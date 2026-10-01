// protocols/eigrp/dual.ts [C1] (ARCHITECTURE-P3 D26, §2.16, §3.12, §4.5; §7 W1 eigrp): DUAL per destination on the
// §3.12 topology — feasibility, the local computation (feasible successor promoted, no query, poison reverse), the
// active phase with queries and replies, a neighbour lost while active, split horizon and poison reverse, equal-cost
// successors under maximum-paths, directly connected networks and the eigrp-topology row.
import { describe, expect, it } from 'vitest';
import { EIGRP_INFINITY } from '../src/contracts/pdu.js';
import {
  DUAL_CAUSE,
  dualEntry,
  dualIsEmpty,
  dualNeighborKey,
  dualReplyDistance,
  dualSplitHorizon,
  dualStep,
  dualTopologyRow,
  type DualContext,
  type DualEntry,
  type DualInput,
  type DualNeighbor,
  type DualOutcome,
} from '../src/protocols/eigrp/dual.js';
import { eigrpConnectedVector, eigrpMetric, eigrpVectorThrough, type EigrpLink } from '../src/protocols/eigrp/metric.js';

const PREFIX = '10.4.0.0/24';
const INF = EIGRP_INFINITY;

// R1's neighbours (§3.12): R2 on Gi0/0, R3 on Gi0/1; a fifth router R5 on a LAN Gi0/2 for the multi-neighbour cases.
const R2: DualNeighbor = { iface: 'GigabitEthernet0/0', address: '10.0.12.2' };
const R3: DualNeighbor = { iface: 'GigabitEthernet0/1', address: '10.0.13.3' };
const R5: DualNeighbor = { iface: 'GigabitEthernet0/2', address: '10.0.15.5' };
const R6: DualNeighbor = { iface: 'GigabitEthernet0/2', address: '10.0.15.6' };

const GIGE: EigrpLink = { bwKbps: 1_000_000, delayUs: 10 };
const R1R3: EigrpLink = { bwKbps: 100_000, delayUs: 100 };
const LAN = eigrpConnectedVector(GIGE);
/** R2's and R3's reported distance and R1's metric through each (computed, so the §3.12 numbers are the metric's). */
const RD_R2 = eigrpMetric(eigrpVectorThrough(LAN, GIGE));
const VIA_R2 = eigrpMetric(eigrpVectorThrough(eigrpVectorThrough(LAN, GIGE), GIGE));
const RD_R3 = eigrpMetric(eigrpVectorThrough(LAN, GIGE));
const VIA_R3 = eigrpMetric(eigrpVectorThrough(eigrpVectorThrough(LAN, GIGE), R1R3));
/** The variant of step 4: R3–R4 at 100 Mb/s and 100 µs too. */
const RD_R3_SLOW = eigrpMetric(eigrpVectorThrough(LAN, R1R3));
const VIA_R3_SLOW = eigrpMetric(eigrpVectorThrough(eigrpVectorThrough(LAN, R1R3), R1R3));

const ctx = (neighbors: readonly DualNeighbor[], maximumPaths = 4): DualContext => ({ maximumPaths, neighbors });
const upd = (from: DualNeighbor, rd: number, metric: number): DualInput => ({ kind: 'update', from, rd, metric });

/** Apply inputs in order; return the last outcome. */
function run(entry: DualEntry, inputs: readonly DualInput[], c: DualContext): DualOutcome {
  let out: DualOutcome | undefined;
  let e = entry;
  for (const i of inputs) {
    out = dualStep(e, i, c);
    e = out.entry;
  }
  return out!;
}

/** R1 converged as §3.12 step 2 (the base topology: R3 is a feasible successor). */
function converged(rd3 = RD_R3, via3 = VIA_R3): DualEntry {
  return run(dualEntry(PREFIX), [upd(R2, RD_R2, VIA_R2), upd(R3, rd3, via3)], ctx([R2, R3])).entry;
}

