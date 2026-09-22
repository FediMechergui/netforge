import { describe, expect, it } from 'vitest';
import {
  ARP_OP_REPLY,
  ARP_OP_REQUEST,
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  ICMP_DEST_UNREACHABLE,
  ICMP_ECHO_REPLY,
  ICMP_ECHO_REQUEST,
  ICMP_TIME_EXCEEDED,
  ICMP_UNREACH_HOST,
  IPPROTO_ICMP,
} from '../src/contracts/pdu.js';
import type { LayerSpec } from '../src/contracts/pdu.js';
import { CODECS, MAX_LAYERS, decodeLayers, encodeLayers, fillLinkField, getCodec } from '../src/pdu/codecs/registry.js';
import { ethernetCodec, ethertypeForProto, protoForEthertype } from '../src/pdu/codecs/ethernet.js';
import { arpCodec } from '../src/pdu/codecs/arp.js';
import { ipProtocolForProto, ipv4Codec, protoForIpProtocol } from '../src/pdu/codecs/ipv4.js';
import { DISPATCH_TABLE, PROTO_FIELDS } from '../src/contracts/fields.js';
import { keyForProto, linkFieldFor, lookupNext, lookupPortNext, nextProto } from '../src/pdu/codecs/dispatch.js';
import { icmpv4Codec } from '../src/pdu/codecs/icmpv4.js';
import { payloadCodec } from '../src/pdu/codecs/payload.js';
import { crc32 } from '../src/pdu/checksum.js';

const MAC1 = '00:1f:00:00:00:01';
const MAC2 = '00:1f:00:00:00:02';
const BCAST = 'ff:ff:ff:ff:ff:ff';

const hex = (s: string): number[] => (s.replace(/\s+/g, '').match(/.{2}/g) ?? []).map((h) => parseInt(h, 16));

/** Hand-assembled ARP request frame: PC1 (10.0.0.1) asks for 10.0.0.2. FCS computed independently with zlib. */
const ARP_REQUEST_FRAME: number[] = [
  ...hex('ff ff ff ff ff ff'), // dst
  ...hex('00 1f 00 00 00 01'), // src
  ...hex('08 06'), // ethertype ARP
  ...hex('00 01 08 00 06 04 00 01'), // htype ptype hlen plen op=request
  ...hex('00 1f 00 00 00 01'), // sha
  ...hex('0a 00 00 01'), // spa
  ...hex('00 00 00 00 00 00'), // tha
  ...hex('0a 00 00 02'), // tpa
  ...new Array<number>(18).fill(0), // padding to 60 bytes
  ...hex('05 dd dc d2'), // FCS 0xd2dcdd05 little-endian (zlib.crc32 of the first 60 bytes)
];

const arpRequestSpecs = (): LayerSpec[] => [
  { proto: 'ethernet', fields: { dst: BCAST, src: MAC1, type: ETHERTYPE_ARP } },
  { proto: 'arp', fields: { op: ARP_OP_REQUEST, sha: MAC1, spa: '10.0.0.1', tha: '00:00:00:00:00:00', tpa: '10.0.0.2' } },
];

const echoSpecs = (payloadLen = 56, ttl = 128): LayerSpec[] => [
  { proto: 'ethernet', fields: { dst: MAC2, src: MAC1, type: ETHERTYPE_IPV4 } },
  { proto: 'ipv4', fields: { src: '10.0.0.1', dst: '10.0.0.2', protocol: IPPROTO_ICMP, ttl } },
  { proto: 'icmpv4', fields: { type: ICMP_ECHO_REQUEST, code: 0, id: 1, seq: 1 } },
  { proto: 'payload', fields: { data: new Uint8Array(payloadLen).map((_, i) => i & 0xff) } },
];

