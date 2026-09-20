/**
 * P1 W2 pdu: IPv6 (RFC 8200), extension headers (RFC 8200 §4), ICMPv6 (RFC 4443) and neighbour discovery
 * messages and options (RFC 4861, RDNSS RFC 8106).
 *
 * Golden bytes were computed independently (Python `ipaddress` + `struct` + an independent RFC 1071 sum over
 * the RFC 8200 §8.1 pseudo-header), not by the codecs.
 */
import { describe, expect, it } from 'vitest';
import {
  ETHERTYPE_IPV6,
  HDLC_PROTO_IPV6,
  ICMPV6_DEST_UNREACHABLE,
  ICMPV6_ECHO_REPLY,
  ICMPV6_ECHO_REQUEST,
  ICMPV6_NA,
  ICMPV6_NS,
  ICMPV6_PACKET_TOO_BIG,
  ICMPV6_PARAM_PROBLEM,
  ICMPV6_RA,
  ICMPV6_RS,
  ICMPV6_TIME_EXCEEDED,
  ICMPV6_UNREACH_PORT,
  IPPROTO_DSTOPTS,
  IPPROTO_FRAGMENT,
  IPPROTO_HOPOPTS,
  IPPROTO_ICMPV6,
  IPPROTO_NONE,
  IPPROTO_ROUTING,
  IPPROTO_UDP,
  IPV6_ND_HOP_LIMIT,
} from '../src/contracts/pdu.js';
import type { LayerSpec, LayerView, PduMeta } from '../src/contracts/pdu.js';
import { PROTO_FIELDS } from '../src/contracts/fields.js';
import { decodeLayers, decodeStandalone, encodeLayers, fillLinkField } from '../src/pdu/codecs/registry.js';
import { ipv6Codec } from '../src/pdu/codecs/ipv6.js';
import { ipv6DstOptsCodec, ipv6FragCodec, ipv6HopOptsCodec, ipv6RouteCodec, padIpv6Options } from '../src/pdu/codecs/ipv6-ext.js';
import { icmpv6Codec, isIcmpv6Error, isNdType } from '../src/pdu/codecs/icmpv6.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { internetChecksum } from '../src/pdu/checksum.js';
import { ipv6ToBytes, linkLocalFromMac, solicitedNodeMulticast } from '../src/core/addr6.js';

const hex = (s: string): Uint8Array => new Uint8Array((s.replace(/\s+/g, '').match(/.{2}/g) ?? []).map((h) => parseInt(h, 16)));
const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const protos = (layers: readonly LayerView[]): string[] => layers.map((l) => l.proto);
const meta = (): PduMeta => ({ born: 0, origin: 'd_pc1' });
const layerBytes = (bytes: Uint8Array, l: LayerView): Uint8Array => bytes.slice(l.offset, l.offset + l.length);

const R_MAC = '00:1f:00:00:00:0a';
const PC_MAC = '02:00:00:00:00:01';

/** Independent RFC 4443 §2.3 check over the RFC 8200 §8.1 pseudo-header. */
function icmpv6ChecksumOk(src: string, dst: string, msg: Uint8Array): boolean {
  const buf = new Uint8Array(40 + msg.length);
  buf.set(ipv6ToBytes(src), 0);
  buf.set(ipv6ToBytes(dst), 16);
  buf[34] = (msg.length >>> 8) & 0xff;
  buf[35] = msg.length & 0xff;
  buf[39] = IPPROTO_ICMPV6;
  buf.set(msg, 40);
  return internetChecksum(buf) === 0;
}

const v6 = (src: string, dst: string, nextHeader: number, hopLimit = 64): LayerSpec => ({ proto: 'ipv6', fields: { src, dst, nextHeader, hopLimit } });

