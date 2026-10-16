/**
 * sim/run-control.ts — the simulation run loop (spec §4.1 discrete-event core; ARCHITECTURE "Run loop";
 * ARCHITECTURE-P1 D10, §3.6 mobility, §4.11 simulation mode, §5.2 timers): the tracked scheduler, `step` /
 * `runUntil` / `runFor` / `runToIdle`, breakpoints (`RunOptions.stopOn`), `stepToNext` with its `until` horizon, and
 * `traceQuery` pages over the trace ring.
 *
 * Idle detection (D10): maintenance timers re-arm forever, so `runToIdle` stops when the only pending events are
 * `timer` events scheduled with `periodic: true`. Every other event counts as live work: frames, boots, faults,
 * one-shot timers, and the P0.5 `mediumTimer` (CSMA deferral, backoff and jam end, RF holds, cellular attach) and
 * `deviceMoved` events, which are never periodic (§5.2). The count is kept by a thin wrapper around
 * core/scheduler.ts, so the scheduler itself stays unchanged.
 *
 * Breakpoints (§4.11 step 2): while a run has a `TraceFilter`, a trace tap runs `matchesTraceFilter` on every event
 * the sink emits during a dispatch and remembers the first match and its ring cursor. The loop checks that flag after
 * each WHOLE dispatch (one scheduler event may emit several matching events; granularity is one scheduler event) and
 * then stops WITHOUT `advanceTo(t)`, so `now` stays at the matching event. Resuming with the same call dispatches
 * exactly the events an uninterrupted run would have dispatched, in the same order: breakpoints observe the trace and
 * never change it. Events emitted outside a dispatch (CLI input between runs) are never matched.
 *
 * `stepToNext(filter, {until, maxEvents})` (§4.11 step 4) is the same loop with the horizon `until` (default: none)
 * and a cap (default `DEFAULT_STEP_MAX_EVENTS`). Without a match the clock moves to `until`, exactly like
 * `runUntil`, so a quiet lab never jumps further than the horizon on one step, and repeated steps still make
 * progress through gaps between events that are longer than the horizon.
 *
 * `traceQuery` pages the facade's ring. The facade never clears its ring, so the oldest retained cursor is
 * `max(startHead, head - capacity)`, where `startHead` (@since P2 [S1], default 0) is the ring's first cursor: a replay
 * facade starts its ring at the live world's trace head so the two worlds' cursors are aligned (ARCHITECTURE-P2 §3.13).
 *
 * P2 (ARCHITECTURE-P2 §2.13; W1 sim): the tracked scheduler also counts `dispatched`, the events popped by `next()`
 * since the scheduler was built. It is the `JournalPosition.dispatched` of the world (a new world, a new count); the
 * input journal records it, and a replay reaches a position exactly with `runUntil(now, {maxEvents})`. Counting never
 * changes which event leaves the heap or when.
 *
 * P3c [S39] (ARCHITECTURE-P3C §3.10, D11): the quiet settle. `runToIdle(maxEvents, {quiet: {windowNs}})` first runs
 * EXACTLY today's `runToIdle` up to the smaller cap `min(maxEvents, LAB_CLONE_IDLE_FIRST_EVENTS)`, so every world that
 * idles inside it dispatches the same events and returns the same stats as without the option. Only a world still busy
 * at that cap switches to the quiet rule: it runs on, and stops with `stopped: 'quiet'` once a window of `windowNs`
 * simulated time passes with no lab-relevant trace event (`QUIET_RELEVANT_KINDS`: configChange, tableWrite, portState,
 * assocState) and no non-periodic event other than frame and link events (`isQuietNeutralEvent`: no one-shot timer,
 * boot, fault, command, configure or move) dispatched in it or due before its end. Such an event that keeps being
 * re-armed and never comes due (P2 item 22c: the root bridge's topology-change timer, restarted by every notice of a
 * wrong EtherChannel answer) therefore does not hold the window open; one due inside the window (an OSPF wait timer, an
 * NTP retry) does, and its dispatch restarts the window. Reaching idle still returns plainly, and `maxEvents` stays the
 * backstop (`stopped: 'maxEvents'`). The tracked scheduler keeps the due times of the pending "other" events for this
 * (`earliestOtherAt`).
 *
 * Determinism: events leave the scheduler strictly by `(at, seq)`; the wrapper's bookkeeping Map is used for
 * membership and lookup only and is never iterated (the [S39] `others` map is read only for its minimum). The run
 * loop draws no randomness and reads no clock.
 */
