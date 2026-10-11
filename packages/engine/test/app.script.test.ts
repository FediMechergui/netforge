/**
 * app.script — [S32] the NF-Py script host (`protocols/script-host.ts`; ARCHITECTURE-P3 D21, §2.4, §2.6, §3.0 (d),
 * §3.8 step 8, §4.2, §4.3; §7 W5 auto), on `staged.world` at stage P3 (rule 13) with the test-only NF-DEVHOST and the
 * daemon passed through the registry overlay (the W6 flip registers it for real).
 *
 *   • §3.8 step 8 against three real RESTCONF switches (the §3.8 world, with DEV1 on SW1 Fa0/2 in VLAN 99): an
 *     inventory script saved through the workspace's `file.write` (the `storage` action) and run through
 *     `hostRequest script.run` reads each switch's interfaces with the `requests`-style module — each call one
 *     `http.request` (owner 'script-host'), strictly one after another; the output, the request list and the run in
 *     the StateView; one `script-runs` row written at the start and at the end only; the `restconf-log` row it left
 *     on each switch; `fact automation.lastRun` reads the row. From the host shell, `python fix.py` reads SW2's
 *     description in the JSON and PUTs VLAN 40 FINANCE on SW3 (the configure seam with the script host's address).
 *   • On a small world (DEV1 cabled to R1, an NF-2911 serving RESTCONF): an endless loop ends at the instruction cap
 *     after exactly PY_MAX_STEPS / PY_QUANTUM slices 1 ms apart, and `runToIdle` returns; `time.sleep(5)` advances 5 s
 *     and the clocks a script reads; a syntax error fails at once and sends no packet; a run whose requests all fail at
 *     once goes on in a dispatch of its own per answer, up to the request cap; Ctrl+C and the workspace's stop
 *     (timers cancelled, a pending request abandoned and its late answer ignored); refusals; the run cap; the table
 *     bound; the files; silence before a run; three runs with one seed are byte-identical.
 */
import { describe, expect, it } from 'vitest';
import { NF_WORLD_EPOCH_UNIX_MS } from '../src/contracts/clock.js';
import type { DeviceId, SessionId } from '../src/contracts/ids.js';
import type { ProcessRequest } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { RestconfLogRow, ScriptRunRow } from '../src/contracts/tables.js';
import { MS, SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { MSG_PY_REQUESTS, MSG_PY_STEPS, PY_MAX_REQUESTS, PY_MAX_STEPS, PY_QUANTUM } from '../src/automation/py/vm.js';
import {
  createScriptHost,
  MSG_SCRIPT_NO_NAME,
  MSG_SCRIPT_STOPPED,
  MSG_SCRIPT_TOKEN_BUSY,
  msgScriptHostBusy,
  msgScriptNoFile,
  SCRIPT_HOST_DEBUG,
  SCRIPT_HOST_MAX_RUNS,
  SCRIPT_HOST_RETAINED_RUNS,
  SCRIPT_RUNS_LIMIT,
  SCRIPT_SLICE_DELAY_NS,
  scriptRequestToken,
  type ScriptHostStateView,
  type ScriptRunView,
} from '../src/protocols/script-host.js';
import { checkFact } from '../src/sim/lab-checks/facts.js';
import { createStagedSimulation, NF_DEVHOST_TYPE } from './staged.world.js';

const PASSWORD = 'Lab-Pass1';
const DEV = '10.0.99.20';
const SW = { sw1: '10.0.99.11', sw2: '10.0.99.12', sw3: '10.0.99.13' } as const;
const R1 = '10.0.99.1';
const UPLINK_NOTE = 'uplink - add vlan 40 NAME FINANCE on SW3';

type TableWrite = Extract<TraceEvent, { kind: 'tableWrite' }>;
type CliOut = Extract<TraceEvent, { kind: 'cliOutput' }>;

function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

const SERVICE_LINES: readonly (readonly string[])[] = [
  [`username admin privilege 15 secret ${PASSWORD}`],
  ['ip http secure-server'],
  ['ip http authentication local'],
  ['restconf'],
];

const devhostConfig = (): string => startup([['hostname DEV1'], ['interface GigabitEthernet0', ` ip address ${DEV} 255.255.255.0`]]);

/** One switch of the §3.8 line: the API service lines, VLAN 99, its SVI and its trunks (DEV1's access port on SW1). */
function switchConfig(name: string, address: string, opts: { devPort?: boolean; up?: boolean; down?: string }): string {
  const sections: (readonly string[])[] = [[`hostname ${name}`], ...SERVICE_LINES, ['vlan 99', ' name MGMT']];
  if (opts.devPort === true) sections.push(['interface FastEthernet0/2', ' switchport mode access', ' switchport access vlan 99', ' spanning-tree portfast']);
  if (opts.up === true) sections.push(['interface GigabitEthernet0/1', ' switchport mode trunk']);
  if (opts.down !== undefined) sections.push(['interface GigabitEthernet0/2', ...(opts.down === '' ? [] : [` description ${opts.down}`]), ' switchport mode trunk']);
  sections.push(['interface Vlan99', ` ip address ${address} 255.255.255.0`, ' no shutdown']);
  return startup(sections);
}

/** The §3.8 world with DEV1 (NF-DEVHOST) on SW1 Fa0/2, booted and settled (trunks forwarding) at 100 s. */
function apiWorld(seed = 3_032): Simulation {
  const sim = createStagedSimulation({ seed, stage: 'P3', factories: { 'script-host': createScriptHost } });
  sim.addDevice({ id: 'dev1', type: NF_DEVHOST_TYPE, name: 'DEV1', startupConfig: devhostConfig() });
  sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: switchConfig('SW1', SW.sw1, { devPort: true, down: '' }) });
  sim.addDevice({ id: 'sw2', type: 'switch.nfc2960', name: 'SW2', startupConfig: switchConfig('SW2', SW.sw2, { up: true, down: UPLINK_NOTE }) });
  sim.addDevice({ id: 'sw3', type: 'switch.nfc2960', name: 'SW3', startupConfig: switchConfig('SW3', SW.sw3, { up: true }) });
  sim.addLink({ a: { device: 'dev1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/2' } });
  sim.addLink({ a: { device: 'sw1', port: 'GigabitEthernet0/2' }, b: { device: 'sw2', port: 'GigabitEthernet0/1' } });
  sim.addLink({ a: { device: 'sw2', port: 'GigabitEthernet0/2' }, b: { device: 'sw3', port: 'GigabitEthernet0/1' } });
  sim.runUntil(100 * SEC);
  return sim;
}

