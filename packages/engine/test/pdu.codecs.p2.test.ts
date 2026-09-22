/**
 * P2 codecs: golden bytes, dispatch and the registry order (ARCHITECTURE-P2 §2.3, §7 W1 pdu).
 *
 * Every golden frame is assembled by hand here; the Ethernet FCS is computed with node's zlib CRC-32, independently
 * of the engine's own `crc32`.
 */
import { describe, expect, it } from 'vitest';
import { crc32 as zlibCrc32 } from 'node:zlib';
import {
  ETHERTYPE_SLOW_PROTOCOLS,
  ETHERTYPE_VLAN,
  ETH_LENGTH_MAX,
  IPPROTO_ICMP,
  IPPROTO_UDP,
  LLC_SAP_STP,
  NF_L2_CONTROL_MAC,
  NF_OUI,
  NF_PID_DTP,
  SLOW_PROTOCOLS_MAC,
  STP_GROUP_MAC,
  UDP_PORT_CAPWAP_CONTROL,
  UDP_PORT_CAPWAP_DATA,
  UDP_PORT_DHCPV6_CLIENT,
  UDP_PORT_DHCPV6_SERVER,
  CAPWAP_MSG,
} from '../src/contracts/pdu.js';
import type { LayerSpec, LayerView, PduMeta } from '../src/contracts/pdu.js';
import { CODECS, decodeLayers, encodeLayers, fillLinkField, getCodec } from '../src/pdu/codecs/registry.js';
import { keyForProto, linkFieldFor, linkFieldOf, lookupNext } from '../src/pdu/codecs/dispatch.js';
import { dot1qCodec } from '../src/pdu/codecs/dot1q.js';
import { STP_BPDU_CONFIG, STP_BPDU_RST, STP_BPDU_TCN, stpCodec, stpFlagsText } from '../src/pdu/codecs/stp.js';
import { LACPDU_LENGTH, lacpCodec, lacpStateText } from '../src/pdu/codecs/lacp.js';
import { DTP_MODE_DESIRABLE, DTP_MODE_TRUNK, dtpCodec } from '../src/pdu/codecs/dtp.js';
import { DHCPV6_INFORMATION_REQUEST, DHCPV6_RELAY_FORW, DHCPV6_REPLY, DHCPV6_SOLICIT, dhcpv6Codec, duidLlFromMac } from '../src/pdu/codecs/dhcpv6.js';
import { capwapCodec, capwapMessageName } from '../src/pdu/codecs/capwap.js';
import { hsrpCodec } from '../src/pdu/codecs/hsrp.js';
import { createPduFactory } from '../src/pdu/factory.js';

const hex = (s: string): number[] => (s.replace(/\s+/g, '').match(/.{2}/g) ?? []).map((h) => parseInt(h, 16));
const bytes = (...parts: number[][]): number[] => parts.flat();
const protos = (layers: readonly LayerView[]): string[] => layers.map((l) => l.proto);
const meta = (): PduMeta => ({ born: 0, origin: 'd_sw1' });

const MAC1 = '02:b3:b2:b1:b0:01';
const MAC2 = '02:b3:b2:b1:b0:02';
const BASE = '02:b3:b2:b1:b0:00';
const BASE2 = '02:b3:b2:b1:b0:10';

/** Frame bytes: header + body, zero-padded to 60 bytes, with the CRC-32 FCS appended little-endian. */
function frame(body: number[]): number[] {
  const padded = body.length < 60 ? [...body, ...new Array<number>(60 - body.length).fill(0)] : body;
  const fcs = zlibCrc32(Uint8Array.from(padded)) >>> 0;
  return [...padded, fcs & 0xff, (fcs >>> 8) & 0xff, (fcs >>> 16) & 0xff, (fcs >>> 24) & 0xff];
}

const macBytes = (mac: string): number[] => hex(mac.replace(/:/g, ''));

const layerBytes = (b: Uint8Array, l: LayerView): number[] => Array.from(b.slice(l.offset, l.offset + l.length));

