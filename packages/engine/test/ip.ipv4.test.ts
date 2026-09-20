import { describe, expect, it } from 'vitest';
import { L3_ROLES } from '../src/contracts/catalog.js';
import { ETHERTYPE_IPV4, HDLC_PROTO_IPV4, ICMP_DEST_UNREACHABLE, ICMP_TIME_EXCEEDED } from '../src/contracts/pdu.js';
import type { ConfigDelta } from '../src/contracts/config.js';
import { createIpv4, routeCause } from '../src/protocols/ipv4.js';
import { echoRequest, framed, makeFake, makeSink } from './ip.fake-ctx.js';

const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';
const MAC_R0 = '00:1f:00:00:00:10';
const MAC_R1 = '00:1f:00:00:00:11';
const MAC_PC = '00:1f:00:00:00:01';

const setAddr = (port: string, a: string, m: string): ConfigDelta => ({ op: 'set', context: [['interface', port]], line: ['ip', 'address', a, m] });
const unsetAddr = (port: string): ConfigDelta => ({ op: 'unset', context: [['interface', port]], line: ['ip', 'address'] });
const setRoute = (n: string, m: string, via: string): ConfigDelta => ({ op: 'set', context: [], line: ['ip', 'route', n, m, via] });
const unsetRoute = (n: string, m: string, via: string): ConfigDelta => ({ op: 'unset', context: [], line: ['ip', 'route', n, m, via] });

/** A router with two addressed, up ports and its connected routes installed through config. */
function router() {
  const fake = makeFake({ kind: 'router', ports: [{ id: GI0, mac: MAC_R0 }, { id: GI1, mac: MAC_R1 }] });
  const ipv4 = createIpv4();
  const arp = makeSink('arp');
  const icmp = makeSink('icmpv4');
  fake.register(ipv4);
  fake.register(arp);
  fake.register(icmp);
  fake.run(ipv4.onConfig(fake.ctx, setAddr(GI0, '10.0.0.1', '255.255.255.0')));
  fake.run(ipv4.onConfig(fake.ctx, setAddr(GI1, '10.0.1.1', '255.255.255.0')));
  expect(arp.requests).toEqual([{ kind: 'arp.gratuitous', iface: GI0 }, { kind: 'arp.gratuitous', iface: GI1 }]);
  arp.requests.length = 0; // forget the gratuitous ARPs from address configuration
  return { fake, ipv4, arp, icmp };
}

