import { describe, expect, it } from 'vitest';
import {
  ARP_OP_REQUEST,
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  ICMP_ECHO_REQUEST,
  ICMP_TIME_EXCEEDED,
  IPPROTO_ICMP,
} from '../src/contracts/pdu.js';
import type { FieldValue, LayerSpec, Mutation, MutationCtx, Pdu, PduMeta } from '../src/contracts/pdu.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { PduImpl, isPduImpl } from '../src/pdu/pdu.js';
import { encodeLayers } from '../src/pdu/codecs/registry.js';
import { crc32, readU32LE } from '../src/pdu/checksum.js';

const MAC1 = '00:1f:00:00:00:01';
const MAC2 = '00:1f:00:00:00:02';
const MACR = '00:1f:00:00:00:0a';

const meta = (over: Partial<PduMeta> = {}): PduMeta => ({ born: 1000, origin: 'd_pc1', ...over });
const ctx = (now = 2000, device = 'd_r1'): MutationCtx => ({ now, device });

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

const reasons = (p: Pdu): string[] => p.provenance.map((m) => m.reason);

describe('pdu/factory', () => {
  it('hands out dense monotonic ids from 1 shared by build/decode/clone and calls onCreate for each', () => {
    const seen: Pdu[] = [];
    const f = createPduFactory({ onCreate: (p) => seen.push(p) });
    const a = f.build(arpFrame(), meta());
    const b = f.decode(a.bytes, meta({ origin: 'd_sw1' }));
    const c = f.clone(a, 3000);
    expect([a.id, b.id, c.id]).toEqual([1, 2, 3]);
    expect(seen).toEqual([a, b, c]);
    expect(f.created).toBe(3);
    expect(f.nextId).toBe(4);
    expect(isPduImpl(a)).toBe(true);
  });

  it('layers are always the decoder view of bytes (a payload that happens to be IPv4 stays payload)', () => {
    const f = createPduFactory();
    const ipBytes = encodeLayers(echoPacket());
    const p = f.build([{ proto: 'ethernet', fields: { dst: MAC2, src: MAC1, type: ETHERTYPE_IPV4 } }, { proto: 'payload', fields: { data: ipBytes } }], meta());
    // ethernet decode follows the ethertype, so the decoder view IS ipv4 even though the builder said payload
    expect(p.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'payload']);
    const q = f.build([{ proto: 'payload', fields: { data: ipBytes } }], meta());
    expect(q.layers.map((l) => l.proto)).toEqual(['payload']);
    expect(q.topProto()).toBe('payload');
  });

  it('decode copies the input buffer and build starts with an empty provenance', () => {
    const f = createPduFactory();
    const src = encodeLayers(arpFrame());
    const p = f.decode(src, meta());
    src[0] = 0x11;
    expect(p.bytes[0]).toBe(0xff);
    expect(p.provenance).toEqual([]);
    expect(p.size).toBe(64);
    expect(p.meta).toEqual(meta());
  });

  it('firstId lets a restored counter continue', () => {
    const f = createPduFactory({ firstId: 42 });
    expect(f.build(arpFrame(), meta()).id).toBe(42);
  });

  it('a frame with an unknown ethertype decodes as ethernet + payload', () => {
    const f = createPduFactory();
    const p = f.build([{ proto: 'ethernet', fields: { dst: MAC2, src: MAC1, type: 0x88b5 } }, { proto: 'payload', fields: { data: new Uint8Array([1, 2, 3]) } }], meta());
    expect(p.layers.map((l) => l.proto)).toEqual(['ethernet', 'payload']);
    expect(p.topProto()).toBe('ethernet');
    expect(p.summary()).toBe(`Ethernet ${MAC1} > ${MAC2} type=0x88b5`);
  });
});

