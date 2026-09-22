// core/rib-arbiter [SHOULD S6] (ARCHITECTURE-P2 D13, §2.6): `maxPaths` (default 1 — the P1 pin at
// core.rib-arbiter.test.ts:139 is untouched), `multipathEligible`, `pathCause`; `RouteRow.paths` present only with
// two or more installed paths; the installed row is rewritten whenever its path set changes.
import { describe, expect, it } from 'vitest';
import { createTable } from '../src/core/table.js';
import { createRibArbiter, type RibArbiterOptions } from '../src/core/rib-arbiter.js';
import { AD_STATIC, route6Key, routeKey, type Route6Row, type RouteRow } from '../src/contracts/tables.js';
import type { ProcessName } from '../src/contracts/ids.js';
import type { TraceEvent } from '../src/contracts/trace.js';

const KEY = routeKey('10.3.0.0', 16);
/** D13 static candidate owners: `static|<line>` (the arbiter treats owners as opaque names). */
const own = (line: string): ProcessName => `static|${line}` as ProcessName;
const causeOf = (_row: RouteRow, owner: ProcessName): string | undefined => (owner.startsWith('static|') ? owner.slice(7) : undefined);

function staticRow(t: number, via: string | undefined, over: Partial<RouteRow> = {}): RouteRow {
  const r: RouteRow = { key: KEY, network: '10.3.0.0', prefixLen: 16, source: 'S', ad: AD_STATIC, metric: 0, updatedAt: t, ...over };
  if (via !== undefined) r.nextHop = via;
  return r;
}

const L1 = 'ip route 10.3.0.0 255.255.0.0 10.9.0.2';
const L2 = 'ip route 10.3.0.0 255.255.0.0 10.9.1.2';
const L3 = 'ip route 10.3.0.0 255.255.0.0 10.9.2.2';

function rib(opts: Omit<RibArbiterOptions<RouteRow>, 'table'> = {}) {
  const events: TraceEvent[] = [];
  let now = 0;
  const table = createTable<RouteRow>({ name: 'rib', device: 'd_1', sink: { emit: (e) => events.push(e) }, now: () => now });
  const arb = createRibArbiter<RouteRow>({ table, stampOwner: false, ...opts });
  return { table, events, arb, setNow: (t: number) => { now = t; } };
}

describe('core/rib-arbiter [S6]: maxPaths defaults to 1', () => {
  it('equal static candidates install one winner and never a paths key (the P1 behaviour)', () => {
    for (const opts of [{}, { maxPaths: 1 }, { maxPaths: 1, pathCause: causeOf }]) {
      const { arb, table, events } = rib(opts);
      arb.offer(staticRow(1, '10.9.0.2'), own(L1));
      const d = arb.offer(staticRow(2, '10.9.1.2'), own(L2));
      expect(d.changed).toBe(false);
      expect(events).toHaveLength(1);
      expect(table.get(KEY)).toEqual(staticRow(1, '10.9.0.2'));
      expect('paths' in table.get(KEY)!).toBe(false);
      expect(arb.installedOwners(KEY)).toEqual([own(L1)]);
      expect(arb.candidates(KEY).map((c) => c.installed)).toEqual([true, false]);
    }
  });

  it('replays the pinned tie-break sequence identically with and without an explicit maxPaths 1', () => {
    const run = (opts: Omit<RibArbiterOptions<RouteRow>, 'table'>): string => {
      const { arb, events } = rib({ stampOwner: true, ...opts });
      const row = (t: number, via: string, metric: number): RouteRow => ({ ...staticRow(t, via), key: '0.0.0.0/0', network: '0.0.0.0', prefixLen: 0, metric });
      arb.offer(row(1, '10.0.0.1', 5), 'ipv4');
      arb.offer(row(2, '10.0.0.2', 1), 'host');
      arb.offer(row(3, '10.0.0.3', 1), 'dhcp-client');
      arb.offer(row(4, '10.0.0.4', 1), 'host');
      arb.withdraw('0.0.0.0/0', 'host', 5);
      arb.withdrawWhere(() => true, 6);
      return JSON.stringify(events);
    };
    expect(run({ maxPaths: 1 })).toBe(run({}));
  });

  it('refuses a maxPaths that is not an integer >= 1', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createRibArbiter<RouteRow>({ maxPaths: bad })).toThrow(RangeError);
    }
  });
});

