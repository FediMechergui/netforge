/**
 * P3 W5 sim: the CCNA 3 lab catalogue, every lab's reference solution and its tasks (ARCHITECTURE-P3 §7 W5, §11.1,
 * §11.2; the twin of labs.ccna2.solutions.test.ts).
 *
 * GENERIC over `CCNA3_LABS` (read at run time, so a lab that lands later is covered without an edit here). For each
 * lab the test checks:
 *   • its metadata: category `ccna3-lab`, course `CCNA 3`, `topic` = the title of the module that holds its lesson in
 *     curriculum/ccna3/lessons.ts, a fixed seed, structured-clone safe `scenarioMeta`, `requires` = exactly the catalog
 *     types the topology uses (all in the real catalog), tasks with unique ids, real points and existing dependencies,
 *     a solution for devices the topology has, scheduled faults aimed at devices and cables it has;
 *   • its world: a P3-profile topology whose schema is `schemaIdFor(t)` (1.3), loaded as a P3 world;
 *   • UNSOLVED (built, scheduled faults injected the way the worker does, booted and settled): EVERY task fails, and
 *     says why on a failing assertion;
 *   • SOLVED: `configure` accepts every line of the reference solution as written (a refused line is a defect in the
 *     lab and is reported in full), the world runs to idle, the logins the lab asks the learner to make before Check
 *     (labs 15 and 19 grade the learner's own remote logins live, §11.2, and lab 27 the learner's voice burst, §3.5
 *     step 8; their lab files give them as data, typed here on the hosts' consoles) are typed, and every task passes —
 *     full marks;
 *   • grading is read-only (same clock, trace head and PDU count) and repeatable (two evaluations are equal).
 *
 * Static cases: the lab names come from `CCNA3_LAB_ORDER` — every lab of the ten W5 files is named there exactly once
 * (a lab the order does not know is refused), sits in the file its area owns (§11.2, rule 18), and `CCNA3_LABS`
 * follows that order; the order itself follows the lesson skeleton; `SCENARIOS` is the templates, then the CCNA 1,
 * CCNA 2 and CCNA 3 labs; the kit writes P3 topologies with the 1.3 schema; no lab file imports the catalogue it is
 * part of.
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
import { TOPOLOGY_SCHEMA_ID_1_3, schemaIdFor, type Topology } from '../src/contracts/topology.js';
import { CCNA3_MODULES } from '../src/curriculum/ccna3/lessons.js';
import { createCatalog } from '../src/device/catalog/index.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { createSimulation } from '../src/sim/simulation.js';
import {
  ACL_STANDARD_LOGINS,
  CCNA3_ACL_LABS,
  CCNA3_DISCOVERY_LABS,
  CCNA3_EIGRP_LABS,
  CCNA3_HARDENING_LABS,
  CCNA3_LABS,
  CCNA3_LAB_ORDER,
  CCNA3_OSPF_LABS,
  CCNA3_QOS_LABS,
  CCNA3_TIME_LABS,
  CCNA3_TROUBLESHOOTING_LABS,
  CCNA3_VPN_LABS,
  CCNA3_WAN_LABS,
  QOS_LEARNER_FLOWS,
  SECURE_ACCESS_LOGINS,
} from '../src/sim/scenarios/ccna3/index.js';
import { PC, SWITCH, device, link, topology } from '../src/sim/scenarios/kit.js';
import { CCNA1_LABS, CCNA2_LABS, SCENARIOS, TEMPLATES } from '../src/sim/scenarios.js';

/** Long enough for every model of a lab to boot (the router takes 45 s); `runToIdle` then waits out the elections. */
const BOOT_NS = 90 * SEC;

/** Wall-clock budget of one per-lab world test: a lab world plus one grading clone per fault set it names. */
const LAB_TEST_TIMEOUT_MS = 300_000;

/** Clone time after each line a learner types for a remote login (the connection, the login, the logout). */
const LOGIN_LINE_NS = 5 * SEC;

const catalog = createCatalog(PROCESS_FACTORIES);

