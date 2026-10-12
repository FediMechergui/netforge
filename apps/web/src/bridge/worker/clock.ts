/**
 * Worker clock (protocol.ts ClockPolicy; ARCHITECTURE-P1 §3.14 "Honours ClockPolicy.ignoreBackground").
 *
 * The worker owns sim time. While no frame is on a medium, sim time advances at `rate × wall`, sub-stepping to
 * `nextEventTime()` so no `frameTx` is skipped inside a slice. While frames are in flight the slice is clamped so
 * the shortest in-flight leg spans at least `minTransitWallMs` of wall time, and no step crosses an arrival (or
 * any scheduler event) without re-evaluating. Targets are always `Math.round` integers.
 *
 * P0.5: legs are keyed by `(pdu.id, link, to)` (one entry per receiver leg on segments and BSSs). Background legs
 * (keepalives, beacons: `frameTx.background`) never clamp the clock while `ignoreBackground` is set, so periodic
 * maintenance traffic cannot lock the UI in slow motion. `frameAbort` shortens a leg to its `abortAt`.
 *
 * P3 (ARCHITECTURE-P3 §9.2 ruling R57(a)): legs of traffic-generator datagrams (protocols/traffic.ts, the host shell's
 * `flow` job and the desktop Traffic app) never clamp the clock either. A running flow always has a frame in flight, so
 * clamping on its legs held the clock in permanent slow motion (a 50 pps flow played at a small fraction of the chosen
 * rate). The clock recognises such a leg by what it already receives: the daemon gives every datagram it builds the
 * PDU tag `'traffic'` (`TRAFFIC_DATAGRAM_TAG`), and the tag stays on the PDU through forwarding (a clone keeps its
 * meta) and tunnelling (a rewrap keeps the PDU), so every leg's `frameTx.pdu.tag` and `InflightFrame.pdu.tag` carry it
 * — the same test the engine's traffic grader makes (sim/lab-checks/traffic.ts `trafficActivity`). No engine marking
 * is needed. The exemption is for the clamp only and unconditional: unlike a background leg, a traffic leg does not
 * clamp under `ignoreBackground: false` (the View menu's "Background frames") nor when it matches the simulation-mode
 * clamp filter. The leg is still recorded (so a resync, a prune and an abort treat it like any other), its `frameTx`
 * reaches every other consumer unchanged (the Packets list, NetScope captures — it is not `background`, so "Keep
 * keepalives and beacons" does not hide it — and the canvas, which paces such a leg on wall time itself,
 * canvas/traffic-legs.ts), and every other leg (a ping, an HTTP fetch, ARP) clamps exactly as before.
 *
 * P3 (R57(a), W5 fix step) the reported rate tells the truth when the engine cannot keep up. An unclamped flow at a
 * high rate can need more sub-steps than `MAX_SUBSTEPS` in one slice, or more CPU than the wall time it covers (the
 * caller then caps the catch-up at MAX_SLICE_WALL_MS and the rest of the wall time is lost). `runSlice` records the
 * fraction of the wall time that really passed (`SliceOptions.wallMs`, else `elapsedMs`) that the slice covered, and
 * `currentRate` (the batch's `effectiveRate`) is the clamped rate times that fraction: the "slow-motion" chip shows the
 * shortfall and the canvas extrapolates with the rate sim time really advances at, instead of running ahead and being
 * set back by every batch. A slice that covers its wall time restores the full rate; so do a new rate, play/pause and a
 * new world.
 *
 * `performance.now()` is read by the caller (index.ts), never here, so the slice algorithm stays testable.
 */
import { MS, inflightKey, matchesTraceFilter } from '@netforge/engine';
import type { InflightFrame, RunOptions, RunStats, SimTime, Simulation, TraceEvent, TraceFilter } from '@netforge/engine';
import { DEFAULT_CLOCK_POLICY, isTrafficDatagram, TRAFFIC_DATAGRAM_TAG, type ClockPolicy } from '../protocol';

/** @since P3 (R57(a)) Re-exported from protocol.ts, where the canvas reads them too. */
export { isTrafficDatagram, TRAFFIC_DATAGRAM_TAG };

/** Safety bound on sub-steps per slice. */
export const MAX_SUBSTEPS = 5000;

interface Flight {
  txStart: SimTime;
  arrive: SimTime;
  background: boolean;
  /** @since P3 (R57(a)) A leg of a traffic-generator datagram: never clamps. */
  traffic: boolean;
  /** The leg's `frameTx` (rebuilt from the engine's list on resync): what the clamp filter is matched against. */
  event: TraceEvent;
}

