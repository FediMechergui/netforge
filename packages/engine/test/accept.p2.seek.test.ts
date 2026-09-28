/**
 * P2 acceptance [SHOULD S1] — seeking into the past (ARCHITECTURE-P2 D18, §2.13, §3.13 steps 2–6, §10.1 row
 * `accept.p2.seek`), the ENGINE half.
 *
 * The row names two kinds of behaviour, and each is tested where it lives:
 *   • here, over the engine's journal and `Replay` API (sim/replay.ts), which every seek is made of: 50 seeded
 *     targets (sim times, trace cursors and journal positions), visited forward and backward, each served the §3.13
 *     way — the cursor replay when the target is in its future, else the parked replayer with the largest position at
 *     or before it, else a fresh replay from the origin — advanced in cooperative chunks under the live bound, and
 *     compared with a FRESH replay of the journal advanced to the same target in one call (position, trace head and
 *     snapshot JSON byte for byte); every seek dispatches exactly `target.dispatched − p` events for the replayer it
 *     started from (§3.13 step 6); from steady state (every parked replayer exactly at `head − lag`) a target inside
 *     the parked window costs at most the largest lag gap, and an older target costs exactly `target.dispatched`;
 *     and the live world is never perturbed by any of it (the engine side of "leaving review returns the pre-review
 *     live snapshot": journal, position, trace and snapshot unchanged);
 *   • in apps/web/test/worker.time-machine.seek.test.ts, over the worker's time machine (bridge/worker/time-machine.ts)
 *     and its API (bridge/worker/index.ts), because review, the read-only rule and the parked slots exist only there:
 *     the same 50-target walk through the real time machine and its slots, every mutating API call rejected in review
 *     with `REPLAY_READ_ONLY_MESSAGE`, and leaving review returning the pre-review live snapshot.
 *
 * The world is a CCNA 2 lab with address translation (`ccna2-nat-pat`: two routers, a switch running spanning tree,
 * hosts and servers) loaded as the worker loads it, driven by a seeded input script with inputs at many positions
 * (solution, pings through the translator, a breakpoint stop, single steps, a capped run, a cut, a move, a power
 * cycle, runToIdle). Lags are scaled to the world (a twelfth, a fifth and a half of its events): the §3.13 rule does
 * not depend on their values, and the default budget's lags are longer than a CCNA-sized world of this length.
 * Chunk sizes are small primes, so chunk edges fall between inputs and inside dispatch sequences.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId, SessionId } from '../src/contracts/ids.js';
import type { JournalPosition, SeekTarget, SimJournal } from '../src/contracts/journal.js';
import type { ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { Topology } from '../src/contracts/topology.js';
import { comparePositions } from '../src/sim/journal.js';
import { createReplay, type Replay } from '../src/sim/replay.js';
import { SCENARIOS } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';

/** The world of this file. */
const WORLD = 'ccna2-nat-pat';
/** §10.1: 50 seeded targets. */
const TARGETS = 50;
/** Seed of the target walk and of the script's choices (the world runs on the lab's own seed). */
const WALK_SEED = 0x5eec;
/** Events one seek chunk may dispatch (a worker yields between chunks). */
const SEEK_CHUNK = 257;
/** Events a parked replayer may dispatch per background step (§3.13 step 2 uses about 500). */
const PARK_CHUNK = 499;
/** Wall-clock budget of the walk (one live run, 50 seeks, 50 fresh replays, the parked refills). */
const WALK_TIMEOUT_MS = 180_000;

/** A small deterministic PRNG (mulberry32): the seeded choices of this file (no Math.random). */
function prng(seed: number): { int(n: number): number; chance(p: number): boolean; pick<T>(xs: readonly T[]): T } {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  return {
    int: (n) => (n <= 0 ? 0 : next() % n),
    chance: (p) => next() / 0x1_0000_0000 < p,
    pick: <T>(xs: readonly T[]): T => {
      if (xs.length === 0) throw new Error('nothing to pick from');
      return xs[next() % xs.length] as T;
    },
  };
}

const snap = (sim: Simulation): string => JSON.stringify(sim.snapshot());
const head = (sim: Simulation): number => sim.traceQuery({ from: 0, limit: 0 }).head;

function idOf(sim: Simulation, name: string): DeviceId {
  for (const d of sim.devices()) if (d.spec.name === name) return d.id;
  throw new Error(`no device called ${name} in this world`);
}

