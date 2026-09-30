/**
 * test/replay-exact.harness.ts — the script, the checks and the shard map of the replay-exact acceptance row. Not a
 * test file.
 *
 * P2 acceptance [SHOULD S1] — exact replay of the input journal (ARCHITECTURE-P2 D18, §2.13, §3.13 steps 1–4, §10.1
 * row `accept.p2.replay-exact`). ARCHITECTURE-P3 §7 W0 qa and §9.2 W0 item 8 split that one file by scenario category
 * into three shards, so the slow project can run them in parallel: `accept.p2.replay-exact-templates`, `-ccna1` and
 * `-ccna2`. Everything below is the unsplit file's code, moved here unchanged: the seeded script, the comparisons,
 * the catalogue case (`expectCatalogueCovered`) and the per-scenario case (`replayExactCase`), whose assertions are
 * exactly the unsplit file's. Each shard registers the catalogue case, the partition case (`expectShardPartition`)
 * and one per-scenario case for every scenario of its categories (`scenariosOfShard`).
 *
 * Coverage. The unsplit file covered EVERY `SCENARIOS` entry, read at run time. `REPLAY_EXACT_SHARD_OF_CATEGORY` maps
 * each category to exactly one shard file, and every shard asserts that every scenario's category has a shard, that
 * the shards' scenario lists together are `SCENARIOS` with each scenario exactly once, and that every shard file
 * exists. A scenario of a category no shard takes (the CCNA 3 labs of P3 W5, before their shard
 * `accept.p3.replay-exact-ccna3` joins this map, §9.2 W5 item 40) therefore fails every shard instead of escaping the
 * replay check.
 *
 * For EVERY scenario of a shard (read at run time, so a lab appended later is covered without touching the shards) a
 * seeded input script drives the live world through every way the row names:
 *
 *   prelude  work BEFORE the document is opened (a scratch PC, a console, a line typed, one second run), so the
 *            journal's origin resumes non-zero facade counters (trace head, sessions, headless, topology version);
 *   load     the scenario as the worker's `loadScenario` builds it (lab stamp when it has tasks) and its scheduled
 *            faults (journaled `injectFault` inputs);
 *   boot     a breakpoint stop (`runFor(…, {stopOn: linkState})` leaves the clock at the matching event), two single
 *            `step`s, a `stepToNext(tableWrite)` with a horizon, then `runUntil` the end of the boot;
 *   solution the lab's reference solution through `Simulation.configure`, one call per device (a template, which has
 *            none, gets a seeded `hostname` on a seeded configurable device);
 *   show     seeded consoles typing `show` commands (the host shell's and the device shell's), a seeded ping to a
 *            seeded address the world really has (IPv4, or a global IPv6 address), and a lease renewal on that host;
 *   cut      a seeded `cable-cut` fault on a seeded link, restored by itself 3 s later;
 *   move     a seeded device to a seeded position;
 *   power    a seeded device powered off, run, powered on;
 *   refused  an input the facade refuses (journaled with `threw`, the replay expects it to throw again);
 *   run      a second breakpoint stop, more console input, a console closed, `runToIdle`, a 300 s `runFor` (MAC
 *            aging, hellos, keepalives), one last console input late in the journal, and a final `runFor`.
 *
 * The seed of each script is an FNV-1a hash of the scenario name fed to a small integer PRNG in this file (no
 * Math.random); the world itself runs on the scenario's own seed.
 *
 * Pass conditions (the row, clause by clause):
 *   • replaying the journal to `position()` gives byte-identical trace JSON (from `origin.counters.traceHead`) and
 *     snapshot JSON — one replay advanced in a single call;
 *   • replaying to every intermediate entry equals the live snapshot recorded right after that entry — every entry of
 *     the journal, through `advanceToEntry`, in chunks;
 *   • two replays interleaved in one realm stay identical — the per-entry replay runs interleaved chunk by chunk with
 *     a second, chunked replay (other chunk sizes, its own trace ring) in the same realm as the live world, and both
 *     end byte-identical to the live world (trace and snapshot) and to each other.
 *
 * Cost: every scenario is run once live and three times replayed, over a script of about eight minutes of sim time;
 * nothing is sub-sampled (the unsplit file took about a minute; each shard takes its share).
 */
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, expect } from 'vitest';
import type { DeviceId, LinkId, SessionId } from '../src/contracts/ids.js';
import type { JournalOp, SimJournal } from '../src/contracts/journal.js';
import type { ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { Topology } from '../src/contracts/topology.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createReplay } from '../src/sim/replay.js';
import { SCENARIOS, SCENARIO_SEED } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';

// ── the shards ──────────────────────────────────────────────────────────────

/** The engine's test directory (the shard files live directly in it). */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The shard file that replays each scenario category (ARCHITECTURE-P3 §9.2 W0 item 8). Every category of `SCENARIOS`
 * must be a key: a category without a shard fails `expectShardPartition`. P3 W5 adds `'ccna3-lab'` with its shard
 * `accept.p3.replay-exact-ccna3.test.ts` (§9.2 W5 item 40).
 */
export const REPLAY_EXACT_SHARD_OF_CATEGORY: Readonly<Record<string, string>> = Object.freeze({
  template: 'accept.p2.replay-exact-templates.test.ts',
  'ccna1-lab': 'accept.p2.replay-exact-ccna1.test.ts',
  'ccna2-lab': 'accept.p2.replay-exact-ccna2.test.ts',
});

/** The shard file of a category, or undefined when no shard takes it. */
function shardOfCategory(category: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(REPLAY_EXACT_SHARD_OF_CATEGORY, category) ? REPLAY_EXACT_SHARD_OF_CATEGORY[category] : undefined;
}

/** The shard files, each once, in map order. */
export function replayExactShardFiles(): readonly string[] {
  const out: string[] = [];
  for (const file of Object.values(REPLAY_EXACT_SHARD_OF_CATEGORY)) if (file !== undefined && !out.includes(file)) out.push(file);
  return out;
}

/** The scenarios a shard replays: every `SCENARIOS` entry whose category maps to `file`, in `SCENARIOS` order. */
export function scenariosOfShard(file: string): readonly ScenarioInfo[] {
  return SCENARIOS.filter((sc) => shardOfCategory(sc.category) === file);
}

/**
 * The partition case of a shard: `file` is a shard; every scenario's category has a shard; the shards' scenario
 * lists together are `SCENARIOS`, each scenario exactly once; this shard is not empty; every shard file exists.
 */
export function expectShardPartition(file: string): void {
  const files = replayExactShardFiles();
  expect(files, 'the file is one of the replay-exact shards').toContain(file);
  expect(
    SCENARIOS.filter((sc) => shardOfCategory(sc.category) === undefined).map((sc) => `${sc.name} (${sc.category})`),
    'scenarios whose category no replay-exact shard takes',
  ).toEqual([]);
  const covered = files.flatMap((f) => scenariosOfShard(f).map((sc) => sc.name));
  expect(new Set(covered).size, 'no scenario is replayed by two shards').toBe(covered.length);
  expect([...covered].sort()).toEqual(SCENARIOS.map((sc) => sc.name).sort());
  expect(scenariosOfShard(file).length, `${file} replays at least one scenario`).toBeGreaterThan(0);
  const present = new Set(readdirSync(HERE));
  expect(files.filter((f) => !present.has(f)), 'replay-exact shard files that do not exist').toEqual([]);
}

// ── the seeded script ───────────────────────────────────────────────────────

/** End of the boot phase (every model is up: the router takes 45 s). */
const BOOT_NS = 60 * SEC;
/** The long run near the end of the script: past the 300 s MAC aging of the addresses learned at boot. */
const LONG_RUN_NS = 300 * SEC;
/** Trace ring of the live world and of the replays that compare traces: every event since the origin is kept. */
const TRACE_CAPACITY = 1_000_000;
/** Chunk sizes of the two interleaved replays (co-prime, so their chunk edges rarely meet). */
const CHUNK_PER_ENTRY = 97;
const CHUNK_TWIN = 151;
/** Wall-clock budget of one scenario (one live run, three replays). */
export const SCENARIO_TIMEOUT_MS = 120_000;

/** 32-bit FNV-1a of a string: the script seed of a scenario. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A small deterministic PRNG (mulberry32) for the script's choices. */
function prng(seed: number): { int(n: number): number; pick<T>(xs: readonly T[]): T | undefined } {
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
    pick: (xs) => (xs.length === 0 ? undefined : xs[next() % xs.length]),
  };
}

