import { describe, expect, it } from 'vitest';
import {
  ETHERTYPE_EAPOL,
  ETHERTYPE_IPV4,
  HDLC_ADDRESS_BROADCAST,
  HDLC_PROTO_KEEPALIVE,
  ICMP_ECHO_REQUEST,
  IPPROTO_ICMP,
} from '../src/contracts/pdu.js';
import type { LayerSpec, MutationCtx, PduMeta } from '../src/contracts/pdu.js';
import { PROTO_FIELDS } from '../src/contracts/fields.js';
import { CODECS, decodeLayers, encodeLayers, getCodec } from '../src/pdu/codecs/registry.js';
import { hdlcCodec } from '../src/pdu/codecs/hdlc.js';
import { dot11Codec, dot11SubtypeInfo, dot11SubtypeName, DOT11_SUBTYPES } from '../src/pdu/codecs/dot11.js';
import { dot11MgmtCodec } from '../src/pdu/codecs/dot11-mgmt.js';
import { llcCodec } from '../src/pdu/codecs/llc.js';
import { eapolCodec, eapolKeyInformation, eapolStepOf } from '../src/pdu/codecs/eapol.js';
import { crc16X25, crc32, readU16LE, readU32LE } from '../src/pdu/checksum.js';
import { createPduFactory } from '../src/pdu/factory.js';

const hex = (s: string): number[] => (s.replace(/\s+/g, '').match(/.{2}/g) ?? []).map((h) => parseInt(h, 16));
const protos = (layers: readonly { proto: string }[]): string[] => layers.map((l) => l.proto);
const meta = (): PduMeta => ({ born: 0, origin: 'd_test' });
const mctx = (device = 'd_r1'): MutationCtx => ({ now: 5000, device });

const STA = '00:1f:00:00:00:21';
const AP = '00:1f:00:00:00:10';
const BCAST = 'ff:ff:ff:ff:ff:ff';

// Golden frames assembled by hand; FCS values computed independently (zlib.crc32 and a bitwise CRC-16/X.25).

/** HDLC keepalive: address 0x8f, protocol 0x8035, myseq 1, yourseq 0, reliability 0xffff. */
const HDLC_KEEPALIVE: number[] = [
  ...hex('8f 00 80 35'),
  ...hex('00 00 00 01 00 00 00 00 ff ff 00 00'),
  ...hex('50 5d'), // CRC-16/X.25 0x5d50, little-endian
];

/** HDLC-framed IPv4 echo request 10.0.0.1 > 10.0.0.2 ttl 255, id 1 seq 1, 4 payload bytes. */
const HDLC_IPV4: number[] = [
  ...hex('0f 00 08 00'),
  ...hex('45 00 00 20 00 00 00 00 ff 01 a7 da 0a 00 00 01 0a 00 00 02'),
  ...hex('08 00 f3 f7 00 01 00 01 01 02 03 04'),
  ...hex('52 a3'),
];

/** Broadcast probe request for SSID LAB, seq 5, rates 1/2/5.5/11, band 2.4 simulation element. */
const PROBE_REQ: number[] = [
  ...hex('40 00 00 00'), // fc (mgmt, subtype 4), duration
  ...hex('ff ff ff ff ff ff'), // addr1
  ...hex('00 1f 00 00 00 21'), // addr2
  ...hex('ff ff ff ff ff ff'), // addr3
  ...hex('50 00'), // seq 5 << 4, little-endian
  ...hex('00 03 4c 41 42'), // SSID "LAB"
  ...hex('01 04 02 04 0b 16'), // supported rates
  ...hex('dd 07 02 4e 46 01 01 01 01'), // simulation element: band 2.4
  ...hex('c2 99 f1 6f'), // FCS
];

/** Station → AP data frame (to DS) carrying LLC/SNAP + EAPOL key message 2 of 4. */
const EAPOL_MSG2: number[] = [
  ...hex('08 01 00 00'),
  ...hex('00 1f 00 00 00 10'), // addr1 = bssid
  ...hex('00 1f 00 00 00 21'), // addr2 = station
  ...hex('00 1f 00 00 00 10'), // addr3 = destination
  ...hex('10 00'), // seq 1
  ...hex('aa aa 03 00 00 00 88 8e'), // LLC/SNAP type 0x888e
  ...hex('02 03 00 63'), // version 2, key, body 99
  ...hex('02 01 0a 00 10'), // RSN descriptor, key info 0x010a, key length 16
  ...hex('00 00 00 00 00 00 00 01'), // replay counter 1
  ...new Array<number>(32 + 16 + 8 + 8).fill(0), // nonce, iv, rsc, reserved
  ...new Array<number>(16).fill(0x6d), // MIC marker
  ...hex('00 04 de ad be ef'), // key data
  ...hex('2e 01 00 fd'),
];

/** Beacon for LAB on channel 6 with ten rates (8 + extended), RSN wpa2-psk and the simulation element. */
const BEACON: number[] = [
  ...hex('80 00 00 00 ff ff ff ff ff ff 00 1f 00 00 00 10 00 1f 00 00 00 10 00 00'),
  ...hex('00 00 00 00 00 00 00 00 64 00 11 00'), // timestamp, interval 100, capability 0x0011
  ...hex('00 03 4c 41 42'),
  ...hex('01 08 02 04 0b 16 0c 12 18 24'),
  ...hex('03 01 06'),
  ...hex('30 14 01 00 00 0f ac 04 01 00 00 0f ac 04 01 00 00 0f ac 02 00 00'),
  ...hex('32 02 30 48'),
  ...hex('dd 0a 02 4e 46 01 01 01 01 02 01 01'),
  ...hex('97 78 62 5b'),
];

/** Acknowledgement (control, addr1 only). */
const ACK: number[] = [...hex('d4 00 00 00 00 1f 00 00 00 21'), ...hex('48 57 a9 1b')];

