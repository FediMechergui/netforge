/**
 * cli/grammar/switchport.ts — `switchport` / `no switchport` on Ethernet ports of bridging devices (ARCHITECTURE-P1
 * D3, §3.10, §6), and from P2 the switchport lines of a VLAN-aware switch (ARCHITECTURE-P2 §5.1, D3; §7 W2 cli).
 *
 * `no switchport` asks for the routed role and `switchport` for the switched role; a port whose `allowedRoles`
 * lack the target answers `CLI_MESSAGES.roleLocked` (an NF-C2960 port). The line is stored as a stored negation
 * (`no switchport`), so the routed role survives save and reload; the device runtime performs the role change
 * (address withdrawal, link bounce, `portsVersion`). Help strings are original wording (spec §1.6).
 *
 * P2 (`SWITCHPORT_P2_GRAMMAR`, scoped to `managed-switch`): `switchport mode access|trunk|dynamic auto|dynamic
 * desirable`, `switchport access vlan <v>` (the handler creates a missing VLAN), `switchport trunk native vlan <v>`,
 * `switchport trunk allowed vlan <list>|add|remove|except <list>|all|none` (the handler stores the resolved canonical
 * list), `switchport nonegotiate` (static modes only), [S4] `switchport voice vlan <v>`, and the switching show
 * commands `show interfaces trunk` and `show interfaces [<if>] switchport`. Every line is offered on switched ports
 * and Port-channels, and on routed Ethernet ports so the handler can name the problem (`CLI_MESSAGES.notSwitchport`).
 */
import type { CommandSpec, PortRequirement } from '../../contracts/cli.js';
import { choiceArg, ifaceArg, intArg, kindsPort, NFOS_ONLY } from './core-exec.js';
import { VLAN_AWARE_CAPABILITIES } from './vlan.js';

/** Handler ids of the switchport fragment. */
export const SWITCHPORT_HANDLERS = {
  ifSwitchport: 'if.switchport',
} as const;

/** The switchport command table. */
export const SWITCHPORT_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    path: ['switchport'],
    mode: 'config-if',
    privilege: 15,
    help: 'Bridge this port (no switchport makes it a routed interface)',
    handler: SWITCHPORT_HANDLERS.ifSwitchport,
    allowNo: true,
    grammars: NFOS_ONLY,
    requiresAny: ['switching'],
    portRequires: { kinds: ['ethernet'], roles: ['switched', 'routed'] },
    since: 'P0.5',
    objectives: ['CCNA2.4.1'],
  },
]);

// ── P2: the switchport lines of a VLAN-aware switch (ARCHITECTURE-P2 §5.1) ─────────────────────────────────────

/** @since P2 Handler ids of the P2 switchport lines and show commands. Never rename. */
export const SWITCHPORT_P2_HANDLERS = {
  ifSwitchportMode: 'if.switchport-mode',
  ifSwitchportAccessVlan: 'if.switchport-access-vlan',
  ifSwitchportTrunkNative: 'if.switchport-trunk-native',
  ifSwitchportTrunkAllowed: 'if.switchport-trunk-allowed',
  ifSwitchportNonegotiate: 'if.switchport-nonegotiate',
  ifSwitchportVoiceVlan: 'if.switchport-voice-vlan', // [S4]
  showInterfacesTrunk: 'show.interfaces-trunk',
  showInterfacesSwitchport: 'show.interfaces-switchport',
} as const;

/** @since P2 Arg name the allowed-list handler reads the keyword form from (`fixedArgs`): add, remove, except, all, none. */
export const ALLOWED_FORM_ARG = 'form';
/** @since P2 Arg name of the VLAN list of the allowed-list forms. */
export const ALLOWED_LIST_ARG = 'vlans';

/**
 * @since P2 Port requirement of every switchport line: an Ethernet port or a Port-channel, in a switched, channel or
 * routed role (a routed port reaches the handler, which answers `CLI_MESSAGES.notSwitchport`).
 */
export const SWITCHPORT_LINE_PORT: PortRequirement = Object.freeze<PortRequirement>({ kinds: ['ethernet', 'virtual'], roles: ['switched', 'channel', 'routed'] });

const P2 = SWITCHPORT_P2_HANDLERS;

/** Common members of every P2 switchport interface line. */
const IF_LINE = {
  mode: 'config-if',
  privilege: 15,
  allowNo: true,
  grammars: NFOS_ONLY,
  requiresAny: VLAN_AWARE_CAPABILITIES,
  portRequires: SWITCHPORT_LINE_PORT,
  since: 'P2',
} as const;

/** Common members of the switching show commands. */
const SHOW_LINE = {
  mode: '@exec',
  privilege: 1,
  filterable: true,
  grammars: NFOS_ONLY,
  requiresAny: VLAN_AWARE_CAPABILITIES,
  since: 'P2',
} as const;

