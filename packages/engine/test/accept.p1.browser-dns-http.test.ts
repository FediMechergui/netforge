/**
 * P1 acceptance — the browser fetch of `http://www.lab.nf/` (ARCHITECTURE-P1 §10.2 `accept.p1.browser-dns-http`;
 * §4.4 DNS, §4.5 TCP and HTTP).
 *
 * PC1, a switch, R1 as the name server and SRV2 as the web server. The Desktop browser's one call is
 * `hostRequest(PC1, http.get …)`; everything after it is the real stack, and every assertion reads the decoded
 * layers of the PDUs it produced, the tab the http-client daemon keeps, and the socket rows of both ends.
 *
 * ponytail: one world, one page; the refusal case reuses it by asking for a port nothing listens on.
 */
import { describe, expect, it } from 'vitest';
import type { PduView } from '../src/contracts/pdu.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { SocketRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { createSimulation } from '../src/sim/simulation.js';
import { cable, device, topology } from './accept.p05.harness.js';
import { ofKind } from './sim.harness.js';

const PC_PORT = 'GigabitEthernet0';
const BOOT = 60 * SEC;
/** Page SRV2 is configured to serve at `/`. */
const PAGE = '<html><body><h1>Lab web server</h1></body></html>';
/** How long TIME_WAIT holds a closed server socket (§4.5 step 7). */
const TIME_WAIT_NS = 60 * SEC;

/** Apply `lines` through the headless validator; a line that fails is a test bug. */
function configured(sim: Simulation, dev: string, lines: readonly string[]): void {
  const r = sim.configure(dev, lines);
  if (!r.ok) throw new Error(`${dev} setup failed: ${JSON.stringify(r.lines.filter((l) => !l.ok))}`);
}

/** PC1 (192.168.1.2) – SW1 – R1 (name server .1) and SRV2 (web server .80), booted and configured. */
function web(seed = 9): Simulation {
  const sim = createSimulation({ seed });
  sim.loadTopology(
    topology(
      [
        device('pc1', 'pc.nfpc', 'PC1', 100, 300),
        device('sw1', 'switch.nfc2960', 'SW1', 300, 200),
        device('r1', 'router.nf2911', 'R1', 500, 120),
        device('srv2', 'server.nfserver', 'SRV2', 500, 320),
      ],
      [
        cable('l_pc1_sw1', 'pc1', PC_PORT, 'sw1', 'FastEthernet0/1'),
        cable('l_sw1_r1', 'sw1', 'GigabitEthernet0/1', 'r1', 'GigabitEthernet0/0'),
        cable('l_sw1_srv2', 'sw1', 'FastEthernet0/2', 'srv2', PC_PORT),
      ],
    ),
  );
  sim.runFor(BOOT);
  configured(sim, 'r1', [
    'interface GigabitEthernet0/0',
    'ip address 192.168.1.1 255.255.255.0',
    'no shutdown',
    'exit',
    'ip dns server',
    'ip host www.lab.nf 192.168.1.80',
  ]);
  configured(sim, 'srv2', ['ip address 192.168.1.80 255.255.255.0 192.168.1.1', 'service http on', `service http page / ${PAGE}`]);
  configured(sim, 'pc1', ['ip address 192.168.1.2 255.255.255.0 192.168.1.1', 'ip dns 192.168.1.1']);
  sim.runToIdle();
  return sim;
}

/** The http-client tab a ticket owns. */
function tab(sim: Simulation, dev: string, token: string): Record<string, unknown> {
  const state = sim.device(dev)?.processes.get('http-client')?.stateSnapshot().state;
  const tabs = state?.['tabs'] as Record<string, Record<string, unknown>> | undefined;
  return tabs?.[token] ?? {};
}

const sockets = (sim: Simulation, dev: string): SocketRow[] => sim.device(dev)!.tables.get<SocketRow>('sockets')?.rows() ?? [];

/** Every PDU created since `cursor`, as `{ device, pdu }`, in creation order. */
function created(sim: Simulation, cursor: number): { device: string; pdu: PduView }[] {
  return ofKind(sim.trace(cursor).events, 'pduCreated').map((e) => ({ device: e.device, pdu: sim.pdu(e.pdu.id)! }));
}

