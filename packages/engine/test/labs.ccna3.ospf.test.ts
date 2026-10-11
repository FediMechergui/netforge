/**
 * P3 W5 ospf: the five CCNA 3 OSPF labs — `ccna3-ospf-dr-election` (lesson 03), `ccna3-ospf-single-area` (04),
 * `ccna3-ospf-cost` (05), `ccna3-ospf-default-route` (06) and `ccna3-troubleshoot-ospf` (07) — proved the way the sim
 * builder's `labs.ccna3.solutions.test.ts` proves every CCNA 3 lab (ARCHITECTURE-P3 §7 W5, §11.1, §11.2; the twin of
 * `labs.ccna2.solutions.test.ts`, filtered to these five). Owner: the W5 ospf item; kept beside the generic test as
 * the area's own proof.
 *
 * For each lab:
 *   • its metadata: category `ccna3-lab`, course `CCNA 3`, `topic` = the title of the module that holds its lesson in
 *     curriculum/ccna3/lessons.ts, the name §11.1 freezes, a fixed seed, structured-clone safe `scenarioMeta`,
 *     `requires` = exactly the catalog types the topology uses (all in the real catalog), tasks with unique ids, real
 *     points and existing dependencies, a solution for devices the topology has, scheduled faults aimed at devices it
 *     has, and §11.2's OSPF timing sentences in the instructions;
 *   • its world: a P3-profile topology whose schema is `schemaIdFor(t)` (1.3), loaded as a P3 world, with every switch
 *     port that faces a host or a router an edge port (§11.2);
 *   • UNSOLVED (built, scheduled faults injected the way the worker does, booted and settled): EVERY task fails, and
 *     says why on a failing assertion;
 *   • SOLVED: `configure` accepts every line of the reference solution as written, the world runs to idle, and every
 *     task passes — full marks;
 *   • grading is read-only (same clock, trace head and PDU count) and repeatable (two evaluations are equal).
 *
 * Lab-specific cases (the wrong answers each lesson is about): lab 03 — the election does not preempt (priorities set
 * after the segment came up leave the old DR in place); lab 04 — a router ID typed after the process started is
 * configured but not in use, so the live `fact ospf.routerId` fails until `clear ip ospf process` (§11.2: router IDs
 * are graded live), and network statements on R3 do not earn the interface-line task; lab 05 — a cost on one end only
 * leaves the other router with one path; lab 06 — `always` is not the answer, and a dead interval matched without the
 * hello interval still refuses the hellos; lab 07 — nothing is graded before the hidden faults land, the faults
 * survive a power cycle, each repair earns its own task, and a router ID corrected without a restart fails live
 * although a clone booted from the export would use it. The lab file imports only the contracts, `../kit.js` and
 * `../templates.js`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../src/contracts/ids.js';
import type { ScenarioInfo } from '../src/contracts/scenario.js';
import { scenarioMeta } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { OspfInterfaceRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID_1_3, schemaIdFor, type Topology } from '../src/contracts/topology.js';
import { CCNA3_MODULES } from '../src/curriculum/ccna3/lessons.js';
import { createCatalog } from '../src/device/catalog/index.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import { LAB_PREPARING_DETAIL, evaluateLab } from '../src/sim/lab-checks.js';
import {
  CCNA3_OSPF_LABS,
  DR_ELECTION_PRIORITIES,
  OSPF_COST_SERIAL,
  TROUBLE_DUPLICATE_RID,
  ccna3OspfCost,
  ccna3OspfDefaultRoute,
  ccna3OspfDrElection,
  ccna3OspfSingleArea,
  ccna3TroubleshootOspf,
} from '../src/sim/scenarios/ccna3/ospf.js';
import { createSimulation } from '../src/sim/simulation.js';

/** Long enough for every model of a lab to boot (a router takes 45 s) and for lab 07's hidden faults (50 s) to land. */
const BOOT_NS = 90 * SEC;

/** Wall-clock budget of one per-lab world test: a lab world plus one grading clone per fault set it names. */
const LAB_TEST_TIMEOUT_MS = 90_000;

const catalog = createCatalog(PROCESS_FACTORIES);

