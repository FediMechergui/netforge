/**
 * SNMP codec [S33] [C23] (RFC 3416 PDUs, RFC 3417 transport, RFC 3412 / RFC 3414 v3 message and USM header, over the
 * BER subset of X.690 that SNMP uses; ARCHITECTURE-P3C §2.3, §3.5; contracts/fields.ts `snmp`). UDP 161 (requests and
 * responses) and UDP 162 (traps).
 *
 * Wire image (BER, definite lengths only, short and long form; single-byte tags):
 *  • v1 / v2c: `SEQUENCE { version INTEGER (0 v1, 1 v2c), community OCTET STRING, PDU }`;
 *  • v3: `SEQUENCE { version INTEGER 3, SEQUENCE { msgID, msgMaxSize, msgFlags OCTET STRING (1), msgSecurityModel },
 *    msgSecurityParameters OCTET STRING (holding the USM SEQUENCE { engineID, engineBoots, engineTime, userName,
 *    authParams, privParams }), msgData }`, where msgData is the plaintext `ScopedPDU SEQUENCE { contextEngineID,
 *    contextName, PDU }` or, when msgFlags has the privacy bit, an OCTET STRING of encrypted bytes (`encrypted`);
 *  • PDU: `[tag] { request-id INTEGER, error-status INTEGER, error-index INTEGER, VarBindList }`; a GetBulk carries
 *    non-repeaters and max-repetitions in the two error positions. Tags: get 0xA0, getnext 0xA1, response 0xA2, set
 *    0xA3, getbulk 0xA5, trap 0xA7 (SNMPv2-Trap), report 0xA8.
 *  • Values: INTEGER 0x02, OCTET STRING 0x04, NULL 0x05, OBJECT IDENTIFIER 0x06, IpAddress 0x40, Counter32 0x41,
 *    Gauge32 0x42, TimeTicks 0x43, Counter64 0x46, and the exceptions noSuchObject 0x80, noSuchInstance 0x81,
 *    endOfMibView 0x82 (empty).
 *
 * Fields. The varbind list is one scalar string (contracts/fields.ts rule): entries `<oid>=<type>[:<value>]` joined by
 * '; ', the type being an `SnmpValue` type (contracts/process.ts), e.g.
 * `1.3.6.1.2.1.1.5.0=octets:"R1"; 1.3.6.1.2.1.1.3.0=timeticks:4200; 1.3.6.1.2.1.2.2.1.2.9=endOfMibView`. An octet string
 * is a JSON string when every byte is printable ASCII and `0x<hex>` otherwise; Counter64 is decimal text, so no bigint
 * leaves the codec (`snmpVarbindsText` / `parseSnmpVarbinds` convert to and from `{oid, value: SnmpValue}` lists).
 * Octet strings (community, user and context names, octet values) map one byte to one character (Latin-1).
 *
 * Decode never throws: a message outside the subset (indefinite length, a tag outside the list, a v1 Trap-PDU, an
 * unknown version, bytes past the message) keeps every field read before the fault and carries `malformed: true` and
 * an error; the agent drops it. Every field range covers the value bytes of its TLV (for `authParams`, the twelve bytes
 * an HMAC replaces), except `pdu`, whose range is the PDU's tag and length. Encode writes minimal lengths and minimal
 * integers, so every message this codec writes decodes and re-encodes to the same bytes.
 */
import type { Codec, DecodedLayer, FieldValue } from '../../contracts/pdu.js';
import type { SnmpValue } from '../../contracts/process.js';
import { bytesToIpv4, ipv4ToBytes, isIpv4 } from '../../contracts/addr.js';
import { numField, strField } from '../checksum.js';

/** SNMP versions on the wire (the `snmp.version` field). */
export const SNMP_VERSION = Object.freeze({ v1: 0, v2c: 1, v3: 3 });
/** The PDU names of the `snmp.pdu` field and their BER tags. */
export const SNMP_PDU_TAG: Readonly<Record<string, number>> = Object.freeze({
  get: 0xa0,
  getnext: 0xa1,
  response: 0xa2,
  set: 0xa3,
  getbulk: 0xa5,
  trap: 0xa7,
  report: 0xa8,
});
/** RFC 3416 error-status values (the `snmp.errorStatus` field). */
export const SNMP_ERROR_STATUS = Object.freeze({
  noError: 0,
  tooBig: 1,
  noSuchName: 2,
  badValue: 3,
  readOnly: 4,
  genErr: 5,
  noAccess: 6,
  wrongType: 7,
  wrongLength: 8,
  wrongEncoding: 9,
  wrongValue: 10,
  noCreation: 11,
  inconsistentValue: 12,
  resourceUnavailable: 13,
  commitFailed: 14,
  undoFailed: 15,
  authorizationError: 16,
  notWritable: 17,
  inconsistentName: 18,
});
/** msgFlags bits (RFC 3412 §6.4). */
export const SNMP_V3_FLAGS = Object.freeze({ auth: 0x01, priv: 0x02, reportable: 0x04 });
/** The User-based Security Model's number (RFC 3414). */
export const SNMP_USM_MODEL = 3;
/** BER tags of the subset (X.690 universal tags, then the SNMP application and context tags). */
export const BER_TAG = Object.freeze({
  integer: 0x02,
  octets: 0x04,
  null: 0x05,
  oid: 0x06,
  sequence: 0x30,
  ipaddress: 0x40,
  counter32: 0x41,
  gauge32: 0x42,
  timeticks: 0x43,
  counter64: 0x46,
  noSuchObject: 0x80,
  noSuchInstance: 0x81,
  endOfMibView: 0x82,
});

