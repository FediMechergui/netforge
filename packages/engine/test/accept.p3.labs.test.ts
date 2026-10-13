/**
 * P3 acceptance — every CCNA 3 lab grades itself (ARCHITECTURE-P3 §10.1 `accept.p3.labs`; §11.1, §11.2; §7 W7 qa).
 *
 *   "Every CCNA 3 lab: unsolved fails its tasks, the solution passes all, evaluation leaves the live trace head
 *    unchanged."
 *
 * The twin of `accept.p2.labs`. GENERIC over `CCNA3_LABS` (the catalogue the worker lists, in course order): nothing
 * about a lab is restated here, the pass condition is the lab's own task list, so a lab whose solution drifts from its
 * tasks, or a task that an untouched world already satisfies, fails this test. "Every CCNA 3 lab" is the whole course:
 * the catalogue case checks that `CCNA3_LABS` is exactly the labs the CCNA 3 lessons point at
 * (curriculum/ccna3/lessons.ts), in teaching order — the 21 labs of the approved plan (§8.4, §8.5) — so a lesson whose
 * lab is missing fails here too.
 *
 * Each lab world is built the way the worker loads a lab (`loadScenario`): the lab seed, the lab topology (a P3 world),
 * its scheduled hidden faults injected right after the load, then booted and settled.
 *   1. UNSOLVED — every task fails, so every task discriminates, and says why on a failing assertion; score 0. Grading
 *      the untouched world is read-only too (clock, trace head, PDU count and snapshot unchanged).
 *   2. SOLVED — the reference solution goes through `Simulation.configure` (the call the terminal, the panels and the
 *      worker make) exactly as written, every line accepted; the world runs to idle; then the actions the lab asks the
 *      learner to take before Check, which its lab file gives as data (labs 15 and 19: the remote logins graded live
 *      through the remote terminal, §11.2; lab 27: the voice burst, §3.5 step 8; lab 38: the RESTCONF requests, §3.8
 *      step 7; lab 40: the run of the inventory script on DEV1, §3.8 step 8), typed on the hosts' consoles; settled.
 *      Every task passes: full marks.
 *   3. READ-ONLY — evaluating (twice) leaves the clock, the live trace head and the PDU count unchanged, and the
 *      snapshot byte-identical; both evaluations agree.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../src/contracts/ids.js';
import type { LabStatus, ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { CCNA3_MODULES } from '../src/curriculum/ccna3/lessons.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import {
  ACL_STANDARD_LOGINS,
  CCNA3_LABS,
  CCNA3_LAB_ORDER,
  QOS_LEARNER_FLOWS,
  RESTCONF_LAB_REQUESTS,
  SCRIPT_LAB_RUNS,
  SECURE_ACCESS_LOGINS,
} from '../src/sim/scenarios/ccna3/index.js';
import { SCENARIOS } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';

/** Long enough for every model of a lab to boot (the router takes 45 s); `runToIdle` then waits out the elections. */
const BOOT_NS = 90 * SEC;

/** Sim time after each line a learner types (a remote login's connection, login and logout; a flow; a request; a run). */
const LEARNER_LINE_NS = 5 * SEC;

/** Wall-clock budget of one lab case: two lab worlds plus the grader's clones (one per fault set a task names). */
const LAB_CASE_TIMEOUT_MS = 300_000;

/** The labs of the approved plan (§8.4, §8.5: 16 MUST labs and the approved items' labs, 38 and 40 included). */
const APPROVED_LAB_COUNT = 21;

/** One action a lab asks the learner to take before Check: lines typed on a host's console. */
type LearnerAction = { readonly from: string; readonly lines: readonly string[] };

/**
 * The actions each lab asks the learner to take before Check, exactly as the lab files give them (the same table as
 * labs.ccna3.solutions and sim.grade.parity). A lab not named here is solved by its configuration alone.
 */
const LEARNER_ACTIONS: Readonly<Record<string, readonly LearnerAction[]>> = {
  'ccna3-acl-standard': ACL_STANDARD_LOGINS,
  'ccna3-secure-device-access': SECURE_ACCESS_LOGINS,
  'ccna3-qos-voice-first': QOS_LEARNER_FLOWS,
  'ccna3-restconf-change': RESTCONF_LAB_REQUESTS,
  'ccna3-script-inventory': SCRIPT_LAB_RUNS,
};

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

/** The reference solution through `configure`, exactly as written (every line accepted), then the learner's actions. */
function solve(sim: Simulation, lab: ScenarioInfo): void {
  for (const [device, lines] of Object.entries(lab.solution ?? {})) {
    const r = sim.configure(idOf(sim, device), lines);
    expect(r.lines.filter((l) => !l.ok).map((l) => `${l.line}: ${l.error?.message ?? l.output}`), `${lab.name} solution for ${device}`).toEqual([]);
    expect(r.ok, `${lab.name} solution for ${device}`).toBe(true);
  }
  sim.runToIdle();
  for (const action of LEARNER_ACTIONS[lab.name] ?? []) {
    const s = sim.cli.open(idOf(sim, action.from), 'console');
    for (const line of action.lines) {
      sim.cli.exec(s, line);
      sim.runFor(LEARNER_LINE_NS);
    }
    sim.cli.close(s);
  }
  sim.runToIdle();
}