describe('ipv4 address configuration', () => {
  it('sets port L3 state and installs C/L rows only while the port is oper-up', () => {
    const fake = makeFake({ kind: 'router', ports: [{ id: GI0, mac: MAC_R0, operUp: false }] });
    const ipv4 = createIpv4();
    const actions = fake.run(ipv4.onConfig(fake.ctx, setAddr(GI0, '10.0.0.1', '255.255.255.0')));
    expect(actions).toEqual([{ type: 'setPortL3', port: GI0, ipv4: { address: '10.0.0.1', prefixLen: 24 } }]);
    expect(fake.tables.rib.size).toBe(0);
    expect(ipv4.stateSnapshot().state).toMatchObject({ forwarding: true, interfaces: [{ port: GI0, address: '10.0.0.1', prefixLen: 24, installed: false }] });

    fake.setOper(GI0, true);
    const up = ipv4.onLinkChange!(fake.ctx, GI0, true);
    expect(up).toEqual([{ type: 'request', to: 'arp', req: { kind: 'arp.gratuitous', iface: GI0 } }]);
    const rows = fake.tables.rib.rows();
    expect(rows.map((r) => [r.key, r.source, r.iface, r.ad, r.metric])).toEqual([
      ['10.0.0.0/24', 'C', GI0, 0, 0],
      ['10.0.0.1/32', 'L', GI0, 0, 0],
    ]);
    expect(rows[0]).toMatchObject({ network: '10.0.0.0', prefixLen: 24 });
    expect(rows[1]).toMatchObject({ network: '10.0.0.1', prefixLen: 32 });
    expect(ipv4.stateSnapshot().state).toMatchObject({ interfaces: [{ installed: true }] });
    expect(fake.debug.filter((d) => d.category === 'ip routing').length).toBeGreaterThan(0);
  });

  it('installs immediately on an up port, removes rows with reason link-down and re-installs on up', () => {
    const fake = makeFake({ kind: 'router', ports: [{ id: GI0, mac: MAC_R0, operUp: true }] });
    const ipv4 = createIpv4();
    const actions = fake.run(ipv4.onConfig(fake.ctx, setAddr(GI0, '10.0.0.1', '255.255.255.0')));
    expect(actions.map((a) => a.type)).toEqual(['setPortL3', 'request']);
    expect(fake.tables.rib.size).toBe(2);

    fake.setOper(GI0, false);
    expect(ipv4.onLinkChange!(fake.ctx, GI0, false)).toEqual([]);
    expect(fake.tables.rib.size).toBe(0);
    const expired = fake.trace.filter((e) => e.kind === 'tableExpire');
    expect(expired.map((e) => (e.kind === 'tableExpire' ? [e.key, e.reason] : null))).toEqual([
      ['10.0.0.0/24', 'link-down'],
      ['10.0.0.1/32', 'link-down'],
    ]);
    expect(ipv4.stateSnapshot().state).toMatchObject({ interfaces: [{ installed: false }] });

    fake.setOper(GI0, true);
    ipv4.onLinkChange!(fake.ctx, GI0, true);
    expect(fake.tables.rib.rows().map((r) => r.key)).toEqual(['10.0.0.0/24', '10.0.0.1/32']);
  });

  it('no ip address removes the rows and clears the port L3 state', () => {
    const fake = makeFake({ kind: 'router', ports: [{ id: GI0, mac: MAC_R0 }] });
    const ipv4 = createIpv4();
    fake.run(ipv4.onConfig(fake.ctx, setAddr(GI0, '10.0.0.1', '255.255.255.0')));
    expect(fake.ctx.ports.get(GI0)?.l3.ipv4).toEqual({ address: '10.0.0.1', prefixLen: 24 });
    const actions = fake.run(ipv4.onConfig(fake.ctx, unsetAddr(GI0)));
    // §9.2 (P1 W3): the clear is explicit per member (`ipv4: null`), no longer the member-less P0 fallback.
    expect(actions).toEqual([{ type: 'setPortL3', port: GI0, ipv4: null }]);
    expect(fake.ctx.ports.get(GI0)?.l3.ipv4).toBeUndefined();
    expect(fake.tables.rib.size).toBe(0);
    expect(ipv4.stateSnapshot().state).toMatchObject({ interfaces: [] });
  });

  it('replacing an address swaps the C/L rows', () => {
    const fake = makeFake({ kind: 'router', ports: [{ id: GI0, mac: MAC_R0 }] });
    const ipv4 = createIpv4();
    fake.run(ipv4.onConfig(fake.ctx, setAddr(GI0, '10.0.0.1', '255.255.255.0')));
    fake.run(ipv4.onConfig(fake.ctx, { ...setAddr(GI0, '172.16.0.1', '255.255.0.0'), before: ['10.0.0.1', '255.255.255.0'] }));
    expect(fake.tables.rib.rows().map((r) => r.key)).toEqual(['172.16.0.0/16', '172.16.0.1/32']);
  });

  it('rejects a non-contiguous mask and the network/broadcast address of the subnet', () => {
    const fake = makeFake({ kind: 'router', ports: [{ id: GI0, mac: MAC_R0 }] });
    const ipv4 = createIpv4();
    expect(ipv4.onConfig(fake.ctx, setAddr(GI0, '10.0.0.1', '255.0.255.0'))).toEqual([]);
    expect(ipv4.onConfig(fake.ctx, setAddr(GI0, '10.0.0.0', '255.255.255.0'))).toEqual([]);
    expect(ipv4.onConfig(fake.ctx, setAddr(GI0, '10.0.0.255', '255.255.255.0'))).toEqual([]);
    expect(fake.tables.rib.size).toBe(0);
    expect(fake.debug.filter((d) => d.message.startsWith('ignored')).length).toBe(3);
    // /31 point-to-point addresses are fine
    expect(ipv4.onConfig(fake.ctx, setAddr(GI0, '10.9.9.0', '255.255.255.254'))).toHaveLength(2);
  });

  it('ignores config lines it does not own', () => {
    const fake = makeFake({ kind: 'router', ports: [{ id: GI0, mac: MAC_R0 }] });
    const ipv4 = createIpv4();
    expect(ipv4.onConfig(fake.ctx, { op: 'set', context: [], line: ['hostname', 'R1'] })).toEqual([]);
    expect(ipv4.onConfig(fake.ctx, { op: 'set', context: [], line: ['ip', 'default-gateway', '10.0.0.254'] })).toEqual([]);
    expect(ipv4.onConfig(fake.ctx, { op: 'set', context: [], line: ['ip', 'address', '1.1.1.1', '255.0.0.0'] })).toEqual([]);
    expect(fake.tables.rib.size).toBe(0);
  });

  it('init picks up addresses and static routes already in the running config', () => {
    const fake = makeFake({ kind: 'router', ports: [{ id: GI0, mac: MAC_R0 }, { id: GI1, mac: MAC_R1 }] });
    fake.ctx.config.set([['interface', GI0]], ['ip', 'address', '10.0.0.1', '255.255.255.0']);
    fake.ctx.config.set([], ['ip', 'route', '0.0.0.0', '0.0.0.0', '10.0.0.254']);
    const ipv4 = createIpv4();
    const actions = fake.run(ipv4.init!(fake.ctx));
    expect(actions.filter((a) => a.type === 'setPortL3')).toEqual([{ type: 'setPortL3', port: GI0, ipv4: { address: '10.0.0.1', prefixLen: 24 } }]);
    expect(fake.tables.rib.rows().map((r) => r.key)).toEqual(['10.0.0.0/24', '10.0.0.1/32', '0.0.0.0/0']);
    // idempotent: a replayed delta does not duplicate anything
    fake.run(ipv4.onConfig(fake.ctx, setAddr(GI0, '10.0.0.1', '255.255.255.0')));
    fake.run(ipv4.onConfig(fake.ctx, setRoute('0.0.0.0', '0.0.0.0', '10.0.0.254')));
    expect(fake.tables.rib.size).toBe(3);
    expect(ipv4.stateSnapshot().state).toMatchObject({ staticRoutes: 1, interfaces: [{ port: GI0, installed: true }] });
  });
});

