/**
 * EAPOL codec (IEEE 802.1X-2004 header with the IEEE 802.11 RSN key descriptor; contracts/fields.ts `eapol`).
 * Headers are real, crypto is simulated (spec §4.5): nonces, IV and RSC encode as zeros, and the MIC bytes
 * carry only a validity marker.
 *
 * Wire image (big-endian):
 *   `version(1) packetType(1) bodyLength(2) body...`
 *   packetType 3 (key) body = RSN key descriptor, 95 bytes + key data:
 *   `descriptorType(1)=2 keyInformation(2) keyLength(2) replayCounter(8) nonce(32) iv(16) rsc(8)
 *    reserved(8) mic(16) keyDataLength(2) keyData(n)`
 *  • keyInformation: version bits 0-2 = 2, key type bit 3 (1 = pairwise), install bit 6, ACK bit 7, MIC bit 8,
 *    secure bit 9, encrypted key data bit 12. `keyType` and `handshakeStep` are encoded as these bits:
 *      pairwise 1 = ACK; 2 = MIC; 3 = ACK|MIC|install|secure|encrypted; 4 = MIC|secure
 *      group    1 = ACK|MIC|secure|encrypted; 2 = MIC|secure
 *    Decode inverts the table; an unmatched combination leaves `handshakeStep` unset with an error.
 *  • keyLength is 16 for pairwise frames and 0 for group frames.
 *  • `mic` (MIC valid, simulated) exists only on frames whose MIC bit is set: `mic: false` encodes 16 zero
 *    bytes, anything else (true or absent) a non-zero marker; decode reports whether the bytes are non-zero.
 *  • `replayCounter` is an unsigned integer below 2^53 carried in the 8-byte counter.
 *  • Other packet types carry an opaque body (the key fields are ignored on encode and absent on decode).
 *  • EAPOL is always innermost: decode sets `length = min(4 + bodyLength, bound)` so outer padding is never
 *    attributed to it.
 */
import type { Codec, DecodedLayer, FieldValue } from '../../contracts/pdu.js';
import { bytesField, numField, readU16, readU32, strField, writeU16, writeU32 } from '../checksum.js';

const HEADER = 4;
const DESCRIPTOR = 95;
const DESCRIPTOR_RSN = 2;
const PACKET_KEY = 3;
const TWO_32 = 0x1_0000_0000;
/** Largest replay counter representable exactly (2^53 - 1). */
const MAX_REPLAY = Number.MAX_SAFE_INTEGER;
const MIC_MARKER = 0x6d;

const KI_VERSION = 0x0002;
const KI_PAIRWISE = 0x0008;
const KI_INSTALL = 0x0040;
const KI_ACK = 0x0080;
const KI_MIC = 0x0100;
const KI_SECURE = 0x0200;
const KI_ENCRYPTED = 0x1000;

const PAIRWISE_STEPS: readonly number[] = Object.freeze([
  KI_ACK,
  KI_MIC,
  KI_ACK | KI_MIC | KI_INSTALL | KI_SECURE | KI_ENCRYPTED,
  KI_MIC | KI_SECURE,
]);
const GROUP_STEPS: readonly number[] = Object.freeze([KI_ACK | KI_MIC | KI_SECURE | KI_ENCRYPTED, KI_MIC | KI_SECURE]);

/** Key-information bits for a key type and handshake step; throws on a step outside the handshake. */
export function eapolKeyInformation(keyType: 'pairwise' | 'group', step: number): number {
  const steps = keyType === 'pairwise' ? PAIRWISE_STEPS : GROUP_STEPS;
  const bits = Number.isInteger(step) && step >= 1 ? steps[step - 1] : undefined;
  if (bits === undefined) throw new Error(`eapol.handshakeStep ${step} is outside the ${keyType} handshake (1..${steps.length})`);
  return KI_VERSION | (keyType === 'pairwise' ? KI_PAIRWISE : 0) | bits;
}

