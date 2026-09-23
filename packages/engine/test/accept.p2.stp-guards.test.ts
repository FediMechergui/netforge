/**
 * P2 acceptance — spanning-tree guards (ARCHITECTURE-P2 §3.6 "Guards", §3.8 step 6, §10.1 row `accept.p2.stp-guards`),
 * on real P2-profile worlds of `test/p2.world.ts` (the W3 `stp.harness`).
 *
 *  • PortFast: a host port forwards at link-up; `spanning-tree portfast default` on an untouched switch (ports
 *    `dynamic auto`) makes its host ports edge.
 *  • BPDU guard: cabling a switch to a PortFast + bpduguard port err-disables it (`errDisabled: 'bpduguard'`) on the
 *    first BPDU.
 *  • Root guard: a switch with priority 0 attached to a root-guard port puts that port `inconsistent: 'root'` and SW1
 *    stays root; after the rogue is removed the port recovers within 25 s (`runFor`), and so it does when the rogue
 *    merely stops claiming.
 *  • Type: a static trunk facing an access port puts the access port `inconsistent: 'type'` (blocking); it recovers
 *    when the trunk BPDUs stop and its information ages out (§3.6), and when the trunk itself becomes an access port
 *    (the two access ports then exchange one DTP message and fall silent: an access port does not answer an access
 *    neighbour, §3.3 rule 1a).
 */
import { describe, expect, it } from 'vitest';
import { MS, SEC } from '../src/contracts/time.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { FA1, FA2, GI1, GI2, PC, SWITCH, bridgeRow, events, linkUpAt, logs, ofKind, portRow, section, stpWorld, switchConfig, transitions } from './stp.harness.js';

const pc = (id: string, n: number) => ({ id, type: PC, name: id.toUpperCase(), startupConfig: pcConfig(id.toUpperCase(), `10.0.0.${n}`, '255.255.255.0') });

describe('accept P2 stp-guards: PortFast', () => {
  it('a PortFast host port forwards at link-up; portfast default makes the untouched host ports of a switch edge', () => {
    const sim = stpWorld();
    sim.addDevice({ id: 'sw1', type: SWITCH, name: 'SW1', startupConfig: switchConfig('SW1', ['spanning-tree vlan 1 priority 4096'], [section(`interface ${FA1}`, ['spanning-tree portfast'])]) });
    sim.addDevice({ id: 'sw2', type: SWITCH, name: 'SW2', startupConfig: switchConfig('SW2', ['spanning-tree portfast default']) });
    sim.addDevice(pc('pc1', 1));
    sim.addDevice(pc('pc2', 2));
    sim.addDevice(pc('pc3', 3));
    const l1 = sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: FA1 } });
    const l2 = sim.addLink({ a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: FA2 } });
    const l3 = sim.addLink({ a: { device: 'pc3', port: 'GigabitEthernet0' }, b: { device: 'sw2', port: FA1 } });
    sim.addLink({ a: { device: 'sw1', port: GI1 }, b: { device: 'sw2', port: GI1 } });
    sim.runUntil(31 * SEC);
    const evs = events(sim);
    const up1 = linkUpAt(evs, l1);
    expect(portRow(sim, 'sw1', FA1)).toMatchObject({ edge: true, state: 'forwarding', stateSince: up1 });
    expect(transitions(evs, 'sw1').find((t) => t.port === FA1)!.cause).toBe('edge port (PortFast)');
    // a host port without PortFast on the same switch is still on its timers
    expect(portRow(sim, 'sw1', FA2)).toMatchObject({ edge: false, state: 'listening', stateSince: linkUpAt(evs, l2) });
    // SW2 is untouched apart from the global default: its host port (dynamic auto, oper access) is edge and forwarding
    expect(sim.device('sw2')!.running.render()).not.toContain(`interface ${FA1}\n switchport`);
    expect(portRow(sim, 'sw2', FA1)).toMatchObject({ edge: true, state: 'forwarding', stateSince: linkUpAt(evs, l3) });
    // the default never makes the switch-to-switch (dynamic auto, but soon hearing BPDUs) port a lasting edge port
    sim.runUntil(65 * SEC);
    expect(portRow(sim, 'sw2', GI1)!.edge).toBe(false);
    expect(portRow(sim, 'sw2', GI1)!.state).toBe('forwarding');
    expect(portRow(sim, 'sw2', FA1)!.edge).toBe(true);
  });
});