/** DEV1 cabled to R1 (NF-2911 serving RESTCONF on 10.0.99.1), booted at 60 s. */
function smallWorld(seed = 3_040): Simulation {
  const sim = createStagedSimulation({ seed, stage: 'P3', factories: { 'script-host': createScriptHost } });
  sim.addDevice({ id: 'dev1', type: NF_DEVHOST_TYPE, name: 'DEV1', startupConfig: devhostConfig() });
  sim.addDevice({
    id: 'r1', type: 'router.nf2911', name: 'R1',
    startupConfig: startup([['hostname R1'], ...SERVICE_LINES, ['interface GigabitEthernet0/0', ` ip address ${R1} 255.255.255.0`, ' no shutdown']]),
  });
  sim.addLink({ a: { device: 'dev1', port: 'GigabitEthernet0' }, b: { device: 'r1', port: 'GigabitEthernet0/0' } });
  sim.runUntil(60 * SEC);
  return sim;
}

// ── reading the script host ──────────────────────────────────────────────────────────────────────────────────

const view = (sim: Simulation): ScriptHostStateView =>
  sim.device('dev1')!.processes.get('script-host')!.stateSnapshot().state as unknown as ScriptHostStateView;
const runOf = (sim: Simulation, token: string): ScriptRunView => {
  const all = view(sim).runs.filter((r) => r.token === token);
  expect(all.length, `a run with token ${token}`).toBeGreaterThan(0);
  return all[all.length - 1]!;
};
const rows = (sim: Simulation): ScriptRunRow[] => sim.device('dev1')!.tables.get<ScriptRunRow>('script-runs')!.rows();
const rowWrites = (evs: readonly TraceEvent[]): TableWrite[] =>
  evs.filter((e): e is TableWrite => e.kind === 'tableWrite' && e.device === 'dev1' && e.table === 'script-runs');
const packetsOf = (evs: readonly TraceEvent[], dev: DeviceId = 'dev1'): TraceEvent[] => evs.filter((e) => e.kind === 'pduCreated' && e.device === dev);
const scriptDebug = (evs: readonly TraceEvent[]): string[] =>
  evs.flatMap((e) => (e.kind === 'debug' && e.event.process === 'script-host' ? [`${e.event.category}: ${e.event.message}`] : []));
const sessionText = (evs: readonly TraceEvent[], s: SessionId): string =>
  evs.filter((e): e is CliOut => e.kind === 'cliOutput' && e.session === s).map((e) => e.text).join('');
/** The last prompt of `s` that is not busy (the job's end; opening the session prints one too). */
const promptBack = (evs: readonly TraceEvent[], s: SessionId): TraceEvent | undefined => evs.filter((e) => e.kind === 'cliPrompt' && e.session === s && !e.busy).at(-1);
/** Consecutive repeats removed (a response spans several segments). */
const runsOf = (xs: readonly string[]): string[] => xs.filter((x, i) => i === 0 || xs[i - 1] !== x);

/** Save `content` as `path` in DEV1's `files:` store through the workspace's `file.write`. */
function save(sim: Simulation, path: string, content: string): void {
  sim.hostRequest('dev1', { app: 'file.write', path, content });
}

/** Run `file` from the workspace; the ticket is the run's token. */
function run(sim: Simulation, file: string, argv?: readonly string[]): string {
  return sim.hostRequest('dev1', { app: 'script.run', file, ...(argv !== undefined ? { argv } : {}) }).requestId;
}

/** A request to DEV1's script host as the shell or the workspace would send it. */
function ask(sim: Simulation, req: ProcessRequest): void {
  sim.device('dev1')!.applyActions('cli', [{ type: 'request', to: 'script-host', req }], sim.now);
}

