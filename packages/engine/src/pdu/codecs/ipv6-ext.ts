/**
 * IPv6 extension header codecs (RFC 8200 §4) — ARCHITECTURE-P1 §4.2, contracts/fields.ts `ipv6-hopopts`,
 * `ipv6-route`, `ipv6-frag`, `ipv6-dstopts`.
 *
 *  • Hop-by-hop options (next header 0) and destination options (60):
 *    `nextHeader(1) hdrExtLen(1) options(6 + 8·hdrExtLen)`. `options` holds the raw option bytes (padding
 *    included). Encode pads the options to an 8-byte multiple with Pad1/PadN (RFC 8200 §4.2), so an empty list
 *    becomes one PadN of 4; decoded bytes re-encode unchanged. Options are not interpreted (router alert is
 *    ignored in P1).
 *  • Routing (43): `nextHeader(1) hdrExtLen(1) routingType(1) segmentsLeft(1) data(4 + 8·hdrExtLen)`. Encode pads
 *    `data` with zero bytes to an 8-byte multiple. The ipv6 daemon answers type 0 with a parameter problem.
 *  • Fragment (44): `nextHeader(1) reserved(1) offset(13 bits)·res(2)·M(1) id(4)` (8 bytes). Reassembly is not
 *    supported in P1: only an atomic fragment (offset 0, M clear) dispatches to its next header; every other
 *    fragment carries raw payload.
 *  • `hdrExtLen` is derived (always recomputed). Every header chains by `nextHeader` through the shared
 *    `ipproto` dispatch table; next header 59 ends the chain. A header running past the bound is truncated.
 */
import type { Codec, DecodedLayer, FieldValue, MutationReason } from '../../contracts/pdu.js';
import { IPPROTO_NONE } from '../../contracts/pdu.js';
import { bytesField, numField, readU16, readU32, writeU16, writeU32 } from '../checksum.js';
import { nextProto } from './dispatch.js';

const DERIVED: Readonly<Record<string, MutationReason>> = Object.freeze({ hdrExtLen: 'Other' });

/** Human names of the extension headers, used in summaries and errors. */
const NAMES: Readonly<Record<string, string>> = Object.freeze({
  'ipv6-hopopts': 'hop-by-hop options',
  'ipv6-route': 'routing',
  'ipv6-frag': 'fragment',
  'ipv6-dstopts': 'destination options',
});

/** Next-layer descriptor shared by the extension codecs. */
function chain(out: DecodedLayer, nextHeader: number, offset: number, remaining: number, dispatch: boolean): void {
  if (remaining <= 0 || nextHeader === IPPROTO_NONE) return;
  out.next = { proto: dispatch ? nextProto('ipproto', nextHeader) : 'payload', offset, length: remaining };
}

function nextHeaderField(proto: string, fields: Readonly<Record<string, FieldValue>>): number {
  const nh = numField(proto, fields, 'nextHeader', null);
  if (nh < 0 || nh > 0xff) throw new Error(`${proto}.nextHeader out of range: ${nh}`);
  return nh;
}

/** Pad option bytes (after the 2-byte header) to an 8-byte multiple with Pad1 / PadN. */
export function padIpv6Options(options: Uint8Array): Uint8Array {
  const pad = (8 - ((2 + options.length) % 8)) % 8;
  if (pad === 0) return options;
  const out = new Uint8Array(options.length + pad);
  out.set(options, 0);
  if (pad === 1) out[options.length] = 0; // Pad1
  else {
    out[options.length] = 1; // PadN
    out[options.length + 1] = pad - 2;
  }
  return out;
}

// ── hop-by-hop / destination options ─────────────────────────────────────────

