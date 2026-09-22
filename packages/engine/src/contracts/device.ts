/**
 * Device model v2 (spec §4.4, §5; docs/CATALOG.md; ARCHITECTURE-P1 D2, D3, D7, D8, D9).
 *
 * Behaviour is CAPABILITY- and PORT-ROLE-driven. `kind` is only the icon/palette family and always
 * equals the catalog type-id prefix (`router.nf1941` → 'router'). Original naming (§1.6): every
 * model is `NF-…`; P0 models NF-PC, NF-C2960, NF-2911 keep their ids and ports.
 *
 * TRANSITION: the `@since P0.5` members of DeviceModel are optional in the TYPE only so P0 literal
 * fixtures compile. `defineModel` (device/catalog/define.ts) always fills every one of them; the
 * P0.5 exit gate makes them required (docs/ARCHITECTURE-P1.md §8, §9).
 */
import type { DeviceId, PortId, PortRef, ProcessName, SessionId } from './ids.js';
import type { ConfigAst } from './config.js';
import type { Scheduler } from './events.js';
import type { FrameRxInfo, PortPhySettings, TransmitFn, TxOutcome } from './link.js';
import type { Pdu, PduFactory } from './pdu.js';
import type { ErrDisableCause, PortSpec, PortState, PortView } from './port.js';
import type { Action, Process, ProcessFactory, StateView, DebugEvent } from './process.js';
import type { Rng } from './rng.js';
import type { DeviceTables, TableFactory, TableName } from './tables.js';
import type { SimTime } from './time.js';
import type { TraceSink } from './trace.js';
import type { TopologyDeviceUi } from './topology.js';
import type { AirView, MediumEvent, MediumOp } from './medium.js';
import type { RadioSettings } from './rf.js';
import type {
  Capability,
  CliSpec,
  DefaultsProfile,
  DeviceCategory,
  DeviceIconId,
  GuiPanelId,
  HardwareResult,
  IpDefaults,
  ModuleInstall,
  ModuleModel,
  ModuleType,
  PortRole,
  SlotId,
  SlotSpec,
  SubinterfaceSpec,
  VirtualFamilySpec,
} from './catalog.js';

/** Icon/palette family = catalog type-id prefix (validated). NEVER branch behaviour on it. */
export type DeviceKind =
  | 'pc'
  | 'switch'
  | 'router'
  | 'hub'
  // ── P0.5 ──
  | 'laptop'
  | 'server'
  | 'phone'
  | 'tablet'
  | 'ipphone'
  | 'printer'
  | 'tv'
  | 'iot'
  | 'mlswitch'
  | 'dcswitch'
  | 'repeater'
  | 'bridge'
  | 'firewall'
  | 'ids'
  | 'ap'
  | 'wlc'
  | 'wrouter'
  | 'radio'
  | 'cell'
  | 'modem'
  | 'csu'
  | 'cloud';

/**
 * Catalog entry (output of `defineModel`). Frozen, structured-clone safe (no functions, no RegExp):
 * it crosses the worker boundary in `EngineApi.init`. Shared by every instance; per-instance
 * variation (installed modules, virtual ports, roles) lives on the DeviceRuntime.
 */
export interface DeviceModel {
  /** Topology type id `<kind>.<model>`, e.g. 'router.nf2911'. */
  type: string;
  /** Display name, e.g. 'NF-2911'. */
  model: string;
  kind: DeviceKind;
  description: string;
  /** Fixed ports in canonical order. From P0.5 every entry has role, ordinal, encap and connector resolved. */
  ports: readonly PortSpec[];
  /** Daemons instantiated at boot, in PROCESS_ORDER (an order-preserving subsequence). */
  processes: readonly ProcessName[];
  /** Default hostname prefix: "PC", "Switch", "Router", "AP", … (original). */
  hostnamePrefix: string;
  /** Default admin state of configurable physical ports without `PortSpec.defaultAdminUp` (hosts/switches up, routers down). */
  portsDefaultUp: boolean;
  /** Boot time from power-on to forwarding. */
  bootNs: SimTime;
  /** Forwards IPv4 between L3 ports. */
  ipForwarding: boolean;
  /** Per-packet processing delay (spec §4.2 "processing"). RESERVED — models use 0 and the runtime ignores it. */
  processingNs: SimTime;
  /** Initial config lines applied at first boot. */
  defaultConfig?: readonly string[];

