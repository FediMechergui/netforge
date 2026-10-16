/**
 * OSPFv3 codecs (RFC 5340 Appendix A; ARCHITECTURE-P3C §2.3, §3.3, D7 of P3a as revised by [S6]: a separate codec, not
 * `ospf` version 3; contracts/fields.ts `ospf6`, `ospf6-lsa`). Reached through IPv6 next header 89 (the `ipv6.nh`
 * dispatch space, pdu/codecs/dispatch.ts `nextIpv6Proto`; IPv4 protocol 89 stays `ospf`). An IETF protocol, so the
 * bytes are the RFC's.
 *
 * `ospf6` — the packet header and the fixed part of each packet type:
 *   header (16): `version(1)=3 type(1) length(2) routerId(4) areaId(4) checksum(2) instanceId(1) 0(1)`
 *   1 hello:  `interfaceId(4) priority(1) options(3) helloInterval(2) deadInterval(2) dr(4) bdr(4) neighbor(4)*`
 *   2 DBD:    `0(1) options(3) mtu(2) 0(1) flags(1) ddSeq(4)` then LSA headers (each its own `ospf6-lsa` layer)
 *   3 LSR:    `(0(2) lsType(2) lsId(4) advRouter(4))*` — the flat string `requests` ('<type>:<lsId>:<adv>', the type in
 *             decimal, joined by ';')
 *   4 LSU:    `count(4)` then full LSAs (each its own `ospf6-lsa` layer)
 *   5 LSAck:  LSA headers (each its own `ospf6-lsa` layer)
 *  • `checksum` is the IPv6 upper-layer checksum (RFC 5340 A.3.1, RFC 8200 §8.1): the pseudo-header of the NEAREST
 *    enclosing ipv6 layer with next header 89 and the packet length, then the packet. It is derived; with no enclosing
 *    IPv6 header the encoder writes 0 and the decoder leaves `checksumValid` unset (`outerInputs` lists ipv6.src/dst so
 *    a mutate of an address re-encodes it). `length` and, in an LSU, `count` are derived. OSPFv3 has no
 *    authentication field (IPsec is P4).
 *  • `dr`, `bdr` and `neighbors` are ROUTER IDS (RFC 5340 A.3.2), unlike OSPFv2's interface addresses.
 *  • `stopsMeaning`: summary() and topProto() stop here.
 *
 * `ospf6-lsa` — one LSA (in an LSU) or one LSA header copy (in a DBD or an LSAck), chained one after the other exactly
 * as `ospf-lsa` (its `headerLength` is its own bytes, its `length` runs to the end of the packet):
 *   header (20): `age(2) lsType(2) lsId(4) advRouter(4) seq(4) checksum(2) length(2)`
 *   0x2001 router:            `flags(1: Nt 0x10, V 4, E 2, B 1) options(3)` then links
 *                             `(type(1) 0(1) metric(2) ifaceId(4) nbrIfaceId(4) nbrRouterId(4))*`
 *   0x2002 network:           `0(1) options(3) attached(4)*`
 *   0x2003 inter-area-prefix: `0(1) metric(3) prefix`
 *   0x2004 inter-area-router: `0(1) options(3) 0(1) metric(3) destRouterId(4)`
 *   0x4005 AS-external:       `flags(1: E 4, F 2, T 1) metric(3) prefixLen(1) prefixOptions(1) refType(2) address`
 *                             `[forward(16) if F] [tag(4) if T] [refLsId(4) if refType ≠ 0]`
 *   0x0008 link:              `priority(1) options(3) linkLocal(16) count(4)` then prefixes
 *   0x2009 intra-area-prefix: `count(2) refType(2) refLsId(4) refAdvRouter(4)` then prefixes with metrics
 *   where a prefix is `prefixLen(1) prefixOptions(1) metric-or-0(2) address(⌈len/32⌉·4)` (RFC 5340 A.4.1; the bits
 *   after the prefix length are written as zero) and the inter-area-prefix and external forms carry their metric at
 *   the LSA level.
 *  • Lists are flat strings: `links` '<kind>,<metric>,<ifaceId>,<nbrIfaceId>,<nbrRouterId>' joined by ';' (kinds p2p,
 *    transit, virtual; an unknown kind decodes as its number); `attached` router ids joined by ','; `prefixes`
 *    '<prefix>/<len>' joined by ';', each followed by ',<metric>' in an intra-area-prefix LSA. Prefix option bits are
 *    written as zero and not decoded.
 *  • The checksum is OSPFv2's Fletcher over the LSA without its age (RFC 5340 A.4.2 keeps RFC 2328 §12.1.7), and a
 *    header copy carries the full LSA's `checksum` and `length` (both required on encode), exactly as `ospf-lsa`.
 *    `headerOnly` and `checksumValid` (full LSAs only) are decode-only. A type without a body codec decodes its header
 *    only and refuses to encode.
 */
import type { Codec, CodecContext, DecodedLayer, FieldValue, MutationReason, ProtoName } from '../../contracts/pdu.js';
import { bytesToIpv4, ipv4ToBytes, isIpv4 } from '../../contracts/addr.js';
import { bytesToIpv6, ipv6ToBytes } from '../../core/addr6.js';
import {
  finishChecksum,
  numField,
  onesSum,
  ospfLsaFletcher,
  ospfLsaFletcherValid,
  readU16,
  readU32,
  strField,
  writeU16,
  writeU32,
} from '../checksum.js';
import { nearestIpLayer, pseudoHeaderSumFor } from './udp.js';

