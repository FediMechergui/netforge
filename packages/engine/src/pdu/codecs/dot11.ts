/**
 * IEEE 802.11 MAC frame codec (ARCHITECTURE-P1 D5, §3.6; contracts/fields.ts `dot11`).
 *
 * Wire image (802.11 byte order: multi-byte MAC header fields are LITTLE-endian):
 *   management / data: `fc(2) duration(2) addr1(6) addr2(6) addr3(6) seqCtl(2) [qosCtl(2)] body... fcs(4)`
 *   control ack / cts: `fc(2) duration(2) addr1(6) fcs(4)`
 *   control rts:       `fc(2) duration(2) addr1(6) addr2(6) fcs(4)`
 *   other control subtypes decode with the short (addr1-only) layout.
 *  • Frame control byte 0 = `subtype << 4 | type << 2 | version` (version must be 0); byte 1 carries the
 *    flags toDs (bit 0), fromDs (bit 1), retry (bit 3) and protected (bit 6). Other flag bits encode as 0.
 *  • `seq` is the 12-bit sequence number (`seqCtl >> 4`); the fragment number encodes as 0.
 *  • qos-data adds a 2-byte QoS control field (encoded as 0, not exposed as a field).
 *  • The FCS is the IEEE CRC-32 over the header and body, written little-endian (as ethernet); no padding.
 *  • Next layer: management → `dot11-mgmt` (its fixed fields depend on `subtype`, read from the
 *    CodecContext); data / qos-data with a body → `llc`; control frames and empty data frames end the chain.
 *  • Frames with both toDs and fromDs set (4-address WDS) are not simulated: decode reports an error and
 *    stops; encode throws.
 *  • Subtype names follow contracts/fields.ts, plus `reassoc-resp` and `action` for completeness. A subtype
 *    number without a name decodes as `unknown-<type>-<n>` and re-encodes to the same number.
 *  • Fields: frameType, subtype, toDs, fromDs, retry, protected, duration, addr1, addr2, addr3, seq
 *    (encode + decode, as present in the frame); fcs, fcsValid (decode-only; fcs derived).
 *  • `fixTrailer` attributes bytes between the inner layer's declared end and the FCS to the trailer.
 *  • P1: `ctx.fcsLen === 0` (an ieee802_11 capture record, FCS stripped) bounds the body to the remaining bytes
 *    and leaves `fcs`/`fcsValid` undefined. Any value other than the native 4 falls back to 0.
 *  • P2 FCS-in-tunnel rule (ARCHITECTURE-P2 §2.3): a native 802.11 frame carried inside a CAPWAP tunnel (its nearest
 *    outer layer is `capwap`) has no FCS. Decode then behaves as with `ctx.fcsLen === 0`; encode omits the FCS.
 */
import type { Codec, CodecContext, DecodedLayer, FieldValue, LayerView, MutationReason, ProtoName } from '../../contracts/pdu.js';
import { DOT11_FCS, DOT11_HEADER, DOT11_MAX_FRAME } from '../../contracts/pdu.js';
import { bytesToMac, macToBytes } from '../../contracts/addr.js';
import { crc32, numField, readU16LE, readU32LE, strField, writeU16LE, writeU32LE } from '../checksum.js';
import { isTunnelledFrame } from './ethernet.js';

/** 802.11 frame type as carried in `dot11.frameType`. */
export type Dot11FrameType = 'mgmt' | 'ctrl' | 'data';

const TYPE_CODE: Readonly<Record<Dot11FrameType, number>> = Object.freeze({ mgmt: 0, ctrl: 1, data: 2 });
const TYPE_NAME: readonly Dot11FrameType[] = Object.freeze(['mgmt', 'ctrl', 'data']);

/** One named subtype: its frame type and 4-bit subtype number. */
export interface Dot11SubtypeInfo {
  readonly frameType: Dot11FrameType;
  readonly code: number;
}

