/**
 * device/pipeline.ts — frame pipeline v2 decisions: encapsulation validators, the role-based MAC filter and the
 * per-role demux index (ARCHITECTURE-P1 D3, §3.1; replaces the P0 kind checks at device.ts:244-278 and demux()).
 *
 * Everything here is a pure decision over a port view and a frame. `frameArrivalVerdict` implements §3.1 steps
 * 3–14 and `ingressVerdict` implements the `ingress` action (steps 11–14 at a chosen layer). A verdict names the
 * counters to increment (in order) and either a drop (reason, detail) or the process to hand the frame to. The
 * device runtime emits `frameRx` and bumps `inPackets`/`inBytes`/`lastInput` itself (step 2), applies the counter
 * list with `countIngress`, emits the drop or calls `onPdu` (step 15).
 *
 * Demux (process.ts DemuxSelector): the index holds, per effective port role and demux layer, every matching
 * selector sorted by score (1 + defined keys) descending, then `model.processes` order, then selector order, under
 * each role the selector lists (every selector lists its roles since the P0.5 exit gate). Lookup returns the first entry whose
 * key is absent or equals the frame's key; frames without a key (dot11 management, ipv4/ipv6 ingress) match only
 * key-less entries. The runtime rebuilds the index at boot (processes change); a role change needs no rebuild of
 * the rows, because rows are keyed by role — the runtime re-reads the row of the new role.
 *
 * Frames are read through the structural `FrameLike` shape (a `Pdu` satisfies it), so the decisions do not depend
 * on codec availability.
 */
import type { MacAddress } from '../contracts/addr.js';
import type { ProcessName } from '../contracts/ids.js';
import type { DropReason, FrameRxInfo } from '../contracts/link.js';
import {
  DOT11_MAX_FRAME,
  ETH_FCS,
  ETH_HEADER,
  ETH_MIN_FRAME,
  HDLC_FCS,
  HDLC_HEADER,
  HDLC_PROTO_KEEPALIVE,
  type FieldValue,
  type ProtoName,
} from '../contracts/pdu.js';
import type { PortCounters, PortView } from '../contracts/port.js';
import type { DemuxLayer, Process } from '../contracts/process.js';
import {
  PORT_ROLES,
  ROLE_TRAITS,
  macFilterApplies,
  type Capability,
  type FramingProto,
  type PortEncap,
  type PortRole,
} from '../contracts/catalog.js';
import { specEncap, specRole } from './ports.js';

// ── frame shape ──────────────────────────────────────────────────────────────

/** One decoded layer as the pipeline reads it (a `LayerView` satisfies it). */
export interface FrameLayerLike {
  readonly proto: ProtoName;
  readonly fields: Readonly<Record<string, FieldValue>>;
}

/** The parts of a PDU the pipeline reads (a `Pdu` satisfies it). */
export interface FrameLike {
  readonly layers: readonly FrameLayerLike[];
  /** Total bytes on the wire. */
  readonly size: number;
  /** Outermost-first lookup of a layer by protocol. */
  layer(proto: ProtoName): FrameLayerLike | undefined;
}

/** Outer framings, in declaration order. */
export const FRAMING_PROTOS: readonly FramingProto[] = Object.freeze(['ethernet', 'hdlc', 'dot11']);

/** Demux layers, in declaration order. */
export const DEMUX_LAYERS: readonly DemuxLayer[] = Object.freeze(['ethernet', 'hdlc', 'dot11', 'ipv4', 'ipv6']);

/** True when `proto` names an outer framing. */
export function isFramingProto(proto: string | undefined): proto is FramingProto {
  return proto !== undefined && (FRAMING_PROTOS as readonly string[]).includes(proto);
}

/** True when `proto` names a demux layer. */
export function isDemuxLayer(proto: string | undefined): proto is DemuxLayer {
  return proto !== undefined && (DEMUX_LAYERS as readonly string[]).includes(proto);
}

// ── counters and verdicts ────────────────────────────────────────────────────

/** Receive counters the pipeline may increment (besides inPackets/inBytes, which the runtime counts first). */
export type IngressCounter = 'inDrops' | 'inErrors' | 'crcErrors' | 'runts' | 'giants' | 'inBroadcasts';

