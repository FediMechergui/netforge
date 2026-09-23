/**
 * cli/grammar/index.ts — the full built-in command table assembled from its fragments (spec §7.2, §7.3, §7.6;
 * ARCHITECTURE-P1 D2, §3.13, §8.1 W3, §8.2 W5).
 *
 * Commands are DATA: every entry is a `CommandSpec` whose `path` mixes literal keywords with `<arg>` placeholders.
 * The parser derives prefix matching, `?` help, Tab completion and caret errors from this table; the CLI runtime
 * resolves `handler` ids through its registry (cli/handlers/index.ts).
 *
 * Fragments, in table order: core EXEC, shared show commands, global configuration, shared interface lines,
 * virtual interfaces, switchport, serial, wireless, modules, then the P1 features (IPv6, DHCP, DNS, web services,
 * transport, traceroute, passwords and lines) and the host shell, then (ARCHITECTURE-P2, folded in by the W4 catalog
 * flip) the P2 fragments: VLANs, the P2 switchport lines, subinterfaces, routing, spanning tree, EtherChannel, port
 * security, err-disable recovery, NAT, access lists, DHCPv6 and HSRP. Scoping is capability-, grammar- and
 * port-role-driven (`grammars`, `requires`, `requiresAny`, `portRequires`); no spec names a device kind.
 *
 * `HANDLERS` is the union of every fragment's handler ids (frozen names shared with the runtime and handler
 * owners), `DEBUG_CATEGORY_DEFS` the debug category registry. Every string is original wording (spec §1.6).
 */
import type { CommandSpec } from '../../contracts/cli.js';
import { CORE_DEBUG_CATEGORIES, CORE_EXEC_GRAMMAR, CORE_EXEC_HANDLERS, debugSpecs, type GrammarDebugCategory } from './core-exec.js';
import { SHOW_GRAMMAR, SHOW_HANDLERS } from './show.js';
import { CONFIG_GLOBAL_GRAMMAR, CONFIG_GLOBAL_HANDLERS } from './config-global.js';
import { CONFIG_IF_GRAMMAR, CONFIG_IF_HANDLERS } from './config-if.js';
import { SVI_GRAMMAR } from './svi.js';
import { SWITCHPORT_GRAMMAR, SWITCHPORT_HANDLERS } from './switchport.js';
import { SERIAL_DEBUG_CATEGORIES, SERIAL_GRAMMAR, SERIAL_HANDLERS } from './serial.js';
import { WIRELESS_DEBUG_CATEGORIES, WIRELESS_GRAMMAR, WIRELESS_HANDLERS } from './wireless.js';
import { MODULES_GRAMMAR, MODULES_HANDLERS } from './modules.js';
import { IPV6_DEBUG_CATEGORIES, IPV6_GRAMMAR, IPV6_HANDLERS } from './ipv6.js';
import { DHCP_DEBUG_CATEGORIES, DHCP_GRAMMAR, DHCP_HANDLERS } from './dhcp.js';
import { DNS_DEBUG_CATEGORIES, DNS_GRAMMAR, DNS_HANDLERS } from './dns.js';
import { SERVICES_GRAMMAR, SERVICES_HANDLERS } from './services.js';
import { TRANSPORT_DEBUG_CATEGORIES, TRANSPORT_GRAMMAR, TRANSPORT_HANDLERS } from './transport.js';
import { TRACEROUTE_DEBUG_CATEGORIES, TRACEROUTE_GRAMMAR } from './traceroute.js';
import { LINE_AUTH_GRAMMAR, LINE_AUTH_HANDLERS } from './line-auth.js';
import { HOST_SHELL_GRAMMAR, HOST_SHELL_HANDLERS } from './host-shell.js';
import { VLAN_GRAMMAR, VLAN_HANDLERS } from './vlan.js';
import { SWITCHPORT_P2_GRAMMAR, SWITCHPORT_P2_HANDLERS } from './switchport.js';
import { SUBIF_GRAMMAR, SUBIF_HANDLERS } from './subif.js';
import { ROUTING_GRAMMAR, ROUTING_HANDLERS } from './routing.js';
import { L2_CONTROL_DEBUG_CATEGORIES, L2_CONTROL_DEBUG_OBJECTIVES, SPANNING_TREE_GRAMMAR, SPANNING_TREE_HANDLERS } from './spanning-tree.js';
import { ETHERCHANNEL_DEBUG_CATEGORIES, ETHERCHANNEL_DEBUG_OBJECTIVES, ETHERCHANNEL_GRAMMAR, ETHERCHANNEL_HANDLERS } from './etherchannel.js';
import { PORT_SECURITY_DEBUG_CATEGORIES, PORT_SECURITY_DEBUG_OBJECTIVES, PORT_SECURITY_GRAMMAR, PORT_SECURITY_HANDLERS } from './port-security.js';
import { ERRDISABLE_GRAMMAR, ERRDISABLE_HANDLERS } from './errdisable.js';
import { NAT_DEBUG_CATEGORIES, NAT_DEBUG_OBJECTIVES, NAT_GRAMMAR, NAT_HANDLERS } from './nat.js';
import { ACL_GRAMMAR, ACL_HANDLERS } from './acl.js';
import { DHCPV6_DEBUG_CATEGORIES, DHCPV6_DEBUG_OBJECTIVES, DHCPV6_GRAMMAR, DHCPV6_HANDLERS } from './dhcpv6.js';
import { HSRP_DEBUG_CATEGORIES, HSRP_DEBUG_OBJECTIVES, HSRP_GRAMMAR, HSRP_HANDLERS } from './hsrp.js';

