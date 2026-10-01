/**
 * PPP IPv6 Control Protocol codec [S19] (RFC 5072; ARCHITECTURE-P3 D17, §2.3; contracts/fields.ts `ipv6cp`). PPP
 * protocol 0x8057.
 *
 * Wire image: the shared control-packet layout (ppp.ts) with codes 1–7. Configure packets (1–4) carry option 1,
 * Interface-Identifier (`interfaceId`, 8 bytes written as 16 hex digits); other options are skipped on decode.
 */
import type { Codec, DecodedLayer, FieldValue } from '../../contracts/pdu.js';
import { numField, strField } from '../checksum.js';
import { PPP_CP_CODE, pppCpCodeText, pppCpDecodeHeader, pppCpEncode, pppCpOptions } from './ppp.js';

/** IPv6CP option 1: Interface-Identifier. */
export const IPV6CP_OPTION_INTERFACE_ID = 1;

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const h = pppCpDecodeHeader(bytes, offset, length, 'IPv6CP', false);
  const { fields, fieldRanges } = h;
  let error = h.error;
  const code = typeof fields.code === 'number' ? fields.code : -1;
  if (h.header && code >= PPP_CP_CODE.configureRequest && code <= PPP_CP_CODE.configureReject) {
    const { options, error: optError } = pppCpOptions(bytes, h.dataStart, h.end, 'IPv6CP');
    if (optError !== undefined && error === undefined) error = optError;
    for (const o of options) {
      if (o.type === IPV6CP_OPTION_INTERFACE_ID && o.length === 10) {
        let text = '';
        for (let k = 0; k < 8; k++) text += bytes[o.value + k]!.toString(16).padStart(2, '0');
        fields.interfaceId = text;
        fieldRanges.interfaceId = [o.offset, o.length];
      }
    }
  }
  const out: DecodedLayer = { fields, fieldRanges, headerLength: h.covered, length: h.covered };
  if (error !== undefined) out.error = error;
  else if (h.header && (code < 1 || code > PPP_CP_CODE.codeReject)) out.error = `unknown IPv6CP code ${code}`;
  return out;
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'ipv6cp';
  if (payload.length > 0) throw new Error('ipv6cp: an IPv6CP packet carries no inner layer');
  const code = numField(p, fields, 'code', null);
  const data: number[] = [];
  if (code >= PPP_CP_CODE.configureRequest && code <= PPP_CP_CODE.configureReject && fields.interfaceId !== undefined && fields.interfaceId !== null) {
    const id = strField(p, fields, 'interfaceId', null).replace(/:/g, '');
    if (!/^[0-9a-fA-F]{16}$/.test(id)) throw new Error(`ipv6cp.interfaceId must be 16 hex digits, got "${String(fields.interfaceId)}"`);
    data.push(IPV6CP_OPTION_INTERFACE_ID, 10);
    for (let k = 0; k < 16; k += 2) data.push(parseInt(id.slice(k, k + 2), 16));
  }
  return pppCpEncode(p, fields, data, PPP_CP_CODE.codeReject);
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const code = typeof fields.code === 'number' ? pppCpCodeText(fields.code) : '?';
  const id = typeof fields.interfaceId === 'string' ? `, interface id ${fields.interfaceId}` : '';
  return `IPv6CP ${code} id ${String(fields.id ?? '?')}${id}`;
}

/** PPP IPv6CP codec [S19]. Required on encode: `code`, `id`. */
export const ipv6cpCodec: Codec = {
  proto: 'ipv6cp',
  defaults: Object.freeze({ code: null, id: null }),
  decode,
  encode,
  summarize,
};
