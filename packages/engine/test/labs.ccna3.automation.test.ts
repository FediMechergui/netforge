/**
 * labs.ccna3.automation — the W6 auto lab 38, proved (ARCHITECTURE-P3 §7 W6 "auto", §11.1 lesson 38, §11.2, §3.8,
 * §5.6, D21, D22). The local copy of the checks of the sim builder's `labs.ccna3.solutions.test.ts`, filtered to
 * `ccna3-restconf-change`, plus what only this lab needs.
 *   • metadata (§11.2) and the file rules (rule 12), as for every CCNA 3 lab; the timing sentence in the instructions;
 *     the lab joins `CCNA3_LABS` and `SCENARIOS` in course order; it survives the [S37] lab document round trip;
 *   • the world: a P3-profile topology (schema 1.3) loaded as a P3 world; PortFast on PC1's port; the API answering on
 *     every switch from the start; the note on SW2's `GigabitEthernet0/2`;
 *   • UNSOLVED: every task fails, each with a detail; SOLVED — the reference solution through `Simulation.configure`,
 *     then the learner's requests `RESTCONF_LAB_REQUESTS` typed on PC1's console exactly as the generic solutions test
 *     types a lab's learner lines (a `rest` line is a CLI job, which `configure` refuses): full marks; grading is
 *     read-only and repeatable; the solution alone cannot pass the API tasks; a copy of the unsolved and of the solved
 *     world settles within the grader clone's event cap (`accept.p3.grader-bounded`'s rule, the API's changes carried
 *     by the export).
 * Lab-specific cases: the learner's path on PC1's console, job by job (the GET prints the note inside the JSON, a GET
 * without credentials is 401, each PUT is 201 then 204, the note acted on through the API instead of the console); one
 * near-miss wrong answer (or more) per task — a GET refused 401 and a GET of the wrong switch (read), the note's VLAN
 * made on the switch that holds the note (act), a VLAN named `Voice` (the effect), the VLAN typed on the consoles, the
 * VLAN typed on the consoles plus an accepted PUT to `vlan-list=300` (the path is matched whole, not as a substring), a
 * PUT without its Content-Type (415), a POST, a PUT whose body key differs from the URL's (400) (the API task); and §3.8 step
 * 7's determinism: the journal replays the `cliExec` requests to byte-identical trace and snapshot JSON, and three runs
 * with one seed are byte-identical.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../src/contracts/ids.js';
import { labDocumentOf, scenarioOf } from '../src/contracts/lab-document.js';
import type { LabAssertion } from '../src/contracts/scenario.js';
import { scenarioMeta } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { RestconfLogRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID_1_3, schemaIdFor, type Topology } from '../src/contracts/topology.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { CCNA3_MODULES } from '../src/curriculum/ccna3/lessons.js';
import { createCatalog } from '../src/device/catalog/index.js';
import { labDocumentFromJson, labDocumentToJson, validateLabDocument } from '../src/io/lab-schema.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import { LAB_CLONE_BOOT_EVENTS, evaluateLab } from '../src/sim/lab-checks.js';
import { createReplay } from '../src/sim/replay.js';
import {
  CCNA3_AUTOMATION_LABS,
  RESTCONF_LAB_ADDRESSES,
  RESTCONF_LAB_JSON_TYPE,
  RESTCONF_LAB_NOTE,
  RESTCONF_LAB_REQUESTS,
  RESTCONF_LAB_SECRET,
  RESTCONF_LAB_USER,
  ccna3RestconfChange,
  restconfLabGetInterfaces,
  restconfLabPutVlan,
} from '../src/sim/scenarios/ccna3/automation.js';
import * as ccna3 from '../src/sim/scenarios/ccna3/index.js';
import { SCENARIOS } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';

const BOOT_NS = 90 * SEC;
const LAB_TEST_TIMEOUT_MS = 120_000;
/** Time after each line a learner types, as the generic solutions test gives it (`LOGIN_LINE_NS`). */
const LEARNER_LINE_NS = 5 * SEC;
/** Trace ring of the determinism cases: every event since the start is kept. */
const TRACE_CAPACITY = 1_000_000;
/** The assertion kinds a CCNA 3 lab may use (§11.2). */
const LAB_KINDS: readonly LabAssertion['kind'][] = ['neighbor', 'fact', 'acl', 'aclDecision', 'route', 'table', 'connectivity', 'config', 'vlan', 'service', 'path', 'traffic'];
const LAB = ccna3RestconfChange;
const A = RESTCONF_LAB_ADDRESSES;
const AUTH = `-u ${RESTCONF_LAB_USER}:${RESTCONF_LAB_SECRET}`;
const JSON_HEADER = `-H "Content-Type: ${RESTCONF_LAB_JSON_TYPE}"`;
const catalog = createCatalog(PROCESS_FACTORIES);

