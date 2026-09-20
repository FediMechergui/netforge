/**
 * Device geometry, port anchors, the cable-tool port picker and port LEDs.
 *
 *  • Body size comes from the device's icon (catalog/visuals.ts `visualForModel`): half the icon box.
 *  • Cabled ports get an EDGE anchor on the side of the body that faces the peer device, distributed along that
 *    side in the order of the peers so cables do not cross needlessly.
 *  • Radio ports (Wi-Fi, cellular, point-to-point) get an ANTENNA anchor on top of the body. Association lines,
 *    radio beams and air packets start there; PtP radio links never take an edge anchor.
 *  • While the cable tool is active every pickable port has a PICKER anchor under the label block, grouped in
 *    rows: front ports, uplinks, one row set per module slot (labelled with the slot), the PtP radio row and the
 *    console row last. Wi-Fi/cellular radios and virtual interfaces are never pickable (`isPickablePort`).
 *  • LED state is encoded by shape and colour: link up (filled circle), up with the line protocol down (half
 *    filled circle), enabled without link (hollow ring), shut down (grey square), error-disabled (crossed square).
 *
 * Nothing here branches on device kind (D2/D3); everything is pure and unit-tested.
 */
import type { Graphics } from 'pixi.js';
import {
  portKey,
  type DeviceId,
  type DeviceSnapshot,
  type LinkId,
  type LinkSnapshot,
  type PortRef,
  type PortSnapshot,
  type SimSnapshot,
} from '@netforge/engine';
import { isPickablePort } from '../app/cable/cable-compat';
import type { IconDef } from '../catalog/icon-types';
import { visualForModel } from '../catalog/visuals';
import { lineProtocolText } from '../vocab/media';
import type { Rect, ThemeColors } from './scene';

export const PORT_DOT_R = 3.5;
export const PORT_HIT_R = 7;
const EDGE_INSET = 7;
/** Distance between picker dots (world units). */
export const GRID_SPACING = 12;
/** Picker dots per row before a group wraps. */
export const PICKER_COLS = 12;
/** Extra space between picker groups. */
export const PICKER_GROUP_GAP = 5;
/** Room left of the picker block for row labels ("Uplinks", slot labels). */
export const PICKER_LABEL_ROOM = 56;
/** Height reserved under the body for the name and status lines. */
export const LABEL_BLOCK = 36;
/** Spacing of antenna anchors along the top of a body. */
export const ANTENNA_SPACING = 14;
/** Antenna anchors sit this far above the body. */
export const ANTENNA_LIFT = 3;

export interface BodySize {
  halfW: number;
  halfH: number;
}

/** Visual inputs of a device (the snapshot fields `visualForModel` reads). */
export type DeviceVisualSource = Pick<DeviceSnapshot, 'kind' | 'icon' | 'capabilities'>;

/** Icon artwork of a device (model icon, else the kind's default, else the generic fallback). */
export function deviceVisual(d: DeviceVisualSource): IconDef {
  const model: { kind: DeviceSnapshot['kind']; icon?: NonNullable<DeviceSnapshot['icon']>; capabilities?: NonNullable<DeviceSnapshot['capabilities']> } = { kind: d.kind };
  if (d.icon !== undefined) model.icon = d.icon;
  if (d.capabilities !== undefined) model.capabilities = d.capabilities;
  return visualForModel(model);
}

/** Half extents of the body drawn for `def` at scale 1. */
export function bodySize(def: Pick<IconDef, 'w' | 'h'>): BodySize {
  return { halfW: def.w / 2, halfH: def.h / 2 };
}

// ── port picker model ────────────────────────────────────────────────────────

export type PickerGroupKind = 'front' | 'uplink' | 'slot' | 'radio' | 'console';

/** One group of the port picker (before wrapping into rows). */
export interface PickerGroup {
  /** 'front', 'uplink', `slot:<id>`, 'radio', 'console'. */
  key: string;
  kind: PickerGroupKind;
  /** Row label (empty for the front ports). */
  label: string;
  ports: PortSnapshot[];
}

