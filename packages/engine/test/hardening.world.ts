/**
 * test/hardening.world.ts — shared pieces of the W4 qa acceptance rows for device access and access-layer hardening
 * (ARCHITECTURE-P3 §10.1 `accept.p3.device-access`, `accept.p3.dhcp-snooping`, `accept.p3.dai`; §7 W4 step 1 "qa").
 *
 * The rows run on `staged.world` at stage P3 (rule 13). Since the W4 catalog flip the real registry
 * (`protocols/index.ts`) holds every approved P3 daemon, so `createStagedSimulation({stage: 'P3'})` is the flipped
 * catalog's world (ruling R47 removed the pre-flip factory overlay, `p3Factories`). [S32] `script-host` is the W6
 * flip's and has no factory yet; it is never on a model these rows use.
 *
 * Also: `configText` (a saved-file startup configuration from sections), `configured` (lines through the device's own
 * grammar; a refused line fails the test), `gradingClone` (the grader clone exactly as `sim/lab-checks.ts`
 * `settledClone` builds it, for a test that must read the clone's tables: the export loaded with the live seed and
 * catalog, journal off, run to idle under `LAB_CLONE_BOOT_EVENTS`; the live world here has no cut cable and no
 * err-disabled port, so no fault is re-applied).
 *
 * Nothing here is module-level mutable state (rule 12).
 */
import type { Simulation } from '../src/contracts/simulation.js';
import { LAB_CLONE_BOOT_EVENTS } from '../src/sim/lab-checks.js';
import { createSimulation } from '../src/sim/simulation.js';

/** A startup configuration from sections of lines (the saved-file shape: `!` after each section, then `end`). */
export function configText(sections: readonly (readonly string[])[]): string {
  return [...sections.flatMap((s) => [...s, '!']), 'end', ''].join('\n');
}

/** Apply `lines` through the device's own grammar (`Simulation.configure`); a refused line is a test bug. */
export function configured(sim: Simulation, dev: string, lines: readonly string[]): void {
  const r = sim.configure(dev, lines);
  if (!r.ok) throw new Error(`${dev} setup failed: ${JSON.stringify(r.lines.filter((l) => !l.ok))}`);
}

/** The grader clone of `sim` (file header): its export loaded with the live seed and catalog, settled. */
export function gradingClone(sim: Simulation): Simulation {
  const clone = createSimulation({ seed: sim.seed, catalog: sim.catalog, journal: false });
  clone.loadTopology(sim.exportTopology());
  clone.runToIdle(LAB_CLONE_BOOT_EVENTS);
  return clone;
}
