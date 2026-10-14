/**
 * P3c acceptance — every CCNA 3 lab of cad4ac9 grades exactly as P3a graded it (ARCHITECTURE-P3C §0 rule 5, D3, §7 W0,
 * §9.5, §10.1 row `accept.p3c.lab-status-p3`; recorded in W0 from the unchanged engine at cad4ac9). The twin of
 * `accept.p3.lab-status` (lab-status.p2.json) for the P3 profile.
 *
 * test/goldens/lab-status.p3.json holds the `evaluateLab` status of the 21 CCNA 3 labs of cad4ac9 (course order then),
 * with every task result and every assertion's pass flag and detail string, at two points of one world per lab:
 *   • UNSOLVED at 60 s — the lab loaded exactly as the worker's `loadScenario` loads it (the lab seed, else
 *     SCENARIO_SEED; the lab stamp; the scheduled faults injected), then `runFor(60 s)`: every model has booted and
 *     every hidden fault has landed;
 *   • SOLVED at the end — the reference solution through `Simulation.configure` exactly as written (every line
 *     accepted), then `runFor(650 s)`, to 710 s: the end of the P3 golden's fixed script (D3), with none of its typed
 *     probes. Only the reference solution is applied: the learner actions a few labs grade live (the remote logins of
 *     labs 15 and 19, the voice burst of lab 27, the RESTCONF requests of lab 38, the script run of lab 40; their lab
 *     files give them as data for labs.ccna3.solutions) are NOT performed here, so those labs record the partial score
 *     the solution alone earns, detail strings included. The proof is equality with cad4ac9, not full marks.
 * Both must equal the golden exactly; a mismatch names the lab, the point, the task and the assertion with both detail
 * strings. The lab list is the golden's own (its keys, frozen at cad4ac9 by lab id), never the live `CCNA3_LABS`: the
 * labs P3c inserts in lesson order are proved by `accept.p3c.labs`, not here. §9.5 lists the only allowed changes.
 *
 * Regenerating (the architect only, and only for a §9.5 change, entry by entry):
 *   NF_RECORD_LAB_STATUS_P3=<lab,lab,…|all> npx vitest run --root packages/engine test/accept.p3c.lab-status-p3.test.ts
 * re-records the named labs, keeps every other entry, prints which labs changed, and refuses a lab whose solution lines
 * were refused. A first recording (no golden yet) takes the lab list from `CCNA3_LABS` of the engine it runs on, which
 * must be cad4ac9's 21.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { assert, beforeAll, describe, expect, it } from 'vitest';
import type { LabStatus, ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { CCNA3_LABS, SCENARIOS, SCENARIO_SEED } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';

/** Unsolved: every model booted (the router takes 45 s) and every hidden fault landed. */
const UNSOLVED_NS = 60 * SEC;
/** Solved: after the solution, to the end of the P3 golden's fixed script (60 s + 30 s + 20 s + 600 s = 710 s). */
const SOLVED_RUN_NS = 650 * SEC;
const SCRIPT = { unsolvedAtS: UNSOLVED_NS / SEC, solvedAtS: (UNSOLVED_NS + SOLVED_RUN_NS) / SEC };
/** Wall-clock budget of one lab case (one world, two gradings with their clones). */
const LAB_CASE_TIMEOUT_MS = 120_000;
/** The CCNA 3 labs of cad4ac9. */
const CAD4AC9_LAB_COUNT = 21;

/** Both statuses of one lab. */
interface LabEntry {
  readonly unsolved: LabStatus;
  readonly solved: LabStatus;
}

/** Contents of test/goldens/lab-status.p3.json. */
interface StatusGolden {
  readonly about: string;
  readonly script: typeof SCRIPT;
  readonly labs: Readonly<Record<string, LabEntry>>;
}

const GOLDEN_URL = new URL('./goldens/lab-status.p3.json', import.meta.url);

const ABOUT =
  'Lab status of every CCNA 3 lab of cad4ac9 (ARCHITECTURE-P3C D3, §9.5, §10.1 accept.p3c.lab-status-p3), recorded ' +
  'from the unchanged engine at commit cad4ac9 before any P3c code: the evaluateLab status, with every detail string, ' +
  'unsolved at 60 s and solved at 710 s (the reference solution applied at 60 s, no learner action). The labs are the ' +
  'keys of this file, frozen by lab id. Change it only as P3C §9.5 allows, entry by entry, by re-recording with ' +
  'NF_RECORD_LAB_STATUS_P3.';