describe('pdu/pdu accessors', () => {
  it('bytes returns an independent copy; layer/get/summary/topProto read the decoder view', () => {
    const f = createPduFactory();
    const p = f.build(arpFrame(), meta());
    const b1 = p.bytes;
    b1[0] = 0;
    expect(p.bytes[0]).toBe(0xff);
    expect(p.layer('arp')?.fields.tpa).toBe('10.0.0.2');
    expect(p.layer('ipv4')).toBeUndefined();
    expect(p.get('ethernet.type')).toBe(ETHERTYPE_ARP);
    expect(p.get('arp.op')).toBe(ARP_OP_REQUEST);
    expect(p.get('arp.nope')).toBeUndefined();
    expect(p.get('nodot')).toBeUndefined();
    expect(p.summary()).toBe('ARP request who-has 10.0.0.2 tell 10.0.0.1');
    expect(p.topProto()).toBe('arp');
  });

  it('summary uses the innermost meaningful layer and borrows src/dst for ICMP', () => {
    const f = createPduFactory();
    const p = f.build(echoFrame(), meta());
    expect(p.summary()).toBe('ICMP echo request 10.0.0.1 > 10.0.1.1 id=1 seq=1');
    expect(p.topProto()).toBe('icmpv4');
    const ip = f.build([{ proto: 'ipv4', fields: { src: '10.0.0.1', dst: '10.0.1.1', protocol: 253 } }, { proto: 'payload', fields: { data: new Uint8Array(3) } }], meta());
    expect(ip.summary()).toBe('IPv4 10.0.0.1 > 10.0.1.1 proto=253 ttl=128');
    expect(ip.topProto()).toBe('ipv4');
  });

  it('toJSON is a structured-clone-safe snapshot that survives structuredClone', () => {
    const f = createPduFactory();
    const p = f.build(echoFrame(), meta({ tag: 'ping#1', flow: 'ipv4:10.0.0.1>10.0.1.1:icmp' }));
    p.mutate(ctx(), 'ipv4.ttl', 127, 'TtlDecrement', 'ip route 10.0.1.0 255.255.255.0 10.0.0.254');
    const json = p.toJSON();
    const copy = structuredClone(json);
    expect(copy).toEqual(json);
    expect(copy.id).toBe(p.id);
    expect(copy.bytes).toEqual(p.bytes);
    expect(copy.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'payload']);
    expect(copy.summary).toBe('ICMP echo request 10.0.0.1 > 10.0.1.1 id=1 seq=1');
    expect(copy.topProto).toBe('icmpv4');
    expect(copy.meta).toEqual(p.meta);
    expect(copy.provenance.map((m) => m.reason)).toEqual(['TtlDecrement', 'ChecksumRecompute', 'FcsRecompute']);
    // the snapshot does not alias the PDU's internals
    json.bytes[0] = 0;
    expect(p.bytes[0]).toBe(0x00);
    expect(p.bytes[1]).toBe(0x1f);
    (json.layers[1]!.fields as Record<string, FieldValue>).ttl = 1;
    expect(p.get('ipv4.ttl')).toBe(127);
  });
});

