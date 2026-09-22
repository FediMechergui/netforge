/**
 * W2 l2 (ARCHITECTURE-P2 §3.0 "frame path v3", §3.1 access port with a VLAN, D5, D12): the VLAN-aware eth-switch
 * path on access ports — per-VLAN CAM, classification, existence, the control-frame dispatch, member translation,
 * the spanning-tree gate, and every row of the CAM flush table.
 */
import { describe, expect, it } from 'vitest';
import { MAC_BROADCAST } from '../src/contracts/addr.js';
import { LLC_SAP_STP, NF_L2_CONTROL_MAC, NF_OUI, NF_PID_DTP, STP_GROUP_MAC } from '../src/contracts/pdu.js';
import type { Pdu } from '../src/contracts/pdu.js';
import type { Action } from '../src/contracts/process.js';
import { camKey, stpKey, vlanKey } from '../src/contracts/tables.js';
import type { CamRow, EtherchannelRow, StpBridgeRow, StpPortRow, VlanRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import {
  DETAIL_FILTERED,
  DETAIL_NOT_STP_PORT,
  DETAIL_NO_EGRESS,
  DETAIL_STP_LEARNING,
  ETH_SWITCH_DEBUG_CATEGORY,
  createEthSwitch,
  memberNotForwardingDetail,
} from '../src/protocols/eth-switch.js';
import { DETAIL_RESERVED_GROUP, controlNotRunningDetail } from '../src/protocols/l2/control.js';
import { taggedOnAccessDetail, vlanMissingDetail } from '../src/protocols/l2/membership.js';
import {
  FA1,
  FA2,
  FA3,
  GI1,
  GI2,
  MAC_A,
  MAC_B,
  MAC_C,
  VLAN_AWARE_MODEL,
  ingressOf,
  p2SwitchHarness,
  provenanceOf,
  sendsOf,
} from './l2.eth-switch.p2.harness.js';
import type { P2SwitchHarness } from './l2.eth-switch.p2.harness.js';

const PO1 = 'Port-channel1';

function vlanRow(vlan: number, name = `VLAN${String(vlan).padStart(4, '0')}`): VlanRow {
  return { key: vlanKey(vlan), vlan, name, status: 'active', source: 'config', updatedAt: 0 };
}

/** SW1 of §3.1: VLAN 10 exists, Fa0/1–2 access 10, Fa0/3 at its defaults. */
function sales(h: P2SwitchHarness, sw = createEthSwitch()) {
  h.tables.get<VlanRow>('vlans')!.set(vlanRow(10, 'SALES'));
  h.lines(sw, FA1, ['switchport mode access', 'switchport access vlan 10']);
  h.lines(sw, FA2, ['switchport mode access', 'switchport access vlan 10']);
  sw.init!(h.ctx);
  return sw;
}

describe('VLAN-aware model and path selection (D5)', () => {
  it('the P2-stage NF-C2960 runs the vlan daemon and declares the vlans and port-security tables', () => {
    expect(VLAN_AWARE_MODEL.processes).toContain('vlan');
    expect(VLAN_AWARE_MODEL.capabilities).toContain('managed-switch');
    expect(VLAN_AWARE_MODEL.tables).toEqual(expect.arrayContaining(['vlans', 'port-security']));
  });

  it('keeps the transparent drops and the HDLC relay on the VLAN-aware path', () => {
    const h = p2SwitchHarness();
    const sw = createEthSwitch();
    sw.init!(h.ctx);
    h.addPort('Vlan1', 0, { kind: 'virtual', role: 'svi' });
    const onSvi = sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), 'Vlan1');
    expect(onSvi).toEqual([expect.objectContaining({ type: 'drop', reason: 'other', detail: 'port is not part of the bridge' })]);
    const noEth = h.ctx.newPdu([{ proto: 'arp', fields: { op: 1, sha: MAC_A, spa: '10.0.0.1', tha: '00:00:00:00:00:00', tpa: '10.0.0.2' } }]);
    expect(sw.onPdu(h.ctx, noEth, FA1)).toEqual([expect.objectContaining({ type: 'drop', detail: 'frame has no ethernet header' })]);
  });
});

