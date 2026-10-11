/**
 * labs.ccna3.discovery — the W5 disc lab, proved (ARCHITECTURE-P3 §7 W5 "lab files, one owner each", §11.1 lesson 28,
 * §11.2, §3.6, §5.5, D2, D18). The local copy of the checks of the sim builder's `labs.ccna3.solutions.test.ts`,
 * filtered to `ccna3-discover-neighbours`, plus what only this lab needs.
 *   • metadata (§11.2): category `ccna3-lab`, course `CCNA 3`, topic = the title of the module holding lesson 28, a
 *     fixed seed, `requires` = exactly the catalog types used, structured-clone safe metadata, unique task ids, only the
 *     §11.2 assertion kinds, the timing sentence in the instructions; the file imports only the contracts, `../kit.js`
 *     and `../templates.js` (rule 12) and exports the one array under its fixed name;
 *   • the world: a P3-profile topology (schema 1.3) loaded as a P3 world; PortFast on every switch port toward a host or
 *     a router, never on the link between the switches; CDP on by default on the routers and SW1, SW2 LLDP only;
 *   • UNSOLVED: every task fails, each with a detail; SOLVED: every solution line accepted, full marks; grading is
 *     read-only and repeatable.
 * Lab-specific cases: the learner's path typed on consoles (`configure terminal` … `end`), with the two delays the
 * instructions promise (SW1's own LLDP row for SW2 within 30 s; ISP's row for R1 until its hold time ends), and the
 * wrong answers each task must refuse: CDP switched off for a whole device, the descriptions on the wrong ports, LLDP
 * switched on on the wrong device, an LLDP user port that still receives.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../src/contracts/ids.js';
import type { LabAssertion, ScenarioInfo } from '../src/contracts/scenario.js';
import { scenarioMeta } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { CdpNeighbourRow, LldpNeighbourRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID_1_3, schemaIdFor, type Topology } from '../src/contracts/topology.js';
import { CCNA3_MODULES } from '../src/curriculum/ccna3/lessons.js';
import { createCatalog } from '../src/device/catalog/index.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { createSimulation } from '../src/sim/simulation.js';
import { CCNA3_DISCOVERY_LABS, ccna3DiscoverNeighbours } from '../src/sim/scenarios/ccna3/discovery.js';

const BOOT_NS = 90 * SEC;
const LAB_TEST_TIMEOUT_MS = 120_000;
/** The assertion kinds a CCNA 3 lab may use (§11.2). */
const LAB_KINDS: readonly LabAssertion['kind'][] = ['neighbor', 'fact', 'acl', 'aclDecision', 'route', 'table', 'connectivity', 'config', 'vlan', 'service', 'path', 'traffic'];
const LAB = ccna3DiscoverNeighbours;
const catalog = createCatalog(PROCESS_FACTORIES);

function labWorld(lab: ScenarioInfo = LAB): Simulation {
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

/** `lines` through `configure` on the device called `name`; every line must be accepted. */
function typeOn(sim: Simulation, name: string, lines: readonly string[]): void {
  const r = sim.configure(idOf(sim, name), lines);
  expect(r.lines.filter((l) => !l.ok).map((l) => `${l.line}: ${l.error?.message ?? l.output}`), name).toEqual([]);
}

/** `lines` typed on a console of the device called `name` in one configuration session (`configure terminal` … `end`). */
function typeConsole(sim: Simulation, name: string, lines: readonly string[]): void {
  const s = sim.cli.open(idOf(sim, name), 'console');
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) expect(sim.cli.exec(s, line).error, `${name}: ${line}`).toBeUndefined();
  sim.cli.close(s);
}

function applySolution(sim: Simulation, lab: ScenarioInfo = LAB): void {
  for (const [name, lines] of Object.entries(lab.solution ?? {})) typeOn(sim, name, lines);
  sim.runToIdle();
}

