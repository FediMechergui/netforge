/**
 * cli/grammar/dhcp.ts — the DHCPv4 command surface (ARCHITECTURE-P1 §4.3, §6 P1 table).
 *
 * Client side: `ip address dhcp` on an interface (the ipv4 daemon marks the port DHCP-managed and dhcp-client takes
 * over). Server side: `ip dhcp excluded-address`, the `ip dhcp pool NAME` section (mode `dhcp-config`) with
 * `network`, `default-router`, `dns-server`, `domain-name` and `lease`, plus `ip helper-address` for relaying.
 * `show ip dhcp binding` and `show ip dhcp pool` read the 'dhcp-bindings' table and the pool lines.
 *
 * Scope is data: the client lines need a capability whose daemon list holds `dhcp-client`, the server lines one that
 * holds `dhcp-server`, and both address lines need a port whose role holds L3 addresses (`L3_PORT`).
 * Help strings are original wording (spec §1.6).
 *
 * ponytail: `default-router` and `dns-server` take at most two addresses (one primary, one backup — what a CCNA lab
 * needs); `lease` takes days, hours and minutes but not the `infinite` keyword the daemon also understands.
 */
import type { CommandSpec } from '../../contracts/cli.js';
import type { Capability } from '../../contracts/catalog.js';
import type { GrammarDebugCategory } from './core-exec.js';
import {
  capabilitiesRunning,
  debugSpecs,
  intArg,
  ipv4Arg,
  L3_PORT,
  maskArg,
  nameArg,
  NFOS_ONLY,
  wordArg,
} from './core-exec.js';

/** Handler ids of the DHCP commands. */
export const DHCP_HANDLERS = {
  ifIpAddressDhcp: 'if.ip-address-dhcp',
  ifHelperAddress: 'if.ip-helper-address',
  configDhcpExcluded: 'config.ip-dhcp-excluded',
  configDhcpPool: 'config.ip-dhcp-pool',
  poolNetwork: 'dhcp.network',
  poolDefaultRouter: 'dhcp.default-router',
  poolDnsServer: 'dhcp.dns-server',
  poolDomainName: 'dhcp.domain-name',
  poolLease: 'dhcp.lease',
  showDhcpBinding: 'show.ip-dhcp-binding',
  showDhcpPool: 'show.ip-dhcp-pool',
} as const;

/** Capabilities that run the DHCP client (a leased address) and the DHCP server (pools and relaying). */
export const DHCP_CLIENT_CAPABILITIES: readonly Capability[] = capabilitiesRunning('dhcp-client');
export const DHCP_SERVER_CAPABILITIES: readonly Capability[] = capabilitiesRunning('dhcp-server');

/** Both DHCP daemons stamp their events with this one category. */
export const DHCP_DEBUG_CATEGORIES: readonly GrammarDebugCategory[] = Object.freeze([
  {
    category: 'dhcp',
    help: 'Trace address leases: discover, offer, request and acknowledge',
    requiresAny: capabilitiesRunning('dhcp-client', 'dhcp-server'),
    since: 'P1',
  },
]);

/** Objectives of the DHCP debug category. */
export const DHCP_DEBUG_OBJECTIVES: Readonly<Record<string, readonly string[]>> = { dhcp: ['CCNA1.11.2'] };

const H = DHCP_HANDLERS;

