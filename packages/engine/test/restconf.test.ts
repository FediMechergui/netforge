/**
 * restconf — the device API over simulated TLS (ARCHITECTURE-P3 D21, §3.0 (c), §3.8, §4.2, §4.3, §5.6; §7 W2 http).
 *
 * On `staged.world` at stage P3 (rule 13): SW1 (NF-C2960, the managed switch of §3.8) has Vlan1 10.0.99.11/24 and the
 * §3.8 service lines (`username admin privilege 15 secret …`, `ip http secure-server`, `ip http authentication local`,
 * `restconf`), written through `startupConfig` (the config rules; the grammar is W2 cli's). The `restconf` daemon is
 * not registered before the W4 flip, so it is passed through `factories`. DEV1 (the test-only NF-DEVHOST) sends the
 * requests with the W2 `http.request` of its http-client on behalf of a stub `script-host` that records `http.result`.
 * The configure seam (W1 device action, W1 sim handler) applies the writes for real.
 *
 * Pinned: the status matrix of D21 (GET/HEAD 200; POST 201 or 409; PUT 201 or 204 — twice: 201 then 204; PATCH and
 * DELETE 204; 400, 401, 404, 405, 415 with an `ietf-restconf:errors` body); 401 in its three forms; an atomic write the
 * CLI refuses applies nothing and answers 400 with the CLI's own error text; the `restconf-log` bound (50 rows, the
 * oldest deleted with reason 'replaced'); `configChange` carrying the origin {via, user, address}; TLS-protected data
 * segments; silence without both service lines; and the listener closing when a line is removed.
 */
import { describe, expect, it } from 'vitest';
import type { Process, ProcessFactory } from '../src/contracts/process.js';
import type { HttpMethod } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import type { HttpResultEvent } from '../src/contracts/transport.js';
import type { RestconfLogRow } from '../src/contracts/tables.js';
import { parseJson, type DataValue } from '../src/automation/data/json.js';
import {
  basicCredentials,
  createRestconf,
  decodeBase64,
  restconfConfig,
  restconfUsers,
  MSG_RESTCONF_LOGIN_FAILED,
  MSG_RESTCONF_LOGIN_NEEDED,
  MSG_RESTCONF_MEDIA_TYPE,
  MSG_RESTCONF_NO_AUTH_METHOD,
  RESTCONF_JSON_TYPE,
  RESTCONF_LOG_LIMIT,
} from '../src/protocols/restconf.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import { createStagedSimulation, NF_DEVHOST_TYPE } from './staged.world.js';

const SW = '10.0.99.11';
const DEV = '10.0.99.10';
const PASSWORD = 'Lab-Pass1';
const BASE = `https://${SW}/restconf`;

function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

const SERVICE = [['ip http secure-server'], ['ip http authentication local'], ['restconf']];

/** A stub `script-host` that records every `http.result` it receives. */
function recorder(results: HttpResultEvent[]): ProcessFactory {
  return (): Process => ({
    name: 'script-host',
    onPdu: () => [],
    onTimer: () => [],
    onConfig: () => [],
    onEvent: (_ctx, ev) => {
      if (ev.kind === 'http.result') results.push(ev);
      return [];
    },
    stateSnapshot: () => ({ process: 'script-host', state: {} }),
    debugEvents: () => [],
  });
}

interface World {
  readonly sim: Simulation;
  readonly results: HttpResultEvent[];
  readonly send: (method: HttpMethod, path: string, opts?: SendOpts) => Reply;
}

interface SendOpts {
  readonly body?: string;
  readonly auth?: string | null;
  readonly type?: string | null;
  readonly url?: string;
}

interface Reply {
  readonly status?: number;
  readonly reason?: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly text: string;
  readonly json?: DataValue;
  readonly error?: string;
}

