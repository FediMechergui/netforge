/**
 * test/p3-flip.world.ts — the P3 worlds of the W4 qa acceptance rows (ARCHITECTURE-P3 §0 rules 13 and 14, §7 W4,
 * §10 "From W4 the tests build their worlds with `staged.world`, which equals the real catalog once the flip has
 * landed"). Not a test file.
 *
 * ONE helper builds a P3 world for the W4 qa files that need the real catalog (`accept.p3.silence`,
 * `accept.p3.switch-transport`, `accept.p3.profile`, `accept.p3.ospf-scale`, `accept.p3.mgmt-scale`): since the W4
 * catalog flip (`CATALOG_STAGE` 'P3', every approved P3 daemon registered in `protocols/index.ts`) that is
 * `createSimulation` itself. Ruling R47: the flip deleted the helper's pre-flip branch (`staged.world` at stage P3 with
 * the approved P3 daemons' factories laid over the registry) together with that factory overlay and the world-source
 * switch, so the real catalog is the only source; nothing else in the qa files changed.
 *
 * `P3_SILENCE_DAEMONS` names exactly the daemons §10.1 `accept.p3.silence` (a) attributes events to: the seven MUST
 * daemons (ospf, acl, cdp, lldp, ntp, restconf, traffic) and the approved items' daemons ([S19] ppp, [S18] gre, [S13]
 * vty and vty-client, [S24] logger, [S25] syslog-server, [C1] eigrp, [C13] ike), in that order — the fifteen daemons
 * the flip registered. [S32] `script-host` registers at the W6 flip and is not part of W4.
 *
 * Nothing here is module-level mutable state (rule 12).
 */
import type { DefaultsProfile } from '../src/contracts/catalog.js';
import type { ProcessName } from '../src/contracts/ids.js';
import type { ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation, SimulationOptions } from '../src/contracts/simulation.js';
import type { Topology } from '../src/contracts/topology.js';
import { SCENARIO_SEED } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';

/** The daemons the silence rows attribute events to (§10.1 `accept.p3.silence` (a)), in that order. Frozen. */
export const P3_SILENCE_DAEMONS: readonly ProcessName[] = Object.freeze([
  'ospf',
  'acl',
  'cdp',
  'lldp',
  'ntp',
  'restconf',
  'traffic',
  'ppp', // [S19]
  'gre', // [S18]
  'vty', // [S13]
  'vty-client', // [S13]
  'logger', // [S24]
  'syslog-server', // [S25]
  'eigrp', // [C1]
  'ike', // [C13]
]);

/** Options of `createP3Simulation`: `SimulationOptions` without `catalog`; `profile` defaults to 'P3'. */
export interface P3WorldOptions extends Omit<SimulationOptions, 'catalog' | 'profile'> {
  /** The initial world's defaults profile (default 'P3'); a loaded document sets its own. */
  readonly profile?: DefaultsProfile;
}

/** A world on the real (flipped) P3 catalog: `createSimulation`, the profile defaulting to 'P3'. */
export function createP3Simulation(opts: P3WorldOptions): Simulation {
  const { profile = 'P3', ...rest } = opts;
  return createSimulation({ ...rest, profile });
}

/**
 * A scenario loaded into a fresh P3-catalog world exactly as the worker's `loadScenario` loads it: the lab seed (else
 * `SCENARIO_SEED`), the lab stamp when the entry has tasks, the scheduled faults injected right after the load. The
 * document's own profile decides the world's (a template or CCNA 1 lab is P1, a CCNA 2 lab P2). `topo` overrides the
 * built document (default `sc.build()`).
 */
export function loadScenarioP3(sc: ScenarioInfo, topo: Topology = sc.build()): Simulation {
  const sim = createP3Simulation({ seed: sc.seed ?? SCENARIO_SEED });
  sim.loadTopology((sc.tasks?.length ?? 0) > 0 ? { ...topo, lab: { name: sc.name, version: sc.version ?? 1 } } : topo);
  for (const f of sc.faults ?? []) sim.injectFault(f.at, f.fault);
  return sim;
}

/** Startup-config text from sections of lines: each section followed by `!`, then `end` (the harnesses' form). */
export function startupText(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}
