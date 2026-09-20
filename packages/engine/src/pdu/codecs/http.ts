/**
 * HTTP/1.1 message codec (message syntax RFC 9112, semantics RFC 9110) — ARCHITECTURE-P1 §4.5, §4.12,
 * contracts/fields.ts `http`.
 *
 * Real HTTP/1.1 text: `start-line CRLF *(field-line CRLF) CRLF [body]`.
 *  • Fields: kind ('request' | 'response', required), method + target (requests), version (default HTTP/1.1),
 *    status + reason (responses), headers ('Name: value' lines joined by '\n'), body (UTF-8 text).
 *  • Body length (RFC 9112 §6.3): no body for 1xx/204/304 responses; `Transfer-Encoding: chunked` is de-chunked;
 *    else `Content-Length`; else a request has no body and a response runs to the end of the bytes
 *    (close-delimited).
 *  • A message split across TCP segments decodes with error 'partial' (the tcp codec dispatches every segment
 *    with data on port 80/8080 here): a segment that ends inside the header block or before the declared body
 *    end decodes what is present; a segment that does not begin with a start line (a continuation) decodes its
 *    text into `body` with no `kind`. Reassembly belongs to the socket owner and NetScope follow-stream, which
 *    use the pure parsers `parseHttpMessage` / `parseHttpStream` exported here.
 *  • Encode renders the fields verbatim (headers are the builder's: nothing is added, so a server sets its own
 *    Content-Length); a request defaults to `GET /`, a response needs `status` and defaults its reason phrase.
 *  • The layer covers everything the transport hands down; it never chains further.
 */
import type { Codec, DecodedLayer, FieldValue } from '../../contracts/pdu.js';
import { numField, strField } from '../checksum.js';

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });
const UTF8_ENCODER = new TextEncoder();

/** Default HTTP version. */
export const HTTP_VERSION = 'HTTP/1.1';

const REASONS: Readonly<Record<number, string>> = Object.freeze({
  100: 'Continue',
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  411: 'Length Required',
  413: 'Content Too Large',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  503: 'Service Unavailable',
  505: 'HTTP Version Not Supported',
});

/** Standard reason phrase for a status code (RFC 9110 §15), or '' when none is listed. */
export function httpReasonPhrase(status: number): string {
  return REASONS[status] ?? '';
}

/** One parsed HTTP message (pure parser result). */
export interface HttpMessage {
  kind: 'request' | 'response';
  method?: string;
  target?: string;
  version: string;
  status?: number;
  reason?: string;
  /** The start line without CRLF. */
  startLine: string;
  /** 'Name: value' lines joined by '\n'. */
  headers: string;
  /** Body text (de-chunked), UTF-8 decoded; only the part present when incomplete. */
  body: string;
  /** False when the header block or the declared body is not all present. */
  complete: boolean;
  /** Bytes of the input this message occupies (all remaining bytes when incomplete or close-delimited). */
  consumed: number;
  /** Byte offsets relative to the parse start: start line, header block (after the start line) and body. */
  ranges: { startLine: [number, number]; headers: [number, number]; body: [number, number] };
}

const REQUEST_LINE = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+) (\S+) (HTTP\/\d\.\d)$/;
const STATUS_LINE = /^(HTTP\/\d\.\d) (\d{3})(?: (.*))?$/;
const METHOD_PREFIX = /^[A-Z]{1,16}( \S*( H(T(T(P(\/(\d(\.\d?)?)?)?)?)?)?)?)?$/;
const STATUS_PREFIX = /^H(T(T(P(\/(\d(\.(\d( (\d{0,3}.*)?)?)?)?)?)?)?)?)?$/;

function latin1(b: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i < to; i++) s += String.fromCharCode(b[i]!);
  return s;
}

function indexOfSeq(b: Uint8Array, from: number, to: number, seq: readonly number[]): number {
  outer: for (let i = from; i + seq.length <= to; i++) {
    for (let k = 0; k < seq.length; k++) if (b[i + k] !== seq[k]) continue outer;
    return i;
  }
  return -1;
}

