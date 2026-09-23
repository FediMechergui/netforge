/**
 * The worker time machine [SHOULD S1] (ARCHITECTURE-P2 D18, §2.13, §2.14, §3.13, §10.2; W4 web-shell).
 *
 * Three layers, each on its own:
 *   - the lane index (bridge/worker/lanes.ts): every event lands in its `laneOf` lane, background drops are left out,
 *     buckets and marks answer over both tiers, and a full fine tier folds into coarse cells without losing a count;
 *   - the time machine (bridge/worker/time-machine.ts) over a real live world: the §3.13 lifecycle — the slot and
 *     position of every replayer after a park, a seek, a leave and a re-seek — the exact seek cost of step 6, the
 *     origin fallback, "history off", cooperative seeks a newer seek supersedes, the review drivers, a replay fault,
 *     and observation purity (the live world is never perturbed; a twin that never reviewed ends byte-identical);
 *   - the worker API (bridge/worker/index.ts), Comlink mocked and the interval faked as in worker.delta.test.ts
 *     (setTimeout stays real: seek chunks yield through it): review batches, the read-only rule, leaving review,
 *     playing and stepping through the past into the present, the timeline queries and the budget.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LANE_IDS, REPLAY_READ_ONLY_MESSAGE, ReplayDivergenceError, createReplay, createSimulation, twoPcsAndSwitch } from '@netforge/engine';
import type { JournalPosition, SeekTarget, SimJournal, SimTime, Simulation, TraceEvent } from '@netforge/engine';
import type { EngineApi, EngineBatch } from '../src/bridge/protocol';
import { COARSE_CELL_NS, createLaneIndex } from '../src/bridge/worker/lanes';
import { SeekSupersededError, createTimeMachine, type TimeMachine } from '../src/bridge/worker/time-machine';
import { store } from '../src/store/store';

const SEC = 1_000_000_000;
const MS = 1_000_000;

// ── fixtures ────────────────────────────────────────────────────────────────

let pduSeq = 1;
const linkUp = (t: number): TraceEvent => ({ t, kind: 'linkState', link: 'l1', up: true }) as TraceEvent;
const portUp = (t: number): TraceEvent => ({ t, kind: 'portState', device: 'sw1', port: 'Fa0/1', adminUp: true, operUp: true }) as TraceEvent;
const ribWrite = (t: number): TraceEvent => ({ t, kind: 'tableWrite', device: 'r1', table: 'rib', key: '10.0.0.0/24', row: {} }) as TraceEvent;
const arpWrite = (t: number): TraceEvent => ({ t, kind: 'tableWrite', device: 'r1', table: 'arp', key: '10.0.0.1', row: {} }) as TraceEvent;
const configLine = (t: number): TraceEvent => ({ t, kind: 'configChange', device: 'sw1', line: 'hostname X', negate: false, context: [] }) as TraceEvent;
const dropEv = (t: number, background: boolean): TraceEvent =>
  ({ t, kind: 'drop', pdu: { id: pduSeq++, kind: 'frame', summary: 'x', proto: 'stp' }, device: 'pc1', reason: 'other', ...(background ? { background: true } : {}) }) as TraceEvent;
const stpTransition = (t: number): TraceEvent =>
  ({ t, kind: 'debug', event: { at: t, device: 'sw1', process: 'stp', category: 'spanning-tree', message: 'm', fsm: { machine: 'stp-port', subject: 'Fa0/1', from: 'listening', to: 'learning' } } }) as TraceEvent;
const frame = (t: number): TraceEvent =>
  ({ t, kind: 'frameTx', pdu: { id: pduSeq++ }, link: 'l1', from: { device: 'a', port: 'p' }, to: { device: 'b', port: 'p' }, txStart: t, txEnd: t + 4, arrive: t + 9 }) as TraceEvent;

/** The seeded live script: a loaded document, a boot, a console ping, a configuration change, a fault, more traffic. */
function liveWorld(seed: number): { sim: Simulation; marks: { t: SimTime; position: JournalPosition; snapshot: string }[] } {
  const sim = createSimulation({ seed });
  const marks: { t: SimTime; position: JournalPosition; snapshot: string }[] = [];
  const mark = (): void => marks.push({ t: sim.now, position: sim.position(), snapshot: JSON.stringify(sim.snapshot()) });
  sim.loadTopology(twoPcsAndSwitch());
  sim.runFor(40 * SEC);
  const s = sim.cli.open('pc1', 'console');
  sim.cli.exec(s, 'ping 10.0.0.2');
  mark(); // the state at 40 s with every input at 40 s applied
  sim.runFor(3 * SEC);
  sim.configure('sw1', ['hostname Core']);
  sim.injectFault(sim.now + SEC, { id: 'cut', kind: 'cable-cut', target: { link: 'l_pc2_sw1' }, params: { durationNs: 2 * SEC } });
  mark(); // 43 s, after the inputs journaled at that position (a replay to it holds them too)
  sim.runFor(5 * SEC);
  sim.cli.exec(s, 'ping 10.0.0.2');
  mark(); // 48 s, the second ping just entered
  sim.runFor(4 * SEC);
  sim.runToIdle();
  mark();
  return { sim, marks };
}

/** Everything a read must leave alone. */
function fingerprint(sim: Simulation): { journal: string; position: JournalPosition; head: number; snapshot: string; trace: string } {
  return {
    journal: JSON.stringify(sim.journal()),
    position: sim.position(),
    head: sim.traceQuery({ from: 0, limit: 0 }).head,
    snapshot: JSON.stringify(sim.snapshot()),
    trace: JSON.stringify(sim.trace(0).events),
  };
}

/** A fresh replay of the live journal advanced to `target` (the reference of every seek). */
function freshReplayAt(sim: Simulation, target: { time: SimTime } | { cursor: number } | { position: JournalPosition }): Simulation {
  const replay = createReplay(sim.journal());
  const r = replay.advanceTo(target, { bound: sim.position() });
  if (!r.reached && !('cursor' in target)) throw new Error('the reference replay did not reach the target');
  return replay.sim;
}

const snapOf = (sim: Simulation): string => JSON.stringify(sim.snapshot());

/** Park every slot: enough ticks for the replayers to reach their targets. */
function parkAll(tm: TimeMachine, ticks = 200): void {
  for (let i = 0; i < ticks; i++) {
    tm.tick();
    if (tm.slots().every((s) => s.position !== null && s.position.dispatched >= s.target)) return;
  }
  throw new Error('the replayers did not reach their targets');
}

// ── the lane index ───────────────────────────────────────────────────────────