describe('eigrp dual: feasibility (§3.12 step 2)', () => {
  it('the numbers: R2 reports 3072 and R1 computes 3328 through it; R3 reports 3072 and R1 computes 28672', () => {
    expect([RD_R2, VIA_R2, RD_R3, VIA_R3]).toEqual([3072, 3328, 3072, 28672]);
    expect([RD_R3_SLOW, VIA_R3_SLOW]).toEqual([28416, 30976]);
  });

  it('the first path of an unreachable prefix becomes the successor at once; FD is its metric', () => {
    const o = dualStep(dualEntry(PREFIX), upd(R2, RD_R2, VIA_R2), ctx([R2, R3]));
    expect(o.entry).toMatchObject({ state: 'passive', fd: 3328, distance: 3328 });
    expect(o.entry.successors).toEqual([{ nextHop: '10.0.12.2', iface: 'GigabitEthernet0/0', metric: 3328, rd: 3072 }]);
    expect(o.routesChanged).toBe(true);
    expect(o.distanceChanged).toBe(true);
    expect(o.transition).toBeUndefined();
    expect(o).toMatchObject({ queries: [], replies: [], poison: [] });
  });

  it('R3 (RD 3072 < FD 3328) is a feasible successor; the topology row is exact', () => {
    const e = converged();
    const o = dualStep(dualEntry(PREFIX), upd(R2, RD_R2, VIA_R2), ctx([R2, R3]));
    const second = dualStep(o.entry, upd(R3, RD_R3, VIA_R3), ctx([R2, R3]));
    expect(second.routesChanged).toBe(false);
    expect(second.distanceChanged).toBe(false);
    expect(dualTopologyRow(e, 1000)).toEqual({
      key: PREFIX,
      updatedAt: 1000,
      prefix: PREFIX,
      state: 'passive',
      fd: 3328,
      successors: [{ nextHop: '10.0.12.2', iface: 'GigabitEthernet0/0', metric: 3328, rd: 3072 }],
      feasible: [{ nextHop: '10.0.13.3', iface: 'GigabitEthernet0/1', metric: 28672, rd: 3072 }],
      others: [],
    });
  });

  it('a path whose RD is not below FD is listed with the others (all-links), not as feasible', () => {
    const e = converged(RD_R3_SLOW, VIA_R3_SLOW);
    const row = dualTopologyRow(e, 0);
    expect(row.feasible).toEqual([]);
    expect(row.others).toEqual([{ nextHop: '10.0.13.3', iface: 'GigabitEthernet0/1', metric: 30976, rd: 28416 }]);
  });

  it('a better path lowers FD and takes over without a transition; the old successor becomes feasible', () => {
    const e = converged();
    const o = dualStep(e, upd(R3, 1000, 2000), ctx([R2, R3]));
    expect(o.entry.fd).toBe(2000);
    expect(o.entry.successors.map((s) => s.nextHop)).toEqual(['10.0.13.3']);
    expect(o.transition).toBeUndefined();
    expect(dualTopologyRow(o.entry, 0).feasible.map((p) => p.nextHop)).toEqual([]);
    expect(dualTopologyRow(o.entry, 0).others.map((p) => p.nextHop)).toEqual(['10.0.12.2']);
  });

  it('the result does not depend on the order the updates arrive in', () => {
    const a = run(dualEntry(PREFIX), [upd(R3, RD_R3, VIA_R3), upd(R2, RD_R2, VIA_R2)], ctx([R2, R3])).entry;
    expect(a).toEqual(converged());
  });

  it('an unreachable update for an unknown prefix changes nothing; the entry stays empty', () => {
    const o = dualStep(dualEntry(PREFIX), upd(R2, INF, INF), ctx([R2, R3]));
    expect(o.entry).toEqual(dualEntry(PREFIX));
    expect(o.routesChanged || o.distanceChanged).toBe(false);
    expect(dualIsEmpty(o.entry)).toBe(true);
    expect(dualIsEmpty(converged())).toBe(false);
  });
});

