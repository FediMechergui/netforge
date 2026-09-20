/**
 * cli/handlers/traceroute.ts — the path-trace job behind `traceroute` and `tracert` (ARCHITECTURE-P1 §4.7).
 *
 * One handler for both names: the grammar supplies the probe mode through `fixedArgs` (`udp` for the network-OS
 * `traceroute`, `icmp` for the host `tracert`), the handler blocks the session with
 * `{process:'traceroute', abort:{kind:'job.abort', session}, label}` and then asks the daemon for
 * `trace.start {session, target, mode}`. Blocking BEFORE the request matters: a job that fails at once (no route,
 * no such name) answers with `cliDone` during the request, and the flag must be cleared by that answer rather than
 * set after it.
 *
 * The daemon prints every line of the trace itself, so the handler returns no output; ^C reaches it as `job.abort`
 * and it prints the partial footer.
 */
import type { CommandHandler } from '../../contracts/cli.js';
import { HANDLERS, TRACE_MODE_ARG, TRACE_MODE_ICMP, TRACE_MODE_UDP } from '../grammar/index.js';

/** Name of the daemon that owns the trace job. */
export const TRACEROUTE_PROCESS = 'traceroute';
/** Terminal label of the trace job. */
export const TRACEROUTE_JOB_LABEL = 'trace';

/**
 * Message for a trace on a device that runs no traceroute daemon. It may not blame the IP stack: at P1 an L2
 * switch, a bridge and an AP all boot arp/ipv4/icmpv4/host and can ping from their management SVI — only the
 * path-trace daemon is missing there.
 */
export const MSG_NO_TRACEROUTE = '% This device cannot trace a path: it runs no path-trace service.';

/** `traceroute <target>` (UDP probes) and `tracert <target>` (echo probes). */
const traceroute: CommandHandler = (ctx, args) => {
  const target = (args['target'] ?? '').trim();
  if (target === '') return { error: '% Give the address or name of the host to reach.' };
  if (ctx.processState(TRACEROUTE_PROCESS) === undefined) return { error: MSG_NO_TRACEROUTE };
  const mode = args[TRACE_MODE_ARG] === TRACE_MODE_ICMP ? TRACE_MODE_ICMP : TRACE_MODE_UDP;
  ctx.block({ process: TRACEROUTE_PROCESS, abort: { kind: 'job.abort', session: ctx.session.id }, label: TRACEROUTE_JOB_LABEL });
  ctx.request(TRACEROUTE_PROCESS, { kind: 'trace.start', session: ctx.session.id, target, mode });
  return {};
};

/** Registry fragment for the CLI runtime: the trace handler id → handler. */
export const tracerouteHandlers: Readonly<Record<string, CommandHandler>> = {
  [HANDLERS.execTraceroute]: traceroute,
};
