/**
 * app.dns.dual-stack.test.ts — dns-client's learned servers keyed by (iface, family) (protocols/dns-client.ts;
 * ARCHITECTURE-P2 §2.5 consumer rule, §13 #47, §7 W3 svc): a DHCPv4 lease and a stateless DHCPv6 lease on one
 * interface list both servers, IPv4 first; a lease replaces only its own family's list; a v4 release keeps the v6
 * server and a v6 loss keeps the v4 one. Unit level on the ip6.harness bus (events), then end to end on a real
 * P2-stage world with the real dhcp-client, dhcp-server, dhcpv6-client and dhcpv6-server.
 */
import { describe, expect, it } from 'vitest';
import type { ProcessName } from '../src/contracts/ids.js';
import type { ProcessFactory } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { LeaseEvent } from '../src/contracts/transport.js';
import { createDhcpv6Client } from '../src/protocols/dhcpv6-client.js';
import { createDhcpv6Server } from '../src/protocols/dhcpv6-server.js';
import { createDnsClient } from '../src/protocols/dns-client.js';
import { createUdp } from '../src/protocols/udp.js';
import { configText, section } from '../src/sim/scenarios/kit.js';
import { BOOT_NS, createWorld6, type World6 } from './ip6.harness.js';
import { P2_DAEMONS, createP2Simulation, type P2FactoryOverlay } from './p2.world.js';
import { ofKind } from './sim.harness.js';

const PC = 'GigabitEthernet0';
const G0 = 'GigabitEthernet0/0';
const DNS4 = '192.168.1.53';
const DNS4B = '192.168.1.54';
const DNS6 = '2001:db8:1::53';
const DNS6B = '2001:db8:1::54';

describe('app.dns.dual-stack learned servers by (iface, family)', () => {
  function pc(): World6 {
    const w = createWorld6({ seed: 4, extra: { udp: createUdp, 'dns-client': createDnsClient } });
    w.add('pc1', 'pc');
    w.runFor(BOOT_NS);
    return w;
  }
  const servers = (w: World6): unknown => w.dev('pc1').processes.get('dns-client')!.stateSnapshot().state.servers;
  const lease = (w: World6, ev: LeaseEvent): void => w.act('pc1', 'dhcp-client', [{ type: 'event', to: 'dns-client', ev }]);
  const debugText = (w: World6): string[] => w.kinds('debug').filter((e) => e.event.process === 'dns-client').map((e) => e.event.message);

  it('lists the IPv4 list, then the IPv6 list; each family replaces only its own list', () => {
    const w = pc();
    lease(w, { kind: 'dhcp.lease', iface: PC, op: 'bound', dnsServers: [DNS4] });
    expect(servers(w)).toEqual([DNS4]);
    lease(w, { kind: 'dhcp.lease', family: 6, iface: PC, op: 'bound', dnsServers: [DNS6], domainName: 'lab.nf' });
    expect(servers(w)).toEqual([DNS4, DNS6]);
    // a v6 renewal with another server replaces the v6 list only
    lease(w, { kind: 'dhcp.lease', family: 6, iface: PC, op: 'renewed', dnsServers: [DNS6B] });
    expect(servers(w)).toEqual([DNS4, DNS6B]);
    // a v4 renewal replaces the v4 list only, and the order stays v4 first
    lease(w, { kind: 'dhcp.lease', iface: PC, op: 'renewed', dnsServers: [DNS4B, DNS4] });
    expect(servers(w)).toEqual([DNS4B, DNS4, DNS6B]);
    // the v4-only debug text is unchanged; the v6 one names DHCPv6
    expect(debugText(w)).toContain(`${PC}: DHCP bound, DNS servers ${DNS4}`);
    expect(debugText(w)).toContain(`${PC}: DHCPv6 bound, DNS servers ${DNS6}`);
  });

  it("'lost' removes only its family's list: a v4 release keeps the v6 server, a v6 loss keeps the v4 one", () => {
    const w = pc();
    lease(w, { kind: 'dhcp.lease', iface: PC, op: 'bound', dnsServers: [DNS4] });
    lease(w, { kind: 'dhcp.lease', family: 6, iface: PC, op: 'bound', dnsServers: [DNS6] });
    lease(w, { kind: 'dhcp.lease', iface: PC, op: 'lost', dnsServers: [] });
    expect(servers(w)).toEqual([DNS6]);
    lease(w, { kind: 'dhcp.lease', iface: PC, op: 'bound', dnsServers: [DNS4] });
    expect(servers(w)).toEqual([DNS4, DNS6]);
    lease(w, { kind: 'dhcp.lease', family: 6, iface: PC, op: 'lost', dnsServers: [] });
    expect(servers(w)).toEqual([DNS4]);
    // `ip name-server` stays ahead of every learned list
    w.global('pc1', `ip name-server 10.0.0.53`);
    lease(w, { kind: 'dhcp.lease', family: 6, iface: PC, op: 'bound', dnsServers: [DNS6] });
    expect(servers(w)).toEqual(['10.0.0.53', DNS4, DNS6]);
  });
});

