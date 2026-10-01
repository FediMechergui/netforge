/**
 * ip.ospf-plumbing — the L3 plumbing OSPF needs (ARCHITECTURE-P3 D7, D8, D11, §2.4, §3.0 (a); §7 W1 l3):
 * `ipv4.routes` (a batch replaces the owner's candidate set; slots `${owner}|${slot}`, so a changed next hop is a
 * re-offer in place = one tableWrite; ascending (network u32, prefix length) order; `settleStatics` once; no decision
 * event; one 'ip routing' line per installed-row change), multipath for `'O'`, `routeCause` for OSPF, the paths of an
 * interface withdrawn at link-down, `ipv4.ribWatch` / `ipv4.ribChanged` with `keys` and `lpm` (answered at once and on
 * change, to the owner only), and `IPV4_UPPER` 89. Runs ipv4 on the fake ctx of ip.fake-ctx.ts (real tables, LPM,
 * PDU factory).
 */
import { describe, expect, it } from 'vitest';
import type { ConfigDelta } from '../src/contracts/config.js';
import type { DeviceModel } from '../src/contracts/device.js';
import { IPPROTO_OSPF, OSPF_ALL_ROUTERS, type LayerSpec } from '../src/contracts/pdu.js';
import type { Action, ProcessCtx, ProcessRequest } from '../src/contracts/process.js';
import { AD_OSPF, routeKey, type RouteRow } from '../src/contracts/tables.js';
import type { RibChangedEvent } from '../src/contracts/transport.js';
import { ecmpIndex, createIpv4, routeCause, routeSlotOwner, routeSourceCode, routingProcessId } from '../src/protocols/ipv4.js';
import { IPV4_UPPER, ipv4UpperProcess } from '../src/protocols/ip-upper.js';
import { echoRequest, framed, makeFake, makeSink, type Fake } from './ip.fake-ctx.js';

const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';
const GI2 = 'GigabitEthernet0/2';
const MAC_R0 = '00:1f:00:00:00:10';
const MAC_R1 = '00:1f:00:00:00:11';
const MAC_R2 = '00:1f:00:00:00:12';
const MAC_PC = '00:1f:00:00:00:01';

const setAddr = (port: string, a: string, m: string): ConfigDelta => ({ op: 'set', context: [['interface', port]], line: ['ip', 'address', a, m] });
const setRoute = (...args: string[]): ConfigDelta => ({ op: 'set', context: [], line: ['ip', 'route', ...args] });

/** An OSPF row as the daemon offers it (D8): source 'O', AD 110. */
function o(network: string, prefixLen: number, nextHop: string, iface: string, metric: number, extra: Partial<RouteRow> = {}): RouteRow {
  return { key: routeKey(network, prefixLen), network, prefixLen, source: 'O', nextHop, iface, ad: AD_OSPF, metric, updatedAt: 0, ...extra };
}

const routes = (rows: RouteRow[], owner = 'ospf'): ProcessRequest => ({ kind: 'ipv4.routes', owner, rows });

/**
 * R1: Gi0/0 10.0.12.1/29 (towards R2 .2 and a second router .3), Gi0/1 10.0.13.1/29 (towards R3 .2, .3), Gi0/2
 * 10.1.0.1/24 (a LAN), all up, with `router ospf 1` stored.
 */
function r1() {
  const fake = makeFake({ kind: 'router', ports: [{ id: GI0, mac: MAC_R0 }, { id: GI1, mac: MAC_R1 }, { id: GI2, mac: MAC_R2 }] });
  const ipv4 = createIpv4();
  const arp = makeSink('arp');
  const icmp = makeSink('icmpv4');
  fake.register(ipv4);
  fake.register(arp);
  fake.register(icmp);
  fake.run(ipv4.onConfig(fake.ctx, setAddr(GI0, '10.0.12.1', '255.255.255.248')));
  fake.run(ipv4.onConfig(fake.ctx, setAddr(GI1, '10.0.13.1', '255.255.255.248')));
  fake.run(ipv4.onConfig(fake.ctx, setAddr(GI2, '10.1.0.1', '255.255.255.0')));
  fake.ctx.config.set([], ['router', 'ospf', '1']);
  arp.requests.length = 0;
  return { fake, ipv4, arp, icmp };
}

