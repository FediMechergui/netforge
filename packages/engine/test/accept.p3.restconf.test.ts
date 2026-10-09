/**
 * P3 acceptance — a REST change over the simulated network (ARCHITECTURE-P3 §10.1 row `accept.p3.restconf`; §3.8
 * steps 1–7; D21, D22; §4.2, §4.3; §5.6; rule 20; §7 W4 qa).
 *
 * The row, clause by clause, on `staged.world` at stage P3 (rule 13), whose registry is the real one since the W4
 * catalog flip (ruling R47 removed the pre-flip overlay, `FLIP_FACTORIES`). Every request is the learner's host-shell
 * `rest` command typed on PC1's console (a journaled `cliExec`); console changes on the switches are typed too.
 *
 *   §3.8 world: PC1 (NF-PC) 10.0.99.10/24 on SW1 Fa0/1 (access VLAN 99, PortFast); SW1 Gi0/2 ↔ SW2 Gi0/1 and SW2 Gi0/2 ↔
 *   SW3 Gi0/1, trunks; Vlan99 10.0.99.11 / .12 / .13. Each switch: `username admin privilege 15 secret Lab-Pass1`,
 *   `ip http secure-server`, `ip http authentication local`, `restconf` (the lines that wake its transport, D22). SW2
 *   Gi0/2 carries the description `uplink - add vlan 40 NAME FINANCE on SW3`.
 *
 *   • the status-code matrix (GET/HEAD 200; POST 201 or 409; PUT 201 then 204; PATCH and DELETE 204 or 404; 400, 404,
 *     405, 415 with an `ietf-restconf:errors` body); 401 (no credentials, a wrong password, a user below privilege 15);
 *   • the CLI validator's error becomes the 400 body (the console's own error text, word for word); an atomic write
 *     with one refused line applies nothing (the revert is visible and carries the origin);
 *   • every data segment on TCP 443 carries `meta.protected` + `protectedBy: 'tls'` (no handshake bytes exist);
 *   • configure is never nested: the lines run in a `deviceConfigure` dispatch of their own, and a 60-VLAN PUT runs
 *     within the action budget;
 *   • `configChange` carries the origin {via restconf, user, address}; a typed line carries none;
 *   • GET reflects CLI changes; the `restconf-log` keeps the last `RESTCONF_LOG_LIMIT` requests;
 *   • the `rest` command prints the status line, the headers and the (pretty-printed) body, keeps a `-d` body with
 *     quotes, brackets and spaces verbatim, and the whole session is replayed exactly from the journal.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId, SessionId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { RestconfLogRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createReplay } from '../src/sim/replay.js';
import {
  MSG_RESTCONF_LOGIN_FAILED,
  MSG_RESTCONF_LOGIN_NEEDED,
  MSG_RESTCONF_MEDIA_TYPE,
  RESTCONF_JSON_TYPE,
  RESTCONF_LOG_LIMIT,
} from '../src/protocols/restconf.js';
import { createStagedCatalog, createStagedSimulation } from './staged.world.js';

const SEED = 3_008;
const PASSWORD = 'Lab-Pass1';
const PC = '10.0.99.10';
const SW = { sw1: '10.0.99.11', sw2: '10.0.99.12', sw3: '10.0.99.13' } as const;
const ORIGIN = { via: 'restconf', user: 'admin', address: PC } as const;
const AUTH = `-u admin:${PASSWORD}`;
const JSON_TYPE = `-H "Content-Type: ${RESTCONF_JSON_TYPE}"`;
const UPLINK_NOTE = 'uplink - add vlan 40 NAME FINANCE on SW3';

type Change = Extract<TraceEvent, { kind: 'configChange' }>;
type Created = Extract<TraceEvent, { kind: 'pduCreated' }>;

function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

/** One switch of the line: its service lines, VLAN 99, its management SVI, and its uplink / downlink trunks. */
function switchConfig(name: string, address: string, opts: { pcPort?: boolean; up?: boolean; down?: string; guest?: boolean }): string {
  const sections: string[][] = [
    [`hostname ${name}`],
    [`username admin privilege 15 secret ${PASSWORD}`],
    ...(opts.guest === true ? [['username guest privilege 1 secret Guest-Pass1']] : []),
    ['ip http secure-server'],
    ['ip http authentication local'],
    ['restconf'],
    ['vlan 99', ' name MGMT'],
  ];
  if (opts.pcPort === true) sections.push(['interface FastEthernet0/1', ' switchport mode access', ' switchport access vlan 99', ' spanning-tree portfast']);
  if (opts.up === true) sections.push(['interface GigabitEthernet0/1', ' switchport mode trunk']);
  if (opts.down !== undefined) sections.push(['interface GigabitEthernet0/2', ...(opts.down === '' ? [] : [` description ${opts.down}`]), ' switchport mode trunk']);
  sections.push(['interface Vlan99', ` ip address ${address} 255.255.255.0`, ' no shutdown']);
  return startup(sections);
}

