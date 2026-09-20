import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ARP_OP_REQUEST,
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  ICMP_ECHO_REQUEST,
  ICMP_TIME_EXCEEDED,
  IPPROTO_ICMP,
} from '../src/contracts/pdu.js';
import type {
  Codec,
  CodecContext,
  DecodedLayer,
  FieldValue,
  LayerSpec,
  LayerView,
  MutationCtx,
  PduMeta,
} from '../src/contracts/pdu.js';
import { createPduFactory } from '../src/pdu/factory.js';
import {
  CODECS,
  LAYER_LIMIT_ERROR,
  MAX_LAYERS,
  decodeChain,
  decodeLayers,
  encodeLayers,
} from '../src/pdu/codecs/registry.js';
import { crc32, readU32LE } from '../src/pdu/checksum.js';

const MAC1 = '00:1f:00:00:00:01';
const MAC2 = '00:1f:00:00:00:02';
const MACR = '00:1f:00:00:00:0a';

const meta = (over: Partial<PduMeta> = {}): PduMeta => ({ born: 1000, origin: 'd_pc1', ...over });
const ctx = (now = 2000, device = 'd_ap1'): MutationCtx => ({ now, device });

const echoPacket = (payloadLen = 56): LayerSpec[] => [
  { proto: 'ipv4', fields: { src: '10.0.0.1', dst: '10.0.1.1', protocol: IPPROTO_ICMP, ttl: 128 } },
  { proto: 'icmpv4', fields: { type: ICMP_ECHO_REQUEST, code: 0, id: 1, seq: 1 } },
  { proto: 'payload', fields: { data: new Uint8Array(payloadLen).fill(0xab) } },
];

const echoFrame = (payloadLen = 56): LayerSpec[] => [
  { proto: 'ethernet', fields: { dst: MACR, src: MAC1, type: ETHERTYPE_IPV4 } },
  ...echoPacket(payloadLen),
];

const arpFrame = (): LayerSpec[] => [
  { proto: 'ethernet', fields: { dst: 'ff:ff:ff:ff:ff:ff', src: MAC1, type: ETHERTYPE_ARP } },
  { proto: 'arp', fields: { op: ARP_OP_REQUEST, sha: MAC1, spa: '10.0.0.1', tha: '00:00:00:00:00:00', tpa: '10.0.0.2' } },
];

const protos = (layers: readonly LayerView[]): string[] => layers.map((l) => l.proto);