/** The rib tableWrite / tableExpire keys since trace index `from`. */
function ribWrites(fake: Fake, from = 0): { kind: string; key: string }[] {
  return fake.trace
    .slice(from)
    .filter((e) => (e.kind === 'tableWrite' || e.kind === 'tableExpire') && e.table === 'rib')
    .map((e) => ({ kind: e.kind, key: (e as { key: string }).key }));
}

/** ProcessEvents among `actions`, with their targets. */
function events(actions: readonly Action[]): { to: string; ev: RibChangedEvent }[] {
  return actions.filter((a): a is Extract<Action, { type: 'event' }> => a.type === 'event').map((a) => ({ to: a.to, ev: a.ev as RibChangedEvent }));
}

/** `fake.ctx` seen with a model that also runs `names`. */
function withDaemons(fake: Fake, ...names: string[]): ProcessCtx {
  const model: DeviceModel = { ...fake.ctx.model, processes: [...fake.ctx.model.processes, ...names] };
  return Object.create(fake.ctx, { model: { value: model, enumerable: true } }) as ProcessCtx;
}

describe('ip.ospf-plumbing: ipv4.routes batches (D8)', () => {
  it('installs a batch in ascending (network u32, prefix length) order, one write per row, no decision event', () => {
    const { fake, ipv4 } = r1();
    const mark = fake.trace.length;
    const out = ipv4.onRequest!(fake.ctx, routes([
      o('10.3.0.0', 24, '10.0.12.2', GI0, 3),
      o('10.0.23.0', 30, '10.0.12.2', GI0, 2),
      o('0.0.0.0', 0, '10.0.12.2', GI0, 1, { routeType: 'E2', isDefault: true }),
      o('10.3.0.0', 16, '10.0.12.2', GI0, 4),
      o('10.0.0.0', 8, '10.0.13.2', GI1, 65),
    ]));
    expect(out).toEqual([]);
    expect(ribWrites(fake, mark)).toEqual([
      { kind: 'tableWrite', key: '0.0.0.0/0' },
      { kind: 'tableWrite', key: '10.0.0.0/8' },
      { kind: 'tableWrite', key: '10.0.23.0/30' },
      { kind: 'tableWrite', key: '10.3.0.0/16' },
      { kind: 'tableWrite', key: '10.3.0.0/24' },
    ]);
    const row = fake.tables.rib.get('10.3.0.0/24')!;
    expect(row).toEqual({
      key: '10.3.0.0/24', network: '10.3.0.0', prefixLen: 24, source: 'O', nextHop: '10.0.12.2', iface: GI0, ad: 110, metric: 3,
      updatedAt: fake.ctx.now, owner: 'ospf',
    });
    expect(fake.tables.rib.get('0.0.0.0/0')).toMatchObject({ source: 'O', routeType: 'E2', isDefault: true });
    // one 'ip routing' line per installed-row change, in key order
    const lines = fake.debug.filter((d) => d.category === 'ip routing').slice(-5).map((d) => d.message);
    expect(lines).toEqual([
      'add O*E2 0.0.0.0/0 via 10.0.12.2 [110/1] (ospf)',
      'add O 10.0.0.0/8 via 10.0.13.2 [110/65] (ospf)',
      'add O 10.0.23.0/30 via 10.0.12.2 [110/2] (ospf)',
      'add O 10.3.0.0/16 via 10.0.12.2 [110/4] (ospf)',
      'add O 10.3.0.0/24 via 10.0.12.2 [110/3] (ospf)',
    ]);
    // the batch replaces the whole set: what is not re-sent is withdrawn, in key order
    const mark2 = fake.trace.length;
    expect(ipv4.onRequest!(fake.ctx, routes([o('10.3.0.0', 24, '10.0.12.2', GI0, 3)]))).toEqual([]);
    expect(ribWrites(fake, mark2)).toEqual([
      { kind: 'tableExpire', key: '0.0.0.0/0' },
      { kind: 'tableExpire', key: '10.0.0.0/8' },
      { kind: 'tableExpire', key: '10.0.23.0/30' },
      { kind: 'tableExpire', key: '10.3.0.0/16' },
    ]);
    expect(fake.debug.at(-1)!.message).toBe('remove O 10.3.0.0/16 via 10.0.12.2 [110/4] (ospf)');
    // an empty batch withdraws everything
    ipv4.onRequest!(fake.ctx, routes([]));
    expect(fake.tables.rib.get('10.3.0.0/24')).toBeUndefined();
    expect(fake.tables.rib.rows().every((r) => r.source === 'C' || r.source === 'L')).toBe(true);
  });

  it('a changed next hop is a re-offer of the slot in place: exactly one tableWrite; an identical batch writes nothing', () => {
    const { fake, ipv4 } = r1();
    ipv4.onRequest!(fake.ctx, routes([o('10.3.0.0', 24, '10.0.12.2', GI0, 3)]));
    let mark = fake.trace.length;
    ipv4.onRequest!(fake.ctx, routes([o('10.3.0.0', 24, '10.0.13.2', GI1, 65)]));
    expect(ribWrites(fake, mark)).toEqual([{ kind: 'tableWrite', key: '10.3.0.0/24' }]);
    expect(fake.tables.rib.get('10.3.0.0/24')).toMatchObject({ nextHop: '10.0.13.2', iface: GI1, metric: 65 });
    expect(fake.debug.at(-1)!.message).toBe('change O 10.3.0.0/24 via 10.0.13.2 [110/65] (ospf; was O 10.3.0.0/24 via 10.0.12.2 [110/3])');
    mark = fake.trace.length;
    const debugs = fake.debug.length;
    ipv4.onRequest!(fake.ctx, routes([o('10.3.0.0', 24, '10.0.13.2', GI1, 65)]));
    expect(ribWrites(fake, mark)).toEqual([]);
    expect(fake.debug.length).toBe(debugs);
    // the route sets are internal: the StateView keeps exactly its P2 members
    expect(Object.keys(ipv4.stateSnapshot().state)).toEqual(['forwarding', 'interfaces', 'staticRoutes', 'forwarded', 'delivered', 'sent', 'dropped']);
    expect(routeSlotOwner('ospf', 1)).toBe('ospf|1');
  });

  it('ECMP: rows sharing a key are equal-cost paths, each with the OSPF cause; forwarding hashes over them', () => {
    const { fake, ipv4, arp } = r1();
    ipv4.onRequest!(fake.ctx, routes([o('10.3.0.0', 24, '10.0.12.2', GI0, 3), o('10.3.0.0', 24, '10.0.13.2', GI1, 3)]));
    const row = fake.tables.rib.get('10.3.0.0/24')!;
    expect(row).toMatchObject({ source: 'O', nextHop: '10.0.12.2', iface: GI0, ad: 110, metric: 3 });
    expect(row.paths).toEqual([
      { nextHop: '10.0.12.2', iface: GI0, cause: 'ospf 1: O 10.3.0.0/24 [110/3] via 10.0.12.2' },
      { nextHop: '10.0.13.2', iface: GI1, cause: 'ospf 1: O 10.3.0.0/24 [110/3] via 10.0.13.2' },
    ]);
    expect(fake.debug.at(-1)!.message).toBe('add O 10.3.0.0/24 via 10.0.12.2, 10.0.13.2 [110/3] (ospf)');
    // a second path changed: one write, the set keeps its order
    let mark = fake.trace.length;
    ipv4.onRequest!(fake.ctx, routes([o('10.3.0.0', 24, '10.0.12.2', GI0, 3), o('10.3.0.0', 24, '10.0.13.3', GI1, 3)]));
    expect(ribWrites(fake, mark)).toEqual([{ kind: 'tableWrite', key: '10.3.0.0/24' }]);
    expect(fake.tables.rib.get('10.3.0.0/24')!.paths!.map((p) => p.nextHop)).toEqual(['10.0.12.2', '10.0.13.3']);
    // the same paths in another order are no change
    mark = fake.trace.length;
    ipv4.onRequest!(fake.ctx, routes([o('10.3.0.0', 24, '10.0.13.3', GI1, 3), o('10.3.0.0', 24, '10.0.12.2', GI0, 3)]));
    expect(ribWrites(fake, mark)).toEqual([]);
    // each flow leaves by its hashed path, with that path's cause on the TTL decrement
    const srcs = ['10.1.0.2', '10.1.0.3', '10.1.0.4', '10.1.0.5', '10.1.0.6', '10.1.0.7'];
    const a = srcs.find((s) => ecmpIndex(s, '10.3.0.9', 2) === 0)!;
    const b = srcs.find((s) => ecmpIndex(s, '10.3.0.9', 2) === 1)!;
    for (const [src, hop, iface] of [[a, '10.0.12.2', GI0], [b, '10.0.13.3', GI1]] as const) {
      arp.requests.length = 0;
      const pdu = fake.build(framed(MAC_R2, MAC_PC, echoRequest(src, '10.3.0.9', 1, 1, 64)));
      fake.run(ipv4.onPdu(fake.ctx, pdu, GI2));
      expect(arp.requests).toMatchObject([{ kind: 'arp.sendVia', nextHop: hop, iface, cause: `ospf 1: O 10.3.0.0/24 [110/3] via ${hop}` }]);
      expect(fake.mutations.at(-1)).toMatchObject({ field: 'ipv4.ttl', after: 63, reason: 'TtlDecrement', cause: `ospf 1: O 10.3.0.0/24 [110/3] via ${hop}` });
    }
  });

  it('paths through an interface that goes down are withdrawn at link-down; the next batch offers them again', () => {
    const { fake, ipv4 } = r1();
    ipv4.onRequest!(fake.ctx, routes([
      o('10.3.0.0', 24, '10.0.12.2', GI0, 3),
      o('10.3.0.0', 24, '10.0.13.2', GI1, 3),
      o('10.4.0.0', 24, '10.0.12.2', GI0, 2),
    ]));
    fake.setOper(GI0, false);
    const mark = fake.trace.length;
    fake.run(ipv4.onLinkChange!(fake.ctx, GI0, false));
    expect(fake.tables.rib.get('10.3.0.0/24')).toMatchObject({ nextHop: '10.0.13.2', iface: GI1 });
    expect(fake.tables.rib.get('10.3.0.0/24')!.paths).toBeUndefined();
    expect(fake.tables.rib.get('10.4.0.0/24')).toBeUndefined();
    const writes = ribWrites(fake, mark).filter((w) => w.key.startsWith('10.3') || w.key.startsWith('10.4'));
    expect(writes).toEqual([{ kind: 'tableWrite', key: '10.3.0.0/24' }, { kind: 'tableExpire', key: '10.4.0.0/24' }]);
    expect(fake.trace.filter((e) => e.kind === 'tableExpire' && e.key === '10.4.0.0/24').map((e) => (e as { reason: string }).reason)).toEqual(['link-down']);
    expect(fake.debug.some((d) => d.message === 'remove O 10.4.0.0/24 via 10.0.12.2 [110/2] (ospf: GigabitEthernet0/0 went down)')).toBe(true);
    // the daemon's recomputed batch (without Gi0/0) changes nothing more
    const mark2 = fake.trace.length;
    ipv4.onRequest!(fake.ctx, routes([o('10.3.0.0', 24, '10.0.13.2', GI1, 3)]));
    expect(ribWrites(fake, mark2)).toEqual([]);
    // link back up: the next batch offers the path again
    fake.setOper(GI0, true);
    fake.run(ipv4.onLinkChange!(fake.ctx, GI0, true));
    ipv4.onRequest!(fake.ctx, routes([o('10.3.0.0', 24, '10.0.12.2', GI0, 3), o('10.3.0.0', 24, '10.0.13.2', GI1, 3), o('10.4.0.0', 24, '10.0.12.2', GI0, 2)]));
    expect(fake.tables.rib.get('10.3.0.0/24')!.paths!.map((p) => p.nextHop).sort()).toEqual(['10.0.12.2', '10.0.13.2']);
    expect(fake.tables.rib.get('10.4.0.0/24')).toMatchObject({ source: 'O', nextHop: '10.0.12.2' });
  });

  it('ECMP paths install in batch order whatever the offer history: a flap or a staggered convergence (§4.5, D8)', () => {
    const both = [o('10.3.0.0', 24, '10.0.12.2', GI0, 3), o('10.3.0.0', 24, '10.0.13.2', GI1, 3)];
    const inBatchOrder = (fake: Fake): void => {
      const row = fake.tables.rib.get('10.3.0.0/24')!;
      expect(row).toMatchObject({ nextHop: '10.0.12.2', iface: GI0 });
      expect(row.paths!.map((p) => [p.nextHop, p.iface])).toEqual([['10.0.12.2', GI0], ['10.0.13.2', GI1]]);
    };
    // fresh world
    const fresh = r1();
    fresh.ipv4.onRequest!(fresh.fake.ctx, routes(both));
    inBatchOrder(fresh.fake);
    // the first path's interface flaps: the returning path takes a fresh slot, and still installs first
    const { fake, ipv4 } = r1();
    ipv4.onRequest!(fake.ctx, routes(both));
    fake.setOper(GI0, false);
    fake.run(ipv4.onLinkChange!(fake.ctx, GI0, false));
    ipv4.onRequest!(fake.ctx, routes([both[1]!]));
    fake.setOper(GI0, true);
    fake.run(ipv4.onLinkChange!(fake.ctx, GI0, true));
    const mark = fake.trace.length;
    ipv4.onRequest!(fake.ctx, routes(both));
    expect(ribWrites(fake, mark)).toEqual([{ kind: 'tableWrite', key: '10.3.0.0/24' }]);
    inBatchOrder(fake);
    // a staggered first convergence (the second path first, then both) gives the same order
    const late = r1();
    late.ipv4.onRequest!(late.fake.ctx, routes([both[1]!]));
    late.ipv4.onRequest!(late.fake.ctx, routes(both));
    inBatchOrder(late.fake);
    // so a flow leaves by the same path in every world
    const pathOf = (f: Fake): string => f.tables.rib.get('10.3.0.0/24')!.paths![ecmpIndex('10.1.0.2', '10.3.0.9', 2)]!.nextHop!;
    expect(pathOf(fake)).toBe(pathOf(fresh.fake));
    expect(pathOf(late.fake)).toBe(pathOf(fresh.fake));
  });

  it('administrative distance: a static (1) beats O (110); O beats a floating static (120); settleStatics runs once per batch', () => {
    const { fake, ipv4 } = r1();
    ipv4.onConfig(fake.ctx, setRoute('10.5.0.0', '255.255.255.0', '10.0.13.2', '120'));
    expect(fake.tables.rib.get('10.5.0.0/24')).toMatchObject({ source: 'S', ad: 120 });
    ipv4.onRequest!(fake.ctx, routes([o('10.5.0.0', 24, '10.0.12.2', GI0, 2)]));
    expect(fake.tables.rib.get('10.5.0.0/24')).toMatchObject({ source: 'O', ad: 110, nextHop: '10.0.12.2' });
    ipv4.onRequest!(fake.ctx, routes([]));
    expect(fake.tables.rib.get('10.5.0.0/24')).toMatchObject({ source: 'S', ad: 120, nextHop: '10.0.13.2' });
    ipv4.onConfig(fake.ctx, setRoute('10.6.0.0', '255.255.255.0', '10.0.13.2'));
    ipv4.onRequest!(fake.ctx, routes([o('10.6.0.0', 24, '10.0.12.2', GI0, 2)]));
    expect(fake.tables.rib.get('10.6.0.0/24')).toMatchObject({ source: 'S', ad: 1 });
    // a static whose next hop is learned through OSPF becomes usable in the batch that installs the O route
    ipv4.onConfig(fake.ctx, setRoute('172.16.0.0', '255.255.0.0', '10.7.0.1'));
    expect(fake.tables.rib.get('172.16.0.0/16')).toBeUndefined();
    ipv4.onRequest!(fake.ctx, routes([o('10.7.0.0', 24, '10.0.12.2', GI0, 2)]));
    expect(fake.tables.rib.get('172.16.0.0/16')).toMatchObject({ source: 'S', nextHop: '10.7.0.1' });
    ipv4.onRequest!(fake.ctx, routes([]));
    expect(fake.tables.rib.get('172.16.0.0/16')).toBeUndefined();
  });

  it('skips a row with a non-canonical key with one debug line and applies the rest', () => {
    const { fake, ipv4 } = r1();
    ipv4.onRequest!(fake.ctx, routes([{ ...o('10.3.0.0', 24, '10.0.12.2', GI0, 3), key: '10.3.0.0/23' }, o('10.4.0.0', 24, '10.0.12.2', GI0, 3)]));
    expect(fake.tables.rib.get('10.3.0.0/23')).toBeUndefined();
    expect(fake.tables.rib.get('10.4.0.0/24')).toMatchObject({ source: 'O' });
    expect(fake.debug.some((d) => d.message === 'ignored route 10.3.0.0/23 from ospf: invalid network, prefix length or distance')).toBe(true);
  });
});

