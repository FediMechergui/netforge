/**
 * PPP framing codec [S19] (RFC 1661 §2, HDLC-like framing RFC 1662 without flags; ARCHITECTURE-P3 D17, §2.3, §3.9;
 * contracts/fields.ts `ppp`), and the packet layout the PPP control protocols share (RFC 1661 §5), used by the lcp,
 * ipcp and ipv6cp codecs.
 *
 * Wire image (no opening/closing flags in `bytes`, no byte stuffing, as the hdlc codec):
 *   `address(1)=0xff control(1)=0x03 protocol(2, big-endian) payload... fcs(2)`
 *  • `protocol` selects the next layer in the `ppp.proto` space (PPP_PROTO: 0x0021 IPv4, 0x0057 IPv6, 0xc021 LCP,
 *    0xc023 PAP, 0xc223 CHAP, 0x8021 IPCP, 0x8057 IPv6CP); the registry fills it from the inner layer
 *    (`LINK_FIELDS.ppp`) when a builder omits it. Unknown values decode as payload.
 *  • The FCS is CRC-16/X.25 over address..payload, written little-endian (the existing `crc16X25`); derived.
 *  • `ctx.fcsLen === 0` (a capture record without the CRC) bounds the payload to the remaining bytes and leaves
 *    `fcs`/`fcsValid` undefined, as for hdlc. `fixTrailer` attributes any slack before the FCS to the trailer.
 *
 * Control packets (`pppCpDecodeHeader`, `pppCpOptions`, `pppCpEncode`): `code(1) id(1) length(2) data`, the length
 * covering the whole packet; configure packets (codes 1–4) carry options `type(1) length(2… ) value`, the length
 * covering the option.
 */
import type { Codec, CodecContext, DecodedLayer, FieldValue, LayerView, MutationReason, ProtoName } from '../../contracts/pdu.js';
import { PPP_ADDRESS, PPP_CONTROL, PPP_FCS, PPP_HEADER } from '../../contracts/pdu.js';
import { crc16X25, numField, readU16, readU16LE, writeU16, writeU16LE } from '../checksum.js';
import { nextProto } from './dispatch.js';

/** Control-protocol codes (RFC 1661 §5; IPCP and IPv6CP use 1–7). */
export const PPP_CP_CODE = Object.freeze({
  configureRequest: 1,
  configureAck: 2,
  configureNak: 3,
  configureReject: 4,
  terminateRequest: 5,
  terminateAck: 6,
  codeReject: 7,
  protocolReject: 8,
  echoRequest: 9,
  echoReply: 10,
  discardRequest: 11,
});

const CODE_TEXT: Readonly<Record<number, string>> = Object.freeze({
  1: 'configure-request',
  2: 'configure-ack',
  3: 'configure-nak',
  4: 'configure-reject',
  5: 'terminate-request',
  6: 'terminate-ack',
  7: 'code-reject',
  8: 'protocol-reject',
  9: 'echo-request',
  10: 'echo-reply',
  11: 'discard-request',
});

/** Name of a control-protocol code ('configure-request', …), or 'code <n>'. */
export function pppCpCodeText(code: number): string {
  return CODE_TEXT[code] ?? `code ${code}`;
}

function hex16(v: number): string {
  return `0x${v.toString(16).padStart(4, '0')}`;
}

// ── ppp ──────────────────────────────────────────────────────────────────────

/** `ppp.protocol` value → next layer name (the `ppp.proto` space); anything unknown decodes as payload. */
export function protoForPppProtocol(protocol: number): ProtoName {
  return nextProto('ppp.proto', protocol);
}

function decode(bytes: Uint8Array, offset: number, length: number, ctx?: CodecContext): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  if (avail < PPP_HEADER) {
    if (avail >= 1) {
      fields.address = bytes[offset]!;
      fieldRanges.address = [offset, 1];
    }
    if (avail >= 2) {
      fields.control = bytes[offset + 1]!;
      fieldRanges.control = [offset + 1, 1];
    }
    return { fields, fieldRanges, headerLength: avail, length: avail, error: 'PPP header truncated' };
  }
  fields.address = bytes[offset]!;
  fields.control = bytes[offset + 1]!;
  fields.protocol = readU16(bytes, offset + 2);
  fieldRanges.address = [offset, 1];
  fieldRanges.control = [offset + 1, 1];
  fieldRanges.protocol = [offset + 2, 2];
  const next = protoForPppProtocol(fields.protocol);
  if (ctx?.fcsLen !== undefined && ctx.fcsLen !== PPP_FCS) {
    return { fields, fieldRanges, headerLength: PPP_HEADER, length: avail, next: { proto: next, offset: offset + PPP_HEADER, length: avail - PPP_HEADER } };
  }
  if (avail < PPP_HEADER + PPP_FCS) {
    return { fields, fieldRanges, headerLength: PPP_HEADER, length: avail, error: 'PPP frame truncated (no FCS)' };
  }
  const fcsOff = offset + avail - PPP_FCS;
  const fcs = readU16LE(bytes, fcsOff);
  fields.fcs = fcs;
  fields.fcsValid = crc16X25(bytes, offset, avail - PPP_FCS) === fcs;
  fieldRanges.fcs = [fcsOff, PPP_FCS];
  return {
    fields,
    fieldRanges,
    headerLength: PPP_HEADER,
    length: avail,
    trailerLength: PPP_FCS,
    next: { proto: next, offset: offset + PPP_HEADER, length: avail - PPP_HEADER - PPP_FCS },
  };
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'ppp';
  const address = numField(p, fields, 'address', PPP_ADDRESS);
  const control = numField(p, fields, 'control', PPP_CONTROL);
  const protocol = numField(p, fields, 'protocol', null);
  if (address < 0 || address > 0xff) throw new Error(`ppp.address out of range: ${address}`);
  if (control < 0 || control > 0xff) throw new Error(`ppp.control out of range: ${control}`);
  if (protocol < 0 || protocol > 0xffff) throw new Error(`ppp.protocol out of range: ${protocol}`);
  const body = PPP_HEADER + payload.length;
  const out = new Uint8Array(body + PPP_FCS);
  out[0] = address;
  out[1] = control;
  writeU16(out, 2, protocol);
  out.set(payload, PPP_HEADER);
  writeU16LE(out, body, crc16X25(out, 0, body));
  return out;
}

