/**
 * P1 acceptance — DHCP DORA (ARCHITECTURE-P1 §10.2 `accept.p1.dhcp-dora`; §4.3, §4.2 RIB arbitration).
 *
 * A student cables PC1 to a switch and the switch to R1, gives R1 the pool LAN and types `ip address dhcp` on PC1.
 * Nothing is faked: the world is the real catalog with its P1 daemons, the pool is typed through R1's own CLI, and
 * every assertion reads what the daemons produced — the four PDUs on the wire with their decoded layers, the
 * address the lease put on the port, the RIB rows, the binding table and the ping the lease made possible.
 *
 * Also here: the `ip default-gateway` arbitration (S beats D, withdrawing it restores D), the relay form
 * (giaddr + hops), the APIPA fallback with its ARP probes and terminating run, and two concurrent clients whose
 * transaction ids and sockets are drawn per interface.
 *
 * ponytail: one `lan()` world serves most cases; the relay and APIPA variants build their own, smaller worlds.
 */
import { describe, expect, it } from 'vitest';
import type { PduView } from '../src/contracts/pdu.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { DhcpBindingRow, RouteRow, SocketRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createSimulation } from '../src/sim/simulation.js';
import { cable, device, topology } from './accept.p05.harness.js';
import { ofKind, ping } from './sim.harness.js';

const PC_PORT = 'GigabitEthernet0';
const G0 = 'GigabitEthernet0/0';
const G1 = 'GigabitEthernet0/1';
/** Long enough for every model to boot (router 45 s) and for the links to settle. */
const BOOT = 60 * SEC;

/** R1 as the LAN's address server: Gi0/0 on 192.168.1.1/24, pool LAN with .1 kept back. */
const R1_SERVICES: readonly string[] = [
  'interface GigabitEthernet0/0',
  'ip address 192.168.1.1 255.255.255.0',
  'no shutdown',
  'exit',
  'ip dhcp excluded-address 192.168.1.1',
  'ip dhcp pool LAN',
  'network 192.168.1.0 255.255.255.0',
  'default-router 192.168.1.1',
  'dns-server 192.168.1.10',
  'exit',
];

/** Apply `lines` through the headless validator; a line that fails is a test bug. */
function configured(sim: Simulation, dev: string, lines: readonly string[]): void {
  const r = sim.configure(dev, lines);
  if (!r.ok) throw new Error(`${dev} setup failed: ${JSON.stringify(r.lines.filter((l) => !l.ok))}`);
}

/** PC1 – SW1 – R1, booted, with `extra` devices and cables added before boot. */
function world(seed = 5, extra: { devices?: ReturnType<typeof device>[]; links?: ReturnType<typeof cable>[] } = {}): Simulation {
  const sim = createSimulation({ seed });
  sim.loadTopology(
    topology(
      [
        device('pc1', 'pc.nfpc', 'PC1', 100, 300),
        device('sw1', 'switch.nfc2960', 'SW1', 300, 200),
        device('r1', 'router.nf2911', 'R1', 500, 120),
        ...(extra.devices ?? []),
      ],
      [
        cable('l_pc1_sw1', 'pc1', PC_PORT, 'sw1', 'FastEthernet0/1'),
        cable('l_sw1_r1', 'sw1', 'GigabitEthernet0/1', 'r1', G0),
        ...(extra.links ?? []),
      ],
    ),
  );
  sim.runFor(BOOT);
  return sim;
}

/** The booted lab with R1 serving the pool and PC1 asking for an address; run to idle. */
function lan(seed = 5): Simulation {
  const sim = world(seed);
  configured(sim, 'r1', R1_SERVICES);
  configured(sim, 'pc1', ['ip address dhcp']);
  sim.runToIdle();
  return sim;
}

/** Every DHCP PDU a device created, in creation order, as `{ tag, pdu }`. */
function dhcpPdus(sim: Simulation, evs: readonly TraceEvent[]): { tag: string; device: string; pdu: PduView }[] {
  return ofKind(evs, 'pduCreated')
    .filter((e) => (e.pdu.tag ?? '').startsWith('dhcp-'))
    .map((e) => ({ tag: e.pdu.tag!, device: e.device, pdu: sim.pdu(e.pdu.id)! }));
}

