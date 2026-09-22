/**
 * device/ports.ts — live port construction, canonical ordering, virtual interfaces and virtual oper state
 * (ARCHITECTURE-P1 D3, D7, D8, §3.3 step 6, §3.10).
 *
 * Pure helpers used by the device runtime (device/device.ts). They build `PortState` objects, keep the port Map
 * in canonical order WITHOUT replacing the Map object (process contexts hold the same Map), create virtual
 * interface instances (`Vlan<n>`, `Loopback<n>`) and derive the oper state of virtual ports, which the runtime
 * owns (§3.10). Nothing here emits trace events or touches the link model: callers apply the returned changes,
 * emit `portState` and fan `onLinkChange` out.
 *
 * Canonical port order (DeviceRuntime.ports):
 *   1. fixed ports in `model.ports` order;
 *   2. module ports by slot index, then by port ordinal (128 + slot×16 + i, D7);
 *   3. virtual ports by `model.virtualFamilies` order, then ascending instance number;
 *   4. (P2) subinterfaces `<parent>.<n>`, after every other virtual port, by (parent position, n) (ARCHITECTURE-P2 §3.4).
 *
 * P2 (ARCHITECTURE-P2 §3.0 "Virtual oper state", D10, D11; W1 device):
 *  - `evaluateVirtualOper` knows the new roles — `channel` (up while a bundled member is up), `subif` (up while its
 *    parent is an up routed port and `encapsulation dot1Q` is set), `wlan-tunnel` (up while the device is up) — and,
 *    when the runtime injects `VirtualOperLookups`, the VLAN-aware SVI rule (any VLAN; `vlan-missing`, otherwise the
 *    P1 reason `no-bridged-port-up`). Without lookups every P1 rule applies unchanged;
 *  - the subinterface factory (`planSubinterface`, `createSubinterfacePortState`): the parent's MAC, ordinal and MTU,
 *    `PortSpec.parent`, administratively up.
 *
 * Determinism: every ordering is explicit (indexes and numbers); no Set or object-identity ordering is used.
 */
import { portMac } from '../contracts/addr.js';
import type { DeviceModel } from '../contracts/device.js';
import type { PortId } from '../contracts/ids.js';
import { DEFAULT_MTU, SPEED_1G, emptyCounters, type PortSpec, type PortState, type PortView } from '../contracts/port.js';
import type { SimTime } from '../contracts/time.js';
import {
  KIND_ENCAP,
  ROLE_TRAITS,
  defaultRoleFor,
  type Capability,
  type PortEncap,
  type PortRole,
  type VirtualFamilySpec,
} from '../contracts/catalog.js';
import type { ConfigAst } from '../contracts/config.js';
import { parseSubinterfaceName, subinterfacePortName, virtualPortName } from './catalog/names.js';

// ── wording (original, §1.6) ─────────────────────────────────────────────────

/** Original messages of virtual interface creation and removal. `{name}`, `{family}`, `{min}`, `{max}` are filled by the helpers. */
export const VIRTUAL_PORT_MESSAGES = Object.freeze({
  /** `no interface Vlan1` on an auto instance (wording fixed by ARCHITECTURE-P1 §3.10). */
  builtIn: 'This interface is built in and cannot be removed.',
  /** The name belongs to no creatable family of this model. */
  notCreatable: 'This device cannot create an interface called {name}.',
  /** The family exists but the number is outside its range. */
  outOfRange: '{family} interfaces on this device are numbered {min} to {max}.',
  /** `no interface X` for a port that is not a virtual interface. */
  notVirtual: '{name} is a physical interface and cannot be removed.',
  /** `no interface X` for a virtual interface that does not exist. */
  noSuchInterface: 'There is no interface called {name}.',
  /** An SVI on a router whose Vlan family comes from a switch module that is not installed (no `switching`). */
  needsSwitchModule: 'This interface needs a switch module in this router.',
  /** Log text for an SVI other than Vlan1 (VLANs arrive in a later release). */
  vlanUnsupported: 'Interface {name} stays down: only VLAN 1 is available in this release.',
  /** @since P2 Log text for an SVI of a VLAN-aware device whose VLAN does not exist (ARCHITECTURE-P2 §9.2 W4 item 16). */
  vlanMissing: 'Interface {name} stays down: VLAN {vlan} does not exist.',
  /** @since P2 `interface <parent>.<n>` with n outside the model's subinterface range. */
  subinterfaceOutOfRange: 'Subinterfaces on this device are numbered 1 to {max}.',
  /** @since P2 `interface <parent>.<n>` on a port that is not a routed interface (a switched port, a serial line, …). */
  subinterfaceNeedsRoutedParent: '{parent} is not a routed interface, so it cannot carry subinterfaces.',
});