/** The §3.8 world, booted and settled (trunks forwarding) at 100 s. */
function world(seed = SEED): Simulation {
  const sim = createStagedSimulation({ seed, stage: 'P3' });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: startup([['hostname PC1'], ['interface GigabitEthernet0', ` ip address ${PC} 255.255.255.0`]]) });
  sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: switchConfig('SW1', SW.sw1, { pcPort: true, down: '', guest: true }) });
  sim.addDevice({ id: 'sw2', type: 'switch.nfc2960', name: 'SW2', startupConfig: switchConfig('SW2', SW.sw2, { up: true, down: UPLINK_NOTE }) });
  sim.addDevice({ id: 'sw3', type: 'switch.nfc2960', name: 'SW3', startupConfig: switchConfig('SW3', SW.sw3, { up: true }) });
  sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
  sim.addLink({ a: { device: 'sw1', port: 'GigabitEthernet0/2' }, b: { device: 'sw2', port: 'GigabitEthernet0/1' } });
  sim.addLink({ a: { device: 'sw2', port: 'GigabitEthernet0/2' }, b: { device: 'sw3', port: 'GigabitEthernet0/1' } });
  sim.runUntil(100 * SEC);
  return sim;
}

// ── the rest command on PC1 ───────────────────────────────────────────────────────────────────────────────────

interface Reply {
  /** Everything the session printed for the job. */
  readonly text: string;
  readonly status?: number;
  readonly reason?: string;
  readonly headers: readonly (readonly [string, string])[];
  /** The printed body (after the blank line), without the final newline. */
  readonly body: string;
  /** Trace events of the call. */
  readonly evs: readonly TraceEvent[];
}

/** Type `line` on a fresh console of PC1 (the `rest` job), run until the job is over, and read what it printed. */
function rest(sim: Simulation, line: string): Reply {
  const s: SessionId = sim.cli.open('pc1', 'console');
  const cursor = sim.trace(0).next;
  const started = sim.cli.exec(s, line);
  expect(started.error, line).toBeUndefined();
  expect(started.busy, line).toBe(true);
  let done = false;
  for (let i = 0; i < 400 && !done; i++) {
    sim.runFor(SEC / 20);
    done = sim.trace(cursor).events.some((e) => e.kind === 'cliPrompt' && e.session === s && !e.busy);
  }
  expect(done, `the job of "${line.slice(0, 60)}" ended`).toBe(true);
  const evs = sim.trace(cursor).events;
  sim.cli.close(s);
  const text = evs.filter((e): e is Extract<TraceEvent, { kind: 'cliOutput' }> => e.kind === 'cliOutput' && e.session === s).map((e) => e.text).join('');
  const lines = text.split('\n');
  const m = /^HTTP\/1\.1 (\d{3}) (.*)$/.exec(lines[0] ?? '');
  if (m === null) return { text, headers: [], body: '', evs };
  const blank = lines.indexOf('');
  const headers = lines.slice(1, blank).map((l) => {
    const at = l.indexOf(':');
    return [l.slice(0, at), l.slice(at + 1).trim()] as const;
  });
  const body = lines.slice(blank + 1).join('\n').replace(/\n$/, '');
  return { text, status: Number(m[1]), reason: m[2]!, headers, body, evs };
}

