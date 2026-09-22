import { describe, expect, it } from 'vitest';
import type { DeviceCatalog, DeviceModel } from '../src/contracts/device.js';
import type { PortId, ProcessName } from '../src/contracts/ids.js';
import { ETHERTYPE_IPV4, ICMP_ECHO_REQUEST, IPPROTO_ICMP, type Pdu } from '../src/contracts/pdu.js';
import type { Ipv6PortAddress, PortL3 } from '../src/contracts/port.js';
import type { Action } from '../src/contracts/process.js';
import type { RouteRow, Route6Row, SocketRow } from '../src/contracts/tables.js';
import type { SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import type { ProcessEvent } from '../src/contracts/transport.js';
import { createRng } from '../src/core/prng.js';
import { createScheduler } from '../src/core/scheduler.js';
import { createTable } from '../src/core/table.js';
import { NF_2911 } from '../src/device/catalog.js';
import { resolvePortName } from '../src/device/catalog/names.js';
import { deriveTables } from '../src/device/catalog/define.js';
import { ACTION_BUDGET, DEBUG_RING_CAPACITY, createDevice, mergePortL3, pduOf } from '../src/device/device.js';
import { SOURCE_ORIGIN_RANK6, dualStackQueryOrder, selectSource6, sourceScope6 } from '../src/device/process-ctx.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { boot, fakeProcess, harness, type FakeProcess } from './device.harness.js';

/** A booted router with two addressed, oper-up ports and a captured ctx. */
function router() {
  const arp = fakeProcess('arp');
  const ipv4 = fakeProcess('ipv4');
  const icmpv4 = fakeProcess('icmpv4');
  const h = harness({ type: 'router.nf2911', name: 'R1', processes: { arp: arp.factory, ipv4: ipv4.factory, icmpv4: icmpv4.factory } });
  boot(h);
  const at = h.device.bootedAt!;
  h.device.applyActions('ipv4', [
    { type: 'setPortL3', port: 'GigabitEthernet0/0', ipv4: { address: '10.0.0.1', prefixLen: 24 } },
    { type: 'setPortL3', port: 'GigabitEthernet0/1', ipv4: { address: '192.168.1.1', prefixLen: 24 } },
  ], at);
  h.device.port('GigabitEthernet0/0')!.operUp = true;
  h.device.port('GigabitEthernet0/1')!.operUp = true;
  const route = (network: string, prefixLen: number, over: Partial<RouteRow>): RouteRow => ({
    key: `${network}/${prefixLen}`, network, prefixLen, source: 'S', ad: 1, metric: 0, updatedAt: at, ...over,
  });
  h.device.tables.rib.set(route('10.0.0.0', 24, { source: 'C', ad: 0, iface: 'GigabitEthernet0/0' }));
  h.device.tables.rib.set(route('192.168.1.0', 24, { source: 'C', ad: 0, iface: 'GigabitEthernet0/1' }));
  h.device.tables.rib.set(route('0.0.0.0', 0, { nextHop: '10.0.0.254', isDefault: true }));
  h.device.tables.rib.set(route('172.16.0.0', 16, { nextHop: '192.168.1.2' }));
  h.device.tables.rib.set(route('172.16.5.0', 24, { nextHop: '10.0.0.9' }));
  h.device.tables.rib.set(route('10.99.0.0', 16, { nextHop: '203.0.113.1' })); // next hop on no connected port
  h.device.tables.rib.set(route('10.98.0.0', 16, { iface: 'Serial0/0/0' })); // egress port without an address
  return { h, ctx: ipv4.ctx!, arp, ipv4, at };
}

describe('ProcessCtx addressing helpers', () => {
  it('ownAddress / isLocalDestination', () => {
    const { ctx } = router();
    expect(ctx.ownAddress('10.0.0.1')).toBe('GigabitEthernet0/0');
    expect(ctx.ownAddress('192.168.1.1')).toBe('GigabitEthernet0/1');
    expect(ctx.ownAddress('10.0.0.2')).toBeUndefined();
    expect(ctx.isLocalDestination('10.0.0.1')).toBe(true);
    expect(ctx.isLocalDestination('255.255.255.255')).toBe(true);
    expect(ctx.isLocalDestination('10.0.0.255', 'GigabitEthernet0/0')).toBe(true); // directed broadcast of the ingress subnet
    expect(ctx.isLocalDestination('10.0.0.255', 'GigabitEthernet0/1')).toBe(false);
    expect(ctx.isLocalDestination('10.0.0.255')).toBe(false);
    expect(ctx.isLocalDestination('10.0.0.2', 'GigabitEthernet0/0')).toBe(false);
    expect(ctx.isLocalDestination('10.0.0.2', 'Serial0/0/0')).toBe(false);
  });

  it('isLocalDestination ignores addresses on oper-down ports; ownAddress does not', () => {
    const { h, ctx } = router();
    h.device.port('GigabitEthernet0/1')!.operUp = false;
    expect(ctx.ownAddress('192.168.1.1')).toBe('GigabitEthernet0/1');
    expect(ctx.isLocalDestination('192.168.1.1')).toBe(false);
    expect(ctx.isLocalDestination('192.168.1.255', 'GigabitEthernet0/1')).toBe(false);
    expect(ctx.isLocalDestination('10.0.0.1')).toBe(true);
  });

  it('connectedPortFor only considers oper-up ports with an address', () => {
    const { h, ctx } = router();
    expect(ctx.connectedPortFor('10.0.0.77')).toBe('GigabitEthernet0/0');
    expect(ctx.connectedPortFor('192.168.1.9')).toBe('GigabitEthernet0/1');
    expect(ctx.connectedPortFor('8.8.8.8')).toBeUndefined();
    h.device.port('GigabitEthernet0/1')!.operUp = false;
    expect(ctx.connectedPortFor('192.168.1.9')).toBeUndefined();
  });

  it('lpm returns the candidates in order and the longest-prefix winner', () => {
    const { ctx } = router();
    const r = ctx.lpm('172.16.5.7');
    expect(r.winner?.key).toBe('172.16.5.0/24');
    expect(r.candidates.map((c) => c.key)).toEqual(['172.16.5.0/24', '172.16.0.0/16', '0.0.0.0/0']);
    expect(ctx.lpm('10.0.0.5').winner?.iface).toBe('GigabitEthernet0/0');
    expect(ctx.lpm('1.2.3.4').winner?.isDefault).toBe(true);
  });

  it('sourceFor picks the egress address via connected route, next-hop route, or nothing', () => {
    const { h, ctx } = router();
    expect(ctx.sourceFor('10.0.0.5')).toEqual({ address: '10.0.0.1', iface: 'GigabitEthernet0/0' });
    expect(ctx.sourceFor('172.16.5.7')).toEqual({ address: '10.0.0.1', iface: 'GigabitEthernet0/0' }); // via 10.0.0.9
    expect(ctx.sourceFor('172.16.9.9')).toEqual({ address: '192.168.1.1', iface: 'GigabitEthernet0/1' }); // via 192.168.1.2
    expect(ctx.sourceFor('8.8.8.8')).toEqual({ address: '10.0.0.1', iface: 'GigabitEthernet0/0' }); // default via 10.0.0.254
    // P2 (D13): a next hop on no connected port resolves through its own longest match — here the default
    expect(ctx.sourceFor('10.99.1.1')).toEqual({ address: '10.0.0.1', iface: 'GigabitEthernet0/0' }); // via 203.0.113.1, via the default
    expect(ctx.sourceFor('10.98.1.1')).toBeUndefined(); // egress port has no address
    h.device.tables.rib.delete('0.0.0.0/0');
    expect(ctx.sourceFor('8.8.8.8')).toBeUndefined(); // no route
    expect(ctx.sourceFor('10.99.1.1')).toBeUndefined(); // next hop on no connected port and nothing to resolve it through
  });
});

describe('ProcessCtx PDU helpers', () => {
  it('newPdu stamps born/origin, merges meta and emits pduCreated; clone gets a fresh id with parent', () => {
    const { h, ctx, at } = router();
    h.events.length = 0;
    const p = ctx.newPdu([
      { proto: 'ipv4', fields: { src: '10.0.0.1', dst: '10.0.0.2', protocol: IPPROTO_ICMP, ttl: 255 } },
      { proto: 'icmpv4', fields: { type: ICMP_ECHO_REQUEST, code: 0, id: 1, seq: 1 } },
    ], { tag: 'ping#1', flow: 'ipv4:10.0.0.1>10.0.0.2:icmp' });
    expect(p.meta).toEqual({ born: at, origin: 'd_1', tag: 'ping#1', flow: 'ipv4:10.0.0.1>10.0.0.2:icmp' });
    expect(h.kinds('pduCreated')).toEqual([{ t: at, kind: 'pduCreated', pdu: { id: p.id, proto: 'icmpv4', size: p.size, summary: p.summary(), flow: 'ipv4:10.0.0.1>10.0.0.2:icmp', tag: 'ping#1' }, device: 'd_1', process: 'ipv4' }]);
    const c = ctx.clone(p);
    expect(c.id).toBe(p.id + 1);
    expect(c.meta.parent).toBe(p.id);
    expect(c.bytes).toEqual(p.bytes);
  });

  it('mutate and encapsulate stamp provenance with this device/time and mirror every mutation to the trace', () => {
    const { h, ctx, at } = router();
    const p = ctx.newPdu([
      { proto: 'ipv4', fields: { src: '10.0.0.1', dst: '10.0.0.2', protocol: IPPROTO_ICMP, ttl: 128 } },
      { proto: 'icmpv4', fields: { type: ICMP_ECHO_REQUEST, code: 0, id: 1, seq: 1 } },
    ]);
    h.events.length = 0;
    ctx.encapsulate(p, { proto: 'ethernet', fields: { dst: '00:1f:00:00:00:99', src: ctx.macOf('GigabitEthernet0/0'), type: ETHERTYPE_IPV4 } }, 'arp cache 10.0.0.2');
    expect(p.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'payload']);
    expect(p.provenance).toHaveLength(1);
    expect(p.provenance[0]).toMatchObject({ at, device: 'd_1', reason: 'Encapsulate', field: 'ethernet', before: null, after: 'ethernet', cause: 'arp cache 10.0.0.2' });
    ctx.mutate(p, 'ipv4.ttl', 127, 'TtlDecrement', 'ip route 0.0.0.0 0.0.0.0 10.0.0.254');
    expect(p.get('ipv4.ttl')).toBe(127);
    expect(p.provenance.map((m) => m.reason)).toEqual(['Encapsulate', 'TtlDecrement', 'ChecksumRecompute', 'FcsRecompute']);
    expect(p.provenance.every((m) => m.at === at && m.device === 'd_1')).toBe(true);
    const muts = h.kinds('mutation') as Extract<TraceEvent, { kind: 'mutation' }>[];
    expect(muts.map((m) => m.mutation)).toEqual([...p.provenance]);
    expect(muts.every((m) => m.pdu === p.id && m.t === at)).toBe(true);
  });

  it('debug appends to a bounded per-process ring and emits a debug trace event', () => {
    const { h, ctx, arp } = router();
    h.events.length = 0;
    for (let i = 0; i < DEBUG_RING_CAPACITY + 25; i++) ctx.debug('ip routing', `m${i}`);
    arp.ctx!.debug('arp', 'from-arp');
    expect(h.kinds('debug')).toHaveLength(DEBUG_RING_CAPACITY + 26);
    const recent = h.device.recentDebug(1000);
    expect(recent).toHaveLength(DEBUG_RING_CAPACITY + 1);
    expect(recent[0]?.message).toBe('m25');
    expect(recent.at(-1)?.message).toBe('from-arp');
    expect(h.device.recentDebug(2).map((e) => e.message)).toEqual([`m${DEBUG_RING_CAPACITY + 24}`, 'from-arp']);
    expect(h.device.recentDebug().length).toBe(50);
    const ev = (h.kinds('debug')[0] as Extract<TraceEvent, { kind: 'debug' }>).event;
    expect(ev).toEqual({ at: h.device.bootedAt, device: 'd_1', process: 'ipv4', category: 'ip routing', message: 'm0' });
  });

  it('now, config and ports are live views of the runtime', () => {
    const { h, ctx } = router();
    const t = h.device.bootedAt! + 4242;
    h.device.onPortOper('GigabitEthernet0/0', true, t);
    expect(ctx.now).toBe(t);
    expect(ctx.config.get('hostname')).toEqual(['R1']);
    h.device.applyConfigLine([], ['hostname', 'Core'], false);
    expect(ctx.config.get('hostname')).toEqual(['Core']);
    expect(ctx.hostname).toBe('Core');
    h.device.port('GigabitEthernet0/0')!.counters.inPackets = 3;
    expect(ctx.ports.get('GigabitEthernet0/0')?.counters.inPackets).toBe(3);
    expect(ctx.ports.get('GigabitEthernet0/0')?.l3.ipv4?.address).toBe('10.0.0.1');
    expect(ctx.tables).toBe(h.device.tables);
  });
});

