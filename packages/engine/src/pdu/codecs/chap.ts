/**
 * PPP Challenge-Handshake Authentication Protocol codec [S19] (RFC 1994 §4; ARCHITECTURE-P3 D17, §2.3, §3.9;
 * contracts/fields.ts `chap`). PPP protocol 0xc223, algorithm 5 (MD5).
 *
 * Wire image: `code(1) id(1) length(2)` then, by code:
 *   1 challenge, 2 response — `valueSize(1) value name`: the challenge, or the response MD5(id ‖ secret ‖ challenge)
 *                             (RFC 1994 §4.1; the daemon computes it with `core/md5.ts`), then the sender's name
 *                             (the rest of the packet)
 *   3 success, 4 failure     — `message` (the rest of the packet)
 *  • `length` covers the whole packet; the texts are UTF-8. The secret itself never travels.
 */
import type { Codec, DecodedLayer, FieldValue } from '../../contracts/pdu.js';
import { bytesField, numField, readU16, strField, writeU16 } from '../checksum.js';

/** CHAP codes. */
export const CHAP_CODE = Object.freeze({ challenge: 1, response: 2, success: 3, failure: 4 });
/** Length of an MD5 response value (and of the challenges NetForge sends). */
export const CHAP_MD5_VALUE_BYTES = 16;

const CODE_TEXT: Readonly<Record<number, string>> = Object.freeze({ 1: 'challenge', 2: 'response', 3: 'success', 4: 'failure' });
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
    return { fields, fieldRanges, headerLength: avail, length: avail, error: 'CHAP packet truncated' };
  }
  fields.code = bytes[offset]!;
  fields.id = bytes[offset + 1]!;
  fieldRanges.code = [offset, 1];
  fieldRanges.id = [offset + 1, 1];
  const declared = readU16(bytes, offset + 2);
  const len = Math.min(Math.max(declared, 4), avail);
  const end = offset + len;
  let error: string | undefined = declared > avail ? `CHAP packet truncated (length ${declared}, ${avail} bytes present)` : declared < 4 ? `CHAP length ${declared} is smaller than the header` : undefined;
  const s = offset + 4;
  if (fields.code === CHAP_CODE.challenge || fields.code === CHAP_CODE.response) {
    if (s >= end) {
      if (error === undefined) error = `CHAP ${CODE_TEXT[fields.code]} has no value`;
    } else {
      const size = bytes[s]!;
      if (s + 1 + size > end) {
        if (error === undefined) error = `CHAP value of ${size} bytes runs past the packet`;
      } else {
        fields.value = bytes.slice(s + 1, s + 1 + size);
        fields.name = UTF8_DECODER.decode(bytes.subarray(s + 1 + size, end));
        fieldRanges.value = [s, 1 + size];
        fieldRanges.name = [s + 1 + size, end - (s + 1 + size)];
      }
    }
  } else if (fields.code === CHAP_CODE.success || fields.code === CHAP_CODE.failure) {
    fields.message = UTF8_DECODER.decode(bytes.subarray(s, end));
    fieldRanges.message = [s, end - s];
  } else if (error === undefined) {
    error = `unknown CHAP code ${fields.code}`;
  }
  const out: DecodedLayer = { fields, fieldRanges, headerLength: len, length: len };
  if (error !== undefined) out.error = error;
  return out;
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'chap';
  if (payload.length > 0) throw new Error('chap: a CHAP packet carries no inner layer');
  const code = numField(p, fields, 'code', null);
  const id = numField(p, fields, 'id', null);
  if (id < 0 || id > 0xff) throw new Error(`chap.id out of range: ${id}`);
  let data: number[];
  if (code === CHAP_CODE.challenge || code === CHAP_CODE.response) {
    const value = bytesField(p, fields, 'value');
    if (value.length < 1 || value.length > 0xff) throw new Error(`chap.value must hold 1 to 255 bytes, got ${value.length}`);
    data = [value.length, ...value, ...UTF8_ENCODER.encode(strField(p, fields, 'name', ''))];
  } else if (code === CHAP_CODE.success || code === CHAP_CODE.failure) {
    data = [...UTF8_ENCODER.encode(strField(p, fields, 'message', ''))];
  } else {
    throw new Error(`chap.code must be 1 to 4, got ${code}`);
  }
  const out = new Uint8Array(4 + data.length);
  if (out.length > 0xffff) throw new Error(`chap packet too large: ${out.length} bytes`);
  out[0] = code;
  out[1] = id;
  writeU16(out, 2, out.length);
  out.set(data, 4);
  return out;
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const code = typeof fields.code === 'number' ? CODE_TEXT[fields.code] ?? `code ${fields.code}` : '?';
  const who = typeof fields.name === 'string' && fields.name !== '' ? ` from ${fields.name}` : '';
  const msg = typeof fields.message === 'string' && fields.message !== '' ? `: ${fields.message}` : '';
  return `CHAP ${code} id ${String(fields.id ?? '?')}${who}${msg}`;
}

/** PPP CHAP codec [S19]. Required on encode: `code`, `id`; a challenge or response also `value`. */
export const chapCodec: Codec = {
  proto: 'chap',
  defaults: Object.freeze({ code: null, id: null }),
  decode,
  encode,
  summarize,
};
