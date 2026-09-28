/**
 * P2 acceptance [SHOULD S1] — seeking into the past, the WORKER half of the §10.1 row `accept.p2.seek`
 * (ARCHITECTURE-P2 D18, §2.13, §2.14, §3.13 steps 3–6). The engine half — the same walk over the journal and
 * `Replay` API alone — is packages/engine/test/accept.p2.seek.test.ts; review, the read-only rule and the parked slots
 * exist only in the worker (bridge/worker/time-machine.ts, bridge/worker/index.ts), so they are tested here.
 *
 *   1. The time machine over a real live world (the `ccna2-nat-pat` lab loaded as the worker loads it, a seeded
 *      input script): 50 seeded targets — sim times, trace cursors and journal positions, now and then one past the
 *      present — in ten rounds of five, forward and backward. Every seek:
 *        • equals a FRESH replay of the live journal advanced to the same target in one call (position and snapshot
 *          JSON byte for byte);
 *        • started from the replayer §3.13 step 6 names — the cursor replay when the target is in its future, else the
 *          parked replayer with the largest position at or before the target, else a new replay from the origin —
 *          and dispatched exactly `target.dispatched − p`, p being the position that replayer had before the seek
 *          (the replayer is identified by identity: `createReplay` is wrapped to record every replay the time machine
 *          builds, nothing else about it changes);
 *        • in steady state (every slot holds a replayer exactly at `head − lag`) cost at most the largest lag gap when
 *          the target is inside the parked window, and exactly `target.dispatched` when it is older.
 *      Even rounds start from steady state (history off and on again, then one background tick parks every slot);
 *      odd rounds keep the lifecycle as the previous round left it (re-parked replayers ahead of their targets).
 *      Leaving review at the end of each round leaves the live world byte-identical (journal, position, trace,
 *      snapshot). Lags are scaled to the world (a twelfth, a fifth and a half of its events); the rule does not
 *      depend on their values, and the default lags are longer than this world.
 *   2. The worker API, Comlink mocked as in worker.time-machine.test.ts: every method of the API is classified, so a
 *      method added later must be classified before this passes; in review every MUTATOR rejects with exactly
 *      `REPLAY_READ_ONLY_MESSAGE` and changes nothing (live trace head and topology unchanged, no live batch posted),
 *      while reads, settings and the review drivers still answer; leaving review — by `leaveReview`, and by running
 *      the review to the present — returns the pre-review live snapshot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPLAY_READ_ONLY_MESSAGE, SCENARIOS, comparePositions, createReplay, createSimulation } from '@netforge/engine';
import type { DeviceId, JournalPosition, LinkId, Replay, ScenarioInfo, SeekTarget, SessionId, SimJournal, Simulation, Topology } from '@netforge/engine';
import type { EngineApi, EngineBatch } from '../src/bridge/protocol';
import { createTimeMachine, type TimeMachine } from '../src/bridge/worker/time-machine';

const SEC = 1_000_000_000;

/** Every replay built through `createReplay` while `on` is set, in creation order (the time machine's, not ours). */
const tracking = vi.hoisted(() => ({ on: true, replays: [] as unknown[] }));

vi.mock('@netforge/engine', async (importOriginal) => {
  const engine = await importOriginal<typeof import('@netforge/engine')>();
  return {
    ...engine,
    createReplay: (...args: Parameters<typeof engine.createReplay>) => {
      const r = engine.createReplay(...args);
      if (tracking.on) tracking.replays.push(r);
      return r;
    },
  };
});

let exposed: EngineApi | undefined;

vi.mock('comlink', () => ({
  expose: (api: EngineApi) => {
    exposed = api;
  },
  proxy: <T>(x: T) => x,
  transfer: <T>(x: T) => x,
}));

/** The world of this file (the engine half uses the same lab). */
const WORLD = 'ccna2-nat-pat';
/** §10.1: 50 seeded targets. */
const ROUNDS = 10;
const SEEKS_PER_ROUND = 5;
/** Seed of the walk (no Math.random). */
const WALK_SEED = 0x71ae;

/** A small deterministic PRNG (mulberry32). */
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

