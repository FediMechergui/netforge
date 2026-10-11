/**
 * P3 W5 qos: the CCNA 3 quality-of-service lab (ARCHITECTURE-P3 §7 W5, §11.1, §11.2, §2.10, §3.5, §3.11; ruling R44;
 * sim/scenarios/ccna3/qos.ts) — a local copy of the checks of `labs.ccna3.solutions.test.ts` (owned by sim), filtered
 * to lab 27 `ccna3-qos-voice-first` ([S20] LLQ and [S21] policing tasks), plus the lab's own proofs.
 *
 *   • metadata: category `ccna3-lab`, course `CCNA 3`, `topic` = the title of the module that holds lesson 27 in
 *     curriculum/ccna3/lessons.ts, the name §11.1 freezes, a fixed seed, the §11.2 timing sentence, original wording,
 *     structured-clone safe `scenarioMeta`, `requires` = exactly the catalog types the topology uses, tasks with unique
 *     ids, real points and existing dependencies, a solution for devices the topology has;
 *   • its world: a P3-profile topology whose schema is `schemaIdFor(t)` (1.3), loaded as a P3 world, with PortFast on
 *     every switch port that faces a host or the router (§11.2);
 *   • UNSOLVED (booted and settled): EVERY task fails, each on a failing assertion that says why, while the network
 *     already carries a ping from PC-D to PC-S (the lab is about QoS, not reachability);
 *   • SOLVED: `configure` accepts every line of the reference solution as written, the world runs to idle, and every
 *     task — the two `traffic` checks in the grader's clone included (R44: continuous flows under `runFor`) — passes;
 *   • grading is read-only (same clock, trace head and PDU count) and repeatable (two evaluations are equal), checked on
 *     the solved world.
 *
 * Wrong answers, each graded by the real checkers: marking alone on the FIFO line (the voice waits seconds); a
 * priority queue without the marking (only the clone's flows can tell: every configuration check of the task passes,
 * and the unmarked voice is lost and late in class-default); LLQ without the policer (the bulk data waits seconds);
 * a policer that drops even conforming packets (it drops the desks’ ARP too, so the whole LAN is cut off); CS6 instead of EF; the marking policy attached
 * outbound; a marking list that matches the bulk data too; (W5 fixes #16-#18) an extra match line that keeps VOIP from
 * ever matching (the learner's burst, `QOS_LEARNER_FLOWS`, arrives unmarked), marking lists wider than the voice ports
 * (`gt 16383`, `range 1024 65535`, `range 16384 32768`), and CS6 with the burst sent again (the live row shows 48,
 * failing the marking and the priority task). A right answer typed in other forms (`class-map VOIP`, `set
 * dscp 46`, `match dscp 46`, `police 64000` with its default actions) still earns full marks.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../src/contracts/ids.js';
import type { LabAssertion, LabStatus, ScenarioInfo } from '../src/contracts/scenario.js';
import { scenarioMeta } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { FlowRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID_1_3, schemaIdFor, type Topology } from '../src/contracts/topology.js';
import { CCNA3_MODULES } from '../src/curriculum/ccna3/lessons.js';
import { createCatalog } from '../src/device/catalog/index.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { createSimulation } from '../src/sim/simulation.js';
import {
  CCNA3_QOS_LABS,
  QOS_LAB_BULK_MAX_DELAY_MS,
  QOS_LAB_POLICE_BPS,
  QOS_LAB_VOICE_PORT_FIRST,
  QOS_LAB_VOICE_PORT_LAST,
  QOS_LEARNER_FLOWS,
  QOS_LAB_PRIORITY_KBPS,
  QOS_LAB_TRAFFIC_RUN_MS,
  QOS_LAB_VOICE_MAX_DELAY_MS,
  ccna3QosVoiceFirst as lab,
} from '../src/sim/scenarios/ccna3/qos.js';

/** Long enough for every model of the lab to boot (the routers take 45 s); `runToIdle` then settles the rest. */
const BOOT_NS = 90 * SEC;

/** Wall-clock budget of one world test: the lab world plus its grading clone (two 10 s flow runs and their drains). */
const LAB_TEST_TIMEOUT_MS = 120_000;

const catalog = createCatalog(PROCESS_FACTORIES);

/** The lessons of the skeleton, with the title of the module that holds each. */
const LESSONS = CCNA3_MODULES.flatMap((m) => m.lessons.map((l) => ({ lesson: l, module: m.title })));