const url = (dev: keyof typeof SW, path: string): string => `https://${SW[dev]}/restconf${path}`;
const header = (r: Reply, name: string): string | undefined => r.headers.find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1];
const errorOf = (r: Reply): { type: string; tag: string; message: string } => {
  const e = (JSON.parse(r.body) as { 'ietf-restconf:errors': { error: { 'error-type': string; 'error-tag': string; 'error-message': string }[] } })['ietf-restconf:errors'].error[0]!;
  return { type: e['error-type'], tag: e['error-tag'], message: e['error-message'] };
};
const logRows = (sim: Simulation, dev: DeviceId = 'sw1'): RestconfLogRow[] => sim.device(dev)!.tables.get<RestconfLogRow>('restconf-log')!.rows();
const vlanNames = (sim: Simulation, dev: DeviceId = 'sw1'): Record<string, string | null> => {
  const out: Record<string, string | null> = {};
  for (const n of sim.device(dev)!.running.root.children) if (n.key === 'vlan') out[n.args[0]!] = n.children.find((c) => c.key === 'name')?.args[0] ?? null;
  return out;
};
const changes = (evs: readonly TraceEvent[], dev: DeviceId = 'sw1'): Change[] => evs.filter((e): e is Change => e.kind === 'configChange' && e.device === dev);

/** Type configuration lines on a console of `dev`; returns the error of the first refused line (or undefined). */
function typeConfig(sim: Simulation, dev: DeviceId, lines: readonly string[]): string | undefined {
  const s = sim.cli.open(dev, 'console');
  let refused: string | undefined;
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) {
    const r = sim.cli.exec(s, line);
    if (r.error !== undefined && refused === undefined) refused = r.error.message;
  }
  sim.cli.close(s);
  return refused;
}

