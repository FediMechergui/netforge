/**
 * ospf.default-originate — `default-information originate [always]` on `staged.world` (ARCHITECTURE-P3 D8, D11, §2.6,
 * §5.1; RFC 2328 §12.4.4, §14; §7 W2 ospf): while the routing table holds a default route from another source (watched
 * with `ipv4.ribWatch {keys: ['0.0.0.0/0']}`), the router originates the AS-external LSA 0.0.0.0/0 (E2, metric 1) and
 * sets the E bit of its router-LSA; every other router installs `O*E2 0.0.0.0/0 [110/1]` (source 'O', routeType 'E2',
 * isDefault). Removing the static flushes the LSA (a MaxAge flood; the rows go once acknowledged) and the routes go;
 * `always` originates without any default route; an OSPF-learned default never counts as one.
 */
import { describe, expect, it } from 'vitest';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import {
  addRouter,
  cursor,
  eventsSince,
  GI0,
  GI1,
  iface,
  lsdbRows,
  ospfCreated,
  ospfRoutes,
  ospfView,
  ospfWorld,
  ribRow,
  setLine,
  startup,
} from './ospf.harness.js';

const P2P = ['ip ospf network point-to-point'];
const STATIC = ['ip', 'route', '0.0.0.0', '0.0.0.0', '10.9.9.2'];
const EXT_KEY = 'as|5|0.0.0.0|1.1.1.1';

/**
 * R1 (the edge, its Gi0/1 toward the provider PC 10.9.9.2) – R2 – R3 on GigE point-to-point links; R1 holds `ip route
 * 0.0.0.0 0.0.0.0 10.9.9.2` and `default-information originate` (`always` with `always`); R2 optionally its own
 * `default-information originate`.
 */
function world(opts: { always?: boolean; staticRoute?: boolean; r2Originates?: boolean } = {}): Simulation {
  const sim = ospfWorld(17);
  const area = ' network 10.0.0.0 0.255.255.255 area 0';
  addRouter(sim, 'r1', 'R1', [
    iface(GI0, '10.0.12.1', '255.255.255.252', P2P),
    iface(GI1, '10.9.9.1', '255.255.255.252'),
    ...(opts.staticRoute === false ? [] : [['ip route 0.0.0.0 0.0.0.0 10.9.9.2']]),
    ['router ospf 1', ' router-id 1.1.1.1', ' network 10.0.12.0 0.0.0.3 area 0', ` default-information originate${opts.always === true ? ' always' : ''}`],
  ]);
  addRouter(sim, 'r2', 'R2', [
    iface(GI0, '10.0.12.2', '255.255.255.252', P2P),
    iface(GI1, '10.0.23.1', '255.255.255.252', P2P),
    ['router ospf 1', ' router-id 2.2.2.2', area, ...(opts.r2Originates === true ? [' default-information originate'] : [])],
  ]);
  addRouter(sim, 'r3', 'R3', [iface(GI0, '10.0.23.2', '255.255.255.252', P2P), ['router ospf 1', ' router-id 3.3.3.3', area]]);
  sim.addDevice({ id: 'isp', type: 'pc.nfpc', name: 'ISP', startupConfig: startup([['hostname ISP'], ['interface GigabitEthernet0', ' ip address 10.9.9.2 255.255.255.252']]) });
  sim.addLink({ a: { device: 'r1', port: GI0 }, b: { device: 'r2', port: GI0 } });
  sim.addLink({ a: { device: 'r2', port: GI1 }, b: { device: 'r3', port: GI0 } });
  sim.addLink({ a: { device: 'r1', port: GI1 }, b: { device: 'isp', port: 'GigabitEthernet0' } });
  sim.runToIdle();
  return sim;
}

const defaultOf = (sim: Simulation, d: string) => {
  const r = ribRow(sim, d, '0.0.0.0/0');
  return r === undefined ? undefined : { source: r.source, routeType: r.routeType, isDefault: r.isDefault, ad: r.ad, metric: r.metric, nextHop: r.nextHop };
};

