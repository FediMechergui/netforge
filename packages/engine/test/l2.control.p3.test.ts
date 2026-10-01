/**
 * W1 l2 (ARCHITECTURE-P3 D18, §3.0 (b), §3.6 step 3, §7 W1 l2): the control-table rows of the discovery protocols.
 *  - `classifyControl` returns 'cdp' for the NF CDP PID under the NF control group, and 'lldp' for ethertype 0x88cc to
 *    01:80:c2:00:00:0e (the only LLDP form; the rest of the reserved block stays 'reserved');
 *  - the two rows sit before 'reserved', deliver to their daemon on the physical port, and drop `not-for-me` with
 *    `controlNotRunningDetail` where the daemon does not run (the controller runs cdp but not lldp);
 *  - the P2 rows (`L2_CONTROL`) and every P2 class keep their behaviour.
 *
 * Frames are minimal decoded views: classification reads the outer Ethernet fields and the SNAP header only, so no
 * discovery codec is needed (the codecs are the same wave's pdu item).
 */
import { describe, expect, it } from 'vitest';
import type { FieldValue, LayerView, PduView } from '../src/contracts/pdu.js';
import {
  ETHERTYPE_LLDP,
  LLDP_NEAREST_BRIDGE_MAC,
  NF_L2_CONTROL_MAC,
  NF_OUI,
  NF_PID_CDP,
  NF_PID_DTP,
  NF_PID_PAGP,
  STP_GROUP_MAC,
} from '../src/contracts/pdu.js';
import type { ProcessName } from '../src/contracts/ids.js';
import {
  L2_CONTROL,
  L2_CONTROL_TABLE,
  classifyControl,
  controlAction,
  controlNotRunningDetail,
  isPhysicalControl,
  l2ControlRow,
} from '../src/protocols/l2/control.js';

function layer(proto: string, fields: Record<string, FieldValue>): LayerView {
  return { proto, offset: 0, length: 0, headerLength: 0, fields, fieldRanges: {} };
}
function frame(...layers: LayerView[]): Pick<PduView, 'layers'> {
  return { layers };
}
const SRC = '02:4e:59:e8:af:01';
const eth = (dst: string, type: number): LayerView => layer('ethernet', { dst, src: SRC, type });
const snap = (oui: number, type: number): LayerView => layer('llc', { dsap: 0xaa, ssap: 0xaa, control: 3, oui, type });

/** §3.6 step 2: `[ethernet {dst 03:4e:46:00:00:01, type = length}, llc {aa aa 03, oui NF_OUI, type 4}, cdp {…}]`. */
const CDP = frame(eth(NF_L2_CONTROL_MAC, 60), snap(NF_OUI, NF_PID_CDP), layer('cdp', { version: 2, ttl: 180, deviceId: 'R1' }));
/** §3.6 step 7: an IEEE frame to the nearest-bridge group. */
const LLDP = frame(eth(LLDP_NEAREST_BRIDGE_MAC, ETHERTYPE_LLDP), layer('lldp', { chassisSubtype: 4, portSubtype: 5, ttl: 120 }));

