/**
 * 802.3 length framing and LLC with and without SNAP (ARCHITECTURE-P2 §2.3, §7 W1 pdu).
 *
 * The SNAP paths are pinned unchanged (the dot11 vectors of pdu.codecs.link.test.ts run through the same code), and
 * the new length-framed path is checked from both ends: what the codecs write, and where each byte lands on decode.
 */
import { describe, expect, it } from 'vitest';
import { ETH_LENGTH_MAX, ETHERTYPE_VLAN, LLC_SAP_STP, NF_OUI, NF_PID_DTP, STP_GROUP_MAC } from '../src/contracts/pdu.js';
import type { LayerSpec, LayerView } from '../src/contracts/pdu.js';
import { decodeLayers, encodeLayers } from '../src/pdu/codecs/registry.js';
import { ethernetCodec, nextForTypeOrLength, typeOrLengthToWrite } from '../src/pdu/codecs/ethernet.js';
import { LLC_HEADER, llcCodec } from '../src/pdu/codecs/llc.js';
import { dot1qCodec } from '../src/pdu/codecs/dot1q.js';
import { isLengthType } from '../src/pdu/codecs/dispatch.js';
import { STP_BPDU_CONFIG } from '../src/pdu/codecs/stp.js';

const hex = (s: string): number[] => (s.replace(/\s+/g, '').match(/.{2}/g) ?? []).map((h) => parseInt(h, 16));
const protos = (layers: readonly LayerView[]): string[] => layers.map((l) => l.proto);
const MAC1 = '02:b3:b2:b1:b0:01';
const BASE = '02:b3:b2:b1:b0:00';

const bpdu = (over: Record<string, number> = {}): LayerSpec => ({
  proto: 'stp',
  fields: {
    version: 0, bpduType: STP_BPDU_CONFIG, flags: 0, rootPriority: 32769, rootMac: BASE, rootPathCost: 0,
    bridgePriority: 32769, bridgeMac: BASE, portId: 0x8001, messageAge: 0, maxAge: 5120, helloTime: 512,
    forwardDelay: 3840, ...over,
  },
});

describe('802.3 length framing (ethernet and dot1q)', () => {
  it('writes the LLC payload length whenever the builder passes a value up to 0x05dc', () => {
    expect(isLengthType(0)).toBe(true);
    expect(isLengthType(ETH_LENGTH_MAX)).toBe(true);
    expect(isLengthType(ETH_LENGTH_MAX + 1)).toBe(false);
    expect(typeOrLengthToWrite('ethernet', 0, 38)).toBe(38);
    expect(typeOrLengthToWrite('ethernet', 1500, 38)).toBe(38); // any length value is replaced by the real one
    expect(typeOrLengthToWrite('ethernet', 0x0800, 38)).toBe(0x0800);
    expect(() => typeOrLengthToWrite('ethernet', 0, 1501)).toThrow(/at most 1500 bytes/);
    expect(() => typeOrLengthToWrite('ethernet', 0x10000, 1)).toThrow(/out of range/);
  });

  it('dispatches a length to llc, bounded by it, and an ethertype through the table', () => {
    expect(nextForTypeOrLength(38, 14, 46)).toEqual({ proto: 'llc', offset: 14, length: 38 });
    expect(nextForTypeOrLength(38, 14, 20)).toEqual({ proto: 'llc', offset: 14, length: 20 }); // clamped to what is there
    expect(nextForTypeOrLength(0x0800, 14, 46)).toEqual({ proto: 'ipv4', offset: 14, length: 46 });
    expect(nextForTypeOrLength(0x88b5, 14, 46)).toEqual({ proto: 'payload', offset: 14, length: 46 });
  });

  it('keeps the padding of a short 802.3 frame on the ethernet trailer, never on LLC', () => {
    const b = encodeLayers([
      { proto: 'ethernet', fields: { dst: STP_GROUP_MAC, src: MAC1, type: 0 } },
      { proto: 'llc', fields: { dsap: LLC_SAP_STP, ssap: LLC_SAP_STP, control: 3 } },
      bpdu(),
    ]);
    expect(b.length).toBe(64);
    const layers = decodeLayers(b);
    expect(protos(layers)).toEqual(['ethernet', 'llc', 'stp']);
    expect(layers[0]!.fields.type).toBe(38);
    expect(layers[0]!.fields.padding).toBe(8);
    expect(layers[0]!.trailerLength).toBe(8 + 4);
    expect(layers[1]!.offset).toBe(14);
    expect(layers[1]!.length).toBe(38);
    expect(layers[2]!.length).toBe(35);
  });

  it('a frame whose 802.3 length is longer than the bytes present decodes to what is there', () => {
    const b = encodeLayers([
      { proto: 'ethernet', fields: { dst: STP_GROUP_MAC, src: MAC1, type: 0 } },
      { proto: 'llc', fields: { dsap: LLC_SAP_STP, ssap: LLC_SAP_STP, control: 3 } },
      bpdu(),
    ]);
    const lying = b.slice();
    lying[13] = 60; // claim 60 bytes of LLC in a frame that carries 46
    const layers = decodeLayers(lying);
    expect(protos(layers)).toEqual(['ethernet', 'llc', 'stp']);
    expect(layers[1]!.length).toBe(38); // header + the BPDU the inner layer declares
    expect(layers[2]!.length).toBe(35);
  });

  it('carries the same rule inside an 802.1Q tag', () => {
    const b = encodeLayers([
      { proto: 'ethernet', fields: { dst: STP_GROUP_MAC, src: MAC1, type: ETHERTYPE_VLAN } },
      { proto: 'dot1q', fields: { vid: 99 } },
      { proto: 'llc', fields: { dsap: LLC_SAP_STP, ssap: LLC_SAP_STP, control: 3 } },
      bpdu({ pvid: 99 }),
    ]);
    const layers = decodeLayers(b);
    expect(protos(layers)).toEqual(['ethernet', 'dot1q', 'llc', 'stp']);
    expect(layers[0]!.fields.type).toBe(ETHERTYPE_VLAN);
    expect(layers[1]!.fields.type).toBe(44);
    expect(layers[3]!.fields.pvid).toBe(99);
    expect(dot1qCodec.encode({ vid: 1, type: 0 }, Uint8Array.from([1, 2, 3]))).toEqual(Uint8Array.from([0, 1, 0, 3, 1, 2, 3]));
  });

  it('summarizes a length-framed ethernet header as a length', () => {
    expect(ethernetCodec.summarize({ src: MAC1, dst: STP_GROUP_MAC, type: 38 })).toBe(`Ethernet ${MAC1} > ${STP_GROUP_MAC} length=38`);
    expect(ethernetCodec.summarize({ src: MAC1, dst: STP_GROUP_MAC, type: 0x0806 })).toBe(`Ethernet ${MAC1} > ${STP_GROUP_MAC} type=0x0806`);
  });
});

