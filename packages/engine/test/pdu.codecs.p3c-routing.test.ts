/**
 * P3c routing codecs (ARCHITECTURE-P3C §7 W1a pdu, §2.3, §3.1–§3.3): the OSPFv2 summary bodies (types 3 and 4) [S4],
 * OSPFv2 authentication types 1 and 2 with the RFC 2328 D.4.3 keyed-MD5 trailer [S5], the new `ospf6` / `ospf6-lsa`
 * codecs (RFC 5340 Appendix A) [S6], and the IPv6 next-header 89 dispatch (the `ipv6.nh` space; IPv4 protocol 89 stays
 * `ospf`).
 *
 * Every golden below was assembled independently of the engine (a separate script packing the RFC layouts with the
 * RFC 1071 internet checksum over the IPv6 pseudo-header, the RFC 905 Annex B Fletcher check octets and a stock MD5);
 * the keyed-MD5 vector is also recomputed here with node's own MD5.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { IPPROTO_OSPF, OSPF6_ALL_ROUTERS, OSPF_ALL_ROUTERS } from '../src/contracts/pdu.js';
import type { LayerSpec, LayerView, PduMeta } from '../src/contracts/pdu.js';
import { DISPATCH_TABLE, PROTO_FIELDS } from '../src/contracts/fields.js';
import { CODECS, decodeLayers, encodeLayers } from '../src/pdu/codecs/registry.js';
import { IPV6_NH_SPACE, keyForProto, lookupNext, nextIpv6Proto } from '../src/pdu/codecs/dispatch.js';
import { OSPF_AUTH, OSPF_LSA_KIND, OSPF_PACKET, ospfCodec, ospfLsaCodec, ospfMd5Digest } from '../src/pdu/codecs/ospf.js';
import { OSPF6_LSA_KIND, OSPF6_PACKET, ospf6Codec, ospf6LsaCodec, ospf6LsaText } from '../src/pdu/codecs/ospf6.js';
import { createPduFactory } from '../src/pdu/factory.js';

const hex = (s: string): number[] => (s.replace(/\s+/g, '').match(/.{2}/g) ?? []).map((h) => parseInt(h, 16));
const bytesOf = (s: string): Uint8Array => Uint8Array.from(hex(s));
const protos = (layers: readonly LayerView[]): string[] => layers.map((l) => l.proto);
const layerBytes = (b: Uint8Array, l: LayerView, len = l.length): number[] => Array.from(b.slice(l.offset, l.offset + len));
const meta = (): PduMeta => ({ born: 0, origin: 'd_r2' });

// ── [S4] summary LSAs (§3.1: the ABR R2 2.2.2.2 into area 1) ──────────────────────────────────────────────────────

/** Type 3: 10.0.23.0/30 metric 1 (Fletcher check octets a6 8f). */
const SUMMARY3 = '0001 02 03 0a001700 02020202 80000001 a68f 001c' + ' fffffffc 00 000001';
/** Type 4: ASBR 3.3.3.3 metric 1, mask 0.0.0.0 (Fletcher check octets a0 a6). */
const SUMMARY4 = '0001 02 04 03030303 02020202 80000001 a0a6 001c' + ' 00000000 00 000001';
const LSU_SUMMARIES = '02 04 0054 02020202 00000001 7f19 0000 0000000000000000 00000002 ' + SUMMARY3 + SUMMARY4;

const summarySpec = (lsType: number, lsid: string, extra: Record<string, string | number>): LayerSpec => ({
  proto: 'ospf-lsa',
  fields: { age: 1, lsType, lsid, advRouter: '2.2.2.2', seq: 0x80000001, ...extra },
});