export * from './core-exec.js';
export * from './show.js';
export * from './config-global.js';
export * from './config-if.js';
export * from './svi.js';
export * from './switchport.js';
export * from './serial.js';
export * from './wireless.js';
export * from './modules.js';
export * from './ipv6.js';
export * from './dhcp.js';
export * from './dns.js';
export * from './services.js';
export * from './transport.js';
export * from './traceroute.js';
export * from './line-auth.js';
export * from './host-shell.js';
export * from './vlan.js';
export * from './subif.js';
export * from './routing.js';
export * from './spanning-tree.js';
export * from './etherchannel.js';
export * from './port-security.js';
export * from './errdisable.js';
export * from './nat.js';
export * from './acl.js';
export * from './dhcpv6.js';
export * from './hsrp.js';

/**
 * @since P2 (ARCHITECTURE-P2 §5.4; W3 cli) The debug categories of the P2 daemons, in the §5.4 table order. Each is
 * keyed on the capability rows of its daemon (`capabilitiesRunning`), which the W4 catalog fills when it registers
 * the daemons (§2.1): until then the categories are registered but offered on no device.
 */
export const P2_DEBUG_CATEGORIES: readonly GrammarDebugCategory[] = Object.freeze([
  ...L2_CONTROL_DEBUG_CATEGORIES,
  ...ETHERCHANNEL_DEBUG_CATEGORIES,
  ...PORT_SECURITY_DEBUG_CATEGORIES,
  ...NAT_DEBUG_CATEGORIES,
  ...HSRP_DEBUG_CATEGORIES,
  ...DHCPV6_DEBUG_CATEGORIES,
]);

/** @since P2 Objectives of the P2 debug categories. */
export const P2_DEBUG_OBJECTIVES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ...L2_CONTROL_DEBUG_OBJECTIVES,
  ...ETHERCHANNEL_DEBUG_OBJECTIVES,
  ...PORT_SECURITY_DEBUG_OBJECTIVES,
  ...NAT_DEBUG_OBJECTIVES,
  ...HSRP_DEBUG_OBJECTIVES,
  ...DHCPV6_DEBUG_OBJECTIVES,
});