describe('pdu/pdu mutate', () => {
  it("mutate('ipv4.ttl') keeps size, re-encodes ipv4.checksum and ethernet.fcs, appends exactly 3 mutations", () => {
    const f = createPduFactory();
    const p = f.build(echoFrame(), meta());
    const before = p.bytes;
    const ipl = p.layer('ipv4')!;
    const oldChecksum = ipl.fields.checksum;
    const oldFcs = p.get('ethernet.fcs');
    const cause = 'ip route 10.0.1.0 255.255.255.0 10.0.0.254';

    p.mutate(ctx(2000, 'd_r1'), 'ipv4.ttl', 127, 'TtlDecrement', cause);

    expect(p.size).toBe(before.length);
    expect(p.get('ipv4.ttl')).toBe(127);
    expect(p.get('ipv4.checksum')).not.toBe(oldChecksum);
    expect(p.get('ipv4.checksumValid')).toBe(true);
    expect(p.get('ethernet.fcs')).not.toBe(oldFcs);
    expect(p.get('ethernet.fcsValid')).toBe(true);
    expect(p.get('icmpv4.checksumValid')).toBe(true);
    expect(p.get('ipv4.totalLength')).toBe(84);
    expect(p.get('ethernet.padding')).toBe(0);
    // only the ttl byte, checksum and FCS changed
    const after = p.bytes;
    const diff: number[] = [];
    for (let i = 0; i < after.length; i++) if (after[i] !== before[i]) diff.push(i);
    expect(diff.every((i) => i === 22 || i === 24 || i === 25 || i >= after.length - 4)).toBe(true);
    expect(diff).toContain(22);

    expect(reasons(p)).toEqual(['TtlDecrement', 'ChecksumRecompute', 'FcsRecompute']);
    const [m0, m1, m2] = p.provenance as [Mutation, Mutation, Mutation];
    expect(m0).toEqual({ at: 2000, device: 'd_r1', reason: 'TtlDecrement', field: 'ipv4.ttl', before: 128, after: 127, cause });
    expect(m1.field).toBe('ipv4.checksum');
    expect(m1.before).toBe(oldChecksum);
    expect(m1.after).toBe(p.get('ipv4.checksum'));
    expect(m2.field).toBe('ethernet.fcs');
    expect(m2.before).toBe(oldFcs);
    expect(m2.after).toBe(p.get('ethernet.fcs'));
    // layers were rebuilt from the bytes, so the old view is stale but untouched
    expect(ipl.fields.ttl).toBe(128);
  });

  it('a MacRewrite on ethernet does not double-pad and leaves inner checksums untouched', () => {
    const f = createPduFactory();
    const p = f.build(arpFrame(), meta());
    const ipChecksum = p.get('ipv4.checksum');
    p.mutate(ctx(), 'ethernet.src', MACR, 'MacRewrite');
    p.mutate(ctx(), 'ethernet.dst', MAC2, 'MacRewrite');
    expect(p.size).toBe(64);
    expect(p.get('ethernet.src')).toBe(MACR);
    expect(p.get('ethernet.dst')).toBe(MAC2);
    expect(p.get('ethernet.padding')).toBe(18);
    expect(p.get('ethernet.fcsValid')).toBe(true);
    expect(p.get('ipv4.checksum')).toBe(ipChecksum);
    expect(reasons(p)).toEqual(['MacRewrite', 'FcsRecompute', 'MacRewrite', 'FcsRecompute']);
    const b = p.bytes;
    expect(crc32(b, 0, 60)).toBe(p.get('ethernet.fcs'));
  });

  it('mutating an inner field updates every outer derived field', () => {
    const f = createPduFactory();
    const p = f.build(echoFrame(), meta());
    p.mutate(ctx(), 'icmpv4.seq', 2, 'Other');
    expect(p.get('icmpv4.seq')).toBe(2);
    expect(p.get('icmpv4.checksumValid')).toBe(true);
    expect(p.get('ethernet.fcsValid')).toBe(true);
    // the IPv4 header did not change, so no ipv4 ChecksumRecompute is recorded
    expect(reasons(p)).toEqual(['Other', 'ChecksumRecompute', 'FcsRecompute']);
    expect(p.provenance[1]!.field).toBe('icmpv4.checksum');
  });

  it('changing the payload size records the length/padding changes too', () => {
    const f = createPduFactory();
    const p = f.build(echoFrame(0), meta());
    expect(p.size).toBe(64);
    p.mutate(ctx(), 'payload.data', new Uint8Array(40), 'Other');
    expect(p.size).toBe(14 + 20 + 8 + 40 + 4);
    expect(p.get('ipv4.totalLength')).toBe(68);
    expect(p.get('ethernet.padding')).toBe(0);
    expect(p.get('ipv4.checksumValid')).toBe(true);
    expect(p.get('ethernet.fcsValid')).toBe(true);
    expect(p.provenance.map((m) => m.field)).toContain('ipv4.totalLength');
    expect(p.provenance.map((m) => m.field)).toContain('ethernet.padding');
  });

  it('rejects bad paths and missing layers', () => {
    const f = createPduFactory();
    const p = f.build(arpFrame(), meta());
    expect(() => p.mutate(ctx(), 'ttl', 1, 'Other')).toThrow(/proto/);
    expect(() => p.mutate(ctx(), 'ipv4.ttl', 1, 'TtlDecrement')).toThrow(/no ipv4 layer/);
    expect(p.provenance).toHaveLength(0);
  });
});