// ── P1 W2: IPv6 helpers, setPortL3 merge, event action, onShutdown, extra tables ─────────────────────────────

/** A dual-stack NF-2911 variant (ipv6 + udp daemons, so the declared tables gain rib6 and sockets). */
const V6_TYPE = 'router.nf2911-dualstack-test';

/** Build a powered dual-stack router with fake daemons and boot it; returns the runtime, trace and fakes. */
function dualStack(extra: Record<ProcessName, FakeProcess> = {}) {
  const fakes: Record<ProcessName, FakeProcess> = {
    arp: fakeProcess('arp'),
    ipv4: fakeProcess('ipv4'),
    icmpv4: fakeProcess('icmpv4'),
    hdlc: fakeProcess('hdlc'),
    ipv6: fakeProcess('ipv6'),
    udp: fakeProcess('udp'),
    ...extra,
  };
  const processes: ProcessName[] = ['hdlc', 'arp', 'ipv4', 'icmpv4', 'ipv6', 'udp', ...Object.keys(extra).filter((n) => !['hdlc', 'arp', 'ipv4', 'icmpv4', 'ipv6', 'udp'].includes(n))];
  const model: DeviceModel = {
    ...NF_2911,
    tables: deriveTables(processes),
    type: V6_TYPE,
    // the P0.5 NF-2911 daemons plus ipv6 and udp: the shim entry is derived at CATALOG_STAGE ('P1') and would
    // declare the whole stack, and this test is about the two extra tables those two daemons bring.
    processes,
  };
  const catalog: DeviceCatalog = {
    get: (type) => (type === V6_TYPE ? model : undefined),
    list: () => [model],
    process: (name) => fakes[name]?.factory,
    module: () => undefined,
    modules: () => [],
    resolvePort: (source, name) => resolvePortName(source, name),
  };
  const events: TraceEvent[] = [];
  const scheduler = createScheduler();
  const transmits: { port: PortId; pdu: Pdu; now: SimTime }[] = [];
  const adminCalls: { port: PortId; adminUp: boolean; now: SimTime }[] = [];
  const device = createDevice(
    { id: 'd_6', type: V6_TYPE, name: 'R6', position: { x: 0, y: 0 }, power: true, modules: [], macSalt: 0 },
    {
      scheduler,
      trace: { emit: (ev) => events.push(ev) },
      rng: createRng(7).split('device:d_6'),
      pdus: createPduFactory(),
      catalog,
      tables: createTable,
      transmit: (from, pdu, now) => {
        transmits.push({ port: from.port, pdu, now });
        return { ok: true, link: 'l_1', txStart: now, txEnd: now + 1000, arrive: now + 2000 };
      },
      onPortAdmin: (ref, adminUp, now) => adminCalls.push({ port: ref.port, adminUp, now }),
      onPortPhyConfig: () => undefined,
      mediumOp: () => undefined,
      airView: () => ({ visibleBss: () => [], link: () => undefined }),
      cliSink: { output: () => undefined, done: () => undefined },
    },
    0,
  );
  const run = (until = Number.MAX_SAFE_INTEGER): void => {
    for (;;) {
      const t = scheduler.peekTime();
      if (t === undefined || t > until) break;
      const ev = scheduler.next();
      if (ev === undefined) break;
      if (ev.kind === 'boot') device.onBoot(ev.at);
      else if (ev.kind === 'timer') device.onTimer(ev.process, ev.key, ev.at);
    }
  };
  run(scheduler.peekTime());
  const at = device.bootedAt!;
  const g0 = 'GigabitEthernet0/0';
  const g1 = 'GigabitEthernet0/1';
  device.port(g0)!.operUp = true;
  device.port(g1)!.operUp = true;
  return { device, events, scheduler, transmits, adminCalls, fakes, ctx: fakes.ipv6!.ctx!, at, g0, g1, run };
}

