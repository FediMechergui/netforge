/**
 * wan.gre [S18] — the tunnel owner in GRE mode on `staged.world` (ARCHITECTURE-P3 D17, D15, D8, §2.6 `TunnelRow`,
 * §3.10, §4.3; §7 W2 wan): the underlay evaluation with the lpm watch, the `tunnels` row and `virtualChanged`, the
 * head and tail rewraps (one PduId end to end), the D15 fallback (`mtu-exceeded`, ICMP 3/4 with the next-hop MTU when
 * DF is set) and `ip tcp adjust-mss`.
 *
 * §3.10's world: PC1 — R1 Gi0/0; R1 Se0/0/0 209.165.200.225/30 — ISP — R2 Se0/0/0 209.165.200.230/30; R2 Gi0/0 — PC2.
 * The ISP has no private routes. A test-only frame injector (test/inject.ts) on R1 Gi0/1 (192.168.3.0/24) supplies
 * the packets no host sends: a 1500-byte DF datagram, and a TCP SYN with an MSS option.
 */
import { describe, expect, it } from 'vitest';
import type { LayerSpec } from '../src/contracts/pdu.js';
import { ETHERTYPE_IPV4, IPPROTO_ICMP, IPPROTO_TCP } from '../src/contracts/pdu.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { MS, SEC } from '../src/contracts/time.js';
import type { EigrpNeighborRow, TunnelRow } from '../src/contracts/tables.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createEigrp } from '../src/protocols/eigrp.js';
import { createGre, greMtuDetail } from '../src/protocols/gre.js';
import { INJECTOR_HOST_TYPE, injectFrames, withInjector } from './inject.js';
import { ping } from './sim.harness.js';
import { createStagedSimulation } from './staged.world.js';

const TU0 = 'Tunnel0';
const SE0 = 'Serial0/0/0';
const SE1 = 'Serial0/0/1';
const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';
const MASK30 = '255.255.255.252';
const MASK24 = '255.255.255.0';

function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

interface GreWorldOptions {
  /** R1's Tunnel0 section body (default: address, source and destination). */
  readonly r1Tunnel?: readonly string[];
  readonly r2Tunnel?: readonly string[];
  /** [C1] EIGRP over the tunnel instead of the static routes through it (both routers: the tunnel and LAN networks). */
  readonly eigrp?: boolean;
}

const R1_TUNNEL = [` ip address 172.16.0.1 ${MASK30}`, ` tunnel source ${SE0}`, ' tunnel destination 209.165.200.230'];
const R2_TUNNEL = [` ip address 172.16.0.2 ${MASK30}`, ` tunnel source ${SE0}`, ' tunnel destination 209.165.200.225'];

