/**
 * test/p2.world.ts — real P2 worlds with a daemon registry overlay (ARCHITECTURE-P2 §0 rule 13; §7 W1 qa, reduced to a
 * thin wrapper by the W8 exit gate).
 *
 * `createP2Simulation({seed, profile, factories})` is `createSimulation` in the P2 profile (unless told otherwise) with
 * the catalog of `createP2Catalog(factories)`:
 *   1. the registry is `PROCESS_FACTORIES` with `factories` laid over it (`p2Registry`): a passed factory wins, and a
 *      name passed as `undefined` is removed, so a test models a daemon that is missing, or runs a daemon under test
 *      as a stub, while every other daemon keeps its real factory;
 *   2. every real model input (`ALL_MODEL_INPUTS`, palette order) goes through `defineP2Model`: `defineModel(…, 'P2')`
 *      (the real `CATALOG_STAGE`), then its daemon list FILTERED to the registry — an approved P2 daemon
 *      (`P2_DAEMONS`) without a factory is left out, so no "Process … is not available" log appears — and `tables` and
 *      `portOwners` re-derived from the filtered list (define.ts rules). P0/P1 daemons are never filtered: removing one
 *      is the caller's choice and the device logs it at boot.
 *
 * With the default registry nothing is filtered and the helper's catalog equals the real one, model for model
 * (device.catalog.p2.test.ts checks it). The catalog is never validated: a filtered model is not the model its
 * capabilities derive, which `validateCatalog` would refuse by design.
 *
 * Until the W4 and W6 catalog flips this file held the flips' model deltas, the §2.1 `CAPABILITY_PROCESSES` rows and
 * the final `PROCESS_ORDER` as test-only data; since the flips they are the real data, and nothing here duplicates
 * them. The model delta of a type (`p2ModelDeltaFor`: `managed-switch`, `lightweight-ap`, `stpDefaultMode`) is READ
 * from the real input of that type. `defineP2Model` still applies it, so an input written before the flips (the P0
 * literals of device.catalog.p0-inputs.ts) builds the P2 model of its type; on a real input it changes nothing. The
 * names older tests import for the rest (`P2_PROCESS_ORDER`, `P2_CAPABILITY_PROCESS_ROWS`, `p2ModelInputs`,
 * `CAPWAP_TUNNEL_FAMILY`, `NF_WLC_9800_TEST_INPUT`) are `@deprecated` aliases of the real data, at the end of the file.
 *
 * Nothing here is module-level mutable state: every call builds fresh, frozen models (rule 12). Inputs are never
 * mutated.
 */
import { CAPABILITY_PROCESSES, PROCESS_ORDER, type Capability, type DefaultsProfile, type VirtualFamilySpec } from '../src/contracts/catalog.js';
import type { DeviceCatalog, DeviceModel, PortNameSource, PortResolution } from '../src/contracts/device.js';
import type { ProcessName } from '../src/contracts/ids.js';
import type { ProcessFactory } from '../src/contracts/process.js';
import type { Simulation, SimulationOptions } from '../src/contracts/simulation.js';
import { ALL_MODEL_INPUTS, ALL_MODULES } from '../src/device/catalog.js';
import {
  CAPWAP_TUNNEL_FAMILY as REAL_CAPWAP_TUNNEL_FAMILY,
  deepFreeze,
  defineModel,
  deriveTables,
  derivePortOwners,
  moduleReachableProcesses,
  type ModelInput,
} from '../src/device/catalog/define.js';
import { NF_WLC_9800_INPUT } from '../src/device/catalog/wireless.js';
import { resolvePortName } from '../src/device/catalog/names.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import { createSimulation } from '../src/sim/simulation.js';

/** The approved P2 daemons (§2.1 final order; vtp and radius-server are not approved). Only these are ever filtered. */
export const P2_DAEMONS: readonly ProcessName[] = Object.freeze([
  'capwap-wtp',
  'vlan',
  'dtp',
  'etherchannel',
  'stp',
  'nat',
  'hsrp',
  'dhcpv6-client',
  'dhcpv6-server',
  'capwap-ac',
]);