  // ── P0.5 ──
  /** @since P0.5 Palette category. */
  category: DeviceCategory;
  /** @since P0.5 Variant grouping key for the palette (e.g. 'nf-c2960'). */
  family: string;
  /** @since P0.5 Short variant label inside a family ('8-port', 'PoE+'). */
  variant: string;
  /** @since P0.5 Icon registry key. */
  icon: DeviceIconId;
  /** @since P0.5 Search tags (lowercase). */
  tags: readonly string[];
  /** @since P0.5 Expanded capability closure in CAPABILITIES order. */
  capabilities: readonly Capability[];
  /** @since P0.5 Console shell, headless grammar, initial privilege. */
  cli: CliSpec;
  /** @since P0.5 GUI panels in display order ('physical' first). */
  gui: readonly GuiPanelId[];
  /** @since P0.5 Module slots (empty unless `modular` or host-expansion). */
  slots: readonly SlotSpec[];
  /** @since P0.5 Creatable virtual interface families (Vlan, Loopback). */
  virtualFamilies: readonly VirtualFamilySpec[];
  /** @since P0.5 Host adapters in preference order for the host shell / Desktop IP config (may name auto virtual ports, e.g. 'Vlan1'). */
  hostPorts: readonly PortId[];
  /** @since P0.5 Egress owner per role whose trait egress is 'owner' (P0.5: `{ svi: 'eth-switch' }`). */
  portOwners: Readonly<Partial<Record<PortRole, ProcessName>>>;
  /** @since P0.5 Tables the device owns ('cam','arp','rib' first, then PROCESS_TABLES in process order). */
  tables: readonly TableName[];
  /** @since P0.5 TTL / hop limit / ARP and CAM timeouts. */
  ipDefaults: IpDefaults;
  /** @since P0.5 PoE budget for `poe-source` models (behaviour P2+). */
  poeBudgetW?: number;

  // ── P2 (optional by meaning, filled by defineModel; ARCHITECTURE-P2 §2.9, D2) ──
  /**
   * @since P2 (optional by meaning) Config text lines replayed at EVERY boot after `defaultConfig` and before the saved
   * configuration, for every key k with `profileIncludes(profile, k)`. Together with `defaultConfig` they are the
   * device's default lines D of the completeness rule (D2): the runtime passes D's slots to the config store (§5).
   */
  profileConfig?: Readonly<Partial<Record<DefaultsProfile, readonly string[]>>>;
  /** @since P2 (optional by meaning) Subinterface support (routers, multilayer switches; D11). */
  subinterfaces?: SubinterfaceSpec;
  /**
   * @since P2 (optional by meaning) Builds `profileConfig` (NF-C9300: 'rapid-pvst') and is the mode that
   * `no spanning-tree mode` restores in a P2 world (§5.1).
   */
  stpDefaultMode?: 'pvst' | 'rapid-pvst';
}

/** What port-name resolution works against: the model plus the live instance port set. */
export interface PortNameSource {
  readonly model: DeviceModel;
  readonly ports: ReadonlyMap<PortId, { readonly spec: Pick<PortSpec, 'name' | 'short'> }>;
}

/** Result of resolving a typed port name against a live device. */
export type PortResolution =
  | { kind: 'existing'; port: PortId }
  /**
   * Names a creatable virtual interface of an allowed family that does not exist yet.
   * `parent` @since P2 (optional by meaning): subinterfaces (family 'subinterface') name the physical port.
   */
  | { kind: 'virtual'; port: PortId; family: string; parent?: PortId }
  | { kind: 'unknown' }
  | { kind: 'ambiguous'; candidates: readonly PortId[] };

export interface DeviceCatalog {
  get(type: string): DeviceModel | undefined;
  /** All models in palette order (DEVICE_CATEGORIES order, then file order). */
  list(): readonly DeviceModel[];
  /** Resolve a process name to its factory. */
  process(name: ProcessName): ProcessFactory | undefined;
  /** @since P0.5 Module catalog lookup. */
  module(type: ModuleType): ModuleModel | undefined;
  /** @since P0.5 All modules in catalog order. */
  modules(): readonly ModuleModel[];
  /** @since P0.5 Resolve a typed port name against a live device (fixed + module + virtual) and its virtual families. */
  resolvePort(source: PortNameSource, name: string): PortResolution;
}