/** Named subtypes (contracts/fields.ts `dot11.subtype`, plus reassoc-resp and action). */
export const DOT11_SUBTYPES: Readonly<Record<string, Dot11SubtypeInfo>> = Object.freeze({
  'assoc-req': Object.freeze({ frameType: 'mgmt', code: 0 }),
  'assoc-resp': Object.freeze({ frameType: 'mgmt', code: 1 }),
  'reassoc-req': Object.freeze({ frameType: 'mgmt', code: 2 }),
  'reassoc-resp': Object.freeze({ frameType: 'mgmt', code: 3 }),
  'probe-req': Object.freeze({ frameType: 'mgmt', code: 4 }),
  'probe-resp': Object.freeze({ frameType: 'mgmt', code: 5 }),
  beacon: Object.freeze({ frameType: 'mgmt', code: 8 }),
  disassoc: Object.freeze({ frameType: 'mgmt', code: 10 }),
  auth: Object.freeze({ frameType: 'mgmt', code: 11 }),
  deauth: Object.freeze({ frameType: 'mgmt', code: 12 }),
  action: Object.freeze({ frameType: 'mgmt', code: 13 }),
  rts: Object.freeze({ frameType: 'ctrl', code: 11 }),
  cts: Object.freeze({ frameType: 'ctrl', code: 12 }),
  ack: Object.freeze({ frameType: 'ctrl', code: 13 }),
  data: Object.freeze({ frameType: 'data', code: 0 }),
  'qos-data': Object.freeze({ frameType: 'data', code: 8 }),
} satisfies Record<string, Dot11SubtypeInfo>);

const SUBTYPE_BY_CODE = new Map<string, string>();
for (const name of Object.keys(DOT11_SUBTYPES)) {
  const info = DOT11_SUBTYPES[name]!;
  SUBTYPE_BY_CODE.set(`${info.frameType}|${info.code}`, name);
}

const UNKNOWN_SUBTYPE = /^unknown-(mgmt|ctrl|data)-(\d{1,2})$/;

/** Subtype name for a (type, number) pair; unnamed numbers become `unknown-<type>-<n>`. */
export function dot11SubtypeName(frameType: Dot11FrameType, code: number): string {
  return SUBTYPE_BY_CODE.get(`${frameType}|${code}`) ?? `unknown-${frameType}-${code}`;
}

/** Frame type and number of a subtype name (named or `unknown-<type>-<n>`), or undefined. */
export function dot11SubtypeInfo(subtype: string): Dot11SubtypeInfo | undefined {
  if (Object.prototype.hasOwnProperty.call(DOT11_SUBTYPES, subtype)) return DOT11_SUBTYPES[subtype];
  const m = UNKNOWN_SUBTYPE.exec(subtype);
  if (!m) return undefined;
  const code = Number(m[2]);
  return code <= 15 ? { frameType: m[1] as Dot11FrameType, code } : undefined;
}

const FLAG_TO_DS = 0x01;
const FLAG_FROM_DS = 0x02;
const FLAG_RETRY = 0x08;
const FLAG_PROTECTED = 0x40;
const QOS_CONTROL = 2;
/** Control-frame header lengths (without FCS): ack/cts carry addr1 only, rts addr1+addr2. */
const CTRL_SHORT = 10;
const CTRL_RTS = 16;

/** Header layout of a frame: its length and which addresses / sequence control it carries. */
function layoutOf(info: Dot11SubtypeInfo): { header: number; addrs: 1 | 2 | 3; seq: boolean } {
  if (info.frameType === 'ctrl') {
    return info.code === DOT11_SUBTYPES.rts!.code ? { header: CTRL_RTS, addrs: 2, seq: false } : { header: CTRL_SHORT, addrs: 1, seq: false };
  }
  const qos = info.frameType === 'data' && (info.code & 0x08) !== 0;
  return { header: DOT11_HEADER + (qos ? QOS_CONTROL : 0), addrs: 3, seq: true };
}

function nextFor(info: Dot11SubtypeInfo, bodyLength: number): ProtoName | undefined {
  if (info.frameType === 'mgmt') return 'dot11-mgmt';
  if (info.frameType === 'data' && bodyLength > 0) return 'llc';
  return undefined;
}

