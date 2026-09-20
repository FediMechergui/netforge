/**
 * cli/grammar/ipv6.ts — the IPv6 command surface (ARCHITECTURE-P1 §4.6, §6 P1 table).
 *
 * Interface lines (`ipv6 enable`, `ipv6 address X/len [eui-64|link-local]`, `ipv6 address autoconfig`,
 * `ipv6 nd suppress-ra`), the global switches (`ipv6 unicast-routing`, `ipv6 route`), the IPv6 show commands and the
 * IPv6 form of `ping`. Scope is data: every spec requires a capability whose daemon list holds the `ipv6` process
 * (`IPV6_CAPABILITIES`), and the address lines require a port whose role holds L3 addresses (`L3_PORT`), so a
 * switched port answers with the "enter no switchport first" wording and a Vlan interface accepts them.
 *
 * `ping <X:X::X>` is a second `ping` spec next to the IPv4 one: the address type decides which matches, and `?`
 * shows both placeholders under the one `ping` keyword. Help strings are original wording (spec §1.6).
 *
 * ponytail: one `ipv6 address` spec with an optional `eui-64|link-local` tail instead of three; `ipv6 route` takes
 * an address or an exit interface plus an optional next hop, validated in the handler rather than in the grammar.
 */
import type { CommandSpec } from '../../contracts/cli.js';
import type { GrammarDebugCategory } from './core-exec.js';
import {
  choiceArg,
  debugSpecs,
  ifaceArg,
  IPV6_CAPABILITIES,
  ipv6Arg,
  L3_PORT,
  NFOS_ONLY,
  prefix6Arg,
  wordArg,
} from './core-exec.js';

/** Handler ids of the IPv6 commands. */
export const IPV6_HANDLERS = {
  ifIpv6Enable: 'if.ipv6-enable',
  ifIpv6Address: 'if.ipv6-address',
  ifIpv6Autoconfig: 'if.ipv6-autoconfig',
  ifIpv6SuppressRa: 'if.ipv6-nd-suppress-ra',
  configIpv6UnicastRouting: 'config.ipv6-unicast-routing',
  configIpv6Route: 'config.ipv6-route',
  showIpv6IntBrief: 'show.ipv6-int-brief',
  showIpv6Interface: 'show.ipv6-interface',
  showIpv6Route: 'show.ipv6-route',
  showIpv6Neighbors: 'show.ipv6-neighbors',
  execPing6: 'exec.ping6',
} as const;

/** Debug categories of the IPv6 daemons (the category strings the daemons stamp on their events). */
export const IPV6_DEBUG_CATEGORIES: readonly GrammarDebugCategory[] = Object.freeze([
  { category: 'ipv6 packet', help: 'Trace IPv6 packets received, forwarded and dropped', requiresAny: IPV6_CAPABILITIES, since: 'P1' },
  { category: 'ipv6 routing', help: 'Trace IPv6 routing table changes and lookups', requiresAny: IPV6_CAPABILITIES, since: 'P1' },
  { category: 'ipv6 nd', help: 'Trace neighbour discovery, router advertisements and duplicate address detection', requiresAny: IPV6_CAPABILITIES, since: 'P1' },
  { category: 'ipv6 icmp', help: 'Trace ICMPv6 messages sent and received', requiresAny: IPV6_CAPABILITIES, since: 'P1' },
]);

/** Objectives of the IPv6 debug categories. */
export const IPV6_DEBUG_OBJECTIVES: Readonly<Record<string, readonly string[]>> = {
  'ipv6 packet': ['CCNA1.12.1'],
  'ipv6 routing': ['CCNA1.12.3'],
  'ipv6 nd': ['CCNA1.12.4'],
  'ipv6 icmp': ['CCNA1.12.4'],
};

const H = IPV6_HANDLERS;

