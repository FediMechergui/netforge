/**
 * test/staged.world.ts — real worlds of any build stage, with a daemon registry overlay (ARCHITECTURE-P3 §0 rule 13;
 * §7 W0 qa; reduced to a thin wrapper of the real catalog by the W8 exit gate). It generalises `test/p2.world.ts`
 * (ARCHITECTURE-P2 §0 rule 13), whose names are thin wrappers of this file keyed to stage P2; `test/p3-flip.world.ts`
 * is its wrapper keyed to stage P3.
 *
 * `createStagedSimulation({seed, stage, profile, factories})` is `createSimulation` in the world profile
 * `profile ?? stagedDefaultProfile(stage)` (the stage's own profile: 'P3' at stage P3, 'P2' at stage P2, else 'P1'), on
 * the catalog of `createStagedCatalog({stage, factories})`:
 *   - the REAL catalog, `createCatalog(PROCESS_FACTORIES)` — and the world is then `createSimulation` itself, with no
 *     catalog option — wherever that catalog equals this helper's: at stage `CATALOG_STAGE` ('P3' since the W4 flip)
 *     when the overlaid registry is the real one (no overlay, or only the real factories under their own names).
 *     `staged.world.p3-parity.test.ts` proves the equality model for model, `profileConfig.P3` included;
 *   - otherwise a catalog of its own (the shape and lookups of `createCatalog`, without its validation, since a
 *     filtered model is not the model its capabilities derive, which `validateCatalog` would refuse by design):
 *       1. the registry is `PROCESS_FACTORIES` with `factories` laid over it (`stagedRegistry`): a passed factory wins,
 *          and a name passed as `undefined` is removed, so a test models a daemon that is missing, or runs a daemon
 *          under test as a stub, while every other daemon keeps its real factory;
 *       2. every real model input (`ALL_MODEL_INPUTS`, palette order) goes through `defineStagedModel(input, stage,
 *          registry)`: `defineModel(…, stage)` of the input with its P2 model delta applied (read from the real inputs,
 *          so a real input is unchanged), then its daemons FILTERED to the registry — an approved P2 or P3 daemon
 *          (`STAGED_DAEMONS`) without a factory is left out, so no "Process … is not available" log appears — and
 *          `tables` and `portOwners` derived again from the filtered list by the real rules (`deriveTables`,
 *          `moduleReachableProcesses`, `derivePortOwners`). P0/P1 daemons are never filtered: removing one is the
 *          caller's choice and the device logs it at boot.
 *     At stage P2 with the default registry nothing is filtered and the catalog equals the real model inputs defined
 *     at stage P2, model for model (`device.catalog.p2.test.ts`); there `createStagedSimulation` is
 *     `createP2Simulation` (`staged.world.test.ts`).
 *
 * The P3 test-only data of waves 0–7 (rule 13) are the real contract since the W4 catalog flip and the W6 flip for
 * [S32] (`staged.world.p3-parity.test.ts`), so the W8 gate reduced them to the contract they equal; the names stay for
 * the tests that pin them (`staged.world.test.ts` checks them against its own transcription of §2.1 and §2.6):
 *   - `STAGED_PROCESS_ORDER` is `PROCESS_ORDER` (the §2.1 final order restricted to the approved names, §8.5);
 *   - `P3_CAPABILITY_PROCESS_ROWS` are the `since: 'P3'` rows of `CAPABILITY_PROCESSES`, by capability;
 *   - `P3_PROCESS_TABLES` are the `PROCESS_TABLES` rows of the approved P3 daemons (§2.6);
 *   - `P3_STAGED_PROCESS_TABLES` is `STAGED_PROCESS_TABLES` (the §2.6 stage-filtered snooping tables);
 *   - `deriveStagedProcesses` and `deriveStagedTables` are `deriveProcesses` and `deriveTables`;
 *   - `stagedModelInputs(stage)` is `ALL_MODEL_INPUTS` at every stage, and `NF_DEVHOST_TYPE` / `nfDevhostTestInput()`
 *     are the real NF-DEVHOST's (`computers.ts`, the W6 flip).
 * What remains this helper's own: the approved-daemon lists `P2_DAEMONS` / `P3_DAEMONS` (§8.5; the registry filter's
 * domain), the registry overlay, the P2 model deltas (an input written before the P2 flips — the P0 literals of
 * `device.catalog.p0-inputs.ts` — builds its type's P2 model) and the test injector's host below.
 *
 * The test injector (W1 qa, ARCHITECTURE-P3 §7 W1 qa, D13): when the registry overlay registers a factory named
 * `injector` (`INJECTOR_PROCESS`; `test/inject.ts` provides it, `withInjector(...)`), the catalog also holds the test-only
 * host NF-INJECTOR (`INJECTOR_HOST_TYPE`, after every other model): no capability, so no other daemon, four gigabit
 * ports, and exactly one daemon, the injector, which sends pre-built frames out of a port at a fixed spacing
 * (`injectFrames`). Without that factory nothing changes (no overlay the P2/P3 pins use registers it).
 *
 * Since the flips a device that installs a module recomputes its daemon list with the real `deriveProcesses` at
 * `CATALOG_STAGE` (`device.ts` computeProcessOrder), so in a world of this helper at stage P2 (or P1), a module that
 * adds a capability at run time also brings that capability's P3 daemons (the W4b fix step).
 *
 * Nothing here is module-level mutable state: every call builds fresh, frozen models (rule 12), or returns the real
 * frozen ones. Inputs are never mutated.
 */
