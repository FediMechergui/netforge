/**
 * routing/lsdb-model.ts — [S2] the pure model behind the link-state browser (ARCHITECTURE-P3 §6, §2.6, §2.14, D7, D10;
 * spec §9.7 "LSDB browser").
 *
 * From each device's `ospf-lsdb` and `ospf-interfaces` rows only (§2.6; rule 20 — the tables are what a learner can
 * also read with `show ip ospf database`):
 *
 * - **router and area pickers**: every device that runs OSPF (an interface row or an LSA), labelled with its router id
 *   in use; the areas of the chosen router (its interface areas, then the scopes of its LSAs), in numeric order;
 * - **the LSA list** of the chosen router and area: its router and network LSAs, then the AS-external LSAs, in the
 *   database order of §4.5 (type, link-state id as u32, advertising router as u32), each with its LIVE age
 *   (`lsaAgeAt`, so the list ages while the simulation runs), its sequence number in hex (`0x80000001`), and the
 *   `self` and `MaxAge` marks as words (never colour alone);
 * - **the LSA detail**: the header, the body in words (router links, attached routers, external metric), "the same in
 *   every router of this area: yes/no" (each router of the area holds the same instance, RFC 2328 §13.1 through
 *   `compareLsaInstances`), and the display filter of the packets that carried it (`ospf-lsa.*`, NetScope);
 * - **the LSDB graph**: routers at their canvas positions, transit networks at the centroid of their routers, point-to-
 *   point and transit edges with the cost each side advertises; an edge only one side lists is marked one-way (the
 *   SPF's bidirectional check would not use it).
 *
 * Pure: no React, no store, no Pixi; `now` is passed in. `deriveDeviceLsdb` depends on one device object only and is
 * memoised per device object (`lsdbOf`), like the canvas overlay models. The SPF model (`canvas/overlays/spf-model.ts`)
 * builds on the same per-device data.
 */
import {
  ospfLsaKey,
  type DeviceId,
  type DeviceSnapshot,
  type Ipv4Address,
  type LinkId,
  type OspfAreaId,
  type OspfInterfaceRow,
  type OspfLsaRow,
  type OspfLsaType,
  type OspfRouterLink,
  type PortId,
  type SimSnapshot,
  type SimTime,
} from '@netforge/engine';
import { compareLsaInstances, ipv4ToU32, lsaAgeAt, LSA_MAX_AGE_S, maskToPrefixLen, u32ToIpv4 } from '@netforge/engine/pure';
import { areaLabel } from '../canvas/overlays/ospf-model';

// ── words ────────────────────────────────────────────────────────────────────

/** The LSA type names the list and the detail show. */
export const LSA_TYPE_LABEL: Readonly<Record<number, string>> = Object.freeze({ 1: 'Router', 2: 'Network', 5: 'External' });

/** The mark of an LSA this router originated. */
export const LSA_SELF_MARK = 'self';
/** The mark of an LSA at MaxAge (being flushed). */
export const LSA_MAXAGE_MARK = 'MaxAge';

/** Words of a router link kind. */
export const ROUTER_LINK_WORD: Readonly<Record<OspfRouterLink['kind'], string>> = Object.freeze({
  p2p: 'point-to-point',
  transit: 'transit network',
  stub: 'stub network',
});

/** Type label of an LSA type (`Type 7` when unknown). */
export function lsaTypeLabel(type: number): string {
  return LSA_TYPE_LABEL[type] ?? `Type ${type}`;
}

/** A sequence number in hex, as `show ip ospf database` prints it: `0x80000001`. */
export function seqHex(seq: number): string {
  return `0x${(seq >>> 0).toString(16).padStart(8, '0')}`;
}

/** A checksum in hex: `0x00a3f1`'s 16-bit form, `0x3f1c`. */
export function checksumHex(checksum: number): string {
  return `0x${(checksum & 0xffff).toString(16).padStart(4, '0')}`;
}

/** Numeric value of a dotted area id (0.0.0.1 → 1), or NaN when it is not dotted. */
function areaNumber(area: string): number {
  const parts = area.split('.');
  if (parts.length !== 4) return Number.NaN;
  let v = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255 || p === '') return Number.NaN;
    v = v * 256 + o;
  }
  return v;
}

