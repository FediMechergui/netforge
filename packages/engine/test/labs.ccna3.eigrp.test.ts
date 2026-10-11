/**
 * P3 W5 eigrp: the two CCNA 3 EIGRP labs [C1] — `ccna3-eigrp-feasible-successor` (lesson 10) and
 * `ccna3-troubleshoot-eigrp` (lesson 33) — proved the way the sim builder's `labs.ccna3.solutions.test.ts` proves every
 * CCNA 3 lab (ARCHITECTURE-P3 §7 W5, §11.1, §11.2; the twin of `labs.ccna2.solutions.test.ts`, filtered to these two).
 * Owner: the W5 eigrp item; kept beside the generic test as the area's own proof.
 *
 * For each lab:
 *   • its metadata: category `ccna3-lab`, course `CCNA 3`, `topic` = the title of the module that holds its lesson in
 *     curriculum/ccna3/lessons.ts, the name §11.1 freezes, a fixed seed, structured-clone safe `scenarioMeta`,
 *     `requires` = exactly the catalog types the topology uses, tasks with unique ids, real points and existing
 *     dependencies, a solution for devices the topology has, scheduled faults aimed at devices it has, and §11.2's
 *     EIGRP timing note (only the router boot is waited for: "about a minute", no OSPF-style 90 s warning);
 *   • its world: a P3-profile topology whose schema is `schemaIdFor(t)` (1.3), loaded as a P3 world;
 *   • UNSOLVED (built, scheduled faults injected the way the worker does, booted and settled): at least one task
 *     fails, and every failing task says why on a failing assertion;
 *   • SOLVED: `configure` accepts every line of the reference solution as written, the world runs to idle, and every
 *     task passes — full marks;
 *   • grading is read-only (same clock, trace head and PDU count) and repeatable (two evaluations are equal).
 *
 * Lab-specific cases: lab 10's metrics are §3.12's, recomputed here from D26's formula; the live topology table
 * holds the successor and feasible successor of §3.12 step 2 and none for the R2–R4 link; the wrong answers score what
 * they should (EIGRP without describing the slow circuit: two successors and no feasible successor; another AS on
 * every router). Lab 33: nothing is graded before the hidden faults land, the unsolved lab earns nothing, a power cycle
 * keeps the faults, each repair alone earns exactly its own task, R1 logs the K-value mismatch the instructions point
 * at, and a static-route workaround does not earn the network-line task. The lab file imports only the contracts,
 * `../kit.js` and `../templates.js`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../src/contracts/ids.js';
import type { ScenarioInfo } from '../src/contracts/scenario.js';
import { scenarioMeta } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { EigrpTopologyRow } from '../src/contracts/tables.js';
import { MS, SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID_1_3, schemaIdFor, type Topology } from '../src/contracts/topology.js';
import { CCNA3_MODULES } from '../src/curriculum/ccna3/lessons.js';
import { createCatalog } from '../src/device/catalog/index.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import { LAB_PREPARING_DETAIL, evaluateLab } from '../src/sim/lab-checks.js';
import { CCNA3_EIGRP_LABS, EIGRP_LAB_AS, ccna3EigrpFeasibleSuccessor, ccna3TroubleshootEigrp } from '../src/sim/scenarios/ccna3/eigrp.js';
import { createSimulation } from '../src/sim/simulation.js';

/** Long enough for every model of a lab to boot (a router takes 45 s) and for lab 33's hidden faults (50 s) to land. */
const BOOT_NS = 90 * SEC;

/** Wall-clock budget of one per-lab world test: a lab world plus one grading clone per fault set it names. */
const LAB_TEST_TIMEOUT_MS = 60_000;

const catalog = createCatalog(PROCESS_FACTORIES);

/** The lessons of the skeleton in teaching order, with the title of the module that holds each. */
const LESSONS = CCNA3_MODULES.flatMap((m) => m.lessons.map((l) => ({ lesson: l, module: m.title })));

