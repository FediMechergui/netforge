/**
 * sim — the P2 snapshot members (ARCHITECTURE-P2 §2.8, D6; §7 W2 sim), on `p2.world` (§0 rule 13): `PortSnapshot.l2`
 * (the `PortL2View` derived at snapshot time from the running config and the tables of a VLAN-aware device, present
 * only when it differs from the default), `parent` and `dot1q` (subinterfaces), and `SimSnapshot.profile`. P1 worlds
 * and P1-stage models carry none of them, so P1 snapshots keep their bytes.
 *
 * The L2 daemons of this wave (vlan, dtp, stp, etherchannel) are other owners' same-wave items, so the models are
 * completed with silent stand-in factories and the rows the view reads are written straight into the tables.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceRuntime } from '../src/contracts/device.js';
import type { PortState } from '../src/contracts/port.js';
import { DEFAULT_SWITCHPORT } from '../src/contracts/port.js';
import type { Process, ProcessFactory } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { DtpRow, EtherchannelRow, PortSecurityRow, StpPortRow, VlanRow } from '../src/contracts/tables.js';
import { stpKey, vlanKey } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { pcRouterPc, twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';
import { buildPortL2View, buildPortSnapshot } from '../src/sim/snapshot-cache.js';
import { createP2Simulation } from './p2.world.js';

/** A daemon that does nothing: it exists so the model declares the tables the view reads. */
function silent(name: string): ProcessFactory {
  return (): Process => ({
    name,
    onPdu: () => [],
    onTimer: () => [],
    onConfig: () => [],
    stateSnapshot: () => ({ process: name, state: {} }),
    debugEvents: () => [],
  });
}

const FACTORIES = { vlan: silent('vlan'), dtp: silent('dtp'), stp: silent('stp'), etherchannel: silent('etherchannel') };

const SW_CONFIG = [
  'hostname SW1',
  'interface FastEthernet0/1',
  ' switchport mode trunk',
  ' switchport trunk allowed vlan 10,20,30',
  ' switchport trunk native vlan 99',
  'interface FastEthernet0/2',
  ' switchport access vlan 10',
  'interface FastEthernet0/3',
  ' switchport mode access',
  ' switchport nonegotiate',
  '',
].join('\n');

/** A P2 world: one managed switch (VLAN-aware through the stand-in daemons) and a PC on Fa0/2, booted. */
function world(): { sim: Simulation; sw: DeviceRuntime } {
  const sim = createP2Simulation({ seed: 5, factories: FACTORIES });
  sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: SW_CONFIG });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1' });
  sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/2' } });
  sim.runFor(40 * SEC);
  const sw = sim.device('sw1')!;
  return { sim, sw };
}

const portSnap = (sim: Simulation, device: string, port: string) => sim.snapshot().devices.find((d) => d.id === device)!.ports.find((p) => p.id === port)!;
const l2Keys = (sim: Simulation): string[] =>
  sim.snapshot().devices.flatMap((d) => d.ports.filter((p) => 'l2' in p || 'parent' in p || 'dot1q' in p).map((p) => `${d.id}/${p.id}`));

describe('P1 worlds carry none of the P2 snapshot members', () => {
  it('a P1 world with the real catalog: no l2, parent, dot1q or profile key anywhere', () => {
    const sim = createSimulation({ seed: 1 });
    sim.loadTopology(twoPcsAndSwitch());
    sim.runFor(40 * SEC);
    expect(l2Keys(sim)).toEqual([]);
    expect('profile' in sim.snapshot()).toBe(false);
    const r = createSimulation({ seed: 1 });
    r.loadTopology(pcRouterPc());
    r.runFor(60 * SEC);
    expect(l2Keys(r)).toEqual([]);
  });

  it('a P1-stage switch in a P2-profile world is not VLAN-aware: no l2 view, but the profile is in the snapshot', () => {
    const sim = createSimulation({ seed: 1, profile: 'P2' });
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', startupConfig: SW_CONFIG });
    sim.runFor(30 * SEC);
    expect(l2Keys(sim)).toEqual([]);
    expect(sim.snapshot().profile).toBe('P2');
  });
});