describe('accept P2 stp-guards: BPDU guard', () => {
  it('cabling a switch to a PortFast + bpduguard port err-disables it on the first BPDU', () => {
    const sim = stpWorld();
    sim.addDevice({ id: 'sw1', type: SWITCH, name: 'SW1', startupConfig: switchConfig('SW1', ['spanning-tree vlan 1 priority 4096'], [section(`interface ${FA1}`, ['spanning-tree portfast', 'spanning-tree bpduguard enable'])]) });
    sim.addDevice({ id: 'sw2', type: SWITCH, name: 'SW2', startupConfig: switchConfig('SW2') });
    sim.addLink({ id: 'l_rogue', a: { device: 'sw2', port: GI1 }, b: { device: 'sw1', port: FA1 } });
    sim.runUntil(31 * SEC);
    const evs = events(sim);
    const view = sim.device('sw1')!.portView(FA1)!;
    expect(view.errDisabled).toBe('bpduguard');
    expect(view.operUp).toBe(false);
    expect(sim.link('l_rogue')!.up).toBe(false);
    expect(portRow(sim, 'sw1', FA1)).toBeUndefined();
    const firstBpdu = ofKind(evs, 'frameRx').find((e) => e.device === 'sw1' && e.port === FA1 && e.pdu.tag === 'bpdu')!;
    expect(firstBpdu).toBeDefined();
    const disabled = ofKind(evs, 'portState').filter((e) => e.device === 'sw1' && e.port === FA1 && e.reason === 'err-disabled');
    expect(disabled).toHaveLength(1);
    expect(disabled[0]!.t).toBe(firstBpdu.t);
    expect(ofKind(evs, 'frameRx').filter((e) => e.device === 'sw1' && e.port === FA1 && e.pdu.tag === 'bpdu' && e.t < firstBpdu.t)).toEqual([]);
    expect(logs(evs, 'sw1')).toContain('BPDU guard shut FastEthernet0/1 down: a spanning-tree BPDU arrived in VLAN 1 on a port meant for an end device.');
    expect(logs(evs, 'sw1').some((m) => m.includes('error-disabled'))).toBe(true);
    // without recovery it stays down
    sim.runUntil(300 * SEC);
    expect(sim.device('sw1')!.portView(FA1)!.errDisabled).toBe('bpduguard');
  });
});