describe('pdu/pdu encapsulate', () => {
  it('wraps an L3 packet in ethernet, keeps the id, and records one Encapsulate mutation', () => {
    const f = createPduFactory();
    const p = f.build(echoPacket(), meta());
    expect(p.layers.map((l) => l.proto)).toEqual(['ipv4', 'icmpv4', 'payload']);
    expect(p.size).toBe(84);
    const id = p.id;
    p.encapsulate(ctx(1500, 'd_pc1'), { proto: 'ethernet', fields: { dst: MACR, src: MAC1, type: ETHERTYPE_IPV4 } }, 'arp cache 10.0.0.254');
    expect(p.id).toBe(id);
    expect(p.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'payload']);
    expect(p.size).toBe(14 + 84 + 4);
    expect(p.get('ethernet.dst')).toBe(MACR);
    expect(p.get('ethernet.src')).toBe(MAC1);
    expect(p.get('ethernet.type')).toBe(ETHERTYPE_IPV4);
    expect(p.get('ethernet.fcsValid')).toBe(true);
    expect(p.get('ipv4.checksumValid')).toBe(true);
    expect(p.layer('ipv4')!.offset).toBe(14);
    expect(p.provenance).toEqual([
      { at: 1500, device: 'd_pc1', reason: 'Encapsulate', field: 'ethernet', before: null, after: 'ethernet', cause: 'arp cache 10.0.0.254' },
    ]);
    expect(p.summary()).toBe('ICMP echo request 10.0.0.1 > 10.0.1.1 id=1 seq=1');
  });

  it('fills ethernet.type from the current outermost layer when omitted', () => {
    const f = createPduFactory();
    const p = f.build(echoPacket(), meta());
    p.encapsulate(ctx(), { proto: 'ethernet', fields: { dst: MACR, src: MAC1 } });
    expect(p.get('ethernet.type')).toBe(ETHERTYPE_IPV4);
    expect(p.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'payload']);
  });

  it('an encapsulated packet can then be mutated per hop', () => {
    const f = createPduFactory();
    const p = f.build(echoPacket(), meta());
    p.encapsulate(ctx(), { proto: 'ethernet', fields: { dst: MACR, src: MAC1, type: ETHERTYPE_IPV4 } });
    p.mutate(ctx(), 'ipv4.ttl', 127, 'TtlDecrement', 'ip route 0.0.0.0 0.0.0.0 10.0.0.254');
    p.mutate(ctx(), 'ethernet.src', MACR, 'MacRewrite');
    p.mutate(ctx(), 'ethernet.dst', MAC2, 'MacRewrite');
    expect(p.size).toBe(102);
    expect(p.get('ethernet.fcsValid')).toBe(true);
    expect(p.get('ipv4.checksumValid')).toBe(true);
    expect(p.get('ipv4.ttl')).toBe(127);
    expect(reasons(p)).toEqual([
      'Encapsulate', 'TtlDecrement', 'ChecksumRecompute', 'FcsRecompute', 'MacRewrite', 'FcsRecompute', 'MacRewrite', 'FcsRecompute',
    ]);
  });
});

