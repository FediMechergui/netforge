/**
 * Wire arithmetic for the PDU codecs (spec §4.5, §2.1 "Ethernet & framing").
 *
 *  • `internetChecksum` — RFC 1071 one's-complement sum used by IPv4 and ICMPv4.
 *  • `crc32` — IEEE 802.3 frame check sequence (reflected CRC-32, polynomial
 *    0xEDB88320, init/xorout 0xFFFFFFFF, table-driven). The FCS is written
 *    little-endian on the wire (see `writeU32LE`).
 *  • Big-endian / little-endian byte accessors shared by every codec, plus the
 *    `LayerSpec.fields` coercion helpers (`numField`, `strField`, `bytesField`)
 *    so the codecs agree on how a missing/required field is reported.
 *
 *  • P0.5: `onesSum` / `foldOnes` / `finishChecksum` (chained one's-complement sums),
 *    `pseudoHeaderSumV4` / `pseudoHeaderSumV6` (transport pseudo-headers), `crc16X25`
 *    (HDLC FCS) and the little-endian u16 accessors used for it.
 *
 * Pure functions, no engine state, no allocation on the hot paths.
 */
import type { FieldValue } from '../contracts/pdu.js';
import type { Ipv4Address } from '../contracts/addr.js';
import { ipv4ToU32 } from '../contracts/addr.js';

// ── RFC 1071 ────────────────────────────────────────────────────────────────

/**
 * One's-complement Internet checksum over `bytes[offset, offset+length)`.
 * An odd trailing byte is treated as the high octet of a final 16-bit word
 * (RFC 1071 §2). Returns the 16-bit checksum (already complemented), so
 * verifying a header means `internetChecksum(hdr) === 0`.
 */
export function internetChecksum(bytes: Uint8Array, offset = 0, length = bytes.length - offset): number {
  return finishChecksum(onesSum(bytes, offset, length));
}

/**
 * Folded 16-bit one's-complement SUM (not complemented) over `bytes[offset, offset+length)`, added to
 * `initial` (itself a folded sum, e.g. from `pseudoHeaderSumV4`). Chain calls to checksum data held in
 * several places; only the LAST range may have odd length (its trailing byte is the high octet of a
 * final word). Finish with `finishChecksum`.
 */
export function onesSum(bytes: Uint8Array, offset = 0, length = bytes.length - offset, initial = 0): number {
  const end = offset + length;
  let sum = initial & 0xffff;
  let i = offset;
  for (; i + 1 < end; i += 2) {
    sum += (bytes[i]! << 8) | bytes[i + 1]!;
    // Fold periodically so the accumulator stays a small integer on very large buffers.
    if (sum > 0x7fffffff) sum = (sum & 0xffff) + (sum >>> 16);
  }
  if (i < end) sum += bytes[i]! << 8;
  return foldOnes(sum);
}

/** Fold carries of a one's-complement accumulator into 16 bits. */
export function foldOnes(sum: number): number {
  let s = sum;
  while (s > 0xffff) s = (s & 0xffff) + Math.floor(s / 0x10000);
  return s;
}

/** Complement a folded one's-complement sum into the transmitted 16-bit checksum. */
export function finishChecksum(sum: number): number {
  return ~foldOnes(sum) & 0xffff;
}

/**
 * Folded one's-complement sum of the IPv4 pseudo-header (RFC 768 / RFC 793):
 * src(4) dst(4) zero(1) protocol(1) upper-layer length(2). Addresses are dotted strings or 4 bytes.
 * Use as the `initial` of `onesSum` over the transport header and data.
 */
export function pseudoHeaderSumV4(
  src: Ipv4Address | Uint8Array,
  dst: Ipv4Address | Uint8Array,
  protocol: number,
  upperLength: number,
): number {
  const s = typeof src === 'string' ? ipv4ToU32(src) : readU32(src, 0);
  const d = typeof dst === 'string' ? ipv4ToU32(dst) : readU32(dst, 0);
  const sum = (s >>> 16) + (s & 0xffff) + (d >>> 16) + (d & 0xffff) + (protocol & 0xff) + (upperLength & 0xffff);
  return foldOnes(sum);
}

/**
 * Folded one's-complement sum of the IPv6 pseudo-header (RFC 8200 §8.1):
 * src(16) dst(16) upper-layer length(4) zero(3) next header(1). Addresses are 16-byte arrays.
 */
export function pseudoHeaderSumV6(src: Uint8Array, dst: Uint8Array, nextHeader: number, upperLength: number): number {
  if (src.length < 16 || dst.length < 16) throw new RangeError('pseudoHeaderSumV6: addresses must be 16 bytes');
  let sum = onesSum(src, 0, 16);
  sum = onesSum(dst, 0, 16, sum);
  const len = upperLength >>> 0;
  return foldOnes(sum + (len >>> 16) + (len & 0xffff) + (nextHeader & 0xff));
}

// ── CRC-16/X.25 (HDLC FCS) ──────────────────────────────────────────────────

