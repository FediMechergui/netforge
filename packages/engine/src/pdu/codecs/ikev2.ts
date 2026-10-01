/**
 * IKEv2-lite codec [C13] (RFC 7296 header and generic payload header, original compact payload bodies;
 * ARCHITECTURE-P3 D27, §2.17, §3.13; contracts/fields.ts `ikev2`). UDP port 500.
 *
 * Wire image (big-endian): header (28) `spiI(8) spiR(8) nextPayload(1) version(1)=0x20 exchange(1) flags(1)
 * messageId(4) length(4)`, then payloads, each `nextPayload(1) critical/reserved(1)=0 length(2) body`:
 *   41 N    notify   — `protocol(1)=0 spiSize(1)=0 type(2)`: 24 AUTHENTICATION_FAILED, 14 NO_PROPOSAL_CHOSEN
 *                      (other types decode as 'NOTIFY_<n>')
 *   35 IDi, 36 IDr    — `idType(1)=1 (IPv4) reserved(3) address(4)`
 *   39 AUTH           — `method(1)=2 (shared key) reserved(3) proof bytes` (`auth`: the simulated FNV proof, hex)
 *   33 SA             — the proposal as text (`sa`, e.g. 'enc=aes-cbc-256,integ=sha256,prf=sha256,dh=14')
 *   34 KE             — `group(2)=14 reserved(2) key data` (`ke`, hex)
 *   40 Ni/Nr nonce    — the nonce bytes (`nonce`, hex)
 *   44 TSi, 45 TSr    — the selectors as text ('0.0.0.0/0')
 *  • Encode writes the payloads present in that order (notify, idi, idr, auth, sa, ke, nonce, tsi, tsr: IKE_SA_INIT
 *    gets SA, KE, Ni as in RFC 7296 §1.2); `nextPayload` (the first payload type) and `length` are derived. Decode
 *    follows the payload chain; unknown payload types are skipped by their length.
 *  • `spiI` and `spiR` are 16 hex digits (`spiR` all zeros in the first request); hex fields are lowercase on decode.
 *    IKE_AUTH messages travel in clear inside the PDU, marked `meta.protected` with `protectedBy: 'ike'` by the
 *    sender (simulated SK payload). No byte is ever a configured key: the proofs are FNV values (D27).
 *  • `stopsMeaning`: summary() and topProto() stop here.
 */
import type { Codec, DecodedLayer, FieldValue, MutationReason } from '../../contracts/pdu.js';
import { bytesToIpv4, ipv4ToBytes, isIpv4 } from '../../contracts/addr.js';
import { numField, readU16, readU32, strField, writeU16, writeU32 } from '../checksum.js';

/** IKEv2 exchange types used. */
export const IKEV2_EXCHANGE = Object.freeze({ ikeSaInit: 34, ikeAuth: 35 });
/** Header flag bits. */
export const IKEV2_FLAG = Object.freeze({ initiator: 0x08, response: 0x20 });
/** Payload types (RFC 7296 §3.2). */
export const IKEV2_PAYLOAD = Object.freeze({ sa: 33, ke: 34, idi: 35, idr: 36, auth: 39, nonce: 40, notify: 41, tsi: 44, tsr: 45 });
/** Notify message types used. */
export const IKEV2_NOTIFY: Readonly<Record<string, number>> = Object.freeze({ NO_PROPOSAL_CHOSEN: 14, AUTHENTICATION_FAILED: 24 });
/** IKE header length. */
export const IKEV2_HEADER_BYTES = 28;
/** IKEv2 version byte (major 2, minor 0). */
export const IKEV2_VERSION = 0x20;
/** Diffie-Hellman group named in the KE payload (2048-bit MODP, never computed). */
export const IKEV2_DH_GROUP = 14;

const GENERIC_HEADER = 4;
const ORDER = ['notify', 'idi', 'idr', 'auth', 'sa', 'ke', 'nonce', 'tsi', 'tsr'] as const;
type PayloadKey = (typeof ORDER)[number];
const NOTIFY_NAME: ReadonlyMap<number, string> = new Map(Object.entries(IKEV2_NOTIFY).map(([k, v]) => [v, k]));
const EXCHANGE_TEXT: Readonly<Record<number, string>> = Object.freeze({ 34: 'IKE_SA_INIT', 35: 'IKE_AUTH', 36: 'CREATE_CHILD_SA', 37: 'INFORMATIONAL' });
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });
const UTF8_ENCODER = new TextEncoder();

