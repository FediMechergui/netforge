/**
 * ip.static-routing.usable — two defects of the D13 "usable" rule found by the W5 labs (ARCHITECTURE-P2 D13, §7 W5
 * fix):
 *   • a re-addressed interface: `setAddress` settles the statics while the port view still holds the OLD address
 *     (`setPortL3` is applied after the handler returns), so a static whose next hop sat in the old subnet stayed
 *     installed and its floating twin never took over. ipv4 now answers "directly connected" from its own interface
 *     record, and the live RIB equals a freshly booted copy of the same configuration;
 *   • a floating twin: the recursive walk skipped only the line's OWN installed row, so a line whose next hop was gone
 *     resolved through the row its twin installed for the same prefix, won again on distance, and the table flip-flopped
 *     until the round limit — the result depended on how many static lines the router held. The walk now skips every
 *     route of the line's own prefix (as forwarding's `resolveVia` does), in IPv4 and IPv6.
 */
import { describe, expect, it } from 'vitest';
import type { ConfigDelta } from '../src/contracts/config.js';
import type { ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { Route6Row, RouteRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { Topology } from '../src/contracts/topology.js';
import { createIpv4 } from '../src/protocols/ipv4.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { ccna2FloatingStatic, ccna2StaticRoutes } from '../src/sim/scenarios/ccna2/routing.js';
import { ccna2TroubleshootRouting } from '../src/sim/scenarios/ccna2/troubleshooting.js';
import { createSimulation } from '../src/sim/simulation.js';
import { makeFake, makeSink } from './ip.fake-ctx.js';
import { BOOT_NS, createWorld6 } from './ip6.harness.js';

const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';
const MASK24 = '255.255.255.0';

const setAddr = (port: string, a: string, m: string): ConfigDelta => ({ op: 'set', context: [['interface', port]], line: ['ip', 'address', a, m] });
const setRoute = (...args: string[]): ConfigDelta => ({ op: 'set', context: [], line: ['ip', 'route', ...args] });

/** A router with GI0 10.0.0.1/24 and GI1 10.0.1.1/24, both up. */
function router() {
  const fake = makeFake({ kind: 'router', ports: [{ id: GI0, mac: '00:1f:00:00:00:10' }, { id: GI1, mac: '00:1f:00:00:00:11' }] });
  const ipv4 = createIpv4();
  fake.register(ipv4);
  fake.register(makeSink('arp'));
  fake.register(makeSink('icmpv4'));
  fake.run(ipv4.onConfig(fake.ctx, setAddr(GI0, '10.0.0.1', MASK24)));
  fake.run(ipv4.onConfig(fake.ctx, setAddr(GI1, '10.0.1.1', MASK24)));
  return { fake, ipv4 };
}

/** A lab world as the worker builds it: seed, topology, scheduled faults, booted and settled. */
function labWorld(lab: ScenarioInfo): Simulation {
  const sim = createSimulation({ seed: lab.seed ?? 1 });
  sim.loadTopology({ ...lab.build(), lab: { name: lab.name, version: lab.version ?? 1 } });
  for (const f of lab.faults ?? []) sim.injectFault(f.at, f.fault);
  sim.runFor(90 * SEC);
  sim.runToIdle();
  return sim;
}

function idOf(sim: Simulation, name: string): string {
  for (const d of sim.devices()) if (d.spec.name === name) return d.id;
  throw new Error(`no device called ${name}`);
}

function configure(sim: Simulation, name: string, lines: readonly string[]): void {
  const r = sim.configure(idOf(sim, name), lines);
  expect(r.lines.filter((l) => !l.ok).map((l) => l.line), `${name}: ${lines.join(' / ')}`).toEqual([]);
}

/** The static and connected rows of a device, without their timestamps. */
function ribOf(sim: Simulation, name: string): string[] {
  const dev = sim.device(idOf(sim, name))!;
  return dev.tables.rib
    .rows()
    .map((r: RouteRow) => `${r.source} ${r.key} nh=${r.nextHop ?? '-'} if=${r.iface ?? '-'} ad=${r.ad}${(r.paths ?? []).length > 1 ? ` paths=${r.paths!.length}` : ''}`)
    .sort();
}

/** A clone of `sim`'s saved configuration, freshly booted and settled. */
function freshCopy(sim: Simulation): Simulation {
  const topo: Topology = sim.exportTopology();
  const copy = createSimulation({ seed: sim.seed });
  copy.loadTopology(topo);
  copy.runFor(90 * SEC);
  copy.runToIdle();
  return copy;
}

describe('ip.static-routing.usable: a re-addressed interface (the port view lags one step behind setAddress)', () => {
  it('withdraws a next-hop static whose next hop left the new subnet, in the same step, and the floating twin takes over', () => {
    const { fake, ipv4 } = router();
    ipv4.onConfig(fake.ctx, setRoute('10.5.0.0', MASK24, '10.0.1.9'));
    ipv4.onConfig(fake.ctx, setRoute('10.5.0.0', MASK24, '10.0.0.9', '5'));
    expect(fake.tables.rib.get('10.5.0.0/24')).toMatchObject({ nextHop: '10.0.1.9', ad: 1 });
    fake.setNow(3 * SEC);
    // GI1 moves to 10.0.2.1/24: 10.0.1.9 is no longer on a connected subnet
    fake.run(ipv4.onConfig(fake.ctx, setAddr(GI1, '10.0.2.1', MASK24)));
    expect(fake.tables.rib.get('10.5.0.0/24')).toMatchObject({ nextHop: '10.0.0.9', ad: 5, updatedAt: 3 * SEC });
    expect(fake.debug.some((d) => d.message === 'remove S 10.5.0.0/24 via 10.0.1.9 (next hop 10.0.1.9 is not reachable)')).toBe(true);
    // moving it back re-installs the distance-1 line
    fake.setNow(5 * SEC);
    fake.run(ipv4.onConfig(fake.ctx, setAddr(GI1, '10.0.1.1', MASK24)));
    expect(fake.tables.rib.get('10.5.0.0/24')).toMatchObject({ nextHop: '10.0.1.9', ad: 1, updatedAt: 5 * SEC });
  });

  it('withdraws a fully specified static whose next hop left the subnet of its interface', () => {
    const { fake, ipv4 } = router();
    ipv4.onConfig(fake.ctx, setRoute('10.6.0.0', MASK24, GI1, '10.0.1.7'));
    expect(fake.tables.rib.get('10.6.0.0/24')).toMatchObject({ iface: GI1, nextHop: '10.0.1.7' });
    fake.run(ipv4.onConfig(fake.ctx, setAddr(GI1, '10.0.2.1', MASK24)));
    expect(fake.tables.rib.get('10.6.0.0/24')).toBeUndefined();
  });

  it('the solved floating lab fails over when the main link is re-addressed, and the live table equals a fresh boot of the same configuration', () => {
    const sim = labWorld(ccna2FloatingStatic);
    for (const [name, lines] of Object.entries(ccna2FloatingStatic.solution ?? {})) configure(sim, name, lines);
    sim.runToIdle();
    expect(sim.device(idOf(sim, 'R1'))!.tables.rib.get('0.0.0.0/0')).toMatchObject({ nextHop: '10.0.0.2', ad: 1 });
    configure(sim, 'R1', ['interface GigabitEthernet0/1', 'ip address 10.0.0.9 255.255.255.252', 'exit']);
    sim.runFor(60 * SEC);
    sim.runToIdle();
    expect(sim.device(idOf(sim, 'R1'))!.tables.rib.get('0.0.0.0/0')).toMatchObject({ nextHop: '10.0.0.6', ad: 5 });
    const copy = freshCopy(sim);
    for (const name of ['R1', 'R2']) expect(ribOf(sim, name), name).toEqual(ribOf(copy, name));
  }, 60_000);

  it('a fully specified route of the solved route-forms lab stops counting once its interface is re-addressed', () => {
    const sim = labWorld(ccna2StaticRoutes);
    for (const [name, lines] of Object.entries(ccna2StaticRoutes.solution ?? {})) configure(sim, name, lines);
    sim.runToIdle();
    configure(sim, 'R2', ['interface GigabitEthernet0/0', 'ip address 10.0.12.6 255.255.255.252', 'exit']);
    sim.runFor(10 * SEC);
    sim.runToIdle();
    expect(sim.device(idOf(sim, 'R2'))!.tables.rib.get('10.1.0.0/24')).toBeUndefined();
    const status = evaluateLab(sim, ccna2StaticRoutes);
    expect(status.results.find((r) => r.task === 'fully-specified-route')?.pass).toBe(false);
    expect(ribOf(sim, 'R2')).toEqual(ribOf(freshCopy(sim), 'R2'));
  }, 60_000);

  it('the unsolved routing fault-finding lab shows no route whose next hop is off every connected subnet', () => {
    const sim = labWorld(ccna2TroubleshootRouting);
    const r2 = sim.device(idOf(sim, 'R2'))!;
    expect(r2.port('GigabitEthernet0/0')!.l3.ipv4).toEqual({ address: '10.0.12.6', prefixLen: 30 });
    expect(r2.tables.rib.get('192.168.10.0/24')).toBeUndefined();
    expect(ribOf(sim, 'R2')).toEqual(ribOf(freshCopy(sim), 'R2'));
  }, 60_000);
});

describe('ip.static-routing.usable: a line never resolves its next hop through a route of its own prefix', () => {
  for (const extra of [0, 1, 2, 3]) {
    it(`IPv4: the floating default takes over and stays with ${extra} unrelated static line(s) configured`, () => {
      const { fake, ipv4 } = router();
      ipv4.onConfig(fake.ctx, setRoute('0.0.0.0', '0.0.0.0', '10.0.1.9'));
      ipv4.onConfig(fake.ctx, setRoute('0.0.0.0', '0.0.0.0', '10.0.0.9', '5'));
      for (let k = 0; k < extra; k++) ipv4.onConfig(fake.ctx, setRoute(`172.16.${k}.0`, MASK24, '10.0.0.9'));
      expect(fake.tables.rib.get('0.0.0.0/0')).toMatchObject({ nextHop: '10.0.1.9', ad: 1 });
      fake.setNow(4 * SEC);
      fake.setOper(GI1, false);
      ipv4.onLinkChange!(fake.ctx, GI1, false);
      expect(fake.tables.rib.get('0.0.0.0/0')).toMatchObject({ nextHop: '10.0.0.9', ad: 5 });
      expect(fake.tables.rib.get('0.0.0.0/0')!.paths).toBeUndefined();
      // the distance-1 line was withdrawn once and never offered again
      expect(fake.debug.filter((d) => d.message.startsWith('add S 0.0.0.0/0 via 10.0.1.9'))).toHaveLength(1);
    });
  }

  it('IPv4: an equal-cost sibling whose next hop is gone leaves the shared row instead of resolving through it', () => {
    const { fake, ipv4 } = router();
    ipv4.onConfig(fake.ctx, setRoute('0.0.0.0', '0.0.0.0', '10.0.1.9'));
    ipv4.onConfig(fake.ctx, setRoute('0.0.0.0', '0.0.0.0', '10.0.0.9'));
    ipv4.onConfig(fake.ctx, setRoute('172.16.0.0', MASK24, '10.0.0.9'));
    expect(fake.tables.rib.get('0.0.0.0/0')!.paths).toHaveLength(2);
    fake.setOper(GI1, false);
    ipv4.onLinkChange!(fake.ctx, GI1, false);
    const row = fake.tables.rib.get('0.0.0.0/0')!;
    expect(row).toMatchObject({ nextHop: '10.0.0.9', ad: 1 });
    expect(row.paths).toBeUndefined();
  });

  for (const extra of [0, 1]) {
    it(`IPv6: the floating default takes over and stays with ${extra} unrelated static line(s) configured`, () => {
      const w = createWorld6({ seed: 2 });
      w.add('pc1', 'pc');
      w.add('r1', 'router');
      w.add('r2', 'router');
      w.link({ device: 'pc1', port: 'GigabitEthernet0' }, { device: 'r1', port: GI0 });
      w.link({ device: 'r1', port: GI1 }, { device: 'r2', port: GI1 });
      w.runFor(BOOT_NS);
      w.global('r1', 'ipv6 unicast-routing');
      w.iface('r1', GI0, 'ipv6 address 2001:db8:1::1/64', 'no shutdown');
      w.iface('r1', GI1, 'ipv6 address 2001:db8:12::1/64', 'no shutdown');
      w.iface('r2', GI1, 'ipv6 address 2001:db8:12::2/64', 'no shutdown');
      w.runFor(6 * SEC);
      w.global('r1', 'ipv6 route ::/0 2001:db8:12::2', 'ipv6 route ::/0 2001:db8:1::99 5');
      for (let k = 0; k < extra; k++) w.global('r1', `ipv6 route 2001:db8:7${k}::/64 2001:db8:1::77`);
      const rib6 = (): Route6Row | undefined => w.dev('r1').tables.get<Route6Row>('rib6')!.get('::/0');
      expect(rib6()).toMatchObject({ nextHop: '2001:db8:12::2', ad: 1 });
      w.iface('r1', GI1, 'shutdown');
      w.runFor(2 * SEC);
      expect(rib6()).toMatchObject({ nextHop: '2001:db8:1::99', ad: 5 });
    });
  }
});
