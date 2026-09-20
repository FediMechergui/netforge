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
 * transport, traceroute, passwords and lines) and the host shell. Scoping is capability-, grammar- and
 * port-role-driven (`grammars`, `requires`, `requiresAny`, `portRequires`); no spec names a device kind.
 *
 * `HANDLERS` is the union of every fragment's handler ids (frozen names shared with the runtime and handler
 * owners), `DEBUG_CATEGORY_DEFS` the debug category registry. Every string is original wording (spec §1.6).
 */
import type { CommandSpec } from '../../contracts/cli.js';
import { CORE_DEBUG_CATEGORIES, CORE_EXEC_GRAMMAR, CORE_EXEC_HANDLERS, type GrammarDebugCategory } from './core-exec.js';
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

/** Handler ids resolved by the CLI runtime's registry: the union of every fragment. Never rename. */
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
});

/** Union of every handler id in `HANDLERS`. */
export type HandlerId = (typeof HANDLERS)[keyof typeof HANDLERS];

/** The grammar fragments by name, in table order (focused tests and runtime injection). */
export const GRAMMAR_FRAGMENTS: Readonly<Record<string, readonly CommandSpec[]>> = Object.freeze({
  'core-exec': CORE_EXEC_GRAMMAR,
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
});

/** The full built-in command table: every fragment concatenated in `GRAMMAR_FRAGMENTS` order. */
export const GRAMMAR: readonly CommandSpec[] = Object.freeze(Object.values(GRAMMAR_FRAGMENTS).flat());

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