import type { Scheduler, SimEvent, SimEventBody } from '../contracts/events.js';
import type { RunOptions, RunStats, RunToIdleOptions, TraceFilter, TraceQuery, TraceQueryResult } from '../contracts/simulation.js';
import { assertSimTime, type SimTime } from '../contracts/time.js';
import type { TraceEvent, TraceKind } from '../contracts/trace.js';
import { createScheduler } from '../core/scheduler.js';
import { matchesTraceFilter } from '../trace/filter.js';

/** Default event cap of `stepToNext` when `opts.maxEvents` is omitted (contracts/simulation.ts). */
export const DEFAULT_STEP_MAX_EVENTS = 100_000;

/**
 * @since P3c [S39] The idle-first cap of the quiet settle (file header; ARCHITECTURE-P3C §3.10): `runToIdle` with
 * `opts.quiet` runs today's loop for at most this many events before the quiet rule may stop it. Chosen above every
 * grader settle of the lab worlds of `lab-status.p2` and `lab-status.p3`, which therefore idle inside it with their
 * statuses byte-identical (`accept.p3c.quiet-settle`).
 */
export const LAB_CLONE_IDLE_FIRST_EVENTS = 50_000;

/** @since P3c [S39] The trace kinds that are lab-relevant progress: one of them restarts the quiet window. */
export const QUIET_RELEVANT_KINDS: readonly TraceKind[] = Object.freeze(['configChange', 'tableWrite', 'portState', 'assocState'] as const);

/**
 * @since P3c [S39] True when a pending non-periodic event does NOT hold the quiet window open: frame and link events
 * (`frameArrival`, `txComplete`, `linkState`, the medium's `mediumTimer`). A one-shot timer, a boot, a fault, a command,
 * a configure or a move does.
 */
export function isQuietNeutralEvent(body: SimEventBody): boolean {
  switch (body.kind) {
    case 'frameArrival':
    case 'txComplete':
    case 'linkState':
    case 'mediumTimer':
      return true;
    default:
      return false;
  }
}

/** A scheduler that also counts its live non-periodic events and the events it has handed out. */
export interface TrackedScheduler extends Scheduler {
  /** Pending events that are NOT periodic maintenance timers. */
  readonly nonPeriodic: number;
  /**
   * @since P3c [S39] The due time of the earliest pending non-periodic event that is not a frame or link event
   * (`isQuietNeutralEvent`): a one-shot timer, a boot, a fault, a command, a configure or a move. Undefined when none is
   * pending. Read by the quiet settle only.
   */
  earliestOtherAt(): SimTime | undefined;
  /**
   * @since P2 Events popped by `next()` since this scheduler was built (cancelled events never count). The
   * `JournalPosition.dispatched` of the world that owns it (ARCHITECTURE-P2 §2.13).
   */
  readonly dispatched: number;
}

/** True when `body` is a periodic maintenance timer (D10); every other event body is live work. */
export function isPeriodicEvent(body: SimEventBody): boolean {
  return body.kind === 'timer' && body.periodic === true;
}

/** Wrap `createScheduler()` so the run loop knows when only periodic timers remain. */
export function createTrackedScheduler(): TrackedScheduler {
  const inner = createScheduler();
  /** seq → whether the event is periodic. Membership and lookup only; never iterated. */
  const live = new Map<number, boolean>();
  /**
   * [S39] seq → due time of each pending "other" event (non-periodic, not `isQuietNeutralEvent`). Iterated only by
   * `earliestOtherAt`, whose minimum does not depend on the iteration order.
   */
  const others = new Map<number, SimTime>();
  let nonPeriodic = 0;
  let dispatched = 0;
  const forget = (seq: number): void => {
    const periodic = live.get(seq);
    if (periodic === undefined) return;
    live.delete(seq);
    if (!periodic) {
      nonPeriodic--;
      others.delete(seq);
    }
  };
  return {
    get now(): SimTime {
      return inner.now;
    },
    get size(): number {
      return inner.size;
    },
    get nonPeriodic(): number {
      return nonPeriodic;
    },
    get dispatched(): number {
      return dispatched;
    },
    earliestOtherAt(): SimTime | undefined {
      let min: SimTime | undefined;
      for (const at of others.values()) if (min === undefined || at < min) min = at;
      return min;
    },
    schedule(at: SimTime, body: SimEventBody): number {
      const seq = inner.schedule(at, body);
      const periodic = isPeriodicEvent(body);
      live.set(seq, periodic);
      if (!periodic) {
        nonPeriodic++;
        if (!isQuietNeutralEvent(body)) others.set(seq, at);
      }
      return seq;
    },
    cancel(seq: number): boolean {
      const ok = inner.cancel(seq);
      if (ok) forget(seq);
      return ok;
    },
    next(): SimEvent | undefined {
      const ev = inner.next();
      if (ev !== undefined) {
        forget(ev.seq);
        dispatched++;
      }
      return ev;
    },
    peekTime(): SimTime | undefined {
      return inner.peekTime();
    },
    advanceTo(t: SimTime): void {
      inner.advanceTo(t);
    },
  };
}

