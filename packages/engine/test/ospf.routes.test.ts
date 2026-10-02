/**
 * ospf.routes — from the LSDB to the RIB on `staged.world` (ARCHITECTURE-P3 D8, D9, D10, §3.2, §4.2, §4.5; §7 W2
 * ospf): each SPF run sends ONE `ipv4.routes` batch (rows in key order, equal-cost paths adjacent in path order); the
 * paths through an interface that goes down are withdrawn at once (ipv4, before the SPF); an `lsa-gen` due with `spf`
 * runs first (the SPF sees the router's own newest LSA); the §3.2 timings: routes at link-up + 15 s, the failover at
 * T + 5 s, the restore at T2 + 15 s; a floating static above AD 110; ECMP and `maximum-paths`; `no router ospf` withdraws
 * every route in one empty batch.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId, LinkId } from '../src/contracts/ids.js';
import type { Action, Process, ProcessCtx, ProcessFactory } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { RouteRow } from '../src/contracts/tables.js';
import { SEC, type SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { buildSpfGraph, ospfRoutes as spfRoutes, runSpf } from '../src/core/ospf-spf.js';
import { createOspf } from '../src/protocols/ospf.js';
import { computeOspfRoutes, ospfRouteRows } from '../src/protocols/ospf/routes.js';
import {
  addRouter,
  adminPort,
  cursor,
  debugLines,
  eventsSince,
  GI0,
  GI1,
  iface,
  lsdbRows,
  MS_NS,
  ospfRoutes,
  ospfView,
  portDownAt,
  portUpAt,
  ribRow,
  SE0,
  setLine,
  startup,
  tableEvents,
} from './ospf.harness.js';
import { createStagedSimulation } from './staged.world.js';

const P2P = ['ip ospf network point-to-point'];

/** One `ipv4.routes` request the ospf daemon returned: device, time, rows, and which handler call it came from. */
interface Batch {
  readonly device: DeviceId;
  readonly t: SimTime;
  readonly call: number;
  readonly rows: readonly RouteRow[];
}

/** createOspf with every handler's actions inspected for `ipv4.routes` requests. */
function spiedOspf(log: Batch[]): ProcessFactory {
  let calls = 0;
  return (): Process => {
    const p = createOspf();
    const watch = <A extends unknown[]>(fn: ((ctx: ProcessCtx, ...rest: A) => Action[]) | undefined) =>
      fn === undefined
        ? undefined
        : (ctx: ProcessCtx, ...rest: A): Action[] => {
            const out = fn(ctx, ...rest);
            const call = ++calls;
            for (const a of out) if (a.type === 'request' && a.req.kind === 'ipv4.routes') log.push({ device: ctx.deviceId, t: ctx.now, call, rows: a.req.rows });
            return out;
          };
    return {
      ...p,
      onPdu: watch(p.onPdu)!,
      onTimer: watch(p.onTimer)!,
      onConfig: watch(p.onConfig)!,
      onLinkChange: watch(p.onLinkChange),
      onRequest: watch(p.onRequest),
      onEvent: watch(p.onEvent),
    };
  };
}

/**
 * §3.2: R1 Gi0/0–R2 Gi0/0 10.0.12.0/30 and R2 Gi0/1–R3 Gi0/0 10.0.23.0/30 (point-to-point, shut until `up()`); R1
 * Se0/0/0–R3 Se0/0/0 10.0.13.0/30 (HDLC, DCE R1); LANs R1 Gi0/1 10.1.0.0/24 (PC1) and R3 Gi0/1 10.3.0.0/24 (PC3),
 * passive. Router ids n.n.n.n, area 0.
 */
