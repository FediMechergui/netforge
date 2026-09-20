/**
 * ICMPv6 codec (RFC 4443) with neighbour discovery messages and options (RFC 4861) and the RDNSS option
 * (RFC 8106) — ARCHITECTURE-P1 §4.6, contracts/fields.ts `icmpv6`.
 *
 * Header: `type(1) code(1) checksum(2)` and then, per type:
 *  • 1 destination unreachable / 3 time exceeded: `unused(4)`; 2 packet too big: `mtu(4)`; 4 parameter problem:
 *    `pointer(4)`. The invoking packet follows ("as much as fits") and decodes as nested `ipv6` → … layers, so
 *    the quote shows up like an ICMPv4 error quote. `stopsMeaning` is true for these error types.
 *  • 128 echo request / 129 echo reply: `id(2) seq(2)`, then the echo data as payload.
 *  • 133 router solicitation: `reserved(4)` + options.
 *  • 134 router advertisement: `curHopLimit(1) flags(1: M 0x80, O 0x40) routerLifetime(2) reachableTime(4)
 *    retransTimer(4)` + options. Reachable time and retransmit timer encode as 0 (unspecified).
 *  • 135 neighbour solicitation: `reserved(4) target(16)` + options; 136 neighbour advertisement:
 *    `flags(1: R 0x80, S 0x40, O 0x20) reserved(3) target(16)` + options.
 *  • Any other type: `unused(4)`, then raw payload.
 * ND options (8-byte units): 1 source link-layer address → `sourceLla`, 2 target link-layer address →
 * `targetLla`, 3 prefix information → the FIRST one fills `prefix`/`prefixLen`/`validLifetimeS`/
 * `preferredLifetimeS` (encoded with the on-link and autonomous flags set, prefix bits past the length zeroed),
 * 5 MTU → `mtu`, 25 RDNSS → `rdnss` (decode-only, comma-separated). Unknown options are skipped; an option of
 * length 0 or one running past the message is an error. Encode writes options in the order source LLA, target
 * LLA, MTU, prefix.
 *
 * The checksum covers the IPv6 pseudo-header (next header 58) of the NEAREST enclosing ipv6 layer and the whole
 * message; it is derived. `outerInputs` lists ipv6.src/dst. A message quoted inside another error is not
 * verified (`checksumValid` undefined) and is not an error when its fixed part was cut short.
 */
import type { Codec, CodecContext, DecodedLayer, FieldValue, MutationReason } from '../../contracts/pdu.js';
import {
  ICMPV6_DEST_UNREACHABLE,
  ICMPV6_ECHO_REPLY,
  ICMPV6_ECHO_REQUEST,
  ICMPV6_NA,
  ICMPV6_NS,
  ICMPV6_PACKET_TOO_BIG,
  ICMPV6_PARAM_PROBLEM,
  ICMPV6_RA,
  ICMPV6_RS,
  ICMPV6_TIME_EXCEEDED,
  IPPROTO_ICMPV6,
  IPV6_MIN_MTU,
} from '../../contracts/pdu.js';
import { bytesToMac, macToBytes } from '../../contracts/addr.js';
import { ND_RA_PREFERRED_LIFETIME_S, ND_RA_VALID_LIFETIME_S } from '../../contracts/services.js';
import { bytesToIpv6, ipv6NetworkOf } from '../../core/addr6.js';
import { finishChecksum, numField, onesSum, readU16, readU32, strField, writeU16, writeU32 } from '../checksum.js';
import { ipv6FieldBytes } from './ipv6.js';
import { isQuotedContext, nearestIpLayer, pseudoHeaderSumFor } from './udp.js';

const BASE = 8;
const RA_FIXED = 16;
const NS_FIXED = 24;

/** RA default: current hop limit advertised to hosts. */
export const ICMPV6_RA_DEFAULT_HOP_LIMIT = 64;
/** RA default router lifetime (3 × the 600 s default maximum RA interval, RFC 4861 §6.2.1). */
export const ICMPV6_RA_DEFAULT_LIFETIME_S = 1800;

/** ND option type numbers. */
export const ND_OPT_SOURCE_LLA = 1;
export const ND_OPT_TARGET_LLA = 2;
export const ND_OPT_PREFIX_INFO = 3;
export const ND_OPT_MTU = 5;
export const ND_OPT_RDNSS = 25;

/** True for the four ICMPv6 error types (1–4), whose body quotes the invoking packet. */
export function isIcmpv6Error(type: number): boolean {
  return type >= ICMPV6_DEST_UNREACHABLE && type <= ICMPV6_PARAM_PROBLEM;
}

