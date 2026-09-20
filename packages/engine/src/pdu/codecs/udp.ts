/**
 * UDP codec (RFC 768; IPv6 rules RFC 8200 §8.1) — ARCHITECTURE-P1 §4.2, contracts/fields.ts `udp`.
 *
 * Wire image: `srcPort(2) dstPort(2) length(2) checksum(2) data...`.
 *  • Fields: srcPort, dstPort (required); length, checksum (derived: always recomputed by `encode`);
 *    checksumValid (decode-only).
 *  • The checksum covers the pseudo-header of the NEAREST enclosing IP layer in the CodecContext (IPv4:
 *    src, dst, zero, 17, length; IPv6: src, dst, length, zeros, 17), the header and the data. A computed 0 is
 *    sent as 0xffff. With no enclosing IP layer (a bare `encodeLayers([udp, …])`) the checksum is 0 ("none").
 *    `outerInputs` lists ipv4.src/dst and ipv6.src/dst, so a NAT-style `mutate` re-encodes this layer.
 *  • Decode verification: over IPv4 a transmitted 0 means "no checksum" and leaves `checksumValid`
 *    undefined (fields.ts correction 3); over IPv6 the checksum is mandatory, so 0 is invalid. A header quoted
 *    inside an ICMP/ICMPv6 error, or a datagram whose declared length exceeds the bytes present, is never
 *    verified (`checksumValid` undefined); a quote is not an error even when only its 8-byte header is present.
 *  • `length` of the layer = the declared UDP length (trailing bytes past it are not attributed to UDP); when
 *    fewer bytes are present the layer covers what is there. Errors: header truncated (fewer than 8 bytes, not
 *    quoted), declared length below 8, datagram truncated (not quoted).
 *  • Next layer: DISPATCH_TABLE `udp.port` (destination first, then source) when the data is at least 1 byte
 *    and complete; otherwise raw payload.
 *
 * The CodecContext helpers exported here (`nearestIpLayer`, `isQuotedContext`, `pseudoHeaderSumFor`) are shared
 * with the tcp and icmpv6 codecs.
 */
import type { Codec, CodecContext, DecodedLayer, FieldValue, MutationReason, ProtoName } from '../../contracts/pdu.js';
import { IPPROTO_UDP, UDP_HEADER } from '../../contracts/pdu.js';
import { ipv6ToBytes } from '../../core/addr6.js';
import { finishChecksum, numField, onesSum, pseudoHeaderSumV4, pseudoHeaderSumV6, readU16, writeU16 } from '../checksum.js';
import { lookupPortNext } from './dispatch.js';

/** The nearest enclosing IP layer of a codec context (innermost `ipv4` or `ipv6`), with its index in `ctx.outer`. */
export interface NearestIp {
  readonly family: 4 | 6;
  readonly index: number;
  readonly fields: Readonly<Record<string, FieldValue>>;
}

/** Innermost `ipv4`/`ipv6` layer of `ctx.outer`, or undefined when the layer has no enclosing IP header. */
export function nearestIpLayer(ctx: CodecContext | undefined): NearestIp | undefined {
  const outer = ctx?.outer;
  if (!outer) return undefined;
  for (let i = outer.length - 1; i >= 0; i--) {
    const o = outer[i]!;
    if (o.proto === 'ipv4') return { family: 4, index: i, fields: o.fields };
    if (o.proto === 'ipv6') return { family: 6, index: i, fields: o.fields };
  }
  return undefined;
}

/**
 * True when the layer sits inside the datagram quoted by an ICMP or ICMPv6 error: some `icmpv4`/`icmpv6` layer
 * encloses its nearest IP header (those codecs chain to an IP layer only for error messages).
 */
export function isQuotedContext(ctx: CodecContext | undefined): boolean {
  const ip = nearestIpLayer(ctx);
  if (!ip || !ctx) return false;
  for (let i = 0; i < ip.index; i++) {
    const p = ctx.outer[i]!.proto;
    if (p === 'icmpv4' || p === 'icmpv6') return true;
  }
  return false;
}

/**
 * Folded pseudo-header sum for an upper-layer message of `upperLength` bytes and IP protocol `proto`, taken from
 * the nearest enclosing IP layer of `ctx`. Undefined when there is no enclosing IP layer or its addresses do not
 * parse.
 */
export function pseudoHeaderSumFor(ctx: CodecContext | undefined, proto: number, upperLength: number): number | undefined {
  const ip = nearestIpLayer(ctx);
  if (!ip) return undefined;
  const src = ip.fields.src;
  const dst = ip.fields.dst;
  if (typeof src !== 'string' || typeof dst !== 'string') return undefined;
  try {
    if (ip.family === 4) return pseudoHeaderSumV4(src, dst, proto, upperLength);
    return pseudoHeaderSumV6(ipv6ToBytes(src), ipv6ToBytes(dst), proto, upperLength);
  } catch {
    return undefined;
  }
}

