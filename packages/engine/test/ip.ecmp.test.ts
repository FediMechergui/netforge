/**
 * ip.ecmp [S6] — equal-cost multipath for static routes (ARCHITECTURE-P2 D13, §2.6 `RouteRow.paths`, §4.1 flow hash):
 * two usable `ip route` lines for one prefix with the same distance install one row carrying `paths` (each with its
 * line as cause); forwarding picks the path with the fixed hash `ecmpIndex`; a line of another distance, a
 * withdrawn line or an unusable line leaves the set; at most `IPV4_MAX_PATHS` paths. The same for IPv6 lines.
 */
import { describe, expect, it } from 'vitest';
import { ipv4ToU32 } from '../src/contracts/addr.js';
import type { ConfigDelta } from '../src/contracts/config.js';
import { SEC } from '../src/contracts/time.js';
import { IPV4_MAX_PATHS, createIpv4, ecmpIndex } from '../src/protocols/ipv4.js';
import { IPV6_MAX_PATHS, ecmpIndex6 } from '../src/protocols/ipv6.js';
import { echoRequest, framed, makeFake, makeSink } from './ip.fake-ctx.js';

const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';
const MAC_R0 = '00:1f:00:00:00:10';
const MAC_R1 = '00:1f:00:00:00:11';
const MAC_PC = '00:1f:00:00:00:01';
const MASK24 = '255.255.255.0';

const setRoute = (...args: string[]): ConfigDelta => ({ op: 'set', context: [], line: ['ip', 'route', ...args] });
const unsetRoute = (...args: string[]): ConfigDelta => ({ op: 'unset', context: [], line: ['ip', 'route', ...args] });

function router() {
  const fake = makeFake({ kind: 'router', ports: [{ id: GI0, mac: MAC_R0 }, { id: GI1, mac: MAC_R1 }] });
  const ipv4 = createIpv4();
  const arp = makeSink('arp');
  fake.register(ipv4);
  fake.register(arp);
  fake.register(makeSink('icmpv4'));
  fake.run(ipv4.onConfig(fake.ctx, { op: 'set', context: [['interface', GI0]], line: ['ip', 'address', '10.0.0.1', MASK24] }));
  fake.run(ipv4.onConfig(fake.ctx, { op: 'set', context: [['interface', GI1]], line: ['ip', 'address', '10.0.1.1', MASK24] }));
  arp.requests.length = 0;
  return { fake, ipv4, arp };
}

/** The §4.1 hash, spelled out independently. */
function expectedIndex(src: string, dst: string, n: number): number {
  let h = (ipv4ToU32(src) ^ ipv4ToU32(dst)) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h % n;
}

describe('ip.ecmp [S6] flow hash', () => {
  it('is the fixed integer function of §4.1 and spreads flows over the paths', () => {
    expect(ecmpIndex('10.0.0.2', '10.5.0.5', 1)).toBe(0);
    for (const [s, d] of [['10.0.0.2', '10.5.0.5'], ['10.0.0.3', '10.5.0.5'], ['192.168.1.77', '8.8.8.8'], ['172.16.255.1', '10.5.0.6']]) {
      for (const n of [2, 3, 4]) expect(ecmpIndex(s!, d!, n)).toBe(expectedIndex(s!, d!, n));
    }
    const seen = new Set<number>();
    for (let i = 2; i < 40; i++) seen.add(ecmpIndex(`10.0.0.${i}`, '10.5.0.5', 2));
    expect(Array.from(seen).sort()).toEqual([0, 1]);
    expect(ecmpIndex6('2001:db8:1::10', '2001:db8:2::20', 1)).toBe(0);
    const seen6 = new Set<number>();
    for (let i = 1; i < 40; i++) seen6.add(ecmpIndex6(`2001:db8:1::${i}`, '2001:db8:2::20', 2));
    expect(Array.from(seen6).sort()).toEqual([0, 1]);
    expect(ecmpIndex6('2001:db8:1::1', '2001:db8:2::2', 4)).toBe(ecmpIndex6('2001:db8:1::1', '2001:db8:2::2', 4));
    expect(IPV4_MAX_PATHS).toBe(4);
    expect(IPV6_MAX_PATHS).toBe(4);
  });
});