describe('ipv4 static routes', () => {
  it('adds a next-hop route, an exit-interface route and a default route, and removes them', () => {
    const { fake, ipv4 } = router();
    expect(ipv4.onConfig(fake.ctx, setRoute('192.168.5.0', '255.255.255.0', '10.0.1.2'))).toEqual([]);
    ipv4.onConfig(fake.ctx, setRoute('192.168.6.0', '255.255.255.0', 'gigabitethernet0/1'));
    ipv4.onConfig(fake.ctx, setRoute('0.0.0.0', '0.0.0.0', '10.0.0.254'));
    const rib = fake.tables.rib;
    expect(rib.get('192.168.5.0/24')).toMatchObject({ source: 'S', nextHop: '10.0.1.2', ad: 1, metric: 0, network: '192.168.5.0', prefixLen: 24 });
    expect(rib.get('192.168.5.0/24')?.iface).toBeUndefined();
    expect(rib.get('192.168.5.0/24')?.isDefault).toBeUndefined();
    expect(rib.get('192.168.6.0/24')).toMatchObject({ source: 'S', iface: GI1 });
    expect(rib.get('0.0.0.0/0')).toMatchObject({ source: 'S', nextHop: '10.0.0.254', isDefault: true, prefixLen: 0 });
    expect(ipv4.stateSnapshot().state).toMatchObject({ staticRoutes: 3 });

    ipv4.onConfig(fake.ctx, unsetRoute('192.168.5.0', '255.255.255.0', '10.0.1.2'));
    expect(rib.has('192.168.5.0/24')).toBe(false);
    ipv4.onConfig(fake.ctx, unsetRoute('0.0.0.0', '0.0.0.0', '10.0.0.254'));
    expect(rib.has('0.0.0.0/0')).toBe(false);
    expect(ipv4.stateSnapshot().state).toMatchObject({ staticRoutes: 1 });
    // `no ip route` with no args clears every static route but leaves C/L alone
    ipv4.onConfig(fake.ctx, { op: 'unset', context: [], line: ['ip', 'route'] });
    expect(rib.rows().map((r) => r.source)).toEqual(['C', 'L', 'C', 'L']);
  });

  it('normalises the network to the mask and ignores an unknown next hop', () => {
    const { fake, ipv4 } = router();
    ipv4.onConfig(fake.ctx, setRoute('192.168.5.77', '255.255.255.0', '10.0.1.2'));
    expect(fake.tables.rib.get('192.168.5.0/24')).toBeDefined();
    ipv4.onConfig(fake.ctx, setRoute('192.168.7.0', '255.255.255.0', 'Serial9/9'));
    expect(fake.tables.rib.has('192.168.7.0/24')).toBe(false);
    ipv4.onConfig(fake.ctx, setRoute('192.168.8.0', '255.0.255.0', '10.0.1.2'));
    expect(fake.tables.rib.has('192.168.8.0/24')).toBe(false);
  });

  it('routeCause renders the responsible config line', () => {
    // §9.3: the default-gateway wording is chosen by the route's owner (the host daemon), never by the device kind.
    expect(routeCause({ key: '0.0.0.0/0', network: '0.0.0.0', prefixLen: 0, source: 'S', nextHop: '10.0.0.254', ad: 1, metric: 0, isDefault: true, updatedAt: 0 })).toBe(
      'ip route 0.0.0.0 0.0.0.0 10.0.0.254',
    );
    expect(routeCause({ key: '0.0.0.0/0', network: '0.0.0.0', prefixLen: 0, source: 'S', nextHop: '10.0.0.254', ad: 1, metric: 0, isDefault: true, updatedAt: 0, owner: 'host' })).toBe(
      'ip default-gateway 10.0.0.254',
    );
    expect(routeCause({ key: '10.0.1.0/24', network: '10.0.1.0', prefixLen: 24, source: 'C', iface: GI1, ad: 0, metric: 0, updatedAt: 0 })).toBe(`connected via ${GI1}`);
    expect(routeCause({ key: '10.0.1.0/24', network: '10.0.1.0', prefixLen: 24, source: 'S', iface: GI1, ad: 1, metric: 0, updatedAt: 0 })).toBe(`ip route 10.0.1.0 255.255.255.0 ${GI1}`);
  });
});