describe('[S4] OSPFv2 summary LSAs (types 3 and 4)', () => {
  it('encodes and decodes mask(4) 0(1) metric(3) bodies in an update, with their Fletcher checksums', () => {
    const b = encodeLayers([
      { proto: 'ospf', fields: { type: OSPF_PACKET.lsu, routerId: '2.2.2.2', area: '0.0.0.1' } },
      summarySpec(OSPF_LSA_KIND.summary, '10.0.23.0', { mask: '255.255.255.252', metric: 1 }),
      summarySpec(OSPF_LSA_KIND.asbrSummary, '3.3.3.3', { metric: 1 }), // a type 4's mask defaults to 0.0.0.0
    ]);
    expect(Array.from(b)).toEqual(hex(LSU_SUMMARIES));
    const layers = decodeLayers(b, 'ospf');
    expect(protos(layers)).toEqual(['ospf', 'ospf-lsa', 'ospf-lsa']);
    expect(layers[0]!.fields).toMatchObject({ count: 2, length: 84, checksumValid: true });
    expect(layers[1]!.fields).toEqual({
      age: 1, options: 2, lsType: 3, lsid: '10.0.23.0', advRouter: '2.2.2.2', seq: 0x80000001, checksum: 0xa68f, length: 28,
      headerOnly: false, checksumValid: true, mask: '255.255.255.252', metric: 1,
    });
    expect(layers[2]!.fields).toEqual({
      age: 1, options: 2, lsType: 4, lsid: '3.3.3.3', advRouter: '2.2.2.2', seq: 0x80000001, checksum: 0xa0a6, length: 28,
      headerOnly: false, checksumValid: true, mask: '0.0.0.0', metric: 1,
    });
    expect(layerBytes(b, layers[1]!, layers[1]!.headerLength)).toEqual(hex(SUMMARY3));
    expect(layerBytes(b, layers[2]!, layers[2]!.headerLength)).toEqual(hex(SUMMARY4));
    expect(layers.every((l) => l.error === undefined)).toBe(true);
    expect(ospfLsaCodec.summarize(layers[2]!.fields)).toBe('ASBR summary LSA 3.3.3.3 from 2.2.2.2 seq 0x80000001 age 1');
  });

  it('uses the full 24-bit metric, requires a type 3 mask, and reports a short body', () => {
    const big = ospfLsaCodec.encode({ lsType: 3, lsid: '10.3.0.0', advRouter: '2.2.2.2', mask: '255.255.255.0', metric: 0xfffffe }, new Uint8Array(0));
    expect(ospfLsaCodec.decode(big, 0, big.length).fields).toMatchObject({ metric: 0xfffffe, checksumValid: true });
    expect(() => ospfLsaCodec.encode({ lsType: 3, lsid: '10.3.0.0', advRouter: '2.2.2.2', metric: 1 }, new Uint8Array(0))).toThrow(/ospf-lsa.mask is required/);
    expect(() => ospfLsaCodec.encode({ lsType: 4, lsid: '3.3.3.3', advRouter: '2.2.2.2', metric: 0x1000000 }, new Uint8Array(0))).toThrow(/metric out of range/);
    const short = bytesOf(SUMMARY3).slice(0, 24);
    short[19] = 24; // a declared length of 24: the header and half a body
    expect(ospfLsaCodec.decode(short, 0, 24).error).toBe('summary LSA body truncated');
  });
});

// ── [S5] authentication ───────────────────────────────────────────────────────────────────────────────────────────

const HELLO_SIMPLE = '02 01 002c 01010101 00000001 f99e 0001 6e662d6b65790000' + ' fffffffc 000a 02 01 00000028 00000000 00000000';
const HELLO_MD5_BODY = '02 01 002c 01010101 00000001 0000 0002 0000 07 10 000003e8' + ' fffffffc 000a 02 01 00000028 00000000 00000000';
/** MD5(packet ‖ 'lab-secret' zero-padded to 16 octets), RFC 2328 D.4.3. */
const HELLO_MD5_DIGEST = 'faaf58b5538904f96f6b908c2f17f212';
/** The same packet with a 16-octet key, which takes no padding. */
const DIGEST_KEY16 = '36c452c3105846bd10ae654461c8de85';

const authHello = (over: Record<string, string | number | Uint8Array>): LayerSpec => ({
  proto: 'ospf',
  fields: { type: OSPF_PACKET.hello, routerId: '1.1.1.1', area: '0.0.0.1', mask: '255.255.255.252', ...over },
});

