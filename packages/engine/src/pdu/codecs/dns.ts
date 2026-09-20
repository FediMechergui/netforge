/**
 * DNS codec (RFC 1035 §4; AAAA RFC 3596; TCP framing RFC 1035 §4.2.2 / RFC 7766) — ARCHITECTURE-P1 §4.4,
 * contracts/fields.ts `dns`.
 *
 * Wire image: `id(2) flags(2: QR opcode(4) AA TC RD RA Z(3) RCODE(4)) qdcount(2) ancount(2) nscount(2) arcount(2)`
 * then the question entries (`name type(2) class(2)`) and the answer, authority and additional records
 * (`name type(2) class(2) ttl(4) rdlength(2) rdata`).
 *  • List-valued sections stay scalar strings (fields.ts): `questions` = 'name TYPE' entries and `answers` /
 *    `authorities` / `additionals` = 'name TYPE ttl data' entries, joined by ';'. Names are lowercase without the
 *    trailing dot ('.' is the root). Record data: A dotted IPv4, AAAA RFC 5952 text, CNAME/NS/PTR a name, MX
 *    'pref host', SOA 'mname rname serial refresh retry expire minimum', any other type `TYPE<n>` with the rdata
 *    as hex. Class is always IN on encode; other classes decode without being shown.
 *  • Name compression (RFC 1035 §4.1.4) is decoded (pointers followed with a loop guard), never encoded.
 *  • Over TCP (the nearest transport layer in the CodecContext is `tcp`) the message carries a 2-byte length
 *    prefix, decoded as `tcpLength` (derived). A message longer than the bytes present decodes what is there
 *    with error 'partial' (the rest travels in later segments).
 *  • Decode errors: header truncated, a section running past the message, a compression loop, a label too long.
 *  • The layer covers everything the transport hands down; it never chains further.
 *
 * `parseDnsQuestions` / `parseDnsRecords` / `formatDnsQuestions` / `formatDnsRecords` convert between the field
 * strings and structured values for the DNS daemons.
 */
import type { Codec, CodecContext, DecodedLayer, FieldValue, MutationReason } from '../../contracts/pdu.js';
import { bytesToIpv4, ipv4ToBytes, isIpv4 } from '../../contracts/addr.js';
import { DNS_TYPE_CODE } from '../../contracts/services.js';
import type { DnsRecord, DnsType } from '../../contracts/services.js';
import { bytesToIpv6, parseIpv6 } from '../../core/addr6.js';
import { numField, readU16, readU32, writeU16 } from '../checksum.js';

/** DNS header length. */
export const DNS_HEADER = 12;
/** Class IN. */
export const DNS_CLASS_IN = 1;

const DERIVED: Readonly<Record<string, MutationReason>> = Object.freeze({ tcpLength: 'Other' });

const TYPE_BY_CODE: ReadonlyMap<number, DnsType> = new Map(
  (Object.keys(DNS_TYPE_CODE) as DnsType[]).map((t) => [DNS_TYPE_CODE[t], t] as [number, DnsType]),
);

/** Text name of a DNS type code (`TYPE<n>` when not simulated). */
export function dnsTypeName(code: number): string {
  return TYPE_BY_CODE.get(code) ?? `TYPE${code}`;
}

/** Type code for a type name (A, AAAA, …, or `TYPE<n>`), or undefined. */
export function dnsTypeCode(name: string): number | undefined {
  const u = name.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(DNS_TYPE_CODE, u)) return DNS_TYPE_CODE[u as DnsType];
  const m = /^TYPE(\d{1,5})$/.exec(u);
  if (m) {
    const n = Number(m[1]);
    return n <= 0xffff ? n : undefined;
  }
  return undefined;
}

/** Response code names (RFC 1035 §4.1.1). */
export function dnsRcodeName(rcode: number): string {
  switch (rcode) {
    case 0:
      return 'NOERROR';
    case 1:
      return 'FORMERR';
    case 2:
      return 'SERVFAIL';
    case 3:
      return 'NXDOMAIN';
    case 4:
      return 'NOTIMP';
    case 5:
      return 'REFUSED';
    default:
      return `RCODE${rcode}`;
  }
}

/** Lowercase, no trailing dot; the root is '.'. */
export function normalizeDnsName(name: string): string {
  const t = name.trim().toLowerCase();
  if (t === '' || t === '.') return '.';
  return t.endsWith('.') ? t.slice(0, -1) : t;
}

