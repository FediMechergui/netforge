/**
 * sim/grade.ts — headless grading of a lab document (ARCHITECTURE-P3 D6 [S37], §2.13; §7 W6 sim; rulings R58 (b) and
 * R59 (a), §7 W7 qa).
 *
 * `gradeTopology(doc, submission)` grades a saved world against a lab document with nothing but the two of them: it
 * boots the submission in a fresh simulation, settles it, and evaluates the document's tasks there with the live
 * grader itself (`evaluateLab`, sim/lab-checks.ts). It is the seam P3b's assessment engine wraps: a server holding a
 * learner's saved world and the lab's document gets the status the app gives that world once it is reopened — for
 * every assertion a saved world can prove (below).
 *
 * The world (one fresh simulation per call, dropped when the call returns):
 *   • seed — the submission's `seed`. `exportTopology` writes it from the simulation the world was saved from, and
 *     the live grader's clones of that world run with that same seed (sim/lab-checks.ts `settledClone`). The catalog
 *     is the built-in one, as in the app; the profile is the submission's (`loadTopology`: `t.profile ?? 'P1'`); the
 *     journal is off (the world is never replayed).
 *   • load — `loadTopology(submission)`. A submission the topology schema refuses throws its `TopologyLoadError`
 *     before anything is graded; so does a malformed saved lab state (`parseSavedLabState`, io/lab-schema.ts, with
 *     path-qualified problems such as `lab.pendingFaults[0].at: must be >= 0`). The submission is read, never changed,
 *     and so is the document.
 *   • scheduled faults — the document's own are NOT injected: a saved world already holds in its configuration every
 *     change a landed fault made (the labs' configuration faults are saved fragments), and injecting one again would
 *     undo the learner's repair. What IS replayed is what the save recorded (ruling R58 (b)): `exportTopology` of a P3
 *     lab world writes `lab.pendingFaults`, the scheduled faults that had not landed yet, and `gradeTopology` injects
 *     each at its own instant (a reloaded world restarts at t = 0, as the saved one did), so a world saved before its
 *     faults land — or after a cosmetic edit in the app — is graded on the faulted network. A P1 or P2 save records
 *     none (its export keeps its bytes) and grades as before.
 *   • EXCEPT for the document's own topology. A submission that is `doc.topology` (equal by content, its `lab` section
 *     aside: `isDocumentTopology`) is the lab before any of its faults, by definition, so it is graded as the worker
 *     loads the lab (`loadScenario`): the document's seed, every scheduled fault of the document injected at its
 *     instant (the recorded state of its `lab` section, if any, is ignored). An untouched lab file therefore grades as
 *     the unsolved lab, never as a repaired one.
 *   • err-disabled ports (ruling R58 (b)) — runtime port state a configuration cannot carry. `exportTopology` of a P3 lab
 *     world writes them, with their causes, as `lab.errDisabled`; they are err-disabled again exactly as the live
 *     grader's clone does it: an `err-disable` fault at t = 0 for each, and once the world has settled, again for each
 *     listed port that exists and is not err-disabled (a virtual port the boot creates), then idle once more.
 *   • settle — `runFor(GRADE_SETTLE_MS)`, then `runToIdle`, each phase capped at LAB_CLONE_BOOT_EVENTS events (a
 *     world that never quiets is graded where the cap leaves it). `runToIdle` alone is the live grader's clone
 *     settle, but it stops as soon as only periodic timers are pending, and some first messages ARE periodic timers:
 *     a router that boots with IPv6 routing arms its first router advertisement as one, so hosts would still be
 *     waiting for their SLAAC addresses. GRADE_SETTLE_MS covers the slowest boot (a router, 45 s) and those first
 *     periodic messages; `runToIdle` then waits out the elections and adjacencies they start. When the document (or
 *     the recorded state) schedules a fault later than the settled instant, the world then runs to that instant and
 *     settles again, so the grader's "still being prepared" rule (a scheduled fault ahead of the clock,
 *     LAB_PREPARING_DETAIL) does not apply: a saved world is graded once the lab's preparation time has passed.
 *   • evaluate — `evaluateLab(world, scenarioOf(doc))`: every assertion kind, its clones and its details exactly as
 *     the live grader gives them. `checkedAt` is the settled world's clock.
 *
 * Not gradable headless (ruling R58 (b), R59 (a)). Some tables record what happened while the lab ran — the learner's
 * remote logins (`vty-logins`), the hits of the access lists (the hit members of an `acl` row, ACL_HIT_MEMBERS: its
 * rows themselves are written from the configuration and rebuilt alike by a reload), generated traffic (`flows`), the
 * log lines a server received (`syslog-messages`), the API requests a device answered (`restconf-log`) and the script
 * runs of a developer host (`script-runs`): RUNTIME_ONLY_TABLES. A save does not carry them (a reload empties them), so
 * an assertion whose verdict rests on one — a `table` assertion on one (on `acl`, one whose `where` or `whereOps` names
 * a hit member), an `acl` assertion with `minMatches` (the hit count of the `acl` table), a `fact` whose reader's
 * source names one (`vty.logins`, `automation.lastRun`): `runtimeTableOf` — is reported with the third status
 * NOT_GRADABLE_HEADLESS, beside pass and fail and never counted
 * as either. Its result entry is `{index, pass: false, detail, status: 'not-gradable-headless'}` (the contract's
 * `pass` is a boolean; `status` overrides it); its task:
 *   – fails, as live grading must, when another of its assertions fails (its points count in `total`, never in
 *     `score`; its `misconception` is that of its first failing gradable assertion);
 *   – otherwise is itself not gradable headless (`status` on the task, `pass: false`, 0 points), and its points are
 *     counted neither in `score` nor in `total` but in `notGradableHeadless`.
 * A lab with no such assertion gets the live grader's status unchanged (no `status`, no `notGradableHeadless`).
 *
 * Parity (test/sim.grade.parity.test.ts, test/accept.p3.lab-document.test.ts). For every CCNA 1–3 lab, unsolved and
 * solved, the headless status of the saved world equals what the live grader gives the same saved world reopened and
 * settled, and equals the live grade of the learner's own world, for every assertion gradable headless; the others are
 * exactly the assertions `runtimeTableOf` names. Against the learner's world a few more differ where a verdict rests on
 * what a reload resets and no save records: the sequence numbers of access-list entries (renumbered 10, 20, … from the
 * configuration text, D12), the device clocks (no hardware calendar), and the err-disabled ports of a P2 world (a P2
 * save keeps its P2 bytes). The parity test names each one.
 *
 * Pure: deterministic (the same document and submission give the same status), keeps nothing between calls (the
 * clone memo of sim/lab-checks.ts is keyed by the fresh world and dropped with it), and never touches a simulation of
 * the caller's. The document is trusted as given, as by `scenarioOf`; validate untrusted input with io/lab-schema.ts
 * (`parseLabDocument`) first.
 */
