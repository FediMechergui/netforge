/**
 * ip6.ipv6 — the IPv6 daemon (protocols/ipv6.ts) against RFC 8200 / RFC 4291 / RFC 4443 semantics, on real device
 * runtimes (test/ip6.harness.ts): interface addressing from config, rib6 (C/L/S/ND with AD arbitration), forwarding
 * with the hop-limit decrement and its provenance cause, the upper-layer table with the parameter-problem errors,
 * packet too big, and link state.
 */
import { describe, expect, it } from 'vitest';
import {
  ICMPV6_DEST_UNREACHABLE,
  ICMPV6_PACKET_TOO_BIG,
  ICMPV6_PARAM_PROBLEM,
  ICMPV6_TIME_EXCEEDED,
  type LayerSpec,
  type Pdu,
} from '../src/contracts/pdu.js';
import type { Ipv6PortAddress } from '../src/contracts/port.js';
import type { Process } from '../src/contracts/process.js';
import type { Route6Row } from '../src/contracts/tables.js';
import { MS, SEC } from '../src/contracts/time.js';
import { eui64Address, linkLocalFromMac, solicitedNodeMulticast } from '../src/core/addr6.js';
import { route6Cause } from '../src/protocols/ipv6.js';
import { BOOT_NS, createWorld6, icmp6Of, recorder, type World6 } from './ip6.harness.js';

const PC = 'GigabitEthernet0';
const G0 = 'GigabitEthernet0/0';
const G1 = 'GigabitEthernet0/1';

function addrs(w: World6, dev: string, port: string): readonly Ipv6PortAddress[] {
  return w.dev(dev).port(port)?.l3.ipv6 ?? [];
}
function mac(w: World6, dev: string, port: string): string {
  return w.dev(dev).port(port)!.mac;
}
function rib6(w: World6, dev: string): Route6Row[] {
  return w.dev(dev).tables.get<Route6Row>('rib6')!.rows();
}
function slaacOf(w: World6, dev: string, prefix: string): string {
  return eui64Address(prefix, 64, mac(w, dev, PC))!;
}

/**
 * PC1 (2001:db8:1::/64, SLAAC) — R1 — (2001:db8:12::/64) — R2 — PC2 (2001:db8:2::/64, SLAAC), static routes both ways.
 */
function chain(opts: { extra?: Record<string, () => Process> } = {}): World6 {
  const w = createWorld6({ seed: 2, ...(opts.extra !== undefined ? { extra: opts.extra } : {}) });
  w.add('pc1', 'pc');
  w.add('r1', 'router');
  w.add('r2', 'router');
  w.add('pc2', 'pc');
  w.link({ device: 'pc1', port: PC }, { device: 'r1', port: G0 });
  w.link({ device: 'r1', port: G1 }, { device: 'r2', port: G1 });
  w.link({ device: 'r2', port: G0 }, { device: 'pc2', port: PC });
  w.runFor(BOOT_NS);
  w.global('r1', 'ipv6 unicast-routing', 'ipv6 route 2001:db8:2::/64 2001:db8:12::2');
  w.global('r2', 'ipv6 unicast-routing', 'ipv6 route 2001:db8:1::/64 2001:db8:12::1');
  w.iface('r1', G0, 'ipv6 address 2001:db8:1::1/64', 'no shutdown');
  w.iface('r1', G1, 'ipv6 address 2001:db8:12::1/64', 'no shutdown');
  w.iface('r2', G0, 'ipv6 address 2001:db8:2::1/64', 'no shutdown');
  w.iface('r2', G1, 'ipv6 address 2001:db8:12::2/64', 'no shutdown');
  w.iface('pc1', PC, 'ipv6 address autoconfig');
  w.iface('pc2', PC, 'ipv6 address autoconfig');
  w.runFor(6 * SEC);
  return w;
}

