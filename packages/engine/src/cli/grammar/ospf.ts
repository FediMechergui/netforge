/**
 * cli/grammar/ospf.ts — single-area OSPFv2 configuration and verification (ARCHITECTURE-P3 §5.1, §5.8, D7, D11; §7 W2
 * cli part 1).
 *
 * Configuration (§5.1, MUST):
 *   global         `router ospf <1-65535>` (mode `config-router`; refused under `no ip routing`; one process per device)
 *   config-router  `router-id <a>`, `network <a> <wildcard> area <area>`, `passive-interface <if>` / `passive-interface
 *                  default`, `auto-cost reference-bandwidth <1-4294967>`, `default-information originate [always]`,
 *                  `maximum-paths <1-4>`
 *   interface      `ip ospf <pid> area <area>`, `ip ospf cost|priority|hello-interval|dead-interval <n>`, `ip ospf network
 *                  point-to-point|broadcast`; `bandwidth <kbps>` is the serial fragment's spec, widened in this change to
 *                  routed Ethernet ports, subinterfaces and [S18] tunnels (cli/grammar/serial.ts `BANDWIDTH_PORT`).
 * Verification (§5.8, W2 part): `show ip ospf`, `show ip ospf neighbor`, `show ip ospf interface [brief|<if>]`, `show
 * ip route ospf` (the `show.ip-route` handler with the source filter `O`) and the interactive `clear ip ospf process`.
 * (W3, cli part 2): `show ip ospf neighbor detail`, `show ip ospf database [router|network|external]
 * [self-originate]`, `show ip protocols` (the OSPF section, and the [C1] EIGRP section when `router eigrp` runs) and the
 * five OSPF debug categories of §5.8 (`OSPF_DEBUG_CATEGORIES`, the strings the ospf daemon passes to `ctx.debug` and
 * `ctx.transition`). The ospf daemon reads the lines (protocols/ospf/config.ts); the shows read the `ospf-*` tables
 * and the ospf StateView (§2.6).
 *
 * Scope: the `routing` capability (routers and multilayer switches), written as a literal (rule 12: no module-scope
 * read of another module's derived lists). Help strings are original wording (spec §1.6).
 */
import type { ArgSpec, CommandSpec, PortRequirement } from '../../contracts/cli.js';
import type { Capability } from '../../contracts/catalog.js';
import { choiceArg, debugSpecs, type GrammarDebugCategory, ifaceArg, intArg, ipv4Arg, NFOS_ONLY } from './core-exec.js';

/** Handler ids of the OSPF fragment. Never rename. */
export const OSPF_HANDLERS = {
  configRouterOspf: 'config.router-ospf',
  ospfRouterId: 'ospf.router-id',
  ospfNetwork: 'ospf.network',
  ospfPassiveInterface: 'ospf.passive-interface',
  ospfAutoCost: 'ospf.auto-cost',
  ospfDefaultInformation: 'ospf.default-information',
  ospfMaximumPaths: 'ospf.maximum-paths',
  ifIpOspf: 'if.ip-ospf',
  showIpOspf: 'show.ip-ospf',
  showIpOspfNeighbor: 'show.ip-ospf-neighbor',
  showIpOspfInterface: 'show.ip-ospf-interface',
  execClearIpOspf: 'exec.clear-ip-ospf-process',
  // W3 cli part 2
  showIpOspfDatabase: 'show.ip-ospf-database',
  showIpProtocols: 'show.ip-protocols',
} as const;

/** @since P3 Capabilities that run OSPF (the W4 catalog adds the daemon to `routing`, §2.1). */
export const OSPF_CAPABILITIES: readonly Capability[] = Object.freeze(['routing']);