const basic = (user: string, password: string): string => `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;

/**
 * SW1 (NF-C2960, Vlan1 10.0.99.11) and DEV1 (NF-DEVHOST, 10.0.99.10) on Fa0/1. `swLines` replace the §3.8 service
 * lines when given. Boot 60 s.
 */
function world(opts: { swLines?: readonly (readonly string[])[]; seed?: number } = {}): World {
  const results: HttpResultEvent[] = [];
  const sim = createStagedSimulation({ seed: opts.seed ?? 38, stage: 'P3', factories: { restconf: createRestconf, 'script-host': recorder(results) } });
  sim.addDevice({
    id: 'sw1', type: 'switch.nfc2960', name: 'SW1',
    startupConfig: startup([
      ['hostname SW1'],
      [`username admin privilege 15 secret ${PASSWORD}`],
      ['username guest privilege 1 secret Guest-Pass1'],
      ...(opts.swLines ?? SERVICE),
      ['interface Vlan1', ` ip address ${SW} 255.255.255.0`, ' no shutdown'],
    ]),
  });
  sim.addDevice({
    id: 'dev1', type: NF_DEVHOST_TYPE, name: 'DEV1',
    startupConfig: startup([['hostname DEV1'], ['interface GigabitEthernet0', ` ip address ${DEV} 255.255.255.0`]]),
  });
  sim.addLink({ a: { device: 'dev1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
  sim.runFor(60 * SEC);
  let n = 0;
  const send = (method: HttpMethod, path: string, o: SendOpts = {}): Reply => {
    const token = `q${++n}`;
    const headers: [string, string][] = [];
    if (o.auth !== null) headers.push(['Authorization', o.auth ?? basic('admin', PASSWORD)]);
    headers.push(['Accept', RESTCONF_JSON_TYPE]);
    if (o.body !== undefined && o.type !== null) headers.push(['Content-Type', o.type ?? RESTCONF_JSON_TYPE]);
    const dev = sim.device('dev1')!;
    dev.applyActions('script-host', [{
      type: 'request', to: 'http-client',
      req: {
        kind: 'http.request', owner: 'script-host', token, method, url: o.url ?? `${BASE}${path}`, headers,
        ...(o.body !== undefined ? { body: new TextEncoder().encode(o.body) } : {}),
      },
    }], sim.now);
    sim.runFor(3 * SEC);
    const r = results.find((x) => x.token === token);
    expect(r, `no http.result for ${method} ${path}`).toBeDefined();
    const text = new TextDecoder().decode(r!.body ?? new Uint8Array(0));
    const parsed = text === '' ? undefined : parseJson(text);
    return {
      ...(r!.status !== undefined ? { status: r!.status } : {}),
      ...(r!.reason !== undefined ? { reason: r!.reason } : {}),
      headers: r!.headers ?? [],
      text,
      ...(parsed !== undefined && parsed.ok ? { json: parsed.value } : {}),
      ...(r!.error !== undefined ? { error: r!.error } : {}),
    };
  };
  return { sim, results, send };
}

const header = (r: Reply, name: string): string | undefined => r.headers.find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1];
const errorOf = (r: Reply): { tag: string; message: string; type: string } => {
  const e = (r.json as { 'ietf-restconf:errors': { error: { 'error-tag': string; 'error-message': string; 'error-type': string }[] } })['ietf-restconf:errors'].error[0]!;
  return { tag: e['error-tag'], message: e['error-message'], type: e['error-type'] };
};
const logRows = (sim: Simulation): RestconfLogRow[] => sim.device('sw1')!.tables.get<RestconfLogRow>('restconf-log')!.rows();
const vlanNames = (sim: Simulation): Record<string, string | null> => {
  const out: Record<string, string | null> = {};
  for (const n of sim.device('sw1')!.running.root.children) if (n.key === 'vlan') out[n.args[0]!] = n.children.find((c) => c.key === 'name')?.args[0] ?? null;
  return out;
};

describe('restconf: configuration readers', () => {
  it('listens only with both `restconf` and `ip http secure-server`; reads `ip http authentication local`', () => {
    const ast = (lines: string[]) => {
      const a = createConfigAst();
      for (const l of lines) a.set([], l.split(' '));
      return a.root;
    };
    expect(restconfConfig(ast(['restconf']))).toEqual({ restconf: true, secureServer: false, authLocal: false, enabled: false });
    expect(restconfConfig(ast(['ip http secure-server']))).toMatchObject({ enabled: false });
    expect(restconfConfig(ast(['restconf', 'ip http secure-server', 'ip http authentication local']))).toEqual({ restconf: true, secureServer: true, authLocal: true, enabled: true });
    expect(restconfUsers(ast(['username admin privilege 15 secret abc', 'username bob secret xyz']))).toEqual([
      { name: 'admin', privilege: 15, stored: 'abc' },
      { name: 'bob', privilege: 1, stored: 'xyz' },
    ]);
  });

  it('decodes Basic credentials (RFC 7617) and refuses what is not', () => {
    expect(basicCredentials(basic('admin', 'p:a:ss'))).toEqual({ user: 'admin', password: 'p:a:ss' });
    expect(basicCredentials('Bearer abc')).toBeUndefined();
    expect(basicCredentials('Basic !!!')).toBeUndefined();
    expect(basicCredentials(`Basic ${Buffer.from('nocolon').toString('base64')}`)).toBeUndefined();
    expect(Array.from(decodeBase64('TWFu')!)).toEqual([77, 97, 110]);
    expect(Array.from(decodeBase64('TWE=')!)).toEqual([77, 97]);
  });
});

describe('restconf on staged.world (§3.8)', () => {
  it('GET answers 200 with RFC 7951 JSON over TLS-protected segments; HEAD has the headers and no body', () => {
    const w = world();
    const cursor = w.sim.trace(0).next;
    const r = w.send('GET', '/data/ietf-interfaces:interfaces');
    expect(r.status).toBe(200);
    expect(header(r, 'Content-Type')).toBe(RESTCONF_JSON_TYPE);
    const list = (r.json as { 'ietf-interfaces:interfaces': { interface: { name: string; type: string; enabled: boolean }[] } })['ietf-interfaces:interfaces'].interface;
    expect(list.map((i) => i.name)).toContain('Vlan1');
    expect(list.find((i) => i.name === 'Vlan1')).toMatchObject({ type: 'iana-if-type:l3ipvlan', enabled: true, 'ietf-ip:ipv4': { address: [{ ip: SW, 'prefix-length': 24 }] } });
    expect(list.find((i) => i.name === 'FastEthernet0/1')).toMatchObject({ type: 'iana-if-type:ethernetCsmacd' });
    // every TCP segment with data between the two carries the simulated TLS mark; no handshake bytes exist
    const segs = w.sim.trace(cursor).events.filter((e): e is Extract<TraceEvent, { kind: 'pduCreated' }> => e.kind === 'pduCreated' && e.process === 'tcp');
    const withData = segs.filter((e) => e.pdu.proto === 'http');
    expect(withData.slice(0, 2).map((s) => [s.device, s.pdu.summary])).toEqual([
      ['dev1', 'HTTP GET /restconf/data/ietf-interfaces:interfaces HTTP/1.1'],
      ['sw1', 'HTTP HTTP/1.1 200 OK'],
    ]);
    // the long answer continues in further segments of the switch
    for (const s of withData.slice(2)) expect([s.device, s.pdu.summary.startsWith('HTTP continuation ')]).toEqual(['sw1', true]);
    for (const s of withData) expect(w.sim.pdu(s.pdu.id)?.meta).toMatchObject({ protected: true, protectedBy: 'tls' });
    for (const s of segs.filter((e) => e.pdu.proto === 'tcp')) expect(w.sim.pdu(s.pdu.id)?.meta.protected).toBeUndefined();

    const h = w.send('HEAD', '/data/ietf-interfaces:interfaces');
    expect(h.status).toBe(200);
    expect(h.text).toBe('');
    expect(Number(header(h, 'Content-Length'))).toBe(new TextEncoder().encode(r.text).length);

    const root = w.send('GET', '');
    expect(root.status).toBe(200);
    expect(root.json).toEqual({ 'ietf-restconf:restconf': { data: {}, operations: {}, 'yang-library-version': '2016-06-21' } });
    const meta = w.send('GET', '', { url: `https://${SW}/.well-known/host-meta`, auth: null });
    expect(meta.status).toBe(200);
    expect(meta.text).toContain("<Link rel='restconf' href='/restconf'/>");
  });

  it('PUT twice: 201 Created, then 204 No Content; the VLAN exists with its name', () => {
    const w = world();
    const body = '{"nf-native:vlan-list":[{"id":30,"name":"VOICE"}]}';
    const first = w.send('PUT', '/data/nf-native:native/vlan/vlan-list=30', { body });
    expect([first.status, first.reason]).toEqual([201, 'Created']);
    expect(vlanNames(w.sim)['30']).toBe('VOICE');
    const second = w.send('PUT', '/data/nf-native:native/vlan/vlan-list=30', { body });
    expect([second.status, second.reason, second.text]).toEqual([204, 'No Content', '']);
    const renamed = w.send('PUT', '/data/nf-native:native/vlan/vlan-list=30', { body: '{"nf-native:vlan-list":[{"id":30,"name":"PHONES"}]}' });
    expect(renamed.status).toBe(204);
    expect(vlanNames(w.sim)['30']).toBe('PHONES');
    expect(logRows(w.sim).map((r) => [r.method, r.path, r.status, r.client, r.user])).toEqual([
      ['PUT', '/restconf/data/nf-native:native/vlan/vlan-list=30', 201, DEV, 'admin'],
      ['PUT', '/restconf/data/nf-native:native/vlan/vlan-list=30', 204, DEV, 'admin'],
      ['PUT', '/restconf/data/nf-native:native/vlan/vlan-list=30', 204, DEV, 'admin'],
    ]);
  });

  it('the status matrix: POST 201/409, PATCH 204/404, DELETE 204/404, 400, 404, 405, 415', () => {
    const w = world();
    const post = w.send('POST', '/data/nf-native:native/vlan', { body: '{"nf-native:vlan-list":[{"id":40,"name":"FINANCE"}]}' });
    expect(post.status).toBe(201);
    expect(vlanNames(w.sim)['40']).toBe('FINANCE');
    const again = w.send('POST', '/data/nf-native:native/vlan', { body: '{"nf-native:vlan-list":[{"id":40,"name":"FINANCE"}]}' });
    expect(again.status).toBe(409);
    expect(errorOf(again).tag).toBe('data-exists');

    const patch = w.send('PATCH', '/data/nf-native:native/vlan/vlan-list=40', { body: '{"nf-native:vlan-list":[{"id":40,"name":"LEDGER"}]}' });
    expect(patch.status).toBe(204);
    expect(vlanNames(w.sim)['40']).toBe('LEDGER');
    const patchMissing = w.send('PATCH', '/data/nf-native:native/vlan/vlan-list=41', { body: '{"nf-native:vlan-list":[{"id":41,"name":"X"}]}' });
    expect(patchMissing.status).toBe(404);

    const del = w.send('DELETE', '/data/nf-native:native/vlan/vlan-list=40');
    expect(del.status).toBe(204);
    expect(vlanNames(w.sim)['40']).toBeUndefined();
    expect(w.send('DELETE', '/data/nf-native:native/vlan/vlan-list=40').status).toBe(404);

    // 400: the body's key differs from the URL's (RFC 8040 §4.5), and JSON that does not parse
    const keyMismatch = w.send('PUT', '/data/nf-native:native/vlan/vlan-list=30', { body: '{"nf-native:vlan-list":[{"id":31}]}' });
    expect(keyMismatch.status).toBe(400);
    expect(errorOf(keyMismatch)).toMatchObject({ tag: 'invalid-value' });
    const broken = w.send('PUT', '/data/nf-native:native/vlan/vlan-list=30', { body: '{"nf-native:vlan-list": [ {id: 30} ]}' });
    expect(broken.status).toBe(400);
    expect(errorOf(broken).tag).toBe('malformed-message');
    expect(errorOf(broken).message).toMatch(/^The body is not valid JSON \(line 1, column \d+\): /);

    // 404: a node the model does not have, and a target outside /restconf
    expect(w.send('GET', '/data/nf-native:native/nothing').status).toBe(404);
    expect(w.send('GET', '', { url: `https://${SW}/api/v1/vlans` }).status).toBe(404);
    // a list entry that does not exist holds no data
    expect(w.send('GET', '/data/nf-native:native/vlan/vlan-list=99').status).toBe(404);

    // 405: writing state data, writing the API root, a method the API does not answer
    const state = w.send('PUT', '/data/ietf-interfaces:interfaces-state/interface=Vlan1', { body: '{"ietf-interfaces:interface":[{"name":"Vlan1"}]}' });
    expect(state.status).toBe(405);
    expect(errorOf(state).tag).toBe('operation-not-supported');
    const rootWrite = w.send('DELETE', '');
    expect(rootWrite.status).toBe(405);
    expect(header(rootWrite, 'Allow')).toBe('GET, HEAD');

    // 415: a body that says it is not JSON
    const plain = w.send('PUT', '/data/nf-native:native/hostname', { body: '{"nf-native:hostname":"CORE1"}', type: 'text/plain' });
    expect(plain.status).toBe(415);
    expect(errorOf(plain).message).toBe(MSG_RESTCONF_MEDIA_TYPE);
    expect(w.sim.device('sw1')!.hostname).toBe('SW1');
    // application/json is read as well
    expect(w.send('PUT', '/data/nf-native:native/hostname', { body: '{"nf-native:hostname":"CORE1"}', type: 'application/json' }).status).toBe(204);
    expect(w.sim.device('sw1')!.hostname).toBe('CORE1');

    expect(logRows(w.sim).map((r) => r.status)).toEqual([201, 409, 204, 404, 204, 404, 400, 400, 404, 404, 404, 405, 405, 415, 204]);
  });

  it('401: no credentials, a wrong password, a user without privilege 15, and no login method', () => {
    const w = world();
    const none = w.send('GET', '/data/nf-native:native', { auth: null });
    expect(none.status).toBe(401);
    expect(header(none, 'WWW-Authenticate')).toBe('Basic realm="restconf"');
    expect(errorOf(none)).toEqual({ type: 'protocol', tag: 'access-denied', message: MSG_RESTCONF_LOGIN_NEEDED });
    expect(errorOf(w.send('GET', '/data/nf-native:native', { auth: basic('admin', 'wrong') })).message).toBe(MSG_RESTCONF_LOGIN_FAILED);
    expect(w.send('GET', '/data/nf-native:native', { auth: basic('guest', 'Guest-Pass1') }).status).toBe(401);
    expect(w.send('GET', '/data/nf-native:native', { auth: basic('nobody', 'x') }).status).toBe(401);
    expect(w.send('GET', '/data/nf-native:native').status).toBe(200);
    // a refused login changes nothing and leaves no user in the log
    expect(w.send('PUT', '/data/nf-native:native/hostname', { auth: basic('admin', 'wrong'), body: '{"nf-native:hostname":"X"}' }).status).toBe(401);
    expect(w.sim.device('sw1')!.hostname).toBe('SW1');
    expect(logRows(w.sim).map((r) => [r.status, r.user ?? null])).toEqual([[401, null], [401, null], [401, null], [401, null], [200, 'admin'], [401, null]]);

    const noMethod = world({ swLines: [['ip http secure-server'], ['restconf']] });
    const r = noMethod.send('GET', '/data/nf-native:native');
    expect(r.status).toBe(401);
    expect(errorOf(r).message).toBe(MSG_RESTCONF_NO_AUTH_METHOD);
  });

  it('an atomic write the CLI refuses applies nothing and answers 400 with the CLI\'s own error text', () => {
    const w = world();
    const cursor = w.sim.trace(0).next;
    // vlan 30 is valid, vlan 4095 is not: the run reverts vlan 30 too
    const r = w.send('PATCH', '/data/nf-native:native/vlan', { body: '{"nf-native:vlan":{"vlan-list":[{"id":30,"name":"VOICE"},{"id":4095}]}}' });
    expect(r.status).toBe(400);
    const e = errorOf(r);
    expect(e.tag).toBe('invalid-value');
    // the message is exactly the error the console prints for that line
    const typed = w.sim.configure('sw1', ['vlan 4095']);
    expect(typed.ok).toBe(false);
    expect(e.message).toBe(typed.lines[0]!.error!.message);
    expect(vlanNames(w.sim)['30']).toBeUndefined();
    // the revert is visible: vlan 30 was set, then unset, both by the API
    const changes = w.sim.trace(cursor).events.filter((x): x is Extract<TraceEvent, { kind: 'configChange' }> => x.kind === 'configChange' && x.device === 'sw1' && x.origin !== undefined);
    expect(changes.some((c) => c.line === 'vlan 30' && !c.negate)).toBe(true);
    expect(changes.some((c) => c.line === 'vlan 30' && c.negate)).toBe(true);
    expect(logRows(w.sim).at(-1)).toMatchObject({ method: 'PATCH', status: 400, user: 'admin' });
  });

  it('configChange events of an API write carry the origin {via restconf, user, address}', () => {
    const w = world();
    const cursor = w.sim.trace(0).next;
    expect(w.send('PUT', '/data/nf-native:native/vlan/vlan-list=30', { body: '{"nf-native:vlan-list":[{"id":30,"name":"VOICE"}]}' }).status).toBe(201);
    const changes = w.sim.trace(cursor).events.filter((x): x is Extract<TraceEvent, { kind: 'configChange' }> => x.kind === 'configChange' && x.device === 'sw1');
    expect(changes.length).toBeGreaterThanOrEqual(2);
    for (const c of changes) expect(c.origin).toEqual({ via: 'restconf', user: 'admin', address: DEV });
    expect(changes.map((c) => c.line)).toEqual(expect.arrayContaining(['vlan 30', 'name VOICE']));
    // a line typed at the console carries none
    const typed = w.sim.trace(w.sim.trace(0).next);
    w.sim.configure('sw1', ['vlan 31']);
    const after = w.sim.trace(typed.next).events.filter((x): x is Extract<TraceEvent, { kind: 'configChange' }> => x.kind === 'configChange');
    expect(after.length).toBeGreaterThan(0);
    for (const c of after) expect(c.origin).toBeUndefined();
  });

  it('POST /restconf/operations/nf-native:save-config saves the running configuration (204)', () => {
    const w = world();
    expect(w.send('PUT', '/data/nf-native:native/vlan/vlan-list=30', { body: '{"nf-native:vlan-list":[{"id":30,"name":"VOICE"}]}' }).status).toBe(201);
    const ops = w.send('GET', '/operations');
    expect(ops.json).toEqual({ 'ietf-restconf:operations': { 'nf-native:save-config': '/restconf/operations/nf-native:save-config' } });
    expect(w.send('GET', '/operations/nf-native:save-config').status).toBe(405);
    const save = w.send('POST', '/operations/nf-native:save-config');
    expect(save.status).toBe(204);
    expect(w.sim.device('sw1')!.startup?.root.children.some((n) => n.key === 'vlan' && n.args[0] === '30')).toBe(true);
  });

  it('requests are handled one at a time: two PUTs of one entry sent together answer 201 then 204', () => {
    const w = world();
    const dev = w.sim.device('dev1')!;
    const body = new TextEncoder().encode('{"nf-native:vlan-list":[{"id":30,"name":"VOICE"}]}');
    const headers: [string, string][] = [['Authorization', basic('admin', PASSWORD)], ['Content-Type', RESTCONF_JSON_TYPE]];
    dev.applyActions('script-host', ['a', 'b'].map((token) => ({
      type: 'request' as const, to: 'http-client',
      req: { kind: 'http.request' as const, owner: 'script-host', token, method: 'PUT' as const, url: `${BASE}/data/nf-native:native/vlan/vlan-list=30`, headers, body },
    })), w.sim.now);
    w.sim.runFor(3 * SEC);
    expect(['a', 'b'].map((t) => w.results.find((r) => r.token === t)?.status)).toEqual([201, 204]);
    expect(logRows(w.sim).map((r) => r.status)).toEqual([201, 204]);
  });

  it('on a router: an interface entry with a %2F key, its description and address written through the CLI', () => {
    const results: HttpResultEvent[] = [];
    const sim = createStagedSimulation({ seed: 3, stage: 'P3', factories: { restconf: createRestconf, 'script-host': recorder(results) } });
    sim.addDevice({
      id: 'r1', type: 'router.nf2911', name: 'R1',
      startupConfig: startup([['hostname R1'], [`username admin privilege 15 secret ${PASSWORD}`], ...SERVICE, ['interface GigabitEthernet0/0', ' ip address 10.0.99.1 255.255.255.0', ' no shutdown']]),
    });
    sim.addDevice({ id: 'dev1', type: NF_DEVHOST_TYPE, name: 'DEV1', startupConfig: startup([['hostname DEV1'], ['interface GigabitEthernet0', ` ip address ${DEV} 255.255.255.0`]]) });
    sim.addLink({ a: { device: 'dev1', port: 'GigabitEthernet0' }, b: { device: 'r1', port: 'GigabitEthernet0/0' } });
    sim.runFor(60 * SEC);
    const put =(path: string, body: string, token: string): HttpResultEvent | undefined => {
      sim.device('dev1')!.applyActions('script-host', [{
        type: 'request', to: 'http-client',
        req: {
          kind: 'http.request', owner: 'script-host', token, method: 'PUT', url: `https://10.0.99.1/restconf/data/${path}`,
          headers: [['Authorization', basic('admin', PASSWORD)], ['Content-Type', RESTCONF_JSON_TYPE]], body: new TextEncoder().encode(body),
        },
      }], sim.now);
      sim.runFor(3 * SEC);
      return results.find((r) => r.token === token);
    };
    const r = put(
      'ietf-interfaces:interfaces/interface=GigabitEthernet0%2F1',
      '{"ietf-interfaces:interface":[{"name":"GigabitEthernet0/1","description":"to SW2","enabled":true,"ietf-ip:ipv4":{"address":[{"ip":"10.0.12.1","prefix-length":30}]}}]}',
      'if',
    );
    expect(r?.status).toBe(204);
    const section = sim.device('r1')!.running.root.children.find((n) => n.key === 'interface' && n.args[0] === 'GigabitEthernet0/1')!;
    expect(section.children.find((c) => c.key === 'description')?.args).toEqual(['to SW2']);
    expect(sim.device('r1')!.port('GigabitEthernet0/1')!.adminUp).toBe(true);
    expect(sim.device('r1')!.port('GigabitEthernet0/1')!.l3.ipv4).toMatchObject({ address: '10.0.12.1', prefixLen: 30 });
    // a router has no VLAN list: the CLI refuses the line and the API answers 400 with the CLI's text
    const vlan = put('nf-native:native/vlan/vlan-list=30', '{"nf-native:vlan-list":[{"id":30}]}', 'vlan');
    expect(vlan?.status).toBe(400);
    const typed = sim.configure('r1', ['vlan 30']);
    const message = (JSON.parse(new TextDecoder().decode(vlan!.body)) as { 'ietf-restconf:errors': { error: { 'error-message': string }[] } })['ietf-restconf:errors'].error[0]!['error-message'];
    expect(message).toBe(typed.lines[0]!.error!.message);
  });

  it(`the restconf-log table keeps the last ${RESTCONF_LOG_LIMIT} requests: the oldest is deleted with reason 'replaced'`, () => {
    const w = world();
    const cursor = w.sim.trace(0).next;
    for (let i = 0; i < RESTCONF_LOG_LIMIT + 3; i++) w.send('GET', `/data/nf-native:native/hostname`);
    const rows = logRows(w.sim);
    expect(rows.length).toBe(RESTCONF_LOG_LIMIT);
    expect(rows[0]!.seq).toBe(4);
    expect(rows.at(-1)!.seq).toBe(RESTCONF_LOG_LIMIT + 3);
    expect(rows.map((r) => r.key)).toEqual(rows.map((r) => String(r.seq)));
    const expired = w.sim.trace(cursor).events.filter((e): e is Extract<TraceEvent, { kind: 'tableExpire' }> => e.kind === 'tableExpire' && e.table === 'restconf-log');
    expect(expired.map((e) => [e.key, e.reason])).toEqual([['1', 'replaced'], ['2', 'replaced'], ['3', 'replaced']]);
  });

  it('silence: without both service lines nothing listens and nothing is written; removing a line closes the API', () => {
    const quiet = world({ swLines: [['ip http secure-server'], ['ip http authentication local']] });
    const r = quiet.send('GET', '/data/nf-native:native');
    // the switch's transport is dormant (D22): no listener, so the connection is refused or unreachable
    expect(r.status).toBeUndefined();
    expect(r.error).toBeDefined();
    expect(quiet.sim.device('sw1')!.tables.get('restconf-log')!.size).toBe(0);
    const sw = quiet.sim.device('sw1')!;
    expect(sw.processes.get('restconf')!.stateSnapshot().state).toMatchObject({ enabled: false, open: [], requests: 0 });
    expect(sw.tables.get('sockets')?.rows().some((row) => String((row as unknown as { key: string }).key).includes('restconf')) ?? false).toBe(false);

    const w = world();
    expect(w.send('GET', '/data/nf-native:native').status).toBe(200);
    expect(w.sim.device('sw1')!.applyConfigLine([], ['restconf'], true)).toEqual({ ok: true });
    // the last wake line is gone, so the switch's transport is dormant again (D22): protocol unreachable, as in P2
    const after = w.send('GET', '/data/nf-native:native');
    expect(after.status).toBeUndefined();
    expect(after.error).toBe('proto-unreachable');
    expect(w.sim.device('sw1')!.processes.get('restconf')!.stateSnapshot().state).toMatchObject({ enabled: false, open: [] });
    // with the lines back the API answers again
    expect(w.sim.device('sw1')!.applyConfigLine([], ['restconf'], false)).toEqual({ ok: true });
    expect(w.send('GET', '/data/nf-native:native').status).toBe(200);
  });
});
