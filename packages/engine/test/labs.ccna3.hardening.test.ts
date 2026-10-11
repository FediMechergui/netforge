/**
 * labs.ccna3.hardening — the W5 l2 labs, proved (ARCHITECTURE-P3 §7 W5 "lab files, one owner each", §11.1 lessons 19
 * and 20, §11.2, §3.4, §3.14, D13, D14, [S13]; rulings R45 and R47). The local copy of the checks of the sim builder's
 * `labs.ccna3.solutions.test.ts`, filtered to this file's two labs, plus what only these labs need.
 *
 * For `ccna3-secure-device-access` (lab 19) and `ccna3-dhcp-snooping-dai` (lab 20):
 *   • metadata (§11.2): category `ccna3-lab`, course `CCNA 3`, topic = the title of the module holding the lesson that
 *     names the lab, a fixed seed, `requires` = exactly the catalog types used (all in the real catalog), structured-
 *     clone safe metadata, unique task ids, real points, a solution for devices the topology has, only the §11.2
 *     assertion kinds, the §11.2 timing sentences in the instructions; the file imports only the contracts, `../kit.js`
 *     and `../templates.js` (rule 12) and exports the one array under its fixed name;
 *   • the world: a P3-profile topology with the schema that expresses it (1.3), loaded as a P3 world; PortFast on every
 *     switch access port that faces a host or a router, and (R45) `spanning-tree portfast trunk` on lab 20's trunk;
 *   • UNSOLVED (booted and settled): EVERY task fails, each with a detail, and each on an assertion other than a
 *     remote-login check (so the failure never rests on the clone alone);
 *   • SOLVED: `configure` accepts every solution line as written; lab 19 then gets the learner's own logins typed on
 *     the PCs' consoles (`SECURE_ACCESS_LOGINS`, the logins the lab asks for before Check: a login is a job, which a
 *     headless configure refuses); every task passes;
 *   • grading is read-only (same clock, trace head and PDU count) and repeatable.
 * Lab-specific cases: the learner's paths typed on consoles (lab 19: the exact `vty-logins` rows, the refusal counted
 * on list 10's implicit deny, telnet refused; lab 20: the rogue leases of the unsolved world, `ipconfig /release` and
 * `/renew` writing PC1's binding), the lab constants against the live world (SRV1's MAC), and the wrong answers each
 * task must refuse (telnet left on, the whole subnet permitted, logins tried before the access class, a line password
 * kept, 'deny PC2, permit any'; every port trusted, the static server's port trusted, no static binding, no renewal, SRV1's
 * own dropped ARPs without the attack), and one right answer typed differently (`line vty 0 15` for `line vty 0 4`).
 *
 * The [S13] `service` checker is the W5 sim item's (sim/lab-checks/service.ts). Until it lands, the registry's W0 stub
 * answers every `service` assertion with SERVICE_STUB_DETAIL; the full-marks case then accepts exactly those failures
 * and nothing else, and demands full marks as soon as the checker is in (`serviceCheckerLanded`).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DeviceId, SessionId } from '../src/contracts/ids.js';
import type { LabAssertion, LabStatus, ScenarioInfo } from '../src/contracts/scenario.js';
import { scenarioMeta } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { AclRow, ArpInspectionRow, DhcpSnoopingRow, VtyLoginRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID, TOPOLOGY_SCHEMA_ID_1_3, schemaIdFor, type Topology } from '../src/contracts/topology.js';
import { CCNA3_MODULES } from '../src/curriculum/ccna3/lessons.js';
import { createCatalog } from '../src/device/catalog/index.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { createSimulation } from '../src/sim/simulation.js';
import {
  CCNA3_HARDENING_LABS,
  SECURE_ACCESS_ADDRESSES,
  SECURE_ACCESS_LOGINS,
  SECURE_ACCESS_OLD_LINE_PASSWORD,
  SECURE_ACCESS_SECRET,
  SECURE_ACCESS_USER,
  SNOOPING_ADDRESSES,
  SNOOPING_RATE_LIMIT,
  SNOOPING_SRV1_MAC,
  ccna3DhcpSnoopingDai,
  ccna3SecureDeviceAccess,
} from '../src/sim/scenarios/ccna3/hardening.js';

/** Long enough for every model to boot (a router takes 45 s); `runToIdle` then settles DHCP and spanning tree. */
const BOOT_NS = 90 * SEC;
/** Wall-clock budget of one per-lab world test (a world, a solution and one or two grading clones). */
const LAB_TEST_TIMEOUT_MS = 120_000;
/** Clone time a console line is given before the next one (a login asks for the password, then connects). */
const LINE_GAP_NS = 3 * SEC;

/** The W0 stub detail of the `service` kind (sim/lab-checks/registry.ts), until the W5 sim checker replaces it. */
const SERVICE_STUB_DETAIL = 'Remote login checks are not available in this build.';