describe('P2 codec registry and dispatch', () => {
  it('registers every P2 codec under its protocol name', () => {
    expect(getCodec('dot1q')).toBe(dot1qCodec);
    expect(getCodec('stp')).toBe(stpCodec);
    expect(getCodec('lacp')).toBe(lacpCodec);
    expect(getCodec('dtp')).toBe(dtpCodec);
    expect(getCodec('dhcpv6')).toBe(dhcpv6Codec);
    expect(getCodec('capwap')).toBe(capwapCodec);
    expect(getCodec('hsrp')).toBe(hsrpCodec);
    expect([...CODECS.keys()].slice(-8)).toEqual(['dot1q', 'stp', 'lacp', 'dtp', 'dhcpv6', 'capwap', 'hsrp', 'pagp']);
  });

  it('dispatches the P2 keys in their spaces (§2.3)', () => {
    expect(lookupNext('ethertype', ETHERTYPE_VLAN)).toBe('dot1q');
    expect(lookupNext('ethertype', ETHERTYPE_SLOW_PROTOCOLS)).toBe('lacp');
    expect(lookupNext('llc.sap', LLC_SAP_STP)).toBe('stp');
    expect(lookupNext('llc.sap', 0xf0)).toBeUndefined();
    expect(lookupNext('nf.pid', NF_PID_DTP)).toBe('dtp');
    expect(lookupNext('udp.port', UDP_PORT_DHCPV6_CLIENT)).toBe('dhcpv6');
    expect(lookupNext('udp.port', UDP_PORT_DHCPV6_SERVER)).toBe('dhcpv6');
    expect(lookupNext('udp.port', UDP_PORT_CAPWAP_CONTROL)).toBe('capwap');
    expect(lookupNext('udp.port', UDP_PORT_CAPWAP_DATA)).toBe('capwap');
    expect(lookupNext('udp.port', 1985)).toBe('hsrp');
    expect(keyForProto('ethertype', 'dot1q')).toBe(ETHERTYPE_VLAN);
    expect(keyForProto('llc.sap', 'stp')).toBe(LLC_SAP_STP);
    expect(keyForProto('nf.pid', 'dtp')).toBe(NF_PID_DTP);
  });

  it('fills the next-layer selector by the 802.3 rule and the llc selector spaces', () => {
    expect(linkFieldFor('dot1q')).toEqual({ field: 'type', space: 'ethertype', lengthFramed: true });
    expect(fillLinkField('ethernet', { dst: MAC1 }, 'llc')).toEqual({ dst: MAC1, type: 0 });
    expect(fillLinkField('dot1q', { vid: 10 }, 'llc')).toEqual({ vid: 10, type: 0 });
    expect(fillLinkField('dot1q', { vid: 10 }, 'ipv4')).toEqual({ vid: 10, type: 0x0800 });
    expect(fillLinkField('llc', {}, 'stp')).toEqual({ dsap: LLC_SAP_STP, ssap: LLC_SAP_STP });
    expect(fillLinkField('llc', {}, 'dtp')).toEqual({ oui: NF_OUI, type: NF_PID_DTP });
    expect(fillLinkField('llc', { oui: NF_OUI }, 'dtp')).toEqual({ oui: NF_OUI, type: NF_PID_DTP });
    expect(fillLinkField('llc', {}, 'eapol')).toEqual({ type: 0x888e }); // SNAP path unchanged (P1)
    const explicit = { dsap: LLC_SAP_STP, ssap: LLC_SAP_STP };
    expect(fillLinkField('llc', explicit, 'stp')).toBe(explicit);
    expect(linkFieldOf('llc', explicit)).toBeUndefined();
    expect(linkFieldOf('llc', { oui: NF_OUI })).toEqual({ field: 'type', space: 'nf.pid' });
    expect(linkFieldOf('llc', {})).toEqual({ field: 'type', space: 'ethertype' });
  });
});

describe('dot1q codec', () => {
  const ARP_BODY = hex('00 01 08 00 06 04 00 01') .concat(macBytes(MAC1), hex('0a 00 00 01'), macBytes('00:00:00:00:00:00'), hex('0a 00 00 02'));
  const TAGGED_ARP = frame(bytes(
    macBytes('ff:ff:ff:ff:ff:ff'),
    macBytes(MAC1),
    hex('81 00'), // ethertype 0x8100
    hex('00 0a'), // pcp 0, dei 0, vid 10
    hex('08 06'), // inner ethertype ARP
    ARP_BODY,
  ));

  const taggedArpSpecs = (): LayerSpec[] => [
    { proto: 'ethernet', fields: { dst: 'ff:ff:ff:ff:ff:ff', src: MAC1, type: ETHERTYPE_VLAN } },
    { proto: 'dot1q', fields: { vid: 10 } },
    { proto: 'arp', fields: { op: 1, sha: MAC1, spa: '10.0.0.1', tha: '00:00:00:00:00:00', tpa: '10.0.0.2' } },
  ];

  it('encodes a tagged ARP frame byte for byte and pads it to 64 bytes', () => {
    const b = encodeLayers(taggedArpSpecs());
    expect(Array.from(b)).toEqual(TAGGED_ARP);
    expect(b.length).toBe(64);
  });

  it('decodes the tag as its own transparent layer and leaves the padding on the ethernet trailer', () => {
    const b = Uint8Array.from(TAGGED_ARP);
    const layers = decodeLayers(b);
    expect(protos(layers)).toEqual(['ethernet', 'dot1q', 'arp']);
    expect(layers[1]!.fields).toEqual({ pcp: 0, dei: false, vid: 10, type: 0x0806 });
    expect(layers[1]!.length).toBe(4 + 28);
    expect(layers[0]!.fields.padding).toBe(14);
    expect(layers[0]!.fields.fcsValid).toBe(true);
    const p = createPduFactory().decode(b, meta());
    expect(p.topProto()).toBe('arp'); // the tag is transparent
    expect(p.summary()).toBe('ARP request who-has 10.0.0.2 tell 10.0.0.1');
  });

  it('carries pcp and dei in the TCI and refuses values outside the tag', () => {
    const b = dot1qCodec.encode({ pcp: 5, dei: true, vid: 4095, type: 0x0800 }, Uint8Array.from([1]));
    expect(Array.from(b)).toEqual([0xbf, 0xff, 0x08, 0x00, 1]);
    expect(dot1qCodec.decode(b, 0, b.length).fields).toEqual({ pcp: 5, dei: true, vid: 4095, type: 0x0800 });
    expect(() => dot1qCodec.encode({ vid: 4096, type: 0 }, new Uint8Array(0))).toThrow(/vid out of range/);
    expect(() => dot1qCodec.encode({ vid: 1, pcp: 8, type: 0 }, new Uint8Array(0))).toThrow(/pcp out of range/);
    expect(() => dot1qCodec.encode({ pcp: 0, type: 0x0800 }, new Uint8Array(0))).toThrow(/dot1q\.vid is required/);
    expect(dot1qCodec.decode(Uint8Array.from([0, 10, 8]), 0, 3).error).toMatch(/truncated/);
  });

  it('summarizes the VLAN and the payload selector', () => {
    expect(dot1qCodec.summarize({ vid: 10, pcp: 0, type: 0x0800 })).toBe('802.1Q VLAN 10 type=0x0800');
    expect(dot1qCodec.summarize({ vid: 99, pcp: 5, type: 44 })).toBe('802.1Q VLAN 99 priority 5 length=44');
  });
});

