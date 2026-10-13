/**
 * sim.grade.parity — headless `gradeTopology` against live grading over every CCNA 1–3 lab built so far
 * (ARCHITECTURE-P3 D6 [S37], §2.13; §7 W6 sim; ruling R58 (b), R59 (a): W7 qa; the W7 row `accept.p3.lab-document`
 * builds on the same harness, test/sim.grade.harness.ts).
 *
 * GENERIC over `CCNA1_LABS`, `CCNA2_LABS` and `CCNA3_LABS` (read when the file is collected, so a lab that lands later
 * is covered without an edit here). For each lab, ONE live world plays the learner (the harness's `learnerWorld`: the
 * lab loaded as the worker's `loadScenario` loads it, booted for 90 s and settled). At two points of that world —
 *   • UNSOLVED: as loaded, every scheduled fault landed;
 *   • SOLVED: the reference solution and the learner's actions (the harness's `solve`), settled. There the live grader
 *     must give every lab with a solution full marks, so a lab whose learner actions are missing from LEARNER_ACTIONS
 *     fails here instead of passing vacuously —
 * the world is saved (`exportTopology`) and three statuses are taken:
 *   L  the live grader on the learner's world (`evaluateLab(world, lab)`), what the app shows on Check;
 *   H  `gradeTopology(labDocumentOf(lab), saved)`, the headless grade of the saved world from the lab's document;
 *   R  the live grader on the saved world reopened in a fresh session: the saved seed, the file loaded (a reopened
 *      file activates its lab by name and injects no scheduled fault, P1 §4.13), GRADE_SETTLE_MS of simulated time,
 *      then idle, then Check with the built-in lab.
 * Asserted:
 *   0. R58 (b)'s rule (`runtimeTableOf`) names exactly the harness's NOT_GRADABLE_HEADLESS_ASSERTIONS of the lab, and H
 *      reports each of them, at both points, as not gradable headless, counted neither in `score` nor in `total`
 *      (`expectHeadlessShape`). This is what the W6 allow-list's 'learner history' entries became (§9.2 W7).
 *   1. H equals R for every assertion gradable headless, `checkedAt` included, and exactly (the whole status) for a lab
 *      with none of them: grading the saved world from the document on a server equals grading it in the app once it
 *      is reopened (the document carries everything grading needs, and the submission — not the document's own
 *      topology — is what is graded, with the submission's seed and profile).
 *   2. H equals L for every assertion gradable headless, `checkedAt` aside, EXCEPT exactly the assertions the harness's
 *      RELOAD_DIFFERENCES names (what a reload resets and no save records: a P2 world's err-disabled ports, renumbered
 *      access-list entries, device clocks). A listed assertion must really differ (a stale entry fails), every other
 *      assertion and every task without an entry must be equal, and with no entry at the point the whole status must
 *      be equal (score included).
 *   3. Grading reads its inputs only: the saved world and the document are unchanged by `gradeTopology`.
 */