describe('eigrp dual: local computation (§3.12 step 3)', () => {
  it('the successor is lost; R3 is promoted in the same step; FD becomes 28672; no query; poison out Gi0/1', () => {
    const o = dualStep(converged(), { kind: 'neighbor-down', neighbor: R2 }, ctx([R3]));
    expect(o.transition).toEqual({ from: 'passive', to: 'passive', cause: 'feasible successor promoted' });
    expect(DUAL_CAUSE.promoted).toBe('feasible successor promoted');
    expect(o.entry).toMatchObject({ state: 'passive', fd: 28672, distance: 28672 });
    expect(o.entry.successors).toEqual([{ nextHop: '10.0.13.3', iface: 'GigabitEthernet0/1', metric: 28672, rd: 3072 }]);
    expect(o.queries).toEqual([]);
    expect(o.routesChanged).toBe(true);
    expect(o.distanceChanged).toBe(true);
    expect(o.poison).toEqual(['GigabitEthernet0/1']);
    expect(dualSplitHorizon(o.entry, 'GigabitEthernet0/1')).toBe(true);
    expect(dualSplitHorizon(o.entry, 'GigabitEthernet0/0')).toBe(false);
  });

  it('the successor advertises the infinite metric: the same promotion', () => {
    const o = dualStep(converged(), upd(R2, INF, INF), ctx([R2, R3]));
    expect(o.transition?.cause).toBe(DUAL_CAUSE.promoted);
    expect(o.entry.fd).toBe(28672);
    expect(o.entry.paths.map((p) => p.nextHop)).toEqual(['10.0.13.3']);
  });

  it("the successor's metric rises but it stays the best feasible path: FD follows it, no promotion", () => {
    const o = dualStep(converged(), upd(R2, RD_R2, 4000), ctx([R2, R3]));
    expect(o.transition).toBeUndefined();
    expect(o.entry.fd).toBe(4000);
    expect(o.entry.successors.map((s) => [s.nextHop, s.metric])).toEqual([['10.0.12.2', 4000]]);
    expect(o.routesChanged).toBe(true);
    expect(o.poison).toEqual([]);
  });

  it("the successor's metric rises above a feasible successor's: the feasible successor is promoted", () => {
    const o = dualStep(converged(), upd(R2, RD_R2, 40_000), ctx([R2, R3]));
    expect(o.transition?.cause).toBe(DUAL_CAUSE.promoted);
    expect(o.entry.successors.map((s) => s.nextHop)).toEqual(['10.0.13.3']);
    expect(o.entry.fd).toBe(28672);
  });
});