/** @since P1 Options for one slice (simulation mode: breakpoints). */
export interface SliceOptions extends RunOptions {
  /** Called once with the stats of the sub-step that stopped on a breakpoint; the slice then ends. */
  onStop?(stats: RunStats): void;
  /**
   * @since P3 (R57(a)) The wall time that really passed since the previous slice, when the caller capped `elapsedMs`
   * (a late tick: the engine could not keep up, or timers were throttled). Absent or not above `elapsedMs`: `elapsedMs`.
   */
  wallMs?: number;
}

/** A `frameTx` shaped from an engine in-flight frame, so a resync can be matched by the clamp filter too. */
function frameEventOf(f: InflightFrame): TraceEvent {
  const ev: Extract<TraceEvent, { kind: 'frameTx' }> = {
    t: f.txStart,
    kind: 'frameTx',
    pdu: f.pdu,
    link: f.link,
    from: f.from,
    to: f.to,
    txStart: f.txStart,
    txEnd: f.txEnd,
    arrive: f.arrive,
  };
  if (f.medium !== undefined) ev.medium = f.medium;
  if (f.rateBps !== undefined) ev.rateBps = f.rateBps;
  if (f.background === true) ev.background = true;
  return ev;
}

export interface WorkerClock {
  readonly policy: Readonly<ClockPolicy>;
  readonly playing: boolean;
  readonly rate: number;
  /** Frames the clamp currently considers (tests, status); never a traffic-generator leg (R57(a)). */
  readonly clampingFlights: number;
  setPlaying(p: boolean): void;
  setRate(r: number): void;
  setPolicy(p: Partial<ClockPolicy>): void;
  /**
   * @since P1 In simulation mode only frames matching the list filter keep the clock in slow motion (§4.11 item 2);
   * null (realtime) clamps on every frame.
   */
  setClampFilter(f: TraceFilter | null): void;
  /** Synchronous trace listener: records frame legs as they are emitted. */
  observe(ev: TraceEvent): void;
  /** Forget every leg (new simulation). */
  clear(): void;
  /** Rebuild the leg map from the engine's authoritative in-flight list. */
  resync(frames: readonly InflightFrame[]): void;
  /** Drop legs that already arrived. */
  prune(now: SimTime): void;
  /**
   * Sim ns per wall ms in force right now (rate×1e6 when idle or paused, lower while clamped). @since P3 (R57(a))
   * While playing it is also scaled by `throughput`.
   */
  currentRate(now: SimTime): number;
  /**
   * @since P3 (R57(a)) The fraction (0..1] of the wall time that really passed which the last slice covered: below 1
   * when it ended on `MAX_SUBSTEPS` or its wall time was capped by the caller (`SliceOptions.wallMs`); 1 after a
   * slice that covered it, a new rate, play/pause or a new world.
   */
  readonly throughput: number;
  /** Run one slice covering `elapsedMs` of wall time; returns the sim ns advanced. */
  runSlice(sim: Pick<Simulation, 'now' | 'nextEventTime' | 'runUntil'>, elapsedMs: number, opts?: SliceOptions): SimTime;
}

function validatePolicy(p: Partial<ClockPolicy>): void {
  if (p.minTransitWallMs !== undefined && (!Number.isFinite(p.minTransitWallMs) || p.minTransitWallMs < 0)) {
    throw new RangeError('minTransitWallMs must be a non-negative number.');
  }
  if (p.ignoreBackground !== undefined && typeof p.ignoreBackground !== 'boolean') {
    throw new TypeError('ignoreBackground must be true or false.');
  }
}

