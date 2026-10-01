/**
 * EIGRP codec [C1] (RFC 7868, classic TLVs; ARCHITECTURE-P3 D26, §2.16, §3.12; contracts/fields.ts `eigrp`). IP
 * protocol 88; hellos to 224.0.0.10. The wire format is published, so the bytes are the RFC's (D23).
 *
 * Wire image (big-endian): header (20) `version(1)=2 opcode(1) checksum(2) flags(4) seq(4) ack(4) vrid(2) as(2)`, then
 * TLVs `type(2) length(2) value`, the length covering the whole TLV:
 *   0x0001 parameters (12)  — `k1 k2 k3 k4 k5 (1 each) reserved(1) holdTime(2)`: `kValues` 'k1,k2,k3,k4,k5' and `holdS`
 *   0x0102 IPv4 internal route (25 + n) — `nextHop(4) delay(4) bandwidth(4) mtu(3) hops(1) reliability(1) load(1)
 *          tag(1)=0 flags(1)=0 prefixLength(1) destination(n = ceil(prefixLength / 8))`, one per `routes` entry
 *  • `routes` holds 'prefix/len,delayUs,bwKbps,mtu,hops,rel,load,nextHop' entries joined by ';'. On the wire the delay
 *    is the RFC's scaled value floor(delayUs / 10) × 256 (0xffffffff for 'inf', an unreachable route) and the bandwidth
 *    floor(10⁷ / bwKbps) × 256 (0 for 0 kb/s); decode inverts both: delayUs = floor(delay / 256) × 10 and bwKbps =
 *    floor(10⁷ / floor(bandwidth / 256)). A bandwidth read back may differ from the one sent (7000 kb/s reads 7002),
 *    but floor(10⁷ / bwKbps) — the only thing the metric uses (D26) — is exactly the sender's, and re-encoding
 *    writes the same bytes.
 *  • `checksum` is the IP one's-complement sum over the packet (derived). The parameter TLV is written when `kValues`
 *    is given (with `holdS`); an acknowledgement is a hello with `ack` set and no TLV. Other TLVs (software version,
 *    sequence, external routes) are skipped on decode.
 *  • `stopsMeaning`: summary() and topProto() stop here.
 */
import type { Codec, DecodedLayer, FieldValue, MutationReason } from '../../contracts/pdu.js';
import { bytesToIpv4, ipv4ToBytes, isIpv4 } from '../../contracts/addr.js';
import { finishChecksum, numField, onesSum, readU16, readU32, strField, writeU16, writeU32 } from '../checksum.js';

/** EIGRP opcodes (the `eigrp.opcode` field). */
export const EIGRP_OPCODE = Object.freeze({ update: 1, query: 3, reply: 4, hello: 5, siaQuery: 10, siaReply: 11 });
/** EIGRP header flag bits (the `eigrp.flags` field). */
export const EIGRP_FLAG = Object.freeze({ init: 1, cr: 2, rs: 4, eot: 8 });
/** TLV types used. */
export const EIGRP_TLV = Object.freeze({ parameters: 0x0001, ipv4Internal: 0x0102 });
/** EIGRP header length. */
export const EIGRP_HEADER_BYTES = 20;
/** The scaled delay of an unreachable route. */
export const EIGRP_WIRE_DELAY_INFINITE = 0xffffffff;

const PARAM_TLV_BYTES = 12;
const ROUTE_TLV_FIXED = 25;
const TLV_HEADER = 4;
const BW_NUMERATOR = 10_000_000;
const SCALE = 256;

const OPCODE_TEXT: Readonly<Record<number, string>> = Object.freeze({
  1: 'update',
  3: 'query',
  4: 'reply',
  5: 'hello',
  10: 'SIA query',
  11: 'SIA reply',
});

/** Name of an opcode ('update', 'hello', …), or 'opcode <n>'. */
export function eigrpOpcodeText(opcode: number): string {
  return OPCODE_TEXT[opcode] ?? `opcode ${opcode}`;
}

