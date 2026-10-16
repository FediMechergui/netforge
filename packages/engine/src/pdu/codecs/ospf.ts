/**
 * OSPFv2 codecs (RFC 2328 Appendix A; ARCHITECTURE-P3 D7, §2.3; contracts/fields.ts `ospf`, `ospf-lsa`).
 * Reached through IP protocol 89 (`ipproto` dispatch). OSPF is an IETF protocol, so the bytes are the RFC's.
 *
 * `ospf` — the packet header and the fixed part of each packet type:
 *   header (24): `version(1) type(1) length(2) routerId(4) area(4) checksum(2) auType(2) authentication(8)`
 *   1 hello:  `mask(4) helloInterval(2) options(1) priority(1) deadInterval(4) dr(4) bdr(4) neighbor(4)*`
 *   2 DBD:    `mtu(2) options(1) flags(1) ddSeq(4)` then LSA headers (each its own `ospf-lsa` layer)
 *   3 LSR:    `(lsType(4) lsid(4) advRouter(4))*` — the flat string `requests` ('<type>:<lsid>:<adv>' joined by ';')
 *   4 LSU:    `count(4)` then full LSAs (each its own `ospf-lsa` layer)
 *   5 LSAck:  LSA headers (each its own `ospf-lsa` layer)
 *  • `checksum` is the IP one's-complement sum over the packet minus the 8-byte authentication field (derived);
 *    `length` and, in an LSU, `count` are derived from what follows.
 *  • Authentication (header octets 16–23; @since P3c [S5], ARCHITECTURE-P3C §2.3, §3.2):
 *    auType 0 — eight zero octets (no field is decoded, so every P3 capture decodes as before);
 *    auType 1 — `authKey`, at most 8 bytes, zero-padded, in clear (a teaching point, like PAP);
 *    auType 2 — `0(2) keyId(1) 16(1) cryptoSeq(4)`, checksum 0 (RFC 2328 D.4.3: not calculated, so `checksumValid` is
 *    not set), and the 16-byte `digest` as a TRAILER after the OSPF `length` (the layer's `trailerLength`; the packet
 *    length excludes it). The codec never sees a key: the sender encodes the packet, computes the digest over it with
 *    `ospfMd5Digest(packet, key)` (MD5 of the packet ‖ the key zero-padded to 16 bytes) and encodes again with
 *    `digest` set (absent = 16 zero octets). A mutate keeps the decoded digest, so a changed packet no longer matches.
 *  • Lists are flat strings (the CAPWAP precedent): `neighbors` holds router ids joined by ','.
 *  • `stopsMeaning`: summary() and topProto() stop here, so a packet is described by its OSPF type.
 *
 * `ospf-lsa` — one LSA (in an LSU) or one LSA header copy (in a DBD or an LSAck), chained one after the other: each
 * layer's `headerLength` is its own bytes (20 for a header copy, the LSA length otherwise) and its `length` runs to
 * the end of the packet, so the next LSA is its inner layer and a `mutate` re-encodes every LSA after it unchanged.
 *   header (20): `age(2) options(1) lsType(1) lsid(4) advRouter(4) seq(4) checksum(2) length(2)`
 *   router (1):  `flags(1: V 4, E 2, B 1) 0(1) links(2) (id(4) data(4) type(1) tos(1) metric(2) tos*4)*`
 *   network (2): `mask(4) attached(4)*`
 *   summary (3, 4): `mask(4) 0(1) metric(3)` (@since P3c [S4]; RFC 2328 A.4.4: the mask is 0.0.0.0 in a type 4; any
 *                 TOS entries after the first word pair are kept inside the layer, not decoded)
 *   external (5): `mask(4) E|0(1) metric(3) forward(4) tag(4)`
 *  • The layer knows it is a header copy from the enclosing packet type (`ctx.outer`, the nearest `ospf` layer: 2
 *    DBD or 5 LSAck). A header copy carries the FULL LSA's `checksum` and `length`, which its 20 bytes cannot
 *    recompute, so both are required on encode; in an LSU (or with no enclosing packet) they are derived: the length
 *    from the body and the checksum by Fletcher over the LSA from its options byte (the age excluded, RFC 2328
 *    §12.1.7). `headerOnly` and `checksumValid` (full LSAs only) are decode-only.
 *  • `links` holds '<kind>,<id>,<data>,<metric>' entries joined by ';' (kinds p2p, transit, stub; a decoded virtual
 *    link is 'virtual'); `attached` holds router ids joined by ','. Types 1–5 have a body encoder (NSSA [C4] is not
 *    approved); any other type decodes its header only.
 */
