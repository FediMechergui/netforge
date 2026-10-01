/**
 * PPP Link Control Protocol codec [S19] (RFC 1661 §5–§6, CHAP algorithm RFC 1994 §3; ARCHITECTURE-P3 D17, §2.3,
 * §3.9; contracts/fields.ts `lcp`). PPP protocol 0xc021.
 *
 * Wire image: `code(1) id(1) length(2) data` (the shared control-packet layout, ppp.ts), `length` derived.
 *  • Configure packets (codes 1–4) carry options, written in type order: 1 MRU (`mru`, 2 bytes), 3
 *    authentication protocol (`authProto`: 'pap' = 0xc023; 'chap-md5' = 0xc223 with algorithm 5), 5 magic number
 *    (`magic`, 4 bytes). Unknown options are skipped on decode. A configure-reject also lists the option names it
 *    carries in `rejected` ('mru', 'auth-proto', 'magic', or 'option <n>', joined by ','); on encode `rejected`
 *    selects which of the option fields a configure-reject carries.
 *  • Terminate-request / terminate-ack (5, 6): the data is the `reason` text (UTF-8).
 *  • Protocol-reject (8): the rejected protocol, as `rejected` = its hex value ('0x8057'); any rejected information
 *    after it is not decoded.
 *  • Echo-request / echo-reply / discard-request (9–11): `echoMagic`, the sender's magic number.
 *  • Code-reject (7) carries a copy of the rejected packet, which is not decoded.
 */
import type { Codec, DecodedLayer, FieldValue, MutationReason } from '../../contracts/pdu.js';
import { numField, readU16, readU32, strField, writeU16, writeU32 } from '../checksum.js';
import { PPP_CP_CODE, pppCpCodeText, pppCpDecodeHeader, pppCpEncode, pppCpOptions } from './ppp.js';

/** LCP option types used. */
export const LCP_OPTION = Object.freeze({ mru: 1, authProto: 3, magic: 5 });
/** Authentication protocol values of the LCP option. */
export const LCP_AUTH = Object.freeze({ pap: 0xc023, chap: 0xc223, chapMd5Algorithm: 5 });

const OPTION_NAME: Readonly<Record<number, string>> = Object.freeze({ 1: 'mru', 3: 'auth-proto', 5: 'magic' });
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });
const UTF8_ENCODER = new TextEncoder();

function isConfigure(code: number): boolean {
  return code >= PPP_CP_CODE.configureRequest && code <= PPP_CP_CODE.configureReject;
}

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const h = pppCpDecodeHeader(bytes, offset, length, 'LCP', true);
  const { fields, fieldRanges } = h;
  let error = h.error;
  const code = typeof fields.code === 'number' ? fields.code : -1;
  const s = h.dataStart;
  const e = h.end;
  if (h.header && isConfigure(code)) {
    const { options, error: optError } = pppCpOptions(bytes, s, e, 'LCP');
    if (optError !== undefined && error === undefined) error = optError;
    const names: string[] = [];
    for (const o of options) {
      const range: readonly [number, number] = [o.offset, o.length];
      names.push(OPTION_NAME[o.type] ?? `option ${o.type}`);
      if (o.type === LCP_OPTION.mru && o.length === 4) {
        fields.mru = readU16(bytes, o.value);
        fieldRanges.mru = range;
      } else if (o.type === LCP_OPTION.authProto && o.length >= 4) {
        const proto = readU16(bytes, o.value);
        if (proto === LCP_AUTH.pap && o.length === 4) fields.authProto = 'pap';
        else if (proto === LCP_AUTH.chap && o.length === 5 && bytes[o.value + 2] === LCP_AUTH.chapMd5Algorithm) fields.authProto = 'chap-md5';
        else fields.authProto = `0x${proto.toString(16).padStart(4, '0')}`;
        fieldRanges.authProto = range;
      } else if (o.type === LCP_OPTION.magic && o.length === 6) {
        fields.magic = readU32(bytes, o.value);
        fieldRanges.magic = range;
      }
    }
    if (code === PPP_CP_CODE.configureReject) {
      fields.rejected = names.join(',');
      fieldRanges.rejected = [s, e - s];
    }
  } else if (h.header && (code === PPP_CP_CODE.terminateRequest || code === PPP_CP_CODE.terminateAck)) {
    if (e > s) {
      fields.reason = UTF8_DECODER.decode(bytes.subarray(s, e));
      fieldRanges.reason = [s, e - s];
    }
  } else if (h.header && code === PPP_CP_CODE.protocolReject) {
    if (e - s >= 2) {
      fields.rejected = `0x${readU16(bytes, s).toString(16).padStart(4, '0')}`;
      fieldRanges.rejected = [s, 2];
    }
  } else if (h.header && code >= PPP_CP_CODE.echoRequest && code <= PPP_CP_CODE.discardRequest) {
    if (e - s >= 4) {
      fields.echoMagic = readU32(bytes, s);
      fieldRanges.echoMagic = [s, 4];
    }
  }
  const out: DecodedLayer = { fields, fieldRanges, headerLength: h.covered, length: h.covered };
  if (error !== undefined) out.error = error;
  else if (h.header && (code < 1 || code > PPP_CP_CODE.discardRequest)) out.error = `unknown LCP code ${code}`;
  return out;
}