/** The document `loadScenario` loads: the lab stamp when the scenario has tasks. */
function labTopology(sc: ScenarioInfo): Topology {
  const topo = sc.build();
  return (sc.tasks?.length ?? 0) > 0 ? { ...topo, lab: { name: sc.name, version: sc.version ?? 1 } } : topo;
}

function idOf(sim: Simulation, name: string): DeviceId {
  for (const d of sim.devices()) if (d.spec.name === name) return d.id;
  throw new Error(`no device called ${name} in this world`);
}

const snap = (sim: Simulation): string => JSON.stringify(sim.snapshot());
const head = (sim: Simulation): number => sim.traceQuery({ from: 0, limit: 0 }).head;

/** Devices whose console opens, in id order. */
function consoles(sim: Simulation): DeviceId[] {
  return sim
    .devices()
    .filter((d) => sim.cli.canOpen(d.id, 'console').ok)
    .map((d) => d.id)
    .sort();
}

/** The show line typed on a device's console: the host shell's or the device shell's. */
function showLine(sim: Simulation, id: DeviceId): string {
  return sim.device(id)?.model.cli.shell === 'host' ? 'show arp' : 'show ip interface brief';
}

/** Every IPv4 address, and every usable global IPv6 address, a device other than `not` has right now (fixed order). */
function addressesBut(sim: Simulation, not: DeviceId): string[] {
  const out: string[] = [];
  for (const d of [...sim.devices()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (d.id === not) continue;
    for (const p of d.ports.values()) {
      if (p.l3.ipv4 !== undefined) out.push(p.l3.ipv4.address);
      for (const a of p.l3.ipv6 ?? []) if (a.scope === 'global' && a.state === 'preferred') out.push(a.address);
    }
  }
  return out;
}

/** One live run of the script, with the snapshot recorded right after every journal entry. */
interface LiveRun {
  readonly sim: Simulation;
  readonly journal: SimJournal;
  /** Snapshot JSON right after entry i. */
  readonly afterEntry: readonly string[];
  /** The ops the script journaled, by kind. */
  readonly kinds: ReadonlySet<JournalOp['op']>;
  /** How the script went: the boot breakpoint stop, the single steps and the ping really happened. */
  readonly runs: {
    /** The boot's breakpoint stop: it stopped, and where the clock stayed. */
    readonly firstStop: { readonly stopped: boolean; readonly at: number };
    readonly stepped: number;
    /** A ping was typed (the world has a host and an address to ping). */
    readonly pinged: boolean;
  };
}

function runLive(sc: ScenarioInfo): LiveRun {
  const pick = prng(fnv1a(sc.name));
  const sim = createSimulation({ seed: sc.seed ?? SCENARIO_SEED, traceCapacity: TRACE_CAPACITY });
  const afterEntry: string[] = [];
  const entries = (): number => sim.journal().entries.length;

  // prelude: work before the document is opened, recorded in the journal the load replaces
  const scratch = sim.addDevice({ type: 'pc.nfpc', name: 'Scratch' });
  const s0 = sim.cli.open(scratch, 'console');
  sim.cli.exec(s0, 'show arp');
  sim.runFor(SEC);
  sim.loadTopology(labTopology(sc));
  expect(entries(), 'the load starts a new journal').toBe(0);

  /** One journaled input: exactly one entry, the snapshot right after it recorded. */
  const input = <T>(fn: () => T): T => {
    const before = entries();
    let out: T;
    try {
      out = fn();
    } finally {
      expect(entries(), 'one facade call journals exactly one entry').toBe(before + 1);
      afterEntry.push(snap(sim));
    }
    return out;
  };

  for (const f of sc.faults ?? []) input(() => sim.injectFault(f.at, f.fault));

  // boot: a breakpoint stop, single steps, a step to the next table write, then the rest of the boot
  const stop = sim.runFor(BOOT_NS, { stopOn: { kinds: ['linkState'] } });
  const firstStop = { stopped: stop.stopped === 'breakpoint', at: sim.now };
  let stepped = 0;
  for (let i = 0; i < 2; i++) if (sim.step() !== undefined) stepped++;
  sim.stepToNext({ kinds: ['tableWrite'] }, { until: sim.now + 10 * SEC });
  sim.runUntil(Math.max(sim.now, BOOT_NS));

  // the solution (a template gets a seeded hostname on a seeded configurable device)
  const solution = Object.entries(sc.solution ?? {});
  if (solution.length > 0) {
    for (const [name, lines] of solution) input(() => sim.configure(idOf(sim, name), lines));
  } else {
    const nfos = consoles(sim).filter((id) => sim.device(id)?.model.cli.shell === 'nfos');
    const target = pick.pick(nfos) ?? pick.pick(consoles(sim));
    if (target !== undefined) input(() => sim.configure(target, sim.device(target)?.model.cli.shell === 'nfos' ? [`hostname Replay${pick.int(100)}`] : ['ip default-gateway 10.255.255.254']));
  }
  sim.runFor(10 * SEC);

  // show commands on two seeded consoles, and a seeded ping
  const open = consoles(sim);
  const first = pick.pick(open);
  let session: SessionId | undefined;
  if (first !== undefined) {
    const s = input(() => sim.cli.open(first, 'console'));
    session = s;
    input(() => sim.cli.exec(s, showLine(sim, first)));
  }
  const second = pick.pick(open);
  if (second !== undefined) {
    const s = input(() => sim.cli.open(second, 'console'));
    input(() => sim.cli.exec(s, showLine(sim, second)));
  }
  const hosts = open.filter((id) => sim.device(id)?.model.cli.shell === 'host');
  const pinger = pick.pick(hosts);
  let pinged = false;
  if (pinger !== undefined) {
    const to = pick.pick(addressesBut(sim, pinger));
    if (to !== undefined) {
      const s = input(() => sim.cli.open(pinger, 'console'));
      input(() => sim.cli.exec(s, `ping ${to}`));
      pinged = true;
    }
    // a host app request (a lease renewal draws fresh transaction ids; a host without a lease refuses it, journaled)
    const port = [...(sim.device(pinger)?.ports.keys() ?? [])][0];
    if (port !== undefined) {
      input(() => {
        try {
          return sim.hostRequest(pinger, { app: 'dhcp.renew', port });
        } catch {
          return undefined;
        }
      });
    }
  }
  sim.runFor(5 * SEC);

  // a cut (restored by itself) and a move
  const links = sim.snapshot().links.map((l) => l.id as LinkId);
  const cut = pick.pick(links);
  if (cut !== undefined) {
    input(() => sim.injectFault(sim.now + SEC, { id: 'replay-cut', kind: 'cable-cut', target: { link: cut }, params: { durationNs: 3 * SEC } }));
  }
  const devices = sim.devices().map((d) => d.id).sort();
  const mover = pick.pick(devices);
  if (mover !== undefined) input(() => sim.moveDevice(mover, { x: 40 + pick.int(600), y: 40 + pick.int(400) }));
  sim.runFor(6 * SEC);

  // a power cycle
  const cycled = pick.pick(devices);
  if (cycled !== undefined) {
    input(() => sim.setPower(cycled, false));
    sim.runFor(2 * SEC);
    input(() => sim.setPower(cycled, true));
  }

  // an input the facade refuses: journaled with `threw`
  input(() => expect(() => sim.renameDevice('no-such-device' as DeviceId, 'Ghost')).toThrow());

  // a second breakpoint stop, more console input, a console closed, then idle and a last run
  sim.runFor(60 * SEC, { stopOn: { kinds: ['linkState', 'portState'] } });
  if (session !== undefined && first !== undefined) {
    const s = session;
    input(() => sim.cli.exec(s, showLine(sim, first)));
    input(() => sim.cli.close(s));
  }
  sim.runToIdle();
  // a long run (address and MAC aging, keepalives, hellos), and one last input late in the journal
  sim.runFor(LONG_RUN_NS);
  if (second !== undefined) {
    const s = input(() => sim.cli.open(second, 'console'));
    input(() => sim.cli.exec(s, showLine(sim, second)));
  }
  sim.runFor(5 * SEC);

  const journal = sim.journal();
  return {
    sim,
    journal,
    afterEntry,
    kinds: new Set(journal.entries.map((e) => e.op.op)),
    runs: { firstStop, stepped, pinged },
  };
}

// ── comparisons with readable failures ──────────────────────────────────────

/** The events of a world from `cursor` on (every one of them: nothing may have been evicted). */
function eventsFrom(sim: Simulation, cursor: number): TraceEvent[] {
  const t = sim.trace(cursor);
  expect(t.dropped, 'the trace ring kept every event since the origin').toBe(0);
  return t.events;
}

/** Byte-identical trace JSON; on a mismatch, the first differing event of both worlds. */
function expectSameTrace(what: string, replay: Simulation, live: Simulation, cursor: number): void {
  const a = eventsFrom(replay, cursor);
  const b = eventsFrom(live, cursor);
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja === jb) return;
  let i = 0;
  while (i < a.length && i < b.length && JSON.stringify(a[i]) === JSON.stringify(b[i])) i++;
  assert.fail(
    `${what}: the trace differs at cursor ${cursor + i} (replay ${a.length} events, live ${b.length})\n` +
      `  replay: ${JSON.stringify(a[i]) ?? '(none)'}\n  live:   ${JSON.stringify(b[i]) ?? '(none)'}`,
  );
}