import type { Codec, CodecContext, DecodedLayer, FieldValue, MutationReason, ProtoName } from '../../contracts/pdu.js';
import { bytesToIpv4, ipv4ToBytes, isIpv4 } from '../../contracts/addr.js';
import { MD5_DIGEST_BYTES, md5 } from '../../core/md5.js';
import {
  bytesField,
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

/** OSPF packet types (the `ospf.type` field). */
export const OSPF_PACKET = Object.freeze({ hello: 1, dbd: 2, lsr: 3, lsu: 4, lsack: 5 });
/** LSA types with a body encoder (the `ospf-lsa.lsType` field; the summary types @since P3c [S4]). */
export const OSPF_LSA_KIND = Object.freeze({ router: 1, network: 2, summary: 3, asbrSummary: 4, external: 5 });
/** @since P3c [S5] Authentication types (the `ospf.auType` field, RFC 2328 D.3). */
export const OSPF_AUTH = Object.freeze({ none: 0, simple: 1, md5: 2 });
/** @since P3c [S5] Longest simple-password key (the 8-octet authentication field). */
export const OSPF_SIMPLE_KEY_BYTES = 8;
/** @since P3c [S5] Longest keyed-MD5 secret (zero-padded to 16 octets before hashing, RFC 2328 D.4.3). */
export const OSPF_MD5_KEY_BYTES = 16;
/** Database description flag bits (the `ospf.flags` field of a DBD). */
export const OSPF_DD_FLAG = Object.freeze({ I: 4, M: 2, MS: 1 });
/** Router-LSA flag bits (the `ospf-lsa.flags` field). */
export const OSPF_ROUTER_FLAG = Object.freeze({ V: 4, E: 2, B: 1 });
/** OSPF packet header length. */
export const OSPF_HEADER_BYTES = 24;
/** LSA header length. */
export const OSPF_LSA_HEADER_BYTES = 20;
/** Initial LSA sequence number (RFC 2328 InitialSequenceNumber). */
export const OSPF_INITIAL_LSA_SEQ = 0x80000001;

const HELLO_FIXED = 20;
const AUTH_OFFSET = 16;
const AUTH_BYTES = 8;
const SUMMARY_BODY = 8;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });
const UTF8_ENCODER = new TextEncoder();
const DBD_FIXED = 8;
const LSR_ENTRY = 12;
const LSU_FIXED = 4;
const ROUTER_LINK = 12;

const PACKET_TEXT: Readonly<Record<number, string>> = Object.freeze({
  1: 'hello',
  2: 'database description',
  3: 'link-state request',
  4: 'link-state update',
  5: 'link-state acknowledgement',
});
const LSA_TEXT: Readonly<Record<number, string>> = Object.freeze({ 1: 'router', 2: 'network', 3: 'summary', 4: 'ASBR summary', 5: 'external', 7: 'NSSA external' });
const LINK_KIND: Readonly<Record<string, number>> = Object.freeze({ p2p: 1, transit: 2, stub: 3 });
const LINK_KIND_TEXT: Readonly<Record<number, string>> = Object.freeze({ 1: 'p2p', 2: 'transit', 3: 'stub', 4: 'virtual' });

/** Name of an OSPF packet type ('hello', 'database description', …), or 'type <n>'. */
export function ospfPacketText(type: number): string {
  return PACKET_TEXT[type] ?? `type ${type}`;
}

/** Name of an LSA type ('router', 'network', 'external', …), or 'type <n>'. */
export function ospfLsaText(type: number): string {
  return LSA_TEXT[type] ?? `type ${type}`;
}

/** The DBD flag letters of `flags`, e.g. 'I M MS' ('' when none is set). */
export function ospfDdFlagsText(flags: number): string {
  const out: string[] = [];
  if (flags & OSPF_DD_FLAG.I) out.push('I');
  if (flags & OSPF_DD_FLAG.M) out.push('M');
  if (flags & OSPF_DD_FLAG.MS) out.push('MS');
  return out.join(' ');
}

// ── shared helpers ───────────────────────────────────────────────────────────

function ipField(proto: string, fields: Readonly<Record<string, FieldValue>>, key: string, dflt: string | null): Uint8Array {
  const s = strField(proto, fields, key, dflt);
  if (!isIpv4(s)) throw new Error(`${proto}.${key} is not an IPv4 address: "${s}"`);
  return ipv4ToBytes(s);
}

function uint(proto: string, fields: Readonly<Record<string, FieldValue>>, key: string, bits: number, dflt: number | null): number {
  const v = numField(proto, fields, key, dflt);
  const max = bits === 32 ? 0xffffffff : (1 << bits) - 1;
  if (v < 0 || v > max) throw new Error(`${proto}.${key} out of range: ${v}`);
  return v;
}

function addrList(proto: string, key: string, text: string, sep: string): Uint8Array[] {
  if (text.trim() === '') return [];
  return text.split(sep).map((s) => {
    const a = s.trim();
    if (!isIpv4(a)) throw new Error(`${proto}.${key} holds a value that is not an IPv4 address: "${a}"`);
    return ipv4ToBytes(a);
  });
}

