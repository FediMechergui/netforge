/**
 * HDLC serial framing codec (ARCHITECTURE-P1 D6, §3.9; contracts/fields.ts `hdlc`).
 *
 * Wire image (no opening/closing flags in `bytes`, no bit stuffing):
 *   `address(1) control(1) protocol(2, big-endian) payload... fcs(2)`
 *  • `address` defaults to 0x0f (unicast); keepalives use 0x8f (broadcast). `control` defaults to 0.
 *  • `protocol` shares the ethertype number space (0x0800 IPv4, 0x86dd IPv6, 0x8035 keepalive) and selects
 *    the next layer through the `ethertype` dispatch table; unknown values (keepalives) decode as payload.
 *  • The FCS is CRC-16/X.25 over address..payload, written little-endian (ISO/IEC 13239 bit order).
 *  • Fields: `address`, `control`, `protocol` (encode + decode); `fcs`, `fcsValid` (decode-only).
 *    `fcs` is derived: `encode` always recomputes it and ignores a builder value.
 *  • `next.length` is an UPPER BOUND (`avail - 4 - 2`). HDLC never pads, so `fixTrailer` attributes any
 *    bytes between the inner layer's declared end and the FCS to the trailer (a malformed or over-long
 *    frame) without inventing a padding field. Idempotent: the FCS length is read from its field range.
 *  • P1: `ctx.fcsLen === 0` (a c_hdlc capture record, CRC stripped) bounds the payload to the remaining
 *    bytes and leaves `fcs`/`fcsValid` undefined. Any value other than the native 2 falls back to 0.
 */
import type { Codec, CodecContext, DecodedLayer, FieldValue, LayerView, MutationReason, ProtoName } from '../../contracts/pdu.js';
import { HDLC_ADDRESS_UNICAST, HDLC_FCS, HDLC_HEADER, HDLC_PROTO_KEEPALIVE } from '../../contracts/pdu.js';
import { crc16X25, numField, readU16, readU16LE, writeU16, writeU16LE } from '../checksum.js';
import { nextProto } from './dispatch.js';

/** `0x0800` */
function hex16(v: number): string {
  return `0x${v.toString(16).padStart(4, '0')}`;
}

/** `0x0f` */
function hex8(v: number): string {
  return `0x${v.toString(16).padStart(2, '0')}`;
}

/** Protocol field value → next layer name (shared `ethertype` table); anything unknown decodes as payload. */
export function protoForHdlcProtocol(protocol: number): ProtoName {
  return nextProto('ethertype', protocol);
}

function decode(bytes: Uint8Array, offset: number, length: number, ctx?: CodecContext): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};

  if (avail < HDLC_HEADER) {
    if (avail >= 1) {
      fields.address = bytes[offset]!;
      fieldRanges.address = [offset, 1];
    }
    if (avail >= 2) {
      fields.control = bytes[offset + 1]!;
      fieldRanges.control = [offset + 1, 1];
    }
    return { fields, fieldRanges, headerLength: avail, length: avail, error: 'HDLC header truncated' };
  }
  fields.address = bytes[offset]!;
  fields.control = bytes[offset + 1]!;
  fields.protocol = readU16(bytes, offset + 2);
  fieldRanges.address = [offset, 1];
  fieldRanges.control = [offset + 1, 1];
  fieldRanges.protocol = [offset + 2, 2];

  if (ctx?.fcsLen !== undefined && ctx.fcsLen !== HDLC_FCS) {
    return {
      fields,
      fieldRanges,
      headerLength: HDLC_HEADER,
      length: avail,
      next: { proto: protoForHdlcProtocol(fields.protocol), offset: offset + HDLC_HEADER, length: avail - HDLC_HEADER },
    };
  }

  if (avail < HDLC_HEADER + HDLC_FCS) {
    return { fields, fieldRanges, headerLength: HDLC_HEADER, length: avail, error: 'HDLC frame truncated (no FCS)' };
  }

  const fcsOff = offset + avail - HDLC_FCS;
  const fcs = readU16LE(bytes, fcsOff);
  fields.fcs = fcs;
  fields.fcsValid = crc16X25(bytes, offset, avail - HDLC_FCS) === fcs;
  fieldRanges.fcs = [fcsOff, HDLC_FCS];

  return {
    fields,
    fieldRanges,
    headerLength: HDLC_HEADER,
    length: avail,
    trailerLength: HDLC_FCS,
    next: { proto: protoForHdlcProtocol(fields.protocol), offset: offset + HDLC_HEADER, length: avail - HDLC_HEADER - HDLC_FCS },
  };
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'hdlc';
  const address = numField(p, fields, 'address', HDLC_ADDRESS_UNICAST);
  const control = numField(p, fields, 'control', 0);
  const protocol = numField(p, fields, 'protocol', null);
  if (address < 0 || address > 0xff) throw new Error(`hdlc.address out of range: ${address}`);
  if (control < 0 || control > 0xff) throw new Error(`hdlc.control out of range: ${control}`);
  if (protocol < 0 || protocol > 0xffff) throw new Error(`hdlc.protocol out of range: ${protocol}`);

  const body = HDLC_HEADER + payload.length;
  const out = new Uint8Array(body + HDLC_FCS);
  out[0] = address;
  out[1] = control;
  writeU16(out, 2, protocol);
  out.set(payload, HDLC_HEADER);
  writeU16LE(out, body, crc16X25(out, 0, body));
  return out;
}

/**
 * Attribute the slack between the payload bound and the inner layer's declared length to the trailer.
 * Rewrites `trailerLength` only (HDLC has no padding field). Idempotent.
 */
function fixTrailer(self: LayerView, inner: LayerView | undefined): LayerView {
  if (!inner || self.error !== undefined) return self;
  const fcsRange = self.fieldRanges.fcs;
  const fcsLen = fcsRange ? fcsRange[1] : 0;
  const bound = self.length - self.headerLength - fcsLen;
  const slack = bound - inner.length;
  if (slack <= 0) return self;
  return { ...self, trailerLength: slack + fcsLen };
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const address = typeof fields.address === 'number' ? hex8(fields.address) : '?';
  if (fields.protocol === HDLC_PROTO_KEEPALIVE) return `HDLC keepalive address=${address}`;
  const protocol = typeof fields.protocol === 'number' ? hex16(fields.protocol) : '?';
  return `HDLC address=${address} protocol=${protocol}`;
}

const DERIVED: Readonly<Record<string, MutationReason>> = Object.freeze({ fcs: 'FcsRecompute' });

/** HDLC codec. Required on encode: `protocol` (the registry fills it from the inner layer when possible). */
export const hdlcCodec: Codec = {
  proto: 'hdlc',
  defaults: Object.freeze({ address: HDLC_ADDRESS_UNICAST, control: 0, protocol: null }),
  decode,
  encode,
  summarize,
  derived: DERIVED,
  fixTrailer,
};