import type { FaultSpec } from '../contracts/events.js';
import { scenarioOf, type LabDocument } from '../contracts/lab-document.js';
import type { LabAssertion, LabCheckResult, LabStatus, ScenarioInfo } from '../contracts/scenario.js';
import type { TableName } from '../contracts/tables.js';
import { MS, type SimTime } from '../contracts/time.js';
import type { Topology, TopologyErrDisabledPort, TopologyPendingFault } from '../contracts/topology.js';
import { parseSavedLabState, type SavedLabState } from '../io/lab-schema.js';
import { LAB_CLONE_BOOT_EVENTS, evaluateLab, misconceptionOf } from './lab-checks.js';
import { canonicalJson } from './lab-checks/core.js';
import { FACT_READERS } from './lab-checks/facts.js';
import { createSimulation } from './simulation.js';

/**
 * @since P3 [S37] Simulated time a submission runs before it is settled to idle (file header): the slowest boot of a
 * lab model (a router, 45 s) plus as long again for the first periodic messages the boot arms.
 */
export const GRADE_SETTLE_MS = 90_000;

/** @since P3 (ruling R58 (b)) The third status of a headless grade, beside pass and fail (file header). */
export const NOT_GRADABLE_HEADLESS = 'not-gradable-headless';
/** @since P3 (ruling R58 (b)) */
export type NotGradableHeadless = typeof NOT_GRADABLE_HEADLESS;

/**
 * @since P3 (rulings R58 (b), R59 (a)) The tables that record what happened while a lab ran, which a saved world does
 * not carry (file header), in the rulings' order. For `acl` it is the hit members of a row only (ACL_HIT_MEMBERS): the
 * rows themselves, one per entry of a list applied as a filter, are configuration, which a reload rebuilds alike.
 */
export const RUNTIME_ONLY_TABLES: readonly TableName[] = Object.freeze(['vty-logins', 'acl', 'flows', 'syslog-messages', 'restconf-log', 'script-runs']);

/**
 * @since P3 (ruling R58 (b): "`acl` hit rows") The members of an `acl` row a hit writes (`AclRow`: the hit count, the
 * last match and its instant), which a reload resets; every other member is written from the configuration alone.
 */
export const ACL_HIT_MEMBERS: readonly string[] = Object.freeze(['matches', 'lastPdu', 'lastAt', 'lastIface', 'lastDir', 'updatedAt']);