/** The lessons of the skeleton in teaching order, with the title of the module that holds each. */
const LESSONS = CCNA3_MODULES.flatMap((m) => m.lessons.map((l) => ({ lesson: l, module: m.title })));

/** The lab's world as `loadScenario` builds it: the lab seed, the lab topology, its scheduled faults, booted and settled. */
function labWorld(lab: ScenarioInfo): Simulation {
  const sim = labWorldAt(lab, BOOT_NS);
  sim.runToIdle();
  return sim;
}

/** The lab world at `at`, as the worker holds it before a check at that instant (loaded, faults injected, not settled). */
function labWorldAt(lab: ScenarioInfo, at: number): Simulation {
  const sim = createSimulation({ seed: lab.seed ?? 1 });
  sim.loadTopology({ ...lab.build(), lab: { name: lab.name, version: lab.version ?? 1 } });
  // the worker injects a lab's scheduled faults right after the load (apps/web bridge/worker applyFaults)
  for (const f of lab.faults ?? []) sim.injectFault(f.at, f.fault);
  if (at > 0) sim.runFor(at);
  return sim;
}

/** Device id of a topology name (labs address devices by name, `configure` takes an id). */
function idOf(sim: Simulation, name: string): DeviceId {
  for (const d of sim.devices()) if (d.spec.name === name) return d.id;
  throw new Error(`no device called ${name} in this lab`);
}

/** Type `lines` on the device called `name`; every line must be accepted (a refused line is reported in full). */
function typeOn(sim: Simulation, name: string, lines: readonly string[], what = name): void {
  const r = sim.configure(idOf(sim, name), lines);
  expect(r.lines.filter((l) => !l.ok).map((l) => `${l.line}: ${l.error?.message ?? l.output}`), what).toEqual([]);
  expect(r.ok, what).toBe(true);
}

/** Apply the reference solution as written, then settle. */
function applySolution(sim: Simulation, lab: ScenarioInfo): void {
  for (const [name, lines] of Object.entries(lab.solution ?? {})) typeOn(sim, name, lines, `${lab.name} solution for ${name}`);
  sim.runToIdle();
}

/** The catalog types a topology actually uses. */
function typesOf(topo: Topology): string[] {
  return [...new Set(topo.devices.map((d) => d.type))].sort();
}

/** Tasks that did not pass, each with the details of its failing assertions. */
function failures(sim: Simulation, lab: ScenarioInfo): string[] {
  return evaluateLab(sim, lab)
    .results.filter((r) => !r.pass)
    .map((r) => `${r.task}: ${r.assertions.filter((a) => !a.pass).map((a) => a.detail ?? '(no detail)').join(' | ')}`);
}

/** Pass flag of each task, by id. */
function taskPasses(sim: Simulation, lab: ScenarioInfo): Record<string, boolean> {
  return Object.fromEntries(evaluateLab(sim, lab).results.map((r) => [r.task, r.pass]));
}

/** The task ids of a lab, each mapped to `pass` except the ids listed in `flipped`. */
function expectTasks(lab: ScenarioInfo, pass: boolean, flipped: readonly string[] = []): Record<string, boolean> {
  return Object.fromEntries((lab.tasks ?? []).map((t) => [t.id, flipped.includes(t.id) ? !pass : pass]));
}

/** The `ospf-interfaces` row of `port` on the device called `name`. */
function ifRow(sim: Simulation, name: string, port: string): OspfInterfaceRow | undefined {
  return sim.device(idOf(sim, name))!.tables.get<OspfInterfaceRow>('ospf-interfaces')?.rows().find((r) => r.port === port);
}