const CRC16_X25_TABLE: Uint16Array = (() => {
  const t = new Uint16Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x8408 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

/**
 * CRC-16/X.25 (ISO/IEC 13239 HDLC FCS): reflected polynomial 0x8408, init and xorout 0xFFFF, table-driven.
 * `crc16X25(ascii('123456789')) === 0x906E`. The FCS is written little-endian on the wire (`writeU16LE`).
 */
export function crc16X25(bytes: Uint8Array, offset = 0, length = bytes.length - offset): number {
  let c = 0xffff;
  const end = offset + length;
  for (let i = offset; i < end; i++) {
    c = CRC16_X25_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffff) & 0xffff;
}

// ── IEEE 802.3 CRC-32 ───────────────────────────────────────────────────────

const CRC32_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/**
 * Reflected CRC-32 (IEEE 802.3 / zlib) over `bytes[offset, offset+length)`.
 * `crc32(ascii('123456789')) === 0xCBF43926`. Result is an unsigned 32-bit number.
 */
export function crc32(bytes: Uint8Array, offset = 0, length = bytes.length - offset): number {
  let c = 0xffffffff;
  const end = offset + length;
  for (let i = offset; i < end; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ── byte accessors (network order unless suffixed LE) ───────────────────────

/** Big-endian u16 at `off`. Caller guarantees bounds. */
export function readU16(b: Uint8Array, off: number): number {
  return (b[off]! << 8) | b[off + 1]!;
}

/** Big-endian u32 at `off`. Caller guarantees bounds. */
export function readU32(b: Uint8Array, off: number): number {
  return ((b[off]! << 24) | (b[off + 1]! << 16) | (b[off + 2]! << 8) | b[off + 3]!) >>> 0;
}

/** Little-endian u32 at `off` (Ethernet FCS byte order). Caller guarantees bounds. */
export function readU32LE(b: Uint8Array, off: number): number {
  return ((b[off + 3]! << 24) | (b[off + 2]! << 16) | (b[off + 1]! << 8) | b[off]!) >>> 0;
}

/** Little-endian u16 at `off` (HDLC FCS byte order). Caller guarantees bounds. */
export function readU16LE(b: Uint8Array, off: number): number {
  return (b[off + 1]! << 8) | b[off]!;
}

/** Write little-endian u16 (HDLC FCS byte order). */
export function writeU16LE(b: Uint8Array, off: number, v: number): void {
  b[off] = v & 0xff;
  b[off + 1] = (v >>> 8) & 0xff;
}

/** Write big-endian u16. */
export function writeU16(b: Uint8Array, off: number, v: number): void {
  b[off] = (v >>> 8) & 0xff;
  b[off + 1] = v & 0xff;
}

/** Write big-endian u32. */
export function writeU32(b: Uint8Array, off: number, v: number): void {
  b[off] = (v >>> 24) & 0xff;
  b[off + 1] = (v >>> 16) & 0xff;
  b[off + 2] = (v >>> 8) & 0xff;
  b[off + 3] = v & 0xff;
}

/** Write little-endian u32 (Ethernet FCS byte order). */
export function writeU32LE(b: Uint8Array, off: number, v: number): void {
  b[off] = v & 0xff;
  b[off + 1] = (v >>> 8) & 0xff;
  b[off + 2] = (v >>> 16) & 0xff;
  b[off + 3] = (v >>> 24) & 0xff;
}

// ── LayerSpec field coercion ────────────────────────────────────────────────

/**
 * Numeric field with a default. `dflt === null` marks the field REQUIRED: a
 * missing value throws a descriptive error naming `<proto>.<key>` so a builder
 * that forgot `ethernet.type` / `ipv4.src` fails loudly and deterministically.
 */
export function numField(
  proto: string,
  fields: Readonly<Record<string, FieldValue>>,
  key: string,
  dflt: number | null,
): number {
  const v = fields[key];
  if (v === undefined || v === null) {
    if (dflt === null) throw new Error(`${proto}.${key} is required to encode a ${proto} layer`);
    return dflt;
  }
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error(`${proto}.${key} must be an integer, got ${v}`);
    return v;
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isInteger(n)) return n;
  }
  throw new Error(`${proto}.${key} must be a number`);
}

/** String field with a default (`null` = required). */
export function strField(
  proto: string,
  fields: Readonly<Record<string, FieldValue>>,
  key: string,
  dflt: string | null,
): string {
  const v = fields[key];
  if (v === undefined || v === null) {
    if (dflt === null) throw new Error(`${proto}.${key} is required to encode a ${proto} layer`);
    return dflt;
  }
  if (typeof v === 'string') return v;
  throw new Error(`${proto}.${key} must be a string`);
}

/** Byte-array field; missing or null → empty. */
export function bytesField(proto: string, fields: Readonly<Record<string, FieldValue>>, key: string): Uint8Array {
  const v = fields[key];
  if (v === undefined || v === null) return new Uint8Array(0);
  if (v instanceof Uint8Array) return v;
  throw new Error(`${proto}.${key} must be a Uint8Array`);
}
