/**
 * cli/grammar/hsrp.ts — [SHOULD S2] first-hop redundancy lines and `show standby` (ARCHITECTURE-P2 §3.10, §5.2, §5.4;
 * §7 W3 cli [S2]): `standby version 1|2`, `standby [<g>] ip [<a>]`, `standby [<g>] priority <n>`, `standby [<g>]
 * preempt [delay minimum <s>]`, `standby [<g>] timers <hello> <hold>` on an interface that holds addresses, plus
 * `show standby [brief]`. The hsrp daemon is the consumer; the CLI validates (group range per version, timers) and
 * stores the lines as typed (a group-less line is group 0).
 *
 * Scope: the `routing` capability (the S2 item adds `hsrp` to it in the W4 catalog). The interface lines are scoped to
 * the port roles `routed`, `subif` and `svi` (`STANDBY_PORT`, architect ruling of 2026-09-23, ARCHITECTURE-P2 §9.2
 * item 20e): a standby group needs a shared multi-access segment on which a virtual MAC can answer ARP, so neither
 * the `wan` role (the point-to-point serial links) nor `virtual` (loopbacks) nor `mgmt` takes one; the one mismatch
 * message (`CLI_MESSAGES.standbyNotHere`) also points a switched port at `no switchport`. `show standby` and the
 * `standby` debug category keep their capability scope. The `standby` debug category (§5.4) is declared here. Help
 * strings are original wording (spec §1.6).
 */
import { CLI_MESSAGES, type CommandSpec, type PortRequirement } from '../../contracts/cli.js';
import type { Capability } from '../../contracts/catalog.js';
import { capabilitiesRunning, choiceArg, type GrammarDebugCategory, intArg, ipv4Arg, NFOS_ONLY } from './core-exec.js';

/** Handler ids of the HSRP fragment. Never rename. */
export const HSRP_HANDLERS = {
  ifStandbyVersion: 'if.standby-version',
  ifStandbyIp: 'if.standby-ip',
  ifStandbyPriority: 'if.standby-priority',
  ifStandbyPreempt: 'if.standby-preempt',
  ifStandbyTimers: 'if.standby-timers',
  showStandby: 'show.standby',
} as const;

/** Capabilities that run the hsrp daemon (added to `routing` by the S2 catalog change). */
export const HSRP_CAPABILITIES: readonly Capability[] = Object.freeze(['routing']);

/** Highest group number per version (§3.10 step 7). */
export const HSRP_V1_GROUP_MAX = 255;
export const HSRP_V2_GROUP_MAX = 4095;
/** Priority bounds. */
export const HSRP_PRIORITY_MAX = 255;
/** Timer bounds (seconds): hello 1-254, hold 2-255 and above the hello. */
export const HSRP_HELLO_MIN_S = 1;
export const HSRP_HELLO_MAX_S = 254;
export const HSRP_HOLD_MIN_S = 2;
export const HSRP_HOLD_MAX_S = 255;
/** Preempt delay bounds (seconds). */
export const HSRP_PREEMPT_DELAY_MAX_S = 3600;

/**
 * Port requirement of the `standby` interface lines (architect ruling of 2026-09-23, §9.2 item 20e): a routed port,
 * a router subinterface or an SVI — the roles on a shared LAN segment.
 */
export const STANDBY_PORT: PortRequirement = Object.freeze<PortRequirement>({ roles: Object.freeze(['routed', 'subif', 'svi'] as const), mismatch: CLI_MESSAGES.standbyNotHere });

/** Arg name of `show standby brief` (`fixedArgs`). */
export const HSRP_SHOW_BRIEF_ARG = 'brief';

/** Debug category of the hsrp daemon (§5.4, binding). */
export const HSRP_DEBUG_CATEGORY = 'standby';

/** The HSRP debug category (offered where the daemon runs, §2.1). */
export const HSRP_DEBUG_CATEGORIES: readonly GrammarDebugCategory[] = Object.freeze([
  { category: HSRP_DEBUG_CATEGORY, help: 'Trace standby group hellos, elections and state changes', requiresAny: capabilitiesRunning('hsrp'), since: 'P2' },
]);

/** Objectives of the HSRP debug category. */
export const HSRP_DEBUG_OBJECTIVES: Readonly<Record<string, readonly string[]>> = { [HSRP_DEBUG_CATEGORY]: ['CCNA2.11.1'] };

const H = HSRP_HANDLERS;

const IF_LINE = {
  mode: 'config-if',
  privilege: 15,
  allowNo: true,
  grammars: NFOS_ONLY,
  requiresAny: HSRP_CAPABILITIES,
  portRequires: STANDBY_PORT,
  since: 'P2',
  objectives: ['CCNA2.11.1'],
} as const;