/** Type `line` on a fresh console of DEV1; returns the session (left open) and whether the line started a job. */
function shell(sim: Simulation, line: string): SessionId {
  const s = sim.cli.open('dev1', 'console');
  const r = sim.cli.exec(s, line);
  expect(r.error, line).toBeUndefined();
  return s;
}

// ── the scripts ──────────────────────────────────────────────────────────────────────────────────────────────

const INVENTORY = [
  'import requests',
  '',
  `SWITCHES = ["${SW.sw1}", "${SW.sw2}", "${SW.sw3}"]`,
  `AUTH = ("admin", "${PASSWORD}")`,
  '',
  'total = 0',
  'for address in SWITCHES:',
  '    r = requests.get("https://" + address + "/restconf/data/ietf-interfaces:interfaces", auth=AUTH)',
  '    r.raise_for_status()',
  '    interfaces = r.json()["ietf-interfaces:interfaces"]["interface"]',
  '    total += len(interfaces)',
  '    print(f"{address}: {len(interfaces)} interfaces")',
  '    for i in interfaces:',
  '        if "description" in i:',
  '            print(f"  {i[\'name\']}: {i[\'description\']}")',
  'print(f"{total} interfaces on {len(SWITCHES)} switches")',
  '',
].join('\n');

const FIX = [
  'import requests',
  '',
  `AUTH = ("admin", "${PASSWORD}")`,
  `SWITCHES = {"SW1": "${SW.sw1}", "SW2": "${SW.sw2}", "SW3": "${SW.sw3}"}`,
  '',
  'r = requests.get("https://" + SWITCHES["SW2"] + "/restconf/data/ietf-interfaces:interfaces", auth=AUTH)',
  'note = [i["description"] for i in r.json()["ietf-interfaces:interfaces"]["interface"] if "description" in i][0]',
  'words = note.split()',
  'vlan = int(words[words.index("vlan") + 1])',
  'name = words[words.index("NAME") + 1]',
  'target = SWITCHES[words[-1]]',
  'body = {"nf-native:vlan-list": [{"id": vlan, "name": name}]}',
  'url = "https://" + target + "/restconf/data/nf-native:native/vlan/vlan-list=" + str(vlan)',
  'put = requests.put(url, json=body, auth=AUTH, headers={"Content-Type": "application/yang-data+json"})',
  'print("vlan", vlan, name, "on", target + ":", put.status_code, put.reason)',
  '',
].join('\n');

const SLEEPY = [
  'import time',
  'a = time.monotonic_ns()',
  'print("before", a)',
  'time.sleep(5)',
  'b = time.monotonic_ns()',
  'print("after", b - a)',
  'print(int(time.time()))',
  '',
].join('\n');

const LOOP = 'while True:\n    pass\n';
const FOREVER = 'import time\nwhile True:\n    time.sleep(1)\n';
const BROKEN = 'print("never"\n';
const QUICK = 'print(1)\n';

// ── §3.8 step 8 ──────────────────────────────────────────────────────────────────────────────────────────────

