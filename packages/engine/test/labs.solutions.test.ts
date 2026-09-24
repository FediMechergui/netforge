/**
 * P1 W6 labs: every CCNA 1 lab, its reference solution and its tasks (ARCHITECTURE-P1 §4.13, §8.2 W6;
 * contracts/scenario.ts).
 *
 * For each lab the test builds the real world (`loadTopology(build())`, boot, settle), then:
 *   • grades it UNSOLVED — every task must fail, or the task does not discriminate and the lab is broken;
 *   • applies `solution` through `Simulation.configure` exactly as written (a line the CLI refuses is a defect in
 *     the lab, so the test reports the refused lines), runs to idle and grades again — full marks;
 *   • checks that grading touched nothing: same clock, same trace head, same PDU count (connectivity assertions
 *     run in the disposable clone of sim/lab-checks.ts);
 *   • checks the catalogue metadata: `scenarioMeta` is structured-clone safe and carries no engine-only member,
 *     `requires` lists exactly the catalog types the topology uses and every one of them exists.
 *
 * ponytail: one world per lab per state, built by the same helper the acceptance test uses, and no literal lease
 * or interface-identifier addresses in the assertions — those live in the labs, where a failing task explains them.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../src/contracts/ids.js';
import type { ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { Topology } from '../src/contracts/topology.js';
import { scenarioMeta } from '../src/contracts/scenario.js';
import { SEC } from '../src/contracts/time.js';
import { createCatalog } from '../src/device/catalog/index.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { createSimulation } from '../src/sim/simulation.js';
import { CCNA1_LABS } from '../src/sim/scenarios/ccna1/index.js';
import { CCNA2_LABS, SCENARIOS, TEMPLATES } from '../src/sim/scenarios.js';

/** Long enough for every model of a lab to boot (the router takes 45 s). */
const BOOT_NS = 60 * SEC;

const catalog = createCatalog(PROCESS_FACTORIES);

/** The lab's world, booted and settled, with the lab reference stamped in as `loadScenario` does. */
function labWorld(lab: ScenarioInfo): Simulation {
  const sim = createSimulation({ seed: lab.seed ?? 1 });
  const topo: Topology = { ...lab.build(), lab: { name: lab.name, version: lab.version ?? 1 } };
  sim.loadTopology(topo);
  sim.runFor(BOOT_NS);
  sim.runToIdle();
  return sim;
}

/** Device id of a topology name (labs address devices by name, `configure` takes an id). */
function idOf(sim: Simulation, name: string): DeviceId {
  for (const d of sim.devices()) if (d.spec.name === name) return d.id;
  throw new Error(`no device called ${name} in this lab`);
}

/** Apply the reference solution; a refused line is a defect in the lab, so it is reported in full. */
function applySolution(sim: Simulation, lab: ScenarioInfo): void {
  for (const [name, lines] of Object.entries(lab.solution ?? {})) {
    const r = sim.configure(idOf(sim, name), lines);
    const refused = r.lines.filter((l) => !l.ok).map((l) => `${l.line}: ${l.error?.message ?? l.output}`);
    expect(refused, `${lab.name} solution for ${name}`).toEqual([]);
    expect(r.ok, `${lab.name} solution for ${name}`).toBe(true);
  }
  sim.runToIdle();
}

/** The catalog types a topology actually uses. */
function typesOf(topo: Topology): string[] {
  return [...new Set(topo.devices.map((d) => d.type))].sort();
}

