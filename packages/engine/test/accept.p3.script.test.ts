/**
 * P3 acceptance [S32] — NF-Py scripts on the developer host (ARCHITECTURE-P3 D21, §2.4, §2.6, §3.8 step 8, §4.2, §4.3;
 * §7 W7 qa; §10.1 row `accept.p3.script`): the management map's script row, adapted to lab 40's inventory script, on
 * the REAL catalog (NF-DEVHOST exists since the W6 flip: no staged world, no factory overlay). Every case runs in lab
 * 40's own world (`ccna3-script-inventory`: its seed, its build, its lab stamp), DEV1 with `inventory.py` in its
 * `files:` store and the three RESTCONF switches, booted and settled.
 *
 *   • output exact: the first run from DEV1's command prompt prints SW1's and SW2's interfaces, then the traceback of
 *     SW3's 401 (Python style, its last line naming the status and the address); after the fix on SW3 the run from the
 *     automation workspace prints the whole inventory;
 *   • requests strictly sequential: one `http.request` per switch, in the script's order, each started only once the
 *     previous one is answered — in the run's request list, on the wire (DEV1's HTTP and each answer alternate) and in
 *     the order the switches logged them;
 *   • the `script-runs` row is written exactly twice per run, when it starts and when it ends (never per slice,
 *     request or output line);
 *   • an infinite loop is aborted at exactly the instruction cap: PY_MAX_STEPS instructions in PY_MAX_STEPS / PY_QUANTUM
 *     full slices SCRIPT_SLICE_DELAY_NS (1 ms) apart, failing in the next slice with `LimitExceeded`; `runToIdle`
 *     returns; it sends nothing;
 *   • `time.sleep(5)` advances exactly 5 s of simulated time;
 *   • a syntax error fails the run at once and sends no PDU;
 *   • the script file survives export and reload in `TopologyDevice.files` (schema 1.3), as a plain list of
 *     `{path, content}` — no other storage member ([S29] is not approved) — and the reloaded host runs it alike;
 *   • three runs of one script scenario with one seed are byte-identical, and the journal replays one exactly
 *     (`replay-exact`: trace and snapshot JSON, the `script-runs` rows, the files).
 * Counts follow from the constants (PY_MAX_STEPS, PY_QUANTUM, SCRIPT_SLICE_DELAY_NS), never typed as numbers.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId, SessionId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { RestconfLogRow, ScriptRunRow } from '../src/contracts/tables.js';
import { MS, SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID_1_3, type Topology } from '../src/contracts/topology.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { MSG_PY_STEPS, PY_MAX_STEPS, PY_QUANTUM } from '../src/automation/py/vm.js';
import { NF_DEVHOST_TYPE } from '../src/device/catalog/computers.js';
import { SCRIPT_SLICE_DELAY_NS, type ScriptHostStateView, type ScriptRunView } from '../src/protocols/script-host.js';
import { createReplay } from '../src/sim/replay.js';
import {
  SCRIPT_LAB_ADDRESSES,
  SCRIPT_LAB_FAULTY,
  SCRIPT_LAB_FILE,
  SCRIPT_LAB_INVENTORY,
  SCRIPT_LAB_PATH,
  SCRIPT_LAB_SECRET,
  SCRIPT_LAB_USER,
  ccna3ScriptInventory,
} from '../src/sim/scenarios/ccna3/automation.js';
import { createSimulation } from '../src/sim/simulation.js';

const LAB = ccna3ScriptInventory;
const D = SCRIPT_LAB_ADDRESSES;
/** Every model of the lab booted and its trunks forwarding (the switches boot in 30 s, spanning tree forwards 30 s later). */
const BOOT_NS = 90 * SEC;
/** Trace ring of the cases that read every event since the load. */
const TRACE_CAPACITY = 1_000_000;
const CASE_TIMEOUT_MS = 120_000;

type TableWrite = Extract<TraceEvent, { kind: 'tableWrite' }>;
type CliOut = Extract<TraceEvent, { kind: 'cliOutput' }>;
type PduCreated = Extract<TraceEvent, { kind: 'pduCreated' }>;

