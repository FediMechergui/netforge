/**
 * eigrp.routes [C1] — DUAL in the eigrp daemon on `staged.world` (ARCHITECTURE-P3 D26, D8, D11, §2.16, §3.12 steps
 * 2–4, §4.5; §7 W2 eigrp): the §3.12 metrics and tables, one `ipv4.routes` batch per change (owner eigrp, source
 * 'EIGRP', AD 90), the feasible-successor failover inside the link-down dispatch (with the poison reverse to the new
 * successor and no query for the prefix), the variant without a feasible successor (active, one query, one reply,
 * passive again within 5 ms), `maximum-paths`, and passive interfaces.
 */
import { describe, expect, it } from 'vitest';
import { EIGRP_INFINITY } from '../src/contracts/pdu.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { MS, SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { EIGRP_OPCODE } from '../src/pdu/codecs/eigrp.js';
import { eigrpParseRoutes } from '../src/protocols/eigrp.js';
import { eigrpMetric } from '../src/protocols/eigrp/metric.js';
import { routeCause } from '../src/protocols/ipv4.js';
import {
  GI0,
  GI1,
  LAN,
  PC4,
  R1,
  R2,
  R3,
  eigrpCreated,
  eigrpWorld,
  neighborRows,
  ribRow,
  topologyRow,
  transitions,
  type Created,
} from './eigrp.world.js';
import { ping } from './sim.harness.js';

const eigrpOf = (sim: Simulation, c: Created): Record<string, unknown> => sim.pdu(c.pdu.id)!.layers.find((l) => l.proto === 'eigrp')!.fields as Record<string, unknown>;
/** The prefixes (and their metric as the sender advertised it) of an EIGRP packet. */
function routesOf(sim: Simulation, c: Created): Record<string, number> {
  const f = eigrpOf(sim, c);
  const out: Record<string, number> = {};
  for (const r of eigrpParseRoutes(typeof f.routes === 'string' ? f.routes : '')) out[r.prefix] = eigrpMetric(r.vector);
  return out;
}
const ribWrites = (evs: readonly TraceEvent[], device: string, key: string) =>
  evs.filter((e): e is Extract<TraceEvent, { kind: 'tableWrite' }> => e.kind === 'tableWrite' && e.device === device && e.table === 'rib' && e.key === key);

describe('eigrp routes [C1]: §3.12 step 2, the metrics', () => {
  it('R1: FD 3328 via R2 (RD 3072), R3 a feasible successor at 28672/3072; D 10.4.0.0/24 [90/3328] installed once', () => {
    const { sim } = eigrpWorld({ noRun: true });
    const cursor = sim.trace(0).next;
    sim.runToIdle();
    const evs = sim.trace(cursor).events;
    expect(topologyRow(sim, R1, LAN)).toEqual({
      key: LAN,
      updatedAt: expect.any(Number),
      prefix: LAN,
      state: 'passive',
      fd: 3328,
      successors: [{ nextHop: '10.0.12.2', iface: GI0, metric: 3328, rd: 3072 }],
      feasible: [{ nextHop: '10.0.13.3', iface: GI1, metric: 28672, rd: 3072 }],
      others: [],
    });
    const row = ribRow(sim, R1, LAN)!;
    expect(row).toMatchObject({ network: '10.4.0.0', prefixLen: 24, source: 'EIGRP', ad: 90, metric: 3328, nextHop: '10.0.12.2', iface: GI0, owner: 'eigrp' });
    expect(row.paths).toBeUndefined();
    expect(routeCause(row, { config: sim.device(R1)!.running })).toBe('eigrp 100: D 10.4.0.0/24 [90/3328] via 10.0.12.2');
    // installed with one write: no transient path on the way to convergence; every route within link-up + 50 ms
    const writes = ribWrites(evs, R1, LAN);
    expect(writes).toHaveLength(1);
    const linkUp = evs.find((e) => e.kind === 'portState' && e.device === R1 && e.operUp)!.t;
    for (const d of [R1, R2, R3]) {
      for (const w of evs.filter((e) => e.kind === 'tableWrite' && e.device === d && e.table === 'rib' && (e.row as { source?: string }).source === 'EIGRP')) {
        expect(w.t - linkUp).toBeLessThan(50 * MS);
      }
    }
    // the connected network of an EIGRP interface is in the topology table and never offered to ipv4
    expect(topologyRow(sim, R1, '10.0.12.0/24')).toMatchObject({ state: 'passive', fd: 2816, successors: [], connected: GI0 });
    expect(ribRow(sim, R1, '10.0.12.0/24')).toMatchObject({ source: 'C' });
    // R3's own distance is 3072 through R4; its path via R1 (100 Mb/s, 100 µs) is listed as another path
    expect(topologyRow(sim, R3, LAN)).toMatchObject({ fd: 3072, successors: [{ nextHop: '10.0.34.4', metric: 3072, rd: 2816 }] });
    // and the network works: R1 reaches PC4
    expect(ping(sim, R1, '10.4.0.10').text).toContain('!!!!');
    expect(sim.device(PC4)!.ports.get('GigabitEthernet0')!.counters.inPackets).toBeGreaterThan(0);
  });
});