/** Read access to the trace ring the run loop pages and taps (the facade's ring; it is never cleared). */
export interface RunLoopTrace {
  /** Cursor of the next event to be emitted (monotonic). */
  readonly head: number;
  /**
   * @since P2 [S1] The ring's first cursor (trace/ring.ts `startHead`); absent = 0. No cursor below it was ever
   * retained, so `traceQuery` never pages below it.
   */
  readonly startHead?: number;
  /** Ring capacity in events (0 = nothing retained). */
  readonly capacity: number;
  /** Retained events with cursor >= `cursor` (trace/ring.ts semantics). */
  since(cursor: number): { events: TraceEvent[]; next: number; dropped: number };
}

/** What the run loop drives: the current world's scheduler, the facade's event dispatcher and its trace. */
export interface RunLoopHost {
  /** The scheduler of the current world (it is replaced by `loadTopology`, so it is read on every call). */
  scheduler(): TrackedScheduler;
  /** Dispatch one popped event to the link model, a device, the CLI or the fault handler. */
  dispatch(ev: SimEvent): void;
  /** The trace ring (cursors and `traceQuery`). */
  readonly trace: RunLoopTrace;
  /**
   * Register a synchronous tap called for every emitted trace event AFTER the ring stored it, so the event's cursor
   * is `trace.head - 1`. Returns the unsubscribe function.
   */
  tap(cb: (ev: TraceEvent) => void): () => void;
}

/** Options of `RunControl.stepToNext` (contracts/simulation.ts `Simulation.stepToNext`). */
export interface StepToNextOptions {
  /** Event cap (default `DEFAULT_STEP_MAX_EVENTS`). */
  maxEvents?: number;
  /** Horizon: events with `at > until` are not dispatched; without a match the clock ends at `until`. */
  until?: SimTime;
}

/**
 * @since P3c [S39] `RunToIdleOptions` plus the idle-first cap, which only tests of the run loop override (the
 * Simulation facade passes the contract options, so its cap is always LAB_CLONE_IDLE_FIRST_EVENTS).
 */
export interface QuietRunToIdleOptions extends RunToIdleOptions {
  readonly idleFirstEvents?: number;
}

/** The run-control surface the Simulation facade exposes. */
export interface RunControl {
  /** Pop and dispatch exactly one event; undefined when the queue is empty. */
  step(): SimEvent | undefined;
  /**
   * Dispatch every event with `at <= t`, then set now = t. `t < now` is a no-op. Throws RangeError for a non-integer
   * `t`. With `opts.stopOn` the run stops after the whole dispatch of the first event that emitted a matching trace
   * event (`stopped: 'breakpoint'`, `stopEvent`, `stopCursor`, `now` at that event); with `opts.maxEvents` it stops
   * before a dispatch beyond that many (`stopped: 'maxEvents'`, `now` at the last dispatched event).
   */
  runUntil(t: SimTime, opts?: RunOptions): RunStats;
  /** `runUntil(now + dt, opts)`; `dt` must be an integer >= 0. */
  runFor(dt: SimTime, opts?: RunOptions): RunStats;
  /**
   * Dispatch until only periodic timers remain, the queue is empty, or `maxEvents` events were dispatched. With
   * `opts.quiet` (P3c [S39]): the quiet settle of the file header, after at most `opts.idleFirstEvents` (default
   * LAB_CLONE_IDLE_FIRST_EVENTS) events of today's loop.
   */
  runToIdle(maxEvents: number, opts?: QuietRunToIdleOptions): RunStats;
  /** Time of the next pending event. */
  nextEventTime(): SimTime | undefined;
  /**
   * `step()` until a dispatch emits a trace event matching `filter` (`stopped: 'breakpoint'`, `now` at that event),
   * `maxEvents` dispatches were made (`stopped: 'maxEvents'`), or no event with `at <= until` is pending (the clock
   * then moves to `until` when one is given; without `until` it stays at the last dispatched event).
   * `until < now` is a no-op.
   */
  stepToNext(filter: TraceFilter, opts?: StepToNextOptions): RunStats;
  /**
   * Page the trace ring with a filter. `from` is inclusive and clamped to the retained window. `forward` (default)
   * returns matches in ascending cursor order and `next` is the cursor after the last one examined (`head` once the
   * window is exhausted); `backward` returns matches in descending cursor order and `next` is the cursor before the
   * last one examined (`oldest - 1` once the window is exhausted). Throws RangeError for a non-integer `from` or a
   * negative or non-integer `limit`.
   */
  traceQuery(q: TraceQuery): TraceQueryResult;
}