/** Lab 40's world as the worker's `loadScenario` loads it (seed, build, lab stamp), booted and settled. */
function labWorld(traceCapacity?: number): Simulation {
  const sim = createSimulation({ seed: LAB.seed ?? 1, ...(traceCapacity === undefined ? {} : { traceCapacity }) });
  sim.loadTopology({ ...LAB.build(), lab: { name: LAB.name, version: LAB.version ?? 1 } });
  for (const f of LAB.faults ?? []) sim.injectFault(f.at, f.fault);
  sim.runFor(BOOT_NS);
  sim.runToIdle();
  return sim;
}

function idOf(sim: Simulation, name: string): DeviceId {
  for (const d of sim.devices()) if (d.spec.name === name) return d.id;
  throw new Error(`no device called ${name}`);
}

const dev1 = (sim: Simulation): DeviceId => idOf(sim, 'DEV1');
const view = (sim: Simulation): ScriptHostStateView => sim.device(dev1(sim))!.processes.get('script-host')!.stateSnapshot().state as unknown as ScriptHostStateView;
const rows = (sim: Simulation): ScriptRunRow[] => sim.device(dev1(sim))!.tables.get<ScriptRunRow>('script-runs')?.rows() ?? [];
const rowWrites = (sim: Simulation, evs: readonly TraceEvent[]): TableWrite[] =>
  evs.filter((e): e is TableWrite => e.kind === 'tableWrite' && e.device === dev1(sim) && e.table === 'script-runs');
const pdusOf = (evs: readonly TraceEvent[], device: DeviceId): PduCreated[] => evs.filter((e): e is PduCreated => e.kind === 'pduCreated' && e.device === device);
const logOf = (sim: Simulation, name: string): RestconfLogRow[] => sim.device(idOf(sim, name))!.tables.get<RestconfLogRow>('restconf-log')?.rows() ?? [];
/** Consecutive repeats removed (an answer spans several segments). */
const runsOf = (xs: readonly string[]): string[] => xs.filter((x, i) => i === 0 || xs[i - 1] !== x);

/** The run of the workspace with token `token`, as the StateView shows it now. */
function runOf(sim: Simulation, token: string): ScriptRunView {
  const run = view(sim).runs.filter((r) => r.token === token).at(-1);
  expect(run, `a run with token ${token}`).toBeDefined();
  return run!;
}

/** Save `content` as `path` in DEV1's store through the automation workspace (`file.write`). */
function save(sim: Simulation, path: string, content: string): void {
  sim.hostRequest(dev1(sim), { app: 'file.write', path, content });
}

/** Run `file` from the automation workspace (`script.run`); the ticket is the run's token. */
function workspaceRun(sim: Simulation, file: string): string {
  return sim.hostRequest(dev1(sim), { app: 'script.run', file }).requestId;
}

/** Type `line` on a fresh console of DEV1 and wait for the job to end (at most 10 s); the text it printed. */
function job(sim: Simulation, line: string): { session: SessionId; text: string } {
  const s = sim.cli.open(dev1(sim), 'console');
  const cursor = sim.trace(0).next;
  const started = sim.cli.exec(s, line);
  expect(started.error, line).toBeUndefined();
  for (let i = 0; i < 200 && sim.cli.session(s)?.busy === true; i++) sim.runFor(SEC / 20);
  expect(sim.cli.session(s)?.busy, `the job of "${line}" ended`).toBe(false);
  const text = sim
    .trace(cursor)
    .events.filter((e): e is CliOut => e.kind === 'cliOutput' && e.session === s)
    .map((e) => e.text)
    .join('');
  sim.cli.close(s);
  return { session: s, text };
}

/** Type configuration lines on `name`'s console. */
function typeConfig(sim: Simulation, name: string, lines: readonly string[]): void {
  const s = sim.cli.open(idOf(sim, name), 'console');
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) expect(sim.cli.exec(s, line).error, `${name}: ${line}`).toBeUndefined();
  sim.cli.close(s);
}