const addr6 = (address: string, prefixLen: number, origin: Ipv6PortAddress['origin'], state: Ipv6PortAddress['state'] = 'preferred'): Ipv6PortAddress => ({
  address,
  prefixLen,
  scope: address.startsWith('fe80') ? 'link-local' : address.startsWith('fd') ? 'unique-local' : 'global',
  origin,
  state,
});

/**
 * Gi0/0 carries (list order): fe80::1 (link-local), a SLAAC address, 2001:db8:1::1 (manual), fd00:1::1 (ULA),
 * 2001:db8:2::1 still tentative and 2001:db8:3::1 deprecated. Gi0/1 carries only its link-local fe80::2.
 */
const G0_ADDRS: readonly Ipv6PortAddress[] = [
  addr6('fe80::1', 64, 'auto-link-local'),
  addr6('2001:db8:1:0:4e:59ff:fee8:af01', 64, 'slaac'),
  addr6('2001:db8:1::1', 64, 'manual'),
  addr6('fd00:1::1', 64, 'manual'),
  addr6('2001:db8:2::1', 64, 'manual', 'tentative'),
  addr6('2001:db8:3::1', 64, 'eui64', 'deprecated'),
];

function addressed() {
  const r = dualStack();
  r.device.applyActions('ipv6', [
    { type: 'setPortL3', port: r.g0, ipv6: G0_ADDRS, ipv6Enabled: true, groups6: ['ff02::1', 'ff02::2', 'ff02::1:ff00:1'] },
    { type: 'setPortL3', port: r.g1, ipv6: [addr6('fe80::2', 64, 'auto-link-local')], ipv6Enabled: true, groups6: ['ff02::1', 'ff02::1:ff00:2'] },
  ], r.at);
  const rib6 = r.device.tables.get<Route6Row>('rib6')!;
  const row = (network: string, prefixLen: number, over: Partial<Route6Row>): Route6Row => ({
    key: `${network}/${prefixLen}`, network, prefixLen, source: 'S', ad: 1, metric: 0, updatedAt: r.at, ...over,
  });
  rib6.set(row('2001:db8:1::', 64, { source: 'C', ad: 0, iface: r.g0 }));
  rib6.set(row('2001:db8:1::1', 128, { source: 'L', ad: 0, iface: r.g0 }));
  rib6.set(row('2001:db8:77::', 48, { nextHop: '2001:db8:1::fe' })); // recursive: next hop on Gi0/0's prefix
  rib6.set(row('2001:db8:88::', 48, { nextHop: '2001:db8:99::1' })); // next hop on no connected prefix
  rib6.set(row('2001:db8:66::', 48, { nextHop: 'fe80::fe', iface: r.g1 })); // egress with only a link-local
  rib6.set(row('fd00:1::', 64, { source: 'C', ad: 0, iface: r.g0 }));
  return { ...r, rib6, row };
}