describe('ipv6 codec', () => {
  it('encodes an echo request byte-identical to an independent computation', () => {
    const bytes = encodeLayers([
      v6('2001:db8::1', '2001:db8::2', IPPROTO_ICMPV6),
      { proto: 'icmpv6', fields: { type: ICMPV6_ECHO_REQUEST, id: 1, seq: 1 } },
      { proto: 'payload', fields: { data: hex('01020304') } },
    ]);
    expect(toHex(bytes)).toBe(
      '60000000000c3a4020010db800000000000000000000000120010db80000000000000000000000028000203c0001000101020304',
    );
    const [ip, icmp, pl] = decodeLayers(bytes, 'ipv6');
    expect(ip!.fields).toEqual({
      version: 6, trafficClass: 0, flowLabel: 0, payloadLength: 12, nextHeader: 58, hopLimit: 64,
      src: '2001:db8::1', dst: '2001:db8::2',
    });
    expect(ip!.headerLength).toBe(40);
    expect(ip!.length).toBe(52);
    expect(ip!.fieldRanges.src).toEqual([8, 16]);
    expect(icmp!.fields).toMatchObject({ type: 128, code: 0, id: 1, seq: 1, checksumValid: true });
    expect(pl!.fields.data).toEqual(hex('01020304'));
  });

  it('decodes addresses to RFC 5952 text and accepts any RFC 4291 form on encode', () => {
    const bytes = encodeLayers([
      { proto: 'ipv6', fields: { src: '2001:0DB8:0000:0000:0000:FF00:0042:8329', dst: 'fe80::0:1', nextHeader: IPPROTO_NONE } },
    ]);
    const ip = decodeLayers(bytes, 'ipv6')[0]!;
    expect(ip.fields.src).toBe('2001:db8::ff00:42:8329');
    expect(ip.fields.dst).toBe('fe80::1');
    expect(() => encodeLayers([{ proto: 'ipv6', fields: { src: '1::2::3', dst: '::1', nextHeader: 59 } }])).toThrow(/ipv6\.src is not a valid IPv6 address/);
    expect(() => encodeLayers([{ proto: 'ipv6', fields: { src: '::1', dst: '::1' } }])).toThrow(/ipv6\.nextHeader is required/);
  });

  it('packs traffic class and flow label into the first word', () => {
    const bytes = encodeLayers([{ proto: 'ipv6', fields: { src: '::1', dst: '::1', nextHeader: 59, trafficClass: 0xb8, flowLabel: 0x12345 } }]);
    expect(toHex(bytes.slice(0, 4))).toBe('6b812345');
    expect(decodeLayers(bytes, 'ipv6')[0]!.fields).toMatchObject({ trafficClass: 0xb8, flowLabel: 0x12345 });
  });

  it('next header 59 or an empty payload ends the chain; unknown next headers decode as payload', () => {
    expect(protos(decodeLayers(encodeLayers([v6('::1', '::1', IPPROTO_NONE)]), 'ipv6'))).toEqual(['ipv6']);
    const unknown = encodeLayers([v6('::1', '::1', 253), { proto: 'payload', fields: { data: hex('aabb') } }]);
    expect(protos(decodeLayers(unknown, 'ipv6'))).toEqual(['ipv6', 'payload']);
  });

  it('reports a truncated header or a wrong version; clamps a payload length larger than the bytes', () => {
    const short = ipv6Codec.decode(new Uint8Array(20).fill(0x60), 0, 20);
    expect(short.error).toBe('IPv6 header truncated');
    const bytes = encodeLayers([v6('::1', '::2', IPPROTO_UDP), { proto: 'udp', fields: { srcPort: 1, dstPort: 2 } }]);
    const v4ish = bytes.slice();
    v4ish[0] = 0x40;
    expect(ipv6Codec.decode(v4ish, 0, v4ish.length).error).toBe('not an IPv6 header (version 4)');
    const cut = ipv6Codec.decode(bytes, 0, 44);
    expect(cut.error).toBeUndefined();
    expect(cut.length).toBe(44);
    expect(cut.next).toEqual({ proto: 'udp', offset: 40, length: 4 });
  });

  it('travels inside Ethernet (0x86dd) and HDLC (0x86dd) frames', () => {
    const f = createPduFactory();
    const eth = f.build([
      { proto: 'ethernet', fields: { dst: '33:33:00:00:00:01', src: R_MAC, type: ETHERTYPE_IPV6 } },
      v6('fe80::1', 'ff02::1', IPPROTO_ICMPV6, 255),
      { proto: 'icmpv6', fields: { type: ICMPV6_RA, sourceLla: R_MAC } },
    ], meta());
    expect(protos(eth.layers)).toEqual(['ethernet', 'ipv6', 'icmpv6']);
    const serial = f.build([
      { proto: 'hdlc', fields: { protocol: HDLC_PROTO_IPV6 } },
      v6('2001:db8:12::1', '2001:db8:12::2', IPPROTO_ICMPV6),
      { proto: 'icmpv6', fields: { type: ICMPV6_ECHO_REPLY, id: 7, seq: 3 } },
    ], meta());
    expect(protos(serial.layers)).toEqual(['hdlc', 'ipv6', 'icmpv6']);
    expect(serial.get('hdlc.fcsValid')).toBe(true);
    expect(serial.summary()).toBe('ICMPv6 echo reply 2001:db8:12::1 > 2001:db8:12::2 id=7 seq=3');
    expect(fillLinkField('ethernet', {}, 'ipv6')).toEqual({ type: ETHERTYPE_IPV6 });
  });

  it('mutate of hopLimit re-encodes without a header checksum', () => {
    const p = createPduFactory().build([v6('2001:db8:1::5', '2001:db8:2::5', IPPROTO_ICMPV6), { proto: 'icmpv6', fields: { type: 128, id: 1, seq: 1 } }], meta());
    p.mutate({ now: 1, device: 'd_r1' }, 'ipv6.hopLimit', 63, 'TtlDecrement', 'ipv6 route 2001:db8:2::/64 Gi0/1');
    expect(p.provenance.map((m) => `${m.field}:${String(m.before)}>${String(m.after)}`)).toEqual(['ipv6.hopLimit:64>63']);
    expect(p.get('icmpv6.checksumValid')).toBe(true);
  });
});

