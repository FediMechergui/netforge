/**
 * P3c acceptance — the CCNA 3 labs of cad4ac9 export byte for byte as P3a did (ARCHITECTURE-P3C §0 rule 5, D3, §7 W0,
 * §9.5, §10.1 row `accept.p3c.p3-exports`; recorded in W0 from the unchanged engine at cad4ac9). The twin of
 * `accept.p3.p2-exports` (p2-lab-exports.json) for the P3 profile.
 *
 * test/goldens/p3-lab-exports.json holds the topology document each of the 21 CCNA 3 labs of cad4ac9 exports right
 * after the worker's `loadScenario` has loaded it (the lab seed, else SCENARIO_SEED; the lab stamp; the scheduled
 * faults injected), in their course order then. Every lab must export the same document byte for byte
 * (`JSON.stringify` of the export equals that of the golden entry, key order included): schema 1.3 and
 * `profile: 'P3'`, every device's startup text, the links and the lab stamp. A renderer, config-rule, schema or loader
 * change that moves a P3 export fails here; a saved P3 file must keep reopening as it was saved. The export is also a
 * fixed point: loading it again as a saved lab world is reopened (its `lab.pendingFaults` re-scheduled) exports the
 * same bytes. The lab list is the golden's own (its keys, frozen by lab id),
 * never the live `CCNA3_LABS`: the labs P3c inserts are not part of this proof.
 *
 * Regenerating (the architect only, and only for a P3C §9.5 change, entry by entry):
 *   NF_RECORD_P3_EXPORTS=<lab,lab,…|all> npx vitest run --root packages/engine test/accept.p3c.p3-exports.test.ts
 * re-records the named labs, keeps every other entry, and prints which labs changed for the wave report. A first
 * recording (no golden yet) takes the lab list from `CCNA3_LABS` of the engine it runs on, which must be cad4ac9's 21.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { assert, beforeAll, describe, expect, it } from 'vitest';
import type { ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { TOPOLOGY_SCHEMA_ID_1_3, type Topology } from '../src/contracts/topology.js';
import { parseSavedLabState } from '../src/io/lab-schema.js';
import { CCNA3_LABS, SCENARIOS, SCENARIO_SEED } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';

/** The CCNA 3 labs of cad4ac9. */
const CAD4AC9_LAB_COUNT = 21;

/** Contents of test/goldens/p3-lab-exports.json. */
interface ExportsGolden {
  readonly about: string;
  readonly labs: Readonly<Record<string, Topology>>;
}

const GOLDEN_URL = new URL('./goldens/p3-lab-exports.json', import.meta.url);

const ABOUT =
  'P3 lab exports (ARCHITECTURE-P3C D3, §9.5, §10.1 accept.p3c.p3-exports), recorded from the unchanged engine at commit ' +
  'cad4ac9 before any P3c code: the topology document (schema 1.3, profile P3) every CCNA 3 lab of cad4ac9 exports ' +
  'right after the worker loads it (lab seed, lab stamp, scheduled faults). The labs are the keys of this file, frozen ' +
  'by lab id. Change it only as P3C §9.5 allows, entry by entry, by re-recording with NF_RECORD_P3_EXPORTS.';

let goldenCache: ExportsGolden | undefined;

function golden(): ExportsGolden {
  if (goldenCache === undefined) {
    if (!existsSync(GOLDEN_URL)) throw new Error('test/goldens/p3-lab-exports.json is missing; it is recorded once, from the unchanged engine at cad4ac9 (P3C §7 W0).');
    goldenCache = JSON.parse(readFileSync(GOLDEN_URL, 'utf8')) as ExportsGolden;
  }
  return goldenCache;
}

