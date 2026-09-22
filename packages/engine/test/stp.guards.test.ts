/**
 * W3 stp (ARCHITECTURE-P2 §3.6 "Guards", §3.2 step 6, §3.8 step 6, §13 #24 and #33, §10.1 accept.p2.stp-guards):
 * PortFast scopes, BPDU guard with err-disable and its periodic recovery, root guard, the pvid check on trunks only,
 * and the type inconsistency of an access port facing a trunk — on real P2-profile worlds.
 */
import { describe, expect, it } from 'vitest';
import { SEC, MS } from '../src/contracts/time.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import {
  DEFAULT_STP_PORT_LINES,
  isBpduGuardOn,
  isEdgePort,
  nativeMismatchMessage,
  nativeVlanMismatch,
  facesTrunk,
} from '../src/protocols/stp/guards.js';
import {
  FA1,
  FA2,
  GI1,
  GI2,
  PC,
  SWITCH,
  bridgeRow,
  events,
  linkUpAt,
  logs,
  ofKind,
  portRow,
  section,
  stpWorld,
  switchConfig,
  transitions,
} from './stp.harness.js';

const pc = (id: string, n: number) => ({ id, type: PC, name: id.toUpperCase(), startupConfig: pcConfig(id.toUpperCase(), `10.0.0.${n}`, '255.255.255.0') });

