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
 * `performance.now()` is read by the caller (index.ts), never here, so the slice algorithm stays testable.
 */
import { MS, inflightKey, matchesTraceFilter } from '@netforge/engine';
import type { InflightFrame, RunOptions, RunStats, SimTime, Simulation, TraceEvent, TraceFilter } from '@netforge/engine';
import { DEFAULT_CLOCK_POLICY, type ClockPolicy } from '../protocol';

/** Safety bound on sub-steps per slice. */
export const MAX_SUBSTEPS = 5000;

interface Flight {
  txStart: SimTime;
  arrive: SimTime;
  background: boolean;
  /** The leg's `frameTx` (rebuilt from the engine's list on resync): what the clamp filter is matched against. */
  event: TraceEvent;
}

/** @since P1 Options for one slice (simulation mode: breakpoints). */
export interface SliceOptions extends RunOptions {
  /** Called once with the stats of the sub-step that stopped on a breakpoint; the slice then ends. */
  onStop?(stats: RunStats): void;
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
  /** Frames the clamp currently considers (tests, status). */
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
  /** Sim ns per wall ms in force right now (rate×1e6 when idle or paused, lower while clamped). */
  currentRate(now: SimTime): number;
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

  const clamps = (f: Flight): boolean =>
    !(f.background && policy.ignoreBackground) && (clampFilter === null || matchesTraceFilter(clampFilter, f.event));

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
    setPlaying(p) {
      playing = p;
    },
    setRate(r) {
      if (!Number.isFinite(r) || r <= 0) throw new RangeError(`Rate must be a positive number, got ${r}.`);
      rate = r;
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
    },
    resync(frames) {
      flights.clear();
      for (const f of frames) {
        const arrive = f.abortAt !== undefined && f.abortAt < f.arrive ? Math.max(f.txStart, f.abortAt) : f.arrive;
        flights.set(inflightKey(f.pdu.id, f.link, f.to), { txStart: f.txStart, arrive, background: f.background === true, event: frameEventOf(f) });
      }
    },
    prune,
    currentRate(now) {
      prune(now);
      const full = rate * MS;
      if (!playing) return full;
      const w = clampWindow();
      if (w === undefined) return full;
      return Math.min(full, w.minDur / policy.minTransitWallMs);
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

      prune(sim.now);
      return sim.now - start;
    },
  };
}
