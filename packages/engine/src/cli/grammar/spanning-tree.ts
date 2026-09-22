/**
 * cli/grammar/spanning-tree.ts — the spanning-tree lines of a VLAN-aware switch (ARCHITECTURE-P2 §3.6, §5.1, §5.4,
 * D9; §7 W3 cli), the `root primary|secondary` macro, `clear spanning-tree detected-protocols`, `show spanning-tree`
 * in every §5.4 form and `show dtp interface <if>`.
 *
 * Global: `spanning-tree mode pvst|rapid-pvst` (its `no` form restores the device's default, §5), `spanning-tree
 * extend system-id` (its `no` form is refused), `spanning-tree vlan <list> priority <p>`, `spanning-tree vlan <list>
 * root primary|secondary` (the handler stores priorities), `no spanning-tree vlan <list>`, `spanning-tree portfast
 * default`, `spanning-tree portfast bpduguard default`. Interface: `spanning-tree portfast [trunk|disable]`,
 * `spanning-tree bpduguard enable|disable`, `spanning-tree guard root|none`, `spanning-tree cost <n>`,
 * `spanning-tree port-priority <n>`, `spanning-tree vlan <list> cost|port-priority <n>`. The [S5] timer, loop-guard
 * and `clear errdisable` lines are not built (§8.5).
 *
 * The L2 control-plane debug categories of §5.4 that no earlier fragment registered (`sw-vlan`, `dtp`,
 * `spanning-tree events`) are declared here; their `debug` specs are keyed on the daemon's capability rows, so they
 * appear exactly when the W4 catalog registers the daemons (§2.1). Help strings are original wording (spec §1.6).
 */
import type { CommandSpec } from '../../contracts/cli.js';
import { STP_COST_MAX, STP_COST_MIN } from '../../protocols/stp/cost.js';
import { STP_BRIDGE_PRIORITY_MAX, STP_PORT_PRIORITY_MAX } from '../../protocols/stp/ids.js';
import { capabilitiesRunning, choiceArg, type GrammarDebugCategory, ifaceArg, intArg, kindsPort, NFOS_ONLY } from './core-exec.js';
import { SWITCHPORT_LINE_PORT } from './switchport.js';
import { VLAN_AWARE_CAPABILITIES } from './vlan.js';

/** Handler ids of the spanning-tree fragment. Shared with the runtime and handler owners — never rename. */
export const SPANNING_TREE_HANDLERS = {
  configStpMode: 'config.spanning-tree-mode',
  configStpExtend: 'config.spanning-tree-extend',
  configStpVlanPriority: 'config.spanning-tree-vlan-priority',
  configStpVlanRoot: 'config.spanning-tree-vlan-root',
  configStpVlan: 'config.spanning-tree-vlan',
  configStpPortfastDefault: 'config.spanning-tree-portfast-default',
  configStpBpduguardDefault: 'config.spanning-tree-portfast-bpduguard-default',
  ifStpPortfast: 'if.spanning-tree-portfast',
  ifStpBpduguard: 'if.spanning-tree-bpduguard',
  ifStpGuard: 'if.spanning-tree-guard',
  ifStpCost: 'if.spanning-tree-cost',
  ifStpPortPriority: 'if.spanning-tree-port-priority',
  ifStpVlanCost: 'if.spanning-tree-vlan-cost',
  ifStpVlanPortPriority: 'if.spanning-tree-vlan-port-priority',
  showSpanningTree: 'show.spanning-tree',
  showDtpInterface: 'show.dtp-interface',
  execClearStpDetected: 'exec.clear-spanning-tree-detected',
} as const;

/** Arg name the `show spanning-tree` handler reads its form from (`fixedArgs`): summary, root or interface. */
export const STP_SHOW_FORM_ARG = 'form';
/** Arg name of the `detail` flag of `show spanning-tree interface <if> detail` (`fixedArgs`). */
export const STP_SHOW_DETAIL_ARG = 'detail';

/**
 * Request kind the CLI sends to the stp daemon for `clear spanning-tree detected-protocols [interface <if>]`
 * (§3.6 Mixed modes step 3). No built-in `ProcessRequest` kind exists for it (§2.4), so it uses the `ext.` slot:
 * `{ kind: STP_CLEAR_DETECTED_REQUEST, port?: PortId, session: SessionId }` — every port when `port` is absent.
 */
export const STP_CLEAR_DETECTED_REQUEST = 'ext.stp.clear-detected-protocols';

/** Debug category of the stp daemon (§5.4, binding; the daemon exports the same string from protocols/stp.ts). */
const STP_DEBUG_CATEGORY = 'spanning-tree events';