describe('§3.1 access port with a VLAN', () => {
  it('floods a VLAN-10 broadcast only to the other VLAN-10 port, untouched, and keys the CAM per VLAN', () => {
    const h = p2SwitchHarness();
    const sw = sales(h);
    const pdu = h.frame(MAC_A, MAC_BROADCAST);
    const bytes = Array.from(pdu.bytes);
    const actions = sw.onPdu(h.ctx, pdu, FA1);
    expect(sendsOf(actions).map((a) => a.port)).toEqual([FA2]);
    expect(sendsOf(actions)[0]!.pdu).toBe(pdu);
    expect(Array.from(pdu.bytes)).toEqual(bytes);
    expect(provenanceOf(pdu)).toEqual([]);
    expect(h.tables.cam.get(camKey(10, MAC_A))).toMatchObject({ port: FA1, vlan: 10, type: 'dynamic' });
    expect(h.tables.cam.get(camKey(1, MAC_A))).toBeUndefined();
    expect(h.debug.map((d) => d.message)).toEqual(expect.arrayContaining([
      `learned ${MAC_A} on ${FA1} (vlan 10)`,
      `flooding broadcast frame for ${MAC_BROADCAST} from ${FA1} to 1 port(s): ${FA2}`,
    ]));
    expect(h.debug.every((d) => d.category === ETH_SWITCH_DEBUG_CATEGORY)).toBe(true);
  });

  it('a VLAN-1 broadcast never reaches the VLAN-10 ports (PC3 → arp-unresolved at PC3)', () => {
    const h = p2SwitchHarness();
    const sw = sales(h);
    const actions = sw.onPdu(h.ctx, h.frame(MAC_C, MAC_BROADCAST), FA3);
    expect(sendsOf(actions).map((a) => a.port)).toEqual([GI1, GI2]);
    expect(h.tables.cam.get(camKey(1, MAC_C))).toMatchObject({ port: FA3, vlan: 1 });
  });

  it('forwards a known unicast in its VLAN and filters it back to its own port', () => {
    const h = p2SwitchHarness();
    const sw = sales(h);
    sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), FA1);
    sw.onPdu(h.ctx, h.frame(MAC_B, MAC_BROADCAST), FA2);
    const fwd = sw.onPdu(h.ctx, h.frame(MAC_B, MAC_A), FA2);
    expect(fwd).toEqual([{ type: 'send', port: FA1, pdu: expect.anything() }]);
    expect(h.debug.at(-1)!.message).toBe(`forwarding frame for ${MAC_A} from ${FA2} out ${FA1} (vlan 10)`);
    const filtered = sw.onPdu(h.ctx, h.frame(MAC_B, MAC_A), FA1);
    expect(filtered).toEqual([expect.objectContaining({ type: 'drop', reason: 'other', detail: DETAIL_FILTERED, port: FA1 })]);
    expect(sw.stateSnapshot().state).toMatchObject({ vlan: 1, filtered: 1, forwards: 1, floods: 2, learned: 2 });
  });

  it('a CAM hit on a port that no longer carries the VLAN drops "no egress port"', () => {
    const h = p2SwitchHarness();
    const sw = sales(h);
    sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), FA1);
    // FA1 moves to VLAN 20 by hand-editing the CAM row's port to FA3 (VLAN 1 only): the row is stale for VLAN 10
    h.tables.cam.set({ ...h.tables.cam.get(camKey(10, MAC_A))!, port: FA3 });
    const actions = sw.onPdu(h.ctx, h.frame(MAC_B, MAC_A), FA2);
    expect(actions).toEqual([expect.objectContaining({ type: 'drop', reason: 'other', detail: DETAIL_NO_EGRESS })]);
  });

  it('a frame tagged 20 on an access port drops vlan-filtered with the §3.1 detail', () => {
    const h = p2SwitchHarness();
    const sw = sales(h);
    const actions = sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST, 20), FA1);
    expect(actions).toEqual([expect.objectContaining({ type: 'drop', reason: 'vlan-filtered', detail: taggedOnAccessDetail(20, 10), port: FA1 })]);
    expect(h.tables.cam.size).toBe(0);
  });

  it('a VLAN that does not exist drops every frame of its ports with "VLAN 10 does not exist"', () => {
    const h = p2SwitchHarness();
    const sw = sales(h);
    h.tables.get<VlanRow>('vlans')!.delete(vlanKey(10), 'cleared');
    const actions = sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), FA1);
    expect(actions).toEqual([expect.objectContaining({ type: 'drop', reason: 'vlan-filtered', detail: vlanMissingDetail(10) })]);
    // VLAN 1 and the reserved VLANs are implicit
    h.lines(sw, FA3, ['switchport mode access', 'switchport access vlan 1002']);
    expect(sendsOf(sw.onPdu(h.ctx, h.frame(MAC_C, MAC_BROADCAST), FA3))).toEqual([]);
    expect(h.tables.cam.get(camKey(1002, MAC_C))).toMatchObject({ port: FA3 });
  });

  it('the SVI of the frame VLAN gets the ingress clone of a group frame; other SVIs do not', () => {
    const h = p2SwitchHarness();
    const sw = sales(h);
    h.addPort('Vlan1', 0, { kind: 'virtual', role: 'svi' });
    h.addPort('Vlan10', 0, { kind: 'virtual', role: 'svi' });
    const from10 = sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), FA1);
    expect(ingressOf(from10).map((a) => a.port)).toEqual(['Vlan10']);
    const from1 = sw.onPdu(h.ctx, h.frame(MAC_C, MAC_BROADCAST), FA3);
    expect(ingressOf(from1).map((a) => a.port)).toEqual(['Vlan1']);
    h.setOper('Vlan10', false);
    expect(ingressOf(sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), FA1))).toEqual([]);
  });
});