function optionsCodec(proto: 'ipv6-hopopts' | 'ipv6-dstopts'): Codec {
  const name = NAMES[proto]!;
  function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
    const avail = Math.max(0, Math.min(length, bytes.length - offset));
    const fields: Record<string, FieldValue> = {};
    const fieldRanges: Record<string, readonly [number, number]> = {};
    if (avail < 2) {
      if (avail === 1) {
        fields.nextHeader = bytes[offset]!;
        fieldRanges.nextHeader = [offset, 1];
      }
      return { fields, fieldRanges, headerLength: avail, length: avail, error: `IPv6 ${name} header truncated` };
    }
    fields.nextHeader = bytes[offset]!;
    fields.hdrExtLen = bytes[offset + 1]!;
    fieldRanges.nextHeader = [offset, 1];
    fieldRanges.hdrExtLen = [offset + 1, 1];
    const hdrLen = (fields.hdrExtLen + 1) * 8;
    if (avail < hdrLen) {
      fields.options = bytes.slice(offset + 2, offset + avail);
      fieldRanges.options = [offset + 2, avail - 2];
      return { fields, fieldRanges, headerLength: avail, length: avail, error: `IPv6 ${name} header truncated` };
    }
    fields.options = bytes.slice(offset + 2, offset + hdrLen);
    fieldRanges.options = [offset + 2, hdrLen - 2];
    const out: DecodedLayer = { fields, fieldRanges, headerLength: hdrLen, length: avail };
    chain(out, fields.nextHeader, offset + hdrLen, avail - hdrLen, true);
    return out;
  }
  function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
    const nh = nextHeaderField(proto, fields);
    const options = padIpv6Options(bytesField(proto, fields, 'options'));
    const hdrLen = 2 + options.length;
    if (hdrLen / 8 - 1 > 0xff) throw new Error(`${proto}.options too long: ${options.length} bytes`);
    const out = new Uint8Array(hdrLen + payload.length);
    out[0] = nh;
    out[1] = hdrLen / 8 - 1;
    out.set(options, 2);
    out.set(payload, hdrLen);
    return out;
  }
  function summarize(fields: Readonly<Record<string, FieldValue>>): string {
    return `IPv6 ${name} next=${String(fields.nextHeader ?? '?')}`;
  }
  return {
    proto,
    defaults: Object.freeze({ nextHeader: null, options: new Uint8Array(0) }),
    decode,
    encode,
    summarize,
    derived: DERIVED,
  };
}

/** Hop-by-hop options header codec (next header 0). Required on encode: `nextHeader`. */
export const ipv6HopOptsCodec: Codec = optionsCodec('ipv6-hopopts');

/** Destination options header codec (next header 60). Required on encode: `nextHeader`. */
export const ipv6DstOptsCodec: Codec = optionsCodec('ipv6-dstopts');

// ── routing ──────────────────────────────────────────────────────────────────

function routeDecode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  const err = 'IPv6 routing header truncated';
  if (avail < 4) {
    if (avail >= 1) {
      fields.nextHeader = bytes[offset]!;
      fieldRanges.nextHeader = [offset, 1];
    }
    if (avail >= 2) {
      fields.hdrExtLen = bytes[offset + 1]!;
      fieldRanges.hdrExtLen = [offset + 1, 1];
    }
    return { fields, fieldRanges, headerLength: avail, length: avail, error: err };
  }
  fields.nextHeader = bytes[offset]!;
  fields.hdrExtLen = bytes[offset + 1]!;
  fields.routingType = bytes[offset + 2]!;
  fields.segmentsLeft = bytes[offset + 3]!;
  fieldRanges.nextHeader = [offset, 1];
  fieldRanges.hdrExtLen = [offset + 1, 1];
  fieldRanges.routingType = [offset + 2, 1];
  fieldRanges.segmentsLeft = [offset + 3, 1];
  const hdrLen = (fields.hdrExtLen + 1) * 8;
  if (avail < hdrLen) {
    fields.data = bytes.slice(offset + 4, offset + avail);
    fieldRanges.data = [offset + 4, avail - 4];
    return { fields, fieldRanges, headerLength: avail, length: avail, error: err };
  }
  fields.data = bytes.slice(offset + 4, offset + hdrLen);
  fieldRanges.data = [offset + 4, hdrLen - 4];
  const out: DecodedLayer = { fields, fieldRanges, headerLength: hdrLen, length: avail };
  chain(out, fields.nextHeader, offset + hdrLen, avail - hdrLen, true);
  return out;
}