function triangle(opts: { floating?: boolean } = {}): { sim: Simulation; log: Batch[]; l12: LinkId } {
  const log: Batch[] = [];
  const sim = createStagedSimulation({ seed: 32, stage: 'P3', factories: { ospf: spiedOspf(log) } });
  addRouter(sim, 'r1', 'R1', [
    iface(GI0, '10.0.12.1', '255.255.255.252', P2P, false),
    iface(GI1, '10.1.0.1', '255.255.255.0'),
    iface(SE0, '10.0.13.1', '255.255.255.252', ['clock rate 64000']),
    ...(opts.floating === true ? [['ip route 10.3.0.0 255.255.255.0 10.0.13.2 120']] : []),
    ['router ospf 1', ' router-id 1.1.1.1', ' passive-interface GigabitEthernet0/1', ' network 10.0.0.0 0.255.255.255 area 0'],
  ]);
  addRouter(sim, 'r2', 'R2', [
    iface(GI0, '10.0.12.2', '255.255.255.252', P2P, false),
    iface(GI1, '10.0.23.1', '255.255.255.252', P2P, false),
    ['router ospf 1', ' router-id 2.2.2.2', ' network 10.0.0.0 0.255.255.255 area 0'],
  ]);
  addRouter(sim, 'r3', 'R3', [
    iface(GI0, '10.0.23.2', '255.255.255.252', P2P, false),
    iface(GI1, '10.3.0.1', '255.255.255.0'),
    iface(SE0, '10.0.13.2', '255.255.255.252'),
    ['router ospf 1', ' router-id 3.3.3.3', ' passive-interface GigabitEthernet0/1', ' network 10.0.0.0 0.255.255.255 area 0'],
  ]);
  for (const [pc, net] of [['pc1', '10.1.0'], ['pc3', '10.3.0']] as const) {
    sim.addDevice({ id: pc, type: 'pc.nfpc', name: pc.toUpperCase(), startupConfig: startup([[`hostname ${pc.toUpperCase()}`], ['interface GigabitEthernet0', ` ip address ${net}.10 255.255.255.0`], [`ip default-gateway ${net}.1`]]) });
  }
  const l12 = sim.addLink({ a: { device: 'r1', port: GI0 }, b: { device: 'r2', port: GI0 } });
  sim.addLink({ a: { device: 'r2', port: GI1 }, b: { device: 'r3', port: GI0 } });
  sim.addLink({ a: { device: 'r1', port: SE0 }, b: { device: 'r3', port: SE0 }, media: 'serial-dce' });
  sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'r1', port: GI1 } });
  sim.addLink({ a: { device: 'pc3', port: 'GigabitEthernet0' }, b: { device: 'r3', port: GI1 } });
  sim.runFor(100 * SEC);
  return { sim, log, l12 };
}

/** Bring the GigE point-to-point links up; returns the link-up time U and the events. */
function converge(sim: Simulation): { U: SimTime; evs: TraceEvent[] } {
  const c = cursor(sim);
  for (const [d, p] of [['r1', GI0], ['r2', GI0], ['r2', GI1], ['r3', GI0]] as const) adminPort(sim, d, p, true);
  sim.runToIdle();
  const evs = eventsSince(sim, c);
  return { U: portUpAt(evs, 'r1', GI0)!, evs };
}

const table = (sim: Simulation, d: DeviceId) => ospfRoutes(sim, d).map((r) => [r.key, r.ad, r.metric, r.nextHop, r.iface]);