/** Areas in numeric order (anything that is not dotted after, by text). */
export function compareAreaIds(a: OspfAreaId, b: OspfAreaId): number {
  const x = areaNumber(a);
  const y = areaNumber(b);
  if (!Number.isNaN(x) && !Number.isNaN(y)) return x - y;
  if (Number.isNaN(x) !== Number.isNaN(y)) return Number.isNaN(x) ? 1 : -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Natural order of device names (R2 before R10), deterministic (no locale). */
export function compareNames(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  const xa = a.match(re) ?? [];
  const xb = b.match(re) ?? [];
  for (let i = 0; i < Math.min(xa.length, xb.length); i++) {
    const p = xa[i]!;
    const q = xb[i]!;
    if (p === q) continue;
    const np = /^\d+$/.test(p);
    const nq = /^\d+$/.test(q);
    if (np && nq) {
      const d = Number(p) - Number(q);
      if (d !== 0) return d;
      continue;
    }
    return p < q ? -1 : 1;
  }
  return xa.length - xb.length || (a < b ? -1 : a > b ? 1 : 0);
}

/** The database order of §4.5: scope (areas numeric, the AS scope last), type, link-state id u32, advertising router u32. */
export function compareLsaRows(a: OspfLsaRow, b: OspfLsaRow): number {
  if (a.scope !== b.scope) {
    if (a.scope === 'as') return 1;
    if (b.scope === 'as') return -1;
    return compareAreaIds(a.scope, b.scope);
  }
  return a.type - b.type || ipv4ToU32(a.lsid) - ipv4ToU32(b.lsid) || ipv4ToU32(a.advRouter) - ipv4ToU32(b.advRouter);
}

/** The row key of an LSA (`ospfLsaKey`). */
export function lsaRowKey(row: Pick<OspfLsaRow, 'scope' | 'type' | 'lsid' | 'advRouter'>): string {
  return ospfLsaKey(row.scope, row.type, row.lsid, row.advRouter);
}

// ── per device ───────────────────────────────────────────────────────────────

/** A device's link-state data. */
export interface DeviceLsdb {
  /** `ospf-lsdb` rows in database order (§4.5). */
  readonly lsas: readonly OspfLsaRow[];
  /** `ospf-interfaces` rows in canonical port order (the device's port list), then any other port. */
  readonly interfaces: readonly OspfInterfaceRow[];
  /** The router id in use (the `routerId` column of an interface row), when OSPF runs. */
  readonly routerId?: Ipv4Address;
  /** The device's ports with the link each is cabled to. */
  readonly portLinks: ReadonlyMap<PortId, LinkId>;
}

const EMPTY_LSDB: DeviceLsdb = Object.freeze({ lsas: Object.freeze([]), interfaces: Object.freeze([]), portLinks: new Map() });

function rowsOf(d: DeviceSnapshot, name: string): readonly Record<string, unknown>[] {
  return (d.tables.extra ?? []).find((t) => t.name === name)?.rows ?? [];
}

function isLsaRow(r: Record<string, unknown>): boolean {
  return (
    typeof r.scope === 'string' &&
    typeof r.type === 'number' &&
    typeof r.lsid === 'string' &&
    typeof r.advRouter === 'string' &&
    typeof r.seq === 'number' &&
    typeof r.ageAtInstall === 'number' &&
    typeof r.installedAt === 'number'
  );
}

function isInterfaceRow(r: Record<string, unknown>): boolean {
  return typeof r.port === 'string' && typeof r.area === 'string' && typeof r.state === 'string' && typeof r.routerId === 'string';
}

/** Derive a device's link-state data. Pure in the device object. */
export function deriveDeviceLsdb(d: DeviceSnapshot): DeviceLsdb {
  const lsaRows = rowsOf(d, 'ospf-lsdb');
  const ifRows = rowsOf(d, 'ospf-interfaces');
  if (lsaRows.length === 0 && ifRows.length === 0) return EMPTY_LSDB;
  const lsas = lsaRows.filter(isLsaRow).map((r) => r as unknown as OspfLsaRow);
  lsas.sort(compareLsaRows);
  const byPort = new Map<PortId, OspfInterfaceRow>();
  for (const r of ifRows) if (isInterfaceRow(r)) byPort.set(r.port as PortId, r as unknown as OspfInterfaceRow);
  const interfaces: OspfInterfaceRow[] = [];
  for (const p of d.ports) {
    const row = byPort.get(p.id);
    if (row !== undefined) interfaces.push(row);
  }
  for (const row of byPort.values()) if (!interfaces.includes(row)) interfaces.push(row);
  const portLinks = new Map<PortId, LinkId>();
  for (const p of d.ports) if (p.link !== undefined) portLinks.set(p.id, p.link);
  const routerId = interfaces.find((r) => r.routerId !== '')?.routerId;
  return routerId === undefined ? { lsas, interfaces, portLinks } : { lsas, interfaces, routerId, portLinks };
}

const lsdbMemo = new WeakMap<DeviceSnapshot, DeviceLsdb>();

/** `deriveDeviceLsdb`, memoised per device object (the store replaces a device object only when it changed). */
export function lsdbOf(d: DeviceSnapshot): DeviceLsdb {
  const hit = lsdbMemo.get(d);
  if (hit !== undefined) return hit;
  const v = deriveDeviceLsdb(d);
  lsdbMemo.set(d, v);
  return v;
}

/** True when the device runs OSPF (an interface row) or holds LSAs. */
export function runsOspf(lsdb: DeviceLsdb): boolean {
  return lsdb.interfaces.length > 0 || lsdb.lsas.length > 0;
}

/** The areas of a device: its interfaces' areas and its LSAs' area scopes, numeric order. */
export function areasOfLsdb(lsdb: DeviceLsdb): OspfAreaId[] {
  const out = new Set<OspfAreaId>();
  for (const r of lsdb.interfaces) out.add(r.area);
  for (const r of lsdb.lsas) if (r.scope !== 'as') out.add(r.scope);
  return [...out].sort(compareAreaIds);
}

/** The LSAs one area shows: its router and network LSAs, then the AS-external ones (database order). */
export function lsasOfArea(lsdb: DeviceLsdb, area: OspfAreaId): OspfLsaRow[] {
  return lsdb.lsas.filter((r) => r.scope === area || r.scope === 'as');
}

// ── the world's routers ──────────────────────────────────────────────────────

/** One router of the picker. */
export interface LsdbRouterChoice {
  readonly device: DeviceId;
  readonly name: string;
  readonly routerId?: Ipv4Address;
  /** `R1 (1.1.1.1)`, or the name alone while it has no router id. */
  readonly label: string;
  readonly areas: readonly OspfAreaId[];
}

/** Every device that runs OSPF, in natural name order. */
export function lsdbRouters(snapshot: SimSnapshot | null, perDevice: (d: DeviceSnapshot) => DeviceLsdb = lsdbOf): LsdbRouterChoice[] {
  if (snapshot === null) return [];
  const out: LsdbRouterChoice[] = [];
  for (const d of snapshot.devices) {
    const lsdb = perDevice(d);
    if (!runsOspf(lsdb)) continue;
    const base = { device: d.id, name: d.name, label: lsdb.routerId === undefined ? d.name : `${d.name} (${lsdb.routerId})`, areas: areasOfLsdb(lsdb) };
    out.push(lsdb.routerId === undefined ? base : { ...base, routerId: lsdb.routerId });
  }
  return out.sort((a, b) => compareNames(a.name, b.name) || (a.device < b.device ? -1 : a.device > b.device ? 1 : 0));
}

/** The router the browser shows: the wanted one when it runs OSPF, else the first. */
export function chooseRouter(routers: readonly LsdbRouterChoice[], wanted: DeviceId | null | undefined): LsdbRouterChoice | undefined {
  return routers.find((r) => r.device === wanted) ?? routers[0];
}

/** The area the browser shows: the wanted one when the router has it, else its first. */
export function chooseArea(areas: readonly OspfAreaId[], wanted: OspfAreaId | null | undefined): OspfAreaId | undefined {
  return wanted !== null && wanted !== undefined && areas.includes(wanted) ? wanted : areas[0];
}

/** Router id → the device that uses it (the first in snapshot order when two claim one id). */
export function routerDevices(snapshot: SimSnapshot | null, perDevice: (d: DeviceSnapshot) => DeviceLsdb = lsdbOf): Map<Ipv4Address, DeviceSnapshot> {
  const out = new Map<Ipv4Address, DeviceSnapshot>();
  if (snapshot === null) return out;
  for (const d of snapshot.devices) {
    const rid = perDevice(d).routerId;
    if (rid !== undefined && !out.has(rid)) out.set(rid, d);
  }
  return out;
}

/** Router ids that two or more devices use at once (a duplicate router id: a classic fault). */
export function duplicateRouterIds(snapshot: SimSnapshot | null, perDevice: (d: DeviceSnapshot) => DeviceLsdb = lsdbOf): Ipv4Address[] {
  if (snapshot === null) return [];
  const seen = new Map<Ipv4Address, number>();
  for (const d of snapshot.devices) {
    const rid = perDevice(d).routerId;
    if (rid !== undefined) seen.set(rid, (seen.get(rid) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([rid]) => rid).sort((a, b) => ipv4ToU32(a) - ipv4ToU32(b));
}

/** `R2 (2.2.2.2)` when a device uses the router id, else the id alone. */
export function routerName(rid: Ipv4Address, devices: ReadonlyMap<Ipv4Address, DeviceSnapshot>): string {
  const d = devices.get(rid);
  return d === undefined ? rid : `${d.name} (${rid})`;
}

// ── the LSA list ─────────────────────────────────────────────────────────────

/** One row of the LSA list. */
export interface LsaListEntry {
  readonly key: string;
  readonly scope: OspfAreaId | 'as';
  readonly type: OspfLsaType;
  readonly typeLabel: string;
  readonly lsid: Ipv4Address;
  readonly advRouter: Ipv4Address;
  /** `R2 (2.2.2.2)` when a device uses the advertising router id. */
  readonly advName: string;
  /** Live age, whole seconds (capped at 3600). */
  readonly age: number;
  readonly seq: number;
  readonly seqHex: string;
  readonly checksumHex: string;
  readonly self: boolean;
  /** At MaxAge: being flushed, or aged out. */
  readonly maxAge: boolean;
  /** The marks as words: `self`, `MaxAge` (joined by ' · '; '' when none). */
  readonly marks: string;
}

/** True when an LSA is at MaxAge at `now` (flagged, or its live age reached 3600 s). */
export function isAtMaxAge(row: OspfLsaRow, now: SimTime): boolean {
  return row.maxAge === true || lsaAgeAt(row, now) >= LSA_MAX_AGE_S;
}

/** One list entry of an LSA row at `now`. */
export function lsaEntry(row: OspfLsaRow, now: SimTime, devices: ReadonlyMap<Ipv4Address, DeviceSnapshot> = new Map()): LsaListEntry {
  const maxAge = isAtMaxAge(row, now);
  const marks = [row.self ? LSA_SELF_MARK : '', maxAge ? LSA_MAXAGE_MARK : ''].filter((m) => m !== '').join(' · ');
  return {
    key: lsaRowKey(row),
    scope: row.scope,
    type: row.type,
    typeLabel: lsaTypeLabel(row.type),
    lsid: row.lsid,
    advRouter: row.advRouter,
    advName: routerName(row.advRouter, devices),
    age: lsaAgeAt(row, now),
    seq: row.seq,
    seqHex: seqHex(row.seq),
    checksumHex: checksumHex(row.checksum),
    self: row.self === true,
    maxAge,
    marks,
  };
}

// ── the LSA detail ───────────────────────────────────────────────────────────

/** One router link in words. */
export interface RouterLinkLine {
  readonly kind: OspfRouterLink['kind'];
  readonly kindText: string;
  readonly id: Ipv4Address;
  readonly data: Ipv4Address;
  readonly metric: number;
  /** `point-to-point to R2 (2.2.2.2), local address 10.0.12.1, cost 64`. */
  readonly text: string;
}

/** The body of an LSA in words. */
export type LsaBody =
  | { readonly kind: 'router'; readonly flags: string; readonly links: readonly RouterLinkLine[] }
  | { readonly kind: 'network'; readonly mask?: Ipv4Address; readonly prefix?: string; readonly attached: readonly { readonly rid: Ipv4Address; readonly name: string }[] }
  | { readonly kind: 'external'; readonly mask?: Ipv4Address; readonly prefix?: string; readonly metric: number; readonly metricType: 'E1' | 'E2'; readonly forward: Ipv4Address; readonly tag: number }
  | { readonly kind: 'other' };

/** How one router of the area holds the shown LSA. */
export type LsaHolding = 'same' | 'older' | 'newer' | 'missing';

/** "The same in every router of this area": the verdict and each router's copy. */
export interface LsaAgreement {
  /** True when every router of the scope holds the same instance. */
  readonly same: boolean;
  /** `yes` or `no`. */
  readonly word: 'yes' | 'no';
  readonly routers: readonly { readonly device: DeviceId; readonly name: string; readonly holding: LsaHolding; readonly seqHex?: string }[];
}

/** The detail of one LSA. */
export interface LsaDetailModel {
  readonly entry: LsaListEntry;
  /** Header lines: [label, value]. */
  readonly header: readonly (readonly [string, string])[];
  readonly body: LsaBody;
  readonly agreement: LsaAgreement;
  /** NetScope display filter matching the packets that carried it. */
  readonly filter: string;
  /** The question the agreement answers, with its scope: `the same in every router of this area` (or `… of the AS`). */
  readonly agreementLabel: string;
}

function prefixText(id: Ipv4Address, mask: Ipv4Address | undefined): string | undefined {
  if (mask === undefined) return undefined;
  const len = maskToPrefixLen(mask);
  if (len === null) return undefined;
  return `${u32ToIpv4((ipv4ToU32(id) & ipv4ToU32(mask)) >>> 0)}/${len}`;
}

function flagsText(flags: OspfLsaRow['flags']): string {
  if (flags === undefined) return 'none';
  const words: string[] = [];
  if (flags.b) words.push('B (area border)');
  if (flags.e) words.push('E (AS boundary)');
  if (flags.v) words.push('V (virtual link end)');
  return words.length === 0 ? 'none' : words.join(', ');
}

function routerLinkText(l: OspfRouterLink, devices: ReadonlyMap<Ipv4Address, DeviceSnapshot>): string {
  switch (l.kind) {
    case 'p2p':
      return `point-to-point to ${routerName(l.id, devices)}, local address ${l.data}, cost ${l.metric}`;
    case 'transit':
      return `transit network with DR ${l.id}, local address ${l.data}, cost ${l.metric}`;
    case 'stub': {
      const p = prefixText(l.id, l.data);
      return `stub network ${p ?? `${l.id} mask ${l.data}`}, cost ${l.metric}`;
    }
  }
}

/** The body of an LSA in words. */
export function lsaBody(row: OspfLsaRow, devices: ReadonlyMap<Ipv4Address, DeviceSnapshot> = new Map()): LsaBody {
  if (row.type === 1) {
    return {
      kind: 'router',
      flags: flagsText(row.flags),
      links: (row.links ?? []).map((l) => ({ kind: l.kind, kindText: ROUTER_LINK_WORD[l.kind], id: l.id, data: l.data, metric: l.metric, text: routerLinkText(l, devices) })),
    };
  }
  if (row.type === 2) {
    const prefix = prefixText(row.lsid, row.mask);
    const base = { kind: 'network' as const, attached: (row.attached ?? []).map((rid) => ({ rid, name: routerName(rid, devices) })) };
    return row.mask === undefined ? base : prefix === undefined ? { ...base, mask: row.mask } : { ...base, mask: row.mask, prefix };
  }
  if (row.type === 5) {
    const prefix = prefixText(row.lsid, row.mask);
    const base = {
      kind: 'external' as const,
      metric: row.metric ?? 0,
      metricType: row.external?.e2 === false ? ('E1' as const) : ('E2' as const),
      forward: row.external?.forward ?? '0.0.0.0',
      tag: row.external?.tag ?? 0,
    };
    return row.mask === undefined ? base : prefix === undefined ? { ...base, mask: row.mask } : { ...base, mask: row.mask, prefix };
  }
  return { kind: 'other' };
}

/** The display filter that matches the packets carrying this LSA (updates, and the headers in descriptions and acknowledgements). */
export function lsaDisplayFilter(row: Pick<OspfLsaRow, 'type' | 'lsid' | 'advRouter'>): string {
  return `ospf-lsa.lsType == ${row.type} && ospf-lsa.lsid == ${row.lsid} && ospf-lsa.advRouter == ${row.advRouter}`;
}

/**
 * The routers an LSA's scope reaches: for an area, every device with an OSPF interface in it; for the AS scope, every
 * device that runs OSPF. Natural name order.
 */
export function routersOfScope(snapshot: SimSnapshot, scope: OspfAreaId | 'as', perDevice: (d: DeviceSnapshot) => DeviceLsdb = lsdbOf): DeviceSnapshot[] {
  const out: DeviceSnapshot[] = [];
  for (const d of snapshot.devices) {
    const lsdb = perDevice(d);
    if (scope === 'as' ? lsdb.interfaces.length > 0 : lsdb.interfaces.some((r) => r.area === scope)) out.push(d);
  }
  return out.sort((a, b) => compareNames(a.name, b.name));
}

/**
 * Whether every router of the LSA's scope holds the same instance of it (RFC 2328 §13.1: sequence number, checksum,
 * MaxAge, and ages more than 15 minutes apart), compared with the chosen router's copy.
 */
export function lsaAgreement(snapshot: SimSnapshot, row: OspfLsaRow, now: SimTime, perDevice: (d: DeviceSnapshot) => DeviceLsdb = lsdbOf): LsaAgreement {
  const key = lsaRowKey(row);
  const mine = { seq: row.seq, checksum: row.checksum, age: lsaAgeAt(row, now) };
  const routers = routersOfScope(snapshot, row.scope, perDevice).map((d) => {
    const copy = perDevice(d).lsas.find((r) => lsaRowKey(r) === key);
    if (copy === undefined) return { device: d.id, name: d.name, holding: 'missing' as LsaHolding };
    const cmp = compareLsaInstances({ seq: copy.seq, checksum: copy.checksum, age: lsaAgeAt(copy, now) }, mine);
    const holding: LsaHolding = cmp === 0 ? 'same' : cmp > 0 ? 'newer' : 'older';
    return { device: d.id, name: d.name, holding, seqHex: seqHex(copy.seq) };
  });
  const same = routers.length > 0 && routers.every((r) => r.holding === 'same');
  return { same, word: same ? 'yes' : 'no', routers };
}

/** The detail of the LSA `key` in the chosen router's database, or undefined when it does not hold it. */
export function lsaDetail(
  snapshot: SimSnapshot,
  device: DeviceId,
  key: string,
  now: SimTime,
  perDevice: (d: DeviceSnapshot) => DeviceLsdb = lsdbOf,
): LsaDetailModel | undefined {
  const d = snapshot.devices.find((x) => x.id === device);
  if (d === undefined) return undefined;
  const row = perDevice(d).lsas.find((r) => lsaRowKey(r) === key);
  if (row === undefined) return undefined;
  const devices = routerDevices(snapshot, perDevice);
  const entry = lsaEntry(row, now, devices);
  const header: (readonly [string, string])[] = [
    ['Type', `${row.type} (${entry.typeLabel})`],
    ['Link-state id', row.lsid],
    ['Advertising router', entry.advName],
    ['Age', `${entry.age} s${entry.maxAge ? ' (MaxAge)' : ''}`],
    ['Sequence', entry.seqHex],
    ['Checksum', entry.checksumHex],
    ['Length', `${row.length} bytes`],
    ['Scope', row.scope === 'as' ? 'the whole AS' : areaLabel(row.scope)],
  ];
  return {
    entry,
    header,
    body: lsaBody(row, devices),
    agreement: lsaAgreement(snapshot, row, now, perDevice),
    filter: lsaDisplayFilter(row),
    agreementLabel: row.scope === 'as' ? 'The same in every OSPF router' : 'The same in every router of this area',
  };
}

// ── the LSDB graph ───────────────────────────────────────────────────────────

/** One vertex of the graph. */
export interface LsdbGraphNode {
  /** `R:<router id>` or `N:<DR address>` (the SPF vertex keys). */
  readonly key: string;
  readonly kind: 'router' | 'network';
  readonly id: Ipv4Address;
  /** `R1` / `10.0.123.0/24`. */
  readonly label: string;
  /** `1.1.1.1` / `DR 10.0.123.2`. */
  readonly sub: string;
  readonly x: number;
  readonly y: number;
  /** False when no device on the canvas uses this router id (laid out on a row below the others). */
  readonly placed: boolean;
  /** The key of the LSA behind the vertex. */
  readonly lsaKey: string;
  /** Stub networks a router advertises (not drawn as vertices). */
  readonly stubs: number;
}

/** One edge of the graph: a point-to-point pair of routers, or a router on a transit network. */
export interface LsdbGraphEdge {
  readonly key: string;
  readonly kind: 'p2p' | 'transit';
  readonly from: string;
  readonly to: string;
  /** The cost `from` advertises towards `to` (undefined when only `to` lists the link). */
  readonly costFrom?: number;
  /** The cost `to` advertises towards `from` (networks advertise none: 0 when the network lists the router). */
  readonly costTo?: number;
  /** Both sides list the link (the SPF's bidirectional check). */
  readonly twoWay: boolean;
}

export interface LsdbGraphModel {
  readonly nodes: readonly LsdbGraphNode[];
  readonly edges: readonly LsdbGraphEdge[];
  readonly bounds: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number };
}

/** Distance (world units) between unplaced routers on their row. */
export const GRAPH_UNPLACED_STEP = 120;

/**
 * The graph of one router's database for one area: routers at the canvas positions of the devices that use their
 * router ids, transit networks at the centroid of the routers attached to them (their network LSA's list, else the
 * routers linking to them). MaxAge copies are left out, as the SPF leaves them out.
 */
export function buildLsdbGraph(
  snapshot: SimSnapshot,
  device: DeviceId,
  area: OspfAreaId,
  now: SimTime,
  perDevice: (d: DeviceSnapshot) => DeviceLsdb = lsdbOf,
): LsdbGraphModel {
  const empty: LsdbGraphModel = { nodes: [], edges: [], bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } };
  const d = snapshot.devices.find((x) => x.id === device);
  if (d === undefined) return empty;
  const rows = perDevice(d).lsas.filter((r) => r.scope === area && !isAtMaxAge(r, now));
  const routers = rows.filter((r) => r.type === 1 && r.lsid === r.advRouter);
  const networks = new Map<Ipv4Address, OspfLsaRow>();
  for (const r of rows) {
    if (r.type !== 2) continue;
    const prev = networks.get(r.lsid);
    if (prev === undefined || ipv4ToU32(r.advRouter) > ipv4ToU32(prev.advRouter)) networks.set(r.lsid, r);
  }
  const devices = routerDevices(snapshot, perDevice);
  // routers
  const pos = new Map<string, { x: number; y: number; placed: boolean }>();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of routers) {
    const dev = devices.get(r.advRouter);
    if (dev === undefined) continue;
    pos.set(`R:${r.advRouter}`, { x: dev.position.x, y: dev.position.y, placed: true });
    minX = Math.min(minX, dev.position.x);
    minY = Math.min(minY, dev.position.y);
    maxX = Math.max(maxX, dev.position.x);
    maxY = Math.max(maxY, dev.position.y);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }
  let unplaced = 0;
  for (const r of routers) {
    const key = `R:${r.advRouter}`;
    if (pos.has(key)) continue;
    pos.set(key, { x: minX + unplaced * GRAPH_UNPLACED_STEP, y: maxY + GRAPH_UNPLACED_STEP, placed: false });
    unplaced++;
  }
  // edges
  const edges: LsdbGraphEdge[] = [];
  const routerSet = new Set(routers.map((r) => r.advRouter));
  const p2p = new Map<string, { a: Ipv4Address; b: Ipv4Address; ab?: number; ba?: number }>();
  const transitFrom = new Map<Ipv4Address, Map<Ipv4Address, number>>(); // network id → router → cost
  for (const r of routers) {
    for (const l of r.links ?? []) {
      if (l.kind === 'p2p') {
        if (!routerSet.has(l.id)) continue;
        const [a, b] = ipv4ToU32(r.advRouter) <= ipv4ToU32(l.id) ? [r.advRouter, l.id] : [l.id, r.advRouter];
        const k = `${a}|${b}`;
        const e = p2p.get(k) ?? { a, b };
        if (r.advRouter === a) e.ab = Math.min(e.ab ?? Infinity, l.metric);
        else e.ba = Math.min(e.ba ?? Infinity, l.metric);
        p2p.set(k, e);
      } else if (l.kind === 'transit') {
        let m = transitFrom.get(l.id);
        if (m === undefined) transitFrom.set(l.id, (m = new Map()));
        m.set(r.advRouter, Math.min(m.get(r.advRouter) ?? Infinity, l.metric));
      }
    }
  }
  for (const [k, e] of [...p2p.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    const edge: { -readonly [K in keyof LsdbGraphEdge]: LsdbGraphEdge[K] } = { key: `p2p:${k}`, kind: 'p2p', from: `R:${e.a}`, to: `R:${e.b}`, twoWay: e.ab !== undefined && e.ba !== undefined };
    if (e.ab !== undefined) edge.costFrom = e.ab;
    if (e.ba !== undefined) edge.costTo = e.ba;
    edges.push(edge);
  }
  // networks
  const nodes: LsdbGraphNode[] = [];
  for (const r of routers) {
    const p = pos.get(`R:${r.advRouter}`)!;
    const dev = devices.get(r.advRouter);
    nodes.push({
      key: `R:${r.advRouter}`,
      kind: 'router',
      id: r.advRouter,
      label: dev?.name ?? r.advRouter,
      sub: r.advRouter,
      x: p.x,
      y: p.y,
      placed: p.placed,
      lsaKey: lsaRowKey(r),
      stubs: (r.links ?? []).filter((l) => l.kind === 'stub').length,
    });
  }
  const netIds = [...networks.keys()].sort((a, b) => ipv4ToU32(a) - ipv4ToU32(b));
  for (const id of netIds) {
    const n = networks.get(id)!;
    const linking = transitFrom.get(id) ?? new Map<Ipv4Address, number>();
    const members = [...new Set([...(n.attached ?? []), ...linking.keys()])].filter((rid) => routerSet.has(rid));
    const pts = members.map((rid) => pos.get(`R:${rid}`)!).filter((p) => p !== undefined);
    const x = pts.length === 0 ? minX : pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const y = pts.length === 0 ? maxY + GRAPH_UNPLACED_STEP : pts.reduce((s, p) => s + p.y, 0) / pts.length;
    nodes.push({
      key: `N:${id}`,
      kind: 'network',
      id,
      label: prefixText(id, n.mask) ?? id,
      sub: `DR ${id}`,
      x,
      y,
      placed: pts.length > 0,
      lsaKey: lsaRowKey(n),
      stubs: 0,
    });
    for (const rid of members.sort((a, b) => ipv4ToU32(a) - ipv4ToU32(b))) {
      const cost = linking.get(rid);
      const listed = (n.attached ?? []).includes(rid);
      const edge: { -readonly [K in keyof LsdbGraphEdge]: LsdbGraphEdge[K] } = { key: `transit:${id}|${rid}`, kind: 'transit', from: `R:${rid}`, to: `N:${id}`, twoWay: cost !== undefined && listed };
      if (cost !== undefined) edge.costFrom = cost;
      if (listed) edge.costTo = 0;
      edges.push(edge);
    }
  }
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x);
    maxY = Math.max(maxY, n.y);
  }
  return { nodes, edges, bounds: { minX, minY, maxX, maxY } };
}