describe('the lane index (bridge/worker/lanes.ts)', () => {
  it('puts every event in its laneOf lane and skips events in no lane and background drops', () => {
    const index = createLaneIndex(100);
    const events: [TraceEvent, number][] = [
      [linkUp(1 * SEC), 10],
      [portUp(1 * SEC), 11],
      [arpWrite(1 * SEC + 5), 12], // no lane
      [ribWrite(2 * SEC), 13],
      [frame(2 * SEC + 1), 14], // no lane
      [configLine(3 * SEC), 15],
      [dropEv(3 * SEC + 1, true), 16], // background: left out
      [dropEv(4 * SEC), 17],
      [stpTransition(5 * SEC), 18],
    ];
    for (const [ev, cursor] of events) index.observe(ev, cursor);
    expect(index.size).toBe(6);
    expect(index.revision).toBe(6);
    expect(index.total).toBe(6);
    const buckets = index.buckets({ from: 0, to: 5 * SEC, buckets: 5 });
    expect(buckets).toHaveLength(5);
    expect(buckets.map((b) => [b.from, b.to])).toEqual([
      [0, SEC],
      [SEC, 2 * SEC],
      [2 * SEC, 3 * SEC],
      [3 * SEC, 4 * SEC],
      [4 * SEC, 5 * SEC],
    ]);
    expect(buckets[1]?.counts).toEqual({ link: 2 });
    expect(buckets[1]?.firstCursor).toEqual({ link: 10 });
    expect(buckets[2]?.counts).toEqual({ routing: 1 });
    expect(buckets[3]?.counts).toEqual({ config: 1 });
    // the last bucket is closed at `to`: the drop at 4 s and the transition at exactly 5 s are both in it
    expect(buckets[4]?.counts).toEqual({ drops: 1, stp: 1 });
    expect(buckets[4]?.firstCursor).toEqual({ drops: 17, stp: 18 });
    expect(buckets[0]?.counts).toEqual({});
  });

  it('limits buckets to the lanes asked for, and marks to one lane in time order', () => {
    const index = createLaneIndex(100);
    index.observe(linkUp(1 * SEC), 1);
    index.observe(ribWrite(1 * SEC), 2);
    index.observe(linkUp(2 * SEC), 3);
    index.observe(linkUp(9 * SEC), 4);
    const only = index.buckets({ from: 0, to: 10 * SEC, buckets: 1, lanes: ['routing'] });
    expect(only[0]?.counts).toEqual({ routing: 1 });
    expect(index.marks({ lane: 'link', from: 0, to: 5 * SEC, limit: 10 })).toEqual([
      { cursor: 1, t: SEC, lane: 'link' },
      { cursor: 3, t: 2 * SEC, lane: 'link' },
    ]);
    expect(index.marks({ lane: 'link', from: 0, to: 10 * SEC, limit: 1 })).toEqual([{ cursor: 1, t: SEC, lane: 'link' }]);
    expect(index.marks({ lane: 'link', from: 3 * SEC, to: 8 * SEC, limit: 10 })).toEqual([]);
    expect(index.marks({ lane: 'nat', from: 0, to: 10 * SEC, limit: 10 })).toEqual([]);
  });

  it('folds the oldest half into coarse cells when full, without losing a count or a first cursor', () => {
    const index = createLaneIndex(4);
    for (let i = 0; i < 10; i++) index.observe(linkUp(i * SEC), 100 + i);
    expect(index.size).toBeLessThanOrEqual(4);
    expect(index.coarseCells).toBeGreaterThan(0);
    expect(index.total).toBe(10);
    expect(index.revision).toBe(10);
    const whole = index.buckets({ from: 0, to: 10 * SEC, buckets: 1 });
    expect(whole[0]?.counts).toEqual({ link: 10 });
    expect(whole[0]?.firstCursor).toEqual({ link: 100 });
    // per-second buckets: each second holds one event, coarse or fine
    const perSecond = index.buckets({ from: 0, to: 10 * SEC, buckets: 10 });
    expect(perSecond.map((b) => b.counts.link ?? 0)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    // marks only come from the fine tier (the newest)
    const marks = index.marks({ lane: 'link', from: 0, to: 10 * SEC, limit: 100 });
    expect(marks.length).toBe(index.size);
    expect(marks[marks.length - 1]?.cursor).toBe(109);
    expect(COARSE_CELL_NS).toBe(SEC);
  });

  it('changes capacity in place and validates its queries', () => {
    const index = createLaneIndex(8);
    for (let i = 0; i < 8; i++) index.observe(ribWrite(i * MS), i);
    index.setCapacity(3);
    expect(index.size).toBeLessThanOrEqual(3);
    expect(index.total).toBe(8);
    index.setCapacity(50);
    for (let i = 8; i < 20; i++) index.observe(ribWrite(i * MS), i);
    expect(index.total).toBe(20);
    expect(index.buckets({ from: 0, to: 20 * MS, buckets: 1 })[0]?.counts).toEqual({ routing: 20 });
    expect(() => index.buckets({ from: 5, to: 4, buckets: 1 })).toThrow(RangeError);
    expect(() => index.buckets({ from: 0, to: 4, buckets: 0 })).toThrow(RangeError);
    expect(() => index.marks({ lane: 'nope' as never, from: 0, to: 4, limit: 1 })).toThrow(RangeError);
    expect(() => index.marks({ lane: 'link', from: 0, to: 4, limit: -1 })).toThrow(RangeError);
    expect(() => createLaneIndex(0)).toThrow(RangeError);
    index.reset();
    expect(index.total).toBe(0);
    expect(index.revision).toBe(0);
    expect(index.coarseCells).toBe(0);
  });

  it('knows every lane of the engine', () => {
    const index = createLaneIndex(100);
    for (const lane of LANE_IDS) expect(index.marks({ lane, from: 0, to: 1, limit: 1 })).toEqual([]);
  });

  it('counts every event in the bucket whose reported [from, to) holds it, also on an edge that is not a whole ns', () => {
    const index = createLaneIndex(100);
    index.observe(linkUp(3), 7);
    const three = index.buckets({ from: 0, to: 10, buckets: 3 });
    expect(three.map((b) => [b.from, b.to])).toEqual([
      [0, 3],
      [3, 6],
      [6, 10],
    ]);
    expect(three.map((b) => b.counts)).toEqual([{}, { link: 1 }, {}]);
    expect(three[1]?.firstCursor).toEqual({ link: 7 });
    // a strip sized in pixels (60 s over 700 cells: most edges fall between two whole ns), events on and beside edges
    const q = { from: 0, to: 60 * SEC, buckets: 700 };
    const times = new Set<number>([q.from, q.to]);
    for (let b = 1; b < q.buckets; b += 23) {
      const e = Math.floor((b * (q.to - q.from)) / q.buckets);
      for (const t of [e - 1, e, e + 1]) times.add(t);
    }
    for (const t of times) {
      const one = createLaneIndex(4);
      one.observe(linkUp(t), 1);
      const cells = one.buckets(q);
      const at = cells.findIndex((c) => (c.counts.link ?? 0) > 0);
      expect(at, `t=${t}`).toBeGreaterThanOrEqual(0);
      const cell = cells[at] as (typeof cells)[number];
      expect(cell.from, `t=${t}`).toBeLessThanOrEqual(t);
      expect(t < cell.to || at === q.buckets - 1, `t=${t} counted in [${cell.from}, ${cell.to})`).toBe(true);
      expect(cells.reduce((n, c) => n + (c.counts.link ?? 0), 0)).toBe(1);
    }
  });
});

// ── the time machine over a real world ───────────────────────────────────────

describe('the time machine (bridge/worker/time-machine.ts): the §3.13 lifecycle', () => {
  const { sim: live, marks } = liveWorld(31);
  const D = live.position().dispatched;
  /** Lags that spread the three parked replayers over the run. */
  const lags = [Math.floor(D / 5), Math.floor(D / 2), Math.floor((4 * D) / 5)];
  const before = fingerprint(live);

  function machine(extra: Partial<Parameters<typeof createTimeMachine>[1]> = {}): TimeMachine {
    return createTimeMachine({ sim: () => live }, { budget: { replayers: 3, lagsEvents: lags }, parkChunk: 10_000, ...extra });
  }

  it('the script is long enough for three distinct parked positions', () => {
    expect(D).toBeGreaterThan(50);
    expect(lags[0]).toBeGreaterThan(0);
    expect(new Set(lags).size).toBe(3);
    expect(marks).toHaveLength(4);
  });

  it('parks each replayer at head − lag, idles it there and follows the head as the live run grows', () => {
    const tm = machine({ parkChunk: 17 });
    expect(tm.slots().map((s) => s.position)).toEqual([null, null, null]);
    parkAll(tm, 10_000);
    const parked = tm.slots();
    for (const s of parked) {
      expect(s.target).toBe(D - s.lag);
      expect(s.position?.dispatched).toBe(s.target);
    }
    // idle: more ticks move nothing
    tm.tick();
    tm.tick();
    expect(tm.slots()).toEqual(parked);
    expect(fingerprint(live)).toEqual(before);
    // a replayer ahead of its target idles until the target passes it: park a machine whose lags shrink
    tm.setBudget({ lagsEvents: [0, lags[1] as number, lags[2] as number] });
    parkAll(tm, 10_000);
    expect(tm.slots()[0]?.position?.dispatched).toBe(D);
    expect(tm.slots()[0]?.position).toEqual(live.position());
  });

  it('a seek takes the parked replayer with the largest position at or before the target; leaving re-parks it in its slot', async () => {
    const tm = machine();
    parkAll(tm);
    const [p0, p1] = [tm.slots()[0]?.position as JournalPosition, tm.slots()[1]?.position as JournalPosition];
    expect(p1.now).toBeLessThan(p0.now);
    // a time between slot 1's clock and slot 0's clock: slot 1 is the nearest at or before it
    const t = p1.now + Math.min(MS, Math.floor((p0.now - p1.now) / 2));
    const r = await tm.seek({ time: t });
    expect(r.atLive).toBe(false);
    expect(tm.reviewing).toBe(true);
    expect(tm.busy).toBe(true);
    const c = tm.cursor();
    expect(c?.from).toBe(1);
    expect(c?.ready).toBe(true);
    expect(tm.slots()[1]?.position).toBeNull();
    expect(tm.slots()[0]?.position).toEqual(p0);
    // exact cost (§3.13 step 6): the events between the parked position and the target
    expect(r.replayedEvents).toBe((c?.position.dispatched as number) - p1.dispatched);
    expect(tm.reviewInfo()).toEqual({ at: c?.position, t, live: live.position(), atLive: false });
    // the reviewed world equals a fresh replay of the journal to the same time
    expect(snapOf(tm.reviewSim as Simulation)).toBe(snapOf(freshReplayAt(live, { time: t })));
    expect((tm.reviewSim as Simulation).now).toBe(t);
    // no refill of the empty slot while reviewing
    tm.tick();
    expect(tm.slots()[1]?.position).toBeNull();

    tm.leave();
    expect(tm.reviewing).toBe(false);
    expect(tm.cursor()).toBeUndefined();
    expect(tm.reviewSim).toBeUndefined();
    const back = tm.slots()[1];
    expect(back?.position).toEqual(c?.position);
    // ahead of its target: it idles there
    tm.tick();
    expect(tm.slots()[1]?.position).toEqual(c?.position);
    expect(fingerprint(live)).toEqual(before);
  });

  it('a forward seek inside review advances the cursor replay; a backward one takes another parked replayer and re-parks the old cursor', async () => {
    const tm = machine();
    parkAll(tm);
    const slots = tm.slots();
    const p0 = slots[0]?.position as JournalPosition;
    const p1 = slots[1]?.position as JournalPosition;
    const p2 = slots[2]?.position as JournalPosition;
    const t1 = p1.now + Math.min(MS, Math.floor((p0.now - p1.now) / 2));
    await tm.seek({ time: t1 });
    const first = tm.cursor()?.position as JournalPosition;
    expect(tm.cursor()?.from).toBe(1);

    // forward, still before slot 0's clock: the cursor replay just advances
    const t2 = t1 + Math.min(MS, Math.floor((p0.now - t1) / 2));
    expect(t2).toBeGreaterThan(t1);
    const fwd = await tm.seek({ time: t2 });
    expect(tm.cursor()?.from).toBe(1);
    expect(fwd.replayedEvents).toBe((tm.cursor()?.position.dispatched as number) - first.dispatched);
    expect(tm.slots()[0]?.position).toEqual(p0);
    expect(tm.slots()[2]?.position).toEqual(p2);
    expect(snapOf(tm.reviewSim as Simulation)).toBe(snapOf(freshReplayAt(live, { time: t2 })));
    const second = tm.cursor()?.position as JournalPosition;

    // backward, before slot 2's clock is not possible (nothing older is parked) — so to a time slot 2 can reach
    const t3 = p2.now + Math.min(MS, Math.floor((p1.now - p2.now) / 2));
    expect(t3).toBeLessThan(t1);
    const bwd = await tm.seek({ time: t3 });
    expect(tm.cursor()?.from).toBe(2);
    expect(bwd.replayedEvents).toBe((tm.cursor()?.position.dispatched as number) - p2.dispatched);
    // the old cursor went back to slot 1, where it was taken from
    expect(tm.slots()[1]?.position).toEqual(second);
    expect(tm.slots()[2]?.position).toBeNull();
    expect(snapOf(tm.reviewSim as Simulation)).toBe(snapOf(freshReplayAt(live, { time: t3 })));

    tm.leave();
    expect(tm.slots()[2]?.position).toEqual(tm.slots()[2]?.position);
    expect(tm.slots().map((s) => s.position === null)).toEqual([false, false, false]);
    expect(fingerprint(live)).toEqual(before);
  });

  it('a target older than every parked replayer replays from the origin; on leave it takes the empty slot with the largest lag, or is discarded', async () => {
    const tm = machine();
    parkAll(tm);
    // cursor 0 is the first event of the run: only a fresh replay can still reach it
    const r = await tm.seek({ cursor: 0 });
    expect(tm.cursor()?.from).toBe('origin');
    expect(r.replayedEvents).toBe(tm.cursor()?.position.dispatched);
    expect(tm.slots().every((s) => s.position !== null)).toBe(true);
    tm.leave();
    // every slot is taken: discarded
    expect(tm.slots().every((s) => s.position !== null)).toBe(true);
    expect(tm.cursor()).toBeUndefined();

    // with only slot 0 parked (a small chunk builds one slot per tick), the origin replay lands in the emptiest, largest-lag slot
    const lazy = machine({ parkChunk: 1 });
    lazy.tick();
    expect(lazy.slots().map((s) => s.position !== null)).toEqual([true, false, false]);
    await lazy.seek({ cursor: 0 });
    expect(lazy.cursor()?.from).toBe('origin');
    lazy.tick();
    // no refill while reviewing
    expect(lazy.slots().map((s) => s.position !== null)).toEqual([true, false, false]);
    lazy.leave();
    expect(lazy.slots().map((s) => s.position !== null)).toEqual([true, false, true]);
    // outside review the empty slot refills lazily from the origin
    lazy.tick();
    expect(lazy.slots()[1]?.position).not.toBeNull();
    expect(fingerprint(live)).toEqual(before);
  });

  it('history off: no replayer is kept and every seek replays from the origin at exactly target.dispatched events', async () => {
    const tm = machine();
    parkAll(tm);
    tm.setBudget({ replayers: 0 });
    expect(tm.slots()).toEqual([]);
    tm.tick();
    const target = marks[1] as { t: SimTime; position: JournalPosition; snapshot: string };
    const r = await tm.seek({ time: target.t });
    expect(tm.cursor()?.from).toBe('origin');
    expect(r.replayedEvents).toBe(target.position.dispatched);
    expect(tm.cursor()?.position).toEqual(target.position);
    expect(snapOf(tm.reviewSim as Simulation)).toBe(target.snapshot);
    tm.leave();
    expect(tm.slots()).toEqual([]);
    expect(() => tm.setBudget({ lagsEvents: [5, 3] })).toThrow(RangeError);
    expect(() => tm.setBudget({ replayers: -1 })).toThrow(RangeError);
    expect(() => tm.setBudget({ laneEntries: 0 })).toThrow(RangeError);
    expect(fingerprint(live)).toEqual(before);
  });

  it('seeks by position and by cursor resolve like fresh replays; a target at or past the present reviews nothing', async () => {
    const tm = machine();
    parkAll(tm);
    const m = marks[2] as { t: SimTime; position: JournalPosition; snapshot: string };
    const byPosition = await tm.seek({ position: m.position });
    expect(byPosition.atLive).toBe(false);
    expect(tm.cursor()?.position).toEqual(m.position);
    expect(snapOf(tm.reviewSim as Simulation)).toBe(m.snapshot);
    const head = live.traceQuery({ from: 0, limit: 0 }).head;
    const c = Math.floor(head / 3);
    await tm.seek({ cursor: c });
    const reference = freshReplayAt(live, { cursor: c });
    expect(snapOf(tm.reviewSim as Simulation)).toBe(snapOf(reference));
    // the first position whose trace head passes the cursor (one dispatched event may emit several trace events)
    const reviewHead = (tm.reviewSim as Simulation).traceQuery({ from: 0, limit: 0 }).head;
    expect(reviewHead).toBeGreaterThan(c);
    expect(reviewHead).toBe(reference.traceQuery({ from: 0, limit: 0 }).head);
    // the present itself
    const atLive = await tm.seek({ position: { dispatched: live.position().dispatched + 5, now: live.now + SEC } });
    expect(atLive.atLive).toBe(true);
    expect(tm.atLive()).toBe(true);
    expect(tm.reviewInfo()?.atLive).toBe(true);
    tm.leave();
    const byTime = await tm.seek({ time: live.now + 10 * SEC });
    expect(byTime.atLive).toBe(true);
    tm.leave();
    expect(fingerprint(live)).toEqual(before);
  });

  it('a newer seek supersedes an older one between two chunks', async () => {
    let gate: Promise<void> = Promise.resolve();
    let open: (() => void) | undefined;
    // one event per chunk: every seek of this case needs at least two, so each one yields at least once
    const tm = createTimeMachine({ sim: () => live, yieldToHost: () => gate }, { budget: { replayers: 3, lagsEvents: lags }, parkChunk: 10_000, seekChunk: 1 });
    parkAll(tm);
    gate = new Promise((resolve) => {
      open = resolve;
    });
    const m = marks[1] as { t: SimTime; position: JournalPosition; snapshot: string };
    const older = tm.seek({ time: (marks[0] as { t: SimTime }).t + SEC });
    expect(tm.seeking).toBe(true);
    expect(tm.reviewing).toBe(false);
    const newer = tm.seek({ time: m.t });
    open?.();
    await expect(older).rejects.toBeInstanceOf(SeekSupersededError);
    gate = Promise.resolve();
    const r = await newer;
    expect(r.atLive).toBe(false);
    expect(tm.reviewing).toBe(true);
    expect(tm.cursor()?.position).toEqual(m.position);
    expect(snapOf(tm.reviewSim as Simulation)).toBe(m.snapshot);
    // leave() also supersedes a seek in flight
    gate = new Promise((resolve) => {
      open = resolve;
    });
    const cancelled = tm.seek({ time: (marks[0] as { t: SimTime }).t });
    tm.leave();
    open?.();
    await expect(cancelled).rejects.toBeInstanceOf(SeekSupersededError);
    expect(tm.reviewing).toBe(false);
    expect(tm.cursor()).toBeUndefined();
    expect(fingerprint(live)).toEqual(before);
  });

  it('a seek target is normalised before anything moves: a fractional time rounds; a malformed one changes nothing and supersedes nothing', async () => {
    const tm = machine();
    parkAll(tm);
    const m = marks[1] as { t: SimTime; position: JournalPosition; snapshot: string };
    // a scrubber's pixel → time mapping gives fractions: the seek rounds to whole ns (sim time is integral)
    const r = await tm.seek({ time: m.t + 0.4 });
    expect(r.atLive).toBe(false);
    expect((tm.reviewSim as Simulation).now).toBe(m.t);
    expect(snapOf(tm.reviewSim as Simulation)).toBe(m.snapshot);
    const info = tm.reviewInfo();
    const cursor = tm.cursor();
    const slots = tm.slots();
    const malformed = [
      { time: Number.NaN },
      { time: Number.POSITIVE_INFINITY },
      { time: '5' },
      { cursor: -1 },
      { cursor: 1.5 },
      { position: { dispatched: -1, now: 0 } },
      { position: { dispatched: 1 } },
      {},
      null,
    ] as unknown as SeekTarget[];
    for (const target of malformed) {
      await expect(tm.seek(target), JSON.stringify(target)).rejects.toBeInstanceOf(RangeError);
      // the review it met is untouched: same instant, same cursor replay, same parked replayers
      expect(tm.reviewing).toBe(true);
      expect(tm.reviewInfo()).toEqual(info);
      expect(tm.cursor()).toEqual(cursor);
      expect(tm.slots()).toEqual(slots);
    }
    tm.leave();

    // nor does a malformed target supersede a seek in flight
    let open: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const slow = createTimeMachine({ sim: () => live, yieldToHost: () => gate }, { budget: { replayers: 3, lagsEvents: lags }, parkChunk: 10_000, seekChunk: 1 });
    parkAll(slow);
    const inFlight = slow.seek({ time: m.t });
    expect(slow.seeking).toBe(true);
    await expect(slow.seek({ time: Number.NaN })).rejects.toBeInstanceOf(RangeError);
    open?.();
    const done = await inFlight;
    expect(done.atLive).toBe(false);
    expect(slow.cursor()?.position).toEqual(m.position);
    slow.leave();
    expect(fingerprint(live)).toEqual(before);
  });

  it('a budget is checked whole before any of it applies; the lane-entry bound is the lane index\'s (two)', () => {
    const tm = machine();
    const budget = tm.budget;
    expect(() => tm.setBudget({ replayers: 0, laneEntries: 1 })).toThrow(RangeError);
    expect(tm.budget).toEqual(budget);
    expect(tm.slots()).toHaveLength(3);
    expect(() => createLaneIndex(1)).toThrow(RangeError);
    tm.setBudget({ laneEntries: 2 });
    expect(tm.budget.laneEntries).toBe(2);
    expect(createLaneIndex(2).capacity).toBe(2);
  });

  it('only a cursor that serves review feeds the host clock: the prefix a seek replays never reaches it', async () => {
    const seen: TraceEvent[] = [];
    const tm = createTimeMachine({ sim: () => live, observe: (ev) => seen.push(ev) }, { budget: { replayers: 0 } });
    const m = marks[1] as { t: SimTime; position: JournalPosition; snapshot: string };
    // history off: this seek replays the whole prefix from the origin
    const r = await tm.seek({ time: m.t });
    expect(r.replayedEvents).toBe(m.position.dispatched);
    expect(seen).toEqual([]);
    // the review ring still holds what the seek replayed (the instant's context)
    expect((tm.reviewSim as Simulation).trace(0).events.length).toBeGreaterThan(0);
    // review play and step: the cursor serves review, so the clock hears it
    tm.reviewRunUntil(m.t + 2 * SEC);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((e) => e.t >= m.t && e.t <= m.t + 2 * SEC)).toBe(true);
    // a forward seek inside review replays without it too
    const heard = seen.length;
    await tm.seek({ time: m.t + 3 * SEC });
    expect(seen).toHaveLength(heard);
    tm.reviewStep();
    tm.reviewRunUntil(m.t + 4 * SEC);
    expect(seen.length).toBeGreaterThan(heard);
    tm.leave();
    expect(fingerprint(live)).toEqual(before);
  });

  it('the review drivers move only forward and never past the live position, where review ends', async () => {
    const tm = machine();
    parkAll(tm);
    const m = marks[2] as { t: SimTime; position: JournalPosition; snapshot: string };
    await tm.seek({ time: m.t });
    const review = tm.reviewSim as Simulation;
    // step by step to the present
    let steps = 0;
    let prev = tm.cursor()?.position as JournalPosition;
    while (!tm.atLive()) {
      tm.reviewStep();
      const p = tm.cursor()?.position as JournalPosition;
      expect(p.dispatched).toBeGreaterThanOrEqual(prev.dispatched);
      expect(p.dispatched).toBeLessThanOrEqual(prev.dispatched + 1);
      prev = p;
      if (++steps > 100_000) throw new Error('never reached the present');
    }
    expect(tm.cursor()?.position).toEqual(live.position());
    expect(snapOf(review)).toBe(snapOf(live));
    tm.leave();

    // the clock driver: a slice past the present stops at it and says so
    await tm.seek({ time: m.t });
    const driver = tm.reviewDriver();
    expect(driver.now).toBe(m.t);
    expect(driver.nextEventTime()).toBeDefined();
    const stats = driver.runUntil(live.now + 60 * SEC);
    expect(stats.to).toBe(live.now);
    expect(stats.stopped).toBe('breakpoint');
    expect(stats.events).toBe(live.position().dispatched - m.position.dispatched);
    expect(tm.atLive()).toBe(true);
    expect(driver.nextEventTime()).toBeUndefined();
    tm.leave();

    // runUntil and runToLive
    await tm.seek({ time: m.t });
    tm.reviewRunUntil(m.t + 2 * SEC);
    expect((tm.reviewSim as Simulation).now).toBe(m.t + 2 * SEC);
    expect(snapOf(tm.reviewSim as Simulation)).toBe(snapOf(freshReplayAt(live, { time: m.t + 2 * SEC })));
    tm.reviewRunToLive();
    expect(tm.atLive()).toBe(true);
    expect(snapOf(tm.reviewSim as Simulation)).toBe(snapOf(live));
    tm.leave();
    expect(fingerprint(live)).toEqual(before);
  });

  it('a replay that goes a different way than the journal switches history off and surfaces the defect', async () => {
    // a journal whose recorded trace heads are wrong: the replay diverges at entry 1
    const tampered = new Proxy(live, {
      get(target, prop) {
        if (prop === 'journal') {
          return (): SimJournal => {
            const j = live.journal();
            const entries = j.entries as unknown as { traceHead: number }[];
            if (entries[1] !== undefined) entries[1].traceHead += 1;
            return j;
          };
        }
        return Reflect.get(target, prop, target) as unknown;
      },
    });
    const tm = createTimeMachine({ sim: () => tampered }, { budget: { replayers: 2, lagsEvents: [lags[0] as number, lags[1] as number] }, parkChunk: 10_000 });
    expect(() => parkAll(tm)).toThrow(ReplayDivergenceError);
    expect(tm.slots().every((s) => s.position === null)).toBe(true);
    tm.tick();
    expect(tm.slots().every((s) => s.position === null)).toBe(true);
    await expect(tm.seek({ time: (marks[1] as { t: SimTime }).t })).rejects.toBeInstanceOf(ReplayDivergenceError);
    expect(tm.reviewing).toBe(false);
    // a new world clears the fault
    tm.reset();
    expect(fingerprint(live)).toEqual(before);
  });

  it('observation purity: a world reviewed all along ends byte-identical to a twin that never was', async () => {
    const reviewed = liveWorld(47).sim;
    const quiet = liveWorld(47).sim;
    expect(snapOf(reviewed)).toBe(snapOf(quiet));
    const tm = createTimeMachine({ sim: () => reviewed }, { budget: { replayers: 3, lagsEvents: [10, 40, 80] }, parkChunk: 10_000 });
    const peek = async (): Promise<void> => {
      parkAll(tm);
      await tm.seek({ time: Math.max(0, reviewed.now - 5 * SEC) });
      tm.reviewStep();
      tm.reviewRunUntil(reviewed.now);
      tm.leave();
      await tm.seek({ cursor: 3 });
      tm.leave();
    };
    const script = async (sim: Simulation, spy: () => Promise<void>): Promise<void> => {
      await spy();
      const s = sim.cli.open('pc2', 'console');
      sim.cli.exec(s, 'ping 10.0.0.1');
      await spy();
      sim.runFor(2 * SEC);
      await spy();
      sim.step();
      sim.configure('sw1', ['hostname Twin']);
      await spy();
      sim.runFor(3 * SEC, { stopOn: { kinds: ['tableWrite'] } });
      await spy();
      sim.runToIdle();
      await spy();
    };
    await script(reviewed, peek);
    await script(quiet, async () => undefined);
    expect(reviewed.position()).toEqual(quiet.position());
    expect(snapOf(reviewed)).toBe(snapOf(quiet));
    expect(JSON.stringify(reviewed.trace(0).events)).toBe(JSON.stringify(quiet.trace(0).events));
    expect(JSON.stringify(reviewed.journal())).toBe(JSON.stringify(quiet.journal()));
  });
});