/** OSPFv3 next header (the `ipv6.nh` dispatch key). */
export const IPV6_NH_OSPF6 = 89;
/** OSPFv3 packet types (the `ospf6.type` field). */
export const OSPF6_PACKET = Object.freeze({ hello: 1, dbd: 2, lsr: 3, lsu: 4, lsack: 5 });
/** Function-coded LSA types (the `ospf6-lsa.lsType` field). */
export const OSPF6_LSA_KIND = Object.freeze({
  router: 0x2001,
  network: 0x2002,
  interAreaPrefix: 0x2003,
  interAreaRouter: 0x2004,
  external: 0x4005,
  link: 0x0008,
  intraAreaPrefix: 0x2009,
});
/** Option bits (hello, DBD and the LSA bodies). */
export const OSPF6_OPTION = Object.freeze({ V6: 0x01, E: 0x02, N: 0x08, R: 0x10, DC: 0x20 });
/** Default options: V6, E and R (a router that forwards IPv6 and accepts external routes). */
export const OSPF6_DEFAULT_OPTIONS = 0x13;
/** Router-LSA flag bits (the `ospf6-lsa.flags` field of a router LSA). */
export const OSPF6_ROUTER_FLAG = Object.freeze({ Nt: 0x10, V: 4, E: 2, B: 1 });
/** AS-external flag bits (inside the external body; `e2`, the forwarding address and the tag set them). */
const EXT_FLAG = Object.freeze({ E: 4, F: 2, T: 1 });
/** OSPFv3 packet header length. */
export const OSPF6_HEADER_BYTES = 16;
/** LSA header length. */
export const OSPF6_LSA_HEADER_BYTES = 20;

const HELLO_FIXED = 20;
const DBD_FIXED = 12;
const LSR_ENTRY = 12;
const LSU_FIXED = 4;
const ROUTER_FIXED = 4;
const ROUTER_LINK = 16;
const INITIAL_LSA_SEQ = 0x80000001;

const PACKET_TEXT: Readonly<Record<number, string>> = Object.freeze({
  1: 'hello',
  2: 'database description',
  3: 'link-state request',
  4: 'link-state update',
  5: 'link-state acknowledgement',
});
const LSA_TEXT: Readonly<Record<number, string>> = Object.freeze({
  0x2001: 'router',
  0x2002: 'network',
  0x2003: 'inter-area-prefix',
  0x2004: 'inter-area-router',
  0x4005: 'AS-external',
  0x0008: 'link',
  0x2009: 'intra-area-prefix',
});
const LINK_KIND: Readonly<Record<string, number>> = Object.freeze({ p2p: 1, transit: 2, virtual: 4 });
const LINK_KIND_TEXT: Readonly<Record<number, string>> = Object.freeze({ 1: 'p2p', 2: 'transit', 4: 'virtual' });

/** Name of an OSPFv3 packet type ('hello', 'database description', …), or 'type <n>'. */
export function ospf6PacketText(type: number): string {
  return PACKET_TEXT[type] ?? `type ${type}`;
}

/** Name of a function-coded LSA type ('router', 'intra-area-prefix', …), or 'type 0x<hex>'. */
export function ospf6LsaText(type: number): string {
  return LSA_TEXT[type] ?? `type 0x${type.toString(16).padStart(4, '0')}`;
}

// ── shared helpers ───────────────────────────────────────────────────────────

function ipField(proto: string, fields: Readonly<Record<string, FieldValue>>, key: string, dflt: string | null): Uint8Array {
  const s = strField(proto, fields, key, dflt);
  if (!isIpv4(s)) throw new Error(`${proto}.${key} is not an IPv4 address: "${s}"`);
  return ipv4ToBytes(s);
}

function ip6Bytes(proto: string, key: string, value: string): Uint8Array {
  try {
    return ipv6ToBytes(value);
  } catch {
    throw new Error(`${proto}.${key} is not a valid IPv6 address: "${value}"`);
  }
}

function uint(proto: string, fields: Readonly<Record<string, FieldValue>>, key: string, bits: number, dflt: number | null): number {
  const v = numField(proto, fields, key, dflt);
  const max = bits === 32 ? 0xffffffff : (1 << bits) - 1;
  if (v < 0 || v > max) throw new Error(`${proto}.${key} out of range: ${v}`);
  return v;
}

function has(fields: Readonly<Record<string, FieldValue>>, key: string): boolean {
  return fields[key] !== undefined && fields[key] !== null;
}

function readU24(b: Uint8Array, off: number): number {
  return (b[off]! << 16) | (b[off + 1]! << 8) | b[off + 2]!;
}

function writeU24(b: Uint8Array, off: number, v: number): void {
  b[off] = (v >>> 16) & 0xff;
  b[off + 1] = (v >>> 8) & 0xff;
  b[off + 2] = v & 0xff;
}

function idList(proto: string, key: string, text: string): Uint8Array[] {
  if (text.trim() === '') return [];
  return text.split(',').map((s) => {
    const a = s.trim();
    if (!isIpv4(a)) throw new Error(`${proto}.${key} holds a value that is not a router id: "${a}"`);
    return ipv4ToBytes(a);
  });
}

/** The `type` of the nearest enclosing `ospf6` layer, or undefined. */
function enclosingType(ctx: CodecContext | undefined): number | undefined {
  const outer = ctx?.outer;
  if (!outer) return undefined;
  for (let i = outer.length - 1; i >= 0; i--) {
    const o = outer[i]!;
    if (o.proto === 'ospf6') return typeof o.fields.type === 'number' ? o.fields.type : undefined;
  }
  return undefined;
}

function isHeaderCopy(ctx: CodecContext | undefined): boolean {
  const t = enclosingType(ctx);
  return t === OSPF6_PACKET.dbd || t === OSPF6_PACKET.lsack;
}