describe('§3.8 step 8: a script inventories three RESTCONF switches', () => {
  it('each call is one http.request, strictly one after another; output, requests and run in the StateView; the row at start and end; the server logs', () => {
    const sim = apiWorld();
    save(sim, 'inventory.py', INVENTORY);
    expect(sim.device('dev1')!.files!('files').map((f) => f.path)).toEqual(['inventory.py']);
    const cursor = sim.trace(0).next;
    const t0 = sim.now;
    const token = run(sim, 'inventory.py');
    sim.runFor(5 * SEC);
    const evs = sim.trace(cursor).events;
    const r = runOf(sim, token);
    expect(r).toMatchObject({ run: 'r1', file: 'inventory.py', argv: [], state: 'completed', startedAt: t0, sleptNs: 0 });
    expect(r.output).toBe(
      [
        `${SW.sw1}: 28 interfaces`,
        `${SW.sw2}: 28 interfaces`,
        `  GigabitEthernet0/2: ${UPLINK_NOTE}`,
        `${SW.sw3}: 28 interfaces`,
        '84 interfaces on 3 switches',
        '',
      ].join('\n'),
    );
    expect(r).not.toHaveProperty('error');
    expect(r).not.toHaveProperty('waiting');
    // the request list: one GET per switch, in the script's order
    expect(r.requests.map((q) => [q.n, q.method, q.url, q.state, q.status, q.reason])).toEqual([
      [1, 'GET', `https://${SW.sw1}/restconf/data/ietf-interfaces:interfaces`, 'done', 200, 'OK'],
      [2, 'GET', `https://${SW.sw2}/restconf/data/ietf-interfaces:interfaces`, 'done', 200, 'OK'],
      [3, 'GET', `https://${SW.sw3}/restconf/data/ietf-interfaces:interfaces`, 'done', 200, 'OK'],
    ]);
    // strictly sequential: a request starts only once the previous one is answered
    expect(r.requests[0]!.startedAt).toBe(t0);
    for (let k = 1; k < r.requests.length; k++) expect(r.requests[k]!.startedAt).toBeGreaterThanOrEqual(r.requests[k - 1]!.endedAt!);
    expect(r.endedAt).toBe(r.requests[2]!.endedAt);
    // …and on the wire: DEV1's three HTTP requests and the three answers alternate, each to and from the next switch
    const http = evs.filter((e): e is Extract<TraceEvent, { kind: 'pduCreated' }> => e.kind === 'pduCreated' && e.pdu.proto === 'http');
    expect(runsOf(http.map((e) => e.device))).toEqual(['dev1', 'sw1', 'dev1', 'sw2', 'dev1', 'sw3']);
    expect(http.filter((e) => e.device === 'dev1')).toHaveLength(3);
    for (const e of http.filter((x) => x.device === 'dev1')) expect(e.process).toBe('tcp'); // http-client's bytes, segmented by tcp
    // each request is an http.request of owner script-host with its own token
    const client = sim.device('dev1')!.processes.get('http-client')!.stateSnapshot().state as { requests: Record<string, { method: string; url: string; phase: string }> };
    expect(Object.keys(client.requests)).toEqual([1, 2, 3].map((n) => scriptRequestToken('r1', n)));
    // the row: written when the run started and when it ended, never per request or output line
    const writes = rowWrites(evs);
    expect(writes.map((w) => [w.t, w.row['state'], w.row['requests']])).toEqual([[t0, 'running', 0], [r.endedAt, 'completed', 3]]);
    expect(rows(sim)).toEqual([{ key: 'r1', run: 'r1', file: 'inventory.py', state: 'completed', startedAt: t0, endedAt: r.endedAt, requests: 3, updatedAt: r.endedAt }]);
    // the GET each switch logged: from DEV1, as admin
    const logs = (['sw1', 'sw2', 'sw3'] as const).map((dev) => sim.device(dev)!.tables.get<RestconfLogRow>('restconf-log')!.rows());
    for (const log of logs) {
      expect(log).toEqual([expect.objectContaining({ method: 'GET', path: '/restconf/data/ietf-interfaces:interfaces', status: 200, client: DEV, user: 'admin' })]);
    }
    // …in the script's order
    expect(logs[0]![0]!.at).toBeLessThan(logs[1]![0]!.at);
    expect(logs[1]![0]!.at).toBeLessThan(logs[2]![0]!.at);
    // the debug lines of the run (category `script`)
    expect(scriptDebug(evs)).toEqual([
      `${SCRIPT_HOST_DEBUG}: r1: inventory.py started`,
      `${SCRIPT_HOST_DEBUG}: r1: request 1: GET https://${SW.sw1}/restconf/data/ietf-interfaces:interfaces`,
      `${SCRIPT_HOST_DEBUG}: r1: request 1: 200 OK`,
      `${SCRIPT_HOST_DEBUG}: r1: request 2: GET https://${SW.sw2}/restconf/data/ietf-interfaces:interfaces`,
      `${SCRIPT_HOST_DEBUG}: r1: request 2: 200 OK`,
      `${SCRIPT_HOST_DEBUG}: r1: request 3: GET https://${SW.sw3}/restconf/data/ietf-interfaces:interfaces`,
      `${SCRIPT_HOST_DEBUG}: r1: request 3: 200 OK`,
      `${SCRIPT_HOST_DEBUG}: r1: inventory.py completed`,
    ]);
    // the grader's fact reads the row (rule 20), live
    expect(checkFact(sim, { kind: 'fact', device: 'DEV1', fact: 'automation.lastRun', subject: 'inventory.py', equals: 'completed' }).pass).toBe(true);
    expect(checkFact(sim, { kind: 'fact', device: 'DEV1', fact: 'automation.lastRun', equals: 'completed' }).pass).toBe(true);

    // from the host shell: `python fix.py` reads the note in SW2's JSON and adds the VLAN on SW3 through the API
    save(sim, 'fix.py', FIX);
    const c2 = sim.trace(0).next;
    const t1 = sim.now;
    const s = shell(sim, 'python fix.py');
    expect(sim.cli.session(s)?.job).toEqual({ process: 'script-host', label: 'python' });
    sim.runFor(5 * SEC);
    const evs2 = sim.trace(c2).events;
    expect(sessionText(evs2, s)).toBe(`vlan 40 FINANCE on ${SW.sw3}: 201 Created\n`);
    expect(promptBack(evs2, s)!.t).toBeGreaterThan(t1);
    expect(sim.cli.session(s)).toMatchObject({ busy: false });
    expect(sim.cli.session(s)).not.toHaveProperty('job');
    const fix = view(sim).runs.find((x) => x.file === 'fix.py')!;
    expect(fix).toMatchObject({ run: 'r2', token: `py:${s}@${t1}`, state: 'completed' });
    expect(fix.requests.map((q) => [q.method, q.url, q.status])).toEqual([
      ['GET', `https://${SW.sw2}/restconf/data/ietf-interfaces:interfaces`, 200],
      ['PUT', `https://${SW.sw3}/restconf/data/nf-native:native/vlan/vlan-list=40`, 201],
    ]);
    const vlan40 = sim.device('sw3')!.running.root.children.find((n) => n.key === 'vlan' && n.args[0] === '40');
    expect(vlan40?.children.find((c) => c.key === 'name')?.args[0]).toBe('FINANCE');
    const changes = evs2.filter((e): e is Extract<TraceEvent, { kind: 'configChange' }> => e.kind === 'configChange' && e.device === 'sw3');
    expect(changes.map((c) => [c.line, c.origin])).toEqual([
      ['vlan 40', { via: 'restconf', user: 'admin', address: DEV }],
      ['name FINANCE', { via: 'restconf', user: 'admin', address: DEV }],
    ]);
    expect(sim.device('sw3')!.tables.get<RestconfLogRow>('restconf-log')!.rows().map((x) => [x.method, x.status, x.client])).toEqual([
      ['GET', 200, DEV],
      ['PUT', 201, DEV],
    ]);
    expect(rows(sim).map((x) => [x.run, x.file, x.state, x.requests])).toEqual([
      ['r1', 'inventory.py', 'completed', 3],
      ['r2', 'fix.py', 'completed', 2],
    ]);
    // the newest run of any file is now fix.py's; inventory.py's is still its own
    expect(checkFact(sim, { kind: 'fact', device: 'DEV1', fact: 'automation.lastRun', subject: 'inventory.py', equals: 'completed' }).pass).toBe(true);
    sim.cli.close(s);
  });
});

