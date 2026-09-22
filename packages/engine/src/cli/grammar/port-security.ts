/**
 * cli/grammar/port-security.ts — port-security lines and show commands of a VLAN-aware switch (ARCHITECTURE-P2 §3.8,
 * §5.1, §5.4, D12; §7 W3 cli): `switchport port-security` (the enabling line, fixed modes only), `… maximum <n>`,
 * `… violation protect|restrict|shutdown`, `… mac-address <mac>`, `… mac-address sticky` and `… mac-address sticky
 * <mac>` (the form eth-switch writes for a learned sticky address), plus `show port-security [interface <if> |
 * address]`. eth-switch is the consumer: it derives the `port-security` row and the secure CAM rows from these lines.
 *
 * The `port-security` debug category (eth-switch's port-security messages, §5.4) is declared here. Help strings are
 * original wording (spec §1.6).
 */
import type { CommandSpec } from '../../contracts/cli.js';
import { PORT_SECURITY_DEBUG_CATEGORY, PORT_SECURITY_MAX_LIMIT } from '../../protocols/l2/port-security.js';
import { capabilitiesRunning, choiceArg, type GrammarDebugCategory, ifaceArg, intArg, kindsPort, NFOS_ONLY } from './core-exec.js';
import { SWITCHPORT_LINE_PORT } from './switchport.js';
import { VLAN_AWARE_CAPABILITIES } from './vlan.js';

/** Handler ids of the port-security fragment. Never rename. */
export const PORT_SECURITY_HANDLERS = {
  ifPortSecurity: 'if.switchport-port-security',
  ifPortSecurityMaximum: 'if.switchport-port-security-maximum',
  ifPortSecurityViolation: 'if.switchport-port-security-violation',
  ifPortSecurityMacAddress: 'if.switchport-port-security-mac-address',
  ifPortSecuritySticky: 'if.switchport-port-security-sticky',
  showPortSecurity: 'show.port-security',
} as const;

/** Arg name the `show port-security` handler reads its form from (`fixedArgs`): interface or address. */
export const PSEC_SHOW_FORM_ARG = 'form';

/** Violation modes in help order. */
export const PSEC_VIOLATION_MODES = Object.freeze(['protect', 'restrict', 'shutdown'] as const);

/** The port-security debug category (eth-switch's messages; offered where the VLAN-aware bridge runs, §2.6). */
export const PORT_SECURITY_DEBUG_CATEGORIES: readonly GrammarDebugCategory[] = Object.freeze([
  { category: PORT_SECURITY_DEBUG_CATEGORY, help: 'Trace secure address learning and violations', requiresAny: capabilitiesRunning('vlan'), since: 'P2' },
]);

/** Objectives of the port-security debug category. */
export const PORT_SECURITY_DEBUG_OBJECTIVES: Readonly<Record<string, readonly string[]>> = { [PORT_SECURITY_DEBUG_CATEGORY]: ['CCNA2.4.2'] };

const H = PORT_SECURITY_HANDLERS;

const IF_LINE = {
  mode: 'config-if',
  privilege: 15,
  allowNo: true,
  grammars: NFOS_ONLY,
  requiresAny: VLAN_AWARE_CAPABILITIES,
  portRequires: SWITCHPORT_LINE_PORT,
  since: 'P2',
} as const;

const SHOW_LINE = {
  mode: '@exec',
  privilege: 1,
  filterable: true,
  grammars: NFOS_ONLY,
  requiresAny: VLAN_AWARE_CAPABILITIES,
  since: 'P2',
} as const;

/** The port-security command table. */
export const PORT_SECURITY_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    ...IF_LINE,
    path: ['switchport', 'port-security'],
    help: 'Allow only a limited set of source addresses on this port (access or trunk mode only)',
    handler: H.ifPortSecurity,
    objectives: ['CCNA2.4.2'],
  },
  {
    ...IF_LINE,
    path: ['switchport', 'port-security', 'maximum', '<count>'],
    help: 'How many secure addresses this port may hold (default 1)',
    args: { count: intArg('Number of addresses', 1, PORT_SECURITY_MAX_LIMIT) },
    handler: H.ifPortSecurityMaximum,
    noArgsOptional: true,
    objectives: ['CCNA2.4.2'],
  },
  {
    ...IF_LINE,
    path: ['switchport', 'port-security', 'violation', '<mode>'],
    help: 'What happens to a frame from an address the port does not allow (default shutdown)',
    args: { mode: choiceArg('protect: drop; restrict: drop, count and log; shutdown: error-disable the port', PSEC_VIOLATION_MODES) },
    handler: H.ifPortSecurityViolation,
    noArgsOptional: true,
    objectives: ['CCNA2.4.2'],
  },
  {
    ...IF_LINE,
    path: ['switchport', 'port-security', 'mac-address', '<mac>'],
    help: 'An address this port always allows',
    args: { mac: { type: 'mac-any', help: 'MAC address, e.g. aabb.cc00.0100' } },
    handler: H.ifPortSecurityMacAddress,
    objectives: ['CCNA2.4.2'],
  },
  {
    ...IF_LINE,
    path: ['switchport', 'port-security', 'mac-address', 'sticky'],
    help: 'Keep the addresses this port learns as part of the configuration',
    handler: H.ifPortSecuritySticky,
    objectives: ['CCNA2.4.2'],
  },
  {
    ...IF_LINE,
    path: ['switchport', 'port-security', 'mac-address', 'sticky', '<mac>'],
    help: 'A learned sticky address (written by the switch; may also be typed)',
    args: { mac: { type: 'mac-any', help: 'MAC address, e.g. aabb.cc00.0100' } },
    handler: H.ifPortSecuritySticky,
    objectives: ['CCNA2.4.2'],
  },
  {
    ...SHOW_LINE,
    path: ['show', 'port-security'],
    help: 'Every secured port: maximum, addresses in use, violation mode and count',
    handler: H.showPortSecurity,
    objectives: ['CCNA2.4.2'],
  },
  {
    ...SHOW_LINE,
    path: ['show', 'port-security', 'interface', '<iface>'],
    help: 'Port security settings and state of one port',
    args: { iface: ifaceArg('The port', { portFilter: kindsPort(['ethernet', 'virtual']) }) },
    handler: H.showPortSecurity,
    fixedArgs: { [PSEC_SHOW_FORM_ARG]: 'interface' },
    objectives: ['CCNA2.4.2'],
  },
  {
    ...SHOW_LINE,
    path: ['show', 'port-security', 'address'],
    help: 'Every secure address: VLAN, address, how it became secure and its port',
    handler: H.showPortSecurity,
    fixedArgs: { [PSEC_SHOW_FORM_ARG]: 'address' },
    objectives: ['CCNA2.4.2'],
  },
]);
