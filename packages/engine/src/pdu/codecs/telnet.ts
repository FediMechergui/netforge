/**
 * Telnet codec [S13] (RFC 854 / RFC 855; ARCHITECTURE-P3 D14, §2.3, §3.14; contracts/fields.ts `telnet`). TCP port 23.
 * Nothing is protected: a typed password travels in the clear, one character per segment.
 *
 * Wire image: the data stream with its IAC (0xff) commands. The layer covers every byte the transport hands down.
 *  • `data` — the text carried (UTF-8), with the commands removed and a doubled IAC (0xff 0xff) read as one 0xff byte.
 *  • `iac` — the commands, joined by ';', in wire order: 'WILL ECHO', 'DO SUPPRESS-GO-AHEAD', 'WONT 99', 'GA',
 *    'SB TERMINAL-TYPE 0158' (a subnegotiation: the option, then its data in hex). Option names are the RFC names;
 *    an unnamed option is its number.
 *  • Encode writes the commands first, then the data (a 0xff data byte, impossible in UTF-8 text, is never produced).
 *    A segment that interleaves commands and data decodes to the same fields, re-encoded in that canonical order.
 *  • An IAC cut at the end of the segment decodes with error 'partial' (the rest arrives in the next segment).
 */
import type { Codec, DecodedLayer, FieldValue } from '../../contracts/pdu.js';
import { strField } from '../checksum.js';

const IAC = 0xff;
const SE = 240;
const SB = 250;
/** Commands that take an option byte. */
const OPTION_COMMANDS: Readonly<Record<number, string>> = Object.freeze({ 251: 'WILL', 252: 'WONT', 253: 'DO', 254: 'DONT' });
/** Two-byte commands. */
const SIMPLE_COMMANDS: Readonly<Record<number, string>> = Object.freeze({
  241: 'NOP',
  242: 'DM',
  243: 'BRK',
  244: 'IP',
  245: 'AO',
  246: 'AYT',
  247: 'EC',
  248: 'EL',
  249: 'GA',
});
/** RFC option names. */
export const TELNET_OPTION: Readonly<Record<string, number>> = Object.freeze({
  BINARY: 0,
  ECHO: 1,
  'SUPPRESS-GO-AHEAD': 3,
  STATUS: 5,
  'TIMING-MARK': 6,
  'TERMINAL-TYPE': 24,
  NAWS: 31,
  'TERMINAL-SPEED': 32,
  'TOGGLE-FLOW-CONTROL': 33,
  LINEMODE: 34,
  'NEW-ENVIRON': 39,
});
const OPTION_NAME: ReadonlyMap<number, string> = new Map(Object.entries(TELNET_OPTION).map(([k, v]) => [v, k]));
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });
const UTF8_ENCODER = new TextEncoder();

function optionText(code: number): string {
  return OPTION_NAME.get(code) ?? String(code);
}

function optionCode(text: string, entry: string): number {
  const named = TELNET_OPTION[text.toUpperCase()];
  if (named !== undefined) return named;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`telnet.iac: unknown option "${text}" in "${entry}"`);
  return n;
}

function hex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fieldRanges: Record<string, readonly [number, number]> = {};
  const end = offset + avail;
  const data: number[] = [];
  const cmds: string[] = [];
  let partial = false;
  let i = offset;
  while (i < end) {
    const b = bytes[i]!;
    if (b !== IAC) {
      data.push(b);
      i++;
      continue;
    }
    if (i + 1 >= end) {
      partial = true;
      break;
    }
    const c = bytes[i + 1]!;
    if (c === IAC) {
      data.push(IAC);
      i += 2;
      continue;
    }
    const verb = OPTION_COMMANDS[c];
    if (verb !== undefined) {
      if (i + 2 >= end) {
        partial = true;
        break;
      }
      cmds.push(`${verb} ${optionText(bytes[i + 2]!)}`);
      i += 3;
      continue;
    }
    if (c === SB) {
      let j = i + 3;
      const sub: number[] = [];
      let closed = false;
      while (j < end) {
        if (bytes[j] === IAC && j + 1 < end && bytes[j + 1] === SE) {
          closed = true;
          break;
        }
        if (bytes[j] === IAC && j + 1 < end && bytes[j + 1] === IAC) {
          sub.push(IAC);
          j += 2;
          continue;
        }
        sub.push(bytes[j]!);
        j++;
      }
      if (i + 2 >= end || !closed) {
        partial = true;
        break;
      }
      cmds.push(`SB ${optionText(bytes[i + 2]!)}${sub.length > 0 ? ` ${hex(sub)}` : ''}`);
      i = j + 2;
      continue;
    }
    cmds.push(SIMPLE_COMMANDS[c] ?? String(c));
    i += 2;
  }
  const fields: Record<string, FieldValue> = { data: UTF8_DECODER.decode(Uint8Array.from(data)), iac: cmds.join(';') };
  fieldRanges.data = [offset, avail];
  const out: DecodedLayer = { fields, fieldRanges, headerLength: avail, length: avail };
  if (partial) out.error = 'partial';
  return out;
}

function encodeCommand(entry: string, out: number[]): void {
  const parts = entry.trim().split(/\s+/);
  const head = (parts[0] ?? '').toUpperCase();
  const optionVerb = Object.entries(OPTION_COMMANDS).find(([, v]) => v === head);
  if (optionVerb) {
    if (parts.length !== 2) throw new Error(`telnet.iac: "${entry}" needs exactly one option`);
    out.push(IAC, Number(optionVerb[0]), optionCode(parts[1]!, entry));
    return;
  }
  if (head === 'SB') {
    if (parts.length < 2 || parts.length > 3) throw new Error(`telnet.iac: "${entry}" must be 'SB <option> [<hex>]'`);
    out.push(IAC, SB, optionCode(parts[1]!, entry));
    const h = parts[2] ?? '';
    if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error(`telnet.iac: bad subnegotiation data in "${entry}"`);
    for (let k = 0; k < h.length; k += 2) {
      const v = parseInt(h.slice(k, k + 2), 16);
      out.push(v);
      if (v === IAC) out.push(IAC);
    }
    out.push(IAC, SE);
    return;
  }
  const simple = Object.entries(SIMPLE_COMMANDS).find(([, v]) => v === head);
  if (simple && parts.length === 1) {
    out.push(IAC, Number(simple[0]));
    return;
  }
  const n = Number(head);
  if (parts.length === 1 && Number.isInteger(n) && n >= 240 && n <= 249) {
    out.push(IAC, n);
    return;
  }
  throw new Error(`telnet.iac: unknown command "${entry}"`);
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'telnet';
  if (payload.length > 0) throw new Error('telnet: the telnet stream carries no inner layer');
  const out: number[] = [];
  const iac = strField(p, fields, 'iac', '');
  for (const entry of iac.split(';')) if (entry.trim() !== '') encodeCommand(entry, out);
  for (const b of UTF8_ENCODER.encode(strField(p, fields, 'data', ''))) out.push(b);
  return Uint8Array.from(out);
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const iac = typeof fields.iac === 'string' && fields.iac !== '' ? ` [${fields.iac.split(';').join(', ')}]` : '';
  const data = typeof fields.data === 'string' ? fields.data : '';
  const shown = data.length > 40 ? `${data.slice(0, 40)}…` : data;
  const text = data === '' ? '' : ` ${JSON.stringify(shown)}`;
  return `Telnet${iac}${text}`;
}

/** Telnet stream codec [S13]. Nothing is required. */
export const telnetCodec: Codec = {
  proto: 'telnet',
  defaults: Object.freeze({ data: '', iac: '' }),
  decode,
  encode,
  summarize,
};
