/**
 * sim/replay.ts — deterministic replay of an input journal (ARCHITECTURE-P2 D18, §2.13, §3.13 steps 2–4) [SHOULD S1].
 *
 * A `Replay` is a second `Simulation` built from a journal's origin — `createSimulation({seed, mode, profile,
 * resume: origin.counters, journal: false, …})` plus `loadTopology(origin.topology)` when the journal started from a
 * loaded document — that re-applies the journal's entries at their exact positions. Between two entries it runs
 * `runUntil(e.at.now, {maxEvents: e.at.dispatched − dispatched})`, which reproduces both ways the live world reached
 * a position (a full `runUntil` advances the clock to `t`; a `step`, breakpoint or event-cap stop leaves it at the
 * last dispatched event), then applies the entry (`applyJournalOp`) and asserts the trace head equals the recorded
 * one — a mismatch throws `ReplayDivergenceError`, a determinism defect. An entry recorded with `threw` is expected
 * to throw again (the error is swallowed); an entry that threw only in the replay is a defect and propagates.
 *
 * Targets. `advance(target)` takes a `ReplayTarget`: a `JournalPosition`, or `{dispatched}` alone (the parked
 * replayers of §3.13 step 2 target `head − lag` events; the clock then ends at the last dispatched event). Every entry
 * at or before the target is applied — "position p" is the live world after every input recorded at p — and a
 * replay only moves forward: a target behind its position throws a RangeError. `advanceToEntry(i)` stops right after
 * entry i, before any later input at the same position (the per-entry check of `accept.p2.replay-exact`). `advanceTo(seek)` resolves a
 * `SeekTarget`: `{position}`; `{time: t}` = every entry recorded at `at.now <= t`, then `runUntil(t)` — the state the
 * live world had after `runUntil(t)` and its inputs at t; `{cursor: c}` = the state right after the dispatch or
 * input that emitted trace event c (events are stepped one at a time once the entries before c are in). `bound` (the
 * live position) is never passed. Both are cooperative: `maxEvents` caps the events dispatched in one call and the
 * result says whether the target was reached, so a worker advances in chunks and a newer seek can cancel an older
 * one. `extend(entries)` appends the live journal's newer entries.
 *
 * Cursors are aligned with the live world (trace/ring.ts `startHead` = `origin.counters.traceHead`), so
 * `replay.sim.traceQuery` answers with live cursors. The trace ring capacity defaults to 0 (parked replayers keep no
 * events) and the PDU registry to `DEFAULT_TIME_TRAVEL_BUDGET.reviewPduRegistry`; `catalog` must be the live world's
 * when that world was built with `SimulationOptions.catalog` (tests, §0 rule 13).
 *
 * The replay's facade journals nothing (`journal: false`), so a replay costs no memory beyond its world; `replay.sim`
 * is a full `Simulation` (snapshot, traceQuery, pdu, device access) — the caller keeps it read-only. Nothing here
 * draws randomness or reads a clock; several replays share one realm (no module-level state).
 */
import type { DeviceCatalog } from '../contracts/device.js';
import { ReplayDivergenceError, type JournalEntry, type JournalOp, type JournalOrigin, type JournalPosition, type SeekTarget, type SimJournal } from '../contracts/journal.js';
import type { Simulation } from '../contracts/simulation.js';
import { assertSimTime, type SimTime } from '../contracts/time.js';
import { DEFAULT_TIME_TRAVEL_BUDGET } from '../contracts/timeline.js';
import { comparePositions } from './journal.js';
import { DEFAULT_STEP_MAX_EVENTS } from './run-control.js';
import { createSimulation } from './simulation.js';

/** @since P2 [S1] Thrown when a replay runs out of events before a position its journal describes (a determinism defect). */
export class ReplayExhaustedError extends Error {
  readonly position: JournalPosition;
  readonly target: number;
  constructor(position: JournalPosition, target: number) {
    super(`The replay ran out of events at (${position.dispatched}, ${position.now}) before reaching event ${target}: the journal does not describe this world.`);
    this.name = 'ReplayExhaustedError';
    this.position = position;
    this.target = target;
  }
}

/** Where a replay is asked to go: a position, or an event count alone (the clock ends at the last dispatched event). */
export type ReplayTarget = JournalPosition | { readonly dispatched: number; readonly now?: undefined };

/** Options of `createReplay`. */
export interface ReplayOptions {
  /** Trace ring capacity of the replay world (default 0: count only, as parked replayers do). */
  traceCapacity?: number;
  /** Cap of the replay's id → PDU registry (default `DEFAULT_TIME_TRAVEL_BUDGET.reviewPduRegistry`). */
  pduRegistryLimit?: number;
  /** The live world's catalog when it was built with `SimulationOptions.catalog` (tests and tooling only). */
  catalog?: DeviceCatalog;
}