describe('ospf.routes: §3.2 single-area convergence and a link failure', () => {
  it('step 1: before the GigE links, 10.3.0.0/24 via the serial path; at link-up + 15 s the GigE routes, in ONE batch, rows in key order', () => {
    const { sim, log } = triangle();
    expect(table(sim, 'r1')).toEqual([['10.3.0.0/24', 110, 65, '10.0.13.2', SE0]]);
    const mark = log.length;
    const { U, evs } = converge(sim);
    expect(table(sim, 'r1')).toEqual([
      ['10.3.0.0/24', 110, 3, '10.0.12.2', GI0],
      ['10.0.23.0/30', 110, 2, '10.0.12.2', GI0],
    ]);
    // the route of the converged SPF: installed exactly at link-up + 15 s (§3.2), as one batch in key order
    const writes = tableEvents(evs, 'r1', 'rib').filter((e) => e.kind === 'tableWrite' && e.row.source === 'O' && e.row.nextHop === '10.0.12.2');
    expect(writes.map((e) => [e.t - U, e.key])).toEqual([[15 * SEC, '10.0.23.0/30'], [15 * SEC, '10.3.0.0/24']]);
    const batches = log.slice(mark).filter((b) => b.device === 'r1');
    const at15 = batches.filter((b) => b.t === U + 15 * SEC);
    expect(at15).toHaveLength(1);
    expect(at15[0]!.rows.map((r) => [r.key, r.metric, r.nextHop, r.iface, r.source, r.ad])).toEqual([
      ['10.0.23.0/30', 2, '10.0.12.2', GI0, 'O', 110],
      ['10.3.0.0/24', 3, '10.0.12.2', GI0, 'O', 110],
    ]);
    // one batch per SPF run, never more (the SPF runs: link-up + 5 s and + 15 s)
    const runs = debugLines(evs, 'r1', 'ip ospf spf').filter((l) => l.message.startsWith('SPF run'));
    expect(runs.map((l) => l.t - U)).toEqual([5 * SEC, 15 * SEC]);
    expect(batches.map((b) => b.t - U)).toEqual([5 * SEC, 15 * SEC]);
    expect(new Set(batches.map((b) => b.call)).size).toBe(batches.length);
    // the provenance cause of the installed routes
    expect(ribRow(sim, 'r1', '10.3.0.0/24')).toMatchObject({ source: 'O', owner: 'ospf', ad: 110, metric: 3 });
  });

  it('every router\'s O routes equal ospfRoutes over its own LSDB (engine/pure parity, D10)', () => {
    const { sim } = triangle();
    converge(sim);
    for (const d of ['r1', 'r2', 'r3']) {
      const rows = lsdbRows(sim, d);
      const rid = ospfView(sim, d).process!.routerId;
      const ports = [...sim.device(d)!.ports.values()];
      const rootIfaces = ports.filter((p) => p.operUp && p.l3.ipv4 !== undefined && p.id !== 'Console').map((p) => ({ port: p.id, address: p.l3.ipv4!.address }));
      const graph = buildSpfGraph(rows, '0.0.0.0', sim.now);
      const pure = ospfRouteRows(spfRoutes(graph, runSpf(graph, rid, rootIfaces)), sim.now).map((r) => [r.key, r.metric, r.nextHop, r.iface]);
      const installed = ospfRoutes(sim, d).flatMap((r) => (r.paths ?? [{ nextHop: r.nextHop, iface: r.iface }]).map((h) => [r.key, r.metric, h.nextHop, h.iface]));
      expect(installed.sort()).toEqual([...pure].sort());
      expect(computeOspfRoutes(rows, rid, [{ area: '0.0.0.0', rootIfaces }], { maximumPaths: 4, now: sim.now }).rows.map((r) => [r.key, r.metric, r.nextHop, r.iface])).toEqual(pure);
    }
  });

  it('an lsa-gen due with spf runs first: at link-up + 5 s the own router-LSA with the point-to-point link is installed before the SPF computes', () => {
    const { sim } = triangle();
    const { U, evs } = converge(sim);
    const at5 = evs.filter((e) => e.t === U + 5 * SEC);
    const own = at5.findIndex((e) => e.kind === 'tableWrite' && e.device === 'r1' && e.table === 'ospf-lsdb' && e.key === '0.0.0.0|1|1.1.1.1|1.1.1.1');
    const spf = at5.findIndex((e) => e.kind === 'debug' && e.event.device === 'r1' && e.event.message.startsWith('SPF run'));
    expect(own).toBeGreaterThanOrEqual(0);
    expect(spf).toBeGreaterThan(own);
    const row = (at5[own] as Extract<TraceEvent, { kind: 'tableWrite' }>).row as { links: { kind: string; id: string }[] };
    expect(row.links.filter((l) => l.kind === 'p2p').map((l) => l.id)).toEqual(['2.2.2.2', '3.3.3.3']); // canonical port order: Gi0/0, then Se0/0/0
    // the deferred origination ran inside the SPF's dispatch: no second write of the own LSA in that instant
    expect(at5.filter((e) => e.kind === 'tableWrite' && e.device === 'r1' && e.key === '0.0.0.0|1|1.1.1.1|1.1.1.1')).toHaveLength(1);
    // MinLSInterval: the Full at link-up + 1 s deferred it to link-up + 5 s (the previous origination was at link-up)
    const origins = tableEvents(evs, 'r1', 'ospf-lsdb').filter((e) => e.kind === 'tableWrite' && e.key === '0.0.0.0|1|1.1.1.1|1.1.1.1');
    expect(origins.map((e) => e.t - U)).toEqual([0, 5 * SEC]);
  });

  it('step 2 and 3: the paths via Gi0/0 are withdrawn at T (before any SPF), the serial path at T + 5 s, the GigE path back at T2 + 15 s', () => {
    const { sim, log, l12 } = triangle();
    converge(sim);
    sim.runFor(30 * SEC);
    let c = cursor(sim);
    const T = sim.now;
    const mark = log.length;
    sim.removeLink(l12);
    sim.runToIdle();
    let evs = eventsSince(sim, c);
    expect(portDownAt(evs, 'r1', GI0)).toBe(T);
    const rib = tableEvents(evs, 'r1', 'rib').filter((e) => e.key === '10.3.0.0/24');
    expect(rib.map((e) => [e.t - T, e.kind, (e as { reason?: string }).reason ?? (e.row as unknown as RouteRow).nextHop])).toEqual([
      [0, 'tableExpire', 'link-down'],
      [5 * SEC, 'tableWrite', '10.0.13.2'],
    ]);
    expect(log.slice(mark).filter((b) => b.device === 'r1').map((b) => b.t - T)).toEqual([5 * SEC]);
    expect(table(sim, 'r1')).toEqual([
      ['10.0.23.0/30', 110, 65, '10.0.13.2', SE0],
      ['10.3.0.0/24', 110, 65, '10.0.13.2', SE0],
    ]);
    // the neighbour went Down on the link-down itself
    expect(debugLines(evs, 'r1', 'ip ospf adj').find((l) => l.message.includes('neighbour 2.2.2.2'))).toMatchObject({ t: T });
    // restore at T2 ≥ T + 30 s
    sim.runFor(30 * SEC);
    c = cursor(sim);
    const T2 = sim.now;
    sim.addLink({ a: { device: 'r1', port: GI0 }, b: { device: 'r2', port: GI0 } });
    sim.runToIdle();
    evs = eventsSince(sim, c);
    expect(portUpAt(evs, 'r1', GI0)).toBe(T2);
    const back = tableEvents(evs, 'r1', 'rib').filter((e) => e.key === '10.3.0.0/24' && e.kind === 'tableWrite');
    expect(back.map((e) => [e.t - T2, (e.row as unknown as RouteRow).nextHop, (e.row as unknown as RouteRow).metric])).toEqual([[15 * SEC, '10.0.12.2', 3]]);
  });

  it('a floating static (AD 120) installs at T and the OSPF route replaces it at T + 5 s', () => {
    const { sim, l12 } = triangle({ floating: true });
    converge(sim);
    expect(ribRow(sim, 'r1', '10.3.0.0/24')).toMatchObject({ source: 'O', metric: 3 });
    sim.runFor(30 * SEC);
    const c = cursor(sim);
    const T = sim.now;
    sim.removeLink(l12);
    sim.runToIdle();
    const writes = tableEvents(eventsSince(sim, c), 'r1', 'rib').filter((e) => e.key === '10.3.0.0/24' && e.kind === 'tableWrite');
    expect(writes.map((e) => [e.t - T, (e.row as unknown as RouteRow).source, (e.row as unknown as RouteRow).ad])).toEqual([
      [0, 'S', 120],
      [5 * SEC, 'O', 110],
    ]);
  });

  it('`no router ospf` withdraws every OSPF route at once with one empty batch, and the process leaves no row behind', () => {
    const { sim, log } = triangle();
    converge(sim);
    const mark = log.length;
    const c = cursor(sim);
    setLine(sim, 'r1', [], ['router', 'ospf', '1'], true);
    sim.runFor(MS_NS);
    const batches = log.slice(mark).filter((b) => b.device === 'r1');
    expect(batches.map((b) => b.rows.length)).toEqual([0]);
    expect(ospfRoutes(sim, 'r1')).toEqual([]);
    const evs = eventsSince(sim, c);
    expect(tableEvents(evs, 'r1', 'rib').filter((e) => e.kind === 'tableExpire').map((e) => e.key).sort()).toEqual(['10.0.23.0/30', '10.3.0.0/24']);
    for (const t of ['ospf-interfaces', 'ospf-neighbors', 'ospf-lsdb']) expect(sim.device('r1')!.tables.get(t)!.size).toBe(0);
    expect(sim.device('r1')!.portView(GI0)!.l3.groups4).toBeUndefined();
  });
});