describe('eigrp dual: active and passive with replies (§3.12 step 4)', () => {
  it('no feasible successor: active, a query to R3 carrying infinity, the route withdrawn; R3 replies; passive at 30976', () => {
    const e = converged(RD_R3_SLOW, VIA_R3_SLOW);
    const a = dualStep(e, { kind: 'neighbor-down', neighbor: R2 }, ctx([R3]));
    expect(a.transition).toEqual({ from: 'passive', to: 'active', cause: DUAL_CAUSE.active });
    expect(a.entry).toMatchObject({ state: 'active', fd: 3328, distance: INF, successors: [], waiting: [R3] });
    expect(a.queries).toEqual([R3]);
    expect(dualReplyDistance(a.entry, R3.iface)).toBe(INF);
    expect(a.routesChanged).toBe(true);
    expect(a.distanceChanged).toBe(true);
    expect(dualTopologyRow(a.entry, 5).pendingReplies).toBe(1);
    expect(dualTopologyRow(a.entry, 5).state).toBe('active');

    const p = dualStep(a.entry, { kind: 'reply', from: R3, rd: RD_R3_SLOW, metric: VIA_R3_SLOW }, ctx([R3]));
    expect(p.transition).toEqual({ from: 'active', to: 'passive', cause: 'all replies received' });
    expect(p.entry).toMatchObject({ state: 'passive', fd: 30976, distance: 30976, waiting: [] });
    expect(p.entry.successors).toEqual([{ nextHop: '10.0.13.3', iface: 'GigabitEthernet0/1', metric: 30976, rd: 28416 }]);
    expect(p.routesChanged).toBe(true);
    expect(p.replies).toEqual([]);
    // The query already told R3 this router's distance was infinite: nothing to poison.
    expect(p.poison).toEqual([]);
    expect(dualTopologyRow(p.entry, 6).pendingReplies).toBeUndefined();
  });

  it('R3 answers a query from R1 (not its successor) at once with its own distance, 28416', () => {
    // R3's entry: successor R4 (its distance 28416), and a path through R1.
    const R4: DualNeighbor = { iface: 'GigabitEthernet0/2', address: '10.0.34.4' };
    const R1: DualNeighbor = { iface: 'GigabitEthernet0/1', address: '10.0.13.1' };
    const r3 = run(dualEntry(PREFIX), [upd(R4, 2816, 28416), upd(R1, 3328, 28928)], ctx([R1, R4])).entry;
    const o = dualStep(r3, { kind: 'query', from: R1, rd: INF, metric: INF }, ctx([R1, R4]));
    expect(o.entry.state).toBe('passive');
    expect(o.replies).toEqual([{ to: R1, distance: 28416 }]);
    expect(o.queries).toEqual([]);
    expect(o.routesChanged).toBe(false);
    expect(o.entry.paths.map((p) => p.nextHop)).toEqual(['10.0.34.4']);
  });

  it('a query from the successor with a feasible successor: local computation, the reply carries the new distance', () => {
    const o = dualStep(converged(), { kind: 'query', from: R2, rd: INF, metric: INF }, ctx([R2, R3]));
    expect(o.transition?.cause).toBe(DUAL_CAUSE.promoted);
    expect(o.replies).toEqual([{ to: R2, distance: 28672 }]);
  });

  it('a query from the successor without one: active, R2 not queried back, its reply deferred to the end', () => {
    const e = run(dualEntry(PREFIX), [upd(R2, RD_R2, VIA_R2), upd(R3, RD_R3_SLOW, VIA_R3_SLOW), upd(R5, 30_000, 31_000)], ctx([R2, R3, R5])).entry;
    const a = dualStep(e, { kind: 'query', from: R2, rd: INF, metric: INF }, ctx([R2, R3, R5]));
    expect(a.entry.state).toBe('active');
    expect(a.queries).toEqual([R3, R5]);
    expect(a.replies).toEqual([]);
    expect(a.entry.replyTo).toEqual(R2);
    const b = dualStep(a.entry, { kind: 'reply', from: R5, rd: 30_000, metric: 31_000 }, ctx([R2, R3, R5]));
    expect(b.entry.state).toBe('active');
    expect(b.entry.waiting).toEqual([R3]);
    const c = dualStep(b.entry, { kind: 'reply', from: R3, rd: RD_R3_SLOW, metric: VIA_R3_SLOW }, ctx([R2, R3, R5]));
    expect(c.entry.state).toBe('passive');
    expect(c.entry.successors.map((s) => s.nextHop)).toEqual(['10.0.13.3']);
    expect(c.replies).toEqual([{ to: R2, distance: 30976 }]);
  });

  it('while active: an update is recorded without recomputing; a query from another neighbour is answered at once', () => {
    const e = run(dualEntry(PREFIX), [upd(R2, RD_R2, VIA_R2), upd(R3, RD_R3_SLOW, VIA_R3_SLOW), upd(R5, 30_000, 31_000)], ctx([R2, R3, R5])).entry;
    const a = dualStep(e, { kind: 'neighbor-down', neighbor: R2 }, ctx([R3, R5]));
    expect(a.entry.waiting).toEqual([R3, R5]);
    const u = dualStep(a.entry, upd(R5, 20_000, 21_000), ctx([R3, R5]));
    expect(u.entry.state).toBe('active');
    expect(u.transition).toBeUndefined();
    expect(u.routesChanged).toBe(false);
    const q = dualStep(u.entry, { kind: 'query', from: R3, rd: INF, metric: INF }, ctx([R3, R5]));
    expect(q.replies).toEqual([{ to: R3, distance: INF }]);
    expect(q.entry.waiting).toEqual([R3, R5]);
    // A late reply from R5 with its current distance; then R3's: the recorded update decides.
    const r5 = dualStep(q.entry, { kind: 'reply', from: R5, rd: 20_000, metric: 21_000 }, ctx([R3, R5]));
    const done = dualStep(r5.entry, { kind: 'reply', from: R3, rd: INF, metric: INF }, ctx([R3, R5]));
    expect(done.entry.successors.map((s) => [s.nextHop, s.metric])).toEqual([['10.0.15.5', 21_000]]);
    expect(done.entry.fd).toBe(21_000);
  });

  it('a stale reply from a neighbour not waited for leaves the active phase running', () => {
    const e = converged(RD_R3_SLOW, VIA_R3_SLOW);
    const a = dualStep(e, { kind: 'neighbor-down', neighbor: R2 }, ctx([R3, R5]));
    const stale = dualStep(a.entry, { kind: 'reply', from: R6, rd: 50_000, metric: 51_000 }, ctx([R3, R5]));
    expect(stale.entry.state).toBe('active');
    expect(stale.entry.waiting).toEqual([R3, R5]);
  });

  it('with no neighbour left to query, the lost route becomes unreachable at once', () => {
    const e = converged(RD_R3_SLOW, VIA_R3_SLOW);
    const gone = dualStep(e, { kind: 'neighbor-down', neighbor: R3 }, ctx([R2]));
    const o = dualStep(gone.entry, { kind: 'neighbor-down', neighbor: R2 }, ctx([]));
    expect(o.transition).toBeUndefined();
    expect(o.entry).toMatchObject({ state: 'passive', fd: INF, distance: INF, successors: [] });
    expect(o.routesChanged).toBe(true);
    expect(dualIsEmpty(o.entry)).toBe(true);
  });
});

