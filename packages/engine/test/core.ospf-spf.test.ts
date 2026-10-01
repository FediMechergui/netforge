// core/ospf-spf (ARCHITECTURE-P3 D10, §3.1, §3.2, §4.5; RFC 2328 §16.1, §16.1.1, §16.4; §7 W1 core): the RFC's example
// network (its Figure 3 directed graph, from RT6: the distances and next hops of its Table 2), the brief's own
// examples, the §16.1 step (3) tie order (network before router, then vertex id as u32), ECMP next hops in port
// order, the bidirectional check, MaxAge, type-2 external routes, and the stepper whose last frame is the tree.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ospfLsaKey, type OspfLsaRow, type OspfRouterLink } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { LSA_INITIAL_SEQ } from '../src/core/ospf-lsa.js';
import {
  buildSpfGraph,
  ospfRoutes,
  runSpf,
  spfNetworkKey,
  spfRouterKey,
  spfSteps,
  type SpfRootIface,
} from '../src/core/ospf-spf.js';

const AREA = '0.0.0.0';
const base = { updatedAt: 0, seq: LSA_INITIAL_SEQ, ageAtInstall: 0, installedAt: 0, checksum: 0, length: 0, options: 2, self: false };
type L = [OspfRouterLink['kind'], string, string, number];
const R = (rid: string, links: L[], extra: Partial<OspfLsaRow> = {}): OspfLsaRow => ({
  ...base,
  key: ospfLsaKey(AREA, 1, rid, rid),
  scope: AREA,
  type: 1,
  lsid: rid,
  advRouter: rid,
  flags: { b: false, e: false, v: false },
  links: links.map(([kind, id, data, metric]) => ({ kind, id, data, metric })),
  ...extra,
});
const N = (dr: string, adv: string, mask: string, attached: string[], extra: Partial<OspfLsaRow> = {}): OspfLsaRow => ({
  ...base,
  key: ospfLsaKey(AREA, 2, dr, adv),
  scope: AREA,
  type: 2,
  lsid: dr,
  advRouter: adv,
  mask,
  attached,
  ...extra,
});
const X = (adv: string, prefix: string, mask: string, metric: number, e2 = true, forward = '0.0.0.0'): OspfLsaRow => ({
  ...base,
  key: ospfLsaKey('as', 5, prefix, adv),
  scope: 'as',
  type: 5,
  lsid: prefix,
  advRouter: adv,
  mask,
  metric,
  external: { e2, forward, tag: 0 },
});
const M24 = '255.255.255.0';
const M30 = '255.255.255.252';
const M32 = '255.255.255.255';

// ── RFC 2328 §2.1.1, Figure 3 (the directed graph of Figure 2's single-area view), with addresses chosen here ──
//    transit networks N3, N6, N8, N9 (DR = the highest-numbered router), point-to-point links as /30s, stubs.
const RID = (n: number): string => `${n}.${n}.${n}.${n}`;
const rfc: OspfLsaRow[] = [
  R(RID(1), [['transit', '192.1.3.4', '192.1.3.1', 1], ['stub', '192.1.1.0', M24, 3]]),
  R(RID(2), [['transit', '192.1.3.4', '192.1.3.2', 1], ['stub', '192.1.2.0', M24, 3]]),
  R(RID(3), [['transit', '192.1.3.4', '192.1.3.3', 1], ['p2p', RID(6), '10.3.6.1', 8], ['stub', '192.1.4.0', M24, 2]]),
  R(RID(4), [['transit', '192.1.3.4', '192.1.3.4', 1], ['p2p', RID(5), '10.4.5.1', 8]]),
  R(RID(5), [
    ['p2p', RID(4), '10.4.5.2', 8], ['p2p', RID(6), '10.5.6.1', 7], ['p2p', RID(7), '10.5.7.1', 6],
    ['stub', '192.1.12.0', M24, 8], ['stub', '192.1.13.0', M24, 8], ['stub', '192.1.14.0', M24, 8],
  ]),
  R(RID(6), [['p2p', RID(3), '10.3.6.2', 6], ['p2p', RID(5), '10.5.6.2', 6], ['p2p', RID(10), '10.6.10.1', 7], ['stub', '10.6.10.2', M32, 7]]),
  R(RID(7), [['p2p', RID(5), '10.5.7.2', 6], ['transit', '192.1.6.10', '192.1.6.7', 1], ['stub', '192.1.12.0', M24, 2], ['stub', '192.1.15.0', M24, 9]]),
  R(RID(8), [['transit', '192.1.6.10', '192.1.6.8', 1], ['stub', '192.1.7.0', M24, 4]]),
  R(RID(9), [['transit', '192.1.9.12', '192.1.9.9', 1], ['stub', '192.1.11.0', M24, 3]]),
  R(RID(10), [['transit', '192.1.6.10', '192.1.6.10', 1], ['transit', '192.1.8.11', '192.1.8.10', 3], ['p2p', RID(6), '10.6.10.2', 5], ['stub', '10.6.10.1', M32, 5]]),
  R(RID(11), [['transit', '192.1.8.11', '192.1.8.11', 2], ['transit', '192.1.9.12', '192.1.9.11', 1]]),
  R(RID(12), [['transit', '192.1.9.12', '192.1.9.12', 1], ['stub', '192.1.10.0', M24, 2], ['stub', '192.1.100.1', M32, 10]]),
  N('192.1.3.4', RID(4), M24, [RID(4), RID(1), RID(2), RID(3)]),
  N('192.1.6.10', RID(10), M24, [RID(10), RID(7), RID(8)]),
  N('192.1.8.11', RID(11), M24, [RID(11), RID(10)]),
  N('192.1.9.12', RID(12), M24, [RID(12), RID(9), RID(11)]),
];
const RT6_IFACES: SpfRootIface[] = [
  { port: 'Serial0/0/0', address: '10.3.6.2' },
  { port: 'Serial0/0/1', address: '10.5.6.2' },
  { port: 'Serial0/1/0', address: '10.6.10.1' },
];