/** @since P3 Arg (`fixedArgs`) naming which `ip ospf …` setting a spec writes. */
export const OSPF_IF_SETTING_ARG = 'setting';
/** @since P3 Values of OSPF_IF_SETTING_ARG, one per interface line. */
export const OSPF_IF_SETTINGS = Object.freeze(['area', 'cost', 'priority', 'hello-interval', 'dead-interval', 'network'] as const);
/** @since P3 Arg (`fixedArgs`) of `passive-interface default`. */
export const OSPF_PASSIVE_DEFAULT_ARG = 'default';
/** @since P3 Arg (`fixedArgs`) of the `show ip ospf interface` forms: `brief` lists one row per interface. */
export const OSPF_SHOW_BRIEF_ARG = 'brief';
/** @since P3 Arg (`fixedArgs`) of `show ip ospf neighbor detail`: one block per neighbour instead of the table. */
export const OSPF_SHOW_DETAIL_ARG = 'detail';
/** @since P3 Arg (`fixedArgs`) of the typed `show ip ospf database` forms: which LSA type to print in full. */
export const OSPF_DB_TYPE_ARG = 'type';
/** @since P3 Values of OSPF_DB_TYPE_ARG (§5.8): router (type 1), network (type 2) and external (type 5) LSAs. */
export const OSPF_DB_TYPES = Object.freeze(['router', 'network', 'external'] as const);
/** @since P3 Arg (`fixedArgs`) of `show ip ospf database … self-originate`: only the LSAs this router originated. */
export const OSPF_DB_SELF_ARG = 'self';
/** @since P3 The `show ip route` source filter value of `show ip route ospf` (`RouteRow.source`). */
export const OSPF_ROUTE_SOURCE = 'O';

/** The `show ip route` handler id and its source-filter arg (cli/grammar/show.ts `HANDLERS.showIpRoute`, `ROUTE_SOURCE_ARG`). */
const SHOW_IP_ROUTE_HANDLER = 'show.ip-route';
const SHOW_IP_ROUTE_SOURCE_ARG = 'source';

/** @since P3 Largest `maximum-paths` (§5.1). */
export const OSPF_CLI_MAXIMUM_PATHS = 4;
/** @since P3 Largest `auto-cost reference-bandwidth`, Mb/s (§5.1). */
export const OSPF_CLI_REFERENCE_MAX = 4_294_967;

const H = OSPF_HANDLERS;
const OBJ_ON = ['CCNA3.ospf.1'];
const OBJ_RID = ['CCNA3.ospf.7'];
const OBJ_PASSIVE = ['CCNA3.ospf.6'];
const OBJ_COST = ['CCNA3.ospf.5'];
const OBJ_DR = ['CCNA3.ospf.2', 'CCNA3.ospf.3'];
const OBJ_TIMERS = ['CCNA3.ospf.4'];
const OBJ_DEFAULT = ['CCNA3.ospf.13'];
const OBJ_LSDB = ['CCNA3.ospf.8', 'CCNA3.ospf.12'];
const OBJ_LSA_TYPE: Readonly<Record<(typeof OSPF_DB_TYPES)[number], readonly string[]>> = Object.freeze({
  router: ['CCNA3.ospf.12'],
  network: ['CCNA3.ospf.12'],
  external: ['CCNA3.ospf.13'],
});
const OBJ_PROTOCOLS = ['CCNA3.ospf.1', 'CCNA3.eigrp.1'];

/**
 * @since P3 The OSPF debug categories (§5.8, binding across the daemon and cli seam: protocols/ospf.ts `OSPF_DEBUG`
 * passes exactly these strings to `ctx.debug` and `ctx.transition`), offered where OSPF runs. Written as literals (rule
 * 12); cli.debug.p3.test.ts pins them to the daemon's constants.
 */
export const OSPF_DEBUG_CATEGORIES: readonly GrammarDebugCategory[] = Object.freeze([
  { category: 'ip ospf adj', help: 'Trace OSPF interface and neighbour state changes and the DR/BDR elections', requiresAny: OSPF_CAPABILITIES, since: 'P3' },
  { category: 'ip ospf hello', help: 'Trace OSPF hellos sent and received, and every refused hello with its reason', requiresAny: OSPF_CAPABILITIES, since: 'P3' },
  { category: 'ip ospf flood', help: 'Trace OSPF updates, requests and acknowledgements, and LSAs installed or flushed', requiresAny: OSPF_CAPABILITIES, since: 'P3' },
  { category: 'ip ospf spf', help: 'Trace OSPF shortest-path runs, their reasons and the route changes they make', requiresAny: OSPF_CAPABILITIES, since: 'P3' },
  { category: 'ip ospf packet', help: 'Trace every OSPF packet sent or received, one line each', requiresAny: OSPF_CAPABILITIES, since: 'P3' },
]);

/** @since P3 Objectives of the OSPF debug categories. */
export const OSPF_DEBUG_OBJECTIVES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'ip ospf adj': OBJ_DR,
  'ip ospf hello': OBJ_TIMERS,
  'ip ospf flood': OBJ_LSDB,
  'ip ospf spf': ['CCNA3.ospf.8'],
  'ip ospf packet': OBJ_ON,
});

