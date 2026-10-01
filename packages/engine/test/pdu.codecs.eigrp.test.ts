/**
 * [C1] EIGRP codec (ARCHITECTURE-P3 §2.16, D26, §3.12; §7 W1 approved pdu items): IP protocol 88, the RFC 7868 header,
 * the parameter TLV and the classic IPv4 internal-route TLV with the RFC's 256-scaled delay and bandwidth. The cases
 * §2.16 names — a hello, an init update, an update carrying two routes, a query with an infinite route, a reply and an
 * acknowledgement (a hello with `ack`) — each against golden bytes assembled independently of the engine.
 */
import { describe, expect, it } from 'vitest';
import { EIGRP_GROUP, IPPROTO_EIGRP } from '../src/contracts/pdu.js';
import type { FieldValue, LayerView, PduMeta } from '../src/contracts/pdu.js';
import { PROTO_FIELDS } from '../src/contracts/fields.js';
import { decodeLayers, encodeLayers } from '../src/pdu/codecs/registry.js';
import { keyForProto, lookupNext } from '../src/pdu/codecs/dispatch.js';
import { EIGRP_FLAG, EIGRP_OPCODE, eigrpCodec, eigrpWireBandwidth, eigrpWireDelay } from '../src/pdu/codecs/eigrp.js';
import { createPduFactory } from '../src/pdu/factory.js';

const hex = (s: string): number[] => (s.replace(/\s+/g, '').match(/.{2}/g) ?? []).map((h) => parseInt(h, 16));
const protos = (layers: readonly LayerView[]): string[] => layers.map((l) => l.proto);
const meta = (): PduMeta => ({ born: 0, origin: 'd_r1' });

const HELLO = '02 05 fb7a 00000000 00000000 00000000 0000 0064' + ' 0001 000c 01 00 01 00 00 00 000f';
const INIT_UPDATE = '02 01 fd98 00000001 00000001 00000000 0000 0064';
/** R2 advertises 10.4.0.0/24 (20 µs, 1 Gb/s: its RD 3072) and its own 10.0.24.0/24, with the end-of-table flag. */
const UPDATE_TWO = '02 01 fa16 00000008 00000002 00000001 0000 0064' +
  ' 0102 001c 00000000 00000200 00000a00 0005dc 01 ff 01 00 00 18 0a0400' +
  ' 0102 001c 00000000 00000100 00000a00 0005dc 00 ff 01 00 00 18 0a0018';
const QUERY_INF = '02 03 fb64 00000000 00000003 00000000 0000 0064' + ' 0102 001c 00000000 ffffffff 00000a00 0005dc 01 ff 01 00 00 18 0a0400';
/** R3 replies with its own distance 28416 = 256 × (100 + 11): 100 Mb/s, 110 µs. */
const REPLY = '02 04 3362 00000000 00000001 00000003 0000 0064' + ' 0102 001c 00000000 00006e00 00006400 0005dc 01 ff 01 00 00 18 0a0400';
const ACK = '02 05 fd93 00000000 00000000 00000003 0000 0064';

const decodeOne = (h: string): Readonly<Record<string, FieldValue>> => {
  const b = Uint8Array.from(hex(h));
  const d = eigrpCodec.decode(b, 0, b.length);
  expect(d.error).toBeUndefined();
  return d.fields;
};