describe('ip.ospf-plumbing: route codes and causes (D11)', () => {
  it('renders the OSPF cause with the process number of the configuration', () => {
    const { fake } = r1();
    const row = o('10.3.0.0', 24, '10.0.12.2', GI0, 3);
    expect(routingProcessId(fake.ctx, 'ospf')).toBe('1');
    expect(routingProcessId(fake.ctx, 'eigrp')).toBeUndefined();
    expect(routeCause(row, fake.ctx)).toBe('ospf 1: O 10.3.0.0/24 [110/3] via 10.0.12.2');
    expect(routeCause(row)).toBe('ospf: O 10.3.0.0/24 [110/3] via 10.0.12.2');
    expect(routeCause(o('0.0.0.0', 0, '10.0.12.2', GI0, 1, { routeType: 'E2', isDefault: true }), fake.ctx)).toBe('ospf 1: O*E2 0.0.0.0/0 [110/1] via 10.0.12.2');
    expect(routeCause(o('10.9.0.0', 16, '10.0.12.2', GI0, 20, { routeType: 'E2' }), fake.ctx)).toBe('ospf 1: O E2 10.9.0.0/16 [110/20] via 10.0.12.2');
    expect(routeSourceCode(o('10.3.0.0', 24, '10.0.12.2', GI0, 3))).toBe('O');
    // the P1/P2 causes are unchanged with a ctx
    expect(routeCause({ key: '0.0.0.0/0', network: '0.0.0.0', prefixLen: 0, source: 'D', nextHop: '192.168.1.1', ad: 254, metric: 0, isDefault: true, updatedAt: 0 }, fake.ctx)).toBe(
      'dhcp default route via 192.168.1.1',
    );
    expect(routeCause({ key: '10.1.0.0/24', network: '10.1.0.0', prefixLen: 24, source: 'C', iface: GI2, ad: 0, metric: 0, updatedAt: 0 }, fake.ctx)).toBe(`connected via ${GI2}`);
  });
});