/** The IPv4 address of the first addressed port of `name`. */
function addressOf(sim: Simulation, name: string): string {
  for (const p of sim.device(idOf(sim, name))?.ports.values() ?? []) if (p.l3.ipv4 !== undefined) return p.l3.ipv4.address;
  throw new Error(`${name} has no IPv4 address`);
}

/** The lab's world as the worker's `loadScenario` builds it (lab seed, lab stamp, scheduled faults). */
function loadLab(sc: ScenarioInfo): Simulation {
  const sim = createSimulation({ seed: sc.seed ?? 1, traceCapacity: 500_000 });
  const topo: Topology = (sc.tasks?.length ?? 0) > 0 ? { ...sc.build(), lab: { name: sc.name, version: sc.version ?? 1 } } : sc.build();
  sim.loadTopology(topo);
  for (const f of sc.faults ?? []) sim.injectFault(f.at, f.fault);
  return sim;
}

/** The seeded live script; returns the world and positions it passed through (every run end and every input). */
function liveWorld(): { sim: Simulation; positions: JournalPosition[] } {
  const sc = SCENARIOS.find((s) => s.name === WORLD);
  if (sc === undefined) throw new Error(`${WORLD} is not in SCENARIOS`);
  const pick = prng(WALK_SEED);
  const sim = loadLab(sc);
  const positions: JournalPosition[] = [];
  const mark = (): void => void positions.push(sim.position());

  sim.runFor(40 * SEC, { stopOn: { kinds: ['linkState'] } });
  mark();
  for (let i = 0; i < 3; i++) sim.step();
  mark();
  sim.stepToNext({ kinds: ['tableWrite'] }, { until: sim.now + 5 * SEC });
  mark();
  sim.runUntil(60 * SEC);
  mark();
  for (const [name, lines] of Object.entries(sc.solution ?? {})) {
    sim.configure(idOf(sim, name), lines);
    mark();
    sim.runFor(SEC + pick.int(SEC));
    mark();
  }
  sim.runFor(10 * SEC);
  mark();
  // two inside hosts ping the outside server at once (address and port translation), a third a little later
  const ext = addressOf(sim, 'EXT');
  const sessions: SessionId[] = [];
  for (const host of ['PC1', 'PC2']) {
    const s = sim.cli.open(idOf(sim, host), 'console');
    sim.cli.exec(s, `ping ${ext}`);
    sessions.push(s);
    mark();
  }
  sim.runFor(3 * SEC, { stopOn: { kinds: ['tableWrite'], tables: ['nat'] } });
  mark();
  sim.runFor(2 * SEC, { maxEvents: 11 + pick.int(20) });
  mark();
  const s3 = sim.cli.open(idOf(sim, 'PC3'), 'console');
  sim.cli.exec(s3, `ping ${ext}`);
  mark();
  sim.runFor(15 * SEC);
  mark();
  // a cut (restored by itself), a move, a power cycle
  const links = sim.snapshot().links.map((l) => l.id);
  sim.injectFault(sim.now + SEC, { id: 'seek-cut', kind: 'cable-cut', target: { link: pick.pick(links) }, params: { durationNs: 4 * SEC } });
  mark();
  sim.moveDevice(idOf(sim, 'PC2'), { x: 100 + pick.int(300), y: 100 + pick.int(300) });
  mark();
  sim.runFor(10 * SEC);
  mark();
  const cycled = idOf(sim, pick.pick(['SW1', 'PC1', 'WEB']));
  sim.setPower(cycled, false);
  mark();
  sim.runFor(3 * SEC);
  mark();
  sim.setPower(cycled, true);
  mark();
  sim.runFor(20 * SEC, { stopOn: { kinds: ['linkState'] } });
  mark();
  sim.cli.exec(sessions[0] as SessionId, 'show arp');
  mark();
  sim.runToIdle();
  mark();
  sim.runFor(60 * SEC);
  mark();
  const r1 = sim.cli.open(idOf(sim, 'R1'), 'console');
  sim.cli.exec(r1, 'show ip nat translations');
  mark();
  sim.runFor(90 * SEC);
  mark();
  return { sim, positions };
}

/** Everything a seek must leave alone in the live world. */
function fingerprint(sim: Simulation): { journal: string; position: JournalPosition; head: number; snapshot: string; trace: string } {
  return {
    journal: JSON.stringify(sim.journal()),
    position: sim.position(),
    head: head(sim),
    snapshot: snap(sim),
    trace: JSON.stringify(sim.trace(0).events),
  };
}