/** The URL the script GETs on a switch. */
const scriptUrl = (address: string): string => `https://${address}${SCRIPT_LAB_PATH}`;
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
/** The traceback's last line of the run SW3 refuses. */
const SW3_REFUSAL = `requests.exceptions.HTTPError: 401 Client Error: Unauthorized for url: ${scriptUrl(D.sw3)}`;
/** The whole first run as the command prompt prints it: two switches, then the traceback at `r.raise_for_status()`. */
const FIRST_RUN = [
  ...INVENTORY_SW1_SW2,
  'Traceback (most recent call last):',
  `  File "${SCRIPT_LAB_FILE}", line 11, in <module>`,
  '    r.raise_for_status()',
  SW3_REFUSAL,
  '',
].join('\n');

/** The three GETs of a run, in the script's order: [n, method, url, state, status]. */
const GETS = (statuses: readonly number[]): unknown[] => [D.sw1, D.sw2, D.sw3].map((a, i) => [i + 1, 'GET', scriptUrl(a), 'done', statuses[i]]);

/** A run's requests one after another: each starts no earlier than the previous one's answer. */
function expectSequential(run: ScriptRunView): void {
  for (let k = 1; k < run.requests.length; k++) expect(run.requests[k]!.startedAt, `request ${k + 1}`).toBeGreaterThanOrEqual(run.requests[k - 1]!.endedAt!);
}

/** On the wire: DEV1's HTTP requests and the switches' answers alternate, one switch after the other, in order. */
function expectAlternating(sim: Simulation, evs: readonly TraceEvent[], switches: readonly string[]): void {
  const http = evs.filter((e): e is PduCreated => e.kind === 'pduCreated' && e.pdu.proto === 'http');
  const order = switches.flatMap((name) => [dev1(sim), idOf(sim, name)]);
  expect(runsOf(http.map((e) => e.device))).toEqual(order);
}

describe('[S32] lab 40: the inventory script, its output, its requests and its row', () => {
  it(
    'the first run prints two switches and the 401 traceback; after the fix the second prints the whole inventory; requests strictly sequential; the row at start and end only',
    () => {
      const sim = labWorld(TRACE_CAPACITY);
      const dev = sim.device(dev1(sim))!;
      expect(dev.spec.type).toBe(NF_DEVHOST_TYPE);
      expect(dev.readFile!('files', SCRIPT_LAB_FILE)?.content).toBe(SCRIPT_LAB_INVENTORY);
      expect(rows(sim)).toEqual([]);

      // 1. from DEV1's command prompt, before the fix
      const c1 = sim.trace(0).next;
      const t1 = sim.now;
      const first = job(sim, `python ${SCRIPT_LAB_FILE}`);
      expect(first.text).toBe(FIRST_RUN);
      const evs1 = sim.trace(c1).events;
      const r1 = view(sim).runs[0]!;
      expect(r1).toMatchObject({ run: 'r1', file: SCRIPT_LAB_FILE, state: 'failed', startedAt: t1, error: { last: SW3_REFUSAL } });
      expect(r1.output).toBe(`${INVENTORY_SW1_SW2.join('\n')}\n`);
      expect(r1.requests.map((q) => [q.n, q.method, q.url, q.state, q.status])).toEqual(GETS([200, 200, 401]));
      expect(r1.requests[0]!.startedAt).toBe(t1);
      expectSequential(r1);
      expect(r1.endedAt).toBe(r1.requests[2]!.endedAt);
      expectAlternating(sim, evs1, ['SW1', 'SW2', 'SW3']);
      expect(rowWrites(sim, evs1).map((w) => [w.t, w.row['state'], w.row['requests'], w.row['error']])).toEqual([
        [t1, 'running', 0, undefined],
        [r1.endedAt, 'failed', 3, SW3_REFUSAL],
      ]);
      // each switch logged the GET it answered, in the script's order
      const at1 = (['SW1', 'SW2', 'SW3'] as const).map((name) => logOf(sim, name).map((x) => [x.method, x.path, x.status, x.client]));
      expect(at1).toEqual([
        [['GET', SCRIPT_LAB_PATH, 200, D.dev1]],
        [['GET', SCRIPT_LAB_PATH, 200, D.dev1]],
        [['GET', SCRIPT_LAB_PATH, 401, D.dev1]],
      ]);
      expect(logOf(sim, 'SW1')[0]!.at).toBeLessThan(logOf(sim, 'SW2')[0]!.at);
      expect(logOf(sim, 'SW2')[0]!.at).toBeLessThan(logOf(sim, 'SW3')[0]!.at);

      // 2. the fix on SW3's console, then the run from the automation workspace
      typeConfig(sim, SCRIPT_LAB_FAULTY.device, [SCRIPT_LAB_FAULTY.line]);
      sim.runToIdle();
      const c2 = sim.trace(0).next;
      const t2 = sim.now;
      const token = workspaceRun(sim, SCRIPT_LAB_FILE);
      sim.runFor(5 * SEC);
      const evs2 = sim.trace(c2).events;
      const r2 = runOf(sim, token);
      expect(r2).toMatchObject({ run: 'r2', file: SCRIPT_LAB_FILE, state: 'completed', startedAt: t2, sleptNs: 0 });
      expect(r2).not.toHaveProperty('error');
      expect(r2.output).toBe(INVENTORY);
      expect(r2.requests.map((q) => [q.n, q.method, q.url, q.state, q.status])).toEqual(GETS([200, 200, 200]));
      expect(r2.requests[0]!.startedAt).toBe(t2);
      expectSequential(r2);
      expectAlternating(sim, evs2, ['SW1', 'SW2', 'SW3']);
      expect(rowWrites(sim, evs2).map((w) => [w.t, w.row['state'], w.row['requests']])).toEqual([
        [t2, 'running', 0],
        [r2.endedAt, 'completed', 3],
      ]);
      expect(rows(sim).map((x) => [x.run, x.file, x.state, x.requests])).toEqual([
        ['r1', SCRIPT_LAB_FILE, 'failed', 3],
        ['r2', SCRIPT_LAB_FILE, 'completed', 3],
      ]);
      for (const name of ['SW1', 'SW2', 'SW3']) expect(logOf(sim, name).at(-1), name).toMatchObject({ method: 'GET', status: 200, client: D.dev1, user: SCRIPT_LAB_USER });
    },
    CASE_TIMEOUT_MS,
  );
});

