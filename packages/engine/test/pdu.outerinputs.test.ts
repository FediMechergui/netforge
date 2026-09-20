/**
 * P1 W1 pdu: `Pdu.mutate` honours `Codec.outerInputs` (contracts/pdu.ts re-encode contract).
 *
 * A self-contained RFC 768 UDP codec is registered under `udp` for the duration of this file, so the test
 * checks the re-encode rule in pdu/pdu.ts independently of the real transport codecs. Checksums are
 * verified against an independent pseudo-header computation built byte by byte (RFC 768: src, dst, zero,
 * protocol 17, UDP length).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ETHERTYPE_IPV4, ICMP_TIME_EXCEEDED, IPPROTO_ICMP, IPPROTO_UDP } from '../src/contracts/pdu.js';
import type { Codec, CodecContext, FieldValue, LayerSpec, MutationCtx, Pdu, PduMeta } from '../src/contracts/pdu.js';
import { CODECS } from '../src/pdu/codecs/registry.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { crc32, finishChecksum, internetChecksum, onesSum, pseudoHeaderSumV4, readU16, writeU16 } from '../src/pdu/checksum.js';
import { ipv4ToU32 } from '../src/contracts/addr.js';

const MAC1 = '00:1f:00:00:00:01';
const MACR = '00:1f:00:00:00:0a';

const meta = (): PduMeta => ({ born: 1000, origin: 'd_pc1' });
const mctx = (): MutationCtx => ({ now: 2000, device: 'd_r1' });

/** Source address each `encode` call saw in its context (proves the context carries the new value). */
const seenSrc: string[] = [];

/** Nearest enclosing ipv4 layer's fields from a codec context. */
function nearestIpv4(ctx: CodecContext | undefined): Readonly<Record<string, FieldValue>> {
  const outer = ctx?.outer ?? [];
  for (let i = outer.length - 1; i >= 0; i--) if (outer[i]!.proto === 'ipv4') return outer[i]!.fields;
  throw new Error('test udp codec needs an enclosing ipv4 layer');
}

/** Minimal RFC 768 UDP codec whose checksum depends on the enclosing IPv4 src/dst. */
const testUdp: Codec = {
  proto: 'udp',
  defaults: { srcPort: 0, dstPort: 0 },
  derived: { length: 'Other', checksum: 'ChecksumRecompute' },
  outerInputs: ['ipv4.src', 'ipv4.dst'],
  decode(bytes, offset, length, ctx) {
    const avail = Math.min(length, bytes.length - offset);
    const declared = readU16(bytes, offset + 4);
    const len = Math.max(8, Math.min(declared, avail));
    const ip = nearestIpv4(ctx);
    const sum = onesSum(bytes, offset, len, pseudoHeaderSumV4(String(ip.src), String(ip.dst), IPPROTO_UDP, declared));
    return {
      fields: {
        srcPort: readU16(bytes, offset),
        dstPort: readU16(bytes, offset + 2),
        length: declared,
        checksum: readU16(bytes, offset + 6),
        checksumValid: declared === len ? finishChecksum(sum) === 0 : null,
      },
      fieldRanges: { srcPort: [offset, 2], dstPort: [offset + 2, 2], length: [offset + 4, 2], checksum: [offset + 6, 2] },
      headerLength: 8,
      length: len,
      ...(len > 8 ? { next: { proto: 'payload', offset: offset + 8, length: len - 8 } } : {}),
    };
  },
  encode(fields, payload, ctx) {
    const ip = nearestIpv4(ctx);
    seenSrc.push(String(ip.src));
    const len = 8 + payload.length;
    const out = new Uint8Array(len);
    writeU16(out, 0, Number(fields.srcPort));
    writeU16(out, 2, Number(fields.dstPort));
    writeU16(out, 4, len);
    out.set(payload, 8);
    let c = finishChecksum(onesSum(out, 0, len, pseudoHeaderSumV4(String(ip.src), String(ip.dst), IPPROTO_UDP, len)));
    if (c === 0) c = 0xffff;
    writeU16(out, 6, c);
    return out;
  },
  summarize(fields) {
    return `UDP ${String(fields.srcPort)} > ${String(fields.dstPort)}`;
  },
};