/** The scaled wire delay of a delay in µs ('inf' or a number). */
export function eigrpWireDelay(delayUs: number | 'inf'): number {
  if (delayUs === 'inf') return EIGRP_WIRE_DELAY_INFINITE;
  if (!Number.isInteger(delayUs) || delayUs < 0) throw new Error(`eigrp route delay must be a whole number of µs, got ${delayUs}`);
  const scaled = Math.floor(delayUs / 10) * SCALE;
  if (scaled >= EIGRP_WIRE_DELAY_INFINITE) throw new Error(`eigrp route delay too large: ${delayUs} µs`);
  return scaled;
}

/** The scaled wire bandwidth of a bandwidth in kb/s (0 → 0). */
export function eigrpWireBandwidth(bwKbps: number): number {
  if (!Number.isInteger(bwKbps) || bwKbps < 0 || bwKbps > BW_NUMERATOR) throw new Error(`eigrp route bandwidth must be 0 to 10000000 kb/s, got ${bwKbps}`);
  return bwKbps === 0 ? 0 : Math.floor(BW_NUMERATOR / bwKbps) * SCALE;
}

function prefixBytes(len: number): number {
  return Math.ceil(len / 8);
}

function decodeRoute(bytes: Uint8Array, v: number, len: number): string | undefined {
  if (len < ROUTE_TLV_FIXED) return undefined;
  const nextHop = bytesToIpv4(bytes, v);
  const delay = readU32(bytes, v + 4);
  const bw = readU32(bytes, v + 8);
  const mtu = (bytes[v + 12]! << 16) | (bytes[v + 13]! << 8) | bytes[v + 14]!;
  const hops = bytes[v + 15]!;
  const rel = bytes[v + 16]!;
  const load = bytes[v + 17]!;
  const plen = bytes[v + 20]!;
  if (plen > 32 || ROUTE_TLV_FIXED + prefixBytes(plen) > len) return undefined;
  const dest = new Uint8Array(4);
  dest.set(bytes.subarray(v + 21, v + 21 + prefixBytes(plen)));
  const inv = Math.floor(bw / SCALE);
  const bwKbps = inv === 0 ? 0 : Math.floor(BW_NUMERATOR / inv);
  const delayText = delay === EIGRP_WIRE_DELAY_INFINITE ? 'inf' : String(Math.floor(delay / SCALE) * 10);
  return `${bytesToIpv4(dest, 0)}/${plen},${delayText},${bwKbps},${mtu},${hops},${rel},${load},${nextHop}`;
}

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  const o = offset;
  if (avail < EIGRP_HEADER_BYTES) {
    if (avail >= 1) {
      fields.version = bytes[o]!;
      fieldRanges.version = [o, 1];
    }
    if (avail >= 2) {
      fields.opcode = bytes[o + 1]!;
      fieldRanges.opcode = [o + 1, 1];
    }
    return { fields, fieldRanges, headerLength: avail, length: avail, error: 'EIGRP header truncated' };
  }
  fields.version = bytes[o]!;
  fields.opcode = bytes[o + 1]!;
  fields.checksum = readU16(bytes, o + 2);
  fields.checksumValid = finishChecksum(onesSum(bytes, o, avail)) === 0;
  fields.flags = readU32(bytes, o + 4);
  fields.seq = readU32(bytes, o + 8);
  fields.ack = readU32(bytes, o + 12);
  fields.vrid = readU16(bytes, o + 16);
  fields.as = readU16(bytes, o + 18);
  fieldRanges.version = [o, 1];
  fieldRanges.opcode = [o + 1, 1];
  fieldRanges.checksum = [o + 2, 2];
  fieldRanges.flags = [o + 4, 4];
  fieldRanges.seq = [o + 8, 4];
  fieldRanges.ack = [o + 12, 4];
  fieldRanges.vrid = [o + 16, 2];
  fieldRanges.as = [o + 18, 2];
  const end = o + avail;
  let i = o + EIGRP_HEADER_BYTES;
  let error: string | undefined;
  const routes: string[] = [];
  let routeStart = -1;
  let routeEnd = -1;
  while (i < end) {
    if (i + TLV_HEADER > end) {
      error = 'EIGRP TLV truncated';
      break;
    }
    const type = readU16(bytes, i);
    const len = readU16(bytes, i + 2);
    if (len < TLV_HEADER || i + len > end) {
      error = `EIGRP TLV 0x${type.toString(16).padStart(4, '0')} has a bad length ${len}`;
      break;
    }
    const v = i + TLV_HEADER;
    if (type === EIGRP_TLV.parameters && len >= PARAM_TLV_BYTES) {
      fields.kValues = [0, 1, 2, 3, 4].map((k) => bytes[v + k]!).join(',');
      fields.holdS = readU16(bytes, v + 6);
      fieldRanges.kValues = [v, 5];
      fieldRanges.holdS = [v + 6, 2];
    } else if (type === EIGRP_TLV.ipv4Internal) {
      const r = decodeRoute(bytes, v, len);
      if (r === undefined) {
        if (error === undefined) error = 'EIGRP internal route TLV malformed';
      } else {
        routes.push(r);
        if (routeStart < 0) routeStart = i;
        routeEnd = i + len;
      }
    }
    i += len;
  }
  if (routes.length > 0) {
    fields.routes = routes.join(';');
    fieldRanges.routes = [routeStart, routeEnd - routeStart];
  }
  const out: DecodedLayer = { fields, fieldRanges, headerLength: avail, length: avail };
  if (error !== undefined) out.error = error;
  else if (fields.version !== 2) out.error = `EIGRP version ${fields.version} is not simulated`;
  return out;
}

