/**
 * HSRP codec, versions 1 and 2 [SHOULD S2] (ARCHITECTURE-P2 D8, §2.3, §3.10; §7 W1 pdu [S2]).
 * The port, groups and virtual MAC prefixes are protocol facts; the v1 authentication data is eight zero bytes.
 */
import { describe, expect, it } from 'vitest';
import {
  HSRP_V1_GROUP,
  HSRP_V2_GROUP,
  IPPROTO_UDP,
  UDP_PORT_HSRP,
} from '../src/contracts/pdu.js';
import type { LayerSpec, LayerView, PduMeta } from '../src/contracts/pdu.js';
import { decodeLayers, encodeLayers } from '../src/pdu/codecs/registry.js';
import { HSRP_OP, HSRP_STATE, HSRP_V1_LENGTH, HSRP_V2_TLV_LENGTH, hsrpCodec, hsrpStateText, hsrpVirtualMac } from '../src/pdu/codecs/hsrp.js';
import { createPduFactory } from '../src/pdu/factory.js';

const hex = (s: string): number[] => (s.replace(/\s+/g, '').match(/.{2}/g) ?? []).map((h) => parseInt(h, 16));
const protos = (layers: readonly LayerView[]): string[] => layers.map((l) => l.proto);
const layerBytes = (b: Uint8Array, l: LayerView): number[] => Array.from(b.slice(l.offset, l.offset + l.length));
const meta = (): PduMeta => ({ born: 0, origin: 'd_r1' });

const R1_MAC = '02:b3:b2:b1:b0:0a';
const V2_MAC = hsrpVirtualMac(2, 1);

const hello = (version: 1 | 2, over: Record<string, string | number> = {}): LayerSpec[] => [
  { proto: 'ethernet', fields: { dst: version === 1 ? '01:00:5e:00:00:02' : '01:00:5e:00:00:66', src: version === 1 ? R1_MAC : V2_MAC, type: 0x0800 } },
  { proto: 'ipv4', fields: { src: '192.168.1.2', dst: version === 1 ? HSRP_V1_GROUP : HSRP_V2_GROUP, protocol: IPPROTO_UDP, ttl: 1 } },
  { proto: 'udp', fields: { srcPort: UDP_PORT_HSRP, dstPort: UDP_PORT_HSRP } },
  {
    proto: 'hsrp',
    fields: {
      version, opCode: HSRP_OP.hello, state: HSRP_STATE.active, helloMs: 3000, holdMs: 10000, priority: 110,
      group: 1, virtualIp: '192.168.1.1', ...(version === 2 ? { identifier: R1_MAC } : {}), ...over,
    },
  },
];