describe('ospf.routes: equal-cost paths and maximum-paths', () => {
  /** R1 with two equal GigE point-to-point paths (via R2 and R3) to R4's loopback 4.4.4.4/32. */
  function square(maxPaths?: number): Simulation {
    const sim = createStagedSimulation({ seed: 8, stage: 'P3', factories: { ospf: createOspf } });
    const ospf = (n: number) => ['router ospf 1', ` router-id ${n}.${n}.${n}.${n}`, ' network 0.0.0.0 255.255.255.255 area 0', ...(n === 1 && maxPaths !== undefined ? [` maximum-paths ${maxPaths}`] : [])];
    addRouter(sim, 'r1', 'R1', [iface(GI0, '10.0.12.1', '255.255.255.252', P2P), iface(GI1, '10.0.13.1', '255.255.255.252', P2P), ospf(1)]);
    addRouter(sim, 'r2', 'R2', [iface(GI0, '10.0.12.2', '255.255.255.252', P2P), iface(GI1, '10.0.24.1', '255.255.255.252', P2P), ospf(2)]);
    addRouter(sim, 'r3', 'R3', [iface(GI0, '10.0.13.2', '255.255.255.252', P2P), iface(GI1, '10.0.34.1', '255.255.255.252', P2P), ospf(3)]);
    addRouter(sim, 'r4', 'R4', [iface(GI0, '10.0.24.2', '255.255.255.252', P2P), iface(GI1, '10.0.34.2', '255.255.255.252', P2P), iface('Loopback0', '4.4.4.4', '255.255.255.255'), ospf(4)]);
    sim.addLink({ a: { device: 'r1', port: GI0 }, b: { device: 'r2', port: GI0 } });
    sim.addLink({ a: { device: 'r1', port: GI1 }, b: { device: 'r3', port: GI0 } });
    sim.addLink({ a: { device: 'r2', port: GI1 }, b: { device: 'r4', port: GI0 } });
    sim.addLink({ a: { device: 'r3', port: GI1 }, b: { device: 'r4', port: GI1 } });
    sim.runToIdle();
    return sim;
  }

  it('two equal-cost paths install as one rib row with both paths, in canonical port order', () => {
    const sim = square();
    const row = ribRow(sim, 'r1', '4.4.4.4/32')!;
    expect(row).toMatchObject({ source: 'O', metric: 3, nextHop: '10.0.12.2', iface: GI0 });
    expect(row.paths!.map((p) => [p.nextHop, p.iface])).toEqual([['10.0.12.2', GI0], ['10.0.13.2', GI1]]);
  });

  it('`maximum-paths 1` keeps one path', () => {
    const sim = square(1);
    const row = ribRow(sim, 'r1', '4.4.4.4/32')!;
    expect(row).toMatchObject({ metric: 3, nextHop: '10.0.12.2', iface: GI0 });
    expect(row.paths).toBeUndefined();
  });
});