describe('ipv4 receive and forward', () => {
  it('forwards a transit packet: TTL decrement with the connected route as cause, then arp.sendVia', () => {
    const { fake, ipv4, arp } = router();
    const pdu = fake.build(framed(MAC_R0, MAC_PC, echoRequest('10.0.0.2', '10.0.1.2', 1, 1, 128)));
    const actions = fake.run(ipv4.onPdu(fake.ctx, pdu, GI0));
    expect(actions).toHaveLength(1);
    expect(arp.requests).toEqual([{ kind: 'arp.sendVia', pdu, nextHop: '10.0.1.2', iface: GI1, cause: `connected via ${GI1}` }]);
    expect(pdu.get('ipv4.ttl')).toBe(127);
    expect(pdu.get('ipv4.checksumValid')).toBe(true);
    expect(fake.mutations).toEqual([{ pdu: pdu.id, field: 'ipv4.ttl', after: 127, reason: 'TtlDecrement', cause: `connected via ${GI1}` }]);
    expect(pdu.provenance.map((m) => m.reason)).toEqual(['TtlDecrement', 'ChecksumRecompute', 'FcsRecompute']);
    expect(pdu.provenance[0]).toMatchObject({ before: 128, after: 127, device: 'd_fake', cause: `connected via ${GI1}` });
    expect(ipv4.stateSnapshot().state).toMatchObject({ forwarded: 1, delivered: 0, dropped: 0 });
    const msgs = fake.debug.filter((d) => d.category === 'ip packet').map((d) => d.message);
    expect(msgs[0]).toBe(`rx 10.0.0.2 > 10.0.1.2 ttl 128 proto 1 on ${GI0}`);
    expect(msgs[1]).toContain('forward 10.0.0.2 > 10.0.1.2 ttl 127');
  });

  it('uses a static route: next hop from the route, cause is the ip route line', () => {
    const { fake, ipv4, arp } = router();
    ipv4.onConfig(fake.ctx, setRoute('192.168.5.0', '255.255.255.0', '10.0.1.2'));
    ipv4.onConfig(fake.ctx, setRoute('0.0.0.0', '0.0.0.0', '10.0.0.9'));
    const pdu = fake.build(framed(MAC_R0, MAC_PC, echoRequest('10.0.0.2', '192.168.5.5', 1, 1, 64)));
    fake.run(ipv4.onPdu(fake.ctx, pdu, GI0));
    expect(arp.requests).toEqual([{ kind: 'arp.sendVia', pdu, nextHop: '10.0.1.2', iface: GI1, cause: 'ip route 192.168.5.0 255.255.255.0 10.0.1.2' }]);
    expect(pdu.get('ipv4.ttl')).toBe(63);
    // longest prefix wins over the default; a destination matching nothing but the default goes to 10.0.0.9 out Gi0/0
    const other = fake.build(framed(MAC_R0, MAC_R1, echoRequest('10.0.1.2', '8.8.8.8', 1, 1, 64)));
    fake.run(ipv4.onPdu(fake.ctx, other, GI1));
    expect(arp.requests[1]).toMatchObject({ kind: 'arp.sendVia', nextHop: '10.0.0.9', iface: GI0, cause: 'ip route 0.0.0.0 0.0.0.0 10.0.0.9' });
  });

  it('exit-interface static routes send to the destination itself out that interface', () => {
    const { fake, ipv4, arp } = router();
    ipv4.onConfig(fake.ctx, setRoute('192.168.6.0', '255.255.255.0', GI1));
    const pdu = fake.build(framed(MAC_R0, MAC_PC, echoRequest('10.0.0.2', '192.168.6.6', 1, 1, 64)));
    fake.run(ipv4.onPdu(fake.ctx, pdu, GI0));
    expect(arp.requests[0]).toMatchObject({ nextHop: '192.168.6.6', iface: GI1, cause: `ip route 192.168.6.0 255.255.255.0 ${GI1}` });
  });

  it('resolves a recursive static route through a second lookup', () => {
    const { fake, ipv4, arp } = router();
    ipv4.onConfig(fake.ctx, setRoute('172.16.0.0', '255.255.0.0', '10.0.1.2'));
    ipv4.onConfig(fake.ctx, setRoute('192.168.9.0', '255.255.255.0', '172.16.1.1'));
    const pdu = fake.build(framed(MAC_R0, MAC_PC, echoRequest('10.0.0.2', '192.168.9.9', 1, 1, 64)));
    fake.run(ipv4.onPdu(fake.ctx, pdu, GI0));
    expect(arp.requests[0]).toMatchObject({ nextHop: '10.0.1.2', iface: GI1, cause: 'ip route 192.168.9.0 255.255.255.0 172.16.1.1' });
  });

  it('drops ttl-expired and asks icmpv4 for a time-exceeded error', () => {
    const { fake, ipv4, arp, icmp } = router();
    const pdu = fake.build(framed(MAC_R0, MAC_PC, echoRequest('10.0.0.2', '10.0.1.2', 1, 1, 1)));
    const actions = fake.run(ipv4.onPdu(fake.ctx, pdu, GI0));
    expect(actions[0]).toMatchObject({ type: 'drop', pdu, reason: 'ttl-expired', port: GI0 });
    expect(icmp.requests).toEqual([{ kind: 'icmp.error', original: pdu, type: ICMP_TIME_EXCEEDED, code: 0, inPort: GI0 }]);
    expect(arp.requests).toEqual([]);
    expect(pdu.get('ipv4.ttl')).toBe(1);
    expect(pdu.provenance).toEqual([]);
    expect(ipv4.stateSnapshot().state).toMatchObject({ dropped: 1, forwarded: 0 });
  });

  it('drops no-route and asks icmpv4 for a net-unreachable error', () => {
    const { fake, ipv4, icmp } = router();
    const pdu = fake.build(framed(MAC_R0, MAC_PC, echoRequest('10.0.0.2', '192.168.99.1', 1, 1, 64)));
    const actions = fake.run(ipv4.onPdu(fake.ctx, pdu, GI0));
    expect(actions[0]).toMatchObject({ type: 'drop', pdu, reason: 'no-route', port: GI0 });
    expect(icmp.requests).toEqual([{ kind: 'icmp.error', original: pdu, type: ICMP_DEST_UNREACHABLE, code: 0, inPort: GI0 }]);
    expect(pdu.get('ipv4.ttl')).toBe(64);
  });

  it('drops no-route when the next hop of a static route is on no connected network', () => {
    const { fake, ipv4, icmp } = router();
    ipv4.onConfig(fake.ctx, setRoute('192.168.5.0', '255.255.255.0', '203.0.113.1'));
    const pdu = fake.build(framed(MAC_R0, MAC_PC, echoRequest('10.0.0.2', '192.168.5.5', 1, 1, 64)));
    const actions = fake.run(ipv4.onPdu(fake.ctx, pdu, GI0));
    expect(actions[0]).toMatchObject({ type: 'drop', reason: 'no-route' });
    expect(icmp.requests[0]).toMatchObject({ kind: 'icmp.error', type: ICMP_DEST_UNREACHABLE });
    expect(pdu.provenance).toEqual([]);
  });

  it('delivers packets for a local address to icmpv4; without a udp daemon a UDP datagram is protocol-unreachable', () => {
    const { fake, ipv4, icmp } = router();
    const pdu = fake.build(framed(MAC_R0, MAC_PC, echoRequest('10.0.0.2', '10.0.0.1', 1, 1)));
    const actions = fake.run(ipv4.onPdu(fake.ctx, pdu, GI0));
    expect(actions).toEqual([{ type: 'deliver', to: 'icmpv4', pdu, port: GI0 }]);
    expect(icmp.pdus).toEqual([pdu]);
    // limited broadcast is local too
    const bcast = fake.build(framed('ff:ff:ff:ff:ff:ff', MAC_PC, echoRequest('10.0.0.2', '255.255.255.255', 1, 2)));
    expect(fake.run(ipv4.onPdu(fake.ctx, bcast, GI0))[0]).toMatchObject({ type: 'deliver', to: 'icmpv4' });
    // §9.2 split: this P0.5 router model runs no udp daemon → unsupported-protocol plus ICMP protocol unreachable (3/2)
    const udp = fake.build(framed(MAC_R0, MAC_PC, [{ proto: 'ipv4', fields: { src: '10.0.0.2', dst: '10.0.0.1', protocol: 17, ttl: 64 } }, { proto: 'payload', fields: { data: new Uint8Array(8) } }]));
    const udpActions = fake.run(ipv4.onPdu(fake.ctx, udp, GI0));
    expect(udpActions[0]).toMatchObject({ type: 'drop', reason: 'unsupported-protocol', port: GI0 });
    expect(udpActions[1]).toEqual({ type: 'request', to: 'icmpv4', req: { kind: 'icmp.error', original: udp, type: ICMP_DEST_UNREACHABLE, code: 2, inPort: GI0 } });
    expect(icmp.requests).toEqual([{ kind: 'icmp.error', original: udp, type: ICMP_DEST_UNREACHABLE, code: 2, inPort: GI0 }]);
    expect(ipv4.stateSnapshot().state).toMatchObject({ delivered: 2, dropped: 1 });
  });

  it('delivers UDP (17) and TCP (6) for a local address to the udp / tcp daemons when the device runs them', () => {
    // §9.2 split: a P1 model (udp and tcp in model.processes) → the ip-upper table delivers by protocol.
    const fake = makeFake({ kind: 'router', stage: 'P1', ports: [{ id: GI0, mac: MAC_R0 }] });
    expect(fake.ctx.model.processes).toEqual(expect.arrayContaining(['udp', 'tcp']));
    const ipv4 = createIpv4();
    const udpSink = makeSink('udp');
    const tcpSink = makeSink('tcp');
    const icmp = makeSink('icmpv4');
    fake.register(ipv4);
    fake.register(udpSink);
    fake.register(tcpSink);
    fake.register(icmp);
    fake.run(ipv4.onConfig(fake.ctx, setAddr(GI0, '10.0.0.1', '255.255.255.0')));
    const udp = fake.build(framed(MAC_R0, MAC_PC, [
      { proto: 'ipv4', fields: { src: '10.0.0.2', dst: '10.0.0.1', protocol: 17, ttl: 64 } },
      { proto: 'udp', fields: { srcPort: 5000, dstPort: 9 } },
      { proto: 'payload', fields: { data: new Uint8Array([1, 2, 3]) } },
    ]));
    expect(fake.run(ipv4.onPdu(fake.ctx, udp, GI0))).toEqual([{ type: 'deliver', to: 'udp', pdu: udp, port: GI0 }]);
    expect(udpSink.pdus).toEqual([udp]);
    const tcp = fake.build(framed(MAC_R0, MAC_PC, [
      { proto: 'ipv4', fields: { src: '10.0.0.2', dst: '10.0.0.1', protocol: 6, ttl: 64 } },
      { proto: 'tcp', fields: { srcPort: 50000, dstPort: 80, seq: 1, ack: 0, flags: 'S', window: 65535 } },
    ]));
    expect(fake.run(ipv4.onPdu(fake.ctx, tcp, GI0))).toEqual([{ type: 'deliver', to: 'tcp', pdu: tcp, port: GI0 }]);
    expect(tcpSink.pdus).toEqual([tcp]);
    expect(icmp.requests).toEqual([]);
    const msgs = fake.debug.filter((d) => d.category === 'ip packet').map((d) => d.message);
    expect(msgs).toContain('deliver 10.0.0.2 > 10.0.0.1 ttl 64 proto 17 to udp');
    // a self-addressed UDP send takes the same table back to udp
    const self = fake.ctx.newPdu([
      { proto: 'ipv4', fields: { src: '10.0.0.1', dst: '10.0.0.1', protocol: 17, ttl: 255 } },
      { proto: 'udp', fields: { srcPort: 1, dstPort: 2 } },
    ]);
    expect(fake.run(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.send', pdu: self }))).toEqual([{ type: 'deliver', to: 'udp', pdu: self, port: GI0 }]);
    expect(ipv4.stateSnapshot().state).toMatchObject({ delivered: 3, dropped: 0 });
  });

  it('never answers an unknown protocol sent to a broadcast address with an ICMP error', () => {
    const { fake, ipv4, icmp } = router();
    const directed = fake.build(framed('ff:ff:ff:ff:ff:ff', MAC_PC, [{ proto: 'ipv4', fields: { src: '10.0.0.2', dst: '10.0.0.255', protocol: 253, ttl: 64 } }, { proto: 'payload', fields: { data: new Uint8Array(4) } }]));
    expect(fake.run(ipv4.onPdu(fake.ctx, directed, GI0))).toEqual([{ type: 'drop', pdu: directed, reason: 'unsupported-protocol', detail: 'ip protocol 253 has no listener', port: GI0 }]);
    const limited = fake.build(framed('ff:ff:ff:ff:ff:ff', MAC_PC, [{ proto: 'ipv4', fields: { src: '10.0.0.2', dst: '255.255.255.255', protocol: 253, ttl: 64 } }, { proto: 'payload', fields: { data: new Uint8Array(4) } }]));
    expect(fake.run(ipv4.onPdu(fake.ctx, limited, GI0))).toHaveLength(1);
    expect(icmp.requests).toEqual([]);
  });

  it('a PC drops transit packets not-for-me instead of forwarding', () => {
    const fake = makeFake({ kind: 'pc', ports: [{ id: 'GigabitEthernet0', mac: MAC_PC, ipv4: { address: '10.0.0.1', prefixLen: 24 } }] });
    const ipv4 = createIpv4();
    const pdu = fake.build(framed(MAC_PC, MAC_R0, echoRequest('10.0.0.2', '10.0.0.3', 1, 1)));
    const actions = ipv4.onPdu(fake.ctx, pdu, 'GigabitEthernet0');
    expect(actions).toEqual([{ type: 'drop', pdu, reason: 'not-for-me', detail: expect.any(String), port: 'GigabitEthernet0' }]);
    expect(ipv4.stateSnapshot().state).toMatchObject({ forwarding: false, dropped: 1 });
  });

  it('drops a packet with a bad header checksum', () => {
    const { fake, ipv4 } = router();
    const good = fake.build(framed(MAC_R0, MAC_PC, echoRequest('10.0.0.2', '10.0.1.2', 1, 1)));
    good.corrupt({ now: fake.ctx.now, device: 'd_peer' }, 14 + 8, 0x01); // flip a TTL bit: header checksum no longer matches
    expect(good.get('ipv4.checksumValid')).toBe(false);
    const actions = ipv4.onPdu(fake.ctx, good, GI0);
    expect(actions).toEqual([{ type: 'drop', pdu: good, reason: 'bad-checksum', detail: expect.any(String), port: GI0 }]);
  });

  it('does not forward broadcast or multicast destinations', () => {
    const { fake, ipv4, icmp } = router();
    const pdu = fake.build(framed('01:00:5e:00:00:01', MAC_PC, echoRequest('10.0.0.2', '224.0.0.1', 1, 1)));
    expect(ipv4.onPdu(fake.ctx, pdu, GI0)[0]).toMatchObject({ type: 'drop', reason: 'not-for-me' });
    expect(icmp.requests).toEqual([]);
  });
});

describe('ipv4.send (locally originated)', () => {
  it('routes without touching the TTL and passes the request cause to arp', () => {
    const { fake, ipv4, arp } = router();
    const pdu = fake.ctx.newPdu(echoRequest('10.0.1.1', '10.0.1.2', 1, 1, 255), { tag: 'ping#1' });
    const actions = fake.run(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.send', pdu, cause: 'ping 10.0.1.2' }));
    expect(actions).toHaveLength(1);
    expect(arp.requests).toEqual([{ kind: 'arp.sendVia', pdu, nextHop: '10.0.1.2', iface: GI1, cause: 'ping 10.0.1.2' }]);
    expect(pdu.get('ipv4.ttl')).toBe(255);
    expect(pdu.provenance).toEqual([]);
    expect(pdu.layer('ethernet')).toBeUndefined();
    expect(ipv4.stateSnapshot().state).toMatchObject({ sent: 1, forwarded: 0 });
  });

  it('falls back to the route line as cause and uses the static next hop', () => {
    const { fake, ipv4, arp } = router();
    ipv4.onConfig(fake.ctx, setRoute('0.0.0.0', '0.0.0.0', '10.0.0.254'));
    const pdu = fake.ctx.newPdu(echoRequest('10.0.0.1', '8.8.8.8', 1, 1, 255));
    fake.run(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.send', pdu }));
    expect(arp.requests[0]).toEqual({ kind: 'arp.sendVia', pdu, nextHop: '10.0.0.254', iface: GI0, cause: 'ip route 0.0.0.0 0.0.0.0 10.0.0.254' });
  });

  it('drops a limited broadcast sent without an egress interface as no-route (§9.2: was a gateway unicast)', () => {
    const { fake, ipv4, arp } = router();
    ipv4.onConfig(fake.ctx, setRoute('0.0.0.0', '0.0.0.0', '10.0.0.254'));
    const pdu = fake.ctx.newPdu([{ proto: 'ipv4', fields: { src: '10.0.0.1', dst: '255.255.255.255', protocol: 17, ttl: 255 } }, { proto: 'payload', fields: { data: new Uint8Array(8) } }]);
    expect(fake.run(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.send', pdu }))).toEqual([
      { type: 'drop', pdu, reason: 'no-route', detail: 'limited broadcast needs an egress interface' },
    ]);
    expect(arp.requests).toEqual([]);
  });

  it('drops no-route when nothing matches and delivers a packet to our own address locally', () => {
    const { fake, ipv4, icmp, arp } = router();
    const pdu = fake.ctx.newPdu(echoRequest('10.0.0.1', '192.0.2.1', 1, 1, 255));
    expect(fake.run(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.send', pdu }))).toEqual([{ type: 'drop', pdu, reason: 'no-route', detail: 'no route to 192.0.2.1' }]);
    expect(fake.debug.some((d) => d.category === 'ip packet' && d.message.includes('no-route'))).toBe(true);
    const self = fake.ctx.newPdu(echoRequest('10.0.0.1', '10.0.1.1', 1, 1, 255));
    expect(fake.run(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.send', pdu: self }))).toEqual([{ type: 'deliver', to: 'icmpv4', pdu: self, port: GI1 }]);
    expect(icmp.pdus).toEqual([self]);
    expect(arp.requests).toEqual([]);
  });
});

describe('ipv4 process shape', () => {
  it('registers for ethertype 0x0800, keeps a debug ring and a structured-clone-safe snapshot', () => {
    const ipv4 = createIpv4();
    expect(ipv4.name).toBe('ipv4');
    // P0.5 (§9.2): Ethernet on L3 roles plus HDLC protocol 0x0800 on serial WAN ports.
    expect(ipv4.handles).toEqual([
      { layer: 'ethernet', ethertype: ETHERTYPE_IPV4, roles: L3_ROLES },
      { layer: 'hdlc', ethertype: HDLC_PROTO_IPV4, roles: ['wan'] },
    ]);
    expect(ipv4.onTimer({} as never, 'x')).toEqual([]);
    const snap = ipv4.stateSnapshot();
    expect(snap).toEqual({ process: 'ipv4', state: { forwarding: false, interfaces: [], staticRoutes: 0, forwarded: 0, delivered: 0, sent: 0, dropped: 0 } });
    expect(() => structuredClone(snap)).not.toThrow();
    const { fake } = router();
    expect(ipv4.debugEvents()).toEqual([]);
    ipv4.onConfig(fake.ctx, setRoute('0.0.0.0', '0.0.0.0', '10.0.0.254'));
    const ev = ipv4.debugEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ process: 'ipv4', category: 'ip routing', device: 'd_fake', at: fake.ctx.now });
  });
});