/** Limits of one `advance` / `advanceTo` call. */
export interface AdvanceOptions {
  /** At most this many events are dispatched in this call (default: no cap). Entries between them are still applied. */
  maxEvents?: number;
  /** `advanceTo` only: the live world's position; the replay never passes it (a `{time}` or `{cursor}` beyond it stops there). */
  bound?: JournalPosition;
}

/** What one `advance` / `advanceTo` call did. */
export interface AdvanceResult {
  /** Events dispatched by this call. */
  readonly events: number;
  /** Journal entries applied by this call. */
  readonly entries: number;
  /** True when the target was reached (false: the cap, the bound, or the end of the known journal and queue stopped it). */
  readonly reached: boolean;
}

/** A replay of an input journal (file header). */
export interface Replay {
  /** The replay world. Read it (snapshot, traceQuery, pdu, device); never drive or mutate it from outside. */
  readonly sim: Simulation;
  /** The journal's origin (the replay's own copy). */
  readonly origin: JournalOrigin;
  /** The entries known to this replay, in order. */
  readonly entries: readonly JournalEntry[];
  /** Number of entries applied so far (entries `[0, applied)` are in). */
  readonly applied: number;
  /** The replay world's position. */
  position(): JournalPosition;
  /** Append the live journal's newer entries: those beyond `entries.length` of `all` (the whole live list) are copied in. */
  extend(all: readonly JournalEntry[]): void;
  /** Move forward to `target` (every entry at or before it applied), at most `opts.maxEvents` events in this call. */
  advance(target: ReplayTarget, opts?: AdvanceOptions): AdvanceResult;
  /**
   * Move forward to the state right after entry `index` (entries `[0, index]` applied, no later entry even at the
   * same position), at most `opts.maxEvents` events in this call. Reached at once when that entry is already in.
   */
  advanceToEntry(index: number, opts?: AdvanceOptions): AdvanceResult;
  /** Resolve a `SeekTarget` and move forward to it (file header), at most `opts.maxEvents` events in this call. */
  advanceTo(target: SeekTarget, opts?: AdvanceOptions): AdvanceResult;
}

/** Apply one journaled op to a facade (the same call the live world made). */
export function applyJournalOp(sim: Simulation, op: JournalOp): void {
  switch (op.op) {
    case 'addDevice':
      sim.addDevice(op.spec);
      return;
    case 'removeDevice':
      sim.removeDevice(op.id);
      return;
    case 'renameDevice':
      sim.renameDevice(op.id, op.name);
      return;
    case 'moveDevice':
      sim.moveDevice(op.id, op.position);
      return;
    case 'setPower':
      sim.setPower(op.id, op.on);
      return;
    case 'addLink':
      sim.addLink(op.spec);
      return;
    case 'removeLink':
      sim.removeLink(op.id);
      return;
    case 'setImpairments':
      sim.setImpairments(op.id, op.imp);
      return;
    case 'injectFault':
      sim.injectFault(op.at, op.fault);
      return;
    case 'configure':
      sim.configure(op.device, op.commands, op.opts);
      return;
    case 'insertModule':
      sim.insertModule(op.device, op.slot, op.module);
      return;
    case 'removeModule':
      sim.removeModule(op.device, op.slot);
      return;
    case 'setDeviceUi':
      sim.setDeviceUi(op.device, op.ui);
      return;
    case 'setCanvasScale':
      sim.setCanvasScale(op.metresPerUnit);
      return;
    case 'hostRequest':
      sim.hostRequest(op.device, op.req);
      return;
    case 'cliOpen':
      sim.cli.open(op.device, op.via);
      return;
    case 'cliExec':
      sim.cli.exec(op.session, op.line);
      return;
    case 'cliInterrupt':
      sim.cli.interrupt(op.session);
      return;
    case 'cliClose':
      sim.cli.close(op.session);
      return;
  }
}

/** The world a journal starts from: a fresh facade resuming the origin's counters, with the origin topology loaded. */
export function createOriginSimulation(origin: JournalOrigin, opts: ReplayOptions = {}): Simulation {
  const sim = createSimulation({
    seed: origin.seed,
    mode: origin.mode,
    profile: origin.profile,
    resume: origin.counters,
    journal: false,
    traceCapacity: opts.traceCapacity ?? 0,
    pduRegistryLimit: opts.pduRegistryLimit ?? DEFAULT_TIME_TRAVEL_BUDGET.reviewPduRegistry,
    ...(opts.catalog === undefined ? {} : { catalog: opts.catalog }),
  });
  if (origin.topology !== null) sim.loadTopology(structuredClone(origin.topology));
  return sim;
}