/** A registry overlay: a factory wins over `PROCESS_FACTORIES`; `undefined` removes that name. */
export type P2FactoryOverlay = Readonly<Record<ProcessName, ProcessFactory | undefined>>;
/** A daemon registry (name → factory), as `createCatalog` takes it. */
export type P2Registry = Readonly<Record<ProcessName, ProcessFactory>>;

/** `PROCESS_FACTORIES` with `overlay` laid over it (a factory wins, `undefined` removes the name). Frozen. */
export function p2Registry(overlay: P2FactoryOverlay = {}): P2Registry {
  const out: Record<ProcessName, ProcessFactory> = { ...PROCESS_FACTORIES };
  for (const [name, factory] of Object.entries(overlay)) {
    if (factory === undefined) delete out[name];
    else out[name] = factory;
  }
  return Object.freeze(out);
}

// ── model deltas, read from the real inputs ────────────────────────────────────────────────────────────────────

/** One model-data delta of a catalog flip: capabilities to add and an optional spanning-tree default mode. */
export interface P2ModelDelta {
  readonly addCapabilities?: readonly Capability[];
  readonly stpDefaultMode?: 'pvst' | 'rapid-pvst';
}

/** The real inputs that carry `cap`, as deltas adding it (plus the input's `stpDefaultMode` when `withMode`), palette order. */
function realDeltas(cap: Capability, withMode: boolean): Readonly<Record<string, P2ModelDelta>> {
  const out: Record<string, P2ModelDelta> = {};
  for (const input of ALL_MODEL_INPUTS) {
    if (!input.capabilities.includes(cap)) continue;
    const addCapabilities = Object.freeze([cap]);
    const mode = withMode ? input.stpDefaultMode : undefined;
    out[input.type] = Object.freeze(mode === undefined ? { addCapabilities } : { addCapabilities, stpDefaultMode: mode });
  }
  return Object.freeze(out);
}

/** The W4 deltas, read from the real inputs: every managed switch (`managed-switch`; NF-C9300 also `rapid-pvst`). */
export const P2_MODEL_DELTAS: Readonly<Record<string, P2ModelDelta>> = realDeltas('managed-switch', true);

/** The W6 delta, read from the real inputs: NF-AP-1832 (`lightweight-ap`). Apart, so the W4 list stays the switches. */
export const P2_WIRELESS_MODEL_DELTAS: Readonly<Record<string, P2ModelDelta>> = realDeltas('lightweight-ap', false);

/** The delta of `type` across both flips (W4 then W6), merged; undefined when neither flip touches the model. */
export function p2ModelDeltaFor(type: string): P2ModelDelta | undefined {
  const w4 = P2_MODEL_DELTAS[type];
  const w6 = P2_WIRELESS_MODEL_DELTAS[type];
  if (w4 === undefined) return w6;
  if (w6 === undefined) return w4;
  const out: P2ModelDelta = { addCapabilities: [...(w4.addCapabilities ?? []), ...(w6.addCapabilities ?? [])] };
  const mode = w4.stpDefaultMode ?? w6.stpDefaultMode;
  return mode === undefined ? out : { ...out, stpDefaultMode: mode };
}

/**
 * `input` with `delta` (default: its type's, `p2ModelDeltaFor`) applied, as a new object; `input` itself when there
 * is no delta. Idempotent: a listed capability is not repeated, a set mode is kept.
 */
export function applyP2ModelDelta(input: ModelInput, delta: P2ModelDelta | undefined = p2ModelDeltaFor(input.type)): ModelInput {
  if (delta === undefined) return input;
  const capabilities = [...input.capabilities];
  for (const c of delta.addCapabilities ?? []) if (!capabilities.includes(c)) capabilities.push(c);
  const out: ModelInput = { ...input, capabilities };
  return delta.stpDefaultMode !== undefined && input.stpDefaultMode === undefined ? { ...out, stpDefaultMode: delta.stpDefaultMode } : out;
}

