/**
 * P2 acceptance — every CCNA 2 lab grades itself (ARCHITECTURE-P2 §10.1 `accept.p2.labs`; §11.2; §7 W7 qa).
 *
 *   "Every CCNA 2 lab: unsolved fails its tasks, the solution passes all, evaluation leaves the live trace head
 *    unchanged."
 *
 * GENERIC over `CCNA2_LABS` (the catalogue the worker lists, in course order — the wired labs of W5 and the wireless
 * lab of W7 alike): nothing about a lab is restated here, the pass condition is the lab's own task list, so a lab whose
 * solution drifts from its tasks, or a task that an untouched world already satisfies, fails this test. "Every CCNA 2
 * lab" is the whole course: the catalogue case checks that `CCNA2_LABS` is exactly the labs the CCNA 2 lessons point at
 * (curriculum/ccna2/lessons.ts), in teaching order, so a lesson whose lab is missing fails here too.
 *
 * Each lab world is built the way the worker loads a lab (`loadScenario`): the lab seed, the lab topology (a P2 world),
 * its scheduled hidden faults injected right after the load, then booted and settled.
 *   1. UNSOLVED — every task fails, so every task discriminates, and says why on a failing assertion; score 0.
 *   2. SOLVED — the reference solution goes through `Simulation.configure` (the call the terminal, the panels and the
 *      worker make) exactly as written, every line accepted; the world runs to idle; every task passes, full marks.
 *   3. READ-ONLY — evaluating (twice) leaves the clock, the live trace head and the PDU count unchanged, and the
 *      snapshot byte-identical; both evaluations agree.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../src/contracts/ids.js';
import type { LabStatus, ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { CCNA2_MODULES } from '../src/curriculum/ccna2/lessons.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { createSimulation } from '../src/sim/simulation.js';
import { CCNA2_LABS, CCNA2_LAB_ORDER } from '../src/sim/scenarios/ccna2/index.js';
import { SCENARIOS } from '../src/sim/scenarios.js';

/** Long enough for every model of a lab to boot (the router takes 45 s); `runToIdle` then waits out spanning tree. */
const BOOT_NS = 90 * SEC;

/** Wall-clock budget of one lab case: two lab worlds plus the grader's clones (one per `connectivity.after` set). */
const LAB_CASE_TIMEOUT_MS = 120_000;

/** The lab's world as the worker loads it: lab seed, lab topology, scheduled faults injected, booted and settled. */
function labWorld(lab: ScenarioInfo): Simulation {
  const sim = createSimulation({ seed: lab.seed ?? 1 });
  sim.loadTopology({ ...lab.build(), lab: { name: lab.name, version: lab.version ?? 1 } });
  for (const f of lab.faults ?? []) sim.injectFault(f.at, f.fault);
  sim.runFor(BOOT_NS);
  sim.runToIdle();
  return sim;
}

function idOf(sim: Simulation, name: string): DeviceId {
  for (const d of sim.devices()) if (d.spec.name === name) return d.id;
  throw new Error(`no device called ${name} in this lab`);
}

/** Tasks that did not pass, each with the details of its failing assertions. */
function failures(status: LabStatus): string[] {
  return status.results
    .filter((r) => !r.pass)
    .map((r) => `${r.task}: ${r.assertions.filter((a) => !a.pass).map((a) => a.detail ?? '(no detail)').join(' | ')}`);
}

describe('P2 acceptance: the CCNA 2 labs grade themselves', () => {
  it('grades the whole course: every lab a CCNA 2 lesson points at, each listed with tasks and a reference solution', () => {
    // the labs the lesson skeleton names, in teaching order (§11.1: the 19 MUST labs and [S2]; [S11]/[S12] lessons
    // are theory-only) — every one exists, in that order, and there is no other
    const lessonLabs = CCNA2_MODULES.flatMap((m) => m.lessons.flatMap((l) => (l.lab === undefined ? [] : [l.lab])));
    expect(lessonLabs.length).toBeGreaterThanOrEqual(20);
    expect(CCNA2_LABS.map((l) => l.name)).toEqual(lessonLabs);
    expect(CCNA2_LABS.map((l) => l.name)).toEqual([...CCNA2_LAB_ORDER]);
    for (const lab of CCNA2_LABS) {
      expect(SCENARIOS, lab.name).toContain(lab);
      expect(lab.category, lab.name).toBe('ccna2-lab');
      expect((lab.tasks ?? []).length, lab.name).toBeGreaterThan(0);
      expect(Object.keys(lab.solution ?? {}).length, lab.name).toBeGreaterThan(0);
    }
  });

  for (const lab of CCNA2_LABS) {
    it(`${lab.name}: unsolved fails its tasks, the reference solution passes all, grading is read-only`, () => {
      const total = (lab.tasks ?? []).reduce((n, t) => n + t.points, 0);
      expect(total, lab.name).toBeGreaterThan(0);

      // 1. Unsolved: every task fails, and says why.
      const unsolved = labWorld(lab);
      expect(unsolved.profile, `${lab.name} is a P2 world`).toBe('P2');
      const before = evaluateLab(unsolved, lab);
      expect(before.lab).toBe(lab.name);
      expect(before.total).toBe(total);
      expect(before.results.map((r) => r.task)).toEqual((lab.tasks ?? []).map((t) => t.id));
      expect(before.results.filter((r) => r.pass).map((r) => r.task), `${lab.name} unsolved`).toEqual([]);
      expect(before.score).toBe(0);
      for (const r of before.results) {
        expect(r.assertions.some((a) => !a.pass && (a.detail ?? '') !== ''), `${lab.name}/${r.task} says why it fails`).toBe(true);
      }

      // 2. Solved through the public configure API, exactly as the lab writes its solution.
      const sim = labWorld(lab);
      for (const [device, lines] of Object.entries(lab.solution ?? {})) {
        const r = sim.configure(idOf(sim, device), lines);
        expect(r.lines.filter((l) => !l.ok).map((l) => `${l.line}: ${l.error?.message ?? l.output}`), `${lab.name} solution for ${device}`).toEqual([]);
        expect(r.ok, `${lab.name} solution for ${device}`).toBe(true);
      }
      sim.runToIdle();

      // 3. Grading reads only: same clock, same trace head, same PDU count, same snapshot.
      const now = sim.now;
      const head = sim.trace(0).next;
      const pdus = sim.snapshot().pduCount;
      const snapshot = JSON.stringify(sim.snapshot());

      const after = evaluateLab(sim, lab);
      const again = evaluateLab(sim, lab);

      expect(failures(after), `${lab.name} solved`).toEqual([]);
      expect(after.score).toBe(total);
      expect(again).toEqual(after);
      expect(sim.now).toBe(now);
      expect(sim.trace(0).next).toBe(head);
      expect(sim.snapshot().pduCount).toBe(pdus);
      expect(JSON.stringify(sim.snapshot())).toBe(snapshot);
    }, LAB_CASE_TIMEOUT_MS);
  }
});
