/**
 * labs.ccna3.time — the W5 svc lab, proved (ARCHITECTURE-P3 §7 W5 "lab files, one owner each", §11.1 lesson 29, §11.2,
 * §3.7, §5.5, §5.7, D19, D22; the approved [S24] and [S25] tasks; ruling R47). The local copy of the checks of the sim
 * builder's `labs.ccna3.solutions.test.ts`, filtered to `ccna3-time-and-logs`, plus what only this lab needs.
 *   • metadata (§11.2) and the file rules (rule 12), as for every CCNA 3 lab; the timing sentences in the instructions;
 *   • the world: a P3-profile topology (schema 1.3) loaded as a P3 world; PortFast on SW1's ports toward R1 and SRV1;
 *     the [S24] timestamps lines replayed; every clock but SRV1's unset;
 *   • UNSOLVED: every task fails, each with a detail; SOLVED: every solution line accepted, full marks; grading is
 *     read-only and repeatable.
 * Lab-specific cases: the learner's path typed on consoles in the order the instructions give (time first, logs later),
 * where the server's row carries R1's synchronised local stamp and the configuration log (severity 5) never reaches the
 * server once `logging trap warnings` is set — it fires when the session leaves configuration mode (R47), after the
 * trap line; and the wrong answers each task must refuse: SW1 pointed straight at the reference (stratum 2), a server
 * whose time service is off (R1 retries, then polls, and `runToIdle` still returns), a trap level that is not warnings,
 * a link change made while the receiver was off, stamps without the local zone. A trap level typed as a number is the
 * same answer (`logging trap 4` is stored as `warnings`).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../src/contracts/ids.js';
import type { LabAssertion, ScenarioInfo } from '../src/contracts/scenario.js';
import { scenarioMeta } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { SyslogMessageRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID_1_3, schemaIdFor, type Topology } from '../src/contracts/topology.js';
import { CCNA3_MODULES } from '../src/curriculum/ccna3/lessons.js';
import { createCatalog } from '../src/device/catalog/index.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { createSimulation } from '../src/sim/simulation.js';
import {
  CCNA3_TIME_LABS,
  TIME_LINK_LOG,
  TIME_R1_ADDRESS,
  TIME_SERVER_ADDRESS,
  TIME_ZONE_NAME,
  ccna3TimeAndLogs,
} from '../src/sim/scenarios/ccna3/time.js';

const BOOT_NS = 90 * SEC;
const LAB_TEST_TIMEOUT_MS = 120_000;
/** The assertion kinds a CCNA 3 lab may use (§11.2). */
const LAB_KINDS: readonly LabAssertion['kind'][] = ['neighbor', 'fact', 'acl', 'aclDecision', 'route', 'table', 'connectivity', 'config', 'vlan', 'service', 'path', 'traffic'];
const LAB = ccna3TimeAndLogs;
const catalog = createCatalog(PROCESS_FACTORIES);

function labWorld(): Simulation {
  const sim = createSimulation({ seed: LAB.seed ?? 1 });
  sim.loadTopology({ ...LAB.build(), lab: { name: LAB.name, version: LAB.version ?? 1 } });
  for (const f of LAB.faults ?? []) sim.injectFault(f.at, f.fault);
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

/** `lines` typed on a console of the network device `name` in one configuration session (`configure terminal` … `end`). */
function typeConfig(sim: Simulation, name: string, lines: readonly string[]): void {
  const s = sim.cli.open(idOf(sim, name), 'console');
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) expect(sim.cli.exec(s, line).error, `${name}: ${line}`).toBeUndefined();
  sim.cli.close(s);
}

/** `lines` typed at the server's command line (the host shell). */
function typeShell(sim: Simulation, name: string, lines: readonly string[]): void {
  const s = sim.cli.open(idOf(sim, name), 'console');
  for (const line of lines) expect(sim.cli.exec(s, line).error, `${name}: ${line}`).toBeUndefined();
  sim.cli.close(s);
}

function applySolution(sim: Simulation, solution: Readonly<Record<string, readonly string[]>> = LAB.solution ?? {}): void {
  for (const [name, lines] of Object.entries(solution)) typeOn(sim, name, lines);
  sim.runToIdle();
}

/** Pass flag of each task, by id. */
function passes(sim: Simulation): Record<string, boolean> {
  return Object.fromEntries(evaluateLab(sim, LAB).results.map((r) => [r.task, r.pass]));
}

