/**
 * cli/grammar/dhcpv6.ts — the DHCPv6 command surface (ARCHITECTURE-P2 §3.11, §5.2, §5.4, D16; §7 W3 cli).
 *
 * Server side: the `ipv6 dhcp pool <name>` section (mode `config-dhcpv6`) with `address prefix <p/len> [lifetime
 * <valid> <preferred>]` (stateful), `dns-server <a>` (several) and `domain-name <d>`; `ipv6 dhcp server <pool>` on
 * an interface, and the RA flags `ipv6 nd managed-config-flag` / `ipv6 nd other-config-flag` that make hosts ask.
 * Client side: `ipv6 address dhcp` on an interface. Shows: `show ipv6 dhcp pool|binding|interface`. [S8] relay and
 * `ipv6 nd prefix default no-autoconfig` are not built (§8.5).
 *
 * Scope: the server lines need `routing` (the W4 catalog adds dhcpv6-server to it); the client line and the RA flags
 * need a capability whose daemon list holds `ipv6` (`IPV6_CAPABILITIES`), so a switch SVI can lease too. The
 * `ipv6 dhcp` debug category (both daemons, §5.4) is declared here. Help strings are original wording (spec §1.6).
 */
import type { CommandSpec } from '../../contracts/cli.js';
import type { Capability } from '../../contracts/catalog.js';
import { capabilitiesRunning, type GrammarDebugCategory, IPV6_CAPABILITIES, ipv6Arg, L3_PORT, NFOS_ONLY, prefix6Arg, wordArg } from './core-exec.js';

/** Handler ids of the DHCPv6 fragment. Never rename. */
export const DHCPV6_HANDLERS = {
  configIpv6DhcpPool: 'config.ipv6-dhcp-pool',
  pool6AddressPrefix: 'dhcpv6.address-prefix',
  pool6DnsServer: 'dhcpv6.dns-server',
  pool6DomainName: 'dhcpv6.domain-name',
  ifIpv6DhcpServer: 'if.ipv6-dhcp-server',
  ifIpv6NdManagedFlag: 'if.ipv6-nd-managed-config-flag',
  ifIpv6NdOtherFlag: 'if.ipv6-nd-other-config-flag',
  ifIpv6AddressDhcp: 'if.ipv6-address-dhcp',
  showIpv6DhcpPool: 'show.ipv6-dhcp-pool',
  showIpv6DhcpBinding: 'show.ipv6-dhcp-binding',
  showIpv6DhcpInterface: 'show.ipv6-dhcp-interface',
} as const;

/** Capabilities that run the DHCPv6 server (the W4 catalog adds `dhcpv6-server` to `routing`). */
export const DHCPV6_SERVER_CAPABILITIES: readonly Capability[] = Object.freeze(['routing']);

/** Longest pool name. */
export const DHCPV6_POOL_NAME_MAX_LENGTH = 32;
/** Pattern of a lifetime value: seconds or `infinite`. */
export const DHCPV6_LIFETIME_PATTERN = '\\d{1,10}|infinite';

/** Debug category of both DHCPv6 daemons (§5.4, binding). */
export const DHCPV6_DEBUG_CATEGORY = 'ipv6 dhcp';

/** The DHCPv6 debug category (offered where either daemon runs, §2.1). */
export const DHCPV6_DEBUG_CATEGORIES: readonly GrammarDebugCategory[] = Object.freeze([
  { category: DHCPV6_DEBUG_CATEGORY, help: 'Trace IPv6 address leases: solicit, advertise, request, reply and information requests', requiresAny: capabilitiesRunning('dhcpv6-client', 'dhcpv6-server'), since: 'P2' },
]);

/** Objectives of the DHCPv6 debug category. */
export const DHCPV6_DEBUG_OBJECTIVES: Readonly<Record<string, readonly string[]>> = { [DHCPV6_DEBUG_CATEGORY]: ['CCNA2.10.1'] };

const H = DHCPV6_HANDLERS;

const POOL_LINE = {
  mode: 'config-dhcpv6',
  privilege: 15,
  allowNo: true,
  grammars: NFOS_ONLY,
  requiresAny: DHCPV6_SERVER_CAPABILITIES,
  since: 'P2',
  objectives: ['CCNA2.10.1'],
} as const;

const SHOW_LINE = {
  mode: '@exec',
  privilege: 1,
  filterable: true,
  grammars: NFOS_ONLY,
  since: 'P2',
} as const;

const LIFETIME_ARG = (help: string) => wordArg(help, { pattern: DHCPV6_LIFETIME_PATTERN });