describe('PortFast scopes (§3.6 Guards, #33)', () => {
  it('pure rules: portfast on a non-trunking port, portfast default, portfast trunk, portfast disable', () => {
    const g = { portfastDefault: false, bpduguardDefault: false };
    expect(isEdgePort(g, { ...DEFAULT_STP_PORT_LINES, portfast: 'on' }, false)).toBe(true);
    expect(isEdgePort(g, { ...DEFAULT_STP_PORT_LINES, portfast: 'on' }, true)).toBe(false);
    expect(isEdgePort(g, DEFAULT_STP_PORT_LINES, false)).toBe(false);
    expect(isEdgePort({ ...g, portfastDefault: true }, DEFAULT_STP_PORT_LINES, false)).toBe(true);
    expect(isEdgePort({ ...g, portfastDefault: true }, DEFAULT_STP_PORT_LINES, true)).toBe(false);
    expect(isEdgePort({ ...g, portfastDefault: true }, { ...DEFAULT_STP_PORT_LINES, portfast: 'disable' }, false)).toBe(false);
    expect(isEdgePort(g, { ...DEFAULT_STP_PORT_LINES, portfast: 'trunk' }, true)).toBe(true);
    expect(isBpduGuardOn(g, { ...DEFAULT_STP_PORT_LINES, bpduguard: 'enable' }, false)).toBe(true);
    expect(isBpduGuardOn({ ...g, bpduguardDefault: true }, DEFAULT_STP_PORT_LINES, true)).toBe(true);
    expect(isBpduGuardOn({ ...g, bpduguardDefault: true }, DEFAULT_STP_PORT_LINES, false)).toBe(false);
    expect(isBpduGuardOn({ ...g, bpduguardDefault: true }, { ...DEFAULT_STP_PORT_LINES, bpduguard: 'disable' }, true)).toBe(false);
  });

  it('an edge port forwards at link-up and causes no topology change; a trunk with plain portfast is not edge; portfast default covers dynamic-auto host ports', () => {
    const sim = stpWorld();
    sim.addDevice({
      id: 'sw1', type: SWITCH, name: 'SW1',
      startupConfig: switchConfig('SW1', ['spanning-tree vlan 1 priority 4096'], [
        section(`interface ${FA1}`, ['spanning-tree portfast']),
        section(`interface ${GI1}`, ['switchport mode trunk', 'spanning-tree portfast']),
        section(`interface ${GI2}`, ['switchport mode trunk', 'spanning-tree portfast trunk']),
      ]),
    });
    sim.addDevice({
      id: 'sw2', type: SWITCH, name: 'SW2',
      startupConfig: switchConfig('SW2', ['spanning-tree portfast default'], [
        section(`interface ${FA2}`, ['spanning-tree portfast disable']),
        section(`interface ${GI1}`, ['switchport mode trunk']),
        section(`interface ${GI2}`, ['switchport mode trunk']),
      ]),
    });
    sim.addDevice(pc('pc1', 1));
    sim.addDevice(pc('pc2', 2));
    sim.addDevice(pc('pc3', 3));
    const l1 = sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: FA1 } });
    sim.addLink({ a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: 'sw2', port: FA1 } });
    sim.addLink({ a: { device: 'pc3', port: 'GigabitEthernet0' }, b: { device: 'sw2', port: FA2 } });
    sim.addLink({ a: { device: 'sw1', port: GI1 }, b: { device: 'sw2', port: GI1 } });
    sim.addLink({ a: { device: 'sw1', port: GI2 }, b: { device: 'sw2', port: GI2 } });
    sim.runUntil(31 * SEC);
    const up = linkUpAt(events(sim), l1);
    const edge = portRow(sim, 'sw1', FA1)!;
    expect(edge.edge).toBe(true);
    expect(edge.state).toBe('forwarding');
    expect(edge.stateSince).toBe(up);
    expect(transitions(events(sim), 'sw1').find((t) => t.port === FA1)!.cause).toBe('edge port (PortFast)');
    // plain portfast on an operational trunk: stored, not edge (the CLI warns with CLI_MESSAGES.portfastOnTrunk)
    expect(portRow(sim, 'sw1', GI1)!.edge).toBe(false);
    expect(portRow(sim, 'sw1', GI1)!.state).toBe('listening');
    // portfast trunk on an operational trunk: edge at link-up (forwarding at once); the neighbour's first BPDU then
    // takes the edge status away, as it does on any edge port
    const gi2 = transitions(events(sim), 'sw1').filter((t) => t.port === GI2);
    expect(gi2[0]!.to).toBe('forwarding');
    expect(gi2[0]!.cause).toBe('edge port (PortFast)');
    expect(gi2[0]!.t).toBe(up);
    expect(portRow(sim, 'sw1', GI2)!.edge).toBe(false);
    expect(portRow(sim, 'sw1', GI2)!.state).toBe('forwarding');
    // portfast default: the untouched (dynamic auto, oper access) host port is edge; `portfast disable` opts out
    expect(portRow(sim, 'sw2', FA1)!.edge).toBe(true);
    expect(portRow(sim, 'sw2', FA1)!.state).toBe('forwarding');
    expect(portRow(sim, 'sw2', FA2)!.edge).toBe(false);
    expect(portRow(sim, 'sw2', FA2)!.state).toBe('listening');
    // the default never makes a static trunk edge
    expect(portRow(sim, 'sw2', GI1)!.edge).toBe(false);
    // no topology change from the edge ports at link-up: the root's counter is still 0 until a non-edge port forwards
    expect(bridgeRow(sim, 'sw1')!.topologyChanges).toBe(0);
    sim.runUntil(65 * SEC);
    expect(bridgeRow(sim, 'sw1')!.topologyChanges).toBe(1);
    expect(bridgeRow(sim, 'sw1')!.lastChangePort).not.toBe(FA1);
  });

  it('an edge port that hears a BPDU loses its edge status until it goes down', () => {
    const sim = stpWorld();
    sim.addDevice({ id: 'sw1', type: SWITCH, name: 'SW1', startupConfig: switchConfig('SW1', ['spanning-tree vlan 1 priority 4096'], [section(`interface ${FA1}`, ['spanning-tree portfast'])]) });
    sim.addDevice({ id: 'sw2', type: SWITCH, name: 'SW2', startupConfig: switchConfig('SW2') });
    const l = sim.addLink({ a: { device: 'sw2', port: GI1 }, b: { device: 'sw1', port: FA1 } });
    sim.runUntil(31 * SEC);
    const r = portRow(sim, 'sw1', FA1)!;
    expect(r.edge).toBe(false);
    expect(r.state).toBe('forwarding'); // it forwarded at link-up and keeps its state
    sim.removeLink(l);
    sim.runUntil(32 * SEC);
    sim.addLink({ a: { device: 'sw2', port: GI1 }, b: { device: 'sw1', port: FA1 } });
    sim.runUntil(33 * SEC);
    // it came up edge again and lost the status on the neighbour's first BPDU
    const again = transitions(events(sim), 'sw1').filter((t) => t.t >= 32 * SEC && t.port === FA1);
    expect(again[0]!.to).toBe('forwarding');
    expect(again[0]!.cause).toBe('edge port (PortFast)');
    expect(portRow(sim, 'sw1', FA1)!.edge).toBe(false);
  });
});

