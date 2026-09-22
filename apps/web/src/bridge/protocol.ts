/**
 * Worker ↔ UI bridge contract (spec §3.3 "Bridge"; ARCHITECTURE-P1 §3.14, §4.11, §4.12, §7).
 *
 * The engine runs in a Web Worker (`engine.worker.ts`) and is exposed through
 * Comlink as `EngineApi`. The WORKER owns the clock: while playing it advances
 * sim time at `rate × wall time` (when idle — see ClockPolicy) in small slices
 * and posts `EngineBatch`es to the subscribed callback (~30–60 Hz). The UI never
 * calls `runUntil` directly. The worker computes each slice target as
 * `Math.round(now + rate * elapsedMs * MS)` — SimTime must stay integral
 * (engine time.ts); `runUntil` rejects fractional input.
 *
 * Batch cadence (independent of `playing`): the worker keeps a trace-ring cursor
 * (`Simulation.trace(cursor)`) and posts a batch whenever that cursor advanced —
 * after every clock slice, AND after any `EngineApi` call that can advance time
 * or mutate the simulation (`stepEvent`/`stepTime`/`runToIdle`, `cliExec`/
 * `cliInterrupt`/`cliClose`, `loadTopology`/`reset`, `add*`/`remove*`/`rename*`/
 * `move*`/`setPower`/`setImpairments`, from P0.5 `configure`/`insertModule`/`removeModule`/
 * `hostRequest`/`setCanvasScale`, and from P1 `runUntilStop`/`stepToNext`/`setPlaybackMode`/`setSimFilters`/
 * `checkLab` and the capture calls that change the capture set). Batches with no events and no snapshot may be skipped only when the dirty set
 * (below) is empty. `snapshot` is taken after the last event in `events`; step/runToIdle/reset/loadTopology
 * batches always carry one.
 *
 * P0.5 performance: while playing, and after any mutating EngineApi call while paused, the worker posts `delta`
 * (changed DeviceSnapshots, marked dirty from the device/port/table fields of drained trace events plus
 * `watchDevices`) every SNAPSHOT_EVERY_MS instead of a full snapshot; a full snapshot is sent on
 * epoch/topologyVersion change, step, load, reset or resync, and at least every 2 s while playing. The store
 * merges deltas by index keeping identity of untouched devices.
 *
 * Event-derived dirty set also includes: topologyChanged op:"move" → id (device); rfState → port.device and
 * peer.device, and links changed; linkState, phyNegotiated, segmentChanged → links changed (delta.links present)
 * plus their endpoint/member devices; collision → the stations. API calls whose effect may emit no dirtying event
 * mark their targets dirty explicitly and ALWAYS post a batch, whether playing or paused (a delta when
 * topologyVersion is unchanged, otherwise a full snapshot): setDeviceUi, renameDevice, moveDevice, setPower →
 * devices:[id]; setImpairments, setCanvasScale → links changed, plus the devices at both link ends
 * (setCanvasScale: all devices with radio/wlan/cellular ports).
 *
 * P1 additions (§4.11–§4.13). Simulation mode: `setPlaybackMode`/`setSimFilters` hold the two trace filters in the
 * worker; while playing in simulation mode every slice runs with `{stopOn: breakOn}`, and a match pauses the clock
 * and posts a full snapshot carrying `stopped {reason:'breakpoint'}`. `runUntilStop` and `stepToNext` do the same
 * on demand and also return what they found. Captures live in the worker (live `c_*` in the Simulation, imported
 * `i_*` in its library): the UI holds no engine object, gets rows/details/statistics as plain data and pcap bytes
 * as a transferable, and learns from `captureHeads` which capture grew. Labs: `loadScenario` activates the lab and
 * the batch carries its first `LabStatus`; after that a status rides a batch whenever grading changed, and
 * `checkLab` forces one.
 *
 * Errors: rejections are real Errors carried by the shared Comlink 'throw' handler in bridge/errors.ts
 * (`EngineError`), so `problems` survives the worker boundary.
 *
 * P0.5/P1 members are OPTIONAL in these types only until the web-shell wave that implements them removes the `?`
 * (engine contracts/port.ts TRANSITION RULE). Everything crossing this boundary is structured-clone safe.
 */
