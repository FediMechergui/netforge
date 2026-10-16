/**
 * P3c discovery codec additions [S35] (ARCHITECTURE-P3C §7 W1a pdu, §2.3, §3.9): the NF discovery ("CDP") TLV 9
 * `voiceVlan` (original format) and the LLDP-MED organisation TLVs (TIA OUI 00-12-BB): subtype 1 capabilities
 * (`medCapabilities`, `medDeviceType`) and subtype 2 network policy for voice (`medVlan`). Every other organisation TLV
 * stays skipped, and a frame without the new TLVs decodes exactly as before.
 *
 * The goldens were assembled independently of the engine (a separate script packing the TLV layouts).
 */
import { describe, expect, it } from 'vitest';
import { ETHERTYPE_LLDP, LLDP_NEAREST_BRIDGE_MAC, NF_L2_CONTROL_MAC } from '../src/contracts/pdu.js';
import type { LayerView } from '../src/contracts/pdu.js';
import { PROTO_FIELDS } from '../src/contracts/fields.js';
import { decodeLayers, encodeLayers } from '../src/pdu/codecs/registry.js';
import { CDP_TLV, cdpCodec } from '../src/pdu/codecs/cdp.js';
import {
  LLDP_CAPABILITY,
  LLDP_MED_CAPABILITY,
  LLDP_MED_DEVICE,
  LLDP_MED_OUI,
  LLDP_MED_SUBTYPE,
  LLDP_TLV,
  lldpCodec,
} from '../src/pdu/codecs/lldp.js';

const hex = (s: string): number[] => (s.replace(/\s+/g, '').match(/.{2}/g) ?? []).map((h) => parseInt(h, 16));
const protos = (layers: readonly LayerView[]): string[] => layers.map((l) => l.proto);

/** SW1's CDP on Fa0/2 (access VLAN 10, voice VLAN 30): the TLVs in type order, TLV 9 last. */
const CDP_VOICE =
  '02 b4' + // version 2, holdtime 180
  ' 0001 0003 535731' + // deviceId 'SW1'
  ' 0002 000f 4661737445746865726e6574302f32' + // portId 'FastEthernet0/2'
  ' 0004 0002 0002' + // capabilities S
  ' 0007 0002 000a' + // native VLAN 10
  ' 0008 0001 01' + // duplex full
  ' 0009 0002 001e'; // voice VLAN 30

/** SW1's LLDP on Fa0/2 to a phone that advertised MED: capabilities (network connectivity) and the voice policy. */
const LLDP_MED =
  '0207 04 0200000000a1' + // chassis id, subtype 4 (MAC)
  ' 0406 05 4661302f32' + // port id 'Fa0/2'
  ' 0602 0078' + // TTL 120
  ' 0a03 535731' + // system name 'SW1'
  ' 0e04 0004 0004' + // capabilities: bridge, enabled bridge
  ' fe07 0012bb 01 0003 04' + // LLDP-MED capabilities: capabilities + network policy, device type 4 (network connectivity)
  ' fe08 0012bb 02 01 403d6e' + // network policy: voice, U 0 T 1 X 0, VLAN 30, priority 5, DSCP 46
  ' 0000';

/** An IEEE 802.1 organisation TLV (OUI 00-80-C2 subtype 1, port VLAN 10) is still skipped. */
const LLDP_OTHER_ORG = '0207 04 0200000000a1' + ' 0406 05 4661302f32' + ' 0602 0078' + ' fe06 0080c2 01 000a' + ' 0000';

describe('[S35] NF discovery TLV 9: the voice VLAN', () => {
  it('writes TLV 9 last and only when voiceVlan is present', () => {
    const fields = { version: 2, ttl: 180, deviceId: 'SW1', portId: 'FastEthernet0/2', capabilities: 'S', nativeVlan: 10, duplex: 'full', voiceVlan: 30 };
    const b = cdpCodec.encode({ ...fields }, new Uint8Array(0));
    expect(Array.from(b)).toEqual(hex(CDP_VOICE));
    const d = cdpCodec.decode(b, 0, b.length);
    expect(d.error).toBeUndefined();
    expect(d.fields).toEqual(fields);
    expect(d.fieldRanges.voiceVlan).toEqual([b.length - 6, 6]);
    expect(CDP_TLV.voiceVlan).toBe(9);
    // without the field, the message is the P3 message byte for byte (no TLV 9)
    const { voiceVlan: _drop, ...plain } = fields;
    const p = cdpCodec.encode({ ...plain }, new Uint8Array(0));
    expect(Array.from(p)).toEqual(hex(CDP_VOICE).slice(0, -6));
    expect(cdpCodec.decode(p, 0, p.length).fields.voiceVlan).toBeUndefined();
    expect(() => cdpCodec.encode({ deviceId: 'X', portId: 'Y', voiceVlan: 70000 }, new Uint8Array(0))).toThrow(/cdp.voiceVlan out of range/);
    // a phone's answer carries H P (host, phone)
    const phone = cdpCodec.encode({ deviceId: 'SEP0200000000B1', portId: 'Port 1', capabilities: 'H P' }, new Uint8Array(0));
    expect(cdpCodec.decode(phone, 0, phone.length).fields.capabilities).toBe('H P');
  });

  it('travels in the NF control frame (802.3, LLC/SNAP, PID 4) and decodes through the chain', () => {
    const b = encodeLayers([
      { proto: 'ethernet', fields: { dst: NF_L2_CONTROL_MAC, src: '02:00:00:00:00:a2', type: 0 } },
      { proto: 'llc', fields: {} },
      { proto: 'cdp', fields: { deviceId: 'SW1', portId: 'FastEthernet0/2', capabilities: 'S', nativeVlan: 10, duplex: 'full', voiceVlan: 30 } },
    ]);
    const layers = decodeLayers(b);
    expect(protos(layers)).toEqual(['ethernet', 'llc', 'cdp']);
    expect(Array.from(b.slice(layers[2]!.offset, layers[2]!.offset + layers[2]!.length))).toEqual(hex(CDP_VOICE));
    expect(layers[2]!.fields).toMatchObject({ voiceVlan: 30, nativeVlan: 10 });
  });
});

