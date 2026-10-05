/**
 * cli/handlers/remote.ts — [S13] the remote terminal client jobs `telnet <host> [<port>]` and `ssh -l <user> [-v 2]
 * <host>` (ARCHITECTURE-P3 §5.7, §3.14, D14; §7 W2 cli, approved items).
 *
 * Each handler blocks the session with a `vty-client` job (abort `vty.interrupt`) and sends `vty.connect` to the
 * device's vty-client. From then on the runtime relays the session (cli/runtime.ts, [S13] block): the vty-client's
 * `cliRemote` actions set the remote prompt, masked input and the "R1 via SSH" chip (`setRemote`), every line typed is
 * sent as `vty.input`, and the vty-client's `cliDone` ends the job. The vty-client prints the connection progress and
 * refusals. The runtime refuses a `telnet`/`ssh` typed inside a session already `REMOTE_DEPTH_CAP` deep (D14).
 *
 * A device without the vty-client daemon answers with a message instead of a job that never ends.
 *
 * W3 cli (cli-b): `show users` (the typing console line, then the inbound connections of the vty StateView) and `show
 * ssh` (the SSH connections in, from vty, and out, from vty-client). Messages are original wording (spec §1.6).
 * W4 (ruling R43): the vty StateView's connection entries carry `since`, so `show users` adds its "Connected for" column.
 */
import type { CommandCtx, CommandHandler, CommandOutcome } from '../../contracts/cli.js';
import type { SessionId } from '../../contracts/ids.js';
import type { ProcessRequest } from '../../contracts/process.js';
import type { SimTime } from '../../contracts/time.js';
import { isIpv4, isIpv4Broadcast, isIpv4Multicast, type IpAddress } from '../../contracts/addr.js';
import { fmtDuration, table } from '../format.js';
import { REMOTE_HANDLERS, VTY_CLIENT_PROCESS, VTY_PROCESS } from '../grammar/remote.js';

/** @since P3 [S13] A device that runs no remote terminal client. */
export const MSG_NO_VTY_CLIENT = '% This device has no remote terminal client.';
/** @since P3 [S13] An address that can never be logged in to. */
export const MSG_BAD_REMOTE_TARGET = '% That address cannot be the far end of a remote session.';

/** @since P3 [S13] The job label of each protocol (the terminal's status line). */
export const REMOTE_JOB_LABELS = Object.freeze({ telnet: 'telnet', ssh: 'ssh' } as const);

/** True for an address no remote session can reach (unspecified, broadcast, multicast). */
function badTarget(host: string): boolean {
  if (isIpv4(host)) return host === '0.0.0.0' || isIpv4Broadcast(host) || isIpv4Multicast(host);
  const lower = host.toLowerCase();
  return lower === '::' || lower.startsWith('ff');
}

/** Start one client job: block the session, then ask the vty-client to connect. */
function connect(ctx: CommandCtx, req: Extract<ProcessRequest, { kind: 'vty.connect' }>): CommandOutcome {
  if (!ctx.model.processes.includes(VTY_CLIENT_PROCESS)) return { error: MSG_NO_VTY_CLIENT };
  if (badTarget(req.target)) return { error: MSG_BAD_REMOTE_TARGET };
  ctx.block({ process: VTY_CLIENT_PROCESS, abort: { kind: 'vty.interrupt', session: ctx.session.id }, label: REMOTE_JOB_LABELS[req.proto] });
  ctx.request(VTY_CLIENT_PROCESS, req);
  return {};
}

/** `telnet <host> [<port>]`. */
const telnet: CommandHandler = (ctx, args) => {
  const target = args['host'] ?? '';
  if (target === '') return { error: '% Give the address to connect to.' };
  const req: Extract<ProcessRequest, { kind: 'vty.connect' }> = { kind: 'vty.connect', session: ctx.session.id, target, proto: 'telnet' };
  const port = args['port'];
  if (port !== undefined && port !== '') req.port = Number(port);
  return connect(ctx, req);
};

