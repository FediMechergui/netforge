/**
 * ESP codec [C13] (RFC 4303 layout, tunnel mode; ARCHITECTURE-P3 D27, §2.17, §3.13; contracts/fields.ts `esp`). IP
 * protocol 50. Headers real, crypto simulated: the inner packet travels in clear inside the PDU, which the tunnel
 * owner marks `meta.protected` with `protectedBy: 'esp'`; the inspector decodes it under its banner.
 *
 * Wire image (big-endian): `spi(4) seq(4) | inner packet | padding(padLength: 1, 2, 3 …) padLength(1) nextHeader(1) |
 * icv(12)`.
 *  • `padLength` pads the inner packet plus the two trailer bytes to a multiple of 4 (0–3 bytes; derived).
 *  • `nextHeader` is 4 (IPv4) by default and selects the next layer: 4 → ipv4, 41 → ipv6, anything else through the
 *    `ipproto` space.
 *  • `icv` (derived) is three chained FNV-1a 32 words over the protected span — spi, seq, the inner packet, the
 *    padding, padLength and nextHeader — never over a key:
 *      w0 = fnv(keyId ‖ span)        the keyed word, which only an end holding the SA's key id recomputes;
 *      w1 = fnv(span)                the integrity word, which anyone can recompute;
 *      w2 = fnv(w0 ‖ w1)             the chain.
 *    `icvValid` (decode-only) checks w1 and w2, so damage on the wire shows as an invalid ICV; the tunnel tail
 *    checks w0 against its SA's key id with `espIcvKeyMatches`. The key id is an ENCODE-ONLY input `keyId` (u32,
 *    default 0), which the tunnel head passes with `spi` and `seq`; it is not a wire field and is never decoded, so
 *    a re-encode from decoded fields (a tampering `mutate`) writes a w0 that no SA accepts.
 *  • `stopsMeaning` is false: summary() and topProto() describe the inner packet (the banner says it is protected).
 */
import type { Codec, DecodedLayer, FieldValue, MutationReason, ProtoName } from '../../contracts/pdu.js';
import { ESP_ICV_BYTES } from '../../contracts/pdu.js';
import { bytesField, fnv1aBytes, fnv1aU32, numField, readU32, writeU32 } from '../checksum.js';
import { nextProto } from './dispatch.js';

/** ESP header length (spi, seq). */
export const ESP_HEADER_BYTES = 8;
/** ESP next header of an IPv4 inner packet (tunnel mode). */
export const ESP_NEXT_HEADER_IPV4 = 4;
/** ESP next header of an IPv6 inner packet (tunnel mode). */
export const ESP_NEXT_HEADER_IPV6 = 41;

const TRAILER_FIXED = 2;

/** The inner protocol of an ESP `nextHeader` value. */
export function espInnerProto(nextHeader: number): ProtoName {
  if (nextHeader === ESP_NEXT_HEADER_IPV4) return 'ipv4';
  if (nextHeader === ESP_NEXT_HEADER_IPV6) return 'ipv6';
  return nextProto('ipproto', nextHeader);
}

/** Pad length for an inner packet of `innerLength` bytes (pads inner + 2 to a multiple of 4). */
export function espPadLength(innerLength: number): number {
  return (4 - ((innerLength + TRAILER_FIXED) % 4)) % 4;
}

/** The 12-byte ICV of the protected span `bytes[offset, offset+length)` (spi through nextHeader) under `keyId`. */
export function espIcv(bytes: Uint8Array, offset: number, length: number, keyId: number): Uint8Array {
  const w0 = fnv1aBytes(bytes, offset, length, fnv1aU32(keyId >>> 0));
  const w1 = fnv1aBytes(bytes, offset, length);
  const w2 = fnv1aU32(w1, fnv1aU32(w0));
  const icv = new Uint8Array(ESP_ICV_BYTES);
  writeU32(icv, 0, w0);
  writeU32(icv, 4, w1);
  writeU32(icv, 8, w2);
  return icv;
}

