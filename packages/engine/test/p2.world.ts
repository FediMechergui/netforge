/**
 * test/p2.world.ts — real P2-stage worlds before the catalog flips (ARCHITECTURE-P2 §0 rule 13, §7 W1 qa); since the
 * W4 and W6 flips, the real catalog with a registry overlay.
 *
 * `createP2Simulation({seed, profile, factories})` builds a catalog the way the W4 and W6 catalog flips do, without
 * touching the real one:
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
 * The W6 wireless model deltas (§7 W4 qa, §7 W6 catalog, §9.2 item 23) were held here as TEST-ONLY data for W5. Since
 * the W6 catalog item they RESOLVE TO THE REAL DATA, so the catalog is defined once: `P2_WIRELESS_MODEL_DELTAS`
 * (NF-AP-1832 gains `lightweight-ap`) is idempotent on the real input, which already carries the capability, and
 * `NF_WLC_9800_TEST_INPUT` is the real `NF_WLC_9800_INPUT` of device/catalog/wireless.ts (as `CAPWAP_TUNNEL_FAMILY` and
 * `WLC_VLAN_FAMILY` are define.ts's families), so `p2ModelInputs()` inserts nothing. `p2ModelDeltaFor(type)` merges
 * the W4 and W6 deltas; `P2_MODEL_DELTAS` itself stays the W4 list. W8 reduces this helper to a thin wrapper.
 *
 * The registry is `PROCESS_FACTORIES` with `factories` laid over it: a passed factory wins, and a name passed as
 * `undefined` is removed (so a test can model a daemon that is missing even after the flip registered it). A test
 * therefore adds only the daemons under test (`{ vlan: createVlan, stp: createStp }`) and every P0/P1 daemon keeps its
 * real factory. P1 daemons are never filtered: removing one is the caller's choice and the device logs it at boot.
 *
 * The helper never validates: before the flips the P2 daemon names were not in the contract `PROCESS_ORDER` (§0
 * rule 3), so `validateCatalog` would have refused every completed model by design. The catalog owner's own tests
 * validate `defineModel(…, 'P2')`. Since the W4 and W6 flips every delta is in the data and every row in
 * `CAPABILITY_PROCESSES`, so with the default registry the helper equals the real catalog, model for model
 * (device.catalog.p2.test.ts checks it; W8 reduces the helper to a thin wrapper).
 *
 * Nothing here is module-level mutable state: every call builds fresh, frozen models (rule 12; several simulations
 * share one realm once replayers exist). Inputs are never mutated.
 */
import { expandCapabilities, type Capability, type DefaultsProfile, type VirtualFamilySpec } from '../src/contracts/catalog.js';
import type { DeviceCatalog, DeviceModel, PortNameSource, PortResolution } from '../src/contracts/device.js';
import type { ProcessName } from '../src/contracts/ids.js';
import type { ProcessFactory } from '../src/contracts/process.js';
import type { Simulation, SimulationOptions } from '../src/contracts/simulation.js';
import { ALL_MODEL_INPUTS, ALL_MODULES } from '../src/device/catalog.js';
import {
  CAPWAP_TUNNEL_FAMILY as REAL_CAPWAP_TUNNEL_FAMILY,
  CONTROLLER_VLAN_FAMILY,
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
 * wireless-controller). Since both flips every row is in the contract `CAPABILITY_PROCESSES`, so completing a model's
 * list adds nothing to the real derivation (the rows keep their use for registries that remove a P2 daemon).
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
 * wireless deltas (NF-AP-1832 lightweight, NF-WLC-9800) live in `P2_WIRELESS_MODEL_DELTAS` and `NF_WLC_9800_TEST_INPUT`.
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

/**
 * The W6 wireless model deltas (§7 W6 catalog, §9.2 item 23), by type id: NF-AP-1832 gains `lightweight-ap` (define.ts
 * then derives `profileConfig.P2` = `capwap enable`, `interface Vlan1` / ` ip address dhcp` / ` no shutdown`, and the
 * `lightweight-ap` row brings `capwap-wtp`, `udp`, `dhcp-client`). TEST-ONLY data for W5; since the W6 catalog item
 * the real input carries the capability, so applying the delta changes nothing. Kept apart from `P2_MODEL_DELTAS` so
 * that the W4 list stays exactly the managed switches.
 */