/** The DHCPv6 command table. */
export const DHCPV6_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    path: ['ipv6', 'dhcp', 'pool', '<name>'],
    mode: 'config',
    privilege: 15,
    help: 'Create or edit a pool of IPv6 settings (and optionally addresses) to lease',
    args: { name: wordArg('Pool name', { maxLength: DHCPV6_POOL_NAME_MAX_LENGTH }) },
    handler: H.configIpv6DhcpPool,
    entersMode: 'config-dhcpv6',
    sessionEffect: 'enter-mode',
    allowNo: true,
    grammars: NFOS_ONLY,
    requiresAny: DHCPV6_SERVER_CAPABILITIES,
    since: 'P2',
    objectives: ['CCNA2.10.1'],
  },
  {
    ...POOL_LINE,
    path: ['address', 'prefix', '<prefix>'],
    help: 'Lease addresses from this prefix (stateful DHCPv6)',
    args: { prefix: prefix6Arg('Prefix the leased addresses come from') },
    handler: H.pool6AddressPrefix,
    noArgsOptional: true,
  },
  {
    ...POOL_LINE,
    path: ['address', 'prefix', '<prefix>', 'lifetime', '<valid>', '<preferred>'],
    help: 'Lease addresses from this prefix with these valid and preferred lifetimes (seconds or infinite)',
    args: {
      prefix: prefix6Arg('Prefix the leased addresses come from'),
      valid: LIFETIME_ARG('Valid lifetime in seconds, or infinite'),
      preferred: LIFETIME_ARG('Preferred lifetime in seconds, or infinite'),
    },
    handler: H.pool6AddressPrefix,
  },
  {
    ...POOL_LINE,
    path: ['dns-server', '<address>'],
    help: 'A name server to hand out (repeat for several)',
    args: { address: ipv6Arg('IPv6 address of the name server') },
    handler: H.pool6DnsServer,
    noArgsOptional: true,
  },
  {
    ...POOL_LINE,
    path: ['domain-name', '<name>'],
    help: 'The domain name to hand out',
    args: { name: wordArg('Domain name', { maxLength: 253 }) },
    handler: H.pool6DomainName,
    noArgsOptional: true,
  },
  {
    path: ['ipv6', 'dhcp', 'server', '<pool>'],
    mode: 'config-if',
    privilege: 15,
    help: 'Answer DHCPv6 requests on this interface from this pool',
    args: { pool: wordArg('Pool name', { maxLength: DHCPV6_POOL_NAME_MAX_LENGTH }) },
    handler: H.ifIpv6DhcpServer,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    requiresAny: DHCPV6_SERVER_CAPABILITIES,
    portRequires: L3_PORT,
    since: 'P2',
    objectives: ['CCNA2.10.1'],
  },
  {
    path: ['ipv6', 'nd', 'managed-config-flag'],
    mode: 'config-if',
    privilege: 15,
    help: 'Tell hosts in router advertisements to get their address from DHCPv6 (stateful)',
    handler: H.ifIpv6NdManagedFlag,
    allowNo: true,
    grammars: NFOS_ONLY,
    requiresAny: IPV6_CAPABILITIES,
    portRequires: L3_PORT,
    since: 'P2',
    objectives: ['CCNA2.10.1'],
  },
  {
    path: ['ipv6', 'nd', 'other-config-flag'],
    mode: 'config-if',
    privilege: 15,
    help: 'Tell hosts in router advertisements to get other settings, such as name servers, from DHCPv6 (stateless)',
    handler: H.ifIpv6NdOtherFlag,
    allowNo: true,
    grammars: NFOS_ONLY,
    requiresAny: IPV6_CAPABILITIES,
    portRequires: L3_PORT,
    since: 'P2',
    objectives: ['CCNA2.10.1'],
  },
  {
    path: ['ipv6', 'address', 'dhcp'],
    mode: 'config-if',
    privilege: 15,
    help: 'Ask a DHCPv6 server for the IPv6 address of this interface',
    handler: H.ifIpv6AddressDhcp,
    allowNo: true,
    grammars: NFOS_ONLY,
    requiresAny: IPV6_CAPABILITIES,
    portRequires: L3_PORT,
    since: 'P2',
    objectives: ['CCNA2.10.2'],
  },
  {
    ...SHOW_LINE,
    path: ['show', 'ipv6', 'dhcp', 'pool'],
    help: 'Every DHCPv6 pool: prefix, lifetimes, name servers, domain and the interfaces that serve it',
    handler: H.showIpv6DhcpPool,
    requiresAny: DHCPV6_SERVER_CAPABILITIES,
    objectives: ['CCNA2.10.1'],
  },
  {
    ...SHOW_LINE,
    path: ['show', 'ipv6', 'dhcp', 'binding'],
    help: 'Every address leased by this device: client identifier, pool and lifetimes',
    handler: H.showIpv6DhcpBinding,
    requiresAny: DHCPV6_SERVER_CAPABILITIES,
    objectives: ['CCNA2.10.1'],
  },
  {
    ...SHOW_LINE,
    path: ['show', 'ipv6', 'dhcp', 'interface'],
    help: 'Every interface with a DHCPv6 role: server pool, client lease, RA flags',
    handler: H.showIpv6DhcpInterface,
    requiresAny: IPV6_CAPABILITIES,
    objectives: ['CCNA2.10.1'],
  },
]);