const GROUP_RANK: Readonly<Record<PickerGroupKind, number>> = { front: 0, uplink: 1, slot: 2, radio: 3, console: 4 };

/** Picker group of a port, or null when the port never appears in the picker. */
export function pickerGroupOf(port: PortSnapshot): { key: string; kind: PickerGroupKind; slot?: string } | null {
  if (!isPickablePort(port)) return null;
  if (port.kind === 'console' || port.kind === 'usb' || port.role === 'console' || port.group === 'console') {
    return { key: 'console', kind: 'console' };
  }
  if (port.kind === 'radio' || port.role === 'radio-ptp' || port.group === 'radio') return { key: 'radio', kind: 'radio' };
  const groupSlot = port.group !== undefined && port.group.startsWith('slot:') ? port.group.slice(5) : undefined;
  const slot = port.module !== undefined ? (port.slot ?? port.module.slot) : groupSlot;
  if (slot !== undefined) return { key: `slot:${slot}`, kind: 'slot', slot };
  if (port.group === 'uplink') return { key: 'uplink', kind: 'uplink' };
  return { key: 'front', kind: 'front' };
}

/** Original row label of a picker group. */
export function pickerGroupLabel(kind: PickerGroupKind, slotLabel?: string): string {
  switch (kind) {
    case 'front':
      return '';
    case 'uplink':
      return 'Uplinks';
    case 'slot':
      return slotLabel ?? 'Module';
    case 'radio':
      return 'Radio';
    case 'console':
      return 'Console';
  }
}

/**
 * Picker groups of a device: front ports, uplinks, module slots in chassis slot order (slots the snapshot does
 * not list follow in order of appearance), the PtP radio group and the console group last. Ports keep snapshot
 * order inside a group. Groups without ports are omitted.
 */
export function pickerGroups(device: Pick<DeviceSnapshot, 'ports' | 'slots'>): PickerGroup[] {
  const byKey = new Map<string, PickerGroup>();
  const slotOrder = new Map<string, number>();
  (device.slots ?? []).forEach((s, i) => slotOrder.set(s.id, i));
  const firstSeen = new Map<string, number>();
  for (const port of device.ports) {
    const g = pickerGroupOf(port);
    if (!g) continue;
    let group = byKey.get(g.key);
    if (!group) {
      const slotLabel = g.slot !== undefined ? (device.slots?.find((s) => s.id === g.slot)?.label ?? `Slot ${g.slot}`) : undefined;
      group = { key: g.key, kind: g.kind, label: pickerGroupLabel(g.kind, slotLabel), ports: [] };
      byKey.set(g.key, group);
      firstSeen.set(g.key, firstSeen.size);
    }
    group.ports.push(port);
  }
  const slotRank = (key: string): number => {
    const id = key.slice(5);
    const known = slotOrder.get(id);
    return known !== undefined ? known : slotOrder.size + (firstSeen.get(key) ?? 0);
  };
  return [...byKey.values()].sort((a, b) => {
    const r = GROUP_RANK[a.kind] - GROUP_RANK[b.kind];
    if (r !== 0) return r;
    if (a.kind === 'slot') return slotRank(a.key) - slotRank(b.key);
    return 0;
  });
}

/** One laid-out picker row. */
export interface PickerRowGeom {
  /** Group key; wrapped rows of one group share it. */
  group: string;
  kind: PickerGroupKind;
  /** Label drawn left of the row (only on the first row of a labelled group). */
  label: string;
  /** World y of the dots. */
  y: number;
  /** World x of the first dot. */
  x0: number;
  count: number;
}

export interface PickerGeom {
  rows: PickerRowGeom[];
  /** Half width of the dot block around the device centre. */
  halfW: number;
  /** World y of the lowest dot. */
  bottom: number;
}

