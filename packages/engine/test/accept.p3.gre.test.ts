/**
 * accept.p3.gre [S18] — ARCHITECTURE-P3 §10.1 row `accept.p3.gre.test.ts` (W4 qa; on `staged.world` at stage P3, rule
 * 14 step 1; the flip is a later, separate change): §3.10 — GRE carries a ping between two sites.
 *
 *   - ping 5/5, each datagram one PduId end to end;
 *   - head and tail provenance exact (§3.10 steps 2 and 4);
 *   - the ISP RIB has no private route;
 *   - TTLs decremented only where §3.10 says (the inner header at R1 and R2, the outer 255 → 254 at the ISP);
 *   - `PduSummary.tunnel = 'gre'` only on the WAN legs (the provider's serial links);
 *   - the exact down reasons (§3.10 steps 1 and 5; the `TunnelDownReason`s of [S18]);
 *   - the D15 fallback without [S17]: drop `mtu-exceeded` with its detail, ICMP 3/4 carrying 1476 when DF is set, and
 *     `ip tcp adjust-mss` clamping the SYN of a real web request;
 *   - OSPF over the tunnel at cost 1000 (§3.10 step 6, D17).
 * (The `path` lab kind is W5's, proved by `sim.lab-checks.approved-kinds.test.ts` and lab 24.)
 *
 * The world (test/tunnel.world.ts) carries the registry of the W4 flip, so it is the same world after the flip.
 * Counts and sizes that follow from constants are computed from them (§10).
 */
import { describe, expect, it } from 'vitest';
import { GRE_OVERHEAD, IPPROTO_GRE } from '../src/contracts/pdu.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { OspfInterfaceRow, OspfNeighborRow } from '../src/contracts/tables.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { GRE_DEFAULT_TRANSPORT_MTU, GRE_LOG_FACILITY, GRE_OUTER_TTL, greMtuDetail, greTunnelCause } from '../src/protocols/gre.js';
import { OSPF_REFERENCE_MBPS_DEFAULT, OSPF_TUNNEL_BANDWIDTH_KBPS, ospfCostFor } from '../src/protocols/ospf/cost.js';
import { injectFrames } from './inject.js';
import { ping } from './sim.harness.js';
import {
  GI0,
  INJ_PORT,
  MASK24,
  PC1_ADDR,
  PC2_ADDR,
  R1_GRE_TUNNEL,
  R1_WAN,
  R2_GRE_TUNNEL,
  R2_WAN,
  SE0,
  TU0,
  jsonOf,
  line,
  oversizeEcho,
  privateRoutes,
  tunnelRow,
  tunnelUp,
  tunnelWorld,
  type Created,
  type Drop,
  type FrameTx,
  type Mut,
} from './tunnel.world.js';

/** The IP MTU of a GRE tunnel on a 1500-byte transport (D15). */
const greIpMtu = (): number => GRE_DEFAULT_TRANSPORT_MTU - GRE_OVERHEAD;
/** Frame overheads on the wire: Ethernet II with FCS and the HDLC framing (with FCS). */
const ETH_OVERHEAD = 18;
const HDLC_OVERHEAD = 6;
/** The host `ping` datagram size (§3.10 step 2: the default 100-byte datagram). */
const PING_BYTES = 100;
/** The host's initial TTL (NF hosts). */
const HOST_TTL = 128;
/** The provenance cause of every rewrap on Tunnel0 (read at call time, rule 12). */
const cause = (): string => greTunnelCause(TU0);

const isWanLeg = (l: FrameTx): boolean => l.from.device === 'isp' || l.to.device === 'isp';

/** Every echo request and reply PDU of one `ping` (creation order). */
function echoes(r: { evs: TraceEvent[] }): { requests: Created[]; replies: Created[] } {
  const created = r.evs.filter((e): e is Created => e.kind === 'pduCreated');
  return {
    requests: created.filter((e) => e.device === 'pc1' && e.pdu.summary.startsWith('ICMP echo request')),
    replies: created.filter((e) => e.device === 'pc2' && e.pdu.summary.startsWith('ICMP echo reply')),
  };
}

/** [reason, field, before, after, cause] of every provenance record of `device` (none filtered). */
function recordsAt(muts: readonly Mut[], device: string): unknown[][] {
  return muts.filter((m) => m.device === device).map((m) => [m.reason, m.field, m.before, m.after, m.cause ?? '']);
}