/** Handshake step encoded by key-information bits, or undefined when the combination is not a known step. */
export function eapolStepOf(keyInformation: number): number | undefined {
  const ack = (keyInformation & KI_ACK) !== 0;
  const mic = (keyInformation & KI_MIC) !== 0;
  const secure = (keyInformation & KI_SECURE) !== 0;
  if ((keyInformation & KI_PAIRWISE) === 0) {
    if (!mic) return undefined;
    return ack ? 1 : 2;
  }
  if (ack) return mic ? 3 : 1;
  if (!mic) return undefined;
  return secure ? 4 : 2;
}

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};

  if (avail < HEADER) {
    return { fields, fieldRanges, headerLength: avail, length: avail, error: 'EAPOL header truncated' };
  }
  fields.version = bytes[offset]!;
  fields.packetType = bytes[offset + 1]!;
  fieldRanges.version = [offset, 1];
  fieldRanges.packetType = [offset + 1, 1];
  const bodyLength = readU16(bytes, offset + 2);
  const declared = HEADER + bodyLength;
  const layerLength = Math.min(declared, avail);
  if (declared > avail) {
    return { fields, fieldRanges, headerLength: layerLength, length: layerLength, error: 'EAPOL body truncated' };
  }
  if (fields.packetType !== PACKET_KEY) {
    return { fields, fieldRanges, headerLength: layerLength, length: layerLength };
  }

  const d = offset + HEADER;
  if (bodyLength < DESCRIPTOR) {
    return { fields, fieldRanges, headerLength: layerLength, length: layerLength, error: 'EAPOL key descriptor truncated' };
  }
  const descriptorType = bytes[d]!;
  if (descriptorType !== DESCRIPTOR_RSN) {
    return { fields, fieldRanges, headerLength: layerLength, length: layerLength, error: `unsupported EAPOL key descriptor type ${descriptorType}` };
  }
  const keyInformation = readU16(bytes, d + 1);
  fields.keyType = (keyInformation & KI_PAIRWISE) !== 0 ? 'pairwise' : 'group';
  fieldRanges.keyType = [d + 1, 2];

  const high = readU32(bytes, d + 5);
  const low = readU32(bytes, d + 9);
  fields.replayCounter = high * TWO_32 + low;
  fieldRanges.replayCounter = [d + 5, 8];

  if ((keyInformation & KI_MIC) !== 0) {
    let nonZero = false;
    for (let i = 0; i < 16; i++) if (bytes[d + 77 + i] !== 0) nonZero = true;
    fields.mic = nonZero;
    fieldRanges.mic = [d + 77, 16];
  }

  const keyDataLength = readU16(bytes, d + 93);
  let error: string | undefined;
  const available = bodyLength - DESCRIPTOR;
  const kdl = Math.min(keyDataLength, available);
  fields.keyData = bytes.slice(d + DESCRIPTOR, d + DESCRIPTOR + kdl);
  fieldRanges.keyData = [d + DESCRIPTOR, kdl];
  if (keyDataLength > available) error = 'EAPOL key data truncated';

  const step = eapolStepOf(keyInformation);
  if (step === undefined) {
    error ??= `EAPOL key information 0x${keyInformation.toString(16).padStart(4, '0')} is not a handshake step`;
  } else {
    fields.handshakeStep = step;
    fieldRanges.handshakeStep = [d + 1, 2];
  }
  if (high > 0x1fffff) error ??= 'EAPOL replay counter exceeds 53 bits';

  const out: DecodedLayer = { fields, fieldRanges, headerLength: layerLength, length: layerLength };
  if (error !== undefined) out.error = error;
  return out;
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'eapol';
  const version = numField(p, fields, 'version', 2);
  const packetType = numField(p, fields, 'packetType', PACKET_KEY);
  if (version < 0 || version > 0xff) throw new Error(`eapol.version out of range: ${version}`);
  if (packetType < 0 || packetType > 0xff) throw new Error(`eapol.packetType out of range: ${packetType}`);

  let body: Uint8Array;
  if (packetType !== PACKET_KEY) {
    body = payload;
  } else {
    if (payload.length > 0) throw new Error('eapol: a key frame carries no inner layer');
    const keyType = strField(p, fields, 'keyType', 'pairwise');
    if (keyType !== 'pairwise' && keyType !== 'group') throw new Error(`eapol.keyType must be 'pairwise' or 'group', got "${keyType}"`);
    const step = numField(p, fields, 'handshakeStep', null);
    const keyInformation = eapolKeyInformation(keyType, step);
    const replay = numField(p, fields, 'replayCounter', 0);
    if (replay < 0 || replay > MAX_REPLAY) throw new Error(`eapol.replayCounter out of range: ${replay}`);
    const keyData = bytesField(p, fields, 'keyData');
    if (keyData.length > 0xffff - DESCRIPTOR) throw new Error(`eapol.keyData too large: ${keyData.length} bytes`);

    body = new Uint8Array(DESCRIPTOR + keyData.length);
    body[0] = DESCRIPTOR_RSN;
    writeU16(body, 1, keyInformation);
    writeU16(body, 3, keyType === 'pairwise' ? 16 : 0);
    writeU32(body, 5, Math.floor(replay / TWO_32));
    writeU32(body, 9, replay % TWO_32);
    if ((keyInformation & KI_MIC) !== 0 && fields.mic !== false) body.fill(MIC_MARKER, 77, 93);
    writeU16(body, 93, keyData.length);
    body.set(keyData, DESCRIPTOR);
  }
  if (body.length > 0xffff) throw new Error(`eapol body too large: ${body.length} bytes`);

  const out = new Uint8Array(HEADER + body.length);
  out[0] = version;
  out[1] = packetType;
  writeU16(out, 2, body.length);
  out.set(body, HEADER);
  return out;
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  if (fields.packetType !== PACKET_KEY) return `EAPOL packet type ${String(fields.packetType ?? '?')}`;
  const group = fields.keyType === 'group';
  const total = group ? GROUP_STEPS.length : PAIRWISE_STEPS.length;
  const step = typeof fields.handshakeStep === 'number' ? String(fields.handshakeStep) : '?';
  return `EAPOL ${group ? 'group key' : 'key'} message ${step} of ${total}`;
}

/** EAPOL codec. Required on encode for key frames: `handshakeStep`. */
export const eapolCodec: Codec = {
  proto: 'eapol',
  defaults: Object.freeze({
    version: 2,
    packetType: PACKET_KEY,
    keyType: 'pairwise',
    handshakeStep: null,
    replayCounter: 0,
    keyData: new Uint8Array(0),
  }),
  decode,
  encode,
  summarize,
};
