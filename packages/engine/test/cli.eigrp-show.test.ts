/**
 * cli.eigrp-show — [C1] the EIGRP shows and the clear (ARCHITECTURE-P3 §2.16, §3.12, §5.8; §7 W3 cli, approved items):
 * `show ip eigrp neighbors [<if>]`, `show ip eigrp topology [all-links | <prefix>]` (the §5.8 example byte for byte),
 * `show ip eigrp interfaces`, `show ip route eigrp` (the D11 `D` code and legend kept), `clear ip eigrp neighbors
 * [<address>]` and the `eigrp packets` / `eigrp fsm` debug categories — against fake `eigrp-neighbors` /
 * `eigrp-topology` tables and a fake `EigrpStateView`, then once on a real P3 world (the W2 eigrp daemon).
 */
import { describe, expect, it } from 'vitest';
import type { CommandCtx } from '../src/contracts/cli.js';
import type { EigrpNeighborRow, EigrpStateView, EigrpTopologyRow, RouteRow } from '../src/contracts/tables.js';
import { EIGRP_DEBUG_CATEGORIES, EIGRP_GRAMMAR, EIGRP_HANDLERS as E, EIGRP_TOPOLOGY_ALL_LINKS, EIGRP_TOPOLOGY_VIEW_ARG } from '../src/cli/grammar/eigrp.js';
import { ROUTE_SOURCE_ARG, SHOW_HANDLERS } from '../src/cli/grammar/show.js';
import {
  EIGRP_TOPOLOGY_CODES,
  MSG_EIGRP_NOT_RUNNING,
  MSG_EIGRP_TOPOLOGY_EMPTY,
  MSG_NO_EIGRP_INTERFACE,
} from '../src/cli/handlers/eigrp.js';
import { ROUTE_CODES_EIGRP, ROUTE_CODES_LEGEND } from '../src/cli/handlers/show.js';
import { createEigrp } from '../src/protocols/eigrp.js';
import { catalogModel, devicePortViews, type RecordingCtx } from './cli.p05.fixture.js';
import { createStagedSimulation } from './staged.world.js';
import { approvedCtx, handlerOf, parse, runOn, showCtx, showLines } from './cli.p3-approved.fixture.js';

const R = 'router.nf2911';
const SEC = 1_000_000_000;
const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';

/** §3.12's R1: Gi0/0 10.0.12.1/24, Gi0/1 10.0.13.1/24 (`bandwidth 100000`, `delay 10`), `router eigrp 100` / `network 10.0.0.0`. */
function r1(): RecordingCtx {
  const ports = devicePortViews(catalogModel(R));
  ports.set(GI0, { ...ports.get(GI0)!, l3: { ipv4: { address: '10.0.12.1', prefixLen: 24 } } });
  ports.set(GI1, { ...ports.get(GI1)!, l3: { ipv4: { address: '10.0.13.1', prefixLen: 24 } } });
  const rec = approvedCtx(R, { mode: 'priv-exec', ports });
  rec.running.set([], ['router', 'eigrp', '100']);
  rec.running.set([['router', 'eigrp', '100']], ['network', '10.0.0.0']);
  rec.running.set([['interface', GI1]], ['bandwidth', '100000']);
  rec.running.set([['interface', GI1]], ['delay', '10']);
  return rec;
}

function nbr(iface: string, address: string, extra: Partial<EigrpNeighborRow> = {}): EigrpNeighborRow {
  return { key: `${iface}|${address}`, updatedAt: 0, iface, address, as: 100, state: 'up', holdS: 15, srttMs: 1, rtoMs: 100, ...extra };
}

/** The §3.12 step 2 entry of 10.4.0.0/24 at R1. */
const TOPO_10_4: EigrpTopologyRow = {
  key: '10.4.0.0/24',
  updatedAt: 0,
  prefix: '10.4.0.0/24',
  state: 'passive',
  fd: 3328,
  successors: [{ nextHop: '10.0.12.2', iface: GI0, metric: 3328, rd: 3072 }],
  feasible: [{ nextHop: '10.0.13.3', iface: GI1, metric: 28672, rd: 3072 }],
  others: [],
};