/** The `ospf-interfaces` row of `port` on `device`. */
const ospfIf = (sim: Simulation, device: string, port: string): OspfInterfaceRow | undefined =>
  sim.device(device)!.tables.get<OspfInterfaceRow>('ospf-interfaces')?.get(port);

describe('accept.p3.gre [S18]: the underlay brings Tunnel0 up (§3.10 step 1)', () => {
  it('interface Tunnel0 is created down no-source; with source, destination and the default route the row is up at MTU 1476; C, L and the static follow; the ISP has no private route', () => {
    const sim = tunnelWorld({ mode: 'gre' });
    const evs = sim.trace(0).events;
    for (const [device, source, destination] of [['r1', R1_WAN, R2_WAN], ['r2', R2_WAN, R1_WAN]] as const) {
      // the virtual port is created down, and its first row says no-source
      const created = evs.find((e) => e.kind === 'portState' && e.device === device && e.port === TU0)!;
      expect(created).toMatchObject({ operUp: false, reason: 'virtual-created' });
      const rows = evs.flatMap((e) => (e.kind === 'tableWrite' && e.device === device && e.table === 'tunnels' ? [e.row] : []));
      expect(rows[0]).toMatchObject({ mode: 'gre', state: 'down', reason: 'no-source' });
      expect(rows.at(-1)).toMatchObject({ state: 'up' });
      expect(tunnelRow(sim, device)).toEqual({
        key: TU0,
        port: TU0,
        mode: 'gre',
        source,
        sourceIface: SE0,
        destination,
        state: 'up',
        transportMtu: GRE_DEFAULT_TRANSPORT_MTU,
        ipMtu: greIpMtu(),
        since: expect.any(Number),
        updatedAt: expect.any(Number),
      });
      expect(greIpMtu()).toBe(1476);
      expect(tunnelUp(sim, device)).toBe(true);
      // the line protocol came up exactly once, when the row went up
      const ups = evs.filter((e) => e.kind === 'portState' && e.device === device && e.port === TU0 && e.operUp);
      expect(ups).toHaveLength(1);
      expect(ups[0]!.t).toBe(tunnelRow(sim, device)!.since);
    }
    const rib = sim.device('r1')!.tables.rib;
    expect(rib.get('172.16.0.0/30')).toMatchObject({ source: 'C', iface: TU0 });
    expect(rib.get('172.16.0.1/32')).toMatchObject({ source: 'L', iface: TU0 });
    expect(rib.get('192.168.2.0/24')).toMatchObject({ source: 'S', nextHop: '172.16.0.2' });
    expect(rib.get('0.0.0.0/0')).toMatchObject({ source: 'S', nextHop: '209.165.200.226' });
    expect(privateRoutes(sim, 'isp')).toEqual([]);
  });
});

