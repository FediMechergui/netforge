/**
 * P3 W5 course: the CCNA 3 point-to-point WAN lab, lab 22 `ccna3-serial-links` (lesson 22, [S19]; ARCHITECTURE-P3
 * §7 W5, §11.1, §11.2, §3.9, §5.7; sim/scenarios/ccna3/wan.ts) — a local copy of the checks of
 * `labs.ccna3.solutions.test.ts` (owned by sim), filtered to this lab, plus the lab's own proofs.
 *
 *   • metadata: category `ccna3-lab`, course `CCNA 3`, `topic` = the title of the module that holds lesson 22 in
 *     curriculum/ccna3/lessons.ts ("Wide area networks"), the name §11.1 freezes, a fixed seed, the timing sentences,
 *     structured-clone safe `scenarioMeta`, `requires` = exactly the catalog types the topology uses, tasks with
 *     unique ids, real points and existing dependencies, a solution for devices the topology has;
 *   • its world: a P3-profile topology whose schema is `schemaIdFor(t)` (1.3), loaded as a P3 world;
 *   • UNSOLVED (booted and settled): EVERY task fails, each on a failing assertion that says why;
 *   • SOLVED: `configure` accepts every line of the reference solution as written, the world runs to idle, and every
 *     task passes — full marks;
 *   • grading is read-only (same clock, trace head and PDU count) and repeatable (two evaluations are equal).
 *
 * The lab's own proofs: the HDLC part alone earns exactly the two HDLC tasks (the second graded in a clone that the
 * grader puts back on HDLC with `LabFault config`); with PPP and CHAP on both ends but R2's secret left in the wrong
 * case CHAP fails both ways (§3.9 step 6), the line protocol says so, and only the HDLC tasks pass; correcting the
 * secret brings the link up on the next 10 s retry, as the instructions say, and not before; switching CHAP off
 * earns everything but the CHAP task; CHAP on R1 alone still fails on R2's wrong secret; and the clock typed on the
 * DTE end leaves the line down.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../src/contracts/ids.js';
import type { ScenarioInfo } from '../src/contracts/scenario.js';
import { scenarioMeta } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { PppRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID_1_3, schemaIdFor, type Topology } from '../src/contracts/topology.js';
import { CCNA3_MODULES } from '../src/curriculum/ccna3/lessons.js';
import { createCatalog } from '../src/device/catalog/index.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { CCNA3_WAN_LABS, SERIAL_LINKS_SECRET, SERIAL_LINKS_WRONG_SECRET, ccna3SerialLinks } from '../src/sim/scenarios/ccna3/wan.js';
import { createSimulation } from '../src/sim/simulation.js';

/** Long enough for every model of the lab to boot (a router takes 45 s); `runToIdle` then settles the rest. */
const BOOT_NS = 90 * SEC;

/** Wall-clock budget of one world test: a lab world plus one grading clone per fault set it names. */
const LAB_TEST_TIMEOUT_MS = 60_000;

const lab = ccna3SerialLinks;
const SERIAL = 'Serial0/0/0';
const catalog = createCatalog(PROCESS_FACTORIES);

/** The lessons of the skeleton, with the title of the module that holds each. */
const LESSONS = CCNA3_MODULES.flatMap((m) => m.lessons.map((l) => ({ lesson: l, module: m.title })));