import {
  CAPABILITIES,
  CAPABILITY_PROCESSES,
  PROCESS_ORDER,
  stageIncluded,
  type BuildStage,
  type Capability,
  type CapabilityProcess,
  type DefaultsProfile,
} from '../src/contracts/catalog.js';
import type { DeviceCatalog, DeviceModel, PortNameSource, PortResolution } from '../src/contracts/device.js';
import type { ProcessName } from '../src/contracts/ids.js';
import { SPEED_1G } from '../src/contracts/port.js';
import type { ProcessFactory } from '../src/contracts/process.js';
import type { Simulation, SimulationOptions } from '../src/contracts/simulation.js';
import { PROCESS_TABLES, STAGED_PROCESS_TABLES, type ExtraTableName, type TableName } from '../src/contracts/tables.js';
import { ALL_MODEL_INPUTS, ALL_MODULES, CATALOG_STAGE, createCatalog } from '../src/device/catalog.js';
import { NF_DEVHOST_MODEL_INPUT, hostEth } from '../src/device/catalog/computers.js';
import {
  deepFreeze,
  defineModel,
  derivePortOwners,
  deriveProcesses,
  deriveTables,
  moduleReachableProcesses,
  type ModelInput,
} from '../src/device/catalog/define.js';
import { resolvePortName } from '../src/device/catalog/names.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import { createSimulation } from '../src/sim/simulation.js';

// ── the approved daemons ───────────────────────────────────────────────────────────────────────────────────────

/** The approved P2 daemons (ARCHITECTURE-P2 §2.1 final order; vtp and radius-server are not approved). */
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

/**
 * The approved P3 daemons (ARCHITECTURE-P3 §2.1, §8.5), in their final order: the seven MUST daemons (ospf, acl, cdp,
 * lldp, ntp, restconf, traffic), the approved items' daemons ([S19] ppp, [S18] gre, [S13] vty and vty-client, [S24]
 * logger, [S25] syslog-server, [C1] eigrp, [C13] ike) and [S32] script-host. Not approved, so never here: ospfv3 [S6],
 * tftp [S29], snmp-agent and snmp-manager [S33].
 */
export const P3_DAEMONS: readonly ProcessName[] = Object.freeze([
  'ppp',
  'cdp',
  'lldp',
  'acl',
  'gre',
  'vty',
  'vty-client',
  'logger',
  'ntp',
  'syslog-server',
  'ospf',
  'eigrp',
  'ike',
  'restconf',
  'traffic',
  'script-host',
]);

/** The daemons the registry filter applies to: every approved P2 and P3 daemon. */
export const STAGED_DAEMONS: readonly ProcessName[] = Object.freeze([...P2_DAEMONS, ...P3_DAEMONS]);

// ── the former P3 test-only data, now the contract (ARCHITECTURE-P3 §0 rule 13, §2.1, §2.6; reduced at W8) ─────────