/**
 * @since P2 The `debug <category>` specs of the P2 categories. They join the P1 table's `core-exec` fragment (not the
 * P2 fragments): the registry rule `DEBUG_CATEGORY_DEFS` ⇔ `debug` specs of `GRAMMAR` is pinned by
 * cli.parser.grammar.test.ts, and their handler is the runtime-bound `exec.debug`.
 */
export const P2_DEBUG_GRAMMAR: readonly CommandSpec[] = Object.freeze(debugSpecs(P2_DEBUG_CATEGORIES, P2_DEBUG_OBJECTIVES));

// ── P2 (ARCHITECTURE-P2 §7 W2/W3 cli, folded in by the W4 catalog flip, §9.2 items 17 and 18) ─────────────────────
// The P2 fragments were assembled beside the P1 table until the W4 flip; since then they are part of it: `HANDLERS`
// is the union with `P2_HANDLERS`, `GRAMMAR_FRAGMENTS` lists the P2 fragments after the P1 ones, and `GRAMMAR` (the
// table the help goldens and the runtime read) holds every spec. `P2_HANDLERS`, `P2_GRAMMAR_FRAGMENTS` and
// `P2_GRAMMAR` stay as the named P2 subset (the P2 handler files key their registries on `P2_HANDLERS`), and
// `BUILTIN_GRAMMAR` is `GRAMMAR`. New P2 ids join `P2_HANDLERS`.

/**
 * @since P2 Handler ids of the P2 fragments (W2: vlan, the P2 switchport lines, subinterfaces and ranges, routing;
 * W3: spanning tree, EtherChannel, port security, err-disable recovery, NAT, access lists, DHCPv6 and [S2] HSRP).
 */
export const P2_HANDLERS = Object.freeze({
  ...VLAN_HANDLERS,
  ...SWITCHPORT_P2_HANDLERS,
  ...SUBIF_HANDLERS,
  ...ROUTING_HANDLERS,
  ...SPANNING_TREE_HANDLERS,
  ...ETHERCHANNEL_HANDLERS,
  ...PORT_SECURITY_HANDLERS,
  ...ERRDISABLE_HANDLERS,
  ...NAT_HANDLERS,
  ...ACL_HANDLERS,
  ...DHCPV6_HANDLERS,
  ...HSRP_HANDLERS,
});

/** @since P2 Union of every handler id in `P2_HANDLERS`. */
export type P2HandlerId = (typeof P2_HANDLERS)[keyof typeof P2_HANDLERS];

/** @since P2 The P2 grammar fragments by name, in table order. */
export const P2_GRAMMAR_FRAGMENTS: Readonly<Record<string, readonly CommandSpec[]>> = Object.freeze({
  vlan: VLAN_GRAMMAR,
  'switchport-p2': SWITCHPORT_P2_GRAMMAR,
  subif: SUBIF_GRAMMAR,
  routing: ROUTING_GRAMMAR,
  // W3 cli
  'spanning-tree': SPANNING_TREE_GRAMMAR,
  etherchannel: ETHERCHANNEL_GRAMMAR,
  'port-security': PORT_SECURITY_GRAMMAR,
  errdisable: ERRDISABLE_GRAMMAR,
  nat: NAT_GRAMMAR,
  acl: ACL_GRAMMAR,
  dhcpv6: DHCPV6_GRAMMAR,
  hsrp: HSRP_GRAMMAR,
});

/** @since P2 Every P2 spec, in `P2_GRAMMAR_FRAGMENTS` order. */
export const P2_GRAMMAR: readonly CommandSpec[] = Object.freeze(Object.values(P2_GRAMMAR_FRAGMENTS).flat());

/**
 * Handler ids resolved by the CLI runtime's registry: the union of every fragment, P1 and (since the W4 fold, §9.2
 * item 18) P2. Never rename.
 */