/** Number of LSAs chained in `payload` (each LSA's length at its header offset 18). */
function countLsas(payload: Uint8Array): number {
  let n = 0;
  let pos = 0;
  while (pos + OSPF6_LSA_HEADER_BYTES <= payload.length) {
    const len = readU16(payload, pos + 18);
    if (len < OSPF6_LSA_HEADER_BYTES) break;
    n++;
    pos += len;
  }
  return n;
}

/** The next layer after `used` bytes of a `bound`-byte LSA list: another LSA, trailing bytes as payload, or none. */
function nextAfter(offset: number, used: number, bound: number): DecodedLayer['next'] {
  const rest = bound - used;
  if (rest <= 0) return undefined;
  const proto: ProtoName = rest >= OSPF6_LSA_HEADER_BYTES ? 'ospf6-lsa' : 'payload';
  return { proto, offset: offset + used, length: rest };
}

// ── prefixes (RFC 5340 A.4.1) ────────────────────────────────────────────────

interface Prefix {
  readonly bytes: Uint8Array; // 16, host bits cleared
  readonly len: number;
  readonly metric: number;
}

/** Address octets a prefix of `len` bits occupies on the wire: ⌈len / 32⌉ · 4. */
function prefixWireBytes(len: number): number {
  return Math.ceil(len / 32) * 4;
}

function parsePrefixes(proto: string, text: string, withMetric: boolean): Prefix[] {
  if (text.trim() === '') return [];
  return text.split(';').map((entry) => {
    const parts = entry.split(',').map((x) => x.trim());
    const slash = parts[0]!.lastIndexOf('/');
    const len = slash < 0 ? NaN : Number(parts[0]!.slice(slash + 1));
    const metric = withMetric ? Number(parts[1]) : 0;
    if (slash < 0 || !Number.isInteger(len) || len < 0 || len > 128 || parts.length !== (withMetric ? 2 : 1)
      || !Number.isInteger(metric) || metric < 0 || metric > 0xffff) {
      throw new Error(`${proto}.prefixes entry must be '<prefix>/<len>${withMetric ? ',<metric>' : ''}', got "${entry}"`);
    }
    const full = ip6Bytes(proto, 'prefixes', parts[0]!.slice(0, slash));
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      const bits = Math.max(0, Math.min(8, len - i * 8));
      bytes[i] = full[i]! & ((0xff << (8 - bits)) & 0xff);
    }
    return { bytes, len, metric };
  });
}

/** Wire form of one prefix: `len(1) options(1)=0 metric(2) address`. */
function writePrefix(out: number[], p: Prefix, metric: number): void {
  out.push(p.len, 0, (metric >>> 8) & 0xff, metric & 0xff);
  for (let i = 0; i < prefixWireBytes(p.len); i++) out.push(p.bytes[i]!);
}

function prefixText(bytes: Uint8Array, at: number, len: number): string {
  const full = new Uint8Array(16);
  full.set(bytes.subarray(at, at + prefixWireBytes(len)));
  return `${bytesToIpv6(full, 0)}/${len}`;
}

/** Decodes `n` prefixes from `pos`; returns the entries and the end, or an error when one runs past `end`. */
function readPrefixes(bytes: Uint8Array, pos: number, end: number, n: number, withMetric: boolean): { text: string; pos: number; error?: string } {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    if (pos + 4 > end) return { text: out.join(';'), pos, error: 'OSPFv3 prefix runs past the LSA' };
    const len = bytes[pos]!;
    const metric = readU16(bytes, pos + 2);
    const size = len > 128 ? -1 : prefixWireBytes(len);
    if (size < 0 || pos + 4 + size > end) return { text: out.join(';'), pos, error: 'OSPFv3 prefix runs past the LSA' };
    out.push(withMetric ? `${prefixText(bytes, pos + 4, len)},${metric}` : prefixText(bytes, pos + 4, len));
    pos += 4 + size;
  }
  return { text: out.join(';'), pos };
}

// ── ospf6 ────────────────────────────────────────────────────────────────────