describe('accept P1: browser fetch over DNS, TCP and HTTP', () => {
  it('resolves the name, opens the connection, exchanges the request and the page, and closes both ways', () => {
    const sim = web();
    const cursor = sim.trace(0).next;
    sim.hostRequest!('pc1', { app: 'http.get', url: 'http://www.lab.nf/' });
    sim.runFor(5 * SEC);
    const flight = created(sim, cursor);

    // ── the name (§4.4) ──
    const query = flight.find((f) => f.pdu.layer('dns') !== undefined && f.pdu.get('dns.qr') === false)!;
    expect(query.device).toBe('pc1');
    expect(query.pdu.get('dns.questions')).toBe('www.lab.nf A');
    expect(query.pdu.get('udp.dstPort')).toBe(53);
    const answer = flight.find((f) => f.pdu.layer('dns') !== undefined && f.pdu.get('dns.qr') === true)!;
    expect(answer.device).toBe('r1');
    expect(String(answer.pdu.get('dns.answers'))).toContain('192.168.1.80');
    expect(answer.pdu.meta.triggeredBy).toBe(query.pdu.id);

    // ── the connection (§4.5 steps 1–3) ──
    const tcp = flight.filter((f) => f.pdu.layer('tcp') !== undefined);
    const syn = tcp[0]!;
    const synAck = tcp[1]!;
    const ack = tcp[2]!;
    expect([syn.device, synAck.device, ack.device]).toEqual(['pc1', 'srv2', 'pc1']);
    expect([syn.pdu.get('tcp.flags'), synAck.pdu.get('tcp.flags'), ack.pdu.get('tcp.flags')]).toEqual(['S', 'SA', 'A']);
    expect(syn.pdu.get('tcp.dstPort')).toBe(80);
    expect(Number(synAck.pdu.get('tcp.ack'))).toBe((Number(syn.pdu.get('tcp.seq')) + 1) >>> 0);
    expect(Number(ack.pdu.get('tcp.seq'))).toBe((Number(syn.pdu.get('tcp.seq')) + 1) >>> 0);
    expect(Number(ack.pdu.get('tcp.ack'))).toBe((Number(synAck.pdu.get('tcp.seq')) + 1) >>> 0);

    // ── request and response, decoded as HTTP (§4.5 steps 3–5) ──
    const get = flight.find((f) => f.pdu.get('http.kind') === 'request')!;
    expect(get.device).toBe('pc1');
    expect(get.pdu.get('http.method')).toBe('GET');
    expect(get.pdu.get('http.target')).toBe('/');
    expect(String(get.pdu.get('http.headers'))).toContain('Host: www.lab.nf');
    const ok = flight.find((f) => f.pdu.get('http.kind') === 'response')!;
    expect(ok.device).toBe('srv2');
    expect(ok.pdu.get('http.status')).toBe(200);
    expect(ok.pdu.get('http.body')).toBe(PAGE);

    // ── both ends close (§4.5 steps 6–7) ──
    const fins = tcp.filter((f) => String(f.pdu.get('tcp.flags')).includes('F'));
    expect(fins.map((f) => f.device)).toContain('srv2');
    expect(fins.map((f) => f.device)).toContain('pc1');
    expect(flight.indexOf(fins.find((f) => f.device === 'srv2')!)).toBeGreaterThan(flight.indexOf(ok));
  });

  it('ends the tab done with the configured page', () => {
    const sim = web();
    const ticket = sim.hostRequest!('pc1', { app: 'http.get', url: 'http://www.lab.nf/' });
    sim.runFor(5 * SEC);
    const t = tab(sim, 'pc1', ticket.requestId);
    expect(t['phase']).toBe('done');
    expect(t['status']).toBe(200);
    expect(t['host']).toBe('www.lab.nf');
    expect(t['address']).toBe('192.168.1.80');
    expect(t['body']).toBe(PAGE);
  });

  it('drops the client socket and leaves the server one in TIME_WAIT for a minute', () => {
    const sim = web();
    sim.hostRequest!('pc1', { app: 'http.get', url: 'http://www.lab.nf/' });
    sim.runFor(5 * SEC);

    expect(sockets(sim, 'pc1').filter((s) => s.owner === 'http-client')).toEqual([]);
    const waiting = sockets(sim, 'srv2').filter((s) => s.state === 'TIME_WAIT');
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.localPort).toBe(80);
    expect(waiting[0]!.expiresAt).toBe(waiting[0]!.updatedAt + TIME_WAIT_NS);
    // The listener itself stays open for the next client.
    expect(sockets(sim, 'srv2').filter((s) => s.state === 'LISTEN')).not.toEqual([]);

    sim.runFor(TIME_WAIT_NS);
    expect(sockets(sim, 'srv2').filter((s) => s.state === 'TIME_WAIT')).toEqual([]);
  });

  it('answers a port nothing listens on with a refusal the tab can show', () => {
    const sim = web();
    const ticket = sim.hostRequest!('pc1', { app: 'http.get', url: 'http://www.lab.nf:81/' });
    sim.runFor(5 * SEC);
    const t = tab(sim, 'pc1', ticket.requestId);
    expect(t['phase']).toBe('error');
    expect(t['error']).toBe('The server refused the connection.');
    // Original wording: nothing here names a vendor or copies a browser.
    expect(String(t['error'])).not.toMatch(/cisco|windows|chrome|firefox/i);
    expect(sockets(sim, 'pc1').filter((s) => s.owner === 'http-client')).toEqual([]);
  });
});