export const HANDLERS = Object.freeze({
  ...CORE_EXEC_HANDLERS,
  ...SHOW_HANDLERS,
  ...CONFIG_GLOBAL_HANDLERS,
  ...CONFIG_IF_HANDLERS,
  ...SWITCHPORT_HANDLERS,
  ...SERIAL_HANDLERS,
  ...WIRELESS_HANDLERS,
  ...MODULES_HANDLERS,
  ...IPV6_HANDLERS,
  ...DHCP_HANDLERS,
  ...DNS_HANDLERS,
  ...SERVICES_HANDLERS,
  ...TRANSPORT_HANDLERS,
  ...LINE_AUTH_HANDLERS,
  ...HOST_SHELL_HANDLERS,
  ...P2_HANDLERS,
});

/** Union of every handler id in `HANDLERS`. */
export type HandlerId = (typeof HANDLERS)[keyof typeof HANDLERS];

/**
 * The grammar fragments by name, in table order (focused tests and runtime injection): the P1 fragments, then (since
 * the W4 fold, §9.2 items 17 and 18) the P2 fragments in `P2_GRAMMAR_FRAGMENTS` order.
 */
export const GRAMMAR_FRAGMENTS: Readonly<Record<string, readonly CommandSpec[]>> = Object.freeze({
  // P2 (W3 cli): the P2 `debug` specs follow the core EXEC specs (see `P2_DEBUG_GRAMMAR`).
  'core-exec': Object.freeze([...CORE_EXEC_GRAMMAR, ...P2_DEBUG_GRAMMAR]),
  show: SHOW_GRAMMAR,
  'config-global': CONFIG_GLOBAL_GRAMMAR,
  'config-if': CONFIG_IF_GRAMMAR,
  svi: SVI_GRAMMAR,
  switchport: SWITCHPORT_GRAMMAR,
  serial: SERIAL_GRAMMAR,
  wireless: WIRELESS_GRAMMAR,
  modules: MODULES_GRAMMAR,
  ipv6: IPV6_GRAMMAR,
  dhcp: DHCP_GRAMMAR,
  dns: DNS_GRAMMAR,
  services: SERVICES_GRAMMAR,
  transport: TRANSPORT_GRAMMAR,
  traceroute: TRACEROUTE_GRAMMAR,
  'line-auth': LINE_AUTH_GRAMMAR,
  'host-shell': HOST_SHELL_GRAMMAR,
  ...P2_GRAMMAR_FRAGMENTS,
});

/** The full built-in command table: every fragment concatenated in `GRAMMAR_FRAGMENTS` order (P1, then P2). */
export const GRAMMAR: readonly CommandSpec[] = Object.freeze(Object.values(GRAMMAR_FRAGMENTS).flat());

/**
 * @since P2 The command table the CLI runtime uses by default. Since the W4 fold it is `GRAMMAR` itself (the P1 table
 * followed by the P2 fragments, the order it always had).
 */
export const BUILTIN_GRAMMAR: readonly CommandSpec[] = GRAMMAR;

/** The debug category registry (`debug <category>` specs and handler validation derive from it). */
export const DEBUG_CATEGORY_DEFS: readonly GrammarDebugCategory[] = Object.freeze([
  ...CORE_DEBUG_CATEGORIES,
  ...SERIAL_DEBUG_CATEGORIES,
  ...WIRELESS_DEBUG_CATEGORIES,
  ...IPV6_DEBUG_CATEGORIES,
  ...DHCP_DEBUG_CATEGORIES,
  ...DNS_DEBUG_CATEGORIES,
  ...TRANSPORT_DEBUG_CATEGORIES,
  ...TRACEROUTE_DEBUG_CATEGORIES,
  ...P2_DEBUG_CATEGORIES,
]);

/**
 * Debug categories accepted by `debug <category>` / `no debug <category>`, in registry order (the P0 five first).
 * `'all'` is handled separately by `debug all` / `no debug all`.
 */
export const DEBUG_CATEGORIES: readonly string[] = Object.freeze(DEBUG_CATEGORY_DEFS.map((d) => d.category));

