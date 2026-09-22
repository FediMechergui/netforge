/**
 * HSRP codec, versions 1 and 2 [SHOULD S2] (ARCHITECTURE-P2 D8, D15, §2.3, §3.10; contracts/fields.ts `hsrp`).
 * Reached through UDP 1985; v1 is sent to 224.0.0.2, v2 to 224.0.0.102. The protocol name, port, groups and virtual
 * MAC prefixes are protocol facts (D8); the v1 default authentication data is eight zero bytes (never a vendor word).
 *
 * `version` holds the protocol version (1 or 2); the codec maps it to the wire.
 *   v1 (20 bytes): `version(1)=0 opCode(1) state(1) hello(1, s) hold(1, s) priority(1) group(1) reserved(1)
 *                   authData(8) virtualIp(4)`
 *   v2 group-state TLV (42 bytes): `type(1)=1 length(1)=40 version(1)=2 opCode(1) state(1) ipVersion(1)=4 group(2)
 *                   identifier(6) priority(4) hello(4, ms) hold(4, ms) virtualIp(16: the IPv4 address, then zeros)`
 *  • Times are fields in ms (`helloMs`, `holdMs`); v1 carries whole seconds (encode requires a multiple of 1000 ms,
 *    decode multiplies by 1000). v1 limits: group ≤ 255, priority ≤ 255, times ≤ 255 s.
 *  • `state`: 0 initial, 1 learn, 2 listen, 4 speak, 8 standby, 16 active; `opCode`: 0 hello, 1 coup, 2 resign.
 *  • Decode: a first byte 0 is v1; a first byte 1 whose third byte is 2 is the v2 group-state TLV (TLVs after it are
 *    skipped); anything else is an error. Encode refuses an inner payload.
 *  • `hsrpVirtualMac(version, group)` is the virtual MAC of a group (v1 `00:00:0c:07:ac:XX`, v2 `00:00:0c:9f:fX:XX`).
 */
import type { Codec, DecodedLayer, FieldValue } from '../../contracts/pdu.js';
import { HSRP_V1_MAC_PREFIX, HSRP_V2_MAC_PREFIX } from '../../contracts/pdu.js';
import type { MacAddress } from '../../contracts/addr.js';
import { bytesToIpv4, bytesToMac, ipv4ToBytes, isIpv4, macToBytes, MAC_ZERO } from '../../contracts/addr.js';
import { bytesField, numField, readU16, readU32, strField, writeU16, writeU32 } from '../checksum.js';

/** HSRP states (the `state` field). */
export const HSRP_STATE = Object.freeze({ initial: 0, learn: 1, listen: 2, speak: 4, standby: 8, active: 16 });
/** HSRP op codes (the `opCode` field). */
export const HSRP_OP = Object.freeze({ hello: 0, coup: 1, resign: 2 });
/** Wire lengths. */
export const HSRP_V1_LENGTH = 20;
export const HSRP_V2_TLV_LENGTH = 42;
/** Size of the v1 authentication data. */
export const HSRP_AUTH_LENGTH = 8;

const STATE_TEXT: Readonly<Record<number, string>> = Object.freeze({
  0: 'initial',
  1: 'learn',
  2: 'listen',
  4: 'speak',
  8: 'standby',
  16: 'active',
});
const OP_TEXT: Readonly<Record<number, string>> = Object.freeze({ 0: 'hello', 1: 'coup', 2: 'resign' });

/** Text of a state value ('active'), or 'state <n>'. */
export function hsrpStateText(state: number): string {
  return STATE_TEXT[state] ?? `state ${state}`;
}

/**
 * The virtual MAC of an HSRP group (a protocol fact, D8): v1 `00:00:0c:07:ac:` + the group as 2 hex digits (0–255),
 * v2 `00:00:0c:9f:f` + the group as 3 hex digits (0–4095).
 */
