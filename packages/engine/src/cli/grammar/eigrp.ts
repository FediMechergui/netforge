/**
 * cli/grammar/eigrp.ts — [C1] EIGRP configuration lines (ARCHITECTURE-P3 §2.16, §5.1, D26; §7 W2 cli, approved items).
 *
 * Global `router eigrp <1-65535>` enters mode `config-router-eigrp` (prompt `(config-router)#`, context entry
 * `['router', 'eigrp', <as>]`); inside it: `network <a> [<wildcard>]`, `eigrp router-id <a>`, `passive-interface <if>`
 * and `passive-interface default`, `metric weights 0 <k1> <k2> <k3> <k4> <k5>`, `maximum-paths <1-4>` and
 * `no auto-summary` (accepted, never stored: it is the default; the positive form is refused with
 * `CLI_MESSAGES.eigrpAutoSummary`). Interface lines: `delay <1-16777215>` (tens of microseconds),
 * `ip hello-interval eigrp <as> <1-65535>` and `ip hold-time eigrp <as> <1-65535>`; `bandwidth` is the existing line.
 *
 * Scope: the `routing` capability (the [C1] `eigrp` daemon row of §2.1). `delay` exists on routed Ethernet ports,
 * serial lines, subinterfaces and tunnels (not on VLAN interfaces, whose help list stays unchanged, §9.2 item 21);
 * the two `ip … eigrp` lines on every interface that holds an address. Help strings are original wording (spec §1.6).
 *
 * W3 cli (cli-b, §2.16, §5.8): `show ip eigrp neighbors [<if>]`, `show ip eigrp topology [all-links | <prefix>]`, `show ip
 * eigrp interfaces`, `show ip route eigrp` (the shared route handler on source 'EIGRP'), `clear ip eigrp neighbors
 * [<address>]` and the `eigrp packets` / `eigrp fsm` debug categories.
 */
import type { CommandSpec } from '../../contracts/cli.js';
import { L3_ROLES, type PortRole } from '../../contracts/catalog.js';
import { debugSpecs, ifaceArg, intArg, ipv4Arg, NFOS_ONLY, type GrammarDebugCategory } from './core-exec.js';
import { ROUTE_SOURCE_ARG, SHOW_HANDLERS } from './show.js';

/** @since P3 [C1] Handler ids of the EIGRP fragment. Never rename. */
export const EIGRP_HANDLERS = {
  configRouterEigrp: 'config.router-eigrp',
  eigrpNetwork: 'eigrp.network',
  eigrpRouterId: 'eigrp.router-id',
  eigrpPassiveInterface: 'eigrp.passive-interface',
  eigrpPassiveDefault: 'eigrp.passive-interface-default',
  eigrpMetricWeights: 'eigrp.metric-weights',
  eigrpMaximumPaths: 'eigrp.maximum-paths',
  eigrpAutoSummary: 'eigrp.auto-summary',
  ifDelay: 'if.delay',
  ifIpHelloEigrp: 'if.ip-hello-interval-eigrp',
  ifIpHoldEigrp: 'if.ip-hold-time-eigrp',
  // W3 cli (cli-b): the shows and the clear of §2.16 / §5.8
  showIpEigrpNeighbors: 'show.ip-eigrp-neighbors',
  showIpEigrpTopology: 'show.ip-eigrp-topology',
  showIpEigrpInterfaces: 'show.ip-eigrp-interfaces',
  execClearIpEigrpNeighbors: 'exec.clear-ip-eigrp-neighbors',
} as const;

/** @since P3 [C1] The mode `router eigrp` enters (contracts/cli.ts MODES). */
export const EIGRP_MODE = 'config-router-eigrp';

/** @since P3 [C1] Highest EIGRP autonomous system number. */
export const EIGRP_AS_MAX = 65535;
/** @since P3 [C1] Highest interface delay, in tens of microseconds. */
export const EIGRP_DELAY_MAX = 16_777_215;
/** @since P3 [C1] Most equal-cost paths one destination installs. */
export const EIGRP_MAX_PATHS = 4;

