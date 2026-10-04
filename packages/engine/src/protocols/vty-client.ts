/**
 * protocols/vty-client.ts — [S13] the remote terminal client: the `telnet <host> [<port>]` and `ssh -l <user> [-v 2]
 * <host>` jobs of routers, switches and host shells (ARCHITECTURE-P3 D14, D22, §2.4, §3.14, §4.2, §4.3, §5.7; §7 W3 svc;
 * rulings R17 and R27).
 *
 * Silent until a `vty.connect {session, target, proto, user?, password?, port?}` (the CLI's job, or a grader clone with
 * the credentials). One client session per CLI session; it relays that session (cli/runtime.ts, [S13] block):
 *  • SSH asks for the password locally first (`cliRemote {prompt 'Password: ', input 'secret'}`; skipped when the
 *    request carries one), then connects to port 22; telnet connects to port 23 (or `port`) at once.
 *  • `tcp.connect` from socket `vty-client#<n>` (the client's connect timeout is tcp's SYN retries, §4.2). On a managed
 *    switch whose transport is dormant (D22) the session first sends ipv4 `ext.ipv4.transportHold {hold: true}`
 *    (R17/R27: the outbound session wakes the transport for its own life) and releases it when the connection is gone.
 *  • SSH: the identification line in clear, then `ext.tcp.protect` (every later segment is protected); after the
 *    server's line, USERAUTH_REQUEST (user, password) in a protected packet; FAILURE prints a refusal and asks for the
 *    password again (or re-sends the supplied one); SUCCESS opens the session; CHANNEL_DATA carries the terminal stream
 *    both ways (protocols/vty.ts).
 *  • The terminal stream from the server: complete lines become `cliOutput` (one per received segment), a prompt
 *    (`IAC GA`) becomes `cliRemote {session, prompt, input: 'secret' while the server echoes (WILL ECHO), remote: '<name>
 *    via SSH|Telnet' once, at the first device prompt}` — the prompt frees the session for the next line. With
 *    credentials in the request, the login prompts are answered with them instead of being relayed.
 *  • `vty.input {line}`: the password (SSH), or a line for the far end — SSH: one CHANNEL_DATA packet; telnet: one
 *    segment per line, but one segment per character while the server masks the input (so a telnet password is seen
 *    in clear, one character per segment), each sent once the previous one is acknowledged (`sock.drained`).
 *  • `vty.interrupt` (^C, or the console closing) ends the session: the connection is closed, `cliDone` at once.
 *  • The end: the server closing prints the closing line; a refusal (a RST before the session opened, or no listener)
 *    prints `% Connection refused by <addr>`; an ICMP error prints why the address cannot be reached; each ends with
 *    `cliDone` (the CLI's relay ends).
 *
 * Timers: none of its own (§4.2: the connect timeout is tcp's). Debug categories (§5.8): `ip ssh` and `telnet`.
 * Determinism: no rng; socket ids count per daemon; the SSH keystream is the server's (`vtySshKey`, §4.1).
 *
 * stateSnapshot(): `{ process: 'vty-client', state: { sessions: [{ session, proto, target, port, phase, remote? }],
 *   results: [{ session, proto, target, outcome, detail?, at }] } }` — `results` (at most VTY_CLIENT_RESULTS, newest
 *   last) records each session's latest outcome: 'connecting', 'open', 'refused', 'failed', 'unreachable', 'timeout',
 *   'closed' or 'cancelled' (the grader clone's `service` check reads a refusal here, §2.10).
 */