describe('EIGRP codec [C1] (RFC 7868)', () => {
  it('encodes a hello with the parameter TLV (K 1 0 1 0 0, hold 15) to 224.0.0.10 over IP protocol 88', () => {
    expect(lookupNext('ipproto', IPPROTO_EIGRP)).toBe('eigrp');
    expect(keyForProto('ipproto', 'eigrp')).toBe(88);
    const b = encodeLayers([
      { proto: 'ipv4', fields: { src: '10.0.12.1', dst: EIGRP_GROUP, ttl: 2, dscp: 48 } },
      { proto: 'eigrp', fields: { opcode: EIGRP_OPCODE.hello, as: 100, kValues: '1,0,1,0,0', holdS: 15 } },
    ]);
    const layers = decodeLayers(b, 'ipv4');
    expect(protos(layers)).toEqual(['ipv4', 'eigrp']);
    expect(layers[0]!.fields.protocol).toBe(88);
    expect(Array.from(b.slice(20))).toEqual(hex(HELLO));
    expect(layers[1]!.fields).toEqual({
      version: 2, opcode: 5, checksum: 0xfb7a, checksumValid: true, flags: 0, seq: 0, ack: 0, vrid: 0, as: 100, kValues: '1,0,1,0,0', holdS: 15,
    });
    const names = new Set(PROTO_FIELDS.eigrp!.fields.map((x) => x.name));
    for (const k of Object.keys(layers[1]!.fields)) expect(names.has(k), k).toBe(true);
    const pdu = createPduFactory().decode(b, meta(), 'ipv4');
    expect(pdu.topProto()).toBe('eigrp');
    expect(pdu.summary()).toBe('EIGRP hello AS 100, hold 15 s');
  });

  it('encodes the init update, a two-route update, a query with an infinite route, a reply and an acknowledgement', () => {
    const cases: [string, Record<string, FieldValue>][] = [
      [INIT_UPDATE, { opcode: EIGRP_OPCODE.update, flags: EIGRP_FLAG.init, seq: 1, as: 100 }],
      [UPDATE_TWO, {
        opcode: EIGRP_OPCODE.update, flags: EIGRP_FLAG.eot, seq: 2, ack: 1, as: 100,
        routes: '10.4.0.0/24,20,1000000,1500,1,255,1,0.0.0.0;10.0.24.0/24,10,1000000,1500,0,255,1,0.0.0.0',
      }],
      [QUERY_INF, { opcode: EIGRP_OPCODE.query, seq: 3, as: 100, routes: '10.4.0.0/24,inf,1000000,1500,1,255,1,0.0.0.0' }],
      [REPLY, { opcode: EIGRP_OPCODE.reply, seq: 1, ack: 3, as: 100, routes: '10.4.0.0/24,1100,100000,1500,1,255,1,0.0.0.0' }],
      [ACK, { opcode: EIGRP_OPCODE.hello, ack: 3, as: 100 }],
    ];
    for (const [golden, fields] of cases) {
      const b = eigrpCodec.encode({ ...fields }, new Uint8Array(0));
      expect(Array.from(b)).toEqual(hex(golden));
      const d = decodeOne(golden);
      expect(d.checksumValid).toBe(true);
      for (const [k, v] of Object.entries(fields)) expect(d[k], k).toEqual(v);
      expect(Array.from(eigrpCodec.encode({ ...d }, new Uint8Array(0)))).toEqual(hex(golden));
    }
    expect(eigrpCodec.summarize(decodeOne(ACK))).toBe('EIGRP acknowledgement AS 100, ack 3');
    expect(eigrpCodec.summarize(decodeOne(UPDATE_TWO))).toBe('EIGRP update AS 100, seq 2 ack 1, flags EOT, 2 routes');
    expect(eigrpCodec.summarize(decodeOne(QUERY_INF))).toBe('EIGRP query AS 100, seq 3 ack 0, 1 route');
    expect(eigrpCodec.summarize(decodeOne(INIT_UPDATE))).toBe('EIGRP update AS 100, seq 1 ack 0, flags init, 0 routes');
  });

  it('scales delay and bandwidth as the RFC does; the metric term floor(10⁷ / bw) survives the round trip exactly', () => {
    expect(eigrpWireDelay(20)).toBe(512);
    expect(eigrpWireDelay('inf')).toBe(0xffffffff);
    expect(eigrpWireBandwidth(1_000_000)).toBe(2560);
    expect(eigrpWireBandwidth(1544)).toBe(6476 * 256);
    expect(eigrpWireBandwidth(0)).toBe(0);
    const b = eigrpCodec.encode({ opcode: 1, as: 1, routes: '10.9.0.0/16,100,7000,1500,0,255,1,0.0.0.0' }, new Uint8Array(0));
    expect(Array.from(b.slice(20))).toEqual(hex('0102 001b 00000000 00000a00 00059400 0005dc 00 ff 01 00 00 10 0a09'));
    const d = eigrpCodec.decode(b, 0, b.length).fields;
    expect(d.routes).toBe('10.9.0.0/16,100,7002,1500,0,255,1,0.0.0.0');
    expect(Math.floor(10_000_000 / 7002)).toBe(Math.floor(10_000_000 / 7000));
    expect(Array.from(eigrpCodec.encode({ ...d }, new Uint8Array(0)))).toEqual(Array.from(b));
    const def = eigrpCodec.encode({ opcode: 1, as: 1, routes: '0.0.0.0/0,10,100000,1500,0,255,1,0.0.0.0' }, new Uint8Array(0));
    expect(eigrpCodec.decode(def, 0, def.length).fields.routes).toBe('0.0.0.0/0,10,100000,1500,0,255,1,0.0.0.0');
  });

  it('reports corruption and malformed TLVs, and refuses incomplete parameters', () => {
    const b = Uint8Array.from(hex(UPDATE_TWO));
    b[30] = b[30]! ^ 0x10;
    expect(eigrpCodec.decode(b, 0, b.length).fields.checksumValid).toBe(false);
    expect(eigrpCodec.decode(Uint8Array.from(hex(HELLO)), 0, 10).error).toBe('EIGRP header truncated');
    const cut = Uint8Array.from(hex(QUERY_INF)).slice(0, 30);
    expect(eigrpCodec.decode(cut, 0, cut.length).error).toMatch(/bad length/);
    expect(() => eigrpCodec.encode({ opcode: 5, as: 1, kValues: '1,0,1,0,0' }, new Uint8Array(0))).toThrow(/both kValues and holdS/);
    expect(() => eigrpCodec.encode({ opcode: 5, as: 1, kValues: '1,0,1', holdS: 15 }, new Uint8Array(0))).toThrow(/five numbers/);
    expect(() => eigrpCodec.encode({ opcode: 1, as: 1, routes: '10.0.0.0/24,1,1' }, new Uint8Array(0))).toThrow(/routes entry must be/);
  });
});
