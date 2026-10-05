/**
 * P3 acceptance — an implicit deny breaks OSPF (ARCHITECTURE-P3 §10.1 `accept.p3.ospf-acl`; §3.3 step 8, §3.0 (a)
 * step 2, D7, D9, D12, §4.2; §7 W4 qa).
 *
 * A real world on `staged.world` at stage P3 with every approved P3 daemon registered (the catalog flip is a later,
 * separate step; after it the overlay is a no-op):
 *
 *   PC1 192.168.10.10 ── Gi0/0 R1 192.168.10.1   Gi0/1 10.0.12.1/30 ──── 10.0.12.2/30 Gi0/0 R2   Loopback0 2.2.2.2/32
 *
 * Both routers run `router ospf 1` in area 0 on the default broadcast network (hello 10 s, dead 4 × hello). Once the
 * adjacency is Full, R1 gets `access-list 10 permit 192.168.10.0 0.0.0.255` inbound on Gi0/1 — a list without the
 * neighbour:
 *   • R2's hellos (IP protocol 89 to 224.0.0.5, source 10.0.12.2) are dropped `acl-deny` at R1 Gi0/1 by the implicit
 *     deny, before the for-me test, and counted on the implicit row; no ICMP answers a multicast;
 *   • the adjacency goes Down on R1 by the inactivity timer exactly one dead interval after the last hello R1 accepted,
 *     and R1's OSPF routes are withdrawn (R2 drops back to Init: R1's hellos stop naming it);
 *   • permitting the neighbour (`access-list 10 permit host 10.0.12.2`) restores the adjacency and the routes; its
 *     hellos count on the new entry, and whatever the list still does not name (replies from 2.2.2.2) stays denied.
 */
import { describe, expect, it } from 'vitest';
import { isIpv4Multicast } from '../src/contracts/addr.js';
import type { FsmTransition } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { aclKey, type OspfNeighborRow, type RouteRow } from '../src/contracts/tables.js';
import { SEC, type SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { PING_COUNT } from '../src/cli/handlers/exec.js';
import { OSPF_HELLO_S_DEFAULT } from '../src/protocols/ospf/config.js';
import { ofKind } from './sim.harness.js';
import { GI0, GI1, MASK24, MASK30, PC_PORT, aclRow, aclWorld, adminProhibited, cfg, dropsAt, hostConfig, mark, pingFrom, routedPort, routerConfig, since } from './accept.p3.acl.harness.js';

const R2_LOOPBACK = '2.2.2.2';
const R2_WAN = '10.0.12.2';
/** The dead interval without a dead line: 4 × hello (§5.1). */
const DEAD_NS: SimTime = 4 * OSPF_HELLO_S_DEFAULT * SEC;
const IPPROTO_OSPF = 89;

/** The world of the file header, booted and converged (Full both ways). */
function world(seed: number): Simulation {
  const sim = aclWorld(seed);
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: hostConfig('PC1', '192.168.10.10', '192.168.10.1') });
  sim.addDevice({
    id: 'r1',
    type: 'router.nf2911',
    name: 'R1',
    startupConfig: routerConfig('R1', [
      routedPort(GI0, '192.168.10.1', MASK24),
      routedPort(GI1, '10.0.12.1', MASK30),
      ['router ospf 1', ' router-id 1.1.1.1', ' network 192.168.10.0 0.0.0.255 area 0', ' network 10.0.12.0 0.0.0.3 area 0'],
    ]),
  });
  sim.addDevice({
    id: 'r2',
    type: 'router.nf2911',
    name: 'R2',
    startupConfig: routerConfig('R2', [
      routedPort(GI0, R2_WAN, MASK30),
      ['interface Loopback0', ` ip address ${R2_LOOPBACK} 255.255.255.255`],
      ['router ospf 1', ' router-id 2.2.2.2', ' network 10.0.12.0 0.0.0.3 area 0', ` network ${R2_LOOPBACK} 0.0.0.0 area 0`],
    ]),
  });
  sim.addLink({ a: { device: 'pc1', port: PC_PORT }, b: { device: 'r1', port: GI0 } });
  sim.addLink({ a: { device: 'r1', port: GI1 }, b: { device: 'r2', port: GI0 } });
  sim.runFor(60 * SEC);
  sim.runToIdle();
  return sim;
}

