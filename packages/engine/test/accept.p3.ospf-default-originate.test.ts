/**
 * P3 acceptance — `default-information originate [always]` (ARCHITECTURE-P3 §10.1 `accept.p3.ospf-default-originate`;
 * D8, D11, §2.6, §5.1, §5.8; RFC 2328 §12.4.4, §14; §7 W4 qa).
 *
 * R1 (the edge: Gi0/1 toward the provider host 10.9.9.2, `ip route 0.0.0.0 0.0.0.0 10.9.9.2`, `default-information
 * originate`) – R2 – R3 on GigE point-to-point links, and R4 on a broadcast cable to R3's Gi0/1 (a DR segment). Pinned:
 *   • `O*E2 0.0.0.0/0 [110/1]` on every other router (`show ip route`: the row and the `Default route:` line), from the
 *     one AS-external LSA 0.0.0.0/0 of 1.1.1.1 (E2, metric 1) in every database; the originator keeps its static;
 *   • removing the static (typed) flushes the type-5 LSA: R1 floods it at MaxAge (age 3600) at once, every router
 *     floods the MaxAge copy on, the defaults go with the next SPF, and the rows are removed everywhere;
 *   • `always` keeps it: with `default-information originate always` removing the static flushes nothing and every
 *     other router keeps `O*E2 0.0.0.0/0 [110/1]`; `always` originates without any default route.
 * Worlds: `staged.world` at stage P3 with the flip's daemons (ospf.accept.harness.ts).
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { RouteRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { acceptWorld, configureOk, showLines, traceSince } from './ospf.accept.harness.js';
import { addRouter, cursor, GI0, GI1, iface, ifRow, lsdbRows, MS_NS, ospfCreated, ospfRoutes, ribRow, startup, tableEvents } from './ospf.harness.js';

const P2P = ['ip ospf network point-to-point'];
const MASK30 = '255.255.255.252';
const STATIC = 'ip route 0.0.0.0 0.0.0.0 10.9.9.2';
const EXT_KEY = 'as|5|0.0.0.0|1.1.1.1';

/** The world of the file header, converged; `always` puts `always` on R1's line; `staticRoute: false` omits the static. */
function world(seed: number, opts: { always?: boolean; staticRoute?: boolean } = {}): Simulation {
  const sim = acceptWorld(seed);
  addRouter(sim, 'r1', 'R1', [
    iface(GI0, '10.0.12.1', MASK30, P2P),
    iface(GI1, '10.9.9.1', MASK30),
    ...(opts.staticRoute === false ? [] : [[STATIC]]),
    ['router ospf 1', ' router-id 1.1.1.1', ' network 10.0.12.0 0.0.0.3 area 0', ` default-information originate${opts.always === true ? ' always' : ''}`],
  ]);
  addRouter(sim, 'r2', 'R2', [
    iface(GI0, '10.0.12.2', MASK30, P2P),
    iface(GI1, '10.0.23.1', MASK30, P2P),
    ['router ospf 1', ' router-id 2.2.2.2', ' network 10.0.0.0 0.255.255.255 area 0'],
  ]);
  addRouter(sim, 'r3', 'R3', [
    iface(GI0, '10.0.23.2', MASK30, P2P),
    iface(GI1, '10.0.34.3', '255.255.255.0'),
    ['router ospf 1', ' router-id 3.3.3.3', ' network 10.0.0.0 0.255.255.255 area 0'],
  ]);
  addRouter(sim, 'r4', 'R4', [iface(GI0, '10.0.34.4', '255.255.255.0'), ['router ospf 1', ' router-id 4.4.4.4', ' network 10.0.0.0 0.255.255.255 area 0']]);
  sim.addDevice({ id: 'isp', type: 'pc.nfpc', name: 'ISP', startupConfig: startup([['hostname ISP'], ['interface GigabitEthernet0', ' ip address 10.9.9.2 255.255.255.252']]) });
  sim.addLink({ a: { device: 'r1', port: GI0 }, b: { device: 'r2', port: GI0 } });
  sim.addLink({ a: { device: 'r2', port: GI1 }, b: { device: 'r3', port: GI0 } });
  sim.addLink({ a: { device: 'r3', port: GI1 }, b: { device: 'r4', port: GI0 } });
  sim.addLink({ a: { device: 'r1', port: GI1 }, b: { device: 'isp', port: 'GigabitEthernet0' } });
  sim.runFor(90 * SEC);
  expect(sim.runToIdle().stopped).toBeUndefined();
  sim.runFor(30 * SEC); // past the SPF hold of the convergence
  return sim;
}

/** Each other router, its upstream next hop and egress port toward R1. */
const OTHERS: readonly (readonly [DeviceId, string, string])[] = [
  ['r2', '10.0.12.1', GI0],
  ['r3', '10.0.23.1', GI0],
  ['r4', '10.0.34.3', GI0],
];

function expectDefaults(sim: Simulation): void {
  for (const [d, via, port] of OTHERS) {
    expect(ribRow(sim, d, '0.0.0.0/0'), d).toMatchObject({ source: 'O', routeType: 'E2', isDefault: true, ad: 110, metric: 1, nextHop: via, iface: port });
    const out = showLines(sim, d, 'show ip route');
    expect(out.find((l) => l.startsWith('Default route:'))).toBe(`Default route: via ${via} (O*E2)`);
    expect(out.filter((l) => l.includes(' 0.0.0.0/0 '))).toEqual([`O*E2 0.0.0.0/0  via ${via} [110/1] ${port}`]);
  }
  for (const d of ['r1', 'r2', 'r3', 'r4']) {
    expect(lsdbRows(sim, d).filter((r) => r.type === 5).map((r) => [r.key, r.mask, r.metric, r.external, r.self, r.maxAge])).toEqual([
      [EXT_KEY, '0.0.0.0', 1, { e2: true, forward: '0.0.0.0', tag: 0 }, d === 'r1', undefined],
    ]);
  }
}

