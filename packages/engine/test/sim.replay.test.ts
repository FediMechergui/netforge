/**
 * sim [S1] — deterministic replay of the input journal (ARCHITECTURE-P2 D18, §2.13, §3.13 steps 2–4; §7 W2 sim [S1]):
 * a replay built from the journal reaches the live position with byte-identical trace and snapshot JSON, every
 * intermediate entry and position equals the live snapshot recorded there, chunked and interleaved replays stay
 * identical, seeks by time and by cursor resolve, and a tampered journal is caught as a divergence.
 */
import { describe, expect, it } from 'vitest';
import { ReplayDivergenceError, type JournalPosition, type SimJournal } from '../src/contracts/journal.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { pcRouterPc, twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { ReplayExhaustedError, createOriginSimulation, createReplay, replayJournal } from '../src/sim/replay.js';
import { DEFAULT_TRACE_CAPACITY, createSimulation } from '../src/sim/simulation.js';

const snap = (sim: Simulation): string => JSON.stringify(sim.snapshot());
const traceFrom = (sim: Simulation, cursor: number): string => JSON.stringify(sim.trace(cursor).events);
const head = (sim: Simulation): number => sim.trace(Number.MAX_SAFE_INTEGER).next;

/** The time at which the console inputs of the script are typed (after boot, before anything else). */
const T_INPUTS = 60 * SEC;

/** One step of the seeded input script: a mutating call, or a run. */
type Step = (sim: Simulation) => void;

/** The seeded input script: every kind of input, every way of running. */
function script(): Step[] {
  return [
    (sim) => sim.loadTopology(twoPcsAndSwitch()),
    (sim) => sim.runFor(25 * SEC),
    // a breakpoint stop leaves the clock at the matching event (the first link comes up around 30 s)
    (sim) => sim.runFor(20 * SEC, { stopOn: { kinds: ['linkState'] } }),
    (sim) => {
      sim.step();
      sim.step();
    },
    (sim) => sim.stepToNext({ kinds: ['tableWrite'] }, { until: 50 * SEC }),
    (sim) => sim.runUntil(T_INPUTS),
    (sim) => {
      const s = sim.cli.open('pc1', 'console');
      sim.cli.exec(s, 'ping 10.0.0.2');
    },
    (sim) => sim.runFor(3 * SEC),
    (sim) => sim.injectFault(sim.now + SEC, { id: 'cut', kind: 'cable-cut', target: { link: 'l_pc2_sw1' }, params: { durationNs: 2 * SEC } }),
    (sim) => sim.moveDevice('sw1', { x: 300, y: 120 }),
    (sim) => sim.runToIdle(),
    (sim) => sim.setPower('pc2', false),
    (sim) => sim.runFor(SEC),
    (sim) => sim.setPower('pc2', true),
    (sim) => sim.runFor(30 * SEC),
    (sim) => sim.configure('sw1', ['hostname Core', 'interface FastEthernet0/3', 'description spare']),
    (sim) => sim.renameDevice('pc1', 'Alpha'),
    (sim) => sim.hostRequest('pc1', { app: 'dhcp.release', port: 'GigabitEthernet0' }),
    (sim) => {
      const pc = sim.addDevice({ type: 'pc.nfpc', name: 'PC3', position: { x: 10.6, y: 3 } });
      sim.addLink({ a: { device: pc, port: 'gi0' }, b: { device: 'sw1', port: 'fa0/5' } });
      sim.setImpairments('l_pc1_sw1', { latencyNs: 5_000_000 });
    },
    (sim) => sim.runFor(40 * SEC),
    (sim) => {
      const s = sim.cli.open('pc1', 'console');
      sim.cli.exec(s, 'ping 10.0.0.2');
      sim.runFor(2 * SEC, { maxEvents: 7 });
      sim.cli.interrupt(s);
      sim.cli.close(s);
    },
    (sim) => sim.runToIdle(),
    (sim) => expect(() => sim.addLink({ a: { device: 'pc1', port: 'gi0' }, b: { device: 'sw1', port: 'fa0/9' } })).toThrow(),
    (sim) => sim.removeLink('l_pc2_sw1'),
    (sim) => sim.removeDevice('pc2'),
    (sim) => sim.runFor(5 * SEC),
  ];
}