/** The assertion kinds a CCNA 3 lab may use (§11.2), plus the P1 `port` kind lab 19's unused-ports task reads. */
const LAB_KINDS: readonly LabAssertion['kind'][] = [
  'neighbor', 'fact', 'acl', 'aclDecision', 'route', 'table', 'connectivity', 'config', 'vlan', 'service', 'path', 'traffic', 'port',
];

const catalog = createCatalog(PROCESS_FACTORIES);

/** The lessons of the CCNA 3 skeleton with the title of the module that holds each. */
const LESSONS = CCNA3_MODULES.flatMap((m) => m.lessons.map((l) => ({ lesson: l, module: m.title })));

/** The lab's world as `loadScenario` builds it: the lab seed, the lab topology, booted and settled. */
function labWorld(lab: ScenarioInfo): Simulation {
  const sim = createSimulation({ seed: lab.seed ?? 1 });
  sim.loadTopology({ ...lab.build(), lab: { name: lab.name, version: lab.version ?? 1 } });
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

/** Type `lines` on the device called `name` through `configure`; every line must be accepted. */
function typeOn(sim: Simulation, name: string, lines: readonly string[]): void {
  const r = sim.configure(idOf(sim, name), lines);
  expect(r.lines.filter((l) => !l.ok).map((l) => `${l.line}: ${l.error?.message ?? l.output}`), `${name}: ${lines.join(' / ')}`).toEqual([]);
  expect(r.ok, `${name}: ${lines.join(' / ')}`).toBe(true);
}

/** Apply the reference solution as written (a refused line is a defect in the lab, reported in full). */
function applySolution(sim: Simulation, lab: ScenarioInfo): void {
  for (const [name, lines] of Object.entries(lab.solution ?? {})) typeOn(sim, name, lines);
  sim.runToIdle();
}

/** What a console of `name` printed for each typed line, `LINE_GAP_NS` after each. */
function typedOnConsole(sim: Simulation, name: string, lines: readonly string[]): string[] {
  const s: SessionId = sim.cli.open(idOf(sim, name), 'console');
  const out: string[] = [];
  for (const line of lines) {
    const from = sim.trace(0).next;
    const r = sim.cli.exec(s, line);
    sim.runFor(LINE_GAP_NS);
    const printed = sim.trace(from).events.flatMap((e) => (e.kind === 'cliOutput' && e.session === s ? [e.text] : []));
    out.push([r.output, ...printed].filter((t) => t !== '').join('\n'));
  }
  sim.cli.close(s);
  return out;
}

/** The learner's own logins of lab 19 (`SECURE_ACCESS_LOGINS`), typed on the PCs' consoles; what each printed. */
function typeLogins(sim: Simulation): string[][] {
  const printed = SECURE_ACCESS_LOGINS.map((l) => typedOnConsole(sim, l.from, l.lines));
  sim.runToIdle();
  return printed;
}

/** The learner's whole answer: the reference solution, then (lab 19) the logins the lab asks for before Check. */
function solve(sim: Simulation, lab: ScenarioInfo): void {
  applySolution(sim, lab);
  if (lab === ccna3SecureDeviceAccess) typeLogins(sim);
}

/** Every failing assertion of a status, with its task, kind and detail. */
function failingAssertions(status: LabStatus, lab: ScenarioInfo): { task: string; kind: string; detail: string }[] {
  return status.results.flatMap((r) => {
    const task = (lab.tasks ?? []).find((t) => t.id === r.task);
    return r.assertions.filter((a) => !a.pass).map((a) => ({ task: r.task, kind: task?.assertions[a.index]?.kind ?? '?', detail: a.detail ?? '' }));
  });
}

/** Pass flag of each task, by id. */
function taskPasses(sim: Simulation, lab: ScenarioInfo): Record<string, boolean> {
  return Object.fromEntries(evaluateLab(sim, lab).results.map((r) => [r.task, r.pass]));
}

/** The failing details of one task. */
function taskFailures(sim: Simulation, lab: ScenarioInfo, task: string): string[] {
  return (evaluateLab(sim, lab).results.find((r) => r.task === task)?.assertions ?? []).filter((a) => !a.pass).map((a) => a.detail ?? '');
}

/** Whether the [S13] `service` checker has replaced the W0 stub (file header). */
function serviceCheckerLanded(): boolean {
  const probe: ScenarioInfo = {
    name: 'service-probe',
    title: 'Service probe',
    description: 'A lab built by the test',
    category: 'ccna3-lab',
    build: () => ({ schema: TOPOLOGY_SCHEMA_ID, seed: 1, devices: [], links: [] }),
    tasks: [{ id: 'only', title: 'Only', description: 'One task', points: 1, assertions: [{ kind: 'service', from: 'NOBODY', to: 'NOWHERE', service: 'ssh', expect: 'success' }] }],
  };
  const detail = evaluateLab(createSimulation({ seed: 1 }), probe).results[0]?.assertions[0]?.detail;
  return detail !== SERVICE_STUB_DETAIL;
}

/** The catalog types a topology actually uses. */
function typesOf(topo: Topology): string[] {
  return [...new Set(topo.devices.map((d) => d.type))].sort();
}

/** One section of a saved configuration text: its child lines (trimmed), or undefined when the header is absent. */
function sectionOf(config: string, header: string): string[] | undefined {
  const lines = config.split('\n');
  const at = lines.indexOf(header);
  if (at < 0) return undefined;
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith(' ')) break;
    out.push(l.trim());
  }
  return out;
}