/** The frame is discarded. */
export interface FrameDrop {
  readonly kind: 'drop';
  readonly reason: DropReason;
  readonly detail?: string;
  /** Counters to increment, in order. */
  readonly counters: readonly IngressCounter[];
}

/** The frame goes to `process.onPdu`. */
export interface FrameDeliver {
  readonly kind: 'deliver';
  readonly process: ProcessName;
  /** Layer the demux matched on. */
  readonly layer: DemuxLayer;
  /** Demux key read from the frame (absent for key-less frames). */
  readonly key?: number;
  /** Counters to increment, in order (e.g. `inBroadcasts`). */
  readonly counters: readonly IngressCounter[];
}

/** Outcome of the pipeline for one frame. */
export type FrameVerdict = FrameDrop | FrameDeliver;

function drop(reason: DropReason, detail: string | undefined, counters: readonly IngressCounter[]): FrameDrop {
  return detail === undefined ? { kind: 'drop', reason, counters } : { kind: 'drop', reason, detail, counters };
}

/** Increment `list` on `counters` (the runtime is the only counter writer; this is its helper). */
export function countIngress(counters: PortCounters, list: readonly IngressCounter[]): void {
  for (const name of list) counters[name]++;
}

// ── port helpers ─────────────────────────────────────────────────────────────

/** Effective role of a live port: `PortState.role`, else the spec default for the device capabilities. */
export function effectivePortRole(port: Pick<PortView, 'role' | 'spec'>, capabilities: readonly Capability[] | undefined): PortRole {
  return port.role ?? specRole(port.spec, capabilities);
}

/** Effective encapsulation of a live port: `PortState.encap`, else the spec default. */
export function effectivePortEncap(port: Pick<PortView, 'encap' | 'spec'>): PortEncap {
  return port.encap ?? specEncap(port.spec);
}

/**
 * §3.1 step 4 receive gate. wlan ports gate on `phy.carrier` (management and EAPOL flow before authorization);
 * every other port on `operUp`, except that an HDLC keepalive (protocol 0x8035) is still received while the port
 * has carrier and is down only by its keepalive latch.
 */
export function portReceiveUp(port: Pick<PortView, 'operUp' | 'phy' | 'spec'>, frame: Pick<FrameLike, 'layers'>): boolean {
  if (port.spec.kind === 'wlan') return port.phy?.carrier === true;
  if (port.operUp) return true;
  const outer = frame.layers[0];
  return outer !== undefined && outer.proto === 'hdlc' && outer.fields['protocol'] === HDLC_PROTO_KEEPALIVE
    && port.phy?.carrier === true && port.phy.lineProtocolReason === 'keepalive-missed';
}

// ── encapsulation validators ─────────────────────────────────────────────────

/** Outer framings each port encapsulation accepts (§3.1 step 9). dot11 ports also take Ethernet (air data after the admit rewrap). */
export const ENCAP_ALLOWS: Readonly<Record<PortEncap, readonly FramingProto[]>> = Object.freeze({
  ethernet: Object.freeze(['ethernet'] as FramingProto[]),
  hdlc: Object.freeze(['hdlc'] as FramingProto[]),
  dot11: Object.freeze(['dot11', 'ethernet'] as FramingProto[]),
  ppp: Object.freeze([] as FramingProto[]),
  none: Object.freeze([] as FramingProto[]),
});

/** Step 9: is the outer layer allowed by the port encapsulation? The failure detail is `no-${encap}-layer` (P0 `no-ethernet-layer`). */
export function checkEncap(encap: PortEncap, outer: string | undefined): { ok: true; outer: FramingProto } | { ok: false; detail: string } {
  if (isFramingProto(outer) && ENCAP_ALLOWS[encap].includes(outer)) return { ok: true, outer };
  return { ok: false, detail: `no-${encap}-layer` };
}

/** Per-framing rules: size limits, destination address, demux key. */
export interface FramingRules {
  /** Frames shorter than this are runts (0 = never). */
  readonly minBytes: number;
  /** Largest valid frame for a port MTU. */
  maxBytes(mtu: number): number;
  /** Destination MAC of the framing layer (ethernet.dst, dot11.addr1), undefined for HDLC. */
  destination(layer: FrameLayerLike): MacAddress | undefined;
  /** Demux key: ethernet.type, hdlc.protocol, llc.type of dot11 data frames; undefined when the frame has none. */
  demuxKey(frame: FrameLike, layer: FrameLayerLike): number | undefined;
  /** dot11 management/control subtype (frames that only key-less selectors take); undefined otherwise. */
  managementSubtype(layer: FrameLayerLike): string | undefined;
}

