/**
 * 802.1Q push and pop through `Pdu.rewrap` with `RewrapOp.as` (ARCHITECTURE-P2 D4, §2.3, §3.0 step 12, §3.4).
 *
 * The provenance is exactly `[VlanTagPush, FcsRecompute]` / `[VlanTagPop, FcsRecompute]`, push then pop returns the
 * original bytes of any codec-built frame, and the router-on-a-stick mutation sequence of §3.4 is DERIVED here from
 * the calls the daemons really make (the order is asserted, not assumed).
 */
import { describe, expect, it } from 'vitest';
import {
  ARP_OP_REQUEST,
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  ETHERTYPE_IPV6,
  ETHERTYPE_VLAN,
  ICMP_ECHO_REQUEST,
  IPPROTO_ICMP,
  LLC_SAP_STP,
  STP_GROUP_MAC,
} from '../src/contracts/pdu.js';
import type { LayerSpec, MutationCtx, Pdu, PduMeta, RewrapOp } from '../src/contracts/pdu.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { vlanPopOp, vlanPushOp } from '../src/pdu/vlan.js';
import { STP_BPDU_CONFIG } from '../src/pdu/codecs/stp.js';

const meta = (): PduMeta => ({ born: 1000, origin: 'd_pc1' });
const at = (now: number, device: string): MutationCtx => ({ now, device });

const PC1 = '02:b3:b2:b1:b0:01';
const PC2 = '02:b3:b2:b1:b0:02';
const R1 = '02:b3:b2:b1:b0:0a';
const BASE = '02:b3:b2:b1:b0:00';

const protos = (p: Pdu): string[] => p.layers.map((l) => l.proto);
const reasons = (p: Pdu): string[] => p.provenance.map((m) => `${m.reason}:${m.field}`);

const arpFrame = (): LayerSpec[] => [
  { proto: 'ethernet', fields: { dst: 'ff:ff:ff:ff:ff:ff', src: PC1, type: ETHERTYPE_ARP } },
  { proto: 'arp', fields: { op: ARP_OP_REQUEST, sha: PC1, spa: '192.168.10.10', tha: '00:00:00:00:00:00', tpa: '192.168.10.1' } },
];

const echoFrame = (payloadLen = 56, ttl = 128): LayerSpec[] => [
  { proto: 'ethernet', fields: { dst: R1, src: PC1, type: ETHERTYPE_IPV4 } },
  { proto: 'ipv4', fields: { src: '192.168.10.10', dst: '192.168.20.10', protocol: IPPROTO_ICMP, ttl } },
  { proto: 'icmpv4', fields: { type: ICMP_ECHO_REQUEST, code: 0, id: 1, seq: 1 } },
  { proto: 'payload', fields: { data: new Uint8Array(payloadLen).map((_, i) => i & 0xff) } },
];

const bigFrame = (): LayerSpec[] => echoFrame(1500 - 20 - 8); // a 1518-byte frame at MTU 1500

const v6Frame = (): LayerSpec[] => [
  { proto: 'ethernet', fields: { dst: PC2, src: PC1, type: ETHERTYPE_IPV6 } },
  { proto: 'ipv6', fields: { src: '2001:db8:1::10', dst: '2001:db8:1::20', nextHeader: 58, hopLimit: 64 } },
  { proto: 'icmpv6', fields: { type: 128, code: 0, id: 1, seq: 1 } },
];

const bpduFrame = (): LayerSpec[] => [
  { proto: 'ethernet', fields: { dst: STP_GROUP_MAC, src: PC1, type: 0 } },
  { proto: 'llc', fields: { dsap: LLC_SAP_STP, ssap: LLC_SAP_STP, control: 3 } },
  {
    proto: 'stp',
    fields: {
      version: 0, bpduType: STP_BPDU_CONFIG, flags: 0, rootPriority: 32778, rootMac: BASE, rootPathCost: 0,
      bridgePriority: 32778, bridgeMac: BASE, portId: 0x8001, messageAge: 0, maxAge: 5120, helloTime: 512,
      forwardDelay: 3840, pvid: 10,
    },
  },
];