/** The ten W5 lab files (§11.2: each owned by the area that knows the feature), with the labs their lessons give them. */
const FILES: readonly { file: string; labs: readonly ScenarioInfo[]; names: readonly string[] }[] = [
  {
    file: 'ospf',
    labs: CCNA3_OSPF_LABS,
    names: ['ccna3-ospf-dr-election', 'ccna3-ospf-single-area', 'ccna3-ospf-cost', 'ccna3-ospf-default-route', 'ccna3-troubleshoot-ospf'],
  },
  { file: 'eigrp', labs: CCNA3_EIGRP_LABS, names: ['ccna3-eigrp-feasible-successor', 'ccna3-troubleshoot-eigrp'] },
  { file: 'acl', labs: CCNA3_ACL_LABS, names: ['ccna3-acl-standard', 'ccna3-acl-extended', 'ccna3-acl-edit-verify'] },
  { file: 'hardening', labs: CCNA3_HARDENING_LABS, names: ['ccna3-secure-device-access', 'ccna3-dhcp-snooping-dai'] },
  { file: 'wan', labs: CCNA3_WAN_LABS, names: ['ccna3-serial-links'] },
  { file: 'vpn', labs: CCNA3_VPN_LABS, names: ['ccna3-gre-tunnel', 'ccna3-ipsec-site-to-site'] },
  { file: 'qos', labs: CCNA3_QOS_LABS, names: ['ccna3-qos-voice-first'] },
  { file: 'discovery', labs: CCNA3_DISCOVERY_LABS, names: ['ccna3-discover-neighbours'] },
  { file: 'time', labs: CCNA3_TIME_LABS, names: ['ccna3-time-and-logs'] },
  { file: 'troubleshooting', labs: CCNA3_TROUBLESHOOTING_LABS, names: ['ccna3-troubleshoot-enterprise'] },
];

/** The two automation labs W6 brings (`automation.ts`), already in the course order. */
const W6_LABS: readonly string[] = ['ccna3-restconf-change', 'ccna3-script-inventory'];

/**
 * The actions a lab asks the learner to take before Check, as the lab files give them: the console lines typed on each
 * host after the solution — the remote logins of labs 15 and 19 (§11.2 "graded live through the remote terminal") and
 * lab 27's bounded voice burst (§3.5 step 8: the live EF row at PC-S; W5 fix #16).
 */
const LEARNER_LOGINS: Readonly<Record<string, readonly { readonly from: string; readonly lines: readonly string[] }[]>> = {
  'ccna3-acl-standard': ACL_STANDARD_LOGINS,
  'ccna3-secure-device-access': SECURE_ACCESS_LOGINS,
  'ccna3-qos-voice-first': QOS_LEARNER_FLOWS,
};

/** Every lab of the ten files, in file order. */
const ALL_FILE_LABS: readonly ScenarioInfo[] = FILES.flatMap((f) => f.labs);

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

/** Device id of a topology name (labs address devices by name, `configure` takes an id). */
function idOf(sim: Simulation, name: string): DeviceId {
  for (const d of sim.devices()) if (d.spec.name === name) return d.id;
  throw new Error(`no device called ${name} in this lab`);
}