/** Top of the cable-tool port picker for a device. */
export function gridTop(g: Pick<DeviceGeom, 'y' | 'halfH'>): number {
  return g.y + g.halfH + LABEL_BLOCK + 4;
}

/**
 * Lay the picker groups out under the device: rows of up to PICKER_COLS dots, left-aligned on a block centred
 * on the device, PICKER_GROUP_GAP between groups. Returns the geometry and each port's anchor position (in
 * group order).
 */
export function layoutPicker(
  g: Pick<DeviceGeom, 'x' | 'y' | 'halfH'>,
  groups: readonly PickerGroup[],
): { geom: PickerGeom; dots: { port: PortSnapshot; x: number; y: number }[] } {
  const rows: PickerRowGeom[] = [];
  const dots: { port: PortSnapshot; x: number; y: number }[] = [];
  let widest = 0;
  for (const grp of groups) widest = Math.max(widest, Math.min(PICKER_COLS, grp.ports.length));
  const width = Math.max(0, (widest - 1) * GRID_SPACING);
  const x0 = g.x - width / 2;
  let y = gridTop(g);
  let bottom = y;
  groups.forEach((grp, gi) => {
    if (gi > 0) y += PICKER_GROUP_GAP;
    const rowCount = Math.ceil(grp.ports.length / PICKER_COLS);
    for (let r = 0; r < rowCount; r++) {
      const count = Math.min(PICKER_COLS, grp.ports.length - r * PICKER_COLS);
      rows.push({ group: grp.key, kind: grp.kind, label: r === 0 ? grp.label : '', y, x0, count });
      for (let i = 0; i < count; i++) {
        const port = grp.ports[r * PICKER_COLS + i];
        if (port) dots.push({ port, x: x0 + i * GRID_SPACING, y });
      }
      bottom = y;
      y += GRID_SPACING;
    }
  });
  return { geom: { rows, halfW: width / 2, bottom }, dots };
}

// ── layout ───────────────────────────────────────────────────────────────────

export interface DeviceGeom {
  device: DeviceSnapshot;
  x: number;
  y: number;
  halfW: number;
  halfH: number;
  /** Icon artwork (identity-stable per icon and badge). */
  visual: IconDef;
  /** Port picker layout; present only when the layout was computed with the picker. */
  picker?: PickerGeom;
}

export type Side = 'left' | 'right' | 'top' | 'bottom';

export interface PortAnchor {
  ref: PortRef;
  key: string;
  port: PortSnapshot;
  device: DeviceSnapshot;
  x: number;
  y: number;
  /** Outward unit normal (direction the cable leaves the port). */
  nx: number;
  ny: number;
}

export interface Layout {
  devices: Map<DeviceId, DeviceGeom>;
  /** Cabled ports, on the body edge facing the peer. */
  edge: Map<string, PortAnchor>;
  /** Pickable ports in the cable-tool picker (empty unless computed with the picker). */
  grid: Map<string, PortAnchor>;
  /** Radio ports (wlan, cellular, radio) on top of the body. */
  antenna: Map<string, PortAnchor>;
  links: Map<LinkId, LinkSnapshot>;
}

export function emptyLayout(): Layout {
  return { devices: new Map(), edge: new Map(), grid: new Map(), antenna: new Map(), links: new Map() };
}

export type Position = { x: number; y: number };

export interface LayoutOptions {
  /** Lay out the cable-tool port picker. */
  picker?: boolean;
}

/** True for a PtP radio link (drawn as a beam between antenna anchors, never as a cable). */
export function isRadioLink(link: Pick<LinkSnapshot, 'kind' | 'resolvedMedia' | 'media'>): boolean {
  return link.kind === 'radio' || link.resolvedMedia === 'radio' || link.media === 'radio';
}

/** True for a port that radiates (Wi-Fi, cellular or PtP radio). */
export function isRadioPort(port: Pick<PortSnapshot, 'kind' | 'radio'>): boolean {
  return port.radio !== undefined || port.kind === 'wlan' || port.kind === 'cellular' || port.kind === 'radio';
}