const noDefaults = (sim: Simulation): void => {
  for (const [d] of OTHERS) {
    expect(ribRow(sim, d, '0.0.0.0/0'), d).toBeUndefined();
    expect(showLines(sim, d, 'show ip route').find((l) => l.startsWith('Default route:'))).toBe('Default route: none configured');
  }
  for (const d of ['r1', 'r2', 'r3', 'r4']) expect(lsdbRows(sim, d).filter((r) => r.type === 5), d).toEqual([]);
};

/** The OSPF updates `device` created that carry the external default at MaxAge. */
function maxAgeFloods(sim: Simulation, evs: readonly TraceEvent[], device: DeviceId) {
  return ospfCreated(evs, device).filter(
    (p) => p.kind === 'lsu' && sim.pdu(p.pdu)!.layers.some((l) => l.proto === 'ospf-lsa' && l.fields.lsType === 5 && l.fields.lsid === '0.0.0.0' && l.fields.age === 3600),
  );
}

describe('accept.p3.ospf-default-originate', () => {
  it('O*E2 0.0.0.0/0 [110/1] on every other router; the originator keeps its static and installs no OSPF default', () => {
    const sim = world(61);
    expectDefaults(sim);
    expect(ribRow(sim, 'r1', '0.0.0.0/0')).toMatchObject({ source: 'S', ad: 1, nextHop: '10.9.9.2' });
    expect(ospfRoutes(sim, 'r1').filter((r) => r.prefixLen === 0)).toEqual([]);
    expect(showLines(sim, 'r1', 'show ip route').find((l) => l.startsWith('Default route:'))).toBe('Default route: via 10.9.9.2 (S*)');
    // the E bit of the originator's router-LSA
    expect(lsdbRows(sim, 'r3').find((r) => r.key === '0.0.0.0|1|1.1.1.1|1.1.1.1')!.flags).toEqual({ b: false, e: true, v: false });
  });

  it('removing the static flushes the type-5 LSA: a MaxAge flood from R1 at once and onward, the defaults gone with the next SPF, the rows removed', () => {
    const sim = world(62);
    const c = cursor(sim);
    const T = sim.now;
    configureOk(sim, 'r1', ['no ' + STATIC]);
    expect(sim.runToIdle().stopped).toBeUndefined();
    const evs = traceSince(sim, c);
    // R1 floods the LSA at MaxAge at once; the MaxAge copy is flooded on: by R2 to R3 (point-to-point, AllSPFRouters)
    // and by R3 to R4, the DR of the R3–R4 segment (R3 is not DR there, so AllDRouters)
    const r1Flush = maxAgeFloods(sim, evs, 'r1');
    expect(r1Flush.length).toBeGreaterThan(0);
    expect(r1Flush[0]!.t).toBe(T);
    expect(ifRow(sim, 'r4', GI0)!.state).toBe('dr');
    const onward = [...maxAgeFloods(sim, evs, 'r2'), ...maxAgeFloods(sim, evs, 'r3')];
    expect(onward.filter((p) => p.dst.startsWith('224.')).map((p) => `${p.device} ${p.dst}`).sort()).toEqual(['r2 224.0.0.5', 'r3 224.0.0.6']);
    for (const p of onward) expect(p.t - T).toBeLessThan(10 * MS_NS);
    // the defaults go with the next SPF (5 s after the flush arrived), on every other router
    for (const [d] of OTHERS) {
      const gone = tableEvents(evs, d, 'rib').filter((e) => e.kind === 'tableExpire' && e.key === '0.0.0.0/0');
      expect(gone, d).toHaveLength(1);
      expect(gone[0]!.t - T).toBeGreaterThanOrEqual(5 * SEC);
      expect(gone[0]!.t - T).toBeLessThan(5 * SEC + 10 * MS_NS);
    }
    noDefaults(sim);
    expect(lsdbRows(sim, 'r3').find((r) => r.key === '0.0.0.0|1|1.1.1.1|1.1.1.1')!.flags!.e).toBe(false);
    // the static back: the LSA and the routes return
    configureOk(sim, 'r1', [STATIC]);
    expect(sim.runToIdle().stopped).toBeUndefined();
    expectDefaults(sim);
  });

  it('`always` keeps it: removing the static flushes nothing and every other router keeps O*E2 0.0.0.0/0 [110/1]', () => {
    const sim = world(63, { always: true });
    expectDefaults(sim);
    const c = cursor(sim);
    configureOk(sim, 'r1', ['no ' + STATIC]);
    sim.runFor(60 * SEC);
    const evs = traceSince(sim, c);
    expect(ribRow(sim, 'r1', '0.0.0.0/0')).toBeUndefined();
    for (const d of ['r1', 'r2', 'r3', 'r4']) expect(maxAgeFloods(sim, evs, d)).toEqual([]);
    for (const [d] of OTHERS) expect(tableEvents(evs, d, 'rib').filter((e) => e.key === '0.0.0.0/0')).toEqual([]);
    expectDefaults(sim);
  });

  it('`always` originates without any default route; the plain form then flushes it', () => {
    const sim = world(64, { always: true, staticRoute: false });
    expect(ribRow(sim, 'r1', '0.0.0.0/0')).toBeUndefined();
    expectDefaults(sim);
    configureOk(sim, 'r1', ['router ospf 1', 'default-information originate']);
    expect(sim.runToIdle().stopped).toBeUndefined();
    noDefaults(sim);
    const r2 = ribRow(sim, 'r2', '0.0.0.0/0') as RouteRow | undefined;
    expect(r2).toBeUndefined();
  });
});