/** Apply the reference solution, then type the logins the lab asks for; a refused line is a defect in the lab. */
function applySolution(sim: Simulation, lab: ScenarioInfo): void {
  for (const [name, lines] of Object.entries(lab.solution ?? {})) {
    const r = sim.configure(idOf(sim, name), lines);
    const refused = r.lines.filter((l) => !l.ok).map((l) => `${l.line}: ${l.error?.message ?? l.output}`);
    expect(refused, `${lab.name} solution for ${name}`).toEqual([]);
    expect(r.ok, `${lab.name} solution for ${name}`).toBe(true);
  }
  sim.runToIdle();
  for (const login of LEARNER_LOGINS[lab.name] ?? []) {
    const s = sim.cli.open(idOf(sim, login.from), 'console');
    for (const line of login.lines) {
      sim.cli.exec(s, line);
      sim.runFor(LOGIN_LINE_NS);
    }
    sim.cli.close(s);
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

describe('CCNA3 labs: the catalogue', () => {
  it('names the 21 labs of the approved plan in course order, each once', () => {
    expect(CCNA3_LAB_ORDER).toHaveLength(21);
    expect(new Set(CCNA3_LAB_ORDER).size).toBe(CCNA3_LAB_ORDER.length);
    for (const name of CCNA3_LAB_ORDER) expect(name).toMatch(/^ccna3(-[a-z0-9]+)+$/);
  });

  it('takes the lab names from CCNA3_LAB_ORDER: every lab of the ten files is named there once, and CCNA3_LABS follows it', () => {
    const names = ALL_FILE_LABS.map((l) => l.name);
    // no lab twice, in one file or across two
    expect(new Set(names).size).toBe(names.length);
    // a lab the order does not know is refused
    for (const name of names) expect(CCNA3_LAB_ORDER.filter((n) => n === name), `${name} is in CCNA3_LAB_ORDER`).toHaveLength(1);
    // CCNA3_LABS is exactly the labs of the files, sorted by the order (a name whose lab has not landed is absent)
    expect(CCNA3_LABS.length).toBe(ALL_FILE_LABS.length);
    for (const lab of ALL_FILE_LABS) expect(CCNA3_LABS, lab.name).toContain(lab);
    expect(CCNA3_LABS.map((l) => l.name)).toEqual(CCNA3_LAB_ORDER.filter((n) => names.includes(n)));
  });

  it('keeps each lab in the file of the area that owns it (§11.2)', () => {
    const planned = FILES.flatMap((f) => f.names);
    expect(new Set(planned).size).toBe(planned.length);
    for (const f of FILES) {
      for (const lab of f.labs) expect(f.names, `${lab.name} in ${f.file}.ts`).toContain(lab.name);
    }
    // every planned name is in the course order, and every ordered name has a file (W6's automation.ts included)
    for (const name of planned) expect(CCNA3_LAB_ORDER, name).toContain(name);
    for (const name of CCNA3_LAB_ORDER) expect([...planned, ...W6_LABS], name).toContain(name);
  });

  it('orders the labs as the lesson skeleton meets them', () => {
    const lessonLabs = LESSONS.flatMap((l) => (l.lesson.lab === undefined ? [] : [l.lesson.lab]));
    for (const name of CCNA3_LAB_ORDER) expect(lessonLabs.filter((n) => n === name), name).toHaveLength(1);
    expect(lessonLabs.filter((n) => CCNA3_LAB_ORDER.includes(n))).toEqual([...CCNA3_LAB_ORDER]);
  });

  it('lists the templates, then the CCNA 1, CCNA 2 and CCNA 3 labs in SCENARIOS, every name once', () => {
    const t = TEMPLATES.length;
    const c1 = CCNA1_LABS.length;
    const c2 = CCNA2_LABS.length;
    expect(SCENARIOS.length).toBe(t + c1 + c2 + CCNA3_LABS.length);
    expect(SCENARIOS.slice(0, t)).toEqual(TEMPLATES);
    expect(SCENARIOS.slice(t, t + c1)).toEqual(CCNA1_LABS);
    expect(SCENARIOS.slice(t + c1, t + c1 + c2)).toEqual(CCNA2_LABS);
    expect(SCENARIOS.slice(t + c1 + c2)).toEqual(CCNA3_LABS);
    expect(new Set(SCENARIOS.map((s) => s.name)).size).toBe(SCENARIOS.length);
  });

  it('writes a P3 topology with the schema that can express it (1.3), loaded as a P3 world', () => {
    const devices = [device('pc1', PC, 'PC1', 100, 100), device('sw1', SWITCH, 'SW1', 200, 100)];
    const links = [link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1')];
    const p3 = topology(7, devices, links, ['An objective'], 'Notes', { profile: 'P3' });
    expect(p3.profile).toBe('P3');
    expect(p3.schema).toBe(TOPOLOGY_SCHEMA_ID_1_3);
    expect(p3.schema).toBe(schemaIdFor(p3));
    const sim = createSimulation({ seed: 7 });
    sim.loadTopology(p3);
    expect(sim.profile).toBe('P3');
    expect(sim.exportTopology()).toMatchObject({ profile: 'P3', schema: TOPOLOGY_SCHEMA_ID_1_3 });
  });

  it('keeps the lab files free of imports of the catalogue they belong to', () => {
    // ccna3/index.ts reads the lab arrays at module scope, which is safe only while no lab file imports the catalogue
    // back (a cycle is the rule-12 hazard)
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sim', 'scenarios', 'ccna3');
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

for (const lab of CCNA3_LABS) {
  describe(`CCNA3 lab: ${lab.name}`, () => {
    it('describes itself with structured-clone safe metadata, its module as topic and a catalog it really uses', () => {
      expect(lab.category).toBe('ccna3-lab');
      expect(lab.course).toBe('CCNA 3');
      expect(lab.name).toMatch(/^ccna3(-[a-z0-9]+)+$/);
      expect(CCNA3_LAB_ORDER, `${lab.name} is in CCNA3_LAB_ORDER`).toContain(lab.name);
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
      for (const login of LEARNER_LOGINS[lab.name] ?? []) expect(deviceNames).toContain(login.from);
      // a scheduled fault aims at a device and a cable of this topology
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
      expect(topo.seed).toBeTypeOf('number');
      const sim = createSimulation({ seed: lab.seed ?? 1 });
      sim.loadTopology(topo);
      expect(sim.profile).toBe('P3');
    });

    it('fails every task before the student starts, and says why', () => {
      const sim = labWorld(lab);
      const status = evaluateLab(sim, lab);
      expect(status.lab).toBe(lab.name);
      expect(status.total).toBe((lab.tasks ?? []).reduce((n, t) => n + t.points, 0));
      expect(status.results.filter((r) => r.pass).map((r) => r.task), `${lab.name} unsolved`).toEqual([]);
      expect(status.score).toBe(0);
      for (const r of status.results) expect(r.assertions.some((a) => !a.pass && (a.detail ?? '') !== ''), `${lab.name}/${r.task}`).toBe(true);
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
