/**
 * P1 W2 pdu: UDP (RFC 768) and TCP (RFC 9293, options RFC 7323 / RFC 2018) codecs, pseudo-header checksums
 * (RFC 768 / RFC 8200 §8.1), ICMP quoting, port dispatch, NAT-style re-encode through `outerInputs`, and
 * `decodeStandalone` with `fcsLen`.
 *
 * Golden bytes were computed independently (Python `struct` + an independent RFC 1071 sum), not by the codecs.
 */
import { describe, expect, it } from 'vitest';
import {
  ETHERTYPE_IPV4,
  ETHERTYPE_IPV6,
  HDLC_PROTO_IPV4,
  ICMP_DEST_UNREACHABLE,
  ICMP_UNREACH_PORT,
  ICMPV6_DEST_UNREACHABLE,
  ICMPV6_UNREACH_PORT,
  IPPROTO_ICMP,
  IPPROTO_ICMPV6,
  IPPROTO_TCP,
  IPPROTO_UDP,
} from '../src/contracts/pdu.js';
import type { CodecContext, LayerSpec, LayerView, MutationCtx, PduMeta } from '../src/contracts/pdu.js';
import { PROTO_FIELDS } from '../src/contracts/fields.js';
import { CODECS, decodeChain, decodeLayers, decodeStandalone, encodeLayers } from '../src/pdu/codecs/registry.js';
import { udpCodec, isQuotedContext, nearestIpLayer, pseudoHeaderSumFor } from '../src/pdu/codecs/udp.js';
import { hasTcpFlag, normalizeTcpFlags, parseSackBlocks, tcpCodec, tcpFlagBits, tcpFlagsFromBits } from '../src/pdu/codecs/tcp.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { crc32, internetChecksum, writeU16 } from '../src/pdu/checksum.js';
import { ipv6ToBytes } from '../src/core/addr6.js';
import { ipv4ToBytes } from '../src/contracts/addr.js';

const hex = (s: string): Uint8Array => new Uint8Array((s.replace(/\s+/g, '').match(/.{2}/g) ?? []).map((h) => parseInt(h, 16)));
const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const protos = (layers: readonly LayerView[]): string[] => layers.map((l) => l.proto);
const meta = (): PduMeta => ({ born: 0, origin: 'd_pc1' });
const mctx = (): MutationCtx => ({ now: 1000, device: 'd_r1' });

const MAC1 = '02:00:00:00:00:01';
const MAC2 = '02:00:00:00:00:02';
const PC = '192.168.1.2';
const SRV = '192.168.1.80';

/** Independent RFC 768 / 793 check: pseudo-header written out byte by byte, summed with RFC 1071. */
function transportChecksumOk4(src: string, dst: string, proto: number, seg: Uint8Array): boolean {
  const buf = new Uint8Array(12 + seg.length);
  buf.set(ipv4ToBytes(src), 0);
  buf.set(ipv4ToBytes(dst), 4);
  buf[9] = proto;
  writeU16(buf, 10, seg.length);
  buf.set(seg, 12);
  return internetChecksum(buf) === 0;
}

/** Independent RFC 8200 §8.1 check. */
function transportChecksumOk6(src: string, dst: string, proto: number, seg: Uint8Array): boolean {
  const buf = new Uint8Array(40 + seg.length);
  buf.set(ipv6ToBytes(src), 0);
  buf.set(ipv6ToBytes(dst), 16);
  buf[34] = (seg.length >>> 8) & 0xff;
  buf[35] = seg.length & 0xff;
  buf[39] = proto;
  buf.set(seg, 40);
  return internetChecksum(buf) === 0;
}

const layerBytes = (bytes: Uint8Array, l: LayerView): Uint8Array => bytes.slice(l.offset, l.offset + l.length);

const udp4 = (data: Uint8Array, srcPort = 49152, dstPort = 7): LayerSpec[] => [
  { proto: 'ethernet', fields: { dst: MAC2, src: MAC1, type: ETHERTYPE_IPV4 } },
  { proto: 'ipv4', fields: { src: PC, dst: SRV, protocol: IPPROTO_UDP, ttl: 128 } },
  { proto: 'udp', fields: { srcPort, dstPort } },
  { proto: 'payload', fields: { data } },
];