/** @since P3 (ruling R58 (b)) The detail of an assertion that is not gradable headless: it reads `table`. */
export function notGradableHeadlessDetail(table: TableName): string {
  return `Not graded from a saved file: this check reads the ${table} table, which records what happened while the lab was running and is empty once the file is reopened.`;
}

/** @since P3 (ruling R58 (b)) One assertion's result in a headless grade: the live entry, or a not-gradable one. */
export interface HeadlessAssertionResult {
  index: number;
  /** False for a not-gradable assertion, whose `status` says it was not graded (never counted as a fail). */
  pass: boolean;
  detail?: string;
  /** Present only on an assertion that is not gradable headless. */
  status?: NotGradableHeadless;
}

/** @since P3 (ruling R58 (b)) One task's result in a headless grade (file header). */
export interface HeadlessCheckResult extends LabCheckResult {
  assertions: HeadlessAssertionResult[];
  /** Present only on a task whose gradable assertions all pass and that has one not gradable headless. */
  status?: NotGradableHeadless;
}

/**
 * @since P3 (ruling R58 (b)) A headless grade: a `LabStatus` whose not-gradable assertions and tasks carry `status`,
 * whose `score` and `total` count the graded tasks only, and whose `notGradableHeadless` (present only when > 0) holds
 * the points of the tasks it could not grade.
 */
export interface HeadlessLabStatus extends LabStatus {
  results: HeadlessCheckResult[];
  notGradableHeadless?: number;
}