describe('setPortL3 per-member merge (P1 W2)', () => {
  it('each member merges on its own: undefined keeps, a value replaces, null clears', () => {
    const { device, at, g0 } = dualStack();
    device.applyActions('ipv4', [{ type: 'setPortL3', port: g0, ipv4: { address: '10.0.0.1', prefixLen: 24 } }], at);
    device.applyActions('ipv6', [{ type: 'setPortL3', port: g0, ipv6: [addr6('fe80::1', 64, 'auto-link-local', 'tentative')], ipv6Enabled: true, groups6: ['ff02::1'] }], at);
    expect(device.port(g0)!.l3).toEqual({
      ipv4: { address: '10.0.0.1', prefixLen: 24 },
      ipv6: [addr6('fe80::1', 64, 'auto-link-local', 'tentative')],
      ipv6Enabled: true,
      groups6: ['ff02::1'],
    });
    // ipv4 writes leave the IPv6 members alone and vice versa
    device.applyActions('ipv4', [{ type: 'setPortL3', port: g0, ipv4: { address: '10.0.0.9', prefixLen: 8 } }], at);
    device.applyActions('ipv6', [{ type: 'setPortL3', port: g0, groups6: ['ff02::1', 'ff02::1:ff00:1'] }], at);
    const l3 = device.port(g0)!.l3;
    expect(l3.ipv4).toEqual({ address: '10.0.0.9', prefixLen: 8 });
    expect(l3.ipv6?.map((a) => a.address)).toEqual(['fe80::1']);
    expect(l3.ipv6Enabled).toBe(true);
    expect(l3.groups6).toEqual(['ff02::1', 'ff02::1:ff00:1']);
    // null clears exactly one member
    device.applyActions('ipv6', [{ type: 'setPortL3', port: g0, groups6: null }], at);
    expect(Object.keys(device.port(g0)!.l3)).toEqual(['ipv4', 'ipv6', 'ipv6Enabled']);
    device.applyActions('ipv6', [{ type: 'setPortL3', port: g0, ipv6: null, ipv6Enabled: null }], at);
    expect(device.port(g0)!.l3).toEqual({ ipv4: { address: '10.0.0.9', prefixLen: 8 } });
    device.applyActions('ipv4', [{ type: 'setPortL3', port: g0, ipv4: null }], at);
    expect(Object.keys(device.port(g0)!.l3)).toEqual([]);
  });

  it('a member-less action is a no-op (the P0 clear-ipv4 fallback went at the W8 exit gate)', () => {
    const { device, at, g0 } = dualStack();
    device.applyActions('ipv4', [{ type: 'setPortL3', port: g0, ipv4: { address: '10.0.0.1', prefixLen: 24 } }], at);
    device.applyActions('ipv6', [{ type: 'setPortL3', port: g0, ipv6: [addr6('2001:db8::1', 64, 'manual')], ipv6Enabled: true }], at);
    device.applyActions('ipv4', [{ type: 'setPortL3', port: g0 }], at);
    expect(device.port(g0)!.l3).toEqual({
      ipv4: { address: '10.0.0.1', prefixLen: 24 },
      ipv6: [addr6('2001:db8::1', 64, 'manual')],
      ipv6Enabled: true,
    });
    // clearing is explicit per member
    device.applyActions('ipv4', [{ type: 'setPortL3', port: g0, ipv4: null }], at);
    expect('ipv4' in device.port(g0)!.l3).toBe(false);
  });

  it('copies values (origin and lease end included), normalises IPv6 texts and never aliases the action', () => {
    const { device, at, g0 } = dualStack();
    const v4 = { address: '192.168.1.2', prefixLen: 24, origin: 'dhcp' as const, leaseExpiresAt: at + 86_400_000_000_000 };
    const list = [addr6('2001:DB8:0:0:0:0:0:1', 64, 'manual')];
    const groups = ['FF02:0:0:0:0:0:0:1'];
    device.applyActions('ipv4', [{ type: 'setPortL3', port: g0, ipv4: v4, ipv6: list, groups6: groups }], at);
    const l3 = device.port(g0)!.l3;
    expect(l3.ipv4).toEqual(v4);
    expect(l3.ipv4).not.toBe(v4);
    expect(l3.ipv6).toEqual([{ ...list[0], address: '2001:db8::1' }]);
    expect(l3.ipv6).not.toBe(list);
    expect(l3.groups6).toEqual(['ff02::1']);
    list[0]!.state = 'duplicate';
    expect(l3.ipv6?.[0]?.state).toBe('preferred');
    // a manual P0 address carries no optional fields (P0 snapshot bytes unchanged)
    device.applyActions('ipv4', [{ type: 'setPortL3', port: g0, ipv4: { address: '10.0.0.1', prefixLen: 24 } }], at);
    expect(Object.keys(device.port(g0)!.l3.ipv4!)).toEqual(['address', 'prefixLen']);
  });

  it('mergePortL3 is pure', () => {
    const before: PortL3 = { ipv4: { address: '10.0.0.1', prefixLen: 24 }, groups6: ['ff02::1'] };
    const copy = JSON.parse(JSON.stringify(before)) as PortL3;
    const after = mergePortL3(before, { type: 'setPortL3', port: 'x', groups6: null, ipv6Enabled: false });
    expect(before).toEqual(copy);
    expect(after).toEqual({ ipv4: { address: '10.0.0.1', prefixLen: 24 }, ipv6Enabled: false });
  });

  it('an unknown port is ignored', () => {
    const { device, at } = dualStack();
    expect(() => device.applyActions('ipv6', [{ type: 'setPortL3', port: 'Gi9/9', ipv6Enabled: true }], at)).not.toThrow();
  });
});