describe('§3.0 step 2 — physical control dispatch', () => {
  function dtpFrame(h: P2SwitchHarness): Pdu {
    return h.ctx.newPdu([
      { proto: 'ethernet', fields: { dst: NF_L2_CONTROL_MAC, src: MAC_A, type: 0 } },
      { proto: 'llc', fields: { dsap: 0xaa, ssap: 0xaa, control: 3, oui: NF_OUI, type: NF_PID_DTP } },
      { proto: 'dtp', fields: { adminMode: 3, operTrunk: false, neighbor: MAC_A } },
    ]);
  }

  it('a DTP frame is dropped unsupported-protocol when dtp does not run, delivered on the arrival port when it does', () => {
    const h = p2SwitchHarness();
    const sw = createEthSwitch();
    sw.init!(h.ctx);
    expect(sw.onPdu(h.ctx, dtpFrame(h), FA1)).toEqual([
      expect.objectContaining({ type: 'drop', reason: 'unsupported-protocol', detail: controlNotRunningDetail('dtp'), port: FA1 }),
    ]);
    const withDtp = p2SwitchHarness({ model: { ...VLAN_AWARE_MODEL, processes: [...VLAN_AWARE_MODEL.processes, 'dtp'] } });
    const sw2 = createEthSwitch();
    sw2.init!(withDtp.ctx);
    // even on a suspended member the physical port is passed (step 2 runs before member translation)
    withDtp.tables.get<EtherchannelRow>('etherchannel')!.set({ key: FA1, port: FA1, group: 1, bundle: PO1, protocol: 'lacp', mode: 'active', state: 'suspended', updatedAt: 0 });
    const pdu = dtpFrame(withDtp);
    expect(sw2.onPdu(withDtp.ctx, pdu, FA1)).toEqual([{ type: 'deliver', to: 'dtp', pdu, port: FA1 }]);
    expect(withDtp.tables.cam.size).toBe(0);
  });

  it('a reserved link-layer group frame is dropped not-for-me', () => {
    const h = p2SwitchHarness();
    const sw = createEthSwitch();
    sw.init!(h.ctx);
    const pdu = h.ctx.newPdu([{ proto: 'ethernet', fields: { dst: '01:80:c2:00:00:0e', src: MAC_A, type: 0x88cc } }, { proto: 'payload', fields: { bytes: new Uint8Array(4) } }]);
    expect(sw.onPdu(h.ctx, pdu, FA1)).toEqual([expect.objectContaining({ type: 'drop', reason: 'not-for-me', detail: DETAIL_RESERVED_GROUP })]);
  });
});