import type { IpAddress } from '../contracts/addr.js';
import type { ProcessName, SessionId } from '../contracts/ids.js';
import type { Action, CliRemoteAction, DebugEvent, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import type { SimTime } from '../contracts/time.js';
import type { ProcessEvent, SocketErrorCode, SocketId } from '../contracts/transport.js';
import { dormantTransportEligible, transportHoldRequest } from './ip-upper.js';
import { tcpProtectRequest } from './tcp.js';
import {
  createVtyTermReader,
  SSH_MSG_CHANNEL_DATA,
  SSH_MSG_DISCONNECT,
  SSH_MSG_USERAUTH_FAILURE,
  SSH_MSG_USERAUTH_REQUEST,
  SSH_MSG_USERAUTH_SUCCESS,
  VTY_DEBUG_CATEGORY,
  VTY_PROMPT_PASSWORD,
  VTY_SSH_PORT,
  VTY_SSH_VERSION,
  VTY_TELNET_PORT,
  vtyBytes,
  vtyConcat,
  vtySshKey,
  vtySshPacket,
  vtySshUnpack,
  vtySshVersionLine,
  vtySshVersionOk,
  vtyTermLine,
  vtyText,
  type VtyProto,
  type VtyTermReader,
} from './vty.js';

/** @since P3 [S13] The client daemon's name (`PROCESS_ORDER`: after vty, §2.1). */
export const VTY_CLIENT_DAEMON: ProcessName = 'vty-client';
/** @since P3 [S13] Session outcomes kept in the StateView (newest last). */
export const VTY_CLIENT_RESULTS = 16;
/** @since P3 [S13] The longest SSH identification line the client waits for. */
export const VTY_CLIENT_VERSION_MAX = 255;

/** @since P3 [S13] What became of a client session (the StateView `results`). */
export type VtyClientOutcome = 'connecting' | 'open' | 'refused' | 'failed' | 'unreachable' | 'timeout' | 'closed' | 'cancelled';

// ── texts the client prints (original wording) ─────────────────────────────

/** @since P3 [S13] The connection attempt. */
export const vtyClientConnectingText = (target: IpAddress, port: number): string => `Connecting to ${target} port ${port} ...`;
/** @since P3 [S13] A telnet connection was opened. */
export const vtyClientConnectedText = (target: IpAddress): string => `Connected to ${target}.`;
/** @since P3 [S13] A RST before the session opened: no listener, the transport or an access-class refused it. */
export const vtyClientRefusedText = (target: IpAddress): string => `% Connection refused by ${target}`;
/** @since P3 [S13] The remote device ended the session. */
export const vtyClientClosedByRemoteText = (target: IpAddress): string => `% Connection to ${target} closed by the remote device.`;
/** @since P3 [S13] The local user ended the session (^C). */
export const vtyClientClosedText = (target: IpAddress): string => `% Connection to ${target} closed.`;
/** @since P3 [S13] An open session was reset. */
export const vtyClientResetText = (target: IpAddress): string => `% Connection to ${target} was reset.`;
/** @since P3 [S13] SSH USERAUTH_FAILURE. */
export const VTY_CLIENT_DENIED = '% Permission denied: wrong user name or password.';
/** @since P3 [S13] The far end does not speak SSH 2.0. */
export const vtyClientMismatchText = (target: IpAddress): string => `% ${target} does not answer with SSH 2.0 (protocol mismatch).`;
/** @since P3 [S13] The SSH password prompt was cancelled. */
export const VTY_CLIENT_CANCELLED = '% Cancelled.';

/** The words of an ICMP-derived socket error. */
const UNREACHABLE_WORDS: Readonly<Partial<Record<SocketErrorCode, string>>> = Object.freeze({
  'host-unreachable': 'host unreachable',
  'net-unreachable': 'network unreachable',
  'port-unreachable': 'port unreachable',
  'proto-unreachable': 'protocol unreachable',
  'admin-prohibited': 'administratively prohibited',
  'ttl-exceeded': 'time to live exceeded',
});

/** @since P3 [S13] The line printed when a connection fails with `code`, and the session's outcome. */
export function vtyClientFailure(target: IpAddress, code: SocketErrorCode, opened: boolean): { text: string; outcome: VtyClientOutcome } {
  if (code === 'refused' || (code === 'reset' && !opened)) return { text: vtyClientRefusedText(target), outcome: 'refused' };
  if (code === 'reset') return { text: vtyClientResetText(target), outcome: 'closed' };
  if (code === 'timeout') return { text: `% ${target} did not answer (connection timed out).`, outcome: 'timeout' };
  if (code === 'no-route') return { text: `% No route to ${target}.`, outcome: 'unreachable' };
  if (code === 'no-address') return { text: `% No address on this device can reach ${target}.`, outcome: 'unreachable' };
  const words = UNREACHABLE_WORDS[code];
  if (words !== undefined) return { text: `% Cannot reach ${target}: ${words}.`, outcome: 'unreachable' };
  return { text: `% Connection to ${target} failed (${code}).`, outcome: opened ? 'closed' : 'refused' };
}

/** A device prompt (`R1>`, `SW1#`, `R1(config)#`): the remote device's name, else undefined (a login prompt). */
const DEVICE_PROMPT = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\([A-Za-z0-9-]+\))?[>#]$/;

/** @since P3 [S13] The device name of an exec or configuration prompt, else undefined. */
export function vtyClientPromptName(prompt: string): string | undefined {
  return DEVICE_PROMPT.exec(prompt)?.[1];
}

// ── the daemon ──────────────────────────────────────────────────────────────

const NAME = VTY_CLIENT_DAEMON;
const DEBUG_RING = 256;
const NO_BYTES = new Uint8Array(0);

/** The StateView record of one session's outcome. */
interface ResultView {
  session: SessionId;
  proto: VtyProto;
  target: IpAddress;
  outcome: VtyClientOutcome;
  detail?: string;
  at: SimTime;
}

/** One client session. */
interface ClientSession {
  readonly session: SessionId;
  readonly proto: VtyProto;
  readonly target: IpAddress;
  readonly port: number;
  readonly user: string;
  /** Credentials the request supplied: every login prompt is answered with them instead of being relayed. */
  readonly given: { readonly user?: string; readonly password?: string };
  password?: string;
  socket?: SocketId;
  phase: 'password' | 'connecting' | 'version' | 'auth' | 'retry' | 'open' | 'closing';
  /** SSH: received bytes not yet framed. */
  rx: Uint8Array;
  readonly reader: VtyTermReader;
  /** SSH keystream keys (set at connect). */
  txKey: number;
  rxKey: number;
  /** Telnet: chunks waiting for the previous one's acknowledgement, and whether one is in flight. */
  readonly queue: Uint8Array[];
  sending: boolean;
  /** The chip, once the first device prompt named the far end. */
  remote?: string;
  /** The session holds a dormant switch transport awake (R27). */
  held: boolean;
  /** `cliDone` was sent: the CLI session is free again. */
  done: boolean;
  readonly result: ResultView;
}

/** @since P3 [S13] Create the remote terminal client (`name: 'vty-client'`, no frame selectors). One per device. */
export function createVtyClient(): Process {
  const bySession = new Map<SessionId, ClientSession>();
  const bySocket = new Map<SocketId, ClientSession>();
  const results: ResultView[] = [];
  const ring: DebugEvent[] = [];
  let nextSocket = 0;

  function debug(ctx: ProcessCtx, c: ClientSession, message: string, data?: Record<string, unknown>): void {
    const category = VTY_DEBUG_CATEGORY[c.proto];
    ctx.debug(category, message, data);
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: NAME, category, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: NAME, category, message };
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  const toTcp = (req: ProcessRequest): Action => ({ type: 'request', to: 'tcp', req });
  const print = (c: ClientSession, text: string): Action => ({ type: 'cliOutput', session: c.session, text });
  const label = (c: ClientSession): string => (c.proto === 'ssh' ? 'SSH' : 'Telnet');

  function outcome(ctx: ProcessCtx, c: ClientSession, o: VtyClientOutcome, detail?: string): void {
    c.result.outcome = o;
    c.result.at = ctx.now;
    if (detail !== undefined) c.result.detail = detail;
    else delete c.result.detail;
  }

  /** `cliDone` once: the CLI session's relay ends. */
  function done(c: ClientSession): Action[] {
    if (c.done) return [];
    c.done = true;
    if (bySession.get(c.session) === c) bySession.delete(c.session);
    return [{ type: 'cliDone', session: c.session }];
  }

  /** The connection is gone: forget the socket and release the transport hold (R27). */
  function finish(c: ClientSession): Action[] {
    if (c.socket !== undefined) bySocket.delete(c.socket);
    if (!c.held) return [];
    c.held = false;
    return [{ type: 'request', to: 'ipv4', req: transportHoldRequest(NAME, c.socket ?? c.session, false) }];
  }

  function relayPrompt(c: ClientSession, prompt: string, secret: boolean, remote?: string): Action {
    const act: CliRemoteAction = { type: 'cliRemote', session: c.session, prompt };
    if (secret) act.input = 'secret';
    if (remote !== undefined) act.remote = remote;
    return act;
  }

  /** Open the TCP connection (the SSH password is known by now). */
  function connect(ctx: ProcessCtx, c: ClientSession): Action[] {
    nextSocket++;
    const socket = `${NAME}#${nextSocket}`;
    c.socket = socket;
    c.phase = 'connecting';
    bySocket.set(socket, c);
    const out: Action[] = [];
    // R17/R27: an outbound session wakes a dormant switch transport for its own life (D22)
    if (dormantTransportEligible(ctx.model, 'tcp')) {
      c.held = true;
      out.push({ type: 'request', to: 'ipv4', req: transportHoldRequest(NAME, socket, true) });
    }
    debug(ctx, c, `${c.session}: connecting to ${c.target} port ${c.port} (${label(c)}) from ${socket}`, { session: c.session, socket, target: c.target });
    out.push(print(c, vtyClientConnectingText(c.target, c.port)));
    out.push(toTcp({ kind: 'tcp.connect', owner: NAME, socket, dst: c.target, dstPort: c.port }));
    return out;
  }

  /** Telnet: send the next queued chunk once the previous one is acknowledged. */
  function pump(c: ClientSession): Action[] {
    if (c.sending || c.socket === undefined) return [];
    const chunk = c.queue.shift();
    if (chunk === undefined) return [];
    c.sending = true;
    return [toTcp({ kind: 'tcp.send', socket: c.socket, data: chunk })];
  }

  /** A line for the far end (the typed line, or a supplied credential). */
  function typeLine(c: ClientSession, line: string): Action[] {
    if (c.socket === undefined) return [];
    if (c.proto === 'ssh') return [toTcp({ kind: 'tcp.send', socket: c.socket, data: vtySshPacket(c.txKey, SSH_MSG_CHANNEL_DATA, vtyTermLine(line)) })];
    if (c.reader.masked) {
      // the server masks the input (WILL ECHO): one character per segment, then the line end
      for (const ch of line) c.queue.push(vtyBytes(ch));
      c.queue.push(vtyTermLine(''));
    } else c.queue.push(vtyTermLine(line));
    return pump(c);
  }

  /** SSH USERAUTH_REQUEST: user, a zero byte, the password. */
  function sendAuth(c: ClientSession): Action[] {
    if (c.socket === undefined) return [];
    const user = vtyBytes(c.user);
    const password = vtyBytes(c.password ?? '');
    const body = new Uint8Array(user.length + 1 + password.length);
    body.set(user, 0);
    body.set(password, user.length + 1);
    c.phase = 'auth';
    return [toTcp({ kind: 'tcp.send', socket: c.socket, data: vtySshPacket(c.txKey, SSH_MSG_USERAUTH_REQUEST, body) })];
  }

  /** A prompt from the far end: answered with a supplied credential during the login, else relayed to the CLI. */
  function onPrompt(ctx: ProcessCtx, c: ClientSession, prompt: string, masked: boolean): Action[] {
    const name = vtyClientPromptName(prompt);
    if (c.remote === undefined && name === undefined) {
      if (masked && c.given.password !== undefined) return typeLine(c, c.given.password);
      if (!masked && c.given.user !== undefined) return typeLine(c, c.given.user);
    }
    let remote: string | undefined;
    if (c.remote === undefined && name !== undefined) {
      remote = `${name} via ${label(c)}`;
      c.remote = remote;
      outcome(ctx, c, 'open');
      debug(ctx, c, `${c.session}: logged in to ${name} (${c.target})`, { session: c.session, remote });
    }
    return [relayPrompt(c, prompt, masked, remote)];
  }

  /** Terminal stream bytes from the far end: lines are printed, a prompt is relayed. */
  function onTerm(ctx: ProcessCtx, c: ClientSession, bytes: Uint8Array): Action[] {
    const out: Action[] = [];
    let lines: string[] = [];
    const flush = (): void => {
      if (lines.length > 0) out.push(print(c, lines.join('\n')));
      lines = [];
    };
    for (const ev of c.reader.feed(bytes)) {
      if (ev.kind === 'line') lines.push(ev.text);
      else if (ev.kind === 'prompt') {
        flush();
        out.push(...onPrompt(ctx, c, ev.text, ev.masked));
      }
    }
    flush();
    return out;
  }

  /** SSH bytes from the server: its identification line, then protected packets. */
  function onSsh(ctx: ProcessCtx, c: ClientSession, data: Uint8Array): Action[] {
    c.rx = vtyConcat(c.rx, data);
    const out: Action[] = [];
    if (c.phase === 'version') {
      const v = vtySshVersionLine(c.rx);
      if (v === undefined && c.rx.length <= VTY_CLIENT_VERSION_MAX) return out;
      if (v === undefined || !vtySshVersionOk(v.line)) {
        outcome(ctx, c, 'failed', 'protocol mismatch');
        debug(ctx, c, `${c.session}: ${c.target} does not speak SSH 2.0`, { session: c.session });
        c.phase = 'closing';
        return [print(c, vtyClientMismatchText(c.target)), ...done(c), ...(c.socket !== undefined ? [toTcp({ kind: 'tcp.close', socket: c.socket })] : [])];
      }
      c.rx = v.rest;
      out.push(...sendAuth(c));
    }
    const { packets, rest } = vtySshUnpack(c.rxKey, c.rx);
    c.rx = rest;
    for (const p of packets) {
      if (c.done) break;
      const type = p[0];
      const body = p.subarray(1);
      if (type === SSH_MSG_USERAUTH_SUCCESS) {
        c.phase = 'open';
        outcome(ctx, c, 'open');
        debug(ctx, c, `${c.session}: authenticated as ${c.user} on ${c.target}`, { session: c.session, user: c.user });
      } else if (type === SSH_MSG_USERAUTH_FAILURE) {
        outcome(ctx, c, 'failed', 'authentication');
        out.push(print(c, VTY_CLIENT_DENIED));
        if (c.given.password !== undefined) out.push(...sendAuth(c));
        else {
          c.phase = 'retry';
          out.push(relayPrompt(c, VTY_PROMPT_PASSWORD, true));
        }
      } else if (type === SSH_MSG_DISCONNECT) {
        const reason = vtyText(body);
        if (c.result.outcome !== 'open') outcome(ctx, c, 'failed', reason);
        if (reason !== '') out.push(print(c, reason));
      } else if (type === SSH_MSG_CHANNEL_DATA && c.phase === 'open') {
        out.push(...onTerm(ctx, c, body));
      }
    }
    return out;
  }

  // ── requests ──

  function onConnect(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'vty.connect' }>): Action[] {
    const existing = bySession.get(req.session);
    if (existing !== undefined && !existing.done) return [];
    const port = req.port ?? (req.proto === 'ssh' ? VTY_SSH_PORT : VTY_TELNET_PORT);
    const result: ResultView = { session: req.session, proto: req.proto, target: req.target, outcome: 'connecting', at: ctx.now };
    const given: { user?: string; password?: string } = {};
    if (req.user !== undefined) given.user = req.user;
    if (req.password !== undefined) given.password = req.password;
    const c: ClientSession = {
      session: req.session, proto: req.proto, target: req.target, port, user: req.user ?? '', given,
      phase: 'connecting', rx: NO_BYTES, reader: createVtyTermReader(), txKey: 0, rxKey: 0, queue: [], sending: false,
      held: false, done: false, result,
    };
    if (req.password !== undefined) c.password = req.password;
    bySession.set(c.session, c);
    const at = results.findIndex((r) => r.session === req.session);
    if (at >= 0) results.splice(at, 1);
    results.push(result);
    if (results.length > VTY_CLIENT_RESULTS) results.splice(0, results.length - VTY_CLIENT_RESULTS);
    if (c.proto === 'ssh' && c.password === undefined) {
      // SSH asks for the password before it connects (§3.14 step 3)
      c.phase = 'password';
      return [relayPrompt(c, VTY_PROMPT_PASSWORD, true)];
    }
    return connect(ctx, c);
  }

  function onInput(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'vty.input' }>): Action[] {
    const c = bySession.get(req.session);
    if (c === undefined || c.done) return [];
    switch (c.phase) {
      case 'password':
        c.password = req.line;
        return connect(ctx, c);
      case 'retry':
        c.password = req.line;
        return sendAuth(c);
      case 'open':
        return typeLine(c, req.line);
      default:
        return [];
    }
  }

  function onInterrupt(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'vty.interrupt' }>): Action[] {
    const c = bySession.get(req.session);
    if (c === undefined || c.done) return [];
    if (c.socket === undefined) {
      outcome(ctx, c, 'cancelled');
      return [print(c, VTY_CLIENT_CANCELLED), ...done(c)];
    }
    if (c.result.outcome === 'connecting') outcome(ctx, c, 'cancelled');
    else if (c.result.outcome === 'open') outcome(ctx, c, 'closed');
    debug(ctx, c, `${c.session}: closed by the local user`, { session: c.session });
    c.phase = 'closing';
    c.queue.length = 0;
    return [print(c, vtyClientClosedText(c.target)), ...done(c), toTcp({ kind: 'tcp.close', socket: c.socket })];
  }

  // ── socket events ──

  function onSocketEvent(ctx: ProcessCtx, ev: Extract<ProcessEvent, { socket: SocketId }>): Action[] {
    const c = bySocket.get(ev.socket);
    if (c === undefined) return [];
    switch (ev.kind) {
      case 'sock.connected': {
        if (c.phase !== 'connecting') return [];
        debug(ctx, c, `${c.session}: connected to ${c.target} from ${ev.localAddr}:${ev.localPort}`, { session: c.session });
        if (c.proto === 'telnet') {
          c.phase = 'open';
          return [print(c, vtyClientConnectedText(c.target))];
        }
        c.txKey = vtySshKey(ev.localAddr, ev.localPort, ev.remoteAddr, ev.remotePort);
        c.rxKey = vtySshKey(ev.remoteAddr, ev.remotePort, ev.localAddr, ev.localPort);
        c.phase = 'version';
        // the identification line in clear, then every later byte of the connection is protected
        return [toTcp({ kind: 'tcp.send', socket: ev.socket, data: vtyBytes(`${VTY_SSH_VERSION}\r\n`) }), toTcp(tcpProtectRequest(ev.socket, 'ssh'))];
      }
      case 'sock.data':
        if (c.done || c.phase === 'closing') return [];
        return c.proto === 'ssh' ? onSsh(ctx, c, ev.data) : onTerm(ctx, c, ev.data);
      case 'sock.drained':
        c.sending = false;
        return pump(c);
      case 'sock.peerClosed': {
        const out: Action[] = [];
        if (!c.done) {
          if (c.result.outcome === 'open' || c.result.outcome === 'connecting') outcome(ctx, c, 'closed');
          debug(ctx, c, `${c.session}: ${c.target} closed the connection`, { session: c.session });
          out.push(print(c, vtyClientClosedByRemoteText(c.target)), ...done(c));
        }
        c.phase = 'closing';
        out.push(toTcp({ kind: 'tcp.close', socket: ev.socket }));
        return out;
      }
      case 'sock.closed':
        return [...done(c), ...finish(c)];
      case 'sock.error': {
        const out: Action[] = [];
        if (!c.done) {
          const f = vtyClientFailure(c.target, ev.code, c.result.outcome === 'open');
          outcome(ctx, c, f.outcome, ev.code);
          debug(ctx, c, `${c.session}: ${ev.code}${ev.detail !== undefined ? ` (${ev.detail})` : ''}`, { session: c.session, code: ev.code });
          out.push(print(c, f.text), ...done(c));
        }
        return [...out, ...finish(c)];
      }
      default:
        return [];
    }
  }

  return {
    name: NAME,

    init(): Action[] {
      return [];
    },

    onPdu(): Action[] {
      return [];
    },

    onTimer(): Action[] {
      return [];
    },

    onConfig(): Action[] {
      return [];
    },

    onRequest(ctx, req): Action[] {
      switch (req.kind) {
        case 'vty.connect':
          return onConnect(ctx, req);
        case 'vty.input':
          return onInput(ctx, req);
        case 'vty.interrupt':
          return onInterrupt(ctx, req);
        default:
          return [];
      }
    },

    onEvent(ctx, ev): Action[] {
      return 'socket' in ev && typeof ev.socket === 'string' && ev.kind.startsWith('sock.')
        ? onSocketEvent(ctx, ev as Extract<ProcessEvent, { socket: SocketId }>)
        : [];
    },

    stateSnapshot(): StateView {
      const sessions = [...bySession.values()].map((c) => ({
        session: c.session,
        proto: c.proto,
        target: c.target,
        port: c.port,
        phase: c.phase,
        ...(c.remote !== undefined ? { remote: c.remote } : {}),
      }));
      return { process: NAME, state: { sessions, results: results.map((r) => ({ ...r })) } };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}