const udp6 = (data: Uint8Array, srcPort = 547, dstPort = 546): LayerSpec[] => [
  { proto: 'ethernet', fields: { dst: MAC2, src: MAC1, type: ETHERTYPE_IPV6 } },
  { proto: 'ipv6', fields: { src: '2001:db8::1', dst: '2001:db8::2', nextHeader: IPPROTO_UDP } },
  { proto: 'udp', fields: { srcPort, dstPort } },
  { proto: 'payload', fields: { data } },
];

describe('udp codec', () => {
  it('encodes RFC 768 over IPv4 byte-identical to an independent computation', () => {
    const bytes = encodeLayers(udp4(new TextEncoder().encode('hello')));
    const layers = decodeLayers(bytes);
    expect(protos(layers)).toEqual(['ethernet', 'ipv4', 'udp', 'payload']);
    const u = layers[2]!;
    expect(toHex(layerBytes(bytes, u))).toBe('c0000007000d785768656c6c6f');
    expect(u.fields).toEqual({ srcPort: 49152, dstPort: 7, length: 13, checksum: 0x7857, checksumValid: true });
    expect(u.headerLength).toBe(8);
    expect(u.length).toBe(13);
    expect(u.fieldRanges.checksum).toEqual([u.offset + 6, 2]);
    expect(transportChecksumOk4(PC, SRV, IPPROTO_UDP, layerBytes(bytes, u))).toBe(true);
    // ethernet padding (60-byte minimum) is not attributed to UDP
    expect(bytes.length).toBe(64);
    expect(layers[0]!.fields.padding).toBe(64 - 4 - 14 - 20 - 13);
  });

  it('sends a computed checksum of 0 as 0xffff (RFC 768)', () => {
    const specs: LayerSpec[] = [
      { proto: 'ipv4', fields: { src: '10.0.0.1', dst: '10.0.0.2', protocol: IPPROTO_UDP } },
      { proto: 'udp', fields: { srcPort: 1000, dstPort: 2000 } },
      { proto: 'payload', fields: { data: hex('0000e01b') } },
    ];
    const layers = decodeLayers(encodeLayers(specs), 'ipv4');
    expect(layers[1]!.fields.checksum).toBe(0xffff);
    expect(layers[1]!.fields.checksumValid).toBe(true);
  });

  it('over IPv4 a transmitted 0 means "no checksum": checksumValid stays undefined', () => {
    const bytes = encodeLayers(udp4(hex('01020304')));
    const u = decodeLayers(bytes)[2]!;
    bytes[u.offset + 6] = 0;
    bytes[u.offset + 7] = 0;
    const again = decodeLayers(bytes)[2]!;
    expect(again.fields.checksum).toBe(0);
    expect(again.fields.checksumValid).toBeUndefined();
    expect(again.error).toBeUndefined();
  });

  it('over IPv6 the checksum is mandatory: golden bytes, and 0 is invalid', () => {
    const bytes = encodeLayers(udp6(hex('01020304')));
    const layers = decodeLayers(bytes);
    expect(protos(layers)).toEqual(['ethernet', 'ipv6', 'udp', 'payload']);
    const u = layers[2]!;
    expect(toHex(layerBytes(bytes, u))).toBe('02230222000c9c1601020304');
    expect(u.fields.checksumValid).toBe(true);
    expect(transportChecksumOk6('2001:db8::1', '2001:db8::2', IPPROTO_UDP, layerBytes(bytes, u))).toBe(true);
    bytes[u.offset + 6] = 0;
    bytes[u.offset + 7] = 0;
    expect(decodeLayers(bytes)[2]!.fields.checksumValid).toBe(false);
  });

  it('flags a corrupted datagram as checksumValid false', () => {
    const bytes = encodeLayers(udp4(hex('01020304')));
    const u = decodeLayers(bytes)[2]!;
    bytes[u.offset + 9] = bytes[u.offset + 9]! ^ 0x40;
    expect(decodeLayers(bytes)[2]!.fields.checksumValid).toBe(false);
  });

  it('dispatches by destination port, then source port, only with data (DISPATCH_TABLE udp.port)', () => {
    const chain = (src: number, dst: number, data: Uint8Array): string[] => protos(decodeLayers(encodeLayers(udp4(data, src, dst))));
    expect(chain(49152, 53, new Uint8Array(12)).slice(0, 4)).toEqual(['ethernet', 'ipv4', 'udp', 'dns']);
    expect(chain(53, 49152, new Uint8Array(12)).slice(0, 4)).toEqual(['ethernet', 'ipv4', 'udp', 'dns']);
    expect(chain(68, 67, new Uint8Array(4))[3]).toBe('dhcp');
    expect(chain(40000, 69, new Uint8Array(4))[3]).toBe('payload'); // reserved tftp decodes as payload
    expect(chain(40000, 40001, new Uint8Array(4))[3]).toBe('payload');
    expect(chain(40000, 53, new Uint8Array(0))).toEqual(['ethernet', 'ipv4', 'udp']);
  });

  it('reports header truncation, bad lengths and truncated datagrams', () => {
    const ctx = { outer: [{ proto: 'ipv4', fields: { src: PC, dst: SRV } }] };
    const short = udpCodec.decode(hex('c0000007'), 0, 4, ctx);
    expect(short.error).toBe('UDP header truncated');
    expect(short.fields).toEqual({ srcPort: 49152, dstPort: 7 });
    const bad = udpCodec.decode(hex('c000000700040000'), 0, 8, ctx);
    expect(bad.error).toMatch(/smaller than the header/);
    const cut = udpCodec.decode(hex('c0000007001400000102'), 0, 10, ctx);
    expect(cut.error).toMatch(/truncated \(length 20, 10 bytes present\)/);
    expect(cut.length).toBe(10);
    expect(cut.fields.checksumValid).toBeUndefined();
    // trailing bytes past the declared length are not attributed to UDP
    const long = udpCodec.decode(hex('c000000700090000ff0000'), 0, 11, ctx);
    expect(long.length).toBe(9);
  });

  it('decodes a UDP header quoted in an ICMP port unreachable without error or checksum verdict', () => {
    const f = createPduFactory();
    const probe = f.build(udp4(new Uint8Array(12), 49152, 33434), meta());
    const ip = probe.layer('ipv4')!;
    const quote = probe.bytes.slice(ip.offset, ip.offset + ip.headerLength + 8);
    const err = f.build([
      { proto: 'ethernet', fields: { dst: MAC1, src: MAC2, type: ETHERTYPE_IPV4 } },
      { proto: 'ipv4', fields: { src: SRV, dst: PC, protocol: IPPROTO_ICMP, ttl: 255 } },
      { proto: 'icmpv4', fields: { type: ICMP_DEST_UNREACHABLE, code: ICMP_UNREACH_PORT } },
      { proto: 'payload', fields: { data: quote } },
    ], meta());
    expect(protos(err.layers)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'ipv4', 'udp']);
    const q = err.layerAt(4)!;
    expect(q.error).toBeUndefined();
    expect(q.fields).toMatchObject({ srcPort: 49152, dstPort: 33434, length: 20 });
    expect(q.fields.checksumValid).toBeUndefined();
    expect(q.length).toBe(8);
    expect(err.topProto()).toBe('icmpv4');
    expect(err.summary()).toBe('ICMP destination unreachable (port)');
  });

  it('summarizes with endpoints from the enclosing IP layer', () => {
    const p = createPduFactory().build(udp4(new Uint8Array(3), 49152, 9999), meta());
    expect(p.summary()).toBe(`UDP ${PC}:49152 > ${SRV}:9999 len=3`);
    const p6 = createPduFactory().build(udp6(new Uint8Array(3), 1000, 9999), meta());
    expect(p6.summary()).toBe('UDP [2001:db8::1]:1000 > [2001:db8::2]:9999 len=3');
    expect(p6.topProto()).toBe('udp');
  });

  it('without an enclosing IP layer encodes checksum 0 and never verifies', () => {
    const bytes = encodeLayers([{ proto: 'udp', fields: { srcPort: 1, dstPort: 2 } }]);
    expect(toHex(bytes)).toBe('0001000200080000');
    const d = decodeLayers(bytes, 'udp')[0]!;
    expect(d.fields.checksumValid).toBeUndefined();
    expect(() => encodeLayers([{ proto: 'udp', fields: { srcPort: 1 } }])).toThrow(/udp\.dstPort is required/);
    expect(() => encodeLayers([{ proto: 'udp', fields: { srcPort: 70000, dstPort: 1 } }])).toThrow(/out of range/);
  });
});

