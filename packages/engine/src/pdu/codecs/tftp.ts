/**
 * TFTP codec [S29] (RFC 1350; option extension RFC 2347, transfer size option RFC 2349; ARCHITECTURE-P3C §2.3, §3.4;
 * contracts/fields.ts `tftp`). UDP port 69 (the request); the transfer then moves between two ephemeral ports, which
 * the udp codec dispatches by its source or destination port only when one of them is 69, so a mid-transfer DATA or
 * ACK between two ephemeral ports decodes as `payload` unless the receiver decodes it as `tftp` itself
 * (`decodeLayers(bytes, 'tftp')`).
 *
 * Wire images (big-endian; every string is NUL-terminated ASCII):
 *  • 1 RRQ / 2 WRQ: `opcode(2) filename 0 mode 0 [option 0 value 0]…`
 *  • 3 DATA: `opcode(2) block(2) data(0–512)` — a block shorter than 512 bytes (0 included) ends the transfer
 *  • 4 ACK: `opcode(2) block(2)` — block 0 answers a WRQ or an OACK
 *  • 5 ERROR: `opcode(2) errorCode(2) errorMsg 0`
 *  • 6 OACK: `opcode(2) [option 0 value 0]…`
 *
 * `tsize` (RFC 2349, the decimal size of the file: 0 in a request, the size in the OACK) is the only option modelled.
 * Decode reads it with a case-insensitive name and skips every other option (the bytes stay inside the layer); encode
 * writes it, after the mode, only when the field is present. Decode is tolerant: a malformed packet decodes what it
 * can and carries an error; encode refuses what RFC 1350 cannot carry (a NUL in a string, a DATA block over 512 bytes).
 */
import type { Codec, DecodedLayer, FieldValue } from '../../contracts/pdu.js';
import { numField, readU16, strField, writeU16 } from '../checksum.js';

/** TFTP opcodes (the `tftp.opcode` field). */
export const TFTP_OPCODE = Object.freeze({ rrq: 1, wrq: 2, data: 3, ack: 4, error: 5, oack: 6 });
/** TFTP error codes (RFC 1350 §5; 8 from RFC 2347). */
export const TFTP_ERROR = Object.freeze({
  undefined: 0,
  fileNotFound: 1,
  accessViolation: 2,
  diskFull: 3,
  illegalOperation: 4,
  unknownTransferId: 5,
  fileExists: 6,
  noSuchUser: 7,
  optionRefused: 8,
});
/** The largest DATA block (RFC 1350; the default block size, no `blksize` option is modelled). */
export const TFTP_MAX_DATA = 512;
/** The only transfer mode NetForge's daemons accept. */
export const TFTP_MODE_OCTET = 'octet';
/** The transfer size option name (RFC 2349). */
export const TFTP_OPTION_TSIZE = 'tsize';

const OPCODE_TEXT: Readonly<Record<number, string>> = Object.freeze({
  1: 'read request',
  2: 'write request',
  3: 'data',
  4: 'acknowledgement',
  5: 'error',
  6: 'option acknowledgement',
});
const TSIZE_RE = /^\d{1,10}$/;
const U32_MAX = 0xffffffff;

/** The NUL-terminated string at `at` (bytes as Latin-1 characters), its end (the NUL's index), or undefined. */
function readZ(bytes: Uint8Array, at: number, end: number): { text: string; nul: number } | undefined {
  let text = '';
  for (let i = at; i < end; i++) {
    const b = bytes[i]!;
    if (b === 0) return { text, nul: i };
    text += String.fromCharCode(b);
  }
  return undefined;
}

/**
 * Options from `at` to `end` into `fields` (only `tsize`); returns an error text or undefined. The option bytes are
 * covered by the layer whatever they hold.
 */
