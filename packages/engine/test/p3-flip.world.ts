/**
 * test/p3-flip.world.ts — the P3 worlds of the W4 qa acceptance rows (ARCHITECTURE-P3 §0 rules 13 and 14, §7 W4 step 1,
 * §10 "From W4 the tests build their worlds with `staged.world`, which equals the real catalog once the flip has
 * landed"). Not a test file.
 *
 * ONE helper chooses where a P3 world's catalog comes from, so the W4 qa files (`accept.p3.silence`,
 * `accept.p3.switch-transport`, `accept.p3.profile`, `accept.p3.ospf-scale`, `accept.p3.mgmt-scale`) are written once
 * and run both before and after the catalog flip:
 *   - before the flip (`CATALOG_STAGE` is still 'P2'): `staged.world` at stage P3 — the P3 test-only data of rule 13 —
 *     with every approved P3 daemon's real factory laid over the registry (`P3_DAEMON_FACTORIES`), since the real
 *     registry (`protocols/index.ts`) gains them only at the flip and `staged.world` filters an approved daemon without
 *     a factory off every model;
 *   - after the flip (`CATALOG_STAGE === 'P3'`): the real catalog and the real registry, `createSimulation` itself.
 * The W4 flip step deletes the staged branch of `p3WorldSource` / `createP3Simulation` (and with it the factory
 * overlay), leaving the real catalog the only source; nothing else in the qa files changes (rule 14: the lead then runs
 * every W4 qa file again, now against the real catalog).
 *
 * `P3_DAEMON_FACTORIES` holds exactly the daemons §10.1 `accept.p3.silence` (a) names: the seven MUST daemons (ospf,
 * acl, cdp, lldp, ntp, restconf, traffic) and the approved items' daemons ([S19] ppp, [S18] gre, [S13] vty and
 * vty-client, [S24] logger, [S25] syslog-server, [C1] eigrp, [C13] ike), in that order. [S32] `script-host` registers
 * at the W6 flip and is not part of W4 (on `staged.world` NF-DEVHOST simply runs without it).
 *
 * The source is read at call time (rule 12): nothing here is module-level mutable state.
 */
import type { DefaultsProfile } from '../src/contracts/catalog.js';
import type { ProcessName } from '../src/contracts/ids.js';
import type { ProcessFactory } from '../src/contracts/process.js';
import type { ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation, SimulationOptions } from '../src/contracts/simulation.js';
import type { Topology } from '../src/contracts/topology.js';
import { CATALOG_STAGE } from '../src/device/catalog/index.js';
import { createAcl } from '../src/protocols/acl.js';
import { createCdp } from '../src/protocols/cdp.js';
import { createEigrp } from '../src/protocols/eigrp.js';
import { createGre } from '../src/protocols/gre.js';
import { createIke } from '../src/protocols/ike.js';
import { createLldp } from '../src/protocols/lldp.js';
import { createLogger } from '../src/protocols/logger.js';
import { createNtp } from '../src/protocols/ntp.js';
import { createOspf } from '../src/protocols/ospf.js';
import { createPpp } from '../src/protocols/ppp.js';
import { createRestconf } from '../src/protocols/restconf.js';
import { createSyslogServer } from '../src/protocols/syslog-server.js';
import { createTraffic } from '../src/protocols/traffic.js';
import { createVtyClient } from '../src/protocols/vty-client.js';
import { createVty } from '../src/protocols/vty.js';
import { SCENARIO_SEED } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';
import { createStagedSimulation } from './staged.world.js';

/**
 * Every approved P3 daemon of W4 with its real factory, in the order of §10.1 `accept.p3.silence` (a): the MUST
 * daemons, then the approved items'. Frozen.
 */
export const P3_DAEMON_FACTORIES: Readonly<Record<ProcessName, ProcessFactory>> = Object.freeze({
  ospf: createOspf,
  acl: createAcl,
  cdp: createCdp,
  lldp: createLldp,
  ntp: createNtp,
  restconf: createRestconf,
  traffic: createTraffic,
  ppp: createPpp, // [S19]
  gre: createGre, // [S18]
  vty: createVty, // [S13]
  'vty-client': createVtyClient, // [S13]
  logger: createLogger, // [S24]
  'syslog-server': createSyslogServer, // [S25]
  eigrp: createEigrp, // [C1]
  ike: createIke, // [C13]
});

/** The names of `P3_DAEMON_FACTORIES`, in its order: the daemons the silence rows attribute events to. */
export const P3_SILENCE_DAEMONS: readonly ProcessName[] = Object.freeze(Object.keys(P3_DAEMON_FACTORIES));

/** Where a P3 world's catalog comes from. */
export type P3WorldSource = 'staged' | 'real';

/**
 * 'real' once the catalog flip has set `CATALOG_STAGE` to 'P3', else 'staged' (`staged.world` at stage P3 with
 * `P3_DAEMON_FACTORIES`). Read at call time. The W4 flip step removes the 'staged' branch.
 */
export function p3WorldSource(): P3WorldSource {
  return CATALOG_STAGE === 'P3' ? 'real' : 'staged';
}

/** Options of `createP3Simulation`: `SimulationOptions` without `catalog`; `profile` defaults to 'P3'. */
export interface P3WorldOptions extends Omit<SimulationOptions, 'catalog' | 'profile'> {
  /** The initial world's defaults profile (default 'P3'); a loaded document sets its own. */
  readonly profile?: DefaultsProfile;
}

/**
 * A world on the P3 catalog (`p3WorldSource`): the real `createSimulation` after the flip; before it,
 * `createStagedSimulation({stage: 'P3', factories: P3_DAEMON_FACTORIES})`. The profile defaults to 'P3'.
 */
export function createP3Simulation(opts: P3WorldOptions): Simulation {
  const { profile = 'P3', ...rest } = opts;
  if (p3WorldSource() === 'real') return createSimulation({ ...rest, profile });
  return createStagedSimulation({ ...rest, stage: 'P3', profile, factories: P3_DAEMON_FACTORIES });
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