describe('eigrp dual: a neighbour lost while active', () => {
  it('a waited-for neighbour that goes down counts as a reply', () => {
    const e = run(dualEntry(PREFIX), [upd(R2, RD_R2, VIA_R2), upd(R3, RD_R3_SLOW, VIA_R3_SLOW), upd(R5, 30_000, 31_000)], ctx([R2, R3, R5])).entry;
    const a = dualStep(e, { kind: 'neighbor-down', neighbor: R2 }, ctx([R3, R5]));
    const b = dualStep(a.entry, { kind: 'neighbor-down', neighbor: R5 }, ctx([R3]));
    expect(b.entry.state).toBe('active');
    expect(b.entry.waiting).toEqual([R3]);
    expect(b.entry.paths.map((p) => p.nextHop)).toEqual(['10.0.13.3']);
    const c = dualStep(b.entry, { kind: 'neighbor-down', neighbor: R3 }, ctx([]));
    expect(c.transition).toEqual({ from: 'active', to: 'passive', cause: DUAL_CAUSE.replies });
    expect(c.entry).toMatchObject({ state: 'passive', fd: INF, distance: INF, successors: [], paths: [] });
    expect(c.distanceChanged).toBe(false);
  });

  it('when the last reply is lost, the paths already reported decide', () => {
    const e = converged(RD_R3_SLOW, VIA_R3_SLOW);
    const a = dualStep(e, { kind: 'neighbor-down', neighbor: R2 }, ctx([R3, R5]));
    const b = dualStep(a.entry, { kind: 'reply', from: R3, rd: RD_R3_SLOW, metric: VIA_R3_SLOW }, ctx([R3, R5]));
    expect(b.entry.state).toBe('active');
    const c = dualStep(b.entry, { kind: 'neighbor-down', neighbor: R5 }, ctx([R3]));
    expect(c.entry.state).toBe('passive');
    expect(c.entry.successors.map((s) => s.nextHop)).toEqual(['10.0.13.3']);
    expect(c.entry.fd).toBe(30976);
  });

  it('the neighbour that started the computation goes down: no reply is owed any more', () => {
    const e = run(dualEntry(PREFIX), [upd(R2, RD_R2, VIA_R2), upd(R3, RD_R3_SLOW, VIA_R3_SLOW)], ctx([R2, R3])).entry;
    const a = dualStep(e, { kind: 'query', from: R2, rd: INF, metric: INF }, ctx([R2, R3]));
    expect(a.entry.replyTo).toEqual(R2);
    const b = dualStep(a.entry, { kind: 'neighbor-down', neighbor: R2 }, ctx([R3]));
    expect(b.entry.state).toBe('active');
    expect(b.entry.replyTo).toBeUndefined();
    const c = dualStep(b.entry, { kind: 'reply', from: R3, rd: RD_R3_SLOW, metric: VIA_R3_SLOW }, ctx([R3]));
    expect(c.entry.state).toBe('passive');
    expect(c.replies).toEqual([]);
  });

  it('a query again from the neighbour that started the computation stays deferred', () => {
    const e = run(dualEntry(PREFIX), [upd(R2, RD_R2, VIA_R2), upd(R3, RD_R3_SLOW, VIA_R3_SLOW)], ctx([R2, R3])).entry;
    const a = dualStep(e, { kind: 'query', from: R2, rd: INF, metric: INF }, ctx([R2, R3]));
    const again = dualStep(a.entry, { kind: 'query', from: R2, rd: INF, metric: INF }, ctx([R2, R3]));
    expect(again.replies).toEqual([]);
    expect(again.entry.state).toBe('active');
  });

  it('a surviving successor whose metric rose keeps the route while active; the query carries its metric', () => {
    const e = converged(RD_R3_SLOW, VIA_R3_SLOW);
    const a = dualStep(e, { kind: 'update', from: R2, rd: 29_000, metric: 29_256 }, ctx([R2, R3]));
    expect(a.entry.state).toBe('active');
    expect(a.entry.successors.map((s) => [s.nextHop, s.metric])).toEqual([['10.0.12.2', 29_256]]);
    expect(a.entry.distance).toBe(29_256);
    expect(a.queries).toEqual([R2, R3]);
    // Split horizon on the query out the surviving successor's interface.
    expect(dualReplyDistance(a.entry, R2.iface)).toBe(INF);
    expect(dualReplyDistance(a.entry, R3.iface)).toBe(29_256);
    const b = run(a.entry, [{ kind: 'reply', from: R2, rd: 29_000, metric: 29_256 }, { kind: 'reply', from: R3, rd: RD_R3_SLOW, metric: VIA_R3_SLOW }], ctx([R2, R3]));
    expect(b.entry.successors.map((s) => s.nextHop)).toEqual(['10.0.12.2']);
    expect(b.entry.fd).toBe(29_256);
  });
});

