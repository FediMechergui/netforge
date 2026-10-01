/**
 * core/ospf-lsa.ts — OSPFv2 LSA rules (ARCHITECTURE-P3 D7, D9, §2.6, §4.5; RFC 2328 §12, §13.1; §7 W1 core).
 *
 *   • Sequence numbers: signed 32-bit (RFC 2328 §12.1.6), stored in rows and fields as the unsigned u32 of the wire
 *     (`OspfLsaRow.seq`); the first instance is 0x80000001 (`LSA_INITIAL_SEQ`, D9), the last 0x7fffffff. The next
 *     number after the last does not exist: the LSA must be flushed (MaxAge) and restarted at the initial number.
 *   • Age: the live age of an installed LSA is `ageAtInstall + floor((now − installedAt) / 1 s)`, capped at MaxAge
 *     3600 (§2.6: rows carry no expiresAt).
 *   • Which instance is newer (RFC 2328 §13.1): the higher sequence number; then the higher checksum; then the one at
 *     MaxAge; then, when the ages differ by more than MaxAgeDiff (900 s), the younger one; otherwise the same instance.
 *   • Bytes and checksum: `encodeLsaBytes` lays an LSA out as RFC 2328 A.4 (the 20-byte header, then the router,
 *     network or AS-external body) and fills its length and its Fletcher checksum (ISO 8473 / RFC 905 Annex B over the
 *     LSA from the options byte on, the 2-byte age excluded, check octets at LSA offset 16). The daemon uses it to
 *     give a self-originated `OspfLsaRow` its `checksum` and `length` (a database description or acknowledgement
 *     carries both from the row, D7); the `ospf-lsa` codec computes the same values on the wire.
 *
 * Pure: no module state, no floating-point maths, no randomness. Also exported from `@netforge/engine/pure`.
 */
import { ipv4ToU32, type Ipv4Address } from '../contracts/addr.js';
import type { OspfLsaRow, OspfRouterLink } from '../contracts/tables.js';
import { SEC, type SimTime } from '../contracts/time.js';

/** @since P3 InitialSequenceNumber (0x80000001, the u32 of −2^31 + 1). */
export const LSA_INITIAL_SEQ = 0x80000001;
/** @since P3 MaxSequenceNumber (0x7fffffff). */
export const LSA_MAX_SEQ = 0x7fffffff;
/** @since P3 MaxAge, seconds. */
export const LSA_MAX_AGE_S = 3600;
/** @since P3 MaxAgeDiff, seconds. */
export const LSA_MAX_AGE_DIFF_S = 900;
/** @since P3 LSRefreshTime, seconds: a self-originated LSA is re-originated at this age. */
export const LSA_REFRESH_S = 1800;
/** @since P3 MinLSInterval: two originations of one LSA are at least 5 s apart (D9). */
export const LSA_MIN_INTERVAL_NS = 5 * 1_000_000_000;
/** @since P3 MinLSArrival: a newer copy arriving sooner than 1 s after the last one is discarded (D9). */
export const LSA_MIN_ARRIVAL_NS = 1_000_000_000;
/** @since P3 Length of the LSA header, bytes. */
export const LSA_HEADER_BYTES = 20;

/** @since P3 A u32 sequence number read as the signed 32-bit value RFC 2328 compares. */
export function lsaSeqSigned(seq: number): number {
  return seq | 0;
}

/** @since P3 Negative when `a` is older than `b`, positive when newer, 0 when equal (signed comparison). */
export function compareLsaSeq(a: number, b: number): number {
  return lsaSeqSigned(a) - lsaSeqSigned(b);
}

/** @since P3 The sequence number after `seq` (u32), or undefined after MaxSequenceNumber (flush, then restart). */
export function nextLsaSeq(seq: number): number | undefined {
  const s = lsaSeqSigned(seq);
  if (s >= LSA_MAX_SEQ) return undefined;
  return (s + 1) >>> 0;
}

/** @since P3 The live age of an installed LSA at `now`, whole seconds, capped at MaxAge. */
export function lsaAgeAt(row: Pick<OspfLsaRow, 'ageAtInstall' | 'installedAt' | 'maxAge'>, now: SimTime): number {
  if (row.maxAge === true) return LSA_MAX_AGE_S;
  const elapsed = now > row.installedAt ? Math.floor((now - row.installedAt) / SEC) : 0;
  return Math.min(LSA_MAX_AGE_S, row.ageAtInstall + elapsed);
}

/** @since P3 What RFC 2328 §13.1 compares: the sequence number, the checksum and the age (seconds). */
export interface LsaInstance {
  readonly seq: number;
  readonly checksum: number;
  readonly age: number;
}

/**
 * @since P3 Which of two instances of one LSA is newer (RFC 2328 §13.1): positive when `a` is newer, negative when `b`
 * is, 0 when they are the same instance.
 */
export function compareLsaInstances(a: LsaInstance, b: LsaInstance): number {
  const bySeq = compareLsaSeq(a.seq, b.seq);
  if (bySeq !== 0) return bySeq > 0 ? 1 : -1;
  if (a.checksum !== b.checksum) return a.checksum > b.checksum ? 1 : -1;
  const aMax = a.age >= LSA_MAX_AGE_S;
  const bMax = b.age >= LSA_MAX_AGE_S;
  if (aMax !== bMax) return aMax ? 1 : -1;
  if (Math.abs(a.age - b.age) > LSA_MAX_AGE_DIFF_S) return a.age < b.age ? 1 : -1;
  return 0;
}

// ── bytes and the Fletcher checksum ─────────────────────────────────────────