/** @since P2 The switchport lines and switching show commands of a VLAN-aware switch. */
export const SWITCHPORT_P2_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    ...IF_LINE,
    path: ['switchport', 'mode', '<mode>'],
    help: 'Fix the port as an access port or a trunk',
    args: { mode: choiceArg('Port mode', ['access', 'trunk']) },
    handler: P2.ifSwitchportMode,
    noArgsOptional: true,
    objectives: ['CCNA2.2.2'],
  },
  {
    ...IF_LINE,
    path: ['switchport', 'mode', 'dynamic', '<wish>'],
    help: 'Negotiate the port mode with the neighbour',
    args: { wish: choiceArg('auto: trunk only if asked; desirable: ask for a trunk', ['auto', 'desirable']) },
    handler: P2.ifSwitchportMode,
    objectives: ['CCNA2.2.2'],
  },
  {
    ...IF_LINE,
    path: ['switchport', 'access', 'vlan', '<vlan>'],
    help: 'VLAN of the frames this access port carries (created when missing)',
    args: { vlan: intArg('VLAN number', 1, 4094) },
    handler: P2.ifSwitchportAccessVlan,
    noArgsOptional: true,
    objectives: ['CCNA2.2.1'],
  },
  {
    ...IF_LINE,
    path: ['switchport', 'trunk', 'native', 'vlan', '<vlan>'],
    help: 'VLAN sent untagged on this trunk',
    args: { vlan: intArg('VLAN number', 1, 4094) },
    handler: P2.ifSwitchportTrunkNative,
    noArgsOptional: true,
    objectives: ['CCNA2.2.2'],
  },
  {
    ...IF_LINE,
    path: ['switchport', 'trunk', 'allowed', 'vlan', `<${ALLOWED_LIST_ARG}>`],
    help: 'VLANs this trunk carries (a list replaces the current one)',
    args: { [ALLOWED_LIST_ARG]: { type: 'vlan-list', help: 'VLAN numbers or ranges, e.g. 1,10,20-30' } },
    handler: P2.ifSwitchportTrunkAllowed,
    noArgsOptional: true,
    objectives: ['CCNA2.2.2'],
  },
  {
    ...IF_LINE,
    path: ['switchport', 'trunk', 'allowed', 'vlan', 'add', `<${ALLOWED_LIST_ARG}>`],
    help: 'Add VLANs to the list this trunk carries',
    args: { [ALLOWED_LIST_ARG]: { type: 'vlan-list', help: 'VLAN numbers or ranges to add' } },
    handler: P2.ifSwitchportTrunkAllowed,
    fixedArgs: { [ALLOWED_FORM_ARG]: 'add' },
    allowNo: false,
    objectives: ['CCNA2.2.2'],
  },
  {
    ...IF_LINE,
    path: ['switchport', 'trunk', 'allowed', 'vlan', 'remove', `<${ALLOWED_LIST_ARG}>`],
    help: 'Remove VLANs from the list this trunk carries',
    args: { [ALLOWED_LIST_ARG]: { type: 'vlan-list', help: 'VLAN numbers or ranges to remove' } },
    handler: P2.ifSwitchportTrunkAllowed,
    fixedArgs: { [ALLOWED_FORM_ARG]: 'remove' },
    allowNo: false,
    objectives: ['CCNA2.2.2'],
  },
  {
    ...IF_LINE,
    path: ['switchport', 'trunk', 'allowed', 'vlan', 'except', `<${ALLOWED_LIST_ARG}>`],
    help: 'Carry every VLAN except these',
    args: { [ALLOWED_LIST_ARG]: { type: 'vlan-list', help: 'VLAN numbers or ranges to leave out' } },
    handler: P2.ifSwitchportTrunkAllowed,
    fixedArgs: { [ALLOWED_FORM_ARG]: 'except' },
    allowNo: false,
    objectives: ['CCNA2.2.2'],
  },
  {
    ...IF_LINE,
    path: ['switchport', 'trunk', 'allowed', 'vlan', 'all'],
    help: 'Carry every VLAN (the default)',
    handler: P2.ifSwitchportTrunkAllowed,
    fixedArgs: { [ALLOWED_FORM_ARG]: 'all' },
    allowNo: false,
    objectives: ['CCNA2.2.2'],
  },
  {
    ...IF_LINE,
    path: ['switchport', 'trunk', 'allowed', 'vlan', 'none'],
    help: 'Carry no VLAN at all',
    handler: P2.ifSwitchportTrunkAllowed,
    fixedArgs: { [ALLOWED_FORM_ARG]: 'none' },
    allowNo: false,
    objectives: ['CCNA2.2.2'],
  },
  {
    ...IF_LINE,
    path: ['switchport', 'nonegotiate'],
    help: 'Send no trunk negotiation frames (access or trunk mode only)',
    handler: P2.ifSwitchportNonegotiate,
    objectives: ['CCNA2.2.2'],
  },
  // [S4] ── voice VLAN ──────────────────────────────────────────────────────────────────────────────────────────
  {
    ...IF_LINE,
    path: ['switchport', 'voice', 'vlan', '<vlan>'],
    help: 'VLAN a phone on this access port tags its own traffic with',
    args: { vlan: intArg('VLAN number', 1, 4094) },
    handler: P2.ifSwitchportVoiceVlan,
    noArgsOptional: true,
    objectives: ['CCNA2.2.1'],
  },
  // [S4] ── end ────────────────────────────────────────────────────────────────────────────────────────────────
  {
    ...SHOW_LINE,
    path: ['show', 'interfaces', 'trunk'],
    help: 'Every trunking port: mode, native VLAN and the VLANs it carries',
    handler: P2.showInterfacesTrunk,
    objectives: ['CCNA2.2.2'],
  },
  {
    ...SHOW_LINE,
    path: ['show', 'interfaces', 'switchport'],
    help: 'Switching settings and state of every switched port',
    handler: P2.showInterfacesSwitchport,
    objectives: ['CCNA2.2.1'],
  },
  {
    ...SHOW_LINE,
    path: ['show', 'interfaces', '<iface>', 'switchport'],
    help: 'Switching settings and state of one port',
    args: { iface: ifaceArg('The port to describe', { portFilter: kindsPort(['ethernet', 'virtual']) }) },
    handler: P2.showInterfacesSwitchport,
    objectives: ['CCNA2.2.1'],
  },
]);