describe('eigrp dual: split horizon and poison reverse', () => {
  it('a route is not advertised out its successor interface; replies out it carry infinity', () => {
    const e = converged();
    expect(dualSplitHorizon(e, R2.iface)).toBe(true);
    expect(dualSplitHorizon(e, R3.iface)).toBe(false);
    expect(dualReplyDistance(e, R2.iface)).toBe(INF);
    expect(dualReplyDistance(e, R3.iface)).toBe(3328);
    const q = dualStep(e, { kind: 'query', from: R3, rd: INF, metric: INF }, ctx([R2, R3]));
    expect(q.replies).toEqual([{ to: R3, distance: 3328 }]);
  });

  it('two neighbours on one LAN: a reply to the non-successor on the successor interface is poisoned', () => {
    const e = run(dualEntry(PREFIX), [upd(R5, 2000, 3000), upd(R6, 2500, 4000)], ctx([R5, R6])).entry;
    const q = dualStep(e, { kind: 'query', from: R6, rd: INF, metric: INF }, ctx([R5, R6]));
    expect(q.replies).toEqual([{ to: R6, distance: INF }]);
  });

  it('poison reverse only when a successor moves to an interface where a finite distance was advertised', () => {
    // First learning: nothing was advertised before, nothing to poison.
    expect(dualStep(dualEntry(PREFIX), upd(R2, RD_R2, VIA_R2), ctx([R2])).poison).toEqual([]);
    // The move Gi0/0 → Gi0/1 (step 3): poison Gi0/1 once.
    const moved = dualStep(converged(), { kind: 'neighbor-down', neighbor: R2 }, ctx([R3]));
    expect(moved.poison).toEqual(['GigabitEthernet0/1']);
    // A second change on the same interface: no new poison.
    expect(dualStep(moved.entry, upd(R3, RD_R3, 30_000), ctx([R3])).poison).toEqual([]);
  });

  it('a moved successor on a LAN shared with the old one poisons nothing (same interface)', () => {
    const e = run(dualEntry(PREFIX), [upd(R5, 2000, 3000), upd(R6, 2500, 4000)], ctx([R5, R6])).entry;
    const o = dualStep(e, { kind: 'neighbor-down', neighbor: R5 }, ctx([R6]));
    expect(o.transition?.cause).toBe(DUAL_CAUSE.promoted);
    expect(o.poison).toEqual([]);
  });
});