describe('§3.8 steps 1–6: the PUT of the walk-through, typed in the host shell', () => {
  it('201 Created, then 204; the VLAN exists; the log row; configChange carries the origin; the -d body travels verbatim', () => {
    const sim = world();
    // quotes, brackets and runs of spaces, typed unquoted after -d (it takes the rest of the line verbatim, D21)
    const body = '{"nf-native:vlan-list":  [ {"id": 30,  "name": "VOICE"} ]}';
    const line = `rest PUT ${url('sw1', '/data/nf-native:native/vlan/vlan-list=30')} ${AUTH} ${JSON_TYPE} -d ${body}`;
    const first = rest(sim, line);
    expect([first.status, first.reason]).toEqual([201, 'Created']);
    // the printed answer: the status line, the headers, a blank line, no body
    expect(first.text.split('\n')[0]).toBe('HTTP/1.1 201 Created');
    expect(header(first, 'Connection')).toBe('close');
    expect(first.text.endsWith('\n\n')).toBe(true);
    expect(first.body).toBe('');
    // the request on the wire: PUT with the typed body byte for byte, Basic credentials, the typed Content-Type
    const req = first.evs.find((e): e is Created => e.kind === 'pduCreated' && e.device === 'pc1' && e.pdu.proto === 'http')!;
    const view = sim.pdu(req.pdu.id)!;
    expect(view.get('http.method')).toBe('PUT');
    expect(view.get('http.target')).toBe('/restconf/data/nf-native:native/vlan/vlan-list=30');
    expect(view.get('http.body')).toBe(body);
    expect(String(view.get('http.headers'))).toContain(`Content-Type: ${RESTCONF_JSON_TYPE}`);
    expect(String(view.get('http.headers'))).toContain(`Authorization: Basic ${Buffer.from(`admin:${PASSWORD}`).toString('base64')}`);
    expect(vlanNames(sim)['30']).toBe('VOICE');
    // configChange events of the API write carry the origin
    const api = changes(first.evs);
    expect(api.map((c) => c.line)).toEqual(['vlan 30', 'name VOICE']);
    for (const c of api) expect(c.origin).toEqual(ORIGIN);
    // the log row (rule 20: gradeable)
    expect(logRows(sim)).toEqual([
      expect.objectContaining({ key: '1', seq: 1, method: 'PUT', path: '/restconf/data/nf-native:native/vlan/vlan-list=30', status: 201, client: PC, user: 'admin' }),
    ]);
    const second = rest(sim, line);
    expect([second.status, second.reason, second.body]).toEqual([204, 'No Content', '']);
    expect(changes(second.evs)).toEqual([]);
    expect(logRows(sim).map((r) => r.status)).toEqual([201, 204]);
    // a typed line carries no origin
    const cursor = sim.trace(0).next;
    expect(typeConfig(sim, 'sw1', ['vlan 31'])).toBeUndefined();
    const typed = changes(sim.trace(cursor).events);
    expect(typed.map((c) => c.line)).toEqual(['vlan 31']);
    expect(typed[0]).not.toHaveProperty('origin');
  });

  it('a GET prints the status line, the headers and the pretty-printed RFC 7951 JSON, read from the running configuration', () => {
    const sim = world();
    const r = rest(sim, `rest GET ${url('sw2', '/data/ietf-interfaces:interfaces')} ${AUTH}`);
    expect([r.status, r.reason]).toEqual([200, 'OK']);
    expect(header(r, 'Content-Type')).toBe(RESTCONF_JSON_TYPE);
    expect(Number(header(r, 'Content-Length'))).toBeGreaterThan(0);
    // the body is printed pretty (two-space indentation, members in their order)
    const parsed = JSON.parse(r.body) as { 'ietf-interfaces:interfaces': { interface: { name: string; description?: string; type: string }[] } };
    expect(r.body).toBe(JSON.stringify(parsed, null, 2));
    const list = parsed['ietf-interfaces:interfaces'].interface;
    expect(list.find((i) => i.name === 'GigabitEthernet0/2')).toMatchObject({ description: UPLINK_NOTE, type: 'iana-if-type:ethernetCsmacd' });
    expect(list.find((i) => i.name === 'Vlan99')).toMatchObject({ type: 'iana-if-type:l3ipvlan', 'ietf-ip:ipv4': { address: [{ ip: SW.sw2, 'prefix-length': 24 }] } });
    expect(logRows(sim, 'sw2').map((row) => [row.method, row.path, row.status])).toEqual([['GET', '/restconf/data/ietf-interfaces:interfaces', 200]]);
  });
});