/** The §3.10 world plus the injector on R1 Gi0/1, run to idle. */
function greWorld(opts: GreWorldOptions = {}): Simulation {
  const sim = createStagedSimulation({ seed: 18, stage: 'P3', factories: withInjector(opts.eigrp === true ? { gre: createGre, eigrp: createEigrp } : { gre: createGre }) });
  const eigrp = (lan: string): string[][] => (opts.eigrp === true ? [['router eigrp 100', ' network 172.16.0.0 0.0.0.3', ` network ${lan} 0.0.0.255`]] : []);
  sim.addDevice({
    id: 'r1', type: 'router.nf2911', name: 'R1',
    startupConfig: startup([
      ['hostname R1'],
      [`interface ${GI0}`, ` ip address 192.168.1.1 ${MASK24}`, ' no shutdown'],
      [`interface ${GI1}`, ` ip address 192.168.3.1 ${MASK24}`, ' no shutdown'],
      [`interface ${SE0}`, ` ip address 209.165.200.225 ${MASK30}`, ' no shutdown'],
      [`interface ${TU0}`, ...(opts.r1Tunnel ?? R1_TUNNEL)],
      opts.eigrp === true ? ['ip route 0.0.0.0 0.0.0.0 209.165.200.226'] : ['ip route 0.0.0.0 0.0.0.0 209.165.200.226', `ip route 192.168.2.0 ${MASK24} 172.16.0.2`],
      ...eigrp('192.168.1.0'),
    ]),
  });
  sim.addDevice({
    id: 'isp', type: 'router.nf2911', name: 'ISP',
    startupConfig: startup([
      ['hostname ISP'],
      [`interface ${SE0}`, ` ip address 209.165.200.226 ${MASK30}`, ' clock rate 2000000', ' no shutdown'],
      [`interface ${SE1}`, ` ip address 209.165.200.229 ${MASK30}`, ' clock rate 2000000', ' no shutdown'],
    ]),
  });
  sim.addDevice({
    id: 'r2', type: 'router.nf2911', name: 'R2',
    startupConfig: startup([
      ['hostname R2'],
      [`interface ${GI0}`, ` ip address 192.168.2.1 ${MASK24}`, ' no shutdown'],
      [`interface ${SE0}`, ` ip address 209.165.200.230 ${MASK30}`, ' no shutdown'],
      [`interface ${TU0}`, ...(opts.r2Tunnel ?? R2_TUNNEL)],
      opts.eigrp === true
        ? ['ip route 0.0.0.0 0.0.0.0 209.165.200.229']
        : ['ip route 0.0.0.0 0.0.0.0 209.165.200.229', `ip route 192.168.1.0 ${MASK24} 172.16.0.1`, `ip route 192.168.3.0 ${MASK24} 172.16.0.1`],
      ...eigrp('192.168.2.0'),
    ]),
  });
  const pc = (name: string, addr: string, gw: string): string =>
    startup([[`hostname ${name}`], ['interface GigabitEthernet0', ` ip address ${addr} ${MASK24}`], [`ip default-gateway ${gw}`]]);
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: pc('PC1', '192.168.1.10', '192.168.1.1') });
  sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: pc('PC2', '192.168.2.10', '192.168.2.1') });
  sim.addDevice({ id: 'inj', type: INJECTOR_HOST_TYPE, name: 'INJ' });
  sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'r1', port: GI0 } });
  sim.addLink({ a: { device: 'inj', port: 'GigabitEthernet0' }, b: { device: 'r1', port: GI1 } });
  sim.addLink({ a: { device: 'r1', port: SE0 }, b: { device: 'isp', port: SE0 }, dceEnd: 'b' });
  sim.addLink({ a: { device: 'isp', port: SE1 }, b: { device: 'r2', port: SE0 }, dceEnd: 'a' });
  sim.addLink({ a: { device: 'r2', port: GI0 }, b: { device: 'pc2', port: 'GigabitEthernet0' } });
  sim.runToIdle();
  return sim;
}

const tunnelRow = (sim: Simulation, device: string): TunnelRow | undefined => sim.device(device)!.tables.get<TunnelRow>('tunnels')?.get(TU0);
const tunnelUp = (sim: Simulation, device: string): boolean => sim.device(device)!.port(TU0)!.operUp;

/** Apply one stored line on `device` at `sim.now` (the device clock synced first, as the facade does), then run to idle. */
function line(sim: Simulation, device: string, context: string[][], tokens: string[], negate = false): TraceEvent[] {
  const cursor = sim.trace(0).next;
  const d = sim.device(device)!;
  d.applyActions('sim', [], sim.now);
  expect(d.applyConfigLine(context, tokens, negate)).toEqual({ ok: true });
  const stats = sim.runToIdle();
  expect(stats.stopped).toBeUndefined();
  return sim.trace(cursor).events;
}

type Mut = { device: string; reason: string; field: string; before: unknown; after: unknown; cause?: string };

