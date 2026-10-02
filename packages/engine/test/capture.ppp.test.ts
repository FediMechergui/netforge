/**
 * W2 capture [S19] (ARCHITECTURE-P3 §7 W2 approved capture item; §9.2 item 30; ruling R4): a port with PPP
 * encapsulation captures as `ppp_hdlc`, pcap link type 50 (PPP in HDLC-like framing, RFC 1662). The 2-byte CRC is
 * stripped as for HDLC (fcsLen 0), rows decode from the `ppp` layer, the PPP family's display fields filter them, and
 * pcap and pcapng exports carry link type 50 and read back. Frames are built by the real PDU factory and recorded by
 * the capture hub with the link type the link model reports for a PPP frame.
 */
import { describe, expect, it } from 'vitest';
import type { PortEncap } from '../src/contracts/catalog.js';
import type { PortRef } from '../src/contracts/ids.js';
import { PCAP_LINKTYPE, PCAP_MIXED_LINKTYPE_MESSAGE, outerForLinkType } from '../src/contracts/capture.js';
import type { CaptureLinkType } from '../src/contracts/capture.js';
import { HDLC_ADDRESS_BROADCAST, HDLC_PROTO_KEEPALIVE, ICMP_ECHO_REQUEST, IPPROTO_ICMP, PPP_PROTO } from '../src/contracts/pdu.js';
import type { LayerSpec, Pdu, PduMeta } from '../src/contracts/pdu.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { PPP_CP_CODE } from '../src/pdu/codecs/ppp.js';
import { CHAP_CODE } from '../src/pdu/codecs/chap.js';
import { PAP_CODE } from '../src/pdu/codecs/pap.js';
import { readCapture, writeCapture } from '../src/io/pcap.js';
import { createCaptureStoreImpl } from '../src/capture/store.js';
import {
  CAPTURE_LIVE_FCS_LEN,
  CAPTURE_STRIP_BYTES,
  captureLinkForEncap,
  createCaptureHub,
  resolveCapturePoints,
  type CapturePointResolver,
} from '../src/capture/tap.js';

const SE0: PortRef = { device: 'd_r1', port: 'Serial0/0/0' };
const meta = (over: Partial<PduMeta> = {}): PduMeta => ({ born: 0, origin: 'd_r1', ...over });
const f = createPduFactory();
const ppp = (inner: LayerSpec, ...rest: LayerSpec[]): Pdu => f.build([{ proto: 'ppp', fields: {} }, inner, ...rest], meta());
const CHALLENGE = Uint8Array.from({ length: 16 }, (_, i) => (i * 17 + 3) & 0xff);

/** The §3.9 bring-up as it crosses R1's serial port: LCP, CHAP, PAP (another lab), IPCP, IPV6CP, then a ping. */
const FRAMES: readonly (readonly [string, () => Pdu])[] = [
  ['lcp', () => ppp({ proto: 'lcp', fields: { code: PPP_CP_CODE.configureRequest, id: 1, authProto: 'chap-md5', magic: 0x1a2b3c4d } })],
  ['chap-challenge', () => ppp({ proto: 'chap', fields: { code: CHAP_CODE.challenge, id: 1, value: CHALLENGE, name: 'R1' } })],
  ['chap-success', () => ppp({ proto: 'chap', fields: { code: CHAP_CODE.success, id: 1, message: 'Welcome' } })],
  ['pap', () => ppp({ proto: 'pap', fields: { code: PAP_CODE.authenticateRequest, id: 2, peerId: 'R1', password: 'NetF0rge' } })],
  ['ipcp', () => ppp({ proto: 'ipcp', fields: { code: PPP_CP_CODE.configureRequest, id: 3, ipAddress: '10.0.12.1' } })],
  ['ipv6cp', () => ppp({ proto: 'ipv6cp', fields: { code: PPP_CP_CODE.configureRequest, id: 4, interfaceId: '0200000000000001' } })],
  ['ping', () => ppp(
    { proto: 'ipv4', fields: { src: '10.0.12.1', dst: '10.0.12.2', ttl: 255, protocol: IPPROTO_ICMP } },
    { proto: 'icmpv4', fields: { type: ICMP_ECHO_REQUEST, code: 0, id: 1, seq: 1 } },
  )],
];

function liveCapture() {
  const hub = createCaptureHub();
  const store = hub.start({}, [{ ref: SE0, name: 'R1 Se0/0/0', ...captureLinkForEncap('ppp') }]);
  const pdus = FRAMES.map(([, make]) => make());
  pdus.forEach((pdu, i) => hub.record({ t: (i + 1) * 1_000_000, dir: i % 2 === 0 ? 'tx' : 'rx', port: SE0, pdu, linkType: 'ppp_hdlc' }));
  return { hub, store, pdus };
}

