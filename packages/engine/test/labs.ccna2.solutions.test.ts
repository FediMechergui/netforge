/**
 * P2 W5 sim: the CCNA 2 lab catalogue, every lab's reference solution and its tasks (ARCHITECTURE-P2 §7 W5, §10.1
 * `accept.p2.labs`, §11.1, §11.2; the twin of labs.solutions.test.ts).
 *
 * GENERIC over `CCNA2_LABS` (all nineteen labs, pinned in course order). For each lab the test checks:
 *   • its metadata: category `ccna2-lab`, course `CCNA 2`, `topic` = the title of the module that holds its lesson in
 *     curriculum/ccna2/lessons.ts, a fixed seed, structured-clone safe `scenarioMeta`, `requires` = exactly the catalog
 *     types the topology uses (all in the real catalog), tasks with unique ids, real points and existing dependencies,
 *     a solution for devices the topology has, scheduled faults aimed at devices and cables it has;
 *   • its world: a P2-profile topology whose schema is `schemaIdFor(t)` (1.2), loaded as a P2 world;
 *   • UNSOLVED (built, scheduled faults injected the way the worker does, booted and settled): at least one task
 *     fails, and every failing task says why on a failing assertion;
 *   • SOLVED: `configure` accepts every line of the reference solution as written (a refused line is a defect in the
 *     lab and is reported in full), the world runs to idle, and every task passes — full marks;
 *   • grading is read-only (same clock, trace head and PDU count) and repeatable (two evaluations are equal).
 *
 * Static cases: every lab of the eleven files is named in `CCNA2_LAB_ORDER` exactly once, sits in the file its lesson
 * belongs to, and `CCNA2_LABS` follows that order; the order itself follows the lesson skeleton; `SCENARIOS` is the
 * templates, then `CCNA1_LABS`, then `CCNA2_LABS`; the kit writes P2 topologies with the 1.2 schema and leaves every
 * P1 caller's topology unchanged, writes the canonical switching lines, and its three fault helpers (err-disable,
 * cable cut, config fragment) take effect when injected as the worker injects a lab's faults; no lab file imports
 * the catalogue it is part of.
 *
 * W5 review: the wrong answers the review found score what they should (a swapped root pair, a floating route with no
 * main route, a standby group left to one router, a stale secure address kept beside a larger maximum, an unused
 * port left open, a static bundle facing lone LACP members) and a right answer typed in another order still passes; a troubleshooting lab grades nothing
 * before its hidden faults land, and a power cycle does not undo them.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../src/contracts/ids.js';
import type { ScenarioInfo } from '../src/contracts/scenario.js';
import { scenarioMeta } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID_1_1, TOPOLOGY_SCHEMA_ID_1_2, schemaIdFor, type Topology } from '../src/contracts/topology.js';
import { CCNA2_MODULES } from '../src/curriculum/ccna2/lessons.js';
import { createCatalog } from '../src/device/catalog/index.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import { LAB_PREPARING_DETAIL, evaluateLab } from '../src/sim/lab-checks.js';
import { createSimulation } from '../src/sim/simulation.js';
import {
  CCNA2_DHCPV6_LABS,
  CCNA2_ETHERCHANNEL_LABS,
  CCNA2_FHRP_LABS,
  CCNA2_INTERVLAN_LABS,
  CCNA2_LABS,
  CCNA2_LAB_ORDER,
  CCNA2_NAT_LABS,
  CCNA2_ROUTING_LABS,
  CCNA2_SECURITY_LABS,
  CCNA2_STP_LABS,
  CCNA2_TROUBLESHOOTING_LABS,
  CCNA2_TRUNK_LABS,
  CCNA2_VLAN_LABS,
} from '../src/sim/scenarios/ccna2/index.js';
import { ccna2EtherchannelLacp } from '../src/sim/scenarios/ccna2/etherchannel.js';
import { ccna2HsrpGateway } from '../src/sim/scenarios/ccna2/fhrp.js';
import { ccna2FloatingStatic } from '../src/sim/scenarios/ccna2/routing.js';
import { STALE_SECURE_MAC, ccna2PortSecurity } from '../src/sim/scenarios/ccna2/security.js';
import { ccna2StpGuards, ccna2StpRootPlacement } from '../src/sim/scenarios/ccna2/stp.js';
import { ccna2TroubleshootRouting, ccna2TroubleshootVlans } from '../src/sim/scenarios/ccna2/troubleshooting.js';
import {
  PC,
  SWITCH,
  accessPort,
  cableCutFault,
  configFragmentFault,
  configText,
  device,
  errDisableFault,
  link,
  topology,
  trunkPort,
  vlanSections,
} from '../src/sim/scenarios/kit.js';
import { CCNA1_LABS, SCENARIOS, TEMPLATES } from '../src/sim/scenarios.js';

/** Long enough for every model of a lab to boot (the router takes 45 s); `runToIdle` then waits out spanning tree. */
const BOOT_NS = 90 * SEC;

