/**
 * P3 MUST codecs (ARCHITECTURE-P3 §7 W1 pdu, §2.3, D7, D18, D19; §9.2 items 13–14): OSPFv2 with its chained `ospf-lsa`
 * layers and the Fletcher LSA checksum, the NF discovery ("CDP") frame, IEEE LLDP and NTPv4, plus the dispatch rows
 * (ntp un-reserved, tcp 443 → http) and the field tables moved into PROTO_FIELDS (ruling R11).
 *
 * Every golden below was assembled independently of the engine (a separate script packing the RFC layouts, the
 * internet checksum of RFC 1071, the Fletcher check octets of RFC 905 Annex B and zlib's CRC-32).
 */
import { describe, expect, it } from 'vitest';
import {
  ETHERTYPE_LLDP,
  IPPROTO_OSPF,
  IPPROTO_UDP,
  LLDP_NEAREST_BRIDGE_MAC,
  NF_L2_CONTROL_MAC,
  NF_OUI,
  NF_PID_CDP,
  OSPF_ALL_ROUTERS,
  TCP_PORT_HTTPS,
  UDP_PORT_NTP,
} from '../src/contracts/pdu.js';
import type { LayerSpec, LayerView, PduMeta } from '../src/contracts/pdu.js';
import { DISPATCH_TABLE, PROTO_FIELDS } from '../src/contracts/fields.js';
import { decodeLayers, encodeLayers } from '../src/pdu/codecs/registry.js';
import { keyForProto, lookupNext } from '../src/pdu/codecs/dispatch.js';
import { fletcherCheckbytes, fletcherValid, ospfLsaFletcher, ospfLsaFletcherValid } from '../src/pdu/checksum.js';
import { OSPF_DD_FLAG, OSPF_PACKET, ospfCodec, ospfLsaCodec } from '../src/pdu/codecs/ospf.js';
import { cdpCodec, cdpCapabilityText } from '../src/pdu/codecs/cdp.js';
import { LLDP_CAPABILITY, lldpCodec } from '../src/pdu/codecs/lldp.js';
import { NTP_LEAP_ALARM, NTP_MODE, NTP_STRATUM_UNSYNCHRONISED, ntpCodec, ntpWireTimestampText, writeNtpWireTimestamp } from '../src/pdu/codecs/ntp.js';
import { createPduFactory } from '../src/pdu/factory.js';

const hex = (s: string): number[] => (s.replace(/\s+/g, '').match(/.{2}/g) ?? []).map((h) => parseInt(h, 16));
const protos = (layers: readonly LayerView[]): string[] => layers.map((l) => l.proto);
const layerBytes = (b: Uint8Array, l: LayerView, len = l.length): number[] => Array.from(b.slice(l.offset, l.offset + len));
const meta = (): PduMeta => ({ born: 0, origin: 'd_r1' });

/** RFC 905 Annex B, written independently of pdu/checksum.ts: C0 and C1 over the octets are both zero mod 255. */
function fletcherSumsZero(bytes: readonly number[]): boolean {
  let c0 = 0;
  let c1 = 0;
  for (const b of bytes) {
    c0 = (c0 + b) % 255;
    c1 = (c1 + c0) % 255;
  }
  return c0 === 0 && c1 === 0;
}

// ── OSPF goldens (§3.1: R1 1.1.1.1 and R2 2.2.2.2 on 10.0.123.0/24) ─────────────────────────────────────────────────

const HELLO_1 = '02 01 002c 01010101 00000000 fa9c 0000 0000000000000000' + // header: v2 hello, len 44, rid, area, cksum, auType, auth
  ' ffffff00 000a 02 01 00000028 00000000 00000000'; // mask /24, hello 10, options E, priority 1, dead 40, DR, BDR
const HELLO_2 = '02 01 0030 01010101 00000000 ec90 0000 0000000000000000' +
  ' ffffff00 000a 02 01 00000028 0a007b02 0a007b01 02020202'; // DR 10.0.123.2, BDR 10.0.123.1, neighbour 2.2.2.2
/** R2's router-LSA: one transit link to the DR 10.0.123.2, metric 1 (Fletcher check octets b4 7e). */
const ROUTER_LSA = '0001 02 01 02020202 02020202 80000002 b47e 0024' + ' 00 00 0001' + ' 0a007b02 0a007b02 02 00 0001';
/** The DR's network-LSA 10.0.123.2: mask /24, attached 2.2.2.2 and 1.1.1.1 (Fletcher check octets d6 e7). */
const NETWORK_LSA = '0001 02 02 0a007b02 02020202 80000001 d6e7 0020' + ' ffffff00 02020202 01010101';
const LSU = '02 04 0060 02020202 00000000 c7c5 0000 0000000000000000 00000002 ' + ROUTER_LSA + NETWORK_LSA;
const DBD = '02 02 0048 02020202 00000000 d00f 0000 0000000000000000' + ' 05dc 02 03 00000101' +
  ' 0001 02 01 02020202 02020202 80000002 b47e 0024' + ' 0001 02 02 0a007b02 02020202 80000001 d6e7 0020';