describe('pdu/codecs registry', () => {
  it('registers the five P0 codecs in insertion order, then the P0.5 link codecs, then the P1 codecs (§9.2), then the P2 codecs (P2 §9 item 4)', () => {
    expect([...CODECS.keys()]).toEqual([
      'ethernet', 'arp', 'ipv4', 'icmpv4', 'payload',
      'hdlc', 'dot11', 'dot11-mgmt', 'llc', 'eapol',
      'ipv6', 'ipv6-hopopts', 'ipv6-route', 'ipv6-frag', 'ipv6-dstopts', 'icmpv6', 'udp', 'tcp', 'dhcp', 'dns', 'http',
      'dot1q', 'stp', 'lacp', 'dtp', 'dhcpv6', 'capwap', 'hsrp', 'pagp',
    ]);
    expect(getCodec('ethernet')).toBe(ethernetCodec);
    expect(getCodec('arp')).toBe(arpCodec);
    expect(getCodec('ipv4')).toBe(ipv4Codec);
    expect(getCodec('icmpv4')).toBe(icmpv4Codec);
    expect(getCodec('payload')).toBe(payloadCodec);
    expect(getCodec('nope')).toBeUndefined();
  });

  it('encodeLayers throws on an empty list and on unknown protocols', () => {
    expect(() => encodeLayers([])).toThrow();
    expect(() => encodeLayers([{ proto: 'mystery', fields: {} }])).toThrow(/mystery/);
  });

  it('decodeLayers of an unknown outer proto yields a single payload layer', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const layers = decodeLayers(bytes, 'mystery');
    expect(layers).toHaveLength(1);
    expect(layers[0]!.proto).toBe('payload');
    expect(layers[0]!.fields.data).toEqual(bytes);
  });
});

describe('pdu/codecs ARP golden frame', () => {
  it('build → bytes match the hand-assembled frame (padding to 64 incl. FCS, correct FCS)', () => {
    const bytes = encodeLayers(arpRequestSpecs());
    expect(bytes.length).toBe(64);
    expect(Array.from(bytes)).toEqual(ARP_REQUEST_FRAME);
    // FCS covers everything before it and is little-endian
    const fcs = crc32(bytes, 0, 60);
    expect(bytes[60]).toBe(fcs & 0xff);
    expect(bytes[63]).toBe(fcs >>> 24);
  });

  it('decode of the golden frame recovers the fields and attributes padding to ethernet', () => {
    const layers = decodeLayers(new Uint8Array(ARP_REQUEST_FRAME));
    expect(layers.map((l) => l.proto)).toEqual(['ethernet', 'arp']);
    const [eth, arp] = layers;
    expect(eth!.fields).toMatchObject({ dst: BCAST, src: MAC1, type: ETHERTYPE_ARP, fcs: 0xd2dcdd05, fcsValid: true, padding: 18 });
    expect(eth!.offset).toBe(0);
    expect(eth!.length).toBe(64);
    expect(eth!.headerLength).toBe(14);
    expect(eth!.trailerLength).toBe(22);
    expect(eth!.error).toBeUndefined();
    expect(arp!.fields).toEqual({
      htype: 1, ptype: 0x0800, hlen: 6, plen: 4, op: ARP_OP_REQUEST,
      sha: MAC1, spa: '10.0.0.1', tha: '00:00:00:00:00:00', tpa: '10.0.0.2',
    });
    expect(arp!.offset).toBe(14);
    expect(arp!.length).toBe(28);
    expect(arp!.headerLength).toBe(28);
    expect(arp!.error).toBeUndefined();
  });

  it('fieldRanges point at the right bytes', () => {
    const [eth, arp] = decodeLayers(new Uint8Array(ARP_REQUEST_FRAME));
    expect(eth!.fieldRanges.dst).toEqual([0, 6]);
    expect(eth!.fieldRanges.src).toEqual([6, 6]);
    expect(eth!.fieldRanges.type).toEqual([12, 2]);
    expect(eth!.fieldRanges.padding).toEqual([42, 18]);
    expect(eth!.fieldRanges.fcs).toEqual([60, 4]);
    expect(arp!.fieldRanges.op).toEqual([20, 2]);
    expect(arp!.fieldRanges.sha).toEqual([22, 6]);
    expect(arp!.fieldRanges.spa).toEqual([28, 4]);
    expect(arp!.fieldRanges.tha).toEqual([32, 6]);
    expect(arp!.fieldRanges.tpa).toEqual([38, 4]);
    const b = new Uint8Array(ARP_REQUEST_FRAME);
    const [o, n] = arp!.fieldRanges.tpa!;
    expect(Array.from(b.subarray(o, o + n))).toEqual([10, 0, 0, 2]);
  });

  it('summaries read as specified', () => {
    const [eth, arp] = decodeLayers(new Uint8Array(ARP_REQUEST_FRAME));
    expect(arpCodec.summarize(arp!.fields)).toBe('ARP request who-has 10.0.0.2 tell 10.0.0.1');
    expect(ethernetCodec.summarize(eth!.fields)).toBe(`Ethernet ${MAC1} > ${BCAST} type=0x0806`);
    expect(arpCodec.summarize({ op: ARP_OP_REPLY, spa: '10.0.0.2', sha: MAC2 })).toBe(`ARP reply 10.0.0.2 is-at ${MAC2}`);
  });

  it('a decoder-only field passed on build (fcs, padding) is ignored and recomputed', () => {
    const specs = arpRequestSpecs();
    specs[0]!.fields.fcs = 1234;
    specs[0]!.fields.padding = 99;
    expect(Array.from(encodeLayers(specs))).toEqual(ARP_REQUEST_FRAME);
  });
});