/**
 * The L2 control-plane debug categories of §5.4: the VLAN database (`sw-vlan`), trunk negotiation (`dtp`) and
 * spanning tree. Each is offered on the capabilities whose daemon list holds its daemon (§2.1 rows, filled by W4).
 */
export const L2_CONTROL_DEBUG_CATEGORIES: readonly GrammarDebugCategory[] = Object.freeze([
  { category: 'sw-vlan', help: 'Trace VLAN database changes', requiresAny: capabilitiesRunning('vlan'), since: 'P2' },
  { category: 'dtp', help: 'Trace trunk negotiation frames and mode changes', requiresAny: capabilitiesRunning('dtp'), since: 'P2' },
  { category: STP_DEBUG_CATEGORY, help: 'Trace spanning-tree role and state changes, elections and topology changes', requiresAny: capabilitiesRunning('stp'), since: 'P2' },
]);

/** Objectives of the L2 control-plane debug categories. */
export const L2_CONTROL_DEBUG_OBJECTIVES: Readonly<Record<string, readonly string[]>> = {
  'sw-vlan': ['CCNA2.2.1'],
  dtp: ['CCNA2.2.2'],
  [STP_DEBUG_CATEGORY]: ['CCNA2.5.1'],
};

const H = SPANNING_TREE_HANDLERS;

/** Common members of the global spanning-tree lines. */
const GLOBAL_LINE = {
  mode: 'config',
  privilege: 15,
  grammars: NFOS_ONLY,
  requiresAny: VLAN_AWARE_CAPABILITIES,
  since: 'P2',
} as const;

/** Common members of the interface spanning-tree lines (switched ports and Port-channels; a routed port is told why). */
const IF_LINE = {
  mode: 'config-if',
  privilege: 15,
  allowNo: true,
  grammars: NFOS_ONLY,
  requiresAny: VLAN_AWARE_CAPABILITIES,
  portRequires: SWITCHPORT_LINE_PORT,
  since: 'P2',
} as const;

/** Common members of the show commands. */
const SHOW_LINE = {
  mode: '@exec',
  privilege: 1,
  filterable: true,
  grammars: NFOS_ONLY,
  requiresAny: VLAN_AWARE_CAPABILITIES,
  since: 'P2',
} as const;

const VLAN_LIST_ARG = { type: 'vlan-list', help: 'VLAN numbers or ranges, e.g. 1,10,20-30' } as const;
const STP_IFACE = ifaceArg('The port', { portFilter: kindsPort(['ethernet', 'virtual']) });