describe('ProcessCtx IPv6 helpers (P1 W2)', () => {
  it('lpm6 orders candidates by prefix length, AD, metric, then insertion; no rib6 or a bad address gives none', () => {
    const { ctx, rib6, row, g0 } = addressed();
    rib6.set(row('::', 0, { source: 'ND', ad: 2, nextHop: 'fe80::fe', iface: g0, isDefault: true }));
    rib6.set(row('2001:db8::', 32, { ad: 5, metric: 0 }));
    rib6.set(row('2001:db8:0::', 32, { key: 'dup-a', ad: 1, metric: 7 }));
    rib6.set(row('2001:db8::', 32, { key: 'dup-b', ad: 1, metric: 7 }));
    rib6.set(row('2001:db8::', 32, { key: 'dup-c', ad: 1, metric: 3 }));
    const r = ctx.lpm6!('2001:db8:1::77');
    expect(r.candidates.map((c) => c.key)).toEqual(['2001:db8:1::/64', 'dup-c', 'dup-a', 'dup-b', '2001:db8::/32', '::/0']);
    expect(r.winner?.key).toBe('2001:db8:1::/64');
    expect(ctx.lpm6!('2001:0DB8:0001:0000:0000:0000:0000:0001').winner?.key).toBe('2001:db8:1::1/128');
    expect(ctx.lpm6!('2001:db8:1::1').winner?.source).toBe('L');
    expect(ctx.lpm6!('3000::1').winner?.key).toBe('::/0');
    expect(ctx.lpm6!('not-an-address')).toEqual({ candidates: [] });
    const p0 = router();
    expect(p0.ctx.lpm6!('2001:db8::1')).toEqual({ candidates: [] }); // P0.5 router: no rib6 table
    expect(p0.ctx.sourceFor6!('2001:db8::1')).toBeUndefined();
  });

  it('ownAddress6 finds an address in any DAD state; isLocalDestination6 needs a preferred address on an up port', () => {
    const { device, ctx, g0, g1 } = addressed();
    expect(ctx.ownAddress6!('2001:db8:1::1')).toBe(g0);
    expect(ctx.ownAddress6!('2001:DB8:1:0::1')).toBe(g0);
    expect(ctx.ownAddress6!('2001:db8:2::1')).toBe(g0); // tentative
    expect(ctx.ownAddress6!('fe80::2')).toBe(g1);
    expect(ctx.ownAddress6!('2001:db8:1::2')).toBeUndefined();
    expect(ctx.ownAddress6!('zzz')).toBeUndefined();

    expect(ctx.isLocalDestination6!('2001:db8:1::1')).toBe(true);
    expect(ctx.isLocalDestination6!('2001:0db8:0001::0001', g1)).toBe(true); // global unicast: any up port
    expect(ctx.isLocalDestination6!('2001:db8:2::1')).toBe(false); // tentative
    expect(ctx.isLocalDestination6!('2001:db8:3::1')).toBe(false); // deprecated
    expect(ctx.isLocalDestination6!('fe80::1')).toBe(true);
    expect(ctx.isLocalDestination6!('fe80::1', g0)).toBe(true);
    expect(ctx.isLocalDestination6!('fe80::1', g1)).toBe(false); // link-local is zoned to its link
    expect(ctx.isLocalDestination6!('ff02::1:ff00:1', g0)).toBe(true);
    expect(ctx.isLocalDestination6!('ff02::1:ff00:1', g1)).toBe(false);
    expect(ctx.isLocalDestination6!('FF02::1:FF00:2')).toBe(true); // any port when omitted
    expect(ctx.isLocalDestination6!('ff02::2', g1)).toBe(false);
    expect(ctx.isLocalDestination6!('ff02::5')).toBe(false);
    expect(ctx.isLocalDestination6!('bogus')).toBe(false);
    device.port(g0)!.operUp = false;
    expect(ctx.isLocalDestination6!('2001:db8:1::1')).toBe(false);
    expect(ctx.ownAddress6!('2001:db8:1::1')).toBe(g0);
  });

  it('connectedPortFor6 uses finished on-link prefixes; link-scoped addresses need the hint', () => {
    const { device, ctx, g0, g1 } = addressed();
    expect(ctx.connectedPortFor6!('2001:db8:1::99')).toBe(g0);
    expect(ctx.connectedPortFor6!('fd00:1::42')).toBe(g0);
    expect(ctx.connectedPortFor6!('2001:db8:3::5')).toBe(g0); // deprecated still defines the prefix
    expect(ctx.connectedPortFor6!('2001:db8:2::5')).toBeUndefined(); // tentative: not on-link yet
    expect(ctx.connectedPortFor6!('2001:db8:9::5')).toBeUndefined();
    expect(ctx.connectedPortFor6!('fe80::99')).toBeUndefined();
    expect(ctx.connectedPortFor6!('fe80::99', g1)).toBe(g1);
    expect(ctx.connectedPortFor6!('ff02::1', g0)).toBe(g0);
    expect(ctx.connectedPortFor6!('2001:db8:1::99', g1)).toBe(g0); // the hint does not qualify
    device.applyActions('ipv6', [{ type: 'setPortL3', port: g1, ipv6: [addr6('fe80::2', 64, 'auto-link-local'), addr6('2001:db8:1::2', 64, 'manual')] }], device.bootedAt!);
    expect(ctx.connectedPortFor6!('2001:db8:1::99')).toBe(g0);
    expect(ctx.connectedPortFor6!('2001:db8:1::99', g1)).toBe(g1); // the hint wins when it qualifies
    device.port(g1)!.operUp = false;
    expect(ctx.connectedPortFor6!('fe80::99', g1)).toBeUndefined();
    expect(ctx.connectedPortFor6!('2001:db8:1::99', g1)).toBe(g0);
  });

  describe('sourceFor6 source-selection vectors (RFC 6724-lite, section 4.8)', () => {
    const cases: readonly { name: string; dst: string; iface?: 'g0' | 'g1'; expect: string | undefined; via?: 'g0' | 'g1' }[] = [
      { name: 'a link-local destination takes the link-local', dst: 'fe80::99', iface: 'g0', expect: 'fe80::1' },
      { name: 'ff02::1 takes the link-local', dst: 'ff02::1', iface: 'g0', expect: 'fe80::1' },
      { name: 'ff02::1:2 on the other port takes the link-local of that port', dst: 'ff02::1:2', iface: 'g1', expect: 'fe80::2' },
      { name: 'the longest common prefix wins among global candidates', dst: '2001:db8:1::99', expect: '2001:db8:1::1', via: 'g0' },
      { name: 'the SLAAC address wins when it shares the longer prefix', dst: '2001:db8:1:0:4e:59ff:fee8:af99', expect: '2001:db8:1:0:4e:59ff:fee8:af01', via: 'g0' },
      { name: 'equal prefix: origin rank puts manual before slaac despite list order', dst: '2001:db8:77::5', expect: '2001:db8:1::1', via: 'g0' },
      { name: 'same scope first: a ULA destination takes the ULA', dst: 'fd00:1::42', expect: 'fd00:1::1', via: 'g0' },
      { name: 'same scope first beats a longer prefix (global multicast)', dst: 'ff0e::1', iface: 'g0', expect: '2001:db8:1::1' },
      { name: 'site-scope multicast pairs with the ULA', dst: 'ff05::1:3', iface: 'g0', expect: 'fd00:1::1' },
      { name: 'tentative addresses never source traffic', dst: '2001:db8:2::5', iface: 'g0', expect: '2001:db8:1::1' },
      { name: 'deprecated addresses never source traffic', dst: '2001:db8:3::5', iface: 'g0', expect: '2001:db8:1::1' },
      { name: 'a route out of a port with only a link-local has no global source', dst: '2001:db8:66::1', expect: undefined },
      { name: 'forced egress with only a link-local has no global source', dst: '2001:db8:1::5', iface: 'g1', expect: undefined },
      { name: 'a recursive next hop on no connected prefix', dst: '2001:db8:88::1', expect: undefined },
      { name: 'no route at all', dst: '3000::1', expect: undefined },
      { name: 'a link-local destination without iface has no route', dst: 'fe80::99', expect: undefined },
      { name: 'non-canonical text behaves like canonical', dst: '2001:0DB8:0001:0000:0000:0000:0000:0099', expect: '2001:db8:1::1', via: 'g0' },
      { name: 'an unparsable destination', dst: '2001:db8::1::2', iface: 'g0', expect: undefined },
    ];
    for (const c of cases) {
      it(c.name, () => {
        const r = addressed();
        const port = (k: 'g0' | 'g1' | undefined): PortId | undefined => (k === undefined ? undefined : k === 'g0' ? r.g0 : r.g1);
        const got = r.ctx.sourceFor6!(c.dst, port(c.iface));
        if (c.expect === undefined) expect(got).toBeUndefined();
        else expect(got).toEqual({ address: c.expect, iface: port(c.iface ?? c.via) });
      });
    }
  });

  it('selectSource6 is pure and ranks origin manual < eui64 < slaac < dhcpv6 at equal scope and prefix', () => {
    const list = [
      addr6('2001:db8:5::d', 64, 'dhcpv6'),
      addr6('2001:db8:5::c', 64, 'slaac'),
      addr6('2001:db8:5::b', 64, 'eui64'),
    ];
    // the destination differs from all three in the first bit of the last group, so the common prefix is equal
    expect(selectSource6(list, '2001:db8:5::8000')?.address).toBe('2001:db8:5::b');
    expect(selectSource6(list.slice(0, 2), '2001:db8:5::8000')?.address).toBe('2001:db8:5::c');
    expect(selectSource6([...list, addr6('2001:db8:5::a', 64, 'manual')], '2001:db8:5::8000')?.address).toBe('2001:db8:5::a');
    // list order is the last tie-break
    expect(selectSource6([addr6('2001:db8:5::e', 64, 'manual'), addr6('2001:db8:5::f', 64, 'manual')], '2001:db8:5::8000')?.address).toBe('2001:db8:5::e');
    expect(selectSource6(list, 'fe80::1')).toBeUndefined(); // link-scoped destination, no link-local candidate
    expect(SOURCE_ORIGIN_RANK6.manual).toBeLessThan(SOURCE_ORIGIN_RANK6.eui64);
    expect(sourceScope6('ff05::2')).toBe('unique-local');
    expect(sourceScope6('ff02::2')).toBe('link-local');
    expect(sourceScope6('2001:db8::1')).toBe('global');
    expect(sourceScope6('x')).toBeUndefined();
  });

  it('dual-stack name order: AAAA first only with a preferred global/ULA address and a route', () => {
    const r = dualStack();
    expect(dualStackQueryOrder(r.ctx)).toEqual(['A', 'AAAA']);
    r.device.applyActions('ipv6', [{ type: 'setPortL3', port: r.g0, ipv6: [addr6('fe80::1', 64, 'auto-link-local'), addr6('2001:db8:1::1', 64, 'manual', 'tentative')] }], r.at);
    const rib6 = r.device.tables.get<Route6Row>('rib6')!;
    rib6.set({ key: '2001:db8:1::1/128', network: '2001:db8:1::1', prefixLen: 128, source: 'L', ad: 0, metric: 0, iface: r.g0, updatedAt: r.at });
    expect(dualStackQueryOrder(r.ctx)).toEqual(['A', 'AAAA']); // tentative only
    r.device.applyActions('ipv6', [{ type: 'setPortL3', port: r.g0, ipv6: [addr6('fe80::1', 64, 'auto-link-local'), addr6('2001:db8:1::1', 64, 'manual')] }], r.at);
    expect(dualStackQueryOrder(r.ctx)).toEqual(['A', 'AAAA']); // an L route leads nowhere else
    rib6.set({ key: 'fe80::/10', network: 'fe80::', prefixLen: 10, source: 'C', ad: 0, metric: 0, iface: r.g0, updatedAt: r.at });
    expect(dualStackQueryOrder(r.ctx)).toEqual(['A', 'AAAA']); // link scope only
    rib6.set({ key: '2001:db8:1::/64', network: '2001:db8:1::', prefixLen: 64, source: 'C', ad: 0, metric: 0, iface: r.g0, updatedAt: r.at });
    expect(dualStackQueryOrder(r.ctx)).toEqual(['AAAA', 'A']);
    expect(dualStackQueryOrder(r.ctx, '2001:db8:1::80')).toEqual(['AAAA', 'A']);
    expect(dualStackQueryOrder(r.ctx, '2001:db8:9::80')).toEqual(['A', 'AAAA']);
    r.device.port(r.g0)!.operUp = false;
    expect(dualStackQueryOrder(r.ctx)).toEqual(['A', 'AAAA']);
  });
});