function decodeOspf6(bytes: Uint8Array, offset: number, length: number, ctx?: CodecContext): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  const o = offset;
  if (avail < OSPF6_HEADER_BYTES) {
    if (avail >= 1) {
      fields.version = bytes[o]!;
      fieldRanges.version = [o, 1];
    }
    if (avail >= 2) {
      fields.type = bytes[o + 1]!;
      fieldRanges.type = [o + 1, 1];
    }
    return { fields, fieldRanges, headerLength: avail, length: avail, error: 'OSPFv3 header truncated' };
  }
  fields.version = bytes[o]!;
  fields.type = bytes[o + 1]!;
  fields.length = readU16(bytes, o + 2);
  fields.routerId = bytesToIpv4(bytes, o + 4);
  fields.areaId = bytesToIpv4(bytes, o + 8);
  fields.checksum = readU16(bytes, o + 12);
  fields.instanceId = bytes[o + 14]!;
  fieldRanges.version = [o, 1];
  fieldRanges.type = [o + 1, 1];
  fieldRanges.length = [o + 2, 2];
  fieldRanges.routerId = [o + 4, 4];
  fieldRanges.areaId = [o + 8, 4];
  fieldRanges.checksum = [o + 12, 2];
  fieldRanges.instanceId = [o + 14, 1];

  const declared = fields.length;
  if (declared < OSPF6_HEADER_BYTES) {
    fields.checksumValid = false;
    return { fields, fieldRanges, headerLength: OSPF6_HEADER_BYTES, length: avail, error: `OSPFv3 length ${declared} is smaller than the header` };
  }
  const complete = declared <= avail;
  const len = complete ? declared : avail;
  if (complete) {
    const pseudo = nearestIpLayer(ctx)?.family === 6 ? pseudoHeaderSumFor(ctx, IPV6_NH_OSPF6, declared) : undefined;
    if (pseudo !== undefined) fields.checksumValid = finishChecksum(onesSum(bytes, o, declared, pseudo)) === 0;
  }
  const out: DecodedLayer = { fields, fieldRanges, headerLength: OSPF6_HEADER_BYTES, length: len };
  const truncated = (): DecodedLayer => ({ ...out, headerLength: len, error: `OSPFv3 ${ospf6PacketText(fields.type as number)} truncated` });
  const b = o + OSPF6_HEADER_BYTES;
  switch (fields.type) {
    case OSPF6_PACKET.hello: {
      if (len < OSPF6_HEADER_BYTES + HELLO_FIXED) return truncated();
      fields.interfaceId = readU32(bytes, b);
      fields.priority = bytes[b + 4]!;
      fields.options = readU24(bytes, b + 5);
      fields.helloInterval = readU16(bytes, b + 8);
      fields.deadInterval = readU16(bytes, b + 10);
      fields.dr = bytesToIpv4(bytes, b + 12);
      fields.bdr = bytesToIpv4(bytes, b + 16);
      fieldRanges.interfaceId = [b, 4];
      fieldRanges.priority = [b + 4, 1];
      fieldRanges.options = [b + 5, 3];
      fieldRanges.helloInterval = [b + 8, 2];
      fieldRanges.deadInterval = [b + 10, 2];
      fieldRanges.dr = [b + 12, 4];
      fieldRanges.bdr = [b + 16, 4];
      const n = Math.floor((len - OSPF6_HEADER_BYTES - HELLO_FIXED) / 4);
      const ids: string[] = [];
      for (let i = 0; i < n; i++) ids.push(bytesToIpv4(bytes, b + HELLO_FIXED + i * 4));
      fields.neighbors = ids.join(',');
      fieldRanges.neighbors = [b + HELLO_FIXED, n * 4];
      out.headerLength = len;
      break;
    }
    case OSPF6_PACKET.dbd: {
      if (len < OSPF6_HEADER_BYTES + DBD_FIXED) return truncated();
      fields.options = readU24(bytes, b + 1);
      fields.mtu = readU16(bytes, b + 4);
      fields.flags = bytes[b + 7]!;
      fields.ddSeq = readU32(bytes, b + 8);
      fieldRanges.options = [b + 1, 3];
      fieldRanges.mtu = [b + 4, 2];
      fieldRanges.flags = [b + 7, 1];
      fieldRanges.ddSeq = [b + 8, 4];
      out.headerLength = OSPF6_HEADER_BYTES + DBD_FIXED;
      const next = nextAfter(o, out.headerLength, len);
      if (next) out.next = next;
      break;
    }
    case OSPF6_PACKET.lsr: {
      const n = Math.floor((len - OSPF6_HEADER_BYTES) / LSR_ENTRY);
      const entries: string[] = [];
      for (let i = 0; i < n; i++) {
        const e = b + i * LSR_ENTRY;
        entries.push(`${readU16(bytes, e + 2)}:${bytesToIpv4(bytes, e + 4)}:${bytesToIpv4(bytes, e + 8)}`);
      }
      fields.requests = entries.join(';');
      fieldRanges.requests = [b, n * LSR_ENTRY];
      out.headerLength = len;
      break;
    }
    case OSPF6_PACKET.lsu: {
      if (len < OSPF6_HEADER_BYTES + LSU_FIXED) return truncated();
      fields.count = readU32(bytes, b);
      fieldRanges.count = [b, 4];
      out.headerLength = OSPF6_HEADER_BYTES + LSU_FIXED;
      const next = nextAfter(o, out.headerLength, len);
      if (next) out.next = next;
      break;
    }
    case OSPF6_PACKET.lsack: {
      const next = nextAfter(o, OSPF6_HEADER_BYTES, len);
      if (next) out.next = next;
      break;
    }
    default:
      out.error = `unknown OSPFv3 packet type ${String(fields.type)}`;
      break;
  }
  if (!complete && out.error === undefined) out.error = `OSPFv3 packet truncated (length ${declared}, ${avail} bytes present)`;
  return out;
}