const num = (v: FieldValue | undefined): number | undefined => (typeof v === 'number' ? v : undefined);
const mac = (v: FieldValue | undefined): MacAddress | undefined => (typeof v === 'string' ? v : undefined);

/** Framing rules by outer layer (§3.1 step 10 table). */
export const FRAMING_RULES: Readonly<Record<FramingProto, FramingRules>> = Object.freeze({
  ethernet: Object.freeze({
    minBytes: ETH_MIN_FRAME,
    maxBytes: (mtu: number) => mtu + ETH_HEADER + ETH_FCS,
    destination: (layer: FrameLayerLike) => mac(layer.fields['dst']),
    demuxKey: (_frame: FrameLike, layer: FrameLayerLike) => num(layer.fields['type']),
    managementSubtype: () => undefined,
  }),
  hdlc: Object.freeze({
    minBytes: 0,
    maxBytes: (mtu: number) => mtu + HDLC_HEADER + HDLC_FCS,
    destination: () => undefined,
    demuxKey: (_frame: FrameLike, layer: FrameLayerLike) => num(layer.fields['protocol']),
    managementSubtype: () => undefined,
  }),
  dot11: Object.freeze({
    minBytes: 0,
    maxBytes: () => DOT11_MAX_FRAME,
    destination: (layer: FrameLayerLike) => mac(layer.fields['addr1']),
    demuxKey: (frame: FrameLike, layer: FrameLayerLike) => (layer.fields['frameType'] === 'data' ? num(frame.layer('llc')?.fields['type']) : undefined),
    managementSubtype: (layer: FrameLayerLike) => (layer.fields['frameType'] === 'data' ? undefined : String(layer.fields['subtype'] ?? 'unknown')),
  }),
});

/**
 * Step 10: FCS, runt and giant checks of the outer framing (`frame.layers[0]`). FCS errors (corrupted or
 * `fcsValid === false`) count crcErrors + inErrors; runts count runts + inErrors; giants count giants + inErrors.
 * Runt/giant details are `${size} bytes`. Undefined when the frame is valid.
 */
export function validateFraming(outer: FramingProto, frame: FrameLike, corrupted: boolean | undefined, mtu: number): FrameDrop | undefined {
  const rules = FRAMING_RULES[outer];
  if (corrupted === true || frame.layers[0]?.fields['fcsValid'] === false) return drop('fcs-error', undefined, ['crcErrors', 'inErrors']);
  if (frame.size < rules.minBytes) return drop('runt', `${frame.size} bytes`, ['runts', 'inErrors']);
  if (frame.size > rules.maxBytes(mtu)) return drop('giant', `${frame.size} bytes`, ['giants', 'inErrors']);
  return undefined;
}

/** True when a MAC has the group bit (broadcast or multicast); malformed text is not a group address. */
export function isGroupMac(address: string): boolean {
  const m = /^([0-9a-fA-F]{2})[:-]/.exec(address);
  return m !== null && (parseInt(m[1] as string, 16) & 1) === 1;
}

// ── demux index ──────────────────────────────────────────────────────────────

/** One selector placed in a demux row. */
export interface DemuxEntry {
  readonly process: ProcessName;
  /** Key the selector requires (absent = any key, including none). */
  readonly ethertype?: number;
  /** 1 + number of defined keys. */
  readonly score: number;
  /** Position of the process in the model order. */
  readonly order: number;
  /** Position of the selector inside the process's `handles`. */
  readonly selector: number;
}

/** Sorted demux rows per effective role and demux layer. */
export type DemuxIndex = Readonly<Record<PortRole, Readonly<Partial<Record<DemuxLayer, readonly DemuxEntry[]>>>>>;

/**
 * Build the demux index from the instantiated processes, visited in `order` (`model.processes`). Processes missing
 * from `processes` or without `handles` contribute nothing. Rows are sorted by score descending, then process
 * order, then selector order.
 */
