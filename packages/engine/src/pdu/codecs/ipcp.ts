/**
 * PPP IP Control Protocol codec [S19] (RFC 1332; ARCHITECTURE-P3 D17, §2.3, §3.9; contracts/fields.ts `ipcp`). PPP
 * protocol 0x8021.
 *
 * Wire image: the shared control-packet layout (ppp.ts) with codes 1–7. Configure packets (1–4) carry option 3,
 * IP-Address (`ipAddress`, 4 bytes); other options are skipped on decode. The other codes carry no decoded data.
 */
import type { Codec, DecodedLayer, FieldValue } from '../../contracts/pdu.js';
import { bytesToIpv4, ipv4ToBytes, isIpv4 } from '../../contracts/addr.js';
import { numField, strField } from '../checksum.js';
import { PPP_CP_CODE, pppCpCodeText, pppCpDecodeHeader, pppCpEncode, pppCpOptions } from './ppp.js';

/** IPCP option 3: IP-Address. */
export const IPCP_OPTION_ADDRESS = 3;

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const h = pppCpDecodeHeader(bytes, offset, length, 'IPCP', false);
  const { fields, fieldRanges } = h;
  let error = h.error;
  const code = typeof fields.code === 'number' ? fields.code : -1;
  if (h.header && code >= PPP_CP_CODE.configureRequest && code <= PPP_CP_CODE.configureReject) {
    const { options, error: optError } = pppCpOptions(bytes, h.dataStart, h.end, 'IPCP');
    if (optError !== undefined && error === undefined) error = optError;
    for (const o of options) {
      if (o.type === IPCP_OPTION_ADDRESS && o.length === 6) {
        fields.ipAddress = bytesToIpv4(bytes, o.value);
        fieldRanges.ipAddress = [o.offset, o.length];
      }
    }
  }
  const out: DecodedLayer = { fields, fieldRanges, headerLength: h.covered, length: h.covered };
  if (error !== undefined) out.error = error;
  else if (h.header && (code < 1 || code > PPP_CP_CODE.codeReject)) out.error = `unknown IPCP code ${code}`;
  return out;
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'ipcp';
  if (payload.length > 0) throw new Error('ipcp: an IPCP packet carries no inner layer');
  const code = numField(p, fields, 'code', null);
  const data: number[] = [];
  if (code >= PPP_CP_CODE.configureRequest && code <= PPP_CP_CODE.configureReject && fields.ipAddress !== undefined && fields.ipAddress !== null) {
    const a = strField(p, fields, 'ipAddress', null);
    if (!isIpv4(a)) throw new Error(`ipcp.ipAddress is not an IPv4 address: "${a}"`);
    data.push(IPCP_OPTION_ADDRESS, 6, ...ipv4ToBytes(a));
  }
  return pppCpEncode(p, fields, data, PPP_CP_CODE.codeReject);
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const code = typeof fields.code === 'number' ? pppCpCodeText(fields.code) : '?';
  const address = typeof fields.ipAddress === 'string' ? `, address ${fields.ipAddress}` : '';
  return `IPCP ${code} id ${String(fields.id ?? '?')}${address}`;
}

/** PPP IPCP codec [S19]. Required on encode: `code`, `id`. */
export const ipcpCodec: Codec = {
  proto: 'ipcp',
  defaults: Object.freeze({ code: null, id: null }),
  decode,
  encode,
  summarize,
};
