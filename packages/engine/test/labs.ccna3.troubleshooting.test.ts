/**
 * P3 W5 course: the CCNA 3 enterprise fault-finding lab, lab 34 `ccna3-troubleshoot-enterprise` (lesson 34;
 * ARCHITECTURE-P3 §7 W5, §11.1, §11.2, §2.10; sim/scenarios/ccna3/troubleshooting.ts) — a local copy of the checks of
 * `labs.ccna3.solutions.test.ts` (owned by sim), filtered to this lab, plus the lab's own proofs.
 *
 *   • metadata: category `ccna3-lab`, course `CCNA 3`, `topic` = the title of the module that holds lesson 34 in
 *     curriculum/ccna3/lessons.ts ("Designing and fixing"), the name §11.1 freezes, a fixed seed, §11.2's OSPF timing
 *     sentence, structured-clone safe `scenarioMeta`, `requires` = exactly the catalog types the topology uses, tasks
 *     with unique ids, real points and existing dependencies, a solution for devices the topology has, and four hidden
 *     faults scheduled through the kit's `configFragmentFault`, each aimed at a device of the topology after the
 *     routers have booted;
 *   • its world: a P3-profile topology whose schema is `schemaIdFor(t)` (1.3), loaded as a P3 world;
 *   • UNSOLVED (faults injected the way the worker does, booted and settled): EVERY task fails, each on a failing
 *     assertion that says why;
 *   • SOLVED: `configure` accepts every line of the reference solution as written, the world runs to idle, and every
 *     task passes — full marks;
 *   • grading is read-only (same clock, trace head and PDU count) and repeatable (two evaluations are equal).
 *
 * The lab's own proofs: nothing is graded before the last hidden fault lands, and the unsolved lab earns nothing
 * after; a power cycle of both routers keeps every fault; each repair alone earns exactly its own task — the ACL task
 * included, whose traffic checks run in a clone where the grader repairs the routing fault with `LabFault config`;
 * and the wrong answers score what they should: static routes instead of the adjacency, the branch list unbound or
 * stripped of its deny, a host entry in the NAT list, the right time server added beside the wrong one, and a clock
 * set by hand. The W5 fixes add: the NAT repair typed the usual way (appended) earns its task while a leftover wrong
 * line or a `permit any` does not (#22); the number the hidden remark holds is refused, not stored as nothing (#23);
 * and after the time fault neither R2's clock commands nor the grade point to a clock set by hand (#24).
 */
import { describe, expect, it } from 'vitest';
import { MSG_ACL_SEQ_REMARK } from '../src/cli/handlers/acl.js';
import type { DeviceId } from '../src/contracts/ids.js';
import type { ScenarioInfo } from '../src/contracts/scenario.js';
import { scenarioMeta } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID_1_3, schemaIdFor, type Topology } from '../src/contracts/topology.js';
import { CCNA3_MODULES } from '../src/curriculum/ccna3/lessons.js';
import { createCatalog } from '../src/device/catalog/index.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import { LAB_PREPARING_DETAIL, evaluateLab } from '../src/sim/lab-checks.js';
import {
  CCNA3_TROUBLESHOOTING_LABS,
  ENTERPRISE_EXT,
  ENTERPRISE_SERVER,
  ENTERPRISE_WRONG_NTP,
  ccna3TroubleshootEnterprise,
} from '../src/sim/scenarios/ccna3/troubleshooting.js';
import { createSimulation } from '../src/sim/simulation.js';

/** Long enough for every model of the lab to boot (a router takes 45 s) and for the hidden faults (50–53 s) to land. */
const BOOT_NS = 90 * SEC;

/** Wall-clock budget of one world test: a lab world plus one grading clone per fault set it names. */
const LAB_TEST_TIMEOUT_MS = 90_000;

const lab = ccna3TroubleshootEnterprise;
const catalog = createCatalog(PROCESS_FACTORIES);

/** The lessons of the skeleton, with the title of the module that holds each. */
const LESSONS = CCNA3_MODULES.flatMap((m) => m.lessons.map((l) => ({ lesson: l, module: m.title })));

/** Every task id of the lab, in order. */
const TASKS = ['routing', 'branch-policy', 'translation', 'time', 'end-to-end'];

/** The pass map of `TASKS` with exactly `passing` passing. */
const only = (...passing: string[]): Record<string, boolean> => Object.fromEntries(TASKS.map((t) => [t, passing.includes(t)]));

