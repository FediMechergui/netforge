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
 * A device without the vty-client daemon answers with a message instead of a job that never ends. Messages are
 * original wording (spec §1.6).
 */
import type { CommandCtx, CommandHandler, CommandOutcome } from '../../contracts/cli.js';
import type { ProcessRequest } from '../../contracts/process.js';
import { isIpv4, isIpv4Broadcast, isIpv4Multicast } from '../../contracts/addr.js';
import { REMOTE_HANDLERS, VTY_CLIENT_PROCESS } from '../grammar/remote.js';

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

/** @since P3 [S13] Registry fragment: remote terminal client handler id → handler. */
export const remoteHandlers: Readonly<Record<string, CommandHandler>> = {
  [REMOTE_HANDLERS.execTelnet]: telnet,
  [REMOTE_HANDLERS.execSsh]: ssh,
};
