/**
 * ip6.static-routing — the P2 static routing rework of protocols/ipv6.ts (ARCHITECTURE-P2 D13, §7 W2 l3) on real
 * device runtimes (test/ip6.harness.ts): one candidate per `ipv6 route` line with a distance (floating statics), a
 * link-local next hop with an interface, recursion, install when usable (after DAD / link-up) and withdrawal when
 * the exit goes down, `no ipv6 route` per line, and [S6] equal-cost paths.
 */
import { describe, expect, it } from 'vitest';
import { ICMPV6_ECHO_REPLY } from '../src/contracts/pdu.js';
import type { Route6Row } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { linkLocalFromMac } from '../src/core/addr6.js';
import { STATIC6_RECURSION_MAX, parseStaticRoute6, route6Cause } from '../src/protocols/ipv6.js';
import { BOOT_NS, createWorld6, ofIcmp6Type, type World6 } from './ip6.harness.js';

const PC = 'GigabitEthernet0';
const G0 = 'GigabitEthernet0/0';
const G1 = 'GigabitEthernet0/1';

function rib6(w: World6, dev: string): Route6Row[] {
  return w.dev(dev).tables.get<Route6Row>('rib6')!.rows();
}
function route(w: World6, dev: string, key: string): Route6Row | undefined {
  return w.dev(dev).tables.get<Route6Row>('rib6')!.get(key);
}
function mac(w: World6, dev: string, port: string): string {
  return w.dev(dev).port(port)!.mac;
}
function writes(w: World6, dev: string, key: string) {
  return w.kinds('tableWrite').filter((e) => e.device === dev && e.table === 'rib6' && e.key === key);
}

/** PC1 — R1 — R2 — PC2, addressed and routing, WITHOUT static routes (each test adds its own). */
function chain(seed = 2): World6 {
  const w = createWorld6({ seed });
  w.add('pc1', 'pc');
  w.add('r1', 'router');
  w.add('r2', 'router');
  w.add('pc2', 'pc');
  w.link({ device: 'pc1', port: PC }, { device: 'r1', port: G0 });
  w.link({ device: 'r1', port: G1 }, { device: 'r2', port: G1 });
  w.link({ device: 'r2', port: G0 }, { device: 'pc2', port: PC });
  w.runFor(BOOT_NS);
  w.global('r1', 'ipv6 unicast-routing');
  w.global('r2', 'ipv6 unicast-routing');
  w.iface('r1', G0, 'ipv6 address 2001:db8:1::1/64', 'no shutdown');
  w.iface('r1', G1, 'ipv6 address 2001:db8:12::1/64', 'no shutdown');
  w.iface('r2', G0, 'ipv6 address 2001:db8:2::1/64', 'no shutdown');
  w.iface('r2', G1, 'ipv6 address 2001:db8:12::2/64', 'no shutdown');
  w.iface('pc1', PC, 'ipv6 address autoconfig');
  w.iface('pc2', PC, 'ipv6 address autoconfig');
  w.runFor(6 * SEC);
  return w;
}

function ping6(w: World6, from: string, target: string, session: string): string {
  w.request(from, 'icmpv6', { kind: 'icmp6.ping', session, target, count: 3, timeoutNs: 2 * SEC, sizeBytes: 100 });
  w.runFor(10 * SEC);
  return w.output(session);
}

