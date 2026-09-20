/**
 * sim — stable MACs (ARCHITECTURE-P1 D8, §3.3 step 4): per-device MAC bases independent of seed and creation order,
 * deterministic salt bumps on a base collision, `hardware.macSalt` persisted and reloaded identically.
 */
import { describe, expect, it } from 'vitest';
import { deviceMacBase, portMac } from '../src/contracts/addr.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { TOPOLOGY_SCHEMA_ID, type Topology } from '../src/contracts/topology.js';
import { createSimulation } from '../src/sim/simulation.js';

/** device id → [port id, mac] in canonical port order. */
function macsOf(sim: Simulation): Record<string, [string, string][]> {
  const out: Record<string, [string, string][]> = {};
  for (const d of sim.devices()) out[d.id] = [...d.ports.values()].map((p) => [p.id, p.mac]);
  return out;
}

const TYPES: Record<string, string> = { pc1: 'pc.nfpc', sw1: 'switch.nfc2960', r1: 'router.nf2911', r2: 'router.nf1941' };

describe('sim: stable MACs (D8)', () => {
  it('gives identical MACs per device id whatever the seed and the creation order', () => {
    const a = createSimulation({ seed: 1 });
    for (const id of ['pc1', 'sw1', 'r1', 'r2']) a.addDevice({ id, type: TYPES[id]!, modules: id === 'r2' ? [{ slot: '0/1', module: 'mod.ehwic-2t' }] : undefined });
    const b = createSimulation({ seed: 987_654 });
    for (const id of ['r2', 'r1', 'sw1', 'pc1']) b.addDevice({ id, type: TYPES[id]!, modules: id === 'r2' ? [{ slot: '0/1', module: 'mod.ehwic-2t' }] : undefined });

    const ma = macsOf(a);
    const mb = macsOf(b);
    for (const id of Object.keys(TYPES)) expect(mb[id]).toEqual(ma[id]);

    // D8 vectors: portMac(deviceMacBase(id), ordinal); module ports use 128 + slot×16 + i
    const pc = a.device('pc1')!;
    expect(pc.port('GigabitEthernet0')!.mac).toBe(portMac(deviceMacBase('pc1'), pc.port('GigabitEthernet0')!.ordinal!));
    expect(a.device('r2')!.port('Serial0/1/0')!.mac).toBe(portMac(deviceMacBase('r2'), 144));
    expect(a.device('r1')!.spec.macSalt).toBe(0);
    const snap = a.snapshot().devices.find((d) => d.id === 'sw1')!;
    expect(snap.baseMac).toBe(portMac(deviceMacBase('sw1'), 0));
  });

  it('keeps the published vector for the first generated id', () => {
    const sim = createSimulation({ seed: 3 });
    const id = sim.addDevice({ type: 'pc.nfpc' });
    expect(id).toBe('d_0001');
    expect(sim.device(id)!.port('GigabitEthernet0')!.mac).toBe('02:4e:59:e8:af:01');
  });

  it('bumps the salt of the later device on a base collision, persists it and reloads identically', () => {
    const sim = createSimulation({ seed: 5 });
    // 'a' with salt 1 hashes "a#1", exactly the salt-0 base of the device id "a#1"
    sim.addDevice({ id: 'a', type: 'pc.nfpc', macSalt: 1 });
    sim.addDevice({ id: 'a#1', type: 'pc.nfpc' });
    sim.addDevice({ id: 'plain', type: 'pc.nfpc' });
    expect(sim.device('a')!.spec.macSalt).toBe(1);
    expect(sim.device('a#1')!.spec.macSalt).toBe(1);
    expect(sim.device('a#1')!.port('GigabitEthernet0')!.mac).toBe(portMac(deviceMacBase('a#1', 1), 1));
    expect(sim.device('a#1')!.port('GigabitEthernet0')!.mac).not.toBe(sim.device('a')!.port('GigabitEthernet0')!.mac);

    const exported = sim.exportTopology();
    expect(exported.devices.map((d) => [d.id, d.hardware])).toEqual([
      ['a', { macSalt: 1 }],
      ['a#1', { macSalt: 1 }],
      ['plain', undefined],
    ]);
    expect(Object.keys(exported.devices[2]!)).not.toContain('hardware');

    const reloaded = createSimulation({ seed: 77 });
    reloaded.loadTopology(exported);
    expect(macsOf(reloaded)).toEqual(macsOf(sim));
    expect(JSON.stringify(reloaded.exportTopology().devices)).toBe(JSON.stringify(exported.devices));
  });

  it('frees a MAC base when its device is removed', () => {
    const sim = createSimulation({ seed: 5 });
    sim.addDevice({ id: 'a', type: 'pc.nfpc', macSalt: 1 });
    sim.removeDevice('a');
    sim.addDevice({ id: 'a#1', type: 'pc.nfpc' });
    expect(sim.device('a#1')!.spec.macSalt).toBe(0);
  });

  it('reproduces a loaded 1.0 file with the same MACs in any simulation', () => {
    const topo: Topology = {
      schema: 'netforge.topology/1.0',
      seed: 1,
      devices: [
        { id: 'x1', type: 'pc.nfpc', name: 'X1', position: { logical: [0, 0] } },
        { id: 'x2', type: 'switch.nfc2960', name: 'X2', position: { logical: [10, 0] } },
      ],
      links: [{ id: 'l1', a: { device: 'x1', port: 'Gi0' }, b: { device: 'x2', port: 'Fa0/1' }, media: 'auto' }],
    };
    const one = createSimulation({ seed: 1 });
    one.loadTopology(topo);
    const two = createSimulation({ seed: 2 });
    two.loadTopology(topo);
    expect(macsOf(two)).toEqual(macsOf(one));
    expect(one.exportTopology().schema).toBe(TOPOLOGY_SCHEMA_ID);
  });
});
