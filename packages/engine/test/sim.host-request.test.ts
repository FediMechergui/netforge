/**
 * P1 W6 sim: `Simulation.hostRequest` — the GUI app allowlist (ARCHITECTURE-P1 §4.4 step 0, §4.5;
 * contracts/simulation.ts `HostAppRequest` / `HostAppTicket`).
 *
 * Nothing is faked: real catalog models boot with their P1 daemons, and every assertion reads what the daemon did —
 * the http-client tab keyed by the ticket, the probe request a Wi-Fi scan puts on the air, the DHCP-leased address
 * on the port. Checked: the ticket ids, each app kind, the refusals (unknown device, missing daemon, unknown port)
 * and that two identical runs hand out the same ids and leave the same trace.
 */
import { describe, expect, it } from 'vitest';
import type { HostAppRequest, Simulation } from '../src/contracts/simulation.js';
import { HTTP_CLIENT_RETAINED_TABS } from '../src/protocols/http-client.js';
import { homeWifi, pcRouterPc } from '../src/sim/scenarios.js';
import { booted, ofKind } from './sim.harness.js';

/** R1 as the lab's web server, DHCP pool and name server. */
const ROUTER_SERVICES: readonly string[] = [
  'ip dhcp excluded-address 10.0.0.200 10.0.0.254',
  'ip dhcp pool LAN',
  'network 10.0.0.0 255.255.255.0',
  'default-router 10.0.0.254',
  'dns-server 10.0.0.254',
  'exit',
  'ip dns server',
  'ip host www.lab.nf 10.0.0.254',
  'ip http server',
];

function configured(sim: Simulation, device: string, lines: readonly string[]): void {
  const r = sim.configure(device, lines);
  if (!r.ok) throw new Error(`${device} setup failed: ${JSON.stringify(r.lines.filter((l) => !l.ok))}`);
}

/** A booted PC–router–PC lab whose router serves HTTP, DHCP and DNS, with PC1 on a lease. */
function lab(seed = 7): Simulation {
  const sim = booted(pcRouterPc(), seed);
  configured(sim, 'r1', ROUTER_SERVICES);
  configured(sim, 'pc1', ['ip address dhcp']);
  sim.runToIdle();
  return sim;
}

/** The http-client tab keyed by a ticket. */
function tab(sim: Simulation, device: string, token: string): Record<string, unknown> | undefined {
  const state = sim.device(device)?.processes.get('http-client')?.stateSnapshot().state;
  const tabs = state?.['tabs'] as Record<string, Record<string, unknown>> | undefined;
  return tabs?.[token];
}

describe('hostRequest: tickets', () => {
  it('numbers tickets r_1, r_2, … from a per-simulation counter and names the target daemon', () => {
    const sim = lab();
    const first = sim.hostRequest!('pc1', { app: 'http.get', url: 'http://10.0.0.254/' });
    expect(first).toEqual({ requestId: 'r_1', process: 'http-client' });
    const second = sim.hostRequest!('pc1', { app: 'dhcp.renew', port: 'GigabitEthernet0' });
    expect(second).toEqual({ requestId: 'r_2', process: 'dhcp-client' });
    // The ticket is the token the daemon keys its result by (§4.4 step 0).
    expect(tab(sim, 'pc1', 'r_1')?.['url']).toBe('http://10.0.0.254/');
  });

  it('a refused request changes nothing and does not spend a ticket number', () => {
    const sim = lab();
    expect(() => sim.hostRequest!('pc1', { app: 'wifi.scan' })).toThrow();
    expect(sim.hostRequest!('pc1', { app: 'http.get', url: 'http://10.0.0.254/' }).requestId).toBe('r_1');
  });
});