/** One varbind: an object identifier and its value. */
export interface SnmpVarbind {
  readonly oid: string;
  readonly value: SnmpValue;
}

const PDU_BY_TAG: ReadonlyMap<number, string> = new Map(Object.entries(SNMP_PDU_TAG).map(([k, v]) => [v, k]));
const PDU_TEXT: Readonly<Record<string, string>> = Object.freeze({
  get: 'get-request',
  getnext: 'get-next-request',
  response: 'response',
  set: 'set-request',
  getbulk: 'get-bulk-request',
  trap: 'trap',
  report: 'report',
});
const ERROR_TEXT: ReadonlyMap<number, string> = new Map(Object.entries(SNMP_ERROR_STATUS).map(([k, v]) => [v, k]));
const U32_MAX = 0xffffffff;
const I32_MIN = -0x80000000;
const I32_MAX = 0x7fffffff;
const U64_MAX = (1n << 64n) - 1n;
const UNSIGNED_TYPES: ReadonlySet<string> = new Set(['counter32', 'gauge32', 'timeticks']);
const EMPTY_TYPES: ReadonlySet<string> = new Set(['null', 'noSuchObject', 'noSuchInstance', 'endOfMibView']);
const OID_RE = /^\.?(\d+)(\.\d+)+$/;
const DECIMAL_RE = /^(0|[1-9]\d*)$/;
const SIGNED_RE = /^-?(0|[1-9]\d*)$/;
const HEX_RE = /^(?:[0-9a-f]{2})*$/;

// ── BER reading ────────────────────────────────────────────────────────────────────────────────────────────────────

class BerFault extends Error {}

interface Tlv {
  readonly tag: number;
  /** Offset of the tag byte. */
  readonly start: number;
  /** Offset of the first content byte. */
  readonly content: number;
  /** Offset just past the content. */
  readonly end: number;
}

function readTlv(b: Uint8Array, at: number, end: number, what: string): Tlv {
  if (at >= end) throw new BerFault(`SNMP ${what} missing`);
  const tag = b[at]!;
  if ((tag & 0x1f) === 0x1f) throw new BerFault(`SNMP ${what} uses a multi-byte tag`);
  if (at + 1 >= end) throw new BerFault(`SNMP ${what} truncated`);
  const l0 = b[at + 1]!;
  let len: number;
  let content: number;
  if (l0 < 0x80) {
    len = l0;
    content = at + 2;
  } else if (l0 === 0x80) {
    throw new BerFault(`SNMP ${what} uses an indefinite length`);
  } else {
    const n = l0 & 0x7f;
    if (n > 4) throw new BerFault(`SNMP ${what} length is too long`);
    if (at + 2 + n > end) throw new BerFault(`SNMP ${what} truncated`);
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[at + 2 + i]!;
    content = at + 2 + n;
  }
  if (content + len > end) throw new BerFault(`SNMP ${what} runs past the message`);
  return { tag, start: at, content, end: content + len };
}

function expectTlv(b: Uint8Array, at: number, end: number, tag: number, what: string): Tlv {
  const t = readTlv(b, at, end, what);
  if (t.tag !== tag) throw new BerFault(`SNMP ${what} has tag 0x${hex2(t.tag)}, expected 0x${hex2(tag)}`);
  return t;
}

function hex2(v: number): string {
  return v.toString(16).padStart(2, '0');
}

/** A two's-complement INTEGER content of 1–6 bytes as a number. */
function intContent(b: Uint8Array, t: Tlv, what: string): number {
  const n = t.end - t.content;
  if (n < 1) throw new BerFault(`SNMP ${what} is empty`);
  if (n > 6) throw new BerFault(`SNMP ${what} is too large`);
  let v = (b[t.content]! << 24) >> 24;
  for (let i = t.content + 1; i < t.end; i++) v = v * 256 + b[i]!;
  return v;
}