/** `ssh -l <user> [-v 2] <host>`. */
const ssh: CommandHandler = (ctx, args) => {
  const target = args['host'] ?? '';
  const user = args['user'] ?? '';
  if (target === '') return { error: '% Give the address to connect to.' };
  if (user === '') return { error: '% Give the user name (-l <user>).' };
  return connect(ctx, { kind: 'vty.connect', session: ctx.session.id, target, proto: 'ssh', user });
};

// ── W3 cli (cli-b): `show users` and `show ssh` (§5.8; M10, D14 and [S13]) ────────────────────────────────────────

/**
 * @since P3 (W3 cli) [S13] One inbound connection as the cli reads it from the vty daemon's StateView: its
 * `connections` member (protocols/vty.ts header: `{ id, proto, peer, phase, user? }`), oldest first. The brief fixes no
 * shape for the vty StateView (§2.6 names the ospf, ntp, eigrp, gre and ike views only), so the reader is defensive:
 * an entry without a protocol or a peer is skipped.
 */
export interface VtyConnectionView {
  readonly id: string;
  readonly proto: 'telnet' | 'ssh';
  readonly peer: IpAddress;
  /** 'open' once the CLI session runs; the login phases before ('check', 'version', 'auth', 'user', 'password'); 'closing'. */
  readonly phase: string;
  readonly user?: string;
  /**
   * @since P3 (W4, ruling R43; additive) When the connection was accepted (sim time), so `show users` prints how long
   * it has been connected. Absent in a view that carries no start time (the column is then not shown).
   */
  readonly since?: SimTime;
}

/**
 * @since P3 (W3 cli) [S13] One outbound session as the cli reads it from the vty-client's StateView: its `sessions`
 * member (protocols/vty-client.ts header: `{ session, proto, target, port, phase, remote? }`), oldest first.
 */
export interface VtyClientSessionView {
  readonly session: SessionId;
  readonly proto: 'telnet' | 'ssh';
  readonly target: IpAddress;
  /** 'connecting', the login phases ('version', 'auth', 'password', 'retry'), 'open', 'closing'. */
  readonly phase: string;
}

/** The array member `key` of a daemon's StateView, entries narrowed to objects. */
function viewList(ctx: Pick<CommandCtx, 'processState'>, process: string, key: string): Record<string, unknown>[] {
  const list = ctx.processState(process)?.state[key];
  return Array.isArray(list) ? list.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null) : [];
}

/** A remote protocol, or undefined. */
function protoOf(v: unknown): 'telnet' | 'ssh' | undefined {
  return v === 'telnet' || v === 'ssh' ? v : undefined;
}

/** @since P3 (W3 cli) [S13] The inbound connections of the vty StateView (`VtyConnectionView`), oldest first. */
export function vtyConnections(ctx: Pick<CommandCtx, 'processState'>): VtyConnectionView[] {
  const out: VtyConnectionView[] = [];
  for (const e of viewList(ctx, VTY_PROCESS, 'connections')) {
    const proto = protoOf(e['proto']);
    const peer = e['peer'];
    if (proto === undefined || typeof peer !== 'string') continue;
    const id = typeof e['id'] === 'string' ? e['id'] : '';
    const phase = typeof e['phase'] === 'string' ? e['phase'] : 'open';
    const view: { -readonly [K in keyof VtyConnectionView]: VtyConnectionView[K] } = { id, proto, peer, phase };
    if (typeof e['user'] === 'string') view.user = e['user'];
    const since = e['since'];
    if (typeof since === 'number' && Number.isSafeInteger(since) && since >= 0) view.since = since;
    out.push(view);
  }
  return out;
}

/** @since P3 (W3 cli) [S13] The outbound sessions of the vty-client StateView (`VtyClientSessionView`), oldest first. */
export function vtyClientSessions(ctx: Pick<CommandCtx, 'processState'>): VtyClientSessionView[] {
  const out: VtyClientSessionView[] = [];
  for (const e of viewList(ctx, VTY_CLIENT_PROCESS, 'sessions')) {
    const proto = protoOf(e['proto']);
    const target = e['target'];
    const session = e['session'];
    if (proto === undefined || typeof target !== 'string' || typeof session !== 'string') continue;
    out.push({ session, proto, target, phase: typeof e['phase'] === 'string' ? e['phase'] : 'open' });
  }
  return out;
}