const LSACK = '02 05 0040 01010101 00000000 daf6 0000 0000000000000000' +
  ' 0001 02 01 02020202 02020202 80000002 b47e 0024' + ' 0001 02 02 0a007b02 02020202 80000001 d6e7 0020';
const LSR = '02 03 0030 01010101 00000000 6ab9 0000 0000000000000000' + ' 00000001 02020202 02020202' + ' 00000002 0a007b02 02020202';
const EXTERNAL_LSA = '0000 02 05 00000000 01010101 80000001 cefe 0024' + ' 00000000 80 000001 00000000 00000000';

const ip = (src: string, dst: string): LayerSpec => ({ proto: 'ipv4', fields: { src, dst, ttl: 1, dscp: 48 } });
const helloSpec = (over: Record<string, string | number> = {}): LayerSpec => ({
  proto: 'ospf',
  fields: { type: OSPF_PACKET.hello, routerId: '1.1.1.1', area: '0.0.0.0', mask: '255.255.255.0', ...over },
});
const routerLsa = (extra: Record<string, string | number> = {}): LayerSpec => ({
  proto: 'ospf-lsa',
  fields: { age: 1, lsType: 1, lsid: '2.2.2.2', advRouter: '2.2.2.2', seq: 0x80000002, flags: 0, links: 'transit,10.0.123.2,10.0.123.2,1', ...extra },
});
const networkLsa = (extra: Record<string, string | number> = {}): LayerSpec => ({
  proto: 'ospf-lsa',
  fields: { age: 1, lsType: 2, lsid: '10.0.123.2', advRouter: '2.2.2.2', seq: 0x80000001, mask: '255.255.255.0', attached: '2.2.2.2,1.1.1.1', ...extra },
});
/** Header copies carry the FULL LSA's checksum and length (they cannot recompute them from 20 bytes). */
const routerHeader = (): LayerSpec => ({ proto: 'ospf-lsa', fields: { age: 1, lsType: 1, lsid: '2.2.2.2', advRouter: '2.2.2.2', seq: 0x80000002, checksum: 0xb47e, length: 36 } });
const networkHeader = (): LayerSpec => ({ proto: 'ospf-lsa', fields: { age: 1, lsType: 2, lsid: '10.0.123.2', advRouter: '2.2.2.2', seq: 0x80000001, checksum: 0xd6e7, length: 32 } });