describe('ipv6 extension headers', () => {
  it('pads hop-by-hop options with Pad1/PadN to 8-byte multiples', () => {
    expect(toHex(padIpv6Options(new Uint8Array(0)))).toBe('010400000000');
    expect(toHex(padIpv6Options(hex('05020000')))).toBe('050200000100'); // router alert + PadN(0)
    expect(toHex(padIpv6Options(hex('0502000001')))).toBe('050200000100'.slice(0, 10) + '00'); // Pad1
    expect(padIpv6Options(hex('000000000000')).length).toBe(6);
  });

  it('chains ipv6 → hop-by-hop → routing → destination options → fragment (atomic) → icmpv6', () => {
    const bytes = encodeLayers([
      v6('2001:db8::1', '2001:db8::2', IPPROTO_HOPOPTS),
      { proto: 'ipv6-hopopts', fields: { nextHeader: IPPROTO_ROUTING, options: hex('05020000') } },
      { proto: 'ipv6-route', fields: { nextHeader: IPPROTO_DSTOPTS, routingType: 0, segmentsLeft: 0, data: hex('00000000') } },
      { proto: 'ipv6-dstopts', fields: { nextHeader: IPPROTO_FRAGMENT } },
      { proto: 'ipv6-frag', fields: { nextHeader: IPPROTO_ICMPV6, offset: 0, more: false, id: 0x01020304 } },
      { proto: 'icmpv6', fields: { type: ICMPV6_ECHO_REQUEST, id: 9, seq: 9 } },
    ]);
    const layers = decodeLayers(bytes, 'ipv6');
    expect(protos(layers)).toEqual(['ipv6', 'ipv6-hopopts', 'ipv6-route', 'ipv6-dstopts', 'ipv6-frag', 'icmpv6']);
    expect(layers[1]!.fields).toEqual({ nextHeader: IPPROTO_ROUTING, hdrExtLen: 0, options: hex('050200000100') });
    expect(layers[1]!.headerLength).toBe(8);
    expect(layers[2]!.fields).toEqual({ nextHeader: IPPROTO_DSTOPTS, hdrExtLen: 0, routingType: 0, segmentsLeft: 0, data: hex('00000000') });
    expect(layers[3]!.fields.options).toEqual(hex('010400000000'));
    expect(layers[4]!.fields).toEqual({ nextHeader: IPPROTO_ICMPV6, offset: 0, more: false, id: 0x01020304 });
    // the ICMPv6 pseudo-header uses the upper-layer length, excluding the extension headers
    expect(layers[5]!.fields.checksumValid).toBe(true);
    expect(icmpv6ChecksumOk('2001:db8::1', '2001:db8::2', layerBytes(bytes, layers[5]!))).toBe(true);
    expect(fillLinkField('ipv6-frag', {}, 'udp')).toEqual({ nextHeader: IPPROTO_UDP });
  });

  it('a non-atomic fragment carries raw payload (no reassembly in P1)', () => {
    const first = encodeLayers([
      v6('::1', '::2', IPPROTO_FRAGMENT),
      { proto: 'ipv6-frag', fields: { nextHeader: IPPROTO_UDP, offset: 0, more: true, id: 5 } },
      { proto: 'payload', fields: { data: new Uint8Array(16) } },
    ]);
    expect(protos(decodeLayers(first, 'ipv6'))).toEqual(['ipv6', 'ipv6-frag', 'payload']);
    const later = encodeLayers([
      v6('::1', '::2', IPPROTO_FRAGMENT),
      { proto: 'ipv6-frag', fields: { nextHeader: IPPROTO_UDP, offset: 2, more: false, id: 5 } },
      { proto: 'payload', fields: { data: new Uint8Array(8) } },
    ]);
    const l = decodeLayers(later, 'ipv6');
    expect(protos(l)).toEqual(['ipv6', 'ipv6-frag', 'payload']);
    expect(toHex(later.slice(40, 48))).toBe('1100001000000005');
    expect(l[1]!.fields).toEqual({ nextHeader: IPPROTO_UDP, offset: 2, more: false, id: 5 });
  });

  it('a routing header of type 0 decodes its segments left; long data grows hdrExtLen', () => {
    const bytes = encodeLayers([
      v6('::1', '::2', IPPROTO_ROUTING),
      { proto: 'ipv6-route', fields: { nextHeader: IPPROTO_NONE, routingType: 0, segmentsLeft: 1, data: new Uint8Array(4 + 16) } },
    ]);
    const r = decodeLayers(bytes, 'ipv6')[1]!;
    expect(r.fields).toMatchObject({ routingType: 0, segmentsLeft: 1, hdrExtLen: 2 });
    expect(r.headerLength).toBe(24);
    expect(ipv6RouteCodec.summarize(r.fields)).toBe('IPv6 routing type=0 segments-left=1 next=59');
  });

  it('reports truncated extension headers', () => {
    expect(ipv6HopOptsCodec.decode(hex('3a01000000000000'), 0, 8).error).toBe('IPv6 hop-by-hop options header truncated');
    expect(ipv6DstOptsCodec.decode(hex('3a'), 0, 1).error).toBe('IPv6 destination options header truncated');
    expect(ipv6RouteCodec.decode(hex('3a00'), 0, 2).error).toBe('IPv6 routing header truncated');
    expect(ipv6FragCodec.decode(hex('3a000000'), 0, 4).error).toBe('IPv6 fragment header truncated');
  });

  it('derived maps name hdrExtLen / payloadLength from PROTO_FIELDS', () => {
    for (const c of [ipv6Codec, ipv6HopOptsCodec, ipv6RouteCodec, ipv6DstOptsCodec]) {
      for (const name of Object.keys(c.derived ?? {})) {
        expect(PROTO_FIELDS[c.proto]!.fields.find((x) => x.name === name)?.derived, `${c.proto}.${name}`).toBe(true);
      }
    }
  });
});

