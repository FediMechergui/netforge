/**
 * P2 acceptance [SHOULD S1] — exact replay of the input journal (ARCHITECTURE-P2 D18, §2.13, §3.13 steps 1–4, §10.1
 * row `accept.p2.replay-exact`): the shard of the CCNA 3 labs, category `ccna3-lab` (ARCHITECTURE-P3 §9.2 W5 item 40,
 * §10.1 row `accept.p3.replay-exact-ccna3`).
 *
 * The script, the checks and the shard map are in `replay-exact.harness.ts` (its map gains `'ccna3-lab'` → this file,
 * the one edit item 40 makes there); this shard runs the same three cases as the P2 shards, with the same assertions:
 * the catalogue case, the partition case (the four shards together replay every `SCENARIOS` entry exactly once) and
 * the per-scenario case for every CCNA 3 lab (read at run time, so a lab that lands later is covered without an edit
 * here). That covers the approved labs 10, 24, 25 and 33 and the approved tasks of the MUST labs.
 *
 * Remote sessions included (item 40). The harness's script types `show` lines and a ping on host consoles, never a
 * remote login, so this shard adds one case per CCNA 3 lab that grades the learner's own remote logins (labs 15 and
 * 19, §11.2; their lab files give the logins as data, the lines a learner types on each PC's console): the journal of
 * load, scheduled faults, boot, solution and those logins — an SSH session that logs in and out, and one the access
 * class refuses — replays to byte-identical trace JSON (from the origin's head) and snapshot JSON straight to
 * `position()` (every event dispatched, every entry applied), and to every entry's recorded snapshot in chunks
 * interleaved with a chunked twin in the same realm that ends byte-identical (the P2 row's three clauses; W5 fix #28).
 * Only the client side is journaled: the server's remote session is a consequence (the `remoteCli` SimEvent, D14).
 *
 * This shard runs in the engine's `slow` project (vitest.workspace.ts: `accept.*.replay-exact*`), as the CCNA 2
 * shard does.
 */
