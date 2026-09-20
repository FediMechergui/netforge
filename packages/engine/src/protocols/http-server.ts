/**
 * protocols/http-server.ts — the HTTP/1.1 origin server (RFC 9110 semantics, RFC 9112 syntax;
 * ARCHITECTURE-P1 §4.5 steps 5-7, §6).
 *
 * Silent unless the config has `ip http server`; then it listens on port 80 with two sockets, 'http-server#80'
 * (family 4) and 'http-server#80v6' (family 6), and serves every accepted child:
 *  • bytes are buffered per child until the request head is complete (CRLFCRLF). A child that is not an HTTP
 *    request at all, or whose head passes HTTP_REQUEST_MAX bytes without ending, gets 400;
 *  • the target path (query and fragment cut off) is looked up in the `ip http page PATH TEXT` lines, else the
 *    original default page answers '/', else 404;
 *  • the reply is `HTTP/1.1 <status> <reason>` with `Server: <HTTP_SERVER_HEADER>`, `Content-Type: text/html`,
 *    `Content-Length` (UTF-8 bytes of the body) and `Connection: close`, encoded by the http codec, then
 *    `tcp.close` so the FIN follows the data (the client sees §4.5 steps 6-7).
 * A child's buffer is dropped on `sock.closed` / `sock.error`, a child that never completes a head is answered 408
 * and closed after HTTP_REQUEST_TIMEOUT_NS (one-shot timer `head:<socket>`, never periodic), and
 * `no ip http server` aborts every child and closes both listeners, so nothing is left behind.
 *
 * Debug category 'http'. stateSnapshot:
 *   { enabled, pages: [{ path, bytes }], open: ['<listenId>/<n>'], requests, served, notFound, badRequests }
 *
 * ponytail: the family-6 listener opens with the service instead of when IPv6 first comes up on a port — a
 * listener with no IPv6 address is silent, and re-checking `ipv6Enabled` would need a poll (nothing tells a
 * daemon that DAD finished). Skipped: keep-alive (every reply closes), HEAD/POST handling (every method is
 * answered like GET), conditional requests, a configurable port and MIME types other than text/html.
 */