describe('tcp codec', () => {
  const syn = (): LayerSpec[] => [
    { proto: 'ethernet', fields: { dst: MAC2, src: MAC1, type: ETHERTYPE_IPV4 } },
    { proto: 'ipv4', fields: { src: PC, dst: SRV, protocol: IPPROTO_TCP } },
    { proto: 'tcp', fields: { srcPort: 49152, dstPort: 80, seq: 0x12345678, flags: 'S', window: 65535, mss: 1460 } },
  ];

  it('encodes a SYN with MSS byte-identical to an independent computation', () => {
    const bytes = encodeLayers(syn());
    const layers = decodeLayers(bytes);
    expect(protos(layers)).toEqual(['ethernet', 'ipv4', 'tcp']);
    const t = layers[2]!;
    expect(toHex(layerBytes(bytes, t))).toBe('c000005012345678000000006002ffffeb860000020405b4');
    expect(t.fields).toEqual({
      srcPort: 49152, dstPort: 80, seq: 0x12345678, ack: 0, dataOffset: 6, flags: 'S', window: 65535,
      checksum: 0xeb86, urgentPointer: 0, mss: 1460, checksumValid: true,
    });
    expect(t.headerLength).toBe(24);
    expect(t.fieldRanges.mss).toEqual([t.offset + 20, 4]);
    expect(transportChecksumOk4(PC, SRV, IPPROTO_TCP, layerBytes(bytes, t))).toBe(true);
  });

  it('encodes a SYN-ACK over IPv6 byte-identical to an independent computation', () => {
    const bytes = encodeLayers([
      { proto: 'ipv6', fields: { src: '2001:db8::80', dst: '2001:db8::2', nextHeader: IPPROTO_TCP } },
      { proto: 'tcp', fields: { srcPort: 80, dstPort: 49152, seq: 0x0a0b0c0d, ack: 0x12345679, flags: 'AS', mss: 1440 } },
    ]);
    const t = decodeLayers(bytes, 'ipv6')[1]!;
    expect(toHex(layerBytes(bytes, t))).toBe('0050c0000a0b0c0d123456796012fffffd200000020405a0');
    expect(t.fields.flags).toBe('SA');
    expect(t.fields.checksumValid).toBe(true);
  });

  it('flag letters keep the fixed order FSRPAUEC', () => {
    expect(TCP_FLAGS_ALL()).toBe('FSRPAUEC');
    expect(tcpFlagsFromBits(0x12)).toBe('SA');
    expect(tcpFlagsFromBits(0x18)).toBe('PA');
    expect(tcpFlagsFromBits(0x11)).toBe('FA');
    expect(tcpFlagsFromBits(0x14)).toBe('RA');
    expect(tcpFlagBits('SA')).toBe(0x12);
    expect(tcpFlagBits('')).toBe(0);
    expect(tcpFlagBits(0x04)).toBe(0x04);
    expect(normalizeTcpFlags('AP')).toBe('PA');
    expect(hasTcpFlag('SA', 'S')).toBe(true);
    expect(hasTcpFlag('A', 'S')).toBe(false);
    expect(() => tcpFlagBits('SX')).toThrow(/unknown flag letter "X"/);
    expect(() => tcpFlagBits('SS')).toThrow(/repeats/);
  });

  it('round-trips every option in canonical order with NOP alignment', () => {
    const fields = {
      srcPort: 1, dstPort: 2, seq: 0xfffffffe, ack: 5, flags: 'SA', window: 1000,
      mss: 1400, sackPermitted: true, timestamp: 0xdeadbeef, timestampEcho: 7, windowScale: 7, sackBlocks: '10-20,30-40',
    };
    const bytes = encodeLayers([{ proto: 'ipv4', fields: { src: PC, dst: SRV, protocol: IPPROTO_TCP } }, { proto: 'tcp', fields }]);
    const t = decodeLayers(bytes, 'ipv4')[1]!;
    const opts = layerBytes(bytes, t).slice(20);
    // MSS | SACK-perm + TS | NOP WS | NOP NOP SACK(2 blocks)
    expect(toHex(opts)).toBe('02040578' + '0402' + '080adeadbeef00000007' + '01030307' + '0101' + '0512' + '0000000a00000014' + '0000001e00000028');
    expect(opts.length % 4).toBe(0);
    expect(t.fields).toMatchObject({ ...fields, dataOffset: (20 + opts.length) / 4, checksumValid: true });
    expect(parseSackBlocks('1-2, 3-4')).toEqual([[1, 2], [3, 4]]);
    expect(() => parseSackBlocks('1-2,3-4,5-6,7-8,9-10')).toThrow(/at most 4/);
  });

  it('skips NOP/unknown options and reports malformed option lists without losing the header', () => {
    const ctx = { outer: [{ proto: 'ipv4', fields: { src: PC, dst: SRV } }] };
    const base = '0001000200000001000000007002ffff00000000';
    const ok = tcpCodec.decode(hex(base + '01' + 'fe03aa' + '02040200' + '000000'), 0, 30, ctx);
    expect(ok.error).toBeUndefined();
    expect(ok.fields.mss).toBe(512);
    const bad = tcpCodec.decode(hex(base + '0209000000000000' + '00000000'), 0, 28, ctx);
    expect(bad.error).toMatch(/option 2 has a bad length 9/);
    expect(bad.fields.flags).toBe('S');
    const trunc = tcpCodec.decode(hex(base.slice(0, 30)), 0, 15, ctx);
    expect(trunc.error).toBe('TCP header truncated');
    const off = tcpCodec.decode(hex('0001000200000001000000004002ffff00000000'), 0, 20, ctx);
    expect(off.error).toBe('bad TCP data offset 4');
  });

  it('dispatches by tcp.port whenever the segment carries data; not for empty segments', () => {
    const seg = (src: number, dst: number, data: Uint8Array): string[] =>
      protos(decodeLayers(encodeLayers([
        { proto: 'ipv4', fields: { src: PC, dst: SRV, protocol: IPPROTO_TCP } },
        { proto: 'tcp', fields: { srcPort: src, dstPort: dst, flags: 'PA' } },
        { proto: 'payload', fields: { data } },
      ]), 'ipv4'));
    const get = new TextEncoder().encode('GET / HTTP/1.1\r\n\r\n');
    expect(seg(49152, 80, get)).toEqual(['ipv4', 'tcp', 'http']);
    expect(seg(80, 49152, new TextEncoder().encode('HTTP/1.1 200 OK\r\n\r\n'))).toEqual(['ipv4', 'tcp', 'http']);
    expect(seg(49152, 8080, get)).toEqual(['ipv4', 'tcp', 'http']);
    expect(seg(49152, 53, hex('001c1a2b'))[2]).toBe('dns');
    expect(seg(49152, 23, get)).toEqual(['ipv4', 'tcp', 'payload']); // reserved telnet
    expect(seg(49152, 80, new Uint8Array(0))).toEqual(['ipv4', 'tcp']);
  });

  it('an 8-byte TCP header quoted in an ICMPv6 error decodes without error', () => {
    const f = createPduFactory();
    const orig = f.build([
      { proto: 'ipv6', fields: { src: '2001:db8::2', dst: '2001:db8::80', nextHeader: IPPROTO_TCP } },
      { proto: 'tcp', fields: { srcPort: 49152, dstPort: 81, seq: 99, flags: 'S' } },
    ], meta());
    const quote = orig.bytes.slice(0, 48);
    const err = f.build([
      { proto: 'ipv6', fields: { src: '2001:db8::80', dst: '2001:db8::2', nextHeader: IPPROTO_ICMPV6 } },
      { proto: 'icmpv6', fields: { type: ICMPV6_DEST_UNREACHABLE, code: ICMPV6_UNREACH_PORT } },
      { proto: 'payload', fields: { data: quote } },
    ], meta());
    expect(protos(err.layers)).toEqual(['ipv6', 'icmpv6', 'ipv6', 'tcp']);
    const q = err.layerAt(3)!;
    expect(q.error).toBeUndefined();
    expect(q.fields).toEqual({ srcPort: 49152, dstPort: 81, seq: 99 });
    expect(err.layerAt(2)!.error).toBeUndefined(); // quoted ipv6 payloadLength exceeds the quote: clamped
    expect(err.layerAt(1)!.fields.checksumValid).toBe(true);
  });

  it('summarizes flags, seq/ack and window', () => {
    const p = createPduFactory().build(syn(), meta());
    expect(p.summary()).toBe(`TCP ${PC}:49152 > ${SRV}:80 [S] seq=305419896 win=65535 mss=1460`);
    expect(p.topProto()).toBe('tcp');
    const ack = createPduFactory().build([
      { proto: 'ipv4', fields: { src: PC, dst: SRV, protocol: IPPROTO_TCP } },
      { proto: 'tcp', fields: { srcPort: 49152, dstPort: 80, seq: 1, ack: 2, flags: 'A' } },
    ], meta());
    expect(ack.summary()).toBe(`TCP ${PC}:49152 > ${SRV}:80 [A] seq=1 ack=2 win=65535`);
  });
});

