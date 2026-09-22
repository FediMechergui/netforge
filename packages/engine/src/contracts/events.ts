/**
 * Discrete-event scheduler contract (spec §4.1).
 *
 * There is no tick. State advances by popping the earliest event. Ordering is
 * by `(at, seq)` — `seq` is a monotonic counter assigned at schedule time and
 * is THE determinism tiebreaker. Never order by Map/Set iteration, object
 * identity, or insertion into any hash structure.
 */
import type { DeviceId, LinkId, PortId, ProcessName, SessionId } from './ids.js';
import type { Pdu } from './pdu.js';
import type { SimTime } from './time.js';
import type { MediumId } from './medium.js';
import type { RfBand } from './rf.js';

export type SimEventBody =
  /** Last bit of a frame has arrived on `port` (store-and-forward). */
  | {
      kind: 'frameArrival';
      device: DeviceId;
      port: PortId;
      pdu: Pdu;
      corrupted?: boolean;
      /** @since P0.5 Medium that scheduled it (absent = P2P cable). */
      medium?: MediumId;
      /** @since P0.5 Collision fragment: bytes actually received. */
      fragmentBytes?: number;
      /** @since P0.5 Half-duplex receiver was hit by a collision during reception. */
      collided?: boolean;
      /** @since P0.5 Air data frame: `LinkModel.admit` rewraps dot11 → ethernet before delivery. */
      rewrap?: 'dot11-to-ethernet';
      /**
       * @since P2 (optional by meaning; wireless) The air hands an 802.11 data frame of a centrally switched BSS to the
       * AP unchanged; admit still re-checks authorization.
       */
      central?: true;
    }
  /** Serialization of the head-of-line frame on `port` finished; the port may start the next. */
  | { kind: 'txComplete'; device: DeviceId; port: PortId }
  /**
   * A process timer fired. `key` is the process-chosen timer key. `periodic` (D10) is copied from the
   * arming Action: the timer re-arms indefinitely for maintenance (sweeps, RA interval, beacons,
   * keepalives, rescans, DHCP lease T1/T2/expiry, DHCP restart pause), so `runToIdle` does not wait for it.
   */
  | { kind: 'timer'; device: DeviceId; process: ProcessName; key: string; periodic?: boolean }
  /** Physical link went up/down (cable connect/disconnect, port shutdown, fault). */
  | { kind: 'linkState'; link: LinkId; up: boolean }
  /** A line was submitted on a CLI session (used when the UI drives the CLI through sim time). */
  | { kind: 'userCommand'; device: DeviceId; session: SessionId; line: string }
  /** A scheduled fault (spec §4.11). Opaque to the scheduler. */
  | { kind: 'fault'; fault: FaultSpec }
  /** Device power-on completes (boot). */
  | { kind: 'boot'; device: DeviceId }
  /** @since P0.5 Link-model-owned timer (CSMA deferral/backoff/jam end, RF hold, attach, noise bursts). Never periodic. */
  | { kind: 'mediumTimer'; medium: MediumId; key: string }
  /** @since P0.5 Coalesced mobility re-evaluation (scheduled at `now` by moveDevice for devices with radio ports). */
  | { kind: 'deviceMoved'; device: DeviceId };

export type SimEvent = SimEventBody & {
  readonly at: SimTime;
  readonly seq: number;
};

export type FaultKind =
  | 'cable-cut'
  | 'port-flap'
  | 'power-loss'
  | 'link-impairment'
  | 'config-fragment'
  // ── P0.5 / P1 ──
  /** params {riseDb, radiusM?, durationNs?}; target device = centre, or band/channel only = everywhere. */
  | 'rf-interference'
  /** params {extraLossDb, durationNs?}; target link (radio). */
  | 'radio-fade'
  /** Config fault: params {duplex, speed?}; applied as config lines through `Simulation.configure`; target device+port. */
  | 'duplex-mismatch'
  /** Config fault: `no clock rate` on the DCE end; target link or device+port. */
  | 'clock-missing'
  /** params {burstsPerSec, durationNs}; target device+port on a segment; jam bursts from rng 'fault:<id>'. */
  | 'collision-storm'
  // ── P2 ──
  /**
   * @since P2 target {device, port}; params {cause?: ErrDisableCause} (default 'fault'). Applied through
   * DeviceRuntime.errDisablePort. Used by troubleshooting labs and by the lab-check clone (ARCHITECTURE-P2 §3.8).
   */
  | 'err-disable';

export interface FaultSpec {
  id: string;
  kind: FaultKind;
  target: {
    device?: DeviceId;
    port?: PortId;
    link?: LinkId;
    /** @since P0.5 */
    medium?: MediumId;
    /** @since P0.5 */
    band?: RfBand;
    /** @since P0.5 */
    channel?: number;
  };
  params?: Record<string, unknown>;
  hiddenFromStudent?: boolean;
}

export interface Scheduler {
  readonly now: SimTime;
  /** Number of pending events. */
  readonly size: number;
  /** Schedule `body` at absolute time `at` (>= now). Returns the event's `seq`, usable with `cancel`. */
  schedule(at: SimTime, body: SimEventBody): number;
  /** Cancel by seq. Returns false if already fired or unknown. */
  cancel(seq: number): boolean;
  /** Pop the earliest event and advance `now` to its time. Undefined when empty. */
  next(): SimEvent | undefined;
  /** Time of the earliest pending event, or undefined. */
  peekTime(): SimTime | undefined;
  /** Advance `now` without popping (used by `runUntil` when the queue is empty or the next event is later). */
  advanceTo(t: SimTime): void;
}
