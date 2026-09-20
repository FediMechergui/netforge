/**
 * device/device.ts — the live device runtime (spec §4.4 device/port/storage model, §4.8 process
 * model, §7.4 startup/running config; ARCHITECTURE "Frame arrival pipeline", "Sending",
 * "Config flow"; ARCHITECTURE-P1 D2, D3, D6, D7, D8, §3.1–§3.3, §3.10, §3.11).
 *
 * Responsibilities:
 *  - ports (D7, D8): built in canonical order — fixed ports (model order), module ports (slot order, ordinal
 *    128 + slot×16 + i), auto virtual interfaces (family order) — with stable MACs
 *    `portMac(deviceMacBase(spec.id, spec.macSalt), ordinal)` (virtual ports use the base MAC, ordinal 0). The
 *    port Map object never changes identity; it is refilled in place when modules or virtual ports change.
 *  - hardware (D7, §3.11): `insertModule` / `removeModule` only while powered off, with checks in the order
 *    slot → module → fit → power → occupancy and the HARDWARE_MESSAGES wording. Modules contribute ports (or a
 *    cage transceiver) and capabilities; the effective capability set adds daemons and tables at the next boot.
 *  - storage: `running` (RAM, a `ConfigAst`, lost on power-off/reload) and `startup` (NVRAM, kept until
 *    `erase startup-config`);
 *  - power/boot: power-on schedules a `boot` event after `model.bootNs`; `onBoot` instantiates the daemons,
 *    builds the demux index, replays the configuration through `applyConfigLine` (cli/config-text replay lines, so
 *    every process receives its `ConfigDelta`s and virtual interfaces are created on the way), calls `init`,
 *    marks the device booted, lets the link model bring the ports up and recomputes virtual oper state;
 *  - the frame pipeline v2 (§3.1): counters → `frameArrivalVerdict` (device/pipeline.ts: admin, receive gate,
 *    err-disabled, role frames trait, collision/fragment, encapsulation, FCS/runt/giant, MAC filter by role, demux
 *    by role and outer layer) → `applyActions`;
 *  - egress (§3.2) by the role's egress trait: `link` → `deps.transmit`; `owner` → `model.portOwners[role]`'s
 *    `onEgress`; `loop` → counted and re-entered through the `ingress` action;
 *  - `applyActions`: depth-first application of process actions with a 1000-action budget per top-level call
 *    (send/deliver/request/drop/consume/timer/cancelTimer/cliOutput/cliDone/setPortL3/log/ingress/medium/event);
 *    `setPortL3` merges per member (`mergePortL3`; undefined keeps, a value replaces, null clears)
 *    and `event` hands a ProcessEvent to the target's `onEvent` depth-first (a missing target is a runtime debug line);
 *  - timers: a `(process,key) → {seq, at}` map; re-arming cancels the previous event and a fired event that no
 *    longer matches the map is ignored;
 *  - config flow: `applyConfigLine` → runtime special cases (virtual interface create/remove, `switchport`
 *    role flips, `encapsulation`, `hostname`, `shutdown`) → AST set/unset → fan the delta out to every process in
 *    daemon order, then apply all collected actions → `configChange` trace → `deps.onPortPhyConfig` for
 *    PHY- and radio-relevant lines;
 *  - virtual interfaces (§3.10): created from `interface Vlan<n>` / `Loopback<n>`, removed by `no interface`,
 *    oper state owned here (never reported to the link model);
 *  - tables (P1): the declared set is cam, arp, rib plus every extra table of the model and of the effective daemons
 *    (PROCESS_TABLES: rib6, nd, sockets, dhcp-bindings, dns-cache, dot11-assoc), reached with `tables.get(name)` and
 *    exported by the snapshot as `tables.extra` in declared order;
 *  - PHY and radio settings rendered from running-config for the link model (`phySettings`, `radioSettings`),
 *    deferred transmit outcomes (`onTxOutcome`) and medium notifications (`onMediumEvent`).
 *
 * Power-off semantics (RAM is lost, NVRAM survives): every daemon's `onShutdown` runs first (its actions apply while the
 * ports are still up; P1), then tables are cleared (declared order), processes and timers
 * dropped, virtual interfaces other than the auto ones removed, roles/encapsulations/admin state/counters/L3
 * state reset to the factory defaults and the running-config reset to hostname = spec.name plus one interface
 * section per configurable port (`shutdown` when it defaults down). Installed modules are hardware and stay.
 *
 * `now` inside the runtime is the `at` of the event being dispatched (never a wall clock); device-level
 * operations that take no time argument (`applyConfigLine`, `saveConfig`) use the most recent dispatched time.
 * Iteration that affects behaviour runs over the port Map (canonical order) and the daemon order array.
 */
import { deviceMacBase } from '../contracts/addr.js';
import {
  HARDWARE_MESSAGES,
  PROCESS_ORDER,
  ROLE_KINDS,
  ROLE_TRAITS,
  SLOT_ACCEPTS,
  expandCapabilities,
  type Capability,
  type HardwareErrorCode,
  type HardwareResult,
  type ModuleModel,
  type ModuleType,
  type PortRole,
  type SlotId,
  type SlotSpec,
} from '../contracts/catalog.js';
import { CLI_MESSAGES } from '../contracts/cli.js';
import type { ConfigAst, ConfigDelta, ConfigNode } from '../contracts/config.js';
import type { DeviceModel, DeviceRuntime, DeviceRuntimeDeps, DeviceSpec, PortResolution } from '../contracts/device.js';
import type { DeviceId, PortId, ProcessName } from '../contracts/ids.js';
import type { DropReason, FrameRxInfo, PortPhySettings, TxOutcome } from '../contracts/link.js';
import type { AirView, MediumEvent } from '../contracts/medium.js';
import type { Pdu, PduFactory } from '../contracts/pdu.js';
import type { Ipv6PortAddress, PortIpv4Address, PortL3, PortState, PortView } from '../contracts/port.js';
import type { Action, DebugEvent, DemuxLayer, Process, ProcessCtx, StateView } from '../contracts/process.js';
import { CHANNELS, type ChannelWidthMhz, type RadioSettings, type RfBand, type WifiSecurity } from '../contracts/rf.js';
import type { DeviceTables, Table, TableFactory, TableName, TableRow } from '../contracts/tables.js';
import type { SimTime } from '../contracts/time.js';
import type { TraceEvent, TraceSink } from '../contracts/trace.js';
import { createConfigAst, parseConfigText } from '../cli/config-ast.js';
import { normalizeIpv6 } from '../core/addr6.js';
import { configTextLinesOf } from '../cli/config-text.js';
import { CATALOG_STAGE } from './catalog/index.js';
import { deriveProcesses, deriveTables, modulePortSpecs } from './catalog/define.js';
import { resolvePortName } from './catalog/names.js';
import {
  buildDemuxIndex,
  countIngress,
  effectivePortRole,
  frameArrivalVerdict,
  ingressVerdict,
  loopIngressLayer,
  type DemuxIndex,
  type FrameVerdict,
} from './pipeline.js';
import {
  SVI_SUPPORTED_VLAN,
  autoVirtualPortStates,
  checkVirtualPortRemoval,
  createPortState,
  createVirtualPortState,
  fixedPortStates,
  insertPorts,
  isAutoInstance,
  parseVirtualPortName,
  planVirtualPort,
  recomputeVirtualOper,
  removePorts,
  resetPortForPowerOff,
  seedInterfaceSection,
  seedRunningConfig,
  specEncap,
  specRole,
  vlanUnsupportedMessage,
  type PortBuildContext,
} from './ports.js';
import { createProcessCtx, pduSummary, type ProcessHost } from './process-ctx.js';

/** Maximum number of actions applied per top-level `applyActions` call. */
export const ACTION_BUDGET = 1000;

/** Debug events retained per process. */
export const DEBUG_RING_CAPACITY = 200;

/** Syslog facility used for admin-state changes. */
const FACILITY_LINK = 'LINK';

/** Syslog facility used for runtime/system messages. */
const FACILITY_SYS = 'SYS';

/**
 * Interface config keys whose change the link model must see (`DeviceRuntimeDeps.onPortPhyConfig`): speed,
 * duplex, clock rate, encapsulation, keepalive, the radio lines and switchport (§3.4 triggers).
 */
