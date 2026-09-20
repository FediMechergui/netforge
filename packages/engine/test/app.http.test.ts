/**
 * app.http.test.ts — http-client and http-server end to end (protocols/http-{client,server}.ts;
 * ARCHITECTURE-P1 §4.5, §4.4 step 0), on the ip6.harness bus with the real arp/ipv4/icmpv4/tcp/udp daemons taken
 * from the P1 process registry (protocols/index.ts), so the daemons a real device model boots are the ones tested.
 *
 * PC1 192.168.1.2 — R1 Gi0/0 192.168.1.80 (`ip http server`, `ip dns server`, `ip host www.lab.nf 192.168.1.80`).
 */
import { describe, expect, it } from 'vitest';
import type { Pdu } from '../src/contracts/pdu.js';
import type { SocketRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { HTTP_BROWSER_USER_AGENT, HTTP_REQUEST_TIMEOUT_NS, HTTP_SERVER_HEADER } from '../src/contracts/services.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import { MSG_HTTPS } from '../src/protocols/http-client.js';
import { httpDefaultPage } from '../src/protocols/http-server.js';
import { BOOT_NS, createWorld6, type World6 } from './ip6.harness.js';

const PC = 'GigabitEthernet0';
const G0 = 'GigabitEthernet0/0';
const SERVER = '192.168.1.80';

/** PC1 — R1; R1 serves the web (and DNS, for the fetch-by-name case). */
function lab(opts: { seed?: number; pages?: string[] } = {}): World6 {
  const w = createWorld6({ seed: opts.seed ?? 5, extra: { ...PROCESS_FACTORIES } });
  w.add('pc1', 'pc');
  w.add('r1', 'router');
  w.link({ device: 'pc1', port: PC }, { device: 'r1', port: G0 });
  w.runFor(BOOT_NS);
  w.iface('pc1', PC, 'ip address 192.168.1.2 255.255.255.0');
  w.iface('r1', G0, `ip address ${SERVER} 255.255.255.0`, 'no shutdown');
  w.global('r1', 'ip http server', ...(opts.pages ?? []));
  w.runFor(1 * SEC);
  return w;
}

function fetchUrl(w: World6, url: string, token = 'r_1', session?: string): void {
  w.request('pc1', 'http-client', { kind: 'http.fetch', owner: 'host', token, url, ...(session !== undefined ? { session } : {}) });
}

const tabs = (w: World6, dev = 'pc1'): Record<string, Record<string, unknown>> =>
  (w.dev(dev).processes.get('http-client')!.stateSnapshot().state as { tabs: Record<string, Record<string, unknown>> }).tabs;
const tab = (w: World6, token = 'r_1'): Record<string, unknown> => tabs(w)[token]!;
const httpOf = (p: Pdu): Record<string, unknown> | undefined => p.layers.find((l) => l.proto === 'http')?.fields as Record<string, unknown> | undefined;
const messages = (w: World6, dev: string): Record<string, unknown>[] => w.sentBy(dev).map(httpOf).filter((f): f is Record<string, unknown> => f !== undefined);
const sockets = (w: World6, dev: string): string[] => w.dev(dev).tables.get<SocketRow>('sockets')!.rows().map((r) => `${r.id}:${r.state}`);
const tcpFlags = (w: World6, dev: string): string[] =>
  w.sentBy(dev).map((p) => p.layers.find((l) => l.proto === 'tcp')?.fields.flags).filter((f): f is string => typeof f === 'string');

describe('app.http fetch of a configured page', () => {
  it('runs resolve-free connect, GET, 200 with the default page, and closes both ways', () => {
    const w = lab();
    fetchUrl(w, `http://${SERVER}/`);
    w.runFor(2 * SEC);

    const body = httpDefaultPage('R1');
    const t = tab(w);
    expect(t.phase).toBe('done');
    expect(t.status).toBe(200);
    expect(t.reason).toBe('OK');
    expect(t.body).toBe(body);
    expect(t.address).toBe(SERVER);
    expect(String(t.headers).split('\n')).toEqual([
      `Server: ${HTTP_SERVER_HEADER}`,
      'Content-Type: text/html',
      `Content-Length: ${body.length}`,
      'Connection: close',
    ]);

    // §4.5 step 3: the request line and headers exactly as the brief writes them
    const [request] = messages(w, 'pc1');
    expect([request!.kind, request!.method, request!.target, request!.version]).toEqual(['request', 'GET', '/', 'HTTP/1.1']);
    expect(String(request!.headers).split('\n')).toEqual([`Host: ${SERVER}`, `User-Agent: ${HTTP_BROWSER_USER_AGENT}`, 'Accept: */*', 'Connection: close']);
    const [response] = messages(w, 'r1');
    expect([response!.kind, response!.status, response!.reason]).toEqual(['response', 200, 'OK']);
    expect(response!.body).toBe(body);

    // handshake, request, response, FIN both ways (§4.5 steps 1-7)
    expect(tcpFlags(w, 'pc1').slice(0, 3)).toEqual(['S', 'A', 'PA']);
    expect(tcpFlags(w, 'pc1')).toContain('FA');
    expect(tcpFlags(w, 'r1')).toContain('FA');
    // the client socket is gone; the server child sits in TIME_WAIT beside its two listeners
    expect(sockets(w, 'pc1')).toEqual([]);
    expect(sockets(w, 'r1')).toEqual(['http-server#80:LISTEN', 'http-server#80v6:LISTEN', 'http-server#80/1:TIME_WAIT']);
    expect((w.dev('r1').processes.get('http-server')!.stateSnapshot().state as { served: number }).served).toBe(1);
  });

  it('serves a configured ip http page and 404s an unknown path', () => {
    const w = lab({ pages: ['ip http page /hello.html <html><body>Lab page</body></html>'] });
    fetchUrl(w, `http://${SERVER}/hello.html`);
    w.runFor(2 * SEC);
    expect([tab(w).status, tab(w).body]).toEqual([200, '<html><body>Lab page</body></html>']);

    fetchUrl(w, `http://${SERVER}/missing.html`, 'r_2');
    w.runFor(2 * SEC);
    const t = tabs(w).r_2!;
    expect([t.phase, t.status, t.reason]).toEqual(['done', 404, 'Not Found']);
    expect(String(t.body)).toContain('/missing.html');
    const state = w.dev('r1').processes.get('http-server')!.stateSnapshot().state as { served: number; notFound: number; requests: number };
    expect([state.requests, state.served, state.notFound]).toEqual([2, 1, 1]);
  });

  it('a query string selects the same page and the closed ports are answered with an original message', () => {
    const w = lab({ pages: ['ip http page /p <html>q</html>'] });
    fetchUrl(w, `http://${SERVER}/p?x=1`);
    fetchUrl(w, `http://${SERVER}:81/`, 'r_2');
    w.runFor(2 * SEC);
    expect(tab(w).body).toBe('<html>q</html>');
    expect(tabs(w).r_2).toMatchObject({ phase: 'error', error: 'The server refused the connection.' });
  });

  it('no ip http server closes both listeners and the port is refused again', () => {
    const w = lab();
    w.global('r1', 'no ip http server');
    w.runFor(1 * SEC);
    expect(sockets(w, 'r1')).toEqual([]);
    fetchUrl(w, `http://${SERVER}/`);
    w.runFor(2 * SEC);
    expect(tab(w)).toMatchObject({ phase: 'error', error: 'The server refused the connection.' });
  });

  it('refuses an https URL without touching the wire', () => {
    const w = lab();
    const before = w.sentBy('pc1').length;
    fetchUrl(w, 'https://www.lab.nf/');
    w.runFor(2 * SEC);
    expect(tab(w)).toMatchObject({ phase: 'error', error: MSG_HTTPS });
    expect(w.sentBy('pc1')).toHaveLength(before);
  });

  it('restarts the tab on the same token without killing the new fetch or leaking a socket', () => {
    // The browser's reload: a second `http.fetch` on the live token. The abort of the old connection must not be
    // mistaken for the new one (§4.5 steps 6-7: the client socket is gone when the tab is done).
    const w = lab();
    fetchUrl(w, `http://${SERVER}/`, 'r_1', 's_1');
    fetchUrl(w, `http://${SERVER}/`, 'r_1', 's_1');
    w.runFor(3 * SEC);
    expect(tab(w)).toMatchObject({ phase: 'done', status: 200 });
    expect(sockets(w, 'pc1')).toEqual([]);
    // one command, one cliDone: the superseded tab does not unblock the session the new fetch still holds
    expect(w.done.map((d) => d.session)).toEqual(['s_1']);
  });

  it('restarting a tab that is still connecting ends only the old connection', () => {
    const w = lab();
    fetchUrl(w, 'http://192.168.1.99/');
    w.runFor(1 * SEC);
    expect(tab(w).phase).toBe('connecting');
    expect(sockets(w, 'pc1')).toEqual(['http-client#r_1:SYN_SENT']);

    fetchUrl(w, `http://${SERVER}/`);
    w.runFor(3 * SEC);
    expect(tab(w)).toMatchObject({ phase: 'done', status: 200, address: SERVER });
    // the second attempt used an id of its own, and both attempts are gone from the socket table
    expect(sockets(w, 'pc1')).toEqual([]);
    expect(sockets(w, 'r1')).toEqual(['http-server#80:LISTEN', 'http-server#80v6:LISTEN', 'http-server#80/1:TIME_WAIT']);
  });

  it('answers an accepted connection that never sends a request head with 408 and closes it', () => {
    const w = lab();
    w.request('pc1', 'tcp', { kind: 'tcp.connect', owner: 'host', socket: 'probe#1', dst: SERVER, dstPort: 80 });
    w.runFor(2 * SEC);
    expect(sockets(w, 'r1')).toContain('http-server#80/1:ESTABLISHED');

    w.runFor(HTTP_REQUEST_TIMEOUT_NS);
    const answers = messages(w, 'r1');
    expect(answers[answers.length - 1]).toMatchObject({ kind: 'response', status: 408 });
    const state = w.dev('r1').processes.get('http-server')!.stateSnapshot().state as { open: string[]; badRequests: number };
    expect(state.badRequests).toBe(1);
    // the peer's own close then frees everything: no child and no row are left behind
    w.request('pc1', 'tcp', { kind: 'tcp.close', socket: 'probe#1' });
    w.runFor(2 * SEC);
    expect((w.dev('r1').processes.get('http-server')!.stateSnapshot().state as { open: string[] }).open).toEqual([]);
    expect(sockets(w, 'pc1')).toEqual([]);
  });

  it('prints one original line to a CLI session and ends it', () => {
    const w = lab();
    fetchUrl(w, `http://${SERVER}/`, 'r_1', 's_1');
    w.runFor(2 * SEC);
    expect(w.output('s_1')).toBe(`Fetched http://${SERVER}/: 200 OK from ${SERVER}, ${httpDefaultPage('R1').length} characters\n`);
    expect(w.done.map((d) => d.session)).toEqual(['s_1']);
  });
});

describe('app.http fetch by name', () => {
  /** R1 also answers DNS for www.lab.nf. */
  function named(seed = 5): World6 {
    const w = lab({ seed });
    w.global('r1', 'ip dns server', `ip host www.lab.nf ${SERVER}`);
    w.global('pc1', 'ip name-server 192.168.1.80');
    w.runFor(1 * SEC);
    return w;
  }

  it('resolves the host through dns-client and dns-server, then fetches it', () => {
    const w = named();
    fetchUrl(w, 'http://www.lab.nf/');
    w.runFor(3 * SEC);
    expect(tab(w)).toMatchObject({ phase: 'done', status: 200, host: 'www.lab.nf', address: SERVER });
    // the query went out and the Host header carries the name, not the address (§4.5 step 3)
    expect(w.sentBy('pc1').filter((p) => p.meta.tag === 'dns-query')).toHaveLength(1);
    expect(String(messages(w, 'pc1')[0]!.headers)).toContain('Host: www.lab.nf');
  });

  it('reports an unknown name as an original tab error', () => {
    const w = named();
    fetchUrl(w, 'http://nowhere.lab.nf/');
    w.runFor(3 * SEC);
    expect(tab(w)).toMatchObject({ phase: 'error', error: 'The name nowhere.lab.nf was not found.' });
  });
});

describe('app.http determinism', () => {
  it('two runs of the same seed pick the same port and ISN and produce the same bytes', () => {
    const run = (): { flows: string[]; body: unknown } => {
      const w = named();
      fetchUrl(w, 'http://www.lab.nf/');
      w.runFor(3 * SEC);
      return {
        flows: w.sentBy('pc1').map((p) => `${p.meta.flow ?? ''}|${p.meta.tag ?? ''}|${p.summary()}`),
        body: tab(w).body,
      };
    };
    const named = (): World6 => {
      const w = lab({ seed: 21 });
      w.global('r1', 'ip dns server', `ip host www.lab.nf ${SERVER}`);
      w.global('pc1', 'ip name-server 192.168.1.80');
      w.runFor(1 * SEC);
      return w;
    };
    const a = run();
    const b = run();
    expect(a.flows).toEqual(b.flows);
    expect(a.body).toEqual(b.body);
    expect(a.flows.some((f) => f.includes(':80:tcp'))).toBe(true);
  });
});