describe('eigrp dual: equal-cost successors and maximum-paths', () => {
  it('equal-cost feasible paths are all successors up to maximum-paths, ordered by next hop', () => {
    const inputs = [upd(R6, 2000, 3000), upd(R5, 2000, 3000), upd(R3, 2000, 3000)];
    const four = run(dualEntry(PREFIX), inputs, ctx([R3, R5, R6], 4)).entry;
    expect(four.successors.map((s) => s.nextHop)).toEqual(['10.0.13.3', '10.0.15.5', '10.0.15.6']);
    const two = run(dualEntry(PREFIX), inputs, ctx([R3, R5, R6], 2)).entry;
    expect(two.successors.map((s) => s.nextHop)).toEqual(['10.0.13.3', '10.0.15.5']);
    // The third equal-cost path is left out by the cap; its RD is below FD, so it is listed as feasible.
    expect(dualTopologyRow(two, 0).feasible.map((p) => p.nextHop)).toEqual(['10.0.15.6']);
    expect(dualTopologyRow(two, 0).others).toEqual([]);
    // `maximum-paths` changed: a recompute re-selects.
    const back = dualStep(two, { kind: 'recompute' }, ctx([R3, R5, R6], 4));
    expect(back.entry.successors.length).toBe(3);
    expect(back.routesChanged).toBe(true);
    const one = dualStep(four, { kind: 'recompute' }, ctx([R3, R5, R6], 1));
    expect(one.entry.successors.map((s) => s.nextHop)).toEqual(['10.0.13.3']);
  });

  it('losing one of two equal-cost successors keeps the other without a query or transition', () => {
    const e = run(dualEntry(PREFIX), [upd(R2, 2000, 3000), upd(R3, 2000, 3000)], ctx([R2, R3])).entry;
    expect(e.successors.length).toBe(2);
    const o = dualStep(e, { kind: 'neighbor-down', neighbor: R2 }, ctx([R3]));
    expect(o.entry.state).toBe('passive');
    expect(o.transition).toBeUndefined();
    expect(o.queries).toEqual([]);
    expect(o.entry.successors.map((s) => s.nextHop)).toEqual(['10.0.13.3']);
    expect(o.distanceChanged).toBe(false);
    expect(o.poison).toEqual([]);
  });
});