/** Association response status 0 aid 1 with an rssiDbm -48 annotation. */
const ASSOC_RESP: number[] = [
  ...hex('10 00 00 00 00 1f 00 00 00 21 00 1f 00 00 00 10 00 1f 00 00 00 10 20 00'),
  ...hex('11 00 00 00 01 c0'),
  ...hex('dd 08 02 4e 46 01 03 02 d0 ff'),
  ...hex('fb 0b 8a 45'),
];

const keepaliveSpecs = (): LayerSpec[] => [
  { proto: 'hdlc', fields: { address: HDLC_ADDRESS_BROADCAST, control: 0, protocol: HDLC_PROTO_KEEPALIVE } },
  { proto: 'payload', fields: { data: new Uint8Array(hex('00 00 00 01 00 00 00 00 ff ff 00 00')) } },
];

const hdlcIpv4Specs = (): LayerSpec[] => [
  { proto: 'hdlc', fields: { protocol: ETHERTYPE_IPV4 } },
  { proto: 'ipv4', fields: { src: '10.0.0.1', dst: '10.0.0.2', protocol: IPPROTO_ICMP, ttl: 255 } },
  { proto: 'icmpv4', fields: { type: ICMP_ECHO_REQUEST, code: 0, id: 1, seq: 1 } },
  { proto: 'payload', fields: { data: new Uint8Array([1, 2, 3, 4]) } },
];

const probeReqSpecs = (): LayerSpec[] => [
  { proto: 'dot11', fields: { frameType: 'mgmt', subtype: 'probe-req', addr1: BCAST, addr2: STA, addr3: BCAST, seq: 5 } },
  { proto: 'dot11-mgmt', fields: { ssid: 'LAB', rates: '1,2,5.5,11', band: '2.4' } },
];

const eapolSpecs = (): LayerSpec[] => [
  { proto: 'dot11', fields: { frameType: 'data', subtype: 'data', toDs: true, addr1: AP, addr2: STA, addr3: AP, seq: 1 } },
  { proto: 'llc', fields: { type: ETHERTYPE_EAPOL } },
  { proto: 'eapol', fields: { keyType: 'pairwise', handshakeStep: 2, replayCounter: 1, mic: true, keyData: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) } },
];

const beaconSpecs = (): LayerSpec[] => [
  { proto: 'dot11', fields: { frameType: 'mgmt', subtype: 'beacon', addr1: BCAST, addr2: AP, addr3: AP } },
  {
    proto: 'dot11-mgmt',
    fields: { ssid: 'LAB', beaconIntervalMs: 100, capability: 0x0011, channel: 6, rates: '1,2,5.5,11,6,9,12,18,24,36', security: 'wpa2-psk', band: '2.4' },
  },
];

const assocRespSpecs = (): LayerSpec[] => [
  { proto: 'dot11', fields: { frameType: 'mgmt', subtype: 'assoc-resp', addr1: STA, addr2: AP, addr3: AP, seq: 2 } },
  { proto: 'dot11-mgmt', fields: { capability: 0x0011, statusCode: 0, aid: 1, rssiDbm: -48 } },
];

describe('link codecs registration', () => {
  it('registers hdlc, dot11, dot11-mgmt, llc and eapol after the P0 codecs', () => {
    expect([...CODECS.keys()].slice(5, 10)).toEqual(['hdlc', 'dot11', 'dot11-mgmt', 'llc', 'eapol']); // P1 codecs follow (§9.2)
    expect(getCodec('hdlc')).toBe(hdlcCodec);
    expect(getCodec('dot11')).toBe(dot11Codec);
    expect(getCodec('dot11-mgmt')).toBe(dot11MgmtCodec);
    expect(getCodec('llc')).toBe(llcCodec);
    expect(getCodec('eapol')).toBe(eapolCodec);
  });

  it('every decoded field name is a PROTO_FIELDS key of its protocol', () => {
    const frames: [number[], string][] = [
      [HDLC_KEEPALIVE, 'hdlc'], [HDLC_IPV4, 'hdlc'], [PROBE_REQ, 'dot11'], [EAPOL_MSG2, 'dot11'],
      [BEACON, 'dot11'], [ACK, 'dot11'], [ASSOC_RESP, 'dot11'],
    ];
    for (const [bytes, outer] of frames) {
      for (const layer of decodeLayers(new Uint8Array(bytes), outer)) {
        const names = new Set(PROTO_FIELDS[layer.proto]!.fields.map((f) => f.name));
        for (const key of Object.keys(layer.fields)) expect(names.has(key), `${layer.proto}.${key}`).toBe(true);
        for (const key of Object.keys(layer.fieldRanges)) expect(names.has(key), `${layer.proto}.${key} range`).toBe(true);
      }
    }
  });

  it('derived maps and flags match the field tables', () => {
    expect(hdlcCodec.derived).toEqual({ fcs: 'FcsRecompute' });
    expect(dot11Codec.derived).toEqual({ fcs: 'FcsRecompute' });
    expect(llcCodec.transparent).toBe(true);
    expect(dot11Codec.transparent).toBeUndefined();
    expect(Object.isFrozen(eapolCodec.defaults)).toBe(true);
  });
});