describe('eigrp routes [C1]: §3.12 step 3, the feasible successor takes over in the link-down dispatch', () => {
  it('the R1–R2 cable cut at T: R2 down, R3 promoted, [90/28672] installed at T with no query for 10.4.0.0/24, R3 poisoned', () => {
    const { sim, links } = eigrpWorld();
    const t = sim.now;
    const cursor = sim.trace(0).next;
    sim.removeLink(links.r1r2);
    // nothing has run yet: the failover happened inside the link-down dispatch
    expect(sim.now).toBe(t);
    expect(ribRow(sim, R1, LAN)).toMatchObject({ source: 'EIGRP', nextHop: '10.0.13.3', iface: GI1, metric: 28672 });
    expect(topologyRow(sim, R1, LAN)).toMatchObject({ state: 'passive', fd: 28672, successors: [{ nextHop: '10.0.13.3', iface: GI1, metric: 28672, rd: 3072 }], feasible: [], others: [] });
    const now = sim.trace(cursor).events;
    expect(transitions(now, R1, 'eigrp-nbr').map((x) => [x.t, x.subject, x.from, x.to, x.cause])).toEqual([[t, `${GI0} 10.0.12.2`, 'up', 'down', 'interface down']]);
    expect(transitions(now, R1, 'eigrp-route').filter((x) => x.subject === LAN).map((x) => [x.t, x.from, x.to, x.cause])).toEqual([
      [t, 'passive', 'passive', 'feasible successor promoted'],
    ]);
    expect(ribWrites(now, R1, LAN).map((w) => [w.t, (w.row as { nextHop?: string }).nextHop])).toEqual([[t, '10.0.13.3']]);
    sim.runToIdle();
    const evs = sim.trace(cursor).events;
    // R1 queried nobody for 10.4.0.0/24 (its lost connected network 10.0.12.0/24 had no feasible successor: that one is queried)
    const queries = eigrpCreated(evs, R1).filter((c) => eigrpOf(sim, c).opcode === EIGRP_OPCODE.query);
    for (const q of queries) expect(Object.keys(routesOf(sim, q))).not.toContain(LAN);
    // poison reverse: R1 tells R3 that 10.4.0.0/24 is unreachable through R1 (R3 is now its successor)
    const toR3 = eigrpCreated(evs, R1).filter((c) => c.pdu.flow === 'ipv4:10.0.13.1>10.0.13.3:eigrp' && eigrpOf(sim, c).opcode === EIGRP_OPCODE.update);
    expect(toR3.length).toBeGreaterThan(0);
    expect(routesOf(sim, toR3[0]!)[LAN]).toBe(EIGRP_INFINITY);
    expect(toR3[0]!.t).toBe(t);
    // stable afterwards: the route stays, R3 stays the successor
    sim.runFor(30 * SEC);
    expect(ribRow(sim, R1, LAN)).toMatchObject({ nextHop: '10.0.13.3', metric: 28672 });
    expect(neighborRows(sim, R1).map((r) => r.address)).toEqual(['10.0.13.3']);
  });
});

