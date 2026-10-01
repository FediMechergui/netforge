// [C1] The EIGRP overlay model (ARCHITECTURE-P3 §6, §2.16, §3.12, §10.2 "overlays.eigrp-model"): S and FS chips from
// `eigrp-topology` rows, the live `RD 3072 < FD 3328` text, the active badge, and the prefix choice.
import { describe, expect, it } from 'vitest';
import { EIGRP_INFINITY } from '@netforge/engine';
import type { DeviceSnapshot, EigrpPath, EigrpTopologyRow, PortSnapshot } from '@netforge/engine';
import {
  buildEigrpOverlay,
  chooseEigrpPrefix,
  deriveDeviceEigrp,
  eigrpMetricText,
  eigrpPrefixesOf,
  feasibilityText,
} from '../src/canvas/overlays/eigrp-model.js';
import { device, link, port, snapshot } from './canvas-fixtures.js';

const LAN = '10.4.0.0/24';

function path(nextHop: string, iface: string, metric: number, rd: number): EigrpPath {
  return { nextHop, iface, metric, rd };
}

function topo(prefix: string, over: Partial<EigrpTopologyRow> = {}): EigrpTopologyRow {
  return { key: prefix, prefix, state: 'passive', fd: 0, successors: [], feasible: [], others: [], ...over } as EigrpTopologyRow;
}

function routed(id: string, linkId: string): PortSnapshot {
  return port(id, { short: id, role: 'routed', operUp: true, link: linkId });
}

function router(id: string, ports: PortSnapshot[], rows: EigrpTopologyRow[]): DeviceSnapshot {
  return device(id, 0, 0, ports, {
    type: 'router.nf2911',
    model: 'NF-2911',
    kind: 'router',
    tables: { cam: [], arp: [], rib: [], extra: [{ name: 'eigrp-topology', title: 'EIGRP topology', columns: [], rows: rows as unknown as Record<string, unknown>[] }] },
  });
}

/**
 * §3.12: R1 Gi0/0 — R2 (l12), R1 Gi0/1 — R3 (l13, 100 Mb/s, 100 µs), R2 — R4 (l24), R3 — R4 (l34), R4's LAN 10.4.0.0/24.
 * `withFs` false is step 4's variant: R3 — R4 is slow too, so R3 is no feasible successor for R1.
 */
function diamond(opts: { withFs?: boolean; r1Active?: boolean } = {}) {
  const withFs = opts.withFs ?? true;
  const r1Row = topo(LAN, {
    fd: 3328,
    successors: [path('10.0.12.2', 'Gi0/0', 3328, 3072)],
    feasible: withFs ? [path('10.0.13.3', 'Gi0/1', 28672, 3072)] : [],
    others: withFs ? [] : [path('10.0.13.3', 'Gi0/1', 30976, 28416)],
    ...(opts.r1Active === true ? { state: 'active' as const, pendingReplies: 1 } : {}),
  });
  const r1 = router('r1', [routed('Gi0/0', 'l12'), routed('Gi0/1', 'l13')], [
    r1Row,
    topo('10.0.12.0/24', { fd: 2816, connected: 'Gi0/0' }),
  ]);
  const r2 = router('r2', [routed('Gi0/0', 'l12'), routed('Gi0/1', 'l24')], [
    topo(LAN, { fd: 3072, successors: [path('10.0.24.4', 'Gi0/1', 3072, 2816)], others: [path('10.0.12.1', 'Gi0/0', 3584, 3328)] }),
  ]);
  const r3 = router('r3', [routed('Gi0/0', 'l13'), routed('Gi0/1', 'l34')], [
    topo(LAN, withFs ? { fd: 3072, successors: [path('10.0.34.4', 'Gi0/1', 3072, 2816)], others: [path('10.0.13.1', 'Gi0/0', 28928, 3328)] } : { fd: 28416, successors: [path('10.0.34.4', 'Gi0/1', 28416, 2816)] }),
  ]);
  const r4 = router('r4', [routed('Gi0/0', 'l24'), routed('Gi0/1', 'l34'), routed('Gi0/2', 'lan')], [topo(LAN, { fd: 2816, connected: 'Gi0/2' })]);
  const pc4 = device('pc4', 0, 0, [routed('Gi0', 'lan')]);
  return snapshot([r1, r2, r3, r4, pc4], [
    link('l12', ['r1', 'Gi0/0'], ['r2', 'Gi0/0']),
    link('l13', ['r1', 'Gi0/1'], ['r3', 'Gi0/0']),
    link('l24', ['r2', 'Gi0/1'], ['r4', 'Gi0/0']),
    link('l34', ['r3', 'Gi0/1'], ['r4', 'Gi0/1']),
    link('lan', ['r4', 'Gi0/2'], ['pc4', 'Gi0']),
  ]);
}

describe('the feasibility text', () => {
  it('prints the live inequality, with ∞ for an unreachable distance', () => {
    expect(feasibilityText(3072, 3328)).toBe('RD 3072 < FD 3328');
    expect(feasibilityText(28416, 3328)).toBe('RD 28416 ≥ FD 3328');
    expect(feasibilityText(3328, 3328)).toBe('RD 3328 ≥ FD 3328');
    expect(feasibilityText(EIGRP_INFINITY, 3328)).toBe('RD ∞ ≥ FD 3328');
    expect(eigrpMetricText(EIGRP_INFINITY)).toBe('∞');
    expect(eigrpMetricText(28672)).toBe('28672');
  });
});

