/**
 * P3 acceptance — single-area convergence and a link failure (ARCHITECTURE-P3 §10.1 `accept.p3.ospf-convergence`;
 * §3.2, D8, D9, D10, §4.2, §4.5, §5.8; §7 W4 qa).
 *
 * §3.2's triangle: R1 Gi0/0–R2 Gi0/0 10.0.12.0/30 and R2 Gi0/1–R3 Gi0/0 10.0.23.0/30, both `ip ospf network
 * point-to-point`; R1 Se0/0/0–R3 Se0/0/0 10.0.13.0/30 (HDLC, DCE on R1); LANs R1 Gi0/1 10.1.0.0/24 (PC1 .10) and R3
 * Gi0/1 10.3.0.0/24 (PC3 .10), both passive; area 0; reference 100 Mb/s (GigE 1, serial 64). The serial link, the
 * PCs and the routers are up long before the two GigE cables are plugged in at U (so every previous origination is at
 * least 5 s old). Pinned:
 *   • engine/pure parity: each router's `O` rows equal `ospfRoutes` (the pure entry, D10) over its own `ospf-lsdb` rows,
 *     after the convergence, after the failover and after the restore;
 *   • the first convergence at link-up + 15 s (`O 10.3.0.0/24 [110/3] via 10.0.12.2` and `O 10.0.23.0/30 [110/2]` on
 *     R1, the serial path not installed), the routes in ONE batch;
 *   • an `lsa-gen` due with `spf` runs first (U + 5 s: the own router-LSA with the point-to-point links is written before
 *     the SPF computes, once);
 *   • the R1–R2 cable cut at T: the paths via Gi0/0 withdrawn at T, the failover route `[110/65] via 10.0.13.2,
 *     Serial0/0/0` at T + 5 s ± 10 ms; a ping stream PC1 → PC3 (one echo every 100 ms) loses echoes only in
 *     [T, T + 5 s + ε] (ε = 100 ms, the serial latency bound), and every echo sent in [T, T + 5 s) is lost;
 *   • the floating-static variant (`ip route 10.3.0.0 255.255.255.0 10.0.13.2 120`): the static at T, the O route back
 *     at T + 5 s;
 *   • the restore at T2 = T + 30 s: the route via 10.0.12.2 `[110/3]` again at T2 + 15 s ± 10 ms;
 *   • the exact `show ip route` lines of R1, the second legend line included;
 *   • a lab `connectivity` check with `after: [{cut: {a: 'R1', b: 'R2', aPort: 'Gi0/0'}}]` passes in the grader clone,
 *     and its `then` route check sees the serial path there (W3 clone features); the live world is untouched.
 * Worlds: `staged.world` at stage P3 with the flip's daemons (ospf.accept.harness.ts).
 */
import { describe, expect, it } from 'vitest';
import { ipv4ToU32 } from '../src/contracts/addr.js';
import type { DeviceId, LinkId, SessionId } from '../src/contracts/ids.js';
import type { LabAssertion, LabCheckResult, ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { OspfInterfaceRow, RouteRow } from '../src/contracts/tables.js';
import { SEC, type SimTime } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID } from '../src/contracts/topology.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { buildSpfGraph, ospfRoutes as pureOspfRoutes, runSpf } from '../src/pure.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { acceptWorld, linkUpAt, showLines, traceSince } from './ospf.accept.harness.js';
import { addRouter, cursor, debugLines, GI0, GI1, iface, lsdbRows, MS_NS, ospfRoutes, ospfView, portDownAt, ribRow, SE0, startup, tableEvents } from './ospf.harness.js';

const MASK30 = '255.255.255.252';
const MASK24 = '255.255.255.0';
const P2P = ['ip ospf network point-to-point'];
const PC3 = '10.3.0.10';

interface Triangle {
  readonly sim: Simulation;
  /** Plug the two GigE cables in (the R1–R2 one first); returns the R1–R2 link. */
  readonly plug: () => LinkId;
}