describe('CCNA1 labs: the catalogue', () => {
  it('lists the labs after the templates, with unique names and a lab category', () => {
    expect(CCNA1_LABS.length).toBeGreaterThanOrEqual(14);
    // P2 §9.2 item 21: SCENARIOS is the templates, then CCNA1_LABS, then CCNA2_LABS
    expect(SCENARIOS.slice(TEMPLATES.length, TEMPLATES.length + CCNA1_LABS.length)).toEqual(CCNA1_LABS);
    expect(SCENARIOS.slice(0, TEMPLATES.length)).toEqual(TEMPLATES);
    expect(SCENARIOS.slice(TEMPLATES.length + CCNA1_LABS.length)).toEqual(CCNA2_LABS);
    expect(new Set(SCENARIOS.map((s) => s.name)).size).toBe(SCENARIOS.length);
    for (const lab of CCNA1_LABS) {
      expect(lab.category).toBe('ccna1-lab');
      expect(lab.name, lab.name).toMatch(/^ccna1(-[a-z0-9]+)+$/);
      expect(lab.labType).toBeDefined();
      expect(lab.seed, lab.name).toBeTypeOf('number');
      expect(lab.instructions ?? '', lab.name).not.toBe('');
      expect((lab.objectives ?? []).length, lab.name).toBeGreaterThan(0);
      expect((lab.tasks ?? []).length, lab.name).toBeGreaterThan(1);
      expect(Object.keys(lab.solution ?? {}).length, lab.name).toBeGreaterThan(0);
    }
  });

  it('keeps every lab covered by at least one troubleshooting, concept and build entry', () => {
    const types = new Set(CCNA1_LABS.map((l) => l.labType));
    expect([...types].sort()).toEqual(['build', 'concept', 'guided', 'troubleshoot']);
  });
});

for (const lab of CCNA1_LABS) {
  describe(`CCNA1 lab: ${lab.name}`, () => {
    it('describes itself with structured-clone safe metadata and a catalog it really uses', () => {
      const meta = scenarioMeta(lab);
      expect(structuredClone(meta)).toEqual(meta);
      expect(meta).not.toHaveProperty('build');
      expect(meta).not.toHaveProperty('solution');
      for (const task of meta.tasks ?? []) expect(task).not.toHaveProperty('assertions');

      const topo = lab.build();
      expect([...(lab.requires ?? [])].sort()).toEqual(typesOf(topo));
      for (const type of lab.requires ?? []) expect(catalog.get(type), type).toBeDefined();

      // Tasks: unique ids, real points, dependencies that exist.
      const ids = (lab.tasks ?? []).map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const task of lab.tasks ?? []) {
        expect(task.points, `${lab.name}/${task.id}`).toBeGreaterThan(0);
        expect(task.assertions.length, `${lab.name}/${task.id}`).toBeGreaterThan(0);
        for (const dep of task.dependsOn ?? []) expect(ids, `${lab.name}/${task.id}`).toContain(dep);
      }
      // The solution only configures devices this topology has.
      for (const name of Object.keys(lab.solution ?? {})) expect(topo.devices.map((d) => d.name)).toContain(name);
    });

    it('fails every task before the student starts', () => {
      const sim = labWorld(lab);
      const status = evaluateLab(sim, lab);
      expect(status.lab).toBe(lab.name);
      expect(status.total).toBe((lab.tasks ?? []).reduce((n, t) => n + t.points, 0));
      expect(status.results.filter((r) => r.pass).map((r) => r.task), `${lab.name} unsolved`).toEqual([]);
      expect(status.score).toBe(0);
      // Every failing task says why, on the assertion that failed.
      for (const r of status.results) expect(r.assertions.some((a) => !a.pass && (a.detail ?? '') !== ''), `${lab.name}/${r.task}`).toBe(true);
    });

    it('scores full marks once the reference solution is applied', () => {
      const sim = labWorld(lab);
      applySolution(sim, lab);
      const status = evaluateLab(sim, lab);
      const failed = status.results
        .filter((r) => !r.pass)
        .map((r) => `${r.task}: ${r.assertions.filter((a) => !a.pass).map((a) => a.detail ?? '(no detail)').join(' | ')}`);
      expect(failed, `${lab.name} solved`).toEqual([]);
      expect(status.score).toBe(status.total);
    });

    it('grades without touching the live simulation', () => {
      const sim = labWorld(lab);
      applySolution(sim, lab);
      const now = sim.now;
      const head = sim.trace(0).next;
      const pdus = sim.snapshot().pduCount;

      evaluateLab(sim, lab);

      expect(sim.now).toBe(now);
      expect(sim.trace(0).next).toBe(head);
      expect(sim.snapshot().pduCount).toBe(pdus);
    });
  });
}

/**
 * Wrong answers a lab used to score anyway (P1 W6 review). Each case applies the reference solution with ONE
 * deliberate mistake — or breaks the world after solving it — and pins the task that must now fail.
 */