describe('PortSnapshot.l2 on a VLAN-aware switch (p2.world)', () => {
  it('is absent on every port whose view is the default, on non-bridged ports, and on the PC', () => {
    const { sim, sw } = world();
    expect(sw.model.processes).toContain('vlan');
    expect(sw.tables.names()).toEqual(expect.arrayContaining(['vlans', 'dtp', 'stp', 'etherchannel', 'port-security']));
    const ports = sim.snapshot().devices.find((d) => d.id === 'sw1')!.ports;
    expect(ports.find((p) => p.id === 'FastEthernet0/4')!.l2).toBeUndefined();
    expect(ports.find((p) => p.id === 'Vlan1')!.l2).toBeUndefined();
    expect(sim.snapshot().devices.find((d) => d.id === 'pc1')!.ports.every((p) => p.l2 === undefined)).toBe(true);
    expect(l2Keys(sim).sort()).toEqual(['sw1/FastEthernet0/1', 'sw1/FastEthernet0/2', 'sw1/FastEthernet0/3']);
  });

  it('a static trunk: config, oper trunk, and the allowed VLANs that exist (canonical)', () => {
    const { sim, sw } = world();
    const trunk = portSnap(sim, 'sw1', 'FastEthernet0/1').l2!;
    expect(trunk).toEqual({
      config: { mode: 'trunk', negotiate: true, accessVlan: 1, nativeVlan: 99, allowed: '10,20,30' },
      oper: 'trunk',
      active: '',
    });
    expect(Object.keys(trunk)).toEqual(['config', 'oper', 'active']);
    // VLANs come into existence as rows
    const vlans = sw.tables.get<VlanRow>('vlans')!;
    vlans.set({ key: vlanKey(20), vlan: 20, name: 'VLAN0020', status: 'active', source: 'config', updatedAt: sim.now });
    vlans.set({ key: vlanKey(10), vlan: 10, name: 'VLAN0010', status: 'active', source: 'config', updatedAt: sim.now });
    expect(portSnap(sim, 'sw1', 'FastEthernet0/1').l2!.active).toBe('10,20');
    // the implicit VLANs exist without rows
    sim.configure('sw1', ['interface FastEthernet0/1', 'switchport trunk allowed vlan all']);
    const all = portSnap(sim, 'sw1', 'FastEthernet0/1').l2!;
    expect(all.config.allowed).toBe('1-4094');
    expect(all.active).toBe('1,10,20,1002-1005');
  });

  it('an access port with a VLAN, and a nonegotiate access port: present, oper access, no active list', () => {
    const { sim } = world();
    expect(portSnap(sim, 'sw1', 'FastEthernet0/2').l2).toEqual({ config: { ...DEFAULT_SWITCHPORT, accessVlan: 10 }, oper: 'access' });
    expect(portSnap(sim, 'sw1', 'FastEthernet0/3').l2).toEqual({ config: { ...DEFAULT_SWITCHPORT, mode: 'access', negotiate: false }, oper: 'access' });
  });

  it('a dynamic port takes its oper mode from the dtp row, and appears once it is a trunk', () => {
    const { sim, sw } = world();
    const port = 'FastEthernet0/4';
    const dtp = sw.tables.get<DtpRow>('dtp')!;
    dtp.set({ key: port, port, admin: 'dynamic-auto', oper: 'access', status: 'waiting', updatedAt: sim.now });
    expect(portSnap(sim, 'sw1', port).l2).toBeUndefined();
    dtp.set({ key: port, port, admin: 'dynamic-auto', oper: 'trunk', status: 'negotiated', updatedAt: sim.now });
    expect(portSnap(sim, 'sw1', port).l2).toEqual({ config: DEFAULT_SWITCHPORT, oper: 'trunk', active: '1,1002-1005' });
    // a static access port ignores a stale trunk row
    dtp.set({ key: 'FastEthernet0/3', port: 'FastEthernet0/3', admin: 'access', oper: 'trunk', status: 'static', updatedAt: sim.now });
    expect(portSnap(sim, 'sw1', 'FastEthernet0/3').l2!.oper).toBe('access');
  });

  it('forwarding lists the VLANs whose stp row is forwarding; absent without any stp row; empty when none forwards', () => {
    const { sim, sw } = world();
    const port = 'FastEthernet0/1';
    const stp = sw.tables.get<StpPortRow>('stp')!;
    const row = (vlan: number, state: StpPortRow['state']): StpPortRow => ({
      key: stpKey(vlan, port),
      vlan,
      port,
      role: 'designated',
      state,
      protocol: 'stp',
      cost: 19,
      portId: '128.1',
      designatedBridge: '32768/00:00:00:00:00:01',
      designatedPort: '128.1',
      edge: false,
      stateSince: sim.now,
      updatedAt: sim.now,
    });
    expect(portSnap(sim, 'sw1', port).l2!.forwarding).toBeUndefined();
    stp.set(row(10, 'listening'));
    stp.set(row(20, 'learning'));
    expect(portSnap(sim, 'sw1', port).l2!.forwarding).toBe('');
    stp.set(row(20, 'forwarding'));
    stp.set(row(1, 'forwarding'));
    stp.set(row(30, 'forwarding'));
    expect(portSnap(sim, 'sw1', port).l2!.forwarding).toBe('1,20,30');
    // another port's rows do not count
    stp.set({ ...row(40, 'forwarding'), key: stpKey(40, 'FastEthernet0/2'), port: 'FastEthernet0/2' });
    expect(portSnap(sim, 'sw1', port).l2!.forwarding).toBe('1,20,30');
    expect(portSnap(sim, 'sw1', 'FastEthernet0/2').l2!.forwarding).toBe('40');
  });

  it('channel and security come from the etherchannel and port-security rows, and make a default port appear', () => {
    const { sim, sw } = world();
    const channels = sw.tables.get<EtherchannelRow>('etherchannel')!;
    const member = (port: string, state: EtherchannelRow['state']): EtherchannelRow => ({
      key: port,
      port,
      group: 1,
      bundle: 'Port-channel1',
      protocol: 'lacp',
      mode: 'active',
      state,
      updatedAt: sim.now,
    });
    channels.set(member('FastEthernet0/5', 'bundled'));
    channels.set(member('FastEthernet0/6', 'suspended'));
    expect(portSnap(sim, 'sw1', 'FastEthernet0/5').l2).toEqual({ config: DEFAULT_SWITCHPORT, oper: 'access', channel: { group: 1, bundle: 'Port-channel1', state: 'bundled' } });
    expect(portSnap(sim, 'sw1', 'FastEthernet0/6').l2!.channel).toEqual({ group: 1, bundle: 'Port-channel1', state: 'suspended' });

    const security = sw.tables.get<PortSecurityRow>('port-security')!;
    security.set({ key: 'FastEthernet0/7', port: 'FastEthernet0/7', max: 1, count: 1, violation: 'shutdown', sticky: true, violations: 2, status: 'secure-shutdown', updatedAt: sim.now });
    expect(portSnap(sim, 'sw1', 'FastEthernet0/7').l2).toEqual({
      config: DEFAULT_SWITCHPORT,
      oper: 'access',
      security: { status: 'secure-shutdown', count: 1, max: 1, violations: 2 },
    });
    expect(Object.keys(portSnap(sim, 'sw1', 'FastEthernet0/7').l2!)).toEqual(['config', 'oper', 'security']);
  });

  it('a Port-channel reads its own section and takes its oper mode from its bundled members', () => {
    const { sim, sw } = world();
    const made = sw.ensureVirtualPort('Port-channel1', sim.now);
    expect(made.ok).toBe(true);
    const po = sw.port('Port-channel1')!;
    expect(po.role).toBe('channel');
    // no members: default view, absent
    expect(portSnap(sim, 'sw1', 'Port-channel1').l2).toBeUndefined();
    const channels = sw.tables.get<EtherchannelRow>('etherchannel')!;
    const dtp = sw.tables.get<DtpRow>('dtp')!;
    for (const port of ['FastEthernet0/5', 'FastEthernet0/6']) {
      channels.set({ key: port, port, group: 1, bundle: 'Port-channel1', protocol: 'lacp', mode: 'active', state: 'bundled', updatedAt: sim.now });
      dtp.set({ key: port, port, admin: 'dynamic-desirable', oper: 'trunk', status: 'negotiated', updatedAt: sim.now });
    }
    expect(portSnap(sim, 'sw1', 'Port-channel1').l2).toEqual({ config: DEFAULT_SWITCHPORT, oper: 'trunk', active: '1,1002-1005' });
    // one member falls back to access: the bundle is no trunk
    dtp.set({ key: 'FastEthernet0/6', port: 'FastEthernet0/6', admin: 'dynamic-desirable', oper: 'access', status: 'negotiated', updatedAt: sim.now });
    expect(portSnap(sim, 'sw1', 'Port-channel1').l2).toBeUndefined();
    // a suspended member does not count
    dtp.set({ key: 'FastEthernet0/6', port: 'FastEthernet0/6', admin: 'dynamic-desirable', oper: 'trunk', status: 'negotiated', updatedAt: sim.now });
    channels.set({ key: 'FastEthernet0/6', port: 'FastEthernet0/6', group: 1, bundle: 'Port-channel1', protocol: 'lacp', mode: 'active', state: 'suspended', updatedAt: sim.now });
    expect(portSnap(sim, 'sw1', 'Port-channel1').l2!.oper).toBe('trunk');
    // the bundle's own static mode wins
    sim.configure('sw1', ['interface Port-channel1', 'switchport mode access']);
    expect(portSnap(sim, 'sw1', 'Port-channel1').l2).toEqual({ config: { ...DEFAULT_SWITCHPORT, mode: 'access' }, oper: 'access' });
  });

  it('buildPortL2View is a pure read: two calls give equal, fresh objects and the config is a copy', () => {
    const { sw } = world();
    const p = sw.port('FastEthernet0/1')!;
    const a = buildPortL2View(sw, p);
    const b = buildPortL2View(sw, p);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a!.config).not.toBe(b!.config);
    expect(buildPortL2View(sw, sw.port('FastEthernet0/4')!)).toBeUndefined();
  });
});

