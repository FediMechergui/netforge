/**
 * W3 stp (ARCHITECTURE-P2 §3.6 "Mixed modes", §13 #19, §10.1 accept.p2.stp-rapid "Mixed"): an NF-C2960 (pvst) linked
 * to an NF-C9300 (rapid by its model default) in a real P2-profile world: port protocol migration after the 3 s
 * migrate delay, the 30 s timer-based transition on the shared link, rapid convergence on rapid-only links, RST
 * BPDUs discarded by the legacy bridge, and `clear spanning-tree detected-protocols`.
 */
import { describe, expect, it } from 'vitest';
import { SEC, MS } from '../src/contracts/time.js';
import { STP_CLEAR_DETECTED_PROTOCOLS_REQUEST, STP_MIGRATE_DELAY_NS } from '../src/protocols/stp/mixed.js';
import {
  GI1,
  MLS,
  SWITCH,
  bpduTx,
  bridgeRow,
  events,
  linkUpAt,
  ofKind,
  portRow,
  stpWorld,
  switchConfig,
  transitions,
} from './stp.harness.js';

const M1 = 'GigabitEthernet1/0/1';
const M2 = 'GigabitEthernet1/0/2';

/**
 * MLS1 (NF-C9300, rapid by model default) — SW2 (NF-C2960, pvst) on M1; MLS2 (rapid) on M2. By default MLS1 is the
 * root (priority 4096), so its port toward the legacy bridge is designated; with `legacyRoot` SW2 is the root and
 * MLS1's port toward it is a root port that keeps hearing the legacy bridge's hellos.
 */
function mixedWorld(legacyRoot = false) {
  const sim = stpWorld();
  sim.addDevice({ id: 'mls1', type: MLS, name: 'MLS1', startupConfig: switchConfig('MLS1', legacyRoot ? [] : ['spanning-tree vlan 1 priority 4096']) });
  sim.addDevice({ id: 'sw2', type: SWITCH, name: 'SW2', startupConfig: switchConfig('SW2', legacyRoot ? ['spanning-tree vlan 1 priority 4096'] : []) });
  sim.addDevice({ id: 'mls2', type: MLS, name: 'MLS2', startupConfig: switchConfig('MLS2') });
  const legacy = sim.addLink({ a: { device: 'mls1', port: M1 }, b: { device: 'sw2', port: GI1 } });
  const rapid = sim.addLink({ a: { device: 'mls1', port: M2 }, b: { device: 'mls2', port: M1 } });
  return { sim, legacy, rapid };
}