interface Recorded {
  readonly sim: Simulation;
  readonly journal: SimJournal;
  /** Snapshot JSON, position and journal length after each step. */
  readonly after: { position: JournalPosition; snapshot: string; entries: number }[];
  /** Snapshot JSON right after each journal entry. */
  readonly afterEntry: string[];
}

function runScript(seed: number): Recorded {
  const sim = createSimulation({ seed });
  const after: Recorded['after'] = [];
  const afterEntry: string[] = [];
  let seen = 0;
  for (const step of script()) {
    step(sim);
    const n = sim.journal().entries.length;
    after.push({ position: sim.position(), snapshot: snap(sim), entries: n });
    // a step that recorded exactly one entry: the snapshot right after it
    if (n === seen + 1) afterEntry[seen] = after[after.length - 1]!.snapshot;
    seen = n;
  }
  return { sim, journal: sim.journal(), after, afterEntry };
}

/**
 * The step-end positions at which the live script recorded nothing more (every journal entry at that position was
 * already in): the states `advance(position)` must reproduce.
 */
function completePositions(r: Recorded): { position: JournalPosition; snapshot: string }[] {
  const same = (a: JournalPosition, b: JournalPosition): boolean => a.dispatched === b.dispatched && a.now === b.now;
  const out: { position: JournalPosition; snapshot: string }[] = [];
  for (const a of r.after) {
    const total = r.journal.entries.filter((e) => same(e.at, a.position)).length;
    const seen = r.journal.entries.slice(0, a.entries).filter((e) => same(e.at, a.position)).length;
    if (total === seen && !out.some((o) => same(o.position, a.position))) out.push({ position: a.position, snapshot: a.snapshot });
  }
  return out;
}