/** The DHCP command table. */
export const DHCP_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    path: ['ip', 'address', 'dhcp'],
    mode: 'config-if',
    privilege: 15,
    help: 'Ask a DHCP server for the address of this interface',
    handler: H.ifIpAddressDhcp,
    allowNo: true,
    grammars: NFOS_ONLY,
    requiresAny: DHCP_CLIENT_CAPABILITIES,
    portRequires: L3_PORT,
    since: 'P1',
    objectives: ['CCNA1.11.2'],
  },
  {
    path: ['ip', 'helper-address', '<address>'],
    mode: 'config-if',
    privilege: 15,
    help: 'Forward broadcast service requests arriving here to this server',
    args: { address: ipv4Arg('Address of the DHCP server') },
    handler: H.ifHelperAddress,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    requiresAny: DHCP_SERVER_CAPABILITIES,
    portRequires: L3_PORT,
    since: 'P1',
    objectives: ['CCNA1.11.3'],
  },
  {
    path: ['ip', 'dhcp', 'excluded-address', '<low>', '<high>'],
    mode: 'config',
    privilege: 15,
    help: 'Keep an address, or a range of them, out of every pool',
    args: { low: ipv4Arg('First address to keep back'), high: ipv4Arg('Last address of the range', true) },
    handler: H.configDhcpExcluded,
    allowNo: true,
    grammars: NFOS_ONLY,
    requiresAny: DHCP_SERVER_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.11.3'],
  },
  {
    path: ['ip', 'dhcp', 'pool', '<name>'],
    mode: 'config',
    privilege: 15,
    help: 'Create or edit a pool of addresses to lease',
    args: { name: wordArg('Pool name', { maxLength: 32, completion: 'dhcp-pools' }) },
    handler: H.configDhcpPool,
    entersMode: 'dhcp-config',
    sessionEffect: 'enter-mode',
    allowNo: true,
    grammars: NFOS_ONLY,
    requiresAny: DHCP_SERVER_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.11.3'],
  },
  {
    path: ['network', '<address>', '<mask>'],
    mode: 'dhcp-config',
    privilege: 15,
    help: 'Subnet this pool leases addresses from',
    args: { address: ipv4Arg('Network address'), mask: maskArg('Subnet mask') },
    handler: H.poolNetwork,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    since: 'P1',
    objectives: ['CCNA1.11.3'],
  },
  {
    path: ['default-router', '<first>', '<second>'],
    mode: 'dhcp-config',
    privilege: 15,
    help: 'Default gateway handed to the clients of this pool',
    args: { first: ipv4Arg('Gateway address'), second: ipv4Arg('Second gateway address', true) },
    handler: H.poolDefaultRouter,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    since: 'P1',
    objectives: ['CCNA1.11.3'],
  },
  {
    path: ['dns-server', '<first>', '<second>'],
    mode: 'dhcp-config',
    privilege: 15,
    help: 'Name servers handed to the clients of this pool',
    args: { first: ipv4Arg('Name server address'), second: ipv4Arg('Second name server address', true) },
    handler: H.poolDnsServer,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    since: 'P1',
    objectives: ['CCNA1.11.3'],
  },
  {
    path: ['domain-name', '<name>'],
    mode: 'dhcp-config',
    privilege: 15,
    help: 'Domain name handed to the clients of this pool',
    args: { name: nameArg('Domain name, e.g. lab.nf') },
    handler: H.poolDomainName,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    since: 'P1',
    objectives: ['CCNA1.11.3'],
  },
  {
    path: ['lease', '<days>', '<hours>', '<minutes>'],
    mode: 'dhcp-config',
    privilege: 15,
    help: 'How long a client may keep an address from this pool',
    args: {
      days: intArg('Days', 0, 365),
      hours: intArg('Hours', 0, 23, true),
      minutes: intArg('Minutes', 0, 59, true),
    },
    handler: H.poolLease,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    since: 'P1',
    objectives: ['CCNA1.11.3'],
  },
  {
    path: ['show', 'ip', 'dhcp', 'binding'],
    mode: '@exec',
    privilege: 1,
    help: 'Addresses this server has offered or leased',
    filterable: true,
    handler: H.showDhcpBinding,
    requiresAny: DHCP_SERVER_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.11.3'],
  },
  {
    path: ['show', 'ip', 'dhcp', 'pool', '<name>'],
    mode: '@exec',
    privilege: 1,
    help: 'Size, use and settings of the address pools',
    args: { name: wordArg('Limit the output to one pool', { optional: true, maxLength: 32, completion: 'dhcp-pools' }) },
    filterable: true,
    handler: H.showDhcpPool,
    requiresAny: DHCP_SERVER_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.11.3'],
  },
  ...debugSpecs(DHCP_DEBUG_CATEGORIES, DHCP_DEBUG_OBJECTIVES),
]);