function decode(bytes: Uint8Array, offset: number, length: number, ctx?: CodecContext): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};

  if (avail < 2) {
    return { fields, fieldRanges, headerLength: avail, length: avail, error: '802.11 header truncated' };
  }
  const fc0 = bytes[offset]!;
  const fc1 = bytes[offset + 1]!;
  const version = fc0 & 0x03;
  const typeCode = (fc0 >>> 2) & 0x03;
  const code = fc0 >>> 4;
  if (typeCode === 3) {
    return { fields, fieldRanges, headerLength: 2, length: avail, error: '802.11 reserved frame type 3' };
  }
  const frameType = TYPE_NAME[typeCode]!;
  const info: Dot11SubtypeInfo = { frameType, code };
  fields.frameType = frameType;
  fields.subtype = dot11SubtypeName(frameType, code);
  fields.toDs = (fc1 & FLAG_TO_DS) !== 0;
  fields.fromDs = (fc1 & FLAG_FROM_DS) !== 0;
  fields.retry = (fc1 & FLAG_RETRY) !== 0;
  fields.protected = (fc1 & FLAG_PROTECTED) !== 0;
  fieldRanges.frameType = [offset, 1];
  fieldRanges.subtype = [offset, 1];
  fieldRanges.toDs = [offset + 1, 1];
  fieldRanges.fromDs = [offset + 1, 1];
  fieldRanges.retry = [offset + 1, 1];
  fieldRanges.protected = [offset + 1, 1];

  if (version !== 0) {
    return { fields, fieldRanges, headerLength: 2, length: avail, error: `unsupported 802.11 protocol version ${version}` };
  }

  const layout = layoutOf(info);
  if (avail < layout.header) {
    let off = offset + 2;
    if (avail >= 4) {
      fields.duration = readU16LE(bytes, off);
      fieldRanges.duration = [off, 2];
    }
    off += 2;
    for (let i = 1; i <= layout.addrs; i++, off += 6) {
      if (off + 6 > offset + avail) break;
      fields[`addr${i}`] = bytesToMac(bytes, off);
      fieldRanges[`addr${i}`] = [off, 6];
    }
    return { fields, fieldRanges, headerLength: avail, length: avail, error: '802.11 header truncated' };
  }

  fields.duration = readU16LE(bytes, offset + 2);
  fieldRanges.duration = [offset + 2, 2];
  let off = offset + 4;
  for (let i = 1; i <= layout.addrs; i++, off += 6) {
    fields[`addr${i}`] = bytesToMac(bytes, off);
    fieldRanges[`addr${i}`] = [off, 6];
  }
  if (layout.seq) {
    fields.seq = readU16LE(bytes, off) >>> 4;
    fieldRanges.seq = [off, 2];
  }

  if (fields.toDs === true && fields.fromDs === true) {
    return { fields, fieldRanges, headerLength: layout.header, length: avail, error: '4-address (WDS) 802.11 frames are not simulated' };
  }
  if ((ctx?.fcsLen !== undefined && ctx.fcsLen !== DOT11_FCS) || isTunnelledFrame(ctx)) {
    const body = avail - layout.header;
    const name = nextFor(info, body);
    const bare: DecodedLayer = { fields, fieldRanges, headerLength: layout.header, length: avail };
    if (name !== undefined) bare.next = { proto: name, offset: offset + layout.header, length: body };
    return bare;
  }
  if (avail < layout.header + DOT11_FCS) {
    return { fields, fieldRanges, headerLength: layout.header, length: avail, error: '802.11 frame truncated (no FCS)' };
  }

  const fcsOff = offset + avail - DOT11_FCS;
  const fcs = readU32LE(bytes, fcsOff);
  fields.fcs = fcs;
  fields.fcsValid = crc32(bytes, offset, avail - DOT11_FCS) === fcs;
  fieldRanges.fcs = [fcsOff, DOT11_FCS];

  const bodyLength = avail - layout.header - DOT11_FCS;
  const nextName = nextFor(info, bodyLength);
  const out: DecodedLayer = {
    fields,
    fieldRanges,
    headerLength: layout.header,
    length: avail,
    trailerLength: DOT11_FCS,
  };
  if (nextName !== undefined) out.next = { proto: nextName, offset: offset + layout.header, length: bodyLength };
  return out;
}

