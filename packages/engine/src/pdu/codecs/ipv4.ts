/**
 * IPv4 codec (RFC 791) — spec §4.5, §2.1 "IPv4 addressing".
 *
 * Fields per the canonical table: version, ihl, dscp, ecn, totalLength, id, flags,
 * fragOffset, ttl, protocol, checksum, checksumValid (decode-only), src, dst.
 *
 *  • `encode` always emits a 20-byte header (ihl 5, no options) and recomputes
 *    ihl/totalLength/checksum; values passed for derived fields are ignored.
 *    `protocol`, `src` and `dst` are REQUIRED (the registry fills `protocol` from
 *    the inner layer name when the builder omits it).
 *  • `decode` honours `ihl` (options are skipped, not decoded) and sets
 *    `length = min(totalLength, bound)`: a header quoted inside an ICMP error
 *    declares its original totalLength, which exceeds what was actually quoted —
 *    we clamp instead of flagging an error. `error` is set only when the header
 *    itself is truncated or malformed.
 *  • `next`: protocol 1 → icmpv4, everything else → payload, at `offset + ihl*4`
 *    with length `length - ihl*4`.
 */
import type { Codec, DecodedLayer, FieldValue, MutationReason, ProtoName } from '../../contracts/pdu.js';
import { IPV4_DEFAULT_TTL_HOST } from '../../contracts/pdu.js';
import { bytesToIpv4, ipv4ToBytes } from '../../contracts/addr.js';
import { internetChecksum, numField, readU16, strField, writeU16 } from '../checksum.js';
import { keyForProto, nextProto } from './dispatch.js';

const MIN_HEADER = 20;

/**
 * IP protocol number → layer name via the shared `ipproto` dispatch table; unknown → payload.
 * A name without a registered codec (tcp/udp before P1) still decodes as payload in the chain walk.
 */
export function protoForIpProtocol(protocol: number): ProtoName {
  return nextProto('ipproto', protocol);
}

/** Protocol number implied by an inner layer name (registry fills a missing `protocol`). */
export function ipProtocolForProto(proto: ProtoName): number | undefined {
  return keyForProto('ipproto', proto);
}

const DERIVED: Readonly<Record<string, MutationReason>> = Object.freeze({
  checksum: 'ChecksumRecompute',
  totalLength: 'Other',
  ihl: 'Other',
});

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};

  if (avail < MIN_HEADER) {
    return { fields, fieldRanges, headerLength: avail, length: avail, error: 'IPv4 header truncated' };
  }
  const b0 = bytes[offset]!;
  const version = b0 >>> 4;
  const ihl = b0 & 0x0f;
  const b1 = bytes[offset + 1]!;
  const totalLength = readU16(bytes, offset + 2);
  const fl = readU16(bytes, offset + 6);
  const hdrLen = ihl * 4;

  fields.version = version;
  fields.ihl = ihl;
  fields.dscp = b1 >>> 2;
  fields.ecn = b1 & 0x03;
  fields.totalLength = totalLength;
  fields.id = readU16(bytes, offset + 4);
  fields.flags = fl >>> 13;
  fields.fragOffset = fl & 0x1fff;
  fields.ttl = bytes[offset + 8]!;
  fields.protocol = bytes[offset + 9]!;
  fields.checksum = readU16(bytes, offset + 10);
  fields.src = bytesToIpv4(bytes, offset + 12);
  fields.dst = bytesToIpv4(bytes, offset + 16);

  fieldRanges.version = [offset, 1];
  fieldRanges.ihl = [offset, 1];
  fieldRanges.dscp = [offset + 1, 1];
  fieldRanges.ecn = [offset + 1, 1];
  fieldRanges.totalLength = [offset + 2, 2];
  fieldRanges.id = [offset + 4, 2];
  fieldRanges.flags = [offset + 6, 2];
  fieldRanges.fragOffset = [offset + 6, 2];
  fieldRanges.ttl = [offset + 8, 1];
  fieldRanges.protocol = [offset + 9, 1];
  fieldRanges.checksum = [offset + 10, 2];
  fieldRanges.src = [offset + 12, 4];
  fieldRanges.dst = [offset + 16, 4];

  let error: string | undefined;
  if (version !== 4) error = `not an IPv4 header (version ${version})`;
  else if (hdrLen < MIN_HEADER) error = `bad IPv4 header length (ihl ${ihl})`;
  else if (avail < hdrLen) error = 'IPv4 options truncated';
  else if (totalLength < hdrLen) error = `IPv4 total length ${totalLength} smaller than header`;

  if (error) {
    fields.checksumValid = false;
    return { fields, fieldRanges, headerLength: Math.min(Math.max(hdrLen, MIN_HEADER), avail), length: avail, error };
  }

  fields.checksumValid = internetChecksum(bytes, offset, hdrLen) === 0;
  const layerLen = Math.min(totalLength, avail); // clamp: quoted headers declare more than was quoted
  return {
    fields,
    fieldRanges,
    headerLength: hdrLen,
    length: layerLen,
    next: { proto: protoForIpProtocol(fields.protocol), offset: offset + hdrLen, length: layerLen - hdrLen },
  };
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'ipv4';
  const dscp = numField(p, fields, 'dscp', 0);
  const ecn = numField(p, fields, 'ecn', 0);
  const id = numField(p, fields, 'id', 0);
  const flags = numField(p, fields, 'flags', 0);
  const fragOffset = numField(p, fields, 'fragOffset', 0);
  const ttl = numField(p, fields, 'ttl', IPV4_DEFAULT_TTL_HOST);
  const protocol = numField(p, fields, 'protocol', null);
  const src = ipv4ToBytes(strField(p, fields, 'src', null));
  const dst = ipv4ToBytes(strField(p, fields, 'dst', null));

  const totalLength = MIN_HEADER + payload.length;
  if (totalLength > 0xffff) throw new Error(`ipv4 datagram too large: ${totalLength} bytes`);
  if (ttl < 0 || ttl > 255) throw new Error(`ipv4.ttl out of range: ${ttl}`);
  if (protocol < 0 || protocol > 255) throw new Error(`ipv4.protocol out of range: ${protocol}`);

  const out = new Uint8Array(totalLength);
  out[0] = 0x45; // version 4, ihl 5
  out[1] = ((dscp & 0x3f) << 2) | (ecn & 0x03);
  writeU16(out, 2, totalLength);
  writeU16(out, 4, id & 0xffff);
  writeU16(out, 6, ((flags & 0x07) << 13) | (fragOffset & 0x1fff));
  out[8] = ttl;
  out[9] = protocol;
  // checksum (bytes 10-11) stays 0 while summing
  out.set(src, 12);
  out.set(dst, 16);
  writeU16(out, 10, internetChecksum(out, 0, MIN_HEADER));
  out.set(payload, MIN_HEADER);
  return out;
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  return `IPv4 ${String(fields.src ?? '?')} > ${String(fields.dst ?? '?')} proto=${String(fields.protocol ?? '?')} ttl=${String(fields.ttl ?? '?')}`;
}

/** IPv4 codec. Required on encode: `protocol`, `src`, `dst`. */
export const ipv4Codec: Codec = {
  proto: 'ipv4',
  defaults: Object.freeze({
    version: 4,
    dscp: 0,
    ecn: 0,
    id: 0,
    flags: 0,
    fragOffset: 0,
    ttl: IPV4_DEFAULT_TTL_HOST,
    protocol: null,
    src: null,
    dst: null,
  }),
  decode,
  encode,
  summarize,
  derived: DERIVED,
};
