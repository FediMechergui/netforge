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
 *
 * P2 (ARCHITECTURE-P2 §3.0 "Pipeline", W1 device) adds, between the framing checks and the demux:
 *  - step 10: an Ethernet frame whose second layer is `dot1q` may be 4 bytes longer (1522 at MTU 1500);
 *  - step 10a (`classifySubinterface`): on a port whose effective role is `routed`, a tagged frame goes to the
 *    subinterface whose `dot1q.vid` matches (verdict `subif`, pop) or is dropped `encapsulation-mismatch`; an
 *    untagged frame goes to the native subinterface (verdict `subif`, no pop) or stays on the parent. The runtime
 *    applies a `subif` verdict and runs steps 10b–14 on the subinterface (`subinterfaceVerdict`);
 *  - step 10b (`linkLayerFilter`): on a port whose role is not bridged (and not promiscuous), frames to the reserved
 *    link-layer control groups `01:80:c2:00:00:00`–`0f` and to the NF control group are dropped `not-for-me`, detail
 *    `link-layer control frame`, with no counter; [S2] IPv4 multicast frames of a group the port has not joined
 *    (`PortL3.groups4`; the all-hosts group always counts as joined) are dropped `not-for-me`, detail `multicast
 *    group not joined` (`multicastGroupFilter`; switched on by the input's `groupFilter`, which the runtime sets);
 *  - step 12: the MAC filter also accepts the MAC of a virtual address of the port (`PortL3.virtual4`).
 * Step 10b also runs in the `ingress` action at a framing layer (the SVI clone eth-switch hands over, a loop
 * egress), so a control or unjoined-group frame never reaches an L3 daemon by that path either.
 */
import { ipv4ToU32, isIpv4, type MacAddress } from '../contracts/addr.js';
import type { PortId, ProcessName } from '../contracts/ids.js';
import type { DropReason, FrameRxInfo } from '../contracts/link.js';
import {
  DOT11_MAX_FRAME,
  DOT1Q_HEADER,
  ETH_FCS,
  ETH_HEADER,
  ETH_MIN_FRAME,
  HDLC_FCS,
  HDLC_HEADER,
  HDLC_PROTO_KEEPALIVE,
  NF_L2_CONTROL_MAC,
  type FieldValue,
  type ProtoName,
} from '../contracts/pdu.js';
import type { PortCounters, PortL3, PortView } from '../contracts/port.js';
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

/**
 * @since P2 Step 10a: the frame belongs to subinterface `port` of the arrival port (ARCHITECTURE-P2 §3.0). The runtime
 * pops the tag when `pop` (a native subinterface takes untagged frames, `pop` false), counts `inPackets`/`inBytes` on
 * the subinterface and continues with `subinterfaceVerdict` on it. Nothing is counted on the parent beyond step 2.
 */
export interface FrameSubif {
  readonly kind: 'subif';
  readonly port: PortId;
  readonly pop: boolean;
  /** Always empty (the verdict counts nothing on the parent); present so every verdict carries a counter list. */
  readonly counters: readonly IngressCounter[];
}

/** @since P2 Outcome of `frameArrivalVerdict`: a final verdict, or the hand-over to a subinterface (step 10a). */
export type FrameArrivalVerdict = FrameVerdict | FrameSubif;

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
  if (frame.size > rules.maxBytes(mtu) + tagAllowance(outer, frame)) return drop('giant', `${frame.size} bytes`, ['giants', 'inErrors']);
  return undefined;
}

/**
 * @since P2 Step 10: extra bytes a frame may carry beyond `FRAMING_RULES[outer].maxBytes(mtu)` — the 802.1Q header
 * when an Ethernet frame's second layer is `dot1q` (1522 bytes at MTU 1500), else 0.
 */
export function tagAllowance(outer: FramingProto, frame: Pick<FrameLike, 'layers'>): number {
  return outer === 'ethernet' && frame.layers[1]?.proto === 'dot1q' ? DOT1Q_HEADER : 0;
}

/** True when a MAC has the group bit (broadcast or multicast); malformed text is not a group address. */
export function isGroupMac(address: string): boolean {
  const m = /^([0-9a-fA-F]{2})[:-]/.exec(address);
  return m !== null && (parseInt(m[1] as string, 16) & 1) === 1;
}

// ── P2: subinterfaces (step 10a) and the link-layer filter (step 10b) ───────