/** True for the ND message types 133–137. */
export function isNdType(type: number): boolean {
  return type >= ICMPV6_RS && type <= 137;
}

const DERIVED: Readonly<Record<string, MutationReason>> = Object.freeze({ checksum: 'ChecksumRecompute' });

/** Parse ND options in `[start, end)`; returns an error text or undefined. */
function decodeOptions(
  bytes: Uint8Array,
  start: number,
  end: number,
  fields: Record<string, FieldValue>,
  fieldRanges: Record<string, readonly [number, number]>,
): string | undefined {
  let i = start;
  const rdnss: string[] = [];
  let error: string | undefined;
  while (i < end) {
    if (i + 2 > end) {
      error = 'ICMPv6 option truncated';
      break;
    }
    const type = bytes[i]!;
    const len = bytes[i + 1]! * 8;
    if (len === 0) {
      error = `ICMPv6 option ${type} has length 0`;
      break;
    }
    if (i + len > end) {
      error = `ICMPv6 option ${type} runs past the message`;
      break;
    }
    switch (type) {
      case ND_OPT_SOURCE_LLA:
        if (len >= 8 && fields.sourceLla === undefined) {
          fields.sourceLla = bytesToMac(bytes, i + 2);
          fieldRanges.sourceLla = [i + 2, 6];
        }
        break;
      case ND_OPT_TARGET_LLA:
        if (len >= 8 && fields.targetLla === undefined) {
          fields.targetLla = bytesToMac(bytes, i + 2);
          fieldRanges.targetLla = [i + 2, 6];
        }
        break;
      case ND_OPT_PREFIX_INFO:
        if (len === 32 && fields.prefix === undefined) {
          fields.prefixLen = bytes[i + 2]!;
          fields.validLifetimeS = readU32(bytes, i + 4);
          fields.preferredLifetimeS = readU32(bytes, i + 8);
          fields.prefix = bytesToIpv6(bytes, i + 16);
          fieldRanges.prefixLen = [i + 2, 1];
          fieldRanges.validLifetimeS = [i + 4, 4];
          fieldRanges.preferredLifetimeS = [i + 8, 4];
          fieldRanges.prefix = [i + 16, 16];
        }
        break;
      case ND_OPT_MTU:
        if (len === 8 && fields.mtu === undefined) {
          fields.mtu = readU32(bytes, i + 4);
          fieldRanges.mtu = [i + 4, 4];
        }
        break;
      case ND_OPT_RDNSS:
        for (let a = i + 8; a + 16 <= i + len; a += 16) rdnss.push(bytesToIpv6(bytes, a));
        if (fieldRanges.rdnss === undefined) fieldRanges.rdnss = [i, len];
        break;
      default:
        break;
    }
    i += len;
  }
  if (rdnss.length > 0) fields.rdnss = rdnss.join(',');
  return error;
}

function readFlag(fields: Readonly<Record<string, FieldValue>>, key: string): boolean {
  const v = fields[key];
  return v === true || v === 1;
}

