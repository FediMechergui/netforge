/**
 * The worker's time machine [SHOULD S1] (ARCHITECTURE-P2 D18, §2.13, §3.13 steps 2–6, §12.2 R8; W4 web-shell):
 * parked replayers a fixed distance behind the live run, seeks, and review ("viewing the past").
 *
 * Over the W2 `sim/journal.ts` + `sim/replay.ts`: the live Simulation journals every outermost mutating call; a
 * `Replay` re-applies that journal from its origin and reaches any earlier position byte for byte. This module keeps
 * `budget.replayers` replays PARKED in slots, slot i targeting `head − lagsEvents[i]` live events (trace capacity 0,
 * a small PDU registry), each advanced in chunks of `parkChunk` events per worker tick and idle once at or ahead of
 * its target (live events move the targets forward). A seek first checks and normalises its target
 * (`normaliseSeekTarget`: a time is rounded to whole nanoseconds; a malformed target is refused before anything
 * moves), then takes the parked replayer with the largest position at or before the target out of its slot (a target
 * older than every parked one takes a fresh replay from the origin; a target in the cursor replay's own future just
 * advances it), advances it in cooperative chunks (a newer seek or a `leave` supersedes an older seek between two
 * chunks) and makes it the CURSOR replay that serves review. Only a cursor that serves review feeds the host's
 * `observe` (the worker clock); the events a seek replays on the way reach the review ring only.
 *
 * Lifecycle (§3.13 step 5, binding): a replayer is parked in exactly one slot, or the cursor, or discarded; it only
 * moves forward. When review ends (`leave`, or the cursor reaching the live position) the cursor replay is re-parked
 * in the slot it was taken from; one that came from the origin, or whose slot is taken, goes to the empty slot with
 * the largest lag, or is discarded when none is empty. An empty slot is refilled lazily from the origin in background
 * chunks, only while no seek or review is active (empty slots take a tick's budget before the parked ones that are a
 * little behind). Nothing is rebuilt eagerly. A slot whose target is the live event count itself (lag 0) follows the
 * live clock as well, so it holds the live position exactly.
 *
 * Cost (§3.13 step 6): `seek` returns the events it dispatched, which is exactly `target.dispatched − p` for the
 * replayer it started from (asserted by the tests, never timed).
 *
 * Review: while the cursor replay serves review the worker's clock, batches and `snapshot`/`pdu` read it through
 * `reviewSim`, a view of the replay world whose `trace(cursor)` answers from a REVIEW RING this module fills from the
 * replay's trace listener (`budget.reviewTraceCapacity` events; the replay's own ring keeps nothing). Cursors are the
 * live ones (trace/ring.ts `startHead`), so a review event's cursor can still be paged in the live ring. `play`/`step`
 * in review go through `reviewDriver`, `reviewStep`, `reviewRunUntil` and `reviewRunToLive`, which never pass the live
 * position (the bound) and apply journal inputs at their positions (`Replay.advanceTo`); a direct run call on the
 * replay world would skip them, so nothing here exposes one.
 *
 * Observation purity: the live world is only READ here (`position`, `journal`); replays are separate worlds in the
 * same realm (no module-level state in the engine), so review never perturbs the live run. No clock, no randomness.
 */
import {
  DEFAULT_TIME_TRAVEL_BUDGET,
  MAX_SIM_TIME,
  ReplayDivergenceError,
  ReplayExhaustedError,
  comparePositions,
  createReplay,
  createTraceRing,
  isJournalPosition,
} from '@netforge/engine';
import type {
  JournalPosition,
  PduView,
  Replay,
  RunStats,
  SeekTarget,
  SimJournal,
  SimTime,
  Simulation,
  TimeTravelBudget,
  TraceEvent,
  TraceRingImpl,
} from '@netforge/engine';
import type { ReviewInfo } from '../protocol';

/** Events a parked replayer may dispatch per worker tick, shared by the slots that are behind (§3.13 step 2). */
export const PARK_CHUNK_EVENTS = 500;
/** Events one seek chunk dispatches before yielding to newer messages. */
export const SEEK_CHUNK_EVENTS = 5_000;
/** Most events one review batch carries (the store keeps that many in `timeline.reviewEvents`). */
export const REVIEW_EVENTS_PER_BATCH = 2_000;