/** The repair of each fault, as the learner types it (the reference solution, one fault at a time). */
const REPAIR = {
  routing: { R2: ['router ospf 1', 'no passive-interface Serial0/0/0', 'exit'] },
  'branch-policy': { R2: ['ip access-list extended BRANCH-POLICY', 'no 35', `20 permit tcp 192.168.20.0 0.0.0.255 host ${ENTERPRISE_SERVER} eq www`, 'exit'] },
  translation: { R1: ['ip access-list standard NAT-LANS', 'no 10', '10 permit 192.168.10.0 0.0.0.255', 'exit'] },
  time: { R2: [`no ntp server ${ENTERPRISE_WRONG_NTP}`, 'ntp server 10.0.12.1'] },
} as const satisfies Record<string, Readonly<Record<string, readonly string[]>>>;

/** The lab world at `at`, as the worker holds it before a check at that instant (loaded, faults injected, not settled). */
function labWorldAt(at: number): Simulation {
  const sim = createSimulation({ seed: lab.seed ?? 1 });
  const topo: Topology = { ...lab.build(), lab: { name: lab.name, version: lab.version ?? 1 } };
  sim.loadTopology(topo);
  // the worker injects a lab's scheduled faults right after the load (apps/web bridge/worker applyFaults)
  for (const f of lab.faults ?? []) sim.injectFault(f.at, f.fault);
  if (at > 0) sim.runFor(at);
  return sim;
}

/** The lab's world as `loadScenario` builds it: booted, the hidden faults landed, settled. */
function labWorld(): Simulation {
  const sim = labWorldAt(BOOT_NS);
  sim.runToIdle();
  return sim;
}

/** Device id of a topology name. */
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

/** Type every device's lines of `by`, then settle. */
function typeAll(sim: Simulation, by: Readonly<Record<string, readonly string[]>>): void {
  for (const [name, lines] of Object.entries(by)) typeOn(sim, name, lines);
  sim.runToIdle();
}

/** Tasks that did not pass, each with the details of its failing assertions. */
function failures(sim: Simulation, graded: ScenarioInfo = lab): string[] {
  return evaluateLab(sim, graded)
    .results.filter((r) => !r.pass)
    .map((r) => `${r.task}: ${r.assertions.filter((a) => !a.pass).map((a) => a.detail ?? '(no detail)').join(' | ')}`);
}

/** Pass flag of each task, by id. */
function taskPasses(sim: Simulation): Record<string, boolean> {
  return Object.fromEntries(evaluateLab(sim, lab).results.map((r) => [r.task, r.pass]));
}

/** The lab with only the task `id` (a wrong answer is graded on the task it is about; the clones stay few). */
function taskOnly(id: string): ScenarioInfo {
  return { ...lab, tasks: (lab.tasks ?? []).filter((t) => t.id === id) };
}

/** The result of the one task `id`. */
function resultOf(sim: Simulation, id: string) {
  const r = evaluateLab(sim, taskOnly(id)).results[0];
  if (r === undefined) throw new Error(`no task ${id}`);
  return r;
}

/** The details of the failing assertions of task `id`. */
const failingDetails = (sim: Simulation, id: string): string[] => resultOf(sim, id).assertions.filter((a) => !a.pass).map((a) => a.detail ?? '(no detail)');

describe('CCNA3 troubleshooting lab: the file', () => {
  it('exports lab 34 alone under the fixed name, the lab of lesson 34', () => {
    expect(CCNA3_TROUBLESHOOTING_LABS).toEqual([ccna3TroubleshootEnterprise]);
    expect(lab.name).toBe('ccna3-troubleshoot-enterprise');
    expect(LESSONS.filter((l) => l.lesson.lab === lab.name).map((l) => l.lesson.id)).toEqual(['ccna3-34-finding-faults-across-layers']);
    expect((lab.tasks ?? []).map((t) => t.id)).toEqual(TASKS);
  });
});

