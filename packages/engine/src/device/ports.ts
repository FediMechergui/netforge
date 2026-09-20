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
 *   3. virtual ports by `model.virtualFamilies` order, then ascending instance number.
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
import { virtualPortName } from './catalog/names.js';

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
 * Parse a CANONICAL virtual interface name (`Vlan10`, `Loopback0`) against the model's families. Undefined when
 * the letters match no family or the number part is not a plain decimal. The range is NOT checked here.
 */
export function parseVirtualPortName(model: Pick<DeviceModel, 'virtualFamilies'>, name: PortId): VirtualPortName | undefined {
  const m = /^([A-Za-z]+)([0-9]+)$/.exec(name);
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
 * SVIs and `none` for loopbacks, ordinal 0 (base MAC), connector `none`, the family's default admin state.
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
    encap: family.role === 'svi' ? 'ethernet' : 'none',
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

// ── canonical Map order ──────────────────────────────────────────────────────

/** Sort key of a port: [class, primary, secondary]; compared lexicographically. */
type OrderKey = readonly [number, number, number];

/**
 * Canonical sort key of a port on `model` (see the file header). Fixed ports that are not in `model.ports` sort
 * after the model's fixed ports by ordinal; virtual ports of an unknown family sort last by name order of arrival.
 */
export function canonicalPortKey(model: Pick<DeviceModel, 'ports' | 'slots' | 'virtualFamilies'>, spec: PortSpec): OrderKey {
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
  for (let i = 0; i < 3; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Re-insert every entry of `ports` in canonical order, keeping the SAME Map object (process contexts and views
 * alias it). Ties keep their current relative order (stable sort).
 */
export function refillPortMap(ports: Map<PortId, PortState>, model: Pick<DeviceModel, 'ports' | 'slots' | 'virtualFamilies'>): void {
  const entries = [...ports.values()].map((state, i) => ({ state, i, key: canonicalPortKey(model, state.spec) }));
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
  if (ROLE_TRAITS[role].virtual && port.operUp) {
    port.operUp = false;
    port.lastChange = now;
  }
}

// ── virtual oper state ───────────────────────────────────────────────────────

/** Why a virtual port is down (or undefined when up). */
export type VirtualDownReason = 'power-off' | 'booting' | 'admin-down' | 'no-bridged-port-up' | 'vlan-unsupported';

/** Device-level inputs of the virtual oper rule. */
export interface VirtualOperContext {
  readonly power: boolean;
  readonly booted: boolean;
}

/** The only VLAN served by SVIs in P0.5 (VLANs arrive in P2). */
export const SVI_SUPPORTED_VLAN = 1;

/**
 * Oper state of a virtual port (§3.10 "Virtual oper state"), from the port set it lives in:
 *  SVI (role svi)        : power && booted && adminUp && name is Vlan1 && some bridged-role port is operUp;
 *  loopback (role virtual): power && booted && adminUp.
 * Non-virtual ports are returned as `{ up: port.operUp }` (the link model owns them).
 */
export function evaluateVirtualOper(
  port: Pick<PortView, 'id' | 'adminUp' | 'operUp' | 'role' | 'spec'>,
  ports: Iterable<Pick<PortView, 'operUp' | 'role' | 'spec'>>,
  device: VirtualOperContext,
  capabilities: readonly Capability[] | undefined,
): { up: boolean; reason?: VirtualDownReason } {
  const role = port.role ?? specRole(port.spec, capabilities);
  if (!ROLE_TRAITS[role].virtual) return { up: port.operUp };
  if (!device.power) return { up: false, reason: 'power-off' };
  if (!device.booted) return { up: false, reason: 'booting' };
  if (!port.adminUp) return { up: false, reason: 'admin-down' };
  if (role !== 'svi') return { up: true };
  const m = /^[A-Za-z]+([0-9]+)$/.exec(port.id);
  if (m === null || Number(m[1]) !== SVI_SUPPORTED_VLAN) return { up: false, reason: 'vlan-unsupported' };
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
 */
export function recomputeVirtualOper(
  ports: ReadonlyMap<PortId, PortState>,
  device: VirtualOperContext,
  capabilities: readonly Capability[] | undefined,
  now: SimTime,
): VirtualOperChange[] {
  const changes: VirtualOperChange[] = [];
  const all = [...ports.values()];
  for (const port of all) {
    const role = port.role ?? specRole(port.spec, capabilities);
    if (!ROLE_TRAITS[role].virtual) continue;
    const v = evaluateVirtualOper(port, all, device, capabilities);
    if (v.up === port.operUp) continue;
    port.operUp = v.up;
    port.lastChange = now;
    changes.push(v.reason === undefined ? { port: port.id, operUp: v.up } : { port: port.id, operUp: v.up, reason: v.reason });
  }
  return changes;
}

/** Log message for an SVI that stays down because its VLAN is not available (original wording). */
export function vlanUnsupportedMessage(name: PortId): string {
  return fill(VIRTUAL_PORT_MESSAGES.vlanUnsupported, { name });
}
