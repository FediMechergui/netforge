/**
 * CAPWAP codec (RFC 5415 header, control header and message elements; RFC 5416 IEEE 802.11 binding message types) —
 * ARCHITECTURE-P2 D8, D17, §2.3, §3.12; contracts/fields.ts `capwap`. Reached through UDP 5246 (control) and 5247
 * (data). Control versus data is decided by the enclosing udp layer's ports (destination first, then source); with no
 * udp layer outside it, a message decodes as control and encodes as control when `messageType` is set.
 *
 * Wire image (big-endian):
 *   header (8 bytes): `preamble(1)=0` then 24 bits `HLEN(5)=2 RID(5)=radioId WBID(5)=wbid T(1)=tbit F L W M K(1)=keepAlive
 *   flags(3)`, then `fragmentId(2) fragmentOffset/reserved(2)` (always 0: nothing is fragmented).
 *   control: header + `messageType(4) seq(1) msgElementLength(2) flags(1)` + message elements `type(2) length(2) value`
 *            (msgElementLength counts the bytes after `seq`: itself, the flags byte and the elements).
 *     4 AC Name → acName     33 Result Code → resultCode (u32)     45 WTP Name → wtpName
 *     37 Vendor Specific Payload, vendor id NF_OUI: element 1 → wlans (one WLAN per IEEE 802.11 WLAN Configuration
 *        Request: '<id>:<ssid>:<security>:<vlan>:<keyTag>', never a passphrase); element 2 → stations (WTP Event
 *        station reports '<add|del>:<station mac>:<bssid>:<wlanId>' joined by ';').
 *     Encode writes the present ones in that order; decode skips other elements.
 *   data: header, then the tunnelled frame — a native 802.11 frame when T is set (`dot11`), an 802.3 frame otherwise
 *         (`ethernet`); neither carries an FCS inside the tunnel (the ethernet and dot11 codecs see `capwap` as their
 *         nearest outer layer). A data-channel keep-alive (K set, `keepAlive`) carries `msgElementLength(2)=0` and no
 *         frame.
 *  • The DTLS session is simulated (§3.12): records are never on the wire; control messages after the DTLS step carry
 *    `PduMeta.protected`. A header whose preamble type is 1 (a DTLS record) decodes with an error and stops.
 *  • Decode errors: truncation, a preamble other than 0, an element running past the message.
 */
import type { Codec, CodecContext, DecodedLayer, FieldValue, ProtoName } from '../../contracts/pdu.js';
import { CAPWAP_MSG, NF_OUI, UDP_PORT_CAPWAP_CONTROL, UDP_PORT_CAPWAP_DATA } from '../../contracts/pdu.js';
import { numField, readU16, readU32, strField, writeU16, writeU32 } from '../checksum.js';

/** CAPWAP header length (HLEN 2). */
export const CAPWAP_HEADER = 8;
/** Control header length (message type, sequence, element length, flags). */
export const CAPWAP_CONTROL_HEADER = 8;
/** Message element types used (RFC 5415 §4.6). */
export const CAPWAP_ELEMENT = Object.freeze({ acName: 4, resultCode: 33, vendorSpecific: 37, wtpName: 45 });
/** NF vendor-specific element ids (under NF_OUI). */
export const CAPWAP_NF_ELEMENT = Object.freeze({ wlans: 1, stations: 2 });
/** Wireless binding id of IEEE 802.11. */
export const CAPWAP_WBID_IEEE80211 = 1;

const MESSAGE_NAMES: Readonly<Record<number, string>> = Object.freeze({
  1: 'Discovery Request',
  2: 'Discovery Response',
  3: 'Join Request',
  4: 'Join Response',
  5: 'Configuration Status Request',
  6: 'Configuration Status Response',
  7: 'Configuration Update Request',
  8: 'Configuration Update Response',
  9: 'WTP Event Request',
  10: 'WTP Event Response',
  11: 'Change State Event Request',
  12: 'Change State Event Response',
  13: 'Echo Request',
  14: 'Echo Response',
  15: 'Image Data Request',
  16: 'Image Data Response',
  17: 'Reset Request',
  18: 'Reset Response',
  19: 'Primary Discovery Request',
  20: 'Primary Discovery Response',
  21: 'Data Transfer Request',
  22: 'Data Transfer Response',
  23: 'Clear Configuration Request',
  24: 'Clear Configuration Response',
  25: 'Station Configuration Request',
  26: 'Station Configuration Response',
  [CAPWAP_MSG.wlanConfigReq]: 'IEEE 802.11 WLAN Configuration Request',
  [CAPWAP_MSG.wlanConfigResp]: 'IEEE 802.11 WLAN Configuration Response',
});