function routeEncode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'ipv6-route';
  const nh = nextHeaderField(p, fields);
  const routingType = numField(p, fields, 'routingType', 0);
  const segmentsLeft = numField(p, fields, 'segmentsLeft', 0);
  if (routingType < 0 || routingType > 0xff) throw new Error(`ipv6-route.routingType out of range: ${routingType}`);
  if (segmentsLeft < 0 || segmentsLeft > 0xff) throw new Error(`ipv6-route.segmentsLeft out of range: ${segmentsLeft}`);
  const data = bytesField(p, fields, 'data');
  const hdrLen = Math.max(8, Math.ceil((4 + data.length) / 8) * 8);
  if (hdrLen / 8 - 1 > 0xff) throw new Error(`ipv6-route.data too long: ${data.length} bytes`);
  const out = new Uint8Array(hdrLen + payload.length);
  out[0] = nh;
  out[1] = hdrLen / 8 - 1;
  out[2] = routingType;
  out[3] = segmentsLeft;
  out.set(data, 4);
  out.set(payload, hdrLen);
  return out;
}

/** Routing header codec (next header 43). Required on encode: `nextHeader`. */
export const ipv6RouteCodec: Codec = {
  proto: 'ipv6-route',
  defaults: Object.freeze({ nextHeader: null, routingType: 0, segmentsLeft: 0, data: new Uint8Array(0) }),
  decode: routeDecode,
  encode: routeEncode,
  summarize: (fields) =>
    `IPv6 routing type=${String(fields.routingType ?? '?')} segments-left=${String(fields.segmentsLeft ?? '?')} next=${String(fields.nextHeader ?? '?')}`,
  derived: DERIVED,
};

// ── fragment ─────────────────────────────────────────────────────────────────

const FRAG_HEADER = 8;

function fragDecode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  if (avail < FRAG_HEADER) {
    if (avail >= 1) {
      fields.nextHeader = bytes[offset]!;
      fieldRanges.nextHeader = [offset, 1];
    }
    return { fields, fieldRanges, headerLength: avail, length: avail, error: 'IPv6 fragment header truncated' };
  }
  const w = readU16(bytes, offset + 2);
  fields.nextHeader = bytes[offset]!;
  fields.offset = w >>> 3;
  fields.more = (w & 1) === 1;
  fields.id = readU32(bytes, offset + 4);
  fieldRanges.nextHeader = [offset, 1];
  fieldRanges.offset = [offset + 2, 2];
  fieldRanges.more = [offset + 3, 1];
  fieldRanges.id = [offset + 4, 4];
  const out: DecodedLayer = { fields, fieldRanges, headerLength: FRAG_HEADER, length: avail };
  const atomic = fields.offset === 0 && fields.more === false;
  chain(out, fields.nextHeader, offset + FRAG_HEADER, avail - FRAG_HEADER, atomic);
  return out;
}

function fragEncode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'ipv6-frag';
  const nh = nextHeaderField(p, fields);
  const fragOffset = numField(p, fields, 'offset', 0);
  const more = numField(p, fields, 'more', 0);
  const id = numField(p, fields, 'id', 0);
  if (fragOffset < 0 || fragOffset > 0x1fff) throw new Error(`ipv6-frag.offset out of range: ${fragOffset}`);
  if (id < 0 || id > 0xffffffff) throw new Error(`ipv6-frag.id out of range: ${id}`);
  const out = new Uint8Array(FRAG_HEADER + payload.length);
  out[0] = nh;
  writeU16(out, 2, (fragOffset << 3) | (more ? 1 : 0));
  writeU32(out, 4, id);
  out.set(payload, FRAG_HEADER);
  return out;
}

/** Fragment header codec (next header 44). Required on encode: `nextHeader`. */
export const ipv6FragCodec: Codec = {
  proto: 'ipv6-frag',
  defaults: Object.freeze({ nextHeader: null, offset: 0, more: false, id: 0 }),
  decode: fragDecode,
  encode: fragEncode,
  summarize: (fields) =>
    `IPv6 fragment id=${String(fields.id ?? '?')} offset=${String(fields.offset ?? '?')}${fields.more === true ? ' more' : ''} next=${String(fields.nextHeader ?? '?')}`,
};