// ── the worker API ───────────────────────────────────────────────────────────

let exposed: EngineApi | undefined;

vi.mock('comlink', () => ({
  expose: (api: EngineApi) => {
    exposed = api;
  },
  proxy: <T>(x: T) => x,
  transfer: <T>(x: T) => x,
}));

const WORKER = '../src/bridge/worker/index.ts';

type TimeTravelApi = Required<Pick<EngineApi, 'seek' | 'leaveReview' | 'timelineBuckets' | 'timelineMarks' | 'setTimeTravelBudget'>>;

async function booted(): Promise<{ api: EngineApi & TimeTravelApi; batches: EngineBatch[] }> {
  vi.resetModules();
  exposed = undefined;
  await import(WORKER);
  const api = exposed as unknown as EngineApi & TimeTravelApi;
  const batches: EngineBatch[] = [];
  await api.subscribe((b) => {
    batches.push(b);
  });
  await api.init({ seed: 7 });
  await api.loadScenario('two-pcs-and-switch');
  await api.runToIdle();
  const view = await api.cliOpen('pc1', 'console');
  await api.cliExec(view.id, 'ping 10.0.0.2');
  await api.runToIdle();
  batches.length = 0;
  return { api, batches };
}

const last = (batches: readonly EngineBatch[]): EngineBatch => {
  const b = batches[batches.length - 1];
  if (b === undefined) throw new Error('no batch was posted');
  return b;
};