/** Thrown to the caller of a seek that a newer seek (or `leave`) replaced between two chunks. */
export class SeekSupersededError extends Error {
  constructor() {
    super('This seek was replaced by a newer one.');
    this.name = 'SeekSupersededError';
  }
}

/** What the time machine reads from the worker. */
export interface TimeMachineHost {
  /** The live world (read only here). */
  sim(): Simulation;
  /**
   * Called with every event the cursor replay emits while it serves review (review play and step; the worker clock
   * keeps its in-flight legs from it) — never with the events a seek replays on its way to the target.
   */
  observe?(ev: TraceEvent): void;
  /** Between two seek chunks: a macrotask, so a newer message reaches the worker (default `setTimeout(0)`). */
  yieldToHost?(): Promise<void>;
}

export interface TimeMachineOptions {
  budget?: Partial<TimeTravelBudget>;
  /** Events per seek chunk (default SEEK_CHUNK_EVENTS). */
  seekChunk?: number;
  /** Events per worker tick for the parked replayers (default PARK_CHUNK_EVENTS). */
  parkChunk?: number;
}

/** One slot as the tests and the status see it. */
export interface SlotView {
  readonly slot: number;
  readonly lag: number;
  /** `head − lag`, never below 0. */
  readonly target: number;
  /** The parked replayer's position, or null when the slot is empty. */
  readonly position: JournalPosition | null;
}

/** The cursor replay as the tests see it. */
export interface CursorView {
  /** The slot it was taken from, or 'origin'. */
  readonly from: number | 'origin';
  readonly position: JournalPosition;
  /** False while the seek that took it is still in flight. */
  readonly ready: boolean;
}

/** What one seek did. */
export interface SeekResult {
  /** Events dispatched by this seek (`target.dispatched − p`, §3.13 step 6). */
  readonly replayedEvents: number;
  /** The target was the live position itself: there is nothing to review. */
  readonly atLive: boolean;
}

/** The time machine (file header). */
export interface TimeMachine {
  readonly budget: TimeTravelBudget;
  /** A cursor replay serves review. */
  readonly reviewing: boolean;
  /** A seek is in flight. */
  readonly seeking: boolean;
  /** `reviewing || seeking`: the live world must not change. */
  readonly busy: boolean;
  /** The cursor replay's world with `trace` answered from the review ring; undefined while not reviewing. */
  readonly reviewSim: Simulation | undefined;
  setBudget(b: Partial<TimeTravelBudget>): void;
  /** The live journal grew (a mutating facade call): re-read it before the next replay advance. */
  markJournalDirty(): void;
  /** A new world: drop every replayer and the cached journal; supersede a seek in flight. */
  reset(): void;
  /** Background work for one worker tick (parked replayers, lazy refills). */
  tick(): void;
  /** Enter (or move within) review at `target`; rejects with `SeekSupersededError` when replaced. */
  seek(target: SeekTarget): Promise<SeekResult>;
  /** End review (or cancel a seek in flight): the cursor replay is re-parked by the §3.13 rule. */
  leave(): void;
  reviewInfo(): ReviewInfo | undefined;
  /** The cursor replay reached the live position. */
  atLive(): boolean;
  /** The cursor replay as the worker clock drives it (never past the live position; reports it as a stop). */
  reviewDriver(): Pick<Simulation, 'now' | 'nextEventTime' | 'runUntil'>;
  /** One event forward in review (with the inputs recorded at that count), clamped to the live position. */
  reviewStep(): void;
  /** Forward to sim time `t` in review, clamped to the live position. */
  reviewRunUntil(t: SimTime): void;
  /** Forward to the live position. */
  reviewRunToLive(): void;
  /** A PDU of the reviewed world (its registry is small; undefined when evicted or unknown). */
  reviewPdu(id: Parameters<Simulation['pdu']>[0]): PduView | undefined;
  slots(): SlotView[];
  cursor(): CursorView | undefined;
}

