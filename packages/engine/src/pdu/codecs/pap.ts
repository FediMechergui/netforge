/**
 * PPP Password Authentication Protocol codec [S19] (RFC 1334 §2.2; ARCHITECTURE-P3 D17, §2.3, §3.9;
 * contracts/fields.ts `pap`). PPP protocol 0xc023. The password travels in the clear, by design: the lesson shows it
 * in a capture.
 *
 * Wire image: `code(1) id(1) length(2)` then, by code:
 *   1 authenticate-request — `peerIdLength(1) peerId passwordLength(1) password`
 *   2 authenticate-ack, 3 authenticate-nak — `messageLength(1) message`
 *  • `length` covers the whole packet; the texts are UTF-8. Encode writes the parts of its code only.
 */
import type { Codec, DecodedLayer, FieldValue } from '../../contracts/pdu.js';
import { numField, readU16, strField, writeU16 } from '../checksum.js';

/** PAP codes. */
export const PAP_CODE = Object.freeze({ authenticateRequest: 1, authenticateAck: 2, authenticateNak: 3 });

const CODE_TEXT: Readonly<Record<number, string>> = Object.freeze({ 1: 'authenticate-request', 2: 'authenticate-ack', 3: 'authenticate-nak' });
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });
const UTF8_ENCODER = new TextEncoder();

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  if (avail < 4) {
    if (avail >= 1) {
      fields.code = bytes[offset]!;
      fieldRanges.code = [offset, 1];
    }
    if (avail >= 2) {
      fields.id = bytes[offset + 1]!;
      fieldRanges.id = [offset + 1, 1];
    }
    return { fields, fieldRanges, headerLength: avail, length: avail, error: 'PAP packet truncated' };
  }
  fields.code = bytes[offset]!;
  fields.id = bytes[offset + 1]!;
  fieldRanges.code = [offset, 1];
  fieldRanges.id = [offset + 1, 1];
  const declared = readU16(bytes, offset + 2);
  const len = Math.min(Math.max(declared, 4), avail);
  const end = offset + len;
  let error: string | undefined = declared > avail ? `PAP packet truncated (length ${declared}, ${avail} bytes present)` : declared < 4 ? `PAP length ${declared} is smaller than the header` : undefined;
  /** A length-prefixed text at `at`: the text and the position after it, or undefined when it runs past the packet. */
  const lv = (at: number): { text: string; next: number; range: readonly [number, number] } | undefined => {
    if (at >= end) return undefined;
    const n = bytes[at]!;
    if (at + 1 + n > end) return undefined;
    return { text: UTF8_DECODER.decode(bytes.subarray(at + 1, at + 1 + n)), next: at + 1 + n, range: [at, 1 + n] };
  };
  if (fields.code === PAP_CODE.authenticateRequest) {
    const peer = lv(offset + 4);
    const pass = peer ? lv(peer.next) : undefined;
    if (peer) {
      fields.peerId = peer.text;
      fieldRanges.peerId = peer.range;
    }
    if (pass) {
      fields.password = pass.text;
      fieldRanges.password = pass.range;
    }
    if ((!peer || !pass) && error === undefined) error = 'PAP authenticate-request truncated';
  } else if (fields.code === PAP_CODE.authenticateAck || fields.code === PAP_CODE.authenticateNak) {
    const msg = lv(offset + 4);
    if (msg) {
      fields.message = msg.text;
      fieldRanges.message = msg.range;
    } else if (len > 4 && error === undefined) error = 'PAP message truncated';
  } else if (error === undefined) {
    error = `unknown PAP code ${fields.code}`;
  }
  const out: DecodedLayer = { fields, fieldRanges, headerLength: len, length: len };
  if (error !== undefined) out.error = error;
  return out;
}

function text(fields: Readonly<Record<string, FieldValue>>, key: string, dflt: string | null): number[] {
  const b = UTF8_ENCODER.encode(strField('pap', fields, key, dflt));
  if (b.length > 0xff) throw new Error(`pap.${key} is longer than 255 bytes`);
  return [b.length, ...b];
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'pap';
  if (payload.length > 0) throw new Error('pap: a PAP packet carries no inner layer');
  const code = numField(p, fields, 'code', null);
  const id = numField(p, fields, 'id', null);
  if (id < 0 || id > 0xff) throw new Error(`pap.id out of range: ${id}`);
  let data: number[];
  if (code === PAP_CODE.authenticateRequest) data = [...text(fields, 'peerId', null), ...text(fields, 'password', '')];
  else if (code === PAP_CODE.authenticateAck || code === PAP_CODE.authenticateNak) data = text(fields, 'message', '');
  else throw new Error(`pap.code must be 1, 2 or 3, got ${code}`);
  const out = new Uint8Array(4 + data.length);
  out[0] = code;
  out[1] = id;
  writeU16(out, 2, out.length);
  out.set(data, 4);
  return out;
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const code = typeof fields.code === 'number' ? CODE_TEXT[fields.code] ?? `code ${fields.code}` : '?';
  const who = typeof fields.peerId === 'string' ? ` from ${fields.peerId}` : '';
  const msg = typeof fields.message === 'string' && fields.message !== '' ? `: ${fields.message}` : '';
  return `PAP ${code} id ${String(fields.id ?? '?')}${who}${msg}`;
}

/** PPP PAP codec [S19]. Required on encode: `code`, `id`; an authenticate-request also `peerId`. */
export const papCodec: Codec = {
  proto: 'pap',
  defaults: Object.freeze({ code: null, id: null }),
  decode,
  encode,
  summarize,
};
