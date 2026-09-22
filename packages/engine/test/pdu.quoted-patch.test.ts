/**
 * Indexed field paths and quoted-layer patching [SHOULD S9] (ARCHITECTURE-P2 §2.3, §3.9 step 5; §7 W1 pdu [S9]).
 *
 * NAT translates the packet an ICMP error quotes. The quote is the IP header plus 8 bytes, so it can never be
 * re-encoded: it is patched in place, its checksums are fixed incrementally, and the enclosing layers re-encode as
 * usual. Every case below checks the quote's length, the bytes that must not move, and every checksum — the quoted
 * ones against an independently built datagram carrying the translated values.
 */
import { describe, expect, it } from 'vitest';
import {
  ETHERTYPE_IPV4,
  ETHERTYPE_IPV6,
  ICMP_DEST_UNREACHABLE,
  ICMP_ECHO_REQUEST,
  ICMP_QUOTE_PAYLOAD_BYTES,
  ICMP_TIME_EXCEEDED,
  ICMP_UNREACH_PORT,
  ICMPV6_TIME_EXCEEDED,
  IPPROTO_ICMP,
  IPPROTO_ICMPV6,
  IPPROTO_TCP,
  IPPROTO_UDP,
  TRACEROUTE_BASE_PORT,
} from '../src/contracts/pdu.js';
import type { LayerSpec, MutationCtx, Pdu, PduMeta } from '../src/contracts/pdu.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { encodeLayers } from '../src/pdu/codecs/registry.js';
import { internetChecksum } from '../src/pdu/checksum.js';

const meta = (): PduMeta => ({ born: 0, origin: 'd_r1' });
const at = (): MutationCtx => ({ now: 7000, device: 'd_r1' });
const RULE = 'ip nat inside source list 1 interface GigabitEthernet0/1 overload';

const PC_MAC = '02:b3:b2:b1:b0:01';
const R1_MAC = '02:b3:b2:b1:b0:0a';
const INSIDE_LOCAL = '192.168.1.10';
const INSIDE_GLOBAL = '203.0.113.1';
const OUTSIDE = '203.0.113.10';
const HOP = '198.51.100.9';

const fields = (p: Pdu, i: number): Record<string, unknown> => ({ ...p.layerAt(i)!.fields });
const reasons = (p: Pdu): string[] => p.provenance.map((m) => `${m.reason}:${m.field}`);
const layerBytes = (p: Pdu, i: number): number[] => {
  const l = p.layerAt(i)!;
  return Array.from(p.bytes.slice(l.offset, l.offset + l.length));
};

/** The original datagram a NAT'd host sent, as the outside world saw it. */
const udpProbe = (src: string, srcPort: number): LayerSpec[] => [
  { proto: 'ipv4', fields: { src, dst: OUTSIDE, protocol: IPPROTO_UDP, ttl: 1, id: 7 } },
  { proto: 'udp', fields: { srcPort, dstPort: TRACEROUTE_BASE_PORT } },
  { proto: 'payload', fields: { data: new Uint8Array(12).fill(0xa5) } },
];

const icmpProbe = (src: string, id: number): LayerSpec[] => [
  { proto: 'ipv4', fields: { src, dst: OUTSIDE, protocol: IPPROTO_ICMP, ttl: 1, id: 7 } },
  { proto: 'icmpv4', fields: { type: ICMP_ECHO_REQUEST, code: 0, id, seq: 3 } },
  { proto: 'payload', fields: { data: new Uint8Array(32).fill(0x5a) } },
];

const tcpProbe = (src: string, srcPort: number): LayerSpec[] => [
  { proto: 'ipv4', fields: { src, dst: OUTSIDE, protocol: IPPROTO_TCP, ttl: 1, id: 7 } },
  { proto: 'tcp', fields: { srcPort, dstPort: 80, seq: 1, ack: 0, flags: 'S', window: 8192 } },
];

/** An ICMP error from `from` quoting the first 28 bytes of `original` (IP header + 8), as icmpv4.ts builds it. */
function errorQuoting(original: LayerSpec[], type = ICMP_TIME_EXCEEDED, code = 0): Pdu {
  const packet = encodeLayers(original);
  const quote = packet.slice(0, 20 + ICMP_QUOTE_PAYLOAD_BYTES);
  return createPduFactory().build([
    { proto: 'ethernet', fields: { dst: R1_MAC, src: PC_MAC, type: ETHERTYPE_IPV4 } },
    { proto: 'ipv4', fields: { src: HOP, dst: INSIDE_GLOBAL, protocol: IPPROTO_ICMP, ttl: 255 } },
    { proto: 'icmpv4', fields: { type, code, unused: 0 } },
    { proto: 'payload', fields: { data: quote } },
  ], meta());
}

