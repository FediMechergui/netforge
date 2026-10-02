/**
 * http.request — the API client of http-client (ARCHITECTURE-P3 D21, §2.4, §3.0 (d), §3.8 steps 1, 2 and 6, §4.2;
 * §7 W2 http).
 *
 * On `staged.world` at stage P3 (rule 13): PC1 (NF-PC, the host shell's `rest` job is the CLI owner), DEV1 (the
 * test-only NF-DEVHOST, whose stub `script-host` is a process owner) and R1 (NF-2911: `ip http server` on port 80, and
 * the RESTCONF service lines with the `restconf` daemon passed through `factories`) on one switch. The requests are
 * issued exactly as their owners will issue them: `applyActions('cli' | 'script-host', [request http-client …])`.
 *
 * Pinned: the CLI owner gets the status line, the headers, a blank line and the pretty-printed JSON body, then cliDone;
 * a process owner gets `http.result` {status, reason, headers, body}; `https:` connects with `tls` (protected data
 * segments) to 443 and `http:` without it to 80; the request head (Host, the caller's headers, Content-Length,
 * Connection: close; the caller's own Host and Content-Length left out); HEAD ends with its header block; the errors
 * (`bad-url` without a packet, `refused`, an unresolvable name, `timeout`); `job.abort` cancels; the StateView keeps its
 * P1/P2 shape until a request is made; the browser's https refusal is unchanged.
 */
import { describe, expect, it } from 'vitest';
import type { HttpMethod, Process, ProcessFactory } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import type { HttpResultEvent } from '../src/contracts/transport.js';
import { createRestconf } from '../src/protocols/restconf.js';
import { formatHttpResponseText, httpHeaderPairs, MSG_API_BAD_HEADER, MSG_API_BAD_URL, MSG_API_CANCELLED, MSG_HTTPS } from '../src/protocols/http-client.js';
import { createStagedSimulation, NF_DEVHOST_TYPE } from './staged.world.js';

const R1 = '10.0.99.1';
const PASSWORD = 'Lab-Pass1';
const AUTH: [string, string] = ['Authorization', `Basic ${Buffer.from(`admin:${PASSWORD}`).toString('base64')}`];

function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

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

interface Req {
  readonly method?: HttpMethod;
  readonly url: string;
  readonly headers?: readonly (readonly [string, string])[];
  readonly body?: string;
  readonly timeoutNs?: number;
}

function world() {
  const results: HttpResultEvent[] = [];
  const sim = createStagedSimulation({ seed: 32, stage: 'P3', factories: { restconf: createRestconf, 'script-host': recorder(results) } });
  sim.addDevice({
    id: 'r1', type: 'router.nf2911', name: 'R1',
    startupConfig: startup([
      ['hostname R1'], [`username admin privilege 15 secret ${PASSWORD}`], ['ip http server'], ['ip http secure-server'],
      ['ip http authentication local'], ['restconf'], ['interface GigabitEthernet0/0', ` ip address ${R1} 255.255.255.0`, ' no shutdown'],
    ]),
  });
  // PortFast on the three host ports (§11.2), so nothing waits for spanning tree after R1's 45 s boot
  const portfast = (port: string): string[] => [`interface ${port}`, ' spanning-tree portfast'];
  sim.addDevice({
    id: 'sw1', type: 'switch.nfc2960', name: 'SW1',
    startupConfig: startup([['hostname SW1'], portfast('FastEthernet0/1'), portfast('FastEthernet0/2'), portfast('GigabitEthernet0/1')]),
  });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: startup([['hostname PC1'], ['interface GigabitEthernet0', ' ip address 10.0.99.10 255.255.255.0']]) });
  sim.addDevice({ id: 'dev1', type: NF_DEVHOST_TYPE, name: 'DEV1', startupConfig: startup([['hostname DEV1'], ['interface GigabitEthernet0', ' ip address 10.0.99.12 255.255.255.0']]) });
  sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
  sim.addLink({ a: { device: 'dev1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/2' } });
  sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
  sim.runFor(60 * SEC);
  let n = 0;
  /** A process-owned request from DEV1's stub script host; runs `runNs` and returns the result (if any). */
  const fromDev = (r: Req, runNs = 3 * SEC): HttpResultEvent | undefined => {
    const token = `d${++n}`;
    sim.device('dev1')!.applyActions('script-host', [{
      type: 'request', to: 'http-client',
      req: {
        kind: 'http.request', owner: 'script-host', token, method: r.method ?? 'GET', url: r.url,
        ...(r.headers !== undefined ? { headers: r.headers } : {}),
        ...(r.body !== undefined ? { body: new TextEncoder().encode(r.body) } : {}),
        ...(r.timeoutNs !== undefined ? { timeoutNs: r.timeoutNs } : {}),
      },
    }], sim.now);
    sim.runFor(runNs);
    return results.find((x) => x.token === token);
  };
  /** A CLI-owned request on PC1's console session (the `rest` job's call); returns the session's output. */
  const fromCli = (r: Req, runNs = 3 * SEC, between?: (session: string) => void): { text: string; done: boolean } => {
    const session = sim.cli.open('pc1', 'console');
    const cursor = sim.trace(0).next;
    sim.device('pc1')!.applyActions('cli', [{
      type: 'request', to: 'http-client',
      req: { kind: 'http.request', owner: 'cli', session, token: `${session}:rest`, method: r.method ?? 'GET', url: r.url, ...(r.headers !== undefined ? { headers: r.headers } : {}) },
    }], sim.now);
    between?.(session);
    sim.runFor(runNs);
    const evs = sim.trace(cursor).events;
    const text = evs.filter((e): e is Extract<TraceEvent, { kind: 'cliOutput' }> => e.kind === 'cliOutput' && e.session === session).map((e) => e.text).join('');
    const done = evs.some((e) => e.kind === 'cliPrompt' && e.session === session && !e.busy);
    return { text, done };
  };
  return { sim, results, fromDev, fromCli };
}