export const PHY_CONFIG_KEYS: readonly string[] = Object.freeze([
  'speed',
  'duplex',
  'clock',
  'encapsulation',
  'keepalive',
  'ssid',
  'security',
  'passphrase',
  'band',
  'channel',
  'channel-width',
  'tx-power',
  'peer-key',
  'beacons',
  'switchport',
]);

/** Original wording of the runtime's own config refusals (§1.6). */
export const DEVICE_CONFIG_MESSAGES = Object.freeze({
  /** `encapsulation ppp` (D6: PPP is reserved). */
  pppUnavailable: 'PPP encapsulation is not available in this release. Serial interfaces use HDLC.',
  /** `encapsulation <other>`. */
  encapsulationUnknown: 'Encapsulation {encap} is not supported on this interface.',
  /** `encapsulation …` on a port that is not a serial interface. */
  encapsulationNotSerial: 'Encapsulation can only be changed on serial interfaces.',
  /** `setPortRole` on a port the device does not have. */
  unknownInterface: 'Unknown interface {name}',
});

/** Link-layer port kinds that carry a radio (ctx.air is offered only to devices with one). */
const RADIO_KINDS: readonly string[] = Object.freeze(['wlan', 'radio', 'cellular']);

/** Valid `security` values. */
const WIFI_SECURITIES: readonly WifiSecurity[] = Object.freeze(['open', 'wpa2-psk', 'wpa3-sae']);

/** Valid `channel-width` values below 60 GHz. */
const CHANNEL_WIDTHS: readonly ChannelWidthMhz[] = Object.freeze([20, 40, 80, 160]);

/** `speed <n>` values are megabits per second. */
const MBPS = 1_000_000;

/** Timer map key. */
const timerKey = (process: ProcessName, key: string): string => `${process}\0${key}`;

/** Fill `{key}` placeholders of a message template. */
function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  let out = template;
  for (const key of Object.keys(values)) out = out.split(`{${key}}`).join(String(values[key]));
  return out;
}

/** One pending action and the process it was returned by. */
interface PendingAction {
  process: ProcessName;
  action: Action;
}

/**
 * The pdu still in hand in an action, if any (for budget-exhaustion drops): the pdu of send/deliver/drop/consume/
 * ingress, the packet a send request carries (`arp.sendVia`, `ipv4.send`, `ipv6.send`, `nd.sendVia`) and the quoted
 * original of an ICMP error request (`icmp.error`, `icmp6.error`). Socket requests carry payloads, not pdus, and the
 * pdus inside ProcessEvents were already consumed, so neither is dropped again.
 */
export function pduOf(a: Action): Pdu | undefined {
  switch (a.type) {
    case 'send':
    case 'deliver':
    case 'drop':
    case 'consume':
    case 'ingress':
      return a.pdu;
    case 'request': {
      const req = a.req;
      if (req.kind === 'arp.sendVia' || req.kind === 'ipv4.send' || req.kind === 'ipv6.send' || req.kind === 'nd.sendVia') return req.pdu;
      if (req.kind === 'icmp.error' || req.kind === 'icmp6.error') return req.original;
      return undefined;
    }
    default:
      return undefined;
  }
}

/** A `setPortL3` action (the L3 write path of ipv4 and ipv6). */
export type SetPortL3Action = Extract<Action, { type: 'setPortL3' }>;

/**
 * Apply a `setPortL3` action to a port's derived L3 state and return the new state object (the input is not
 * modified). MERGE per member: undefined = unchanged, null = clear, value = replace that member with a copy
 * (IPv6 address texts and groups are normalised to RFC 5952; unparsable texts are kept as given).
 * An action carrying none of the four members is a no-op (the P0 member-less "clear ipv4" form was deleted at
 * the P1 exit gate, §0 rule 2; ipv4 sends `ipv4: null` instead).
 * Optional `ipv4` fields (`origin`, `leaseExpiresAt`) are copied only when set, so P0 snapshots keep their bytes.
 */
export function mergePortL3(current: Readonly<PortL3>, a: SetPortL3Action): PortL3 {
  const out: PortL3 = {};

  const ipv4 = a.ipv4;
  if (ipv4 === undefined) {
    if (current.ipv4 !== undefined) out.ipv4 = current.ipv4;
  } else if (ipv4 !== null) {
    const v4: PortIpv4Address = { address: ipv4.address, prefixLen: ipv4.prefixLen };
    if (ipv4.origin !== undefined) v4.origin = ipv4.origin;
    if (ipv4.leaseExpiresAt !== undefined) v4.leaseExpiresAt = ipv4.leaseExpiresAt;
    out.ipv4 = v4;
  }

  if (a.ipv6 === undefined) {
    if (current.ipv6 !== undefined) out.ipv6 = current.ipv6;
  } else if (a.ipv6 !== null) {
    out.ipv6 = a.ipv6.map((addr): Ipv6PortAddress => ({ ...addr, address: normalizeIpv6(addr.address) ?? addr.address }));
  }

  if (a.ipv6Enabled === undefined) {
    if (current.ipv6Enabled !== undefined) out.ipv6Enabled = current.ipv6Enabled;
  } else if (a.ipv6Enabled !== null) {
    out.ipv6Enabled = a.ipv6Enabled;
  }

  if (a.groups6 === undefined) {
    if (current.groups6 !== undefined) out.groups6 = current.groups6;
  } else if (a.groups6 !== null) {
    out.groups6 = a.groups6.map((g) => normalizeIpv6(g) ?? g);
  }
  return out;
}

// ── tables v2 ─────────────────────────────────────────────────────────────────

/** `DeviceTables` whose optional P0.5 members are always present, plus the runtime's resync hook. */
export interface DeviceTableSet extends DeviceTables {
  get<R extends TableRow = TableRow>(name: TableName): Table<R> | undefined;
  names(): readonly TableName[];
  /**
   * Make the declared set equal `names` (cam, arp and rib always stay first): missing tables are created, tables
   * no longer declared are dropped (their rows are gone with the hardware that needed them).
   */
  sync(names: readonly TableName[]): void;
}

/** The three P0 tables every device owns, in their fixed order. */
const BASE_TABLES: readonly TableName[] = Object.freeze(['cam', 'arp', 'rib']);

/** Declared order of a table name list: cam, arp, rib, then the others in first-occurrence order. */
function orderTableNames(names: readonly TableName[]): TableName[] {
  const out: TableName[] = [...BASE_TABLES];
  for (const n of names) if (!out.includes(n)) out.push(n);
  return out;
}

/**
 * Build a device's table set (`DeviceModel.tables` order; cam, arp, rib first) from a `TableFactory`. Used by the
 * runtime and by test fixtures that need a v2 `DeviceTables` with `get`/`names`.
 */
export function createDeviceTables(
  device: DeviceId,
  names: readonly TableName[],
  factory: TableFactory,
  sink: TraceSink,
  now: () => SimTime,
): DeviceTableSet {
  const tables = new Map<TableName, Table<TableRow>>();
  const make = (name: TableName): Table<TableRow> => factory<TableRow>({ name, device, sink, now });
  const sync = (wanted: readonly TableName[]): void => {
    const order = orderTableNames(wanted);
    const kept = new Map<TableName, Table<TableRow>>();
    for (const name of order) kept.set(name, tables.get(name) ?? make(name));
    tables.clear();
    for (const [name, table] of kept) tables.set(name, table);
  };
  sync(names);
  return {
    get cam() {
      return tables.get('cam') as unknown as DeviceTables['cam'];
    },
    get arp() {
      return tables.get('arp') as unknown as DeviceTables['arp'];
    },
    get rib() {
      return tables.get('rib') as unknown as DeviceTables['rib'];
    },
    get<R extends TableRow = TableRow>(name: TableName): Table<R> | undefined {
      return tables.get(name) as Table<R> | undefined;
    },
    names(): readonly TableName[] {
      return [...tables.keys()];
    },
    sync,
  };
}

// ── the runtime ───────────────────────────────────────────────────────────────