function toHex(bytes: Uint8Array, offset: number, length: number): string {
  let s = '';
  for (let k = 0; k < length; k++) s += bytes[offset + k]!.toString(16).padStart(2, '0');
  return s;
}

function fromHex(key: string, text: string): number[] {
  if (text.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(text)) throw new Error(`ikev2.${key} must be hex bytes, got "${text}"`);
  const out: number[] = [];
  for (let k = 0; k < text.length; k += 2) out.push(parseInt(text.slice(k, k + 2), 16));
  return out;
}

function decodeBody(key: PayloadKey, bytes: Uint8Array, v: number, len: number): string | undefined {
  switch (key) {
    case 'sa':
    case 'tsi':
    case 'tsr':
      return UTF8_DECODER.decode(bytes.subarray(v, v + len));
    case 'ke':
      return len < 4 ? undefined : toHex(bytes, v + 4, len - 4);
    case 'nonce':
      return toHex(bytes, v, len);
    case 'idi':
    case 'idr':
      return len === 8 && bytes[v] === 1 ? bytesToIpv4(bytes, v + 4) : undefined;
    case 'auth':
      return len < 4 ? undefined : toHex(bytes, v + 4, len - 4);
    case 'notify': {
      if (len < 4) return undefined;
      const type = readU16(bytes, v + 2);
      return NOTIFY_NAME.get(type) ?? `NOTIFY_${type}`;
    }
  }
}

function keyOfType(type: number): PayloadKey | undefined {
  for (const k of ORDER) if (IKEV2_PAYLOAD[k] === type) return k;
  return undefined;
}

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  const o = offset;
  if (avail < IKEV2_HEADER_BYTES) return { fields, fieldRanges, headerLength: avail, length: avail, error: 'IKE header truncated' };
  fields.spiI = toHex(bytes, o, 8);
  fields.spiR = toHex(bytes, o + 8, 8);
  fields.nextPayload = bytes[o + 16]!;
  fields.version = bytes[o + 17]!;
  fields.exchange = bytes[o + 18]!;
  fields.flags = bytes[o + 19]!;
  fields.messageId = readU32(bytes, o + 20);
  fields.length = readU32(bytes, o + 24);
  fieldRanges.spiI = [o, 8];
  fieldRanges.spiR = [o + 8, 8];
  fieldRanges.nextPayload = [o + 16, 1];
  fieldRanges.version = [o + 17, 1];
  fieldRanges.exchange = [o + 18, 1];
  fieldRanges.flags = [o + 19, 1];
  fieldRanges.messageId = [o + 20, 4];
  fieldRanges.length = [o + 24, 4];
  const declared = fields.length;
  let error: string | undefined;
  if (declared < IKEV2_HEADER_BYTES) error = `IKE length ${declared} is smaller than the header`;
  else if (declared > avail) error = `IKE message truncated (length ${declared}, ${avail} bytes present)`;
  const end = o + Math.min(Math.max(declared, IKEV2_HEADER_BYTES), avail);
  let np = fields.nextPayload;
  let i = o + IKEV2_HEADER_BYTES;
  while (np !== 0 && i < end) {
    if (i + GENERIC_HEADER > end) {
      if (error === undefined) error = 'IKE payload header truncated';
      break;
    }
    const next = bytes[i]!;
    const plen = readU16(bytes, i + 2);
    if (plen < GENERIC_HEADER || i + plen > end) {
      if (error === undefined) error = `IKE payload ${np} has a bad length ${plen}`;
      break;
    }
    const key = keyOfType(np);
    if (key !== undefined) {
      const value = decodeBody(key, bytes, i + GENERIC_HEADER, plen - GENERIC_HEADER);
      if (value === undefined) {
        if (error === undefined) error = `IKE payload ${np} is malformed`;
      } else {
        fields[key] = value;
        fieldRanges[key] = [i, plen];
      }
    }
    np = next;
    i += plen;
  }
  const covered = end - o;
  const out: DecodedLayer = { fields, fieldRanges, headerLength: covered, length: covered };
  if (error !== undefined) out.error = error;
  else if (fields.version !== IKEV2_VERSION) out.error = `IKE version 0x${(fields.version as number).toString(16)} is not simulated`;
  return out;
}

function spiBytes(key: string, text: string): number[] {
  if (!/^[0-9a-fA-F]{16}$/.test(text)) throw new Error(`ikev2.${key} must be 16 hex digits, got "${text}"`);
  return fromHex(key, text);
}