describe('Pdu.rewrap strip/push', () => {
  it('strip 1 with nothing pushed exposes the packet, keeps the id and records one Decapsulate', () => {
    const f = createPduFactory();
    const p = f.build(echoFrame(), meta());
    const id = p.id;
    const packet = p.bytes.slice(14, 14 + 84);
    const cause = 'wireless client framing';

    p.rewrap(ctx(3000, 'd_lap1'), { strip: 1, push: [] }, cause);

    expect(p.id).toBe(id);
    expect(protos(p.layers)).toEqual(['ipv4', 'icmpv4', 'payload']);
    expect(p.size).toBe(84);
    expect(p.bytes).toEqual(packet);
    expect(p.get('ipv4.checksumValid')).toBe(true);
    expect(p.summary()).toBe('ICMP echo request 10.0.0.1 > 10.0.1.1 id=1 seq=1');
    expect(p.provenance).toEqual([
      { at: 3000, device: 'd_lap1', reason: 'Decapsulate', field: 'ethernet', before: 'ethernet', after: null, cause },
    ]);
  });

  it('strip 1 + push ethernet on a padded frame never doubles padding or FCS, however often it repeats', () => {
    const f = createPduFactory();
    const p = f.build(arpFrame(), meta());
    expect(p.size).toBe(64);
    for (let k = 0; k < 5; k++) {
      // type omitted: filled from the kept arp layer through the ethertype dispatch table
      p.rewrap(ctx(2000 + k), { strip: 1, push: [{ proto: 'ethernet', fields: { dst: MAC2, src: MACR } }] }, `hop ${k}`);
      const b = p.bytes;
      expect(p.size).toBe(64);
      expect(protos(p.layers)).toEqual(['ethernet', 'arp']);
      expect(p.get('ethernet.type')).toBe(ETHERTYPE_ARP);
      expect(p.get('ethernet.padding')).toBe(18);
      expect(p.layer('ethernet')!.trailerLength).toBe(22);
      expect(p.get('ethernet.fcsValid')).toBe(true);
      expect(crc32(b, 0, 60)).toBe(readU32LE(b, 60));
      expect(p.get('arp.tpa')).toBe('10.0.0.2');
    }
    expect(p.provenance.map((m) => `${m.reason}:${m.field}`)).toEqual(
      new Array<string>(5).fill('').flatMap(() => ['Decapsulate:ethernet', 'Encapsulate:ethernet']),
    );
    expect(p.provenance[1]).toEqual({ at: 2000, device: 'd_ap1', reason: 'Encapsulate', field: 'ethernet', before: null, after: 'ethernet', cause: 'hop 0' });
  });

  it('a tiny echo keeps its inner lengths when re-framed (padding stays attributed to ethernet)', () => {
    const f = createPduFactory();
    const p = f.build(echoFrame(0), meta());
    expect(p.size).toBe(64);
    p.rewrap(ctx(), { strip: 1, push: [{ proto: 'ethernet', fields: { dst: MAC2, src: MACR, type: ETHERTYPE_IPV4 } }] });
    expect(p.size).toBe(64);
    expect(p.layer('ipv4')!.length).toBe(28);
    expect(p.layer('icmpv4')!.length).toBe(8);
    expect(p.get('ethernet.padding')).toBe(64 - 4 - 14 - 28);
    expect(p.get('ethernet.fcsValid')).toBe(true);
  });

  it('pushes several layers innermost-first, fills link fields, and records Encapsulate innermost first', () => {
    const f = createPduFactory();
    const p = f.build(echoFrame(8), meta());
    const packet = p.bytes.slice(14, 14 + 36);

    p.rewrap(ctx(), {
      strip: 1,
      push: [
        { proto: 'ethernet', fields: { dst: MAC2, src: MACR } },
        { proto: 'ipv4', fields: { src: '192.0.2.1', dst: '192.0.2.2', protocol: 4, ttl: 64 } },
      ],
    }, 'tunnel entry');

    expect(protos(p.layers)).toEqual(['ethernet', 'ipv4', 'payload']);
    expect(p.size).toBe(14 + 20 + 36 + 4);
    expect(p.get('ethernet.type')).toBe(ETHERTYPE_IPV4); // filled from push[1]
    expect(p.get('ipv4.totalLength')).toBe(56);
    expect(p.get('ipv4.checksumValid')).toBe(true);
    expect(p.get('payload.data')).toEqual(packet);
    expect(p.provenance.map((m) => [m.reason, m.field, m.before, m.after])).toEqual([
      ['Decapsulate', 'ethernet', 'ethernet', null],
      ['Encapsulate', 'ipv4', null, 'ipv4'],
      ['Encapsulate', 'ethernet', null, 'ethernet'],
    ]);

    // tunnel exit: strip ethernet + outer ipv4, re-frame the original packet
    p.rewrap(ctx(), { strip: 2, push: [{ proto: 'ethernet', fields: { dst: MAC1, src: MAC2, type: ETHERTYPE_IPV4 } }] }, 'tunnel exit');
    expect(protos(p.layers)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'payload']);
    expect(p.size).toBe(64);
    expect(p.get('ipv4.src')).toBe('10.0.0.1');
    expect(p.get('ipv4.checksumValid')).toBe(true);
    expect(p.get('icmpv4.checksumValid')).toBe(true);
    expect(p.provenance.slice(3).map((m) => `${m.reason}:${m.field}`)).toEqual([
      'Decapsulate:ethernet',
      'Decapsulate:ipv4',
      'Encapsulate:ethernet',
    ]);
  });

  it('strip 2 with nothing pushed re-decodes from the kept layer', () => {
    const f = createPduFactory();
    const p = f.build(echoFrame(), meta());
    p.rewrap(ctx(), { strip: 2, push: [] });
    expect(protos(p.layers)).toEqual(['icmpv4', 'payload']);
    expect(p.size).toBe(64);
    expect(p.topProto()).toBe('icmpv4');
    expect(p.get('icmpv4.checksumValid')).toBe(true);
    expect(p.provenance.map((m) => `${m.reason}:${m.field}`)).toEqual(['Decapsulate:ethernet', 'Decapsulate:ipv4']);
    expect(p.layers).toEqual(decodeLayers(p.bytes, 'icmpv4'));
  });

  it('rejects impossible rewraps and leaves the PDU untouched (atomic)', () => {
    const f = createPduFactory();
    const p = f.build(arpFrame(), meta());
    const bytes = p.bytes;
    expect(() => p.rewrap(ctx(), { strip: 2, push: [] })).toThrow(/leaves no layers/);
    expect(() => p.rewrap(ctx(), { strip: 9, push: [] })).toThrow(/leaves no layers/);
    expect(() => p.rewrap(ctx(), { strip: -1, push: [] })).toThrow(RangeError);
    expect(() => p.rewrap(ctx(), { strip: 1.5, push: [] })).toThrow(RangeError);
    expect(() => p.rewrap(ctx(), { strip: 1, push: [{ proto: 'ipv4', fields: { dst: '10.0.0.9' } }] })).toThrow(/ipv4\./);
    expect(() => p.rewrap(ctx(), { strip: 1, push: [{ proto: 'mystery', fields: {} }] })).toThrow(/mystery/);
    expect(p.provenance).toEqual([]);
    expect(p.bytes).toEqual(bytes);
    expect(protos(p.layers)).toEqual(['ethernet', 'arp']);
  });

  it('strip 0 with nothing pushed is a no-op; stripping everything with a push wraps an empty payload', () => {
    const f = createPduFactory();
    const p = f.build(arpFrame(), meta());
    const bytes = p.bytes;
    p.rewrap(ctx(), { strip: 0, push: [] });
    expect(p.provenance).toEqual([]);
    expect(p.bytes).toEqual(bytes);

    p.rewrap(ctx(), { strip: 5, push: [{ proto: 'payload', fields: { data: new Uint8Array([1, 2, 3]) } }] });
    expect(protos(p.layers)).toEqual(['payload']);
    expect(p.size).toBe(3);
    expect(p.provenance.map((m) => `${m.reason}:${m.field}`)).toEqual(['Decapsulate:ethernet', 'Decapsulate:arp', 'Encapsulate:payload']);
  });

  it('clone after rewrap carries the structural history; layers remain the decoder view', () => {
    const f = createPduFactory();
    const p = f.build(echoFrame(), meta());
    p.rewrap(ctx(), { strip: 1, push: [] }, 'strip');
    const c = f.clone(p, 4000);
    expect(c.provenance).toEqual(p.provenance);
    expect(c.bytes).toEqual(p.bytes);
    expect(p.layers).toEqual(decodeLayers(p.bytes, 'ipv4'));
    c.rewrap(ctx(), { strip: 0, push: [{ proto: 'ethernet', fields: { dst: MAC2, src: MAC1 } }] });
    expect(protos(c.layers)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'payload']);
    expect(protos(p.layers)).toEqual(['ipv4', 'icmpv4', 'payload']);
  });
});