const snapOf = (sim: Simulation): string => JSON.stringify(sim.snapshot());
const headOf = (sim: Simulation): number => sim.traceQuery({ from: 0, limit: 0 }).head;

function lab(): ScenarioInfo {
  const sc = SCENARIOS.find((s) => s.name === WORLD);
  if (sc === undefined) throw new Error(`${WORLD} is not in SCENARIOS`);
  return sc;
}

function labTopology(sc: ScenarioInfo): Topology {
  const topo = sc.build();
  return (sc.tasks?.length ?? 0) > 0 ? { ...topo, lab: { name: sc.name, version: sc.version ?? 1 } } : topo;
}

function idOf(sim: Simulation, name: string): DeviceId {
  for (const d of sim.devices()) if (d.spec.name === name) return d.id;
  throw new Error(`no device called ${name}`);
}

function addressOf(sim: Simulation, name: string): string {
  for (const p of sim.device(idOf(sim, name))?.ports.values() ?? []) if (p.l3.ipv4 !== undefined) return p.l3.ipv4.address;
  throw new Error(`${name} has no IPv4 address`);
}

/** The live world: the lab as the worker loads it, then a seeded script with inputs at many positions. */
function liveWorld(): { sim: Simulation; positions: JournalPosition[] } {
  const sc = lab();
  const pick = prng(WALK_SEED);
  const sim = createSimulation({ seed: sc.seed ?? 1, traceCapacity: 500_000 });
  sim.loadTopology(labTopology(sc));
  for (const f of sc.faults ?? []) sim.injectFault(f.at, f.fault);
  const positions: JournalPosition[] = [];
  const mark = (): void => void positions.push(sim.position());
  sim.runFor(40 * SEC, { stopOn: { kinds: ['linkState'] } });
  mark();
  sim.step();
  sim.step();
  mark();
  sim.runUntil(60 * SEC);
  for (const [name, lines] of Object.entries(sc.solution ?? {})) {
    sim.configure(idOf(sim, name), lines);
    mark();
    sim.runFor(SEC + pick.int(SEC));
    mark();
  }
  sim.runFor(10 * SEC);
  const ext = addressOf(sim, 'EXT');
  for (const host of ['PC1', 'PC2']) {
    const s = sim.cli.open(idOf(sim, host), 'console');
    sim.cli.exec(s, `ping ${ext}`);
    mark();
  }
  sim.runFor(3 * SEC, { stopOn: { kinds: ['tableWrite'] } });
  mark();
  sim.runFor(2 * SEC, { maxEvents: 17 });
  mark();
  sim.runFor(12 * SEC);
  mark();
  const links = sim.snapshot().links.map((l) => l.id);
  sim.injectFault(sim.now + SEC, { id: 'seek-cut', kind: 'cable-cut', target: { link: pick.pick(links) }, params: { durationNs: 4 * SEC } });
  mark();
  sim.moveDevice(idOf(sim, 'PC3'), { x: 100 + pick.int(300), y: 100 + pick.int(300) });
  mark();
  sim.runFor(8 * SEC);
  const cycled = idOf(sim, pick.pick(['SW1', 'PC2', 'MAIL']));
  sim.setPower(cycled, false);
  mark();
  sim.runFor(3 * SEC);
  sim.setPower(cycled, true);
  mark();
  sim.runToIdle();
  mark();
  sim.runFor(60 * SEC);
  const r1 = sim.cli.open(idOf(sim, 'R1'), 'console');
  sim.cli.exec(r1, 'show ip nat translations');
  mark();
  sim.runFor(40 * SEC);
  mark();
  return { sim, positions };
}

/** Everything a review must leave alone in the live world. */
function fingerprint(sim: Simulation): { journal: string; position: JournalPosition; head: number; snapshot: string; trace: string } {
  return {
    journal: JSON.stringify(sim.journal()),
    position: sim.position(),
    head: headOf(sim),
    snapshot: snapOf(sim),
    trace: JSON.stringify(sim.trace(0).events),
  };
}