/** Fill `{key}` placeholders of a message template. */
function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  let out = template;
  for (const key of Object.keys(values)) out = out.split(`{${key}}`).join(String(values[key]));
  return out;
}

// ── construction of fixed and module ports ───────────────────────────────────

/** Effective default role of a port spec: `spec.role`, else `defaultRoleFor(kind, capabilities)`. */
export function specRole(spec: Pick<PortSpec, 'role' | 'kind'>, capabilities: readonly Capability[] | undefined): PortRole {
  return spec.role ?? defaultRoleFor(spec.kind, capabilities ?? []);
}

/** Effective default encapsulation of a port spec: `spec.encap`, else `KIND_ENCAP[kind]`. */
export function specEncap(spec: Pick<PortSpec, 'encap' | 'kind'>): PortEncap {
  return spec.encap ?? KIND_ENCAP[spec.kind];
}

/**
 * Factory-default admin state of a port (§3.3 step 6): configurable roles use `spec.defaultAdminUp`, else
 * `portsDefaultUp`; roles that are not configurable (console, repeater) are always administratively up.
 */
export function defaultAdminUpFor(spec: Pick<PortSpec, 'defaultAdminUp'>, role: PortRole, portsDefaultUp: boolean): boolean {
  if (!ROLE_TRAITS[role].configurable) return true;
  return spec.defaultAdminUp ?? portsDefaultUp;
}

/** Inputs shared by every port built for one device. */
export interface PortBuildContext {
  /** The device's 32-bit MAC base (`deviceMacBase(id, salt)`, D8). */
  readonly macBase: number;
  /** Effective capabilities (model plus installed modules). */
  readonly capabilities: readonly Capability[] | undefined;
  /** `model.portsDefaultUp`. */
  readonly portsDefaultUp: boolean;
}

/**
 * Build the live state of a fixed or module port (§3.3 step 6): role, encap, ordinal (`spec.ordinal`, else
 * `defaultOrdinal`), MAC `portMac(macBase, ordinal)`, admin default, MTU `spec.mtu ?? 1500`, operUp false, empty
 * counters and L3 state. Module ports carry `module` when `install` is given.
 */
export function createPortState(spec: PortSpec, defaultOrdinal: number, ctx: PortBuildContext): PortState {
  const role = specRole(spec, ctx.capabilities);
  const ordinal = spec.ordinal ?? defaultOrdinal;
  const state: PortState = {
    id: spec.name,
    spec,
    mac: portMac(ctx.macBase, ordinal),
    adminUp: defaultAdminUpFor(spec, role, ctx.portsDefaultUp),
    operUp: false,
    mtu: spec.mtu ?? DEFAULT_MTU,
    counters: emptyCounters(),
    l3: {},
    tx: { busyUntil: 0, queue: 0 },
    role,
    ordinal,
    encap: specEncap(spec),
  };
  if (spec.slot !== undefined && spec.module !== undefined) state.module = { slot: spec.slot, module: spec.module };
  return state;
}

/** Live states of every fixed port of `model`, in model order (default ordinal = index + 1). */
export function fixedPortStates(model: Pick<DeviceModel, 'ports'>, ctx: PortBuildContext): PortState[] {
  return model.ports.map((spec, i) => createPortState(spec, i + 1, ctx));
}

// ── virtual interfaces ───────────────────────────────────────────────────────

/** A parsed virtual interface name: its family and instance number. */
export interface VirtualPortName {
  readonly family: VirtualFamilySpec;
  readonly number: number;
  /** Canonical name `${family}${number}`. */
  readonly name: PortId;
}

/** Index of a family inside `model.virtualFamilies`, or -1. */
function familyIndex(model: Pick<DeviceModel, 'virtualFamilies'>, family: string): number {
  return (model.virtualFamilies ?? []).findIndex((f) => f.family === family);
}

/**
 * Parse a CANONICAL virtual interface name (`Vlan10`, `Loopback0`, P2 `Port-channel1`: the family letters may be
 * hyphenated, as names.ts accepts them) against the model's families. Undefined when the letters match no family or
 * the number part is not a plain decimal. The range is NOT checked here.
 */