describe('accept.p3.gre [S18]: a ping across the tunnel (§3.10 steps 2–4)', () => {
  it('ping 5/5: every echo is one PduId end to end; head and tail provenance exact; TTLs only where §3.10 says; tunnel gre only on the WAN legs', () => {
    const sim = tunnelWorld({ mode: 'gre' });
    const r = ping(sim, 'pc1', PC2_ADDR);
    expect(r.text).toContain('!!!!!');
    expect(r.text).toContain('Sent 5, received 5, lost 0 (0% loss)');
    const { requests, replies } = echoes(r);
    expect(requests).toHaveLength(5);
    expect(replies).toHaveLength(5);
    const legsOf = (id: number): FrameTx[] => r.evs.filter((e): e is FrameTx => e.kind === 'frameTx' && e.pdu.id === id);
    const wanBytes = PING_BYTES + GRE_OVERHEAD + HDLC_OVERHEAD;
    for (const req of requests) {
      const id = req.pdu.id;
      // one PduId from PC1 to PC2: four legs, the provider's two in GRE inside HDLC, tagged gre
      expect(legsOf(id).map((l) => [l.from.device, l.to.device, l.pdu.size, l.pdu.tunnel ?? null])).toEqual([
        ['pc1', 'r1', PING_BYTES + ETH_OVERHEAD, null],
        ['r1', 'isp', wanBytes, 'gre'],
        ['isp', 'r2', wanBytes, 'gre'],
        ['r2', 'pc2', PING_BYTES + ETH_OVERHEAD, null],
      ]);
      expect(r.evs.some((e) => e.kind === 'frameRx' && e.device === 'pc2' && e.pdu.id === id)).toBe(true);
      const muts = sim.pdu(id)!.provenance as readonly Mut[];
      // head at R1: the inner TTL by the static through the tunnel, then ONE rewrap (ethernet off; gre, ipv4 on), cause
      // `interface Tunnel0`, then the serial framing
      const r1 = recordsAt(muts, 'r1');
      expect(r1.map(([reason, field, , , cause]) => [reason, field, cause])).toEqual([
        ['TtlDecrement', 'ipv4.ttl', `ip route 192.168.2.0 ${MASK24} 172.16.0.2`],
        ['ChecksumRecompute', 'ipv4.checksum', `ip route 192.168.2.0 ${MASK24} 172.16.0.2`],
        ['FcsRecompute', 'ethernet.fcs', `ip route 192.168.2.0 ${MASK24} 172.16.0.2`],
        ['Decapsulate', 'ethernet', cause()],
        ['Encapsulate', 'gre', cause()],
        ['Encapsulate', 'ipv4', cause()],
        ['Encapsulate', 'hdlc', cause()],
      ]);
      expect(r1.slice(3)).toEqual([
        ['Decapsulate', 'ethernet', 'ethernet', null, cause()],
        ['Encapsulate', 'gre', null, 'gre', cause()],
        ['Encapsulate', 'ipv4', null, 'ipv4', cause()],
        ['Encapsulate', 'hdlc', null, 'hdlc', cause()],
      ]);
      // the provider routes the OUTER header by its connected route; nothing else happens there
      expect(recordsAt(muts, 'isp').map(([reason, field, , , cause]) => [reason, field, cause])).toEqual([
        ['TtlDecrement', 'ipv4.ttl', 'connected via Serial0/0/1'],
        ['ChecksumRecompute', 'ipv4.checksum', 'connected via Serial0/0/1'],
        ['FcsRecompute', 'hdlc.fcs', 'connected via Serial0/0/1'],
      ]);
      // tail at R2: ONE strip-only rewrap (hdlc, ipv4, gre removed), then the inner TTL out Gi0/0 and the Ethernet
      expect(recordsAt(muts, 'r2').map(([reason, field, , , cause]) => [reason, field, cause])).toEqual([
        ['Decapsulate', 'hdlc', cause()],
        ['Decapsulate', 'ipv4', cause()],
        ['Decapsulate', 'gre', cause()],
        ['TtlDecrement', 'ipv4.ttl', `connected via ${GI0}`],
        ['ChecksumRecompute', 'ipv4.checksum', `connected via ${GI0}`],
        ['Encapsulate', 'ethernet', `connected via ${GI0}`],
      ]);
      // TTLs: the inner header at R1 and R2 only, the outer header (born at 255) at the ISP only
      expect(muts.filter((m) => m.reason === 'TtlDecrement').map((m) => [m.device, m.before, m.after])).toEqual([
        ['r1', HOST_TTL, HOST_TTL - 1],
        ['isp', GRE_OUTER_TTL, GRE_OUTER_TTL - 1],
        ['r2', HOST_TTL - 1, HOST_TTL - 2],
      ]);
      expect(sim.pdu(id)!.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'payload']);
    }
    for (const rep of replies) {
      // the reply returns through R2's Tunnel0 the same way: one PduId, gre only on the provider's legs
      expect(legsOf(rep.pdu.id).map((l) => [l.from.device, l.to.device, l.pdu.tunnel ?? null])).toEqual([
        ['pc2', 'r2', null],
        ['r2', 'isp', 'gre'],
        ['isp', 'r1', 'gre'],
        ['r1', 'pc1', null],
      ]);
      const muts = sim.pdu(rep.pdu.id)!.provenance as readonly Mut[];
      expect(muts.filter((m) => m.reason === 'TtlDecrement').map((m) => [m.device, m.before, m.after])).toEqual([
        ['r2', HOST_TTL, HOST_TTL - 1],
        ['isp', GRE_OUTER_TTL, GRE_OUTER_TTL - 1],
        ['r1', HOST_TTL - 1, HOST_TTL - 2],
      ]);
      expect(recordsAt(muts, 'r2').slice(3, 6).map(([reason, field, , , cause]) => [reason, field, cause])).toEqual([
        ['Decapsulate', 'ethernet', cause()],
        ['Encapsulate', 'gre', cause()],
        ['Encapsulate', 'ipv4', cause()],
      ]);
    }
    // over the whole run (the boot included), `tunnel` appears only on the provider's legs, always 'gre', and only on
    // packets of the tunnel; and every leg of a tunnelled echo inside the provider carries it
    const all = sim.trace(0).events.filter((e): e is FrameTx => e.kind === 'frameTx');
    const tagged = all.filter((l) => l.pdu.tunnel !== undefined);
    expect(tagged.length).toBe(4 * 5);
    for (const l of tagged) {
      expect(l.pdu.tunnel).toBe('gre');
      expect(isWanLeg(l)).toBe(true);
      expect([...requests, ...replies].some((e) => e.pdu.id === l.pdu.id)).toBe(true);
    }
    for (const l of all.filter((x) => !isWanLeg(x))) expect(l.pdu.tunnel).toBeUndefined();
    // the provider never forwarded an inner address: every packet it routed was the outer GRE header
    expect(privateRoutes(sim, 'isp')).toEqual([]);
    const ispTtl = [...requests, ...replies].flatMap((e) => (sim.pdu(e.pdu.id)!.provenance as readonly Mut[]).filter((m) => m.device === 'isp' && m.reason === 'TtlDecrement'));
    expect(ispTtl.map((m) => m.before)).toEqual(Array.from({ length: 10 }, () => GRE_OUTER_TTL));
    const drops = r.evs.filter((e): e is Drop => e.kind === 'drop' && e.background !== true);
    expect(drops).toEqual([]);
    // the outer header the provider saw: protocol 47 between the tunnel's public ends (a capture of the next echo)
    const cap = sim.startCapture({ ports: [{ device: 'isp', port: SE0 }], dir: 'rx', name: 'ISP' });
    expect(ping(sim, 'pc1', PC2_ADDR).text).toContain('!!!!!');
    const rows = sim.queryCapture(cap, { from: 0, limit: 100 }).rows;
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      const rec = sim.captureRecord(cap, row.index)!;
      expect(rec.layers.map((l) => l.proto).slice(0, 4)).toEqual(['hdlc', 'ipv4', 'gre', 'ipv4']);
      expect(rec.layers[1]!.fields).toMatchObject({ src: R1_WAN, dst: R2_WAN, protocol: IPPROTO_GRE, ttl: GRE_OUTER_TTL });
      expect(rec.layers[3]!.fields).toMatchObject({ src: PC1_ADDR, dst: PC2_ADDR, ttl: HOST_TTL - 1 });
    }
  });
});

