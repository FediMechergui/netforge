/**
 * Port aggregation (PAgP) codec — an ORIGINAL NetForge format [SHOULD S3] (ARCHITECTURE-P2 D8, §2.3, §3.7;
 * contracts/fields.ts `pagp`). Carried as 802.3 + LLC/SNAP with the NF OUI and PID 3 (`nf.pid` space) to the NF L2
 * control group 03:4e:46:00:00:01. The CCNA name is used as a name only; the layout below is NetForge's own.
 *
 * Wire image (fixed 20 bytes, big-endian):
 *   `version(1) mode(1) device(6) port(2) group(2) partnerDevice(6) partnerPort(2)`
 *  • mode: 1 desirable (initiates), 2 auto (answers only) (`PAGP_MODE_*`).
 *  • device / port / group: the sender's base MAC, port number (ordinal) and channel group.
 *  • partnerDevice / partnerPort: what the sender knows of its partner; all-zero when it knows none.
 *  • Every field defaults to 0 / 00:00:00:00:00:00 except `version` (1). Encode refuses an inner payload and a mode
 *    other than 1 or 2. Decode errors on truncation.
 */
import type { Codec, DecodedLayer, FieldValue } from '../../contracts/pdu.js';
import { bytesToMac, macToBytes, MAC_ZERO } from '../../contracts/addr.js';
import { numField, readU16, strField, writeU16 } from '../checksum.js';

/** Size of a PAgP message. */
export const PAGP_LENGTH = 20;
/** Message version written by this release. */
export const PAGP_VERSION = 1;
/** `mode` values. */
export const PAGP_MODE_DESIRABLE = 1;
export const PAGP_MODE_AUTO = 2;

const AT_VERSION = 0;
const AT_MODE = 1;
const AT_DEVICE = 2;
const AT_PORT = 8;
const AT_GROUP = 10;
const AT_PARTNER_DEVICE = 12;
const AT_PARTNER_PORT = 18;

const MODE_TEXT: Readonly<Record<number, string>> = Object.freeze({
  [PAGP_MODE_DESIRABLE]: 'desirable',
  [PAGP_MODE_AUTO]: 'auto',
});

/** Text of a mode value ('desirable', 'auto', or 'mode <n>'). */
export function pagpModeText(mode: number): string {
  return MODE_TEXT[mode] ?? `mode ${mode}`;
}

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  if (avail < PAGP_LENGTH) return { fields, fieldRanges, headerLength: avail, length: avail, error: 'port aggregation message truncated' };
  fields.version = bytes[offset + AT_VERSION]!;
  fields.mode = bytes[offset + AT_MODE]!;
  fields.device = bytesToMac(bytes, offset + AT_DEVICE);
  fields.port = readU16(bytes, offset + AT_PORT);
  fields.group = readU16(bytes, offset + AT_GROUP);
  fields.partnerDevice = bytesToMac(bytes, offset + AT_PARTNER_DEVICE);
  fields.partnerPort = readU16(bytes, offset + AT_PARTNER_PORT);
  fieldRanges.version = [offset + AT_VERSION, 1];
  fieldRanges.mode = [offset + AT_MODE, 1];
  fieldRanges.device = [offset + AT_DEVICE, 6];
  fieldRanges.port = [offset + AT_PORT, 2];
  fieldRanges.group = [offset + AT_GROUP, 2];
  fieldRanges.partnerDevice = [offset + AT_PARTNER_DEVICE, 6];
  fieldRanges.partnerPort = [offset + AT_PARTNER_PORT, 2];
  return { fields, fieldRanges, headerLength: PAGP_LENGTH, length: PAGP_LENGTH };
}

function u(fields: Record<string, FieldValue>, key: string, bits: 8 | 16, dflt: number): number {
  const v = numField('pagp', fields, key, dflt);
  if (v < 0 || v > (1 << bits) - 1) throw new Error(`pagp.${key} out of range: ${v}`);
  return v;
}

function mac(fields: Record<string, FieldValue>, key: string): Uint8Array {
  const v = strField('pagp', fields, key, MAC_ZERO);
  try {
    return macToBytes(v);
  } catch {
    throw new Error(`pagp.${key} is not a valid MAC address: "${v}"`);
  }
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  if (payload.length > 0) throw new Error('pagp: a port aggregation message carries no inner layer');
  const mode = u(fields, 'mode', 8, 0);
  if (MODE_TEXT[mode] === undefined) throw new Error(`pagp.mode must be ${PAGP_MODE_DESIRABLE} (desirable) or ${PAGP_MODE_AUTO} (auto), got ${mode}`);
  const out = new Uint8Array(PAGP_LENGTH);
  out[AT_VERSION] = u(fields, 'version', 8, PAGP_VERSION);
  out[AT_MODE] = mode;
  out.set(mac(fields, 'device'), AT_DEVICE);
  writeU16(out, AT_PORT, u(fields, 'port', 16, 0));
  writeU16(out, AT_GROUP, u(fields, 'group', 16, 0));
  out.set(mac(fields, 'partnerDevice'), AT_PARTNER_DEVICE);
  writeU16(out, AT_PARTNER_PORT, u(fields, 'partnerPort', 16, 0));
  return out;
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const mode = typeof fields.mode === 'number' ? pagpModeText(fields.mode) : '?';
  const partner = fields.partnerDevice !== undefined && fields.partnerDevice !== MAC_ZERO
    ? ` partner ${String(fields.partnerDevice)} port ${String(fields.partnerPort ?? '?')}`
    : ' no partner';
  return `PAgP ${mode} from ${String(fields.device ?? '?')} port ${String(fields.port ?? '?')} group ${String(fields.group ?? '?')}${partner}`;
}

/** Port aggregation codec (NF format, fixed 20 bytes). Required on encode: `mode`; every other field defaults. */
export const pagpCodec: Codec = {
  proto: 'pagp',
  defaults: Object.freeze({ version: PAGP_VERSION, mode: null, device: MAC_ZERO, port: 0, group: 0, partnerDevice: MAC_ZERO, partnerPort: 0 }),
  decode,
  encode,
  summarize,
};