/** The IPv6 command table. */
export const IPV6_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    path: ['ipv6', 'enable'],
    mode: 'config-if',
    privilege: 15,
    help: 'Turn IPv6 on for this interface and give it a link-local address',
    handler: H.ifIpv6Enable,
    allowNo: true,
    grammars: NFOS_ONLY,
    requiresAny: IPV6_CAPABILITIES,
    portRequires: L3_PORT,
    since: 'P1',
    objectives: ['CCNA1.12.2'],
  },
  {
    path: ['ipv6', 'address', '<prefix>', '<kind>'],
    mode: 'config-if',
    privilege: 15,
    help: 'Add an IPv6 address to this interface',
    args: {
      prefix: prefix6Arg('IPv6 address with its prefix length'),
      kind: choiceArg('eui-64 builds the host part from the hardware address; link-local marks a fe80:: address', ['eui-64', 'link-local'], true),
    },
    handler: H.ifIpv6Address,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    requiresAny: IPV6_CAPABILITIES,
    portRequires: L3_PORT,
    since: 'P1',
    objectives: ['CCNA1.12.2'],
  },
  {
    path: ['ipv6', 'address', 'autoconfig'],
    mode: 'config-if',
    privilege: 15,
    help: 'Build the address from the prefix a router advertises',
    handler: H.ifIpv6Autoconfig,
    allowNo: true,
    grammars: NFOS_ONLY,
    requiresAny: IPV6_CAPABILITIES,
    portRequires: L3_PORT,
    since: 'P1',
    objectives: ['CCNA1.12.4'],
  },
  {
    path: ['ipv6', 'nd', 'suppress-ra'],
    mode: 'config-if',
    privilege: 15,
    help: 'Stop sending router advertisements on this interface',
    handler: H.ifIpv6SuppressRa,
    allowNo: true,
    grammars: NFOS_ONLY,
    requiresAny: IPV6_CAPABILITIES,
    portRequires: L3_PORT,
    since: 'P1',
    objectives: ['CCNA1.12.4'],
  },
  {
    path: ['ipv6', 'unicast-routing'],
    mode: 'config',
    privilege: 15,
    help: 'Forward IPv6 packets between interfaces and advertise prefixes',
    handler: H.configIpv6UnicastRouting,
    allowNo: true,
    grammars: NFOS_ONLY,
    requiresAny: ['routing'],
    since: 'P1',
    objectives: ['CCNA1.12.3'],
  },
  {
    path: ['ipv6', 'route', '<prefix>', '<nexthop>', '<via>'],
    mode: 'config',
    privilege: 15,
    help: 'Add a static IPv6 route',
    args: {
      prefix: prefix6Arg('Destination prefix'),
      nexthop: wordArg('Next-hop address (X:X:X:X::X) or exit interface'),
      via: ipv6Arg('Next-hop address, when the previous value is an exit interface', true),
    },
    handler: H.configIpv6Route,
    allowNo: true,
    grammars: NFOS_ONLY,
    requiresAny: ['routing'],
    since: 'P1',
    objectives: ['CCNA2.1.3'],
  },
  {
    path: ['show', 'ipv6', 'interface', 'brief'],
    mode: '@exec',
    privilege: 1,
    help: 'One line per interface: IPv6 addresses, admin and link state',
    filterable: true,
    handler: H.showIpv6IntBrief,
    grammars: NFOS_ONLY,
    requiresAny: IPV6_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.12.2'],
  },
  {
    path: ['show', 'ipv6', 'interface', '<iface>'],
    mode: '@exec',
    privilege: 1,
    help: 'IPv6 addresses, link-local address and joined groups per interface',
    args: { iface: ifaceArg('Limit the output to one interface', { optional: true }) },
    filterable: true,
    handler: H.showIpv6Interface,
    grammars: NFOS_ONLY,
    requiresAny: IPV6_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.12.2'],
  },
  {
    path: ['show', 'ipv6', 'route'],
    mode: '@exec',
    privilege: 1,
    help: 'The IPv6 routing table',
    filterable: true,
    handler: H.showIpv6Route,
    grammars: NFOS_ONLY,
    requiresAny: IPV6_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.12.3'],
  },
  {
    path: ['show', 'ipv6', 'neighbors'],
    mode: '@exec',
    privilege: 1,
    help: 'The IPv6 neighbour cache',
    filterable: true,
    handler: H.showIpv6Neighbors,
    grammars: NFOS_ONLY,
    requiresAny: IPV6_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.12.4'],
  },
  {
    path: ['ping', '<target>'],
    mode: '@exec',
    privilege: 1,
    help: 'Send echo requests to a host',
    args: { target: ipv6Arg('IPv6 address of the host to reach') },
    handler: H.execPing6,
    job: true,
    requiresAny: IPV6_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.12.4'],
  },
  {
    path: ['ping', '-6', '<target>'],
    mode: 'user-exec',
    privilege: 15,
    help: 'Send echo requests to an IPv6 host',
    args: { target: ipv6Arg('IPv6 address of the host to reach') },
    handler: H.execPing6,
    job: true,
    hidden: true,
    grammars: ['host'],
    requiresAny: IPV6_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.12.4'],
  },
  ...debugSpecs(IPV6_DEBUG_CATEGORIES, IPV6_DEBUG_OBJECTIVES),
]);
