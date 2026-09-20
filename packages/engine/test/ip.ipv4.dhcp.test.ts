/**
 * ipv4 — DHCP-managed ports, leases, forced-egress sends and RIB arbitration (ARCHITECTURE-P1 §4.2, §4.3, §10.2
 * accept.p1.dhcp-dora RIB expectations). RFC 2131 §4.1 (a client without an address sends from 0.0.0.0 to the
 * limited broadcast 255.255.255.255), RFC 1122 §3.3.6 (limited broadcasts are never forwarded nor routed), RFC 3927
 * (APIPA 169.254/16 without a router).
 */
import { describe, expect, it } from 'vitest';
import { MAC_BROADCAST } from '../src/contracts/addr.js';
import type { ConfigDelta } from '../src/contracts/config.js';
import type { Action } from '../src/contracts/process.js';
import { AD_DHCP } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createArp } from '../src/protocols/arp.js';
import { createHost } from '../src/protocols/host.js';
import { LEASE_ROUTE_OWNER, createIpv4, routeCause } from '../src/protocols/ipv4.js';
import { framed, makeFake, makeSink } from './ip.fake-ctx.js';

const GI0 = 'GigabitEthernet0';
const MAC_PC = '00:1f:00:00:00:01';
const MAC_R1 = '00:1f:00:00:00:10';
const LEASE_END = 86_400 * SEC;

const ipDhcp = (port = GI0): ConfigDelta => ({ op: 'set', context: [['interface', port]], line: ['ip', 'address', 'dhcp'] });
const noIpAddress = (port = GI0): ConfigDelta => ({ op: 'unset', context: [['interface', port]], line: ['ip', 'address'] });
const setAddr = (a: string, m: string, port = GI0): ConfigDelta => ({ op: 'set', context: [['interface', port]], line: ['ip', 'address', a, m] });
const gateway = (gw: string): ConfigDelta => ({ op: 'set', context: [], line: ['ip', 'default-gateway', gw] });
const noGateway: ConfigDelta = { op: 'unset', context: [], line: ['ip', 'default-gateway'] };

/** A PC (P1 model: udp, tcp and dhcp-client run) with ipv4, host, an arp sink and a udp sink. */
function pc(opts: { stage?: 'P0.5' | 'P1'; up?: boolean } = {}) {
  const fake = makeFake({ kind: 'pc', stage: opts.stage ?? 'P1', ports: [{ id: GI0, mac: MAC_PC, operUp: opts.up ?? true }] });
  const ipv4 = createIpv4();
  const host = createHost();
  const arp = makeSink('arp');
  const udp = makeSink('udp');
  for (const p of [ipv4, host, arp, udp]) fake.register(p);
  return { fake, ipv4, host, arp, udp };
}

/** Bind the standard lease 192.168.1.2/24 via 192.168.1.1. */
function bind(fake: ReturnType<typeof pc>['fake'], ipv4: ReturnType<typeof createIpv4>, extra: Partial<{ address: string; prefixLen: number; router: string; origin: 'dhcp' | 'apipa'; leaseExpiresAt: number }> = {}): Action[] {
  return fake.run(ipv4.onRequest!(fake.ctx, {
    kind: 'ipv4.lease',
    op: 'bind',
    iface: GI0,
    address: extra.address ?? '192.168.1.2',
    prefixLen: extra.prefixLen ?? 24,
    ...(extra.origin === 'apipa' ? {} : { router: extra.router ?? '192.168.1.1', server: '192.168.1.1' }),
    leaseExpiresAt: extra.leaseExpiresAt ?? LEASE_END,
    origin: extra.origin ?? 'dhcp',
  }));
}

const ribKeys = (fake: ReturnType<typeof pc>['fake']) => fake.tables.rib.rows().map((r) => `${r.source} ${r.key}`);
const ribEvents = (trace: TraceEvent[]) =>
  trace.flatMap((e) => (e.kind === 'tableWrite' && e.table === 'rib' ? [`write ${e.key}`] : e.kind === 'tableExpire' && e.table === 'rib' ? [`expire ${e.key} ${e.reason}`] : []));

