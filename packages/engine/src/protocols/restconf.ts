/**
 * protocols/restconf.ts — the device API: RESTCONF (RFC 8040) over simulated TLS on TCP 443 (ARCHITECTURE-P3 D21,
 * §3.0 (c), §3.8, §4.2, §4.3, §5.6; §7 W2 http).
 *
 * Silent unless the configuration holds BOTH `restconf` and `ip http secure-server` (§4.3); then it listens on
 * `restconf#443` (family 4, `tls: true`: every data segment of an accepted connection carries `meta.protected` with
 * `protectedBy 'tls'`, no handshake bytes) and only answers. Removing either line aborts every connection and closes
 * the listener. On a managed switch the transport is awake while both lines are stored (D22, `DORMANT_TRANSPORT_OWNERS`;
 * ipv4 precedes this daemon, so the delta that starts the service has already woken it).
 *
 * One request per connection (every answer ends with `Connection: close` and `tcp.close`):
 *  1. bytes are buffered per accepted child until the head and its Content-Length body are complete (the one-shot
 *     `head:<socket>` guard of HTTP_REQUEST_TIMEOUT_NS answers 408; a request beyond RESTCONF_REQUEST_MAX bytes 413);
 *  2. a complete request joins a FIFO: requests are handled one at a time, in arrival order, so a write is planned
 *     against the configuration every earlier write left (a write waits for its `config.result` before the next one);
 *  3. a method outside GET, HEAD, POST, PUT, PATCH, DELETE is 405 (not logged: the log row needs an HTTP method);
 *     `/.well-known/host-meta` answers without a login (RFC 8040 §3.1); every other target needs HTTP Basic
 *     credentials of a `username <u> privilege 15 secret|password <s>` line and `ip http authentication local` (401
 *     otherwise, with `WWW-Authenticate`);
 *  4. the target is read by `automation/yang/path.ts` and resolved by `automation/yang/model.ts`: GET/HEAD of `/restconf`,
 *     of the operations list and of data answer 200 with RFC 7951 JSON (`application/yang-data+json`; HEAD without the
 *     body); a write (PUT, POST, PATCH, DELETE) with a JSON body (`application/yang-data+json` or `application/json`,
 *     else 415; unparsable JSON 400) is planned by `planYangWrite` into canonical configuration lines — none: answered
 *     at once (204 for a PUT that changes nothing, so PUT twice is 201 then 204); some: the `configure` action
 *     `{token: <child socket>, lines, atomic: true, indentation: true, origin {via 'restconf', user, address}}` (D21),
 *     whose `config.result` decides: 201 or 204 as planned, else 400 whose message is the CLI's own error text (the
 *     atomic run applied nothing); POST `/restconf/operations/nf-native:save-config` runs its line the same way (204);
 *  5. refusals carry an `ietf-restconf:errors` body (RFC 8040 §7.1) with the model's or the CLI's original message.
 * Every answered request with an HTTP method is one row of the `restconf-log` table (key = String(seq); seq counts from
 * 1 for the life of the daemon; at most RESTCONF_LOG_LIMIT rows, the oldest deleted with reason 'replaced' first) —
 * the gradeable record (rule 20). `user` is set once the credentials were accepted.
 *
 * Debug category 'restconf'. stateSnapshot:
 *   { enabled, authentication: 'local' | 'none', open: ['<listenId>/<n>'], pending, requests, refused }
 *
 * ponytail: IPv4 only; one request per connection (no keep-alive); query parameters are read and ignored (no depth,
 * fields or content filtering); XML bodies are refused with 415 (XML encoding is [C21], not approved); there is no
 * candidate datastore: a write changes the running configuration (listed deviation (20)).
 */