import type {
  AddDeviceSpec,
  AddLinkSpec,
  CableValidation,
  CaptureExportOptions,
  CaptureId,
  CaptureInfo,
  CaptureQuery,
  CaptureQueryResult,
  CaptureRecordDetail,
  CaptureSpec,
  CaptureStatistics,
  CliCompletion,
  CliResult,
  CliSessionView,
  ConfigureOptions,
  ConfigureResult,
  DefaultsProfile,
  DeviceId,
  DeviceModel,
  DeviceSnapshot,
  FollowStreamResult,
  HardwareResult,
  HostAppRequest,
  HostAppTicket,
  Impairments,
  JournalPosition,
  LabStatus,
  LaneBucket,
  LaneId,
  LinkId,
  LinkSnapshot,
  LinkState,
  MediaSpec,
  ModuleModel,
  ModuleType,
  PduId,
  PduJson,
  ScenarioMeta,
  SeekTarget,
  SessionId,
  SimSnapshot,
  SimTime,
  SlotId,
  TimelineMarkQuery,
  TimelineQuery,
  TimeTravelBudget,
  Topology,
  TopologyDeviceUi,
  TraceEvent,
  TraceFilter,
  TraceQuery,
  TraceQueryResult,
} from '@netforge/engine';

/**
 * Clock policy (architect decision, P0). Real Ethernet wire times are µs; at any
 * usable `rate` a capsule would cross the cable in < 1 screen frame. The WORKER
 * therefore runs sim time at `rate × wall` ONLY while no frame is on a cable;
 * while any frame is in flight it clamps each slice so every in-flight frame
 * spends ≥ `minTransitWallMs` of wall time on the wire, and it sub-steps to
 * `nextEventTime()` when idle so no `frameTx` is skipped inside a slice. Idle
 * waits (ping's 1 s spacing, ARP retries, CAM ageing) still run at `rate`. The
 * engine and the capsule formula are unchanged; only the sim→wall mapping is
 * adaptive. Tests and `runToIdle` use `minTransitWallMs: 0`.
 */
export interface ClockPolicy {
  /** 0 = pure rate×wall (tests / turbo). UI default 400. */
  minTransitWallMs: number;
  /** @since P0.5 Background frames (keepalives, beacons) never clamp the clock. Default true. In simulation playback only frames matching the list filter clamp. */
  ignoreBackground: boolean;
}
export const DEFAULT_CLOCK_POLICY: Readonly<ClockPolicy> = Object.freeze({ minTransitWallMs: 400, ignoreBackground: true });

/** @since P1 Worker playback mode. 'simulation' = pause-at-event learning mode (the engine FidelityMode is unrelated). */
export type PlaybackMode = 'realtime' | 'simulation';

/** @since P0.5 Delta form of SimSnapshot: valid only when `topologyVersion` equals the store's; all non-device/link fields complete. */
export type SnapshotDelta = Omit<SimSnapshot, 'devices' | 'links'> & {
  /** Changed devices (full objects), in snapshot order. */
  devices: DeviceSnapshot[];
  /** Present only when any link changed (full list). */
  links?: LinkSnapshot[];
};

/** @since P1 Simulation-mode filters. */
export interface SimModeFilters {
  /** Rows shown in the sim-events list and frames that keep slow motion. */
  list: TraceFilter;
  /** Pause (breakpoint) when matched while playing; null = none. */
  breakOn: TraceFilter | null;
}

/** @since P1 Filters simulation mode starts from (§4.11 item 1): the three kinds a CCNA learner steps through. */
export const DEFAULT_SIM_FILTERS: Readonly<SimModeFilters> = Object.freeze({
  list: Object.freeze({ kinds: ['frameTx', 'drop', 'tableWrite'], includeBackground: false }) as TraceFilter,
  breakOn: null,
});

/**
 * @since P1 Result of a run that may stop on a match (`runUntilStop`, `stepToNext`). The batch posted by the same
 * call carries the identical `stopped` value, so a listener and a caller never disagree.
 */
export interface RunStopResult {
  snapshot: SimSnapshot;
  /** Null when the run finished without a match. */
  stopped: StopInfo | null;
  /** Why a `stepToNext` found nothing (§4.11 item 4); absent when `stopped` is set. */
  ended?: 'horizon' | 'maxEvents' | 'idle';
}

/** @since P1 Where a breakpoint or a step stopped the clock. */
export interface StopInfo {
  cursor: number;
  event: TraceEvent;
  reason: 'breakpoint' | 'step';
}