/**
 * Help text for INTERMEDIATE literals (a keyword that is not the last literal of any matching command at that
 * position). The last literal of a command shows `spec.help`. Original wording.
 */
export const LITERAL_HELP: Readonly<Record<string, string>> = Object.freeze({
  show: 'Display device information',
  ip: 'Internet protocol settings',
  ipv6: 'Internet protocol version 6 settings',
  interface: 'Interface status and settings',
  interfaces: 'Interface status and counters',
  mac: 'MAC address table',
  'address-table': 'MAC address table entries',
  clear: 'Reset a table or counters',
  debug: 'Enable diagnostic tracing',
  undebug: 'Disable diagnostic tracing',
  copy: 'Copy a configuration file',
  'running-config': 'The active configuration',
  'startup-config': 'The saved configuration',
  erase: 'Erase saved data',
  configure: 'Enter configuration mode',
  banner: 'Define a message banner',
  enable: 'Privileged-mode access settings',
  ethernet: 'Ethernet switching events',
  arp: 'Address resolution cache',
  write: 'Save the active configuration',
  address: 'Address settings',
  route: 'Routing settings',
  mask: 'Subnet mask',
  clock: 'Line clock settings',
  controllers: 'Line controller details',
  serial: 'Serial interfaces',
  wifi: 'Wireless network commands',
  connect: 'Join a wireless network',
  dhcp: 'Address lease settings',
  dns: 'Name service settings',
  http: 'Web service settings',
  nd: 'Neighbour discovery settings',
  service: 'Device-wide service switches',
  line: 'Console and remote terminal lines',
  username: 'User names for line login',
  // P2 (ARCHITECTURE-P2 §5; W2 cli)
  range: 'Several interfaces at once',
  vlan: 'VLAN settings',
  switchport: 'Switched-port settings',
  mode: 'Port mode',
  dynamic: 'Negotiate the port mode with the neighbour',
  access: 'Access-port settings',
  trunk: 'Trunk settings',
  native: 'Native VLAN of a trunk',
  allowed: 'VLANs allowed on a trunk',
  voice: 'Voice VLAN settings',
  encapsulation: 'Frame encapsulation',
  status: 'Port status table',
  routing: 'Packet forwarding between interfaces',
  // P2 (ARCHITECTURE-P2 §5.1, §5.2, §5.4; W3 cli)
  'spanning-tree': 'Spanning-tree settings',
  extend: 'Bridge identifier settings',
  portfast: 'Edge-port settings',
  bpduguard: 'Spanning-tree frame guard',
  'detected-protocols': 'Which spanning-tree flavour each port fell back to',
  dtp: 'Trunk negotiation',
  'channel-group': 'Bundle this port into a Port-channel',
  'port-channel': 'Port-channel settings',
  etherchannel: 'Port-channel bundles',
  lacp: 'Link aggregation control',
  'port-security': 'Secure address settings',
  'mac-address': 'Secure address entries',
  errdisable: 'Error-disable settings',
  recovery: 'Automatic recovery settings',
  nat: 'Address translation settings',
  pool: 'Address pool settings',
  inside: 'The private side of the translation',
  source: 'Translate source addresses',
  list: 'Choose the sources with an access list',
  static: 'A fixed translation',
  translation: 'Translation table settings',
  'access-list': 'Access list entries',
  standby: 'First-hop redundancy settings',
  preempt: 'Take the active role back',
  delay: 'Wait before taking over',
  prefix: 'Address prefix settings',
});

/** Help for the parser's pseudo-keywords. Original wording. */
export const PSEUDO_HELP: Readonly<Record<string, string>> = Object.freeze({
  no: 'Undo a setting or restore its default',
  do: 'Run a privileged command from configuration mode',
  '|': 'Filter the output lines',
  section: 'Show only the sections that match a pattern',
  include: 'Show only the lines that match a pattern',
  exclude: 'Hide the lines that match a pattern',
  begin: 'Start output at the first line that matches a pattern',
});
