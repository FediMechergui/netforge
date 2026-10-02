/**
 * protocols/ospf/lsdb.ts — the link-state database as the ospf daemon keeps it (ARCHITECTURE-P3 D7, D10, §2.6, §4.5;
 * RFC 2328 §12, §13, A.4; §7 W2 ospf). Pure: conversions and orders only; the rows themselves live in the device's
 * `ospf-lsdb` table, written by the daemon alone. No module state.
 *
 *   • The wire form: an `ospf-lsa` layer (codec pdu/codecs/ospf.ts) is read with `lsaWireOf` (a full LSA in a
 *     link-state update, or a header copy in a database description or an acknowledgement) and written with
 *     `lsaLayerOf` (a full LSA: the codec derives its length and Fletcher checksum, equal to the row's) or
 *     `lsaHeaderLayerOf` (a header copy: the row's checksum and length are required, D7).
 *   • A row (`OspfLsaRow`, key `ospfLsaKey(scope, type, lsid, advRouter)`, scope = the area, or 'as' for AS-external
 *     LSAs) keeps the age the LSA had when it was installed and the install time; the live age is `lsaAgeAt`
 *     (core/ospf-lsa.ts). An LSA being flushed carries `maxAge: true` and is sent with age 3600.
 *   • Ages on the wire: an LSA in an update leaves with its live age plus InfTransDelay (1 s, RFC 2328 §13.3); a header
 *     copy carries the live age.
 *   • Order (§4.5): the database is iterated by (scope — areas as u32, then 'as' —, type, link-state id as u32,
 *     advertising router as u32), and update packets carry their LSAs in that order.
 *   • Bodies compare by content (`lsaBodyEqual`): flags, links in order, mask, attached routers in order, metric and the
 *     external fields; the header (sequence, age, checksum) is not part of the content.
 */
import { ipv4ToU32, isIpv4, type Ipv4Address } from '../../contracts/addr.js';
import type { FieldValue, LayerSpec } from '../../contracts/pdu.js';
import { ospfLsaKey, type OspfAreaId, type OspfLsaRow, type OspfLsaType, type OspfRouterLink } from '../../contracts/tables.js';
import type { SimTime } from '../../contracts/time.js';
import { lsaAgeAt, LSA_MAX_AGE_S, type LsaInstance } from '../../core/ospf-lsa.js';

/** @since P3 The options byte every P3a LSA and packet carries: E set (external routing capable, no stub areas). */
export const OSPF_OPTIONS = 0x02;
/** @since P3 InfTransDelay, seconds: added to an LSA's age when it leaves in a link-state update (RFC 2328 §13.3). */
export const OSPF_INF_TRANS_DELAY_S = 1;
/** @since P3 The LSA types P3a speaks (1 router, 2 network, 5 AS-external). */
export const OSPF_LSA_TYPES: readonly OspfLsaType[] = Object.freeze([1, 2, 5]);

/** @since P3 One LSA as a packet carries it: the header and, for a full LSA, its body. */
export interface OspfLsaWire {
  readonly type: number;
  readonly lsid: Ipv4Address;
  readonly advRouter: Ipv4Address;
  readonly seq: number;
  readonly age: number;
  readonly options: number;
  readonly checksum: number;
  readonly length: number;
  /** Full LSAs only: the Fletcher checksum verified (absent on a header copy). */
  readonly checksumValid?: boolean;
  readonly flags?: { b: boolean; e: boolean; v: boolean };
  readonly links?: readonly OspfRouterLink[];
  readonly mask?: Ipv4Address;
  readonly attached?: readonly Ipv4Address[];
  readonly metric?: number;
  readonly external?: { e2: boolean; forward: Ipv4Address; tag: number };
}

/** @since P3 The body of an LSA a router originates (no header numbers). */
export type OspfLsaBody = Pick<OspfLsaRow, 'type' | 'lsid' | 'advRouter' | 'options' | 'flags' | 'links' | 'mask' | 'attached' | 'metric' | 'external'>;

/** @since P3 True for an LSA type P3a speaks (1, 2 or 5). */
export function isOspfLsaType(type: number): type is OspfLsaType {
  return type === 1 || type === 2 || type === 5;
}