/** The `type` of the nearest enclosing `ospf` layer, or undefined. */
function enclosingOspfType(ctx: CodecContext | undefined): number | undefined {
  const outer = ctx?.outer;
  if (!outer) return undefined;
  for (let i = outer.length - 1; i >= 0; i--) {
    const o = outer[i]!;
    if (o.proto === 'ospf') return typeof o.fields.type === 'number' ? o.fields.type : undefined;
  }
  return undefined;
}

function isHeaderCopy(ctx: CodecContext | undefined): boolean {
  const t = enclosingOspfType(ctx);
  return t === OSPF_PACKET.dbd || t === OSPF_PACKET.lsack;
}

/** Number of LSAs chained in `payload` (each LSA's length at its header offset 18). */
function countLsas(payload: Uint8Array): number {
  let n = 0;
  let pos = 0;
  while (pos + OSPF_LSA_HEADER_BYTES <= payload.length) {
    const len = readU16(payload, pos + 18);
    if (len < OSPF_LSA_HEADER_BYTES) break;
    n++;
    pos += len;
  }
  return n;
}

/** The next layer after `used` bytes of a `bound`-byte LSA list: another LSA, trailing bytes as payload, or none. */
function nextAfter(offset: number, used: number, bound: number): DecodedLayer['next'] {
  const rest = bound - used;
  if (rest <= 0) return undefined;
  const proto: ProtoName = rest >= OSPF_LSA_HEADER_BYTES ? 'ospf-lsa' : 'payload';
  return { proto, offset: offset + used, length: rest };
}

// ── ospf ─────────────────────────────────────────────────────────────────────

function decodeOspf(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  const o = offset;
  if (avail < OSPF_HEADER_BYTES) {
    if (avail >= 1) {
      fields.version = bytes[o]!;
      fieldRanges.version = [o, 1];
    }
    if (avail >= 2) {
      fields.type = bytes[o + 1]!;
      fieldRanges.type = [o + 1, 1];
    }
    return { fields, fieldRanges, headerLength: avail, length: avail, error: 'OSPF header truncated' };
  }
  fields.version = bytes[o]!;
  fields.type = bytes[o + 1]!;
  fields.length = readU16(bytes, o + 2);
  fields.routerId = bytesToIpv4(bytes, o + 4);
  fields.area = bytesToIpv4(bytes, o + 8);
  fields.checksum = readU16(bytes, o + 12);
  fields.auType = readU16(bytes, o + 14);
  fieldRanges.version = [o, 1];
  fieldRanges.type = [o + 1, 1];
  fieldRanges.length = [o + 2, 2];
  fieldRanges.routerId = [o + 4, 4];
  fieldRanges.area = [o + 8, 4];
  fieldRanges.checksum = [o + 12, 2];
  fieldRanges.auType = [o + 14, 2];

  const md5Auth = fields.auType === OSPF_AUTH.md5;
  if (fields.auType === OSPF_AUTH.simple) {
    let n = 0;
    while (n < AUTH_BYTES && bytes[o + AUTH_OFFSET + n] !== 0) n++;
    fields.authKey = UTF8_DECODER.decode(bytes.subarray(o + AUTH_OFFSET, o + AUTH_OFFSET + n));
    fieldRanges.authKey = [o + AUTH_OFFSET, AUTH_BYTES];
  } else if (md5Auth) {
    fields.keyId = bytes[o + 18]!;
    fields.cryptoSeq = readU32(bytes, o + 20);
    fieldRanges.keyId = [o + 18, 1];
    fieldRanges.cryptoSeq = [o + 20, 4];
  }

  const declared = fields.length;
  if (declared < OSPF_HEADER_BYTES) {
    fields.checksumValid = false;
    return { fields, fieldRanges, headerLength: OSPF_HEADER_BYTES, length: avail, error: `OSPF length ${declared} is smaller than the header` };
  }
  const complete = declared <= avail;
  const len = complete ? declared : avail;
  if (complete && !md5Auth) {
    fields.checksumValid = finishChecksum(onesSum(bytes, o + OSPF_HEADER_BYTES, declared - OSPF_HEADER_BYTES, onesSum(bytes, o, 16))) === 0;
  }
  const out: DecodedLayer = { fields, fieldRanges, headerLength: OSPF_HEADER_BYTES, length: len };
  if (md5Auth && complete) {
    const digestLen = bytes[o + 19]!;
    if (digestLen === MD5_DIGEST_BYTES && declared + MD5_DIGEST_BYTES <= avail) {
      fields.digest = bytes.slice(o + declared, o + declared + MD5_DIGEST_BYTES);
      fieldRanges.digest = [o + declared, MD5_DIGEST_BYTES];
      out.length = declared + MD5_DIGEST_BYTES;
      out.trailerLength = MD5_DIGEST_BYTES;
    } else {
      out.error = 'OSPF keyed MD5 digest missing or truncated';
    }
  }
  const truncated = (): DecodedLayer => ({ ...out, headerLength: len, error: `OSPF ${ospfPacketText(fields.type as number)} truncated` });
  const b = o + OSPF_HEADER_BYTES;
  switch (fields.type) {
    case OSPF_PACKET.hello: {
      if (len < OSPF_HEADER_BYTES + HELLO_FIXED) return truncated();
      fields.mask = bytesToIpv4(bytes, b);
      fields.helloInterval = readU16(bytes, b + 4);
      fields.options = bytes[b + 6]!;
      fields.priority = bytes[b + 7]!;
      fields.deadInterval = readU32(bytes, b + 8);
      fields.dr = bytesToIpv4(bytes, b + 12);
      fields.bdr = bytesToIpv4(bytes, b + 16);
      fieldRanges.mask = [b, 4];
      fieldRanges.helloInterval = [b + 4, 2];
      fieldRanges.options = [b + 6, 1];
      fieldRanges.priority = [b + 7, 1];
      fieldRanges.deadInterval = [b + 8, 4];
      fieldRanges.dr = [b + 12, 4];
      fieldRanges.bdr = [b + 16, 4];
      const n = Math.floor((len - OSPF_HEADER_BYTES - HELLO_FIXED) / 4);
      const ids: string[] = [];
      for (let i = 0; i < n; i++) ids.push(bytesToIpv4(bytes, b + HELLO_FIXED + i * 4));
      fields.neighbors = ids.join(',');
      fieldRanges.neighbors = [b + HELLO_FIXED, n * 4];
      out.headerLength = len;
      break;
    }
    case OSPF_PACKET.dbd: {
      if (len < OSPF_HEADER_BYTES + DBD_FIXED) return truncated();
      fields.mtu = readU16(bytes, b);
      fields.options = bytes[b + 2]!;
      fields.flags = bytes[b + 3]!;
      fields.ddSeq = readU32(bytes, b + 4);
      fieldRanges.mtu = [b, 2];
      fieldRanges.options = [b + 2, 1];
      fieldRanges.flags = [b + 3, 1];
      fieldRanges.ddSeq = [b + 4, 4];
      out.headerLength = OSPF_HEADER_BYTES + DBD_FIXED;
      const next = nextAfter(o, out.headerLength, len);
      if (next) out.next = next;
      break;
    }
    case OSPF_PACKET.lsr: {
      const n = Math.floor((len - OSPF_HEADER_BYTES) / LSR_ENTRY);
      const entries: string[] = [];
      for (let i = 0; i < n; i++) {
        const e = b + i * LSR_ENTRY;
        entries.push(`${readU32(bytes, e)}:${bytesToIpv4(bytes, e + 4)}:${bytesToIpv4(bytes, e + 8)}`);
      }
      fields.requests = entries.join(';');
      fieldRanges.requests = [b, n * LSR_ENTRY];
      out.headerLength = len;
      break;
    }
    case OSPF_PACKET.lsu: {
      if (len < OSPF_HEADER_BYTES + LSU_FIXED) return truncated();
      fields.count = readU32(bytes, b);
      fieldRanges.count = [b, 4];
      out.headerLength = OSPF_HEADER_BYTES + LSU_FIXED;
      const next = nextAfter(o, out.headerLength, len);
      if (next) out.next = next;
      break;
    }
    case OSPF_PACKET.lsack: {
      const next = nextAfter(o, OSPF_HEADER_BYTES, len);
      if (next) out.next = next;
      break;
    }
    default:
      out.error = `unknown OSPF packet type ${String(fields.type)}`;
      break;
  }
  if (!complete && out.error === undefined) out.error = `OSPF packet truncated (length ${declared}, ${avail} bytes present)`;
  return out;
}