const httpState = (sim: Simulation, dev: string): Record<string, unknown> =>
  sim.device(dev)!.processes.get('http-client')!.stateSnapshot().state as Record<string, unknown>;

describe('http.request: pure helpers', () => {
  it('formats a response for the session: status line, headers, blank line, JSON pretty-printed', () => {
    expect(formatHttpResponseText({ startLine: 'HTTP/1.1 200 OK', headers: 'Content-Type: application/yang-data+json\nContent-Length: 13', body: '{"a":[1,"x"]}' }))
      .toBe('HTTP/1.1 200 OK\nContent-Type: application/yang-data+json\nContent-Length: 13\n\n{\n  "a": [\n    1,\n    "x"\n  ]\n}\n');
    expect(formatHttpResponseText({ startLine: 'HTTP/1.1 204 No Content', headers: 'Connection: close', body: '' })).toBe('HTTP/1.1 204 No Content\nConnection: close\n\n');
    // not JSON, or JSON that does not parse: printed as it came
    expect(formatHttpResponseText({ startLine: 'HTTP/1.1 200 OK', headers: 'Content-Type: text/html', body: '<p>{"a":1}</p>\n' })).toBe('HTTP/1.1 200 OK\nContent-Type: text/html\n\n<p>{"a":1}</p>\n');
    expect(formatHttpResponseText({ startLine: 'HTTP/1.1 200 OK', headers: 'Content-Type: application/json', body: '{broken' })).toBe('HTTP/1.1 200 OK\nContent-Type: application/json\n\n{broken\n');
    expect(httpHeaderPairs('A: 1\nB:  two words \nbad line')).toEqual([['A', '1'], ['B', 'two words']]);
    // members keep the order they arrived in (integer-like names too) and numbers are printed as written
    expect(formatHttpResponseText({ startLine: 'HTTP/1.1 200 OK', headers: 'Content-Type: application/json', body: '{"b":1.50,"20":{},"10":[true,null,"\\u00e9"]}' }))
      .toBe('HTTP/1.1 200 OK\nContent-Type: application/json\n\n{\n  "b": 1.50,\n  "20": {},\n  "10": [\n    true,\n    null,\n    "é"\n  ]\n}\n');
  });
});