describe('[S5] OSPFv2 authentication', () => {
  it('auType 1 carries the key in clear in the header; the checksum still skips the authentication field', () => {
    const b = encodeLayers([authHello({ auType: OSPF_AUTH.simple, authKey: 'nf-key' })]);
    expect(Array.from(b)).toEqual(hex(HELLO_SIMPLE));
    const l = decodeLayers(b, 'ospf')[0]!;
    expect(l.fields).toMatchObject({ auType: 1, authKey: 'nf-key', checksum: 0xf99e, checksumValid: true });
    expect(l.fieldRanges.authKey).toEqual([16, 8]);
    expect(l.fields.keyId).toBeUndefined();
    // the key travels in clear (the teaching point): its bytes are in the packet
    expect(Buffer.from(b).includes(Buffer.from('nf-key'))).toBe(true);
    const eight = encodeLayers([authHello({ auType: 1, authKey: 'abcdefgh' })]);
    expect(decodeLayers(eight, 'ospf')[0]!.fields.authKey).toBe('abcdefgh');
    expect(() => encodeLayers([authHello({ auType: 1, authKey: 'abcdefghi' })])).toThrow(/at most 8 bytes/);
  });

  it('the RFC 2328 D.4.3 keyed-MD5 digest: MD5 over the packet with checksum 0, then the key padded to 16 octets', () => {
    const unsigned = encodeLayers([authHello({ auType: OSPF_AUTH.md5, keyId: 7, cryptoSeq: 1000 })]);
    // the length excludes the 16-octet trailer, which is zeros until the digest is supplied
    expect(Array.from(unsigned)).toEqual([...hex(HELLO_MD5_BODY), ...new Array<number>(16).fill(0)]);
    const digest = ospfMd5Digest(unsigned, 'lab-secret');
    expect(Array.from(digest)).toEqual(hex(HELLO_MD5_DIGEST));
    // an independent MD5 of the same octets
    const padded = Buffer.concat([Buffer.from(hex(HELLO_MD5_BODY)), Buffer.from('lab-secret'), Buffer.alloc(6)]);
    expect(createHash('md5').update(padded).digest('hex')).toBe(HELLO_MD5_DIGEST);
    expect(Array.from(ospfMd5Digest(unsigned.slice(0, 44), '0123456789abcdef'))).toEqual(hex(DIGEST_KEY16));
    expect(Array.from(ospfMd5Digest(unsigned, new TextEncoder().encode('lab-secret')))).toEqual(hex(HELLO_MD5_DIGEST));
    expect(() => ospfMd5Digest(unsigned, '0123456789abcdefg')).toThrow(/at most 16 bytes/);
    expect(() => ospfMd5Digest(unsigned.slice(0, 30), 'k')).toThrow(/does not fit/);

    const signed = encodeLayers([authHello({ auType: 2, keyId: 7, cryptoSeq: 1000, digest })]);
    expect(Array.from(signed)).toEqual([...hex(HELLO_MD5_BODY), ...hex(HELLO_MD5_DIGEST)]);
    // re-signing a signed packet ignores the trailer already present
    expect(Array.from(ospfMd5Digest(signed, 'lab-secret'))).toEqual(hex(HELLO_MD5_DIGEST));
    // no key byte is in the packet
    expect(Buffer.from(signed).includes(Buffer.from('lab-secret'))).toBe(false);
  });

  it('decodes keyId, cryptoSeq and the digest trailer (the layer covers it as its trailer); the checksum is not computed', () => {
    const b = bytesOf(HELLO_MD5_BODY + HELLO_MD5_DIGEST);
    const l = decodeLayers(b, 'ospf')[0]!;
    expect(l.fields).toEqual({
      version: 2, type: 1, length: 44, routerId: '1.1.1.1', area: '0.0.0.1', checksum: 0, auType: 2, keyId: 7, cryptoSeq: 1000,
      digest: bytesOf(HELLO_MD5_DIGEST), mask: '255.255.255.252', helloInterval: 10, options: 2, priority: 1, deadInterval: 40,
      dr: '0.0.0.0', bdr: '0.0.0.0', neighbors: '',
    });
    expect(l.length).toBe(60);
    expect(l.trailerLength).toBe(16);
    expect(l.fieldRanges.digest).toEqual([44, 16]);
    expect(l.error).toBeUndefined();
    // a missing trailer is an error; the rest still decodes
    const cut = decodeLayers(bytesOf(HELLO_MD5_BODY), 'ospf')[0]!;
    expect(cut.error).toBe('OSPF keyed MD5 digest missing or truncated');
    expect(cut.fields).toMatchObject({ keyId: 7, cryptoSeq: 1000, mask: '255.255.255.252' });
    expect(cut.fields.digest).toBeUndefined();
    expect(() => encodeLayers([authHello({ auType: 2, cryptoSeq: 1 })])).toThrow(/ospf.keyId is required/);
    expect(() => encodeLayers([authHello({ auType: 2, keyId: 1, digest: new Uint8Array(15) })])).toThrow(/16 bytes/);
  });

  it('inside IPv4 the trailer is part of the datagram; an update keeps its LSAs bounded by the OSPF length', () => {
    const lsu = (digest?: Uint8Array): LayerSpec[] => [
      { proto: 'ipv4', fields: { src: '10.0.12.2', dst: OSPF_ALL_ROUTERS, ttl: 1, dscp: 48 } },
      { proto: 'ospf', fields: { type: OSPF_PACKET.lsu, routerId: '2.2.2.2', area: '0.0.0.1', auType: 2, keyId: 1, cryptoSeq: 5, ...(digest ? { digest } : {}) } },
      summarySpec(3, '10.0.23.0', { mask: '255.255.255.252', metric: 1 }),
    ];
    const unsigned = encodeLayers(lsu());
    const digest = ospfMd5Digest(unsigned.slice(20), 'k1');
    const b = encodeLayers(lsu(digest));
    const layers = decodeLayers(b, 'ipv4');
    expect(protos(layers)).toEqual(['ipv4', 'ospf', 'ospf-lsa']);
    expect(layers[0]!.fields).toMatchObject({ protocol: IPPROTO_OSPF, totalLength: 20 + 56 + 16 });
    expect(layers[1]!.fields).toMatchObject({ length: 56, count: 1, digest });
    expect(layers[1]!.trailerLength).toBe(16);
    expect(layers[2]!.length).toBe(28);
    expect(layers[2]!.fields).toMatchObject({ lsType: 3, metric: 1, checksumValid: true });
    // a mutate of the LSA re-encodes the packet around it and keeps the old digest, which no longer matches
    const pdu = createPduFactory().build(lsu(digest), meta());
    pdu.mutate({ now: 1, device: 'd_r1' }, 'ospf-lsa.metric', 9, 'Other', 'tampered');
    const after = pdu.layerAt(1)!;
    expect(after.fields.digest).toEqual(digest);
    expect(Array.from(ospfMd5Digest(pdu.bytes.slice(20), 'k1'))).not.toEqual(Array.from(digest));
    expect(pdu.layerAt(2)!.fields).toMatchObject({ metric: 9, checksumValid: true });
  });

  it('auType 0 decodes exactly as before: no authentication field is added', () => {
    const b = encodeLayers([authHello({})]);
    const f = decodeLayers(b, 'ospf')[0]!.fields;
    for (const k of ['authKey', 'keyId', 'cryptoSeq', 'digest']) expect(f[k], k).toBeUndefined();
    expect(f).toMatchObject({ auType: 0, checksumValid: true });
    expect(ospfCodec.summarize(f)).toBe('OSPF hello from 1.1.1.1 area 0.0.0.1, DR 0.0.0.0, BDR 0.0.0.0');
  });
});

