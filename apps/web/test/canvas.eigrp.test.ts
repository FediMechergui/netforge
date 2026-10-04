// [C1] The EIGRP overlay layer's pure parts (ARCHITECTURE-P3 §6, §2.16, §3.12; W3 web-canvas): underlay widths (thick
// successor, medium feasible successor, never a dash), chip and inequality placement, the chips per port, and the text
// forms (per port, router and link) the keyboard outline reads, with the live `RD 3072 < FD 3328`.
import { describe, expect, it } from 'vitest';
import { EIGRP_INFINITY } from '@netforge/engine';
import type { DeviceSnapshot, EigrpPath, EigrpTopologyRow, PortSnapshot } from '@netforge/engine';
import {
  EIGRP_CHIP_INSET,
  EIGRP_MEDIUM_WIDTH,
  EIGRP_THICK_WIDTH,
  INEQUALITY_LIFT,
  describeEigrpPath,
  describeEigrpRouter,
  eigrpDeviceFacts,
  eigrpLinkFacts,
  eigrpPortFacts,
  eigrpWidth,
  inequalityPoint,
  pathChipPoint,
  portChips,
  shortEigrpRouter,
} from '../src/canvas/eigrp.js';
import { buildEigrpOverlay, type EigrpOverlayModel, type EigrpPathMark } from '../src/canvas/overlays/eigrp-model.js';
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
 * §3.12: R1 Gi0/0 — R2 (l12), R1 Gi0/1 — R3 (l13), R2 — R4 (l24), R3 — R4 (l34), R4's LAN 10.4.0.0/24. `withFs` false is
 * step 4's variant: R3 — R4 is slow too, so R3 is no feasible successor for R1.
 */
