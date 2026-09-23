/**
 * P2 acceptance — an L3 switch routes between SVIs (ARCHITECTURE-P2 §3.5, D2, §3.0 "Virtual oper state", §10.1 row
 * `accept.p2.svi-routing`), on real worlds of `test/p2.world.ts` (vlan, dtp, etherchannel and stp daemons).
 *
 * MLS1 (NF-C3650-24): VLANs 10 and 20, PC1 on Gi1/0/1 (VLAN 10) and PC2 on Gi1/0/2 (VLAN 20), `interface Vlan10` /
 * `Vlan20` addressed. In the P2 profile the switch booted with `no ip routing` replayed:
 *  • PC1→PC2 fails with drop `no-route` whose detail names `ip routing` (local delivery to the SVI still works);
 *  • after `ip routing`: 5/5 with no dot1q mutation, and a lab `connectivity` check PC1→PC2 passes in the grader's
 *    clone built from `exportTopology` (both a clone built the grader's way on the P2-stage catalog and the real
 *    grader, `evaluateLab`, which clones on the real catalog — VLAN-aware since the W4 flip);
 *  • shutting Gi1/0/2 takes Vlan20 down with reason `no-bridged-port-up`;
 *  • trunked host: an L2 NF-C2960 joined to MLS1 by a trunk with PC4 in VLAN 10 behind it resolves Vlan10's address
 *    and pings it 5/5 — its broadcast reached the SVI untagged (the SVI ingress copy is popped, cause `interface
 *    Vlan10`);
 *  • the same topology in the P1 profile forwards without `ip routing`.
 */