describe('ospf.default-originate', () => {
  it('with a static default: the E2 default LSA, the E bit, and O*E2 0.0.0.0/0 [110/1] on every other router', () => {
    const sim = world();
    expect(defaultOf(sim, 'r1')).toMatchObject({ source: 'S', ad: 1, nextHop: '10.9.9.2' });
    expect(defaultOf(sim, 'r2')).toEqual({ source: 'O', routeType: 'E2', isDefault: true, ad: 110, metric: 1, nextHop: '10.0.12.1' });
    expect(defaultOf(sim, 'r3')).toEqual({ source: 'O', routeType: 'E2', isDefault: true, ad: 110, metric: 1, nextHop: '10.0.23.1' });
    for (const d of ['r1', 'r2', 'r3']) {
      const ext = lsdbRows(sim, d).find((r) => r.key === EXT_KEY)!;
      expect(ext).toMatchObject({ scope: 'as', type: 5, lsid: '0.0.0.0', advRouter: '1.1.1.1', mask: '0.0.0.0', metric: 1, external: { e2: true, forward: '0.0.0.0', tag: 0 }, self: d === 'r1' });
      expect(lsdbRows(sim, d).find((r) => r.key === '0.0.0.0|1|1.1.1.1|1.1.1.1')!.flags).toEqual({ b: false, e: true, v: false });
    }
    // the originator installs no OSPF default of its own
    expect(ospfRoutes(sim, 'r1').filter((r) => r.prefixLen === 0)).toEqual([]);
    expect(ospfView(sim, 'r1').process).toMatchObject({ defaultOriginate: 'on' });
  });

  it('removing the static flushes the LSA (a MaxAge flood), the O*E2 routes go, and the rows are removed once acknowledged', () => {
    const sim = world();
    sim.runFor(30 * SEC); // the SPF hold of the convergence is over
    const c = cursor(sim);
    const T = sim.now;
    setLine(sim, 'r1', [], STATIC, true);
    sim.runToIdle();
    const evs: TraceEvent[] = eventsSince(sim, c);
    // R1's flush: an update carrying the external LSA at age 3600
    const lsus = ospfCreated(evs, 'r1').filter((p) => p.kind === 'lsu');
    const flush = lsus.find((p) => sim.pdu(p.pdu)!.layers.some((l) => l.proto === 'ospf-lsa' && l.fields.lsType === 5 && l.fields.age === 3600));
    expect(flush).toBeDefined();
    expect(flush!.t).toBe(T);
    // the defaults go with the next SPF (5 s later), and the flushed rows are gone everywhere
    expect(defaultOf(sim, 'r1')).toBeUndefined();
    expect(defaultOf(sim, 'r2')).toBeUndefined();
    expect(defaultOf(sim, 'r3')).toBeUndefined();
    const expire = evs.find((e) => e.kind === 'tableExpire' && e.device === 'r3' && e.table === 'rib' && e.key === '0.0.0.0/0')!;
    expect(expire.t - T).toBeGreaterThanOrEqual(5 * SEC);
    expect(expire.t - T).toBeLessThan(5 * SEC + 10_000_000);
    for (const d of ['r1', 'r2', 'r3']) {
      expect(lsdbRows(sim, d).find((r) => r.key === EXT_KEY)).toBeUndefined();
      expect(lsdbRows(sim, d).find((r) => r.key === '0.0.0.0|1|1.1.1.1|1.1.1.1')!.flags!.e).toBe(false);
    }
    // the static back: the LSA returns
    setLine(sim, 'r1', [], STATIC);
    sim.runToIdle();
    expect(defaultOf(sim, 'r3')).toMatchObject({ source: 'O', routeType: 'E2', metric: 1 });
  });

  it('`always` originates without any default route', () => {
    const sim = world({ always: true, staticRoute: false });
    expect(defaultOf(sim, 'r1')).toBeUndefined();
    expect(defaultOf(sim, 'r2')).toMatchObject({ source: 'O', routeType: 'E2', isDefault: true, metric: 1, nextHop: '10.0.12.1' });
    expect(ospfView(sim, 'r1').process).toMatchObject({ defaultOriginate: 'always' });
    // back to the plain form: with no default route the LSA is flushed
    setLine(sim, 'r1', [['router', 'ospf', '1']], ['default-information', 'originate']);
    sim.runToIdle();
    expect(defaultOf(sim, 'r2')).toBeUndefined();
    expect(lsdbRows(sim, 'r2').find((r) => r.key === EXT_KEY)).toBeUndefined();
  });

  it('an OSPF-learned default is not a default route to originate from; without the line a static default is not advertised', () => {
    const sim = world({ r2Originates: true });
    expect(defaultOf(sim, 'r2')).toMatchObject({ source: 'O', routeType: 'E2' });
    expect(lsdbRows(sim, 'r3').filter((r) => r.type === 5).map((r) => r.advRouter)).toEqual(['1.1.1.1']);
    // R1 without `default-information originate`: its static stays local
    setLine(sim, 'r1', [['router', 'ospf', '1']], ['default-information', 'originate'], true);
    sim.runToIdle();
    expect(defaultOf(sim, 'r1')).toMatchObject({ source: 'S' });
    expect(defaultOf(sim, 'r2')).toBeUndefined();
    expect(lsdbRows(sim, 'r2').filter((r) => r.type === 5)).toEqual([]);
  });
});