function decode(bytes: Uint8Array, offset: number, length: number, ctx?: CodecContext): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  const quoted = isQuotedContext(ctx);
  const cut = (headerLength: number, what: string): DecodedLayer => {
    const out: DecodedLayer = { fields, fieldRanges, headerLength, length: avail };
    if (!quoted) out.error = `ICMPv6 ${what} truncated`;
    return out;
  };

  if (avail >= 1) {
    fields.type = bytes[offset]!;
    fieldRanges.type = [offset, 1];
  }
  if (avail >= 2) {
    fields.code = bytes[offset + 1]!;
    fieldRanges.code = [offset + 1, 1];
  }
  if (avail < 4) return cut(avail, 'header');
  fields.checksum = readU16(bytes, offset + 2);
  fieldRanges.checksum = [offset + 2, 2];
  const type = fields.type as number;

  if (!quoted && nearestIpLayer(ctx)?.family === 6) {
    const pseudo = pseudoHeaderSumFor(ctx, IPPROTO_ICMPV6, avail);
    if (pseudo !== undefined) fields.checksumValid = finishChecksum(onesSum(bytes, offset, avail, pseudo)) === 0;
  }

  if (type === ICMPV6_RA) {
    if (avail < RA_FIXED) return cut(avail, 'router advertisement');
    const flags = bytes[offset + 5]!;
    fields.curHopLimit = bytes[offset + 4]!;
    fields.managedFlag = (flags & 0x80) !== 0;
    fields.otherFlag = (flags & 0x40) !== 0;
    fields.routerLifetimeS = readU16(bytes, offset + 6);
    fieldRanges.curHopLimit = [offset + 4, 1];
    fieldRanges.managedFlag = [offset + 5, 1];
    fieldRanges.otherFlag = [offset + 5, 1];
    fieldRanges.routerLifetimeS = [offset + 6, 2];
    const err = decodeOptions(bytes, offset + RA_FIXED, offset + avail, fields, fieldRanges);
    return { fields, fieldRanges, headerLength: avail, length: avail, ...(err !== undefined ? { error: err } : {}) };
  }
  if (type === ICMPV6_NS || type === ICMPV6_NA) {
    const what = type === ICMPV6_NS ? 'neighbour solicitation' : 'neighbour advertisement';
    if (avail < NS_FIXED) return cut(avail, what);
    if (type === ICMPV6_NA) {
      const flags = bytes[offset + 4]!;
      fields.routerFlag = (flags & 0x80) !== 0;
      fields.solicitedFlag = (flags & 0x40) !== 0;
      fields.overrideFlag = (flags & 0x20) !== 0;
      fieldRanges.routerFlag = [offset + 4, 1];
      fieldRanges.solicitedFlag = [offset + 4, 1];
      fieldRanges.overrideFlag = [offset + 4, 1];
    }
    fields.target = bytesToIpv6(bytes, offset + 8);
    fieldRanges.target = [offset + 8, 16];
    const err = decodeOptions(bytes, offset + NS_FIXED, offset + avail, fields, fieldRanges);
    return { fields, fieldRanges, headerLength: avail, length: avail, ...(err !== undefined ? { error: err } : {}) };
  }
  if (type === ICMPV6_RS) {
    if (avail < BASE) return cut(avail, 'router solicitation');
    const err = decodeOptions(bytes, offset + BASE, offset + avail, fields, fieldRanges);
    return { fields, fieldRanges, headerLength: avail, length: avail, ...(err !== undefined ? { error: err } : {}) };
  }

  if (avail < BASE) return cut(avail, 'message');
  if (type === ICMPV6_ECHO_REQUEST || type === ICMPV6_ECHO_REPLY) {
    fields.id = readU16(bytes, offset + 4);
    fields.seq = readU16(bytes, offset + 6);
    fieldRanges.id = [offset + 4, 2];
    fieldRanges.seq = [offset + 6, 2];
  } else if (type === ICMPV6_PACKET_TOO_BIG) {
    fields.mtu = readU32(bytes, offset + 4);
    fieldRanges.mtu = [offset + 4, 4];
  } else if (type === ICMPV6_PARAM_PROBLEM) {
    fields.pointer = readU32(bytes, offset + 4);
    fieldRanges.pointer = [offset + 4, 4];
  } else {
    fields.unused = readU32(bytes, offset + 4);
    fieldRanges.unused = [offset + 4, 4];
  }
  const out: DecodedLayer = { fields, fieldRanges, headerLength: BASE, length: avail };
  if (avail > BASE) out.next = { proto: isIcmpv6Error(type) ? 'ipv6' : 'payload', offset: offset + BASE, length: avail - BASE };
  return out;
}

/** One 8-byte link-layer address option. */
function llaOption(type: number, mac: string, key: string): number[] {
  let b: Uint8Array;
  try {
    b = macToBytes(mac);
  } catch {
    throw new Error(`icmpv6.${key} is not a valid MAC address: "${mac}"`);
  }
  return [type, 1, ...b];
}