/** A fresh replay of `journal` advanced to `target` in one call (not tracked: it is the reference, not a replayer). */
function fresh(journal: SimJournal, target: SeekTarget, bound: JournalPosition): { sim: Simulation; position: JournalPosition } {
  tracking.on = false;
  try {
    const r = createReplay(journal);
    r.advanceTo(target, { bound });
    return { sim: r.sim, position: r.position() };
  } finally {
    tracking.on = true;
  }
}

/** The tracked replay whose world the review shows (the proxy forwards every member but `trace`). */
function cursorReplay(tm: TimeMachine): Replay | undefined {
  const view = tm.reviewSim;
  if (view === undefined) return undefined;
  return (tracking.replays as Replay[]).find((r) => r.sim.position === view.position);
}

describe('the time machine: 50 seeded targets, forward and backward (§3.13 steps 3–6)', () => {
  it(
    'every seek equals a fresh replay, starts from the replayer step 6 names, costs exactly target.dispatched − p, and in steady state at most the largest lag gap',
    async () => {
      const { sim: live, positions } = liveWorld();
      const before = fingerprint(live);
      const journal = live.journal();
      const end = live.position();
      const D = end.dispatched;
      const originHead = journal.origin.counters.traceHead;
      const liveHead = headOf(live);
      expect(D).toBeGreaterThan(800);
      expect(journal.entries.length).toBeGreaterThan(10);

      const lags = [Math.floor(D / 12), Math.floor(D / 5), Math.floor(D / 2)];
      const gap = Math.max(lags[0] as number, (lags[1] as number) - (lags[0] as number), (lags[2] as number) - (lags[1] as number));
      const tm = createTimeMachine({ sim: () => live }, { budget: { replayers: 3, lagsEvents: lags }, parkChunk: 1_000_000, seekChunk: 211 });
      /** Steady state (§3.13 step 6): every slot holds a replayer exactly at its target (a cursor from the origin may exist). */
      const steadyNow = (): boolean => tm.slots().every((s) => s.position !== null && s.position.dispatched === s.target);
      const restoreSteady = (): void => {
        tm.setBudget({ replayers: 0 });
        tm.setBudget({ replayers: 3 });
        tm.tick();
        expect(steadyNow(), 'one background tick parks every slot at head − lag').toBe(true);
      };
      restoreSteady();
      const windowStart = tm.slots()[2]?.position as JournalPosition;
      // the trace head at the start of the window: a fresh replay parked there
      const windowHead = headOf(fresh(journal, { position: windowStart }, end).sim);
      const aims = [...positions, ...journal.entries.map((e) => e.at)];

      const pick = prng(WALK_SEED ^ 0x3c1);
      const tally = { seeks: 0, forward: 0, backward: 0, fromCursor: 0, fromSlot: 0, fromOrigin: 0, undecided: 0, steadyInWindow: 0, steadyOlder: 0, atLive: 0 };
      let previous: JournalPosition | undefined;

      for (let round = 0; round < ROUNDS; round++) {
        if (round % 2 === 0) restoreSteady();
        else tm.tick(); // re-parked replayers ahead of their targets idle there
        const pre = fingerprint(live);
        for (let k = 0; k < SEEKS_PER_ROUND; k++) {
          // a seeded target, half of them inside the parked window, now and then one past the present
          const inside = pick.chance(0.5);
          const fromNow = inside ? windowStart.now : 0;
          const fromHead = inside ? windowHead : originHead;
          const roll = pick.int(10);
          let target: SeekTarget;
          if (roll < 4) target = { time: pick.chance(0.05) ? end.now + (1 + pick.int(9)) * SEC : fromNow + pick.int(end.now - fromNow + 1) };
          else if (roll < 7) target = { cursor: pick.chance(0.05) ? liveHead + pick.int(40) : fromHead + pick.int(liveHead - fromHead) };
          else target = { position: pick.pick(inside ? aims.filter((a) => comparePositions(a, windowStart) >= 0) : aims) };
          // two targets past the present, whatever the draws: one by time from steady state, one by cursor in review
          if (round === 4 && k === 0) target = { time: end.now + 5 * SEC };
          if (round === 7 && k === 3) target = { cursor: liveHead + 10 };
          const what = `round ${round} seek ${k} ${JSON.stringify(target)}`;

          // what the time machine holds before the seek
          const steady = steadyNow();
          const slotsBefore = tm.slots();
          const prevCursor = cursorReplay(tm);
          const prevFrom = tm.cursor()?.from;
          const prevHead = prevCursor === undefined ? undefined : headOf(prevCursor.sim);
          const known = new Map((tracking.replays as Replay[]).map((r) => [r, r.position()]));
          const reference = fresh(journal, target, end);

          const res = await tm.seek(target);
          tally.seeks++;
          const cursor = tm.cursor();
          const replay = cursorReplay(tm);
          expect(cursor?.ready, what).toBe(true);
          expect(replay, `${what}: the cursor is a replay the time machine built`).toBeDefined();
          const at = (replay as Replay).position();

          // equal to a fresh replay
          expect(at, what).toEqual(reference.position);
          expect(cursor?.position, what).toEqual(reference.position);
          expect(snapOf(tm.reviewSim as Simulation) === snapOf(reference.sim), `${what}: the reviewed world equals a fresh replay`).toBe(true);
          expect(res.atLive, what).toBe(comparePositions(at, end) >= 0);
          if (res.atLive) tally.atLive++;

          // §3.13 step 6: exactly target.dispatched − p for the replayer it started from
          const p = known.get(replay as Replay) ?? { dispatched: 0, now: 0 };
          expect(res.replayedEvents, `${what}: cost from p=${JSON.stringify(p)}`).toBe(at.dispatched - p.dispatched);

          // ... and that replayer is the one step 6 names
          const eligibleAt = (q: JournalPosition): boolean | undefined => {
            if ('time' in target) return q.now <= target.time;
            if ('position' in target) return comparePositions(q, target.position) <= 0;
            // a cursor: every state before the one that emitted it is eligible; the same position is undecided
            const c = comparePositions(q, reference.position);
            return c < 0 ? true : c > 0 ? false : undefined;
          };
          const prevEligible =
            prevCursor === undefined ? false : 'cursor' in target ? (prevHead as number) <= target.cursor : (eligibleAt(known.get(prevCursor) as JournalPosition) as boolean);
          if (prevEligible) {
            expect(replay, `${what}: a target in the cursor replay's future advances it`).toBe(prevCursor);
            expect(cursor?.from, what).toBe(prevFrom);
            tally.fromCursor++;
          } else {
            let best: { slot: number; position: JournalPosition } | undefined;
            let undecided = false;
            for (const s of slotsBefore) {
              if (s.position === null) continue;
              const e = eligibleAt(s.position);
              if (e === undefined) undecided = true;
              if (e === true && (best === undefined || comparePositions(s.position, best.position) > 0)) best = { slot: s.slot, position: s.position };
            }
            if (undecided) tally.undecided++;
            if (!undecided) {
              if (best !== undefined) {
                expect(cursor?.from, `${what}: the parked replayer with the largest position at or before the target`).toBe(best.slot);
                expect(p, what).toEqual(best.position);
                tally.fromSlot++;
                if (steady) {
                  expect(res.replayedEvents, `${what}: steady state, inside the parked window: at most the largest lag gap (${gap})`).toBeLessThanOrEqual(gap);
                  tally.steadyInWindow++;
                }
              } else {
                expect(cursor?.from, `${what}: older than every parked replayer: a replay from the origin`).toBe('origin');
                expect(known.has(replay as Replay), what).toBe(false);
                expect(res.replayedEvents, what).toBe(at.dispatched);
                tally.fromOrigin++;
                if (steady) tally.steadyOlder++;
              }
            }
          }
          if (previous !== undefined) {
            const dir = comparePositions(at, previous);
            if (dir > 0) tally.forward++;
            if (dir < 0) tally.backward++;
          }
          previous = at;
          // review never touches the live world
          expect(live.position(), what).toEqual(end);
        }
        tm.leave();
        expect(tm.reviewing).toBe(false);
        expect(fingerprint(live), `round ${round}: leaving review leaves the live world as it was`).toEqual(pre);
      }

      expect(tally.seeks).toBe(ROUNDS * SEEKS_PER_ROUND);
      // the source of (nearly) every seek was checked against step 6: only a cursor target sitting exactly on a parked
      // position leaves it undecided (the replayer's exact cost is still checked)
      expect(tally.fromCursor + tally.fromSlot + tally.fromOrigin + tally.undecided).toBe(tally.seeks);
      expect(tally.undecided).toBeLessThanOrEqual(5);
      expect(tally.forward).toBeGreaterThanOrEqual(10);
      expect(tally.backward).toBeGreaterThanOrEqual(10);
      expect(tally.fromCursor).toBeGreaterThanOrEqual(5);
      expect(tally.fromSlot).toBeGreaterThanOrEqual(5);
      expect(tally.fromOrigin).toBeGreaterThanOrEqual(3);
      expect(tally.steadyInWindow).toBeGreaterThanOrEqual(3);
      expect(tally.steadyOlder).toBeGreaterThanOrEqual(1);
      expect(tally.atLive).toBeGreaterThanOrEqual(2);
      expect(fingerprint(live)).toEqual(before);
    },
    240_000,
  );
});