/** @since P3 The fields of an LSA that its bytes carry (an `OspfLsaRow` has them all). */
export type LsaContent = Pick<OspfLsaRow, 'type' | 'lsid' | 'advRouter' | 'seq' | 'options' | 'flags' | 'links' | 'mask' | 'attached' | 'metric' | 'external'>;

const LINK_TYPE: Readonly<Record<OspfRouterLink['kind'], number>> = Object.freeze({ p2p: 1, transit: 2, stub: 3 });

function put16(b: Uint8Array, at: number, v: number): void {
  b[at] = (v >>> 8) & 0xff;
  b[at + 1] = v & 0xff;
}
function put32(b: Uint8Array, at: number, v: number): void {
  b[at] = (v >>> 24) & 0xff;
  b[at + 1] = (v >>> 16) & 0xff;
  b[at + 2] = (v >>> 8) & 0xff;
  b[at + 3] = v & 0xff;
}
function putAddr(b: Uint8Array, at: number, a: Ipv4Address): void {
  put32(b, at, ipv4ToU32(a));
}

/** @since P3 The length in bytes of an LSA's wire form (header included). */
export function lsaLength(lsa: LsaContent): number {
  switch (lsa.type) {
    case 1:
      return LSA_HEADER_BYTES + 4 + 12 * (lsa.links?.length ?? 0);
    case 2:
      return LSA_HEADER_BYTES + 4 + 4 * (lsa.attached?.length ?? 0);
    case 5:
      return LSA_HEADER_BYTES + 16;
  }
}

/**
 * @since P3 The Fletcher check value of an LSA whose wire form is `bytes` (starting at the LS age): computed over the
 * LSA from its options byte on, the check octets (LSA offset 16) counted as zero (RFC 2328 §12.1.7). Neither octet is
 * ever 0.
 */
export function lsaChecksumOf(bytes: Uint8Array): number {
  const length = bytes.length - 2;
  const at = 14; // the checksum field, relative to the options byte
  let c0 = 0;
  let c1 = 0;
  for (let i = 2; i < bytes.length; i++) {
    const v = i === 16 || i === 17 ? 0 : bytes[i]!;
    c0 = (c0 + v) % 255;
    c1 = (c1 + c0) % 255;
  }
  let x = ((length - at - 1) * c0 - c1) % 255;
  if (x <= 0) x += 255;
  let y = 510 - c0 - x;
  if (y > 255) y -= 255;
  return (x << 8) | y;
}

/** @since P3 True when an LSA's wire form carries a matching checksum (both Fletcher sums zero, the age excluded). */
export function lsaChecksumOk(bytes: Uint8Array): boolean {
  if (bytes.length < LSA_HEADER_BYTES) return false;
  let c0 = 0;
  let c1 = 0;
  for (let i = 2; i < bytes.length; i++) {
    c0 = (c0 + bytes[i]!) % 255;
    c1 = (c1 + c0) % 255;
  }
  return c0 === 0 && c1 === 0;
}

/**
 * @since P3 The wire form of an LSA (RFC 2328 A.4), LS age `age` (default 0), with its length and checksum filled.
 * Router body: flags (V 4, E 2, B 1), 0, link count, then per link id, data, type (1 p2p, 2 transit, 3 stub), 0 TOS,
 * metric. Network body: mask, attached routers. AS-external body: mask, E bit (0x80) with the 24-bit metric,
 * forwarding address, route tag.
 */
export function encodeLsaBytes(lsa: LsaContent, age = 0): Uint8Array {
  const length = lsaLength(lsa);
  const b = new Uint8Array(length);
  put16(b, 0, Math.min(Math.max(0, age), LSA_MAX_AGE_S));
  b[2] = lsa.options & 0xff;
  b[3] = lsa.type;
  putAddr(b, 4, lsa.lsid);
  putAddr(b, 8, lsa.advRouter);
  put32(b, 12, lsa.seq >>> 0);
  put16(b, 18, length);
  let at = LSA_HEADER_BYTES;
  if (lsa.type === 1) {
    const f = lsa.flags;
    b[at] = (f?.v === true ? 4 : 0) | (f?.e === true ? 2 : 0) | (f?.b === true ? 1 : 0);
    const links = lsa.links ?? [];
    put16(b, at + 2, links.length);
    at += 4;
    for (const l of links) {
      putAddr(b, at, l.id);
      putAddr(b, at + 4, l.data);
      b[at + 8] = LINK_TYPE[l.kind];
      b[at + 9] = 0;
      put16(b, at + 10, l.metric & 0xffff);
      at += 12;
    }
  } else if (lsa.type === 2) {
    putAddr(b, at, lsa.mask ?? '0.0.0.0');
    at += 4;
    for (const r of lsa.attached ?? []) {
      putAddr(b, at, r);
      at += 4;
    }
  } else {
    putAddr(b, at, lsa.mask ?? '0.0.0.0');
    const metric = (lsa.metric ?? 0) & 0xffffff;
    b[at + 4] = lsa.external?.e2 === false ? 0 : 0x80;
    b[at + 5] = (metric >>> 16) & 0xff;
    put16(b, at + 6, metric & 0xffff);
    putAddr(b, at + 8, lsa.external?.forward ?? '0.0.0.0');
    put32(b, at + 12, (lsa.external?.tag ?? 0) >>> 0);
  }
  put16(b, 16, lsaChecksumOf(b));
  return b;
}

/** @since P3 The `checksum` and `length` an `OspfLsaRow` carries for `lsa`. */
export function lsaChecksumAndLength(lsa: LsaContent): { checksum: number; length: number } {
  const bytes = encodeLsaBytes(lsa);
  return { checksum: (bytes[16]! << 8) | bytes[17]!, length: bytes.length };
}
