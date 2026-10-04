/**
 * cli/grammar/discovery.ts — CDP and LLDP configuration (ARCHITECTURE-P3 §5.5, D2, D18; §7 W2 cli part 1).
 *
 *   global     `cdp run` / `no cdp run` (both forms stored: a P3 world runs CDP by default, D2), `cdp timer <5-254>`,
 *              `cdp holdtime <10-255>`, `[no] cdp advertise-v2` (a stored negation); `lldp run`, `lldp timer
 *              <5-65534>`, `lldp holdtime <0-65535>`, `lldp reinit <2-5>`
 *   interface  `cdp enable` / `no cdp enable` (both forms stored), `[no] lldp transmit`, `[no] lldp receive` (stored
 *              negations) — on Ethernet ports only (D18: CDP and LLDP run on Ethernet, a listed deviation)
 * The cdp and lldp daemons read the lines.
 *
 * Verification (W3, cli part 2, §5.8): `show cdp`, `show cdp neighbors [<if>] [detail]`, `show cdp entry <name|*>`,
 * `show cdp interface [<if>]`, `show cdp traffic`, `clear cdp table`; `show lldp`, `show lldp neighbors [<if>]
 * [detail]`, `show lldp entry <name|*>`, `show lldp interface [<if>]`, `show lldp traffic`, `clear lldp table`; the
 * debug categories `cdp packets`, `cdp events` and `lldp packets` (protocols/cdp.ts `CDP_DEBUG_PACKETS` /
 * `CDP_DEBUG_EVENTS`, protocols/lldp.ts `LLDP_DEBUG_PACKETS`). `clear cdp counters` (§5.8; ruling R39, the W3 fix
 * step) sends the cdp daemon `cdp.clearCounters`, which zeroes the counters `show cdp traffic` prints.
 *
 * Scope: CDP on the models that run it (routers, managed switches, the wireless controller: the `cdp` rows of §2.1),
 * LLDP on routers and managed switches; written as literals (rule 12). Help strings are original wording (spec §1.6).
 */
import type { CommandSpec, PortRequirement } from '../../contracts/cli.js';
import type { Capability } from '../../contracts/catalog.js';
import { debugSpecs, type GrammarDebugCategory, ifaceArg, intArg, NFOS_ONLY, wordArg } from './core-exec.js';

/** Handler ids of the discovery fragment. Never rename. */
export const DISCOVERY_HANDLERS = {
  configCdp: 'config.cdp',
  ifCdpEnable: 'if.cdp-enable',
  configLldp: 'config.lldp',
  ifLldp: 'if.lldp',
  // W3 cli part 2
  showCdp: 'show.cdp',
  showCdpNeighbors: 'show.cdp-neighbors',
  showCdpEntry: 'show.cdp-entry',
  showCdpInterface: 'show.cdp-interface',
  showCdpTraffic: 'show.cdp-traffic',
  execClearCdpTable: 'exec.clear-cdp-table',
  /** W3 fix step (ruling R39): `clear cdp counters`. */
  execClearCdpCounters: 'exec.clear-cdp-counters',
  showLldp: 'show.lldp',
  showLldpNeighbors: 'show.lldp-neighbors',
  showLldpEntry: 'show.lldp-entry',
  showLldpInterface: 'show.lldp-interface',
  showLldpTraffic: 'show.lldp-traffic',
  execClearLldpTable: 'exec.clear-lldp-table',
} as const;

/** @since P3 Capabilities that run cdp (§2.1: routing, managed-switch, wireless-controller). */
export const CDP_CAPABILITIES: readonly Capability[] = Object.freeze(['routing', 'managed-switch', 'wireless-controller']);
/** @since P3 Capabilities that run lldp (§2.1: routing, managed-switch). */
export const LLDP_CAPABILITIES: readonly Capability[] = Object.freeze(['routing', 'managed-switch']);

/** @since P3 `fixedArgs` key naming the sub-form of a discovery line. */
export const DISCOVERY_FORM_ARG = 'form';
/** @since P3 `fixedArgs` key of the `… neighbors … detail` forms: one block per neighbour instead of the table. */
export const DISCOVERY_DETAIL_ARG = 'detail';
/** @since P3 The `show cdp|lldp entry` argument that names every neighbour. */
export const DISCOVERY_ENTRY_ALL = '*';

/**
 * @since P3 The CDP and LLDP debug categories (§5.8; the daemons' `CDP_DEBUG_PACKETS`, `CDP_DEBUG_EVENTS` and
 * `LLDP_DEBUG_PACKETS`), offered where each daemon runs. Literals (rule 12).
 */
export const DISCOVERY_DEBUG_CATEGORIES: readonly GrammarDebugCategory[] = Object.freeze([
  { category: 'cdp packets', help: 'Trace every CDP announcement sent or received', requiresAny: CDP_CAPABILITIES, since: 'P3' },
  { category: 'cdp events', help: 'Trace CDP switched on or off, and neighbours that appear or go away', requiresAny: CDP_CAPABILITIES, since: 'P3' },
  { category: 'lldp packets', help: 'Trace every LLDP announcement sent or received, and neighbours that appear or go away', requiresAny: LLDP_CAPABILITIES, since: 'P3' },
]);

