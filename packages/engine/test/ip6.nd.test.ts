/**
 * ip6.nd — IPv6 Neighbour Discovery (protocols/nd.ts) against RFC 4861 / RFC 4862 semantics, on real device runtimes
 * (test/ip6.harness.ts): DAD probes and both duplicate forms, router solicitation and advertisement, SLAAC, the
 * neighbour cache state machine, resolution failure, serial (HDLC) framing, and the silence rule.
 */
import { describe, expect, it } from 'vitest';
import type { Ipv6Address } from '../src/contracts/addr.js';
import {
  ICMPV6_NA,
  ICMPV6_NS,
  ICMPV6_RA,
  ICMPV6_RS,
  type Pdu,
} from '../src/contracts/pdu.js';
import type { Ipv6PortAddress } from '../src/contracts/port.js';
import {
  ND_RA_INTERVAL_NS,
  ND_RA_PREFERRED_LIFETIME_S,
  ND_RA_VALID_LIFETIME_S,
  ND_REACHABLE_NS,
  ND_RS_INTERVAL_NS,
} from '../src/contracts/services.js';
import { ndKey, type NdRow, type Route6Row } from '../src/contracts/tables.js';
import { MS, SEC } from '../src/contracts/time.js';
import { eui64Address, ipv6MulticastMac, linkLocalFromMac, solicitedNodeMulticast } from '../src/core/addr6.js';
import { BOOT_NS, createWorld6, icmp6Of, ofIcmp6Type, type World6 } from './ip6.harness.js';

const R1_LAN = 'GigabitEthernet0/0';
const PC = 'GigabitEthernet0';

function addrs(w: World6, dev: string, port: string): readonly Ipv6PortAddress[] {
  return w.dev(dev).port(port)?.l3.ipv6 ?? [];
}
function mac(w: World6, dev: string, port: string): string {
  return w.dev(dev).port(port)!.mac;
}
function ndRows(w: World6, dev: string): NdRow[] {
  return w.dev(dev).tables.get<NdRow>('nd')!.rows();
}
function rib6(w: World6, dev: string): Route6Row[] {
  return w.dev(dev).tables.get<Route6Row>('rib6')!.rows();
}
function ip6(p: Pdu): Record<string, unknown> {
  return p.layer('ipv6')!.fields as Record<string, unknown>;
}

/** R1 and PC1 on one cable, both booted. */
function pair(seed = 1): World6 {
  const w = createWorld6({ seed });
  w.add('r1', 'router');
  w.add('pc1', 'pc');
  w.link({ device: 'r1', port: R1_LAN }, { device: 'pc1', port: PC });
  w.runFor(BOOT_NS);
  return w;
}