/** The largest scale `fitGraph` applies (a small topology is not blown up beyond half again its canvas size). */
export const GRAPH_MAX_SCALE = 1.5;

/**
 * Node centres of a graph fitted into a `width` × `height` box with `pad` on every side, keeping the canvas aspect
 * (one scale for both axes, at most `GRAPH_MAX_SCALE`), centred.
 */
export function fitGraph(graph: LsdbGraphModel, width: number, height: number, pad: number): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const { minX, minY, maxX, maxY } = graph.bounds;
  const w = maxX - minX;
  const h = maxY - minY;
  const availW = Math.max(1, width - 2 * pad);
  const availH = Math.max(1, height - 2 * pad);
  const scale = Math.min(GRAPH_MAX_SCALE, w > 0 ? availW / w : GRAPH_MAX_SCALE, h > 0 ? availH / h : GRAPH_MAX_SCALE);
  const offX = (width - w * scale) / 2;
  const offY = (height - h * scale) / 2;
  for (const n of graph.nodes) out.set(n.key, { x: offX + (n.x - minX) * scale, y: offY + (n.y - minY) * scale });
  return out;
}

// ── the whole browser ────────────────────────────────────────────────────────

/** What the link-state panel shows for the store's selection. */
export interface LsdbView {
  readonly routers: readonly LsdbRouterChoice[];
  /** The router shown (the selection when it runs OSPF, else the first), or undefined when no device runs OSPF. */
  readonly router?: LsdbRouterChoice;
  readonly areas: readonly OspfAreaId[];
  readonly area?: OspfAreaId;
  readonly lsas: readonly LsaListEntry[];
  /** The selected LSA's key when the router holds it. */
  readonly selected?: string;
  /** Router ids two devices use at once. */
  readonly duplicates: readonly Ipv4Address[];
}