const GLOBAL = {
  mode: 'config',
  privilege: 15,
  grammars: NFOS_ONLY,
  requiresAny: OSPF_CAPABILITIES,
  since: 'P3',
} as const;

const ROUTER = {
  mode: 'config-router',
  privilege: 15,
  allowNo: true,
  grammars: NFOS_ONLY,
  requiresAny: OSPF_CAPABILITIES,
  since: 'P3',
} as const;

/** Interface lines of OSPF: any port that holds an L3 address (routed, serial, subinterface, SVI, loopback). */
const OSPF_PORT: PortRequirement = Object.freeze<PortRequirement>({
  roles: ['routed', 'wan', 'subif', 'svi', 'virtual', 'tunnel'],
  mismatch: '% OSPF runs on routed interfaces; enter "no switchport" first or use the VLAN interface.',
});

const IF_LINE = {
  mode: ['config-if', 'config-subif'],
  privilege: 15,
  allowNo: true,
  grammars: NFOS_ONLY,
  requiresAny: OSPF_CAPABILITIES,
  portRequires: OSPF_PORT,
  since: 'P3',
} as const;

const PID_ARG: ArgSpec = intArg('OSPF process number (local to this device)', 1, 65535);
/**
 * The area: a number 0-4294967295 (kept as typed) or dotted (normalised) — the parser's dotted-or-number reading of an
 * `ipv4` arg with bounds (cli/parser.ts `ospfAreaArg`), written as data here so this fragment reads no other module at
 * load time (rule 12).
 */
const AREA_ARG: ArgSpec = Object.freeze({ type: 'ipv4', help: 'Area: a number (0 is the backbone) or a dotted id such as 0.0.0.0', min: 0, max: 4_294_967_295 });

/** `ip ospf <setting> <value>` specs. */
function ipOspf(setting: (typeof OSPF_IF_SETTINGS)[number], path: string[], help: string, args: Record<string, ArgSpec>, objectives: readonly string[]): CommandSpec {
  return { ...IF_LINE, path, help, args, handler: H.ifIpOspf, noArgsOptional: true, fixedArgs: { [OSPF_IF_SETTING_ARG]: setting }, objectives };
}

/**
 * The `show ip ospf database [router|network|external] [self-originate]` specs (§5.8): the plain form lists every LSA
 * by type, one line each; the typed forms print one block per LSA of that type.
 */
function ospfDatabaseSpecs(): CommandSpec[] {
  const base = { mode: '@exec', privilege: 1, handler: H.showIpOspfDatabase, filterable: true, grammars: NFOS_ONLY, requiresAny: OSPF_CAPABILITIES, since: 'P3' } as const;
  const self = { [OSPF_DB_SELF_ARG]: 'self-originate' };
  const out: CommandSpec[] = [
    { ...base, path: ['show', 'ip', 'ospf', 'database'], help: 'The link-state database: one line per LSA this router holds', objectives: OBJ_LSDB },
    { ...base, path: ['show', 'ip', 'ospf', 'database', 'self-originate'], help: 'Only the LSAs this router originated', fixedArgs: self, objectives: OBJ_LSDB },
  ];
  const typeHelp: Readonly<Record<(typeof OSPF_DB_TYPES)[number], string>> = {
    router: "Router LSAs (type 1) in full: each router's links and their costs",
    network: "Network LSAs (type 2) in full: each segment's mask and attached routers",
    external: 'External LSAs (type 5) in full: routes from outside OSPF, such as a default route',
  };
  for (const type of OSPF_DB_TYPES) {
    out.push({ ...base, path: ['show', 'ip', 'ospf', 'database', type], help: typeHelp[type], fixedArgs: { [OSPF_DB_TYPE_ARG]: type }, objectives: OBJ_LSA_TYPE[type] });
    out.push({
      ...base,
      path: ['show', 'ip', 'ospf', 'database', type, 'self-originate'],
      help: 'Only the LSAs this router originated',
      fixedArgs: { [OSPF_DB_TYPE_ARG]: type, ...self },
      objectives: OBJ_LSA_TYPE[type],
    });
  }
  return out;
}