describe('stp codec', () => {
  const ROOT_ID = hex('80 0a').concat(macBytes(BASE)); // priority 32768 + VLAN 10
  const CONFIG_BPDU = bytes(
    hex('00 00'), // protocol id
    hex('00'), // version 0 (802.1D)
    hex('00'), // configuration BPDU
    hex('00'), // flags
    ROOT_ID,
    hex('00 00 00 04'), // root path cost
    hex('80 0a'), macBytes(BASE2), // bridge id
    hex('80 01'), // port id 128.1
    hex('01 00'), // message age 1 s
    hex('14 00'), // max age 20 s
    hex('02 00'), // hello 2 s
    hex('0f 00'), // forward delay 15 s
  );
  const PVID_TLV = hex('00 00 00 02 00 0a');

  const bpduSpecs = (over: Record<string, number> = {}): LayerSpec[] => [
    { proto: 'ethernet', fields: { dst: STP_GROUP_MAC, src: MAC1, type: 0 } },
    { proto: 'llc', fields: { dsap: LLC_SAP_STP, ssap: LLC_SAP_STP, control: 3 } },
    {
      proto: 'stp',
      fields: {
        version: 0,
        bpduType: STP_BPDU_CONFIG,
        flags: 0,
        rootPriority: 32778,
        rootMac: BASE,
        rootPathCost: 4,
        bridgePriority: 32778,
        bridgeMac: BASE2,
        portId: 0x8001,
        messageAge: 256,
        maxAge: 5120,
        helloTime: 512,
        forwardDelay: 3840,
        ...over,
      },
    },
  ];

  it('encodes an untagged 802.3 configuration BPDU byte for byte (length framing, LLC SAP 0x42)', () => {
    const b = encodeLayers(bpduSpecs());
    expect(Array.from(b)).toEqual(frame(bytes(
      macBytes(STP_GROUP_MAC),
      macBytes(MAC1),
      hex('00 26'), // 802.3 length = 3 (LLC) + 35 (BPDU)
      hex('42 42 03'),
      CONFIG_BPDU,
    )));
    const layers = decodeLayers(b);
    expect(protos(layers)).toEqual(['ethernet', 'llc', 'stp']);
    expect(layers[0]!.fields.type).toBe(38);
    expect(layers[0]!.fields.padding).toBe(8);
    expect(layers[1]!.length).toBe(38);
    expect(layers[2]!.length).toBe(35);
    expect(layers[2]!.fields).toEqual({
      protocolId: 0, version: 0, bpduType: 0, flags: 0, flagsText: '',
      rootPriority: 32778, rootMac: BASE, rootPathCost: 4,
      bridgePriority: 32778, bridgeMac: BASE2, portId: 0x8001,
      messageAge: 256, maxAge: 5120, helloTime: 512, forwardDelay: 3840,
    });
    const p = createPduFactory().decode(b, meta());
    expect(p.topProto()).toBe('stp');
    expect(p.summary()).toBe('STP configuration BPDU root 32778/02:b3:b2:b1:b0:00 cost 4 bridge 32778/02:b3:b2:b1:b0:10 port 128.1');
  });

  it('encodes a tagged per-VLAN BPDU as [ethernet 0x8100, dot1q {type = length}, llc, stp] with the pvid TLV', () => {
    const specs = bpduSpecs({ pvid: 10 });
    const tagged: LayerSpec[] = [
      { proto: 'ethernet', fields: { dst: STP_GROUP_MAC, src: MAC1, type: ETHERTYPE_VLAN } },
      { proto: 'dot1q', fields: { vid: 10 } },
      ...specs.slice(1),
    ];
    const b = encodeLayers(tagged);
    expect(Array.from(b)).toEqual(frame(bytes(
      macBytes(STP_GROUP_MAC),
      macBytes(MAC1),
      hex('81 00'),
      hex('00 0a'),
      hex('00 2c'), // 802.3 length inside the tag = 3 + 35 + 6
      hex('42 42 03'),
      CONFIG_BPDU,
      PVID_TLV,
    )));
    const layers = decodeLayers(b);
    expect(protos(layers)).toEqual(['ethernet', 'dot1q', 'llc', 'stp']);
    expect(layers[1]!.fields.type).toBe(44);
    expect(layers[3]!.fields.pvid).toBe(10);
    expect(layers[3]!.length).toBe(41);
    expect(layers[0]!.fields.padding).toBe(0); // 14 + 4 + 44 + 4 = 66 bytes: nothing to pad
    expect(b.length).toBe(14 + 4 + 44 + 4);
  });

  it('encodes a 4-byte topology change notification and an RST BPDU with its flags', () => {
    const tcn = encodeLayers([
      { proto: 'ethernet', fields: { dst: STP_GROUP_MAC, src: MAC1, type: 0 } },
      { proto: 'llc', fields: { dsap: LLC_SAP_STP, ssap: LLC_SAP_STP, control: 3 } },
      { proto: 'stp', fields: { version: 0, bpduType: STP_BPDU_TCN } },
    ]);
    expect(Array.from(tcn)).toEqual(frame(bytes(
      macBytes(STP_GROUP_MAC), macBytes(MAC1), hex('00 07'), hex('42 42 03'), hex('00 00 00 80'),
    )));
    const tcnLayers = decodeLayers(tcn);
    expect(tcnLayers[2]!.fields).toEqual({ protocolId: 0, version: 0, bpduType: 0x80 });
    expect(createPduFactory().decode(tcn, meta()).summary()).toBe('STP topology change notification');

    const rst = encodeLayers(bpduSpecs({ version: 2, bpduType: STP_BPDU_RST, flags: 0x3e }));
    const rstLayers = decodeLayers(rst);
    expect(rstLayers[2]!.length).toBe(36);
    expect(rstLayers[2]!.fields.v1Length).toBe(0);
    expect(rstLayers[2]!.fields.flagsText).toBe('P,D,L,F');
    expect(layerBytes(rst, rstLayers[2]!).slice(0, 5)).toEqual(hex('00 00 02 02 3e'));
  });

  it('maps every flag bit to its token and rejects an unknown BPDU type', () => {
    expect(stpFlagsText(0x01)).toBe('TC');
    expect(stpFlagsText(0x80)).toBe('TCA');
    expect(stpFlagsText(0xff)).toBe('TC,P,D,L,F,AG,TCA');
    expect(stpFlagsText(0x06)).toBe('P,A');
    expect(() => stpCodec.encode({ version: 0, bpduType: 0x7f }, new Uint8Array(0))).toThrow(/bpduType/);
    expect(() => stpCodec.encode({ version: 0, bpduType: 0 }, Uint8Array.from([1]))).toThrow(/no inner layer/);
    expect(stpCodec.decode(Uint8Array.from([0, 0, 0]), 0, 3).error).toMatch(/truncated/);
    expect(stpCodec.decode(Uint8Array.from([0, 1, 0, 0]), 0, 4).error).toMatch(/not a spanning-tree BPDU/);
    expect(stpCodec.decode(Uint8Array.from([0, 0, 0, 0x7f]), 0, 4).error).toMatch(/unknown BPDU type 0x7f/);
  });
});