// ── slices, sleeps and the caps ──────────────────────────────────────────────────────────────────────────────

describe('slices, sleeps and the caps', () => {
  it(`an endless loop ends at the instruction cap after ${PY_MAX_STEPS / PY_QUANTUM} slices 1 ms apart; runToIdle returns`, () => {
    const sim = smallWorld();
    save(sim, 'loop.py', LOOP);
    const cursor = sim.trace(0).next;
    const t0 = sim.now;
    const token = run(sim, 'loop.py');
    expect(view(sim).runs[0]).toMatchObject({ state: 'running', slices: 1, steps: PY_QUANTUM });
    const stats = sim.runToIdle();
    expect(stats.stopped).toBeUndefined();
    const evs = sim.trace(cursor).events;
    const r = runOf(sim, token);
    const quanta = PY_MAX_STEPS / PY_QUANTUM;
    expect(r).toMatchObject({ state: 'failed', startedAt: t0, endedAt: t0 + quanta * SCRIPT_SLICE_DELAY_NS, slices: quanta + 1, steps: PY_MAX_STEPS + 1, output: '' });
    expect(r.error).toMatchObject({ type: 'LimitExceeded', last: `LimitExceeded: ${MSG_PY_STEPS}`, line: 1 });
    expect(rows(sim)).toEqual([
      { key: 'r1', run: 'r1', file: 'loop.py', state: 'failed', startedAt: t0, endedAt: t0 + 500 * MS, requests: 0, error: `LimitExceeded: ${MSG_PY_STEPS}`, updatedAt: t0 + 500 * MS },
    ]);
    expect(rowWrites(evs).map((w) => [w.t, w.row['state']])).toEqual([[t0, 'running'], [t0 + 500 * MS, 'failed']]);
    expect(packetsOf(evs)).toEqual([]);
    expect(scriptDebug(evs)).toEqual([`${SCRIPT_HOST_DEBUG}: r1: loop.py started`, `${SCRIPT_HOST_DEBUG}: r1: loop.py failed: LimitExceeded: ${MSG_PY_STEPS}`]);
    expect(checkFact(sim, { kind: 'fact', device: 'DEV1', fact: 'automation.lastRun', equals: 'failed' }).pass).toBe(true);
  });

  it('time.sleep(5) advances 5 s; the script reads the sim time and the device clock; the shell prints as the script prints', () => {
    const sim = smallWorld();
    save(sim, 'sleepy.py', SLEEPY);
    const cursor = sim.trace(0).next;
    const t0 = sim.now;
    const s = shell(sim, 'python sleepy.py');
    sim.runToIdle();
    const evs = sim.trace(cursor).events;
    const out = evs.filter((e): e is CliOut => e.kind === 'cliOutput' && e.session === s);
    const unix = Math.floor((NF_WORLD_EPOCH_UNIX_MS + (t0 + 5 * SEC) / MS) / 1000);
    expect(sim.device('dev1')!.clockView(t0 + 5 * SEC).unixMs).toBe(NF_WORLD_EPOCH_UNIX_MS + (t0 + 5 * SEC) / MS);
    expect(out.map((e) => [e.t, e.text])).toEqual([
      [t0, `before ${t0}\n`],
      [t0 + 5 * SEC, `after ${5 * SEC}\n${unix}\n`],
    ]);
    expect(promptBack(evs, s)?.t).toBe(t0 + 5 * SEC);
    const r = view(sim).runs[0]!;
    expect(r).toMatchObject({ state: 'completed', startedAt: t0, endedAt: t0 + 5 * SEC, sleptNs: 5 * SEC, slices: 2 });
    expect(rowWrites(evs).map((w) => [w.t, w.row['state']])).toEqual([[t0, 'running'], [t0 + 5 * SEC, 'completed']]);
    expect(scriptDebug(evs)).toEqual([
      `${SCRIPT_HOST_DEBUG}: r1: sleepy.py started`,
      `${SCRIPT_HOST_DEBUG}: r1: sleeping 5000 ms`,
      `${SCRIPT_HOST_DEBUG}: r1: sleepy.py completed`,
    ]);
    sim.cli.close(s);
  });

  it('a syntax error fails the run at once and sends no packet; the shell prints the traceback; sys.argv', () => {
    const sim = smallWorld();
    save(sim, 'broken.py', BROKEN);
    save(sim, 'args.py', 'import sys\nprint(sys.argv)\nsys.exit(3)\n');
    const cursor = sim.trace(0).next;
    const t0 = sim.now;
    const s = shell(sim, 'python broken.py');
    const evs = sim.trace(cursor).events;
    const text = sessionText(evs, s);
    expect(text.startsWith('  File "broken.py", line 1\n')).toBe(true);
    expect(text).toMatch(/\nSyntaxError: [^\n]+\n$/);
    expect(promptBack(evs, s)?.t).toBe(t0);
    const r = view(sim).runs[0]!;
    expect(r).toMatchObject({ state: 'failed', startedAt: t0, endedAt: t0, slices: 1, steps: 0 });
    expect(`${r.error!.traceback}\n`).toBe(text);
    expect(rows(sim)).toEqual([expect.objectContaining({ run: 'r1', state: 'failed', startedAt: t0, endedAt: t0, requests: 0, error: r.error!.last })]);
    expect(rowWrites(evs).map((w) => w.row['state'])).toEqual(['running', 'failed']);
    sim.runFor(5 * SEC);
    expect(packetsOf(sim.trace(cursor).events)).toEqual([]);
    // the arguments after the file name; sys.exit(3) fails the run without a traceback on the shell
    const c2 = sim.trace(0).next;
    const s2 = shell(sim, 'python args.py R1 R2');
    const evs2 = sim.trace(c2).events;
    expect(sessionText(evs2, s2)).toBe("['args.py', 'R1', 'R2']\n");
    expect(sim.cli.session(s2)).toMatchObject({ busy: false });
    expect(view(sim).runs[1]).toMatchObject({ run: 'r2', argv: ['R1', 'R2'], state: 'failed', error: { type: 'SystemExit', last: 'SystemExit: 3' } });
    sim.cli.close(s);
    sim.cli.close(s2);
  });

  it('a run whose requests fail at once goes on 0 ns later in a dispatch of its own, up to the request cap', () => {
    const sim = smallWorld();
    const many = (n: number): string =>
      ['import requests', 'failed = 0', `for i in range(${n}):`, '    try:', '        requests.get("ftp://files.example/x")', '    except requests.exceptions.InvalidURL:', '        failed += 1', 'print(failed)', ''].join('\n');
    save(sim, 'many.py', many(PY_MAX_REQUESTS));
    save(sim, 'toomany.py', many(PY_MAX_REQUESTS + 1));
    const cursor = sim.trace(0).next;
    const t0 = sim.now;
    const ok = run(sim, 'many.py');
    sim.runToIdle();
    const r = runOf(sim, ok);
    expect(r).toMatchObject({ state: 'completed', startedAt: t0, endedAt: t0, output: `${PY_MAX_REQUESTS}\n` });
    expect(r.requests).toHaveLength(PY_MAX_REQUESTS);
    for (const q of r.requests) expect(q).toMatchObject({ state: 'failed', error: 'bad-url', startedAt: t0, endedAt: t0 });
    expect(rows(sim)[0]).toMatchObject({ state: 'completed', requests: PY_MAX_REQUESTS });
    const bad = run(sim, 'toomany.py');
    sim.runToIdle();
    const r2 = runOf(sim, bad);
    expect(r2).toMatchObject({ state: 'failed', error: { last: `LimitExceeded: ${MSG_PY_REQUESTS}` } });
    expect(r2.requests).toHaveLength(PY_MAX_REQUESTS);
    expect(rows(sim)[1]).toMatchObject({ state: 'failed', requests: PY_MAX_REQUESTS, error: `LimitExceeded: ${MSG_PY_REQUESTS}` });
    // a bad address never leaves the host
    expect(packetsOf(sim.trace(cursor).events)).toEqual([]);
  });
});

