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
import type { Action, DebugEvent, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import { HTTP_BROWSER_USER_AGENT, HTTP_CLIENT_TIMEOUT_NS, type HttpResponseView, type HttpTabPhase } from '../contracts/services.js';
import type { ProcessEvent, SocketErrorCode, SocketId } from '../contracts/transport.js';
import { normalizeUrl } from '../cli/parser.js';
import { normalizeIp } from '../core/addr6.js';
import { httpCodec, httpHeader, parseHttpMessage, type HttpMessage } from '../pdu/codecs/http.js';

const NAME = 'http-client';
const CAT = 'http';
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
      const t = key.startsWith('fetch:') ? byToken(key.slice('fetch:'.length)) : undefined;
      if (t === undefined || !isActive(t)) return [];
      // a whole response that the server never followed with a FIN still counts
      const m = t.phase === 'receiving' ? wholeResponse(t, false) : undefined;
      return m === undefined ? fail(ctx, t, MSG_TIMEOUT) : done(ctx, t, m);
    },

    onEvent(ctx, ev: ProcessEvent): Action[] {
      if (ev.kind === 'dns.result') {
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
      if (t === undefined) return [];
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
      const t =
        req.kind === 'http.cancel'
          ? byToken(req.token)
          : req.kind === 'job.abort'
            ? [...tabs.values()].find((x) => isActive(x) && x.session === req.session)
            : undefined;
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
      return { process: NAME, state: { tabs: view, fetches, completed, failed } };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}