// ── the worker API ───────────────────────────────────────────────────────────

const WORKER = '../src/bridge/worker/index.ts';

/**
 * Every method of the worker API, by what it does in review. A method missing here (or listed here but gone) fails
 * the classification case, so "every mutator" stays every mutator.
 */
const MUTATORS = [
  'loadTopology',
  'loadScenario',
  'addDevice',
  'removeDevice',
  'renameDevice',
  'moveDevice',
  'setPower',
  'addLink',
  'removeLink',
  'setImpairments',
  'insertModule',
  'removeModule',
  'setDeviceUi',
  'setCanvasScale',
  'cliOpen',
  'cliExec',
  'cliInterrupt',
  'cliClose',
  'configure',
  'hostRequest',
  'stepToNext',
  'runUntilStop',
  'reset',
  'useCurrentDefaults',
] as const;
/** In review they move the cursor replay forward (never the live world); at the present review ends. */
const REVIEW_DRIVERS = ['play', 'stepEvent', 'stepTime', 'runToIdle'] as const;
/** Reads of the live world or of the reviewed instant. */
const READS = [
  'exportTopology',
  'listScenarios',
  'validateLink',
  'checkLab',
  'cliComplete',
  'cliHelp',
  'cliCanOpen',
  'snapshot',
  'pdu',
  'traceQuery',
  'timelineBuckets',
  'timelineMarks',
  'captures',
  'listCaptures',
  'queryCapture',
  'captureRecord',
  'followStream',
  'captureStats',
  'exportCapture',
] as const;
/** Clock, view and history settings: they change how the world is shown, not the world. */
const SETTINGS = ['pause', 'setRate', 'setClockPolicy', 'setPlaybackMode', 'setSimFilters', 'setWatchedDevices', 'subscribe', 'setTimeTravelBudget'] as const;
/** The capture desk: observation tools, never journaled inputs (§2.13 journal rules). */
const CAPTURE_DESK = ['startCapture', 'stopCapture', 'removeCapture', 'importCapture'] as const;
/** Time travel itself. */
const TIME_TRAVEL = ['seek', 'leaveReview'] as const;
/** The one-time handshake that builds the worker's first world (bridge/client.ts `initEngine`, idempotent). */
const HANDSHAKE = ['init'] as const;