function encodeOspf6(fields: Record<string, FieldValue>, payload: Uint8Array, ctx?: CodecContext): Uint8Array {
  const p = 'ospf6';
  const version = uint(p, fields, 'version', 8, 3);
  const type = uint(p, fields, 'type', 8, null);
  const routerId = ipField(p, fields, 'routerId', null);
  const areaId = ipField(p, fields, 'areaId', null);
  const instanceId = uint(p, fields, 'instanceId', 8, 0);
  let body: Uint8Array;
  switch (type) {
    case OSPF6_PACKET.hello: {
      if (payload.length > 0) throw new Error('ospf6: a hello carries no inner layer');
      const neighbors = idList(p, 'neighbors', strField(p, fields, 'neighbors', ''));
      body = new Uint8Array(HELLO_FIXED + neighbors.length * 4);
      writeU32(body, 0, uint(p, fields, 'interfaceId', 32, null));
      body[4] = uint(p, fields, 'priority', 8, 1);
      writeU24(body, 5, uint(p, fields, 'options', 24, OSPF6_DEFAULT_OPTIONS));
      writeU16(body, 8, uint(p, fields, 'helloInterval', 16, 10));
      writeU16(body, 10, uint(p, fields, 'deadInterval', 16, 40));
      body.set(ipField(p, fields, 'dr', '0.0.0.0'), 12);
      body.set(ipField(p, fields, 'bdr', '0.0.0.0'), 16);
      neighbors.forEach((a, i) => body.set(a, HELLO_FIXED + i * 4));
      break;
    }
    case OSPF6_PACKET.dbd: {
      body = new Uint8Array(DBD_FIXED);
      writeU24(body, 1, uint(p, fields, 'options', 24, OSPF6_DEFAULT_OPTIONS));
      writeU16(body, 4, uint(p, fields, 'mtu', 16, 1500));
      body[7] = uint(p, fields, 'flags', 8, 0);
      writeU32(body, 8, uint(p, fields, 'ddSeq', 32, 0));
      break;
    }
    case OSPF6_PACKET.lsr: {
      if (payload.length > 0) throw new Error('ospf6: a link-state request carries no inner layer');
      const text = strField(p, fields, 'requests', '');
      const entries = text.trim() === '' ? [] : text.split(';');
      body = new Uint8Array(entries.length * LSR_ENTRY);
      entries.forEach((entry, i) => {
        const parts = entry.split(':');
        const t = Number(parts[0]);
        if (parts.length !== 3 || !Number.isInteger(t) || t < 0 || t > 0xffff || !isIpv4(parts[1]!) || !isIpv4(parts[2]!)) {
          throw new Error(`ospf6.requests entry must be '<type>:<lsId>:<adv>', got "${entry}"`);
        }
        writeU16(body, i * LSR_ENTRY + 2, t);
        body.set(ipv4ToBytes(parts[1]!), i * LSR_ENTRY + 4);
        body.set(ipv4ToBytes(parts[2]!), i * LSR_ENTRY + 8);
      });
      break;
    }
    case OSPF6_PACKET.lsu:
      body = new Uint8Array(LSU_FIXED);
      writeU32(body, 0, countLsas(payload));
      break;
    case OSPF6_PACKET.lsack:
      body = new Uint8Array(0);
      break;
    default:
      throw new Error(`ospf6.type must be 1 (hello) to 5 (link-state acknowledgement), got ${type}`);
  }
  const total = OSPF6_HEADER_BYTES + body.length + payload.length;
  if (total > 0xffff) throw new Error(`ospf6 packet too large: ${total} bytes`);
  const out = new Uint8Array(total);
  out[0] = version;
  out[1] = type;
  writeU16(out, 2, total);
  out.set(routerId, 4);
  out.set(areaId, 8);
  out[14] = instanceId;
  out.set(body, OSPF6_HEADER_BYTES);
  out.set(payload, OSPF6_HEADER_BYTES + body.length);
  // checksum (12..13) is zero while summing; no enclosing IPv6 header leaves it zero
  const pseudo = nearestIpLayer(ctx)?.family === 6 ? pseudoHeaderSumFor(ctx, IPV6_NH_OSPF6, total) : undefined;
  if (pseudo !== undefined) writeU16(out, 12, finishChecksum(onesSum(out, 0, total, pseudo)));
  return out;
}

function summarizeOspf6(fields: Readonly<Record<string, FieldValue>>): string {
  const type = typeof fields.type === 'number' ? fields.type : -1;
  const from = `from ${String(fields.routerId ?? '?')} area ${String(fields.areaId ?? '?')}`;
  switch (type) {
    case OSPF6_PACKET.hello:
      return `OSPFv3 hello ${from}, DR ${String(fields.dr ?? '?')}, BDR ${String(fields.bdr ?? '?')}`;
    case OSPF6_PACKET.dbd: {
      const flags = typeof fields.flags === 'number' ? ddFlagsText(fields.flags) : '';
      return `OSPFv3 database description ${from}, seq ${String(fields.ddSeq ?? '?')}${flags === '' ? '' : `, flags ${flags}`}`;
    }
    case OSPF6_PACKET.lsr: {
      const text = typeof fields.requests === 'string' ? fields.requests : '';
      const n = text === '' ? 0 : text.split(';').length;
      return `OSPFv3 link-state request ${from}, ${n} ${n === 1 ? 'LSA' : 'LSAs'}`;
    }
    case OSPF6_PACKET.lsu: {
      const n = typeof fields.count === 'number' ? fields.count : 0;
      return `OSPFv3 link-state update ${from}, ${n} ${n === 1 ? 'LSA' : 'LSAs'}`;
    }
    case OSPF6_PACKET.lsack:
      return `OSPFv3 link-state acknowledgement ${from}`;
    default:
      return `OSPFv3 ${ospf6PacketText(type)} ${from}`;
  }
}

function ddFlagsText(flags: number): string {
  const out: string[] = [];
  if (flags & 4) out.push('I');
  if (flags & 2) out.push('M');
  if (flags & 1) out.push('MS');
  return out.join(' ');
}

const OSPF6_DERIVED: Readonly<Record<string, MutationReason>> = Object.freeze({ checksum: 'ChecksumRecompute', length: 'Other', count: 'Other' });

/** OSPFv3 packet codec. Required on encode: `type`, `routerId`, `areaId`; a hello also `interfaceId`. */
export const ospf6Codec: Codec = {
  proto: 'ospf6',
  defaults: Object.freeze({ version: 3, type: null, routerId: null, areaId: null, instanceId: 0 }),
  decode: decodeOspf6,
  encode: encodeOspf6,
  summarize: summarizeOspf6,
  derived: OSPF6_DERIVED,
  outerInputs: Object.freeze(['ipv6.src', 'ipv6.dst']),
  stopsMeaning: () => true,
};

