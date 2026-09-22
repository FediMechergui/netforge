/**
 * The Simulation facade (sim/simulation.ts) — the single entry point used by
 * the worker bridge, tests and (later) the headless grader.
 *
 * The facade owns: scheduler, root rng, device catalog, devices, links, trace
 * ring, PDU registry (id → Pdu for on-demand inspection), and the CLI runtime.
 * It never touches the DOM or wall-clock time. Driving it forward is the
 * caller's job (`runUntil`, `runFor`, `step`).
 *
 * P0.5/P1 members are optional in the type during the transition (contracts/port.ts TRANSITION RULE).
 * User/GUI actions (cli.exec, configure, moves, module changes) are applied between scheduler events at
 * the synced device clock, exactly like P0 `cli.exec`.
 */
import type { CliRuntime, ConfigureOptions, ConfigureResult } from './cli.js';
import type { DeviceCatalog, DeviceRuntime } from './device.js';
import type { DeviceId, LinkId, PduId, PortId, PortRef, ProcessName } from './ids.js';
import type { Impairments, MediaType, CableValidation, LinkState } from './link.js';
import type { PduView, ProtoName } from './pdu.js';
import type { SimSnapshot } from './snapshot.js';
import type { SimTime } from './time.js';
import type { Topology, TopologyDeviceUi } from './topology.js';
import type { TraceEvent, TraceKind } from './trace.js';
import type { SimEvent, FaultSpec } from './events.js';
import type { TableName } from './tables.js';
import type { DefaultsProfile, HardwareResult, ModuleInstall, ModuleType, SlotId } from './catalog.js';
import type { FsmMachine } from './process.js';
import type { FacadeCounters, JournalPosition, SimJournal } from './journal.js';
import type {
  CaptureExportOptions,
  CaptureId,
  CaptureInfo,
  CaptureQuery,
  CaptureQueryResult,
  CaptureRecordDetail,
  CaptureSpec,
  CaptureStatistics,
  FollowStreamResult,
} from './capture.js';

export type FidelityMode = 'realtime' | 'simulation' | 'turbo';

export interface SimulationOptions {
  seed: number;
  /** Trace ring capacity in events (default 200k). Turbo mode may set 0. */
  traceCapacity?: number;
  mode?: FidelityMode;
  /** @since P2 (optional by meaning) Defaults profile of the initial (empty) world; default 'P1' (D2). */
  profile?: DefaultsProfile;
  /**
   * @since P2 (optional by meaning) TESTS AND TOOLING ONLY (ARCHITECTURE-P2 §0 rule 13): the catalog to build devices
   * from instead of createCatalog(PROCESS_FACTORIES). Never passed by apps/web.
   */
  catalog?: DeviceCatalog;
  /** @since P2 (optional by meaning) [SHOULD S1] Journal every outermost mutating facade call (default true). */
  journal?: boolean;
  /** @since P2 (optional by meaning) [SHOULD S1] Cap of the id → PDU registry (replayers run with a small one). */
  pduRegistryLimit?: number;
  /** @since P2 (optional by meaning) [SHOULD S1] Facade counters a replay starts from (`JournalOrigin.counters`). */
  resume?: FacadeCounters;
}

export interface AddDeviceSpec {
  id?: DeviceId;
  type: string;
  name?: string;
  position?: { x: number; y: number };
  power?: boolean;
  startupConfig?: string;
  /** running-config text restored on the first boot only (a saved project's unsaved changes). */
  runningConfig?: string;
  /** @since P0.5 Undefined = the model's default modules; [] = empty chassis. Validated before the device exists (readable error). */
  modules?: readonly ModuleInstall[];
  /** @since P0.5 Preferred MAC salt (from a loaded file); bumped deterministically if it collides. */
  macSalt?: number;
  /** @since P0.5 */
  ui?: TopologyDeviceUi;
}

export interface AddLinkSpec {
  id?: LinkId;
  a: PortRef;
  b: PortRef;
  media?: MediaType; // default 'auto'
  lengthM?: number; // default 3
  impairments?: Partial<Impairments>;
  /** @since P0.5 'radio' pairs two radio-ptp ports (media 'radio'). */
  kind?: 'cable' | 'radio';
  /** @since P0.5 Serial DCE end override. */
  dceEnd?: 'a' | 'b';
  /** @since P0.5 Radio distance override in metres. */
  distanceOverrideM?: number;
}

export interface RunStats {
  events: number;
  from: SimTime;
  to: SimTime;
  /** @since P1 Why a run stopped early. */
  stopped?: 'breakpoint' | 'maxEvents';
  /** @since P1 First matching event of a breakpoint stop and its ring cursor. */
  stopEvent?: TraceEvent;
  stopCursor?: number;
}

/**
 * @since P1 Structured-clone-safe predicate over TraceEvents (semantics: trace/filter.ts `matchesTraceFilter`).
 * All present keys must match (AND); array values match any member (OR).
 */