/** The decoded endpoint of a DHCP PDU: `src:srcPort > dst:dstPort`. */
function endpoints(pdu: PduView): string {
  return `${String(pdu.get('ipv4.src'))}:${String(pdu.get('udp.srcPort'))} > ${String(pdu.get('ipv4.dst'))}:${String(pdu.get('udp.dstPort'))}`;
}

const rib = (sim: Simulation, dev: string): RouteRow[] => sim.device(dev)!.tables.rib.rows();
const sockets = (sim: Simulation, dev: string): SocketRow[] => sim.device(dev)!.tables.get<SocketRow>('sockets')?.rows() ?? [];
const bindings = (sim: Simulation, dev: string): DhcpBindingRow[] => sim.device(dev)!.tables.get<DhcpBindingRow>('dhcp-bindings')?.rows() ?? [];

describe('accept P1: DHCP DORA', () => {
  it('exchanges exactly DISCOVER, OFFER, REQUEST and ACK, each triggered by the one before it', () => {
    const sim = lan();
    const flight = dhcpPdus(sim, sim.trace(0).events);
    expect(flight.map((f) => f.tag)).toEqual(['dhcp-discover', 'dhcp-offer', 'dhcp-request', 'dhcp-ack']);
    expect(flight.map((f) => f.device)).toEqual(['pc1', 'r1', 'pc1', 'r1']);
    expect(flight.map((f) => String(f.pdu.get('dhcp.messageType')))).toEqual(['DISCOVER', 'OFFER', 'REQUEST', 'ACK']);

    const [discover, offer, request, ack] = flight.map((f) => f.pdu);
    expect(endpoints(discover!)).toBe('0.0.0.0:68 > 255.255.255.255:67');
    expect(endpoints(offer!)).toBe('192.168.1.1:67 > 255.255.255.255:68');
    expect(endpoints(request!)).toBe('0.0.0.0:68 > 255.255.255.255:67');
    expect(endpoints(ack!)).toBe('192.168.1.1:67 > 255.255.255.255:68');

    // The chain the provenance panel draws: every message names the one that caused it.
    expect(offer!.meta.triggeredBy).toBe(discover!.id);
    expect(request!.meta.triggeredBy).toBe(offer!.id);
    expect(ack!.meta.triggeredBy).toBe(request!.id);

    const mac = sim.device('pc1')!.port(PC_PORT)!.mac;
    for (const f of flight) expect(f.pdu.get('dhcp.chaddr')).toBe(mac);
    expect(offer!.get('dhcp.yiaddr')).toBe('192.168.1.2');
    expect(request!.get('dhcp.requestedIp')).toBe('192.168.1.2');
    expect(request!.get('dhcp.serverId')).toBe('192.168.1.1');
    expect(ack!.get('dhcp.yiaddr')).toBe('192.168.1.2');
    expect(ack!.get('dhcp.subnetMask')).toBe('255.255.255.0');
    expect(ack!.get('dhcp.router')).toBe('192.168.1.1');
    expect(ack!.get('dhcp.dnsServers')).toBe('192.168.1.10');
  });

  it('binds the lease on PC1, installs C, L and the DHCP default, and keeps one bound binding on R1', () => {
    const sim = lan();
    expect(sim.device('pc1')!.port(PC_PORT)!.l3.ipv4).toMatchObject({ address: '192.168.1.2', prefixLen: 24, origin: 'dhcp' });

    expect(rib(sim, 'pc1').map((r) => `${r.source} ${r.network}/${r.prefixLen} ad${r.ad} ${r.nextHop ?? '-'}`).sort()).toEqual([
      'C 192.168.1.0/24 ad0 -',
      'D 0.0.0.0/0 ad254 192.168.1.1',
      'L 192.168.1.2/32 ad0 -',
    ]);

    const rows = bindings(sim, 'r1');
    expect(rows.map((b) => [b.ip, b.state, b.pool, b.mac])).toEqual([['192.168.1.2', 'bound', 'LAN', sim.device('pc1')!.port(PC_PORT)!.mac]]);

    expect(ping(sim, 'pc1', '192.168.1.1').text).toContain('Sent 5, received 5, lost 0');
  });

  it('lets a typed default gateway replace the DHCP default, and restores it when the line goes', () => {
    const sim = lan();
    const defaults = (): string[] => rib(sim, 'pc1').filter((r) => r.prefixLen === 0).map((r) => `${r.source} ${r.nextHop ?? '-'} ad${r.ad}`);
    expect(defaults()).toEqual(['D 192.168.1.1 ad254']);

    // `ip default-gateway` is a configuration line of the host, applied the way a startup config applies it.
    expect(sim.device('pc1')!.applyConfigLine([], ['ip', 'default-gateway', '192.168.1.254'], false).ok).toBe(true);
    sim.runToIdle();
    expect(defaults()).toEqual(['S 192.168.1.254 ad1']);
    expect(sim.device('pc1')!.port(PC_PORT)!.l3.ipv4?.origin).toBe('dhcp');

    expect(sim.device('pc1')!.applyConfigLine([], ['ip', 'default-gateway', '192.168.1.254'], true).ok).toBe(true);
    sim.runToIdle();
    expect(defaults()).toEqual(['D 192.168.1.1 ad254']);
  });

  it('relays a request through a router that has no pool, stamping giaddr and one hop', () => {
    const sim = world(5, {
      devices: [device('srv1', 'router.nf2911', 'SRV1', 700, 120)],
      links: [cable('l_r1_srv1', 'r1', G1, 'srv1', G0)],
    });
    configured(sim, 'r1', [
      'interface GigabitEthernet0/0',
      'ip address 192.168.1.1 255.255.255.0',
      'ip helper-address 10.0.0.10',
      'no shutdown',
      'exit',
      'interface GigabitEthernet0/1',
      'ip address 10.0.0.1 255.255.255.0',
      'no shutdown',
      'exit',
    ]);
    configured(sim, 'srv1', [
      'interface GigabitEthernet0/0',
      'ip address 10.0.0.10 255.255.255.0',
      'no shutdown',
      'exit',
      'ip route 192.168.1.0 255.255.255.0 10.0.0.1',
      'ip dhcp excluded-address 192.168.1.1',
      'ip dhcp pool LAN',
      'network 192.168.1.0 255.255.255.0',
      'default-router 192.168.1.1',
      'exit',
    ]);
    configured(sim, 'pc1', ['ip address dhcp']);
    sim.runToIdle();

    const flight = dhcpPdus(sim, sim.trace(0).events);
    const relayed = flight.filter((f) => f.device === 'r1');
    expect(relayed.length).toBeGreaterThan(0);
    for (const f of relayed) expect(f.pdu.get('dhcp.giaddr')).toBe('192.168.1.1');
    // The client's own messages, carried towards the server, count the hop they took.
    const towardsServer = relayed.filter((f) => f.pdu.get('dhcp.op') === 1);
    expect(towardsServer.length).toBeGreaterThan(0);
    for (const f of towardsServer) expect(f.pdu.get('dhcp.hops')).toBe(1);
    // The relayed DISCOVER is a new PDU that names the client's broadcast as its cause.
    const client = flight.find((f) => f.device === 'pc1' && f.tag === 'dhcp-discover')!;
    const forwarded = relayed.find((f) => String(f.pdu.get('dhcp.messageType')) === 'DISCOVER')!;
    expect(forwarded.pdu.id).not.toBe(client.pdu.id);
    expect(forwarded.pdu.meta.triggeredBy).toBe(client.pdu.id);
    expect(String(forwarded.pdu.get('ipv4.dst'))).toBe('10.0.0.10');

    expect(sim.device('pc1')!.port(PC_PORT)!.l3.ipv4).toMatchObject({ address: '192.168.1.2', prefixLen: 24, origin: 'dhcp' });
    expect(bindings(sim, 'srv1').map((b) => [b.ip, b.state, b.relay])).toEqual([['192.168.1.2', 'bound', '192.168.1.1']]);
  });

  it('falls back to a probed link-local address when nothing answers, and the run still settles', () => {
    // No server on the segment: PC1 asks four times, then claims a 169.254 address it has probed for.
    const sim = world(5);
    configured(sim, 'pc1', ['ip address dhcp']);
    const stats = sim.runToIdle(200_000);
    expect(stats.stopped).toBeUndefined();

    const evs = sim.trace(0).events;
    const discovers = dhcpPdus(sim, evs).filter((f) => f.tag === 'dhcp-discover');
    expect(discovers.length).toBeGreaterThanOrEqual(4);
    const probes = ofKind(evs, 'pduCreated').filter((e) => e.device === 'pc1' && e.pdu.tag === 'arp-probe');
    expect(probes.length).toBeGreaterThanOrEqual(3);

    const leased = sim.device('pc1')!.port(PC_PORT)!.l3.ipv4;
    expect(leased?.origin).toBe('apipa');
    expect(leased?.prefixLen).toBe(16);
    expect(leased?.address).toMatch(/^169\.254\.\d+\.\d+$/);

    // Only the periodic maintenance timers are left: nothing one-shot is still pending.
    expect(sim.nextEventTime()).toBeDefined();
    const again = sim.runToIdle(200_000);
    expect(again.stopped).toBeUndefined();
  });

  it('draws a transaction id and a socket per interface, so two clients on one device never collide', () => {
    // R2 takes an address on both of its interfaces at once, one from each pool of R1.
    const sim = createSimulation({ seed: 5 });
    sim.loadTopology(
      topology(
        [device('r1', 'router.nf2911', 'R1', 200, 120), device('r2', 'router.nf2911', 'R2', 500, 120)],
        [cable('l_a', 'r1', G0, 'r2', G0), cable('l_b', 'r1', G1, 'r2', G1)],
      ),
    );
    sim.runFor(BOOT);
    configured(sim, 'r1', [
      'interface GigabitEthernet0/0',
      'ip address 192.168.1.1 255.255.255.0',
      'no shutdown',
      'exit',
      'interface GigabitEthernet0/1',
      'ip address 192.168.2.1 255.255.255.0',
      'no shutdown',
      'exit',
      'ip dhcp excluded-address 192.168.1.1',
      'ip dhcp excluded-address 192.168.2.1',
      'ip dhcp pool LAN1',
      'network 192.168.1.0 255.255.255.0',
      'exit',
      'ip dhcp pool LAN2',
      'network 192.168.2.0 255.255.255.0',
      'exit',
    ]);
    configured(sim, 'r2', [
      'interface GigabitEthernet0/0',
      'ip address dhcp',
      'no shutdown',
      'exit',
      'interface GigabitEthernet0/1',
      'ip address dhcp',
      'no shutdown',
      'exit',
    ]);
    sim.runToIdle();

    const xids = new Set(dhcpPdus(sim, sim.trace(0).events).filter((f) => f.device === 'r2').map((f) => Number(f.pdu.get('dhcp.xid'))));
    expect(xids.size).toBe(2);

    const clientSockets = sockets(sim, 'r2').filter((s) => s.owner === 'dhcp-client');
    expect(clientSockets.map((s) => s.id).sort()).toEqual([`dhcp-client#${G0}`, `dhcp-client#${G1}`]);
    expect(new Set(clientSockets.map((s) => s.iface)).size).toBe(2);

    expect(sim.device('r2')!.port(G0)!.l3.ipv4).toMatchObject({ address: '192.168.1.2', origin: 'dhcp' });
    expect(sim.device('r2')!.port(G1)!.l3.ipv4).toMatchObject({ address: '192.168.2.2', origin: 'dhcp' });
  });
});