const neighbors = (sim: Simulation, device: string): OspfNeighborRow[] => sim.device(device)!.tables.get<OspfNeighborRow>('ospf-neighbors')?.rows() ?? [];
const ospfRoutes = (sim: Simulation, device: string): RouteRow[] => sim.device(device)!.tables.rib.rows().filter((r) => r.source === 'O');

/** The `ospf-nbr` transitions of `device` in `evs`, with their times. */
function nbrTransitions(evs: readonly TraceEvent[], device: string): (FsmTransition & { t: SimTime })[] {
  const out: (FsmTransition & { t: SimTime })[] = [];
  for (const e of evs) {
    if (e.kind !== 'debug' || e.event.device !== device || e.event.fsm?.machine !== 'ospf-nbr') continue;
    out.push({ ...e.event.fsm, t: e.t });
  }
  return out;
}

/** The OSPF hellos `device` created (ospf process, tag `ospf-hello`), with their times. */
function hellos(evs: readonly TraceEvent[], device: string): { t: SimTime; id: number }[] {
  return ofKind(evs, 'pduCreated')
    .filter((e) => e.device === device && e.process === 'ospf' && e.pdu.tag === 'ospf-hello')
    .map((e) => ({ t: e.t, id: e.pdu.id }));
}

describe('accept P3: an inbound standard list without the neighbour breaks OSPF (§3.3 step 8)', () => {
  it('drops the neighbour’s hellos (acl-deny, protocol 89); Down one dead interval after the last accepted hello; permitting it restores the adjacency', () => {
    const sim = world(81);
    // converged: Full both ways, R1 routes to R2's loopback, PC1 reaches it
    expect(neighbors(sim, 'r1').map((n) => [n.routerId, n.state])).toEqual([[R2_LOOPBACK, 'full']]);
    expect(neighbors(sim, 'r2').map((n) => [n.routerId, n.state])).toEqual([['1.1.1.1', 'full']]);
    expect(ospfRoutes(sim, 'r1').map((r) => [r.key, r.nextHop, r.iface])).toEqual([[`${R2_LOOPBACK}/32`, R2_WAN, GI1]]);
    expect(pingFrom(sim, 'pc1', R2_LOOPBACK).text).toContain(`Sent ${PING_COUNT}, received ${PING_COUNT}, lost 0`);

    // the list permits R1's own LAN only, so its implicit deny catches every packet R2 sends
    const before = mark(sim);
    const T = sim.now;
    cfg(sim, 'r1', ['access-list 10 permit 192.168.10.0 0.0.0.255', `interface ${GI1}`, 'ip access-group 10 in']);
    // the last hello of R2 that R1 accepted came before the binding
    const accepted = hellos(since(sim, 0), 'r2').filter((h) => h.t < T);
    const lastAccepted = accepted.at(-1)!;
    sim.runFor(DEAD_NS + 5 * SEC);
    const evs = since(sim, before);

    // R2's hellos die at R1 Gi0/1 by the implicit deny: OSPF (protocol 89) to AllSPFRouters, from outside the list
    const r2Hellos = hellos(evs, 'r2');
    expect(r2Hellos.length).toBeGreaterThanOrEqual(DEAD_NS / (OSPF_HELLO_S_DEFAULT * SEC));
    const drops = dropsAt(evs, 'r1', 'acl-deny');
    for (const h of r2Hellos) {
      const d = drops.find((x) => x.pdu.id === h.id);
      expect(d, `hello ${h.id}`).toBeDefined();
      expect([d!.port, d!.detail, d!.rule?.seq, d!.rule?.key, d!.rule?.dir]).toEqual([GI1, 'ACL 10 implicit deny', 'implicit', aclKey(4, '10', 'implicit'), 'in']);
      const pdu = sim.pdu(h.id)!;
      expect([pdu.get('ipv4.protocol'), pdu.get('ipv4.src'), pdu.get('ipv4.dst')]).toEqual([IPPROTO_OSPF, R2_WAN, '224.0.0.5']);
    }
    // every packet the list dropped is one of R2's OSPF packets; the implicit row counted each one
    for (const d of drops) expect(sim.pdu(d.pdu.id)!.get('ipv4.protocol')).toBe(IPPROTO_OSPF);
    expect(aclRow(sim, 'r1', aclKey(4, '10', 'implicit'))!.matches).toBe(drops.length);
    expect(aclRow(sim, 'r1', aclKey(4, '10', 10))!.matches).toBe(0);
    expect(sim.device('r1')!.port(GI1)!.counters.aclDenies).toBe(drops.length);
    // no ICMP answers a multicast: any 3/13 R1 sent answers one of R2's unicast packets
    const unicastDrops = drops.filter((d) => !isIpv4Multicast(String(sim.pdu(d.pdu.id)!.get('ipv4.dst'))));
    expect(adminProhibited(sim, evs, 'r1').length).toBeLessThanOrEqual(unicastDrops.length);

    // Down by the inactivity timer exactly one dead interval after the last hello R1 accepted
    const down = nbrTransitions(evs, 'r1').find((f) => f.to === 'down')!;
    expect(down).toMatchObject({ subject: `${GI1} ${R2_LOOPBACK}`, cause: 'InactivityTimer' });
    expect(down.t - lastAccepted.t).toBeGreaterThanOrEqual(DEAD_NS);
    expect(down.t - lastAccepted.t).toBeLessThan(DEAD_NS + 1_000_000);
    expect(neighbors(sim, 'r1')).toEqual([]);
    // the routes are withdrawn; R2 still hears R1, whose hellos no longer name it, so it drops back to Init
    expect(ospfRoutes(sim, 'r1')).toEqual([]);
    expect(neighbors(sim, 'r2').map((n) => [n.routerId, n.state])).toEqual([['1.1.1.1', 'init']]);
    expect(pingFrom(sim, 'pc1', R2_LOOPBACK).text).toContain(`Sent ${PING_COUNT}, received 0`);

    // permitting the neighbour restores the adjacency and the routes; its packets count on the new entry
    const c2 = mark(sim);
    cfg(sim, 'r1', ['access-list 10 permit host 10.0.12.2']);
    // nothing happens until R2's next hello (a periodic timer, which does not hold runToIdle), then the adjacency forms
    sim.runFor(OSPF_HELLO_S_DEFAULT * SEC);
    sim.runToIdle();
    const after = since(sim, c2);
    expect(dropsAt(after, 'r1', 'acl-deny')).toEqual([]);
    expect(nbrTransitions(after, 'r1').at(-1)).toMatchObject({ subject: `${GI1} ${R2_LOOPBACK}`, to: 'full' });
    expect(neighbors(sim, 'r1').map((n) => [n.routerId, n.state])).toEqual([[R2_LOOPBACK, 'full']]);
    expect(neighbors(sim, 'r2').map((n) => [n.routerId, n.state])).toEqual([['1.1.1.1', 'full']]);
    expect(ospfRoutes(sim, 'r1').map((r) => [r.key, r.nextHop, r.iface])).toEqual([[`${R2_LOOPBACK}/32`, R2_WAN, GI1]]);
    expect(aclRow(sim, 'r1', aclKey(4, '10', 20))!.matches).toBeGreaterThan(0);
    expect(aclRow(sim, 'r1', aclKey(4, '10', 20))).toMatchObject({ entry: 'permit 10.0.12.2', lastIface: GI1, lastDir: 'in' });
    // the route is back, but the list still permits only what it names: the replies from 2.2.2.2 die by the implicit deny
    const ping = pingFrom(sim, 'pc1', R2_LOOPBACK);
    expect(ping.text).toContain(`Sent ${PING_COUNT}, received 0`);
    const replies = dropsAt(ping.evs, 'r1', 'acl-deny');
    expect(replies).toHaveLength(PING_COUNT);
    for (const d of replies) {
      expect([d.port, d.rule?.seq]).toEqual([GI1, 'implicit']);
      expect([sim.pdu(d.pdu.id)!.get('ipv4.src'), sim.pdu(d.pdu.id)!.get('icmpv4.type')]).toEqual([R2_LOOPBACK, 0]);
    }
  });
});
