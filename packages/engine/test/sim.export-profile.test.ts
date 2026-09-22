/**
 * sim — profile load and export with schema 1.2 (ARCHITECTURE-P2 D2, §2.9, §13 #14; §7 W2 sim): `loadTopology`
 * gives the world the document's profile (`t.profile ?? 'P1'`; a 1.1 document carrying `profile` loads as P1);
 * `exportTopology` writes `profile: 'P2'` and schema 1.2 only for a P2 world, and a P1 world exports byte-identically
 * as 1.1; the snapshot carries `profile: 'P2'` only for a P2 world.
 */
import { describe, expect, it } from 'vitest';
import { SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID, TOPOLOGY_SCHEMA_ID_1_1, TOPOLOGY_SCHEMA_ID_1_2, schemaIdFor, type Topology } from '../src/contracts/topology.js';
import { readNetforge, topologyToJson, writeNetforge } from '../src/io/netforge-file.js';
import { twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';

const manifest = { format: 1 as const, app: 'netforge/0.0.1', created: '2026-09-21T10:00:00.000Z', modified: '2026-09-21T10:00:00.000Z' };

/** The P0 two-PC template as a 1.2 document in the P2 profile (written as every writer must). */
function p2Doc(): Topology {
  const t: Topology = { ...twoPcsAndSwitch(), profile: 'P2' };
  return { ...t, schema: schemaIdFor(t) };
}

describe('loadTopology and the profile', () => {
  it('a P1 document (no profile) loads as P1, even into a P2 world', () => {
    const sim = createSimulation({ seed: 1, profile: 'P2' });
    expect(sim.profile).toBe('P2');
    sim.loadTopology(twoPcsAndSwitch());
    expect(sim.profile).toBe('P1');
    for (const d of sim.devices()) expect('profile' in d.spec).toBe(false);
    expect(sim.snapshot().profile).toBeUndefined();
    expect('profile' in sim.snapshot()).toBe(false);
  });

  it('a 1.2 document with profile P2 loads as P2: every device carries it', () => {
    const sim = createSimulation({ seed: 1 });
    sim.loadTopology(p2Doc());
    expect(sim.profile).toBe('P2');
    for (const d of sim.devices()) {
      expect(d.spec.profile).toBe('P2');
      expect(d.profile).toBe('P2');
    }
    expect(sim.snapshot().profile).toBe('P2');
    expect(Object.keys(sim.snapshot()).at(-1)).toBe('profile');
  });

  it('a 1.1 document carrying profile P2 is read with the 1.1 field set and loads as P1', () => {
    const sim = createSimulation({ seed: 1 });
    sim.loadTopology({ ...twoPcsAndSwitch(), schema: TOPOLOGY_SCHEMA_ID_1_1, profile: 'P2' });
    expect(sim.profile).toBe('P1');
    expect(sim.exportTopology().profile).toBeUndefined();
  });

  it('a 1.2 document without profile loads as P1', () => {
    const sim = createSimulation({ seed: 1 });
    sim.loadTopology({ ...twoPcsAndSwitch(), schema: TOPOLOGY_SCHEMA_ID_1_2 });
    expect(sim.profile).toBe('P1');
  });

  it('a failed load keeps the current profile', () => {
    const sim = createSimulation({ seed: 1, profile: 'P2' });
    const bad = { ...twoPcsAndSwitch(), devices: [{ ...twoPcsAndSwitch().devices[0]!, type: 'nope' }] };
    expect(() => sim.loadTopology(bad)).toThrow();
    expect(sim.profile).toBe('P2');
  });
});

describe('exportTopology and the profile', () => {
  it('a P1 world exports without profile, as schema 1.1 (the unchanged P1 guarantee)', () => {
    const sim = createSimulation({ seed: 1 });
    sim.loadTopology(twoPcsAndSwitch());
    const out = sim.exportTopology();
    expect(out.schema).toBe(TOPOLOGY_SCHEMA_ID);
    expect(out.schema).toBe(TOPOLOGY_SCHEMA_ID_1_1);
    expect('profile' in out).toBe(false);
    expect(Object.keys(out)[0]).toBe('schema');
    const empty = createSimulation({ seed: 1 }).exportTopology();
    expect(empty).toEqual({ schema: TOPOLOGY_SCHEMA_ID_1_1, seed: 1, devices: [], links: [] });
  });

  it('a P2 world exports profile P2 and schema 1.2 in the same step, schema first', () => {
    const sim = createSimulation({ seed: 1, profile: 'P2' });
    const empty = sim.exportTopology();
    expect(empty).toEqual({ schema: TOPOLOGY_SCHEMA_ID_1_2, seed: 1, devices: [], links: [], profile: 'P2' });
    expect(Object.keys(empty)[0]).toBe('schema');
    expect(empty.schema).toBe(schemaIdFor(empty));
    sim.loadTopology(p2Doc());
    const out = sim.exportTopology();
    expect(out.profile).toBe('P2');
    expect(out.schema).toBe(TOPOLOGY_SCHEMA_ID_1_2);
    // a world switched back to P1 by a load exports as 1.1 again
    sim.loadTopology(twoPcsAndSwitch());
    expect(sim.exportTopology().schema).toBe(TOPOLOGY_SCHEMA_ID_1_1);
  });

  it('a P2 export round-trips: reload gives the same profile, the same export and the same snapshot', () => {
    const sim = createSimulation({ seed: 7 });
    sim.loadTopology(p2Doc());
    sim.runFor(40 * SEC);
    const s = sim.cli.open('pc1', 'console');
    sim.cli.exec(s, 'ping 10.0.0.2');
    sim.runToIdle();
    const out = sim.exportTopology();
    expect(out.profile).toBe('P2');
    expect(out.schema).toBe(TOPOLOGY_SCHEMA_ID_1_2);

    const again = createSimulation({ seed: 7 });
    again.loadTopology(out);
    expect(again.profile).toBe('P2');
    expect(again.exportTopology()).toEqual({ ...out, devices: out.devices.map((d) => ({ ...d, runningConfig: undefined })) });
    // once booted, the reloaded world's running configs are the exported ones again
    again.runFor(40 * SEC);
    expect(again.exportTopology()).toEqual(out);
    // the loaded world equals a world that loaded the same document directly (boot, then the same script)
    const twin = createSimulation({ seed: 7 });
    twin.loadTopology(p2Doc());
    const fresh = createSimulation({ seed: 7 });
    fresh.loadTopology(twin.exportTopology());
    expect(JSON.stringify(fresh.snapshot())).toBe(JSON.stringify(twin.snapshot()));
    expect(fresh.snapshot().profile).toBe('P2');
  });

  it('the file writer keeps the profile and the 1.2 id through a save and a load', () => {
    const sim = createSimulation({ seed: 7 });
    sim.loadTopology(p2Doc());
    const out = sim.exportTopology();
    const json = topologyToJson(out);
    expect(json).toContain('"schema": "netforge.topology/1.2"');
    expect(json).toContain('"profile": "P2"');
    const file = writeNetforge({ manifest, topology: out, configs: {} });
    const read = readNetforge(file);
    const loaded = createSimulation({ seed: 7 });
    loaded.loadTopology(read.topology);
    expect(loaded.profile).toBe('P2');
    expect(loaded.exportTopology()).toEqual(out);
    // and a P1 export has no profile line at all
    const p1 = createSimulation({ seed: 7 });
    p1.loadTopology(twoPcsAndSwitch());
    expect(topologyToJson(p1.exportTopology())).not.toContain('profile');
  });
});