/** Pass flag of each task, by id. */
function passes(sim: Simulation): Record<string, boolean> {
  return Object.fromEntries(evaluateLab(sim, LAB).results.map((r) => [r.task, r.pass]));
}

const ALL_PASS = { 'cdp-map': true, 'lldp-map': true, 'quiet-edge': true, 'quiet-users': true };

const cdpRows = (sim: Simulation, name: string): CdpNeighbourRow[] => sim.device(idOf(sim, name))!.tables.get<CdpNeighbourRow>('cdp-neighbours')?.rows() ?? [];
const lldpRows = (sim: Simulation, name: string): LldpNeighbourRow[] => sim.device(idOf(sim, name))!.tables.get<LldpNeighbourRow>('lldp-neighbours')?.rows() ?? [];

describe('ccna3-discover-neighbours: the lab file', () => {
  it('describes itself as lab 28 of the CCNA 3 course, with structured-clone safe metadata and a catalog it uses', () => {
    expect(CCNA3_DISCOVERY_LABS).toEqual([LAB]);
    expect(LAB.name).toBe('ccna3-discover-neighbours');
    expect(LAB.category).toBe('ccna3-lab');
    expect(LAB.course).toBe('CCNA 3');
    const home = CCNA3_MODULES.flatMap((m) => m.lessons.map((l) => ({ l, m }))).find((x) => x.l.lab === LAB.name);
    expect(home?.l.id).toBe('ccna3-28-who-is-next-door');
    expect(LAB.topic).toBe(home?.m.title);
    expect(LAB.seed).toBeTypeOf('number');
    expect(LAB.instructions).toContain('Allow about a minute for the routers to start');
    const meta = scenarioMeta(LAB);
    expect(structuredClone(meta)).toEqual(meta);
    const topo = LAB.build();
    expect([...(LAB.requires ?? [])].sort()).toEqual([...new Set(topo.devices.map((d) => d.type))].sort());
    for (const type of LAB.requires ?? []) expect(catalog.get(type), type).toBeDefined();
    const ids = (LAB.tasks ?? []).map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of LAB.tasks ?? []) {
      expect(t.points).toBeGreaterThan(0);
      for (const a of t.assertions) expect(LAB_KINDS, `${t.id}: ${a.kind}`).toContain(a.kind);
      for (const dep of t.dependsOn ?? []) expect(ids).toContain(dep);
    }
    for (const name of Object.keys(LAB.solution ?? {})) expect(topo.devices.map((d) => d.name)).toContain(name);
  });

  it('imports only the contracts, the kit and the templates, and exports one array under its fixed name', () => {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sim', 'scenarios', 'ccna3', 'discovery.ts');
    const text = readFileSync(file, 'utf8');
    const specifiers = [...text.matchAll(/^import[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]);
    for (const s of specifiers) expect(s, s).toMatch(/^\.\.\/\.\.\/\.\.\/contracts\/[a-z-]+\.js$|^\.\.\/kit\.js$|^\.\.\/templates\.js$/);
    expect(text.match(/export const \w+: readonly ScenarioInfo\[\]/g)).toEqual(['export const CCNA3_DISCOVERY_LABS: readonly ScenarioInfo[]']);
  });

  it('builds a P3 world: PortFast toward hosts and routers only, CDP by default, SW2 speaking LLDP only', () => {
    const topo: Topology = LAB.build();
    expect(topo.profile).toBe('P3');
    expect(topo.schema).toBe(TOPOLOGY_SCHEMA_ID_1_3);
    expect(topo.schema).toBe(schemaIdFor(topo));
    const sim = labWorld();
    expect(sim.profile).toBe('P3');
    const edge = (name: string, port: string): boolean => /spanning-tree portfast/.test(sim.device(idOf(sim, name))!.running.render().split(`interface ${port}\n`)[1]?.split('!')[0] ?? '');
    for (const [name, port] of [['SW1', 'FastEthernet0/1'], ['SW1', 'FastEthernet0/2'], ['SW1', 'GigabitEthernet0/1'], ['SW2', 'FastEthernet0/1']] as const) {
      expect(edge(name, port), `${name} ${port}`).toBe(true);
    }
    expect(edge('SW1', 'GigabitEthernet0/2')).toBe(false);
    expect(edge('SW2', 'GigabitEthernet0/1')).toBe(false);
    // CDP maps every CDP speaker; SW2 is missing from it and speaks LLDP only (no one listens yet)
    expect(cdpRows(sim, 'SW1').map((r) => [r.localPort, r.deviceId])).toEqual([['GigabitEthernet0/1', 'R1']]);
    expect(cdpRows(sim, 'R1').map((r) => [r.localPort, r.deviceId]).sort()).toEqual([['GigabitEthernet0/0', 'SW1'], ['GigabitEthernet0/1', 'ISP']]);
    expect(sim.device(idOf(sim, 'SW2'))!.tables.get('cdp-neighbours')?.rows() ?? []).toEqual([]);
    expect(lldpRows(sim, 'SW2')).toEqual([]);
  });
});