// ── stop, refusals, files, the table and silence ─────────────────────────────────────────────────────────────

describe('stop, refusals, files, the table bound and silence', () => {
  it('Ctrl+C stops a sleeping run and cancels its timers; the workspace stops a run whose request is pending, and its late answer changes nothing', () => {
    const sim = smallWorld();
    save(sim, 'forever.py', FOREVER);
    const cursor = sim.trace(0).next;
    const s = shell(sim, 'python forever.py');
    sim.runFor(2500 * MS);
    expect(view(sim).runs[0]).toMatchObject({ state: 'running', waiting: 'sleep', sleptNs: 3 * SEC });
    const tStop = sim.now;
    sim.cli.interrupt(s);
    let evs = sim.trace(cursor).events;
    expect(sessionText(evs, s)).toBe(`${MSG_SCRIPT_STOPPED}\n`);
    expect(promptBack(evs, s)?.t).toBe(tStop);
    expect(rows(sim)).toEqual([expect.objectContaining({ run: 'r1', state: 'stopped', endedAt: tStop, requests: 0 })]);
    expect(view(sim).runs[0]).not.toHaveProperty('waiting');
    // nothing of the run is left: no slice, no sleep, no further line
    const before = scriptDebug(sim.trace(cursor).events).length;
    sim.runFor(10 * SEC);
    expect(scriptDebug(sim.trace(cursor).events)).toHaveLength(before);
    expect(view(sim).runs[0]!.sleptNs).toBe(3 * SEC);
    sim.cli.close(s);

    // the workspace's stop while a request waits for an address nobody answers
    save(sim, 'stuck.py', 'import requests\nr = requests.get("http://10.0.99.99/", timeout=30)\nprint(r.status_code)\n');
    const c2 = sim.trace(0).next;
    const token = run(sim, 'stuck.py');
    sim.runFor(100 * MS);
    expect(runOf(sim, token)).toMatchObject({ state: 'running', waiting: 'http' });
    sim.hostRequest('dev1', { app: 'script.stop', run: token });
    const t2 = sim.now;
    const stoppedRun = runOf(sim, token);
    expect(stoppedRun).toMatchObject({ state: 'stopped', endedAt: t2 });
    expect(stoppedRun.requests).toEqual([expect.objectContaining({ n: 1, state: 'abandoned', endedAt: t2 })]);
    sim.runFor(40 * SEC);
    // http-client answered the abandoned request (it failed), and the script host ignored it
    const client = sim.device('dev1')!.processes.get('http-client')!.stateSnapshot().state as { requests: Record<string, { phase: string }> };
    expect(client.requests[scriptRequestToken('r2', 1)]?.phase).toBe('error');
    expect(runOf(sim, token)).toEqual(stoppedRun);
    expect(rows(sim)[1]).toEqual({ key: 'r2', run: 'r2', file: 'stuck.py', state: 'stopped', startedAt: stoppedRun.startedAt, endedAt: t2, requests: 1, updatedAt: t2 });
    expect(rowWrites(sim.trace(c2).events)).toHaveLength(2);
    // a stop of a token that is not running changes nothing
    sim.hostRequest('dev1', { app: 'script.stop', run: token });
    expect(view(sim).stopped).toBe(2);
  });

  it('refusals start no run and write no row; at most SCRIPT_HOST_MAX_RUNS active runs; a token in use', () => {
    const sim = smallWorld();
    save(sim, 'forever.py', FOREVER);
    const cursor = sim.trace(0).next;
    const missing = run(sim, 'nope.py');
    ask(sim, { kind: 'script.run', token: 'blank', file: '  ' });
    expect(view(sim).refused).toEqual([
      { token: missing, file: 'nope.py', reason: msgScriptNoFile('nope.py'), at: sim.now },
      { token: 'blank', file: '  ', reason: MSG_SCRIPT_NO_NAME, at: sim.now },
    ]);
    expect(view(sim).runs).toEqual([]);
    expect(rows(sim)).toEqual([]);
    // a refusal with a session answers it and ends its job
    const s = sim.cli.open('dev1', 'console');
    ask(sim, { kind: 'script.run', token: 'x', file: 'nope.py', session: s });
    expect(sessionText(sim.trace(cursor).events, s)).toBe(`${msgScriptNoFile('nope.py')}\n`);
    sim.cli.close(s);
    // the run cap
    const tokens = Array.from({ length: SCRIPT_HOST_MAX_RUNS }, () => run(sim, 'forever.py'));
    expect(view(sim).runs.map((r) => r.state)).toEqual(Array.from({ length: SCRIPT_HOST_MAX_RUNS }, () => 'running'));
    const fifth = run(sim, 'forever.py');
    expect(view(sim).refused.at(-1)).toEqual({ token: fifth, file: 'forever.py', reason: msgScriptHostBusy(SCRIPT_HOST_MAX_RUNS), at: sim.now });
    // a token that names an active run
    ask(sim, { kind: 'script.run', token: tokens[0]!, file: 'forever.py' });
    expect(view(sim).refused.at(-1)?.reason).toBe(MSG_SCRIPT_TOKEN_BUSY);
    expect(rows(sim).map((r) => r.run)).toEqual(['r1', 'r2', 'r3', 'r4']);
    // stopping one frees a place
    sim.hostRequest('dev1', { app: 'script.stop', run: tokens[1]! });
    const again = run(sim, 'forever.py');
    expect(runOf(sim, again)).toMatchObject({ run: 'r5', state: 'running' });
    for (const t of [...tokens, again]) sim.hostRequest('dev1', { app: 'script.stop', run: t });
    expect(view(sim)).toMatchObject({ started: 5, stopped: 5, completed: 0, failed: 0 });
    expect(sim.runToIdle().stopped).toBeUndefined();
  });

  it(`the table keeps ${SCRIPT_RUNS_LIMIT} rows: a new run replaces the oldest finished one; the StateView keeps the active runs and the last finished ones`, () => {
    const sim = smallWorld();
    save(sim, 'quick.py', QUICK);
    save(sim, 'forever.py', FOREVER);
    const cursor = sim.trace(0).next;
    const first = run(sim, 'forever.py'); // r1 stays active throughout
    for (let i = 0; i < SCRIPT_RUNS_LIMIT + 1; i++) run(sim, 'quick.py'); // r2 … r22
    const keys = rows(sim).map((r) => r.key);
    expect(keys).toHaveLength(SCRIPT_RUNS_LIMIT);
    // r1 (running) is never replaced: the oldest finished rows r2 and r3 went first
    expect(keys).toEqual(['r1', ...Array.from({ length: SCRIPT_RUNS_LIMIT - 1 }, (_, i) => `r${i + 4}`)]);
    const expired = sim.trace(cursor).events.filter((e): e is Extract<TraceEvent, { kind: 'tableExpire' }> => e.kind === 'tableExpire' && e.table === 'script-runs');
    expect(expired.map((e) => [e.key, e.reason])).toEqual([['r2', 'replaced'], ['r3', 'replaced']]);
    expect(view(sim).runs.map((r) => r.run)).toEqual(['r1', ...Array.from({ length: SCRIPT_HOST_RETAINED_RUNS }, (_, i) => `r${SCRIPT_RUNS_LIMIT + 3 - SCRIPT_HOST_RETAINED_RUNS + i}`)]);
    expect(view(sim).completed).toBe(SCRIPT_RUNS_LIMIT + 1);
    sim.hostRequest('dev1', { app: 'script.stop', run: first });
    expect(rows(sim)[0]).toMatchObject({ key: 'r1', state: 'stopped' });
  });

  it('files through the storage action: write, replace, delete; the snapshot lists them; a run reads the file as it is when it starts', () => {
    const sim = smallWorld();
    const dev = sim.device('dev1')!;
    save(sim, 'b.py', 'print("b")\n');
    save(sim, 'a.py', 'print("a")\n');
    expect(dev.files!('files').map((f) => [f.path, f.size])).toEqual([['a.py', 11], ['b.py', 11]]);
    expect(sim.snapshot().devices.find((d) => d.id === 'dev1')?.storage).toEqual([
      { fs: 'files', files: [{ fs: 'files', path: 'a.py', size: 11, modifiedAt: sim.now }, { fs: 'files', path: 'b.py', size: 11, modifiedAt: sim.now }] },
    ]);
    save(sim, 'a.py', 'print("A2")\n');
    expect(dev.readFile!('files', 'a.py')?.content).toBe('print("A2")\n');
    const token = run(sim, 'a.py');
    expect(runOf(sim, token).output).toBe('A2\n');
    sim.hostRequest('dev1', { app: 'file.delete', path: 'b.py' });
    expect(dev.files!('files').map((f) => f.path)).toEqual(['a.py']);
    expect(scriptDebug(sim.trace(0).events).filter((l) => l.includes('of '))).toEqual([
      `${SCRIPT_HOST_DEBUG}: write of b.py (11 characters)`,
      `${SCRIPT_HOST_DEBUG}: write of a.py (11 characters)`,
      `${SCRIPT_HOST_DEBUG}: write of a.py (12 characters)`,
      `${SCRIPT_HOST_DEBUG}: delete of b.py`,
    ]);
  });

  it('silent until a run: no packet, no row, no debug line, an empty StateView', () => {
    const sim = smallWorld();
    sim.runFor(120 * SEC);
    const all = sim.trace(0).events;
    expect(all.filter((e) => e.kind === 'pduCreated' && e.process === 'script-host')).toEqual([]);
    expect(scriptDebug(all)).toEqual([]);
    expect(rows(sim)).toEqual([]);
    expect(view(sim)).toEqual({ runs: [], refused: [], started: 0, completed: 0, failed: 0, stopped: 0 });
    expect(sim.device('dev1')!.processes.get('script-host')!.debugEvents()).toEqual([]);
  });
});