const CRLF = [13, 10];
const CRLFCRLF = [13, 10, 13, 10];

/** Value of the first header named `name` (case-insensitive) in '\n'-joined header lines, or undefined. */
export function httpHeader(headers: string, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const line of headers.split('\n')) {
    const c = line.indexOf(':');
    if (c <= 0) continue;
    if (line.slice(0, c).trim().toLowerCase() === want) return line.slice(c + 1).trim();
  }
  return undefined;
}

/** De-chunk `[from, to)`; returns the body bytes, whether the last chunk was seen, and the end offset. */
function dechunk(b: Uint8Array, from: number, to: number): { data: Uint8Array; complete: boolean; end: number } {
  const parts: Uint8Array[] = [];
  let p = from;
  for (;;) {
    const eol = indexOfSeq(b, p, to, CRLF);
    if (eol < 0) break;
    const size = parseInt(latin1(b, p, eol).split(';')[0]!.trim(), 16);
    if (!Number.isFinite(size) || size < 0) break;
    const dataStart = eol + 2;
    if (size === 0) {
      const trailerEnd = indexOfSeq(b, dataStart, to, CRLF);
      if (trailerEnd === dataStart) return { data: concat(parts), complete: true, end: dataStart + 2 };
      const blockEnd = indexOfSeq(b, dataStart, to, CRLFCRLF);
      if (blockEnd >= 0) return { data: concat(parts), complete: true, end: blockEnd + 4 };
      break;
    }
    const have = Math.min(size, to - dataStart);
    parts.push(b.subarray(dataStart, dataStart + have));
    if (have < size || dataStart + size + 2 > to) break;
    p = dataStart + size + 2;
  }
  return { data: concat(parts), complete: false, end: to };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const x of parts) n += x.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const x of parts) {
    out.set(x, o);
    o += x.length;
  }
  return out;
}

/**
 * Parse one HTTP/1.1 message starting at `offset` (bytes up to `end`). Returns null when the bytes do not begin
 * with a request or status line (nor a prefix of one, for a segment cut inside the start line). Pure; used by
 * the codec, the http daemons and NetScope follow-stream.
 */