/** The checksum a fresh datagram of `specs` carries in its layer `i` (an independent expectation). */
function checksumOf(specs: LayerSpec[], i: number): unknown {
  const p = createPduFactory().build(specs, meta());
  return p.layerAt(i)!.fields.checksum;
}

describe('indexed field paths', () => {
  it('address the layer at the index, and the plain form keeps meaning the first layer', () => {
    const p = errorQuoting(udpProbe(INSIDE_GLOBAL, 1024));
    expect(p.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'ipv4', 'udp']);
    expect(p.get('ipv4.src')).toBe(HOP);
    expect(p.get('ipv4[1].src')).toBe(HOP);
    expect(p.get('ipv4[3].src')).toBe(INSIDE_GLOBAL);
    expect(p.get('udp[4].srcPort')).toBe(1024);
    expect(p.get('ipv4[2].src')).toBeUndefined(); // layer 2 is the icmpv4 error
    expect(p.get('ipv4[9].src')).toBeUndefined();
    expect(() => p.mutate(at(), 'ipv4[2].src', '1.2.3.4', 'NatTranslate')).toThrow(/no ipv4 layer at index 2/);
    expect(() => p.mutate(at(), 'udp[9].srcPort', 1, 'NatTranslate')).toThrow(/no udp layer at index 9/);
    expect(p.provenance).toEqual([]);
  });

  it('record a non-quoted indexed mutation under its canonical (plain) path', () => {
    const p = errorQuoting(udpProbe(INSIDE_GLOBAL, 1024));
    p.mutate(at(), 'ipv4[1].ttl', 254, 'TtlDecrement', 'route');
    expect(reasons(p)).toEqual(['TtlDecrement:ipv4.ttl', 'ChecksumRecompute:ipv4.checksum', 'FcsRecompute:ethernet.fcs']);
    expect(p.get('ipv4.checksumValid')).toBe(true);
  });
});