export function parseVirtualPortName(model: Pick<DeviceModel, 'virtualFamilies'>, name: PortId): VirtualPortName | undefined {
  const m = /^([A-Za-z]+(?:-[A-Za-z]+)*)([0-9]+)$/.exec(name);
  if (!m) return undefined;
  const family = (model.virtualFamilies ?? []).find((f) => f.family === m[1]);
  if (family === undefined) return undefined;
  const number = Number(m[2]);
  if (!Number.isSafeInteger(number)) return undefined;
  return { family, number, name: virtualPortName(family, number) };
}

/** True when instance `n` of `family` is created automatically and cannot be removed. */
export function isAutoInstance(family: Pick<VirtualFamilySpec, 'auto'>, n: number): boolean {
  return (family.auto ?? []).includes(n);
}

/**
 * Port spec of a virtual interface instance (§3.10): kind `virtual`, role from the family, encap `ethernet` for
 * SVIs and every bridged family (Port-channel, the controller tunnel: frames cross them and eth-switch / stp treat
 * them as ports) and `none` for loopbacks (role `virtual`), ordinal 0 (base MAC), connector `none`, the family's
 * default admin state.
 */
export function virtualPortSpec(family: VirtualFamilySpec, n: number): PortSpec {
  const name = virtualPortName(family, n);
  return {
    name,
    short: `${family.short}${n}`,
    kind: 'virtual',
    speedBps: SPEED_1G,
    role: family.role,
    allowedRoles: [family.role],
    encap: family.role === 'svi' || ROLE_TRAITS[family.role].bridged ? 'ethernet' : 'none',
    ordinal: 0,
    connector: 'none',
    defaultAdminUp: family.defaultAdminUp,
  };
}

/** Live state of a new virtual interface: base MAC (ordinal 0), family admin default, operUp false. */
export function createVirtualPortState(family: VirtualFamilySpec, n: number, macBase: number): PortState {
  const spec = virtualPortSpec(family, n);
  return {
    id: spec.name,
    spec,
    mac: portMac(macBase, 0),
    adminUp: family.defaultAdminUp,
    operUp: false,
    mtu: DEFAULT_MTU,
    counters: emptyCounters(),
    l3: {},
    tx: { busyUntil: 0, queue: 0 },
    role: family.role,
    ordinal: 0,
    encap: spec.encap as PortEncap,
  };
}

/** States of every auto virtual instance of `model` (family order, ascending number). */
export function autoVirtualPortStates(model: Pick<DeviceModel, 'virtualFamilies'>, macBase: number): PortState[] {
  const out: PortState[] = [];
  for (const family of model.virtualFamilies ?? []) {
    const numbers = [...(family.auto ?? [])].sort((a, b) => a - b);
    for (const n of numbers) out.push(createVirtualPortState(family, n, macBase));
  }
  return out;
}

/** Outcome of `planVirtualPort`. */
export type VirtualPortPlan =
  | { ok: true; created: false; port: PortId }
  | { ok: true; created: true; port: PortId; family: VirtualFamilySpec; number: number }
  | { ok: false; error: string };

/**
 * Decide what `ensureVirtualPort(name)` must do (§3.10 Create): an existing port → found; a creatable family
 * instance inside its range → create; otherwise an original error. `name` must be canonical
 * (`resolvePortName` returns canonical names). When `capabilities` (the device's EFFECTIVE capabilities: model
 * plus installed modules) are given, an SVI of a family with NO auto instance needs `switching`: that is the
 * router family that comes from a switch module, and it refuses the interface while the module is out. A
 * management family with an auto Vlan1 belongs to a device that already bridges on its own (L2 switch, learning
 * bridge, access point), so it is never gated.
 */
export function planVirtualPort(
  model: Pick<DeviceModel, 'virtualFamilies'>,
  ports: ReadonlyMap<PortId, unknown>,
  name: PortId,
  capabilities?: readonly Capability[],
): VirtualPortPlan {
  if (ports.has(name)) return { ok: true, created: false, port: name };
  const parsed = parseVirtualPortName(model, name);
  if (parsed === undefined) return { ok: false, error: fill(VIRTUAL_PORT_MESSAGES.notCreatable, { name }) };
  const { family, number } = parsed;
  if (number < family.min || number > family.max) {
    return { ok: false, error: fill(VIRTUAL_PORT_MESSAGES.outOfRange, { family: family.family, min: family.min, max: family.max }) };
  }
  if (parsed.name !== name) return { ok: false, error: fill(VIRTUAL_PORT_MESSAGES.notCreatable, { name }) };
  if (family.role === 'svi' && family.auto === undefined && capabilities !== undefined && !capabilities.includes('switching')) {
    return { ok: false, error: VIRTUAL_PORT_MESSAGES.needsSwitchModule };
  }
  return { ok: true, created: true, port: parsed.name, family, number };
}

