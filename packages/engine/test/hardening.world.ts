/**
 * test/hardening.world.ts — shared pieces of the W4 qa acceptance rows for device access and access-layer hardening
 * (ARCHITECTURE-P3 §10.1 `accept.p3.device-access`, `accept.p3.dhcp-snooping`, `accept.p3.dai`; §7 W4 step 1 "qa").
 *
 * The rows run on `staged.world` at stage P3 BEFORE the catalog flip (rule 14), so the worlds must look like the
 * flipped catalog: every approved P3 daemon is passed through `factories` (`p3Factories`), because the real registry
 * (`protocols/index.ts`) only gains them at the flip. After the flip the same factories are the registered ones, so
 * these worlds equal `createStagedSimulation({stage: 'P3'})` on the real catalog. [S32] `script-host` is the W6 flip's
 * and has no factory yet; it is never on a model these rows use.
 *
 * Also: `configText` (a saved-file startup configuration from sections), `configured` (lines through the device's own
 * grammar; a refused line fails the test), `gradingClone` (the grader clone exactly as `sim/lab-checks.ts`
 * `settledClone` builds it, for a test that must read the clone's tables: the export loaded with the live seed and
 * catalog, journal off, run to idle under `LAB_CLONE_BOOT_EVENTS`; the live world here has no cut cable and no
 * err-disabled port, so no fault is re-applied).
 *
 * Nothing here is module-level mutable state (rule 12).
 */
import type { ProcessFactory } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
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
import { LAB_CLONE_BOOT_EVENTS } from '../src/sim/lab-checks.js';
import { createSimulation } from '../src/sim/simulation.js';
import type { StagedFactoryOverlay } from './staged.world.js';

/**
 * Every approved P3 daemon with a factory (the W4 flip's registry additions: the seven MUST daemons and the approved
 * ppp, gre, vty, vty-client, logger, syslog-server, eigrp and ike), as a fresh overlay.
 */
export function p3Factories(): StagedFactoryOverlay {
  const out: Record<string, ProcessFactory> = {
    ppp: createPpp,
    cdp: createCdp,
    lldp: createLldp,
    acl: createAcl,
    gre: createGre,
    vty: createVty,
    'vty-client': createVtyClient,
    logger: createLogger,
    ntp: createNtp,
    'syslog-server': createSyslogServer,
    ospf: createOspf,
    eigrp: createEigrp,
    ike: createIke,
    restconf: createRestconf,
    traffic: createTraffic,
  };
  return out;
}

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