describe('lacp codec', () => {
  const LACPDU = bytes(
    hex('01 01'), // subtype, version
    hex('01 14'), // actor TLV
    hex('00 01'), macBytes(BASE), hex('00 01'), hex('00 80'), hex('00 01'), hex('3d'), hex('00 00 00'),
    hex('02 14'), // partner TLV
    hex('00 01'), macBytes(BASE2), hex('00 01'), hex('00 80'), hex('00 02'), hex('3d'), hex('00 00 00'),
    hex('03 10'), // collector TLV
    hex('00 00'), new Array<number>(12).fill(0),
    hex('00 00'), // terminator
    new Array<number>(50).fill(0),
  );

  const lacpSpecs = (): LayerSpec[] => [
    { proto: 'ethernet', fields: { dst: SLOW_PROTOCOLS_MAC, src: MAC1, type: ETHERTYPE_SLOW_PROTOCOLS } },
    {
      proto: 'lacp',
      fields: {
        actorSystemPriority: 1, actorSystem: BASE, actorKey: 1, actorPortPriority: 128, actorPort: 1, actorState: 0x3d,
        partnerSystemPriority: 1, partnerSystem: BASE2, partnerKey: 1, partnerPortPriority: 128, partnerPort: 2, partnerState: 0x3d,
      },
    },
  ];

  it('encodes a fixed 110-byte LACPDU byte for byte', () => {
    expect(LACPDU.length).toBe(LACPDU_LENGTH);
    const b = encodeLayers(lacpSpecs());
    expect(b.length).toBe(14 + LACPDU_LENGTH + 4);
    expect(Array.from(b)).toEqual(frame(bytes(macBytes(SLOW_PROTOCOLS_MAC), macBytes(MAC1), hex('88 09'), LACPDU)));
  });

  it('decodes the actor and partner blocks and the state letters', () => {
    const b = encodeLayers(lacpSpecs());
    const layers = decodeLayers(b);
    expect(protos(layers)).toEqual(['ethernet', 'lacp']);
    expect(layers[1]!.length).toBe(LACPDU_LENGTH);
    expect(layers[1]!.fields).toEqual({
      subtype: 1, version: 1,
      actorSystemPriority: 1, actorSystem: BASE, actorKey: 1, actorPortPriority: 128, actorPort: 1, actorState: 0x3d,
      partnerSystemPriority: 1, partnerSystem: BASE2, partnerKey: 1, partnerPortPriority: 128, partnerPort: 2, partnerState: 0x3d,
      collectorMaxDelay: 0,
    });
    expect(lacpStateText(0x3d)).toBe('AGSCD');
    expect(lacpStateText(0)).toBe('');
    expect(createPduFactory().decode(b, meta()).summary())
      .toBe('LACP actor 02:b3:b2:b1:b0:00 port 1 key 1 state AGSCD partner 02:b3:b2:b1:b0:10 port 2');
  });

  it('errors and stops on a slow-protocol subtype other than 1, and on truncation', () => {
    const b = encodeLayers(lacpSpecs());
    const marker = b.slice();
    marker[14] = 2;
    const layers = decodeLayers(marker);
    expect(protos(layers)).toEqual(['ethernet', 'lacp']);
    expect(layers[1]!.error).toBe('slow protocols subtype 2 is not LACP');
    expect(lacpCodec.decode(Uint8Array.from([1, 1, 1]), 0, 3).error).toMatch(/truncated/);
    expect(() => lacpCodec.encode({ subtype: 2 }, new Uint8Array(0))).toThrow(/subtype must be 1/);
    expect(() => lacpCodec.encode({}, Uint8Array.from([1]))).toThrow(/no inner layer/);
  });
});