/** The panel's view of a snapshot for the selection `{device, area, lsa}`. */
export function buildLsdbView(
  snapshot: SimSnapshot | null,
  sel: { readonly device: DeviceId | null; readonly area: OspfAreaId | null; readonly lsa: string | null },
  now: SimTime,
  perDevice: (d: DeviceSnapshot) => DeviceLsdb = lsdbOf,
): LsdbView {
  const routers = lsdbRouters(snapshot, perDevice);
  const router = chooseRouter(routers, sel.device);
  if (snapshot === null || router === undefined) return { routers, areas: [], lsas: [], duplicates: [] };
  const d = snapshot.devices.find((x) => x.id === router.device)!;
  const lsdb = perDevice(d);
  const areas = router.areas;
  const area = chooseArea(areas, sel.area);
  const devices = routerDevices(snapshot, perDevice);
  const lsas = area === undefined ? lsdb.lsas.filter((r) => r.scope === 'as') : lsasOfArea(lsdb, area);
  const entries = lsas.map((r) => lsaEntry(r, now, devices));
  const selected = sel.lsa !== null && entries.some((e) => e.key === sel.lsa) ? sel.lsa : undefined;
  const base = { routers, router, areas, lsas: entries, duplicates: duplicateRouterIds(snapshot, perDevice) };
  const withArea = area === undefined ? base : { ...base, area };
  return selected === undefined ? withArea : { ...withArea, selected };
}