type Requests = typeof RESTCONF_LAB_REQUESTS;

function labWorld(opts: { traceCapacity?: number } = {}): Simulation {
  const sim = createSimulation({ seed: LAB.seed ?? 1, ...opts });
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

/** `lines` typed on a console of the switch `name` in one configuration session (`configure terminal` … `end`). */
function typeConfig(sim: Simulation, name: string, lines: readonly string[]): void {
  const s = sim.cli.open(idOf(sim, name), 'console');
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) expect(sim.cli.exec(s, line).error, `${name}: ${line}`).toBeUndefined();
  sim.cli.close(s);
}

/**
 * The learner's lines typed on each host's console, as the generic solutions test types a lab's learner lines: one
 * console per entry, each line followed by `LEARNER_LINE_NS` of simulated time.
 */
function typeRequests(sim: Simulation, requests: Requests): void {
  for (const entry of requests) {
    const s = sim.cli.open(idOf(sim, entry.from), 'console');
    for (const line of entry.lines) {
      sim.cli.exec(s, line);
      sim.runFor(LEARNER_LINE_NS);
    }
    sim.cli.close(s);
  }
  sim.runToIdle();
}

/** The reference solution through `configure`, then the learner's requests (`requests`, by default the lab's). */
function applySolution(sim: Simulation, opts: { solution?: Readonly<Record<string, readonly string[]>>; requests?: Requests } = {}): void {
  for (const [name, lines] of Object.entries(opts.solution ?? LAB.solution ?? {})) typeOn(sim, name, lines);
  sim.runToIdle();
  typeRequests(sim, opts.requests ?? RESTCONF_LAB_REQUESTS);
}

/** The lab's requests from PC1 with `lines` instead. */
const requestsOf = (lines: readonly string[]): Requests => [{ from: 'PC1', lines }];
/** The lab's request lines with the line at `index` replaced (or dropped when `line` is undefined). */
function requestsWith(index: number, line: string | undefined): Requests {
  const lines = [...RESTCONF_LAB_REQUESTS[0]!.lines];
  if (line === undefined) lines.splice(index, 1);
  else lines[index] = line;
  return requestsOf(lines);
}

interface Reply {
  readonly text: string;
  readonly status?: number;
  /** The printed body (after the blank line that ends the headers). */
  readonly body: string;
}

/** Type `line` on a fresh console of PC1 (a `rest` job), run until the job has ended, and read what it printed. */
function rest(sim: Simulation, line: string): Reply {
  const s = sim.cli.open(idOf(sim, 'PC1'), 'console');
  const cursor = sim.trace(0).next;
  const started = sim.cli.exec(s, line);
  expect(started.error, line).toBeUndefined();
  expect(started.busy, line).toBe(true);
  let done = false;
  for (let i = 0; i < 200 && !done; i++) {
    sim.runFor(SEC / 20);
    done = sim.trace(cursor).events.some((e) => e.kind === 'cliPrompt' && e.session === s && !e.busy);
  }
  expect(done, `the job of "${line.slice(0, 60)}" ended`).toBe(true);
  const text = sim
    .trace(cursor)
    .events.filter((e): e is Extract<TraceEvent, { kind: 'cliOutput' }> => e.kind === 'cliOutput' && e.session === s)
    .map((e) => e.text)
    .join('');
  sim.cli.close(s);
  const m = /^HTTP\/1\.1 (\d{3}) /.exec(text);
  const lines = text.split('\n');
  const body = lines.slice(lines.indexOf('') + 1).join('\n').replace(/\n$/, '');
  return m === null ? { text, body: '' } : { text, status: Number(m[1]), body };
}