/**
 * True when `name` survives `writeName`: labels of 1–63 printable ASCII bytes without spaces, 255 bytes in all.
 * ';' is excluded too because it separates entries in the questions/answers fields. Callers validate what a user
 * typed (a name to resolve, an `ip dns record`) so that a typo is refused instead of throwing out of the encoder.
 */
export function isValidDnsName(name: string): boolean {
  const n = normalizeDnsName(name);
  if (n === '.') return true;
  let total = 1;
  for (const label of n.split('.')) {
    if (label.length === 0 || label.length > 63) return false;
    for (let i = 0; i < label.length; i++) {
      const c = label.charCodeAt(i);
      if (c <= 0x20 || c > 0x7e || c === 0x3b) return false;
    }
    total += label.length + 1;
  }
  return total <= 255;
}

/** One question entry. */
export interface DnsQuestion {
  name: string;
  type: string;
}

/** Split a ';'-joined field into trimmed, non-empty entries. */
function entries(text: FieldValue | undefined): string[] {
  if (typeof text !== 'string') return [];
  return text.split(';').map((e) => e.trim()).filter((e) => e !== '');
}

/** Parse a `questions` field ('name TYPE;…'). Throws on a malformed entry. */
export function parseDnsQuestions(text: FieldValue | undefined): DnsQuestion[] {
  return entries(text).map((e) => {
    const t = e.split(/\s+/);
    if (t.length !== 2) throw new Error(`dns question "${e}" must be "name TYPE"`);
    return { name: normalizeDnsName(t[0]!), type: t[1]!.toUpperCase() };
  });
}

/** Format questions as the `questions` field. */
export function formatDnsQuestions(qs: readonly DnsQuestion[]): string {
  return qs.map((q) => `${normalizeDnsName(q.name)} ${q.type.toUpperCase()}`).join(';');
}

/** Parse an `answers`-style field ('name TYPE ttl data;…'). Throws on a malformed entry. */
export function parseDnsRecords(text: FieldValue | undefined): DnsRecord[] {
  return entries(text).map((e) => {
    const t = e.split(/\s+/);
    if (t.length < 4) throw new Error(`dns record "${e}" must be "name TYPE ttl data"`);
    const ttl = Number(t[2]);
    if (!Number.isInteger(ttl) || ttl < 0 || ttl > 0xffffffff) throw new Error(`dns record "${e}" has a bad ttl`);
    return { name: normalizeDnsName(t[0]!), type: t[1]!.toUpperCase() as DnsType, ttl, data: t.slice(3).join(' ') };
  });
}

/** Format records as an `answers`-style field. */
export function formatDnsRecords(records: readonly DnsRecord[]): string {
  return records.map((r) => `${normalizeDnsName(r.name)} ${r.type.toUpperCase()} ${r.ttl} ${r.data}`).join(';');
}

// ── wire helpers ─────────────────────────────────────────────────────────────

class DnsDecodeError extends Error {}

/** Read a (possibly compressed) name at `pos`; pointers are offsets from `base`; every byte read lies before `end`. */
function readName(b: Uint8Array, pos: number, base: number, end: number): { name: string; next: number } {
  const labels: string[] = [];
  let p = pos;
  let next = -1;
  let jumps = 0;
  let total = 0;
  for (;;) {
    if (p >= end) throw new DnsDecodeError('DNS message truncated');
    const len = b[p]!;
    if (len === 0) {
      if (next < 0) next = p + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (p + 1 >= end) throw new DnsDecodeError('DNS message truncated');
      if (++jumps > 64) throw new DnsDecodeError('DNS name compression loop');
      if (next < 0) next = p + 2;
      p = base + (((len & 0x3f) << 8) | b[p + 1]!);
      continue;
    }
    if ((len & 0xc0) !== 0) throw new DnsDecodeError(`DNS label type 0x${(len & 0xc0).toString(16)} is not supported`);
    if (p + 1 + len > end) throw new DnsDecodeError('DNS message truncated');
    total += len + 1;
    if (total > 255) throw new DnsDecodeError('DNS name longer than 255 bytes');
    let s = '';
    for (let i = p + 1; i <= p + len; i++) s += String.fromCharCode(b[i]!);
    labels.push(s.toLowerCase());
    p += 1 + len;
  }
  return { name: labels.length === 0 ? '.' : labels.join('.'), next };
}

