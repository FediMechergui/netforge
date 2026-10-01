/**
 * Discovery codec — an ORIGINAL NetForge format (ARCHITECTURE-P3 D18, §2.3, §3.6; contracts/fields.ts `cdp`). "CDP" is
 * used as a name only (P2 D8): the layout below is NetForge's own. Carried as 802.3 + LLC/SNAP with the NF OUI and
 * PID 4 (`NF_PID_CDP`, the `nf.pid` space) to the NF L2 control group 03:4e:46:00:00:01, always untagged.
 *
 * Wire image (big-endian): `version(1) ttl(1)` followed by TLVs `type(2) length(2) value(length)`, length = value bytes:
 *   type 1 deviceId     — text (UTF-8)
 *   type 2 portId       — text
 *   type 3 addresses    — entries `family(1) address`: family 4 + 4 bytes or family 6 + 16 bytes
 *   type 4 capabilities — 2-byte bit map: R 0x01 router, S 0x02 switch, I 0x04 IGMP-capable, H 0x08 host, P 0x10 phone
 *   type 5 platform     — text
 *   type 6 software     — text (original wording, chosen by the sender)
 *   type 7 nativeVlan   — 2 bytes
 *   type 8 duplex       — 1 byte: 1 full, 0 half
 *  • Encode writes the TLVs in type order, only for the fields present (deviceId and portId are required); an empty
 *    `addresses` or `capabilities` is written as an empty list, so decode gives back ''.
 *  • `addresses` is the comma-joined list; `capabilities` the letters in the fixed order R S I H P, joined by ' '.
 *  • Decode reads TLVs up to the bound; unknown types are skipped by their length. Errors: truncation, a TLV running
 *    past the message, a missing deviceId or portId.
 */
import type { Codec, DecodedLayer, FieldValue } from '../../contracts/pdu.js';
import { bytesToIpv4, ipv4ToBytes, isIpv4 } from '../../contracts/addr.js';
import { bytesToIpv6, ipv6ToBytes, isIpv6 } from '../../core/addr6.js';
import { numField, readU16, strField, writeU16 } from '../checksum.js';

/** NF discovery TLV types. */
export const CDP_TLV = Object.freeze({
  deviceId: 1,
  portId: 2,
  addresses: 3,
  capabilities: 4,
  platform: 5,
  software: 6,
  nativeVlan: 7,
  duplex: 8,
});
/** Capability letters and their bits, in rendering order. */
export const CDP_CAPABILITY_BITS: Readonly<Record<string, number>> = Object.freeze({ R: 0x01, S: 0x02, I: 0x04, H: 0x08, P: 0x10 });
/** Default message version and holdtime. */
export const CDP_DEFAULT_VERSION = 2;
export const CDP_DEFAULT_TTL_S = 180;

const TLV_HEADER = 4;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });
const UTF8_ENCODER = new TextEncoder();

/** Letters of a capability bit map, in the fixed order R S I H P, joined by ' '. */
export function cdpCapabilityText(bits: number): string {
  const out: string[] = [];
  for (const [letter, bit] of Object.entries(CDP_CAPABILITY_BITS)) if (bits & bit) out.push(letter);
  return out.join(' ');
}

function capabilityBits(text: string): number {
  let bits = 0;
  for (const token of text.split(/[\s,]+/)) {
    if (token === '') continue;
    const bit = CDP_CAPABILITY_BITS[token];
    if (bit === undefined) throw new Error(`cdp.capabilities: unknown capability letter "${token}" (R, S, I, H, P)`);
    bits |= bit;
  }
  return bits;
}

function decodeAddresses(bytes: Uint8Array, v: number, len: number): { text: string; error?: string } {
  const out: string[] = [];
  let i = v;
  const end = v + len;
  while (i < end) {
    const family = bytes[i]!;
    const size = family === 4 ? 4 : family === 6 ? 16 : -1;
    if (size < 0) return { text: out.join(','), error: `discovery address family ${family} is not simulated` };
    if (i + 1 + size > end) return { text: out.join(','), error: 'discovery address list truncated' };
    out.push(size === 4 ? bytesToIpv4(bytes, i + 1) : bytesToIpv6(bytes, i + 1));
    i += 1 + size;
  }
  return { text: out.join(',') };
}

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  if (avail < 2) return { fields, fieldRanges, headerLength: avail, length: avail, error: 'discovery message truncated' };
  fields.version = bytes[offset]!;
  fields.ttl = bytes[offset + 1]!;
  fieldRanges.version = [offset, 1];
  fieldRanges.ttl = [offset + 1, 1];
  const end = offset + avail;
  let i = offset + 2;
  let error: string | undefined;
  while (i < end) {
    if (i + TLV_HEADER > end) {
      error = 'discovery TLV truncated';
      break;
    }
    const type = readU16(bytes, i);
    const len = readU16(bytes, i + 2);
    const v = i + TLV_HEADER;
    if (v + len > end) {
      error = `discovery TLV ${type} runs past the message`;
      break;
    }
    const range: readonly [number, number] = [i, TLV_HEADER + len];
    const text = (): string => UTF8_DECODER.decode(bytes.subarray(v, v + len));
    switch (type) {
      case CDP_TLV.deviceId:
        fields.deviceId = text();
        fieldRanges.deviceId = range;
        break;
      case CDP_TLV.portId:
        fields.portId = text();
        fieldRanges.portId = range;
        break;
      case CDP_TLV.addresses: {
        const a = decodeAddresses(bytes, v, len);
        fields.addresses = a.text;
        fieldRanges.addresses = range;
        if (a.error !== undefined && error === undefined) error = a.error;
        break;
      }
      case CDP_TLV.capabilities:
        if (len >= 2) {
          fields.capabilities = cdpCapabilityText(readU16(bytes, v));
          fieldRanges.capabilities = range;
        }
        break;
      case CDP_TLV.platform:
        fields.platform = text();
        fieldRanges.platform = range;
        break;
      case CDP_TLV.software:
        fields.software = text();
        fieldRanges.software = range;
        break;
      case CDP_TLV.nativeVlan:
        if (len >= 2) {
          fields.nativeVlan = readU16(bytes, v);
          fieldRanges.nativeVlan = range;
        }
        break;
      case CDP_TLV.duplex:
        if (len >= 1) {
          fields.duplex = bytes[v] === 1 ? 'full' : 'half';
          fieldRanges.duplex = range;
        }
        break;
      default:
        break; // unknown TLV: skipped by its length
    }
    i = v + len;
  }
  if (error === undefined) {
    const missing = ['deviceId', 'portId'].filter((k) => fields[k] === undefined);
    if (missing.length > 0) error = `discovery message has no ${missing.join(', ')}`;
  }
  const covered = Math.min(i, end) - offset;
  const out: DecodedLayer = { fields, fieldRanges, headerLength: covered, length: covered };
  if (error !== undefined) out.error = error;
  return out;
}