/** Throw a RangeError unless `n` is undefined or a non-negative integer. */
function checkCap(n: number | undefined): number {
  if (n === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`maxEvents must be a non-negative integer, got ${n}`);
  return n;
}

/** Create a replay of `journal` (file header). The journal is copied; later growth arrives through `extend`. */
export function createReplay(journal: SimJournal, opts: ReplayOptions = {}): Replay {
  const origin: JournalOrigin = structuredClone(journal.origin);
  const entries: JournalEntry[] = structuredClone(journal.entries) as JournalEntry[];
  const sim = createOriginSimulation(origin, opts);
  let applied = 0;

  const position = (): JournalPosition => sim.position();
  const head = (): number => sim.traceQuery({ from: 0, limit: 0 }).head;

  /** Apply entry `i` (the world is at its position) and check the trace head. */
  const applyEntry = (i: number): void => {
    const e = entries[i]!;
    const op = structuredClone(e.op);
    try {
      applyJournalOp(sim, op);
    } catch (err) {
      if (e.threw !== true) throw err;
    }
    const actual = head();
    if (actual !== e.traceHead) throw new ReplayDivergenceError(i, e.traceHead, actual);
    applied = i + 1;
  };

  /**
   * Dispatch toward `(dispatched, now)`: `need` events (capped by `budget`), then the clock to `now` when every
   * needed event is in and `now` is given. Returns the events dispatched; throws `ReplayExhaustedError` when the
   * world has fewer events than the journal says it dispatched.
   */
  const runToward = (dispatched: number, now: SimTime | undefined, budget: number): number => {
    const need = dispatched - position().dispatched;
    if (need <= 0 && now === undefined) return 0;
    const cap = Math.max(0, Math.min(need, budget));
    let events = 0;
    if (now !== undefined) {
      // a full runUntil advances the clock to `now`; a capped one leaves it at the last dispatched event, as the live world did
      events = sim.runUntil(cap < need ? Math.max(sim.now, now) : now, { maxEvents: cap }).events;
    } else {
      // an event count alone: time by time, so an exhausted queue never moves the clock into the future
      while (events < cap) {
        const next = sim.nextEventTime();
        if (next === undefined) break;
        const r = sim.runUntil(next, { maxEvents: cap - events });
        events += r.events;
        if (r.events === 0) break;
      }
    }
    if (events < cap) throw new ReplayExhaustedError(position(), dispatched);
    return events;
  };

  const advance = (target: ReplayTarget, opts?: AdvanceOptions): AdvanceResult => {
    if (!Number.isSafeInteger(target.dispatched) || target.dispatched < 0) {
      throw new RangeError(`A replay target needs a non-negative integer event count, got ${String(target.dispatched)}`);
    }
    if (target.now !== undefined) assertSimTime(target.now, 'replay target now');
    const budget = checkCap(opts?.maxEvents);
    const goal: JournalPosition = { dispatched: target.dispatched, now: target.now ?? Number.MAX_SAFE_INTEGER };
    const here = position();
    if (here.dispatched > target.dispatched || (target.now !== undefined && comparePositions(here, goal) > 0)) {
      throw new RangeError(`A replay only moves forward: it is at (${here.dispatched}, ${here.now}) and was asked for (${target.dispatched}, ${target.now ?? '-'}).`);
    }
    let events = 0;
    let count = 0;
    for (;;) {
      const e = entries[applied];
      if (e !== undefined && (target.now === undefined ? e.at.dispatched <= target.dispatched : comparePositions(e.at, goal) <= 0)) {
        const need = e.at.dispatched - position().dispatched;
        if (need > budget - events) {
          events += runToward(e.at.dispatched, undefined, budget - events);
          return { events, entries: count, reached: false };
        }
        events += runToward(e.at.dispatched, e.at.now, need);
        applyEntry(applied);
        count++;
        continue;
      }
      const need = target.dispatched - position().dispatched;
      if (need > budget - events) {
        events += runToward(target.dispatched, undefined, budget - events);
        return { events, entries: count, reached: false };
      }
      events += runToward(target.dispatched, target.now, need);
      const at = position();
      const reached = at.dispatched >= target.dispatched && (target.now === undefined || at.now >= target.now);
      return { events, entries: count, reached };
    }
  };

  const advanceToEntry = (index: number, opts?: AdvanceOptions): AdvanceResult => {
    if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
      throw new RangeError(`This replay knows entries 0 to ${entries.length - 1}, not ${String(index)}.`);
    }
    const budget = checkCap(opts?.maxEvents);
    let events = 0;
    let count = 0;
    while (applied <= index) {
      const e = entries[applied]!;
      const need = e.at.dispatched - position().dispatched;
      if (need > budget - events) {
        events += runToward(e.at.dispatched, undefined, budget - events);
        return { events, entries: count, reached: false };
      }
      events += runToward(e.at.dispatched, e.at.now, need);
      applyEntry(applied);
      count++;
    }
    return { events, entries: count, reached: true };
  };

  /** `{time}`: entries at `at.now <= t` (and within the bound), then the clock to `min(t, bound.now)`. */
  const advanceToTime = (t: SimTime, opts?: AdvanceOptions): AdvanceResult => {
    assertSimTime(t, 'seek time');
    const bound = opts?.bound;
    const budget = checkCap(opts?.maxEvents);
    let events = 0;
    let count = 0;
    for (;;) {
      const e = entries[applied];
      if (e !== undefined && e.at.now <= t && (bound === undefined || comparePositions(e.at, bound) <= 0)) {
        const need = e.at.dispatched - position().dispatched;
        if (need > budget - events) {
          events += runToward(e.at.dispatched, undefined, budget - events);
          return { events, entries: count, reached: false };
        }
        events += runToward(e.at.dispatched, e.at.now, need);
        applyEntry(applied);
        count++;
        continue;
      }
      const until = bound === undefined ? t : Math.min(t, bound.now);
      const cap = bound === undefined ? budget - events : Math.min(budget - events, bound.dispatched - position().dispatched);
      const r = sim.runUntil(Math.max(sim.now, until), { maxEvents: Math.max(0, Math.min(cap, Number.MAX_SAFE_INTEGER)) });
      events += r.events;
      return { events, entries: count, reached: sim.now >= t };
    }
  };

  /**
   * `{cursor}`: entries and single events until the trace head passes `c`. Without a bound the cap defaults to
   * `DEFAULT_STEP_MAX_EVENTS`, because periodic timers would otherwise let a cursor beyond the live head run forever.
   */
  const advanceToCursor = (c: number, opts?: AdvanceOptions): AdvanceResult => {
    if (!Number.isSafeInteger(c) || c < 0) throw new RangeError(`seek cursor must be a non-negative integer, got ${String(c)}`);
    const bound = opts?.bound;
    const budget = checkCap(opts?.maxEvents ?? (bound === undefined ? DEFAULT_STEP_MAX_EVENTS : undefined));
    let events = 0;
    let count = 0;
    while (head() <= c) {
      const here = position();
      if (bound !== undefined && here.dispatched >= bound.dispatched) {
        // at the bound's event count: only the clock may still move, and only up to the bound
        const e = entries[applied];
        if (e !== undefined && e.at.dispatched === here.dispatched && comparePositions(e.at, bound) <= 0) {
          if (e.at.now > here.now) sim.runUntil(e.at.now, { maxEvents: 0 });
          applyEntry(applied);
          count++;
          continue;
        }
        if (here.now < bound.now) sim.runUntil(bound.now, { maxEvents: 0 });
        return { events, entries: count, reached: head() > c };
      }
      const e = entries[applied];
      if (e !== undefined && e.at.dispatched === here.dispatched) {
        if (e.at.now > here.now) sim.runUntil(e.at.now, { maxEvents: 0 });
        applyEntry(applied);
        count++;
        continue;
      }
      if (events >= budget) return { events, entries: count, reached: false };
      if (sim.step() === undefined) return { events, entries: count, reached: false };
      events++;
    }
    return { events, entries: count, reached: true };
  };

  return {
    sim,
    origin,
    entries,
    get applied(): number {
      return applied;
    },
    position,
    extend(all: readonly JournalEntry[]): void {
      for (let i = entries.length; i < all.length; i++) entries.push(structuredClone(all[i]!));
    },
    advance,
    advanceToEntry,
    advanceTo(target: SeekTarget, opts?: AdvanceOptions): AdvanceResult {
      if ('position' in target) return advance(target.position, opts);
      if ('time' in target) return advanceToTime(target.time, opts);
      return advanceToCursor(target.cursor, opts);
    },
  };
}

/**
 * Replay `journal` in one go: to `target` when given, else to the position after its last entry (or the origin when
 * it has none). Returns the replay world.
 */
export function replayJournal(journal: SimJournal, target?: ReplayTarget, opts: ReplayOptions = {}): Simulation {
  const replay = createReplay(journal, opts);
  const last = journal.entries[journal.entries.length - 1];
  const goal: ReplayTarget = target ?? (last === undefined ? { dispatched: 0, now: 0 } : last.at);
  replay.advance(goal);
  return replay.sim;
}
