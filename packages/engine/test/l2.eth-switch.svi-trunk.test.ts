/**
 * W2 l2 (ARCHITECTURE-P2 §3.0 steps 9, 11 and 12, §3.5, §13 #16): the SVI target on the VLAN-aware path — a broadcast
 * arriving tagged reaches the SVI untagged (cause `interface Vlan<V>`), a unicast for the SVI MAC is popped and
 * re-enters on `Vlan<V>`, a down or missing SVI, and `onEgress('Vlan<V>')` confined to the VLAN with normalised copies.
 */
import { describe, expect, it } from 'vitest';
import { MAC_BROADCAST } from '../src/contracts/addr.js';
import { camKey, vlanKey } from '../src/contracts/tables.js';
import type { VlanRow } from '../src/contracts/tables.js';
import { DETAIL_NO_EGRESS, DETAIL_NO_VLAN, DETAIL_SVI_DOWN_SUFFIX, createEthSwitch } from '../src/protocols/eth-switch.js';
import {
  FA1,
  FA2,
  GI1,
  MAC_A,
  MAC_B,
  MAC_C,
  SVI_MAC,
  hexOf,
  ingressOf,
  p2SwitchHarness,
  protosOf,
  provenanceOf,
  sendsOf,
} from './l2.eth-switch.p2.harness.js';
import type { P2SwitchHarness } from './l2.eth-switch.p2.harness.js';

const VLAN10 = 'Vlan10';
const VLAN1 = 'Vlan1';
const NAT_MAC = '02:4e:00:10:00:aa';

/** MLS1 with a trunk on Gi0/1, Fa0/1 in VLAN 10, Fa0/2 in VLAN 1, SVIs Vlan1 and Vlan10 up. */
function mls(h: P2SwitchHarness) {
  const sw = createEthSwitch();
  h.tables.get<VlanRow>('vlans')!.set({ key: vlanKey(10), vlan: 10, name: 'VLAN0010', status: 'active', source: 'config', updatedAt: 0 });
  h.lines(sw, GI1, ['switchport mode trunk']);
  h.lines(sw, FA1, ['switchport mode access', 'switchport access vlan 10']);
  h.addPort(VLAN1, 0, { kind: 'virtual', role: 'svi' });
  h.addPort(VLAN10, 0, { kind: 'virtual', role: 'svi' });
  sw.init!(h.ctx);
  return sw;
}

describe('SVI ingress on the VLAN-aware path', () => {
  it('a broadcast arriving tagged 10 on the trunk reaches Vlan10 untagged, and only Vlan10', () => {
    const h = p2SwitchHarness();
    const sw = mls(h);
    const untagged = h.frame(MAC_C, MAC_BROADCAST);
    const bytes = hexOf(untagged);
    const actions = sw.onPdu(h.ctx, h.frame(MAC_C, MAC_BROADCAST, 10), GI1);
    expect(sendsOf(actions).map((a) => a.port)).toEqual([FA1]);
    expect(ingressOf(actions).map((a) => a.port)).toEqual([VLAN10]);
    const toSvi = ingressOf(actions)[0]!.pdu;
    expect(protosOf(toSvi)).toEqual(['ethernet', 'arp']);
    expect(provenanceOf(toSvi)[0]).toEqual(['VlanTagPop', `interface ${VLAN10}`]);
    expect(hexOf(toSvi)).toBe(bytes);
    expect(h.tables.cam.get(camKey(10, MAC_C))).toMatchObject({ port: GI1 });
  });

  it('a unicast for the SVI MAC in VLAN 10 is popped and re-enters on Vlan10; in VLAN 1 on Vlan1', () => {
    const h = p2SwitchHarness();
    const sw = mls(h);
    const tagged = sw.onPdu(h.ctx, h.frame(MAC_C, SVI_MAC, 10), GI1);
    expect(tagged).toEqual([{ type: 'ingress', port: VLAN10, pdu: expect.anything() }]);
    expect(protosOf(ingressOf(tagged)[0]!.pdu)).toEqual(['ethernet', 'arp']);
    expect(provenanceOf(ingressOf(tagged)[0]!.pdu)[0]).toEqual(['VlanTagPop', `interface ${VLAN10}`]);
    expect(h.debug.at(-1)!.message).toBe(`delivering frame for ${SVI_MAC} from ${GI1} to ${VLAN10} (vlan 10)`);
    const plain = sw.onPdu(h.ctx, h.frame(MAC_B, SVI_MAC), FA2);
    expect(plain).toEqual([{ type: 'ingress', port: VLAN1, pdu: expect.anything() }]);
    expect(provenanceOf(ingressOf(plain)[0]!.pdu)).toEqual([]);
  });

  it('a down SVI drops the frame with the unchanged detail; a missing SVI makes it an unknown unicast', () => {
    const h = p2SwitchHarness();
    const sw = mls(h);
    h.setOper(VLAN10, false);
    expect(sw.onPdu(h.ctx, h.frame(MAC_C, SVI_MAC, 10), GI1)).toEqual([
      expect.objectContaining({ type: 'drop', reason: 'other', detail: `${VLAN10} ${DETAIL_SVI_DOWN_SUFFIX}` }),
    ]);
    h.ports.delete(VLAN10);
    const flooded = sw.onPdu(h.ctx, h.frame(MAC_C, SVI_MAC, 10), GI1);
    expect(sendsOf(flooded).map((a) => a.port)).toEqual([FA1]);
    expect(ingressOf(flooded)).toEqual([]);
  });

  it('a virtual4 MAC of the SVI (a NAT pool address) is delivered like the SVI MAC', () => {
    const h = p2SwitchHarness();
    const sw = mls(h);
    const view = h.ports.get(VLAN10)!;
    h.ports.set(VLAN10, { ...view, l3: { virtual4: [{ address: '203.0.113.5', mac: NAT_MAC, owner: 'nat', local: false }] } });
    expect(sw.onPdu(h.ctx, h.frame(MAC_A, NAT_MAC), FA1)).toEqual([{ type: 'ingress', port: VLAN10, pdu: expect.anything() }]);
  });
});

