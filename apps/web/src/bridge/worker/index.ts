/**
 * Engine worker: hosts the `Simulation`, owns the clock (clock.ts), batches trace events with snapshots or deltas
 * (batch.ts, delta.ts) and exposes `EngineApi` through Comlink (protocol.ts; ARCHITECTURE-P1 §3.14).
 *
 * Generations: `epoch` is bumped on init, reset and every successful loadTopology/loadScenario. A failed load
 * (`TopologyLoadError`, thrown before the world is replaced) leaves the epoch and the world untouched; the
 * rejection carries `problems` across the boundary through the shared 'throw' handler in ../errors.ts.
 *
 * Posting rules (protocol.ts header, §12 item 24):
 *   - structural calls (add/remove device or link, modules, load, reset, step, run to idle) post a full snapshot;
 *   - every other mutating call always posts: a delta for its explicit targets plus the event-derived dirty set;
 *   - `cliExec`/`cliInterrupt` while paused post a full snapshot, so console edits show in the inspector at once
 *     (P0 guarantee kept); while playing they ride the delta cadence;
 *   - while playing, the clock tick posts deltas every SNAPSHOT_EVERY_MS and a full snapshot at least every
 *     FULL_SNAPSHOT_EVERY_MS.
 * Moving a radio device while paused runs `runUntil(now)` so the coalesced `deviceMoved` event dispatches.
 *
 * P1 (§4.11–§4.13): three modules hang off this one. `sim-mode.ts` holds the playback mode and the two trace
 * filters — while playing in simulation mode every slice carries `{stopOn: breakOn}`, and a stop pauses the clock
 * and posts a full snapshot with `stopped {reason:'breakpoint'}`. `captures.ts` owns every capture call (live ones
 * belong to the Simulation, imported ones to its library) and reports the heads that advanced. `labs.ts` keeps the
 * active `ScenarioInfo` and grades it — automatically at most every 2 s after a relevant event, or on demand.
 * `annotate` is where those three decorate each outgoing batch.
 */
import * as Comlink from 'comlink';
import '../errors';
import { MEDIA, SCENARIOS, createSimulation, hasRadioPort, scenarioMeta } from '@netforge/engine';
import type {
  AddDeviceSpec,
  AddLinkSpec,
  CaptureExportOptions,
  CaptureId,
  CaptureQuery,
  CaptureSpec,
  ConfigureOptions,
  DeviceId,
  HostAppRequest,
  Impairments,
  LabStatus,
  LinkId,
  ModuleType,
  PduId,
  ScenarioInfo,
  ScenarioMeta,
  SessionId,
  SimSnapshot,
  SimTime,
  Simulation,
  SlotId,
  Topology,
  TopologyDeviceUi,
  TraceFilter,
  TraceQuery,
} from '@netforge/engine';
import type { BatchListener, ClockPolicy, EngineApi, EngineBatch, PlaybackMode, RunStopResult, SimModeFilters, StopInfo, SubscribeOptions } from '../protocol';
import { createBatcher, type PostOptions } from './batch';
import { createWorkerClock } from './clock';
import { createWorkerCaptures } from './captures';
import { createWorkerLabs } from './labs';
import { createSimMode, endedOf, stepOptions, stopInfoOf } from './sim-mode';

/** Clock tick period (wall ms). */
export const TICK_MS = 16;
/** A backgrounded tab throttles timers; never try to catch up more than this per slice. */
export const MAX_SLICE_WALL_MS = 250;
/** Reported by `init`. */
export const ENGINE_VERSION = 'netforge-engine/0.5.0';

let sim: Simulation | undefined;
let unsubscribeTrace: (() => void) | undefined;
let epoch = 0;
let lastTickWall = 0;
let timer: ReturnType<typeof setInterval> | undefined;

const clock = createWorkerClock();
const simMode = createSimMode();
const labs = createWorkerLabs();

function requireSim(): Simulation {
  if (!sim) throw new Error('The engine has not been initialised yet (call init first).');
  return sim;
}

const captures = createWorkerCaptures(requireSim);

/** A lab status this call wants on its batch (load, checkLab); `null` means "no lab is active any more". */
let pendingLab: LabStatus | null | undefined;