describe('hdlc golden frames and FCS', () => {
  it('keepalive build matches the hand-assembled frame; the FCS is CRC-16/X.25 little-endian', () => {
    const bytes = encodeLayers(keepaliveSpecs());
    expect(Array.from(bytes)).toEqual(HDLC_KEEPALIVE);
    expect(readU16LE(bytes, bytes.length - 2)).toBe(crc16X25(bytes, 0, bytes.length - 2));
  });

  it('keepalive decodes with the protocol undispatched (payload) and summarizes as a keepalive', () => {
    const layers = decodeLayers(new Uint8Array(HDLC_KEEPALIVE), 'hdlc');
    expect(protos(layers)).toEqual(['hdlc', 'payload']);
    const [h, pl] = layers;
    expect(h!.fields).toEqual({ address: 0x8f, control: 0, protocol: 0x8035, fcs: 0x5d50, fcsValid: true });
    expect(h!.headerLength).toBe(4);
    expect(h!.length).toBe(18);
    expect(h!.trailerLength).toBe(2);
    expect(h!.fieldRanges).toEqual({ address: [0, 1], control: [1, 1], protocol: [2, 2], fcs: [16, 2] });
    expect(pl!.offset).toBe(4);
    expect(pl!.length).toBe(12);
    const pdu = createPduFactory().decode(new Uint8Array(HDLC_KEEPALIVE), meta(), 'hdlc');
    expect(pdu.summary()).toBe('HDLC keepalive address=0x8f');
    expect(pdu.topProto()).toBe('hdlc');
  });

  it('IPv4 over HDLC matches the golden frame and chains through the ethertype table', () => {
    expect(Array.from(encodeLayers(hdlcIpv4Specs()))).toEqual(HDLC_IPV4);
    const layers = decodeLayers(new Uint8Array(HDLC_IPV4), 'hdlc');
    expect(protos(layers)).toEqual(['hdlc', 'ipv4', 'icmpv4', 'payload']);
    expect(layers[0]!.fields).toMatchObject({ address: 0x0f, control: 0, protocol: 0x0800, fcsValid: true });
    expect(layers[1]!.fields).toMatchObject({ ttl: 255, checksumValid: true, totalLength: 32 });
    expect(layers[2]!.fields).toMatchObject({ checksumValid: true, id: 1, seq: 1 });
    expect(layers[0]!.trailerLength).toBe(2);
    const pdu = createPduFactory().decode(new Uint8Array(HDLC_IPV4), meta(), 'hdlc');
    expect(pdu.summary()).toBe('ICMP echo request 10.0.0.1 > 10.0.0.2 id=1 seq=1');
  });

  it('protocol is filled from the inner layer; address defaults to unicast 0x0f', () => {
    const specs = hdlcIpv4Specs();
    specs[0] = { proto: 'hdlc', fields: {} };
    expect(Array.from(encodeLayers(specs))).toEqual(HDLC_IPV4);
    expect(() => encodeLayers([{ proto: 'hdlc', fields: {} }])).toThrow(/hdlc\.protocol/);
    expect(() => hdlcCodec.encode({ protocol: 0x10000 }, new Uint8Array(0))).toThrow(/out of range/);
    expect(() => hdlcCodec.encode({ protocol: 0x0800, address: 256 }, new Uint8Array(0))).toThrow(/out of range/);
  });

  it('a flipped bit fails the FCS; truncations report errors', () => {
    const bad = new Uint8Array(HDLC_IPV4);
    bad[20] = bad[20]! ^ 0x01;
    expect(decodeLayers(bad, 'hdlc')[0]!.fields.fcsValid).toBe(false);
    const short = hdlcCodec.decode(new Uint8Array([0x0f, 0x00, 0x08]), 0, 3);
    expect(short.error).toMatch(/header truncated/);
    expect(short.fields).toEqual({ address: 0x0f, control: 0 });
    const noFcs = hdlcCodec.decode(new Uint8Array([0x0f, 0x00, 0x08, 0x00, 0x45]), 0, 5);
    expect(noFcs.error).toMatch(/no FCS/);
    expect(noFcs.next).toBeUndefined();
  });

  it('fixTrailer puts bytes past the inner layer into the trailer, idempotently', () => {
    const inner = encodeLayers(hdlcIpv4Specs().slice(1));
    const frame = hdlcCodec.encode({ protocol: ETHERTYPE_IPV4 }, new Uint8Array([...inner, 0xee, 0xee]));
    const layers = decodeLayers(frame, 'hdlc');
    expect(layers[0]!.trailerLength).toBe(4);
    expect(layers[1]!.length).toBe(32);
    expect(hdlcCodec.fixTrailer!(layers[0]!, layers[1])).toEqual(layers[0]);
    expect(hdlcCodec.fixTrailer!(layers[0]!, undefined)).toBe(layers[0]);
  });
});