/** @since P3 Objectives of the discovery debug categories. */
export const DISCOVERY_DEBUG_OBJECTIVES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'cdp packets': ['CCNA3.management.1'],
  'cdp events': ['CCNA3.management.1'],
  'lldp packets': ['CCNA3.management.1'],
});

const H = DISCOVERY_HANDLERS;
const OBJ = ['CCNA3.management.1'];

/** D18: CDP and LLDP run on Ethernet ports only. */
const ETHERNET_PORT: PortRequirement = Object.freeze<PortRequirement>({
  kinds: ['ethernet'],
  mismatch: '% Neighbour discovery runs on Ethernet interfaces only.',
});

const CDP_GLOBAL = { mode: 'config', privilege: 15, allowNo: true, grammars: NFOS_ONLY, requiresAny: CDP_CAPABILITIES, since: 'P3' } as const;
const LLDP_GLOBAL = { ...CDP_GLOBAL, requiresAny: LLDP_CAPABILITIES } as const;
const CDP_SHOW = { mode: '@exec', privilege: 1, filterable: true, grammars: NFOS_ONLY, requiresAny: CDP_CAPABILITIES, since: 'P3', objectives: OBJ } as const;
const LLDP_SHOW = { ...CDP_SHOW, requiresAny: LLDP_CAPABILITIES } as const;
const CDP_CLEAR = { mode: 'priv-exec', privilege: 15, grammars: NFOS_ONLY, requiresAny: CDP_CAPABILITIES, since: 'P3', objectives: OBJ } as const;
const LLDP_CLEAR = { ...CDP_CLEAR, requiresAny: LLDP_CAPABILITIES } as const;

/** The verification specs of one protocol (§5.8): `show <p>`, `neighbors [<if>] [detail]`, `entry`, `interface`, `traffic`, `clear <p> table`. */
function discoveryShows(
  proto: 'cdp' | 'lldp',
  show: typeof CDP_SHOW | typeof LLDP_SHOW,
  clear: typeof CDP_CLEAR | typeof LLDP_CLEAR,
  ids: { global: string; neighbors: string; entry: string; iface: string; traffic: string; clear: string },
): CommandSpec[] {
  const name = proto === 'cdp' ? 'CDP' : 'LLDP';
  const detail = { [DISCOVERY_DETAIL_ARG]: 'detail' };
  return [
    { ...show, path: ['show', proto], help: `Whether ${name} runs, and its timers`, handler: ids.global },
    {
      ...show,
      path: ['show', proto, 'neighbors', '<iface>'],
      help: `The neighbours ${name} heard, one line each`,
      args: { iface: ifaceArg('Only the neighbours heard on this interface', { optional: true }) },
      handler: ids.neighbors,
    },
    { ...show, path: ['show', proto, 'neighbors', 'detail'], help: `Every ${name} neighbour in full`, handler: ids.neighbors, fixedArgs: detail },
    {
      ...show,
      path: ['show', proto, 'neighbors', '<iface>', 'detail'],
      help: `Every ${name} neighbour in full`,
      args: { iface: ifaceArg('Only the neighbours heard on this interface') },
      handler: ids.neighbors,
      fixedArgs: detail,
    },
    {
      ...show,
      path: ['show', proto, 'entry', '<name>'],
      help: `One ${name} neighbour in full, by name`,
      args: { name: wordArg(`Name of the neighbour, or ${DISCOVERY_ENTRY_ALL} for every one`, { maxLength: 255 }) },
      handler: ids.entry,
    },
    {
      ...show,
      path: ['show', proto, 'interface', '<iface>'],
      help: `${name} on each interface (or one)`,
      args: { iface: ifaceArg('Limit the output to one interface', { optional: true }) },
      handler: ids.iface,
    },
    { ...show, path: ['show', proto, 'traffic'], help: `${name} announcements sent and received`, handler: ids.traffic },
    { ...clear, path: ['clear', proto, 'table'], help: `Forget every ${name} neighbour (they come back with their next announcement)`, handler: ids.clear },
  ];
}

