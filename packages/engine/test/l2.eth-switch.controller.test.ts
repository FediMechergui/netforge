/**
 * W2 l2 (ARCHITECTURE-P2 D17, §3.0 steps 4, 5 and 11, §2.4 control table): eth-switch on a `wireless-controller`
 * model — every distribution port is an intrinsic trunk (`CONTROLLER_PORT_SWITCHPORT`), only the ACTIVE distribution
 * port (the lowest oper-up one) carries traffic, a backup distribution port drops, the controller never bridges port to
 * port (distribution ↔ tunnel only), and it never relays spanning tree.
 */
import { describe, expect, it } from 'vitest';
import { MAC_BROADCAST } from '../src/contracts/addr.js';
import type { DeviceModel } from '../src/contracts/device.js';
import { LLC_SAP_STP, STP_GROUP_MAC } from '../src/contracts/pdu.js';
import { SPEED_1G } from '../src/contracts/port.js';
import { camKey, vlanKey } from '../src/contracts/tables.js';
import type { VlanRow } from '../src/contracts/tables.js';
import { backupDistributionDetail, createEthSwitch } from '../src/protocols/eth-switch.js';
import { DETAIL_CONTROLLER_NO_STP } from '../src/protocols/l2/control.js';
import { CAUSE_CONTROLLER_TUNNEL, untaggedOnTunnelDetail } from '../src/protocols/l2/membership.js';
import { MAC_A, MAC_B, MAC_C, ingressOf, p2SwitchHarness, provenanceOf, sendsOf } from './l2.eth-switch.p2.harness.js';
import type { P2SwitchHarness } from './l2.eth-switch.p2.harness.js';
import { testModel } from './port.fixtures.js';

const D1 = 'GigabitEthernet0/1';
const D2 = 'GigabitEthernet0/2';
const TUNNEL = 'Capwap0';
const VLAN20 = 'Vlan20';

/** A hand-built controller: two distribution ports, the tunnel, eth-switch and vlan (no stp daemon). */
const WLC: DeviceModel = testModel({
  type: 'wlc.nftest',
  model: 'NF-WLC-TEST',
  description: 'Controller fixture',
  kind: 'switch',
  hostnamePrefix: 'WLC',
  portsDefaultUp: true,
  bootNs: 0,
  ipForwarding: false,
  processingNs: 0,
  capabilities: ['wireless-controller', 'switching'],
  processes: ['eth-switch', 'vlan'],
  ports: [
    { name: D1, short: 'Gi0/1', kind: 'ethernet', speedBps: SPEED_1G, autoMdix: true, role: 'switched' },
    { name: D2, short: 'Gi0/2', kind: 'ethernet', speedBps: SPEED_1G, autoMdix: true, role: 'switched' },
  ],
});

function controller(): { h: P2SwitchHarness; sw: ReturnType<typeof createEthSwitch> } {
  const h = p2SwitchHarness({ model: WLC, ports: [D1, D2] });
  h.addPort(TUNNEL, 0, { kind: 'virtual', role: 'wlan-tunnel', mac: '02:4e:00:20:00:00' });
  h.addPort(VLAN20, 0, { kind: 'virtual', role: 'svi', mac: '02:4e:00:20:00:00' });
  h.tables.get<VlanRow>('vlans')!.set({ key: vlanKey(20), vlan: 20, name: 'VLAN0020', status: 'active', source: 'config', updatedAt: 0 });
  const sw = createEthSwitch();
  sw.init!(h.ctx);
  return { h, sw };
}

function bpdu(h: P2SwitchHarness) {
  return h.ctx.newPdu([
    { proto: 'ethernet', fields: { dst: STP_GROUP_MAC, src: MAC_A, type: 0 } },
    { proto: 'llc', fields: { dsap: LLC_SAP_STP, ssap: LLC_SAP_STP, control: 3 } },
    { proto: 'stp', fields: { version: 0, bpduType: 0, rootPriority: 32769, rootMac: MAC_A, rootPathCost: 0, bridgePriority: 32769, bridgeMac: MAC_A, portId: 0x8001, messageAge: 0, maxAge: 5120, helloTime: 512, forwardDelay: 3840 } },
  ]);
}

