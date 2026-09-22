/**
 * protocols/stp/vector.ts — spanning-tree priority vectors (ARCHITECTURE-P2 §3.6; 802.1D-2004 §17.5–§17.6) and the
 * BPDU time units (§4.5).
 *
 * A priority vector is compared component by component, lower is better, in exactly this order:
 *     root bridge id, root path cost, designated bridge id, designated port id, receiving port id.
 * A bridge id compares by its 16-bit priority field, then by its MAC as a 48-bit number (the canonical lowercase
 * colon text compares the same way). A port id compares as its 16-bit value (priority in the top 4 bits).
 * The receiving port id is the last-resort tie-break between two ports of one bridge that hear the same designated
 * port (a hub); a vector without it compares equal on that component.
 *
 * A received message is SUPERIOR to the information stored on a port (§17.6) when it is better, or when it comes
 * from the same designated bridge MAC and the same designated port NUMBER as the stored information: a designated
 * port may replace its own earlier message even with a worse one (a root that became worse, a cost that grew).
 *
 * BPDU times travel in 1/256 s units; the daemon keeps SimTime nanoseconds and converts exactly
 * (1/256 s = 3 906 250 ns; 15 s ↔ 3840).
 *
 * Pure: no module state, no randomness; integers only.
 */
import type { SimTime } from '../../contracts/time.js';
import type { BridgeId } from './ids.js';

/** A spanning-tree priority vector (802.1D-2004 §17.5). */
export interface PriorityVector {
  readonly rootId: BridgeId;
  readonly rootPathCost: number;
  readonly designatedBridgeId: BridgeId;
  /** 16-bit port id value (`portIdValue`). */
  readonly designatedPortId: number;
  /** 16-bit id of the port the vector was received on; absent compares equal. */
  readonly receivingPortId?: number;
}

/** Negative when `a` is the better (lower) bridge id, positive when `b` is, 0 when equal. */
export function compareBridgeIds(a: BridgeId, b: BridgeId): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.mac < b.mac ? -1 : a.mac > b.mac ? 1 : 0;
}

/** Negative when `a` is the better vector, positive when `b` is, 0 when every compared component is equal. */
export function comparePriorityVectors(a: PriorityVector, b: PriorityVector): number {
  const root = compareBridgeIds(a.rootId, b.rootId);
  if (root !== 0) return root;
  if (a.rootPathCost !== b.rootPathCost) return a.rootPathCost - b.rootPathCost;
  const bridge = compareBridgeIds(a.designatedBridgeId, b.designatedBridgeId);
  if (bridge !== 0) return bridge;
  if (a.designatedPortId !== b.designatedPortId) return a.designatedPortId - b.designatedPortId;
  if (a.receivingPortId === undefined || b.receivingPortId === undefined) return 0;
  return a.receivingPortId - b.receivingPortId;
}

/** True when `a` is strictly better than `b`. */
export function isBetterVector(a: PriorityVector, b: PriorityVector): boolean {
  return comparePriorityVectors(a, b) < 0;
}

/**
 * 802.1D-2004 §17.6: a received message vector is superior to the port's stored vector when it is better, or when it
 * was sent by the same designated bridge MAC from the same designated port number (priorities are not compared in
 * that second test). A port with no stored information accepts any message.
 */
export function isSuperiorMessage(message: PriorityVector, stored: PriorityVector | undefined): boolean {
  if (stored === undefined) return true;
  if (comparePriorityVectors(message, stored) < 0) return true;
  return message.designatedBridgeId.mac === stored.designatedBridgeId.mac && (message.designatedPortId & 0xfff) === (stored.designatedPortId & 0xfff);
}

/** The vector a bridge offers on its designated ports: its root information with itself as designated bridge. */
export function designatedVector(rootId: BridgeId, rootPathCost: number, bridgeId: BridgeId, portId: number): PriorityVector {
  return { rootId, rootPathCost, designatedBridgeId: bridgeId, designatedPortId: portId };
}

// ── BPDU times ────────────────────────────────────────────────────────────────

/** One BPDU time unit (1/256 s) in nanoseconds. */
export const STP_TIME_UNIT_NS = 3_906_250;

/** Default timers of an instance, in seconds (hello 2, max age 20, forward delay 15). */
export const STP_DEFAULT_TIMERS = Object.freeze({ helloS: 2, maxAgeS: 20, forwardDelayS: 15 });

/** BPDU units (1/256 s) → nanoseconds, exact. */
export function stpUnitsToNs(units: number): SimTime {
  if (!Number.isInteger(units) || units < 0 || units > 0xffff) throw new RangeError(`BPDU time ${units} is outside 0..65535`);
  return units * STP_TIME_UNIT_NS;
}

/** Nanoseconds → BPDU units (1/256 s), rounded down (whole seconds convert exactly: 15 s → 3840). */
export function nsToStpUnits(ns: SimTime): number {
  if (!Number.isInteger(ns) || ns < 0) throw new RangeError(`time ${ns} is not a non-negative integer`);
  return Math.min(0xffff, Math.floor(ns / STP_TIME_UNIT_NS));
}

/** Whole seconds → BPDU units (15 → 3840). */
export function secondsToStpUnits(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 255) throw new RangeError(`BPDU time ${seconds} s is outside 0..255`);
  return seconds * 256;
}