const hasOwn = (o: object, k: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** The table a reader's source names first (`script-runs.state` → `script-runs`), or undefined. */
function sourceTable(source: string): TableName | undefined {
  const name = /^[a-z0-9-]+/.exec(source)?.[0];
  return name !== undefined && RUNTIME_ONLY_TABLES.includes(name) ? name : undefined;
}

/**
 * @since P3 (rulings R58 (b), R59 (a)) The runtime-only table `a`'s verdict rests on (file header), or undefined when a
 * saved world can prove it: a `table` assertion on one of RUNTIME_ONLY_TABLES (on `acl`, only when its `where` or
 * `whereOps` names one of ACL_HIT_MEMBERS: a row's list, entry, action or binding is configuration), an `acl` assertion
 * with `minMatches` (`acl`), a `fact` whose FACT_READERS source names one. Follow-up checks inside a clone
 * (`connectivity.then`) read the clone's own tables, which grade alike live and headless, so they never count.
 */
export function runtimeTableOf(a: LabAssertion): TableName | undefined {
  switch (a.kind) {
    case 'table':
      if (a.table === 'acl') {
        const members = [...Object.keys(a.where), ...Object.keys(a.whereOps ?? {})];
        return members.some((m) => ACL_HIT_MEMBERS.includes(m)) ? 'acl' : undefined;
      }
      return RUNTIME_ONLY_TABLES.includes(a.table) ? a.table : undefined;
    case 'acl':
      return a.minMatches !== undefined ? 'acl' : undefined;
    case 'fact': {
      const reader = hasOwn(FACT_READERS, a.fact) ? FACT_READERS[a.fact] : undefined;
      return reader === undefined ? undefined : sourceTable(reader.source);
    }
    default:
      return undefined;
  }
}

/** @since P3 [S37] The latest instant at which `doc` schedules a fault, or 0 when it schedules none. */
export function lastScheduledFaultAt(doc: LabDocument): SimTime {
  return lastFaultAt(doc.faults ?? []);
}

/** The latest instant of `faults`, or 0. */
function lastFaultAt(faults: readonly { readonly at: SimTime }[]): SimTime {
  let last = 0;
  for (const f of faults) if (f.at > last) last = f.at;
  return last;
}

/**
 * @since P3 [S37] Whether `submission` is the document's own topology: equal to `doc.topology` by content (canonical
 * JSON), whatever `lab` section it carries. Such a world is the lab before any of its scheduled faults (file header).
 */
export function isDocumentTopology(doc: LabDocument, submission: Topology): boolean {
  const { lab: _own, ...own } = doc.topology;
  const { lab: _sub, ...sub } = submission;
  return canonicalJson(sub) === canonicalJson(own);
}

/** The saved lab state of the document's own topology: nothing recorded (its faults are the document's). */
const NOTHING_SAVED: SavedLabState = Object.freeze({ pendingFaults: Object.freeze([]), errDisabled: Object.freeze([]) });

/** The `err-disable` fault that err-disables a recorded port again (sim/lab-checks.ts `settledClone`'s form). */
function errDisableFault(p: TopologyErrDisabledPort): FaultSpec {
  return { id: `grade-errdisable:${p.device}:${p.port}`, kind: 'err-disable', target: { device: p.device, port: p.port }, params: { cause: p.cause } };
}

/**
 * @since P3 (ruling R58 (b)) The headless status of `live`, the live grader's status of the graded world: every
 * assertion `runtimeTableOf` names becomes not gradable headless, and tasks, score and total follow (file header).
 * `live` itself when no task has such an assertion.
 */
export function headlessStatus(lab: ScenarioInfo, live: LabStatus): HeadlessLabStatus {
  const tasks = lab.tasks ?? [];
  const tables = tasks.map((t) => t.assertions.map(runtimeTableOf));
  if (tables.every((ts) => ts.every((t) => t === undefined))) return live;
  let score = 0;
  let total = 0;
  let notGradable = 0;
  const results = live.results.map((r, i): HeadlessCheckResult => {
    const task = tasks[i];
    const ts = tables[i] ?? [];
    if (task === undefined || task.id !== r.task) throw new Error(`gradeTopology: result ${i} (${r.task}) is not the lab's task ${i}`);
    if (ts.every((t) => t === undefined)) {
      total += task.points;
      if (r.pass) score += task.points;
      return r;
    }
    const assertions = r.assertions.map((a, j): HeadlessAssertionResult => {
      const table = ts[j];
      return table === undefined ? a : { index: a.index, pass: false, detail: notGradableHeadlessDetail(table), status: NOT_GRADABLE_HEADLESS };
    });
    const gradableFailed = assertions.some((a, j) => ts[j] === undefined && !a.pass);
    if (!gradableFailed) {
      notGradable += task.points;
      return { task: r.task, pass: false, points: 0, assertions, status: NOT_GRADABLE_HEADLESS };
    }
    total += task.points;
    const out: HeadlessCheckResult = { task: r.task, pass: false, points: 0, assertions };
    const misconception = misconceptionOf(
      task.assertions,
      assertions.map((a, j) => (ts[j] === undefined ? a : { pass: true })),
    );
    if (misconception !== undefined) out.misconception = misconception;
    return out;
  });
  const status: HeadlessLabStatus = { lab: live.lab, checkedAt: live.checkedAt, score, total, results };
  if (notGradable > 0) status.notGradableHeadless = notGradable;
  return status;
}

/**
 * @since P3 [S37] Grade `submission`, a saved world of the lab `doc` describes, headless (file header): boot it in a
 * fresh simulation with its own seed and the faults and err-disabled ports its save recorded (R58 (b)) — or, when it
 * is the document's own topology, with the document's seed and every scheduled fault, as the worker loads the lab —
 * settle it (GRADE_SETTLE_MS, then idle, then past the last scheduled fault), evaluate the document's tasks with
 * `evaluateLab`, and report the assertions that read a runtime-only table as not gradable headless. Throws what
 * `loadTopology` throws for a submission it refuses, and a `TopologyLoadError` for a malformed saved lab state.
 */
export function gradeTopology(doc: LabDocument, submission: Topology): HeadlessLabStatus {
  const lab = scenarioOf(doc);
  const pristine = isDocumentTopology(doc, submission);
  const world = createSimulation({ seed: pristine ? doc.meta.seed : submission.seed, journal: false });
  world.loadTopology(submission);
  const saved = pristine ? NOTHING_SAVED : parseSavedLabState(submission);
  const faults: readonly TopologyPendingFault[] = pristine ? (doc.faults ?? []) : saved.pendingFaults;
  for (const f of faults) world.injectFault(f.at, f.fault);
  for (const p of saved.errDisabled) world.injectFault(0, errDisableFault(p));
  const cap = { maxEvents: LAB_CLONE_BOOT_EVENTS };
  world.runFor(GRADE_SETTLE_MS * MS, cap);
  world.runToIdle(LAB_CLONE_BOOT_EVENTS);
  // a recorded port the boot created (absent at t = 0) is err-disabled now, as the live grader's clone does it
  const late = saved.errDisabled.filter((p) => {
    const port = world.device(p.device)?.port(p.port);
    return port !== undefined && port.errDisabled === undefined;
  });
  if (late.length > 0) {
    for (const p of late) world.injectFault(world.now, errDisableFault(p));
    world.runToIdle(LAB_CLONE_BOOT_EVENTS);
  }
  const prepared = Math.max(lastScheduledFaultAt(doc), lastFaultAt(faults));
  if (prepared > world.now) {
    world.runUntil(prepared, cap);
    world.runToIdle(LAB_CLONE_BOOT_EVENTS);
  }
  return headlessStatus(lab, evaluateLab(world, lab));
}