// ── ospf6-lsa ────────────────────────────────────────────────────────────────

type Fields = Record<string, FieldValue>;
type Ranges = Record<string, readonly [number, number]>;

/** Decodes the body of a full LSA into `fields`; returns an error text or undefined. */
function decodeBody(type: number, bytes: Uint8Array, b: number, end: number, fields: Fields, fieldRanges: Ranges): string | undefined {
  const name = ospf6LsaText(type);
  const need = (n: number): boolean => b + n <= end;
  switch (type) {
    case OSPF6_LSA_KIND.router: {
      if (!need(ROUTER_FIXED)) return `${name} LSA body truncated`;
      fields.flags = bytes[b]!;
      fields.options = readU24(bytes, b + 1);
      fieldRanges.flags = [b, 1];
      fieldRanges.options = [b + 1, 3];
      const entries: string[] = [];
      let pos = b + ROUTER_FIXED;
      while (pos + ROUTER_LINK <= end) {
        const kind = bytes[pos]!;
        entries.push(`${LINK_KIND_TEXT[kind] ?? String(kind)},${readU16(bytes, pos + 2)},${readU32(bytes, pos + 4)},${readU32(bytes, pos + 8)},${bytesToIpv4(bytes, pos + 12)}`);
        pos += ROUTER_LINK;
      }
      fields.links = entries.join(';');
      fieldRanges.links = [b + ROUTER_FIXED, pos - (b + ROUTER_FIXED)];
      return pos === end ? undefined : `${name} LSA links run past the LSA`;
    }
    case OSPF6_LSA_KIND.network: {
      if (!need(4)) return `${name} LSA body truncated`;
      fields.options = readU24(bytes, b + 1);
      fieldRanges.options = [b + 1, 3];
      const n = Math.floor((end - b - 4) / 4);
      const ids: string[] = [];
      for (let i = 0; i < n; i++) ids.push(bytesToIpv4(bytes, b + 4 + i * 4));
      fields.attached = ids.join(',');
      fieldRanges.attached = [b + 4, n * 4];
      return undefined;
    }
    case OSPF6_LSA_KIND.interAreaPrefix: {
      if (!need(4)) return `${name} LSA body truncated`;
      fields.metric = readU24(bytes, b + 1);
      fieldRanges.metric = [b + 1, 3];
      const r = readPrefixes(bytes, b + 4, end, 1, false);
      fields.prefixes = r.text;
      fieldRanges.prefixes = [b + 4, r.pos - (b + 4)];
      return r.error;
    }
    case OSPF6_LSA_KIND.interAreaRouter: {
      if (!need(12)) return `${name} LSA body truncated`;
      fields.options = readU24(bytes, b + 1);
      fields.metric = readU24(bytes, b + 5);
      fields.destRouterId = bytesToIpv4(bytes, b + 8);
      fieldRanges.options = [b + 1, 3];
      fieldRanges.metric = [b + 5, 3];
      fieldRanges.destRouterId = [b + 8, 4];
      return undefined;
    }
    case OSPF6_LSA_KIND.external: {
      if (!need(8)) return `${name} LSA body truncated`;
      const flags = bytes[b]!;
      fields.e2 = (flags & EXT_FLAG.E) !== 0;
      fields.metric = readU24(bytes, b + 1);
      const refType = readU16(bytes, b + 6);
      fields.refType = refType;
      fieldRanges.e2 = [b, 1];
      fieldRanges.metric = [b + 1, 3];
      fieldRanges.refType = [b + 6, 2];
      const len = bytes[b + 4]!;
      const size = len > 128 ? -1 : prefixWireBytes(len);
      if (size < 0 || !need(8 + size)) return `${name} LSA prefix runs past the LSA`;
      fields.prefixes = prefixText(bytes, b + 8, len);
      fieldRanges.prefixes = [b + 4, 4 + size];
      let pos = b + 8 + size;
      if (flags & EXT_FLAG.F) {
        if (pos + 16 > end) return `${name} LSA forwarding address runs past the LSA`;
        fields.forward = bytesToIpv6(bytes, pos);
        fieldRanges.forward = [pos, 16];
        pos += 16;
      }
      if (flags & EXT_FLAG.T) {
        if (pos + 4 > end) return `${name} LSA tag runs past the LSA`;
        fields.tag = readU32(bytes, pos);
        fieldRanges.tag = [pos, 4];
        pos += 4;
      }
      if (refType !== 0) {
        if (pos + 4 > end) return `${name} LSA referenced id runs past the LSA`;
        fields.refLsId = bytesToIpv4(bytes, pos);
        fieldRanges.refLsId = [pos, 4];
      }
      return undefined;
    }
    case OSPF6_LSA_KIND.link: {
      if (!need(24)) return `${name} LSA body truncated`;
      fields.priority = bytes[b]!;
      fields.options = readU24(bytes, b + 1);
      fields.linkLocal = bytesToIpv6(bytes, b + 4);
      fieldRanges.priority = [b, 1];
      fieldRanges.options = [b + 1, 3];
      fieldRanges.linkLocal = [b + 4, 16];
      const r = readPrefixes(bytes, b + 24, end, readU32(bytes, b + 20), false);
      fields.prefixes = r.text;
      fieldRanges.prefixes = [b + 20, r.pos - (b + 20)];
      return r.error;
    }
    case OSPF6_LSA_KIND.intraAreaPrefix: {
      if (!need(12)) return `${name} LSA body truncated`;
      fields.refType = readU16(bytes, b + 2);
      fields.refLsId = bytesToIpv4(bytes, b + 4);
      fields.refAdvRouter = bytesToIpv4(bytes, b + 8);
      fieldRanges.refType = [b + 2, 2];
      fieldRanges.refLsId = [b + 4, 4];
      fieldRanges.refAdvRouter = [b + 8, 4];
      const r = readPrefixes(bytes, b + 12, end, readU16(bytes, b), true);
      fields.prefixes = r.text;
      fieldRanges.prefixes = [b + 12, r.pos - (b + 12)];
      return r.error;
    }
    default:
      return undefined; // no body decoder: the header is shown, the body stays inside the layer
  }
}

