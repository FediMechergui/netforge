import { describe, expect, it } from 'vitest';
import { createTable, lpm } from '../src/core/table.js';
import { lpm as lpmDirect } from '../src/core/lpm.js';
import type { ArpRow, RouteRow, Table } from '../src/contracts/tables.js';
import type { TraceEvent } from '../src/contracts/trace.js';

function harness() {
  const events: TraceEvent[] = [];
  let now = 0;
  const table = createTable<ArpRow>({
    name: 'arp',
    device: 'd_1',
    sink: { emit: (ev) => events.push(ev) },
    now: () => now,
  });
  return { events, table, setNow: (t: number) => { now = t; } };
}

const arp = (ip: string, updatedAt: number, expiresAt?: number): ArpRow => ({
  key: ip, ip, mac: '00:1f:00:00:00:01', iface: 'GigabitEthernet0', type: 'dynamic', updatedAt, expiresAt,
});

describe('core/table', () => {
  it('set emits tableWrite stamped with row.updatedAt and the device', () => {
    const { events, table } = harness();
    const row = arp('10.0.0.2', 1500);
    expect(table.set(row)).toBeUndefined();
    expect(table.size).toBe(1);
    expect(table.get('10.0.0.2')).toBe(row);
    expect(table.has('10.0.0.2')).toBe(true);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.kind).toBe('tableWrite');
    if (ev.kind !== 'tableWrite') return;
    expect(ev.t).toBe(1500);
    expect(ev.device).toBe('d_1');
    expect(ev.table).toBe('arp');
    expect(ev.key).toBe('10.0.0.2');
    expect(ev.row).toEqual({ ...row });
    expect(ev.row).not.toBe(row);
    expect(ev.previous).toBeUndefined();
  });

  it('replacing a key returns and reports the previous row and keeps position', () => {
    const { events, table } = harness();
    const a = arp('10.0.0.1', 10);
    const b = arp('10.0.0.2', 20);
    table.set(a);
    table.set(b);
    const a2 = { ...a, mac: '00:1f:00:00:00:09', updatedAt: 30 };
    expect(table.set(a2)).toBe(a);
    expect(table.rows().map((r) => r.key)).toEqual(['10.0.0.1', '10.0.0.2']);
    const ev = events[2]!;
    expect(ev.kind).toBe('tableWrite');
    if (ev.kind !== 'tableWrite') return;
    expect(ev.t).toBe(30);
    expect(ev.previous).toEqual({ ...a });
    expect(ev.row).toEqual({ ...a2 });
  });

  it('rows() is a fresh array in insertion order', () => {
    const { table } = harness();
    table.set(arp('10.0.0.3', 1));
    table.set(arp('10.0.0.1', 2));
    table.set(arp('10.0.0.2', 3));
    const r1 = table.rows();
    const r2 = table.rows();
    expect(r1).not.toBe(r2);
    expect(r1.map((r) => r.key)).toEqual(['10.0.0.3', '10.0.0.1', '10.0.0.2']);
    r1.pop();
    expect(table.size).toBe(3);
  });

  it('delete emits tableExpire stamped with now() and the reason', () => {
    const { events, table, setNow } = harness();
    const row = arp('10.0.0.2', 5);
    table.set(row);
    setNow(777);
    expect(table.delete('10.0.0.2', 'link-down')).toBe(row);
    expect(table.delete('10.0.0.2')).toBeUndefined();
    expect(table.size).toBe(0);
    expect(events).toHaveLength(2);
    const ev = events[1]!;
    expect(ev.kind).toBe('tableExpire');
    if (ev.kind !== 'tableExpire') return;
    expect(ev.t).toBe(777);
    expect(ev.device).toBe('d_1');
    expect(ev.table).toBe('arp');
    expect(ev.key).toBe('10.0.0.2');
    expect(ev.reason).toBe('link-down');
    expect(ev.row).toEqual({ ...row });
  });

  it('delete defaults the reason to cleared', () => {
    const { events, table } = harness();
    table.set(arp('10.0.0.2', 5));
    table.delete('10.0.0.2');
    const ev = events[1]!;
    expect(ev.kind === 'tableExpire' && ev.reason).toBe('cleared');
  });

  it('clear emits one tableExpire per row at now() in insertion order', () => {
    const { events, table, setNow } = harness();
    table.set(arp('10.0.0.1', 1));
    table.set(arp('10.0.0.2', 2));
    setNow(900);
    table.clear();
    expect(table.size).toBe(0);
    const expired = events.filter((e) => e.kind === 'tableExpire');
    expect(expired.map((e) => e.kind === 'tableExpire' && e.key)).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(expired.every((e) => e.t === 900 && e.kind === 'tableExpire' && e.reason === 'cleared')).toBe(true);
    table.clear();
    expect(events.filter((e) => e.kind === 'tableExpire')).toHaveLength(2);
  });

  it('expire removes rows with expiresAt <= now, reason aged, t = now', () => {
    const { events, table } = harness();
    table.set(arp('10.0.0.1', 0, 1000));
    table.set(arp('10.0.0.2', 0, 2000));
    table.set(arp('10.0.0.3', 0));
    table.set(arp('10.0.0.4', 0, 500));
    const removed = table.expire(1000);
    expect(removed.map((r) => r.key)).toEqual(['10.0.0.1', '10.0.0.4']);
    expect(table.rows().map((r) => r.key)).toEqual(['10.0.0.2', '10.0.0.3']);
    const expired = events.filter((e) => e.kind === 'tableExpire');
    expect(expired).toHaveLength(2);
    for (const e of expired) {
      expect(e.t).toBe(1000);
      expect(e.kind === 'tableExpire' && e.reason).toBe('aged');
    }
    expect(table.expire(1500)).toEqual([]);
    expect(table.expire(2000).map((r) => r.key)).toEqual(['10.0.0.2']);
    expect(table.expire(10_000)).toEqual([]);
    expect(table.size).toBe(1);
  });

  it('find filters in insertion order', () => {
    const { table } = harness();
    table.set(arp('10.0.0.1', 1));
    table.set({ ...arp('10.0.0.2', 2), type: 'static' });
    table.set(arp('10.0.0.3', 3));
    expect(table.find((r) => r.type === 'dynamic').map((r) => r.key)).toEqual(['10.0.0.1', '10.0.0.3']);
  });

  it('rejects non-integer timestamps', () => {
    const { table } = harness();
    expect(() => table.set(arp('10.0.0.1', 1.5))).toThrow(RangeError);
    expect(() => table.set(arp('10.0.0.1', 1, 2.5))).toThrow(RangeError);
    expect(() => table.expire(-1)).toThrow(RangeError);
  });
});