describe('CCNA3 OSPF labs: the file', () => {
  it('exports the five labs of lessons 03–07 under the fixed name, in course order', () => {
    expect(CCNA3_OSPF_LABS.map((l) => l.name)).toEqual([
      'ccna3-ospf-dr-election',
      'ccna3-ospf-single-area',
      'ccna3-ospf-cost',
      'ccna3-ospf-default-route',
      'ccna3-troubleshoot-ospf',
    ]);
    expect(CCNA3_OSPF_LABS).toEqual([ccna3OspfDrElection, ccna3OspfSingleArea, ccna3OspfCost, ccna3OspfDefaultRoute, ccna3TroubleshootOspf]);
    expect(Object.isFrozen(CCNA3_OSPF_LABS)).toBe(true);
    const homes = CCNA3_OSPF_LABS.map((lab) => LESSONS.filter((l) => l.lesson.lab === lab.name).map((l) => l.lesson.id));
    expect(homes).toEqual([
      ['ccna3-03-neighbours-and-the-designated-router'],
      ['ccna3-04-switching-ospf-on'],
      ['ccna3-05-cost-and-the-best-path'],
      ['ccna3-06-default-routes-and-timers'],
      ['ccna3-07-fixing-ospf'],
    ]);
    expect(CCNA3_OSPF_LABS.map((l) => l.labType)).toEqual(['guided', 'build', 'build', 'build', 'troubleshoot']);
  });

  it('imports only the contracts, the kit and the templates (no cycle through a catalogue)', () => {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sim', 'scenarios', 'ccna3', 'ospf.ts');
    const text = readFileSync(file, 'utf8');
    const imports = [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] as string);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec, `ospf.ts imports ${spec}`).toMatch(/^\.\.\/\.\.\/\.\.\/contracts\/[a-z-]+\.js$|^\.\.\/kit\.js$|^\.\.\/templates\.js$/);
  });
});

for (const lab of CCNA3_OSPF_LABS) {
  describe(`CCNA3 OSPF lab: ${lab.name}`, () => {
    it('describes itself with structured-clone safe metadata, its module as topic and a catalog it really uses', () => {
      expect(lab.category).toBe('ccna3-lab');
      expect(lab.course).toBe('CCNA 3');
      expect(lab.name).toMatch(/^ccna3(-[a-z0-9]+)+$/);
      const home = LESSONS.find((l) => l.lesson.lab === lab.name);
      expect(home, `${lab.name} is the lab of a lesson`).toBeDefined();
      expect(lab.topic).toBe(home?.module);
      expect(lab.seed, lab.name).toBeTypeOf('number');
      expect(lab.instructions ?? '', lab.name).not.toBe('');
      expect((lab.objectives ?? []).length, lab.name).toBeGreaterThan(0);
      expect((lab.tasks ?? []).length, lab.name).toBeGreaterThan(0);
      expect(Object.keys(lab.solution ?? {}).length, lab.name).toBeGreaterThan(0);
      // §11.2: an OSPF lab warns about the timers (the 45 s boot, and the broadcast or point-to-point waits)
      expect(lab.instructions).toContain('45 s to boot');
      expect(/allow about 90 s before the first ping|about a minute/.test(lab.instructions ?? ''), lab.name).toBe(true);

      const meta = scenarioMeta(lab);
      expect(structuredClone(meta)).toEqual(meta);
      expect(meta).not.toHaveProperty('build');
      expect(meta).not.toHaveProperty('solution');
      expect(meta).not.toHaveProperty('faults');
      for (const task of meta.tasks ?? []) expect(task).not.toHaveProperty('assertions');

      const topo = lab.build();
      expect([...(lab.requires ?? [])].sort()).toEqual(typesOf(topo));
      for (const type of lab.requires ?? []) expect(catalog.get(type), type).toBeDefined();

      const ids = (lab.tasks ?? []).map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const task of lab.tasks ?? []) {
        expect(task.points, `${lab.name}/${task.id}`).toBeGreaterThan(0);
        expect(task.assertions.length, `${lab.name}/${task.id}`).toBeGreaterThan(0);
        for (const dep of task.dependsOn ?? []) expect(ids, `${lab.name}/${task.id}`).toContain(dep);
      }
      expect((lab.tasks ?? []).reduce((n, t) => n + t.points, 0)).toBe(100);
      const deviceNames = topo.devices.map((d) => d.name);
      for (const name of Object.keys(lab.solution ?? {})) expect(deviceNames).toContain(name);
      const deviceIds = topo.devices.map((d) => d.id);
      const linkIds = topo.links.map((l) => l.id);
      for (const { fault } of lab.faults ?? []) {
        if (fault.target.device !== undefined) expect(deviceIds, fault.id).toContain(fault.target.device);
        if (fault.target.link !== undefined) expect(linkIds, fault.id).toContain(fault.target.link);
      }
    });

    it('builds a P3-profile world whose schema can express it, with edge ports toward hosts and routers', () => {
      const topo = lab.build();
      expect(topo.profile).toBe('P3');
      expect(topo.schema).toBe(TOPOLOGY_SCHEMA_ID_1_3);
      expect(topo.schema).toBe(schemaIdFor(topo));
      expect(topo.seed).toBe(lab.seed);
      const sim = createSimulation({ seed: lab.seed ?? 1 });
      sim.loadTopology(topo);
      expect(sim.profile).toBe('P3');
      // §11.2: every switch port cabled to a host or a router is PortFast in the startup configuration
      const byId = new Map(topo.devices.map((d) => [d.id, d] as const));
      for (const l of topo.links) {
        for (const [end, other] of [
          [l.a, l.b],
          [l.b, l.a],
        ] as const) {
          const dev = byId.get(end.device)!;
          if (!dev.type.startsWith('switch.')) continue;
          expect(byId.get(other.device)!.type.startsWith('switch.'), `${l.id}: no switch-to-switch link in an OSPF lab`).toBe(false);
          expect(dev.config ?? '', `${dev.name} ${end.port}`).toMatch(new RegExp(`interface ${end.port.replace(/\//g, '\\/')}\\n(?: [^\\n]*\\n)* spanning-tree portfast\\n`));
        }
      }
    });

    it('fails every task before the student starts, and says why', () => {
      const sim = labWorld(lab);
      const status = evaluateLab(sim, lab);
      expect(status.lab).toBe(lab.name);
      expect(status.total).toBe((lab.tasks ?? []).reduce((n, t) => n + t.points, 0));
      expect(status.score, `${lab.name} unsolved`).toBe(0);
      for (const r of status.results) {
        expect(r.pass, `${lab.name}/${r.task} unsolved`).toBe(false);
        expect(r.assertions.some((a) => !a.pass && (a.detail ?? '') !== ''), `${lab.name}/${r.task}`).toBe(true);
      }
    }, LAB_TEST_TIMEOUT_MS);

    it('scores full marks once the reference solution is applied as written', () => {
      const sim = labWorld(lab);
      applySolution(sim, lab);
      expect(failures(sim, lab), `${lab.name} solved`).toEqual([]);
      const status = evaluateLab(sim, lab);
      expect(status.score).toBe(status.total);
    }, LAB_TEST_TIMEOUT_MS);

    it('grades without touching the live simulation, and the same way twice', () => {
      const sim = labWorld(lab);
      applySolution(sim, lab);
      const now = sim.now;
      const head = sim.trace(0).next;
      const pdus = sim.snapshot().pduCount;

      const first = evaluateLab(sim, lab);
      const second = evaluateLab(sim, lab);

      expect(second).toEqual(first);
      expect(sim.now).toBe(now);
      expect(sim.trace(0).next).toBe(head);
      expect(sim.snapshot().pduCount).toBe(pdus);
    }, LAB_TEST_TIMEOUT_MS);
  });
}