/** The final daemon order: `PROCESS_ORDER` itself (the §2.1 final order restricted to the approved names). */
export const STAGED_PROCESS_ORDER: readonly ProcessName[] = PROCESS_ORDER;

/**
 * The P3 rows of `CAPABILITY_PROCESSES` (`since: 'P3'`), by capability, each list frozen; a capability with no P3 row
 * has no key (the lightweight AP gains nothing, D2, D18). Built once from the contract when this module loads.
 */
export const P3_CAPABILITY_PROCESS_ROWS: Readonly<Partial<Record<Capability, readonly CapabilityProcess[]>>> = (() => {
  const out: Partial<Record<Capability, readonly CapabilityProcess[]>> = {};
  for (const cap of CAPABILITIES) {
    const rows = CAPABILITY_PROCESSES[cap].filter((r) => r.since === 'P3');
    if (rows.length > 0) out[cap] = Object.freeze(rows);
  }
  return Object.freeze(out);
})();

/** The `PROCESS_TABLES` rows of the approved P3 daemons (§2.6; `vty-client` and `logger` own no table). */
export const P3_PROCESS_TABLES: Readonly<Partial<Record<ProcessName, readonly ExtraTableName[]>>> = (() => {
  const out: Partial<Record<ProcessName, readonly ExtraTableName[]>> = {};
  for (const p of P3_DAEMONS) {
    const tables = PROCESS_TABLES[p];
    if (tables !== undefined) out[p] = tables;
  }
  return Object.freeze(out);
})();

/** One stage-filtered table row: the shape of `STAGED_PROCESS_TABLES` (ARCHITECTURE-P3 §2.6). */
export interface StagedProcessTables {
  readonly process: ProcessName;
  readonly tables: readonly ExtraTableName[];
  readonly since: BuildStage;
  readonly requires: Capability;
}

/** §2.6: tables a daemon brings only from a stage on, and only to models with a capability: `STAGED_PROCESS_TABLES`. */
export const P3_STAGED_PROCESS_TABLES: readonly StagedProcessTables[] = STAGED_PROCESS_TABLES;

/** The type of NF-DEVHOST ([S32]): the real model's, re-exported from `computers.ts`. */
export { NF_DEVHOST_TYPE } from '../src/device/catalog/computers.js';

/** NF-DEVHOST's input ([S32]): a fresh copy of the real `NF_DEVHOST_MODEL_INPUT` (`computers.ts`) each call (rule 12). */
export function nfDevhostTestInput(): ModelInput {
  return structuredClone(NF_DEVHOST_MODEL_INPUT);
}

// ── registry overlay ───────────────────────────────────────────────────────────────────────────────────────────

/** A registry overlay: a factory wins over `PROCESS_FACTORIES`; `undefined` removes that name. */
export type StagedFactoryOverlay = Readonly<Record<ProcessName, ProcessFactory | undefined>>;
/** A daemon registry (name → factory), as `createCatalog` takes it. */
export type StagedRegistry = Readonly<Record<ProcessName, ProcessFactory>>;

/** `PROCESS_FACTORIES` with `overlay` laid over it (a factory wins, `undefined` removes the name). Frozen. */
export function stagedRegistry(overlay: StagedFactoryOverlay = {}): StagedRegistry {
  const out: Record<ProcessName, ProcessFactory> = { ...PROCESS_FACTORIES };
  for (const [name, factory] of Object.entries(overlay)) {
    if (factory === undefined) delete out[name];
    else out[name] = factory;
  }
  return Object.freeze(out);
}

/** True when `overlay` leaves the real registry as it is: no entry, or only real factories under their own names. */
function overlayIsReal(overlay: StagedFactoryOverlay | undefined): boolean {
  return Object.entries(overlay ?? {}).every(
    ([name, factory]) => factory !== undefined && Object.prototype.hasOwnProperty.call(PROCESS_FACTORIES, name) && PROCESS_FACTORIES[name] === factory,
  );
}

/** True when the real catalog equals this helper's catalog for `stage` and `factories` (the file header). */
function isRealCatalog(stage: BuildStage, factories: StagedFactoryOverlay | undefined): boolean {
  return stage === CATALOG_STAGE && overlayIsReal(factories);
}

