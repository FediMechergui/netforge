// core/rib-arbiter (ARCHITECTURE-P1 §4.2 "RIB arbitration", §4.3 step 6, §10.2 DORA row): a candidate list per
// key, the lowest AD installed, withdrawing the winner re-installs the next, and RouteRow.owner records the
// offering process ("ip default-gateway" provenance iff owner === 'host').
import { describe, expect, it } from 'vitest';
import { createTable } from '../src/core/table.js';
import { createRibArbiter } from '../src/core/rib-arbiter.js';
import {
  AD_DHCP,
  AD_ND,
  AD_STATIC,
  route6Key,
  routeKey,
  type Route6Row,
  type RouteRow,
  type Table,
} from '../src/contracts/tables.js';
import type { TraceEvent } from '../src/contracts/trace.js';

function rib(): { table: Table<RouteRow>; events: TraceEvent[]; setNow(t: number): void } {
  const events: TraceEvent[] = [];
  let now = 0;
  const table = createTable<RouteRow>({ name: 'rib', device: 'd_1', sink: { emit: (e) => events.push(e) }, now: () => now });
  return { table, events, setNow: (t) => { now = t; } };
}

const DEFAULT_KEY = routeKey('0.0.0.0', 0);

function dhcpDefault(t: number, via = '192.168.1.1'): RouteRow {
  return {
    key: DEFAULT_KEY, network: '0.0.0.0', prefixLen: 0, source: 'D', nextHop: via, iface: 'GigabitEthernet0',
    ad: AD_DHCP, metric: 0, isDefault: true, updatedAt: t,
  };
}

function gatewayDefault(t: number, via = '192.168.1.254'): RouteRow {
  return {
    key: DEFAULT_KEY, network: '0.0.0.0', prefixLen: 0, source: 'S', nextHop: via, ad: AD_STATIC, metric: 0,
    isDefault: true, updatedAt: t,
  };
}