describe('eigrp dual: directly connected networks', () => {
  const lanMetric = eigrpMetric(LAN);

  it('a connected network is its own route: FD and distance its metric, no successor, never split-horizoned', () => {
    const o = dualStep(dualEntry(PREFIX), { kind: 'connected', iface: 'GigabitEthernet0/2', metric: lanMetric }, ctx([R2]));
    expect(lanMetric).toBe(2816);
    expect(o.entry).toMatchObject({ state: 'passive', fd: 2816, distance: 2816, successors: [], connected: { iface: 'GigabitEthernet0/2', metric: 2816 } });
    expect(o.routesChanged).toBe(false);
    expect(o.distanceChanged).toBe(true);
    expect(dualSplitHorizon(o.entry, 'GigabitEthernet0/2')).toBe(false);
    expect(dualTopologyRow(o.entry, 0)).toMatchObject({ connected: 'GigabitEthernet0/2', fd: 2816, successors: [] });
    // A neighbour's path is recorded but does not replace the connected route.
    const u = dualStep(o.entry, upd(R2, 3072, 3328), ctx([R2]));
    expect(u.entry.successors).toEqual([]);
    expect(u.entry.fd).toBe(2816);
  });

  it('the connected network goes: with no feasible path the route goes active and queries', () => {
    const c = dualStep(dualEntry(PREFIX), { kind: 'connected', iface: 'GigabitEthernet0/2', metric: 2816 }, ctx([R2])).entry;
    const withPath = dualStep(c, upd(R2, 3072, 3328), ctx([R2])).entry;
    const o = dualStep(withPath, { kind: 'connected-down' }, ctx([R2]));
    expect(o.entry.state).toBe('active');
    expect(o.entry.connected).toBeUndefined();
    expect(o.queries).toEqual([R2]);
    expect(o.entry.distance).toBe(INF);
  });

  it('the connected network goes: a feasible path is promoted', () => {
    const c = dualStep(dualEntry(PREFIX), { kind: 'connected', iface: 'GigabitEthernet0/2', metric: 2816 }, ctx([R2])).entry;
    const withPath = dualStep(c, upd(R2, 2000, 3328), ctx([R2])).entry;
    const o = dualStep(withPath, { kind: 'connected-down' }, ctx([R2]));
    expect(o.transition?.cause).toBe(DUAL_CAUSE.promoted);
    expect(o.entry.successors.map((s) => s.nextHop)).toEqual(['10.0.12.2']);
    expect(o.poison).toEqual(['GigabitEthernet0/0']);
  });

  it('a network that becomes connected while active ends the computation', () => {
    const e = converged(RD_R3_SLOW, VIA_R3_SLOW);
    const a = dualStep(e, { kind: 'neighbor-down', neighbor: R2 }, ctx([R3]));
    const o = dualStep(a.entry, { kind: 'connected', iface: 'GigabitEthernet0/2', metric: 2816 }, ctx([R3]));
    expect(o.transition).toEqual({ from: 'active', to: 'passive', cause: DUAL_CAUSE.connected });
    expect(o.entry).toMatchObject({ state: 'passive', fd: 2816, distance: 2816, waiting: [] });
  });
});

describe('eigrp dual: keys and purity', () => {
  it('the neighbour key is the eigrp-neighbors key', () => {
    expect(dualNeighborKey(R2)).toBe('GigabitEthernet0/0|10.0.12.2');
  });

  it('a step never modifies its input entry', () => {
    const e = converged();
    const copy = JSON.parse(JSON.stringify(e)) as DualEntry;
    dualStep(e, { kind: 'neighbor-down', neighbor: R2 }, ctx([R3]));
    dualStep(e, { kind: 'query', from: R3, rd: INF, metric: INF }, ctx([R2, R3]));
    expect(e).toEqual(copy);
  });
});