describe('ip6.ipv6 interface addressing', () => {
  it('derives the link-local, manual, eui-64 and link-local lines, tentative until DAD, with the right groups', () => {
    const w = createWorld6();
    w.add('r1', 'router');
    w.add('pc1', 'pc');
    w.link({ device: 'r1', port: G0 }, { device: 'pc1', port: PC });
    w.runFor(BOOT_NS);
    w.global('r1', 'ipv6 unicast-routing');
    w.iface('r1', G0, 'ipv6 address 2001:DB8:1:0::1/64', 'ipv6 address 2001:db8:5::/64 eui-64');
    const m = mac(w, 'r1', G0);
    const ll = linkLocalFromMac(m);
    const eui = eui64Address('2001:db8:5::', 64, m)!;
    // the port is administratively down: everything tentative, nothing sent
    expect(addrs(w, 'r1', G0)).toEqual([
      { address: ll, prefixLen: 64, scope: 'link-local', origin: 'auto-link-local', state: 'tentative' },
      { address: '2001:db8:1::1', prefixLen: 64, scope: 'global', origin: 'manual', state: 'tentative' },
      { address: eui, prefixLen: 64, scope: 'global', origin: 'eui64', state: 'tentative' },
    ]);
    const l3 = w.dev('r1').port(G0)!.l3;
    expect(l3.ipv6Enabled).toBe(true);
    // the EUI-64 address shares the low 24 bits of the link-local, hence its solicited-node group (joined once)
    expect(solicitedNodeMulticast(eui)).toBe(solicitedNodeMulticast(ll));
    expect(l3.groups6).toEqual(['ff02::1', 'ff02::2', solicitedNodeMulticast(ll), solicitedNodeMulticast('2001:db8:1::1')]);
    expect(w.sentBy('r1')).toEqual([]);
    w.iface('r1', G0, 'no shutdown');
    w.runFor(2 * SEC);
    expect(addrs(w, 'r1', G0).every((a) => a.state === 'preferred')).toBe(true);
    expect(rib6(w, 'r1').map((r) => [r.source, r.key, r.iface, r.ad])).toEqual([
      ['C', '2001:db8:1::/64', G0, 0],
      ['L', '2001:db8:1::1/128', G0, 0],
      ['C', '2001:db8:5::/64', G0, 0],
      ['L', `${eui}/128`, G0, 0],
    ]);
    // a manual link-local replaces the automatic one; removing lines removes addresses and routes
    w.iface('r1', G0, 'ipv6 address fe80::1 link-local');
    expect(addrs(w, 'r1', G0)[0]).toMatchObject({ address: 'fe80::1', origin: 'manual', scope: 'link-local', state: 'tentative' });
    w.iface('r1', G0, 'no ipv6 address 2001:db8:5::/64 eui-64');
    expect(addrs(w, 'r1', G0).map((a) => a.address)).toEqual(['fe80::1', '2001:db8:1::1']);
    expect(rib6(w, 'r1').map((r) => r.key)).toEqual(['2001:db8:1::/64', '2001:db8:1::1/128']);
    w.iface('r1', G0, 'no ipv6 address');
    const cleared = w.dev('r1').port(G0)!.l3;
    expect(cleared.ipv6).toBeUndefined();
    expect(cleared.ipv6Enabled).toBeUndefined();
    expect(cleared.groups6).toBeUndefined();
    expect(rib6(w, 'r1')).toEqual([]);
  });

  it('ipv6 enable gives only the link-local, and a host joins no all-routers group', () => {
    const w = createWorld6();
    w.add('pc1', 'pc');
    w.runFor(BOOT_NS);
    w.iface('pc1', PC, 'ipv6 enable');
    const l3 = w.dev('pc1').port(PC)!.l3;
    expect(l3.ipv6!.map((a) => a.origin)).toEqual(['auto-link-local']);
    expect(l3.groups6).toEqual(['ff02::1', solicitedNodeMulticast(l3.ipv6![0]!.address)]);
  });

  it('link down withdraws C/L routes and returns addresses to tentative; link up runs DAD again', () => {
    const w = chain();
    expect(rib6(w, 'r1').some((r) => r.key === '2001:db8:12::/64')).toBe(true);
    w.iface('r2', G1, 'shutdown');
    w.runFor(10 * MS);
    expect(addrs(w, 'r1', G1).map((a) => a.state)).toEqual(['tentative', 'tentative']);
    expect(rib6(w, 'r1').some((r) => r.iface === G1)).toBe(false);
    const expire = w.kinds('tableExpire').filter((e) => e.device === 'r1' && e.table === 'rib6');
    expect(expire.map((e) => e.reason)).toContain('link-down');
    const before = w.sentBy('r1', G1).length;
    w.iface('r2', G1, 'no shutdown');
    w.runFor(2 * SEC);
    expect(w.sentBy('r1', G1).length).toBeGreaterThan(before);
    expect(addrs(w, 'r1', G1).map((a) => a.state)).toEqual(['preferred', 'preferred']);
    expect(rib6(w, 'r1').some((r) => r.key === '2001:db8:12::/64')).toBe(true);
  });
});

