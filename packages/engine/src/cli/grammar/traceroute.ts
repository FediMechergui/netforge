/**
 * cli/grammar/traceroute.ts — the host form of the path trace (ARCHITECTURE-P1 §4.7, §9.2 "PC cannot traceroute").
 *
 * The network-OS form (`traceroute`, UDP probes) is a core EXEC command; this fragment adds the host form
 * (`tracert`, echo probes) and the `traceroute` debug category. Both share `exec.traceroute`, which reads the probe
 * mode from `fixedArgs` and starts the same `trace.start` job. Help strings are original wording (spec §1.6).
 */
import type { CommandSpec } from '../../contracts/cli.js';
import type { Capability } from '../../contracts/catalog.js';
import type { GrammarDebugCategory } from './core-exec.js';
import { capabilitiesRunning, CORE_EXEC_HANDLERS, debugSpecs, hostArg, HOST_ONLY, TRACE_MODE_ARG, TRACE_MODE_ICMP } from './core-exec.js';

/** Capabilities that run the traceroute daemon. */
export const TRACEROUTE_CAPABILITIES: readonly Capability[] = capabilitiesRunning('traceroute');

/** Debug category of the traceroute daemon. */
export const TRACEROUTE_DEBUG_CATEGORIES: readonly GrammarDebugCategory[] = Object.freeze([
  { category: 'traceroute', help: 'Trace the probes and answers of a path trace', requiresAny: TRACEROUTE_CAPABILITIES, since: 'P1' },
]);

/** Objectives of the traceroute debug category. */
export const TRACEROUTE_DEBUG_OBJECTIVES: Readonly<Record<string, readonly string[]>> = { traceroute: ['CCNA1.10.4'] };

/** The traceroute command table. */
export const TRACEROUTE_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    path: ['tracert', '<target>'],
    mode: 'user-exec',
    privilege: 15,
    help: 'Trace the path to a host',
    args: { target: hostArg('Address or name of the host to reach') },
    handler: CORE_EXEC_HANDLERS.execTraceroute,
    job: true,
    fixedArgs: { [TRACE_MODE_ARG]: TRACE_MODE_ICMP },
    grammars: HOST_ONLY,
    since: 'P1',
    objectives: ['CCNA1.10.4'],
  },
  ...debugSpecs(TRACEROUTE_DEBUG_CATEGORIES, TRACEROUTE_DEBUG_OBJECTIVES),
]);