/** True when replay `r` can still reach `target` moving forward (§3.13 step 3). */
function eligible(r: Replay, target: SeekTarget): boolean {
  if ('position' in target) return comparePositions(r.position(), target.position) <= 0;
  if ('time' in target) return r.position().now <= target.time;
  return head(r.sim) <= target.cursor;
}

/** Where a seek started from: the cursor replay, a parked slot, or the origin. */
type Source = { readonly kind: 'cursor' } | { readonly kind: 'slot'; readonly slot: number } | { readonly kind: 'origin' };

/**
 * The §3.13 seek over the engine API: `slots` parked at `head − lags[i]` (kept in steady state: a slot the cursor
 * takes is refilled at once, from the origin, exactly at its target), one cursor replay.
 */
function createSeeker(journal: SimJournal, live: JournalPosition, lags: readonly number[]) {
  const targetOf = (i: number): number => Math.max(0, live.dispatched - (lags[i] as number));
  const park = (i: number): Replay => {
    const r = createReplay(journal);
    let n = 0;
    while (!r.advance({ dispatched: targetOf(i) }, { maxEvents: PARK_CHUNK }).reached) if (++n > 1_000_000) throw new Error('never parked');
    return r;
  };
  const slots: Replay[] = lags.map((_, i) => park(i));
  let cursor: Replay | undefined;

  return {
    slots: (): readonly Replay[] => slots,
    targetOf,
    steady: (): boolean => slots.every((r, i) => r.position().dispatched === targetOf(i)),
    seek(target: SeekTarget): { source: Source; p: JournalPosition; events: number; reached: boolean; replay: Replay } {
      let source: Source;
      let replay: Replay;
      if (cursor !== undefined && eligible(cursor, target)) {
        source = { kind: 'cursor' };
        replay = cursor;
      } else {
        let best = -1;
        for (let i = 0; i < slots.length; i++) {
          const r = slots[i] as Replay;
          if (eligible(r, target) && (best < 0 || comparePositions(r.position(), (slots[best] as Replay).position()) > 0)) best = i;
        }
        if (best >= 0) {
          source = { kind: 'slot', slot: best };
          replay = slots[best] as Replay;
        } else {
          source = { kind: 'origin' };
          replay = createReplay(journal);
        }
      }
      const p = replay.position();
      let events = 0;
      let reached = false;
      for (let guard = 0; ; guard++) {
        const r = replay.advanceTo(target, { maxEvents: SEEK_CHUNK, bound: live });
        events += r.events;
        reached = r.reached;
        if (r.reached || (r.events === 0 && r.entries === 0)) break;
        if (guard > 1_000_000) throw new Error('the seek never ended');
      }
      // the replay is the cursor now; a slot it came from is refilled exactly at its target (steady state)
      if (source.kind === 'slot') slots[source.slot] = park(source.slot);
      cursor = replay;
      return { source, p, events, reached, replay };
    },
  };
}

/** A fresh replay of the journal advanced to `target` in one call: the reference of every seek. */
function fresh(journal: SimJournal, target: SeekTarget, live: JournalPosition): { sim: Simulation; reached: boolean } {
  const r = createReplay(journal);
  const res = r.advanceTo(target, { bound: live });
  return { sim: r.sim, reached: res.reached };
}