describe('BPDU guard (§3.6 Guards, §3.8 step 6)', () => {
  it('err-disables the port on the first BPDU, logs, and recovers on the periodic errdisable timer', () => {
    const sim = stpWorld();
    sim.addDevice({
      id: 'sw1', type: SWITCH, name: 'SW1',
      startupConfig: switchConfig('SW1', ['spanning-tree vlan 1 priority 4096', 'errdisable recovery cause bpduguard', 'errdisable recovery interval 30'], [
        section(`interface ${FA1}`, ['spanning-tree portfast', 'spanning-tree bpduguard enable']),
      ]),
    });
    sim.addDevice({ id: 'sw2', type: SWITCH, name: 'SW2', startupConfig: switchConfig('SW2') });
    sim.addLink({ a: { device: 'sw2', port: GI1 }, b: { device: 'sw1', port: FA1 } });
    sim.runUntil(31 * SEC);
    const view = sim.device('sw1')!.portView(FA1)!;
    expect(view.errDisabled).toBe('bpduguard');
    expect(view.operUp).toBe(false);
    expect(portRow(sim, 'sw1', FA1)).toBeUndefined();
    const evs = events(sim);
    expect(logs(evs, 'sw1')).toContain('BPDU guard shut FastEthernet0/1 down: a spanning-tree BPDU arrived in VLAN 1 on a port meant for an end device.');
    const disabled = ofKind(evs, 'portState').filter((e) => e.device === 'sw1' && e.port === FA1 && e.reason === 'err-disabled');
    expect(disabled).toHaveLength(1);
    expect(disabled[0]!.t).toBeLessThan(30 * SEC + 10 * MS);
    // the recovery timer is periodic: runToIdle returns with the offender still attached
    const idle = sim.runToIdle(20_000);
    expect(idle.stopped).toBeUndefined();
    expect(sim.now).toBeLessThan(60 * SEC);
    sim.runUntil(62 * SEC);
    const later = events(sim);
    const recovered = ofKind(later, 'portState').filter((e) => e.device === 'sw1' && e.port === FA1 && e.reason === 'err-recovered');
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.t - disabled[0]!.t).toBeGreaterThanOrEqual(30 * SEC);
    expect(recovered[0]!.t - disabled[0]!.t).toBeLessThan(30 * SEC + 20 * MS);
    // …and the neighbour's next BPDU err-disables it again (the faithful cycle)
    expect(ofKind(later, 'portState').filter((e) => e.device === 'sw1' && e.port === FA1 && e.reason === 'err-disabled')).toHaveLength(2);
    expect(sim.device('sw1')!.portView(FA1)!.errDisabled).toBe('bpduguard');
  });

  it('portfast bpduguard default guards edge ports only, and without recovery the port stays down', () => {
    const sim = stpWorld();
    sim.addDevice({ id: 'sw1', type: SWITCH, name: 'SW1', startupConfig: switchConfig('SW1', ['spanning-tree vlan 1 priority 4096', 'spanning-tree portfast default', 'spanning-tree portfast bpduguard default'], [section(`interface ${GI1}`, ['switchport mode trunk'])]) });
    sim.addDevice({ id: 'sw2', type: SWITCH, name: 'SW2', startupConfig: switchConfig('SW2', [], [section(`interface ${GI1}`, ['switchport mode trunk'])]) });
    sim.addDevice({ id: 'sw3', type: SWITCH, name: 'SW3', startupConfig: switchConfig('SW3') });
    sim.addLink({ a: { device: 'sw2', port: GI1 }, b: { device: 'sw1', port: GI1 } });
    sim.addLink({ a: { device: 'sw3', port: GI1 }, b: { device: 'sw1', port: FA1 } });
    sim.runUntil(31 * SEC);
    expect(portRow(sim, 'sw1', GI1)!.bpduGuard).toBeUndefined();
    expect(portRow(sim, 'sw1', GI1)!.state).toBe('listening');
    expect(sim.device('sw1')!.portView(FA1)!.errDisabled).toBe('bpduguard');
    sim.runUntil(400 * SEC);
    expect(sim.device('sw1')!.portView(FA1)!.errDisabled).toBe('bpduguard');
    expect(sim.device('sw1')!.portView(FA1)!.operUp).toBe(false);
  });
});

