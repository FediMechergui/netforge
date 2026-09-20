/**
 * Simulation mode in the worker (ARCHITECTURE-P1 §4.11): playback mode, the two trace filters, breakpoints and the
 * pause-at-event step.
 *
 * The engine already owns the hard part (`runUntil(t, {stopOn})` and `stepToNext(filter, {until, maxEvents})` stop
 * after the WHOLE dispatch that emitted the first matching event, leaving `now` at it). This module holds the
 * state those calls need and turns a `RunStats` into the `stopped` / `ended` shapes the bridge posts, so
 * `worker/index.ts` stays a thin wiring layer and the decisions stay unit-testable.
 *
 * Slow motion follows the list filter: in simulation mode only frames matching `list` clamp the clock (§4.11 item
 * 2), so an unrelated background transfer cannot hold the learner at 1/1000 speed while they step through a DHCP
 * exchange.
 *
 * ponytail: `stepToNext` reuses the list filter rather than growing a second "step filter" — the panel the learner
 * is reading and the events they step through are the same set.
 */
import { matchesTraceFilter } from '@netforge/engine';
import type { RunOptions, RunStats, SimTime, TraceEvent, TraceFilter } from '@netforge/engine';
import { DEFAULT_SIM_FILTERS, SIM_STEP_HORIZON_NS, SIM_STEP_MAX_EVENTS, type PlaybackMode, type SimModeFilters, type StopInfo } from '../protocol';

export { DEFAULT_SIM_FILTERS } from '../protocol';

/** `stepToNext` horizon and cap (protocol.ts). */
export const stepOptions = (now: SimTime): { until: SimTime; maxEvents: number } => ({
  until: now + SIM_STEP_HORIZON_NS,
  maxEvents: SIM_STEP_MAX_EVENTS,
});

/**
 * The `stopped` field of a batch, or null when the run finished without a match. The engine reports both a
 * breakpoint and a step match as `stopped: 'breakpoint'`; `reason` says which call asked.
 */
export function stopInfoOf(stats: RunStats, reason: StopInfo['reason']): StopInfo | null {
  if (stats.stopped !== 'breakpoint' || stats.stopEvent === undefined || stats.stopCursor === undefined) return null;
  return { cursor: stats.stopCursor, event: stats.stopEvent, reason };
}

/**
 * Why a `stepToNext` found nothing (§4.11 item 4): the cap, an empty queue, or the 10 s horizon. `nextEventTime` is
 * the engine's after the step.
 */
export function endedOf(stats: RunStats, nextEventTime: SimTime | undefined): 'horizon' | 'maxEvents' | 'idle' {
  if (stats.stopped === 'maxEvents') return 'maxEvents';
  return nextEventTime === undefined ? 'idle' : 'horizon';
}

export interface WorkerSimMode {
  readonly mode: PlaybackMode;
  readonly filters: SimModeFilters;
  /** Returns true when the mode actually changed. Switching to 'realtime' clears `breakOn` (§4.11 item 6). */
  setMode(mode: PlaybackMode): boolean;
  setFilters(f: SimModeFilters): void;
  /** Options for a play slice: a breakpoint only stops the clock in simulation mode. */
  runOptions(): RunOptions | undefined;
  /** Filter the worker clock clamps on, or null when every frame clamps (realtime). */
  clampFilter(): TraceFilter | null;
  /** Whether a trace event matches the list filter (sim-events rows, clock clamp). */
  matchesList(ev: TraceEvent): boolean;
}

export function createSimMode(): WorkerSimMode {
  let mode: PlaybackMode = 'realtime';
  let filters: SimModeFilters = { list: { ...DEFAULT_SIM_FILTERS.list }, breakOn: null };

  return {
    get mode() {
      return mode;
    },
    get filters() {
      return filters;
    },
    setMode(next) {
      if (next !== 'realtime' && next !== 'simulation') throw new RangeError(`Playback mode must be 'realtime' or 'simulation', got ${String(next)}.`);
      if (next === mode) return false;
      mode = next;
      if (mode === 'realtime') filters = { list: filters.list, breakOn: null };
      return true;
    },
    setFilters(f) {
      filters = { list: { ...f.list }, breakOn: f.breakOn === null ? null : { ...f.breakOn } };
    },
    runOptions() {
      const breakOn = mode === 'simulation' ? filters.breakOn : null;
      return breakOn === null ? undefined : { stopOn: breakOn };
    },
    clampFilter() {
      return mode === 'simulation' ? filters.list : null;
    },
    matchesList(ev) {
      return matchesTraceFilter(filters.list, ev);
    },
  };
}