/** The name §11.1 freezes for this file. */
const QOS_NAMES = ['ccna3-qos-voice-first'];

/** The detail of a voice flow that reached PC-S later than the LLQ task allows. */
const VOICE_LATE = new RegExp(`flow voice from PC-V took up to (\\d+(?:\\.\\d)?) ms to reach PC-S, more than ${QOS_LAB_VOICE_MAX_DELAY_MS} ms`, 'i');

/** The lab's world as `loadScenario` builds it: the lab seed, the lab topology, booted and settled. */
function labWorld(): Simulation {
  const sim = createSimulation({ seed: lab.seed ?? 1 });
  sim.loadTopology({ ...lab.build(), lab: { name: lab.name, version: lab.version ?? 1 } });
  for (const f of lab.faults ?? []) sim.injectFault(f.at, f.fault);
  sim.runFor(BOOT_NS);
  expect(sim.runToIdle().stopped).toBeUndefined();
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

/** Apply `solution` (default: the lab's reference solution) as written, then settle (which must return). */
function applySolution(sim: Simulation, solution: Readonly<Record<string, readonly string[]>> = lab.solution ?? {}): void {
  for (const [name, lines] of Object.entries(solution)) typeOn(sim, name, lines, `${lab.name} solution for ${name}`);
  expect(sim.runToIdle().stopped).toBeUndefined();
}

/** The learner's voice burst of step 2 (`QOS_LEARNER_FLOWS`) typed on PC-V's console, then settled (a bounded flow ends). */
function sendVoiceBurst(sim: Simulation): void {
  for (const f of QOS_LEARNER_FLOWS) {
    const s = sim.cli.open(idOf(sim, f.from), 'console');
    for (const line of f.lines) {
      expect(sim.cli.exec(s, line).error, line).toBeUndefined();
      sim.runFor(5 * SEC);
    }
    sim.cli.close(s);
  }
  expect(sim.runToIdle().stopped).toBeUndefined();
}

/** The catalog types a topology actually uses. */
function typesOf(topo: Topology): string[] {
  return [...new Set(topo.devices.map((d) => d.type))].sort();
}

/** Every failing assertion of a status: `task#index: detail`. */
function failing(status: LabStatus): string[] {
  return status.results.flatMap((r) => r.assertions.filter((a) => !a.pass).map((a) => `${r.task}#${a.index}: ${a.detail ?? '(no detail)'}`));
}

/** Pass flag of each task, by id. */
function taskPasses(status: LabStatus): Record<string, boolean> {
  return Object.fromEntries(status.results.map((r) => [r.task, r.pass]));
}

/** The result of assertion `index` of task `task`. */
function resultOf(status: LabStatus, task: string, index: number): { pass: boolean; detail?: string } {
  const r = status.results.find((t) => t.task === task)?.assertions.find((a) => a.index === index);
  if (r === undefined) throw new Error(`no assertion ${task}#${index}`);
  return r;
}

/** The index of the first assertion of `kind` in task `task`. */
function indexOf(task: string, kind: LabAssertion['kind']): number {
  const i = lab.tasks?.find((t) => t.id === task)?.assertions.findIndex((a) => a.kind === kind) ?? -1;
  if (i < 0) throw new Error(`task ${task} has no ${kind} assertion`);
  return i;
}

/** The reference solution's R1 lines with `edit` applied (each pair replaces one exact line; a `null` drops it). */
function r1Solution(edit: ReadonlyMap<string, string | readonly string[] | null>): Record<string, readonly string[]> {
  const out: string[] = [];
  for (const line of lab.solution?.['R1'] ?? []) {
    if (!edit.has(line)) {
      out.push(line);
      continue;
    }
    const to = edit.get(line);
    if (to === null || to === undefined) continue;
    if (typeof to === 'string') out.push(to);
    else out.push(...to);
  }
  return { R1: out };
}

/** The slice of the reference solution's R1 lines from `first` (inclusive) to `last` (exclusive; undefined = the end). */
function r1Lines(first: string, last?: string): string[] {
  const lines = lab.solution?.['R1'] ?? [];
  const a = lines.indexOf(first);
  const b = last === undefined ? lines.length : lines.indexOf(last);
  expect(a, first).toBeGreaterThanOrEqual(0);
  expect(b, last).toBeGreaterThan(a);
  return lines.slice(a, b);
}

/** The marking part of the solution, without the policer (task 1 alone). */
function markingOnly(): string[] {
  const out = r1Lines('ip access-list extended VOICE-PORTS', 'class-map match-all VOICE');
  const i = out.indexOf('class class-default');
  expect(i).toBeGreaterThan(0);
  out.splice(i, 3); // class class-default / police … / exit
  return out;
}

/** The LLQ part of the solution (task 2 alone). */
function llqOnly(): string[] {
  return r1Lines('class-map match-all VOICE');
}

describe('CCNA3 lab file: qos.ts', () => {
  it('exports exactly the lab of lesson 27, under the name §11.1 freezes', () => {
    expect(CCNA3_QOS_LABS.map((l) => l.name)).toEqual(QOS_NAMES);
    expect(CCNA3_QOS_LABS).toEqual([lab]);
  });

  it('imports only the contracts, the kit and the templates (no cycle through the catalogue, rule 12)', () => {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sim', 'scenarios', 'ccna3', 'qos.ts');
    const text = readFileSync(file, 'utf8');
    const imports = [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');
    expect(imports.length).toBeGreaterThan(0);
    for (const m of imports) expect(m, `qos.ts imports ${m}`).toMatch(/^\.\.\/\.\.\/\.\.\/contracts\/[a-z0-9-]+\.js$|^\.\.\/kit\.js$|^\.\.\/templates\.js$/);
  });
});

describe(`CCNA3 lab: ${lab.name}`, () => {
  it('describes itself with structured-clone safe metadata, its module as topic and a catalog it really uses', () => {
    expect(lab.category).toBe('ccna3-lab');
    expect(lab.course).toBe('CCNA 3');
    expect(lab.name).toMatch(/^ccna3(-[a-z0-9]+)+$/);
    const home = LESSONS.find((l) => l.lesson.lab === lab.name);
    expect(home, `${lab.name} is the lab of a lesson`).toBeDefined();
    expect(home?.lesson.id).toBe('ccna3-27-marking-queuing-and-policing');
    expect(lab.topic).toBe(home?.module);
    expect(lab.topic).toBe('Quality of service');
    expect(lab.labType).toBeDefined();
    expect(lab.seed).toBeTypeOf('number');
    expect(lab.build().seed).toBe(lab.seed);
    expect((lab.objectives ?? []).length).toBeGreaterThan(0);
    expect((lab.tasks ?? []).length).toBeGreaterThan(0);
    expect(Object.keys(lab.solution ?? {}).length).toBeGreaterThan(0);

    // §11.2: the timing sentence (the 45 s router boot), the 5-minute flow cap, and the Check's own flows
    const text = lab.instructions ?? '';
    expect(text).toContain('allow about a minute after the lab loads before the first ping or flow');
    expect(text).toContain('for at most 5 minutes');
    expect(text).toContain(`for ${QOS_LAB_TRAFFIC_RUN_MS / 1000} s of simulated time`);
    // original wording: no vendor, product or programme names (§0 rule 6)
    const words = [lab.title, lab.description, text, ...(lab.objectives ?? []), ...(lab.tasks ?? []).flatMap((t) => [t.title, t.description, t.hint ?? '', t.feedbackOnFail ?? ''])].join('\n');
    expect(words).not.toMatch(/cisco|juniper|catalyst|\bios\b|packet tracer|netacad/i);
    // markdown links only to a concept tool (D24)
    for (const m of text.matchAll(/\]\(([^)]+)\)/g)) expect(m[1]).toBe('concept:queueing');

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
    expect(ids).toEqual(['mark-voice', 'voice-first', 'police-bulk']);
    for (const task of lab.tasks ?? []) {
      expect(task.points, task.id).toBeGreaterThan(0);
      expect(task.assertions.length, task.id).toBeGreaterThan(0);
      for (const dep of task.dependsOn ?? []) expect(ids, task.id).toContain(dep);
    }
    expect((lab.tasks ?? []).reduce((n, t) => n + t.points, 0)).toBe(100);
    const deviceNames = topo.devices.map((d) => d.name);
    for (const name of Object.keys(lab.solution ?? {})) expect(deviceNames).toContain(name);
  });

  it('grades the approved [S20]/[S21] tasks with continuous flows in the clone (R44), each with its own flow ids', () => {
    const traffic = (lab.tasks ?? []).flatMap((t) => t.assertions.filter((a): a is Extract<LabAssertion, { kind: 'traffic' }> => a.kind === 'traffic').map((a) => ({ task: t.id, a })));
    expect(traffic.map((x) => x.task)).toEqual(['voice-first', 'police-bulk']);
    const ids: string[] = [];
    for (const { a } of traffic) {
      expect(a.runMs).toBe(QOS_LAB_TRAFFIC_RUN_MS);
      for (const f of a.flows) {
        // continuous: neither a count nor a duration (R44)
        expect(f.count, f.id).toBeUndefined();
        expect(f.durationMs, f.id).toBeUndefined();
        // the voice leaves PC-V unmarked, so only R1's marking can put it in the priority queue
        expect(f.dscp, f.id).toBeUndefined();
        expect(f.preset, f.id).toBeUndefined();
        ids.push(f.id ?? '');
      }
    }
    expect(ids).toEqual(['voice', 'bulk', 'edge-voice', 'edge-bulk']);
  });

  it('builds a P3-profile world whose schema can express it, with PortFast on every host and router port of SW1', () => {
    const topo = lab.build();
    expect(topo.profile).toBe('P3');
    expect(topo.schema).toBe(TOPOLOGY_SCHEMA_ID_1_3);
    expect(topo.schema).toBe(schemaIdFor(topo));
    const sim = createSimulation({ seed: lab.seed ?? 1 });
    sim.loadTopology(topo);
    expect(sim.profile).toBe('P3');

    const sw1 = topo.devices.find((d) => d.name === 'SW1');
    const config = sw1?.config ?? '';
    const cabled = topo.links.flatMap((l) => [l.a, l.b]).filter((e) => e.device === sw1?.id).map((e) => e.port);
    expect(cabled.sort()).toEqual(['FastEthernet0/1', 'FastEthernet0/2', 'GigabitEthernet0/1']);
    for (const port of cabled) {
      const section = config.split('!\n').find((s) => s.startsWith(`interface ${port}\n`)) ?? '';
      expect(section, port).toContain(' switchport mode access\n');
      expect(section, port).toContain(' spanning-tree portfast\n');
    }
  });

  it('fails every task before the student starts, and says why; the network already works', () => {
    const sim = labWorld();
    const status = evaluateLab(sim, lab);
    expect(status.lab).toBe(lab.name);
    expect(status.total).toBe(100);
    expect(status.score).toBe(0);
    for (const r of status.results) {
      expect(r.pass, r.task).toBe(false);
      expect(r.assertions.some((a) => !a.pass && (a.detail ?? '') !== ''), r.task).toBe(true);
    }
    // the routes are in place: PC-D reaches PC-S before any QoS line (the policing task's ping)
    expect(resultOf(status, 'police-bulk', indexOf('police-bulk', 'connectivity')).pass).toBe(true);
    // on the FIFO line the voice waits behind the bulk data for seconds
    const voice = resultOf(status, 'voice-first', indexOf('voice-first', 'traffic'));
    expect(voice.pass).toBe(false);
    expect(voice.detail).toMatch(VOICE_LATE);
    const ms = Number(VOICE_LATE.exec(voice.detail ?? '')?.[1]);
    expect(ms).toBeGreaterThan(1000);
  }, LAB_TEST_TIMEOUT_MS);

  it('scores full marks once the reference solution is applied as written, grading read-only and the same way twice', () => {
    const sim = labWorld();
    applySolution(sim);
    // without the learner's voice burst (step 2) the live EF row is missing: the marking is not proven yet (W5 fix #16)
    expect(taskPasses(evaluateLab(sim, lab))).toEqual({ 'mark-voice': false, 'voice-first': false, 'police-bulk': true });
    sendVoiceBurst(sim);
    const now = sim.now;
    const head = sim.trace(0).next;
    const pdus = sim.snapshot().pduCount;

    const first = evaluateLab(sim, lab);
    expect(failing(first), `${lab.name} solved`).toEqual([]);
    expect(first.score).toBe(first.total);
    const second = evaluateLab(sim, lab);

    expect(second).toEqual(first);
    expect(sim.now).toBe(now);
    expect(sim.trace(0).next).toBe(head);
    expect(sim.snapshot().pduCount).toBe(pdus);
  }, LAB_TEST_TIMEOUT_MS);
});