/** The L3 members of a port the P2 steps read (absent on hand-built fixture ports = nothing joined, no virtual address). */
export type PipelineL3 = Readonly<Pick<PortL3, 'virtual4' | 'groups4'>>;

/** @since P2 A subinterface of the arrival port as step 10a reads it (a `PortState` satisfies it). */
export interface PipelineSubif {
  readonly id: PortId;
  /** From `encapsulation dot1Q <vid> [native]`; absent = not configured yet (the subinterface takes no frame). */
  readonly dot1q?: { readonly vid: number; readonly native: boolean };
}

/** @since P2 Original drop details of steps 10a and 10b (ARCHITECTURE-P2 §3.0). */
export const PIPELINE_P2_DETAILS = Object.freeze({
  /** Step 10a: a tagged frame whose VID no subinterface of the port carries (`{vlan}` = the VID). */
  noSubinterface: 'tagged frame for VLAN {vlan}; no subinterface carries it',
  /** Step 10b: a frame to a reserved link-layer control group or to the NF control group. */
  linkLayerControl: 'link-layer control frame',
  /** Step 10b [S2]: an IPv4 multicast frame of a group the port has not joined. */
  groupNotJoined: 'multicast group not joined',
});

/**
 * @since P2 Destinations of step 10b's control rule: the IEEE reserved link-layer groups `01:80:c2:00:00:00`–`0f`
 * (spanning tree, slow protocols, …) and the NF L2 control group (DTP, PAgP, VTP in their NF formats, D8).
 */
export function isLinkLayerControlMac(dst: MacAddress): boolean {
  const d = dst.toLowerCase();
  return (d.length === 17 && d.startsWith('01:80:c2:00:00:0')) || d === NF_L2_CONTROL_MAC;
}

/**
 * @since P2 Step 10a on a port whose effective role is `routed` (ARCHITECTURE-P2 §3.0, D11):
 *  - tagged frame (`layers[1]` is `dot1q`, VID v): the subinterface with `dot1q.vid === v` → `{kind:'subif', pop:
 *    true}`; none → drop `encapsulation-mismatch`, detail `tagged frame for VLAN <v>; no subinterface carries it`,
 *    counter `inDrops`;
 *  - untagged frame: the native subinterface → `{kind:'subif', pop: false}`; none → undefined (the parent itself
 *    continues at step 10b).
 * `subifs` are the subinterfaces of the arrival port in port order; the first match wins.
 */
export function classifySubinterface(frame: Pick<FrameLike, 'layers'>, subifs: readonly PipelineSubif[]): FrameSubif | FrameDrop | undefined {
  const tag = frame.layers[1];
  if (tag !== undefined && tag.proto === 'dot1q') {
    const vid = num(tag.fields['vid']);
    const hit = vid === undefined ? undefined : subifs.find((s) => s.dot1q !== undefined && s.dot1q.vid === vid);
    if (hit !== undefined) return { kind: 'subif', port: hit.id, pop: true, counters: [] };
    return drop('encapsulation-mismatch', PIPELINE_P2_DETAILS.noSubinterface.split('{vlan}').join(String(vid ?? '')), ['inDrops']);
  }
  const native = subifs.find((s) => s.dot1q !== undefined && s.dot1q.native);
  return native === undefined ? undefined : { kind: 'subif', port: native.id, pop: false, counters: [] };
}

/**
 * @since P2 Step 10b (ARCHITECTURE-P2 §3.0): on a port whose role is not bridged and that is not promiscuous, a frame
 * to a link-layer control destination (`isLinkLayerControlMac`) is dropped `not-for-me`, detail `link-layer control
 * frame`; [S2] then, when `groupFilter` is on, the multicast-group rule (`multicastGroupFilter`). No counter is
 * incremented. Frames without a destination (HDLC) pass. Undefined when the frame passes.
 */
export function linkLayerFilter(
  role: PortRole,
  outer: FramingProto,
  framingLayer: FrameLayerLike,
  port: { readonly spec: { readonly promiscuous?: boolean | undefined }; readonly l3?: PipelineL3 | undefined },
  groupFilter = false,
): FrameDrop | undefined {
  if (ROLE_TRAITS[role].bridged || port.spec.promiscuous === true) return undefined;
  const dst = FRAMING_RULES[outer].destination(framingLayer);
  if (dst === undefined) return undefined;
  if (isLinkLayerControlMac(dst)) return drop('not-for-me', PIPELINE_P2_DETAILS.linkLayerControl, []);
  return groupFilter ? multicastGroupFilter(dst, port.l3?.groups4) : undefined;
}

