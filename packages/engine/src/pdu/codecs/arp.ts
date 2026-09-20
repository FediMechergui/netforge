/**
 * ARP codec (RFC 826) — spec §4.5, §2.1 "ARP".
 *
 * Wire image (Ethernet/IPv4 flavour, 28 bytes):
 *   htype(2) ptype(2) hlen(1) plen(1) op(2) sha(hlen) spa(plen) tha(hlen) tpa(plen)
 * Fields per the canonical table: htype, ptype, hlen, plen, op, sha, spa, tha, tpa.
 * The layout is derived from hlen/plen so odd sizes still decode (addresses are then
 * rendered as plain hex); the normal 6/4 case yields canonical MAC / dotted IPv4 strings.
 * `length` is `min(headerLength, bound)` so Ethernet padding is never attributed to ARP.
 * There is no next layer: ARP is always innermost.
 */
import type { Codec, DecodedLayer, FieldValue } from '../../contracts/pdu.js';
import { ARP_OP_REPLY, ARP_OP_REQUEST, ETHERTYPE_IPV4 } from '../../contracts/pdu.js';
import {
  bytesToIpv4,
  bytesToMac,
  ipv4ToBytes,
  macToBytes,
  MAC_ZERO,
} from '../../contracts/addr.js';
import { numField, readU16, strField, writeU16 } from '../checksum.js';

const FIXED = 8; // bytes before the addresses

function hex(b: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += b[off + i]!.toString(16).padStart(2, '0');
  return s;
}

function hwToString(b: Uint8Array, off: number, len: number): string {
  return len === 6 ? bytesToMac(b, off) : hex(b, off, len);
}

function protoToString(b: Uint8Array, off: number, len: number): string {
  return len === 4 ? bytesToIpv4(b, off) : hex(b, off, len);
}

function hwToBytes(proto: string, key: string, s: string, len: number): Uint8Array {
  if (len === 6) return macToBytes(s);
  const clean = s.replace(/[^0-9a-f]/gi, '');
  if (clean.length !== len * 2) throw new Error(`${proto}.${key}: expected ${len} bytes of hex`);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function protoToBytes(proto: string, key: string, s: string, len: number): Uint8Array {
  if (len === 4) return ipv4ToBytes(s);
  return hwToBytes(proto, key, s, len);
}

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};

  if (avail < FIXED) {
    return { fields, fieldRanges, headerLength: avail, length: avail, error: 'ARP header truncated' };
  }
  const htype = readU16(bytes, offset);
  const ptype = readU16(bytes, offset + 2);
  const hlen = bytes[offset + 4]!;
  const plen = bytes[offset + 5]!;
  const op = readU16(bytes, offset + 6);
  fields.htype = htype;
  fields.ptype = ptype;
  fields.hlen = hlen;
  fields.plen = plen;
  fields.op = op;
  fieldRanges.htype = [offset, 2];
  fieldRanges.ptype = [offset + 2, 2];
  fieldRanges.hlen = [offset + 4, 1];
  fieldRanges.plen = [offset + 5, 1];
  fieldRanges.op = [offset + 6, 2];

  const headerLength = FIXED + 2 * hlen + 2 * plen;
  let error: string | undefined;
  if (avail < headerLength) error = 'ARP header truncated';

  let off = offset + FIXED;
  const addr = (key: string, len: number, conv: (b: Uint8Array, o: number, l: number) => string): void => {
    if (off + len <= offset + avail) {
      fields[key] = conv(bytes, off, len);
      fieldRanges[key] = [off, len];
    }
    off += len;
  };
  addr('sha', hlen, hwToString);
  addr('spa', plen, protoToString);
  addr('tha', hlen, hwToString);
  addr('tpa', plen, protoToString);

  const out: DecodedLayer = { fields, fieldRanges, headerLength, length: Math.min(headerLength, avail) };
  if (error) out.error = error;
  return out;
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'arp';
  const htype = numField(p, fields, 'htype', 1);
  const ptype = numField(p, fields, 'ptype', ETHERTYPE_IPV4);
  const hlen = numField(p, fields, 'hlen', 6);
  const plen = numField(p, fields, 'plen', 4);
  const op = numField(p, fields, 'op', ARP_OP_REQUEST);
  const zeroProto = plen === 4 ? '0.0.0.0' : '00'.repeat(plen);
  const zeroHw = hlen === 6 ? MAC_ZERO : '00'.repeat(hlen);
  const sha = hwToBytes(p, 'sha', strField(p, fields, 'sha', zeroHw), hlen);
  const spa = protoToBytes(p, 'spa', strField(p, fields, 'spa', zeroProto), plen);
  const tha = hwToBytes(p, 'tha', strField(p, fields, 'tha', zeroHw), hlen);
  const tpa = protoToBytes(p, 'tpa', strField(p, fields, 'tpa', zeroProto), plen);

  const headerLength = FIXED + 2 * hlen + 2 * plen;
  const out = new Uint8Array(headerLength + payload.length);
  writeU16(out, 0, htype);
  writeU16(out, 2, ptype);
  out[4] = hlen;
  out[5] = plen;
  writeU16(out, 6, op);
  let off = FIXED;
  out.set(sha, off);
  off += hlen;
  out.set(spa, off);
  off += plen;
  out.set(tha, off);
  off += hlen;
  out.set(tpa, off);
  off += plen;
  out.set(payload, off);
  return out;
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  switch (fields.op) {
    case ARP_OP_REQUEST:
      return `ARP request who-has ${String(fields.tpa ?? '?')} tell ${String(fields.spa ?? '?')}`;
    case ARP_OP_REPLY:
      return `ARP reply ${String(fields.spa ?? '?')} is-at ${String(fields.sha ?? '?')}`;
    default:
      return `ARP op=${String(fields.op ?? '?')} ${String(fields.spa ?? '?')} > ${String(fields.tpa ?? '?')}`;
  }
}

/** ARP codec. All fields have defaults (a zeroed request), but real senders set op/sha/spa/tha/tpa. */
export const arpCodec: Codec = {
  proto: 'arp',
  defaults: Object.freeze({
    htype: 1,
    ptype: ETHERTYPE_IPV4,
    hlen: 6,
    plen: 4,
    op: ARP_OP_REQUEST,
    sha: MAC_ZERO,
    spa: '0.0.0.0',
    tha: MAC_ZERO,
    tpa: '0.0.0.0',
  }),
  decode,
  encode,
  summarize,
};