describe('classifyControl — the discovery classes (D18)', () => {
  it('the NF CDP frame is cdp; the codec is not needed (SNAP PID only)', () => {
    expect(classifyControl(CDP)).toBe('cdp');
    expect(classifyControl(frame(eth(NF_L2_CONTROL_MAC, 60), snap(NF_OUI, NF_PID_CDP)))).toBe('cdp');
    expect(classifyControl(frame(eth(NF_L2_CONTROL_MAC.toUpperCase(), 60), snap(NF_OUI, NF_PID_CDP)))).toBe('cdp');
    // PID 4 under another OUI, or the NF OUI to another destination, is not CDP
    expect(classifyControl(frame(eth(NF_L2_CONTROL_MAC, 60), snap(0, NF_PID_CDP)))).toBeUndefined();
    expect(classifyControl(frame(eth('01:00:0c:cc:cc:cc', 60), snap(NF_OUI, NF_PID_CDP)))).toBeUndefined();
    expect(classifyControl(frame(eth('ff:ff:ff:ff:ff:ff', 60), snap(NF_OUI, NF_PID_CDP)))).toBeUndefined();
    // the NF control group without an LLC layer is still ordinary
    expect(classifyControl(frame(eth(NF_L2_CONTROL_MAC, 0x0800)))).toBeUndefined();
  });

  it('LLDP is exactly ethertype 0x88cc to 01:80:c2:00:00:0e (with or without its codec)', () => {
    expect(classifyControl(LLDP)).toBe('lldp');
    expect(classifyControl(frame(eth('01:80:c2:00:00:0e', 0x88cc)))).toBe('lldp');
    expect(classifyControl(frame(eth('01:80:C2:00:00:0E', 0x88cc), layer('payload', {})))).toBe('lldp');
  });

  it('the rest of the reserved block stays reserved, the LLDP ethertype included', () => {
    // the LLDP ethertype to another group of the block (nearest non-TPMR, nearest customer bridge)
    expect(classifyControl(frame(eth('01:80:c2:00:00:03', 0x88cc)))).toBe('reserved');
    expect(classifyControl(frame(eth('01:80:c2:00:00:01', 0x88cc)))).toBe('reserved');
    // another ethertype to the LLDP group, a tagged frame to it, an 802.3 length frame to it
    expect(classifyControl(frame(eth('01:80:c2:00:00:0e', 0x0800)))).toBe('reserved');
    expect(classifyControl(frame(eth('01:80:c2:00:00:0e', 0x8100), layer('dot1q', { vid: 1, type: 0x88cc })))).toBe('reserved');
    expect(classifyControl(frame(eth('01:80:c2:00:00:0e', 40), snap(NF_OUI, NF_PID_CDP)))).toBe('reserved');
    expect(classifyControl(frame(eth('01:80:c2:00:00:0f', 0x0800)))).toBe('reserved');
    // the bridge group address with the LLDP ethertype is not a BPDU and not reserved (the STP row claims :00)
    expect(classifyControl(frame(eth(STP_GROUP_MAC, 0x88cc)))).toBeUndefined();
    // the LLDP ethertype to a unicast or broadcast address is ordinary traffic
    expect(classifyControl(frame(eth('02:00:00:00:00:02', 0x88cc)))).toBeUndefined();
    expect(classifyControl(frame(eth('ff:ff:ff:ff:ff:ff', 0x88cc)))).toBeUndefined();
  });

  it('the P2 classes are unchanged', () => {
    expect(classifyControl(frame(eth(NF_L2_CONTROL_MAC, 40), snap(NF_OUI, NF_PID_DTP)))).toBe('dtp');
    expect(classifyControl(frame(eth(NF_L2_CONTROL_MAC, 40), snap(NF_OUI, NF_PID_PAGP)))).toBe('pagp');
    expect(classifyControl(frame(eth(NF_L2_CONTROL_MAC, 40), snap(NF_OUI, 0x0002)))).toBeUndefined();
    expect(classifyControl(frame(eth(NF_L2_CONTROL_MAC, 40), snap(NF_OUI, 0x0005)))).toBeUndefined();
  });
});