/** Restart OSPF on the device called `name` the way a learner does: `clear ip ospf process`, answered yes. */
function clearOspfProcess(sim: Simulation, name: string): void {
  const s = sim.cli.open(idOf(sim, name), 'console');
  sim.cli.exec(s, 'enable');
  const ask = sim.cli.exec(s, 'clear ip ospf process');
  expect(ask.error, `clear ip ospf process on ${name}`).toBeUndefined();
  const yes = sim.cli.exec(s, 'yes');
  expect(yes.error, `clear ip ospf process on ${name}: yes`).toBeUndefined();
  sim.cli.close(s);
}

/** The failing details of one task. */
function taskDetails(sim: Simulation, lab: ScenarioInfo, task: string): (string | undefined)[] {
  const r = evaluateLab(sim, lab).results.find((x) => x.task === task);
  return (r?.assertions ?? []).filter((a) => !a.pass).map((a) => a.detail);
}

describe('ccna3-ospf-dr-election: the election does not preempt', () => {
  it('priorities set after the segment came up leave the earlier roles in place; a restart of the segment applies them', () => {
    const lab = ccna3OspfDrElection;
    const sim = labWorld(lab);
    // the segment first, with every priority still 1: the highest router ID takes the DR role
    for (const name of ['R1', 'R2', 'R3']) typeOn(sim, name, ['interface GigabitEthernet0/0', 'no shutdown', 'exit']);
    sim.runToIdle();
    expect(ifRow(sim, 'R3', 'GigabitEthernet0/0')?.state).toBe('dr');
    expect(ifRow(sim, 'R2', 'GigabitEthernet0/0')?.state).toBe('backup');
    // then the priorities: stored and announced, but R1 does not take the DR role from a running segment
    for (const [name, pri] of Object.entries(DR_ELECTION_PRIORITIES)) typeOn(sim, name, ['interface GigabitEthernet0/0', `ip ospf priority ${pri}`, 'exit']);
    typeOn(sim, 'R3', ['interface GigabitEthernet0/1', 'ip ospf network point-to-point', 'exit']);
    typeOn(sim, 'R4', ['interface GigabitEthernet0/0', 'ip ospf network point-to-point', 'exit']);
    sim.runToIdle();
    const passes = taskPasses(sim, lab);
    expect(passes['priorities']).toBe(true);
    expect(passes['point-to-point']).toBe(true);
    expect(passes['elected']).toBe(false);
    expect(ifRow(sim, 'R1', 'GigabitEthernet0/0')?.state).not.toBe('dr');
    // the recovery the instructions give: shut the three segment ports, then enable them again
    for (const name of ['R1', 'R2', 'R3']) typeOn(sim, name, ['interface GigabitEthernet0/0', 'shutdown', 'exit']);
    sim.runFor(2 * SEC);
    for (const name of ['R1', 'R2', 'R3']) typeOn(sim, name, ['interface GigabitEthernet0/0', 'no shutdown', 'exit']);
    sim.runToIdle();
    expect(failures(sim, lab)).toEqual([]);
  }, LAB_TEST_TIMEOUT_MS);

  it('a low priority instead of 0 still lets R3 become the backup when the DR fails', () => {
    const lab = ccna3OspfDrElection;
    const sim = labWorld(lab);
    const r3 = (lab.solution?.['R3'] ?? []).map((l) => (l === `ip ospf priority ${DR_ELECTION_PRIORITIES.R3}` ? 'ip ospf priority 1' : l));
    for (const [name, lines] of Object.entries({ ...lab.solution, R3: r3 })) typeOn(sim, name, lines);
    sim.runToIdle();
    // R1 and R2 still win today, so the roles look right …
    expect(taskPasses(sim, lab)).toEqual(expectTasks(lab, true, ['priorities', 'dr-fails']));
    // … but with R1 gone, R3 is elected backup
    expect(taskDetails(sim, lab, 'dr-fails').join(' ')).toContain('R3 ospf.ifaceState of GigabitEthernet0/0');
  }, LAB_TEST_TIMEOUT_MS);
});