describe('ip6.static-routing lines (D13)', () => {
  it('parses next hop, interface, fully specified and distance forms; a link-local next hop needs an interface', () => {
    const w = chain();
    const ctx = { ports: w.dev('r1').ports } as never;
    const ok = (args: string[]) => {
      const r = parseStaticRoute6(ctx, args);
      if (!r.ok) throw new Error(r.reason);
      return r.def;
    };
    expect(ok(['2001:DB8:2::77/64', '2001:db8:12::2'])).toMatchObject({ line: 'ipv6 route 2001:db8:2::/64 2001:db8:12::2', key: '2001:db8:2::/64', nextHop: '2001:db8:12::2', ad: 1 });
    expect(ok(['2001:db8:2::/64', G1, 'fe80::1'])).toMatchObject({ line: `ipv6 route 2001:db8:2::/64 ${G1} fe80::1`, iface: G1, nextHop: 'fe80::1' });
    expect(ok(['2001:db8:2::/64', '2001:db8:12::9', '5'])).toMatchObject({ line: 'ipv6 route 2001:db8:2::/64 2001:db8:12::9 5', ad: 5 });
    expect(ok(['::/0', 'gigabitethernet0/1'])).toMatchObject({ line: `ipv6 route ::/0 ${G1}`, iface: G1, isDefault: true });
    expect(parseStaticRoute6(ctx, ['2001:db8:2::/64', 'fe80::1'])).toMatchObject({ ok: false, reason: 'a link-local next hop needs an interface' });
    expect(parseStaticRoute6(ctx, ['2001:db8:2::/64', 'Serial9/9'])).toMatchObject({ ok: false });
    expect(parseStaticRoute6(ctx, ['2001:db8:2::/64', '2001:db8:12::2', '0'])).toMatchObject({ ok: false });
    expect(parseStaticRoute6(ctx, ['nope/64', '2001:db8:12::2'])).toMatchObject({ ok: false, reason: 'invalid prefix' });
  });

  it('a floating static waits as a candidate and takes over when the distance-1 line is removed', () => {
    const w = chain();
    w.global('r1', 'ipv6 route 2001:db8:2::/64 2001:db8:12::2', 'ipv6 route 2001:db8:2::/64 2001:db8:12::9 5');
    w.global('r2', 'ipv6 route 2001:db8:1::/64 2001:db8:12::1');
    expect(route(w, 'r1', '2001:db8:2::/64')).toMatchObject({ source: 'S', nextHop: '2001:db8:12::2', ad: 1 });
    expect(route(w, 'r1', '2001:db8:2::/64')!.paths).toBeUndefined();
    expect(w.dev('r1').processes.get('ipv6')!.stateSnapshot().state).toMatchObject({ staticRoutes: 2 });
    w.global('r1', 'no ipv6 route 2001:db8:2::/64 2001:db8:12::2');
    const floating = route(w, 'r1', '2001:db8:2::/64')!;
    expect(floating).toMatchObject({ source: 'S', nextHop: '2001:db8:12::9', ad: 5 });
    expect(route6Cause(floating)).toBe('ipv6 route 2001:db8:2::/64 2001:db8:12::9 5');
    expect(w.dev('r1').processes.get('ipv6')!.stateSnapshot().state).toMatchObject({ staticRoutes: 1 });
    w.global('r1', 'ipv6 route 2001:db8:2::/64 2001:db8:12::2');
    expect(route(w, 'r1', '2001:db8:2::/64')).toMatchObject({ nextHop: '2001:db8:12::2', ad: 1 });
  });

  it('a static with a link-local next hop and an interface forwards, with the line as the hop-limit cause', () => {
    const w = chain();
    const r2Ll = linkLocalFromMac(mac(w, 'r2', G1));
    const r1Ll = linkLocalFromMac(mac(w, 'r1', G1));
    w.global('r1', `ipv6 route 2001:db8:2::/64 ${G1} ${r2Ll}`);
    w.global('r2', `ipv6 route 2001:db8:1::/64 ${G1} ${r1Ll}`);
    expect(route(w, 'r1', '2001:db8:2::/64')).toMatchObject({ source: 'S', iface: G1, nextHop: r2Ll, ad: 1 });
    const pc2 = (w.dev('pc2').port(PC)!.l3.ipv6 ?? []).find((a) => a.origin === 'slaac')!.address;
    expect(ping6(w, 'pc1', pc2, 'p')).toContain('!!!');
    const echo = w.sentBy('r1', G1).find((p) => p.layer('icmpv6')?.fields.type === 128)!;
    expect(echo.provenance.find((m) => m.reason === 'TtlDecrement')).toMatchObject({ device: 'r1', cause: `ipv6 route 2001:db8:2::/64 ${G1} ${r2Ll}` });
    // the same PDU object travels on and is re-framed at R2: R1's own rewrite named R2's MAC
    expect(echo.provenance.find((m) => m.reason === 'MacRewrite' && m.device === 'r1' && m.field === 'ethernet.dst')).toMatchObject({ after: mac(w, 'r2', G1) });
    expect(ofIcmp6Type(w.sentBy('pc2', PC), ICMPV6_ECHO_REPLY)).toHaveLength(3);
  });

  it('resolves recursive statics, never through the line itself, at most STATIC6_RECURSION_MAX deep', () => {
    const w = chain();
    w.global('r1', 'ipv6 route 2001:db8:99::/64 2001:db8:2::99');
    expect(route(w, 'r1', '2001:db8:99::/64')).toBeUndefined();
    w.global('r1', 'ipv6 route 2001:db8:2::/64 2001:db8:12::2');
    expect(route(w, 'r1', '2001:db8:99::/64')).toMatchObject({ source: 'S', nextHop: '2001:db8:2::99' });
    w.global('r1', 'ipv6 route 2001:db8:66::/64 2001:db8:66::1');
    expect(route(w, 'r1', '2001:db8:66::/64')).toBeUndefined();
    const n = STATIC6_RECURSION_MAX + 2;
    for (let k = 1; k <= n; k++) {
      const via = k === 1 ? '2001:db8:12::2' : `2001:db8:${100 + k - 1}::1`;
      w.global('r1', `ipv6 route 2001:db8:${100 + k}::/64 ${via}`);
    }
    for (let k = 1; k < n; k++) expect(route(w, 'r1', `2001:db8:${100 + k}::/64`)).toMatchObject({ source: 'S' });
    expect(route(w, 'r1', `2001:db8:${100 + n}::/64`)).toBeUndefined();
    w.global('r1', 'no ipv6 route 2001:db8:2::/64 2001:db8:12::2');
    expect(route(w, 'r1', '2001:db8:99::/64')).toBeUndefined();
  });

  it('a static whose next hop lies inside its own prefix, installed through a covering default, forwards through the default with its own line as the hop-limit cause', () => {
    const w = chain();
    w.global('r1', 'ipv6 route ::/0 2001:db8:12::2');
    w.global('r1', 'ipv6 route 2001:db8:2::/64 2001:db8:2::9');
    w.global('r2', 'ipv6 route 2001:db8:1::/64 2001:db8:12::1');
    expect(route(w, 'r1', '2001:db8:2::/64')).toMatchObject({ source: 'S', nextHop: '2001:db8:2::9' });
    const pc2 = (w.dev('pc2').port(PC)!.l3.ipv6 ?? []).find((a) => a.origin === 'slaac')!.address;
    expect(ping6(w, 'pc1', pc2, 'p')).toContain('!!!');
    const echo = w.sentBy('r1', G1).find((p) => p.layer('icmpv6')?.fields.type === 128)!;
    expect(echo.provenance.find((m) => m.reason === 'TtlDecrement')).toMatchObject({ device: 'r1', cause: 'ipv6 route 2001:db8:2::/64 2001:db8:2::9' });
    expect(echo.provenance.find((m) => m.reason === 'MacRewrite' && m.device === 'r1' && m.field === 'ethernet.dst')).toMatchObject({ after: mac(w, 'r2', G1) });
  });

  it('the router sources its own traffic through a recursive static: a host route whose next hop is behind a /64 line', () => {
    const w = chain();
    w.global('r1', 'ipv6 route 2001:db8:2::/64 2001:db8:12::2');
    w.global('r2', 'ipv6 route 2001:db8:1::/64 2001:db8:12::1');
    const pc2 = (w.dev('pc2').port(PC)!.l3.ipv6 ?? []).find((a) => a.origin === 'slaac')!.address;
    w.global('r1', `ipv6 route ${pc2}/128 2001:db8:2::1`);
    expect(route(w, 'r1', `${pc2}/128`)).toMatchObject({ source: 'S', nextHop: '2001:db8:2::1' });
    const out = ping6(w, 'r1', pc2, 'own');
    expect(out).not.toContain('No IPv6 route');
    expect(out).toContain('!!!');
    const echo = w.sentBy('r1', G1).find((p) => p.layer('icmpv6')?.fields.type === 128)!;
    expect(echo.get('ipv6.src')).toBe('2001:db8:12::1');
  });

  it('installs a static when it becomes usable (after the interface address finishes DAD) and withdraws it at shutdown', () => {
    const w = createWorld6({ seed: 4 });
    w.add('r1', 'router');
    w.add('r2', 'router');
    w.link({ device: 'r1', port: G1 }, { device: 'r2', port: G1 });
    w.runFor(BOOT_NS);
    w.global('r1', 'ipv6 unicast-routing', 'ipv6 route 2001:db8:2::/64 2001:db8:12::2', `ipv6 route 2001:db8:3::/64 ${G1}`);
    const configuredAt = w.now();
    expect(rib6(w, 'r1')).toEqual([]);
    w.iface('r1', G1, 'ipv6 address 2001:db8:12::1/64', 'no shutdown');
    w.iface('r2', G1, 'ipv6 address 2001:db8:12::2/64', 'no shutdown');
    w.runFor(3 * SEC);
    const s = route(w, 'r1', '2001:db8:2::/64')!;
    expect(s).toMatchObject({ source: 'S', nextHop: '2001:db8:12::2', ad: 1 });
    expect(route(w, 'r1', '2001:db8:3::/64')).toMatchObject({ source: 'S', iface: G1 });
    const sw = writes(w, 'r1', '2001:db8:2::/64');
    const cw = writes(w, 'r1', '2001:db8:12::/64');
    expect(sw).toHaveLength(1);
    expect(sw[0]!.t).toBeGreaterThan(configuredAt);
    expect(sw[0]!.t).toBe(cw[0]!.t);
    expect(s.updatedAt).toBe(sw[0]!.t);
    w.iface('r1', G1, 'shutdown');
    w.runFor(SEC);
    expect(route(w, 'r1', '2001:db8:2::/64')).toBeUndefined();
    expect(route(w, 'r1', '2001:db8:3::/64')).toBeUndefined();
    expect(w.kinds('tableExpire').filter((e) => e.device === 'r1' && e.key === '2001:db8:2::/64')).toHaveLength(1);
    w.iface('r1', G1, 'no shutdown');
    w.runFor(3 * SEC);
    expect(route(w, 'r1', '2001:db8:2::/64')).toMatchObject({ nextHop: '2001:db8:12::2' });
    expect(w.dev('r1').processes.get('ipv6')!.stateSnapshot().state).toMatchObject({ staticRoutes: 2 });
  });

  it('[S6] two equal lines for one prefix install one row with paths; each has its line as cause', () => {
    const w = chain();
    w.global('r1', 'ipv6 route 2001:db8:2::/64 2001:db8:12::2', 'ipv6 route 2001:db8:2::/64 2001:db8:12::3');
    const row = route(w, 'r1', '2001:db8:2::/64')!;
    expect(row).toMatchObject({ nextHop: '2001:db8:12::2', ad: 1 });
    expect(row.paths).toEqual([
      { nextHop: '2001:db8:12::2', cause: 'ipv6 route 2001:db8:2::/64 2001:db8:12::2' },
      { nextHop: '2001:db8:12::3', cause: 'ipv6 route 2001:db8:2::/64 2001:db8:12::3' },
    ]);
    w.global('r1', 'no ipv6 route 2001:db8:2::/64 2001:db8:12::3');
    expect(route(w, 'r1', '2001:db8:2::/64')!.paths).toBeUndefined();
  });
});