function readInt(b: Uint8Array, t: Tlv, what: string, min: number, max: number): number {
  const v = intContent(b, t, what);
  if (v < min || v > max) throw new BerFault(`SNMP ${what} out of range: ${v}`);
  return v;
}

function latin1(b: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i < to; i++) s += String.fromCharCode(b[i]!);
  return s;
}

function readOid(b: Uint8Array, t: Tlv, what: string): string {
  if (t.end === t.content) throw new BerFault(`SNMP ${what} is empty`);
  const arcs: number[] = [];
  let v = 0;
  let open = false;
  for (let i = t.content; i < t.end; i++) {
    const x = b[i]!;
    if (!open && x === 0x80) throw new BerFault(`SNMP ${what} has a padded sub-identifier`);
    v = v * 128 + (x & 0x7f);
    // the first sub-identifier carries 2.x as x + 80, so it may exceed 2^32-1 by 80
    if (v > U32_MAX + (arcs.length === 0 ? 80 : 0)) throw new BerFault(`SNMP ${what} has a sub-identifier above 2^32-1`);
    open = (x & 0x80) !== 0;
    if (!open) {
      arcs.push(v);
      v = 0;
    }
  }
  if (open) throw new BerFault(`SNMP ${what} ends inside a sub-identifier`);
  const first = arcs[0]!;
  const head = first < 40 ? [0, first] : first < 80 ? [1, first - 40] : [2, first - 80];
  return [...head, ...arcs.slice(1)].join('.');
}

function readValue(b: Uint8Array, t: Tlv): SnmpValue {
  const n = t.end - t.content;
  switch (t.tag) {
    case BER_TAG.integer:
      return { type: 'integer', value: readInt(b, t, 'INTEGER value', I32_MIN, I32_MAX) };
    case BER_TAG.octets:
      return { type: 'octets', value: latin1(b, t.content, t.end) };
    case BER_TAG.null:
      if (n !== 0) throw new BerFault('SNMP NULL value is not empty');
      return { type: 'null' };
    case BER_TAG.oid:
      return { type: 'oid', value: readOid(b, t, 'OBJECT IDENTIFIER value') };
    case BER_TAG.ipaddress:
      if (n !== 4) throw new BerFault('SNMP IpAddress value is not 4 bytes');
      return { type: 'ipaddress', value: bytesToIpv4(b, t.content) };
    case BER_TAG.counter32:
      return { type: 'counter32', value: readInt(b, t, 'Counter32 value', 0, U32_MAX) };
    case BER_TAG.gauge32:
      return { type: 'gauge32', value: readInt(b, t, 'Gauge32 value', 0, U32_MAX) };
    case BER_TAG.timeticks:
      return { type: 'timeticks', value: readInt(b, t, 'TimeTicks value', 0, U32_MAX) };
    case BER_TAG.counter64: {
      if (n < 1 || n > 9) throw new BerFault('SNMP Counter64 value has a bad length');
      let v = BigInt.asIntN(8, BigInt(b[t.content]!));
      for (let i = t.content + 1; i < t.end; i++) v = v * 256n + BigInt(b[i]!);
      if (v < 0n || v > U64_MAX) throw new BerFault('SNMP Counter64 value out of range');
      return { type: 'counter64', value: v.toString() };
    }
    case BER_TAG.noSuchObject:
    case BER_TAG.noSuchInstance:
    case BER_TAG.endOfMibView:
      if (n !== 0) throw new BerFault('SNMP exception value is not empty');
      return { type: t.tag === BER_TAG.noSuchObject ? 'noSuchObject' : t.tag === BER_TAG.noSuchInstance ? 'noSuchInstance' : 'endOfMibView' };
    default:
      throw new BerFault(`SNMP value type 0x${hex2(t.tag)} is not simulated`);
  }
}

// ── BER writing ────────────────────────────────────────────────────────────────────────────────────────────────────

function lengthBytes(len: number): number[] {
  if (len < 0x80) return [len];
  const out: number[] = [];
  for (let v = len; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return [0x80 | out.length, ...out];
}

function tlv(tag: number, content: readonly number[] | Uint8Array): number[] {
  return [tag, ...lengthBytes(content.length), ...content];
}

/** Minimal two's-complement content of an integer (bigint so Counter64 fits). */
function intBytes(v: bigint): number[] {
  const out: number[] = [];
  let x = v;
  for (;;) {
    const byte = Number(BigInt.asUintN(8, x));
    out.unshift(byte);
    x >>= 8n;
    if ((x === 0n && (byte & 0x80) === 0) || (x === -1n && (byte & 0x80) !== 0)) return out;
  }
}

function berInt(tag: number, v: number | bigint): number[] {
  return tlv(tag, intBytes(BigInt(v)));
}

function latin1Bytes(field: string, s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0xff) throw new Error(`${field} holds a character outside one byte (Latin-1), got "${s}"`);
    out.push(c);
  }
  return out;
}