describe('the status-code matrix (D21) and 401', () => {
  it('GET/HEAD 200; POST 201/409; PATCH 204/404; DELETE 204/404; 400; 404; 405; 415 — each with its errors body', () => {
    const sim = world();
    const data = (path: string): string => url('sw1', `/data/nf-native:native${path}`);
    const get = rest(sim, `rest GET ${data('/hostname')} ${AUTH}`);
    expect([get.status, JSON.parse(get.body)]).toEqual([200, { 'nf-native:hostname': 'SW1' }]);
    const head = rest(sim, `rest HEAD ${data('/hostname')} ${AUTH}`);
    expect([head.status, head.body]).toEqual([200, '']);
    expect(Number(header(head, 'Content-Length'))).toBeGreaterThan(0);
    expect(header(head, 'Content-Length')).toBe(header(get, 'Content-Length'));

    const finance = '{"nf-native:vlan-list":[{"id":40,"name":"FINANCE"}]}';
    expect(rest(sim, `rest POST ${data('/vlan')} ${AUTH} ${JSON_TYPE} -d ${finance}`).status).toBe(201);
    expect(vlanNames(sim)['40']).toBe('FINANCE');
    const again = rest(sim, `rest POST ${data('/vlan')} ${AUTH} ${JSON_TYPE} -d ${finance}`);
    expect([again.status, errorOf(again).tag]).toEqual([409, 'data-exists']);

    expect(rest(sim, `rest PATCH ${data('/vlan/vlan-list=40')} ${AUTH} ${JSON_TYPE} -d {"nf-native:vlan-list":[{"id":40,"name":"LEDGER"}]}`).status).toBe(204);
    expect(vlanNames(sim)['40']).toBe('LEDGER');
    expect(rest(sim, `rest PATCH ${data('/vlan/vlan-list=41')} ${AUTH} ${JSON_TYPE} -d {"nf-native:vlan-list":[{"id":41}]}`).status).toBe(404);
    expect(rest(sim, `rest DELETE ${data('/vlan/vlan-list=40')} ${AUTH}`).status).toBe(204);
    expect(vlanNames(sim)['40']).toBeUndefined();
    expect(rest(sim, `rest DELETE ${data('/vlan/vlan-list=40')} ${AUTH}`).status).toBe(404);

    // 400: the body's key differs from the URL's (RFC 8040), and a body that is not JSON
    const keyMismatch = rest(sim, `rest PUT ${data('/vlan/vlan-list=30')} ${AUTH} ${JSON_TYPE} -d {"nf-native:vlan-list":[{"id":31}]}`);
    expect([keyMismatch.status, errorOf(keyMismatch).tag]).toEqual([400, 'invalid-value']);
    const broken = rest(sim, `rest PUT ${data('/vlan/vlan-list=30')} ${AUTH} ${JSON_TYPE} -d {"nf-native:vlan-list": [ {id: 30} ]}`);
    expect([broken.status, errorOf(broken).tag]).toEqual([400, 'malformed-message']);
    // 404: no such node; a target outside /restconf
    expect(rest(sim, `rest GET ${data('/nothing')} ${AUTH}`).status).toBe(404);
    expect(rest(sim, `rest GET https://${SW.sw1}/api/v1/vlans ${AUTH}`).status).toBe(404);
    // 405: state data cannot be written; the API root is read only
    const state = rest(sim, `rest PUT ${url('sw1', '/data/ietf-interfaces:interfaces-state/interface=Vlan99')} ${AUTH} ${JSON_TYPE} -d {"ietf-interfaces:interface":[{"name":"Vlan99"}]}`);
    expect([state.status, errorOf(state).tag]).toEqual([405, 'operation-not-supported']);
    const root = rest(sim, `rest DELETE ${url('sw1', '')} ${AUTH}`);
    expect([root.status, header(root, 'Allow')]).toEqual([405, 'GET, HEAD']);
    // 415: a body that says it is not JSON
    const plain = rest(sim, `rest PUT ${data('/hostname')} ${AUTH} -H "Content-Type: text/plain" -d {"nf-native:hostname":"CORE1"}`);
    expect([plain.status, errorOf(plain).message]).toEqual([415, MSG_RESTCONF_MEDIA_TYPE]);
    expect(sim.device('sw1')!.hostname).toBe('SW1');
    // every error body is the RFC 8040 errors document, typed JSON
    for (const r of [again, keyMismatch, broken, state, plain]) expect(header(r, 'Content-Type')).toBe(RESTCONF_JSON_TYPE);
    expect(logRows(sim).map((r) => [r.method, r.status])).toEqual([
      ['GET', 200], ['HEAD', 200], ['POST', 201], ['POST', 409], ['PATCH', 204], ['PATCH', 404], ['DELETE', 204], ['DELETE', 404],
      ['PUT', 400], ['PUT', 400], ['GET', 404], ['GET', 404], ['PUT', 405], ['DELETE', 405], ['PUT', 415],
    ]);
  });

  it('401: no credentials, a wrong password and a user below privilege 15; nothing is applied and no user is logged', () => {
    const sim = world();
    const target = url('sw1', '/data/nf-native:native/hostname');
    const none = rest(sim, `rest GET ${target}`);
    expect([none.status, none.reason, header(none, 'WWW-Authenticate')]).toEqual([401, 'Unauthorized', 'Basic realm="restconf"']);
    expect(errorOf(none)).toEqual({ type: 'protocol', tag: 'access-denied', message: MSG_RESTCONF_LOGIN_NEEDED });
    const wrong = rest(sim, `rest PUT ${target} -u admin:wrong ${JSON_TYPE} -d {"nf-native:hostname":"X"}`);
    expect([wrong.status, errorOf(wrong).message]).toEqual([401, MSG_RESTCONF_LOGIN_FAILED]);
    expect(sim.device('sw1')!.hostname).toBe('SW1');
    expect(rest(sim, `rest GET ${target} -u guest:Guest-Pass1`).status).toBe(401);
    expect(rest(sim, `rest GET ${target} ${AUTH}`).status).toBe(200);
    expect(logRows(sim).map((r) => [r.status, r.user ?? null])).toEqual([[401, null], [401, null], [401, null], [200, 'admin']]);
  });
});