function boolField(fields: Readonly<Record<string, FieldValue>>, key: string): boolean {
  const v = fields[key];
  if (v === undefined || v === null) return false;
  if (typeof v === 'boolean') return v;
  if (v === 0 || v === 1) return v === 1;
  throw new Error(`dot11.${key} must be a boolean`);
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array, ctx?: CodecContext): Uint8Array {
  const p = 'dot11';
  const subtype = strField(p, fields, 'subtype', null);
  const info = dot11SubtypeInfo(subtype);
  if (!info) throw new Error(`dot11.subtype unknown: "${subtype}"`);
  const frameType = strField(p, fields, 'frameType', null);
  if (!Object.prototype.hasOwnProperty.call(TYPE_CODE, frameType)) throw new Error(`dot11.frameType unknown: "${frameType}"`);
  if (frameType !== info.frameType) throw new Error(`dot11.subtype "${subtype}" is a ${info.frameType} frame, not ${frameType}`);
  const toDs = boolField(fields, 'toDs');
  const fromDs = boolField(fields, 'fromDs');
  if (toDs && fromDs) throw new Error('dot11: 4-address (WDS) frames with toDs and fromDs are not simulated');
  const duration = numField(p, fields, 'duration', 0);
  if (duration < 0 || duration > 0xffff) throw new Error(`dot11.duration out of range: ${duration}`);
  const seq = numField(p, fields, 'seq', 0);
  if (seq < 0 || seq > 0xfff) throw new Error(`dot11.seq out of range: ${seq}`);

  const layout = layoutOf(info);
  if (info.frameType === 'ctrl' && payload.length > 0) throw new Error(`dot11: control frame "${subtype}" carries no body`);
  const body = layout.header + payload.length;
  const tunnelled = isTunnelledFrame(ctx);
  const total = body + (tunnelled ? 0 : DOT11_FCS);
  if (total > DOT11_MAX_FRAME) throw new Error(`dot11 frame too large: ${total} bytes (max ${DOT11_MAX_FRAME})`);

  const out = new Uint8Array(total);
  out[0] = (info.code << 4) | (TYPE_CODE[info.frameType] << 2);
  out[1] = (toDs ? FLAG_TO_DS : 0) | (fromDs ? FLAG_FROM_DS : 0)
    | (boolField(fields, 'retry') ? FLAG_RETRY : 0) | (boolField(fields, 'protected') ? FLAG_PROTECTED : 0);
  writeU16LE(out, 2, duration);
  let off = 4;
  out.set(macToBytes(strField(p, fields, 'addr1', null)), off);
  off += 6;
  if (layout.addrs >= 2) {
    out.set(macToBytes(strField(p, fields, 'addr2', null)), off);
    off += 6;
  }
  if (layout.addrs >= 3) {
    out.set(macToBytes(strField(p, fields, 'addr3', null)), off);
    off += 6;
  }
  if (layout.seq) writeU16LE(out, off, seq << 4); // QoS control (qos-data) stays zero
  out.set(payload, layout.header);
  if (!tunnelled) writeU32LE(out, body, crc32(out, 0, body));
  return out;
}

/**
 * Attribute the slack between the body bound and the inner layer's declared length to the trailer.
 * Rewrites `trailerLength` only (802.11 never pads). Idempotent.
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

const SUBTYPE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'assoc-req': 'association request',
  'assoc-resp': 'association response',
  'reassoc-req': 'reassociation request',
  'reassoc-resp': 'reassociation response',
  'probe-req': 'probe request',
  'probe-resp': 'probe response',
  beacon: 'beacon',
  disassoc: 'disassociation',
  auth: 'authentication',
  deauth: 'deauthentication',
  action: 'action',
  rts: 'request to send',
  cts: 'clear to send',
  ack: 'acknowledgement',
  data: 'data',
  'qos-data': 'QoS data',
});

/** Human text for a subtype name (`probe request`), falling back to the name itself. */
export function dot11SubtypeText(subtype: FieldValue | undefined): string {
  if (typeof subtype !== 'string') return 'frame';
  return Object.prototype.hasOwnProperty.call(SUBTYPE_TEXT, subtype) ? SUBTYPE_TEXT[subtype]! : subtype;
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const what = dot11SubtypeText(fields.subtype);
  const from = fields.addr2 !== undefined ? `${String(fields.addr2)} > ` : '';
  const to = String(fields.addr1 ?? '?');
  const ds = fields.toDs === true ? ' (to DS)' : fields.fromDs === true ? ' (from DS)' : '';
  const retry = fields.retry === true ? ' retry' : '';
  return `802.11 ${what} ${from}${to}${ds}${retry}`;
}

const DERIVED: Readonly<Record<string, MutationReason>> = Object.freeze({ fcs: 'FcsRecompute' });

/** 802.11 MAC codec. Required on encode: frameType, subtype, addr1 (plus addr2/addr3 where the frame carries them). */
export const dot11Codec: Codec = {
  proto: 'dot11',
  defaults: Object.freeze({
    frameType: null,
    subtype: null,
    toDs: false,
    fromDs: false,
    retry: false,
    protected: false,
    duration: 0,
    addr1: null,
    addr2: null,
    addr3: null,
    seq: 0,
  }),
  decode,
  encode,
  summarize,
  derived: DERIVED,
  fixTrailer,
};