function oidContent(field: string, oid: string): number[] {
  if (!OID_RE.test(oid)) throw new Error(`${field} must be a dotted object identifier with at least two arcs, got "${oid}"`);
  const arcs = oid.replace(/^\./, '').split('.').map(Number);
  for (const a of arcs) if (!Number.isSafeInteger(a) || a > U32_MAX) throw new Error(`${field} has an arc above 2^32-1: "${oid}"`);
  const [a0, a1] = arcs as [number, number];
  if (a0 > 2 || (a0 < 2 && a1 >= 40)) throw new Error(`${field} starts with an invalid pair ${a0}.${a1}`);
  const out: number[] = [];
  for (const arc of [a0 * 40 + a1, ...arcs.slice(2)]) {
    const sub: number[] = [arc % 128];
    for (let v = Math.floor(arc / 128); v > 0; v = Math.floor(v / 128)) sub.unshift(0x80 | (v % 128));
    out.push(...sub);
  }
  return out;
}

function u32(field: string, v: number): number {
  if (!Number.isInteger(v) || v < 0 || v > U32_MAX) throw new Error(`${field} must be an integer 0..4294967295, got ${v}`);
  return v;
}

function valueBytes(oid: string, v: SnmpValue): number[] {
  const field = `snmp.varbinds ${oid}`;
  switch (v.type) {
    case 'integer':
      if (!Number.isInteger(v.value) || v.value < I32_MIN || v.value > I32_MAX) throw new Error(`${field} integer out of range: ${v.value}`);
      return berInt(BER_TAG.integer, v.value);
    case 'octets':
      return tlv(BER_TAG.octets, latin1Bytes(field, v.value));
    case 'oid':
      return tlv(BER_TAG.oid, oidContent(field, v.value));
    case 'ipaddress':
      if (!isIpv4(v.value)) throw new Error(`${field} ipaddress must be dotted IPv4, got "${v.value}"`);
      return tlv(BER_TAG.ipaddress, ipv4ToBytes(v.value));
    case 'counter32':
    case 'gauge32':
    case 'timeticks':
      return berInt(BER_TAG[v.type], u32(`${field} ${v.type}`, v.value));
    case 'counter64': {
      if (!DECIMAL_RE.test(v.value) || BigInt(v.value) > U64_MAX) throw new Error(`${field} counter64 must be decimal 0..2^64-1, got "${v.value}"`);
      return berInt(BER_TAG.counter64, BigInt(v.value));
    }
    case 'null':
      return [BER_TAG.null, 0];
    case 'noSuchObject':
    case 'noSuchInstance':
    case 'endOfMibView':
      return [BER_TAG[v.type], 0];
  }
}

// ── the varbind text ───────────────────────────────────────────────────────────────────────────────────────────────

function isPrintable(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

/** The text of one value: `<type>` or `<type>:<value>` (see the header). */
export function snmpValueText(v: SnmpValue): string {
  switch (v.type) {
    case 'octets': {
      if (isPrintable(v.value)) return `octets:${JSON.stringify(v.value)}`;
      let h = '';
      for (let i = 0; i < v.value.length; i++) h += hex2(v.value.charCodeAt(i) & 0xff);
      return `octets:0x${h}`;
    }
    case 'null':
    case 'noSuchObject':
    case 'noSuchInstance':
    case 'endOfMibView':
      return v.type;
    default:
      return `${v.type}:${String(v.value)}`;
  }
}

/** The `snmp.varbinds` text of a varbind list (entries joined by '; '). */
export function snmpVarbindsText(list: readonly SnmpVarbind[]): string {
  return list.map((vb) => `${vb.oid}=${snmpValueText(vb.value)}`).join('; ');
}

function parseValue(type: string, raw: string | undefined, where: string): SnmpValue {
  if (EMPTY_TYPES.has(type)) {
    if (raw !== undefined) throw new Error(`${where}: ${type} takes no value`);
    return { type } as SnmpValue;
  }
  if (raw === undefined) throw new Error(`${where}: ${type} needs a value`);
  switch (type) {
    case 'integer':
    case 'counter32':
    case 'gauge32':
    case 'timeticks': {
      if (!SIGNED_RE.test(raw)) throw new Error(`${where}: ${type} value must be an integer, got "${raw}"`);
      const n = Number(raw);
      if (type === 'integer' ? n < I32_MIN || n > I32_MAX : n < 0 || n > U32_MAX) throw new Error(`${where}: ${type} value out of range: ${raw}`);
      return UNSIGNED_TYPES.has(type) ? { type: type as 'counter32', value: n } : { type: 'integer', value: n };
    }
    case 'counter64':
      if (!DECIMAL_RE.test(raw) || BigInt(raw) > U64_MAX) throw new Error(`${where}: counter64 value must be decimal 0..2^64-1, got "${raw}"`);
      return { type: 'counter64', value: raw };
    case 'oid':
      oidContent(where, raw);
      return { type: 'oid', value: raw };
    case 'ipaddress':
      if (!isIpv4(raw)) throw new Error(`${where}: ipaddress value must be dotted IPv4, got "${raw}"`);
      return { type: 'ipaddress', value: raw };
    case 'octets': {
      if (raw.startsWith('0x')) {
        const h = raw.slice(2).toLowerCase();
        if (!HEX_RE.test(h)) throw new Error(`${where}: octets hex value must be pairs of hex digits, got "${raw}"`);
        let s = '';
        for (let i = 0; i < h.length; i += 2) s += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
        return { type: 'octets', value: s };
      }
      let s: unknown;
      try {
        s = JSON.parse(raw);
      } catch {
        throw new Error(`${where}: octets value must be a quoted string or 0x hex, got ${raw}`);
      }
      if (typeof s !== 'string') throw new Error(`${where}: octets value must be a quoted string or 0x hex, got ${raw}`);
      latin1Bytes(where, s);
      return { type: 'octets', value: s };
    }
    default:
      throw new Error(`${where}: unknown value type "${type}"`);
  }
}

/** The end (exclusive) of the JSON string literal starting at `at` (a '"'), or -1. */
function quotedEnd(text: string, at: number): number {
  for (let i = at + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === '"') return i + 1;
  }
  return -1;
}