/** Pass flag of each task, by id. */
function passes(sim: Simulation): Record<string, boolean> {
  return Object.fromEntries(evaluateLab(sim, LAB).results.map((r) => [r.task, r.pass]));
}

const ALL_PASS = { 'read-interfaces': true, 'act-on-note': true, 'vlan-30': true, 'through-the-api': true };

/** The `restconf-log` rows of a switch: [method, path, status]. */
const logOf = (sim: Simulation, name: string): [string, string, number][] =>
  (sim.device(idOf(sim, name))!.tables.get<RestconfLogRow>('restconf-log')?.rows() ?? []).map((r) => [r.method, r.path, r.status]);

/** The name of VLAN `vlan` in the running configuration of `name` (undefined: no such VLAN section). */
function vlanName(sim: Simulation, name: string, vlan: number): string | null | undefined {
  const node = sim.device(idOf(sim, name))!.running.root.children.find((n) => n.key === 'vlan' && n.args[0] === String(vlan));
  return node === undefined ? undefined : node.children.find((c) => c.key === 'name')?.args[0] ?? null;
}

const VLAN_PATH = '/restconf/data/nf-native:native/vlan/vlan-list=30';
const INTERFACES_PATH = '/restconf/data/ietf-interfaces:interfaces';

describe('ccna3-restconf-change: the lab file', () => {
  it('describes itself as lab 38 of the CCNA 3 course, with structured-clone safe metadata and a catalog it uses', () => {
    expect(CCNA3_AUTOMATION_LABS[0]).toBe(LAB);
    // lab 40 [S32] joins this array after the NF-DEVHOST flip (§7 W6); nothing else ever does
    for (const lab of CCNA3_AUTOMATION_LABS) expect(['ccna3-restconf-change', 'ccna3-script-inventory']).toContain(lab.name);
    expect(LAB.name).toBe('ccna3-restconf-change');
    expect(LAB.category).toBe('ccna3-lab');
    expect(LAB.course).toBe('CCNA 3');
    const home = CCNA3_MODULES.flatMap((m) => m.lessons.map((l) => ({ l, m }))).find((x) => x.l.lab === LAB.name);
    expect(home?.l.id).toBe('ccna3-38-talking-to-devices-through-apis');
    expect(LAB.topic).toBe(home?.m.title);
    expect(LAB.topic).toBe('Automating the network');
    expect(LAB.seed).toBeTypeOf('number');
    expect(LAB.instructions).toContain('allow about a minute before the first request');
    expect(LAB.instructions).toContain('trunks forward 30 s after that');
    const meta = scenarioMeta(LAB);
    expect(structuredClone(meta)).toEqual(meta);
    expect(meta).not.toHaveProperty('solution');
    const topo = LAB.build();
    expect([...(LAB.requires ?? [])].sort()).toEqual([...new Set(topo.devices.map((d) => d.type))].sort());
    for (const type of LAB.requires ?? []) expect(catalog.get(type), type).toBeDefined();
    const ids = (LAB.tasks ?? []).map((t) => t.id);
    expect(ids).toEqual(['read-interfaces', 'act-on-note', 'vlan-30', 'through-the-api']);
    expect((LAB.tasks ?? []).reduce((n, t) => n + t.points, 0)).toBe(100);
    for (const t of LAB.tasks ?? []) {
      expect(t.points).toBeGreaterThan(0);
      for (const a of t.assertions) expect(LAB_KINDS, `${t.id}: ${a.kind}`).toContain(a.kind);
      for (const dep of t.dependsOn ?? []) expect(ids).toContain(dep);
    }
    const names = topo.devices.map((d) => d.name);
    expect(Object.keys(LAB.solution ?? {}).length).toBeGreaterThan(0);
    for (const name of Object.keys(LAB.solution ?? {})) expect(names).toContain(name);
    for (const r of RESTCONF_LAB_REQUESTS) expect(names).toContain(r.from);
  });

  it('prints in its instructions the request lines a learner types, exactly', () => {
    const [get, put1, put2, put3] = RESTCONF_LAB_REQUESTS[0]!.lines;
    expect(get).toBe(restconfLabGetInterfaces(A.sw2));
    expect(put1).toBe(restconfLabPutVlan(A.sw1));
    expect(LAB.instructions).toContain(`\`${get}\``);
    expect(LAB.instructions).toContain(`\`${put1}\``);
    // the PUTs to SW2 and SW3 are SW1's with the address changed, as the instructions say
    expect(put2).toBe(put1!.replace(A.sw1, A.sw2));
    expect(put3).toBe(put1!.replace(A.sw1, A.sw3));
    expect(put1).toBe(
      `rest PUT https://${A.sw1}${VLAN_PATH} ${AUTH} ${JSON_HEADER} -d {"nf-native:vlan-list":[{"id":30,"name":"VOICE"}]}`,
    );
    expect(LAB.instructions).toContain(RESTCONF_LAB_SECRET);
    // the note is for the learner to find: the instructions never give it away
    expect(LAB.instructions).not.toContain('FINANCE');
    expect(LAB.instructions).not.toContain('vlan 40');
    for (const t of LAB.tasks ?? []) expect(`${t.title} ${t.description} ${t.hint ?? ''}`, t.id).not.toContain('FINANCE');
  });

  it('imports only the contracts, the kit and the templates, and exports one array under its fixed name', () => {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sim', 'scenarios', 'ccna3', 'automation.ts');
    const text = readFileSync(file, 'utf8');
    const specifiers = [...text.matchAll(/^import[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]);
    for (const s of specifiers) expect(s, s).toMatch(/^\.\.\/\.\.\/\.\.\/contracts\/[a-z-]+\.js$|^\.\.\/kit\.js$|^\.\.\/templates\.js$/);
    expect(text.match(/export const \w+: readonly ScenarioInfo\[\]/g)).toEqual(['export const CCNA3_AUTOMATION_LABS: readonly ScenarioInfo[]']);
    // every exported name is prefixed, since ccna3/index.ts re-exports the file with `export *`
    for (const m of text.matchAll(/^export (?:const|function) (\w+)/gm)) expect(m[1], m[1]).toMatch(/^(RESTCONF_LAB_|restconfLab|ccna3Restconf|CCNA3_AUTOMATION_)/);
  });

  it('joins the CCNA 3 catalogue in course order and SCENARIOS once, as a ccna3-lab', () => {
    expect(ccna3.CCNA3_AUTOMATION_LABS).toBe(CCNA3_AUTOMATION_LABS);
    expect(ccna3.RESTCONF_LAB_REQUESTS).toBe(RESTCONF_LAB_REQUESTS);
    expect(ccna3.CCNA3_LABS).toContain(LAB);
    const order = ccna3.CCNA3_LAB_ORDER;
    const landed = ccna3.CCNA3_LABS.map((l) => l.name);
    expect(landed).toEqual(order.filter((n) => landed.includes(n)));
    expect(landed.indexOf(LAB.name)).toBeGreaterThan(landed.indexOf('ccna3-troubleshoot-enterprise'));
    expect(SCENARIOS.filter((s) => s.name === LAB.name).map((s) => s.category)).toEqual(['ccna3-lab']);
  });

  it('survives the lab document round trip ([S37]): JSON text, schema, scenario', () => {
    const doc = labDocumentOf(LAB);
    const json = JSON.parse(labDocumentToJson(doc)) as unknown;
    const checked = validateLabDocument(json);
    expect(checked.ok ? [] : checked.errors).toEqual([]);
    const back = scenarioOf(labDocumentFromJson(labDocumentToJson(doc)));
    expect(back.build()).toEqual(LAB.build());
    expect(back.tasks).toEqual(LAB.tasks);
    expect(back.solution).toEqual(LAB.solution);
    expect(back.category).toBe('ccna3-lab');
  });
});

describe('ccna3-restconf-change: the world', () => {
  it('builds a P3 world: PC1 on an edge port in VLAN 99, the API answering on every switch, the note on SW2', () => {
    const topo: Topology = LAB.build();
    expect(topo.profile).toBe('P3');
    expect(topo.schema).toBe(TOPOLOGY_SCHEMA_ID_1_3);
    expect(topo.schema).toBe(schemaIdFor(topo));
    const sim = labWorld();
    expect(sim.profile).toBe('P3');
    const sw1 = sim.device(idOf(sim, 'SW1'))!.running.render();
    const pcPort = sw1.split('interface FastEthernet0/1\n')[1]?.split('!')[0] ?? '';
    expect(pcPort).toContain('switchport access vlan 99');
    expect(pcPort).toContain('spanning-tree portfast');
    expect(sim.device(idOf(sim, 'SW2'))!.running.render().split('interface GigabitEthernet0/2\n')[1]?.split('!')[0]).toContain(
      `description ${RESTCONF_LAB_NOTE}`,
    );
    for (const name of ['SW1', 'SW2', 'SW3']) {
      const s = sim.cli.open(idOf(sim, name), 'console');
      const out = sim.cli.exec(s, 'show restconf').output;
      sim.cli.close(s);
      expect(out.split('\n')[0], name).toBe('RESTCONF API: on, answering on TCP port 443 (HTTPS, simulated TLS)');
      expect(out, name).toContain(`(${RESTCONF_LAB_USER})`);
      expect(vlanName(sim, name, 30), name).toBeUndefined();
      expect(vlanName(sim, name, 40), name).toBeUndefined();
      expect(logOf(sim, name), name).toEqual([]);
    }
  }, LAB_TEST_TIMEOUT_MS);
});

describe('ccna3-restconf-change: graded', () => {
  it('fails every task before the student starts, and says why', () => {
    const status = evaluateLab(labWorld(), LAB);
    expect(status.results.filter((r) => r.pass).map((r) => r.task)).toEqual([]);
    expect(status.score).toBe(0);
    for (const r of status.results) expect(r.assertions.some((a) => !a.pass && (a.detail ?? '') !== ''), r.task).toBe(true);
  }, LAB_TEST_TIMEOUT_MS);

  it('scores full marks with the reference solution and the learner\'s requests, read-only and repeatably', () => {
    const sim = labWorld();
    applySolution(sim);
    expect(logOf(sim, 'SW2')).toEqual([
      ['GET', INTERFACES_PATH, 200],
      ['PUT', VLAN_PATH, 201],
    ]);
    expect(logOf(sim, 'SW1')).toEqual([['PUT', VLAN_PATH, 201]]);
    expect(logOf(sim, 'SW3')).toEqual([['PUT', VLAN_PATH, 201]]);
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

  it('a copy of the unsolved and of the solved world reaches idle within the grader clone\'s event cap', () => {
    /** The grader's settle of a copy (sim/lab-checks.ts `settledClone`; no cut cable or err-disabled port here). */
    const cloneSettle = (sim: Simulation): ReturnType<Simulation['runToIdle']> => {
      const copy = createSimulation({ seed: sim.seed, catalog: sim.catalog, journal: false });
      copy.loadTopology(sim.exportTopology());
      return copy.runToIdle(LAB_CLONE_BOOT_EVENTS);
    };
    expect(cloneSettle(labWorld()).stopped, 'unsolved').toBeUndefined();
    const solved = labWorld();
    applySolution(solved);
    // the API's changes are running configuration: the export carries them to the copy
    const sw1 = solved.exportTopology().devices.find((d) => d.name === 'SW1')!.runningConfig ?? '';
    expect(sw1).toContain('vlan 30\n name VOICE\n');
    expect(cloneSettle(solved).stopped, 'solved').toBeUndefined();
  }, LAB_TEST_TIMEOUT_MS);

  it('the reference solution alone cannot pass the API tasks: the requests are the learner\'s (configure refuses a job)', () => {
    const sim = labWorld();
    applySolution(sim, { requests: [] });
    expect(passes(sim)).toEqual({ 'read-interfaces': false, 'act-on-note': true, 'vlan-30': false, 'through-the-api': false });
    // a rest line through configure is refused, never sent
    const r = sim.configure(idOf(sim, 'PC1'), [RESTCONF_LAB_REQUESTS[0]!.lines[0]!]);
    expect(r.ok).toBe(false);
    sim.runToIdle();
    expect(logOf(sim, 'SW2')).toEqual([]);
  }, LAB_TEST_TIMEOUT_MS);

  it('the learner path on PC1\'s console: read the note in the JSON, act on it through the API, PUT VLAN 30 everywhere', () => {
    const sim = labWorld();
    // a GET without credentials: 401, and the row says so
    const refused = rest(sim, `rest GET https://${A.sw2}${INTERFACES_PATH}`);
    expect(refused.status).toBe(401);
    expect(passes(sim)['read-interfaces']).toBe(false);
    // the GET of step 1: 200 and the RFC 7951 JSON, pretty-printed, holding the note on Gi0/2
    const read = rest(sim, restconfLabGetInterfaces(A.sw2));
    expect(read.status).toBe(200);
    const doc = JSON.parse(read.body) as { 'ietf-interfaces:interfaces': { interface: { name: string; description?: string }[] } };
    const noted = doc['ietf-interfaces:interfaces'].interface.filter((i) => i.description === RESTCONF_LAB_NOTE).map((i) => i.name);
    expect(noted).toEqual(['GigabitEthernet0/2']);
    expect(read.body).toContain(`"description": "${RESTCONF_LAB_NOTE}"`);
    expect(passes(sim)).toEqual({ 'read-interfaces': true, 'act-on-note': false, 'vlan-30': false, 'through-the-api': false });
    // the note acted on through the API (a PUT to SW3) instead of SW3's console
    expect(rest(sim, restconfLabPutVlan(A.sw3, 40, 'FINANCE')).status).toBe(201);
    expect(vlanName(sim, 'SW3', 40)).toBe('FINANCE');
    expect(passes(sim)['act-on-note']).toBe(true);
    // the PUT of step 3 on each switch: 201, then 204 for the same PUT again (nothing to change)
    for (const address of [A.sw1, A.sw2, A.sw3]) expect(rest(sim, restconfLabPutVlan(address)).status, address).toBe(201);
    expect(rest(sim, restconfLabPutVlan(A.sw1)).status).toBe(204);
    expect(logOf(sim, 'SW1')).toEqual([
      ['PUT', VLAN_PATH, 201],
      ['PUT', VLAN_PATH, 204],
    ]);
    // read back through the API
    const back = rest(sim, `rest GET https://${A.sw3}${VLAN_PATH} ${AUTH}`);
    expect([back.status, JSON.parse(back.body)]).toEqual([200, { 'nf-native:vlan-list': [{ id: 30, name: 'VOICE' }] }]);
    sim.runToIdle();
    expect(passes(sim)).toEqual(ALL_PASS);
    expect(evaluateLab(sim, LAB).score).toBe(100);
  }, LAB_TEST_TIMEOUT_MS);
});

describe('ccna3-restconf-change: wrong answers (one near miss or more per task)', () => {
  it('read: a GET without credentials (401) reads nothing; a GET of another switch reads the wrong one', () => {
    const noAuth = labWorld();
    applySolution(noAuth, { requests: requestsWith(0, `rest GET https://${A.sw2}${INTERFACES_PATH}`) });
    expect(logOf(noAuth, 'SW2')[0]).toEqual(['GET', INTERFACES_PATH, 401]);
    expect(passes(noAuth)).toEqual({ ...ALL_PASS, 'read-interfaces': false });

    const otherSwitch = labWorld();
    applySolution(otherSwitch, { requests: requestsWith(0, restconfLabGetInterfaces(A.sw1)) });
    expect(logOf(otherSwitch, 'SW1')[0]).toEqual(['GET', INTERFACES_PATH, 200]);
    expect(passes(otherSwitch)).toEqual({ ...ALL_PASS, 'read-interfaces': false });
  }, LAB_TEST_TIMEOUT_MS);

  it('act: the note\'s VLAN made on SW2, the switch that holds the note, instead of SW3', () => {
    const sim = labWorld();
    applySolution(sim, { solution: { SW2: ['vlan 40', 'name FINANCE'] } });
    expect(vlanName(sim, 'SW2', 40)).toBe('FINANCE');
    expect(passes(sim)).toEqual({ ...ALL_PASS, 'act-on-note': false });
    const act = evaluateLab(sim, LAB).results.find((r) => r.task === 'act-on-note')!;
    expect(act.misconception).toBe('note-applied-where-it-was-read');
    expect(act.assertions[0]!.detail).toContain('VLAN 40 does not exist on SW3.');
  }, LAB_TEST_TIMEOUT_MS);

  it('the effect: VLAN 30 named Voice is accepted by the API (so the API task passes) but is not VOICE', () => {
    const sim = labWorld();
    applySolution(sim, { requests: requestsWith(3, restconfLabPutVlan(A.sw3, 30, 'Voice')) });
    expect(vlanName(sim, 'SW3', 30)).toBe('Voice');
    expect(passes(sim)).toEqual({ ...ALL_PASS, 'vlan-30': false });
    // putting it right: the PUT replaces the entry (204), and the marks are full
    expect(rest(sim, restconfLabPutVlan(A.sw3)).status).toBe(204);
    sim.runToIdle();
    expect(passes(sim)).toEqual(ALL_PASS);
  }, LAB_TEST_TIMEOUT_MS);

  it('the API task: VLAN 30 typed on the consoles has the effect but leaves no API request', () => {
    const sim = labWorld();
    applySolution(sim, { requests: requestsOf([restconfLabGetInterfaces(A.sw2)]) });
    for (const name of ['SW1', 'SW2', 'SW3']) typeConfig(sim, name, ['vlan 30', 'name VOICE']);
    sim.runToIdle();
    expect(passes(sim)).toEqual({ ...ALL_PASS, 'through-the-api': false });
    const api = evaluateLab(sim, LAB).results.find((r) => r.task === 'through-the-api')!;
    expect(api.misconception).toBe('console-change-counted-as-api');
  }, LAB_TEST_TIMEOUT_MS);

  it('the API task: VLAN 30 typed on the consoles plus an accepted PUT to vlan-list=300 (a typo) is no API request for VLAN 30', () => {
    const sim = labWorld();
    for (const name of ['SW1', 'SW2', 'SW3']) typeConfig(sim, name, ['vlan 30', 'name VOICE']);
    const typo = (address: string): string => restconfLabPutVlan(address, 300);
    expect(typo(A.sw1)).toContain('/vlan-list=300 ');
    expect(typo(A.sw1)).toContain('{"id":300,"name":"VOICE"}');
    applySolution(sim, { requests: requestsOf([restconfLabGetInterfaces(A.sw2), typo(A.sw1), typo(A.sw2), typo(A.sw3)]) });
    // every switch accepted the typo (201) and logged it; its path holds "vlan-list=30" as a substring
    const typoPath = `${VLAN_PATH}0`;
    expect(logOf(sim, 'SW1')).toEqual([['PUT', typoPath, 201]]);
    expect(logOf(sim, 'SW2')).toEqual([
      ['GET', INTERFACES_PATH, 200],
      ['PUT', typoPath, 201],
    ]);
    expect(logOf(sim, 'SW3')).toEqual([['PUT', typoPath, 201]]);
    for (const name of ['SW1', 'SW2', 'SW3']) expect(vlanName(sim, name, 300), name).toBe('VOICE');
    expect(passes(sim)).toEqual({ ...ALL_PASS, 'through-the-api': false });
    const api = evaluateLab(sim, LAB).results.find((r) => r.task === 'through-the-api')!;
    expect(api.misconception).toBe('console-change-counted-as-api');
    expect(api.assertions.map((a) => a.pass)).toEqual([false, false, false]);
    expect(api.assertions[0]!.detail).toContain(`path=${VLAN_PATH} `);
  }, LAB_TEST_TIMEOUT_MS);

  it('the API task: a PUT without its Content-Type is refused 415 and changes nothing', () => {
    const sim = labWorld();
    const bare = restconfLabPutVlan(A.sw1).replace(` ${JSON_HEADER}`, '');
    expect(bare).not.toContain('Content-Type');
    applySolution(sim, { requests: requestsWith(1, bare) });
    expect(logOf(sim, 'SW1')).toEqual([['PUT', VLAN_PATH, 415]]);
    expect(vlanName(sim, 'SW1', 30)).toBeUndefined();
    expect(passes(sim)).toEqual({ ...ALL_PASS, 'vlan-30': false, 'through-the-api': false });
  }, LAB_TEST_TIMEOUT_MS);

  it('the API task: a POST to the VLAN container makes the VLAN (201) but is not the PUT the task asks for', () => {
    const sim = labWorld();
    const post = `rest POST https://${A.sw1}/restconf/data/nf-native:native/vlan ${AUTH} ${JSON_HEADER} -d {"nf-native:vlan-list":[{"id":30,"name":"VOICE"}]}`;
    applySolution(sim, { requests: requestsWith(1, post) });
    expect(logOf(sim, 'SW1')).toEqual([['POST', '/restconf/data/nf-native:native/vlan', 201]]);
    expect(vlanName(sim, 'SW1', 30)).toBe('VOICE');
    expect(passes(sim)).toEqual({ ...ALL_PASS, 'through-the-api': false });
  }, LAB_TEST_TIMEOUT_MS);

  it('the API task: a body whose key differs from the URL\'s is refused 400 and changes nothing', () => {
    const sim = labWorld();
    const mismatch = restconfLabPutVlan(A.sw2).replace('"id":30', '"id":31');
    applySolution(sim, { requests: requestsWith(2, mismatch) });
    expect(logOf(sim, 'SW2')).toEqual([
      ['GET', INTERFACES_PATH, 200],
      ['PUT', VLAN_PATH, 400],
    ]);
    expect(vlanName(sim, 'SW2', 30)).toBeUndefined();
    expect(vlanName(sim, 'SW2', 31)).toBeUndefined();
    expect(passes(sim)).toEqual({ ...ALL_PASS, 'vlan-30': false, 'through-the-api': false });
  }, LAB_TEST_TIMEOUT_MS);
});

describe('ccna3-restconf-change: determinism (§3.8 step 7)', () => {
  /** The lab's script: load, boot, the solution, the learner's requests (journaled cliExec), some quiet time. */
  function script(): Simulation {
    const sim = labWorld({ traceCapacity: TRACE_CAPACITY });
    applySolution(sim);
    sim.runFor(10 * SEC);
    return sim;
  }

  it('the journal replays the learner\'s requests exactly: byte-identical trace and snapshot JSON', () => {
    const live = script();
    const journal = live.journal();
    expect(journal.entries.filter((e) => e.op.op === 'cliExec' && e.op.line.startsWith('rest ')).map((e) => (e.op.op === 'cliExec' ? e.op.line : ''))).toEqual([
      ...RESTCONF_LAB_REQUESTS[0]!.lines,
    ]);
    const replay = createReplay(journal, { traceCapacity: TRACE_CAPACITY });
    const r = replay.advance(live.position());
    expect(r.reached).toBe(true);
    expect(replay.position()).toEqual(live.position());
    const head = journal.origin.counters.traceHead;
    expect(JSON.stringify(replay.sim.trace(head).events)).toBe(JSON.stringify(live.trace(head).events));
    expect(JSON.stringify(replay.sim.snapshot())).toBe(JSON.stringify(live.snapshot()));
    expect(logOf(replay.sim, 'SW2')).toEqual(logOf(live, 'SW2'));
    expect(evaluateLab(replay.sim, LAB).score).toBe(100);
  }, LAB_TEST_TIMEOUT_MS);

  it('three runs with one seed give byte-identical trace and snapshot JSON', () => {
    const run = (): string => {
      const sim = script();
      return JSON.stringify({ trace: sim.trace(0).events, snapshot: sim.snapshot() });
    };
    const a = run();
    expect(run()).toBe(a);
    expect(run()).toBe(a);
  }, LAB_TEST_TIMEOUT_MS);
});
