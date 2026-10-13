/**
 * labs.ccna3.automation — the W6 auto labs 38 and 40 [S32], proved (ARCHITECTURE-P3 §7 W6 "auto", §11.1 lessons 38 and
 * 40, §11.2, §3.8 (step 8 for lab 40), §5.6, D21, D22; ruling R58 (c)). The local copy of the checks of the sim
 * builder's `labs.ccna3.solutions.test.ts`, filtered to the two automation labs, plus what only these labs need.
 *
 * Lab 38 `ccna3-restconf-change`:
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
 *   Lab-specific cases: the learner's path on PC1's console, job by job (the GET prints the note inside the JSON, a GET
 *   without credentials is 401, each PUT is 201 then 204, the note acted on through the API instead of the console); one
 *   near-miss wrong answer (or more) per task — a GET refused 401 and a GET of the wrong switch (read), the note's VLAN
 *   made on the switch that holds the note (act), a VLAN named `Voice` (the effect), the VLAN typed on the consoles, the
 *   VLAN typed on the consoles plus an accepted PUT to `vlan-list=300` (the path is matched whole, not as a substring), a
 *   PUT without its Content-Type (415), a POST, a PUT whose body key differs from the URL's (400) (the API task); the
 *   R58 (c) near miss the other way: a PUT to VLAN 30's entry written with a trailing `/`, or with the module repeated on
 *   a later step, is the same entry, logged under the canonical path and graded as the API change; and §3.8 step 7's
 *   determinism: the journal replays the `cliExec` requests to byte-identical trace and snapshot JSON, and three runs
 *   with one seed are byte-identical.
 *
 * Lab 40 `ccna3-script-inventory` ([S32], §3.8 step 8, after the NF-DEVHOST flip):
 *   • metadata and file rules as above; the world: DEV1 is the real NF-DEVHOST (`pc.nfdevhost`) with `inventory.py` in
 *     its `files:` store from the lab document (schema 1.3), SW1 and SW2 accept API logins, SW3 accepts none (no `ip
 *     http authentication local`), no run and no request yet;
 *   • UNSOLVED: every task fails with a detail; SOLVED — the fix on SW3 through `configure`, then `SCRIPT_LAB_RUNS` typed
 *     on DEV1's console as the generic solutions test types learner lines: full marks; read-only and repeatable; the fix
 *     alone (no run) passes nothing; the grader never runs the script (no `script-runs` row and no request appear while
 *     it grades, and a copy of the world settles within the clone's event cap with no run in it);
 *   • the learner's path: the first run reads SW1 and SW2, then stops with an HTTPError traceback naming 401 and SW3's
 *     address (the `script-runs` row says failed, SW3 logs a 401); `show restconf` on SW3 says why; the fix on SW3's
 *     console; the second run from the automation workspace completes with the exact inventory, one strictly sequential
 *     GET per switch, and full marks;
 *   • one near miss or more per task — the run before the fix, a copy of the script run under another name, a run
 *     stopped from the workspace (the run); the script edited to skip SW3, and the fix typed on the wrong switch (every
 *     switch read);
 *   • determinism: the journal (the console fix, the `python` job) replays to byte-identical trace and snapshot JSON, and
 *     three runs with one seed are byte-identical.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DeviceId, SessionId } from '../src/contracts/ids.js';
import { labDocumentOf, scenarioOf } from '../src/contracts/lab-document.js';
import type { LabAssertion, ScenarioInfo } from '../src/contracts/scenario.js';
import { scenarioMeta } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { RestconfLogRow, ScriptRunRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID_1_3, schemaIdFor, type Topology } from '../src/contracts/topology.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { CCNA3_MODULES } from '../src/curriculum/ccna3/lessons.js';
import { NF_DEVHOST_TYPE } from '../src/device/catalog/computers.js';
import { createCatalog } from '../src/device/catalog/index.js';
import { labDocumentFromJson, labDocumentToJson, validateLabDocument } from '../src/io/lab-schema.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import type { ScriptHostStateView, ScriptRunView } from '../src/protocols/script-host.js';
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
  SCRIPT_LAB_ADDRESSES,
  SCRIPT_LAB_FAULTY,
  SCRIPT_LAB_FILE,
  SCRIPT_LAB_INVENTORY,
  SCRIPT_LAB_PATH,
  SCRIPT_LAB_RUNS,
  SCRIPT_LAB_SECRET,
  SCRIPT_LAB_USER,
  ccna3RestconfChange,
  ccna3ScriptInventory,
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
const SLAB = ccna3ScriptInventory;
const A = RESTCONF_LAB_ADDRESSES;
const D = SCRIPT_LAB_ADDRESSES;
const AUTH = `-u ${RESTCONF_LAB_USER}:${RESTCONF_LAB_SECRET}`;
const JSON_HEADER = `-H "Content-Type: ${RESTCONF_LAB_JSON_TYPE}"`;
const catalog = createCatalog(PROCESS_FACTORIES);

type Requests = typeof RESTCONF_LAB_REQUESTS;

/** The lab's world as `loadScenario` builds it: the lab seed, the lab stamp, its scheduled faults, booted and settled. */
function labWorld(opts: { traceCapacity?: number } = {}, lab: ScenarioInfo = LAB): Simulation {
  const sim = createSimulation({ seed: lab.seed ?? 1, ...opts });
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

/** Type `line` on a fresh console of `host` (a job), run until the job has ended, and return what the session printed. */
function job(sim: Simulation, host: string, line: string): string {
  const s: SessionId = sim.cli.open(idOf(sim, host), 'console');
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
  return text;
}

interface Reply {
  readonly text: string;
  readonly status?: number;
  /** The printed body (after the blank line that ends the headers). */
  readonly body: string;
}

/** Type `line` on a fresh console of PC1 (a `rest` job), run until the job has ended, and read what it printed. */
function rest(sim: Simulation, line: string): Reply {
  const text = job(sim, 'PC1', line);
  const m = /^HTTP\/1\.1 (\d{3}) /.exec(text);
  const lines = text.split('\n');
  const body = lines.slice(lines.indexOf('') + 1).join('\n').replace(/\n$/, '');
  return m === null ? { text, body: '' } : { text, status: Number(m[1]), body };
}

/** Pass flag of each task of `lab`, by id. */
function passes(sim: Simulation, lab: ScenarioInfo = LAB): Record<string, boolean> {
  return Object.fromEntries(evaluateLab(sim, lab).results.map((r) => [r.task, r.pass]));
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

/** `show restconf` on a switch's console. */
function showRestconf(sim: Simulation, name: string): string {
  const s = sim.cli.open(idOf(sim, name), 'console');
  const out = sim.cli.exec(s, 'show restconf').output;
  sim.cli.close(s);
  return out;
}

/** The lesson of the skeleton that points at `lab`, with the title of its module. */
const homeOf = (lab: ScenarioInfo): { id?: string; module?: string } => {
  const home = CCNA3_MODULES.flatMap((m) => m.lessons.map((l) => ({ l, m }))).find((x) => x.l.lab === lab.name);
  return { ...(home !== undefined ? { id: home.l.id, module: home.m.title } : {}) };
};

/** The metadata and catalog rules every CCNA 3 lab meets (labs.ccna3.solutions), for one lab. */
function expectLabMetadata(lab: ScenarioInfo, learnerHosts: readonly string[]): void {
  expect(lab.category).toBe('ccna3-lab');
  expect(lab.course).toBe('CCNA 3');
  expect(lab.topic).toBe(homeOf(lab).module);
  expect(lab.topic).toBe('Automating the network');
  expect(lab.seed).toBeTypeOf('number');
  const meta = scenarioMeta(lab);
  expect(structuredClone(meta)).toEqual(meta);
  expect(meta).not.toHaveProperty('solution');
  const topo = lab.build();
  expect([...(lab.requires ?? [])].sort()).toEqual([...new Set(topo.devices.map((d) => d.type))].sort());
  for (const type of lab.requires ?? []) expect(catalog.get(type), type).toBeDefined();
  const ids = (lab.tasks ?? []).map((t) => t.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect((lab.tasks ?? []).reduce((n, t) => n + t.points, 0)).toBe(100);
  for (const t of lab.tasks ?? []) {
    expect(t.points).toBeGreaterThan(0);
    for (const a of t.assertions) expect(LAB_KINDS, `${t.id}: ${a.kind}`).toContain(a.kind);
    for (const dep of t.dependsOn ?? []) expect(ids).toContain(dep);
  }
  const names = topo.devices.map((d) => d.name);
  expect(Object.keys(lab.solution ?? {}).length).toBeGreaterThan(0);
  for (const name of Object.keys(lab.solution ?? {})) expect(names).toContain(name);
  for (const host of learnerHosts) expect(names).toContain(host);
}

/** The [S37] lab document round trip: JSON text, schema, scenario. */
function expectRoundTrip(lab: ScenarioInfo): void {
  const doc = labDocumentOf(lab);
  const json = JSON.parse(labDocumentToJson(doc)) as unknown;
  const checked = validateLabDocument(json);
  expect(checked.ok ? [] : checked.errors).toEqual([]);
  const back = scenarioOf(labDocumentFromJson(labDocumentToJson(doc)));
  expect(back.build()).toEqual(lab.build());
  expect(back.tasks).toEqual(lab.tasks);
  expect(back.solution).toEqual(lab.solution);
  expect(back.category).toBe('ccna3-lab');
}

/** The grader's settle of a copy (sim/lab-checks.ts `settledClone`; no cut cable or err-disabled port here). */
function cloneSettle(sim: Simulation): { stats: ReturnType<Simulation['runToIdle']>; copy: Simulation } {
  const copy = createSimulation({ seed: sim.seed, catalog: sim.catalog, journal: false });
  copy.loadTopology(sim.exportTopology());
  return { stats: copy.runToIdle(LAB_CLONE_BOOT_EVENTS), copy };
}

const VLAN_PATH = '/restconf/data/nf-native:native/vlan/vlan-list=30';
const INTERFACES_PATH = '/restconf/data/ietf-interfaces:interfaces';

describe('the automation lab file', () => {
  it('holds the two automation labs of the course, lab 38 then lab 40, and joins the catalogue in course order', () => {
    expect(CCNA3_AUTOMATION_LABS.map((l) => l.name)).toEqual(['ccna3-restconf-change', 'ccna3-script-inventory']);
    expect(CCNA3_AUTOMATION_LABS[0]).toBe(LAB);
    expect(CCNA3_AUTOMATION_LABS[1]).toBe(SLAB);
    expect(ccna3.CCNA3_AUTOMATION_LABS).toBe(CCNA3_AUTOMATION_LABS);
    expect(ccna3.RESTCONF_LAB_REQUESTS).toBe(RESTCONF_LAB_REQUESTS);
    expect(ccna3.SCRIPT_LAB_RUNS).toBe(SCRIPT_LAB_RUNS);
    const order = ccna3.CCNA3_LAB_ORDER;
    const landed = ccna3.CCNA3_LABS.map((l) => l.name);
    expect(landed).toEqual(order.filter((n) => landed.includes(n)));
    // every lab of the approved plan has landed: lab 40 was the last (after the [S32] flip)
    expect(landed).toEqual([...order]);
    for (const lab of [LAB, SLAB]) {
      expect(ccna3.CCNA3_LABS).toContain(lab);
      expect(SCENARIOS.filter((s) => s.name === lab.name).map((s) => s.category)).toEqual(['ccna3-lab']);
    }
    expect(landed.indexOf(LAB.name)).toBeGreaterThan(landed.indexOf('ccna3-troubleshoot-enterprise'));
    expect(landed.indexOf(SLAB.name)).toBe(landed.indexOf(LAB.name) + 1);
    expect(landed.at(-1)).toBe(SLAB.name);
  });

  it('imports only the contracts, the kit and the templates, and exports one array under its fixed name', () => {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sim', 'scenarios', 'ccna3', 'automation.ts');
    const text = readFileSync(file, 'utf8');
    const specifiers = [...text.matchAll(/^import[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]);
    for (const s of specifiers) expect(s, s).toMatch(/^\.\.\/\.\.\/\.\.\/contracts\/[a-z-]+\.js$|^\.\.\/kit\.js$|^\.\.\/templates\.js$/);
    expect(text.match(/export const \w+: readonly ScenarioInfo\[\]/g)).toEqual(['export const CCNA3_AUTOMATION_LABS: readonly ScenarioInfo[]']);
    // every exported name is prefixed, since ccna3/index.ts re-exports the file with `export *`
    const exported = [...text.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]!);
    for (const name of exported) expect(name, name).toMatch(/^(RESTCONF_LAB_|restconfLab|ccna3Restconf|SCRIPT_LAB_|ccna3Script|CCNA3_AUTOMATION_)/);
    // lab 40's names are exactly these
    expect(exported.filter((n) => /^(SCRIPT_LAB_|ccna3Script)/.test(n)).sort()).toEqual(
      ['SCRIPT_LAB_ADDRESSES', 'SCRIPT_LAB_FAULTY', 'SCRIPT_LAB_FILE', 'SCRIPT_LAB_INVENTORY', 'SCRIPT_LAB_PATH', 'SCRIPT_LAB_RUNS', 'SCRIPT_LAB_SECRET', 'SCRIPT_LAB_USER', 'ccna3ScriptInventory'].sort(),
    );
  });
});

describe('ccna3-restconf-change: the lab file', () => {
  it('describes itself as lab 38 of the CCNA 3 course, with structured-clone safe metadata and a catalog it uses', () => {
    expect(LAB.name).toBe('ccna3-restconf-change');
    expect(homeOf(LAB).id).toBe('ccna3-38-talking-to-devices-through-apis');
    expect(LAB.instructions).toContain('allow about a minute before the first request');
    expect(LAB.instructions).toContain('trunks forward 30 s after that');
    expectLabMetadata(LAB, RESTCONF_LAB_REQUESTS.map((r) => r.from));
    expect((LAB.tasks ?? []).map((t) => t.id)).toEqual(['read-interfaces', 'act-on-note', 'vlan-30', 'through-the-api']);
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

  it('survives the lab document round trip ([S37]): JSON text, schema, scenario', () => {
    expectRoundTrip(LAB);
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
      const out = showRestconf(sim, name);
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
    expect(cloneSettle(labWorld()).stats.stopped, 'unsolved').toBeUndefined();
    const solved = labWorld();
    applySolution(solved);
    // the API's changes are running configuration: the export carries them to the copy
    const sw1 = solved.exportTopology().devices.find((d) => d.name === 'SW1')!.runningConfig ?? '';
    expect(sw1).toContain('vlan 30\n name VOICE\n');
    expect(cloneSettle(solved).stats.stopped, 'solved').toBeUndefined();
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

  it('the API task (R58 (c)): a PUT to VLAN 30\'s entry with a trailing / or a repeated module is that entry, logged canonically and graded', () => {
    const sim = labWorld();
    // the same entry written three ways: a trailing slash (SW1), the module repeated on every later step (SW2), as printed (SW3)
    const trailing = restconfLabPutVlan(A.sw1).replace('/vlan-list=30 ', '/vlan-list=30/ ');
    const repeated = restconfLabPutVlan(A.sw2).replace('/nf-native:native/vlan/vlan-list=30 ', '/nf-native:native/nf-native:vlan/nf-native:vlan-list=30 ');
    expect(trailing).toContain(`https://${A.sw1}${VLAN_PATH}/ `);
    expect(repeated).toContain(`https://${A.sw2}/restconf/data/nf-native:native/nf-native:vlan/nf-native:vlan-list=30 `);
    applySolution(sim, { requests: requestsOf([restconfLabGetInterfaces(A.sw2), trailing, repeated, restconfLabPutVlan(A.sw3)]) });
    // every switch accepted its PUT (201) and logged the canonical path of the entry it changed, never the text as typed
    expect(logOf(sim, 'SW1')).toEqual([['PUT', VLAN_PATH, 201]]);
    expect(logOf(sim, 'SW2')).toEqual([
      ['GET', INTERFACES_PATH, 200],
      ['PUT', VLAN_PATH, 201],
    ]);
    expect(logOf(sim, 'SW3')).toEqual([['PUT', VLAN_PATH, 201]]);
    for (const name of ['SW1', 'SW2', 'SW3']) expect(vlanName(sim, name, 30), name).toBe('VOICE');
    expect(passes(sim)).toEqual(ALL_PASS);
    expect(evaluateLab(sim, LAB).score).toBe(100);
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

// ── lab 40 [S32] ─────────────────────────────────────────────────────────────

/** Lab 40's world as `loadScenario` builds it (booted and settled). */
const scriptWorld = (opts: { traceCapacity?: number } = {}): Simulation => labWorld(opts, SLAB);

/** The fix through `configure` (the reference solution, by default the lab's), then `runs` typed on the hosts' consoles. */
function solveScript(sim: Simulation, opts: { solution?: Readonly<Record<string, readonly string[]>>; runs?: typeof SCRIPT_LAB_RUNS } = {}): void {
  for (const [name, lines] of Object.entries(opts.solution ?? SLAB.solution ?? {})) typeOn(sim, name, lines);
  sim.runToIdle();
  typeRequests(sim, opts.runs ?? SCRIPT_LAB_RUNS);
}

/** DEV1's script host StateView (display only; the grader reads the table). */
const hostView = (sim: Simulation): ScriptHostStateView =>
  sim.device(idOf(sim, 'DEV1'))!.processes.get('script-host')!.stateSnapshot().state as unknown as ScriptHostStateView;
/** DEV1's `script-runs` rows: [run, file, state, requests, error?]. */
const runRows = (sim: Simulation): ScriptRunRow[] => sim.device(idOf(sim, 'DEV1'))!.tables.get<ScriptRunRow>('script-runs')?.rows() ?? [];

/** Start `file` from DEV1's automation workspace (`hostRequest script.run`); returns the run's token (the ticket). */
function workspaceRun(sim: Simulation, file: string): string {
  return sim.hostRequest(idOf(sim, 'DEV1'), { app: 'script.run', file }).requestId;
}

/** The workspace's run with token `token`, once it is no longer running (at most 5 s of simulated time). */
function finished(sim: Simulation, token: string): ScriptRunView {
  let run: ScriptRunView | undefined;
  for (let i = 0; i < 100; i++) {
    run = hostView(sim).runs.filter((r) => r.token === token).at(-1);
    if (run !== undefined && run.state !== 'running') break;
    sim.runFor(SEC / 20);
  }
  expect(run, `a run with token ${token}`).toBeDefined();
  expect(run!.state, `the run ${run!.run} ended`).not.toBe('running');
  return run!;
}

/** Save `content` as `path` in DEV1's store through the workspace (`file.write`). */
function save(sim: Simulation, path: string, content: string): void {
  sim.hostRequest(idOf(sim, 'DEV1'), { app: 'file.write', path, content });
  sim.runToIdle();
}

const SCRIPT_PASS = { 'inventory-completed': true, 'every-switch-read': true };
const SWITCHES = ['SW1', 'SW2', 'SW3'] as const;
/** The URL the script GETs on a switch. */
const scriptUrl = (address: string): string => `https://${address}${SCRIPT_LAB_PATH}`;
/** The traceback's last line of the run SW3 refuses. */
const SW3_REFUSAL = `requests.exceptions.HTTPError: 401 Client Error: Unauthorized for url: ${scriptUrl(D.sw3)}`;
/** What the inventory prints for SW1 and SW2 (each with its described interfaces), and for SW3 once it answers. */
const INVENTORY_SW1_SW2 = [
  `${D.sw1} has 28 interfaces`,
  '  FastEthernet0/1: DEV1 automation host',
  '  GigabitEthernet0/2: trunk to SW2',
  `${D.sw2} has 28 interfaces`,
  '  GigabitEthernet0/1: trunk to SW1',
  '  GigabitEthernet0/2: trunk to SW3',
];
const INVENTORY = [...INVENTORY_SW1_SW2, `${D.sw3} has 28 interfaces`, '  GigabitEthernet0/1: trunk to SW2', 'Inventory complete: 84 interfaces on 3 switches', ''].join('\n');

describe('ccna3-script-inventory: the lab file', () => {
  it('describes itself as lab 40 of the CCNA 3 course, with structured-clone safe metadata and a catalog it uses', () => {
    expect(SLAB.name).toBe('ccna3-script-inventory');
    expect(homeOf(SLAB).id).toBe('ccna3-40-scripting-the-network');
    expectLabMetadata(SLAB, SCRIPT_LAB_RUNS.map((r) => r.from));
    expect((SLAB.tasks ?? []).map((t) => t.id)).toEqual(['inventory-completed', 'every-switch-read']);
    // the developer host is the real NF-DEVHOST of the W6 flip
    expect(SLAB.requires).toContain(NF_DEVHOST_TYPE);
    expect(catalog.get(NF_DEVHOST_TYPE)?.model).toBe('NF-DEVHOST');
    expect(SLAB.instructions).toContain('allow about a minute before the first run');
    expect(SLAB.instructions).toContain('trunks forward 30 s after that');
  });

  it('grades what §3.8 step 8 names: the newest run of inventory.py on DEV1, and the GET of the interfaces each switch logged', () => {
    const [run, read] = SLAB.tasks ?? [];
    expect(run!.assertions).toEqual([expect.objectContaining({ kind: 'fact', device: 'DEV1', fact: 'automation.lastRun', subject: 'inventory.py', equals: 'completed' })]);
    expect(read!.assertions.map((a) => (a.kind === 'table' ? [a.device, a.table, a.where, a.exists] : a.kind))).toEqual(
      SWITCHES.map((sw) => [sw, 'restconf-log', { method: 'GET', path: INTERFACES_PATH, status: 200, client: D.dev1 }, true]),
    );
    expect(SCRIPT_LAB_PATH).toBe(INTERFACES_PATH);
    // the fix is the solution, the run is the learner's (a job, which configure refuses)
    expect(SLAB.solution).toEqual({ SW3: ['ip http authentication local'] });
    expect(SCRIPT_LAB_FAULTY).toEqual({ device: 'SW3', line: 'ip http authentication local' });
    expect(SCRIPT_LAB_RUNS).toEqual([{ from: 'DEV1', lines: ['python inventory.py'] }]);
  });

  it('prints the run line, the file and the credentials in its instructions, and never names the faulty switch or its fix', () => {
    expect(SLAB.instructions).toContain(`\`python ${SCRIPT_LAB_FILE}\``);
    expect(SLAB.instructions).toContain(`\`type ${SCRIPT_LAB_FILE}\``);
    expect(SLAB.instructions).toContain(SCRIPT_LAB_SECRET);
    expect(SLAB.instructions).toContain('`show restconf`');
    // the learner finds the switch in the traceback and its cause on that switch
    expect(SLAB.instructions).not.toContain('authentication local');
    expect(SLAB.instructions).not.toMatch(/SW3 (refuses|answers 401|has no)/);
    for (const t of SLAB.tasks ?? []) expect(`${t.title} ${t.description} ${t.hint ?? ''}`, t.id).not.toContain('authentication local');
  });

  it('saves the script in DEV1\'s files: store through the lab document (schema 1.3), the switches it loops over in order', () => {
    const topo = SLAB.build();
    expect(topo.profile).toBe('P3');
    expect(topo.schema).toBe(TOPOLOGY_SCHEMA_ID_1_3);
    expect(topo.schema).toBe(schemaIdFor(topo));
    const dev1 = topo.devices.find((d) => d.name === 'DEV1')!;
    expect(dev1.type).toBe(NF_DEVHOST_TYPE);
    expect(dev1.files).toEqual([{ path: 'inventory.py', content: SCRIPT_LAB_INVENTORY }]);
    for (const d of topo.devices.filter((x) => x.name !== 'DEV1')) expect(d.files, d.name).toBeUndefined();
    expect(SCRIPT_LAB_INVENTORY).toContain(`SWITCHES = ["${D.sw1}", "${D.sw2}", "${D.sw3}"]`);
    expect(SCRIPT_LAB_INVENTORY).toContain(`AUTH = ("${SCRIPT_LAB_USER}", "${SCRIPT_LAB_SECRET}")`);
    expect(SCRIPT_LAB_INVENTORY).toContain('import requests\n');
    expect(SCRIPT_LAB_INVENTORY).toContain('    r.raise_for_status()\n');
    expect(SCRIPT_LAB_INVENTORY.endsWith('\n')).toBe(true);
    // original wording: no vendor name, the IETF interfaces model only
    expect(SCRIPT_LAB_INVENTORY).not.toMatch(/cisco|ios|juniper|arista/i);
  });

  it('survives the lab document round trip ([S37]) with the script in it: JSON text, schema, scenario', () => {
    expectRoundTrip(SLAB);
    const back = scenarioOf(labDocumentFromJson(labDocumentToJson(labDocumentOf(SLAB))));
    expect(back.build().devices.find((d) => d.name === 'DEV1')!.files).toEqual([{ path: SCRIPT_LAB_FILE, content: SCRIPT_LAB_INVENTORY }]);
  });
});

describe('ccna3-script-inventory: the world', () => {
  it('loads DEV1 as an NF-DEVHOST with the script in its store; SW1 and SW2 accept API logins, SW3 accepts none; nothing has run', () => {
    const sim = scriptWorld();
    expect(sim.profile).toBe('P3');
    const dev1 = sim.device(idOf(sim, 'DEV1'))!;
    expect(dev1.spec.type).toBe(NF_DEVHOST_TYPE);
    expect(dev1.processes.has('script-host')).toBe(true);
    expect(dev1.files!('files').map((f) => f.path)).toEqual(['inventory.py']);
    expect(dev1.readFile!('files', 'inventory.py')?.content).toBe(SCRIPT_LAB_INVENTORY);
    expect(dev1.port('GigabitEthernet0')?.l3.ipv4?.address).toBe(D.dev1);
    const shell = sim.cli.open(idOf(sim, 'DEV1'), 'console');
    expect(sim.cli.exec(shell, 'dir').output).toContain('inventory.py');
    sim.cli.close(shell);
    // DEV1's port is an edge port in VLAN 99
    const devPort = sim.device(idOf(sim, 'SW1'))!.running.render().split('interface FastEthernet0/1\n')[1]?.split('!')[0] ?? '';
    expect(devPort).toContain('switchport access vlan 99');
    expect(devPort).toContain('spanning-tree portfast');
    for (const name of SWITCHES) {
      const out = showRestconf(sim, name);
      expect(out.split('\n')[0], name).toBe('RESTCONF API: on, answering on TCP port 443 (HTTPS, simulated TLS)');
      if (name === 'SW3') expect(out, name).toContain('Logins: none accepted until "ip http authentication local" is configured');
      else expect(out, name).toContain(`(${SCRIPT_LAB_USER})`);
      expect(logOf(sim, name), name).toEqual([]);
    }
    expect(runRows(sim)).toEqual([]);
    expect(hostView(sim).runs).toEqual([]);
  }, LAB_TEST_TIMEOUT_MS);
});

describe('ccna3-script-inventory: graded', () => {
  it('fails every task before the student starts, and says why', () => {
    const status = evaluateLab(scriptWorld(), SLAB);
    expect(status.results.filter((r) => r.pass).map((r) => r.task)).toEqual([]);
    expect(status.score).toBe(0);
    for (const r of status.results) expect(r.assertions.some((a) => !a.pass && (a.detail ?? '') !== ''), r.task).toBe(true);
    const run = status.results.find((r) => r.task === 'inventory-completed')!;
    expect(run.assertions[0]!.detail).toContain('DEV1 automation.lastRun of inventory.py is not set, expected completed.');
  }, LAB_TEST_TIMEOUT_MS);

  it('scores full marks with the fix and the learner\'s run, read-only and repeatably; the grader never runs the script', () => {
    const sim = scriptWorld();
    solveScript(sim);
    expect(runRows(sim).map((r) => [r.run, r.file, r.state, r.requests])).toEqual([['r1', 'inventory.py', 'completed', 3]]);
    for (const name of SWITCHES) expect(logOf(sim, name), name).toEqual([['GET', INTERFACES_PATH, 200]]);
    const now = sim.now;
    const head = sim.trace(0).next;
    const pdus = sim.snapshot().pduCount;
    const first = evaluateLab(sim, SLAB);
    expect(first.results.filter((r) => !r.pass).map((r) => `${r.task}: ${r.assertions.map((a) => a.detail ?? '').join(' ')}`)).toEqual([]);
    expect(first.score).toBe(first.total);
    expect(evaluateLab(sim, SLAB)).toEqual(first);
    expect(sim.now).toBe(now);
    expect(sim.trace(0).next).toBe(head);
    expect(sim.snapshot().pduCount).toBe(pdus);
    // no run and no request came from grading
    expect(runRows(sim)).toHaveLength(1);
    for (const name of SWITCHES) expect(logOf(sim, name), name).toHaveLength(1);
  }, LAB_TEST_TIMEOUT_MS);

  it('the fix alone passes nothing: the run is the learner\'s (configure refuses a job)', () => {
    const sim = scriptWorld();
    solveScript(sim, { runs: [] });
    expect(passes(sim, SLAB)).toEqual({ 'inventory-completed': false, 'every-switch-read': false });
    const r = sim.configure(idOf(sim, 'DEV1'), [SCRIPT_LAB_RUNS[0]!.lines[0]!]);
    expect(r.ok).toBe(false);
    sim.runToIdle();
    expect(runRows(sim)).toEqual([]);
  }, LAB_TEST_TIMEOUT_MS);

  it('a copy of the unsolved and of the solved world reaches idle within the grader clone\'s event cap, with the script and no run', () => {
    const unsolved = cloneSettle(scriptWorld());
    expect(unsolved.stats.stopped, 'unsolved').toBeUndefined();
    const solvedWorld = scriptWorld();
    solveScript(solvedWorld);
    // the export carries the script (schema 1.3) and the fix; never a run
    const saved = solvedWorld.exportTopology();
    expect(saved.devices.find((d) => d.name === 'DEV1')!.files).toEqual([{ path: SCRIPT_LAB_FILE, content: SCRIPT_LAB_INVENTORY }]);
    expect(saved.devices.find((d) => d.name === 'SW3')!.runningConfig ?? '').toContain('ip http authentication local');
    const solved = cloneSettle(solvedWorld);
    expect(solved.stats.stopped, 'solved').toBeUndefined();
    const copyDev = solved.copy.device(idOf(solved.copy, 'DEV1'))!;
    expect(copyDev.readFile!('files', SCRIPT_LAB_FILE)?.content).toBe(SCRIPT_LAB_INVENTORY);
    expect(copyDev.tables.get<ScriptRunRow>('script-runs')?.rows() ?? []).toEqual([]);
  }, LAB_TEST_TIMEOUT_MS);

  it('the learner path: the first run stops at SW3 with a 401 traceback; show restconf says why; the fix; the second run completes', () => {
    const sim = scriptWorld();
    // 1. the first run, from DEV1's command prompt: SW1 and SW2 are read, SW3 refuses the login
    const printed = job(sim, 'DEV1', `python ${SCRIPT_LAB_FILE}`);
    expect(printed.startsWith(`${INVENTORY_SW1_SW2.join('\n')}\n`)).toBe(true);
    expect(printed).toContain('Traceback (most recent call last):');
    expect(printed.trimEnd().split('\n').at(-1)).toBe(SW3_REFUSAL);
    expect(runRows(sim).map((r) => [r.run, r.state, r.requests, r.error])).toEqual([['r1', 'failed', 3, SW3_REFUSAL]]);
    expect(logOf(sim, 'SW1')).toEqual([['GET', INTERFACES_PATH, 200]]);
    expect(logOf(sim, 'SW2')).toEqual([['GET', INTERFACES_PATH, 200]]);
    expect(logOf(sim, 'SW3')).toEqual([['GET', INTERFACES_PATH, 401]]);
    const failed = evaluateLab(sim, SLAB);
    expect(failed.results.map((r) => [r.task, r.pass])).toEqual([['inventory-completed', false], ['every-switch-read', false]]);
    expect(failed.results[0]!.assertions[0]!.detail).toContain('DEV1 automation.lastRun of inventory.py is failed, expected completed.');
    expect(failed.results[1]!.assertions.map((a) => a.pass)).toEqual([true, true, false]);
    expect(failed.results[1]!.misconception).toBe('refusal-blamed-on-the-script');
    // 2. why: SW3 checks no login, and its log shows the refused GET
    const why = showRestconf(sim, 'SW3');
    expect(why).toContain('Logins: none accepted until "ip http authentication local" is configured');
    expect(why).toContain(INTERFACES_PATH);
    // 3. the fix on SW3's console
    typeConfig(sim, 'SW3', ['ip http authentication local']);
    expect(showRestconf(sim, 'SW3')).toContain(`(${SCRIPT_LAB_USER})`);
    // 4. the second run, from the automation workspace: the whole inventory, one GET per switch, one after another
    const t0 = sim.now;
    const token = workspaceRun(sim, SCRIPT_LAB_FILE);
    const run = finished(sim, token);
    expect(run).toMatchObject({ run: 'r2', file: 'inventory.py', state: 'completed', startedAt: t0 });
    expect(run).not.toHaveProperty('error');
    expect(run.output).toBe(INVENTORY);
    expect(run.requests.map((q) => [q.n, q.method, q.url, q.state, q.status])).toEqual(
      [D.sw1, D.sw2, D.sw3].map((address, i) => [i + 1, 'GET', scriptUrl(address), 'done', 200]),
    );
    for (let k = 1; k < run.requests.length; k++) expect(run.requests[k]!.startedAt).toBeGreaterThanOrEqual(run.requests[k - 1]!.endedAt!);
    expect(runRows(sim).map((r) => [r.run, r.state, r.requests])).toEqual([
      ['r1', 'failed', 3],
      ['r2', 'completed', 3],
    ]);
    expect(logOf(sim, 'SW3')).toEqual([
      ['GET', INTERFACES_PATH, 401],
      ['GET', INTERFACES_PATH, 200],
    ]);
    for (const name of SWITCHES) {
      const rows = sim.device(idOf(sim, name))!.tables.get<RestconfLogRow>('restconf-log')!.rows();
      expect(rows.at(-1), name).toMatchObject({ method: 'GET', status: 200, client: D.dev1, user: SCRIPT_LAB_USER });
    }
    sim.runToIdle();
    expect(passes(sim, SLAB)).toEqual(SCRIPT_PASS);
    expect(evaluateLab(sim, SLAB).score).toBe(100);
  }, LAB_TEST_TIMEOUT_MS);
});

describe('ccna3-script-inventory: wrong answers (one near miss or more per task)', () => {
  it('the run: the script run before the fix only — it fails at SW3, and the newest run is a failure', () => {
    const sim = scriptWorld();
    solveScript(sim, { solution: {} });
    expect(runRows(sim).map((r) => [r.state, r.error])).toEqual([['failed', SW3_REFUSAL]]);
    expect(passes(sim, SLAB)).toEqual({ 'inventory-completed': false, 'every-switch-read': false });
    // the fix after that run changes nothing until the script runs again
    typeOn(sim, 'SW3', ['ip http authentication local']);
    sim.runToIdle();
    expect(passes(sim, SLAB)).toEqual({ 'inventory-completed': false, 'every-switch-read': false });
    typeRequests(sim, SCRIPT_LAB_RUNS);
    expect(passes(sim, SLAB)).toEqual(SCRIPT_PASS);
  }, LAB_TEST_TIMEOUT_MS);

  it('the run: a copy of the script run under another name reads every switch, but inventory.py\'s own newest run failed', () => {
    const sim = scriptWorld();
    // the learner runs inventory.py (it fails), fixes SW3, then runs a copy instead of the script
    solveScript(sim, { solution: {} });
    typeOn(sim, 'SW3', ['ip http authentication local']);
    save(sim, 'inventory2.py', SCRIPT_LAB_INVENTORY);
    expect(finished(sim, workspaceRun(sim, 'inventory2.py')).state).toBe('completed');
    expect(runRows(sim).map((r) => [r.file, r.state])).toEqual([
      ['inventory.py', 'failed'],
      ['inventory2.py', 'completed'],
    ]);
    sim.runToIdle();
    expect(passes(sim, SLAB)).toEqual({ 'inventory-completed': false, 'every-switch-read': true });
    const run = evaluateLab(sim, SLAB).results.find((r) => r.task === 'inventory-completed')!;
    expect(run.assertions[0]!.detail).toContain('DEV1 automation.lastRun of inventory.py is failed, expected completed.');
  }, LAB_TEST_TIMEOUT_MS);

  it('the run: a run stopped from the workspace before it ends is no completed run', () => {
    const sim = scriptWorld();
    typeOn(sim, 'SW3', ['ip http authentication local']);
    sim.runToIdle();
    const token = workspaceRun(sim, SCRIPT_LAB_FILE);
    // the first GET is on its way: Stop now
    expect(hostView(sim).runs.at(-1)).toMatchObject({ state: 'running', waiting: 'http' });
    sim.hostRequest(idOf(sim, 'DEV1'), { app: 'script.stop', run: token });
    sim.runFor(5 * SEC);
    sim.runToIdle();
    expect(runRows(sim).map((r) => [r.file, r.state])).toEqual([['inventory.py', 'stopped']]);
    expect(passes(sim, SLAB)).toEqual({ 'inventory-completed': false, 'every-switch-read': false });
    expect(evaluateLab(sim, SLAB).results[0]!.assertions[0]!.detail).toContain('is stopped, expected completed.');
  }, LAB_TEST_TIMEOUT_MS);

  it('every switch: the script edited to skip the switch that refused completes, but SW3 was never read', () => {
    const sim = scriptWorld();
    const skipped = SCRIPT_LAB_INVENTORY.replace(`, "${D.sw3}"]`, ']');
    expect(skipped).toContain(`SWITCHES = ["${D.sw1}", "${D.sw2}"]`);
    save(sim, SCRIPT_LAB_FILE, skipped);
    typeRequests(sim, SCRIPT_LAB_RUNS);
    expect(runRows(sim).map((r) => [r.file, r.state, r.requests])).toEqual([['inventory.py', 'completed', 2]]);
    expect(logOf(sim, 'SW3')).toEqual([]);
    expect(passes(sim, SLAB)).toEqual({ 'inventory-completed': true, 'every-switch-read': false });
    const read = evaluateLab(sim, SLAB).results.find((r) => r.task === 'every-switch-read')!;
    expect(read.assertions.map((a) => a.pass)).toEqual([true, true, false]);
    expect(read.misconception).toBe('refusal-blamed-on-the-script');
  }, LAB_TEST_TIMEOUT_MS);

  it('every switch: the fix typed on SW2, the switch before the one that refused, leaves SW3 refusing', () => {
    const sim = scriptWorld();
    solveScript(sim, { solution: { SW2: ['ip http authentication local'] } });
    expect(logOf(sim, 'SW3')).toEqual([['GET', INTERFACES_PATH, 401]]);
    expect(passes(sim, SLAB)).toEqual({ 'inventory-completed': false, 'every-switch-read': false });
    expect(evaluateLab(sim, SLAB).results[1]!.assertions.map((a) => a.pass)).toEqual([true, true, false]);
  }, LAB_TEST_TIMEOUT_MS);
});

describe('ccna3-script-inventory: determinism', () => {
  /** The lab's script: load, boot, the fix (configure), the learner's run (a journaled cliExec job), some quiet time. */
  function script(): Simulation {
    const sim = scriptWorld({ traceCapacity: TRACE_CAPACITY });
    solveScript(sim);
    sim.runFor(10 * SEC);
    return sim;
  }

  it('the journal replays the fix and the run exactly: byte-identical trace and snapshot JSON', () => {
    const live = script();
    const journal = live.journal();
    expect(journal.entries.filter((e) => e.op.op === 'cliExec' && e.op.line.startsWith('python ')).map((e) => (e.op.op === 'cliExec' ? e.op.line : ''))).toEqual([
      ...SCRIPT_LAB_RUNS[0]!.lines,
    ]);
    const replay = createReplay(journal, { traceCapacity: TRACE_CAPACITY });
    const r = replay.advance(live.position());
    expect(r.reached).toBe(true);
    expect(replay.position()).toEqual(live.position());
    const head = journal.origin.counters.traceHead;
    expect(JSON.stringify(replay.sim.trace(head).events)).toBe(JSON.stringify(live.trace(head).events));
    expect(JSON.stringify(replay.sim.snapshot())).toBe(JSON.stringify(live.snapshot()));
    expect(runRows(replay.sim)).toEqual(runRows(live));
    expect(evaluateLab(replay.sim, SLAB).score).toBe(100);
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