class DeviceRuntimeImpl implements DeviceRuntime, ProcessHost {
  readonly id: DeviceId;
  readonly model: DeviceModel;
  readonly spec: DeviceSpec;
  hostname: string;
  power = false;
  bootedAt?: SimTime;
  readonly ports: Map<PortId, PortState> = new Map();
  readonly tables: DeviceTableSet;
  startup?: ConfigAst;
  readonly processes: Map<ProcessName, Process> = new Map();
  readonly macBase: number;

  readonly trace: TraceSink;
  readonly pdus: PduFactory;

  private readonly deps: DeviceRuntimeDeps;
  private runningAst: ConfigAst;
  /** One-shot running-config from `spec.runningConfig`, consumed by the first boot; dropped on power-off. */
  private pendingRunning: ConfigAst | undefined;
  private clock: SimTime;
  private bootSeq: number | undefined;
  private readonly timers = new Map<string, { seq: number; at: SimTime }>();
  private readonly ctxs = new Map<ProcessName, ProcessCtx>();
  /** Per-process debug rings; entries carry an emission sequence so `recentDebug` can merge them in order. */
  private readonly debugRings = new Map<ProcessName, { seq: number; ev: DebugEvent }[]>();
  private debugSeq = 0;
  /** Installed modules, in model slot order. */
  private readonly installed = new Map<SlotId, ModuleType>();
  private effectiveCaps: readonly Capability[];
  /** Daemon order: `model.processes`, plus daemons of module capabilities in PROCESS_ORDER. */
  private processOrder: readonly ProcessName[];
  private demuxIndex: DemuxIndex;
  private version = 0;
  private airResolved = false;
  private airCache: AirView | undefined;

  constructor(spec: DeviceSpec, deps: DeviceRuntimeDeps, now: SimTime) {
    const model = deps.catalog.get(spec.type);
    if (model === undefined) throw new Error(`unknown device type ${spec.type}`);
    this.id = spec.id;
    this.model = model;
    this.spec = spec;
    this.deps = deps;
    this.trace = deps.trace;
    this.pdus = deps.pdus;
    this.clock = now;
    this.hostname = spec.name;
    this.macBase = deviceMacBase(spec.id, spec.macSalt ?? 0);

    // Validate and record the installed modules BEFORE any state is built (readable errors, no partial device).
    for (const install of this.orderInstalls(spec.modules ?? [])) {
      const slot = this.slotSpec(install.slot);
      if (slot === undefined) throw new Error(fill(HARDWARE_MESSAGES['no-such-slot'], { model: model.model, slot: install.slot }));
      const mod = this.moduleModel(install.module);
      if (mod === undefined) throw new Error(fill(HARDWARE_MESSAGES['unknown-module'], { module: install.module }));
      if (!SLOT_ACCEPTS[slot.type].includes(mod.fits)) throw new Error(fill(HARDWARE_MESSAGES['does-not-fit'], { module: mod.model, slotType: slot.type }));
      const occupant = this.installed.get(slot.id);
      if (occupant !== undefined) {
        throw new Error(fill(HARDWARE_MESSAGES['slot-occupied'], { slot: slot.id, module: this.moduleModel(occupant)?.model ?? occupant }));
      }
      this.installed.set(slot.id, mod.type);
    }
    this.effectiveCaps = this.computeCapabilities();
    this.processOrder = this.computeProcessOrder();
    this.demuxIndex = buildDemuxIndex([], new Map());

    const build = this.buildContext();
    const states: PortState[] = fixedPortStates(model, build);
    for (const [slotId, type] of this.installed) {
      const slot = this.slotSpec(slotId) as SlotSpec;
      states.push(...this.moduleStates(slot, this.moduleModel(type) as ModuleModel, build));
    }
    states.push(...autoVirtualPortStates(model, this.macBase));
    insertPorts(this.ports, model, states);
    for (const [slotId, type] of this.installed) this.applyCageTransceiver(slotId, type);

    this.tables = createDeviceTables(spec.id, this.computeTableNames(), deps.tables, deps.trace, () => this.clock);

    this.runningAst = this.freshRunning();
    if (spec.startupConfig !== undefined) this.startup = parseConfigText(spec.startupConfig);
    if (spec.runningConfig !== undefined && spec.power) this.pendingRunning = parseConfigText(spec.runningConfig);

    if (spec.power) this.setPower(true, now);
  }

  // ── ProcessHost ─────────────────────────────────────────────────────────

  get now(): SimTime {
    return this.clock;
  }

  get running(): ConfigAst {
    return this.runningAst;
  }

  /** Effective capabilities: model capabilities plus those added by installed modules (CAPABILITIES order). */
  get capabilities(): readonly Capability[] {
    return this.effectiveCaps;
  }

  /** RF view for daemons: resolved once per power cycle, only for devices with a radio port. */
  get air(): AirView | undefined {
    if (!this.airResolved) {
      this.airResolved = true;
      let radio = false;
      for (const p of this.ports.values()) if (RADIO_KINDS.includes(p.spec.kind)) radio = true;
      this.airCache = radio ? this.deps.airView(this.id) : undefined;
    }
    return this.airCache;
  }

  recordDebug(ev: DebugEvent): void {
    let ring = this.debugRings.get(ev.process);
    if (ring === undefined) {
      ring = [];
      this.debugRings.set(ev.process, ring);
    }
    ring.push({ seq: this.debugSeq++, ev });
    if (ring.length > DEBUG_RING_CAPACITY) ring.splice(0, ring.length - DEBUG_RING_CAPACITY);
  }

  // ── accessors ───────────────────────────────────────────────────────────

  /** Installed modules by slot, in model slot order. */
  get modules(): ReadonlyMap<SlotId, ModuleType> {
    return this.installed;
  }

  /** Bumped whenever the port set or an effective role changes. */
  get portsVersion(): number {
    return this.version;
  }

  port(id: PortId): PortState | undefined {
    return this.ports.get(id);
  }

  portView(id: PortId): PortView | undefined {
    return this.ports.get(id);
  }

  stateSnapshots(): StateView[] {
    const out: StateView[] = [];
    for (const name of this.processOrder) {
      const p = this.processes.get(name);
      if (p !== undefined) out.push(p.stateSnapshot());
    }
    return out;
  }

  recentDebug(limit = 50): DebugEvent[] {
    const all: { seq: number; ev: DebugEvent }[] = [];
    for (const ring of this.debugRings.values()) for (const e of ring) all.push(e);
    all.sort((a, b) => a.seq - b.seq); // emission order across processes
    const tail = limit >= all.length ? all : all.slice(all.length - Math.max(0, limit));
    return tail.map((e) => e.ev);
  }

  uptime(now: SimTime): SimTime {
    return this.bootedAt === undefined ? 0 : Math.max(0, now - this.bootedAt);
  }

  resolvePortName(name: string): PortResolution {
    return resolvePortName({ model: this.model, ports: this.ports }, name);
  }

  // ── run-loop entry points ───────────────────────────────────────────────

  onFrameArrival(portId: PortId, pdu: Pdu, corrupted: boolean | undefined, now: SimTime, rx?: FrameRxInfo): void {
    this.clock = now;
    const port = this.ports.get(portId);
    if (port === undefined) return;
    this.trace.emit({ t: now, kind: 'frameRx', pdu: pduSummary(pdu), device: this.id, port: portId });
    const c = port.counters;
    c.inPackets++;
    c.inBytes += rx?.fragmentBytes ?? pdu.size;
    port.lastInput = now;

    const verdict = frameArrivalVerdict({
      port,
      frame: pdu,
      corrupted,
      rx,
      booted: this.bootedAt !== undefined,
      capabilities: this.effectiveCaps,
      index: this.demuxIndex,
    });
    const next = this.applyVerdict(port, pdu, verdict);
    if (next !== undefined) this.applyActions(next.process, next.actions, now);
  }

  onTimer(process: ProcessName, key: string, now: SimTime): void {
    this.clock = now;
    const k = timerKey(process, key);
    const pending = this.timers.get(k);
    if (pending === undefined || pending.at !== now) return; // stale: re-armed or cancelled
    this.timers.delete(k);
    const p = this.processes.get(process);
    const ctx = this.ctxs.get(process);
    if (p === undefined || ctx === undefined) return;
    this.applyActions(process, p.onTimer(ctx, key), now);
  }