export interface DeviceSpec {
  id: DeviceId;
  type: string;
  name: string;
  position: { x: number; y: number };
  power: boolean;
  /** startup-config text (rendered AST) to load at boot. */
  startupConfig?: string;
  /**
   * running-config text to load on the FIRST boot instead of the startup-config (restores a
   * saved project's unsaved changes). Later boots (reload, power cycle) use startup only.
   */
  runningConfig?: string;
  /** @since P0.5 Installed modules in model slot order. Undefined only for legacy callers (treated as []). */
  modules: readonly ModuleInstall[];
  /** @since P0.5 MAC base salt resolved by the Simulation (0 unless a base collision occurred; D8). */
  macSalt: number;
  /** @since P0.5 Opaque persisted GUI state (D11); never read by the engine. */
  ui?: TopologyDeviceUi;
  /** @since P2 (optional by meaning) Set by the Simulation from the world (D2); absent = 'P1'. */
  profile?: DefaultsProfile;
}

/** Constructor dependencies supplied by the Simulation (sim owner) to `device/device.ts`. */
export interface DeviceRuntimeDeps {
  scheduler: Scheduler;
  trace: TraceSink;
  /** `root.split(`device:${id}`)`; the runtime splits per process as `split(`process:${name}`)`. */
  rng: Rng;
  pdus: PduFactory;
  catalog: DeviceCatalog;
  tables: TableFactory;
  /** `send` egress — the sim passes `linkModel.transmit`. */
  transmit: TransmitFn;
  /**
   * `shutdown` / `no shutdown` / power change: the runtime sets `adminUp`, emits `portState`, then calls
   * this; the sim routes it to `LinkModel.onPortChanged` (P0: `recompute`) and fans `onPortOper` out.
   * Never called for virtual ports.
   */
  onPortAdmin(ref: PortRef, adminUp: boolean, now: SimTime): void;
  /** `cliOutput` / `cliDone` actions are routed here; the sim wires it to `CliRuntime.onOutput/onDone`. */
  cliSink: {
    output(session: SessionId, text: string, now: SimTime): void;
    done(session: SessionId, now: SimTime): void;
  };
  /**
   * @since P0.5 Called after config fan-out whenever a PHY- or radio-relevant line changed on a port
   * (speed, duplex, clock rate, encapsulation, keepalive, ssid/security/passphrase/band/channel/
   * channel-width/tx-power/peer-key, switchport). The sim routes it to `LinkModel.onPortChanged`.
   */
  onPortPhyConfig(ref: PortRef, now: SimTime): void;
  /**
   * @since P0.5 RF view for the daemons of a device with wlan/radio/cellular ports (`ProcessCtx.air`); the sim
   * routes it to `LinkModel.airView`. Absent → `ctx.air` is undefined.
   */
  airView(device: DeviceId): AirView;
  /**
   * @since P0.5 `Action {type:'medium'}` from a daemon; the sim routes it to `LinkModel.mediumOp` and fans the
   * returned OperChanges out through `onPortOper`. Absent → the runtime records a debug event and drops the request.
   */
  mediumOp(from: PortRef, op: MediumOp, now: SimTime): void;
}

/** The live device inside the simulation (device/device.ts). */
export interface DeviceRuntime {
  readonly id: DeviceId;
  readonly model: DeviceModel;
  readonly spec: DeviceSpec;
  hostname: string;
  power: boolean;
  /** Boot completion time (undefined while off/booting). */
  bootedAt?: SimTime;
  /** Live ports in canonical order: fixed (model order), module (slot order), virtual (family order, ascending number). The Map object identity never changes. */
  readonly ports: ReadonlyMap<PortId, PortState>;
  readonly tables: DeviceTables;
  /** running-config (RAM). */
  readonly running: ConfigAst;
  /** startup-config (NVRAM), undefined until `copy running-config startup-config`. */
  startup?: ConfigAst;
  readonly processes: ReadonlyMap<ProcessName, Process>;
  port(id: PortId): PortState | undefined;
  portView(id: PortId): PortView | undefined;
  /** Apply a config delta: mutates `running`, notifies processes. */
  applyConfigLine(context: string[][], line: string[], negate: boolean): { ok: boolean; error?: string };
  stateSnapshots(): StateView[];
  recentDebug(limit?: number): DebugEvent[];
  /** Uptime since boot, 0 while off. */
  uptime(now: SimTime): SimTime;