describe('Pdu.layerAt', () => {
  it('addresses duplicated protos by index (ICMP error quotes)', () => {
    const f = createPduFactory();
    const original = f.build(echoFrame(72), meta());
    const ip = original.layer('ipv4')!;
    const quote = original.bytes.subarray(ip.offset, ip.offset + ip.headerLength + 8);
    const err = f.build(
      [
        { proto: 'ethernet', fields: { dst: MAC1, src: MACR, type: ETHERTYPE_IPV4 } },
        { proto: 'ipv4', fields: { src: '10.0.0.254', dst: '10.0.0.1', protocol: IPPROTO_ICMP, ttl: 255 } },
        { proto: 'icmpv4', fields: { type: ICMP_TIME_EXCEEDED, code: 0 } },
        { proto: 'payload', fields: { data: quote } },
      ],
      meta({ origin: 'd_r1' }),
    );
    expect(err.layerAt(0)!.proto).toBe('ethernet');
    expect(err.layerAt(3)).toBe(err.layers[3]);
    expect(err.layerAt(3)!.proto).toBe('ipv4');
    expect(err.layerAt(3)!.fields.src).toBe('10.0.0.1');
    expect(err.layer('ipv4')!.fields.src).toBe('10.0.0.254');
    expect(err.layerAt(6)).toBeUndefined();
    expect(err.layerAt(-1)).toBeUndefined();
    expect(err.layerAt(1.5)).toBeUndefined();
    expect(err.summary()).toBe('ICMP time exceeded (ttl)');
  });
});