function decodeLsa6(bytes: Uint8Array, offset: number, length: number, ctx?: CodecContext): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Fields = {};
  const fieldRanges: Ranges = {};
  const o = offset;
  const headerOnly = isHeaderCopy(ctx);
  if (avail < OSPF6_LSA_HEADER_BYTES) {
    return { fields, fieldRanges, headerLength: avail, length: avail, error: 'OSPFv3 LSA header truncated' };
  }
  fields.age = readU16(bytes, o);
  fields.lsType = readU16(bytes, o + 2);
  fields.lsId = bytesToIpv4(bytes, o + 4);
  fields.advRouter = bytesToIpv4(bytes, o + 8);
  fields.seq = readU32(bytes, o + 12);
  fields.checksum = readU16(bytes, o + 16);
  fields.length = readU16(bytes, o + 18);
  fields.headerOnly = headerOnly;
  fieldRanges.age = [o, 2];
  fieldRanges.lsType = [o + 2, 2];
  fieldRanges.lsId = [o + 4, 4];
  fieldRanges.advRouter = [o + 8, 4];
  fieldRanges.seq = [o + 12, 4];
  fieldRanges.checksum = [o + 16, 2];
  fieldRanges.length = [o + 18, 2];

  if (headerOnly) {
    const out: DecodedLayer = { fields, fieldRanges, headerLength: OSPF6_LSA_HEADER_BYTES, length: avail };
    const next = nextAfter(o, OSPF6_LSA_HEADER_BYTES, avail);
    if (next) out.next = next;
    return out;
  }
  const lsaLen = fields.length;
  if (lsaLen < OSPF6_LSA_HEADER_BYTES) {
    fields.checksumValid = false;
    return { fields, fieldRanges, headerLength: OSPF6_LSA_HEADER_BYTES, length: avail, error: `OSPFv3 LSA length ${lsaLen} is smaller than its header` };
  }
  if (lsaLen > avail) {
    return { fields, fieldRanges, headerLength: avail, length: avail, error: `OSPFv3 LSA truncated (length ${lsaLen}, ${avail} bytes present)` };
  }
  fields.checksumValid = ospfLsaFletcherValid(bytes, o, lsaLen);
  const error = decodeBody(fields.lsType, bytes, o + OSPF6_LSA_HEADER_BYTES, o + lsaLen, fields, fieldRanges);
  const out: DecodedLayer = { fields, fieldRanges, headerLength: lsaLen, length: avail };
  if (error !== undefined) out.error = error;
  const next = nextAfter(o, lsaLen, avail);
  if (next) out.next = next;
  return out;
}