/** Wall-clock budget of one per-lab world test: a lab world plus one grading clone per fault set it names. */
const LAB_TEST_TIMEOUT_MS = 60_000;

const catalog = createCatalog(PROCESS_FACTORIES);

/** The eleven lab files, by file name, with their fixed export and the labs their lessons give them (§11.1). */
const FILES: readonly { file: string; labs: readonly ScenarioInfo[]; names: readonly string[] }[] = [
  { file: 'vlans', labs: CCNA2_VLAN_LABS, names: ['ccna2-switch-management', 'ccna2-vlan-access-ports'] },
  { file: 'trunks', labs: CCNA2_TRUNK_LABS, names: ['ccna2-trunk-native-allowed', 'ccna2-dtp-modes'] },
  { file: 'intervlan', labs: CCNA2_INTERVLAN_LABS, names: ['ccna2-router-on-a-stick', 'ccna2-l3-switch-svis'] },
  { file: 'stp', labs: CCNA2_STP_LABS, names: ['ccna2-stp-root-placement', 'ccna2-rapid-stp', 'ccna2-stp-guards'] },
  { file: 'etherchannel', labs: CCNA2_ETHERCHANNEL_LABS, names: ['ccna2-etherchannel-lacp'] },
  { file: 'dhcpv6', labs: CCNA2_DHCPV6_LABS, names: ['ccna2-dhcpv6'] },
  { file: 'fhrp', labs: CCNA2_FHRP_LABS, names: ['ccna2-hsrp-gateway'] },
  { file: 'security', labs: CCNA2_SECURITY_LABS, names: ['ccna2-port-security'] },
  { file: 'routing', labs: CCNA2_ROUTING_LABS, names: ['ccna2-static-routes', 'ccna2-floating-static', 'ccna2-ipv6-static'] },
  { file: 'nat', labs: CCNA2_NAT_LABS, names: ['ccna2-nat-pat'] },
  { file: 'troubleshooting', labs: CCNA2_TROUBLESHOOTING_LABS, names: ['ccna2-troubleshoot-vlans', 'ccna2-troubleshoot-routing'] },
];

/** Every lab of the eleven files, in file order. */
const ALL_FILE_LABS: readonly ScenarioInfo[] = FILES.flatMap((f) => f.labs);

/** The lessons of the skeleton in teaching order, with the title of the module that holds each. */
const LESSONS = CCNA2_MODULES.flatMap((m) => m.lessons.map((l) => ({ lesson: l, module: m.title })));

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

/** Tasks that did not pass, each with the details of its failing assertions. */
function failures(sim: Simulation, lab: ScenarioInfo): string[] {
  return evaluateLab(sim, lab)
    .results.filter((r) => !r.pass)
    .map((r) => `${r.task}: ${r.assertions.filter((a) => !a.pass).map((a) => a.detail ?? '(no detail)').join(' | ')}`);
}