describe('ip6.nd duplicate address detection (RFC 4862 §5.4)', () => {
  it('probes from :: to the solicited-node group with hop limit 255 and no source link-layer option, then prefers the address', () => {
    const w = pair();
    w.iface('r1', R1_LAN, 'ipv6 address 2001:db8:1::1/64', 'no shutdown');
    w.runFor(10 * MS);
    const ll = linkLocalFromMac(mac(w, 'r1', R1_LAN));
    const probes = ofIcmp6Type(w.sentBy('r1'), ICMPV6_NS);
    expect(probes.map((p) => icmp6Of(p)!.target)).toEqual([ll, '2001:db8:1::1']);
    for (const p of probes) {
      const target = icmp6Of(p)!.target as Ipv6Address;
      const group = solicitedNodeMulticast(target);
      expect(ip6(p)).toMatchObject({ src: '::', dst: group, hopLimit: 255, nextHeader: 58 });
      expect(p.layer('ethernet')!.fields.dst).toBe(ipv6MulticastMac(group));
      expect(icmp6Of(p)!.sourceLla).toBeUndefined();
      expect(p.meta.tag).toBe('dad-ns');
    }
    expect(addrs(w, 'r1', R1_LAN).map((a) => a.state)).toEqual(['tentative', 'tentative']);
    w.runFor(SEC);
    expect(addrs(w, 'r1', R1_LAN).map((a) => [a.address, a.origin, a.state])).toEqual([
      [ll, 'auto-link-local', 'preferred'],
      ['2001:db8:1::1', 'manual', 'preferred'],
    ]);
  });

  it('marks an address duplicate when another node defends it with an advertisement, and logs it', () => {
    const w = createWorld6();
    w.add('pc1', 'pc');
    w.add('pc2', 'pc');
    w.link({ device: 'pc1', port: PC }, { device: 'pc2', port: PC });
    w.runFor(BOOT_NS);
    w.iface('pc1', PC, 'ipv6 address 2001:db8:1::5/64');
    w.runFor(2 * SEC);
    w.iface('pc2', PC, 'ipv6 address 2001:db8:1::5/64');
    w.runFor(2 * SEC);
    const defence = ofIcmp6Type(w.sentBy('pc1'), ICMPV6_NA);
    expect(defence).toHaveLength(1);
    expect(ip6(defence[0]!)).toMatchObject({ src: '2001:db8:1::5', dst: 'ff02::1', hopLimit: 255 });
    expect(icmp6Of(defence[0]!)).toMatchObject({ target: '2001:db8:1::5', solicitedFlag: false, overrideFlag: true, targetLla: mac(w, 'pc1', PC) });
    const dup = addrs(w, 'pc2', PC).find((a) => a.address === '2001:db8:1::5')!;
    expect(dup.state).toBe('duplicate');
    expect(addrs(w, 'pc1', PC).find((a) => a.address === '2001:db8:1::5')!.state).toBe('preferred');
    const logs = w.kinds('log').filter((l) => l.device === 'pc2' && l.severity === 4);
    expect(logs.map((l) => l.message)).toEqual([`Duplicate address 2001:db8:1::5 on ${PC}`]);
    // the duplicate joins no solicited-node group and never becomes a source; the link-local stays usable
    expect(w.dev('pc2').port(PC)!.l3.ipv6Enabled).toBe(true);
    expect(w.dev('pc2').tables.get<Route6Row>('rib6')!.rows().some((r) => r.network === '2001:db8:1::5')).toBe(false);
  });

  it('detects a simultaneous probe from :: for the same tentative address on both nodes', () => {
    const w = createWorld6();
    w.add('pc1', 'pc');
    w.add('pc2', 'pc');
    w.link({ device: 'pc1', port: PC }, { device: 'pc2', port: PC });
    w.runFor(BOOT_NS);
    w.iface('pc1', PC, 'ipv6 address 2001:db8:1::7/64');
    w.iface('pc2', PC, 'ipv6 address 2001:db8:1::7/64');
    w.runFor(2 * SEC);
    for (const d of ['pc1', 'pc2']) {
      expect(addrs(w, d, PC).find((a) => a.address === '2001:db8:1::7')!.state).toBe('duplicate');
    }
    // nobody defended: the conflict was seen in the other node's probe
    expect(ofIcmp6Type([...w.sentBy('pc1'), ...w.sentBy('pc2')], ICMPV6_NA)).toHaveLength(0);
  });

  it('stops IPv6 on the interface when the link-local address is a duplicate', () => {
    const w = createWorld6();
    w.add('pc1', 'pc');
    w.add('pc2', 'pc');
    w.link({ device: 'pc1', port: PC }, { device: 'pc2', port: PC });
    w.runFor(BOOT_NS);
    w.iface('pc1', PC, 'ipv6 address fe80::1 link-local');
    w.runFor(2 * SEC);
    w.iface('pc2', PC, 'ipv6 address fe80::1 link-local', 'ipv6 address 2001:db8:1::2/64');
    w.runFor(2 * SEC);
    const l3 = w.dev('pc2').port(PC)!.l3;
    expect(l3.ipv6![0]).toMatchObject({ address: 'fe80::1', origin: 'manual', state: 'duplicate' });
    expect(l3.ipv6Enabled).toBe(false);
    expect(rib6(w, 'pc2')).toEqual([]);
    expect(w.dev('pc2').processes.get('ipv6')!.stateSnapshot().state).toMatchObject({
      interfaces: [expect.objectContaining({ port: PC, linkLocalDuplicate: true })],
    });
    // a link bounce runs the detection again (RFC 4862 §5.4): still a duplicate while pc1 holds it
    w.iface('pc2', PC, 'shutdown');
    w.runFor(SEC);
    w.iface('pc2', PC, 'no shutdown');
    w.runFor(2 * SEC);
    expect(w.dev('pc2').port(PC)!.l3.ipv6![0]!.state).toBe('duplicate');
  });
});