/** @since P3 The flooding scope of an LSA of `type` received or originated in `area`: AS-external LSAs are AS-wide. */
export function lsaScopeOf(type: number, area: OspfAreaId): OspfAreaId | 'as' {
  return type === 5 ? 'as' : area;
}

/** @since P3 The table key of an LSA. */
export function lsaKeyOf(scope: OspfAreaId | 'as', type: number, lsid: Ipv4Address, advRouter: Ipv4Address): string {
  return ospfLsaKey(scope, type, lsid, advRouter);
}

const num = (v: FieldValue | undefined, dflt = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
const addr = (v: FieldValue | undefined): Ipv4Address | undefined => (typeof v === 'string' && isIpv4(v) ? v : undefined);

/** @since P3 Router links of the codec's flat `links` string ('<kind>,<id>,<data>,<metric>' joined by ';'); other kinds are left out. */
export function parseRouterLinks(text: string): OspfRouterLink[] {
  const out: OspfRouterLink[] = [];
  if (text.trim() === '') return out;
  for (const entry of text.split(';')) {
    const [kind, id, data, metric] = entry.split(',').map((s) => s.trim());
    if ((kind !== 'p2p' && kind !== 'transit' && kind !== 'stub') || id === undefined || data === undefined || !isIpv4(id) || !isIpv4(data)) continue;
    const m = Number(metric);
    if (!Number.isInteger(m) || m < 0 || m > 0xffff) continue;
    out.push({ kind, id, data, metric: m });
  }
  return out;
}

/** @since P3 The codec's flat `links` string of router links. */
export function routerLinksText(links: readonly OspfRouterLink[] | undefined): string {
  return (links ?? []).map((l) => `${l.kind},${l.id},${l.data},${l.metric}`).join(';');
}

/**
 * @since P3 One `ospf-lsa` layer's fields as an LSA (undefined when the header is incomplete). A header copy carries
 * no body; a full LSA of type 1, 2 or 5 carries its body.
 */
export function lsaWireOf(fields: Readonly<Record<string, FieldValue>>): OspfLsaWire | undefined {
  const lsid = addr(fields.lsid);
  const advRouter = addr(fields.advRouter);
  if (lsid === undefined || advRouter === undefined || typeof fields.lsType !== 'number') return undefined;
  const type = fields.lsType;
  const base = {
    type,
    lsid,
    advRouter,
    seq: num(fields.seq) >>> 0,
    age: Math.min(LSA_MAX_AGE_S, num(fields.age)),
    options: num(fields.options),
    checksum: num(fields.checksum),
    length: num(fields.length),
  };
  if (fields.headerOnly === true) return base;
  const out: { -readonly [K in keyof OspfLsaWire]: OspfLsaWire[K] } = { ...base };
  if (typeof fields.checksumValid === 'boolean') out.checksumValid = fields.checksumValid;
  if (type === 1) {
    const f = num(fields.flags);
    out.flags = { b: (f & 1) !== 0, e: (f & 2) !== 0, v: (f & 4) !== 0 };
    out.links = parseRouterLinks(typeof fields.links === 'string' ? fields.links : '');
  } else if (type === 2) {
    const mask = addr(fields.mask);
    if (mask !== undefined) out.mask = mask;
    const text = typeof fields.attached === 'string' ? fields.attached : '';
    out.attached = text.trim() === '' ? [] : text.split(',').map((s) => s.trim()).filter((s) => isIpv4(s));
  } else if (type === 5) {
    const mask = addr(fields.mask);
    if (mask !== undefined) out.mask = mask;
    out.metric = num(fields.metric);
    out.external = { e2: fields.e2 !== false, forward: addr(fields.forward) ?? '0.0.0.0', tag: num(fields.tag) >>> 0 };
  }
  return out;
}

/** @since P3 The instance numbers RFC 2328 §13.1 compares (core/ospf-lsa.ts `compareLsaInstances`). */
export function wireInstance(w: Pick<OspfLsaWire, 'seq' | 'checksum' | 'age'>): LsaInstance {
  return { seq: w.seq, checksum: w.checksum, age: w.age };
}

/** @since P3 The instance of an installed row at `now` (its live age). */
export function rowInstance(row: OspfLsaRow, now: SimTime): LsaInstance {
  return { seq: row.seq, checksum: row.checksum, age: lsaAgeAt(row, now) };
}

/**
 * @since P3 The row of a received (or adopted) full LSA, installed at `now` with the age it arrived with. `self` marks
 * an LSA this router originated (D7: the row's `self` column).
 */
export function lsaRowOf(w: OspfLsaWire, scope: OspfAreaId | 'as', now: SimTime, self: boolean): OspfLsaRow {
  const row: OspfLsaRow = {
    key: lsaKeyOf(scope, w.type, w.lsid, w.advRouter),
    scope,
    type: w.type as OspfLsaType,
    lsid: w.lsid,
    advRouter: w.advRouter,
    seq: w.seq,
    ageAtInstall: w.age,
    installedAt: now,
    checksum: w.checksum,
    length: w.length,
    options: w.options,
    self,
    updatedAt: now,
  };
  if (w.flags !== undefined) row.flags = { ...w.flags };
  if (w.links !== undefined) row.links = w.links.map((l) => ({ ...l }));
  if (w.mask !== undefined) row.mask = w.mask;
  if (w.attached !== undefined) row.attached = [...w.attached];
  if (w.metric !== undefined) row.metric = w.metric;
  if (w.external !== undefined) row.external = { ...w.external };
  if (w.age >= LSA_MAX_AGE_S) row.maxAge = true;
  return row;
}

/** The age an installed row leaves with: the live age (+ InfTransDelay in an update), 3600 while it is flushed. */
function ageOnWire(row: OspfLsaRow, now: SimTime, inUpdate: boolean): number {
  if (row.maxAge === true) return LSA_MAX_AGE_S;
  return Math.min(LSA_MAX_AGE_S, lsaAgeAt(row, now) + (inUpdate ? OSPF_INF_TRANS_DELAY_S : 0));
}

/** @since P3 The `ospf-lsa` layer of a full LSA in a link-state update (the codec derives its length and checksum). */
export function lsaLayerOf(row: OspfLsaRow, now: SimTime): LayerSpec {
  const fields: Record<string, FieldValue> = {
    age: ageOnWire(row, now, true),
    options: row.options,
    lsType: row.type,
    lsid: row.lsid,
    advRouter: row.advRouter,
    seq: row.seq >>> 0,
  };
  if (row.type === 1) {
    const f = row.flags;
    fields.flags = (f?.v === true ? 4 : 0) | (f?.e === true ? 2 : 0) | (f?.b === true ? 1 : 0);
    fields.links = routerLinksText(row.links);
  } else if (row.type === 2) {
    fields.mask = row.mask ?? '0.0.0.0';
    fields.attached = (row.attached ?? []).join(',');
  } else {
    fields.mask = row.mask ?? '0.0.0.0';
    fields.e2 = row.external?.e2 !== false;
    fields.metric = row.metric ?? 0;
    fields.forward = row.external?.forward ?? '0.0.0.0';
    fields.tag = row.external?.tag ?? 0;
  }
  return { proto: 'ospf-lsa', fields };
}

/** @since P3 The `ospf-lsa` header copy of a row (a database description or an acknowledgement, D7). */
export function lsaHeaderLayerOf(row: OspfLsaRow, now: SimTime): LayerSpec {
  return {
    proto: 'ospf-lsa',
    fields: {
      age: ageOnWire(row, now, false),
      options: row.options,
      lsType: row.type,
      lsid: row.lsid,
      advRouter: row.advRouter,
      seq: row.seq >>> 0,
      checksum: row.checksum,
      length: row.length,
    },
  };
}

/** @since P3 The header copy of a received LSA (an acknowledgement echoes the instance it received). */
export function wireHeaderLayerOf(w: OspfLsaWire): LayerSpec {
  return {
    proto: 'ospf-lsa',
    fields: { age: w.age, options: w.options, lsType: w.type, lsid: w.lsid, advRouter: w.advRouter, seq: w.seq >>> 0, checksum: w.checksum, length: w.length },
  };
}

/** Scope rank: areas as u32, then 'as'. */
function scopeRank(scope: string): number {
  return scope === 'as' ? 0x100000000 : isIpv4(scope) ? ipv4ToU32(scope) : 0x100000001;
}

/** @since P3 The database order of §4.5: (scope, type, link-state id u32, advertising router u32). */
export function compareLsdbRows(
  a: Pick<OspfLsaRow, 'scope' | 'type' | 'lsid' | 'advRouter'>,
  b: Pick<OspfLsaRow, 'scope' | 'type' | 'lsid' | 'advRouter'>,
): number {
  const sa = scopeRank(a.scope);
  const sb = scopeRank(b.scope);
  if (sa !== sb) return sa - sb;
  if (a.type !== b.type) return a.type - b.type;
  const la = ipv4ToU32(a.lsid);
  const lb = ipv4ToU32(b.lsid);
  if (la !== lb) return la - lb;
  return ipv4ToU32(a.advRouter) - ipv4ToU32(b.advRouter);
}

/** @since P3 Rows in the database order (a fresh array). */
export function sortedLsdb<R extends Pick<OspfLsaRow, 'scope' | 'type' | 'lsid' | 'advRouter'>>(rows: Iterable<R>): R[] {
  return [...rows].sort(compareLsdbRows);
}

/** @since P3 The rows a database description to a neighbour of `area` summarises: the area's LSAs and the AS-external ones. */
export function lsdbForArea<R extends Pick<OspfLsaRow, 'scope'>>(rows: Iterable<R>, area: OspfAreaId): R[] {
  const out: R[] = [];
  for (const r of rows) if (r.scope === area || r.scope === 'as') out.push(r);
  return out;
}

function sameLinks(a: readonly OspfRouterLink[] | undefined, b: readonly OspfRouterLink[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    const p = x[i]!;
    const q = y[i]!;
    if (p.kind !== q.kind || p.id !== q.id || p.data !== q.data || p.metric !== q.metric) return false;
  }
  return true;
}

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** @since P3 True when two LSAs of one key carry the same body (the header numbers are not compared). */
export function lsaBodyEqual(a: Partial<OspfLsaBody>, b: Partial<OspfLsaBody>): boolean {
  if (a.type !== b.type || (a.options ?? OSPF_OPTIONS) !== (b.options ?? OSPF_OPTIONS)) return false;
  const fa = a.flags;
  const fb = b.flags;
  if ((fa?.b ?? false) !== (fb?.b ?? false) || (fa?.e ?? false) !== (fb?.e ?? false) || (fa?.v ?? false) !== (fb?.v ?? false)) return false;
  if (!sameLinks(a.links, b.links)) return false;
  if (a.mask !== b.mask || !sameList(a.attached, b.attached) || (a.metric ?? 0) !== (b.metric ?? 0)) return false;
  const ea = a.external;
  const eb = b.external;
  if ((ea === undefined) !== (eb === undefined)) return false;
  if (ea !== undefined && eb !== undefined && (ea.e2 !== eb.e2 || ea.forward !== eb.forward || ea.tag !== eb.tag)) return false;
  return true;
}

/** @since P3 One link-state request entry ('<type>:<lsid>:<adv>', the codec's `requests` element). */
export function lsrEntryOf(type: number, lsid: Ipv4Address, advRouter: Ipv4Address): string {
  return `${type}:${lsid}:${advRouter}`;
}

/** @since P3 The entries of a link-state request's `requests` string (malformed entries are left out). */
export function parseLsrEntries(text: string): { type: number; lsid: Ipv4Address; advRouter: Ipv4Address }[] {
  const out: { type: number; lsid: Ipv4Address; advRouter: Ipv4Address }[] = [];
  if (text.trim() === '') return out;
  for (const e of text.split(';')) {
    const [t, lsid, adv] = e.split(':');
    const type = Number(t);
    if (!Number.isInteger(type) || lsid === undefined || adv === undefined || !isIpv4(lsid) || !isIpv4(adv)) continue;
    out.push({ type, lsid, advRouter: adv });
  }
  return out;
}

/** @since P3 'router LSA 1.1.1.1 from 1.1.1.1 seq 0x80000001' — the LSA in debug lines. */
export function lsaText(l: { readonly type: number; readonly lsid: Ipv4Address; readonly advRouter: Ipv4Address; readonly seq: number }): string {
  const kind = l.type === 1 ? 'router' : l.type === 2 ? 'network' : l.type === 5 ? 'external' : `type ${l.type}`;
  return `${kind} LSA ${l.lsid} from ${l.advRouter} seq 0x${(l.seq >>> 0).toString(16).padStart(8, '0')}`;
}
