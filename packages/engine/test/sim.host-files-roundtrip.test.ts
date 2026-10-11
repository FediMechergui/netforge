/**
 * sim.host-files-roundtrip — [S32] a host's `files:` store survives export and reload (W5 integration, the auto
 * report's gap: `Simulation.loadTopology` ignored `TopologyDevice.files` and `exportTopology` never wrote them, so a
 * script was lost on reload and never reached a grader clone). Loaded before boot, exported in path order when the
 * store is not empty, in the schema that can express it; a world with empty stores exports exactly as before.
 */
import { describe, expect, it } from 'vitest';
import { SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID_1_3, schemaIdFor, type Topology } from '../src/contracts/topology.js';
import { createSimulation } from '../src/sim/simulation.js';

const SCRIPT = { path: 'inventory.py', content: 'print("hi")\n' };
const NOTES = { path: 'notes.txt', content: 'two\n' };

/** One PC with two files in its store, in a P3 (or P1) world. */
function doc(profile?: 'P3'): Topology {
  const t: Topology = {
    schema: TOPOLOGY_SCHEMA_ID_1_3,
    seed: 5,
    devices: [{ id: 'pc1', type: 'pc.nfpc', name: 'PC1', position: { logical: [100, 100] }, files: [NOTES, SCRIPT] }],
    links: [],
    ...(profile !== undefined ? { profile } : {}),
  };
  return { ...t, schema: schemaIdFor(t) };
}

describe('[S32] host files: load, export, reload', () => {
  for (const profile of ['P3', undefined] as const) {
    it(`a ${profile ?? 'P1'} world keeps the store through export and reload`, () => {
      const sim = createSimulation({ seed: 5 });
      sim.loadTopology(doc(profile));
      const pc = sim.device('pc1')!;
      expect(pc.files?.('files').map((f) => f.path)).toEqual(['inventory.py', 'notes.txt']);
      expect(pc.readFile?.('files', 'inventory.py')?.content).toBe(SCRIPT.content);
      sim.runFor(10 * SEC);
      const out = sim.exportTopology();
      expect(out.schema).toBe(TOPOLOGY_SCHEMA_ID_1_3);
      expect(out.devices[0]!.files).toEqual([SCRIPT, NOTES]);
      const again = createSimulation({ seed: 5 });
      again.loadTopology(out);
      expect(again.device('pc1')!.readFile?.('files', 'notes.txt')?.content).toBe(NOTES.content);
      expect(again.exportTopology().devices[0]!.files).toEqual([SCRIPT, NOTES]);
    });
  }

  it('an empty store writes no files member', () => {
    const sim = createSimulation({ seed: 5, profile: 'P3' });
    sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1' });
    expect(sim.exportTopology().devices[0]).not.toHaveProperty('files');
  });
});