import type { IpAddress } from '../contracts/addr.js';
import type { ConfigNode } from '../contracts/config.js';
import type { PortView } from '../contracts/port.js';
import { TCP_PORT_HTTPS } from '../contracts/pdu.js';
import type { Action, DebugEvent, HttpMethod, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import { HTTP_REQUEST_TIMEOUT_NS, HTTP_SERVER_HEADER } from '../contracts/services.js';
import type { RestconfLogRow } from '../contracts/tables.js';
import type { ConfigResultEvent, ProcessEvent, SocketId } from '../contracts/transport.js';
import { configTextLinesOf } from '../cli/config-text.js';
import { verifySecret } from '../cli/secrets.js';
import { parseJson, stringifyJson, type DataValue } from '../automation/data/json.js';
import { parseRestconfTarget } from '../automation/yang/path.js';
import {
  planYangWrite,
  readYang,
  resolveYangOperation,
  resolveYangPath,
  yangOperationLines,
  yangOperations,
  type YangDeviceView,
  type YangError,
  type YangErrorTag,
  type YangIfType,
  type YangInterfaceView,
  type YangWriteMethod,
} from '../automation/yang/model.js';
import { httpCodec, httpHeader, httpReasonPhrase, parseHttpMessage, type HttpMessage } from '../pdu/codecs/http.js';

const NAME = 'restconf';
const CAT = 'restconf';
const DEBUG_RING = 256;
const NO_PAYLOAD = new Uint8Array(0);
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });

