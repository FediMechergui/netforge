/**
 * test/staged.world.ts — real worlds of any build stage, with a daemon registry overlay (ARCHITECTURE-P3 §0 rule 13;
 * §7 W0 qa). It generalises `test/p2.world.ts` (ARCHITECTURE-P2 §0 rule 13), whose names are now thin wrappers of
 * this file keyed to stage P2.
 *
 * `createStagedSimulation({seed, stage, profile, factories})` is `createSimulation` with the catalog of
 * `createStagedCatalog({stage, factories})` and the world profile `profile ?? stagedDefaultProfile(stage)` (the stage's
 * own profile: 'P3' at stage P3, 'P2' at stage P2, else 'P1'):
 *   1. the registry is `PROCESS_FACTORIES` with `factories` laid over it (`stagedRegistry`): a passed factory wins, and
 *      a name passed as `undefined` is removed, so a test models a daemon that is missing, or runs a daemon under test
 *      as a stub, while every other daemon keeps its real factory;
 *   2. every model input goes through `defineStagedModel(input, stage, registry)`: `defineModel(…, stage)` of the input
 *      with its P2 model delta applied (read from the real inputs, so a real input is unchanged), then its daemons
 *      derived again by `deriveStagedProcesses` over the real `CAPABILITY_PROCESSES` rows plus the P3 test-only rows
 *      below, in the final daemon order below, and FILTERED to the registry: an approved P2 or P3 daemon
 *      (`STAGED_DAEMONS`) without a factory is left out, so no "Process … is not available" log appears; then `tables`
 *      (`deriveStagedTables`) and `portOwners` derived again from the filtered list. P0/P1 daemons are never filtered:
 *      removing one is the caller's choice and the device logs it at boot.
 *
 * P3 test-only data (rule 13), applied when the stage is 'P3' (every row is `since: 'P3'`, so no earlier stage derives
 * it). The W4 catalog flip (and the W6 flip for [S32]) makes it the real contract; `staged.world.p3-parity.test.ts`
 * (W4) asserts that this data equals the contract, and W8 reduces this file to a wrapper. Since the W4 flip the real
 * registry holds every approved P3 daemon but [S32] `script-host`, so the default overlay at stage P3 builds the
 * flipped catalog model for model (plus the test-only NF-DEVHOST), `profileConfig.P3` (the two [S24] lines, D2)
 * included: a test that needs a P3 daemon ABSENT now removes it with `{ <name>: undefined }`.
 *   - `STAGED_PROCESS_ORDER`: the §2.1 final `PROCESS_ORDER` restricted to approved names (§8.5). The real
 *     `PROCESS_ORDER` is an order-preserving subsequence of it, so at stages up to P2 it orders exactly as the real one.
 *   - `P3_CAPABILITY_PROCESS_ROWS`: the §2.1 `CAPABILITY_PROCESSES` rows of P3, the approved items' rows included, and
 *     [S32]'s `programmable` row (the W6 flip's).
 *   - `P3_PROCESS_TABLES`: the §2.6 `PROCESS_TABLES` additions of the daemons above, so a P3 daemon under test finds
 *     its tables on the model (the runtime declares `model.tables` plus the real `PROCESS_TABLES` of its daemons).
 *   - `P3_STAGED_PROCESS_TABLES`: the §2.6 stage-filtered snooping tables (the W4 `STAGED_PROCESS_TABLES` row): `vlan`
 *     brings `dhcp-snooping` and `arp-inspection` from stage P3, to `managed-switch` models only, never to the
 *     controller (which runs `vlan` too).
 *   - NF-DEVHOST (`nfDevhostTestInput`, type `pc.nfdevhost`, `host` + `programmable`) for [S32], in the catalog at
 *     stage P3 right after the last Computers model, until the W6 flip puts the real model in `computers.ts` (then the
 *     real input is used and the test-only one is not added).
 *
 * The test injector (W1 qa, ARCHITECTURE-P3 §7 W1 qa, D13): when the registry overlay registers a factory named
 * `injector` (`INJECTOR_PROCESS`; `test/inject.ts` provides it, `withInjector(...)`), the catalog also holds the test-only
 * host NF-INJECTOR (`INJECTOR_HOST_TYPE`, after every other model): no capability, so no other daemon, four gigabit
 * ports, and exactly one daemon, the injector, which sends pre-built frames out of a port at a fixed spacing
 * (`injectFrames`). Without that factory nothing changes (no overlay the P2/P3 pins use registers it).
 *
 * With the default registry at stage P2 nothing is filtered and the catalog equals the real model inputs defined at
 * stage P2 (`defineModel(input, 'P2')`), model for model (`device.catalog.p2.test.ts`); at stage P2
 * `createStagedSimulation` is `createP2Simulation` (`staged.world.test.ts`). It is NOT the shipped catalog: since the
 * P3 W4 flip that one is derived at stage P3 and equals this helper at stage P3, apart from the test-only NF-DEVHOST
 * (`staged.world.p3-parity.test.ts`). A test that must exercise the shipped models uses `createSimulation`.
 * The catalog is never validated: a filtered model is not the model its capabilities derive, which `validateCatalog`
 * would refuse by design.
 *
 * Limitation (until the W4 flip, which lifted it): a device that installs a module recomputes its daemon list with
 * the REAL `deriveProcesses` at `CATALOG_STAGE` and ranks names by the real `PROCESS_ORDER` (`device.ts`
 * computeProcessOrder), so before the flip a module added at run time in a P3 world added no P3 daemon and ranked the
 * model's P3 daemons after the others. Since the flip both are the P3 ones ([S32] `script-host` waits for W6), so
 * the limitation is now the reverse one: in a world of this helper at stage P2 (or P1), a module that adds a
 * capability at run time also brings that capability's P3 daemons (the W4b fix step).
 *
 * Nothing here is module-level mutable state: every call builds fresh, frozen models (rule 12). The P3 data are
 * plain literals; inputs are never mutated.
 */