/** §3.2's world, booted, with the two GigE cables still unplugged. */
function triangle(seed: number, opts: { floating?: boolean } = {}): Triangle {
  const sim = acceptWorld(seed);
  addRouter(sim, 'r1', 'R1', [
    iface(GI0, '10.0.12.1', MASK30, P2P),
    iface(GI1, '10.1.0.1', MASK24),
    iface(SE0, '10.0.13.1', MASK30, ['clock rate 64000']),
    ...(opts.floating === true ? [['ip route 10.3.0.0 255.255.255.0 10.0.13.2 120']] : []),
    ['router ospf 1', ' router-id 1.1.1.1', ' passive-interface GigabitEthernet0/1', ' network 10.0.12.0 0.0.0.3 area 0', ' network 10.0.13.0 0.0.0.3 area 0', ' network 10.1.0.0 0.0.0.255 area 0'],
  ]);
  addRouter(sim, 'r2', 'R2', [
    iface(GI0, '10.0.12.2', MASK30, P2P),
    iface(GI1, '10.0.23.1', MASK30, P2P),
    ['router ospf 1', ' router-id 2.2.2.2', ' network 10.0.12.0 0.0.0.3 area 0', ' network 10.0.23.0 0.0.0.3 area 0'],
  ]);
  addRouter(sim, 'r3', 'R3', [
    iface(GI0, '10.0.23.2', MASK30, P2P),
    iface(GI1, '10.3.0.1', MASK24),
    iface(SE0, '10.0.13.2', MASK30),
    ['router ospf 1', ' router-id 3.3.3.3', ' passive-interface GigabitEthernet0/1', ' network 10.0.23.0 0.0.0.3 area 0', ' network 10.0.13.0 0.0.0.3 area 0', ' network 10.3.0.0 0.0.0.255 area 0'],
  ]);
  for (const [id, name, net] of [['pc1', 'PC1', '10.1.0'], ['pc3', 'PC3', '10.3.0']] as const) {
    sim.addDevice({ id, type: 'pc.nfpc', name, startupConfig: startup([[`hostname ${name}`], ['interface GigabitEthernet0', ` ip address ${net}.10 ${MASK24}`], [`ip default-gateway ${net}.1`]]) });
  }
  sim.addLink({ a: { device: 'r1', port: SE0 }, b: { device: 'r3', port: SE0 }, media: 'serial-dce' });
  sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'r1', port: GI1 } });
  sim.addLink({ a: { device: 'pc3', port: 'GigabitEthernet0' }, b: { device: 'r3', port: GI1 } });
  sim.runFor(90 * SEC);
  expect(sim.runToIdle().stopped).toBeUndefined();
  const plug = (): LinkId => {
    const l12 = sim.addLink({ a: { device: 'r1', port: GI0 }, b: { device: 'r2', port: GI0 } });
    sim.addLink({ a: { device: 'r2', port: GI1 }, b: { device: 'r3', port: GI0 } });
    return l12;
  };
  return { sim, plug };
}

/** Converge: plug the GigE cables, run to idle; the link-up U, the R1–R2 link and the events. */
function converge(t: Triangle): { U: SimTime; l12: LinkId; evs: TraceEvent[] } {
  const c = cursor(t.sim);
  const l12 = t.plug();
  expect(t.sim.runToIdle().stopped).toBeUndefined();
  const evs = traceSince(t.sim, c);
  return { U: linkUpAt(evs, l12), l12, evs };
}

/** The O rows of `d` in (network as u32, prefix length) order (the rib table lists rows in write order). */
const table = (sim: Simulation, d: DeviceId) =>
  ospfRoutes(sim, d)
    .sort((a, b) => ipv4ToU32(a.network) - ipv4ToU32(b.network) || a.prefixLen - b.prefixLen)
    .map((r) => [r.key, r.ad, r.metric, r.nextHop, r.iface]);

/**
 * Engine/pure parity (D10): the installed `O` rows of `d`, one entry per path, equal `ospfRoutes` of the pure entry over
 * the router's own LSDB rows, rooted at its router id with its running OSPF interfaces (canonical port order).
 */
