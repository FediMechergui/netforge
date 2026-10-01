// core/rib-arbiter P3 (ARCHITECTURE-P3 D8, §4.5; W1 fix): the optional `pathOrder` tie-break orders equal-cost
// candidates before the offer sequence, so an ECMP set installs in its owner's path order whatever the offer history;
// without it every decision is the P1/P2 one (offer order).
import { describe, expect, it } from 'vitest';
import { createTable } from '../src/core/table.js';
import { createRibArbiter } from '../src/core/rib-arbiter.js';
import { ipv4ToU32 } from '../src/contracts/addr.js';
import { AD_OSPF, routeKey, type RouteRow, type Table } from '../src/contracts/tables.js';
import type { TraceEvent } from '../src/contracts/trace.js';

const KEY = routeKey('10.3.0.0', 24);

function rib(): { table: Table<RouteRow>; events: TraceEvent[] } {
  const events: TraceEvent[] = [];
  const table = createTable<RouteRow>({ name: 'rib', device: 'd_1', sink: { emit: (e) => events.push(e) }, now: () => 0 });
  return { table, events };
}

function o(nextHop: string, iface: string, t = 0, metric = 3): RouteRow {
  return { key: KEY, network: '10.3.0.0', prefixLen: 24, source: 'O', nextHop, iface, ad: AD_OSPF, metric, updatedAt: t };
}

const byNextHop = (a: RouteRow, _ao: string, b: RouteRow): number => ipv4ToU32(a.nextHop!) - ipv4ToU32(b.nextHop!);

describe('core/rib-arbiter P3: pathOrder', () => {
  it('without pathOrder equal-cost paths keep the offer order (P2)', () => {
    const { table } = rib();
    const arb = createRibArbiter<RouteRow>({ table, maxPaths: 4 });
    arb.offer(o('10.0.13.2', 'Gi0/1'), 'b');
    arb.offer(o('10.0.12.2', 'Gi0/0'), 'a');
    expect(table.get(KEY)!.paths!.map((p) => p.nextHop)).toEqual(['10.0.13.2', '10.0.12.2']);
    expect(arb.installedOwners(KEY)).toEqual(['b', 'a']);
  });

  it('with pathOrder the paths install in its order whatever the offer order, and a re-offer keeps it', () => {
    const { table } = rib();
    const arb = createRibArbiter<RouteRow>({ table, maxPaths: 4, pathOrder: byNextHop });
    arb.offer(o('10.0.13.2', 'Gi0/1'), 'b');
    arb.offer(o('10.0.12.2', 'Gi0/0'), 'a');
    expect(table.get(KEY)).toMatchObject({ nextHop: '10.0.12.2', iface: 'Gi0/0' });
    expect(table.get(KEY)!.paths!.map((p) => p.nextHop)).toEqual(['10.0.12.2', '10.0.13.2']);
    expect(arb.installedOwners(KEY)).toEqual(['a', 'b']);
    expect(arb.candidates(KEY).map((c) => c.owner)).toEqual(['a', 'b']);
    // the first path goes and comes back as a fresh offer: same order
    arb.withdraw(KEY, 'a', 5);
    arb.offer(o('10.0.12.2', 'Gi0/0', 6), 'a');
    expect(table.get(KEY)!.paths!.map((p) => p.nextHop)).toEqual(['10.0.12.2', '10.0.13.2']);
  });

  it('pathOrder breaks only ties of ad and metric; 0 leaves a pair to the offer order', () => {
    const { table } = rib();
    const arb = createRibArbiter<RouteRow>({ table, maxPaths: 4, pathOrder: () => 0 });
    arb.offer(o('10.0.13.2', 'Gi0/1'), 'b');
    arb.offer(o('10.0.12.2', 'Gi0/0'), 'a');
    expect(arb.installedOwners(KEY)).toEqual(['b', 'a']);
    const { table: t2 } = rib();
    const arb2 = createRibArbiter<RouteRow>({ table: t2, maxPaths: 4, pathOrder: byNextHop });
    arb2.offer(o('10.0.12.2', 'Gi0/0', 0, 5), 'a');
    arb2.offer(o('10.0.13.2', 'Gi0/1', 0, 3), 'b');
    // the lower metric wins before the path order is consulted
    expect(t2.get(KEY)).toMatchObject({ nextHop: '10.0.13.2', metric: 3 });
    expect(t2.get(KEY)!.paths).toBeUndefined();
  });
});