// ── P2 model deltas, read from the real inputs ─────────────────────────────────────────────────────────────────

/** One model-data delta of a P2 catalog flip: capabilities to add and an optional spanning-tree default mode. */
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

/** The P2 W4 deltas, read from the real inputs: every managed switch (`managed-switch`; NF-C9300 also `rapid-pvst`). */
export const P2_MODEL_DELTAS: Readonly<Record<string, P2ModelDelta>> = realDeltas('managed-switch', true);

/** The P2 W6 delta, read from the real inputs: NF-AP-1832 (`lightweight-ap`). Apart, so the W4 list stays the switches. */
export const P2_WIRELESS_MODEL_DELTAS: Readonly<Record<string, P2ModelDelta>> = realDeltas('lightweight-ap', false);

/** The delta of `type` across both P2 flips (W4 then W6), merged; undefined when neither flip touches the model. */
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

// ── derivations: the real ones ─────────────────────────────────────────────────────────────────────────────────

/** Daemons of an EXPANDED capability list for a build stage, in `PROCESS_ORDER`: `deriveProcesses`. */
export function deriveStagedProcesses(caps: readonly Capability[], stage: BuildStage): readonly ProcessName[] {
  return deriveProcesses(caps, stage);
}

/** Tables a model owns at `stage` (cam, arp, rib, then its daemons' tables and stage-filtered rows): `deriveTables`. */
export function deriveStagedTables(processes: readonly ProcessName[], capabilities: readonly Capability[], stage: BuildStage): readonly TableName[] {
  return deriveTables(processes, capabilities, stage);
}

// ── models, catalog, world ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One model at `stage` with its daemons filtered to `registry`: `defineModel(applyP2ModelDelta(input), stage)`, then
 * every approved P2/P3 daemon (`STAGED_DAEMONS`) that has no factory removed from its daemons (the rest keep
 * `PROCESS_ORDER`), and `tables` and `portOwners` derived again from the filtered list. At stage P2 this is the P2
 * helper's `defineP2Model` exactly (`staged.world.test.ts` proves it against a copy of that code).
 */
export function defineStagedModel(input: ModelInput, stage: BuildStage, registry: StagedRegistry = PROCESS_FACTORIES): DeviceModel {
  const base = defineModel(applyP2ModelDelta(input), stage, ALL_MODULES);
  const processes = base.processes.filter((p) => !STAGED_DAEMONS.includes(p) || Object.prototype.hasOwnProperty.call(registry, p));
  const moduleProcesses = moduleReachableProcesses(base.capabilities, base.slots, processes, stage, ALL_MODULES);
  return deepFreeze<DeviceModel>({
    ...base,
    processes,
    tables: deriveTables(processes, base.capabilities, stage),
    portOwners: derivePortOwners(base.ports, base.virtualFamilies, processes, moduleProcesses),
  });
}

/** The model inputs of a stage, palette order: every real input (`ALL_MODEL_INPUTS`), at every stage. */
export function stagedModelInputs(_stage: BuildStage): readonly ModelInput[] {
  return Object.freeze([...ALL_MODEL_INPUTS]);
}

// ── the test injector's host (W1 qa: test/inject.ts, ARCHITECTURE-P3 §7 W1 qa, D13) ─────────────────────────────

/** The test-only injector daemon's name (its factory lives in `test/inject.ts`). */
export const INJECTOR_PROCESS: ProcessName = 'injector';
/** The type of the test-only injector host. */
export const INJECTOR_HOST_TYPE = 'pc.nfinjector';
/** The injector host's ports, in canonical order. */
export const INJECTOR_HOST_PORTS: readonly string[] = Object.freeze(['GigabitEthernet0', 'GigabitEthernet1', 'GigabitEthernet2', 'GigabitEthernet3']);

/**
 * The test-only injector host input: no capability (so it derives no daemon, runs no host stack and sends nothing of its
 * own), four gigabit ports (up by default, role `routed`), category Computers. Built at call time (rule 12).
 */
