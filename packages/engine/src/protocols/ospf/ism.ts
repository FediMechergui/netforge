/**
 * protocols/ospf/ism.ts — the OSPF interface state machine (ARCHITECTURE-P3 §3.1, §4.2; RFC 2328 §9.1–§9.3; §7 W1
 * ospf). Pure: it says what an event does; the daemon runs the timers, the election (`electDesignatedRouter`) and the
 * `ospf-if` transitions. No module state.
 *
 *   Down + InterfaceUp         → Point-to-point (point-to-point networks), Loopback (a loopback stub), DROther
 *                                (priority 0: never DR or BDR), else Waiting with the 40 s wait timer
 *   Waiting + BackupSeen       → election
 *   Waiting + WaitTimer        → election
 *   DROther | Backup | DR + NeighborChange → election
 *   any + InterfaceDown        → Down
 *   any + LoopInd              → Loopback;   Loopback + UnloopInd → Down
 * Every other pair changes nothing (for example NeighborChange while Waiting, or on a point-to-point interface). An
 * election's outcome is its `state` (DR, Backup or DROther), which may equal the current one.
 */
import type { OspfIsmState, OspfNetworkType } from '../../contracts/tables.js';

/** @since P3 Interface events (RFC 2328 §9.2), as the daemon names them. */
export type OspfIsmEvent = 'interface-up' | 'wait-timer' | 'backup-seen' | 'neighbor-change' | 'loop-ind' | 'unloop-ind' | 'interface-down';

/** @since P3 The RFC names of the events, for `ip ospf adj` debug lines. */
export const OSPF_ISM_EVENT_NAMES: Readonly<Record<OspfIsmEvent, string>> = Object.freeze({
  'interface-up': 'InterfaceUp',
  'wait-timer': 'WaitTimer',
  'backup-seen': 'BackupSeen',
  'neighbor-change': 'NeighborChange',
  'loop-ind': 'LoopInd',
  'unloop-ind': 'UnloopInd',
  'interface-down': 'InterfaceDown',
});

/** @since P3 What an event does to an interface. */
export type OspfIsmOutcome =
  | { readonly kind: 'none' }
  /** Go to `to`; `startWait` = arm the wait timer (entering Waiting). */
  | { readonly kind: 'goto'; readonly to: OspfIsmState; readonly startWait?: true }
  /** Run the DR election; the interface takes the election's state. */
  | { readonly kind: 'elect' };

/** @since P3 The outcome of `event` on an interface in `state` (RFC 2328 §9.3). */
export function ismOutcome(
  state: OspfIsmState,
  event: OspfIsmEvent,
  iface: { readonly networkType: OspfNetworkType; readonly priority: number },
): OspfIsmOutcome {
  const none: OspfIsmOutcome = { kind: 'none' };
  switch (event) {
    case 'interface-down':
      return state === 'down' ? none : { kind: 'goto', to: 'down' };
    case 'loop-ind':
      return state === 'loopback' ? none : { kind: 'goto', to: 'loopback' };
    case 'unloop-ind':
      return state === 'loopback' && iface.networkType !== 'loopback' ? { kind: 'goto', to: 'down' } : none;
    case 'interface-up':
      if (state !== 'down') return none;
      if (iface.networkType === 'point-to-point') return { kind: 'goto', to: 'point-to-point' };
      if (iface.networkType === 'loopback') return { kind: 'goto', to: 'loopback' };
      if (iface.priority <= 0) return { kind: 'goto', to: 'drother' };
      return { kind: 'goto', to: 'waiting', startWait: true };
    case 'wait-timer':
    case 'backup-seen':
      return state === 'waiting' ? { kind: 'elect' } : none;
    case 'neighbor-change':
      return state === 'drother' || state === 'backup' || state === 'dr' ? { kind: 'elect' } : none;
  }
}