describe('the CLI decides (D21): its error is the 400 body; atomic writes revert', () => {
  it('VLAN 5000: the API answers 400 with the console\'s own error text, and nothing is applied', () => {
    const sim = world();
    const r = rest(sim, `rest PUT ${url('sw1', '/data/nf-native:native/vlan/vlan-list=5000')} ${AUTH} ${JSON_TYPE} -d {"nf-native:vlan-list":[{"id":5000,"name":"BIG"}]}`);
    expect(r.status).toBe(400);
    const typedError = typeConfig(sim, 'sw2', ['vlan 5000']);
    expect(typedError).toBeDefined();
    expect(errorOf(r)).toEqual({ type: 'application', tag: 'invalid-value', message: typedError });
    expect(vlanNames(sim)['5000']).toBeUndefined();
    expect(logRows(sim).at(-1)).toMatchObject({ method: 'PUT', status: 400, user: 'admin' });
  });

  it('an atomic PATCH with one refused line applies nothing: the valid line is set, then reverted, both with the origin', () => {
    const sim = world();
    const r = rest(sim, `rest PATCH ${url('sw1', '/data/nf-native:native/vlan')} ${AUTH} ${JSON_TYPE} -d {"nf-native:vlan":{"vlan-list":[{"id":30,"name":"VOICE"},{"id":4095}]}}`);
    expect([r.status, errorOf(r).tag]).toEqual([400, 'invalid-value']);
    expect(vlanNames(sim)['30']).toBeUndefined();
    const api = changes(r.evs);
    expect(api.some((c) => c.line === 'vlan 30' && !c.negate)).toBe(true);
    expect(api.some((c) => c.line === 'vlan 30' && c.negate)).toBe(true);
    for (const c of api) expect(c.origin).toEqual(ORIGIN);
  });
});