import { describe, expect, it } from 'vitest';
import type { PortId } from '../src/contracts/ids.js';
import type { ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { createDtp } from '../src/protocols/dtp.js';
import { createEtherchannel } from '../src/protocols/etherchannel.js';
import { IP_ROUTING_OFF_DETAIL } from '../src/protocols/ipv4.js';
import { createStp } from '../src/protocols/stp.js';
import { createVlan } from '../src/protocols/vlan.js';
import { LAB_CLONE_BOOT_EVENTS, evaluateLab } from '../src/sim/lab-checks.js';
import { configText, section } from '../src/sim/scenarios/kit.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { createP2Simulation, type P2FactoryOverlay } from './p2.world.js';
import { ofKind, ping } from './sim.harness.js';

const L2: P2FactoryOverlay = { vlan: createVlan, dtp: createDtp, etherchannel: createEtherchannel, stp: createStp };
const MLS = 'mlswitch.nfc3650-24';
const G1: PortId = 'GigabitEthernet1/0/1';
const G2: PortId = 'GigabitEthernet1/0/2';
const G3: PortId = 'GigabitEthernet1/0/3';
/** MLS1 boots at 40 s; its access ports forward 30 s later. */
const CONVERGED = 75 * SEC;

/** The §3.5 world; with `trunked`, an NF-C2960 hangs off Gi1/0/3 by a trunk with PC4 (VLAN 10) behind it. */
function sviWorld(o: { profile?: 'P1' | 'P2'; trunked?: boolean; seed?: number } = {}): Simulation {
  const sim = createP2Simulation({ seed: o.seed ?? 7, profile: o.profile ?? 'P2', factories: L2 });
  const access = (port: string, vlan: number): string[] => section(`interface ${port}`, ['switchport mode access', `switchport access vlan ${vlan}`]);
  sim.addDevice({
    id: 'mls1', type: MLS, name: 'MLS1',
    startupConfig: configText([
      ['hostname MLS1'], ['vlan 10'], ['vlan 20'],
      access(G1, 10), access(G2, 20),
      ...(o.trunked === true ? [section(`interface ${G3}`, ['switchport mode trunk'])] : []),
      section('interface Vlan10', ['ip address 192.168.10.1 255.255.255.0', 'no shutdown']),
      section('interface Vlan20', ['ip address 192.168.20.1 255.255.255.0', 'no shutdown']),
    ]),
  });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: pcConfig('PC1', '192.168.10.10', '255.255.255.0', '192.168.10.1') });
  sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: pcConfig('PC2', '192.168.20.10', '255.255.255.0', '192.168.20.1') });
  sim.addLink({ id: 'l_pc1', a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'mls1', port: G1 } });
  sim.addLink({ id: 'l_pc2', a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: 'mls1', port: G2 } });
  if (o.trunked === true) {
    sim.addDevice({
      id: 'sw1', type: 'switch.nfc2960', name: 'SW1',
      startupConfig: configText([['hostname SW1'], ['vlan 10'], section('interface GigabitEthernet0/1', ['switchport mode trunk']), access('FastEthernet0/1', 10)]),
    });
    sim.addDevice({ id: 'pc4', type: 'pc.nfpc', name: 'PC4', startupConfig: pcConfig('PC4', '192.168.10.40', '255.255.255.0', '192.168.10.1') });
    sim.addLink({ id: 'l_trunk', a: { device: 'mls1', port: G3 }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
    sim.addLink({ id: 'l_pc4', a: { device: 'pc4', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
  }
  return sim;
}

const running = (sim: Simulation, dev = 'mls1'): string => sim.device(dev)!.running.render();
const forwarding = (sim: Simulation, dev = 'mls1'): unknown => sim.device(dev)!.processes.get('ipv4')!.stateSnapshot().state['forwarding'];
const noTagMutation = (evs: readonly import('../src/contracts/trace.js').TraceEvent[]): void => {
  expect(ofKind(evs, 'mutation').filter((m) => m.mutation.reason === 'VlanTagPush' || m.mutation.reason === 'VlanTagPop')).toEqual([]);
};

/** A one-task lab whose topology is the live world's export: PC1 → PC2 must reach. */
function connectivityLab(sim: Simulation): ScenarioInfo {
  return {
    name: 'accept-p2-svi-routing', title: 'SVI routing', description: 'PC1 reaches PC2 across the multilayer switch', category: 'ccna2-lab',
    build: () => sim.exportTopology(),
    tasks: [{ id: 'reach', title: 'Reach PC2', description: 'PC1 pings PC2', points: 1, assertions: [{ kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'success' }] }],
  };
}

describe('accept P2 svi-routing: §3.5 in the P2 profile', () => {
  it('boots with no ip routing: local delivery works, PC1→PC2 drops no-route naming ip routing', () => {
    const sim = sviWorld();
    sim.runUntil(CONVERGED);
    expect(running(sim)).toContain('no ip routing');
    expect(forwarding(sim)).toBe(false);
    expect(sim.device('mls1')!.port('Vlan10')?.operUp).toBe(true);
    expect(sim.device('mls1')!.port('Vlan20')?.operUp).toBe(true);
    // §3.5 step 2: the SVI answers its own address without routing
    expect(ping(sim, 'pc1', '192.168.10.1').text).toContain('Sent 5, received 5, lost 0');
    const p = ping(sim, 'pc1', '192.168.20.10');
    expect(p.text).toContain('received 0, lost 5');
    const drops = ofKind(p.evs, 'drop').filter((e) => e.device === 'mls1' && e.reason === 'no-route');
    expect(drops).toHaveLength(5);
    expect(drops.every((e) => e.detail === IP_ROUTING_OFF_DETAIL && e.detail.includes('ip routing'))).toBe(true);
    expect(drops[0]!.detail).toBe('IP routing is switched off on this device (ip routing)');
    expect(ofKind(p.evs, 'frameRx').filter((e) => e.device === 'pc2' && e.pdu.tag !== 'bpdu')).toEqual([]);
  });

  it('after ip routing: 5/5 with no dot1q mutation; the line replaces the stored negation and survives export', () => {
    const sim = sviWorld();
    sim.runUntil(CONVERGED);
    expect(sim.configure('mls1', ['ip routing']).ok).toBe(true);
    expect(running(sim)).toContain('\nip routing\n');
    expect(running(sim)).not.toContain('no ip routing');
    expect(forwarding(sim)).toBe(true);
    const p = ping(sim, 'pc1', '192.168.20.10');
    expect(p.text).toContain('Sent 5, received 5, lost 0');
    noTagMutation(p.evs);
    const reqs = ofKind(p.evs, 'pduCreated').filter((e) => e.device === 'pc1' && (e.pdu.tag ?? '').startsWith('ping#'));
    expect(reqs).toHaveLength(5);
    for (const r of reqs) expect(ofKind(p.evs, 'frameRx').filter((e) => e.device === 'pc2' && e.pdu.id === r.pdu.id)).toHaveLength(1);
    const exported = sim.exportTopology();
    expect(exported.profile).toBe('P2');
    expect(exported.devices.find((d) => d.id === 'mls1')!.runningConfig).toContain('\nip routing\n');
  });

  it('a lab connectivity check PC1→PC2 passes in a clone built the grader\'s way (P2 catalog)', () => {
    const sim = sviWorld();
    sim.runUntil(CONVERGED);
    expect(sim.configure('mls1', ['ip routing']).ok).toBe(true);
    // the grader's technique (lab-checks.ts createCloneHost): a fresh world, the export loaded, run to idle, then a ping
    const clone = createP2Simulation({ seed: sim.seed, profile: 'P2', factories: L2 });
    clone.loadTopology(sim.exportTopology());
    expect(clone.profile).toBe('P2');
    const boot = clone.runToIdle(LAB_CLONE_BOOT_EVENTS);
    expect(boot.stopped).toBeUndefined();
    expect(running(clone)).toContain('\nip routing\n');
    expect(running(clone)).not.toContain('no ip routing');
    expect(forwarding(clone)).toBe(true);
    expect(ping(clone, 'pc1', '192.168.20.10').text).toContain('Sent 5, received 5, lost 0');
  });

  it('a lab connectivity check PC1→PC2 passes in the grader\'s clone (evaluateLab, the real catalog after the W4 flip)', () => {
    const sim = sviWorld();
    sim.runUntil(CONVERGED);
    expect(sim.configure('mls1', ['ip routing']).ok).toBe(true);
    const status = evaluateLab(sim, connectivityLab(sim));
    expect(status.results[0]!.assertions[0]).toEqual({ index: 0, pass: true });
    expect(status.score).toBe(1);
  });

  it('shutting Gi1/0/2 takes Vlan20 down with reason no-bridged-port-up', () => {
    const sim = sviWorld();
    sim.runUntil(CONVERGED);
    const cursor = sim.trace(0).next;
    expect(sim.configure('mls1', [`interface ${G2}`, 'shutdown']).ok).toBe(true);
    sim.runFor(1 * SEC);
    const evs = sim.trace(cursor).events;
    const vlan20 = ofKind(evs, 'portState').filter((e) => e.device === 'mls1' && e.port === 'Vlan20');
    expect(vlan20).toHaveLength(1);
    expect(vlan20[0]).toMatchObject({ operUp: false, adminUp: true, reason: 'no-bridged-port-up' });
    expect(sim.device('mls1')!.port('Vlan20')?.operUp).toBe(false);
    expect(sim.device('mls1')!.port('Vlan10')?.operUp).toBe(true);
    expect(sim.device('mls1')!.tables.rib.rows().some((r) => r.source === 'C' && r.iface === 'Vlan20')).toBe(false);
    expect(sim.configure('mls1', [`interface ${G2}`, 'no shutdown']).ok).toBe(true);
    sim.runFor(35 * SEC);
    expect(sim.device('mls1')!.port('Vlan20')?.operUp).toBe(true);
  });
});

describe('accept P2 svi-routing: a trunked host', () => {
  it('PC4 in VLAN 10 behind an L2 switch resolves Vlan10 and pings it 5/5: the broadcast reached the SVI untagged', () => {
    const sim = sviWorld({ trunked: true });
    sim.runUntil(CONVERGED);
    const p = ping(sim, 'pc4', '192.168.10.1');
    expect(p.text).toContain('Sent 5, received 5, lost 0');
    const request = ofKind(p.evs, 'pduCreated').find((e) => e.device === 'pc4' && e.pdu.tag === 'arp-request')!;
    expect(request).toBeDefined();
    // tagged 10 by SW1's trunk, popped again for the SVI ingress copy at MLS1 (cause `interface Vlan10`)
    const pushes = ofKind(p.evs, 'mutation').filter((m) => m.pdu === request.pdu.id && m.mutation.reason === 'VlanTagPush');
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.mutation).toMatchObject({ device: 'sw1', after: 10, cause: 'switchport mode trunk' });
    const sviPops = ofKind(p.evs, 'mutation').filter((m) => m.mutation.device === 'mls1' && m.mutation.reason === 'VlanTagPop' && m.mutation.cause === 'interface Vlan10');
    expect(sviPops.length).toBeGreaterThanOrEqual(1);
    expect(sviPops[0]!.mutation).toMatchObject({ before: 10, after: null });
    expect(ofKind(p.evs, 'pduCreated').filter((e) => e.device === 'mls1' && e.pdu.tag === 'arp-reply')).toHaveLength(1);
    expect(sim.device('mls1')!.tables.arp.rows().some((r) => r.ip === '192.168.10.40')).toBe(true);
    // the echo requests reached the SVI untagged too (their SVI ingress copies were popped)
    expect(ofKind(p.evs, 'pduCreated').filter((e) => e.device === 'mls1' && e.pdu.tag === 'echo-reply')).toHaveLength(5);
  });

  it('the same topology in the P1 profile forwards between the VLANs without ip routing', () => {
    const sim = sviWorld({ trunked: true, profile: 'P1' });
    sim.runUntil(CONVERGED);
    expect(running(sim)).not.toContain('ip routing');
    expect(forwarding(sim)).toBe(true);
    expect(sim.device('mls1')!.tables.get('stp-bridge')!.size).toBe(0);
    const p = ping(sim, 'pc1', '192.168.20.10');
    expect(p.text).toContain('Sent 5, received 5, lost 0');
    // the echoes are unicast between access ports and the SVIs and are never tagged (the ARP flood does reach the
    // trunk to SW1 tagged 10, as it must)
    const echoes = new Set(ofKind(p.evs, 'pduCreated').filter((e) => (e.pdu.tag ?? '').startsWith('ping#') || e.pdu.tag === 'echo-reply').map((e) => e.pdu.id));
    expect(echoes.size).toBe(10);
    expect(ofKind(p.evs, 'mutation').filter((m) => echoes.has(m.pdu) && (m.mutation.reason === 'VlanTagPush' || m.mutation.reason === 'VlanTagPop'))).toEqual([]);
    expect(ping(sim, 'pc4', '192.168.20.10').text).toContain('Sent 5, received 5, lost 0');
  });
});