describe('[S35] LLDP-MED capabilities and network policy', () => {
  it('writes subtype 1 then subtype 2 after the standard TLVs, and decodes both', () => {
    const fields = {
      chassisSubtype: 4, chassisId: '02:00:00:00:00:a1', portSubtype: 5, portId: 'Fa0/2', ttl: 120, systemName: 'SW1',
      capabilities: LLDP_CAPABILITY.bridge, enabledCapabilities: LLDP_CAPABILITY.bridge,
      medCapabilities: LLDP_MED_CAPABILITY.capabilities | LLDP_MED_CAPABILITY.networkPolicy, medDeviceType: LLDP_MED_DEVICE.networkConnectivity, medVlan: 30,
    };
    const b = lldpCodec.encode({ ...fields }, new Uint8Array(0));
    expect(Array.from(b)).toEqual(hex(LLDP_MED));
    const d = lldpCodec.decode(b, 0, b.length);
    expect(d.error).toBeUndefined();
    expect(d.fields).toEqual(fields);
    expect(d.length).toBe(b.length);
    expect(LLDP_TLV.orgSpecific).toBe(127);
    expect(LLDP_MED_OUI).toEqual([0x00, 0x12, 0xbb]);
    expect(LLDP_MED_SUBTYPE).toEqual({ capabilities: 1, networkPolicy: 2 });
  });

  it('the endpoint side: capabilities alone (device type defaults to 0, not defined); a policy alone; VLAN bounds', () => {
    const caps = lldpCodec.encode({ chassisId: '02:00:00:00:00:b1', portId: 'Port 1', medCapabilities: 0x0033 }, new Uint8Array(0));
    const c = lldpCodec.decode(caps, 0, caps.length).fields;
    expect(c).toMatchObject({ medCapabilities: 0x0033, medDeviceType: 0 });
    expect(c.medVlan).toBeUndefined();
    const phone = lldpCodec.encode({ chassisId: '02:00:00:00:00:b1', portId: 'Port 1', medCapabilities: 0x0033, medDeviceType: LLDP_MED_DEVICE.endpointClass3 }, new Uint8Array(0));
    expect(lldpCodec.decode(phone, 0, phone.length).fields.medDeviceType).toBe(3);
    for (const vlan of [1, 4094, 0xfff]) {
      const p = lldpCodec.encode({ chassisId: '02:00:00:00:00:a1', portId: 'Fa0/2', medVlan: vlan }, new Uint8Array(0));
      const f = lldpCodec.decode(p, 0, p.length).fields;
      expect(f.medVlan, String(vlan)).toBe(vlan);
      expect(f.medCapabilities).toBeUndefined();
    }
    expect(() => lldpCodec.encode({ chassisId: '02:00:00:00:00:a1', portId: 'Fa0/2', medVlan: 4096 }, new Uint8Array(0))).toThrow(/lldp.medVlan out of range/);
  });

  it('skips every other organisation TLV and a policy for another application, as before', () => {
    const b = Uint8Array.from(hex(LLDP_OTHER_ORG));
    const d = lldpCodec.decode(b, 0, b.length);
    expect(d.error).toBeUndefined();
    expect(d.fields).toEqual({ chassisSubtype: 4, chassisId: '02:00:00:00:00:a1', portSubtype: 5, portId: 'Fa0/2', ttl: 120 });
    // application type 2 (voice signalling) is not the voice VLAN
    const sig = Uint8Array.from(hex(LLDP_MED));
    const at = hex(LLDP_MED).length - 2 - 8 + 4; // the application-type octet of the network-policy TLV
    sig[at] = 2;
    const f = lldpCodec.decode(sig, 0, sig.length).fields;
    expect(f.medVlan).toBeUndefined();
    expect(f.medCapabilities).toBe(3);
  });

  it('travels to the nearest-bridge group and decodes through the chain', () => {
    const b = encodeLayers([
      { proto: 'ethernet', fields: { dst: LLDP_NEAREST_BRIDGE_MAC, src: '02:00:00:00:00:a2', type: ETHERTYPE_LLDP } },
      { proto: 'lldp', fields: { chassisId: '02:00:00:00:00:a1', portId: 'Fa0/2', medCapabilities: 3, medDeviceType: 4, medVlan: 30 } },
    ]);
    const layers = decodeLayers(b);
    expect(protos(layers)).toEqual(['ethernet', 'lldp']);
    expect(layers[1]!.fields).toMatchObject({ medCapabilities: 3, medDeviceType: 4, medVlan: 30 });
  });

  it('every decoded field is a name of its table', () => {
    const cases: [Uint8Array, 'cdp' | 'lldp'][] = [
      [Uint8Array.from(hex(CDP_VOICE)), 'cdp'], [Uint8Array.from(hex(LLDP_MED)), 'lldp'], [Uint8Array.from(hex(LLDP_OTHER_ORG)), 'lldp'],
    ];
    for (const [bytes, proto] of cases) {
      const names = new Set(PROTO_FIELDS[proto]!.fields.map((x) => x.name));
      const codec = proto === 'cdp' ? cdpCodec : lldpCodec;
      for (const k of Object.keys(codec.decode(bytes, 0, bytes.length).fields)) expect(names.has(k), `${proto}.${k}`).toBe(true);
    }
  });
});