describe('§3.0 steps 3–6 — member translation, spanning-tree dispatch and gate', () => {
  function bpdu(h: P2SwitchHarness, vid?: number): Pdu {
    const llc = { proto: 'llc' as const, fields: { dsap: LLC_SAP_STP, ssap: LLC_SAP_STP, control: 3 } };
    const stp = { proto: 'stp' as const, fields: { version: 0, bpduType: 0, rootPriority: 32769, rootMac: MAC_B, rootPathCost: 0, bridgePriority: 32769, bridgeMac: MAC_B, portId: 0x8001, messageAge: 0, maxAge: 5120, helloTime: 512, forwardDelay: 3840 } };
    return vid === undefined
      ? h.ctx.newPdu([{ proto: 'ethernet', fields: { dst: STP_GROUP_MAC, src: MAC_B, type: 0 } }, llc, stp])
      : h.ctx.newPdu([{ proto: 'ethernet', fields: { dst: STP_GROUP_MAC, src: MAC_B, type: 0x8100 } }, { proto: 'dot1q', fields: { vid, type: 0 } }, llc, stp]);
  }

  it('a bundled member is translated to its Port-channel; waiting and suspended members drop', () => {
    const h = p2SwitchHarness();
    const sw = createEthSwitch();
    sw.init!(h.ctx);
    h.addPort(PO1, 30, { kind: 'virtual', role: 'channel', mac: '00:1f:00:00:01:30' });
    const ec = h.tables.get<EtherchannelRow>('etherchannel')!;
    ec.set({ key: GI1, port: GI1, group: 1, bundle: PO1, protocol: 'lacp', mode: 'active', state: 'bundled', updatedAt: 0 });
    ec.set({ key: GI2, port: GI2, group: 1, bundle: PO1, protocol: 'lacp', mode: 'active', state: 'waiting', updatedAt: 0 });
    const actions = sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), GI1);
    expect(h.tables.cam.get(camKey(1, MAC_A))).toMatchObject({ port: PO1 });
    // members in a non-individual state are not candidates; the bundle is (once, not per member)
    expect(sendsOf(actions).map((a) => a.port)).toEqual([FA1, FA2, FA3]);
    expect(sw.onPdu(h.ctx, h.frame(MAC_C, MAC_BROADCAST), GI2)).toEqual([
      expect.objectContaining({ type: 'drop', reason: 'other', detail: memberNotForwardingDetail(GI2, PO1, 'waiting') }),
    ]);
    // a frame from FA1 for a MAC learned on the bundle leaves on the bundle
    const toA = sw.onPdu(h.ctx, h.frame(MAC_C, MAC_A), FA1);
    expect(sendsOf(toA).map((a) => a.port)).toEqual([PO1]);
  });

  it('a BPDU is bridged as a multicast without an instance, and handed to stp with the logical port when one runs', () => {
    const h = p2SwitchHarness({ model: { ...VLAN_AWARE_MODEL, processes: [...VLAN_AWARE_MODEL.processes, 'stp'] } });
    const sw = createEthSwitch();
    sw.init!(h.ctx);
    const noInstance = sw.onPdu(h.ctx, bpdu(h), FA1);
    expect(sendsOf(noInstance).map((a) => a.port)).toEqual([FA2, FA3, GI1, GI2]);
    expect(h.tables.cam.get(camKey(1, MAC_B))).toMatchObject({ port: FA1 });
    h.tables.get<StpBridgeRow>('stp-bridge')!.set({ key: vlanKey(1), vlan: 1, mode: 'pvst', bridgeId: '32769/00:1f:00:00:01:00', rootId: '32769/00:1f:00:00:01:00', isRoot: true, rootCost: 0, helloS: 2, maxAgeS: 20, forwardDelayS: 15, topologyChanges: 0, updatedAt: 0 });
    const pdu = bpdu(h);
    // delivered even though FA1 has no stp row yet (blocking)
    expect(sw.onPdu(h.ctx, pdu, FA1)).toEqual([{ type: 'deliver', to: 'stp', pdu, port: FA1 }]);
    // a tagged per-VLAN BPDU classifies by its tag: VLAN 10 has no instance → bridged in VLAN 10 (no candidate here)
    h.tables.get<VlanRow>('vlans')!.set(vlanRow(10));
    h.lines(sw, GI1, ['switchport mode trunk']);
    h.lines(sw, FA1, ['switchport mode access', 'switchport access vlan 10']);
    const tagged = sw.onPdu(h.ctx, bpdu(h, 10), GI1);
    expect(sendsOf(tagged).map((a) => a.port)).toEqual([FA1]);
    expect(provenanceOf(sendsOf(tagged)[0]!.pdu).map((m) => m[0])).toEqual(['VlanTagPop', 'FcsRecompute']);
    expect(provenanceOf(sendsOf(tagged)[0]!.pdu)[0]).toEqual(['VlanTagPop', 'switchport access vlan 10']);
  });

  it('the spanning-tree gate: forwarding passes, learning learns then drops, others drop with the state', () => {
    const h = p2SwitchHarness({ model: { ...VLAN_AWARE_MODEL, processes: [...VLAN_AWARE_MODEL.processes, 'stp'] } });
    const sw = createEthSwitch();
    sw.init!(h.ctx);
    h.tables.get<StpBridgeRow>('stp-bridge')!.set({ key: vlanKey(1), vlan: 1, mode: 'pvst', bridgeId: 'b', rootId: 'b', isRoot: true, rootCost: 0, helloS: 2, maxAgeS: 20, forwardDelayS: 15, topologyChanges: 0, updatedAt: 0 });
    const stp = h.tables.get<StpPortRow>('stp')!;
    const row = (port: string, state: StpPortRow['state']): StpPortRow => ({
      key: stpKey(1, port), vlan: 1, port, role: 'designated', state, protocol: 'stp', cost: 19, portId: '128.1', designatedBridge: 'b', designatedPort: '128.1', edge: false, stateSince: 0, updatedAt: 0,
    });
    stp.set(row(FA1, 'forwarding'));
    stp.set(row(FA2, 'forwarding'));
    stp.set(row(FA3, 'learning'));
    stp.set(row(GI1, 'blocking'));
    // GI2 has no row: not a spanning-tree port → not a candidate either
    const fwd = sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), FA1);
    expect(sendsOf(fwd).map((a) => a.port)).toEqual([FA2]);
    const learning = sw.onPdu(h.ctx, h.frame(MAC_C, MAC_BROADCAST), FA3);
    expect(learning).toEqual([expect.objectContaining({ type: 'drop', reason: 'stp-discarding', detail: DETAIL_STP_LEARNING })]);
    expect(h.tables.cam.get(camKey(1, MAC_C))).toMatchObject({ port: FA3 });
    expect(sw.onPdu(h.ctx, h.frame(MAC_B, MAC_BROADCAST), GI1)).toEqual([expect.objectContaining({ type: 'drop', reason: 'stp-discarding', detail: 'blocking' })]);
    expect(sw.onPdu(h.ctx, h.frame(MAC_B, MAC_BROADCAST), GI2)).toEqual([expect.objectContaining({ type: 'drop', reason: 'stp-discarding', detail: DETAIL_NOT_STP_PORT })]);
    expect(h.tables.cam.get(camKey(1, MAC_B))).toBeUndefined();
  });
});