describe('TLS and the configure seam', () => {
  it('every data segment on TCP 443 carries meta.protected + protectedBy tls; no handshake bytes exist', () => {
    const sim = world();
    const cursor = sim.trace(0).next;
    rest(sim, `rest GET ${url('sw3', '/data/ietf-interfaces:interfaces')} ${AUTH}`);
    rest(sim, `rest PUT ${url('sw3', '/data/nf-native:native/vlan/vlan-list=40')} ${AUTH} ${JSON_TYPE} -d {"nf-native:vlan-list":[{"id":40,"name":"FINANCE"}]}`);
    const evs = sim.trace(cursor).events;
    const segments = evs
      .filter((e): e is Created => e.kind === 'pduCreated' && e.process === 'tcp')
      .map((e) => sim.pdu(e.pdu.id)!)
      .filter((p) => p.get('tcp.srcPort') === 443 || p.get('tcp.dstPort') === 443);
    const withData = segments.filter((p) => p.layer('http') !== undefined);
    expect(withData.length).toBeGreaterThanOrEqual(4);
    // the data segments of both connections: request heads on the client side, answers on the switch side
    expect(new Set(withData.map((p) => p.get('ipv4.src')))).toEqual(new Set([PC, SW.sw3]));
    for (const p of withData) expect(p.meta, p.summary()).toMatchObject({ protected: true, protectedBy: 'tls' });
    // the segments without data are the handshake and the close: SYN, ACK, FIN — no TLS record is ever sent
    for (const p of segments.filter((x) => x.layer('http') === undefined)) {
      expect(p.layers.at(-1)!.proto).toBe('tcp');
      expect(p.meta.protected).toBeUndefined();
    }
    // the first data segment of each connection is the HTTP request itself
    const fromPc = withData.filter((p) => p.get('ipv4.src') === PC);
    expect(fromPc.map((p) => p.get('http.method'))).toEqual(['GET', 'PUT']);
    expect(vlanNames(sim, 'sw3')['40']).toBe('FINANCE');
  });

  it('configure is never nested: the lines run in a deviceConfigure dispatch of their own; a 60-VLAN PUT is within budget', () => {
    const sim = world();
    const vlans = Array.from({ length: 60 }, (_, i) => ({ id: 100 + i, name: `LAB${100 + i}` }));
    const body = JSON.stringify({ 'nf-native:vlan': { 'vlan-list': [{ id: 99, name: 'MGMT' }, ...vlans] } });
    const s = sim.cli.open('pc1', 'console');
    const cursor = sim.trace(0).next;
    expect(sim.cli.exec(s, `rest PUT ${url('sw1', '/data/nf-native:native/vlan')} ${AUTH} ${JSON_TYPE} -d ${body}`).busy).toBe(true);
    // step one dispatch at a time until the job ends: every configChange of the run appears in ONE dispatch, a
    // deviceConfigure event, after the dispatch where restconf consumed the request
    const kindsWithChanges: string[] = [];
    let requestSeenAt = -1;
    let configuredAt = -1;
    for (let i = 0; i < 20_000; i++) {
      const before = sim.trace(0).next;
      const ev = sim.step();
      if (ev === undefined) break;
      const got = sim.trace(before).events;
      if (got.some((e) => e.kind === 'pduConsumed' && e.device === 'sw1' && e.pdu.proto === 'http') && requestSeenAt < 0) requestSeenAt = i;
      if (got.some((e) => e.kind === 'configChange' && e.device === 'sw1')) {
        kindsWithChanges.push(ev.kind);
        configuredAt = i;
      }
      if (got.some((e) => e.kind === 'cliPrompt' && e.session === s && !e.busy)) break;
    }
    expect(kindsWithChanges).toEqual(['deviceConfigure']);
    expect(requestSeenAt).toBeGreaterThanOrEqual(0);
    expect(configuredAt).toBeGreaterThan(requestSeenAt);
    const evs = sim.trace(cursor).events;
    const text = evs.filter((e): e is Extract<TraceEvent, { kind: 'cliOutput' }> => e.kind === 'cliOutput' && e.session === s).map((e) => e.text).join('');
    expect(text.split('\n')[0]).toBe('HTTP/1.1 204 No Content');
    // all 60 VLANs with their names, VLAN 99 kept, one configChange per line, each with the origin, no budget drop
    const names = vlanNames(sim);
    for (const v of vlans) expect(names[String(v.id)], `vlan ${v.id}`).toBe(v.name);
    expect(names['99']).toBe('MGMT');
    const api = changes(evs);
    expect(api).toHaveLength(120);
    for (const c of api) expect(c.origin).toEqual(ORIGIN);
    expect(evs.some((e) => e.kind === 'drop' && e.detail === 'action-budget')).toBe(false);
    expect(logRows(sim).at(-1)).toMatchObject({ method: 'PUT', path: '/restconf/data/nf-native:native/vlan', status: 204 });
    // the management VLAN still answers
    expect(rest(sim, `rest GET ${url('sw1', '/data/nf-native:native/vlan/vlan-list=159')} ${AUTH}`).status).toBe(200);
  });
});

