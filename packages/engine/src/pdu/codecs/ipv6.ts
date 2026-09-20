/**
 * IPv6 codec (RFC 8200 §3; text form RFC 5952) — ARCHITECTURE-P1 §4.2, §4.6, contracts/fields.ts `ipv6`.
 *
 * Wire image: `version(4) trafficClass(8) flowLabel(20) payloadLength(16) nextHeader(8) hopLimit(8) src(16)
 * dst(16) payload...` (40-byte fixed header).
 *  • Fields: version (default 6), trafficClass (default 0), flowLabel (default 0), payloadLength (derived),
 *    nextHeader (required; the registry fills it from the inner layer name), hopLimit (default 64), src, dst
 *    (required). Addresses decode to RFC 5952 canonical text; encode accepts any valid RFC 4291 text form.
 *  • `decode` sets `length = min(40 + payloadLength, bound)`: a header quoted inside an ICMPv6 error declares
 *    the original payload length, which may exceed what was quoted, so the layer is clamped instead of flagged.
 *    `error` is set only when the header itself is truncated or the version is not 6.
 *  • Next layer: DISPATCH_TABLE `ipproto` on `nextHeader` (extension headers, icmpv6, tcp, udp; unknown values
 *    decode as payload) whenever the payload is at least 1 byte; next header 59 (no next header) ends the chain.
 *  • Jumbograms (payload length 0 with a hop-by-hop jumbo option) are not simulated.
 */
import type { Codec, DecodedLayer, FieldValue, MutationReason } from '../../contracts/pdu.js';
import { IPPROTO_NONE, IPV6_DEFAULT_HOP_LIMIT, IPV6_HEADER } from '../../contracts/pdu.js';
import { bytesToIpv6, ipv6ToBytes } from '../../core/addr6.js';
import { numField, readU16, strField, writeU16 } from '../checksum.js';
import { nextProto } from './dispatch.js';

const DERIVED: Readonly<Record<string, MutationReason>> = Object.freeze({ payloadLength: 'Other' });

/** Encode an IPv6 text address to 16 bytes, naming the field in the error. */
export function ipv6FieldBytes(proto: string, key: string, value: string): Uint8Array {
  try {
    return ipv6ToBytes(value);
  } catch {
    throw new Error(`${proto}.${key} is not a valid IPv6 address: "${value}"`);
  }
}

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};

  if (avail < IPV6_HEADER) {
    if (avail >= 1) {
      fields.version = bytes[offset]! >>> 4;
      fieldRanges.version = [offset, 1];
    }
    return { fields, fieldRanges, headerLength: avail, length: avail, error: 'IPv6 header truncated' };
  }
  const w0 = ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
  const version = w0 >>> 28;
  const payloadLength = readU16(bytes, offset + 4);
  fields.version = version;
  fields.trafficClass = (w0 >>> 20) & 0xff;
  fields.flowLabel = w0 & 0xfffff;
  fields.payloadLength = payloadLength;
  fields.nextHeader = bytes[offset + 6]!;
  fields.hopLimit = bytes[offset + 7]!;
  fields.src = bytesToIpv6(bytes, offset + 8);
  fields.dst = bytesToIpv6(bytes, offset + 24);
  fieldRanges.version = [offset, 1];
  fieldRanges.trafficClass = [offset, 2];
  fieldRanges.flowLabel = [offset + 1, 3];
  fieldRanges.payloadLength = [offset + 4, 2];
  fieldRanges.nextHeader = [offset + 6, 1];
  fieldRanges.hopLimit = [offset + 7, 1];
  fieldRanges.src = [offset + 8, 16];
  fieldRanges.dst = [offset + 24, 16];

  if (version !== 6) {
    return { fields, fieldRanges, headerLength: IPV6_HEADER, length: avail, error: `not an IPv6 header (version ${version})` };
  }
  const layerLen = Math.min(IPV6_HEADER + payloadLength, avail);
  const out: DecodedLayer = { fields, fieldRanges, headerLength: IPV6_HEADER, length: layerLen };
  const inner = layerLen - IPV6_HEADER;
  if (inner > 0 && fields.nextHeader !== IPPROTO_NONE) {
    out.next = { proto: nextProto('ipproto', fields.nextHeader), offset: offset + IPV6_HEADER, length: inner };
  }
  return out;
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'ipv6';
  const trafficClass = numField(p, fields, 'trafficClass', 0);
  const flowLabel = numField(p, fields, 'flowLabel', 0);
  const nextHeader = numField(p, fields, 'nextHeader', null);
  const hopLimit = numField(p, fields, 'hopLimit', IPV6_DEFAULT_HOP_LIMIT);
  const src = ipv6FieldBytes(p, 'src', strField(p, fields, 'src', null));
  const dst = ipv6FieldBytes(p, 'dst', strField(p, fields, 'dst', null));
  if (trafficClass < 0 || trafficClass > 0xff) throw new Error(`ipv6.trafficClass out of range: ${trafficClass}`);
  if (flowLabel < 0 || flowLabel > 0xfffff) throw new Error(`ipv6.flowLabel out of range: ${flowLabel}`);
  if (nextHeader < 0 || nextHeader > 0xff) throw new Error(`ipv6.nextHeader out of range: ${nextHeader}`);
  if (hopLimit < 0 || hopLimit > 0xff) throw new Error(`ipv6.hopLimit out of range: ${hopLimit}`);
  if (payload.length > 0xffff) throw new Error(`ipv6 payload too large: ${payload.length} bytes (jumbograms are not simulated)`);

  const out = new Uint8Array(IPV6_HEADER + payload.length);
  out[0] = 0x60 | (trafficClass >>> 4);
  out[1] = ((trafficClass & 0x0f) << 4) | (flowLabel >>> 16);
  out[2] = (flowLabel >>> 8) & 0xff;
  out[3] = flowLabel & 0xff;
  writeU16(out, 4, payload.length);
  out[6] = nextHeader;
  out[7] = hopLimit;
  out.set(src, 8);
  out.set(dst, 24);
  out.set(payload, IPV6_HEADER);
  return out;
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  return `IPv6 ${String(fields.src ?? '?')} > ${String(fields.dst ?? '?')} next=${String(fields.nextHeader ?? '?')} hlim=${String(fields.hopLimit ?? '?')}`;
}

/** IPv6 codec. Required on encode: `nextHeader`, `src`, `dst`. */
export const ipv6Codec: Codec = {
  proto: 'ipv6',
  defaults: Object.freeze({
    version: 6,
    trafficClass: 0,
    flowLabel: 0,
    nextHeader: null,
    hopLimit: IPV6_DEFAULT_HOP_LIMIT,
    src: null,
    dst: null,
  }),
  decode,
  encode,
  summarize,
  derived: DERIVED,
};