describe('accept.p3.gre [S18]: the exact down reasons (§3.10 steps 1 and 5)', () => {
  it('no-source, no-destination, no-route, recursive-routing: each named in the row, the line protocol following it', () => {
    // interface Tunnel0 alone: down no-source; the source alone: down no-destination; both: up
    const sim = tunnelWorld({ mode: 'gre', r1Tunnel: [` ip address 172.16.0.1 255.255.255.252`] });
    expect(tunnelRow(sim, 'r1')).toMatchObject({ state: 'down', reason: 'no-source', transportMtu: GRE_DEFAULT_TRANSPORT_MTU, ipMtu: greIpMtu() });
    expect(tunnelUp(sim, 'r1')).toBe(false);
    line(sim, 'r1', [['interface', TU0]], ['tunnel', 'source', SE0]);
    expect(tunnelRow(sim, 'r1')).toMatchObject({ state: 'down', reason: 'no-destination', source: R1_WAN, sourceIface: SE0 });
    expect(tunnelUp(sim, 'r1')).toBe(false);
    let evs = line(sim, 'r1', [['interface', TU0]], ['tunnel', 'destination', R2_WAN]);
    expect(tunnelRow(sim, 'r1')).toMatchObject({ state: 'up', destination: R2_WAN });
    expect(tunnelRow(sim, 'r1')!.reason).toBeUndefined();
    expect(evs.filter((e) => e.kind === 'portState' && e.device === 'r1' && e.port === TU0).map((e) => (e as { operUp: boolean }).operUp)).toEqual([true]);
    expect(ping(sim, 'pc1', PC2_ADDR).text).toContain('!!!!!');

    const downTo = (events: TraceEvent[], reason: string): void => {
      expect(tunnelRow(sim, 'r1')).toMatchObject({ state: 'down', reason });
      expect(tunnelUp(sim, 'r1')).toBe(false);
      expect(events.filter((e) => e.kind === 'portState' && e.device === 'r1' && e.port === TU0).map((e) => (e as { operUp: boolean }).operUp)).toEqual([false]);
      // the tunnel's connected route goes with its line protocol
      expect(sim.device('r1')!.tables.rib.get('172.16.0.0/30')).toBeUndefined();
    };
    const backUp = (): void => {
      expect(tunnelRow(sim, 'r1')).toMatchObject({ state: 'up' });
      expect(tunnelUp(sim, 'r1')).toBe(true);
    };
    // no tunnel destination → no-destination
    downTo(line(sim, 'r1', [['interface', TU0]], ['tunnel', 'destination', R2_WAN], true), 'no-destination');
    line(sim, 'r1', [['interface', TU0]], ['tunnel', 'destination', R2_WAN]);
    backUp();
    // the default route withdrawn → ipv4.ribChanged → no-route (D8)
    downTo(line(sim, 'r1', [], ['ip', 'route', '0.0.0.0', '0.0.0.0', '209.165.200.226'], true), 'no-route');
    line(sim, 'r1', [], ['ip', 'route', '0.0.0.0', '0.0.0.0', '209.165.200.226']);
    backUp();
    // the source interface shut → no-source
    downTo(line(sim, 'r1', [['interface', SE0]], ['shutdown']), 'no-source');
    line(sim, 'r1', [['interface', SE0]], ['shutdown'], true);
    backUp();
    // the destination routed through the tunnel itself → recursive-routing, with one log ([S36]'s flap is not approved)
    evs = line(sim, 'r1', [], ['ip', 'route', R2_WAN, '255.255.255.255', TU0]);
    downTo(evs, 'recursive-routing');
    expect(evs.filter((e) => e.kind === 'log' && e.device === 'r1' && e.facility === GRE_LOG_FACILITY).map((e) => (e as { message: string }).message)).toEqual([
      `${TU0} is down: its destination ${R2_WAN} is routed through a tunnel (recursive routing)`,
    ]);
    line(sim, 'r1', [], ['ip', 'route', R2_WAN, '255.255.255.255', TU0], true);
    backUp();
    // and the ping crosses again
    expect(ping(sim, 'pc1', PC2_ADDR).text).toContain('!!!!!');
  });
});