describe('dot11 golden frames and FCS', () => {
  it('probe request build matches the golden frame; the FCS is CRC-32 little-endian', () => {
    const bytes = encodeLayers(probeReqSpecs());
    expect(Array.from(bytes)).toEqual(PROBE_REQ);
    expect(readU32LE(bytes, bytes.length - 4)).toBe(crc32(bytes, 0, bytes.length - 4));
  });

  it('probe request decodes header, elements and field ranges', () => {
    const layers = decodeLayers(new Uint8Array(PROBE_REQ), 'dot11');
    expect(protos(layers)).toEqual(['dot11', 'dot11-mgmt']);
    const [h, m] = layers;
    expect(h!.fields).toEqual({
      frameType: 'mgmt', subtype: 'probe-req', toDs: false, fromDs: false, retry: false, protected: false,
      duration: 0, addr1: BCAST, addr2: STA, addr3: BCAST, seq: 5, fcs: 0x6ff199c2, fcsValid: true,
    });
    expect(h!.headerLength).toBe(24);
    expect(h!.trailerLength).toBe(4);
    expect(h!.length).toBe(PROBE_REQ.length);
    expect(h!.fieldRanges.addr2).toEqual([10, 6]);
    expect(h!.fieldRanges.seq).toEqual([22, 2]);
    expect(h!.fieldRanges.fcs).toEqual([44, 4]);
    expect(m!.fields).toEqual({ bssid: BCAST, ssid: 'LAB', rates: '1,2,5.5,11', band: '2.4' });
    expect(m!.offset).toBe(24);
    expect(m!.length).toBe(20);
    expect(m!.headerLength).toBe(20);
    expect(m!.fieldRanges.ssid).toEqual([26, 3]);
    expect(m!.fieldRanges.rates).toEqual([31, 4]);
    expect(m!.fieldRanges.band).toEqual([43, 1]);
    const pdu = createPduFactory().decode(new Uint8Array(PROBE_REQ), meta(), 'dot11');
    expect(pdu.summary()).toBe('802.11 probe request SSID "LAB"');
    expect(pdu.topProto()).toBe('dot11-mgmt');
  });

  it('beacon with extended rates, RSN and the simulation element round-trips byte-exact', () => {
    const bytes = encodeLayers(beaconSpecs());
    expect(Array.from(bytes)).toEqual(BEACON);
    const [h, m] = decodeLayers(bytes, 'dot11');
    expect(h!.fields).toMatchObject({ frameType: 'mgmt', subtype: 'beacon', addr2: AP, fcsValid: true });
    expect(m!.fields).toEqual({
      bssid: AP, beaconIntervalMs: 100, capability: 0x0011, ssid: 'LAB', rates: '1,2,5.5,11,6,9,12,18,24,36',
      channel: 6, security: 'wpa2-psk', band: '2.4',
    });
    expect(m!.fieldRanges.beaconIntervalMs).toEqual([32, 2]);
    expect(m!.fieldRanges.channel).toEqual([53, 1]);
    const pdu = createPduFactory().decode(bytes, meta(), 'dot11');
    expect(pdu.summary()).toBe('802.11 beacon SSID "LAB" channel 6');
  });

  it('security falls back to the RSN AKM when the simulation element is absent', () => {
    const beacon = BEACON.slice(0, BEACON.length - 4 - 12);
    const layers = dot11MgmtCodec.decode(new Uint8Array(beacon), 24, beacon.length - 24, {
      outer: [{ proto: 'dot11', fields: { subtype: 'beacon', addr3: AP } }],
    });
    expect(layers.fields.security).toBe('wpa2-psk');
    expect(layers.fields.band).toBeUndefined();
    expect(layers.fieldRanges.security).toEqual([56, 20]);
    for (const [security, akm] of [['wpa2-ent', 1], ['wpa3-sae', 8]] as const) {
      const body = dot11MgmtCodec.encode({ security }, new Uint8Array(0));
      expect(body[0]).toBe(48);
      expect(body[2 + 17]).toBe(akm);
    }
    const open = dot11MgmtCodec.encode({ security: 'open' }, new Uint8Array(0));
    expect(Array.from(open)).toEqual(hex('dd 07 02 4e 46 01 02 01 00'));
  });

  it('EAPOL message 2 in a to-DS data frame matches the golden frame', () => {
    const bytes = encodeLayers(eapolSpecs());
    expect(bytes.length).toBe(139);
    expect(Array.from(bytes)).toEqual(EAPOL_MSG2);
    const layers = decodeLayers(bytes, 'dot11');
    expect(protos(layers)).toEqual(['dot11', 'llc', 'eapol']);
    const [h, l, e] = layers;
    expect(h!.fields).toMatchObject({ frameType: 'data', subtype: 'data', toDs: true, fromDs: false, addr1: AP, addr2: STA, addr3: AP, seq: 1, fcsValid: true });
    expect(l!.fields).toEqual({ dsap: 0xaa, ssap: 0xaa, control: 3, oui: 0, type: 0x888e });
    expect(l!.offset).toBe(24);
    expect(l!.length).toBe(8 + 103);
    expect(e!.fields).toEqual({
      version: 2, packetType: 3, keyType: 'pairwise', replayCounter: 1, mic: true,
      keyData: new Uint8Array([0xde, 0xad, 0xbe, 0xef]), handshakeStep: 2,
    });
    expect(e!.offset).toBe(32);
    expect(e!.length).toBe(103);
    expect(e!.fieldRanges.handshakeStep).toEqual([37, 2]);
    expect(e!.fieldRanges.keyData).toEqual([131, 4]);
    const pdu = createPduFactory().decode(bytes, meta(), 'dot11');
    expect(pdu.topProto()).toBe('eapol');
    expect(pdu.summary()).toBe('EAPOL key message 2 of 4');
    expect(pdu.get('llc.type')).toBe(ETHERTYPE_EAPOL);
  });

  it('llc.type is filled from the inner layer name', () => {
    const specs = eapolSpecs();
    specs[1] = { proto: 'llc', fields: {} };
    expect(Array.from(encodeLayers(specs))).toEqual(EAPOL_MSG2);
  });

  it('control frames: ack carries addr1 only and ends the chain', () => {
    const bytes = encodeLayers([{ proto: 'dot11', fields: { frameType: 'ctrl', subtype: 'ack', addr1: STA } }]);
    expect(Array.from(bytes)).toEqual(ACK);
    const layers = decodeLayers(bytes, 'dot11');
    expect(protos(layers)).toEqual(['dot11']);
    expect(layers[0]!.fields).toEqual({
      frameType: 'ctrl', subtype: 'ack', toDs: false, fromDs: false, retry: false, protected: false,
      duration: 0, addr1: STA, fcs: 0x1ba95748, fcsValid: true,
    });
    expect(layers[0]!.headerLength).toBe(10);
    const rts = encodeLayers([{ proto: 'dot11', fields: { frameType: 'ctrl', subtype: 'rts', addr1: AP, addr2: STA, duration: 300 } }]);
    expect(rts.length).toBe(20);
    expect(decodeLayers(rts, 'dot11')[0]!.fields).toMatchObject({ subtype: 'rts', addr1: AP, addr2: STA, duration: 300 });
    expect(() => dot11Codec.encode({ frameType: 'ctrl', subtype: 'ack', addr1: STA }, new Uint8Array(1))).toThrow(/no body/);
    expect(createPduFactory().decode(bytes, meta(), 'dot11').summary()).toBe(`802.11 acknowledgement ${STA}`);
  });

  it('association response carries status, aid (top bits set on the wire) and the rssi annotation', () => {
    const bytes = encodeLayers(assocRespSpecs());
    expect(Array.from(bytes)).toEqual(ASSOC_RESP);
    const [, m] = decodeLayers(bytes, 'dot11');
    expect(m!.fields).toEqual({ bssid: AP, capability: 0x0011, statusCode: 0, aid: 1, rssiDbm: -48 });
    const pdu = createPduFactory().decode(bytes, meta(), 'dot11');
    expect(pdu.summary()).toBe('802.11 association response status 0 aid 1');
  });

  it('fixed fields follow the subtype: auth, deauth, disassoc, assoc-req and reassoc-req', () => {
    const f = createPduFactory();
    const header = (subtype: string, from = STA, to = AP): LayerSpec => ({
      proto: 'dot11', fields: { frameType: 'mgmt', subtype, addr1: to, addr2: from, addr3: AP },
    });
    const auth = f.build([header('auth'), { proto: 'dot11-mgmt', fields: { authAlgorithm: 3, authSeq: 2, statusCode: 1 } }], meta());
    expect(auth.layer('dot11-mgmt')!.fields).toEqual({ bssid: AP, authAlgorithm: 3, authSeq: 2, statusCode: 1 });
    expect(auth.layer('dot11-mgmt')!.length).toBe(6);
    expect(auth.summary()).toBe('802.11 authentication (SAE) seq 2 status 1');

    const deauth = f.build([header('deauth', AP, STA), { proto: 'dot11-mgmt', fields: { reasonCode: 15 } }], meta());
    expect(deauth.layer('dot11-mgmt')!.fields).toEqual({ bssid: AP, reasonCode: 15 });
    expect(deauth.summary()).toBe('802.11 deauthentication reason 15');
    const disassoc = f.build([header('disassoc'), { proto: 'dot11-mgmt', fields: { reasonCode: 8 } }], meta());
    expect(disassoc.summary()).toBe('802.11 disassociation reason 8');

    const assoc = f.build([header('assoc-req'), { proto: 'dot11-mgmt', fields: { capability: 1, ssid: 'LAB', rates: '6,54' } }], meta());
    expect(assoc.layer('dot11-mgmt')!.fields).toEqual({ bssid: AP, capability: 1, ssid: 'LAB', rates: '6,54' });
    expect(assoc.summary()).toBe('802.11 association request SSID "LAB"');

    const OLD = '00:1f:00:00:00:99';
    const reassoc = f.build([header('reassoc-req'), { proto: 'dot11-mgmt', fields: { capability: 1, bssid: OLD, ssid: 'LAB' } }], meta());
    expect(reassoc.layer('dot11-mgmt')!.fields).toEqual({ capability: 1, bssid: OLD, ssid: 'LAB' });

    const probe = f.build([header('probe-req', STA, BCAST), { proto: 'dot11-mgmt', fields: { ssid: '' } }], meta());
    expect(probe.summary()).toBe('802.11 probe request for any SSID');

    const action = f.build([header('action'), { proto: 'dot11-mgmt', fields: { ssid: 'ignored' } }], meta());
    expect(action.layer('dot11-mgmt')!.fields).toEqual({ bssid: AP });
    expect(action.layer('dot11-mgmt')!.length).toBe(0);
  });

  it('qos-data adds the QoS control field; data frames chain to llc only with a body', () => {
    const qos = encodeLayers([
      { proto: 'dot11', fields: { frameType: 'data', subtype: 'qos-data', fromDs: true, addr1: STA, addr2: AP, addr3: AP, retry: true, protected: true } },
      { proto: 'llc', fields: { type: ETHERTYPE_IPV4 } },
      ...hdlcIpv4Specs().slice(1),
    ]);
    const layers = decodeLayers(qos, 'dot11');
    expect(protos(layers)).toEqual(['dot11', 'llc', 'ipv4', 'icmpv4', 'payload']);
    expect(layers[0]!.headerLength).toBe(26);
    expect(layers[0]!.fields).toMatchObject({ subtype: 'qos-data', fromDs: true, retry: true, protected: true });
    expect(layers[1]!.offset).toBe(26);
    const pdu = createPduFactory().decode(qos, meta(), 'dot11');
    expect(pdu.topProto()).toBe('icmpv4');

    const empty = encodeLayers([{ proto: 'dot11', fields: { frameType: 'data', subtype: 'data', addr1: STA, addr2: AP, addr3: AP } }]);
    expect(protos(decodeLayers(empty, 'dot11'))).toEqual(['dot11']);
    expect(createPduFactory().decode(empty, meta(), 'dot11').summary()).toBe(`802.11 data ${AP} > ${STA}`);
  });

  it('subtype names map both ways, including unnamed numbers', () => {
    for (const name of Object.keys(DOT11_SUBTYPES)) {
      const info = DOT11_SUBTYPES[name]!;
      expect(dot11SubtypeName(info.frameType, info.code)).toBe(name);
      expect(dot11SubtypeInfo(name)).toEqual(info);
    }
    expect(dot11SubtypeName('mgmt', 14)).toBe('unknown-mgmt-14');
    expect(dot11SubtypeInfo('unknown-ctrl-9')).toEqual({ frameType: 'ctrl', code: 9 });
    expect(dot11SubtypeInfo('unknown-ctrl-16')).toBeUndefined();
    expect(dot11SubtypeInfo('toString')).toBeUndefined();
    const raw = new Uint8Array([0xe0, 0x00, 0, 0, ...new Array<number>(20).fill(0), 0, 0, 0, 0]);
    const fixed = new Uint8Array(raw);
    const crc = crc32(fixed, 0, 24);
    fixed.set([crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, crc >>> 24], 24);
    const [h, m] = decodeLayers(fixed, 'dot11');
    expect(h!.fields.subtype).toBe('unknown-mgmt-14');
    expect(m!.proto).toBe('dot11-mgmt');
    expect(Array.from(encodeLayers([
      { proto: 'dot11', fields: { ...h!.fields } },
      { proto: 'dot11-mgmt', fields: {} },
    ]))).toEqual(Array.from(fixed));
  });

  it('encode validation and decode errors', () => {
    const base = { frameType: 'data', subtype: 'data', addr1: STA, addr2: AP, addr3: AP };
    expect(() => dot11Codec.encode({ ...base, subtype: 'nope' }, new Uint8Array(0))).toThrow(/subtype unknown/);
    expect(() => dot11Codec.encode({ ...base, frameType: 'mgmt' }, new Uint8Array(0))).toThrow(/is a data frame/);
    expect(() => dot11Codec.encode({ ...base, frameType: 'bogus' }, new Uint8Array(0))).toThrow(/frameType unknown/);
    expect(() => dot11Codec.encode({ ...base, toDs: true, fromDs: true }, new Uint8Array(0))).toThrow(/WDS/);
    expect(() => dot11Codec.encode({ ...base, seq: 4096 }, new Uint8Array(0))).toThrow(/seq out of range/);
    expect(() => dot11Codec.encode({ ...base, addr3: undefined as unknown as string }, new Uint8Array(0))).toThrow(/dot11\.addr3/);
    expect(() => dot11Codec.encode(base, new Uint8Array(2400))).toThrow(/too large/);

    const wds = new Uint8Array(EAPOL_MSG2);
    wds[1] = 0x03;
    const wdsLayer = dot11Codec.decode(wds, 0, wds.length);
    expect(wdsLayer.error).toMatch(/WDS/);
    expect(wdsLayer.next).toBeUndefined();
    expect(dot11Codec.decode(new Uint8Array([0x0c, 0x00]), 0, 2).error).toMatch(/reserved frame type/);
    expect(dot11Codec.decode(new Uint8Array([0x81, 0x00, 0, 0]), 0, 4).error).toMatch(/protocol version 1/);
    const truncated = dot11Codec.decode(new Uint8Array(PROBE_REQ.slice(0, 12)), 0, 12);
    expect(truncated.error).toMatch(/header truncated/);
    expect(truncated.fields.addr1).toBe(BCAST);
    expect(truncated.fields.addr2).toBeUndefined();
    expect(dot11Codec.decode(new Uint8Array(PROBE_REQ.slice(0, 26)), 0, 26).error).toMatch(/no FCS/);

    const corrupt = new Uint8Array(PROBE_REQ);
    corrupt[27] = corrupt[27]! ^ 0x20;
    const [h, m] = decodeLayers(corrupt, 'dot11');
    expect(h!.fields.fcsValid).toBe(false);
    expect(m!.fields.ssid).toBe('LaB');
  });

  it('dot11-mgmt encode validation and malformed elements', () => {
    const ctx = { outer: [{ proto: 'dot11', fields: { subtype: 'probe-req' } }] };
    expect(() => dot11MgmtCodec.encode({ ssid: 'x'.repeat(33) }, new Uint8Array(0), ctx)).toThrow(/32 bytes/);
    expect(() => dot11MgmtCodec.encode({ rates: '1,fast' }, new Uint8Array(0), ctx)).toThrow(/not a rate/);
    expect(() => dot11MgmtCodec.encode({ rates: '0.3' }, new Uint8Array(0), ctx)).toThrow(/multiple of 0\.5/);
    expect(() => dot11MgmtCodec.encode({ band: '3.6' }, new Uint8Array(0), ctx)).toThrow(/band unknown/);
    expect(() => dot11MgmtCodec.encode({ security: 'wep' }, new Uint8Array(0), ctx)).toThrow(/security unknown/);
    expect(() => dot11MgmtCodec.encode({ rssiDbm: 40000 }, new Uint8Array(0), ctx)).toThrow(/rssiDbm out of range/);
    expect(() => dot11MgmtCodec.encode({}, new Uint8Array(1), ctx)).toThrow(/no inner layer/);
    expect(() => dot11MgmtCodec.encode({ aid: 3000 }, new Uint8Array(0), { outer: [{ proto: 'dot11', fields: { subtype: 'assoc-resp' } }] })).toThrow(/aid out of range/);

    const multibyte = dot11MgmtCodec.encode({ ssid: 'café' }, new Uint8Array(0), ctx);
    expect(multibyte[1]).toBe(5);
    expect(dot11MgmtCodec.decode(multibyte, 0, multibyte.length, ctx).fields.ssid).toBe('café');

    const overrun = new Uint8Array([0x00, 0x09, 0x4c, 0x41]);
    const d = dot11MgmtCodec.decode(overrun, 0, overrun.length, ctx);
    expect(d.error).toMatch(/element 0 truncated/);
    const unknownElement = new Uint8Array([0x07, 0x02, 0x55, 0x53, 0x00, 0x01, 0x41]);
    expect(dot11MgmtCodec.decode(unknownElement, 0, unknownElement.length, ctx).fields).toEqual({ ssid: 'A' });
    const shortFixed = dot11MgmtCodec.decode(new Uint8Array([1, 0]), 0, 2, { outer: [{ proto: 'dot11', fields: { subtype: 'auth' } }] });
    expect(shortFixed.error).toMatch(/fixed fields truncated/);
    expect(dot11MgmtCodec.summarize({ ssid: 'LAB' })).toBe('802.11 management frame SSID "LAB"');
  });
});