// ── [S6] OSPFv3 ───────────────────────────────────────────────────────────────────────────────────────────────────

/** R1's hello on Gi0/0 (interface id 3) from fe80::1 to ff02::5, neighbour 2.2.2.2 (pseudo-header checksum f7 7d). */
const HELLO6 = '03 01 0028 01010101 00000000 f77d 00 00' + ' 00000003 01 000013 000a 0028 00000000 00000000 02020202';
const IPV6_HELLO6 = '6e000000 0028 59 01 fe800000000000000000000000000001 ff020000000000000000000000000005' + HELLO6;
const ROUTER6 = '0001 2001 00000000 01010101 80000001 58b4 0028' + ' 00 000013' + ' 01 00 0001 00000003 00000004 02020202';
const NETWORK6 = '0001 2002 00000005 02020202 80000001 9c6b 0020' + ' 00 000013 02020202 03030303';
const IAP6 = '0001 2003 00000001 02020202 80000001 a061 0024' + ' 00 000002 40 00 0000 20010db800030000';
const IAR6 = '0001 2004 03030303 02020202 80000001 ed18 0020' + ' 00 000013 00 000001 03030303';
const EXT6 = '0001 4005 00000001 03030303 80000001 8740 0038' + ' 07 000014 30 00 0000 20010db80099 0000' +
  ' 20010db8002300000000000000000009 0000004d';
const LINK6 = '0001 0008 00000003 01010101 80000001 6ef9 0038' + ' 01 000013 fe800000000000000000000000000001 00000001' +
  ' 40 00 0000 20010db800120000';
const INTRA6 = '0001 2009 00000000 01010101 80000001 820c 0038' + ' 0002 2001 00000000 01010101' +
  ' 40 00 0001 20010db800120000' + ' 40 00 0001 20010db800010000';
