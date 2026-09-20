/**
 * cli/grammar/transport.ts — what the transport layer is doing right now (ARCHITECTURE-P1 §4.5, §6 P1 table).
 *
 * One listing of the device's 'sockets' table under two names: `netstat` at a host prompt and `show ip sockets` at a
 * network-OS prompt, both through the same handler. Adding the `udp` and `tcp` debug categories here keeps every
 * transport-level switch in one fragment. Help strings are original wording (spec §1.6).
 *
 * ponytail: the familiar `netstat` option letters are accepted and ignored — the table is short enough to print
 * whole, its columns already say which rows are listeners and which are connections, and every address is already
 * numeric. `show ip sockets` keeps no options at all.
 */
import type { CommandSpec } from '../../contracts/cli.js';
import type { Capability } from '../../contracts/catalog.js';
import type { GrammarDebugCategory } from './core-exec.js';
import { capabilitiesRunning, choiceArg, debugSpecs, HOST_ONLY, NFOS_ONLY } from './core-exec.js';

/** Handler ids of the transport commands. */
export const TRANSPORT_HANDLERS = {
  showSockets: 'show.sockets',
} as const;

/** Option letters `netstat` accepts (and ignores: the listing is always the whole numeric table). */
export const NETSTAT_OPTIONS: readonly string[] = Object.freeze(['-a', '-an', '-n', '-na']);

/** Capabilities that run a transport daemon (and therefore own a 'sockets' table). */
export const TRANSPORT_CAPABILITIES: readonly Capability[] = capabilitiesRunning('udp', 'tcp');

/** Debug categories of the transport daemons. */
export const TRANSPORT_DEBUG_CATEGORIES: readonly GrammarDebugCategory[] = Object.freeze([
  { category: 'udp', help: 'Trace datagrams handed to and taken from sockets', requiresAny: capabilitiesRunning('udp'), since: 'P1' },
  { category: 'tcp', help: 'Trace connection setup, data, acknowledgements and close', requiresAny: capabilitiesRunning('tcp'), since: 'P1' },
]);

/** Objectives of the transport debug categories. */
export const TRANSPORT_DEBUG_OBJECTIVES: Readonly<Record<string, readonly string[]>> = {
  udp: ['CCNA1.14.3'],
  tcp: ['CCNA1.14.2'],
};

const H = TRANSPORT_HANDLERS;

/** The transport command table. */
export const TRANSPORT_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    path: ['netstat', '<options>'],
    mode: 'user-exec',
    privilege: 15,
    help: 'List the sockets this host has open',
    args: { options: choiceArg('Listing options; the whole table is printed either way', NETSTAT_OPTIONS, true) },
    handler: H.showSockets,
    filterable: true,
    grammars: HOST_ONLY,
    requiresAny: TRANSPORT_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.14.1'],
  },
  {
    path: ['show', 'ip', 'sockets'],
    mode: '@exec',
    privilege: 1,
    help: 'Sockets the daemons on this device have open',
    handler: H.showSockets,
    filterable: true,
    grammars: NFOS_ONLY,
    requiresAny: TRANSPORT_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.14.1'],
  },
  ...debugSpecs(TRANSPORT_DEBUG_CATEGORIES, TRANSPORT_DEBUG_OBJECTIVES),
]);