async function booted(): Promise<{ api: EngineApi; batches: EngineBatch[]; ids: Map<string, DeviceId>; session: SessionId; links: LinkId[] }> {
  vi.resetModules();
  exposed = undefined;
  await import(WORKER);
  const api = exposed as unknown as EngineApi;
  const batches: EngineBatch[] = [];
  await api.subscribe((b) => {
    batches.push(b);
  });
  await api.init({ seed: 7 });
  const sc = lab();
  await api.loadScenario(WORLD);
  const topo = await api.exportTopology();
  const ids = new Map(topo.devices.map((d) => [d.name, d.id as DeviceId]));
  const id = (name: string): DeviceId => {
    const v = ids.get(name);
    if (v === undefined) throw new Error(`no device called ${name}`);
    return v;
  };
  await api.stepTime(60 * SEC);
  for (const [name, lines] of Object.entries(sc.solution ?? {})) await api.configure(id(name), [...lines]);
  await api.stepTime(10 * SEC);
  const view = await api.cliOpen(id('PC1'), 'console');
  const snap = await api.snapshot();
  const ext = snap.devices.find((d) => d.id === id('EXT'))?.ports.find((p) => p.l3.ipv4 !== undefined)?.l3.ipv4?.address;
  expect(ext).toBeDefined();
  await api.cliExec(view.id, `ping ${String(ext)}`);
  await api.stepTime(15 * SEC);
  await api.runToIdle();
  await api.stepTime(20 * SEC);
  batches.length = 0;
  return { api, batches, ids, session: view.id, links: (await api.snapshot()).links.map((l) => l.id as LinkId) };
}

