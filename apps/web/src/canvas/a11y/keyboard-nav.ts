/**
 * Keyboard canvas model (spec §16; ARCHITECTURE-P1 §7 "Keyboard canvas", §8.1 W6 web-canvas).
 *
 * Pure helpers behind the DOM outline (CanvasOutline.tsx) and the keyboard cabling flow (KeyboardCabling.tsx):
 *  - spatial arrow-key navigation over device positions (a 90° cone in the arrow direction, half-plane fallback);
 *  - reading order (rows of GRID_ROW_BAND world units, then x) for Home/End and linear stepping;
 *  - cable-graph traversal (the peers of a device across its links);
 *  - the outline model: devices → ports, links and wireless associations, each with original wording that never
 *    relies on colour (status glyph + words);
 *  - keyboard cabling candidates (source ports of a device, target ports for a source), driven by the same
 *    engine cable validator as the pointer port picker (app/cable/cable-compat.ts);
 *  - the canvas projection of a device position through the store camera.
 *
 * Nothing here branches on device kind (D2/D3) or touches the DOM, so it is unit-tested directly.
 */
import { portKey, samePort } from '@netforge/engine';
import type {
  AssociationSnapshot,
  DeviceId,
  DeviceSnapshot,
  LinkId,
  LinkSnapshot,
  MediaType,
  PortRef,
  PortSnapshot,
  SimSnapshot,
} from '@netforge/engine';
import { isPickablePort, portCompat, type CableLookup, type PortCompat } from '../../app/cable/cable-compat.js';
import { portKindLabel } from '../../vocab/categories.js';
import { linkDownText, mediaName } from '../../vocab/media.js';
import type { SnapshotIndex } from '../../store/types.js';

/** Height (world units) of one reading-order row: devices whose y falls in the same band read left to right. */
export const GRID_ROW_BAND = 40;

// ── canvas bridge ────────────────────────────────────────────────────────────

/**
 * The object the a11y layer hands to `registerCanvasA11y` (canvas/Canvas.tsx). The canvas calls it:
 *  - `focusDevice(id)` when a device gets focus on the canvas (the outline moves its roving focus there);
 *  - `screenPoint(id)` to place keyboard-opened popups next to a device (canvas-local pixels, null when unknown);
 *  - `beginCable(from)` to continue a cable in the keyboard cabling dialog.
 */
export interface CanvasA11yApi {
  focusDevice(id: DeviceId): void;
  screenPoint(id: DeviceId): { x: number; y: number } | null;
  beginCable(from: PortRef): void;
}

/** World → canvas-local pixels through the camera (inverse of `Scene.localToWorld`). */
export function screenPointOf(position: { x: number; y: number }, camera: { x: number; y: number; zoom: number }): { x: number; y: number } {
  return { x: Math.round(position.x * camera.zoom + camera.x), y: Math.round(position.y * camera.zoom + camera.y) };
}

// ── lookups ──────────────────────────────────────────────────────────────────

/** A device by id: O(1) through the snapshot index when it matches, else a scan (index missing or stale). */
export function deviceById(snapshot: Pick<SimSnapshot, 'devices' | 'topologyVersion'> | null, index: SnapshotIndex | undefined, id: DeviceId): DeviceSnapshot | undefined {
  if (snapshot === null) return undefined;
  if (index !== undefined && index.topologyVersion === snapshot.topologyVersion) {
    const i = index.devices[id];
    const hit = i === undefined ? undefined : snapshot.devices[i];
    if (hit !== undefined && hit.id === id) return hit;
  }
  return snapshot.devices.find((d) => d.id === id);
}

/** A link by id, like `deviceById`. */
export function linkById(snapshot: Pick<SimSnapshot, 'links' | 'topologyVersion'> | null, index: SnapshotIndex | undefined, id: LinkId): LinkSnapshot | undefined {
  if (snapshot === null) return undefined;
  if (index !== undefined && index.topologyVersion === snapshot.topologyVersion) {
    const i = index.links[id];
    const hit = i === undefined ? undefined : snapshot.links[i];
    if (hit !== undefined && hit.id === id) return hit;
  }
  return snapshot.links.find((l) => l.id === id);
}

