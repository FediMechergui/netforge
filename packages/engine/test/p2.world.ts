/**
 * test/p2.world.ts — real P2-stage worlds before the catalog flips (ARCHITECTURE-P2 §0 rule 13, §7 W1 qa).
 *
 * `createP2Simulation({seed, profile, factories})` builds a catalog the way the W4 (and later W6) catalog flip will,
 * without touching the real one:
 *   1. every real model input (`ALL_MODEL_INPUTS`, palette order) with the model-data deltas of the flips applied
 *      idempotently (`P2_MODEL_DELTAS`: `managed-switch` on the managed switches, `stpDefaultMode` on NF-C9300);
 *   2. `defineModel(input, 'P2')`, so every P2 derivation of define.ts (profileConfig, subinterfaces, the managed
 *      families, the P2 panels) runs as it will after the flip;
 *   3. each model's `processes` completed with the §2.1 `CAPABILITY_PROCESSES` rows that later waves add
 *      (`P2_CAPABILITY_PROCESS_ROWS`, approved items only), FILTERED to the factories of the registry — a P2 daemon
 *      (`P2_DAEMONS`) without a factory is left out wherever it came from, so no "Process … is not available" log
 *      appears — and put in the final `PROCESS_ORDER` (`P2_PROCESS_ORDER`); `tables` and `portOwners` are re-derived
 *      from the completed list;
 *   4. `createSimulation({seed, profile, catalog, …})` with that catalog (`SimulationOptions.catalog`).
 *
 * The registry is `PROCESS_FACTORIES` with `factories` laid over it: a passed factory wins, and a name passed as
 * `undefined` is removed (so a test can model a daemon that is missing even after the flip registered it). A test
 * therefore adds only the daemons under test (`{ vlan: createVlan, stp: createStp }`) and every P0/P1 daemon keeps its
 * real factory. P1 daemons are never filtered: removing one is the caller's choice and the device logs it at boot.
 *
 * The helper never validates: the P2 daemon names are not in the contract `PROCESS_ORDER` until their factories are
 * registered (§0 rule 3), so `validateCatalog` would refuse every completed model by design. The catalog owner's own
 * tests validate `defineModel(…, 'P2')`. After the W4 and W6 flips every delta is already in the data and every row in
 * `CAPABILITY_PROCESSES`, so with the default registry the helper equals the real catalog (W8 reduces it to a thin
 * wrapper).
 *
 * Nothing here is module-level mutable state: every call builds fresh, frozen models (rule 12; several simulations
 * share one realm once replayers exist). Inputs are never mutated.
 */
import { expandCapabilities, type Capability, type DefaultsProfile } from '../src/contracts/catalog.js';
import type { DeviceCatalog, DeviceModel, PortNameSource, PortResolution } from '../src/contracts/device.js';
import type { ProcessName } from '../src/contracts/ids.js';
import type { ProcessFactory } from '../src/contracts/process.js';
import type { Simulation, SimulationOptions } from '../src/contracts/simulation.js';
import { ALL_MODEL_INPUTS, ALL_MODULES } from '../src/device/catalog.js';
import { defineModel, deriveTables, derivePortOwners, moduleReachableProcesses, type ModelInput } from '../src/device/catalog/define.js';
import { resolvePortName } from '../src/device/catalog/names.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import { createSimulation } from '../src/sim/simulation.js';

/**
 * The FINAL daemon order of ARCHITECTURE-P2 §2.1: the contract `PROCESS_ORDER` with every approved P2 daemon at its
 * position (vtp C1 and radius-server S11 are not approved in §8.5 and are left out). The relative order of the P1
 * names is unchanged, so every P1 `processes` list is an order-preserving subsequence.
 */
export const P2_PROCESS_ORDER: readonly ProcessName[] = Object.freeze([
  'wlan-ap',
  'wlan-client',
  'capwap-wtp',
  'cell-client',
  'hdlc',
  'eth-switch',
  'vlan',
  'dtp',
  'etherchannel',
  'stp',
  'arp',
  'ipv4',
  'nat',
  'icmpv4',
  'host',
  'ipv6',
  'nd',
  'icmpv6',
  'udp',
  'tcp',
  'hsrp',
  'dhcp-client',
  'dhcp-server',
  'dhcpv6-client',
  'dhcpv6-server',
  'dns-client',
  'dns-server',
  'http-client',
  'http-server',
  'traceroute',
  'capwap-ac',
]);

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