/** Canonical letters, spelled out from bits 0..7. */
function TCP_FLAGS_ALL(): string {
  return tcpFlagsFromBits(0xff);
}

describe('pseudo-header context helpers', () => {
  it('find the nearest IP layer and detect ICMP quotes', () => {
    const outer: CodecContext['outer'] = [
      { proto: 'ipv4', fields: { src: '1.1.1.1', dst: '2.2.2.2' } },
      { proto: 'icmpv4', fields: { type: 3 } },
      { proto: 'ipv4', fields: { src: '3.3.3.3', dst: '4.4.4.4' } },
    ];
    expect(nearestIpLayer({ outer })).toMatchObject({ family: 4, index: 2 });
    expect(isQuotedContext({ outer })).toBe(true);
    expect(isQuotedContext({ outer: outer.slice(0, 1) })).toBe(false);
    expect(nearestIpLayer({ outer: [] })).toBeUndefined();
    expect(pseudoHeaderSumFor({ outer: [{ proto: 'ipv4', fields: { src: 'bad', dst: '1.1.1.1' } }] }, 17, 8)).toBeUndefined();
  });
});

describe('outerInputs re-encode with the real codecs (NAT-style mutate)', () => {
  it('mutate ipv4.src records src, udp.checksum, ipv4.checksum and ethernet.fcs; the result verifies', () => {
    const p = createPduFactory().build(udp4(hex('0102030405')), meta());
    p.mutate(mctx(), 'ipv4.src', '203.0.113.9', 'NatTranslate', 'ip nat inside source static');
    expect(p.provenance.map((m) => `${m.reason}:${m.field}`)).toEqual([
      'NatTranslate:ipv4.src',
      'ChecksumRecompute:udp.checksum',
      'ChecksumRecompute:ipv4.checksum',
      'FcsRecompute:ethernet.fcs',
    ]);
    expect(p.get('udp.checksumValid')).toBe(true);
    const u = p.layer('udp')!;
    expect(transportChecksumOk4('203.0.113.9', SRV, IPPROTO_UDP, layerBytes(p.bytes, u))).toBe(true);
  });

  it('mutate ipv4.dst re-encodes TCP the same way', () => {
    const p = createPduFactory().build([
      { proto: 'ethernet', fields: { dst: MAC2, src: MAC1, type: ETHERTYPE_IPV4 } },
      { proto: 'ipv4', fields: { src: PC, dst: SRV, protocol: IPPROTO_TCP } },
      { proto: 'tcp', fields: { srcPort: 49152, dstPort: 80, flags: 'S', mss: 1460 } },
    ], meta());
    p.mutate(mctx(), 'ipv4.dst', '10.9.9.9', 'NatTranslate');
    expect(p.provenance.map((m) => m.field)).toEqual(['ipv4.dst', 'tcp.checksum', 'ipv4.checksum', 'ethernet.fcs']);
    expect(p.get('tcp.checksumValid')).toBe(true);
  });

  it('TTL and hop-limit mutates keep their exact P0-style counts', () => {
    const p = createPduFactory().build(udp4(hex('01')), meta());
    p.mutate(mctx(), 'ipv4.ttl', 127, 'TtlDecrement', 'ip route 0.0.0.0 0.0.0.0 10.0.0.1');
    expect(p.provenance.map((m) => m.field)).toEqual(['ipv4.ttl', 'ipv4.checksum', 'ethernet.fcs']);
    const p6 = createPduFactory().build(udp6(hex('01')), meta());
    p6.mutate(mctx(), 'ipv6.hopLimit', 63, 'TtlDecrement', 'ipv6 route ::/0 2001:db8::ff');
    expect(p6.provenance.map((m) => m.field)).toEqual(['ipv6.hopLimit', 'ethernet.fcs']);
    expect(p6.get('ipv6.hopLimit')).toBe(63);
    expect(p6.get('udp.checksumValid')).toBe(true);
  });

  it('mutate ipv6.src re-encodes the UDP checksum over the IPv6 pseudo-header', () => {
    const p = createPduFactory().build(udp6(hex('0a0b')), meta());
    p.mutate(mctx(), 'ipv6.src', '2001:db8:ffff::7', 'NatTranslate');
    expect(p.provenance.map((m) => m.field)).toEqual(['ipv6.src', 'udp.checksum', 'ethernet.fcs']);
    expect(p.get('udp.checksumValid')).toBe(true);
  });

  it('a mutate of the outer IPv4 never touches a UDP header quoted in an ICMP error', () => {
    const f = createPduFactory();
    const probe = f.build(udp4(new Uint8Array(4), 49152, 33434), meta());
    const ip = probe.layer('ipv4')!;
    const err = f.build([
      { proto: 'ethernet', fields: { dst: MAC1, src: MAC2, type: ETHERTYPE_IPV4 } },
      { proto: 'ipv4', fields: { src: SRV, dst: PC, protocol: IPPROTO_ICMP, ttl: 255 } },
      { proto: 'icmpv4', fields: { type: ICMP_DEST_UNREACHABLE, code: ICMP_UNREACH_PORT } },
      { proto: 'payload', fields: { data: probe.bytes.slice(ip.offset, ip.offset + 28) } },
    ], meta());
    const quotedBefore = layerBytes(err.bytes, err.layerAt(4)!);
    err.mutate(mctx(), 'ipv4.src', '10.1.1.1', 'NatTranslate');
    expect(err.provenance.map((m) => m.field)).toEqual(['ipv4.src', 'ipv4.checksum', 'ethernet.fcs']);
    expect(layerBytes(err.bytes, err.layerAt(4)!)).toEqual(quotedBefore);
  });
});