/**
 * Check `no interface <name>` (§3.10 Remove): only existing, non-auto virtual interfaces may be removed.
 * Returns `{ok:true}` or an original error.
 */
export function checkVirtualPortRemoval(
  model: Pick<DeviceModel, 'virtualFamilies'>,
  ports: ReadonlyMap<PortId, Pick<PortState, 'spec'>>,
  name: PortId,
): { ok: true } | { ok: false; error: string } {
  const port = ports.get(name);
  if (port === undefined) return { ok: false, error: fill(VIRTUAL_PORT_MESSAGES.noSuchInterface, { name }) };
  if (port.spec.kind !== 'virtual') return { ok: false, error: fill(VIRTUAL_PORT_MESSAGES.notVirtual, { name }) };
  const parsed = parseVirtualPortName(model, name);
  if (parsed !== undefined && isAutoInstance(parsed.family, parsed.number)) return { ok: false, error: VIRTUAL_PORT_MESSAGES.builtIn };
  return { ok: true };
}

// ── subinterfaces (P2, D11) ──────────────────────────────────────────────────

/**
 * @since P2 Port spec of subinterface `<parent>.<n>` (ARCHITECTURE-P2 §3.4 step 1): kind `virtual`, role `subif`,
 * encap `ethernet`, the parent's speed and ordinal (so its MAC), connector `none`, administratively up, the parent's
 * MTU, and `parent`. The short name is the parent's short name plus `.<n>`.
 */
export function subinterfacePortSpec(parent: Pick<PortState, 'id' | 'spec' | 'ordinal' | 'mtu'>, n: number): PortSpec {
  return {
    name: subinterfacePortName(parent.id, n),
    short: `${parent.spec.short}.${n}`,
    kind: 'virtual',
    speedBps: parent.spec.speedBps,
    role: 'subif',
    allowedRoles: ['subif'],
    encap: 'ethernet',
    ordinal: parent.ordinal ?? parent.spec.ordinal ?? 0,
    connector: 'none',
    defaultAdminUp: true,
    mtu: parent.mtu,
    parent: parent.id,
  };
}

/**
 * @since P2 Live state of a new subinterface: the parent's MAC and ordinal, administratively up, the parent's MTU,
 * operUp false (the runtime derives it: `subif` rule of `evaluateVirtualOper`), no `dot1q` until
 * `encapsulation dot1Q` sets it.
 */
export function createSubinterfacePortState(parent: Pick<PortState, 'id' | 'spec' | 'ordinal' | 'mtu' | 'mac'>, n: number): PortState {
  const spec = subinterfacePortSpec(parent, n);
  return {
    id: spec.name,
    spec,
    mac: parent.mac,
    adminUp: true,
    operUp: false,
    mtu: parent.mtu,
    counters: emptyCounters(),
    l3: {},
    tx: { busyUntil: 0, queue: 0 },
    role: 'subif',
    ordinal: spec.ordinal as number,
    encap: 'ethernet',
  };
}

/** @since P2 Outcome of `planSubinterface`. */
export type SubinterfacePlan =
  | { ok: true; created: false; port: PortId }
  | { ok: true; created: true; port: PortId; parent: PortId; number: number }
  | { ok: false; error: string };

/**
 * @since P2 Decide what creating subinterface `name` (canonical, `<parent>.<n>`) must do (D11): an existing port →
 * found; otherwise the model must declare `subinterfaces`, the parent must be a live non-virtual port whose effective
 * role is in `subinterfaces.roles`, and n must lie in [1, `subinterfaces.max`]. Errors are original wording.
 */