export function createWorkerClock(initial: Partial<ClockPolicy> = {}): WorkerClock {
  validatePolicy(initial);
  const policy: ClockPolicy = { ...DEFAULT_CLOCK_POLICY, ...initial };
  const flights = new Map<string, Flight>();
  let playing = false;
  let rate = 1;
  let clampFilter: TraceFilter | null = null;
  /** R57(a): the share of the real wall time the last slice covered (see `WorkerClock.throughput`). */
  let throughput = 1;

  const clamps = (f: Flight): boolean =>
    !f.traffic && !(f.background && policy.ignoreBackground) && (clampFilter === null || matchesTraceFilter(clampFilter, f.event));

  /** Shortest clamping leg and earliest clamping arrival, or undefined when nothing clamps. */
  function clampWindow(): { minDur: number; earliestArrive: number } | undefined {
    if (policy.minTransitWallMs <= 0) return undefined;
    let minDur = Number.POSITIVE_INFINITY;
    let earliestArrive = Number.POSITIVE_INFINITY;
    let any = false;
    for (const f of flights.values()) {
      if (!clamps(f)) continue;
      any = true;
      const dur = Math.max(1, f.arrive - f.txStart);
      if (dur < minDur) minDur = dur;
      if (f.arrive < earliestArrive) earliestArrive = f.arrive;
    }
    return any ? { minDur, earliestArrive } : undefined;
  }

  function prune(now: SimTime): void {
    for (const [k, f] of flights) if (f.arrive <= now) flights.delete(k);
  }

  return {
    get policy() {
      return policy;
    },
    get playing() {
      return playing;
    },
    get rate() {
      return rate;
    },
    get clampingFlights() {
      let n = 0;
      for (const f of flights.values()) if (clamps(f)) n++;
      return n;
    },
    get throughput() {
      return throughput;
    },
    setPlaying(p) {
      playing = p;
      throughput = 1;
    },
    setRate(r) {
      if (!Number.isFinite(r) || r <= 0) throw new RangeError(`Rate must be a positive number, got ${r}.`);
      rate = r;
      throughput = 1;
    },
    setPolicy(p) {
      validatePolicy(p);
      if (p.minTransitWallMs !== undefined) policy.minTransitWallMs = p.minTransitWallMs;
      if (p.ignoreBackground !== undefined) policy.ignoreBackground = p.ignoreBackground;
    },
    setClampFilter(f) {
      clampFilter = f;
    },
    observe(ev) {
      if (ev.kind === 'frameTx') {
        flights.set(inflightKey(ev.pdu.id, ev.link, ev.to), {
          txStart: ev.txStart,
          arrive: ev.arrive,
          background: ev.background === true,
          traffic: isTrafficDatagram(ev.pdu),
          event: ev,
        });
      } else if (ev.kind === 'frameAbort') {
        const key = inflightKey(ev.pdu.id, ev.link, ev.to);
        const f = flights.get(key);
        if (f !== undefined && ev.abortAt < f.arrive) f.arrive = Math.max(f.txStart, ev.abortAt);
      }
    },
    clear() {
      flights.clear();
      throughput = 1;
    },
    resync(frames) {
      flights.clear();
      throughput = 1;
      for (const f of frames) {
        const arrive = f.abortAt !== undefined && f.abortAt < f.arrive ? Math.max(f.txStart, f.abortAt) : f.arrive;
        flights.set(inflightKey(f.pdu.id, f.link, f.to), {
          txStart: f.txStart,
          arrive,
          background: f.background === true,
          traffic: isTrafficDatagram(f.pdu),
          event: frameEventOf(f),
        });
      }
    },
    prune,
    currentRate(now) {
      prune(now);
      const full = rate * MS;
      if (!playing) return full;
      const w = clampWindow();
      if (w === undefined) return full * throughput;
      return Math.min(full, w.minDur / policy.minTransitWallMs) * throughput;
    },
    runSlice(sim, elapsedMs, opts) {
      const start = sim.now;
      const runOpts: RunOptions | undefined = opts?.stopOn === undefined ? undefined : { stopOn: opts.stopOn };
      let stopped = false;
      /** One sub-step; with a breakpoint it reports the stop so the slice ends where the engine did. */
      const runUntil = (t: SimTime): void => {
        if (runOpts === undefined) {
          sim.runUntil(t);
          return;
        }
        const stats = sim.runUntil(t, runOpts);
        if (stats.stopped === 'breakpoint') {
          stopped = true;
          opts?.onStop?.(stats);
        }
      };
      const fullRate = rate * MS; // sim ns per wall ms
      let now = start;
      let wallLeft = elapsedMs;
      let guard = 0;

      while (wallLeft > 0 && !stopped && guard++ < MAX_SUBSTEPS) {
        prune(now);
        let r = fullRate;
        let cap = Number.POSITIVE_INFINITY;

        const next = sim.nextEventTime();
        if (next !== undefined) cap = next;

        const w = clampWindow();
        if (w !== undefined) {
          r = Math.min(fullRate, w.minDur / policy.minTransitWallMs);
          if (w.earliestArrive < cap) cap = w.earliestArrive;
        }

        const want = now + r * wallLeft;
        const stepTo = Math.round(Math.min(want, cap));

        if (stepTo <= now) {
          if (cap <= now) {
            // An event sits exactly at `now`: process it and re-evaluate (arrivals prune legs).
            runUntil(now);
            continue;
          }
          // Sub-nanosecond remainder at very low rates: nothing more to do this slice.
          break;
        }

        runUntil(stepTo);
        // A breakpoint leaves `now` at the matching event, short of `stepTo`.
        const advanced = sim.now - now;
        wallLeft -= advanced / r;
        now = sim.now;
      }

      // R57(a): the share of the real wall time this slice covered (it ended on the sub-step bound with wall time
      // left, or the caller capped the wall time it was given); a breakpoint ends the slice by design
      const cut = !stopped && wallLeft > 0 && guard > MAX_SUBSTEPS;
      const wall = Math.max(elapsedMs, opts?.wallMs ?? 0);
      const covered = cut ? Math.max(0, elapsedMs - wallLeft) : elapsedMs;
      throughput = stopped || !(wall > 0) ? 1 : Math.min(1, covered / wall);

      prune(sim.now);
      return sim.now - start;
    },
  };
}
