/**
 * W2 l2 (ARCHITECTURE-P2 §3.2 trunk with a native VLAN and an allowed list, §3.0 steps 4, 11 and 12, D4): tag push
 * and pop with the exact provenance, the native VLAN, the allowed list, voice VLAN [S4] and the fan-out order rule
 * (clones allocated before any tag).
 */
import { describe, expect, it } from 'vitest';
import { MAC_BROADCAST } from '../src/contracts/addr.js';
import { camKey, vlanKey } from '../src/contracts/tables.js';
import type { DtpRow, VlanRow } from '../src/contracts/tables.js';
import { createEthSwitch } from '../src/protocols/eth-switch.js';
import { CAUSE_NEGOTIATED_TRUNK, nativeNotAllowedDetail, vlanNotAllowedDetail } from '../src/protocols/l2/membership.js';
import {
  FA1,
  FA2,
  FA3,
  GI1,
  GI2,
  MAC_A,
  MAC_B,
  MAC_C,
  hexOf,
  p2SwitchHarness,
  protosOf,
  provenanceOf,
  sendsOf,
} from './l2.eth-switch.p2.harness.js';
import type { P2SwitchHarness } from './l2.eth-switch.p2.harness.js';

function vlanRow(vlan: number): VlanRow {
  return { key: vlanKey(vlan), vlan, name: `VLAN${String(vlan).padStart(4, '0')}`, status: 'active', source: 'config', updatedAt: 0 };
}

/** SW1 of §3.2: Gi0/1 trunk, native 99, allowed 1,10,20,99; Fa0/1 access 10; Fa0/2 access 20; Fa0/3 default. */
function sw1(h: P2SwitchHarness, allowed = '1,10,20,99') {
  const sw = createEthSwitch();
  const vlans = h.tables.get<VlanRow>('vlans')!;
  for (const v of [10, 20, 99]) vlans.set(vlanRow(v));
  h.lines(sw, GI1, ['switchport mode trunk', 'switchport trunk native vlan 99', `switchport trunk allowed vlan ${allowed}`]);
  h.lines(sw, FA1, ['switchport mode access', 'switchport access vlan 10']);
  h.lines(sw, FA2, ['switchport mode access', 'switchport access vlan 20']);
  sw.init!(h.ctx);
  return sw;
}