import type { IpAddress } from '../contracts/addr.js';
import type { ConfigNode } from '../contracts/config.js';
import type { Action, DebugEvent, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import { HTTP_REQUEST_TIMEOUT_NS, HTTP_SERVER_HEADER } from '../contracts/services.js';
import type { ProcessEvent, SocketId } from '../contracts/transport.js';
import { configTextLinesOf } from '../cli/config-text.js';
import { httpCodec, httpReasonPhrase, parseHttpMessage } from '../pdu/codecs/http.js';

const NAME = 'http-server';
const CAT = 'http';
const DEBUG_RING = 256;
const SOCKET4 = 'http-server#80';
const SOCKET6 = 'http-server#80v6';
const HTTP_PORT = 80;
const UTF8 = new TextEncoder();
const NO_PAYLOAD = new Uint8Array(0);
/** Head cap: a client that never ends its request head is answered 400 instead of buffering for ever. */
export const HTTP_REQUEST_MAX = 8192;

/** Timer key of an accepted child's request-head deadline (the socket id reads back from it). */
const headKey = (socket: SocketId): string => `head:${socket}`;

/** `ip http server` plus the `ip http page PATH TEXT` pages, by normalized path. */
export interface HttpServerConfig {
  enabled: boolean;
  pages: Map<string, string>;
}

/** Request target → the path the pages are keyed by: query and fragment cut off, always leading '/'. */
export function httpPagePath(target: string): string {
  const cut = target.search(/[?#]/);
  const p = cut === -1 ? target : target.slice(0, cut);
  return p.startsWith('/') ? p : `/${p}`;
}

/** Service switch and pages from the running config. */
export function httpServerConfig(root: ConfigNode): HttpServerConfig {
  const pages = new Map<string, string>();
  let enabled = false;
  for (const l of configTextLinesOf(root)) {
    const t = l.tokens;
    if (l.context.length !== 0 || t[0] !== 'ip' || t[1] !== 'http') continue;
    if (t[2] === 'server' && t.length === 3) enabled = true;
    else if (t[2] === 'page' && t.length >= 4) pages.set(httpPagePath(t[3]!), t.slice(4).join(' '));
  }
  return { enabled, pages };
}

/** The original page '/' answers when no `ip http page /` line is configured. */
export function httpDefaultPage(hostname: string): string {
  return `<html><head><title>NetForge web server</title></head><body><h1>${hostname}</h1><p>This page is served by the simulated web server on ${hostname}. Configure your own with "ip http page".</p></body></html>`;
}

/** Original body of an error status. */
function errorPage(status: number, detail: string): string {
  return `<html><head><title>${status} ${httpReasonPhrase(status)}</title></head><body><h1>${status} ${httpReasonPhrase(status)}</h1><p>${detail}</p></body></html>`;
}

/** A complete response message as bytes (the http codec renders the head verbatim, so Content-Length is ours). */
function responseBytes(status: number, body: string): Uint8Array {
  const headers = `Server: ${HTTP_SERVER_HEADER}\nContent-Type: text/html\nContent-Length: ${UTF8.encode(body).length}\nConnection: close`;
  return httpCodec.encode({ kind: 'response', status, reason: httpReasonPhrase(status), headers, body }, NO_PAYLOAD);
}

function append(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Wrap a transport request as an action (one place for the `to: 'tcp'` target). */
function toTcp(req: Extract<ProcessRequest, { kind: `tcp.${string}` }>): Action {
  return { type: 'request', to: 'tcp', req };
}

/** One accepted connection while its request is read and answered. */
interface Child {
  readonly id: SocketId;
  readonly remote: IpAddress;
  buf: Uint8Array;
  answered: boolean;
}

export function createHttpServer(): Process {
  const children = new Map<SocketId, Child>();
  const ring: DebugEvent[] = [];
  let cfg: HttpServerConfig = { enabled: false, pages: new Map() };
  let open = false;
  let requests = 0;
  let served = 0;
  let notFound = 0;
  let badRequests = 0;

  function debug(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(CAT, message, data);
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message };
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  /** Start or stop the listeners to match `ip http server`. */
  function sync(ctx: ProcessCtx): Action[] {
    cfg = httpServerConfig(ctx.config.root);
    if (cfg.enabled === open) return [];
    open = cfg.enabled;
    debug(ctx, open ? 'web service started on port 80' : 'web service stopped', { pages: [...cfg.pages.keys()] });
    if (open) {
      return [
        toTcp({ kind: 'tcp.listen', owner: NAME, socket: SOCKET4, family: 4, localPort: HTTP_PORT }),
        toTcp({ kind: 'tcp.listen', owner: NAME, socket: SOCKET6, family: 6, localPort: HTTP_PORT }),
      ];
    }
    const out: Action[] = [];
    for (const id of children.keys()) out.push({ type: 'cancelTimer', key: headKey(id) }, toTcp({ kind: 'tcp.abort', socket: id }));
    children.clear();
    out.push(toTcp({ kind: 'tcp.close', socket: SOCKET4 }), toTcp({ kind: 'tcp.close', socket: SOCKET6 }));
    return out;
  }

  /** Send one response and close the connection (FIN after the data). */
  function respond(ctx: ProcessCtx, child: Child, status: number, body: string): Action[] {
    child.answered = true;
    if (status === 200) served++;
    else if (status === 404) notFound++;
    else badRequests++;
    const data = responseBytes(status, body);
    debug(ctx, `${child.id}: ${status} ${httpReasonPhrase(status)} to ${child.remote}, ${data.length} bytes`, { socket: child.id, status, bytes: data.length });
    return [
      { type: 'cancelTimer', key: headKey(child.id) },
      toTcp({ kind: 'tcp.send', socket: child.id, data }),
      toTcp({ kind: 'tcp.close', socket: child.id }),
    ];
  }

  /** Answer as soon as the buffered bytes hold a whole request head. */
  function serve(ctx: ProcessCtx, child: Child): Action[] {
    const m = parseHttpMessage(child.buf);
    if (m === null || m.kind !== 'request') return respond(ctx, child, 400, errorPage(400, 'The request could not be read as HTTP.'));
    if (!m.complete) {
      return child.buf.length > HTTP_REQUEST_MAX ? respond(ctx, child, 400, errorPage(400, 'The request head is too long.')) : [];
    }
    requests++;
    const path = httpPagePath(m.target ?? '/');
    const page = cfg.pages.get(path) ?? (path === '/' ? httpDefaultPage(ctx.hostname) : undefined);
    debug(ctx, `${child.id}: ${m.method ?? '?'} ${path} from ${child.remote}`, { socket: child.id, method: m.method, path });
    if (page === undefined) return respond(ctx, child, 404, errorPage(404, `No page is configured at ${path} on ${ctx.hostname}.`));
    return respond(ctx, child, 200, page);
  }

  return {
    name: NAME,

    init(ctx): Action[] {
      return sync(ctx);
    },

    onPdu(_ctx, pdu, port): Action[] {
      return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: 'http-server takes its bytes from tcp sockets', port }];
    },

    onConfig(ctx, delta): Action[] {
      return delta.context.length === 0 && delta.line[0] === 'ip' && delta.line[1] === 'http' ? sync(ctx) : [];
    },

    onTimer(ctx, key): Action[] {
      if (!key.startsWith('head:')) return [];
      const child = children.get(key.slice('head:'.length));
      if (child === undefined || child.answered) return [];
      return respond(ctx, child, 408, errorPage(408, 'The request did not arrive in time.'));
    },

    onEvent(ctx, ev: ProcessEvent): Action[] {
      switch (ev.kind) {
        case 'sock.accepted': {
          if (ev.listener !== SOCKET4 && ev.listener !== SOCKET6) return [];
          children.set(ev.socket, { id: ev.socket, remote: ev.remoteAddr, buf: NO_PAYLOAD, answered: false });
          debug(ctx, `accepted ${ev.socket} from ${ev.remoteAddr}:${ev.remotePort}`, { socket: ev.socket, remote: ev.remoteAddr });
          return [{ type: 'timer', key: headKey(ev.socket), delay: HTTP_REQUEST_TIMEOUT_NS }];
        }
        case 'sock.data': {
          const child = children.get(ev.socket);
          if (child === undefined || child.answered) return [];
          child.buf = append(child.buf, ev.data);
          return serve(ctx, child);
        }
        case 'sock.peerClosed': {
          const child = children.get(ev.socket);
          return child === undefined || child.answered ? [] : [toTcp({ kind: 'tcp.close', socket: child.id })];
        }
        case 'sock.closed':
          return children.delete(ev.socket) ? [{ type: 'cancelTimer', key: headKey(ev.socket) }] : [];
        case 'sock.error': {
          const known = children.delete(ev.socket);
          if (known || ev.socket === SOCKET4 || ev.socket === SOCKET6) {
            debug(ctx, `${ev.socket}: ${ev.code}${ev.detail !== undefined ? ` (${ev.detail})` : ''}`, { socket: ev.socket, code: ev.code });
          }
          return known ? [{ type: 'cancelTimer', key: headKey(ev.socket) }] : [];
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
          pages: [...cfg.pages].map(([path, text]) => ({ path, bytes: UTF8.encode(text).length })),
          open: [...children.keys()],
          requests,
          served,
          notFound,
          badRequests,
        },
      };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}