describe('hostRequest: http.get', () => {
  it('drives a whole fetch through the real stack and ends the tab done', () => {
    const sim = lab();
    const ticket = sim.hostRequest!('pc1', { app: 'http.get', url: 'http://www.lab.nf/' });
    expect(ticket.process).toBe('http-client');
    sim.runToIdle();

    const done = tab(sim, 'pc1', ticket.requestId);
    expect(done?.['phase']).toBe('done');
    expect(done?.['status']).toBe(200);
    expect(String(done?.['body'] ?? '')).not.toBe('');
    // The name was resolved by dns-client on the way (§4.4), not by the facade.
    expect(done?.['host']).toBe('www.lab.nf');
    expect(String(done?.['address'] ?? '')).toBe('10.0.0.254');
  });

  it('a URL the browser cannot use fails inside the tab, not at the facade', () => {
    const sim = lab();
    const ticket = sim.hostRequest!('pc1', { app: 'http.get', url: 'https://www.lab.nf/' });
    sim.runToIdle();
    const t = tab(sim, 'pc1', ticket.requestId);
    expect(t?.['phase']).toBe('error');
    expect(String(t?.['error'] ?? '')).not.toBe('');
  });
});

describe('hostRequest: wifi.scan', () => {
  it('puts a probe request on the air, defaulting to the wireless interface', () => {
    const sim = booted(homeWifi(), 3);
    sim.runToIdle();
    const cursor = sim.trace(0).next;

    const ticket = sim.hostRequest!('laptop1', { app: 'wifi.scan' });
    expect(ticket).toEqual({ requestId: 'r_1', process: 'wlan-client' });
    const probes = ofKind(sim.trace(cursor).events, 'pduCreated').filter((e) => e.device === 'laptop1' && e.pdu.tag === 'probe-req');
    expect(probes.length).toBe(1);
  });

  it('accepts an explicit port, by its short name too', () => {
    const sim = booted(homeWifi(), 3);
    sim.runToIdle();
    const cursor = sim.trace(0).next;
    expect(sim.hostRequest!('laptop1', { app: 'wifi.scan', port: 'Wl0' }).process).toBe('wlan-client');
    expect(ofKind(sim.trace(cursor).events, 'pduCreated').filter((e) => e.pdu.tag === 'probe-req').length).toBe(1);
  });
});

describe('hostRequest: dhcp.renew and dhcp.release', () => {
  it('releases a live lease and takes a new one', () => {
    const sim = lab();
    const leased = sim.device('pc1')!.port('GigabitEthernet0')!.l3.ipv4;
    expect(leased?.origin).toBe('dhcp');

    const release = sim.hostRequest!('pc1', { app: 'dhcp.release', port: 'Gi0' });
    expect(release).toEqual({ requestId: 'r_1', process: 'dhcp-client' });
    sim.runToIdle();
    expect(sim.device('pc1')!.port('GigabitEthernet0')!.l3.ipv4).toBeUndefined();

    expect(sim.hostRequest!('pc1', { app: 'dhcp.renew', port: 'Gi0' }).requestId).toBe('r_2');
    sim.runToIdle();
    expect(sim.device('pc1')!.port('GigabitEthernet0')!.l3.ipv4?.origin).toBe('dhcp');
  });
});