// ── codec hooks: CodecContext plumbing, fixTrailer, MAX_LAYERS, derived, transparent ──

const seenDecode: string[] = [];
const seenEncode: string[] = [];
const fixOrder: number[] = [];

const outerNames = (c: CodecContext | undefined): string => (c ? c.outer.map((o) => o.proto).join('/') : '<none>');

/** Test codec: 2-byte header [flag, marker]; flag 1 chains to another probe, anything else to payload. */
const probeCodec: Codec = {
  proto: 'probe',
  defaults: Object.freeze({ flag: 0, marker: 0 }),
  decode(bytes: Uint8Array, offset: number, length: number, c?: CodecContext): DecodedLayer {
    seenDecode.push(outerNames(c));
    const avail = Math.max(0, Math.min(length, bytes.length - offset));
    const flag = bytes[offset] ?? 0;
    const marker = bytes[offset + 1] ?? 0;
    return {
      fields: { flag, marker, check: marker ^ 0xff },
      fieldRanges: { flag: [offset, 1], marker: [offset + 1, 1] },
      headerLength: 2,
      length: avail,
      next: { proto: flag === 1 ? 'probe' : 'payload', offset: offset + 2, length: avail - 2 },
    };
  },
  encode(fields: Record<string, FieldValue>, payload: Uint8Array, c?: CodecContext): Uint8Array {
    seenEncode.push(outerNames(c));
    const out = new Uint8Array(2 + payload.length);
    out[0] = Number(fields.flag ?? 0);
    out[1] = Number(fields.marker ?? 0);
    out.set(payload, 2);
    return out;
  },
  summarize(_fields: Readonly<Record<string, FieldValue>>, c?: CodecContext): string {
    return `probe depth=${c ? c.outer.length : -1}`;
  },
  derived: Object.freeze({ check: 'ChecksumRecompute' }),
  fixTrailer(self: LayerView, inner: LayerView | undefined): LayerView {
    fixOrder.push(self.offset);
    return { ...self, fields: { ...self.fields, innerProto: inner ? inner.proto : null } };
  },
};

/** Transparent framing glue: 1-byte header, chains to arp when bytes follow. */
const glueCodec: Codec = {
  proto: 'glue',
  defaults: Object.freeze({}),
  transparent: true,
  decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
    const avail = Math.max(0, Math.min(length, bytes.length - offset));
    return {
      fields: { tag: bytes[offset] ?? 0 },
      fieldRanges: { tag: [offset, 1] },
      headerLength: 1,
      length: avail,
      ...(avail > 1 ? { next: { proto: 'arp', offset: offset + 1, length: avail - 1 } } : {}),
    };
  },
  encode(_fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
    const out = new Uint8Array(1 + payload.length);
    out[0] = 0xaa;
    out.set(payload, 1);
    return out;
  },
  summarize(): string {
    return 'glue';
  },
};

/** n probe headers (the last one ends the probe chain) plus one payload byte. */
const probes = (n: number): Uint8Array => {
  const b = new Uint8Array(n * 2 + 1);
  for (let i = 0; i < n; i++) b[i * 2] = i < n - 1 ? 1 : 0;
  b[n * 2] = 9;
  return b;
};