function u(fields: Readonly<Record<string, FieldValue>>, key: string, bits: number, dflt: number | null): number {
  const v = numField('eigrp', fields, key, dflt);
  const max = bits === 32 ? 0xffffffff : (1 << bits) - 1;
  if (v < 0 || v > max) throw new Error(`eigrp.${key} out of range: ${v}`);
  return v;
}

function intPart(entry: string, text: string, max: number): number {
  const n = Number(text);
  if (text.trim() === '' || !Number.isInteger(n) || n < 0 || n > max) throw new Error(`eigrp.routes entry "${entry}" has a bad value "${text}"`);
  return n;
}

function encodeRoute(entry: string): number[] {
  const parts = entry.split(',').map((s) => s.trim());
  if (parts.length !== 8) throw new Error(`eigrp.routes entry must be 'prefix/len,delayUs,bwKbps,mtu,hops,rel,load,nextHop', got "${entry}"`);
  const [prefix, lenText] = parts[0]!.split('/');
  const plen = intPart(entry, lenText ?? '', 32);
  if (prefix === undefined || !isIpv4(prefix)) throw new Error(`eigrp.routes entry "${entry}" has a bad prefix`);
  const delay = eigrpWireDelay(parts[1] === 'inf' ? 'inf' : intPart(entry, parts[1]!, 0xffffffff));
  const bw = eigrpWireBandwidth(intPart(entry, parts[2]!, BW_NUMERATOR));
  const mtu = intPart(entry, parts[3]!, 0xffffff);
  const hops = intPart(entry, parts[4]!, 0xff);
  const rel = intPart(entry, parts[5]!, 0xff);
  const load = intPart(entry, parts[6]!, 0xff);
  if (!isIpv4(parts[7]!)) throw new Error(`eigrp.routes entry "${entry}" has a bad next hop`);
  const n = prefixBytes(plen);
  const tlv = new Uint8Array(ROUTE_TLV_FIXED + n);
  writeU16(tlv, 0, EIGRP_TLV.ipv4Internal);
  writeU16(tlv, 2, tlv.length);
  tlv.set(ipv4ToBytes(parts[7]!), 4);
  writeU32(tlv, 8, delay);
  writeU32(tlv, 12, bw);
  tlv[16] = (mtu >>> 16) & 0xff;
  tlv[17] = (mtu >>> 8) & 0xff;
  tlv[18] = mtu & 0xff;
  tlv[19] = hops;
  tlv[20] = rel;
  tlv[21] = load;
  // tag (22) and flags (23) stay 0
  tlv[24] = plen;
  tlv.set(ipv4ToBytes(prefix).subarray(0, n), 25);
  return Array.from(tlv);
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'eigrp';
  if (payload.length > 0) throw new Error('eigrp: an EIGRP packet carries no inner layer');
  const tlvs: number[] = [];
  const hasK = fields.kValues !== undefined && fields.kValues !== null;
  const hasHold = fields.holdS !== undefined && fields.holdS !== null;
  if (hasK !== hasHold) throw new Error('eigrp: the parameter TLV needs both kValues and holdS');
  if (hasK) {
    const ks = strField(p, fields, 'kValues', null).split(',').map((s) => Number(s.trim()));
    if (ks.length !== 5 || ks.some((k) => !Number.isInteger(k) || k < 0 || k > 0xff)) {
      throw new Error(`eigrp.kValues must be five numbers 'k1,k2,k3,k4,k5' of 0–255, got "${String(fields.kValues)}"`);
    }
    const hold = u(fields, 'holdS', 16, null);
    tlvs.push(0x00, 0x01, 0x00, PARAM_TLV_BYTES, ...ks, 0, (hold >>> 8) & 0xff, hold & 0xff);
  }
  const routes = strField(p, fields, 'routes', '');
  for (const entry of routes.split(';')) if (entry.trim() !== '') tlvs.push(...encodeRoute(entry));
  const out = new Uint8Array(EIGRP_HEADER_BYTES + tlvs.length);
  out[0] = u(fields, 'version', 8, 2);
  out[1] = u(fields, 'opcode', 8, null);
  writeU32(out, 4, u(fields, 'flags', 32, 0));
  writeU32(out, 8, u(fields, 'seq', 32, 0));
  writeU32(out, 12, u(fields, 'ack', 32, 0));
  writeU16(out, 16, u(fields, 'vrid', 16, 0));
  writeU16(out, 18, u(fields, 'as', 16, null));
  out.set(tlvs, EIGRP_HEADER_BYTES);
  writeU16(out, 2, finishChecksum(onesSum(out, 0, out.length)));
  return out;
}