describe("onEgress('Vlan<V>')", () => {
  it('a known unicast sent on Vlan10 leaves on its CAM port, tagged toward the trunk, untagged toward access', () => {
    const h = p2SwitchHarness();
    const sw = mls(h);
    sw.onPdu(h.ctx, h.frame(MAC_C, MAC_BROADCAST, 10), GI1);
    sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), FA1);
    const toTrunk = sw.onEgress!(h.ctx, h.frame(SVI_MAC, MAC_C), VLAN10);
    expect(toTrunk).toEqual([{ type: 'send', port: GI1, pdu: expect.anything() }]);
    const out = sendsOf(toTrunk)[0]!.pdu;
    expect(out.get('dot1q.vid')).toBe(10);
    expect(provenanceOf(out)[0]).toEqual(['VlanTagPush', 'switchport mode trunk']);
    expect(h.debug.at(-1)!.message).toBe(`bridging frame for ${MAC_C} from ${VLAN10} out ${GI1} (vlan 10)`);
    const toAccess = sw.onEgress!(h.ctx, h.frame(SVI_MAC, MAC_A), VLAN10);
    expect(toAccess).toEqual([{ type: 'send', port: FA1, pdu: expect.anything() }]);
    expect(provenanceOf(sendsOf(toAccess)[0]!.pdu)).toEqual([]);
  });

  it('a broadcast sent on Vlan10 floods only the VLAN-10 candidates, each copy normalised; on Vlan1 the others', () => {
    const h = p2SwitchHarness();
    const sw = mls(h);
    const from10 = sw.onEgress!(h.ctx, h.frame(SVI_MAC, MAC_BROADCAST), VLAN10);
    expect(sendsOf(from10).map((a) => a.port)).toEqual([FA1, GI1]);
    expect(provenanceOf(sendsOf(from10)[0]!.pdu)).toEqual([]);
    expect(sendsOf(from10)[1]!.pdu.get('dot1q.vid')).toBe(10);
    expect(ingressOf(from10)).toEqual([]);
    const from1 = sw.onEgress!(h.ctx, h.frame(SVI_MAC, MAC_BROADCAST), VLAN1);
    expect(sendsOf(from1).map((a) => a.port)).toEqual([FA2, FA3_OF(h), GI1, 'GigabitEthernet0/2']);
    expect(sendsOf(from1).every((a) => provenanceOf(a.pdu).length === 0)).toBe(true);
  });

  it('a CAM port that no longer carries the VLAN, or a port that is not an SVI, drops', () => {
    const h = p2SwitchHarness();
    const sw = mls(h);
    sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), FA1);
    h.setOper(FA1, false);
    expect(sw.onEgress!(h.ctx, h.frame(SVI_MAC, MAC_A), VLAN10)).toEqual([
      expect.objectContaining({ type: 'drop', reason: 'other', detail: DETAIL_NO_EGRESS, port: VLAN10 }),
    ]);
    expect(sw.onEgress!(h.ctx, h.frame(SVI_MAC, MAC_A), 'Loopback0')).toEqual([
      expect.objectContaining({ type: 'drop', reason: 'other', detail: DETAIL_NO_VLAN }),
    ]);
  });
});

/** Fa0/3 of the harness (a VLAN-1 port here). */
function FA3_OF(h: P2SwitchHarness): string {
  return [...h.ports.keys()].find((p) => p === 'FastEthernet0/3')!;
}