const LSU6 = '03 04 00ac 01010101 00000000 7b39 00 00 00000003 ' + ROUTER6 + LINK6 + INTRA6;
const DBD6 = '03 02 0030 01010101 00000000 e9ac 00 00' + ' 00 000013 05dc 00 07 00001234' + ' 0001 2001 00000000 01010101 80000001 58b4 0028';
const LSR6 = '03 03 0028 02020202 00000000 d6b5 00 00' + ' 0000 2001 00000000 01010101' + ' 0000 0008 00000003 01010101';

const ip6 = (src = 'fe80::1', dst: string = OSPF6_ALL_ROUTERS): LayerSpec => ({ proto: 'ipv6', fields: { src, dst, hopLimit: 1, trafficClass: 0xe0 } });
const hello6 = (over: Record<string, string | number> = {}): LayerSpec => ({
  proto: 'ospf6',
  fields: { type: OSPF6_PACKET.hello, routerId: '1.1.1.1', areaId: '0.0.0.0', interfaceId: 3, neighbors: '2.2.2.2', ...over },
});
const lsa6 = (lsType: number, lsId: string, advRouter: string, extra: Record<string, string | number | boolean>): LayerSpec => ({
  proto: 'ospf6-lsa',
  fields: { age: 1, lsType, lsId, advRouter, seq: 0x80000001, ...extra },
});
const routerLsa6 = (): LayerSpec => lsa6(OSPF6_LSA_KIND.router, '0.0.0.0', '1.1.1.1', { flags: 0, links: 'p2p,1,3,4,2.2.2.2' });
const linkLsa6 = (): LayerSpec => lsa6(OSPF6_LSA_KIND.link, '0.0.0.3', '1.1.1.1', { priority: 1, linkLocal: 'fe80::1', prefixes: '2001:db8:12::/64' });
const intraLsa6 = (): LayerSpec => lsa6(OSPF6_LSA_KIND.intraAreaPrefix, '0.0.0.0', '1.1.1.1', {
  refType: OSPF6_LSA_KIND.router, refLsId: '0.0.0.0', refAdvRouter: '1.1.1.1', prefixes: '2001:db8:12::/64,1;2001:db8:1::/64,1',
});