/**
 * @since P3c [S5] The RFC 2328 D.4.3 keyed-MD5 digest of an OSPF packet encoded with auType 2: MD5 over the packet's
 * `length` octets (read from octets 2–3; the checksum is zero and the authentication field holds `0 keyId 16
 * cryptoSeq`) followed by `key` zero-padded to 16 octets. A trailer already present after `length` is ignored. Throws
 * when the key is longer than 16 octets or the packet is shorter than its length.
 */
export function ospfMd5Digest(packet: Uint8Array, key: string | Uint8Array): Uint8Array {
  const secret = typeof key === 'string' ? UTF8_ENCODER.encode(key) : key;
  if (secret.length > OSPF_MD5_KEY_BYTES) throw new Error(`ospf: an MD5 key is at most ${OSPF_MD5_KEY_BYTES} bytes`);
  if (packet.length < OSPF_HEADER_BYTES) throw new Error('ospf: the packet is shorter than its header');
  const length = readU16(packet, 2);
  if (length < OSPF_HEADER_BYTES || length > packet.length) throw new Error(`ospf: packet length ${length} does not fit ${packet.length} bytes`);
  const data = new Uint8Array(length + OSPF_MD5_KEY_BYTES);
  data.set(packet.subarray(0, length), 0);
  data.set(secret, length);
  return md5(data);
}