describe('eigrp routes [C1]: §3.12 step 4, no feasible successor', () => {
  it('R3 is not feasible (28416 ≥ 3328): at T R1 goes active, queries R3, gets 28416 back, installs [90/30976] by T + 5 ms', () => {
    const { sim, links } = eigrpWorld({ variant: 'no-fs' });
    expect(topologyRow(sim, R1, LAN)).toMatchObject({
      fd: 3328,
      successors: [{ nextHop: '10.0.12.2', metric: 3328, rd: 3072 }],
      feasible: [],
      others: [{ nextHop: '10.0.13.3', iface: GI1, metric: 30976, rd: 28416 }],
    });
    expect(topologyRow(sim, R3, LAN)).toMatchObject({ fd: 28416, successors: [{ nextHop: '10.0.34.4', metric: 28416 }] });
    const t = sim.now;
    const cursor = sim.trace(0).next;
    sim.removeLink(links.r1r2);
    // active at T: no route for the prefix while the query is out
    expect(topologyRow(sim, R1, LAN)).toMatchObject({ state: 'active', pendingReplies: 1 });
    expect(ribRow(sim, R1, LAN)).toBeUndefined();
    sim.runToIdle();
    const evs = sim.trace(cursor).events;
    const route = transitions(evs, R1, 'eigrp-route').filter((x) => x.subject === LAN);
    expect(route.map((x) => [x.from, x.to, x.cause])).toEqual([
      ['passive', 'active', 'no feasible successor: querying neighbours'],
      ['active', 'passive', 'all replies received'],
    ]);
    expect(route[0]!.t).toBe(t);
    expect(route[1]!.t - t).toBeLessThan(5 * MS);
    // one query (R1 → R3, carrying the infinite distance) and one reply (R3 → R1, 28416)
    const q = eigrpCreated(evs, R1).filter((c) => eigrpOf(sim, c).opcode === EIGRP_OPCODE.query && LAN in routesOf(sim, c));
    // (it leaves when the packet already in flight to R3 is acknowledged: one reliable packet per neighbour at a time)
    expect(q.map((c) => [c.pdu.flow, routesOf(sim, c)[LAN]])).toEqual([['ipv4:10.0.13.1>10.0.13.3:eigrp', EIGRP_INFINITY]]);
    expect(q[0]!.t - t).toBeLessThan(1 * MS);
    const r = eigrpCreated(evs, R3).filter((c) => eigrpOf(sim, c).opcode === EIGRP_OPCODE.reply && LAN in routesOf(sim, c));
    expect(r.map((c) => [c.pdu.flow, routesOf(sim, c)[LAN]])).toEqual([['ipv4:10.0.13.3>10.0.13.1:eigrp', 28416]]);
    // passive again through R3, FD 30976
    expect(topologyRow(sim, R1, LAN)).toMatchObject({ state: 'passive', fd: 30976, successors: [{ nextHop: '10.0.13.3', iface: GI1, metric: 30976, rd: 28416 }] });
    expect(topologyRow(sim, R1, LAN)!.pendingReplies).toBeUndefined();
    const row = ribRow(sim, R1, LAN)!;
    expect(row).toMatchObject({ nextHop: '10.0.13.3', metric: 30976, ad: 90 });
    expect(ribWrites(evs, R1, LAN).at(-1)!.t).toBe(route[1]!.t);
    // nothing is left active, and no stuck-in-active machinery runs
    const view = sim.device(R1)!.stateSnapshots().find((v) => v.process === 'eigrp')!.state as { active: unknown[] };
    expect(view.active).toEqual([]);
  });
});