describe('OSPF codec (D7, RFC 2328 bytes)', () => {
  it('encodes the §3.1 hello as the RFC 2328 packet, with the IP checksum over the packet minus the authentication field', () => {
    const b = encodeLayers([ip('10.0.123.1', OSPF_ALL_ROUTERS), helloSpec()]);
    const layers = decodeLayers(b, 'ipv4');
    expect(protos(layers)).toEqual(['ipv4', 'ospf']);
    expect(layers[0]!.fields).toMatchObject({ protocol: IPPROTO_OSPF, ttl: 1, dscp: 48, dst: '224.0.0.5' });
    expect(layerBytes(b, layers[1]!)).toEqual(hex(HELLO_1));
    expect(layers[1]!.fields).toEqual({
      version: 2, type: 1, length: 44, routerId: '1.1.1.1', area: '0.0.0.0', checksum: 0xfa9c, checksumValid: true, auType: 0,
      mask: '255.255.255.0', helloInterval: 10, options: 2, priority: 1, deadInterval: 40, dr: '0.0.0.0', bdr: '0.0.0.0', neighbors: '',
    });
    expect(layers[1]!.error).toBeUndefined();
    const pdu = createPduFactory().decode(b, meta(), 'ipv4');
    expect(pdu.topProto()).toBe('ospf');
    expect(pdu.summary()).toBe('OSPF hello from 1.1.1.1 area 0.0.0.0, DR 0.0.0.0, BDR 0.0.0.0');
  });

  it('lists the neighbours heard and the DR and BDR as the sender sees them', () => {
    const b = encodeLayers([ip('10.0.123.1', OSPF_ALL_ROUTERS), helloSpec({ dr: '10.0.123.2', bdr: '10.0.123.1', neighbors: '2.2.2.2' })]);
    const layers = decodeLayers(b, 'ipv4');
    expect(layerBytes(b, layers[1]!)).toEqual(hex(HELLO_2));
    expect(layers[1]!.fields).toMatchObject({ dr: '10.0.123.2', bdr: '10.0.123.1', neighbors: '2.2.2.2', checksumValid: true });
    const two = encodeLayers([ip('10.0.123.1', OSPF_ALL_ROUTERS), helloSpec({ neighbors: '2.2.2.2,3.3.3.3' })]);
    expect(decodeLayers(two, 'ipv4')[1]!.fields.neighbors).toBe('2.2.2.2,3.3.3.3');
  });

  it('carries a router and a network LSA in one update, each a chained ospf-lsa layer with its Fletcher checksum', () => {
    const b = encodeLayers([ip('10.0.123.2', OSPF_ALL_ROUTERS), { proto: 'ospf', fields: { type: OSPF_PACKET.lsu, routerId: '2.2.2.2', area: '0.0.0.0' } }, routerLsa(), networkLsa()]);
    const layers = decodeLayers(b, 'ipv4');
    expect(protos(layers)).toEqual(['ipv4', 'ospf', 'ospf-lsa', 'ospf-lsa']);
    const [, pkt, r, n] = layers;
    expect(layerBytes(b, pkt!)).toEqual(hex(LSU));
    expect(pkt!.fields).toMatchObject({ type: 4, length: 96, count: 2, checksum: 0xc7c5, checksumValid: true });
    expect(pkt!.headerLength).toBe(28);
    // one card and one hex range per LSA: each layer's header is its own LSA, and it runs to the end of the packet
    expect(layerBytes(b, r!, r!.headerLength)).toEqual(hex(ROUTER_LSA));
    expect(layerBytes(b, n!, n!.headerLength)).toEqual(hex(NETWORK_LSA));
    expect(r!.length).toBe(36 + 32);
    expect(n!.length).toBe(32);
    expect(r!.fields).toEqual({
      age: 1, options: 2, lsType: 1, lsid: '2.2.2.2', advRouter: '2.2.2.2', seq: 0x80000002, checksum: 0xb47e, length: 36,
      headerOnly: false, checksumValid: true, flags: 0, links: 'transit,10.0.123.2,10.0.123.2,1',
    });
    expect(n!.fields).toEqual({
      age: 1, options: 2, lsType: 2, lsid: '10.0.123.2', advRouter: '2.2.2.2', seq: 0x80000001, checksum: 0xd6e7, length: 32,
      headerOnly: false, checksumValid: true, mask: '255.255.255.0', attached: '2.2.2.2,1.1.1.1',
    });
    // Fletcher vectors: the check octets make both RFC 905 sums vanish over the LSA from its options byte (age excluded)
    for (const lsa of [ROUTER_LSA, NETWORK_LSA, EXTERNAL_LSA]) expect(fletcherSumsZero(hex(lsa).slice(2))).toBe(true);
    const routerBytes = Uint8Array.from(hex(ROUTER_LSA));
    expect(ospfLsaFletcher(routerBytes, 0, 36)).toBe(0xb47e);
    expect(ospfLsaFletcherValid(routerBytes, 0, 36)).toBe(true);
    expect(ospfLsaFletcher(Uint8Array.from(hex(NETWORK_LSA)), 0, 32)).toBe(0xd6e7);
    const summary = createPduFactory().decode(b, meta(), 'ipv4').summary();
    expect(summary).toBe('OSPF link-state update from 2.2.2.2 area 0.0.0.0, 2 LSAs');
  });

  it('a database description and an acknowledgement carry LSA header copies with the full LSA checksum and length', () => {
    const lsu = encodeLayers([{ proto: 'ospf', fields: { type: OSPF_PACKET.lsu, routerId: '2.2.2.2', area: '0.0.0.0' } }, routerLsa(), networkLsa()]);
    const full = decodeLayers(lsu, 'ospf');
    const dbd = encodeLayers([
      { proto: 'ospf', fields: { type: OSPF_PACKET.dbd, routerId: '2.2.2.2', area: '0.0.0.0', mtu: 1500, flags: OSPF_DD_FLAG.M | OSPF_DD_FLAG.MS, ddSeq: 0x101 } },
      routerHeader(),
      networkHeader(),
    ]);
    expect(Array.from(dbd)).toEqual(hex(DBD));
    const d = decodeLayers(dbd, 'ospf');
    expect(protos(d)).toEqual(['ospf', 'ospf-lsa', 'ospf-lsa']);
    expect(d[0]!.fields).toMatchObject({ type: 2, mtu: 1500, options: 2, flags: 3, ddSeq: 0x101, checksumValid: true });
    expect(d[0]!.headerLength).toBe(32);
    for (let i = 1; i <= 2; i++) {
      const copy = d[i]!;
      expect(copy.headerLength).toBe(20);
      expect(copy.fields.headerOnly).toBe(true);
      expect(copy.fields.checksumValid).toBeUndefined();
      // the copy's 20 bytes are exactly the full LSA's header, checksum and length included
      expect(layerBytes(dbd, copy, 20)).toEqual(layerBytes(lsu, full[i]!, 20));
      expect(copy.fields.checksum).toBe(full[i]!.fields.checksum);
      expect(copy.fields.length).toBe(full[i]!.fields.length);
    }
    const ack = encodeLayers([{ proto: 'ospf', fields: { type: OSPF_PACKET.lsack, routerId: '1.1.1.1', area: '0.0.0.0' } }, routerHeader(), networkHeader()]);
    expect(Array.from(ack)).toEqual(hex(LSACK));
    const a = decodeLayers(ack, 'ospf');
    expect(protos(a)).toEqual(['ospf', 'ospf-lsa', 'ospf-lsa']);
    expect(a[1]!.fields).toMatchObject({ headerOnly: true, checksum: 0xb47e, length: 36 });
    expect(createPduFactory().decode(ack, meta(), 'ospf').summary()).toBe('OSPF link-state acknowledgement from 1.1.1.1 area 0.0.0.0');
    expect(createPduFactory().decode(dbd, meta(), 'ospf').summary()).toBe('OSPF database description from 2.2.2.2 area 0.0.0.0, seq 257, flags M MS');
    // a header copy cannot invent the checksum or the length of an LSA it does not carry
    const noCk = { ...routerHeader(), fields: { ...routerHeader().fields, checksum: null } };
    expect(() => encodeLayers([{ proto: 'ospf', fields: { type: 5, routerId: '1.1.1.1', area: '0.0.0.0' } }, noCk])).toThrow(/ospf-lsa.checksum is required/);
  });

  it('a link-state request lists <type>:<lsid>:<adv> entries; an external LSA encodes mask, E2, metric, forward and tag', () => {
    const lsr = encodeLayers([{ proto: 'ospf', fields: { type: OSPF_PACKET.lsr, routerId: '1.1.1.1', area: '0.0.0.0', requests: '1:2.2.2.2:2.2.2.2;2:10.0.123.2:2.2.2.2' } }]);
    expect(Array.from(lsr)).toEqual(hex(LSR));
    expect(decodeLayers(lsr, 'ospf')[0]!.fields).toMatchObject({ requests: '1:2.2.2.2:2.2.2.2;2:10.0.123.2:2.2.2.2', checksumValid: true });
    const ext = ospfLsaCodec.encode({ lsType: 5, lsid: '0.0.0.0', advRouter: '1.1.1.1', mask: '0.0.0.0', e2: true, metric: 1 }, new Uint8Array(0));
    expect(Array.from(ext)).toEqual(hex(EXTERNAL_LSA));
    expect(ospfLsaCodec.decode(ext, 0, ext.length).fields).toMatchObject({ lsType: 5, mask: '0.0.0.0', e2: true, metric: 1, forward: '0.0.0.0', tag: 0, checksumValid: true, headerOnly: false });
    expect(() => ospfLsaCodec.encode({ lsType: 3, lsid: '10.0.0.0', advRouter: '1.1.1.1' }, new Uint8Array(0))).toThrow(/no body encoder/);
    expect(() => ospfLsaCodec.encode({ lsType: 1, lsid: '1.1.1.1', advRouter: '1.1.1.1', links: 'bogus,1,2,3' }, new Uint8Array(0))).toThrow(/links entry/);
  });

  it('a mutate re-encodes the LSA and the packet around it and leaves the next LSA byte for byte (age is outside the Fletcher sum)', () => {
    const f = createPduFactory();
    const pdu = f.build([ip('10.0.123.2', OSPF_ALL_ROUTERS), { proto: 'ospf', fields: { type: OSPF_PACKET.lsu, routerId: '2.2.2.2', area: '0.0.0.0' } }, routerLsa(), networkLsa()], meta());
    const networkBefore = layerBytes(pdu.bytes, pdu.layerAt(3)!);
    pdu.mutate({ now: 1, device: 'd_r1' }, 'ospf-lsa.age', 2, 'Other', 'aged in transit');
    expect(pdu.layerAt(2)!.fields).toMatchObject({ age: 2, checksum: 0xb47e, checksumValid: true });
    expect(layerBytes(pdu.bytes, pdu.layerAt(3)!)).toEqual(networkBefore);
    expect(pdu.layerAt(1)!.fields).toMatchObject({ count: 2, length: 96, checksumValid: true });
    pdu.mutate({ now: 2, device: 'd_r1' }, 'ospf-lsa.seq', 0x80000003, 'Other');
    expect(pdu.layerAt(2)!.fields.checksumValid).toBe(true);
    expect(pdu.layerAt(2)!.fields.checksum).not.toBe(0xb47e);
    // the IPv4 header (and so its checksum) does not change: the packet length is the same; the LSA checksum is not a
    // derived field of the table (it is required in a header copy), so only the packet checksum is recorded
    expect(pdu.provenance.map((m) => m.field)).toEqual(['ospf-lsa.age', 'ospf.checksum', 'ospf-lsa.seq', 'ospf.checksum']);
  });

  it('reports truncation and a bad LSA checksum, and never throws on malformed bytes', () => {
    const b = Uint8Array.from(hex(LSU));
    expect(ospfCodec.decode(b, 0, 10).error).toBe('OSPF header truncated');
    expect(decodeLayers(b.slice(0, 60), 'ospf')[0]!.error).toMatch(/truncated/);
    const bad = b.slice();
    bad[28 + 20] = bad[28 + 20]! ^ 0x01; // a byte of the router-LSA body
    const layers = decodeLayers(bad, 'ospf');
    expect(layers[0]!.fields.checksumValid).toBe(false);
    expect(layers[1]!.fields.checksumValid).toBe(false);
    expect(layers[2]!.fields.checksumValid).toBe(true);
    expect(decodeLayers(Uint8Array.from([2, 9, 0, 24, ...new Array<number>(20).fill(0)]), 'ospf')[0]!.error).toBe('unknown OSPF packet type 9');
  });
});