describe('pdu/codecs IPv4 + ICMP echo round-trip', () => {
  it('build → decode yields [ethernet, ipv4, icmpv4, payload] with valid checksums and exact lengths', () => {
    const bytes = encodeLayers(echoSpecs(56));
    expect(bytes.length).toBe(14 + 20 + 8 + 56 + 4);
    const layers = decodeLayers(bytes);
    expect(layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'payload']);
    const [eth, ip, icmp, pl] = layers;
    expect(eth!.fields.fcsValid).toBe(true);
    expect(eth!.fields.padding).toBe(0);
    expect(eth!.trailerLength).toBe(4);
    expect(ip!.fields).toMatchObject({
      version: 4, ihl: 5, dscp: 0, ecn: 0, totalLength: 84, id: 0, flags: 0, fragOffset: 0,
      ttl: 128, protocol: 1, checksumValid: true, src: '10.0.0.1', dst: '10.0.0.2',
    });
    expect(ip!.offset).toBe(14);
    expect(ip!.length).toBe(84);
    expect(ip!.headerLength).toBe(20);
    expect(icmp!.fields).toMatchObject({ type: ICMP_ECHO_REQUEST, code: 0, id: 1, seq: 1, checksumValid: true });
    expect(icmp!.offset).toBe(34);
    expect(icmp!.length).toBe(64);
    expect(icmp!.headerLength).toBe(8);
    expect(pl!.offset).toBe(42);
    expect(pl!.length).toBe(56);
    expect(pl!.fields.data).toEqual(new Uint8Array(56).map((_, i) => i & 0xff));
    expect(ip!.fieldRanges.ttl).toEqual([22, 1]);
    expect(ip!.fieldRanges.checksum).toEqual([24, 2]);
    expect(ip!.fieldRanges.src).toEqual([26, 4]);
    expect(ip!.fieldRanges.dst).toEqual([30, 4]);
    expect(icmp!.fieldRanges.seq).toEqual([40, 2]);
    expect(pl!.fieldRanges.data).toEqual([42, 56]);
    expect(bytes[22]).toBe(128);
  });

  it('summaries read as specified', () => {
    const [, ip, icmp] = decodeLayers(encodeLayers(echoSpecs()));
    expect(ipv4Codec.summarize(ip!.fields)).toBe('IPv4 10.0.0.1 > 10.0.0.2 proto=1 ttl=128');
    expect(icmpv4Codec.summarize({ ...icmp!.fields, src: '10.0.0.1', dst: '10.0.0.2' })).toBe(
      'ICMP echo request 10.0.0.1 > 10.0.0.2 id=1 seq=1',
    );
    expect(icmpv4Codec.summarize({ type: ICMP_ECHO_REPLY, id: 3, seq: 4 })).toBe('ICMP echo reply id=3 seq=4');
    expect(icmpv4Codec.summarize({ type: ICMP_TIME_EXCEEDED, code: 0 })).toBe('ICMP time exceeded (ttl)');
    expect(icmpv4Codec.summarize({ type: ICMP_DEST_UNREACHABLE, code: ICMP_UNREACH_HOST })).toBe(
      'ICMP destination unreachable (host)',
    );
  });

  it('a tiny echo is padded by ethernet and the padding is not attributed to ipv4/icmp', () => {
    const bytes = encodeLayers(echoSpecs(0));
    expect(bytes.length).toBe(64);
    const [eth, ip, icmp, pl] = decodeLayers(bytes);
    expect(eth!.fields.padding).toBe(60 - 14 - 28);
    expect(eth!.trailerLength).toBe(60 - 14 - 28 + 4);
    expect(ip!.length).toBe(28);
    expect(icmp!.length).toBe(8);
    expect(pl!.length).toBe(0);
  });

  it('a corrupted ipv4 header decodes with checksumValid false and no error', () => {
    const bytes = encodeLayers(echoSpecs());
    bytes[22] = 127; // ttl without checksum update
    const [, ip] = decodeLayers(bytes);
    expect(ip!.fields.checksumValid).toBe(false);
    expect(ip!.error).toBeUndefined();
  });

  it('ipv4 honours ihl on decode (options skipped) and errors only on a truncated header', () => {
    const inner = icmpv4Codec.encode({ type: ICMP_ECHO_REQUEST, id: 1, seq: 1 }, new Uint8Array(4));
    // 24-byte header with 4 bytes of options (NOPs)
    const hdr = new Uint8Array(24 + inner.length);
    hdr[0] = 0x46;
    hdr[2] = hdr.length >>> 8;
    hdr[3] = hdr.length & 0xff;
    hdr[8] = 64;
    hdr[9] = 1;
    hdr.set([10, 0, 0, 1], 12);
    hdr.set([10, 0, 0, 2], 16);
    hdr.set([1, 1, 1, 1], 20);
    hdr.set(inner, 24);
    const d = ipv4Codec.decode(hdr, 0, hdr.length);
    expect(d.error).toBeUndefined();
    expect(d.headerLength).toBe(24);
    expect(d.fields.ihl).toBe(6);
    expect(d.next).toEqual({ proto: 'icmpv4', offset: 24, length: inner.length });
    const truncated = ipv4Codec.decode(hdr, 0, 12);
    expect(truncated.error).toMatch(/truncated/);
  });

  it('build fills ethernet.type / ipv4.protocol from the inner layer when omitted', () => {
    const specs = echoSpecs();
    delete specs[0]!.fields.type;
    delete specs[1]!.fields.protocol;
    const [eth, ip] = decodeLayers(encodeLayers(specs));
    expect(eth!.fields.type).toBe(ETHERTYPE_IPV4);
    expect(ip!.fields.protocol).toBe(IPPROTO_ICMP);
  });

  it('ethernet.type is required when nothing can imply it', () => {
    expect(() => encodeLayers([{ proto: 'ethernet', fields: { dst: MAC2, src: MAC1 } }])).toThrow(/ethernet\.type/);
    expect(() => encodeLayers([{ proto: 'ipv4', fields: { protocol: 1, dst: '10.0.0.2' } }])).toThrow(/ipv4\.src/);
  });
});