const unknownFrame = (): LayerSpec[] => [
  { proto: 'ethernet', fields: { dst: PC2, src: PC1, type: 0x88b5 } },
  { proto: 'payload', fields: { data: new Uint8Array(10).fill(7) } },
];

describe('vlanPushOp / vlanPopOp', () => {
  it('are the exact ops of §2.3 and validate their arguments', () => {
    expect(vlanPushOp(10)).toEqual({
      strip: 1,
      push: [{ proto: 'ethernet', fields: {} }, { proto: 'dot1q', fields: { pcp: 0, vid: 10 } }],
      as: 'vlan-push',
    });
    expect(vlanPushOp(20, 5).push[1]!.fields).toEqual({ pcp: 5, vid: 20 });
    expect(vlanPopOp()).toEqual({ strip: 2, push: [{ proto: 'ethernet', fields: {} }], as: 'vlan-pop' });
    expect(() => vlanPushOp(4096)).toThrow(RangeError);
    expect(() => vlanPushOp(10, 8)).toThrow(RangeError);
  });
});

describe('Pdu.rewrap as vlan-push / vlan-pop', () => {
  it('records exactly VlanTagPush then FcsRecompute, with the tag as the only change', () => {
    const f = createPduFactory();
    const p = f.build(arpFrame(), meta());
    const id = p.id;
    const fcsBefore = p.get('ethernet.fcs');
    p.rewrap(at(5000, 'd_sw1'), vlanPushOp(10), 'switchport mode trunk');

    expect(p.id).toBe(id);
    expect(protos(p)).toEqual(['ethernet', 'dot1q', 'arp']);
    expect(p.get('ethernet.type')).toBe(ETHERTYPE_VLAN);
    expect(p.get('dot1q.vid')).toBe(10);
    expect(p.get('dot1q.type')).toBe(ETHERTYPE_ARP);
    expect(p.get('ethernet.dst')).toBe('ff:ff:ff:ff:ff:ff');
    expect(p.get('ethernet.src')).toBe(PC1);
    expect(p.size).toBe(64); // re-padded to the 64-byte minimum
    expect(p.get('ethernet.padding')).toBe(14);
    expect(p.get('ethernet.fcsValid')).toBe(true);
    expect(p.provenance).toEqual([
      { at: 5000, device: 'd_sw1', reason: 'VlanTagPush', field: 'dot1q.vid', before: null, after: 10, cause: 'switchport mode trunk' },
      { at: 5000, device: 'd_sw1', reason: 'FcsRecompute', field: 'ethernet.fcs', before: fcsBefore, after: p.get('ethernet.fcs'), cause: 'switchport mode trunk' },
    ]);
  });

  it('records exactly VlanTagPop then FcsRecompute', () => {
    const f = createPduFactory();
    const p = f.build(arpFrame(), meta());
    p.rewrap(at(5000, 'd_sw1'), vlanPushOp(10), 'switchport mode trunk');
    const tagged = p.get('ethernet.fcs');
    p.rewrap(at(6000, 'd_sw2'), vlanPopOp(), 'switchport access vlan 10');
    expect(protos(p)).toEqual(['ethernet', 'arp']);
    expect(p.get('ethernet.type')).toBe(ETHERTYPE_ARP);
    expect(p.provenance.slice(2)).toEqual([
      { at: 6000, device: 'd_sw2', reason: 'VlanTagPop', field: 'dot1q.vid', before: 10, after: null, cause: 'switchport access vlan 10' },
      { at: 6000, device: 'd_sw2', reason: 'FcsRecompute', field: 'ethernet.fcs', before: tagged, after: p.get('ethernet.fcs'), cause: 'switchport access vlan 10' },
    ]);
  });

  it('push then pop returns the original bytes of an ARP, a 1500-byte IPv4, an IPv6 and an 802.3/LLC frame', () => {
    const f = createPduFactory();
    for (const [name, specs, tagged] of [
      ['arp', arpFrame(), 64],
      ['ipv4-1500', bigFrame(), 1522],
      ['ipv6', v6Frame(), 70], // 14 + 4 + 40 + 8 + 4: long enough that the tag adds bytes instead of eating padding
      ['802.3 BPDU', bpduFrame(), 66], // 14 + 4 + 3 + 35 + 6 + 4
      // An unknown ethertype decodes as one payload layer that already holds the padding, so the tag adds 4 bytes.
      ['unknown ethertype', unknownFrame(), 68],
    ] as [string, LayerSpec[], number][]) {
      const p = f.build(specs, meta());
      const original = p.bytes;
      p.rewrap(at(1, 'd_sw1'), vlanPushOp(10), 'switchport mode trunk');
      expect(p.size, name).toBe(tagged);
      expect(p.layers[1]!.proto, name).toBe('dot1q');
      p.rewrap(at(2, 'd_sw2'), vlanPopOp(), 'switchport access vlan 10');
      expect(Array.from(p.bytes), name).toEqual(Array.from(original));
      expect(p.provenance.map((m) => m.reason), name).toEqual(['VlanTagPush', 'FcsRecompute', 'VlanTagPop', 'FcsRecompute']);
    }
  });

  it('keeps the 802.3 length and the layer structure of a tagged BPDU', () => {
    const f = createPduFactory();
    const p = f.build(bpduFrame(), meta());
    const length = p.get('ethernet.type');
    p.rewrap(at(1, 'd_sw1'), vlanPushOp(10), 'switchport mode trunk');
    expect(protos(p)).toEqual(['ethernet', 'dot1q', 'llc', 'stp']);
    expect(p.get('dot1q.type')).toBe(length);
    expect(p.get('stp.pvid')).toBe(10);
    expect(p.get('ethernet.fcsValid')).toBe(true);
  });

  it('refuses a wrong shape, a second tag or a MAC rewrite, and leaves the PDU untouched', () => {
    const f = createPduFactory();
    const p = f.build(arpFrame(), meta());
    const before = p.bytes;
    const bad: RewrapOp[] = [
      { strip: 2, push: [{ proto: 'ethernet', fields: {} }, { proto: 'dot1q', fields: { vid: 10 } }], as: 'vlan-push' as const },
      { strip: 1, push: [{ proto: 'dot1q', fields: { vid: 10 } }], as: 'vlan-push' as const },
      { strip: 1, push: [{ proto: 'ethernet', fields: {} }, { proto: 'dot1q', fields: {} }], as: 'vlan-push' as const },
      { strip: 1, push: [{ proto: 'ethernet', fields: { dst: PC2 } }, { proto: 'dot1q', fields: { vid: 10 } }], as: 'vlan-push' as const },
      { strip: 2, push: [{ proto: 'ethernet', fields: {} }], as: 'vlan-pop' as const },
    ];
    for (const op of bad) expect(() => p.rewrap(at(1, 'd_sw1'), op, 'x')).toThrow();
    expect(Array.from(p.bytes)).toEqual(Array.from(before));
    expect(p.provenance).toEqual([]);

    p.rewrap(at(1, 'd_sw1'), vlanPushOp(10), 'switchport mode trunk');
    expect(() => p.rewrap(at(2, 'd_sw1'), vlanPushOp(20), 'x')).toThrow(/already tagged/);
    // an explicit dst/src equal to the frame's own is accepted
    p.rewrap(at(3, 'd_sw2'), { strip: 2, push: [{ proto: 'ethernet', fields: { dst: 'ff:ff:ff:ff:ff:ff', src: PC1 } }], as: 'vlan-pop' }, 'switchport access vlan 10');
    expect(protos(p)).toEqual(['ethernet', 'arp']);
  });

  it('tags one clone without touching the original', () => {
    const f = createPduFactory();
    const p = f.build(arpFrame(), meta());
    const copy = f.clone(p, 2000);
    copy.rewrap(at(2000, 'd_sw1'), vlanPushOp(20), 'switchport mode trunk');
    expect(copy.get('dot1q.vid')).toBe(20);
    expect(p.layers[1]!.proto).toBe('arp');
    expect(p.provenance).toEqual([]);
    expect(copy.meta.parent).toBe(p.id);
  });
});