const GROUP_ARG = intArg('Standby group number (0-255 in version 1, 0-4095 in version 2)', 0, HSRP_V2_GROUP_MAX);
const PRIORITY_ARG = intArg('Priority; the highest wins the active role (default 100)', 0, HSRP_PRIORITY_MAX);
const HELLO_ARG = intArg('Seconds between hellos (default 3)', HSRP_HELLO_MIN_S, HSRP_HELLO_MAX_S);
const HOLD_ARG = intArg('Seconds without hellos before the active router is given up (default 10)', HSRP_HOLD_MIN_S, HSRP_HOLD_MAX_S);
const DELAY_ARG = intArg('Seconds to wait after coming up before taking over', 0, HSRP_PREEMPT_DELAY_MAX_S);

/** The HSRP command table. */
export const HSRP_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    ...IF_LINE,
    path: ['standby', 'version', '<version>'],
    help: 'Protocol version of every group on this interface (2 allows groups up to 4095)',
    args: { version: choiceArg('1 or 2', ['1', '2']) },
    handler: H.ifStandbyVersion,
    noArgsOptional: true,
  },
  {
    ...IF_LINE,
    path: ['standby', 'ip', '<address>'],
    help: 'Virtual gateway address of group 0 (start the group)',
    args: { address: ipv4Arg('Virtual address shared by the routers of the group', true) },
    handler: H.ifStandbyIp,
    noArgsOptional: true,
  },
  {
    ...IF_LINE,
    path: ['standby', '<group>', 'ip', '<address>'],
    help: 'Virtual gateway address of this group (start the group)',
    args: { group: GROUP_ARG, address: ipv4Arg('Virtual address shared by the routers of the group', true) },
    handler: H.ifStandbyIp,
    noArgsOptional: true,
  },
  {
    ...IF_LINE,
    path: ['standby', 'priority', '<priority>'],
    help: 'Priority of this router in group 0',
    args: { priority: PRIORITY_ARG },
    handler: H.ifStandbyPriority,
    noArgsOptional: true,
  },
  {
    ...IF_LINE,
    path: ['standby', '<group>', 'priority', '<priority>'],
    help: 'Priority of this router in this group',
    args: { group: GROUP_ARG, priority: PRIORITY_ARG },
    handler: H.ifStandbyPriority,
    noArgsOptional: true,
  },
  {
    ...IF_LINE,
    path: ['standby', 'preempt'],
    help: 'Take the active role of group 0 back whenever this router has the higher priority',
    handler: H.ifStandbyPreempt,
  },
  {
    ...IF_LINE,
    path: ['standby', 'preempt', 'delay', 'minimum', '<seconds>'],
    help: 'Take over group 0 after waiting this long once the router comes up',
    args: { seconds: DELAY_ARG },
    handler: H.ifStandbyPreempt,
  },
  {
    ...IF_LINE,
    path: ['standby', '<group>', 'preempt'],
    help: 'Take the active role of this group back whenever this router has the higher priority',
    args: { group: GROUP_ARG },
    handler: H.ifStandbyPreempt,
  },
  {
    ...IF_LINE,
    path: ['standby', '<group>', 'preempt', 'delay', 'minimum', '<seconds>'],
    help: 'Take over this group after waiting this long once the router comes up',
    args: { group: GROUP_ARG, seconds: DELAY_ARG },
    handler: H.ifStandbyPreempt,
  },
  {
    ...IF_LINE,
    path: ['standby', 'timers', '<hello>', '<hold>'],
    help: 'Hello and hold times of group 0, in seconds',
    args: { hello: HELLO_ARG, hold: HOLD_ARG },
    handler: H.ifStandbyTimers,
    noArgsOptional: true,
  },
  {
    ...IF_LINE,
    path: ['standby', '<group>', 'timers', '<hello>', '<hold>'],
    help: 'Hello and hold times of this group, in seconds',
    args: { group: GROUP_ARG, hello: HELLO_ARG, hold: HOLD_ARG },
    handler: H.ifStandbyTimers,
    noArgsOptional: true,
  },
  {
    path: ['show', 'standby'],
    mode: '@exec',
    privilege: 1,
    help: 'Every standby group in full: state, virtual address and MAC, priority, timers, active and standby routers',
    handler: H.showStandby,
    filterable: true,
    grammars: NFOS_ONLY,
    requiresAny: HSRP_CAPABILITIES,
    since: 'P2',
    objectives: ['CCNA2.11.1'],
  },
  {
    path: ['show', 'standby', 'brief'],
    mode: '@exec',
    privilege: 1,
    help: 'One line per standby group',
    handler: H.showStandby,
    fixedArgs: { [HSRP_SHOW_BRIEF_ARG]: 'brief' },
    filterable: true,
    grammars: NFOS_ONLY,
    requiresAny: HSRP_CAPABILITIES,
    since: 'P2',
    objectives: ['CCNA2.11.1'],
  },
]);
