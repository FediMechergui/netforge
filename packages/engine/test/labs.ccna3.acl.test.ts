/**
 * P3 W5 acl: the CCNA 3 access-list labs (ARCHITECTURE-P3 §7 W5, §11.1, §11.2, §3.3, §3.14; sim/scenarios/ccna3/acl.ts)
 * — a local copy of the checks of `labs.ccna3.solutions.test.ts` (owned by sim), filtered to lab 15
 * `ccna3-acl-standard` (with its [S13] remote-line tasks), lab 16 `ccna3-acl-extended` and lab 17
 * `ccna3-acl-edit-verify`, plus each lab's own proofs.
 *
 * For each lab:
 *   • metadata: category `ccna3-lab`, course `CCNA 3`, `topic` = the title of the module that holds its lesson in
 *     curriculum/ccna3/lessons.ts, the name §11.1 freezes, a fixed seed, the §11.2 timing sentence, structured-clone
 *     safe `scenarioMeta`, `requires` = exactly the catalog types the topology uses, tasks with unique ids, real points
 *     and existing dependencies, a solution for devices the topology has, scheduled faults aimed at devices it has;
 *     PortFast on every switch port that faces a host or a router;
 *   • its world: a P3-profile topology whose schema is `schemaIdFor(t)` (1.3), loaded as a P3 world;
 *   • UNSOLVED (built, scheduled faults injected the way the worker does, booted and settled): EVERY task fails, each
 *     on a failing assertion that says why;
 *   • SOLVED: `configure` accepts every line of the reference solution as written, the world runs to idle, and — for
 *     lab 15 after the learner's own logins of `ACL_STANDARD_LOGINS` typed on the PCs' consoles — every task passes:
 *     full marks;
 *   • grading is read-only (same clock, trace head and PDU count) and repeatable (two evaluations are equal).
 *
 * The [S13] `service` kind is the W5 sim item's checker. While the registry still answers it with the W0 stub detail,
 * the full-marks case accepts exactly those failures (each must be a `service` assertion) and becomes strict by itself
 * once the checker is in the tree; lab 15's live task proves the same configuration from the learner's own logins.
 *
 * Also: lab 15 grades the remote lines live — the configuration alone passes the configuration task and not the
 * login task, whose details name the missing rows, and logins made before the access class was bound do not count;
 * lab 17 grades nothing before the colleague's hidden edit lands, a power cycle of R1 keeps it, the counters of the
 * broken list show which entries never match, and a saved repair survives a reload in order but renumbered (the
 * instructions warn; the clone, which boots from the export, renumbers the same way, so its counter checks find the
 * rows by their text). Wrong answers: a standard list placed near the source and the server list bound inbound on
 * R2's serial link (lab 15: the guests lose INFO); a vty list that admits the whole staff LAN (lab 15: the pure
 * decision and the clone's SSH login from PC2 both fail, and the live record has no refusal); vty lists that refuse
 * only the hosts they name ('deny PC2, permit any', with the guest LAN's deny added, or with the staff LAN permitted
 * after it: lab 15's GUEST, INFO and other-staff-host probes); a named list without
 * its final permit (lab 15); an extended list applied near the destination, `permit icmp any any` in place of echo
 * replies and a server list that matches port 80 as the destination instead of `established` (lab 16); the kiosk's
 * deny appended at the end, a deny without `log` and a ping entry appended instead of replacing entry 20 (lab 17).
 * Right answers in other words still pass: an entry by port number (`eq 80`) and narrower return entries (lab 16);
 * a list deleted and typed again in the right order earns the content tasks but not the sequence-number ones (lab 17).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../src/contracts/ids.js';
import type { LabAssertion, ScenarioInfo } from '../src/contracts/scenario.js';
import { scenarioMeta } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { AclRow, VtyLoginRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID_1_3, schemaIdFor, type Topology } from '../src/contracts/topology.js';
import { CCNA3_MODULES } from '../src/curriculum/ccna3/lessons.js';
import { createCatalog } from '../src/device/catalog/index.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import { LAB_PREPARING_DETAIL, evaluateLab } from '../src/sim/lab-checks.js';
import { createSimulation } from '../src/sim/simulation.js';
import {
  ACL_EDIT_FAULT_AT,
  ACL_EDIT_LIST,
  ACL_STANDARD_ADDRESSES,
  ACL_STANDARD_LOGINS,
  ACL_STANDARD_SECRET,
  ACL_STANDARD_USER,
  ACL_STANDARD_VTY_LIST,
  CCNA3_ACL_LABS,
  ccna3AclEditVerify,
  ccna3AclExtended,
  ccna3AclStandard,
} from '../src/sim/scenarios/ccna3/acl.js';
import { PC, ROUTER, SERVER, SWITCH } from '../src/sim/scenarios/kit.js';

/** Long enough for every model of a lab to boot (a router takes 45 s) and for lab 17's hidden edit (50 s) to land. */
const BOOT_NS = 90 * SEC;

/** Wall-clock budget of one per-lab world test: a lab world plus the grading clones it names. */
const LAB_TEST_TIMEOUT_MS = 90_000;

/** The W0 stub detail of the `service` kind (registry.ts UNAVAILABLE_KIND_DETAILS), until the W5 sim checker lands. */
const SERVICE_STUB_DETAIL = 'Remote login checks are not available in this build.';

/** The three labs, the names §11.1 freezes, in course order. */
const NAMES = ['ccna3-acl-standard', 'ccna3-acl-extended', 'ccna3-acl-edit-verify'] as const;

const catalog = createCatalog(PROCESS_FACTORIES);

