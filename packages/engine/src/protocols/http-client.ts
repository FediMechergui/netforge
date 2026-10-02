/**
 * protocols/http-client.ts — the browser fetch engine (RFC 9110/9112; ARCHITECTURE-P1 §4.4 step 0, §4.5
 * steps 1-6, §4.8 "Names").
 *
 * Requests:
 *  • `http.fetch {owner, token, url, session?}` starts (or restarts) the tab `token`;
 *  • `http.cancel {token}` and `job.abort {session}` end it with an original message.
 *
 * One fetch walks the phases of `HttpTabPhase`:
 *  1. the URL is normalized by the CLI parser's `normalizeUrl`. `https:` ends the tab at once with
 *     MSG_HTTPS; any other non-http scheme with MSG_SCHEME; unreadable text with MSG_BAD_URL.
 *  2. a name host → `resolving` and `dns.resolve {owner:'http-client', token}`. Order per §4.8: AAAA then A
 *     when this device has a preferred global or unique-local address AND a rib6 route towards global IPv6,
 *     otherwise A then AAAA; an empty answer falls through to the second type.
 *  3. `connecting` → `tcp.connect {socket:'http-client#<token>'}` to the first address (every later attempt of the
 *     same token appends `.<n>`, so a superseded connection can never be mistaken for the live one). `refused`,
 *     `timeout`,
 *     `no-route`, `host-unreachable` and `net-unreachable` move on to the next address (§4.8) before the tab
 *     fails.
 *  4. `sock.connected` → `waiting`: the GET of §4.5 step 3 (Host, User-Agent HTTP_BROWSER_USER_AGENT, Accept,
 *     Connection: close), encoded by the http codec.
 *  5. `sock.data` → `receiving`. The tab is finished by the server's FIN (`sock.peerClosed`), so the client is
 *     the passive closer and the server takes TIME_WAIT (§4.5 steps 6-7): it parses the response (framed by
 *     Content-Length or chunked, else close-delimited), goes `done` with {status, reason, headers, body} and
 *     calls `tcp.close`. A whole framed response that is never followed by a FIN is still delivered when the
 *     fetch deadline passes.
 * HTTP_CLIENT_TIMEOUT_NS bounds the whole fetch through the one-shot timer `fetch:<token>`.
 *
 * Debug category 'http'. stateSnapshot (read by the Desktop browser):
 *   { tabs: { '<token>': { url, phase, host, address?, status?, reason?, headers?, body?, error? } },
 *     fetches, completed, failed }
 * With a `session` the tab also prints one original summary line and ends with cliDone.
 *
 * P3 (ARCHITECTURE-P3 D21, §2.4, §3.0 (d), §3.8; §7 W2 http): `http.request {owner, token, method, url, headers?,
 * body?, timeoutNs?, session?}` is the API client — the host-shell `rest` job (owner 'cli', with its `session`) and
 * [S32] the script host use it. It is a separate path that never touches the browser tabs above:
 *  1. the URL is normalized by the same `normalizeUrl`; `http:` (port 80) and `https:` (port 443, `tcp.connect
 *     {tls: true}`: the data segments carry `meta.protected` + `protectedBy 'tls'`, no handshake bytes) are accepted;
 *     anything else, or a header that cannot be sent, ends the call at once with `bad-url`;
 *  2. a name host is resolved like a tab's (dns token `api:<token>`), a literal address is used as is;
 *  3. `tcp.connect {socket: 'http-client#api:<token>'}` (later attempts append `.<n>`), next address on the same
 *     socket errors as a tab;
 *  4. `sock.connected` → the request: `<METHOD> <target> HTTP/1.1`, `Host`, the caller's headers in order (its own
 *     Host, Content-Length, Connection and Transfer-Encoding are left out: the client writes those), `Content-Length`
 *     when there is a body or the method carries one, `Connection: close`, then the body;
 *  5. the response is read like a tab's (framed by Content-Length, finished by the server's FIN, so the client is the
 *     passive closer; a whole framed response without a FIN is still delivered at the deadline); a response to HEAD
 *     ends with its header block;
 *  6. the result goes to the owner: ProcessEvent `http.result {token, status, reason, headers, body}` (or `{token,
 *     error}`) to a process; to the CLI session the status line, the headers, a blank line and the body (JSON
 *     pretty-printed with two spaces when the response says it is JSON), or one original failure line; then cliDone.
 * The deadline is `timeoutNs` (default HTTP_CLIENT_TIMEOUT_NS) through the one-shot timer `request:<token>`; `job.abort`
 * of the session cancels the call. The StateView gains a `requests` member (the last HTTP_CLIENT_RETAINED_TABS calls)
 * and an `apiRequests` count only once a request has been made, so a P1 or P2 world's StateView is byte-identical.
 *
 * ponytail: the socket id counts connection ATTEMPTS, not tabs — the first attempt of a token is the plain
 * `http-client#<token>` of §4.5 step 1 and every later one appends `.<n>`, which is the cheapest way to keep a
 * restarted tab from inheriting the `sock.closed` of the connection its own restart aborted (and to stop a
 * next-address retry re-using an id that may still be in TIME_WAIT).
 * ponytail: one connection per fetch (no keep-alive, no pipelining, no parallel sub-resources), no redirects,
 * no cookies, no request body and no proxy; the port comes from the URL only. Finished tabs are forgotten oldest
 * first past HTTP_CLIENT_RETAINED_TABS (active ones never), because the GUI mints a token per navigation and
 * stateSnapshot is re-serialised into every UI snapshot; a student who wants an older page loads it again. §4.8's "a rib6 route to the
 * destination" is probed with 2000:: because the destination is still a name when the type is chosen. A tab
 * cancelled while resolving leaves its DNS query to finish; the late answer is ignored.
 */