describe('ipv4: ip address dhcp', () => {
  it('clears a static address (setPortL3 ipv4: null), withdraws its routes and marks the port DHCP-managed', () => {
    const { fake, ipv4 } = pc();
    fake.run(ipv4.onConfig(fake.ctx, setAddr('10.0.0.5', '255.255.255.0')));
    expect(ribKeys(fake)).toEqual(['C 10.0.0.0/24', 'L 10.0.0.5/32']);
    const actions = fake.run(ipv4.onConfig(fake.ctx, ipDhcp()));
    expect(actions).toEqual([{ type: 'setPortL3', port: GI0, ipv4: null }]);
    expect(fake.ctx.ports.get(GI0)!.l3.ipv4).toBeUndefined();
    expect(fake.tables.rib.size).toBe(0);
    expect(ribEvents(fake.trace).slice(-2)).toEqual(['expire 10.0.0.0/24 replaced', 'expire 10.0.0.5/32 replaced']);
    expect(ipv4.stateSnapshot().state).toMatchObject({ interfaces: [], dhcp: [GI0] });
    // replaying the line changes nothing more
    expect(ipv4.onConfig(fake.ctx, ipDhcp())).toEqual([{ type: 'setPortL3', port: GI0, ipv4: null }]);
    expect(ipv4.stateSnapshot().state).toMatchObject({ dhcp: [GI0] });
  });

  it('init picks up `ip address dhcp` from the running config', () => {
    const { fake, ipv4 } = pc();
    fake.ctx.config.set([['interface', GI0]], ['ip', 'address', 'dhcp']);
    fake.run(ipv4.init!(fake.ctx));
    expect(ipv4.stateSnapshot().state).toMatchObject({ interfaces: [], dhcp: [GI0] });
    expect(fake.tables.rib.size).toBe(0);
  });
});

