/**
 * contracts/timeline.ts — timeline lanes and the time-travel budget (ARCHITECTURE-P2 §2.13, §3.13) [SHOULD S1].
 *
 * The worker indexes every drained trace event into one lane (`laneOf`, timeline/lanes.ts, W1): linkState/portState
 * → 'link'; `debug.fsm.machine` → its lane; tableWrite/tableExpire by table (stp → 'stp', etherchannel →
 * 'etherchannel', vlans/dtp → 'vlan', hsrp → 'fhrp', rib/rib6 → 'routing', nat → 'nat', dhcp-bindings/dhcpv6-bindings
 * → 'dhcp', capwap* / dot11-assoc → 'wireless', port-security → 'security'); configChange → 'config'; drop → 'drops'.
 * Structured-clone safe.
 */
import type { SimTime } from './time.js';

/** @since P2 [S1] One timeline lane. */
export type LaneId = 'link' | 'stp' | 'etherchannel' | 'vlan' | 'fhrp' | 'routing' | 'nat' | 'dhcp' | 'wireless' | 'security' | 'config' | 'drops';

/** @since P2 [S1] Bucketed lane activity between two times. */
export interface TimelineQuery {
  from: SimTime;
  to: SimTime;
  buckets: number;
  lanes?: readonly LaneId[];
}

/** @since P2 [S1] One bucket of `timelineBuckets`: events per lane and the ring cursor of each lane's first event. */
export interface LaneBucket {
  from: SimTime;
  to: SimTime;
  counts: Partial<Record<LaneId, number>>;
  firstCursor: Partial<Record<LaneId, number>>;
}

/** @since P2 [S1] Individual marks of one lane (`timelineMarks`). */
export interface TimelineMarkQuery {
  lane: LaneId;
  from: SimTime;
  to: SimTime;
  limit: number;
}

/** @since P2 [S1] Memory budget of the time machine (§12.2 R8). */
export interface TimeTravelBudget {
  /** Parked replayers. */
  replayers: number;
  /** Event lag of each parked replayer behind the live head (one per replayer, ascending). */
  lagsEvents: readonly number[];
  /** Trace ring capacity of the cursor replay while reviewing. */
  reviewTraceCapacity: number;
  /** PDU registry cap of the cursor replay. */
  reviewPduRegistry: number;
  /** Lane index entries before buckets are merged. */
  laneEntries: number;
}

/** @since P2 [S1] About 10–30 MB extra for CCNA-sized worlds (§12.2 R8). */
export const DEFAULT_TIME_TRAVEL_BUDGET: TimeTravelBudget = Object.freeze({
  replayers: 3,
  lagsEvents: Object.freeze([5_000, 30_000, 150_000]),
  reviewTraceCapacity: 50_000,
  reviewPduRegistry: 5_000,
  laneEntries: 250_000,
});

/** @since P2 [S1] Row members that change without a state change (ignored when comparing rows across positions). */
export const VOLATILE_ROW_KEYS = ['updatedAt', 'expiresAt'] as const;