  onBoot(now: SimTime): void {
    this.clock = now;
    this.bootSeq = undefined;
    if (!this.power || this.bootedAt !== undefined) return;

    // 1. instantiate processes so they receive every config delta; the demux index follows the instances
    for (const name of this.processOrder) {
      const factory = this.deps.catalog.process(name);
      if (factory === undefined) {
        this.trace.emit({ t: now, kind: 'log', device: this.id, severity: 3, facility: FACILITY_SYS, message: `Process ${name} is not available on this platform` });
        continue;
      }
      const proc = factory();
      this.processes.set(name, proc);
      this.ctxs.set(name, createProcessCtx(this, name, this.deps.rng.split(`process:${name}`)));
    }
    this.demuxIndex = buildDemuxIndex(this.processOrder, this.processes);

    // 2. load configuration: model defaults, then the startup-config from NVRAM — or, on the
    //    first boot of a device restored from a saved project, its saved running-config
    if (this.model.defaultConfig !== undefined && this.model.defaultConfig.length > 0) {
      this.replayConfig(parseConfigText(this.model.defaultConfig.join('\n')));
    }
    const initial = this.pendingRunning ?? this.startup;
    this.pendingRunning = undefined;
    if (initial !== undefined) this.replayConfig(initial);

    // 3. init (after config is loaded)
    for (const name of this.processOrder) {
      const p = this.processes.get(name);
      const ctx = this.ctxs.get(name);
      if (p === undefined || ctx === undefined || p.init === undefined) continue;
      this.applyActions(name, p.init(ctx), now);
    }

    // 4. booted; let the link model bring the physical ports up, then derive virtual oper state
    this.bootedAt = now;
    this.trace.emit({ t: now, kind: 'deviceState', device: this.id, power: true, booted: true });
    for (const port of [...this.ports.values()]) {
      if (this.isVirtual(port)) continue;
      this.deps.onPortAdmin({ device: this.id, port: port.id }, port.adminUp, now);
    }
    this.recomputeVirtual(now);
  }

  onPortOper(portId: PortId, operUp: boolean, now: SimTime): void {
    this.clock = now;
    if (!this.ports.has(portId)) return;
    this.fanLinkChange(portId, operUp, now);
    this.recomputeVirtual(now);
  }

  onTxOutcome(portId: PortId, outcome: TxOutcome, now: SimTime): void {
    this.clock = now;
    const port = this.ports.get(portId);
    if (port === undefined) return;
    const c = port.counters;
    switch (outcome.kind) {
      case 'sent':
        c.outPackets++;
        c.outBytes += outcome.bytes;
        port.lastOutput = outcome.txStart;
        return;
      case 'deferred':
        c.deferred = (c.deferred ?? 0) + 1;
        return;
      case 'collision':
        c.collisions++;
        if (outcome.late) c.lateCollisions = (c.lateCollisions ?? 0) + 1;
        return;
      case 'dropped':
        c.outDrops++;
        if (outcome.reason === 'excessive-collisions') c.excessiveCollisions = (c.excessiveCollisions ?? 0) + 1;
        return;
      case 'repeated':
        if (outcome.dir === 'in') {
          c.inPackets++;
          c.inBytes += outcome.bytes;
          port.lastInput = now;
        } else {
          c.outPackets++;
          c.outBytes += outcome.bytes;
          port.lastOutput = now;
        }
        return;
    }
  }

  onMediumEvent(portId: PortId, ev: MediumEvent, now: SimTime): void {
    this.clock = now;
    if (!this.ports.has(portId)) return;
    for (const name of this.processOrder) {
      const p = this.processes.get(name);
      const ctx = this.ctxs.get(name);
      if (p === undefined || ctx === undefined || p.onMediumEvent === undefined) continue;
      this.applyActions(name, p.onMediumEvent(ctx, portId, ev), now);
    }
  }

  applyActions(process: ProcessName, actions: Action[], now: SimTime): void {
    this.clock = now;
    const stack: PendingAction[] = [];
    for (let i = actions.length - 1; i >= 0; i--) stack.push({ process, action: actions[i] as Action });
    let budget = ACTION_BUDGET;

    while (stack.length > 0) {
      if (budget === 0) {
        // exhausted: drop every pdu still in hand and stop
        while (stack.length > 0) {
          const left = stack.pop() as PendingAction;
          const pdu = pduOf(left.action);
          if (pdu !== undefined) this.emitDrop(pdu, 'other', 'action-budget', undefined);
        }
        return;
      }
      budget--;
      const { process: owner, action } = stack.pop() as PendingAction;
      const more = this.applyOne(owner, action, now);
      if (more !== undefined) {
        for (let i = more.actions.length - 1; i >= 0; i--) stack.push({ process: more.process, action: more.actions[i] as Action });
      }
    }
  }

  /** Apply one action; returns follow-up actions (deliver/request/egress/ingress) to push, or undefined. */
  private applyOne(owner: ProcessName, a: Action, now: SimTime): { process: ProcessName; actions: Action[] } | undefined {
    switch (a.type) {
      case 'send':
        return this.applySend(owner, a.port, a.pdu, now);
      case 'deliver': {
        const target = this.processes.get(a.to);
        const ctx = this.ctxs.get(a.to);
        if (target === undefined || ctx === undefined) {
          this.emitDrop(a.pdu, 'unsupported-protocol', `no process ${a.to}`, a.port);
          return undefined;
        }
        return { process: a.to, actions: target.onPdu(ctx, a.pdu, a.port) };
      }
      case 'request': {
        const target = this.processes.get(a.to);
        const ctx = this.ctxs.get(a.to);
        if (target === undefined || ctx === undefined || target.onRequest === undefined) {
          this.runtimeDebug(owner, `request ${a.req.kind} ignored: no process ${a.to}`, now);
          return undefined;
        }
        return { process: a.to, actions: target.onRequest(ctx, a.req) };
      }
      case 'drop':
        this.emitDrop(a.pdu, a.reason, a.detail, a.port);
        return undefined;
      case 'consume':
        this.trace.emit({ t: now, kind: 'pduConsumed', pdu: pduSummary(a.pdu), device: this.id, process: owner });
        return undefined;
      case 'timer': {
        const k = timerKey(owner, a.key);
        const prev = this.timers.get(k);
        if (prev !== undefined) this.deps.scheduler.cancel(prev.seq);
        const at = now + Math.max(0, Math.round(a.delay));
        const seq = this.deps.scheduler.schedule(
          at,
          a.periodic === true
            ? { kind: 'timer', device: this.id, process: owner, key: a.key, periodic: true }
            : { kind: 'timer', device: this.id, process: owner, key: a.key },
        );
        this.timers.set(k, { seq, at });
        return undefined;
      }
      case 'cancelTimer': {
        const k = timerKey(owner, a.key);
        const prev = this.timers.get(k);
        if (prev !== undefined) {
          this.deps.scheduler.cancel(prev.seq);
          this.timers.delete(k);
        }
        return undefined;
      }
      case 'cliOutput':
        this.deps.cliSink.output(a.session, a.text, now);
        return undefined;
      case 'cliDone':
        this.deps.cliSink.done(a.session, now);
        return undefined;
      case 'setPortL3': {
        const port = this.ports.get(a.port);
        if (port !== undefined) port.l3 = mergePortL3(port.l3, a);
        return undefined;
      }
      case 'log':
        this.trace.emit({ t: now, kind: 'log', device: this.id, severity: a.severity, facility: a.facility, message: a.message });
        return undefined;
      case 'ingress':
        return this.applyIngress(a.port, a.pdu, a.layer, now);
      case 'medium': {
        if (!this.ports.has(a.port)) {
          this.runtimeDebug(owner, `medium request ${a.op.op} on ${a.port} ignored: no medium`, now);
          return undefined;
        }
        this.deps.mediumOp({ device: this.id, port: a.port }, a.op, now);
        return undefined;
      }
      case 'event': {
        // depth-first like `request`; a missing target (or one without onEvent) is only a runtime debug line
        const target = this.processes.get(a.to);
        const ctx = this.ctxs.get(a.to);
        if (target === undefined || ctx === undefined || target.onEvent === undefined) {
          this.runtimeDebug(owner, `event ${a.ev.kind} ignored: no process ${a.to}`, now);
          return undefined;
        }
        return { process: a.to, actions: target.onEvent(ctx, a.ev) };
      }
      default:
        return undefined;
    }
  }