function diamond(opts: { withFs?: boolean; r1Active?: boolean } = {}) {
  const withFs = opts.withFs ?? true;
  const r1 = router('r1', [routed('Gi0/0', 'l12'), routed('Gi0/1', 'l13')], [
    topo(LAN, {
      fd: 3328,
      successors: [path('10.0.12.2', 'Gi0/0', 3328, 3072)],
      feasible: withFs ? [path('10.0.13.3', 'Gi0/1', 28672, 3072)] : [],
      others: withFs ? [] : [path('10.0.13.3', 'Gi0/1', 30976, 28416)],
      ...(opts.r1Active === true ? { state: 'active' as const, pendingReplies: 1 } : {}),
    }),
    topo('10.0.12.0/24', { fd: 2816, connected: 'Gi0/0' }),
  ]);
  const r2 = router('r2', [routed('Gi0/0', 'l12'), routed('Gi0/1', 'l24')], [
    topo(LAN, { fd: 3072, successors: [path('10.0.24.4', 'Gi0/1', 3072, 2816)], others: [path('10.0.12.1', 'Gi0/0', 3584, 3328)] }),
  ]);
  const r3 = router('r3', [routed('Gi0/0', 'l13'), routed('Gi0/1', 'l34')], [
    topo(
      LAN,
      withFs
        ? { fd: 3072, successors: [path('10.0.34.4', 'Gi0/1', 3072, 2816)], others: [path('10.0.13.1', 'Gi0/0', 28928, 3328)] }
        : { fd: 28416, successors: [path('10.0.34.4', 'Gi0/1', 28416, 2816)] },
    ),
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

const upper = (id: string): string => id.toUpperCase();

describe('geometry', () => {
  it('weights the underlay: thick for a successor, medium for a feasible successor, nothing otherwise', () => {
    expect(eigrpWidth('thick')).toBe(EIGRP_THICK_WIDTH);
    expect(eigrpWidth('medium')).toBe(EIGRP_MEDIUM_WIDTH);
    expect(eigrpWidth('none')).toBe(0);
    expect(eigrpWidth('medium', 0.5)).toBe(EIGRP_MEDIUM_WIDTH / 2);
    expect(EIGRP_THICK_WIDTH).toBeGreaterThan(EIGRP_MEDIUM_WIDTH);
  });

  it('puts a path chip out of the router port along the cable, and the inequality above the router', () => {
    expect(pathChipPoint({ x: 10, y: 20, nx: 0, ny: 1 })).toEqual({ x: 10, y: 20 + EIGRP_CHIP_INSET });
    expect(pathChipPoint({ x: 10, y: 20, nx: -1, ny: 0 }, 2)).toEqual({ x: 10 - 2 * EIGRP_CHIP_INSET, y: 20 });
    expect(inequalityPoint({ x: 100, y: 200, halfH: 18 })).toEqual({ x: 100, y: 200 - 18 - INEQUALITY_LIFT });
  });
});

describe('the chips', () => {
  it('chips the successor S and the feasible successor FS at the router ends, and nothing for a failing path', () => {
    expect([...portChips(buildEigrpOverlay(diamond(), { prefix: LAN }))]).toEqual([
      ['r1/Gi0/0', 'S'],
      ['r1/Gi0/1', 'FS'],
      ['r2/Gi0/1', 'S'],
      ['r3/Gi0/1', 'S'],
    ]);
    expect([...portChips(buildEigrpOverlay(diamond({ withFs: false }), { prefix: LAN })).keys()]).toEqual(['r1/Gi0/0', 'r2/Gi0/1', 'r3/Gi0/1']);
    expect(portChips(null).size).toBe(0);
  });

  it('joins the chips of two neighbours behind one port, once each', () => {
    const base = buildEigrpOverlay(diamond(), { prefix: LAN });
    const s = base.paths[0]!;
    const model: EigrpOverlayModel = {
      ...base,
      paths: [s, { ...s, nextHop: '10.0.12.9' }, { ...s, nextHop: '10.0.12.8', role: 'feasible', chip: 'FS', weight: 'medium' }],
    };
    expect([...portChips(model)]).toEqual([['r1/Gi0/0', 'S FS']]);
  });
});

describe('the text forms (keyboard outline)', () => {
  it('says each path with its distances and the feasibility condition', () => {
    const model = buildEigrpOverlay(diamond(), { prefix: LAN });
    expect([...eigrpPortFacts(model)]).toEqual([
      ['r1/Gi0/0', { short: 'S', text: 'successor to 10.4.0.0/24 via 10.0.12.2, distance 3328, reported 3072 (RD 3072 < FD 3328)' }],
      ['r1/Gi0/1', { short: 'FS', text: 'feasible successor to 10.4.0.0/24 via 10.0.13.3, distance 28672, reported 3072 (RD 3072 < FD 3328)' }],
      ['r2/Gi0/1', { short: 'S', text: 'successor to 10.4.0.0/24 via 10.0.24.4, distance 3072, reported 2816 (RD 2816 < FD 3072)' }],
      [
        'r2/Gi0/0',
        { short: 'RD 3328 ≥ FD 3072', text: 'path to 10.4.0.0/24 via 10.0.12.1, distance 3584, reported 3328; fails the feasibility condition (RD 3328 ≥ FD 3072)' },
      ],
      ['r3/Gi0/1', { short: 'S', text: 'successor to 10.4.0.0/24 via 10.0.34.4, distance 3072, reported 2816 (RD 2816 < FD 3072)' }],
      [
        'r3/Gi0/0',
        { short: 'RD 3328 ≥ FD 3072', text: 'path to 10.4.0.0/24 via 10.0.13.1, distance 28928, reported 3328; fails the feasibility condition (RD 3328 ≥ FD 3072)' },
      ],
    ]);
    const unreachable: EigrpPathMark = {
      device: 'r1',
      iface: 'Gi0/1',
      nextHop: '10.0.13.3',
      role: 'other',
      chip: '',
      weight: 'none',
      metric: EIGRP_INFINITY,
      rd: EIGRP_INFINITY,
      feasible: false,
      inequality: 'RD ∞ ≥ FD 3328',
    };
    expect(describeEigrpPath(unreachable, LAN)).toBe('path to 10.4.0.0/24 via 10.0.13.3, distance ∞, reported ∞; fails the feasibility condition (RD ∞ ≥ FD 3328)');
  });

  it('says each router: its state, FD, counts and the live inequality (§3.12 steps 2 and 4)', () => {
    expect([...eigrpDeviceFacts(buildEigrpOverlay(diamond(), { prefix: LAN }))]).toEqual([
      ['r1', { short: 'RD 3072 < FD 3328', text: 'EIGRP 10.4.0.0/24: passive, FD 3328, 1 successor, 1 feasible successor; RD 3072 < FD 3328, a backup is ready' }],
      ['r2', { short: 'RD 3328 ≥ FD 3072', text: 'EIGRP 10.4.0.0/24: passive, FD 3072, 1 successor, 0 feasible successors; RD 3328 ≥ FD 3072, no feasible successor' }],
      ['r3', { short: 'RD 3328 ≥ FD 3072', text: 'EIGRP 10.4.0.0/24: passive, FD 3072, 1 successor, 0 feasible successors; RD 3328 ≥ FD 3072, no feasible successor' }],
      ['r4', { short: 'connected', text: 'EIGRP 10.4.0.0/24: directly connected on Gi0/2' }],
    ]);
    const step4 = buildEigrpOverlay(diamond({ withFs: false }), { prefix: LAN });
    expect(eigrpDeviceFacts(step4).get('r1')).toEqual({
      short: 'RD 28416 ≥ FD 3328',
      text: 'EIGRP 10.4.0.0/24: passive, FD 3328, 1 successor, 0 feasible successors; RD 28416 ≥ FD 3328, no feasible successor',
    });
  });

  it('carries the A badge while the route is active, with the replies it still waits for', () => {
    const r1 = buildEigrpOverlay(diamond({ r1Active: true }), { prefix: LAN }).routers[0]!;
    expect(shortEigrpRouter(r1)).toBe('A RD 3072 < FD 3328');
    expect(describeEigrpRouter(r1)).toBe(
      'EIGRP 10.4.0.0/24: active, querying its neighbours (1 reply awaited), FD 3328, 1 successor, 1 feasible successor; RD 3072 < FD 3328, a backup is ready',
    );
    expect(shortEigrpRouter({ ...r1, text: '', badge: '' })).toBe('FD 3328');
    expect(describeEigrpRouter({ ...r1, pendingReplies: 2 })).toContain('(2 replies awaited)');
  });

  it('says which router uses each weighted cable, and skips the cables nobody uses', () => {
    expect([...eigrpLinkFacts(buildEigrpOverlay(diamond(), { prefix: LAN }), upper)]).toEqual([
      ['l12', { short: 'S', text: 'EIGRP 10.4.0.0/24: successor path of R1' }],
      ['l13', { short: 'FS', text: 'EIGRP 10.4.0.0/24: feasible successor path of R1' }],
      ['l24', { short: 'S', text: 'EIGRP 10.4.0.0/24: successor path of R2' }],
      ['l34', { short: 'S', text: 'EIGRP 10.4.0.0/24: successor path of R3' }],
    ]);
    expect([...eigrpLinkFacts(buildEigrpOverlay(diamond({ withFs: false }), { prefix: LAN })).keys()]).toEqual(['l12', 'l24', 'l34']);
  });

  it('follows the chosen prefix, and says nothing with the overlay off or no prefix known', () => {
    const other = buildEigrpOverlay(diamond(), { prefix: '10.0.12.0/24' });
    expect([...eigrpDeviceFacts(other)]).toEqual([['r1', { short: 'connected', text: 'EIGRP 10.0.12.0/24: directly connected on Gi0/0' }]]);
    expect(eigrpPortFacts(other).size).toBe(0);
    expect(eigrpLinkFacts(other).size).toBe(0);
    const empty = buildEigrpOverlay(snapshot([device('pc1', 0, 0, [port('Gi0')])]), {});
    expect(empty.prefix).toBeNull();
    expect(eigrpPortFacts(empty).size).toBe(0);
    expect(eigrpDeviceFacts(empty).size).toBe(0);
    expect(eigrpLinkFacts(empty).size).toBe(0);
    expect(eigrpPortFacts(null).size).toBe(0);
    expect(eigrpDeviceFacts(null).size).toBe(0);
    expect(eigrpLinkFacts(null).size).toBe(0);
  });
});