function expectPureParity(sim: Simulation, d: DeviceId): void {
  const dev = sim.device(d)!;
  const rows = lsdbRows(sim, d);
  const rid = ospfView(sim, d).process!.routerId;
  const ifRows = dev.tables.get<OspfInterfaceRow>('ospf-interfaces')!.rows();
  const rootIfaces = [...dev.ports.keys()]
    .map((p) => ifRows.find((r) => r.port === p))
    .filter((r): r is OspfInterfaceRow => r !== undefined && r.state !== 'down' && r.address !== undefined && r.area === '0.0.0.0')
    .map((r) => ({ port: r.port, address: r.address! }));
  const graph = buildSpfGraph(rows, '0.0.0.0', sim.now);
  const pure = pureOspfRoutes(graph, runSpf(graph, rid, rootIfaces), { maximumPaths: ospfView(sim, d).process!.maximumPaths })
    .flatMap((r) => r.nextHops.map((h) => [`${r.network}/${r.prefixLen}`, r.cost, h.nextHop, h.iface]));
  // the rib table lists rows in write order; the pure routes come in (network as u32, prefix length) order
  const installed = ospfRoutes(sim, d)
    .sort((a, b) => ipv4ToU32(a.network) - ipv4ToU32(b.network) || a.prefixLen - b.prefixLen)
    .flatMap((r) => (r.paths ?? [{ nextHop: r.nextHop, iface: r.iface }]).map((h) => [r.key, r.metric, h.nextHop, h.iface]));
  expect(installed, `${d}: installed O rows vs pure ospfRoutes`).toEqual(pure);
  expect(pure.length).toBeGreaterThan(0);
}

const RIB_WRITE = (evs: readonly TraceEvent[], d: DeviceId, key: string) =>
  tableEvents(evs, d, 'rib').filter((e) => e.key === key).map((e) => ({ t: e.t, kind: e.kind, row: e.row as unknown as RouteRow, reason: (e as { reason?: string }).reason }));