describe('core/ospf-spf: RFC 2328 example network, from RT6', () => {
  const graph = buildSpfGraph(rfc, AREA);
  const result = runSpf(graph, RID(6), RT6_IFACES);

  it('settles every vertex in the §16.1 order: cost, network before router, id as u32', () => {
    expect(result.tree.root).toBe(RID(6));
    expect(result.tree.vertices.map((v) => `${v.key}=${v.cost}`)).toEqual([
      'R:6.6.6.6=0', 'R:3.3.3.3=6', 'R:5.5.5.5=6', 'N:192.1.3.4=7', 'R:1.1.1.1=7', 'R:2.2.2.2=7', 'R:4.4.4.4=7',
      'R:10.10.10.10=7', 'N:192.1.6.10=8', 'R:7.7.7.7=8', 'R:8.8.8.8=8', 'N:192.1.8.11=10', 'R:11.11.11.11=10',
      'N:192.1.9.12=11', 'R:9.9.9.9=11', 'R:12.12.12.12=11',
    ]);
    // RT4 is reached through N3 (7), not over RT5's link (6 + 8); RT7 through N6 (8), not RT5 (12)
    const byKey = new Map(result.tree.vertices.map((v) => [v.key, v]));
    expect(byKey.get('R:4.4.4.4')).toEqual({ key: 'R:4.4.4.4', kind: 'router', id: RID(4), cost: 7, parent: 'N:192.1.3.4', nextHops: [{ iface: 'Serial0/0/0', nextHop: '10.3.6.1' }] });
    expect(byKey.get('R:7.7.7.7')!.parent).toBe('N:192.1.6.10');
    expect(byKey.get('R:6.6.6.6')).toEqual({ key: 'R:6.6.6.6', kind: 'router', id: RID(6), cost: 0, nextHops: [] });
    expect(result.nextHops.get('R:12.12.12.12')).toEqual([{ iface: 'Serial0/1/0', nextHop: '10.6.10.2' }]);
    expect(result.ifaceOrder).toEqual(['Serial0/0/0', 'Serial0/0/1', 'Serial0/1/0']);
  });

  it('gives RT6 the routes of the RFC routing table (Table 2), connected ones left out', () => {
    const via = (h: { iface: string; nextHop?: string }): string => `${h.nextHop} ${h.iface}`;
    const routes = ospfRoutes(graph, result).map((r) => `${r.network}/${r.prefixLen} [${r.cost}] ${r.nextHops.map(via).join(', ')}`);
    const RT3 = '10.3.6.1 Serial0/0/0';
    const RT5 = '10.5.6.1 Serial0/0/1';
    const RT10 = '10.6.10.2 Serial0/1/0';
    expect(routes).toEqual([
      `10.6.10.1/32 [12] ${RT10}`, // Ia
      `192.1.1.0/24 [10] ${RT3}`, // N1
      `192.1.2.0/24 [10] ${RT3}`, // N2
      `192.1.3.0/24 [7] ${RT3}`, // N3
      `192.1.4.0/24 [8] ${RT3}`, // N4
      `192.1.6.0/24 [8] ${RT10}`, // N6
      `192.1.7.0/24 [12] ${RT10}`, // N7
      `192.1.8.0/24 [10] ${RT10}`, // N8
      `192.1.9.0/24 [11] ${RT10}`, // N9
      `192.1.10.0/24 [13] ${RT10}`, // N10
      `192.1.11.0/24 [14] ${RT10}`, // N11
      `192.1.12.0/24 [10] ${RT10}`, // N12 via RT7 (8 + 2), not RT5 (6 + 8)
      `192.1.13.0/24 [14] ${RT5}`, // N13
      `192.1.14.0/24 [14] ${RT5}`, // N14
      `192.1.15.0/24 [17] ${RT10}`, // N15
      `192.1.100.1/32 [21] ${RT10}`, // H1
    ]);
  });

  it('from RT10 the same graph gives the reverse distances', () => {
    const r = runSpf(graph, RID(10), [{ port: 'Gi0/0', address: '192.1.6.10' }, { port: 'Gi0/1', address: '192.1.8.10' }, { port: 'Se0/0/0', address: '10.6.10.2' }]);
    const cost = new Map(r.tree.vertices.map((v) => [v.key, v.cost]));
    expect([cost.get('R:6.6.6.6'), cost.get('R:3.3.3.3'), cost.get('R:5.5.5.5'), cost.get('R:7.7.7.7'), cost.get('R:12.12.12.12')]).toEqual([5, 11, 7, 1, 4]);
    const n6 = r.tree.vertices.find((v) => v.key === 'N:192.1.6.10')!;
    expect(n6.nextHops).toEqual([{ iface: 'Gi0/0' }]);
    // RT5 is reached through RT7 on N6 (1 + 6): next hop = RT7's address on N6
    expect(r.nextHops.get('R:5.5.5.5')).toEqual([{ iface: 'Gi0/0', nextHop: '192.1.6.7' }]);
  });

  it('the stepper runs the same computation: one frame per vertex, the last settled set is the tree', () => {
    const steps = spfSteps(graph, RID(6), RT6_IFACES);
    expect(steps.map((s) => s.settled)).toEqual(result.tree.vertices);
    expect(steps[0]!.relaxed).toEqual([
      { from: 'R:6.6.6.6', to: 'R:3.3.3.3', cost: 6, outcome: 'new' },
      { from: 'R:6.6.6.6', to: 'R:5.5.5.5', cost: 6, outcome: 'new' },
      { from: 'R:6.6.6.6', to: 'R:10.10.10.10', cost: 7, outcome: 'new' },
    ]);
    expect(steps[0]!.candidates.map((c) => c.key)).toEqual(['R:3.3.3.3', 'R:5.5.5.5', 'R:10.10.10.10']);
    // after RT5: N3 (7) and RT10 (7) tie; the network is listed and settled first
    expect(steps[2]!.candidates.map((c) => `${c.key}=${c.cost}`)).toEqual(['N:192.1.3.4=7', 'R:10.10.10.10=7', 'R:7.7.7.7=12', 'R:4.4.4.4=14']);
    expect(steps[3]!.relaxed.find((x) => x.to === 'R:4.4.4.4')).toEqual({ from: 'N:192.1.3.4', to: 'R:4.4.4.4', cost: 7, outcome: 'better' });
    expect(steps[steps.length - 1]!.candidates).toEqual([]);
  });
});