const SV: EigrpStateView = {
  process: { as: 100, routerId: '10.0.13.1', kValues: [1, 0, 1, 0, 0], maximumPaths: 4 },
  neighbors: [{ iface: GI0, address: '10.0.12.2', holdUntil: 90 * SEC + 13_500_000_000, queue: 0, lastSeq: 5 }],
  active: [],
};

function ctxOf(rec: RecordingCtx, topology: readonly EigrpTopologyRow[], neighbors: readonly EigrpNeighborRow[] = [], sv: EigrpStateView = SV): CommandCtx {
  return showCtx(rec, {
    now: 90 * SEC,
    rows: { 'eigrp-topology': topology, 'eigrp-neighbors': neighbors },
    states: { eigrp: sv as unknown as Record<string, unknown> },
  });
}

describe('cli.eigrp-show grammar', () => {
  it('parses the shows, the clear and the route filter on a router', () => {
    expect(handlerOf(R, 'priv-exec', 'show ip eigrp neighbors')).toBe(E.showIpEigrpNeighbors);
    expect(handlerOf(R, 'priv-exec', 'show ip eigrp neighbors GigabitEthernet0/0')).toBe(E.showIpEigrpNeighbors);
    expect(handlerOf(R, 'user-exec', 'show ip eigrp topology')).toBe(E.showIpEigrpTopology);
    const all = parse(R, 'priv-exec', 'show ip eigrp topology all-links');
    expect(all.ok && all.args).toMatchObject({ [EIGRP_TOPOLOGY_VIEW_ARG]: EIGRP_TOPOLOGY_ALL_LINKS });
    const one = parse(R, 'priv-exec', 'show ip eigrp topology 10.4.0.0/24');
    expect(one.ok && one.args).toMatchObject({ prefix: '10.4.0.0/24' });
    expect(handlerOf(R, 'priv-exec', 'show ip eigrp interfaces')).toBe(E.showIpEigrpInterfaces);
    const route = parse(R, 'priv-exec', 'show ip route eigrp');
    expect(route.ok && route.spec.handler).toBe(SHOW_HANDLERS.showIpRoute);
    expect(route.ok && route.args).toMatchObject({ [ROUTE_SOURCE_ARG]: 'EIGRP' });
    expect(handlerOf(R, 'priv-exec', 'clear ip eigrp neighbors')).toBe(E.execClearIpEigrpNeighbors);
    expect(handlerOf(R, 'priv-exec', 'clear ip eigrp neighbors 10.0.12.2')).toBe(E.execClearIpEigrpNeighbors);
    expect(parse(R, 'user-exec', 'clear ip eigrp neighbors').ok).toBe(false);
    // the L2 switch runs no routing: no EIGRP show
    expect(parse('switch.nfc2960', 'priv-exec', 'show ip eigrp topology').ok).toBe(false);
  });

  it('registers eigrp packets and eigrp fsm, offered on routing devices (the eigrp row of §2.1)', () => {
    expect(EIGRP_DEBUG_CATEGORIES.map((d) => d.category)).toEqual(['eigrp packets', 'eigrp fsm']);
    for (const d of EIGRP_DEBUG_CATEGORIES) {
      expect(d.requiresAny, d.category).toEqual(['routing']);
      const spec = EIGRP_GRAMMAR.find((s) => s.path.join(' ') === `debug ${d.category}`);
      expect(spec?.fixedArgs, d.category).toEqual({ category: d.category });
      expect(spec?.requiresAny, d.category).toEqual(['routing']);
    }
    expect(handlerOf(R, 'priv-exec', 'debug eigrp packets')).toBe('exec.debug');
    expect(handlerOf(R, 'priv-exec', 'no debug eigrp fsm')).toBe('exec.debug');
    expect(parse('switch.nfc2960', 'priv-exec', 'debug eigrp packets').ok).toBe(false);
  });
});