describe('icmpv6 neighbour discovery', () => {
  it('DAD neighbour solicitation from :: to the solicited-node group matches the independent bytes', () => {
    const target = '2001:db8:1::1';
    const dst = solicitedNodeMulticast(target);
    expect(dst).toBe('ff02::1:ff00:1');
    const bytes = encodeLayers([v6('::', dst, IPPROTO_ICMPV6, IPV6_ND_HOP_LIMIT), { proto: 'icmpv6', fields: { type: ICMPV6_NS, target } }]);
    const [ip, ns] = decodeLayers(bytes, 'ipv6');
    expect(toHex(layerBytes(bytes, ns!))).toBe('87004cec0000000020010db8000100000000000000000001');
    expect(ip!.fields.hopLimit).toBe(255);
    expect(ns!.fields).toEqual({ type: 135, code: 0, checksum: 0x4cec, checksumValid: true, target });
    expect(ns!.headerLength).toBe(24);
    expect(ns!.fieldRanges.target).toEqual([48, 16]);
    expect(icmpv6Codec.summarize(ns!.fields, { outer: [{ proto: 'ipv6', fields: ip!.fields }] })).toBe(
      'ICMPv6 neighbour solicitation for 2001:db8:1::1 :: > ff02::1:ff00:1',
    );
  });

  it('router advertisement with source LLA, MTU and prefix information matches the independent bytes', () => {
    const bytes = encodeLayers([
      v6('fe80::1', 'ff02::1', IPPROTO_ICMPV6, 255),
      {
        proto: 'icmpv6',
        fields: {
          type: ICMPV6_RA, sourceLla: R_MAC, mtu: 1500, prefix: '2001:db8:1::', prefixLen: 64,
          validLifetimeS: 2_592_000, preferredLifetimeS: 604_800,
        },
      },
    ]);
    const ra = decodeLayers(bytes, 'ipv6')[1]!;
    expect(toHex(layerBytes(bytes, ra))).toBe(
      '8600efc04000070800000000000000000101001f0000000a05010000000005dc030440c000278d0000093a800000000020010db8000100000000000000000000',
    );
    expect(ra.fields).toEqual({
      type: 134, code: 0, checksum: 0xefc0, checksumValid: true, curHopLimit: 64, managedFlag: false, otherFlag: false,
      routerLifetimeS: 1800, sourceLla: R_MAC, mtu: 1500, prefix: '2001:db8:1::', prefixLen: 64,
      validLifetimeS: 2_592_000, preferredLifetimeS: 604_800,
    });
    expect(ra.error).toBeUndefined();
  });

  it('RA encode zeroes prefix bits past the length, honours flags/lifetime and keeps only the first prefix on decode', () => {
    const bytes = encodeLayers([
      v6('fe80::1', 'ff02::1', IPPROTO_ICMPV6, 255),
      { proto: 'icmpv6', fields: { type: ICMPV6_RA, prefix: '2001:db8:1::77', prefixLen: 64, managedFlag: true, otherFlag: true, routerLifetimeS: 0, curHopLimit: 0 } },
    ]);
    const ra = decodeLayers(bytes, 'ipv6')[1]!;
    expect(ra.fields).toMatchObject({ prefix: '2001:db8:1::', managedFlag: true, otherFlag: true, routerLifetimeS: 0, curHopLimit: 0 });
    // append a second prefix option by hand: decode keeps the first one
    const msg = layerBytes(bytes, ra);
    const second = hex('0304 30c0 00000001 00000001 00000000' + '20010db8000200000000000000000000');
    const joined = new Uint8Array(msg.length + second.length);
    joined.set(msg, 0);
    joined.set(second, msg.length);
    const d = icmpv6Codec.decode(joined, 0, joined.length);
    expect(d.fields.prefix).toBe('2001:db8:1::');
    expect(d.fields.prefixLen).toBe(64);
    expect(d.error).toBeUndefined();
  });

  it('decodes RDNSS servers (decode-only) and rejects zero-length options', () => {
    const ra = hex(
      '8600 0000 40 00 0708 00000000 00000000' +
        '1905 0000 00000e10' +
        '20010db8000000000000000000000053' +
        '20010db8000000000000000000000054',
    );
    const d = icmpv6Codec.decode(ra, 0, ra.length);
    expect(d.fields.rdnss).toBe('2001:db8::53,2001:db8::54');
    expect(d.fields.checksumValid).toBeUndefined(); // no enclosing ipv6 layer
    const bad = hex('8500 0000 00000000 0100 000000000000');
    expect(icmpv6Codec.decode(bad, 0, bad.length).error).toBe('ICMPv6 option 1 has length 0');
    const over = hex('8500 0000 00000000 0102 001f0000000a');
    expect(icmpv6Codec.decode(over, 0, over.length).error).toBe('ICMPv6 option 1 runs past the message');
  });

  it('neighbour advertisement flags and target LLA match the independent bytes', () => {
    const bytes = encodeLayers([
      v6('2001:db8:1::1', 'fe80::2', IPPROTO_ICMPV6, 255),
      { proto: 'icmpv6', fields: { type: ICMPV6_NA, target: '2001:db8:1::1', solicitedFlag: true, overrideFlag: true, targetLla: R_MAC } },
    ]);
    const na = decodeLayers(bytes, 'ipv6')[1]!;
    expect(toHex(layerBytes(bytes, na))).toBe('8800bb816000000020010db80001000000000000000000010201001f0000000a');
    expect(na.fields).toMatchObject({ routerFlag: false, solicitedFlag: true, overrideFlag: true, targetLla: R_MAC, checksumValid: true });
    expect(icmpv6Codec.summarize(na.fields)).toBe(`ICMPv6 neighbour advertisement 2001:db8:1::1 is at ${R_MAC} [SO]`);
  });

  it('router solicitation carries the source LLA; NS/NA require a target', () => {
    const ll = linkLocalFromMac(PC_MAC);
    const bytes = encodeLayers([v6(ll, 'ff02::2', IPPROTO_ICMPV6, 255), { proto: 'icmpv6', fields: { type: ICMPV6_RS, sourceLla: PC_MAC } }]);
    const rs = decodeLayers(bytes, 'ipv6')[1]!;
    expect(toHex(layerBytes(bytes, rs)).slice(8)).toBe('00000000' + '0101' + '020000000001');
    expect(rs.fields).toMatchObject({ type: 133, sourceLla: PC_MAC, checksumValid: true });
    expect(icmpv6ChecksumOk(ll, 'ff02::2', layerBytes(bytes, rs))).toBe(true);
    expect(() => encodeLayers([v6('::', 'ff02::1', 58), { proto: 'icmpv6', fields: { type: ICMPV6_NS } }])).toThrow(/icmpv6\.target is required/);
    expect(isNdType(ICMPV6_RS)).toBe(true);
    expect(isNdType(ICMPV6_ECHO_REQUEST)).toBe(false);
  });

  it('checksum verification fails on corruption and needs an IPv6 pseudo-header', () => {
    const bytes = encodeLayers([v6('fe80::1', 'fe80::2', IPPROTO_ICMPV6), { proto: 'icmpv6', fields: { type: ICMPV6_ECHO_REQUEST, id: 1, seq: 2 } }]);
    bytes[45] = bytes[45]! ^ 0x01;
    expect(decodeLayers(bytes, 'ipv6')[1]!.fields.checksumValid).toBe(false);
    const bare = encodeLayers([{ proto: 'icmpv6', fields: { type: ICMPV6_ECHO_REQUEST } }]);
    expect(toHex(bare)).toBe('8000000000000000');
  });
});