/** ` 10.0.0.1:53 > 10.0.0.2:49152` style endpoints from the nearest IP layer (IPv6 bracketed), or plain ports. */
export function transportEndpoints(fields: Readonly<Record<string, FieldValue>>, ctx: CodecContext | undefined): string {
  const sp = String(fields.srcPort ?? '?');
  const dp = String(fields.dstPort ?? '?');
  const ip = nearestIpLayer(ctx);
  if (!ip) return `${sp} > ${dp}`;
  const wrap = (a: FieldValue | undefined): string => (ip.family === 6 ? `[${String(a ?? '?')}]` : String(a ?? '?'));
  return `${wrap(ip.fields.src)}:${sp} > ${wrap(ip.fields.dst)}:${dp}`;
}

const DERIVED: Readonly<Record<string, MutationReason>> = Object.freeze({ length: 'Other', checksum: 'ChecksumRecompute' });

function decode(bytes: Uint8Array, offset: number, length: number, ctx?: CodecContext): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  const quoted = isQuotedContext(ctx);

  if (avail < UDP_HEADER) {
    if (avail >= 2) {
      fields.srcPort = readU16(bytes, offset);
      fieldRanges.srcPort = [offset, 2];
    }
    if (avail >= 4) {
      fields.dstPort = readU16(bytes, offset + 2);
      fieldRanges.dstPort = [offset + 2, 2];
    }
    if (avail >= 6) {
      fields.length = readU16(bytes, offset + 4);
      fieldRanges.length = [offset + 4, 2];
    }
    const out: DecodedLayer = { fields, fieldRanges, headerLength: avail, length: avail };
    if (!quoted) out.error = 'UDP header truncated';
    return out;
  }

  const declared = readU16(bytes, offset + 4);
  fields.srcPort = readU16(bytes, offset);
  fields.dstPort = readU16(bytes, offset + 2);
  fields.length = declared;
  fields.checksum = readU16(bytes, offset + 6);
  fieldRanges.srcPort = [offset, 2];
  fieldRanges.dstPort = [offset + 2, 2];
  fieldRanges.length = [offset + 4, 2];
  fieldRanges.checksum = [offset + 6, 2];

  if (declared < UDP_HEADER) {
    fields.checksumValid = false;
    return { fields, fieldRanges, headerLength: UDP_HEADER, length: avail, error: `UDP length ${declared} is smaller than the header` };
  }

  const complete = declared <= avail;
  const layerLen = complete ? declared : avail;
  const out: DecodedLayer = { fields, fieldRanges, headerLength: UDP_HEADER, length: layerLen };
  if (!complete && !quoted) out.error = `UDP datagram truncated (length ${declared}, ${avail} bytes present)`;

  if (complete && !quoted) {
    const ip = nearestIpLayer(ctx);
    const checksum = fields.checksum;
    if (ip && !(ip.family === 4 && checksum === 0)) {
      const pseudo = pseudoHeaderSumFor(ctx, IPPROTO_UDP, declared);
      if (ip.family === 6 && checksum === 0) fields.checksumValid = false;
      else if (pseudo !== undefined) fields.checksumValid = finishChecksum(onesSum(bytes, offset, declared, pseudo)) === 0;
    }
  }

  const dataLen = layerLen - UDP_HEADER;
  if (dataLen > 0) {
    const app: ProtoName | undefined = complete ? lookupPortNext('udp.port', fields.dstPort, fields.srcPort, dataLen) : undefined;
    out.next = { proto: app ?? 'payload', offset: offset + UDP_HEADER, length: dataLen };
  }
  return out;
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array, ctx?: CodecContext): Uint8Array {
  const p = 'udp';
  const srcPort = numField(p, fields, 'srcPort', null);
  const dstPort = numField(p, fields, 'dstPort', null);
  if (srcPort < 0 || srcPort > 0xffff) throw new Error(`udp.srcPort out of range: ${srcPort}`);
  if (dstPort < 0 || dstPort > 0xffff) throw new Error(`udp.dstPort out of range: ${dstPort}`);
  const len = UDP_HEADER + payload.length;
  if (len > 0xffff) throw new Error(`udp datagram too large: ${len} bytes`);

  const out = new Uint8Array(len);
  writeU16(out, 0, srcPort);
  writeU16(out, 2, dstPort);
  writeU16(out, 4, len);
  out.set(payload, UDP_HEADER);
  const pseudo = pseudoHeaderSumFor(ctx, IPPROTO_UDP, len);
  if (pseudo !== undefined) {
    const c = finishChecksum(onesSum(out, 0, len, pseudo));
    writeU16(out, 6, c === 0 ? 0xffff : c);
  }
  return out;
}

function summarize(fields: Readonly<Record<string, FieldValue>>, ctx?: CodecContext): string {
  const len = typeof fields.length === 'number' ? ` len=${Math.max(0, fields.length - UDP_HEADER)}` : '';
  return `UDP ${transportEndpoints(fields, ctx)}${len}`;
}

/** UDP codec. Required on encode: `srcPort`, `dstPort`. */
export const udpCodec: Codec = {
  proto: 'udp',
  defaults: Object.freeze({ srcPort: null, dstPort: null }),
  decode,
  encode,
  summarize,
  derived: DERIVED,
  outerInputs: Object.freeze(['ipv4.src', 'ipv4.dst', 'ipv6.src', 'ipv6.dst']),
};
