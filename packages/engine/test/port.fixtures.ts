/**
 * Port fixture helpers for hand-built test models (P0.5 exit gate, ARCHITECTURE-P1 §0 rule 2 and §11 "fixture
 * churn"). Since the gate, `PortSpec.role/allowedRoles/connector/encap/ordinal` and `PortState.role/ordinal/encap`
 * are required. These helpers fill them the way `resolvePortSpec` does (defaultRoleFor, KIND_CONNECTOR,
 * KIND_ENCAP) WITHOUT adding the optional wiring/group members, so a hand-built port behaves exactly as before:
 * its copper wiring comes from its role's wiring trait. `testModel` does the same for a hand-built DeviceModel.
 * Not a test file itself.
 */
import {
  KIND_CONNECTOR,
  KIND_ENCAP,
  defaultRoleFor,
  ipDefaultsFor,
  type Capability,
  type DeviceCategory,
  type DeviceIconId,
  type PortSpecDerived,
} from '../src/contracts/catalog.js';
import type { DeviceKind, DeviceModel } from '../src/contracts/device.js';
import type { LinkModelDeps } from '../src/contracts/link.js';
import type { PortSpec, PortState } from '../src/contracts/port.js';
import type { ProcessCtx } from '../src/contracts/process.js';
import type { ArpRow, CamRow, DeviceTables, Lpm6Result, RouteRow, Table, TableName, TableRow } from '../src/contracts/tables.js';
import { deriveCliSpec, deriveTables } from '../src/device/catalog/define.js';

/** A port spec whose derived members may be omitted (as catalog data authors them). */
export type TestPortInput = Omit<PortSpec, PortSpecDerived> & Partial<Pick<PortSpec, PortSpecDerived>>;

/**
 * Fill the derived PortSpec members. `caps` are the owning model's capabilities (they pick the default role:
 * `switching` → switched ethernet, `repeater` → repeater, none → routed); `ordinal` defaults to 1.
 */
export function testPortSpec(input: TestPortInput, caps: readonly Capability[] = [], ordinal = 1): PortSpec {
  const role = input.role ?? defaultRoleFor(input.kind, caps);
  return {
    ...input,
    role,
    allowedRoles: input.allowedRoles ?? [role],
    connector: input.connector ?? KIND_CONNECTOR[input.kind],
    encap: input.encap ?? KIND_ENCAP[input.kind],
    ordinal: input.ordinal ?? ordinal,
  };
}

/** The runtime-owned PortState members as the device runtime initialises them from the spec. */
export function portStateFields(spec: PortSpec): Pick<PortState, 'role' | 'ordinal' | 'encap'> {
  return { role: spec.role, ordinal: spec.ordinal, encap: spec.encap };
}

/** The P0.5 DeviceModel members `testModel` fills when a hand-built fixture leaves them out. */
type ModelV2Member =
  | 'category' | 'family' | 'variant' | 'icon' | 'tags' | 'capabilities' | 'cli' | 'gui' | 'slots'
  | 'virtualFamilies' | 'hostPorts' | 'portOwners' | 'tables' | 'ipDefaults';

/** A hand-built model: P0 members, ports as `TestPortInput`, any P0.5 member optional. */
export type TestModelInput = Omit<DeviceModel, ModelV2Member | 'ports'> &
  Partial<Pick<DeviceModel, ModelV2Member>> & { readonly ports: readonly TestPortInput[] };

const KIND_CATEGORY: Partial<Record<DeviceKind, DeviceCategory>> = { router: 'routers', switch: 'switches', hub: 'legacy', pc: 'computers' };
const KIND_ICON: Partial<Record<DeviceKind, DeviceIconId>> = { router: 'router', switch: 'switch', hub: 'hub', pc: 'pc' };

/**
 * Complete a hand-built DeviceModel: ports through `testPortSpec` (ordinal = index + 1, roles from the capabilities),
 * CLI spec (the P0 network-OS default when there are no capabilities), tables and IP defaults derived as
 * `defineModel` does, and empty slots / virtual families / host ports /
 * owners / GUI panels (the fixture has none of them). Given members win.
 */