/** The varbind list of a `snmp.varbinds` text; '' is the empty list. Throws on text this codec would not write. */
export function parseSnmpVarbinds(text: string): SnmpVarbind[] {
  const out: SnmpVarbind[] = [];
  let i = 0;
  while (i < text.length) {
    const where = `snmp.varbinds entry ${out.length + 1}`;
    const eq = text.indexOf('=', i);
    if (eq < 0) throw new Error(`${where}: expected <oid>=<type>`);
    const oid = text.slice(i, eq);
    oidContent(where, oid);
    let j = eq + 1;
    let k = j;
    while (k < text.length && /[A-Za-z0-9]/.test(text[k]!)) k++;
    const type = text.slice(j, k);
    let raw: string | undefined;
    if (text[k] === ':') {
      j = k + 1;
      if (type === 'octets' && text[j] === '"') {
        k = quotedEnd(text, j);
        if (k < 0) throw new Error(`${where}: unterminated quoted octets value`);
      } else {
        k = text.indexOf(';', j);
        if (k < 0) k = text.length;
      }
      raw = text.slice(j, k);
    }
    out.push({ oid, value: parseValue(type, raw, where) });
    if (k === text.length) break;
    if (text[k] !== ';') throw new Error(`${where}: expected '; ' after the value`);
    i = k + 1;
    while (text[i] === ' ') i++;
    if (i === text.length) throw new Error(`${where}: a '; ' with no entry after it`);
  }
  return out;
}

// ── decode ─────────────────────────────────────────────────────────────────────────────────────────────────────────

type Fields = Record<string, FieldValue>;
type Ranges = Record<string, readonly [number, number]>;

function range(r: Ranges, key: string, t: Tlv): void {
  r[key] = [t.content, t.end - t.content];
}

/** The PDU at `at` (its TLV must end exactly at `end`). */
function decodePdu(b: Uint8Array, at: number, end: number, fields: Fields, r: Ranges): void {
  const p = readTlv(b, at, end, 'PDU');
  const name = PDU_BY_TAG.get(p.tag);
  if (name === undefined) {
    throw new BerFault(p.tag === 0xa4 ? 'SNMPv1 Trap-PDU is not simulated' : `SNMP PDU type 0x${hex2(p.tag)} is not simulated`);
  }
  fields.pdu = name;
  r.pdu = [p.start, p.content - p.start];
  const rid = expectTlv(b, p.content, p.end, BER_TAG.integer, 'request-id');
  fields.requestId = readInt(b, rid, 'request-id', I32_MIN, I32_MAX);
  range(r, 'requestId', rid);
  const e1 = expectTlv(b, rid.end, p.end, BER_TAG.integer, name === 'getbulk' ? 'non-repeaters' : 'error-status');
  const e2 = expectTlv(b, e1.end, p.end, BER_TAG.integer, name === 'getbulk' ? 'max-repetitions' : 'error-index');
  const [k1, k2] = name === 'getbulk' ? ['nonRepeaters', 'maxRepetitions'] : ['errorStatus', 'errorIndex'];
  fields[k1] = readInt(b, e1, k1, 0, I32_MAX);
  range(r, k1, e1);
  fields[k2] = readInt(b, e2, k2, 0, I32_MAX);
  range(r, k2, e2);
  const list = expectTlv(b, e2.end, p.end, BER_TAG.sequence, 'variable-bindings');
  if (list.end !== p.end) throw new BerFault('SNMP PDU has bytes after its variable-bindings');
  const vbs: SnmpVarbind[] = [];
  let i = list.content;
  while (i < list.end) {
    const vb = expectTlv(b, i, list.end, BER_TAG.sequence, `varbind ${vbs.length + 1}`);
    const name1 = expectTlv(b, vb.content, vb.end, BER_TAG.oid, `varbind ${vbs.length + 1} name`);
    const oid = readOid(b, name1, `varbind ${vbs.length + 1} name`);
    const val = readTlv(b, name1.end, vb.end, `varbind ${vbs.length + 1} value`);
    if (val.end !== vb.end) throw new BerFault(`SNMP varbind ${vbs.length + 1} has bytes after its value`);
    vbs.push({ oid, value: readValue(b, val) });
    i = vb.end;
  }
  fields.varbinds = snmpVarbindsText(vbs);
  range(r, 'varbinds', list);
  if (p.end !== end) throw new BerFault('SNMP message has bytes after its PDU');
}