const ALL_PASS = { 'r1-time': true, 'sw1-time': true, 'local-logs': true, syslog: true };

/** The reference solution with `device`'s lines replaced. */
function solutionWith(device: string, lines: readonly string[]): Record<string, readonly string[]> {
  return { ...(LAB.solution ?? {}), [device]: lines };
}

const serverRows = (sim: Simulation): SyslogMessageRow[] => sim.device(idOf(sim, 'SRV1'))!.tables.get<SyslogMessageRow>('syslog-messages')?.rows() ?? [];

describe('ccna3-time-and-logs: the lab file', () => {
  it('describes itself as lab 29 of the CCNA 3 course, with structured-clone safe metadata and a catalog it uses', () => {
    expect(CCNA3_TIME_LABS).toEqual([LAB]);
    expect(LAB.name).toBe('ccna3-time-and-logs');
    expect(LAB.category).toBe('ccna3-lab');
    expect(LAB.course).toBe('CCNA 3');
    const home = CCNA3_MODULES.flatMap((m) => m.lessons.map((l) => ({ l, m }))).find((x) => x.l.lab === LAB.name);
    expect(home?.l.id).toBe('ccna3-29-time-and-logs');
    expect(LAB.topic).toBe(home?.m.title);
    expect(LAB.seed).toBeTypeOf('number');
    expect(LAB.instructions).toContain('Allow about a minute for the routers to start');
    expect(LAB.instructions).toContain('1, 2, 4, 8, 16 and 32 s, then every 64 s');
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
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sim', 'scenarios', 'ccna3', 'time.ts');
    const text = readFileSync(file, 'utf8');
    const specifiers = [...text.matchAll(/^import[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]);
    for (const s of specifiers) expect(s, s).toMatch(/^\.\.\/\.\.\/\.\.\/contracts\/[a-z-]+\.js$|^\.\.\/kit\.js$|^\.\.\/templates\.js$/);
    expect(text.match(/export const \w+: readonly ScenarioInfo\[\]/g)).toEqual(['export const CCNA3_TIME_LABS: readonly ScenarioInfo[]']);
  });

  it('builds a P3 world: edge ports toward R1 and SRV1, the timestamps lines replayed, the network clocks unset', () => {
    const topo: Topology = LAB.build();
    expect(topo.profile).toBe('P3');
    expect(topo.schema).toBe(TOPOLOGY_SCHEMA_ID_1_3);
    expect(topo.schema).toBe(schemaIdFor(topo));
    const sim = labWorld();
    expect(sim.profile).toBe('P3');
    const sw1 = sim.device(idOf(sim, 'SW1'))!.running.render();
    for (const port of ['GigabitEthernet0/1', 'FastEthernet0/1']) expect(sw1.split(`interface ${port}\n`)[1]?.split('!')[0]).toContain('spanning-tree portfast');
    expect(sim.device(idOf(sim, 'R1'))!.running.render()).toContain('\nservice timestamps log datetime msec\n');
    const facts = evaluateLab(sim, LAB).results.find((r) => r.task === 'r1-time')!;
    expect(facts.assertions[3]!.detail).toContain('R1 clock.source is unset');
  });
});

describe('ccna3-time-and-logs: graded', () => {
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

  it('the learner path on the consoles, time first: the server keeps R1\'s link line with its synchronised local stamp', () => {
    const sim = labWorld();
    typeShell(sim, 'SRV1', ['service ntp on']);
    typeConfig(sim, 'R1', [`ntp server ${TIME_SERVER_ADDRESS}`]);
    typeConfig(sim, 'SW1', [`ntp server ${TIME_R1_ADDRESS}`]);
    sim.runToIdle();
    expect(passes(sim)).toEqual({ ...ALL_PASS, 'local-logs': false, syslog: false });
    typeConfig(sim, 'R1', ['clock timezone CET 1', 'service timestamps log datetime msec localtime show-timezone', 'logging buffered 16384 informational']);
    typeShell(sim, 'SRV1', ['service syslog on']);
    // the host line before the trap line, in one session: the configuration log (severity 5) fires at `end`, after the
    // trap line (R47), so it never reaches the server
    typeConfig(sim, 'R1', [`logging host ${TIME_SERVER_ADDRESS}`, 'logging trap warnings']);
    sim.runFor(10 * SEC);
    expect(serverRows(sim)).toEqual([]);
    typeConfig(sim, 'R1', ['interface GigabitEthernet0/0', 'shutdown', 'no shutdown']);
    sim.runToIdle();
    expect(passes(sim)).toEqual(ALL_PASS);
    const rows = serverRows(sim);
    expect(rows.every((r) => r.hostname === 'R1' && r.severity <= 4)).toBe(true);
    const up = rows.find((r) => r.message.startsWith(`${TIME_LINK_LOG}:`))!;
    expect(up.message).toBe(`${TIME_LINK_LOG}: Interface GigabitEthernet0/0: the link is up`);
    // a synchronised clock: no `*`, the local zone named
    expect(up.stamp.startsWith('*')).toBe(false);
    expect(up.stamp.endsWith(` ${TIME_ZONE_NAME}`)).toBe(true);
    expect(rows.some((r) => r.message.includes('CONFIGURED'))).toBe(false);
  }, LAB_TEST_TIMEOUT_MS);
});

describe('ccna3-time-and-logs: wrong answers', () => {
  it('SW1 pointed straight at the reference is synchronised, but at stratum 2 and to the wrong peer', () => {
    const sim = labWorld();
    applySolution(sim, solutionWith('SW1', [`ntp server ${TIME_SERVER_ADDRESS}`]));
    expect(passes(sim)).toEqual({ ...ALL_PASS, 'sw1-time': false });
    const sw1 = evaluateLab(sim, LAB).results.find((r) => r.task === 'sw1-time')!;
    expect(sw1.assertions.map((a) => a.pass)).toEqual([true, false, false, true]);
    expect(sw1.misconception).toBe('every-device-to-the-reference');
  }, LAB_TEST_TIMEOUT_MS);

  it('a server whose time service is off: nobody synchronises, and the world still runs to idle', () => {
    const sim = labWorld();
    for (const [name, lines] of Object.entries(solutionWith('SRV1', ['service syslog on']))) typeOn(sim, name, lines);
    // the unanswered polls: six fast retries each, then only the periodic poll, so the grader's clone settles (rule 19)
    const stats = sim.runToIdle(5_000);
    expect(stats.events).toBeGreaterThan(0);
    expect(stats.events).toBeLessThan(5_000);
    const got = passes(sim);
    expect(got['r1-time']).toBe(false);
    expect(got['sw1-time']).toBe(false);
  }, LAB_TEST_TIMEOUT_MS);

  it('the trap level: errors is refused, 4 is warnings', () => {
    const sim = labWorld();
    applySolution(sim);
    typeOn(sim, 'R1', ['logging trap errors']);
    sim.runToIdle();
    expect(passes(sim)).toEqual({ ...ALL_PASS, syslog: false });
    typeOn(sim, 'R1', ['logging trap 4']);
    sim.runToIdle();
    expect(passes(sim)).toEqual(ALL_PASS);
  }, LAB_TEST_TIMEOUT_MS);

  it('a link change made while the receiver was off reaches nobody; once it is on, the next change does', () => {
    const sim = labWorld();
    applySolution(sim, solutionWith('SRV1', ['service ntp on']));
    expect(passes(sim)).toEqual({ ...ALL_PASS, syslog: false });
    expect(serverRows(sim)).toEqual([]);
    typeShell(sim, 'SRV1', ['service syslog on']);
    sim.runToIdle();
    expect(passes(sim)['syslog']).toBe(false);
    typeOn(sim, 'R1', ['interface GigabitEthernet0/0', 'shutdown', 'no shutdown']);
    sim.runToIdle();
    expect(passes(sim)).toEqual(ALL_PASS);
  }, LAB_TEST_TIMEOUT_MS);

  it('the time zone typed with a zero minutes field is the same answer: full marks (W5 fix #19)', () => {
    const sim = labWorld();
    const r1 = (LAB.solution?.['R1'] ?? []).map((l) => (l.startsWith('clock timezone ') ? `${l} 0` : l));
    expect(r1).toContain('clock timezone CET 1 0');
    applySolution(sim, solutionWith('R1', r1));
    expect(sim.device(idOf(sim, 'R1'))!.running.render()).toContain('clock timezone CET 1\n');
    expect(passes(sim)).toEqual(ALL_PASS);
  }, LAB_TEST_TIMEOUT_MS);

  it('stamps without the local time and zone fail the log task', () => {
    const sim = labWorld();
    applySolution(sim);
    typeOn(sim, 'R1', ['service timestamps log datetime msec']);
    sim.runToIdle();
    expect(passes(sim)).toEqual({ ...ALL_PASS, 'local-logs': false });
  }, LAB_TEST_TIMEOUT_MS);
});
