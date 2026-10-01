/**
 * LLDP codec (IEEE 802.1AB; ARCHITECTURE-P3 D18, §2.3, §3.6; contracts/fields.ts `lldp`). Ethertype 0x88cc to the
 * nearest-bridge group 01:80:c2:00:00:0e. A standard format, so the bytes are the standard's.
 *
 * Wire image: TLVs with a 2-byte header `type(7 bits) length(9 bits)`, in this order:
 *   1 chassis id   — `subtype(1) id`: subtype 4 (MAC address) carries 6 bytes, any other subtype carries text
 *   2 port id      — `subtype(1) id`: subtype 5 (interface name) and the others carry text, subtype 3 (MAC) 6 bytes
 *   3 TTL          — 2 bytes, seconds
 *   4 port description, 5 system name, 6 system description — text
 *   7 system capabilities — `capabilities(2) enabledCapabilities(2)` bit maps (IEEE bits: 0x04 bridge, 0x10 router, …)
 *   8 management address  — `length(1)=5 subtype(1)=1 (IPv4) address(4) ifSubtype(1)=1 (unknown) ifNumber(4)=0
 *                            oidLength(1)=0`
 *   0 end of LLDPDU — length 0 (derived: always written last)
 *  • Encode writes the optional TLVs only for the fields present; a present `capabilities` or `enabledCapabilities`
 *    writes TLV 7, the missing one taking the other's value.
 *  • Decode reads TLVs up to the end TLV, which ends the layer (the Ethernet padding after it belongs to Ethernet);
 *    unknown TLV types (organisation-specific ones included) are skipped by their length. Errors: truncation, a TLV
 *    running past the frame, no end TLV, a missing chassis id, port id or TTL.
 */
import type { Codec, DecodedLayer, FieldValue } from '../../contracts/pdu.js';
import { bytesToIpv4, bytesToMac, ipv4ToBytes, isIpv4, macToBytes, normalizeMac } from '../../contracts/addr.js';
import { numField, readU16, strField } from '../checksum.js';

/** LLDP TLV types used. */
export const LLDP_TLV = Object.freeze({
  end: 0,
  chassisId: 1,
  portId: 2,
  ttl: 3,
  portDescription: 4,
  systemName: 5,
  systemDescription: 6,
  capabilities: 7,
  mgmtAddress: 8,
});
/** Chassis id subtype 4: a MAC address. */
export const LLDP_CHASSIS_MAC = 4;
/** Port id subtypes: 3 a MAC address, 5 an interface name. */
export const LLDP_PORT_MAC = 3;
export const LLDP_PORT_IFNAME = 5;
/** IEEE system capability bits. */
export const LLDP_CAPABILITY = Object.freeze({ other: 0x01, repeater: 0x02, bridge: 0x04, wlanAp: 0x08, router: 0x10, telephone: 0x20, docsis: 0x40, station: 0x80 });
/** Default time to live, seconds. */
export const LLDP_DEFAULT_TTL_S = 120;

const TLV_MAX_VALUE = 511;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });
const UTF8_ENCODER = new TextEncoder();

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  const end = offset + avail;
  let i = offset;
  let error: string | undefined;
  let ended = false;
  while (i < end) {
    if (i + 2 > end) {
      error = 'LLDP TLV truncated';
      break;
    }
    const h = readU16(bytes, i);
    const type = h >>> 9;
    const len = h & 0x1ff;
    const v = i + 2;
    if (v + len > end) {
      error = `LLDP TLV ${type} runs past the frame`;
      break;
    }
    const range: readonly [number, number] = [i, 2 + len];
    const text = (from: number): string => UTF8_DECODER.decode(bytes.subarray(from, v + len));
    i = v + len;
    if (type === LLDP_TLV.end) {
      ended = true;
      break;
    }
    switch (type) {
      case LLDP_TLV.chassisId:
        if (len < 1) break;
        fields.chassisSubtype = bytes[v]!;
        fields.chassisId = bytes[v] === LLDP_CHASSIS_MAC && len === 7 ? bytesToMac(bytes, v + 1) : text(v + 1);
        fieldRanges.chassisSubtype = [v, 1];
        fieldRanges.chassisId = range;
        break;
      case LLDP_TLV.portId:
        if (len < 1) break;
        fields.portSubtype = bytes[v]!;
        fields.portId = bytes[v] === LLDP_PORT_MAC && len === 7 ? bytesToMac(bytes, v + 1) : text(v + 1);
        fieldRanges.portSubtype = [v, 1];
        fieldRanges.portId = range;
        break;
      case LLDP_TLV.ttl:
        if (len < 2) break;
        fields.ttl = readU16(bytes, v);
        fieldRanges.ttl = range;
        break;
      case LLDP_TLV.portDescription:
        fields.portDescription = text(v);
        fieldRanges.portDescription = range;
        break;
      case LLDP_TLV.systemName:
        fields.systemName = text(v);
        fieldRanges.systemName = range;
        break;
      case LLDP_TLV.systemDescription:
        fields.systemDescription = text(v);
        fieldRanges.systemDescription = range;
        break;
      case LLDP_TLV.capabilities:
        if (len < 4) break;
        fields.capabilities = readU16(bytes, v);
        fields.enabledCapabilities = readU16(bytes, v + 2);
        fieldRanges.capabilities = [v, 2];
        fieldRanges.enabledCapabilities = [v + 2, 2];
        break;
      case LLDP_TLV.mgmtAddress:
        if (len >= 6 && bytes[v] === 5 && bytes[v + 1] === 1) {
          fields.mgmtAddress = bytesToIpv4(bytes, v + 2);
          fieldRanges.mgmtAddress = range;
        }
        break;
      default:
        break; // unknown or organisation-specific TLV: skipped by its length
    }
  }
  if (error === undefined && !ended) error = 'LLDP frame has no end TLV';
  if (error === undefined) {
    const missing = ['chassisId', 'portId', 'ttl'].filter((k) => fields[k] === undefined);
    if (missing.length > 0) error = `LLDP frame has no ${missing.join(', ')}`;
  }
  const covered = Math.min(i, end) - offset;
  const out: DecodedLayer = { fields, fieldRanges, headerLength: covered, length: covered };
  if (error !== undefined) out.error = error;
  return out;
}