describe('Fletcher checksum (pdu/checksum.ts; ISO 8473 / RFC 905 Annex B)', () => {
  it('never writes a zero octet, and the written octets make both sums vanish', () => {
    const zeros = new Uint8Array(10);
    expect(fletcherCheckbytes(zeros, 0, 10, 4)).toBe(0xffff);
    zeros[4] = 0xff;
    zeros[5] = 0xff;
    expect(fletcherValid(zeros, 0, 10)).toBe(true);
    const data = Uint8Array.from([0x01, 0x02, 0x00, 0x00, 0x03, 0x04, 0x05]);
    const ck = fletcherCheckbytes(data, 0, 7, 2);
    data[2] = ck >> 8;
    data[3] = ck & 0xff;
    expect(fletcherSumsZero(Array.from(data))).toBe(true);
    expect(() => fletcherCheckbytes(data, 0, 7, 6)).toThrow(RangeError);
  });
});

// ── NF discovery ("CDP", D18) and LLDP ─────────────────────────────────────────────────────────────────────────────

const CDP_FRAME =
  '034e46000001 024e59e8af01 0065' + // 802.3: NF control group, the port MAC, length 101
  ' aaaa03 024e46 0004' + // LLC/SNAP, NF OUI, PID 4
  ' 02 b4' + // version 2, holdtime 180
  ' 0001 0002 5231' + // deviceId 'R1'
  ' 0002 0012 4769676162697445746865726e6574302f30' + // portId 'GigabitEthernet0/0'
  ' 0003 0005 04 0a000c01' + // addresses: IPv4 10.0.12.1
  ' 0004 0002 0001' + // capabilities R
  ' 0005 0007 4e462d32393131' + // platform 'NF-2911'
  ' 0006 001c 4e6574466f72676520726f7574657220736f66747761726520312e30' + // software
  ' 0008 0001 01' + // duplex full
  ' dbd99e00'; // FCS

