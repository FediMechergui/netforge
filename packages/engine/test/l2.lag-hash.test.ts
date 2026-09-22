/**
 * W1 l2 (ARCHITECTURE-P2 D10, §3.7 step 5, #38): the EtherChannel load-balance hash.
 *  - the five-octet MAC fold (the fixed 0x02 prefix excluded, the port-ordinal octet included but not alone);
 *  - single-NIC PCs (every MAC ends in :01) spread over the members;
 *  - every method, the IP → MAC fallback for non-IPv4 frames, `hash mod n` over the members in the given order;
 *  - the `port-channel load-balance` reader.
 */
import { describe, expect, it } from 'vitest';
import { configAstFromJson } from '../src/cli/config-ast.js';
import { deviceMacBase, portMac } from '../src/contracts/addr.js';
import type { ConfigNode } from '../src/contracts/config.js';
import { ETHERTYPE_ARP, ETHERTYPE_IPV4, IPPROTO_ICMP } from '../src/contracts/pdu.js';
import type { FieldValue, LayerView, PduView } from '../src/contracts/pdu.js';
import {
  DEFAULT_LOAD_BALANCE,
  LOAD_BALANCE_METHODS,
  ipv4Fold,
  lagFrameKeys,
  lagHash,
  lagMemberIndex,
  macFold,
  noActiveMemberDetail,
  pickLagMember,
  readLoadBalance,
} from '../src/protocols/l2/lag-hash.js';

/** A decoded layer carrying only fields (the field names of contracts/fields.ts). */
function layer(proto: string, fields: Record<string, FieldValue>): LayerView {
  return { proto, offset: 0, length: 0, headerLength: 0, fields, fieldRanges: {} };
}
function ipFrame(srcMac: string, dstMac: string, src: string, dst: string): Pick<PduView, 'layers'> {
  return {
    layers: [
      layer('ethernet', { dst: dstMac, src: srcMac, type: ETHERTYPE_IPV4 }),
      layer('ipv4', { src, dst, protocol: IPPROTO_ICMP, ttl: 128 }),
      layer('icmpv4', { type: 8, code: 0, id: 1, seq: 1 }),
    ],
  };
}
function arpFrame(srcMac: string, dstMac: string): Pick<PduView, 'layers'> {
  return {
    layers: [
      layer('ethernet', { dst: dstMac, src: srcMac, type: ETHERTYPE_ARP }),
      layer('arp', { op: 1, sha: srcMac, spa: '10.0.0.1', tha: '00:00:00:00:00:00', tpa: '10.0.0.2' }),
    ],
  };
}
/** A tagged frame: the tag sits at layers[1] (D4); the IPv4 header still hashes. */
function taggedIpFrame(srcMac: string, dstMac: string, src: string, dst: string): Pick<PduView, 'layers'> {
  return {
    layers: [
      layer('ethernet', { dst: dstMac, src: srcMac, type: 0x8100 }),
      layer('dot1q', { vid: 10, type: ETHERTYPE_IPV4 }),
      layer('ipv4', { src, dst, protocol: IPPROTO_ICMP, ttl: 128 }),
    ],
  };
}

/** The NIC of a single-NIC host with device id `id` (ordinal 1). */
const nic = (id: string): string => portMac(deviceMacBase(id), 1);

describe('the fold', () => {
  it('XORs octets 1–5 and ignores the fixed first octet', () => {
    // portMac(deviceMacBase('d_0001'), 1) = '02:4e:59:e8:af:01'; 0x4e ^ 0x59 ^ 0xe8 ^ 0xaf ^ 0x01 = 0x51
    expect(nic('d_0001')).toBe('02:4e:59:e8:af:01');
    expect(macFold('02:4e:59:e8:af:01')).toBe(0x51);
    expect(macFold('06:4e:59:e8:af:01')).toBe(0x51);
    expect(macFold('02:00:00:00:00:00')).toBe(0);
    expect(macFold('02:00:00:00:00:07')).toBe(7);
    expect(macFold('02:ff:00:00:00:00')).toBe(0xff);
    expect(macFold('02:4E:59:E8:AF:01')).toBe(0x51);
    expect(macFold('not a mac')).toBe(0);
  });

  it('single-NIC PCs (all ending in :01) spread over two and four members', () => {
    const ids = ['d_0001', 'd_0002', 'd_0003', 'd_0004', 'd_0005', 'd_0006', 'd_0007', 'd_0008'];
    const macs = ids.map(nic);
    expect(macs.every((m) => m.endsWith(':01'))).toBe(true);
    const two = macs.map((m) => lagMemberIndex('src-mac', { srcMac: m, dstMac: 'ff:ff:ff:ff:ff:ff' }, 2));
    expect(two).toEqual([1, 0, 1, 0, 0, 0, 1, 1]);
    const four = macs.map((m) => lagMemberIndex('src-mac', { srcMac: m, dstMac: 'ff:ff:ff:ff:ff:ff' }, 4));
    expect(new Set(four)).toEqual(new Set([0, 1, 2, 3]));
    // hashing only the last octet would put every one of them on member 1 of 2
    expect(new Set(macs.map((m) => parseInt(m.slice(15), 16) % 2))).toEqual(new Set([1]));
  });

  it('ipv4Fold XORs the four octets', () => {
    expect(ipv4Fold('192.168.1.10')).toBe(192 ^ 168 ^ 1 ^ 10);
    expect(ipv4Fold('0.0.0.0')).toBe(0);
    expect(ipv4Fold('255.255.255.255')).toBe(0);
    expect(ipv4Fold('bogus')).toBe(0);
  });
});