describe('icmpv6 errors and quoting', () => {
  it('port unreachable quotes the invoking IPv6 + UDP datagram as nested layers and stops meaning', () => {
    const f = createPduFactory();
    const probe = f.build([
      v6('2001:db8::2', '2001:db8::80', IPPROTO_UDP, 1),
      { proto: 'udp', fields: { srcPort: 49152, dstPort: 33434 } },
      { proto: 'payload', fields: { data: new Uint8Array(12) } },
    ], meta());
    const err = f.build([
      { proto: 'ethernet', fields: { dst: PC_MAC, src: R_MAC, type: ETHERTYPE_IPV6 } },
      v6('2001:db8::80', '2001:db8::2', IPPROTO_ICMPV6),
      { proto: 'icmpv6', fields: { type: ICMPV6_DEST_UNREACHABLE, code: ICMPV6_UNREACH_PORT } },
      { proto: 'payload', fields: { data: probe.bytes } },
    ], meta());
    expect(protos(err.layers)).toEqual(['ethernet', 'ipv6', 'icmpv6', 'ipv6', 'udp', 'payload']);
    expect(err.layerAt(2)!.fields).toMatchObject({ type: 1, code: 4, unused: 0, checksumValid: true });
    const quotedUdp = err.layerAt(4)!;
    expect(quotedUdp.fields).toMatchObject({ srcPort: 49152, dstPort: 33434 });
    expect(quotedUdp.fields.checksumValid).toBeUndefined();
    expect(quotedUdp.error).toBeUndefined();
    expect(err.layerAt(3)!.fields.hopLimit).toBe(1);
    expect(err.topProto()).toBe('icmpv6');
    expect(err.summary()).toBe('ICMPv6 destination unreachable (port)');
    expect(isIcmpv6Error(ICMPV6_DEST_UNREACHABLE)).toBe(true);
    expect(icmpv6Codec.stopsMeaning!({ type: ICMPV6_ECHO_REQUEST })).toBe(false);
    expect(icmpv6Codec.stopsMeaning!({ type: ICMPV6_TIME_EXCEEDED })).toBe(true);
  });

  it('packet too big carries mtu; parameter problem carries pointer; time exceeded names the code', () => {
    const quote = encodeLayers([v6('::1', '::2', IPPROTO_NONE)]);
    const mk = (fields: Record<string, number>): LayerView =>
      decodeLayers(encodeLayers([v6('::2', '::1', IPPROTO_ICMPV6), { proto: 'icmpv6', fields }, { proto: 'payload', fields: { data: quote } }]), 'ipv6')[1]!;
    const ptb = mk({ type: ICMPV6_PACKET_TOO_BIG, mtu: 1280 });
    expect(ptb.fields.mtu).toBe(1280);
    expect(icmpv6Codec.summarize(ptb.fields)).toBe('ICMPv6 packet too big mtu=1280');
    const pp = mk({ type: ICMPV6_PARAM_PROBLEM, code: 1, pointer: 6 });
    expect(pp.fields.pointer).toBe(6);
    expect(icmpv6Codec.summarize(pp.fields)).toBe('ICMPv6 parameter problem (unknown next header) pointer=6');
    const te = mk({ type: ICMPV6_TIME_EXCEEDED, code: 0 });
    expect(icmpv6Codec.summarize(te.fields)).toBe('ICMPv6 time exceeded (hop limit)');
    const chain = decodeLayers(encodeLayers([
      v6('::2', '::1', IPPROTO_ICMPV6),
      { proto: 'icmpv6', fields: { type: ICMPV6_TIME_EXCEEDED, code: 0 } },
      { proto: 'payload', fields: { data: quote } },
    ]), 'ipv6');
    expect(protos(chain)).toEqual(['ipv6', 'icmpv6', 'ipv6']);
    expect(chain[2]!.offset).toBe(te.offset + 8);
    expect(chain[2]!.length).toBe(40);
  });

  it('decodeStandalone of a raw IPv6 packet uses the ipv6 outer', () => {
    const bytes = encodeLayers([v6('2001:db8::1', '2001:db8::2', IPPROTO_ICMPV6), { proto: 'icmpv6', fields: { type: ICMPV6_ECHO_REQUEST, id: 1, seq: 1 } }]);
    const d = decodeStandalone(bytes, 'ipv6');
    expect(protos(d.layers)).toEqual(['ipv6', 'icmpv6']);
    expect(d.summary).toBe('ICMPv6 echo request 2001:db8::1 > 2001:db8::2 id=1 seq=1');
    expect(d.topProto).toBe('icmpv6');
  });

  it('every decoded icmpv6 field name exists in PROTO_FIELDS', () => {
    const names = new Set(PROTO_FIELDS.icmpv6!.fields.map((x) => x.name));
    const samples: Record<string, unknown>[] = [
      { type: ICMPV6_RA, sourceLla: R_MAC, mtu: 1500, prefix: '2001:db8::', prefixLen: 64 },
      { type: ICMPV6_NA, target: '::1', targetLla: R_MAC, routerFlag: true },
      { type: ICMPV6_NS, target: '::1', sourceLla: R_MAC },
      { type: ICMPV6_ECHO_REQUEST, id: 1, seq: 1 },
      { type: ICMPV6_PARAM_PROBLEM, pointer: 1 },
      { type: ICMPV6_PACKET_TOO_BIG, mtu: 1400 },
      { type: ICMPV6_DEST_UNREACHABLE },
    ];
    for (const s of samples) {
      const l = decodeLayers(encodeLayers([v6('::1', '::2', 58), { proto: 'icmpv6', fields: s as Record<string, never> }]), 'ipv6')[1]!;
      for (const k of Object.keys(l.fields)) expect(names.has(k), k).toBe(true);
    }
  });
});