describe('accept P2 stp-guards: root guard', () => {
  function guarded() {
    const sim = stpWorld();
    sim.addDevice({ id: 'sw1', type: SWITCH, name: 'SW1', startupConfig: switchConfig('SW1', ['spanning-tree vlan 1 priority 4096'], [section(`interface ${GI2}`, ['spanning-tree guard root'])]) });
    sim.addDevice({ id: 'sw2', type: SWITCH, name: 'SW2', startupConfig: switchConfig('SW2') });
    sim.addDevice({ id: 'rogue', type: SWITCH, name: 'ROGUE', startupConfig: switchConfig('ROGUE', ['spanning-tree vlan 1 priority 0']) });
    sim.addLink({ id: 'l_sw2', a: { device: 'sw1', port: GI1 }, b: { device: 'sw2', port: GI1 } });
    const rogue = sim.addLink({ id: 'l_rogue', a: { device: 'rogue', port: GI1 }, b: { device: 'sw1', port: GI2 } });
    sim.runUntil(65 * SEC);
    expect(portRow(sim, 'sw1', GI2)).toMatchObject({ inconsistent: 'root', state: 'blocking' });
    expect(bridgeRow(sim, 'sw1')!.isRoot).toBe(true);
    expect(bridgeRow(sim, 'sw2')!.rootId).toBe(bridgeRow(sim, 'sw1')!.bridgeId);
    expect(bridgeRow(sim, 'rogue')!.isRoot).toBe(true); // it believes so, on its own side of the guard
    expect(logs(events(sim), 'sw1')).toContain('Root guard blocked GigabitEthernet0/2 in VLAN 1: a neighbour claimed a better root than this tree allows.');
    return { sim, rogue };
  }

  it('a priority-0 switch on a root-guard port is blocked root-inconsistent, SW1 stays root; removing it lets the port recover within 25 s', () => {
    const { sim } = guarded();
    sim.removeDevice('rogue');
    sim.runFor(25 * SEC);
    // the port has no neighbour now: it is down and takes no part; nothing is inconsistent any more
    expect(sim.device('sw1')!.portView(GI2)!.operUp).toBe(false);
    expect(portRow(sim, 'sw1', GI2)).toBeUndefined();
    expect(bridgeRow(sim, 'sw1')!.isRoot).toBe(true);
    // an ordinary switch cabled there comes up as a clean designated port
    sim.addDevice({ id: 'sw3', type: SWITCH, name: 'SW3', startupConfig: switchConfig('SW3') });
    sim.addLink({ id: 'l_sw3', a: { device: 'sw3', port: GI1 }, b: { device: 'sw1', port: GI2 } });
    sim.runFor(35 * SEC);
    const clean = portRow(sim, 'sw1', GI2)!;
    expect(clean.role).toBe('designated');
    expect(clean.inconsistent).toBeUndefined();
    expect(clean.state).not.toBe('blocking');
    expect(bridgeRow(sim, 'sw3')!.rootId).toBe(bridgeRow(sim, 'sw1')!.bridgeId);
    expect(bridgeRow(sim, 'sw1')!.isRoot).toBe(true);
  });

  it('when the rogue stops claiming, the guarded port recovers within 25 s of the last superior BPDU', () => {
    const { sim } = guarded();
    sim.runUntil(66 * SEC);
    const T = sim.now;
    expect(sim.configure('rogue', ['spanning-tree vlan 1 priority 32768']).ok).toBe(true);
    sim.runFor(25 * SEC);
    const recovered = portRow(sim, 'sw1', GI2)!;
    expect(recovered.inconsistent).toBeUndefined();
    expect(recovered.role).toBe('designated');
    expect(['listening', 'learning', 'forwarding']).toContain(recovered.state);
    expect(logs(events(sim), 'sw1')).toContain('Root guard on GigabitEthernet0/2 in VLAN 1 cleared: the superior BPDUs stopped.');
    const cleared = transitions(events(sim), 'sw1').find((t) => t.t > T && t.port === GI2 && t.to === 'listening')!;
    expect(cleared.t - T).toBeLessThanOrEqual(25 * SEC);
    expect(bridgeRow(sim, 'sw1')!.isRoot).toBe(true);
    expect(bridgeRow(sim, 'rogue')!.rootId).toBe(bridgeRow(sim, 'sw1')!.bridgeId);
  });
});