/**
 * The §2.1 `CAPABILITY_PROCESSES` rows the later catalog items add (all `since: 'P2'`), approved items only: W4
 * catalog (managed-switch, routing incl. hsrp [S2], host, nat-gateway) and W6 catalog (lightweight-ap,
 * wireless-controller). No model carries the two wireless capabilities before the W6 model deltas, so their rows are
 * inert until then.
 */
export const P2_CAPABILITY_PROCESS_ROWS: Readonly<Partial<Record<Capability, readonly ProcessName[]>>> = Object.freeze({
  'managed-switch': Object.freeze(['vlan', 'dtp', 'etherchannel', 'stp']),
  routing: Object.freeze(['nat', 'dhcpv6-client', 'dhcpv6-server', 'hsrp']),
  host: Object.freeze(['dhcpv6-client']),
  'nat-gateway': Object.freeze(['nat']),
  'lightweight-ap': Object.freeze(['capwap-wtp', 'udp', 'dhcp-client']),
  'wireless-controller': Object.freeze(['vlan', 'udp', 'capwap-ac']),
});

/** One model-data delta of a catalog flip: capabilities to add and an optional spanning-tree default mode. */
export interface P2ModelDelta {
  readonly addCapabilities?: readonly Capability[];
  readonly stpDefaultMode?: 'pvst' | 'rapid-pvst';
}

/**
 * The W4 model-data deltas (§7 W4 catalog, §9.2 item 13), by type id: `managed-switch` on the five managed L2
 * switches (NF-C2960-8TC, NF-C2960, NF-C2960-48TT, NF-C2960-24PG, NF-C9200-48P), listed explicitly on the multilayer
 * (NF-C3650-24, NF-C9300-48U) and data-centre (NF-N9K-48X, NF-N9K-32F) switches (D5: the `layer3-switch` implication
 * does not change); NF-C9300 defaults to `rapid-pvst`. The learning bridges, hubs and APs are not managed. The W6
 * wireless deltas (NF-AP-1832 lightweight, NF-WLC-9800) are added by the W4 qa item (§7 W4).
 */
export const P2_MODEL_DELTAS: Readonly<Record<string, P2ModelDelta>> = Object.freeze({
  'switch.nfc2960-8': Object.freeze({ addCapabilities: Object.freeze(['managed-switch'] as const) }),
  'switch.nfc2960': Object.freeze({ addCapabilities: Object.freeze(['managed-switch'] as const) }),
  'switch.nfc2960-48': Object.freeze({ addCapabilities: Object.freeze(['managed-switch'] as const) }),
  'switch.nfc2960-24pg': Object.freeze({ addCapabilities: Object.freeze(['managed-switch'] as const) }),
  'switch.nfc9200-48': Object.freeze({ addCapabilities: Object.freeze(['managed-switch'] as const) }),
  'mlswitch.nfc3650-24': Object.freeze({ addCapabilities: Object.freeze(['managed-switch'] as const) }),
  'mlswitch.nfc9300-48': Object.freeze({ addCapabilities: Object.freeze(['managed-switch'] as const), stpDefaultMode: 'rapid-pvst' as const }),
  'dcswitch.nfn9k-48': Object.freeze({ addCapabilities: Object.freeze(['managed-switch'] as const) }),
  'dcswitch.nfn9k-32': Object.freeze({ addCapabilities: Object.freeze(['managed-switch'] as const) }),
});

/** A registry overlay: a factory wins over `PROCESS_FACTORIES`; `undefined` removes that name. */
export type P2FactoryOverlay = Readonly<Record<ProcessName, ProcessFactory | undefined>>;
/** A daemon registry (name → factory), as `createCatalog` takes it. */
export type P2Registry = Readonly<Record<ProcessName, ProcessFactory>>;

/**
 * A model input as the flip will author it. `stpDefaultMode` is P2 model data (§2.9); it is typed here too so the
 * helper does not depend on when the catalog item adds it to `ModelInput`.
 */
type P2ModelInput = ModelInput & { readonly stpDefaultMode?: 'pvst' | 'rapid-pvst' };

/** `input` with its delta applied, as a new object. Idempotent: a listed capability is not repeated, a set mode is kept. */
export function applyP2ModelDelta(input: ModelInput, delta: P2ModelDelta | undefined = P2_MODEL_DELTAS[input.type]): ModelInput {
  if (delta === undefined) return input;
  const capabilities = [...input.capabilities];
  for (const c of delta.addCapabilities ?? []) if (!capabilities.includes(c)) capabilities.push(c);
  const out: P2ModelInput = { ...input, capabilities };
  if (delta.stpDefaultMode !== undefined && (input as P2ModelInput).stpDefaultMode === undefined) {
    return { ...out, stpDefaultMode: delta.stpDefaultMode };
  }
  return out;
}