describe('ccna3-discover-neighbours: graded', () => {
  it('fails every task before the student starts, and says why', () => {
    const status = evaluateLab(labWorld(), LAB);
    expect(status.results.filter((r) => r.pass).map((r) => r.task)).toEqual([]);
    expect(status.score).toBe(0);
    for (const r of status.results) expect(r.assertions.some((a) => !a.pass && (a.detail ?? '') !== ''), r.task).toBe(true);
  }, LAB_TEST_TIMEOUT_MS);

  it('scores full marks with the reference solution, read-only and repeatably', () => {
    const sim = labWorld();
    applySolution(sim);
    const now = sim.now;
    const head = sim.trace(0).next;
    const pdus = sim.snapshot().pduCount;
    const first = evaluateLab(sim, LAB);
    expect(first.results.filter((r) => !r.pass).map((r) => `${r.task}: ${r.assertions.map((a) => a.detail ?? '').join(' ')}`)).toEqual([]);
    expect(first.score).toBe(first.total);
    expect(evaluateLab(sim, LAB)).toEqual(first);
    expect(sim.now).toBe(now);
    expect(sim.trace(0).next).toBe(head);
    expect(sim.snapshot().pduCount).toBe(pdus);
  }, LAB_TEST_TIMEOUT_MS);

  it('the learner path on the consoles scores full marks, with the delays the instructions promise', () => {
    const sim = labWorld();
    const solution = LAB.solution ?? {};
    for (const name of ['R1', 'SW1', 'SW2']) typeConsole(sim, name, solution[name] ?? []);
    sim.runToIdle();
    expect(passes(sim)).toEqual(ALL_PASS);
    // SW1 hears SW2 at SW2's next LLDP announcement (every 30 s), with the description SW2 gave its port
    expect(lldpRows(sim, 'SW1')).toEqual([]);
    sim.runFor(31 * SEC);
    const sw2 = lldpRows(sim, 'SW1');
    expect(sw2.map((r) => [r.localPort, r.systemName, r.portId, r.mgmtAddress])).toEqual([['GigabitEthernet0/2', 'SW2', 'GigabitEthernet0/1', '10.28.0.3']]);
    expect(sw2[0]!.portDescription).toBe('link to SW1 Gi0/2');
    // R1 forgot ISP at once; ISP keeps R1's last announcement until its 180 s hold time runs out
    expect(cdpRows(sim, 'R1').map((r) => r.deviceId)).toEqual(['SW1']);
    expect(cdpRows(sim, 'ISP').map((r) => r.deviceId)).toEqual(['R1']);
    sim.runFor(180 * SEC);
    expect(cdpRows(sim, 'ISP')).toEqual([]);
    expect(passes(sim)).toEqual(ALL_PASS);
  }, LAB_TEST_TIMEOUT_MS);
});