let previous: Codec | undefined;
beforeAll(() => {
  previous = CODECS.get('udp');
  CODECS.set('udp', testUdp);
});
afterAll(() => {
  if (previous) CODECS.set('udp', previous);
  else CODECS.delete('udp');
});

/** Independent RFC 768 checksum: pseudo-header bytes written out, then the UDP bytes with checksum zeroed. */
function rfc768(src: string, dst: string, udp: Uint8Array): number {
  const buf = new Uint8Array(12 + udp.length);
  const s = ipv4ToU32(src);
  const d = ipv4ToU32(dst);
  buf[0] = s >>> 24; buf[1] = (s >>> 16) & 0xff; buf[2] = (s >>> 8) & 0xff; buf[3] = s & 0xff;
  buf[4] = d >>> 24; buf[5] = (d >>> 16) & 0xff; buf[6] = (d >>> 8) & 0xff; buf[7] = d & 0xff;
  buf[8] = 0;
  buf[9] = IPPROTO_UDP;
  writeU16(buf, 10, udp.length);
  buf.set(udp, 12);
  buf[12 + 6] = 0;
  buf[12 + 7] = 0;
  const c = internetChecksum(buf);
  return c === 0 ? 0xffff : c;
}

const udpFrame = (): LayerSpec[] => [
  { proto: 'ethernet', fields: { dst: MACR, src: MAC1, type: ETHERTYPE_IPV4 } },
  { proto: 'ipv4', fields: { src: '192.168.1.10', dst: '203.0.113.5', protocol: IPPROTO_UDP, ttl: 64 } },
  { proto: 'udp', fields: { srcPort: 49152, dstPort: 7 } },
  { proto: 'payload', fields: { data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) } },
];

/** Bytes of the first layer named `proto`. */
function layerBytes(p: Pdu, proto: string): Uint8Array {
  const l = p.layer(proto)!;
  return p.bytes.slice(l.offset, l.offset + l.length);
}