function u32Bytes(v: number): number[] {
  return [v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

function u32Field(fields: Readonly<Record<string, FieldValue>>, key: string, dflt: number | null): number {
  const v = numField('icmpv6', fields, key, dflt);
  if (v < 0 || v > 0xffffffff) throw new Error(`icmpv6.${key} out of range: ${v}`);
  return v;
}

function optionalMac(fields: Readonly<Record<string, FieldValue>>, key: string): string | undefined {
  const v = fields[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`icmpv6.${key} must be a MAC address string`);
  return v;
}

/** Encoded ND options for `type` from `fields`. */
function encodeOptions(type: number, fields: Readonly<Record<string, FieldValue>>): number[] {
  const o: number[] = [];
  const src = optionalMac(fields, 'sourceLla');
  const tgt = optionalMac(fields, 'targetLla');
  if (src !== undefined && type !== ICMPV6_NA) o.push(...llaOption(ND_OPT_SOURCE_LLA, src, 'sourceLla'));
  if (tgt !== undefined && type === ICMPV6_NA) o.push(...llaOption(ND_OPT_TARGET_LLA, tgt, 'targetLla'));
  if (type !== ICMPV6_RA) return o;
  if (fields.mtu !== undefined && fields.mtu !== null) o.push(ND_OPT_MTU, 1, 0, 0, ...u32Bytes(u32Field(fields, 'mtu', null)));
  const prefixV = fields.prefix;
  if (prefixV !== undefined && prefixV !== null) {
    const prefixText = strField('icmpv6', fields, 'prefix', null);
    const prefixLen = numField('icmpv6', fields, 'prefixLen', 64);
    if (prefixLen < 0 || prefixLen > 128) throw new Error(`icmpv6.prefixLen out of range: ${prefixLen}`);
    ipv6FieldBytes('icmpv6', 'prefix', prefixText);
    const network = ipv6FieldBytes('icmpv6', 'prefix', ipv6NetworkOf(prefixText, prefixLen));
    const valid = u32Field(fields, 'validLifetimeS', ND_RA_VALID_LIFETIME_S);
    const preferred = u32Field(fields, 'preferredLifetimeS', ND_RA_PREFERRED_LIFETIME_S);
    o.push(ND_OPT_PREFIX_INFO, 4, prefixLen, 0xc0, ...u32Bytes(valid), ...u32Bytes(preferred), 0, 0, 0, 0, ...network);
  }
  return o;
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array, ctx?: CodecContext): Uint8Array {
  const p = 'icmpv6';
  const type = numField(p, fields, 'type', null);
  const code = numField(p, fields, 'code', 0);
  if (type < 0 || type > 255) throw new Error(`icmpv6.type out of range: ${type}`);
  if (code < 0 || code > 255) throw new Error(`icmpv6.code out of range: ${code}`);

  let head: number[];
  if (type === ICMPV6_RA) {
    const hop = numField(p, fields, 'curHopLimit', ICMPV6_RA_DEFAULT_HOP_LIMIT);
    const life = numField(p, fields, 'routerLifetimeS', ICMPV6_RA_DEFAULT_LIFETIME_S);
    if (hop < 0 || hop > 255) throw new Error(`icmpv6.curHopLimit out of range: ${hop}`);
    if (life < 0 || life > 0xffff) throw new Error(`icmpv6.routerLifetimeS out of range: ${life}`);
    const flags = (readFlag(fields, 'managedFlag') ? 0x80 : 0) | (readFlag(fields, 'otherFlag') ? 0x40 : 0);
    head = [type, code, 0, 0, hop, flags, life >>> 8, life & 0xff, 0, 0, 0, 0, 0, 0, 0, 0, ...encodeOptions(type, fields)];
  } else if (type === ICMPV6_NS || type === ICMPV6_NA) {
    const target = ipv6FieldBytes(p, 'target', strField(p, fields, 'target', null));
    const flags = type === ICMPV6_NA
      ? (readFlag(fields, 'routerFlag') ? 0x80 : 0) | (readFlag(fields, 'solicitedFlag') ? 0x40 : 0) | (readFlag(fields, 'overrideFlag') ? 0x20 : 0)
      : 0;
    head = [type, code, 0, 0, flags, 0, 0, 0, ...target, ...encodeOptions(type, fields)];
  } else if (type === ICMPV6_RS) {
    head = [type, code, 0, 0, 0, 0, 0, 0, ...encodeOptions(type, fields)];
  } else if (type === ICMPV6_ECHO_REQUEST || type === ICMPV6_ECHO_REPLY) {
    const id = numField(p, fields, 'id', 0) & 0xffff;
    const seq = numField(p, fields, 'seq', 0) & 0xffff;
    head = [type, code, 0, 0, id >>> 8, id & 0xff, seq >>> 8, seq & 0xff];
  } else if (type === ICMPV6_PACKET_TOO_BIG) {
    head = [type, code, 0, 0, ...u32Bytes(u32Field(fields, 'mtu', IPV6_MIN_MTU))];
  } else if (type === ICMPV6_PARAM_PROBLEM) {
    head = [type, code, 0, 0, ...u32Bytes(u32Field(fields, 'pointer', 0))];
  } else {
    head = [type, code, 0, 0, ...u32Bytes(u32Field(fields, 'unused', 0))];
  }
  const out = new Uint8Array(head.length + payload.length);
  out.set(head, 0);
  out.set(payload, head.length);
  const pseudo = nearestIpLayer(ctx)?.family === 6 ? pseudoHeaderSumFor(ctx, IPPROTO_ICMPV6, out.length) : undefined;
  if (pseudo !== undefined) writeU16(out, 2, finishChecksum(onesSum(out, 0, out.length, pseudo)));
  return out;
}

function unreachableName(code: number): string {
  switch (code) {
    case 0:
      return 'no route';
    case 1:
      return 'administratively prohibited';
    case 2:
      return 'beyond scope of source';
    case 3:
      return 'address';
    case 4:
      return 'port';
    case 5:
      return 'source policy';
    case 6:
      return 'reject route';
    default:
      return `code ${code}`;
  }
}

function paramProblemName(code: number): string {
  switch (code) {
    case 0:
      return 'bad header field';
    case 1:
      return 'unknown next header';
    case 2:
      return 'unknown option';
    default:
      return `code ${code}`;
  }
}

/** ` src > dst` from the nearest enclosing ipv6 layer, or ''. */
function addresses(ctx: CodecContext | undefined): string {
  const ip = nearestIpLayer(ctx);
  return ip ? ` ${String(ip.fields.src ?? '?')} > ${String(ip.fields.dst ?? '?')}` : '';
}

function summarize(fields: Readonly<Record<string, FieldValue>>, ctx?: CodecContext): string {
  const type = typeof fields.type === 'number' ? fields.type : -1;
  const code = typeof fields.code === 'number' ? fields.code : 0;
  const addrs = addresses(ctx);
  switch (type) {
    case ICMPV6_ECHO_REQUEST:
      return `ICMPv6 echo request${addrs} id=${String(fields.id ?? '?')} seq=${String(fields.seq ?? '?')}`;
    case ICMPV6_ECHO_REPLY:
      return `ICMPv6 echo reply${addrs} id=${String(fields.id ?? '?')} seq=${String(fields.seq ?? '?')}`;
    case ICMPV6_DEST_UNREACHABLE:
      return `ICMPv6 destination unreachable (${unreachableName(code)})`;
    case ICMPV6_PACKET_TOO_BIG:
      return `ICMPv6 packet too big mtu=${String(fields.mtu ?? '?')}`;
    case ICMPV6_TIME_EXCEEDED:
      return `ICMPv6 time exceeded (${code === 1 ? 'fragment reassembly' : code === 0 ? 'hop limit' : `code ${code}`})`;
    case ICMPV6_PARAM_PROBLEM:
      return `ICMPv6 parameter problem (${paramProblemName(code)}) pointer=${String(fields.pointer ?? '?')}`;
    case ICMPV6_RS:
      return `ICMPv6 router solicitation${addrs}`;
    case ICMPV6_RA: {
      const prefix = fields.prefix !== undefined ? ` prefix ${String(fields.prefix)}/${String(fields.prefixLen ?? '?')}` : '';
      return `ICMPv6 router advertisement${addrs}${prefix} lifetime=${String(fields.routerLifetimeS ?? '?')}s`;
    }
    case ICMPV6_NS:
      return `ICMPv6 neighbour solicitation for ${String(fields.target ?? '?')}${addrs}`;
    case ICMPV6_NA: {
      const flags = `${readFlag(fields, 'routerFlag') ? 'R' : ''}${readFlag(fields, 'solicitedFlag') ? 'S' : ''}${readFlag(fields, 'overrideFlag') ? 'O' : ''}`;
      const lla = fields.targetLla !== undefined ? ` is at ${String(fields.targetLla)}` : '';
      return `ICMPv6 neighbour advertisement ${String(fields.target ?? '?')}${lla}${flags !== '' ? ` [${flags}]` : ''}`;
    }
    default:
      return `ICMPv6 type=${type} code=${code}${addrs}`;
  }
}

/** ICMPv6 codec (errors, echo, ND). Required on encode: `type`; NS/NA also `target`. */
export const icmpv6Codec: Codec = {
  proto: 'icmpv6',
  defaults: Object.freeze({ type: null, code: 0 }),
  decode,
  encode,
  summarize,
  derived: DERIVED,
  outerInputs: Object.freeze(['ipv6.src', 'ipv6.dst']),
  stopsMeaning: (fields: Readonly<Record<string, FieldValue>>): boolean => typeof fields.type === 'number' && isIcmpv6Error(fields.type),
};