describe('core/rib-arbiter: ip default-gateway versus a DHCP default', () => {
  it('installs D, replaces it with S, and restores D when S is withdrawn', () => {
    const { table, events, setNow } = rib();
    const arb = createRibArbiter<RouteRow>({ table });

    const d1 = arb.offer(dhcpDefault(1000), 'dhcp-client');
    expect(d1.changed).toBe(true);
    expect(d1.before).toBeUndefined();
    expect(d1.after).toMatchObject({ source: 'D', ad: 254, owner: 'dhcp-client', updatedAt: 1000 });
    expect(table.get(DEFAULT_KEY)).toMatchObject({ source: 'D', nextHop: '192.168.1.1', owner: 'dhcp-client' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'tableWrite', t: 1000, table: 'rib', key: DEFAULT_KEY });

    const d2 = arb.offer(gatewayDefault(2000), 'host');
    expect(d2.changed).toBe(true);
    expect(d2.before).toMatchObject({ source: 'D' });
    expect(d2.after).toMatchObject({ source: 'S', owner: 'host' });
    expect(d2.afterOwner).toBe('host');
    expect(table.get(DEFAULT_KEY)).toMatchObject({ source: 'S', nextHop: '192.168.1.254', ad: 1, owner: 'host' });
    expect(events).toHaveLength(2);
    const ev2 = events[1]!;
    expect(ev2.kind).toBe('tableWrite');
    if (ev2.kind === 'tableWrite') {
      expect(ev2.t).toBe(2000);
      expect(ev2.previous).toMatchObject({ source: 'D' });
    }

    setNow(3000);
    const d3 = arb.withdraw(DEFAULT_KEY, 'host', 3000);
    expect(d3.changed).toBe(true);
    expect(d3.before).toMatchObject({ source: 'S' });
    // The re-installed candidate is stamped with the time of the change.
    expect(d3.after).toMatchObject({ source: 'D', owner: 'dhcp-client', updatedAt: 3000 });
    expect(table.get(DEFAULT_KEY)).toMatchObject({ source: 'D', updatedAt: 3000 });
    expect(events[2]).toMatchObject({ kind: 'tableWrite', t: 3000 });

    const d4 = arb.withdraw(DEFAULT_KEY, 'dhcp-client', 4000, 'aged');
    setNow(4000);
    expect(d4.changed).toBe(true);
    expect(d4.after).toBeUndefined();
    expect(d4.before).toMatchObject({ source: 'D' });
    expect(table.has(DEFAULT_KEY)).toBe(false);
    const ev4 = events[3]!;
    expect(ev4.kind).toBe('tableExpire');
    if (ev4.kind === 'tableExpire') expect(ev4.reason).toBe('aged');
    expect(arb.keys()).toEqual([]);
  });

  it('a losing offer or withdrawal writes nothing to the table', () => {
    const { table, events } = rib();
    const arb = createRibArbiter<RouteRow>({ table });
    arb.offer(gatewayDefault(10), 'host');
    const n = events.length;

    const lose = arb.offer(dhcpDefault(20), 'dhcp-client');
    expect(lose.changed).toBe(false);
    expect(lose.after).toMatchObject({ source: 'S' });
    expect(events.length).toBe(n);
    expect(arb.candidates(DEFAULT_KEY).map((c) => [c.owner, c.installed])).toEqual([['host', true], ['dhcp-client', false]]);

    const w = arb.withdraw(DEFAULT_KEY, 'dhcp-client', 30);
    expect(w.changed).toBe(false);
    expect(events.length).toBe(n);
    expect(table.get(DEFAULT_KEY)).toMatchObject({ source: 'S', updatedAt: 10 });

    const unknown = arb.withdraw(DEFAULT_KEY, 'tcp', 40);
    expect(unknown).toMatchObject({ changed: false, after: { source: 'S' } });
    expect(arb.withdraw('10.0.0.0/8', 'host', 40)).toEqual({ key: '10.0.0.0/8', changed: false });
  });

  it('a re-offer from the installed owner rewrites the row; from a losing owner it only updates the candidate', () => {
    const { table, events } = rib();
    const arb = createRibArbiter<RouteRow>({ table });
    arb.offer(gatewayDefault(10), 'host');
    arb.offer(dhcpDefault(11), 'dhcp-client');
    const n = events.length;

    const re = arb.offer(gatewayDefault(50, '192.168.1.253'), 'host');
    expect(re.changed).toBe(true);
    expect(re.before).toMatchObject({ nextHop: '192.168.1.254' });
    expect(re.after).toMatchObject({ nextHop: '192.168.1.253', updatedAt: 50 });
    expect(events.length).toBe(n + 1);
    expect(table.get(DEFAULT_KEY)).toMatchObject({ nextHop: '192.168.1.253' });

    const loser = arb.offer(dhcpDefault(60, '192.168.1.9'), 'dhcp-client');
    expect(loser.changed).toBe(false);
    expect(events.length).toBe(n + 1);
    expect(arb.candidates(DEFAULT_KEY)).toHaveLength(2);

    // Re-offering the winner with a worse AD hands the key to the other candidate.
    const worse = arb.offer({ ...gatewayDefault(70), ad: 255 }, 'host');
    expect(worse.changed).toBe(true);
    expect(worse.before).toMatchObject({ source: 'S', nextHop: '192.168.1.253' });
    expect(worse.after).toMatchObject({ source: 'D', nextHop: '192.168.1.9', updatedAt: 70 });
    expect(arb.installedOwner(DEFAULT_KEY)).toBe('dhcp-client');
  });

  it('breaks equal AD on metric, then on the earliest offer, and keeps the offer position on re-offer', () => {
    const arb = createRibArbiter<RouteRow>();
    const row = (t: number, via: string, metric: number): RouteRow => ({ ...gatewayDefault(t, via), metric });
    arb.offer(row(1, '10.0.0.1', 5), 'ipv4');
    arb.offer(row(2, '10.0.0.2', 1), 'host');
    expect(arb.installed(DEFAULT_KEY)?.nextHop).toBe('10.0.0.2');
    arb.offer(row(3, '10.0.0.3', 1), 'dhcp-client');
    expect(arb.installed(DEFAULT_KEY)?.nextHop).toBe('10.0.0.2');
    // host re-offers with the same metric: still the earliest offer among equals, so it stays installed
    arb.offer(row(4, '10.0.0.4', 1), 'host');
    expect(arb.installed(DEFAULT_KEY)?.nextHop).toBe('10.0.0.4');
    expect(arb.candidates(DEFAULT_KEY).map((c) => c.owner)).toEqual(['host', 'dhcp-client', 'ipv4']);
    arb.withdraw(DEFAULT_KEY, 'host', 5);
    expect(arb.installed(DEFAULT_KEY)?.nextHop).toBe('10.0.0.3');
  });

  it('stamps RouteRow.owner so provenance can tell ip default-gateway apart', () => {
    const arb = createRibArbiter<RouteRow>();
    const off = gatewayDefault(1);
    arb.offer(off, 'host');
    expect(arb.installed(DEFAULT_KEY)?.owner).toBe('host');
    // the caller's object is not mutated
    expect(off.owner).toBeUndefined();
  });

  it('works without a table and reports decisions only', () => {
    const arb = createRibArbiter<RouteRow>();
    expect(arb.offer(dhcpDefault(1), 'dhcp-client').changed).toBe(true);
    expect(arb.installed(DEFAULT_KEY)).toMatchObject({ source: 'D' });
  });
});

