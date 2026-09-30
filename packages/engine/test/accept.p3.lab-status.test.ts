/**
 * P3 acceptance — every CCNA 1 and CCNA 2 lab grades exactly as P2 graded it (ARCHITECTURE-P3 D3, D5, §9.1, §9.2 W0
 * item 6, §10.1 row `accept.p3.lab-status`; recorded in W0 from the unchanged engine at 5263f16).
 *
 * test/goldens/lab-status.p2.json holds the `evaluateLab` status of all 35 existing labs (the 15 CCNA 1 labs and the
 * 20 CCNA 2 labs, course order), with every task result and every assertion's pass flag and detail string, at two
 * points of one world per lab:
 *   • UNSOLVED at 60 s — the lab loaded exactly as the worker's `loadScenario` loads it (the lab seed, else
 *     SCENARIO_SEED; the lab stamp; the scheduled faults injected), then `runFor(60 s)`: every model has booted and
 *     every hidden fault has landed;
 *   • SOLVED at the end — the reference solution through `Simulation.configure` exactly as written (every line
 *     accepted), then `runFor(650 s)`, to 710 s: the end of the P2 golden's fixed script (D3), with none of its typed
 *     probes.
 * Both must equal the golden exactly. It proves the grader refactor of D5 (the checkers moved verbatim into
 * `sim/lab-checks/{core,switching,routing}.ts`, the registry, the stub kinds) behaviour-identical for every P1/P2 lab;
 * a mismatch names the lab, the point, the task and the assertion with both detail strings.
 *
 * Regenerating (the architect only, and only for a §9.4 change): `NF_RECORD_LAB_STATUS=<lab,lab,…|all>` re-records the
 * named labs, keeps every other entry, prints which labs changed, and refuses a lab whose solution lines were refused
 * or whose solved world does not earn full marks.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { assert, beforeAll, describe, expect, it } from 'vitest';
import type { LabStatus, ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { CCNA1_LABS, CCNA2_LABS, SCENARIOS, SCENARIO_SEED } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';

/** Unsolved: every model booted (the router takes 45 s) and every hidden fault landed. */
const UNSOLVED_NS = 60 * SEC;
/** Solved: after the solution, to the end of the P2 golden's fixed script (60 s + 30 s + 20 s + 600 s = 710 s). */
const SOLVED_RUN_NS = 650 * SEC;
const SCRIPT = { unsolvedAtS: UNSOLVED_NS / SEC, solvedAtS: (UNSOLVED_NS + SOLVED_RUN_NS) / SEC };
/** Wall-clock budget of one lab case (one world, two gradings with their clones; well under a second alone). */
const LAB_CASE_TIMEOUT_MS = 60_000;

/** Both statuses of one lab. */
interface LabEntry {
  readonly unsolved: LabStatus;
  readonly solved: LabStatus;
}

/** Contents of test/goldens/lab-status.p2.json. */
interface StatusGolden {
  readonly about: string;
  readonly script: typeof SCRIPT;
  readonly labs: Readonly<Record<string, LabEntry>>;
}

const GOLDEN_URL = new URL('./goldens/lab-status.p2.json', import.meta.url);

const ABOUT =
  'Lab status of every CCNA 1 and CCNA 2 lab (ARCHITECTURE-P3 D3, D5, §10.1 accept.p3.lab-status), recorded from the ' +
  'unchanged engine at commit 5263f16 before any P3 code: the evaluateLab status, with every detail string, unsolved ' +
  'at 60 s and solved at 710 s (the reference solution applied at 60 s). Change it only as §9.4 allows, by ' +
  're-recording with NF_RECORD_LAB_STATUS.';

let goldenCache: StatusGolden | undefined;

function golden(): StatusGolden {
  if (goldenCache === undefined) {
    if (!existsSync(GOLDEN_URL)) throw new Error('test/goldens/lab-status.p2.json is missing; it is recorded once, from the unchanged engine (P3 §7 W0).');
    goldenCache = JSON.parse(readFileSync(GOLDEN_URL, 'utf8')) as StatusGolden;
  }
  return goldenCache;
}

/** Every existing lab, course order: CCNA 1, then CCNA 2 (read at call time). */
function labs(): readonly ScenarioInfo[] {
  return [...CCNA1_LABS, ...CCNA2_LABS];
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
  const out = [`${lab} (${point}): the lab status differs from test/goldens/lab-status.p2.json (§9.4 lists the only allowed changes).`];
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

const RECORD = (process.env['NF_RECORD_LAB_STATUS'] ?? '').trim();

/** Re-record the labs `RECORD` names (`all` = every lab), keeping every other entry. */
function record(): void {
  const all = labs();
  const names = RECORD === 'all' ? all.map((l) => l.name) : RECORD.split(',').map((s) => s.trim()).filter((s) => s !== '');
  for (const name of names) if (!all.some((l) => l.name === name)) throw new Error(`NF_RECORD_LAB_STATUS names ${name}, which is not a CCNA 1 or CCNA 2 lab`);
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
    const problems = [...run.refused];
    if (run.entry.solved.score !== run.entry.solved.total) problems.push(`the solved world scores ${run.entry.solved.score}/${run.entry.solved.total}`);
    if (problems.length > 0) throw new Error(`refusing to record ${lab.name}:\n  ${problems.join('\n  ')}`);
    if (old !== undefined) {
      const report = [statusReport(lab.name, 'unsolved', old.unsolved, run.entry.unsolved), statusReport(lab.name, 'solved', old.solved, run.entry.solved)].filter((r) => r !== '');
      console.log(report.length === 0 ? `${lab.name}: unchanged` : `${lab.name}: re-recorded\n${report.join('\n')}`);
    }
    out[lab.name] = run.entry;
  }
  const file: StatusGolden = { about: ABOUT, script: SCRIPT, labs: out };
  writeFileSync(GOLDEN_URL, `${JSON.stringify(file, null, 2)}\n`);
  goldenCache = file;
}

describe('accept P3: every CCNA 1 and CCNA 2 lab grades exactly as P2 graded it', () => {
  beforeAll(() => {
    if (RECORD !== '') record();
  }, 600_000);

  it('covers all 35 existing labs, in course order', () => {
    const all = labs();
    expect(CCNA1_LABS).toHaveLength(15);
    expect(CCNA2_LABS).toHaveLength(20);
    expect(SCENARIOS.filter((s) => s.category === 'ccna1-lab' || s.category === 'ccna2-lab').map((s) => s.name)).toEqual(all.map((l) => l.name));
    expect(Object.keys(golden().labs)).toEqual(all.map((l) => l.name));
    expect(golden().script).toEqual(SCRIPT);
    expect(golden().about).toBe(ABOUT);
  });

  for (const lab of labs()) {
    it(`${lab.name}: the status unsolved at 60 s and solved at 710 s equals the golden, every detail string included`, () => {
      const expected = golden().labs[lab.name];
      if (expected === undefined) return assert.fail(`${lab.name} has no entry in test/goldens/lab-status.p2.json`);
      const run = freshRun(lab);
      expect(run.refused, `${lab.name}: solution lines the CLI refused`).toEqual([]);
      const report = [statusReport(lab.name, 'unsolved', expected.unsolved, run.entry.unsolved), statusReport(lab.name, 'solved', expected.solved, run.entry.solved)].filter((r) => r !== '');
      if (report.length > 0) assert.fail(report.join('\n'));
      expect(run.entry).toEqual(expected);
    }, LAB_CASE_TIMEOUT_MS);
  }
});