const batcher = createBatcher({
  sim: requireSim,
  epoch: () => epoch,
  playing: () => clock.playing,
  rate: () => clock.rate,
  effectiveRate: (now) => clock.currentRate(now),
  wallNow: () => performance.now(),
  annotate,
});

/** The P1 fields that belong to the worker rather than to one call (protocol.ts EngineBatch). */
function annotate(batch: EngineBatch): void {
  batch.playbackMode = simMode.mode;
  const heads = captures.advanced();
  if (heads !== undefined) batch.captureHeads = heads;
  if (pendingLab !== undefined) {
    batch.lab = pendingLab;
    pendingLab = undefined;
    return;
  }
  const status = labs.maybeCheck(requireSim(), batch.events, performance.now());
  if (status !== null) batch.lab = status;
}

function post(opts: PostOptions = {}): SimSnapshot | undefined {
  return batcher.post(opts);
}

/** Post a batch that carries a fresh full snapshot and return that snapshot. */
function postFull(stopped?: StopInfo): SimSnapshot {
  const opts: PostOptions = { full: true, force: true };
  if (stopped !== undefined) opts.stopped = stopped;
  const snap = batcher.post(opts);
  if (snap === undefined) throw new Error('The engine could not take a snapshot.');
  return snap;
}

/** Explicit dirty marks for calls whose effect may emit no dirtying event, then an always-posted batch. */
function postMutation(devices: readonly DeviceId[] = [], links = false): void {
  batcher.dirty.markDevices(devices);
  if (links) batcher.dirty.markLinks();
  batcher.post({ mutation: true });
}

// ── simulation lifecycle ─────────────────────────────────────────────────────

function attach(s: Simulation): void {
  unsubscribeTrace?.();
  sim = s;
  epoch++;
  clock.clear();
  batcher.reset(true);
  // Live captures went with the previous world; imported ones stay in the library.
  captures.reset();
  unsubscribeTrace = s.onTrace((ev) => clock.observe(ev));
}

function buildSim(seed: number): Simulation {
  const s = createSimulation({ seed });
  attach(s);
  labs.activate(undefined);
  pendingLab = null;
  return s;
}

/** Frames on media after anything that resets time or cancels legs (load, removals, power). */
function resyncInflight(s: Simulation): void {
  clock.resync(s.snapshot({ devices: [] }).inflight);
}

function ensureTimer(): void {
  if (timer === undefined) {
    lastTickWall = performance.now();
    timer = setInterval(tick, TICK_MS);
  }
}

function pauseInternal(): void {
  if (!clock.playing) return;
  clock.setPlaying(false);
}

function tick(): void {
  const wall = performance.now();
  const elapsed = Math.min(MAX_SLICE_WALL_MS, Math.max(0, wall - lastTickWall));
  lastTickWall = wall;
  if (!clock.playing || !sim) return;
  try {
    const run = simMode.runOptions();
    let stopped: StopInfo | undefined;
    if (run?.stopOn === undefined) {
      clock.runSlice(sim, elapsed);
    } else {
      clock.runSlice(sim, elapsed, {
        stopOn: run.stopOn,
        onStop: (stats) => {
          stopped = stopInfoOf(stats, 'breakpoint') ?? undefined;
        },
      });
    }
    // §4.11 item 3: a breakpoint pauses and posts a snapshot with the event it stopped on.
    if (stopped !== undefined) {
      clock.setPlaying(false);
      postFull(stopped);
      return;
    }
    post();
  } catch (err) {
    // A fault inside the engine must surface, not silently freeze the clock.
    clock.setPlaying(false);
    try {
      post({ full: true, force: true });
    } catch {
      /* the sim is broken beyond snapshotting; the UI notices through `playing` on the next call */
    }
    throw err;
  }
}

/** Load into the live simulation (atomic in the engine): flush old-generation events first, bump epoch after. */
function loadInto(s: Simulation, t: Topology): void {
  post();
  s.loadTopology(t);
  epoch++;
  batcher.reset(false);
  captures.reset();
  resyncInflight(s);
}