function decodeV3(b: Uint8Array, at: number, end: number, fields: Fields, r: Ranges): void {
  const g = expectTlv(b, at, end, BER_TAG.sequence, 'msgGlobalData');
  const id = expectTlv(b, g.content, g.end, BER_TAG.integer, 'msgID');
  fields.msgId = readInt(b, id, 'msgID', 0, I32_MAX);
  range(r, 'msgId', id);
  const max = expectTlv(b, id.end, g.end, BER_TAG.integer, 'msgMaxSize');
  fields.msgMaxSize = readInt(b, max, 'msgMaxSize', 0, I32_MAX);
  range(r, 'msgMaxSize', max);
  const fl = expectTlv(b, max.end, g.end, BER_TAG.octets, 'msgFlags');
  if (fl.end - fl.content !== 1) throw new BerFault('SNMP msgFlags is not one byte');
  const flags = b[fl.content]!;
  fields.msgFlags = flags;
  range(r, 'msgFlags', fl);
  const sm = expectTlv(b, fl.end, g.end, BER_TAG.integer, 'msgSecurityModel');
  fields.securityModel = readInt(b, sm, 'msgSecurityModel', 0, I32_MAX);
  range(r, 'securityModel', sm);
  if (sm.end !== g.end) throw new BerFault('SNMP msgGlobalData has bytes after its security model');
  const sp = expectTlv(b, g.end, end, BER_TAG.octets, 'msgSecurityParameters');
  if (fields.securityModel !== SNMP_USM_MODEL) throw new BerFault(`SNMP security model ${String(fields.securityModel)} is not simulated`);
  const usm = expectTlv(b, sp.content, sp.end, BER_TAG.sequence, 'USM parameters');
  if (usm.end !== sp.end) throw new BerFault('SNMP USM parameters have bytes after them');
  const eid = expectTlv(b, usm.content, usm.end, BER_TAG.octets, 'msgAuthoritativeEngineID');
  fields.engineId = b.slice(eid.content, eid.end);
  range(r, 'engineId', eid);
  const boots = expectTlv(b, eid.end, usm.end, BER_TAG.integer, 'msgAuthoritativeEngineBoots');
  fields.engineBoots = readInt(b, boots, 'msgAuthoritativeEngineBoots', 0, I32_MAX);
  range(r, 'engineBoots', boots);
  const time = expectTlv(b, boots.end, usm.end, BER_TAG.integer, 'msgAuthoritativeEngineTime');
  fields.engineTime = readInt(b, time, 'msgAuthoritativeEngineTime', 0, I32_MAX);
  range(r, 'engineTime', time);
  const user = expectTlv(b, time.end, usm.end, BER_TAG.octets, 'msgUserName');
  fields.userName = latin1(b, user.content, user.end);
  range(r, 'userName', user);
  const auth = expectTlv(b, user.end, usm.end, BER_TAG.octets, 'msgAuthenticationParameters');
  fields.authParams = b.slice(auth.content, auth.end);
  range(r, 'authParams', auth);
  const priv = expectTlv(b, auth.end, usm.end, BER_TAG.octets, 'msgPrivacyParameters');
  fields.privParams = b.slice(priv.content, priv.end);
  range(r, 'privParams', priv);
  if (priv.end !== usm.end) throw new BerFault('SNMP USM parameters have bytes after the privacy parameters');
  if ((flags & SNMP_V3_FLAGS.priv) !== 0) {
    const enc = expectTlv(b, sp.end, end, BER_TAG.octets, 'encryptedPDU');
    fields.encrypted = b.slice(enc.content, enc.end);
    range(r, 'encrypted', enc);
    if (enc.end !== end) throw new BerFault('SNMP message has bytes after its encrypted PDU');
    return;
  }
  const scoped = expectTlv(b, sp.end, end, BER_TAG.sequence, 'ScopedPDU');
  if (scoped.end !== end) throw new BerFault('SNMP message has bytes after its ScopedPDU');
  const ce = expectTlv(b, scoped.content, scoped.end, BER_TAG.octets, 'contextEngineID');
  fields.contextEngineId = b.slice(ce.content, ce.end);
  range(r, 'contextEngineId', ce);
  const cn = expectTlv(b, ce.end, scoped.end, BER_TAG.octets, 'contextName');
  fields.contextName = latin1(b, cn.content, cn.end);
  range(r, 'contextName', cn);
  decodePdu(b, cn.end, scoped.end, fields, r);
}

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const end = offset + avail;
  const fields: Fields = {};
  const fieldRanges: Ranges = {};
  const out: DecodedLayer = { fields, fieldRanges, headerLength: avail, length: avail };
  try {
    const msg = expectTlv(bytes, offset, end, BER_TAG.sequence, 'message');
    if (msg.end !== end) throw new BerFault('SNMP message is followed by other bytes');
    const ver = expectTlv(bytes, msg.content, msg.end, BER_TAG.integer, 'version');
    const version = readInt(bytes, ver, 'version', I32_MIN, I32_MAX);
    fields.version = version;
    range(fieldRanges, 'version', ver);
    if (version === SNMP_VERSION.v1 || version === SNMP_VERSION.v2c) {
      const c = expectTlv(bytes, ver.end, msg.end, BER_TAG.octets, 'community');
      fields.community = latin1(bytes, c.content, c.end);
      range(fieldRanges, 'community', c);
      decodePdu(bytes, c.end, msg.end, fields, fieldRanges);
    } else if (version === SNMP_VERSION.v3) {
      decodeV3(bytes, ver.end, msg.end, fields, fieldRanges);
    } else {
      throw new BerFault(`SNMP version ${version} is not defined`);
    }
    fields.malformed = false;
  } catch (e) {
    if (!(e instanceof BerFault)) throw e;
    fields.malformed = true;
    out.error = e.message;
  }
  return out;
}

