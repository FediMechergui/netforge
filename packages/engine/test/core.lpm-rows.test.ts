// core/lpm, P3c [S7] (ARCHITECTURE-P3C §7 W1a core): `lpmRows`, the longest-prefix match over plain RIB rows that the
// route-path overlay runs on snapshot rows, agrees with `lpm` over a table; core/lpm and core/lpm6 are reachable
// through `@netforge/engine/pure`.
import { describe, expect, it } from 'vitest';
import { createTable } from '../src/core/table.js';
import { lpm, lpmRows } from '../src/core/lpm.js';
import { createRng } from '../src/core/prng.js';
import { u32ToIpv4 } from '../src/contracts/addr.js';
import { routeKey, type RouteRow } from '../src/contracts/tables.js';
import * as pure from '../src/pure.js';

function route(network: string, prefixLen: number, over: Partial<RouteRow> = {}): RouteRow {
  return {
    key: routeKey(network, prefixLen), network, prefixLen, source: 'S', ad: 1, metric: 0, updatedAt: 0,
    nextHop: '10.0.0.2', iface: 'GigabitEthernet0/0', ...over,
  } as RouteRow;
}

describe('core/lpm P3c [S7]: lpmRows', () => {
  it('orders by prefix, AD, metric, then key, and picks the first', () => {
    const rows = [
      route('0.0.0.0', 0, { key: 'z' }),
      route('10.1.0.0', 16, { key: 'b', ad: 110, metric: 20 }),
      route('10.1.0.0', 16, { key: 'a', ad: 110, metric: 20 }),
      route('10.1.0.0', 16, { key: 'c', ad: 90 }),
      route('10.1.1.0', 24, { key: 'd', ad: 120 }),
      route('192.168.0.0', 16, { key: 'e' }),
    ];
    const r = lpmRows(rows, '10.1.1.7');
    expect(r.candidates.map((c) => c.key)).toEqual(['d', 'c', 'a', 'b', 'z']);
    expect(r.winner?.key).toBe('d');
    expect(lpmRows(rows, '172.16.0.1').candidates.map((c) => c.key)).toEqual(['z']);
    expect(lpmRows(rows.slice(1), '172.16.0.1')).toEqual({ candidates: [] });
    expect(lpmRows([], '10.0.0.1')).toEqual({ candidates: [] });
  });

  it('never throws on bad data: a bad destination or row never matches', () => {
    const rows = [route('not-an-address', 8, { key: 'x' }), route('10.0.0.0', 33, { key: 'y' }), route('10.0.0.0', 8, { key: 'ok' })];
    expect(lpmRows(rows, '10.2.3.4').candidates.map((c) => c.key)).toEqual(['ok']);
    expect(lpmRows(rows, 'nope')).toEqual({ candidates: [] });
  });

  it('agrees with lpm over a table, on random RIBs (any row order)', () => {
    const rng = createRng(7);
    for (let round = 0; round < 40; round++) {
      const table = createTable<RouteRow>({ name: 'rib', device: 'd_1', sink: { emit: () => undefined }, now: () => 0 });
      const rows: RouteRow[] = [];
      // a small address space (10.0.0.0/20) so most destinations meet several candidates
      const addr = (): number => (0x0a000000 + rng.nextInt(0, 0xfff)) >>> 0;
      for (let i = 0; i < 25; i++) {
        const len = rng.nextInt(0, 32);
        const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
        const r = route(u32ToIpv4((addr() & mask) >>> 0), len, { key: `k${i}`, ad: rng.nextInt(0, 3), metric: rng.nextInt(0, 3) });
        rows.push(r);
        table.set(r);
      }
      for (let j = 0; j < 20; j++) {
        const dst = u32ToIpv4(addr());
        const a = lpm(table, dst);
        const b = lpmRows(rows.slice().reverse(), dst);
        expect(b.candidates.map((c) => c.key)).toEqual(a.candidates.map((c) => c.key));
        expect(b.winner?.key).toBe(a.winner?.key);
      }
    }
  });
});

describe('core/lpm P3c [S7]: the pure entry', () => {
  it('exports lpm, lpmRows, lpm6 and lpm6Rows', () => {
    expect(pure.lpmRows).toBe(lpmRows);
    expect(typeof pure.lpm).toBe('function');
    expect(typeof pure.lpm6).toBe('function');
    expect(pure.lpm6Rows([], '2001:db8::1')).toEqual({ candidates: [] });
    expect(pure.lpmRows([route('10.0.0.0', 8)], '10.9.9.9').winner?.network).toBe('10.0.0.0');
  });
});