describe('CCNA2 labs: the catalogue', () => {
  it('holds all nineteen labs of the course, in course order', () => {
    expect(CCNA2_LAB_ORDER).toHaveLength(19);
    expect(CCNA2_LABS.map((l) => l.name)).toEqual([...CCNA2_LAB_ORDER]);
  });

  it('names every lab of the eleven files in CCNA2_LAB_ORDER exactly once, and CCNA2_LABS follows that order', () => {
    expect(new Set(CCNA2_LAB_ORDER).size).toBe(CCNA2_LAB_ORDER.length);
    const names = ALL_FILE_LABS.map((l) => l.name);
    // no lab twice, in one file or across two
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(CCNA2_LAB_ORDER.filter((n) => n === name), name).toHaveLength(1);
    // CCNA2_LABS is exactly the labs of the files, sorted by the order (a name whose lab has not landed is absent)
    expect(CCNA2_LABS.length).toBe(ALL_FILE_LABS.length);
    for (const lab of ALL_FILE_LABS) expect(CCNA2_LABS, lab.name).toContain(lab);
    expect(CCNA2_LABS.map((l) => l.name)).toEqual(CCNA2_LAB_ORDER.filter((n) => names.includes(n)));
  });

  it('keeps each lab in the file of its lesson', () => {
    const planned = FILES.flatMap((f) => f.names);
    expect(new Set(planned).size).toBe(planned.length);
    for (const f of FILES) {
      for (const lab of f.labs) expect(f.names, `${lab.name} in ${f.file}.ts`).toContain(lab.name);
    }
    // every planned name is in the course order, and every ordered name has a file
    for (const name of planned) expect(CCNA2_LAB_ORDER, name).toContain(name);
    for (const name of CCNA2_LAB_ORDER) expect(planned, name).toContain(name);
  });

  it('orders the labs as the lesson skeleton meets them', () => {
    const lessonLabs = LESSONS.flatMap((l) => (l.lesson.lab === undefined ? [] : [l.lesson.lab]));
    // every ordered lab is the lab of exactly one lesson …
    for (const name of CCNA2_LAB_ORDER) expect(lessonLabs.filter((n) => n === name), name).toHaveLength(1);
    // … and the order is the lessons' order (the skeleton may name labs of a later wave, e.g. the wireless lab)
    expect(lessonLabs.filter((n) => CCNA2_LAB_ORDER.includes(n))).toEqual([...CCNA2_LAB_ORDER]);
  });

  it('lists the templates, then the CCNA 1 labs, then the CCNA 2 labs in SCENARIOS, every name once', () => {
    const t = TEMPLATES.length;
    const c1 = CCNA1_LABS.length;
    expect(SCENARIOS.length).toBe(t + c1 + CCNA2_LABS.length);
    expect(SCENARIOS.slice(0, t)).toEqual(TEMPLATES);
    expect(SCENARIOS.slice(t, t + c1)).toEqual(CCNA1_LABS);
    expect(SCENARIOS.slice(t + c1)).toEqual(CCNA2_LABS);
    expect(new Set(SCENARIOS.map((s) => s.name)).size).toBe(SCENARIOS.length);
  });

  it('writes a P2 topology with the schema that can express it, and leaves every P1 caller unchanged', () => {
    const devices = [device('pc1', PC, 'PC1', 100, 100), device('sw1', SWITCH, 'SW1', 200, 100)];
    const links = [link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1')];
    const p2 = topology(7, devices, links, ['An objective'], 'Notes', { profile: 'P2' });
    expect(p2.profile).toBe('P2');
    expect(p2.schema).toBe(TOPOLOGY_SCHEMA_ID_1_2);
    expect(p2.schema).toBe(schemaIdFor(p2));
    const p1 = topology(7, devices, links, ['An objective'], 'Notes');
    expect(p1).toEqual({ schema: TOPOLOGY_SCHEMA_ID_1_1, seed: 7, devices, links, objectives: ['An objective'], notes: 'Notes' });
    expect('profile' in p1).toBe(false);
    expect(topology(7, devices, links, [], '', { profile: 'P1' })).toEqual(topology(7, devices, links, [], ''));
    // a P2 lab topology loads as a P2 world and exports as one
    const sim = createSimulation({ seed: 7 });
    sim.loadTopology(p2);
    expect(sim.profile).toBe('P2');
    expect(sim.exportTopology()).toMatchObject({ profile: 'P2', schema: TOPOLOGY_SCHEMA_ID_1_2 });
  });

  it('writes the canonical switching lines and schedules the hidden faults a troubleshooting lab needs', () => {
    expect(vlanSections([{ id: 10, name: 'Sales' }, { id: 20 }])).toEqual([['vlan 10', ' name Sales'], ['vlan 20']]);
    expect(accessPort('FastEthernet0/1', 10, { portfast: true })).toEqual([
      'interface FastEthernet0/1',
      ' switchport mode access',
      ' switchport access vlan 10',
      ' spanning-tree portfast',
    ]);
    expect(accessPort('FastEthernet0/2', 1)).toEqual(['interface FastEthernet0/2', ' switchport mode access']);
    expect(trunkPort('GigabitEthernet0/1', { native: 99, allowed: '10,20,99', nonegotiate: true })).toEqual([
      'interface GigabitEthernet0/1',
      ' switchport mode trunk',
      ' switchport trunk native vlan 99',
      ' switchport trunk allowed vlan 10,20,99',
      ' switchport nonegotiate',
    ]);
    // a P2 world with the three faults scheduled the way the worker schedules a lab's `faults`
    const sw1 = configText([['hostname SW1'], ...vlanSections([{ id: 10, name: 'Sales' }]), accessPort('FastEthernet0/1', 10, { portfast: true })]);
    const t = topology(
      9,
      [device('sw1', SWITCH, 'SW1', 200, 100, sw1), device('pc1', PC, 'PC1', 100, 200), device('pc2', PC, 'PC2', 300, 200)],
      [link('l_pc1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1'), link('l_pc2', 'pc2', 'GigabitEthernet0', 'sw1', 'FastEthernet0/2')],
      [],
      '',
      { profile: 'P2' },
    );
    const faults = [
      errDisableFault(40 * SEC, 'sw1', 'FastEthernet0/1', 'psecure-violation'),
      cableCutFault(41 * SEC, 'l_pc2'),
      configFragmentFault(42 * SEC, 'sw1', ['interface FastEthernet0/3', ' switchport access vlan 10']),
    ];
    const sim = createSimulation({ seed: 9 });
    sim.loadTopology(t);
    for (const f of faults) sim.injectFault(f.at, f.fault);
    sim.runFor(60 * SEC);
    expect(sim.device('sw1')!.port('FastEthernet0/1')!.errDisabled).toBe('psecure-violation');
    expect(sim.link('l_pc1')!.up).toBe(false);
    expect(sim.link('l_pc2')!.downReason).toBe('cut');
    expect(sim.device('sw1')!.running.render()).toMatch(/interface FastEthernet0\/3\n switchport access vlan 10\n/);
  });

  it('keeps the lab files free of imports of the catalogue they belong to', () => {
    // ccna2/index.ts reads the lab arrays at module scope, which is safe only while no lab file imports the catalogue
    // back (a cycle is the rule-12 hazard, f4f883e)
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sim', 'scenarios', 'ccna2');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'index.ts');
    for (const f of FILES) expect(files, `${f.file}.ts`).toContain(`${f.file}.ts`);
    for (const file of files) {
      const text = readFileSync(join(dir, file), 'utf8');
      for (const m of text.matchAll(/from\s+'([^']+)'/g)) {
        expect(m[1], `${file} imports ${m[1]}`).not.toMatch(/^\.\/index\.js$|^\.\.\/index\.js$|^\.\.\/\.\.\/scenarios\.js$|^\.\.\/\.\.\/\.\.\/index\.js$/);
      }
    }
  });
});