export function hsrpVirtualMac(version: 1 | 2, group: number): MacAddress {
  if (!Number.isInteger(group) || group < 0 || group > (version === 1 ? 0xff : 0xfff)) {
    throw new RangeError(`HSRP version ${version} group out of range: ${group}`);
  }
  if (version === 1) return `${HSRP_V1_MAC_PREFIX}${group.toString(16).padStart(2, '0')}`;
  const g = group.toString(16).padStart(3, '0');
  return `${HSRP_V2_MAC_PREFIX}${g[0]}:${g.slice(1)}`;
}

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  if (avail < 1) return { fields, fieldRanges, headerLength: 0, length: 0, error: 'HSRP message truncated' };
  const o = offset;
  if (bytes[o] === 0) {
    if (avail < HSRP_V1_LENGTH) return { fields, fieldRanges, headerLength: avail, length: avail, error: 'HSRP message truncated' };
    fields.version = 1;
    fields.opCode = bytes[o + 1]!;
    fields.state = bytes[o + 2]!;
    fields.helloMs = bytes[o + 3]! * 1000;
    fields.holdMs = bytes[o + 4]! * 1000;
    fields.priority = bytes[o + 5]!;
    fields.group = bytes[o + 6]!;
    fields.authData = bytes.slice(o + 8, o + 16);
    fields.virtualIp = bytesToIpv4(bytes, o + 16);
    fieldRanges.version = [o, 1];
    fieldRanges.opCode = [o + 1, 1];
    fieldRanges.state = [o + 2, 1];
    fieldRanges.helloMs = [o + 3, 1];
    fieldRanges.holdMs = [o + 4, 1];
    fieldRanges.priority = [o + 5, 1];
    fieldRanges.group = [o + 6, 1];
    fieldRanges.authData = [o + 8, 8];
    fieldRanges.virtualIp = [o + 16, 4];
    return { fields, fieldRanges, headerLength: HSRP_V1_LENGTH, length: HSRP_V1_LENGTH };
  }
  if (bytes[o] === 1 && avail >= 3 && bytes[o + 2] === 2) {
    if (avail < HSRP_V2_TLV_LENGTH || bytes[o + 1] !== HSRP_V2_TLV_LENGTH - 2) {
      return { fields, fieldRanges, headerLength: avail, length: avail, error: 'HSRP version 2 group state TLV truncated' };
    }
    fields.version = 2;
    fields.opCode = bytes[o + 3]!;
    fields.state = bytes[o + 4]!;
    fields.group = readU16(bytes, o + 6);
    fields.identifier = bytesToMac(bytes, o + 8);
    fields.priority = readU32(bytes, o + 14);
    fields.helloMs = readU32(bytes, o + 18);
    fields.holdMs = readU32(bytes, o + 22);
    fields.virtualIp = bytesToIpv4(bytes, o + 26);
    fieldRanges.version = [o + 2, 1];
    fieldRanges.opCode = [o + 3, 1];
    fieldRanges.state = [o + 4, 1];
    fieldRanges.group = [o + 6, 2];
    fieldRanges.identifier = [o + 8, 6];
    fieldRanges.priority = [o + 14, 4];
    fieldRanges.helloMs = [o + 18, 4];
    fieldRanges.holdMs = [o + 22, 4];
    fieldRanges.virtualIp = [o + 26, 16];
    const out: DecodedLayer = { fields, fieldRanges, headerLength: avail, length: avail };
    if (bytes[o + 5] !== 4) out.error = `HSRP version 2 IP version ${bytes[o + 5]!} is not simulated`;
    return out;
  }
  return { fields, fieldRanges, headerLength: avail, length: avail, error: `not an HSRP message (first byte ${bytes[o]!})` };
}

function uField(fields: Record<string, FieldValue>, key: string, max: number, dflt: number | null): number {
  const v = numField('hsrp', fields, key, dflt);
  if (v < 0 || v > max) throw new Error(`hsrp.${key} out of range: ${v}`);
  return v;
}