describe('ccna3-ospf-single-area: router IDs are graded live (§11.2)', () => {
  it('a router ID typed after the process started is configured but not in use until clear ip ospf process', () => {
    const lab = ccna3OspfSingleArea;
    const sim = labWorld(lab);
    // R1: the process starts without an ID line, and picks the highest address of an up interface
    typeOn(sim, 'R1', ['router ospf 1', 'passive-interface GigabitEthernet0/0', 'network 192.168.1.0 0.0.0.255 area 0', 'network 10.0.12.0 0.0.0.3 area 0', 'exit']);
    sim.runFor(1 * SEC);
    expect(ifRow(sim, 'R1', 'GigabitEthernet0/1')?.routerId).toBe('192.168.1.1');
    typeOn(sim, 'R1', ['router ospf 1', 'router-id 1.1.1.1', 'exit']);
    typeOn(sim, 'R3', lab.solution?.['R3'] ?? []);
    sim.runToIdle();
    expect(taskPasses(sim, lab)).toEqual(expectTasks(lab, true, ['router-ids']));
    expect(taskDetails(sim, lab, 'router-ids')).toEqual(['R1 ospf.routerId is 192.168.1.1, expected 1.1.1.1.']);
    // a clone booted from the export would already use the configured ID: only the live router shows the truth
    const clone = createSimulation({ seed: lab.seed ?? 1 });
    clone.loadTopology(sim.exportTopology());
    clone.runFor(BOOT_NS);
    clone.runToIdle();
    expect(ifRow(clone, 'R1', 'GigabitEthernet0/1')?.routerId).toBe('1.1.1.1');
    // the learner's way to apply it
    clearOspfProcess(sim, 'R1');
    sim.runToIdle();
    expect(failures(sim, lab)).toEqual([]);
  }, LAB_TEST_TIMEOUT_MS);

  it('network statements on R3 do not earn the interface-line task', () => {
    const lab = ccna3OspfSingleArea;
    const sim = labWorld(lab);
    typeOn(sim, 'R1', lab.solution?.['R1'] ?? []);
    typeOn(sim, 'R3', ['router ospf 1', 'router-id 3.3.3.3', 'passive-interface GigabitEthernet0/0', 'network 10.0.23.0 0.0.0.3 area 0', 'network 192.168.3.0 0.0.0.255 area 0', 'exit']);
    sim.runToIdle();
    expect(taskPasses(sim, lab)).toEqual(expectTasks(lab, true, ['r3-interface-lines']));
    expect(taskDetails(sim, lab, 'r3-interface-lines')).toEqual(['R3 still has a configuration line at router.ospf.network. R3 should switch OSPF on per interface, without network statements.']);
  }, LAB_TEST_TIMEOUT_MS);

  it("an interface line for R1's link does not earn the network-statement task (W5 fix #2)", () => {
    const lab = ccna3OspfSingleArea;
    const sim = labWorld(lab);
    typeOn(sim, 'R1', ['router ospf 1', 'router-id 1.1.1.1', 'passive-interface GigabitEthernet0/0', 'network 192.168.1.0 0.0.0.255 area 0', 'exit', 'interface GigabitEthernet0/1', 'ip ospf 1 area 0', 'exit']);
    typeOn(sim, 'R3', lab.solution?.['R3'] ?? []);
    sim.runToIdle();
    expect(taskPasses(sim, lab)).toEqual(expectTasks(lab, true, ['r1-network-statements']));
    expect(taskDetails(sim, lab, 'r1-network-statements')).toEqual(['R1 still has a configuration line at interface.GigabitEthernet0/1.ip.ospf.1. R1 should switch OSPF on with network statements only.']);
  }, LAB_TEST_TIMEOUT_MS);

  it('an ip ospf cost line on R1 next to the network statements still earns the task', () => {
    const lab = ccna3OspfSingleArea;
    const sim = labWorld(lab);
    for (const [name, lines] of Object.entries(lab.solution ?? {})) typeOn(sim, name, lines);
    typeOn(sim, 'R1', ['interface GigabitEthernet0/1', 'ip ospf cost 5', 'exit']);
    sim.runToIdle();
    expect(taskPasses(sim, lab)['r1-network-statements']).toBe(true);
  }, LAB_TEST_TIMEOUT_MS);
});