describe('core/lpm', () => {
  function rib(): Table<RouteRow> {
    return createTable<RouteRow>({ name: 'rib', device: 'r_1', sink: { emit: () => {} }, now: () => 0 });
  }
  const route = (network: string, prefixLen: number, source: 'C' | 'L' | 'S', ad: number, metric = 0, extra: Partial<RouteRow> = {}): RouteRow => ({
    key: `${network}/${prefixLen}`, network, prefixLen, source, ad, metric, updatedAt: 0, ...extra,
  });

  it('re-exports lpm from table.ts', () => {
    expect(lpm).toBe(lpmDirect);
  });

  it('returns no winner on an empty table', () => {
    const r = lpm(rib(), '10.0.0.1');
    expect(r.winner).toBeUndefined();
    expect(r.candidates).toEqual([]);
  });

  it('prefers the longest prefix among /0, /8, /24, /32', () => {
    const t = rib();
    t.set(route('0.0.0.0', 0, 'S', 1, 0, { nextHop: '192.168.1.1', isDefault: true }));
    t.set(route('10.0.0.0', 8, 'S', 1, 0, { nextHop: '192.168.1.2' }));
    t.set(route('10.1.2.0', 24, 'C', 0, 0, { iface: 'GigabitEthernet0/0' }));
    t.set(route('10.1.2.1', 32, 'L', 0, 0, { iface: 'GigabitEthernet0/0' }));
    t.set(route('172.16.0.0', 12, 'S', 1));

    const exact = lpm(t, '10.1.2.1');
    expect(exact.winner?.key).toBe('10.1.2.1/32');
    expect(exact.candidates.map((c) => c.key)).toEqual(['10.1.2.1/32', '10.1.2.0/24', '10.0.0.0/8', '0.0.0.0/0']);

    const inSubnet = lpm(t, '10.1.2.77');
    expect(inSubnet.winner?.key).toBe('10.1.2.0/24');
    expect(inSubnet.candidates.map((c) => c.key)).toEqual(['10.1.2.0/24', '10.0.0.0/8', '0.0.0.0/0']);

    const inSlash8 = lpm(t, '10.200.0.1');
    expect(inSlash8.winner?.key).toBe('10.0.0.0/8');
    expect(inSlash8.candidates.map((c) => c.key)).toEqual(['10.0.0.0/8', '0.0.0.0/0']);

    const only0 = lpm(t, '8.8.8.8');
    expect(only0.winner?.key).toBe('0.0.0.0/0');
    expect(only0.winner?.isDefault).toBe(true);
    expect(only0.candidates.map((c) => c.key)).toEqual(['0.0.0.0/0']);

    const v172 = lpm(t, '172.20.5.5');
    expect(v172.winner?.key).toBe('172.16.0.0/12');
  });

  it('breaks equal-prefix ties by AD, then metric, then key', () => {
    const t = rib();
    // Distinct keys with the same effective prefix are possible only with distinct network strings;
    // use unnormalized-but-equivalent networks to build the tie (LPM masks them identically).
    t.set(route('10.0.0.0', 24, 'S', 5, 10));
    t.set(route('10.0.0.1', 24, 'S', 1, 20));
    t.set(route('10.0.0.2', 24, 'S', 1, 5));
    t.set(route('10.0.0.3', 24, 'S', 1, 5));
    const r = lpm(t, '10.0.0.200');
    expect(r.candidates.map((c) => c.key)).toEqual(['10.0.0.2/24', '10.0.0.3/24', '10.0.0.1/24', '10.0.0.0/24']);
    expect(r.winner?.key).toBe('10.0.0.2/24');
  });

  it('a static route with lower AD does not beat a longer connected prefix', () => {
    const t = rib();
    t.set(route('10.0.0.0', 16, 'S', 1));
    t.set(route('10.0.5.0', 24, 'C', 0));
    expect(lpm(t, '10.0.5.9').winner?.source).toBe('C');
    expect(lpm(t, '10.0.6.9').winner?.source).toBe('S');
  });

  it('does not mutate the table order', () => {
    const t = rib();
    t.set(route('0.0.0.0', 0, 'S', 1));
    t.set(route('10.0.0.0', 24, 'C', 0));
    lpm(t, '10.0.0.1');
    expect(t.rows().map((r) => r.key)).toEqual(['0.0.0.0/0', '10.0.0.0/24']);
  });
});