describe('[S32] slices, sleeps and syntax errors on the real NF-DEVHOST', () => {
  it(
    `an infinite loop is aborted at exactly the instruction cap: ${PY_MAX_STEPS / PY_QUANTUM} full slices 1 ms apart, then the failing one; runToIdle returns; nothing is sent`,
    () => {
      const sim = labWorld();
      save(sim, 'loop.py', 'while True:\n    pass\n');
      const cursor = sim.trace(0).next;
      const t0 = sim.now;
      const token = workspaceRun(sim, 'loop.py');
      // the first slice runs in the request's own dispatch and spends its whole quantum
      expect(runOf(sim, token)).toMatchObject({ state: 'running', slices: 1, steps: PY_QUANTUM });
      const stats = sim.runToIdle();
      expect(stats.stopped).toBeUndefined();
      const quanta = PY_MAX_STEPS / PY_QUANTUM;
      expect(Number.isInteger(quanta)).toBe(true);
      expect(SCRIPT_SLICE_DELAY_NS).toBe(MS);
      const end = t0 + quanta * SCRIPT_SLICE_DELAY_NS;
      const run = runOf(sim, token);
      // PY_MAX_STEPS instructions ran; the next one is the one the cap refuses
      expect(run).toMatchObject({ state: 'failed', startedAt: t0, endedAt: end, slices: quanta + 1, steps: PY_MAX_STEPS + 1, output: '' });
      expect(run.error).toMatchObject({ type: 'LimitExceeded', last: `LimitExceeded: ${MSG_PY_STEPS}` });
      const evs = sim.trace(cursor).events;
      expect(rowWrites(sim, evs).map((w) => [w.t, w.row['state'], w.row['error']])).toEqual([
        [t0, 'running', undefined],
        [end, 'failed', `LimitExceeded: ${MSG_PY_STEPS}`],
      ]);
      expect(pdusOf(evs.filter((e) => e.t <= end), dev1(sim))).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'time.sleep(5) advances exactly 5 s of simulated time',
    () => {
      const sim = labWorld();
      save(sim, 'sleepy.py', ['import time', 'a = time.monotonic_ns()', 'time.sleep(5)', 'print(time.monotonic_ns() - a)', ''].join('\n'));
      const cursor = sim.trace(0).next;
      const t0 = sim.now;
      const token = workspaceRun(sim, 'sleepy.py');
      sim.runFor(4999 * MS);
      expect(runOf(sim, token)).toMatchObject({ state: 'running', waiting: 'sleep' });
      sim.runToIdle();
      const run = runOf(sim, token);
      expect(run).toMatchObject({ state: 'completed', startedAt: t0, endedAt: t0 + 5 * SEC, sleptNs: 5 * SEC, output: `${5 * SEC}\n` });
      expect(rowWrites(sim, sim.trace(cursor).events).map((w) => [w.t, w.row['state']])).toEqual([
        [t0, 'running'],
        [t0 + 5 * SEC, 'completed'],
      ]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'a syntax error fails the run at once and sends no PDU',
    () => {
      const sim = labWorld();
      // the lab's own script with one parenthesis missing: it never reaches a request
      const broken = SCRIPT_LAB_INVENTORY.replace('r = requests.get(url, auth=AUTH)', 'r = requests.get(url, auth=AUTH');
      expect(broken).not.toBe(SCRIPT_LAB_INVENTORY);
      save(sim, 'broken.py', broken);
      const cursor = sim.trace(0).next;
      const t0 = sim.now;
      const shown = job(sim, 'python broken.py');
      expect(shown.text.startsWith('  File "broken.py", line ')).toBe(true);
      expect(shown.text).toMatch(/\nSyntaxError: [^\n]+\n$/);
      const run = view(sim).runs[0]!;
      expect(run).toMatchObject({ run: 'r1', state: 'failed', startedAt: t0, endedAt: t0, steps: 0, requests: [] });
      expect(run.error?.type).toBe('SyntaxError');
      sim.runFor(10 * SEC);
      const evs = sim.trace(cursor).events;
      expect(pdusOf(evs, dev1(sim))).toEqual([]);
      for (const name of ['SW1', 'SW2', 'SW3']) expect(logOf(sim, name), name).toEqual([]);
      expect(rowWrites(sim, evs).map((w) => [w.t, w.row['state'], w.row['requests']])).toEqual([
        [t0, 'running', 0],
        [t0, 'failed', 0],
      ]);
    },
    CASE_TIMEOUT_MS,
  );
});

describe('[S32] the script file survives export and reload (schema 1.3)', () => {
  it(
    "DEV1's files travel in TopologyDevice.files as plain {path, content} entries, and the reloaded host runs them alike",
    () => {
      const sim = labWorld();
      const hello = 'import sys\nprint("hello from", sys.argv[0])\n';
      save(sim, 'hello.py', hello);
      const saved = JSON.parse(JSON.stringify(sim.exportTopology())) as Topology;
      expect(saved.schema).toBe(TOPOLOGY_SCHEMA_ID_1_3);
      expect(saved.profile).toBe('P3');
      const d = saved.devices.find((x) => x.name === 'DEV1')!;
      // in path order; the members a device carries, and no storage member beyond `files` ([S29] is not approved)
      expect(d.files).toEqual([
        { path: 'hello.py', content: hello },
        { path: SCRIPT_LAB_FILE, content: SCRIPT_LAB_INVENTORY },
      ]);
      expect(Object.keys(d)).toEqual(['id', 'type', 'name', 'position', 'power', 'config', 'runningConfig', 'files']);
      for (const other of saved.devices.filter((x) => x.name !== 'DEV1')) expect(other, other.name).not.toHaveProperty('files');
      // reloaded in a fresh session: the same store, and the script runs alike
      const again = createSimulation({ seed: saved.seed });
      again.loadTopology(saved);
      again.runFor(BOOT_NS);
      again.runToIdle();
      const host = again.device(dev1(again))!;
      expect(host.files!('files').map((f) => f.path)).toEqual(['hello.py', SCRIPT_LAB_FILE]);
      expect(host.readFile!('files', SCRIPT_LAB_FILE)?.content).toBe(SCRIPT_LAB_INVENTORY);
      expect(host.readFile!('files', 'hello.py')?.content).toBe(hello);
      expect(again.snapshot().devices.find((x) => x.id === dev1(again))?.storage?.map((s) => s.fs)).toEqual(['files']);
      expect(job(again, 'python hello.py').text).toBe('hello from hello.py\n');
      // the reloaded world's own export carries the same files (a fixed point)
      expect(again.exportTopology().devices.find((x) => x.name === 'DEV1')?.files).toEqual(d.files);
      // and the reloaded host's first run of the lab's script ends where the lab's does: at SW3's 401
      expect(job(again, `python ${SCRIPT_LAB_FILE}`).text).toBe(FIRST_RUN);
    },
    CASE_TIMEOUT_MS,
  );
});

describe('[S32] determinism', () => {
  /**
   * A script scenario: lab 40 loaded and booted, a script saved and run from the workspace (two sleeps between the
   * switches' GETs, so slices, sleeps and requests interleave), the fix typed on SW3's console, the lab's script run
   * from DEV1's command prompt (a journaled `cliExec` job), and quiet time after.
   */
  function scenario(): Simulation {
    const sim = labWorld(TRACE_CAPACITY);
    const paced = [
      'import requests, time',
      `AUTH = ("${SCRIPT_LAB_USER}", "${SCRIPT_LAB_SECRET}")`,
      `for address in ["${D.sw1}", "${D.sw2}"]:`,
      `    r = requests.get("https://" + address + "${SCRIPT_LAB_PATH}", auth=AUTH)`,
      '    print(address, r.status_code, len(r.text), time.monotonic_ns())',
      '    time.sleep(0.25)',
      '',
    ].join('\n');
    save(sim, 'paced.py', paced);
    workspaceRun(sim, 'paced.py');
    sim.runFor(3 * SEC);
    typeConfig(sim, SCRIPT_LAB_FAULTY.device, [SCRIPT_LAB_FAULTY.line]);
    const s = sim.cli.open(dev1(sim), 'console');
    sim.cli.exec(s, `python ${SCRIPT_LAB_FILE}`);
    sim.runFor(10 * SEC);
    sim.cli.close(s);
    return sim;
  }

  it(
    'three runs of a script scenario with one seed give byte-identical trace and snapshot JSON',
    () => {
      const once = (): string => {
        const sim = scenario();
        return JSON.stringify({ trace: sim.trace(0).events, snapshot: sim.snapshot(), view: view(sim), rows: rows(sim) });
      };
      const a = once();
      const parsed = JSON.parse(a) as { view: ScriptHostStateView };
      expect(parsed.view.runs.map((r) => [r.file, r.state, r.requests.length])).toEqual([
        ['paced.py', 'completed', 2],
        [SCRIPT_LAB_FILE, 'completed', 3],
      ]);
      expect(parsed.view.runs[0]!.sleptNs).toBe(500 * MS);
      expect(once()).toBe(a);
      expect(once()).toBe(a);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'replay-exact: the journal replays the script scenario to byte-identical trace and snapshot JSON',
    () => {
      const live = scenario();
      const journal = live.journal();
      const ops = journal.entries.map((e) => e.op.op);
      expect(ops).toContain('hostRequest');
      expect(ops).toContain('cliExec');
      const replay = createReplay(journal, { traceCapacity: TRACE_CAPACITY });
      expect(replay.advance(live.position()).reached).toBe(true);
      expect(replay.position()).toEqual(live.position());
      const head = journal.origin.counters.traceHead;
      expect(JSON.stringify(replay.sim.trace(head).events)).toBe(JSON.stringify(live.trace(head).events));
      expect(JSON.stringify(replay.sim.snapshot())).toBe(JSON.stringify(live.snapshot()));
      expect(rows(replay.sim)).toEqual(rows(live));
      expect(replay.sim.exportTopology()).toEqual(live.exportTopology());
    },
    CASE_TIMEOUT_MS,
  );
});