/** The bounded, filtered loop behind `runUntil` and `stepToNext`. */
interface LoopSpec {
  /** Last dispatchable time; undefined = unbounded. */
  until: SimTime | undefined;
  /** Breakpoint filter; undefined = no breakpoint. */
  filter: TraceFilter | undefined;
  /** Dispatch cap; undefined = no cap. */
  maxEvents: number | undefined;
}

/** Throw a RangeError unless `n` is undefined or a non-negative integer. */
function checkMaxEvents(n: number | undefined, what: string): void {
  if (n !== undefined && (!Number.isInteger(n) || n < 0)) {
    throw new RangeError(`${what} must be a non-negative integer, got ${n}`);
  }
}

/** Build the run loop over `host`. */
export function createRunControl(host: RunLoopHost): RunControl {
  const step = (): SimEvent | undefined => {
    const ev = host.scheduler().next();
    if (ev === undefined) return undefined;
    host.dispatch(ev);
    return ev;
  };

  const loop = (spec: LoopSpec): RunStats => {
    const from = host.scheduler().now;
    const filter = spec.filter;
    let events = 0;
    let armed = false;
    let match: { event: TraceEvent; cursor: number } | undefined;
    const untap =
      filter === undefined
        ? undefined
        : host.tap((ev) => {
            if (!armed || match !== undefined) return;
            if (matchesTraceFilter(filter, ev)) match = { event: ev, cursor: host.trace.head - 1 };
          });
    try {
      for (;;) {
        const next = host.scheduler().peekTime();
        if (next === undefined || (spec.until !== undefined && next > spec.until)) break;
        if (spec.maxEvents !== undefined && events >= spec.maxEvents) {
          return { events, from, to: host.scheduler().now, stopped: 'maxEvents' };
        }
        armed = true;
        try {
          step();
        } finally {
          armed = false;
        }
        events++;
        if (match !== undefined) {
          return {
            events,
            from,
            to: host.scheduler().now,
            stopped: 'breakpoint',
            stopEvent: match.event,
            stopCursor: match.cursor,
          };
        }
      }
    } finally {
      if (untap !== undefined) untap();
    }
    if (spec.until !== undefined) host.scheduler().advanceTo(spec.until);
    return { events, from, to: host.scheduler().now };
  };

  const runUntil = (t: SimTime, opts?: RunOptions): RunStats => {
    assertSimTime(t, 'runUntil(t)');
    checkMaxEvents(opts?.maxEvents, 'runUntil maxEvents');
    const from = host.scheduler().now;
    if (t < from) return { events: 0, from, to: from };
    return loop({ until: t, filter: opts?.stopOn, maxEvents: opts?.maxEvents });
  };

  /** Today's `runToIdle` loop. */
  const idleLoop = (maxEvents: number): RunStats => {
    const from = host.scheduler().now;
    let events = 0;
    while (events < maxEvents && host.scheduler().nonPeriodic > 0) {
      if (step() === undefined) break;
      events++;
    }
    // P3 (ruling R40, R31's engine half): the cap stopped the run only when non-periodic work is still pending after
    // `maxEvents` dispatches; a run that reached idle on exactly its last allowed event is not capped. Not traced.
    if (events >= maxEvents && host.scheduler().nonPeriodic > 0) return { events, from, to: host.scheduler().now, stopped: 'maxEvents' };
    return { events, from, to: host.scheduler().now };
  };

  /**
   * [S39] Phase 2 of the quiet settle (file header): continue `first` (capped, still busy) until idle, the cap, or a
   * quiet window. The window restarts at every dispatch that emitted a lab-relevant trace event and at every dispatch of
   * an "other" event (non-periodic, not a frame or link event: a one-shot timer fired, a boot, a fault, …). It has
   * passed once the next pending event, and the earliest pending "other" event, both lie more than `windowNs` after its
   * start. Checked before each dispatch, so the clock never moves past the last dispatched event.
   */
  const quietLoop = (first: RunStats, maxEvents: number, windowNs: SimTime): RunStats => {
    let events = first.events;
    let relevant = false;
    const untap = host.tap((ev) => {
      if (!relevant && QUIET_RELEVANT_KINDS.includes(ev.kind)) relevant = true;
    });
    try {
      let quietSince = host.scheduler().now;
      for (;;) {
        const sched = host.scheduler();
        if (sched.nonPeriodic === 0) return { events, from: first.from, to: sched.now };
        if (events >= maxEvents) return { events, from: first.from, to: sched.now, stopped: 'maxEvents' };
        const next = sched.peekTime();
        if (next === undefined) return { events, from: first.from, to: sched.now };
        if (next - quietSince > windowNs) {
          const other = sched.earliestOtherAt();
          if (other === undefined || other - quietSince > windowNs) return { events, from: first.from, to: sched.now, stopped: 'quiet' };
        }
        relevant = false;
        const ev = step();
        if (ev === undefined) return { events, from: first.from, to: sched.now };
        events++;
        if (relevant || (!isPeriodicEvent(ev) && !isQuietNeutralEvent(ev))) quietSince = host.scheduler().now;
      }
    } finally {
      untap();
    }
  };

  const traceQuery = (q: TraceQuery): TraceQueryResult => {
    if (!Number.isInteger(q.from)) throw new RangeError(`traceQuery from must be an integer cursor, got ${q.from}`);
    if (!Number.isInteger(q.limit) || q.limit < 0) {
      throw new RangeError(`traceQuery limit must be a non-negative integer, got ${q.limit}`);
    }
    const ring = host.trace;
    const head = ring.head;
    const oldest = Math.max(ring.startHead ?? 0, head - ring.capacity);
    const filter = q.filter;
    const out: { cursor: number; event: TraceEvent }[] = [];
    if (q.direction === 'backward') {
      const start = Math.min(q.from, head - 1);
      if (start < oldest || q.limit === 0) return { events: out, next: start < oldest ? oldest - 1 : start, oldest, head };
      const window = ring.since(oldest).events;
      let c = start;
      for (; c >= oldest && out.length < q.limit; c--) {
        const event = window[c - oldest]!;
        if (filter === undefined || matchesTraceFilter(filter, event)) out.push({ cursor: c, event });
      }
      return { events: out, next: c, oldest, head };
    }
    const start = Math.max(q.from, oldest);
    if (start >= head || q.limit === 0) return { events: out, next: Math.min(start, head), oldest, head };
    const window = ring.since(start).events;
    let c = start;
    for (; c < head && out.length < q.limit; c++) {
      const event = window[c - start]!;
      if (filter === undefined || matchesTraceFilter(filter, event)) out.push({ cursor: c, event });
    }
    return { events: out, next: c, oldest, head };
  };

  return {
    step,
    runUntil,
    runFor(dt: SimTime, opts?: RunOptions): RunStats {
      assertSimTime(dt, 'runFor(dt)');
      return runUntil(host.scheduler().now + dt, opts);
    },
    runToIdle(maxEvents: number, opts?: QuietRunToIdleOptions): RunStats {
      const quiet = opts?.quiet;
      if (quiet === undefined) return idleLoop(maxEvents);
      assertSimTime(quiet.windowNs, 'runToIdle quiet.windowNs');
      const firstCap = opts?.idleFirstEvents ?? LAB_CLONE_IDLE_FIRST_EVENTS;
      checkMaxEvents(firstCap, 'runToIdle idleFirstEvents');
      // phase 1: exactly today's loop, up to the smaller cap; a world that idles inside it returns today's stats
      const first = idleLoop(Math.min(maxEvents, firstCap));
      if (first.stopped === undefined || first.events >= maxEvents) return first;
      return quietLoop(first, maxEvents, quiet.windowNs);
    },
    nextEventTime: () => host.scheduler().peekTime(),
    stepToNext(filter: TraceFilter, opts?: StepToNextOptions): RunStats {
      const until = opts?.until;
      if (until !== undefined) assertSimTime(until, 'stepToNext until');
      const maxEvents = opts?.maxEvents ?? DEFAULT_STEP_MAX_EVENTS;
      checkMaxEvents(maxEvents, 'stepToNext maxEvents');
      const from = host.scheduler().now;
      if (until !== undefined && until < from) return { events: 0, from, to: from };
      return loop({ until, filter, maxEvents });
    },
    traceQuery,
  };
}