/** @since P3 (W3 cli) [S13] How a connection's phase reads in `show users` and `show ssh`. */
export function sessionPhaseText(phase: string): string {
  if (phase === 'open') return 'session open';
  if (phase === 'connecting') return 'connecting';
  if (phase === 'closing') return 'closing';
  return 'logging in';
}

/** @since P3 (W3 cli) `show users` with nothing to list beyond the typing session. */
export const MSG_NO_REMOTE_SESSION = 'No remote session is open.';
/** @since P3 (W3 cli) `show ssh` without an SSH connection. */
export const MSG_NO_SSH_SESSION = 'No SSH connection is open.';

/** @since P3 (W4, ruling R43) The `show users` column of how long each inbound connection has been up. */
export const SHOW_USERS_CONNECTED_FOR = 'Connected for';

/**
 * `show users` (§5.8): the typing session's console line (`*`), then one `vty <n>` line per inbound connection ([S13],
 * the vty StateView) with its user, protocol, peer and state. A typing remote session is starred when it is the only
 * open connection (the typing session must be one of them; the StateView does not name CLI sessions). W4 (ruling R43):
 * when the listed connections carry their start time (`since`), a last column says how long each has been connected
 * (`HH:MM:SS`; '-' for the console line and for an entry without a start time).
 */
const showUsers: CommandHandler = (ctx) => {
  const remote = vtyConnections(ctx);
  const open = remote.filter((c) => c.phase === 'open');
  const timed = remote.some((c) => c.since !== undefined);
  const rows: string[][] = [['', 'Line', 'User', 'Protocol', 'From', 'State', ...(timed ? [SHOW_USERS_CONNECTED_FOR] : [])]];
  if (ctx.session.via === 'console') rows.push(['*', 'con 0', '-', 'console', '-', 'session open', ...(timed ? ['-'] : [])]);
  remote.forEach((c, i) => {
    const own = ctx.session.via === 'vty' && open.length === 1 && open[0] === c;
    const connected = timed ? [c.since === undefined ? '-' : fmtDuration(ctx.now - c.since)] : [];
    rows.push([own ? '*' : '', `vty ${i}`, c.user ?? '-', c.proto, c.peer, sessionPhaseText(c.phase), ...connected]);
  });
  const out = table(rows);
  return { output: remote.length === 0 ? `${out}\n${MSG_NO_REMOTE_SESSION}` : out };
};

/**
 * `show ssh` (§5.8): every SSH connection into this device (the vty StateView, `in`) and out of it (the vty-client's,
 * `out`), with the protocol version (2.0 only), the user (inbound), the peer and the state.
 */
const showSsh: CommandHandler = (ctx) => {
  const rows: string[][] = [['Connection', 'Version', 'Direction', 'User', 'Peer', 'State']];
  for (const c of vtyConnections(ctx)) {
    if (c.proto === 'ssh') rows.push([String(rows.length - 1), '2.0', 'in', c.user ?? '-', c.peer, sessionPhaseText(c.phase)]);
  }
  for (const s of vtyClientSessions(ctx)) {
    if (s.proto === 'ssh') rows.push([String(rows.length - 1), '2.0', 'out', '-', s.target, sessionPhaseText(s.phase)]);
  }
  return { output: rows.length === 1 ? MSG_NO_SSH_SESSION : table(rows) };
};

/** @since P3 [S13] Registry fragment: remote terminal client handler id → handler. */
export const remoteHandlers: Readonly<Record<string, CommandHandler>> = {
  [REMOTE_HANDLERS.execTelnet]: telnet,
  [REMOTE_HANDLERS.execSsh]: ssh,
  [REMOTE_HANDLERS.showUsers]: showUsers,
  [REMOTE_HANDLERS.showSsh]: showSsh,
};
