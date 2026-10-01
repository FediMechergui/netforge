/**
 * [C13] ESP and IKEv2-lite codecs (ARCHITECTURE-P3 §2.17, D27, §3.13; §7 W1 approved pdu items): IP protocol 50 and
 * UDP 500. §2.17 names the cases: golden bytes for the four IKE messages and an ESP packet, the trailer for inner
 * lengths 1453–1456 (every one fits in 1500), and that no byte of any PDU is the configured key. Goldens assembled
 * independently of the engine (the ICV words by a separate FNV-1a implementation).
 */
import { describe, expect, it } from 'vitest';
import { ICMP_ECHO_REQUEST, IPPROTO_ESP, IPPROTO_ICMP, IPSEC_OVERHEAD, UDP_PORT_IKE } from '../src/contracts/pdu.js';
import type { FieldValue, LayerSpec, LayerView, PduMeta } from '../src/contracts/pdu.js';
import { PROTO_FIELDS } from '../src/contracts/fields.js';
import { decodeLayers, encodeLayers } from '../src/pdu/codecs/registry.js';
import { keyForProto, lookupNext } from '../src/pdu/codecs/dispatch.js';
import { fnv1aBytes, fnv1aU32 } from '../src/pdu/checksum.js';
import { ESP_HEADER_BYTES, espCodec, espIcvKeyMatches, espPadLength } from '../src/pdu/codecs/esp.js';
import { IKEV2_EXCHANGE, IKEV2_FLAG, ikev2Codec } from '../src/pdu/codecs/ikev2.js';
import { createPduFactory } from '../src/pdu/factory.js';

const hex = (s: string): number[] => (s.replace(/\s+/g, '').match(/.{2}/g) ?? []).map((h) => parseInt(h, 16));
const protos = (layers: readonly LayerView[]): string[] => layers.map((l) => l.proto);
const layerBytes = (b: Uint8Array, l: LayerView): number[] => Array.from(b.slice(l.offset, l.offset + l.length));
const meta = (): PduMeta => ({ born: 0, origin: 'd_r1' });

function checkNames(layers: readonly LayerView[]): void {
  for (const layer of layers) {
    const names = new Set(PROTO_FIELDS[layer.proto]!.fields.map((x) => x.name));
    for (const k of Object.keys(layer.fields)) expect(names.has(k), `${layer.proto}.${k}`).toBe(true);
  }
}

const R1 = '209.165.200.225';
const R2 = '209.165.200.230';
const KEY_ID = 0x0badf00d;
const INNER = '4500001c 0000 0000 7f 01 b77c c0a8010a c0a8020a 0800 f7fd 0001 0001';
/** SPI, seq 1, the inner echo (28 bytes), padding 1 2, pad length 2, next header 4, ICV w0 w1 w2. */
const ESP = '5a1f2e3d 00000001 ' + INNER + ' 0102 02 04' + ' ddd1ab93 793f6960 0eb64d04';
const ESP_OUTER = '45000048 0000 0000 ff 32 8670 d1a5c8e1 d1a5c8e6';

const innerSpecs = (): LayerSpec[] => [
  { proto: 'ipv4', fields: { src: '192.168.1.10', dst: '192.168.2.10', ttl: 127, protocol: IPPROTO_ICMP } },
  { proto: 'icmpv4', fields: { type: ICMP_ECHO_REQUEST, code: 0, id: 1, seq: 1 } },
];

const SA = 'enc=aes-cbc-256,integ=sha256,prf=sha256,dh=14';
const KEI = '01080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3da';
const NI = '030e19242f3a45505b66717c87929da8b3bec9d4dfeaf5000b16212c37424d58';
const KER = '05121f2c394653606d7a8794a1aebbc8d5e2effc091623303d4a5764717e8b98';
const NR = '091a2b3c4d5e6f8091a2b3c4d5e6f708192a3b4c5d6e7f90a1b2c3d4e5f60718';
const AUTH_I = '02070c11161b20252a2f34393e43484d';
const AUTH_R = '04070a0d101316191c1f2225282b2e31';
const SPI_I = '1a2b3c4d5e6f7081';
const SPI_R = '9a8b7c6d5e4f3021';

const SA_HEX = '656e633d6165732d6362632d3235362c696e7465673d7368613235362c7072663d7368613235362c64683d3134';
const IKE_INIT_REQ = `${SPI_I} 0000000000000000 21 20 22 08 00000000 00000099` +
  ` 22 00 0031 ${SA_HEX}` + ` 28 00 0028 000e 0000 ${KEI}` + ` 00 00 0024 ${NI}`;