  /** §3.2 egress by the role's egress trait. */
  private applySend(owner: ProcessName, portId: PortId, pdu: Pdu, now: SimTime): { process: ProcessName; actions: Action[] } | undefined {
    const port = this.ports.get(portId);
    if (port === undefined) {
      this.emitDrop(pdu, 'other', `unknown-port:${portId}`, undefined);
      return undefined;
    }
    const role = effectivePortRole(port, this.effectiveCaps);
    const egress = ROLE_TRAITS[role].egress;
    if (egress === 'owner') {
      const ownerName = this.model.portOwners?.[role];
      if (ownerName === undefined) {
        this.emitDrop(pdu, 'other', `no-owner:${role}`, portId);
        return undefined;
      }
      if (ownerName === owner) {
        this.emitDrop(pdu, 'other', 'virtual-transmit', portId);
        return undefined;
      }
      const proc = this.processes.get(ownerName);
      const ctx = this.ctxs.get(ownerName);
      if (proc === undefined || ctx === undefined || proc.onEgress === undefined) {
        this.emitDrop(pdu, 'other', `no-owner:${role}`, portId);
        return undefined;
      }
      this.countOut(port, pdu.size, now);
      return { process: ownerName, actions: proc.onEgress(ctx, pdu, portId) };
    }
    if (egress === 'loop') {
      this.countOut(port, pdu.size, now);
      return { process: owner, actions: [{ type: 'ingress', port: portId, pdu, layer: loopIngressLayer(pdu) }] };
    }
    // Read the size before transmit: the air medium rewraps the pdu in place (Ethernet -> 802.11), and outBytes
    // counts the frame as the port handed it over, matching inBytes on the receive side.
    const bytes = pdu.size;
    const res = this.deps.transmit({ device: this.id, port: portId }, pdu, now);
    if (res.ok) {
      // Deferred (segment media): counters arrive later through onTxOutcome.
      if (res.deferred !== true) {
        port.counters.outPackets++;
        port.counters.outBytes += bytes;
        port.lastOutput = res.txStart;
        if (res.retries !== undefined && res.retries > 0) port.counters.txRetries = (port.counters.txRetries ?? 0) + res.retries;
      }
    } else {
      port.counters.outDrops++;
    }
    return undefined;
  }

  /** The `ingress` action (§3.1 last paragraph): steps 11–15 on `portId` starting at `layer`. */
  private applyIngress(portId: PortId, pdu: Pdu, layer: DemuxLayer | undefined, now: SimTime): { process: ProcessName; actions: Action[] } | undefined {
    const port = this.ports.get(portId);
    if (port === undefined) {
      this.emitDrop(pdu, 'other', `unknown-port:${portId}`, undefined);
      return undefined;
    }
    if (this.isVirtual(port)) {
      port.counters.inPackets++;
      port.counters.inBytes += pdu.size;
      port.lastInput = now;
    }
    const verdict = ingressVerdict({ port, frame: pdu, layer, capabilities: this.effectiveCaps, index: this.demuxIndex });
    return this.applyVerdict(port, pdu, verdict);
  }

  /** Count a verdict's receive counters, then emit its drop or return the target's onPdu actions. */
  private applyVerdict(port: PortState, pdu: Pdu, verdict: FrameVerdict): { process: ProcessName; actions: Action[] } | undefined {
    countIngress(port.counters, verdict.counters);
    if (verdict.kind === 'drop') {
      this.emitDrop(pdu, verdict.reason, verdict.detail, port.id);
      return undefined;
    }
    const target = this.processes.get(verdict.process);
    const ctx = this.ctxs.get(verdict.process);
    if (target === undefined || ctx === undefined) {
      port.counters.inDrops++;
      this.emitDrop(pdu, 'unsupported-protocol', `no process ${verdict.process}`, port.id);
      return undefined;
    }
    return { process: verdict.process, actions: target.onPdu(ctx, pdu, port.id) };
  }

  private countOut(port: PortState, bytes: number, now: SimTime): void {
    port.counters.outPackets++;
    port.counters.outBytes += bytes;
    port.lastOutput = now;
  }

  // ── config ──────────────────────────────────────────────────────────────

  applyConfigLine(context: string[][], line: string[], negate: boolean): { ok: boolean; error?: string } {
    const now = this.clock;
    if (line.length === 0 || line[0] === undefined || line[0] === '') return { ok: false, error: 'Empty configuration line' };
    const first = context[0];
    const key = line[0];
    let ifacePort: PortState | undefined;
    if (first !== undefined && first[0] === 'interface') {
      const name = first[1];
      ifacePort = name === undefined ? undefined : this.ports.get(name);
      if (ifacePort === undefined && name !== undefined && parseVirtualPortName(this.model, name) !== undefined) {
        const made = this.ensureVirtualPort(name, now);
        if (!made.ok) return { ok: false, error: made.error };
        ifacePort = this.ports.get(made.port);
      }
      if (ifacePort === undefined) return { ok: false, error: `Unknown interface ${name ?? ''}`.trimEnd() };
    }

    // global `interface N` / `no interface N`: virtual interface create and remove (§3.10)
    if (context.length === 0 && key === 'interface') {
      const name = line[1];
      if (name === undefined || name === '') return { ok: false, error: 'An interface name is required' };
      if (negate) return this.removeVirtualPort(name, now);
      if (!this.ports.has(name)) {
        if (parseVirtualPortName(this.model, name) === undefined) return { ok: false, error: `Unknown interface ${name}` };
        const made = this.ensureVirtualPort(name, now);
        if (!made.ok) return { ok: false, error: made.error };
      }
    }

    if (key === 'hostname' && !negate && (line[1] === undefined || line[1] === '')) {
      return { ok: false, error: 'A host name is required' };
    }

    // interface special cases decided BEFORE the AST changes
    if (ifacePort !== undefined && key === 'switchport' && line.length === 1) {
      const target: PortRole = negate ? 'routed' : specRole(ifacePort.spec, this.effectiveCaps);
      const flipped = this.setPortRole(ifacePort.id, target, now);
      if (!flipped.ok) return flipped;
    }
    if (ifacePort !== undefined && key === 'encapsulation') {
      const encap = this.checkEncapsulation(ifacePort, negate ? undefined : line[1]);
      if (!encap.ok) return { ok: false, error: encap.error };
      ifacePort.encap = encap.encap;
    }

    let delta = negate ? this.runningAst.unset(context, line) : this.runningAst.set(context, line);
    if (delta === undefined && negate && context.length === 0 && key !== 'hostname') {
      // `no <something>` that removes nothing at global level is kept as a `no` line (round-trip)
      delta = this.runningAst.set([], ['no', ...line]);
    }

    if (key === 'hostname') {
      const name = negate ? this.spec.name : (line[1] as string);
      this.hostname = name;
      if (negate) this.runningAst.set([], ['hostname', this.spec.name]);
    }
    if (key === 'shutdown' && ifacePort !== undefined) {
      this.setPortAdmin(ifacePort.id, negate, now);
    }

    if (delta === undefined) return { ok: true };
    this.fanOutConfig(delta, now);
    this.trace.emit({ t: now, kind: 'configChange', device: this.id, line: line.join(' '), negate, context: context.map((c) => c.slice()) });
    if (ifacePort !== undefined && PHY_CONFIG_KEYS.includes(key) && !this.isVirtual(ifacePort)) {
      this.deps.onPortPhyConfig?.({ device: this.id, port: ifacePort.id }, now);
    }
    return { ok: true };
  }

  /** `encapsulation X` on `port` (undefined value = `no encapsulation`, back to the spec default). */
  private checkEncapsulation(port: PortState, value: string | undefined): { ok: true; encap: NonNullable<PortState['encap']> } | { ok: false; error: string } {
    if (port.spec.kind !== 'serial') return { ok: false, error: DEVICE_CONFIG_MESSAGES.encapsulationNotSerial };
    if (value === undefined) return { ok: true, encap: specEncap(port.spec) };
    if (value === 'hdlc') return { ok: true, encap: 'hdlc' };
    if (value === 'ppp') return { ok: false, error: DEVICE_CONFIG_MESSAGES.pppUnavailable };
    return { ok: false, error: fill(DEVICE_CONFIG_MESSAGES.encapsulationUnknown, { encap: value }) };
  }