const LLDP_FRAME =
  '0180c200000e 02e76329c801 88cc' +
  ' 0207 04 02e76329c800' + // chassis id, subtype 4 (MAC)
  ' 0413 05 4769676162697445746865726e6574302f31' + // port id, subtype 5 (interface name) 'GigabitEthernet0/1'
  ' 0602 0078' + // TTL 120
  ' 0a03 535731' + // system name 'SW1'
  ' 0e04 0004 0004' + // capabilities: bridge, enabled bridge
  ' 100c 05 01 0a000002 01 00000000 00' + // management address 10.0.0.2
  ' 0000' + // end of LLDPDU
  ' 24a7c90b';

describe('NF discovery codec ("CDP" as a name only, D18)', () => {
  it('encodes the §3.6 frame in the original NF TLV format under LLC/SNAP with the NF OUI and PID 4', () => {
    const b = encodeLayers([
      { proto: 'ethernet', fields: { dst: NF_L2_CONTROL_MAC, src: '02:4e:59:e8:af:01', type: 0 } },
      { proto: 'llc', fields: {} },
      {
        proto: 'cdp',
        fields: { deviceId: 'R1', portId: 'GigabitEthernet0/0', addresses: '10.0.12.1', capabilities: 'R', platform: 'NF-2911', software: 'NetForge router software 1.0', duplex: 'full' },
      },
    ]);
    expect(Array.from(b)).toEqual(hex(CDP_FRAME));
    const layers = decodeLayers(b);
    expect(protos(layers)).toEqual(['ethernet', 'llc', 'cdp']);
    expect(layers[1]!.fields).toMatchObject({ oui: NF_OUI, type: NF_PID_CDP });
    expect(layers[2]!.fields).toEqual({
      version: 2, ttl: 180, deviceId: 'R1', portId: 'GigabitEthernet0/0', addresses: '10.0.12.1', capabilities: 'R',
      platform: 'NF-2911', software: 'NetForge router software 1.0', duplex: 'full',
    });
    expect(layers[2]!.error).toBeUndefined();
    const pdu = createPduFactory().decode(b, meta());
    expect(pdu.topProto()).toBe('cdp');
    expect(pdu.summary()).toBe('CDP from R1 (NF-2911) port GigabitEthernet0/0, holdtime 180 s');
  });

  it('round-trips a switch frame (S I, native VLAN, several addresses) and reports what is missing', () => {
    const fields = { version: 2, ttl: 180, deviceId: 'SW1', portId: 'GigabitEthernet0/1', addresses: '10.0.12.2,2001:db8::2', capabilities: 'S I', platform: 'NF-C2960', nativeVlan: 1, duplex: 'half' };
    const b = cdpCodec.encode({ ...fields }, new Uint8Array(0));
    const d = cdpCodec.decode(b, 0, b.length);
    expect(d.error).toBeUndefined();
    expect(d.fields).toEqual(fields);
    expect(Array.from(cdpCodec.encode({ ...d.fields }, new Uint8Array(0)))).toEqual(Array.from(b));
    expect(cdpCapabilityText(0x07)).toBe('R S I');
    expect(() => cdpCodec.encode({ deviceId: 'X', portId: 'Y', capabilities: 'Q' }, new Uint8Array(0))).toThrow(/unknown capability letter/);
    expect(() => cdpCodec.encode({ portId: 'Y' }, new Uint8Array(0))).toThrow(/cdp.deviceId is required/);
    expect(cdpCodec.decode(Uint8Array.from([2, 180, 0, 2, 0, 1, 0x41]), 0, 7).error).toBe('discovery message has no deviceId');
    expect(cdpCodec.decode(Uint8Array.from([2, 180, 0, 1, 0, 9, 0x41]), 0, 7).error).toMatch(/runs past the message/);
  });
});

