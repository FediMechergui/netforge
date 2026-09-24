/**
 * P1 acceptance (ARCHITECTURE-P1 §10.2, row `accept.p1.labs.test.ts`):
 *
 *   "Every CCNA1 lab: the reference solution via configure passes all tasks; the unsolved state fails its tasks;
 *    evaluation leaves the live trace head unchanged."
 *
 * One world per lab is built from `build()` and booted, graded unsolved, then configured with the lab's own
 * `solution` through `Simulation.configure` — the same call the terminal and the worker make — run to idle and
 * graded again. Nothing about the lab is restated here: the pass condition is the lab's own task list, so a lab
 * whose solution drifts from its tasks fails this test.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../src/contracts/ids.js';
import type { LabStatus, ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { createSimulation } from '../src/sim/simulation.js';
import { CCNA1_LABS } from '../src/sim/scenarios/ccna1/index.js';
import { CCNA2_LABS, SCENARIOS, TEMPLATES } from '../src/sim/scenarios.js';

/** Long enough for every model of a lab to boot (the router takes 45 s). */
const BOOT_NS = 60 * SEC;

/** The lab's world as `loadScenario` builds it: the lab seed, the lab topology, booted and settled. */
function labWorld(lab: ScenarioInfo): Simulation {
  const sim = createSimulation({ seed: lab.seed ?? 1 });
  sim.loadTopology({ ...lab.build(), lab: { name: lab.name, version: lab.version ?? 1 } });
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

describe('P1 acceptance: the CCNA1 labs grade themselves', () => {
  it('ships a lab catalogue with tasks and a reference solution', () => {
    expect(CCNA1_LABS.length).toBeGreaterThanOrEqual(14);
    // P2 §9.2 item 21: the catalogue is the templates, then CCNA1_LABS, then CCNA2_LABS
    expect(SCENARIOS.slice(0, TEMPLATES.length)).toEqual(TEMPLATES);
    expect(SCENARIOS.slice(TEMPLATES.length, TEMPLATES.length + CCNA1_LABS.length)).toEqual(CCNA1_LABS);
    expect(SCENARIOS.slice(TEMPLATES.length + CCNA1_LABS.length)).toEqual(CCNA2_LABS);
    for (const lab of CCNA1_LABS) {
      expect(lab.category, lab.name).toBe('ccna1-lab');
      expect((lab.tasks ?? []).length, lab.name).toBeGreaterThan(1);
      expect(Object.keys(lab.solution ?? {}).length, lab.name).toBeGreaterThan(0);
    }
  });

  for (const lab of CCNA1_LABS) {
    it(`${lab.name}: unsolved fails, the reference solution scores full marks, grading is read-only`, () => {
      const total = (lab.tasks ?? []).reduce((n, t) => n + t.points, 0);

      // 1. Unsolved: every task fails, so every task discriminates.
      const unsolved = labWorld(lab);
      const before = evaluateLab(unsolved, lab);
      expect(before.lab).toBe(lab.name);
      expect(before.total).toBe(total);
      expect(before.results.filter((r) => r.pass).map((r) => r.task), `${lab.name} unsolved`).toEqual([]);
      expect(before.score).toBe(0);

      // 2. Solved through the public configure API, exactly as the lab writes its solution.
      const sim = labWorld(lab);
      for (const [device, lines] of Object.entries(lab.solution ?? {})) {
        const r = sim.configure(idOf(sim, device), lines);
        expect(r.lines.filter((l) => !l.ok).map((l) => l.line), `${lab.name} solution for ${device}`).toEqual([]);
      }
      sim.runToIdle();

      // 3. Grading reads only: same clock, same trace head, same PDU count.
      const now = sim.now;
      const head = sim.trace(0).next;
      const pdus = sim.snapshot().pduCount;

      const after = evaluateLab(sim, lab);

      expect(failures(after), `${lab.name} solved`).toEqual([]);
      expect(after.score).toBe(total);
      expect(sim.now).toBe(now);
      expect(sim.trace(0).next).toBe(head);
      expect(sim.snapshot().pduCount).toBe(pdus);
    });
  }
});