describe('core/rib-arbiter: bulk withdraw, reset and validation', () => {
  it('withdrawWhere removes every candidate out of an interface, key by key in first-offer order', () => {
    const { table } = rib();
    const arb = createRibArbiter<RouteRow>({ table });
    const conn = (net: string, len: number, iface: string, t: number): RouteRow => ({
      key: routeKey(net, len), network: net, prefixLen: len, source: 'C', iface, ad: 0, metric: 0, updatedAt: t,
    });
    arb.offer(conn('192.168.1.0', 24, 'Gi0/0', 1), 'ipv4');
    arb.offer(conn('10.0.0.0', 8, 'Gi0/1', 2), 'ipv4');
    arb.offer({ ...conn('192.168.1.0', 24, 'Gi0/1', 3), source: 'S', ad: 1 }, 'host');
    arb.offer(conn('172.16.0.0', 16, 'Gi0/0', 4), 'ipv4');

    const out = arb.withdrawWhere((r) => r.iface === 'Gi0/0', 100, 'link-down');
    expect(out.map((d) => [d.key, d.changed, d.after?.source])).toEqual([
      ['192.168.1.0/24', true, 'S'],
      ['172.16.0.0/16', true, undefined],
    ]);
    expect(table.rows().map((r) => r.key)).toEqual(['192.168.1.0/24', '10.0.0.0/8']);
    expect(table.get('192.168.1.0/24')).toMatchObject({ source: 'S', updatedAt: 100 });
    expect(arb.keys()).toEqual(['192.168.1.0/24', '10.0.0.0/8']);
  });

  it('reset forgets candidates without writing the table', () => {
    const { table, events } = rib();
    const arb = createRibArbiter<RouteRow>({ table });
    arb.offer(dhcpDefault(1), 'dhcp-client');
    const n = events.length;
    arb.reset();
    expect(events.length).toBe(n);
    expect(arb.keys()).toEqual([]);
    expect(arb.installed(DEFAULT_KEY)).toBeUndefined();
    // withdrawing after a reset (and after the device cleared the table) is harmless
    table.clear();
    expect(arb.withdraw(DEFAULT_KEY, 'dhcp-client', 5).changed).toBe(false);
  });

  it('removing the last candidate after the table was cleared elsewhere does not throw', () => {
    const { table } = rib();
    const arb = createRibArbiter<RouteRow>({ table });
    arb.offer(dhcpDefault(1), 'dhcp-client');
    table.clear();
    const d = arb.withdraw(DEFAULT_KEY, 'dhcp-client', 2);
    expect(d.changed).toBe(true);
    expect(table.size).toBe(0);
  });

  it('rejects non-integer times and non-finite distances', () => {
    const arb = createRibArbiter<RouteRow>();
    expect(() => arb.offer(dhcpDefault(1.5), 'dhcp-client')).toThrow();
    expect(() => arb.offer({ ...dhcpDefault(1), ad: Number.NaN }, 'dhcp-client')).toThrow(RangeError);
    expect(() => arb.withdraw(DEFAULT_KEY, 'dhcp-client', -1)).toThrow();
  });

  it('arbitrates rib6 without stamping an owner', () => {
    const events: TraceEvent[] = [];
    const table = createTable<Route6Row>({ name: 'rib6', device: 'd_2', sink: { emit: (e) => events.push(e) }, now: () => 0 });
    const arb = createRibArbiter<Route6Row>({ table, stampOwner: false });
    const key = route6Key('::', 0);
    const nd: Route6Row = { key, network: '::', prefixLen: 0, source: 'ND', nextHop: 'fe80::1', iface: 'Gi0', ad: AD_ND, metric: 0, isDefault: true, updatedAt: 5 };
    const st: Route6Row = { key, network: '::', prefixLen: 0, source: 'S', nextHop: '2001:db8::1', ad: AD_STATIC, metric: 0, isDefault: true, updatedAt: 6 };
    arb.offer(nd, 'nd');
    arb.offer(st, 'ipv6');
    expect(table.get(key)).toBe(st);
    expect('owner' in table.get(key)!).toBe(false);
    arb.withdraw(key, 'ipv6', 9);
    expect(table.get(key)).toMatchObject({ source: 'ND', updatedAt: 9 });
    expect('owner' in table.get(key)!).toBe(false);
  });

  it('is deterministic: the same offer sequence yields the same trace', () => {
    const run = () => {
      const { table, events } = rib();
      const arb = createRibArbiter<RouteRow>({ table });
      arb.offer(dhcpDefault(1), 'dhcp-client');
      arb.offer(gatewayDefault(2), 'host');
      arb.withdraw(DEFAULT_KEY, 'host', 3);
      arb.offer(gatewayDefault(4), 'host');
      arb.withdrawWhere(() => true, 5);
      return JSON.stringify(events);
    };
    expect(run()).toBe(run());
  });
});