  /** Notify every process of `delta` (daemon order), then apply all collected actions in order. */
  private fanOutConfig(delta: ConfigDelta, now: SimTime): void {
    if (this.processes.size === 0) return;
    const collected: { process: ProcessName; actions: Action[] }[] = [];
    for (const name of this.processOrder) {
      const p = this.processes.get(name);
      const ctx = this.ctxs.get(name);
      if (p === undefined || ctx === undefined) continue;
      collected.push({ process: name, actions: p.onConfig(ctx, delta) });
    }
    for (const c of collected) this.applyActions(c.process, c.actions, now);
  }

  /**
   * Replay a stored config tree through `applyConfigLine` (cli/config-text replay lines) so processes see every
   * line. An `interface` section line only makes sure its port exists (creating virtual interfaces); a section
   * naming an interface this device cannot have is logged once and its lines are skipped.
   */
  private replayConfig(ast: ConfigAst): void {
    const skipped: PortId[] = [];
    for (const l of configTextLinesOf(ast.root)) {
      const first = l.context[0];
      if (first !== undefined && first[0] === 'interface') {
        if (skipped.includes(first[1] ?? '')) continue;
        this.applyConfigLine(l.context, l.tokens, l.negate);
        continue;
      }
      if (l.context.length === 0 && l.tokens[0] === 'interface' && !l.negate) {
        const name = l.tokens[1] ?? '';
        if (this.ports.has(name)) continue;
        const made = parseVirtualPortName(this.model, name) !== undefined ? this.ensureVirtualPort(name, this.clock) : undefined;
        if (made === undefined || !made.ok) {
          skipped.push(name);
          this.trace.emit({ t: this.clock, kind: 'log', device: this.id, severity: 4, facility: FACILITY_SYS, message: `Startup configuration refers to an unknown interface ${name}`.trimEnd() });
        }
        continue;
      }
      this.applyConfigLine(l.context, l.tokens, l.negate);
    }
  }

  // ── PHY and radio settings ──────────────────────────────────────────────

  /** The running-config `interface` section of a port, if any. */
  private interfaceNode(port: PortId): ConfigNode | undefined {
    return this.runningAst.root.children.find((n) => n.key === 'interface' && n.args[0] === port);
  }

  phySettings(portId: PortId): PortPhySettings {
    const out: PortPhySettings = { speed: 'auto', duplex: 'auto' };
    const node = this.interfaceNode(portId);
    if (node === undefined) return out;
    for (const child of node.children) {
      const arg = child.args[0];
      if (child.key === 'speed' && arg !== undefined) {
        const mbps = Number(arg);
        if (arg !== 'auto' && Number.isSafeInteger(mbps) && mbps > 0) out.speed = mbps * MBPS;
      } else if (child.key === 'duplex' && (arg === 'full' || arg === 'half' || arg === 'auto')) {
        out.duplex = arg;
      } else if (child.key === 'clock' && arg === 'rate') {
        const bps = Number(child.args[1]);
        if (Number.isSafeInteger(bps) && bps > 0) out.clockRateBps = bps;
      }
    }
    return out;
  }

  radioSettings(portId: PortId): RadioSettings | undefined {
    const port = this.ports.get(portId);
    const radio = port?.spec.radio;
    if (port === undefined || radio === undefined || !RADIO_KINDS.includes(port.spec.kind)) return undefined;
    const lines = new Map<string, string[]>();
    for (const child of this.interfaceNode(portId)?.children ?? []) lines.set(child.key, child.args);
    const text = (key: string): string | undefined => {
      const args = lines.get(key);
      return args === undefined || args.length === 0 ? undefined : args.join(' ');
    };

    const bandArg = text('band');
    const band: RfBand = bandArg !== undefined && (radio.bands as readonly string[]).includes(bandArg) ? (bandArg as RfBand) : radio.defaultBand;
    const channelArg = text('channel');
    let channel: number | 'auto';
    if (channelArg === 'auto') channel = 'auto';
    else if (channelArg !== undefined && Number.isSafeInteger(Number(channelArg))) channel = Number(channelArg);
    else if (band === radio.defaultBand) channel = radio.defaultChannel;
    else channel = band === 'cell' ? radio.defaultChannel : (CHANNELS[band][0] ?? radio.defaultChannel);
    let widthMhz: ChannelWidthMhz = 20;
    const widthArg = Number(text('channel-width'));
    if (band === '60') widthMhz = 2160;
    else if ((CHANNEL_WIDTHS as readonly number[]).includes(widthArg) && widthArg <= radio.maxWidthMhz) widthMhz = widthArg as ChannelWidthMhz;
    const powerArg = Number(text('tx-power'));
    const txPowerDbm = text('tx-power') !== undefined && Number.isSafeInteger(powerArg) ? Math.min(powerArg, radio.maxTxPowerDbm) : radio.maxTxPowerDbm;
    const securityArg = text('security');
    const security: WifiSecurity = securityArg !== undefined && (WIFI_SECURITIES as readonly string[]).includes(securityArg) ? (securityArg as WifiSecurity) : 'open';

    const out: RadioSettings = { band, channel, widthMhz, txPowerDbm, security };
    const ssid = text('ssid');
    if (ssid !== undefined) out.ssid = ssid;
    const passphrase = text('passphrase');
    if (passphrase !== undefined) out.passphrase = passphrase;
    const peerKey = text('peer-key');
    if (peerKey !== undefined) out.peerKey = peerKey;
    if (lines.has('beacons')) out.emitBeacons = true;
    return out;
  }

  // ── device-level operations ─────────────────────────────────────────────

  setPortAdmin(portId: PortId, adminUp: boolean, now: SimTime): void {
    this.clock = now;
    const port = this.ports.get(portId);
    if (port === undefined) return;
    const role = effectivePortRole(port, this.effectiveCaps);
    if (!ROLE_TRAITS[role].configurable) return;
    // keep the running-config in step even when called directly (CLI device op)
    if (adminUp) this.runningAst.unset([['interface', portId]], ['shutdown']);
    else this.runningAst.set([['interface', portId]], ['shutdown']);
    if (port.adminUp === adminUp) return;
    port.adminUp = adminUp;
    this.trace.emit({ t: now, kind: 'portState', device: this.id, port: portId, adminUp, operUp: port.operUp, reason: adminUp ? 'admin-up' : 'admin-down' });
    this.trace.emit({
      t: now,
      kind: 'log',
      device: this.id,
      severity: 3,
      facility: FACILITY_LINK,
      message: adminUp ? `Interface ${portId} administratively enabled` : `Interface ${portId} administratively down`,
    });
    if (ROLE_TRAITS[role].virtual) {
      if (adminUp) this.logUnsupportedVlan(port, now);
      this.recomputeVirtual(now);
      return;
    }
    this.deps.onPortAdmin({ device: this.id, port: portId }, adminUp, now);
  }