export interface EngineBatch {
  /**
   * Simulation generation. Bumped by the worker whenever the simulation is rebuilt or
   * reloaded (init, reset, loadTopology, loadScenario). PDU and session ids restart per
   * generation, so the store drops all engine-mirrored history when this changes.
   */
  epoch: number;
  now: SimTime;
  /** Trace events since the previous batch, in order (capped at MAX_EVENTS_PER_BATCH from P0.5). */
  events: TraceEvent[];
  /**
   * Included when structure changed, after step/runToIdle/reset/loadTopology, on every CLI
   * exec/interrupt while paused (so console config shows up in the inspector at once), or every
   * ~250 ms of wall time while playing (P0; P0.5 sends `delta` instead while playing).
   */
  snapshot?: SimSnapshot;
  playing: boolean;
  rate: number;
  /**
   * Sim ns per wall ms in force when the batch was posted (not a slice average). Equals rate×1e6
   * when idle or paused, lower while the ClockPolicy clamp is active. The status bar shows it as "slow-motion ×N"; the canvas
   * uses it to extrapolate `now` between batches.
   */
  effectiveRate: number;
  /** Trace events dropped from the ring since last batch (UI shows a warning). */
  dropped: number;

  // ── P0.5 / P1 ──
  /** @since P0.5 Mutually exclusive with `snapshot`. */
  delta?: SnapshotDelta;
  /** @since P1 */
  playbackMode?: PlaybackMode;
  /** @since P1 Trace ring head after this batch (sim-events paging). */
  traceHead?: number;
  /** @since P0.5 Events not included because of the per-batch cap (use traceQuery). */
  eventsTruncated?: number;
  /** @since P1 Set when a breakpoint or stepToNext stopped the clock. */
  stopped?: StopInfo;
  /** @since P1 Live/imported capture heads that advanced. */
  captureHeads?: Record<CaptureId, number>;
  /** @since P1 Latest lab status when it changed (null = no active lab). */
  lab?: LabStatus | null;

  // ── P2 [SHOULD S1] time travel (both optional by meaning) ──
  /**
   * @since P2 (optional by meaning) Set while reviewing the past: snapshot/delta and `now` come from the cursor
   * replay and apply as today; `events` go to `timeline.reviewEvents`, never to the store's `events`; the epoch does
   * not change. `null` ends review (the batch carries a full live snapshot that restores the mirror).
   */
  review?: ReviewInfo | null;
  /** @since P2 (optional by meaning) The live head of the timeline (the scrubber's right end). */
  timelineHead?: { t: SimTime; at: JournalPosition; lanesRevision: number };
}

/** @since P2 [SHOULD S1] Where review is: the cursor replay's position and time, the live position, and whether they meet. */
export interface ReviewInfo {
  at: JournalPosition;
  t: SimTime;
  live: JournalPosition;
  atLive: boolean;
}

/** Result of `init`. */
export interface InitResult {
  catalog: DeviceModel[];
  /** @since P0.5 Module catalog (Physical panel). */
  modules: ModuleModel[];
  /** @since P0.5 Media table (cable picker), in MEDIA key order. */
  media: MediaSpec[];
  /** @since P0.5 */
  engineVersion: string;
}

/** @since P0.5 */
export interface SubscribeOptions {
  /** Always delta-refresh these devices even without trace activity (the inspected device). */
  watchDevices?: DeviceId[];
  /** Max events per batch (default MAX_EVENTS_PER_BATCH). */
  maxEventsPerBatch?: number;
}

export type BatchListener = (batch: EngineBatch) => void;

export interface EngineApi {
  /**
   * `profile` @since P2 (optional by meaning; default 'P1'). The CALLER chooses it from the course context (D2): the
   * web shell passes profileForCourse(lastCourse) (learn/course-profile.ts: 'P1' for CCNA 1, else 'P2').
   */
  init(opts: { seed: number; profile?: DefaultsProfile }): Promise<InitResult>;

