/**
 * State-machine vocabulary [SHOULD S14] (ARCHITECTURE-P2 D19, §6): for every machine that reports through
 * `ctx.transition` (`DebugEvent.fsm`), its display name and the states the history strip lays out, in the order a
 * learner meets them.
 *
 * `FSM_VOCAB` is typed `Record<FsmMachine, …>`, so a new engine machine is a compile error here until it has wording.
 * The state lists use the contract's own state words wherever a table row names them (`StpState`, the `dtp` row's
 * `oper`, `ChannelMemberState`, `PortSecurityRow.status`, `CapwapState`, `HsrpRow.state`), because a transition's
 * `from`/`to` are those words:
 *
 * - `lacp` and `pagp` report a member moving between `ChannelMemberState`s (§3.7 step 3: the LACP transition is the
 *   member becoming `bundled`), exactly like `channel` (static members), so all three share one list;
 * - `stp-port` lists the `StpState` values (the classic and the rapid sets together); `stp-bridge` whether the bridge
 *   is the root.
 *
 * The W6 [S14] history strip (inspector/FsmStrip.tsx) lays a transition out by `fsmStateIndex`; a state word a daemon
 * emits that is not listed here gets index -1 and is drawn after the known states, so a new word never breaks the
 * strip. All wording is original (§1.6).
 */
import type { FsmMachine } from '@netforge/engine';

/** Presentation data for one state machine. */
export interface FsmVocab {
  readonly machine: FsmMachine;
  /** Display name of the machine. */
  readonly label: string;
  /** Known states, in the order the history strip lays them out. */
  readonly states: readonly string[];
}

function fsm(machine: FsmMachine, label: string, states: readonly string[]): FsmVocab {
  return Object.freeze({ machine, label, states: Object.freeze([...states]) });
}

const CAPWAP_STATES = ['idle', 'discovery', 'dtls', 'join', 'configure', 'data-check', 'run'] as const;
const MEMBER_STATES = ['down', 'waiting', 'individual', 'suspended', 'bundled'] as const;

/** Every state machine, exhaustive over `FsmMachine`. */
export const FSM_VOCAB: Readonly<Record<FsmMachine, FsmVocab>> = Object.freeze({
  'stp-port': fsm('stp-port', 'Spanning-tree port', ['disabled', 'blocking', 'discarding', 'listening', 'learning', 'forwarding']),
  'stp-bridge': fsm('stp-bridge', 'Spanning-tree bridge', ['non-root', 'root']),
  dtp: fsm('dtp', 'Trunk negotiation', ['access', 'trunk']),
  lacp: fsm('lacp', 'Link aggregation (LACP)', MEMBER_STATES),
  channel: fsm('channel', 'Bundle member', MEMBER_STATES),
  'port-security': fsm('port-security', 'Port security', ['secure-down', 'secure-up', 'secure-shutdown']),
  'err-disable': fsm('err-disable', 'Error-disable', ['enabled', 'err-disabled']),
  nat: fsm('nat', 'Address translation', ['none', 'active', 'expired']),
  dhcpv6: fsm('dhcpv6', 'DHCPv6 client', ['idle', 'soliciting', 'requesting', 'bound', 'renewing', 'rebinding', 'informing', 'informed']),
  'capwap-wtp': fsm('capwap-wtp', 'Access point to controller', CAPWAP_STATES),
  'capwap-ac': fsm('capwap-ac', 'Controller to access point', CAPWAP_STATES),
  hsrp: fsm('hsrp', 'Standby group', ['initial', 'learn', 'listen', 'speak', 'standby', 'active']),
  pagp: fsm('pagp', 'Port aggregation', MEMBER_STATES),
});

/** Machines in display order. */
export const FSM_MACHINES: readonly FsmMachine[] = Object.freeze(Object.keys(FSM_VOCAB) as FsmMachine[]);

/** True when `m` names a state machine. */
export function isFsmMachine(m: string): m is FsmMachine {
  return Object.prototype.hasOwnProperty.call(FSM_VOCAB, m);
}

/** Display name of a machine (the raw name when unknown). */
export function fsmLabel(m: string): string {
  return isFsmMachine(m) ? FSM_VOCAB[m].label : m;
}

/** Position of `state` in its machine's list, or -1 when the machine or the state is not known. */
export function fsmStateIndex(m: string, state: string): number {
  return isFsmMachine(m) ? FSM_VOCAB[m].states.indexOf(state) : -1;
}