/** The OSPF command table. */
export const OSPF_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    ...GLOBAL,
    path: ['router', 'ospf', '<pid>'],
    help: 'Start or configure the OSPF process',
    args: { pid: PID_ARG },
    handler: H.configRouterOspf,
    allowNo: true,
    entersMode: 'config-router',
    sessionEffect: 'enter-mode',
    objectives: OBJ_ON,
  },
  {
    // `router ospf <pid>` typed inside config-router: `router` would otherwise abbreviate `router-id` there, and the
    // line would never fall back to the global mode (cli/runtime.ts falls back on unrecognized lines only). Hidden.
    ...GLOBAL,
    mode: 'config-router',
    path: ['router', 'ospf', '<pid>'],
    help: 'Start or configure the OSPF process',
    args: { pid: PID_ARG },
    handler: H.configRouterOspf,
    allowNo: true,
    hidden: true,
    entersMode: 'config-router',
    sessionEffect: 'enter-mode',
    objectives: OBJ_ON,
  },
  {
    ...ROUTER,
    path: ['router-id', '<id>'],
    help: 'Fixed router ID, written like an IPv4 address',
    args: { id: ipv4Arg('Router ID') },
    handler: H.ospfRouterId,
    noArgsOptional: true,
    objectives: OBJ_RID,
  },
  {
    ...ROUTER,
    path: ['network', '<address>', '<wildcard>', 'area', '<area>'],
    help: 'Run OSPF on the interfaces whose address falls in this range',
    args: {
      address: ipv4Arg('Network address'),
      wildcard: ipv4Arg('Wildcard mask: 1 bits are ignored (0.0.0.255 = a /24, 0.0.0.0 = one address)'),
      area: AREA_ARG,
    },
    handler: H.ospfNetwork,
    noArgsOptional: true,
    objectives: OBJ_ON,
  },
  {
    ...ROUTER,
    path: ['passive-interface', '<iface>'],
    help: 'Stop sending hellos on an interface while still advertising its network',
    args: { iface: ifaceArg('Interface to keep silent') },
    handler: H.ospfPassiveInterface,
    objectives: OBJ_PASSIVE,
  },
  {
    ...ROUTER,
    path: ['passive-interface', 'default'],
    help: 'Keep every interface silent unless "no passive-interface <if>" names it',
    handler: H.ospfPassiveInterface,
    fixedArgs: { [OSPF_PASSIVE_DEFAULT_ARG]: 'default' },
    objectives: OBJ_PASSIVE,
  },
  {
    ...ROUTER,
    path: ['auto-cost', 'reference-bandwidth', '<mbps>'],
    help: 'Bandwidth that costs 1, in Mb/s (default 100); set it alike on every router',
    args: { mbps: intArg('Reference bandwidth in Mb/s', 1, OSPF_CLI_REFERENCE_MAX) },
    handler: H.ospfAutoCost,
    noArgsOptional: true,
    objectives: OBJ_COST,
  },
  {
    ...ROUTER,
    path: ['default-information', 'originate', '<always>'],
    help: 'Advertise this router\'s default route to the area',
    args: { always: choiceArg('always: advertise it even when this router has no default route', ['always'], true) },
    handler: H.ospfDefaultInformation,
    noArgsOptional: true,
    objectives: OBJ_DEFAULT,
  },
  {
    ...ROUTER,
    path: ['maximum-paths', '<paths>'],
    help: 'Equal-cost paths installed per destination (default 4)',
    args: { paths: intArg('Number of paths', 1, OSPF_CLI_MAXIMUM_PATHS) },
    handler: H.ospfMaximumPaths,
    noArgsOptional: true,
    objectives: OBJ_ON,
  },
  ipOspf('area', ['ip', 'ospf', '<pid>', 'area', '<area>'], 'Run OSPF on this interface in an area, whatever the network lines say', { pid: PID_ARG, area: AREA_ARG }, OBJ_ON),
  ipOspf('cost', ['ip', 'ospf', 'cost', '<cost>'], 'Fixed cost of this interface instead of the bandwidth-based one', { cost: intArg('Cost', 1, 65535) }, OBJ_COST),
  ipOspf('priority', ['ip', 'ospf', 'priority', '<priority>'], 'Priority in the designated router election (0 never becomes DR)', { priority: intArg('Priority (default 1)', 0, 255) }, OBJ_DR),
  ipOspf('hello-interval', ['ip', 'ospf', 'hello-interval', '<seconds>'], 'Seconds between hellos (default 10); must match the neighbours', { seconds: intArg('Seconds', 1, 65535) }, OBJ_TIMERS),
  ipOspf('dead-interval', ['ip', 'ospf', 'dead-interval', '<seconds>'], 'Seconds without a hello before a neighbour is declared down (default 4 x hello)', { seconds: intArg('Seconds', 1, 65535) }, OBJ_TIMERS),
  ipOspf('network', ['ip', 'ospf', 'network', '<type>'], 'Treat this interface as a point-to-point link or a broadcast segment', {
    type: choiceArg('point-to-point: no election; broadcast: elect a DR and a BDR', ['point-to-point', 'broadcast']),
  }, OBJ_DR),
  {
    path: ['show', 'ip', 'ospf'],
    mode: '@exec',
    privilege: 1,
    help: 'The OSPF process: router ID, timers, SPF runs and areas',
    handler: H.showIpOspf,
    filterable: true,
    grammars: NFOS_ONLY,
    requiresAny: OSPF_CAPABILITIES,
    since: 'P3',
    objectives: OBJ_ON,
  },
  {
    path: ['show', 'ip', 'ospf', 'neighbor'],
    mode: '@exec',
    privilege: 1,
    help: 'OSPF neighbours with their state, role and dead timer',
    handler: H.showIpOspfNeighbor,
    filterable: true,
    grammars: NFOS_ONLY,
    requiresAny: OSPF_CAPABILITIES,
    since: 'P3',
    objectives: OBJ_DR,
  },
  {
    path: ['show', 'ip', 'ospf', 'interface', '<iface>'],
    mode: '@exec',
    privilege: 1,
    help: 'OSPF settings and state of each interface (or one)',
    args: { iface: ifaceArg('Limit the output to one interface', { optional: true }) },
    handler: H.showIpOspfInterface,
    filterable: true,
    grammars: NFOS_ONLY,
    requiresAny: OSPF_CAPABILITIES,
    since: 'P3',
    objectives: OBJ_DR,
  },
  {
    path: ['show', 'ip', 'ospf', 'interface', 'brief'],
    mode: '@exec',
    privilege: 1,
    help: 'One line per OSPF interface',
    handler: H.showIpOspfInterface,
    fixedArgs: { [OSPF_SHOW_BRIEF_ARG]: 'brief' },
    filterable: true,
    grammars: NFOS_ONLY,
    requiresAny: OSPF_CAPABILITIES,
    since: 'P3',
    objectives: OBJ_DR,
  },
  {
    path: ['show', 'ip', 'ospf', 'neighbor', 'detail'],
    mode: '@exec',
    privilege: 1,
    help: 'Every OSPF neighbour in full: area, state, role, timers and queue',
    handler: H.showIpOspfNeighbor,
    fixedArgs: { [OSPF_SHOW_DETAIL_ARG]: 'detail' },
    filterable: true,
    grammars: NFOS_ONLY,
    requiresAny: OSPF_CAPABILITIES,
    since: 'P3',
    objectives: OBJ_DR,
  },
  ...ospfDatabaseSpecs(),
  {
    path: ['show', 'ip', 'protocols'],
    mode: '@exec',
    privilege: 1,
    help: 'The routing processes: what they advertise, their settings and where their routes come from',
    handler: H.showIpProtocols,
    filterable: true,
    grammars: NFOS_ONLY,
    requiresAny: OSPF_CAPABILITIES,
    since: 'P3',
    objectives: OBJ_PROTOCOLS,
  },
  {
    path: ['show', 'ip', 'route', 'ospf'],
    mode: '@exec',
    privilege: 1,
    help: 'Only the routes OSPF learned',
    handler: SHOW_IP_ROUTE_HANDLER,
    fixedArgs: { [SHOW_IP_ROUTE_SOURCE_ARG]: OSPF_ROUTE_SOURCE },
    filterable: true,
    grammars: NFOS_ONLY,
    requiresAny: OSPF_CAPABILITIES,
    since: 'P3',
    objectives: OBJ_ON,
  },
  {
    path: ['clear', 'ip', 'ospf', 'process'],
    mode: 'priv-exec',
    privilege: 15,
    help: 'Restart OSPF: drop every neighbour and use a new router ID',
    handler: H.execClearIpOspf,
    interactive: true,
    grammars: NFOS_ONLY,
    requiresAny: OSPF_CAPABILITIES,
    since: 'P3',
    objectives: OBJ_RID,
  },
  // W3 cli part 2: `debug ip ospf adj|hello|flood|spf|packet` (§5.8)
  ...debugSpecs(OSPF_DEBUG_CATEGORIES, OSPF_DEBUG_OBJECTIVES),
]);
