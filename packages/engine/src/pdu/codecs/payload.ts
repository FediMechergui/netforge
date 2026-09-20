/**
 * Raw payload codec — spec §4.5. The terminal layer of every decode chain.
 *
 * Single field `data` (Uint8Array): on decode a COPY of `bytes[offset, offset+length)`
 * (the bound handed down by the outer codec is the whole layer — there is no header);
 * on encode `data` followed by any `payload` bytes. Never chains further, and an
 * unknown protocol name in `decodeLayers` falls back to this codec.
 */
import type { Codec, DecodedLayer, FieldValue } from '../../contracts/pdu.js';
import { bytesField } from '../checksum.js';

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  return {
    fields: { data: bytes.slice(offset, offset + avail) },
    fieldRanges: { data: [offset, avail] },
    headerLength: 0,
    length: avail,
  };
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const data = bytesField('payload', fields, 'data');
  if (payload.length === 0) return data.slice();
  const out = new Uint8Array(data.length + payload.length);
  out.set(data, 0);
  out.set(payload, data.length);
  return out;
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const n = fields.data instanceof Uint8Array ? fields.data.length : 0;
  return `payload ${n} bytes`;
}

/** Raw bytes codec. */
export const payloadCodec: Codec = {
  proto: 'payload',
  defaults: Object.freeze({ data: new Uint8Array(0) }),
  decode,
  encode,
  summarize,
};
