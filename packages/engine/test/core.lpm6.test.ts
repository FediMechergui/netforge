// core/lpm6 (ARCHITECTURE-P1 §8.2 W2 stack): IPv6 longest-prefix match over rib6 with the Lpm6Result order
// (prefixLen desc, ad, metric, insertion). Prefix containment follows RFC 4291 §2.3/§2.5: the first
// `prefixLen` bits of the address equal those of the prefix; checked here against a bit-by-bit reference.
import { describe, expect, it } from 'vitest';
import { createTable } from '../src/core/table.js';
import { ipv6Words, lpm6, lpm6Rows, prefixMatches6, route6Contains } from '../src/core/lpm6.js';
import { createRng } from '../src/core/prng.js';
import { bytesToIpv6, parseIpv6 } from '../src/core/addr6.js';
import { route6Key, type Route6Row, type Table } from '../src/contracts/tables.js';
import type { TraceEvent } from '../src/contracts/trace.js';

function rib6(): { table: Table<Route6Row>; events: TraceEvent[] } {
  const events: TraceEvent[] = [];
  const table = createTable<Route6Row>({ name: 'rib6', device: 'd_1', sink: { emit: (e) => events.push(e) }, now: () => 0 });
  return { table, events };
}

function route(network: string, prefixLen: number, over: Partial<Route6Row> = {}): Route6Row {
  return {
    key: route6Key(network, prefixLen), network, prefixLen, source: 'S', ad: 1, metric: 0, updatedAt: 0,
    iface: 'GigabitEthernet0/0', ...over,
  };
}

/** Reference: compare the first `len` bits one at a time. */
function refContains(addr: string, network: string, len: number): boolean {
  const a = parseIpv6(addr)!;
  const n = parseIpv6(network)!;
  for (let bit = 0; bit < len; bit++) {
    const byte = bit >> 3;
    const mask = 0x80 >> (bit & 7);
    if ((a[byte]! & mask) !== (n[byte]! & mask)) return false;
  }
  return true;
}

describe('core/lpm6 words and containment', () => {
  it('splits an address into four big-endian u32 words', () => {
    expect(ipv6Words('2001:db8::ff00:42:8329')).toEqual([0x20010db8, 0, 0x0000ff00, 0x00428329]);
    expect(ipv6Words('ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')).toEqual([0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff]);
    expect(ipv6Words('::')).toEqual([0, 0, 0, 0]);
    expect(ipv6Words('not-an-address')).toBeNull();
    expect(ipv6Words('10.0.0.1')).toBeNull();
  });

  it('matches prefixes on and across 32-bit word boundaries', () => {
    const w = (s: string) => ipv6Words(s)!;
    expect(prefixMatches6(w('2001:db8:1::5'), w('::'), 0)).toBe(true);
    expect(prefixMatches6(w('2001:db8:1::5'), w('2001:db8::'), 32)).toBe(true);
    expect(prefixMatches6(w('2001:db8:8000::1'), w('2001:db8::'), 33)).toBe(false);
    expect(prefixMatches6(w('2001:db8:7fff::1'), w('2001:db8::'), 33)).toBe(true);
    expect(prefixMatches6(w('2001:db8:1:0:8000::1'), w('2001:db8:1::'), 64)).toBe(true);
    expect(prefixMatches6(w('2001:db8:1:0:8000::1'), w('2001:db8:1::'), 65)).toBe(false);
    expect(prefixMatches6(w('2001:db8::1'), w('2001:db8::'), 127)).toBe(true);
    expect(prefixMatches6(w('2001:db8::2'), w('2001:db8::'), 127)).toBe(false);
    expect(prefixMatches6(w('2001:db8::1'), w('2001:db8::1'), 128)).toBe(true);
    expect(prefixMatches6(w('2001:db8::1'), w('2001:db8::'), 128)).toBe(false);
    // out-of-range prefix lengths never match
    expect(prefixMatches6(w('::'), w('::'), 129)).toBe(false);
    expect(prefixMatches6(w('::'), w('::'), -1)).toBe(false);
    expect(prefixMatches6(w('::'), w('::'), 1.5)).toBe(false);
  });

  it('agrees with a bit-by-bit reference on 2000 generated vectors', () => {
    const rng = createRng(0x6e6c706d);
    for (let i = 0; i < 2000; i++) {
      const a = new Uint8Array(16);
      const n = new Uint8Array(16);
      for (let j = 0; j < 16; j++) {
        a[j] = rng.nextU32() & 0xff;
        // share a random-length prefix with `a` so matches and near misses both occur
        n[j] = a[j]!;
      }
      const len = rng.nextU32() % 129;
      const flip = rng.nextU32() % 128;
      if (rng.nextU32() & 1) n[flip >> 3] = n[flip >> 3]! ^ (0x80 >> (flip & 7));
      const addr = bytesToIpv6(a);
      const net = bytesToIpv6(n);
      expect(prefixMatches6(ipv6Words(addr)!, ipv6Words(net)!, len)).toBe(refContains(addr, net, len));
    }
  });

  it('route6Contains checks a row and ignores rows or destinations that do not parse', () => {
    expect(route6Contains(route('2001:db8:1::', 64), '2001:db8:1::abcd')).toBe(true);
    expect(route6Contains(route('2001:db8:1::', 64), '2001:db8:2::abcd')).toBe(false);
    expect(route6Contains(route('garbage', 64), '2001:db8:1::abcd')).toBe(false);
    expect(route6Contains(route('2001:db8:1::', 64), 'garbage')).toBe(false);
  });
});