describe(`CCNA3 lab: ${lab.name}`, () => {
  it('describes itself with structured-clone safe metadata, its module as topic and a catalog it really uses', () => {
    expect(lab.category).toBe('ccna3-lab');
    expect(lab.course).toBe('CCNA 3');
    expect(lab.labType).toBe('troubleshoot');
    const home = LESSONS.find((l) => l.lesson.lab === lab.name);
    expect(lab.topic).toBe(home?.module);
    expect(lab.topic).toBe('Designing and fixing');
    expect(lab.seed).toBeTypeOf('number');
    expect((lab.objectives ?? []).length).toBeGreaterThan(0);
    // §11.2: OSPF on point-to-point links installs its routes about 15 s after link-up, "about a minute" with the boot
    expect(lab.instructions).toContain('about 45 s to boot');
    expect(lab.instructions).toContain('about a minute');
    expect(lab.instructions).toContain('15 s');

    const meta = scenarioMeta(lab);
    expect(structuredClone(meta)).toEqual(meta);
    expect(meta).not.toHaveProperty('build');
    expect(meta).not.toHaveProperty('solution');
    expect(meta).not.toHaveProperty('faults');
    for (const task of meta.tasks ?? []) expect(task).not.toHaveProperty('assertions');

    const topo = lab.build();
    expect([...(lab.requires ?? [])].sort()).toEqual([...new Set(topo.devices.map((d) => d.type))].sort());
    for (const type of lab.requires ?? []) expect(catalog.get(type), type).toBeDefined();
    const ids = (lab.tasks ?? []).map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect((lab.tasks ?? []).reduce((n, t) => n + t.points, 0)).toBe(100);
    for (const task of lab.tasks ?? []) {
      expect(task.points).toBeGreaterThan(0);
      expect(task.assertions.length).toBeGreaterThan(0);
      for (const dep of task.dependsOn ?? []) expect(ids).toContain(dep);
    }
    const names = topo.devices.map((d) => d.name);
    for (const name of Object.keys(lab.solution ?? {})) expect(names).toContain(name);
    // four hidden configuration changes, one per instant, each after every router has booted (45 s), saved
    const deviceIds = topo.devices.map((d) => d.id);
    expect((lab.faults ?? []).map((f) => f.fault.kind)).toEqual(['config-fragment', 'config-fragment', 'config-fragment', 'config-fragment']);
    expect(new Set((lab.faults ?? []).map((f) => f.fault.id)).size).toBe(4);
    for (const { at, fault } of lab.faults ?? []) {
      expect(at).toBeGreaterThan(45 * SEC);
      expect(deviceIds, fault.id).toContain(fault.target.device);
      expect((fault.params?.lines as readonly string[] | undefined)?.at(-1), fault.id).toBe('do write memory');
    }
    // the switches carry hosts and one router each: every port in use is an edge port (§11.2)
    for (const sw of topo.devices.filter((d) => d.name.startsWith('SW'))) {
      const used = topo.links.flatMap((l) => [l.a, l.b]).filter((e) => e.device === sw.id).map((e) => e.port);
      for (const port of used) expect(sw.config ?? '', `${sw.name} ${port}`).toMatch(new RegExp(`interface ${port.replace('/', '\\/')}\\n switchport mode access\\n spanning-tree portfast\\n`));
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
  });

  it('fails every task before the student starts, and says why', () => {
    const sim = labWorld();
    const status = evaluateLab(sim, lab);
    expect(status.total).toBe(100);
    expect(status.score).toBe(0);
    for (const r of status.results) {
      expect(r.pass, r.task).toBe(false);
      expect(r.assertions.some((a) => !a.pass && (a.detail ?? '') !== '' && a.detail !== LAB_PREPARING_DETAIL), r.task).toBe(true);
    }
  }, LAB_TEST_TIMEOUT_MS);

  it('scores full marks once the reference solution is applied as written', () => {
    const sim = labWorld();
    typeAll(sim, lab.solution ?? {});
    expect(failures(sim), `${lab.name} solved`).toEqual([]);
    expect(evaluateLab(sim, lab).score).toBe(100);
  }, LAB_TEST_TIMEOUT_MS);

  it('grades without touching the live simulation, and the same way twice', () => {
    const sim = labWorld();
    typeAll(sim, lab.solution ?? {});
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

describe(`CCNA3 lab ${lab.name}: the hidden faults`, () => {
  it('grades no task before the last hidden fault has landed', () => {
    const last = Math.max(...(lab.faults ?? []).map((f) => f.at));
    expect(last).toBe(53 * SEC);
    for (const at of [0, 35 * SEC, 52 * SEC]) {
      const status = evaluateLab(labWorldAt(at), lab);
      expect(status.score, `at ${at / SEC} s`).toBe(0);
      for (const r of status.results) {
        expect(r.pass).toBe(false);
        expect(r.assertions.filter((a) => a.detail !== undefined).map((a) => a.detail), r.task).toEqual([LAB_PREPARING_DETAIL]);
      }
    }
  }, LAB_TEST_TIMEOUT_MS);

  it('keeps the hidden changes through a power cycle of both routers', () => {
    const sim = labWorld();
    for (const name of ['R1', 'R2']) sim.setPower(idOf(sim, name), false);
    sim.runFor(1 * SEC);
    for (const name of ['R1', 'R2']) sim.setPower(idOf(sim, name), true);
    sim.runFor(120 * SEC);
    sim.runToIdle();
    expect(taskPasses(sim)).toEqual(only());
    // the saved configurations carry the changes
    const r1 = sim.device(idOf(sim, 'R1'))!.startup?.render() ?? '';
    const r2 = sim.device(idOf(sim, 'R2'))!.startup?.render() ?? '';
    expect(r2).toContain('passive-interface Serial0/0/0');
    expect(r2).toContain(`ntp server ${ENTERPRISE_WRONG_NTP}`);
    expect(r1).toContain('permit 192.168.1.0 0.0.0.255');
  }, LAB_TEST_TIMEOUT_MS);

  for (const [task, by] of Object.entries(REPAIR)) {
    it(`repairing the ${task} fault alone earns exactly its own task`, () => {
      const sim = labWorld();
      typeAll(sim, by);
      expect(taskPasses(sim)).toEqual(only(task));
    }, LAB_TEST_TIMEOUT_MS);
  }

  it('the four repairs in any order give full marks (time first, routing last)', () => {
    const sim = labWorld();
    for (const task of ['time', 'translation', 'branch-policy', 'routing'] as const) typeAll(sim, REPAIR[task]);
    expect(failures(sim)).toEqual([]);
  }, LAB_TEST_TIMEOUT_MS);
});

describe(`CCNA3 lab ${lab.name}: wrong answers`, () => {
  it('static routes in place of the adjacency do not repair the routing fault', () => {
    const sim = labWorld();
    typeAll(sim, { R2: ['ip route 0.0.0.0 0.0.0.0 10.0.12.1'], R1: ['ip route 192.168.20.0 255.255.255.0 10.0.12.2'] });
    const r = resultOf(sim, 'routing');
    expect(r.pass).toBe(false);
    expect(r.misconception).toBe('ospf-passive-wan');
    expect(r.assertions.map((a) => a.pass)).toEqual([false, false, false, true, false, false, true]);
  }, LAB_TEST_TIMEOUT_MS);

  it('unbinding the branch list, or deleting its deny, is not the designed policy', () => {
    // the order repaired, then the list unbound: its decisions are right, but nothing filters the branch any more
    const sim = labWorld();
    typeAll(sim, REPAIR.routing);
    typeAll(sim, REPAIR['branch-policy']);
    typeAll(sim, { R2: ['interface GigabitEthernet0/0', 'no ip access-group BRANCH-POLICY in', 'exit'] });
    const unbound = resultOf(sim, 'branch-policy');
    expect(unbound.assertions.map((a) => a.pass)).toEqual([false, true, true, true, false]);
    expect(failingDetails(sim, 'branch-policy')[0]).toContain('BRANCH-POLICY');

    const other = labWorld();
    typeAll(other, { ...REPAIR.routing });
    typeAll(other, { R2: ['ip access-list extended BRANCH-POLICY', 'no 30', 'exit'] });
    const r = resultOf(other, 'branch-policy');
    expect(r.pass).toBe(false);
    expect(r.misconception).toBe('acl-order');
    // the web entry decides now, but a ping to the server is no longer dropped at R2
    expect(r.assertions.map((a) => a.pass)).toEqual([false, true, false, true, false]);
  }, 2 * LAB_TEST_TIMEOUT_MS);

  it('the number the hidden remark holds is refused, never accepted silently; another number repairs the list (W5 fix #23)', () => {
    const sim = labWorld();
    const web = `permit tcp 192.168.20.0 0.0.0.255 host ${ENTERPRISE_SERVER} eq www`;
    // the remark of BRANCH-POLICY holds 10 and no show command prints it: `10 permit …` used to store nothing
    const r = sim.configure(idOf(sim, 'R2'), ['ip access-list extended BRANCH-POLICY', 'no 35', `10 ${web}`], { stopOnError: false });
    expect(r.lines.map((l) => (l.ok ? 'ok' : l.error?.message))).toEqual(['ok', 'ok', MSG_ACL_SEQ_REMARK('10')]);
    sim.runToIdle();
    typeAll(sim, { R2: ['ip access-list extended BRANCH-POLICY', `20 ${web}`, 'exit'] });
    expect(resultOf(sim, 'branch-policy').pass).toBe(true);
  }, LAB_TEST_TIMEOUT_MS);

  it('a host entry in the NAT list lets PC1 out but does not repair the list', () => {
    const sim = labWorld();
    typeAll(sim, { R1: ['ip access-list standard NAT-LANS', 'no 10', '10 permit host 192.168.10.11', 'exit'] });
    const r = resultOf(sim, 'translation');
    // W5 fix #22 added the deny decision for the wrong network at index 1 (the host entry does not match it)
    expect(r.assertions.map((a) => a.pass)).toEqual([false, true, true]);
  }, LAB_TEST_TIMEOUT_MS);

  it('the repair typed the usual way (no 10, then the permit appended as 30) earns the translation task (W5 fix #22)', () => {
    for (const repair of [
      ['ip access-list standard NAT-LANS', 'no 10', 'permit 192.168.10.0 0.0.0.255', 'exit'],
      ['ip access-list standard NAT-LANS', 'no permit 192.168.1.0 0.0.0.255', 'permit 192.168.10.0 0.0.0.255', 'exit'],
    ]) {
      const sim = labWorld();
      typeAll(sim, { R1: repair });
      const r = resultOf(sim, 'translation');
      expect(r.assertions.map((a) => a.pass), repair.join(' / ')).toEqual([true, true, true]);
      expect(r.pass, repair.join(' / ')).toBe(true);
    }
  }, LAB_TEST_TIMEOUT_MS * 2);

  it('the right entry added beside the wrong one, or a permit any, still fails the translation task (W5 fix #22)', () => {
    for (const [lines, flags] of [
      [['ip access-list standard NAT-LANS', '15 permit 192.168.10.0 0.0.0.255', 'exit'], [true, false, true]],
      [['ip access-list standard NAT-LANS', 'no 10', '10 permit any', 'exit'], [false, false, true]],
    ] as const) {
      const sim = labWorld();
      typeAll(sim, { R1: lines });
      const r = resultOf(sim, 'translation');
      expect(r.assertions.map((a) => a.pass), lines.join(' / ')).toEqual(flags);
    }
  }, LAB_TEST_TIMEOUT_MS * 2);

  it('the right time server beside the wrong one synchronises R2 but leaves the wrong one asked', () => {
    const sim = labWorld();
    typeAll(sim, { R2: ['ntp server 10.0.12.1'] });
    const r = resultOf(sim, 'time');
    expect(r.assertions.map((a) => a.pass)).toEqual([true, true, true, true, false]);
    expect(failingDetails(sim, 'time')).toEqual([`The ntp-peers table of R2 still has a row with address=${ENTERPRISE_WRONG_NTP}. R2 still asks ${ENTERPRISE_WRONG_NTP} for the time.`]);
  }, LAB_TEST_TIMEOUT_MS);

  it('a clock set by hand is not a synchronised clock', () => {
    const sim = labWorld();
    typeAll(sim, { R2: [`no ntp server ${ENTERPRISE_WRONG_NTP}`] });
    const s = sim.cli.open(idOf(sim, 'R2'), 'console');
    sim.cli.exec(s, 'enable');
    expect(sim.cli.exec(s, 'clock set 09:00:00 6 Jan 2025').error).toBeUndefined();
    sim.cli.close(s);
    sim.runToIdle();
    const r = resultOf(sim, 'time');
    expect(r.pass).toBe(false);
    expect(r.assertions.map((a) => a.pass)).toEqual([false, false, false, false, true]);
  }, LAB_TEST_TIMEOUT_MS);

  it('after the time fault nothing on R2 or in the grade points to a clock set by hand (W5 fix #24)', () => {
    // R2 synchronised to R1 before the fault; removing its server keeps the value with source 'user', no `clock set`
    const sim = labWorld();
    const s = sim.cli.open(idOf(sim, 'R2'), 'console');
    sim.cli.exec(s, 'enable');
    const detail = sim.cli.exec(s, 'show clock detail').output;
    const status = sim.cli.exec(s, 'show ntp status').output;
    sim.cli.close(s);
    for (const text of [detail, status]) {
      expect(text).toContain("this device's own clock");
      expect(text).toContain('kept after its time server was removed');
      expect(text).not.toContain('(clock set)');
    }
    const source = resultOf(sim, 'time').assertions[3];
    expect(source?.pass).toBe(false);
    expect(source?.detail).toContain('R2 runs on its own clock and follows no time server');
  }, LAB_TEST_TIMEOUT_MS);

  it('the provider knows no private network: PC1 reaches EXT only through the translation', () => {
    const sim = labWorld();
    const isp = sim.device(idOf(sim, 'ISP'))!.tables.rib.rows().map((r) => r.key);
    expect(isp.some((k) => k.startsWith('192.168.') || k.startsWith('10.'))).toBe(false);
    expect(ENTERPRISE_EXT).toBe('198.51.100.10');
  }, LAB_TEST_TIMEOUT_MS);
});