import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import workspace from '../vitest.workspace.js';
import type { DeviceId } from '../src/contracts/ids.js';
import type { ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { VtyLoginRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { createReplay } from '../src/sim/replay.js';
import { ACL_STANDARD_LOGINS, CCNA3_LABS, SECURE_ACCESS_LOGINS } from '../src/sim/scenarios/ccna3/index.js';
import { SCENARIO_SEED } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';
import { SCENARIO_TIMEOUT_MS, expectCatalogueCovered, expectShardPartition, replayExactCase, scenariosOfShard } from './replay-exact.harness.js';

/** The chunk sizes of the P2 row's interleaved replays (replay-exact.harness.ts): per entry, and the twin's. */
const CHUNK_PER_ENTRY = 97;
const CHUNK_TWIN = 151;

/** This shard's file name (its value in `REPLAY_EXACT_SHARD_OF_CATEGORY`). */
const SHARD = 'accept.p3.replay-exact-ccna3.test.ts';

/** The logins a lab asks the learner to make before Check (as its lab file gives them). */
const LEARNER_LOGINS: Readonly<Record<string, readonly { readonly from: string; readonly lines: readonly string[] }[]>> = {
  'ccna3-acl-standard': ACL_STANDARD_LOGINS,
  'ccna3-secure-device-access': SECURE_ACCESS_LOGINS,
};

/** Every model of a lab has booted (the router takes 45 s) and OSPF has elected. */
const BOOT_NS = 90 * SEC;
/** Clone time after each line typed for a remote login. */
const LOGIN_LINE_NS = 5 * SEC;
/** Trace ring of the live world and the replays: every event since the origin is kept. */
const TRACE_CAPACITY = 1_000_000;

describe('accept.p3.replay-exact-ccna3: every CCNA 3 lab, replayed from its journal', () => {
  it('covers every scenario of the catalogue (templates, CCNA 1 labs, CCNA 2 labs)', () => {
    expectCatalogueCovered();
  });

  it('replays exactly the CCNA 3 labs here, and the four shards together replay every scenario once', () => {
    expectShardPartition(SHARD);
  });

  it('runs in the slow project, never in the fast one (vitest.workspace.ts; W5 fix #27)', () => {
    type Project = { readonly test?: { readonly name?: string; readonly include?: readonly string[]; readonly exclude?: readonly string[] } };
    const projects = workspace as unknown as readonly Project[];
    const globs = (name: string, member: 'include' | 'exclude'): readonly string[] => projects.find((p) => p.test?.name === name)?.test?.[member] ?? [];
    const file = `test/${SHARD}`;
    expect(globs('slow', 'include').some((g) => posix.matchesGlob(file, g)), 'a slow include glob names this shard').toBe(true);
    expect(globs('fast', 'exclude').some((g) => posix.matchesGlob(file, g)), 'a fast exclude glob names this shard').toBe(true);
  });

  for (const sc of scenariosOfShard(SHARD)) {
    it(
      `${sc.name}: to position(), to every entry, and interleaved`,
      () => {
        replayExactCase(sc);
      },
      SCENARIO_TIMEOUT_MS,
    );
  }
});

function idOf(sim: Simulation, name: string): DeviceId {
  for (const d of sim.devices()) if (d.spec.name === name) return d.id;
  throw new Error(`no device called ${name} in this lab`);
}

/** The vty-logins rows of every device: (device, proto, result). */
function logins(sim: Simulation): string[] {
  return sim.devices().flatMap((d) => (d.tables.get<VtyLoginRow>('vty-logins')?.rows() ?? []).map((r) => `${d.spec.name} ${r.proto} ${r.result}`));
}

/** The remote-session script: load, faults, boot, solution, the learner's logins; the snapshot after every entry. */
function remoteRun(sc: ScenarioInfo): { sim: Simulation; afterEntry: string[] } {
  const sim = createSimulation({ seed: sc.seed ?? SCENARIO_SEED, traceCapacity: TRACE_CAPACITY });
  const afterEntry: string[] = [];
  const snap = (): string => JSON.stringify(sim.snapshot());
  sim.loadTopology({ ...sc.build(), lab: { name: sc.name, version: sc.version ?? 1 } });
  const input = <T>(fn: () => T): T => {
    const before = sim.journal().entries.length;
    const out = fn();
    expect(sim.journal().entries.length, 'one facade call journals exactly one entry').toBe(before + 1);
    afterEntry.push(snap());
    return out;
  };
  for (const f of sc.faults ?? []) input(() => sim.injectFault(f.at, f.fault));
  sim.runFor(BOOT_NS);
  for (const [name, lines] of Object.entries(sc.solution ?? {})) input(() => sim.configure(idOf(sim, name), lines));
  sim.runToIdle();
  for (const login of LEARNER_LOGINS[sc.name] ?? []) {
    const s = input(() => sim.cli.open(idOf(sim, login.from), 'console'));
    for (const line of login.lines) {
      input(() => sim.cli.exec(s, line));
      sim.runFor(LOGIN_LINE_NS);
    }
    input(() => sim.cli.close(s));
  }
  sim.runToIdle();
  sim.runFor(30 * SEC);
  return { sim, afterEntry };
}

describe('accept.p3.replay-exact-ccna3: remote sessions included (labs that grade the learner’s own logins)', () => {
  it('knows the labs whose tasks read the learner’s remote logins', () => {
    for (const name of Object.keys(LEARNER_LOGINS)) expect(CCNA3_LABS.some((l) => l.name === name), name).toBe(true);
  });

  for (const sc of CCNA3_LABS.filter((l) => LEARNER_LOGINS[l.name] !== undefined)) {
    it(
      `${sc.name}: an admitted and a refused remote login replay to byte-identical trace and snapshot JSON`,
      () => {
        const { sim, afterEntry } = remoteRun(sc);
        const journal = sim.journal();
        const end = sim.position();
        // the learner's logins really happened: one admitted, one refused, recorded by the server
        const seen = logins(sim);
        expect(seen.some((l) => l.endsWith(' success')), `${sc.name}: ${seen.join(', ')}`).toBe(true);
        expect(seen.some((l) => l.endsWith(' refused')), `${sc.name}: ${seen.join(', ')}`).toBe(true);
        expect(journal.entries.some((e) => e.op.op === 'cliExec')).toBe(true);

        // (1) one replay straight to position(): byte-identical trace JSON from the origin's head, and snapshot JSON;
        // every event dispatched and every entry applied (the P2 row's pins, W5 fix #28)
        const whole = createReplay(journal, { traceCapacity: TRACE_CAPACITY });
        const r = whole.advance(end);
        expect(r.reached).toBe(true);
        expect(r.events).toBe(end.dispatched);
        expect(whole.applied).toBe(journal.entries.length);
        expect(whole.position()).toEqual(end);
        const head = journal.origin.counters.traceHead;
        const live = sim.trace(head);
        expect(live.dropped).toBe(0);
        expect(JSON.stringify(whole.sim.trace(head).events)).toBe(JSON.stringify(live.events));
        expect(JSON.stringify(whole.sim.snapshot())).toBe(JSON.stringify(sim.snapshot()));
        expect(logins(whole.sim)).toEqual(seen);

        // (2) every entry, in chunks: the replayed snapshot equals the live one recorded right after that entry —
        // interleaved with (3) a chunked twin in the same realm, as the P2 row's per-scenario case does (W5 fix #28)
        const perEntry = createReplay(journal);
        const twin = createReplay(journal, { traceCapacity: TRACE_CAPACITY });
        let twinDone = false;
        const nudgeTwin = (): void => {
          if (!twinDone) twinDone = twin.advance(end, { maxEvents: CHUNK_TWIN }).reached;
        };
        for (let i = 0; i < journal.entries.length; i++) {
          let guard = 0;
          while (!perEntry.advanceToEntry(i, { maxEvents: CHUNK_PER_ENTRY }).reached) {
            nudgeTwin();
            if (++guard > 1_000_000) throw new Error('never reached the entry');
          }
          nudgeTwin();
          expect(perEntry.applied).toBe(i + 1);
          expect(JSON.stringify(perEntry.sim.snapshot()), `${sc.name} after entry ${i} (${journal.entries[i]!.op.op})`).toBe(afterEntry[i]);
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
        const a = JSON.stringify(perEntry.sim.snapshot());
        const b = JSON.stringify(twin.sim.snapshot());
        expect(a === b, `${sc.name}: the two interleaved replays are identical`).toBe(true);
        expect(b).toBe(JSON.stringify(sim.snapshot()));
        expect(JSON.stringify(twin.sim.trace(head).events)).toBe(JSON.stringify(live.events));
        expect(logins(twin.sim)).toEqual(seen);
        // replays journal nothing of their own
        expect(whole.sim.journal().entries).toEqual([]);
        expect(twin.sim.journal().entries).toEqual([]);
      },
      SCENARIO_TIMEOUT_MS,
    );
  }
});