describe('ipv4.send with a forced egress interface (§4.2)', () => {
  it('sends a DHCP DISCOVER from 0.0.0.0 to 255.255.255.255 out the interface as an Ethernet broadcast, with no route at all', () => {
    const fake = makeFake({ kind: 'pc', stage: 'P1', ports: [{ id: GI0, mac: MAC_PC }] });
    const ipv4 = createIpv4();
    const arp = createArp();
    fake.register(ipv4);
    fake.register(arp);
    fake.run(ipv4.onConfig(fake.ctx, ipDhcp()));
    expect(fake.tables.rib.size).toBe(0);
    const pdu = fake.ctx.newPdu([
      { proto: 'ipv4', fields: { src: '0.0.0.0', dst: '255.255.255.255', protocol: 17, ttl: 128 } },
      { proto: 'udp', fields: { srcPort: 68, dstPort: 67 } },
      { proto: 'payload', fields: { data: new Uint8Array(8) } },
    ], { tag: 'dhcp-discover' });
    const out = fake.run(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.send', pdu, iface: GI0, cause: 'dhcp discover' }));
    expect(out).toEqual([{ type: 'request', to: 'arp', req: { kind: 'arp.sendVia', pdu, nextHop: '255.255.255.255', iface: GI0, cause: 'dhcp discover' } }]);
    const sends = fake.actionsOf('send');
    expect(sends).toHaveLength(1);
    expect(sends[0]!.port).toBe(GI0);
    expect(sends[0]!.pdu.id).toBe(pdu.id);
    // framed in place (same pdu), Ethernet outermost; the port-67 payload decodes per the UDP dispatch table
    expect(pdu.layers.map((l) => l.proto).slice(0, 3)).toEqual(['ethernet', 'ipv4', 'udp']);
    expect(pdu.get('ethernet.dst')).toBe(MAC_BROADCAST);
    expect(pdu.get('ethernet.src')).toBe(MAC_PC);
    expect(pdu.get('ipv4.src')).toBe('0.0.0.0');
    expect(pdu.get('ipv4.ttl')).toBe(128);
    expect(ipv4.stateSnapshot().state).toMatchObject({ sent: 1, dropped: 0 });
  });

  it('source 0.0.0.0 without an interface and a limited broadcast without an interface are dropped', () => {
    const { fake, ipv4, arp } = pc();
    const zero = fake.ctx.newPdu([{ proto: 'ipv4', fields: { src: '0.0.0.0', dst: '192.168.1.1', protocol: 17, ttl: 128 } }]);
    expect(fake.run(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.send', pdu: zero }))).toEqual([
      { type: 'drop', pdu: zero, reason: 'no-l3-address', detail: 'source 0.0.0.0 needs an egress interface' },
    ]);
    bind(fake, ipv4);
    const bcast = fake.ctx.newPdu([{ proto: 'ipv4', fields: { src: '192.168.1.2', dst: '255.255.255.255', protocol: 17, ttl: 128 } }]);
    expect(fake.run(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.send', pdu: bcast }))).toEqual([
      { type: 'drop', pdu: bcast, reason: 'no-route', detail: 'limited broadcast needs an egress interface' },
    ]);
    expect(arp.requests.filter((r) => r.kind === 'arp.sendVia')).toEqual([]);
  });

  it('picks the next hop without LPM: given next hop, directed broadcast / on-link destination, gateway out of that interface, else no-route', () => {
    const { fake, ipv4, arp } = pc();
    const send = (dst: string, extra: { nextHop?: string } = {}) => {
      const pdu = fake.ctx.newPdu([{ proto: 'ipv4', fields: { src: '192.168.1.2', dst, protocol: 17, ttl: 128 } }]);
      return { pdu, out: fake.run(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.send', pdu, iface: GI0, ...extra })) };
    };
    // no address yet: only an explicit next hop works for a unicast
    expect(send('192.168.1.1').out[0]).toMatchObject({ type: 'drop', reason: 'no-route', detail: `no gateway for 192.168.1.1 on ${GI0}` });
    expect(send('192.168.1.1', { nextHop: '192.168.1.1' }).out[0]).toMatchObject({ type: 'request', req: { kind: 'arp.sendVia', nextHop: '192.168.1.1', iface: GI0, cause: `sent out ${GI0}` } });
    bind(fake, ipv4);
    arp.requests.length = 0;
    send('192.168.1.1');
    send('192.168.1.255');
    send('8.8.8.8');
    expect(arp.requests.map((r) => (r.kind === 'arp.sendVia' ? r.nextHop : r.kind))).toEqual(['192.168.1.1', '192.168.1.255', '192.168.1.1']);
    expect(fake.debug.at(-1)!.message).toContain('(dhcp default route via 192.168.1.1)');
  });
});

describe('ipv4.lease (§4.3 step 6)', () => {
  it('bind applies the address with origin and lease end, installs C, L and D (AD 254 via the router) and announces it', () => {
    const { fake, ipv4, arp } = pc();
    fake.run(ipv4.onConfig(fake.ctx, ipDhcp()));
    fake.setNow(5 * SEC);
    const out = bind(fake, ipv4);
    expect(out).toEqual([
      { type: 'setPortL3', port: GI0, ipv4: { address: '192.168.1.2', prefixLen: 24, origin: 'dhcp', leaseExpiresAt: LEASE_END } },
      { type: 'request', to: 'arp', req: { kind: 'arp.gratuitous', iface: GI0 } },
    ]);
    expect(fake.ctx.ports.get(GI0)!.l3.ipv4).toEqual({ address: '192.168.1.2', prefixLen: 24, origin: 'dhcp', leaseExpiresAt: LEASE_END });
    expect(arp.requests).toEqual([{ kind: 'arp.gratuitous', iface: GI0 }]);
    expect(ribKeys(fake)).toEqual(['C 192.168.1.0/24', 'L 192.168.1.2/32', 'D 0.0.0.0/0']);
    const d = fake.tables.rib.get('0.0.0.0/0')!;
    expect(d).toEqual({
      key: '0.0.0.0/0', network: '0.0.0.0', prefixLen: 0, source: 'D', nextHop: '192.168.1.1', iface: GI0,
      ad: AD_DHCP, metric: 0, isDefault: true, updatedAt: 5 * SEC, owner: LEASE_ROUTE_OWNER,
    });
    expect(d.ad).toBe(254);
    expect(routeCause(d)).toBe('dhcp default route via 192.168.1.1');
    // C and L rows keep the P0 shape (no owner)
    expect(fake.tables.rib.get('192.168.1.0/24')!.owner).toBeUndefined();
    expect(fake.ctx.lpm('8.8.8.8').winner).toMatchObject({ source: 'D', nextHop: '192.168.1.1' });
    expect(fake.ctx.sourceFor('8.8.8.8')).toEqual({ address: '192.168.1.2', iface: GI0 });
    expect(ipv4.stateSnapshot().state).toMatchObject({
      interfaces: [{ port: GI0, address: '192.168.1.2', prefixLen: 24, installed: true, origin: 'dhcp', router: '192.168.1.1', leaseExpiresAt: LEASE_END, server: '192.168.1.1' }],
      dhcp: [GI0],
    });
  });

  it('a static ip default-gateway (S, AD 1) replaces the DHCP default, and removing it restores D', () => {
    const { fake, ipv4, host } = pc();
    fake.run(ipv4.onConfig(fake.ctx, ipDhcp()));
    bind(fake, ipv4);
    fake.setNow(10 * SEC);
    fake.run(host.onConfig(fake.ctx, gateway('192.168.1.254')));
    expect(fake.tables.rib.get('0.0.0.0/0')).toMatchObject({ source: 'S', nextHop: '192.168.1.254', ad: 1, owner: 'host', updatedAt: 10 * SEC });
    expect(routeCause(fake.tables.rib.get('0.0.0.0/0')!)).toBe('ip default-gateway 192.168.1.254');
    expect(fake.debug.at(-1)!.message).toBe('default gateway changed from 192.168.1.1 to 192.168.1.254');
    fake.setNow(20 * SEC);
    fake.run(host.onConfig(fake.ctx, noGateway));
    expect(fake.tables.rib.get('0.0.0.0/0')).toMatchObject({ source: 'D', nextHop: '192.168.1.1', ad: AD_DHCP, owner: LEASE_ROUTE_OWNER, updatedAt: 20 * SEC });
    expect(fake.debug.slice(-2).map((d) => d.message)).toEqual([
      'default gateway removed: default route via 192.168.1.254 withdrawn',
      'default route now dhcp default route via 192.168.1.1',
    ]);
    // the key was rewritten each time, never left empty in between
    expect(ribEvents(fake.trace).filter((e) => e.includes('0.0.0.0/0'))).toEqual(['write 0.0.0.0/0', 'write 0.0.0.0/0', 'write 0.0.0.0/0']);
  });

  it('a lease learned while ip default-gateway is set keeps D as a candidate until the gateway goes', () => {
    const { fake, ipv4, host } = pc();
    fake.run(host.onConfig(fake.ctx, gateway('192.168.1.254')));
    fake.run(ipv4.onConfig(fake.ctx, ipDhcp()));
    bind(fake, ipv4);
    expect(fake.tables.rib.get('0.0.0.0/0')).toMatchObject({ source: 'S', owner: 'host' });
    expect(fake.debug.some((d) => d.message === 'D 0.0.0.0/0 via 192.168.1.1 kept as a candidate: ip default-gateway 192.168.1.254 is preferred')).toBe(true);
    fake.run(host.onConfig(fake.ctx, noGateway));
    expect(fake.tables.rib.get('0.0.0.0/0')).toMatchObject({ source: 'D', nextHop: '192.168.1.1' });
  });

  it('link down withdraws C, L and D (link-down); link up installs them again', () => {
    const { fake, ipv4 } = pc();
    fake.run(ipv4.onConfig(fake.ctx, ipDhcp()));
    bind(fake, ipv4);
    fake.setOper(GI0, false);
    fake.run(ipv4.onLinkChange!(fake.ctx, GI0, false));
    expect(fake.tables.rib.size).toBe(0);
    expect(ribEvents(fake.trace).slice(-3)).toEqual(['expire 192.168.1.0/24 link-down', 'expire 192.168.1.2/32 link-down', 'expire 0.0.0.0/0 link-down']);
    fake.setOper(GI0, true);
    fake.run(ipv4.onLinkChange!(fake.ctx, GI0, true));
    expect(ribKeys(fake)).toEqual(['C 192.168.1.0/24', 'L 192.168.1.2/32', 'D 0.0.0.0/0']);
  });

  it('a bind while the port is down applies the address and defers the routes', () => {
    const { fake, ipv4, arp } = pc({ up: false });
    fake.run(ipv4.onConfig(fake.ctx, ipDhcp()));
    const out = bind(fake, ipv4);
    expect(out).toEqual([{ type: 'setPortL3', port: GI0, ipv4: { address: '192.168.1.2', prefixLen: 24, origin: 'dhcp', leaseExpiresAt: LEASE_END } }]);
    expect(fake.tables.rib.size).toBe(0);
    expect(arp.requests).toEqual([]);
  });

  it('renewing the same lease only moves the lease end (no route churn, no announcement)', () => {
    const { fake, ipv4, arp } = pc();
    fake.run(ipv4.onConfig(fake.ctx, ipDhcp()));
    bind(fake, ipv4);
    const before = ribEvents(fake.trace).length;
    arp.requests.length = 0;
    const out = bind(fake, ipv4, { leaseExpiresAt: 2 * LEASE_END });
    expect(out).toEqual([{ type: 'setPortL3', port: GI0, ipv4: { address: '192.168.1.2', prefixLen: 24, origin: 'dhcp', leaseExpiresAt: 2 * LEASE_END } }]);
    expect(ribEvents(fake.trace)).toHaveLength(before);
    expect(arp.requests).toEqual([]);
    expect(ipv4.stateSnapshot().state).toMatchObject({ interfaces: [{ leaseExpiresAt: 2 * LEASE_END }] });
  });

  it('a new lease address replaces the old one (replaced), and unbind withdraws everything (cleared)', () => {
    const { fake, ipv4 } = pc();
    fake.run(ipv4.onConfig(fake.ctx, ipDhcp()));
    bind(fake, ipv4);
    bind(fake, ipv4, { address: '192.168.1.9' });
    expect(ribEvents(fake.trace).filter((e) => e.startsWith('expire'))).toEqual([
      'expire 192.168.1.0/24 replaced', 'expire 192.168.1.2/32 replaced', 'expire 0.0.0.0/0 replaced',
    ]);
    expect(ribKeys(fake)).toEqual(['C 192.168.1.0/24', 'L 192.168.1.9/32', 'D 0.0.0.0/0']);
    // a release for an address we do not hold is ignored
    expect(fake.run(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.lease', op: 'unbind', iface: GI0, address: '192.168.1.2' }))).toEqual([]);
    expect(fake.tables.rib.size).toBe(3);
    const out = fake.run(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.lease', op: 'unbind', iface: GI0, address: '192.168.1.9' }));
    expect(out).toEqual([{ type: 'setPortL3', port: GI0, ipv4: null }]);
    expect(fake.tables.rib.size).toBe(0);
    expect(fake.ctx.ports.get(GI0)!.l3.ipv4).toBeUndefined();
    expect(ipv4.stateSnapshot().state).toMatchObject({ interfaces: [], dhcp: [GI0] });
  });

  it('APIPA: 169.254.x.y/16 without a router (no D); a later DHCP lease replaces it', () => {
    const { fake, ipv4, arp } = pc();
    fake.run(ipv4.onConfig(fake.ctx, ipDhcp()));
    const out = bind(fake, ipv4, { address: '169.254.17.3', prefixLen: 16, origin: 'apipa' });
    expect(out[0]).toEqual({ type: 'setPortL3', port: GI0, ipv4: { address: '169.254.17.3', prefixLen: 16, origin: 'apipa', leaseExpiresAt: LEASE_END } });
    expect(ribKeys(fake)).toEqual(['C 169.254.0.0/16', 'L 169.254.17.3/32']);
    expect(arp.requests).toEqual([{ kind: 'arp.gratuitous', iface: GI0 }]);
    // a router passed with an APIPA bind is ignored (RFC 3927: link-local only)
    const withRouter = fake.run(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.lease', op: 'bind', iface: GI0, address: '169.254.17.4', prefixLen: 16, router: '169.254.0.1', origin: 'apipa' }));
    expect(withRouter[0]).toEqual({ type: 'setPortL3', port: GI0, ipv4: { address: '169.254.17.4', prefixLen: 16, origin: 'apipa' } });
    expect(fake.tables.rib.has('0.0.0.0/0')).toBe(false);
    bind(fake, ipv4);
    expect(ribKeys(fake)).toEqual(['C 192.168.1.0/24', 'L 192.168.1.2/32', 'D 0.0.0.0/0']);
    expect(fake.ctx.ports.get(GI0)!.l3.ipv4).toMatchObject({ address: '192.168.1.2', origin: 'dhcp' });
  });

  it('ignores a lease for an interface with a static address, an unknown interface or a bad address', () => {
    const { fake, ipv4 } = pc();
    fake.run(ipv4.onConfig(fake.ctx, setAddr('10.0.0.5', '255.255.255.0')));
    expect(bind(fake, ipv4)).toEqual([]);
    expect(fake.run(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.lease', op: 'bind', iface: 'Nope0', address: '192.168.1.2', prefixLen: 24 }))).toEqual([]);
    expect(fake.run(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.lease', op: 'bind', iface: GI0, address: 'x', prefixLen: 24 }))).toEqual([]);
    expect(ribKeys(fake)).toEqual(['C 10.0.0.0/24', 'L 10.0.0.5/32']);
  });

  it('no ip address on a leased port leaves the lease to dhcp-client (it releases first); without dhcp-client it is dropped', () => {
    const p1 = pc({ stage: 'P1' });
    p1.fake.run(p1.ipv4.onConfig(p1.fake.ctx, ipDhcp()));
    bind(p1.fake, p1.ipv4);
    expect(p1.fake.ctx.model.processes).toContain('dhcp-client');
    expect(p1.fake.run(p1.ipv4.onConfig(p1.fake.ctx, noIpAddress()))).toEqual([]);
    expect(p1.fake.tables.rib.size).toBe(3);
    // the RELEASE can still leave from the leased address, by LPM
    const release = p1.fake.ctx.newPdu([{ proto: 'ipv4', fields: { src: '192.168.1.2', dst: '192.168.1.1', protocol: 17, ttl: 128 } }]);
    expect(p1.fake.run(p1.ipv4.onRequest!(p1.fake.ctx, { kind: 'ipv4.send', pdu: release }))[0]).toMatchObject({ type: 'request', req: { kind: 'arp.sendVia', nextHop: '192.168.1.1' } });
    expect(p1.ipv4.stateSnapshot().state.dhcp).toBeUndefined();
    p1.fake.run(p1.ipv4.onRequest!(p1.fake.ctx, { kind: 'ipv4.lease', op: 'unbind', iface: GI0 }));
    expect(p1.fake.tables.rib.size).toBe(0);

    const p05 = pc({ stage: 'P0.5' });
    expect(p05.fake.ctx.model.processes).not.toContain('dhcp-client');
    p05.fake.run(p05.ipv4.onConfig(p05.fake.ctx, ipDhcp()));
    bind(p05.fake, p05.ipv4);
    expect(p05.fake.run(p05.ipv4.onConfig(p05.fake.ctx, noIpAddress()))).toEqual([{ type: 'setPortL3', port: GI0, ipv4: null }]);
    expect(p05.fake.tables.rib.size).toBe(0);
  });

  it('a static ip address replaces the lease and ends DHCP management', () => {
    const { fake, ipv4 } = pc();
    fake.run(ipv4.onConfig(fake.ctx, ipDhcp()));
    bind(fake, ipv4);
    const out = fake.run(ipv4.onConfig(fake.ctx, setAddr('10.0.0.5', '255.255.255.0')));
    expect(out[0]).toEqual({ type: 'setPortL3', port: GI0, ipv4: { address: '10.0.0.5', prefixLen: 24 } });
    expect(ribKeys(fake)).toEqual(['C 10.0.0.0/24', 'L 10.0.0.5/32']);
    expect(ipv4.stateSnapshot().state.dhcp).toBeUndefined();
    // dhcp-client's late unbind finds no lease and changes nothing
    expect(fake.run(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.lease', op: 'unbind', iface: GI0 }))).toEqual([]);
    expect(ribKeys(fake)).toEqual(['C 10.0.0.0/24', 'L 10.0.0.5/32']);
  });
});

describe('ipv4 receive on a DHCP client', () => {
  it('delivers a broadcast OFFER to udp while the port has no address yet', () => {
    const { fake, ipv4, udp } = pc();
    fake.run(ipv4.onConfig(fake.ctx, ipDhcp()));
    const offer = fake.build(framed(MAC_BROADCAST, MAC_R1, [
      { proto: 'ipv4', fields: { src: '192.168.1.1', dst: '255.255.255.255', protocol: 17, ttl: 255 } },
      { proto: 'udp', fields: { srcPort: 67, dstPort: 68 } },
      { proto: 'payload', fields: { data: new Uint8Array(8) } },
    ]));
    expect(fake.run(ipv4.onPdu(fake.ctx, offer, GI0))).toEqual([{ type: 'deliver', to: 'udp', pdu: offer, port: GI0 }]);
    expect(udp.pdus).toEqual([offer]);
  });
});