function readOptions(
  bytes: Uint8Array,
  at: number,
  end: number,
  fields: Record<string, FieldValue>,
  fieldRanges: Record<string, readonly [number, number]>,
): string | undefined {
  let i = at;
  while (i < end) {
    const name = readZ(bytes, i, end);
    if (!name) return 'TFTP option name not terminated';
    const value = readZ(bytes, name.nul + 1, end);
    if (!value) return 'TFTP option value not terminated';
    if (name.text.toLowerCase() === TFTP_OPTION_TSIZE && fields.tsize === undefined) {
      if (!TSIZE_RE.test(value.text) || Number(value.text) > U32_MAX) return `TFTP tsize value is not a size: "${value.text}"`;
      fields.tsize = Number(value.text);
      fieldRanges.tsize = [i, value.nul + 1 - i];
    }
    i = value.nul + 1;
  }
  return undefined;
}

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const end = offset + avail;
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  const out: DecodedLayer = { fields, fieldRanges, headerLength: avail, length: avail };
  if (avail < 2) {
    out.error = 'TFTP packet truncated';
    return out;
  }
  const opcode = readU16(bytes, offset);
  fields.opcode = opcode;
  fieldRanges.opcode = [offset, 2];
  const o = offset + 2;
  switch (opcode) {
    case TFTP_OPCODE.rrq:
    case TFTP_OPCODE.wrq: {
      const file = readZ(bytes, o, end);
      if (!file) {
        out.error = 'TFTP file name not terminated';
        return out;
      }
      fields.filename = file.text;
      fieldRanges.filename = [o, file.nul - o];
      const mode = readZ(bytes, file.nul + 1, end);
      if (!mode) {
        out.error = 'TFTP mode not terminated';
        return out;
      }
      fields.mode = mode.text;
      fieldRanges.mode = [file.nul + 1, mode.nul - file.nul - 1];
      const err = readOptions(bytes, mode.nul + 1, end, fields, fieldRanges);
      if (err !== undefined) out.error = err;
      return out;
    }
    case TFTP_OPCODE.data:
    case TFTP_OPCODE.ack: {
      if (avail < 4) {
        out.error = 'TFTP packet truncated';
        return out;
      }
      fields.block = readU16(bytes, o);
      fieldRanges.block = [o, 2];
      if (opcode === TFTP_OPCODE.ack) {
        if (avail > 4) out.error = 'TFTP acknowledgement longer than 4 bytes';
        return out;
      }
      fields.data = bytes.slice(o + 2, end);
      fieldRanges.data = [o + 2, end - o - 2];
      if (end - o - 2 > TFTP_MAX_DATA) out.error = `TFTP data block longer than ${TFTP_MAX_DATA} bytes`;
      return out;
    }
    case TFTP_OPCODE.error: {
      if (avail < 4) {
        out.error = 'TFTP packet truncated';
        return out;
      }
      fields.errorCode = readU16(bytes, o);
      fieldRanges.errorCode = [o, 2];
      const msg = readZ(bytes, o + 2, end);
      if (!msg) {
        // keep what arrived: a sender that forgot the NUL still said something
        let text = '';
        for (let i = o + 2; i < end; i++) text += String.fromCharCode(bytes[i]!);
        fields.errorMsg = text;
        fieldRanges.errorMsg = [o + 2, end - o - 2];
        out.error = 'TFTP error message not terminated';
        return out;
      }
      fields.errorMsg = msg.text;
      fieldRanges.errorMsg = [o + 2, msg.nul - o - 2];
      return out;
    }
    case TFTP_OPCODE.oack: {
      const err = readOptions(bytes, o, end, fields, fieldRanges);
      if (err !== undefined) out.error = err;
      return out;
    }
    default:
      out.error = `TFTP opcode ${opcode} is not defined`;
      return out;
  }
}

/** `text` as NUL-free ASCII bytes followed by a NUL. */
function zBytes(field: string, text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0 || c > 0x7f) throw new Error(`tftp.${field} must be ASCII without NUL, got "${text}"`);
    out.push(c);
  }
  out.push(0);
  return out;
}

function tsizeBytes(fields: Readonly<Record<string, FieldValue>>): number[] {
  const v = fields.tsize;
  if (v === undefined || v === null) return [];
  const n = numField('tftp', fields, 'tsize', null);
  if (n < 0 || n > U32_MAX) throw new Error(`tftp.tsize out of range: ${n}`);
  return [...zBytes('tsize', TFTP_OPTION_TSIZE), ...zBytes('tsize', String(n))];
}