describe('replay of the input journal', () => {
  const live = runScript(11);
  const origin = live.journal.origin;

  it('the script produced every kind of entry and started from a loaded document', () => {
    expect(origin.topology).toEqual(twoPcsAndSwitch());
    expect(origin.counters.traceHead).toBe(0);
    const kinds = new Set(live.journal.entries.map((e) => e.op.op));
    for (const k of ['cliOpen', 'cliExec', 'cliInterrupt', 'cliClose', 'injectFault', 'moveDevice', 'setPower', 'configure', 'renameDevice', 'hostRequest', 'addDevice', 'addLink', 'setImpairments', 'removeLink', 'removeDevice']) {
      expect(kinds.has(k as never)).toBe(true);
    }
    expect(live.journal.entries.some((e) => e.threw === true)).toBe(true);
    expect(live.after[2]!.position.now).toBeLessThan(45 * SEC);
    expect(live.after[5]!.position.now).toBe(T_INPUTS);
    expect(live.after[6]!.position.now).toBe(T_INPUTS);
  });

  it('reaches the live position with byte-identical trace and snapshot JSON', () => {
    const replay = createReplay(live.journal, { traceCapacity: DEFAULT_TRACE_CAPACITY });
    const r = replay.advance(live.sim.position());
    expect(r.reached).toBe(true);
    expect(r.entries).toBe(live.journal.entries.length);
    expect(replay.applied).toBe(live.journal.entries.length);
    expect(replay.position()).toEqual(live.sim.position());
    expect(head(replay.sim)).toBe(head(live.sim));
    expect(traceFrom(replay.sim, origin.counters.traceHead)).toBe(traceFrom(live.sim, origin.counters.traceHead));
    expect(snap(replay.sim)).toBe(snap(live.sim));
    // the replay journals nothing of its own
    expect(replay.sim.journal().entries).toEqual([]);
  });

  it('a parked replayer (no trace, a small PDU registry) reproduces the same snapshot', () => {
    const replay = createReplay(live.journal);
    replay.advance(live.sim.position());
    expect(replay.sim.trace(0).events).toEqual([]);
    expect(head(replay.sim)).toBe(head(live.sim));
    expect(snap(replay.sim)).toBe(snap(live.sim));
    expect(replayJournal(live.journal, live.sim.position()).snapshot()).toEqual(live.sim.snapshot());
  });

  it('every complete intermediate position equals the live snapshot recorded there', () => {
    const points = completePositions(live);
    expect(points.length).toBeGreaterThan(10);
    for (const { position, snapshot } of points) {
      const replay = createReplay(live.journal);
      expect(replay.advance(position).reached).toBe(true);
      expect(replay.position()).toEqual(position);
      expect(snap(replay.sim)).toBe(snapshot);
    }
  });

  it('every entry equals the live snapshot recorded right after it (advanceToEntry)', () => {
    const replay = createReplay(live.journal);
    for (let i = 0; i < live.journal.entries.length; i++) {
      const r = replay.advanceToEntry(i);
      expect(r.reached).toBe(true);
      expect(replay.applied).toBe(i + 1);
      expect(replay.position()).toEqual(live.journal.entries[i]!.at);
      const expected = live.afterEntry[i];
      if (expected !== undefined) expect(snap(replay.sim)).toBe(expected);
    }
    expect(live.afterEntry.filter((s) => s !== undefined).length).toBeGreaterThan(8);
    // already in: reached at once
    expect(replay.advanceToEntry(0)).toEqual({ events: 0, entries: 0, reached: true });
    expect(() => replay.advanceToEntry(live.journal.entries.length)).toThrow(RangeError);
    // and a fresh one in chunks, to the last entry that has a snapshot of its own
    const index = live.afterEntry.length - 1;
    expect(live.afterEntry[index]).toBeDefined();
    const chunked = createReplay(live.journal);
    let n = 0;
    while (!chunked.advanceToEntry(index, { maxEvents: 40 }).reached) if (++n > 100_000) throw new Error('never');
    expect(chunked.applied).toBe(index + 1);
    expect(snap(chunked.sim)).toBe(live.afterEntry[index]);
  });

  it('advances in chunks (maxEvents) to the same state, reporting progress', () => {
    const replay = createReplay(live.journal);
    const target = live.sim.position();
    let total = 0;
    let calls = 0;
    for (;;) {
      const r = replay.advance(target, { maxEvents: 37 });
      total += r.events;
      calls++;
      expect(r.events).toBeLessThanOrEqual(37);
      if (r.reached) break;
      if (calls > 100_000) throw new Error('never reached');
    }
    expect(total).toBe(target.dispatched);
    expect(calls).toBeGreaterThan(1);
    expect(snap(replay.sim)).toBe(snap(live.sim));
    // a further call is a no-op
    expect(replay.advance(target, { maxEvents: 5 })).toEqual({ events: 0, entries: 0, reached: true });
  });

  it('two replays interleaved in one realm stay identical', () => {
    const a = createReplay(live.journal);
    const b = createReplay(live.journal);
    const target = live.sim.position();
    let doneA = false;
    let doneB = false;
    while (!doneA || !doneB) {
      if (!doneA) doneA = a.advance(target, { maxEvents: 50 }).reached;
      if (!doneB) doneB = b.advance(target, { maxEvents: 120 }).reached;
    }
    expect(snap(a.sim)).toBe(snap(live.sim));
    expect(snap(b.sim)).toBe(snap(live.sim));
  });

  it('an event count alone is a target too: the clock ends at the last dispatched event', () => {
    // the position after step 1 (a plain runFor): no input shares it
    const target = live.after[1]!.position;
    const replay = createReplay(live.journal);
    const r = replay.advance({ dispatched: target.dispatched });
    expect(r.reached).toBe(true);
    expect(replay.position().dispatched).toBe(target.dispatched);
    expect(replay.position().now).toBeLessThanOrEqual(target.now);
    expect(replay.position().now).toBeGreaterThan(0);
    // then the exact position
    expect(replay.advance(target).reached).toBe(true);
    expect(replay.position()).toEqual(target);
    expect(snap(replay.sim)).toBe(live.after[1]!.snapshot);
    // a count between inputs at one position applies every input recorded at that count
    const end = live.sim.position();
    const whole = createReplay(live.journal);
    expect(whole.advance({ dispatched: end.dispatched }).reached).toBe(true);
    expect(whole.applied).toBe(live.journal.entries.length);
    expect(whole.advance(end).reached).toBe(true);
    expect(snap(whole.sim)).toBe(snap(live.sim));
  });

  it('extend appends the entries recorded after the replay was built', () => {
    const fresh = createSimulation({ seed: 11 });
    const steps = script();
    for (const step of steps.slice(0, 8)) step(fresh);
    const replay = createReplay(fresh.journal());
    for (const step of steps.slice(8)) step(fresh);
    replay.extend(fresh.journal().entries);
    expect(replay.entries).toHaveLength(fresh.journal().entries.length);
    expect(replay.advance(fresh.position()).reached).toBe(true);
    expect(snap(replay.sim)).toBe(snap(fresh));
    expect(snap(fresh)).toBe(snap(live.sim));
  });

  it('a replay only moves forward', () => {
    const replay = createReplay(live.journal);
    replay.advance(live.after[5]!.position);
    expect(() => replay.advance(live.after[2]!.position)).toThrow(RangeError);
    expect(() => replay.advance({ dispatched: -1 })).toThrow(RangeError);
    expect(() => replay.advance(live.after[6]!.position, { maxEvents: 1.5 })).toThrow(RangeError);
  });

  it('a tampered journal is a divergence at the entry where the heads differ', () => {
    const broken: SimJournal = structuredClone(live.journal);
    const entries = broken.entries as unknown as { traceHead: number }[];
    entries[3]!.traceHead += 1;
    const replay = createReplay(broken);
    let err: unknown;
    try {
      replay.advance(live.sim.position());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ReplayDivergenceError);
    const d = err as ReplayDivergenceError;
    expect(d.entry).toBe(3);
    expect(d.expectedHead).toBe(live.journal.entries[3]!.traceHead + 1);
    expect(d.actualHead).toBe(live.journal.entries[3]!.traceHead);
    expect(d.message).toContain('journal entry 3');
    expect(replay.applied).toBe(3);
  });

  it('a journal that claims more events than the world has is exhausted, not looped', () => {
    const replay = createReplay(live.journal);
    const end = live.sim.position();
    expect(() => replay.advance({ dispatched: end.dispatched + 10_000, now: end.now })).toThrow(ReplayExhaustedError);
  });
});