/** The scenario's world, tagged with the lab section the engine round-trips (§4.13 step 2). */
function labTopology(sc: ScenarioInfo): Topology {
  const topo = sc.build();
  return (sc.tasks?.length ?? 0) > 0 ? { ...topo, lab: { name: sc.name, version: sc.version ?? 1 } } : topo;
}

/** Scheduled (usually hidden) faults of a lab, applied after the world is in place (§4.13 step 3). */
function applyFaults(s: Simulation, sc: ScenarioInfo): void {
  for (const f of sc.faults ?? []) s.injectFault(f.at, f.fault);
}

/** Activate `sc` (or the lab a reopened document names) and make the next batch carry its status. */
function activateLab(s: Simulation, sc: ScenarioInfo | undefined): void {
  labs.activate(sc);
  pendingLab = labs.check(s);
}

function missingTypes(s: Simulation, meta: ScenarioMeta): string[] {
  return (meta.requires ?? []).filter((type) => s.catalog.get(type) === undefined);
}

function scenarioList(s: Simulation): ScenarioMeta[] {
  return SCENARIOS.map((sc: ScenarioInfo) => {
    const meta = scenarioMeta(sc);
    const missing = missingTypes(s, meta);
    return missing.length > 0 ? { ...meta, missingTypes: missing } : meta;
  });
}

function devicesWithRadios(s: Simulation): DeviceId[] {
  return s.devices().filter((d) => hasRadioPort(d)).map((d) => d.id);
}

function linkEnds(s: Simulation, id: LinkId): DeviceId[] {
  const l = s.link(id);
  return l === undefined ? [] : [l.a.device, l.b.device];
}

// ── api ──────────────────────────────────────────────────────────────────────