describe('core/rib-arbiter [S6]: equal-cost paths with maxPaths > 1', () => {
  it('a second equal candidate joins the installed row as a second path, and leaves it again', () => {
    const { arb, table, events, setNow } = rib({ maxPaths: 4, pathCause: causeOf });
    const d1 = arb.offer(staticRow(10, '10.9.0.2'), own(L1));
    expect(d1.changed).toBe(true);
    expect(table.get(KEY)).toEqual(staticRow(10, '10.9.0.2'));
    expect('paths' in table.get(KEY)!).toBe(false);

    const d2 = arb.offer(staticRow(20, '10.9.1.2'), own(L2));
    expect(d2.changed).toBe(true);
    expect(d2.afterOwner).toBe(own(L1));
    // nextHop of the row stays the first path; paths lists both in offer order with their causes
    expect(table.get(KEY)).toEqual({
      ...staticRow(20, '10.9.0.2'),
      paths: [{ nextHop: '10.9.0.2', cause: L1 }, { nextHop: '10.9.1.2', cause: L2 }],
    });
    expect(events.map((e) => [e.kind, e.t])).toEqual([['tableWrite', 10], ['tableWrite', 20]]);
    expect(arb.installedOwners(KEY)).toEqual([own(L1), own(L2)]);
    expect(arb.installedOwner(KEY)).toBe(own(L1));
    expect(arb.candidates(KEY).map((c) => [c.owner, c.installed])).toEqual([[own(L1), true], [own(L2), true]]);

    // withdrawing a non-first path rewrites the row without it (no paths key once one path is left)
    setNow(30);
    const d3 = arb.withdraw(KEY, own(L2), 30);
    expect(d3.changed).toBe(true);
    expect(d3.before).toMatchObject({ paths: [{ nextHop: '10.9.0.2' }, { nextHop: '10.9.1.2' }] });
    expect(table.get(KEY)).toEqual(staticRow(30, '10.9.0.2'));
    expect('paths' in table.get(KEY)!).toBe(false);
    expect(events).toHaveLength(3);
    expect(events[2]).toMatchObject({ kind: 'tableWrite', t: 30 });

    // the last one leaves: the key is removed with the given reason
    setNow(40);
    const d4 = arb.withdraw(KEY, own(L1), 40, 'link-down');
    expect(d4.changed).toBe(true);
    expect(d4.after).toBeUndefined();
    expect(table.has(KEY)).toBe(false);
    expect(events[3]).toMatchObject({ kind: 'tableExpire', t: 40, reason: 'link-down' });
    expect(arb.installedOwners(KEY)).toEqual([]);
  });

  it('withdrawing the first path promotes the next one to the row\'s nextHop', () => {
    const { arb, table } = rib({ maxPaths: 4, pathCause: causeOf });
    arb.offer(staticRow(1, '10.9.0.2'), own(L1));
    arb.offer(staticRow(2, '10.9.1.2'), own(L2));
    arb.offer(staticRow(3, '10.9.2.2'), own(L3));
    arb.withdraw(KEY, own(L1), 4);
    expect(table.get(KEY)).toEqual({
      ...staticRow(4, '10.9.1.2'),
      paths: [{ nextHop: '10.9.1.2', cause: L2 }, { nextHop: '10.9.2.2', cause: L3 }],
    });
    expect(arb.installedOwner(KEY)).toBe(own(L2));
  });

  it('a floating static (higher AD) never joins, and takes over alone when the equal paths go', () => {
    const { arb, table, events } = rib({ maxPaths: 4 });
    arb.offer(staticRow(1, '10.9.0.2'), own(L1));
    arb.offer(staticRow(2, '10.9.1.2'), own(L2));
    const n = events.length;
    const floating = arb.offer(staticRow(3, '10.9.9.2', { ad: 5 }), own('ip route 10.3.0.0 255.255.0.0 10.9.9.2 5'));
    expect(floating.changed).toBe(false);
    expect(events).toHaveLength(n);
    expect(table.get(KEY)!.paths).toEqual([{ nextHop: '10.9.0.2' }, { nextHop: '10.9.1.2' }]);
    arb.withdrawWhere((r) => r.ad === AD_STATIC, 9, 'link-down');
    expect(table.get(KEY)).toEqual(staticRow(9, '10.9.9.2', { ad: 5 }));
  });

  it('a lower metric wins alone; equal AD but a different metric never shares', () => {
    const { arb, table } = rib({ maxPaths: 4 });
    arb.offer(staticRow(1, '10.9.0.2', { metric: 2 }), own(L1));
    arb.offer(staticRow(2, '10.9.1.2', { metric: 1 }), own(L2));
    expect(table.get(KEY)).toEqual(staticRow(2, '10.9.1.2', { metric: 1 }));
    arb.offer(staticRow(3, '10.9.2.2', { metric: 1 }), own(L3));
    expect(table.get(KEY)!.paths).toEqual([{ nextHop: '10.9.1.2' }, { nextHop: '10.9.2.2' }]);
  });

  it('installs at most maxPaths paths; a withdrawn path lets the next equal candidate in', () => {
    const { arb, table } = rib({ maxPaths: 2 });
    arb.offer(staticRow(1, '10.9.0.2'), own(L1));
    arb.offer(staticRow(2, '10.9.1.2'), own(L2));
    const third = arb.offer(staticRow(3, '10.9.2.2'), own(L3));
    expect(third.changed).toBe(false);
    expect(table.get(KEY)!.paths).toEqual([{ nextHop: '10.9.0.2' }, { nextHop: '10.9.1.2' }]);
    expect(arb.candidates(KEY).map((c) => c.installed)).toEqual([true, true, false]);
    arb.withdraw(KEY, own(L2), 4);
    expect(table.get(KEY)!.paths).toEqual([{ nextHop: '10.9.0.2' }, { nextHop: '10.9.2.2' }]);
    expect(table.get(KEY)!.updatedAt).toBe(4);
  });

  it('multipathEligible: an ineligible winner installs alone; an ineligible equal candidate is skipped', () => {
    const eligible = (r: RouteRow): boolean => r.source === 'S';
    const { arb, table } = rib({ maxPaths: 4, multipathEligible: eligible });
    // two connected candidates for one key (overlapping subnets on two interfaces): never multipath
    const conn = (t: number, iface: string): RouteRow => ({ key: KEY, network: '10.3.0.0', prefixLen: 16, source: 'C', iface, ad: 0, metric: 0, updatedAt: t });
    arb.offer(conn(1, 'GigabitEthernet0/0'), 'ipv4');
    arb.offer(conn(2, 'GigabitEthernet0/1'), 'host');
    expect(table.get(KEY)).toEqual(conn(1, 'GigabitEthernet0/0'));
    expect(arb.installedOwners(KEY)).toEqual(['ipv4']);

    const k2 = routeKey('0.0.0.0', 0);
    const dflt = (t: number, via: string, source: RouteRow['source']): RouteRow => ({ key: k2, network: '0.0.0.0', prefixLen: 0, source, nextHop: via, ad: 1, metric: 0, isDefault: true, updatedAt: t });
    arb.offer(dflt(3, '10.0.0.1', 'S'), own('ip route 0.0.0.0 0.0.0.0 10.0.0.1'));
    arb.offer(dflt(4, '10.0.0.2', 'D'), 'dhcp-client');
    arb.offer(dflt(5, '10.0.0.3', 'S'), own('ip route 0.0.0.0 0.0.0.0 10.0.0.3'));
    expect(table.get(k2)!.paths).toEqual([{ nextHop: '10.0.0.1' }, { nextHop: '10.0.0.3' }]);
    expect(arb.candidates(k2).map((c) => [c.owner, c.installed])).toEqual([
      [own('ip route 0.0.0.0 0.0.0.0 10.0.0.1'), true],
      ['dhcp-client', false],
      [own('ip route 0.0.0.0 0.0.0.0 10.0.0.3'), true],
    ]);
  });

  it('paths omit absent members: an interface-only static has no nextHop, no cause without pathCause', () => {
    const { arb, table } = rib({ maxPaths: 2 });
    arb.offer(staticRow(1, undefined, { iface: 'Serial0/0/0' }), own('ip route 10.3.0.0 255.255.0.0 Serial0/0/0'));
    arb.offer(staticRow(2, '10.9.1.2', { iface: 'GigabitEthernet0/1' }), own('ip route 10.3.0.0 255.255.0.0 GigabitEthernet0/1 10.9.1.2'));
    const row = table.get(KEY)!;
    expect(row.paths).toEqual([{ iface: 'Serial0/0/0' }, { nextHop: '10.9.1.2', iface: 'GigabitEthernet0/1' }]);
    expect(Object.keys(row.paths![0]!)).toEqual(['iface']);
    expect('nextHop' in row).toBe(false);
    expect(JSON.stringify(row)).not.toContain('undefined');
  });

  it('re-offering a member rewrites the row; re-offering an outsider writes nothing', () => {
    const { arb, table, events } = rib({ maxPaths: 2, pathCause: causeOf });
    arb.offer(staticRow(1, '10.9.0.2'), own(L1));
    arb.offer(staticRow(2, '10.9.1.2'), own(L2));
    arb.offer(staticRow(3, '10.9.9.9', { ad: 200 }), own('floating'));
    const n = events.length;
    const re = arb.offer(staticRow(4, '10.9.1.3'), own(L2));
    expect(re.changed).toBe(true);
    expect(events).toHaveLength(n + 1);
    expect(table.get(KEY)!.paths).toEqual([{ nextHop: '10.9.0.2', cause: L1 }, { nextHop: '10.9.1.3', cause: L2 }]);
    expect(table.get(KEY)!.updatedAt).toBe(4);
    const outsider = arb.offer(staticRow(5, '10.9.9.8', { ad: 200 }), own('floating'));
    expect(outsider.changed).toBe(false);
    expect(events).toHaveLength(n + 1);
    // a withdrawal outside the set changes nothing either
    expect(arb.withdraw(KEY, own('floating'), 6).changed).toBe(false);
    expect(events).toHaveLength(n + 1);
  });

  it('an offered row\'s own paths are never kept', () => {
    const { arb, table } = rib({ maxPaths: 2 });
    arb.offer(staticRow(1, '10.9.0.2', { paths: [{ nextHop: '1.1.1.1' }, { nextHop: '2.2.2.2' }] }), own(L1));
    expect('paths' in table.get(KEY)!).toBe(false);
    expect(table.get(KEY)).toEqual(staticRow(1, '10.9.0.2'));
  });

  it('withdrawWhere drops the paths out of a failed interface, key by key', () => {
    const { arb, table } = rib({ maxPaths: 4 });
    arb.offer(staticRow(1, '10.9.0.2', { iface: 'GigabitEthernet0/0' }), own(L1));
    arb.offer(staticRow(2, '10.9.1.2', { iface: 'GigabitEthernet0/1' }), own(L2));
    const out = arb.withdrawWhere((r) => r.iface === 'GigabitEthernet0/0', 50, 'link-down');
    expect(out.map((d) => [d.key, d.changed])).toEqual([[KEY, true]]);
    expect(table.get(KEY)).toEqual(staticRow(50, '10.9.1.2', { iface: 'GigabitEthernet0/1' }));
  });

  it('reset forgets the path sets without writing', () => {
    const { arb, table, events } = rib({ maxPaths: 2 });
    arb.offer(staticRow(1, '10.9.0.2'), own(L1));
    arb.offer(staticRow(2, '10.9.1.2'), own(L2));
    const n = events.length;
    arb.reset();
    expect(events).toHaveLength(n);
    expect(arb.installedOwners(KEY)).toEqual([]);
    table.clear();
    // after a reset the same offers install from scratch
    arb.offer(staticRow(3, '10.9.0.2'), own(L1));
    arb.offer(staticRow(4, '10.9.1.2'), own(L2));
    expect(table.get(KEY)!.paths).toHaveLength(2);
  });

  it('works for rib6 without an owner stamp', () => {
    const events: TraceEvent[] = [];
    const table = createTable<Route6Row>({ name: 'rib6', device: 'd_2', sink: { emit: (e) => events.push(e) }, now: () => 0 });
    const arb = createRibArbiter<Route6Row>({ table, stampOwner: false, maxPaths: 2 });
    const key = route6Key('2001:db8:3::', 48);
    const r = (t: number, nh: string, iface: string): Route6Row => ({ key, network: '2001:db8:3::', prefixLen: 48, source: 'S', nextHop: nh, iface, ad: 1, metric: 0, updatedAt: t });
    arb.offer(r(1, 'fe80::1', 'GigabitEthernet0/0'), 'ipv6');
    arb.offer(r(2, 'fe80::2', 'GigabitEthernet0/1'), 'nd');
    expect(table.get(key)).toEqual({ ...r(2, 'fe80::1', 'GigabitEthernet0/0'), paths: [{ nextHop: 'fe80::1', iface: 'GigabitEthernet0/0' }, { nextHop: 'fe80::2', iface: 'GigabitEthernet0/1' }] });
    expect('owner' in table.get(key)!).toBe(false);
  });

  it('is deterministic: the same sequence gives the same trace', () => {
    const run = (): string => {
      const { arb, events } = rib({ maxPaths: 3, pathCause: causeOf });
      arb.offer(staticRow(1, '10.9.0.2'), own(L1));
      arb.offer(staticRow(2, '10.9.1.2'), own(L2));
      arb.offer(staticRow(3, '10.9.2.2'), own(L3));
      arb.withdraw(KEY, own(L1), 4);
      arb.offer(staticRow(5, '10.9.0.2'), own(L1));
      arb.withdrawWhere(() => true, 6);
      return JSON.stringify(events);
    };
    expect(run()).toBe(run());
  });
});