describe('accept.p2.seek (engine): 50 seeded targets over the journal and replay API', () => {
  it(
    'every seek equals a fresh replay, costs exactly target.dispatched − p, and in steady state at most the largest lag gap',
    () => {
      const { sim: live, positions } = liveWorld();
      const before = fingerprint(live);
      const journal = live.journal();
      const end = live.position();
      const D = end.dispatched;
      const originHead = journal.origin.counters.traceHead;
      const liveHead = head(live);
      expect(D).toBeGreaterThan(1_000);
      expect(journal.entries.length).toBeGreaterThan(12);
      expect(live.trace(originHead).dropped).toBe(0);

      const lags = [Math.floor(D / 12), Math.floor(D / 5), Math.floor(D / 2)];
      const gap = Math.max(lags[0] as number, (lags[1] as number) - (lags[0] as number), (lags[2] as number) - (lags[1] as number));
      const seeker = createSeeker(journal, end, lags);
      expect(seeker.steady()).toBe(true);
      const oldestParked = (): JournalPosition => (seeker.slots()[2] as Replay).position();
      /** Where the parked window starts (the oldest parked replayer: steady, so it never moves). */
      const windowStart = oldestParked();
      const windowHead = head((seeker.slots()[2] as Replay).sim);

      // positions worth aiming at: every input's and every run end's (a seek to an input's position lands after it)
      const aims = [...positions, ...journal.entries.map((e) => e.at)];
      const pick = prng(WALK_SEED ^ 0x7a3);
      const tally = { time: 0, cursor: 0, position: 0, forward: 0, backward: 0, fromCursor: 0, fromSlot: 0, fromOrigin: 0, inWindow: 0, older: 0, pastLive: 0 };
      let previous: JournalPosition | undefined;

      for (let k = 0; k < TARGETS; k++) {
        // a seeded target: a sim time, a trace cursor or a journal position — half of them inside the parked window,
        // the others anywhere since the origin, and now and then one past the live world
        const inside = pick.chance(0.5);
        const fromNow = inside ? windowStart.now : 0;
        const fromHead = inside ? windowHead : originHead;
        const roll = pick.int(10);
        let target: SeekTarget;
        if (roll < 4) {
          target = { time: pick.chance(0.06) ? end.now + (1 + pick.int(9)) * SEC : fromNow + pick.int(end.now - fromNow + 1) };
          tally.time++;
        } else if (roll < 7) {
          target = { cursor: pick.chance(0.06) ? liveHead + pick.int(50) : fromHead + pick.int(liveHead - fromHead) };
          tally.cursor++;
        } else {
          target = { position: pick.pick(inside ? aims.filter((a) => comparePositions(a, windowStart) >= 0) : aims) };
          tally.position++;
        }
        const steadyBefore = seeker.steady();
        const window = oldestParked();
        const r = seeker.seek(target);
        const at = r.replay.position();
        const reference = fresh(journal, target, end);

        // equal to a fresh replay: position, trace head, snapshot JSON
        const what = `target ${k} ${JSON.stringify(target)} from ${JSON.stringify(r.source)}`;
        expect(r.reached, what).toBe(reference.reached);
        expect(at, what).toEqual(reference.sim.position());
        expect(head(r.replay.sim), what).toBe(head(reference.sim));
        expect(snap(r.replay.sim) === snap(reference.sim), `${what}: snapshot equals a fresh replay`).toBe(true);
        expect(comparePositions(at, end), what).toBeLessThanOrEqual(0);
        if (!r.reached) {
          // only a target beyond the present stops short, at the present
          expect(at, what).toEqual(end);
          tally.pastLive++;
        }

        // §3.13 step 6: exactly target.dispatched − p for the replayer it started from
        expect(r.events, what).toBe(at.dispatched - r.p.dispatched);
        if (r.source.kind === 'origin') {
          expect(r.p.dispatched, what).toBe(0);
          expect(r.events, `${what}: an older target costs exactly target.dispatched`).toBe(at.dispatched);
          // older than every parked replayer: none could reach it
          for (const s of seeker.slots()) expect(eligible(s, target), what).toBe(false);
          tally.fromOrigin++;
          tally.older++;
        } else if (r.source.kind === 'slot') {
          expect(steadyBefore, what).toBe(true);
          expect(comparePositions(at, window), `${what} is inside the parked window`).toBeGreaterThanOrEqual(0);
          expect(r.events, `${what}: at most the largest lag gap (${gap})`).toBeLessThanOrEqual(gap);
          tally.fromSlot++;
          tally.inWindow++;
        } else {
          tally.fromCursor++;
        }
        if (previous !== undefined) {
          const dir = comparePositions(at, previous);
          if (dir > 0) tally.forward++;
          if (dir < 0) tally.backward++;
        }
        previous = at;
      }

      // the walk really went both ways and used every kind of target and source
      expect(tally.time + tally.cursor + tally.position).toBe(TARGETS);
      expect(tally.time).toBeGreaterThanOrEqual(10);
      expect(tally.cursor).toBeGreaterThanOrEqual(10);
      expect(tally.position).toBeGreaterThanOrEqual(10);
      expect(tally.forward).toBeGreaterThanOrEqual(10);
      expect(tally.backward).toBeGreaterThanOrEqual(10);
      expect(tally.fromCursor).toBeGreaterThanOrEqual(5);
      expect(tally.fromSlot).toBeGreaterThanOrEqual(5);
      expect(tally.fromOrigin).toBeGreaterThanOrEqual(5);
      expect(tally.pastLive).toBeGreaterThanOrEqual(1);

      // the live world was never perturbed: the pre-review snapshot is still the live one
      expect(fingerprint(live)).toEqual(before);
    },
    WALK_TIMEOUT_MS,
  );
});