let goldenCache: StatusGolden | undefined;

function golden(): StatusGolden {
  if (goldenCache === undefined) {
    if (!existsSync(GOLDEN_URL)) throw new Error('test/goldens/lab-status.p3.json is missing; it is recorded once, from the unchanged engine at cad4ac9 (P3C §7 W0).');
    goldenCache = JSON.parse(readFileSync(GOLDEN_URL, 'utf8')) as StatusGolden;
  }
  return goldenCache;
}

/** The frozen labs: the golden's keys, or (first recording only) the live CCNA 3 labs, which must be cad4ac9's 21. */
function labs(): readonly ScenarioInfo[] {
  const names = existsSync(GOLDEN_URL) ? Object.keys(golden().labs) : CCNA3_LABS.map((l) => l.name);
  return names.map((name) => {
    const lab = SCENARIOS.find((s) => s.name === name);
    if (lab === undefined) throw new Error(`lab-status.p3.json names ${name}, which this build does not have`);
    return lab;
  });
}

function idOf(sim: Simulation, name: string): string {
  for (const d of sim.devices()) if (d.spec.name === name) return d.id;
  throw new Error(`no device called ${name} in this lab`);
}

/** One graded run of a lab: both statuses (JSON copies) and the solution lines the CLI refused. */
interface LabRun {
  readonly entry: LabEntry;
  readonly refused: readonly string[];
}

/** Load as the worker does, grade at 60 s, apply the solution, run to 710 s, grade again. */
function gradeLab(lab: ScenarioInfo): LabRun {
  const sim = createSimulation({ seed: lab.seed ?? SCENARIO_SEED });
  sim.loadTopology({ ...lab.build(), lab: { name: lab.name, version: lab.version ?? 1 } });
  for (const f of lab.faults ?? []) sim.injectFault(f.at, f.fault);
  sim.runFor(UNSOLVED_NS);
  const unsolved = JSON.parse(JSON.stringify(evaluateLab(sim, lab))) as LabStatus;
  const refused: string[] = [];
  for (const [device, lines] of Object.entries(lab.solution ?? {})) {
    const r = sim.configure(idOf(sim, device), lines);
    for (const l of r.lines) if (!l.ok) refused.push(`${device}: ${l.line}: ${l.error?.message ?? l.output}`);
  }
  sim.runFor(SOLVED_RUN_NS);
  const solved = JSON.parse(JSON.stringify(evaluateLab(sim, lab))) as LabStatus;
  return { entry: { unsolved, solved }, refused };
}

const runCache = new Map<string, LabRun>();

function freshRun(lab: ScenarioInfo): LabRun {
  let run = runCache.get(lab.name);
  if (run === undefined) {
    run = gradeLab(lab);
    runCache.set(lab.name, run);
  }
  return run;
}

/** Empty when `got` equals `expected`; otherwise every task and assertion that differs, with both details. */
function statusReport(lab: string, point: 'unsolved' | 'solved', expected: LabStatus, got: LabStatus): string {
  if (JSON.stringify(expected) === JSON.stringify(got)) return '';
  const out = [`${lab} (${point}): the lab status differs from test/goldens/lab-status.p3.json (ARCHITECTURE-P3C §9.5 lists the only allowed changes).`];
  for (const key of ['lab', 'checkedAt', 'score', 'total'] as const) {
    if (expected[key] !== got[key]) out.push(`  ${key}: ${JSON.stringify(expected[key])} → ${JSON.stringify(got[key])}`);
  }
  const tasks = [...new Set([...expected.results.map((r) => r.task), ...got.results.map((r) => r.task)])];
  for (const task of tasks) {
    const was = expected.results.find((r) => r.task === task);
    const now = got.results.find((r) => r.task === task);
    if (JSON.stringify(was) === JSON.stringify(now)) continue;
    if (was === undefined || now === undefined) {
      out.push(`  task ${task}: ${was === undefined ? 'not in the golden' : 'missing from this run'}`);
      continue;
    }
    out.push(`  task ${task}: pass ${String(was.pass)} → ${String(now.pass)}, points ${was.points} → ${now.points}`);
    for (let i = 0; i < Math.max(was.assertions.length, now.assertions.length); i++) {
      const a = was.assertions[i];
      const b = now.assertions[i];
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
      out.push(`    assertion ${i}: golden ${JSON.stringify(a)}`, `    ${' '.repeat(String(i).length + 10)}run    ${JSON.stringify(b)}`);
    }
  }
  if (out.length === 1) out.push('  (same content, different key order)');
  return out.join('\n');
}