describe('eapol codec', () => {
  it('the four pairwise and two group steps round-trip through key information', () => {
    for (const step of [1, 2, 3, 4]) {
      const ki = eapolKeyInformation('pairwise', step);
      expect(eapolStepOf(ki)).toBe(step);
      const bytes = eapolCodec.encode({ handshakeStep: step, replayCounter: step }, new Uint8Array(0));
      const d = eapolCodec.decode(bytes, 0, bytes.length);
      expect(d.error).toBeUndefined();
      expect(d.fields.handshakeStep).toBe(step);
      expect(d.fields.keyType).toBe('pairwise');
      expect(d.fields.mic).toBe(step === 1 ? undefined : true);
      expect(eapolCodec.summarize(d.fields)).toBe(`EAPOL key message ${step} of 4`);
    }
    for (const step of [1, 2]) {
      const bytes = eapolCodec.encode({ keyType: 'group', handshakeStep: step }, new Uint8Array(0));
      const d = eapolCodec.decode(bytes, 0, bytes.length);
      expect(d.fields).toMatchObject({ keyType: 'group', handshakeStep: step, mic: true });
      expect(bytes[4 + 4]).toBe(0); // group key length 0
      expect(eapolCodec.summarize(d.fields)).toBe(`EAPOL group key message ${step} of 2`);
    }
    expect(eapolKeyInformation('pairwise', 3)).toBe(0x13ca);
    expect(() => eapolKeyInformation('group', 3)).toThrow(/outside the group handshake/);
    expect(() => eapolCodec.encode({}, new Uint8Array(0))).toThrow(/eapol\.handshakeStep/);
    expect(eapolStepOf(0x0002 | 0x0008)).toBeUndefined();
    expect(eapolStepOf(0x0002)).toBeUndefined();
  });

  it('mic false encodes zero MIC bytes; large replay counters and non-key packets', () => {
    const bad = eapolCodec.encode({ handshakeStep: 2, mic: false }, new Uint8Array(0));
    expect(eapolCodec.decode(bad, 0, bad.length).fields.mic).toBe(false);
    const big = 2 ** 40 + 7;
    const b = eapolCodec.encode({ handshakeStep: 4, replayCounter: big }, new Uint8Array(0));
    expect(eapolCodec.decode(b, 0, b.length).fields.replayCounter).toBe(big);
    expect(() => eapolCodec.encode({ handshakeStep: 1, replayCounter: -1 }, new Uint8Array(0))).toThrow(/replayCounter/);
    expect(() => eapolCodec.encode({ keyType: 'both', handshakeStep: 1 }, new Uint8Array(0))).toThrow(/keyType/);
    expect(() => eapolCodec.encode({ handshakeStep: 1 }, new Uint8Array(1))).toThrow(/no inner layer/);

    const start = eapolCodec.encode({ packetType: 1 }, new Uint8Array(0));
    expect(Array.from(start)).toEqual([2, 1, 0, 0]);
    expect(eapolCodec.decode(start, 0, start.length).fields).toEqual({ version: 2, packetType: 1 });
    expect(eapolCodec.summarize({ packetType: 1 })).toBe('EAPOL packet type 1');
  });

  it('decode errors: truncation, descriptor type, unknown key information', () => {
    expect(eapolCodec.decode(new Uint8Array([2, 3]), 0, 2).error).toMatch(/header truncated/);
    expect(eapolCodec.decode(new Uint8Array([2, 3, 0, 99, 2]), 0, 5).error).toMatch(/body truncated/);
    expect(eapolCodec.decode(new Uint8Array([2, 3, 0, 1, 2]), 0, 5).error).toMatch(/descriptor truncated/);
    const bytes = eapolCodec.encode({ handshakeStep: 2 }, new Uint8Array(0));
    const wpa = bytes.slice();
    wpa[4] = 254;
    expect(eapolCodec.decode(wpa, 0, wpa.length).error).toMatch(/descriptor type 254/);
    const odd = bytes.slice();
    odd[5] = 0x00;
    odd[6] = 0x0a; // pairwise without ACK or MIC
    const d = eapolCodec.decode(odd, 0, odd.length);
    expect(d.error).toMatch(/not a handshake step/);
    expect(d.fields.handshakeStep).toBeUndefined();
    const longKd = bytes.slice();
    longKd[4 + 94] = 9;
    expect(eapolCodec.decode(longKd, 0, longKd.length).error).toMatch(/key data truncated/);
  });

  it('EAPOL over Ethernet dispatches by ethertype and ethernet padding is not attributed to it', () => {
    const bytes = encodeLayers([
      { proto: 'ethernet', fields: { dst: AP, src: STA } },
      { proto: 'eapol', fields: { handshakeStep: 1 } },
    ]);
    const [eth, e] = decodeLayers(bytes);
    expect(eth!.fields.type).toBe(ETHERTYPE_EAPOL);
    expect(eth!.fields.padding).toBe(0);
    expect(e!.length).toBe(99);
  });
});