describe('the worker API in review', () => {
  beforeEach(() => {
    // setTimeout stays real: seek chunks yield through it
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('seek posts the past: a full snapshot of that instant with `review`, the live trace head and the timeline head', async () => {
    const { api, batches } = await booted();
    const live = await api.snapshot();
    const liveHead = (await api.traceQuery({ from: 0, limit: 0 })).head;
    expect(live.sessions).toHaveLength(1);
    const epochBefore = (await api.play(), await api.pause(), last(batches).epoch);
    batches.length = 0;

    const r = await api.seek({ time: 5 * SEC });
    expect(r.review.t).toBe(5 * SEC);
    expect(r.review.atLive).toBe(false);
    expect(r.review.live.now).toBe(live.now);
    expect(r.snapshot.now).toBe(5 * SEC);
    expect(r.snapshot.sessions).toHaveLength(0);
    expect(r.replayedEvents).toBe(r.review.at.dispatched);
    const b = last(batches);
    expect(b.epoch).toBe(epochBefore);
    expect(b.review).toEqual(r.review);
    expect(b.snapshot?.now).toBe(5 * SEC);
    expect(b.now).toBe(5 * SEC);
    expect(b.playing).toBe(false);
    expect(b.traceHead).toBe(liveHead);
    expect(b.dropped).toBe(0);
    expect(b.eventsTruncated).toBeUndefined();
    expect(b.timelineHead?.t).toBe(live.now);
    expect(b.timelineHead?.at.now).toBe(live.now);
    // the events of the reviewed instant, in order, with live cursors below the live head
    expect(b.events.length).toBeGreaterThan(0);
    expect(b.events.every((e) => e.t <= 5 * SEC)).toBe(true);
    // the instant on screen is the past: a resync reads it too
    expect((await api.snapshot()).now).toBe(5 * SEC);
    // while the live world is still where it was
    expect((await api.traceQuery({ from: 0, limit: 0 })).head).toBe(liveHead);
    expect((await api.exportTopology()).devices.map((d) => d.id).sort()).toEqual(['pc1', 'pc2', 'sw1']);
  });

  it('every call that would change the network rejects with the read-only message; leaving review returns the pre-review live snapshot', async () => {
    const { api, batches } = await booted();
    const before = await api.snapshot();
    await api.seek({ time: 10 * SEC });
    batches.length = 0;
    const calls: (() => Promise<unknown>)[] = [
      () => api.addDevice({ type: 'pc.nfpc', position: { x: 0, y: 0 } }),
      () => api.removeDevice('pc2'),
      () => api.renameDevice('pc2', 'X'),
      () => api.moveDevice('pc2', { x: 1, y: 1 }),
      () => api.setPower('pc2', false),
      () => api.addLink({ a: { device: 'pc1', port: 'gi0' }, b: { device: 'sw1', port: 'fa0/9' } }),
      () => api.removeLink('l_pc2_sw1'),
      () => api.setImpairments('l_pc2_sw1', { lossPct: 5 }),
      () => api.insertModule('sw1', 'slot0' as never, 'x' as never),
      () => api.removeModule('sw1', 'slot0' as never),
      () => api.setDeviceUi('pc1', { note: 'n' }),
      () => api.setCanvasScale(2),
      () => api.cliOpen('pc2', 'console'),
      () => api.cliExec('s_1' as never, 'show version'),
      () => api.cliInterrupt('s_1' as never),
      () => api.cliClose('s_1' as never),
      () => api.configure('sw1', ['hostname Nope']),
      () => api.hostRequest('pc1', { app: 'dhcp.release', port: 'GigabitEthernet0' }),
      () => api.loadTopology(twoPcsAndSwitch()),
      () => api.loadScenario('pc-router-pc'),
      () => api.reset(9),
      () => api.useCurrentDefaults(),
      () => api.stepToNext(),
      () => api.runUntilStop(200 * SEC, { kinds: ['frameTx'] }),
    ];
    for (const call of calls) await expect(call()).rejects.toThrow(REPLAY_READ_ONLY_MESSAGE);
    // nothing of that posted a live batch
    expect(batches.every((b) => b.review !== undefined && b.review !== null)).toBe(true);
    // reads keep answering: the lab check reads the live world, the CLI helpers too
    expect(await api.checkLab()).toBeNull();
    expect((await api.cliCanOpen('pc2', 'console')).ok).toBe(true);
    expect(await api.listScenarios()).not.toHaveLength(0);

    const after = await api.leaveReview();
    expect(after).toEqual(before);
    const b = last(batches);
    expect(b.review).toBeNull();
    expect(b.snapshot).toEqual(before);
    expect(b.now).toBe(before.now);
    expect((await api.snapshot()).now).toBe(before.now);
    // and the network can change again
    await api.renameDevice('pc2', 'Back');
    expect(last(batches).review).toBeUndefined();
    expect(last(batches).delta?.devices.find((d) => d.id === 'pc2')?.name).toBe('Back');
    // leaving twice is harmless
    expect((await api.leaveReview()).now).toBe(before.now);
  });

  it('play in review drives the cursor replay to the present, where review ends by itself with a full live snapshot', async () => {
    const { api, batches } = await booted();
    const before = await api.snapshot();
    // no slow motion on the wire (the clamp would take hundreds of ticks per frame leg): the review plays at the rate
    await api.setClockPolicy({ minTransitWallMs: 0 });
    await api.setRate(1000);
    await api.seek({ time: 5 * SEC });
    batches.length = 0;
    await api.play();
    expect(last(batches).review?.t).toBe(5 * SEC);
    expect(last(batches).playing).toBe(true);
    let ended = false;
    let lastT = 5 * SEC;
    let seen = 0;
    for (let i = 0; i < 400 && !ended; i++) {
      vi.advanceTimersByTime(16);
      // the batches this tick posted, in order: review time never goes back
      for (; seen < batches.length && !ended; seen++) {
        const b = batches[seen] as EngineBatch;
        if (b.review === null) {
          ended = true;
          break;
        }
        if (b.review !== undefined) {
          expect(b.review.t).toBeGreaterThanOrEqual(lastT);
          lastT = b.review.t;
        }
      }
    }
    expect(ended).toBe(true);
    await api.pause();
    const end = batches.find((b) => b.review === null);
    expect(end?.snapshot).toEqual(before);
    // the live world was never touched: the present is where it was
    expect(await api.snapshot()).toEqual(before);
  });

  it('stepping in review moves one event at a time and ends review at the present; a seek to the present reviews nothing', async () => {
    const { api, batches } = await booted();
    const before = await api.snapshot();
    const head = last((await api.pause(), batches)).timelineHead;
    expect(head).toBeDefined();
    const r = await api.seek({ time: (head?.t as number) - 1 });
    expect(r.review.atLive).toBe(false);
    let at = r.review.at.dispatched;
    let ended = false;
    for (let i = 0; i < 10_000 && !ended; i++) {
      batches.length = 0;
      const snap = await api.stepEvent();
      const b = last(batches);
      if (b.review === null) {
        ended = true;
        expect(snap).toEqual(before);
      } else {
        expect(b.review?.at.dispatched).toBeLessThanOrEqual(at + 1);
        at = b.review?.at.dispatched as number;
        expect(b.snapshot?.now).toBe(snap.now);
      }
    }
    expect(ended).toBe(true);
    expect(await api.snapshot()).toEqual(before);

    // stepTime past the present ends review too
    await api.seek({ time: 5 * SEC });
    const t = await api.stepTime(2 * SEC);
    expect(t.now).toBe(7 * SEC);
    expect(last(batches).review?.t).toBe(7 * SEC);
    const toLive = await api.runToIdle();
    expect(toLive).toEqual(before);
    expect(last(batches).review).toBeNull();

    // the present itself
    batches.length = 0;
    const present = await api.seek({ time: head?.t as number });
    expect(present.review.atLive).toBe(true);
    expect(present.snapshot).toEqual(before);
    expect(last(batches).review).toBeNull();
    expect(await api.snapshot()).toEqual(before);
  });

  it('timelineBuckets and timelineMarks answer from the live lane index; marks resolve their events from the live ring', async () => {
    const { api, batches } = await booted();
    await api.pause();
    const head = last(batches).timelineHead;
    const t = head?.t as number;
    const revision = head?.lanesRevision as number;
    expect(revision).toBeGreaterThan(0);
    const buckets = await api.timelineBuckets({ from: 0, to: t, buckets: 4 });
    expect(buckets).toHaveLength(4);
    const links = buckets.reduce((n, b) => n + (b.counts.link ?? 0), 0);
    expect(links).toBeGreaterThan(0);
    const marks = await api.timelineMarks({ lane: 'link', from: 0, to: t, limit: 50 });
    expect(marks.length).toBe(Math.min(50, links));
    for (const m of marks) {
      expect(['linkState', 'portState']).toContain(m.event.kind);
      expect(m.lane).toBe('link');
      expect(m.t).toBe(m.event.t);
      const paged = await api.traceQuery({ from: m.cursor, limit: 1 });
      expect(paged.events[0]?.cursor).toBe(m.cursor);
      expect(paged.events[0]?.event).toEqual(m.event);
    }
    // a configuration line lands in the config lane, at the head, and bumps the revision
    await api.configure('sw1', ['hostname Marked']);
    const after = last(batches).timelineHead;
    expect(after?.lanesRevision).toBeGreaterThan(revision);
    const config = await api.timelineBuckets({ from: t, to: t, buckets: 1, lanes: ['config'] });
    expect(config[0]?.counts).toEqual({ config: 1 });
    // (the config lines of the loaded document are in the lane too, at 0 s: the marks are asked for at the head)
    const mark = (await api.timelineMarks({ lane: 'config', from: t, to: t, limit: 5 }))[0];
    expect(mark?.event.kind).toBe('configChange');
    expect(config[0]?.firstCursor.config).toBe(mark?.cursor);
    expect((await api.timelineMarks({ lane: 'config', from: 0, to: t, limit: 500 })).map((m) => m.cursor)).toContain(mark?.cursor);
    // the queries work in review too, still over the live index
    await api.seek({ time: 5 * SEC });
    expect(await api.timelineBuckets({ from: t, to: t, buckets: 1, lanes: ['config'] })).toEqual(config);
    await api.leaveReview();
  });

  it('a load restarts the lane index and the replayers with the new world', async () => {
    const { api, batches } = await booted();
    await api.pause();
    const before = last(batches).timelineHead?.lanesRevision as number;
    await api.loadScenario('two-pcs-and-switch');
    const after = last(batches).timelineHead;
    expect(after?.at).toEqual({ dispatched: 0, now: 0 });
    expect(after?.lanesRevision).toBeLessThan(before);
    // the boot of the reloaded world is indexed from its first event
    await api.runToIdle();
    const t = last(batches).timelineHead?.t as number;
    const links = (await api.timelineBuckets({ from: 0, to: t, buckets: 1 }))[0]?.counts.link ?? 0;
    expect(links).toBeGreaterThan(0);
    const r = await api.seek({ time: 1 * SEC });
    expect(r.review.at.now).toBe(SEC);
    await api.leaveReview();
    // a fresh world by seed: the same (this template emits no lane event at load; its boot is the first)
    await api.loadScenario('pc-router-pc', { seed: 99 });
    expect(last(batches).timelineHead?.at).toEqual({ dispatched: 0, now: 0 });
    expect(last(batches).review).toBeUndefined();
    await api.runToIdle();
    expect(last(batches).timelineHead?.lanesRevision).toBeGreaterThan(0);
    const booted2 = last(batches).timelineHead?.t as number;
    expect((await api.timelineBuckets({ from: 0, to: booted2, buckets: 1 }))[0]?.counts.link ?? 0).toBeGreaterThan(0);
  });

  it('setTimeTravelBudget: history off makes seeks replay from the origin; an invalid budget is refused', async () => {
    const { api, batches } = await booted();
    await api.setTimeTravelBudget({ replayers: 0, laneEntries: 16 });
    const r = await api.seek({ time: 20 * SEC });
    expect(r.replayedEvents).toBe(r.review.at.dispatched);
    expect(last(batches).review?.t).toBe(20 * SEC);
    await api.leaveReview();
    await expect(api.setTimeTravelBudget({ lagsEvents: [10, 5] })).rejects.toThrow(RangeError);
    await expect(api.setTimeTravelBudget({ laneEntries: 0 })).rejects.toThrow(RangeError);
    // history on again: lags that park one replayer one event before the target; the replayers catch up in the
    // background (the worker tick runs while paused), so the same seek costs exactly one event
    const D = last(batches).timelineHead?.at.dispatched as number;
    const P = r.review.at.dispatched;
    expect(P).toBeGreaterThan(1);
    await api.setTimeTravelBudget({ replayers: 3, lagsEvents: [D - (P - 1), D - 1, D] });
    vi.advanceTimersByTime(16 * 50);
    const again = await api.seek({ time: 20 * SEC });
    expect(again.replayedEvents).toBe(1);
    expect(again.replayedEvents).toBeLessThan(r.replayedEvents);
    expect(again.review.at).toEqual(r.review.at);
    await api.leaveReview();
  });

  it('setTimeTravelBudget is all or nothing: a refused budget leaves history on and the replayers where they were parked', async () => {
    const { api, batches } = await booted();
    await api.setTimeTravelBudget({ replayers: 0 });
    const r = await api.seek({ time: 20 * SEC });
    await api.leaveReview();
    const D = last(batches).timelineHead?.at.dispatched as number;
    const P = r.review.at.dispatched;
    await api.setTimeTravelBudget({ replayers: 3, lagsEvents: [D - (P - 1), D - 1, D] });
    vi.advanceTimersByTime(16 * 50);
    // one lane entry is below the lane index's bound: the whole call is refused, `replayers: 0` included
    await expect(api.setTimeTravelBudget({ replayers: 0, laneEntries: 1 })).rejects.toThrow(RangeError);
    const again = await api.seek({ time: 20 * SEC });
    expect(again.replayedEvents).toBe(1);
    expect(again.review.at).toEqual(r.review.at);
    await api.leaveReview();
  });

  it('a scrubber time with a fraction seeks to the rounded instant; a malformed target is refused and leaves the review on screen', async () => {
    const { api, batches } = await booted();
    const r = await api.seek({ time: 5.5 * SEC + 0.5 });
    expect(r.review.t).toBe(Math.round(5.5 * SEC + 0.5));
    expect(r.snapshot.now).toBe(r.review.t);
    expect(last(batches).review?.t).toBe(r.review.t);
    const posted = batches.length;
    for (const bad of [{ time: Number.NaN }, { cursor: -3 }, { cursor: 2.5 }, { position: { dispatched: 1, now: -1 } }] as SeekTarget[]) {
      await expect(api.seek(bad), JSON.stringify(bad)).rejects.toThrow(RangeError);
    }
    // nothing was posted and nothing moved: the same instant is on screen, still read-only
    expect(batches).toHaveLength(posted);
    expect((await api.snapshot()).now).toBe(r.review.t);
    await expect(api.renameDevice('pc2', 'No')).rejects.toThrow(REPLAY_READ_ONLY_MESSAGE);
    // a time before the run is its start
    const start = await api.seek({ time: -1 });
    expect(start.review.t).toBe(0);
    const back = await api.leaveReview();
    expect(last(batches).review).toBeNull();
    expect(back.now).toBe(r.review.live.now);
  });

  it('a seek or a review advance that fails after the time machine left review ends review in the store too; leaveReview always offers the way back', async () => {
    // a replay that diverges on demand: the one failure a well-formed seek can still meet (a determinism defect)
    let armed = false;
    vi.doMock('@netforge/engine', async (importOriginal) => {
      const real = await importOriginal<typeof import('@netforge/engine')>();
      const createReplay: typeof real.createReplay = (journal, opts) => {
        const replay = real.createReplay(journal, opts);
        const diverge = (): never => {
          throw new real.ReplayDivergenceError(0, 1, 2);
        };
        return new Proxy(replay, {
          get(target, prop) {
            if (armed && (prop === 'advance' || prop === 'advanceTo')) return diverge;
            return Reflect.get(target, prop, target) as unknown;
          },
        });
      };
      return { ...real, createReplay };
    });
    try {
      const { api, batches } = await booted();
      const before = await api.snapshot();
      await api.pause();
      // the store mirrors this world from a full live snapshot on, fed every batch the worker posts
      store.getState().applyBatch({ epoch: last(batches).epoch, now: before.now, playing: false, rate: 1, effectiveRate: 1, dropped: 0, events: [], snapshot: before } as EngineBatch);
      let fed = batches.length;
      const sync = (): void => {
        for (const b of batches.slice(fed)) store.getState().applyBatch(b);
        fed = batches.length;
      };
      await api.seek({ time: 5 * SEC });
      sync();
      expect(store.getState().timeline?.review?.t).toBe(5 * SEC);

      // a forward seek inside review diverges after it took the cursor replay: history is off and review is over in
      // the worker, so the ending batch (the full live snapshot, `review: null`) goes out before the rejection
      armed = true;
      const n = batches.length;
      await expect(api.seek({ time: 6 * SEC })).rejects.toThrow(/different way/);
      armed = false;
      expect(batches.slice(n).map((b) => b.review)).toEqual([null]);
      expect(last(batches).snapshot).toEqual(before);
      sync();
      expect(store.getState().timeline?.review).toBeNull();
      expect(store.getState().timeline?.reviewEvents).toEqual([]);
      expect(store.getState().now).toBe(before.now);
      expect(store.getState().snapshot?.now).toBe(before.now);
      expect(await api.snapshot()).toEqual(before);
      // the way back is always there (already the present: nothing to post), and the network can change again: its
      // batches are live ones on a live mirror
      expect(await api.leaveReview()).toEqual(before);
      await api.renameDevice('pc2', 'Changed');
      expect(last(batches).review).toBeUndefined();
      sync();
      expect(store.getState().timeline?.review).toBeNull();
      expect(store.getState().snapshot?.devices.find((d) => d.id === 'pc2')?.name).toBe('Changed');

      // the same through a review advance, in a fresh world (a load clears the fault)
      await api.loadScenario('two-pcs-and-switch');
      await api.runToIdle();
      const present = await api.snapshot();
      await api.seek({ time: 5 * SEC });
      sync();
      expect(store.getState().timeline?.review?.t).toBe(5 * SEC);
      armed = true;
      const m = batches.length;
      await expect(api.stepEvent()).rejects.toThrow(/different way/);
      armed = false;
      expect(batches.slice(m).map((b) => b.review)).toEqual([null]);
      expect(last(batches).snapshot).toEqual(present);
      sync();
      expect(store.getState().timeline?.review).toBeNull();
      expect(store.getState().now).toBe(present.now);
      expect(await api.snapshot()).toEqual(present);
    } finally {
      vi.doUnmock('@netforge/engine');
    }
  });
});