  setPower(on: boolean, now: SimTime): void {
    this.clock = now;
    if (on === this.power) return;
    this.power = on;
    if (on) {
      this.bootedAt = undefined;
      this.bootSeq = this.deps.scheduler.schedule(now + this.model.bootNs, { kind: 'boot', device: this.id });
      this.trace.emit({ t: now, kind: 'deviceState', device: this.id, power: true, booted: false });
      return;
    }
    // power off: RAM state is lost
    if (this.bootSeq !== undefined) {
      this.deps.scheduler.cancel(this.bootSeq);
      this.bootSeq = undefined;
    }
    this.pendingRunning = undefined;
    // onShutdown (P1): each daemon may say goodbye (DHCP RELEASE, …) before RAM is lost. Actions apply now, while the
    // ports are still up; the links go down right after, and any timer armed here is cancelled with the rest below.
    for (const name of this.processOrder) {
      const p = this.processes.get(name);
      const ctx = this.ctxs.get(name);
      if (p === undefined || ctx === undefined || p.onShutdown === undefined) continue;
      this.applyActions(name, p.onShutdown(ctx), now);
    }
    for (const t of this.timers.values()) this.deps.scheduler.cancel(t.seq);
    this.timers.clear();
    for (const change of recomputeVirtualOper(this.ports, { power: false, booted: false }, this.effectiveCaps, now)) {
      this.emitPortState(change.port, change.reason);
    }
    this.processes.clear();
    this.ctxs.clear();
    this.debugRings.clear();
    this.demuxIndex = buildDemuxIndex([], new Map());
    this.airResolved = false;
    this.airCache = undefined;
    for (const name of this.tables.names()) this.tables.get(name)?.clear('cleared');
    this.hostname = this.spec.name;

    // virtual interfaces other than the auto ones only exist in the lost running-config
    const created: PortId[] = [];
    for (const port of this.ports.values()) {
      if (port.spec.kind !== 'virtual') continue;
      const parsed = parseVirtualPortName(this.model, port.id);
      if (parsed === undefined || !isAutoInstance(parsed.family, parsed.number)) created.push(port.id);
    }
    if (created.length > 0) {
      removePorts(this.ports, this.model, created);
      this.version++;
    }
    let rolesChanged = false;
    for (const port of this.ports.values()) {
      const before = port.role;
      resetPortForPowerOff(port, { capabilities: this.effectiveCaps, portsDefaultUp: this.model.portsDefaultUp }, now);
      if (before !== undefined && before !== port.role) rolesChanged = true;
    }
    if (rolesChanged) this.version++;
    this.runningAst = this.freshRunning();
    this.bootedAt = undefined;
    this.trace.emit({ t: now, kind: 'deviceState', device: this.id, power: false, booted: false });
    for (const port of [...this.ports.values()]) {
      if (this.isVirtual(port)) continue;
      this.deps.onPortAdmin({ device: this.id, port: port.id }, false, now);
    }
  }

  reload(now: SimTime): void {
    this.setPower(false, now);
    this.setPower(true, now);
  }

  saveConfig(): void {
    this.startup = this.runningAst.clone();
  }

  eraseStartup(): void {
    this.startup = undefined;
  }

  // ── roles (§3.10 switchport / no switchport) ────────────────────────────

  setPortRole(portId: PortId, role: PortRole, now: SimTime): { ok: boolean; error?: string } {
    this.clock = now;
    const port = this.ports.get(portId);
    if (port === undefined) return { ok: false, error: fill(DEVICE_CONFIG_MESSAGES.unknownInterface, { name: portId }) };
    const current = effectivePortRole(port, this.effectiveCaps);
    const allowed = port.spec.allowedRoles ?? [specRole(port.spec, this.effectiveCaps)];
    if (!allowed.includes(role) || !ROLE_KINDS[role].includes(port.spec.kind)) return { ok: false, error: CLI_MESSAGES.roleLocked };
    if (current === role) return { ok: true };

    // leaving an L3 role withdraws the address (processes see the unset delta and remove C/L routes)
    if (ROLE_TRAITS[current].l3 && !ROLE_TRAITS[role].l3) {
      const configured = this.interfaceNode(portId)?.children.some((c) => c.key === 'ip' && c.children.some((leaf) => leaf.key === 'address')) === true;
      if (configured || port.l3.ipv4 !== undefined) this.applyConfigLine([['interface', portId]], ['ip', 'address'], true);
    }
    const wasUp = port.operUp;
    if (wasUp) this.fanLinkChange(portId, false, now);
    port.role = role;
    this.demuxIndex = buildDemuxIndex(this.processOrder, this.processes);
    this.version++;
    this.emitPortState(portId, 'role-change');
    if (wasUp) this.fanLinkChange(portId, true, now);
    this.recomputeVirtual(now);
    return { ok: true };
  }

  // ── virtual interfaces (§3.10) ──────────────────────────────────────────

  ensureVirtualPort(name: PortId, now: SimTime): { ok: true; port: PortId; created: boolean } | { ok: false; error: string } {
    this.clock = now;
    const plan = planVirtualPort(this.model, this.ports, name, this.effectiveCaps);
    if (!plan.ok) return { ok: false, error: plan.error };
    if (!plan.created) return { ok: true, port: plan.port, created: false };
    const state = createVirtualPortState(plan.family, plan.number, this.macBase);
    insertPorts(this.ports, this.model, [state]);
    seedInterfaceSection(this.runningAst, state, this.effectiveCaps);
    this.version++;
    this.emitPortState(state.id, 'virtual-created');
    if (state.adminUp) this.logUnsupportedVlan(state, now);
    this.recomputeVirtual(now);
    return { ok: true, port: state.id, created: true };
  }

  removeVirtualPort(name: PortId, now: SimTime): { ok: boolean; error?: string } {
    this.clock = now;
    const check = checkVirtualPortRemoval(this.model, this.ports, name);
    if (!check.ok) return { ok: false, error: check.error };
    const port = this.ports.get(name) as PortState;
    const context: string[][] = [['interface', name]];
    const section = this.interfaceNode(name);
    if (section !== undefined) {
      // unset the section's lines first so every process sees them go (the address withdraws its routes)
      const lines = configTextLinesOf({ key: '', args: [], children: [section] });
      for (const l of lines) {
        if (l.context.length !== 1 || l.negate || l.tokens[0] === 'shutdown') continue;
        this.applyConfigLine(context, l.tokens, true);
      }
      const delta = this.runningAst.unset([], ['interface', name]);
      if (delta !== undefined) {
        this.fanOutConfig(delta, now);
        this.trace.emit({ t: now, kind: 'configChange', device: this.id, line: `interface ${name}`, negate: true, context: [] });
      }
    }
    if (port.operUp) {
      port.operUp = false;
      port.lastChange = now;
      this.fanLinkChange(name, false, now);
    }
    removePorts(this.ports, this.model, [name]);
    this.version++;
    this.trace.emit({ t: now, kind: 'portState', device: this.id, port: name, adminUp: port.adminUp, operUp: false, reason: 'virtual-removed' });
    return { ok: true };
  }

  // ── modules (D7, §3.11) ─────────────────────────────────────────────────

  insertModule(slotId: SlotId, type: ModuleType, now: SimTime): HardwareResult {
    this.clock = now;
    const slot = this.slotSpec(slotId);
    if (slot === undefined) return this.hardwareError('no-such-slot', { model: this.model.model, slot: slotId });
    const mod = this.moduleModel(type);
    if (mod === undefined) return this.hardwareError('unknown-module', { module: type });
    if (!SLOT_ACCEPTS[slot.type].includes(mod.fits)) return this.hardwareError('does-not-fit', { module: mod.model, slotType: slot.type });
    if (this.power) return this.hardwareError('powered-on', { device: this.hostname });
    const occupant = this.installed.get(slot.id);
    if (occupant !== undefined) return this.hardwareError('slot-occupied', { slot: slot.id, module: this.moduleModel(occupant)?.model ?? occupant });

    this.installed.set(slot.id, mod.type);
    this.reorderInstalled();
    this.effectiveCaps = this.computeCapabilities();
    const states = this.moduleStates(slot, mod, this.buildContext());
    if (states.length > 0) {
      insertPorts(this.ports, this.model, states);
      for (const s of states) seedInterfaceSection(this.runningAst, s, this.effectiveCaps);
    }
    this.applyCageTransceiver(slot.id, mod.type);
    this.hardwareChanged();
    return { ok: true };
  }

  removeModule(slotId: SlotId, now: SimTime): HardwareResult & { removedPorts?: readonly PortId[] } {
    this.clock = now;
    const slot = this.slotSpec(slotId);
    if (slot === undefined) return this.hardwareError('no-such-slot', { model: this.model.model, slot: slotId });
    if (!this.installed.has(slot.id)) return this.hardwareError('slot-empty', { slot: slot.id });
    if (this.power) return this.hardwareError('powered-on', { device: this.hostname });

    const removed = this.modulePorts(slot.id);
    if (removed.length > 0) removePorts(this.ports, this.model, removed);
    if (slot.cage !== undefined) {
      const cage = this.ports.get(slot.cage);
      if (cage !== undefined) delete cage.transceiver;
    }
    this.installed.delete(slot.id);
    this.effectiveCaps = this.computeCapabilities();
    this.hardwareChanged();
    return { ok: true, removedPorts: removed };
  }