/** @since P3 [C1] Roles whose ports take `delay`: routed Ethernet, serial, subinterfaces and tunnels (no SVIs). */
export const DELAY_ROLES: readonly PortRole[] = Object.freeze(['routed', 'wan', 'subif', 'tunnel'] as PortRole[]);

/** @since P3 [C1] Mismatch of `delay` typed on another kind of port. */
export const MSG_DELAY_PORT = '% The delay applies to routed, serial, subinterface and tunnel interfaces.';

/** @since P3 (W3 cli) [C1] The machine source of an EIGRP route (`RouteRow.source`, D11): `show ip route eigrp` filters on it. */
export const EIGRP_ROUTE_SOURCE = 'EIGRP';

/** @since P3 (W3 cli) [C1] Arg name (`fixedArgs`) naming the view of `show ip eigrp topology all-links`. */
export const EIGRP_TOPOLOGY_VIEW_ARG = 'view';
/** @since P3 (W3 cli) [C1] The value of EIGRP_TOPOLOGY_VIEW_ARG that also lists the paths failing the feasibility condition. */
export const EIGRP_TOPOLOGY_ALL_LINKS = 'all-links';

/**
 * @since P3 (W3 cli) [C1] The debug categories of the eigrp daemon (§5.8): `eigrp packets` (one line per packet sent or
 * received) and `eigrp fsm` (neighbour changes and DUAL). Scoped by capability literals like the rest of the P3
 * grammar: `routing`, the eigrp row of §2.1.
 */
export const EIGRP_DEBUG_CATEGORIES: readonly GrammarDebugCategory[] = Object.freeze([
  { category: 'eigrp packets', help: 'Trace every EIGRP packet sent or received', requiresAny: ['routing'], since: 'P3' },
  { category: 'eigrp fsm', help: 'Trace EIGRP neighbour changes and DUAL route computations', requiresAny: ['routing'], since: 'P3' },
]);

/** @since P3 (W3 cli) Objectives of the EIGRP debug categories. */
export const EIGRP_DEBUG_OBJECTIVES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'eigrp packets': ['CCNA3.eigrp.1'],
  'eigrp fsm': ['CCNA3.eigrp.2', 'CCNA3.eigrp.4'],
});

const H = EIGRP_HANDLERS;

const AS_ARG = intArg('Autonomous system number', 1, EIGRP_AS_MAX);

/** Shared fields of the lines inside `router eigrp`. */
const PROCESS_LINE = {
  mode: EIGRP_MODE,
  privilege: 15,
  allowNo: true,
  grammars: NFOS_ONLY,
  requiresAny: ['routing'],
  since: 'P3',
} as const;

/** Shared fields of the EIGRP shows (W3 cli). */
const SHOW_LINE = {
  mode: '@exec',
  privilege: 1,
  filterable: true,
  grammars: NFOS_ONLY,
  requiresAny: ['routing'],
  since: 'P3',
} as const;

/** Shared fields of the EIGRP interface lines. */
const IF_LINE = {
  mode: 'config-if',
  privilege: 15,
  allowNo: true,
  noArgsOptional: true,
  grammars: NFOS_ONLY,
  requiresAny: ['routing'],
  since: 'P3',
} as const;

