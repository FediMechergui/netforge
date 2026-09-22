/**
 * Trunk negotiation codec — an ORIGINAL NetForge format (ARCHITECTURE-P2 D8, §2.3, §3.3; contracts/fields.ts `dtp`).
 * Carried as 802.3 + LLC/SNAP with the NF OUI and PID 1 (`nf.pid` space) to the NF L2 control group
 * 03:4e:46:00:00:01. The CCNA name is used as a name only; the layout below is NetForge's own.
 *
 * Wire image (big-endian): `version(1)` followed by TLVs `type(2) length(2) value(length)`, length = value bytes:
 *   type 1 domain      — 0–32 printable ASCII bytes ('' = none; always present)
 *   type 2 adminMode   — 1 byte: 1 access, 2 trunk, 3 desirable, 4 auto (`DTP_MODE_*`)
 *   type 3 operTrunk   — 1 byte: 1 when the sender is trunking, else 0
 *   type 4 trunkType   — 1 byte: 1 = 802.1Q
 *   type 5 neighbor    — 6 bytes: the sender port's MAC
 *  • Encode writes the five TLVs in type order. Decode reads TLVs until the bound; a TLV of type 0 (padding) ends the
 *    list, unknown types are skipped by their length, and the layer covers exactly the TLVs read.
 *  • Decode errors: truncation, a TLV running past the bound, a missing adminMode / operTrunk / neighbor TLV.
 */
import type { Codec, DecodedLayer, FieldValue } from '../../contracts/pdu.js';
import { bytesToMac, macToBytes } from '../../contracts/addr.js';
import { numField, readU16, strField } from '../checksum.js';

/** adminMode values. */
export const DTP_MODE_ACCESS = 1;
export const DTP_MODE_TRUNK = 2;
export const DTP_MODE_DESIRABLE = 3;
export const DTP_MODE_AUTO = 4;
/** trunkType 802.1Q. */
export const DTP_TRUNK_DOT1Q = 1;
/** Longest negotiation domain name. */
export const DTP_DOMAIN_MAX = 32;

const TLV_DOMAIN = 1;
const TLV_ADMIN_MODE = 2;
const TLV_OPER_TRUNK = 3;
const TLV_TRUNK_TYPE = 4;
const TLV_NEIGHBOR = 5;
const TLV_HEADER = 4;

const MODE_TEXT: Readonly<Record<number, string>> = Object.freeze({
  [DTP_MODE_ACCESS]: 'access',
  [DTP_MODE_TRUNK]: 'trunk',
  [DTP_MODE_DESIRABLE]: 'desirable',
  [DTP_MODE_AUTO]: 'auto',
});

/** Text of an adminMode value ('access', 'trunk', 'desirable', 'auto', or 'mode <n>'). */
export function dtpModeText(mode: number): string {
  return MODE_TEXT[mode] ?? `mode ${mode}`;
}

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  if (avail < 1) return { fields, fieldRanges, headerLength: 0, length: 0, error: 'trunk negotiation message truncated' };
  fields.version = bytes[offset]!;
  fieldRanges.version = [offset, 1];
  const end = offset + avail;
  let i = offset + 1;
  let error: string | undefined;
  while (i < end) {
    if (i + TLV_HEADER > end) {
      if (bytes.subarray(i, end).every((b) => b === 0)) break; // trailing zero padding
      error = 'trunk negotiation TLV truncated';
      break;
    }
    const type = readU16(bytes, i);
    const len = readU16(bytes, i + 2);
    if (type === 0) break;
    const v = i + TLV_HEADER;
    if (v + len > end) {
      error = `trunk negotiation TLV ${type} runs past the message`;
      break;
    }
    const range: readonly [number, number] = [i, TLV_HEADER + len];
    switch (type) {
      case TLV_DOMAIN: {
        let s = '';
        for (let k = v; k < v + len; k++) s += String.fromCharCode(bytes[k]!);
        fields.domain = s;
        fieldRanges.domain = range;
        break;
      }
      case TLV_ADMIN_MODE:
        if (len >= 1) {
          fields.adminMode = bytes[v]!;
          fieldRanges.adminMode = range;
        }
        break;
      case TLV_OPER_TRUNK:
        if (len >= 1) {
          fields.operTrunk = bytes[v] !== 0;
          fieldRanges.operTrunk = range;
        }
        break;
      case TLV_TRUNK_TYPE:
        if (len >= 1) {
          fields.trunkType = bytes[v]!;
          fieldRanges.trunkType = range;
        }
        break;
      case TLV_NEIGHBOR:
        if (len >= 6) {
          fields.neighbor = bytesToMac(bytes, v);
          fieldRanges.neighbor = range;
        }
        break;
      default:
        break; // unknown TLV: skipped by its length
    }
    i = v + len;
  }
  const covered = Math.min(i, end) - offset;
  if (error === undefined) {
    const missing = ['adminMode', 'operTrunk', 'neighbor'].filter((k) => fields[k] === undefined);
    if (missing.length > 0) error = `trunk negotiation message has no ${missing.join(', ')}`;
  }
  const out: DecodedLayer = { fields, fieldRanges, headerLength: covered, length: covered };
  if (error !== undefined) out.error = error;
  return out;
}