describe('ip6.nd router discovery and SLAAC (RFC 4861 §6, RFC 4862 §5.5)', () => {
  it('answers a router solicitation with an RA that yields the SLAAC address, the router entry and the ND default', () => {
    const w = pair(3);
    w.global('r1', 'ipv6 unicast-routing');
    w.iface('r1', R1_LAN, 'ipv6 address 2001:db8:1::1/64', 'no shutdown');
    w.runFor(10 * SEC);
    const periodicBefore = ofIcmp6Type(w.sentBy('r1'), ICMPV6_RA).length;
    expect(periodicBefore).toBe(1);
    const start = w.now();
    w.iface('pc1', PC, 'ipv6 address autoconfig');
    w.runFor(5 * SEC);
    const pcMac = mac(w, 'pc1', PC);
    const pcLl = linkLocalFromMac(pcMac);
    const r1Ll = linkLocalFromMac(mac(w, 'r1', R1_LAN));
    const rs = ofIcmp6Type(w.sentBy('pc1'), ICMPV6_RS);
    expect(rs).toHaveLength(1);
    expect(ip6(rs[0]!)).toMatchObject({ src: pcLl, dst: 'ff02::2', hopLimit: 255 });
    expect(icmp6Of(rs[0]!)!.sourceLla).toBe(pcMac);
    const rsAt = w.sent.find((s) => s.pdu === rs[0])!.t;
    // RS after the link-local is preferred (1 s of DAD), within the 1 s random delay
    expect(rsAt - start).toBeGreaterThanOrEqual(SEC);
    expect(rsAt - start).toBeLessThanOrEqual(2 * SEC);
    const ras = ofIcmp6Type(w.sentBy('r1'), ICMPV6_RA).slice(periodicBefore);
    expect(ras).toHaveLength(1);
    const ra = ras[0]!;
    const raAt = w.sent.find((s) => s.pdu === ra)!.t;
    expect(raAt - rsAt).toBeLessThanOrEqual(500 * MS + 10_000);
    expect(ra.meta.triggeredBy).toBe(rs[0]!.id);
    expect(ra.meta.background).toBeUndefined();
    expect(ip6(ra)).toMatchObject({ src: r1Ll, dst: 'ff02::1', hopLimit: 255 });
    expect(icmp6Of(ra)).toMatchObject({
      prefix: '2001:db8:1::',
      prefixLen: 64,
      validLifetimeS: ND_RA_VALID_LIFETIME_S,
      preferredLifetimeS: ND_RA_PREFERRED_LIFETIME_S,
      mtu: 1500,
      sourceLla: mac(w, 'r1', R1_LAN),
      routerLifetimeS: 1800,
      managedFlag: false,
      otherFlag: false,
    });
    // SLAAC: EUI-64 address, DAD from ::, then preferred
    const slaac = eui64Address('2001:db8:1::', 64, pcMac)!;
    const dad = ofIcmp6Type(w.sentBy('pc1'), ICMPV6_NS).filter((p) => icmp6Of(p)!.target === slaac);
    expect(dad).toHaveLength(1);
    expect(ip6(dad[0]!).src).toBe('::');
    const a = addrs(w, 'pc1', PC).find((x) => x.address === slaac)!;
    expect(a).toMatchObject({ origin: 'slaac', scope: 'global', state: 'preferred', prefixLen: 64 });
    expect(a.validUntil! - a.preferredUntil!).toBe((ND_RA_VALID_LIFETIME_S - ND_RA_PREFERRED_LIFETIME_S) * SEC);
    // router entry STALE + isRouter, default route ND AD 2 via the router link-local
    expect(ndRows(w, 'pc1')).toEqual([
      expect.objectContaining({ key: ndKey(PC, r1Ll), ip: r1Ll, mac: mac(w, 'r1', R1_LAN), state: 'STALE', isRouter: true }),
    ]);
    const def = rib6(w, 'pc1').find((r) => r.key === '::/0')!;
    expect(def).toMatchObject({ source: 'ND', ad: 2, nextHop: r1Ll, iface: PC, isDefault: true });
    expect(rib6(w, 'pc1').map((r) => `${r.source} ${r.key}`)).toEqual(['ND ::/0', 'C 2001:db8:1::/64', `L ${slaac}/128`]);
    // and the router learned the soliciting host (STALE)
    expect(ndRows(w, 'r1')).toEqual([expect.objectContaining({ ip: pcLl, mac: pcMac, state: 'STALE', isRouter: false })]);
  });

  it('retries router solicitation every 4 s up to 3 times when no router answers', () => {
    const w = pair();
    w.iface('r1', R1_LAN, 'ipv6 address 2001:db8:1::1/64', 'no shutdown');
    w.iface('pc1', PC, 'ipv6 address autoconfig');
    w.runFor(30 * SEC);
    const times = w.sent.filter((s) => s.from.device === 'pc1' && icmp6Of(s.pdu)?.type === ICMPV6_RS).map((s) => s.t);
    expect(times).toHaveLength(3);
    expect(times[1]! - times[0]!).toBe(ND_RS_INTERVAL_NS);
    expect(times[2]! - times[1]!).toBe(ND_RS_INTERVAL_NS);
    // no RA from a device without ipv6 unicast-routing
    expect(ofIcmp6Type(w.sentBy('r1'), ICMPV6_RA)).toHaveLength(0);
    expect(addrs(w, 'pc1', PC)).toHaveLength(1);
  });

  it('advertises periodically (first within 500 ms, then every 200 s, as background traffic) and stops on suppress-ra', () => {
    const w = pair(7);
    w.global('r1', 'ipv6 unicast-routing');
    w.iface('r1', R1_LAN, 'ipv6 address 2001:db8:1::1/64', 'no shutdown');
    const start = w.now();
    w.runFor(402 * SEC);
    const ras = w.sent.filter((s) => s.from.device === 'r1' && icmp6Of(s.pdu)?.type === ICMPV6_RA);
    expect(ras).toHaveLength(3);
    const first = ras[0]!.t - start - SEC; // after the link-local DAD
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(500 * MS + 10_000);
    expect(ras[1]!.t - ras[0]!.t).toBe(ND_RA_INTERVAL_NS);
    expect(ras[2]!.t - ras[1]!.t).toBe(ND_RA_INTERVAL_NS);
    for (const r of ras) expect(r.pdu.meta.background).toBe(true);
    w.iface('r1', R1_LAN, 'ipv6 nd suppress-ra');
    w.runFor(401 * SEC);
    expect(ofIcmp6Type(w.sentBy('r1'), ICMPV6_RA)).toHaveLength(3);
    w.iface('r1', R1_LAN, 'no ipv6 nd suppress-ra');
    w.runFor(SEC);
    expect(ofIcmp6Type(w.sentBy('r1'), ICMPV6_RA)).toHaveLength(4);
    w.global('r1', 'no ipv6 unicast-routing');
    w.runFor(401 * SEC);
    expect(ofIcmp6Type(w.sentBy('r1'), ICMPV6_RA)).toHaveLength(4);
  });

  it('a router lifetime of 0 withdraws the ND default route', () => {
    const w = pair();
    w.iface('r1', R1_LAN, 'ipv6 address 2001:db8:1::1/64', 'no shutdown');
    w.iface('pc1', PC, 'ipv6 address autoconfig');
    w.runFor(5 * SEC);
    const r1Ll = linkLocalFromMac(mac(w, 'r1', R1_LAN));
    const ra = (lifetime: number): Pdu => w.build([
      { proto: 'ethernet', fields: { dst: '33:33:00:00:00:01', src: mac(w, 'r1', R1_LAN), type: 0x86dd } },
      { proto: 'ipv6', fields: { src: r1Ll, dst: 'ff02::1', nextHeader: 58, hopLimit: 255 } },
      { proto: 'icmpv6', fields: { type: ICMPV6_RA, routerLifetimeS: lifetime, sourceLla: mac(w, 'r1', R1_LAN), prefix: '2001:db8:1::', prefixLen: 64, validLifetimeS: 3600, preferredLifetimeS: 1800 } },
    ]);
    w.dev('pc1').onFrameArrival(PC, ra(600), false, w.now());
    expect(rib6(w, 'pc1').find((r) => r.key === '::/0')).toMatchObject({ source: 'ND', expiresAt: w.now() + 600 * SEC });
    w.dev('pc1').onFrameArrival(PC, ra(0), false, w.now());
    expect(rib6(w, 'pc1').find((r) => r.key === '::/0')).toBeUndefined();
    // the prefix still autoconfigured an address
    expect(addrs(w, 'pc1', PC).some((a) => a.origin === 'slaac')).toBe(true);
  });

  it('expires the ND default router and deprecates then removes the SLAAC address with its lifetimes', () => {
    const w = pair();
    w.iface('r1', R1_LAN, 'ipv6 address 2001:db8:1::1/64', 'no shutdown');
    w.iface('pc1', PC, 'ipv6 address autoconfig');
    w.runFor(5 * SEC);
    const r1Ll = linkLocalFromMac(mac(w, 'r1', R1_LAN));
    const t0 = w.now();
    w.dev('pc1').onFrameArrival(PC, w.build([
      { proto: 'ethernet', fields: { dst: '33:33:00:00:00:01', src: mac(w, 'r1', R1_LAN), type: 0x86dd } },
      { proto: 'ipv6', fields: { src: r1Ll, dst: 'ff02::1', nextHeader: 58, hopLimit: 255 } },
      { proto: 'icmpv6', fields: { type: ICMPV6_RA, routerLifetimeS: 100, sourceLla: mac(w, 'r1', R1_LAN), prefix: '2001:db8:7::', prefixLen: 64, validLifetimeS: 300, preferredLifetimeS: 120 } },
    ]), false, t0);
    const slaac = eui64Address('2001:db8:7::', 64, mac(w, 'pc1', PC))!;
    w.runFor(2 * SEC);
    expect(addrs(w, 'pc1', PC).find((a) => a.address === slaac)!.state).toBe('preferred');
    w.runUntil(t0 + 100 * SEC);
    expect(rib6(w, 'pc1').find((r) => r.key === '::/0')).toBeUndefined();
    w.runUntil(t0 + 120 * SEC);
    expect(addrs(w, 'pc1', PC).find((a) => a.address === slaac)!.state).toBe('deprecated');
    w.runUntil(t0 + 300 * SEC);
    expect(addrs(w, 'pc1', PC).find((a) => a.address === slaac)).toBeUndefined();
    expect(rib6(w, 'pc1').some((r) => r.network.startsWith('2001:db8:7'))).toBe(false);
    // the expiry is reported on the ipv6 debug stream
    const expired = w.events.some((e) => e.kind === 'debug' && e.event.process === 'ipv6' && e.event.message === `autoconfigured ${slaac} on ${PC} expired`);
    expect(expired).toBe(true);
  });
});