const api: EngineApi = {
  async init({ seed }) {
    const s = buildSim(seed);
    ensureTimer();
    return {
      catalog: [...s.catalog.list()],
      modules: [...s.catalog.modules()],
      media: Object.values(MEDIA),
      engineVersion: ENGINE_VERSION,
    };
  },

  // topology
  async loadTopology(t: Topology) {
    const s = requireSim();
    loadInto(s, t);
    // Reopening a saved lab: the document's `lab` section names it (§4.13).
    activateLab(s, t.lab === undefined ? undefined : SCENARIOS.find((x) => x.name === t.lab?.name));
    return postFull();
  },
  async exportTopology() {
    return requireSim().exportTopology();
  },
  async listScenarios() {
    return scenarioList(requireSim());
  },
  async loadScenario(name: string, opts?: { seed?: number }) {
    const sc = SCENARIOS.find((x) => x.name === name);
    if (!sc) throw new Error(`There is no template called "${name}".`);
    const s = requireSim();
    const missing = missingTypes(s, scenarioMeta(sc));
    if (missing.length > 0) {
      throw new Error(`"${sc.title}" needs devices this build does not include: ${missing.join(', ')}.`);
    }
    const seed = opts?.seed ?? sc.seed;
    const topo = labTopology(sc);
    let target = s;
    if (seed !== undefined && seed !== s.seed) {
      // Build and load into a fresh simulation first, so a failed load leaves the current world in place.
      const fresh = createSimulation({ seed });
      fresh.loadTopology(topo);
      pauseInternal();
      attach(fresh);
      resyncInflight(fresh);
      target = fresh;
    } else {
      loadInto(s, topo);
    }
    applyFaults(target, sc);
    activateLab(target, sc);
    return postFull();
  },
  async addDevice(spec: AddDeviceSpec) {
    const id = requireSim().addDevice(spec);
    post({ full: true, force: true });
    return id;
  },
  async removeDevice(id: DeviceId) {
    const s = requireSim();
    s.removeDevice(id);
    resyncInflight(s);
    post({ full: true, force: true });
  },
  async renameDevice(id: DeviceId, name: string) {
    requireSim().renameDevice(id, name);
    postMutation([id]);
  },
  async moveDevice(id: DeviceId, position) {
    const s = requireSim();
    s.moveDevice(id, position);
    // A radio device schedules `deviceMoved` at now; dispatch it at once while paused.
    if (!clock.playing) s.runUntil(s.now);
    postMutation([id]);
  },
  async setPower(id: DeviceId, on: boolean) {
    const s = requireSim();
    s.setPower(id, on);
    resyncInflight(s);
    postMutation([id]);
  },
  async validateLink(spec: AddLinkSpec) {
    return requireSim().validateLink(spec);
  },
  async addLink(spec: AddLinkSpec) {
    const id = requireSim().addLink(spec);
    post({ full: true, force: true });
    return id;
  },
  async removeLink(id: LinkId) {
    const s = requireSim();
    s.removeLink(id);
    resyncInflight(s);
    post({ full: true, force: true });
  },
  async setImpairments(id: LinkId, imp: Partial<Impairments>) {
    const s = requireSim();
    s.setImpairments(id, imp);
    postMutation(linkEnds(s, id), true);
    return s.link(id);
  },
  async insertModule(device: DeviceId, slot: SlotId, module: ModuleType) {
    const result = requireSim().insertModule(device, slot, module);
    post({ full: true, force: true });
    return result;
  },
  async removeModule(device: DeviceId, slot: SlotId) {
    const s = requireSim();
    const result = s.removeModule(device, slot);
    resyncInflight(s);
    post({ full: true, force: true });
    return result;
  },
  async setDeviceUi(device: DeviceId, ui: TopologyDeviceUi) {
    requireSim().setDeviceUi(device, ui);
    postMutation([device]);
  },
  async setCanvasScale(metresPerUnit: number) {
    const s = requireSim();
    s.setCanvasScale(metresPerUnit);
    postMutation(devicesWithRadios(s), true);
  },
  async checkLab() {
    const s = requireSim();
    const status = labs.check(s);
    pendingLab = status;
    post({ mutation: true });
    return status;
  },

  // cli
  async cliOpen(device: DeviceId, via) {
    const s = requireSim();
    const id = s.cli.open(device, via);
    const view = s.cli.session(id);
    if (!view) throw new Error('The console session could not be opened.');
    postMutation([device]);
    return view;
  },
  async cliExec(session: SessionId, line: string) {
    const result = requireSim().cli.exec(session, line);
    // While paused (step-debugging) config changes must reach the inspector immediately.
    if (clock.playing) post({ mutation: true });
    else post({ full: true, force: true });
    return result;
  },
  async cliComplete(session: SessionId, partial: string) {
    return requireSim().cli.complete(session, partial);
  },
  async cliHelp(session: SessionId, partial: string) {
    return requireSim().cli.help(session, partial);
  },
  async cliInterrupt(session: SessionId) {
    requireSim().cli.interrupt(session);
    if (clock.playing) post({ mutation: true });
    else post({ full: true, force: true });
  },
  async cliClose(session: SessionId) {
    const s = requireSim();
    const device = s.cli.session(session)?.device;
    s.cli.close(session);
    postMutation(device === undefined ? [] : [device]);
  },
  async cliCanOpen(device: DeviceId, via) {
    return requireSim().cli.canOpen(device, via);
  },

  // gui
  async configure(device: DeviceId, commands: string[], opts?: ConfigureOptions) {
    const result = requireSim().configure(device, commands, opts);
    postMutation([device]);
    return result;
  },
  async hostRequest(device: DeviceId, req: HostAppRequest) {
    const s = requireSim();
    if (typeof s.hostRequest !== 'function') {
      throw new Error('This action is not available in this release of the engine.');
    }
    const ticket = s.hostRequest(device, req);
    postMutation([device]);
    return ticket;
  },

  // clock
  async play() {
    requireSim();
    if (clock.playing) return;
    clock.setPlaying(true);
    lastTickWall = performance.now();
    ensureTimer();
    post({ force: true });
  },
  async pause() {
    requireSim();
    pauseInternal();
    post({ force: true });
  },
  async setRate(r: number) {
    clock.setRate(r);
    if (sim) post({ force: true });
  },
  async setClockPolicy(p: Partial<ClockPolicy>) {
    clock.setPolicy(p);
  },
  async stepEvent() {
    const s = requireSim();
    pauseInternal();
    s.step();
    clock.prune(s.now);
    return postFull();
  },
  async stepTime(dt: SimTime) {
    const s = requireSim();
    pauseInternal();
    const step = Math.round(dt);
    if (!Number.isFinite(step) || step < 0) throw new RangeError(`Step must be a non-negative duration, got ${dt}.`);
    s.runFor(step);
    clock.prune(s.now);
    return postFull();
  },
  async runToIdle(maxEvents?: number) {
    const s = requireSim();
    pauseInternal();
    s.runToIdle(maxEvents);
    clock.prune(s.now);
    return postFull();
  },

  // simulation mode (§4.11)
  async setPlaybackMode(mode: PlaybackMode) {
    simMode.setMode(mode);
    // Simulation mode is a paused, step-by-step mode: entering it stops the clock.
    if (mode === 'simulation') pauseInternal();
    clock.setClampFilter(simMode.clampFilter());
    if (sim) post({ force: true });
  },
  async setSimFilters(f: SimModeFilters) {
    simMode.setFilters(f);
    clock.setClampFilter(simMode.clampFilter());
    if (sim) post({ force: true });
  },
  async stepToNext(filter?: TraceFilter): Promise<RunStopResult> {
    const s = requireSim();
    pauseInternal();
    const stats = s.stepToNext(filter ?? simMode.filters.list, stepOptions(s.now));
    clock.prune(s.now);
    resyncInflight(s);
    const stopped = stopInfoOf(stats, 'step');
    const snapshot = postFull(stopped ?? undefined);
    return stopped === null ? { snapshot, stopped, ended: endedOf(stats, s.nextEventTime()) } : { snapshot, stopped };
  },
  async runUntilStop(t: SimTime, stopOn: TraceFilter): Promise<RunStopResult> {
    const s = requireSim();
    pauseInternal();
    const target = Math.round(t);
    if (!Number.isFinite(target)) throw new RangeError(`Run target must be a finite sim time, got ${t}.`);
    const stats = s.runUntil(target, { stopOn });
    clock.prune(s.now);
    resyncInflight(s);
    const stopped = stopInfoOf(stats, 'breakpoint');
    const snapshot = postFull(stopped ?? undefined);
    return { snapshot, stopped };
  },

  // observation
  async snapshot() {
    return requireSim().snapshot();
  },
  async pdu(id: PduId) {
    return requireSim().pdu(id)?.toJSON();
  },
  async subscribe(cb: BatchListener, opts?: SubscribeOptions) {
    batcher.setListener(cb, opts);
  },
  async reset(seed: number) {
    pauseInternal();
    buildSim(seed);
    ensureTimer();
    return postFull();
  },
  async setWatchedDevices(ids: DeviceId[]) {
    batcher.setWatched(ids);
    if (sim && ids.length > 0) postMutation(ids);
  },
  async traceQuery(q: TraceQuery) {
    return requireSim().traceQuery(q);
  },

  // capture (§4.12) — every call goes through the capture desk, which routes live vs imported by id
  async startCapture(spec: CaptureSpec) {
    const info = captures.start(spec);
    post({ force: true });
    return info;
  },
  async stopCapture(id: CaptureId) {
    captures.stop(id);
    post({ force: true });
  },
  async removeCapture(id: CaptureId) {
    captures.remove(id);
    post({ force: true });
  },
  async captures() {
    return captures.list();
  },
  async listCaptures() {
    return captures.list();
  },
  async queryCapture(id: CaptureId, q: CaptureQuery) {
    return captures.query(id, q);
  },
  async captureRecord(id: CaptureId, index: number) {
    return captures.record(id, index);
  },
  async followStream(id: CaptureId, key: string) {
    return captures.follow(id, key);
  },
  async captureStats(id: CaptureId, filter?: string) {
    return captures.stats(id, filter);
  },
  async exportCapture(id: CaptureId, opts: CaptureExportOptions) {
    const bytes = captures.export(id, opts);
    // Transfer only a buffer this array owns; a view into engine memory is copied instead of detached.
    const owned = bytes.byteOffset === 0 && bytes.buffer.byteLength === bytes.byteLength;
    return owned ? Comlink.transfer(bytes, [bytes.buffer]) : bytes;
  },
  async importCapture(bytes: Uint8Array, name: string) {
    const info = captures.import(bytes, name);
    post({ force: true });
    return info;
  },
};

Comlink.expose(api);
