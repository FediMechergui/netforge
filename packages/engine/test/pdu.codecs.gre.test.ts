/**
 * [S18] GRE codec (ARCHITECTURE-P3 §7 W1 approved pdu items, D17, §2.3, §3.10): IP protocol 47, `LINK_FIELDS.gre`
 * (protocolType in the ethertype space). The §3.10 ping between two sites, assembled independently of the engine.
 */
import { describe, expect, it } from 'vitest';
import { ICMP_ECHO_REQUEST, IPPROTO_GRE, IPPROTO_ICMP } from '../src/contracts/pdu.js';
import type { LayerSpec, LayerView, PduMeta } from '../src/contracts/pdu.js';
import { PROTO_FIELDS } from '../src/contracts/fields.js';
import { decodeLayers, encodeLayers, fillLinkField } from '../src/pdu/codecs/registry.js';
import { keyForProto, linkFieldFor, lookupNext } from '../src/pdu/codecs/dispatch.js';
import { greCodec } from '../src/pdu/codecs/gre.js';
import { createPduFactory } from '../src/pdu/factory.js';

const hex = (s: string): number[] => (s.replace(/\s+/g, '').match(/.{2}/g) ?? []).map((h) => parseInt(h, 16));
const protos = (layers: readonly LayerView[]): string[] => layers.map((l) => l.proto);
const meta = (): PduMeta => ({ born: 0, origin: 'd_r1' });

/** PC1 192.168.1.10 → PC2 192.168.2.10, echo id 1 seq 1, inner TTL already decremented at R1 (127). */
const INNER = '4500001c 0000 0000 7f 01 b77c c0a8010a c0a8020a' + ' 0800 f7fd 0001 0001';
/** R1 209.165.200.225 → R2 209.165.200.230, protocol 47, TTL 255, then the 4-byte GRE header. */
const GRE_PACKET = '45000034 0000 0000 ff 2f 8687 d1a5c8e1 d1a5c8e6' + ' 0000 0800 ' + INNER;

const inner = (): LayerSpec[] => [
  { proto: 'ipv4', fields: { src: '192.168.1.10', dst: '192.168.2.10', ttl: 127, protocol: IPPROTO_ICMP } },
  { proto: 'icmpv4', fields: { type: ICMP_ECHO_REQUEST, code: 0, id: 1, seq: 1 } },
];
const outer = (): LayerSpec => ({ proto: 'ipv4', fields: { src: '209.165.200.225', dst: '209.165.200.230', ttl: 255 } });

describe('GRE codec [S18]', () => {
  it('encodes the §3.10 tunnel leg; the registry fills ipv4.protocol 47 and gre.protocolType 0x0800', () => {
    expect(lookupNext('ipproto', IPPROTO_GRE)).toBe('gre');
    expect(keyForProto('ipproto', 'gre')).toBe(47);
    expect(linkFieldFor('gre')).toEqual({ field: 'protocolType', space: 'ethertype' });
    expect(fillLinkField('gre', {}, 'ipv4')).toEqual({ protocolType: 0x0800 });
    expect(fillLinkField('gre', {}, 'ipv6')).toEqual({ protocolType: 0x86dd });
    const b = encodeLayers([outer(), { proto: 'gre', fields: {} }, ...inner()]);
    expect(Array.from(b)).toEqual(hex(GRE_PACKET));
    const layers = decodeLayers(b, 'ipv4');
    expect(protos(layers)).toEqual(['ipv4', 'gre', 'ipv4', 'icmpv4', 'payload']); // the echo carries no data
    expect(layers[1]!.fields).toEqual({ checksumPresent: false, keyPresent: false, seqPresent: false, version: 0, protocolType: 0x0800 });
    expect(layers[1]!.headerLength).toBe(4);
    expect(layers[1]!.length).toBe(4 + 28);
    for (const layer of layers) {
      const names = new Set(PROTO_FIELDS[layer.proto]!.fields.map((x) => x.name));
      for (const k of Object.keys(layer.fields)) expect(names.has(k), `${layer.proto}.${k}`).toBe(true);
    }
    // the leg is described by what it carries (GRE does not stop the meaning)
    const pdu = createPduFactory().decode(b, meta(), 'ipv4');
    expect(pdu.topProto()).toBe('icmpv4');
    expect(greCodec.summarize(layers[1]!.fields)).toBe('GRE protocol 0x0800');
  });

  it('the tunnel head wraps the inner packet in one rewrap: same PduId, Decapsulate ethernet, Encapsulate gre, Encapsulate ipv4', () => {
    const f = createPduFactory();
    const pdu = f.build([{ proto: 'ethernet', fields: { dst: '02:00:00:00:00:02', src: '02:00:00:00:00:01', type: 0x0800 } }, ...inner()], meta());
    const id = pdu.id;
    pdu.rewrap({ now: 5, device: 'd_r1' }, { strip: 1, push: [outer(), { proto: 'gre', fields: {} }] }, 'interface Tunnel0');
    expect(pdu.id).toBe(id);
    expect(Array.from(pdu.bytes)).toEqual(hex(GRE_PACKET));
    expect(protos(pdu.layers)).toEqual(['ipv4', 'gre', 'ipv4', 'icmpv4', 'payload']);
    expect(pdu.provenance.map((m) => [m.reason, m.field])).toEqual([['Decapsulate', 'ethernet'], ['Encapsulate', 'gre'], ['Encapsulate', 'ipv4']]);
    // the tail strips the outer header and GRE and hands the inner packet on unchanged
    pdu.rewrap({ now: 9, device: 'd_r2' }, { strip: 2, push: [] }, 'interface Tunnel0');
    expect(Array.from(pdu.bytes)).toEqual(hex(INNER));
  });

  it('writes the RFC 2784 checksum when asked, skips the key and sequence words, and reports bad headers', () => {
    const b = encodeLayers([{ proto: 'gre', fields: { checksumPresent: true } }, ...inner()]);
    expect(Array.from(b.slice(0, 8))).toEqual(hex('8000 0800 77ff 0000'));
    const d = decodeLayers(b, 'gre');
    expect(protos(d)).toEqual(['gre', 'ipv4', 'icmpv4', 'payload']);
    expect(d[0]!.headerLength).toBe(8);
    expect(d[0]!.fields.checksumPresent).toBe(true);
    const ks = encodeLayers([{ proto: 'gre', fields: { keyPresent: true, seqPresent: true } }, ...inner()]);
    expect(Array.from(ks.slice(0, 12))).toEqual(hex('3000 0800 00000000 00000000'));
    expect(protos(decodeLayers(ks, 'gre'))).toEqual(['gre', 'ipv4', 'icmpv4', 'payload']);
    expect(greCodec.decode(Uint8Array.from([0, 0, 8]), 0, 3).error).toBe('GRE header truncated');
    expect(greCodec.decode(Uint8Array.from([0x80, 0, 8, 0, 0]), 0, 5).error).toBe('GRE optional fields truncated');
    expect(greCodec.decode(Uint8Array.from([0, 1, 8, 0]), 0, 4).error).toBe('GRE version 1 is not simulated');
    expect(() => greCodec.encode({ version: 9, protocolType: 0x0800 }, new Uint8Array(0))).toThrow(/version out of range/);
    expect(() => greCodec.encode({}, new Uint8Array(0))).toThrow(/gre.protocolType is required/);
  });
});
