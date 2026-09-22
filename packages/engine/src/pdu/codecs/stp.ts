/**
 * Spanning-tree BPDU codec, IEEE 802.1D configuration / topology-change-notification BPDUs and 802.1w RST BPDUs
 * (ARCHITECTURE-P2 D8, D9, §2.3, §3.6; contracts/fields.ts `stp`). Reached through LLC SAP 0x42 (`llc.sap`).
 *
 * Wire image (big-endian):
 *   TCN (4 bytes):            `protocolId(2)=0 version(1) bpduType(1)=0x80`
 *   configuration (35 bytes): `protocolId(2) version(1) bpduType(1)=0x00 flags(1) rootId(8) rootPathCost(4)
 *                              bridgeId(8) portId(2) messageAge(2) maxAge(2) helloTime(2) forwardDelay(2)`
 *   RST / MST (36 bytes):     the configuration layout with bpduType 0x02, then `v1Length(1)` (always 0, derived).
 *   A bridge id is `priority(2) mac(6)`: `rootPriority`/`rootMac`, `bridgePriority`/`bridgeMac` (the priority includes
 *   the VLAN, extended system id). Times are in 1/256 s, as on the wire.
 *  • `pvid` (optional): the original per-VLAN TLV `00 00 00 02 <vid(2)>` appended after the BPDU (D8), carried by
 *    every trunk BPDU and absent on access ports. Decode reads it when the six bytes after the BPDU (inside the bound)
 *    start `00 00 00 02`; the layer then covers it.
 *  • `flagsText` (decode-only): the flag bits as tokens joined by ',' in bit order — TC (bit 0), P proposal (1), the
 *    port role of bits 2–3 (A alternate/backup, R root, D designated; nothing for 0), L learning (4), F forwarding
 *    (5), AG agreement (6), TCA TC-ack (7). An 802.1D configuration BPDU uses only TC and TCA.
 *  • Defaults: priorities 32768, timers the 802.1D values (max age 20 s, hello 2 s, forward delay 15 s, message
 *    age 0), everything else 0. `version` and `bpduType` are required. Encode refuses an inner payload.
 *  • Decode errors: truncation, a protocol id other than 0, an unknown BPDU type (the header fields are kept).
 */
import type { Codec, DecodedLayer, FieldValue, MutationReason } from '../../contracts/pdu.js';
import { bytesToMac, macToBytes, MAC_ZERO } from '../../contracts/addr.js';
import { numField, readU16, readU32, strField, writeU16, writeU32 } from '../checksum.js';

/** BPDU types (bpduType). */
export const STP_BPDU_CONFIG = 0x00;
export const STP_BPDU_TCN = 0x80;
export const STP_BPDU_RST = 0x02;
/** Protocol versions (version). */
export const STP_VERSION_STP = 0;
export const STP_VERSION_RSTP = 2;
export const STP_VERSION_MSTP = 3;

/** Flag bits (flags). The port role occupies bits 2–3 (`STP_FLAG_ROLE_SHIFT`). */
export const STP_FLAG_TC = 0x01;
export const STP_FLAG_PROPOSAL = 0x02;
export const STP_FLAG_ROLE_SHIFT = 2;
export const STP_FLAG_ROLE_MASK = 0x0c;
export const STP_FLAG_LEARNING = 0x10;
export const STP_FLAG_FORWARDING = 0x20;
export const STP_FLAG_AGREEMENT = 0x40;
export const STP_FLAG_TC_ACK = 0x80;
/** Port role values of flag bits 2–3. */
export const STP_ROLE_UNKNOWN = 0;
export const STP_ROLE_ALTERNATE_BACKUP = 1;
export const STP_ROLE_ROOT = 2;
export const STP_ROLE_DESIGNATED = 3;

/** Wire lengths of the three BPDU shapes and of the NF per-VLAN TLV. */
export const STP_TCN_LENGTH = 4;
export const STP_CONFIG_LENGTH = 35;
export const STP_RST_LENGTH = 36;
export const STP_PVID_TLV_LENGTH = 6;

/** 802.1D default times in 1/256 s. */
const MAX_AGE_DEFAULT = 20 * 256;
const HELLO_DEFAULT = 2 * 256;
const FORWARD_DELAY_DEFAULT = 15 * 256;
const PRIORITY_DEFAULT = 32768;

const ROLE_TOKEN: readonly string[] = Object.freeze(['', 'A', 'R', 'D']);