/** Byte-identical snapshot JSON; on a mismatch, the first differing top-level member (per device). */
function expectSameSnapshot(what: string, actual: string, expected: string): void {
  if (actual === expected) return;
  const a = JSON.parse(actual) as Record<string, unknown>;
  const b = JSON.parse(expected) as Record<string, unknown>;
  const diffs: string[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === 'devices') {
      const da = (a[key] ?? []) as { id: string }[];
      const db = (b[key] ?? []) as { id: string }[];
      for (const d of db) {
        const other = da.find((x) => x.id === d.id);
        if (JSON.stringify(other) !== JSON.stringify(d)) diffs.push(`devices/${d.id}`);
      }
      if (da.length !== db.length) diffs.push(`devices (${da.length} vs ${db.length})`);
    } else if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      diffs.push(`${key}: replay ${JSON.stringify(a[key])?.slice(0, 300)} / live ${JSON.stringify(b[key])?.slice(0, 300)}`);
    }
  }
  assert.fail(`${what}: the snapshot differs in ${diffs.join('; ')}`);
}

// ── the acceptance cases (the unsplit file's, unchanged) ────────────────────

/** The catalogue case: every scenario of the catalogue (templates, CCNA 1 labs, CCNA 2 labs) is there to replay. */
export function expectCatalogueCovered(): void {
  const categories = new Set(SCENARIOS.map((s) => s.category));
  expect(SCENARIOS.length).toBeGreaterThanOrEqual(43);
  for (const c of ['template', 'ccna1-lab', 'ccna2-lab']) expect(categories.has(c as never), c).toBe(true);
  expect(new Set(SCENARIOS.map((s) => s.name)).size).toBe(SCENARIOS.length);
}