describe('ccna3-discover-neighbours: wrong answers', () => {
  it('CDP switched off for the whole router fails the edge task and blinds the map', () => {
    const sim = labWorld();
    applySolution(sim);
    typeOn(sim, 'R1', ['interface GigabitEthernet0/1', 'cdp enable', 'exit', 'no cdp run']);
    sim.runToIdle();
    expect(passes(sim)).toEqual({ ...ALL_PASS, 'cdp-map': false, 'quiet-edge': false });
  }, LAB_TEST_TIMEOUT_MS);

  it('CDP switched off for the whole of SW1 fails the user-port task', () => {
    const sim = labWorld();
    applySolution(sim);
    typeOn(sim, 'SW1', ['no cdp run']);
    sim.runToIdle();
    expect(passes(sim)['quiet-users']).toBe(false);
  }, LAB_TEST_TIMEOUT_MS);

  it('descriptions on the wrong ports fail the map tasks', () => {
    const sim = labWorld();
    applySolution(sim);
    typeOn(sim, 'SW1', ['interface GigabitEthernet0/1', 'description link to SW2', 'interface GigabitEthernet0/2', 'description link to R1']);
    sim.runToIdle();
    expect(passes(sim)).toEqual({ ...ALL_PASS, 'cdp-map': false, 'lldp-map': false });
  }, LAB_TEST_TIMEOUT_MS);

  it('LLDP switched on on R1 instead of SW1 finds nothing and leaks toward the provider', () => {
    const sim = labWorld();
    const solution = LAB.solution ?? {};
    typeOn(sim, 'R1', [...(solution['R1'] ?? []), 'lldp run']);
    typeOn(sim, 'SW1', (solution['SW1'] ?? []).filter((l) => l !== 'lldp run'));
    typeOn(sim, 'SW2', solution['SW2'] ?? []);
    sim.runToIdle();
    // SW1 runs no LLDP, so the link between the switches lost it too
    expect(passes(sim)).toEqual({ ...ALL_PASS, 'lldp-map': false, 'quiet-edge': false, 'quiet-users': false });
  }, LAB_TEST_TIMEOUT_MS);

  it('a user port that still receives LLDP fails the user-port task', () => {
    const sim = labWorld();
    applySolution(sim);
    typeOn(sim, 'SW2', ['interface FastEthernet0/1', 'lldp receive']);
    sim.runToIdle();
    expect(passes(sim)).toEqual({ ...ALL_PASS, 'quiet-users': false });
  }, LAB_TEST_TIMEOUT_MS);

  it('LLDP switched off on SW2 (globally, or on its switch link) fails the user-port task as well as the map (W5 fix #20)', () => {
    const sw2 = (LAB.solution?.['SW2'] ?? []).filter((l) => !['interface FastEthernet0/1', 'no lldp transmit', 'no lldp receive'].includes(l));
    for (const [what, lines] of [
      ['no lldp run', [...sw2, 'exit', 'no lldp run']],
      ['silenced switch link', [...(LAB.solution?.['SW2'] ?? []), 'interface GigabitEthernet0/1', 'no lldp transmit', 'no lldp receive']],
    ] as const) {
      const sim = labWorld();
      applySolution(sim, { ...LAB, solution: { ...LAB.solution, SW2: lines } });
      expect(passes(sim), what).toEqual({ ...ALL_PASS, 'lldp-map': false, 'quiet-users': false });
      const quiet = evaluateLab(sim, LAB).results.find((r) => r.task === 'quiet-users')!;
      expect(quiet.assertions.filter((a) => !a.pass).map((a) => a.detail), what).toEqual(["SW2 lldp.enabled of GigabitEthernet0/1 is false, expected true. LLDP no longer runs on SW2's end of the link between the switches."]);
      expect(quiet.misconception, what).toBe('discovery-off-globally');
    }
  }, LAB_TEST_TIMEOUT_MS * 2);
});