import { describe, expect, it } from 'vitest';
import { labDocumentOf } from '../src/contracts/lab-document.js';
import type { LabStatus, ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { MS } from '../src/contracts/time.js';
import type { Topology } from '../src/contracts/topology.js';
import { GRADE_SETTLE_MS, gradeTopology, isDocumentTopology } from '../src/sim/grade.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { createSimulation } from '../src/sim/simulation.js';
import {
  LABS,
  LAB_TEST_TIMEOUT_MS,
  LEARNER_ACTIONS,
  NOT_GRADABLE_HEADLESS_ASSERTIONS,
  RELOAD_DIFFERENCES,
  differingIndexes,
  expectHeadlessShape,
  expectParity,
  expectRuleNamesTheList,
  learnerWorld,
  solve,
  type Point,
} from './sim.grade.harness.js';

/** R: the saved file reopened in a fresh session and checked once settled (file header). */
function reopenedStatus(lab: ScenarioInfo, saved: Topology): LabStatus {
  const sim = createSimulation({ seed: saved.seed });
  sim.loadTopology(saved);
  sim.runFor(GRADE_SETTLE_MS * MS);
  sim.runToIdle();
  return evaluateLab(sim, lab);
}

/** Grade one point: L, H and R, with assertions 0–3 of the file header. */
function gradePoint(lab: ScenarioInfo, point: Point, sim: Simulation): void {
  const doc = labDocumentOf(lab);
  const saved = sim.exportTopology();
  const docText = JSON.stringify(doc);
  const savedText = JSON.stringify(saved);
  // a booted world's save is never the document's own topology (that one is graded with its scheduled faults)
  expect(isDocumentTopology(doc, saved), `${lab.name} (${point}): the saved world reads as the document's topology`).toBe(false);
  const live = evaluateLab(sim, lab);
  const headless = gradeTopology(doc, saved);
  expect(JSON.stringify(doc), `${lab.name} (${point}): gradeTopology changed the document`).toBe(docText);
  expect(JSON.stringify(saved), `${lab.name} (${point}): gradeTopology changed the submission`).toBe(savedText);
  expectHeadlessShape(lab, point, headless);
  expectParity(lab, point, reopenedStatus(lab, saved), headless, () => new Set(), 'the reopened file', true);
  expectParity(lab, point, live, headless, (task) => differingIndexes(lab, point, task), "the learner's world", false);
}

describe('the named assertions name labs and tasks that exist', () => {
  it('every RELOAD_DIFFERENCES and NOT_GRADABLE_HEADLESS_ASSERTIONS entry names a lab of the parity and a task of that lab', () => {
    for (const d of [...RELOAD_DIFFERENCES, ...NOT_GRADABLE_HEADLESS_ASSERTIONS]) {
      const lab = LABS.find((l) => l.name === d.lab);
      expect(lab, `${d.lab} is not a CCNA 1–3 lab`).toBeDefined();
      expect(lab?.tasks?.some((t) => t.id === d.task), `${d.lab} has no task ${d.task}`).toBe(true);
    }
  });

  it("R58 (b)'s rule names exactly the written-out not-gradable assertions, lab by lab", () => {
    for (const lab of LABS) expectRuleNamesTheList(lab);
    // the labs that read what a running lab records (§9.2 W6b, R58 (b), R59 (a)): 15, 19, 27, 29, 38 and 40
    expect([...new Set(NOT_GRADABLE_HEADLESS_ASSERTIONS.map((d) => d.lab))]).toEqual([
      'ccna3-acl-standard',
      'ccna3-secure-device-access',
      'ccna3-qos-voice-first',
      'ccna3-time-and-logs',
      'ccna3-restconf-change',
      'ccna3-script-inventory',
    ]);
  });
});

describe('gradeTopology equals live grading for every assertion gradable headless', () => {
  it('covers every CCNA 1, 2 and 3 lab built so far', () => {
    expect(LABS.length).toBeGreaterThanOrEqual(15 + 20 + 21);
    expect(new Set(LABS.map((l) => l.name)).size).toBe(LABS.length);
  });

  for (const lab of LABS) {
    it(
      `${lab.name}: the saved world, unsolved and solved, grades as live`,
      () => {
        const sim = learnerWorld(lab);
        gradePoint(lab, 'unsolved', sim);
        solve(sim, lab);
        if (lab.solution !== undefined || LEARNER_ACTIONS[lab.name] !== undefined) {
          // the solved point is solved: a lab whose learner actions are missing from LEARNER_ACTIONS fails here
          const solved = evaluateLab(sim, lab);
          expect(solved.score, `${lab.name}: the solution and the learner actions do not earn full marks live`).toBe(solved.total);
        }
        gradePoint(lab, 'solved', sim);
      },
      LAB_TEST_TIMEOUT_MS,
    );
  }
});