describe('the overlay model', () => {
  it('chips the successor S and the feasible successor FS from the topology rows (§3.12 step 2)', () => {
    const model = buildEigrpOverlay(diamond(), { prefix: LAN });
    expect(model.prefix).toBe(LAN);
    const r1 = model.paths.filter((p) => p.device === 'r1');
    expect(r1).toEqual([
      { device: 'r1', iface: 'Gi0/0', nextHop: '10.0.12.2', link: 'l12', end: 'a', role: 'successor', chip: 'S', weight: 'thick', metric: 3328, rd: 3072, feasible: true, inequality: 'RD 3072 < FD 3328' },
      { device: 'r1', iface: 'Gi0/1', nextHop: '10.0.13.3', link: 'l13', end: 'a', role: 'feasible', chip: 'FS', weight: 'medium', metric: 28672, rd: 3072, feasible: true, inequality: 'RD 3072 < FD 3328' },
    ]);
    // Paths that fail the condition draw nothing.
    const r2Back = model.paths.find((p) => p.device === 'r2' && p.role === 'other');
    expect(r2Back).toMatchObject({ chip: '', weight: 'none', feasible: false, inequality: 'RD 3328 ≥ FD 3072' });
  });

  it('writes RD 3072 < FD 3328 at R1, the router with a feasible successor', () => {
    const model = buildEigrpOverlay(diamond(), { prefix: LAN });
    expect(model.routers.find((r) => r.device === 'r1')).toEqual({
      device: 'r1',
      prefix: LAN,
      state: 'passive',
      badge: '',
      fd: 3328,
      text: 'RD 3072 < FD 3328',
      holds: true,
      successors: 1,
      feasibleSuccessors: 1,
    });
    expect(model.routers.find((r) => r.device === 'r4')).toMatchObject({ connected: 'Gi0/2', text: '', holds: false, successors: 0 });
    expect(model.routers.map((r) => r.device)).toEqual(['r1', 'r2', 'r3', 'r4']);
  });

  it('weighs each cable by its heaviest path: thick successors, medium feasible successors', () => {
    const model = buildEigrpOverlay(diamond(), { prefix: LAN });
    expect(model.links).toEqual([
      { link: 'l12', weight: 'thick' },
      { link: 'l13', weight: 'medium' },
      { link: 'l24', weight: 'thick' },
      { link: 'l34', weight: 'thick' },
    ]);
  });

  it('shows why there is no backup when the condition fails (§3.12 step 4), and A while the route is active', () => {
    const noFs = buildEigrpOverlay(diamond({ withFs: false }), { prefix: LAN });
    const r1 = noFs.routers.find((r) => r.device === 'r1');
    expect(r1).toMatchObject({ text: 'RD 28416 ≥ FD 3328', holds: false, feasibleSuccessors: 0, badge: '' });
    expect(noFs.links.find((l) => l.link === 'l13')).toBeUndefined();
    expect(noFs.paths.find((p) => p.device === 'r1' && p.iface === 'Gi0/1')).toMatchObject({ role: 'other', chip: '', weight: 'none' });

    const active = buildEigrpOverlay(diamond({ withFs: false, r1Active: true }), { prefix: LAN });
    expect(active.routers.find((r) => r.device === 'r1')).toMatchObject({ state: 'active', badge: 'A', pendingReplies: 1 });
  });

  it('draws the chosen prefix, the first in address order by default, and nothing when no router knows one', () => {
    const snap = diamond();
    expect(eigrpPrefixesOf(snap)).toEqual(['10.0.12.0/24', LAN]);
    expect(chooseEigrpPrefix(['10.0.12.0/24', LAN], LAN)).toBe(LAN);
    expect(chooseEigrpPrefix(['10.0.12.0/24', LAN], '192.168.9.0/24')).toBe('10.0.12.0/24');
    expect(chooseEigrpPrefix([], LAN)).toBeNull();
    const first = buildEigrpOverlay(snap);
    expect(first.prefix).toBe('10.0.12.0/24');
    expect(first.routers).toEqual([
      { device: 'r1', prefix: '10.0.12.0/24', state: 'passive', badge: '', fd: 2816, text: '', holds: false, successors: 0, feasibleSuccessors: 0, connected: 'Gi0/0' },
    ]);
    expect(first.links).toEqual([]);
    expect(buildEigrpOverlay(snapshot([device('pc1', 0, 0, [port('Gi0')])]), { prefix: LAN })).toEqual({ prefix: null, prefixes: [], routers: [], paths: [], links: [] });
  });

  it('sorts prefixes by address then length, not as text', () => {
    const r = router('r1', [], [topo('10.10.0.0/16'), topo('10.9.0.0/24'), topo('10.9.0.0/16'), topo('9.0.0.0/8')]);
    expect(eigrpPrefixesOf(snapshot([r]))).toEqual(['9.0.0.0/8', '10.9.0.0/16', '10.9.0.0/24', '10.10.0.0/16']);
  });

  it('derives a device once from its object and skips rows that are not topology entries', () => {
    const r = router('r1', [], [topo(LAN, { fd: 1 }), { key: 'x', junk: true } as unknown as EigrpTopologyRow]);
    expect([...deriveDeviceEigrp(r).topology.keys()]).toEqual([LAN]);
    const snap = diamond();
    let calls = 0;
    buildEigrpOverlay(snap, { prefix: LAN }, (d) => {
      calls++;
      return deriveDeviceEigrp(d);
    });
    expect(calls).toBe(snap.devices.length);
  });
});
