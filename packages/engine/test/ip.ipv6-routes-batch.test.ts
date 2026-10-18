/**
 * ip.ipv6-routes-batch — the IPv6 routing plumbing OSPFv3 needs (ARCHITECTURE-P3C §2.4, §3.3 step 6, §7 W2a l3; P3a
 * D8 mirrored): `ipv6.routes` replaces the owner's candidate set (slots `${owner}|${slot}`, so a changed next hop is a
 * re-offer in place = one tableWrite; ascending (network, prefix length) order; `settleStatics` once; no decision
 * event; one 'ipv6 routing' line per installed-row change), `Route6Row.owner`, multipath for `'O'` in batch order, the
 * paths of an interface withdrawn at link-down, AD arbitration against statics, and the `O` / `OI` / `OE2` renderers
 * (`route6SourceCode`, `route6Cause`). Runs on real device runtimes (test/ip6.harness.ts).
 */
import { describe, expect, it } from 'vitest';
import type { DebugEvent, ProcessRequest } from '../src/contracts/process.js';
import { AD_OSPF, route6Key, type Route6Row } from '../src/contracts/tables.js';
import { MS, SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { eui64Address, linkLocalFromMac } from '../src/core/addr6.js';
import { compareRoute6Keys, ipv6RoutingProcessId, route6Cause, route6SlotOwner, route6SourceCode } from '../src/protocols/ipv6.js';
import { BOOT_NS, createWorld6, recorder, type Recorder, type World6 } from './ip6.harness.js';

const PC = 'GigabitEthernet0';
const G0 = 'GigabitEthernet0/0';
const G1 = 'GigabitEthernet0/1';

const mac = (w: World6, dev: string, port: string): string => w.dev(dev).port(port)!.mac;
const ll = (w: World6, dev: string, port: string): string => linkLocalFromMac(mac(w, dev, port));
const rib6 = (w: World6, dev: string): Route6Row[] => w.dev(dev).tables.get<Route6Row>('rib6')!.rows();
const row = (w: World6, dev: string, key: string): Route6Row | undefined => rib6(w, dev).find((r) => r.key === key);

/** An OSPFv3 row as the daemon offers it: source 'O', AD 110. */
function o(network: string, prefixLen: number, nextHop: string, iface: string, metric: number, extra: Partial<Route6Row> = {}): Route6Row {
  return { key: route6Key(network, prefixLen), network, prefixLen, source: 'O', nextHop, iface, ad: AD_OSPF, metric, updatedAt: 0, ...extra };
}
const batch = (rows: Route6Row[], owner = 'ospfv3'): ProcessRequest => ({ kind: 'ipv6.routes', owner, rows });

/** rib6 tableWrite / tableExpire events of `dev` since trace index `from`. */
function ribEvents(w: World6, dev: string, from: number): { kind: string; key: string }[] {
  return w.events
    .slice(from)
    .filter((e): e is Extract<TraceEvent, { kind: 'tableWrite' | 'tableExpire' }> => (e.kind === 'tableWrite' || e.kind === 'tableExpire') && e.device === dev && e.table === 'rib6')
    .map((e) => ({ kind: e.kind, key: e.key }));
}

/** A mark in the ipv6 daemon's debug ring of `dev` (the events seen so far). */
function mark(w: World6, dev: string): Set<DebugEvent> {
  return new Set(w.dev(dev).processes.get('ipv6')!.debugEvents());
}

/** The 'ipv6 routing' debug messages of `dev` after `seen`. */
function routingLines(w: World6, dev: string, seen: Set<DebugEvent>): string[] {
  return w.dev(dev).processes.get('ipv6')!.debugEvents().filter((e) => !seen.has(e) && e.category === 'ipv6 routing').map((e) => e.message);
}

/**
 * R1, R2 and R3 on one LAN (2001:db8:a::/64, R1 Gi0/0 .1, R2 .2, R3 .3); PC1 behind R1 Gi0/1 (2001:db8:1::/64, SLAAC).
 */
function lan(ospfv3?: Recorder): World6 {
  const w = createWorld6(ospfv3 === undefined ? { seed: 3 } : { seed: 3, routerProcesses: ['ospfv3'], extra: { ospfv3: () => ospfv3 } });
  w.add('r1', 'router');
  w.add('r2', 'router');
  w.add('r3', 'router');
  w.add('pc1', 'pc');
  w.link({ device: 'r1', port: G0 }, { device: 'r2', port: G0 }, { device: 'r3', port: G0 });
  w.link({ device: 'r1', port: G1 }, { device: 'pc1', port: PC });
  w.runFor(BOOT_NS);
  for (const [r, a] of [['r1', '1'], ['r2', '2'], ['r3', '3']] as const) {
    w.global(r, 'ipv6 unicast-routing');
    w.iface(r, G0, `ipv6 address 2001:db8:a::${a}/64`, 'no shutdown');
  }
  w.iface('r1', G1, 'ipv6 address 2001:db8:1::1/64', 'no shutdown');
  w.iface('pc1', PC, 'ipv6 address autoconfig');
  w.runFor(6 * SEC);
  return w;
}

describe('ipv6.routes: one batch replaces the owner set (P3a D8 mirrored)', () => {
  it('installs O rows with AD 110 and the owner stamped, in ascending (network, length) order, one write each', () => {
    const rec = recorder('ospfv3');
    const w = lan(rec);
    const nh = ll(w, 'r2', G0);
    const from = w.events.length;
    const seen = mark(w, 'r1');
    const t = w.now();
    w.request('r1', 'ipv6', batch([o('2001:db8:3::', 64, nh, G0, 3), o('2001:db8:2::', 64, nh, G0, 2), o('2001:db8:2::', 56, nh, G0, 4)]));
    expect(ribEvents(w, 'r1', from)).toEqual([
      { kind: 'tableWrite', key: '2001:db8:2::/56' },
      { kind: 'tableWrite', key: '2001:db8:2::/64' },
      { kind: 'tableWrite', key: '2001:db8:3::/64' },
    ]);
    expect(row(w, 'r1', '2001:db8:3::/64')).toEqual({
      key: '2001:db8:3::/64', network: '2001:db8:3::', prefixLen: 64, source: 'O', nextHop: nh, iface: G0, ad: 110, metric: 3, owner: 'ospfv3', updatedAt: t,
    });
    expect(routingLines(w, 'r1', seen)).toEqual([
      `add O 2001:db8:2::/56 via ${nh} [110/4] (ospfv3)`,
      `add O 2001:db8:2::/64 via ${nh} [110/2] (ospfv3)`,
      `add O 2001:db8:3::/64 via ${nh} [110/3] (ospfv3)`,
    ]);
    // no decision event: ipv6 answers a batch with nothing
    expect(rec.evs).toEqual([]);
    expect(rec.requests).toEqual([]);
    // the P1 rows keep their bytes: no owner key on connected and local rows
    expect(row(w, 'r1', '2001:db8:a::/64')).not.toHaveProperty('owner');
    expect(row(w, 'r1', '2001:db8:a::1/128')).not.toHaveProperty('owner');
  });

  it('the same batch writes nothing; a changed next hop is one re-offer in place; vanished rows go; [] withdraws all', () => {
    const w = lan();
    const n2 = ll(w, 'r2', G0);
    const n3 = ll(w, 'r3', G0);
    const rows = [o('2001:db8:2::', 64, n2, G0, 2), o('2001:db8:3::', 64, n2, G0, 3)];
    w.request('r1', 'ipv6', batch(rows));
    let from = w.events.length;
    let seen = mark(w, 'r1');
    w.request('r1', 'ipv6', batch(rows));
    expect(ribEvents(w, 'r1', from)).toEqual([]);
    expect(routingLines(w, 'r1', seen)).toEqual([]);
    // a changed next hop: slot 0 re-offered in place (one write, no expire)
    from = w.events.length;
    seen = mark(w, 'r1');
    w.request('r1', 'ipv6', batch([o('2001:db8:2::', 64, n2, G0, 2), o('2001:db8:3::', 64, n3, G0, 3)]));
    expect(ribEvents(w, 'r1', from)).toEqual([{ kind: 'tableWrite', key: '2001:db8:3::/64' }]);
    expect(routingLines(w, 'r1', seen)).toEqual([`change O 2001:db8:3::/64 via ${n3} [110/3] (ospfv3; was O 2001:db8:3::/64 via ${n2} [110/3])`]);
    expect(row(w, 'r1', '2001:db8:3::/64')).toMatchObject({ nextHop: n3, owner: 'ospfv3' });
    // a vanished row is withdrawn
    from = w.events.length;
    seen = mark(w, 'r1');
    w.request('r1', 'ipv6', batch([o('2001:db8:3::', 64, n3, G0, 3)]));
    expect(ribEvents(w, 'r1', from)).toEqual([{ kind: 'tableExpire', key: '2001:db8:2::/64' }]);
    expect(routingLines(w, 'r1', seen)).toEqual([`remove O 2001:db8:2::/64 via ${n2} [110/2] (ospfv3)`]);
    // the empty batch withdraws everything the owner offered
    from = w.events.length;
    w.request('r1', 'ipv6', batch([]));
    expect(ribEvents(w, 'r1', from)).toEqual([{ kind: 'tableExpire', key: '2001:db8:3::/64' }]);
    expect(rib6(w, 'r1').some((r) => r.source === 'O')).toBe(false);
    // the route sets are internal: the StateView keeps exactly its P1/P2 members
    expect(Object.keys(w.dev('r1').processes.get('ipv6')!.stateSnapshot().state)).toEqual([
      'forwarding', 'interfaces', 'staticRoutes', 'forwarded', 'delivered', 'sent', 'dropped',
    ]);
  });

  it('equal-cost O paths install as ONE row with paths in batch order; each path carries its own cause', () => {
    const w = lan();
    w.global('r1', 'ipv6 router ospf 1');
    const n2 = ll(w, 'r2', G0);
    const n3 = ll(w, 'r3', G0);
    const from = w.events.length;
    const seen = mark(w, 'r1');
    w.request('r1', 'ipv6', batch([o('2001:db8:3::', 64, n3, G0, 3), o('2001:db8:3::', 64, n2, G0, 3)]));
    // slot 0 installs, slot 1 joins the path set (two writes of the one row, as ipv4's batch does)
    expect(ribEvents(w, 'r1', from)).toEqual([{ kind: 'tableWrite', key: '2001:db8:3::/64' }, { kind: 'tableWrite', key: '2001:db8:3::/64' }]);
    const r = row(w, 'r1', '2001:db8:3::/64')!;
    expect(r).toMatchObject({ source: 'O', nextHop: n3, iface: G0, owner: 'ospfv3' });
    expect(r.paths).toEqual([
      { nextHop: n3, iface: G0, cause: `ospfv3 1: O 2001:db8:3::/64 [110/3] via ${n3}` },
      { nextHop: n2, iface: G0, cause: `ospfv3 1: O 2001:db8:3::/64 [110/3] via ${n2}` },
    ]);
    expect(routingLines(w, 'r1', seen)).toEqual([`add O 2001:db8:3::/64 via ${n3}, ${n2} [110/3] (ospfv3)`]);
    // the slot owners are `${owner}|${slot}`
    expect(route6SlotOwner('ospfv3', 1)).toBe('ospfv3|1');
    // reordering unchanged paths offers nothing and writes nothing
    let again = w.events.length;
    w.request('r1', 'ipv6', batch([o('2001:db8:3::', 64, n2, G0, 3), o('2001:db8:3::', 64, n3, G0, 3)]));
    expect(ribEvents(w, 'r1', again)).toEqual([]);
    // one changed path: one write, the set keeps its order
    const n9 = 'fe80::9';
    again = w.events.length;
    w.request('r1', 'ipv6', batch([o('2001:db8:3::', 64, n3, G0, 3), o('2001:db8:3::', 64, n9, G0, 3)]));
    expect(ribEvents(w, 'r1', again)).toEqual([{ kind: 'tableWrite', key: '2001:db8:3::/64' }]);
    expect(row(w, 'r1', '2001:db8:3::/64')!.paths!.map((p) => p.nextHop)).toEqual([n3, n9]);
    // a higher-cost path never joins
    w.request('r1', 'ipv6', batch([o('2001:db8:4::', 64, n2, G0, 3), o('2001:db8:4::', 64, n3, G0, 9)]));
    expect(row(w, 'r1', '2001:db8:4::/64')).toMatchObject({ nextHop: n2, metric: 3 });
    expect(row(w, 'r1', '2001:db8:4::/64')).not.toHaveProperty('paths');
  });

  it('arbitrates by AD against statics: S (AD 1) wins; a floating static (AD 200) takes over when O goes', () => {
    const w = lan();
    const n2 = ll(w, 'r2', G0);
    w.global('r1', 'ipv6 route 2001:db8:3::/64 2001:db8:a::3', 'ipv6 route 2001:db8:4::/64 2001:db8:a::3 200');
    w.request('r1', 'ipv6', batch([o('2001:db8:3::', 64, n2, G0, 3), o('2001:db8:4::', 64, n2, G0, 4)]));
    expect(row(w, 'r1', '2001:db8:3::/64')).toMatchObject({ source: 'S', ad: 1, nextHop: '2001:db8:a::3' });
    expect(row(w, 'r1', '2001:db8:3::/64')).not.toHaveProperty('owner');
    expect(row(w, 'r1', '2001:db8:4::/64')).toMatchObject({ source: 'O', ad: 110, owner: 'ospfv3' });
    w.request('r1', 'ipv6', batch([]));
    expect(row(w, 'r1', '2001:db8:4::/64')).toMatchObject({ source: 'S', ad: 200, nextHop: '2001:db8:a::3' });
    expect(row(w, 'r1', '2001:db8:3::/64')).toMatchObject({ source: 'S', ad: 1 });
    // a static whose next hop is reached only through an O route is usable (D13)
    w.global('r1', 'ipv6 route 2001:db8:5::/64 2001:db8:3::9');
    expect(row(w, 'r1', '2001:db8:5::/64')).toMatchObject({ source: 'S' });
  });

  it('a static resolving through an O route follows it: installed with the batch, withdrawn without it', () => {
    const w = lan();
    const n2 = ll(w, 'r2', G0);
    w.global('r1', 'ipv6 route 2001:db8:5::/64 2001:db8:3::9');
    expect(row(w, 'r1', '2001:db8:5::/64')).toBeUndefined();
    w.request('r1', 'ipv6', batch([o('2001:db8:3::', 64, n2, G0, 3)]));
    expect(row(w, 'r1', '2001:db8:5::/64')).toMatchObject({ source: 'S', nextHop: '2001:db8:3::9' });
    w.request('r1', 'ipv6', batch([]));
    expect(row(w, 'r1', '2001:db8:5::/64')).toBeUndefined();
  });

  it('withdraws every batch path through an interface at link-down, before the owner recomputes', () => {
    const w = lan();
    const n2 = ll(w, 'r2', G0);
    const pcLl = ll(w, 'pc1', PC);
    w.request('r1', 'ipv6', batch([o('2001:db8:3::', 64, n2, G0, 3), o('2001:db8:9::', 64, pcLl, G1, 5)]));
    const seen = mark(w, 'r1');
    w.iface('r1', G0, 'shutdown');
    w.runFor(100 * MS);
    expect(row(w, 'r1', '2001:db8:3::/64')).toBeUndefined();
    expect(row(w, 'r1', '2001:db8:9::/64')).toMatchObject({ source: 'O', iface: G1 });
    expect(routingLines(w, 'r1', seen)).toContain(`remove O 2001:db8:3::/64 via ${n2} [110/3] (ospfv3: ${G0} went down)`);
    // the slot is forgotten: the owner's next batch offers it again (one write)
    w.iface('r1', G0, 'no shutdown');
    w.runFor(3 * SEC);
    const again = w.events.length;
    w.request('r1', 'ipv6', batch([o('2001:db8:3::', 64, n2, G0, 3), o('2001:db8:9::', 64, pcLl, G1, 5)]));
    expect(ribEvents(w, 'r1', again)).toEqual([{ kind: 'tableWrite', key: '2001:db8:3::/64' }]);
  });

  it('forwards through an O row: the hop-limit decrement names the OSPFv3 route', () => {
    const w = lan();
    w.global('r1', 'ipv6 router ospf 1');
    const n2 = ll(w, 'r2', G0);
    w.request('r1', 'ipv6', batch([o('2001:db8:3::', 64, n2, G0, 3)]));
    const target = '2001:db8:3::5';
    w.request('pc1', 'icmpv6', { kind: 'icmp6.ping', session: 'p', target, count: 1, timeoutNs: 2 * SEC, sizeBytes: 100 });
    w.runFor(SEC);
    const first = w.kinds('pduCreated').find((e) => e.device === 'pc1' && e.pdu.tag === 'ping6#1')!.pdu.id;
    const hops = w.kinds('mutation').filter((m) => m.pdu === first && m.mutation.field === 'ipv6.hopLimit');
    expect(hops.map((m) => [m.mutation.device, m.mutation.reason, m.mutation.cause])).toEqual([
      ['r1', 'TtlDecrement', `ospfv3 1: O 2001:db8:3::/64 [110/3] via ${n2}`],
    ]);
    expect(w.sentBy('r1', G0).some((p) => p.id === first)).toBe(true);
  });

  it('ignores invalid rows (non-canonical network, host bits, a wrong key, an infinite distance) and keeps the rest', () => {
    const w = lan();
    const n2 = ll(w, 'r2', G0);
    const from = w.events.length;
    const seen = mark(w, 'r1');
    w.request('r1', 'ipv6', batch([
      { ...o('2001:db8:3::', 64, n2, G0, 3), network: '2001:DB8:3::' },
      { ...o('2001:db8:3::', 64, n2, G0, 3), network: '2001:db8:3::1', key: '2001:db8:3::1/64' },
      { ...o('2001:db8:3::', 64, n2, G0, 3), key: '2001:db8:3::/48' },
      { ...o('2001:db8:3::', 64, n2, G0, 3), ad: Number.POSITIVE_INFINITY },
      o('2001:db8:6::', 64, n2, G0, 6),
    ]));
    expect(ribEvents(w, 'r1', from)).toEqual([{ kind: 'tableWrite', key: '2001:db8:6::/64' }]);
    expect(routingLines(w, 'r1', seen).filter((l) => l.startsWith('ignored route'))).toHaveLength(4);
  });

  it('keeps two owners apart: each batch replaces only its own set', () => {
    const w = lan();
    const n2 = ll(w, 'r2', G0);
    const n3 = ll(w, 'r3', G0);
    w.request('r1', 'ipv6', batch([o('2001:db8:3::', 64, n2, G0, 3)], 'ospfv3'));
    w.request('r1', 'ipv6', batch([o('2001:db8:7::', 64, n3, G0, 1)], 'other'));
    w.request('r1', 'ipv6', batch([], 'ospfv3'));
    expect(row(w, 'r1', '2001:db8:3::/64')).toBeUndefined();
    expect(row(w, 'r1', '2001:db8:7::/64')).toMatchObject({ owner: 'other' });
  });
});

describe('the O / OI / OE2 renderers', () => {
  it('route6SourceCode: O, OI, OE2 for OSPFv3 rows; every P1 code unchanged', () => {
    expect(route6SourceCode({ source: 'O' })).toBe('O');
    expect(route6SourceCode({ source: 'O', routeType: 'OI' })).toBe('OI');
    expect(route6SourceCode({ source: 'O', routeType: 'OE2', isDefault: true })).toBe('OE2');
    expect(route6SourceCode({ source: 'C' })).toBe('C');
    expect(route6SourceCode({ source: 'L' })).toBe('L');
    expect(route6SourceCode({ source: 'S', isDefault: true })).toBe('S*');
    expect(route6SourceCode({ source: 'ND', isDefault: true })).toBe('ND*');
  });

  it('route6Cause: the OSPFv3 line with the process number when a section is stored; P1 causes unchanged', () => {
    const r = o('2001:db8:3::', 64, 'fe80::2', G0, 3);
    expect(route6Cause(r)).toBe('ospfv3: O 2001:db8:3::/64 [110/3] via fe80::2');
    expect(route6Cause({ ...r, routeType: 'OI', metric: 20 })).toBe('ospfv3: OI 2001:db8:3::/64 [110/20] via fe80::2');
    const w = lan();
    expect(ipv6RoutingProcessId({ config: w.dev('r1').running }, 'ospf')).toBeUndefined();
    w.global('r1', 'ipv6 router ospf 7');
    const ctx = { config: w.dev('r1').running };
    expect(ipv6RoutingProcessId(ctx, 'ospf')).toBe('7');
    expect(route6Cause({ ...r, routeType: 'OE2' }, ctx)).toBe('ospfv3 7: OE2 2001:db8:3::/64 [110/3] via fe80::2');
    // the P1 forms do not read the ctx
    const s: Route6Row = { key: '2001:db8:2::/64', network: '2001:db8:2::', prefixLen: 64, source: 'S', nextHop: '2001:db8:12::2', ad: 1, metric: 0, updatedAt: 0 };
    expect(route6Cause(s, ctx)).toBe(route6Cause(s));
    expect(route6Cause(s)).toBe('ipv6 route 2001:db8:2::/64 2001:db8:12::2');
  });

  it('compareRoute6Keys: by network as a 128-bit number, then prefix length', () => {
    const keys = ['2001:db8:10::/64', '2001:db8:2::/64', '::/0', '2001:db8:2::/48', 'fe80::/10', '2001:db8:2::1/128'];
    expect([...keys].sort(compareRoute6Keys)).toEqual(['::/0', '2001:db8:2::/48', '2001:db8:2::/64', '2001:db8:2::1/128', '2001:db8:10::/64', 'fe80::/10']);
  });

  it('an SLAAC host address sorts by value, not by text', () => {
    const a = eui64Address('2001:db8:1::', 64, '00:1f:00:00:00:01')!;
    expect(compareRoute6Keys(`${a}/128`, '2001:db8:1::/64')).toBeGreaterThan(0);
  });
});