describe('derived maps and field names follow contracts/fields.ts', () => {
  it('udp/tcp derived and decode-only names exist in PROTO_FIELDS', () => {
    for (const codec of [udpCodec, tcpCodec]) {
      const table = PROTO_FIELDS[codec.proto]!;
      for (const name of Object.keys(codec.derived ?? {})) {
        expect(table.fields.find((x) => x.name === name)?.derived, `${codec.proto}.${name}`).toBe(true);
      }
    }
    const tcpNames = new Set(PROTO_FIELDS.tcp!.fields.map((x) => x.name));
    const d = decodeLayers(encodeLayers([
      { proto: 'ipv4', fields: { src: PC, dst: SRV, protocol: IPPROTO_TCP } },
      { proto: 'tcp', fields: { srcPort: 1, dstPort: 2, mss: 1, windowScale: 1, sackPermitted: true, sackBlocks: '1-2', timestamp: 1, timestampEcho: 2 } },
    ]), 'ipv4')[1]!;
    for (const k of Object.keys(d.fields)) expect(tcpNames.has(k), k).toBe(true);
    expect(udpCodec.outerInputs).toEqual(['ipv4.src', 'ipv4.dst', 'ipv6.src', 'ipv6.dst']);
    expect(tcpCodec.outerInputs).toEqual(['ipv4.src', 'ipv4.dst', 'ipv6.src', 'ipv6.dst']);
  });
});