export function buildDemuxIndex(order: readonly ProcessName[], processes: ReadonlyMap<ProcessName, Pick<Process, 'handles'>>): DemuxIndex {
  const rows = {} as Record<PortRole, Partial<Record<DemuxLayer, DemuxEntry[]>>>;
  for (const role of PORT_ROLES) rows[role] = {};
  order.forEach((name, position) => {
    const handles = processes.get(name)?.handles;
    if (handles === undefined) return;
    handles.forEach((sel, selector) => {
      const entry: DemuxEntry = sel.ethertype === undefined
        ? { process: name, score: 1, order: position, selector }
        : { process: name, ethertype: sel.ethertype, score: 2, order: position, selector };
      for (const role of sel.roles) {
        const row = rows[role];
        if (row === undefined) continue;
        const list = row[sel.layer] ?? [];
        list.push(entry);
        row[sel.layer] = list;
      }
    });
  });
  for (const role of PORT_ROLES) {
    const row = rows[role];
    for (const layer of DEMUX_LAYERS) {
      const list = row[layer];
      if (list === undefined) continue;
      list.sort((a, b) => b.score - a.score || a.order - b.order || a.selector - b.selector);
      Object.freeze(list);
    }
    Object.freeze(row);
  }
  return Object.freeze(rows);
}

/** Best entry for a frame on a port of `role` at `layer` with demux `key` (undefined key → key-less entries only). */
export function demuxLookup(index: DemuxIndex, role: PortRole, layer: DemuxLayer, key: number | undefined): DemuxEntry | undefined {
  const list = index[role][layer];
  if (list === undefined) return undefined;
  for (const entry of list) {
    if (entry.ethertype === undefined) return entry;
    if (key !== undefined && entry.ethertype === key) return entry;
  }
  return undefined;
}

/** `unsupported-ethertype` detail: `0xNNNN` (P0 form), or `no-ethertype` when the frame carries no key. */
export function unsupportedKeyDetail(key: number | undefined): string {
  return key === undefined ? 'no-ethertype' : `0x${key.toString(16).padStart(4, '0')}`;
}

// ── pipeline ─────────────────────────────────────────────────────────────────

/** The port fields the pipeline reads (a `PortState`/`PortView` satisfies it). */
export type PipelinePort = Pick<PortView, 'id' | 'spec' | 'mac' | 'adminUp' | 'operUp' | 'errDisabled' | 'phy' | 'role' | 'encap' | 'mtu'>;

/** Inputs of `frameArrivalVerdict`. */
export interface FrameArrivalInput {
  readonly port: PipelinePort;
  readonly frame: FrameLike;
  readonly corrupted?: boolean | undefined;
  readonly rx?: FrameRxInfo | undefined;
  /** Device powered and booted. */
  readonly booted: boolean;
  /** Effective device capabilities (default role of role-less fixture ports). */
  readonly capabilities?: readonly Capability[] | undefined;
  readonly index: DemuxIndex;
}

/** Steps 11–14 at a framing layer or an IP layer. `counters` holds increments already decided. */
function demuxStage(
  role: PortRole,
  layer: DemuxLayer,
  framingLayer: FrameLayerLike | undefined,
  frame: FrameLike,
  port: Pick<PortView, 'mac' | 'spec'>,
  index: DemuxIndex,
): FrameVerdict {
  if (!isFramingProto(layer) || framingLayer === undefined) {
    const target = demuxLookup(index, role, layer, undefined);
    if (target === undefined) return drop('unsupported-protocol', `no-handler-${layer}`, ['inDrops']);
    return { kind: 'deliver', process: target.process, layer, counters: [] };
  }
  const rules = FRAMING_RULES[layer];
  const counters: IngressCounter[] = [];
  const dst = rules.destination(framingLayer);
  const group = dst !== undefined && isGroupMac(dst);
  if (group) counters.push('inBroadcasts');
  if (macFilterApplies(role, layer, port.spec.promiscuous) && !group && dst !== port.mac) {
    return drop('not-for-me', dst ?? '', [...counters, 'inDrops']);
  }
  const key = rules.demuxKey(frame, framingLayer);
  const target = demuxLookup(index, role, layer, key);
  if (target !== undefined) {
    return key === undefined
      ? { kind: 'deliver', process: target.process, layer, counters }
      : { kind: 'deliver', process: target.process, layer, key, counters };
  }
  const subtype = rules.managementSubtype(framingLayer);
  if (subtype !== undefined) return drop('other', `no-handler-dot11-${subtype}`, [...counters, 'inDrops']);
  return drop('unsupported-ethertype', unsupportedKeyDetail(key), [...counters, 'inDrops']);
}