describe('CCNA3 hardening labs: the file', () => {
  it('exports the two labs of lessons 19 and 20 in course order, each the lab of its lesson, under the module title', () => {
    expect(CCNA3_HARDENING_LABS.map((l) => l.name)).toEqual(['ccna3-secure-device-access', 'ccna3-dhcp-snooping-dai']);
    expect(CCNA3_HARDENING_LABS).toEqual([ccna3SecureDeviceAccess, ccna3DhcpSnoopingDai]);
    expect(Object.isFrozen(CCNA3_HARDENING_LABS)).toBe(true);
    const homes = CCNA3_HARDENING_LABS.map((lab) => LESSONS.find((l) => l.lesson.lab === lab.name));
    expect(homes.map((h) => h?.lesson.id)).toEqual(['ccna3-19-locking-down-device-access', 'ccna3-20-guarding-the-access-layer']);
    expect(homes.map((h) => h?.module)).toEqual(['Hardening', 'Hardening']);
  });

  it('imports only the contracts, the kit and the templates (rule 12)', () => {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sim', 'scenarios', 'ccna3', 'hardening.ts');
    const text = readFileSync(file, 'utf8');
    const specifiers = [...text.matchAll(/^import[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const s of specifiers) expect(s, s).toMatch(/^\.\.\/\.\.\/\.\.\/contracts\/[a-z-]+\.js$|^\.\.\/kit\.js$|^\.\.\/templates\.js$/);
    // one array under the fixed name, nothing else exported as an array of labs
    expect(text.match(/export const \w+: readonly ScenarioInfo\[\]/g)).toEqual(['export const CCNA3_HARDENING_LABS: readonly ScenarioInfo[]']);
  });
});

for (const lab of CCNA3_HARDENING_LABS) {
  describe(`CCNA3 lab: ${lab.name}`, () => {
    it('describes itself with structured-clone safe metadata, its module as topic, §11.2 kinds and a catalog it really uses', () => {
      expect(lab.category).toBe('ccna3-lab');
      expect(lab.course).toBe('CCNA 3');
      expect(lab.topic).toBe(LESSONS.find((l) => l.lesson.lab === lab.name)?.module);
      expect(lab.labType).toBeDefined();
      expect(lab.seed).toBeTypeOf('number');
      expect(lab.build().seed).toBe(lab.seed);
      expect((lab.objectives ?? []).length).toBeGreaterThan(0);
      expect(Object.keys(lab.solution ?? {}).length).toBeGreaterThan(0);

      const meta = scenarioMeta(lab);
      expect(structuredClone(meta)).toEqual(meta);
      for (const task of meta.tasks ?? []) expect(task).not.toHaveProperty('assertions');

      const topo = lab.build();
      expect([...(lab.requires ?? [])].sort()).toEqual(typesOf(topo));
      for (const type of lab.requires ?? []) expect(catalog.get(type), type).toBeDefined();
      const ids = (lab.tasks ?? []).map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect((lab.tasks ?? []).reduce((n, t) => n + t.points, 0)).toBe(100);
      for (const task of lab.tasks ?? []) {
        expect(task.points, task.id).toBeGreaterThan(0);
        expect(task.assertions.length, task.id).toBeGreaterThan(0);
        for (const a of task.assertions) expect(LAB_KINDS, `${task.id}: ${a.kind}`).toContain(a.kind);
      }
      const names = topo.devices.map((d) => d.name);
      for (const name of Object.keys(lab.solution ?? {})) expect(names).toContain(name);
    });

    it('builds a P3-profile world with the 1.3 schema, and tells the learner how long the boot takes (§11.2)', () => {
      const topo = lab.build();
      expect(topo.profile).toBe('P3');
      expect(topo.schema).toBe(TOPOLOGY_SCHEMA_ID_1_3);
      expect(topo.schema).toBe(schemaIdFor(topo));
      const sim = createSimulation({ seed: lab.seed ?? 1 });
      sim.loadTopology(topo);
      expect(sim.profile).toBe('P3');
      expect(lab.instructions).toContain('about 45 s');
      expect(lab.instructions).toContain('about a minute');
    });

    it('makes every switch access port facing a host or a router an edge port (PortFast)', () => {
      const topo = lab.build();
      const byId = new Map(topo.devices.map((d) => [d.id, d]));
      let checked = 0;
      for (const l of topo.links) {
        for (const [sw, other] of [[l.a, l.b], [l.b, l.a]] as const) {
          const swDev = byId.get(sw.device)!;
          if (swDev.type !== 'switch.nfc2960') continue;
          const lines = sectionOf(swDev.config ?? '', `interface ${sw.port}`) ?? [];
          if (lines.includes('switchport mode trunk')) continue;
          expect(byId.get(other.device)!.type, `${l.id}`).not.toBe('switch.nfc2960');
          expect(lines, `${swDev.name} ${sw.port}`).toContain('spanning-tree portfast');
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(0);
    });

    it('fails every task before the learner starts, each with a reason that is not only the grader\'s own login', () => {
      const sim = labWorld(lab);
      const status = evaluateLab(sim, lab);
      expect(status.lab).toBe(lab.name);
      expect(status.score).toBe(0);
      const failing = failingAssertions(status, lab);
      for (const r of status.results) {
        expect(r.pass, r.task).toBe(false);
        const own = failing.filter((f) => f.task === r.task);
        expect(own.some((f) => f.detail !== ''), r.task).toBe(true);
        expect(own.some((f) => f.kind !== 'service'), r.task).toBe(true);
      }
    }, LAB_TEST_TIMEOUT_MS);

    it('scores full marks once the reference solution is applied as written (lab 19: with the learner\'s logins)', () => {
      const sim = labWorld(lab);
      solve(sim, lab);
      const status = evaluateLab(sim, lab);
      const failing = failingAssertions(status, lab);
      if (serviceCheckerLanded()) {
        expect(failing).toEqual([]);
        expect(status.score).toBe(status.total);
      } else {
        // only the remote-login checks of the clone are pending, each with the W0 stub text
        expect(failing.filter((f) => !(f.kind === 'service' && f.detail.startsWith(SERVICE_STUB_DETAIL)))).toEqual([]);
      }
    }, LAB_TEST_TIMEOUT_MS);

    it('grades without touching the live simulation, and the same way twice', () => {
      const sim = labWorld(lab);
      solve(sim, lab);
      const now = sim.now;
      const head = sim.trace(0).next;
      const pdus = sim.snapshot().pduCount;
      const topo = JSON.stringify(sim.exportTopology());
      const first = evaluateLab(sim, lab);
      const second = evaluateLab(sim, lab);
      expect(second).toEqual(first);
      expect(sim.now).toBe(now);
      expect(sim.trace(0).next).toBe(head);
      expect(sim.snapshot().pduCount).toBe(pdus);
      expect(JSON.stringify(sim.exportTopology())).toBe(topo);
    }, LAB_TEST_TIMEOUT_MS);
  });
}

describe('CCNA3 lab ccna3-secure-device-access: the learner\'s own logins (§3.14)', () => {
  const A = SECURE_ACCESS_ADDRESSES;
  const logins = (sim: Simulation): Pick<VtyLoginRow, 'proto' | 'peer' | 'user' | 'result' | 'reason'>[] =>
    (sim.device(idOf(sim, 'R1'))!.tables.get<VtyLoginRow>('vty-logins')?.rows() ?? []).map((r) => ({ proto: r.proto, peer: r.peer, user: r.user, result: r.result, reason: r.reason }));
  const aclRow = (sim: Simulation, key: string): AclRow | undefined => sim.device(idOf(sim, 'R1'))!.tables.get<AclRow>('acl')?.get(key);

  it('starts with telnet open to the shared line password (the weakness), which the lab text names', () => {
    const sim = labWorld(ccna3SecureDeviceAccess);
    const out = typedOnConsole(sim, 'PC2', [`telnet ${A.r1}`, SECURE_ACCESS_OLD_LINE_PASSWORD]);
    expect(out[0]).toContain(`Connected to ${A.r1}.`);
    expect(logins(sim)).toEqual([{ proto: 'telnet', peer: A.pc2, user: undefined, result: 'success', reason: undefined }]);
    expect(ccna3SecureDeviceAccess.instructions).toContain(`\`${SECURE_ACCESS_OLD_LINE_PASSWORD}\``);
  }, LAB_TEST_TIMEOUT_MS);

  it('the logins the lab asks for write one success from PC1 and one access-class refusal from PC2; telnet is refused', () => {
    const sim = labWorld(ccna3SecureDeviceAccess);
    applySolution(sim, ccna3SecureDeviceAccess);
    // the logins are the lines the instructions print
    for (const l of SECURE_ACCESS_LOGINS) for (const line of l.lines.filter((x) => x !== SECURE_ACCESS_SECRET && x !== 'exit')) expect(ccna3SecureDeviceAccess.instructions).toContain(line);
    const [pc1, pc2] = typeLogins(sim);
    expect(pc1!.join('\n')).not.toContain('refused');
    expect(pc2!.join('\n')).toContain(`% Connection refused by ${A.r1}`);
    expect(logins(sim)).toEqual([
      { proto: 'ssh', peer: A.pc1, user: SECURE_ACCESS_USER, result: 'success', reason: undefined },
      { proto: 'ssh', peer: A.pc2, user: SECURE_ACCESS_USER, result: 'refused', reason: 'access-class 10' },
    ]);
    expect(aclRow(sim, '4|10|implicit')).toMatchObject({ matches: 1, lastIface: 'vty', applied: 'vty in' });
    expect(aclRow(sim, '4|10|10')).toMatchObject({ matches: 1, applied: 'vty in' });
    // PC1's session ended with its `exit`
    expect(sim.cli.sessions().filter((v) => v.via === 'vty')).toEqual([]);
    // telnet, which the transport excludes, is refused before any login (no row)
    expect(typedOnConsole(sim, 'PC1', [`telnet ${A.r1}`])[0]).toContain(`% Connection refused by ${A.r1}`);
    expect(logins(sim)).toHaveLength(2);
    expect(taskPasses(sim, ccna3SecureDeviceAccess)['own-logins']).toBe(true);
  }, LAB_TEST_TIMEOUT_MS);

  it('the configuration alone earns everything but the task that needs the learner\'s own logins', () => {
    const sim = labWorld(ccna3SecureDeviceAccess);
    applySolution(sim, ccna3SecureDeviceAccess);
    const passes = taskPasses(sim, ccna3SecureDeviceAccess);
    expect(passes['own-logins']).toBe(false);
    expect(taskFailures(sim, ccna3SecureDeviceAccess, 'own-logins')).toEqual([
      `The vty-logins table of R1 has no row with proto=ssh peer=${A.pc1} user=${SECURE_ACCESS_USER} result=success. R1 has not seen an SSH login from PC1 yet.`,
      `The vty-logins table of R1 has no row with proto=ssh peer=${A.pc2} result=refused. R1 has not refused an SSH attempt from PC2 yet.`,
      'The acl table of R1 has no row with list=10 action=deny lastIface=vty matches >= 1. List 10 has not yet refused a login on the remote lines.',
    ]);
    for (const task of ['ssh-ready', 'unused-ports']) expect(passes[task], task).toBe(true);
  }, LAB_TEST_TIMEOUT_MS);
});

describe('CCNA3 lab ccna3-secure-device-access: wrong answers', () => {
  const lab = ccna3SecureDeviceAccess;
  const A = SECURE_ACCESS_ADDRESSES;
  const R1 = lab.solution!['R1']!;
  const without = (drop: readonly string[], add: readonly string[] = []): string[] => {
    const lines = R1.filter((l) => !drop.includes(l));
    const at = lines.indexOf('exit');
    return [...lines.slice(0, at), ...add, ...lines.slice(at)];
  };

  it('telnet left on beside SSH fails the SSH-only task', () => {
    const sim = labWorld(lab);
    typeOn(sim, 'R1', without(['transport input ssh'], ['transport input telnet ssh']));
    typeOn(sim, 'SW1', lab.solution!['SW1']!);
    sim.runToIdle();
    typeLogins(sim);
    expect(taskFailures(sim, lab, 'ssh-only')[0]).toMatch(/^R1 vty.transport is (ssh telnet|telnet ssh), expected ssh.$/);
    if (serviceCheckerLanded()) expect(taskFailures(sim, lab, 'ssh-only')[1]).toBe(`PC1's Telnet login to R1 (${A.r1}) succeeded; this task expects it to be refused. Telnet still reaches the remote lines.`);
    // telnet really reaches the lines (asks for a user name and a password)
    expect(typedOnConsole(sim, 'PC1', [`telnet ${A.r1}`])[0]).toContain(`Connected to ${A.r1}.`);
  }, LAB_TEST_TIMEOUT_MS);

  it('a list 10 that permits the whole subnet fails the admin-PC task (PC2 is not denied)', () => {
    const sim = labWorld(lab);
    typeOn(sim, 'R1', without([`access-list 10 permit host ${A.pc1}`]));
    typeOn(sim, 'R1', ['access-list 10 permit 192.168.10.0 0.0.0.255']);
    sim.runToIdle();
    const fails = taskFailures(sim, lab, 'admin-pc-only');
    expect(fails.some((d) => d.includes('expected deny'))).toBe(true);
    // PC2 now logs in: no refusal for the learner's own logins either
    typeLogins(sim);
    expect(taskPasses(sim, lab)['own-logins']).toBe(false);
  }, LAB_TEST_TIMEOUT_MS);

  it('logins tried before the access class was bound leave no refusal: the own-logins task fails', () => {
    const sim = labWorld(lab);
    typeOn(sim, 'R1', without(['access-class 10 in']));
    sim.runToIdle();
    typeLogins(sim);
    typeOn(sim, 'R1', ['line vty 0 4', 'access-class 10 in', 'exit']);
    sim.runToIdle();
    const passes = taskPasses(sim, lab);
    expect(passes['admin-pc-only']).toBe(serviceCheckerLanded());
    expect(passes['own-logins']).toBe(false);
    expect(taskFailures(sim, lab, 'own-logins')[0]).toContain('R1 has not refused an SSH attempt from PC2 yet.');
  }, LAB_TEST_TIMEOUT_MS);

  it("'deny PC2, permit any' fails the admin-PC task: SW1's address would be admitted (W5 fix #10)", () => {
    const sim = labWorld(lab);
    typeOn(sim, 'R1', without([`access-list 10 permit host ${A.pc1}`], [`access-list 10 deny host ${A.pc2}`, 'access-list 10 permit any']));
    typeOn(sim, 'SW1', lab.solution!['SW1']!);
    sim.runToIdle();
    typeLogins(sim);
    const result = evaluateLab(sim, lab).results.find((r) => r.task === 'admin-pc-only')!;
    expect(result.pass).toBe(false);
    expect(result.assertions.filter((a) => !a.pass).map((a) => a.index)).toEqual([4]);
    expect(result.misconception).toBe('deny-one-permit-the-rest');
    expect(result.assertions[4]!.detail).toContain(`from ${A.sw1}`);
  }, LAB_TEST_TIMEOUT_MS);

  it('an explicit deny any after the permit still earns the own-logins task (the deny row is read by action, W5 fix #3)', () => {
    const sim = labWorld(lab);
    const R1x = R1.flatMap((l) => (l === `access-list 10 permit host ${A.pc1}` ? [l, 'access-list 10 deny any'] : [l]));
    expect(R1x).toContain('access-list 10 deny any');
    typeOn(sim, 'R1', R1x);
    typeOn(sim, 'SW1', lab.solution!['SW1']!);
    sim.runToIdle();
    typeLogins(sim);
    expect(sim.device(idOf(sim, 'R1'))!.tables.get<AclRow>('acl')?.get('4|10|20')).toMatchObject({ matches: 1, lastIface: 'vty' });
    expect(sim.device(idOf(sim, 'R1'))!.tables.get<AclRow>('acl')?.get('4|10|implicit')).toMatchObject({ matches: 0 });
    const status = evaluateLab(sim, lab);
    expect(failingAssertions(status, lab)).toEqual([]);
    expect(status.score).toBe(100);
  }, LAB_TEST_TIMEOUT_MS);

  it("'line vty 0 15' instead of 'line vty 0 4' earns full marks: the range covers lines 0-4 too (W5 fix #11)", () => {
    const sim = labWorld(lab);
    typeOn(sim, 'R1', R1.map((l) => (l === 'line vty 0 4' ? 'line vty 0 15' : l)));
    typeOn(sim, 'SW1', lab.solution!['SW1']!);
    sim.runToIdle();
    // stored as typed: the startup section keeps its line password, the new one follows it
    const text = sim.device(idOf(sim, 'R1'))!.running.render();
    expect(text.indexOf('line vty 0 4')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('line vty 0 15')).toBeGreaterThan(text.indexOf('line vty 0 4'));
    expect(sectionOf(text, 'line vty 0 15')).toEqual(expect.arrayContaining(['login local', 'transport input ssh', 'access-class 10 in']));
    // the server serves line 0 with the new settings: PC1 logs in as admin, PC2 is refused by the access class
    const [pc1, pc2] = typeLogins(sim);
    expect(pc1!.join('\n')).not.toMatch(/refused|failed|denied/i);
    expect(pc2!.join('\n')).toContain(`% Connection refused by ${A.r1}`);
    expect((sim.device(idOf(sim, 'R1'))!.tables.get<VtyLoginRow>('vty-logins')?.rows() ?? []).map((r) => [r.proto, r.peer, r.result])).toEqual([
      ['ssh', A.pc1, 'success'],
      ['ssh', A.pc2, 'refused'],
    ]);
    // telnet is off on every line
    expect(typedOnConsole(sim, 'PC1', [`telnet ${A.r1}`])[0]).toContain(`% Connection refused by ${A.r1}`);
    const status = evaluateLab(sim, lab);
    if (serviceCheckerLanded()) {
      expect(failingAssertions(status, lab)).toEqual([]);
      expect(status.score).toBe(100);
    } else {
      expect(failingAssertions(status, lab).filter((f) => !(f.kind === 'service' && f.detail.startsWith(SERVICE_STUB_DETAIL)))).toEqual([]);
    }
  }, LAB_TEST_TIMEOUT_MS);

  it('keeping the shared line password (no login local) fails the local-users task', () => {
    const sim = labWorld(lab);
    typeOn(sim, 'R1', without(['login local']));
    sim.runToIdle();
    const fails = taskFailures(sim, lab, 'local-users');
    expect(fails[0]).toBe('R1 vty.loginLocal is false, expected true.');
    if (serviceCheckerLanded()) expect(fails[1]).toContain(`PC1's SSH login to R1 (${SECURE_ACCESS_ADDRESSES.r1}) failed on the user name or password`);
  }, LAB_TEST_TIMEOUT_MS);
});

describe('CCNA3 lab ccna3-dhcp-snooping-dai: the rogue server, the bindings and the learner\'s path (§3.4)', () => {
  const lab = ccna3DhcpSnoopingDai;
  const A = SNOOPING_ADDRESSES;
  const sw1 = (sim: Simulation) => sim.device(idOf(sim, 'SW1'))!;
  const bindings = (sim: Simulation): [string, string, string, string][] =>
    (sw1(sim).tables.get<DhcpSnoopingRow>('dhcp-snooping')?.rows() ?? []).map((r) => [r.mac, r.ip, r.port, r.kind]);
  const leaseOf = (sim: Simulation, name: string) => sim.device(idOf(sim, name))!.port('GigabitEthernet0')!.l3.ipv4;
  const macOf = (sim: Simulation, name: string): string => sim.device(idOf(sim, name))!.port('GigabitEthernet0')!.mac;

  it('opens with PC1 and ATTACKER on the rogue\'s lure, SRV1 on its fixed address; SRV1\'s MAC is the one the solution binds', () => {
    const sim = labWorld(lab);
    expect(leaseOf(sim, 'PC1')).toMatchObject({ address: '10.66.0.2', origin: 'dhcp' });
    expect(leaseOf(sim, 'ATTACKER')).toMatchObject({ address: '10.66.0.3', origin: 'dhcp' });
    expect(leaseOf(sim, 'SRV1')).toMatchObject({ address: A.srv1, prefixLen: 24 });
    expect(macOf(sim, 'SRV1')).toBe(SNOOPING_SRV1_MAC);
    expect(lab.solution!['SW1']).toContain(`ip source binding ${SNOOPING_SRV1_MAC} vlan 10 ${A.srv1} interface FastEthernet0/2`);
    // R45: the trunk to R1 is a PortFast trunk from the start
    expect(sectionOf(lab.build().devices.find((d) => d.name === 'SW1')!.config ?? '', 'interface GigabitEthernet0/1')).toEqual(['switchport mode trunk', 'spanning-tree portfast trunk']);
  }, LAB_TEST_TIMEOUT_MS);

  it('the learner\'s path: snooping, then ipconfig /release and /renew on PC1 bind it to Fa0/1 with R1\'s lease; the rest earns full marks', () => {
    const sim = labWorld(lab);
    const sw = lab.solution!['SW1']!;
    const dai = sw.indexOf(`ip source binding ${SNOOPING_SRV1_MAC} vlan 10 ${A.srv1} interface FastEthernet0/2`);
    typeOn(sim, 'SW1', sw.slice(0, dai));
    sim.runToIdle();
    expect(typedOnConsole(sim, 'PC1', ['ipconfig /release', 'ipconfig /renew']).join('\n')).toContain('GigabitEthernet0: 192.168.10.11/24 leased from 192.168.10.1');
    sim.runToIdle();
    expect(leaseOf(sim, 'PC1')).toMatchObject({ address: '192.168.10.11', origin: 'dhcp' });
    expect(bindings(sim)).toEqual([[macOf(sim, 'PC1'), '192.168.10.11', 'FastEthernet0/1', 'learned']]);
    // the rate limit is stored and shown, never graded (D13)
    expect(sw1(sim).running.render()).toContain(`ip dhcp snooping limit rate ${SNOOPING_RATE_LIMIT}`);
    typeOn(sim, 'SW1', sw.slice(dai));
    typeOn(sim, 'ATTACKER', lab.solution!['ATTACKER']!);
    sim.runToIdle();
    const dropped = sw1(sim).tables.get<ArpInspectionRow>('arp-inspection')!.get('10')!;
    expect(dropped.droppedNoBinding).toBeGreaterThan(0);
    const status = evaluateLab(sim, lab);
    expect(failingAssertions(status, lab)).toEqual([]);
    expect(status.score).toBe(100);
  }, LAB_TEST_TIMEOUT_MS);

  it('the forged announcement is dropped at SW1 and PC1 keeps R1\'s MAC address for the gateway', () => {
    const sim = labWorld(lab);
    applySolution(sim, lab);
    const r1Mac = sim.device(idOf(sim, 'R1'))!.port('GigabitEthernet0/0')!.mac;
    expect(typedOnConsole(sim, 'PC1', [`ping ${A.r1}`])[0]).toMatch(/!/);
    const row = sim.device(idOf(sim, 'PC1'))!.tables.arp.rows().find((r) => r.ip === A.r1);
    expect(row?.mac).toBe(r1Mac);
    expect(sw1(sim).tables.get<ArpInspectionRow>('arp-inspection')!.get('10')!.dropped).toBeGreaterThan(0);
  }, LAB_TEST_TIMEOUT_MS);
});

describe('CCNA3 lab ccna3-dhcp-snooping-dai: wrong answers', () => {
  const lab = ccna3DhcpSnoopingDai;
  const SW = lab.solution!['SW1']!;
  const solveWith = (sim: Simulation, sw1: readonly string[]): void => {
    typeOn(sim, 'SW1', sw1);
    typeOn(sim, 'PC1', lab.solution!['PC1']!);
    typeOn(sim, 'ATTACKER', lab.solution!['ATTACKER']!);
    sim.runToIdle();
  };

  it('trusting every access port fails the uplink task, and the rogue\'s offers are let through again', () => {
    const sim = labWorld(lab);
    solveWith(sim, [...SW, 'interface range FastEthernet0/1 - 2 , FastEthernet0/5 , FastEthernet0/24', 'ip dhcp snooping trust', 'exit']);
    const fails = taskFailures(sim, lab, 'trust-uplink');
    expect(fails).toEqual(['FastEthernet0/1', 'FastEthernet0/2', 'FastEthernet0/5', 'FastEthernet0/24'].map((p) => `SW1 snooping.trusted of ${p} is true, expected false.`));
  }, LAB_TEST_TIMEOUT_MS);

  it('trusting SRV1\'s port instead of binding its address fails the static-server task', () => {
    const sim = labWorld(lab);
    const binding = SW.find((l) => l.startsWith('ip source binding'))!;
    solveWith(sim, [...SW.filter((l) => l !== binding), 'interface FastEthernet0/2', 'ip arp inspection trust', 'exit']);
    const fails = taskFailures(sim, lab, 'static-server');
    expect(fails).toHaveLength(2);
    expect(fails[0]).toContain('The dhcp-snooping table of SW1 has no row with kind=static');
    expect(fails[1]).toBe('SW1 dai.trusted of FastEthernet0/2 is true, expected false.');
  }, LAB_TEST_TIMEOUT_MS);

  it('inspection without SRV1\'s binding cuts SRV1 off: the static-server task fails on its ping too', () => {
    const sim = labWorld(lab);
    solveWith(sim, SW.filter((l) => !l.startsWith('ip source binding')));
    const fails = taskFailures(sim, lab, 'static-server');
    expect(fails[0]).toContain('The dhcp-snooping table of SW1 has no row with kind=static');
    expect(fails[1]).toMatch(/^SRV1 got no reply from 192\.168\.10\.1/);
    // the other tasks are unaffected
    const passes = taskPasses(sim, lab);
    for (const task of ['snooping-on', 'trust-uplink', 'pc1-bound', 'dai-on', 'spoof-dropped']) expect(passes[task], task).toBe(true);
  }, LAB_TEST_TIMEOUT_MS);

  it('dropped ARPs of SRV1 alone, with no attack, do not earn the spoof task (W5 fix #9)', () => {
    const sim = labWorld(lab);
    const sw = lab.solution!['SW1']!;
    const binding = sw.find((l) => l.startsWith('ip source binding'))!;
    // the instructions' order: snooping, the renewal, inspection — then a ping from SRV1 before its binding exists
    typeOn(sim, 'SW1', sw.filter((l) => l !== binding));
    typeOn(sim, 'PC1', lab.solution!['PC1']!);
    sim.runToIdle();
    typedOnConsole(sim, 'SRV1', [`ping ${SNOOPING_ADDRESSES.r1}`]);
    sim.runToIdle();
    typeOn(sim, 'SW1', [binding]);
    sim.runToIdle();
    expect(sim.device(idOf(sim, 'SW1'))!.tables.get<ArpInspectionRow>('arp-inspection')!.get('10')!.dropped).toBeGreaterThan(0);
    const passes = taskPasses(sim, lab);
    expect(passes['spoof-dropped']).toBe(false);
    expect(taskFailures(sim, lab, 'spoof-dropped')).toEqual([`ATTACKER GigabitEthernet0 has 10.66.0.3/24, expected ${SNOOPING_ADDRESSES.r1}. ATTACKER has not claimed R1's address yet.`]);
    for (const task of ['snooping-on', 'trust-uplink', 'pc1-bound', 'dai-on', 'static-server']) expect(passes[task], task).toBe(true);
  }, LAB_TEST_TIMEOUT_MS);

  it('PC1 left on the rogue\'s lease (no new request after snooping) fails the binding task', () => {
    const sim = labWorld(lab);
    typeOn(sim, 'SW1', SW);
    sim.runToIdle();
    expect(taskFailures(sim, lab, 'pc1-bound')[0]).toBe('SW1 snooping.bindingPort of PC1 is not set, expected FastEthernet0/1. SW1 has no binding for PC1 yet.');
  }, LAB_TEST_TIMEOUT_MS);
});