describe('hostRequest: refusals', () => {
  it('names the device that does not exist', () => {
    const sim = lab();
    expect(() => sim.hostRequest!('nope', { app: 'http.get', url: 'http://10.0.0.254/' })).toThrow(/nope/);
  });

  it('refuses a device that does not run the target daemon', () => {
    const sim = lab();
    // A router serves HTTP; it has no browser of its own.
    expect(() => sim.hostRequest!('r1', { app: 'http.get', url: 'http://10.0.0.1/' })).toThrow(/http-client/);
    expect(() => sim.hostRequest!('pc1', { app: 'wifi.scan', port: 'Wlan0' })).toThrow(/wlan-client/);
  });

  it('refuses an interface the device does not have', () => {
    const sim = lab();
    expect(() => sim.hostRequest!('pc1', { app: 'dhcp.renew', port: 'GigabitEthernet9' })).toThrow(/GigabitEthernet9/);
    const wifi = booted(homeWifi(), 3);
    expect(() => wifi.hostRequest!('laptop1', { app: 'wifi.scan', port: 'Wlan7' })).toThrow(/Wlan7/);
  });

  it('refuses a device that is running nothing at all (powered off)', () => {
    const sim = lab();
    sim.setPower('pc1', false);
    sim.runFor(1);
    expect(() => sim.hostRequest!('pc1', { app: 'http.get', url: 'http://10.0.0.254/' })).toThrow(/http-client/);
  });

  it('refuses a malformed payload with readable wording and spends no ticket', () => {
    // The worker forwards the UI's message unchecked, so a missing or mistyped field must not reach a daemon as a
    // TypeError — and a refused request must not consume a ticket number.
    const sim = lab();
    const bad = [
      { app: 'http.get' },
      { app: 'http.get', url: '   ' },
      { app: 'http.get', url: 7 },
      { app: 'dhcp.renew' },
      { app: 'dhcp.release', port: 42 },
    ] as unknown as HostAppRequest[];
    for (const req of bad) {
      let message = '';
      expect(() => {
        try {
          sim.hostRequest!('pc1', req);
        } catch (e) {
          message = e instanceof Error ? e.message : String(e);
          throw e;
        }
      }, JSON.stringify(req)).toThrow();
      expect(message, JSON.stringify(req)).not.toMatch(/TypeError|undefined|is not a function/);
    }
    // None of the refusals moved the counter.
    expect(sim.hostRequest!('pc1', { app: 'http.get', url: 'http://10.0.0.254/' }).requestId).toBe('r_1');
  });
});

describe('hostRequest: http.get retention', () => {
  it('forgets the oldest finished tabs so a long browsing session does not grow every snapshot', () => {
    const sim = lab();
    const view = (): Record<string, unknown> => sim.device('pc1')!.processes.get('http-client')!.stateSnapshot().state as Record<string, unknown>;
    const fetches = HTTP_CLIENT_RETAINED_TABS * 3;
    const counts: number[] = [];
    for (let i = 0; i < fetches; i++) {
      sim.hostRequest!('pc1', { app: 'http.get', url: `http://www.lab.nf/page-${i}` });
      sim.runToIdle();
      counts.push(Object.keys(view()['tabs'] as object).length);
    }
    // Every fetch really ran (the GUI mints a fresh token each time), but the retained tabs stop growing.
    expect(view()['fetches']).toBe(fetches);
    expect(view()['completed']).toBe(fetches);
    expect(Math.max(...counts)).toBe(HTTP_CLIENT_RETAINED_TABS + 1);
    expect(counts[counts.length - 1]).toBe(HTTP_CLIENT_RETAINED_TABS + 1);

    // The most recent fetch is still readable by its ticket.
    const last = sim.hostRequest!('pc1', { app: 'http.get', url: 'http://www.lab.nf/' });
    sim.runToIdle();
    expect(view()['tabs']).toHaveProperty(last.requestId);
  });
});

describe('hostRequest: determinism', () => {
  it('two identical runs hand out the same tickets and leave the same trace', () => {
    const script = (seed: number): { ids: string[]; trace: string } => {
      const sim = lab(seed);
      const ids: string[] = [];
      ids.push(sim.hostRequest!('pc1', { app: 'http.get', url: 'http://www.lab.nf/' }).requestId);
      sim.runToIdle();
      ids.push(sim.hostRequest!('pc1', { app: 'http.get', url: 'http://10.0.0.254/' }).requestId);
      sim.runToIdle();
      return { ids, trace: JSON.stringify(sim.trace(0).events) };
    };
    const a = script(11);
    const b = script(11);
    expect(a.ids).toEqual(['r_1', 'r_2']);
    expect(b.ids).toEqual(a.ids);
    expect(b.trace).toBe(a.trace);
  });
});