export function parseHttpMessage(bytes: Uint8Array, offset = 0, end = bytes.length): HttpMessage | null {
  const stop = Math.min(end, bytes.length);
  if (offset >= stop) return null;
  const lineEnd = indexOfSeq(bytes, offset, stop, CRLF);
  const firstLine = latin1(bytes, offset, lineEnd < 0 ? stop : lineEnd);
  const req = REQUEST_LINE.exec(firstLine);
  const res = req ? null : STATUS_LINE.exec(firstLine);
  let kind: 'request' | 'response';
  if (req) kind = 'request';
  else if (res) kind = 'response';
  else if (lineEnd >= 0) return null;
  else if (STATUS_PREFIX.test(firstLine)) kind = 'response';
  else if (METHOD_PREFIX.test(firstLine)) kind = 'request';
  else return null;

  const msg: HttpMessage = {
    kind,
    version: HTTP_VERSION,
    startLine: firstLine,
    headers: '',
    body: '',
    complete: false,
    consumed: stop - offset,
    ranges: { startLine: [0, firstLine.length], headers: [firstLine.length, 0], body: [stop - offset, 0] },
  };
  if (req) {
    msg.method = req[1]!;
    msg.target = req[2]!;
    msg.version = req[3]!;
  } else if (res) {
    msg.version = res[1]!;
    msg.status = Number(res[2]);
    msg.reason = res[3] ?? '';
  }
  if (lineEnd < 0) return msg;

  const hdrStart = lineEnd + 2;
  const blockEnd = indexOfSeq(bytes, lineEnd, stop, CRLFCRLF);
  if (blockEnd < 0) {
    const lastEol = (() => {
      let last = -1;
      for (let p = indexOfSeq(bytes, hdrStart, stop, CRLF); p >= 0; p = indexOfSeq(bytes, p + 2, stop, CRLF)) last = p;
      return last;
    })();
    if (lastEol > hdrStart) {
      msg.headers = latin1(bytes, hdrStart, lastEol).split('\r\n').join('\n');
      msg.ranges.headers = [hdrStart - offset, lastEol - hdrStart];
    }
    return msg;
  }
  const headerText = blockEnd > hdrStart ? latin1(bytes, hdrStart, blockEnd) : '';
  msg.headers = headerText === '' ? '' : headerText.split('\r\n').join('\n');
  msg.ranges.headers = [hdrStart - offset, Math.max(0, blockEnd - hdrStart)];
  const bodyStart = blockEnd + 4;
  msg.ranges.body = [bodyStart - offset, 0];

  const status = msg.status ?? 0;
  const noBody = kind === 'response' && ((status >= 100 && status < 200) || status === 204 || status === 304);
  const te = httpHeader(msg.headers, 'transfer-encoding');
  const cl = httpHeader(msg.headers, 'content-length');
  if (noBody) {
    msg.complete = true;
    msg.consumed = bodyStart - offset;
  } else if (te !== undefined && te.toLowerCase().split(',').map((x) => x.trim()).includes('chunked')) {
    const d = dechunk(bytes, bodyStart, stop);
    msg.body = UTF8_DECODER.decode(d.data);
    msg.complete = d.complete;
    msg.consumed = d.end - offset;
    msg.ranges.body = [bodyStart - offset, d.end - bodyStart];
  } else if (cl !== undefined && /^\d+$/.test(cl)) {
    const want = Number(cl);
    const have = Math.min(want, stop - bodyStart);
    msg.body = UTF8_DECODER.decode(bytes.subarray(bodyStart, bodyStart + have));
    msg.complete = have === want;
    msg.consumed = bodyStart + have - offset;
    msg.ranges.body = [bodyStart - offset, have];
  } else if (kind === 'request') {
    msg.complete = true;
    msg.consumed = bodyStart - offset;
  } else {
    msg.body = UTF8_DECODER.decode(bytes.subarray(bodyStart, stop));
    msg.complete = true;
    msg.consumed = stop - offset;
    msg.ranges.body = [bodyStart - offset, stop - bodyStart];
  }
  return msg;
}

/**
 * Parse consecutive HTTP messages from a reassembled byte stream (pipelined or keep-alive), stopping at the
 * first incomplete message (included, with `complete: false`) or at bytes that are not HTTP.
 */
export function parseHttpStream(bytes: Uint8Array): HttpMessage[] {
  const out: HttpMessage[] = [];
  let p = 0;
  while (p < bytes.length) {
    const m = parseHttpMessage(bytes, p);
    if (!m) break;
    out.push(m);
    if (!m.complete || m.consumed <= 0) break;
    p += m.consumed;
  }
  return out;
}

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  const m = parseHttpMessage(bytes, offset, offset + avail);
  if (!m) {
    fields.body = UTF8_DECODER.decode(bytes.subarray(offset, offset + avail));
    fieldRanges.body = [offset, avail];
    return { fields, fieldRanges, headerLength: 0, length: avail, error: 'partial' };
  }
  fields.kind = m.kind;
  const start: readonly [number, number] = [offset + m.ranges.startLine[0], m.ranges.startLine[1]];
  if (m.kind === 'request') {
    if (m.method !== undefined) fields.method = m.method;
    if (m.target !== undefined) fields.target = m.target;
    if (m.method !== undefined) fieldRanges.method = start;
    if (m.target !== undefined) fieldRanges.target = start;
  } else {
    if (m.status !== undefined) fields.status = m.status;
    if (m.reason !== undefined) fields.reason = m.reason;
    if (m.status !== undefined) fieldRanges.status = start;
    if (m.reason !== undefined) fieldRanges.reason = start;
  }
  fields.version = m.version;
  fields.headers = m.headers;
  fields.body = m.body;
  fieldRanges.kind = start;
  fieldRanges.version = start;
  fieldRanges.headers = [offset + m.ranges.headers[0], m.ranges.headers[1]];
  fieldRanges.body = [offset + m.ranges.body[0], m.ranges.body[1]];
  const headerLength = Math.min(avail, m.ranges.body[0]);
  const out: DecodedLayer = { fields, fieldRanges, headerLength, length: avail };
  if (!m.complete) out.error = 'partial';
  return out;
}