describe('ccna3-ospf-cost: wrong answers', () => {
  it('the raised reference makes the serial port cost 647, as the instructions work out', () => {
    const lab = ccna3OspfCost;
    const sim = labWorld(lab);
    for (const name of ['R1', 'R2', 'R3']) typeOn(sim, name, ['router ospf 1', 'auto-cost reference-bandwidth 1000', 'exit']);
    sim.runToIdle();
    expect(ifRow(sim, 'R1', 'Serial0/0/0')?.cost).toBe(647);
    expect(ifRow(sim, 'R2', 'GigabitEthernet0/1')?.cost).toBe(1);
    expect(taskPasses(sim, lab)).toEqual(expectTasks(lab, false, ['reference-bandwidth']));
  }, LAB_TEST_TIMEOUT_MS);

  it('a serial cost on one end only leaves R3 with a single path', () => {
    const lab = ccna3OspfCost;
    const sim = labWorld(lab);
    const r3 = (lab.solution?.['R3'] ?? []).filter((l) => l !== `ip ospf cost ${OSPF_COST_SERIAL}`);
    for (const [name, lines] of Object.entries({ ...lab.solution, R3: r3 })) typeOn(sim, name, lines);
    sim.runToIdle();
    expect(taskPasses(sim, lab)).toEqual(expectTasks(lab, true, ['equal-cost']));
    expect(taskDetails(sim, lab, 'equal-cost')).toEqual([
      'R3 ospf.ifaceCost of Serial0/0/0 is 647, expected 11.',
      'R3 reaches 10.1.0.10 through 10.1.0.0/24 (O, distance 110, via 10.0.23.1, out GigabitEthernet0/0); expected at least 2 equal-cost paths (it has 1).',
    ]);
  }, LAB_TEST_TIMEOUT_MS);

  it('a serial cost of 11 alone, with no equal-cost path before the cut, does not earn lose-a-path (W5 fix #0)', () => {
    const lab = ccna3OspfCost;
    for (const lines of [{ R1: ['interface Serial0/0/0', `ip ospf cost ${OSPF_COST_SERIAL}`, 'exit'] }, { R1: ['interface Serial0/0/0', `ip ospf cost ${OSPF_COST_SERIAL}`, 'exit'], R3: ['interface Serial0/0/0', `ip ospf cost ${OSPF_COST_SERIAL}`, 'exit'] }]) {
      const sim = labWorld(lab);
      for (const [name, l] of Object.entries(lines)) typeOn(sim, name, l);
      sim.runToIdle();
      expect(taskPasses(sim, lab)).toEqual(expectTasks(lab, false));
      // before the cut R1 still routes through R2 alone (cost 3 at the default reference): the pre-cut check fails
      const details = taskDetails(sim, lab, 'lose-a-path');
      expect(details).toHaveLength(1);
      expect(details[0]).toContain('at least 2 equal-cost paths (it has 1)');
      expect(details[0]).toContain('Before the cut, R1 must already hold both equal-cost paths to PC3.');
    }
  }, LAB_TEST_TIMEOUT_MS * 2);

  it('a reference raised on two routers only does not earn the reference task', () => {
    const lab = ccna3OspfCost;
    const sim = labWorld(lab);
    const r3 = (lab.solution?.['R3'] ?? []).filter((l) => !l.startsWith('auto-cost'));
    for (const [name, lines] of Object.entries({ ...lab.solution, R3: r3 })) typeOn(sim, name, lines);
    sim.runToIdle();
    expect(taskPasses(sim, lab)['reference-bandwidth']).toBe(false);
    expect(taskDetails(sim, lab, 'reference-bandwidth')).toEqual(['R3 ospf.referenceBandwidthMbps is 100, expected 1000. The reference must be the same on every router of the area.']);
  }, LAB_TEST_TIMEOUT_MS);
});