/** The lab's world as `loadScenario` builds it: the lab seed, the lab topology, its scheduled faults, booted and settled. */
function labWorld(lab: ScenarioInfo): Simulation {
  const sim = createSimulation({ seed: lab.seed ?? 1 });
  const topo: Topology = { ...lab.build(), lab: { name: lab.name, version: lab.version ?? 1 } };
  sim.loadTopology(topo);
  // the worker injects a lab's scheduled faults right after the load (apps/web bridge/worker applyFaults)
  for (const f of lab.faults ?? []) sim.injectFault(f.at, f.fault);
  sim.runFor(BOOT_NS);
  sim.runToIdle();
  return sim;
}

/** The lab world at `at`, as the worker holds it before a check at that instant (loaded, faults injected, not settled). */
function labWorldAt(lab: ScenarioInfo, at: number): Simulation {
  const sim = createSimulation({ seed: lab.seed ?? 1 });
  sim.loadTopology({ ...lab.build(), lab: { name: lab.name, version: lab.version ?? 1 } });
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

/** The `eigrp-topology` row of `prefix` on the device called `name`. */
function topologyRow(sim: Simulation, name: string, prefix: string): EigrpTopologyRow | undefined {
  return sim.device(idOf(sim, name))!.tables.get<EigrpTopologyRow>('eigrp-topology')?.get(prefix);
}

/** What `line` prints on a fresh privileged console of the device called `name` (opened and closed here). */
function shown(sim: Simulation, name: string, line: string): string {
  const s = sim.cli.open(idOf(sim, name), 'console');
  sim.cli.exec(s, 'enable');
  const out = sim.cli.exec(s, line).output;
  sim.cli.close(s);
  return out;
}

/** D26's classic composite metric with the default K values: 256 × (floor(10⁷ / slowest kb/s) + floor(Σ delay µs / 10)). */
const classic = (minBwKbps: number, delayUs: number): number => 256 * (Math.floor(10_000_000 / minBwKbps) + Math.floor(delayUs / 10));

describe('CCNA3 EIGRP labs: the file', () => {
  it('exports the two labs of lessons 10 and 33 under the fixed name, in course order', () => {
    expect(CCNA3_EIGRP_LABS.map((l) => l.name)).toEqual(['ccna3-eigrp-feasible-successor', 'ccna3-troubleshoot-eigrp']);
    expect(CCNA3_EIGRP_LABS).toEqual([ccna3EigrpFeasibleSuccessor, ccna3TroubleshootEigrp]);
    expect(Object.isFrozen(CCNA3_EIGRP_LABS)).toBe(true);
    // each is the lab of exactly one lesson, 10 and 33
    const homes = CCNA3_EIGRP_LABS.map((lab) => LESSONS.filter((l) => l.lesson.lab === lab.name).map((l) => l.lesson.id));
    expect(homes).toEqual([['ccna3-10-eigrp-and-its-metric'], ['ccna3-33-a-method-for-enterprise-faults']]);
  });

  it('imports only the contracts, the kit and the templates', () => {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sim', 'scenarios', 'ccna3', 'eigrp.ts');
    const text = readFileSync(file, 'utf8');
    const imports = [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec, `eigrp.ts imports ${spec}`).toMatch(/^\.\.\/\.\.\/\.\.\/contracts\/[a-z-]+\.js$|^\.\.\/kit\.js$|^\.\.\/templates\.js$/);
  });
});

for (const lab of CCNA3_EIGRP_LABS) {
  describe(`CCNA3 lab: ${lab.name}`, () => {
    it('describes itself with structured-clone safe metadata, its module as topic and a catalog it really uses', () => {
      expect(lab.category).toBe('ccna3-lab');
      expect(lab.course).toBe('CCNA 3');
      expect(lab.name).toMatch(/^ccna3(-[a-z0-9]+)+$/);
      const home = LESSONS.find((l) => l.lesson.lab === lab.name);
      expect(home, `${lab.name} is the lab of a lesson`).toBeDefined();
      expect(lab.topic).toBe(home?.module);
      expect(lab.labType).toBeDefined();
      expect(lab.seed, lab.name).toBeTypeOf('number');
      expect(lab.build().seed).toBe(lab.seed);
      expect(lab.instructions ?? '', lab.name).not.toBe('');
      expect((lab.objectives ?? []).length, lab.name).toBeGreaterThan(0);
      expect((lab.tasks ?? []).length, lab.name).toBeGreaterThan(0);
      expect(Object.keys(lab.solution ?? {}).length, lab.name).toBeGreaterThan(0);
      // §11.2: an EIGRP lab waits only for the router boot ("about a minute"), never OSPF's 90 s
      expect(lab.instructions).toContain('about a minute');
      expect(lab.instructions).not.toMatch(/90 s/);

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
      expect((lab.tasks ?? []).reduce((n, t) => n + t.points, 0)).toBe(100);
      for (const task of lab.tasks ?? []) {
        expect(task.points, `${lab.name}/${task.id}`).toBeGreaterThan(0);
        expect(task.assertions.length, `${lab.name}/${task.id}`).toBeGreaterThan(0);
        for (const dep of task.dependsOn ?? []) expect(ids, `${lab.name}/${task.id}`).toContain(dep);
      }
      const deviceNames = topo.devices.map((d) => d.name);
      for (const name of Object.keys(lab.solution ?? {})) expect(deviceNames).toContain(name);
      const deviceIds = topo.devices.map((d) => d.id);
      const linkIds = topo.links.map((l) => l.id);
      for (const { fault } of lab.faults ?? []) {
        if (fault.target.device !== undefined) expect(deviceIds, fault.id).toContain(fault.target.device);
        if (fault.target.link !== undefined) expect(linkIds, fault.id).toContain(fault.target.link);
      }
    });

    it('builds a P3-profile world whose schema can express it', () => {
      const topo = lab.build();
      expect(topo.profile).toBe('P3');
      expect(topo.schema).toBe(TOPOLOGY_SCHEMA_ID_1_3);
      expect(topo.schema).toBe(schemaIdFor(topo));
      const sim = createSimulation({ seed: lab.seed ?? 1 });
      sim.loadTopology(topo);
      expect(sim.profile).toBe('P3');
      expect(sim.exportTopology()).toMatchObject({ profile: 'P3', schema: TOPOLOGY_SCHEMA_ID_1_3 });
    });

    it('fails at least one task before the student starts, and says why', () => {
      const sim = labWorld(lab);
      const status = evaluateLab(sim, lab);
      expect(status.lab).toBe(lab.name);
      expect(status.total).toBe((lab.tasks ?? []).reduce((n, t) => n + t.points, 0));
      const failed = status.results.filter((r) => !r.pass);
      expect(failed.length, `${lab.name} unsolved`).toBeGreaterThan(0);
      expect(status.score).toBeLessThan(status.total);
      for (const r of failed) expect(r.assertions.some((a) => !a.pass && (a.detail ?? '') !== ''), `${lab.name}/${r.task}`).toBe(true);
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

describe('ccna3-eigrp-feasible-successor: §3.12 in the live world', () => {
  const lab = ccna3EigrpFeasibleSuccessor;
  const GIGE = { bw: 1_000_000, delay: 10 };
  const SLOW = { bw: 100_000, delay: 100 };

  it('pins the metrics the tasks grade to D26 and §3.12', () => {
    // 10.4.0.0/24 through R2: three gigabit interfaces; through R3: the slow circuit, then two gigabit interfaces
    expect(classic(GIGE.bw, 3 * GIGE.delay)).toBe(3328);
    expect(classic(SLOW.bw, SLOW.delay + 2 * GIGE.delay)).toBe(28672);
    // the reported distances: R2's and R3's own distance to 10.4.0.0/24 (two gigabit interfaces)
    expect(classic(GIGE.bw, 2 * GIGE.delay)).toBe(3072);
    // 10.0.24.0/24: R2's FD (two gigabit interfaces) equals R3's reported distance (through R4) — not feasible
    expect(classic(GIGE.bw, 2 * GIGE.delay)).toBe(3072);
    const tasks = Object.fromEntries((lab.tasks ?? []).map((t) => [t.id, JSON.stringify(t.assertions)]));
    expect(tasks.successor).toContain('"metric":3328');
    expect(tasks['feasible-successor']).toContain('"metric":28672');
    expect(tasks['no-feasible-successor']).toContain('"equals":3072');
    expect(tasks['no-feasible-successor']).toContain('"metric":28672');
  });

  it('holds the successor and the feasible successor of §3.12 step 2, and none for the R2–R4 link', () => {
    const sim = labWorld(lab);
    applySolution(sim, lab);
    expect(topologyRow(sim, 'R1', '10.4.0.0/24')).toMatchObject({
      state: 'passive',
      fd: 3328,
      successors: [{ nextHop: '10.0.12.2', iface: 'GigabitEthernet0/0', metric: 3328, rd: 3072 }],
      feasible: [{ nextHop: '10.0.13.3', iface: 'GigabitEthernet0/1', metric: 28672, rd: 3072 }],
    });
    const link = topologyRow(sim, 'R1', '10.0.24.0/24');
    expect(link).toMatchObject({ state: 'passive', fd: 3072, successors: [{ nextHop: '10.0.12.2', metric: 3072, rd: 2816 }], feasible: [] });
    expect(link?.others).toMatchObject([{ nextHop: '10.0.13.3', rd: 3072 }]);
    // what the learner reads (§3.12 step 2)
    const topo = shown(sim, 'R1', 'show ip eigrp topology');
    expect(topo).toContain('10.4.0.0/24, 1 successor, FD 3328');
    expect(topo).toContain('via 10.0.13.3 (28672/3072), GigabitEthernet0/1');
    expect(shown(sim, 'R1', 'show ip route')).toMatch(/D\s+10\.4\.0\.0\/24\s+via 10\.0\.12\.2 \[90\/3328\] GigabitEthernet0\/0/);
  }, LAB_TEST_TIMEOUT_MS);

  it('shows the learner both failovers the instructions describe (steps 6 and 7)', () => {
    const sim = labWorld(lab);
    applySolution(sim, lab);
    // step 6: all-links shows R3's path to the R2–R4 link, whose RD only equals the FD
    const allLinks = shown(sim, 'R1', 'show ip eigrp topology all-links');
    expect(allLinks).toContain('10.0.24.0/24, 1 successor, FD 3072');
    expect(allLinks).toContain('via 10.0.13.3 (28672/3072), GigabitEthernet0/1');
    // step 7, typed as the learner types it
    const s = sim.cli.open(idOf(sim, 'R1'), 'console');
    const run = (line: string): string => {
      const r = sim.cli.exec(s, line);
      expect(r.output, line).not.toMatch(/^%|\n%/);
      return r.output;
    };
    for (const line of ['enable', 'debug eigrp fsm', 'configure terminal', 'interface GigabitEthernet0/0']) run(line);
    const cursor = sim.trace(0).next;
    const t = sim.now;
    run('shutdown');
    run('end');
    sim.runFor(1 * SEC);
    const events = sim.trace(cursor).events;
    const fsm = events.flatMap((e) =>
      e.kind === 'debug' && e.event.device === 'r1' && e.event.fsm?.machine === 'eigrp-route' ? [{ t: e.t - t, ...e.event.fsm }] : [],
    );
    // 10.4.0.0/24: the feasible successor is promoted in the same instant, no query
    expect(fsm.filter((f) => f.subject === '10.4.0.0/24')).toEqual([{ t: 0, machine: 'eigrp-route', subject: '10.4.0.0/24', from: 'passive', to: 'passive', cause: 'feasible successor promoted' }]);
    // 10.0.24.0/24: active at once, passive again when R3's reply is in (well under a millisecond on gigabit links)
    const link = fsm.filter((f) => f.subject === '10.0.24.0/24');
    expect(link.map((f) => [f.from, f.to])).toEqual([['passive', 'active'], ['active', 'passive']]);
    expect(link[0]?.t).toBe(0);
    expect(link[1]?.t).toBeGreaterThan(0);
    expect(link[1]?.t).toBeLessThan(1_000_000);
    const routes = shown(sim, 'R1', 'show ip route eigrp');
    expect(routes).toMatch(/D\s+10\.4\.0\.0\/24\s+via 10\.0\.13\.3 \[90\/28672\] GigabitEthernet0\/1/);
    expect(routes).toMatch(/D\s+10\.0\.24\.0\/24\s+via 10\.0\.13\.3 \[90\/28672\] GigabitEthernet0\/1/);
    // and back: the cable to R2 carries both routes again once the interface is up
    for (const line of ['configure terminal', 'interface GigabitEthernet0/0', 'no shutdown', 'end', 'undebug all']) run(line);
    sim.cli.close(s);
    sim.runToIdle();
    expect(shown(sim, 'R1', 'show ip route eigrp')).toMatch(/D\s+10\.4\.0\.0\/24\s+via 10\.0\.12\.2 \[90\/3328\] GigabitEthernet0\/0/);
    expect(failures(sim, lab)).toEqual([]);
  }, LAB_TEST_TIMEOUT_MS);

  it('wrong answer: EIGRP everywhere without describing the slow circuit gives two successors and no backup', () => {
    const sim = labWorld(lab);
    for (const name of ['R1', 'R2', 'R3', 'R4']) typeOn(sim, name, [`router eigrp ${EIGRP_LAB_AS}`, 'network 10.0.0.0', 'exit']);
    sim.runToIdle();
    expect(topologyRow(sim, 'R1', '10.4.0.0/24')?.successors.map((p) => p.nextHop)).toEqual(['10.0.12.2', '10.0.13.3']);
    const status = evaluateLab(sim, lab);
    expect(Object.fromEntries(status.results.map((r) => [r.task, r.pass]))).toEqual({
      neighbours: true,
      'slow-circuit': false,
      successor: true,
      'feasible-successor': false,
      'no-feasible-successor': false,
    });
    expect(status.results.find((r) => r.task === 'feasible-successor')?.misconception).toBe('eigrp-fs-needs-unequal-metric');
    expect(status.score).toBe(40);
  }, LAB_TEST_TIMEOUT_MS);

  it('wrong answer: another autonomous system on every router forms the network but misses the neighbour task', () => {
    const sim = labWorld(lab);
    for (const name of ['R1', 'R2', 'R3', 'R4']) typeOn(sim, name, ['router eigrp 1', 'network 10.0.0.0', 'exit']);
    typeOn(sim, 'R1', ['interface GigabitEthernet0/1', 'bandwidth 100000', 'delay 10', 'exit']);
    typeOn(sim, 'R3', ['interface GigabitEthernet0/0', 'bandwidth 100000', 'delay 10', 'exit']);
    sim.runToIdle();
    const passes = taskPasses(sim, lab);
    expect(passes).toEqual({ neighbours: false, 'slow-circuit': true, successor: true, 'feasible-successor': true, 'no-feasible-successor': true });
  }, LAB_TEST_TIMEOUT_MS);
});

describe('ccna3-troubleshoot-eigrp: the hidden faults', () => {
  const lab = ccna3TroubleshootEigrp;

  it('grades nothing before its last hidden fault has landed, and nothing once they have', () => {
    const last = Math.max(...(lab.faults ?? []).map((f) => f.at));
    expect(last).toBeGreaterThan(45 * SEC);
    for (const at of [0, 30 * SEC, 47 * SEC]) {
      const status = evaluateLab(labWorldAt(lab, at), lab);
      expect(status.score, `at ${at / SEC} s`).toBe(0);
      for (const r of status.results) {
        expect(r.pass).toBe(false);
        expect(r.assertions.filter((a) => a.detail !== undefined).map((a) => a.detail), r.task).toEqual([LAB_PREPARING_DETAIL]);
      }
    }
    const sim = labWorld(lab);
    const status = evaluateLab(sim, lab);
    expect(status.score).toBe(0);
    for (const r of status.results) expect(r.assertions.some((a) => a.detail === LAB_PREPARING_DETAIL), r.task).toBe(false);
    // the symptoms the instructions describe: R1 hears from no branch
    expect(sim.device(idOf(sim, 'R1'))!.tables.get('eigrp-neighbors')?.rows() ?? []).toEqual([]);
  }, LAB_TEST_TIMEOUT_MS);

  it('logs the K-value mismatch on R1, where the instructions send the learner', () => {
    const sim = labWorld(lab);
    expect(shown(sim, 'R1', 'show logging')).toMatch(/K-value/i);
  }, LAB_TEST_TIMEOUT_MS);

  it('keeps the hidden changes through a power cycle of the routers that hold them', () => {
    const sim = labWorld(lab);
    for (const name of ['R1', 'R2', 'R3', 'R4']) sim.setPower(idOf(sim, name), false);
    sim.runFor(1 * SEC);
    for (const name of ['R1', 'R2', 'R3', 'R4']) sim.setPower(idOf(sim, name), true);
    sim.runFor(120 * SEC);
    sim.runToIdle();
    expect(evaluateLab(sim, lab).score).toBe(0);
    expect(sim.device(idOf(sim, 'R2'))!.startup?.render()).toContain('router eigrp 200');
    expect(sim.device(idOf(sim, 'R3'))!.startup?.render()).toContain('metric weights 0 1 1 1 0 0');
  }, 2 * LAB_TEST_TIMEOUT_MS);

  it('gives each repair alone exactly its own task, within milliseconds of typing it', () => {
    const only: Record<string, string> = { R2: 'autonomous-system', R3: 'k-values', R4: 'passive-uplink', R1: 'hq-network' };
    for (const [name, task] of Object.entries(only)) {
      const sim = labWorld(lab);
      typeOn(sim, name, lab.solution?.[name] ?? []);
      // the instructions' timing sentence: once the routers agree, EIGRP peers within milliseconds (§11.2, §3.12)
      sim.runFor(50 * MS);
      const passes = taskPasses(sim, lab);
      const expected = Object.fromEntries((lab.tasks ?? []).map((t) => [t.id, t.id === task]));
      expect(passes, `only ${name} repaired`).toEqual(expected);
    }
  }, 4 * LAB_TEST_TIMEOUT_MS);

  it('wrong answer: static routes to the HQ LAN at the branches reach the server but do not repair the network line', () => {
    const sim = labWorld(lab);
    for (const name of ['R2', 'R3', 'R4']) typeOn(sim, name, lab.solution?.[name] ?? []);
    const uplink: Record<string, string> = { R2: '10.0.12.1', R3: '10.0.13.1', R4: '10.0.14.1' };
    for (const [name, hop] of Object.entries(uplink)) typeOn(sim, name, [`ip route 192.168.1.0 255.255.255.0 ${hop}`]);
    sim.runToIdle();
    const status = evaluateLab(sim, lab);
    const passes = Object.fromEntries(status.results.map((r) => [r.task, r.pass]));
    expect(passes).toEqual({ 'autonomous-system': true, 'k-values': true, 'passive-uplink': true, 'hq-network': false, 'end-to-end': true });
    expect(status.results.find((r) => r.task === 'hq-network')?.assertions[0]?.detail).toContain('192.168.1.0/24');
  }, LAB_TEST_TIMEOUT_MS);
});