function has(fields: Readonly<Record<string, FieldValue>>, key: string): boolean {
  return fields[key] !== undefined && fields[key] !== null;
}

function configureOptions(fields: Readonly<Record<string, FieldValue>>, code: number): number[] {
  const p = 'lcp';
  let wanted: ReadonlySet<string> | undefined;
  if (code === PPP_CP_CODE.configureReject && has(fields, 'rejected')) {
    wanted = new Set(strField(p, fields, 'rejected', '').split(',').map((x) => x.trim()).filter((x) => x !== ''));
    for (const name of wanted) {
      if (name !== 'mru' && name !== 'auth-proto' && name !== 'magic') throw new Error(`lcp.rejected: option "${name}" cannot be encoded`);
    }
  }
  const want = (name: string, key: string): boolean => {
    if (wanted === undefined) return has(fields, key);
    if (!wanted.has(name)) return false;
    if (!has(fields, key)) throw new Error(`lcp.rejected names ${name} but lcp.${key} is not set`);
    return true;
  };
  const out: number[] = [];
  if (want('mru', 'mru')) {
    const mru = numField(p, fields, 'mru', null);
    if (mru < 0 || mru > 0xffff) throw new Error(`lcp.mru out of range: ${mru}`);
    out.push(LCP_OPTION.mru, 4, (mru >>> 8) & 0xff, mru & 0xff);
  }
  if (want('auth-proto', 'authProto')) {
    const a = strField(p, fields, 'authProto', null);
    if (a === 'pap') out.push(LCP_OPTION.authProto, 4, 0xc0, 0x23);
    else if (a === 'chap-md5') out.push(LCP_OPTION.authProto, 5, 0xc2, 0x23, LCP_AUTH.chapMd5Algorithm);
    else throw new Error(`lcp.authProto must be 'pap' or 'chap-md5', got "${a}"`);
  }
  if (want('magic', 'magic')) {
    const b = new Uint8Array(4);
    writeU32(b, 0, numField(p, fields, 'magic', null) >>> 0);
    out.push(LCP_OPTION.magic, 6, ...b);
  }
  return out;
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'lcp';
  if (payload.length > 0) throw new Error('lcp: an LCP packet carries no inner layer');
  const code = numField(p, fields, 'code', null);
  let data: ArrayLike<number> = [];
  if (isConfigure(code)) data = configureOptions(fields, code);
  else if (code === PPP_CP_CODE.terminateRequest || code === PPP_CP_CODE.terminateAck) data = UTF8_ENCODER.encode(strField(p, fields, 'reason', ''));
  else if (code === PPP_CP_CODE.protocolReject) {
    const text = strField(p, fields, 'rejected', null);
    const v = Number(text);
    if (!/^0x[0-9a-fA-F]{1,4}$/.test(text) || !Number.isInteger(v)) throw new Error(`lcp.rejected must be a protocol like '0x8057', got "${text}"`);
    const b = new Uint8Array(2);
    writeU16(b, 0, v);
    data = b;
  } else if (code >= PPP_CP_CODE.echoRequest && code <= PPP_CP_CODE.discardRequest) {
    const b = new Uint8Array(4);
    writeU32(b, 0, numField(p, fields, 'echoMagic', 0) >>> 0);
    data = b;
  }
  return pppCpEncode(p, fields, data, PPP_CP_CODE.discardRequest);
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const code = typeof fields.code === 'number' ? pppCpCodeText(fields.code) : '?';
  const parts: string[] = [];
  if (typeof fields.authProto === 'string') parts.push(`auth ${fields.authProto}`);
  if (typeof fields.mru === 'number') parts.push(`mru ${fields.mru}`);
  if (typeof fields.magic === 'number') parts.push(`magic 0x${fields.magic.toString(16).padStart(8, '0')}`);
  if (typeof fields.rejected === 'string' && fields.rejected !== '') parts.push(`rejects ${fields.rejected}`);
  if (typeof fields.reason === 'string' && fields.reason !== '') parts.push(`"${fields.reason}"`);
  return `LCP ${code} id ${String(fields.id ?? '?')}${parts.length > 0 ? `, ${parts.join(', ')}` : ''}`;
}

const DERIVED: Readonly<Record<string, MutationReason>> = Object.freeze({ length: 'Other' });

/** PPP LCP codec [S19]. Required on encode: `code`, `id`. */
export const lcpCodec: Codec = {
  proto: 'lcp',
  defaults: Object.freeze({ code: null, id: null }),
  decode,
  encode,
  summarize,
  derived: DERIVED,
};