describe('http.request on staged.world', () => {
  it('the CLI owner: an https GET prints the status line, headers and pretty JSON, then cliDone', () => {
    const w = world();
    const out = w.fromCli({ url: `https://${R1}/restconf/data/nf-native:native/hostname`, headers: [AUTH, ['Accept', 'application/yang-data+json']] });
    expect(out.done).toBe(true);
    const lines = out.text.split('\n');
    expect(lines[0]).toBe('HTTP/1.1 200 OK');
    expect(lines).toContain('Content-Type: application/yang-data+json');
    expect(lines).toContain('Connection: close');
    const blank = lines.indexOf('');
    expect(lines.slice(blank + 1)).toEqual(['{', '  "nf-native:hostname": "R1"', '}', '']);
  });

  it('a process owner gets http.result {status, reason, headers, body}; http: goes to port 80 without TLS', () => {
    const w = world();
    const cursor = w.sim.trace(0).next;
    const r = w.fromDev({ url: `http://${R1}/` })!;
    expect(r).toMatchObject({ kind: 'http.result', status: 200, reason: 'OK' });
    expect(r.error).toBeUndefined();
    expect(r.headers).toEqual(expect.arrayContaining([['Content-Type', 'text/html'], ['Connection', 'close']]));
    expect(new TextDecoder().decode(r.body)).toContain('R1');
    const created = w.sim.trace(cursor).events.filter((e): e is Extract<TraceEvent, { kind: 'pduCreated' }> => e.kind === 'pduCreated' && e.pdu.proto === 'http');
    expect(created[0]!.pdu.flow).toMatch(/^ipv4:10\.0\.99\.12:\d+>10\.0\.99\.1:80:tcp$/);
    for (const c of created) expect(w.sim.pdu(c.pdu.id)?.meta.protected).toBeUndefined();
    expect(httpState(w.sim, 'dev1')).toMatchObject({ apiRequests: 1, requests: { d1: { method: 'GET', url: `http://${R1}/`, phase: 'done', status: 200, address: R1 } } });
  });

  it('the request head: Host, the caller\'s headers in order, Content-Length, Connection: close; the body follows', () => {
    const w = world();
    const cursor = w.sim.trace(0).next;
    const body = '{"x": "é"}';
    const r = w.fromDev({ method: 'POST', url: `http://${R1}:80/submit?a=1#frag`, headers: [['X-One', '1'], ['Host', 'evil'], ['content-length', '999'], ['X-Two', 'two']], body })!;
    expect(r.status).toBe(404);
    const req = w.sim.trace(cursor).events.find((e): e is Extract<TraceEvent, { kind: 'pduCreated' }> => e.kind === 'pduCreated' && e.device === 'dev1' && e.pdu.proto === 'http')!;
    const view = w.sim.pdu(req.pdu.id)!;
    expect(view.get('http.method')).toBe('POST');
    expect(view.get('http.target')).toBe('/submit?a=1');
    expect(view.get('http.headers')).toBe(`Host: ${R1}:80\nX-One: 1\nX-Two: two\nContent-Length: ${new TextEncoder().encode(body).length}\nConnection: close`);
    expect(view.get('http.body')).toBe(body);
    // a GET without a body sends no Content-Length; a PUT without one sends 0
    const c2 = w.sim.trace(0).next;
    w.fromDev({ method: 'PUT', url: `http://${R1}/` });
    const put = w.sim.trace(c2).events.find((e): e is Extract<TraceEvent, { kind: 'pduCreated' }> => e.kind === 'pduCreated' && e.device === 'dev1' && e.pdu.proto === 'http')!;
    expect(w.sim.pdu(put.pdu.id)!.get('http.headers')).toBe(`Host: ${R1}\nContent-Length: 0\nConnection: close`);
  });

  it('https: tcp.connect with tls to 443; HEAD ends with the header block', () => {
    const w = world();
    const cursor = w.sim.trace(0).next;
    const r = w.fromDev({ method: 'HEAD', url: `https://${R1}/restconf/data/nf-native:native`, headers: [AUTH] })!;
    expect(r.status).toBe(200);
    expect(r.body).toEqual(new Uint8Array(0));
    expect(Number(r.headers!.find(([n]) => n === 'Content-Length')![1])).toBeGreaterThan(0);
    const data = w.sim.trace(cursor).events.filter((e): e is Extract<TraceEvent, { kind: 'pduCreated' }> => e.kind === 'pduCreated' && e.pdu.proto === 'http');
    expect(data.length).toBe(2);
    expect(data[0]!.pdu.flow).toMatch(/:443:tcp$/);
    for (const d of data) expect(w.sim.pdu(d.pdu.id)!.meta).toMatchObject({ protected: true, protectedBy: 'tls' });
  });

  it('errors: bad-url and bad headers at once and without a packet; refused; an unresolvable name; timeout', () => {
    const w = world();
    const c0 = w.sim.trace(0).next;
    expect(w.fromDev({ url: 'ftp://10.0.99.1/file' }, 0)).toEqual({ kind: 'http.result', token: 'd1', error: 'bad-url' });
    expect(w.fromDev({ url: 'not a url' }, 0)).toEqual({ kind: 'http.result', token: 'd2', error: 'bad-url' });
    expect(w.fromDev({ url: `https://${R1}/`, headers: [['Bad Name', 'x']] }, 0)).toEqual({ kind: 'http.result', token: 'd3', error: 'bad-url' });
    expect(w.fromDev({ url: `https://${R1}/`, headers: [['X-Ok', 'line\nbreak']] }, 0)?.error).toBe('bad-url');
    expect(w.sim.trace(c0).events.filter((e) => e.kind === 'pduCreated' && e.device === 'dev1')).toEqual([]);
    expect(httpState(w.sim, 'dev1')).toMatchObject({ requests: { d1: { error: MSG_API_BAD_URL }, d3: { error: MSG_API_BAD_HEADER } } });

    expect(w.fromDev({ url: `http://${R1}:8080/` })?.error).toBe('refused');
    // no DNS server on DEV1: the name never resolves
    expect(w.fromDev({ url: 'https://core-sw.lab/restconf' })?.error).toBe('host-unreachable');
    // nobody answers 10.0.99.99: the request's own deadline ends it
    const t = w.fromDev({ url: 'https://10.0.99.99/restconf', timeoutNs: 2 * SEC }, 5 * SEC);
    expect(t?.error).toBe('timeout');
  });

  it('the CLI owner: a failure prints one line and cliDone; job.abort cancels the call', () => {
    const w = world();
    const failed = w.fromCli({ url: `http://${R1}:8080/x` });
    expect(failed).toEqual({ text: `% The request to http://${R1}:8080/x failed: The server refused the connection.\n`, done: true });
    let abortedSession = '';
    const aborted = w.fromCli({ url: 'https://10.0.99.99/restconf' }, 15 * SEC, (session) => {
      abortedSession = session;
      w.sim.runFor(SEC);
      w.sim.device('pc1')!.applyActions('cli', [{ type: 'request', to: 'http-client', req: { kind: 'job.abort', session } }], w.sim.now);
    });
    // one line, and nothing more after the deadline would have passed
    expect(aborted.text).toBe(`% ${MSG_API_CANCELLED}\n`);
    expect(httpState(w.sim, 'pc1')['requests']).toMatchObject({ [`${abortedSession}:rest`]: { phase: 'error', error: MSG_API_CANCELLED } });
  });

  it('the StateView keeps its P1/P2 shape until a request is made; the browser\'s https refusal is unchanged', () => {
    const w = world();
    expect(Object.keys(httpState(w.sim, 'pc1'))).toEqual(['tabs', 'fetches', 'completed', 'failed']);
    w.sim.hostRequest('pc1', { app: 'http.get', url: `https://${R1}/` });
    w.sim.runFor(SEC);
    const s = httpState(w.sim, 'pc1');
    expect(Object.keys(s)).toEqual(['tabs', 'fetches', 'completed', 'failed']);
    expect(Object.values(s['tabs'] as Record<string, { error?: string }>)[0]!.error).toBe(MSG_HTTPS);
    w.fromCli({ url: `http://${R1}/` });
    expect(Object.keys(httpState(w.sim, 'pc1'))).toEqual(['tabs', 'fetches', 'completed', 'failed', 'requests', 'apiRequests']);
  });

  it('is deterministic: two runs with one seed give the same trace', () => {
    const run = (): string => {
      const w = world();
      const cursor = w.sim.trace(0).next;
      w.fromDev({ method: 'PUT', url: `https://${R1}/restconf/data/nf-native:native/hostname`, headers: [AUTH, ['Content-Type', 'application/yang-data+json']], body: '{"nf-native:hostname":"EDGE"}' });
      w.fromCli({ url: `https://${R1}/restconf/data/nf-native:native`, headers: [AUTH] });
      return JSON.stringify(w.sim.trace(cursor).events);
    };
    const a = run();
    expect(a).toContain('"line":"hostname EDGE"');
    expect(run()).toBe(a);
  });
});