describe('ip6.ipv6 rib6 and forwarding', () => {
  it('installs static routes (AD 1) and forwards with the hop-limit decrement caused by the matched route line', () => {
    const w = chain();
    const s = rib6(w, 'r1').find((r) => r.key === '2001:db8:2::/64')!;
    expect(s).toMatchObject({ source: 'S', ad: 1, nextHop: '2001:db8:12::2' });
    expect(route6Cause(s)).toBe('ipv6 route 2001:db8:2::/64 2001:db8:12::2');
    const target = slaacOf(w, 'pc2', '2001:db8:2::');
    w.request('pc1', 'icmpv6', { kind: 'icmp6.ping', session: 's', target, count: 3, timeoutNs: 2 * SEC, sizeBytes: 100 });
    w.runFor(3 * SEC);
    expect(w.output('s')).toContain('!!!');
    const muts = w.kinds('mutation').filter((m) => m.mutation.field === 'ipv6.hopLimit');
    const byDevice = (d: string) => muts.filter((m) => m.mutation.device === d);
    const first = w.kinds('pduCreated').find((e) => e.device === 'pc1' && e.pdu.tag === 'ping6#1')!.pdu.id;
    const hops = muts.filter((m) => m.pdu === first).map((m) => [m.mutation.device, m.mutation.before, m.mutation.after, m.mutation.reason, m.mutation.cause]);
    expect(hops).toEqual([
      ['r1', 64, 63, 'TtlDecrement', 'ipv6 route 2001:db8:2::/64 2001:db8:12::2'],
      ['r2', 63, 62, 'TtlDecrement', 'connected via GigabitEthernet0/0'],
    ]);
    expect(byDevice('pc1')).toEqual([]);
  });

  it('hop limit 1 → drop ttl-expired and time exceeded from the ingress address', () => {
    const w = chain();
    const target = slaacOf(w, 'pc2', '2001:db8:2::');
    w.request('pc1', 'icmpv6', { kind: 'icmp6.ping', session: 't', target, count: 1, timeoutNs: 2 * SEC, sizeBytes: 100, hopLimit: 1 });
    w.runFor(SEC);
    expect(w.kinds('drop').filter((d) => d.device === 'r1' && d.reason === 'ttl-expired')).toHaveLength(1);
    const err = w.sentBy('r1', G0).find((p) => icmp6Of(p)?.type === ICMPV6_TIME_EXCEEDED)!;
    expect(err.layer('ipv6')!.fields).toMatchObject({ src: '2001:db8:1::1', dst: slaacOf(w, 'pc1', '2001:db8:1::'), hopLimit: 255 });
    // the quote is the invoking packet, decoded as nested layers
    const quoted = err.layers.filter((l) => l.proto === 'ipv6');
    expect(quoted).toHaveLength(2);
    expect(quoted[1]!.fields).toMatchObject({ dst: target, hopLimit: 1 });
    expect(w.output('t')).toContain('T');
  });

  it('no route → drop no-route and unreachable code 0; a host never forwards', () => {
    const w = chain();
    w.request('pc1', 'icmpv6', { kind: 'icmp6.ping', session: 'u', target: '2001:db8:99::1', count: 1, timeoutNs: 2 * SEC, sizeBytes: 100 });
    w.runFor(SEC);
    expect(w.kinds('drop').filter((d) => d.device === 'r1' && d.reason === 'no-route')).toHaveLength(1);
    const err = w.sentBy('r1', G0).find((p) => icmp6Of(p)?.type === ICMPV6_DEST_UNREACHABLE)!;
    expect(icmp6Of(err)!.code).toBe(0);
    expect(w.output('u')).toContain('U');
    // a packet for somebody else reaching a host is not forwarded
    const stray = w.build([
      { proto: 'ipv6', fields: { src: '2001:db8:1::1', dst: '2001:db8:99::9', nextHeader: 59, hopLimit: 64 } },
    ]);
    w.act('r1', 'icmpv6', [{ type: 'request', to: 'nd', req: { kind: 'nd.sendVia', pdu: stray, nextHop: linkLocalFromMac(mac(w, 'pc1', PC)), iface: G0 } }]);
    w.runFor(SEC);
    const d = w.kinds('drop').find((e) => e.device === 'pc1' && e.pdu.id === stray.id)!;
    expect(d.reason).toBe('not-for-me');
  });

  it('packet too big when the egress MTU is smaller (routers never fragment)', () => {
    const w = chain();
    w.dev('r1').port(G1)!.mtu = 1280;
    const target = slaacOf(w, 'pc2', '2001:db8:2::');
    w.request('pc1', 'icmpv6', { kind: 'icmp6.ping', session: 'm', target, count: 1, timeoutNs: 2 * SEC, sizeBytes: 1400 });
    w.runFor(SEC);
    const err = w.sentBy('r1', G0).find((p) => icmp6Of(p)?.type === ICMPV6_PACKET_TOO_BIG)!;
    expect(icmp6Of(err)!.mtu).toBe(1280);
    // the error fits the minimum MTU (RFC 4443 §2.4 c)
    expect(err.layer('ipv6')!.length).toBeLessThanOrEqual(1280);
    expect(w.output('m')).toContain('U');
  });

  it('a static ::/0 (AD 1) beats the ND default (AD 2); removing it restores the ND route', () => {
    const w = chain();
    const r1Ll = linkLocalFromMac(mac(w, 'r1', G0));
    expect(rib6(w, 'pc1').find((r) => r.key === '::/0')).toMatchObject({ source: 'ND', nextHop: r1Ll });
    w.global('pc1', `ipv6 route ::/0 ${PC} ${r1Ll}`);
    expect(rib6(w, 'pc1').find((r) => r.key === '::/0')).toMatchObject({ source: 'S', ad: 1, iface: PC, nextHop: r1Ll });
    expect(route6Cause(rib6(w, 'pc1').find((r) => r.key === '::/0')!)).toBe(`ipv6 route ::/0 ${PC} ${r1Ll}`);
    w.global('pc1', `no ipv6 route ::/0 ${PC} ${r1Ll}`);
    expect(rib6(w, 'pc1').find((r) => r.key === '::/0')).toMatchObject({ source: 'ND', ad: 2 });
  });
});