// [S2] ── the multicast-group rule of step 10b (HSRP, ARCHITECTURE-P2 §3.0, §3.10, D15) ─────────────────────────────
//
// The device runtime switches the rule on for every frame (`FrameArrivalInput.groupFilter`, `IngressInput.groupFilter`).
// A hand-built pipeline input without the flag keeps the P1 decision (every IPv4 multicast frame passes to the demux),
// as the pure SVI rule of device/ports.ts keeps the P1 rule without its injected lookups. No P0/P1 daemon sends IPv4
// multicast, so no P1-profile trace sees the rule.

/**
 * [S2] The all-hosts group (RFC 1112 §4: every IPv4 multicast-capable interface is a permanent member), so a frame to
 * `01:00:5e:00:00:01` always passes the rule, exactly as it reached ipv4 in P1.
 */
export const IPV4_ALL_HOSTS_GROUP = '224.0.0.1';

/** [S2] Low 23 bits of an IPv4 multicast MAC (`01:00:5e:00:00:00`–`01:00:5e:7f:ff:ff`), or undefined for any other MAC. */
export function ipv4MulticastMacBits(dst: MacAddress): number | undefined {
  const m = /^01:00:5e:([0-7][0-9a-f]):([0-9a-f]{2}):([0-9a-f]{2})$/.exec(dst.toLowerCase());
  if (m === null) return undefined;
  return (parseInt(m[1] as string, 16) << 16) | (parseInt(m[2] as string, 16) << 8) | parseInt(m[3] as string, 16);
}

/**
 * [S2] The multicast-group rule of step 10b: a destination in `01:00:5e:00:00:00`–`01:00:5e:7f:ff:ff` whose low 23
 * bits match neither the all-hosts group nor a group in `groups4` (the port's joined IPv4 groups, written by ipv4 on
 * `ipv4.group`) is dropped `not-for-me`, detail `multicast group not joined`, with no counter. Any other destination
 * passes (undefined).
 */
export function multicastGroupFilter(dst: MacAddress, groups4: readonly string[] | undefined): FrameDrop | undefined {
  const bits = ipv4MulticastMacBits(dst);
  if (bits === undefined) return undefined;
  for (const g of [IPV4_ALL_HOSTS_GROUP, ...(groups4 ?? [])]) {
    if (isIpv4(g) && (ipv4ToU32(g) & 0x7fffff) === bits) return undefined;
  }
  return drop('not-for-me', PIPELINE_P2_DETAILS.groupNotJoined, []);
}

// [/S2] ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** @since P2 Step 12: true when `dst` is the MAC of one of the port's virtual addresses (`PortL3.virtual4`). */
export function isVirtualMac(l3: PipelineL3 | undefined, dst: MacAddress): boolean {
  return (l3?.virtual4 ?? []).some((v) => v.mac === dst);
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

/**
 * The port fields the pipeline reads (a `PortState`/`PortView` satisfies it). `l3` (@since P2) is read for the
 * virtual MACs of step 12 and [S2] the joined groups of step 10b; hand-built fixture ports may leave it out.
 */
export type PipelinePort = Pick<PortView, 'id' | 'spec' | 'mac' | 'adminUp' | 'operUp' | 'errDisabled' | 'phy' | 'role' | 'encap' | 'mtu'> & {
  readonly l3?: PipelineL3 | undefined;
};

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
  /** @since P2 Step 10a: the subinterfaces of `port` in port order (absent = none). Read only on a `routed` port. */
  readonly subinterfaces?: readonly PipelineSubif[] | undefined;
  /** @since P2 [S2] Switch the multicast-group rule of step 10b on (the device runtime always does; absent = off). */
  readonly groupFilter?: boolean | undefined;
}

