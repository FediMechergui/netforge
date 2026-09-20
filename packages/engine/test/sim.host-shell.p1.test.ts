/**
 * The P1 host shell end to end on a real simulation (ARCHITECTURE-P1 §6 "Host shell expansions (P1)", §4.3, §4.4,
 * §4.7, §8.2 W5): `ip address dhcp` and `ipconfig /all` over a live lease, `/release` and `/renew` as blocking jobs
 * with ^C, `nslookup`, `tracert`, `netstat`, `ipv6 address` and `ipv6config`.
 *
 * Nothing is faked: the router is configured through its own CLI, and every value the host shell prints comes from
 * the daemons that produced it (dhcp-client's lease, the 'sockets' and 'nd' tables, the traceroute job's output).
 */
import { describe, expect, it } from 'vitest';
import type { CliResult } from '../src/contracts/cli.js';
import type { SessionId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { pcRouterPc } from '../src/sim/scenarios.js';
import { booted, output } from './sim.harness.js';

/** R1 as the lab's DHCP and name server; PC1 keeps its static address until the test takes it away. */
const ROUTER_SERVICES: readonly string[] = [
  'ip dhcp excluded-address 10.0.0.200 10.0.0.254',
  'ip dhcp pool LAN',
  'network 10.0.0.0 255.255.255.0',
  'default-router 10.0.0.254',
  'dns-server 10.0.0.254',
  'domain-name lab.nf',
  'exit',
  'ip dns server',
  'ip host www.lab.nf 10.0.1.1',
];

/** A booted PC–router–PC lab whose router offers DHCP and DNS, with a console open on PC1. */
function lab(): { sim: Simulation; session: SessionId } {
  const sim = booted(pcRouterPc(), 7);
  const r = sim.configure('r1', ROUTER_SERVICES);
  if (!r.ok) throw new Error(`router setup failed: ${JSON.stringify(r.lines.filter((l) => !l.ok))}`);
  sim.runToIdle();
  return { sim, session: sim.cli.open('pc1', 'console') };
}

/** Run one line and return its result; a line that fails to parse is a test bug, not a finding. */
function exec(sim: Simulation, session: SessionId, line: string): CliResult {
  const r = sim.cli.exec(session, line);
  if (r.error !== undefined) throw new Error(`"${line}" failed: ${r.output}`);
  return r;
}

/** Everything the session printed asynchronously since `cursor`. */
function since(sim: Simulation, session: SessionId, cursor: number): string {
  return output(sim.trace(cursor).events, session);
}

describe('host shell: DHCP', () => {
  it('ip address dhcp takes a lease and ipconfig /all shows where it came from', () => {
    const { sim, session } = lab();
    expect(exec(sim, session, 'ip address dhcp').output).toMatch(/asking a DHCP server/);
    sim.runToIdle();

    const brief = exec(sim, session, 'ipconfig').output;
    expect(brief).toMatch(/IPv4 address \.+: 10\.0\.0\.\d+/);
    const all = exec(sim, session, 'ipconfig /all').output;
    expect(all).toContain('Address from DHCP ...: yes (BOUND)');
    expect(all).toMatch(/IPv4 address \.+: 10\.0\.0\.\d+ \(dhcp\)/);
    expect(all).toContain('Subnet mask .........: 255.255.255.0');
    expect(all).toContain('Default gateway .....: 10.0.0.254');
    expect(all).toContain('DHCP server .........: 10.0.0.254');
    expect(all).toContain('Domain name .........: lab.nf');
    expect(all).toContain('Name servers ........: 10.0.0.254');

    // The lease the daemon holds and the address the port carries are the same one.
    const leased = sim.device('pc1')!.port('GigabitEthernet0')!.l3.ipv4;
    expect(leased?.origin).toBe('dhcp');
    expect(all).toContain(leased!.address);
    const binding = sim.device('r1')!.tables.get?.('dhcp-bindings')?.rows() ?? [];
    expect(binding.map((b) => (b as unknown as { ip: string }).ip)).toContain(leased!.address);
  });

  it('ipconfig /release gives the address back and blocks until the daemon answers', () => {
    const { sim, session } = lab();
    exec(sim, session, 'ip address dhcp');
    sim.runToIdle();
    expect(sim.device('pc1')!.port('GigabitEthernet0')!.l3.ipv4).toBeDefined();

    const cursor = sim.trace(0).next;
    // A release the daemon answers within the same call comes back free; one that waits comes back busy.
    exec(sim, session, 'ipconfig /release');
    sim.runToIdle();
    expect(sim.cli.session(session)!.busy).toBe(false);
    expect(since(sim, session, cursor)).toMatch(/released|gave up|no address/i);
    expect(sim.device('pc1')!.port('GigabitEthernet0')!.l3.ipv4).toBeUndefined();
    expect(exec(sim, session, 'ipconfig').output).toContain('IPv4 address ........: not set');
  });

  it('ipconfig /renew blocks, and ^C ends the wait', () => {
    const { sim, session } = lab();
    exec(sim, session, 'ip address dhcp');
    sim.runToIdle();
    // The server is unplugged, so the renew has nobody to answer it and the session stays busy.
    sim.setPower('r1', false);
    sim.runToIdle();
    const renew = exec(sim, session, 'ipconfig /renew');
    expect(renew.busy).toBe(true);
    expect(sim.cli.session(session)!.job).toEqual({ process: 'dhcp-client', label: 'ipconfig' });

    const cursor = sim.trace(0).next;
    sim.cli.interrupt(session);
    expect(sim.cli.session(session)!.busy).toBe(false);
    expect(since(sim, session, cursor).length).toBeGreaterThan(0);
    // The session takes commands again straight away.
    expect(exec(sim, session, 'ipconfig').output).toContain('GigabitEthernet0');
  });

  it('/renew and /release need an adapter that takes its address from DHCP', () => {
    const { sim, session } = lab();
    const r = sim.cli.exec(session, 'ipconfig /renew');
    expect(r.error?.message).toMatch(/No adapter of this host takes its address from DHCP/);
    expect(r.busy).toBe(false);
  });
});

describe('host shell: names, paths and sockets', () => {
  it('nslookup asks the name server and prints what it answered', () => {
    const { sim, session } = lab();
    const cursor = sim.trace(0).next;
    // The name server is named explicitly: PC1 keeps its static address here, so it has learnt none from DHCP.
    const r = exec(sim, session, 'nslookup www.lab.nf 10.0.0.254');
    expect(r.busy).toBe(true);
    expect(sim.cli.session(session)!.job).toEqual({ process: 'dns-client', label: 'nslookup' });
    sim.runToIdle();
    const text = since(sim, session, cursor);
    expect(text).toContain('www.lab.nf');
    expect(text).toContain('10.0.1.1');
    expect(sim.cli.session(session)!.busy).toBe(false);
    // The answer is cached, and `show hosts` reads that cache.
    expect(exec(sim, session, 'show hosts').output).toContain('www.lab.nf');
  });

  it('tracert walks the path with echo probes and ends the job', () => {
    const { sim, session } = lab();
    const cursor = sim.trace(0).next;
    const r = exec(sim, session, 'tracert 10.0.1.1');
    expect(r.busy).toBe(true);
    expect(sim.cli.session(session)!.job).toEqual({ process: 'traceroute', label: 'trace' });
    sim.runToIdle();
    const text = since(sim, session, cursor);
    expect(text).toContain('10.0.1.1');
    expect(text).toMatch(/\s1\s/);
    expect(sim.cli.session(session)!.busy).toBe(false);
  });

  it('ping takes a name, resolves it through dns-client and pings the first address', () => {
    // ARCHITECTURE-P1 §10.2 accept.p1.host-shell types `ping www.lab.nf`; §4.8: the FIRST address only.
    const { sim, session } = lab();
    exec(sim, session, 'ip dns 10.0.0.254');
    const cursor = sim.trace(0).next;
    const r = exec(sim, session, 'ping www.lab.nf');
    expect(r.busy).toBe(true);
    sim.runToIdle();
    const text = since(sim, session, cursor);
    expect(text).toContain('Sending 5 echo requests to 10.0.1.1');
    expect(text).toMatch(/Sent 5, received 5, lost 0 \(0% loss\)/);
    expect(sim.cli.session(session)!.busy).toBe(false);
    // the query really went to the name server, and the answer is in the resolver cache
    expect(exec(sim, session, 'show hosts').output).toContain('www.lab.nf');
  });

  it('a ping of a name nothing answers ends with one original line', () => {
    const { sim, session } = lab();
    exec(sim, session, 'ip dns 10.0.0.254');
    const cursor = sim.trace(0).next;
    expect(sim.cli.exec(session, 'ping nowhere.lab.nf').busy).toBe(true);
    sim.runToIdle();
    expect(since(sim, session, cursor)).toContain('Cannot resolve nowhere.lab.nf');
    expect(sim.cli.session(session)!.busy).toBe(false);
  });

  it('netstat lists the sockets the daemons opened', () => {
    const { sim, session } = lab();
    exec(sim, session, 'ip address dhcp');
    sim.runToIdle();
    const out = exec(sim, session, 'netstat').output;
    expect(out).toMatch(/^Proto\s+Local address\s+Remote address\s+State\s+Owner\s+Interface$/m);
    expect(out).toContain('dhcp-client');
    expect(out).toContain(':68');
    const rows = sim.device('pc1')!.tables.get?.('sockets')?.rows() ?? [];
    expect(rows.length).toBeGreaterThan(0);
    // §10.2 accept.p1.host-shell types `netstat -an`: the option letters are accepted and the same table printed.
    expect(exec(sim, session, 'netstat -an').output).toBe(out);
  });
});

describe('host shell: IPv6', () => {
  it('ipv6 address enables IPv6 and ipv6config reports the addresses and neighbours', () => {
    const { sim, session } = lab();
    expect(exec(sim, session, 'ipv6 address 2001:db8::5/64').output).toContain('2001:db8::5/64');
    sim.runToIdle();

    const port = sim.device('pc1')!.port('GigabitEthernet0')!;
    expect(port.l3.ipv6Enabled).toBe(true);
    expect((port.l3.ipv6 ?? []).map((a) => a.address)).toContain('2001:db8::5');

    const out = exec(sim, session, 'ipv6config').output;
    expect(out).toContain('GigabitEthernet0');
    expect(out).toContain('IPv6 enabled');
    expect(out).toContain('2001:db8::5/64');
    expect(out).toContain('Default router ......:');
    // The running config carries the canonical §6 lines, not a host-only form.
    const text = sim.device('pc1')!.running.render();
    expect(text).toContain(' ipv6 enable');
    expect(text).toContain(' ipv6 address 2001:db8::5/64');
  });

  it('ipv6 autoconfig writes the autoconfig line and ping -6 is available', () => {
    const { sim, session } = lab();
    expect(exec(sim, session, 'ipv6 autoconfig').output).toMatch(/listening for a router advertisement/);
    sim.runToIdle();
    expect(sim.device('pc1')!.running.render()).toContain(' ipv6 address autoconfig');
    // `ping -6` reaches the icmpv6 job; with no IPv6 route it answers at once, so the session comes back free.
    const cursor = sim.trace(0).next;
    const r = sim.cli.exec(session, 'ping -6 2001:db8::9');
    expect(r.error).toBeUndefined();
    sim.runToIdle();
    expect(sim.cli.session(session)!.busy).toBe(false);
    expect(since(sim, session, cursor).length).toBeGreaterThan(0);
  });
});