describe('ip.ospf-plumbing: the RIB watch (D8)', () => {
  it('an lpm watch is answered at once and on every change of the longest match, to the owner only', () => {
    const { fake, ipv4 } = r1();
    expect(events(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.ribWatch', owner: 'ntp', lpm: ['10.3.0.10'] }))).toEqual([
      { to: 'ntp', ev: { kind: 'ipv4.ribChanged', lpm: { address: '10.3.0.10' } } },
    ]);
    // a route toward it appears
    let evs = events(ipv4.onRequest!(fake.ctx, routes([o('10.3.0.0', 24, '10.0.12.2', GI0, 3)])));
    expect(evs).toHaveLength(1);
    expect(evs[0]!.to).toBe('ntp');
    expect(evs[0]!.ev.lpm).toEqual({ address: '10.3.0.10', row: fake.tables.rib.get('10.3.0.0/24') });
    // an unrelated route changes nothing for the watcher
    expect(events(ipv4.onRequest!(fake.ctx, routes([o('10.3.0.0', 24, '10.0.12.2', GI0, 3), o('10.9.0.0', 24, '10.0.12.2', GI0, 3)])))).toEqual([]);
    // a more specific route takes over
    evs = events(ipv4.onRequest!(fake.ctx, routes([o('10.3.0.0', 24, '10.0.12.2', GI0, 3), o('10.3.0.0', 25, '10.0.13.2', GI1, 9)])));
    expect(evs.map((e) => e.ev.lpm?.row?.key)).toEqual(['10.3.0.0/25']);
    // a static route through the configuration answers too (onConfig)
    evs = events(ipv4.onConfig(fake.ctx, setRoute('10.3.0.8', '255.255.255.248', '10.0.12.3')));
    expect(evs.map((e) => [e.to, e.ev.lpm?.row?.key, e.ev.lpm?.row?.source])).toEqual([['ntp', '10.3.0.8/29', 'S']]);
    // the route disappears: an answer without a row
    ipv4.onConfig(fake.ctx, { op: 'unset', context: [], line: ['ip', 'route'] });
    evs = events(ipv4.onRequest!(fake.ctx, routes([])));
    expect(evs).toEqual([{ to: 'ntp', ev: { kind: 'ipv4.ribChanged', lpm: { address: '10.3.0.10' } } }]);
  });

  it('an exact-key watch answers at once, on change and on link-down; lpm and keys together; empty lists stop it', () => {
    const { fake, ipv4 } = r1();
    const out = ipv4.onRequest!(fake.ctx, { kind: 'ipv4.ribWatch', owner: 'ospf', keys: ['0.0.0.0/0', '10.1.0.0/24'], lpm: ['10.1.0.9'] });
    const evs = events(out);
    expect(evs.map((e) => e.ev)).toEqual([
      { kind: 'ipv4.ribChanged', key: '0.0.0.0/0' },
      { kind: 'ipv4.ribChanged', key: '10.1.0.0/24', row: fake.tables.rib.get('10.1.0.0/24') },
      { kind: 'ipv4.ribChanged', lpm: { address: '10.1.0.9', row: fake.tables.rib.get('10.1.0.0/24') } },
    ]);
    // a static default through onConfig
    let next = events(ipv4.onConfig(fake.ctx, setRoute('0.0.0.0', '0.0.0.0', '10.0.12.2')));
    expect(next.map((e) => [e.to, e.ev.key, e.ev.row?.source])).toEqual([['ospf', '0.0.0.0/0', 'S']]);
    // the LAN goes down: the connected key and the lpm answer both change (the lpm falls back to the default route)
    fake.setOper(GI2, false);
    next = events(ipv4.onLinkChange!(fake.ctx, GI2, false));
    expect(next.map((e) => e.ev)).toEqual([
      { kind: 'ipv4.ribChanged', key: '10.1.0.0/24' },
      { kind: 'ipv4.ribChanged', lpm: { address: '10.1.0.9', row: fake.tables.rib.get('0.0.0.0/0') } },
    ]);
    // re-registering replaces the watch and answers at once
    next = events(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.ribWatch', owner: 'ospf', keys: ['0.0.0.0/0'] }));
    expect(next.map((e) => e.ev.key)).toEqual(['0.0.0.0/0']);
    // empty lists stop it: nothing more, whatever changes
    expect(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.ribWatch', owner: 'ospf', keys: [], lpm: [] })).toEqual([]);
    expect(events(ipv4.onConfig(fake.ctx, { op: 'unset', context: [], line: ['ip', 'route'] }))).toEqual([]);
  });

  it('a device with no watch never emits the event (the P1/P2 paths return exactly what they returned)', () => {
    const { fake, ipv4 } = r1();
    const out = ipv4.onConfig(fake.ctx, setRoute('0.0.0.0', '0.0.0.0', '10.0.12.2'));
    expect(out).toEqual([]);
    expect(ipv4.onRequest!(fake.ctx, routes([o('10.3.0.0', 24, '10.0.12.2', GI0, 3)]))).toEqual([]);
    fake.setOper(GI1, false);
    expect(ipv4.onLinkChange!(fake.ctx, GI1, false)).toEqual([]);
  });
});

describe('ip.ospf-plumbing: IP protocol 89 (IPV4_UPPER)', () => {
  const hello = (dst: string): LayerSpec[] => [
    { proto: 'ipv4', fields: { src: '10.0.12.2', dst, protocol: IPPROTO_OSPF, ttl: 1, dscp: 48 } },
    { proto: 'payload', fields: { data: new Uint8Array(24) } },
  ];

  it('maps 89 to ospf, delivered only where the model runs ospf', () => {
    expect(IPV4_UPPER.find((e) => e.protocol === 89)).toEqual({ protocol: 89, process: 'ospf', label: 'ospf' });
    expect(ipv4UpperProcess({ processes: ['ospf'] }, 89)).toBe('ospf');
    expect(ipv4UpperProcess({ processes: ['ipv4'] }, 89)).toBeUndefined();
  });

  it('a hello to 224.0.0.5 joined on the port reaches ospf; without ospf it drops silently (a group destination)', () => {
    const { fake, ipv4, icmp } = r1();
    const ospf = makeSink('ospf');
    fake.register(ospf);
    const ctx = withDaemons(fake, 'ospf');
    fake.run(ipv4.onRequest!(ctx, { kind: 'ipv4.group', op: 'join', iface: GI0, group: OSPF_ALL_ROUTERS, owner: 'ospf' }));
    const pdu = fake.build(framed('01:00:5e:00:00:05', MAC_PC, hello(OSPF_ALL_ROUTERS)));
    expect(fake.run(ipv4.onPdu(ctx, pdu, GI0))).toEqual([{ type: 'deliver', to: 'ospf', pdu, port: GI0 }]);
    expect(ospf.pdus).toEqual([pdu]);
    // a model without ospf (every P1/P2 model): unsupported-protocol, no ICMP for a multicast destination
    const again = fake.build(framed('01:00:5e:00:00:05', MAC_PC, hello(OSPF_ALL_ROUTERS)));
    expect(fake.run(ipv4.onPdu(fake.ctx, again, GI0))).toEqual([
      { type: 'drop', pdu: again, reason: 'unsupported-protocol', detail: 'ip protocol 89 has no listener', port: GI0 },
    ]);
    // unicast protocol 89 to a device without ospf keeps P1's answer: protocol unreachable
    const uni = fake.build(framed(MAC_R0, MAC_PC, hello('10.0.12.1')));
    const acts = fake.run(ipv4.onPdu(fake.ctx, uni, GI0));
    expect(acts.map((a) => a.type)).toEqual(['drop', 'request']);
    expect(icmp.requests).toMatchObject([{ kind: 'icmp.error', type: 3, code: 2, inPort: GI0 }]);
  });
});

describe('ip.ospf-plumbing: ipv4.send to a group on an interface', () => {
  it('takes the group as the next hop, so arp frames it for the group (D7)', () => {
    const { fake, ipv4, arp } = r1();
    const pdu = fake.ctx.newPdu([
      { proto: 'ipv4', fields: { src: '10.0.12.1', dst: OSPF_ALL_ROUTERS, protocol: IPPROTO_OSPF, ttl: 1, dscp: 48 } },
      { proto: 'payload', fields: { data: new Uint8Array(24) } },
    ]);
    fake.run(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.send', pdu, iface: GI0 }));
    expect(arp.requests).toMatchObject([{ kind: 'arp.sendVia', pdu, nextHop: OSPF_ALL_ROUTERS, iface: GI0 }]);
    expect(fake.debug.at(-1)!.message).toBe(`send 10.0.12.1 > 224.0.0.5 ttl 1 proto 89 out ${GI0} next hop 224.0.0.5 (multicast group)`);
    // with an explicit next hop (what the daemon sends) it is used as given
    arp.requests.length = 0;
    const p2 = fake.ctx.newPdu([
      { proto: 'ipv4', fields: { src: '10.0.12.1', dst: OSPF_ALL_ROUTERS, protocol: IPPROTO_OSPF, ttl: 1 } },
      { proto: 'payload', fields: { data: new Uint8Array(24) } },
    ]);
    fake.run(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.send', pdu: p2, iface: GI0, nextHop: OSPF_ALL_ROUTERS }));
    expect(arp.requests).toMatchObject([{ kind: 'arp.sendVia', nextHop: OSPF_ALL_ROUTERS, iface: GI0 }]);
  });
});
