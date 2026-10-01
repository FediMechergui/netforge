/**
 * sim — the profile sweep for P3 (ARCHITECTURE-P3 D2, §2.9, §7 W1 sim, §9.2 W1 item 16): every "P2" literal of the
 * facade (`sim/simulation.ts` export), the snapshot cache (`sim/snapshot-cache.ts`) and the scenario kit
 * (`sim/scenarios/kit.ts` `topology`) reads "P2 or later". A P3 world reports and plumbs 'P3', exports
 * `profile: 'P3'` with the schema that can express it (`schemaIdFor`: 1.3, §2.9) in the same step, and its snapshot
 * carries `profile: 'P3'`; P1 and P2 worlds keep every byte (their own tests stay unchanged).
 *
 * The full reload round trip of every world kind is `accept.p3.profile` (W4); the one case here only shows that the
 * facade takes the profile of a P3 document back.
 */
import { describe, expect, it } from 'vitest';
import { SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID_1_1, TOPOLOGY_SCHEMA_ID_1_2, TOPOLOGY_SCHEMA_ID_1_3, schemaIdFor } from '../src/contracts/topology.js';
import { device, link, topology } from '../src/sim/scenarios/kit.js';
import { twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';

describe('a P3 world', () => {
  it("reports 'P3' and plumbs it into every device it builds", () => {
    const sim = createSimulation({ seed: 1, profile: 'P3' });
    expect(sim.profile).toBe('P3');
    const sw = sim.addDevice({ type: 'switch.nfc2960' });
    const r = sim.addDevice({ type: 'router.nf2911', name: 'R1' });
    const pc = sim.addDevice({ type: 'pc.nfpc' });
    for (const id of [sw, r, pc]) {
      expect(sim.device(id)!.spec.profile).toBe('P3');
      expect(sim.device(id)!.profile).toBe('P3');
    }
    expect(sim.journal().origin.profile).toBe('P3');
  });

  it("exports profile 'P3' with schemaIdFor's schema in the same step, schema first", () => {
    const sim = createSimulation({ seed: 1, profile: 'P3' });
    sim.addDevice({ type: 'pc.nfpc', name: 'PC1' });
    const out = sim.exportTopology();
    expect(out.profile).toBe('P3');
    expect(out.schema).toBe(TOPOLOGY_SCHEMA_ID_1_3);
    expect(out.schema).toBe(schemaIdFor(out));
    expect(Object.keys(out)[0]).toBe('schema');
    expect(Object.keys(out).at(-1)).toBe('profile');
    const empty = createSimulation({ seed: 1, profile: 'P3' }).exportTopology();
    expect(empty).toEqual({ schema: TOPOLOGY_SCHEMA_ID_1_3, seed: 1, devices: [], links: [], profile: 'P3' });
  });

  it('a P3 document loaded into a fresh world makes it a P3 world, and it exports the same text', () => {
    const sim = createSimulation({ seed: 1, profile: 'P3' });
    sim.addDevice({ type: 'pc.nfpc', name: 'PC1' });
    sim.addDevice({ type: 'router.nf2911', name: 'R1' });
    const out = sim.exportTopology();
    const back = createSimulation({ seed: 1 });
    back.loadTopology(out);
    expect(back.profile).toBe('P3');
    for (const d of back.devices()) expect(d.spec.profile).toBe('P3');
    expect(JSON.stringify(back.exportTopology())).toBe(JSON.stringify(out));
  });

  it("carries profile 'P3' in its snapshot, as the last key, after a run", () => {
    const sim = createSimulation({ seed: 7, profile: 'P3' });
    sim.addDevice({ type: 'pc.nfpc', name: 'PC1' });
    sim.runFor(5 * SEC);
    const snap = sim.snapshot();
    expect(snap.profile).toBe('P3');
    expect(Object.keys(snap).at(-1)).toBe('profile');
    expect(sim.snapshot({ devices: [] }).profile).toBe('P3');
  });

  it('a P1 document loaded into a P3 world makes it a P1 world again: no profile anywhere', () => {
    const sim = createSimulation({ seed: 1, profile: 'P3' });
    sim.loadTopology(twoPcsAndSwitch());
    expect(sim.profile).toBe('P1');
    for (const d of sim.devices()) expect('profile' in d.spec).toBe(false);
    expect('profile' in sim.snapshot()).toBe(false);
    const out = sim.exportTopology();
    expect('profile' in out).toBe(false);
    expect(out.schema).toBe(TOPOLOGY_SCHEMA_ID_1_1);
  });
});

describe('P1 and P2 worlds after the sweep', () => {
  it('a P2 world still exports profile P2 and schema 1.2, and its snapshot says P2', () => {
    const sim = createSimulation({ seed: 1, profile: 'P2' });
    sim.addDevice({ type: 'pc.nfpc', name: 'PC1' });
    const out = sim.exportTopology();
    expect(out.profile).toBe('P2');
    expect(out.schema).toBe(TOPOLOGY_SCHEMA_ID_1_2);
    expect(sim.snapshot().profile).toBe('P2');
  });

  it('a P1 world writes no profile in its export or its snapshot', () => {
    const sim = createSimulation({ seed: 1 });
    sim.addDevice({ type: 'pc.nfpc', name: 'PC1' });
    expect('profile' in sim.exportTopology()).toBe(false);
    expect(sim.exportTopology().schema).toBe(TOPOLOGY_SCHEMA_ID_1_1);
    expect('profile' in sim.snapshot()).toBe(false);
  });
});

describe('the scenario kit', () => {
  const devices = [device('pc1', 'pc.nfpc', 'PC1', 100, 100), device('sw1', 'switch.nfc2960', 'SW1', 200, 100)];
  const links = [link('l_pc1_sw1', 'pc1', 'GigabitEthernet0', 'sw1', 'FastEthernet0/1')];

  it("writes a P3 topology with profile 'P3' and the schema that can express it", () => {
    const p3 = topology(7, devices, links, ['An objective'], 'Notes', { profile: 'P3' });
    expect(p3.profile).toBe('P3');
    expect(p3.schema).toBe(TOPOLOGY_SCHEMA_ID_1_3);
    expect(p3.schema).toBe(schemaIdFor(p3));
    expect({ ...p3, schema: TOPOLOGY_SCHEMA_ID_1_1, profile: undefined }).toEqual({ ...topology(7, devices, links, ['An objective'], 'Notes'), profile: undefined });
  });

  it('keeps P2 and P1 topologies exactly as before', () => {
    const p2 = topology(7, devices, links, [], '', { profile: 'P2' });
    expect(p2.profile).toBe('P2');
    expect(p2.schema).toBe(TOPOLOGY_SCHEMA_ID_1_2);
    const p1 = topology(7, devices, links, [], '');
    expect(p1).toEqual({ schema: TOPOLOGY_SCHEMA_ID_1_1, seed: 7, devices, links, objectives: [], notes: '' });
    expect('profile' in p1).toBe(false);
    expect(topology(7, devices, links, [], '', { profile: 'P1' })).toEqual(p1);
  });
});
