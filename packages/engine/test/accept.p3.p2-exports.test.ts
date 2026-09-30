/**
 * P3 acceptance — the CCNA 2 labs export byte for byte as P2 did (ARCHITECTURE-P3 D3, §9.2 W0 item 6, §9.4, §10.1 row
 * `accept.p3.p2-exports`; recorded in W0 from the unchanged engine at 5263f16).
 *
 * test/goldens/p2-lab-exports.json is the twin of p1-template-exports.json for the P2 profile: the topology document
 * every CCNA 2 lab exports right after the worker's `loadScenario` has loaded it (the lab seed, else SCENARIO_SEED;
 * the lab stamp; the scheduled faults injected), in course order. Every lab must export the same document byte for
 * byte (`JSON.stringify` of the export equals that of the golden entry, key order included): schema 1.2 and
 * `profile: 'P2'`, every device's startup text, the links and the lab stamp. A renderer, config-rule, schema or
 * loader change that moves a P2 export fails here. The export is also a fixed point: loading it again exports the
 * same bytes.
 *
 * Regenerating (the architect only, and only for a §9.4 change): `NF_RECORD_P2_EXPORTS=<lab,lab,…|all>` re-records the
 * named labs, keeps every other entry, and prints which labs changed for the wave report.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { assert, beforeAll, describe, expect, it } from 'vitest';
import type { ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { TOPOLOGY_SCHEMA_ID_1_2, type Topology } from '../src/contracts/topology.js';
import { CCNA2_LABS, SCENARIO_SEED } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';

/** Contents of test/goldens/p2-lab-exports.json. */
interface ExportsGolden {
  readonly about: string;
  readonly labs: Readonly<Record<string, Topology>>;
}

const GOLDEN_URL = new URL('./goldens/p2-lab-exports.json', import.meta.url);

const ABOUT =
  'P2 lab exports (ARCHITECTURE-P3 D3, §9.4, §10.1 accept.p3.p2-exports), recorded from the unchanged engine at commit ' +
  '5263f16 before any P3 code: the topology document every CCNA 2 lab exports right after the worker loads it (lab ' +
  'seed, lab stamp, scheduled faults). Change it only as §9.4 allows, by re-recording with NF_RECORD_P2_EXPORTS.';

let goldenCache: ExportsGolden | undefined;

function golden(): ExportsGolden {
  if (goldenCache === undefined) {
    if (!existsSync(GOLDEN_URL)) throw new Error('test/goldens/p2-lab-exports.json is missing; it is recorded once, from the unchanged engine (P3 §7 W0).');
    goldenCache = JSON.parse(readFileSync(GOLDEN_URL, 'utf8')) as ExportsGolden;
  }
  return goldenCache;
}

/** The lab as the worker's `loadScenario` loads it: seed, lab stamp, scheduled faults. */
function loaded(lab: ScenarioInfo): Simulation {
  const sim = createSimulation({ seed: lab.seed ?? SCENARIO_SEED });
  const topo = lab.build();
  sim.loadTopology((lab.tasks?.length ?? 0) > 0 ? { ...topo, lab: { name: lab.name, version: lab.version ?? 1 } } : topo);
  for (const f of lab.faults ?? []) sim.injectFault(f.at, f.fault);
  return sim;
}

/** The document the lab exports right after the load (a JSON copy: exactly what a saved file holds). */
function exported(lab: ScenarioInfo): Topology {
  return JSON.parse(JSON.stringify(loaded(lab).exportTopology())) as Topology;
}

const RECORD = (process.env['NF_RECORD_P2_EXPORTS'] ?? '').trim();

/** Re-record the labs `RECORD` names (`all` = every CCNA 2 lab), keeping every other entry. */
function record(): void {
  const names = RECORD === 'all' ? CCNA2_LABS.map((l) => l.name) : RECORD.split(',').map((s) => s.trim()).filter((s) => s !== '');
  for (const name of names) if (!CCNA2_LABS.some((l) => l.name === name)) throw new Error(`NF_RECORD_P2_EXPORTS names ${name}, which is not a CCNA 2 lab`);
  const previous = existsSync(GOLDEN_URL) ? golden() : undefined;
  const labs: Record<string, Topology> = {};
  for (const lab of CCNA2_LABS) {
    const old = previous?.labs[lab.name];
    if (!names.includes(lab.name)) {
      if (old === undefined) throw new Error(`${lab.name} has no golden entry yet; re-record it too`);
      labs[lab.name] = old;
      continue;
    }
    const now = exported(lab);
    if (old !== undefined) console.log(`${lab.name}: ${JSON.stringify(old) === JSON.stringify(now) ? 'unchanged' : 're-recorded (the export changed)'}`);
    labs[lab.name] = now;
  }
  const file: ExportsGolden = { about: ABOUT, labs };
  writeFileSync(GOLDEN_URL, `${JSON.stringify(file, null, 2)}\n`);
  goldenCache = file;
}

describe('accept P3: every CCNA 2 lab exports the P2 bytes', () => {
  beforeAll(() => {
    if (RECORD !== '') record();
  }, 600_000);

  it('covers every CCNA 2 lab, in course order', () => {
    expect(CCNA2_LABS).toHaveLength(20);
    expect(Object.keys(golden().labs)).toEqual(CCNA2_LABS.map((l) => l.name));
    expect(golden().about).toBe(ABOUT);
  });

  for (const lab of CCNA2_LABS) {
    it(`${lab.name}: exported after load equals the golden byte for byte (schema 1.2, profile P2), and reloads to the same bytes`, () => {
      const expected = golden().labs[lab.name];
      if (expected === undefined) return assert.fail(`${lab.name} has no entry in test/goldens/p2-lab-exports.json`);
      const out = exported(lab);
      expect(out.schema, lab.name).toBe(TOPOLOGY_SCHEMA_ID_1_2);
      expect(out.profile, lab.name).toBe('P2');
      expect(out, lab.name).toEqual(expected);
      expect(JSON.stringify(out), `${lab.name}: byte for byte, key order included`).toBe(JSON.stringify(expected));
      // the export is a fixed point: loading it again (as a saved file is opened) exports the same bytes
      const again = createSimulation({ seed: lab.seed ?? SCENARIO_SEED });
      again.loadTopology(out);
      expect(again.profile, lab.name).toBe('P2');
      expect(JSON.stringify(again.exportTopology()), `${lab.name}: reloaded export`).toBe(JSON.stringify(out));
    });
  }
});