export function testModel(input: TestModelInput): DeviceModel {
  const capabilities = input.capabilities ?? [];
  return {
    ...input,
    ports: input.ports.map((p, i) => testPortSpec(p, capabilities, i + 1)),
    category: input.category ?? KIND_CATEGORY[input.kind] ?? 'iot',
    family: input.family ?? input.model.toLowerCase(),
    variant: input.variant ?? input.model,
    icon: input.icon ?? KIND_ICON[input.kind] ?? 'iot-sensor',
    tags: input.tags ?? [],
    capabilities,
    // P0 fixtures without capabilities keep the P0 console default (network OS, privilege 1, console and vty)
    cli: input.cli ?? (capabilities.length === 0 ? { shell: 'nfos', grammar: 'nfos', initialPrivilege: 1, consoleVia: ['console', 'vty'] } : deriveCliSpec(capabilities)),
    gui: input.gui ?? [],
    slots: input.slots ?? [],
    virtualFamilies: input.virtualFamilies ?? [],
    hostPorts: input.hostPorts ?? [],
    portOwners: input.portOwners ?? {},
    tables: input.tables ?? deriveTables(input.processes),
    ipDefaults: input.ipDefaults ?? ipDefaultsFor(capabilities),
  };
}

/**
 * Inert values for the P0.5 `LinkModelDeps` members that became required at the exit gate: no host terminals, default
 * PHY and radio settings, no optics, no canvas positions, dropped TX outcomes and medium notifications. Spread it
 * FIRST into a hand-built deps object so the harness's own members win.
 */
export const INERT_LINK_DEPS: Pick<LinkModelDeps, 'hostTerminal' | 'portSettings' | 'radioSettings' | 'transceiver' | 'position' | 'onTxOutcome' | 'notify'> =
  Object.freeze({
    hostTerminal: () => false,
    portSettings: () => undefined,
    radioSettings: () => undefined,
    transceiver: () => undefined,
    position: () => undefined,
    onTxOutcome: () => {},
    notify: () => {},
  });

/**
 * The five IPv6 `ProcessCtx` helpers (required since the P1 exit gate, §0 rule 2) for an IPv4-only harness whose
 * ports carry no `l3.ipv6` and whose tables declare no rib6. Every answer is the one `createProcessCtx` gives on
 * such a device, so spreading this in changes no behaviour. Spread FIRST so a harness's own member wins.
 */
export const NO_IPV6_CTX: Pick<ProcessCtx, 'lpm6' | 'ownAddress6' | 'isLocalDestination6' | 'connectedPortFor6' | 'sourceFor6'> = Object.freeze({
  lpm6: (): Lpm6Result => ({ candidates: [] }),
  ownAddress6: () => undefined,
  isLocalDestination6: () => false,
  connectedPortFor6: () => undefined,
  sourceFor6: () => undefined,
});

/**
 * Give a P0 table triple the P0.5 `DeviceTables` accessors (required since the exit gate): `get` finds cam/arp/rib
 * by name and nothing else, `names` lists the three in order. Matches a model that declares no extra tables.
 */
export function p0Tables<T extends { readonly cam: Table<CamRow>; readonly arp: Table<ArpRow>; readonly rib: Table<RouteRow> }>(t: T): T & DeviceTables {
  const byName = (name: TableName): Table<TableRow> | undefined =>
    name === 'cam' ? (t.cam as unknown as Table<TableRow>) : name === 'arp' ? (t.arp as unknown as Table<TableRow>) : name === 'rib' ? (t.rib as unknown as Table<TableRow>) : undefined;
  return Object.assign(t, {
    get: <R extends TableRow = TableRow>(name: TableName): Table<R> | undefined => byName(name) as unknown as Table<R> | undefined,
    names: (): readonly TableName[] => ['cam', 'arp', 'rib'],
  });
}
