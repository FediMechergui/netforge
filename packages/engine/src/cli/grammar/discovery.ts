/**
 * cli/grammar/discovery.ts — CDP and LLDP configuration (ARCHITECTURE-P3 §5.5, D2, D18; §7 W2 cli part 1).
 *
 *   global     `cdp run` / `no cdp run` (both forms stored: a P3 world runs CDP by default, D2), `cdp timer <5-254>`,
 *              `cdp holdtime <10-255>`, `[no] cdp advertise-v2` (a stored negation); `lldp run`, `lldp timer
 *              <5-65534>`, `lldp holdtime <0-65535>`, `lldp reinit <2-5>`
 *   interface  `cdp enable` / `no cdp enable` (both forms stored), `[no] lldp transmit`, `[no] lldp receive` (stored
 *              negations) — on Ethernet ports only (D18: CDP and LLDP run on Ethernet, a listed deviation)
 * The cdp and lldp daemons read the lines; the shows (`show cdp …`, `show lldp …`) are W3's.
 *
 * Scope: CDP on the models that run it (routers, managed switches, the wireless controller: the `cdp` rows of §2.1),
 * LLDP on routers and managed switches; written as literals (rule 12). Help strings are original wording (spec §1.6).
 */
import type { CommandSpec, PortRequirement } from '../../contracts/cli.js';
import type { Capability } from '../../contracts/catalog.js';
import { intArg, NFOS_ONLY } from './core-exec.js';

/** Handler ids of the discovery fragment. Never rename. */
export const DISCOVERY_HANDLERS = {
  configCdp: 'config.cdp',
  ifCdpEnable: 'if.cdp-enable',
  configLldp: 'config.lldp',
  ifLldp: 'if.lldp',
} as const;

/** @since P3 Capabilities that run cdp (§2.1: routing, managed-switch, wireless-controller). */
export const CDP_CAPABILITIES: readonly Capability[] = Object.freeze(['routing', 'managed-switch', 'wireless-controller']);
/** @since P3 Capabilities that run lldp (§2.1: routing, managed-switch). */
export const LLDP_CAPABILITIES: readonly Capability[] = Object.freeze(['routing', 'managed-switch']);

/** @since P3 `fixedArgs` key naming the sub-form of a discovery line. */
export const DISCOVERY_FORM_ARG = 'form';

const H = DISCOVERY_HANDLERS;
const OBJ = ['CCNA3.management.1'];

/** D18: CDP and LLDP run on Ethernet ports only. */
const ETHERNET_PORT: PortRequirement = Object.freeze<PortRequirement>({
  kinds: ['ethernet'],
  mismatch: '% Neighbour discovery runs on Ethernet interfaces only.',
});

const CDP_GLOBAL = { mode: 'config', privilege: 15, allowNo: true, grammars: NFOS_ONLY, requiresAny: CDP_CAPABILITIES, since: 'P3' } as const;
const LLDP_GLOBAL = { ...CDP_GLOBAL, requiresAny: LLDP_CAPABILITIES } as const;

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
]);