/**
 * §3.1 steps 3–14 for a frame that arrived on `port`:
 *  3 admin down → port-admin-down; 4 receive gate (`portReceiveUp`) or not booted → link-down;
 *  5 err-disabled → port-err-disabled (detail = the cause); 6 role without frames → other `no-frames-on-<role>`;
 *  7 `rx.collided` → collision (no counter); 8 `rx.fragmentBytes` → runt (< 64 B) or fcs-error;
 *  9 encapsulation → other `no-<encap>-layer`; 10 FCS/runt/giant of the outer framing;
 *  11 group destination → inBroadcasts; 12 MAC filter (`macFilterApplies`) → not-for-me (detail = destination);
 *  13–14 demux by role and outer layer → deliver, or unsupported-ethertype `0xNNNN` / other `no-handler-dot11-<subtype>`.
 * Drops at steps 3–6, 9, 12 and 14 count inDrops.
 */
export function frameArrivalVerdict(input: FrameArrivalInput): FrameVerdict {
  const { port, frame } = input;
  if (!port.adminUp) return drop('port-admin-down', undefined, ['inDrops']);
  if (!portReceiveUp(port, frame) || !input.booted) return drop('link-down', undefined, ['inDrops']);
  if (port.errDisabled !== undefined) return drop('port-err-disabled', port.errDisabled, ['inDrops']);
  const role = effectivePortRole(port, input.capabilities);
  if (!ROLE_TRAITS[role].frames) return drop('other', `no-frames-on-${role}`, ['inDrops']);
  if (input.rx?.collided === true) return drop('collision', undefined, []);
  const fragment = input.rx?.fragmentBytes;
  if (fragment !== undefined) {
    return fragment < ETH_MIN_FRAME ? drop('runt', `${fragment} bytes`, ['runts', 'inErrors']) : drop('fcs-error', undefined, ['crcErrors', 'inErrors']);
  }
  const encap = checkEncap(effectivePortEncap(port), frame.layers[0]?.proto);
  if (!encap.ok) return drop('other', encap.detail, ['inDrops']);
  const invalid = validateFraming(encap.outer, frame, input.corrupted, port.mtu);
  if (invalid !== undefined) return invalid;
  return demuxStage(role, encap.outer, frame.layers[0], frame, port, input.index);
}

/** Inputs of `ingressVerdict` (the `ingress` action). */
export interface IngressInput {
  readonly port: Pick<PortView, 'id' | 'spec' | 'mac' | 'role'>;
  readonly frame: FrameLike;
  /** Demux layer to start at (default: the frame's outer layer when it is a demux layer). */
  readonly layer?: DemuxLayer | undefined;
  readonly capabilities?: readonly Capability[] | undefined;
  readonly index: DemuxIndex;
}

/**
 * The `ingress` action (§3.1 last paragraph): steps 11–14 on `port` starting at `layer`. At a framing layer the
 * layer must be present in the frame (else other `no-<layer>-layer`); group counting and the MAC filter apply.
 * At `ipv4`/`ipv6` only key-less selectors match; no handler → unsupported-protocol `no-handler-<layer>`.
 */
export function ingressVerdict(input: IngressInput): FrameVerdict {
  const role = effectivePortRole(input.port, input.capabilities);
  const outer = input.frame.layers[0]?.proto;
  const layer = input.layer ?? (isDemuxLayer(outer) ? outer : undefined);
  if (layer === undefined) return drop('other', 'no-demux-layer', ['inDrops']);
  if (isFramingProto(layer)) {
    const framingLayer = input.frame.layer(layer);
    if (framingLayer === undefined) return drop('other', `no-${layer}-layer`, ['inDrops']);
    return demuxStage(role, layer, framingLayer, input.frame, input.port, input.index);
  }
  return demuxStage(role, layer, undefined, input.frame, input.port, input.index);
}

/** Layer used by 'loop' egress (§3.2): the outer layer when it is a demux layer, else `ipv4`. */
export function loopIngressLayer(frame: Pick<FrameLike, 'layers'>): DemuxLayer {
  const outer = frame.layers[0]?.proto;
  return isDemuxLayer(outer) ? outer : 'ipv4';
}