  modulePorts(slotId: SlotId): readonly PortId[] {
    const out: PortId[] = [];
    for (const port of this.ports.values()) if (port.spec.module !== undefined && port.spec.slot === slotId) out.push(port.id);
    return out;
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private isVirtual(port: Pick<PortState, 'role' | 'spec'>): boolean {
    return ROLE_TRAITS[effectivePortRole(port, this.effectiveCaps)].virtual;
  }

  private buildContext(): PortBuildContext {
    return { macBase: this.macBase, capabilities: this.effectiveCaps, portsDefaultUp: this.model.portsDefaultUp };
  }

  private slotSpec(id: SlotId): SlotSpec | undefined {
    return (this.model.slots ?? []).find((s) => s.id === id);
  }

  private moduleModel(type: ModuleType): ModuleModel | undefined {
    return this.deps.catalog.module?.(type);
  }

  /** Installs sorted by the model's slot order (unknown slots keep their relative order at the end). */
  private orderInstalls(installs: readonly { slot: SlotId; module: ModuleType }[]): { slot: SlotId; module: ModuleType }[] {
    const slots = this.model.slots ?? [];
    const rank = (slot: SlotId): number => {
      const at = slots.findIndex((s) => s.id === slot);
      return at < 0 ? slots.length : at;
    };
    return installs.map((install, i) => ({ install, i })).sort((a, b) => rank(a.install.slot) - rank(b.install.slot) || a.i - b.i).map((e) => ({ slot: e.install.slot, module: e.install.module }));
  }

  /** Refill `installed` in model slot order and mirror it into `spec.modules`. */
  private reorderInstalled(): void {
    const ordered = this.orderInstalls([...this.installed].map(([slot, module]) => ({ slot, module })));
    this.installed.clear();
    for (const i of ordered) this.installed.set(i.slot, i.module);
    this.spec.modules = ordered.map((i) => ({ slot: i.slot, module: i.module }));
  }

  /** Port states a module adds in `slot` (none for transceivers, which become the cage port's `transceiver`). */
  private moduleStates(slot: SlotSpec, mod: ModuleModel, build: PortBuildContext): PortState[] {
    if (mod.ports.length === 0) return [];
    return modulePortSpecs({ capabilities: this.model.capabilities ?? [] }, slot, mod).map((spec) => createPortState(spec, spec.ordinal ?? 0, build));
  }

  private applyCageTransceiver(slotId: SlotId, type: ModuleType): void {
    const slot = this.slotSpec(slotId);
    const mod = this.moduleModel(type);
    if (slot?.cage === undefined || mod === undefined || mod.ports.length > 0) return;
    const cage = this.ports.get(slot.cage);
    if (cage !== undefined) cage.transceiver = mod.type;
  }

  /** After a module change: spec mirror, daemons, tables, RF view, ports version. */
  private hardwareChanged(): void {
    this.reorderInstalled();
    this.processOrder = this.computeProcessOrder();
    this.tables.sync(this.computeTableNames());
    this.airResolved = false;
    this.airCache = undefined;
    this.version++;
  }

  private hardwareError(code: HardwareErrorCode, values: Readonly<Record<string, string>>): { ok: false; code: HardwareErrorCode; error: string } {
    return { ok: false, code, error: fill(HARDWARE_MESSAGES[code], values) };
  }

  /** Model capabilities plus the capabilities of installed modules (expanded, CAPABILITIES order). */
  private computeCapabilities(): readonly Capability[] {
    const added: Capability[] = [];
    for (const type of this.installed.values()) for (const c of this.moduleModel(type)?.capabilitiesAdded ?? []) added.push(c);
    if (added.length === 0) return this.model.capabilities ?? [];
    return expandCapabilities([...(this.model.capabilities ?? []), ...added]);
  }

  /** `model.processes`, plus the daemons of module-added capabilities, ordered by PROCESS_ORDER. */
  private computeProcessOrder(): readonly ProcessName[] {
    const base = this.model.capabilities ?? [];
    if (this.effectiveCaps.length === base.length && this.effectiveCaps.every((c) => base.includes(c))) return this.model.processes;
    const all: ProcessName[] = [...this.model.processes];
    for (const p of deriveProcesses(this.effectiveCaps, CATALOG_STAGE)) if (!all.includes(p)) all.push(p);
    const rank = (name: ProcessName): number => {
      const at = PROCESS_ORDER.indexOf(name);
      return at < 0 ? PROCESS_ORDER.length : at;
    };
    return all.map((name, i) => ({ name, i })).sort((a, b) => rank(a.name) - rank(b.name) || a.i - b.i).map((e) => e.name);
  }

  /** Declared tables: `model.tables`, plus the tables of the effective daemons. */
  private computeTableNames(): readonly TableName[] {
    return orderTableNames([...(this.model.tables ?? []), ...deriveTables(this.processOrder)]);
  }

  /** Factory-default running-config: hostname plus one interface section per configurable port (Map order). */
  private freshRunning(): ConfigAst {
    const ast = createConfigAst();
    seedRunningConfig(ast, this.spec.name, this.ports.values(), this.effectiveCaps);
    return ast;
  }

  /** Fan `onLinkChange(port, up)` out in daemon order, applying each process's actions at once. */
  private fanLinkChange(portId: PortId, up: boolean, now: SimTime): void {
    for (const name of this.processOrder) {
      const p = this.processes.get(name);
      const ctx = this.ctxs.get(name);
      if (p === undefined || ctx === undefined || p.onLinkChange === undefined) continue;
      this.applyActions(name, p.onLinkChange(ctx, portId, up), now);
    }
  }

  /** Recompute virtual oper state; per change emit `portState` then fan `onLinkChange` out. */
  private recomputeVirtual(now: SimTime): void {
    const changes = recomputeVirtualOper(this.ports, { power: this.power, booted: this.bootedAt !== undefined }, this.effectiveCaps, now);
    for (const change of changes) {
      this.emitPortState(change.port, change.reason);
      this.fanLinkChange(change.port, change.operUp, now);
    }
  }

  /** Log that an administratively enabled SVI other than Vlan1 stays down (VLANs arrive in P2). */
  private logUnsupportedVlan(port: PortState, now: SimTime): void {
    if (effectivePortRole(port, this.effectiveCaps) !== 'svi') return;
    const parsed = parseVirtualPortName(this.model, port.id);
    if (parsed === undefined || parsed.number === SVI_SUPPORTED_VLAN) return;
    this.trace.emit({ t: now, kind: 'log', device: this.id, severity: 4, facility: FACILITY_SYS, message: vlanUnsupportedMessage(port.id) });
  }

  private emitPortState(portId: PortId, reason: string | undefined): void {
    const port = this.ports.get(portId);
    if (port === undefined) return;
    const ev: Extract<TraceEvent, { kind: 'portState' }> = { t: this.clock, kind: 'portState', device: this.id, port: portId, adminUp: port.adminUp, operUp: port.operUp };
    if (reason !== undefined) ev.reason = reason;
    this.trace.emit(ev);
  }

  private emitDrop(pdu: Pdu, reason: DropReason, detail: string | undefined, port: PortId | undefined): void {
    const ev: Extract<TraceEvent, { kind: 'drop' }> = { t: this.clock, kind: 'drop', pdu: pduSummary(pdu), device: this.id, reason };
    if (port !== undefined) ev.port = port;
    if (detail !== undefined) ev.detail = detail;
    this.trace.emit(ev);
  }

  private runtimeDebug(process: ProcessName, message: string, now: SimTime): void {
    const ev: DebugEvent = { at: now, device: this.id, process, category: 'runtime', message };
    this.recordDebug(ev);
    this.trace.emit({ t: now, kind: 'debug', event: ev });
  }
}

/**
 * Create the runtime for `spec`. If `spec.power` is true a `boot` event is scheduled at
 * `now + model.bootNs`. Throws when `spec.type` is not in the catalog or `spec.modules` is invalid
 * (unknown slot or module, a module that does not fit, two modules in one slot) — before any state exists.
 */
export function createDevice(spec: DeviceSpec, deps: DeviceRuntimeDeps, now: SimTime): DeviceRuntime {
  return new DeviceRuntimeImpl(spec, deps, now);
}