function encodeOspf(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'ospf';
  const version = uint(p, fields, 'version', 8, 2);
  const type = uint(p, fields, 'type', 8, null);
  const routerId = ipField(p, fields, 'routerId', null);
  const area = ipField(p, fields, 'area', null);
  const auType = uint(p, fields, 'auType', 16, 0);
  let auth: Uint8Array | undefined;
  if (auType === OSPF_AUTH.simple) {
    auth = UTF8_ENCODER.encode(strField(p, fields, 'authKey', ''));
    if (auth.length > AUTH_BYTES) throw new Error(`ospf.authKey is at most ${AUTH_BYTES} bytes, got ${auth.length}`);
  }
  let trailer: Uint8Array | undefined;
  if (auType === OSPF_AUTH.md5) {
    const d = bytesField(p, fields, 'digest');
    if (d.length !== 0 && d.length !== MD5_DIGEST_BYTES) throw new Error(`ospf.digest must be ${MD5_DIGEST_BYTES} bytes, got ${d.length}`);
    trailer = d.length === MD5_DIGEST_BYTES ? d : new Uint8Array(MD5_DIGEST_BYTES);
  }
  let body: Uint8Array;
  switch (type) {
    case OSPF_PACKET.hello: {
      if (payload.length > 0) throw new Error('ospf: a hello carries no inner layer');
      const neighbors = addrList(p, 'neighbors', strField(p, fields, 'neighbors', ''), ',');
      body = new Uint8Array(HELLO_FIXED + neighbors.length * 4);
      body.set(ipField(p, fields, 'mask', '0.0.0.0'), 0);
      writeU16(body, 4, uint(p, fields, 'helloInterval', 16, 10));
      body[6] = uint(p, fields, 'options', 8, 0x02);
      body[7] = uint(p, fields, 'priority', 8, 1);
      writeU32(body, 8, uint(p, fields, 'deadInterval', 32, 40));
      body.set(ipField(p, fields, 'dr', '0.0.0.0'), 12);
      body.set(ipField(p, fields, 'bdr', '0.0.0.0'), 16);
      neighbors.forEach((a, i) => body.set(a, HELLO_FIXED + i * 4));
      break;
    }
    case OSPF_PACKET.dbd: {
      body = new Uint8Array(DBD_FIXED);
      writeU16(body, 0, uint(p, fields, 'mtu', 16, 1500));
      body[2] = uint(p, fields, 'options', 8, 0x02);
      body[3] = uint(p, fields, 'flags', 8, 0);
      writeU32(body, 4, uint(p, fields, 'ddSeq', 32, 0));
      break;
    }
    case OSPF_PACKET.lsr: {
      if (payload.length > 0) throw new Error('ospf: a link-state request carries no inner layer');
      const text = strField(p, fields, 'requests', '');
      const entries = text.trim() === '' ? [] : text.split(';');
      body = new Uint8Array(entries.length * LSR_ENTRY);
      entries.forEach((entry, i) => {
        const parts = entry.split(':');
        const t = Number(parts[0]);
        if (parts.length !== 3 || !Number.isInteger(t) || t < 0 || t > 0xffffffff || !isIpv4(parts[1]!) || !isIpv4(parts[2]!)) {
          throw new Error(`ospf.requests entry must be '<type>:<lsid>:<adv>', got "${entry}"`);
        }
        writeU32(body, i * LSR_ENTRY, t);
        body.set(ipv4ToBytes(parts[1]!), i * LSR_ENTRY + 4);
        body.set(ipv4ToBytes(parts[2]!), i * LSR_ENTRY + 8);
      });
      break;
    }
    case OSPF_PACKET.lsu:
      body = new Uint8Array(LSU_FIXED);
      writeU32(body, 0, countLsas(payload));
      break;
    case OSPF_PACKET.lsack:
      body = new Uint8Array(0);
      break;
    default:
      throw new Error(`ospf.type must be 1 (hello) to 5 (link-state acknowledgement), got ${type}`);
  }
  const total = OSPF_HEADER_BYTES + body.length + payload.length;
  if (total > 0xffff) throw new Error(`ospf packet too large: ${total} bytes`);
  const out = new Uint8Array(total + (trailer?.length ?? 0));
  out[0] = version;
  out[1] = type;
  writeU16(out, 2, total);
  out.set(routerId, 4);
  out.set(area, 8);
  writeU16(out, 14, auType);
  // authentication (16..23): zeros (auType 0 and any other type), the key (1) or `0 keyId 16 cryptoSeq` (2)
  if (auth) out.set(auth, AUTH_OFFSET);
  if (trailer) {
    out[18] = uint(p, fields, 'keyId', 8, null);
    out[19] = MD5_DIGEST_BYTES;
    writeU32(out, 20, uint(p, fields, 'cryptoSeq', 32, 0));
  }
  out.set(body, OSPF_HEADER_BYTES);
  out.set(payload, OSPF_HEADER_BYTES + body.length);
  if (trailer) {
    out.set(trailer, total); // keyed MD5: the checksum is not calculated (stays 0)
    return out;
  }
  // checksum (12..13) is zero while summing; the authentication field is outside the sum
  writeU16(out, 12, finishChecksum(onesSum(out, OSPF_HEADER_BYTES, total - OSPF_HEADER_BYTES, onesSum(out, 0, 16))));
  return out;
}