const IKE_INIT_RESP = `${SPI_I} ${SPI_R} 21 20 22 20 00000000 00000099` +
  ` 22 00 0031 ${SA_HEX}` + ` 28 00 0028 000e 0000 ${KER}` + ` 00 00 0024 ${NR}`;
const TS = '302e302e302e302f30'; // '0.0.0.0/0'
const IKE_AUTH_REQ = `${SPI_I} ${SPI_R} 23 20 23 08 00000001 0000008d` +
  ' 27 00 000c 01 000000 d1a5c8e1' + ` 21 00 0018 02 000000 ${AUTH_I}` +
  ' 2c 00 0033 6573703a656e633d6165732d6362632d3235362c696e7465673d7368613235362c7370693d30783561316632653364' +
  ` 2d 00 000d ${TS}` + ` 00 00 000d ${TS}`;
const IKE_AUTH_RESP = `${SPI_I} ${SPI_R} 24 20 23 20 00000001 0000008d` +
  ' 27 00 000c 01 000000 d1a5c8e6' + ` 21 00 0018 02 000000 ${AUTH_R}` +
  ' 2c 00 0033 6573703a656e633d6165732d6362632d3235362c696e7465673d7368613235362c7370693d30783662326533663461' +
  ` 2d 00 000d ${TS}` + ` 00 00 000d ${TS}`;
const IKE_AUTH_FAILED = `${SPI_I} ${SPI_R} 29 20 23 20 00000001 00000024` + ' 00 00 0008 00 00 0018';

const ikeOverUdp = (fields: Record<string, FieldValue>): LayerSpec[] => [
  { proto: 'ipv4', fields: { src: R1, dst: R2, protocol: 17 } },
  { proto: 'udp', fields: { srcPort: UDP_PORT_IKE, dstPort: UDP_PORT_IKE } },
  { proto: 'ikev2', fields },
];

describe('ESP codec [C13]', () => {
  it('encodes the §3.13 tunnel leg: outer protocol 50, SPI and sequence, the inner packet in clear, the trailer and the ICV', () => {
    expect(lookupNext('ipproto', IPPROTO_ESP)).toBe('esp');
    expect(keyForProto('ipproto', 'esp')).toBe(50);
    const b = encodeLayers([
      { proto: 'ipv4', fields: { src: R1, dst: R2, ttl: 255 } },
      { proto: 'esp', fields: { spi: 0x5a1f2e3d, seq: 1, keyId: KEY_ID } },
      ...innerSpecs(),
    ]);
    expect(Array.from(b.slice(0, 20))).toEqual(hex(ESP_OUTER));
    expect(Array.from(b.slice(20))).toEqual(hex(ESP));
    const layers = decodeLayers(b, 'ipv4');
    expect(protos(layers)).toEqual(['ipv4', 'esp', 'ipv4', 'icmpv4', 'payload']); // the echo carries no data
    const esp = layers[1]!;
    expect(esp.fields).toEqual({ spi: 0x5a1f2e3d, seq: 1, padLength: 2, nextHeader: 4, icv: Uint8Array.from(hex('ddd1ab93 793f6960 0eb64d04')), icvValid: true });
    expect(esp.headerLength).toBe(ESP_HEADER_BYTES);
    expect(esp.trailerLength).toBe(2 + 2 + 12);
    expect(layerBytes(b, layers[2]!)).toEqual(hex(INNER));
    checkNames(layers);
    // the keyed word is only recomputed by an end holding the SA's key id
    expect(espIcvKeyMatches(b, esp.offset, esp.length, KEY_ID)).toBe(true);
    expect(espIcvKeyMatches(b, esp.offset, esp.length, KEY_ID + 1)).toBe(false);
    // stopsMeaning is false: the leg is described by the inner packet (the inspector shows it under the ESP banner)
    const pdu = createPduFactory().decode(b, meta(), 'ipv4');
    expect(pdu.topProto()).toBe('icmpv4');
    expect(espCodec.summarize(esp.fields)).toBe('ESP spi 0x5a1f2e3d seq 1');
  });

  it('damage on the wire shows as an invalid ICV; the padding must count 1, 2, 3', () => {
    const b = Uint8Array.from(hex(ESP));
    b[20] = b[20]! ^ 0x01;
    expect(espCodec.decode(b, 0, b.length).fields.icvValid).toBe(false);
    const p = Uint8Array.from(hex(ESP));
    p[36] = 9; // the first padding byte
    expect(espCodec.decode(p, 0, p.length).error).toBe('ESP padding is not 1, 2, 3 …');
    expect(espCodec.decode(new Uint8Array(12), 0, 12).error).toBe('ESP trailer truncated');
    expect(() => espCodec.encode({ seq: 1 }, new Uint8Array(0))).toThrow(/esp.spi is required/);
  });

  it('pads inner packets of 1453–1456 bytes and every one fits in a 1500-byte outer packet (IPSEC_OVERHEAD 44)', () => {
    const outerLengths: number[] = [];
    const pads: number[] = [];
    for (let inner = 1453; inner <= 1456; inner++) {
      const b = encodeLayers([
        { proto: 'ipv4', fields: { src: R1, dst: R2, ttl: 255 } },
        { proto: 'esp', fields: { spi: 1, seq: 7 } },
        { proto: 'ipv4', fields: { src: '192.168.1.10', dst: '192.168.2.10', protocol: 253 } },
        { proto: 'payload', fields: { data: new Uint8Array(inner - 20) } },
      ]);
      const layers = decodeLayers(b, 'ipv4');
      expect(layers[2]!.fields.totalLength).toBe(inner);
      pads.push(layers[1]!.fields.padLength as number);
      outerLengths.push(b.length);
      expect(layers[1]!.fields.icvValid).toBe(true);
      expect(espPadLength(inner)).toBe(layers[1]!.fields.padLength);
    }
    expect(pads).toEqual([1, 0, 3, 2]);
    expect(outerLengths).toEqual([1496, 1496, 1500, 1500]);
    expect(1456 + IPSEC_OVERHEAD).toBe(1500);
  });
});