function hexOf(b: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i < to; i++) s += b[i]!.toString(16).padStart(2, '0');
  return s;
}

function readRdata(b: Uint8Array, type: number, from: number, len: number, base: number, end: number): string {
  const to = from + len;
  switch (type) {
    case DNS_TYPE_CODE.A:
      if (len !== 4) throw new DnsDecodeError(`DNS A record with ${len} data bytes`);
      return bytesToIpv4(b, from);
    case DNS_TYPE_CODE.AAAA:
      if (len !== 16) throw new DnsDecodeError(`DNS AAAA record with ${len} data bytes`);
      return bytesToIpv6(b, from);
    case DNS_TYPE_CODE.CNAME:
    case DNS_TYPE_CODE.NS:
    case DNS_TYPE_CODE.PTR:
      return readName(b, from, base, end).name;
    case DNS_TYPE_CODE.MX: {
      if (len < 3) throw new DnsDecodeError(`DNS MX record with ${len} data bytes`);
      return `${readU16(b, from)} ${readName(b, from + 2, base, end).name}`;
    }
    case DNS_TYPE_CODE.SOA: {
      const m = readName(b, from, base, end);
      const r = readName(b, m.next, base, end);
      if (r.next + 20 > to) throw new DnsDecodeError('DNS SOA record truncated');
      const n: number[] = [];
      for (let i = 0; i < 5; i++) n.push(readU32(b, r.next + i * 4));
      return `${m.name} ${r.name} ${n.join(' ')}`;
    }
    default:
      return hexOf(b, from, to);
  }
}

/** Encode a name as uncompressed labels. */
function writeName(name: string, out: number[]): void {
  const n = normalizeDnsName(name);
  if (n === '.') {
    out.push(0);
    return;
  }
  let total = 1;
  for (const label of n.split('.')) {
    if (label.length === 0) throw new Error(`dns name "${name}" has an empty label`);
    if (label.length > 63) throw new Error(`dns name "${name}" has a label longer than 63 bytes`);
    total += label.length + 1;
    out.push(label.length);
    for (let i = 0; i < label.length; i++) {
      const c = label.charCodeAt(i);
      if (c > 0x7e || c <= 0x20) throw new Error(`dns name "${name}" must be printable ASCII without spaces`);
      out.push(c);
    }
  }
  if (total > 255) throw new Error(`dns name "${name}" is longer than 255 bytes`);
  out.push(0);
}

function writeRdata(r: DnsRecord, code: number): number[] {
  const out: number[] = [];
  const bad = (): Error => new Error(`dns ${r.type} record data "${r.data}" is not valid`);
  switch (code) {
    case DNS_TYPE_CODE.A:
      if (!isIpv4(r.data)) throw bad();
      return [...ipv4ToBytes(r.data.trim())];
    case DNS_TYPE_CODE.AAAA: {
      const b = parseIpv6(r.data);
      if (!b) throw bad();
      return [...b];
    }
    case DNS_TYPE_CODE.CNAME:
    case DNS_TYPE_CODE.NS:
    case DNS_TYPE_CODE.PTR:
      writeName(r.data, out);
      return out;
    case DNS_TYPE_CODE.MX: {
      const t = r.data.trim().split(/\s+/);
      const pref = Number(t[0]);
      if (t.length !== 2 || !Number.isInteger(pref) || pref < 0 || pref > 0xffff) throw bad();
      out.push(pref >>> 8, pref & 0xff);
      writeName(t[1]!, out);
      return out;
    }
    case DNS_TYPE_CODE.SOA: {
      const t = r.data.trim().split(/\s+/);
      if (t.length !== 7) throw bad();
      writeName(t[0]!, out);
      writeName(t[1]!, out);
      for (let i = 2; i < 7; i++) {
        const n = Number(t[i]);
        if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw bad();
        out.push(n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
      }
      return out;
    }
    default: {
      const h = r.data.trim();
      if (!/^([0-9a-fA-F]{2})*$/.test(h)) throw bad();
      for (let i = 0; i < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16));
      return out;
    }
  }
}

/** True when the nearest transport layer around this one is TCP (length-prefixed DNS). */
function overTcp(ctx: CodecContext | undefined): boolean {
  const outer = ctx?.outer ?? [];
  for (let i = outer.length - 1; i >= 0; i--) {
    const p = outer[i]!.proto;
    if (p === 'tcp') return true;
    if (p === 'udp') return false;
  }
  return false;
}