describe('ip6.nd neighbour cache (RFC 4861 §7.2, §7.3)', () => {
  /** R1 routing with 2001:db8:1::1 and a SLAAC host, settled. */
  function lan(): { w: World6; pcAddr: Ipv6Address } {
    const w = pair(5);
    w.global('r1', 'ipv6 unicast-routing');
    w.iface('r1', R1_LAN, 'ipv6 address 2001:db8:1::1/64', 'no shutdown');
    w.iface('pc1', PC, 'ipv6 address autoconfig');
    w.runFor(5 * SEC);
    return { w, pcAddr: eui64Address('2001:db8:1::', 64, mac(w, 'pc1', PC))! };
  }

  it('resolves with a multicast NS, answers with a solicited NA, and walks STALE → DELAY → PROBE → REACHABLE → STALE', () => {
    const { w, pcAddr } = lan();
    const s = 's1';
    w.request('pc1', 'icmpv6', { kind: 'icmp6.ping', session: s, target: '2001:db8:1::1', count: 1, timeoutNs: 2 * SEC, sizeBytes: 100 });
    w.runFor(100 * MS);
    expect(w.output(s)).toContain('!');
    // pc1 resolved the router's global address: multicast NS to its solicited-node group, solicited NA back
    const ns = ofIcmp6Type(w.sentBy('pc1'), ICMPV6_NS).filter((p) => icmp6Of(p)!.target === '2001:db8:1::1');
    expect(ns).toHaveLength(1);
    expect(ip6(ns[0]!)).toMatchObject({ src: pcAddr, dst: solicitedNodeMulticast('2001:db8:1::1'), hopLimit: 255 });
    expect(icmp6Of(ns[0]!)!.sourceLla).toBe(mac(w, 'pc1', PC));
    const na = ofIcmp6Type(w.sentBy('r1'), ICMPV6_NA);
    expect(na).toHaveLength(1);
    expect(ip6(na[0]!)).toMatchObject({ src: '2001:db8:1::1', dst: pcAddr, hopLimit: 255 });
    expect(icmp6Of(na[0]!)).toMatchObject({ target: '2001:db8:1::1', solicitedFlag: true, overrideFlag: true, routerFlag: true, targetLla: mac(w, 'r1', R1_LAN) });
    expect(na[0]!.layer('ethernet')!.fields.dst).toBe(mac(w, 'pc1', PC));
    const pcEntry = (): NdRow | undefined => ndRows(w, 'pc1').find((r) => r.ip === '2001:db8:1::1');
    expect(pcEntry()).toMatchObject({ state: 'REACHABLE', isRouter: true, mac: mac(w, 'r1', R1_LAN) });
    // r1 learned pc1 from the NS (STALE), used it for the reply → DELAY
    const r1Entry = (): NdRow | undefined => ndRows(w, 'r1').find((r) => r.ip === pcAddr);
    expect(r1Entry()!.state).toBe('DELAY');
    w.runFor(5 * SEC);
    // after the 5 s delay r1 probes with a unicast NS and pc1's solicited answer makes it REACHABLE
    const probe = ofIcmp6Type(w.sentBy('r1'), ICMPV6_NS).filter((p) => icmp6Of(p)!.target === pcAddr);
    expect(probe).toHaveLength(1);
    expect(ip6(probe[0]!).dst).toBe(pcAddr);
    expect(probe[0]!.layer('ethernet')!.fields.dst).toBe(mac(w, 'pc1', PC));
    expect(r1Entry()!.state).toBe('REACHABLE');
    w.runFor(ND_REACHABLE_NS);
    expect(r1Entry()!.state).toBe('STALE');
    expect(pcEntry()!.state).toBe('STALE');
  });

  it('gives up after 3 multicast solicitations 1 s apart and drops the queued packet arp-unresolved', () => {
    const { w } = lan();
    const s = 's2';
    const t0 = w.now();
    w.request('pc1', 'icmpv6', { kind: 'icmp6.ping', session: s, target: '2001:db8:1::77', count: 1, timeoutNs: 5 * SEC, sizeBytes: 100 });
    w.runFor(6 * SEC);
    const ns = w.sent.filter((x) => x.from.device === 'pc1' && icmp6Of(x.pdu)?.type === ICMPV6_NS && icmp6Of(x.pdu)!.target === '2001:db8:1::77');
    expect(ns.map((x) => x.t - t0)).toEqual([0, SEC, 2 * SEC]);
    const drops = w.kinds('drop').filter((d) => d.device === 'pc1' && d.reason === 'arp-unresolved');
    expect(drops).toHaveLength(1);
    expect(ndRows(w, 'pc1').some((r) => r.ip === '2001:db8:1::77')).toBe(false);
    expect(w.output(s)).toContain('.');
    // locally originated: no address-unreachable error to itself
    expect(w.kinds('pduCreated').some((e) => e.device === 'pc1' && e.pdu.tag === 'icmp6-unreachable')).toBe(false);
  });

  it('sends address unreachable to the source of a forwarded packet whose next hop does not resolve', () => {
    const { w, pcAddr } = lan();
    const s = 's3';
    // a /64 on R1's second port with nobody behind it
    w.add('pc9', 'pc');
    w.link({ device: 'r1', port: 'GigabitEthernet0/1' }, { device: 'pc9', port: PC });
    w.runFor(BOOT_NS);
    w.iface('r1', 'GigabitEthernet0/1', 'ipv6 address 2001:db8:2::1/64', 'no shutdown');
    w.runFor(2 * SEC);
    w.request('pc1', 'icmpv6', { kind: 'icmp6.ping', session: s, target: '2001:db8:2::99', count: 1, timeoutNs: 5 * SEC, sizeBytes: 100 });
    w.runFor(5 * SEC);
    const err = w.sentBy('r1').filter((p) => icmp6Of(p)?.type === 1);
    expect(err).toHaveLength(1);
    expect(icmp6Of(err[0]!)!.code).toBe(3);
    expect(ip6(err[0]!).dst).toBe(pcAddr);
    expect(w.output(s)).toContain('U');
  });

  it('ignores neighbour discovery with a hop limit other than 255', () => {
    const { w } = lan();
    const r1Ll = linkLocalFromMac(mac(w, 'r1', R1_LAN));
    const forged = w.build([
      { proto: 'ethernet', fields: { dst: '33:33:00:00:00:01', src: '02:00:00:00:00:99', type: 0x86dd } },
      { proto: 'ipv6', fields: { src: 'fe80::99', dst: 'ff02::1', nextHeader: 58, hopLimit: 254 } },
      { proto: 'icmpv6', fields: { type: ICMPV6_RA, routerLifetimeS: 1800, sourceLla: '02:00:00:00:00:99', prefix: '2001:db8:66::', prefixLen: 64, validLifetimeS: 3600, preferredLifetimeS: 1800 } },
    ]);
    w.dev('pc1').onFrameArrival(PC, forged, false, w.now());
    expect(w.kinds('drop').some((d) => d.device === 'pc1' && d.detail?.includes('hop limit 254'))).toBe(true);
    expect(rib6(w, 'pc1').find((r) => r.key === '::/0')!.nextHop).toBe(r1Ll);
    expect(addrs(w, 'pc1', PC).some((a) => a.address.startsWith('2001:db8:66'))).toBe(false);
  });

  it('removes the entries of a port that goes down', () => {
    const { w } = lan();
    expect(ndRows(w, 'pc1').length).toBeGreaterThan(0);
    w.iface('pc1', PC, 'shutdown');
    w.runFor(SEC);
    expect(ndRows(w, 'pc1')).toEqual([]);
    expect(addrs(w, 'pc1', PC).every((a) => a.state === 'tentative')).toBe(true);
    expect(rib6(w, 'pc1')).toEqual([]);
  });
});