/** @since P3 [C1] The EIGRP command table. */
export const EIGRP_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    path: ['router', 'eigrp', '<as>'],
    mode: 'config',
    privilege: 15,
    help: 'Run EIGRP in one autonomous system and configure it',
    args: { as: AS_ARG },
    handler: H.configRouterEigrp,
    allowNo: true,
    entersMode: EIGRP_MODE,
    sessionEffect: 'enter-mode',
    grammars: NFOS_ONLY,
    requiresAny: ['routing'],
    since: 'P3',
    objectives: ['CCNA3.eigrp.1'],
  },
  {
    ...PROCESS_LINE,
    path: ['network', '<address>', '<wildcard>'],
    help: 'Run EIGRP on the interfaces inside this network',
    args: {
      address: ipv4Arg('Network address (a classful network when no wildcard follows)'),
      wildcard: ipv4Arg('Wildcard mask: 1 bits are ignored (0.0.0.255 = a /24)', true),
    },
    handler: H.eigrpNetwork,
    objectives: ['CCNA3.eigrp.1'],
  },
  {
    ...PROCESS_LINE,
    path: ['eigrp', 'router-id', '<address>'],
    help: 'Fix the router ID this process uses',
    args: { address: ipv4Arg('Router ID, written as an IPv4 address') },
    handler: H.eigrpRouterId,
    noArgsOptional: true,
    objectives: ['CCNA3.eigrp.1'],
  },
  // the keyword form first, so `default` is never read as an interface name
  {
    ...PROCESS_LINE,
    path: ['passive-interface', 'default'],
    help: 'Send no hellos on any interface unless it is named with no passive-interface',
    handler: H.eigrpPassiveDefault,
    objectives: ['CCNA3.eigrp.1'],
  },
  {
    ...PROCESS_LINE,
    path: ['passive-interface', '<iface>'],
    help: 'Advertise this interface\'s network but send no hellos on it',
    args: { iface: ifaceArg('Interface that stays silent', { completion: 'interfaces', portFilter: { roles: L3_ROLES } }) },
    handler: H.eigrpPassiveInterface,
    objectives: ['CCNA3.eigrp.1'],
  },
  {
    ...PROCESS_LINE,
    path: ['metric', 'weights', '<tos>', '<k1>', '<k2>', '<k3>', '<k4>', '<k5>'],
    help: 'K values that weigh bandwidth, load, delay and reliability in the metric',
    args: {
      tos: intArg('Type of service (always 0)', 0, 0),
      k1: intArg('K1, the bandwidth weight', 0, 255),
      k2: intArg('K2, the load weight', 0, 255),
      k3: intArg('K3, the delay weight', 0, 255),
      k4: intArg('K4, the first reliability weight', 0, 255),
      k5: intArg('K5, the second reliability weight', 0, 255),
    },
    handler: H.eigrpMetricWeights,
    noArgsOptional: true,
    objectives: ['CCNA3.eigrp.3'],
  },
  {
    ...PROCESS_LINE,
    path: ['maximum-paths', '<paths>'],
    help: 'Most equal-cost paths installed for one destination',
    args: { paths: intArg('Number of paths', 1, EIGRP_MAX_PATHS) },
    handler: H.eigrpMaximumPaths,
    noArgsOptional: true,
    objectives: ['CCNA3.eigrp.2'],
  },
  {
    ...PROCESS_LINE,
    path: ['auto-summary'],
    help: 'Summarise at classful boundaries (not simulated; no auto-summary is accepted)',
    handler: H.eigrpAutoSummary,
    objectives: ['CCNA3.eigrp.1'],
  },
  {
    ...IF_LINE,
    path: ['delay', '<tens-of-us>'],
    help: 'Delay of this link in tens of microseconds, for the EIGRP metric',
    args: { 'tens-of-us': intArg('Delay in tens of microseconds', 1, EIGRP_DELAY_MAX) },
    handler: H.ifDelay,
    portRequires: { roles: DELAY_ROLES, mismatch: MSG_DELAY_PORT },
    objectives: ['CCNA3.eigrp.3'],
  },
  {
    ...IF_LINE,
    path: ['ip', 'hello-interval', 'eigrp', '<as>', '<seconds>'],
    help: 'Seconds between EIGRP hellos on this interface',
    args: { as: AS_ARG, seconds: intArg('Hello interval in seconds', 1, 65535) },
    handler: H.ifIpHelloEigrp,
    portRequires: { roles: L3_ROLES },
    objectives: ['CCNA3.eigrp.1'],
  },
  {
    ...IF_LINE,
    path: ['ip', 'hold-time', 'eigrp', '<as>', '<seconds>'],
    help: 'Seconds neighbours wait for a hello from this interface before dropping it',
    args: { as: AS_ARG, seconds: intArg('Hold time in seconds', 1, 65535) },
    handler: H.ifIpHoldEigrp,
    portRequires: { roles: L3_ROLES },
    objectives: ['CCNA3.eigrp.1'],
  },
  // ── W3 cli (cli-b): the shows, the clear and the debug categories (§2.16, §5.8) ──
  {
    ...SHOW_LINE,
    path: ['show', 'ip', 'eigrp', 'neighbors', '<iface>'],
    help: 'EIGRP neighbours: address, interface, hold time, uptime, SRTT and queue',
    args: { iface: ifaceArg('Limit the output to one interface', { optional: true }) },
    handler: H.showIpEigrpNeighbors,
    objectives: ['CCNA3.eigrp.1', 'CCNA3.eigrp.4'],
  },
  {
    ...SHOW_LINE,
    path: ['show', 'ip', 'eigrp', 'topology'],
    help: 'EIGRP topology table: successors and feasible successors of each destination',
    handler: H.showIpEigrpTopology,
    objectives: ['CCNA3.eigrp.1', 'CCNA3.eigrp.2'],
  },
  {
    ...SHOW_LINE,
    path: ['show', 'ip', 'eigrp', 'topology', 'all-links'],
    help: 'EIGRP topology table with every path, feasible or not',
    handler: H.showIpEigrpTopology,
    fixedArgs: { [EIGRP_TOPOLOGY_VIEW_ARG]: EIGRP_TOPOLOGY_ALL_LINKS },
    objectives: ['CCNA3.eigrp.2'],
  },
  {
    ...SHOW_LINE,
    path: ['show', 'ip', 'eigrp', 'topology', '<prefix>'],
    help: 'One destination of the EIGRP topology table, with every path',
    args: { prefix: { type: 'ipv4-prefix', help: 'Destination as A.B.C.D/len' } },
    handler: H.showIpEigrpTopology,
    objectives: ['CCNA3.eigrp.2', 'CCNA3.eigrp.3'],
  },
  {
    ...SHOW_LINE,
    path: ['show', 'ip', 'eigrp', 'interfaces'],
    help: 'Interfaces running EIGRP: neighbours, timers, bandwidth and delay',
    handler: H.showIpEigrpInterfaces,
    objectives: ['CCNA3.eigrp.1', 'CCNA3.eigrp.3'],
  },
  {
    ...SHOW_LINE,
    path: ['show', 'ip', 'route', 'eigrp'],
    help: 'Only the routes EIGRP learned',
    handler: SHOW_HANDLERS.showIpRoute,
    fixedArgs: { [ROUTE_SOURCE_ARG]: EIGRP_ROUTE_SOURCE },
    objectives: ['CCNA3.eigrp.2'],
  },
  {
    path: ['clear', 'ip', 'eigrp', 'neighbors', '<address>'],
    mode: 'priv-exec',
    privilege: 15,
    help: 'Drop every EIGRP neighbour (or the one with this address) and form the adjacencies again',
    args: { address: ipv4Arg('Neighbour address (every neighbour when left out)', true) },
    handler: H.execClearIpEigrpNeighbors,
    grammars: NFOS_ONLY,
    requiresAny: ['routing'],
    since: 'P3',
    objectives: ['CCNA3.eigrp.4'],
  },
  ...debugSpecs(EIGRP_DEBUG_CATEGORIES, EIGRP_DEBUG_OBJECTIVES),
]);

/** @since P3 [C1] Help of the intermediate EIGRP keywords (merged into `LITERAL_HELP` by the fold). */
export const EIGRP_LITERAL_HELP: Readonly<Record<string, string>> = Object.freeze({
  eigrp: 'EIGRP settings',
  'hello-interval': 'Hello interval settings',
  'hold-time': 'Hold time settings',
  metric: 'Metric settings',
});