describe('accept.p3.gre [S18]: the MTU fallback of D15 without [S17] (§3.10 step 5)', () => {
  it('1500 bytes with DF: drop mtu-exceeded with its detail and ICMP 3/4 carrying 1476 to PC1; without DF the drop alone; 1476 bytes cross', () => {
    const sim = tunnelWorld({ mode: 'gre' });
    const cursor = sim.trace(0).next;
    const big = GRE_DEFAULT_TRANSPORT_MTU;
    injectFrames(sim, { from: 'inj', port: INJ_PORT, frames: [oversizeEcho(sim, big, true), oversizeEcho(sim, big, false), oversizeEcho(sim, greIpMtu(), true)], spacingNs: 10_000_000 });
    expect(sim.runToIdle().stopped).toBeUndefined();
    const evs = sim.trace(cursor).events;
    const injected = evs.filter((e): e is Created => e.kind === 'pduCreated' && e.device === 'inj').map((e) => e.pdu.id);
    expect(injected).toHaveLength(3);
    const drops = evs.filter((e): e is Drop => e.kind === 'drop' && e.reason === 'mtu-exceeded');
    expect(drops.map((d) => [d.device, d.port, d.pdu.id, d.detail])).toEqual([
      ['r1', TU0, injected[0], greMtuDetail(greIpMtu())],
      ['r1', TU0, injected[1], greMtuDetail(greIpMtu())],
    ]);
    expect(greMtuDetail(greIpMtu())).toBe('larger than the tunnel can carry (1476 bytes); fragmentation is not simulated');
    // ICMP 3/4 only for the DF datagram, with the next-hop MTU in the low 16 bits of `unused` (RFC 1191), and PC1 gets it
    const errors = evs.filter((e): e is Created => e.kind === 'pduCreated' && e.process === 'icmpv4' && e.device === 'r1');
    expect(errors).toHaveLength(1);
    const icmp = sim.pdu(errors[0]!.pdu.id)!;
    expect(icmp.layer('icmpv4')!.fields).toMatchObject({ type: 3, code: 4, unused: greIpMtu() });
    expect(icmp.layer('ipv4')!.fields).toMatchObject({ dst: PC1_ADDR });
    expect(icmp.meta.triggeredBy).toBe(injected[0]);
    expect(evs.some((e) => e.kind === 'frameRx' && e.device === 'pc1' && e.pdu.id === errors[0]!.pdu.id)).toBe(true);
    // exactly the IP MTU crosses: 1476 + 24 = 1500 bytes inside HDLC on the provider's links
    expect(evs.some((e) => e.kind === 'frameRx' && e.device === 'pc2' && e.pdu.id === injected[2])).toBe(true);
    const leg = evs.find((e): e is FrameTx => e.kind === 'frameTx' && e.pdu.id === injected[2] && e.from.device === 'r1')!;
    expect([leg.to.device, leg.pdu.size, leg.pdu.tunnel]).toEqual(['isp', GRE_DEFAULT_TRANSPORT_MTU + HDLC_OVERHEAD, 'gre']);
  });

  it('ip tcp adjust-mss clamps the SYN of a web request from PC1 at the head (R1, 1436) and at the tail (R2, 1400)', () => {
    const sim = tunnelWorld({ mode: 'gre', r1Tunnel: [...R1_GRE_TUNNEL, ' ip tcp adjust-mss 1436'], r2Tunnel: [...R2_GRE_TUNNEL, ' ip tcp adjust-mss 1400'] });
    const cursor = sim.trace(0).next;
    sim.hostRequest('pc1', { app: 'http.get', url: `http://${PC2_ADDR}/` });
    expect(sim.runToIdle().stopped).toBeUndefined();
    const evs = sim.trace(cursor).events;
    const syn = evs.find((e): e is Created => e.kind === 'pduCreated' && e.device === 'pc1' && e.pdu.tag === 'tcp-syn')!;
    const pdu = sim.pdu(syn.pdu.id)!;
    const offered = (pdu.provenance as readonly Mut[]).find((m) => m.field === 'tcp.mss')!.before as number;
    expect(offered).toBeGreaterThan(1436);
    expect((pdu.provenance as readonly Mut[]).filter((m) => m.field === 'tcp.mss').map((m) => [m.device, m.reason, m.before, m.after, m.cause])).toEqual([
      ['r1', 'Other', offered, 1436, `ip tcp adjust-mss 1436 on ${TU0}`],
      ['r2', 'Other', 1436, 1400, `ip tcp adjust-mss 1400 on ${TU0}`],
    ]);
    // the clamped SYN crossed the tunnel and reached PC2 with the smaller MSS
    expect(evs.some((e) => e.kind === 'frameRx' && e.device === 'pc2' && e.pdu.id === syn.pdu.id)).toBe(true);
    expect(pdu.layer('tcp')!.fields.mss).toBe(1400);
    const legs = evs.filter((e): e is FrameTx => e.kind === 'frameTx' && e.pdu.id === syn.pdu.id);
    expect(legs.map((l) => l.pdu.tunnel ?? null)).toEqual([null, 'gre', 'gre', null]);
  });
});