describe('wan.gre [S18]: the underlay evaluation and the tunnels row (§3.10 step 1)', () => {
  it('source, destination and the default route bring the row up; virtualChanged brings Tunnel0 up; C and the static follow', () => {
    const sim = greWorld();
    expect(tunnelRow(sim, 'r1')).toEqual({
      key: TU0,
      port: TU0,
      mode: 'gre',
      source: '209.165.200.225',
      sourceIface: SE0,
      destination: '209.165.200.230',
      state: 'up',
      transportMtu: 1500,
      ipMtu: 1476,
      since: expect.any(Number),
      updatedAt: expect.any(Number),
    });
    expect(tunnelRow(sim, 'r2')).toMatchObject({ source: '209.165.200.230', destination: '209.165.200.225', state: 'up', ipMtu: 1476 });
    expect(tunnelUp(sim, 'r1')).toBe(true);
    const rib = sim.device('r1')!.tables.rib;
    expect(rib.get('172.16.0.0/30')).toMatchObject({ source: 'C', iface: TU0 });
    expect(rib.get('192.168.2.0/24')).toMatchObject({ source: 'S', nextHop: '172.16.0.2' });
    // the ISP never learns a private route
    expect(sim.device('isp')!.tables.rib.rows().filter((r) => r.network.startsWith('192.168.') || r.network.startsWith('172.16.'))).toEqual([]);
    // the gre StateView
    expect(sim.device('r1')!.stateSnapshots().find((v) => v.process === 'gre')!.state).toMatchObject({ tunnels: [{ port: TU0, mode: 'gre', state: 'up' }] });
  });

  it('step by step: interface Tunnel0 alone is down no-source, then no-destination, then up', () => {
    const sim = greWorld({ r1Tunnel: [` ip address 172.16.0.1 ${MASK30}`] });
    expect(tunnelRow(sim, 'r1')).toMatchObject({ state: 'down', reason: 'no-source', transportMtu: 1500, ipMtu: 1476 });
    expect(tunnelUp(sim, 'r1')).toBe(false);
    let evs = line(sim, 'r1', [['interface', TU0]], ['tunnel', 'source', SE0]);
    expect(tunnelRow(sim, 'r1')).toMatchObject({ state: 'down', reason: 'no-destination', source: '209.165.200.225', sourceIface: SE0 });
    expect(evs.filter((e) => e.kind === 'portState' && e.device === 'r1' && e.port === TU0)).toEqual([]);
    evs = line(sim, 'r1', [['interface', TU0]], ['tunnel', 'destination', '209.165.200.230']);
    expect(tunnelRow(sim, 'r1')).toMatchObject({ state: 'up', destination: '209.165.200.230' });
    expect(tunnelRow(sim, 'r1')!.reason).toBeUndefined();
    expect(tunnelUp(sim, 'r1')).toBe(true);
    const t = evs.find((e) => e.kind === 'debug' && e.event.device === 'r1' && e.event.fsm?.machine === 'tunnel');
    expect(t?.kind === 'debug' ? [t.event.category, t.event.fsm!.subject, t.event.fsm!.from, t.event.fsm!.to] : undefined).toEqual(['tunnel', TU0, 'down', 'up']);
    expect(evs.filter((e) => e.kind === 'portState' && e.device === 'r1' && e.port === TU0).map((e) => (e as { operUp: boolean }).operUp)).toEqual([true]);
    // and PC1 now reaches PC2
    expect(ping(sim, 'pc1', '192.168.2.10').text).toContain('!!!');
  });

  it('failures: no tunnel destination, the default route withdrawn, the source shut, a destination routed through the tunnel', () => {
    const sim = greWorld();
    line(sim, 'r1', [['interface', TU0]], ['tunnel', 'destination', '209.165.200.230'], true);
    expect(tunnelRow(sim, 'r1')).toMatchObject({ state: 'down', reason: 'no-destination' });
    expect(tunnelUp(sim, 'r1')).toBe(false);
    expect(sim.device('r1')!.tables.rib.get('172.16.0.0/30')).toBeUndefined();
    line(sim, 'r1', [['interface', TU0]], ['tunnel', 'destination', '209.165.200.230']);
    expect(tunnelUp(sim, 'r1')).toBe(true);
    // the lpm watch: withdrawing the default route takes the tunnel down `no-route`, restoring it brings it back
    line(sim, 'r1', [], ['ip', 'route', '0.0.0.0', '0.0.0.0', '209.165.200.226'], true);
    expect(tunnelRow(sim, 'r1')).toMatchObject({ state: 'down', reason: 'no-route' });
    line(sim, 'r1', [], ['ip', 'route', '0.0.0.0', '0.0.0.0', '209.165.200.226']);
    expect(tunnelRow(sim, 'r1')).toMatchObject({ state: 'up' });
    // the source interface shut
    line(sim, 'r1', [['interface', SE0]], ['shutdown']);
    expect(tunnelRow(sim, 'r1')).toMatchObject({ state: 'down', reason: 'no-source' });
    line(sim, 'r1', [['interface', SE0]], ['shutdown'], true);
    expect(tunnelRow(sim, 'r1')).toMatchObject({ state: 'up' });
    // recursive routing: a host route to the destination through Tunnel0; one log; it stays down (no flap)
    const evs = line(sim, 'r1', [], ['ip', 'route', '209.165.200.230', '255.255.255.255', TU0]);
    expect(tunnelRow(sim, 'r1')).toMatchObject({ state: 'down', reason: 'recursive-routing' });
    expect(evs.filter((e) => e.kind === 'log' && e.device === 'r1' && e.facility === 'TUNNEL').map((e) => (e as { severity: number; message: string }))).toEqual([
      expect.objectContaining({ severity: 5, message: `${TU0} is down: its destination 209.165.200.230 is routed through a tunnel (recursive routing)` }),
    ]);
    expect(evs.filter((e) => e.kind === 'portState' && e.device === 'r1' && e.port === TU0).map((e) => (e as { operUp: boolean }).operUp)).toEqual([false]);
    sim.runFor(30 * SEC);
    expect(tunnelUp(sim, 'r1')).toBe(false);
    line(sim, 'r1', [], ['ip', 'route', '209.165.200.230', '255.255.255.255', TU0], true);
    expect(tunnelRow(sim, 'r1')).toMatchObject({ state: 'up' });
    expect(tunnelUp(sim, 'r1')).toBe(true);
  });

  it('silence: a router running gre without a Tunnel interface writes no row and sends nothing (§4.3)', () => {
    const sim = greWorld();
    const isp = sim.device('isp')!;
    expect(isp.processes.has('gre')).toBe(true);
    expect(isp.tables.get('tunnels')!.size).toBe(0);
    const all = sim.trace(0).events;
    expect(all.filter((e) => e.kind === 'tableWrite' && e.device === 'isp' && e.table === 'tunnels')).toEqual([]);
    expect(all.filter((e) => e.kind === 'debug' && e.event.device === 'isp' && e.event.process === 'gre')).toEqual([]);
    expect(all.filter((e) => e.kind === 'pduCreated' && e.process === 'gre')).toEqual([]);
  });
});