describe('show ip eigrp topology', () => {
  it('prints the §5.8 example exactly: successor, then feasible successor', () => {
    expect(showLines(ctxOf(r1(), [TOPO_10_4]), E.showIpEigrpTopology)).toEqual([
      'EIGRP topology, AS 100, router ID 10.0.13.1',
      'Codes: P passive, A active, U update, Q query, R reply',
      '',
      'P 10.4.0.0/24, 1 successor, FD 3328',
      '        via 10.0.12.2 (3328/3072), GigabitEthernet0/0',
      '        via 10.0.13.3 (28672/3072), GigabitEthernet0/1',
    ]);
    expect(EIGRP_TOPOLOGY_CODES).toBe('Codes: P passive, A active, U update, Q query, R reply');
  });

  it('orders entries by network, shows connected networks, active entries and the infinite distance', () => {
    const connected: EigrpTopologyRow = { key: '10.0.12.0/24', updatedAt: 0, prefix: '10.0.12.0/24', state: 'passive', fd: 2816, successors: [], feasible: [], others: [], connected: GI0 };
    const active: EigrpTopologyRow = {
      key: '10.9.0.0/16', updatedAt: 0, prefix: '10.9.0.0/16', state: 'active', fd: 0xffff_ffff, successors: [], feasible: [],
      others: [{ nextHop: '10.0.13.3', iface: GI1, metric: 0xffff_ffff, rd: 0xffff_ffff }], pendingReplies: 2,
    };
    const lines = showLines(ctxOf(r1(), [active, TOPO_10_4, connected]), E.showIpEigrpTopology);
    expect(lines.slice(3)).toEqual([
      'P 10.0.12.0/24, 1 successor, FD 2816',
      '        via Connected, GigabitEthernet0/0',
      'P 10.4.0.0/24, 1 successor, FD 3328',
      '        via 10.0.12.2 (3328/3072), GigabitEthernet0/0',
      '        via 10.0.13.3 (28672/3072), GigabitEthernet0/1',
      'A 10.9.0.0/16, 0 successors, FD inaccessible, waiting for 2 replies',
    ]);
    // all-links adds the paths that fail the feasibility condition
    const all = showLines(ctxOf(r1(), [active]), E.showIpEigrpTopology, { [EIGRP_TOPOLOGY_VIEW_ARG]: EIGRP_TOPOLOGY_ALL_LINKS });
    expect(all.slice(3)).toEqual([
      'A 10.9.0.0/16, 0 successors, FD inaccessible, waiting for 2 replies',
      '        via 10.0.13.3 (inaccessible/inaccessible), GigabitEthernet0/1',
    ]);
  });

  it('shows one prefix with every path (host bits cleared), and says when it is absent', () => {
    const r: EigrpTopologyRow = { ...TOPO_10_4, others: [{ nextHop: '10.0.14.4', iface: GI1, metric: 40000, rd: 5000 }] };
    expect(showLines(ctxOf(r1(), [r]), E.showIpEigrpTopology, { prefix: '10.4.0.9/24' }).slice(3)).toEqual([
      'P 10.4.0.0/24, 1 successor, FD 3328',
      '        via 10.0.12.2 (3328/3072), GigabitEthernet0/0',
      '        via 10.0.13.3 (28672/3072), GigabitEthernet0/1',
      '        via 10.0.14.4 (40000/5000), GigabitEthernet0/1',
    ]);
    expect(showLines(ctxOf(r1(), [r]), E.showIpEigrpTopology, { prefix: '10.5.0.0/24' })).toEqual(['10.5.0.0/24 is not in the EIGRP topology table.']);
  });

  it('says so with an empty table, without a process, and before a router id is chosen', () => {
    expect(showLines(ctxOf(r1(), []), E.showIpEigrpTopology).slice(3)).toEqual([MSG_EIGRP_TOPOLOGY_EMPTY]);
    expect(showLines(showCtx(approvedCtx(R, { mode: 'priv-exec' })), E.showIpEigrpTopology)).toEqual([MSG_EIGRP_NOT_RUNNING]);
    // configured, the daemon not running yet (pre-flip): the AS from the configuration
    expect(showLines(showCtx(r1()), E.showIpEigrpTopology)[0]).toBe('EIGRP topology, AS 100, router ID not chosen yet');
  });
});

