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
/** @since P3 [S19] The RFC 1661 automaton states (LCP and the NCPs; `PppFsmState`). */
const PPP_STATES = ['initial', 'starting', 'closed', 'stopped', 'closing', 'stopping', 'req-sent', 'ack-rcvd', 'ack-sent', 'opened'] as const;

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
  // ── P3 (ARCHITECTURE-P3 §2.4, §2.16, §2.17; W1 web-inspector). The contract's own state words: the RFC 2328 ISM and
  // NSM states (`OspfIsmState`, `OspfNsmState`), the synchronisation the runtime reports for the `clock` action
  // (§3.7), `TunnelRow.state`, `PppFsmState` for LCP and the NCPs, `PppRow.authLocalState`, the §2.16 EIGRP words
  // (a neighbour goes down → pending → up) and the §2.17 IKE exchange states. ──
  'ospf-if': fsm('ospf-if', 'OSPF interface', ['down', 'loopback', 'waiting', 'point-to-point', 'drother', 'backup', 'dr']),
  'ospf-nbr': fsm('ospf-nbr', 'OSPF neighbour', ['down', 'attempt', 'init', '2way', 'exstart', 'exchange', 'loading', 'full']),
  ntp: fsm('ntp', 'Time synchronisation', ['unsynchronised', 'synchronised']),
  tunnel: fsm('tunnel', 'Tunnel', ['down', 'up']),
  'ppp-lcp': fsm('ppp-lcp', 'PPP link control', PPP_STATES),
  'ppp-auth': fsm('ppp-auth', 'PPP authentication', ['pending', 'success', 'failed']),
  'ppp-ncp': fsm('ppp-ncp', 'PPP network control', PPP_STATES),
  'eigrp-nbr': fsm('eigrp-nbr', 'EIGRP neighbour', ['down', 'pending', 'up']),
  'eigrp-route': fsm('eigrp-route', 'EIGRP route', ['passive', 'active']),
  ike: fsm('ike', 'IKE negotiation', ['idle', 'init-sent', 'init-answered', 'auth-sent', 'established', 'failed']),
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

