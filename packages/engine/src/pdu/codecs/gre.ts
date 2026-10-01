/**
 * GRE codec [S18] (RFC 2784, key and sequence bits RFC 2890; ARCHITECTURE-P3 D17, §2.3, §3.10; contracts/fields.ts
 * `gre`). IP protocol 47. The tunnel head pushes `[ipv4 {protocol 47}, gre]` around the inner packet in one rewrap,
 * so the PduId never changes.
 *
 * Wire image (big-endian): `C(1) 0 K(1) S(1) reserved0(9) version(3) | protocolType(2)`, then the optional
 * `checksum(2) reserved1(2)` (C), `key(4)` (K) and `sequence(4)` (S), then the inner packet.
 *  • `protocolType` is in the ethertype space (0x0800 IPv4, 0x86dd IPv6) and selects the next layer; the registry
 *    fills it from the inner layer (`LINK_FIELDS.gre`) when a builder omits it.
 *  • The tunnels of P3a send the 4-byte header only (no keepalives, keys or sequence numbers, D17). The optional
 *    words are still decoded, and encoded when their bit is set: the checksum is the IP one's-complement sum over the
 *    GRE header and payload (RFC 2784 §2.5), the key and sequence words are written as zero (no field carries them).
 *  • The layer covers the rest of the IP payload; there is no trailer.
 */
import type { Codec, DecodedLayer, FieldValue } from '../../contracts/pdu.js';
import { internetChecksum, numField, readU16, writeU16 } from '../checksum.js';
import { nextProto } from './dispatch.js';

/** Length of the base GRE header. */
export const GRE_BASE_HEADER = 4;

const FLAG_C = 0x80;
const FLAG_K = 0x20;
const FLAG_S = 0x10;

function hex16(v: number): string {
  return `0x${v.toString(16).padStart(4, '0')}`;
}

function bool(fields: Readonly<Record<string, FieldValue>>, key: string): boolean {
  const v = fields[key];
  if (v === undefined || v === null) return false;
  if (typeof v === 'boolean') return v;
  if (v === 0 || v === 1) return v === 1;
  throw new Error(`gre.${key} must be a boolean`);
}

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  if (avail < GRE_BASE_HEADER) return { fields, fieldRanges, headerLength: avail, length: avail, error: 'GRE header truncated' };
  const b0 = bytes[offset]!;
  fields.checksumPresent = (b0 & FLAG_C) !== 0;
  fields.keyPresent = (b0 & FLAG_K) !== 0;
  fields.seqPresent = (b0 & FLAG_S) !== 0;
  fields.version = bytes[offset + 1]! & 0x07;
  fields.protocolType = readU16(bytes, offset + 2);
  fieldRanges.checksumPresent = [offset, 1];
  fieldRanges.keyPresent = [offset, 1];
  fieldRanges.seqPresent = [offset, 1];
  fieldRanges.version = [offset + 1, 1];
  fieldRanges.protocolType = [offset + 2, 2];
  const hdr = GRE_BASE_HEADER + (fields.checksumPresent ? 4 : 0) + (fields.keyPresent ? 4 : 0) + (fields.seqPresent ? 4 : 0);
  if (avail < hdr) return { fields, fieldRanges, headerLength: avail, length: avail, error: 'GRE optional fields truncated' };
  const out: DecodedLayer = { fields, fieldRanges, headerLength: hdr, length: avail };
  if (fields.version !== 0) out.error = `GRE version ${fields.version} is not simulated`;
  if (avail > hdr) out.next = { proto: nextProto('ethertype', fields.protocolType), offset: offset + hdr, length: avail - hdr };
  return out;
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'gre';
  const c = bool(fields, 'checksumPresent');
  const k = bool(fields, 'keyPresent');
  const s = bool(fields, 'seqPresent');
  const version = numField(p, fields, 'version', 0);
  if (version < 0 || version > 7) throw new Error(`gre.version out of range: ${version}`);
  const protocolType = numField(p, fields, 'protocolType', null);
  if (protocolType < 0 || protocolType > 0xffff) throw new Error(`gre.protocolType out of range: ${protocolType}`);
  const hdr = GRE_BASE_HEADER + (c ? 4 : 0) + (k ? 4 : 0) + (s ? 4 : 0);
  const out = new Uint8Array(hdr + payload.length);
  out[0] = (c ? FLAG_C : 0) | (k ? FLAG_K : 0) | (s ? FLAG_S : 0);
  out[1] = version;
  writeU16(out, 2, protocolType);
  out.set(payload, hdr);
  if (c) writeU16(out, GRE_BASE_HEADER, internetChecksum(out, 0, out.length));
  return out;
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const type = typeof fields.protocolType === 'number' ? hex16(fields.protocolType) : '?';
  return `GRE protocol ${type}`;
}

/** GRE codec [S18]. Required on encode: `protocolType` (the registry fills it from the inner layer). */
export const greCodec: Codec = {
  proto: 'gre',
  defaults: Object.freeze({ checksumPresent: false, keyPresent: false, seqPresent: false, version: 0, protocolType: null }),
  decode,
  encode,
  summarize,
};