describe('methods', () => {
  const src = '02:4e:59:e8:af:01';
  const dst = '02:dc:52:79:74:01';
  const ip = { srcMac: src, dstMac: dst, srcIp: '192.168.1.10', dstIp: '203.0.113.10' };
  const nonIp = { srcMac: src, dstMac: dst };

  it('every §5.1 method, default src-mac', () => {
    expect(LOAD_BALANCE_METHODS).toEqual(['src-mac', 'dst-mac', 'src-dst-mac', 'src-ip', 'dst-ip', 'src-dst-ip']);
    expect(DEFAULT_LOAD_BALANCE).toBe('src-mac');
    expect(lagHash('src-mac', ip)).toBe(macFold(src));
    expect(lagHash('dst-mac', ip)).toBe(macFold(dst));
    expect(lagHash('src-dst-mac', ip)).toBe(macFold(src) ^ macFold(dst));
    expect(lagHash('src-ip', ip)).toBe(ipv4Fold('192.168.1.10'));
    expect(lagHash('dst-ip', ip)).toBe(ipv4Fold('203.0.113.10'));
    expect(lagHash('src-dst-ip', ip)).toBe(ipv4Fold('192.168.1.10') ^ ipv4Fold('203.0.113.10'));
  });

  it('IP methods fall back to their MAC variant for a non-IPv4 frame', () => {
    expect(lagHash('src-ip', nonIp)).toBe(macFold(src));
    expect(lagHash('dst-ip', nonIp)).toBe(macFold(dst));
    expect(lagHash('src-dst-ip', nonIp)).toBe(macFold(src) ^ macFold(dst));
  });

  it('member index = hash mod n; no member → undefined', () => {
    for (const n of [1, 2, 3, 4, 8]) expect(lagMemberIndex('src-dst-mac', ip, n)).toBe((macFold(src) ^ macFold(dst)) % n);
    expect(lagMemberIndex('src-mac', ip, 0)).toBeUndefined();
  });
});

describe('frames', () => {
  it('reads the outer Ethernet and the first IPv4 addresses of a frame, tagged or not', () => {
    const f = ipFrame(nic('d_0001'), nic('d_0002'), '192.168.1.10', '192.168.1.20');
    expect(lagFrameKeys(f)).toEqual({ srcMac: nic('d_0001'), dstMac: nic('d_0002'), srcIp: '192.168.1.10', dstIp: '192.168.1.20' });
    const a = arpFrame(nic('d_0003'), 'ff:ff:ff:ff:ff:ff');
    expect(lagFrameKeys(a)).toEqual({ srcMac: nic('d_0003'), dstMac: 'ff:ff:ff:ff:ff:ff' });
    const t = taggedIpFrame(nic('d_0001'), nic('d_0002'), '10.0.0.1', '10.0.0.2');
    expect(lagFrameKeys(t)).toEqual({ srcMac: nic('d_0001'), dstMac: nic('d_0002'), srcIp: '10.0.0.1', dstIp: '10.0.0.2' });
  });

  it('pickLagMember picks members[hash mod n] in the order given (canonical port order)', () => {
    const members = ['GigabitEthernet0/1', 'GigabitEthernet0/2'];
    // d_0001 folds to 0x51 (odd) → member 1; d_0002 folds to 130 (even) → member 0
    expect(pickLagMember('src-mac', ipFrame(nic('d_0001'), nic('d_0002'), '10.0.0.1', '10.0.0.2'), members)).toBe('GigabitEthernet0/2');
    expect(pickLagMember('src-mac', arpFrame(nic('d_0002'), 'ff:ff:ff:ff:ff:ff'), members)).toBe('GigabitEthernet0/1');
    expect(pickLagMember('dst-mac', arpFrame(nic('d_0002'), nic('d_0001')), members)).toBe('GigabitEthernet0/2');
    expect(pickLagMember('src-ip', arpFrame(nic('d_0002'), nic('d_0001')), members)).toBe('GigabitEthernet0/1');
    expect(pickLagMember('src-mac', arpFrame(nic('d_0001'), 'ff:ff:ff:ff:ff:ff'), [])).toBeUndefined();
    expect(noActiveMemberDetail('Port-channel1')).toBe('Port-channel1 has no active member');
  });
});

describe('readLoadBalance', () => {
  const cfg = (lines: readonly string[]) => {
    const root: ConfigNode = { key: '', args: [], children: lines.map((l) => { const t = l.split(' '); return { key: t[0] as string, args: t.slice(1), children: [] }; }) };
    return configAstFromJson(root);
  };

  it('reads the global line, default src-mac, unknown methods ignored', () => {
    expect(readLoadBalance(cfg([]))).toBe('src-mac');
    expect(readLoadBalance(cfg(['port-channel load-balance src-dst-ip']))).toBe('src-dst-ip');
    expect(readLoadBalance(cfg(['port-channel load-balance round-robin']))).toBe('src-mac');
  });
});