function tlv(out: number[], type: number, value: ArrayLike<number>): void {
  if (value.length > TLV_MAX_VALUE) throw new Error(`lldp: TLV ${type} value is longer than ${TLV_MAX_VALUE} bytes`);
  const h = (type << 9) | value.length;
  out.push((h >>> 8) & 0xff, h & 0xff);
  for (let k = 0; k < value.length; k++) out.push(value[k]!);
}

function has(fields: Readonly<Record<string, FieldValue>>, key: string): boolean {
  return fields[key] !== undefined && fields[key] !== null;
}

function u8(fields: Readonly<Record<string, FieldValue>>, key: string, dflt: number | null): number {
  const v = numField('lldp', fields, key, dflt);
  if (v < 0 || v > 0xff) throw new Error(`lldp.${key} out of range: ${v}`);
  return v;
}

function u16(fields: Readonly<Record<string, FieldValue>>, key: string, dflt: number | null): number {
  const v = numField('lldp', fields, key, dflt);
  if (v < 0 || v > 0xffff) throw new Error(`lldp.${key} out of range: ${v}`);
  return v;
}

/** The id bytes of a chassis or port id: 6 MAC bytes for the MAC subtype, text otherwise. */
function idBytes(key: string, subtype: number, macSubtype: number, value: string): number[] {
  if (subtype === macSubtype) {
    const mac = normalizeMac(value);
    if (mac === null) throw new Error(`lldp.${key} must be a MAC address with subtype ${macSubtype}, got "${value}"`);
    return Array.from(macToBytes(mac));
  }
  return Array.from(UTF8_ENCODER.encode(value));
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'lldp';
  if (payload.length > 0) throw new Error('lldp: an LLDP frame carries no inner layer');
  const out: number[] = [];
  const chassisSubtype = u8(fields, 'chassisSubtype', LLDP_CHASSIS_MAC);
  tlv(out, LLDP_TLV.chassisId, [chassisSubtype, ...idBytes('chassisId', chassisSubtype, LLDP_CHASSIS_MAC, strField(p, fields, 'chassisId', null))]);
  const portSubtype = u8(fields, 'portSubtype', LLDP_PORT_IFNAME);
  tlv(out, LLDP_TLV.portId, [portSubtype, ...idBytes('portId', portSubtype, LLDP_PORT_MAC, strField(p, fields, 'portId', null))]);
  const ttl = u16(fields, 'ttl', LLDP_DEFAULT_TTL_S);
  tlv(out, LLDP_TLV.ttl, [(ttl >>> 8) & 0xff, ttl & 0xff]);
  for (const [key, type] of [['portDescription', LLDP_TLV.portDescription], ['systemName', LLDP_TLV.systemName], ['systemDescription', LLDP_TLV.systemDescription]] as const) {
    if (has(fields, key)) tlv(out, type, UTF8_ENCODER.encode(strField(p, fields, key, '')));
  }
  if (has(fields, 'capabilities') || has(fields, 'enabledCapabilities')) {
    const caps = has(fields, 'capabilities') ? u16(fields, 'capabilities', null) : u16(fields, 'enabledCapabilities', null);
    const enabled = has(fields, 'enabledCapabilities') ? u16(fields, 'enabledCapabilities', null) : caps;
    tlv(out, LLDP_TLV.capabilities, [(caps >>> 8) & 0xff, caps & 0xff, (enabled >>> 8) & 0xff, enabled & 0xff]);
  }
  if (has(fields, 'mgmtAddress')) {
    const a = strField(p, fields, 'mgmtAddress', null);
    if (!isIpv4(a)) throw new Error(`lldp.mgmtAddress is not an IPv4 address: "${a}"`);
    tlv(out, LLDP_TLV.mgmtAddress, [5, 1, ...ipv4ToBytes(a), 1, 0, 0, 0, 0, 0]);
  }
  tlv(out, LLDP_TLV.end, []);
  return Uint8Array.from(out);
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const who = typeof fields.systemName === 'string' && fields.systemName !== '' ? fields.systemName : String(fields.chassisId ?? '?');
  return `LLDP from ${who} port ${String(fields.portId ?? '?')}, ttl ${String(fields.ttl ?? '?')} s`;
}

/** LLDP codec. Required on encode: `chassisId`, `portId`. */
export const lldpCodec: Codec = {
  proto: 'lldp',
  defaults: Object.freeze({ chassisSubtype: LLDP_CHASSIS_MAC, chassisId: null, portSubtype: LLDP_PORT_IFNAME, portId: null, ttl: LLDP_DEFAULT_TTL_S }),
  decode,
  encode,
  summarize,
};