function summarizeOspf(fields: Readonly<Record<string, FieldValue>>): string {
  const type = typeof fields.type === 'number' ? fields.type : -1;
  const from = `from ${String(fields.routerId ?? '?')} area ${String(fields.area ?? '?')}`;
  switch (type) {
    case OSPF_PACKET.hello:
      return `OSPF hello ${from}, DR ${String(fields.dr ?? '?')}, BDR ${String(fields.bdr ?? '?')}`;
    case OSPF_PACKET.dbd: {
      const flags = typeof fields.flags === 'number' ? ospfDdFlagsText(fields.flags) : '';
      return `OSPF database description ${from}, seq ${String(fields.ddSeq ?? '?')}${flags === '' ? '' : `, flags ${flags}`}`;
    }
    case OSPF_PACKET.lsr: {
      const text = typeof fields.requests === 'string' ? fields.requests : '';
      const n = text === '' ? 0 : text.split(';').length;
      return `OSPF link-state request ${from}, ${n} ${n === 1 ? 'LSA' : 'LSAs'}`;
    }
    case OSPF_PACKET.lsu: {
      const n = typeof fields.count === 'number' ? fields.count : 0;
      return `OSPF link-state update ${from}, ${n} ${n === 1 ? 'LSA' : 'LSAs'}`;
    }
    case OSPF_PACKET.lsack:
      return `OSPF link-state acknowledgement ${from}`;
    default:
      return `OSPF ${ospfPacketText(type)} ${from}`;
  }
}

const OSPF_DERIVED: Readonly<Record<string, MutationReason>> = Object.freeze({ checksum: 'ChecksumRecompute', length: 'Other', count: 'Other' });

/** OSPFv2 packet codec. Required on encode: `type`, `routerId`, `area`; with auType 2 also `keyId`. */
export const ospfCodec: Codec = {
  proto: 'ospf',
  defaults: Object.freeze({ version: 2, type: null, routerId: null, area: null, auType: 0 }),
  decode: decodeOspf,
  encode: encodeOspf,
  summarize: summarizeOspf,
  derived: OSPF_DERIVED,
  stopsMeaning: () => true,
};

// ── ospf-lsa ─────────────────────────────────────────────────────────────────

function decodeRouterBody(bytes: Uint8Array, b: number, end: number, fields: Record<string, FieldValue>, fieldRanges: Record<string, readonly [number, number]>): string | undefined {
  if (b + 4 > end) return 'router LSA body truncated';
  fields.flags = bytes[b]!;
  fieldRanges.flags = [b, 1];
  const n = readU16(bytes, b + 2);
  const entries: string[] = [];
  let pos = b + 4;
  for (let i = 0; i < n; i++) {
    if (pos + ROUTER_LINK > end) {
      fields.links = entries.join(';');
      fieldRanges.links = [b + 4, pos - (b + 4)];
      return 'router LSA links run past the LSA';
    }
    const id = bytesToIpv4(bytes, pos);
    const data = bytesToIpv4(bytes, pos + 4);
    const kind = bytes[pos + 8]!;
    const tos = bytes[pos + 9]!;
    const metric = readU16(bytes, pos + 10);
    entries.push(`${LINK_KIND_TEXT[kind] ?? String(kind)},${id},${data},${metric}`);
    pos += ROUTER_LINK + tos * 4;
  }
  fields.links = entries.join(';');
  fieldRanges.links = [b + 4, Math.min(pos, end) - (b + 4)];
  return pos > end ? 'router LSA links run past the LSA' : undefined;
}

