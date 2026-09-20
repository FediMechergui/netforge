/**
 * Simulation facade: ids, names, topology lifecycle, time control and observation.
 */
import { describe, expect, it } from 'vitest';
import { SEC } from '../src/contracts/time.js';
import { createIdGen } from '../src/sim/ids.js';
import { SCENARIOS } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';
import { ofKind, ping } from './sim.harness.js';

describe('sim/ids', () => {
  it('counts in zero-padded hex', () => {
    const g = createIdGen('d');
    const ids = Array.from({ length: 11 }, () => g.next());
    expect(ids.slice(0, 2)).toEqual(['d_0001', 'd_0002']);
    expect(ids[9]).toBe('d_000a');
    expect(g.issued).toBe(11);
    expect(createIdGen('l').next()).toBe('l_0001');
    expect(() => createIdGen('')).toThrow();
  });
});

describe('sim/facade', () => {
  it('builds a network from API calls with generated ids and names', () => {
    const sim = createSimulation({ seed: 1 });
    const pcA = sim.addDevice({ type: 'pc.nfpc' });
    const sw = sim.addDevice({ type: 'switch.nfc2960', position: { x: 10, y: 20 } });
    const pcB = sim.addDevice({ type: 'pc.nfpc', startupConfig: 'hostname Beta\n' });
    expect([pcA, sw, pcB]).toEqual(['d_0001', 'd_0002', 'd_0003']);
    expect(sim.device(pcA)!.spec.name).toBe('PC1');
    expect(sim.device(sw)!.spec.name).toBe('Switch1');
    expect(sim.device(pcB)!.spec.name).toBe('PC2');
    expect(() => sim.addDevice({ type: 'nope' })).toThrow(/Unknown device type/);
    expect(() => sim.addDevice({ id: pcA, type: 'pc.nfpc' })).toThrow(/already exists/);

    expect(sim.validateLink({ a: { device: pcA, port: 'gi0' }, b: { device: sw, port: 'fa0/9' } }).ok).toBe(true);
    const bad = sim.validateLink({ a: { device: pcA, port: 'Fa0/1' }, b: { device: sw, port: 'fa0/9' } });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain('no port');

    const v0 = sim.snapshot().topologyVersion;
    const l1 = sim.addLink({ a: { device: pcA, port: 'g0' }, b: { device: sw, port: 'Fa0/1' } });
    sim.addLink({ a: { device: pcB, port: 'GigabitEthernet0' }, b: { device: sw, port: 'fa 0/2' } });
    expect(l1).toBe('l_0001');
    expect(sim.link(l1)!.a.port).toBe('GigabitEthernet0');
    expect(sim.link(l1)!.lengthM).toBe(3);
    expect(sim.snapshot().topologyVersion).toBe(v0 + 2);

    sim.moveDevice(sw, { x: 99, y: 1 });
    expect(sim.snapshot().topologyVersion).toBe(v0 + 2);
    expect(ofKind(sim.trace(0).events, 'topologyChanged').at(-1)).toMatchObject({ op: 'move', id: sw });

    sim.runFor(40 * SEC);
    expect(sim.link(l1)!.up).toBe(true);
    const s = sim.cli.open(pcA, 'console');
    expect(sim.cli.exec(s, 'ip address 192.168.1.1 255.255.255.0').error).toBeUndefined();
    const s2 = sim.cli.open(pcB, 'console');
    expect(sim.cli.exec(s2, 'ip address 192.168.1.2 255.255.255.0').error).toBeUndefined();
    expect(ping(sim, pcA, '192.168.1.2').text).toContain('Sent 5, received 5, lost 0');
    // plugging a cable into a booted device brings the processes' link state up
    const snap = sim.snapshot();
    expect(snap.devices.find((d) => d.id === sw)!.tables.cam).toHaveLength(2);
    expect(snap.pduCount).toBeGreaterThan(10);
    expect(snap.inflight).toEqual([]);
    expect(sim.pdu(1)).toBeDefined();

    sim.renameDevice(pcB, 'Beta2');
    expect(sim.device(pcB)!.hostname).toBe('Beta2');
    expect(sim.device(pcB)!.running.get('hostname')).toEqual(['Beta2']);

    sim.removeDevice(pcB);
    expect(sim.device(pcB)).toBeUndefined();
    expect(sim.snapshot().links).toHaveLength(1);
    expect(sim.cli.session(s2)).toBeUndefined();
    sim.removeLink(l1);
    expect(sim.snapshot().links).toHaveLength(0);
    expect(sim.device(pcA)!.port('GigabitEthernet0')!.operUp).toBe(false);
    expect(() => sim.removeLink(l1)).toThrow();
  });

  it('controls time: runUntil, runFor, step, runToIdle with periodic sweeps', () => {
    const sim = createSimulation({ seed: 1 });
    expect(sim.runUntil(5).to).toBe(5);
    expect(sim.runUntil(2)).toEqual({ events: 0, from: 5, to: 5 });
    expect(() => sim.runUntil(1.5)).toThrow(RangeError);
    expect(() => sim.runFor(-1)).toThrow(RangeError);
    sim.loadTopology(SCENARIOS[0]!.build());
    expect(sim.now).toBe(0);
    const stats = sim.runToIdle();
    expect(stats.events).toBeGreaterThan(0);
    // only ageing sweeps remain
    expect(sim.nextEventTime()).toBeDefined();
    const ev = sim.step();
    expect(ev?.kind).toBe('timer');
    // D10: idleness is decided by the periodic flag the sweeps arm with (the P0 key list was removed at W7)
    expect(ev?.kind === 'timer' && ev.periodic).toBe(true);
    expect(ev?.kind === 'timer' && ['cam-sweep', 'arp-sweep'].includes(ev.key)).toBe(true);
    expect(sim.runToIdle().events).toBe(0);
    expect(sim.snapshot().pendingEvents).toBeGreaterThan(0);
  });

  it('exports a topology that reloads to the same snapshot', () => {
    const a = createSimulation({ seed: 8 });
    a.loadTopology(SCENARIOS[1]!.build());
    const exported = a.exportTopology();
    const b = createSimulation({ seed: 8 });
    b.loadTopology(exported);
    a.runFor(60 * SEC);
    b.runFor(60 * SEC);
    expect(JSON.stringify(b.snapshot())).toBe(JSON.stringify(a.snapshot()));
  });

  it('turbo mode keeps no trace but still notifies listeners', () => {
    const sim = createSimulation({ seed: 1, mode: 'turbo' });
    let seen = 0;
    const off = sim.onTrace(() => seen++);
    sim.loadTopology(SCENARIOS[0]!.build());
    sim.runFor(40 * SEC);
    off();
    expect(seen).toBeGreaterThan(0);
    const t = sim.trace(0);
    expect(t.events).toEqual([]);
    expect(t.next).toBe(seen);
  });

  it('applies config-fragment and link-impairment faults', () => {
    const sim = createSimulation({ seed: 1 });
    sim.loadTopology(SCENARIOS[1]!.build());
    sim.runFor(60 * SEC);
    sim.injectFault(sim.now, { id: 'f', kind: 'config-fragment', target: { device: 'r1' }, params: { config: 'interface Gi0/1\n shutdown\n' } });
    sim.injectFault(sim.now, { id: 'i', kind: 'link-impairment', target: { link: 'l_pc1_r1' }, params: { impairments: { latencyNs: 1000 }, durationNs: SEC } });
    sim.runFor(1);
    expect(sim.device('r1')!.port('GigabitEthernet0/1')!.adminUp).toBe(false);
    expect(sim.link('l_pc1_r1')!.impairments.latencyNs).toBe(1000);
    sim.runFor(2 * SEC);
    expect(sim.link('l_pc1_r1')!.impairments.latencyNs).toBe(0);
    sim.injectFault(sim.now, { id: 'g', kind: 'config-fragment', target: { device: 'r1' }, params: { lines: ['interface GigabitEthernet0/1', ' no shutdown'] } });
    sim.runFor(1);
    expect(sim.link('l_r1_pc2')!.up).toBe(true);
  });
});