function ipv4Of(fields: Record<string, FieldValue>): Uint8Array {
  const vip = strField('hsrp', fields, 'virtualIp', '0.0.0.0');
  if (!isIpv4(vip)) throw new Error(`hsrp.virtualIp is not a valid IPv4 address: "${vip}"`);
  return ipv4ToBytes(vip);
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  if (payload.length > 0) throw new Error('hsrp: an HSRP message carries no inner layer');
  const version = numField('hsrp', fields, 'version', null);
  const opCode = uField(fields, 'opCode', 0xff, HSRP_OP.hello);
  const state = uField(fields, 'state', 0xff, null);
  if (version === 1) {
    const secs = (key: 'helloMs' | 'holdMs', dflt: number): number => {
      const ms = uField(fields, key, 255_000, dflt);
      if (ms % 1000 !== 0) throw new Error(`hsrp.${key} must be whole seconds in version 1, got ${ms} ms`);
      return ms / 1000;
    };
    const auth = bytesField('hsrp', fields, 'authData');
    if (auth.length !== 0 && auth.length !== HSRP_AUTH_LENGTH) throw new Error(`hsrp.authData must be ${HSRP_AUTH_LENGTH} bytes, got ${auth.length}`);
    const out = new Uint8Array(HSRP_V1_LENGTH);
    out[0] = 0;
    out[1] = opCode;
    out[2] = state;
    out[3] = secs('helloMs', 3000);
    out[4] = secs('holdMs', 10000);
    out[5] = uField(fields, 'priority', 0xff, 100);
    out[6] = uField(fields, 'group', 0xff, null);
    if (auth.length === HSRP_AUTH_LENGTH) out.set(auth, 8); // else eight zero bytes
    out.set(ipv4Of(fields), 16);
    return out;
  }
  if (version !== 2) throw new Error(`hsrp.version must be 1 or 2, got ${version}`);
  const out = new Uint8Array(HSRP_V2_TLV_LENGTH);
  out[0] = 1;
  out[1] = HSRP_V2_TLV_LENGTH - 2;
  out[2] = 2;
  out[3] = opCode;
  out[4] = state;
  out[5] = 4;
  writeU16(out, 6, uField(fields, 'group', 0xfff, null));
  const id = strField('hsrp', fields, 'identifier', MAC_ZERO);
  try {
    out.set(macToBytes(id), 8);
  } catch {
    throw new Error(`hsrp.identifier is not a valid MAC address: "${id}"`);
  }
  writeU32(out, 14, uField(fields, 'priority', 0xffffffff, 100));
  writeU32(out, 18, uField(fields, 'helloMs', 0xffffffff, 3000));
  writeU32(out, 22, uField(fields, 'holdMs', 0xffffffff, 10000));
  out.set(ipv4Of(fields), 26); // bytes 30-41 stay zero (an IPv4 group)
  return out;
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const v = String(fields.version ?? '?');
  const op = typeof fields.opCode === 'number' ? OP_TEXT[fields.opCode] ?? `op ${fields.opCode}` : '?';
  const state = typeof fields.state === 'number' ? hsrpStateText(fields.state) : '?';
  return `HSRPv${v} ${op} group ${String(fields.group ?? '?')} ${state} priority ${String(fields.priority ?? '?')}` +
    ` virtual ${String(fields.virtualIp ?? '?')}`;
}

/** HSRP codec (v1 and v2). Required on encode: `version`, `state`, `group`. */
export const hsrpCodec: Codec = {
  proto: 'hsrp',
  defaults: Object.freeze({
    version: null,
    opCode: HSRP_OP.hello,
    state: null,
    helloMs: 3000,
    holdMs: 10000,
    priority: 100,
    group: null,
    virtualIp: '0.0.0.0',
    identifier: MAC_ZERO,
  }),
  decode,
  encode,
  summarize,
};