describe('dtp codec (NF format)', () => {
  const DTP_BODY = bytes(
    hex('01'), // version
    hex('00 01 00 00'), // domain, empty
    hex('00 02 00 01'), [DTP_MODE_DESIRABLE],
    hex('00 03 00 01 00'), // not trunking
    hex('00 04 00 01 01'), // 802.1Q
    hex('00 05 00 06'), macBytes(MAC1),
  );

  const dtpSpecs = (): LayerSpec[] => [
    { proto: 'ethernet', fields: { dst: NF_L2_CONTROL_MAC, src: MAC1, type: 0 } },
    { proto: 'llc', fields: { oui: NF_OUI, type: NF_PID_DTP } },
    { proto: 'dtp', fields: { adminMode: DTP_MODE_DESIRABLE, operTrunk: false, neighbor: MAC1 } },
  ];

  it('encodes an 802.3 + LLC/SNAP NF frame to the NF control group byte for byte', () => {
    const b = encodeLayers(dtpSpecs());
    expect(Array.from(b)).toEqual(frame(bytes(
      macBytes(NF_L2_CONTROL_MAC),
      macBytes(MAC1),
      hex('00 26'), // 802.3 length = 8 (LLC/SNAP) + 30 (DTP)
      hex('aa aa 03 02 4e 46 00 01'),
      DTP_BODY,
    )));
    const layers = decodeLayers(b);
    expect(protos(layers)).toEqual(['ethernet', 'llc', 'dtp']);
    expect(layers[1]!.fields.oui).toBe(NF_OUI);
    expect(layers[2]!.fields).toEqual({ version: 1, domain: '', adminMode: DTP_MODE_DESIRABLE, operTrunk: false, trunkType: 1, neighbor: MAC1 });
    expect(layers[2]!.length).toBe(30);
    expect(createPduFactory().decode(b, meta()).summary()).toBe('DTP desirable, not trunking, from 02:b3:b2:b1:b0:01');
  });

  it('carries a domain, reports a missing TLV and refuses a bad mode', () => {
    const b = dtpCodec.encode({ adminMode: DTP_MODE_TRUNK, operTrunk: true, neighbor: MAC2, domain: 'lab' }, new Uint8Array(0));
    const d = dtpCodec.decode(b, 0, b.length);
    expect(d.fields).toEqual({ version: 1, domain: 'lab', adminMode: DTP_MODE_TRUNK, operTrunk: true, trunkType: 1, neighbor: MAC2 });
    expect(d.error).toBeUndefined();
    expect(dtpCodec.decode(Uint8Array.from([1]), 0, 1).error).toMatch(/has no adminMode, operTrunk, neighbor/);
    expect(dtpCodec.decode(Uint8Array.from([1, 0, 2, 0, 9]), 0, 5).error).toMatch(/runs past the message/);
    expect(() => dtpCodec.encode({ adminMode: 9, operTrunk: false, neighbor: MAC1 }, new Uint8Array(0))).toThrow(/adminMode/);
    expect(() => dtpCodec.encode({ adminMode: 1, neighbor: MAC1 }, new Uint8Array(0))).toThrow(/operTrunk is required/);
    expect(() => dtpCodec.encode({ adminMode: 1, operTrunk: false, neighbor: MAC1, domain: 'x'.repeat(33) }, new Uint8Array(0))).toThrow(/at most 32/);
  });
});