/** True when the ESP packet `bytes[offset, offset+length)` (header to ICV) carries a keyed word made with `keyId`. */
export function espIcvKeyMatches(bytes: Uint8Array, offset: number, length: number, keyId: number): boolean {
  if (length < ESP_HEADER_BYTES + TRAILER_FIXED + ESP_ICV_BYTES) return false;
  const span = length - ESP_ICV_BYTES;
  return readU32(bytes, offset + span) === fnv1aBytes(bytes, offset, span, fnv1aU32(keyId >>> 0));
}

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  const o = offset;
  if (avail < ESP_HEADER_BYTES) return { fields, fieldRanges, headerLength: avail, length: avail, error: 'ESP header truncated' };
  fields.spi = readU32(bytes, o);
  fields.seq = readU32(bytes, o + 4);
  fieldRanges.spi = [o, 4];
  fieldRanges.seq = [o + 4, 4];
  if (avail < ESP_HEADER_BYTES + TRAILER_FIXED + ESP_ICV_BYTES) {
    return { fields, fieldRanges, headerLength: ESP_HEADER_BYTES, length: avail, error: 'ESP trailer truncated' };
  }
  const icvAt = o + avail - ESP_ICV_BYTES;
  const nhAt = icvAt - 1;
  const padLenAt = icvAt - 2;
  const padLength = bytes[padLenAt]!;
  fields.padLength = padLength;
  fields.nextHeader = bytes[nhAt]!;
  fields.icv = bytes.slice(icvAt, icvAt + ESP_ICV_BYTES);
  fieldRanges.padLength = [padLenAt, 1];
  fieldRanges.nextHeader = [nhAt, 1];
  fieldRanges.icv = [icvAt, ESP_ICV_BYTES];
  const span = avail - ESP_ICV_BYTES;
  const w0 = readU32(bytes, icvAt);
  const w1 = readU32(bytes, icvAt + 4);
  const w2 = readU32(bytes, icvAt + 8);
  fields.icvValid = w1 === fnv1aBytes(bytes, o, span) && w2 === fnv1aU32(w1, fnv1aU32(w0));
  const innerLen = avail - ESP_HEADER_BYTES - TRAILER_FIXED - ESP_ICV_BYTES - padLength;
  if (innerLen < 0) {
    return { fields, fieldRanges, headerLength: ESP_HEADER_BYTES, length: avail, trailerLength: avail - ESP_HEADER_BYTES, error: `ESP pad length ${padLength} runs past the payload` };
  }
  const out: DecodedLayer = { fields, fieldRanges, headerLength: ESP_HEADER_BYTES, length: avail, trailerLength: avail - ESP_HEADER_BYTES - innerLen };
  for (let k = 0; k < padLength; k++) {
    if (bytes[o + ESP_HEADER_BYTES + innerLen + k] !== k + 1) {
      out.error = 'ESP padding is not 1, 2, 3 …';
      break;
    }
  }
  if (innerLen > 0) out.next = { proto: espInnerProto(fields.nextHeader), offset: o + ESP_HEADER_BYTES, length: innerLen };
  return out;
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'esp';
  const spi = numField(p, fields, 'spi', null);
  const seq = numField(p, fields, 'seq', null);
  const nextHeader = numField(p, fields, 'nextHeader', ESP_NEXT_HEADER_IPV4);
  const keyId = numField(p, fields, 'keyId', 0);
  if (spi < 0 || spi > 0xffffffff) throw new Error(`esp.spi out of range: ${spi}`);
  if (seq < 0 || seq > 0xffffffff) throw new Error(`esp.seq out of range: ${seq}`);
  if (nextHeader < 0 || nextHeader > 0xff) throw new Error(`esp.nextHeader out of range: ${nextHeader}`);
  if (keyId < 0 || keyId > 0xffffffff) throw new Error(`esp.keyId out of range: ${keyId}`);
  if (fields.icv !== undefined && fields.icv !== null) bytesField(p, fields, 'icv'); // type check only: always recomputed
  const pad = espPadLength(payload.length);
  const span = ESP_HEADER_BYTES + payload.length + pad + TRAILER_FIXED;
  const out = new Uint8Array(span + ESP_ICV_BYTES);
  writeU32(out, 0, spi);
  writeU32(out, 4, seq);
  out.set(payload, ESP_HEADER_BYTES);
  for (let k = 0; k < pad; k++) out[ESP_HEADER_BYTES + payload.length + k] = k + 1;
  out[span - 2] = pad;
  out[span - 1] = nextHeader;
  out.set(espIcv(out, 0, span, keyId), span);
  return out;
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const spi = typeof fields.spi === 'number' ? `0x${fields.spi.toString(16).padStart(8, '0')}` : '?';
  return `ESP spi ${spi} seq ${String(fields.seq ?? '?')}`;
}

const DERIVED: Readonly<Record<string, MutationReason>> = Object.freeze({ padLength: 'Padding', icv: 'ChecksumRecompute' });

/**
 * ESP codec [C13]. Required on encode: `spi`, `seq`; `nextHeader` defaults to 4; the encode-only `keyId` (the SA's key
 * id, D27) seeds the keyed ICV word.
 */
export const espCodec: Codec = {
  proto: 'esp',
  defaults: Object.freeze({ spi: null, seq: null, nextHeader: ESP_NEXT_HEADER_IPV4 }),
  decode,
  encode,
  summarize,
  derived: DERIVED,
  stopsMeaning: () => false,
};
