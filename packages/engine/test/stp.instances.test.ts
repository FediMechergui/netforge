/**
 * W3 stp (ARCHITECTURE-P2 D9, §4.2, §4.3, §5.1): the instance set of a switch on real P2-profile worlds — one
 * instance per existing, enabled VLAN with an up port carrying it; the 128 cap in ascending VLAN order with one log
 * line; hello timers armed ascending; instances that come and go with VLANs, ports and `no spanning-tree vlan`; and
 * the silence rule in the P1 profile.
 */
import { describe, expect, it } from 'vitest';
import { TABLE_DESCRIPTORS } from '../src/contracts/tables.js';
import type { StpBridgeRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { STP_MAX_INSTANCES } from '../src/protocols/stp.js';
import { instanceCapMessage } from '../src/protocols/stp/guards.js';
import {
  FA1,
  FA2,
  GI1,
  GI2,
  PC,
  SWITCH,
  bpduTx,
  bridgeRow,
  events,
  logs,
  ofKind,
  portRow,
  portRows,
  section,
  stpWorld,
  switchConfig,
} from './stp.harness.js';

const vlanLines = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => `vlan ${from + i}`);
const instanceVlans = (sim: ReturnType<typeof stpWorld>, device: string): number[] =>
  (sim.device(device)!.tables.get<StpBridgeRow>('stp-bridge')!.rows() as StpBridgeRow[]).map((r) => r.vlan).sort((a, b) => a - b);