for (const lab of CCNA2_LABS) {
  describe(`CCNA2 lab: ${lab.name}`, () => {
    it('describes itself with structured-clone safe metadata, its module as topic and a catalog it really uses', () => {
      expect(lab.category).toBe('ccna2-lab');
      expect(lab.course).toBe('CCNA 2');
      expect(lab.name).toMatch(/^ccna2(-[a-z0-9]+)+$/);
      const home = LESSONS.find((l) => l.lesson.lab === lab.name);
      expect(home, `${lab.name} is the lab of a lesson`).toBeDefined();
      expect(lab.topic).toBe(home?.module);
      expect(lab.labType).toBeDefined();
      expect(lab.seed, lab.name).toBeTypeOf('number');
      expect(lab.instructions ?? '', lab.name).not.toBe('');
      expect((lab.objectives ?? []).length, lab.name).toBeGreaterThan(0);
      expect((lab.tasks ?? []).length, lab.name).toBeGreaterThan(0);
      expect(Object.keys(lab.solution ?? {}).length, lab.name).toBeGreaterThan(0);

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
      const deviceNames = topo.devices.map((d) => d.name);
      for (const name of Object.keys(lab.solution ?? {})) expect(deviceNames).toContain(name);
      // a scheduled fault aims at a device and a cable of this topology
      const deviceIds = topo.devices.map((d) => d.id);
      const linkIds = topo.links.map((l) => l.id);
      for (const { fault } of lab.faults ?? []) {
        if (fault.target.device !== undefined) expect(deviceIds, fault.id).toContain(fault.target.device);
        if (fault.target.link !== undefined) expect(linkIds, fault.id).toContain(fault.target.link);
      }
    });

    it('builds a P2-profile world whose schema can express it', () => {
      const topo = lab.build();
      expect(topo.profile).toBe('P2');
      expect(topo.schema).toBe(schemaIdFor(topo));
      expect(topo.seed).toBeTypeOf('number');
      const sim = createSimulation({ seed: lab.seed ?? 1 });
      sim.loadTopology(topo);
      expect(sim.profile).toBe('P2');
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

/** The lab world at `at`, as the worker holds it before a check at that instant (loaded, faults injected, not settled). */
function labWorldAt(lab: ScenarioInfo, at: number): Simulation {
  const sim = createSimulation({ seed: lab.seed ?? 1 });
  sim.loadTopology({ ...lab.build(), lab: { name: lab.name, version: lab.version ?? 1 } });
  for (const f of lab.faults ?? []) sim.injectFault(f.at, f.fault);
  if (at > 0) sim.runFor(at);
  return sim;
}

/** Type `lines` on the device called `name`; every line must be accepted. */
function typeOn(sim: Simulation, name: string, lines: readonly string[]): void {
  const r = sim.configure(idOf(sim, name), lines);
  expect(r.lines.filter((l) => !l.ok).map((l) => `${l.line}: ${l.error?.message ?? l.output}`), `${name}: ${lines.join(' / ')}`).toEqual([]);
}

/** Pass flag of each task, by id. */
function taskPasses(sim: Simulation, lab: ScenarioInfo): Record<string, boolean> {
  return Object.fromEntries(evaluateLab(sim, lab).results.map((r) => [r.task, r.pass]));
}

describe('CCNA2 labs: hidden faults (W5 review)', () => {
  it('grades no task of a troubleshooting lab before its last hidden fault has landed', () => {
    for (const lab of [ccna2TroubleshootVlans, ccna2TroubleshootRouting]) {
      const last = Math.max(...(lab.faults ?? []).map((f) => f.at));
      expect(last, lab.name).toBeGreaterThan(47 * SEC);
      for (const at of [0, 35 * SEC, 47 * SEC]) {
        const status = evaluateLab(labWorldAt(lab, at), lab);
        expect(status.score, `${lab.name} at ${at / SEC} s`).toBe(0);
        for (const r of status.results) {
          expect(r.pass).toBe(false);
          expect(r.assertions.filter((a) => a.detail !== undefined).map((a) => a.detail), `${lab.name}/${r.task}`).toEqual([LAB_PREPARING_DETAIL]);
        }
      }
      // once the faults are in, the grader reads the world again, and the unsolved lab still earns nothing
      const sim = labWorldAt(lab, 60 * SEC);
      sim.runToIdle();
      const status = evaluateLab(sim, lab);
      expect(status.score, lab.name).toBe(0);
      for (const r of status.results) expect(r.assertions.some((a) => a.detail === LAB_PREPARING_DETAIL), `${lab.name}/${r.task}`).toBe(false);
    }
  }, LAB_TEST_TIMEOUT_MS);

  it('shows the guard lab with its port error-disabled from the start, never healthy', () => {
    for (const at of [1 * SEC, 35 * SEC]) {
      const sim = labWorldAt(ccna2StpGuards, at);
      expect(sim.device('acc1')!.port('FastEthernet0/3')!.errDisabled, `at ${at / SEC} s`).toBe('bpduguard');
      expect(taskPasses(sim, ccna2StpGuards)['recover-port'], `at ${at / SEC} s`).toBe(false);
    }
    const sim = labWorldAt(ccna2StpGuards, 35 * SEC);
    sim.runToIdle();
    expect(sim.device('acc1')!.port('FastEthernet0/3')!.errDisabled).toBe('bpduguard');
  }, LAB_TEST_TIMEOUT_MS);

  it('keeps the hidden configuration changes through a power cycle of the devices that hold them', () => {
    const cases = [
      { lab: ccna2TroubleshootVlans, devices: ['SW1', 'SW2', 'R1'], tasks: ['wrong-vlan', 'trunk-vlan', 'subinterface', 'every-vlan'] },
      { lab: ccna2TroubleshootRouting, devices: ['SW2', 'R1', 'R2'], tasks: ['link-subnet', 'branch-route', 'end-to-end'] },
    ];
    for (const c of cases) {
      const sim = labWorld(c.lab);
      for (const name of c.devices) sim.setPower(idOf(sim, name), false);
      sim.runFor(1 * SEC);
      for (const name of c.devices) sim.setPower(idOf(sim, name), true);
      sim.runFor(120 * SEC);
      sim.runToIdle();
      const passes = taskPasses(sim, c.lab);
      for (const task of c.tasks) expect(passes[task], `${c.lab.name}/${task} after a power cycle`).toBe(false);
    }
    // the saved configuration carries the change: R2 boots with the wrong address
    const sim = labWorld(ccna2TroubleshootRouting);
    expect(sim.device(idOf(sim, 'R2'))!.startup?.render()).toContain('ip address 10.0.12.6 255.255.255.252');
  }, 2 * LAB_TEST_TIMEOUT_MS);
});

describe('CCNA2 labs: wrong answers the W5 review found', () => {
  it('stp-root-placement: swapping primary and secondary earns nothing, backup roots included', () => {
    const sim = labWorld(ccna2StpRootPlacement);
    typeOn(sim, 'DS1', ['spanning-tree vlan 10 root secondary', 'spanning-tree vlan 20 root primary']);
    typeOn(sim, 'DS2', ['spanning-tree vlan 20 root secondary', 'spanning-tree vlan 10 root primary']);
    sim.runToIdle();
    const status = evaluateLab(sim, ccna2StpRootPlacement);
    expect(status.results.find((r) => r.task === 'backup-roots')?.pass).toBe(false);
    expect(status.score).toBe(0);
  }, LAB_TEST_TIMEOUT_MS);

  it('floating-static: floating routes with no main route earn nothing', () => {
    const sim = labWorld(ccna2FloatingStatic);
    typeOn(sim, 'R1', ['ip route 0.0.0.0 0.0.0.0 10.0.0.6 5']);
    typeOn(sim, 'R2', ['ip route 192.168.10.0 255.255.255.0 10.0.0.5 5']);
    sim.runToIdle();
    const passes = taskPasses(sim, ccna2FloatingStatic);
    expect(passes['main-path']).toBe(false);
    expect(passes['floating-backup']).toBe(false);
    expect(evaluateLab(sim, ccna2FloatingStatic).score).toBe(0);
  }, LAB_TEST_TIMEOUT_MS);

  it('etherchannel-lacp: a static bundle on SW1 against the lone LACP members of SW2 is not one logical link', () => {
    const sim = labWorld(ccna2EtherchannelLacp);
    typeOn(sim, 'SW2', ['interface GigabitEthernet0/2', 'switchport mode trunk', 'exit', 'port-channel load-balance src-dst-mac']);
    typeOn(sim, 'SW1', ['interface range GigabitEthernet0/1 - 2', 'switchport mode trunk', 'channel-group 1 mode on', 'exit', 'port-channel load-balance src-dst-mac']);
    sim.runFor(60 * SEC);
    // the static tasks only: this misconfiguration never lets spanning tree settle (SW1's topology-change notice is
    // acknowledged on SW2's other, inferior port), so every grading copy would run to its event cap
    const lab: ScenarioInfo = { ...ccna2EtherchannelLacp, tasks: (ccna2EtherchannelLacp.tasks ?? []).filter((t) => t.id !== 'lose-a-cable') };
    expect(taskPasses(sim, lab)).toEqual({ 'lacp-active': false, 'fix-member': false, 'one-logical-link': false, 'load-balance': true });
    const logical = evaluateLab(sim, lab).results.find((r) => r.task === 'one-logical-link');
    expect(logical?.assertions.filter((a) => !a.pass).map((a) => a.detail)).toEqual(['Channel group 1 of SW2 has Port-channel1 down, expected up.']);
  }, LAB_TEST_TIMEOUT_MS);

  it('hsrp-gateway: pointing the hosts at the virtual address without joining R1 earns only the gateway task', () => {
    const sim = labWorld(ccna2HsrpGateway);
    for (const name of ['PC1', 'PC2']) typeOn(sim, name, ccna2HsrpGateway.solution?.[name] ?? []);
    sim.runToIdle();
    const status = evaluateLab(sim, ccna2HsrpGateway);
    const survive = status.results.find((r) => r.task === 'survive-failure');
    expect(survive?.pass).toBe(false);
    expect(survive?.assertions.find((a) => !a.pass)?.detail).toContain('R1 GigabitEthernet0/0 has no standby group 10');
    expect(status.score).toBe(15);
  }, LAB_TEST_TIMEOUT_MS);

  it('port-security: sticky typed after the recovery still pins PC4', () => {
    const sim = labWorld(ccna2PortSecurity);
    typeOn(sim, 'SW1', ['interface FastEthernet0/3', `no switchport port-security mac-address ${STALE_SECURE_MAC}`, 'shutdown', 'no shutdown', 'exit']);
    sim.runFor(10 * SEC);
    typeOn(sim, 'SW1', ['interface FastEthernet0/3', 'switchport port-security mac-address sticky', 'exit']);
    sim.runToIdle();
    const pc4 = new Set([...sim.device(idOf(sim, 'PC4'))!.ports.values()].map((p) => p.mac));
    const rows = sim.device(idOf(sim, 'SW1'))!.tables.cam.rows().filter((r) => pc4.has(r.mac));
    expect(rows.map((r) => r.secure)).toEqual(['sticky']);
    expect(taskPasses(sim, ccna2PortSecurity)['recover-pc4']).toBe(true);
  }, LAB_TEST_TIMEOUT_MS);

  it('port-security: keeping the old address beside a larger maximum is not a recovery', () => {
    const sim = labWorld(ccna2PortSecurity);
    typeOn(sim, 'SW1', ['interface FastEthernet0/3', 'switchport port-security maximum 2', 'switchport port-security mac-address sticky', 'shutdown', 'no shutdown', 'exit']);
    sim.runFor(10 * SEC);
    sim.runToIdle();
    const recover = evaluateLab(sim, ccna2PortSecurity).results.find((r) => r.task === 'recover-pc4');
    expect(recover?.pass).toBe(false);
    expect(recover?.assertions.find((a) => !a.pass)?.detail).toContain('allows 2 addresses, expected 1');
  }, LAB_TEST_TIMEOUT_MS);

  it('port-security: one unused port left open fails the hardening task', () => {
    const sim = labWorld(ccna2PortSecurity);
    typeOn(sim, 'SW1', ['interface range FastEthernet0/4 - 9 , FastEthernet0/11 - 24', 'shutdown', 'exit', 'interface GigabitEthernet0/2', 'shutdown', 'exit']);
    sim.runToIdle();
    const unused = evaluateLab(sim, ccna2PortSecurity).results.find((r) => r.task === 'unused-ports');
    expect(unused?.pass).toBe(false);
    expect(unused?.assertions.filter((a) => !a.pass).map((a) => a.detail)).toEqual(['SW1 FastEthernet0/10 adminUp is true, expected false.']);
    typeOn(sim, 'SW1', ['interface FastEthernet0/10', 'shutdown', 'exit']);
    expect(taskPasses(sim, ccna2PortSecurity)['unused-ports']).toBe(true);
  }, LAB_TEST_TIMEOUT_MS);
});