/** Attribute the slack between the payload bound and the inner layer's declared length to the trailer. Idempotent. */
function fixTrailer(self: LayerView, inner: LayerView | undefined): LayerView {
  if (!inner || self.error !== undefined) return self;
  const fcsRange = self.fieldRanges.fcs;
  const fcsLen = fcsRange ? fcsRange[1] : 0;
  const slack = self.length - self.headerLength - fcsLen - inner.length;
  if (slack <= 0) return self;
  return { ...self, trailerLength: slack + fcsLen };
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  return `PPP protocol ${typeof fields.protocol === 'number' ? hex16(fields.protocol) : '?'}`;
}

const DERIVED: Readonly<Record<string, MutationReason>> = Object.freeze({ fcs: 'FcsRecompute' });

/** PPP framing codec [S19]. Required on encode: `protocol` (the registry fills it from the inner layer). */
export const pppCodec: Codec = {
  proto: 'ppp',
  defaults: Object.freeze({ address: PPP_ADDRESS, control: PPP_CONTROL, protocol: null }),
  decode,
  encode,
  summarize,
  derived: DERIVED,
  fixTrailer,
};

// ── the shared control-packet layout (lcp, ipcp, ipv6cp) ─────────────────────

/** A decoded control-packet header. */
export interface PppCpHeader {
  readonly fields: Record<string, FieldValue>;
  readonly fieldRanges: Record<string, readonly [number, number]>;
  /** First data byte and end of the packet (bounded by the bytes present). */
  readonly dataStart: number;
  readonly end: number;
  /** Bytes the layer covers. */
  readonly covered: number;
  /** True when the 4-byte header is present (code, id and length were read). */
  readonly header: boolean;
  readonly error?: string;
}

/**
 * Decode `code id length` of a control packet (`label` names the protocol in errors). The length is kept as the
 * `length` field only when `lengthField` is true (lcp; the ipcp and ipv6cp tables have no such field).
 */
export function pppCpDecodeHeader(bytes: Uint8Array, offset: number, length: number, label: string, lengthField: boolean): PppCpHeader {
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
    return { fields, fieldRanges, dataStart: offset + avail, end: offset + avail, covered: avail, header: false, error: `${label} packet truncated` };
  }
  fields.code = bytes[offset]!;
  fields.id = bytes[offset + 1]!;
  fieldRanges.code = [offset, 1];
  fieldRanges.id = [offset + 1, 1];
  const declared = readU16(bytes, offset + 2);
  if (lengthField) {
    fields.length = declared;
    fieldRanges.length = [offset + 2, 2];
  }
  if (declared < 4) return { fields, fieldRanges, dataStart: offset + 4, end: offset + 4, covered: avail, header: true, error: `${label} length ${declared} is smaller than the header` };
  if (declared > avail) return { fields, fieldRanges, dataStart: offset + 4, end: offset + avail, covered: avail, header: true, error: `${label} packet truncated (length ${declared}, ${avail} bytes present)` };
  return { fields, fieldRanges, dataStart: offset + 4, end: offset + declared, covered: declared, header: true };
}

/** One configure option: its type, its whole range and where its value starts. */
export interface PppCpOption {
  readonly type: number;
  readonly offset: number;
  readonly length: number;
  readonly value: number;
}

/** The options of a configure packet's data `[start, end)`, and an error when one runs past the packet. */
export function pppCpOptions(bytes: Uint8Array, start: number, end: number, label: string): { options: PppCpOption[]; error?: string } {
  const options: PppCpOption[] = [];
  let i = start;
  while (i < end) {
    if (i + 2 > end) return { options, error: `${label} option truncated` };
    const type = bytes[i]!;
    const len = bytes[i + 1]!;
    if (len < 2 || i + len > end) return { options, error: `${label} option ${type} has a bad length ${len}` };
    options.push({ type, offset: i, length: len, value: i + 2 });
    i += len;
  }
  return { options };
}

/** A control packet `code id length data` (the length derived). */
export function pppCpEncode(label: string, fields: Readonly<Record<string, FieldValue>>, data: ArrayLike<number>, maxCode: number): Uint8Array {
  const code = numField(label, fields, 'code', null);
  const id = numField(label, fields, 'id', null);
  if (code < 1 || code > maxCode) throw new Error(`${label}.code out of range: ${code}`);
  if (id < 0 || id > 0xff) throw new Error(`${label}.id out of range: ${id}`);
  const total = 4 + data.length;
  if (total > 0xffff) throw new Error(`${label} packet too large: ${total} bytes`);
  const out = new Uint8Array(total);
  out[0] = code;
  out[1] = id;
  writeU16(out, 2, total);
  for (let k = 0; k < data.length; k++) out[4 + k] = data[k]!;
  return out;
}