export function pickSide(dx: number, dy: number, g: Pick<DeviceGeom, 'halfW' | 'halfH'>): Side {
  const ndx = dx / g.halfW;
  const ndy = dy / g.halfH;
  if (Math.abs(ndx) >= Math.abs(ndy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

function edgePoint(g: DeviceGeom, side: Side, t: number): { x: number; y: number; nx: number; ny: number } {
  const alongH = -g.halfH + EDGE_INSET + t * Math.max(0, 2 * g.halfH - 2 * EDGE_INSET);
  const alongW = -g.halfW + EDGE_INSET + t * Math.max(0, 2 * g.halfW - 2 * EDGE_INSET);
  switch (side) {
    case 'right':
      return { x: g.x + g.halfW, y: g.y + alongH, nx: 1, ny: 0 };
    case 'left':
      return { x: g.x - g.halfW, y: g.y + alongH, nx: -1, ny: 0 };
    case 'top':
      return { x: g.x + alongW, y: g.y - g.halfH, nx: 0, ny: -1 };
    case 'bottom':
    default:
      return { x: g.x + alongW, y: g.y + g.halfH, nx: 0, ny: 1 };
  }
}

/** Antenna anchor positions for `count` radios of a body centred at (x, y). */
export function antennaPoints(g: Pick<DeviceGeom, 'x' | 'y' | 'halfH'>, count: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ x: g.x + (i - (count - 1) / 2) * ANTENNA_SPACING, y: g.y - g.halfH - ANTENNA_LIFT });
  }
  return out;
}

/** World bounds of a device including its label block (and the port picker when shown and laid out). */
export function deviceBounds(g: DeviceGeom, withGrid: boolean): Rect {
  const top = g.y - g.halfH - ANTENNA_LIFT;
  if (withGrid && g.picker && g.picker.rows.length > 0) {
    const halfW = Math.max(g.halfW, g.picker.halfW + PORT_DOT_R + 2);
    const labelled = g.picker.rows.some((r) => r.label !== '');
    const labelLeft = g.x - g.picker.halfW - PICKER_LABEL_ROOM;
    const left = labelled ? Math.min(g.x - halfW, labelLeft) : g.x - halfW;
    return { minX: left, minY: top, maxX: g.x + halfW, maxY: g.picker.bottom + PORT_DOT_R + 3 };
  }
  return { minX: g.x - g.halfW, minY: top, maxX: g.x + g.halfW, maxY: g.y + g.halfH + LABEL_BLOCK - 4 };
}

interface EdgeEntry {
  ref: PortRef;
  port: PortSnapshot;
  device: DeviceSnapshot;
  sortKey: number;
}

function portMap(cache: Map<DeviceId, Map<string, PortSnapshot>>, d: DeviceSnapshot): Map<string, PortSnapshot> {
  let m = cache.get(d.id);
  if (!m) {
    m = new Map();
    for (const p of d.ports) m.set(p.id, p);
    cache.set(d.id, m);
  }
  return m;
}

