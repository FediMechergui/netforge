/**
 * ICMPv4 codec (RFC 792) — spec §4.5, §2.1 "Troubleshooting (ping)".
 *
 * Header (8 bytes): type(1) code(1) checksum(2) + 4 type-specific bytes:
 *  • echo request (8) / echo reply (0): id(2) seq(2), then the echo payload
 *    → `next = payload`.
 *  • destination unreachable (3) / time exceeded (11): unused(4), then the quoted
 *    original datagram (IPv4 header + 8 bytes of its payload) → `next = ipv4` so the
 *    quote shows up as nested `ipv4` → `icmpv4` layers. The quoted ipv4 header's
 *    totalLength exceeds the bound; the ipv4 codec clamps.
 *  • any other type: unused(4) → `next = payload`.
 * The checksum covers the entire ICMP message (header + everything after it), i.e.
 * the `length` bound handed down by IPv4. `checksumValid` is decode-only.
 *
 * `summarize` accepts two extra keys, `src` and `dst`, that are NOT ICMP fields; when
 * they are absent it reads them from the nearest enclosing `ipv4` layer in the
 * `CodecContext`, so the one-liner reads "ICMP echo request 10.0.0.1 > 10.0.0.2 id=1 seq=1".
 * `stopsMeaning` marks errors (3/11): summary/topProto never descend into the quote.
 */
import type { Codec, CodecContext, DecodedLayer, FieldValue, MutationReason } from '../../contracts/pdu.js';
import {
  ICMP_DEST_UNREACHABLE,
  ICMP_ECHO_REPLY,
  ICMP_ECHO_REQUEST,
  ICMP_TIME_EXCEEDED,
} from '../../contracts/pdu.js';
import { internetChecksum, numField, readU16, readU32, writeU16, writeU32 } from '../checksum.js';

const HEADER = 8;

function isEcho(type: number): boolean {
  return type === ICMP_ECHO_REQUEST || type === ICMP_ECHO_REPLY;
}

function isError(type: number): boolean {
  return type === ICMP_DEST_UNREACHABLE || type === ICMP_TIME_EXCEEDED;
}

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};

  if (avail < HEADER) {
    if (avail >= 1) {
      fields.type = bytes[offset]!;
      fieldRanges.type = [offset, 1];
    }
    if (avail >= 2) {
      fields.code = bytes[offset + 1]!;
      fieldRanges.code = [offset + 1, 1];
    }
    fields.checksumValid = false;
    return { fields, fieldRanges, headerLength: avail, length: avail, error: 'ICMP header truncated' };
  }

  const type = bytes[offset]!;
  fields.type = type;
  fields.code = bytes[offset + 1]!;
  fields.checksum = readU16(bytes, offset + 2);
  fields.checksumValid = internetChecksum(bytes, offset, avail) === 0;
  fieldRanges.type = [offset, 1];
  fieldRanges.code = [offset + 1, 1];
  fieldRanges.checksum = [offset + 2, 2];

  if (isEcho(type)) {
    fields.id = readU16(bytes, offset + 4);
    fields.seq = readU16(bytes, offset + 6);
    fieldRanges.id = [offset + 4, 2];
    fieldRanges.seq = [offset + 6, 2];
  } else {
    fields.unused = readU32(bytes, offset + 4);
    fieldRanges.unused = [offset + 4, 4];
  }

  return {
    fields,
    fieldRanges,
    headerLength: HEADER,
    length: avail,
    next: { proto: isError(type) ? 'ipv4' : 'payload', offset: offset + HEADER, length: avail - HEADER },
  };
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'icmpv4';
  const type = numField(p, fields, 'type', ICMP_ECHO_REQUEST);
  const code = numField(p, fields, 'code', 0);
  if (type < 0 || type > 255) throw new Error(`icmpv4.type out of range: ${type}`);
  if (code < 0 || code > 255) throw new Error(`icmpv4.code out of range: ${code}`);

  const out = new Uint8Array(HEADER + payload.length);
  out[0] = type;
  out[1] = code;
  if (isEcho(type)) {
    writeU16(out, 4, numField(p, fields, 'id', 0) & 0xffff);
    writeU16(out, 6, numField(p, fields, 'seq', 0) & 0xffff);
  } else {
    writeU32(out, 4, numField(p, fields, 'unused', 0) >>> 0);
  }
  out.set(payload, HEADER);
  writeU16(out, 2, internetChecksum(out, 0, out.length));
  return out;
}

function unreachableName(code: number): string {
  switch (code) {
    case 0:
      return 'net';
    case 1:
      return 'host';
    case 2:
      return 'protocol';
    case 3:
      return 'port';
    case 4:
      return 'fragmentation needed';
    case 5:
      return 'source route failed';
    case 6:
      return 'net unknown';
    case 7:
      return 'host unknown';
    case 9:
      return 'net prohibited';
    case 10:
      return 'host prohibited';
    case 13:
      return 'administratively prohibited';
    default:
      return `code ${code}`;
  }
}

function timeExceededName(code: number): string {
  switch (code) {
    case 0:
      return 'ttl';
    case 1:
      return 'fragment reassembly';
    default:
      return `code ${code}`;
  }
}

/** src/dst for the one-liner: explicit keys first, else the nearest enclosing ipv4 layer. */
function addresses(fields: Readonly<Record<string, FieldValue>>, ctx: CodecContext | undefined): string {
  if (fields.src !== undefined && fields.dst !== undefined) return ` ${String(fields.src)} > ${String(fields.dst)}`;
  if (!ctx) return '';
  for (let j = ctx.outer.length - 1; j >= 0; j--) {
    const o = ctx.outer[j]!;
    if (o.proto === 'ipv4') return ` ${String(o.fields.src ?? null)} > ${String(o.fields.dst ?? null)}`;
  }
  return '';
}

function summarize(fields: Readonly<Record<string, FieldValue>>, ctx?: CodecContext): string {
  const type = typeof fields.type === 'number' ? fields.type : -1;
  const code = typeof fields.code === 'number' ? fields.code : 0;
  const addrs = addresses(fields, ctx);
  switch (type) {
    case ICMP_ECHO_REQUEST:
      return `ICMP echo request${addrs} id=${String(fields.id ?? '?')} seq=${String(fields.seq ?? '?')}`;
    case ICMP_ECHO_REPLY:
      return `ICMP echo reply${addrs} id=${String(fields.id ?? '?')} seq=${String(fields.seq ?? '?')}`;
    case ICMP_DEST_UNREACHABLE:
      return `ICMP destination unreachable (${unreachableName(code)})`;
    case ICMP_TIME_EXCEEDED:
      return `ICMP time exceeded (${timeExceededName(code)})`;
    default:
      return `ICMP type=${type} code=${code}${addrs}`;
  }
}

/** ICMPv4 codec (echo request/reply, destination unreachable, time exceeded; other types decode generically). */
export const icmpv4Codec: Codec = {
  proto: 'icmpv4',
  defaults: Object.freeze({ type: ICMP_ECHO_REQUEST, code: 0, id: 0, seq: 0, unused: 0 }),
  decode,
  encode,
  summarize,
  derived: Object.freeze({ checksum: 'ChecksumRecompute' }) as Readonly<Record<string, MutationReason>>,
  stopsMeaning: (fields: Readonly<Record<string, FieldValue>>): boolean =>
    typeof fields.type === 'number' && isError(fields.type),
};