  // topology
  /**
   * P0.5: rejects with an Error whose `name === 'TopologyLoadError'` and which carries
   * `problems: TopologyLoadProblem[]` (see bridge/errors.ts `EngineError`); the world is unchanged on failure.
   */
  loadTopology(t: Topology): Promise<SimSnapshot>;
  exportTopology(): Promise<Topology>;
  /** Built-in templates and labs (`scenarioMeta` of the engine's scenario registry). */
  listScenarios(): Promise<ScenarioMeta[]>;
  /**
   * P1: resets to the scenario seed when `meta.seed` is set (`opts.seed` overrides it, for a lab restarted with a
   * different world). Activates the lab when the scenario has tasks. Rejects like loadTopology (an Error named
   * 'TopologyLoadError' carrying `problems`, world unchanged), or with an original message when the scenario's
   * `missingTypes` is non-empty.
   */
  loadScenario(name: string, opts?: { seed?: number }): Promise<SimSnapshot>;
  addDevice(spec: AddDeviceSpec): Promise<DeviceId>;
  removeDevice(id: DeviceId): Promise<void>;
  renameDevice(id: DeviceId, name: string): Promise<void>;
  moveDevice(id: DeviceId, position: { x: number; y: number }): Promise<void>;
  setPower(id: DeviceId, on: boolean): Promise<void>;
  validateLink(spec: AddLinkSpec): Promise<CableValidation>;
  addLink(spec: AddLinkSpec): Promise<LinkId>;
  removeLink(id: LinkId): Promise<void>;
  setImpairments(id: LinkId, imp: Partial<Impairments>): Promise<LinkState | undefined>;
  /** @since P0.5 D7; posts a batch with a snapshot (topologyVersion bumped on success). */
  insertModule(device: DeviceId, slot: SlotId, module: ModuleType): Promise<HardwareResult>;
  /** @since P0.5 */
  removeModule(device: DeviceId, slot: SlotId): Promise<HardwareResult>;
  /** @since P0.5 */
  setDeviceUi(device: DeviceId, ui: TopologyDeviceUi): Promise<void>;
  /** @since P0.5 Metres per canvas unit. */
  setCanvasScale(metresPerUnit: number): Promise<void>;
  /** @since P1 Evaluate the active lab now; null when no lab is loaded. Posts a batch carrying `lab`. */
  checkLab(): Promise<LabStatus | null>;

  // cli
  cliOpen(device: DeviceId, via: 'console' | 'vty'): Promise<CliSessionView>;
  cliExec(session: SessionId, line: string): Promise<CliResult>;
  cliComplete(session: SessionId, partial: string): Promise<CliCompletion>;
  cliHelp(session: SessionId, partial: string): Promise<CliCompletion>;
  cliInterrupt(session: SessionId): Promise<void>;
  cliClose(session: SessionId): Promise<void>;
  /** @since P0.5 */
  cliCanOpen(device: DeviceId, via: 'console' | 'vty'): Promise<{ ok: true } | { ok: false; reason: string }>;

  // gui
  /** @since P0.5 D9 headless configure; posts a batch with a delta for `device` afterwards. */
  configure(device: DeviceId, commands: string[], opts?: ConfigureOptions): Promise<ConfigureResult>;
  /** @since P0.5 Non-config GUI actions; results appear in process StateViews. */
  hostRequest(device: DeviceId, req: HostAppRequest): Promise<HostAppTicket>;

  // clock
  play(): Promise<void>;
  pause(): Promise<void>;
  setRate(rate: number): Promise<void>;
  setClockPolicy(p: Partial<ClockPolicy>): Promise<void>;
  /** Advance by exactly one scheduler event. Pauses first if playing. */
  stepEvent(): Promise<SimSnapshot>;
  /** Advance by `dt` sim ns. Pauses first if playing. */
  stepTime(dt: SimTime): Promise<SimSnapshot>;
  /** Run until the queue is idle or the cap is hit (used by "run to idle" and tests). Pauses first if playing. */
  runToIdle(maxEvents?: number): Promise<SimSnapshot>;
  /** @since P1 Switching to 'simulation' pauses; switching to 'realtime' clears `breakOn` (§4.11 item 6). */
  setPlaybackMode(mode: PlaybackMode): Promise<void>;
  /** @since P1 */
  setSimFilters(f: SimModeFilters): Promise<void>;
  /**
   * @since P1 Pause, then `stepToNext(filter ?? filters.list, {until: now + SIM_STEP_HORIZON_NS, maxEvents:
   * SIM_STEP_MAX_EVENTS})`. `ended` is set when `stopped` is null: 'maxEvents' if the run stopped on the cap,
   * 'idle' if no event is pending, otherwise 'horizon' (UI: "No matching event in the next 10 s").
   */
  stepToNext(filter?: TraceFilter): Promise<RunStopResult>;
  /**
   * @since P1 Pause, then `runUntil(t, {stopOn})`. Used by the sim-mode "run to the next breakpoint" control and by
   * the acceptance test: the batch it posts carries `stopped {reason:'breakpoint'}` and a snapshot (§10.2
   * accept.p1.sim-mode-dhcp-offer). `ended` is never set.
   */
  runUntilStop(t: SimTime, stopOn: TraceFilter): Promise<RunStopResult>;