/** `flagsText` for a flags byte: 'TC,P,D,L,F' style tokens in bit order (see the file header). */
export function stpFlagsText(flags: number): string {
  const out: string[] = [];
  if (flags & STP_FLAG_TC) out.push('TC');
  if (flags & STP_FLAG_PROPOSAL) out.push('P');
  const role = ROLE_TOKEN[(flags & STP_FLAG_ROLE_MASK) >>> STP_FLAG_ROLE_SHIFT]!;
  if (role !== '') out.push(role);
  if (flags & STP_FLAG_LEARNING) out.push('L');
  if (flags & STP_FLAG_FORWARDING) out.push('F');
  if (flags & STP_FLAG_AGREEMENT) out.push('AG');
  if (flags & STP_FLAG_TC_ACK) out.push('TCA');
  return out.join(',');
}

/** Wire length of a BPDU of `bpduType` (without the pvid TLV), or undefined for an unknown type. */
export function stpBpduLength(bpduType: number): number | undefined {
  if (bpduType === STP_BPDU_TCN) return STP_TCN_LENGTH;
  if (bpduType === STP_BPDU_CONFIG) return STP_CONFIG_LENGTH;
  if (bpduType === STP_BPDU_RST) return STP_RST_LENGTH;
  return undefined;
}

const DERIVED: Readonly<Record<string, MutationReason>> = Object.freeze({ v1Length: 'Other' });

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  if (avail < STP_TCN_LENGTH) {
    return { fields, fieldRanges, headerLength: avail, length: avail, error: 'BPDU truncated' };
  }
  fields.protocolId = readU16(bytes, offset);
  fields.version = bytes[offset + 2]!;
  fields.bpduType = bytes[offset + 3]!;
  fieldRanges.protocolId = [offset, 2];
  fieldRanges.version = [offset + 2, 1];
  fieldRanges.bpduType = [offset + 3, 1];
  if (fields.protocolId !== 0) {
    return { fields, fieldRanges, headerLength: STP_TCN_LENGTH, length: avail, error: `not a spanning-tree BPDU (protocol id ${fields.protocolId})` };
  }
  const size = stpBpduLength(fields.bpduType);
  if (size === undefined) {
    return { fields, fieldRanges, headerLength: STP_TCN_LENGTH, length: avail, error: `unknown BPDU type 0x${fields.bpduType.toString(16).padStart(2, '0')}` };
  }
  if (avail < size) {
    return { fields, fieldRanges, headerLength: avail, length: avail, error: 'BPDU truncated' };
  }
  if (size > STP_TCN_LENGTH) {
    const o = offset;
    fields.flags = bytes[o + 4]!;
    fields.rootPriority = readU16(bytes, o + 5);
    fields.rootMac = bytesToMac(bytes, o + 7);
    fields.rootPathCost = readU32(bytes, o + 13);
    fields.bridgePriority = readU16(bytes, o + 17);
    fields.bridgeMac = bytesToMac(bytes, o + 19);
    fields.portId = readU16(bytes, o + 25);
    fields.messageAge = readU16(bytes, o + 27);
    fields.maxAge = readU16(bytes, o + 29);
    fields.helloTime = readU16(bytes, o + 31);
    fields.forwardDelay = readU16(bytes, o + 33);
    fieldRanges.flags = [o + 4, 1];
    fieldRanges.rootPriority = [o + 5, 2];
    fieldRanges.rootMac = [o + 7, 6];
    fieldRanges.rootPathCost = [o + 13, 4];
    fieldRanges.bridgePriority = [o + 17, 2];
    fieldRanges.bridgeMac = [o + 19, 6];
    fieldRanges.portId = [o + 25, 2];
    fieldRanges.messageAge = [o + 27, 2];
    fieldRanges.maxAge = [o + 29, 2];
    fieldRanges.helloTime = [o + 31, 2];
    fieldRanges.forwardDelay = [o + 33, 2];
    if (size === STP_RST_LENGTH) {
      fields.v1Length = bytes[o + 35]!;
      fieldRanges.v1Length = [o + 35, 1];
    }
    fields.flagsText = stpFlagsText(fields.flags);
    fieldRanges.flagsText = [o + 4, 1];
  }
  let end = offset + size;
  if (avail >= size + STP_PVID_TLV_LENGTH && readU16(bytes, end) === 0 && readU16(bytes, end + 2) === 2) {
    fields.pvid = readU16(bytes, end + 4);
    fieldRanges.pvid = [end, STP_PVID_TLV_LENGTH];
    end += STP_PVID_TLV_LENGTH;
  }
  return { fields, fieldRanges, headerLength: end - offset, length: end - offset };
}

function macOf(fields: Record<string, FieldValue>, key: string): Uint8Array {
  const v = strField('stp', fields, key, MAC_ZERO);
  try {
    return macToBytes(v);
  } catch {
    throw new Error(`stp.${key} is not a valid MAC address: "${v}"`);
  }
}