function decodeLsa(bytes: Uint8Array, offset: number, length: number, ctx?: CodecContext): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  const o = offset;
  const headerOnly = isHeaderCopy(ctx);
  if (avail < OSPF_LSA_HEADER_BYTES) {
    return { fields, fieldRanges, headerLength: avail, length: avail, error: 'OSPF LSA header truncated' };
  }
  fields.age = readU16(bytes, o);
  fields.options = bytes[o + 2]!;
  fields.lsType = bytes[o + 3]!;
  fields.lsid = bytesToIpv4(bytes, o + 4);
  fields.advRouter = bytesToIpv4(bytes, o + 8);
  fields.seq = readU32(bytes, o + 12);
  fields.checksum = readU16(bytes, o + 16);
  fields.length = readU16(bytes, o + 18);
  fields.headerOnly = headerOnly;
  fieldRanges.age = [o, 2];
  fieldRanges.options = [o + 2, 1];
  fieldRanges.lsType = [o + 3, 1];
  fieldRanges.lsid = [o + 4, 4];
  fieldRanges.advRouter = [o + 8, 4];
  fieldRanges.seq = [o + 12, 4];
  fieldRanges.checksum = [o + 16, 2];
  fieldRanges.length = [o + 18, 2];

  if (headerOnly) {
    const out: DecodedLayer = { fields, fieldRanges, headerLength: OSPF_LSA_HEADER_BYTES, length: avail };
    const next = nextAfter(o, OSPF_LSA_HEADER_BYTES, avail);
    if (next) out.next = next;
    return out;
  }
  const lsaLen = fields.length;
  if (lsaLen < OSPF_LSA_HEADER_BYTES) {
    fields.checksumValid = false;
    return { fields, fieldRanges, headerLength: OSPF_LSA_HEADER_BYTES, length: avail, error: `OSPF LSA length ${lsaLen} is smaller than its header` };
  }
  if (lsaLen > avail) {
    return { fields, fieldRanges, headerLength: avail, length: avail, error: `OSPF LSA truncated (length ${lsaLen}, ${avail} bytes present)` };
  }
  fields.checksumValid = ospfLsaFletcherValid(bytes, o, lsaLen);
  const b = o + OSPF_LSA_HEADER_BYTES;
  const end = o + lsaLen;
  let error: string | undefined;
  switch (fields.lsType) {
    case OSPF_LSA_KIND.router:
      error = decodeRouterBody(bytes, b, end, fields, fieldRanges);
      break;
    case OSPF_LSA_KIND.network: {
      if (b + 4 > end) {
        error = 'network LSA body truncated';
        break;
      }
      fields.mask = bytesToIpv4(bytes, b);
      fieldRanges.mask = [b, 4];
      const n = Math.floor((end - b - 4) / 4);
      const ids: string[] = [];
      for (let i = 0; i < n; i++) ids.push(bytesToIpv4(bytes, b + 4 + i * 4));
      fields.attached = ids.join(',');
      fieldRanges.attached = [b + 4, n * 4];
      break;
    }
    case OSPF_LSA_KIND.summary:
    case OSPF_LSA_KIND.asbrSummary: {
      if (b + SUMMARY_BODY > end) {
        error = 'summary LSA body truncated';
        break;
      }
      fields.mask = bytesToIpv4(bytes, b);
      fields.metric = (bytes[b + 5]! << 16) | (bytes[b + 6]! << 8) | bytes[b + 7]!;
      fieldRanges.mask = [b, 4];
      fieldRanges.metric = [b + 5, 3];
      break;
    }
    case OSPF_LSA_KIND.external: {
      if (b + 16 > end) {
        error = 'external LSA body truncated';
        break;
      }
      fields.mask = bytesToIpv4(bytes, b);
      fields.e2 = (bytes[b + 4]! & 0x80) !== 0;
      fields.metric = (bytes[b + 5]! << 16) | (bytes[b + 6]! << 8) | bytes[b + 7]!;
      fields.forward = bytesToIpv4(bytes, b + 8);
      fields.tag = readU32(bytes, b + 12);
      fieldRanges.mask = [b, 4];
      fieldRanges.e2 = [b + 4, 1];
      fieldRanges.metric = [b + 5, 3];
      fieldRanges.forward = [b + 8, 4];
      fieldRanges.tag = [b + 12, 4];
      break;
    }
    default:
      break; // no body decoder: the header is shown, the body stays inside the layer
  }
  const out: DecodedLayer = { fields, fieldRanges, headerLength: lsaLen, length: avail };
  if (error !== undefined) out.error = error;
  const next = nextAfter(o, lsaLen, avail);
  if (next) out.next = next;
  return out;
}

function encodeRouterBody(fields: Readonly<Record<string, FieldValue>>): Uint8Array {
  const p = 'ospf-lsa';
  const text = strField(p, fields, 'links', '');
  const entries = text.trim() === '' ? [] : text.split(';');
  if (entries.length > 0xffff) throw new Error('ospf-lsa.links: too many links');
  const body = new Uint8Array(4 + entries.length * ROUTER_LINK);
  body[0] = uint(p, fields, 'flags', 8, 0);
  writeU16(body, 2, entries.length);
  entries.forEach((entry, i) => {
    const parts = entry.split(',').map((s) => s.trim());
    const kind = LINK_KIND[parts[0] ?? ''];
    const metric = Number(parts[3]);
    if (parts.length !== 4 || kind === undefined || !isIpv4(parts[1]!) || !isIpv4(parts[2]!) || !Number.isInteger(metric) || metric < 0 || metric > 0xffff) {
      throw new Error(`ospf-lsa.links entry must be '<p2p|transit|stub>,<id>,<data>,<metric>', got "${entry}"`);
    }
    const at = 4 + i * ROUTER_LINK;
    body.set(ipv4ToBytes(parts[1]!), at);
    body.set(ipv4ToBytes(parts[2]!), at + 4);
    body[at + 8] = kind;
    body[at + 9] = 0;
    writeU16(body, at + 10, metric);
  });
  return body;
}