describe('IKEv2-lite codec [C13]', () => {
  it('encodes the four messages of the exchange (§3.13 steps 2–5) over UDP 500', () => {
    expect(lookupNext('udp.port', UDP_PORT_IKE)).toBe('ikev2');
    const messages: [string, Record<string, FieldValue>][] = [
      [IKE_INIT_REQ, { spiI: SPI_I, exchange: IKEV2_EXCHANGE.ikeSaInit, flags: IKEV2_FLAG.initiator, messageId: 0, sa: SA, ke: KEI, nonce: NI }],
      [IKE_INIT_RESP, { spiI: SPI_I, spiR: SPI_R, exchange: IKEV2_EXCHANGE.ikeSaInit, flags: IKEV2_FLAG.response, messageId: 0, sa: SA, ke: KER, nonce: NR }],
      [IKE_AUTH_REQ, {
        spiI: SPI_I, spiR: SPI_R, exchange: IKEV2_EXCHANGE.ikeAuth, flags: IKEV2_FLAG.initiator, messageId: 1, idi: R1, auth: AUTH_I,
        sa: 'esp:enc=aes-cbc-256,integ=sha256,spi=0x5a1f2e3d', tsi: '0.0.0.0/0', tsr: '0.0.0.0/0',
      }],
      [IKE_AUTH_RESP, {
        spiI: SPI_I, spiR: SPI_R, exchange: IKEV2_EXCHANGE.ikeAuth, flags: IKEV2_FLAG.response, messageId: 1, idr: R2, auth: AUTH_R,
        sa: 'esp:enc=aes-cbc-256,integ=sha256,spi=0x6b2e3f4a', tsi: '0.0.0.0/0', tsr: '0.0.0.0/0',
      }],
    ];
    for (const [golden, fields] of messages) {
      const b = encodeLayers(ikeOverUdp(fields));
      const layers = decodeLayers(b, 'ipv4');
      expect(protos(layers)).toEqual(['ipv4', 'udp', 'ikev2']);
      expect(layerBytes(b, layers[2]!)).toEqual(hex(golden));
      const d = layers[2]!.fields;
      expect(layers[2]!.error).toBeUndefined();
      for (const [k, v] of Object.entries(fields)) expect(d[k], k).toEqual(v);
      expect(d.version).toBe(0x20);
      expect(d.length).toBe(hex(golden).length);
      checkNames(layers);
      expect(Array.from(ikev2Codec.encode({ ...d }, new Uint8Array(0)))).toEqual(hex(golden));
    }
    expect(decodeLayers(Uint8Array.from(hex(IKE_INIT_REQ)), 'ikev2')[0]!.fields.spiR).toBe('0000000000000000');
    const pdu = createPduFactory().decode(encodeLayers(ikeOverUdp(messages[2]![1])), meta(), 'ipv4');
    expect(pdu.topProto()).toBe('ikev2');
    expect(pdu.summary()).toBe('IKEv2 IKE_AUTH request message 1');
  });

  it('answers a wrong key with an AUTHENTICATION_FAILED notify', () => {
    const fields = { spiI: SPI_I, spiR: SPI_R, exchange: IKEV2_EXCHANGE.ikeAuth, flags: IKEV2_FLAG.response, messageId: 1, notify: 'AUTHENTICATION_FAILED' };
    const b = ikev2Codec.encode({ ...fields }, new Uint8Array(0));
    expect(Array.from(b)).toEqual(hex(IKE_AUTH_FAILED));
    const d = ikev2Codec.decode(b, 0, b.length).fields;
    expect(d.notify).toBe('AUTHENTICATION_FAILED');
    expect(ikev2Codec.summarize(d)).toBe('IKEv2 IKE_AUTH response message 1, AUTHENTICATION_FAILED');
    const np = ikev2Codec.encode({ spiI: SPI_I, exchange: 34, flags: 0x20, notify: 'NO_PROPOSAL_CHOSEN' }, new Uint8Array(0));
    expect(ikev2Codec.decode(np, 0, np.length).fields.notify).toBe('NO_PROPOSAL_CHOSEN');
    expect(() => ikev2Codec.encode({ spiI: SPI_I, exchange: 34, notify: 'SOMETHING' }, new Uint8Array(0))).toThrow(/ikev2.notify must be one of/);
    expect(() => ikev2Codec.encode({ spiI: 'abc', exchange: 34 }, new Uint8Array(0))).toThrow(/16 hex digits/);
    expect(ikev2Codec.decode(Uint8Array.from(hex(IKE_INIT_REQ)).slice(0, 20), 0, 20).error).toBe('IKE header truncated');
    const cut = Uint8Array.from(hex(IKE_INIT_REQ)).slice(0, 60);
    expect(ikev2Codec.decode(cut, 0, cut.length).error).toMatch(/IKE message truncated/);
  });

  it('no byte sequence of any PDU of the exchange is the configured key (proofs and ICVs are FNV values)', () => {
    const key = 'Lab-PSK-2025!';
    const keyBytes = Array.from(new TextEncoder().encode(key));
    // a proof derived the D27 way (FNV-1a over the key, both SPIs, both nonces and the role), never the key itself
    const proofWords = (role: number): string => {
      let h = fnv1aBytes(Uint8Array.from(keyBytes));
      for (const part of [SPI_I, SPI_R, NI, NR]) h = fnv1aBytes(Uint8Array.from(hex(part)), 0, part.length / 2, h);
      h = fnv1aU32(role, h);
      const words = [h, fnv1aU32(1, h), fnv1aU32(2, h), fnv1aU32(3, h)];
      return words.map((w) => w.toString(16).padStart(8, '0')).join('');
    };
    const keyId = fnv1aBytes(Uint8Array.from(keyBytes));
    const pdus = [
      encodeLayers(ikeOverUdp({ spiI: SPI_I, exchange: 34, flags: 0x08, sa: SA, ke: KEI, nonce: NI })),
      encodeLayers(ikeOverUdp({ spiI: SPI_I, spiR: SPI_R, exchange: 34, flags: 0x20, sa: SA, ke: KER, nonce: NR })),
      encodeLayers(ikeOverUdp({ spiI: SPI_I, spiR: SPI_R, exchange: 35, flags: 0x08, messageId: 1, idi: R1, auth: proofWords(0x49), sa: 'esp:spi=0x1', tsi: '0.0.0.0/0', tsr: '0.0.0.0/0' })),
      encodeLayers(ikeOverUdp({ spiI: SPI_I, spiR: SPI_R, exchange: 35, flags: 0x20, messageId: 1, idr: R2, auth: proofWords(0x52), sa: 'esp:spi=0x2', tsi: '0.0.0.0/0', tsr: '0.0.0.0/0' })),
      encodeLayers([{ proto: 'ipv4', fields: { src: R1, dst: R2, ttl: 255 } }, { proto: 'esp', fields: { spi: 2, seq: 1, keyId } }, ...innerSpecs()]),
    ];
    const contains = (hay: Uint8Array, needle: readonly number[]): boolean => {
      for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((v, k) => hay[i + k] === v)) return true;
      return false;
    };
    for (const b of pdus) {
      expect(contains(b, keyBytes)).toBe(false);
      for (const layer of decodeLayers(b, 'ipv4')) {
        for (const v of Object.values(layer.fields)) expect(v).not.toBe(key);
      }
    }
  });
});