// ── models, catalog, world ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One model at stage P2 with its daemons filtered to `registry`: `defineModel(applyP2ModelDelta(input), 'P2')`, then
 * every P2 daemon (`P2_DAEMONS`) without a factory removed (the rest keep `PROCESS_ORDER`), and `tables` and
 * `portOwners` re-derived from the filtered list.
 */
export function defineP2Model(input: ModelInput, registry: P2Registry = PROCESS_FACTORIES): DeviceModel {
  const base = defineModel(applyP2ModelDelta(input), 'P2', ALL_MODULES);
  const processes = base.processes.filter((p) => !P2_DAEMONS.includes(p) || Object.prototype.hasOwnProperty.call(registry, p));
  const moduleProcesses = moduleReachableProcesses(base.capabilities, base.slots, processes, 'P2', ALL_MODULES);
  return deepFreeze<DeviceModel>({
    ...base,
    processes,
    tables: deriveTables(processes),
    portOwners: derivePortOwners(base.ports, base.virtualFamilies, processes, moduleProcesses),
  });
}

/**
 * The P2 `DeviceCatalog` for a registry overlay (the shape and lookups of `createCatalog`, without its validation —
 * see the file header): every real model through `defineP2Model`, the real module list, the real port-name resolver,
 * and the overlaid registry as its daemon factories.
 */
export function createP2Catalog(factories: P2FactoryOverlay = {}): DeviceCatalog {
  const registry = p2Registry(factories);
  const models = Object.freeze(ALL_MODEL_INPUTS.map((input) => defineP2Model(input, registry)));
  const byType = new Map<string, DeviceModel>();
  for (const m of models) byType.set(m.type, m);
  const moduleByType = new Map(ALL_MODULES.map((m) => [m.type, m] as const));
  const processes = new Map<ProcessName, ProcessFactory>(Object.entries(registry));
  return {
    get: (type: string) => byType.get(type),
    list: () => models,
    process: (name: ProcessName) => processes.get(name),
    module: (type) => moduleByType.get(type),
    modules: () => ALL_MODULES,
    resolvePort: (source: PortNameSource, name: string): PortResolution => resolvePortName(source, name),
  };
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
  const { factories, profile, ...rest } = opts;
  return createSimulation({ ...rest, profile: profile ?? 'P2', catalog: createP2Catalog(factories) });
}

// ── deprecated aliases of the real data (the pre-flip test data) ───────────────────────────────────────────────

/** @deprecated The final §2.1 daemon order is the contract: use `PROCESS_ORDER` (contracts/catalog.ts). */
export const P2_PROCESS_ORDER: readonly ProcessName[] = PROCESS_ORDER;

/**
 * @deprecated The P2 rows are in the contract: use the `since: 'P2'` rows of `CAPABILITY_PROCESSES`
 * (contracts/catalog.ts), which this map lists by capability.
 */
export const P2_CAPABILITY_PROCESS_ROWS: Readonly<Partial<Record<Capability, readonly ProcessName[]>>> = Object.freeze(
  Object.fromEntries(
    Object.entries(CAPABILITY_PROCESSES).flatMap(([cap, rows]): [string, readonly ProcessName[]][] => {
      const p2 = rows.filter((r) => r.since === 'P2').map((r) => r.process);
      return p2.length === 0 ? [] : [[cap, Object.freeze(p2)]];
    }),
  ),
);

/** @deprecated Use `ALL_MODEL_INPUTS` (device/catalog.ts). A fresh frozen copy of it. */
export function p2ModelInputs(): readonly ModelInput[] {
  return Object.freeze([...ALL_MODEL_INPUTS]);
}

/** @deprecated Use `CAPWAP_TUNNEL_FAMILY` of device/catalog/define.ts (this is it). */
export const CAPWAP_TUNNEL_FAMILY: VirtualFamilySpec = REAL_CAPWAP_TUNNEL_FAMILY;

/** @deprecated Use `NF_WLC_9800_INPUT` of device/catalog/wireless.ts (this is it). */
export const NF_WLC_9800_TEST_INPUT: ModelInput = NF_WLC_9800_INPUT;