describe('pdu/codecs ICMP errors quote the original', () => {
  it('time exceeded quoting a 100-byte echo decodes nested layers with the inner ipv4 clamped', () => {
    // Original: 100-byte IPv4 datagram (20 hdr + 8 icmp + 72 payload).
    const original = encodeLayers(echoSpecs(72).slice(1));
    expect(original.length).toBe(100);
    const quote = original.subarray(0, 20 + 8);
    const bytes = encodeLayers([
      { proto: 'ethernet', fields: { dst: MAC1, src: MAC2, type: ETHERTYPE_IPV4 } },
      { proto: 'ipv4', fields: { src: '10.0.0.254', dst: '10.0.0.1', protocol: IPPROTO_ICMP, ttl: 255 } },
      { proto: 'icmpv4', fields: { type: ICMP_TIME_EXCEEDED, code: 0 } },
      { proto: 'payload', fields: { data: quote } },
    ]);
    const layers = decodeLayers(bytes);
    expect(layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'ipv4', 'icmpv4', 'payload']);
    const [eth, ip, icmp, qip, qicmp, qpl] = layers;
    expect(eth!.fields.fcsValid).toBe(true);
    expect(ip!.fields.checksumValid).toBe(true);
    expect(ip!.fields.totalLength).toBe(20 + 8 + 28);
    expect(icmp!.fields).toMatchObject({ type: ICMP_TIME_EXCEEDED, code: 0, unused: 0, checksumValid: true });
    expect(icmp!.length).toBe(8 + 28);
    // quoted original header: declares 100 bytes but only 28 were quoted → clamped, no error
    expect(qip!.offset).toBe(14 + 20 + 8);
    expect(qip!.fields.totalLength).toBe(100);
    expect(qip!.fields.ttl).toBe(128);
    expect(qip!.fields.src).toBe('10.0.0.1');
    expect(qip!.fields.checksumValid).toBe(true);
    expect(qip!.length).toBe(28);
    expect(qip!.error).toBeUndefined();
    expect(qicmp!.fields).toMatchObject({ type: ICMP_ECHO_REQUEST, id: 1, seq: 1 });
    expect(qicmp!.length).toBe(8);
    expect(qicmp!.error).toBeUndefined();
    expect(qpl!.length).toBe(0);
    expect(eth!.fields.padding).toBe(0);
    expect(bytes.length).toBe(14 + 20 + 8 + 28 + 4);
  });

  it('destination unreachable carries the unused word and chains to ipv4', () => {
    const d = icmpv4Codec.decode(icmpv4Codec.encode({ type: ICMP_DEST_UNREACHABLE, code: ICMP_UNREACH_HOST, unused: 0 }, new Uint8Array(0)), 0, 8);
    expect(d.fields).toMatchObject({ type: 3, code: 1, unused: 0, checksumValid: true });
    expect(d.next).toEqual({ proto: 'ipv4', offset: 8, length: 0 });
  });

  it('a truncated icmp header reports an error but still shows type/code', () => {
    const d = icmpv4Codec.decode(new Uint8Array([11, 0, 0]), 0, 3);
    expect(d.error).toMatch(/truncated/);
    expect(d.fields.type).toBe(11);
    expect(d.fields.code).toBe(0);
    expect(d.next).toBeUndefined();
  });
});