/** Steps 11–14 at a framing layer or an IP layer. `counters` holds increments already decided. */
function demuxStage(
  role: PortRole,
  layer: DemuxLayer,
  framingLayer: FrameLayerLike | undefined,
  frame: FrameLike,
  port: Pick<PortView, 'mac' | 'spec'> & { readonly l3?: PipelineL3 | undefined },
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
  if (macFilterApplies(role, layer, port.spec.promiscuous) && !group && dst !== port.mac && !(dst !== undefined && isVirtualMac(port.l3, dst))) {
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
 *  9 encapsulation → other `no-<encap>-layer`; 10 FCS/runt/giant of the outer framing (P2: +4 bytes when tagged);
 *  10a (P2) on a `routed` port: subinterface hand-over (`subif` verdict) or encapsulation-mismatch for a tagged
 *      frame no subinterface carries (`classifySubinterface`);
 *  10b (P2) on a non-bridged, non-promiscuous port: link-layer control groups and [S2] unjoined IPv4 multicast groups
 *      → not-for-me, no counter (`linkLayerFilter`);
 *  11 group destination → inBroadcasts; 12 MAC filter (`macFilterApplies`; P2: a `virtual4` MAC is accepted) →
 *  not-for-me (detail = destination);
 *  13–14 demux by role and outer layer → deliver, or unsupported-ethertype `0xNNNN` / other `no-handler-dot11-<subtype>`.
 * Drops at steps 3–6, 9, 10a, 12 and 14 count inDrops.
 */
export function frameArrivalVerdict(input: FrameArrivalInput): FrameArrivalVerdict {
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
  const outer = frame.layers[0] as FrameLayerLike;
  if (role === 'routed' && encap.outer === 'ethernet') {
    const sub = classifySubinterface(frame, input.subinterfaces ?? []);
    if (sub !== undefined) return sub;
  }
  const filtered = linkLayerFilter(role, encap.outer, outer, port, input.groupFilter === true);
  if (filtered !== undefined) return filtered;
  return demuxStage(role, encap.outer, outer, frame, port, input.index);
}

/** Inputs of `ingressVerdict` (the `ingress` action). */
export interface IngressInput {
  /** `l3` @since P2 (virtual MACs of step 12, [S2] joined groups of step 10b); absent on hand-built fixture ports. */
  readonly port: Pick<PortView, 'id' | 'spec' | 'mac' | 'role'> & { readonly l3?: PipelineL3 | undefined };
  readonly frame: FrameLike;
  /** Demux layer to start at (default: the frame's outer layer when it is a demux layer). */
  readonly layer?: DemuxLayer | undefined;
  readonly capabilities?: readonly Capability[] | undefined;
  readonly index: DemuxIndex;
  /** @since P2 [S2] Switch the multicast-group rule of step 10b on (the device runtime always does; absent = off). */
  readonly groupFilter?: boolean | undefined;
}

/**
 * The `ingress` action (§3.1 last paragraph): steps 11–14 on `port` starting at `layer`. At a framing layer the
 * layer must be present in the frame (else other `no-<layer>-layer`); step 10b (P2, `linkLayerFilter`), group
 * counting and the MAC filter apply. At `ipv4`/`ipv6` only key-less selectors match; no handler →
 * unsupported-protocol `no-handler-<layer>`.
 */
export function ingressVerdict(input: IngressInput): FrameVerdict {
  const role = effectivePortRole(input.port, input.capabilities);
  const outer = input.frame.layers[0]?.proto;
  const layer = input.layer ?? (isDemuxLayer(outer) ? outer : undefined);
  if (layer === undefined) return drop('other', 'no-demux-layer', ['inDrops']);
  if (isFramingProto(layer)) {
    const framingLayer = input.frame.layer(layer);
    if (framingLayer === undefined) return drop('other', `no-${layer}-layer`, ['inDrops']);
    const filtered = linkLayerFilter(role, layer, framingLayer, input.port, input.groupFilter === true);
    if (filtered !== undefined) return filtered;
    return demuxStage(role, layer, framingLayer, input.frame, input.port, input.index);
  }
  return demuxStage(role, layer, undefined, input.frame, input.port, input.index);
}

/**
 * @since P2 Steps 10b–14 on subinterface `input.port` for a frame step 10a handed to it (after the runtime popped the
 * tag, or untagged for a native subinterface; ARCHITECTURE-P2 §3.0): the link-layer filter, group counting, the MAC
 * filter (the subinterface carries its parent's MAC) and the demux by the `subif` role at the Ethernet layer.
 */
export function subinterfaceVerdict(input: Omit<IngressInput, 'layer'>): FrameVerdict {
  return ingressVerdict({ ...input, layer: 'ethernet' });
}

/** Layer used by 'loop' egress (§3.2): the outer layer when it is a demux layer, else `ipv4`. */
export function loopIngressLayer(frame: Pick<FrameLike, 'layers'>): DemuxLayer {
  const outer = frame.layers[0]?.proto;
  return isDemuxLayer(outer) ? outer : 'ipv4';
}