function u(fields: Record<string, FieldValue>, key: string, bits: 8 | 16 | 32, dflt: number): number {
  const v = numField('stp', fields, key, dflt);
  const max = bits === 32 ? 0xffffffff : (1 << bits) - 1;
  if (v < 0 || v > max) throw new Error(`stp.${key} out of range: ${v}`);
  return v;
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'stp';
  if (payload.length > 0) throw new Error('stp: a BPDU carries no inner layer');
  const protocolId = u(fields, 'protocolId', 16, 0);
  const version = numField(p, fields, 'version', null);
  const bpduType = numField(p, fields, 'bpduType', null);
  if (version < 0 || version > 0xff) throw new Error(`stp.version out of range: ${version}`);
  const size = stpBpduLength(bpduType);
  if (size === undefined) throw new Error(`stp.bpduType must be 0x00 (configuration), 0x80 (TCN) or 0x02 (RST), got ${bpduType}`);
  const pvidRaw = fields.pvid;
  const hasPvid = pvidRaw !== undefined && pvidRaw !== null;
  const pvid = hasPvid ? u(fields, 'pvid', 16, 0) : 0;

  const out = new Uint8Array(size + (hasPvid ? STP_PVID_TLV_LENGTH : 0));
  writeU16(out, 0, protocolId);
  out[2] = version;
  out[3] = bpduType;
  if (size > STP_TCN_LENGTH) {
    out[4] = u(fields, 'flags', 8, 0);
    writeU16(out, 5, u(fields, 'rootPriority', 16, PRIORITY_DEFAULT));
    out.set(macOf(fields, 'rootMac'), 7);
    writeU32(out, 13, u(fields, 'rootPathCost', 32, 0));
    writeU16(out, 17, u(fields, 'bridgePriority', 16, PRIORITY_DEFAULT));
    out.set(macOf(fields, 'bridgeMac'), 19);
    writeU16(out, 25, u(fields, 'portId', 16, 0));
    writeU16(out, 27, u(fields, 'messageAge', 16, 0));
    writeU16(out, 29, u(fields, 'maxAge', 16, MAX_AGE_DEFAULT));
    writeU16(out, 31, u(fields, 'helloTime', 16, HELLO_DEFAULT));
    writeU16(out, 33, u(fields, 'forwardDelay', 16, FORWARD_DELAY_DEFAULT));
    // size === STP_RST_LENGTH: v1Length (byte 35) is always 0 (derived).
  }
  if (hasPvid) {
    writeU16(out, size, 0);
    writeU16(out, size + 2, 2);
    writeU16(out, size + 4, pvid);
  }
  return out;
}

/** `32769/02:b3:b2:b1:b0:00` */
function bridgeText(priority: FieldValue | undefined, mac: FieldValue | undefined): string {
  return `${String(priority ?? '?')}/${String(mac ?? '?')}`;
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const vlan = typeof fields.pvid === 'number' ? ` VLAN ${fields.pvid}` : '';
  if (fields.bpduType === STP_BPDU_TCN) return `STP topology change notification${vlan}`;
  const kind = fields.bpduType === STP_BPDU_RST ? (fields.version === STP_VERSION_MSTP ? 'MST BPDU' : 'RST BPDU') : 'STP configuration BPDU';
  const port = typeof fields.portId === 'number' ? ` port ${fields.portId >>> 12 << 4}.${fields.portId & 0x0fff}` : '';
  const flags = typeof fields.flags === 'number' && fields.flags !== 0 ? ` [${stpFlagsText(fields.flags)}]` : '';
  return `${kind}${vlan} root ${bridgeText(fields.rootPriority, fields.rootMac)} cost ${String(fields.rootPathCost ?? '?')}` +
    ` bridge ${bridgeText(fields.bridgePriority, fields.bridgeMac)}${port}${flags}`;
}

/** Spanning-tree BPDU codec. Required on encode: `version`, `bpduType`. */
export const stpCodec: Codec = {
  proto: 'stp',
  defaults: Object.freeze({
    protocolId: 0,
    version: null,
    bpduType: null,
    flags: 0,
    rootPriority: PRIORITY_DEFAULT,
    rootMac: MAC_ZERO,
    rootPathCost: 0,
    bridgePriority: PRIORITY_DEFAULT,
    bridgeMac: MAC_ZERO,
    portId: 0,
    messageAge: 0,
    maxAge: MAX_AGE_DEFAULT,
    helloTime: HELLO_DEFAULT,
    forwardDelay: FORWARD_DELAY_DEFAULT,
  }),
  decode,
  encode,
  summarize,
  derived: DERIVED,
};