describe('wan.gre [S18]: head and tail (§3.10 steps 2–4)', () => {
  it('PC1 pings PC2: one PduId end to end, wrapped once at R1, routed by the ISP on the outer header, unwrapped at R2', () => {
    const sim = greWorld();
    const r = ping(sim, 'pc1', '192.168.2.10');
    expect(r.text).toContain('!!!');
    const echo = r.evs.find((e): e is Extract<TraceEvent, { kind: 'pduCreated' }> => e.kind === 'pduCreated' && e.device === 'pc1' && e.pdu.summary.includes('echo request'))!;
    const id = echo.pdu.id;
    const pdu = sim.pdu(id)!;
    const muts = pdu.provenance as readonly Mut[];
    const at = (d: string) => muts.filter((m) => m.device === d && m.reason !== 'ChecksumRecompute' && m.reason !== 'FcsRecompute').map((m) => [m.reason, m.field, m.cause ?? '']);
    // R1: the inner TTL decrement by the static via the tunnel, then one rewrap (ethernet off, gre and ipv4 on)
    const r1 = at('r1');
    expect(r1.slice(0, 4)).toEqual([
      ['TtlDecrement', 'ipv4.ttl', `ip route 192.168.2.0 ${MASK24} 172.16.0.2`],
      ['Decapsulate', 'ethernet', `interface ${TU0}`],
      ['Encapsulate', 'gre', `interface ${TU0}`],
      ['Encapsulate', 'ipv4', `interface ${TU0}`],
    ]);
    // the ISP decrements the OUTER TTL 255 → 254 by its connected route; the inner addresses are never routed there
    expect(muts.filter((m) => m.device === 'isp' && m.reason === 'TtlDecrement').map((m) => [m.before, m.after])).toEqual([[255, 254]]);
    // R2: a strip-only rewrap (hdlc, ipv4, gre removed), then the inner TTL decrement out Gi0/0
    const r2 = at('r2');
    expect(r2.slice(0, 3)).toEqual([
      ['Decapsulate', 'hdlc', `interface ${TU0}`],
      ['Decapsulate', 'ipv4', `interface ${TU0}`],
      ['Decapsulate', 'gre', `interface ${TU0}`],
    ]);
    expect(muts.filter((m) => m.reason === 'TtlDecrement' && m.field === 'ipv4.ttl').map((m) => [m.device, m.before, m.after])).toEqual([
      ['r1', 128, 127],
      ['isp', 255, 254],
      ['r2', 127, 126],
    ]);
    // the legs: on the LANs the 100-byte packet in Ethernet (+ 18); on the provider's serial links the same PduId in
    // ipv4 + GRE (+ 24) inside HDLC (+ 6), tagged `PduSummary.tunnel = 'gre'` by the link model's summary
    // (`link/media/p2p.ts` `summarizePdu`, the W2 fix of this item's cross-owner need).
    const legs = r.evs.filter((e): e is Extract<TraceEvent, { kind: 'frameTx' }> => e.kind === 'frameTx' && e.pdu.id === id);
    expect(legs.map((l) => [l.from.device, l.to.device, l.pdu.size])).toEqual([
      ['pc1', 'r1', 100 + 18],
      ['r1', 'isp', 100 + 24 + 6],
      ['isp', 'r2', 100 + 24 + 6],
      ['r2', 'pc2', 100 + 18],
    ]);
    expect(legs.map((l) => l.pdu.tunnel)).toEqual([undefined, 'gre', 'gre', undefined]);
    expect(r.evs.some((e) => e.kind === 'frameRx' && e.device === 'pc2' && e.pdu.id === id)).toBe(true);
    // the tunnel counts: out on R1's Tunnel0, in on R2's (the ingress action)
    expect(sim.device('r1')!.port(TU0)!.counters.outPackets).toBeGreaterThanOrEqual(5);
    expect(sim.device('r2')!.port(TU0)!.counters.inPackets).toBeGreaterThanOrEqual(5);
    const view = sim.device('r2')!.stateSnapshots().find((v) => v.process === 'gre')!.state as { tunnels: { encaps: number; decaps: number }[] };
    expect(view.tunnels[0]!.decaps).toBeGreaterThanOrEqual(5);
    expect(view.tunnels[0]!.encaps).toBeGreaterThanOrEqual(5);
  });

  it('the D15 fallback: 1500 bytes with DF → mtu-exceeded and ICMP 3/4 (MTU 1476); without DF → the drop alone; 1476 bytes cross', () => {
    const sim = greWorld();
    const r1Mac = sim.device('r1')!.port(GI1)!.mac;
    const injMac = sim.device('inj')!.port('GigabitEthernet0')!.mac;
    const datagram = (size: number, df: boolean): LayerSpec[] => [
      { proto: 'ethernet', fields: { dst: r1Mac, src: injMac, type: ETHERTYPE_IPV4 } },
      { proto: 'ipv4', fields: { src: '192.168.3.10', dst: '192.168.2.10', protocol: IPPROTO_ICMP, ttl: 64, flags: df ? 2 : 0, id: size } },
      { proto: 'icmpv4', fields: { type: 8, code: 0, id: 9, seq: size } },
      { proto: 'payload', fields: { data: new Uint8Array(size - 28) } },
    ];
    const cursor = sim.trace(0).next;
    injectFrames(sim, { from: 'inj', port: 'GigabitEthernet0', frames: [datagram(1500, true), datagram(1500, false), datagram(1476, true)], spacingNs: 10 * MS });
    sim.runToIdle();
    const evs = sim.trace(cursor).events;
    const injected = evs.filter((e): e is Extract<TraceEvent, { kind: 'pduCreated' }> => e.kind === 'pduCreated' && e.device === 'inj').map((e) => e.pdu.id);
    expect(injected).toHaveLength(3);
    const drops = evs.filter((e): e is Extract<TraceEvent, { kind: 'drop' }> => e.kind === 'drop' && e.reason === 'mtu-exceeded');
    expect(drops.map((d) => [d.device, d.port, d.pdu.id, d.detail])).toEqual([
      ['r1', TU0, injected[0], greMtuDetail(1476)],
      ['r1', TU0, injected[1], greMtuDetail(1476)],
    ]);
    expect(greMtuDetail(1476)).toBe('larger than the tunnel can carry (1476 bytes); fragmentation is not simulated');
    // one ICMP 3/4 (for the DF datagram only), carrying the next-hop MTU 1476 in the low 16 bits of `unused`
    const errors = evs.filter((e): e is Extract<TraceEvent, { kind: 'pduCreated' }> => e.kind === 'pduCreated' && e.device === 'r1' && e.process === 'icmpv4');
    expect(errors).toHaveLength(1);
    const icmp = sim.pdu(errors[0]!.pdu.id)!;
    expect(icmp.layer('icmpv4')!.fields).toMatchObject({ type: 3, code: 4, unused: 1476 });
    expect(icmp.layer('ipv4')!.fields).toMatchObject({ dst: '192.168.3.10' });
    expect(icmp.meta.triggeredBy).toBe(injected[0]);
    // 1476 bytes (exactly the IP MTU) cross the tunnel and reach PC2
    expect(evs.some((e) => e.kind === 'frameRx' && e.device === 'pc2' && e.pdu.id === injected[2])).toBe(true);
    expect((sim.device('r1')!.stateSnapshots().find((v) => v.process === 'gre')!.state as { tunnels: { mtuDrops: number }[] }).tunnels[0]!.mtuDrops).toBe(2);
  });

  it('ip tcp adjust-mss clamps a SYN at the head (R1, 1436) and at the tail (R2, 1400)', () => {
    const sim = greWorld({ r1Tunnel: [...R1_TUNNEL, ' ip tcp adjust-mss 1436'], r2Tunnel: [...R2_TUNNEL, ' ip tcp adjust-mss 1400'] });
    const r1Mac = sim.device('r1')!.port(GI1)!.mac;
    const injMac = sim.device('inj')!.port('GigabitEthernet0')!.mac;
    const syn: LayerSpec[] = [
      { proto: 'ethernet', fields: { dst: r1Mac, src: injMac, type: ETHERTYPE_IPV4 } },
      { proto: 'ipv4', fields: { src: '192.168.3.10', dst: '192.168.2.10', protocol: IPPROTO_TCP, ttl: 64 } },
      { proto: 'tcp', fields: { srcPort: 40000, dstPort: 80, seq: 1, flags: 'S', window: 65535, mss: 1460 } },
    ];
    const cursor = sim.trace(0).next;
    injectFrames(sim, { from: 'inj', port: 'GigabitEthernet0', frames: [syn], spacingNs: 0 });
    sim.runToIdle();
    const evs = sim.trace(cursor).events;
    const id = evs.find((e) => e.kind === 'pduCreated' && e.device === 'inj')!;
    const pid = (id as Extract<TraceEvent, { kind: 'pduCreated' }>).pdu.id;
    const pdu = sim.pdu(pid)!;
    expect((pdu.provenance as readonly Mut[]).filter((m) => m.field === 'tcp.mss').map((m) => [m.device, m.reason, m.before, m.after, m.cause])).toEqual([
      ['r1', 'Other', 1460, 1436, `ip tcp adjust-mss 1436 on ${TU0}`],
      ['r2', 'Other', 1436, 1400, `ip tcp adjust-mss 1400 on ${TU0}`],
    ]);
    expect(evs.some((e) => e.kind === 'frameRx' && e.device === 'pc2' && e.pdu.id === pid)).toBe(true);
    expect(pdu.layer('tcp')!.fields.mss).toBe(1400);
  });
});