describe('pdu/codecs defaults', () => {
  it('every codec exposes defaults for its builder-visible fields', () => {
    expect(ethernetCodec.defaults).toMatchObject({ dst: BCAST, src: '00:00:00:00:00:00' });
    expect(arpCodec.defaults).toMatchObject({ htype: 1, ptype: 0x0800, hlen: 6, plen: 4, op: ARP_OP_REQUEST });
    expect(ipv4Codec.defaults).toMatchObject({ version: 4, ttl: 128, dscp: 0, ecn: 0, id: 0, flags: 0, fragOffset: 0 });
    expect(icmpv4Codec.defaults).toMatchObject({ type: ICMP_ECHO_REQUEST, code: 0, id: 0, seq: 0, unused: 0 });
    expect(payloadCodec.defaults.data).toEqual(new Uint8Array(0));
    expect(Object.isFrozen(ipv4Codec.defaults)).toBe(true);
  });

  it('payload summarize reports the byte count', () => {
    expect(payloadCodec.summarize({ data: new Uint8Array(7) })).toBe('payload 7 bytes');
  });
});

describe('pdu/codecs dispatch tables (P0.5)', () => {
  it('every non-reserved DISPATCH_TABLE entry round-trips; reserved entries never dispatch', () => {
    const firstByKey = new Map<string, string>();
    const firstByProto = new Map<string, number>();
    for (const e of DISPATCH_TABLE) {
      if (e.reserved) {
        expect(lookupNext(e.space, e.key)).toBeUndefined();
        continue;
      }
      const k = `${e.space}|${e.key}`;
      if (!firstByKey.has(k)) firstByKey.set(k, e.proto);
      const pk = `${e.space}|${e.proto}`;
      if (!firstByProto.has(pk)) firstByProto.set(pk, e.key);
      expect(lookupNext(e.space, e.key)).toBe(firstByKey.get(k));
      expect(keyForProto(e.space, e.proto)).toBe(firstByProto.get(pk));
    }
  });

  it('shared number spaces resolve as the contract lists', () => {
    expect(lookupNext('ethertype', 0x0800)).toBe('ipv4');
    expect(lookupNext('ethertype', 0x0806)).toBe('arp');
    expect(lookupNext('ethertype', 0x888e)).toBe('eapol');
    expect(lookupNext('ethertype', 0x86dd)).toBe('ipv6');
    expect(lookupNext('ipproto', 1)).toBe('icmpv4');
    expect(lookupNext('ipproto', 17)).toBe('udp');
    expect(lookupNext('udp.port', 69)).toBeUndefined(); // reserved tftp
    expect(nextProto('ethertype', 0x88b5)).toBe('payload');
    expect(nextProto('ethertype', 0x88b5, 'raw')).toBe('raw');
    expect(keyForProto('udp.port', 'dhcp')).toBe(67);
    expect(keyForProto('tcp.port', 'http')).toBe(80);
    expect(keyForProto('ethertype', 'payload')).toBeUndefined();
  });

  it('port dispatch prefers the destination port, then the source, and needs a payload', () => {
    expect(lookupPortNext('udp.port', 67, 5000, 10)).toBe('dhcp');
    expect(lookupPortNext('udp.port', 40000, 53, 10)).toBe('dns');
    expect(lookupPortNext('tcp.port', 80, 53, 1)).toBe('http');
    expect(lookupPortNext('tcp.port', 80, 49152, 0)).toBeUndefined();
    expect(lookupPortNext('udp.port', 40000, 40001, 10)).toBeUndefined();
  });

  it('the P0 codec helpers are wrappers over the tables', () => {
    expect(protoForEthertype(0x0800)).toBe('ipv4');
    expect(protoForEthertype(0x0806)).toBe('arp');
    expect(protoForEthertype(0x1234)).toBe('payload');
    expect(ethertypeForProto('arp')).toBe(ETHERTYPE_ARP);
    expect(ethertypeForProto('icmpv4')).toBeUndefined();
    expect(protoForIpProtocol(IPPROTO_ICMP)).toBe('icmpv4');
    expect(protoForIpProtocol(253)).toBe('payload');
    expect(ipProtocolForProto('udp')).toBe(17);
  });

  it('fillLinkField is table-driven for every next-layer selector field', () => {
    expect(linkFieldFor('hdlc')).toEqual({ field: 'protocol', space: 'ethertype' });
    expect(linkFieldFor('arp')).toBeUndefined();
    expect(linkFieldFor('toString')).toBeUndefined();
    expect(fillLinkField('hdlc', { address: 0x0f }, 'ipv6')).toEqual({ address: 0x0f, protocol: 0x86dd });
    expect(fillLinkField('llc', {}, 'eapol')).toEqual({ type: 0x888e });
    expect(fillLinkField('ipv4', { src: '10.0.0.1' }, 'udp')).toEqual({ src: '10.0.0.1', protocol: 17 });
    expect(fillLinkField('ipv6', {}, 'icmpv6')).toEqual({ nextHeader: 58 });
    const explicit = { type: 0x0806 };
    expect(fillLinkField('ethernet', explicit, 'ipv4')).toBe(explicit);
    const unknown = { dst: 'x' };
    expect(fillLinkField('ethernet', unknown, 'mystery')).toBe(unknown);
    expect(fillLinkField('ethernet', unknown, undefined)).toBe(unknown);
  });

  it('protocols named by the tables but without a codec still decode as payload (P0 decodes unchanged)', () => {
    // P1 registers udp and ipv6 (§9.2); unregister them for this check so the chain-walk rule is still exercised.
    const saved = [...CODECS];
    CODECS.delete('udp');
    CODECS.delete('ipv6');
    try {
      checkUnregisteredDecodeAsPayload();
    } finally {
      CODECS.clear();
      for (const [k, v] of saved) CODECS.set(k, v); // registry order restored exactly
    }
    expect(decodeLayers(encodeLayers([
      { proto: 'ethernet', fields: { dst: MAC2, src: MAC1, type: ETHERTYPE_IPV4 } },
      { proto: 'ipv4', fields: { src: '10.0.0.1', dst: '10.0.0.2', protocol: 253 } },
      { proto: 'payload', fields: { data: new Uint8Array(12) } },
    ])).map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'payload']);
  });

  function checkUnregisteredDecodeAsPayload(): void {
    const bytes = encodeLayers([
      { proto: 'ethernet', fields: { dst: MAC2, src: MAC1, type: ETHERTYPE_IPV4 } },
      { proto: 'ipv4', fields: { src: '10.0.0.1', dst: '10.0.0.2', protocol: 17 } },
      { proto: 'payload', fields: { data: new Uint8Array(12) } },
    ]);
    expect(decodeLayers(bytes).map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'payload']);
    const v6 = encodeLayers([
      { proto: 'ethernet', fields: { dst: MAC2, src: MAC1, type: 0x86dd } },
      { proto: 'payload', fields: { data: new Uint8Array(40) } },
    ]);
    expect(decodeLayers(v6).map((l) => l.proto)).toEqual(['ethernet', 'payload']);
  }
});