describe('llc without SNAP (P2)', () => {
  it('is three bytes and dispatches on the DSAP', () => {
    const b = llcCodec.encode({ dsap: LLC_SAP_STP, ssap: LLC_SAP_STP, control: 3 }, Uint8Array.from([0, 0, 0, 0x80]));
    expect(Array.from(b)).toEqual([0x42, 0x42, 0x03, 0, 0, 0, 0x80]);
    const d = llcCodec.decode(b, 0, b.length);
    expect(d.headerLength).toBe(LLC_HEADER);
    expect(d.fields).toEqual({ dsap: 0x42, ssap: 0x42, control: 3 });
    expect(d.next).toEqual({ proto: 'stp', offset: 3, length: 4 });
    expect(d.error).toBeUndefined();
  });

  it('leaves an unregistered SAP without a next layer and refuses SNAP-only fields', () => {
    const b = llcCodec.encode({ dsap: 0xf0, ssap: 0xf0, control: 3 }, Uint8Array.from([1, 2]));
    expect(Array.from(b)).toEqual([0xf0, 0xf0, 3, 1, 2]);
    const d = llcCodec.decode(b, 0, b.length);
    expect(d.next).toBeUndefined();
    expect(d.error).toBeUndefined();
    expect(d.length).toBe(5);
    expect(() => llcCodec.encode({ dsap: 0x42, ssap: 0x42, type: 0x0800 }, new Uint8Array(0))).toThrow(/SNAP header/);
    expect(llcCodec.decode(Uint8Array.from([0x42, 0x42]), 0, 2).error).toBe('LLC header truncated');
    expect(llcCodec.summarize({ dsap: 0x42, ssap: 0x42, control: 3 })).toBe('LLC dsap=0x42 ssap=0x42');
  });

  it('keeps the SNAP paths byte-identical and adds the NF PID space', () => {
    const snap = llcCodec.encode({ type: 0x0800 }, Uint8Array.from([9]));
    expect(Array.from(snap)).toEqual([0xaa, 0xaa, 3, 0, 0, 0, 0x08, 0x00, 9]);
    const d = llcCodec.decode(snap, 0, snap.length);
    expect(d.fields).toEqual({ dsap: 0xaa, ssap: 0xaa, control: 3, oui: 0, type: 0x0800 });
    expect(d.next).toEqual({ proto: 'ipv4', offset: 8, length: 1 });
    expect(llcCodec.summarize(d.fields)).toBe('LLC/SNAP type=0x0800');

    const nf = llcCodec.encode({ oui: NF_OUI, type: NF_PID_DTP }, Uint8Array.from([1]));
    expect(Array.from(nf)).toEqual([0xaa, 0xaa, 3, 0x02, 0x4e, 0x46, 0x00, 0x01, 1]);
    expect(llcCodec.decode(nf, 0, nf.length).next?.proto).toBe('dtp');
    expect(llcCodec.summarize({ dsap: 0xaa, ssap: 0xaa, oui: NF_OUI, type: 1 })).toBe('LLC/SNAP NF protocol 0x0001');

    const bad = snap.slice();
    bad[2] = 0x04;
    expect(llcCodec.decode(bad, 0, bad.length).error).toBe('not an LLC/SNAP header');
    expect(llcCodec.decode(Uint8Array.from([0xaa, 0xaa, 3]), 0, 3).error).toBe('LLC/SNAP header truncated');
  });
});