describe('llc codec', () => {
  it('decodes non-SNAP headers by their DSAP (P2 §9 item 5), reports truncation and validates ranges', () => {
    const stp = llcCodec.decode(new Uint8Array([0x42, 0x42, 0x03, 0, 0, 0, 0x08, 0x00]), 0, 8);
    expect(stp.error).toBeUndefined();
    expect(stp.fields).toEqual({ dsap: 0x42, ssap: 0x42, control: 3 });
    expect(stp.next).toEqual({ proto: 'stp', offset: 3, length: 5 });
    const unregistered = llcCodec.decode(new Uint8Array([0xf0, 0xf0, 0x03, 0, 0, 0, 0x08, 0x00]), 0, 8);
    expect(unregistered.error).toBeUndefined();
    expect(unregistered.fields).toEqual({ dsap: 0xf0, ssap: 0xf0, control: 3 });
    expect(unregistered.next).toBeUndefined();
    expect(llcCodec.decode(new Uint8Array([0xaa, 0xaa]), 0, 2).error).toMatch(/truncated/);
    expect(() => llcCodec.encode({}, new Uint8Array(0))).toThrow(/llc\.type/);
    expect(() => llcCodec.encode({ type: 0x0800, oui: 0x1000000 }, new Uint8Array(0))).toThrow(/oui out of range/);
    expect(Array.from(llcCodec.encode({ type: 0x0800, oui: 0x00f00d }, new Uint8Array([9])))).toEqual([0xaa, 0xaa, 3, 0x00, 0xf0, 0x0d, 0x08, 0x00, 9]);
    expect(llcCodec.summarize({ type: 0x0806 })).toBe('LLC/SNAP type=0x0806');
  });

  it('fixTrailer gives slack after the inner layer to the 802.11 trailer', () => {
    const packet = encodeLayers(hdlcIpv4Specs().slice(1));
    const withJunk = encodeLayers([
      { proto: 'dot11', fields: { frameType: 'data', subtype: 'data', toDs: true, addr1: AP, addr2: STA, addr3: AP } },
      { proto: 'payload', fields: { data: new Uint8Array([0xaa, 0xaa, 0x03, 0, 0, 0, 0x08, 0x00, ...packet, 0xee, 0xee, 0xee]) } },
    ]);
    const layers = decodeLayers(withJunk, 'dot11');
    expect(protos(layers)).toEqual(['dot11', 'llc', 'ipv4', 'icmpv4', 'payload']);
    expect(layers[1]!.length).toBe(8 + 32);
    expect(layers[0]!.trailerLength).toBe(3 + 4);
    expect(llcCodec.fixTrailer!(layers[1]!, layers[2])).toBe(layers[1]);
    expect(dot11Codec.fixTrailer!(layers[0]!, layers[1])).toEqual(layers[0]);
  });
});