function encodeBody(type: number, fields: Readonly<Fields>): Uint8Array {
  const p = 'ospf6-lsa';
  const out: number[] = [];
  const u24 = (v: number): void => {
    out.push((v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  };
  const u16 = (v: number): void => {
    out.push((v >>> 8) & 0xff, v & 0xff);
  };
  const u32 = (v: number): void => {
    out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  };
  const ip4 = (key: string, dflt: string | null): void => {
    out.push(...ipField(p, fields, key, dflt));
  };
  const prefixes = (withMetric: boolean): Prefix[] => parsePrefixes(p, strField(p, fields, 'prefixes', ''), withMetric);
  switch (type) {
    case OSPF6_LSA_KIND.router: {
      out.push(uint(p, fields, 'flags', 8, 0));
      u24(uint(p, fields, 'options', 24, OSPF6_DEFAULT_OPTIONS));
      const text = strField(p, fields, 'links', '');
      for (const entry of text.trim() === '' ? [] : text.split(';')) {
        const parts = entry.split(',').map((s) => s.trim());
        const kind = LINK_KIND[parts[0] ?? ''];
        const nums = parts.slice(1, 4).map(Number);
        const ok = parts.length === 5 && kind !== undefined && nums.every((n) => Number.isInteger(n) && n >= 0)
          && nums[0]! <= 0xffff && nums[1]! <= 0xffffffff && nums[2]! <= 0xffffffff && isIpv4(parts[4]!);
        if (!ok) throw new Error(`ospf6-lsa.links entry must be '<p2p|transit|virtual>,<metric>,<ifaceId>,<nbrIfaceId>,<nbrRouterId>', got "${entry}"`);
        out.push(kind!, 0);
        u16(nums[0]!);
        u32(nums[1]!);
        u32(nums[2]!);
        out.push(...ipv4ToBytes(parts[4]!));
      }
      break;
    }
    case OSPF6_LSA_KIND.network: {
      out.push(0);
      u24(uint(p, fields, 'options', 24, OSPF6_DEFAULT_OPTIONS));
      for (const id of idList(p, 'attached', strField(p, fields, 'attached', ''))) out.push(...id);
      break;
    }
    case OSPF6_LSA_KIND.interAreaPrefix: {
      out.push(0);
      u24(uint(p, fields, 'metric', 24, null));
      const list = prefixes(false);
      if (list.length !== 1) throw new Error('ospf6-lsa.prefixes: an inter-area-prefix LSA carries exactly one prefix');
      writePrefix(out, list[0]!, 0);
      break;
    }
    case OSPF6_LSA_KIND.interAreaRouter: {
      out.push(0);
      u24(uint(p, fields, 'options', 24, OSPF6_DEFAULT_OPTIONS));
      out.push(0);
      u24(uint(p, fields, 'metric', 24, null));
      ip4('destRouterId', null);
      break;
    }
    case OSPF6_LSA_KIND.external: {
      const list = prefixes(false);
      if (list.length !== 1) throw new Error('ospf6-lsa.prefixes: an AS-external LSA carries exactly one prefix');
      const e2 = fields.e2;
      const refType = uint(p, fields, 'refType', 16, 0);
      const flags = (e2 === false || e2 === 0 ? 0 : EXT_FLAG.E) | (has(fields, 'forward') ? EXT_FLAG.F : 0) | (has(fields, 'tag') ? EXT_FLAG.T : 0);
      out.push(flags);
      u24(uint(p, fields, 'metric', 24, null));
      const pfx = list[0]!;
      out.push(pfx.len, 0);
      u16(refType);
      for (let i = 0; i < prefixWireBytes(pfx.len); i++) out.push(pfx.bytes[i]!);
      if (flags & EXT_FLAG.F) out.push(...ip6Bytes(p, 'forward', strField(p, fields, 'forward', null)));
      if (flags & EXT_FLAG.T) u32(uint(p, fields, 'tag', 32, null));
      if (refType !== 0) ip4('refLsId', null);
      break;
    }
    case OSPF6_LSA_KIND.link: {
      out.push(uint(p, fields, 'priority', 8, 1));
      u24(uint(p, fields, 'options', 24, OSPF6_DEFAULT_OPTIONS));
      out.push(...ip6Bytes(p, 'linkLocal', strField(p, fields, 'linkLocal', null)));
      const list = prefixes(false);
      u32(list.length);
      for (const pfx of list) writePrefix(out, pfx, 0);
      break;
    }
    case OSPF6_LSA_KIND.intraAreaPrefix: {
      const list = prefixes(true);
      if (list.length > 0xffff) throw new Error('ospf6-lsa.prefixes: too many prefixes');
      u16(list.length);
      u16(uint(p, fields, 'refType', 16, null));
      ip4('refLsId', null);
      ip4('refAdvRouter', null);
      for (const pfx of list) writePrefix(out, pfx, pfx.metric);
      break;
    }
    default:
      throw new Error(`ospf6-lsa: LSA type 0x${type.toString(16).padStart(4, '0')} has no body encoder (0x2001, 0x2002, 0x2003, 0x2004, 0x4005, 0x0008, 0x2009)`);
  }
  return Uint8Array.from(out);
}

function encodeLsa6(fields: Fields, payload: Uint8Array, ctx?: CodecContext): Uint8Array {
  const p = 'ospf6-lsa';
  const age = uint(p, fields, 'age', 16, 0);
  const lsType = uint(p, fields, 'lsType', 16, null);
  const lsId = ipField(p, fields, 'lsId', null);
  const advRouter = ipField(p, fields, 'advRouter', null);
  const seq = uint(p, fields, 'seq', 32, INITIAL_LSA_SEQ);
  const header = (out: Uint8Array): void => {
    writeU16(out, 0, age);
    writeU16(out, 2, lsType);
    out.set(lsId, 4);
    out.set(advRouter, 8);
    writeU32(out, 12, seq);
  };
  if (isHeaderCopy(ctx)) {
    const out = new Uint8Array(OSPF6_LSA_HEADER_BYTES + payload.length);
    header(out);
    writeU16(out, 16, uint(p, fields, 'checksum', 16, null));
    writeU16(out, 18, uint(p, fields, 'length', 16, null));
    out.set(payload, OSPF6_LSA_HEADER_BYTES);
    return out;
  }
  const body = encodeBody(lsType, fields);
  const lsaLen = OSPF6_LSA_HEADER_BYTES + body.length;
  if (lsaLen > 0xffff) throw new Error(`ospf6-lsa too large: ${lsaLen} bytes`);
  const out = new Uint8Array(lsaLen + payload.length);
  header(out);
  writeU16(out, 18, lsaLen);
  out.set(body, OSPF6_LSA_HEADER_BYTES);
  writeU16(out, 16, ospfLsaFletcher(out, 0, lsaLen));
  out.set(payload, lsaLen);
  return out;
}

function summarizeLsa6(fields: Readonly<Fields>): string {
  const type = typeof fields.lsType === 'number' ? ospf6LsaText(fields.lsType) : '?';
  const seq = typeof fields.seq === 'number' ? `0x${fields.seq.toString(16).padStart(8, '0')}` : '?';
  const copy = fields.headerOnly === true ? ' (header)' : '';
  return `${type} LSA ${String(fields.lsId ?? '?')} from ${String(fields.advRouter ?? '?')} seq ${seq} age ${String(fields.age ?? '?')}${copy}`;
}

/**
 * One OSPFv3 LSA or LSA header copy. Required on encode: `lsType`, `lsId`, `advRouter` and the body's required fields;
 * a header copy (inside a DBD or an LSAck) also requires the full LSA's `checksum` and `length`.
 */
export const ospf6LsaCodec: Codec = {
  proto: 'ospf6-lsa',
  defaults: Object.freeze({ age: 0, lsType: null, lsId: null, advRouter: null, seq: INITIAL_LSA_SEQ }),
  decode: decodeLsa6,
  encode: encodeLsa6,
  summarize: summarizeLsa6,
  // no `derived` map, as `ospf-lsa`: `checksum` and `length` are derived in an update but required in a header copy
};
