/**
 * NTPv4 codec (RFC 5905 §7.3; ARCHITECTURE-P3 D19, §2.3, §3.7; contracts/fields.ts `ntp`). UDP port 123.
 *
 * Wire image (48 bytes, big-endian): `leap(2 bits) version(3) mode(3) | stratum(1) | poll(1, signed) |
 * precision(1, signed) | rootDelay(4) | rootDispersion(4) | refId(4) | refTimestamp(8) | originTimestamp(8) |
 * receiveTimestamp(8) | transmitTimestamp(8)`.
 *  • Timestamps are 64-bit NTP values (32-bit seconds since 1900, 32-bit fraction) on the wire and decimal strings
 *    `s.fffffffff` (seconds and nanoseconds) in the fields, so no bigint enters a field. Decode floors the fraction
 *    to whole nanoseconds; encode rounds nanoseconds up to the next fraction step, so every timestamp this codec
 *    writes decodes to the same string and re-encodes to the same bytes. A zero timestamp reads '0.000000000'.
 *    BigInt is used inside the two conversions only (NTP maths, §4.5).
 *  • `refId` is text ('LOCL', 'INIT': up to four ASCII characters, zero-padded) or, for a stratum 2–15 server, the
 *    reference's IPv4 address. Decode shows an address for strata 2–15, and otherwise text when the four bytes are
 *    printable ASCII followed only by zeros, an address when they are not.
 *  • Extension fields and a MAC after the 48 bytes are not decoded; they stay inside the layer.
 */
import type { Codec, DecodedLayer, FieldValue } from '../../contracts/pdu.js';
import { bytesToIpv4, ipv4ToBytes, isIpv4 } from '../../contracts/addr.js';
import { numField, readU32, strField, writeU32 } from '../checksum.js';

/** NTP modes (the `ntp.mode` field). */
export const NTP_MODE = Object.freeze({ symmetricActive: 1, symmetricPassive: 2, client: 3, server: 4, broadcast: 5 });
/** Leap indicator 3: alarm, the clock is not synchronised. */
export const NTP_LEAP_ALARM = 3;
/** Stratum 16: not synchronised. */
export const NTP_STRATUM_UNSYNCHRONISED = 16;
/** Length of an NTP header without extensions. */
export const NTP_PACKET_BYTES = 48;
/** The text of a zero timestamp. */
export const NTP_ZERO_TIMESTAMP = '0.000000000';

const TS_FIELDS = ['refTimestamp', 'originTimestamp', 'receiveTimestamp', 'transmitTimestamp'] as const;
const TS_OFFSET: Readonly<Record<(typeof TS_FIELDS)[number], number>> = Object.freeze({
  refTimestamp: 16,
  originTimestamp: 24,
  receiveTimestamp: 32,
  transmitTimestamp: 40,
});
const NS_PER_S = 1_000_000_000n;
const TIMESTAMP_RE = /^(\d{1,10})(?:\.(\d{1,9}))?$/;
const MODE_TEXT: Readonly<Record<number, string>> = Object.freeze({
  1: 'symmetric active',
  2: 'symmetric passive',
  3: 'client',
  4: 'server',
  5: 'broadcast',
});

/** The `s.fffffffff` text of the 64-bit NTP timestamp at `offset` (the fraction floored to whole nanoseconds). */
export function ntpWireTimestampText(bytes: Uint8Array, offset: number): string {
  const s = readU32(bytes, offset);
  const f = readU32(bytes, offset + 4);
  const ns = (BigInt(f) * NS_PER_S) >> 32n;
  return `${s}.${ns.toString().padStart(9, '0')}`;
}

/**
 * Write the `s.fffffffff` timestamp `text` as a 64-bit NTP value at `offset` (the nanoseconds rounded up to the next
 * fraction step, so the text decodes back unchanged). Up to nine fraction digits; throws on anything else.
 */
export function writeNtpWireTimestamp(out: Uint8Array, offset: number, text: string, label = 'ntp timestamp'): void {
  const m = TIMESTAMP_RE.exec(text.trim());
  if (!m) throw new Error(`${label} must be 's.fffffffff' (seconds since 1900), got "${text}"`);
  const s = Number(m[1]);
  if (s > 0xffffffff) throw new Error(`${label} seconds out of range: ${m[1]}`);
  const ns = BigInt((m[2] ?? '').padEnd(9, '0'));
  const f = ((ns << 32n) + NS_PER_S - 1n) / NS_PER_S;
  writeU32(out, offset, s);
  writeU32(out, offset + 4, Number(f));
}

