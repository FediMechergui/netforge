/**
 * Syslog codec [S25] (RFC 3164 style; ARCHITECTURE-P3 D20, §2.3, §3.7; contracts/fields.ts `syslog`). UDP port 514.
 *
 * Wire image: one line of text, `<PRI>TIMESTAMP HOSTNAME: message`, e.g.
 * `<187>Jan  6 08:10:03.123 R1: %LINK-3-UPDOWN: Interface GigabitEthernet0/2 link state is now down`.
 *  • `pri` = facility × 8 + severity (0–191, required); `facility` and `severity` are derived from it (decode-only).
 *  • `timestamp` is the sender's text (it may hold spaces, e.g. 'Jan  6 08:10:03.123', or start with '*' when the
 *    clock is not authoritative); `hostname` is one word that does not start with '%'. Either may be empty; a
 *    timestamp needs a hostname after it (otherwise the two could not be told apart).
 *  • Decode splits at the first ': ' after the priority: the text before it is the timestamp and the hostname (its
 *    last word); a header whose last word starts with '%' is part of the message (a message sent without a hostname).
 *    Text that does not start with a valid priority decodes with an error, the whole text as `message`.
 */
import type { Codec, DecodedLayer, FieldValue } from '../../contracts/pdu.js';
import { numField, strField } from '../checksum.js';

/** Facility names, by number (RFC 3164 §4.1.1). */
export const SYSLOG_FACILITY_NAMES: readonly string[] = Object.freeze([
  'kern', 'user', 'mail', 'daemon', 'auth', 'syslog', 'lpr', 'news', 'uucp', 'cron', 'authpriv', 'ftp', 'ntp', 'audit',
  'alert', 'clock', 'local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7',
]);
/** Severity names, by number (the CLI level words). */
export const SYSLOG_SEVERITY_NAMES: readonly string[] = Object.freeze([
  'emergencies', 'alerts', 'critical', 'errors', 'warnings', 'notifications', 'informational', 'debugging',
]);
/** The largest priority (local7, debugging). */
export const SYSLOG_MAX_PRI = 191;

const PRI_RE = /^<(\d{1,3})>/;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });
const UTF8_ENCODER = new TextEncoder();

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  const out: DecodedLayer = { fields, fieldRanges, headerLength: avail, length: avail };
  const text = UTF8_DECODER.decode(bytes.subarray(offset, offset + avail));
  const m = PRI_RE.exec(text);
  const pri = m ? Number(m[1]) : NaN;
  if (!m || pri > SYSLOG_MAX_PRI) {
    fields.message = text;
    fieldRanges.message = [offset, avail];
    out.error = 'not a syslog message (no <priority>)';
    return out;
  }
  fields.pri = pri;
  fields.facility = pri >>> 3;
  fields.severity = pri & 7;
  const priLen = m[0].length; // ASCII, so characters are bytes
  fieldRanges.pri = [offset, priLen];
  fieldRanges.facility = [offset, priLen];
  fieldRanges.severity = [offset, priLen];
  const rest = text.slice(priLen);
  let timestamp = '';
  let hostname = '';
  let message = rest;
  const q = rest.indexOf(': ');
  if (q >= 0) {
    const head = rest.slice(0, q);
    const sp = head.lastIndexOf(' ');
    const last = sp < 0 ? head : head.slice(sp + 1);
    if (last !== '' && !last.startsWith('%')) {
      hostname = last;
      timestamp = sp < 0 ? '' : head.slice(0, sp);
      message = rest.slice(q + 2);
    } else if (sp >= 0 && !head.startsWith('%')) {
      timestamp = head.slice(0, sp);
      message = rest.slice(sp + 1);
    }
  }
  fields.timestamp = timestamp;
  fields.hostname = hostname;
  fields.message = message;
  const byteLen = (s: string): number => UTF8_ENCODER.encode(s).length;
  const msgStart = offset + avail - byteLen(message);
  fieldRanges.message = [msgStart, offset + avail - msgStart];
  if (timestamp !== '') fieldRanges.timestamp = [offset + priLen, byteLen(timestamp)];
  if (hostname !== '') fieldRanges.hostname = [offset + priLen + (timestamp === '' ? 0 : byteLen(timestamp) + 1), byteLen(hostname)];
  return out;
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'syslog';
  if (payload.length > 0) throw new Error('syslog: a syslog message carries no inner layer');
  const pri = numField(p, fields, 'pri', null);
  if (pri < 0 || pri > SYSLOG_MAX_PRI) throw new Error(`syslog.pri out of range: ${pri}`);
  const timestamp = strField(p, fields, 'timestamp', '');
  const hostname = strField(p, fields, 'hostname', '');
  const message = strField(p, fields, 'message', '');
  if (hostname !== '' && (/\s/.test(hostname) || hostname.startsWith('%') || hostname.includes(':'))) {
    throw new Error(`syslog.hostname must be one word without ':' that does not start with '%', got "${hostname}"`);
  }
  if (timestamp !== '' && hostname === '') throw new Error('syslog.timestamp needs a hostname after it');
  if (timestamp.includes(': ')) throw new Error(`syslog.timestamp must not hold ': ', got "${timestamp}"`);
  const head = hostname === '' ? '' : `${timestamp === '' ? '' : `${timestamp} `}${hostname}: `;
  return UTF8_ENCODER.encode(`<${pri}>${head}${message}`);
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const facility = typeof fields.facility === 'number' ? SYSLOG_FACILITY_NAMES[fields.facility] ?? String(fields.facility) : '?';
  const severity = typeof fields.severity === 'number' ? SYSLOG_SEVERITY_NAMES[fields.severity] ?? String(fields.severity) : '?';
  const from = typeof fields.hostname === 'string' && fields.hostname !== '' ? ` from ${fields.hostname}` : '';
  const message = typeof fields.message === 'string' ? fields.message : '';
  const shown = message.length > 60 ? `${message.slice(0, 60)}…` : message;
  return `Syslog ${facility}.${severity}${from}: ${shown}`;
}

/** Syslog codec [S25]. Required on encode: `pri`. */
export const syslogCodec: Codec = {
  proto: 'syslog',
  defaults: Object.freeze({ pri: null, timestamp: '', hostname: '', message: '' }),
  decode,
  encode,
  summarize,
};