function flagsText(flags: number): string {
  const out: string[] = [];
  if (flags & EIGRP_FLAG.init) out.push('init');
  if (flags & EIGRP_FLAG.cr) out.push('CR');
  if (flags & EIGRP_FLAG.rs) out.push('RS');
  if (flags & EIGRP_FLAG.eot) out.push('EOT');
  return out.join(' ');
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const opcode = typeof fields.opcode === 'number' ? fields.opcode : -1;
  const as = `AS ${String(fields.as ?? '?')}`;
  const routes = typeof fields.routes === 'string' && fields.routes !== '' ? fields.routes.split(';').length : 0;
  if (opcode === EIGRP_OPCODE.hello) {
    if (fields.kValues === undefined && typeof fields.ack === 'number' && fields.ack !== 0) return `EIGRP acknowledgement ${as}, ack ${fields.ack}`;
    const hold = typeof fields.holdS === 'number' ? `, hold ${fields.holdS} s` : '';
    return `EIGRP hello ${as}${hold}`;
  }
  const flags = typeof fields.flags === 'number' && fields.flags !== 0 ? `, flags ${flagsText(fields.flags)}` : '';
  const count = `, ${routes} ${routes === 1 ? 'route' : 'routes'}`;
  return `EIGRP ${eigrpOpcodeText(opcode)} ${as}, seq ${String(fields.seq ?? '?')} ack ${String(fields.ack ?? '?')}${flags}${count}`;
}

const DERIVED: Readonly<Record<string, MutationReason>> = Object.freeze({ checksum: 'ChecksumRecompute' });

/** EIGRP codec [C1]. Required on encode: `opcode`, `as`. */
export const eigrpCodec: Codec = {
  proto: 'eigrp',
  defaults: Object.freeze({ version: 2, opcode: null, flags: 0, seq: 0, ack: 0, vrid: 0, as: null }),
  decode,
  encode,
  summarize,
  derived: DERIVED,
  stopsMeaning: () => true,
};