describe('LLDP codec (IEEE 802.1AB, D18)', () => {
  it('encodes chassis subtype 4, port subtype 5, TTL 120 and the end TLV; the padding after it belongs to Ethernet', () => {
    const b = encodeLayers([
      { proto: 'ethernet', fields: { dst: LLDP_NEAREST_BRIDGE_MAC, src: '02:e7:63:29:c8:01', type: ETHERTYPE_LLDP } },
      { proto: 'lldp', fields: { chassisId: '02:e7:63:29:c8:00', portId: 'GigabitEthernet0/1', systemName: 'SW1', capabilities: LLDP_CAPABILITY.bridge, enabledCapabilities: LLDP_CAPABILITY.bridge, mgmtAddress: '10.0.0.2' } },
    ]);
    expect(Array.from(b)).toEqual(hex(LLDP_FRAME));
    const layers = decodeLayers(b);
    expect(protos(layers)).toEqual(['ethernet', 'lldp']);
    expect(layers[1]!.fields).toEqual({
      chassisSubtype: 4, chassisId: '02:e7:63:29:c8:00', portSubtype: 5, portId: 'GigabitEthernet0/1', ttl: 120, systemName: 'SW1',
      capabilities: 4, enabledCapabilities: 4, mgmtAddress: '10.0.0.2',
    });
    expect(layers[1]!.length).toBe(61);
    expect(createPduFactory().decode(b, meta()).summary()).toBe('LLDP from SW1 port GigabitEthernet0/1, ttl 120 s');
    // a short frame: the minimum-size padding after the end TLV is Ethernet's
    const short = encodeLayers([
      { proto: 'ethernet', fields: { dst: LLDP_NEAREST_BRIDGE_MAC, src: '02:e7:63:29:c8:01', type: ETHERTYPE_LLDP } },
      { proto: 'lldp', fields: { chassisId: '02:e7:63:29:c8:00', portId: 'Fa0/1' } },
    ]);
    expect(short.length).toBe(64);
    const s = decodeLayers(short);
    expect(s[1]!.length).toBe(2 + 7 + 2 + 6 + 2 + 2 + 2);
    expect(s[0]!.fields.padding).toBe(46 - 23);
  });

  it('reports a frame without its end TLV or a mandatory TLV', () => {
    expect(lldpCodec.decode(Uint8Array.from([0x06, 0x02, 0x00, 0x78]), 0, 4).error).toBe('LLDP frame has no end TLV');
    expect(lldpCodec.decode(Uint8Array.from([0x06, 0x02, 0x00, 0x78, 0, 0]), 0, 6).error).toBe('LLDP frame has no chassisId, portId');
    expect(() => lldpCodec.encode({ chassisId: 'not-a-mac', portId: 'x' }, new Uint8Array(0))).toThrow(/must be a MAC address/);
  });
});

