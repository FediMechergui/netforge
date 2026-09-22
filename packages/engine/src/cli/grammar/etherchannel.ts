/**
 * cli/grammar/etherchannel.ts — EtherChannel lines and show commands of a VLAN-aware switch (ARCHITECTURE-P2 §3.7,
 * §5.1, §5.4, D10; §7 W3 cli): `channel-group <n> mode on|active|passive|desirable|auto` on a switched port (the
 * handler creates `interface Port-channel<n>` when missing and copies the member's switchport lines into it),
 * `port-channel load-balance <method>`, `show etherchannel summary`, `show etherchannel port-channel` and [S3]
 * `show lacp neighbor`. The [S5] EtherChannel guard has no line (§8.5).
 *
 * The `etherchannel` debug category (§5.4) is declared here; its `debug` spec is keyed on the daemon's capability
 * rows, so it appears when the W4 catalog registers the daemon. Help strings are original wording (spec §1.6).
 */
import type { CommandSpec, PortRequirement } from '../../contracts/cli.js';
import { LOAD_BALANCE_METHODS } from '../../protocols/l2/lag-hash.js';
import { capabilitiesRunning, choiceArg, type GrammarDebugCategory, intArg, NFOS_ONLY } from './core-exec.js';
import { VLAN_AWARE_CAPABILITIES } from './vlan.js';

/** Handler ids of the EtherChannel fragment. Never rename. */
export const ETHERCHANNEL_HANDLERS = {
  ifChannelGroup: 'if.channel-group',
  configPortChannelLoadBalance: 'config.port-channel-load-balance',
  showEtherchannelSummary: 'show.etherchannel-summary',
  showEtherchannelPortChannel: 'show.etherchannel-port-channel',
  showLacpNeighbor: 'show.lacp-neighbor', // [S3]
} as const;

/** Lowest and highest channel-group number (`Port-channel1` … `Port-channel48`, D10). */
export const CHANNEL_GROUP_MIN = 1;
export const CHANNEL_GROUP_MAX = 48;

/** `channel-group … mode` choices, in help order. */
export const CHANNEL_MODES = Object.freeze(['on', 'active', 'passive', 'desirable', 'auto'] as const);

/** Debug category of the etherchannel daemon (lacp, pagp, static; §5.4, binding; the daemon exports the same string). */
const ETHERCHANNEL_DEBUG_CATEGORY = 'etherchannel';

/** The EtherChannel debug category (offered where the daemon runs, §2.1). */
export const ETHERCHANNEL_DEBUG_CATEGORIES: readonly GrammarDebugCategory[] = Object.freeze([
  { category: ETHERCHANNEL_DEBUG_CATEGORY, help: 'Trace bundle negotiation and member state changes', requiresAny: capabilitiesRunning('etherchannel'), since: 'P2' },
]);

/** Objectives of the EtherChannel debug category. */
export const ETHERCHANNEL_DEBUG_OBJECTIVES: Readonly<Record<string, readonly string[]>> = { [ETHERCHANNEL_DEBUG_CATEGORY]: ['CCNA2.6.1'] };

/** `channel-group` is typed on a physical switched port (a Port-channel or a routed port is told why by the handler). */
export const CHANNEL_MEMBER_PORT: PortRequirement = Object.freeze<PortRequirement>({ kinds: ['ethernet', 'virtual'], roles: ['switched', 'channel', 'routed'] });

const H = ETHERCHANNEL_HANDLERS;

const SHOW_LINE = {
  mode: '@exec',
  privilege: 1,
  filterable: true,
  grammars: NFOS_ONLY,
  requiresAny: VLAN_AWARE_CAPABILITIES,
  since: 'P2',
} as const;

/** The EtherChannel command table. */
export const ETHERCHANNEL_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    // the short `no channel-group` form; typed positively it asks for the group and mode
    path: ['channel-group'],
    mode: 'config-if',
    privilege: 15,
    help: 'Leave the bundle (no channel-group)',
    handler: H.ifChannelGroup,
    allowNo: true,
    hidden: true,
    grammars: NFOS_ONLY,
    requiresAny: VLAN_AWARE_CAPABILITIES,
    portRequires: CHANNEL_MEMBER_PORT,
    since: 'P2',
    objectives: ['CCNA2.6.1'],
  },
  {
    path: ['channel-group', '<group>', 'mode', '<mode>'],
    mode: 'config-if',
    privilege: 15,
    help: 'Bundle this port into Port-channel<n>: on (no negotiation), active/passive (LACP) or desirable/auto (PAgP)',
    args: {
      group: intArg('Channel group number', CHANNEL_GROUP_MIN, CHANNEL_GROUP_MAX),
      mode: choiceArg('on: static; active/passive: LACP; desirable/auto: PAgP', CHANNEL_MODES),
    },
    handler: H.ifChannelGroup,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    requiresAny: VLAN_AWARE_CAPABILITIES,
    portRequires: CHANNEL_MEMBER_PORT,
    since: 'P2',
    objectives: ['CCNA2.6.1'],
  },
  {
    path: ['port-channel', 'load-balance', '<method>'],
    mode: 'config',
    privilege: 15,
    help: 'Which frame fields choose the member link of a bundle',
    args: { method: choiceArg('Hash input', LOAD_BALANCE_METHODS) },
    handler: H.configPortChannelLoadBalance,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    requiresAny: VLAN_AWARE_CAPABILITIES,
    since: 'P2',
    objectives: ['CCNA2.6.2'],
  },
  {
    ...SHOW_LINE,
    path: ['show', 'etherchannel', 'summary'],
    help: 'One line per bundle: protocol, state and the members with their state',
    handler: H.showEtherchannelSummary,
    objectives: ['CCNA2.6.1'],
  },
  {
    ...SHOW_LINE,
    path: ['show', 'etherchannel', 'port-channel'],
    help: 'Every bundle in full: load balancing, members, their modes and partner details',
    handler: H.showEtherchannelPortChannel,
    objectives: ['CCNA2.6.1'],
  },
  // [S3] ── show lacp neighbor ───────────────────────────────────────────────────────────────────────────────────
  {
    ...SHOW_LINE,
    path: ['show', 'lacp', 'neighbor'],
    help: 'The LACP partner seen on each member: system, key and port',
    handler: H.showLacpNeighbor,
    objectives: ['CCNA2.6.1'],
  },
  // [S3] ── end ─────────────────────────────────────────────────────────────────────────────────────────────────
]);
