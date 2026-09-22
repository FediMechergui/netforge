/**
 * LACPDU codec (IEEE 802.1AX; ARCHITECTURE-P2 D8, §2.3, §3.7; contracts/fields.ts `lacp`). Reached through the slow
 * protocols ethertype 0x8809 and sent to 01:80:c2:00:00:02.
 *
 * Wire image: the fixed 110-byte LACPDU (big-endian)
 *   `subtype(1)=1 version(1)=1`
 *   `tlv(1)=1 len(1)=20 actorSystemPriority(2) actorSystem(6) actorKey(2) actorPortPriority(2) actorPort(2)
 *    actorState(1) reserved(3)`
 *   `tlv(1)=2 len(1)=20` the six `partner*` twins in the same layout
 *   `tlv(1)=3 len(1)=16 collectorMaxDelay(2) reserved(12)`
 *   `tlv(1)=0 len(1)=0 reserved(50)`
 *  • TLV types, lengths and reserved bytes are derived (always written, checked on decode).
 *  • State bits (actorState / partnerState): bit0 activity, 1 timeout, 2 aggregation, 3 synchronization,
 *    4 collecting, 5 distributing, 6 defaulted, 7 expired (`lacpStateText`).
 *  • Every field defaults to 0 (a zero partner means "no partner known"), MACs to 00:00:00:00:00:00; subtype and
 *    version default to 1. Encode refuses an inner payload and a subtype other than 1.
 *  • Decode errors and stops on a slow-protocols subtype other than 1 (a Marker PDU is not LACP), on truncation and
 *    on a TLV header that is not the fixed layout.
 */
import type { Codec, DecodedLayer, FieldValue } from '../../contracts/pdu.js';
import { bytesToMac, macToBytes, MAC_ZERO } from '../../contracts/addr.js';
import { numField, readU16, strField, writeU16 } from '../checksum.js';

/** Size of a LACPDU. */
export const LACPDU_LENGTH = 110;
/** Slow protocols subtype of LACP. */
export const LACP_SUBTYPE = 1;

/** State bits of actorState / partnerState. */
export const LACP_STATE_ACTIVITY = 0x01;
export const LACP_STATE_TIMEOUT = 0x02;
export const LACP_STATE_AGGREGATION = 0x04;
export const LACP_STATE_SYNC = 0x08;
export const LACP_STATE_COLLECTING = 0x10;
export const LACP_STATE_DISTRIBUTING = 0x20;
export const LACP_STATE_DEFAULTED = 0x40;
export const LACP_STATE_EXPIRED = 0x80;

const STATE_LETTERS = 'ATGSCDFE';

/** State bits as letters in bit order: A activity, T short timeout, G aggregation, S sync, C collecting, D distributing, F defaulted, E expired. */
export function lacpStateText(state: number): string {
  let out = '';
  for (let i = 0; i < 8; i++) if ((state >>> i) & 1) out += STATE_LETTERS[i];
  return out;
}

/** One actor/partner information block: the field-name prefix and its offset in the LACPDU. */
const BLOCKS: readonly { readonly prefix: 'actor' | 'partner'; readonly tlv: number; readonly at: number }[] = Object.freeze([
  Object.freeze({ prefix: 'actor' as const, tlv: 1, at: 2 }),
  Object.freeze({ prefix: 'partner' as const, tlv: 2, at: 22 }),
]);
const COLLECTOR_AT = 42;
const TERMINATOR_AT = 58;
const INFO_LENGTH = 20;
const COLLECTOR_LENGTH = 16;

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  if (avail < 2) return { fields, fieldRanges, headerLength: avail, length: avail, error: 'LACPDU truncated' };
  fields.subtype = bytes[offset]!;
  fields.version = bytes[offset + 1]!;
  fieldRanges.subtype = [offset, 1];
  fieldRanges.version = [offset + 1, 1];
  if (fields.subtype !== LACP_SUBTYPE) {
    return { fields, fieldRanges, headerLength: 2, length: avail, error: `slow protocols subtype ${fields.subtype} is not LACP` };
  }
  if (avail < LACPDU_LENGTH) return { fields, fieldRanges, headerLength: avail, length: avail, error: 'LACPDU truncated' };
  for (const b of BLOCKS) {
    const o = offset + b.at;
    if (bytes[o] !== b.tlv || bytes[o + 1] !== INFO_LENGTH) {
      return { fields, fieldRanges, headerLength: LACPDU_LENGTH, length: LACPDU_LENGTH, error: `bad LACP ${b.prefix} information TLV` };
    }
    fields[`${b.prefix}SystemPriority`] = readU16(bytes, o + 2);
    fields[`${b.prefix}System`] = bytesToMac(bytes, o + 4);
    fields[`${b.prefix}Key`] = readU16(bytes, o + 10);
    fields[`${b.prefix}PortPriority`] = readU16(bytes, o + 12);
    fields[`${b.prefix}Port`] = readU16(bytes, o + 14);
    fields[`${b.prefix}State`] = bytes[o + 16]!;
    fieldRanges[`${b.prefix}SystemPriority`] = [o + 2, 2];
    fieldRanges[`${b.prefix}System`] = [o + 4, 6];
    fieldRanges[`${b.prefix}Key`] = [o + 10, 2];
    fieldRanges[`${b.prefix}PortPriority`] = [o + 12, 2];
    fieldRanges[`${b.prefix}Port`] = [o + 14, 2];
    fieldRanges[`${b.prefix}State`] = [o + 16, 1];
  }
  const c = offset + COLLECTOR_AT;
  if (bytes[c] !== 3 || bytes[c + 1] !== COLLECTOR_LENGTH) {
    return { fields, fieldRanges, headerLength: LACPDU_LENGTH, length: LACPDU_LENGTH, error: 'bad LACP collector information TLV' };
  }
  fields.collectorMaxDelay = readU16(bytes, c + 2);
  fieldRanges.collectorMaxDelay = [c + 2, 2];
  const t = offset + TERMINATOR_AT;
  if (bytes[t] !== 0 || bytes[t + 1] !== 0) {
    return { fields, fieldRanges, headerLength: LACPDU_LENGTH, length: LACPDU_LENGTH, error: 'bad LACP terminator TLV' };
  }
  return { fields, fieldRanges, headerLength: LACPDU_LENGTH, length: LACPDU_LENGTH };
}