// ── NTP (D19) ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** R1 (clock unset: 2020-01-01 00:00:12.5 = NTP 3786825612.5) asks SRV1. */
const NTP_MODE3 = '23 00 06 00 00000000 00000000 00000000' + ' 0000000000000000 0000000000000000 0000000000000000' + ' e1b65f8c80000000';
/** SRV1 (stratum 1, LOCL) answers from true time (2025-01-06 08:00:57.123456789 = NTP 3945139257). */
const NTP_MODE4 = '24 01 06 ec 00000000 00000000 4c4f434c' + ' eb260c0000000000 e1b65f8c80000000 eb260c391f9add38 eb260c391f9db22e';
/** An unsynchronised server: leap 3 (alarm), stratum 16, refId INIT. */
const NTP_UNSYNC = 'e4 10 06 ec 00000000 00000000 494e4954' + ' 0000000000000000 e1b65f8c80000000 eb260c6400000005 eb260c6400000009';

const ntpSpec = (fields: Record<string, string | number>): LayerSpec[] => [
  { proto: 'ipv4', fields: { src: '10.0.0.1', dst: '10.0.0.10', protocol: IPPROTO_UDP } },
  { proto: 'udp', fields: { srcPort: UDP_PORT_NTP, dstPort: UDP_PORT_NTP } },
  { proto: 'ntp', fields },
];

describe('NTP codec (RFC 5905, D19)', () => {
  it('encodes a mode 3 request and decodes it through UDP 123 (no longer reserved)', () => {
    const b = encodeLayers(ntpSpec({ mode: NTP_MODE.client, transmitTimestamp: '3786825612.500000000' }));
    const layers = decodeLayers(b, 'ipv4');
    expect(protos(layers)).toEqual(['ipv4', 'udp', 'ntp']);
    expect(layerBytes(b, layers[1]!, 8)).toEqual(hex('007b 007b 0038 003a'));
    expect(layerBytes(b, layers[2]!)).toEqual(hex(NTP_MODE3));
    expect(layers[2]!.fields).toEqual({
      leap: 0, version: 4, mode: 3, stratum: 0, poll: 6, precision: 0, rootDelay: 0, rootDispersion: 0, refId: '',
      refTimestamp: '0.000000000', originTimestamp: '0.000000000', receiveTimestamp: '0.000000000', transmitTimestamp: '3786825612.500000000',
    });
    expect(createPduFactory().decode(b, meta(), 'ipv4').summary()).toBe('NTP client request, version 4');
  });

  it('encodes a mode 4 reply with a stratum 1 LOCL reference and nanosecond timestamps that round-trip exactly', () => {
    const fields = {
      leap: 0, version: 4, mode: NTP_MODE.server, stratum: 1, poll: 6, precision: -20, rootDelay: 0, rootDispersion: 0, refId: 'LOCL',
      refTimestamp: '3945139200.000000000', originTimestamp: '3786825612.500000000', receiveTimestamp: '3945139257.123456789', transmitTimestamp: '3945139257.123500000',
    };
    const b = ntpCodec.encode({ ...fields }, new Uint8Array(0));
    expect(Array.from(b)).toEqual(hex(NTP_MODE4));
    const d = ntpCodec.decode(b, 0, b.length);
    expect(d.fields).toEqual(fields);
    expect(Array.from(ntpCodec.encode({ ...d.fields }, new Uint8Array(0)))).toEqual(Array.from(b));
    expect(ntpCodec.summarize(d.fields)).toBe('NTP server, stratum 1, reference LOCL');
    // stratum 2–15: the reference is the server's address
    const s2 = ntpCodec.encode({ mode: 4, stratum: 2, refId: '10.0.0.10' }, new Uint8Array(0));
    expect(Array.from(s2.slice(12, 16))).toEqual([10, 0, 0, 10]);
    expect(ntpCodec.decode(s2, 0, s2.length).fields.refId).toBe('10.0.0.10');
  });

  it('encodes the stratum-16 leap-3 reply of an unsynchronised server (refId INIT)', () => {
    const fields = {
      leap: NTP_LEAP_ALARM, version: 4, mode: NTP_MODE.server, stratum: NTP_STRATUM_UNSYNCHRONISED, poll: 6, precision: -20, rootDelay: 0, rootDispersion: 0,
      refId: 'INIT', refTimestamp: '0.000000000', originTimestamp: '3786825612.500000000', receiveTimestamp: '3945139300.000000001', transmitTimestamp: '3945139300.000000002',
    };
    const b = ntpCodec.encode({ ...fields }, new Uint8Array(0));
    expect(Array.from(b)).toEqual(hex(NTP_UNSYNC));
    expect(ntpCodec.decode(b, 0, b.length).fields).toEqual(fields);
    expect(ntpCodec.summarize(fields)).toBe('NTP server, stratum 16, reference INIT, not synchronised');
  });

  it('converts timestamp text exactly and refuses what it cannot carry', () => {
    const out = new Uint8Array(8);
    for (const text of ['0.000000000', '1.000000001', '3945139257.999999999', '4294967295.500000000']) {
      writeNtpWireTimestamp(out, 0, text);
      expect(ntpWireTimestampText(out, 0)).toBe(text);
    }
    writeNtpWireTimestamp(out, 0, '12.5');
    expect(ntpWireTimestampText(out, 0)).toBe('12.500000000');
    expect(() => writeNtpWireTimestamp(out, 0, '4294967296.0')).toThrow(/seconds out of range/);
    expect(() => writeNtpWireTimestamp(out, 0, '1.0000000001')).toThrow(/s.fffffffff/);
    expect(() => ntpCodec.encode({ mode: 3, refId: 'TOOLONG' }, new Uint8Array(0))).toThrow(/at most 4 characters/);
    expect(ntpCodec.decode(new Uint8Array(20), 0, 20).error).toBe('NTP packet truncated');
  });
});