import {
  CAPABILITY_PROCESSES,
  expandCapabilities,
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
import { PROCESS_TABLES, type ExtraTableName, type TableName } from '../src/contracts/tables.js';
import { ALL_MODEL_INPUTS, ALL_MODULES } from '../src/device/catalog.js';
import { hostEth } from '../src/device/catalog/computers.js';
import { deepFreeze, defineModel, derivePortOwners, modulesFitting, type ModelInput } from '../src/device/catalog/define.js';
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

// ── P3 test-only data (ARCHITECTURE-P3 §0 rule 13, §2.1, §2.6) ────────────────────────────────────────────────

/**
 * The §2.1 final `PROCESS_ORDER`, restricted to the approved names (the unapproved ospfv3, tftp, snmp-agent and
 * snmp-manager left out). The relative order of the real `PROCESS_ORDER` names is unchanged.
 */
export const STAGED_PROCESS_ORDER: readonly ProcessName[] = Object.freeze([
  'wlan-ap',
  'wlan-client',
  'capwap-wtp',
  'cell-client',
  'hdlc',
  'ppp', // [S19]
  'eth-switch',
  'vlan',
  'dtp',
  'etherchannel',
  'stp',
  'cdp',
  'lldp',
  'arp',
  'ipv4',
  'nat',
  'acl',
  'gre', // [S18]
  'icmpv4',
  'host',
  'ipv6',
  'nd',
  'icmpv6',
  'udp',
  'tcp',
  'vty', // [S13]
  'vty-client', // [S13]
  'logger', // [S24]
  'ntp',
  'syslog-server', // [S25]
  'hsrp',
  'ospf',
  'eigrp', // [C1]
  'ike', // [C13]
  'dhcp-client',
  'dhcp-server',
  'dhcpv6-client',
  'dhcpv6-server',
  'dns-client',
  'dns-server',
  'http-client',
  'http-server',
  'restconf',
  'traceroute',
  'traffic',
  'capwap-ac',
  'script-host', // [S32], the W6 flip
]);

const p3 = (process: ProcessName): CapabilityProcess => Object.freeze({ process, since: 'P3' as BuildStage });

/**
 * The §2.1 `CAPABILITY_PROCESSES` rows of P3 (all `since: 'P3'`), each capability's rows in `STAGED_PROCESS_ORDER`
 * order: the W4 flip's MUST rows, the approved items' rows ([S13] vty/vty-client, [S18] gre, [S19] ppp, [S24] logger,
 * [S25] syslog-server, [C1] eigrp, [C13] ike) and the W6 flip's [S32] `programmable` row (`script-host` only; the
 * [S29] tftp of the management map is not approved). `managed-switch` gains udp and tcp, dormant until a P3 service
 * is configured (D22, W1 l3). Not approved, so no row: ospfv3 [S6], tftp [S29], snmp-agent, snmp-manager [S33].
 */
export const P3_CAPABILITY_PROCESS_ROWS: Readonly<Partial<Record<Capability, readonly CapabilityProcess[]>>> = Object.freeze({
  host: Object.freeze([p3('vty-client'), p3('traffic')]),
  server: Object.freeze([p3('ntp'), p3('syslog-server')]),
  routing: Object.freeze([
    p3('ppp'), p3('cdp'), p3('lldp'), p3('acl'), p3('gre'), p3('vty'), p3('vty-client'), p3('logger'), p3('ntp'),
    p3('ospf'), p3('eigrp'), p3('ike'), p3('restconf'),
  ]),
  'managed-switch': Object.freeze([
    p3('cdp'), p3('lldp'), p3('acl'), p3('udp'), p3('tcp'), p3('vty'), p3('vty-client'), p3('logger'), p3('ntp'), p3('restconf'),
  ]),
  'wireless-controller': Object.freeze([p3('cdp'), p3('logger'), p3('ntp')]),
  programmable: Object.freeze([p3('script-host')]),
});

/** The §2.6 `PROCESS_TABLES` additions of the P3 daemons (the W4 flip; `script-host` the W6 flip). */
export const P3_PROCESS_TABLES: Readonly<Partial<Record<ProcessName, readonly ExtraTableName[]>>> = Object.freeze({
  ppp: Object.freeze(['ppp'] as const), // [S19]
  cdp: Object.freeze(['cdp-neighbours'] as const),
  lldp: Object.freeze(['lldp-neighbours'] as const),
  acl: Object.freeze(['acl'] as const),
  gre: Object.freeze(['tunnels'] as const), // [S18]
  vty: Object.freeze(['vty-logins'] as const), // [S13]
  ntp: Object.freeze(['ntp-peers', 'clock'] as const),
  'syslog-server': Object.freeze(['syslog-messages'] as const), // [S25]
  ospf: Object.freeze(['ospf-interfaces', 'ospf-neighbors', 'ospf-lsdb'] as const),
  eigrp: Object.freeze(['eigrp-neighbors', 'eigrp-topology'] as const), // [C1]
  ike: Object.freeze(['ipsec-sa'] as const), // [C13]
  restconf: Object.freeze(['restconf-log'] as const),
  traffic: Object.freeze(['flows'] as const),
  'script-host': Object.freeze(['script-runs'] as const), // [S32]
});

/** One stage-filtered table row: the shape of the W4 `STAGED_PROCESS_TABLES` (ARCHITECTURE-P3 §2.6). */
export interface StagedProcessTables {
  readonly process: ProcessName;
  readonly tables: readonly ExtraTableName[];
  readonly since: BuildStage;
  readonly requires: Capability;
}

/**
 * §2.6: tables a daemon brings only from a stage on, and only to models with a capability. The snooping tables are
 * `vlan`'s from stage P3 on `managed-switch` models; never plain `vlan` rows, so the controller never declares them.
 */
export const P3_STAGED_PROCESS_TABLES: readonly StagedProcessTables[] = Object.freeze([
  Object.freeze({ process: 'vlan', tables: Object.freeze(['dhcp-snooping', 'arp-inspection'] as const), since: 'P3' as BuildStage, requires: 'managed-switch' as Capability }),
]);

/** The type of the test-only NF-DEVHOST ([S32]). */
export const NF_DEVHOST_TYPE = 'pc.nfdevhost';

/**
 * The test-only NF-DEVHOST input ([S32], ARCHITECTURE-P3 §7 W0 qa, until the W6 flip): a workstation with `host` and
 * `programmable` (the NF-Py script host and the automation workspace), one gigabit adapter, category Computers. Built
 * at call time (rule 12); a fresh object each call.
 */
export function nfDevhostTestInput(): ModelInput {
  return {
    type: NF_DEVHOST_TYPE,
    model: 'NF-DEVHOST',
    description: 'Developer workstation with one gigabit network adapter, a host shell and a scripting workspace',
    category: 'computers',
    icon: 'pc',
    capabilities: ['host', 'programmable'],
    ports: [hostEth('GigabitEthernet0', SPEED_1G)],
    family: 'nf-devhost',
    tags: ['developer', 'workstation', 'automation', 'scripting', 'computer', 'host', 'end device'],
  };
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

// ── derivations ────────────────────────────────────────────────────────────────────────────────────────────────

/** The rows of one capability: the real `CAPABILITY_PROCESSES` rows, then the P3 test-only rows. */
function capabilityRows(cap: Capability): readonly CapabilityProcess[] {
  return [...(CAPABILITY_PROCESSES[cap] ?? []), ...(P3_CAPABILITY_PROCESS_ROWS[cap] ?? [])];
}

/**
 * Daemons of an EXPANDED capability list for a build stage, in `STAGED_PROCESS_ORDER`: the union of the real and the
 * P3 test-only rows whose `since` is included in `stage`. At stages up to P2 this is exactly `deriveProcesses`. Throws
 * when a derived daemon is missing from `STAGED_PROCESS_ORDER` (stale test data), instead of misordering it.
 */
export function deriveStagedProcesses(caps: readonly Capability[], stage: BuildStage): readonly ProcessName[] {
  const wanted = new Set<ProcessName>();
  for (const cap of caps) {
    for (const row of capabilityRows(cap)) if (stageIncluded(row.since, stage)) wanted.add(row.process);
  }
  for (const p of wanted) {
    if (!STAGED_PROCESS_ORDER.includes(p)) throw new Error(`staged.world: daemon ${p} is not in STAGED_PROCESS_ORDER`);
  }
  return STAGED_PROCESS_ORDER.filter((p) => wanted.has(p));
}

/**
 * Tables a model owns at `stage`: cam, arp, rib, then for each daemon in `processes` order its real `PROCESS_TABLES`,
 * its `P3_PROCESS_TABLES` and the `P3_STAGED_PROCESS_TABLES` rows of that daemon whose `since` is included in `stage`
 * and whose `requires` is in `capabilities` (EXPANDED); each table once. At stages up to P2 this is `deriveTables`.
 */
export function deriveStagedTables(processes: readonly ProcessName[], capabilities: readonly Capability[], stage: BuildStage): readonly TableName[] {
  const out: TableName[] = ['cam', 'arp', 'rib'];
  const add = (t: TableName): void => {
    if (!out.includes(t)) out.push(t);
  };
  for (const p of processes) {
    for (const t of PROCESS_TABLES[p] ?? []) add(t);
    for (const t of P3_PROCESS_TABLES[p] ?? []) add(t);
    for (const row of P3_STAGED_PROCESS_TABLES) {
      if (row.process === p && stageIncluded(row.since, stage) && capabilities.includes(row.requires)) for (const t of row.tables) add(t);
    }
  }
  return out;
}

/**
 * Daemons a module fitting `slots` can add on top of `processes` (union over the fitting modules of
 * `deriveStagedProcesses(caps + capabilitiesAdded, stage)`), first-seen order: `moduleReachableProcesses` over the
 * staged rows.
 */
function stagedModuleReachableProcesses(
  caps: readonly Capability[],
  slots: DeviceModel['slots'],
  processes: readonly ProcessName[],
  stage: BuildStage,
): readonly ProcessName[] {
  const out: ProcessName[] = [];
  for (const m of modulesFitting(slots, ALL_MODULES)) {
    if ((m.capabilitiesAdded ?? []).length === 0) continue;
    for (const p of deriveStagedProcesses(expandCapabilities([...caps, ...(m.capabilitiesAdded ?? [])]), stage)) {
      if (!processes.includes(p) && !out.includes(p)) out.push(p);
    }
  }
  return out;
}

// ── models, catalog, world ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One model at `stage` with its daemons filtered to `registry`: `defineModel(applyP2ModelDelta(input), stage)`, then
 * its daemons from `deriveStagedProcesses` with every approved P2/P3 daemon (`STAGED_DAEMONS`) that has no factory
 * removed, and `tables` and `portOwners` derived again from the filtered list. At stage P2 this is the P2 helper's
 * `defineP2Model` exactly (`staged.world.test.ts` proves it against a copy of that code).
 */
export function defineStagedModel(input: ModelInput, stage: BuildStage, registry: StagedRegistry = PROCESS_FACTORIES): DeviceModel {
  const base = defineModel(applyP2ModelDelta(input), stage, ALL_MODULES);
  const processes = deriveStagedProcesses(base.capabilities, stage).filter(
    (p) => !STAGED_DAEMONS.includes(p) || Object.prototype.hasOwnProperty.call(registry, p),
  );
  const moduleProcesses = stagedModuleReachableProcesses(base.capabilities, base.slots, processes, stage);
  return deepFreeze<DeviceModel>({
    ...base,
    processes,
    tables: deriveStagedTables(processes, base.capabilities, stage),
    portOwners: derivePortOwners(base.ports, base.virtualFamilies, processes, moduleProcesses),
  });
}

/**
 * The model inputs of a stage, palette order: every real input (`ALL_MODEL_INPUTS`), plus at stage P3 the test-only
 * NF-DEVHOST right after the last Computers input, unless the real catalog already has that type (the W6 flip).
 */
export function stagedModelInputs(stage: BuildStage): readonly ModelInput[] {
  const out = [...ALL_MODEL_INPUTS];
  if (stageIncluded('P3', stage) && !out.some((i) => i.type === NF_DEVHOST_TYPE)) {
    let at = -1;
    out.forEach((i, k) => {
      if (i.category === 'computers') at = k;
    });
    out.splice(at < 0 ? out.length : at + 1, 0, nfDevhostTestInput());
  }
  return Object.freeze(out);
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
    tables: deriveStagedTables(processes, base.capabilities, stage),
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
 * The `DeviceCatalog` of a stage for a registry overlay (the shape and lookups of `createCatalog`, without its
 * validation — see the file header): every input of `stagedModelInputs(stage)` through `defineStagedModel`, the real
 * module list, the real port-name resolver, and the overlaid registry as its daemon factories.
 */
export function createStagedCatalog(opts: StagedCatalogOptions): DeviceCatalog {
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
  /** The build stage the catalog is derived for ('P3': with the P3 test-only data of the file header). */
  readonly stage: BuildStage;
  /** The world's defaults profile (default `stagedDefaultProfile(stage)`). */
  readonly profile?: DefaultsProfile;
  /** Laid over `PROCESS_FACTORIES` (see `stagedRegistry`); only approved P2/P3 daemons with a factory stay on models. */
  readonly factories?: StagedFactoryOverlay;
}

/** A simulation whose catalog is `createStagedCatalog({stage, factories})`, in `profile ?? stagedDefaultProfile(stage)`. */
export function createStagedSimulation(opts: StagedWorldOptions): Simulation {
  const { stage, factories, profile, ...rest } = opts;
  return createSimulation({ ...rest, profile: profile ?? stagedDefaultProfile(stage), catalog: createStagedCatalog({ stage, factories }) });
}
