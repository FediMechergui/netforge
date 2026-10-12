/**
 * sim/grade.ts — headless grading of a lab document (ARCHITECTURE-P3 D6 [S37], §2.13; §7 W6 sim).
 *
 * `gradeTopology(doc, submission)` grades a saved world against a lab document with nothing but the two of them: it
 * boots the submission in a fresh simulation, settles it, and evaluates the document's tasks there with the live
 * grader itself (`evaluateLab`, sim/lab-checks.ts). It is the seam P3b's assessment engine wraps: a server holding a
 * learner's saved world and the lab's document gets the status the app gives that world once it is reopened.
 *
 * The world (one fresh simulation per call, dropped when the call returns):
 *   • seed — the submission's `seed`. `exportTopology` writes it from the simulation the world was saved from, and
 *     the live grader's clones of that world run with that same seed (sim/lab-checks.ts `settledClone`). The catalog
 *     is the built-in one, as in the app; the profile is the submission's (`loadTopology`: `t.profile ?? 'P1'`); the
 *     journal is off (the world is never replayed).
 *   • load — `loadTopology(submission)`. A submission the topology schema refuses throws its `TopologyLoadError`
 *     before anything is graded. The submission is read, never changed, and so is the document.
 *   • scheduled faults are NOT injected. A saved world already holds in its configuration every change a landed
 *     fault made (the labs' configuration faults are saved fragments), and injecting one again would undo the
 *     learner's repair.
 *   • EXCEPT for the document's own topology. A submission that is `doc.topology` (equal by content, its `lab` stamp
 *     aside: `isDocumentTopology`) is the lab before any of its faults, by definition, so it is graded as the worker
 *     loads the lab (`loadScenario`): the document's seed, every scheduled fault injected at its instant. An untouched
 *     lab file therefore grades as the unsolved lab, never as a repaired one. (A world saved from the app before its
 *     faults landed carries no such proof: closing that case needs a stamp of the pending faults in the saved world,
 *     an architect contract decision; until then such a world grades as one whose faults have landed.)
 *   • settle — `runFor(GRADE_SETTLE_MS)`, then `runToIdle`, each phase capped at LAB_CLONE_BOOT_EVENTS events (a
 *     world that never quiets is graded where the cap leaves it). `runToIdle` alone is the live grader's clone
 *     settle, but it stops as soon as only periodic timers are pending, and some first messages ARE periodic timers:
 *     a router that boots with IPv6 routing arms its first router advertisement as one, so hosts would still be
 *     waiting for their SLAAC addresses. GRADE_SETTLE_MS covers the slowest boot (a router, 45 s) and those first
 *     periodic messages; `runToIdle` then waits out the elections and adjacencies they start. When the document
 *     schedules a fault later than the settled instant, the world then runs to that instant and settles again, so the
 *     grader's "still being prepared" rule (a scheduled fault ahead of the clock, LAB_PREPARING_DETAIL) does not
 *     apply: a saved world is graded as the app grades a reopened file once the lab's preparation time has passed.
 *   • evaluate — `evaluateLab(world, scenarioOf(doc))`: every assertion kind, its clones and its details exactly as
 *     the live grader gives them. `checkedAt` is the settled world's clock.
 *
 * Parity (test/sim.grade.parity.test.ts). The status equals what the live grader gives the same saved world reopened
 * and settled, for every CCNA 1–3 lab, unsolved and solved (a world saved once booted carries its devices' running
 * configurations, so it is never the document's own topology). The document's own topology grades as the
 * live lab once its faults have landed (test/sim.grade.test.ts). Against the world the learner saved it from, it differs
 * exactly where a verdict rests on what a reload resets: a saved world carries configuration, power, cabling and host
 * files, while a port a fault err-disabled, the sequence numbers of access-list entries (renumbered 10, 20, … from
 * the configuration text, D12), the device clocks (no hardware calendar), and the rows the learner's own logins,
 * link changes and generated traffic wrote are runtime state. The parity test names each such assertion.
 *
 * Pure: deterministic (the same document and submission give the same status), keeps nothing between calls (the
 * clone memo of sim/lab-checks.ts is keyed by the fresh world and dropped with it), and never touches a simulation of
 * the caller's. The document is trusted as given, as by `scenarioOf`; validate untrusted input with io/lab-schema.ts
 * (`parseLabDocument`) first.
 */
import { scenarioOf, type LabDocument } from '../contracts/lab-document.js';
import type { LabStatus } from '../contracts/scenario.js';
import { MS, type SimTime } from '../contracts/time.js';
import type { Topology } from '../contracts/topology.js';
import { LAB_CLONE_BOOT_EVENTS, evaluateLab } from './lab-checks.js';
import { canonicalJson } from './lab-checks/core.js';
import { createSimulation } from './simulation.js';

/**
 * @since P3 [S37] Simulated time a submission runs before it is settled to idle (file header): the slowest boot of a
 * lab model (a router, 45 s) plus as long again for the first periodic messages the boot arms.
 */
export const GRADE_SETTLE_MS = 90_000;

/** @since P3 [S37] The latest instant at which `doc` schedules a fault, or 0 when it schedules none. */
export function lastScheduledFaultAt(doc: LabDocument): SimTime {
  let last = 0;
  for (const f of doc.faults ?? []) if (f.at > last) last = f.at;
  return last;
}

/**
 * @since P3 [S37] Whether `submission` is the document's own topology: equal to `doc.topology` by content (canonical
 * JSON), whatever `lab` stamp it carries. Such a world is the lab before any of its scheduled faults (file header).
 */
export function isDocumentTopology(doc: LabDocument, submission: Topology): boolean {
  const { lab: _own, ...own } = doc.topology;
  const { lab: _sub, ...sub } = submission;
  return canonicalJson(sub) === canonicalJson(own);
}

/**
 * @since P3 [S37] Grade `submission`, a saved world of the lab `doc` describes, headless (file header): boot it in a
 * fresh simulation with its own seed and no scheduled fault — or, when it is the document's own topology, with the
 * document's seed and every scheduled fault, as the worker loads the lab — settle it (GRADE_SETTLE_MS, then idle,
 * then past the document's last scheduled fault), and evaluate the document's tasks with `evaluateLab`. Throws what
 * `loadTopology` throws for a submission it refuses.
 */
export function gradeTopology(doc: LabDocument, submission: Topology): LabStatus {
  const lab = scenarioOf(doc);
  const pristine = isDocumentTopology(doc, submission);
  const world = createSimulation({ seed: pristine ? doc.meta.seed : submission.seed, journal: false });
  world.loadTopology(submission);
  if (pristine) for (const f of doc.faults ?? []) world.injectFault(f.at, f.fault);
  const cap = { maxEvents: LAB_CLONE_BOOT_EVENTS };
  world.runFor(GRADE_SETTLE_MS * MS, cap);
  world.runToIdle(LAB_CLONE_BOOT_EVENTS);
  const prepared = lastScheduledFaultAt(doc);
  if (prepared > world.now) {
    world.runUntil(prepared, cap);
    world.runToIdle(LAB_CLONE_BOOT_EVENTS);
  }
  return evaluateLab(world, lab);
}