function text(fields: Readonly<Record<string, FieldValue>>, key: string, dflt: string): string {
  const v = fields[key];
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'string') throw new Error(`http.${key} must be a string`);
  return v;
}

function noLineBreak(key: string, v: string): string {
  if (/[\r\n]/.test(v)) throw new Error(`http.${key} must not contain a line break`);
  return v;
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const kind = strField('http', fields, 'kind', null);
  const version = noLineBreak('version', text(fields, 'version', HTTP_VERSION));
  let startLine: string;
  if (kind === 'request') {
    const method = noLineBreak('method', text(fields, 'method', 'GET'));
    const target = noLineBreak('target', text(fields, 'target', '/'));
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(method)) throw new Error(`http.method is not a valid token: "${method}"`);
    if (target === '' || /\s/.test(target)) throw new Error(`http.target must be non-empty without spaces: "${target}"`);
    startLine = `${method} ${target} ${version}`;
  } else if (kind === 'response') {
    const status = numField('http', fields, 'status', null);
    if (status < 100 || status > 999) throw new Error(`http.status out of range: ${status}`);
    const reason = noLineBreak('reason', text(fields, 'reason', httpReasonPhrase(status)));
    startLine = `${version} ${status} ${reason}`;
  } else {
    throw new Error(`http.kind must be 'request' or 'response', got "${kind}"`);
  }
  const headers = text(fields, 'headers', '');
  const lines = headers === '' ? [] : headers.split('\n').map((l) => l.replace(/\r$/, ''));
  for (const l of lines) if (/\r/.test(l)) throw new Error('http.headers lines must not contain a carriage return');
  const head = `${startLine}\r\n${lines.map((l) => `${l}\r\n`).join('')}\r\n`;
  const headBytes = new Uint8Array(head.length);
  for (let i = 0; i < head.length; i++) {
    const c = head.charCodeAt(i);
    if (c > 0xff) throw new Error('http start line and headers must be Latin-1 text');
    headBytes[i] = c;
  }
  const body = UTF8_ENCODER.encode(text(fields, 'body', ''));
  const out = new Uint8Array(headBytes.length + body.length + payload.length);
  out.set(headBytes, 0);
  out.set(body, headBytes.length);
  out.set(payload, headBytes.length + body.length);
  return out;
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  if (fields.kind === 'request') {
    return `HTTP ${String(fields.method ?? '?')} ${String(fields.target ?? '?')} ${String(fields.version ?? HTTP_VERSION)}`;
  }
  if (fields.kind === 'response') {
    const reason = typeof fields.reason === 'string' && fields.reason !== '' ? ` ${fields.reason}` : '';
    return `HTTP ${String(fields.version ?? HTTP_VERSION)} ${String(fields.status ?? '?')}${reason}`;
  }
  const n = typeof fields.body === 'string' ? UTF8_ENCODER.encode(fields.body).length : 0;
  return `HTTP continuation ${n} bytes`;
}

/** HTTP/1.1 codec. Required on encode: `kind`; responses also `status`. */
export const httpCodec: Codec = {
  proto: 'http',
  defaults: Object.freeze({ kind: null, version: HTTP_VERSION, headers: '', body: '' }),
  decode,
  encode,
  summarize,
};
