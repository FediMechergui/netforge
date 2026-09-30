/**
 * test/p2.world.ts — real P2 worlds with a daemon registry overlay (ARCHITECTURE-P2 §0 rule 13; §7 W1 qa, reduced to a
 * thin wrapper by the W8 exit gate; ARCHITECTURE-P3 §0 rule 13, §7 W0 qa: a wrapper of `test/staged.world.ts` keyed to
 * stage P2).
 *
 * `createP2Simulation({seed, profile, factories})` is `createStagedSimulation({…, stage: 'P2'})`: `createSimulation` in
 * the P2 profile (unless told otherwise) with the catalog of `createP2Catalog(factories)`, which is
 * `createStagedCatalog({stage: 'P2', factories})`:
 *   1. the registry is `PROCESS_FACTORIES` with `factories` laid over it (`p2Registry`): a passed factory wins, and a
 *      name passed as `undefined` is removed, so a test models a daemon that is missing, or runs a daemon under test
 *      as a stub, while every other daemon keeps its real factory;
 *   2. every real model input (`ALL_MODEL_INPUTS`, palette order) goes through `defineP2Model`: `defineModel(…, 'P2')`
 *      (the stage of the P2 catalog), then its daemon list FILTERED to the registry — an approved P2 daemon
 *      (`P2_DAEMONS`) without a factory is left out, so no "Process … is not available" log appears — and `tables` and
 *      `portOwners` re-derived from the filtered list (define.ts rules). P0/P1 daemons are never filtered: removing one
 *      is the caller's choice and the device logs it at boot.
 *
 * With the default registry nothing is filtered and the helper's catalog equals the real one, model for model
 * (device.catalog.p2.test.ts checks it). The catalog is never validated: a filtered model is not the model its
 * capabilities derive, which `validateCatalog` would refuse by design.
 *
 * Until the P2 W4 and W6 catalog flips this file held the flips' model deltas, the §2.1 `CAPABILITY_PROCESSES` rows and
 * the final `PROCESS_ORDER` as test-only data; since the flips they are the real data, and nothing here duplicates
 * them. The model delta of a type (`p2ModelDeltaFor`: `managed-switch`, `lightweight-ap`, `stpDefaultMode`) is READ
 * from the real input of that type. `defineP2Model` still applies it, so an input written before the flips (the P0
 * literals of device.catalog.p0-inputs.ts) builds the P2 model of its type; on a real input it changes nothing. The
 * `@deprecated` aliases of the real data that older tests imported were deleted in P3 W0 (§9.2 W0 item 4): their
 * importers use the real names (`PROCESS_ORDER`, the `since: 'P2'` rows of `CAPABILITY_PROCESSES`, `ALL_MODEL_INPUTS`,
 * `CAPWAP_TUNNEL_FAMILY` of define.ts, `NF_WLC_9800_INPUT` of wireless.ts).
 *
 * Nothing here is module-level mutable state: every call builds fresh, frozen models (rule 12). Inputs are never
 * mutated.
 */
import type { DefaultsProfile } from '../src/contracts/catalog.js';
import type { DeviceCatalog, DeviceModel } from '../src/contracts/device.js';
import type { Simulation, SimulationOptions } from '../src/contracts/simulation.js';
import type { ModelInput } from '../src/device/catalog/define.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import {
  createStagedCatalog,
  createStagedSimulation,
  defineStagedModel,
  stagedRegistry,
  type StagedFactoryOverlay,
  type StagedRegistry,
} from './staged.world.js';

export {
  P2_DAEMONS,
  P2_MODEL_DELTAS,
  P2_WIRELESS_MODEL_DELTAS,
  applyP2ModelDelta,
  p2ModelDeltaFor,
  type P2ModelDelta,
} from './staged.world.js';

/** A registry overlay: a factory wins over `PROCESS_FACTORIES`; `undefined` removes that name. */
export type P2FactoryOverlay = StagedFactoryOverlay;
/** A daemon registry (name → factory), as `createCatalog` takes it. */
export type P2Registry = StagedRegistry;

/** `PROCESS_FACTORIES` with `overlay` laid over it (a factory wins, `undefined` removes the name). Frozen. */
export function p2Registry(overlay: P2FactoryOverlay = {}): P2Registry {
  return stagedRegistry(overlay);
}

/**
 * One model at stage P2 with its daemons filtered to `registry`: `defineStagedModel(input, 'P2', registry)`, that is
 * `defineModel(applyP2ModelDelta(input), 'P2')`, then every P2 daemon (`P2_DAEMONS`) without a factory removed (the
 * rest keep `PROCESS_ORDER`), and `tables` and `portOwners` re-derived from the filtered list.
 */
export function defineP2Model(input: ModelInput, registry: P2Registry = PROCESS_FACTORIES): DeviceModel {
  return defineStagedModel(input, 'P2', registry);
}

/**
 * The P2 `DeviceCatalog` for a registry overlay: `createStagedCatalog({stage: 'P2', factories})` (the shape and lookups
 * of `createCatalog`, without its validation — see the file header).
 */
export function createP2Catalog(factories: P2FactoryOverlay = {}): DeviceCatalog {
  return createStagedCatalog({ stage: 'P2', factories });
}

/** Options of `createP2Simulation`: `SimulationOptions` without `catalog`, plus the registry overlay. */
export interface P2WorldOptions extends Omit<SimulationOptions, 'catalog' | 'profile'> {
  /** The world's defaults profile (default 'P2', the profile of every new world and CCNA 2 lab, D2). */
  readonly profile?: DefaultsProfile;
  /** Laid over `PROCESS_FACTORIES` (see `p2Registry`); only P2 daemons with a factory stay on the models. */
  readonly factories?: P2FactoryOverlay;
}

/** A simulation whose catalog is `createP2Catalog(opts.factories)` and whose world profile is `opts.profile ?? 'P2'`. */
export function createP2Simulation(opts: P2WorldOptions): Simulation {
  return createStagedSimulation({ ...opts, stage: 'P2' });
}