describe('quoted UDP probe (traceroute through PAT, inbound)', () => {
  it('patches the quoted address and port in place, with every checksum valid', () => {
    const p = errorQuoting(udpProbe(INSIDE_GLOBAL, 1024));
    const size = p.size;
    const quotedBefore = layerBytes(p, 3);
    const udpBefore = fields(p, 4);

    p.mutate(at(), 'ipv4[3].src', INSIDE_LOCAL, 'NatTranslate', RULE);
    p.mutate(at(), 'udp[4].srcPort', 49152, 'NatTranslate', RULE);

    expect(p.size).toBe(size);
    expect(p.layerAt(3)!.length).toBe(quotedBefore.length); // the quote keeps its length
    expect(p.get('ipv4[3].src')).toBe(INSIDE_LOCAL);
    expect(p.get('ipv4[3].dst')).toBe(OUTSIDE);
    expect(p.get('ipv4[3].ttl')).toBe(1);
    expect(p.get('ipv4[3].id')).toBe(7);
    expect(p.get('udp[4].srcPort')).toBe(49152);
    expect(p.get('udp[4].dstPort')).toBe(TRACEROUTE_BASE_PORT);
    expect(p.get('udp[4].length')).toBe(udpBefore.length);

    // the quoted ipv4 header checksum is recomputed over its own header
    const quoted = p.layerAt(3)!;
    expect(internetChecksum(p.bytes, quoted.offset, quoted.headerLength)).toBe(0);
    expect(p.get('ipv4[3].checksumValid')).toBe(true);
    // the quoted udp checksum is the one the translated datagram would carry
    expect(p.get('udp[4].checksum')).toBe(checksumOf(udpProbe(INSIDE_LOCAL, 49152), 1));
    // and the enclosing layers re-encoded as usual
    expect(p.get('icmpv4.checksumValid')).toBe(true);
    expect(p.get('ipv4.checksumValid')).toBe(true);
    expect(p.get('ethernet.fcsValid')).toBe(true);
  });

  it('records the primary mutation, then the quoted checksums innermost first, then the enclosing ones', () => {
    const p = errorQuoting(udpProbe(INSIDE_GLOBAL, 1024));
    p.mutate(at(), 'ipv4[3].src', INSIDE_LOCAL, 'NatTranslate', RULE);
    expect(reasons(p)).toEqual([
      'NatTranslate:ipv4[3].src',
      'ChecksumRecompute:udp[4].checksum',
      'ChecksumRecompute:ipv4[3].checksum',
      'ChecksumRecompute:icmpv4.checksum',
      'FcsRecompute:ethernet.fcs',
    ]);
    expect(p.provenance[0]).toEqual({ at: 7000, device: 'd_r1', reason: 'NatTranslate', field: 'ipv4[3].src', before: INSIDE_GLOBAL, after: INSIDE_LOCAL, cause: RULE });

    // A port change compensated by exactly one quoted checksum leaves the enclosing ICMP checksum where it was
    // (one's-complement arithmetic), so no record is written for it — but the frame's FCS still changes.
    const q = errorQuoting(udpProbe(INSIDE_GLOBAL, 1024));
    const icmpBefore = q.get('icmpv4.checksum');
    q.mutate(at(), 'udp[4].srcPort', 49152, 'NatTranslate', RULE);
    expect(reasons(q)).toEqual([
      'NatTranslate:udp[4].srcPort',
      'ChecksumRecompute:udp[4].checksum',
      'FcsRecompute:ethernet.fcs',
    ]);
    expect(q.get('icmpv4.checksum')).toBe(icmpBefore);
    expect(q.get('icmpv4.checksumValid')).toBe(true);
  });

  it('translates the outbound direction (an error from an inside host about an inbound flow)', () => {
    const p = errorQuoting(udpProbe(INSIDE_GLOBAL, 1024), ICMP_DEST_UNREACHABLE, ICMP_UNREACH_PORT);
    p.mutate(at(), 'ipv4[3].dst', INSIDE_GLOBAL, 'NatTranslate', RULE);
    p.mutate(at(), 'udp[4].dstPort', 40000, 'NatTranslate', RULE);
    expect(p.get('ipv4[3].dst')).toBe(INSIDE_GLOBAL);
    expect(p.get('udp[4].dstPort')).toBe(40000);
    const quoted = p.layerAt(3)!;
    expect(internetChecksum(p.bytes, quoted.offset, quoted.headerLength)).toBe(0);
    const expected = udpProbe(INSIDE_GLOBAL, 1024);
    expected[0]!.fields.dst = INSIDE_GLOBAL;
    expected[1]!.fields.dstPort = 40000;
    expect(p.get('udp[4].checksum')).toBe(checksumOf(expected, 1));
    expect(p.get('icmpv4.checksumValid')).toBe(true);
  });

  it('leaves a quoted udp checksum of 0 (IPv4: none) at 0', () => {
    const packet = encodeLayers(udpProbe(INSIDE_GLOBAL, 1024));
    packet[20 + 6] = 0;
    packet[20 + 7] = 0;
    const p = createPduFactory().build([
      { proto: 'ethernet', fields: { dst: R1_MAC, src: PC_MAC, type: ETHERTYPE_IPV4 } },
      { proto: 'ipv4', fields: { src: HOP, dst: INSIDE_GLOBAL, protocol: IPPROTO_ICMP, ttl: 255 } },
      { proto: 'icmpv4', fields: { type: ICMP_TIME_EXCEEDED, code: 0, unused: 0 } },
      { proto: 'payload', fields: { data: packet.slice(0, 28) } },
    ], meta());
    expect(p.get('udp[4].checksum')).toBe(0);
    p.mutate(at(), 'udp[4].srcPort', 49152, 'NatTranslate', RULE);
    expect(p.get('udp[4].checksum')).toBe(0);
    expect(reasons(p)).toEqual(['NatTranslate:udp[4].srcPort', 'ChecksumRecompute:icmpv4.checksum', 'FcsRecompute:ethernet.fcs']);
  });
});

describe('quoted ICMP echo and quoted TCP', () => {
  it('adjusts the quoted ICMP checksum when the quoted id moves', () => {
    const p = errorQuoting(icmpProbe(INSIDE_GLOBAL, 2));
    expect(p.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'ipv4', 'icmpv4', 'payload']);
    p.mutate(at(), 'icmpv4[4].id', 1, 'NatTranslate', RULE);
    expect(p.get('icmpv4[4].id')).toBe(1);
    expect(p.get('icmpv4[4].seq')).toBe(3);
    // the quoted checksum is the one the whole translated echo request carried
    expect(p.get('icmpv4[4].checksum')).toBe(checksumOf(icmpProbe(INSIDE_GLOBAL, 1), 1));
    expect(reasons(p)).toEqual([
      'NatTranslate:icmpv4[4].id',
      'ChecksumRecompute:icmpv4[4].checksum',
      'FcsRecompute:ethernet.fcs', // the quoted checksum compensates the id, so the enclosing one does not move
    ]);
    expect(p.get('icmpv4.checksumValid')).toBe(true);
    expect(p.get('ethernet.fcsValid')).toBe(true);
  });

  it('never touches a quoted tcp checksum (it is outside the 8-byte quote)', () => {
    const p = errorQuoting(tcpProbe(INSIDE_GLOBAL, 1024));
    expect(p.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'ipv4', 'tcp']);
    expect(p.layerAt(4)!.fields.checksum).toBeUndefined(); // only ports and sequence are quoted
    const quotedTcpBefore = layerBytes(p, 4);
    p.mutate(at(), 'ipv4[3].src', INSIDE_LOCAL, 'NatTranslate', RULE);
    expect(reasons(p)).toEqual([
      'NatTranslate:ipv4[3].src',
      'ChecksumRecompute:ipv4[3].checksum', // no quoted udp checksum to fix, so nothing else moves
      'FcsRecompute:ethernet.fcs',
    ]);
    expect(layerBytes(p, 4)).toEqual(quotedTcpBefore);

    p.mutate(at(), 'tcp[4].srcPort', 49152, 'NatTranslate', RULE);
    expect(p.get('tcp[4].srcPort')).toBe(49152);
    expect(p.get('tcp[4].seq')).toBe(1);
    expect(reasons(p).slice(3)).toEqual([
      'NatTranslate:tcp[4].srcPort',
      'ChecksumRecompute:icmpv4.checksum',
      'FcsRecompute:ethernet.fcs',
    ]);
    expect(p.get('icmpv4.checksumValid')).toBe(true);
  });
});