/** The lessons of the skeleton in teaching order, with the title of the module that holds each. */
const LESSONS = CCNA3_MODULES.flatMap((m) => m.lessons.map((l) => ({ lesson: l, module: m.title })));

/** The lab's world as `loadScenario` builds it: the lab seed, the lab topology, its scheduled faults, booted and settled. */
function labWorld(lab: ScenarioInfo): Simulation {
  const sim = createSimulation({ seed: lab.seed ?? 1 });
  sim.loadTopology({ ...lab.build(), lab: { name: lab.name, version: lab.version ?? 1 } });
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

/** Type `lines` on the device called `name` through `configure`; every line must be accepted. */
function typeOn(sim: Simulation, name: string, lines: readonly string[]): void {
  const r = sim.configure(idOf(sim, name), lines);
  expect(r.lines.filter((l) => !l.ok).map((l) => `${l.line}: ${l.error?.message ?? l.output}`), `${name}: ${lines.join(' / ')}`).toEqual([]);
  expect(r.ok, `${name}: ${lines.join(' / ')}`).toBe(true);
}

/** The learner's own logins of lab 15 (`ACL_STANDARD_LOGINS`): each line typed on the PC's console, 3 s apart. */
function typeLogins(sim: Simulation, logins: readonly { readonly from: string; readonly lines: readonly string[] }[]): void {
  for (const login of logins) {
    const s = sim.cli.open(idOf(sim, login.from), 'console');
    for (const line of login.lines) {
      sim.cli.exec(s, line);
      sim.runFor(3 * SEC);
    }
  }
  sim.runToIdle();
}

/** Apply the reference solution (a refused line is a defect in the lab), then the learner's logins lab 15 asks for. */
function solve(sim: Simulation, lab: ScenarioInfo): void {
  for (const [name, lines] of Object.entries(lab.solution ?? {})) typeOn(sim, name, lines);
  sim.runToIdle();
  if (lab === ccna3AclStandard) typeLogins(sim, ACL_STANDARD_LOGINS);
}

/** The catalog types a topology actually uses. */
function typesOf(topo: Topology): string[] {
  return [...new Set(topo.devices.map((d) => d.type))].sort();
}

/** The assertions of `lab` in grading order, matched to the evaluated results (task id, index). */
function assertionOf(lab: ScenarioInfo, task: string, index: number): LabAssertion {
  return lab.tasks!.find((t) => t.id === task)!.assertions[index]!;
}

/** Failing assertions as `task#index: detail`, except the `service` stub failures (file header), returned apart. */
function failures(sim: Simulation, lab: ScenarioInfo): { real: string[]; serviceStub: string[] } {
  const real: string[] = [];
  const serviceStub: string[] = [];
  for (const r of evaluateLab(sim, lab).results) {
    for (const a of r.assertions) {
      if (a.pass) continue;
      const line = `${r.task}#${a.index}: ${a.detail ?? '(no detail)'}`;
      if (a.detail === SERVICE_STUB_DETAIL && assertionOf(lab, r.task, a.index).kind === 'service') serviceStub.push(line);
      else real.push(line);
    }
  }
  return { real, serviceStub };
}

/** Pass flag of each task, by id. */
function taskPasses(sim: Simulation, lab: ScenarioInfo): Record<string, boolean> {
  return Object.fromEntries(evaluateLab(sim, lab).results.map((r) => [r.task, r.pass]));
}

/** The failing details of one task. */
function detailsOf(sim: Simulation, lab: ScenarioInfo, task: string): string[] {
  const r = evaluateLab(sim, lab).results.find((x) => x.task === task);
  return (r?.assertions ?? []).filter((a) => !a.pass).map((a) => a.detail ?? '');
}

/** True when the registry still answers `service` with the W0 stub (file header). */
function serviceStubbed(sim: Simulation): boolean {
  const probe: ScenarioInfo = {
    name: 'probe',
    title: 'probe',
    description: 'probe',
    category: 'ccna3-lab',
    build: () => ({ schema: TOPOLOGY_SCHEMA_ID_1_3, seed: 1, devices: [], links: [] }),
    tasks: [{ id: 'p', title: 'p', description: 'p', points: 1, assertions: [{ kind: 'service', from: 'X', to: 'Y', service: 'ssh', expect: 'success' }] }],
  };
  return evaluateLab(sim, probe).results[0]!.assertions[0]!.detail === SERVICE_STUB_DETAIL;
}

describe('CCNA3 ACL labs: the file', () => {
  it('exports the three labs of lessons 15-17 under CCNA3_ACL_LABS, in course order', () => {
    expect(CCNA3_ACL_LABS.map((l) => l.name)).toEqual([...NAMES]);
    expect(CCNA3_ACL_LABS).toEqual([ccna3AclStandard, ccna3AclExtended, ccna3AclEditVerify]);
    // the lessons that name these labs are 15, 16 and 17, in that order
    expect(LESSONS.filter((l) => (NAMES as readonly string[]).includes(l.lesson.lab ?? '')).map((l) => l.lesson.id)).toEqual([
      'ccna3-15-standard-acls',
      'ccna3-16-extended-acls',
      'ccna3-17-editing-and-reading-acls',
    ]);
  });

  it('imports only the contracts, the kit and the templates (no cycle, rule 12)', () => {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sim', 'scenarios', 'ccna3', 'acl.ts');
    const imports = [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(0);
    for (const target of imports) expect(target, target).toMatch(/^\.\.\/\.\.\/\.\.\/contracts\/[a-z-]+\.js$|^\.\.\/kit\.js$|^\.\.\/templates\.js$/);
  });
});

for (const lab of CCNA3_ACL_LABS) {
  describe(`CCNA3 lab: ${lab.name}`, () => {
    it('describes itself with structured-clone safe metadata, its module as topic and a catalog it really uses', () => {
      expect(lab.category).toBe('ccna3-lab');
      expect(lab.course).toBe('CCNA 3');
      expect(lab.name).toMatch(/^ccna3(-[a-z0-9]+)+$/);
      const home = LESSONS.find((l) => l.lesson.lab === lab.name);
      expect(home, `${lab.name} is the lab of a lesson`).toBeDefined();
      expect(lab.topic).toBe(home?.module);
      expect(lab.topic).toBe('Access control lists');
      expect(lab.labType).toBeDefined();
      expect(lab.seed, lab.name).toBeTypeOf('number');
      expect(lab.instructions ?? '', lab.name).not.toBe('');
      // §11.2: the timing sentence (no OSPF here: the 45 s router boot, "about a minute")
      expect(lab.instructions ?? '', lab.name).toContain('about a minute');
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

    it('puts PortFast on every switch port that faces a host or a router (§11.2)', () => {
      const topo = lab.build();
      const byId = new Map(topo.devices.map((d) => [d.id, d]));
      let edges = 0;
      for (const l of topo.links) {
        for (const [sw, other] of [
          [l.a, l.b],
          [l.b, l.a],
        ] as const) {
          const s = byId.get(sw.device)!;
          const o = byId.get(other.device)!;
          if (s.type !== SWITCH || ![PC, SERVER, ROUTER].includes(o.type)) continue;
          const lines = (s.config ?? '').split('\n');
          const at = lines.indexOf(`interface ${sw.port}`);
          expect(at, `${s.name} ${sw.port}`).toBeGreaterThanOrEqual(0);
          const body: string[] = [];
          for (const line of lines.slice(at + 1)) {
            if (!line.startsWith(' ')) break;
            body.push(line.trim());
          }
          expect(body, `${s.name} ${sw.port} faces ${o.name}`).toContain('spanning-tree portfast');
          edges++;
        }
      }
      expect(edges).toBeGreaterThan(0);
    });

    it('builds a P3-profile world whose schema can express it', () => {
      const topo = lab.build();
      expect(topo.profile).toBe('P3');
      expect(topo.schema).toBe(TOPOLOGY_SCHEMA_ID_1_3);
      expect(topo.schema).toBe(schemaIdFor(topo));
      expect(topo.seed).toBe(lab.seed);
      const sim = createSimulation({ seed: lab.seed ?? 1 });
      sim.loadTopology(topo);
      expect(sim.profile).toBe('P3');
    });

    it('fails every task before the student starts, and says why', () => {
      const sim = labWorld(lab);
      const status = evaluateLab(sim, lab);
      expect(status.lab).toBe(lab.name);
      expect(status.total).toBe((lab.tasks ?? []).reduce((n, t) => n + t.points, 0));
      expect(status.score, `${lab.name} unsolved`).toBe(0);
      for (const r of status.results) {
        expect(r.pass, `${lab.name}/${r.task} unsolved`).toBe(false);
        expect(r.assertions.some((a) => !a.pass && (a.detail ?? '') !== '' && a.detail !== LAB_PREPARING_DETAIL), `${lab.name}/${r.task}`).toBe(true);
      }
    }, LAB_TEST_TIMEOUT_MS);

    it('scores full marks once the reference solution is applied as written', () => {
      const sim = labWorld(lab);
      solve(sim, lab);
      const { real, serviceStub } = failures(sim, lab);
      expect(real, `${lab.name} solved`).toEqual([]);
      if (!serviceStubbed(sim)) {
        expect(serviceStub).toEqual([]);
        const status = evaluateLab(sim, lab);
        expect(status.score).toBe(status.total);
      }
    }, LAB_TEST_TIMEOUT_MS);

    it('grades without touching the live simulation, and the same way twice', () => {
      const sim = labWorld(lab);
      solve(sim, lab);
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

describe('ccna3-acl-standard: the remote lines graded live and in the clone', () => {
  it('the configuration alone earns the configuration task; the learner logins earn the live one', () => {
    const lab = ccna3AclStandard;
    const sim = labWorld(lab);
    for (const [name, lines] of Object.entries(lab.solution ?? {})) typeOn(sim, name, lines);
    sim.runToIdle();
    const before = taskPasses(sim, lab);
    expect(before['server-list']).toBe(true);
    expect(before['staff-list']).toBe(true);
    expect(before['vty-logins']).toBe(false);
    expect(detailsOf(sim, lab, 'vty-logins')).toEqual([
      expect.stringContaining('vty-logins'),
      expect.stringContaining('vty-logins'),
      "The acl table of R1 has no row with list=10 action=permit lastIface=vty matches >= 1. List 10 has not yet counted PC1's login on the remote lines.",
      "The acl table of R1 has no row with list=10 action=deny lastIface=vty matches >= 1. List 10 has not yet refused a login on the remote lines.",
    ]);
    if (!serviceStubbed(sim)) expect(before['vty-list']).toBe(true);

    // the learner logs in from PC1 and is refused on PC2: R1 records both, list 10 counts both on its vty rows
    typeLogins(sim, ACL_STANDARD_LOGINS);
    const r1 = sim.device(idOf(sim, 'R1'))!;
    const rows = (r1.tables.get<VtyLoginRow>('vty-logins')?.rows() ?? []).map((r) => [r.proto, r.peer, r.user, r.result, r.reason]);
    expect(rows).toEqual([
      ['ssh', ACL_STANDARD_ADDRESSES.pc1, ACL_STANDARD_USER, 'success', undefined],
      ['ssh', ACL_STANDARD_ADDRESSES.pc2, ACL_STANDARD_USER, 'refused', 'access-class 10'],
    ]);
    const acl = (r1.tables.get<AclRow>('acl')?.rows() ?? []).filter((r) => r.list === '10').map((r) => [r.key, r.matches, r.lastIface, r.applied]);
    expect(acl).toEqual([
      ['4|10|10', 1, 'vty', 'vty in'],
      ['4|10|implicit', 1, 'vty', 'vty in'],
    ]);
    expect(taskPasses(sim, lab)['vty-logins']).toBe(true);
  }, LAB_TEST_TIMEOUT_MS);

  it('logins made before the access class is bound do not count: the vty rows of list 10 must count them', () => {
    const lab = ccna3AclStandard;
    const sim = labWorld(lab);
    // PC1 and PC2 both log in while the lines admit anybody: two successful rows, no refusal, no vty row of list 10
    typeLogins(sim, [ACL_STANDARD_LOGINS[0]!, { from: 'PC2', lines: [...ACL_STANDARD_LOGINS[1]!.lines, 'exit'] }]);
    for (const [name, lines] of Object.entries(lab.solution ?? {})) typeOn(sim, name, lines);
    sim.runToIdle();
    expect(taskPasses(sim, lab)['vty-logins']).toBe(false);
    expect(detailsOf(sim, lab, 'vty-logins')).toEqual([
      expect.stringContaining('vty-logins'),
      "The acl table of R1 has no row with list=10 action=permit lastIface=vty matches >= 1. List 10 has not yet counted PC1's login on the remote lines.",
      "The acl table of R1 has no row with list=10 action=deny lastIface=vty matches >= 1. List 10 has not yet refused a login on the remote lines.",
    ]);
  }, LAB_TEST_TIMEOUT_MS);

  it('the password the instructions print is the one R1 holds, and SSH is the only transport', () => {
    const sim = labWorld(ccna3AclStandard);
    const r1 = sim.device(idOf(sim, 'R1'))!;
    expect(r1.running.get('username')).toEqual([ACL_STANDARD_USER, 'secret', ACL_STANDARD_SECRET]);
    expect(ccna3AclStandard.instructions).toContain(`\`${ACL_STANDARD_SECRET}\``);
    expect(r1.running.render()).toContain('line vty 0 4\n login local\n transport input ssh\n');
  }, LAB_TEST_TIMEOUT_MS);
});

describe('ccna3-acl-standard: wrong answers', () => {
  it('a standard list near the source keeps the guests off the servers but also off INFO', () => {
    const lab = ccna3AclStandard;
    const sim = labWorld(lab);
    typeOn(sim, 'R1', ['access-list 30 permit 192.168.10.0 0.0.0.255', 'interface GigabitEthernet0/1', 'ip access-group 30 in', 'exit']);
    sim.runToIdle();
    expect(taskPasses(sim, lab)['server-list']).toBe(false);
    const details = detailsOf(sim, lab, 'server-list');
    expect(details[0]).toBe('R2 has no access list 30.');
    expect(details.some((d) => d.includes('GUEST') && d.includes('INFO') && d.includes('cuts the guests off from INFO'))).toBe(true);
    // the analytics tag of the first failing assertion that carries one: the INFO check
    expect(evaluateLab(sim, lab).results.find((r) => r.task === 'server-list')?.misconception).toBe('standard-acl-near-source');
  }, LAB_TEST_TIMEOUT_MS);

  it('the server list bound inbound on R2 serial link also cuts the guests off from INFO', () => {
    const lab = ccna3AclStandard;
    const sim = labWorld(lab);
    typeOn(sim, 'R2', ['access-list 30 permit 192.168.10.0 0.0.0.255', 'interface Serial0/0/0', 'ip access-group 30 in', 'exit']);
    sim.runToIdle();
    const result = evaluateLab(sim, lab).results.find((r) => r.task === 'server-list')!;
    expect(result.pass).toBe(false);
    // W5 fix #7 inserted the INFO and staff-LAN probes at 3 and 4: the GUEST-to-INFO check moved from 5 to 7
    expect(result.assertions.filter((a) => !a.pass).map((a) => a.index)).toEqual([0, 7]);
    expect(result.misconception).toBe('standard-acl-near-source');
  }, LAB_TEST_TIMEOUT_MS);

  it('a vty list that admits the whole staff LAN lets PC2 log in: the grader clone sees it, and so does the live record', () => {
    const lab = ccna3AclStandard;
    const sim = labWorld(lab);
    typeOn(sim, 'R1', ['access-list 10 permit 192.168.10.0 0.0.0.255', 'line vty 0 4', 'access-class 10 in', 'exit']);
    sim.runToIdle();
    typeLogins(sim, ACL_STANDARD_LOGINS);
    const vty = evaluateLab(sim, lab).results.find((r) => r.task === 'vty-list')!;
    expect(vty.pass).toBe(false);
    const failing = vty.assertions.filter((a) => !a.pass).map((a) => a.index);
    // the pure decision for PC2, and — once the W5 service checker is in the tree — the clone's SSH login from PC2
    // (index 7 since W5 fix #4 inserted the GUEST, INFO and other-staff-host probes at 3, 4 and 5; GUEST and INFO are
    // outside the staff LAN, so those probes pass, while the other staff host 192.168.10.99 is admitted: index 5 fails)
    expect(failing.slice(0, 1)).toEqual([2]);
    if (!serviceStubbed(sim)) {
      expect(failing).toEqual([2, 5, 7]);
      expect(vty.assertions[7]!.detail).toContain('PC2');
    }
    // PC2 got in, so no refusal was recorded and nothing counted on a deny row of list 10
    expect(detailsOf(sim, lab, 'vty-logins')).toEqual([
      expect.stringContaining('vty-logins'),
      "The acl table of R1 has no row with list=10 action=deny lastIface=vty matches >= 1. List 10 has not yet refused a login on the remote lines.",
    ]);
  }, LAB_TEST_TIMEOUT_MS);

  it('a named list without the final permit locks everybody out of the staff LAN', () => {
    const lab = ccna3AclStandard;
    const sim = labWorld(lab);
    typeOn(sim, 'R1', ['ip access-list standard NO-GUESTS', 'deny 192.168.20.0 0.0.0.255', 'exit', 'interface GigabitEthernet0/0', 'ip access-group NO-GUESTS out', 'exit']);
    sim.runToIdle();
    const result = evaluateLab(sim, lab).results.find((r) => r.task === 'staff-list')!;
    expect(result.pass).toBe(false);
    expect(result.misconception).toBe('implicit-deny-forgotten');
    // W5 fix #8 inserted the second guest-LAN probe at 2: the SRV permit and INFO-to-PC2 checks moved to 3 and 5
    expect(result.assertions.filter((a) => !a.pass).map((a) => a.index)).toEqual([3, 5]);
  }, LAB_TEST_TIMEOUT_MS);

  it('the course-style vty list (a remark, the host, an explicit deny any) earns the live task: rows are read by action (W5 fix #3)', () => {
    const lab = ccna3AclStandard;
    const sim = labWorld(lab);
    const r1 = (lab.solution?.['R1'] ?? []).flatMap((l) =>
      l === `access-list ${ACL_STANDARD_VTY_LIST} permit host ${ACL_STANDARD_ADDRESSES.pc1}`
        ? [`access-list ${ACL_STANDARD_VTY_LIST} remark only the admin PC may log in`, l, `access-list ${ACL_STANDARD_VTY_LIST} deny any`]
        : [l],
    );
    expect(r1).toContain(`access-list ${ACL_STANDARD_VTY_LIST} deny any`);
    for (const [name, lines] of Object.entries({ ...lab.solution, R1: r1 })) typeOn(sim, name, lines);
    sim.runToIdle();
    typeLogins(sim, ACL_STANDARD_LOGINS);
    const rows = (sim.device(idOf(sim, 'R1'))!.tables.get<AclRow>('acl')?.rows() ?? []).filter((r) => r.list === '10').map((r) => [r.key, r.matches]);
    // the remark took 10: the permit is 20 and the explicit deny 30, which counted the refusal instead of the implicit deny
    expect(rows).toEqual([
      ['4|10|20', 1],
      ['4|10|30', 1],
      ['4|10|implicit', 0],
    ]);
    expect(failures(sim, lab).real).toEqual([]);
    expect(evaluateLab(sim, lab).score).toBe(100);
  }, LAB_TEST_TIMEOUT_MS);

  it("'deny PC2, permit any' on the vty lines fails the remote-line task (W5 fix #4)", () => {
    const lab = ccna3AclStandard;
    const sim = labWorld(lab);
    typeOn(sim, 'R1', ['access-list 10 deny host 192.168.10.11', 'access-list 10 permit any', 'line vty 0 4', 'access-class 10 in', 'exit']);
    sim.runToIdle();
    const vty = evaluateLab(sim, lab).results.find((r) => r.task === 'vty-list')!;
    expect(vty.pass).toBe(false);
    // GUEST, INFO and another staff host are all admitted (W5 integration: the INFO and 192.168.10.99 probes)
    expect(vty.assertions.filter((a) => !a.pass).map((a) => a.index)).toEqual([3, 4, 5]);
    expect(vty.misconception).toBe('deny-one-permit-the-rest');
  }, LAB_TEST_TIMEOUT_MS);

  it('a vty list that refuses only the hosts it names fails the remote-line task, however many it names (W5 integration, fix #4 recheck)', () => {
    const lab = ccna3AclStandard;
    for (const [entries, failing] of [
      // (a) the guest LAN's deny added: INFO and every other staff host still get in
      [['access-list 10 deny host 192.168.10.11', 'access-list 10 deny 192.168.20.0 0.0.0.255', 'access-list 10 permit any'], [4, 5]],
      // (b) the staff LAN permitted after PC2's deny: any other staff host still gets in
      [['access-list 10 deny host 192.168.10.11', 'access-list 10 permit 192.168.10.0 0.0.0.255'], [5]],
    ] as const) {
      const sim = labWorld(lab);
      typeOn(sim, 'R2', lab.solution?.['R2'] ?? []);
      typeOn(sim, 'R1', [...entries, ...(lab.solution?.['R1'] ?? []).filter((l) => !l.startsWith(`access-list ${ACL_STANDARD_VTY_LIST} `))]);
      sim.runToIdle();
      typeLogins(sim, ACL_STANDARD_LOGINS);
      const result = evaluateLab(sim, lab);
      const vty = result.results.find((r) => r.task === 'vty-list')!;
      expect(vty.pass, entries.join(' / ')).toBe(false);
      expect(vty.assertions.filter((a) => !a.pass).map((a) => a.index), entries.join(' / ')).toEqual(failing);
      expect(vty.misconception, entries.join(' / ')).toBe('deny-one-permit-the-rest');
      expect(result.score, entries.join(' / ')).toBeLessThan(100);
    }
  }, 2 * LAB_TEST_TIMEOUT_MS);

  it("'deny the guests, permit any' and a two-host server list both fail the server task (W5 fix #7)", () => {
    const lab = ccna3AclStandard;
    for (const [entries, failing] of [
      [['access-list 30 deny 192.168.20.0 0.0.0.255', 'access-list 30 permit any'], [3]],
      [['access-list 30 permit host 192.168.10.10', 'access-list 30 permit host 192.168.10.11'], [4]],
    ] as const) {
      const sim = labWorld(lab);
      typeOn(sim, 'R2', [...entries, 'interface GigabitEthernet0/0', 'ip access-group 30 out', 'exit']);
      sim.runToIdle();
      const result = evaluateLab(sim, lab).results.find((r) => r.task === 'server-list')!;
      expect(result.pass, entries.join(' / ')).toBe(false);
      expect(result.assertions.filter((a) => !a.pass).map((a) => a.index), entries.join(' / ')).toEqual(failing);
    }
  }, LAB_TEST_TIMEOUT_MS * 2);

  it('a staff list that denies the one guest host instead of the guest LAN fails the staff task (W5 fix #8)', () => {
    const lab = ccna3AclStandard;
    const sim = labWorld(lab);
    typeOn(sim, 'R1', ['ip access-list standard NO-GUESTS', 'deny host 192.168.20.10', 'permit any', 'exit', 'interface GigabitEthernet0/0', 'ip access-group NO-GUESTS out', 'exit']);
    sim.runToIdle();
    const result = evaluateLab(sim, lab).results.find((r) => r.task === 'staff-list')!;
    expect(result.pass).toBe(false);
    expect(result.assertions.filter((a) => !a.pass).map((a) => a.index)).toEqual([2]);
  }, LAB_TEST_TIMEOUT_MS);
});

describe('ccna3-acl-extended: other right answers and wrong answers', () => {
  it('the same lists in other words (a port number, a numbered server list, narrower entries) still earn full marks', () => {
    const lab = ccna3AclExtended;
    const sim = labWorld(lab);
    typeOn(sim, 'R1', [
      'ip access-list extended NO-WEB-PC1',
      'deny tcp host 192.168.10.10 host 192.168.20.100 eq 80',
      'permit ip any any',
      'exit',
      'interface GigabitEthernet0/0',
      'ip access-group NO-WEB-PC1 in',
      'exit',
      'ip access-list extended FROM-SERVERS',
      'permit tcp host 192.168.20.100 eq www 192.168.10.0 0.0.0.255 established',
      'permit icmp 192.168.20.0 0.0.0.255 192.168.10.0 0.0.0.255 echo-reply',
      'exit',
      'interface GigabitEthernet0/1',
      'ip access-group FROM-SERVERS in',
      'exit',
    ]);
    sim.runToIdle();
    expect(failures(sim, lab).real).toEqual([]);
    expect(evaluateLab(sim, lab).score).toBe(100);
  }, LAB_TEST_TIMEOUT_MS);

  it('PC1 blocked near the destination (outbound toward SRV) still loses the placement check', () => {
    const lab = ccna3AclExtended;
    const sim = labWorld(lab);
    typeOn(sim, 'R1', ['ip access-list extended NO-WEB-PC1', 'deny tcp host 192.168.10.10 host 192.168.20.100 eq www', 'permit ip any any', 'exit', 'interface GigabitEthernet0/1', 'ip access-group NO-WEB-PC1 out', 'exit']);
    sim.runToIdle();
    expect(taskPasses(sim, lab)['no-web-for-pc1']).toBe(false);
    // the list itself decides right, and PC1's web traffic dies at R1: only the placement is wrong
    expect(detailsOf(sim, lab, 'no-web-for-pc1')).toEqual(['R1 does not apply access list NO-WEB-PC1 to GigabitEthernet0/0 in.']);
  }, LAB_TEST_TIMEOUT_MS);

  it('permit icmp any any lets the server ping the desks: the echo task fails', () => {
    const lab = ccna3AclExtended;
    const sim = labWorld(lab);
    const solution = lab.solution!['R1']!.map((l) => (l === 'permit icmp any any echo-reply' ? 'permit icmp any any' : l));
    typeOn(sim, 'R1', solution);
    sim.runToIdle();
    const passes = taskPasses(sim, lab);
    expect(passes['no-web-for-pc1']).toBe(true);
    expect(passes['replies-only']).toBe(true);
    expect(passes['echo-replies']).toBe(false);
    expect(detailsOf(sim, lab, 'echo-replies')).toEqual([expect.stringMatching(/^PC1 .*SRV.* Permit the echo replies only: an echo request from SRV must be denied at R1\.$|^SRV /)]);
  }, LAB_TEST_TIMEOUT_MS);

  it('a server list that matches port 80 as the destination instead of established fails both ways', () => {
    const lab = ccna3AclExtended;
    const sim = labWorld(lab);
    const solution = lab.solution!['R1']!.map((l) => (l === 'permit tcp any any established' ? 'permit tcp any any eq www' : l));
    typeOn(sim, 'R1', solution);
    sim.runToIdle();
    const result = evaluateLab(sim, lab).results.find((r) => r.task === 'replies-only')!;
    expect(result.pass).toBe(false);
    // the answers of SRV (from port 80) are denied, so PC2 cannot browse; a connection SRV opens to port 80 is let in
    // (W5 fix #6 inserted the SYN-from-port-80 probe at 3, which this list denies: the connectivity checks are 4 and 5)
    expect(result.assertions.filter((a) => !a.pass).map((a) => a.index)).toEqual([1, 2, 4, 5]);
    expect(result.misconception).toBe('established-allows-new');
  }, LAB_TEST_TIMEOUT_MS);

  it('a deny without the port (every TCP service of SRV) fails the web task (W5 fix #5)', () => {
    const lab = ccna3AclExtended;
    const sim = labWorld(lab);
    const solution = lab.solution!['R1']!.map((l) => (l === 'deny tcp host 192.168.10.10 host 192.168.20.100 eq www' ? 'deny tcp host 192.168.10.10 host 192.168.20.100' : l));
    expect(solution).toContain('deny tcp host 192.168.10.10 host 192.168.20.100');
    typeOn(sim, 'R1', solution);
    sim.runToIdle();
    const result = evaluateLab(sim, lab).results.find((r) => r.task === 'no-web-for-pc1')!;
    expect(result.pass).toBe(false);
    expect(result.assertions.filter((a) => !a.pass).map((a) => a.index)).toEqual([3]);
    expect(result.assertions[3]!.detail).toContain('Name the port: only the web flow is denied.');
  }, LAB_TEST_TIMEOUT_MS);

  it('a server list that matches the source port 80 instead of established fails the replies task (W5 fix #6)', () => {
    const lab = ccna3AclExtended;
    const sim = labWorld(lab);
    const solution = lab.solution!['R1']!.map((l) => (l === 'permit tcp any any established' ? 'permit tcp any eq www any' : l));
    expect(solution).toContain('permit tcp any eq www any');
    typeOn(sim, 'R1', solution);
    sim.runToIdle();
    const result = evaluateLab(sim, lab).results.find((r) => r.task === 'replies-only')!;
    expect(result.pass).toBe(false);
    expect(result.assertions.filter((a) => !a.pass).map((a) => a.index)).toEqual([3]);
    expect(result.misconception).toBe('established-allows-new');
  }, LAB_TEST_TIMEOUT_MS);
});

describe('ccna3-acl-edit-verify: the hidden edit, and wrong answers', () => {
  it("grades no task before the colleague's edit lands, and the edit is what the instructions describe", () => {
    const lab = ccna3AclEditVerify;
    for (const at of [0, 30 * SEC, ACL_EDIT_FAULT_AT - SEC]) {
      const status = evaluateLab(labWorldAt(lab, at), lab);
      expect(status.score, `at ${at / SEC} s`).toBe(0);
      for (const r of status.results) {
        expect(r.assertions.filter((a) => a.detail !== undefined).map((a) => a.detail), `${r.task} at ${at / SEC} s`).toEqual([LAB_PREPARING_DETAIL]);
      }
    }
    const sim = labWorld(lab);
    const r1 = sim.device(idOf(sim, 'R1'))!;
    const show = sim.cli.open(idOf(sim, 'R1'), 'console');
    sim.cli.exec(show, 'enable');
    expect(sim.cli.exec(show, `show access-lists ${ACL_EDIT_LIST}`).output.split('\n')).toEqual([
      `Extended access list ${ACL_EDIT_LIST}`,
      '    10 permit tcp 192.168.10.0 0.0.0.255 host 192.168.20.100 eq www',
      '    20 permit icmp 192.168.10.0 0.0.0.7 192.168.20.0 0.0.0.255',
      '    30 deny tcp host 192.168.10.12 host 192.168.20.100 eq www',
    ]);
    // saved, so a reload keeps it
    expect(r1.startup?.render()).toContain(' permit icmp 192.168.10.0 0.0.0.7 192.168.20.0 0.0.0.255\n deny tcp host 192.168.10.12 host 192.168.20.100 eq www\n');
  }, LAB_TEST_TIMEOUT_MS);

  it('keeps the edit through a power cycle of R1', () => {
    const lab = ccna3AclEditVerify;
    const sim = labWorld(lab);
    sim.setPower(idOf(sim, 'R1'), false);
    sim.runFor(1 * SEC);
    sim.setPower(idOf(sim, 'R1'), true);
    sim.runFor(60 * SEC);
    sim.runToIdle();
    expect(evaluateLab(sim, lab).score).toBe(0);
  }, LAB_TEST_TIMEOUT_MS);

  it('the counters tell the story: the kiosk counts on entry 10, the desks pings on the implicit deny', () => {
    const lab = ccna3AclEditVerify;
    const sim = labWorld(lab);
    const r1 = sim.device(idOf(sim, 'R1'))!;
    const kiosk = sim.cli.open(idOf(sim, 'KIOSK'), 'console');
    sim.cli.exec(kiosk, 'telnet 192.168.20.100 80');
    sim.runFor(5 * SEC);
    const pc2 = sim.cli.open(idOf(sim, 'PC2'), 'console');
    sim.cli.exec(pc2, 'ping 192.168.20.100');
    sim.runFor(10 * SEC);
    sim.runToIdle();
    const counts = Object.fromEntries((r1.tables.get<AclRow>('acl')?.rows() ?? []).filter((r) => r.list === ACL_EDIT_LIST).map((r) => [r.seq ?? 'implicit', r.matches]));
    expect(counts[10]).toBeGreaterThan(0);
    expect(counts[20]).toBe(0);
    expect(counts[30]).toBe(0);
    expect(counts['implicit']).toBeGreaterThan(0);
  }, LAB_TEST_TIMEOUT_MS);

  it('a saved repair survives a reload in order, but renumbered from 10 (the warning of the instructions)', () => {
    const lab = ccna3AclEditVerify;
    const sim = labWorld(lab);
    solve(sim, lab);
    typeOn(sim, 'R1', ['do write memory']);
    sim.setPower(idOf(sim, 'R1'), false);
    sim.runFor(1 * SEC);
    sim.setPower(idOf(sim, 'R1'), true);
    sim.runFor(60 * SEC);
    sim.runToIdle();
    const passes = taskPasses(sim, lab);
    expect(passes['no-dead-entries']).toBe(true);
    expect(passes['remark']).toBe(true);
    expect(passes['log-kiosk']).toBe(true);
    expect(passes['kiosk-first']).toBe(false);
    expect(passes['ping-servers']).toBe(false);
    expect(detailsOf(sim, lab, 'kiosk-first')[0]).toBe(
      `Access list ${ACL_EDIT_LIST} on R1 denies a TCP segment from 192.168.10.12 port 49152 to 192.168.20.100 port 80 by entry 10 (deny tcp host 192.168.10.12 host 192.168.20.100 eq www log); expected entry 5 to decide it.`,
    );
  }, LAB_TEST_TIMEOUT_MS);

  it('the kiosk deny appended at the end never matches: the kiosk task fails, and its details say why', () => {
    const lab = ccna3AclEditVerify;
    const sim = labWorld(lab);
    typeOn(sim, 'R1', [`ip access-list extended ${ACL_EDIT_LIST}`, 'no 30', 'deny tcp host 192.168.10.12 host 192.168.20.100 eq www log', 'exit']);
    sim.runToIdle();
    const result = evaluateLab(sim, lab).results.find((r) => r.task === 'kiosk-first')!;
    expect(result.pass).toBe(false);
    expect(result.misconception).toBe('acl-order-ignored');
    expect(result.assertions.find((a) => a.index === 0)?.detail).toContain('permits a TCP segment from 192.168.10.12 port 49152 to 192.168.20.100 port 80 by entry 10');
    expect(taskPasses(sim, lab)['log-kiosk']).toBe(true);
  }, LAB_TEST_TIMEOUT_MS);

  it('entry 5 without log earns the kiosk task but not the log task', () => {
    const lab = ccna3AclEditVerify;
    const sim = labWorld(lab);
    // the dead entry goes first, as the instructions order it (its text is the same as the new entry's without log)
    typeOn(sim, 'R1', [`ip access-list extended ${ACL_EDIT_LIST}`, 'no 30', '5 deny tcp host 192.168.10.12 host 192.168.20.100 eq www', 'exit']);
    sim.runToIdle();
    const passes = taskPasses(sim, lab);
    expect(detailsOf(sim, lab, 'kiosk-first')).toEqual([]);
    expect(passes['kiosk-first']).toBe(true);
    expect(passes['log-kiosk']).toBe(false);
    expect(detailsOf(sim, lab, 'log-kiosk')).toEqual([`Access list ${ACL_EDIT_LIST} on R1 has no entry "deny tcp host 192.168.10.12 host 192.168.20.100 eq www log".`]);
  }, LAB_TEST_TIMEOUT_MS);

  it('a ping entry appended instead of replacing entry 20 lets the desks ping but fails the task and the tidy list', () => {
    const lab = ccna3AclEditVerify;
    const sim = labWorld(lab);
    typeOn(sim, 'R1', [`ip access-list extended ${ACL_EDIT_LIST}`, 'permit icmp 192.168.10.0 0.0.0.255 192.168.20.0 0.0.0.255', 'exit']);
    sim.runToIdle();
    const passes = taskPasses(sim, lab);
    expect(passes['ping-servers']).toBe(false);
    expect(passes['no-dead-entries']).toBe(false);
    const ping = evaluateLab(sim, lab).results.find((r) => r.task === 'ping-servers')!;
    // the ping itself works and counts on the appended entry (the same text), but entry 20 does not decide it
    expect(ping.assertions.filter((a) => !a.pass).map((a) => a.index)).toEqual([0, 1]);
    expect(ping.assertions[0]!.detail).toBe(
      `Access list ${ACL_EDIT_LIST} on R1 permits an ICMP echo request from 192.168.10.11 to 192.168.20.100 by entry 40 (permit icmp 192.168.10.0 0.0.0.255 192.168.20.0 0.0.0.255); expected entry 20 to decide it.`,
    );
    expect(ping.misconception).toBeUndefined();
  }, LAB_TEST_TIMEOUT_MS);

  it('deleting the list and typing it again in the right order also repairs it (the binding stays)', () => {
    const lab = ccna3AclEditVerify;
    const sim = labWorld(lab);
    typeOn(sim, 'R1', [
      `no ip access-list extended ${ACL_EDIT_LIST}`,
      `ip access-list extended ${ACL_EDIT_LIST}`,
      'remark staff reach the servers; the kiosk may not browse',
      'deny tcp host 192.168.10.12 host 192.168.20.100 eq www log',
      'permit tcp 192.168.10.0 0.0.0.255 host 192.168.20.100 eq www',
      'permit icmp 192.168.10.0 0.0.0.255 192.168.20.0 0.0.0.255',
      'exit',
    ]);
    sim.runToIdle();
    // retyped, the entries are numbered 20, 30 and 40 (the remark took 10): the sequence tasks name 5 and 20
    const passes = taskPasses(sim, lab);
    expect(passes['remark']).toBe(true);
    expect(passes['log-kiosk']).toBe(true);
    expect(passes['no-dead-entries']).toBe(true);
    expect(passes['kiosk-first']).toBe(false);
    expect(passes['ping-servers']).toBe(false);
  }, LAB_TEST_TIMEOUT_MS);
});