describe('dhcpv6 codec', () => {
  const CLIENT_DUID = duidLlFromMac(MAC1);

  const solicitSpecs = (): LayerSpec[] => [
    { proto: 'ethernet', fields: { dst: '33:33:00:01:00:02', src: MAC1, type: 0x86dd } },
    { proto: 'ipv6', fields: { src: 'fe80::b3:b2ff:feb1:b001', dst: 'ff02::1:2', nextHeader: IPPROTO_UDP, hopLimit: 1 } },
    { proto: 'udp', fields: { srcPort: UDP_PORT_DHCPV6_CLIENT, dstPort: UDP_PORT_DHCPV6_SERVER } },
    { proto: 'dhcpv6', fields: { msgType: DHCPV6_SOLICIT, transactionId: 0x123456, clientDuid: CLIENT_DUID, iaid: 1, elapsedTimeCs: 0, oro: '23,24' } },
  ];

  it('encodes a SOLICIT with its options in code order, byte for byte', () => {
    const b = encodeLayers(solicitSpecs());
    const layers = decodeLayers(b);
    expect(protos(layers)).toEqual(['ethernet', 'ipv6', 'udp', 'dhcpv6']);
    expect(layerBytes(b, layers[3]!)).toEqual(bytes(
      hex('01 12 34 56'), // SOLICIT, transaction id
      hex('00 01 00 0a 00 03 00 01'), macBytes(MAC1), // CLIENTID = DUID-LL
      hex('00 03 00 0c 00 00 00 01 00 00 00 00 00 00 00 00'), // IA_NA iaid 1, t1 0, t2 0
      hex('00 06 00 04 00 17 00 18'), // ORO 23, 24
      hex('00 08 00 02 00 00'), // elapsed time
    ));
    expect(CLIENT_DUID).toBe('0003000102b3b2b1b001');
    expect(layers[3]!.fields).toEqual({
      msgType: DHCPV6_SOLICIT, transactionId: 0x123456, clientDuid: CLIENT_DUID,
      iaid: 1, t1S: 0, t2S: 0, oro: '23,24', elapsedTimeCs: 0,
    });
    expect(createPduFactory().decode(b, meta()).summary()).toBe('DHCPv6 SOLICIT xid=0x123456');
  });

  it('round-trips an ADVERTISE with an address, lifetimes, DNS servers and a domain list', () => {
    const fields = {
      msgType: 2, transactionId: 7, clientDuid: CLIENT_DUID, serverDuid: duidLlFromMac(MAC2),
      iaid: 1, t1S: 1800, t2S: 2880, iaAddress: '2001:db8:1::2', preferredLifetimeS: 3600, validLifetimeS: 7200,
      dnsServers: '2001:db8:1::53,2001:db8:1::54', domainList: 'lab.nf,example.nf', statusCode: 0, rapidCommit: true,
    };
    const b = dhcpv6Codec.encode({ ...fields }, new Uint8Array(0));
    const d = dhcpv6Codec.decode(b, 0, b.length);
    expect(d.error).toBeUndefined();
    expect(d.fields).toEqual(fields);
    expect(Array.from(dhcpv6Codec.encode({ ...d.fields }, new Uint8Array(0)))).toEqual(Array.from(b));
  });

  it('chains a relay message to the inner message through the relay-message option', () => {
    const inner = encodeLayers([{ proto: 'dhcpv6', fields: { msgType: DHCPV6_SOLICIT, transactionId: 1, clientDuid: CLIENT_DUID } }]);
    const relay = encodeLayers([
      { proto: 'dhcpv6', fields: { msgType: DHCPV6_RELAY_FORW, hopCount: 0, linkAddress: '2001:db8:1::1', peerAddress: 'fe80::1' } },
      { proto: 'dhcpv6', fields: { msgType: DHCPV6_SOLICIT, transactionId: 1, clientDuid: CLIENT_DUID } },
    ]);
    const layers = decodeLayers(relay, 'dhcpv6');
    expect(protos(layers)).toEqual(['dhcpv6', 'dhcpv6']);
    expect(layers[0]!.fields).toEqual({ msgType: DHCPV6_RELAY_FORW, hopCount: 0, linkAddress: '2001:db8:1::1', peerAddress: 'fe80::1' });
    expect(layerBytes(relay, layers[1]!)).toEqual(Array.from(inner));
    expect(dhcpv6Codec.summarize(layers[0]!.fields)).toBe('DHCPv6 RELAY-FORW link 2001:db8:1::1 peer fe80::1');
  });

  it('reports truncation and a bad option length; refuses an inner message outside a relay', () => {
    expect(dhcpv6Codec.decode(Uint8Array.from([11, 1, 2]), 0, 3).error).toMatch(/header truncated/);
    expect(dhcpv6Codec.decode(Uint8Array.from([11, 1, 2, 3, 0, 1, 0, 9]), 0, 8).error).toMatch(/option 1 runs past the message/);
    expect(() => dhcpv6Codec.encode({ msgType: DHCPV6_REPLY }, Uint8Array.from([1]))).toThrow(/only a relay message/);
    expect(() => dhcpv6Codec.encode({ msgType: 1, clientDuid: 'zz' }, new Uint8Array(0))).toThrow(/hex digits/);
    expect(dhcpv6Codec.summarize({ msgType: DHCPV6_INFORMATION_REQUEST, transactionId: 0xabcdef })).toBe('DHCPv6 INFORMATION-REQUEST xid=0xabcdef');
  });
});