/** Compute every device position and port anchor from the snapshot plus local drag overrides. */
export function computeLayout(snapshot: SimSnapshot | null, overrides: ReadonlyMap<DeviceId, Position>, opts: LayoutOptions = {}): Layout {
  const layout = emptyLayout();
  if (!snapshot) return layout;

  for (const d of snapshot.devices) {
    const pos = overrides.get(d.id) ?? d.position;
    const visual = deviceVisual(d);
    const { halfW, halfH } = bodySize(visual);
    layout.devices.set(d.id, { device: d, x: pos.x, y: pos.y, halfW, halfH, visual });
  }

  const ports = new Map<DeviceId, Map<string, PortSnapshot>>();
  const groups = new Map<string, { geom: DeviceGeom; side: Side; entries: EdgeEntry[] }>();
  for (const link of snapshot.links) {
    layout.links.set(link.id, link);
    if (isRadioLink(link)) continue;
    const ends: [PortRef, PortRef, number][] = [
      [link.a, link.b, -1],
      [link.b, link.a, 1],
    ];
    for (const [self, peer, loopSign] of ends) {
      const g = layout.devices.get(self.device);
      const pg = layout.devices.get(peer.device);
      if (!g || !pg) continue;
      const port = portMap(ports, g.device).get(self.port);
      if (!port) continue;
      const selfLoop = self.device === peer.device;
      const dx = selfLoop ? 1 : pg.x - g.x;
      const dy = selfLoop ? 0 : pg.y - g.y;
      const side = pickSide(dx, dy, g);
      const vertical = side === 'left' || side === 'right';
      const sortKey = selfLoop ? loopSign : vertical ? pg.y : pg.x;
      const gk = `${g.device.id}|${side}`;
      let group = groups.get(gk);
      if (!group) {
        group = { geom: g, side, entries: [] };
        groups.set(gk, group);
      }
      group.entries.push({ ref: self, port, device: g.device, sortKey });
    }
  }
  for (const { geom, side, entries } of groups.values()) {
    entries.sort((a, b) => a.sortKey - b.sortKey || (a.port.id < b.port.id ? -1 : a.port.id > b.port.id ? 1 : 0));
    const n = entries.length;
    entries.forEach((e, i) => {
      const p = edgePoint(geom, side, (i + 1) / (n + 1));
      const key = portKey(e.ref);
      layout.edge.set(key, { ref: e.ref, key, port: e.port, device: e.device, ...p });
    });
  }

  for (const g of layout.devices.values()) {
    const radios = g.device.ports.filter(isRadioPort);
    if (radios.length > 0) {
      const pts = antennaPoints(g, radios.length);
      radios.forEach((port, i) => {
        const p = pts[i];
        if (!p) return;
        const ref: PortRef = { device: g.device.id, port: port.id };
        const key = portKey(ref);
        layout.antenna.set(key, { ref, key, port, device: g.device, x: p.x, y: p.y, nx: 0, ny: -1 });
      });
    }
    if (opts.picker) {
      const { geom, dots } = layoutPicker(g, pickerGroups(g.device));
      g.picker = geom;
      for (const dot of dots) {
        const ref: PortRef = { device: g.device.id, port: dot.port.id };
        const key = portKey(ref);
        layout.grid.set(key, { ref, key, port: dot.port, device: g.device, x: dot.x, y: dot.y, nx: 0, ny: 1 });
      }
    }
  }
  return layout;
}

/** Whether the snapshot `next` replaced every device of `prev` (a load or reset), by id. */
export function snapshotReplaced(prev: Pick<SimSnapshot, 'devices'> | null, next: Pick<SimSnapshot, 'devices'> | null): boolean {
  if (!prev || !next || prev.devices.length === 0 || next.devices.length === 0) return false;
  const old = new Set(prev.devices.map((d) => d.id));
  return !next.devices.some((d) => old.has(d.id));
}

/** Where a cable, beam or leg attaches to a port: its edge anchor, else its antenna anchor, else the picker dot. */
export function anchorOf(layout: Layout, key: string): PortAnchor | undefined {
  return layout.edge.get(key) ?? layout.antenna.get(key) ?? layout.grid.get(key);
}

// ── LEDs ─────────────────────────────────────────────────────────────────────

export type LedState = 'up' | 'carrier' | 'down' | 'off' | 'err';

export function ledState(p: Pick<PortSnapshot, 'operUp' | 'adminUp' | 'errDisabled' | 'phy'>): LedState {
  if (p.errDisabled !== undefined) return 'err';
  if (p.operUp) return 'up';
  if (!p.adminUp) return 'off';
  if (p.phy?.carrier === true) return 'carrier';
  return 'down';
}

export function ledLabel(s: LedState): string {
  switch (s) {
    case 'up':
      return 'link up';
    case 'carrier':
      return 'up, line protocol down';
    case 'down':
      return 'enabled, no link';
    case 'err':
      return 'error-disabled';
    case 'off':
    default:
      return 'shut down';
  }
}

