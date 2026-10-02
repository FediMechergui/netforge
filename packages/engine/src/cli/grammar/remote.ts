/**
 * cli/grammar/remote.ts — [S13] the remote terminal client: `telnet <host> [<port>]` and `ssh -l <user> [-v 2] <host>`
 * on routers, switches and host shells (ARCHITECTURE-P3 §5.7, §3.14, D14; §7 W2 cli, approved items).
 *
 * Both are jobs of the `vty-client` daemon (`vty.connect`): the session is busy while the connection is being made,
 * then every line typed is sent to the remote device (`vty.input`) until the remote session ends (the vty-client's
 * `cliDone`). Ctrl+C sends `vty.interrupt`. The nesting depth is capped at `REMOTE_DEPTH_CAP` sessions (the runtime
 * refuses a further `telnet`/`ssh` typed inside the deepest one). A switch may open a client session even while its
 * transport is dormant (ruling R17: the outbound session wakes it; D22).
 *
 * Scope: the `vty-client` rows of §2.1 — `routing` and `managed-switch` for the network OS, `host` for the host shell.
 * The target is an address (the `vty.connect` contract carries an `IpAddress`). Help strings are original wording.
 */
import type { CommandSpec } from '../../contracts/cli.js';
import type { Capability } from '../../contracts/catalog.js';
import { choiceArg, HOST_ONLY, intArg, ipArg, NFOS_ONLY, wordArg } from './core-exec.js';

/** @since P3 [S13] Handler ids of the remote terminal client. Never rename. */
export const REMOTE_HANDLERS = {
  execTelnet: 'exec.telnet',
  execSsh: 'exec.ssh',
} as const;

/** @since P3 [S13] The daemon that owns the client jobs. */
export const VTY_CLIENT_PROCESS = 'vty-client';

/** @since P3 [S13] Most nested remote sessions (D14): a session at this depth cannot open another. */
export const REMOTE_DEPTH_CAP = 4;

/** @since P3 [S13] Capabilities whose network OS runs the vty-client (§2.1 rows). */
export const REMOTE_CLIENT_CAPABILITIES: readonly Capability[] = Object.freeze(['routing', 'managed-switch'] as Capability[]);
/** @since P3 [S13] Capabilities whose host shell runs the vty-client (§2.1 rows). */
export const REMOTE_HOST_CAPABILITIES: readonly Capability[] = Object.freeze(['host'] as Capability[]);

const H = REMOTE_HANDLERS;

const TARGET = ipArg('Address of the device to log in to');
const PORT = intArg('TCP port (23 when left out)', 1, 65535, true);
const USER = wordArg('User name to log in with', { maxLength: 32 });
const VERSION = choiceArg('Protocol version (only 2 is offered)', ['2']);

/** The three client specs of one shell. */
function clientSpecs(shell: 'nfos' | 'host'): CommandSpec[] {
  const scope =
    shell === 'nfos'
      ? ({ mode: '@exec', privilege: 1, grammars: NFOS_ONLY, requiresAny: REMOTE_CLIENT_CAPABILITIES } as const)
      : ({ mode: 'user-exec', privilege: 15, grammars: HOST_ONLY, requiresAny: REMOTE_HOST_CAPABILITIES } as const);
  return [
    {
      ...scope,
      path: ['telnet', '<host>', '<port>'],
      help: 'Log in to another device over Telnet (everything travels in the clear)',
      args: { host: TARGET, port: PORT },
      handler: H.execTelnet,
      job: true,
      since: 'P3',
      objectives: ['CCNA3.hardening.1'],
    },
    {
      ...scope,
      path: ['ssh', '-l', '<user>', '<host>'],
      help: 'Log in to another device over SSH (the session is encrypted)',
      args: { user: USER, host: TARGET },
      handler: H.execSsh,
      job: true,
      since: 'P3',
      objectives: ['CCNA3.hardening.1'],
    },
    {
      ...scope,
      path: ['ssh', '-l', '<user>', '-v', '<version>', '<host>'],
      help: 'Log in to another device over SSH with an explicit protocol version',
      args: { user: USER, version: VERSION, host: TARGET },
      handler: H.execSsh,
      job: true,
      since: 'P3',
      objectives: ['CCNA3.hardening.1'],
    },
  ];
}

/** @since P3 [S13] The remote terminal client command table (network OS first, then the host shell). */
export const REMOTE_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([...clientSpecs('nfos'), ...clientSpecs('host')]);