/** The RFC name of a control message type ('Join Request'), or 'message type <n>'. */
export function capwapMessageName(messageType: number): string {
  return MESSAGE_NAMES[messageType] ?? `message type ${messageType}`;
}

const FLAG_T = 0x100;
const FLAG_K = 0x008;
const HLEN = CAPWAP_HEADER / 4;

/** 'control' or 'data' from the nearest enclosing udp layer's ports (destination first), else undefined. */
function channelFromUdp(ctx: CodecContext | undefined): 'control' | 'data' | undefined {
  const outer = ctx?.outer;
  if (!outer) return undefined;
  for (let i = outer.length - 1; i >= 0; i--) {
    const o = outer[i]!;
    if (o.proto !== 'udp') continue;
    const dst = o.fields.dstPort;
    const src = o.fields.srcPort;
    if (dst === UDP_PORT_CAPWAP_CONTROL) return 'control';
    if (dst === UDP_PORT_CAPWAP_DATA) return 'data';
    if (src === UDP_PORT_CAPWAP_CONTROL) return 'control';
    if (src === UDP_PORT_CAPWAP_DATA) return 'data';
    return undefined;
  }
  return undefined;
}

function text(bytes: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i < to; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

function decodeElements(
  bytes: Uint8Array,
  start: number,
  end: number,
  fields: Record<string, FieldValue>,
  fieldRanges: Record<string, readonly [number, number]>,
): string | undefined {
  let i = start;
  while (i < end) {
    if (i + 4 > end) return 'CAPWAP message element truncated';
    const type = readU16(bytes, i);
    const len = readU16(bytes, i + 2);
    const v = i + 4;
    if (v + len > end) return `CAPWAP message element ${type} runs past the message`;
    const range: readonly [number, number] = [i, 4 + len];
    if (type === CAPWAP_ELEMENT.acName) {
      fields.acName = text(bytes, v, v + len);
      fieldRanges.acName = range;
    } else if (type === CAPWAP_ELEMENT.wtpName) {
      fields.wtpName = text(bytes, v, v + len);
      fieldRanges.wtpName = range;
    } else if (type === CAPWAP_ELEMENT.resultCode && len >= 4) {
      fields.resultCode = readU32(bytes, v);
      fieldRanges.resultCode = range;
    } else if (type === CAPWAP_ELEMENT.vendorSpecific && len >= 6 && readU32(bytes, v) === NF_OUI) {
      const id = readU16(bytes, v + 4);
      if (id === CAPWAP_NF_ELEMENT.wlans) {
        fields.wlans = text(bytes, v + 6, v + len);
        fieldRanges.wlans = range;
      } else if (id === CAPWAP_NF_ELEMENT.stations) {
        fields.stations = text(bytes, v + 6, v + len);
        fieldRanges.stations = range;
      }
    }
    i = v + len;
  }
  return undefined;
}

function decode(bytes: Uint8Array, offset: number, length: number, ctx?: CodecContext): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  if (avail < CAPWAP_HEADER) return { fields, fieldRanges, headerLength: avail, length: avail, error: 'CAPWAP header truncated' };
  const preamble = bytes[offset]!;
  if (preamble !== 0) {
    const what = (preamble & 0x0f) === 1 ? 'a DTLS record (not simulated on the wire)' : `preamble 0x${preamble.toString(16).padStart(2, '0')}`;
    return { fields, fieldRanges, headerLength: avail, length: avail, error: `CAPWAP ${what}` };
  }
  const bits = (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
  const hlen = (bits >>> 19) * 4;
  fields.radioId = (bits >>> 14) & 0x1f;
  fields.wbid = (bits >>> 9) & 0x1f;
  fields.tbit = (bits & FLAG_T) !== 0;
  fieldRanges.radioId = [offset + 1, 2];
  fieldRanges.wbid = [offset + 2, 1];
  fieldRanges.tbit = [offset + 2, 1];
  if (hlen < CAPWAP_HEADER || hlen > avail) {
    return { fields, fieldRanges, headerLength: Math.min(Math.max(hlen, CAPWAP_HEADER), avail), length: avail, error: `bad CAPWAP header length ${hlen}` };
  }
  const body = offset + hlen;
  const end = offset + avail;
  const channel = channelFromUdp(ctx) ?? 'control';

  if (channel === 'data') {
    const keepAlive = (bits & FLAG_K) !== 0;
    fields.keepAlive = keepAlive;
    fieldRanges.keepAlive = [offset + 3, 1];
    if (keepAlive) return { fields, fieldRanges, headerLength: avail, length: avail };
    const out: DecodedLayer = { fields, fieldRanges, headerLength: hlen, length: avail };
    if (end > body) {
      const inner: ProtoName = fields.tbit ? 'dot11' : 'ethernet';
      out.next = { proto: inner, offset: body, length: end - body };
    }
    return out;
  }

  if (avail < hlen + CAPWAP_CONTROL_HEADER) {
    return { fields, fieldRanges, headerLength: avail, length: avail, error: 'CAPWAP control header truncated' };
  }
  fields.messageType = readU32(bytes, body);
  fields.seq = bytes[body + 4]!;
  fieldRanges.messageType = [body, 4];
  fieldRanges.seq = [body + 4, 1];
  const elementLength = readU16(bytes, body + 5);
  const elementsStart = body + CAPWAP_CONTROL_HEADER;
  const elementsEnd = Math.min(end, body + 5 + elementLength);
  const error = elementsEnd < elementsStart ? `bad CAPWAP message element length ${elementLength}` : decodeElements(bytes, elementsStart, elementsEnd, fields, fieldRanges);
  const out: DecodedLayer = { fields, fieldRanges, headerLength: avail, length: avail };
  if (error !== undefined) out.error = error;
  return out;
}

function textBytes(s: string, key: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) throw new Error(`capwap.${key} must be printable ASCII`);
    out.push(c);
  }
  return out;
}