describe('quoted layers reached by the plain path, and refusals', () => {
  it('patches the first layer of a proto when that layer is the quoted one', () => {
    const p = errorQuoting(udpProbe(INSIDE_GLOBAL, 1024));
    p.mutate(at(), 'udp.srcPort', 49152, 'NatTranslate', RULE); // the only udp layer is inside the quote
    expect(p.get('udp[4].srcPort')).toBe(49152);
    expect(reasons(p)).toEqual(['NatTranslate:udp[4].srcPort', 'ChecksumRecompute:udp[4].checksum', 'FcsRecompute:ethernet.fcs']);
  });

  it('refuses a field that shares its bytes, or one the quote does not carry, and changes nothing', () => {
    const p = errorQuoting(udpProbe(INSIDE_GLOBAL, 1024));
    const before = Array.from(p.bytes);
    expect(() => p.mutate(at(), 'ipv4[3].dscp', 8, 'Other')).toThrow(/shares its bytes/);
    expect(() => p.mutate(at(), 'ipv4[3].nonsense', 8, 'Other')).toThrow(/carries no nonsense/);
    expect(() => p.mutate(at(), 'ipv4[3].src', '10.0.0.999', 'NatTranslate')).toThrow(/IPv4 address/);
    expect(Array.from(p.bytes)).toEqual(before);
    expect(p.provenance).toEqual([]);
  });
});

describe('an ICMPv6 error quote', () => {
  it('patches the quoted IPv6 address and fixes the quoted udp checksum (pseudo-header)', () => {
    const inner: LayerSpec[] = [
      { proto: 'ipv6', fields: { src: '2001:db8:1::10', dst: '2001:db8:2::20', nextHeader: IPPROTO_UDP, hopLimit: 1 } },
      { proto: 'udp', fields: { srcPort: 1024, dstPort: TRACEROUTE_BASE_PORT } },
      { proto: 'payload', fields: { data: new Uint8Array(8).fill(0xa5) } },
    ];
    const packet = encodeLayers(inner);
    const p = createPduFactory().build([
      { proto: 'ethernet', fields: { dst: R1_MAC, src: PC_MAC, type: ETHERTYPE_IPV6 } },
      { proto: 'ipv6', fields: { src: '2001:db8:9::1', dst: '2001:db8:1::10', nextHeader: IPPROTO_ICMPV6, hopLimit: 64 } },
      { proto: 'icmpv6', fields: { type: ICMPV6_TIME_EXCEEDED, code: 0 } },
      { proto: 'payload', fields: { data: packet } },
    ], meta());
    expect(p.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv6', 'icmpv6', 'ipv6', 'udp', 'payload']);

    p.mutate(at(), 'ipv6[3].src', '2001:db8:1::99', 'NatTranslate', RULE);
    expect(p.get('ipv6[3].src')).toBe('2001:db8:1::99');
    const translated = inner.slice();
    translated[0] = { proto: 'ipv6', fields: { ...inner[0]!.fields, src: '2001:db8:1::99' } };
    expect(p.get('udp[4].checksum')).toBe(checksumOf(translated, 1));
    expect(reasons(p)).toEqual([
      'NatTranslate:ipv6[3].src',
      'ChecksumRecompute:udp[4].checksum',
      'FcsRecompute:ethernet.fcs',
    ]);
    expect(p.get('icmpv6.checksumValid')).toBe(true);
  });
});