const last = (batches: readonly EngineBatch[]): EngineBatch => {
  const b = batches[batches.length - 1];
  if (b === undefined) throw new Error('no batch was posted');
  return b;
};

/** The rejection of `call`, which must be exactly the read-only message. */
async function expectReadOnly(name: string, call: () => Promise<unknown>): Promise<void> {
  let err: unknown;
  try {
    await call();
  } catch (e) {
    err = e;
  }
  expect(err, `${name} must reject in review`).toBeInstanceOf(Error);
  expect((err as Error).message, `${name} rejects with the read-only message`).toBe(REPLAY_READ_ONLY_MESSAGE);
}

describe('the worker API in review: the read-only rule and the way back', () => {
  beforeEach(() => {
    // setTimeout stays real: seek chunks yield through it
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it(
    'every method of the API is classified (mutators, review drivers, reads, settings, capture desk, time travel, handshake)',
    async () => {
      vi.resetModules();
      exposed = undefined;
      await import(WORKER);
      const methods = Object.keys(exposed as unknown as object).sort();
      const classified = [...MUTATORS, ...REVIEW_DRIVERS, ...READS, ...SETTINGS, ...CAPTURE_DESK, ...TIME_TRAVEL, ...HANDSHAKE];
      expect(new Set(classified).size, 'each method in one class').toBe(classified.length);
      expect(methods).toEqual([...classified].sort());
    },
    60_000,
  );

  it(
    'every mutator rejects in review with REPLAY_READ_ONLY_MESSAGE and changes nothing; leaving review returns the pre-review live snapshot',
    async () => {
      const { api, batches, ids, session, links } = await booted();
      const id = (name: string): DeviceId => ids.get(name) as DeviceId;
      const pre = await api.snapshot();
      const preHead = (await api.traceQuery({ from: 0, limit: 0 })).head;
      const preTopo = JSON.stringify(await api.exportTopology());
      expect(links.length).toBeGreaterThan(0);

      // into the past, then forward and backward inside review
      const first = await api.seek({ time: 50 * SEC });
      expect(first.review.atLive).toBe(false);
      const fwd = await api.seek({ time: 90 * SEC });
      expect(comparePositions(fwd.review.at, first.review.at)).toBeGreaterThan(0);
      const back = await api.seek({ cursor: 40 });
      expect(comparePositions(back.review.at, first.review.at)).toBeLessThan(0);
      const byPosition = await api.seek({ position: fwd.review.at });
      expect(byPosition.review.at).toEqual(fwd.review.at);
      expect(byPosition.snapshot).toEqual(fwd.snapshot);
      batches.length = 0;

      const calls: Record<(typeof MUTATORS)[number], () => Promise<unknown>> = {
        loadTopology: () => api.loadTopology(labTopology(lab())),
        loadScenario: () => api.loadScenario('two-pcs-and-switch'),
        addDevice: () => api.addDevice({ type: 'pc.nfpc', position: { x: 10, y: 10 } }),
        removeDevice: () => api.removeDevice(id('PC3')),
        renameDevice: () => api.renameDevice(id('PC3'), 'Elsewhere'),
        moveDevice: () => api.moveDevice(id('PC3'), { x: 5, y: 5 }),
        setPower: () => api.setPower(id('PC3'), false),
        addLink: () => api.addLink({ a: { device: id('PC3'), port: 'gi0' as never }, b: { device: id('SW1'), port: 'fa0/20' as never } }),
        removeLink: () => api.removeLink(links[0] as LinkId),
        setImpairments: () => api.setImpairments(links[0] as LinkId, { lossPct: 5 }),
        insertModule: () => api.insertModule(id('R1'), 'slot0' as never, 'nf-hwic-2t' as never),
        removeModule: () => api.removeModule(id('R1'), 'slot0' as never),
        setDeviceUi: () => api.setDeviceUi(id('PC1'), { note: 'from the past' }),
        setCanvasScale: () => api.setCanvasScale(2),
        cliOpen: () => api.cliOpen(id('PC2'), 'console'),
        cliExec: () => api.cliExec(session, 'show arp'),
        cliInterrupt: () => api.cliInterrupt(session),
        cliClose: () => api.cliClose(session),
        configure: () => api.configure(id('R1'), ['hostname Nope']),
        hostRequest: () => api.hostRequest(id('PC1'), { app: 'dhcp.release', port: 'GigabitEthernet0' }),
        stepToNext: () => api.stepToNext(),
        runUntilStop: () => api.runUntilStop(pre.now + 100 * SEC, { kinds: ['frameTx'] }),
        reset: () => api.reset(9),
        useCurrentDefaults: () => api.useCurrentDefaults(),
      };
      expect(Object.keys(calls).sort()).toEqual([...MUTATORS].sort());
      for (const name of MUTATORS) {
        await expectReadOnly(name, calls[name]);
        // nothing moved in the live world
        expect((await api.traceQuery({ from: 0, limit: 0 })).head, name).toBe(preHead);
        expect(JSON.stringify(await api.exportTopology()), name).toBe(preTopo);
      }
      // no live batch was posted on top of the reviewed instant
      expect(batches.every((b) => b.review !== undefined && b.review !== null)).toBe(true);

      // reads and settings still answer, without the read-only message
      await api.pause();
      await api.setRate(2);
      await api.setClockPolicy({ minTransitWallMs: 0 });
      await api.setWatchedDevices([id('PC1')]);
      expect((await api.cliCanOpen(id('PC2'), 'console')).ok).toBe(true);
      expect(await api.checkLab()).not.toBeUndefined();
      expect(typeof (await api.validateLink({ a: { device: id('PC3'), port: 'gi0' as never }, b: { device: id('SW1'), port: 'fa0/20' as never } })).ok).toBe('boolean');
      expect(await api.listScenarios()).not.toHaveLength(0);
      expect(Array.isArray(await api.timelineBuckets({ from: 0, to: pre.now, buckets: 4 }))).toBe(true);
      expect((await api.snapshot()).now).toBe(byPosition.snapshot.now);

      // the review drivers move the reviewed instant forward only, never the live world
      const reviewedAt = byPosition.review.at;
      await api.stepEvent();
      expect(comparePositions(last(batches).review?.at as JournalPosition, reviewedAt)).toBeGreaterThanOrEqual(0);
      await api.stepTime(2 * SEC);
      expect(last(batches).review?.t).toBeGreaterThan(byPosition.review.t);
      await api.play();
      await api.pause();
      expect((await api.traceQuery({ from: 0, limit: 0 })).head).toBe(preHead);
      expect(JSON.stringify(await api.exportTopology())).toBe(preTopo);

      // leaving review: the pre-review live snapshot, on the call and on the batch that ends review
      const after = await api.leaveReview();
      expect(after).toEqual(pre);
      expect(JSON.stringify(after)).toBe(JSON.stringify(pre));
      const ending = last(batches);
      expect(ending.review).toBeNull();
      expect(ending.snapshot).toEqual(pre);
      expect(await api.snapshot()).toEqual(pre);

      // the other way back: running the review to the present ends it on the same live snapshot
      await api.seek({ time: 30 * SEC });
      const atPresent = await api.runToIdle();
      expect(atPresent).toEqual(pre);
      expect(last(batches).review).toBeNull();
      expect(await api.snapshot()).toEqual(pre);

      // and the network can change again
      await api.renameDevice(id('PC3'), 'Back');
      expect((await api.exportTopology()).devices.find((d) => d.id === id('PC3'))?.name).toBe('Back');
    },
    120_000,
  );
});
