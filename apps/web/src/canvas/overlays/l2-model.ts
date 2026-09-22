/**
 * canvas/overlays/l2-model.ts — the pure model behind the VLAN overlay (ARCHITECTURE-P2 §6, D20, spec §9.6).
 *
 * What the overlay shows, computed from snapshot data only (`PortSnapshot.l2`, the `vlans` rows, subinterfaces):
 *
 * - an ACCESS port gets a tint by its VLAN (`vlanHue`) and a chip at its port anchor: `V10` (with a voice VLAN
 *   `V10 · v150`);
 * - a TRUNK end gets a rail under its link and a chip `T 10,20 · N99`: the VLANs it carries tagged (the active list
 *   without the native VLAN, canonical ranges) and its native VLAN. A router port with 802.1Q subinterfaces is a trunk
 *   end too (`source: 'subinterfaces'`, native = its native subinterface, if any);
 * - a link whose two ends disagree is flagged on BOTH ends with a pulse and a `!` glyph: native VLANs differ, one end
 *   trunks while the other is an access port, or two access ports sit in different VLANs;
 * - with a VLAN focus, every port and link that does not carry that VLAN is dimmed.
 *
 * Every encoding keeps a non-colour channel (chip text, `!` glyph, rail); nothing here is a dash pattern (D20).
 *
 * VLAN awareness is read from the snapshot as the engine derives it (D5): a device is VLAN-aware when it declares the
 * `vlans` table (or runs the `vlan` process). `PortSnapshot.l2` is omitted when a port's view is the default (§2.8),
 * so a switched port of a VLAN-aware device without `l2` reads as the default view (dynamic auto, access VLAN 1).
 * Devices that are not VLAN-aware contribute no switch ends (P1 worlds draw nothing).
 *
 * Pure: no Pixi, no store, no clock. Engine constants are read at call time (§0 rule 12). `deriveDeviceL2` depends on
 * one device object only, so the registry memoises it per device object (registry.ts `memoPerDevice`).
 */
import { DEFAULT_SWITCHPORT } from '@netforge/engine';
import type { DeviceId, DeviceSnapshot, LinkId, PortId, PortL2View, PortSnapshot, SimSnapshot } from '@netforge/engine';

// ── VLAN lists ───────────────────────────────────────────────────────────────

/** A VLAN list as ascending, non-overlapping, non-adjacent inclusive ranges within 1..4094. */
export type VlanRanges = readonly (readonly [number, number])[];

/** Lowest and highest VLAN id. */
export const VLAN_MIN = 1;
export const VLAN_MAX = 4094;

function normalise(ranges: (readonly [number, number])[]): VlanRanges {
  const sorted = ranges
    .map(([a, b]): [number, number] => [Math.max(VLAN_MIN, Math.min(a, b)), Math.min(VLAN_MAX, Math.max(a, b))])
    .filter(([a, b]) => a <= b)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * Parse the canonical list format of `core/vlan-list.ts` ("10,20,30-35", "1-4094" = all, "" = none). Tolerant: spaces
 * are ignored, ids outside 1..4094 are clamped away, malformed tokens are skipped, overlaps are merged.
 */
export function parseVlanList(text: string | undefined): VlanRanges {
  if (text === undefined) return [];
  const out: [number, number][] = [];
  for (const raw of text.split(',')) {
    const token = raw.trim();
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(token);
    if (m === null) continue;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    out.push([a, b]);
  }
  return normalise(out);
}

/** A list from single ids (any order, duplicates allowed). */
export function vlanRangesOf(ids: readonly number[]): VlanRanges {
  return normalise(ids.map((v) => [v, v] as const));
}

/** True when `vlan` is in the list. */
export function vlanRangesHas(ranges: VlanRanges, vlan: number): boolean {
  return ranges.some(([a, b]) => vlan >= a && vlan <= b);
}

/** The list without one VLAN. */
export function vlanRangesWithout(ranges: VlanRanges, vlan: number): VlanRanges {
  const out: [number, number][] = [];
  for (const [a, b] of ranges) {
    if (vlan < a || vlan > b) out.push([a, b]);
    else {
      if (a <= vlan - 1) out.push([a, vlan - 1]);
      if (vlan + 1 <= b) out.push([vlan + 1, b]);
    }
  }
  return out;
}

/** True when the list is every VLAN (1-4094). */
export function isAllVlans(ranges: VlanRanges): boolean {
  return ranges.length === 1 && ranges[0]?.[0] === VLAN_MIN && ranges[0]?.[1] === VLAN_MAX;
}

/** Canonical text of a list ("10,20,30-35"; '' for none). */
export function formatVlanRanges(ranges: VlanRanges): string {
  return ranges.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)).join(',');
}