describe('§3.0 CAM flush table', () => {
  function seeded(): { h: P2SwitchHarness; sw: ReturnType<typeof createEthSwitch> } {
    const h = p2SwitchHarness();
    const sw = sales(h);
    sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), FA1); // 10/A on FA1
    sw.onPdu(h.ctx, h.frame(MAC_B, MAC_BROADCAST), FA2); // 10/B on FA2
    sw.onPdu(h.ctx, h.frame(MAC_C, MAC_BROADCAST), FA3); // 1/C on FA3
    h.tables.cam.set({ key: camKey(10, MAC_X_STATIC), mac: MAC_X_STATIC, vlan: 10, port: FA1, type: 'static', updatedAt: 0 });
    h.trace.length = 0;
    return { h, sw };
  }
  const MAC_X_STATIC = '00:1f:00:00:00:0e';
  const keys = (h: P2SwitchHarness) => h.tables.cam.rows().map((r) => r.key).sort();

  it('a membership line of port X flushes only the dynamic rows of X (never a static row, never a port-security line)', () => {
    const { h, sw } = seeded();
    h.lines(sw, FA1, ['switchport access vlan 20']);
    expect(keys(h)).toEqual([camKey(1, MAC_C), camKey(10, MAC_B), camKey(10, MAC_X_STATIC)].sort());
    expect(h.kinds('tableExpire')).toEqual([expect.objectContaining({ table: 'cam', key: camKey(10, MAC_A), reason: 'cleared' })]);
    h.trace.length = 0;
    h.lines(sw, FA2, ['switchport port-security', 'switchport port-security maximum 3']);
    expect(h.tables.cam.get(camKey(10, MAC_B))).toBeDefined();
    h.lines(sw, FA3, ['switchport nonegotiate']);
    expect(h.tables.cam.get(camKey(1, MAC_C))).toBeUndefined();
    // a line of another kind on the interface flushes nothing
    h.lines(sw, FA2, ['description uplink']);
    expect(h.tables.cam.get(camKey(10, MAC_B))).toBeDefined();
  });

  it('l2.changed trunk flushes the port; channel flushes the member and its bundle; security flushes nothing', () => {
    const { h, sw } = seeded();
    sw.onEvent!(h.ctx, { kind: 'l2.changed', what: 'trunk', port: FA2, from: 'dtp' });
    expect(h.tables.cam.get(camKey(10, MAC_B))).toBeUndefined();
    expect(h.tables.cam.get(camKey(10, MAC_A))).toBeDefined();
    h.addPort(PO1, 30, { kind: 'virtual', role: 'channel', mac: '00:1f:00:00:01:30' });
    h.tables.get<EtherchannelRow>('etherchannel')!.set({ key: FA3, port: FA3, group: 1, bundle: PO1, protocol: 'lacp', mode: 'active', state: 'bundled', updatedAt: 0 });
    h.tables.cam.set({ key: camKey(1, MAC_B), mac: MAC_B, vlan: 1, port: PO1, type: 'dynamic', updatedAt: 0, expiresAt: 300 * SEC });
    sw.onEvent!(h.ctx, { kind: 'l2.changed', what: 'security', port: FA1, from: 'eth-switch' });
    expect(h.tables.cam.get(camKey(10, MAC_A))).toBeDefined();
    sw.onEvent!(h.ctx, { kind: 'l2.changed', what: 'channel', port: FA3, from: 'etherchannel' });
    expect(h.tables.cam.get(camKey(1, MAC_C))).toBeUndefined();
    expect(h.tables.cam.get(camKey(1, MAC_B))).toBeUndefined();
    expect(h.tables.cam.get(camKey(10, MAC_A))).toBeDefined();
  });

  it('l2.changed stp flushes (vlan, port) only when the port is not forwarding; vlans only when the VLAN is gone', () => {
    const { h, sw } = seeded();
    const stp = h.tables.get<StpPortRow>('stp')!;
    stp.set({ key: stpKey(10, FA1), vlan: 10, port: FA1, role: 'designated', state: 'forwarding', protocol: 'stp', cost: 19, portId: '128.1', designatedBridge: 'b', designatedPort: '128.1', edge: false, stateSince: 0, updatedAt: 0 });
    sw.onEvent!(h.ctx, { kind: 'l2.changed', what: 'stp', port: FA1, vlan: 10, from: 'stp' });
    expect(h.tables.cam.get(camKey(10, MAC_A))).toBeDefined();
    stp.set({ ...stp.get(stpKey(10, FA1))!, state: 'blocking' });
    sw.onEvent!(h.ctx, { kind: 'l2.changed', what: 'stp', port: FA1, vlan: 10, from: 'stp' });
    expect(h.tables.cam.get(camKey(10, MAC_A))).toBeUndefined();
    expect(h.tables.cam.get(camKey(10, MAC_B))).toBeDefined();
    sw.onEvent!(h.ctx, { kind: 'l2.changed', what: 'vlans', vlan: 10, from: 'vlan' });
    expect(h.tables.cam.get(camKey(10, MAC_B))).toBeDefined();
    h.tables.get<VlanRow>('vlans')!.delete(vlanKey(10), 'cleared');
    sw.onEvent!(h.ctx, { kind: 'l2.changed', what: 'vlans', vlan: 10, from: 'vlan' });
    expect(keys(h)).toEqual([camKey(1, MAC_C), camKey(10, MAC_X_STATIC)].sort());
  });

  it('l2.flush: flush removes the VLAN rows on exactly the named ports; fast-age caps expiresAt', () => {
    const { h, sw } = seeded();
    sw.onEvent!(h.ctx, { kind: 'l2.flush', vlan: 10, mode: 'flush', ports: [FA2, FA3] });
    expect(keys(h)).toEqual([camKey(1, MAC_C), camKey(10, MAC_A), camKey(10, MAC_X_STATIC)].sort());
    h.setNow(100 * SEC);
    sw.onEvent!(h.ctx, { kind: 'l2.flush', vlan: 10, mode: 'fast-age', ports: [FA1], ageingNs: 15 * SEC });
    expect(h.tables.cam.get(camKey(10, MAC_A))).toMatchObject({ expiresAt: 115 * SEC, updatedAt: 100 * SEC });
    expect(h.tables.cam.get(camKey(10, MAC_X_STATIC))!.expiresAt).toBeUndefined();
    // a row that already expires sooner is left alone
    sw.onEvent!(h.ctx, { kind: 'l2.flush', vlan: 10, mode: 'fast-age', ports: [FA1], ageingNs: 100 * SEC });
    expect(h.tables.cam.get(camKey(10, MAC_A))!.expiresAt).toBe(115 * SEC);
  });

  it('link-down removes every dynamic row of the port and keeps the static one', () => {
    const { h, sw } = seeded();
    expect(sw.onLinkChange!(h.ctx, FA1, false)).toEqual([]);
    expect(keys(h)).toEqual([camKey(1, MAC_C), camKey(10, MAC_B), camKey(10, MAC_X_STATIC)].sort());
    expect(h.debug.at(-1)!.message).toBe(`removed ${MAC_A} on ${FA1} (vlan 10): link down`);
  });

  it('configured static rows follow their `mac address-table static` lines', () => {
    const h = p2SwitchHarness();
    const sw = sales(h);
    const line = ['mac', 'address-table', 'static', MAC_C, 'vlan', '10', 'interface', FA2];
    h.configure(sw, [], line);
    expect(h.tables.cam.get(camKey(10, MAC_C))).toMatchObject({ port: FA2, type: 'static' });
    const fwd = sw.onPdu(h.ctx, h.frame(MAC_A, MAC_C), FA1);
    expect(sendsOf(fwd).map((a) => a.port)).toEqual([FA2]);
    // a frame from the static address never rewrites the row
    sw.onPdu(h.ctx, h.frame(MAC_C, MAC_BROADCAST), FA1);
    expect(h.tables.cam.get(camKey(10, MAC_C))).toMatchObject({ port: FA2, type: 'static' });
    h.configure(sw, [], line, true);
    expect(h.tables.cam.get(camKey(10, MAC_C))).toBeUndefined();
  });

  it('a group frame is never learned as a source and static rows survive the ageing sweep', () => {
    const h = p2SwitchHarness();
    const sw = sales(h);
    sw.onPdu(h.ctx, h.frame('01:00:5e:00:00:01', MAC_BROADCAST), FA1);
    expect(h.tables.cam.size).toBe(0);
    h.configure(sw, [], ['mac', 'address-table', 'static', MAC_C, 'vlan', '10', 'interface', FA2]);
    h.setNow(400 * SEC);
    const actions: Action[] = sw.onTimer(h.ctx, 'cam-sweep');
    expect(actions).toHaveLength(1);
    expect(h.tables.cam.size).toBe(1);
  });

  it('`mac address-table aging-time` changes the ageing of new rows', () => {
    const h = p2SwitchHarness();
    const sw = sales(h);
    h.configure(sw, [], ['mac', 'address-table', 'aging-time', '20']);
    sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), FA1);
    expect(h.tables.cam.get(camKey(10, MAC_A))!.expiresAt).toBe(20 * SEC);
    expect(sw.stateSnapshot().state).toMatchObject({ ageingNs: 20 * SEC });
  });
});