export function injectorHostTestInput(): ModelInput {
  return {
    type: INJECTOR_HOST_TYPE,
    model: 'NF-INJECTOR',
    description: 'Test-only frame injector: sends pre-built frames out of its ports at a fixed spacing',
    category: 'computers',
    icon: 'pc',
    capabilities: [],
    ports: INJECTOR_HOST_PORTS.map((name) => hostEth(name, SPEED_1G)),
    family: 'nf-injector',
    tags: ['test', 'injector'],
  };
}

/** The injector host model at `stage`: `defineModel` of its input, with exactly one daemon, the injector. */
export function defineInjectorHostModel(stage: BuildStage): DeviceModel {
  const base = defineModel(injectorHostTestInput(), stage, ALL_MODULES);
  const processes: readonly ProcessName[] = [INJECTOR_PROCESS];
  return deepFreeze<DeviceModel>({
    ...base,
    processes,
    tables: deriveTables(processes, base.capabilities, stage),
    portOwners: derivePortOwners(base.ports, base.virtualFamilies, processes, []),
  });
}

/** Options of `createStagedCatalog`. */
export interface StagedCatalogOptions {
  /** The build stage the models are derived for. */
  readonly stage: BuildStage;
  /** Laid over `PROCESS_FACTORIES` (see `stagedRegistry`); only approved P2/P3 daemons with a factory stay on models. */
  readonly factories?: StagedFactoryOverlay;
}

/**
 * The `DeviceCatalog` of a stage for a registry overlay: the real catalog (`createCatalog(PROCESS_FACTORIES)`) where it
 * equals this helper's (stage `CATALOG_STAGE`, the real registry); otherwise every input of `stagedModelInputs(stage)`
 * through `defineStagedModel`, the real module list, the real port-name resolver, and the overlaid registry as its
 * daemon factories (the shape and lookups of `createCatalog`, without its validation — see the file header).
 */
export function createStagedCatalog(opts: StagedCatalogOptions): DeviceCatalog {
  if (isRealCatalog(opts.stage, opts.factories)) return createCatalog(PROCESS_FACTORIES);
  const registry = stagedRegistry(opts.factories);
  const staged = stagedModelInputs(opts.stage).map((input) => defineStagedModel(input, opts.stage, registry));
  // W1 qa: the injector host exists only when the overlay registers the injector (test/inject.ts)
  if (Object.prototype.hasOwnProperty.call(registry, INJECTOR_PROCESS)) staged.push(defineInjectorHostModel(opts.stage));
  const models = Object.freeze(staged);
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

/** The world profile a stage defaults to: its own profile ('P3', 'P2'), or 'P1' before P2. */
export function stagedDefaultProfile(stage: BuildStage): DefaultsProfile {
  if (stageIncluded('P3', stage)) return 'P3';
  if (stageIncluded('P2', stage)) return 'P2';
  return 'P1';
}

/** Options of `createStagedSimulation`: `SimulationOptions` without `catalog`, plus the stage and the registry overlay. */
export interface StagedWorldOptions extends Omit<SimulationOptions, 'catalog' | 'profile'> {
  /** The build stage the catalog is derived for ('P3': the real catalog unless the overlay changes the registry). */
  readonly stage: BuildStage;
  /** The world's defaults profile (default `stagedDefaultProfile(stage)`). */
  readonly profile?: DefaultsProfile;
  /** Laid over `PROCESS_FACTORIES` (see `stagedRegistry`); only approved P2/P3 daemons with a factory stay on models. */
  readonly factories?: StagedFactoryOverlay;
}

/**
 * A simulation in `profile ?? stagedDefaultProfile(stage)`: `createSimulation` itself (the real catalog) where the
 * real catalog equals this helper's, else `createSimulation` with the catalog `createStagedCatalog({stage, factories})`.
 */
export function createStagedSimulation(opts: StagedWorldOptions): Simulation {
  const { stage, factories, profile, ...rest } = opts;
  const worldProfile = profile ?? stagedDefaultProfile(stage);
  if (isRealCatalog(stage, factories)) return createSimulation({ ...rest, profile: worldProfile });
  return createSimulation({ ...rest, profile: worldProfile, catalog: createStagedCatalog({ stage, factories }) });
}