// ── encode ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function int(fields: Readonly<Fields>, key: string, dflt: number | null, min: number, max: number): number {
  const v = numField('snmp', fields, key, dflt);
  if (v < min || v > max) throw new Error(`snmp.${key} out of range: ${v}`);
  return v;
}

function octetsField(fields: Readonly<Fields>, key: string): Uint8Array {
  const v = fields[key];
  if (v === undefined || v === null) return new Uint8Array(0);
  if (v instanceof Uint8Array) return v;
  throw new Error(`snmp.${key} must be a Uint8Array`);
}

function pduBytes(fields: Readonly<Fields>): number[] {
  const name = strField('snmp', fields, 'pdu', null);
  const tag = SNMP_PDU_TAG[name];
  if (tag === undefined) throw new Error(`snmp.pdu must be one of ${Object.keys(SNMP_PDU_TAG).join(', ')}, got "${name}"`);
  const [k1, k2] = name === 'getbulk' ? ['nonRepeaters', 'maxRepetitions'] : ['errorStatus', 'errorIndex'];
  const list: number[] = [];
  for (const vb of parseSnmpVarbinds(strField('snmp', fields, 'varbinds', ''))) {
    list.push(...tlv(BER_TAG.sequence, [...tlv(BER_TAG.oid, oidContent(`snmp.varbinds ${vb.oid}`, vb.oid)), ...valueBytes(vb.oid, vb.value)]));
  }
  return tlv(tag, [
    ...berInt(BER_TAG.integer, int(fields, 'requestId', 0, I32_MIN, I32_MAX)),
    ...berInt(BER_TAG.integer, int(fields, k1, 0, 0, I32_MAX)),
    ...berInt(BER_TAG.integer, int(fields, k2, 0, 0, I32_MAX)),
    ...tlv(BER_TAG.sequence, list),
  ]);
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  if (payload.length > 0) throw new Error('snmp: an SNMP message carries no inner layer');
  const version = int(fields, 'version', SNMP_VERSION.v2c, 0, I32_MAX);
  const ver = berInt(BER_TAG.integer, version);
  if (version === SNMP_VERSION.v1 || version === SNMP_VERSION.v2c) {
    const community = latin1Bytes('snmp.community', strField('snmp', fields, 'community', null));
    return Uint8Array.from(tlv(BER_TAG.sequence, [...ver, ...tlv(BER_TAG.octets, community), ...pduBytes(fields)]));
  }
  if (version !== SNMP_VERSION.v3) throw new Error(`snmp.version must be 0 (v1), 1 (v2c) or 3 (v3), got ${version}`);
  const flags = int(fields, 'msgFlags', 0, 0, 0xff);
  const model = int(fields, 'securityModel', SNMP_USM_MODEL, 0, I32_MAX);
  if (model !== SNMP_USM_MODEL) throw new Error(`snmp.securityModel must be ${SNMP_USM_MODEL} (USM), got ${model}`);
  const global = tlv(BER_TAG.sequence, [
    ...berInt(BER_TAG.integer, int(fields, 'msgId', 0, 0, I32_MAX)),
    ...berInt(BER_TAG.integer, int(fields, 'msgMaxSize', 65507, 0, I32_MAX)),
    ...tlv(BER_TAG.octets, [flags]),
    ...berInt(BER_TAG.integer, model),
  ]);
  const usm = tlv(BER_TAG.sequence, [
    ...tlv(BER_TAG.octets, octetsField(fields, 'engineId')),
    ...berInt(BER_TAG.integer, int(fields, 'engineBoots', 0, 0, I32_MAX)),
    ...berInt(BER_TAG.integer, int(fields, 'engineTime', 0, 0, I32_MAX)),
    ...tlv(BER_TAG.octets, latin1Bytes('snmp.userName', strField('snmp', fields, 'userName', ''))),
    ...tlv(BER_TAG.octets, octetsField(fields, 'authParams')),
    ...tlv(BER_TAG.octets, octetsField(fields, 'privParams')),
  ]);
  let data: number[];
  if ((flags & SNMP_V3_FLAGS.priv) !== 0) {
    const enc = fields.encrypted;
    if (!(enc instanceof Uint8Array)) throw new Error('snmp.encrypted is required (a Uint8Array) when msgFlags has the privacy bit');
    data = tlv(BER_TAG.octets, enc);
  } else {
    data = tlv(BER_TAG.sequence, [
      ...tlv(BER_TAG.octets, octetsField(fields, 'contextEngineId')),
      ...tlv(BER_TAG.octets, latin1Bytes('snmp.contextName', strField('snmp', fields, 'contextName', ''))),
      ...pduBytes(fields),
    ]);
  }
  return Uint8Array.from(tlv(BER_TAG.sequence, [...ver, ...global, ...tlv(BER_TAG.octets, usm), ...data]));
}