const RECORD = (process.env['NF_RECORD_LAB_STATUS_P3'] ?? '').trim();

/** Re-record the labs `RECORD` names (`all` = every lab), keeping every other entry. */
function record(): void {
  const all = labs();
  if (!existsSync(GOLDEN_URL) && all.length !== CAD4AC9_LAB_COUNT) throw new Error(`a first recording runs on cad4ac9 (21 CCNA 3 labs); this build has ${all.length}`);
  const names = RECORD === 'all' ? all.map((l) => l.name) : RECORD.split(',').map((s) => s.trim()).filter((s) => s !== '');
  for (const name of names) if (!all.some((l) => l.name === name)) throw new Error(`NF_RECORD_LAB_STATUS_P3 names ${name}, which is not a lab of lab-status.p3.json`);
  const previous = existsSync(GOLDEN_URL) ? golden() : undefined;
  const out: Record<string, LabEntry> = {};
  for (const lab of all) {
    const old = previous?.labs[lab.name];
    if (!names.includes(lab.name)) {
      if (old === undefined) throw new Error(`${lab.name} has no golden entry yet; re-record it too`);
      out[lab.name] = old;
      continue;
    }
    const run = freshRun(lab);
    if (run.refused.length > 0) throw new Error(`refusing to record ${lab.name}:\n  ${run.refused.join('\n  ')}`);
    if (old !== undefined) {
      const report = [statusReport(lab.name, 'unsolved', old.unsolved, run.entry.unsolved), statusReport(lab.name, 'solved', old.solved, run.entry.solved)].filter((r) => r !== '');
      console.log(report.length === 0 ? `${lab.name}: unchanged` : `${lab.name}: re-recorded\n${report.join('\n')}`);
    } else {
      console.log(`${lab.name}: recorded, unsolved ${run.entry.unsolved.score}/${run.entry.unsolved.total}, solved ${run.entry.solved.score}/${run.entry.solved.total}`);
    }
    out[lab.name] = run.entry;
  }
  const file: StatusGolden = { about: ABOUT, script: SCRIPT, labs: out };
  writeFileSync(GOLDEN_URL, `${JSON.stringify(file, null, 2)}\n`);
  goldenCache = file;
}

describe('accept P3c: every CCNA 3 lab of cad4ac9 grades exactly as P3a graded it', () => {
  beforeAll(() => {
    if (RECORD !== '') record();
  }, 900_000);

  it('covers the 21 CCNA 3 labs of cad4ac9, frozen by lab id, in their course order then', () => {
    const all = labs();
    expect(all).toHaveLength(CAD4AC9_LAB_COUNT);
    for (const lab of all) expect(lab.category, lab.name).toBe('ccna3-lab');
    // every frozen lab is still a CCNA 3 lab of this build, and they keep their relative course order
    const live = CCNA3_LABS.map((l) => l.name);
    expect(all.map((l) => l.name)).toEqual(live.filter((n) => all.some((l) => l.name === n)));
    expect(golden().script).toEqual(SCRIPT);
    expect(golden().about).toBe(ABOUT);
  });

  for (const lab of labs()) {
    it(`${lab.name}: the status unsolved at 60 s and solved at 710 s equals the golden, every detail string included`, () => {
      const expected = golden().labs[lab.name];
      if (expected === undefined) return assert.fail(`${lab.name} has no entry in test/goldens/lab-status.p3.json`);
      const run = freshRun(lab);
      expect(run.refused, `${lab.name}: solution lines the CLI refused`).toEqual([]);
      const report = [statusReport(lab.name, 'unsolved', expected.unsolved, run.entry.unsolved), statusReport(lab.name, 'solved', expected.solved, run.entry.solved)].filter((r) => r !== '');
      if (report.length > 0) assert.fail(report.join('\n'));
      expect(run.entry).toEqual(expected);
    }, LAB_CASE_TIMEOUT_MS);
  }
});
