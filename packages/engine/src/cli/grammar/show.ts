/**
 * cli/grammar/show.ts — the shared `show …` commands (spec §7.5; ARCHITECTURE "P0 CLI surface", ARCHITECTURE-P1
 * §3.13): interface summaries and counters, the ARP cache, the MAC table (devices that bridge), the IPv4 routing
 * table (devices that route), version, configurations, history and the switch-port status table.
 *
 * Feature-specific show commands live with their feature (`show controllers serial` in serial.ts, `show wireless`
 * in wireless.ts, `show inventory` in modules.ts). Every show spec is filterable (`| section|include|exclude|begin`).
 * Help strings are original wording (spec §1.6).
 */
import type { CommandSpec } from '../../contracts/cli.js';
import { BRIDGING_CAPABILITIES } from '../../contracts/catalog.js';
import { ifaceArg, NFOS_ONLY } from './core-exec.js';

/** Handler ids of the shared show commands. */
export const SHOW_HANDLERS = {
  showIpIntBrief: 'show.ip-int-brief',
  showInterfaces: 'show.interfaces',
  showArp: 'show.arp',
  showIpArp: 'show.ip-arp',
  showMac: 'show.mac',
  showIpRoute: 'show.ip-route',
  showVersion: 'show.version',
  showRunning: 'show.running',
  showStartup: 'show.startup',
  showHistory: 'show.history',
  showInterfacesStatus: 'show.interfaces-status',
} as const;

const H = SHOW_HANDLERS;

/** The shared show command table. */
export const SHOW_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    path: ['show', 'ip', 'interface', 'brief'],
    mode: '@exec',
    privilege: 1,
    help: 'One line per interface: address, admin and link state',
    filterable: true,
    handler: H.showIpIntBrief,
    objectives: ['CCNA1.10.3'],
  },
  {
    path: ['show', 'interfaces', '<iface>'],
    mode: '@exec',
    privilege: 1,
    help: 'Detailed interface state and counters',
    args: { iface: ifaceArg('Limit the output to one interface', { optional: true }) },
    filterable: true,
    handler: H.showInterfaces,
    objectives: ['CCNA1.10.3'],
  },
  {
    path: ['show', 'interfaces', 'status'],
    mode: '@exec',
    privilege: 1,
    help: 'One line per port: link state, role, duplex, speed and connector',
    filterable: true,
    handler: H.showInterfacesStatus,
    grammars: NFOS_ONLY,
    requiresAny: BRIDGING_CAPABILITIES,
    since: 'P0.5',
    objectives: ['CCNA1.4.2'],
  },
  {
    path: ['show', 'arp'],
    mode: '@exec',
    privilege: 1,
    help: 'Contents of the ARP cache',
    filterable: true,
    handler: H.showArp,
    objectives: ['CCNA1.9.2'],
  },
  {
    path: ['show', 'ip', 'arp'],
    mode: '@exec',
    privilege: 1,
    help: 'Contents of the ARP cache (IPv4)',
    filterable: true,
    handler: H.showIpArp,
    grammars: NFOS_ONLY,
    objectives: ['CCNA1.9.2'],
  },
  {
    path: ['show', 'mac', 'address-table'],
    mode: '@exec',
    privilege: 1,
    help: 'Learned and static MAC address entries',
    filterable: true,
    handler: H.showMac,
    grammars: NFOS_ONLY,
    requiresAny: BRIDGING_CAPABILITIES,
    objectives: ['CCNA1.7.2'],
  },
  {
    path: ['show', 'ip', 'route'],
    mode: '@exec',
    privilege: 1,
    help: 'The IPv4 routing table',
    filterable: true,
    handler: H.showIpRoute,
    grammars: NFOS_ONLY,
    requiresAny: ['routing'],
    objectives: ['CCNA2.1.2'],
  },
  {
    path: ['show', 'version'],
    mode: '@exec',
    privilege: 1,
    help: 'Software version, hardware model and uptime',
    filterable: true,
    handler: H.showVersion,
    objectives: ['CCNA1.2.3'],
  },
  {
    path: ['show', 'running-config'],
    mode: '@exec',
    privilege: 1,
    help: 'The active configuration',
    handler: H.showRunning,
    filterable: true,
    objectives: ['CCNA1.2.4'],
  },
  {
    path: ['show', 'startup-config'],
    mode: '@exec',
    privilege: 1,
    help: 'The saved startup configuration',
    handler: H.showStartup,
    filterable: true,
    grammars: NFOS_ONLY,
    objectives: ['CCNA1.2.4'],
  },
  {
    path: ['show', 'history'],
    mode: '@exec',
    privilege: 1,
    help: 'Commands entered in this session',
    filterable: true,
    handler: H.showHistory,
    objectives: ['CCNA1.2.3'],
  },
]);