// ── determinism ──────────────────────────────────────────────────────────────────────────────────────────────

describe('determinism', () => {
  it('three runs of one script with one seed are byte-identical', () => {
    const script = [
      'import requests, time',
      `AUTH = ("admin", "${PASSWORD}")`,
      'for k in range(3):',
      `    r = requests.get("https://${R1}/restconf/data/ietf-interfaces:interfaces", auth=AUTH)`,
      '    print(k, r.status_code, len(r.text), time.monotonic_ns())',
      '    time.sleep(0.25)',
      `r = requests.put("https://${R1}/restconf/data/nf-native:native/hostname", json={"nf-native:hostname": "EDGE"}, auth=AUTH)`,
      'print(r.status_code)',
      '',
    ].join('\n');
    const once = (): string => {
      const sim = smallWorld(7);
      save(sim, 'det.py', script);
      run(sim, 'det.py');
      sim.runFor(30 * SEC);
      const t = sim.trace(0);
      return JSON.stringify({ events: t.events, dropped: t.dropped, view: view(sim), rows: rows(sim) });
    };
    const a = once();
    const first = (JSON.parse(a) as { view: ScriptHostStateView }).view.runs[0]!;
    expect(first.state).toBe('completed');
    expect(first.requests.map((q) => [q.method, q.status])).toEqual([['GET', 200], ['GET', 200], ['GET', 200], ['PUT', 204]]);
    expect(first.sleptNs).toBe(750 * MS);
    expect(once()).toBe(a);
    expect(once()).toBe(a);
  });
});