describe('core/ospf-spf: the brief’s examples', () => {
  // §3.2: R1 Gi0/0 – R2 Gi0/0 10.0.12.0/30 and R2 Gi0/1 – R3 Gi0/0 10.0.23.0/30 point-to-point (cost 1), R1 Se0/0/0 –
  // R3 Se0/0/0 10.0.13.0/30 (64); LANs R1 10.1.0.0/24, R3 10.3.0.0/24 (cost 1)
  const r1 = (withR2 = true): OspfLsaRow => R('1.1.1.1', [
    ...(withR2 ? ([['p2p', '2.2.2.2', '10.0.12.1', 1], ['stub', '10.0.12.0', M30, 1]] as L[]) : []),
    ['p2p', '3.3.3.3', '10.0.13.1', 64], ['stub', '10.0.13.0', M30, 64], ['stub', '10.1.0.0', M24, 1],
  ]);
  const r2 = (withR1 = true): OspfLsaRow => R('2.2.2.2', [
    ...(withR1 ? ([['p2p', '1.1.1.1', '10.0.12.2', 1], ['stub', '10.0.12.0', M30, 1]] as L[]) : []),
    ['p2p', '3.3.3.3', '10.0.23.1', 1], ['stub', '10.0.23.0', M30, 1],
  ]);
  const r3 = R('3.3.3.3', [
    ['p2p', '2.2.2.2', '10.0.23.2', 1], ['stub', '10.0.23.0', M30, 1], ['p2p', '1.1.1.1', '10.0.13.2', 64], ['stub', '10.0.13.0', M30, 64],
    ['stub', '10.3.0.0', M24, 1],
  ]);
  const R1_IFACES: SpfRootIface[] = [{ port: 'GigabitEthernet0/0', address: '10.0.12.1' }, { port: 'Serial0/0/0', address: '10.0.13.1' }];
  const show = (rows: OspfLsaRow[]): string[] => {
    const g = buildSpfGraph(rows, AREA);
    return ospfRoutes(g, runSpf(g, '1.1.1.1', R1_IFACES)).map((r) => `${r.network}/${r.prefixLen} [110/${r.cost}] via ${r.nextHops.map((h) => `${h.nextHop}, ${h.iface}`).join('; ')}`);
  };

  it('§3.2 converged: 10.3.0.0/24 [110/3] via 10.0.12.2, the serial path (65) not installed', () => {
    expect(show([r1(), r2(), r3])).toEqual([
      '10.0.23.0/30 [110/2] via 10.0.12.2, GigabitEthernet0/0',
      '10.3.0.0/24 [110/3] via 10.0.12.2, GigabitEthernet0/0',
    ]);
  });

  it('§3.2 failure: without the R1–R2 link the routes move to the serial link at 65', () => {
    expect(show([r1(false), r2(false), r3])).toEqual([
      '10.0.23.0/30 [110/65] via 10.0.13.2, Serial0/0/0',
      '10.3.0.0/24 [110/65] via 10.0.13.2, Serial0/0/0',
    ]);
  });

  it('§3.2 step 1, the bidirectional check: R2’s LSA without the link back keeps the new path out', () => {
    const rows = [r1(true), r2(false), r3];
    const g = buildSpfGraph(rows, AREA);
    const steps = spfSteps(g, '1.1.1.1', R1_IFACES);
    expect(steps[0]!.relaxed[0]).toEqual({ from: 'R:1.1.1.1', to: 'R:2.2.2.2', cost: 1, outcome: 'one-way' });
    const r = runSpf(g, '1.1.1.1', R1_IFACES);
    expect(r.tree.vertices.find((v) => v.key === 'R:2.2.2.2')).toMatchObject({ cost: 65, parent: 'R:3.3.3.3', nextHops: [{ iface: 'Serial0/0/0', nextHop: '10.0.13.2' }] });
    expect(show(rows)).toEqual(['10.0.23.0/30 [110/65] via 10.0.13.2, Serial0/0/0', '10.3.0.0/24 [110/65] via 10.0.13.2, Serial0/0/0']);
  });

  it('§3.1: the LAN with DR R2 gives the tree R1 → N 10.0.123.2 → R2 and no route', () => {
    const rows = [
      R('1.1.1.1', [['transit', '10.0.123.2', '10.0.123.1', 1]]),
      R('2.2.2.2', [['transit', '10.0.123.2', '10.0.123.2', 1]]),
      N('10.0.123.2', '2.2.2.2', M24, ['2.2.2.2', '1.1.1.1']),
    ];
    const g = buildSpfGraph(rows, AREA);
    const r = runSpf(g, '1.1.1.1', [{ port: 'GigabitEthernet0/0', address: '10.0.123.1' }]);
    expect(r.tree.vertices).toEqual([
      { key: 'R:1.1.1.1', kind: 'router', id: '1.1.1.1', cost: 0, nextHops: [] },
      { key: 'N:10.0.123.2', kind: 'network', id: '10.0.123.2', cost: 1, parent: 'R:1.1.1.1', nextHops: [{ iface: 'GigabitEthernet0/0' }] },
      { key: 'R:2.2.2.2', kind: 'router', id: '2.2.2.2', cost: 1, parent: 'N:10.0.123.2', nextHops: [{ iface: 'GigabitEthernet0/0', nextHop: '10.0.123.2' }] },
    ]);
    expect(ospfRoutes(g, r)).toEqual([]);
    // a network LSA that does not list R1 is one-way: R2 is unreachable
    const stale = buildSpfGraph([rows[0]!, rows[1]!, N('10.0.123.2', '2.2.2.2', M24, ['2.2.2.2'])], AREA);
    expect(runSpf(stale, '1.1.1.1').tree.vertices.map((v) => v.key)).toEqual(['R:1.1.1.1']);
  });
});