describe('ip6.ipv6 upper-layer table (§4.2, RFC 8200 §4)', () => {
  function toR1(w: World6, layers: LayerSpec[]): Pdu {
    const src = slaacOf(w, 'pc1', '2001:db8:1::');
    const first = layers[0]!;
    first.fields = { src, dst: '2001:db8:1::1', hopLimit: 64, ...first.fields };
    const pdu = w.build(layers);
    w.act('pc1', 'icmpv6', [{ type: 'request', to: 'ipv6', req: { kind: 'ipv6.send', pdu } }]);
    w.runFor(100 * MS);
    return pdu;
  }
  function paramProblem(w: World6): Record<string, unknown> | undefined {
    const e = w.sentBy('r1', G0).filter((p) => icmp6Of(p)?.type === ICMPV6_PARAM_PROBLEM);
    return e.length === 0 ? undefined : icmp6Of(e[e.length - 1]!);
  }

  it('an unknown next header → drop unsupported-protocol + parameter problem code 1 pointing at the Next Header field', () => {
    const w = chain();
    const pdu = toR1(w, [
      { proto: 'ipv6', fields: { nextHeader: 253 } },
      { proto: 'payload', fields: { data: new Uint8Array(8) } },
    ]);
    expect(w.kinds('drop').find((d) => d.device === 'r1' && d.pdu.id === pdu.id)).toMatchObject({ reason: 'unsupported-protocol' });
    expect(paramProblem(w)).toMatchObject({ code: 1, pointer: 6 });
    // behind a destination options header, the pointer is that header's Next Header byte (offset 40)
    toR1(w, [
      { proto: 'ipv6', fields: { nextHeader: 60 } },
      { proto: 'ipv6-dstopts', fields: { nextHeader: 253 } },
      { proto: 'payload', fields: { data: new Uint8Array(8) } },
    ]);
    expect(paramProblem(w)).toMatchObject({ code: 1, pointer: 40 });
  });

  it('a type 0 routing header → parameter problem code 0 pointing at the routing type', () => {
    const w = chain();
    toR1(w, [
      { proto: 'ipv6', fields: { nextHeader: 43 } },
      { proto: 'ipv6-route', fields: { nextHeader: 59, routingType: 0, segmentsLeft: 1, data: new Uint8Array(20) } },
    ]);
    expect(paramProblem(w)).toMatchObject({ code: 0, pointer: 42 });
  });

  it('fragments are dropped (no reassembly in P1); next header 59 is consumed silently', () => {
    const w = chain();
    const frag = toR1(w, [
      { proto: 'ipv6', fields: { nextHeader: 44 } },
      { proto: 'ipv6-frag', fields: { nextHeader: 58, offset: 0, more: true, id: 7 } },
      { proto: 'payload', fields: { data: new Uint8Array(16) } },
    ]);
    expect(w.kinds('drop').find((d) => d.device === 'r1' && d.pdu.id === frag.id)).toMatchObject({ reason: 'other', detail: 'ipv6 reassembly not supported in P1' });
    const none = toR1(w, [{ proto: 'ipv6', fields: { nextHeader: 59 } }]);
    expect(w.kinds('pduConsumed').some((e) => e.device === 'r1' && e.pdu.id === none.id && e.process === 'ipv6')).toBe(true);
    expect(paramProblem(w)).toBeUndefined();
  });

  it('delivers UDP and TCP to their daemons when the model runs them', () => {
    const udp = recorder('udp');
    const w = chain({ extra: { udp: () => udp } });
    const pdu = toR1(w, [
      { proto: 'ipv6', fields: { nextHeader: 17 } },
      { proto: 'udp', fields: { srcPort: 5000, dstPort: 9 } },
      { proto: 'payload', fields: { data: new Uint8Array([1, 2, 3]) } },
    ]);
    expect(udp.pdus.map((p) => p.id)).toContain(pdu.id);
  });

  it('a link-local destination needs an egress interface on send', () => {
    const w = chain();
    const pdu = w.build([{ proto: 'ipv6', fields: { src: slaacOf(w, 'pc1', '2001:db8:1::'), dst: 'fe80::1', nextHeader: 59, hopLimit: 64 } }]);
    w.act('pc1', 'icmpv6', [{ type: 'request', to: 'ipv6', req: { kind: 'ipv6.send', pdu } }]);
    expect(w.kinds('drop').find((d) => d.pdu.id === pdu.id)).toMatchObject({ reason: 'no-route', detail: 'link-local and multicast destinations need an egress interface' });
  });
});