describe(`CCNA3 lab: ${lab.name} — wrong answers and other right forms`, () => {
  it('marking alone on the FIFO line: the first task passes, and the voice still waits seconds behind the bulk data', () => {
    const sim = labWorld();
    applySolution(sim, { R1: markingOnly() });
    sendVoiceBurst(sim);
    const status = evaluateLab(sim, lab);
    expect(taskPasses(status)).toEqual({ 'mark-voice': true, 'voice-first': false, 'police-bulk': false });
    const voice = resultOf(status, 'voice-first', indexOf('voice-first', 'traffic'));
    expect(voice.detail).toMatch(VOICE_LATE);
    expect(Number(VOICE_LATE.exec(voice.detail ?? '')?.[1])).toBeGreaterThan(1000);
  }, LAB_TEST_TIMEOUT_MS);

  it('a priority queue without the marking: the LLQ configuration checks pass; the marking’s proof and the clone’s flows fail', () => {
    const sim = labWorld();
    applySolution(sim, { R1: llqOnly() });
    sendVoiceBurst(sim);
    const status = evaluateLab(sim, lab);
    expect(taskPasses(status)).toEqual({ 'mark-voice': false, 'voice-first': false, 'police-bulk': false });
    const traffic = indexOf('voice-first', 'traffic');
    // the LLQ configuration checks pass; the marking's own proof (W5 fix #18: the set line, MARK inbound, the live EF
    // row) and the clone's flows fail
    expect(failing(status).filter((f) => f.startsWith('voice-first#')).map((f) => Number(f.slice('voice-first#'.length, f.indexOf(':'))))).toEqual([0, 1, 2, traffic]);
    expect(failing(status)).toContain(`voice-first#2: ${"The flows table of PC-S has no row with src=192.168.1.10 flow=f1 dscp=46. Send the voice burst from PC-V after MARK is attached (step 2): PC-S must see it arrive as EF (46)."}`);
    // the burst arrived, unmarked
    expect(sim.device(idOf(sim, 'PC-S'))!.tables.get<FlowRow>('flows')?.rows().find((r) => r.flow === 'f1')?.dscp).toBe(0);
    const voice = resultOf(status, 'voice-first', traffic);
    expect(voice.pass).toBe(false);
    // unmarked, the voice shares class-default with the bulk data: some of it is dropped, and what arrives is late
    expect(voice.detail).toMatch(/^PC-S lost \d+ of \d+ datagrams of flow voice from PC-V \(\d+(\.\d)? %\), more than 0 %/);
    expect(voice.detail).toContain("While the line is congested, voice keeps its delay only in a priority queue big enough for it.");
  }, LAB_TEST_TIMEOUT_MS);

  it('LLQ without the policer: voice is protected, but the bulk data still queues for seconds at the serial port', () => {
    const sim = labWorld();
    applySolution(sim, { R1: [...markingOnly(), ...llqOnly()] });
    sendVoiceBurst(sim);
    const status = evaluateLab(sim, lab);
    expect(taskPasses(status)).toEqual({ 'mark-voice': true, 'voice-first': true, 'police-bulk': false });
    expect(resultOf(status, 'police-bulk', indexOf('police-bulk', 'connectivity')).pass).toBe(true);
    const bulk = resultOf(status, 'police-bulk', indexOf('police-bulk', 'traffic'));
    expect(bulk.detail).toMatch(new RegExp(`^Flow edge-bulk from PC-D took up to \\d+(\\.\\d)? ms to reach PC-S, more than ${QOS_LAB_BULK_MAX_DELAY_MS} ms\\.`));
    expect(Number(/up to (\d+(?:\.\d)?) ms/.exec(bulk.detail ?? '')?.[1])).toBeGreaterThan(1000);
  }, LAB_TEST_TIMEOUT_MS);

  it('a policer that drops even conforming packets cuts the LAN off (class-default holds the desks’ ARP too)', () => {
    const sim = labWorld();
    const police = `police ${QOS_LAB_POLICE_BPS} conform-action transmit exceed-action drop`;
    applySolution(sim, r1Solution(new Map([[police, `police ${QOS_LAB_POLICE_BPS} conform-action drop exceed-action drop`]])));
    sendVoiceBurst(sim);
    const status = evaluateLab(sim, lab);
    // the voice would be marked and never policed, but PC-V cannot resolve its gateway: its ARP falls in class-default,
    // so the learner's burst never arrives either (no live EF row: W5 fix #16)
    expect(taskPasses(status)).toEqual({ 'mark-voice': false, 'voice-first': false, 'police-bulk': false });
    expect(failing(status).filter((f) => f.startsWith('mark-voice#'))).toEqual([`mark-voice#${indexOf('mark-voice', 'table')}: ${"The flows table of PC-S has no row with src=192.168.1.10 flow=f1 dscp=46. Send the voice burst from PC-V after MARK is attached (step 2): PC-S must see it arrive as EF (46)."}`]);
    expect(failing(status).filter((f) => f.startsWith('voice-first#'))).toEqual([
      `voice-first#${indexOf('voice-first', 'table')}: ${"The flows table of PC-S has no row with src=192.168.1.10 flow=f1 dscp=46. Send the voice burst from PC-V after MARK is attached (step 2): PC-S must see it arrive as EF (46)."}`,
      `voice-first#${indexOf('voice-first', 'traffic')}: No datagram of flow voice from PC-V reached PC-S. While the line is congested, voice keeps its delay only in a priority queue big enough for it.`,
    ]);
    const index = indexOf('police-bulk', 'connectivity');
    expect(resultOf(status, 'police-bulk', index).pass).toBe(false);
    expect(resultOf(status, 'police-bulk', index).detail).toContain('a policer that drops even conforming packets cuts the desk off');
    expect(resultOf(status, 'police-bulk', indexOf('police-bulk', 'traffic')).detail).toMatch(/^No datagram of flow edge-bulk from PC-D reached PC-S; no datagram of flow edge-voice from PC-V reached PC-S\./);
  }, LAB_TEST_TIMEOUT_MS);

  it('CS6 instead of EF, the marking policy attached outbound, a list that matches the bulk data too', () => {
    const sim = labWorld();
    applySolution(sim);
    sendVoiceBurst(sim);
    // CS6 (48): the class marks something else; the live row still holds the EF burst sent before the change, so here
    // only the configuration check can tell (a burst sent again after the change fails the live row too: next case)
    typeOn(sim, 'R1', ['policy-map MARK', 'class VOIP', 'set dscp cs6']);
    // the first task alone: its checks read the configuration, so no clone is built
    const marking: ScenarioInfo = { ...lab, tasks: (lab.tasks ?? []).filter((t) => t.id === 'mark-voice') };
    let status = evaluateLab(sim, marking);
    expect(taskPasses(status)).toEqual({ 'mark-voice': false });
    expect(failing(status).filter((f) => f.startsWith('mark-voice#'))).toEqual([
      `mark-voice#${(lab.tasks?.[0]?.assertions ?? []).findIndex((a) => a.kind === 'config' && a.path === 'policy-map.MARK.class.VOIP.set')}: R1 policy-map.MARK.class.VOIP.set is "dscp cs6", expected "dscp ef". Voice is marked EF (DSCP 46). CS6 (48) and the AF classes mean something else to every queue on the way.`,
    ]);
    typeOn(sim, 'R1', ['policy-map MARK', 'class VOIP', 'set dscp ef']);

    // the marking policy outbound on the LAN interface
    typeOn(sim, 'R1', ['interface GigabitEthernet0/0', 'no service-policy input MARK', 'service-policy output MARK']);
    status = evaluateLab(sim, marking);
    expect(failing(status).filter((f) => f.startsWith('mark-voice#'))).toEqual([
      `mark-voice#${indexOf('mark-voice', 'fact')}: R1 qos.inputPolicy of GigabitEthernet0/0 is not set, expected MARK. Mark where the traffic enters the network you trust: inbound on the LAN interface, before any routing decision.`,
    ]);
    typeOn(sim, 'R1', ['interface GigabitEthernet0/0', 'no service-policy output MARK', 'service-policy input MARK']);

    // a marking list that permits every UDP datagram: the bulk data would be marked as voice too
    typeOn(sim, 'R1', ['ip access-list extended VOICE-PORTS', 'permit udp any any']);
    status = evaluateLab(sim, marking);
    const wide = failing(status).filter((f) => f.startsWith('mark-voice#'));
    // port 9 and, since W5 fix #17, the ports just outside the voice range
    expect(wide).toHaveLength(3);
    expect(wide[0]).toContain('The bulk data (UDP port 9) must not match VOICE-PORTS');
    expect(wide[1]).toContain(`VOICE-PORTS must match only the voice ports ${QOS_LAB_VOICE_PORT_FIRST}-${QOS_LAB_VOICE_PORT_LAST}.`);
    expect(wide[2]).toContain(`VOICE-PORTS must match only the voice ports ${QOS_LAB_VOICE_PORT_FIRST}-${QOS_LAB_VOICE_PORT_LAST}.`);
  }, LAB_TEST_TIMEOUT_MS);

  it('CS6 with the burst sent again fails the marking AND the priority task: the live row shows 48 (W5 fixes #16, #18)', () => {
    const sim = labWorld();
    applySolution(sim, r1Solution(new Map([['set dscp ef', 'set dscp cs6']])));
    sendVoiceBurst(sim);
    expect(sim.device(idOf(sim, 'PC-S'))!.tables.get<FlowRow>('flows')?.rows().find((r) => r.flow === 'f1')?.dscp).toBe(48);
    const status = evaluateLab(sim, lab);
    expect(taskPasses(status)).toEqual({ 'mark-voice': false, 'voice-first': false, 'police-bulk': true });
    expect(failing(status).filter((f) => f.startsWith('voice-first#')).map((f) => f.slice(0, f.indexOf(':')))).toEqual(['voice-first#0', 'voice-first#2']);
  }, LAB_TEST_TIMEOUT_MS);

  it('an extra match line that keeps VOIP from ever matching fails the marking task: the burst arrives unmarked (W5 fix #16)', () => {
    const sim = labWorld();
    applySolution(sim, r1Solution(new Map([['match access-group name VOICE-PORTS', ['match access-group name VOICE-PORTS', 'match dscp ef']]])));
    sendVoiceBurst(sim);
    const status = evaluateLab(sim, lab);
    expect(taskPasses(status)['mark-voice']).toBe(false);
    expect(failing(status).filter((f) => f.startsWith('mark-voice#'))).toEqual([`mark-voice#${indexOf('mark-voice', 'table')}: ${"The flows table of PC-S has no row with src=192.168.1.10 flow=f1 dscp=46. Send the voice burst from PC-V after MARK is attached (step 2): PC-S must see it arrive as EF (46)."}`]);
  }, LAB_TEST_TIMEOUT_MS);

  it('marking lists wider than the voice ports fail the marking task (W5 fix #17)', () => {
    const sim = labWorld();
    applySolution(sim);
    const marking: ScenarioInfo = { ...lab, tasks: (lab.tasks ?? []).filter((t) => t.id === 'mark-voice') };
    for (const entry of ['permit udp any any gt 16383', 'permit udp any any range 1024 65535', 'permit udp any any range 16384 32768']) {
      typeOn(sim, 'R1', ['no ip access-list extended VOICE-PORTS', 'ip access-list extended VOICE-PORTS', entry, 'exit']);
      const failed = failing(evaluateLab(sim, marking)).filter((f) => f.includes('VOICE-PORTS must match only the voice ports'));
      expect(failed.length, entry).toBeGreaterThan(0);
    }
  }, LAB_TEST_TIMEOUT_MS);

  it('a right answer typed in other forms still earns full marks', () => {
    const sim = labWorld();
    applySolution(sim, {
      R1: [
        'ip access-list extended VOICE-PORTS',
        'permit udp any any range 16384 32767',
        'exit',
        'class-map VOIP',
        'match access-group name VOICE-PORTS',
        'exit',
        'class-map VOICE',
        'match dscp 46',
        'exit',
        'policy-map MARK',
        'class VOIP',
        'set dscp 46',
        'exit',
        'class class-default',
        `police ${QOS_LAB_POLICE_BPS}`,
        'exit',
        'exit',
        'policy-map WAN-EDGE',
        'class VOICE',
        `priority ${QOS_LAB_PRIORITY_KBPS}`,
        'exit',
        'exit',
        'interface Serial0/0/0',
        'bandwidth 128',
        'service-policy output WAN-EDGE',
        'exit',
        'interface GigabitEthernet0/0',
        'service-policy input MARK',
      ],
    });
    sendVoiceBurst(sim);
    const status = evaluateLab(sim, lab);
    expect(failing(status)).toEqual([]);
    expect(status.score).toBe(100);
  }, LAB_TEST_TIMEOUT_MS);
});