describe('ccna3-ospf-default-route: wrong answers', () => {
  it('`default-information originate always` is not the answer the lab asks for', () => {
    const lab = ccna3OspfDefaultRoute;
    const sim = labWorld(lab);
    typeOn(sim, 'R2', lab.solution?.['R2'] ?? []);
    typeOn(sim, 'R1', ['router ospf 1', 'default-information originate always', 'exit']);
    sim.runToIdle();
    expect(taskPasses(sim, lab)).toEqual(expectTasks(lab, true, ['originate-default']));
    expect(taskDetails(sim, lab, 'originate-default')).toEqual(['R1 ospf.defaultOriginate is always, expected on. Advertise the default only while R1 has one: no `always`.']);
  }, LAB_TEST_TIMEOUT_MS);

  it('a dead interval matched without the hello interval still refuses the hellos', () => {
    const lab = ccna3OspfDefaultRoute;
    const sim = labWorld(lab);
    typeOn(sim, 'R2', ['interface GigabitEthernet0/0', 'ip ospf dead-interval 20', 'exit']);
    typeOn(sim, 'R1', lab.solution?.['R1'] ?? []);
    sim.runToIdle();
    const passes = taskPasses(sim, lab);
    expect(passes['matching-timers']).toBe(false);
    expect(passes['originate-default']).toBe(true);
    expect(ifRow(sim, 'R2', 'GigabitEthernet0/0')?.rejected?.reason).toContain('hello interval');
  }, LAB_TEST_TIMEOUT_MS);
});