/** Longest VLAN list text a chip shows before it is clipped with an ellipsis. */
export const CHIP_LIST_MAX = 18;

function chipList(ranges: VlanRanges): string {
  if (ranges.length === 0) return '—';
  if (isAllVlans(ranges)) return 'all';
  const text = formatVlanRanges(ranges);
  if (text.length <= CHIP_LIST_MAX) return text;
  const cut = text.lastIndexOf(',', CHIP_LIST_MAX - 1);
  return `${text.slice(0, cut > 0 ? cut : CHIP_LIST_MAX - 1)},…`;
}

// ── chips and tints ──────────────────────────────────────────────────────────

/** Chip of an access port: `V10`, or `V10 · v150` with a voice VLAN. */
export function accessChip(vlan: number, voice?: number): string {
  return voice === undefined ? `V${vlan}` : `V${vlan} · v${voice}`;
}

/** Chip of a trunk end: `T 10,20 · N99` (tagged VLANs without the native one, then the native VLAN). */
export function trunkChip(vlans: VlanRanges, native: number | null): string {
  const tagged = native === null || isAllVlans(vlans) ? vlans : vlanRangesWithout(vlans, native);
  return native === null ? `T ${chipList(tagged)}` : `T ${chipList(tagged)} · N${native}`;
}

/**
 * Tint hue of a VLAN in degrees (0..359): consecutive VLAN ids are spread by about the golden angle, so VLANs that sit
 * side by side in a lab get clearly different tints. The chip text stays the non-colour channel.
 */
export function vlanHue(vlan: number): number {
  return (((Math.trunc(vlan) * 137) % 360) + 360) % 360;
}

// ── ends ─────────────────────────────────────────────────────────────────────

/** The L2 side of one port as the overlay reads it. */
export type L2End =
  | {
      readonly kind: 'access';
      readonly device: DeviceId;
      readonly port: PortId;
      readonly vlan: number;
      readonly voice?: number;
      readonly view: PortL2View;
    }
  | {
      readonly kind: 'trunk';
      readonly device: DeviceId;
      readonly port: PortId;
      /** VLANs carried (the active list of a switch trunk; the subinterface VLANs of a router port). */
      readonly vlans: VlanRanges;
      /** Native (untagged) VLAN; null for a router port without a native subinterface. */
      readonly native: number | null;
      readonly source: 'switchport' | 'subinterfaces';
      readonly view?: PortL2View;
    };

/** True when the snapshot says the engine runs this device VLAN-aware (it declares the `vlans` table, D5). */
export function isVlanAwareDevice(d: DeviceSnapshot): boolean {
  return (d.tables.extra ?? []).some((t) => t.name === 'vlans') || d.processes.some((p) => p.process === 'vlan');
}

/** The view a switched port of a VLAN-aware device has when the snapshot omits `l2` (§2.8: omitted when default). */
export function defaultL2View(): PortL2View {
  return { config: DEFAULT_SWITCHPORT, oper: 'access' };
}

function isSwitchedPort(p: PortSnapshot): boolean {
  // Hand-built fixtures may omit the role; the P0.5 default of a switch port is 'switched'.
  return (p.role ?? 'switched') === 'switched';
}

/** The effective L2 view of a port: its snapshot `l2`, the default view on a VLAN-aware switched port, else none. */
export function effectiveL2View(d: DeviceSnapshot, p: PortSnapshot, vlanAware = isVlanAwareDevice(d)): PortL2View | undefined {
  if (p.l2 !== undefined) return p.l2;
  return vlanAware && isSwitchedPort(p) ? defaultL2View() : undefined;
}

/** The end a switch port presents, from its view. */
export function switchEnd(device: DeviceId, port: PortId, view: PortL2View): L2End {
  if (view.oper === 'trunk') {
    return {
      kind: 'trunk',
      device,
      port,
      vlans: parseVlanList(view.active ?? view.config.allowed),
      native: view.config.nativeVlan,
      source: 'switchport',
      view,
    };
  }
  return view.config.voiceVlan === undefined
    ? { kind: 'access', device, port, vlan: view.config.accessVlan, view }
    : { kind: 'access', device, port, vlan: view.config.accessVlan, voice: view.config.voiceVlan, view };
}

/** The trunk end a routed port presents through its 802.1Q subinterfaces, or undefined when it has none. */
export function subinterfaceEnd(d: DeviceSnapshot, parent: PortSnapshot): L2End | undefined {
  const subs = d.ports.filter((p) => p.parent === parent.id && p.dot1q !== undefined);
  if (subs.length === 0) return undefined;
  const native = subs.find((p) => p.dot1q?.native === true)?.dot1q?.vid ?? null;
  return {
    kind: 'trunk',
    device: d.id,
    port: parent.id,
    vlans: vlanRangesOf(subs.map((p) => p.dot1q?.vid ?? 0)),
    native,
    source: 'subinterfaces',
  };
}