export interface TraceFilter {
  kinds?: readonly TraceKind[];
  /** Matches any of PduSummary.layers (falls back to PduSummary.proto). Events without a PDU never match when set. */
  protos?: readonly ProtoName[];
  /** Matches event.device, frameTx.from/to.device, drop.device, debug.event.device. */
  devices?: readonly DeviceId[];
  /** Link or medium ids. */
  links?: readonly string[];
  ports?: readonly PortRef[];
  tables?: readonly TableName[];
  /** Matches PduSummary.tag exactly (daemons tag message kinds: 'dhcp-discover', 'dhcp-offer', 'tcp-syn', 'dns-query', …). */
  tags?: readonly string[];
  /** Include frames flagged background (keepalives, beacons). Default false. */
  includeBackground?: boolean;
  /**
   * @since P2 (optional by meaning) [SHOULD S1] Matches debug events whose `event.fsm.machine` is listed (the timeline
   * lanes and the state-machine history strip).
   */
  machines?: readonly FsmMachine[];
}

export interface RunOptions {
  /** Stop after the WHOLE dispatch of the first scheduler event that emitted a matching trace event; `now` stays at that event (no advanceTo). */
  stopOn?: TraceFilter;
  maxEvents?: number;
}

export interface TraceQuery {
  /** Ring cursor to start from (inclusive). */
  from: number;
  filter?: TraceFilter;
  limit: number;
  direction?: 'forward' | 'backward';
}

export interface TraceQueryResult {
  events: { cursor: number; event: TraceEvent }[];
  /** Cursor to continue from. */
  next: number;
  /** Oldest retained cursor and current head. */
  oldest: number;
  head: number;
}

export interface SnapshotOptions {
  /** Include only these DeviceSnapshots (snapshot order preserved); everything else stays complete. */
  devices?: readonly DeviceId[];
}

/** @since P0.5 Non-config GUI actions, mapped by the facade onto ProcessRequests. Results appear in process StateViews. */
export type HostAppRequest =
  | { app: 'http.get'; url: string }
  | { app: 'wifi.scan'; port?: PortId }
  | { app: 'dhcp.renew'; port: PortId }
  | { app: 'dhcp.release'; port: PortId };

export interface HostAppTicket {
  /**
   * `r_<n>`, deterministic per simulation. It is the daemon's StateView key only for `http.get`, where it is the
   * http-client tab token (`tabs['r_<n>']`). A `wifi.scan` result is keyed by PORT (wlan-client
   * `ports[].candidates`) and a `dhcp.renew` / `dhcp.release` result by INTERFACE (dhcp-client `clients[]`); for
   * those, the ticket is only a handle on the call.
   */
  requestId: string;
  process: ProcessName;
}

export interface TopologyLoadProblem {
  device?: DeviceId;
  link?: LinkId;
  message: string;
}

/** @since P0.5 Thrown by an atomic `loadTopology` before the world is replaced (the previous world is untouched). */
export class TopologyLoadError extends Error {
  readonly problems: readonly TopologyLoadProblem[];
  constructor(message: string, problems: readonly TopologyLoadProblem[]) {
    super(message);
    this.name = 'TopologyLoadError';
    this.problems = problems;
  }
}

export interface Simulation {
  readonly seed: number;
  readonly now: SimTime;
  readonly mode: FidelityMode;
  readonly cli: CliRuntime;
  readonly catalog: DeviceCatalog;
  /**
   * @since P2 The world's defaults profile (D2): `SimulationOptions.profile ?? 'P1'` for the initial world, and every
   * device the world builds gets it as `DeviceSpec.profile` (W1 sim). loadTopology sets it from `t.profile ?? 'P1'`;
   * exportTopology writes `profile` only when 'P2' (and then schema 1.2) — both W2 sim. Required since W1 sim.
   */
  readonly profile: DefaultsProfile;
  /** @since P2 [SHOULD S1] Position of the world: scheduler events popped since it was built, and the sim time. Required since W2 sim [S1] (§0 rule 2). */
  position(): JournalPosition;
  /** @since P2 [SHOULD S1] The input journal (a structured-clone copy). Required since W2 sim [S1] (§0 rule 2). */
  journal(): SimJournal;
  /** Live device access (tests, grader). */
  device(id: DeviceId): DeviceRuntime | undefined;
  devices(): DeviceRuntime[];