describe('capwap codec', () => {
  const controlSpecs = (fields: Record<string, string | number | boolean>): LayerSpec[] => [
    { proto: 'ethernet', fields: { dst: MAC2, src: MAC1, type: 0x0800 } },
    { proto: 'ipv4', fields: { src: '192.168.99.20', dst: '192.168.99.5', protocol: IPPROTO_UDP, ttl: 64 } },
    { proto: 'udp', fields: { srcPort: UDP_PORT_CAPWAP_CONTROL, dstPort: UDP_PORT_CAPWAP_CONTROL } },
    { proto: 'capwap', fields: fields },
  ];

  it('encodes a Discovery Request with its WTP Name element byte for byte', () => {
    const b = encodeLayers(controlSpecs({ messageType: CAPWAP_MSG.discoveryReq, seq: 0, wtpName: 'LAP1' }));
    const layers = decodeLayers(b);
    expect(protos(layers)).toEqual(['ethernet', 'ipv4', 'udp', 'capwap']);
    expect(layerBytes(b, layers[3]!)).toEqual(bytes(
      hex('00 10 02 00 00 00 00 00'), // preamble, HLEN 2 / RID 0 / WBID 1, no flags, no fragmentation
      hex('00 00 00 01'), // message type 1
      hex('00'), // sequence
      hex('00 0b'), // element length = 8 + 3
      hex('00'), // flags
      hex('00 2d 00 04'), hex('4c 41 50 31'), // WTP Name "LAP1"
    ));
    expect(layers[3]!.fields).toEqual({ radioId: 0, wbid: 1, tbit: false, messageType: 1, seq: 0, wtpName: 'LAP1' });
    expect(createPduFactory().decode(b, meta()).summary()).toBe('CAPWAP Discovery Request from LAP1 seq 0');
  });

  it('carries the controller name, a result code and the NF vendor-specific WLAN and station elements', () => {
    const join = decodeLayers(encodeLayers(controlSpecs({ messageType: CAPWAP_MSG.joinResp, seq: 1, acName: 'WLC1', resultCode: 0 })));
    expect(join[3]!.fields).toMatchObject({ messageType: 4, seq: 1, acName: 'WLC1', resultCode: 0 });

    const wlanBytes = encodeLayers(controlSpecs({ messageType: CAPWAP_MSG.wlanConfigReq, seq: 2, wlans: '1:LabNet:wpa2-psk:20:305419896' }));
    const wlan = decodeLayers(wlanBytes);
    // Vendor Specific Payload (37): length 6 + 30, vendor id = the NF OUI, NF element 1 = the WLAN line.
    expect(layerBytes(wlanBytes, wlan[3]!).slice(16, 16 + 10)).toEqual(hex('00 25 00 24 00 02 4e 46 00 01'));
    expect(wlan[3]!.fields.wlans).toBe('1:LabNet:wpa2-psk:20:305419896');
    expect(capwapMessageName(CAPWAP_MSG.wlanConfigReq)).toBe('IEEE 802.11 WLAN Configuration Request');

    const event = decodeLayers(encodeLayers(controlSpecs({ messageType: CAPWAP_MSG.wtpEventReq, seq: 3, stations: `add:${MAC2}:${BASE2}:1` })));
    expect(event[3]!.fields.stations).toBe(`add:${MAC2}:${BASE2}:1`);
  });

  it('tunnels a native 802.11 frame on the data channel with no FCS anywhere inside', () => {
    const b = encodeLayers([
      { proto: 'ethernet', fields: { dst: MAC2, src: MAC1, type: 0x0800 } },
      { proto: 'ipv4', fields: { src: '192.168.99.20', dst: '192.168.99.5', protocol: IPPROTO_UDP, ttl: 64 } },
      { proto: 'udp', fields: { srcPort: UDP_PORT_CAPWAP_DATA, dstPort: UDP_PORT_CAPWAP_DATA } },
      { proto: 'capwap', fields: { tbit: true, radioId: 1 } },
      { proto: 'dot11', fields: { frameType: 'data', subtype: 'data', toDs: true, addr1: BASE2, addr2: MAC2, addr3: MAC1 } },
      { proto: 'llc', fields: { type: 0x0800 } },
      { proto: 'ipv4', fields: { src: '192.168.20.10', dst: '192.168.20.1', protocol: IPPROTO_ICMP, ttl: 128 } },
      { proto: 'icmpv4', fields: { type: 8, code: 0, id: 1, seq: 1 } },
      { proto: 'payload', fields: { data: new Uint8Array(8).fill(9) } },
    ]);
    const layers = decodeLayers(b);
    expect(protos(layers)).toEqual(['ethernet', 'ipv4', 'udp', 'capwap', 'dot11', 'llc', 'ipv4', 'icmpv4', 'payload']);
    expect(layers[3]!.fields).toEqual({ radioId: 1, wbid: 1, tbit: true, keepAlive: false });
    const dot11 = layers[4]!;
    expect(dot11.fields.fcs).toBeUndefined(); // no FCS inside the tunnel
    expect(dot11.fields.fcsValid).toBeUndefined();
    expect(dot11.length).toBe(24 + 8 + 20 + 8 + 8);
    expect(layers[0]!.fields.fcsValid).toBe(true); // the carrying frame still has one
    expect(layers[6]!.fields.checksumValid).toBe(true);
    const p = createPduFactory().decode(b, meta());
    expect(p.topProto()).toBe('icmpv4');
  });

  it('tunnels an 802.3 frame without FCS or padding, and encodes a data keep-alive', () => {
    const inner: LayerSpec[] = [
      { proto: 'ethernet', fields: { dst: MAC2, src: MAC1, type: 0x0806 } },
      { proto: 'arp', fields: { op: 1, sha: MAC1, spa: '10.0.0.1', tha: '00:00:00:00:00:00', tpa: '10.0.0.2' } },
    ];
    const b = encodeLayers([
      { proto: 'ethernet', fields: { dst: MAC2, src: MAC1, type: 0x0800 } },
      { proto: 'ipv4', fields: { src: '192.168.99.20', dst: '192.168.99.5', protocol: IPPROTO_UDP, ttl: 64 } },
      { proto: 'udp', fields: { srcPort: UDP_PORT_CAPWAP_DATA, dstPort: UDP_PORT_CAPWAP_DATA } },
      { proto: 'capwap', fields: { tbit: false } },
      ...inner,
    ]);
    const layers = decodeLayers(b);
    expect(protos(layers)).toEqual(['ethernet', 'ipv4', 'udp', 'capwap', 'ethernet', 'arp']);
    expect(layers[4]!.length).toBe(14 + 28); // no FCS, no padding to 64
    expect(layers[4]!.fields.fcs).toBeUndefined();

    const keep = encodeLayers([
      { proto: 'ethernet', fields: { dst: MAC2, src: MAC1, type: 0x0800 } },
      { proto: 'ipv4', fields: { src: '192.168.99.20', dst: '192.168.99.5', protocol: IPPROTO_UDP, ttl: 64 } },
      { proto: 'udp', fields: { srcPort: UDP_PORT_CAPWAP_DATA, dstPort: UDP_PORT_CAPWAP_DATA } },
      { proto: 'capwap', fields: { keepAlive: true } },
    ]);
    const k = decodeLayers(keep);
    expect(layerBytes(keep, k[3]!)).toEqual(hex('00 10 02 08 00 00 00 00 00 00'));
    expect(k[3]!.fields.keepAlive).toBe(true);
    expect(capwapCodec.summarize(k[3]!.fields)).toBe('CAPWAP data keep-alive');
  });

  it('reports a DTLS record, a bad header length and a bad element length', () => {
    expect(capwapCodec.decode(Uint8Array.from([0x01, 0x10, 0x02, 0, 0, 0, 0, 0]), 0, 8).error).toMatch(/DTLS record/);
    expect(capwapCodec.decode(Uint8Array.from([0, 0, 0x02, 0, 0, 0, 0, 0]), 0, 8).error).toMatch(/bad CAPWAP header length/);
    expect(capwapCodec.decode(Uint8Array.from([0, 0x10, 0x02, 0, 0, 0, 0, 0]), 0, 8).error).toMatch(/control header truncated/);
    expect(() => capwapCodec.encode({ messageType: 1 }, Uint8Array.from([1]))).toThrow(/no inner layer/);
    expect(() => capwapCodec.encode({ radioId: 32, messageType: 1 }, new Uint8Array(0))).toThrow(/radioId/);
  });
});