describe('Root guard (§3.6 Guards)', () => {
  it('a superior BPDU on a root-guard port blocks it root-inconsistent, the root stays, and it recovers when the information ages out', () => {
    const sim = stpWorld();
    sim.addDevice({ id: 'sw1', type: SWITCH, name: 'SW1', startupConfig: switchConfig('SW1', ['spanning-tree vlan 1 priority 4096'], [section(`interface ${GI2}`, ['spanning-tree guard root'])]) });
    sim.addDevice({ id: 'sw2', type: SWITCH, name: 'SW2', startupConfig: switchConfig('SW2') });
    sim.addDevice({ id: 'rogue', type: SWITCH, name: 'ROGUE', startupConfig: switchConfig('ROGUE', ['spanning-tree vlan 1 priority 0']) });
    sim.addLink({ a: { device: 'sw1', port: GI1 }, b: { device: 'sw2', port: GI1 } });
    sim.addLink({ a: { device: 'rogue', port: GI1 }, b: { device: 'sw1', port: GI2 } });
    sim.runUntil(65 * SEC);
    const guarded = portRow(sim, 'sw1', GI2)!;
    expect(guarded.inconsistent).toBe('root');
    expect(guarded.state).toBe('blocking');
    expect(bridgeRow(sim, 'sw1')!.isRoot).toBe(true);
    expect(bridgeRow(sim, 'sw2')!.rootId).toBe(bridgeRow(sim, 'sw1')!.bridgeId);
    expect(logs(events(sim), 'sw1')).toContain('Root guard blocked GigabitEthernet0/2 in VLAN 1: a neighbour claimed a better root than this tree allows.');
    // the rogue stops claiming (its priority goes back to the default; the link stays up): the superior information
    // stops, the port recovers within max age and re-enters as designated
    sim.runUntil(66 * SEC); // a hello tick: the rogue's clock is exactly here
    const T = sim.now;
    sim.device('rogue')!.applyConfigLine([], ['spanning-tree', 'vlan', '1', 'priority', '32768'], false);
    sim.runUntil(T + 25 * SEC);
    const recovered = portRow(sim, 'sw1', GI2)!;
    expect(recovered.inconsistent).toBeUndefined();
    expect(recovered.role).toBe('designated');
    expect(['listening', 'learning']).toContain(recovered.state);
    expect(logs(events(sim), 'sw1')).toContain('Root guard on GigabitEthernet0/2 in VLAN 1 cleared: the superior BPDUs stopped.');
    const cleared = transitions(events(sim), 'sw1').find((t) => t.t > T && t.port === GI2 && t.to === 'listening')!;
    expect(cleared.t - T).toBeLessThanOrEqual(20 * SEC + 10 * MS);
  });
});