export function planSubinterface(
  model: Pick<DeviceModel, 'subinterfaces'>,
  ports: ReadonlyMap<PortId, Pick<PortState, 'role' | 'spec'>>,
  name: PortId,
  capabilities?: readonly Capability[],
): SubinterfacePlan {
  if (ports.has(name)) return { ok: true, created: false, port: name };
  const parsed = parseSubinterfaceName(name);
  const spec = model.subinterfaces;
  if (parsed === undefined || spec === undefined) return { ok: false, error: fill(VIRTUAL_PORT_MESSAGES.notCreatable, { name }) };
  const parent = ports.get(parsed.parent);
  if (parent === undefined || parent.spec.kind === 'virtual') return { ok: false, error: fill(VIRTUAL_PORT_MESSAGES.notCreatable, { name }) };
  if (parsed.number < 1 || parsed.number > spec.max) return { ok: false, error: fill(VIRTUAL_PORT_MESSAGES.subinterfaceOutOfRange, { max: spec.max }) };
  const role = parent.role ?? specRole(parent.spec, capabilities);
  if (!spec.roles.includes(role)) return { ok: false, error: fill(VIRTUAL_PORT_MESSAGES.subinterfaceNeedsRoutedParent, { parent: parsed.parent }) };
  if (subinterfacePortName(parsed.parent, parsed.number) !== name) return { ok: false, error: fill(VIRTUAL_PORT_MESSAGES.notCreatable, { name }) };
  return { ok: true, created: true, port: name, parent: parsed.parent, number: parsed.number };
}

/** @since P2 The subinterfaces of `parent` in Map order (ports whose `spec.parent` is `parent`). */
export function subinterfacesOf<P extends Pick<PortState, 'spec'>>(ports: Iterable<P>, parent: PortId): P[] {
  const out: P[] = [];
  for (const p of ports) if (p.spec.parent === parent) out.push(p);
  return out;
}

// ── canonical Map order ──────────────────────────────────────────────────────

/**
 * Sort key of a port: [class, primary, secondary] (P2 subinterfaces: [3, …parent key, n]); compared
 * lexicographically, a shorter key first when one is a prefix of the other.
 */
type OrderKey = readonly number[];

/**
 * Canonical sort key of a port on `model` (see the file header). Fixed ports that are not in `model.ports` sort
 * after the model's fixed ports by ordinal; virtual ports of an unknown family sort last by name order of arrival.
 * A subinterface (P2: `spec.parent` set) sorts after every other port, by its parent's key and then its number;
 * `parentSpec` finds the parent's spec (the runtime passes the live Map; default: the model's fixed ports).
 */
export function canonicalPortKey(
  model: Pick<DeviceModel, 'ports' | 'slots' | 'virtualFamilies'>,
  spec: PortSpec,
  parentSpec?: (id: PortId) => PortSpec | undefined,
): OrderKey {
  if (spec.kind === 'virtual' && spec.parent !== undefined) {
    const parent = parentSpec?.(spec.parent) ?? model.ports.find((p) => p.name === spec.parent);
    const parentKey = parent === undefined || parent.parent !== undefined ? [Number.MAX_SAFE_INTEGER, 0, 0] : canonicalPortKey(model, parent);
    return [3, ...parentKey, parseSubinterfaceName(spec.name)?.number ?? Number.MAX_SAFE_INTEGER];
  }
  if (spec.kind === 'virtual') {
    const parsed = parseVirtualPortName(model, spec.name);
    if (parsed === undefined) return [2, Number.MAX_SAFE_INTEGER, 0];
    return [2, familyIndex(model, parsed.family.family), parsed.number];
  }
  if (spec.module !== undefined) {
    const slotIdx = (model.slots ?? []).findIndex((s) => s.id === spec.slot);
    return [1, slotIdx < 0 ? Number.MAX_SAFE_INTEGER : slotIdx, spec.ordinal ?? 0];
  }
  const idx = model.ports.findIndex((p) => p.name === spec.name);
  return idx >= 0 ? [0, idx, 0] : [0, model.ports.length, spec.ordinal ?? 0];
}

function compareKeys(a: OrderKey, b: OrderKey): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/**
 * Re-insert every entry of `ports` in canonical order, keeping the SAME Map object (process contexts and views
 * alias it). Ties keep their current relative order (stable sort).
 */
export function refillPortMap(ports: Map<PortId, PortState>, model: Pick<DeviceModel, 'ports' | 'slots' | 'virtualFamilies'>): void {
  const parentSpec = (id: PortId): PortSpec | undefined => ports.get(id)?.spec;
  const entries = [...ports.values()].map((state, i) => ({ state, i, key: canonicalPortKey(model, state.spec, parentSpec) }));
  entries.sort((a, b) => compareKeys(a.key, b.key) || a.i - b.i);
  ports.clear();
  for (const e of entries) ports.set(e.state.id, e.state);
}