function encodeLsaBody(type: number, fields: Readonly<Record<string, FieldValue>>): Uint8Array {
  const p = 'ospf-lsa';
  switch (type) {
    case OSPF_LSA_KIND.router:
      return encodeRouterBody(fields);
    case OSPF_LSA_KIND.network: {
      const attached = addrList(p, 'attached', strField(p, fields, 'attached', ''), ',');
      const body = new Uint8Array(4 + attached.length * 4);
      body.set(ipField(p, fields, 'mask', null), 0);
      attached.forEach((a, i) => body.set(a, 4 + i * 4));
      return body;
    }
    case OSPF_LSA_KIND.summary:
    case OSPF_LSA_KIND.asbrSummary: {
      const body = new Uint8Array(SUMMARY_BODY);
      body.set(ipField(p, fields, 'mask', type === OSPF_LSA_KIND.asbrSummary ? '0.0.0.0' : null), 0);
      const metric = uint(p, fields, 'metric', 24, null);
      body[5] = (metric >>> 16) & 0xff;
      body[6] = (metric >>> 8) & 0xff;
      body[7] = metric & 0xff;
      return body;
    }
    case OSPF_LSA_KIND.external: {
      const body = new Uint8Array(16);
      body.set(ipField(p, fields, 'mask', null), 0);
      const e2 = fields.e2;
      body[4] = e2 === false || e2 === 0 ? 0 : 0x80;
      const metric = uint(p, fields, 'metric', 24, null);
      body[5] = (metric >>> 16) & 0xff;
      body[6] = (metric >>> 8) & 0xff;
      body[7] = metric & 0xff;
      body.set(ipField(p, fields, 'forward', '0.0.0.0'), 8);
      writeU32(body, 12, uint(p, fields, 'tag', 32, 0));
      return body;
    }
    default:
      throw new Error(`ospf-lsa: LSA type ${type} has no body encoder (1 router, 2 network, 3 and 4 summary, 5 external)`);
  }
}

function encodeLsa(fields: Record<string, FieldValue>, payload: Uint8Array, ctx?: CodecContext): Uint8Array {
  const p = 'ospf-lsa';
  const age = uint(p, fields, 'age', 16, 0);
  const options = uint(p, fields, 'options', 8, 0x02);
  const lsType = uint(p, fields, 'lsType', 8, null);
  const lsid = ipField(p, fields, 'lsid', null);
  const advRouter = ipField(p, fields, 'advRouter', null);
  const seq = uint(p, fields, 'seq', 32, OSPF_INITIAL_LSA_SEQ);
  const header = (out: Uint8Array): void => {
    writeU16(out, 0, age);
    out[2] = options;
    out[3] = lsType;
    out.set(lsid, 4);
    out.set(advRouter, 8);
    writeU32(out, 12, seq);
  };
  if (isHeaderCopy(ctx)) {
    const out = new Uint8Array(OSPF_LSA_HEADER_BYTES + payload.length);
    header(out);
    writeU16(out, 16, uint(p, fields, 'checksum', 16, null));
    writeU16(out, 18, uint(p, fields, 'length', 16, null));
    out.set(payload, OSPF_LSA_HEADER_BYTES);
    return out;
  }
  const body = encodeLsaBody(lsType, fields);
  const lsaLen = OSPF_LSA_HEADER_BYTES + body.length;
  if (lsaLen > 0xffff) throw new Error(`ospf-lsa too large: ${lsaLen} bytes`);
  const out = new Uint8Array(lsaLen + payload.length);
  header(out);
  writeU16(out, 18, lsaLen);
  out.set(body, OSPF_LSA_HEADER_BYTES);
  writeU16(out, 16, ospfLsaFletcher(out, 0, lsaLen));
  out.set(payload, lsaLen);
  return out;
}

function summarizeLsa(fields: Readonly<Record<string, FieldValue>>): string {
  const type = typeof fields.lsType === 'number' ? ospfLsaText(fields.lsType) : '?';
  const seq = typeof fields.seq === 'number' ? `0x${fields.seq.toString(16).padStart(8, '0')}` : '?';
  const copy = fields.headerOnly === true ? ' (header)' : '';
  return `${type} LSA ${String(fields.lsid ?? '?')} from ${String(fields.advRouter ?? '?')} seq ${seq} age ${String(fields.age ?? '?')}${copy}`;
}

/**
 * One OSPF LSA or LSA header copy. Required on encode: `lsType`, `lsid`, `advRouter`; a header copy (inside a DBD or
 * an LSAck) also requires the full LSA's `checksum` and `length`.
 */
export const ospfLsaCodec: Codec = {
  proto: 'ospf-lsa',
  defaults: Object.freeze({ age: 0, options: 0x02, lsType: null, lsid: null, advRouter: null, seq: OSPF_INITIAL_LSA_SEQ }),
  decode: decodeLsa,
  encode: encodeLsa,
  summarize: summarizeLsa,
  // no `derived` map: the table marks `checksum` and `length` neither derived nor decode-only (they are derived in an
  // LSU but required in a header copy), so a mutate records the LSA's own recomputed checksum through the packet's
  // ChecksumRecompute only
};