export function ledColor(s: LedState, theme: ThemeColors): number {
  switch (s) {
    case 'up':
      return theme.ok;
    case 'carrier':
    case 'down':
      return theme.warn;
    case 'err':
      return theme.err;
    case 'off':
    default:
      return theme.textFaint;
  }
}

/** Draw one LED at (x, y) into `g` (which must be cleared by the caller). */
export function drawLed(g: Graphics, x: number, y: number, state: LedState, theme: ThemeColors, r = PORT_DOT_R): void {
  switch (state) {
    case 'up':
      g.circle(x, y, r).fill({ color: theme.ok }).stroke({ width: 1, color: theme.bg, alpha: 0.9 });
      break;
    case 'carrier':
      // half-filled: carrier present, line protocol down
      g.circle(x, y, r - 0.6).fill({ color: theme.bg }).stroke({ width: 1.6, color: theme.warn });
      g.moveTo(x, y - r + 0.6)
        .arc(x, y, r - 0.6, -Math.PI / 2, Math.PI / 2, true)
        .closePath()
        .fill({ color: theme.warn });
      break;
    case 'down':
      g.circle(x, y, r - 0.6).fill({ color: theme.bg }).stroke({ width: 1.6, color: theme.warn });
      break;
    case 'err':
      g.rect(x - r + 0.5, y - r + 0.5, 2 * r - 1, 2 * r - 1).fill({ color: theme.bg }).stroke({ width: 1.2, color: theme.err });
      g.moveTo(x - r + 1.5, y - r + 1.5)
        .lineTo(x + r - 1.5, y + r - 1.5)
        .moveTo(x + r - 1.5, y - r + 1.5)
        .lineTo(x - r + 1.5, y + r - 1.5)
        .stroke({ width: 1.3, color: theme.err, cap: 'round' });
      break;
    case 'off':
    default:
      g.rect(x - r + 0.5, y - r + 0.5, 2 * r - 1, 2 * r - 1)
        .fill({ color: theme.textFaint })
        .stroke({ width: 1, color: theme.bg, alpha: 0.9 });
      break;
  }
}

/** Nearest anchor within `radius` world units of (wx, wy). */
export function hitPort(anchors: ReadonlyMap<string, PortAnchor>, wx: number, wy: number, radius: number): PortAnchor | undefined {
  let best: PortAnchor | undefined;
  let bestD = radius * radius;
  for (const a of anchors.values()) {
    const d = (a.x - wx) ** 2 + (a.y - wy) ** 2;
    if (d <= bestD) {
      bestD = d;
      best = a;
    }
  }
  return best;
}

function formatAddress(port: PortSnapshot): string {
  const v4 = port.l3.ipv4 ? `${port.l3.ipv4.address}/${port.l3.ipv4.prefixLen}` : '';
  return v4 ? ` · ${v4}` : '';
}

/** Tooltip text for a port: short name, LED state, line protocol reason, cabling status and address. */
export function portTitle(a: Pick<PortAnchor, 'port' | 'device'>): string {
  const led = ledState(a.port);
  const why = led === 'carrier' ? lineProtocolText(a.port.phy?.lineProtocolReason) : '';
  const state = why ? `${ledLabel(led)} (${why})` : ledLabel(led);
  const radio = a.port.radio;
  if (radio !== undefined) {
    const net = radio.ssid !== undefined ? ` · "${radio.ssid}"` : '';
    return `${a.device.name} ${a.port.short} — radio ${radio.up || a.port.operUp ? 'on' : 'idle'}${net} · ${radio.band === 'cell' ? 'cellular' : `${radio.band} GHz ch ${radio.channel}`}${formatAddress(a.port)}`;
  }
  const cabled = a.port.link ? 'cabled' : 'free';
  return `${a.device.name} ${a.port.short} — ${state} · ${cabled}${formatAddress(a.port)}`;
}