function u(fields: Record<string, FieldValue>, key: string, bits: 8 | 16, dflt: number): number {
  const v = numField('lacp', fields, key, dflt);
  if (v < 0 || v > (1 << bits) - 1) throw new Error(`lacp.${key} out of range: ${v}`);
  return v;
}

function mac(fields: Record<string, FieldValue>, key: string): Uint8Array {
  const v = strField('lacp', fields, key, MAC_ZERO);
  try {
    return macToBytes(v);
  } catch {
    throw new Error(`lacp.${key} is not a valid MAC address: "${v}"`);
  }
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  if (payload.length > 0) throw new Error('lacp: a LACPDU carries no inner layer');
  const subtype = u(fields, 'subtype', 8, LACP_SUBTYPE);
  if (subtype !== LACP_SUBTYPE) throw new Error(`lacp.subtype must be ${LACP_SUBTYPE}, got ${subtype}`);
  const out = new Uint8Array(LACPDU_LENGTH); // reserved bytes stay zero
  out[0] = subtype;
  out[1] = u(fields, 'version', 8, 1);
  for (const b of BLOCKS) {
    const o = b.at;
    out[o] = b.tlv;
    out[o + 1] = INFO_LENGTH;
    writeU16(out, o + 2, u(fields, `${b.prefix}SystemPriority`, 16, 0));
    out.set(mac(fields, `${b.prefix}System`), o + 4);
    writeU16(out, o + 10, u(fields, `${b.prefix}Key`, 16, 0));
    writeU16(out, o + 12, u(fields, `${b.prefix}PortPriority`, 16, 0));
    writeU16(out, o + 14, u(fields, `${b.prefix}Port`, 16, 0));
    out[o + 16] = u(fields, `${b.prefix}State`, 8, 0);
  }
  out[COLLECTOR_AT] = 3;
  out[COLLECTOR_AT + 1] = COLLECTOR_LENGTH;
  writeU16(out, COLLECTOR_AT + 2, u(fields, 'collectorMaxDelay', 16, 0));
  // terminator TLV (type 0, length 0) and the 50 reserved bytes are zeros
  return out;
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const state = typeof fields.actorState === 'number' ? lacpStateText(fields.actorState) : '?';
  const partner = fields.partnerSystem !== undefined && fields.partnerSystem !== MAC_ZERO
    ? ` partner ${String(fields.partnerSystem)} port ${String(fields.partnerPort ?? '?')}`
    : ' no partner';
  return `LACP actor ${String(fields.actorSystem ?? '?')} port ${String(fields.actorPort ?? '?')} key ${String(fields.actorKey ?? '?')}` +
    ` state ${state === '' ? '-' : state}${partner}`;
}

const DEFAULTS: Record<string, FieldValue> = { subtype: LACP_SUBTYPE, version: 1, collectorMaxDelay: 0 };
for (const b of BLOCKS) {
  DEFAULTS[`${b.prefix}SystemPriority`] = 0;
  DEFAULTS[`${b.prefix}System`] = MAC_ZERO;
  DEFAULTS[`${b.prefix}Key`] = 0;
  DEFAULTS[`${b.prefix}PortPriority`] = 0;
  DEFAULTS[`${b.prefix}Port`] = 0;
  DEFAULTS[`${b.prefix}State`] = 0;
}

/** LACPDU codec (fixed 110 bytes). No field is required; absent ones encode as 0. */
export const lacpCodec: Codec = {
  proto: 'lacp',
  defaults: Object.freeze(DEFAULTS),
  decode,
  encode,
  summarize,
};