describe('CCNA1 labs: a wrong answer does not score', () => {
  const labNamed = (name: string): ScenarioInfo => {
    const lab = CCNA1_LABS.find((l) => l.name === name);
    if (lab === undefined) throw new Error(`no lab called ${name}`);
    return lab;
  };
  const taskResult = (sim: Simulation, lab: ScenarioInfo, task: string): { pass: boolean; points: number } => {
    const r = evaluateLab(sim, lab).results.find((x) => x.task === task);
    if (r === undefined) throw new Error(`${lab.name} has no task ${task}`);
    return { pass: r.pass, points: r.points };
  };
  const solutionOf = (lab: ScenarioInfo, device: string): readonly string[] => {
    const lines = (lab.solution ?? {})[device];
    if (lines === undefined) throw new Error(`${lab.name} has no solution for ${device}`);
    return lines;
  };

  it('refuses an exclusion range ten times wider than the one asked for', () => {
    const lab = labNamed('ccna1-dhcpv4-server');
    const sim = labWorld(lab);
    // 192.168.15.1–.100 instead of .1–.10: a substring check accepted it because ".10" is a prefix of ".100".
    const wrong = solutionOf(lab, 'R1').map((l) => (l.includes('excluded-address') ? l.replace('192.168.15.10', '192.168.15.100') : l));
    expect(wrong).not.toEqual(solutionOf(lab, 'R1'));
    sim.configure(idOf(sim, 'R1'), wrong);
    sim.runToIdle();
    expect(taskResult(sim, lab, 'excluded')).toEqual({ pass: false, points: 0 });
  });

  it('refuses a reachability task when the target host is off the LAN, whatever the lease order was', () => {
    const lab = labNamed('ccna1-dhcpv4-server');
    const sim = labWorld(lab);
    // PC2 leases BEFORE PC1, so the live addresses are the reverse of what the grading clone derives.
    sim.configure(idOf(sim, 'R1'), solutionOf(lab, 'R1'));
    sim.runToIdle();
    for (const name of ['PC2', 'PC1']) {
      sim.configure(idOf(sim, name), solutionOf(lab, name));
      sim.runToIdle();
    }
    expect(taskResult(sim, lab, 'reachable').pass).toBe(true);

    sim.removeLink('l_pc2_sw1');
    sim.runToIdle();
    expect(taskResult(sim, lab, 'reachable')).toEqual({ pass: false, points: 0 });
  });

  it('refuses an end-to-end task when a cable has been cut', () => {
    const lab = labNamed('ccna1-two-subnets');
    const sim = labWorld(lab);
    applySolution(sim, lab);
    expect(taskResult(sim, lab, 'end-to-end').pass).toBe(true);

    sim.injectFault(sim.now, { id: 'review-cut', kind: 'cable-cut', target: { link: 'l_pc1_sw1' } });
    sim.runToIdle();
    expect(sim.link('l_pc1_sw1')?.downReason).toBe('cut');
    expect(taskResult(sim, lab, 'end-to-end')).toEqual({ pass: false, points: 0 });
  });

  it('still scores the wireless lease after a stray request on the wired adapter', () => {
    const lab = labNamed('ccna1-home-wifi');
    const sim = labWorld(lab);
    sim.configure(idOf(sim, 'HOME1'), solutionOf(lab, 'HOME1'));
    sim.runToIdle();
    // The host shell accepts `ip address dhcp` with no adapter, which leaves an unbound wired entry FIRST in the
    // client list; the task is about the wireless adapter, so it must not read whichever entry happens to be [0].
    const laptop = idOf(sim, 'LAPTOP1');
    sim.cli.exec(sim.cli.open(laptop, 'console'), 'ip address dhcp');
    sim.runToIdle();
    sim.configure(laptop, solutionOf(lab, 'LAPTOP1'));
    sim.runToIdle();

    const clients = sim.device(laptop)!.processes.get('dhcp-client')!.stateSnapshot().state['clients'] as { iface: string }[];
    expect(clients.length).toBe(2);
    expect(clients[0]!.iface).not.toBe('Wlan0');
    const status = evaluateLab(sim, lab);
    expect(status.results.filter((r) => !r.pass)).toEqual([]);
    expect(status.score).toBe(status.total);
  });
});
