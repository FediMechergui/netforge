/**
 * cli/grammar/errdisable.ts — error-disable recovery lines of a VLAN-aware switch (ARCHITECTURE-P2 §3.8 step 6, §5.1,
 * §5.4, D12; §7 W3 cli): `errdisable recovery cause psecure-violation|bpduguard|channel-misconfig|all` (one stored
 * line per cause) and `errdisable recovery interval <s>`, plus `show errdisable recovery`. The cause's daemon
 * (eth-switch, stp, etherchannel) reads the lines through `errdisableRecovery` (protocols/l2/port-security.ts).
 * [S5] `clear errdisable interface <if>` is not built (§8.5). Help strings are original wording (spec §1.6).
 */
import type { CommandSpec } from '../../contracts/cli.js';
import { choiceArg, intArg, NFOS_ONLY } from './core-exec.js';
import { VLAN_AWARE_CAPABILITIES } from './vlan.js';

/** Handler ids of the errdisable fragment. Never rename. */
export const ERRDISABLE_HANDLERS = {
  configErrdisableRecoveryCause: 'config.errdisable-recovery-cause',
  configErrdisableRecoveryInterval: 'config.errdisable-recovery-interval',
  showErrdisableRecovery: 'show.errdisable-recovery',
} as const;

/** Causes `errdisable recovery cause` accepts (the configurable causes of §5.1, then `all`). */
export const ERRDISABLE_RECOVERY_CAUSES = Object.freeze(['psecure-violation', 'bpduguard', 'channel-misconfig', 'all'] as const);

/** Bounds of `errdisable recovery interval` (seconds). */
export const ERRDISABLE_INTERVAL_MIN_S = 30;
export const ERRDISABLE_INTERVAL_MAX_S = 86400;

const H = ERRDISABLE_HANDLERS;

/** The errdisable command table. */
export const ERRDISABLE_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    path: ['errdisable', 'recovery', 'cause', '<cause>'],
    mode: 'config',
    privilege: 15,
    help: 'Bring ports error-disabled for this cause back up by themselves after the interval',
    args: { cause: choiceArg('The cause to recover from, or all of them', ERRDISABLE_RECOVERY_CAUSES) },
    handler: H.configErrdisableRecoveryCause,
    allowNo: true,
    grammars: NFOS_ONLY,
    requiresAny: VLAN_AWARE_CAPABILITIES,
    since: 'P2',
    objectives: ['CCNA2.4.2'],
  },
  {
    path: ['errdisable', 'recovery', 'interval', '<seconds>'],
    mode: 'config',
    privilege: 15,
    help: 'Seconds an error-disabled port waits before automatic recovery (default 300)',
    args: { seconds: intArg('Seconds', ERRDISABLE_INTERVAL_MIN_S, ERRDISABLE_INTERVAL_MAX_S) },
    handler: H.configErrdisableRecoveryInterval,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    requiresAny: VLAN_AWARE_CAPABILITIES,
    since: 'P2',
    objectives: ['CCNA2.4.2'],
  },
  {
    path: ['show', 'errdisable', 'recovery'],
    mode: '@exec',
    privilege: 1,
    help: 'Which causes recover by themselves, the interval, and the ports waiting for recovery',
    handler: H.showErrdisableRecovery,
    filterable: true,
    grammars: NFOS_ONLY,
    requiresAny: VLAN_AWARE_CAPABILITIES,
    since: 'P2',
    objectives: ['CCNA2.4.2'],
  },
]);