describe('ccna3-troubleshoot-ospf: hidden faults, one repair at a time', () => {
  it('grades no task before its last hidden fault has landed', () => {
    const lab = ccna3TroubleshootOspf;
    const last = Math.max(...(lab.faults ?? []).map((f) => f.at));
    expect(last).toBeGreaterThan(45 * SEC);
    for (const at of [0, 35 * SEC, 49 * SEC]) {
      const status = evaluateLab(labWorldAt(lab, at), lab);
      expect(status.score, `at ${at / SEC} s`).toBe(0);
      for (const r of status.results) {
        expect(r.pass).toBe(false);
        expect(r.assertions.filter((a) => a.detail !== undefined).map((a) => a.detail), `${r.task} at ${at / SEC} s`).toEqual([LAB_PREPARING_DETAIL]);
      }
    }
  }, LAB_TEST_TIMEOUT_MS);

  it('puts R3 on the router ID of R2 in use, and keeps every fault through a power cycle', () => {
    const lab = ccna3TroubleshootOspf;
    const sim = labWorld(lab);
    expect(ifRow(sim, 'R3', 'GigabitEthernet0/0')?.routerId).toBe(TROUBLE_DUPLICATE_RID);
    expect(ifRow(sim, 'R2', 'GigabitEthernet0/0')?.area).toBe('0.0.0.1');
    expect(ifRow(sim, 'R1', 'GigabitEthernet0/0')).toBeUndefined();
    // the interface views name the refused hellos the instructions point at
    expect(ifRow(sim, 'R2', 'GigabitEthernet0/1')?.rejected?.reason).toContain("this router's own router ID 2.2.2.2");
    expect(ifRow(sim, 'R1', 'GigabitEthernet0/1')?.rejected?.reason).toContain('area 0.0.0.1');
    for (const name of ['R1', 'R2', 'R3']) sim.setPower(idOf(sim, name), false);
    sim.runFor(1 * SEC);
    for (const name of ['R1', 'R2', 'R3']) sim.setPower(idOf(sim, name), true);
    sim.runFor(BOOT_NS);
    sim.runToIdle();
    expect(taskPasses(sim, lab)).toEqual(expectTasks(lab, false));
    expect(ifRow(sim, 'R3', 'GigabitEthernet0/0')?.routerId).toBe(TROUBLE_DUPLICATE_RID);
  }, LAB_TEST_TIMEOUT_MS);

  it('each repair earns its own task, in any order: the router ID on R3, the wildcard on R1, the area on R2', () => {
    const lab = ccna3TroubleshootOspf;
    const sim = labWorld(lab);
    typeOn(sim, 'R3', lab.solution?.['R3'] ?? []);
    sim.runToIdle();
    expect(taskPasses(sim, lab)).toEqual(expectTasks(lab, false, ['router-ids']));
    typeOn(sim, 'R1', lab.solution?.['R1'] ?? []);
    sim.runToIdle();
    expect(taskPasses(sim, lab)).toEqual(expectTasks(lab, false, ['router-ids', 'lan-advertised']));
    typeOn(sim, 'R2', lab.solution?.['R2'] ?? []);
    sim.runToIdle();
    expect(failures(sim, lab)).toEqual([]);
  }, LAB_TEST_TIMEOUT_MS);

  it('a router ID corrected without a restart fails live, until clear ip ospf process applies it', () => {
    const lab = ccna3TroubleshootOspf;
    const sim = labWorld(lab);
    typeOn(sim, 'R1', lab.solution?.['R1'] ?? []);
    typeOn(sim, 'R2', lab.solution?.['R2'] ?? []);
    typeOn(sim, 'R3', ['router ospf 1', 'router-id 3.3.3.3', 'exit']);
    sim.runToIdle();
    expect(taskPasses(sim, lab)['router-ids']).toBe(false);
    expect(taskDetails(sim, lab, 'router-ids')[0]).toBe(`R3 ospf.routerId is ${TROUBLE_DUPLICATE_RID}, expected 3.3.3.3.`);
    // the export already says 3.3.3.3: a clone booted from it would grade the fault as repaired
    const clone = createSimulation({ seed: lab.seed ?? 1 });
    clone.loadTopology(sim.exportTopology());
    clone.runFor(BOOT_NS);
    clone.runToIdle();
    expect(ifRow(clone, 'R3', 'GigabitEthernet0/0')?.routerId).toBe('3.3.3.3');
    clearOspfProcess(sim, 'R3');
    sim.runToIdle();
    expect(failures(sim, lab)).toEqual([]);
  }, LAB_TEST_TIMEOUT_MS);
});