describe('device runtime P1 actions and hooks (W2)', () => {
  it('the event action reaches onEvent depth-first; a missing target is only a runtime debug line', () => {
    const app = fakeProcess('dns-client');
    const seen: ProcessEvent[] = [];
    app.onEvent = (_ctx, ev) => {
      seen.push(ev);
      return [{ type: 'log', severity: 6, facility: 'T', message: 'from-event' }];
    };
    const r = dualStack({ 'dns-client': app });
    r.events.length = 0;
    const ev: ProcessEvent = { kind: 'dns.result', token: 't1', name: 'www.lab.nf', qtype: 'A', addresses: ['192.168.1.80'], rcode: 'NOERROR', fromCache: false };
    r.device.applyActions('udp', [
      { type: 'event', to: 'dns-client', ev },
      { type: 'log', severity: 6, facility: 'T', message: 'after' },
      { type: 'event', to: 'ghost', ev },
      { type: 'event', to: 'ipv4', ev }, // exists but has no onEvent
    ], r.at);
    expect(seen).toEqual([ev]);
    expect(r.events.filter((e) => e.kind === 'log').map((e) => (e as Extract<TraceEvent, { kind: 'log' }>).message)).toEqual(['from-event', 'after']);
    const debug = r.events.filter((e) => e.kind === 'debug').map((e) => (e as Extract<TraceEvent, { kind: 'debug' }>).event);
    expect(debug.map((d) => [d.process, d.category, d.message])).toEqual([
      ['udp', 'runtime', 'event dns.result ignored: no process ghost'],
      ['udp', 'runtime', 'event dns.result ignored: no process ipv4'],
    ]);
    expect(r.events.some((e) => e.kind === 'drop')).toBe(false);
  });

  it('pduOf finds the pdu of P1 send and error requests (budget-exhaustion drops)', () => {
    const r = dualStack();
    const pdu = r.ctx.newPdu([{ proto: 'ethernet', fields: { dst: 'ff:ff:ff:ff:ff:ff', src: r.ctx.macOf(r.g0), type: ETHERTYPE_IPV4 } }]);
    expect(pduOf({ type: 'request', to: 'ipv6', req: { kind: 'ipv6.send', pdu } })).toBe(pdu);
    expect(pduOf({ type: 'request', to: 'nd', req: { kind: 'nd.sendVia', pdu, nextHop: 'fe80::1', iface: r.g0 } })).toBe(pdu);
    expect(pduOf({ type: 'request', to: 'icmpv6', req: { kind: 'icmp6.error', original: pdu, type: 1, code: 4 } })).toBe(pdu);
    expect(pduOf({ type: 'request', to: 'icmpv4', req: { kind: 'icmp.error', original: pdu, type: 3, code: 3 } })).toBe(pdu);
    expect(pduOf({ type: 'request', to: 'udp', req: { kind: 'udp.close', socket: 'x#1' } })).toBeUndefined();
    expect(pduOf({ type: 'event', to: 'x', ev: { kind: 'sock.data', socket: 's', data: new Uint8Array(0), pdu } })).toBeUndefined();
    expect(pduOf({ type: 'send', port: r.g0, pdu })).toBe(pdu);
  });

  it('an exhausted action budget drops the pdu of a pending ipv6.send', () => {
    const r = dualStack();
    const pdu = r.ctx.newPdu([{ proto: 'ethernet', fields: { dst: 'ff:ff:ff:ff:ff:ff', src: r.ctx.macOf(r.g0), type: ETHERTYPE_IPV4 } }]);
    const logs: Action[] = [];
    for (let i = 0; i < ACTION_BUDGET; i++) logs.push({ type: 'log', severity: 7, facility: 'T', message: `n${i}` });
    r.events.length = 0;
    r.device.applyActions('ipv6', [...logs, { type: 'request', to: 'ipv6', req: { kind: 'ipv6.send', pdu } }], r.at);
    const drops = r.events.filter((e) => e.kind === 'drop') as Extract<TraceEvent, { kind: 'drop' }>[];
    expect(drops.map((d) => [d.pdu.id, d.reason, d.detail])).toEqual([[pdu.id, 'other', 'action-budget']]);
  });

  it('onShutdown runs in daemon order at power-off and reload, before RAM is lost; its sends leave while the ports are up', () => {
    const calls: string[] = [];
    const client = fakeProcess('dhcp-client');
    const r = dualStack({ 'dhcp-client': client });
    let rib6Rows = -1;
    let adminCallsAtShutdown = -1;
    client.onShutdown = (ctx) => {
      calls.push(`dhcp-client@${ctx.now}`);
      rib6Rows = ctx.tables.get('rib6')!.size;
      adminCallsAtShutdown = r.adminCalls.length;
      const release = ctx.newPdu([{ proto: 'ethernet', fields: { dst: '02:00:00:00:00:fe', src: ctx.macOf(r.g0), type: ETHERTYPE_IPV4 } }], { tag: 'dhcp-release' });
      return [
        { type: 'send', port: r.g0, pdu: release },
        { type: 'timer', key: 'never', delay: 1_000_000 },
        { type: 'log', severity: 6, facility: 'DHCP', message: 'released' },
      ];
    };
    r.fakes.ipv6!.onShutdown = (ctx) => {
      calls.push(`ipv6@${ctx.now}`);
      return [];
    };
    r.device.tables.get<Route6Row>('rib6')!.set({ key: '::/0', network: '::', prefixLen: 0, source: 'ND', ad: 2, metric: 0, updatedAt: r.at });
    const adminBefore = r.adminCalls.length;
    r.events.length = 0;
    const off = r.at + 10;
    r.device.setPower(false, off);
    // daemon order: ipv6 and udp are listed before dhcp-client
    expect(calls).toEqual([`ipv6@${off}`, `dhcp-client@${off}`]);
    expect(rib6Rows).toBe(1); // RAM still intact while shutting down
    expect(adminCallsAtShutdown).toBe(adminBefore); // the links are told only afterwards
    expect(r.adminCalls.length).toBeGreaterThan(adminBefore);
    expect(r.transmits.map((t) => [t.port, t.pdu.meta.tag, t.now])).toEqual([[r.g0, 'dhcp-release', off]]);
    expect(r.events.some((e) => e.kind === 'log' && e.message === 'released')).toBe(true);
    const kinds = r.events.map((e) => e.kind);
    expect(kinds.indexOf('pduCreated')).toBeLessThan(kinds.indexOf('deviceState'));
    // the timer armed during shutdown was cancelled with every other timer; the tables were cleared
    r.run();
    expect(client.calls.some((c) => c.kind === 'onTimer')).toBe(false);
    expect(r.device.tables.get('rib6')!.size).toBe(0);

    // powering off again (already off) calls nothing; a reload of a booted device does
    r.device.setPower(false, off + 1);
    expect(calls).toHaveLength(2);
    r.device.setPower(true, off + 2);
    r.run(r.scheduler.peekTime());
    calls.length = 0;
    const t = r.device.bootedAt! + 5;
    r.device.reload(t);
    expect(calls).toEqual([`ipv6@${t}`, `dhcp-client@${t}`]);
  });

  it('onShutdown only runs while daemons exist (a boot cancelled by power-off has none)', () => {
    const client = fakeProcess('dhcp-client');
    let called = 0;
    client.onShutdown = () => {
      called++;
      return [];
    };
    const r = dualStack({ 'dhcp-client': client });
    r.device.setPower(false, r.at + 1);
    expect(called).toBe(1);
    r.device.setPower(true, r.at + 2); // boot pending
    r.device.setPower(false, r.at + 3); // cancelled before boot
    expect(called).toBe(1);
  });

  it('extra tables: the declared set follows the daemons (rib6, sockets) and power-off clears them', () => {
    const r = dualStack();
    expect(r.device.tables.names()).toEqual(['cam', 'arp', 'rib', 'rib6', 'sockets']);
    const sockets = r.device.tables.get<SocketRow>('sockets')!;
    sockets.set({ key: 'udp|x#1', id: 'x#1', proto: 'udp', family: 4, localAddr: '0.0.0.0', localPort: 68, state: 'BOUND', owner: 'dhcp-client', updatedAt: r.at });
    expect(r.ctx.tables.get('sockets')).toBe(sockets);
    expect(sockets.rows()).toHaveLength(1);
    r.events.length = 0;
    r.device.setPower(false, r.at + 1);
    expect(sockets.size).toBe(0);
    const expired = r.events.filter((e) => e.kind === 'tableExpire').map((e) => (e as Extract<TraceEvent, { kind: 'tableExpire' }>).table);
    expect(expired).toEqual(['sockets']);
  });
});