describe('link codecs through the PDU write paths', () => {
  it('mutate on hdlc and dot11 records FcsRecompute and keeps the FCS valid', () => {
    const f = createPduFactory();
    const h = f.build(hdlcIpv4Specs(), meta());
    h.mutate(mctx(), 'ipv4.ttl', 254, 'TtlDecrement', 'route');
    expect(h.provenance.map((m) => `${m.reason}:${m.field}`)).toEqual(['TtlDecrement:ipv4.ttl', 'ChecksumRecompute:ipv4.checksum', 'FcsRecompute:hdlc.fcs']);
    expect(h.get('hdlc.fcsValid')).toBe(true);
    expect(h.size).toBe(HDLC_IPV4.length);

    const w = f.build(assocRespSpecs(), meta());
    w.mutate(mctx('d_ap1'), 'dot11-mgmt.rssiDbm', -60, 'Other', 'air annotation');
    expect(w.get('dot11-mgmt.rssiDbm')).toBe(-60);
    expect(w.get('dot11-mgmt.aid')).toBe(1);
    expect(w.get('dot11.fcsValid')).toBe(true);
    expect(w.provenance.map((m) => `${m.reason}:${m.field}`)).toEqual(['Other:dot11-mgmt.rssiDbm', 'FcsRecompute:dot11.fcs']);
  });

  it('rewrap ethernet → dot11 + llc and back keeps the packet, the id and the provenance order', () => {
    const f = createPduFactory();
    const p = f.build([
      { proto: 'ethernet', fields: { dst: AP, src: STA, type: ETHERTYPE_IPV4 } },
      ...hdlcIpv4Specs().slice(1),
    ], meta());
    const id = p.id;
    const packet = p.bytes.slice(14, 14 + 32);

    p.rewrap(mctx('d_lap1'), {
      strip: 1,
      push: [
        { proto: 'dot11', fields: { frameType: 'data', subtype: 'data', toDs: true, addr1: AP, addr2: STA, addr3: AP } },
        { proto: 'llc', fields: {} },
      ],
    }, 'wireless client framing');
    expect(p.id).toBe(id);
    expect(protos(p.layers)).toEqual(['dot11', 'llc', 'ipv4', 'icmpv4', 'payload']);
    expect(p.size).toBe(24 + 8 + 32 + 4);
    expect(p.get('llc.type')).toBe(ETHERTYPE_IPV4);
    expect(p.get('dot11.fcsValid')).toBe(true);
    expect(p.topProto()).toBe('icmpv4');

    p.rewrap(mctx('d_ap1'), { strip: 2, push: [{ proto: 'ethernet', fields: { dst: AP, src: STA } }] }, 'access point bridging');
    expect(protos(p.layers)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'payload']);
    expect(p.size).toBe(64);
    expect(p.bytes.slice(14, 14 + 32)).toEqual(packet);
    expect(p.provenance.map((m) => `${m.device}:${m.reason}:${m.field}`)).toEqual([
      'd_lap1:Decapsulate:ethernet',
      'd_lap1:Encapsulate:llc',
      'd_lap1:Encapsulate:dot11',
      'd_ap1:Decapsulate:dot11',
      'd_ap1:Decapsulate:llc',
      'd_ap1:Encapsulate:ethernet',
    ]);
  });

  it('rewrap ethernet ↔ hdlc at a router never carries padding or FCS across', () => {
    const f = createPduFactory();
    const p = f.build([
      { proto: 'ethernet', fields: { dst: AP, src: STA, type: ETHERTYPE_IPV4 } },
      ...hdlcIpv4Specs().slice(1),
    ], meta());
    expect(p.size).toBe(64);
    p.rewrap(mctx(), { strip: 1, push: [{ proto: 'hdlc', fields: { address: 0x0f, control: 0 } }] }, 'serial egress');
    expect(Array.from(p.bytes)).toEqual(HDLC_IPV4);
    p.rewrap(mctx(), { strip: 1, push: [{ proto: 'ethernet', fields: { dst: STA, src: AP } }] }, 'ethernet egress');
    expect(p.size).toBe(64);
    expect(p.get('ethernet.padding')).toBe(64 - 4 - 14 - 32);
    expect(p.get('ethernet.fcsValid')).toBe(true);
  });

  it('corrupting an 802.11 frame re-decodes from dot11 and fails the FCS', () => {
    const f = createPduFactory();
    const p = f.build(probeReqSpecs(), meta());
    p.corrupt(mctx(), 30, 0x01);
    expect(p.layers[0]!.proto).toBe('dot11');
    expect(p.get('dot11.fcsValid')).toBe(false);
  });

  it('clones and toJSON stay structured-clone safe for link frames', () => {
    const f = createPduFactory();
    const p = f.build(eapolSpecs(), meta());
    const json = structuredClone(p.toJSON());
    expect(json.summary).toBe('EAPOL key message 2 of 4');
    expect(json.topProto).toBe('eapol');
    expect(json.layers.map((l) => l.proto)).toEqual(['dot11', 'llc', 'eapol']);
    const c = f.clone(p, 10);
    expect(c.bytes).toEqual(p.bytes);
  });
});