/** True when the end carries `vlan` (access: its VLAN or voice VLAN; trunk: its list, native included). */
export function endCarries(end: L2End, vlan: number): boolean {
  if (end.kind === 'access') return end.vlan === vlan || end.voice === vlan;
  return vlanRangesHas(end.vlans, vlan) || end.native === vlan;
}

/** Chip text of an end. */
export function endChip(end: L2End): string {
  return end.kind === 'access' ? accessChip(end.vlan, end.voice) : trunkChip(end.vlans, end.native);
}

// ── per device ───────────────────────────────────────────────────────────────

/** Everything the VLAN overlay needs from one device (derived from that device object alone). */
export interface DeviceL2 {
  readonly vlanAware: boolean;
  /** L2 ends by port id (switch ports of a VLAN-aware device; routed parents of subinterfaces on any device). */
  readonly ends: ReadonlyMap<PortId, L2End>;
  /** VLANs this device knows of (VLAN 1, its `vlans` rows, VLANs its ports use), ascending. */
  readonly vlans: readonly number[];
}

function rowVlans(d: DeviceSnapshot): number[] {
  const table = (d.tables.extra ?? []).find((t) => t.name === 'vlans');
  if (table === undefined) return [];
  const out: number[] = [];
  for (const row of table.rows) {
    const v = row.vlan;
    if (typeof v === 'number' && Number.isInteger(v)) out.push(v);
  }
  return out;
}

/** Derive a device's L2 ends and VLANs. Pure in the device object. */
export function deriveDeviceL2(d: DeviceSnapshot): DeviceL2 {
  const vlanAware = isVlanAwareDevice(d);
  const ends = new Map<PortId, L2End>();
  const vlans = new Set<number>(vlanAware ? [1, ...rowVlans(d)] : []);
  for (const p of d.ports) {
    const view = effectiveL2View(d, p, vlanAware);
    let end: L2End | undefined;
    if (view !== undefined) end = switchEnd(d.id, p.id, view);
    else if (p.role === 'routed') end = subinterfaceEnd(d, p);
    if (end === undefined) continue;
    ends.set(p.id, end);
    if (end.kind === 'access') {
      vlans.add(end.vlan);
      if (end.voice !== undefined) vlans.add(end.voice);
    } else {
      if (end.native !== null) vlans.add(end.native);
      if (end.source === 'subinterfaces') for (const [a, b] of end.vlans) for (let v = a; v <= b; v++) vlans.add(v);
    }
  }
  return { vlanAware, ends, vlans: [...vlans].sort((a, b) => a - b) };
}

// ── mismatches ───────────────────────────────────────────────────────────────

/** What two ends of one link disagree about. */
export type L2MismatchKind = 'native' | 'mode' | 'access-vlan';

/** A disagreement between the two ends of a link; both ends pulse and carry the `!` glyph. */
export interface L2Mismatch {
  readonly kind: L2MismatchKind;
  readonly glyph: '!';
  /** Original-wording sentence naming both ends. */
  readonly text: string;
}

/** How an end is named in a sentence ("SW1 Gi0/1"). */
export type EndName = (end: L2End) => string;

const RAW_NAME: EndName = (end) => `${end.device} ${end.port}`;

/**
 * Compare the two ends of one link (§10.2: a trunk pair with native 99 against native 1 is a mismatch on both ends).
 * A router port without a native subinterface has no native VLAN to compare, so it is never a native mismatch.
 */
export function detectL2Mismatch(a: L2End, b: L2End, name: EndName = RAW_NAME): L2Mismatch | undefined {
  if (a.kind === 'trunk' && b.kind === 'trunk') {
    if (a.native !== null && b.native !== null && a.native !== b.native) {
      return {
        kind: 'native',
        glyph: '!',
        text: `Native VLANs differ: ${name(a)} sends VLAN ${a.native} untagged, ${name(b)} sends VLAN ${b.native} untagged.`,
      };
    }
    return undefined;
  }
  if (a.kind === 'access' && b.kind === 'access') {
    if (a.vlan !== b.vlan) {
      return {
        kind: 'access-vlan',
        glyph: '!',
        text: `Access VLANs differ: ${name(a)} is in VLAN ${a.vlan}, ${name(b)} is in VLAN ${b.vlan}.`,
      };
    }
    return undefined;
  }
  const trunk = a.kind === 'trunk' ? a : b;
  const access = a.kind === 'trunk' ? b : a;
  return {
    kind: 'mode',
    glyph: '!',
    text: `${name(trunk)} is a trunk but ${name(access)} is an access port, so tagged frames are dropped at one end.`,
  };
}