interface Cursor {
  replay: Replay;
  from: number | 'origin';
  ready: boolean;
  ring: TraceRingImpl;
  view: Simulation;
  unsubscribe: () => void;
}

const headOf = (sim: Simulation): number => sim.traceQuery({ from: 0, limit: 0 }).head;

function checkBudget(b: Partial<TimeTravelBudget>): void {
  const count = (v: unknown, what: string, min: number): void => {
    if (!Number.isSafeInteger(v) || (v as number) < min) throw new RangeError(`${what} must be an integer of at least ${min}, got ${String(v)}.`);
  };
  if (b.replayers !== undefined) count(b.replayers, 'replayers', 0);
  if (b.reviewTraceCapacity !== undefined) count(b.reviewTraceCapacity, 'reviewTraceCapacity', 0);
  if (b.reviewPduRegistry !== undefined) count(b.reviewPduRegistry, 'reviewPduRegistry', 0);
  // the lane index keeps at least two entries (lanes.ts): the same bound here, so a budget this check accepts can
  // never be refused by the lane index after the time machine applied it (the worker applies both, all or nothing)
  if (b.laneEntries !== undefined) count(b.laneEntries, 'laneEntries', 2);
  if (b.lagsEvents !== undefined) {
    if (!Array.isArray(b.lagsEvents)) throw new RangeError('lagsEvents must be a list of event counts.');
    let prev = -1;
    for (const lag of b.lagsEvents) {
      count(lag, 'each lag', 0);
      if (lag < prev) throw new RangeError('lagsEvents must be ascending.');
      prev = lag;
    }
  }
}

/**
 * A seek target checked and normalised BEFORE anything moves (§3.13 step 3): a `{time}` is rounded to whole
 * nanoseconds and kept in [0, MAX_SIM_TIME] (a scrubber maps pixels to fractional times; sim time is integral); a
 * `{cursor}` must be a non-negative integer; a `{position}` must be a journal position. Anything else is a RangeError,
 * thrown before a replayer is taken or a seek superseded, so a bad target never disturbs an active review.
 */
export function normaliseSeekTarget(target: SeekTarget): SeekTarget {
  const t = target as Partial<Record<'time' | 'cursor' | 'position', unknown>> | null;
  if (t === null || typeof t !== 'object') throw new RangeError('A seek needs a time, a cursor or a position.');
  if ('time' in t) {
    const time = t.time;
    if (typeof time !== 'number' || !Number.isFinite(time)) throw new RangeError(`A seek time must be a finite sim time, got ${String(time)}.`);
    return { time: Math.min(MAX_SIM_TIME, Math.max(0, Math.round(time))) };
  }
  if ('cursor' in t) {
    const cursor = t.cursor;
    if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < 0) throw new RangeError(`A seek cursor must be a non-negative integer, got ${String(cursor)}.`);
    return { cursor };
  }
  if ('position' in t) {
    if (!isJournalPosition(t.position)) throw new RangeError('A seek position needs a non-negative integer event count and sim time.');
    return { position: t.position };
  }
  throw new RangeError('A seek needs a time, a cursor or a position.');
}