import type { IpAddress } from '../contracts/addr.js';
import type { ProcessName, SessionId } from '../contracts/ids.js';
import { TCP_PORT_HTTPS } from '../contracts/pdu.js';
import type { Action, DebugEvent, HttpMethod, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import { HTTP_BROWSER_USER_AGENT, HTTP_CLIENT_TIMEOUT_NS, type HttpResponseView, type HttpTabPhase } from '../contracts/services.js';
import type { SimTime } from '../contracts/time.js';
import type { HttpResultEvent, ProcessEvent, SocketErrorCode, SocketId } from '../contracts/transport.js';
import { normalizeUrl } from '../cli/parser.js';
import { normalizeIp } from '../core/addr6.js';
import { parseJson, type DataNode } from '../automation/data/json.js';
import { httpCodec, httpHeader, parseHttpMessage, type HttpMessage } from '../pdu/codecs/http.js';

const NAME = 'http-client';
const CAT = 'http';
/** The owner of an `http.request` made by the host-shell `rest` job (text goes to its session). */
const CLI_OWNER = 'cli';
const DEBUG_RING = 256;
/**
 * Finished tabs kept for reading after the fact. The GUI mints a fresh token per navigation (`hostRequest` →
 * `r_<n>`), so without a cap every page a student ever loads would stay in `stateSnapshot()` — and therefore in
 * every snapshot posted to the UI — for the life of the simulation.
 */
export const HTTP_CLIENT_RETAINED_TABS = 8;
const NO_PAYLOAD = new Uint8Array(0);
/** `scheme://host-or-[v6]:port/path` as `normalizeUrl` renders it. */
const URL_PARTS = /^([a-z][a-z0-9+.-]*):\/\/(\[[^\]]+\]|[^:/]+)(?::(\d+))?(\/.*)$/;
/** Probe destination for "is there a route towards global IPv6" (§4.8, names). */
const GLOBAL_V6_PROBE = '2000::';
/** Socket error codes that mean "try the next address of the name" (§4.8). */
const NEXT_ADDRESS: ReadonlySet<SocketErrorCode> = new Set(['refused', 'timeout', 'no-route', 'host-unreachable', 'net-unreachable']);

// Original wording, never a vendor phrase.
export const MSG_HTTPS = 'Secure pages are not simulated in this release.';
export const MSG_BAD_URL = 'That web address could not be read.';
export const MSG_SCHEME = 'Only web addresses that start with http:// are simulated in this release.';
export const MSG_TIMEOUT = 'The page did not load in time.';
export const MSG_CANCELLED = 'The page load was cancelled.';
export const MSG_EMPTY = 'The server closed the connection before sending a page.';

/** Original tab message for a socket failure. */
function socketMessage(code: SocketErrorCode): string {
  switch (code) {
    case 'refused':
      return 'The server refused the connection.';
    case 'reset':
      return 'The connection was reset by the server.';
    case 'timeout':
      return 'The server did not answer in time.';
    case 'no-address':
      return 'This device has no address to reach the server.';
    case 'no-route':
    case 'net-unreachable':
      return 'There is no route to the server.';
    case 'host-unreachable':
      return 'The server could not be reached.';
    default:
      return `The connection failed (${code}).`;
  }
}

/** Original tab message for a failed lookup. */
function resolveMessage(host: string, rcode: string): string {
  if (rcode === 'NO-SERVER') return 'No DNS server is configured on this device.';
  if (rcode === 'NXDOMAIN') return `The name ${host} was not found.`;
  if (rcode === 'TIMEOUT') return 'The name server did not answer.';
  return `The name ${host} could not be resolved (${rcode}).`;
}

/** One browser tab / fetch. */
interface Tab {
  readonly token: string;
  readonly owner: ProcessName;
  readonly url: string;
  /** Host exactly as the URL wrote it (a name, or a literal address). */
  readonly host: string;
  /** Value of the Host header: host, plus ':port' when the URL carried one. */
  readonly hostHeader: string;
  readonly port: number;
  readonly path: string;
  readonly session?: SessionId;
  phase: HttpTabPhase;
  /** Query types still to try (§4.8). */
  qtypes: ('A' | 'AAAA')[];
  /** Addresses still to try. */
  addresses: IpAddress[];
  address?: IpAddress;
  /** Number of the next connection attempt of this token (0 = the first, which uses the plain id). */
  serial: number;
  socket?: SocketId;
  buf: Uint8Array;
  response?: HttpResponseView;
  error?: string;
}