/** `PROCESS_FACTORIES` with `overlay` laid over it (a factory wins, `undefined` removes the name). Frozen. */
export function p2Registry(overlay: P2FactoryOverlay = {}): P2Registry {
  const out: Record<ProcessName, ProcessFactory> = { ...PROCESS_FACTORIES };
  for (const [name, factory] of Object.entries(overlay)) {
    if (factory === undefined) delete out[name];
    else out[name] = factory;
  }
  return Object.freeze(out);
}

function hasFactory(registry: P2Registry, name: ProcessName): boolean {
  return Object.prototype.hasOwnProperty.call(registry, name);
}

/** Rank of a daemon in the final order; unknown names sort last in their given order. */
function finalRank(name: ProcessName): number {
  const at = P2_PROCESS_ORDER.indexOf(name);
  return at < 0 ? P2_PROCESS_ORDER.length : at;
}

/**
 * `processes` completed with the P2 rows of the EXPANDED capabilities `caps` and filtered to `registry`: a row's daemon
 * joins when it has a factory; a P2 daemon (`P2_DAEMONS`) without a factory is removed wherever it came from; every
 * other daemon of `processes` is kept. The result is in the final order (`P2_PROCESS_ORDER`).
 */
export function completeP2Processes(processes: readonly ProcessName[], caps: readonly Capability[], registry: P2Registry): readonly ProcessName[] {
  const all: ProcessName[] = processes.filter((p) => !P2_DAEMONS.includes(p) || hasFactory(registry, p));
  for (const cap of caps) {
    for (const p of P2_CAPABILITY_PROCESS_ROWS[cap] ?? []) {
      if (!all.includes(p) && hasFactory(registry, p)) all.push(p);
    }
  }
  return all
    .map((name, i) => ({ name, i }))
    .sort((a, b) => finalRank(a.name) - finalRank(b.name) || a.i - b.i)
    .map((e) => e.name);
}

/** Deep-freeze a plain value (models are structured-clone data). */
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value as Record<string, unknown>)) freeze(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * One P2-stage model: the delta applied, `defineModel(…, 'P2')`, processes completed and filtered to `registry`,
 * tables and port owners re-derived from the completed list (define.ts rules).
 */
export function defineP2Model(input: ModelInput, registry: P2Registry = PROCESS_FACTORIES): DeviceModel {
  const base = defineModel(applyP2ModelDelta(input), 'P2', ALL_MODULES);
  const caps = base.capabilities ?? expandCapabilities(input.capabilities);
  const processes = completeP2Processes(base.processes, caps, registry);
  const moduleProcesses = moduleReachableProcesses(caps, base.slots ?? [], processes, 'P2', ALL_MODULES);
  return freeze<DeviceModel>({
    ...base,
    processes,
    tables: deriveTables(processes),
    portOwners: derivePortOwners(base.ports, base.virtualFamilies ?? [], processes, moduleProcesses),
  });
}

/** Every P2-stage model in palette order (the real catalog order), built for `registry`. */
export function p2Models(registry: P2Registry = PROCESS_FACTORIES): readonly DeviceModel[] {
  return Object.freeze(ALL_MODEL_INPUTS.map((input) => defineP2Model(input, registry)));
}

/**
 * The P2-stage `DeviceCatalog` (the shape and lookups of `createCatalog`, without its validation — see the file
 * header): models from `p2Models(p2Registry(factories))`, the real module list, the real port-name resolver, and the
 * registry as its daemon factories.
 */
export function createP2Catalog(factories: P2FactoryOverlay = {}): DeviceCatalog {
  const registry = p2Registry(factories);
  const models = p2Models(registry);
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
  /** Laid over `PROCESS_FACTORIES` (see `p2Registry`); only P2 daemons with a factory join the models. */
  readonly factories?: P2FactoryOverlay;
}

/** A simulation whose catalog is `createP2Catalog(opts.factories)` and whose world profile is `opts.profile ?? 'P2'`. */
export function createP2Simulation(opts: P2WorldOptions): Simulation {
  const { factories, profile, ...rest } = opts;
  return createSimulation({ ...rest, profile: profile ?? 'P2', catalog: createP2Catalog(factories) });
}