describe('subinterface members and the world profile', () => {
  it('parent and dot1q are copied from the port spec and state, after every P0.5 member', () => {
    const sim = createSimulation({ seed: 2 });
    sim.loadTopology(pcRouterPc());
    sim.runFor(60 * SEC);
    const r1 = sim.device('r1')!;
    const parent = r1.port('GigabitEthernet0/0')!;
    const sub: PortState = {
      ...parent,
      id: 'GigabitEthernet0/0.10',
      spec: { ...parent.spec, name: 'GigabitEthernet0/0.10', short: 'Gi0/0.10', kind: 'virtual', role: 'subif', allowedRoles: ['subif'], parent: parent.id },
      role: 'subif',
      counters: { ...parent.counters },
      l3: {},
      tx: { ...parent.tx },
      dot1q: { vid: 10, native: false },
    };
    delete sub.link;
    const sources = { links: { radioPortView: () => undefined } as never };
    const s = buildPortSnapshot(r1, sub, sources);
    expect(s.parent).toBe('GigabitEthernet0/0');
    expect(s.dot1q).toEqual({ vid: 10, native: false });
    expect(s.dot1q).not.toBe(sub.dot1q);
    expect(s.virtual).toBe(true);
    expect(s.l2).toBeUndefined();
    const keys = Object.keys(s);
    expect(keys.indexOf('parent')).toBeGreaterThan(keys.indexOf('connector'));
    expect(keys.at(-2)).toBe('parent');
    expect(keys.at(-1)).toBe('dot1q');
    // a physical port of a P1 router has neither
    const plain = buildPortSnapshot(r1, parent, sources);
    expect('parent' in plain).toBe(false);
    expect('dot1q' in plain).toBe(false);
    const native: PortState = { ...sub, dot1q: { vid: 99, native: true } };
    expect(buildPortSnapshot(r1, native, sources).dot1q).toEqual({ vid: 99, native: true });
  });

  it('SimSnapshot.profile is P2 for a P2 world, absent for a P1 one, and follows a load', () => {
    const p2 = createP2Simulation({ seed: 1, factories: FACTORIES });
    expect(p2.snapshot().profile).toBe('P2');
    const p1 = createP2Simulation({ seed: 1, profile: 'P1', factories: FACTORIES });
    expect('profile' in p1.snapshot()).toBe(false);
    p2.loadTopology(twoPcsAndSwitch());
    expect('profile' in p2.snapshot()).toBe(false);
    expect(Object.keys(createSimulation({ seed: 1, profile: 'P2' }).snapshot()).at(-1)).toBe('profile');
  });
});