describe('hsrp codec [S2]', () => {
  it('encodes a version 1 hello as the 20-byte RFC 2281 message, with eight zero authentication bytes', () => {
    const b = encodeLayers(hello(1));
    const layers = decodeLayers(b);
    expect(protos(layers)).toEqual(['ethernet', 'ipv4', 'udp', 'hsrp']);
    expect(layerBytes(b, layers[3]!)).toEqual(hex('00 00 10 03 0a 6e 01 00 00 00 00 00 00 00 00 00 c0 a8 01 01'));
    expect(layers[3]!.length).toBe(HSRP_V1_LENGTH);
    expect(layers[3]!.fields).toEqual({
      version: 1, opCode: 0, state: HSRP_STATE.active, helloMs: 3000, holdMs: 10000, priority: 110, group: 1,
      authData: new Uint8Array(8), virtualIp: '192.168.1.1',
    });
    expect(createPduFactory().decode(b, meta()).summary()).toBe('HSRPv1 hello group 1 active priority 110 virtual 192.168.1.1');
  });

  it('encodes a version 2 hello as the 42-byte group state TLV', () => {
    const b = encodeLayers(hello(2));
    const layers = decodeLayers(b);
    expect(layerBytes(b, layers[3]!)).toEqual(hex('01 28 02 00 10 04 00 01')
      .concat(hex('02 b3 b2 b1 b0 0a'), hex('00 00 00 6e'), hex('00 00 0b b8'), hex('00 00 27 10'),
        hex('c0 a8 01 01'), new Array<number>(12).fill(0)));
    expect(layers[3]!.length).toBe(HSRP_V2_TLV_LENGTH);
    expect(layers[3]!.fields).toEqual({
      version: 2, opCode: 0, state: HSRP_STATE.active, helloMs: 3000, holdMs: 10000, priority: 110, group: 1,
      identifier: R1_MAC, virtualIp: '192.168.1.1',
    });
    expect(createPduFactory().decode(b, meta()).summary()).toBe('HSRPv2 hello group 1 active priority 110 virtual 192.168.1.1');
  });

  it('round-trips coup and resign in both versions, and every state name', () => {
    for (const version of [1, 2] as const) {
      for (const [op, state] of [[HSRP_OP.coup, HSRP_STATE.speak], [HSRP_OP.resign, HSRP_STATE.active]]) {
        const fields = hello(version, { opCode: op!, state: state! })[3]!.fields;
        const b = hsrpCodec.encode({ ...fields }, new Uint8Array(0));
        const d = hsrpCodec.decode(b, 0, b.length);
        expect(d.error).toBeUndefined();
        expect(Array.from(hsrpCodec.encode({ ...d.fields }, new Uint8Array(0)))).toEqual(Array.from(b));
      }
    }
    expect(hsrpStateText(HSRP_STATE.initial)).toBe('initial');
    expect(hsrpStateText(HSRP_STATE.listen)).toBe('listen');
    expect(hsrpStateText(HSRP_STATE.standby)).toBe('standby');
    expect(hsrpStateText(7)).toBe('state 7');
  });

  it('derives the virtual MAC of a group (a protocol fact, D8)', () => {
    expect(hsrpVirtualMac(1, 1)).toBe('00:00:0c:07:ac:01');
    expect(hsrpVirtualMac(1, 255)).toBe('00:00:0c:07:ac:ff');
    expect(hsrpVirtualMac(2, 1)).toBe('00:00:0c:9f:f0:01');
    expect(hsrpVirtualMac(2, 4095)).toBe('00:00:0c:9f:ff:ff');
    expect(() => hsrpVirtualMac(1, 256)).toThrow(RangeError);
    expect(() => hsrpVirtualMac(2, 4096)).toThrow(RangeError);
  });

  it('holds version 1 to its wire limits and reports a message that is neither version', () => {
    expect(() => hsrpCodec.encode({ version: 1, state: 0, group: 256 }, new Uint8Array(0))).toThrow(/group out of range/);
    expect(() => hsrpCodec.encode({ version: 1, state: 0, group: 1, helloMs: 1500 }, new Uint8Array(0))).toThrow(/whole seconds/);
    expect(() => hsrpCodec.encode({ version: 1, state: 0, group: 1, priority: 300 }, new Uint8Array(0))).toThrow(/priority out of range/);
    expect(() => hsrpCodec.encode({ version: 3, state: 0, group: 1 }, new Uint8Array(0))).toThrow(/must be 1 or 2/);
    expect(() => hsrpCodec.encode({ version: 2, state: 0, group: 1 }, Uint8Array.from([1]))).toThrow(/no inner layer/);
    expect(() => hsrpCodec.encode({ version: 1, state: 0, group: 1, authData: new Uint8Array(4) }, new Uint8Array(0))).toThrow(/8 bytes/);
    expect(hsrpCodec.decode(Uint8Array.from([9, 0, 0]), 0, 3).error).toMatch(/not an HSRP message/);
    expect(hsrpCodec.decode(Uint8Array.from([0, 0, 16]), 0, 3).error).toMatch(/truncated/);
    expect(hsrpCodec.decode(Uint8Array.from([1, 40, 2]), 0, 3).error).toMatch(/group state TLV truncated/);
  });
});
