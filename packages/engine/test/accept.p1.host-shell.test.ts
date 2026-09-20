/**
 * P1 acceptance — the host shell of a PC (ARCHITECTURE-P1 §10.2 `accept.p1.host-shell`; §6 "Host shell expansions
 * (P1)", §4.3, §4.4, §4.7).
 *
 * PC1 – SW1 – R1, where R1 leases addresses, answers names and serves a page. Every line the shell prints is
 * checked against the daemon state that produced it: the lease on the port and the binding on the server, the
 * resolver cache, the socket table, the IPv6 addresses and the neighbour cache.
 *
 * ponytail: one lab builder; the cases that need a lease take it first through `ip address dhcp`.
 */
import { describe, expect, it } from 'vitest';
import type { CliResult } from '../src/contracts/cli.js';
import type { SessionId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { DhcpBindingRow, DnsCacheRow, NdRow, SocketRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { createSimulation } from '../src/sim/simulation.js';
import { cable, device, topology } from './accept.p05.harness.js';
import { output } from './sim.harness.js';

const PC_PORT = 'GigabitEthernet0';
const BOOT = 60 * SEC;
const ROUTER = '192.168.1.1';
const ROUTER6 = '2001:db8:1::1';
const NAME = 'www.lab.nf';

/** R1: the LAN's gateway, address server, name server and web server. */
const R1_SERVICES: readonly string[] = [
  'ipv6 unicast-routing',
  'interface GigabitEthernet0/0',
  'ip address 192.168.1.1 255.255.255.0',
  `ipv6 address ${ROUTER6}/64`,
  'no shutdown',
  'exit',
  'ip dhcp excluded-address 192.168.1.1 192.168.1.9',
  'ip dhcp pool LAN',
  'network 192.168.1.0 255.255.255.0',
  'default-router 192.168.1.1',
  'dns-server 192.168.1.1',
  'domain-name lab.nf',
  'exit',
  'ip dns server',
  `ip host ${NAME} ${ROUTER}`,
  'ip http server',
];

/** Apply `lines` through the headless validator; a line that fails is a test bug. */
function configured(sim: Simulation, dev: string, lines: readonly string[]): void {
  const r = sim.configure(dev, lines);
  if (!r.ok) throw new Error(`${dev} setup failed: ${JSON.stringify(r.lines.filter((l) => !l.ok))}`);
}

/** The booted lab with a console open on PC1. */
function lab(seed = 41): { sim: Simulation; session: SessionId } {
  const sim = createSimulation({ seed });
  sim.loadTopology(
    topology(
      [device('pc1', 'pc.nfpc', 'PC1', 100, 300), device('sw1', 'switch.nfc2960', 'SW1', 300, 200), device('r1', 'router.nf2911', 'R1', 500, 120)],
      [cable('l_pc1_sw1', 'pc1', PC_PORT, 'sw1', 'FastEthernet0/1'), cable('l_sw1_r1', 'sw1', 'GigabitEthernet0/1', 'r1', 'GigabitEthernet0/0')],
    ),
  );
  sim.runFor(BOOT);
  configured(sim, 'r1', R1_SERVICES);
  sim.runToIdle();
  return { sim, session: sim.cli.open('pc1', 'console') };
}

/** Run one line; a line that fails to parse is a test bug, not a finding. */
function exec(sim: Simulation, session: SessionId, line: string): CliResult {
  const r = sim.cli.exec(session, line);
  if (r.error !== undefined) throw new Error(`"${line}" failed: ${r.output}`);
  return r;
}

/** Everything the session printed asynchronously since `cursor`. */
function since(sim: Simulation, session: SessionId, cursor: number): string {
  return output(sim.trace(cursor).events, session);
}

const sockets = (sim: Simulation, dev: string): SocketRow[] => sim.device(dev)!.tables.get<SocketRow>('sockets')?.rows() ?? [];

/** Take a lease and settle. */
function leased(sim: Simulation, session: SessionId): void {
  exec(sim, session, 'ip address dhcp');
  sim.runToIdle();
}

describe('accept P1: the host shell', () => {
  it('shows the live lease under ipconfig /all, and gives it back under /release', () => {
    const { sim, session } = lab();
    leased(sim, session);

    const lease = sim.device('pc1')!.port(PC_PORT)!.l3.ipv4!;
    expect(lease.origin).toBe('dhcp');
    const all = exec(sim, session, 'ipconfig /all').output;
    expect(all).toContain('Address from DHCP ...: yes (BOUND)');
    expect(all).toContain(`IPv4 address ........: ${lease.address} (dhcp)`);
    expect(all).toContain('Subnet mask .........: 255.255.255.0');
    expect(all).toContain(`Default gateway .....: ${ROUTER}`);
    expect(all).toContain(`DHCP server .........: ${ROUTER}`);
    expect(all).toContain('Domain name .........: lab.nf');
    expect(all).toContain(`Name servers ........: ${ROUTER}`);
    expect(all).toContain(sim.device('pc1')!.port(PC_PORT)!.mac);
    // The address the shell prints is the one the server has written down.
    const bindings = sim.device('r1')!.tables.get<DhcpBindingRow>('dhcp-bindings')?.rows() ?? [];
    expect(bindings.map((b) => [b.ip, b.state])).toEqual([[lease.address, 'bound']]);

    const cursor = sim.trace(0).next;
    exec(sim, session, 'ipconfig /release');
    sim.runToIdle();
    expect(since(sim, session, cursor)).toMatch(/released|gave up|no address/i);
    expect(sim.device('pc1')!.port(PC_PORT)!.l3.ipv4).toBeUndefined();
    expect(exec(sim, session, 'ipconfig').output).toContain('IPv4 address ........: not set');
    expect(sim.cli.session(session)!.busy).toBe(false);
  });

  it('blocks on ipconfig /renew and lets the interrupt end the job', () => {
    const { sim, session } = lab();
    leased(sim, session);
    // With the server unplugged the renew has nobody to answer it, so the session stays busy.
    sim.setPower('r1', false);
    sim.runToIdle();

    const renew = exec(sim, session, 'ipconfig /renew');
    expect(renew.busy).toBe(true);
    expect(sim.cli.session(session)!.job).toEqual({ process: 'dhcp-client', label: 'ipconfig' });

    const cursor = sim.trace(0).next;
    sim.cli.interrupt(session);
    // The line is the one the dhcp-client prints when it takes `job.abort`.
    expect(since(sim, session, cursor)).toContain(`${PC_PORT}: renew aborted`);
    expect(sim.cli.session(session)!.busy).toBe(false);
    expect(exec(sim, session, 'ipconfig').output).toContain(PC_PORT);
  });

  it('looks a name up, caches the answer and pings it', () => {
    const { sim, session } = lab();
    leased(sim, session);

    const cursor = sim.trace(0).next;
    const lookup = exec(sim, session, `nslookup ${NAME}`);
    expect(lookup.busy).toBe(true);
    expect(sim.cli.session(session)!.job).toEqual({ process: 'dns-client', label: 'nslookup' });
    sim.runToIdle();
    const text = since(sim, session, cursor);
    expect(text).toContain(NAME);
    expect(text).toContain(ROUTER);
    expect(sim.cli.session(session)!.busy).toBe(false);
    // The answer landed in the resolver cache, which is what `show hosts` renders.
    const cache = sim.device('pc1')!.tables.get<DnsCacheRow>('dns-cache')?.rows() ?? [];
    expect(cache.find((r) => r.name === NAME)).toMatchObject({ type: 'A', data: ROUTER, source: 'answer' });

    const pinged = sim.trace(0).next;
    expect(exec(sim, session, `ping ${NAME}`).busy).toBe(true);
    sim.runToIdle();
    const pingText = since(sim, session, pinged);
    expect(pingText).toContain(`Sending 5 echo requests to ${ROUTER}`);
    expect(pingText).toMatch(/Sent 5, received 5, lost 0 \(0% loss\)/);
  });

  it('lists an established connection under netstat -an while a page is loading', () => {
    const { sim, session } = lab();
    leased(sim, session);
    sim.hostRequest!('pc1', { app: 'http.get', url: `http://${NAME}/` });

    // Walk forward until the connection is up, and look at it while it is.
    let guard = 20_000;
    while (guard-- > 0 && !sockets(sim, 'pc1').some((s) => s.state === 'ESTABLISHED')) sim.step();
    const live = sockets(sim, 'pc1').find((s) => s.state === 'ESTABLISHED')!;
    expect(live).toBeDefined();
    expect(live.owner).toBe('http-client');
    expect(live.remotePort).toBe(80);

    const out = exec(sim, session, 'netstat -an').output;
    expect(out).toMatch(/^Proto\s+Local address\s+Remote address\s+State\s+Owner\s+Interface$/m);
    expect(out).toContain('ESTABLISHED');
    expect(out).toContain(`${live.remoteAddr}:80`);
    expect(out).toContain(`${live.localAddr}:${live.localPort}`);
    // `netstat` and `netstat -an` render the same table.
    expect(exec(sim, session, 'netstat').output).toBe(out);
  });

  it('autoconfigures IPv6, reports it under ipv6config and pings the router over it', () => {
    const { sim, session } = lab();
    expect(exec(sim, session, 'ipv6 autoconfig').output).toMatch(/listening for a router advertisement/);
    sim.runFor(10 * SEC);

    const port = sim.device('pc1')!.port(PC_PORT)!;
    expect(port.l3.ipv6Enabled).toBe(true);
    const slaac = (port.l3.ipv6 ?? []).find((a) => a.origin === 'slaac')!;
    expect(slaac).toMatchObject({ state: 'preferred', prefixLen: 64 });

    const out = exec(sim, session, 'ipv6config').output;
    expect(out).toContain(PC_PORT);
    expect(out).toContain(`${slaac.address}/64`);
    const neighbours = sim.device('pc1')!.tables.get<NdRow>('nd')?.rows() ?? [];
    const router = neighbours.find((n) => n.isRouter)!;
    expect(router).toBeDefined();
    expect(out).toContain(`Default router ......: ${router.ip}`);
    expect(out).toContain('Neighbours:');

    const cursor = sim.trace(0).next;
    expect(exec(sim, session, `ping -6 ${ROUTER6}`).busy).toBe(true);
    sim.runToIdle();
    expect(since(sim, session, cursor)).toMatch(/Sent 5, received 5, lost 0 \(0% loss\)/);
    expect(sim.cli.session(session)!.busy).toBe(false);
  });
});