describe('show ip eigrp neighbors', () => {
  it('lists the rows in interface order with the StateView hold countdown, queue and sequence', () => {
    const rows = [nbr(GI1, '10.0.13.3', { state: 'pending', srttMs: 0, rtoMs: 0 }), nbr(GI0, '10.0.12.2', { upSince: 10 * SEC })];
    expect(showLines(ctxOf(r1(), [], rows), E.showIpEigrpNeighbors)).toEqual([
      'EIGRP neighbours, AS 100',
      'H  Address    Interface  Hold (s)  Up for    SRTT (ms)  RTO (ms)  Queue  Seq',
      '0  10.0.12.2  Gi0/0      13        00:01:20  1          100       0      5',
      '1  10.0.13.3  Gi0/1      15        pending   0          0         0      0',
    ]);
    // one interface; the rows of another AS are not this process's
    const other = nbr(GI0, '10.0.12.9', { as: 200 });
    expect(showLines(ctxOf(r1(), [], [...rows, other]), E.showIpEigrpNeighbors, { iface: GI1 }).slice(2)).toEqual([
      '0  10.0.13.3  Gi0/1      15        pending  0          0         0      0',
    ]);
    expect(showLines(ctxOf(r1(), [], []), E.showIpEigrpNeighbors)).toEqual(['EIGRP neighbours, AS 100', 'No EIGRP neighbour has been found.']);
    expect(runOn(ctxOf(r1(), [], rows), E.showIpEigrpNeighbors, { iface: 'Gi9/9' })).toEqual({ error: '% No interface named "Gi9/9" exists on this device.' });
  });
});

describe('show ip eigrp interfaces', () => {
  it('lists the covered interfaces with peers, timers, the metric bandwidth and delay, and passive ones', () => {
    const rec = r1();
    rec.running.set([['router', 'eigrp', '100']], ['passive-interface', GI1]);
    rec.running.set([['interface', GI0]], ['ip', 'hello-interval', 'eigrp', '100', '2']);
    const lines = showLines(ctxOf(rec, [], [nbr(GI0, '10.0.12.2', { upSince: 0 })]), E.showIpEigrpInterfaces);
    expect(lines).toEqual([
      'EIGRP interfaces, AS 100',
      'Interface  Peers  Hello (s)  Hold (s)  Bandwidth (kb/s)  Delay (usec)  Passive',
      'Gi0/0      1      2          15        1000000           10            no',
      'Gi0/1      0      5          15        100000            100           yes',
    ]);
    const none = approvedCtx(R, { mode: 'priv-exec' });
    none.running.set([], ['router', 'eigrp', '100']);
    expect(showLines(showCtx(none), E.showIpEigrpInterfaces)).toEqual(['EIGRP interfaces, AS 100', MSG_NO_EIGRP_INTERFACE]);
    expect(showLines(showCtx(approvedCtx(R, { mode: 'priv-exec' })), E.showIpEigrpInterfaces)).toEqual([MSG_EIGRP_NOT_RUNNING]);
  });
});

describe('show ip route eigrp', () => {
  function withRoutes(rec: RecordingCtx, rows: readonly RouteRow[]): CommandCtx {
    for (const r of rows) rec.ctx.tables.rib.set(r);
    return showCtx(rec);
  }
  const d: RouteRow = { key: '10.4.0.0/24|EIGRP', updatedAt: 0, network: '10.4.0.0', prefixLen: 24, source: 'EIGRP', ad: 90, metric: 3328, nextHop: '10.0.12.2', iface: GI0 } as RouteRow;
  const c: RouteRow = { key: '10.0.12.0/24|C', updatedAt: 0, network: '10.0.12.0', prefixLen: 24, source: 'C', ad: 0, metric: 0, iface: GI0 } as RouteRow;

  it('keeps only the EIGRP routes, with the D code and the D11 legend line', () => {
    expect(showLines(withRoutes(r1(), [c, d]), SHOW_HANDLERS.showIpRoute, { [ROUTE_SOURCE_ARG]: 'EIGRP' })).toEqual([
      ROUTE_CODES_LEGEND,
      `Dynamic sources: ${ROUTE_CODES_EIGRP}`,
      '',
      'Default route: none configured',
      '',
      'D    10.4.0.0/24  via 10.0.12.2 [90/3328] GigabitEthernet0/0',
    ]);
  });

  it('says so when EIGRP learned no route', () => {
    const lines = showLines(withRoutes(r1(), [c]), SHOW_HANDLERS.showIpRoute, { [ROUTE_SOURCE_ARG]: 'EIGRP' });
    expect(lines[lines.length - 1]).toBe('The routing table holds no EIGRP route.');
  });
});

