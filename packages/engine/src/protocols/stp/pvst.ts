/**
 * protocols/stp/pvst.ts — the 802.1D (PVST+) rules of one instance, as pure functions (ARCHITECTURE-P2 §3.6 "PVST+",
 * §4.2, §4.5; IEEE 802.1D-1998 §8.6).
 *
 *   - Port states progress `listening → learning → forwarding`, each step after one forward delay (`fwd:` timer,
 *     never periodic); a port that stops being root or designated goes `blocking` at once.
 *   - A received configuration BPDU SUPERSEDES the information a port holds when its priority vector is better or
 *     equal (802.1D-1998 §8.6.2.2: the same designated bridge and port with an equal vector refreshes the timers). It
 *     never replaces better stored information — the reason an indirect failure waits for max age (§3.6 step 7). The
 *     information a port holds is its own designated vector when it is designated, else the stored received vector.
 *   - Stored information ages out `maxAge − messageAge` after the BPDU that carried it (`age:` timer, re-armed per
 *     BPDU); a bridge relaying on its designated ports adds one second (256 units) to the message age.
 *   - Only the root originates configuration BPDUs on its hello tick; a non-root bridge relays when it receives on its
 *     root port, and a designated port that hears an inferior BPDU replies with its own.
 *   - Topology change (§3.6 step 5): detected when a non-edge port enters forwarding (and the bridge has a designated
 *     port), or when a port in forwarding or learning leaves it. The root sets TC in its BPDUs for max age + forward
 *     delay (35 s); a non-root bridge sends TCN on its root port until a BPDU with TC-ack arrives.
 *
 * Pure: no state, no clock, integers only.
 */
import type { StpRole, StpState } from '../../contracts/tables.js';
import type { SimTime } from '../../contracts/time.js';
import { STP_FLAG_TC, STP_FLAG_TC_ACK } from '../../pdu/codecs/stp.js';
import { comparePriorityVectors, stpUnitsToNs, type PriorityVector } from './vector.js';

/** Message-age increment a relaying bridge adds (one second in 1/256 s units). */
export const PVST_MESSAGE_AGE_INCREMENT = 256;

/** The state a newly active (root or designated) 802.1D port starts in. */
export const PVST_ENTRY_STATE: StpState = 'listening';
/** The state of a port that is neither root nor designated. */
export const PVST_BLOCKED_STATE: StpState = 'blocking';

/**
 * 802.1D-1998 §8.6.2.2: `message` supersedes `held` when it is better or equal; a port that holds nothing accepts any
 * message.
 */
export function pvstSupersedes(message: PriorityVector, held: PriorityVector | undefined): boolean {
  if (held === undefined) return true;
  return comparePriorityVectors(message, held) <= 0;
}

/** The next timer-driven state of an 802.1D port (`listening → learning → forwarding`), or undefined when none. */
export function pvstNextState(state: StpState): StpState | undefined {
  if (state === 'listening') return 'learning';
  if (state === 'learning') return 'forwarding';
  return undefined;
}

/** True for the roles that take part in forwarding (root and designated). */
export function isActiveRole(role: StpRole): boolean {
  return role === 'root' || role === 'designated';
}

/** How long stored information lives after a BPDU: `maxAge − messageAge` (0 when the age already exceeds max age). */
export function pvstAgeTimerNs(maxAgeUnits: number, messageAgeUnits: number): SimTime {
  return stpUnitsToNs(Math.max(0, maxAgeUnits - messageAgeUnits));
}

/** The root's topology-change window: max age + forward delay (35 s at the defaults). */
export function pvstTcWindowNs(maxAgeUnits: number, forwardDelayUnits: number): SimTime {
  return stpUnitsToNs(maxAgeUnits + forwardDelayUnits);
}

/** The message age a bridge puts in the BPDUs it relays: the root port's stored age plus one second. */
export function relayedMessageAge(storedMessageAgeUnits: number): number {
  return Math.min(0xffff, storedMessageAgeUnits + PVST_MESSAGE_AGE_INCREMENT);
}

/** The flags byte of an 802.1D configuration BPDU. */
export function configBpduFlags(tc: boolean, tcAck: boolean): number {
  return (tc ? STP_FLAG_TC : 0) | (tcAck ? STP_FLAG_TC_ACK : 0);
}

/** 802.1D detects a topology change when a port in one of these states stops forwarding (§3.6 step 5, detection). */
export function detectsTcOnLeaving(state: StpState): boolean {
  return state === 'forwarding' || state === 'learning';
}

/** Cause text of the timer-driven transitions (original wording, D19). */
export const CAUSE_FORWARD_DELAY_EXPIRED = 'forward delay expired';
export const CAUSE_SUPERIOR_BPDU = 'superior BPDU received';
export const CAUSE_INFORMATION_AGED = 'stored information aged out';
export const CAUSE_PORT_UP = 'port came up';
export const CAUSE_PORT_DOWN = 'port went down';
export const CAUSE_ROLE_CHANGED = 'port role changed';
export const CAUSE_EDGE_PORT = 'edge port (PortFast)';