/** Add `states` to the Map (replacing entries with the same id) and refill it canonically. */
export function insertPorts(ports: Map<PortId, PortState>, model: Pick<DeviceModel, 'ports' | 'slots' | 'virtualFamilies'>, states: readonly PortState[]): void {
  for (const s of states) ports.set(s.id, s);
  refillPortMap(ports, model);
}

/** Remove `ids` from the Map (unknown ids are ignored) and refill it canonically; returns the removed ids in Map order. */
export function removePorts(ports: Map<PortId, PortState>, model: Pick<DeviceModel, 'ports' | 'slots' | 'virtualFamilies'>, ids: readonly PortId[]): PortId[] {
  const removed: PortId[] = [];
  for (const id of [...ports.keys()]) {
    if (ids.includes(id)) {
      ports.delete(id);
      removed.push(id);
    }
  }
  refillPortMap(ports, model);
  return removed;
}

// ── running-config seeding and power-off reset ───────────────────────────────

/**
 * Add the factory interface section of `port` to `ast` (§3.3 step 8, §3.10 Create): one `interface` section for a
 * configurable role, with `shutdown` when the port is administratively down. Non-configurable ports add nothing.
 */
export function seedInterfaceSection(ast: ConfigAst, port: Pick<PortState, 'id' | 'adminUp' | 'role' | 'spec'>, capabilities: readonly Capability[] | undefined): void {
  const role = port.role ?? specRole(port.spec, capabilities);
  if (!ROLE_TRAITS[role].configurable) return;
  ast.set([], ['interface', port.id]);
  if (!port.adminUp) ast.set([['interface', port.id]], ['shutdown']);
}

/** Factory running-config: `hostname`, then one interface section per configurable port in Map order. */
export function seedRunningConfig(ast: ConfigAst, hostname: string, ports: Iterable<Pick<PortState, 'id' | 'adminUp' | 'role' | 'spec'>>, capabilities: readonly Capability[] | undefined): void {
  ast.set([], ['hostname', hostname]);
  for (const port of ports) seedInterfaceSection(ast, port, capabilities);
}

/**
 * Reset one port for power-off (RAM lost, DeviceRuntime.setPower): role and encap back to the spec defaults,
 * admin state to the factory default, empty counters and L3 state, err-disabled cleared. Virtual ports also go
 * oper down (the runtime owns their oper state; `lastChange` is set only when it changed).
 */
export function resetPortForPowerOff(port: PortState, ctx: Pick<PortBuildContext, 'capabilities' | 'portsDefaultUp'>, now: SimTime): void {
  const role = specRole(port.spec, ctx.capabilities);
  port.role = role;
  port.encap = specEncap(port.spec);
  port.adminUp = defaultAdminUpFor(port.spec, role, ctx.portsDefaultUp);
  port.l3 = {};
  port.counters = emptyCounters();
  delete port.errDisabled;
  delete port.dot1q; // P2: runtime state from `encapsulation dot1Q`, replayed from the configuration at the next boot
  if (ROLE_TRAITS[role].virtual && port.operUp) {
    port.operUp = false;
    port.lastChange = now;
  }
}

// ── virtual oper state ───────────────────────────────────────────────────────

/**
 * Why a virtual port is down (or undefined when up). P2 adds `vlan-missing` (VLAN-aware SVI), `no-bundled-member`
 * (Port-channel), `parent-down` and `no-encapsulation` (subinterface) and `err-disabled` (a virtual port an
 * `errDisable` action named).
 */
export type VirtualDownReason =
  | 'power-off'
  | 'booting'
  | 'admin-down'
  | 'no-bridged-port-up'
  | 'vlan-unsupported'
  | 'vlan-missing'
  | 'no-bundled-member'
  | 'parent-down'
  | 'no-encapsulation'
  | 'err-disabled';

/** Device-level inputs of the virtual oper rule. */
export interface VirtualOperContext {
  readonly power: boolean;
  readonly booted: boolean;
}

/**
 * @since P2 Lookups the runtime injects into the virtual oper rule (ARCHITECTURE-P2 §3.0 "Virtual oper state"; W2
 * device wires them from the `vlans`, `etherchannel`, `stp` and `stp-bridge` rows and `readSwitchport`). Each is
 * optional; without them the P1 rules apply unchanged.
 */