function u16(fields: Readonly<Record<string, FieldValue>>, key: string, dflt: number | null): number {
  const v = numField('tftp', fields, key, dflt);
  if (v < 0 || v > 0xffff) throw new Error(`tftp.${key} out of range: ${v}`);
  return v;
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'tftp';
  if (payload.length > 0) throw new Error('tftp: a TFTP packet carries no inner layer');
  const opcode = u16(fields, 'opcode', null);
  const head = [opcode >>> 8, opcode & 0xff];
  switch (opcode) {
    case TFTP_OPCODE.rrq:
    case TFTP_OPCODE.wrq: {
      const filename = strField(p, fields, 'filename', null);
      if (filename === '') throw new Error('tftp.filename must not be empty');
      const mode = strField(p, fields, 'mode', TFTP_MODE_OCTET);
      return Uint8Array.from([...head, ...zBytes('filename', filename), ...zBytes('mode', mode), ...tsizeBytes(fields)]);
    }
    case TFTP_OPCODE.data: {
      const v = fields.data;
      const data = v === undefined || v === null ? new Uint8Array(0) : v;
      if (!(data instanceof Uint8Array)) throw new Error('tftp.data must be a Uint8Array');
      if (data.length > TFTP_MAX_DATA) throw new Error(`tftp.data holds at most ${TFTP_MAX_DATA} bytes, got ${data.length}`);
      const out = new Uint8Array(4 + data.length);
      writeU16(out, 0, opcode);
      writeU16(out, 2, u16(fields, 'block', null));
      out.set(data, 4);
      return out;
    }
    case TFTP_OPCODE.ack: {
      const out = new Uint8Array(4);
      writeU16(out, 0, opcode);
      writeU16(out, 2, u16(fields, 'block', null));
      return out;
    }
    case TFTP_OPCODE.error: {
      const code = u16(fields, 'errorCode', null);
      return Uint8Array.from([...head, code >>> 8, code & 0xff, ...zBytes('errorMsg', strField(p, fields, 'errorMsg', ''))]);
    }
    case TFTP_OPCODE.oack:
      return Uint8Array.from([...head, ...tsizeBytes(fields)]);
    default:
      throw new Error(`tftp.opcode ${opcode} is not defined (1 RRQ, 2 WRQ, 3 DATA, 4 ACK, 5 ERROR, 6 OACK)`);
  }
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const opcode = typeof fields.opcode === 'number' ? fields.opcode : -1;
  const tsize = typeof fields.tsize === 'number' ? `, tsize ${fields.tsize}` : '';
  switch (opcode) {
    case TFTP_OPCODE.rrq:
    case TFTP_OPCODE.wrq:
      return `TFTP ${OPCODE_TEXT[opcode]!} "${String(fields.filename ?? '?')}", mode ${String(fields.mode ?? '?')}${tsize}`;
    case TFTP_OPCODE.data: {
      const n = fields.data instanceof Uint8Array ? fields.data.length : 0;
      return `TFTP data, block ${String(fields.block ?? '?')}, ${n} bytes${n < TFTP_MAX_DATA ? ' (last)' : ''}`;
    }
    case TFTP_OPCODE.ack:
      return `TFTP acknowledgement, block ${String(fields.block ?? '?')}`;
    case TFTP_OPCODE.error:
      return `TFTP error ${String(fields.errorCode ?? '?')}: ${String(fields.errorMsg ?? '')}`;
    case TFTP_OPCODE.oack:
      return `TFTP option acknowledgement${tsize}`;
    default:
      return opcode < 0 ? 'TFTP (truncated)' : `TFTP opcode ${opcode}`;
  }
}

/** TFTP codec [S29]. Required on encode: `opcode`, then `filename` (RRQ, WRQ), `block` (DATA, ACK) or `errorCode` (ERROR). */
export const tftpCodec: Codec = {
  proto: 'tftp',
  defaults: Object.freeze({ opcode: null, mode: TFTP_MODE_OCTET }),
  decode,
  encode,
  summarize,
};