describe('app.dns.dual-stack end to end (DHCPv4 plus stateless DHCPv6)', () => {
  function svcOnly(): P2FactoryOverlay {
    const out: Record<ProcessName, ProcessFactory | undefined> = {};
    for (const p of P2_DAEMONS) out[p] = undefined;
    out['dhcpv6-client'] = createDhcpv6Client;
    out['dhcpv6-server'] = createDhcpv6Server;
    return out;
  }

  /** PC1 (ip address dhcp, ipv6 address autoconfig) — R1 with a DHCPv4 pool and a stateless DHCPv6 pool (O = 1). */
  function lab(): Simulation {
    const sim = createP2Simulation({ seed: 12, factories: svcOnly() });
    sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: configText([['hostname PC1'], section(`interface ${PC}`, ['ip address dhcp', 'ipv6 address autoconfig'])]) });
    sim.addDevice({
      id: 'r1', type: 'router.nf2911', name: 'R1',
      startupConfig: configText([
        ['hostname R1', 'ipv6 unicast-routing', 'ip dhcp excluded-address 192.168.1.1 192.168.1.9'],
        section('ip dhcp pool LAN4', ['network 192.168.1.0 255.255.255.0', 'default-router 192.168.1.1', `dns-server ${DNS4}`, 'domain-name lab.nf']),
        section('ipv6 dhcp pool LAN6', [`dns-server ${DNS6}`, 'domain-name lab.nf']),
        section(`interface ${G0}`, ['ip address 192.168.1.1 255.255.255.0', 'ipv6 address 2001:db8:1::1/64', 'ipv6 dhcp server LAN6', 'ipv6 nd other-config-flag', 'no shutdown']),
      ]),
    });
    sim.addLink({ id: 'l', a: { device: 'pc1', port: PC }, b: { device: 'r1', port: G0 } });
    sim.runFor(90 * SEC);
    return sim;
  }
  const servers = (sim: Simulation): unknown => sim.device('pc1')!.processes.get('dns-client')!.stateSnapshot().state.servers;

  it('lists both learned servers, IPv4 first; a v4 release keeps the v6 server', () => {
    const sim = lab();
    expect(sim.device('pc1')!.port(PC)!.l3.ipv4).toMatchObject({ address: '192.168.1.10', origin: 'dhcp' });
    const tags = ofKind(sim.trace(0).events, 'pduCreated').filter((e) => e.device === 'pc1' && (e.pdu.tag?.startsWith('dhcp-') || e.pdu.tag?.startsWith('dhcpv6-'))).map((e) => e.pdu.tag);
    expect(tags).toContain('dhcp-request');
    expect(tags).toContain('dhcpv6-inforeq');
    expect(servers(sim)).toEqual([DNS4, DNS6]);
    sim.hostRequest('pc1', { app: 'dhcp.release', port: PC });
    sim.runFor(2 * SEC);
    expect(sim.device('pc1')!.port(PC)!.l3.ipv4).toBeUndefined();
    expect(servers(sim)).toEqual([DNS6]);
    // the resolver keeps working over the remaining server list (nothing answers here, so the query goes to v6)
    sim.hostRequest('pc1', { app: 'dhcp.renew', port: PC });
    sim.runFor(10 * SEC);
    expect(servers(sim)).toEqual([DNS4, DNS6]);
  });
});