describe('core/ospf-spf: the tie order and ECMP', () => {
  it('network before router at equal cost, then the id as u32 (not as text), so every parent is known', () => {
    // R1: p2p to 10.0.0.9 (cost 1) and transit N (DR 10.0.1.3, cost 1) where 9.0.0.10 sits; 10.0.0.9 and 9.0.0.10
    // both reach 4.4.4.4 at cost 1
    const rows = [
      R('1.1.1.1', [['p2p', '10.0.0.9', '10.1.2.1', 1], ['transit', '10.0.1.3', '10.0.1.1', 1]]),
      R('10.0.0.9', [['p2p', '1.1.1.1', '10.1.2.2', 1], ['p2p', '4.4.4.4', '10.2.4.1', 1]]),
      R('9.0.0.10', [['transit', '10.0.1.3', '10.0.1.3', 0], ['p2p', '4.4.4.4', '10.3.4.1', 1]]),
      R('4.4.4.4', [['p2p', '10.0.0.9', '10.2.4.2', 1], ['p2p', '9.0.0.10', '10.3.4.2', 1], ['stub', '10.4.0.0', M24, 1]]),
      N('10.0.1.3', '9.0.0.10', M24, ['9.0.0.10', '1.1.1.1']),
    ];
    const ifaces: SpfRootIface[] = [{ port: 'Gi0/0', address: '10.0.1.1' }, { port: 'Gi0/1', address: '10.1.2.1' }];
    const r = runSpf(buildSpfGraph(rows, AREA), '1.1.1.1', ifaces);
    expect(r.tree.vertices.map((v) => `${v.key}=${v.cost}`)).toEqual(['R:1.1.1.1=0', 'N:10.0.1.3=1', 'R:9.0.0.10=1', 'R:10.0.0.9=1', 'R:4.4.4.4=2']);
    expect(r.nextHops.get('R:4.4.4.4')).toEqual([{ iface: 'Gi0/0', nextHop: '10.0.1.3' }, { iface: 'Gi0/1', nextHop: '10.1.2.2' }]);
    // the ECMP route keeps both paths in port order; maximum-paths cuts it
    const g = buildSpfGraph(rows, AREA);
    expect(ospfRoutes(g, r)).toEqual([{ network: '10.4.0.0', prefixLen: 24, cost: 3, nextHops: [{ iface: 'Gi0/0', nextHop: '10.0.1.3' }, { iface: 'Gi0/1', nextHop: '10.1.2.2' }] }]);
    expect(ospfRoutes(g, r, { maximumPaths: 1 })[0]!.nextHops).toEqual([{ iface: 'Gi0/0', nextHop: '10.0.1.3' }]);
    // the port order comes from the caller
    const swapped = runSpf(g, '1.1.1.1', [...ifaces].reverse());
    expect(swapped.nextHops.get('R:4.4.4.4')).toEqual([{ iface: 'Gi0/1', nextHop: '10.1.2.2' }, { iface: 'Gi0/0', nextHop: '10.0.1.3' }]);
  });

  it('two next hops on one port are ordered by address as u32', () => {
    const rows = [
      R('1.1.1.1', [['transit', '10.0.0.1', '10.0.0.1', 1]]),
      R('2.2.2.2', [['transit', '10.0.0.1', '10.0.0.10', 1], ['p2p', '4.4.4.4', '10.2.4.1', 5]]),
      R('3.3.3.3', [['transit', '10.0.0.1', '10.0.0.2', 1], ['p2p', '4.4.4.4', '10.3.4.1', 5]]),
      R('4.4.4.4', [['p2p', '2.2.2.2', '10.2.4.2', 5], ['p2p', '3.3.3.3', '10.3.4.2', 5], ['stub', '10.4.4.4', M32, 1]]),
      N('10.0.0.1', '1.1.1.1', M24, ['1.1.1.1', '2.2.2.2', '3.3.3.3']),
    ];
    const g = buildSpfGraph(rows, AREA);
    const r = runSpf(g, '1.1.1.1', [{ port: 'Gi0/0', address: '10.0.0.1' }]);
    expect(ospfRoutes(g, r)).toEqual([{ network: '10.4.4.4', prefixLen: 32, cost: 7, nextHops: [{ iface: 'Gi0/0', nextHop: '10.0.0.2' }, { iface: 'Gi0/0', nextHop: '10.0.0.10' }] }]);
  });

  it('parallel point-to-point links to one neighbour give one next hop per link', () => {
    const rows = [
      R('1.1.1.1', [['p2p', '2.2.2.2', '10.0.1.1', 64], ['stub', '10.0.1.0', M30, 64], ['p2p', '2.2.2.2', '10.0.2.1', 64], ['stub', '10.0.2.0', M30, 64]]),
      R('2.2.2.2', [['p2p', '1.1.1.1', '10.0.2.2', 64], ['stub', '10.0.2.0', M30, 64], ['p2p', '1.1.1.1', '10.0.1.2', 64], ['stub', '10.0.1.0', M30, 64], ['stub', '10.2.0.0', M24, 1]]),
    ];
    const g = buildSpfGraph(rows, AREA);
    const r = runSpf(g, '1.1.1.1', [{ port: 'Serial0/0/0', address: '10.0.1.1' }, { port: 'Serial0/0/1', address: '10.0.2.1' }]);
    expect(r.nextHops.get('R:2.2.2.2')).toEqual([{ iface: 'Serial0/0/0', nextHop: '10.0.1.2' }, { iface: 'Serial0/0/1', nextHop: '10.0.2.2' }]);
    expect(ospfRoutes(g, r).map((x) => x.network)).toEqual(['10.2.0.0']);
  });

  it('without port data a root interface is named by its address', () => {
    const g = buildSpfGraph([
      R('1.1.1.1', [['p2p', '2.2.2.2', '10.0.12.1', 1]]),
      R('2.2.2.2', [['p2p', '1.1.1.1', '10.0.12.2', 1], ['stub', '10.2.0.0', M24, 1]]),
    ], AREA);
    expect(runSpf(g, '1.1.1.1').nextHops.get('R:2.2.2.2')).toEqual([{ iface: '10.0.12.1', nextHop: '10.0.12.2' }]);
  });
});