function flagBool(fields: Readonly<Record<string, FieldValue>>, key: string): boolean {
  const v = fields[key];
  return v === true || v === 1;
}

// ── codec ────────────────────────────────────────────────────────────────────

function decode(bytes: Uint8Array, offset: number, length: number, ctx?: CodecContext): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  const tcp = overTcp(ctx);
  let base = offset;
  let end = offset + avail;
  let partial = false;
  if (tcp) {
    if (avail < 2) return { fields, fieldRanges, headerLength: avail, length: avail, error: 'partial' };
    const declared = readU16(bytes, offset);
    fields.tcpLength = declared;
    fieldRanges.tcpLength = [offset, 2];
    base = offset + 2;
    partial = avail - 2 < declared;
    end = base + Math.min(declared, avail - 2);
  }
  const prefix = base - offset;
  if (end - base < DNS_HEADER) {
    if (end - base >= 2) {
      fields.id = readU16(bytes, base);
      fieldRanges.id = [base, 2];
    }
    return { fields, fieldRanges, headerLength: avail, length: avail, error: partial ? 'partial' : 'DNS header truncated' };
  }
  const flags = readU16(bytes, base + 2);
  fields.id = readU16(bytes, base);
  fields.qr = (flags & 0x8000) !== 0;
  fields.opcode = (flags >>> 11) & 0x0f;
  fields.aa = (flags & 0x0400) !== 0;
  fields.tc = (flags & 0x0200) !== 0;
  fields.rd = (flags & 0x0100) !== 0;
  fields.ra = (flags & 0x0080) !== 0;
  fields.rcode = flags & 0x0f;
  fieldRanges.id = [base, 2];
  for (const k of ['qr', 'opcode', 'aa', 'tc', 'rd', 'ra', 'rcode']) fieldRanges[k] = [base + 2, 2];
  const counts = [readU16(bytes, base + 4), readU16(bytes, base + 6), readU16(bytes, base + 8), readU16(bytes, base + 10)];
  fields.questions = '';
  fields.answers = '';
  fields.authorities = '';
  fields.additionals = '';

  let error: string | undefined;
  let p = base + DNS_HEADER;
  try {
    const qs: string[] = [];
    const qStart = p;
    for (let i = 0; i < counts[0]!; i++) {
      const n = readName(bytes, p, base, end);
      if (n.next + 4 > end) throw new DnsDecodeError('DNS message truncated');
      qs.push(`${n.name} ${dnsTypeName(readU16(bytes, n.next))}`);
      p = n.next + 4;
    }
    fields.questions = qs.join(';');
    if (counts[0]! > 0) fieldRanges.questions = [qStart, p - qStart];
    const sections = ['answers', 'authorities', 'additionals'] as const;
    for (let s = 0; s < 3; s++) {
      const rs: string[] = [];
      const sStart = p;
      for (let i = 0; i < counts[s + 1]!; i++) {
        const n = readName(bytes, p, base, end);
        if (n.next + 10 > end) throw new DnsDecodeError('DNS message truncated');
        const type = readU16(bytes, n.next);
        const ttl = readU32(bytes, n.next + 4);
        const rdlen = readU16(bytes, n.next + 8);
        const rd = n.next + 10;
        if (rd + rdlen > end) throw new DnsDecodeError('DNS message truncated');
        rs.push(`${n.name} ${dnsTypeName(type)} ${ttl} ${readRdata(bytes, type, rd, rdlen, base, end)}`);
        p = rd + rdlen;
      }
      fields[sections[s]!] = rs.join(';');
      if (counts[s + 1]! > 0) fieldRanges[sections[s]!] = [sStart, p - sStart];
    }
  } catch (e) {
    if (!(e instanceof DnsDecodeError)) throw e;
    error = e.message;
  }
  const out: DecodedLayer = { fields, fieldRanges, headerLength: prefix + DNS_HEADER, length: avail };
  if (partial) out.error = 'partial';
  else if (error !== undefined) out.error = error;
  return out;
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array, ctx?: CodecContext): Uint8Array {
  const p = 'dns';
  const id = numField(p, fields, 'id', null);
  const opcode = numField(p, fields, 'opcode', 0);
  const rcode = numField(p, fields, 'rcode', 0);
  if (id < 0 || id > 0xffff) throw new Error(`dns.id out of range: ${id}`);
  if (opcode < 0 || opcode > 15) throw new Error(`dns.opcode out of range: ${opcode}`);
  if (rcode < 0 || rcode > 15) throw new Error(`dns.rcode out of range: ${rcode}`);
  const flags =
    (flagBool(fields, 'qr') ? 0x8000 : 0) |
    (opcode << 11) |
    (flagBool(fields, 'aa') ? 0x0400 : 0) |
    (flagBool(fields, 'tc') ? 0x0200 : 0) |
    (flagBool(fields, 'rd') ? 0x0100 : 0) |
    (flagBool(fields, 'ra') ? 0x0080 : 0) |
    rcode;

  const qs = parseDnsQuestions(fields.questions);
  const sections = [parseDnsRecords(fields.answers), parseDnsRecords(fields.authorities), parseDnsRecords(fields.additionals)];
  const body: number[] = [];
  for (const q of qs) {
    const code = dnsTypeCode(q.type);
    if (code === undefined) throw new Error(`dns question type "${q.type}" is unknown`);
    writeName(q.name, body);
    body.push(code >>> 8, code & 0xff, 0, DNS_CLASS_IN);
  }
  for (const records of sections) {
    for (const r of records) {
      const code = dnsTypeCode(r.type);
      if (code === undefined) throw new Error(`dns record type "${r.type}" is unknown`);
      writeName(r.name, body);
      const rdata = writeRdata(r, code);
      if (rdata.length > 0xffff) throw new Error(`dns record data for "${r.name}" is too long`);
      body.push(code >>> 8, code & 0xff, 0, DNS_CLASS_IN);
      body.push(r.ttl >>> 24, (r.ttl >>> 16) & 0xff, (r.ttl >>> 8) & 0xff, r.ttl & 0xff);
      body.push(rdata.length >>> 8, rdata.length & 0xff, ...rdata);
    }
  }
  for (const c of [qs.length, sections[0]!.length, sections[1]!.length, sections[2]!.length]) {
    if (c > 0xffff) throw new Error('dns section has too many entries');
  }
  const msgLen = DNS_HEADER + body.length + payload.length;
  const tcp = overTcp(ctx);
  const prefix = tcp ? 2 : 0;
  if (tcp && msgLen > 0xffff) throw new Error(`dns message too large for TCP framing: ${msgLen} bytes`);
  const out = new Uint8Array(prefix + msgLen);
  if (tcp) writeU16(out, 0, msgLen);
  writeU16(out, prefix, id);
  writeU16(out, prefix + 2, flags);
  writeU16(out, prefix + 4, qs.length);
  writeU16(out, prefix + 6, sections[0]!.length);
  writeU16(out, prefix + 8, sections[1]!.length);
  writeU16(out, prefix + 10, sections[2]!.length);
  out.set(body, prefix + DNS_HEADER);
  out.set(payload, prefix + DNS_HEADER + body.length);
  return out;
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const id = typeof fields.id === 'number' ? `0x${fields.id.toString(16).padStart(4, '0')}` : '?';
  let q = '';
  try {
    q = parseDnsQuestions(fields.questions).map((x) => ` ${x.name} ${x.type}`).join(',');
  } catch {
    q = '';
  }
  if (fields.qr !== true) return `DNS query ${id}${q}`;
  const rcode = typeof fields.rcode === 'number' ? fields.rcode : 0;
  if (rcode !== 0) return `DNS response ${id}${q} ${dnsRcodeName(rcode)}`;
  let data = '';
  try {
    data = parseDnsRecords(fields.answers).map((r) => r.data).join(', ');
  } catch {
    data = '';
  }
  return `DNS response ${id}${q}${data !== '' ? `: ${data}` : ' (no answers)'}`;
}

/** DNS codec. Required on encode: `id`. */
export const dnsCodec: Codec = {
  proto: 'dns',
  defaults: Object.freeze({
    id: null,
    qr: false,
    opcode: 0,
    aa: false,
    tc: false,
    rd: false,
    ra: false,
    rcode: 0,
    questions: '',
    answers: '',
    authorities: '',
    additionals: '',
  }),
  decode,
  encode,
  summarize,
  derived: DERIVED,
};