function element(out: number[], type: number, value: readonly number[]): void {
  if (value.length > 0xffff) throw new Error(`capwap message element ${type} is too long`);
  out.push((type >>> 8) & 0xff, type & 0xff, (value.length >>> 8) & 0xff, value.length & 0xff, ...value);
}

function present(fields: Record<string, FieldValue>, key: string): boolean {
  return fields[key] !== undefined && fields[key] !== null;
}

function boolField(fields: Record<string, FieldValue>, key: string): boolean {
  const v = fields[key];
  if (v === undefined || v === null) return false;
  if (typeof v === 'boolean') return v;
  if (v === 0 || v === 1) return v === 1;
  throw new Error(`capwap.${key} must be a boolean`);
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array, ctx?: CodecContext): Uint8Array {
  const p = 'capwap';
  const radioId = numField(p, fields, 'radioId', 0);
  const wbid = numField(p, fields, 'wbid', CAPWAP_WBID_IEEE80211);
  if (radioId < 0 || radioId > 31) throw new Error(`capwap.radioId out of range: ${radioId}`);
  if (wbid < 0 || wbid > 31) throw new Error(`capwap.wbid out of range: ${wbid}`);
  const tbit = boolField(fields, 'tbit');
  const keepAlive = boolField(fields, 'keepAlive');
  const channel = channelFromUdp(ctx) ?? (present(fields, 'messageType') ? 'control' : 'data');
  const header = (flags: number): number[] => {
    const bits = (HLEN << 19) | (radioId << 14) | (wbid << 9) | flags;
    return [0, (bits >>> 16) & 0xff, (bits >>> 8) & 0xff, bits & 0xff, 0, 0, 0, 0];
  };

  if (channel === 'data') {
    if (keepAlive) {
      if (payload.length > 0) throw new Error('capwap: a data-channel keep-alive carries no frame');
      return Uint8Array.from([...header(FLAG_K | (tbit ? FLAG_T : 0)), 0, 0]);
    }
    const out = new Uint8Array(CAPWAP_HEADER + payload.length);
    out.set(header(tbit ? FLAG_T : 0), 0);
    out.set(payload, CAPWAP_HEADER);
    return out;
  }

  if (payload.length > 0) throw new Error('capwap: a control message carries no inner layer');
  const messageType = numField(p, fields, 'messageType', null);
  if (messageType < 0 || messageType > 0xffffffff) throw new Error(`capwap.messageType out of range: ${messageType}`);
  const seq = numField(p, fields, 'seq', 0);
  if (seq < 0 || seq > 0xff) throw new Error(`capwap.seq out of range: ${seq}`);
  const elements: number[] = [];
  if (present(fields, 'acName')) element(elements, CAPWAP_ELEMENT.acName, textBytes(strField(p, fields, 'acName', null), 'acName'));
  if (present(fields, 'resultCode')) {
    const rc = numField(p, fields, 'resultCode', null);
    if (rc < 0 || rc > 0xffffffff) throw new Error(`capwap.resultCode out of range: ${rc}`);
    element(elements, CAPWAP_ELEMENT.resultCode, [(rc >>> 24) & 0xff, (rc >>> 16) & 0xff, (rc >>> 8) & 0xff, rc & 0xff]);
  }
  if (present(fields, 'wtpName')) element(elements, CAPWAP_ELEMENT.wtpName, textBytes(strField(p, fields, 'wtpName', null), 'wtpName'));
  for (const key of ['wlans', 'stations'] as const) {
    if (!present(fields, key)) continue;
    const id = CAPWAP_NF_ELEMENT[key];
    const vendor = [(NF_OUI >>> 24) & 0xff, (NF_OUI >>> 16) & 0xff, (NF_OUI >>> 8) & 0xff, NF_OUI & 0xff, (id >>> 8) & 0xff, id & 0xff];
    element(elements, CAPWAP_ELEMENT.vendorSpecific, [...vendor, ...textBytes(strField(p, fields, key, null), key)]);
  }
  const elementLength = elements.length + 3;
  if (elementLength > 0xffff) throw new Error('capwap: message elements are too long');
  const out = new Uint8Array(CAPWAP_HEADER + CAPWAP_CONTROL_HEADER + elements.length);
  out.set(header(tbit ? FLAG_T : 0), 0);
  writeU32(out, CAPWAP_HEADER, messageType);
  out[CAPWAP_HEADER + 4] = seq;
  writeU16(out, CAPWAP_HEADER + 5, elementLength);
  // flags byte (CAPWAP_HEADER + 7) stays 0
  out.set(elements, CAPWAP_HEADER + CAPWAP_CONTROL_HEADER);
  return out;
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  if (typeof fields.messageType === 'number') {
    const parts: string[] = [`CAPWAP ${capwapMessageName(fields.messageType)}`];
    if (typeof fields.wtpName === 'string') parts.push(`from ${fields.wtpName}`);
    if (typeof fields.acName === 'string') parts.push(`controller ${fields.acName}`);
    if (typeof fields.resultCode === 'number') parts.push(`result ${fields.resultCode}`);
    if (typeof fields.wlans === 'string') parts.push(`WLAN ${fields.wlans.split(':')[1] ?? fields.wlans}`);
    if (typeof fields.stations === 'string') parts.push(`stations ${fields.stations}`);
    parts.push(`seq ${String(fields.seq ?? '?')}`);
    return parts.join(' ');
  }
  if (fields.keepAlive === true) return 'CAPWAP data keep-alive';
  return `CAPWAP data (${fields.tbit === true ? '802.11' : '802.3'} frame) radio ${String(fields.radioId ?? '?')}`;
}

/** CAPWAP codec. Required on encode: `messageType` for a control message. */
export const capwapCodec: Codec = {
  proto: 'capwap',
  defaults: Object.freeze({ radioId: 0, wbid: CAPWAP_WBID_IEEE80211, tbit: false, seq: 0, keepAlive: false }),
  decode,
  encode,
  summarize,
};