describe('core/ospf-spf: the LSDB the run reads', () => {
  it('leaves out MaxAge copies, other areas, and router LSAs whose id is not their router', () => {
    const rows = [
      R('1.1.1.1', [['p2p', '2.2.2.2', '10.0.12.1', 1]]),
      R('2.2.2.2', [['p2p', '1.1.1.1', '10.0.12.2', 1], ['stub', '10.2.0.0', M24, 1]], { maxAge: true }),
      R('3.3.3.3', [], { scope: '0.0.0.1' }),
      R('4.4.4.4', [], { lsid: '4.4.4.5' }),
    ];
    const g = buildSpfGraph(rows, AREA);
    expect([...g.routers.keys()]).toEqual(['1.1.1.1']);
    expect(runSpf(g, '1.1.1.1').tree.vertices.map((v) => v.key)).toEqual(['R:1.1.1.1']);
    // with `now`, a copy whose live age reached MaxAge is left out too
    const aged = [R('1.1.1.1', []), R('2.2.2.2', [], { ageAtInstall: 3000, installedAt: 0 })];
    expect([...buildSpfGraph(aged, AREA, 599 * SEC).routers.keys()]).toEqual(['1.1.1.1', '2.2.2.2']);
    expect([...buildSpfGraph(aged, AREA, 600 * SEC).routers.keys()]).toEqual(['1.1.1.1']);
    // of two network LSAs with one id, the higher advertising router id (u32) is used
    const two = buildSpfGraph([N('10.0.0.1', '9.0.0.0', M24, []), N('10.0.0.1', '10.0.0.0', M24, [])], AREA);
    expect(two.networks.get('10.0.0.1')!.advRouter).toBe('10.0.0.0');
  });

  it('a root without a router LSA is a tree of one vertex', () => {
    const r = runSpf(buildSpfGraph([], AREA), '1.1.1.1');
    expect(r.tree).toEqual({ root: '1.1.1.1', vertices: [{ key: 'R:1.1.1.1', kind: 'router', id: '1.1.1.1', cost: 0, nextHops: [] }] });
    expect(spfSteps(buildSpfGraph([], AREA), '1.1.1.1')).toHaveLength(1);
    expect([spfRouterKey('1.1.1.1'), spfNetworkKey('10.0.0.1')]).toEqual(['R:1.1.1.1', 'N:10.0.0.1']);
  });
});