function tlv(out: number[], type: number, value: ArrayLike<number>): void {
  if (value.length > 0xffff) throw new Error(`cdp: TLV ${type} is too long`);
  out.push((type >>> 8) & 0xff, type & 0xff, (value.length >>> 8) & 0xff, value.length & 0xff);
  for (let k = 0; k < value.length; k++) out.push(value[k]!);
}

function has(fields: Readonly<Record<string, FieldValue>>, key: string): boolean {
  return fields[key] !== undefined && fields[key] !== null;
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'cdp';
  if (payload.length > 0) throw new Error('cdp: a discovery message carries no inner layer');
  const version = numField(p, fields, 'version', CDP_DEFAULT_VERSION);
  const ttl = numField(p, fields, 'ttl', CDP_DEFAULT_TTL_S);
  if (version < 0 || version > 0xff) throw new Error(`cdp.version out of range: ${version}`);
  if (ttl < 0 || ttl > 0xff) throw new Error(`cdp.ttl out of range: ${ttl}`);
  const out: number[] = [version, ttl];
  tlv(out, CDP_TLV.deviceId, UTF8_ENCODER.encode(strField(p, fields, 'deviceId', null)));
  tlv(out, CDP_TLV.portId, UTF8_ENCODER.encode(strField(p, fields, 'portId', null)));
  if (has(fields, 'addresses')) {
    const text = strField(p, fields, 'addresses', '');
    const value: number[] = [];
    for (const raw of text.split(',')) {
      const a = raw.trim();
      if (a === '') continue;
      if (isIpv4(a)) value.push(4, ...ipv4ToBytes(a));
      else if (isIpv6(a)) value.push(6, ...ipv6ToBytes(a));
      else throw new Error(`cdp.addresses holds a value that is not an address: "${a}"`);
    }
    tlv(out, CDP_TLV.addresses, value);
  }
  if (has(fields, 'capabilities')) {
    const bits = capabilityBits(strField(p, fields, 'capabilities', ''));
    tlv(out, CDP_TLV.capabilities, [(bits >>> 8) & 0xff, bits & 0xff]);
  }
  if (has(fields, 'platform')) tlv(out, CDP_TLV.platform, UTF8_ENCODER.encode(strField(p, fields, 'platform', '')));
  if (has(fields, 'software')) tlv(out, CDP_TLV.software, UTF8_ENCODER.encode(strField(p, fields, 'software', '')));
  if (has(fields, 'nativeVlan')) {
    const vlan = numField(p, fields, 'nativeVlan', null);
    if (vlan < 0 || vlan > 0xffff) throw new Error(`cdp.nativeVlan out of range: ${vlan}`);
    const b = new Uint8Array(2);
    writeU16(b, 0, vlan);
    tlv(out, CDP_TLV.nativeVlan, b);
  }
  if (has(fields, 'duplex')) {
    const duplex = strField(p, fields, 'duplex', 'full');
    if (duplex !== 'full' && duplex !== 'half') throw new Error(`cdp.duplex must be 'full' or 'half', got "${duplex}"`);
    tlv(out, CDP_TLV.duplex, [duplex === 'full' ? 1 : 0]);
  }
  return Uint8Array.from(out);
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const platform = typeof fields.platform === 'string' && fields.platform !== '' ? ` (${fields.platform})` : '';
  return `CDP from ${String(fields.deviceId ?? '?')}${platform} port ${String(fields.portId ?? '?')}, holdtime ${String(fields.ttl ?? '?')} s`;
}

/** NF discovery codec ("CDP" as a name only). Required on encode: `deviceId`, `portId`. */
export const cdpCodec: Codec = {
  proto: 'cdp',
  defaults: Object.freeze({ version: CDP_DEFAULT_VERSION, ttl: CDP_DEFAULT_TTL_S, deviceId: null, portId: null }),
  decode,
  encode,
  summarize,
};