describe('ip6.nd on serial links (§3.9: HDLC 0x86dd, no neighbour resolution)', () => {
  it('frames DAD and data in HDLC protocol 0x86dd without neighbour entries, and ping -6 crosses the link', () => {
    const w = createWorld6();
    w.add('r1', 'router');
    w.add('r2', 'router');
    w.link({ device: 'r1', port: 'Serial0/0/0' }, { device: 'r2', port: 'Serial0/0/0' });
    w.runFor(BOOT_NS);
    w.global('r1', 'ipv6 unicast-routing');
    w.global('r2', 'ipv6 unicast-routing');
    w.iface('r1', 'Serial0/0/0', 'ipv6 address 2001:db8:12::1/64', 'no shutdown');
    w.iface('r2', 'Serial0/0/0', 'ipv6 address 2001:db8:12::2/64', 'no shutdown');
    w.runFor(2 * SEC);
    const dad = ofIcmp6Type(w.sentBy('r1'), ICMPV6_NS);
    expect(dad.length).toBeGreaterThanOrEqual(2);
    for (const p of dad) expect(p.layers[0]!).toMatchObject({ proto: 'hdlc', fields: expect.objectContaining({ protocol: 0x86dd, address: 0x0f }) });
    const ra = ofIcmp6Type(w.sentBy('r1'), ICMPV6_RA)[0]!;
    expect(ra.layers[0]!.proto).toBe('hdlc');
    expect(icmp6Of(ra)!.sourceLla).toBeUndefined();
    const s = 'se';
    w.request('r1', 'icmpv6', { kind: 'icmp6.ping', session: s, target: '2001:db8:12::2', count: 5, timeoutNs: 2 * SEC, sizeBytes: 100 });
    w.runFor(5 * SEC);
    expect(w.output(s)).toContain('!!!!!');
    expect(ndRows(w, 'r1')).toEqual([]);
    expect(ndRows(w, 'r2')).toEqual([]);
  });
});