export interface VirtualOperLookups {
  /**
   * VLAN-aware devices only (`isVlanAware(model)`): does VLAN `vlan` exist (1, or a `vlans` row)? Together with
   * `sviCarrier` it switches the SVI rule to the VLAN-aware one for every `Vlan<V>`.
   */
  readonly vlanExists?: (vlan: number) => boolean;
  /**
   * VLAN-aware devices only: does bridged port `port` count for the SVI of `vlan` — not a bundle member other than an
   * `individual` one, carries `vlan` (`carries(port, vlan) !== undefined`), and forwarding in `vlan` when spanning
   * tree runs for it? (Oper up and the bridged role are checked by the rule itself.)
   */
  readonly sviCarrier?: (port: PortId, vlan: number) => boolean;
  /** Member ports whose `etherchannel` row names `bundle` with state `bundled` (Port-channel rule). */
  readonly bundledMembers?: (bundle: PortId) => readonly PortId[];
}

/** The only VLAN served by SVIs in P0.5 (VLANs arrive in P2). */
export const SVI_SUPPORTED_VLAN = 1;

/** @since P2 VLAN number of an SVI name (`Vlan10` → 10), or undefined when the name has no plain number part. */
export function sviVlanOf(name: PortId): number | undefined {
  const m = /^[A-Za-z]+([0-9]+)$/.exec(name);
  if (m === null) return undefined;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * Oper state of a virtual port (§3.10 "Virtual oper state"; ARCHITECTURE-P2 §3.0), from the port set it lives in.
 * Every rule first needs power and a finished boot; every role but `wlan-tunnel` then needs admin up and no
 * err-disable cause (P2):
 *  SVI (role svi)          : P1 — name is Vlan1 && some bridged-role port is operUp (else `vlan-unsupported` /
 *                            `no-bridged-port-up`); VLAN-aware (lookups `vlanExists` and `sviCarrier` injected) — VLAN V
 *                            of `Vlan<V>` exists (else `vlan-missing`) && some operUp bridged-role port E with
 *                            `sviCarrier(E, V)` (else the P1 reason `no-bridged-port-up`, for every VLAN);
 *  loopback (role virtual) : up;
 *  Port-channel (channel)  : some port of `bundledMembers(this)` is operUp (else `no-bundled-member`; no lookup = none);
 *  subinterface (subif)    : the parent (`spec.parent`) exists, is operUp and has the effective role `routed` (else
 *                            `parent-down`), and `dot1q` is set (else `no-encapsulation`);
 *  controller tunnel (wlan-tunnel): up (power and boot only).
 * Non-virtual ports are returned as `{ up: port.operUp }` (the link model owns them).
 */
export function evaluateVirtualOper(
  port: Pick<PortView, 'id' | 'adminUp' | 'operUp' | 'role' | 'spec' | 'errDisabled' | 'dot1q'>,
  ports: Iterable<Pick<PortView, 'operUp' | 'role' | 'spec'>>,
  device: VirtualOperContext,
  capabilities: readonly Capability[] | undefined,
  lookups?: VirtualOperLookups,
): { up: boolean; reason?: VirtualDownReason } {
  const role = port.role ?? specRole(port.spec, capabilities);
  if (!ROLE_TRAITS[role].virtual) return { up: port.operUp };
  if (!device.power) return { up: false, reason: 'power-off' };
  if (!device.booted) return { up: false, reason: 'booting' };
  if (role === 'wlan-tunnel') return { up: true };
  if (!port.adminUp) return { up: false, reason: 'admin-down' };
  if (port.errDisabled !== undefined) return { up: false, reason: 'err-disabled' };
  switch (role) {
    case 'svi':
      return sviOper(port.id, ports, capabilities, lookups);
    case 'channel': {
      const members = lookups?.bundledMembers?.(port.id) ?? [];
      for (const other of ports) if (members.includes(other.spec.name) && other.operUp) return { up: true };
      return { up: false, reason: 'no-bundled-member' };
    }
    case 'subif': {
      let parent: Pick<PortView, 'operUp' | 'role' | 'spec'> | undefined;
      for (const other of ports) if (port.spec.parent !== undefined && other.spec.name === port.spec.parent) parent = other;
      if (parent === undefined || !parent.operUp || (parent.role ?? specRole(parent.spec, capabilities)) !== 'routed') return { up: false, reason: 'parent-down' };
      if (port.dot1q === undefined) return { up: false, reason: 'no-encapsulation' };
      return { up: true };
    }
    default:
      return { up: true };
  }
}

/** The SVI branch of `evaluateVirtualOper` (P1 rule, or the VLAN-aware rule when its two lookups are injected). */
function sviOper(
  id: PortId,
  ports: Iterable<Pick<PortView, 'operUp' | 'role' | 'spec'>>,
  capabilities: readonly Capability[] | undefined,
  lookups: VirtualOperLookups | undefined,
): { up: boolean; reason?: VirtualDownReason } {
  const vlan = sviVlanOf(id);
  const exists = lookups?.vlanExists;
  const carrier = lookups?.sviCarrier;
  if (exists !== undefined && carrier !== undefined) {
    if (vlan === undefined || !exists(vlan)) return { up: false, reason: 'vlan-missing' };
    for (const other of ports) {
      const r = other.role ?? specRole(other.spec, capabilities);
      if (ROLE_TRAITS[r].bridged && other.operUp && carrier(other.spec.name, vlan)) return { up: true };
    }
    return { up: false, reason: 'no-bridged-port-up' };
  }
  if (vlan !== SVI_SUPPORTED_VLAN) return { up: false, reason: 'vlan-unsupported' };
  for (const other of ports) {
    const r = other.role ?? specRole(other.spec, capabilities);
    if (ROLE_TRAITS[r].bridged && other.operUp) return { up: true };
  }
  return { up: false, reason: 'no-bridged-port-up' };
}

/** One virtual port whose oper state changed. */
export interface VirtualOperChange {
  readonly port: PortId;
  readonly operUp: boolean;
  /** Down reason after the change (absent when up). */
  readonly reason?: VirtualDownReason;
}

/**
 * Recompute every virtual port of the Map (Map order), write `operUp` and `lastChange = now` on those that changed
 * and return the changes. The caller emits `portState` per change and fans `onLinkChange` out in model order.
 * `lookups` (@since P2) are passed to every `evaluateVirtualOper` call. Ports are evaluated in Map order against the
 * states already written, so a subinterface sees its parent's current state (physical parents sort first); because a
 * virtual port may depend on another virtual port that sorts after it (an SVI carried only by a Port-channel), the
 * pass repeats until no port changes (at most one extra pass per virtual port) and only the NET changes against the
 * states before the call are reported, in Map order (a port that settles back where it started is no change). In P1
 * every virtual port depends only on physical ports, so a second pass never changes anything there.
 */
export function recomputeVirtualOper(
  ports: ReadonlyMap<PortId, PortState>,
  device: VirtualOperContext,
  capabilities: readonly Capability[] | undefined,
  now: SimTime,
  lookups?: VirtualOperLookups,
): VirtualOperChange[] {
  const all = [...ports.values()];
  const virtual = all.filter((port) => ROLE_TRAITS[port.role ?? specRole(port.spec, capabilities)].virtual);
  const before = new Map<PortId, boolean>();
  const reasons = new Map<PortId, VirtualDownReason | undefined>();
  for (const port of virtual) before.set(port.id, port.operUp);
  for (let pass = 0; pass <= virtual.length; pass++) {
    let changed = false;
    for (const port of virtual) {
      const v = evaluateVirtualOper(port, all, device, capabilities, lookups);
      if (v.up === port.operUp) continue;
      port.operUp = v.up;
      reasons.set(port.id, v.reason);
      changed = true;
    }
    if (!changed) break;
  }
  const changes: VirtualOperChange[] = [];
  for (const port of virtual) {
    if (port.operUp === before.get(port.id)) continue;
    port.lastChange = now;
    const reason = reasons.get(port.id);
    changes.push(reason === undefined ? { port: port.id, operUp: port.operUp } : { port: port.id, operUp: port.operUp, reason });
  }
  return changes;
}

/** Log message for an SVI that stays down because its VLAN is not available (original wording). */
export function vlanUnsupportedMessage(name: PortId): string {
  return fill(VIRTUAL_PORT_MESSAGES.vlanUnsupported, { name });
}

/** @since P2 Log message for an SVI of a VLAN-aware device whose VLAN does not exist (original wording). */
export function vlanMissingMessage(name: PortId, vlan: number): string {
  return fill(VIRTUAL_PORT_MESSAGES.vlanMissing, { name, vlan });
}