/** 'LOCL'-style text of four reference-id bytes, or undefined when they are not printable ASCII then zeros. */
function refIdText(bytes: Uint8Array, offset: number): string | undefined {
  let text = '';
  let ended = false;
  for (let i = 0; i < 4; i++) {
    const b = bytes[offset + i]!;
    if (b === 0) {
      ended = true;
      continue;
    }
    if (ended || b < 0x20 || b > 0x7e) return undefined;
    text += String.fromCharCode(b);
  }
  return text;
}

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  const o = offset;
  if (avail >= 1) {
    const b0 = bytes[o]!;
    fields.leap = b0 >>> 6;
    fields.version = (b0 >>> 3) & 0x07;
    fields.mode = b0 & 0x07;
    fieldRanges.leap = [o, 1];
    fieldRanges.version = [o, 1];
    fieldRanges.mode = [o, 1];
  }
  if (avail < NTP_PACKET_BYTES) {
    return { fields, fieldRanges, headerLength: avail, length: avail, error: 'NTP packet truncated' };
  }
  const stratum = bytes[o + 1]!;
  fields.stratum = stratum;
  fields.poll = (bytes[o + 2]! << 24) >> 24;
  fields.precision = (bytes[o + 3]! << 24) >> 24;
  fields.rootDelay = readU32(bytes, o + 4);
  fields.rootDispersion = readU32(bytes, o + 8);
  const text = stratum >= 2 && stratum <= 15 ? undefined : refIdText(bytes, o + 12);
  fields.refId = text ?? bytesToIpv4(bytes, o + 12);
  fieldRanges.stratum = [o + 1, 1];
  fieldRanges.poll = [o + 2, 1];
  fieldRanges.precision = [o + 3, 1];
  fieldRanges.rootDelay = [o + 4, 4];
  fieldRanges.rootDispersion = [o + 8, 4];
  fieldRanges.refId = [o + 12, 4];
  for (const k of TS_FIELDS) {
    fields[k] = ntpWireTimestampText(bytes, o + TS_OFFSET[k]);
    fieldRanges[k] = [o + TS_OFFSET[k], 8];
  }
  return { fields, fieldRanges, headerLength: NTP_PACKET_BYTES, length: avail };
}

function field(fields: Readonly<Record<string, FieldValue>>, key: string, min: number, max: number, dflt: number | null): number {
  const v = numField('ntp', fields, key, dflt);
  if (v < min || v > max) throw new Error(`ntp.${key} out of range: ${v}`);
  return v;
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'ntp';
  if (payload.length > 0) throw new Error('ntp: an NTP packet carries no inner layer');
  const out = new Uint8Array(NTP_PACKET_BYTES);
  const leap = field(fields, 'leap', 0, 3, 0);
  const version = field(fields, 'version', 0, 7, 4);
  const mode = field(fields, 'mode', 0, 7, null);
  out[0] = (leap << 6) | (version << 3) | mode;
  out[1] = field(fields, 'stratum', 0, 255, 0);
  out[2] = field(fields, 'poll', -128, 127, 6) & 0xff;
  out[3] = field(fields, 'precision', -128, 127, 0) & 0xff;
  writeU32(out, 4, field(fields, 'rootDelay', 0, 0xffffffff, 0));
  writeU32(out, 8, field(fields, 'rootDispersion', 0, 0xffffffff, 0));
  const refId = strField(p, fields, 'refId', '');
  if (isIpv4(refId)) out.set(ipv4ToBytes(refId), 12);
  else {
    if (refId.length > 4) throw new Error(`ntp.refId text holds at most 4 characters, got "${refId}"`);
    for (let i = 0; i < refId.length; i++) {
      const c = refId.charCodeAt(i);
      if (c < 0x20 || c > 0x7e) throw new Error('ntp.refId text must be printable ASCII');
      out[12 + i] = c;
    }
  }
  for (const k of TS_FIELDS) writeNtpWireTimestamp(out, TS_OFFSET[k], strField(p, fields, k, NTP_ZERO_TIMESTAMP), `ntp.${k}`);
  return out;
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const mode = typeof fields.mode === 'number' ? fields.mode : -1;
  const name = MODE_TEXT[mode] ?? `mode ${mode}`;
  const alarm = fields.leap === NTP_LEAP_ALARM ? ', not synchronised' : '';
  if (mode === NTP_MODE.client) return `NTP client request, version ${String(fields.version ?? '?')}`;
  return `NTP ${name}, stratum ${String(fields.stratum ?? '?')}, reference ${String(fields.refId ?? '?')}${alarm}`;
}

/** NTPv4 codec. Required on encode: `mode`. */
export const ntpCodec: Codec = {
  proto: 'ntp',
  defaults: Object.freeze({ leap: 0, version: 4, mode: null, stratum: 0, poll: 6, precision: 0, rootDelay: 0, rootDispersion: 0, refId: '' }),
  decode,
  encode,
  summarize,
};