  // observation
  snapshot(): Promise<SimSnapshot>;
  pdu(id: PduId): Promise<PduJson | undefined>;
  /** Register the batch listener (Comlink.proxy). Only one listener; later calls replace it. `opts` @since P0.5. */
  subscribe(listener: BatchListener, opts?: SubscribeOptions): Promise<void>;
  /**
   * Reset to an empty simulation with a new seed. `profile` @since P2 (optional by meaning; default 'P1'): File → New
   * passes the course context's profile; entering the sandbox from a lesson while the world has no devices passes that
   * lesson's course profile (D2).
   */
  reset(seed: number, profile?: DefaultsProfile): Promise<SimSnapshot>;
  /**
   * @since P2 "Use current defaults" (File menu, D2): export → write `ip routing` on devices whose P2 profileConfig
   * holds `no ip routing` and whose running config has no `ip routing` line → profile 'P2' and schema =
   * schemaIdFor(t) → load; epoch++. Pauses first; the batch it posts carries a full snapshot (and the lab status when
   * the document names a lab). Required since W2 web-shell.
   */
  useCurrentDefaults(): Promise<SimSnapshot>;

  // time travel — P2 [SHOULD S1]; optional in the type until the W4 web-shell item implements them
  /** @since P2 Enter (or move within) review at `target`; the replayed events are counted, not timed. */
  seek?(target: SeekTarget): Promise<{ snapshot: SimSnapshot; review: ReviewInfo; replayedEvents: number }>;
  /** @since P2 End review; resolves with the live snapshot. */
  leaveReview?(): Promise<SimSnapshot>;
  /** @since P2 Bucketed lane activity for the timeline strip. */
  timelineBuckets?(q: TimelineQuery): Promise<LaneBucket[]>;
  /** @since P2 Individual marks of one lane. */
  timelineMarks?(q: TimelineMarkQuery): Promise<{ cursor: number; t: SimTime; lane: LaneId; event: TraceEvent }[]>;
  /** @since P2 Change the time machine's memory budget ("history off" = no replayers). */
  setTimeTravelBudget?(b: Partial<TimeTravelBudget>): Promise<void>;
  /** @since P1 Page the trace ring (sim-events list; the store's 5000-event ring is never used for it). */
  traceQuery(q: TraceQuery): Promise<TraceQueryResult>;
  /** @since P0.5 */
  setWatchedDevices(ids: DeviceId[]): Promise<void>;

  // capture (live ids c_*, imported ids i_*) — P1
  /** The info of the new capture; `info.id` is the CaptureId every other capture call takes. */
  startCapture(spec: CaptureSpec): Promise<CaptureInfo>;
  stopCapture(id: CaptureId): Promise<void>;
  removeCapture(id: CaptureId): Promise<void>;
  /** Live captures of this simulation first, then imported ones. */
  captures(): Promise<CaptureInfo[]>;
  /** Alias of `captures()` (both names are in use across the P1 web waves). */
  listCaptures(): Promise<CaptureInfo[]>;
  queryCapture(id: CaptureId, q: CaptureQuery): Promise<CaptureQueryResult>;
  captureRecord(id: CaptureId, index: number): Promise<CaptureRecordDetail | undefined>;
  followStream(id: CaptureId, key: string): Promise<FollowStreamResult>;
  captureStats(id: CaptureId, filter?: string): Promise<CaptureStatistics>;
  /** Result transferred (Comlink.transfer). The UI passes `baseWallNs = BigInt(Date.now()) * 1_000_000n`. */
  exportCapture(id: CaptureId, opts: CaptureExportOptions): Promise<Uint8Array>;
  /** Parsed in the worker; rejects with an original message on malformed/oversized input. */
  importCapture(bytes: Uint8Array, name: string): Promise<CaptureInfo>;
}

export const RATE_PRESETS = [0.001, 0.01, 0.1, 0.5, 1, 2, 5, 10, 100, 1000] as const;
/** Delta/snapshot cadence while playing (ms of wall time). */
export const SNAPSHOT_EVERY_MS = 250;
/** @since P0.5 Full snapshot at least this often while playing (ms). */
export const FULL_SNAPSHOT_EVERY_MS = 2000;
/** @since P0.5 */
export const MAX_EVENTS_PER_BATCH = 20_000;
/** @since P1 Max sim time one stepToNext() may advance (10 s). */
export const SIM_STEP_HORIZON_NS = 10_000_000_000;
/** @since P1 stepToNext() event cap. */
export const SIM_STEP_MAX_EVENTS = 20_000;
