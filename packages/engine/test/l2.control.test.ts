/**
 * W1 l2 (ARCHITECTURE-P2 D7, §2.4 "The L2 control table", §3.0 steps 2 and 5): classification of L2 control frames on
 * a bridged port of a VLAN-aware device, and what eth-switch does with each class.
 *
 * Frames are minimal decoded views (fields only): the codecs of these protocols are the same wave's pdu item.
 */
import { describe, expect, it } from 'vitest';
import type { FieldValue, LayerView, PduView } from '../src/contracts/pdu.js';
import {
  ETHERTYPE_SLOW_PROTOCOLS,
  LLC_SAP_STP,
  NF_L2_CONTROL_MAC,
  NF_OUI,
  NF_PID_DTP,
  NF_PID_PAGP,
  SLOW_PROTOCOLS_MAC,
  STP_GROUP_MAC,
} from '../src/contracts/pdu.js';
import type { ProcessName } from '../src/contracts/ids.js';
import {
  DETAIL_CONTROLLER_NO_STP,
  DETAIL_RESERVED_GROUP,
  L2_CONTROL,
  classifyControl,
  controlAction,
  controlNotRunningDetail,
  isPhysicalControl,
  isReservedLinkGroup,
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
const llc = (dsap: number): LayerView => layer('llc', { dsap, ssap: dsap, control: 3 });
const snap = (oui: number, type: number): LayerView => layer('llc', { dsap: 0xaa, ssap: 0xaa, control: 3, oui, type });

const BPDU = frame(eth(STP_GROUP_MAC, 38), llc(LLC_SAP_STP), layer('stp', { version: 0, bpduType: 0 }));
const TAGGED_BPDU = frame(eth(STP_GROUP_MAC, 0x8100), layer('dot1q', { vid: 10, type: 42 }), llc(LLC_SAP_STP), layer('stp', { version: 0, bpduType: 0, pvid: 10 }));
const LACPDU = frame(eth(SLOW_PROTOCOLS_MAC, ETHERTYPE_SLOW_PROTOCOLS), layer('lacp', { subtype: 1, version: 1 }));
const DTP = frame(eth(NF_L2_CONTROL_MAC, 40), snap(NF_OUI, NF_PID_DTP), layer('dtp', { version: 1 }));
const PAGP = frame(eth(NF_L2_CONTROL_MAC, 40), snap(NF_OUI, NF_PID_PAGP), layer('pagp', { version: 1 }));

describe('classifyControl (§2.4 table)', () => {
  it('classifies the four control protocols', () => {
    expect(classifyControl(BPDU)).toBe('stp');
    expect(classifyControl(TAGGED_BPDU)).toBe('stp');
    expect(classifyControl(LACPDU)).toBe('lacp');
    expect(classifyControl(DTP)).toBe('dtp');
    expect(classifyControl(PAGP)).toBe('pagp');
    // the LACP row keys on the ethertype and the subtype, not on the destination
    expect(classifyControl(frame(eth('02:00:00:00:00:02', ETHERTYPE_SLOW_PROTOCOLS), layer('lacp', { subtype: 1 })))).toBe('lacp');
  });

  it('other addresses of the reserved block 01:80:c2:00:00:01–0f are reserved', () => {
    // a slow-protocols frame that is not LACP (marker, OAM)
    expect(classifyControl(frame(eth(SLOW_PROTOCOLS_MAC, ETHERTYPE_SLOW_PROTOCOLS), layer('lacp', { subtype: 2 })))).toBe('reserved');
    expect(classifyControl(frame(eth(SLOW_PROTOCOLS_MAC, ETHERTYPE_SLOW_PROTOCOLS)))).toBe('reserved');
    // a tagged slow-protocols frame is not LACP
    expect(classifyControl(frame(eth(SLOW_PROTOCOLS_MAC, 0x8100), layer('dot1q', { vid: 1, type: ETHERTYPE_SLOW_PROTOCOLS }), layer('lacp', { subtype: 1 })))).toBe('reserved');
    expect(classifyControl(frame(eth('01:80:c2:00:00:01', 0x8808)))).toBe('reserved');
    expect(classifyControl(frame(eth('01:80:c2:00:00:0e', 0x88cc)))).toBe('reserved');
    expect(classifyControl(frame(eth('01:80:c2:00:00:0f', 0x0800)))).toBe('reserved');
  });

  it('anything else is ordinary traffic (undefined)', () => {
    expect(classifyControl(frame(eth('ff:ff:ff:ff:ff:ff', 0x0806), layer('arp', {})))).toBeUndefined();
    expect(classifyControl(frame(eth('02:00:00:00:00:02', 0x0800), layer('ipv4', {})))).toBeUndefined();
    expect(classifyControl(frame(eth('01:80:c2:00:00:10', 0x0800)))).toBeUndefined();
    // §2.4: the bridge group address is claimed by the STP row only. Without an LLC 0x42 header (a truncated BPDU, a
    // learner-crafted frame) it is NOT reserved — it falls through to "anything else" and bridges as multicast.
    expect(classifyControl(frame(eth(STP_GROUP_MAC, 20), llc(0xf0)))).toBeUndefined();
    expect(classifyControl(frame(eth(STP_GROUP_MAC, 0x0800), layer('ipv4', {})))).toBeUndefined();
    expect(classifyControl(frame(eth('01:00:5e:00:00:05', 0x0800)))).toBeUndefined();
    // the NF control group with a PID that has no approved class (VTP is COULD, not approved) or another OUI
    expect(classifyControl(frame(eth(NF_L2_CONTROL_MAC, 40), snap(NF_OUI, 0x0002)))).toBeUndefined();
    expect(classifyControl(frame(eth(NF_L2_CONTROL_MAC, 40), snap(NF_OUI, 0x0009)))).toBeUndefined();
    expect(classifyControl(frame(eth(NF_L2_CONTROL_MAC, 40), snap(0, NF_PID_DTP)))).toBeUndefined();
    // not an Ethernet frame
    expect(classifyControl(frame(layer('hdlc', { address: 0x0f })))).toBeUndefined();
    expect(classifyControl(frame())).toBeUndefined();
  });

  it('isReservedLinkGroup covers exactly 01:80:c2:00:00:00–0f', () => {
    expect(isReservedLinkGroup('01:80:c2:00:00:00')).toBe(true);
    expect(isReservedLinkGroup('01:80:C2:00:00:0F')).toBe(true);
    expect(isReservedLinkGroup('01:80:c2:00:00:10')).toBe(false);
    expect(isReservedLinkGroup('01:80:c2:00:01:00')).toBe(false);
    expect(isReservedLinkGroup(NF_L2_CONTROL_MAC)).toBe(false);
  });
});

describe('the control table (§2.4)', () => {
  it('rows: class → daemon and port passed', () => {
    expect(L2_CONTROL.map((r) => [r.cls, r.to ?? null, r.port, r.whenAbsent])).toEqual([
      ['stp', 'stp', 'logical', 'bridge'],
      ['lacp', 'etherchannel', 'physical', 'drop'],
      ['dtp', 'dtp', 'physical', 'drop'],
      ['pagp', 'etherchannel', 'physical', 'drop'],
      ['reserved', null, null, 'drop'],
    ]);
    expect(l2ControlRow('dtp').to).toBe('dtp');
    expect(Object.isFrozen(L2_CONTROL)).toBe(true);
  });

  it('every class but stp is handled on the physical port (§3.0 step 2)', () => {
    expect((['stp', 'lacp', 'dtp', 'pagp', 'reserved'] as const).map(isPhysicalControl)).toEqual([false, true, true, true, true]);
  });
});

describe('controlAction', () => {
  const SWITCH: readonly ProcessName[] = ['eth-switch', 'vlan', 'dtp', 'etherchannel', 'stp', 'arp', 'ipv4'];
  const managed = { processes: SWITCH, capabilities: ['switching', 'managed-switch'] as const };

  it('delivers each class to its daemon on the port the table names', () => {
    expect(controlAction('lacp', managed)).toEqual({ kind: 'deliver', to: 'etherchannel', port: 'physical' });
    expect(controlAction('pagp', managed)).toEqual({ kind: 'deliver', to: 'etherchannel', port: 'physical' });
    expect(controlAction('dtp', managed)).toEqual({ kind: 'deliver', to: 'dtp', port: 'physical' });
    expect(controlAction('stp', managed, true)).toEqual({ kind: 'deliver', to: 'stp', port: 'logical' });
  });

  it('a BPDU with no spanning-tree instance for its VLAN, or no stp daemon, is bridged', () => {
    expect(controlAction('stp', managed, false)).toEqual({ kind: 'bridge' });
    expect(controlAction('stp', managed)).toEqual({ kind: 'bridge' });
    expect(controlAction('stp', { processes: ['eth-switch', 'vlan'] }, true)).toEqual({ kind: 'bridge' });
  });

  it('a class whose daemon does not run is dropped unsupported-protocol', () => {
    const bare = { processes: ['eth-switch', 'vlan'] as const };
    expect(controlAction('lacp', bare)).toEqual({ kind: 'drop', reason: 'unsupported-protocol', detail: 'lacp is not running on this device' });
    expect(controlAction('dtp', bare)).toEqual({ kind: 'drop', reason: 'unsupported-protocol', detail: 'dtp is not running on this device' });
    expect(controlAction('pagp', bare)).toEqual({ kind: 'drop', reason: 'unsupported-protocol', detail: 'pagp is not running on this device' });
    expect(controlNotRunningDetail('lacp')).toBe('lacp is not running on this device');
  });

  it('reserved groups are dropped not-for-me', () => {
    expect(controlAction('reserved', managed)).toEqual({ kind: 'drop', reason: 'not-for-me', detail: 'reserved link-layer group' });
    expect(DETAIL_RESERVED_GROUP).toBe('reserved link-layer group');
  });

  it('a wireless controller never relays spanning tree (D17)', () => {
    const wlc = { processes: ['eth-switch', 'vlan', 'arp', 'ipv4', 'udp', 'capwap-ac'] as const, capabilities: ['switching', 'wireless-controller'] as const };
    expect(controlAction('stp', wlc, false)).toEqual({ kind: 'drop', reason: 'not-for-me', detail: DETAIL_CONTROLLER_NO_STP });
    expect(controlAction('stp', wlc, true)).toEqual({ kind: 'drop', reason: 'not-for-me', detail: 'the controller does not relay spanning tree' });
    expect(controlAction('dtp', wlc)).toEqual({ kind: 'drop', reason: 'unsupported-protocol', detail: 'dtp is not running on this device' });
  });
});