describe('wan.gre [S18]: a routing protocol over the tunnel, and removal', () => {
  it('[C1] EIGRP over Tunnel0: its multicast hellos cross the provider as unicast GRE; 192.168.2.0/24 is learned through the tunnel', () => {
    const sim = greWorld({ eigrp: true });
    const nbrs = sim.device('r1')!.tables.get<EigrpNeighborRow>('eigrp-neighbors')!.rows();
    expect(nbrs.map((n) => [n.iface, n.address, n.state])).toEqual([[TU0, '172.16.0.2', 'up']]);
    // the tunnel's routing defaults (D17): 100 kb/s and 50 000 µs, added to R2's GigE LAN (10 µs)
    expect(sim.device('r1')!.tables.rib.get('192.168.2.0/24')).toMatchObject({ source: 'EIGRP', nextHop: '172.16.0.2', iface: TU0, metric: 256 * (100_000 + 5_001) });
    expect(ping(sim, 'pc1', '192.168.2.10').text).toContain('!!!');
    // a hello to 224.0.0.10 left Tunnel0 inside an outer unicast packet to R2
    const evs = sim.trace(0).events;
    const hello = evs.find((e): e is Extract<TraceEvent, { kind: 'pduCreated' }> => e.kind === 'pduCreated' && e.device === 'r1' && e.pdu.tag === 'eigrp-hello' && e.pdu.flow === 'ipv4:172.16.0.1>224.0.0.10:eigrp')!;
    const view = sim.pdu(hello.pdu.id)!;
    const muts = (view.provenance as readonly Mut[]).filter((m) => m.reason === 'Encapsulate' || m.reason === 'Decapsulate' || m.reason === 'TtlDecrement');
    expect(muts.map((m) => [m.device, m.reason, m.field])).toEqual([
      ['r1', 'Encapsulate', 'gre'],
      ['r1', 'Encapsulate', 'ipv4'],
      ['r1', 'Encapsulate', 'hdlc'],
      ['isp', 'TtlDecrement', 'ipv4.ttl'],
      ['r2', 'Decapsulate', 'hdlc'],
      ['r2', 'Decapsulate', 'ipv4'],
      ['r2', 'Decapsulate', 'gre'],
    ]);
    // delivered at R2 as the inner multicast hello on Tunnel0
    expect(view.layers.map((l) => l.proto)).toEqual(['ipv4', 'eigrp']);
    expect(view.layers[0]!.fields).toMatchObject({ src: '172.16.0.1', dst: '224.0.0.10', ttl: 2 });
    expect(evs.some((e) => e.kind === 'pduConsumed' && e.device === 'r2' && e.process === 'eigrp' && e.pdu.id === hello.pdu.id)).toBe(true);
  });

  it('no interface Tunnel0: the row goes, the port goes, its connected route goes', () => {
    const sim = greWorld();
    line(sim, 'r1', [], ['interface', TU0], true);
    expect(sim.device('r1')!.port(TU0)).toBeUndefined();
    expect(tunnelRow(sim, 'r1')).toBeUndefined();
    expect(sim.device('r1')!.tables.rib.get('172.16.0.0/30')).toBeUndefined();
    expect(sim.device('r1')!.stateSnapshots().find((v) => v.process === 'gre')!.state).toEqual({ tunnels: [] });
  });
});