/** The listening socket (accepted children are `restconf#443/<n>`). */
export const RESTCONF_LISTEN_SOCKET = 'restconf#443';
/** Rows kept in the `restconf-log` table (§2.6). */
export const RESTCONF_LOG_LIMIT = 50;
/** The largest request (head and body) the API reads; a larger one is answered 413. */
export const RESTCONF_REQUEST_MAX = 65536;
/** The media type of every JSON answer (RFC 8040 §5.2). */
export const RESTCONF_JSON_TYPE = 'application/yang-data+json';
/** Body media types the API reads. */
const READABLE_TYPES: ReadonlySet<string> = new Set([RESTCONF_JSON_TYPE, 'application/json']);
const METHODS: ReadonlySet<string> = new Set<HttpMethod>(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const ALLOW_ALL = 'GET, HEAD, POST, PUT, PATCH, DELETE';
const ALLOW_READ = 'GET, HEAD';
/** Reason phrases the http codec's table does not list. */
const EXTRA_REASONS: Readonly<Record<number, string>> = Object.freeze({ 409: 'Conflict', 415: 'Unsupported Media Type' });
/** The `ietf-yang-library` revision `/restconf` names (RFC 8040 §3.3). */
const YANG_LIBRARY_VERSION = '2016-06-21';

// Original wording, never a vendor phrase.
export const MSG_RESTCONF_NO_AUTH_METHOD = 'The API accepts no login until "ip http authentication local" is configured.';
export const MSG_RESTCONF_LOGIN_NEEDED = 'Log in with HTTP Basic authentication: a user name and password of a privilege 15 user.';
export const MSG_RESTCONF_LOGIN_FAILED = 'The user name or password is wrong, or the user does not have privilege 15.';
export const MSG_RESTCONF_METHOD = 'The API answers GET, HEAD, POST, PUT, PATCH and DELETE.';
export const MSG_RESTCONF_MEDIA_TYPE = `The API reads JSON bodies: send the body with "Content-Type: ${RESTCONF_JSON_TYPE}".`;
export const MSG_RESTCONF_UNKNOWN = 'There is no API resource at this address; the API lives under /restconf.';
export const MSG_RESTCONF_READ_ONLY = 'This resource can only be read (GET or HEAD).';
export const MSG_RESTCONF_TOO_LARGE = `The request is larger than ${RESTCONF_REQUEST_MAX} bytes.`;
export const MSG_RESTCONF_TIMEOUT = 'The request did not arrive in time.';
export const MSG_RESTCONF_UNREADABLE = 'The request could not be read as HTTP.';
export const MSG_RESTCONF_REFUSED = 'The device refused the change.';

/** Reason phrase of a status the API sends. */
export function restconfReason(status: number): string {
  return EXTRA_REASONS[status] ?? httpReasonPhrase(status);
}

// ── configuration ────────────────────────────────────────────────────────────

/** The service lines (§5.6). The daemon listens only when `restconf` and `ip http secure-server` are both stored. */
export interface RestconfConfig {
  readonly restconf: boolean;
  readonly secureServer: boolean;
  readonly authLocal: boolean;
  readonly enabled: boolean;
}

/** Reads the global service lines of a running configuration (stored lines only; negations never count). */
export function restconfConfig(root: ConfigNode): RestconfConfig {
  let restconf = false;
  let secureServer = false;
  let authLocal = false;
  for (const l of configTextLinesOf(root)) {
    if (l.context.length !== 0 || l.negate) continue;
    const t = l.tokens;
    if (t.length === 1 && t[0] === 'restconf') restconf = true;
    else if (t[0] === 'ip' && t[1] === 'http' && t[2] === 'secure-server' && t.length === 3) secureServer = true;
    else if (t[0] === 'ip' && t[1] === 'http' && t[2] === 'authentication' && t[3] === 'local' && t.length === 4) authLocal = true;
  }
  return { restconf, secureServer, authLocal, enabled: restconf && secureServer };
}

/** A local user as the API sees it: `username <name> [privilege <n>] secret|password <stored>`. */
export interface RestconfUser {
  readonly name: string;
  /** 1 when the line names no privilege (the default of a local user). */
  readonly privilege: number;
  /** The stored secret (tagged hash or plain text, as `verifySecret` reads it). */
  readonly stored: string;
}

/** Every `username` line of a running configuration, in configuration order. */
export function restconfUsers(root: ConfigNode): RestconfUser[] {
  const out: RestconfUser[] = [];
  for (const node of root.children) {
    if (node.key !== 'username' || node.args.length < 3) continue;
    const a = node.args;
    let privilege = 1;
    let at = 1;
    if (a[1] === 'privilege') {
      privilege = Number(a[2]);
      at = 3;
    }
    if ((a[at] === 'secret' || a[at] === 'password') && a.length > at + 1 && Number.isInteger(privilege)) {
      out.push({ name: a[0] as string, privilege, stored: a.slice(at + 1).join(' ') });
    }
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decodes standard base64 (padding optional); undefined when the text is not base64. */
export function decodeBase64(text: string): Uint8Array | undefined {
  const s = text.replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(s) || s.length % 4 === 1) return undefined;
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    acc = (acc << 6) | B64.indexOf(s[i] as string);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
    acc &= (1 << bits) - 1;
  }
  return Uint8Array.from(out);
}

/** The user and password of an `Authorization: Basic …` header (RFC 7617), or undefined. */
export function basicCredentials(header: string | undefined): { user: string; password: string } | undefined {
  if (header === undefined) return undefined;
  const m = /^Basic\s+(\S+)\s*$/i.exec(header.trim());
  if (m === null) return undefined;
  const bytes = decodeBase64(m[1] as string);
  if (bytes === undefined) return undefined;
  const text = UTF8_DECODER.decode(bytes);
  const colon = text.indexOf(':');
  if (colon < 0) return undefined;
  return { user: text.slice(0, colon), password: text.slice(colon + 1) };
}

// ── answers ──────────────────────────────────────────────────────────────────

/** The `ietf-restconf:errors` body of a refusal (RFC 8040 §7.1), as RFC 7951 JSON. */
export function restconfErrorBody(type: 'transport' | 'rpc' | 'protocol' | 'application', tag: YangErrorTag | 'access-denied' | 'operation-failed', message: string): string {
  return stringifyJson({ 'ietf-restconf:errors': { error: [{ 'error-type': type, 'error-tag': tag, 'error-message': message }] } });
}

/** One answer before it is encoded. */
interface Answer {
  readonly status: number;
  /** The body text ('' = none). */
  readonly body?: string;
  readonly contentType?: string;
  readonly extra?: readonly string[];
  /** HEAD: the headers of the answer (its Content-Length included), without the body. */
  readonly headOnly?: boolean;
}

/** A refusal answer with its errors body. */
function refusal(status: number, type: Parameters<typeof restconfErrorBody>[0], tag: Parameters<typeof restconfErrorBody>[1], message: string, extra?: readonly string[]): Answer {
  return { status, body: restconfErrorBody(type, tag, message), contentType: RESTCONF_JSON_TYPE, ...(extra !== undefined ? { extra } : {}) };
}

/** A model refusal (`YangError`) as an answer: status, error-tag and message are the model's. */
function modelRefusal(e: YangError): Answer {
  const type = e.errorTag === 'malformed-message' || e.errorTag === 'operation-not-supported' ? 'protocol' : 'application';
  return refusal(e.status, type, e.errorTag, e.message, e.status === 405 ? [`Allow: ${ALLOW_ALL}`] : undefined);
}

/** The bytes of an answer: status line, Server, Content-Type, Content-Length, extra headers, Connection: close, body. */
function answerBytes(a: Answer): Uint8Array {
  const body = a.body ?? '';
  const lines = [`Server: ${HTTP_SERVER_HEADER}`];
  if (body !== '') lines.push(`Content-Type: ${a.contentType ?? RESTCONF_JSON_TYPE}`);
  if (a.status !== 204) lines.push(`Content-Length: ${UTF8_ENCODER.encode(body).length}`);
  lines.push(...(a.extra ?? []), 'Connection: close');
  return httpCodec.encode(
    { kind: 'response', status: a.status, reason: restconfReason(a.status), headers: lines.join('\n'), body: a.headOnly === true || a.status === 204 ? '' : body },
    NO_PAYLOAD,
  );
}

// ── the device view ──────────────────────────────────────────────────────────

/** The iana-if-type of a port, or undefined for ports the API does not show (console, the controller's tunnel). */
function ifTypeOf(p: PortView): YangIfType | undefined {
  if (p.spec.kind === 'console' || p.role === 'console' || p.role === 'wlan-tunnel') return undefined;
  if (p.role === 'svi') return 'l3ipvlan';
  if (p.role === 'channel') return 'ieee8023adLag';
  if (p.role === 'subif') return 'l2vlan';
  if (p.role === 'tunnel') return 'tunnel';
  if (p.spec.kind === 'serial') return 'propPointToPointSerial';
  if (p.spec.kind === 'virtual' && /^Loopback/i.test(p.id)) return 'softwareLoopback';
  if (p.spec.kind === 'ethernet') return 'ethernetCsmacd';
  if (p.spec.kind === 'wlan' || p.spec.kind === 'radio') return 'ieee80211';
  return 'other';
}

/** What the YANG reader and the write planner see of this device: hostname, running configuration, ports in order. */
export function restconfDeviceView(ctx: Pick<ProcessCtx, 'hostname' | 'config' | 'ports'>): YangDeviceView {
  const interfaces: YangInterfaceView[] = [];
  for (const p of ctx.ports.values()) {
    const ifType = ifTypeOf(p);
    if (ifType === undefined) continue;
    const c = p.counters;
    const v4 = p.l3.ipv4;
    interfaces.push({
      name: p.id,
      ifType,
      enabled: p.adminUp,
      operUp: p.operUp,
      physAddress: p.mac,
      speedBps: p.speedBps ?? p.spec.speedBps,
      counters: {
        inOctets: c.inBytes,
        inUnicastPkts: Math.max(0, c.inPackets - c.inBroadcasts),
        inDiscards: c.inDrops,
        inErrors: c.inErrors,
        outOctets: c.outBytes,
        outUnicastPkts: c.outPackets,
        outDiscards: c.outDrops,
        outErrors: 0,
      },
      ...(v4 !== undefined && v4.origin === 'dhcp' ? { dynamicAddress: { ip: v4.address, prefixLength: v4.prefixLen, origin: 'dhcp' as const } } : {}),
    });
  }
  return { hostname: ctx.hostname, config: ctx.config.root, interfaces };
}

// ── the daemon ───────────────────────────────────────────────────────────────

/** One accepted connection while its request is read, waits its turn, is worked on and answered. */
interface Child {
  readonly id: SocketId;
  readonly remote: IpAddress;
  buf: Uint8Array;
  state: 'reading' | 'queued' | 'working' | 'answered' | 'gone';
}

/** What the log row of a request records (absent: the request had no HTTP method). */
interface LogInfo {
  readonly method: HttpMethod;
  readonly path: string;
  user?: string;
}

/** The write waiting for its `config.result`. */
interface Pending {
  readonly child: Child;
  readonly token: string;
  readonly status: number;
  readonly log: LogInfo;
}

const headKey = (socket: SocketId): string => `head:${socket}`;
const isMethod = (m: string): m is HttpMethod => METHODS.has(m);

export function createRestconf(): Process {
  const children = new Map<SocketId, Child>();
  const queue: { child: Child; m: HttpMessage }[] = [];
  const ring: DebugEvent[] = [];
  let cfg: RestconfConfig = { restconf: false, secureServer: false, authLocal: false, enabled: false };
  let open = false;
  let busy: Pending | undefined;
  let seq = 0;
  let requests = 0;
  let refused = 0;

  function debug(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(CAT, message, data);
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message };
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  const toTcp = (req: Extract<ProcessRequest, { kind: `tcp.${string}` }>): Action => ({ type: 'request', to: 'tcp', req });

  /** Start or stop the listener to match `restconf` + `ip http secure-server`. */
  function sync(ctx: ProcessCtx): Action[] {
    cfg = restconfConfig(ctx.config.root);
    if (cfg.enabled === open) return [];
    open = cfg.enabled;
    debug(ctx, open ? `API service started on port ${TCP_PORT_HTTPS} (TLS, simulated)` : 'API service stopped');
    if (open) return [toTcp({ kind: 'tcp.listen', owner: NAME, socket: RESTCONF_LISTEN_SOCKET, family: 4, localPort: TCP_PORT_HTTPS, tls: true })];
    const out: Action[] = [];
    for (const c of children.values()) {
      c.state = 'gone';
      out.push({ type: 'cancelTimer', key: headKey(c.id) }, toTcp({ kind: 'tcp.abort', socket: c.id }));
    }
    children.clear();
    queue.length = 0;
    busy = undefined;
    out.push(toTcp({ kind: 'tcp.close', socket: RESTCONF_LISTEN_SOCKET }));
    return out;
  }

  /** One `restconf-log` row (the oldest deleted first when the table is full). */
  function logRow(ctx: ProcessCtx, child: Child, log: LogInfo, status: number): void {
    const table = ctx.tables.get<RestconfLogRow>('restconf-log');
    seq++;
    if (table === undefined) return;
    while (table.size >= RESTCONF_LOG_LIMIT) {
      const oldest = table.rows()[0];
      if (oldest === undefined) break;
      table.delete(oldest.key, 'replaced');
    }
    table.set({
      key: String(seq),
      seq,
      method: log.method,
      path: log.path,
      status,
      client: child.remote,
      ...(log.user !== undefined ? { user: log.user } : {}),
      at: ctx.now,
      updatedAt: ctx.now,
    });
  }

  /** Send the answer, close the connection (FIN after the data), write the log row. */
  function respond(ctx: ProcessCtx, child: Child, a: Answer, log: LogInfo | undefined): Action[] {
    if (a.status >= 400) refused++;
    if (log !== undefined) logRow(ctx, child, log, a.status);
    const live = child.state !== 'gone' && child.state !== 'answered';
    child.state = 'answered';
    if (!live) return [];
    const data = answerBytes(a);
    debug(ctx, `${child.id}: ${a.status} ${restconfReason(a.status)} to ${child.remote}${log !== undefined ? ` (${log.method} ${log.path})` : ''}`, {
      socket: child.id,
      status: a.status,
      bytes: data.length,
    });
    return [{ type: 'cancelTimer', key: headKey(child.id) }, toTcp({ kind: 'tcp.send', socket: child.id, data }), toTcp({ kind: 'tcp.close', socket: child.id })];
  }

  /** The user of valid Basic credentials of a privilege 15 user, or the refusal. */
  function authenticate(ctx: ProcessCtx, m: HttpMessage): { ok: true; user: string } | { ok: false; answer: Answer } {
    const challenge = ['WWW-Authenticate: Basic realm="restconf"'];
    if (!cfg.authLocal) return { ok: false, answer: refusal(401, 'protocol', 'access-denied', MSG_RESTCONF_NO_AUTH_METHOD, challenge) };
    const cred = basicCredentials(httpHeader(m.headers, 'authorization'));
    if (cred === undefined) return { ok: false, answer: refusal(401, 'protocol', 'access-denied', MSG_RESTCONF_LOGIN_NEEDED, challenge) };
    const user = restconfUsers(ctx.config.root).find((u) => u.name === cred.user);
    if (user === undefined || user.privilege !== 15 || !verifySecret(ctx.deviceId, user.stored, cred.password)) {
      return { ok: false, answer: refusal(401, 'protocol', 'access-denied', MSG_RESTCONF_LOGIN_FAILED, challenge) };
    }
    return { ok: true, user: user.name };
  }

  /** The parsed JSON body of a write, or the refusal (415 for another media type, 400 for broken JSON). */
  function readBody(m: HttpMessage): { ok: true; body?: DataValue } | { ok: false; answer: Answer } {
    if (m.body.trim() === '') return { ok: true };
    const type = (httpHeader(m.headers, 'content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!READABLE_TYPES.has(type)) return { ok: false, answer: refusal(415, 'protocol', 'invalid-value', MSG_RESTCONF_MEDIA_TYPE) };
    const parsed = parseJson(m.body);
    if (!parsed.ok) {
      const e = parsed.error;
      return { ok: false, answer: refusal(400, 'protocol', 'malformed-message', `The body is not valid JSON (line ${e.line}, column ${e.column}): ${e.message}`) };
    }
    return { ok: true, body: parsed.value };
  }

  /** Hand lines to the CLI through the configure seam (D21); the answer waits for `config.result`. */
  function configure(child: Child, log: LogInfo, lines: readonly string[], status: number): Action[] {
    child.state = 'working';
    busy = { child, token: child.id, status, log };
    const origin = { via: 'restconf' as const, ...(log.user !== undefined ? { user: log.user } : {}), address: child.remote };
    return [{ type: 'configure', token: child.id, lines: [...lines], atomic: true, indentation: true, origin }];
  }

  /** Work on one complete request: an answer now, or a configure action whose result answers later. */
  function handle(ctx: ProcessCtx, child: Child, m: HttpMessage): Action[] {
    requests++;
    const method = m.method ?? '';
    const target = m.target ?? '/';
    const parsed = parseRestconfTarget(target);
    const path = parsed.ok ? parsed.path : (target.split('?')[0] as string);
    debug(ctx, `${child.id}: ${method} ${target} from ${child.remote}`, { socket: child.id, method, target });
    if (!isMethod(method)) return respond(ctx, child, refusal(405, 'protocol', 'operation-not-supported', MSG_RESTCONF_METHOD, [`Allow: ${ALLOW_ALL}`]), undefined);
    const log: LogInfo = { method, path };
    const read = method === 'GET' || method === 'HEAD';
    const ok = (body: string, contentType = RESTCONF_JSON_TYPE): Answer => ({ status: 200, body, contentType, headOnly: method === 'HEAD' });
    const readOnly = (): Answer => refusal(405, 'protocol', 'operation-not-supported', MSG_RESTCONF_READ_ONLY, [`Allow: ${ALLOW_READ}`]);

    if (parsed.ok && parsed.resource.kind === 'host-meta') {
      if (!read) return respond(ctx, child, readOnly(), log);
      return respond(ctx, child, ok("<XRD xmlns='http://docs.oasis-open.org/ns/xri/xrd-1.0'>\n  <Link rel='restconf' href='/restconf'/>\n</XRD>\n", 'application/xrd+xml'), log);
    }
    const auth = authenticate(ctx, m);
    if (!auth.ok) return respond(ctx, child, auth.answer, log);
    log.user = auth.user;
    if (!parsed.ok) return respond(ctx, child, refusal(400, 'protocol', 'malformed-message', parsed.error.message), log);
    const res = parsed.resource;
    switch (res.kind) {
      case 'root':
        if (!read) return respond(ctx, child, readOnly(), log);
        return respond(ctx, child, ok(stringifyJson({ 'ietf-restconf:restconf': { data: {}, operations: {}, 'yang-library-version': YANG_LIBRARY_VERSION } })), log);
      case 'unknown':
      case 'host-meta':
        return respond(ctx, child, refusal(404, 'protocol', 'invalid-value', MSG_RESTCONF_UNKNOWN), log);
      case 'operations': {
        if (res.path.length === 0) {
          if (!read) return respond(ctx, child, refusal(405, 'protocol', 'operation-not-supported', 'Name the operation to run, as /restconf/operations/<module>:<operation>.', [`Allow: ${ALLOW_READ}`]), log);
          const ops: Record<string, string> = {};
          for (const n of yangOperations()) ops[`${n.module}:${n.name}`] = `/restconf/operations/${n.module}:${n.name}`;
          return respond(ctx, child, ok(stringifyJson({ 'ietf-restconf:operations': ops })), log);
        }
        const op = resolveYangOperation(res.path);
        if (!op.ok) return respond(ctx, child, modelRefusal(op.error), log);
        if (method !== 'POST') return respond(ctx, child, refusal(405, 'protocol', 'operation-not-supported', 'An operation is run with POST.', ['Allow: POST']), log);
        const lines = yangOperationLines(op.node);
        return lines.length === 0 ? respond(ctx, child, { status: 204 }, log) : configure(child, log, lines, 204);
      }
      case 'data': {
        const steps = resolveYangPath(res.path);
        if (!steps.ok) return respond(ctx, child, modelRefusal(steps.error), log);
        if (read) {
          const r = readYang(restconfDeviceView(ctx), steps.steps);
          if (!r.ok) return respond(ctx, child, modelRefusal(r.error), log);
          return respond(ctx, child, ok(stringifyJson(r.value)), log);
        }
        let body: DataValue | undefined;
        if (method !== 'DELETE') {
          const b = readBody(m);
          if (!b.ok) return respond(ctx, child, b.answer, log);
          body = b.body;
        }
        const plan = planYangWrite(restconfDeviceView(ctx), { method: method as YangWriteMethod, steps: steps.steps, ...(body !== undefined ? { body } : {}) });
        if (!plan.ok) return respond(ctx, child, modelRefusal(plan.error), log);
        if (plan.lines.length === 0) return respond(ctx, child, { status: plan.status }, log);
        debug(ctx, `${child.id}: ${plan.lines.length} configuration line(s) for ${method} ${path}`, { socket: child.id, lines: plan.lines });
        return configure(child, log, plan.lines, plan.status);
      }
    }
  }

  /** Work on queued requests in arrival order until one waits for its configuration result. */
  function pump(ctx: ProcessCtx): Action[] {
    const out: Action[] = [];
    while (busy === undefined && queue.length > 0) {
      const next = queue.shift() as { child: Child; m: HttpMessage };
      if (next.child.state !== 'queued') continue;
      out.push(...handle(ctx, next.child, next.m));
    }
    return out;
  }

  /** New bytes on a child: queue the request once it is whole. */
  function received(ctx: ProcessCtx, child: Child): Action[] {
    const m = parseHttpMessage(child.buf);
    if (m === null || m.kind !== 'request') return respond(ctx, child, refusal(400, 'transport', 'malformed-message', MSG_RESTCONF_UNREADABLE), undefined);
    if (!m.complete) {
      if (child.buf.length <= RESTCONF_REQUEST_MAX) return [];
      const method = m.method ?? '';
      const log = isMethod(method) ? { method, path: (m.target ?? '/').split('?')[0] as string } : undefined;
      return respond(ctx, child, refusal(413, 'transport', 'malformed-message', MSG_RESTCONF_TOO_LARGE), log);
    }
    child.state = 'queued';
    queue.push({ child, m });
    return [{ type: 'cancelTimer', key: headKey(child.id) }, ...pump(ctx)];
  }

  /** The configuration result of the write in progress: answer it, then go on with the queue. */
  function configured(ctx: ProcessCtx, ev: ConfigResultEvent): Action[] {
    if (busy === undefined || ev.token !== busy.token) return [];
    const job = busy;
    busy = undefined;
    let answer: Answer;
    if (ev.result.ok) answer = { status: job.status };
    else {
      const failed = ev.result.lines.find((l) => !l.ok && l.skipped !== true);
      const message = failed?.error?.message ?? MSG_RESTCONF_REFUSED;
      debug(ctx, `${job.child.id}: the device refused "${failed?.line.trim() ?? '?'}": ${message}`, { socket: job.child.id, line: failed?.line, reverted: ev.result.reverted === true });
      answer = refusal(400, 'application', 'invalid-value', message);
    }
    return [...respond(ctx, job.child, answer, job.log), ...pump(ctx)];
  }

  function forget(id: SocketId): Action[] {
    const child = children.get(id);
    if (child === undefined) return [];
    children.delete(id);
    // a request still queued is skipped; one being configured is answered nowhere but still logged
    child.state = 'gone';
    return [{ type: 'cancelTimer', key: headKey(id) }];
  }

  return {
    name: NAME,

    init(ctx): Action[] {
      return sync(ctx);
    },

    onPdu(_ctx, pdu, port): Action[] {
      return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: 'restconf takes its bytes from tcp sockets', port }];
    },

    onConfig(ctx, delta): Action[] {
      if (delta.context.length !== 0) return [];
      const l = delta.line;
      return l[0] === 'restconf' || (l[0] === 'ip' && l[1] === 'http') ? sync(ctx) : [];
    },

    onTimer(ctx, key): Action[] {
      if (!key.startsWith('head:')) return [];
      const child = children.get(key.slice('head:'.length));
      if (child === undefined || child.state !== 'reading') return [];
      return respond(ctx, child, refusal(408, 'transport', 'malformed-message', MSG_RESTCONF_TIMEOUT), undefined);
    },

    onEvent(ctx, ev: ProcessEvent): Action[] {
      switch (ev.kind) {
        case 'config.result':
          return configured(ctx, ev);
        case 'sock.accepted': {
          if (ev.listener !== RESTCONF_LISTEN_SOCKET) return [];
          children.set(ev.socket, { id: ev.socket, remote: ev.remoteAddr, buf: NO_PAYLOAD, state: 'reading' });
          debug(ctx, `accepted ${ev.socket} from ${ev.remoteAddr}:${ev.remotePort}`, { socket: ev.socket, remote: ev.remoteAddr });
          return [{ type: 'timer', key: headKey(ev.socket), delay: HTTP_REQUEST_TIMEOUT_NS }];
        }
        case 'sock.data': {
          const child = children.get(ev.socket);
          if (child === undefined || child.state !== 'reading') return [];
          const buf = new Uint8Array(child.buf.length + ev.data.length);
          buf.set(child.buf, 0);
          buf.set(ev.data, child.buf.length);
          child.buf = buf;
          return received(ctx, child);
        }
        case 'sock.peerClosed': {
          const child = children.get(ev.socket);
          if (child === undefined || child.state !== 'reading') return [];
          // the client gave up before its request was whole
          child.state = 'answered';
          return [{ type: 'cancelTimer', key: headKey(child.id) }, toTcp({ kind: 'tcp.close', socket: child.id })];
        }
        case 'sock.closed':
          return forget(ev.socket);
        case 'sock.error': {
          if (ev.socket === RESTCONF_LISTEN_SOCKET || children.has(ev.socket)) {
            debug(ctx, `${ev.socket}: ${ev.code}${ev.detail !== undefined ? ` (${ev.detail})` : ''}`, { socket: ev.socket, code: ev.code });
          }
          return forget(ev.socket);
        }
        default:
          return [];
      }
    },

    onRequest(): Action[] {
      return [];
    },

    stateSnapshot(): StateView {
      return {
        process: NAME,
        state: {
          enabled: open,
          authentication: cfg.authLocal ? 'local' : 'none',
          open: [...children.keys()],
          pending: [...(busy !== undefined ? [busy.child.id] : []), ...queue.filter((q) => q.child.state === 'queued').map((q) => q.child.id)],
          requests,
          refused,
        },
      };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}