function encodeBody(key: PayloadKey, text: string): number[] {
  switch (key) {
    case 'sa':
    case 'tsi':
    case 'tsr':
      return Array.from(UTF8_ENCODER.encode(text));
    case 'ke':
      return [(IKEV2_DH_GROUP >>> 8) & 0xff, IKEV2_DH_GROUP & 0xff, 0, 0, ...fromHex(key, text)];
    case 'nonce':
      return fromHex(key, text);
    case 'idi':
    case 'idr':
      if (!isIpv4(text)) throw new Error(`ikev2.${key} must be an IPv4 address, got "${text}"`);
      return [1, 0, 0, 0, ...ipv4ToBytes(text)];
    case 'auth':
      return [2, 0, 0, 0, ...fromHex(key, text)];
    case 'notify': {
      const type = IKEV2_NOTIFY[text] ?? (/^NOTIFY_\d{1,5}$/.test(text) ? Number(text.slice(7)) : undefined);
      if (type === undefined || type > 0xffff) throw new Error(`ikev2.notify must be one of ${Object.keys(IKEV2_NOTIFY).join(', ')}, got "${text}"`);
      return [0, 0, (type >>> 8) & 0xff, type & 0xff];
    }
  }
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'ikev2';
  if (payload.length > 0) throw new Error('ikev2: an IKE message carries no inner layer');
  const present = ORDER.filter((k) => fields[k] !== undefined && fields[k] !== null);
  const bodies = present.map((k) => encodeBody(k, strField(p, fields, k, null)));
  const payloadBytes = bodies.reduce((n, b) => n + GENERIC_HEADER + b.length, 0);
  const total = IKEV2_HEADER_BYTES + payloadBytes;
  const out = new Uint8Array(total);
  out.set(spiBytes('spiI', strField(p, fields, 'spiI', null)), 0);
  out.set(spiBytes('spiR', strField(p, fields, 'spiR', '0000000000000000')), 8);
  out[16] = present.length > 0 ? IKEV2_PAYLOAD[present[0]!] : 0;
  const u8 = (key: string, dflt: number | null): number => {
    const v = numField(p, fields, key, dflt);
    if (v < 0 || v > 0xff) throw new Error(`ikev2.${key} out of range: ${v}`);
    return v;
  };
  out[17] = u8('version', IKEV2_VERSION);
  out[18] = u8('exchange', null);
  out[19] = u8('flags', 0);
  const messageId = numField(p, fields, 'messageId', 0);
  if (messageId < 0 || messageId > 0xffffffff) throw new Error(`ikev2.messageId out of range: ${messageId}`);
  writeU32(out, 20, messageId);
  writeU32(out, 24, total);
  let i = IKEV2_HEADER_BYTES;
  present.forEach((k, idx) => {
    const body = bodies[idx]!;
    const next = present[idx + 1];
    out[i] = next === undefined ? 0 : IKEV2_PAYLOAD[next];
    out[i + 1] = 0;
    const plen = GENERIC_HEADER + body.length;
    if (plen > 0xffff) throw new Error(`ikev2.${k} payload too large`);
    writeU16(out, i + 2, plen);
    out.set(body, i + GENERIC_HEADER);
    i += plen;
  });
  return out;
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const exchange = typeof fields.exchange === 'number' ? EXCHANGE_TEXT[fields.exchange] ?? `exchange ${fields.exchange}` : '?';
  const response = typeof fields.flags === 'number' && (fields.flags & IKEV2_FLAG.response) !== 0;
  const notify = typeof fields.notify === 'string' ? `, ${fields.notify}` : '';
  return `IKEv2 ${exchange} ${response ? 'response' : 'request'} message ${String(fields.messageId ?? '?')}${notify}`;
}

const DERIVED: Readonly<Record<string, MutationReason>> = Object.freeze({ nextPayload: 'Other', length: 'Other' });

/** IKEv2-lite codec [C13]. Required on encode: `spiI`, `exchange`. */
export const ikev2Codec: Codec = {
  proto: 'ikev2',
  defaults: Object.freeze({ spiI: null, spiR: '0000000000000000', version: IKEV2_VERSION, exchange: null, flags: 0, messageId: 0 }),
  decode,
  encode,
  summarize,
  derived: DERIVED,
  stopsMeaning: () => true,
};