// ── spatial navigation ───────────────────────────────────────────────────────

export type NavDirection = 'up' | 'down' | 'left' | 'right';

/** One navigable device position (world units). */
export interface NavPoint {
  readonly id: DeviceId;
  readonly x: number;
  readonly y: number;
}

/** Arrow key → direction (null for every other key). */
export function directionForKey(key: string): NavDirection | null {
  switch (key) {
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case 'ArrowLeft':
      return 'left';
    case 'ArrowRight':
      return 'right';
    default:
      return null;
  }
}

/** Device positions of a snapshot, with optional local overrides (a device being dragged). */
export function navPoints(devices: readonly Pick<DeviceSnapshot, 'id' | 'position'>[], overrides?: ReadonlyMap<DeviceId, { x: number; y: number }>): NavPoint[] {
  return devices.map((d) => {
    const p = overrides?.get(d.id) ?? d.position;
    return { id: d.id, x: p.x, y: p.y };
  });
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Reading order: rows of GRID_ROW_BAND world units top to bottom, left to right inside a row, then id. */
export function readingOrder(points: readonly NavPoint[]): NavPoint[] {
  return [...points].sort((a, b) => {
    const ra = Math.floor(a.y / GRID_ROW_BAND);
    const rb = Math.floor(b.y / GRID_ROW_BAND);
    if (ra !== rb) return ra - rb;
    if (a.x !== b.x) return a.x - b.x;
    if (a.y !== b.y) return a.y - b.y;
    return compareIds(a.id, b.id);
  });
}

/**
 * The device an arrow key moves to from `from`.
 *
 * Candidates lie strictly ahead in the arrow direction. Those inside the 90° cone (sideways offset ≤ forward
 * distance) win over the rest of the half-plane. Within a tier the score is `forward + 2 × sideways`, so a device
 * straight ahead beats a nearer one far off-axis; ties prefer the smaller sideways offset, then the id. Devices on
 * the same spot as `from` are never targets. Null when nothing lies that way or `from` is unknown.
 */
export function spatialNeighbour(points: readonly NavPoint[], from: DeviceId, dir: NavDirection): DeviceId | null {
  const origin = points.find((p) => p.id === from);
  if (origin === undefined) return null;
  let best: { id: DeviceId; cone: boolean; score: number; side: number } | null = null;
  for (const p of points) {
    if (p.id === from) continue;
    const dx = p.x - origin.x;
    const dy = p.y - origin.y;
    const forward = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy;
    const side = Math.abs(dir === 'left' || dir === 'right' ? dy : dx);
    if (forward <= 0) continue;
    const cone = side <= forward;
    const score = forward + 2 * side;
    const better =
      best === null ||
      (cone && !best.cone) ||
      (cone === best.cone && (score < best.score || (score === best.score && (side < best.side || (side === best.side && compareIds(p.id, best.id) < 0)))));
    if (better) best = { id: p.id, cone, score, side };
  }
  return best === null ? null : best.id;
}

/** First device in reading order (null for an empty workspace). */
export function firstDevice(points: readonly NavPoint[]): DeviceId | null {
  return readingOrder(points)[0]?.id ?? null;
}

/** Last device in reading order. */
export function lastDevice(points: readonly NavPoint[]): DeviceId | null {
  const order = readingOrder(points);
  return order[order.length - 1]?.id ?? null;
}

/**
 * The id `delta` steps from `current` in `ids`. Clamped at the ends unless `wrap`. An unknown `current` starts
 * from before the first item (delta > 0) or after the last (delta < 0). Null for an empty list.
 */
export function stepInOrder<T>(ids: readonly T[], current: T | null, delta: number, wrap = false): T | null {
  if (ids.length === 0) return null;
  const at = current === null ? -1 : ids.indexOf(current);
  let next: number;
  if (at < 0) next = delta > 0 ? delta - 1 : ids.length + delta;
  else next = at + delta;
  if (wrap) next = ((next % ids.length) + ids.length) % ids.length;
  else next = Math.max(0, Math.min(ids.length - 1, next));
  return ids[next] ?? null;
}

// ── cable graph ──────────────────────────────────────────────────────────────

/** One cable leaving a device. */
export interface CabledPeer {
  readonly link: LinkId;
  readonly local: PortRef;
  readonly peer: PortRef;
}

/** Cables of `device` in snapshot link order (a link looping back to the same device lists both ends). */
export function cabledPeers(links: readonly Pick<LinkSnapshot, 'id' | 'a' | 'b'>[], device: DeviceId): CabledPeer[] {
  const out: CabledPeer[] = [];
  for (const l of links) {
    if (l.a.device === device) out.push({ link: l.id, local: l.a, peer: l.b });
    if (l.b.device === device) out.push({ link: l.id, local: l.b, peer: l.a });
  }
  return out;
}

/**
 * The next cable neighbour for graph traversal: after the peer device reached last time (`previousPeer`), in
 * link order, wrapping. Distinct peer devices only; null when the device has no cabled neighbour.
 */
export function nextPeerDevice(links: readonly Pick<LinkSnapshot, 'id' | 'a' | 'b'>[], device: DeviceId, previousPeer: DeviceId | null): DeviceId | null {
  const peers: DeviceId[] = [];
  for (const c of cabledPeers(links, device)) {
    if (c.peer.device !== device && !peers.includes(c.peer.device)) peers.push(c.peer.device);
  }
  return stepInOrder(peers, previousPeer !== null && peers.includes(previousPeer) ? previousPeer : null, 1, true);
}

// ── outline model ────────────────────────────────────────────────────────────

/** Port row of the outline. */
export interface OutlinePort {
  readonly ref: PortRef;
  readonly key: string;
  /** Port name, e.g. `GigabitEthernet0/1`. */
  readonly label: string;
  /** Glyph + words, e.g. `● up`, `○ down`. */
  readonly status: string;
  /** Full sentence for screen readers. */
  readonly description: string;
  readonly link?: LinkId;
  readonly peer?: PortRef;
}

/** Device row of the outline. */
export interface OutlineDevice {
  readonly id: DeviceId;
  readonly name: string;
  readonly position: { x: number; y: number };
  /** `PC1, NF-PC` */
  readonly label: string;
  readonly description: string;
  readonly ports: readonly OutlinePort[];
}

/** Link row of the outline. */
export interface OutlineLink {
  readonly id: LinkId;
  readonly a: PortRef;
  readonly b: PortRef;
  readonly up: boolean;
  readonly label: string;
  readonly description: string;
}

/** Association row of the outline (Wi-Fi association or cellular attachment). */
export interface OutlineAssociation {
  readonly id: string;
  readonly station: PortRef;
  readonly ap?: PortRef;
  readonly label: string;
  readonly description: string;
}

export interface CanvasOutlineModel {
  /** Reading order. */
  readonly devices: readonly OutlineDevice[];
  readonly links: readonly OutlineLink[];
  readonly associations: readonly OutlineAssociation[];
}

/** Status glyph and words of a port; the glyph shapes match the inspector (never colour alone). */
export function portStatusText(port: Pick<PortSnapshot, 'adminUp' | 'operUp' | 'errDisabled' | 'phy'>, devicePower: boolean): string {
  if (!devicePower) return '■ device off';
  if (port.errDisabled !== undefined) return '✖ error-disabled';
  if (!port.adminUp) return '■ shut down';
  if (port.operUp) return '● up';
  if (port.phy?.carrier === true) return '▲ up, line protocol down';
  return '○ down';
}

/** `3 of 4 bars` */
export function barsText(bars: number): string {
  return `${bars} of 4 ${bars === 1 ? 'bar' : 'bars'}`;
}

/** `100 Mb/s` style rate. */
export function rateText(bps: number): string {
  if (bps >= 1_000_000_000) return `${trimNumber(bps / 1_000_000_000)} Gb/s`;
  if (bps >= 1_000_000) return `${trimNumber(bps / 1_000_000)} Mb/s`;
  if (bps >= 1_000) return `${trimNumber(bps / 1_000)} kb/s`;
  return `${bps} b/s`;
}

function trimNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Name lookups shared by the outline and the announcer. */
export interface NameBook {
  device(id: DeviceId): string;
  /** `SW1 FastEthernet0/1` */
  port(ref: PortRef): string;
}

/** A name book over a snapshot (unknown ids fall back to the raw id). */
export function nameBook(snapshot: Pick<SimSnapshot, 'devices'> | null): NameBook {
  const names = new Map<DeviceId, string>();
  for (const d of snapshot?.devices ?? []) names.set(d.id, d.name);
  const device = (id: DeviceId): string => names.get(id) ?? id;
  return Object.freeze({ device, port: (ref: PortRef) => `${device(ref.device)} ${ref.port}` });
}

/** `PC1 GigabitEthernet0 to SW1 FastEthernet0/1` */
export function linkEndsText(link: Pick<LinkSnapshot, 'a' | 'b'>, names: NameBook): string {
  return `${names.port(link.a)} to ${names.port(link.b)}`;
}

/** State words of a link: `up at 100 Mb/s` or `down: <short reason>`. */
export function linkStateText(link: Pick<LinkSnapshot, 'a' | 'b' | 'up' | 'downReason' | 'negotiatedBps'>, names: NameBook): string {
  if (link.up) return link.negotiatedBps !== undefined ? `up at ${rateText(link.negotiatedBps)}` : 'up';
  const text = linkDownText(link.downReason, {
    deviceA: names.device(link.a.device),
    deviceB: names.device(link.b.device),
    endA: names.port(link.a),
    endB: names.port(link.b),
  });
  return `down: ${text.short}`;
}

const ASSOC_STATE_WORDS: Readonly<Record<AssociationSnapshot['state'], string>> = Object.freeze({
  idle: 'idle',
  scanning: 'scanning',
  authenticating: 'authenticating',
  associating: 'associating',
  handshake: 'exchanging keys',
  associated: 'associated',
  failed: 'failed',
  searching: 'searching for a cell',
  attaching: 'attaching',
  attached: 'attached',
  detached: 'detached',
});

/** Words for a Wi-Fi association or cellular attach state. */
export function associationStateText(state: AssociationSnapshot['state']): string {
  return ASSOC_STATE_WORDS[state];
}

/** Build the outline from a snapshot. Devices in reading order, ports and links in snapshot order. */
export function buildOutline(snapshot: Pick<SimSnapshot, 'devices' | 'links' | 'media'> | null): CanvasOutlineModel {
  if (snapshot === null) return Object.freeze({ devices: [], links: [], associations: [] });
  const names = nameBook(snapshot);
  const linkOf = new Map<string, LinkSnapshot>();
  for (const l of snapshot.links) {
    linkOf.set(portKey(l.a), l);
    linkOf.set(portKey(l.b), l);
  }
  const order = readingOrder(navPoints(snapshot.devices));
  const byId = new Map<DeviceId, DeviceSnapshot>();
  for (const d of snapshot.devices) byId.set(d.id, d);

  const devices: OutlineDevice[] = [];
  for (const p of order) {
    const d = byId.get(p.id);
    if (d === undefined) continue;
    const ports: OutlinePort[] = d.ports.map((port) => {
      const ref: PortRef = { device: d.id, port: port.id };
      const key = portKey(ref);
      const link = linkOf.get(key);
      const peer = link === undefined ? undefined : samePort(link.a, ref) ? link.b : link.a;
      const status = portStatusText(port, d.power);
      const kind = portKindLabel(port.kind);
      const cable = link === undefined || peer === undefined ? 'not connected' : `connected to ${names.port(peer)} by ${mediaName(link.resolvedMedia)}`;
      const out: { -readonly [K in keyof OutlinePort]: OutlinePort[K] } = {
        ref,
        key,
        label: port.id,
        status,
        description: `${port.id}, ${kind} port, ${status.slice(2)}, ${cable}.`,
      };
      if (link !== undefined) out.link = link.id;
      if (peer !== undefined) out.peer = peer;
      return Object.freeze(out);
    });
    const connected = ports.filter((x) => x.link !== undefined).length;
    const power = d.power ? (d.booted ? 'on' : 'starting') : 'off';
    devices.push(
      Object.freeze({
        id: d.id,
        name: d.name,
        position: { x: d.position.x, y: d.position.y },
        label: `${d.name}, ${d.model}`,
        description: `${d.name}, ${d.model}, power ${power}, ${plural(d.ports.length, 'port', 'ports')}, ${connected} connected.`,
        ports: Object.freeze(ports),
      }),
    );
  }

  const links: OutlineLink[] = snapshot.links.map((l) => {
    const ends = linkEndsText(l, names);
    const state = linkStateText(l, names);
    const glyph = l.up ? '●' : '○';
    return Object.freeze({
      id: l.id,
      a: l.a,
      b: l.b,
      up: l.up,
      label: `${glyph} ${ends}`,
      description: `Cable from ${ends}, ${mediaName(l.resolvedMedia)}, ${state}.`,
    });
  });

  const associations: OutlineAssociation[] = (snapshot.media?.associations ?? []).map((a) => {
    const target = a.ap !== undefined ? names.port(a.ap) : a.tech === 'cellular' ? 'the cell' : 'the air';
    const tech = a.tech === 'wifi' ? `Wi-Fi${a.ssid !== undefined ? ` "${a.ssid}"` : ''}` : 'Cellular';
    const state = associationStateText(a.state);
    const signal = `${barsText(a.bars)}, ${a.rssiDbm} dBm`;
    const out: { -readonly [K in keyof OutlineAssociation]: OutlineAssociation[K] } = {
      id: a.id,
      station: a.station,
      label: `${names.port(a.station)} → ${target}`,
      description: `${tech}: ${names.port(a.station)} to ${target}, ${state}, ${signal}${a.rateBps > 0 ? `, ${rateText(a.rateBps)}` : ''}.`,
    };
    if (a.ap !== undefined) out.ap = a.ap;
    return Object.freeze(out);
  });

  return Object.freeze({ devices: Object.freeze(devices), links: Object.freeze(links), associations: Object.freeze(associations) });
}

// ── outline keys ─────────────────────────────────────────────────────────────

/** Tree item keys of the outline: groups `g:*`, devices `d:<id>`, ports `p:<device>/<port>`, links `l:<id>`, associations `a:<id>`. */
export type OutlineGroup = 'devices' | 'links' | 'associations';

export type OutlineItem =
  | { kind: 'group'; group: OutlineGroup; key: string }
  | { kind: 'device'; id: DeviceId; key: string }
  | { kind: 'port'; ref: PortRef; key: string }
  | { kind: 'link'; id: LinkId; key: string }
  | { kind: 'association'; id: string; key: string };

export const groupKey = (g: OutlineGroup): string => `g:${g}`;
export const deviceKey = (id: DeviceId): string => `d:${id}`;
export const portItemKey = (ref: PortRef): string => `p:${portKey(ref)}`;
export const linkKey = (id: LinkId): string => `l:${id}`;
export const associationKey = (id: string): string => `a:${id}`;

/** Expansion state of the outline. */
export interface OutlineExpansion {
  readonly groups: ReadonlySet<OutlineGroup>;
  readonly devices: ReadonlySet<DeviceId>;
}

/** Visible tree items in document order (the linear order of Up/Down on groups, links and associations). */
export function visibleItems(model: CanvasOutlineModel, expansion: OutlineExpansion): OutlineItem[] {
  const out: OutlineItem[] = [];
  out.push({ kind: 'group', group: 'devices', key: groupKey('devices') });
  if (expansion.groups.has('devices')) {
    for (const d of model.devices) {
      out.push({ kind: 'device', id: d.id, key: deviceKey(d.id) });
      if (expansion.devices.has(d.id)) for (const p of d.ports) out.push({ kind: 'port', ref: p.ref, key: portItemKey(p.ref) });
    }
  }
  out.push({ kind: 'group', group: 'links', key: groupKey('links') });
  if (expansion.groups.has('links')) for (const l of model.links) out.push({ kind: 'link', id: l.id, key: linkKey(l.id) });
  if (model.associations.length > 0) {
    out.push({ kind: 'group', group: 'associations', key: groupKey('associations') });
    if (expansion.groups.has('associations')) {
      for (const a of model.associations) out.push({ kind: 'association', id: a.id, key: associationKey(a.id) });
    }
  }
  return out;
}

/** The device an outline item belongs to (devices and ports), else null. */
export function deviceOfItem(item: OutlineItem): DeviceId | null {
  if (item.kind === 'device') return item.id;
  if (item.kind === 'port') return item.ref.device;
  return null;
}

// ── keyboard cabling ─────────────────────────────────────────────────────────

/** One port offered in the keyboard cabling lists. */
export interface CablingCandidate {
  readonly ref: PortRef;
  readonly key: string;
  readonly deviceName: string;
  /** `SW1 FastEthernet0/1` */
  readonly label: string;
  readonly compat: PortCompat;
  /** `✓ works` / `✕ <reason>` (glyph + words). */
  readonly verdict: string;
}

function candidate(device: DeviceSnapshot, port: PortSnapshot, compat: PortCompat): CablingCandidate {
  const ref: PortRef = { device: device.id, port: port.id };
  const ok = compat.status === 'compatible' || compat.status === 'eligible';
  const media = compat.resolvedMedia !== undefined ? ` with ${mediaName(compat.resolvedMedia)}` : '';
  return Object.freeze({
    ref,
    key: portKey(ref),
    deviceName: device.name,
    label: `${device.name} ${port.id}`,
    compat,
    verdict: ok ? `✓ works${media}` : `✕ ${compat.reason ?? 'this cable cannot join these ports'}`,
  });
}

/**
 * Ports of `device` a cable can start from with `media`: pickable and free. Ports the media fits come first
 * ('eligible'), then the ones it does not ('incompatible', with the reason), each in port order.
 */
export function cablingSources(snapshot: Pick<SimSnapshot, 'devices'>, lookup: CableLookup, media: MediaType, device: DeviceSnapshot): CablingCandidate[] {
  const fits: CablingCandidate[] = [];
  const misfits: CablingCandidate[] = [];
  for (const port of device.ports) {
    if (!isPickablePort(port) || port.link !== undefined) continue;
    const v = portCompat(snapshot, lookup, null, media, device, port);
    if (v.status === 'eligible') fits.push(candidate(device, port, v));
    else if (v.status === 'incompatible') misfits.push(candidate(device, port, v));
  }
  return [...fits, ...misfits];
}

/** Target lists for a cable from `from`: ports the validator accepts, and free ports it refuses (with reasons). */
export interface CablingTargets {
  readonly compatible: readonly CablingCandidate[];
  readonly incompatible: readonly CablingCandidate[];
}

/**
 * Free pickable ports on OTHER devices in snapshot order, split by the validator verdict. Ports on the source
 * device are left out (the validator refuses same-device cables and the list stays short).
 */
export function cablingTargets(snapshot: Pick<SimSnapshot, 'devices'>, lookup: CableLookup, from: PortRef, media: MediaType): CablingTargets {
  const compatible: CablingCandidate[] = [];
  const incompatible: CablingCandidate[] = [];
  for (const device of snapshot.devices) {
    if (device.id === from.device) continue;
    for (const port of device.ports) {
      const v = portCompat(snapshot, lookup, from, media, device, port);
      if (v.status === 'compatible') compatible.push(candidate(device, port, v));
      else if (v.status === 'incompatible') incompatible.push(candidate(device, port, v));
    }
  }
  return Object.freeze({ compatible: Object.freeze(compatible), incompatible: Object.freeze(incompatible) });
}

/** Case-insensitive filter on every whitespace-separated word of `query` against the candidate label. */
export function filterCandidates(list: readonly CablingCandidate[], query: string): CablingCandidate[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [...list];
  return list.filter((c) => {
    const hay = c.label.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