describe('PPP link type [S19]', () => {
  it('maps PPP encapsulation to ppp_hdlc (pcap 50), strips the 2-byte CRC and decodes from the ppp layer', () => {
    expect(captureLinkForEncap('ppp')).toEqual({ linkType: 'ppp_hdlc', fcsLen: 0 });
    expect(captureLinkForEncap('hdlc')).toEqual({ linkType: 'c_hdlc', fcsLen: 0 });
    expect(PCAP_LINKTYPE.ppp_hdlc).toBe(50);
    expect(CAPTURE_STRIP_BYTES.ppp_hdlc).toBe(2);
    expect(CAPTURE_LIVE_FCS_LEN.ppp_hdlc).toBe(0);
    expect(outerForLinkType('ppp_hdlc', Uint8Array.of(0xff, 0x03, 0xc0, 0x21))).toBe('ppp');
    // the [S18] tunnel case of ruling R3, confirmed: no link header, so raw
    expect(captureLinkForEncap('tunnel')).toEqual({ linkType: 'raw', fcsLen: 0 });
  });

  it('a capture point on a PPP port gets a ppp_hdlc interface', () => {
    const encaps = new Map<string, PortEncap>([['Serial0/0/0', 'ppp'], ['Serial0/0/1', 'hdlc'], ['GigabitEthernet0/0', 'ethernet']]);
    const resolver: CapturePointResolver = {
      allPorts: () => [...encaps.keys()].map((port) => ({ device: 'd_r1', port })),
      linkPorts: () => undefined,
      portName: (ref) => (encaps.has(ref.port) ? `R1 ${ref.port}` : undefined),
      encap: (ref) => encaps.get(ref.port),
    };
    expect(resolveCapturePoints({}, resolver).map((p) => [p.name, p.linkType, p.fcsLen])).toEqual([
      ['R1 Serial0/0/0', 'ppp_hdlc', 0],
      ['R1 Serial0/0/1', 'c_hdlc', 0],
      ['R1 GigabitEthernet0/0', 'ethernet', 4],
    ]);
  });

  it('records PPP frames without their CRC; rows show the control protocols and the carried IPv4', () => {
    const { store, pdus } = liveCapture();
    expect(store.info().interfaces).toEqual([{ index: 0, ref: SE0, name: 'R1 Se0/0/0', linkType: 'ppp_hdlc', fcsLen: 0 }]);
    store.records().forEach((rec, i) => {
      const pdu = pdus[i]!;
      expect(rec.bytes).toEqual(pdu.bytes.slice(0, pdu.size - 2));
      expect(rec.origLen).toBe(pdu.size - 2);
      expect(rec.iface).toBe(0);
    });
    const rows = store.query({ from: 0, limit: 100 }).rows;
    expect(rows.map((r) => [r.layers, r.proto, r.src, r.dst])).toEqual([
      [['ppp', 'lcp'], 'lcp', '', ''],
      [['ppp', 'chap'], 'chap', '', ''],
      [['ppp', 'chap'], 'chap', '', ''],
      [['ppp', 'pap'], 'pap', '', ''],
      [['ppp', 'ipcp'], 'ipcp', '', ''],
      [['ppp', 'ipv6cp'], 'ipv6cp', '', ''],
      [['ppp', 'ipv4', 'icmpv4', 'payload'], 'icmpv4', '10.0.12.1', '10.0.12.2'],
    ]);
    const lcp = store.record(0)!;
    expect(lcp.layers[0]!.fields).toEqual({ address: 0xff, control: 0x03, protocol: PPP_PROTO.lcp });
    expect(lcp.layers[0]!.fields.fcsValid).toBeUndefined();
    expect(lcp.layers[1]!.fields).toMatchObject({ code: 1, id: 1, authProto: 'chap-md5', magic: 0x1a2b3c4d });
    for (const r of rows) expect(store.record(r.index)!.layers.filter((l) => l.error !== undefined)).toEqual([]);
  });

  it('the PPP family display fields filter the captured frames', () => {
    const { store } = liveCapture();
    const kept = (filter: string): string[] => {
      const r = store.query({ filter, from: 0, limit: 100 });
      expect(r.filterError, filter).toBeUndefined();
      return r.rows.map((row) => FRAMES[row.index]![0]);
    };
    expect(kept('ppp')).toEqual(FRAMES.map(([n]) => n));
    expect(kept('lcp')).toEqual(['lcp']);
    expect(kept('ppp.protocol == 0xc223')).toEqual(['chap-challenge', 'chap-success']);
    expect(kept('ppp.protocol == 0x0021')).toEqual(['ping']);
    expect(kept('lcp.opt.auth_protocol == "chap-md5" && lcp.opt.magic_number == 0x1a2b3c4d')).toEqual(['lcp']);
    expect(kept('chap.code == 1 && chap.identifier == 1 && chap.name == "R1"')).toEqual(['chap-challenge']);
    expect(kept('chap.message contains "Welcome"')).toEqual(['chap-success']);
    // PAP sends the password in the clear, which the lesson shows in a capture (§11.4 WAN row); CHAP never carries the secret
    expect(kept('pap.password == "NetF0rge" && pap.peer_id == "R1"')).toEqual(['pap']);
    expect(kept('frame contains "NetF0rge"')).toEqual(['pap']);
    expect(kept('ipcp.opt.ip_address == 10.0.12.1')).toEqual(['ipcp']);
    expect(kept('ipv6cp.opt.interface_identifier == "0200000000000001"')).toEqual(['ipv6cp']);
    expect(kept('ppp && icmp && ip.addr == 10.0.12.2')).toEqual(['ping']);
    expect(kept('frame.interface_name == "R1 Se0/0/0" && frame.direction == "rx"')).toEqual(['chap-challenge', 'pap', 'ipv6cp']);
  });

  it('pcap and pcapng exports carry link type 50 and read back the same frames', () => {
    const { store } = liveCapture();
    const classic = store.export({ format: 'pcap' });
    expect(new DataView(classic.buffer, classic.byteOffset, classic.byteLength).getUint32(20, true)).toBe(50);
    const ng = store.export({ format: 'pcapng' });
    for (const bytes of [classic, ng]) {
      const file = readCapture(bytes);
      expect(file.interfaces.map((i) => [i.linkType, i.fcsLen])).toEqual([['ppp_hdlc', 0]]);
      expect(file.records.map((r) => r.bytes)).toEqual(store.records().map((r) => r.bytes));
      const back = createCaptureStoreImpl({ id: 'i_1', name: 'back', source: 'import', interfaces: file.interfaces, records: file.records });
      expect(back.query({ from: 0, limit: 100 }).rows.map((r) => r.layers)).toEqual(store.query({ from: 0, limit: 100 }).rows.map((r) => r.layers));
    }
  });

  it('an imported PPP capture that keeps its CRC (if_fcslen 2) checks it', () => {
    const pdu = FRAMES[0]![1]();
    const file = { interfaces: [{ index: 0, name: 'Serial with FCS', linkType: 'ppp_hdlc' as CaptureLinkType, fcsLen: 2 as const }], records: [{ index: 0, t: 0, iface: 0, dir: 'tx' as const, bytes: pdu.bytes.slice(), origLen: pdu.size }] };
    const read = readCapture(writeCapture(file, { format: 'pcapng' }));
    expect(read.interfaces.map((i) => [i.linkType, i.fcsLen])).toEqual([['ppp_hdlc', 2]]);
    const store = createCaptureStoreImpl({ id: 'i_2', name: 'fcs', source: 'import', interfaces: read.interfaces, records: read.records });
    const detail = store.record(0)!;
    expect(detail.layers.map((l) => l.proto)).toEqual(['ppp', 'lcp']);
    expect(detail.layers[0]!.fields.fcsValid).toBe(true);
  });

  it('a serial port switched from HDLC to PPP mid-capture gains a (ppp_hdlc) interface; classic pcap refuses the mix', () => {
    const hub = createCaptureHub();
    const store = hub.start({ includeBackground: true }, [{ ref: SE0, name: 'R1 Se0/0/0', ...captureLinkForEncap('hdlc') }]);
    const keepalive = f.build(
      [
        { proto: 'hdlc', fields: { address: HDLC_ADDRESS_BROADCAST, control: 0, protocol: HDLC_PROTO_KEEPALIVE } },
        { proto: 'payload', fields: { data: new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0, 0xff, 0xff, 0, 0]) } },
      ],
      meta({ background: true }),
    );
    hub.record({ t: 1, dir: 'tx', port: SE0, pdu: keepalive, linkType: 'c_hdlc' });
    hub.record({ t: 2, dir: 'tx', port: SE0, pdu: FRAMES[0]![1](), linkType: 'ppp_hdlc' });
    expect(store.info().interfaces.map((i) => [i.index, i.name, i.linkType, i.fcsLen])).toEqual([
      [0, 'R1 Se0/0/0', 'c_hdlc', 0],
      [1, 'R1 Se0/0/0 (ppp_hdlc)', 'ppp_hdlc', 0],
    ]);
    expect(store.query({ from: 0, limit: 10 }).rows.map((r) => [r.iface, r.layers[0]])).toEqual([[0, 'hdlc'], [1, 'ppp']]);
    expect(() => store.export({ format: 'pcap' })).toThrow(PCAP_MIXED_LINKTYPE_MESSAGE);
    expect(readCapture(store.export({ format: 'pcapng' })).interfaces.map((i) => i.linkType)).toEqual(['c_hdlc', 'ppp_hdlc']);
  });
});