describe('the control table rows (D18)', () => {
  it('the full table gains cdp and lldp before reserved; L2_CONTROL keeps the P2 rows', () => {
    expect(L2_CONTROL_TABLE.map((r) => [r.cls, r.to ?? null, r.port, r.whenAbsent])).toEqual([
      ['stp', 'stp', 'logical', 'bridge'],
      ['lacp', 'etherchannel', 'physical', 'drop'],
      ['dtp', 'dtp', 'physical', 'drop'],
      ['pagp', 'etherchannel', 'physical', 'drop'],
      ['cdp', 'cdp', 'physical', 'drop'],
      ['lldp', 'lldp', 'physical', 'drop'],
      ['reserved', null, null, 'drop'],
    ]);
    expect(L2_CONTROL.map((r) => r.cls)).toEqual(['stp', 'lacp', 'dtp', 'pagp', 'reserved']);
    expect(L2_CONTROL.every((r) => L2_CONTROL_TABLE.includes(r))).toBe(true);
    expect(l2ControlRow('cdp')).toEqual({ cls: 'cdp', to: 'cdp', port: 'physical', whenAbsent: 'drop' });
    expect(l2ControlRow('lldp')).toEqual({ cls: 'lldp', to: 'lldp', port: 'physical', whenAbsent: 'drop' });
    expect(Object.isFrozen(L2_CONTROL_TABLE)).toBe(true);
    expect(L2_CONTROL_TABLE.every((r) => Object.isFrozen(r))).toBe(true);
    expect(Object.isFrozen(L2_CONTROL)).toBe(true);
  });

  it('cdp and lldp are handled on the physical port (never bridged)', () => {
    expect(isPhysicalControl('cdp')).toBe(true);
    expect(isPhysicalControl('lldp')).toBe(true);
  });
});

describe('controlAction for the discovery classes', () => {
  const SWITCH: readonly ProcessName[] = ['eth-switch', 'vlan', 'dtp', 'etherchannel', 'stp', 'arp', 'ipv4'];

  it('delivered to the daemon on the physical port where it runs', () => {
    const p3 = { processes: [...SWITCH, 'cdp', 'lldp'], capabilities: ['switching', 'managed-switch'] as const };
    expect(controlAction('cdp', p3)).toEqual({ kind: 'deliver', to: 'cdp', port: 'physical' });
    expect(controlAction('lldp', p3)).toEqual({ kind: 'deliver', to: 'lldp', port: 'physical' });
  });

  it('dropped not-for-me with "<class> is not running on this device" where it does not (the P2 classes keep unsupported-protocol)', () => {
    const p2 = { processes: SWITCH, capabilities: ['switching', 'managed-switch'] as const };
    expect(controlAction('cdp', p2)).toEqual({ kind: 'drop', reason: 'not-for-me', detail: 'cdp is not running on this device' });
    expect(controlAction('lldp', p2)).toEqual({ kind: 'drop', reason: 'not-for-me', detail: 'lldp is not running on this device' });
    expect(controlNotRunningDetail('lldp')).toBe('lldp is not running on this device');
    expect(controlAction('dtp', { processes: ['eth-switch', 'vlan'] })).toEqual({ kind: 'drop', reason: 'unsupported-protocol', detail: 'dtp is not running on this device' });
    expect(controlAction('lacp', { processes: ['eth-switch', 'vlan'] })).toMatchObject({ kind: 'drop', reason: 'unsupported-protocol' });
    expect(controlAction('pagp', { processes: ['eth-switch', 'vlan'] })).toMatchObject({ kind: 'drop', reason: 'unsupported-protocol' });
  });

  it('the controller runs cdp but not lldp (D18)', () => {
    const wlc = {
      processes: ['eth-switch', 'vlan', 'cdp', 'arp', 'ipv4', 'icmpv4', 'host', 'udp', 'logger', 'ntp', 'capwap-ac'] as const,
      capabilities: ['switching', 'wireless-controller'] as const,
    };
    expect(controlAction('cdp', wlc)).toEqual({ kind: 'deliver', to: 'cdp', port: 'physical' });
    expect(controlAction('lldp', wlc)).toEqual({ kind: 'drop', reason: 'not-for-me', detail: 'lldp is not running on this device' });
    // spanning tree at the controller is unchanged
    expect(controlAction('stp', wlc, true)).toEqual({ kind: 'drop', reason: 'not-for-me', detail: 'the controller does not relay spanning tree' });
  });
});