describe('accept.p3.gre [S18]: determinism (§10, §4.1)', () => {
  it('one seed, three runs: the world, a ping and a refused oversize datagram give byte-identical trace and snapshot JSON', () => {
    const run = (): string => {
      const sim = tunnelWorld({ mode: 'gre' });
      ping(sim, 'pc1', PC2_ADDR);
      injectFrames(sim, { from: 'inj', port: INJ_PORT, frames: [oversizeEcho(sim, GRE_DEFAULT_TRANSPORT_MTU, true)], spacingNs: 0 });
      expect(sim.runToIdle().stopped).toBeUndefined();
      return jsonOf([sim.trace(0).events, sim.snapshot()]);
    };
    const first = run();
    expect(run()).toBe(first);
    expect(run()).toBe(first);
  });
});

describe('accept.p3.gre [S18]: OSPF over the tunnel (§3.10 step 6, D17)', () => {
  it('Tunnel0 is a point-to-point OSPF interface at cost 1000; its hello to 224.0.0.5 crosses the provider as unicast GRE; 192.168.2.0/24 is learned at [110/1001] through it', () => {
    const sim = tunnelWorld({ mode: 'gre', ospf: true });
    const tunnelCost = ospfCostFor(OSPF_REFERENCE_MBPS_DEFAULT, OSPF_TUNNEL_BANDWIDTH_KBPS);
    expect(tunnelCost).toBe(1000);
    const lanCost = ospfIf(sim, 'r2', GI0)!.cost;
    for (const [device, peer, peerRid] of [['r1', '172.16.0.2', R2_WAN], ['r2', '172.16.0.1', R1_WAN]] as const) {
      expect(ospfIf(sim, device, TU0)).toMatchObject({ networkType: 'point-to-point', state: 'point-to-point', cost: tunnelCost, costSource: 'bandwidth', neighbors: 1, adjacent: 1 });
      const nbrs = sim.device(device)!.tables.get<OspfNeighborRow>('ospf-neighbors')!.rows();
      expect(nbrs.map((n) => [n.port, n.address, n.routerId, n.state])).toEqual([[TU0, peer, peerRid, 'full']]);
    }
    const route = sim.device('r1')!.tables.rib.get('192.168.2.0/24')!;
    expect(route).toMatchObject({ source: 'O', ad: 110, metric: tunnelCost + lanCost, nextHop: '172.16.0.2', iface: TU0 });
    expect(tunnelCost + lanCost).toBe(1001);
    const s = sim.cli.open('r1', 'console');
    expect(sim.cli.exec(s, 'show ip route').output.split('\n')).toContain(`O    192.168.2.0/24  via 172.16.0.2 [110/${tunnelCost + lanCost}] ${TU0}`);
    expect(privateRoutes(sim, 'isp')).toEqual([]);
    // the hello to 224.0.0.5 left Tunnel0 inside an outer unicast GRE packet to R2 and reached ospf there
    const evs = sim.trace(0).events;
    const hello = evs.find((e): e is Created => e.kind === 'pduCreated' && e.device === 'r1' && e.process === 'ospf' && e.pdu.flow === 'ipv4:172.16.0.1>224.0.0.5:ospf')!;
    expect(hello).toBeDefined();
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
    const outer = (view.provenance as readonly Mut[]).find((m) => m.device === 'isp' && m.reason === 'TtlDecrement')!;
    expect([outer.before, outer.after]).toEqual([GRE_OUTER_TTL, GRE_OUTER_TTL - 1]);
    expect(view.layers.map((l) => l.proto)).toEqual(['ipv4', 'ospf']);
    expect(view.layers[0]!.fields).toMatchObject({ src: '172.16.0.1', dst: '224.0.0.5' });
    expect(evs.some((e) => e.kind === 'pduConsumed' && e.device === 'r2' && e.process === 'ospf' && e.pdu.id === hello.pdu.id)).toBe(true);
    const legs = evs.filter((e): e is FrameTx => e.kind === 'frameTx' && e.pdu.id === hello.pdu.id);
    expect(legs.map((l) => [l.from.device, l.to.device, l.pdu.tunnel])).toEqual([
      ['r1', 'isp', 'gre'],
      ['isp', 'r2', 'gre'],
    ]);
    // and the learned route carries the ping
    const r = ping(sim, 'pc1', PC2_ADDR);
    expect(r.text).toContain('Sent 5, received 5, lost 0 (0% loss)');
    const echo = r.evs.find((e): e is Created => e.kind === 'pduCreated' && e.device === 'pc1' && e.pdu.summary.startsWith('ICMP echo request'))!;
    const ttl = (sim.pdu(echo.pdu.id)!.provenance as readonly Mut[]).find((m) => m.device === 'r1' && m.reason === 'TtlDecrement')!;
    expect(ttl.cause).toBe(`ospf 1: O 192.168.2.0/24 [110/${tunnelCost + lanCost}] via 172.16.0.2`);
  });
});