// ── summary ────────────────────────────────────────────────────────────────────────────────────────────────────────

function levelText(flags: number): string {
  if ((flags & SNMP_V3_FLAGS.priv) !== 0) return 'authPriv';
  return (flags & SNMP_V3_FLAGS.auth) !== 0 ? 'authNoPriv' : 'noAuthNoPriv';
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const v = fields.version;
  const ver = v === SNMP_VERSION.v1 ? 'v1' : v === SNMP_VERSION.v2c ? 'v2c' : v === SNMP_VERSION.v3 ? 'v3' : '';
  if (fields.malformed === true) return ver === '' ? 'SNMP (malformed)' : `SNMP ${ver} (malformed)`;
  const who = ver === 'v3'
    ? ` (user "${String(fields.userName ?? '')}", ${levelText(typeof fields.msgFlags === 'number' ? fields.msgFlags : 0)})`
    : ` (community "${String(fields.community ?? '')}")`;
  if (fields.encrypted instanceof Uint8Array) return `SNMP v3 encrypted PDU${who}`;
  const pdu = typeof fields.pdu === 'string' ? PDU_TEXT[fields.pdu] ?? fields.pdu : '?';
  const id = typeof fields.requestId === 'number' ? ` #${fields.requestId}` : '';
  let err = '';
  if (typeof fields.errorStatus === 'number' && fields.errorStatus !== 0) {
    err = `, ${ERROR_TEXT.get(fields.errorStatus) ?? `error ${fields.errorStatus}`} at ${String(fields.errorIndex ?? '?')}`;
  }
  let vbs = '';
  if (typeof fields.varbinds === 'string') {
    let n = 0;
    try {
      n = parseSnmpVarbinds(fields.varbinds).length;
    } catch {
      return `SNMP ${ver} ${pdu}${id}${who}${err}, varbinds unreadable`;
    }
    const first = n === 0 ? '' : `: ${fields.varbinds.slice(0, fields.varbinds.indexOf('='))}${n > 1 ? ', …' : ''}`;
    vbs = `, ${n} varbind${n === 1 ? '' : 's'}${first}`;
  }
  return `SNMP ${ver} ${pdu}${id}${who}${err}${vbs}`;
}

/**
 * SNMP codec [S33] [C23]. Required on encode: `pdu` (unless the v3 message is encrypted) and, for v1 / v2c,
 * `community`; `version` defaults to 1 (v2c).
 */
export const snmpCodec: Codec = {
  proto: 'snmp',
  defaults: Object.freeze({ version: SNMP_VERSION.v2c, community: null, pdu: null, requestId: 0, varbinds: '' }),
  decode,
  encode,
  summarize,
};