describe('router-on-a-stick mutation sequence (§3.4 step 4, derived from real calls)', () => {
  it('is VLAN pop, TTL, MAC rewrites (src then dst, as arp.ts:177-178 makes them) and VLAN push', () => {
    const f = createPduFactory();
    const p = f.build(echoFrame(), meta());
    const originalSize = p.size;

    // SW1: the access frame leaves the trunk toward R1 (§3.0 step 12).
    p.rewrap(at(1000, 'd_sw1'), vlanPushOp(10), 'switchport mode trunk');
    // R1: pipeline step 10a pops the tag into the subinterface, ipv4 forwards, arp frames the packet.
    p.rewrap(at(2000, 'd_r1'), vlanPopOp(), 'encapsulation dot1Q 10');
    p.mutate(at(2000, 'd_r1'), 'ipv4.ttl', 127, 'TtlDecrement', 'C 192.168.20.0/24 is directly connected, GigabitEthernet0/0.20');
    p.mutate(at(2000, 'd_r1'), 'ethernet.src', R1, 'MacRewrite', 'arp 192.168.20.10');
    p.mutate(at(2000, 'd_r1'), 'ethernet.dst', PC2, 'MacRewrite', 'arp 192.168.20.10');
    p.rewrap(at(2000, 'd_r1'), vlanPushOp(20), 'encapsulation dot1Q 20');
    // SW1: the tagged frame leaves toward PC2's access port.
    p.rewrap(at(3000, 'd_sw1'), vlanPopOp(), 'switchport access vlan 20');

    expect(reasons(p)).toEqual([
      'VlanTagPush:dot1q.vid', 'FcsRecompute:ethernet.fcs',
      'VlanTagPop:dot1q.vid', 'FcsRecompute:ethernet.fcs',
      'TtlDecrement:ipv4.ttl', 'ChecksumRecompute:ipv4.checksum', 'FcsRecompute:ethernet.fcs',
      'MacRewrite:ethernet.src', 'FcsRecompute:ethernet.fcs',
      'MacRewrite:ethernet.dst', 'FcsRecompute:ethernet.fcs',
      'VlanTagPush:dot1q.vid', 'FcsRecompute:ethernet.fcs',
      'VlanTagPop:dot1q.vid', 'FcsRecompute:ethernet.fcs',
    ]);
    expect(p.provenance.map((m) => m.device)).toEqual([
      'd_sw1', 'd_sw1', 'd_r1', 'd_r1', 'd_r1', 'd_r1', 'd_r1', 'd_r1', 'd_r1', 'd_r1', 'd_r1', 'd_r1', 'd_r1', 'd_sw1', 'd_sw1',
    ]);

    // What PC2 receives: the same PduId, the same size, valid checksums, the rewritten header.
    expect(protos(p)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'payload']);
    expect(p.size).toBe(originalSize);
    expect(p.get('ipv4.ttl')).toBe(127);
    expect(p.get('ipv4.checksumValid')).toBe(true);
    expect(p.get('icmpv4.checksumValid')).toBe(true);
    expect(p.get('ethernet.fcsValid')).toBe(true);
    expect(p.get('ethernet.dst')).toBe(PC2);
    expect(p.get('ethernet.src')).toBe(R1);
    const same = createPduFactory().build([
      { proto: 'ethernet', fields: { dst: PC2, src: R1, type: ETHERTYPE_IPV4 } },
      ...echoFrame(56, 127).slice(1),
    ], meta());
    expect(Array.from(p.bytes)).toEqual(Array.from(same.bytes));
  });
});