/** Socket id of one connection ATTEMPT: the plain id for the first, `.<n>` for every later one. */
const socketOf = (t: Tab): SocketId => (t.serial === 0 ? `${NAME}#${t.token}` : `${NAME}#${t.token}.${t.serial}`);
const timerOf = (t: Tab): string => `fetch:${t.token}`;
const isActive = (t: Tab): boolean => t.phase !== 'done' && t.phase !== 'error';

function toTcp(req: Extract<ProcessRequest, { kind: `tcp.${string}` }>): Action {
  return { type: 'request', to: 'tcp', req };
}

function append(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** A response is framed when its length is declared; otherwise it ends with the connection. */
function isFramed(m: HttpMessage): boolean {
  return httpHeader(m.headers, 'content-length') !== undefined || httpHeader(m.headers, 'transfer-encoding') !== undefined;
}

// ── P3: the API client (`http.request`, D21) ─────────────────────────────────

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });
const UTF8_ENCODER = new TextEncoder();
/** An RFC 9110 field name (token). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Headers the client writes itself: the caller's copies are left out. */
const OWN_HEADERS: ReadonlySet<string> = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);
/** Methods whose request always carries a Content-Length (0 when there is no body). */
const BODY_METHODS: ReadonlySet<HttpMethod> = new Set(['POST', 'PUT', 'PATCH']);
const CRLFCRLF = [13, 10, 13, 10];

// Original wording, never a vendor phrase.
export const MSG_API_BAD_URL = 'That address could not be read as an http:// or https:// web address.';
export const MSG_API_BAD_HEADER = 'A request header could not be sent: a header is written "Name: value" on one line of plain text.';
export const MSG_API_TIMEOUT = 'The server did not answer the request in time.';
export const MSG_API_CANCELLED = 'The request was cancelled.';
export const MSG_API_EMPTY = 'The server closed the connection before it answered.';

/** One `http.request` in progress or finished. */
interface ApiCall {
  readonly token: string;
  readonly owner: ProcessName;
  readonly session?: SessionId;
  readonly method: HttpMethod;
  /** Normalized URL (the text as given when it could not be read). */
  readonly url: string;
  readonly host: string;
  readonly hostHeader: string;
  readonly port: number;
  /** Request target: the path and query of the URL. */
  readonly target: string;
  readonly tls: boolean;
  readonly headers: readonly (readonly [string, string])[];
  /** The body as UTF-8 text ('' when none). */
  readonly body: string;
  /** The same phase words as a browser tab's. */
  phase: HttpTabPhase;
  qtypes: ('A' | 'AAAA')[];
  addresses: IpAddress[];
  address?: IpAddress;
  serial: number;
  socket?: SocketId;
  buf: Uint8Array;
  status?: number;
  error?: string;
}

const apiSocketOf = (c: ApiCall): SocketId => (c.serial === 0 ? `${NAME}#api:${c.token}` : `${NAME}#api:${c.token}.${c.serial}`);
const apiTimerOf = (c: ApiCall): string => `request:${c.token}`;
const apiDnsToken = (token: string): string => `api:${token}`;
const apiActive = (c: ApiCall): boolean => c.phase !== 'done' && c.phase !== 'error';

/** Whether `bytes` holds a whole header block (CRLF CRLF seen). */
function hasHeadEnd(bytes: Uint8Array): boolean {
  outer: for (let i = 0; i + CRLFCRLF.length <= bytes.length; i++) {
    for (let k = 0; k < CRLFCRLF.length; k++) if (bytes[i + k] !== CRLFCRLF[k]) continue outer;
    return true;
  }
  return false;
}

/** 'Name: value' lines (joined by '\n') → ordered pairs. */
export function httpHeaderPairs(headers: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of headers.split('\n')) {
    const c = line.indexOf(':');
    if (c <= 0) continue;
    out.push([line.slice(0, c).trim(), line.slice(c + 1).trim()]);
  }
  return out;
}

/** True when a header can be written on the wire: a token name and a one-line Latin-1 value. */
function headerSendable(name: string, value: string): boolean {
  if (!HEADER_NAME.test(name) || /[\r\n]/.test(value)) return false;
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) > 0xff) return false;
  return true;
}

/**
 * A parsed JSON document pretty-printed with two spaces, members in the order they were received and numbers exactly as
 * written (a data object would move integer-like member names first, as JavaScript objects do).
 */
export function prettyJsonText(node: DataNode, level = 0): string {
  const pad = (n: number): string => '  '.repeat(n);
  switch (node.kind) {
    case 'null':
      return 'null';
    case 'boolean':
      return node.value ? 'true' : 'false';
    case 'number':
      return node.raw;
    case 'string':
      return JSON.stringify(node.value);
    case 'array':
      if (node.items.length === 0) return '[]';
      return `[\n${node.items.map((i) => `${pad(level + 1)}${prettyJsonText(i, level + 1)}`).join(',\n')}\n${pad(level)}]`;
    case 'object':
      if (node.entries.length === 0) return '{}';
      return `{\n${node.entries.map((e) => `${pad(level + 1)}${JSON.stringify(e.key)}: ${prettyJsonText(e.value, level + 1)}`).join(',\n')}\n${pad(level)}}`;
  }
}