describe('eigrp routes [C1]: maximum-paths and passive interfaces', () => {
  it('equal-cost successors share the prefix up to maximum-paths; maximum-paths 1 keeps the lower next hop', () => {
    const { sim } = eigrpWorld({ variant: 'ecmp' });
    expect(topologyRow(sim, R1, LAN)).toMatchObject({
      fd: 3328,
      successors: [
        { nextHop: '10.0.12.2', iface: GI0, metric: 3328, rd: 3072 },
        { nextHop: '10.0.13.3', iface: GI1, metric: 3328, rd: 3072 },
      ],
      feasible: [],
    });
    expect(ribRow(sim, R1, LAN)!.paths).toEqual([
      { nextHop: '10.0.12.2', iface: GI0, cause: 'eigrp 100: D 10.4.0.0/24 [90/3328] via 10.0.12.2' },
      { nextHop: '10.0.13.3', iface: GI1, cause: 'eigrp 100: D 10.4.0.0/24 [90/3328] via 10.0.13.3' },
    ]);
    const r1 = sim.device(R1)!;
    r1.applyActions('sim', [], sim.now);
    expect(r1.applyConfigLine([['router', 'eigrp', '100']], ['maximum-paths', '1'], false)).toEqual({ ok: true });
    sim.runToIdle();
    expect(topologyRow(sim, R1, LAN)).toMatchObject({
      fd: 3328,
      successors: [{ nextHop: '10.0.12.2', iface: GI0, metric: 3328 }],
      feasible: [{ nextHop: '10.0.13.3', iface: GI1, metric: 3328, rd: 3072 }],
    });
    const row = ribRow(sim, R1, LAN)!;
    expect(row).toMatchObject({ nextHop: '10.0.12.2', iface: GI0, metric: 3328 });
    expect(row.paths).toBeUndefined();
    const view = r1.stateSnapshots().find((v) => v.process === 'eigrp')!.state as { process: { maximumPaths: number } };
    expect(view.process.maximumPaths).toBe(1);
  });

  it('passive-interface Gi0/1 on R1: no hello out of it, no neighbour there, its network still advertised', () => {
    const { sim } = eigrpWorld({ noRun: true, process: { [R1]: ['router eigrp 100', ' network 10.0.0.0', ` passive-interface ${GI1}`] } });
    const cursor = sim.trace(0).next;
    sim.runToIdle();
    sim.runFor(20 * SEC);
    const evs = sim.trace(cursor).events;
    expect(eigrpCreated(evs, R1).filter((c) => c.pdu.flow?.startsWith('ipv4:10.0.13.1>') === true)).toEqual([]);
    expect(neighborRows(sim, R1).map((r) => r.address)).toEqual(['10.0.12.2']);
    expect(neighborRows(sim, R3).map((r) => r.address)).toEqual(['10.0.34.4']);
    expect(sim.device(R1)!.ports.get(GI1)!.l3.groups4).toBeUndefined();
    // R3's hellos are refused on the passive interface
    // (224.0.0.10 is not joined there, so they die as not-for-me before ipv4 hands them over)
    expect(evs.some((e) => e.kind === 'drop' && e.device === R1 && e.port === GI1 && e.reason === 'not-for-me' && e.detail === 'multicast group not joined' && e.pdu.tag === 'eigrp-hello')).toBe(true);
    expect(evs.some((e) => e.kind === 'pduConsumed' && e.device === R1 && e.process === 'eigrp' && (e.pdu.flow ?? '').startsWith('ipv4:10.0.13.3>'))).toBe(false);
    // the passive network is advertised: R1 knows it as connected, R2 learns it from R1
    expect(topologyRow(sim, R1, '10.0.13.0/24')).toMatchObject({ connected: GI1, fd: 28160 });
    expect(topologyRow(sim, R2, '10.0.13.0/24')!.successors.concat(topologyRow(sim, R2, '10.0.13.0/24')!.feasible, topologyRow(sim, R2, '10.0.13.0/24')!.others).map((p) => p.nextHop)).toContain('10.0.12.1');
    expect(ribRow(sim, R2, '10.0.13.0/24')).toMatchObject({ source: 'EIGRP' });
  });
});

describe('eigrp routes [C1]: interface metrics and determinism', () => {
  it('a delay and bandwidth change at run time recomputes the paths learned on that interface (R3 becomes a second successor)', () => {
    const { sim } = eigrpWorld();
    const r1 = sim.device(R1)!;
    r1.applyActions('sim', [], sim.now);
    expect(r1.applyConfigLine([['interface', GI1]], ['bandwidth', '1000000'], false)).toEqual({ ok: true });
    expect(r1.applyConfigLine([['interface', GI1]], ['delay', '1'], false)).toEqual({ ok: true });
    sim.runToIdle();
    // through R1 Gi0/1 now (1 Gb/s, 10 µs): R3's 3072 vector + 10 µs = 3328, equal to R2's
    expect(topologyRow(sim, R1, LAN)!.successors.map((p) => [p.nextHop, p.metric, p.rd])).toEqual([
      ['10.0.12.2', 3328, 3072],
      ['10.0.13.3', 3328, 3072],
    ]);
    expect(topologyRow(sim, R1, '10.0.13.0/24')).toMatchObject({ connected: GI1, fd: 2816 });
    expect(ribRow(sim, R1, LAN)!.paths).toHaveLength(2);
  });

  it('the same seed gives the same trace, event for event', () => {
    const run = (): string => {
      const { sim, links } = eigrpWorld({ variant: 'no-fs', noRun: true });
      sim.runToIdle();
      sim.removeLink(links.r1r2);
      sim.runToIdle();
      sim.runFor(12 * SEC);
      return JSON.stringify(sim.trace(0).events);
    };
    expect(run()).toBe(run());
  });
});