describe('core/lpm6 over a rib6 table', () => {
  it('returns no winner and no candidates on an empty table', () => {
    const { table } = rib6();
    expect(lpm6(table, '2001:db8::1')).toEqual({ candidates: [] });
  });

  it('picks the longest prefix and lists every matching route, longest first', () => {
    const { table } = rib6();
    const def = route('::', 0, { source: 'ND', ad: 2, isDefault: true, nextHop: 'fe80::1' });
    const p48 = route('2001:db8:1::', 48);
    const p64 = route('2001:db8:1:2::', 64, { source: 'C', ad: 0, nextHop: undefined });
    const host = route('2001:db8:1:2::5', 128, { source: 'L', ad: 0, nextHop: undefined });
    const other = route('2001:db8:9::', 48);
    for (const r of [def, p48, other, p64, host]) table.set(r);

    const r1 = lpm6(table, '2001:db8:1:2::7');
    expect(r1.winner).toBe(p64);
    expect(r1.candidates).toEqual([p64, p48, def]);

    const r2 = lpm6(table, '2001:db8:1:2::5');
    expect(r2.winner).toBe(host);
    expect(r2.candidates.map((r) => r.prefixLen)).toEqual([128, 64, 48, 0]);

    const r3 = lpm6(table, '2001:db8:1:3::1');
    expect(r3.winner).toBe(p48);

    const r4 = lpm6(table, '2001:db9::1');
    expect(r4.winner).toBe(def);
    expect(r4.candidates).toEqual([def]);
  });

  it('accepts non-canonical destination text (upper case, leading zeros)', () => {
    const { table } = rib6();
    const p64 = route('2001:db8:1:2::', 64);
    table.set(p64);
    expect(lpm6(table, '2001:0DB8:0001:0002:0000:0000:0000:0007').winner).toBe(p64);
  });

  it('breaks equal prefix lengths by AD, then metric, then insertion order', () => {
    const { table } = rib6();
    // Distinct keys with the same network/len can only come from hand-built rows; they exercise the tie-break.
    const a = route('2001:db8::', 32, { key: 'a', ad: 5, metric: 0 });
    const b = route('2001:db8::', 32, { key: 'b', ad: 1, metric: 9 });
    const c = route('2001:db8::', 32, { key: 'c', ad: 1, metric: 3 });
    const d = route('2001:db8::', 32, { key: 'd', ad: 1, metric: 3 });
    for (const r of [a, d, b, c]) table.set(r);
    const res = lpm6(table, '2001:db8::1');
    expect(res.candidates.map((r) => r.key)).toEqual(['d', 'c', 'b', 'a']);
    expect(res.winner?.key).toBe('d');
  });

  it('skips rows that do not parse and returns nothing for an unparsable destination', () => {
    const { table } = rib6();
    const bad = route('zz::', 16, { key: 'bad' });
    const good = route('::', 0, { source: 'ND', ad: 2 });
    table.set(bad);
    table.set(good);
    expect(lpm6(table, '2001:db8::1').candidates).toEqual([good]);
    expect(lpm6(table, '192.0.2.1')).toEqual({ candidates: [] });
  });

  it('lpm6Rows works on a plain row array and does not reorder the input', () => {
    const rows = [route('::', 0, { ad: 2 }), route('2001:db8::', 32)];
    const copy = rows.slice();
    const res = lpm6Rows(rows, '2001:db8::1');
    expect(res.winner).toBe(rows[1]);
    expect(rows).toEqual(copy);
  });

  it('does not write to the table', () => {
    const { table, events } = rib6();
    table.set(route('::', 0));
    const before = events.length;
    lpm6(table, '2001:db8::1');
    expect(events.length).toBe(before);
  });
});