describe('seek targets', () => {
  const live = runScript(23);

  it('{position} is advance', () => {
    const replay = createReplay(live.journal);
    const point = completePositions(live)[7]!;
    expect(replay.advanceTo({ position: point.position }).reached).toBe(true);
    expect(snap(replay.sim)).toBe(point.snapshot);
  });

  it('{time} is the world after runUntil(t) and the inputs recorded at t', () => {
    // step 5 ends with runUntil(T_INPUTS); step 6 records the console inputs at T_INPUTS; step 7 runs on. The state
    // at T_INPUTS with every input at T_INPUTS applied is the snapshot after step 6.
    const at = live.after[6]!;
    expect(at.position.now).toBe(T_INPUTS);
    const replay = createReplay(live.journal);
    const r = replay.advanceTo({ time: T_INPUTS }, { bound: live.sim.position() });
    expect(r.reached).toBe(true);
    expect(replay.position()).toEqual(at.position);
    expect(snap(replay.sim)).toBe(at.snapshot);
    // a time with no input: the state after runFor(25 s) (step 1)
    const quiet = createReplay(live.journal);
    expect(quiet.advanceTo({ time: 25 * SEC }).reached).toBe(true);
    expect(quiet.position()).toEqual(live.after[1]!.position);
    expect(snap(quiet.sim)).toBe(live.after[1]!.snapshot);
    // a time beyond the bound stops at the bound
    const far = createReplay(live.journal);
    const stop = far.advanceTo({ time: live.sim.now + 1000 * SEC }, { bound: live.sim.position() });
    expect(stop.reached).toBe(false);
    expect(far.position()).toEqual(live.sim.position());
    expect(snap(far.sim)).toBe(snap(live.sim));
    // chunked
    const chunked = createReplay(live.journal);
    let n = 0;
    while (!chunked.advanceTo({ time: T_INPUTS }, { bound: live.sim.position(), maxEvents: 25 }).reached) if (++n > 100_000) throw new Error('never');
    expect(snap(chunked.sim)).toBe(at.snapshot);
  });

  it('{cursor} is the state right after the dispatch that emitted the event', () => {
    // record, in a fresh live run, the position of the dispatch that emits the tenth tableWrite of the boot
    const cap = createSimulation({ seed: 23, traceCapacity: DEFAULT_TRACE_CAPACITY });
    let cursor = -1;
    let seen = 0;
    let at: JournalPosition | undefined;
    cap.onTrace((e) => {
      if (at === undefined && e.kind === 'tableWrite' && ++seen === 10) {
        cursor = head(cap) - 1;
        at = cap.position();
      }
    });
    for (const step of script()) step(cap);
    expect(cursor).toBeGreaterThan(0);
    expect(at).toBeDefined();
    const journal = cap.journal();
    const events = cap.trace(0).events;
    const replay = createReplay(journal, { traceCapacity: DEFAULT_TRACE_CAPACITY });
    const r = replay.advanceTo({ cursor }, { bound: cap.position() });
    expect(r.reached).toBe(true);
    expect(head(replay.sim)).toBeGreaterThan(cursor);
    expect(replay.sim.traceQuery({ from: cursor, limit: 1 }).events[0]!.event).toEqual(events[cursor]);
    // exactly the dispatch that emitted it: the same position as the live listener saw
    expect(replay.position()).toEqual(at);
    const twin = createReplay(journal);
    twin.advance(at!);
    expect(snap(replay.sim)).toBe(snap(twin.sim));
    // a cursor already behind the replay is reached at once; one beyond the bound is not
    expect(replay.advanceTo({ cursor: cursor - 5 }, { bound: cap.position() })).toEqual({ events: 0, entries: 0, reached: true });
    const beyond = createReplay(journal);
    expect(beyond.advanceTo({ cursor: head(cap) + 100 }, { bound: cap.position() }).reached).toBe(false);
    expect(beyond.position()).toEqual(cap.position());
    expect(() => beyond.advanceTo({ cursor: -1 })).toThrow(RangeError);
    // a cursor emitted by an input (a configChange) lands right after that entry
    const cfg = events.findIndex((e) => e.kind === 'configChange' && e.device === 'sw1' && e.line.startsWith('hostname Core'));
    expect(cfg).toBeGreaterThan(0);
    const byInput = createReplay(journal);
    expect(byInput.advanceTo({ cursor: cfg }, { bound: cap.position() }).reached).toBe(true);
    const entry = journal.entries.findIndex((e) => e.op.op === 'configure');
    expect(byInput.applied).toBe(entry + 1);
    const chunked = createReplay(journal);
    let n = 0;
    while (!chunked.advanceTo({ cursor: cfg }, { bound: cap.position(), maxEvents: 33 }).reached) if (++n > 100_000) throw new Error('never');
    expect(snap(chunked.sim)).toBe(snap(byInput.sim));
  });
});