/** The frozen labs: the golden's keys, or (first recording only) the live CCNA 3 labs, which must be cad4ac9's 21. */
function labs(): readonly ScenarioInfo[] {
  const names = existsSync(GOLDEN_URL) ? Object.keys(golden().labs) : CCNA3_LABS.map((l) => l.name);
  return names.map((name) => {
    const lab = SCENARIOS.find((s) => s.name === name);
    if (lab === undefined) throw new Error(`p3-lab-exports.json names ${name}, which this build does not have`);
    return lab;
  });
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

const RECORD = (process.env['NF_RECORD_P3_EXPORTS'] ?? '').trim();

/** Re-record the labs `RECORD` names (`all` = every lab of the golden), keeping every other entry. */
function record(): void {
  const all = labs();
  if (!existsSync(GOLDEN_URL) && all.length !== CAD4AC9_LAB_COUNT) throw new Error(`a first recording runs on cad4ac9 (21 CCNA 3 labs); this build has ${all.length}`);
  const names = RECORD === 'all' ? all.map((l) => l.name) : RECORD.split(',').map((s) => s.trim()).filter((s) => s !== '');
  for (const name of names) if (!all.some((l) => l.name === name)) throw new Error(`NF_RECORD_P3_EXPORTS names ${name}, which is not a lab of p3-lab-exports.json`);
  const previous = existsSync(GOLDEN_URL) ? golden() : undefined;
  const out: Record<string, Topology> = {};
  for (const lab of all) {
    const old = previous?.labs[lab.name];
    if (!names.includes(lab.name)) {
      if (old === undefined) throw new Error(`${lab.name} has no golden entry yet; re-record it too`);
      out[lab.name] = old;
      continue;
    }
    const now = exported(lab);
    if (old !== undefined) console.log(`${lab.name}: ${JSON.stringify(old) === JSON.stringify(now) ? 'unchanged' : 're-recorded (the export changed)'}`);
    out[lab.name] = now;
  }
  const file: ExportsGolden = { about: ABOUT, labs: out };
  writeFileSync(GOLDEN_URL, `${JSON.stringify(file, null, 2)}\n`);
  goldenCache = file;
}

describe('accept P3c: every CCNA 3 lab of cad4ac9 exports the P3 bytes', () => {
  beforeAll(() => {
    if (RECORD !== '') record();
  }, 600_000);

  it('covers the 21 CCNA 3 labs of cad4ac9, frozen by lab id, in their course order then', () => {
    const all = labs();
    expect(all).toHaveLength(CAD4AC9_LAB_COUNT);
    for (const lab of all) expect(lab.category, lab.name).toBe('ccna3-lab');
    const live = CCNA3_LABS.map((l) => l.name);
    expect(all.map((l) => l.name)).toEqual(live.filter((n) => all.some((l) => l.name === n)));
    expect(golden().about).toBe(ABOUT);
  });

  for (const lab of labs()) {
    it(`${lab.name}: exported after load equals the golden byte for byte (schema 1.3, profile P3), and reloads to the same bytes`, () => {
      const expected = golden().labs[lab.name];
      if (expected === undefined) return assert.fail(`${lab.name} has no entry in test/goldens/p3-lab-exports.json`);
      const out = exported(lab);
      expect(out.schema, lab.name).toBe(TOPOLOGY_SCHEMA_ID_1_3);
      expect(out.profile, lab.name).toBe('P3');
      expect(out, lab.name).toEqual(expected);
      expect(JSON.stringify(out), `${lab.name}: byte for byte, key order included`).toBe(JSON.stringify(expected));
      // the export is a fixed point: loading it again as a saved P3 lab world is reopened (its saved lab state, the
      // scheduled faults that had not landed, re-scheduled as headless grading does, ruling R58 (b)) exports the same bytes
      const again = createSimulation({ seed: lab.seed ?? SCENARIO_SEED });
      again.loadTopology(out);
      for (const f of parseSavedLabState(out).pendingFaults) again.injectFault(f.at, f.fault);
      expect(again.profile, lab.name).toBe('P3');
      expect(JSON.stringify(again.exportTopology()), `${lab.name}: reloaded export`).toBe(JSON.stringify(out));
    });
  }
});