/** The lab's world as `loadScenario` builds it: the lab seed, the lab topology, booted and settled. */
function labWorld(): Simulation {
  const sim = createSimulation({ seed: lab.seed ?? 1 });
  const topo: Topology = { ...lab.build(), lab: { name: lab.name, version: lab.version ?? 1 } };
  sim.loadTopology(topo);
  for (const f of lab.faults ?? []) sim.injectFault(f.at, f.fault);
  sim.runFor(BOOT_NS);
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

/** Apply the reference solution as written, then settle. */
function applySolution(sim: Simulation): void {
  for (const [name, lines] of Object.entries(lab.solution ?? {})) typeOn(sim, name, lines, `${lab.name} solution for ${name}`);
  sim.runToIdle();
}

/** Tasks that did not pass, each with the details of its failing assertions. */
function failures(sim: Simulation): string[] {
  return evaluateLab(sim, lab)
    .results.filter((r) => !r.pass)
    .map((r) => `${r.task}: ${r.assertions.filter((a) => !a.pass).map((a) => a.detail ?? '(no detail)').join(' | ')}`);
}

/** Pass flag of each task, by id. */
function taskPasses(sim: Simulation): Record<string, boolean> {
  return Object.fromEntries(evaluateLab(sim, lab).results.map((r) => [r.task, r.pass]));
}

/** The `ppp` row of a router's serial interface. */
function pppRow(sim: Simulation, name: string): PppRow | undefined {
  return sim.device(idOf(sim, name))!.tables.get<PppRow>('ppp')?.get(SERIAL);
}

/** What `line` prints on a fresh privileged console of the device called `name`. */
function shown(sim: Simulation, name: string, line: string): string {
  const s = sim.cli.open(idOf(sim, name), 'console');
  sim.cli.exec(s, 'enable');
  const out = sim.cli.exec(s, line).output;
  sim.cli.close(s);
  return out;
}

/** Part 1 of the lab on R1: address, clock and enable the DCE end. */
const PART1_R1: readonly string[] = [`interface ${SERIAL}`, 'ip address 10.0.12.1 255.255.255.252', 'clock rate 64000', 'no shutdown', 'exit'];

/** PPP and CHAP on one router's serial interface. */
const PPP_CHAP: readonly string[] = [`interface ${SERIAL}`, 'encapsulation ppp', 'ppp authentication chap', 'exit'];

/** Every task id of the lab, in order. */
const TASKS = ['clock-the-line', 'hdlc-link', 'ppp-framing', 'chap', 'ipcp'];

/** The pass map of `TASKS` with exactly `passing` passing. */
const only = (...passing: string[]): Record<string, boolean> => Object.fromEntries(TASKS.map((t) => [t, passing.includes(t)]));

describe('CCNA3 WAN lab: the file', () => {
  it('exports lab 22 alone under the fixed name, the lab of lesson 22', () => {
    expect(CCNA3_WAN_LABS).toEqual([ccna3SerialLinks]);
    expect(lab.name).toBe('ccna3-serial-links');
    expect(LESSONS.filter((l) => l.lesson.lab === lab.name).map((l) => l.lesson.id)).toEqual(['ccna3-22-point-to-point-links']);
    expect((lab.tasks ?? []).map((t) => t.id)).toEqual(TASKS);
  });
});

describe(`CCNA3 lab: ${lab.name}`, () => {
  it('describes itself with structured-clone safe metadata, its module as topic and a catalog it really uses', () => {
    expect(lab.category).toBe('ccna3-lab');
    expect(lab.course).toBe('CCNA 3');
    expect(lab.labType).toBe('build');
    const home = LESSONS.find((l) => l.lesson.lab === lab.name);
    expect(lab.topic).toBe(home?.module);
    expect(lab.topic).toBe('Wide area networks');
    expect(lab.seed).toBeTypeOf('number');
    expect((lab.objectives ?? []).length).toBeGreaterThan(0);
    // the timing sentences: the router boot, PPP's negotiation and its 10 s retry after a refused authentication
    expect(lab.instructions).toContain('about 45 s to boot');
    expect(lab.instructions).toContain('every 10 s');
    expect(lab.instructions).toContain('case-sensitive');

    const meta = scenarioMeta(lab);
    expect(structuredClone(meta)).toEqual(meta);
    expect(meta).not.toHaveProperty('build');
    expect(meta).not.toHaveProperty('solution');
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
    // R1 holds the DCE end of the one serial cable; no host sits behind a switch
    expect(topo.links.find((l) => l.media === 'serial-dce')).toMatchObject({ a: { device: 'r1', port: SERIAL }, b: { device: 'r2', port: SERIAL } });
    // the secret R2 starts with differs from the right one only in case
    expect(SERIAL_LINKS_WRONG_SECRET).not.toBe(SERIAL_LINKS_SECRET);
    expect(SERIAL_LINKS_WRONG_SECRET.toLowerCase()).toBe(SERIAL_LINKS_SECRET.toLowerCase());
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
      expect(r.assertions.some((a) => !a.pass && (a.detail ?? '') !== ''), r.task).toBe(true);
    }
    // the serial line is down: R1's end was never configured, and R2 starts on HDLC with no PPP row
    expect(sim.device('r1')!.port(SERIAL)!.operUp).toBe(false);
    expect(sim.device('r2')!.port(SERIAL)!.encap ?? 'hdlc').toBe('hdlc');
    expect(pppRow(sim, 'R2')).toBeUndefined();
  }, LAB_TEST_TIMEOUT_MS);

  it('scores full marks once the reference solution is applied as written', () => {
    const sim = labWorld();
    applySolution(sim);
    expect(failures(sim), `${lab.name} solved`).toEqual([]);
    expect(evaluateLab(sim, lab).score).toBe(100);
    for (const name of ['R1', 'R2']) {
      expect(pppRow(sim, name), name).toMatchObject({ lcp: 'opened', ipcp: 'opened', authLocal: 'chap', authLocalState: 'success', authPeer: 'chap', authPeerState: 'success' });
    }
    expect(pppRow(sim, 'R1')?.peerName).toBe('R2');
    expect(pppRow(sim, 'R2')?.peerName).toBe('R1');
  }, LAB_TEST_TIMEOUT_MS);

  it('grades without touching the live simulation, and the same way twice', () => {
    const sim = labWorld();
    applySolution(sim);
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

describe(`CCNA3 lab ${lab.name}: the parts and the wrong answers`, () => {
  it('Part 1 alone (HDLC) earns exactly the clock and HDLC tasks', () => {
    const sim = labWorld();
    typeOn(sim, 'R1', PART1_R1);
    sim.runToIdle();
    expect(taskPasses(sim)).toEqual(only('clock-the-line', 'hdlc-link'));
    // the form the hint and the instructions name (W5 fix #15: a bare `show controllers` is incomplete in the grammar)
    expect(lab.instructions).toContain('`show controllers serial`');
    expect(lab.tasks?.find((t) => t.id === 'clock-the-line')?.hint).toContain('`show controllers serial`');
    expect(shown(sim, 'R1', 'show controllers serial')).toContain('DCE');
    expect(shown(sim, 'R1', `show controllers serial ${SERIAL}`)).toContain('DCE');
    expect(evaluateLab(sim, lab).score).toBe(35);
  }, LAB_TEST_TIMEOUT_MS);

  it('PPP and CHAP with R2 secret left in the wrong case: CHAP fails both ways and only the HDLC tasks pass', () => {
    const sim = labWorld();
    typeOn(sim, 'R1', [...PART1_R1, `username R2 password ${SERIAL_LINKS_SECRET}`, ...PPP_CHAP]);
    typeOn(sim, 'R2', PPP_CHAP);
    sim.runToIdle();
    for (const name of ['R1', 'R2']) expect(pppRow(sim, name), name).toMatchObject({ lcp: 'stopped', authLocalState: 'failed', authPeerState: 'failed' });
    expect(shown(sim, 'R2', `show interfaces ${SERIAL}`)).toContain('line protocol down (authentication failed)');
    const status = evaluateLab(sim, lab);
    expect(Object.fromEntries(status.results.map((r) => [r.task, r.pass]))).toEqual(only('clock-the-line', 'hdlc-link'));
    expect(status.results.find((r) => r.task === 'chap')?.misconception).toBe('chap-secret-mismatch');

    // the fix: the right secret on R2; nothing changes until the next retry (periodic, 10 s), then the link opens
    typeOn(sim, 'R2', [`username R1 password ${SERIAL_LINKS_SECRET}`]);
    sim.runToIdle();
    expect(pppRow(sim, 'R1')?.lcp).toBe('stopped');
    sim.runFor(10 * SEC);
    sim.runToIdle();
    expect(pppRow(sim, 'R1')).toMatchObject({ lcp: 'opened', ipcp: 'opened', authLocalState: 'success' });
    expect(failures(sim)).toEqual([]);
  }, LAB_TEST_TIMEOUT_MS);

  it('switching CHAP off to get the link up earns everything but the CHAP task', () => {
    const sim = labWorld();
    typeOn(sim, 'R1', [...PART1_R1, `interface ${SERIAL}`, 'encapsulation ppp', 'exit']);
    typeOn(sim, 'R2', [`interface ${SERIAL}`, 'encapsulation ppp', 'exit']);
    sim.runToIdle();
    expect(pppRow(sim, 'R1')).toMatchObject({ lcp: 'opened', ipcp: 'opened', authLocal: 'none', authPeer: 'none' });
    expect(taskPasses(sim)).toEqual(only('clock-the-line', 'hdlc-link', 'ppp-framing', 'ipcp'));
  }, LAB_TEST_TIMEOUT_MS);

  it('CHAP required by R1 alone still fails on the wrong secret R2 answers with', () => {
    const sim = labWorld();
    typeOn(sim, 'R1', [...PART1_R1, `username R2 password ${SERIAL_LINKS_SECRET}`, ...PPP_CHAP]);
    typeOn(sim, 'R2', [`interface ${SERIAL}`, 'encapsulation ppp', 'exit']);
    sim.runToIdle();
    expect(pppRow(sim, 'R1')).toMatchObject({ lcp: 'stopped', authLocal: 'chap', authLocalState: 'failed' });
    expect(taskPasses(sim)).toEqual(only('clock-the-line', 'hdlc-link'));
  }, LAB_TEST_TIMEOUT_MS);

  it('the clock typed on the DTE end leaves the line down', () => {
    const sim = labWorld();
    typeOn(sim, 'R1', [`interface ${SERIAL}`, 'ip address 10.0.12.1 255.255.255.252', 'no shutdown', 'exit']);
    const r = sim.configure(idOf(sim, 'R2'), [`interface ${SERIAL}`, 'clock rate 64000', 'exit']);
    expect(r.lines.length).toBeGreaterThan(0);
    sim.runToIdle();
    expect(sim.device('r1')!.port(SERIAL)!.operUp).toBe(false);
    const status = evaluateLab(sim, lab);
    expect(Object.fromEntries(status.results.map((r) => [r.task, r.pass]))).toEqual(only());
    expect(status.results.find((r) => r.task === 'clock-the-line')?.misconception).toBe('serial-clock-on-dte');
  }, LAB_TEST_TIMEOUT_MS);
});
