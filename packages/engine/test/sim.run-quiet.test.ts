/**
 * P3c W1a sim [S39] — the quiet settle of `runToIdle` (ARCHITECTURE-P3C §2.8, §3.10, D11; sim/run-control.ts).
 *
 * The rule on a scripted run loop (a real tracked scheduler and run control over a fake host whose dispatch is the
 * test's script): phase 1 is exactly today's `runToIdle` up to the idle-first cap; a world still busy then stops
 * `'quiet'` once a window passes with no lab-relevant trace event and no "other" non-periodic event (one-shot timer,
 * boot, fault, …) dispatched in it or due before its end; a relevant event or a fired one-shot timer restarts the
 * window; a one-shot timer that keeps being re-armed and never comes due does not hold it (P2 item 22c); idle and the
 * cap keep their meaning. On the real Simulation: absent options are today exactly, and a world that idles inside the
 * first cap gives byte-identical trace and stats with the option. Counts follow from the constants, never typed.
 */
import { describe, expect, it } from 'vitest';
import type { SimEvent, SimEventBody } from '../src/contracts/events.js';
import type { RunStats } from '../src/contracts/simulation.js';
import { SEC, type SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { LAB_CLONE_SETTLE, QUIET_WINDOW_MS } from '../src/sim/lab-checks.js';
import {
  LAB_CLONE_IDLE_FIRST_EVENTS,
  QUIET_RELEVANT_KINDS,
  createRunControl,
  createTrackedScheduler,
  isQuietNeutralEvent,
  type RunControl,
  type TrackedScheduler,
} from '../src/sim/run-control.js';
import { twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';
import { booted } from './sim.harness.js';

/** The window of the scripted cases. */
const WINDOW: SimTime = 60 * SEC;
/** The idle-first cap of the scripted cases. */
const FIRST = 100;
/** A frame that re-arms itself every second, forever (a never-idle world with only neutral work). */
const FRAME_EVERY: SimTime = SEC;

const frame = (): SimEventBody => ({ kind: 'txComplete', device: 'd1', port: 'p1' });
const timer = (key: string): SimEventBody => ({ kind: 'timer', device: 'd1', process: 'p', key });

interface Script {
  sched: TrackedScheduler;
  run: RunControl;
  emit(ev: TraceEvent): void;
  /** Dispatched events in order. */
  log: SimEvent[];
}

/** A run loop over a fake host whose dispatch is `onEvent`. */
function scripted(onEvent: (ev: SimEvent, s: Script) => void): Script {
  const sched = createTrackedScheduler();
  const taps = new Set<(ev: TraceEvent) => void>();
  let head = 0;
  const s = {} as Script;
  s.sched = sched;
  s.log = [];
  s.emit = (ev) => {
    head++;
    for (const t of taps) t(ev);
  };
  s.run = createRunControl({
    scheduler: () => sched,
    dispatch: (ev) => {
      s.log.push(ev);
      onEvent(ev, s);
    },
    trace: {
      get head() {
        return head;
      },
      capacity: 0,
      since: () => ({ events: [], next: head, dropped: 0 }),
    },
    tap: (cb) => {
      taps.add(cb);
      return () => taps.delete(cb);
    },
  });
  return s;
}

/** A world whose frame re-arms itself every FRAME_EVERY; `extra` adds behaviour per dispatched event. */
function busyWorld(extra?: (ev: SimEvent, s: Script) => void): Script {
  const s = scripted((ev, sc) => {
    if (ev.kind === 'txComplete') sc.sched.schedule(ev.at + FRAME_EVERY, frame());
    extra?.(ev, sc);
  });
  s.sched.schedule(FRAME_EVERY, frame());
  return s;
}

const quiet = { quiet: { windowNs: WINDOW }, idleFirstEvents: FIRST } as const;
/** Frames dispatched in a window that starts at a frame and ends before the frame after `WINDOW`. */
const FRAMES_PER_WINDOW = WINDOW / FRAME_EVERY;

describe('sim/run-control [S39]: the quiet rule', () => {
  it('exports the contract constants', () => {
    expect(QUIET_RELEVANT_KINDS).toEqual(['configChange', 'tableWrite', 'portState', 'assocState']);
    expect(LAB_CLONE_SETTLE).toEqual({ quiet: { windowNs: QUIET_WINDOW_MS * 1_000_000 } });
    expect(LAB_CLONE_IDLE_FIRST_EVENTS).toBeGreaterThan(0);
    for (const k of ['frameArrival', 'txComplete', 'linkState', 'mediumTimer'] as const) {
      expect(isQuietNeutralEvent({ kind: k } as SimEventBody)).toBe(true);
    }
    for (const b of [timer('x'), { kind: 'boot', device: 'd1' }, { kind: 'deviceMoved', device: 'd1' }] as SimEventBody[]) {
      expect(isQuietNeutralEvent(b)).toBe(false);
    }
  });

  it('a busy world with only frames stops quiet one window after the first cap', () => {
    const plain = busyWorld().run.runToIdle(10 * FIRST);
    expect(plain.stopped).toBe('maxEvents');
    const s = busyWorld();
    const r = s.run.runToIdle(10 * FIRST, quiet);
    const t0 = FIRST * FRAME_EVERY; // the first phase ends at the FIRST-th frame
    expect(r).toEqual({ events: FIRST + FRAMES_PER_WINDOW, from: 0, to: t0 + WINDOW, stopped: 'quiet' });
    expect(s.sched.now).toBe(t0 + WINDOW);
  });

  it('a lab-relevant trace event restarts the window; other trace kinds do not', () => {
    const t0 = FIRST * FRAME_EVERY;
    const at = t0 + 30 * SEC;
    const s = busyWorld((ev, sc) => {
      if (ev.at === t0 + 10 * SEC) sc.emit({ t: ev.at, kind: 'log', device: 'd1', severity: 5, facility: 'X', message: 'not relevant' } as TraceEvent);
      if (ev.at === at) sc.emit({ t: at, kind: 'tableWrite', device: 'd1', table: 'cam', key: 'k', row: {} } as TraceEvent);
    });
    const r = s.run.runToIdle(10 * FIRST, quiet);
    expect(r).toEqual({ events: FIRST + (at - t0) / FRAME_EVERY + FRAMES_PER_WINDOW, from: 0, to: at + WINDOW, stopped: 'quiet' });
  });

  it('a one-shot timer due inside the window holds it, and its dispatch restarts it', () => {
    const t0 = FIRST * FRAME_EVERY;
    const due = t0 + 50 * SEC + SEC / 2;
    const s = busyWorld((ev, sc) => {
      if (ev.kind === 'txComplete' && ev.at === t0) sc.sched.schedule(due, timer('wait'));
    });
    const r = s.run.runToIdle(10 * FIRST, quiet);
    // frames up to due + WINDOW (inclusive of the last whole second before it), plus the timer
    const frames = Math.floor((due + WINDOW) / FRAME_EVERY) - FIRST;
    expect(r.stopped).toBe('quiet');
    expect(r.events).toBe(FIRST + frames + 1);
    expect(s.log.some((e) => e.kind === 'timer' && e.key === 'wait')).toBe(true);
    expect(r.to).toBe(Math.floor((due + WINDOW) / FRAME_EVERY) * FRAME_EVERY);
  });

  it('a one-shot timer re-armed by every frame (never due) does not hold the window (P2 item 22c)', () => {
    const rearmWorld = (): Script => {
      let seq: number | undefined;
      return busyWorld((ev, sc) => {
        if (ev.kind !== 'txComplete') return;
        if (seq !== undefined) sc.sched.cancel(seq);
        seq = sc.sched.schedule(ev.at + 35 * SEC, timer('tc'));
      });
    };
    const plain = rearmWorld().run.runToIdle(10 * FIRST);
    const s = rearmWorld();
    expect(plain.stopped).toBe('maxEvents');
    const r = s.run.runToIdle(10 * FIRST, quiet);
    expect(r).toEqual({ events: FIRST + FRAMES_PER_WINDOW, from: 0, to: FIRST * FRAME_EVERY + WINDOW, stopped: 'quiet' });
    expect(s.log.some((e) => e.kind === 'timer')).toBe(false);
  });

  it('the cap stays the backstop, and idle in the second phase returns plainly', () => {
    const capped = busyWorld().run.runToIdle(FIRST + 10, quiet);
    expect(capped).toEqual({ events: FIRST + 10, from: 0, to: (FIRST + 10) * FRAME_EVERY, stopped: 'maxEvents' });
    // frames stop after FIRST + 5: the world idles in phase 2
    const s = scripted((ev, sc) => {
      if (ev.kind === 'txComplete' && sc.log.length < FIRST + 5) sc.sched.schedule(ev.at + FRAME_EVERY, frame());
    });
    s.sched.schedule(FRAME_EVERY, frame());
    expect(s.run.runToIdle(10 * FIRST, quiet)).toEqual({ events: FIRST + 5, from: 0, to: (FIRST + 5) * FRAME_EVERY });
  });

  it('a cap at or below the idle-first cap is today exactly', () => {
    const a: RunStats = busyWorld().run.runToIdle(FIRST);
    const b: RunStats = busyWorld().run.runToIdle(FIRST, quiet);
    expect(b).toEqual(a);
    expect(a.stopped).toBe('maxEvents');
  });

  it('refuses a window that is not a whole number of ns, and a bad idle-first cap', () => {
    expect(() => busyWorld().run.runToIdle(10, { quiet: { windowNs: 1.5 } })).toThrow(RangeError);
    expect(() => busyWorld().run.runToIdle(10, { quiet: { windowNs: WINDOW }, idleFirstEvents: -1 })).toThrow(RangeError);
  });
});

describe('Simulation.runToIdle [S39]: worlds that idle are untouched', () => {
  it('a booted lab world settles byte-identically with and without the grader options', () => {
    const run = (withQuiet: boolean): { stats: RunStats; trace: string; now: SimTime } => {
      const sim = booted(twoPcsAndSwitch(), 7);
      const session = sim.cli.open('pc1', 'console');
      sim.cli.exec(session, 'ping 10.0.0.2');
      const stats = withQuiet ? sim.runToIdle(200_000, LAB_CLONE_SETTLE) : sim.runToIdle(200_000);
      return { stats, trace: JSON.stringify(sim.trace(0).events), now: sim.now };
    };
    const plain = run(false);
    const settled = run(true);
    expect(plain.stats.stopped).toBeUndefined();
    expect(plain.stats.events).toBeLessThan(LAB_CLONE_IDLE_FIRST_EVENTS);
    expect(settled).toEqual(plain);
  });

  it('an absent or quiet-less options object is today exactly', () => {
    const a = createSimulation({ seed: 3 });
    a.loadTopology(twoPcsAndSwitch());
    const b = createSimulation({ seed: 3 });
    b.loadTopology(twoPcsAndSwitch());
    expect(b.runToIdle(1_000, {})).toEqual(a.runToIdle(1_000));
    expect(JSON.stringify(b.trace(0).events)).toBe(JSON.stringify(a.trace(0).events));
  });
});