  // ── topology ────────────────────────────────────────────────────────────
  /** P0.5: atomic (validates schema, migration, catalog types, modules and ports first; throws TopologyLoadError). */
  loadTopology(t: Topology): void;
  exportTopology(): Topology;
  /** P0.5: position rounded with Math.round (the same rule as moveDevice; loadTopology goes through here). */
  addDevice(spec: AddDeviceSpec): DeviceId;
  removeDevice(id: DeviceId): void;
  renameDevice(id: DeviceId, name: string): void;
  /** P0.5: rounds the position; for devices with radio ports schedules one coalesced `deviceMoved` at now. */
  moveDevice(id: DeviceId, position: { x: number; y: number }): void;
  setPower(id: DeviceId, on: boolean): void;
  /** Validate without creating (UI hover feedback). */
  validateLink(spec: AddLinkSpec): CableValidation;
  addLink(spec: AddLinkSpec): LinkId;
  removeLink(id: LinkId): void;
  setImpairments(id: LinkId, imp: Partial<Impairments>): void;
  link(id: LinkId): LinkState | undefined;
  injectFault(at: SimTime, fault: FaultSpec): void;

  // ── time ────────────────────────────────────────────────────────────────
  /**
   * Process events with `at <= t`, then set now = t. `t` MUST be an integer ns (`assertSimTime`).
   * `t < now` is a no-op. With `opts.stopOn` (@since P1) the run stops after the dispatch of the first
   * event that emitted a matching trace event and `now` stays at that event.
   */
  runUntil(t: SimTime, opts?: RunOptions): RunStats;
  /** `runUntil(now + dt, opts)`; `dt` MUST be an integer >= 0. */
  runFor(dt: SimTime, opts?: RunOptions): RunStats;
  /** Process exactly one event. */
  step(): SimEvent | undefined;
  /** Run until only `periodic` timers remain or `maxEvents` processed (tests, grading). */
  runToIdle(maxEvents?: number): RunStats;
  /** Time of the next pending event. */
  nextEventTime(): SimTime | undefined;
  /** @since P1 `step()` until a matching trace event is emitted, `maxEvents` (default 100 000), `until`, or queue end. */
  stepToNext(filter: TraceFilter, opts?: { maxEvents?: number; until?: SimTime }): RunStats;

  // ── observation ─────────────────────────────────────────────────────────
  /** P0.5: `opts.devices` builds a subset snapshot (worker deltas); rendered configs are cached per device. */
  snapshot(opts?: SnapshotOptions): SimSnapshot;
  pdu(id: PduId): PduView | undefined;
  /** Drain trace events since `cursor` (0 = from the start of what is retained). */
  trace(cursor: number): { events: TraceEvent[]; next: number; dropped: number };
  /** Synchronous listener (tests). Returns unsubscribe. */
  onTrace(cb: (ev: TraceEvent) => void): () => void;
  /** @since P1 Page the trace ring with a filter (sim-events list). */
  traceQuery(q: TraceQuery): TraceQueryResult;

  // ── P0.5: configuration, hardware, GUI ───────────────────────────────────
  /**
   * @since P0.5 D9: run `commands` through a HEADLESS CLI session (privilege 15, no history, no
   * cliPrompt/cliOutput/debug routing, never listed in `cli.sessions()`, id `h_<n>`) so GUI panels share the
   * CLI validator. Syncs the device clock like cli.exec; configChange events are emitted as usual. Job or
   * interactive commands are refused per line. Device off/booting → every line fails with the console wording.
   * Throws only for an unknown device id.
   */
  configure(device: DeviceId, commands: readonly string[], opts?: ConfigureOptions): ConfigureResult;
  /** @since P0.5 D7: insert while powered off. On success emits topologyChanged {what:'module', op:'add'} and bumps topologyVersion. */
  insertModule(device: DeviceId, slot: SlotId, module: ModuleType): HardwareResult;
  /** @since P0.5 D7: remove while powered off; links on the module's ports are removed first (link remove events). */
  removeModule(device: DeviceId, slot: SlotId): HardwareResult;
  /** @since P0.5 Replace the persisted GUI state of a device (no trace, no topologyVersion bump). */
  setDeviceUi(device: DeviceId, ui: TopologyDeviceUi): void;
  /** @since P0.5 Canvas scale (metres per unit); recomputes radio links and air/cell pairs. */
  setCanvasScale(metresPerUnit: number): void;
  /** @since P0.5 GUI app actions (browser fetch, Wi-Fi scan, DHCP renew/release). */
  hostRequest(device: DeviceId, req: HostAppRequest): HostAppTicket;

  // ── P1: captures (live, owned by this simulation; ids c_<n>) ─────────────
  startCapture(spec: CaptureSpec): CaptureId;
  stopCapture(id: CaptureId): void;
  removeCapture(id: CaptureId): void;
  captures(): CaptureInfo[];
  queryCapture(id: CaptureId, q: CaptureQuery): CaptureQueryResult;
  captureRecord(id: CaptureId, index: number): CaptureRecordDetail | undefined;
  followStream(id: CaptureId, key: string): FollowStreamResult;
  captureStats(id: CaptureId, filter?: string): CaptureStatistics;
  /** Byte-deterministic for a given `baseWallNs` (default 0). */
  exportCapture(id: CaptureId, opts: CaptureExportOptions): Uint8Array;
}