describe('ip.ecmp [S6] installation and forwarding', () => {
  it('two equal-distance lines for one prefix install one row with paths; each flow leaves by its hashed path', () => {
    const { fake, ipv4, arp } = router();
    ipv4.onConfig(fake.ctx, setRoute('10.5.0.0', MASK24, '10.0.0.9'));
    ipv4.onConfig(fake.ctx, setRoute('10.5.0.0', MASK24, '10.0.1.9'));
    const row = fake.tables.rib.get('10.5.0.0/24')!;
    expect(row).toMatchObject({ source: 'S', nextHop: '10.0.0.9', ad: 1, metric: 0 });
    expect(row.paths).toEqual([
      { nextHop: '10.0.0.9', cause: `ip route 10.5.0.0 ${MASK24} 10.0.0.9` },
      { nextHop: '10.0.1.9', cause: `ip route 10.5.0.0 ${MASK24} 10.0.1.9` },
    ]);
    expect(fake.tables.rib.size).toBe(5);
    expect(fake.debug.at(-1)!.message).toBe('add S 10.5.0.0/24 via 10.0.1.9 (equal-cost path 2 of 2)');
    // pick two sources that hash to different paths
    const srcs = ['10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5', '10.0.0.6'];
    const a = srcs.find((s) => expectedIndex(s, '10.5.0.5', 2) === 0)!;
    const b = srcs.find((s) => expectedIndex(s, '10.5.0.5', 2) === 1)!;
    const pa = fake.build(framed(MAC_R0, MAC_PC, echoRequest(a, '10.5.0.5', 1, 1, 64)));
    fake.run(ipv4.onPdu(fake.ctx, pa, GI0));
    expect(arp.requests[0]).toEqual({ kind: 'arp.sendVia', pdu: pa, nextHop: '10.0.0.9', iface: GI0, cause: `ip route 10.5.0.0 ${MASK24} 10.0.0.9` });
    expect(pa.provenance[0]).toMatchObject({ reason: 'TtlDecrement', cause: `ip route 10.5.0.0 ${MASK24} 10.0.0.9` });
    const pb = fake.build(framed(MAC_R0, MAC_PC, echoRequest(b, '10.5.0.5', 1, 1, 64)));
    fake.run(ipv4.onPdu(fake.ctx, pb, GI0));
    expect(arp.requests[1]).toEqual({ kind: 'arp.sendVia', pdu: pb, nextHop: '10.0.1.9', iface: GI1, cause: `ip route 10.5.0.0 ${MASK24} 10.0.1.9` });
    // the same flow always takes the same path
    const pa2 = fake.build(framed(MAC_R0, MAC_PC, echoRequest(a, '10.5.0.5', 1, 2, 64)));
    fake.run(ipv4.onPdu(fake.ctx, pa2, GI0));
    expect(arp.requests[2]).toMatchObject({ nextHop: '10.0.0.9' });
    // a locally originated packet uses the hash too
    const own = fake.build(echoRequest(a, '10.5.0.5', 9, 1, 128));
    fake.run(ipv4.onRequest!(fake.ctx, { kind: 'ipv4.send', pdu: own }));
    expect(arp.requests[3]).toMatchObject({ pdu: own, nextHop: '10.0.0.9', iface: GI0 });
  });

  it('a different distance stays out of the set; a withdrawn or unusable line leaves it and a single path has no paths key', () => {
    const { fake, ipv4 } = router();
    ipv4.onConfig(fake.ctx, setRoute('10.5.0.0', MASK24, '10.0.0.9'));
    ipv4.onConfig(fake.ctx, setRoute('10.5.0.0', MASK24, '10.0.1.9'));
    ipv4.onConfig(fake.ctx, setRoute('10.5.0.0', MASK24, '10.0.1.8', '5'));
    expect(fake.tables.rib.get('10.5.0.0/24')!.paths).toHaveLength(2);
    ipv4.onConfig(fake.ctx, unsetRoute('10.5.0.0', MASK24, '10.0.0.9'));
    const single = fake.tables.rib.get('10.5.0.0/24')!;
    expect(single).toMatchObject({ nextHop: '10.0.1.9', ad: 1 });
    expect(single.paths).toBeUndefined();
    // the last equal line becomes unusable: the floating one takes over, alone
    fake.setNow(3 * SEC);
    fake.setOper(GI1, false);
    ipv4.onLinkChange!(fake.ctx, GI1, false);
    expect(fake.tables.rib.get('10.5.0.0/24')).toBeUndefined();
    fake.setOper(GI1, true);
    ipv4.onLinkChange!(fake.ctx, GI1, true);
    const back = fake.tables.rib.get('10.5.0.0/24')!;
    expect(back).toMatchObject({ nextHop: '10.0.1.9', ad: 1 });
    expect(back.paths).toBeUndefined();
    ipv4.onConfig(fake.ctx, setRoute('10.5.0.0', MASK24, '10.0.0.9'));
    expect(fake.tables.rib.get('10.5.0.0/24')!.paths!.map((p) => p.nextHop)).toEqual(['10.0.1.9', '10.0.0.9']);
  });

  it('caps the set at IPV4_MAX_PATHS and never mixes in routes offered by other daemons', () => {
    const { fake, ipv4 } = router();
    for (let i = 2; i <= 7; i++) ipv4.onConfig(fake.ctx, setRoute('0.0.0.0', '0.0.0.0', `10.0.0.${i}`));
    const row = fake.tables.rib.get('0.0.0.0/0')!;
    expect(row.paths).toHaveLength(IPV4_MAX_PATHS);
    expect(row.paths!.map((p) => p.nextHop)).toEqual(['10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5']);
    expect(row.isDefault).toBe(true);
    // the host daemon's default gateway (same key, same distance) is a separate candidate, never a path
    fake.run(ipv4.onRequest!(fake.ctx, {
      kind: 'ipv4.route', op: 'offer', owner: 'host',
      row: { key: '0.0.0.0/0', network: '0.0.0.0', prefixLen: 0, source: 'S', nextHop: '10.0.0.254', ad: 1, metric: 0, isDefault: true, updatedAt: 0, owner: 'host' },
    }));
    expect(fake.tables.rib.get('0.0.0.0/0')!.paths!.map((p) => p.nextHop)).toEqual(['10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5']);
    expect(fake.tables.rib.get('0.0.0.0/0')!.owner).toBeUndefined();
  });
});