describe('[S6] OSPFv3 codec (RFC 5340 bytes) and IPv6 next header 89', () => {
  it('dispatches IPv6 next header 89 to ospf6 and IPv4 protocol 89 still to ospf; the builder fills the next header', () => {
    expect(IPV6_NH_SPACE).toBe('ipv6.nh');
    expect(nextIpv6Proto(89)).toBe('ospf6');
    expect(nextIpv6Proto(58)).toBe('icmpv6'); // every other key falls through to the shared ipproto space
    expect(nextIpv6Proto(253)).toBe('payload');
    expect(lookupNext('ipproto', 89)).toBe('ospf');
    expect(keyForProto('ipv6.nh', 'ospf6')).toBe(89);
    expect(DISPATCH_TABLE.filter((e) => e.since === 'P3c').map((e) => `${e.space} ${e.key} ${e.proto}`)).toEqual(['ipv6.nh 89 ospf6', 'udp.port 162 snmp']); // W1b adds the trap port
    const b = encodeLayers([ip6(), hello6()]); // ipv6.nextHeader omitted: filled from 'ospf6'
    expect(Array.from(b)).toEqual(hex(IPV6_HELLO6));
    const layers = decodeLayers(b, 'ipv6');
    expect(protos(layers)).toEqual(['ipv6', 'ospf6']);
    expect(layers[0]!.fields).toMatchObject({ nextHeader: 89, hopLimit: 1, dst: 'ff02::5' });
    // through an extension header too
    const ext = encodeLayers([ip6(), { proto: 'ipv6-hopopts', fields: {} }, hello6()]);
    expect(protos(decodeLayers(ext, 'ipv6'))).toEqual(['ipv6', 'ipv6-hopopts', 'ospf6']);
    // and an IPv4 datagram with protocol 89 is OSPFv2
    const v4 = encodeLayers([{ proto: 'ipv4', fields: { src: '10.0.12.1', dst: OSPF_ALL_ROUTERS } }, authHello({})]);
    expect(protos(decodeLayers(v4, 'ipv4'))).toEqual(['ipv4', 'ospf']);
  });

  it('encodes the hello with the pseudo-header checksum and decodes every header and hello field', () => {
    const b = encodeLayers([ip6(), hello6()]);
    const l = decodeLayers(b, 'ipv6')[1]!;
    expect(layerBytes(b, l)).toEqual(hex(HELLO6));
    expect(l.fields).toEqual({
      version: 3, type: 1, length: 40, routerId: '1.1.1.1', areaId: '0.0.0.0', checksum: 0xf77d, checksumValid: true, instanceId: 0,
      interfaceId: 3, priority: 1, options: 0x13, helloInterval: 10, deadInterval: 40, dr: '0.0.0.0', bdr: '0.0.0.0', neighbors: '2.2.2.2',
    });
    expect(l.error).toBeUndefined();
    const pdu = createPduFactory().decode(b, meta(), 'ipv6');
    expect(pdu.topProto()).toBe('ospf6');
    expect(pdu.summary()).toBe('OSPFv3 hello from 1.1.1.1 area 0.0.0.0, DR 0.0.0.0, BDR 0.0.0.0');
    // standalone: no pseudo-header, so the checksum is neither written nor checked
    const bare = encodeLayers([hello6()]);
    expect(Array.from(bare.slice(12, 14))).toEqual([0, 0]);
    expect(decodeLayers(bare, 'ospf6')[0]!.fields.checksumValid).toBeUndefined();
    // a changed source address re-encodes the checksum (outerInputs)
    expect(ospf6Codec.outerInputs).toEqual(['ipv6.src', 'ipv6.dst']);
    const moved = createPduFactory().build([ip6(), hello6()], meta());
    moved.mutate({ now: 1, device: 'd_r1' }, 'ipv6.src', 'fe80::2', 'Other');
    expect(moved.layerAt(1)!.fields).toMatchObject({ checksumValid: true });
    expect(moved.layerAt(1)!.fields.checksum).not.toBe(0xf77d);
    // a corrupted byte fails the checksum
    const bad = b.slice();
    bad[60] = bad[60]! ^ 0x01;
    expect(decodeLayers(bad, 'ipv6')[1]!.fields.checksumValid).toBe(false);
    expect(() => encodeLayers([ip6(), hello6({ interfaceId: -1 })])).toThrow(/interfaceId out of range/);
    expect(() => encodeLayers([ip6(), { proto: 'ospf6', fields: { type: 1, routerId: '1.1.1.1', areaId: '0.0.0.0' } }])).toThrow(/ospf6.interfaceId is required/);
  });

  it('carries the router, link and intra-area-prefix LSAs of §3.3 step 4 in one update', () => {
    const b = encodeLayers([ip6(), { proto: 'ospf6', fields: { type: OSPF6_PACKET.lsu, routerId: '1.1.1.1', areaId: '0.0.0.0' } }, routerLsa6(), linkLsa6(), intraLsa6()]);
    const layers = decodeLayers(b, 'ipv6');
    expect(protos(layers)).toEqual(['ipv6', 'ospf6', 'ospf6-lsa', 'ospf6-lsa', 'ospf6-lsa']);
    const [, pkt, r, k, i] = layers;
    expect(layerBytes(b, pkt!)).toEqual(hex(LSU6));
    expect(pkt!.fields).toMatchObject({ count: 3, length: 172, checksum: 0x7b39, checksumValid: true });
    expect(layerBytes(b, r!, r!.headerLength)).toEqual(hex(ROUTER6));
    expect(layerBytes(b, k!, k!.headerLength)).toEqual(hex(LINK6));
    expect(layerBytes(b, i!, i!.headerLength)).toEqual(hex(INTRA6));
    expect(r!.length).toBe(40 + 56 + 56);
    expect(r!.fields).toEqual({
      age: 1, lsType: 0x2001, lsId: '0.0.0.0', advRouter: '1.1.1.1', seq: 0x80000001, checksum: 0x58b4, length: 40, headerOnly: false,
      checksumValid: true, flags: 0, options: 0x13, links: 'p2p,1,3,4,2.2.2.2',
    });
    expect(k!.fields).toMatchObject({ lsType: 8, priority: 1, options: 0x13, linkLocal: 'fe80::1', prefixes: '2001:db8:12::/64', checksumValid: true });
    expect(i!.fields).toMatchObject({
      lsType: 0x2009, refType: 0x2001, refLsId: '0.0.0.0', refAdvRouter: '1.1.1.1', prefixes: '2001:db8:12::/64,1;2001:db8:1::/64,1', checksumValid: true,
    });
    expect(layers.every((l) => l.error === undefined)).toBe(true);
    expect(createPduFactory().decode(b, meta(), 'ipv6').summary()).toBe('OSPFv3 link-state update from 1.1.1.1 area 0.0.0.0, 3 LSAs');
    expect(ospf6LsaCodec.summarize(i!.fields)).toBe('intra-area-prefix LSA 0.0.0.0 from 1.1.1.1 seq 0x80000001 age 1');
  });

  it('encodes the network, inter-area-prefix, inter-area-router and AS-external bodies byte for byte', () => {
    const cases: [LayerSpec, string, Record<string, unknown>][] = [
      [lsa6(OSPF6_LSA_KIND.network, '0.0.0.5', '2.2.2.2', { attached: '2.2.2.2,3.3.3.3' }), NETWORK6, { options: 0x13, attached: '2.2.2.2,3.3.3.3' }],
      [lsa6(OSPF6_LSA_KIND.interAreaPrefix, '0.0.0.1', '2.2.2.2', { metric: 2, prefixes: '2001:db8:3::/64' }), IAP6, { metric: 2, prefixes: '2001:db8:3::/64' }],
      [lsa6(OSPF6_LSA_KIND.interAreaRouter, '3.3.3.3', '2.2.2.2', { metric: 1, destRouterId: '3.3.3.3' }), IAR6, { options: 0x13, metric: 1, destRouterId: '3.3.3.3' }],
      [
        lsa6(OSPF6_LSA_KIND.external, '0.0.0.1', '3.3.3.3', { e2: true, metric: 20, prefixes: '2001:db8:99::/48', forward: '2001:db8:23::9', tag: 77 }),
        EXT6,
        { e2: true, metric: 20, refType: 0, prefixes: '2001:db8:99::/48', forward: '2001:db8:23::9', tag: 77 },
      ],
    ];
    for (const [spec, golden, want] of cases) {
      const b = ospf6LsaCodec.encode({ ...spec.fields }, new Uint8Array(0));
      expect(Array.from(b), golden).toEqual(hex(golden));
      const d = ospf6LsaCodec.decode(b, 0, b.length);
      expect(d.fields).toMatchObject({ ...want, checksumValid: true, headerOnly: false });
      expect(d.error).toBeUndefined();
    }
    // host bits after the prefix length are written as zero
    const iap = ospf6LsaCodec.encode({ age: 1, lsType: 0x2003, lsId: '0.0.0.1', advRouter: '2.2.2.2', metric: 2, prefixes: '2001:db8:3::ffff/64' }, new Uint8Array(0));
    expect(Array.from(iap)).toEqual(hex(IAP6));
    // an E1 external without forward or tag, referencing nothing
    const e1 = ospf6LsaCodec.encode({ lsType: 0x4005, lsId: '0.0.0.2', advRouter: '3.3.3.3', e2: false, metric: 5, prefixes: '::/0' }, new Uint8Array(0));
    expect(e1.length).toBe(28);
    expect(ospf6LsaCodec.decode(e1, 0, e1.length).fields).toMatchObject({ e2: false, metric: 5, prefixes: '::/0', checksumValid: true });
    expect(ospf6LsaCodec.decode(e1, 0, e1.length).fields.forward).toBeUndefined();
  });

  it('a database description carries LSA header copies; a request lists <type>:<lsId>:<adv> entries', () => {
    const dbd = encodeLayers([
      ip6(),
      { proto: 'ospf6', fields: { type: OSPF6_PACKET.dbd, routerId: '1.1.1.1', areaId: '0.0.0.0', mtu: 1500, flags: 7, ddSeq: 0x1234 } },
      { proto: 'ospf6-lsa', fields: { age: 1, lsType: 0x2001, lsId: '0.0.0.0', advRouter: '1.1.1.1', seq: 0x80000001, checksum: 0x58b4, length: 40 } },
    ]);
    const layers = decodeLayers(dbd, 'ipv6');
    expect(protos(layers)).toEqual(['ipv6', 'ospf6', 'ospf6-lsa']);
    expect(layerBytes(dbd, layers[1]!)).toEqual(hex(DBD6));
    expect(layers[1]!.fields).toMatchObject({ options: 0x13, mtu: 1500, flags: 7, ddSeq: 0x1234, checksumValid: true });
    expect(layers[2]!.fields).toEqual({
      age: 1, lsType: 0x2001, lsId: '0.0.0.0', advRouter: '1.1.1.1', seq: 0x80000001, checksum: 0x58b4, length: 40, headerOnly: true,
    });
    expect(createPduFactory().decode(dbd, meta(), 'ipv6').summary()).toBe('OSPFv3 database description from 1.1.1.1 area 0.0.0.0, seq 4660, flags I M MS');
    expect(() => encodeLayers([
      { proto: 'ospf6', fields: { type: OSPF6_PACKET.lsack, routerId: '1.1.1.1', areaId: '0.0.0.0' } },
      { proto: 'ospf6-lsa', fields: { lsType: 0x2001, lsId: '0.0.0.0', advRouter: '1.1.1.1', length: 40 } },
    ])).toThrow(/ospf6-lsa.checksum is required/);

    const lsr = encodeLayers([ip6(), { proto: 'ospf6', fields: { type: OSPF6_PACKET.lsr, routerId: '2.2.2.2', areaId: '0.0.0.0', requests: '8193:0.0.0.0:1.1.1.1;8:0.0.0.3:1.1.1.1' } }]);
    const req = decodeLayers(lsr, 'ipv6')[1]!;
    expect(layerBytes(lsr, req)).toEqual(hex(LSR6));
    expect(req.fields).toMatchObject({ requests: '8193:0.0.0.0:1.1.1.1;8:0.0.0.3:1.1.1.1', checksumValid: true });
    expect(() => encodeLayers([{ proto: 'ospf6', fields: { type: 3, routerId: '1.1.1.1', areaId: '0.0.0.0', requests: '70000:0.0.0.0:1.1.1.1' } }])).toThrow(/requests entry/);
  });

  it('refuses malformed values and reports damaged packets without throwing', () => {
    const enc = (f: Record<string, string | number>): Uint8Array => ospf6LsaCodec.encode({ age: 1, seq: 1, lsId: '0.0.0.0', advRouter: '1.1.1.1', ...f }, new Uint8Array(0));
    expect(() => enc({ lsType: 0x2001, links: 'stub,1,1,1,1.1.1.1' })).toThrow(/links entry/);
    expect(() => enc({ lsType: 0x2009, refType: 0x2001, refLsId: '0.0.0.0', refAdvRouter: '1.1.1.1', prefixes: '2001:db8::/64' })).toThrow(/prefixes entry/);
    expect(() => enc({ lsType: 0x0008, linkLocal: 'fe80::1', prefixes: '2001:db8::/129' })).toThrow(/prefixes entry/);
    expect(() => enc({ lsType: 0x2003, metric: 1, prefixes: '2001:db8::/64;2001:db8:1::/64' })).toThrow(/exactly one prefix/);
    expect(() => enc({ lsType: 0x2005, metric: 1 })).toThrow(/no body encoder/);
    expect(ospf6LsaText(0x2005)).toBe('type 0x2005');
    const t = decodeLayers(bytesOf(HELLO6).slice(0, 10), 'ospf6')[0]!;
    expect(t.error).toBe('OSPFv3 header truncated');
    const short = bytesOf(HELLO6).slice(0, 30);
    const s = decodeLayers(short, 'ospf6')[0]!;
    expect(s.error).toBe('OSPFv3 hello truncated');
    const lsa = bytesOf(INTRA6);
    lsa[21] = 9; // claims nine prefixes
    expect(ospf6LsaCodec.decode(lsa, 0, lsa.length).error).toBe('OSPFv3 prefix runs past the LSA');
  });

  it('declares the ospf6 and ospf6-lsa tables at P3c, and every decoded field is a name of its table', () => {
    expect(Object.values(PROTO_FIELDS).filter((t) => t.since === 'P3c').map((t) => t.proto)).toEqual(['ospf6', 'ospf6-lsa', 'tftp', 'snmp']); // W1b appends tftp and snmp
    expect([...CODECS.keys()].slice(-4)).toEqual(['ospf6', 'ospf6-lsa', 'tftp', 'snmp']);
    const frames: [Uint8Array, string][] = [
      [bytesOf(IPV6_HELLO6), 'ipv6'], [bytesOf(LSU6), 'ospf6'], [bytesOf(DBD6), 'ospf6'], [bytesOf(LSR6), 'ospf6'],
      [bytesOf(LSU_SUMMARIES), 'ospf'], [bytesOf(HELLO_SIMPLE), 'ospf'], [bytesOf(HELLO_MD5_BODY + HELLO_MD5_DIGEST), 'ospf'],
    ];
    for (const lsa of [NETWORK6, IAP6, IAR6, EXT6]) frames.push([bytesOf(lsa), 'ospf6-lsa']);
    for (const [bytes, outer] of frames) {
      for (const layer of decodeLayers(bytes, outer)) {
        const names = new Set(PROTO_FIELDS[layer.proto]!.fields.map((x) => x.name));
        for (const k of Object.keys(layer.fields)) expect(names.has(k), `${layer.proto}.${k}`).toBe(true);
      }
    }
  });
});