describe('accept.p3.ospf-convergence: §3.2 step 1, the first convergence', () => {
  it('routes at link-up + 15 s in one batch; an lsa-gen due with spf runs first; engine/pure parity on every router', () => {
    const t = triangle(41);
    // before the GigE links: 10.3.0.0/24 over the serial path
    expect(table(t.sim, 'r1')).toEqual([['10.3.0.0/24', 110, 65, '10.0.13.2', SE0]]);
    const { U, evs } = converge(t);
    const { sim } = t;
    expect(table(sim, 'r1')).toEqual([
      ['10.0.23.0/30', 110, 2, '10.0.12.2', GI0],
      ['10.3.0.0/24', 110, 3, '10.0.12.2', GI0],
    ]);
    // the GigE routes appear exactly at link-up + 15 s, as one batch (both rows in the same instant, key order)
    const writes = tableEvents(evs, 'r1', 'rib').filter((e) => e.kind === 'tableWrite' && (e.row as unknown as RouteRow).source === 'O' && (e.row as unknown as RouteRow).nextHop === '10.0.12.2');
    expect(writes.map((e) => [e.t - U, e.key])).toEqual([[15 * SEC, '10.0.23.0/30'], [15 * SEC, '10.3.0.0/24']]);
    for (const d of ['r2', 'r3']) {
      const first = tableEvents(evs, d, 'rib').filter((e) => e.kind === 'tableWrite' && (e.row as unknown as RouteRow).source === 'O' && (e.row as unknown as RouteRow).iface !== SE0);
      expect(first.length).toBeGreaterThan(0);
      expect(new Set(first.map((e) => e.t - U))).toEqual(new Set([15 * SEC]));
    }
    // SPF runs of R1 after link-up: U + 5 s (misses the neighbour's link back) and U + 15 s
    expect(debugLines(evs, 'r1', 'ip ospf spf').filter((l) => l.message.startsWith('SPF run')).map((l) => l.t - U)).toEqual([5 * SEC, 15 * SEC]);
    // an lsa-gen due with spf runs first: at U + 5 s R1's own router-LSA (now with both point-to-point links) is
    // written before the SPF line, once, although the lsa-gen timer was armed after the spf timer (at Full)
    const at5 = evs.filter((e) => e.t === U + 5 * SEC);
    const ownKey = '0.0.0.0|1|1.1.1.1|1.1.1.1';
    const own = at5.findIndex((e) => e.kind === 'tableWrite' && e.device === 'r1' && e.table === 'ospf-lsdb' && e.key === ownKey);
    const spf = at5.findIndex((e) => e.kind === 'debug' && e.event.device === 'r1' && e.event.message.startsWith('SPF run'));
    expect(own).toBeGreaterThanOrEqual(0);
    expect(spf).toBeGreaterThan(own);
    expect(at5.filter((e) => e.kind === 'tableWrite' && e.device === 'r1' && e.key === ownKey)).toHaveLength(1);
    const links = ((at5[own] as Extract<TraceEvent, { kind: 'tableWrite' }>).row.links as { kind: string; id: string }[]).filter((l) => l.kind === 'p2p').map((l) => l.id);
    expect(links).toEqual(['2.2.2.2', '3.3.3.3']);
    const scheduled = debugLines(evs, 'r1', 'ip ospf spf').filter((l) => l.message.startsWith('SPF scheduled'));
    expect(scheduled[0]!.t).toBe(U);
    expect(tableEvents(evs, 'r1', 'ospf-lsdb').filter((e) => e.kind === 'tableWrite' && e.key === ownKey).map((e) => e.t - U)).toEqual([0, 5 * SEC]);
    for (const d of ['r1', 'r2', 'r3']) expectPureParity(sim, d);
  });

  it('show ip route on R1: the exact lines, the second legend line included', () => {
    const t = triangle(42);
    converge(t);
    expect(showLines(t.sim, 'r1', 'show ip route')).toEqual([
      'Route source codes: C - connected, L - local, S - static, * - candidate default route',
      'Dynamic sources: O - OSPF, IA - OSPF inter area, E1/E2 - OSPF external type 1/2',
      '',
      'Default route: none configured',
      '',
      'C    10.0.12.0/30  connected  GigabitEthernet0/0',
      'L    10.0.12.1/32  connected  GigabitEthernet0/0',
      'C    10.0.13.0/30  connected  Serial0/0/0',
      'L    10.0.13.1/32  connected  Serial0/0/0',
      'O    10.0.23.0/30  via 10.0.12.2 [110/2] GigabitEthernet0/0',
      'C    10.1.0.0/24  connected  GigabitEthernet0/1',
      'L    10.1.0.1/32  connected  GigabitEthernet0/1',
      'O    10.3.0.0/24  via 10.0.12.2 [110/3] GigabitEthernet0/0',
    ]);
    expect(showLines(t.sim, 'r1', 'show ip route ospf').filter((l) => l.startsWith('O'))).toEqual([
      'O    10.0.23.0/30  via 10.0.12.2 [110/2] GigabitEthernet0/0',
      'O    10.3.0.0/24  via 10.0.12.2 [110/3] GigabitEthernet0/0',
    ]);
  });
});

/** One echo PC1 → PC3 in its own console session: the session and its send time. */
interface Echo {
  readonly session: SessionId;
  readonly at: SimTime;
}

function sendEcho(sim: Simulation): Echo {
  const session = sim.cli.open('pc1', 'console');
  sim.device('pc1')!.applyActions('icmpv4', [{ type: 'request', to: 'icmpv4', req: { kind: 'icmp.ping', session, target: PC3, count: 1, timeoutNs: SEC, sizeBytes: 100 } }], sim.now);
  return { session, at: sim.now };
}

/** Whether the echo of `e` was answered (its job's statistics line). */
function answered(evs: readonly TraceEvent[], e: Echo): boolean {
  let text = '';
  for (const x of evs) if (x.kind === 'cliOutput' && x.session === e.session) text += x.text;
  const m = /Sent 1, received (\d)/.exec(text);
  if (m === null) throw new Error(`no statistics for the echo sent at ${e.at}: ${JSON.stringify(text)}`);
  return m[1] === '1';
}