/** The spanning-tree command table. */
export const SPANNING_TREE_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  // ── global ──────────────────────────────────────────────────────────────────────────────────────────────────
  {
    ...GLOBAL_LINE,
    path: ['spanning-tree', 'mode', '<mode>'],
    help: 'Spanning-tree flavour: pvst (one classic tree per VLAN) or rapid-pvst (one rapid tree per VLAN)',
    args: { mode: choiceArg('Tree flavour', ['pvst', 'rapid-pvst']) },
    handler: H.configStpMode,
    allowNo: true,
    noArgsOptional: true,
    objectives: ['CCNA2.5.1'],
  },
  {
    ...GLOBAL_LINE,
    path: ['spanning-tree', 'extend', 'system-id'],
    help: 'Add the VLAN number to the bridge priority (always on; cannot be switched off)',
    handler: H.configStpExtend,
    allowNo: true,
    objectives: ['CCNA2.5.1'],
  },
  {
    ...GLOBAL_LINE,
    path: ['spanning-tree', 'vlan', '<vlans>', 'priority', '<priority>'],
    help: 'Bridge priority for these VLANs (a multiple of 4096; lower wins the root election)',
    args: { vlans: VLAN_LIST_ARG, priority: intArg('Priority, a multiple of 4096', 0, STP_BRIDGE_PRIORITY_MAX) },
    handler: H.configStpVlanPriority,
    allowNo: true,
    noArgsOptional: true,
    objectives: ['CCNA2.5.2'],
  },
  {
    ...GLOBAL_LINE,
    path: ['spanning-tree', 'vlan', '<vlans>', 'root', '<which>'],
    help: 'Set a priority that makes this switch the root (primary) or the backup root (secondary) of these VLANs',
    args: { vlans: VLAN_LIST_ARG, which: choiceArg('primary: become the root; secondary: become the backup root', ['primary', 'secondary']) },
    handler: H.configStpVlanRoot,
    objectives: ['CCNA2.5.2'],
  },
  {
    ...GLOBAL_LINE,
    path: ['spanning-tree', 'vlan', '<vlans>'],
    help: 'Run spanning tree for these VLANs (no spanning-tree vlan switches it off for them)',
    args: { vlans: VLAN_LIST_ARG },
    handler: H.configStpVlan,
    allowNo: true,
    objectives: ['CCNA2.5.1'],
  },
  {
    ...GLOBAL_LINE,
    path: ['spanning-tree', 'portfast', 'default'],
    help: 'Treat every non-trunking port as an edge port that forwards at once',
    handler: H.configStpPortfastDefault,
    allowNo: true,
    objectives: ['CCNA2.5.3'],
  },
  {
    ...GLOBAL_LINE,
    path: ['spanning-tree', 'portfast', 'bpduguard', 'default'],
    help: 'Error-disable every edge port that receives a spanning-tree frame',
    handler: H.configStpBpduguardDefault,
    allowNo: true,
    objectives: ['CCNA2.5.3'],
  },
  // ── interface ───────────────────────────────────────────────────────────────────────────────────────────────
  {
    ...IF_LINE,
    path: ['spanning-tree', 'portfast', '<kind>'],
    help: 'Edge port: forward at once instead of waiting through listening and learning',
    args: { kind: choiceArg('trunk: also while trunking; disable: never an edge port', ['trunk', 'disable'], true) },
    handler: H.ifStpPortfast,
    objectives: ['CCNA2.5.3'],
  },
  {
    ...IF_LINE,
    path: ['spanning-tree', 'bpduguard', '<mode>'],
    help: 'Error-disable this port when a spanning-tree frame arrives',
    args: { mode: choiceArg('enable or disable the guard', ['enable', 'disable']) },
    handler: H.ifStpBpduguard,
    noArgsOptional: true,
    objectives: ['CCNA2.5.3'],
  },
  {
    ...IF_LINE,
    path: ['spanning-tree', 'guard', '<mode>'],
    help: 'Root guard: block this port when a better root appears behind it',
    args: { mode: choiceArg('root: keep the root on this side; none: no guard', ['root', 'none']) },
    handler: H.ifStpGuard,
    noArgsOptional: true,
    objectives: ['CCNA2.5.3'],
  },
  {
    ...IF_LINE,
    path: ['spanning-tree', 'cost', '<cost>'],
    help: 'Path cost of this port in every VLAN (overrides the value derived from the speed)',
    args: { cost: intArg('Path cost', STP_COST_MIN, STP_COST_MAX) },
    handler: H.ifStpCost,
    noArgsOptional: true,
    objectives: ['CCNA2.5.2'],
  },
  {
    ...IF_LINE,
    path: ['spanning-tree', 'port-priority', '<priority>'],
    help: 'Port priority in every VLAN (a multiple of 16; lower is preferred)',
    args: { priority: intArg('Port priority, a multiple of 16', 0, STP_PORT_PRIORITY_MAX) },
    handler: H.ifStpPortPriority,
    noArgsOptional: true,
    objectives: ['CCNA2.5.2'],
  },
  {
    ...IF_LINE,
    path: ['spanning-tree', 'vlan', '<vlans>', 'cost', '<cost>'],
    help: 'Path cost of this port for these VLANs only',
    args: { vlans: VLAN_LIST_ARG, cost: intArg('Path cost', STP_COST_MIN, STP_COST_MAX) },
    handler: H.ifStpVlanCost,
    noArgsOptional: true,
    objectives: ['CCNA2.5.2'],
  },
  {
    ...IF_LINE,
    path: ['spanning-tree', 'vlan', '<vlans>', 'port-priority', '<priority>'],
    help: 'Port priority for these VLANs only (a multiple of 16)',
    args: { vlans: VLAN_LIST_ARG, priority: intArg('Port priority, a multiple of 16', 0, STP_PORT_PRIORITY_MAX) },
    handler: H.ifStpVlanPortPriority,
    noArgsOptional: true,
    objectives: ['CCNA2.5.2'],
  },
  // ── show spanning-tree [vlan <v>] [summary | root | interface <if> [detail]] ─────────────────────────────────
  {
    ...SHOW_LINE,
    path: ['show', 'spanning-tree'],
    help: 'Every spanning-tree instance: root, bridge id, timers and the role and state of each port',
    handler: H.showSpanningTree,
    objectives: ['CCNA2.5.1'],
  },
  {
    ...SHOW_LINE,
    path: ['show', 'spanning-tree', 'vlan', '<vlan>'],
    help: 'The spanning-tree instance of one VLAN',
    args: { vlan: intArg('VLAN number', 1, 4094) },
    handler: H.showSpanningTree,
    objectives: ['CCNA2.5.1'],
  },
  {
    ...SHOW_LINE,
    path: ['show', 'spanning-tree', 'summary'],
    help: 'Mode, global settings and a per-VLAN count of ports in each state',
    handler: H.showSpanningTree,
    fixedArgs: { [STP_SHOW_FORM_ARG]: 'summary' },
    objectives: ['CCNA2.5.1'],
  },
  {
    ...SHOW_LINE,
    path: ['show', 'spanning-tree', 'vlan', '<vlan>', 'summary'],
    help: 'Port-state counts of one VLAN',
    args: { vlan: intArg('VLAN number', 1, 4094) },
    handler: H.showSpanningTree,
    fixedArgs: { [STP_SHOW_FORM_ARG]: 'summary' },
    objectives: ['CCNA2.5.1'],
  },
  {
    ...SHOW_LINE,
    path: ['show', 'spanning-tree', 'root'],
    help: 'The root bridge of every VLAN, with the cost and port that reach it',
    handler: H.showSpanningTree,
    fixedArgs: { [STP_SHOW_FORM_ARG]: 'root' },
    objectives: ['CCNA2.5.2'],
  },
  {
    ...SHOW_LINE,
    path: ['show', 'spanning-tree', 'vlan', '<vlan>', 'root'],
    help: 'The root bridge of one VLAN',
    args: { vlan: intArg('VLAN number', 1, 4094) },
    handler: H.showSpanningTree,
    fixedArgs: { [STP_SHOW_FORM_ARG]: 'root' },
    objectives: ['CCNA2.5.2'],
  },
  {
    ...SHOW_LINE,
    path: ['show', 'spanning-tree', 'interface', '<iface>'],
    help: 'Role, state and cost of one port in every VLAN',
    args: { iface: STP_IFACE },
    handler: H.showSpanningTree,
    fixedArgs: { [STP_SHOW_FORM_ARG]: 'interface' },
    objectives: ['CCNA2.5.1'],
  },
  {
    ...SHOW_LINE,
    path: ['show', 'spanning-tree', 'interface', '<iface>', 'detail'],
    help: 'Everything spanning tree knows about one port, per VLAN',
    args: { iface: STP_IFACE },
    handler: H.showSpanningTree,
    fixedArgs: { [STP_SHOW_FORM_ARG]: 'interface', [STP_SHOW_DETAIL_ARG]: 'detail' },
    objectives: ['CCNA2.5.1'],
  },
  {
    ...SHOW_LINE,
    path: ['show', 'spanning-tree', 'vlan', '<vlan>', 'interface', '<iface>'],
    help: 'Role, state and cost of one port in one VLAN',
    args: { vlan: intArg('VLAN number', 1, 4094), iface: STP_IFACE },
    handler: H.showSpanningTree,
    fixedArgs: { [STP_SHOW_FORM_ARG]: 'interface' },
    objectives: ['CCNA2.5.1'],
  },
  {
    ...SHOW_LINE,
    path: ['show', 'spanning-tree', 'vlan', '<vlan>', 'interface', '<iface>', 'detail'],
    help: 'Everything spanning tree knows about one port in one VLAN',
    args: { vlan: intArg('VLAN number', 1, 4094), iface: STP_IFACE },
    handler: H.showSpanningTree,
    fixedArgs: { [STP_SHOW_FORM_ARG]: 'interface', [STP_SHOW_DETAIL_ARG]: 'detail' },
    objectives: ['CCNA2.5.1'],
  },
  // ── show dtp interface <if> ─────────────────────────────────────────────────────────────────────────────────
  {
    ...SHOW_LINE,
    path: ['show', 'dtp', 'interface', '<iface>'],
    help: 'Trunk negotiation state of one port: configured and operational mode, neighbour',
    args: { iface: STP_IFACE },
    handler: H.showDtpInterface,
    objectives: ['CCNA2.2.2'],
  },
  // ── clear spanning-tree detected-protocols [interface <if>] ─────────────────────────────────────────────────
  {
    path: ['clear', 'spanning-tree', 'detected-protocols'],
    mode: 'priv-exec',
    privilege: 15,
    help: 'Forget which ports fell back to classic spanning tree and let them negotiate the rapid flavour again',
    handler: H.execClearStpDetected,
    grammars: NFOS_ONLY,
    requiresAny: VLAN_AWARE_CAPABILITIES,
    since: 'P2',
    objectives: ['CCNA2.5.1'],
  },
  {
    path: ['clear', 'spanning-tree', 'detected-protocols', 'interface', '<iface>'],
    mode: 'priv-exec',
    privilege: 15,
    help: 'Let one port negotiate the rapid flavour again',
    args: { iface: STP_IFACE },
    handler: H.execClearStpDetected,
    grammars: NFOS_ONLY,
    requiresAny: VLAN_AWARE_CAPABILITIES,
    since: 'P2',
    objectives: ['CCNA2.5.1'],
  },
]);