describe('origin worlds', () => {
  it('a journal from nothing replays a world built by API calls', () => {
    const live = createSimulation({ seed: 4 });
    const a = live.addDevice({ type: 'pc.nfpc' });
    const b = live.addDevice({ type: 'pc.nfpc' });
    live.addLink({ a: { device: a, port: 'gi0' }, b: { device: b, port: 'gi0' } });
    live.configure(a, ['ip address 10.0.0.1 255.255.255.0']);
    live.configure(b, ['ip address 10.0.0.2 255.255.255.0']);
    live.runFor(20 * SEC);
    const s = live.cli.open(a, 'console');
    live.cli.exec(s, 'ping 10.0.0.2');
    live.runToIdle();
    expect(live.journal().origin.topology).toBeNull();
    const replay = replayJournal(live.journal(), live.position(), { traceCapacity: DEFAULT_TRACE_CAPACITY });
    expect(JSON.stringify(replay.trace(0).events)).toBe(JSON.stringify(live.trace(0).events));
    expect(snap(replay)).toBe(snap(live));
  });

  it('a journal started by a load after earlier work resumes the counters of that moment', () => {
    const live = createSimulation({ seed: 8 });
    live.loadTopology(pcRouterPc());
    live.runFor(50 * SEC);
    live.hostRequest('pc1', { app: 'dhcp.renew', port: 'GigabitEthernet0' });
    live.runFor(SEC);
    const beforeHead = head(live);
    live.loadTopology(twoPcsAndSwitch());
    live.runFor(40 * SEC);
    const s = live.cli.open('pc1', 'console');
    live.cli.exec(s, 'ping 10.0.0.2');
    live.runToIdle();
    live.hostRequest('pc1', { app: 'dhcp.renew', port: 'GigabitEthernet0' });
    const journal = live.journal();
    expect(journal.origin.counters.traceHead).toBe(beforeHead);
    expect(journal.origin.counters.requests).toBe(1);
    expect(journal.origin.counters.topologyVersion).toBeGreaterThan(0);
    const replay = createReplay(journal, { traceCapacity: DEFAULT_TRACE_CAPACITY });
    expect(replay.sim.trace(0).dropped).toBe(beforeHead);
    replay.advance(live.position());
    expect(traceFrom(replay.sim, beforeHead)).toBe(traceFrom(live, beforeHead));
    expect(snap(replay.sim)).toBe(snap(live));
    // the origin world alone equals the live world right after its load
    const fresh = createSimulation({ seed: 8 });
    fresh.loadTopology(pcRouterPc());
    fresh.runFor(50 * SEC);
    fresh.hostRequest('pc1', { app: 'dhcp.renew', port: 'GigabitEthernet0' });
    fresh.runFor(SEC);
    fresh.loadTopology(twoPcsAndSwitch());
    expect(snap(createOriginSimulation(journal.origin))).toBe(snap(fresh));
  });

  it('a journal started by a load after consoles were opened resumes the session counters: replayed session ids match', () => {
    const live = createSimulation({ seed: 5 });
    live.loadTopology(pcRouterPc());
    live.runFor(60 * SEC);
    const first = live.cli.open('pc1', 'console');
    expect(first).toBe('s_1');
    live.cli.exec(first, 'ping 10.0.1.1');
    live.runToIdle();
    live.configure('r1', ['hostname Edge']);
    const beforeHead = head(live);
    // File → Open on the same world: sessions die with the old world but the counters keep counting
    live.loadTopology(twoPcsAndSwitch());
    live.runFor(40 * SEC);
    const second = live.cli.open('pc1', 'console');
    expect(second).toBe('s_2');
    live.cli.exec(second, 'ping 10.0.0.2');
    live.runToIdle();
    live.configure('sw1', ['hostname Access']);
    const journal = live.journal();
    expect(journal.origin.counters).toMatchObject({ traceHead: beforeHead, sessions: 1, headless: 1 });
    expect(journal.entries.map((e) => e.op.op)).toEqual(['cliOpen', 'cliExec', 'configure']);
    const replay = createReplay(journal, { traceCapacity: DEFAULT_TRACE_CAPACITY });
    replay.advance(live.position());
    expect(replay.sim.cli.sessions().map((s) => s.id)).toEqual(['s_2']);
    expect(replay.sim.cli.sessions().map((s) => s.id)).toEqual(live.cli.sessions().map((s) => s.id));
    expect(traceFrom(replay.sim, beforeHead)).toBe(traceFrom(live, beforeHead));
    expect(snap(replay.sim)).toBe(snap(live));
    // the counters the replay reports are the live ones
    expect(replay.sim.journal().origin.counters).toMatchObject({ sessions: 1, headless: 1 });
  });

  it('replayJournal without a target stops after the last entry', () => {
    const live = createSimulation({ seed: 9 });
    live.loadTopology(twoPcsAndSwitch());
    live.runFor(40 * SEC);
    live.moveDevice('pc1', { x: 1, y: 1 });
    const lastAt = live.position();
    live.runFor(10 * SEC);
    const replay = replayJournal(live.journal());
    expect(replay.position()).toEqual(lastAt);
    expect(replayJournal(createSimulation({ seed: 9 }).journal()).position()).toEqual({ dispatched: 0, now: 0 });
  });
});