describe('accept.p3.ospf-convergence: §3.2 steps 2 and 3, a failure and the restore', () => {
  it('the cut at T: paths via Gi0/0 withdrawn at T, the serial route at T + 5 s ± 10 ms, ping loss only in [T, T + 5 s + ε]; the restore at T2 = T + 30 s returns [110/3] at T2 + 15 s ± 10 ms; parity throughout', () => {
    const t = triangle(43);
    const { U, l12 } = converge(t);
    const { sim } = t;
    // a ping stream, one echo every 100 ms from T − 2 s to T + 8 s, the cut at T = U + 60 s
    const T = U + 60 * SEC;
    sim.runUntil(T - 2 * SEC);
    const c = cursor(sim);
    const echoes: Echo[] = [];
    const STEP = 100 * MS_NS;
    for (let at = T - 2 * SEC; at < T + 8 * SEC; at += STEP) {
      sim.runUntil(at);
      if (at === T) sim.removeLink(l12);
      echoes.push(sendEcho(sim));
    }
    expect(sim.runToIdle().stopped).toBeUndefined();
    const evs = traceSince(sim, c);
    expect(portDownAt(evs, 'r1', GI0)).toBe(T);
    // 10.3.0.0/24 at R1: withdrawn at T (link-down, before any SPF), the serial path at T + 5 s ± 10 ms
    const r1 = RIB_WRITE(evs, 'r1', '10.3.0.0/24');
    expect(r1.map((w) => [w.kind, w.reason ?? w.row.nextHop])).toEqual([['tableExpire', 'link-down'], ['tableWrite', '10.0.13.2']]);
    expect(r1[0]!.t).toBe(T);
    expect(Math.abs(r1[1]!.t - (T + 5 * SEC))).toBeLessThanOrEqual(10 * MS_NS);
    expect(ribRow(sim, 'r1', '10.3.0.0/24')).toMatchObject({ source: 'O', ad: 110, metric: 65, nextHop: '10.0.13.2', iface: SE0 });
    expect(showLines(sim, 'r1', 'show ip route').find((l) => l.includes(' 10.3.0.0/24 '))).toBe('O    10.3.0.0/24  via 10.0.13.2 [110/65] Serial0/0/0');
    // the ping stream: losses only in [T, T + 5 s + ε], and every echo sent in [T, T + 5 s) is lost
    const EPS = 100 * MS_NS;
    const lost = echoes.filter((e) => !answered(evs, e)).map((e) => e.at - T);
    expect(lost.length).toBeGreaterThan(0);
    for (const at of lost) {
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThanOrEqual(5 * SEC + EPS);
    }
    for (const e of echoes) if (e.at >= T && e.at < T + 5 * SEC) expect(answered(evs, e), `echo at T + ${(e.at - T) / MS_NS} ms`).toBe(false);
    expect(echoes.filter((e) => e.at < T).every((e) => answered(evs, e))).toBe(true);
    expect(echoes.filter((e) => e.at > T + 5 * SEC + EPS).every((e) => answered(evs, e))).toBe(true);
    for (const d of ['r1', 'r2', 'r3']) expectPureParity(sim, d);

    // the restore at T2 = T + 30 s (both throttles free): [110/3] via 10.0.12.2 again at T2 + 15 s ± 10 ms
    const T2 = T + 30 * SEC;
    sim.runUntil(T2);
    const c2 = cursor(sim);
    const back = sim.addLink({ a: { device: 'r1', port: GI0 }, b: { device: 'r2', port: GI0 } });
    expect(sim.runToIdle().stopped).toBeUndefined();
    const evs2 = traceSince(sim, c2);
    expect(linkUpAt(evs2, back)).toBe(T2);
    const restored = RIB_WRITE(evs2, 'r1', '10.3.0.0/24').filter((w) => w.kind === 'tableWrite');
    expect(restored.map((w) => [w.row.nextHop, w.row.metric])).toEqual([['10.0.12.2', 3]]);
    expect(Math.abs(restored[0]!.t - (T2 + 15 * SEC))).toBeLessThanOrEqual(10 * MS_NS);
    expect(table(sim, 'r1')).toEqual([
      ['10.0.23.0/30', 110, 2, '10.0.12.2', GI0],
      ['10.3.0.0/24', 110, 3, '10.0.12.2', GI0],
    ]);
    for (const d of ['r1', 'r2', 'r3']) expectPureParity(sim, d);
  });

  it('the floating-static variant: the AD-120 static installs at T, the O route replaces it at T + 5 s', () => {
    const t = triangle(44, { floating: true });
    const { U, l12 } = converge(t);
    const { sim } = t;
    expect(ribRow(sim, 'r1', '10.3.0.0/24')).toMatchObject({ source: 'O', ad: 110, metric: 3 });
    const T = U + 60 * SEC;
    sim.runUntil(T);
    const c = cursor(sim);
    sim.removeLink(l12);
    expect(sim.runToIdle().stopped).toBeUndefined();
    const writes = RIB_WRITE(traceSince(sim, c), 'r1', '10.3.0.0/24').filter((w) => w.kind === 'tableWrite');
    expect(writes.map((w) => [w.t - T, w.row.source, w.row.ad, w.row.nextHop])).toEqual([
      [0, 'S', 120, '10.0.13.2'],
      [5 * SEC, 'O', 110, '10.0.13.2'],
    ]);
    expect(showLines(sim, 'r1', 'show ip route').find((l) => l.includes(' 10.3.0.0/24 '))).toBe('O    10.3.0.0/24  via 10.0.13.2 [110/65] Serial0/0/0');
  });
});