  // ── run-loop entry points (the Simulation calls these from the popped SimEvent; `now` = event.at) ──
  /** Frame pipeline v2 (ARCHITECTURE-P1 §3.1): counters → role/validation → MAC filter → demux → actions. `rx` @since P0.5. */
  onFrameArrival(port: PortId, pdu: Pdu, corrupted: boolean | undefined, now: SimTime, rx?: FrameRxInfo): void;
  /** Process timer. Stale events (timer re-armed or cancelled since scheduling) are ignored. */
  onTimer(process: ProcessName, key: string, now: SimTime): void;
  /** Boot completes: load startup-config, instantiate processes, call `init`, emit `deviceState`. */
  onBoot(now: SimTime): void;
  /**
   * Called by the sim for each port whose `operUp` changed after the link model recomputed (the link model
   * already wrote `operUp` and emitted `portState`). Fans out `Process.onLinkChange` and applies the actions.
   */
  onPortOper(port: PortId, operUp: boolean, now: SimTime): void;
  /**
   * Apply actions on behalf of `process` (backs `CommandCtx.act`/`request` and process return values):
   * depth-first, in returned order, 1000-action budget per top-level call; on exhaustion emit `drop`
   * reason 'other' detail 'action-budget' for any pdu in hand and stop (never throw).
   */
  applyActions(process: ProcessName, actions: Action[], now: SimTime): void;

  // ── device-level operations (used by the CLI runtime and the Simulation) ──
  setPortAdmin(port: PortId, adminUp: boolean, now: SimTime): void;
  /** Power on schedules a `boot` event at `now + model.bootNs`; power off clears RAM state (running-config, tables, processes, roles, virtual oper). */
  setPower(on: boolean, now: SimTime): void;
  /** `reload`: equivalent to power off + on (running-config lost unless saved). */
  reload(now: SimTime): void;
  saveConfig(): void;
  eraseStartup(): void;

  // ── P0.5 hardware, ports, PHY ──
  /** @since P0.5 Installed modules by slot (slot order). */
  readonly modules: ReadonlyMap<SlotId, ModuleType>;
  /** @since P0.5 32-bit MAC base (`portMac(macBase, 0)` is the device base MAC). */
  readonly macBase: number;
  /** @since P0.5 Model capabilities plus those added by installed modules (CAPABILITIES order). */
  readonly capabilities: readonly Capability[];
  /** @since P0.5 Bumped whenever the port set or any effective role changes (module, virtual port, role flip). CLI scope caches key on it. */
  readonly portsVersion: number;
  /** @since P0.5 D7: only while powered off. Checks slot → module → fit → power → occupancy; refills the port Map in canonical order. */
  insertModule(slot: SlotId, type: ModuleType, now: SimTime): HardwareResult;
  /** @since P0.5 D7: only while powered off. The Simulation removes links on `modulePorts(slot)` BEFORE calling. */
  removeModule(slot: SlotId, now: SimTime): HardwareResult & { removedPorts?: readonly PortId[] };
  /** @since P0.5 Ports the module in `slot` would remove (for link cleanup). */
  modulePorts(slot: SlotId): readonly PortId[];
  /** @since P0.5 Create (or find) a virtual interface by canonical name; error when the family/number is not allowed. */
  ensureVirtualPort(name: PortId, now: SimTime): { ok: true; port: PortId; created: boolean } | { ok: false; error: string };
  /** @since P0.5 `no interface X` for non-auto virtual ports. */
  removeVirtualPort(name: PortId, now: SimTime): { ok: boolean; error?: string };
  /** @since P0.5 Change a port's effective role (must be in spec.allowedRoles); used by `switchport` / `no switchport`. */
  setPortRole(port: PortId, role: PortRole, now: SimTime): { ok: boolean; error?: string };
  /** @since P0.5 Resolve a typed port name against this device (fixed/module/virtual). */
  resolvePortName(name: string): PortResolution;
  /** @since P0.5 PHY settings rendered from running-config (link model input). */
  phySettings(port: PortId): PortPhySettings;
  /** @since P0.5 Radio settings rendered from running-config (undefined for non-radio ports). */
  radioSettings(port: PortId): RadioSettings | undefined;
  /** @since P0.5 Deferred transmit outcome from segment media: the runtime updates counters (rule 6) and emits no trace. */
  onTxOutcome(port: PortId, outcome: TxOutcome, now: SimTime): void;
  /** @since P0.5 Medium notification: fans `Process.onMediumEvent` in model order and applies actions. */
  onMediumEvent(port: PortId, ev: MediumEvent, now: SimTime): void;

  // ── P2 (ARCHITECTURE-P2 §2.9; required since W1 device — hand-built typed fakes spread `P2_DEVICE` from
  //    test/port.fixtures.ts) ──
  /** @since P2 The world's defaults profile (D2), from `DeviceSpec.profile ?? 'P1'`. */
  readonly profile: DefaultsProfile;
  /** @since P2 Fault path (`err-disable` fault, lab-check clone): the same effects as an `errDisable` action. */
  errDisablePort(port: PortId, cause: ErrDisableCause, now: SimTime): void;
}
