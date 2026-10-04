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
 *
 * W3 cli (cli-b, §5.8): `show users` and `show ssh` (routers and managed switches, D14) and the `ip ssh` / `telnet` debug
 * categories.
 */
import type { CommandSpec } from '../../contracts/cli.js';
import type { Capability } from '../../contracts/catalog.js';
import { choiceArg, debugSpecs, HOST_ONLY, intArg, ipArg, NFOS_ONLY, wordArg, type GrammarDebugCategory } from './core-exec.js';

/** @since P3 [S13] Handler ids of the remote terminal client. Never rename. */
export const REMOTE_HANDLERS = {
  execTelnet: 'exec.telnet',
  execSsh: 'exec.ssh',
  // W3 cli (cli-b): the sessions' shows (§5.8; M10 and [S13])
  showUsers: 'show.users',
  showSsh: 'show.ssh',
} as const;

/** @since P3 (W3 cli) [S13] The daemon that serves remote sessions (its StateView lists them for `show users`). */
export const VTY_PROCESS = 'vty';

/**
 * @since P3 (W3 cli) Capabilities offered `show users` and `show ssh`: the device-access scope of D14 (routers and
 * managed switches, the SSH lines' `SSH_CAPABILITIES`).
 */
export const SESSION_SHOW_CAPABILITIES: readonly Capability[] = Object.freeze(['routing', 'managed-switch'] as Capability[]);

/** @since P3 [S13] The daemon that owns the client jobs. */
export const VTY_CLIENT_PROCESS = 'vty-client';

/** @since P3 [S13] Most nested remote sessions (D14): a session at this depth cannot open another. */
export const REMOTE_DEPTH_CAP = 4;

/** @since P3 [S13] Capabilities whose network OS runs the vty-client (§2.1 rows). */
export const REMOTE_CLIENT_CAPABILITIES: readonly Capability[] = Object.freeze(['routing', 'managed-switch'] as Capability[]);
/** @since P3 [S13] Capabilities whose host shell runs the vty-client (§2.1 rows). */
export const REMOTE_HOST_CAPABILITIES: readonly Capability[] = Object.freeze(['host'] as Capability[]);

/**
 * @since P3 (W3 cli) [S13] The debug categories of the remote terminal (§5.8): `ip ssh` and `telnet`, written by vty and
 * vty-client. Scoped by capability literals like the rest of the P3 grammar: the network OS of the vty rows of §2.1
 * (the host shell has no `debug`).
 */
export const REMOTE_DEBUG_CATEGORIES: readonly GrammarDebugCategory[] = Object.freeze([
  { category: 'ip ssh', help: 'Trace SSH connections, logins and refusals', requiresAny: REMOTE_CLIENT_CAPABILITIES, since: 'P3' },
  { category: 'telnet', help: 'Trace Telnet connections, logins and refusals', requiresAny: REMOTE_CLIENT_CAPABILITIES, since: 'P3' },
]);

/** @since P3 (W3 cli) Objectives of the remote terminal's debug categories. */
export const REMOTE_DEBUG_OBJECTIVES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'ip ssh': ['CCNA3.hardening.1'],
  telnet: ['CCNA3.hardening.1'],
});

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
export const REMOTE_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  ...clientSpecs('nfos'),
  ...clientSpecs('host'),
  // ── W3 cli (cli-b): the sessions' shows and the debug categories (§5.8) ──
  {
    path: ['show', 'users'],
    mode: '@exec',
    privilege: 1,
    help: 'Terminal sessions on this device: the console and every remote login',
    handler: H.showUsers,
    filterable: true,
    grammars: NFOS_ONLY,
    requiresAny: SESSION_SHOW_CAPABILITIES,
    since: 'P3',
    objectives: ['CCNA3.hardening.1', 'CCNA3.security.4'],
  },
  {
    path: ['show', 'ssh'],
    mode: '@exec',
    privilege: 1,
    help: 'SSH connections into and out of this device',
    handler: H.showSsh,
    filterable: true,
    grammars: NFOS_ONLY,
    requiresAny: SESSION_SHOW_CAPABILITIES,
    since: 'P3',
    objectives: ['CCNA3.hardening.1'],
  },
  ...debugSpecs(REMOTE_DEBUG_CATEGORIES, REMOTE_DEBUG_OBJECTIVES),
]);