describe('pdu/pdu mutate — outerInputs (pseudo-header) re-encode', () => {
  it('builds a UDP frame whose checksum matches an independent RFC 768 computation', () => {
    const p = createPduFactory().build(udpFrame(), meta());
    expect(p.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'udp', 'payload']);
    expect(p.get('udp.checksum')).toBe(rfc768('192.168.1.10', '203.0.113.5', layerBytes(p, 'udp')));
    expect(p.get('udp.checksumValid')).toBe(true);
  });

  it('NAT-style mutate of ipv4.src records src, udp.checksum, ipv4.checksum, ethernet.fcs in that order', () => {
    const p = createPduFactory().build(udpFrame(), meta());
    const oldUdp = p.get('udp.checksum');
    const oldIp = p.get('ipv4.checksum');
    const oldFcs = p.get('ethernet.fcs');
    const size = p.size;
    seenSrc.length = 0;
    p.mutate(mctx(), 'ipv4.src', '198.51.100.7', 'NatTranslate', 'ip nat inside source static');

    expect(p.size).toBe(size);
    expect(p.get('ipv4.src')).toBe('198.51.100.7');
    expect(p.get('udp.checksumValid')).toBe(true);
    expect(p.get('ipv4.checksumValid')).toBe(true);
    expect(p.get('ethernet.fcsValid')).toBe(true);
    expect(p.get('udp.checksum')).toBe(rfc768('198.51.100.7', '203.0.113.5', layerBytes(p, 'udp')));
    // The inner codec was re-encoded with a context that already carried the new source.
    expect(seenSrc).toEqual(['198.51.100.7']);

    expect(p.provenance.map((m) => [m.reason, m.field])).toEqual([
      ['NatTranslate', 'ipv4.src'],
      ['ChecksumRecompute', 'udp.checksum'],
      ['ChecksumRecompute', 'ipv4.checksum'],
      ['FcsRecompute', 'ethernet.fcs'],
    ]);
    const [primary, udpCk, ipCk, fcs] = p.provenance;
    expect(primary).toMatchObject({ before: '192.168.1.10', after: '198.51.100.7', cause: 'ip nat inside source static' });
    expect(udpCk).toMatchObject({ before: oldUdp, after: p.get('udp.checksum'), cause: 'ip nat inside source static' });
    expect(ipCk).toMatchObject({ before: oldIp, after: p.get('ipv4.checksum') });
    expect(fcs).toMatchObject({ before: oldFcs, after: p.get('ethernet.fcs') });
    const b = p.bytes;
    expect(crc32(b, 0, b.length - 4)).toBe(p.get('ethernet.fcs'));
  });

  it('mutate of ipv4.dst also re-encodes the transport checksum (bare IPv4 packet, no link layer)', () => {
    const p = createPduFactory().build(udpFrame().slice(1), meta());
    expect(p.layers.map((l) => l.proto)).toEqual(['ipv4', 'udp', 'payload']);
    p.mutate(mctx(), 'ipv4.dst', '10.9.8.7', 'NatTranslate');
    expect(p.get('udp.checksum')).toBe(rfc768('192.168.1.10', '10.9.8.7', layerBytes(p, 'udp')));
    expect(p.provenance.map((m) => m.field)).toEqual(['ipv4.dst', 'udp.checksum', 'ipv4.checksum']);
  });

  it('ttl is not a pseudo-header input: mutate(ipv4.ttl) records exactly ttl + ipv4.checksum + ethernet.fcs', () => {
    const p = createPduFactory().build(udpFrame(), meta());
    const udpBefore = layerBytes(p, 'udp');
    seenSrc.length = 0;
    p.mutate(mctx(), 'ipv4.ttl', 63, 'TtlDecrement');
    expect(p.provenance.map((m) => [m.reason, m.field])).toEqual([
      ['TtlDecrement', 'ipv4.ttl'],
      ['ChecksumRecompute', 'ipv4.checksum'],
      ['FcsRecompute', 'ethernet.fcs'],
    ]);
    expect(seenSrc).toEqual([]);
    expect(layerBytes(p, 'udp')).toEqual(udpBefore);
  });

  it('MAC rewrites never touch the transport layer', () => {
    const p = createPduFactory().build(udpFrame(), meta());
    seenSrc.length = 0;
    p.mutate(mctx(), 'ethernet.src', MACR, 'MacRewrite');
    expect(p.provenance.map((m) => m.field)).toEqual(['ethernet.src', 'ethernet.fcs']);
    expect(seenSrc).toEqual([]);
  });

  it('a mutate of the transport layer itself keeps the pseudo-header from the enclosing IPv4', () => {
    const p = createPduFactory().build(udpFrame(), meta());
    p.mutate(mctx(), 'udp.srcPort', 40000, 'NatTranslate');
    expect(p.get('udp.checksum')).toBe(rfc768('192.168.1.10', '203.0.113.5', layerBytes(p, 'udp')));
    expect(p.provenance.map((m) => m.field)).toEqual(['udp.srcPort', 'udp.checksum', 'ethernet.fcs']);
  });

  it('a transport header quoted in an ICMP error depends on the quoted IPv4, not on the outer one', () => {
    const f = createPduFactory();
    const original = f.build(udpFrame().slice(1), meta());
    const quote = original.bytes.slice(0, 28);
    const err = f.build(
      [
        { proto: 'ethernet', fields: { dst: MAC1, src: MACR, type: ETHERTYPE_IPV4 } },
        { proto: 'ipv4', fields: { src: '10.0.0.254', dst: '192.168.1.10', protocol: IPPROTO_ICMP, ttl: 255 } },
        { proto: 'icmpv4', fields: { type: ICMP_TIME_EXCEEDED, code: 0 } },
        { proto: 'payload', fields: { data: quote } },
      ],
      meta(),
    );
    expect(err.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'ipv4', 'udp']);
    const quotedUdp = err.layerAt(4)!;
    const quotedBefore = err.bytes.slice(quotedUdp.offset, quotedUdp.offset + quotedUdp.length);
    seenSrc.length = 0;
    err.mutate(mctx(), 'ipv4.dst', '172.16.0.9', 'NatTranslate');
    expect(seenSrc).toEqual([]);
    expect(err.provenance.map((m) => m.field)).toEqual(['ipv4.dst', 'ipv4.checksum', 'ethernet.fcs']);
    const after = err.layerAt(4)!;
    expect(err.bytes.slice(after.offset, after.offset + after.length)).toEqual(quotedBefore);
  });
});