describe('accept P2 stp-guards: type inconsistency', () => {
  /** SW1 Gi0/1 a static trunk (DTP negotiating, the default), SW2 Gi0/1 an access port, cabled together. */
  function trunkFacingAccess() {
    const sim = stpWorld();
    sim.addDevice({ id: 'sw1', type: SWITCH, name: 'SW1', startupConfig: switchConfig('SW1', ['spanning-tree vlan 1 priority 4096'], [section(`interface ${GI1}`, ['switchport mode trunk'])]) });
    sim.addDevice({ id: 'sw2', type: SWITCH, name: 'SW2', startupConfig: switchConfig('SW2', [], [section(`interface ${GI1}`, ['switchport mode access'])]) });
    const link = sim.addLink({ a: { device: 'sw1', port: GI1 }, b: { device: 'sw2', port: GI1 } });
    return { sim, link };
  }

  it('a static trunk facing an access port puts the access port inconsistent: type (blocking), for as long as the trunk BPDUs arrive', () => {
    const { sim, link } = trunkFacingAccess();
    sim.runUntil(35 * SEC);
    const evs = events(sim);
    const up = linkUpAt(evs, link);
    const row = portRow(sim, 'sw2', GI1)!;
    expect(row).toMatchObject({ inconsistent: 'type', state: 'blocking' });
    // on the first trunk BPDU (the pvid TLV says it comes from a trunk), not on a timer
    expect(row.stateSince - up).toBeLessThan(1 * MS);
    expect(transitions(evs, 'sw2').find((t) => t.port === GI1 && t.to === 'blocking')!.cause).toBe('type inconsistency');
    expect(logs(evs, 'sw2')).toContain('GigabitEthernet0/1 is an access port in VLAN 1 but receives trunk BPDUs: it is blocked until they stop.');
    // the trunk end is not inconsistent (the pvid check runs only on trunks, against an untagged BPDU's TLV)
    expect(portRow(sim, 'sw1', GI1)!.inconsistent).toBeUndefined();
    sim.runUntil(70 * SEC);
    expect(portRow(sim, 'sw2', GI1)).toMatchObject({ inconsistent: 'type', state: 'blocking' });
  });

  it('the access port recovers once the trunk BPDUs stop: its stored information ages out and it takes part again', () => {
    const { sim } = trunkFacingAccess();
    sim.runUntil(70 * SEC);
    expect(portRow(sim, 'sw2', GI1)).toMatchObject({ inconsistent: 'type', state: 'blocking' });
    const T = sim.now;
    // SW1 stops VLAN 1's spanning tree: its trunk BPDUs stop (the trunk and DTP stay as they are)
    expect(sim.configure('sw1', ['no spanning-tree vlan 1']).ok).toBe(true);
    sim.runUntil(T + 25 * SEC);
    const recovered = portRow(sim, 'sw2', GI1)!;
    expect(recovered.inconsistent).toBeUndefined();
    expect(recovered.state).not.toBe('blocking');
    const cleared = transitions(events(sim), 'sw2').find((t) => t.t > T && t.port === GI1 && t.from === 'blocking')!;
    expect(cleared.cause).toBe('type inconsistency cleared');
    expect(cleared.t - T).toBeLessThanOrEqual(20 * SEC + 10 * MS);
    expect(logs(events(sim), 'sw2')).toContain('GigabitEthernet0/1 no longer receives trunk BPDUs in VLAN 1: the port takes part in spanning tree again.');
  });

  it('the access port recovers when the trunk facing it becomes an access port', () => {
    const { sim } = trunkFacingAccess();
    sim.runUntil(70 * SEC);
    expect(portRow(sim, 'sw2', GI1)).toMatchObject({ inconsistent: 'type', state: 'blocking' });
    const T = sim.now;
    expect(sim.configure('sw1', [`interface ${GI1}`, 'switchport mode access']).ok).toBe(true);
    const run = sim.runUntil(T + 25 * SEC, { maxEvents: 100_000 });
    expect(run.stopped).toBeUndefined();
    expect(portRow(sim, 'sw2', GI1)!.inconsistent).toBeUndefined();
    expect(portRow(sim, 'sw2', GI1)!.role).toBe('root');
    expect(portRow(sim, 'sw2', GI1)!.state).not.toBe('blocking');
    expect(transitions(events(sim), 'sw2').some((t) => t.t > T && t.port === GI1 && t.t - T <= 20 * SEC + 10 * MS)).toBe(true);
    // both access ports fall silent after the one message of rule 1b (an access neighbour's message is never answered)
    expect(ofKind(events(sim), 'pduCreated').filter((e) => e.t >= T && e.pdu.tag === 'dtp').length).toBeLessThanOrEqual(2);
  });
});