describe('ip6.nd silence and determinism (§5.1, §5.3)', () => {
  it('sends nothing without IPv6 configuration, even with ipv6 unicast-routing', () => {
    const w = pair();
    w.global('r1', 'ipv6 unicast-routing');
    w.iface('r1', R1_LAN, 'no shutdown');
    w.runFor(600 * SEC);
    expect(w.sent.filter((s) => s.pdu.layer('ipv6') !== undefined)).toEqual([]);
    expect(w.kinds('pduCreated').filter((e) => ['ipv6', 'nd', 'icmpv6'].includes(e.process))).toEqual([]);
    expect(w.dev('r1').port(R1_LAN)!.l3.ipv6).toBeUndefined();
    expect(w.dev('pc1').port(PC)!.l3.groups6).toBeUndefined();
  });

  it('gives byte-identical traffic for the same seed', () => {
    const run = (): string[] => {
      const w = pair(11);
      w.global('r1', 'ipv6 unicast-routing');
      w.iface('r1', R1_LAN, 'ipv6 address 2001:db8:1::1/64', 'no shutdown');
      w.iface('pc1', PC, 'ipv6 address autoconfig');
      w.runFor(250 * SEC);
      return w.sent.map((s) => `${s.t} ${s.from.device} ${Array.from(s.pdu.bytes).join(',')}`);
    };
    const a = run();
    expect(a.length).toBeGreaterThan(5);
    expect(run()).toEqual(a);
  });
});