/** Tasks that did not pass, each with the details of its failing assertions. */
function failures(status: LabStatus): string[] {
  return status.results
    .filter((r) => !r.pass)
    .map((r) => `${r.task}: ${r.assertions.filter((a) => !a.pass).map((a) => a.detail ?? '(no detail)').join(' | ')}`);
}

/**
 * Grade `sim` twice and prove grading read-only: the clock, the live trace head, the PDU count and the snapshot JSON
 * are what they were before, and both evaluations are equal. Returns the status.
 */
function gradeReadOnly(sim: Simulation, lab: ScenarioInfo): LabStatus {
  const now = sim.now;
  const head = sim.trace(0).next;
  const pdus = sim.snapshot().pduCount;
  const snapshot = JSON.stringify(sim.snapshot());

  const first = evaluateLab(sim, lab);
  const again = evaluateLab(sim, lab);

  expect(again, `${lab.name}: two evaluations agree`).toEqual(first);
  expect(sim.now, `${lab.name}: the clock`).toBe(now);
  expect(sim.trace(0).next, `${lab.name}: the live trace head`).toBe(head);
  expect(sim.snapshot().pduCount, `${lab.name}: the PDU count`).toBe(pdus);
  expect(JSON.stringify(sim.snapshot()), `${lab.name}: the snapshot`).toBe(snapshot);
  return first;
}

describe('P3 acceptance: the CCNA 3 labs grade themselves', () => {
  it('grades the whole course: every lab a CCNA 3 lesson points at, each listed with tasks and a reference solution', () => {
    // the labs the lesson skeleton names, in teaching order — every one exists, in that order, and there is no other
    const lessonLabs = CCNA3_MODULES.flatMap((m) => m.lessons.flatMap((l) => (l.lab === undefined ? [] : [l.lab])));
    expect(lessonLabs).toHaveLength(APPROVED_LAB_COUNT);
    expect(CCNA3_LABS.map((l) => l.name)).toEqual(lessonLabs);
    expect(CCNA3_LABS.map((l) => l.name)).toEqual([...CCNA3_LAB_ORDER]);
    for (const lab of CCNA3_LABS) {
      expect(SCENARIOS, lab.name).toContain(lab);
      expect(lab.category, lab.name).toBe('ccna3-lab');
      expect(lab.course, lab.name).toBe('CCNA 3');
      expect((lab.tasks ?? []).length, lab.name).toBeGreaterThan(0);
      expect(Object.keys(lab.solution ?? {}).length, lab.name).toBeGreaterThan(0);
    }
    // every learner action belongs to a lab of the course and is typed on one of its devices
    for (const [name, actions] of Object.entries(LEARNER_ACTIONS)) {
      const lab = CCNA3_LABS.find((l) => l.name === name);
      expect(lab, name).toBeDefined();
      const devices = lab!.build().devices.map((d) => d.name);
      for (const a of actions) {
        expect(devices, `${name}: ${a.from}`).toContain(a.from);
        expect(a.lines.length, `${name}: ${a.from}`).toBeGreaterThan(0);
      }
    }
  });

  for (const lab of CCNA3_LABS) {
    it(`${lab.name}: unsolved fails its tasks, the reference solution passes all, grading is read-only`, () => {
      const total = (lab.tasks ?? []).reduce((n, t) => n + t.points, 0);
      expect(total, lab.name).toBeGreaterThan(0);

      // 1. Unsolved: every task fails, and says why; grading the untouched world reads only.
      const unsolved = labWorld(lab);
      expect(unsolved.profile, `${lab.name} is a P3 world`).toBe('P3');
      const before = gradeReadOnly(unsolved, lab);
      expect(before.lab).toBe(lab.name);
      expect(before.total).toBe(total);
      expect(before.results.map((r) => r.task)).toEqual((lab.tasks ?? []).map((t) => t.id));
      expect(before.results.filter((r) => r.pass).map((r) => r.task), `${lab.name} unsolved`).toEqual([]);
      expect(before.score).toBe(0);
      for (const r of before.results) {
        expect(r.assertions.some((a) => !a.pass && (a.detail ?? '') !== ''), `${lab.name}/${r.task} says why it fails`).toBe(true);
      }

      // 2. Solved through the public configure API, exactly as the lab writes its solution, then the learner's actions.
      const sim = labWorld(lab);
      solve(sim, lab);

      // 3. Grading reads only: same clock, same trace head, same PDU count, same snapshot; full marks.
      const after = gradeReadOnly(sim, lab);
      expect(failures(after), `${lab.name} solved`).toEqual([]);
      expect(after.results.map((r) => r.task)).toEqual((lab.tasks ?? []).map((t) => t.id));
      expect(after.score).toBe(total);
      expect(after.total).toBe(total);
    }, LAB_CASE_TIMEOUT_MS);
  }
});