/**
 * What the CLI session prints for a response: the status line, the headers, a blank line and the body — JSON
 * pretty-printed with two spaces when the response's Content-Type says JSON and the body parses.
 */
export function formatHttpResponseText(m: Pick<HttpMessage, 'startLine' | 'headers' | 'body'>): string {
  const lines = [m.startLine, ...(m.headers === '' ? [] : m.headers.split('\n')), ''];
  let body = m.body;
  const type = (httpHeader(m.headers, 'content-type') ?? '').toLowerCase();
  if (body !== '' && type.includes('json')) {
    const parsed = parseJson(body);
    if (parsed.ok) body = prettyJsonText(parsed.node);
  }
  if (body !== '') lines.push(body.endsWith('\n') ? body.slice(0, -1) : body);
  return `${lines.join('\n')}\n`;
}

export function createHttpClient(): Process {
  const tabs = new Map<string, Tab>();
  const ring: DebugEvent[] = [];
  let fetches = 0;
  let completed = 0;
  let failed = 0;

  function debug(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(CAT, message, data);
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message };
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  const byToken = (token: string): Tab | undefined => tabs.get(token);
  const bySocket = (socket: SocketId): Tab | undefined => [...tabs.values()].find((t) => isActive(t) && t.socket === socket);

  // ── P3 API calls (`http.request`, D21) ──
  const calls = new Map<string, ApiCall>();
  let apiRequests = 0;
  const callBySocket = (socket: SocketId): ApiCall | undefined => [...calls.values()].find((c) => apiActive(c) && c.socket === socket);

  /** Forget the oldest finished calls beyond HTTP_CLIENT_RETAINED_TABS (active ones never; insertion order). */
  function evictFinishedCalls(): void {
    let finished = 0;
    for (const c of calls.values()) if (!apiActive(c)) finished++;
    for (const [token, c] of calls) {
      if (finished <= HTTP_CLIENT_RETAINED_TABS) break;
      if (apiActive(c)) continue;
      calls.delete(token);
      finished--;
    }
  }

  /** End a call: cancel its deadline, close (done) or abort (error) its connection, then hand over the result. */
  function callFinish(c: ApiCall, phase: 'done' | 'error', deliver: readonly Action[]): Action[] {
    c.phase = phase;
    const out: Action[] = [{ type: 'cancelTimer', key: apiTimerOf(c) }];
    if (c.socket !== undefined) out.push(toTcp({ kind: phase === 'done' ? 'tcp.close' : 'tcp.abort', socket: c.socket }));
    out.push(...deliver);
    evictFinishedCalls();
    return out;
  }

  /** The owner's answer: text to the CLI session (owner 'cli'), else `http.result` to the owning process. */
  function callAnswer(c: ApiCall, text: string, ev: HttpResultEvent): Action[] {
    if (c.owner === CLI_OWNER) {
      return c.session === undefined ? [] : [{ type: 'cliOutput', session: c.session, text }, { type: 'cliDone', session: c.session }];
    }
    return [{ type: 'event', to: c.owner, ev }];
  }

  function callFail(ctx: ProcessCtx, c: ApiCall, code: NonNullable<HttpResultEvent['error']>, message: string): Action[] {
    c.error = message;
    debug(ctx, `${c.token}: ${c.method} ${c.url} failed: ${message}`, { token: c.token, url: c.url, error: code });
    return callFinish(c, 'error', callAnswer(c, `% The request to ${c.url} failed: ${message}\n`, { kind: 'http.result', token: c.token, error: code }));
  }

  function callDone(ctx: ProcessCtx, c: ApiCall, m: HttpMessage): Action[] {
    const status = m.status ?? 0;
    const reason = m.reason ?? '';
    c.status = status;
    const body = UTF8_ENCODER.encode(m.body);
    debug(ctx, `${c.token}: ${c.method} ${c.url}: ${status} ${reason} from ${c.address ?? '?'}, ${body.length} bytes`, { token: c.token, status, bytes: body.length });
    return callFinish(
      c,
      'done',
      callAnswer(c, formatHttpResponseText(m), { kind: 'http.result', token: c.token, status, reason, headers: httpHeaderPairs(m.headers), body }),
    );
  }

  /** Try the next address of the call; none left → it fails with `code` / `message`. */
  function callConnect(ctx: ProcessCtx, c: ApiCall, code: SocketErrorCode, message: string): Action[] {
    const address = c.addresses.shift();
    if (address === undefined) return callFail(ctx, c, code, message);
    c.address = address;
    c.phase = 'connecting';
    c.socket = apiSocketOf(c);
    c.serial++;
    c.buf = NO_PAYLOAD;
    debug(ctx, `${c.token}: connecting to ${address} port ${c.port}${c.tls ? ' (TLS, simulated)' : ''}`, { token: c.token, address, port: c.port });
    return [toTcp({ kind: 'tcp.connect', owner: NAME, socket: c.socket, dst: address, dstPort: c.port, ...(c.tls ? { tls: true as const } : {}) })];
  }

  /** Ask for the next query type of the call; none left → it fails (the name has no address). */
  function callResolve(ctx: ProcessCtx, c: ApiCall, message: string): Action[] {
    const qtype = c.qtypes.shift();
    if (qtype === undefined) return callFail(ctx, c, 'host-unreachable', message);
    c.phase = 'resolving';
    debug(ctx, `${c.token}: resolving ${c.host} ${qtype}`, { token: c.token, name: c.host, qtype });
    return [{ type: 'request', to: 'dns-client', req: { kind: 'dns.resolve', owner: NAME, token: apiDnsToken(c.token), name: c.host, qtype } }];
  }

  function startCall(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'http.request' }>): Action[] {
    const out: Action[] = [];
    const old = calls.get(req.token);
    if (old !== undefined && apiActive(old)) {
      // the owner asked again with the same token: the earlier call is dropped without an answer
      old.phase = 'error';
      old.error = MSG_API_CANCELLED;
      out.push({ type: 'cancelTimer', key: apiTimerOf(old) });
      if (old.socket !== undefined) out.push(toTcp({ kind: 'tcp.abort', socket: old.socket }));
    }
    calls.delete(req.token);
    apiRequests++;
    const normalized = normalizeUrl(req.url.trim());
    const parts = normalized === null ? null : URL_PARTS.exec(normalized);
    const scheme = parts?.[1];
    const tls = scheme === 'https';
    const bracketed = parts?.[2] ?? '';
    const path = parts?.[4] ?? '/';
    const hash = path.indexOf('#');
    const c: ApiCall = {
      token: req.token,
      owner: req.owner,
      ...(req.session !== undefined ? { session: req.session } : {}),
      method: req.method,
      url: normalized ?? req.url,
      host: bracketed.startsWith('[') ? bracketed.slice(1, -1) : bracketed,
      hostHeader: `${bracketed}${parts?.[3] !== undefined ? `:${Number(parts[3])}` : ''}`,
      port: parts?.[3] !== undefined ? Number(parts[3]) : tls ? TCP_PORT_HTTPS : 80,
      target: hash < 0 ? path : path.slice(0, hash),
      tls,
      headers: req.headers ?? [],
      body: req.body !== undefined ? UTF8_DECODER.decode(req.body) : '',
      phase: 'resolving',
      qtypes: [],
      addresses: [],
      // the counter runs on across restarts of the token, so no two attempts ever share an id
      serial: old?.serial ?? 0,
      buf: NO_PAYLOAD,
    };
    calls.set(c.token, c);
    if (parts === null || (scheme !== 'http' && scheme !== 'https')) return [...out, ...callFail(ctx, c, 'bad-url', MSG_API_BAD_URL)];
    if (!c.headers.every(([n, v]) => headerSendable(n, v))) return [...out, ...callFail(ctx, c, 'bad-url', MSG_API_BAD_HEADER)];
    debug(ctx, `${c.token}: ${c.method} ${c.url}`, { token: c.token, method: c.method, url: c.url });
    const timeout: SimTime = req.timeoutNs !== undefined && req.timeoutNs > 0 ? req.timeoutNs : HTTP_CLIENT_TIMEOUT_NS;
    out.push({ type: 'timer', key: apiTimerOf(c), delay: timeout });
    const literal = normalizeIp(c.host);
    if (literal !== null) {
      c.addresses = [literal];
      return [...out, ...callConnect(ctx, c, 'no-route', socketMessage('no-route'))];
    }
    c.qtypes = preferV6(ctx) ? ['AAAA', 'A'] : ['A', 'AAAA'];
    return [...out, ...callResolve(ctx, c, resolveMessage(c.host, 'NXDOMAIN'))];
  }

  /** The buffered response once it is whole (a HEAD answer ends with its header block). */
  function callWhole(c: ApiCall, ended: boolean): HttpMessage | undefined {
    const m = parseHttpMessage(c.buf);
    if (m === null || m.kind !== 'response') return undefined;
    if (c.method === 'HEAD') return hasHeadEnd(c.buf) ? { ...m, body: '', complete: true } : undefined;
    return (isFramed(m) ? m.complete : ended) ? m : undefined;
  }

  function callEnded(ctx: ProcessCtx, c: ApiCall): Action[] {
    const m = callWhole(c, true);
    return m === undefined ? callFail(ctx, c, 'reset', MSG_API_EMPTY) : callDone(ctx, c, m);
  }

  /** The request bytes: start line, Host, the caller's headers, Content-Length, Connection: close, body. */
  function requestBytes(c: ApiCall): Uint8Array {
    const lines = [`Host: ${c.hostHeader}`];
    for (const [n, v] of c.headers) if (!OWN_HEADERS.has(n.toLowerCase())) lines.push(`${n}: ${v}`);
    const length = UTF8_ENCODER.encode(c.body).length;
    if (length > 0 || BODY_METHODS.has(c.method)) lines.push(`Content-Length: ${length}`);
    lines.push('Connection: close');
    return httpCodec.encode({ kind: 'request', method: c.method, target: c.target, headers: lines.join('\n'), body: c.body }, NO_PAYLOAD);
  }

  /** A socket event of an API call's connection. */
  function callSocketEvent(ctx: ProcessCtx, c: ApiCall, ev: Extract<ProcessEvent, { socket: SocketId }>): Action[] {
    switch (ev.kind) {
      case 'sock.connected': {
        c.phase = 'waiting';
        const data = requestBytes(c);
        debug(ctx, `${c.token}: ${c.method} ${c.target} to ${c.address ?? '?'}, ${data.length} bytes`, { token: c.token, bytes: data.length });
        return [toTcp({ kind: 'tcp.send', socket: c.socket!, data })];
      }
      case 'sock.data':
        c.phase = 'receiving';
        c.buf = append(c.buf, ev.data);
        return [];
      case 'sock.peerClosed':
      case 'sock.closed':
        return callEnded(ctx, c);
      case 'sock.error': {
        c.socket = undefined;
        if (c.phase === 'connecting' && NEXT_ADDRESS.has(ev.code) && c.addresses.length > 0) return callConnect(ctx, c, ev.code, socketMessage(ev.code));
        return c.phase === 'receiving' ? callEnded(ctx, c) : callFail(ctx, c, ev.code, socketMessage(ev.code));
      }
      default:
        return [];
    }
  }

  function callTimeout(ctx: ProcessCtx, c: ApiCall): Action[] {
    const m = c.phase === 'receiving' ? callWhole(c, false) : undefined;
    return m === undefined ? callFail(ctx, c, 'timeout', MSG_API_TIMEOUT) : callDone(ctx, c, m);
  }

  function callCancel(ctx: ProcessCtx, c: ApiCall): Action[] {
    c.error = MSG_API_CANCELLED;
    debug(ctx, `${c.token}: cancelled`, { token: c.token });
    // the job's session was unblocked by the abort; one line and cliDone, as a cancelled tab prints
    return callFinish(c, 'error', c.owner === CLI_OWNER && c.session !== undefined ? [{ type: 'cliOutput', session: c.session, text: `% ${MSG_API_CANCELLED}\n` }, { type: 'cliDone', session: c.session }] : []);
  }

  function callsView(): Record<string, unknown> {
    const view: Record<string, unknown> = {};
    for (const c of calls.values()) {
      view[c.token] = {
        method: c.method,
        url: c.url,
        phase: c.phase,
        host: c.host,
        ...(c.address !== undefined ? { address: c.address } : {}),
        ...(c.status !== undefined ? { status: c.status } : {}),
        ...(c.error !== undefined ? { error: c.error } : {}),
      };
    }
    return view;
  }

  /**
   * Forget the oldest finished tabs beyond HTTP_CLIENT_RETAINED_TABS. Active tabs are never dropped, and the Map is
   * insertion-ordered, so which tab goes is the same in every run of the same script.
   */
  function evictFinished(): void {
    let finished = 0;
    for (const t of tabs.values()) if (!isActive(t)) finished++;
    if (finished <= HTTP_CLIENT_RETAINED_TABS) return;
    for (const [token, t] of tabs) {
      if (finished <= HTTP_CLIENT_RETAINED_TABS) break;
      if (isActive(t)) continue;
      tabs.delete(token);
      finished--;
    }
  }

  /** AAAA first only with a preferred global/ULA address AND a route towards global IPv6 (§4.8). */
  function preferV6(ctx: ProcessCtx): boolean {
    const global = [...ctx.ports.values()].some((p) => (p.l3.ipv6 ?? []).some((a) => a.state === 'preferred' && a.scope !== 'link-local'));
    return global && ctx.lpm6(GLOBAL_V6_PROBE).winner !== undefined;
  }

  /** Close the tab with a result; a session gets one original line and cliDone. */
  function finish(t: Tab, phase: 'done' | 'error', text: string): Action[] {
    t.phase = phase;
    const out: Action[] = [{ type: 'cancelTimer', key: timerOf(t) }];
    if (t.socket !== undefined) out.push(toTcp({ kind: phase === 'done' ? 'tcp.close' : 'tcp.abort', socket: t.socket }));
    if (t.session !== undefined) {
      out.push({ type: 'cliOutput', session: t.session, text }, { type: 'cliDone', session: t.session });
    }
    return out;
  }

  function fail(ctx: ProcessCtx, t: Tab, message: string): Action[] {
    failed++;
    t.error = message;
    debug(ctx, `${t.token}: ${t.url} failed: ${message}`, { token: t.token, url: t.url, error: message });
    return finish(t, 'error', `Could not fetch ${t.url}: ${message}\n`);
  }

  function done(ctx: ProcessCtx, t: Tab, m: HttpMessage): Action[] {
    completed++;
    t.response = { status: m.status ?? 0, reason: m.reason ?? '', headers: m.headers, body: m.body };
    const bytes = m.body.length;
    debug(ctx, `${t.token}: ${m.status ?? 0} ${m.reason ?? ''} from ${t.address ?? '?'}, ${bytes} characters`, { token: t.token, status: m.status, bytes });
    return finish(t, 'done', `Fetched ${t.url}: ${m.status ?? 0} ${m.reason ?? ''} from ${t.address ?? '?'}, ${bytes} characters\n`);
  }

  /** Try the next address (§4.8); none left → the tab fails with `message`. */
  function connect(ctx: ProcessCtx, t: Tab, message: string): Action[] {
    const address = t.addresses.shift();
    if (address === undefined) return fail(ctx, t, message);
    t.address = address;
    t.phase = 'connecting';
    t.socket = socketOf(t);
    t.serial++;
    t.buf = NO_PAYLOAD;
    debug(ctx, `${t.token}: connecting to ${address} port ${t.port}`, { token: t.token, address, port: t.port });
    return [toTcp({ kind: 'tcp.connect', owner: NAME, socket: t.socket, dst: address, dstPort: t.port })];
  }

  /** Ask for the next query type of the tab; none left → the tab fails. */
  function resolve(ctx: ProcessCtx, t: Tab, message: string): Action[] {
    const qtype = t.qtypes.shift();
    if (qtype === undefined) return fail(ctx, t, message);
    t.phase = 'resolving';
    debug(ctx, `${t.token}: resolving ${t.host} ${qtype}`, { token: t.token, name: t.host, qtype });
    return [{ type: 'request', to: 'dns-client', req: { kind: 'dns.resolve', owner: NAME, token: t.token, name: t.host, qtype } }];
  }

  function start(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'http.fetch' }>): Action[] {
    const out: Action[] = [];
    const old = byToken(req.token);
    if (old !== undefined && isActive(old)) {
      const lines = finish(old, 'error', `Could not fetch ${old.url}: ${MSG_CANCELLED}\n`);
      // A restart from the same session keeps that session blocked for the new fetch: one command, one cliDone.
      const same = old.session !== undefined && old.session === req.session;
      out.push(...(same ? lines.filter((a) => a.type !== 'cliOutput' && a.type !== 'cliDone') : lines));
    }
    fetches++;
    const normalized = normalizeUrl(req.url.trim());
    const parts = normalized === null ? null : URL_PARTS.exec(normalized);
    const bracketed = parts?.[2] ?? '';
    const host = bracketed.startsWith('[') ? bracketed.slice(1, -1) : bracketed;
    const t: Tab = {
      token: req.token,
      owner: req.owner,
      url: normalized ?? req.url,
      host,
      hostHeader: `${bracketed}${parts?.[3] !== undefined ? `:${Number(parts[3])}` : ''}`,
      port: parts?.[3] !== undefined ? Number(parts[3]) : 80,
      path: parts?.[4] ?? '/',
      ...(req.session !== undefined ? { session: req.session } : {}),
      phase: 'resolving',
      qtypes: [],
      addresses: [],
      // the counter runs on across restarts of the token, so no two attempts ever share an id
      serial: old?.serial ?? 0,
      buf: NO_PAYLOAD,
    };
    tabs.set(t.token, t);
    evictFinished();
    if (parts === null) return [...out, ...fail(ctx, t, MSG_BAD_URL)];
    if (parts[1] === 'https') return [...out, ...fail(ctx, t, MSG_HTTPS)];
    if (parts[1] !== 'http') return [...out, ...fail(ctx, t, MSG_SCHEME)];
    debug(ctx, `${t.token}: fetching ${t.url}`, { token: t.token, url: t.url });
    out.push({ type: 'timer', key: timerOf(t), delay: HTTP_CLIENT_TIMEOUT_NS });
    const literal = normalizeIp(host);
    if (literal !== null) {
      t.addresses = [literal];
      return [...out, ...connect(ctx, t, socketMessage('no-route'))];
    }
    t.qtypes = preferV6(ctx) ? ['AAAA', 'A'] : ['A', 'AAAA'];
    return [...out, ...resolve(ctx, t, resolveMessage(host, 'NXDOMAIN'))];
  }

  /** The buffered response once it is whole: framed and complete, or close-delimited and the connection ended. */
  function wholeResponse(t: Tab, ended: boolean): HttpMessage | undefined {
    const m = parseHttpMessage(t.buf);
    if (m === null || m.kind !== 'response') return undefined;
    return (isFramed(m) ? m.complete : ended) ? m : undefined;
  }

  /** The connection ended (FIN, close or reset): finish with what arrived. */
  function ended(ctx: ProcessCtx, t: Tab): Action[] {
    const m = wholeResponse(t, true);
    return m === undefined ? fail(ctx, t, MSG_EMPTY) : done(ctx, t, m);
  }

  return {
    name: NAME,

    init(): Action[] {
      return [];
    },

    onPdu(_ctx, pdu, port): Action[] {
      return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: 'http-client takes its bytes from tcp sockets', port }];
    },

    onConfig(): Action[] {
      return [];
    },

    onTimer(ctx, key): Action[] {
      if (key.startsWith('request:')) {
        const c = calls.get(key.slice('request:'.length));
        return c === undefined || !apiActive(c) ? [] : callTimeout(ctx, c);
      }
      const t = key.startsWith('fetch:') ? byToken(key.slice('fetch:'.length)) : undefined;
      if (t === undefined || !isActive(t)) return [];
      // a whole response that the server never followed with a FIN still counts
      const m = t.phase === 'receiving' ? wholeResponse(t, false) : undefined;
      return m === undefined ? fail(ctx, t, MSG_TIMEOUT) : done(ctx, t, m);
    },

    onEvent(ctx, ev: ProcessEvent): Action[] {
      if (ev.kind === 'dns.result') {
        const call = ev.token.startsWith('api:') ? calls.get(ev.token.slice('api:'.length)) : undefined;
        if (call !== undefined && call.phase === 'resolving') {
          if (ev.addresses.length > 0) {
            call.addresses = [...ev.addresses];
            return callConnect(ctx, call, 'no-route', socketMessage('no-route'));
          }
          return callResolve(ctx, call, resolveMessage(call.host, ev.rcode));
        }
        const t = byToken(ev.token);
        if (t === undefined || t.phase !== 'resolving') return [];
        if (ev.addresses.length > 0) {
          t.addresses = [...ev.addresses];
          return connect(ctx, t, socketMessage('no-route'));
        }
        return resolve(ctx, t, resolveMessage(t.host, ev.rcode));
      }
      if (ev.kind !== 'sock.connected' && ev.kind !== 'sock.data' && ev.kind !== 'sock.peerClosed' && ev.kind !== 'sock.closed' && ev.kind !== 'sock.error') return [];
      const t = bySocket(ev.socket);
      if (t === undefined) {
        const c = callBySocket(ev.socket);
        return c === undefined ? [] : callSocketEvent(ctx, c, ev);
      }
      switch (ev.kind) {
        case 'sock.connected': {
          t.phase = 'waiting';
          const headers = `Host: ${t.hostHeader}\nUser-Agent: ${HTTP_BROWSER_USER_AGENT}\nAccept: */*\nConnection: close`;
          const data = httpCodec.encode({ kind: 'request', method: 'GET', target: t.path, headers }, NO_PAYLOAD);
          debug(ctx, `${t.token}: GET ${t.path} to ${t.address ?? '?'}`, { token: t.token, path: t.path, bytes: data.length });
          return [toTcp({ kind: 'tcp.send', socket: t.socket!, data })];
        }
        case 'sock.data':
          // §4.5 step 6: the tab is finished by the server's FIN, so the client is the passive closer
          t.phase = 'receiving';
          t.buf = append(t.buf, ev.data);
          return [];
        case 'sock.peerClosed':
        case 'sock.closed':
          return ended(ctx, t);
        case 'sock.error': {
          t.socket = undefined;
          if (t.phase === 'connecting' && NEXT_ADDRESS.has(ev.code) && t.addresses.length > 0) return connect(ctx, t, socketMessage(ev.code));
          return t.phase === 'receiving' ? ended(ctx, t) : fail(ctx, t, socketMessage(ev.code));
        }
        default:
          return [];
      }
    },

    onRequest(ctx, req: ProcessRequest): Action[] {
      if (req.kind === 'http.fetch') return start(ctx, req);
      if (req.kind === 'http.request') return startCall(ctx, req);
      const t =
        req.kind === 'http.cancel'
          ? byToken(req.token)
          : req.kind === 'job.abort'
            ? [...tabs.values()].find((x) => isActive(x) && x.session === req.session)
            : undefined;
      if (req.kind === 'job.abort' && (t === undefined || !isActive(t))) {
        const c = [...calls.values()].find((x) => apiActive(x) && x.session === req.session);
        return c === undefined ? [] : callCancel(ctx, c);
      }
      if (t === undefined || !isActive(t)) return [];
      failed++;
      t.error = MSG_CANCELLED;
      debug(ctx, `${t.token}: cancelled`, { token: t.token });
      return finish(t, 'error', `Could not fetch ${t.url}: ${MSG_CANCELLED}\n`);
    },

    stateSnapshot(): StateView {
      const view: Record<string, unknown> = {};
      for (const t of tabs.values()) {
        view[t.token] = {
          url: t.url,
          phase: t.phase,
          host: t.host,
          ...(t.address !== undefined ? { address: t.address } : {}),
          ...(t.response ?? {}),
          ...(t.error !== undefined ? { error: t.error } : {}),
        };
      }
      // P3: the API members appear only once a request was made, so P1/P2 StateViews keep their bytes
      const api = apiRequests > 0 ? { requests: callsView(), apiRequests } : {};
      return { process: NAME, state: { tabs: view, fetches, completed, failed, ...api } };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}