/** The per-scenario case: to position(), to every entry, and interleaved. */
export function replayExactCase(sc: ScenarioInfo): void {
  const live = runLive(sc);
  const { journal, sim } = live;
  const origin = journal.origin;
  const end = sim.position();
  const n = journal.entries.length;

  // the script really exercised what the row names
  expect(origin.topology).not.toBeNull();
  expect(origin.counters.traceHead, 'the origin resumes the prelude trace head').toBeGreaterThan(0);
  expect(origin.counters.sessions, 'the origin resumes the prelude session counter').toBeGreaterThan(0);
  for (const k of ['cliOpen', 'cliExec', 'cliClose', 'configure', 'hostRequest', 'injectFault', 'moveDevice', 'setPower', 'renameDevice'] as const) {
    expect(live.kinds.has(k), `${sc.name} journals ${k}`).toBe(true);
  }
  expect(journal.entries.some((e) => e.threw === true)).toBe(true);
  expect(live.runs.stepped).toBe(2);
  expect(live.runs.firstStop.stopped, 'the boot breakpoint stopped the run').toBe(true);
  expect(live.runs.firstStop.at).toBeLessThan(BOOT_NS);
  expect(live.runs.pinged, 'a ping was typed').toBe(true);
  expect(live.afterEntry).toHaveLength(n);
  expect(end.dispatched).toBeGreaterThan(0);

  // (1) one replay straight to position(): byte-identical trace JSON from the origin head, and snapshot JSON
  const whole = createReplay(journal, { traceCapacity: TRACE_CAPACITY });
  const r = whole.advance(end);
  expect(r.reached).toBe(true);
  expect(r.events).toBe(end.dispatched);
  expect(whole.applied).toBe(n);
  expect(whole.position()).toEqual(end);
  expect(head(whole.sim)).toBe(head(sim));
  expectSameTrace(`${sc.name} (to position())`, whole.sim, sim, origin.counters.traceHead);
  expectSameSnapshot(`${sc.name} (to position())`, snap(whole.sim), snap(sim));

  // (2) every entry, in chunks, interleaved with (3) a chunked twin in the same realm
  const perEntry = createReplay(journal);
  const twin = createReplay(journal, { traceCapacity: TRACE_CAPACITY });
  let twinDone = false;
  const nudgeTwin = (): void => {
    if (!twinDone) twinDone = twin.advance(end, { maxEvents: CHUNK_TWIN }).reached;
  };
  for (let i = 0; i < n; i++) {
    let guard = 0;
    while (!perEntry.advanceToEntry(i, { maxEvents: CHUNK_PER_ENTRY }).reached) {
      nudgeTwin();
      if (++guard > 1_000_000) throw new Error('the per-entry replay never reached its entry');
    }
    nudgeTwin();
    expect(perEntry.applied).toBe(i + 1);
    expect(perEntry.position()).toEqual(journal.entries[i]!.at);
    expectSameSnapshot(`${sc.name} after entry ${i} (${journal.entries[i]!.op.op})`, snap(perEntry.sim), live.afterEntry[i]!);
  }
  let guard = 0;
  while (!perEntry.advance(end, { maxEvents: CHUNK_PER_ENTRY }).reached) {
    nudgeTwin();
    if (++guard > 1_000_000) throw new Error('the per-entry replay never reached the end');
  }
  while (!twinDone) {
    nudgeTwin();
    if (++guard > 2_000_000) throw new Error('the twin replay never reached the end');
  }
  expect(perEntry.position()).toEqual(end);
  expect(twin.position()).toEqual(end);
  const a = snap(perEntry.sim);
  const b = snap(twin.sim);
  expect(a === b, `${sc.name}: the two interleaved replays are identical`).toBe(true);
  expectSameSnapshot(`${sc.name} (interleaved)`, b, snap(sim));
  expectSameTrace(`${sc.name} (interleaved twin)`, twin.sim, sim, origin.counters.traceHead);
  // replays journal nothing of their own
  expect(whole.sim.journal().entries).toEqual([]);
  expect(twin.sim.journal().entries).toEqual([]);
}