describe('registry codec hooks', () => {
  beforeAll(() => {
    CODECS.set('probe', probeCodec);
    CODECS.set('glue', glueCodec);
  });
  afterAll(() => {
    CODECS.delete('probe');
    CODECS.delete('glue');
  });
  beforeEach(() => {
    seenDecode.length = 0;
    seenEncode.length = 0;
    fixOrder.length = 0;
  });

  it('encode passes each codec the specs outside it; decode passes the layers decoded so far', () => {
    const bytes = encodeLayers([
      { proto: 'probe', fields: { flag: 1 } },
      { proto: 'probe', fields: { flag: 1 } },
      { proto: 'probe', fields: { flag: 0 } },
      { proto: 'payload', fields: { data: new Uint8Array([9]) } },
    ]);
    expect(seenEncode).toEqual(['probe/probe', 'probe', '']);
    expect(Array.from(bytes)).toEqual([1, 0, 1, 0, 0, 0, 9]);
    const layers = decodeLayers(bytes, 'probe');
    expect(protos(layers)).toEqual(['probe', 'probe', 'probe', 'payload']);
    expect(seenDecode).toEqual(['', 'probe', 'probe/probe']);
  });

  it('fixTrailer runs innermost first and sees the inner layer view', () => {
    const layers = decodeLayers(probes(3), 'probe');
    expect(fixOrder).toEqual([4, 2, 0]);
    expect(layers[0]!.fields.innerProto).toBe('probe');
    expect(layers[2]!.fields.innerProto).toBe('payload');
  });

  it(`MAX_LAYERS is ${MAX_LAYERS}; a longer chain is cut and flagged`, () => {
    expect(MAX_LAYERS).toBe(32);
    const exact = decodeChain(probes(31), 'probe');
    expect(exact.layers).toHaveLength(32);
    expect(exact.truncated).toBe(false);
    expect(exact.layers.every((l) => l.error === undefined)).toBe(true);

    const cut = decodeChain(probes(32), 'probe');
    expect(cut.layers).toHaveLength(32);
    expect(cut.truncated).toBe(true);
    expect(cut.layers[31]!.error).toBe(LAYER_LIMIT_ERROR);
    expect(cut.layers[30]!.error).toBeUndefined();

    const looping = decodeChain(new Uint8Array(200).fill(1), 'probe');
    expect(looping.layers).toHaveLength(32);
    expect(looping.truncated).toBe(true);
  });

  it('summary passes the CodecContext; derived provenance comes from codec.derived', () => {
    const f = createPduFactory();
    const p = f.build(
      [
        { proto: 'probe', fields: { flag: 1, marker: 5 } },
        { proto: 'probe', fields: { flag: 0, marker: 6 } },
        { proto: 'payload', fields: { data: new Uint8Array([1]) } },
      ],
      meta(),
    );
    expect(p.topProto()).toBe('probe');
    expect(p.summary()).toBe('probe depth=1');
    p.mutate(ctx(), 'probe.marker', 7, 'Other', 'test');
    expect(p.provenance.map((m) => [m.reason, m.field, m.before, m.after])).toEqual([
      ['Other', 'probe.marker', 5, 7],
      ['ChecksumRecompute', 'probe.check', 5 ^ 0xff, 7 ^ 0xff],
    ]);
  });

  it('transparent codecs are skipped by topProto and summary', () => {
    const f = createPduFactory();
    const arp = encodeLayers(arpFrame()).subarray(14, 14 + 28);
    const framed = new Uint8Array(1 + arp.length);
    framed[0] = 0xaa;
    framed.set(arp, 1);
    const p = f.decode(framed, meta(), 'glue');
    expect(protos(p.layers)).toEqual(['glue', 'arp']);
    expect(p.topProto()).toBe('arp');
    expect(p.summary()).toBe('ARP request who-has 10.0.0.2 tell 10.0.0.1');

    const alone = f.decode(new Uint8Array([0xaa]), meta(), 'glue');
    expect(protos(alone.layers)).toEqual(['glue']);
    expect(alone.topProto()).toBe('payload');
    expect(alone.summary()).toBe('glue');
  });
});