export const P2_WIRELESS_MODEL_DELTAS: Readonly<Record<string, P2ModelDelta>> = Object.freeze({
  'ap.nfap-lw': Object.freeze({ addCapabilities: Object.freeze(['lightweight-ap'] as const) }),
});

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
 * The controller's CAPWAP tunnel family (§2.1 `VirtualFamilySpec.role` 'wlan-tunnel', §3.12 step 7): one auto
 * instance `Capwap0`, bridged and hairpin, egress owned by `capwap-ac`. TEST-ONLY data for W5; since the W6 catalog
 * item it is define.ts's `CAPWAP_TUNNEL_FAMILY`, which `defineModel` derives for a `wireless-controller` model.
 */
export const CAPWAP_TUNNEL_FAMILY: VirtualFamilySpec = REAL_CAPWAP_TUNNEL_FAMILY;

/**
 * The controller's SVI family: `interface Vlan<v>` for every VLAN a `wlc-interface` names (§3.12); no auto instance.
 * Since the W6 catalog item it is define.ts's `CONTROLLER_VLAN_FAMILY`.
 */
export const WLC_VLAN_FAMILY: VirtualFamilySpec = CONTROLLER_VLAN_FAMILY;

/**
 * NF-WLC-9800 (`wlc.nfwlc9800`, §7 W6 catalog, §9.2 item 23, D17): TEST-ONLY model data for W5, which the W6 catalog
 * item replaced by the real input — this name now IS `NF_WLC_9800_INPUT` of device/catalog/wireless.ts
 * (`wireless-controller`; eth-switch, vlan, arp, ipv4, icmpv4, host, udp, capwap-ac; shell `none` with the `nfos`
 * grammar; the `wlc.controller` panel; the auto `Capwap0`; four GigabitEthernet0/x ports and a console; no
 * `defaultConfig`), so the W5 tests that name it build the real controller.
 */
export const NF_WLC_9800_TEST_INPUT: ModelInput = NF_WLC_9800_INPUT;

/**
 * Every model input the P2-stage catalog is built from, in palette order: the real inputs, with NF-WLC-9800 inserted
 * before NF-WLC-3504 when the real catalog does not carry it (before the W6 catalog item; since then nothing is
 * inserted). A fresh array every call; the inputs themselves are never copied or mutated.
 */
export function p2ModelInputs(): readonly ModelInput[] {
  const out = [...ALL_MODEL_INPUTS];
  if (!out.some((i) => i.type === NF_WLC_9800_TEST_INPUT.type)) {
    const at = out.findIndex((i) => i.type === 'wlc.nfwlc3504');
    out.splice(at < 0 ? out.length : at, 0, NF_WLC_9800_TEST_INPUT);
  }
  return Object.freeze(out);
}

/** A registry overlay: a factory wins over `PROCESS_FACTORIES`; `undefined` removes that name. */
export type P2FactoryOverlay = Readonly<Record<ProcessName, ProcessFactory | undefined>>;
/** A daemon registry (name → factory), as `createCatalog` takes it. */
export type P2Registry = Readonly<Record<ProcessName, ProcessFactory>>;

/**
 * A model input as the flip will author it. `stpDefaultMode` is P2 model data (§2.9); it is typed here too so the
 * helper does not depend on when the catalog item adds it to `ModelInput`.
 */
type P2ModelInput = ModelInput & { readonly stpDefaultMode?: 'pvst' | 'rapid-pvst' };

/**
 * `input` with its delta applied (default: the merged W4 and W6 delta of its type, `p2ModelDeltaFor`), as a new
 * object. Idempotent: a listed capability is not repeated, a set mode is kept.
 */
export function applyP2ModelDelta(input: ModelInput, delta: P2ModelDelta | undefined = p2ModelDeltaFor(input.type)): ModelInput {
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

/** Every P2-stage model in palette order (the real catalog order; see `p2ModelInputs`), built for `registry`. */
export function p2Models(registry: P2Registry = PROCESS_FACTORIES): readonly DeviceModel[] {
  return Object.freeze(p2ModelInputs().map((input) => defineP2Model(input, registry)));
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