describe('instances (D9)', () => {
  it('runs at most 128 instances, in ascending VLAN order, skipping disabled VLANs, and logs the cap once', () => {
    const sim = stpWorld();
    const vl = vlanLines(2, 141);
    sim.addDevice({ id: 'sw1', type: SWITCH, name: 'SW1', startupConfig: switchConfig('SW1', [...vl, 'no spanning-tree vlan 5'], [section(`interface ${GI1}`, ['switchport mode trunk'])]) });
    sim.addDevice({ id: 'sw2', type: SWITCH, name: 'SW2', startupConfig: switchConfig('SW2', vl, [section(`interface ${GI1}`, ['switchport mode trunk'])]) });
    sim.addLink({ a: { device: 'sw1', port: GI1 }, b: { device: 'sw2', port: GI1 } });
    sim.runUntil(31 * SEC);
    const v1 = instanceVlans(sim, 'sw1');
    expect(v1).toHaveLength(STP_MAX_INSTANCES);
    // the rows were written in ascending VLAN order (instances are created ascending)
    const written = ofKind(events(sim), 'tableWrite').filter((e) => e.device === 'sw1' && e.table === 'stp-bridge').map((e) => (e.row as { vlan: number }).vlan);
    expect(written.slice(0, 128)).toEqual(v1);
    expect(v1).not.toContain(5);
    expect(v1[0]).toBe(1);
    expect(v1[v1.length - 1]).toBe(129);
    expect(instanceVlans(sim, 'sw2')).toEqual(Array.from({ length: 128 }, (_, i) => i + 1));
    expect(portRows(sim, 'sw1')).toHaveLength(128);
    expect(logs(events(sim), 'sw1')).toEqual([instanceCapMessage(128, 130)]);
    expect(logs(events(sim), 'sw2')).toEqual([instanceCapMessage(128, 129)]);
    // the first BPDU of every instance left in ascending VLAN order (hello timers armed ascending)
    const first = bpduTx(events(sim), 'sw2', GI1).filter((e) => e.t === 30 * SEC).map((e) => sim.pdu(e.pdu.id)!.get('stp.pvid'));
    expect(first).toEqual(Array.from({ length: 128 }, (_, i) => i + 1));
    sim.runUntil(70 * SEC);
    expect(logs(events(sim), 'sw1')).toHaveLength(1);
    // the reserved VLANs never run an instance (they are not carried in the trunk as instances)
    expect(v1).not.toContain(1002);
  });

  it('an instance exists only while a VLAN exists and has an up port carrying it; ports move between instances with their access VLAN', () => {
    const sim = stpWorld();
    sim.addDevice({ id: 'sw1', type: SWITCH, name: 'SW1', startupConfig: switchConfig('SW1', ['vlan 10', 'vlan 20'], [section(`interface ${FA1}`, ['switchport mode access', 'switchport access vlan 10'])]) });
    sim.addDevice({ id: 'pc1', type: PC, name: 'PC1', startupConfig: pcConfig('PC1', '10.0.0.1', '255.255.255.0') });
    sim.addDevice({ id: 'pc2', type: PC, name: 'PC2', startupConfig: pcConfig('PC2', '10.0.0.2', '255.255.255.0') });
    sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: FA1 } });
    const l2 = sim.addLink({ a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: FA2 } });
    sim.runUntil(31 * SEC);
    // VLAN 20 exists but no port carries it; VLAN 10 has Fa0/1; VLAN 1 has Fa0/2
    expect(instanceVlans(sim, 'sw1')).toEqual([1, 10]);
    expect(portRow(sim, 'sw1', FA1, 10)!.state).toBe('listening');
    expect(portRow(sim, 'sw1', FA1, 1)).toBeUndefined();
    expect(bridgeRow(sim, 'sw1', 10)!.bridgeId.startsWith('32778/')).toBe(true); // 32768 + 10
    // the BPDU on the access port in VLAN 10 is plain and untagged
    const b = sim.pdu(bpduTx(events(sim), 'sw1', FA1)[0]!.pdu.id)!;
    expect(b.layers.map((l) => l.proto)).toEqual(['ethernet', 'llc', 'stp']);
    expect(b.get('stp.pvid')).toBeUndefined();
    expect(b.get('stp.bridgePriority')).toBe(32778);
    // move Fa0/1 to VLAN 20: VLAN 10 loses its last port, VLAN 20 gains one and starts from listening
    const T = sim.now;
    expect(sim.configure('sw1', [`interface ${FA1}`, 'switchport access vlan 20']).ok).toBe(true);
    expect(instanceVlans(sim, 'sw1')).toEqual([1, 20]);
    expect(portRow(sim, 'sw1', FA1, 20)!.state).toBe('listening');
    expect(portRow(sim, 'sw1', FA1, 20)!.stateSince).toBe(T);
    const gone = ofKind(events(sim), 'tableExpire').filter((e) => e.t === T && e.device === 'sw1');
    expect(gone.map((e) => `${e.table}:${e.key}`).sort()).toEqual(['stp-bridge:10', `stp:10|${FA1}`]);
    // a deleted VLAN stops its instance; `no spanning-tree vlan` stops one too; VLAN 1 goes when its last port is down
    expect(sim.configure('sw1', ['no vlan 20']).ok).toBe(true);
    expect(instanceVlans(sim, 'sw1')).toEqual([1]);
    sim.runUntil(60 * SEC); // the CAM sweep tick: the device clock is exactly here, so a direct config line may arm timers
    sim.device('sw1')!.applyConfigLine([], ['spanning-tree', 'vlan', '1'], true);
    expect(instanceVlans(sim, 'sw1')).toEqual([]);
    expect(portRows(sim, 'sw1')).toHaveLength(0);
    sim.device('sw1')!.applyConfigLine([], ['spanning-tree', 'vlan', '1'], false);
    expect(instanceVlans(sim, 'sw1')).toEqual([1]);
    sim.removeLink(l2);
    sim.runUntil(sim.now + 1 * SEC);
    expect(instanceVlans(sim, 'sw1')).toEqual([]);
    expect(sim.runToIdle().stopped).toBeUndefined();
  });

  it('a trunk carries every existing VLAN: tagged BPDUs with the pvid TLV, the native VLAN untagged with the TLV', () => {
    const sim = stpWorld();
    sim.addDevice({ id: 'sw1', type: SWITCH, name: 'SW1', startupConfig: switchConfig('SW1', ['vlan 10', 'vlan 99'], [section(`interface ${GI1}`, ['switchport mode trunk', 'switchport trunk native vlan 99', 'switchport trunk allowed vlan 10,99'])]) });
    sim.addDevice({ id: 'sw2', type: SWITCH, name: 'SW2', startupConfig: switchConfig('SW2', ['vlan 10', 'vlan 99'], [section(`interface ${GI1}`, ['switchport mode trunk', 'switchport trunk native vlan 99'])]) });
    sim.addLink({ a: { device: 'sw1', port: GI1 }, b: { device: 'sw2', port: GI1 } });
    sim.runUntil(31 * SEC);
    expect(instanceVlans(sim, 'sw1')).toEqual([10, 99]); // VLAN 1 is not allowed on the only up port
    expect(instanceVlans(sim, 'sw2')).toEqual([1, 10, 99]);
    const first = bpduTx(events(sim), 'sw1', GI1).filter((e) => e.t === 30 * SEC).map((e) => sim.pdu(e.pdu.id)!);
    expect(first.map((p) => p.layers.map((l) => l.proto).join('/'))).toEqual(['ethernet/dot1q/llc/stp', 'ethernet/llc/stp']);
    expect(first.map((p) => p.get('stp.pvid'))).toEqual([10, 99]);
    expect(first[0]!.get('dot1q.vid')).toBe(10);
    expect(first[0]!.get('ethernet.type')).toBe(0x8100);
    expect(first[0]!.get('stp.bridgePriority')).toBe(32778);
    expect(first[1]!.get('stp.bridgePriority')).toBe(32768 + 99);
    // SW2 sends VLAN 1 tagged; SW1 filters it (not allowed) before it ever reaches spanning tree
    const dropped = ofKind(events(sim), 'drop').filter((e) => e.device === 'sw1' && e.reason === 'vlan-filtered');
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped[0]!.background).toBe(true);
  });

  it('is silent in the P1 profile and writes no row before the mode line; the stp tables are P2 tables', () => {
    const sim = stpWorld(3, 'P1');
    sim.addDevice({ id: 'sw1', type: SWITCH, name: 'SW1', startupConfig: switchConfig('SW1', ['vlan 10'], [section(`interface ${GI1}`, ['switchport mode trunk'])]) });
    sim.addDevice({ id: 'sw2', type: SWITCH, name: 'SW2', startupConfig: switchConfig('SW2', ['vlan 10'], [section(`interface ${GI1}`, ['switchport mode trunk'])]) });
    sim.addLink({ a: { device: 'sw1', port: GI1 }, b: { device: 'sw2', port: GI1 } });
    sim.addLink({ a: { device: 'sw1', port: GI2 }, b: { device: 'sw2', port: GI2 } });
    const r = sim.runUntil(60 * SEC, { maxEvents: 5000 });
    expect(r.stopped).toBeUndefined();
    const evs = events(sim);
    expect(ofKind(evs, 'pduCreated')).toHaveLength(0);
    expect(ofKind(evs, 'tableWrite').filter((e) => e.table === 'stp' || e.table === 'stp-bridge')).toHaveLength(0);
    expect(ofKind(evs, 'debug').filter((e) => e.event.process === 'stp')).toHaveLength(0);
    expect(ofKind(evs, 'log').filter((e) => e.message.toLowerCase().includes('spanning'))).toHaveLength(0);
    expect(sim.device('sw1')!.tables.get('stp-bridge')!.size).toBe(0);
    expect(TABLE_DESCRIPTORS.stp.since).toBe('P2');
    expect(TABLE_DESCRIPTORS['stp-bridge'].since).toBe('P2');
    // the mode line turns it on at once, even in a P1 world (the profile never gates a feature, D2)
    sim.device('sw1')!.applyConfigLine([], ['spanning-tree', 'mode', 'pvst'], false);
    expect(instanceVlans(sim, 'sw1')).toEqual([1, 10]);
    expect(portRows(sim, 'sw1')).toHaveLength(3); // Gi0/1 in VLANs 1 and 10; Gi0/2 (dynamic auto, oper access) in VLAN 1
    sim.device('sw1')!.applyConfigLine([], ['spanning-tree', 'mode', 'pvst'], true);
    expect(instanceVlans(sim, 'sw1')).toEqual([]);
  });

  it('switching the mode rebuilds every instance from scratch', () => {
    const sim = stpWorld();
    sim.addDevice({ id: 'sw1', type: SWITCH, name: 'SW1', startupConfig: switchConfig('SW1') });
    sim.addDevice({ id: 'sw2', type: SWITCH, name: 'SW2', startupConfig: switchConfig('SW2') });
    sim.addLink({ a: { device: 'sw1', port: GI1 }, b: { device: 'sw2', port: GI1 } });
    sim.runUntil(70 * SEC);
    expect(bridgeRow(sim, 'sw1')!.mode).toBe('pvst');
    expect(portRow(sim, 'sw1', GI1)!.state).toBe('forwarding');
    const T = sim.now;
    sim.device('sw1')!.applyConfigLine([], ['spanning-tree', 'mode', 'rapid-pvst'], false);
    expect(bridgeRow(sim, 'sw1')!.mode).toBe('rapid-pvst');
    expect(portRow(sim, 'sw1', GI1)!.protocol).toBe('rstp');
    expect(portRow(sim, 'sw1', GI1)!.stateSince).toBe(T);
    sim.runUntil(T + 40 * SEC);
    // the neighbour still runs 802.1D: the port migrates and forwards on the timers again
    expect(portRow(sim, 'sw1', GI1)!.protocol).toBe('stp');
    expect(portRow(sim, 'sw1', GI1)!.state).toBe('forwarding');
    expect(sim.runToIdle().stopped).toBeUndefined();
  });
});