describe('clear ip eigrp neighbors', () => {
  it('sends eigrp.clear for every neighbour or one address, not interactive', () => {
    const rec = r1();
    expect(runOn(rec.ctx, E.execClearIpEigrpNeighbors)).toEqual({});
    expect(runOn(rec.ctx, E.execClearIpEigrpNeighbors, { address: '10.0.12.2' })).toEqual({});
    expect(rec.requests).toEqual([
      { to: 'eigrp', req: { kind: 'eigrp.clear', session: 's_1' } },
      { to: 'eigrp', req: { kind: 'eigrp.clear', session: 's_1', neighbor: '10.0.12.2' } },
    ]);
    const none = approvedCtx(R, { mode: 'priv-exec' });
    expect(runOn(none.ctx, E.execClearIpEigrpNeighbors)).toEqual({ output: MSG_EIGRP_NOT_RUNNING });
    expect(none.requests).toEqual([]);
  });
});

describe('on a real P3 world (the W2 eigrp daemon)', () => {
  it('two routers form a neighbour; the shows read the real tables and StateView; clear and debug are accepted', () => {
    const sim = createStagedSimulation({ seed: 5, stage: 'P3', factories: { eigrp: createEigrp } });
    const cfg = (name: string, a: string, lan: string): string =>
      `hostname ${name}\n!\ninterface GigabitEthernet0/0\n ip address ${a} 255.255.255.0\n no shutdown\n!\ninterface GigabitEthernet0/1\n ip address ${lan} 255.255.255.0\n no shutdown\n!\nrouter eigrp 100\n network 10.0.0.0\n!\nend\n`;
    sim.addDevice({ id: 'r1', type: R, name: 'R1', startupConfig: cfg('R1', '10.0.12.1', '10.1.0.1') });
    sim.addDevice({ id: 'r2', type: R, name: 'R2', startupConfig: cfg('R2', '10.0.12.2', '10.2.0.1') });
    sim.addDevice({ id: 'pc', type: 'pc.nfpc', name: 'PC2' });
    sim.addLink({ a: { device: 'r1', port: GI0 }, b: { device: 'r2', port: GI0 } });
    sim.addLink({ a: { device: 'r2', port: GI1 }, b: { device: 'pc', port: 'GigabitEthernet0' } });
    sim.runFor(120 * SEC);
    const s = sim.cli.open('r1', 'console');
    sim.cli.exec(s, 'enable');
    const nbrs = sim.cli.exec(s, 'show ip eigrp neighbors').output.split('\n');
    expect(nbrs[0]).toBe('EIGRP neighbours, AS 100');
    expect(nbrs[2]).toMatch(/^0 {2}10\.0\.12\.2 {2}Gi0\/0 +\d+ +\d\d:\d\d:\d\d /);
    const topo = sim.cli.exec(s, 'show ip eigrp topology').output.split('\n');
    // the router id is the daemon's choice (its StateView), not the CLI's
    expect(topo[0]).toMatch(/^EIGRP topology, AS 100, router ID 10\.(?:0\.12|1\.0)\.1$/);
    expect(topo.slice(1, 3)).toEqual([EIGRP_TOPOLOGY_CODES, '']);
    expect(topo).toContain('P 10.2.0.0/24, 1 successor, FD 3072');
    expect(topo).toContain('        via 10.0.12.2 (3072/2816), GigabitEthernet0/0');
    expect(sim.cli.exec(s, 'show ip route eigrp').output.split('\n')).toContain('D    10.2.0.0/24  via 10.0.12.2 [90/3072] GigabitEthernet0/0');
    expect(sim.cli.exec(s, 'show ip eigrp interfaces').output.split('\n')[2]).toBe('Gi0/0      1      5          15        1000000           10            no');
    expect(sim.cli.exec(s, 'clear ip eigrp neighbors 10.0.12.2').output).toBe('');
    expect(sim.cli.exec(s, 'debug eigrp fsm').output).toBe('Debugging enabled for eigrp fsm.');
  });
});