describe('accept.p3.ospf-convergence: grading in the clone', () => {
  it('a lab connectivity check with `after: [{cut: {a: R1, b: R2, aPort: Gi0/0}}]` passes in the clone and sees the serial path; the live world is untouched', () => {
    const t = triangle(45);
    converge(t);
    const { sim } = t;
    const before = JSON.stringify({ now: sim.now, head: sim.trace(0).next, topo: sim.exportTopology(), snapshot: sim.snapshot() });
    const after = [{ cut: { a: 'R1', b: 'R2', aPort: 'Gi0/0' } }] as const;
    const assertions: LabAssertion[] = [
      { kind: 'route', device: 'R1', destination: PC3, source: 'O', nextHop: '10.0.12.2', metric: 3 },
      {
        kind: 'connectivity',
        from: 'PC1',
        to: 'PC3',
        expect: 'success',
        after,
        settleMs: 60_000,
        then: [{ kind: 'route', device: 'R1', destination: PC3, source: 'O', nextHop: '10.0.13.2', iface: 'Serial0/0/0', metric: 65 }],
      },
      // a wrong answer: in the clone the path no longer uses R2
      { kind: 'connectivity', from: 'PC1', to: 'PC3', expect: 'success', after, settleMs: 60_000, then: [{ kind: 'route', device: 'R1', destination: PC3, source: 'O', nextHop: '10.0.12.2' }] },
    ];
    const lab: ScenarioInfo = {
      name: 'ospf-convergence-clone',
      title: 'OSPF failover',
      description: 'A lab built by the test',
      category: 'ccna2-lab',
      build: () => ({ schema: TOPOLOGY_SCHEMA_ID, seed: 1, devices: [], links: [] }),
      tasks: [{ id: 'only', title: 'Only task', description: 'One task', points: 10, assertions }],
    };
    const got = evaluateLab(sim, lab).results[0]!.assertions.map((r: LabCheckResult['assertions'][number]) => r.pass);
    expect(got).toEqual([true, true, false]);
    // grading never touched the live world
    expect(JSON.stringify({ now: sim.now, head: sim.trace(0).next, topo: sim.exportTopology(), snapshot: sim.snapshot() })).toBe(before);
    expect(ribRow(sim, 'r1', '10.3.0.0/24')).toMatchObject({ nextHop: '10.0.12.2', metric: 3 });
  });
});