describe('reads and the log', () => {
  it('GET reflects CLI changes typed on the console', () => {
    const sim = world();
    const before = rest(sim, `rest GET ${url('sw1', '/data/nf-native:native/vlan/vlan-list=50')} ${AUTH}`);
    expect(before.status).toBe(404);
    expect(typeConfig(sim, 'sw1', ['vlan 50', 'name SALES', 'exit', 'hostname EDGE1'])).toBeUndefined();
    const vlan = rest(sim, `rest GET ${url('sw1', '/data/nf-native:native/vlan/vlan-list=50')} ${AUTH}`);
    expect([vlan.status, JSON.parse(vlan.body)]).toEqual([200, { 'nf-native:vlan-list': [{ id: 50, name: 'SALES' }] }]);
    const host = rest(sim, `rest GET ${url('sw1', '/data/nf-native:native/hostname')} ${AUTH}`);
    expect(JSON.parse(host.body)).toEqual({ 'nf-native:hostname': 'EDGE1' });
  });

  it(`the restconf-log keeps the last ${RESTCONF_LOG_LIMIT} requests; the oldest go with reason 'replaced'`, () => {
    const sim = world();
    const cursor = sim.trace(0).next;
    for (let i = 0; i < RESTCONF_LOG_LIMIT + 3; i++) expect(rest(sim, `rest GET ${url('sw1', '/data/nf-native:native/hostname')} ${AUTH}`).status).toBe(200);
    const rows = logRows(sim);
    expect(rows).toHaveLength(RESTCONF_LOG_LIMIT);
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: RESTCONF_LOG_LIMIT }, (_, i) => i + 4));
    const expired = sim.trace(cursor).events.filter((e): e is Extract<TraceEvent, { kind: 'tableExpire' }> => e.kind === 'tableExpire' && e.table === 'restconf-log');
    expect(expired.map((e) => [e.device, e.key, e.reason])).toEqual([['sw1', '1', 'replaced'], ['sw1', '2', 'replaced'], ['sw1', '3', 'replaced']]);
    expect(rows.every((r) => r.client === PC && r.user === 'admin' && r.method === 'GET')).toBe(true);
  });
});

describe('the journal and determinism', () => {
  /** The scripted session: a PUT with a verbatim body, a refused write, a GET, a console change and a DELETE. */
  function script(seed = SEED): Simulation {
    const sim = world(seed);
    rest(sim, `rest PUT ${url('sw1', '/data/nf-native:native/vlan/vlan-list=30')} ${AUTH} ${JSON_TYPE} -d {"nf-native:vlan-list": [ {"id": 30, "name": "VOICE"} ]}`);
    rest(sim, `rest PUT ${url('sw2', '/data/nf-native:native/vlan/vlan-list=5000')} ${AUTH} ${JSON_TYPE} -d {"nf-native:vlan-list":[{"id":5000}]}`);
    rest(sim, `rest GET ${url('sw2', '/data/ietf-interfaces:interfaces')} ${AUTH}`);
    typeConfig(sim, 'sw3', ['vlan 40', 'name FINANCE']);
    rest(sim, `rest DELETE ${url('sw1', '/data/nf-native:native/vlan/vlan-list=30')} ${AUTH}`);
    sim.runFor(5 * SEC);
    return sim;
  }

  it('the rest session is replayed exactly from the journal: byte-identical trace and snapshot', () => {
    const live = script();
    const journal = live.journal();
    expect(journal.entries.filter((e) => e.op.op === 'cliExec' && e.op.line.startsWith('rest ')).length).toBe(4);
    const replay = createReplay(journal, { traceCapacity: 200_000, catalog: createStagedCatalog({ stage: 'P3' }) });
    const r = replay.advance(live.position());
    expect(r.reached).toBe(true);
    expect(replay.position()).toEqual(live.position());
    const head = journal.origin.counters.traceHead;
    expect(JSON.stringify(replay.sim.trace(head).events)).toBe(JSON.stringify(live.trace(head).events));
    expect(JSON.stringify(replay.sim.snapshot())).toBe(JSON.stringify(live.snapshot()));
    expect(logRows(replay.sim).map((row) => [row.method, row.status])).toEqual([['PUT', 201], ['DELETE', 204]]);
  });

  it('three runs with one seed give byte-identical trace and snapshot JSON', () => {
    const run = (): string => {
      const sim = script();
      return JSON.stringify({ trace: sim.trace(0).events, snapshot: sim.snapshot() });
    };
    const a = run();
    expect(run()).toBe(a);
    expect(run()).toBe(a);
  });
});