/** The default yield between seek chunks: one macrotask. */
const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export function createTimeMachine(host: TimeMachineHost, opts: TimeMachineOptions = {}): TimeMachine {
  checkBudget(opts.budget ?? {});
  const budget: TimeTravelBudget = { ...DEFAULT_TIME_TRAVEL_BUDGET, lagsEvents: [...DEFAULT_TIME_TRAVEL_BUDGET.lagsEvents], ...opts.budget };
  const seekChunk = opts.seekChunk ?? SEEK_CHUNK_EVENTS;
  const parkChunk = opts.parkChunk ?? PARK_CHUNK_EVENTS;
  const yieldToHost = host.yieldToHost ?? macrotask;

  /** Lag of each slot (`budget.lagsEvents` cut to `budget.replayers`). */
  let lags: number[] = [];
  let slots: (Replay | undefined)[] = [];
  let cursor: Cursor | undefined;
  let seekSeq = 0;
  let inFlight = 0;
  let cached: SimJournal | undefined;
  let stale = true;
  /** A replay diverged from the journal (a determinism defect): replayers are off until the next world. */
  let faulted: Error | undefined;

  const journal = (): SimJournal => {
    if (stale || cached === undefined) {
      cached = host.sim().journal();
      stale = false;
    }
    return cached;
  };

  const extend = (r: Replay): void => {
    const j = journal();
    if (j.entries.length > r.entries.length) r.extend(j.entries);
  };

  const build = (): Replay => createReplay(journal(), { traceCapacity: 0, pduRegistryLimit: budget.reviewPduRegistry });

  const livePosition = (): JournalPosition => host.sim().position();

  const targetOf = (slot: number, live: JournalPosition): number => Math.max(0, live.dispatched - (lags[slot] as number));

  const applySlots = (): void => {
    const n = Math.min(budget.replayers, budget.lagsEvents.length);
    lags = budget.lagsEvents.slice(0, n);
    const next: (Replay | undefined)[] = [];
    for (let i = 0; i < n; i++) next.push(slots[i]);
    slots = next;
  };
  applySlots();

  const isFault = (e: unknown): e is Error => e instanceof ReplayDivergenceError || e instanceof ReplayExhaustedError;

  /** A replay went a different way than the journal: keep nothing built on it. */
  const fault = (e: Error): never => {
    faulted = e;
    if (cursor !== undefined) {
      cursor.unsubscribe();
      cursor = undefined;
    }
    slots = slots.map(() => undefined);
    throw e;
  };

  // ── the cursor ──────────────────────────────────────────────────────────

  const attachCursor = (replay: Replay, from: number | 'origin'): Cursor => {
    const ring = createTraceRing(budget.reviewTraceCapacity, headOf(replay.sim));
    const trace = (c: number): { events: TraceEvent[]; next: number; dropped: number } => ring.since(c);
    const view = new Proxy(replay.sim, {
      get(target, prop) {
        if (prop === 'trace') return trace;
        return Reflect.get(target, prop, target) as unknown;
      },
    });
    const cursor: Cursor = { replay, from, ready: false, ring, view, unsubscribe: () => undefined };
    cursor.unsubscribe = replay.sim.onTrace((ev) => {
      // the review ring keeps everything (it is bounded by `reviewTraceCapacity`); the host (the worker clock) hears
      // only a cursor that serves review — a seek's replayed prefix is not the instant on screen, and the worker
      // rebuilds the clock's legs from the reviewed snapshot as soon as the seek lands
      ring.emit(ev);
      if (cursor.ready) host.observe?.(ev);
    });
    return cursor;
  };

  /** Re-park a cursor replay: its own slot when empty, else the empty slot with the largest lag, else discarded. */
  const repark = (c: Cursor): void => {
    c.unsubscribe();
    if (typeof c.from === 'number' && c.from < slots.length && slots[c.from] === undefined) {
      slots[c.from] = c.replay;
      return;
    }
    let best = -1;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] === undefined && (best < 0 || (lags[i] as number) > (lags[best] as number))) best = i;
    }
    if (best >= 0) slots[best] = c.replay;
  };

  const requireCursor = (): Cursor => {
    if (cursor === undefined) throw new Error('There is no review in progress.');
    return cursor;
  };

  /** True when `r` can still reach `target` moving forward. */
  const eligible = (r: Replay, target: SeekTarget): boolean => {
    if ('position' in target) return comparePositions(r.position(), target.position) <= 0;
    if ('time' in target) return r.position().now <= target.time;
    return headOf(r.sim) <= target.cursor;
  };

  /** A `{position}` beyond the live world is the live world. */
  const clampTarget = (target: SeekTarget, live: JournalPosition): SeekTarget => {
    if ('position' in target && comparePositions(target.position, live) > 0) return { position: live };
    return target;
  };

  /** The replayer a seek starts from (§3.13 step 3), installed as the cursor. */
  const takeSource = (target: SeekTarget): Cursor => {
    if (cursor !== undefined && eligible(cursor.replay, target)) return cursor;
    let best = -1;
    for (let i = 0; i < slots.length; i++) {
      const r = slots[i];
      if (r === undefined || !eligible(r, target)) continue;
      const b = slots[best];
      if (b === undefined || comparePositions(r.position(), b.position()) > 0) best = i;
    }
    let next: Cursor;
    if (best >= 0) {
      const r = slots[best] as Replay;
      slots[best] = undefined;
      next = attachCursor(r, best);
    } else {
      next = attachCursor(build(), 'origin');
    }
    if (cursor !== undefined) repark(cursor);
    cursor = next;
    return next;
  };

  const atLive = (): boolean => {
    const c = cursor;
    if (c === undefined) return false;
    return comparePositions(c.replay.position(), livePosition()) >= 0;
  };

  const seek = async (target: SeekTarget): Promise<SeekResult> => {
    if (faulted !== undefined) throw faulted;
    // checked before anything moves: a malformed target neither ends a review nor supersedes a seek in flight
    const wanted = normaliseSeekTarget(target);
    const seq = ++seekSeq;
    inFlight++;
    let c: Cursor | undefined;
    try {
      const live = livePosition();
      const goal = clampTarget(wanted, live);
      c = takeSource(goal);
      c.ready = false;
      extend(c.replay);
      let total = 0;
      for (;;) {
        const r = c.replay.advanceTo(goal, { maxEvents: seekChunk, bound: live });
        total += r.events;
        if (r.reached || (r.events === 0 && r.entries === 0)) break;
        if (seq !== seekSeq) throw new SeekSupersededError();
        await yieldToHost();
        if (seq !== seekSeq) throw new SeekSupersededError();
      }
      c.ready = true;
      return { replayedEvents: total, atLive: atLive() };
    } catch (e) {
      if (isFault(e)) fault(e);
      // the newest seek failed for its own reasons: nothing serves review, so the replay goes back to a slot
      if (seq === seekSeq && cursor !== undefined && cursor === c) {
        repark(cursor);
        cursor = undefined;
      }
      throw e;
    } finally {
      inFlight--;
    }
  };

  const leave = (): void => {
    seekSeq++;
    if (cursor === undefined) return;
    repark(cursor);
    cursor = undefined;
  };

  const reviewInfo = (): ReviewInfo | undefined => {
    const c = cursor;
    if (c === undefined || !c.ready) return undefined;
    const at = c.replay.position();
    const live = livePosition();
    return { at, t: c.replay.sim.now, live, atLive: comparePositions(at, live) >= 0 };
  };

  /** Run a review advance, turning a replay fault into "history off". */
  const guarded = (fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      if (isFault(e)) fault(e);
      throw e;
    }
  };

  return {
    get budget(): TimeTravelBudget {
      return { ...budget, lagsEvents: [...budget.lagsEvents] };
    },
    get reviewing(): boolean {
      return cursor !== undefined && cursor.ready;
    },
    get seeking(): boolean {
      return inFlight > 0;
    },
    get busy(): boolean {
      return inFlight > 0 || (cursor !== undefined && cursor.ready);
    },
    get reviewSim(): Simulation | undefined {
      return cursor !== undefined && cursor.ready ? cursor.view : undefined;
    },
    setBudget(b) {
      checkBudget(b);
      if (b.replayers !== undefined) budget.replayers = b.replayers;
      if (b.lagsEvents !== undefined) budget.lagsEvents = [...b.lagsEvents];
      if (b.reviewTraceCapacity !== undefined) budget.reviewTraceCapacity = b.reviewTraceCapacity;
      if (b.reviewPduRegistry !== undefined) budget.reviewPduRegistry = b.reviewPduRegistry;
      if (b.laneEntries !== undefined) budget.laneEntries = b.laneEntries;
      applySlots();
    },
    markJournalDirty() {
      stale = true;
    },
    reset() {
      seekSeq++;
      cursor?.unsubscribe();
      cursor = undefined;
      slots = slots.map(() => undefined);
      cached = undefined;
      stale = true;
      faulted = undefined;
    },
    tick() {
      if (faulted !== undefined || slots.length === 0) return;
      const live = livePosition();
      let left = parkChunk;
      const busy = inFlight > 0 || cursor !== undefined;
      /**
       * Move the replayer of slot `i` toward its target with the events left in this tick. A slot whose target is
       * the live event count itself (lag 0) follows the live clock too, so it holds the live position exactly.
       */
      const advanceSlot = (i: number, r: Replay): void => {
        const target = targetOf(i, live);
        const p = r.position();
        if (p.dispatched > target) return;
        const toLive = target === live.dispatched;
        if (p.dispatched === target && (!toLive || p.now >= live.now)) return;
        try {
          extend(r);
          left -= r.advance(toLive ? live : { dispatched: target }, { maxEvents: left }).events;
        } catch (e) {
          if (isFault(e)) fault(e);
          throw e;
        }
      };
      // empty slots first (never while a seek or a review is active): a slot with no replayer is worth more than
      // one a little behind, and the tick's budget decides how many get built
      if (!busy) {
        for (let i = 0; i < slots.length && left > 0; i++) {
          if (slots[i] !== undefined) continue;
          let r: Replay;
          try {
            r = build();
          } catch (e) {
            if (isFault(e)) fault(e);
            throw e;
          }
          slots[i] = r;
          advanceSlot(i, r);
        }
      }
      for (let i = 0; i < slots.length && left > 0; i++) {
        const r = slots[i];
        if (r !== undefined) advanceSlot(i, r);
      }
    },
    seek,
    leave,
    reviewInfo,
    atLive,
    reviewDriver() {
      const c = requireCursor();
      const bound = livePosition();
      const replay = c.replay;
      return {
        get now(): SimTime {
          return replay.sim.now;
        },
        nextEventTime(): SimTime | undefined {
          const p = replay.position();
          if (p.dispatched >= bound.dispatched) return undefined;
          let next = replay.sim.nextEventTime();
          // the next journaled input caps a sub-step too, so the clock re-evaluates right at it
          const e = replay.entries[replay.applied];
          if (e !== undefined && e.at.now <= bound.now && (next === undefined || e.at.now < next)) next = e.at.now;
          return next;
        },
        runUntil(t: SimTime): RunStats {
          const from = replay.sim.now;
          const before = replay.position().dispatched;
          guarded(() => {
            extend(replay);
            replay.advanceTo({ time: Math.max(from, Math.min(Math.round(t), bound.now)) }, { bound });
          });
          const after = replay.position();
          const stats: RunStats = { events: after.dispatched - before, from, to: replay.sim.now };
          // the live position is where review ends: reported as a stop so the clock slice ends there
          if (comparePositions(after, bound) >= 0) stats.stopped = 'breakpoint';
          return stats;
        },
      };
    },
    reviewStep() {
      const c = requireCursor();
      const bound = livePosition();
      guarded(() => {
        extend(c.replay);
        const p = c.replay.position();
        if (p.dispatched < bound.dispatched) c.replay.advance({ dispatched: p.dispatched + 1 });
        else if (comparePositions(p, bound) < 0) c.replay.advance(bound);
      });
    },
    reviewRunUntil(t) {
      const c = requireCursor();
      const bound = livePosition();
      guarded(() => {
        extend(c.replay);
        c.replay.advanceTo({ time: Math.max(c.replay.sim.now, Math.min(Math.round(t), bound.now)) }, { bound });
      });
    },
    reviewRunToLive() {
      const c = requireCursor();
      const bound = livePosition();
      guarded(() => {
        extend(c.replay);
        if (comparePositions(c.replay.position(), bound) < 0) c.replay.advance(bound);
      });
    },
    reviewPdu(id) {
      return cursor !== undefined && cursor.ready ? cursor.replay.sim.pdu(id) : undefined;
    },
    slots() {
      const live = livePosition();
      return slots.map((r, i) => ({ slot: i, lag: lags[i] as number, target: targetOf(i, live), position: r === undefined ? null : r.position() }));
    },
    cursor() {
      const c = cursor;
      return c === undefined ? undefined : { from: c.from, position: c.replay.position(), ready: c.ready };
    },
  };
}