// ── the overlay model ────────────────────────────────────────────────────────

/** One linked port of the overlay. */
export interface L2PortMark {
  readonly device: DeviceId;
  readonly port: PortId;
  readonly link: LinkId;
  readonly end: L2End;
  /** Chip at the port anchor. */
  readonly chip: string;
  /** Tint hue of an access port; null for a trunk end (it gets the rail instead). */
  readonly hue: number | null;
  /** Dimmed by the VLAN focus. */
  readonly dimmed: boolean;
  readonly mismatch?: L2Mismatch;
}

/** One link of the overlay (at least one end is an L2 end). */
export interface L2LinkMark {
  readonly link: LinkId;
  readonly a?: L2PortMark;
  readonly b?: L2PortMark;
  /** A trunk rail is drawn under the link (some end trunks). */
  readonly rail: boolean;
  /** The one chip of the link when its L2 ends agree (or only one end is L2); absent when they differ. */
  readonly chip?: string;
  readonly mismatch?: L2Mismatch;
  readonly dimmed: boolean;
}

/** The VLAN overlay's full render model. */
export interface L2OverlayModel {
  /** The focused VLAN, or null. */
  readonly focus: number | null;
  /** VLANs the focus selector offers (every VLAN-aware device's VLANs and every subinterface VLAN), ascending. */
  readonly vlans: readonly number[];
  readonly ports: readonly L2PortMark[];
  readonly links: readonly L2LinkMark[];
}

/** Options of `buildL2Overlay`. */
export interface L2OverlayOptions {
  /** `topoOverlays.vlanFocus`: dim everything that does not carry this VLAN. */
  readonly focus?: number | null;
}

/**
 * Build the VLAN overlay from a snapshot. `perDevice` defaults to the plain derivation; the registry passes a memoised
 * one. Links are visited in snapshot order, ports in link-end order (a, b), so the model is deterministic.
 */
export function buildL2Overlay(
  snapshot: SimSnapshot,
  opts: L2OverlayOptions = {},
  perDevice: (d: DeviceSnapshot) => DeviceL2 = deriveDeviceL2,
): L2OverlayModel {
  const focus = opts.focus ?? null;
  const devices = new Map<DeviceId, DeviceSnapshot>();
  for (const d of snapshot.devices) devices.set(d.id, d);
  const vlans = new Set<number>();
  for (const d of snapshot.devices) for (const v of perDevice(d).vlans) vlans.add(v);

  const nameOf: EndName = (end) => {
    const d = devices.get(end.device);
    const p = d?.ports.find((x) => x.id === end.port);
    return `${d?.name ?? end.device} ${p?.short ?? end.port}`;
  };
  const endAt = (device: DeviceId, port: PortId): L2End | undefined => {
    const d = devices.get(device);
    return d === undefined ? undefined : perDevice(d).ends.get(port);
  };

  const ports: L2PortMark[] = [];
  const links: L2LinkMark[] = [];
  for (const link of snapshot.links) {
    const ea = endAt(link.a.device, link.a.port);
    const eb = endAt(link.b.device, link.b.port);
    if (ea === undefined && eb === undefined) continue;
    const mismatch = ea !== undefined && eb !== undefined ? detectL2Mismatch(ea, eb, nameOf) : undefined;
    const mark = (end: L2End | undefined): L2PortMark | undefined => {
      if (end === undefined) return undefined;
      const base = {
        device: end.device,
        port: end.port,
        link: link.id,
        end,
        chip: endChip(end),
        hue: end.kind === 'access' ? vlanHue(end.vlan) : null,
        dimmed: focus !== null && !endCarries(end, focus),
      };
      return mismatch === undefined ? base : { ...base, mismatch };
    };
    const a = mark(ea);
    const b = mark(eb);
    if (a !== undefined) ports.push(a);
    if (b !== undefined) ports.push(b);
    const chips = [a?.chip, b?.chip].filter((c): c is string => c !== undefined);
    const agreed = chips.every((c) => c === chips[0]) ? chips[0] : undefined;
    const present = [ea, eb].filter((e): e is L2End => e !== undefined);
    const out: L2LinkMark = {
      link: link.id,
      ...(a === undefined ? {} : { a }),
      ...(b === undefined ? {} : { b }),
      rail: present.some((e) => e.kind === 'trunk'),
      ...(agreed === undefined ? {} : { chip: agreed }),
      ...(mismatch === undefined ? {} : { mismatch }),
      dimmed: focus !== null && present.every((e) => !endCarries(e, focus)),
    };
    links.push(out);
  }
  return { focus, vlans: [...vlans].sort((x, y) => x - y), ports, links };
}
