/**
 * Simulated SSH codec [S13] (ARCHITECTURE-P3 D14, §2.3, §3.14; contracts/fields.ts `ssh`). TCP port 22.
 * Headers real, crypto simulated: the version exchange is clear text, as in RFC 4253 §4.2; everything after it is
 * a length-prefixed packet whose payload the sender XORs with an FNV-derived keystream and marks `meta.protected`
 * with `protectedBy: 'ssh'` (the codec only carries the bytes; it neither encrypts nor decrypts).
 *
 * Wire image, by `phase`:
 *   'version'   — the identification line `SSH-2.0-<software>` followed by CR LF; `version` holds the line without
 *                 CR LF.
 *   'protected' — `length(4) payload(length)`; `length` is derived from the payload.
 *  • Decode picks the phase from the first bytes ('SSH-' starts a version line). A version line without its line end
 *    or a packet shorter than its length decodes what is present with error 'partial' (the rest arrives in the next
 *    segment). The layer covers every byte the transport hands down.
 *  • Encode takes `phase` (default: 'version' when `version` is given, else 'protected').
 */
import type { Codec, DecodedLayer, FieldValue, MutationReason } from '../../contracts/pdu.js';
import { bytesField, readU32, strField, writeU32 } from '../checksum.js';

/** The identification line prefix of SSH 2.0. */
export const SSH_VERSION_PREFIX = 'SSH-2.0-';
/** Length of the packet length field of a protected packet. */
export const SSH_LENGTH_BYTES = 4;

const PREFIX = [0x53, 0x53, 0x48, 0x2d]; // 'SSH-'
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });
const UTF8_ENCODER = new TextEncoder();

function startsWithPrefix(bytes: Uint8Array, offset: number, avail: number): boolean {
  if (avail < PREFIX.length) return false;
  for (let k = 0; k < PREFIX.length; k++) if (bytes[offset + k] !== PREFIX[k]) return false;
  return true;
}

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  const out: DecodedLayer = { fields, fieldRanges, headerLength: avail, length: avail };
  if (startsWithPrefix(bytes, offset, avail)) {
    fields.phase = 'version';
    let end = offset;
    const stop = offset + avail;
    while (end < stop && bytes[end] !== 0x0a) end++;
    const lineEnd = end < stop ? (end > offset && bytes[end - 1] === 0x0d ? end - 1 : end) : stop;
    fields.version = UTF8_DECODER.decode(bytes.subarray(offset, lineEnd));
    fieldRanges.version = [offset, lineEnd - offset];
    if (end >= stop) out.error = 'partial';
    return out;
  }
  fields.phase = 'protected';
  if (avail < SSH_LENGTH_BYTES) {
    out.error = 'partial';
    return out;
  }
  const len = readU32(bytes, offset);
  fields.length = len;
  fieldRanges.length = [offset, SSH_LENGTH_BYTES];
  const present = Math.min(len, avail - SSH_LENGTH_BYTES);
  fields.payload = bytes.slice(offset + SSH_LENGTH_BYTES, offset + SSH_LENGTH_BYTES + present);
  fieldRanges.payload = [offset + SSH_LENGTH_BYTES, present];
  out.headerLength = SSH_LENGTH_BYTES;
  if (present < len) out.error = 'partial';
  return out;
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'ssh';
  if (payload.length > 0) throw new Error('ssh: the SSH stream carries no inner layer');
  const hasVersion = typeof fields.version === 'string';
  const phase = strField(p, fields, 'phase', hasVersion ? 'version' : 'protected');
  if (phase === 'version') {
    const version = strField(p, fields, 'version', null);
    if (!version.startsWith('SSH-') || /[\r\n]/.test(version)) throw new Error(`ssh.version must be one 'SSH-…' line, got "${version}"`);
    return UTF8_ENCODER.encode(`${version}\r\n`);
  }
  if (phase !== 'protected') throw new Error(`ssh.phase must be 'version' or 'protected', got "${phase}"`);
  const data = bytesField(p, fields, 'payload');
  const out = new Uint8Array(SSH_LENGTH_BYTES + data.length);
  writeU32(out, 0, data.length);
  out.set(data, SSH_LENGTH_BYTES);
  return out;
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  if (fields.phase === 'version') return `SSH version exchange ${String(fields.version ?? '?')}`;
  return `SSH protected packet, ${String(fields.length ?? '?')} bytes`;
}

const DERIVED: Readonly<Record<string, MutationReason>> = Object.freeze({ length: 'Other' });

/** Simulated SSH codec [S13]. A version line requires `version`. */
export const sshCodec: Codec = {
  proto: 'ssh',
  defaults: Object.freeze({ phase: 'protected' }),
  decode,
  encode,
  summarize,
  derived: DERIVED,
};