describe('D17 — the controller bridge', () => {
  it('a frame on the active distribution port is bridged to the tunnel only (tagged, cause "controller tunnel") and to the SVI', () => {
    const { h, sw } = controller();
    const actions = sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST, 20), D1);
    expect(sendsOf(actions).map((a) => a.port)).toEqual([TUNNEL]);
    expect(ingressOf(actions).map((a) => a.port)).toEqual([VLAN20]);
    expect(sendsOf(actions)[0]!.pdu.get('dot1q.vid')).toBe(20);
    expect(provenanceOf(sendsOf(actions)[0]!.pdu)).toEqual([]);
    expect(provenanceOf(ingressOf(actions)[0]!.pdu)[0]).toEqual(['VlanTagPop', `interface ${VLAN20}`]);
    expect(h.tables.cam.get(camKey(20, MAC_A))).toMatchObject({ port: D1 });
    // untagged on a distribution port = the native VLAN 1 of the intrinsic trunk
    const native = sw.onPdu(h.ctx, h.frame(MAC_B, MAC_BROADCAST), D1);
    expect(sendsOf(native).map((a) => a.port)).toEqual([TUNNEL]);
    expect(provenanceOf(sendsOf(native)[0]!.pdu)[0]).toEqual(['VlanTagPush', CAUSE_CONTROLLER_TUNNEL]);
    expect(h.tables.cam.get(camKey(1, MAC_B))).toMatchObject({ port: D1 });
  });

  it('a frame from the tunnel goes to the active distribution port only (hairpin back to the tunnel), never port to port', () => {
    const { h, sw } = controller();
    const actions = sw.onPdu(h.ctx, h.frame(MAC_C, MAC_BROADCAST, 20), TUNNEL);
    expect(sendsOf(actions).map((a) => a.port)).toEqual([D1, TUNNEL]);
    expect(sendsOf(actions)[0]!.pdu.get('dot1q.vid')).toBe(20);
    // an untagged frame on the tunnel is refused
    expect(sw.onPdu(h.ctx, h.frame(MAC_C, MAC_BROADCAST), TUNNEL)).toEqual([
      expect.objectContaining({ type: 'drop', reason: 'vlan-filtered', detail: untaggedOnTunnelDetail(TUNNEL) }),
    ]);
    // a known unicast learned on the tunnel, arriving on a distribution port, leaves on the tunnel
    const toC = sw.onPdu(h.ctx, h.frame(MAC_A, MAC_C, 20), D1);
    expect(sendsOf(toC).map((a) => a.port)).toEqual([TUNNEL]);
  });

  it('a backup distribution port drops every frame and is never a flood target; it takes over when the active one goes down', () => {
    const { h, sw } = controller();
    expect(sw.onPdu(h.ctx, h.frame(MAC_B, MAC_BROADCAST, 20), D2)).toEqual([
      expect.objectContaining({ type: 'drop', reason: 'other', detail: backupDistributionDetail(D2), port: D2 }),
    ]);
    expect(h.tables.cam.size).toBe(0);
    const fromTunnel = sw.onPdu(h.ctx, h.frame(MAC_C, MAC_BROADCAST, 20), TUNNEL);
    expect(sendsOf(fromTunnel).map((a) => a.port)).toEqual([D1, TUNNEL]);
    h.setOper(D1, false);
    expect(sendsOf(sw.onPdu(h.ctx, h.frame(MAC_C, MAC_BROADCAST, 20), TUNNEL)).map((a) => a.port)).toEqual([D2, TUNNEL]);
    expect(sendsOf(sw.onPdu(h.ctx, h.frame(MAC_B, MAC_BROADCAST, 20), D2)).map((a) => a.port)).toEqual([TUNNEL]);
  });

  it('a unicast whose CAM port is another distribution port drops (no port-to-port bridging)', () => {
    const { h, sw } = controller();
    h.tables.cam.set({ key: camKey(20, MAC_B), mac: MAC_B, vlan: 20, port: D2, type: 'dynamic', updatedAt: 0, expiresAt: 1 });
    expect(sw.onPdu(h.ctx, h.frame(MAC_A, MAC_B, 20), D1)).toEqual([expect.objectContaining({ type: 'drop', reason: 'other', detail: 'no egress port' })]);
  });

  it('the controller never relays spanning tree: a BPDU drops not-for-me', () => {
    const { h, sw } = controller();
    expect(sw.onPdu(h.ctx, bpdu(h), D1)).toEqual([
      expect.objectContaining({ type: 'drop', reason: 'not-for-me', detail: DETAIL_CONTROLLER_NO_STP, port: D1 }),
    ]);
    expect(h.tables.cam.size).toBe(0);
  });
});