// ── dispatch rows, field tables (§9.2 item 14, ruling R11) ─────────────────────────────────────────────────────────

describe('P3 dispatch rows and field tables', () => {
  it('dispatches the MUST protocols and HTTP on 443; the reserved list is exactly tftp, snmp, ftp, smtp, pop3 and imap', () => {
    expect(lookupNext('ipproto', IPPROTO_OSPF)).toBe('ospf');
    expect(lookupNext('nf.pid', NF_PID_CDP)).toBe('cdp');
    expect(lookupNext('ethertype', ETHERTYPE_LLDP)).toBe('lldp');
    expect(lookupNext('udp.port', UDP_PORT_NTP)).toBe('ntp');
    expect(lookupNext('tcp.port', TCP_PORT_HTTPS)).toBe('http');
    expect(keyForProto('tcp.port', 'http')).toBe(80); // the reverse lookup still fills 80
    expect(keyForProto('ipproto', 'ospf')).toBe(89);
    expect(DISPATCH_TABLE.filter((e) => e.reserved).map((e) => `${e.space} ${e.key} ${e.proto}`)).toEqual([
      'udp.port 69 tftp', 'udp.port 161 snmp', 'tcp.port 21 ftp', 'tcp.port 25 smtp', 'tcp.port 110 pop3', 'tcp.port 143 imap',
    ]);
    const get = new TextEncoder().encode('GET /restconf/data HTTP/1.1\r\nHost: 10.0.99.11\r\n\r\n');
    const b = encodeLayers([
      { proto: 'ipv4', fields: { src: '10.0.99.10', dst: '10.0.99.11', protocol: 6 } },
      { proto: 'tcp', fields: { srcPort: 49152, dstPort: TCP_PORT_HTTPS, flags: 'PA' } },
      { proto: 'payload', fields: { data: get } },
    ]);
    const layers = decodeLayers(b, 'ipv4');
    expect(protos(layers)).toEqual(['ipv4', 'tcp', 'http']);
    expect(layers[2]!.fields).toMatchObject({ kind: 'request', method: 'GET', target: '/restconf/data' });
  });

  it('moves every P3 table into PROTO_FIELDS with since P3, and every decoded field is a name of its table', () => {
    const p3 = Object.values(PROTO_FIELDS).filter((t) => t.since === 'P3').map((t) => t.proto);
    expect(p3).toEqual(['ospf', 'ospf-lsa', 'cdp', 'lldp', 'ntp', 'telnet', 'ssh', 'gre', 'ppp', 'lcp', 'pap', 'chap', 'ipcp', 'ipv6cp', 'syslog', 'eigrp', 'esp', 'ikev2']);
    const frames: [Uint8Array, string][] = [
      [Uint8Array.from(hex(LSU)), 'ospf'], [Uint8Array.from(hex(DBD)), 'ospf'], [Uint8Array.from(hex(HELLO_2)), 'ospf'], [Uint8Array.from(hex(LSR)), 'ospf'],
      [Uint8Array.from(hex(CDP_FRAME)), 'ethernet'], [Uint8Array.from(hex(LLDP_FRAME)), 'ethernet'], [Uint8Array.from(hex(NTP_MODE4)), 'ntp'],
    ];
    for (const [bytes, outer] of frames) {
      for (const layer of decodeLayers(bytes, outer)) {
        const names = new Set(PROTO_FIELDS[layer.proto]!.fields.map((x) => x.name));
        for (const k of Object.keys(layer.fields)) expect(names.has(k), `${layer.proto}.${k}`).toBe(true);
      }
    }
  });
});
