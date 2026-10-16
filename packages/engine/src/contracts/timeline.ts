/**
 * contracts/timeline.ts — timeline lanes and the time-travel budget (ARCHITECTURE-P2 §2.13, §3.13) [SHOULD S1].
 *
 * The worker indexes every drained trace event into one lane (`laneOf`, timeline/lanes.ts, W1): linkState/portState
 * → 'link'; `debug.fsm.machine` → its lane; tableWrite/tableExpire by table (stp → 'stp', etherchannel →
 * 'etherchannel', vlans/dtp → 'vlan', hsrp → 'fhrp', rib/rib6 → 'routing', nat → 'nat', dhcp-bindings/dhcpv6-bindings
 * → 'dhcp', capwap* / dot11-assoc → 'wireless', port-security → 'security'); configChange → 'config'; drop → 'drops'.
 * Structured-clone safe.
 */
import type { DeviceId } from './ids.js';
import type { SimTime } from './time.js';

/**
 * @since P2 [S1] One timeline lane.
 * 'mgmt' @since P3 (lane 12: cdp-neighbours, lldp-neighbours, ntp-peers, clock and [S25] syslog-messages rows; the 'ntp'
 * machine) and 'wan' @since P3 (lane 13, for the approved [S18], [S19] and [C13]: tunnels, ppp and ipsec-sa rows; the
 * tunnel, ppp-lcp, ppp-auth, ppp-ncp and ike machines), appended so LANE_IDS keeps every existing index
 * (ARCHITECTURE-P3 §2.12; the final lane entries are in timeline/lanes.ts).
 */
export type LaneId = 'link' | 'stp' | 'etherchannel' | 'vlan' | 'fhrp' | 'routing' | 'nat' | 'dhcp' | 'wireless' | 'security' | 'config' | 'drops' | 'mgmt' | 'wan';

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

// ── [S8] convergence (ARCHITECTURE-P3C §2.10, D7; @since P3c) ─────────────────
//
// The `convergence` lab kind and the convergence panel measure control-plane convergence from the trace: a fault clone
// with settle 0 applies its faults at the clone instant, attaches a synchronous trace listener, runs `runFor(windowMs)`
// and hands the events to the pure `measureConvergence` (timeline/convergence.ts, W1a sim).

/** @since P3c [S8] The protocol families whose convergence is measured, each over its timeline lanes. */
export type ConvergenceProtocol = 'stp' | 'etherchannel' | 'fhrp' | 'routing' | 'wireless' | 'wan';

/** @since P3c [S8] The timeline lanes (timeline/lanes.ts) each protocol's convergence is measured over. */
export const CONVERGENCE_LANES: Readonly<Record<ConvergenceProtocol, readonly LaneId[]>> = Object.freeze({
  stp: Object.freeze(['stp'] as const),
  etherchannel: Object.freeze(['etherchannel'] as const),
  fhrp: Object.freeze(['fhrp'] as const),
  routing: Object.freeze(['routing'] as const),
  wireless: Object.freeze(['wireless'] as const),
  wan: Object.freeze(['wan'] as const),
});

/**
 * @since P3c [S8] The quiet period after the last change that counts as settled (ruling R-13): 12 s for `routing`
 * (longer than the 10 s SPF hold, so a second SPF after a restore is not cut off), 5 s for the others.
 */
export const CONVERGENCE_QUIET_MS: Readonly<Record<ConvergenceProtocol, number>> = Object.freeze({
  stp: 5_000,
  etherchannel: 5_000,
  fhrp: 5_000,
  routing: 12_000,
  wireless: 5_000,
  wan: 5_000,
});

/** @since P3c [S8] What `measureConvergence` measures. */
export interface ConvergenceOptions {
  readonly protocol: ConvergenceProtocol;
  /** The fault instant: changes before it are ignored. */
  readonly from: SimTime;
  /** Default CONVERGENCE_QUIET_MS[protocol]. */
  readonly quietMs?: number;
  /** Restrict to these devices; absent = every device. */
  readonly devices?: readonly DeviceId[];
  /** The routing lane only: that daemon's machines and tables plus the rib rows it owns. */
  readonly only?: 'ospf' | 'eigrp';
}

/**
 * @since P3c [S8] The measured convergence: `settledAt` is the instant of the last change followed by a full quiet
 * period (null when the window ended before it settled); `durationNs` = settledAt − from.
 */
export interface ConvergenceResult {
  readonly protocol: ConvergenceProtocol;
  readonly from: SimTime;
  readonly settledAt: SimTime | null;
  readonly durationNs: SimTime | null;
  readonly changes: number;
  readonly last?: { readonly cursor: number; readonly device: DeviceId; readonly subject: string };
}