describe('core/ospf-spf: type-2 external routes (default-information originate)', () => {
  const tri = [
    R('1.1.1.1', [['p2p', '2.2.2.2', '10.0.12.1', 1], ['p2p', '3.3.3.3', '10.0.13.1', 10]]),
    R('2.2.2.2', [['p2p', '1.1.1.1', '10.0.12.2', 1], ['p2p', '3.3.3.3', '10.0.23.1', 1]], { flags: { b: false, e: true, v: false } }),
    R('3.3.3.3', [['p2p', '2.2.2.2', '10.0.23.2', 1], ['p2p', '1.1.1.1', '10.0.13.2', 10], ['stub', '10.3.0.0', M24, 1]]),
  ];
  const ifaces: SpfRootIface[] = [{ port: 'Gi0/0', address: '10.0.12.1' }, { port: 'Gi0/1', address: '10.0.13.1' }];
  const routes = (extra: OspfLsaRow[], opts?: { maximumPaths?: number }) => {
    const g = buildSpfGraph([...tri, ...extra], AREA);
    return ospfRoutes(g, runSpf(g, '1.1.1.1', ifaces), opts);
  };

  it('O*E2 0.0.0.0/0 [110/1] via the ASBR, after the intra-area routes', () => {
    expect(routes([X('2.2.2.2', '0.0.0.0', '0.0.0.0', 1)])).toEqual([
      { network: '0.0.0.0', prefixLen: 0, cost: 1, routeType: 'E2', forwardCost: 1, nextHops: [{ iface: 'Gi0/0', nextHop: '10.0.12.2' }] },
      { network: '10.3.0.0', prefixLen: 24, cost: 3, nextHops: [{ iface: 'Gi0/0', nextHop: '10.0.12.2' }] },
    ]);
  });

  it('the lowest E2 metric wins, then the lowest forwarding cost; ties merge', () => {
    // R3 at forwarding cost 2, R2 at 1: equal metrics → R2
    expect(routes([X('3.3.3.3', '0.0.0.0', '0.0.0.0', 1), X('2.2.2.2', '0.0.0.0', '0.0.0.0', 1)])[0]).toMatchObject({ cost: 1, forwardCost: 1, nextHops: [{ iface: 'Gi0/0', nextHop: '10.0.12.2' }] });
    // a lower metric wins whatever the forwarding cost
    expect(routes([X('2.2.2.2', '0.0.0.0', '0.0.0.0', 20), X('3.3.3.3', '0.0.0.0', '0.0.0.0', 5)])[0]).toMatchObject({ cost: 5, forwardCost: 2 });
  });

  it('ignores its own externals, unreachable ASBRs, type-1 externals, and a prefix with an intra-area route', () => {
    expect(routes([X('1.1.1.1', '0.0.0.0', '0.0.0.0', 1)]).map((r) => r.network)).toEqual(['10.3.0.0']);
    expect(routes([X('9.9.9.9', '0.0.0.0', '0.0.0.0', 1)]).map((r) => r.network)).toEqual(['10.3.0.0']);
    expect(routes([X('2.2.2.2', '0.0.0.0', '0.0.0.0', 1, false)]).map((r) => r.network)).toEqual(['10.3.0.0']);
    expect(routes([X('2.2.2.2', '10.3.0.0', M24, 1)])).toEqual([{ network: '10.3.0.0', prefixLen: 24, cost: 3, nextHops: [{ iface: 'Gi0/0', nextHop: '10.0.12.2' }] }]);
    expect(routes([X('2.2.2.2', '0.0.0.0', '0.0.0.0', 1, true)], { maximumPaths: 0 })[0]!.nextHops).toHaveLength(1);
  });

  it('a forwarding address is reached through the intra-area route that holds it', () => {
    const r = routes([X('2.2.2.2', '172.16.0.0', '255.255.0.0', 7, true, '10.3.0.9')]);
    expect(r.find((x) => x.network === '172.16.0.0')).toEqual({ network: '172.16.0.0', prefixLen: 16, cost: 7, routeType: 'E2', forwardCost: 3, nextHops: [{ iface: 'Gi0/0', nextHop: '10.0.12.2' }] });
    expect(routes([X('2.2.2.2', '172.16.0.0', '255.255.0.0', 7, true, '10.99.0.1')]).map((x) => x.network)).toEqual(['10.3.0.0']);
  });

  it('a forwarding address on a network the root is on is reached directly, with the address as next hop (§16.4 (3))', () => {
    // R1 10.0.0.1 and R3 10.0.0.3 on the transit LAN 10.0.0.0/24 whose DR is the ASBR R2 10.0.0.2
    const lan = [
      R('1.1.1.1', [['transit', '10.0.0.2', '10.0.0.1', 1]]),
      R('2.2.2.2', [['transit', '10.0.0.2', '10.0.0.2', 1]], { flags: { b: false, e: true, v: false } }),
      R('3.3.3.3', [['transit', '10.0.0.2', '10.0.0.3', 1], ['stub', '10.3.0.0', M24, 1]]),
      N('10.0.0.2', '2.2.2.2', M24, ['2.2.2.2', '1.1.1.1', '3.3.3.3']),
      X('2.2.2.2', '0.0.0.0', '0.0.0.0', 1, true, '10.0.0.3'),
      X('2.2.2.2', '172.16.0.0', '255.255.0.0', 5),
    ];
    const g = buildSpfGraph(lan, AREA);
    expect(ospfRoutes(g, runSpf(g, '1.1.1.1', [{ port: 'Gi0/0', address: '10.0.0.1' }]))).toEqual([
      { network: '0.0.0.0', prefixLen: 0, cost: 1, routeType: 'E2', forwardCost: 1, nextHops: [{ iface: 'Gi0/0', nextHop: '10.0.0.3' }] },
      { network: '10.3.0.0', prefixLen: 24, cost: 2, nextHops: [{ iface: 'Gi0/0', nextHop: '10.0.0.3' }] },
      { network: '172.16.0.0', prefixLen: 16, cost: 5, routeType: 'E2', forwardCost: 1, nextHops: [{ iface: 'Gi0/0', nextHop: '10.0.0.2' }] },
    ]);
    // the root's own stub networks: a point-to-point subnet and a passive LAN, at the link's cost
    const p2p = [
      R('1.1.1.1', [['p2p', '2.2.2.2', '10.0.12.1', 64], ['stub', '10.0.12.0', M30, 64], ['stub', '10.1.0.0', M24, 1]]),
      R('2.2.2.2', [['p2p', '1.1.1.1', '10.0.12.2', 64], ['stub', '10.0.12.0', M30, 64]], { flags: { b: false, e: true, v: false } }),
      X('2.2.2.2', '0.0.0.0', '0.0.0.0', 1, true, '10.0.12.2'),
      X('2.2.2.2', '192.168.9.0', M24, 3, true, '10.1.0.5'),
      X('2.2.2.2', '192.168.8.0', M24, 3, true, '10.1.0.1'),
    ];
    const g2 = buildSpfGraph(p2p, AREA);
    const ifaces: SpfRootIface[] = [{ port: 'Serial0/0/0', address: '10.0.12.1' }, { port: 'Gi0/1', address: '10.1.0.1' }];
    expect(ospfRoutes(g2, runSpf(g2, '1.1.1.1', ifaces))).toEqual([
      { network: '0.0.0.0', prefixLen: 0, cost: 1, routeType: 'E2', forwardCost: 64, nextHops: [{ iface: 'Serial0/0/0', nextHop: '10.0.12.2' }] },
      // 192.168.8.0/24's forwarding address is the root's own address: not used
      { network: '192.168.9.0', prefixLen: 24, cost: 3, routeType: 'E2', forwardCost: 1, nextHops: [{ iface: 'Gi0/1', nextHop: '10.1.0.5' }] },
    ]);
  });
});

describe('core/ospf-spf: integer discipline (§4.5)', () => {
  it('core/ospf-* uses no floating-point maths, exponentiation, randomness or clocks', () => {
    const BANNED = /Math\.(log10|log2|log|pow|exp|random)\s*\(|Date\.now|performance\.now|new Date\(|setTimeout|[\w)\]]\s*\*\*\s*[\w(]/;
    const dir = new URL('../src/core/', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.startsWith('ospf-') && f.endsWith('.ts')).sort();
    expect(files).toEqual(['ospf-lsa.ts', 'ospf-spf.ts']);
    for (const f of files) expect(readFileSync(new URL(f, dir), 'utf8'), f).not.toMatch(BANNED);
  });
});