describe('pdu/pdu ICMP errors', () => {
  it('a time-exceeded quoting a 100-byte echo decodes nested layers and summarises as the error', () => {
    const f = createPduFactory();
    const original = f.build(echoFrame(72), meta());
    expect(original.size).toBe(14 + 100 + 4);
    const ip = original.layer('ipv4')!;
    const quote = original.bytes.subarray(ip.offset, ip.offset + ip.headerLength + 8);
    const err = f.build(
      [
        { proto: 'ethernet', fields: { dst: MAC1, src: MACR, type: ETHERTYPE_IPV4 } },
        { proto: 'ipv4', fields: { src: '10.0.0.254', dst: '10.0.0.1', protocol: IPPROTO_ICMP, ttl: 255 } },
        { proto: 'icmpv4', fields: { type: ICMP_TIME_EXCEEDED, code: 0 } },
        { proto: 'payload', fields: { data: quote } },
      ],
      meta({ origin: 'd_r1', triggeredBy: original.id }),
    );
    expect(err.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'ipv4', 'icmpv4', 'payload']);
    const inner = err.layers[3]!;
    expect(inner.fields.totalLength).toBe(100);
    expect(inner.length).toBe(28);
    expect(inner.error).toBeUndefined();
    expect(err.layers[4]!.fields.seq).toBe(1);
    expect(err.summary()).toBe('ICMP time exceeded (ttl)');
    expect(err.topProto()).toBe('icmpv4');
    // outermost-first lookup finds the error's own ipv4, not the quoted one
    expect(err.get('ipv4.src')).toBe('10.0.0.254');
    expect(err.meta.triggeredBy).toBe(original.id);
  });
});

describe('pdu/pdu corrupt and clone', () => {
  it('corrupt flips one bit, records a Corruption mutation and invalidates the FCS', () => {
    const f = createPduFactory();
    const p = f.build(arpFrame(), meta());
    const before = p.bytes;
    p.corrupt(ctx(2500, 'l_1'), 20, 0x01);
    const after = p.bytes;
    expect(after[20]).toBe(before[20]! ^ 0x01);
    expect(after.length).toBe(before.length);
    expect(p.get('ethernet.fcsValid')).toBe(false);
    expect(p.get('ethernet.fcs')).toBe(readU32LE(before, 60)); // FCS bytes untouched, not recomputed
    expect(p.provenance).toHaveLength(1);
    const m = p.provenance[0]!;
    expect(m).toMatchObject({ at: 2500, device: 'l_1', reason: 'Corruption', field: 'raw.bytes', before: before[20], after: after[20] });
    expect(() => p.corrupt(ctx(), 64, 1)).toThrow(RangeError);
  });

  it('clone has a fresh id, parent, born, independent bytes/layers/provenance', () => {
    const f = createPduFactory();
    const p = f.build(echoFrame(), meta({ tag: 'ping#1' }));
    p.mutate(ctx(), 'ipv4.ttl', 127, 'TtlDecrement');
    const c = f.clone(p, 5000);
    expect(c.id).toBe(p.id + 1);
    expect(c.meta).toEqual({ ...p.meta, born: 5000, parent: p.id });
    expect(c.bytes).toEqual(p.bytes);
    expect(c.layers).toEqual(p.layers);
    expect(c.layers).not.toBe(p.layers);
    expect(c.provenance).toEqual(p.provenance);
    expect(c.provenance).not.toBe(p.provenance);
    expect(c.provenance[0]).not.toBe(p.provenance[0]);
    // diverge: mutating the clone leaves the original alone
    c.mutate(ctx(), 'ipv4.ttl', 126, 'TtlDecrement');
    expect(p.get('ipv4.ttl')).toBe(127);
    expect(c.get('ipv4.ttl')).toBe(126);
    expect(p.provenance).toHaveLength(3);
    expect(c.provenance).toHaveLength(6);
    c.corrupt(ctx(), 0, 0xff);
    expect(p.get('ethernet.fcsValid')).toBe(true);
    expect(c.get('ethernet.fcsValid')).toBe(false);
  });

  it('PduImpl takes ownership of the bytes handed to its constructor', () => {
    const bytes = encodeLayers(arpFrame());
    const p = new PduImpl(7, bytes, [], meta());
    expect(p.id).toBe(7);
    expect(p.layers).toEqual([]);
    expect(p.summary()).toBe('64 bytes');
    expect(p.topProto()).toBe('payload');
  });
});