describe('§3.2 trunk: push on the way out, pop on the way in', () => {
  it('a VLAN-10 broadcast leaves the trunk tagged 10 with the §3.2 provenance and 64 bytes on the wire', () => {
    const h = p2SwitchHarness();
    const sw = sw1(h);
    const pdu = h.frame(MAC_A, MAC_BROADCAST);
    const before = hexOf(pdu);
    const actions = sw.onPdu(h.ctx, pdu, FA1);
    expect(sendsOf(actions).map((a) => a.port)).toEqual([GI1]);
    const out = sendsOf(actions)[0]!.pdu;
    expect(out).toBe(pdu);
    expect(protosOf(out)).toEqual(['ethernet', 'dot1q', 'arp']);
    expect(out.get('dot1q.vid')).toBe(10);
    expect(out.bytes.length).toBe(64);
    expect(out.provenance).toHaveLength(2);
    expect(out.provenance[0]).toMatchObject({ reason: 'VlanTagPush', field: 'dot1q.vid', before: null, after: 10, cause: 'switchport mode trunk', device: 'd_sw1' });
    expect(out.provenance[1]).toMatchObject({ reason: 'FcsRecompute', field: 'ethernet.fcs' });
    expect(hexOf(out)).not.toBe(before);
  });

  it('a priority-tagged frame (VID 0) is untagged for classification: it crosses the trunk with its access VLAN and stays untagged toward access ports', () => {
    const h = p2SwitchHarness();
    const sw = sw1(h);
    h.lines(sw, FA3, ['switchport mode access', 'switchport access vlan 10']);
    const pdu = h.frame(MAC_A, MAC_BROADCAST, 0);
    expect(protosOf(pdu)).toEqual(['ethernet', 'dot1q', 'arp']);
    const actions = sw.onPdu(h.ctx, pdu, FA1);
    const sends = sendsOf(actions);
    expect(sends.map((a) => a.port).sort()).toEqual([FA3, GI1]);
    expect(h.tables.cam.get(camKey(10, MAC_A))).toMatchObject({ port: FA1, vlan: 10 });
    // toward the trunk: the priority tag goes, VLAN 10 comes on, both with the trunk line as cause
    const trunk = sends.find((a) => a.port === GI1)!.pdu;
    expect(protosOf(trunk)).toEqual(['ethernet', 'dot1q', 'arp']);
    expect(trunk.get('dot1q.vid')).toBe(10);
    expect(trunk.provenance.map((m) => m.reason)).toEqual(['VlanTagPop', 'FcsRecompute', 'VlanTagPush', 'FcsRecompute']);
    expect(trunk.provenance[0]).toMatchObject({ reason: 'VlanTagPop', field: 'dot1q.vid', before: 0, after: null, cause: 'switchport mode trunk' });
    expect(trunk.provenance[2]).toMatchObject({ reason: 'VlanTagPush', field: 'dot1q.vid', before: null, after: 10, cause: 'switchport mode trunk' });
    // toward the access port: the priority tag goes, nothing comes on
    const access = sends.find((a) => a.port === FA3)!.pdu;
    expect(protosOf(access)).toEqual(['ethernet', 'arp']);
    expect(access.provenance.map((m) => m.reason)).toEqual(['VlanTagPop', 'FcsRecompute']);
    expect(access.provenance[0]).toMatchObject({ before: 0, after: null, cause: 'switchport access vlan 10' });
  });

  it('a frame arriving tagged 10 is learned on the trunk and popped toward the access port; the bytes come back', () => {
    const h = p2SwitchHarness();
    const sw = sw1(h);
    const original = h.frame(MAC_C, MAC_BROADCAST);
    const bytes = hexOf(original);
    // what SW1 would put on the wire
    const tagged = h.frame(MAC_C, MAC_BROADCAST, 10);
    const actions = sw.onPdu(h.ctx, tagged, GI1);
    expect(sendsOf(actions).map((a) => a.port)).toEqual([FA1]);
    expect(h.tables.cam.get(camKey(10, MAC_C))).toMatchObject({ port: GI1, vlan: 10 });
    const out = sendsOf(actions)[0]!.pdu;
    expect(protosOf(out)).toEqual(['ethernet', 'arp']);
    expect(out.provenance[0]).toMatchObject({ reason: 'VlanTagPop', field: 'dot1q.vid', before: 10, after: null, cause: 'switchport access vlan 10' });
    expect(out.provenance[1]).toMatchObject({ reason: 'FcsRecompute' });
    expect(hexOf(out)).toBe(bytes);
  });

  it('push then pop through two switches gives the receiver byte-identical bytes under one PduId', () => {
    const a = p2SwitchHarness();
    const b = p2SwitchHarness();
    const swA = sw1(a);
    const swB = sw1(b);
    const pdu = a.frame(MAC_A, MAC_BROADCAST);
    const id = pdu.id;
    const bytes = hexOf(pdu);
    const onWire = sendsOf(swA.onPdu(a.ctx, pdu, FA1))[0]!.pdu;
    expect(onWire.id).toBe(id);
    const delivered = sendsOf(swB.onPdu(b.ctx, onWire, GI1));
    expect(delivered.map((d) => d.port)).toEqual([FA1]);
    expect(delivered[0]!.pdu.id).toBe(id);
    expect(hexOf(delivered[0]!.pdu)).toBe(bytes);
    expect(provenanceOf(delivered[0]!.pdu).map((m) => m[0])).toEqual(['VlanTagPush', 'FcsRecompute', 'VlanTagPop', 'FcsRecompute']);
  });

  it('the native VLAN crosses untagged both ways; a tagged native frame is accepted as the native VLAN', () => {
    const h = p2SwitchHarness();
    const sw = sw1(h);
    h.lines(sw, FA3, ['switchport mode access', 'switchport access vlan 99']);
    const out = sendsOf(sw.onPdu(h.ctx, h.frame(MAC_C, MAC_BROADCAST), FA3));
    expect(out.map((o) => o.port)).toEqual([GI1]);
    expect(provenanceOf(out[0]!.pdu)).toEqual([]);
    expect(protosOf(out[0]!.pdu)).toEqual(['ethernet', 'arp']);
    const back = sendsOf(sw.onPdu(h.ctx, h.frame(MAC_B, MAC_BROADCAST), GI1));
    expect(back.map((o) => o.port)).toEqual([FA3]);
    expect(provenanceOf(back[0]!.pdu)).toEqual([]);
    expect(h.tables.cam.get(camKey(99, MAC_B))).toMatchObject({ port: GI1 });
    const taggedNative = sendsOf(sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST, 99), GI1));
    expect(taggedNative.map((o) => o.port)).toEqual([FA3]);
    expect(provenanceOf(taggedNative[0]!.pdu)[0]).toEqual(['VlanTagPop', 'switchport access vlan 99']);
  });

  it('with the native VLAN outside the allowed list, untagged frames on the trunk drop and VLAN 99 never crosses', () => {
    const h = p2SwitchHarness();
    const sw = sw1(h, '10,20');
    h.lines(sw, FA3, ['switchport mode access', 'switchport access vlan 99']);
    expect(sw.onPdu(h.ctx, h.frame(MAC_B, MAC_BROADCAST), GI1)).toEqual([
      expect.objectContaining({ type: 'drop', reason: 'vlan-filtered', detail: nativeNotAllowedDetail(99, GI1) }),
    ]);
    expect(sendsOf(sw.onPdu(h.ctx, h.frame(MAC_C, MAC_BROADCAST), FA3))).toEqual([]);
    expect(h.tables.cam.get(camKey(99, MAC_C))).toMatchObject({ port: FA3 });
  });

  it('the allowed list: VLAN 30 has no trunk candidate and a frame tagged 30 drops vlan-filtered', () => {
    const h = p2SwitchHarness();
    const sw = sw1(h);
    h.tables.get<VlanRow>('vlans')!.set(vlanRow(30));
    h.lines(sw, FA3, ['switchport mode access', 'switchport access vlan 30']);
    expect(sendsOf(sw.onPdu(h.ctx, h.frame(MAC_C, MAC_BROADCAST), FA3))).toEqual([]);
    expect(sw.onPdu(h.ctx, h.frame(MAC_B, MAC_BROADCAST, 30), GI1)).toEqual([
      expect.objectContaining({ type: 'drop', reason: 'vlan-filtered', detail: vlanNotAllowedDetail(30, GI1) }),
    ]);
    // a trunk carries only VLANs that exist
    h.lines(sw, GI1, ['switchport trunk allowed vlan 1,10,20,30,99']);
    expect(sendsOf(sw.onPdu(h.ctx, h.frame(MAC_C, MAC_BROADCAST), FA3)).map((s) => s.port)).toEqual([GI1]);
    h.tables.get<VlanRow>('vlans')!.delete(vlanKey(30), 'cleared');
    expect(sw.onPdu(h.ctx, h.frame(MAC_C, MAC_BROADCAST), FA3)).toEqual([expect.objectContaining({ type: 'drop', reason: 'vlan-filtered' })]);
  });

  it('a trunk negotiated by DTP tags with cause "negotiated trunk"; a dynamic port without a dtp row is access', () => {
    const h = p2SwitchHarness();
    const sw = sw1(h);
    h.tables.get<VlanRow>('vlans')!.set(vlanRow(10));
    // Gi0/2 at its default (dynamic auto): access VLAN 1 until negotiated
    const beforeNeg = sendsOf(sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), FA1));
    expect(beforeNeg.map((o) => o.port)).toEqual([GI1]);
    h.tables.get<DtpRow>('dtp')!.set({ key: GI2, port: GI2, admin: 'dynamic-auto', oper: 'trunk', status: 'negotiated', updatedAt: 0 });
    const afterNeg = sendsOf(sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), FA1));
    expect(afterNeg.map((o) => o.port)).toEqual([GI1, GI2]);
    expect(provenanceOf(afterNeg[1]!.pdu)[0]).toEqual(['VlanTagPush', CAUSE_NEGOTIATED_TRUNK]);
  });

  it('every clone is allocated before any tag (PduIds independent of tags), and the untagged copies keep the bytes', () => {
    const h = p2SwitchHarness();
    const sw = sw1(h);
    h.lines(sw, FA3, ['switchport mode access', 'switchport access vlan 10']);
    h.lines(sw, GI2, ['switchport mode trunk']);
    const pdu = h.frame(MAC_A, MAC_BROADCAST);
    const bytes = hexOf(pdu);
    const out = sendsOf(sw.onPdu(h.ctx, pdu, FA1));
    expect(out.map((o) => o.port)).toEqual([FA3, GI1, GI2]);
    // the original goes to the first target untouched; the clones were taken before any tag (their provenance holds
    // only their own push) and their ids follow target order, independent of which targets are tagged
    expect(out[0]!.pdu).toBe(pdu);
    expect(hexOf(out[0]!.pdu)).toBe(bytes);
    expect(provenanceOf(out[0]!.pdu)).toEqual([]);
    for (const copy of [out[1]!.pdu, out[2]!.pdu]) {
      expect(copy.get('dot1q.vid')).toBe(10);
      expect(copy.meta.parent).toBe(pdu.id);
      expect(provenanceOf(copy).map((m) => m[0])).toEqual(['VlanTagPush', 'FcsRecompute']);
    }
    expect(Number(out[1]!.pdu.id)).toBeLessThan(Number(out[2]!.pdu.id));
    // the same fan-out with no trunk at all allocates the same ids for the same targets
    const h2 = p2SwitchHarness();
    const sw2 = sw1(h2);
    h2.lines(sw2, FA3, ['switchport mode access', 'switchport access vlan 10']);
    h2.lines(sw2, GI2, ['switchport mode access', 'switchport access vlan 10']);
    h2.lines(sw2, GI1, ['switchport mode access', 'switchport access vlan 10']);
    const out2 = sendsOf(sw2.onPdu(h2.ctx, h2.frame(MAC_A, MAC_BROADCAST), FA1));
    expect(out2.map((o) => o.pdu.id)).toEqual(out.map((o) => o.pdu.id));
  });

  it('[S4] an access port with a voice VLAN accepts and emits the voice VLAN tagged, with its cause', () => {
    const h = p2SwitchHarness();
    const sw = sw1(h, '1,10,20,50,99');
    h.tables.get<VlanRow>('vlans')!.set(vlanRow(50));
    h.lines(sw, FA3, ['switchport mode access', 'switchport access vlan 10', 'switchport voice vlan 50']);
    const fromPhone = sendsOf(sw.onPdu(h.ctx, h.frame(MAC_C, MAC_BROADCAST, 50), FA3));
    expect(fromPhone.map((o) => o.port)).toEqual([GI1]);
    expect(h.tables.cam.get(camKey(50, MAC_C))).toMatchObject({ port: FA3 });
    expect(provenanceOf(fromPhone[0]!.pdu)).toEqual([]);
    const toPhone = sendsOf(sw.onPdu(h.ctx, h.frame(MAC_B, MAC_C, 50), GI1));
    expect(toPhone.map((o) => o.port)).toEqual([FA3]);
    expect(provenanceOf(toPhone[0]!.pdu)).toEqual([]);
    const untaggedIn = sendsOf(sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), FA3));
    expect(untaggedIn.map((o) => o.port)).toEqual([FA1, GI1]);
    // a VLAN-50 frame from a VLAN-50 access port is tagged toward the phone port with the voice cause
    h.lines(sw, FA2, ['switchport access vlan 50']);
    const toPhone2 = sendsOf(sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), FA2));
    expect(toPhone2.map((o) => o.port)).toEqual([FA3, GI1]);
    expect(provenanceOf(toPhone2[0]!.pdu)[0]).toEqual(['VlanTagPush', 'switchport voice vlan 50']);
  });
});