/** The discovery command table. */
export const DISCOVERY_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    ...CDP_GLOBAL,
    path: ['cdp', 'run'],
    help: 'Send and listen for CDP announcements (no cdp run switches CDP off on the whole device)',
    handler: H.configCdp,
    fixedArgs: { [DISCOVERY_FORM_ARG]: 'run' },
    objectives: OBJ,
  },
  {
    ...CDP_GLOBAL,
    path: ['cdp', 'timer', '<seconds>'],
    help: 'Seconds between CDP announcements (default 60)',
    args: { seconds: intArg('Seconds', 5, 254) },
    handler: H.configCdp,
    fixedArgs: { [DISCOVERY_FORM_ARG]: 'timer' },
    noArgsOptional: true,
    objectives: OBJ,
  },
  {
    ...CDP_GLOBAL,
    path: ['cdp', 'holdtime', '<seconds>'],
    help: 'How long neighbours keep this device\'s announcement (default 180 s)',
    args: { seconds: intArg('Seconds', 10, 255) },
    handler: H.configCdp,
    fixedArgs: { [DISCOVERY_FORM_ARG]: 'holdtime' },
    noArgsOptional: true,
    objectives: OBJ,
  },
  {
    ...CDP_GLOBAL,
    path: ['cdp', 'advertise-v2'],
    help: 'Send version 2 announcements (no form sends version 1)',
    handler: H.configCdp,
    fixedArgs: { [DISCOVERY_FORM_ARG]: 'advertise-v2' },
    objectives: OBJ,
  },
  {
    path: ['cdp', 'enable'],
    mode: 'config-if',
    privilege: 15,
    help: 'Use CDP on this interface (no cdp enable keeps it off here, at the network edge)',
    handler: H.ifCdpEnable,
    allowNo: true,
    grammars: NFOS_ONLY,
    requiresAny: CDP_CAPABILITIES,
    portRequires: ETHERNET_PORT,
    since: 'P3',
    objectives: OBJ,
  },
  {
    ...LLDP_GLOBAL,
    path: ['lldp', 'run'],
    help: 'Send and listen for LLDP announcements (off by default)',
    handler: H.configLldp,
    fixedArgs: { [DISCOVERY_FORM_ARG]: 'run' },
    objectives: OBJ,
  },
  {
    ...LLDP_GLOBAL,
    path: ['lldp', 'timer', '<seconds>'],
    help: 'Seconds between LLDP announcements (default 30)',
    args: { seconds: intArg('Seconds', 5, 65534) },
    handler: H.configLldp,
    fixedArgs: { [DISCOVERY_FORM_ARG]: 'timer' },
    noArgsOptional: true,
    objectives: OBJ,
  },
  {
    ...LLDP_GLOBAL,
    path: ['lldp', 'holdtime', '<seconds>'],
    help: 'How long neighbours keep this device\'s announcement (default 120 s)',
    args: { seconds: intArg('Seconds', 0, 65535) },
    handler: H.configLldp,
    fixedArgs: { [DISCOVERY_FORM_ARG]: 'holdtime' },
    noArgsOptional: true,
    objectives: OBJ,
  },
  {
    ...LLDP_GLOBAL,
    path: ['lldp', 'reinit', '<seconds>'],
    help: 'Seconds to wait before LLDP starts again on an interface (default 2)',
    args: { seconds: intArg('Seconds', 2, 5) },
    handler: H.configLldp,
    fixedArgs: { [DISCOVERY_FORM_ARG]: 'reinit' },
    noArgsOptional: true,
    objectives: OBJ,
  },
  {
    path: ['lldp', 'transmit'],
    mode: 'config-if',
    privilege: 15,
    help: 'Send LLDP announcements on this interface (no form stops sending)',
    handler: H.ifLldp,
    fixedArgs: { [DISCOVERY_FORM_ARG]: 'transmit' },
    allowNo: true,
    grammars: NFOS_ONLY,
    requiresAny: LLDP_CAPABILITIES,
    portRequires: ETHERNET_PORT,
    since: 'P3',
    objectives: OBJ,
  },
  {
    path: ['lldp', 'receive'],
    mode: 'config-if',
    privilege: 15,
    help: 'Read the LLDP announcements arriving on this interface (no form ignores them)',
    handler: H.ifLldp,
    fixedArgs: { [DISCOVERY_FORM_ARG]: 'receive' },
    allowNo: true,
    grammars: NFOS_ONLY,
    requiresAny: LLDP_CAPABILITIES,
    portRequires: ETHERNET_PORT,
    since: 'P3',
    objectives: OBJ,
  },
  // W3 cli part 2: the shows and `clear … table` (§5.8)
  ...discoveryShows('cdp', CDP_SHOW, CDP_CLEAR, {
    global: H.showCdp,
    neighbors: H.showCdpNeighbors,
    entry: H.showCdpEntry,
    iface: H.showCdpInterface,
    traffic: H.showCdpTraffic,
    clear: H.execClearCdpTable,
  }),
  // ruling R39 (W3 fix step): `clear cdp counters` (§5.8)
  { ...CDP_CLEAR, path: ['clear', 'cdp', 'counters'], help: 'Set the CDP announcement counters back to zero', handler: H.execClearCdpCounters },
  ...discoveryShows('lldp', LLDP_SHOW, LLDP_CLEAR, {
    global: H.showLldp,
    neighbors: H.showLldpNeighbors,
    entry: H.showLldpEntry,
    iface: H.showLldpInterface,
    traffic: H.showLldpTraffic,
    clear: H.execClearLldpTable,
  }),
  // `debug cdp packets|events`, `debug lldp packets` (§5.8)
  ...debugSpecs(DISCOVERY_DEBUG_CATEGORIES, DISCOVERY_DEBUG_OBJECTIVES),
]);