describe('pdu/codecs registry hooks (P0.5)', () => {
  it('raises the chain cap to 32 layers', () => {
    expect(MAX_LAYERS).toBe(32);
  });

  it('derived maps name derived or decode-only fields of PROTO_FIELDS, in provenance order', () => {
    for (const codec of CODECS.values()) {
      const table = PROTO_FIELDS[codec.proto];
      for (const name of Object.keys(codec.derived ?? {})) {
        const spec = table?.fields.find((fs) => fs.name === name);
        expect(spec, `${codec.proto}.${name}`).toBeDefined();
        expect(spec!.derived === true || spec!.decodeOnly === true).toBe(true);
      }
    }
    expect(ethernetCodec.derived).toEqual({ fcs: 'FcsRecompute', padding: 'Padding' });
    expect(Object.keys(ipv4Codec.derived!)).toEqual(['checksum', 'totalLength', 'ihl']);
    expect(icmpv4Codec.derived).toEqual({ checksum: 'ChecksumRecompute' });
  });

  it('icmpv4 errors stop meaning; echoes do not', () => {
    expect(icmpv4Codec.stopsMeaning!({ type: ICMP_TIME_EXCEEDED })).toBe(true);
    expect(icmpv4Codec.stopsMeaning!({ type: ICMP_DEST_UNREACHABLE })).toBe(true);
    expect(icmpv4Codec.stopsMeaning!({ type: ICMP_ECHO_REQUEST })).toBe(false);
  });

  it('icmpv4 summarize borrows addresses from the CodecContext', () => {
    const outer = [{ proto: 'ipv4', fields: { src: '10.0.0.1', dst: '10.0.0.2' } }];
    expect(icmpv4Codec.summarize({ type: ICMP_ECHO_REPLY, id: 3, seq: 4 }, { outer })).toBe('ICMP echo reply 10.0.0.1 > 10.0.0.2 id=3 seq=4');
    expect(icmpv4Codec.summarize({ type: ICMP_ECHO_REPLY, id: 3, seq: 4 }, { outer: [] })).toBe('ICMP echo reply id=3 seq=4');
  });

  it('ethernet fixTrailer is idempotent', () => {
    const [eth, arp] = decodeLayers(new Uint8Array(ARP_REQUEST_FRAME));
    const again = ethernetCodec.fixTrailer!(eth!, arp);
    expect(again).toEqual(eth);
    expect(ethernetCodec.fixTrailer!(eth!, undefined)).toBe(eth);
  });
});