function tlv(out: number[], type: number, value: readonly number[]): void {
  out.push((type >>> 8) & 0xff, type & 0xff, (value.length >>> 8) & 0xff, value.length & 0xff, ...value);
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'dtp';
  if (payload.length > 0) throw new Error('dtp: a trunk negotiation message carries no inner layer');
  const version = numField(p, fields, 'version', 1);
  if (version < 0 || version > 0xff) throw new Error(`dtp.version out of range: ${version}`);
  const domain = strField(p, fields, 'domain', '');
  if (domain.length > DTP_DOMAIN_MAX) throw new Error(`dtp.domain holds at most ${DTP_DOMAIN_MAX} characters`);
  const domainBytes: number[] = [];
  for (let k = 0; k < domain.length; k++) {
    const c = domain.charCodeAt(k);
    if (c < 0x20 || c > 0x7e) throw new Error('dtp.domain must be printable ASCII');
    domainBytes.push(c);
  }
  const adminMode = numField(p, fields, 'adminMode', null);
  if (MODE_TEXT[adminMode] === undefined) throw new Error(`dtp.adminMode must be 1 (access), 2 (trunk), 3 (desirable) or 4 (auto), got ${adminMode}`);
  const operRaw = fields.operTrunk;
  if (operRaw === undefined || operRaw === null) throw new Error('dtp.operTrunk is required to encode a dtp layer');
  if (typeof operRaw !== 'boolean' && operRaw !== 0 && operRaw !== 1) throw new Error('dtp.operTrunk must be a boolean');
  const trunkType = numField(p, fields, 'trunkType', DTP_TRUNK_DOT1Q);
  if (trunkType < 0 || trunkType > 0xff) throw new Error(`dtp.trunkType out of range: ${trunkType}`);
  let neighbor: Uint8Array;
  const nb = strField(p, fields, 'neighbor', null);
  try {
    neighbor = macToBytes(nb);
  } catch {
    throw new Error(`dtp.neighbor is not a valid MAC address: "${nb}"`);
  }
  const out: number[] = [version];
  tlv(out, TLV_DOMAIN, domainBytes);
  tlv(out, TLV_ADMIN_MODE, [adminMode]);
  tlv(out, TLV_OPER_TRUNK, [operRaw === true || operRaw === 1 ? 1 : 0]);
  tlv(out, TLV_TRUNK_TYPE, [trunkType]);
  tlv(out, TLV_NEIGHBOR, Array.from(neighbor));
  const bytes = new Uint8Array(out.length);
  bytes.set(out);
  return bytes;
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const mode = typeof fields.adminMode === 'number' ? dtpModeText(fields.adminMode) : '?';
  const oper = fields.operTrunk === true ? 'trunking' : 'not trunking';
  const domain = typeof fields.domain === 'string' && fields.domain !== '' ? ` domain ${fields.domain}` : '';
  return `DTP ${mode}, ${oper}, from ${String(fields.neighbor ?? '?')}${domain}`;
}

/** Trunk negotiation codec (NF format). Required on encode: `adminMode`, `operTrunk`, `neighbor`. */
export const dtpCodec: Codec = {
  proto: 'dtp',
  defaults: Object.freeze({ version: 1, domain: '', adminMode: null, operTrunk: null, trunkType: DTP_TRUNK_DOT1Q, neighbor: null }),
  decode,
  encode,
  summarize,
};