describe('pvid on trunks only, and the type inconsistency (§3.2 step 6, #24)', () => {
  it('pure rules: the pvid check ignores tagged BPDUs and missing TLVs; an access port faces a trunk only for an untagged BPDU with the TLV', () => {
    expect(nativeVlanMismatch(false, 1, 99)).toEqual([1, 99]);
    expect(nativeVlanMismatch(false, 99, 1)).toEqual([1, 99]);
    expect(nativeVlanMismatch(false, 99, 99)).toBeUndefined();
    expect(nativeVlanMismatch(true, 1, 99)).toBeUndefined();
    expect(nativeVlanMismatch(false, undefined, 99)).toBeUndefined();
    expect(facesTrunk(false, 1)).toBe(true);
    expect(facesTrunk(true, 10)).toBe(false);
    expect(facesTrunk(false, undefined)).toBe(false);
    expect(nativeMismatchMessage('GigabitEthernet0/1', 99, 1, [1, 99])).toBe('Native VLAN mismatch on GigabitEthernet0/1: this switch sends VLAN 99 untagged, the neighbour sends VLAN 1. VLANs 1 and 99 are blocked on this port.');
  });

  it('a native VLAN mismatch blocks both VLANs on both ends with the §3.2 log line, and clears once the native VLANs agree', () => {
    const sim = stpWorld();
    sim.addDevice({ id: 'sw1', type: SWITCH, name: 'SW1', startupConfig: switchConfig('SW1', ['spanning-tree vlan 1 priority 4096', 'vlan 99'], [section(`interface ${GI1}`, ['switchport mode trunk', 'switchport trunk native vlan 99'])]) });
    sim.addDevice({ id: 'sw2', type: SWITCH, name: 'SW2', startupConfig: switchConfig('SW2', ['vlan 99'], [section(`interface ${GI1}`, ['switchport mode trunk', 'switchport trunk native vlan 1'])]) });
    sim.addLink({ a: { device: 'sw1', port: GI1 }, b: { device: 'sw2', port: GI1 } });
    sim.runUntil(35 * SEC);
    for (const [d, own, other] of [['sw1', 99, 1], ['sw2', 1, 99]] as const) {
      expect(portRow(sim, d, GI1, 1)!.inconsistent).toBe('pvid');
      expect(portRow(sim, d, GI1, 99)!.inconsistent).toBe('pvid');
      expect(portRow(sim, d, GI1, 1)!.state).toBe('blocking');
      expect(portRow(sim, d, GI1, 99)!.state).toBe('blocking');
      const line = logs(events(sim), d).filter((m) => m.startsWith('Native VLAN mismatch'));
      expect(line).toEqual([nativeMismatchMessage(GI1, own, other, [1, 99])]);
    }
    // the tagged BPDUs (VLAN 1 from SW1, VLAN 99 from SW2) never trigger the check: only the two untagged ones did.
    // SW2 is fixed: SW1 hears a matching untagged BPDU at once; SW2's neighbour's VLAN 99 port is a root port that
    // sends nothing, so SW2 recovers when max age passes without a mismatching BPDU
    const fixed = sim.configure('sw2', [`interface ${GI1}`, 'switchport trunk native vlan 99']);
    expect(fixed.ok).toBe(true);
    sim.runUntil(40 * SEC);
    expect(portRow(sim, 'sw1', GI1, 1)!.inconsistent).toBeUndefined();
    expect(portRow(sim, 'sw1', GI1, 99)!.inconsistent).toBeUndefined();
    expect(portRow(sim, 'sw2', GI1, 1)!.inconsistent).toBe('pvid');
    sim.runUntil(35 * SEC + 20 * SEC + 2 * SEC);
    for (const d of ['sw1', 'sw2']) {
      expect(portRow(sim, d, GI1, 1)!.inconsistent).toBeUndefined();
      expect(portRow(sim, d, GI1, 99)!.inconsistent).toBeUndefined();
      expect(portRow(sim, d, GI1, 1)!.state).not.toBe('blocking');
      expect(portRow(sim, d, GI1, 99)!.state).not.toBe('blocking');
    }
    expect(logs(events(sim), 'sw2')).toContain('Native VLAN mismatch on GigabitEthernet0/1 cleared for VLAN 99: the port takes part in spanning tree again.');
    sim.runUntil(95 * SEC);
    expect(portRow(sim, 'sw2', GI1, 1)!.state).toBe('forwarding');
    expect(portRow(sim, 'sw2', GI1, 99)!.state).toBe('forwarding');
  });

  it('an access port facing a static trunk goes type-inconsistent (blocking) and recovers when the trunk BPDUs stop', () => {
    const sim = stpWorld();
    sim.addDevice({ id: 'sw1', type: SWITCH, name: 'SW1', startupConfig: switchConfig('SW1', ['spanning-tree vlan 1 priority 4096'], [section(`interface ${GI1}`, ['switchport mode trunk'])]) });
    sim.addDevice({ id: 'sw2', type: SWITCH, name: 'SW2', startupConfig: switchConfig('SW2', [], [section(`interface ${GI1}`, ['switchport mode access'])]) });
    sim.addLink({ a: { device: 'sw1', port: GI1 }, b: { device: 'sw2', port: GI1 } });
    sim.runUntil(35 * SEC);
    const access = portRow(sim, 'sw2', GI1)!;
    expect(access.inconsistent).toBe('type');
    expect(access.state).toBe('blocking');
    expect(logs(events(sim), 'sw2')).toContain('GigabitEthernet0/1 is an access port in VLAN 1 but receives trunk BPDUs: it is blocked until they stop.');
    // the trunk end is not inconsistent: the access port sends plain BPDUs and the pvid check runs on trunks only
    expect(portRow(sim, 'sw1', GI1)!.inconsistent).toBeUndefined();
    // the access-VLAN mismatch case never blocks: two access ports in different VLANs merge them (D8)
    const T = sim.now;
    expect(sim.configure('sw1', [`interface ${GI1}`, 'switchport mode access']).ok).toBe(true);
    sim.runUntil(T + 25 * SEC);
    expect(portRow(sim, 'sw2', GI1)!.inconsistent).toBeUndefined();
    expect(logs(events(sim), 'sw2')).toContain('GigabitEthernet0/1 no longer receives trunk BPDUs in VLAN 1: the port takes part in spanning tree again.');
    expect(portRow(sim, 'sw2', GI1)!.role).toBe('root');
  });
});