describe('decodeStandalone', () => {
  it('matches the PduView summary/topProto for a full frame with the native FCS', () => {
    const p = createPduFactory().build(udp4(new Uint8Array(3), 49152, 9999), meta());
    const d = decodeStandalone(p.bytes, 'ethernet');
    expect(d.layers).toEqual(p.layers);
    expect(d.summary).toBe(p.summary());
    expect(d.topProto).toBe(p.topProto());
  });

  it('fcsLen 0 on ethernet: no FCS invented, padding still reported, inner layers identical', () => {
    const p = createPduFactory().build(udp4(hex('0102')), meta());
    const noFcs = p.bytes.slice(0, p.size - 4);
    const d = decodeStandalone(noFcs, 'ethernet', { fcsLen: 0 });
    const eth = d.layers[0]!;
    expect(eth.fields.fcs).toBeUndefined();
    expect(eth.fields.fcsValid).toBeUndefined();
    expect(eth.fields.padding).toBe(60 - 14 - 20 - 10);
    expect(eth.trailerLength).toBe(60 - 14 - 20 - 10);
    expect(eth.length).toBe(60);
    expect(eth.error).toBeUndefined();
    expect(d.layers.slice(1)).toEqual(p.layers.slice(1));
    expect(d.topProto).toBe('udp');
    // without the option the last 4 bytes are taken as a (now wrong) FCS
    expect(decodeStandalone(noFcs, 'ethernet').layers[0]!.fields.fcsValid).toBe(false);
    expect(decodeStandalone(p.bytes, 'ethernet', { fcsLen: 4 }).layers[0]!.fields.fcsValid).toBe(true);
  });

  it('fcsLen 0 on hdlc (c_hdlc) and dot11 (ieee802_11) records', () => {
    const f = createPduFactory();
    const serial = f.build([
      { proto: 'hdlc', fields: { protocol: HDLC_PROTO_IPV4 } },
      { proto: 'ipv4', fields: { src: '10.0.0.1', dst: '10.0.0.2', protocol: IPPROTO_UDP } },
      { proto: 'udp', fields: { srcPort: 5, dstPort: 6 } },
    ], meta());
    const h = decodeStandalone(serial.bytes.slice(0, serial.size - 2), 'hdlc', { fcsLen: 0 });
    expect(protos(h.layers)).toEqual(['hdlc', 'ipv4', 'udp']);
    expect(h.layers[0]!.fields.fcs).toBeUndefined();
    expect(h.layers[0]!.trailerLength).toBeUndefined();
    expect(h.layers[2]!.fields.checksumValid).toBe(true);

    const air = f.build([
      { proto: 'dot11', fields: { frameType: 'data', subtype: 'data', toDs: true, addr1: MAC2, addr2: MAC1, addr3: MAC2 } },
      { proto: 'llc', fields: { type: ETHERTYPE_IPV4 } },
      { proto: 'ipv4', fields: { src: '10.0.0.1', dst: '10.0.0.2', protocol: IPPROTO_UDP } },
      { proto: 'udp', fields: { srcPort: 5, dstPort: 6 } },
    ], meta());
    const w = decodeStandalone(air.bytes.slice(0, air.size - 4), 'dot11', { fcsLen: 0 });
    expect(protos(w.layers)).toEqual(['dot11', 'llc', 'ipv4', 'udp']);
    expect(w.layers[0]!.fields.fcsValid).toBeUndefined();
    expect(w.layers.slice(1)).toEqual(air.layers.slice(1));
  });

  it('raw link type: an IPv4 packet decodes from ipv4 and has no FCS handling', () => {
    const bytes = encodeLayers(udp4(hex('01')).slice(1));
    const d = decodeStandalone(bytes, 'ipv4', { fcsLen: 0 });
    expect(protos(d.layers)).toEqual(['ipv4', 'udp', 'payload']);
    expect(d.summary).toBe(`UDP ${PC}:49152 > ${SRV}:7 len=1`);
  });

  it('never throws on arbitrary bytes for any outer protocol (deterministic fuzz)', () => {
    let x = 0x2545f491;
    const next = (): number => {
      x ^= x << 13;
      x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      return x;
    };
    const outers = [...CODECS.keys()];
    for (let round = 0; round < 400; round++) {
      const len = next() % 200;
      const b = new Uint8Array(len);
      for (let i = 0; i < len; i++) b[i] = next() & 0xff;
      // bias some rounds towards plausible headers
      if (len > 1 && round % 3 === 0) b[0] = 0x45;
      if (len > 1 && round % 3 === 1) b[0] = 0x60;
      for (const outer of outers) {
        for (const fcsLen of [undefined, 0] as const) {
          const d = decodeStandalone(b, outer, fcsLen === undefined ? undefined : { fcsLen });
          expect(typeof d.summary).toBe('string');
          expect(decodeChain(b, outer).layers.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('keeps the ethernet FCS convention: crc32 still covers the frame', () => {
    const bytes = encodeLayers(udp4(hex('01')));
    const fcs = crc32(bytes, 0, bytes.length - 4);
    expect(decodeStandalone(bytes, 'ethernet').layers[0]!.fields.fcs).toBe(fcs);
  });
});