describe('Mixed PVST+ / Rapid PVST+ (§3.6 Mixed modes)', () => {
  it('the NF-C9300 runs rapid-pvst by its model default and the NF-C2960 pvst', () => {
    const { sim } = mixedWorld();
    sim.runUntil(50 * SEC);
    expect(bridgeRow(sim, 'mls1')!.mode).toBe('rapid-pvst');
    expect(bridgeRow(sim, 'mls2')!.mode).toBe('rapid-pvst');
    expect(bridgeRow(sim, 'sw2')!.mode).toBe('pvst');
    expect(bridgeRow(sim, 'mls1')!.isRoot).toBe(true);
    expect(bridgeRow(sim, 'sw2')!.rootId).toBe(bridgeRow(sim, 'mls1')!.bridgeId);
  });

  it('the rapid port facing the legacy bridge migrates to 802.1D after the migrate delay and forwards 30 s after link-up; the rapid-only link converges within 1 s', () => {
    const { sim, legacy, rapid } = mixedWorld();
    sim.runUntil(41 * SEC);
    const evs = events(sim);
    const up = linkUpAt(evs, legacy);
    expect(linkUpAt(evs, rapid)).toBe(up);
    // before the delay ends the port still speaks RST
    expect(portRow(sim, 'mls1', M1)!.protocol).toBe('rstp');
    expect(portRow(sim, 'mls1', M1)!.role).toBe('designated');
    expect(portRow(sim, 'mls1', M1)!.state).toBe('discarding');
    // the rapid-only link is already done
    expect(portRow(sim, 'mls1', M2)!.state).toBe('forwarding');
    expect(portRow(sim, 'mls2', M1)!.state).toBe('forwarding');
    expect(portRow(sim, 'mls2', M1)!.role).toBe('root');
    expect(portRow(sim, 'mls1', M2)!.stateSince - up).toBeLessThan(1 * SEC);
    expect(portRow(sim, 'mls1', M2)!.protocol).toBe('rstp');
    // the legacy bridge discards every RST BPDU
    const discarded = ofKind(evs, 'drop').filter((e) => e.device === 'sw2' && e.reason === 'unsupported-protocol');
    expect(discarded.length).toBeGreaterThan(0);
    expect(discarded[0]!.detail).toBe('RST BPDU ignored: this switch runs 802.1D spanning tree');
    expect(discarded[0]!.background).toBe(true);
    sim.runUntil(up + 6 * SEC);
    const migrated = portRow(sim, 'mls1', M1)!;
    expect(migrated.protocol).toBe('stp');
    const m = transitions(events(sim), 'mls1').find((t) => t.port === M1 && t.from === 'rstp' && t.to === 'stp')!;
    expect(m.t - up).toBeGreaterThanOrEqual(STP_MIGRATE_DELAY_NS);
    expect(m.cause).toBe('neighbour speaks 802.1D');
    // after the migration the port sends 802.1D configuration BPDUs
    const legacyTx = bpduTx(events(sim), 'mls1', M1).filter((e) => e.t > m.t).map((e) => sim.pdu(e.pdu.id)!);
    expect(legacyTx.length).toBeGreaterThan(0);
    expect(legacyTx.every((p) => p.get('stp.version') === 0 && p.get('stp.bpduType') === 0)).toBe(true);
    // the other rapid port stays rapid
    expect(portRow(sim, 'mls1', M2)!.protocol).toBe('rstp');
    sim.runUntil(up + 30 * SEC + 10 * MS);
    expect(portRow(sim, 'mls1', M1)!.state).toBe('forwarding');
    expect(portRow(sim, 'mls1', M1)!.stateSince).toBe(up + 30 * SEC);
    expect(portRow(sim, 'sw2', GI1)!.state).toBe('forwarding');
    expect(portRow(sim, 'sw2', GI1)!.stateSince).toBe(up + 30 * SEC);
    expect(portRow(sim, 'sw2', GI1)!.role).toBe('root');
  });

  it('clear spanning-tree detected-protocols returns the port to rstp and restarts the delay; a legacy neighbour that keeps sending migrates it again', () => {
    // the legacy bridge is the root: MLS1's port is a root port that hears its hellos (a legacy root port never sends)
    const { sim } = mixedWorld(true);
    sim.runUntil(80 * SEC);
    expect(bridgeRow(sim, 'sw2')!.isRoot).toBe(true);
    expect(portRow(sim, 'mls1', M1)!.role).toBe('root');
    expect(portRow(sim, 'mls1', M1)!.protocol).toBe('stp');
    const T = sim.now;
    sim.device('mls1')!.applyActions('cli', [{ type: 'request', to: 'stp', req: { kind: STP_CLEAR_DETECTED_PROTOCOLS_REQUEST, port: M1 } }], T);
    expect(portRow(sim, 'mls1', M1)!.protocol).toBe('rstp');
    const cleared = transitions(events(sim), 'mls1').filter((t) => t.t === T && t.port === M1);
    expect(cleared.map((t) => `${t.from}>${t.to}`)).toEqual(['stp>rstp']);
    expect(cleared[0]!.cause).toBe('detected protocols cleared');
    // still forwarding; the state does not restart
    expect(portRow(sim, 'mls1', M1)!.state).toBe('forwarding');
    sim.runUntil(T + STP_MIGRATE_DELAY_NS - 1);
    expect(portRow(sim, 'mls1', M1)!.protocol).toBe('rstp');
    sim.runUntil(T + STP_MIGRATE_DELAY_NS + 2 * SEC + 1);
    expect(portRow(sim, 'mls1', M1)!.protocol).toBe('stp');
    // the whole-switch form (no port) also works and leaves the rapid-only port alone
    sim.device('mls1')!.applyActions('cli', [{ type: 'request', to: 'stp', req: { kind: STP_CLEAR_DETECTED_PROTOCOLS_REQUEST } }], sim.now);
    expect(portRow(sim, 'mls1', M1)!.protocol).toBe('rstp');
    expect(portRow(sim, 'mls1', M2)!.protocol).toBe('rstp');
    expect(sim.runToIdle().stopped).toBeUndefined();
  });

  it('a migrated port accepts and acknowledges TCNs from its legacy neighbour', () => {
    const { sim } = mixedWorld();
    sim.addDevice({ id: 'sw3', type: SWITCH, name: 'SW3', startupConfig: switchConfig('SW3') });
    const l = sim.addLink({ a: { device: 'sw2', port: 'GigabitEthernet0/2' }, b: { device: 'sw3', port: GI1 } });
    sim.runUntil(100 * SEC);
    expect(portRow(sim, 'sw2', 'GigabitEthernet0/2')!.state).toBe('forwarding');
    const T = sim.now;
    sim.removeLink(l);
    sim.runUntil(T + 1 * SEC);
    const evs = events(sim);
    const tcn = ofKind(evs, 'frameTx').filter((e) => e.t >= T && e.from.device === 'sw2' && e.pdu.summary.startsWith('STP topology change notification'));
    expect(tcn).toHaveLength(1);
    expect(tcn[0]!.t).toBe(T);
    const ack = bpduTx(evs, 'mls1', M1).filter((e) => e.t >= T).map((e) => sim.pdu(e.pdu.id)!).filter((p) => String(p.get('stp.flagsText')).includes('TCA'));
    expect(ack.length).toBeGreaterThan(0);
    expect(ack[0]!.get('stp.version')).toBe(0);
    // the rapid bridge propagated the change on its other non-edge port
    const tc = bpduTx(evs, 'mls1', M2).filter((e) => e.t >= T).map((e) => sim.pdu(e.pdu.id)!).filter((p) => String(p.get('stp.flagsText')).includes('TC'));
    expect(tc.length).toBeGreaterThan(0);
    expect(bridgeRow(sim, 'mls1')!.topologyChanges).toBeGreaterThan(1);
  });
});
