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
 *
 * P2 (ARCHITECTURE-P2 D2, §2.14; W2 web-shell): a world has a defaults profile. `init` and `reset` build the empty
 * simulation with the profile the CALLER chose from the course context (default 'P1'). `useCurrentDefaults` moves a
 * classic world to the current defaults: export, `withCurrentDefaults` (below), load, epoch++.
 *
 * P2 [SHOULD S1] time travel (ARCHITECTURE-P2 §2.14, §3.13; W4 web-shell): two more modules hang off this one.
 * `lanes.ts` indexes every event the live world emits (through the trace listener, so before the batch cap) into the
 * timeline lanes; `timelineBuckets`/`timelineMarks` answer from it, marks resolving their events from the live ring.
 * `time-machine.ts` keeps the parked replayers and serves review: `seek` pauses the live world, advances a replayer
 * to the target and makes it the cursor; from then on the clock, `snapshot`, `pdu` and every batch read the cursor
 * replay (a second batcher, `reviewBatcher`, whose batches carry `review`), while `traceQuery`, `checkLab` and the
 * captures keep reading the live world. Every call that would change the network rejects with
 * `REPLAY_READ_ONLY_MESSAGE` while a seek or a review is active (`mutable`). `play`/`step` in review drive the
 * cursor replay up to the live position, where review ends by itself (`endReview`: the cursor is re-parked, the
 * live batcher posts a full snapshot with `review: null`). Every batch carries `timelineHead`. The store is never
 * left in a review that is gone (`storeInReview`): a seek or a review advance that fails after the time machine left
 * review (a replay fault, a seek that went wrong) posts the ending batch before the error surfaces (`settleReview`),
 * `leaveReview` posts it whenever the store may still be reviewing, and no live batch is posted while the store
 * believes it reviews. Nothing here ever runs or mutates the live world on behalf of a review.
 */
import * as Comlink from 'comlink';
import '../errors';
import { MEDIA, REPLAY_READ_ONLY_MESSAGE, SCENARIOS, createSimulation, hasRadioPort, scenarioMeta, schemaIdFor } from '@netforge/engine';
import type {
  AddDeviceSpec,
  AddLinkSpec,
  CaptureExportOptions,
  CaptureId,
  CaptureQuery,
  CaptureSpec,
  ConfigureOptions,
  DefaultsProfile,
  DeviceId,
  DeviceModel,
  HostAppRequest,
  Impairments,
  LabStatus,
  LaneId,
  LinkId,
  ModuleType,
  PduId,
  ScenarioInfo,
  ScenarioMeta,
  SeekTarget,
  SessionId,
  SimSnapshot,
  SimTime,
  Simulation,
  SlotId,
  TimeTravelBudget,
  TimelineMarkQuery,
  TimelineQuery,
  Topology,
  TopologyDeviceUi,
  TraceEvent,
  TraceFilter,
  TraceQuery,
} from '@netforge/engine';
import type { BatchListener, ClockPolicy, EngineApi, EngineBatch, PlaybackMode, ReviewInfo, RunStopResult, SimModeFilters, StopInfo, SubscribeOptions } from '../protocol';
import { createBatcher, type Batcher, type PostOptions } from './batch';
import { createWorkerClock, type SliceOptions } from './clock';
import { createWorkerCaptures } from './captures';
import { createWorkerLabs } from './labs';
import { createLaneIndex } from './lanes';
import { createSimMode, endedOf, stepOptions, stopInfoOf } from './sim-mode';
import { REVIEW_EVENTS_PER_BATCH, SeekSupersededError, createTimeMachine } from './time-machine';

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

// ── [S1] the lane index and the time machine ──────────────────────────────────

const lanes = createLaneIndex();
/** Ring cursor of the next event the trace listener will see (the live ring's head, kept in lockstep). */
let laneCursor = 0;

const timeMachine = createTimeMachine({
  sim: requireSim,
  observe: (ev) => clock.observe(ev),
  yieldToHost: () => new Promise((resolve) => setTimeout(resolve, 0)),
});

/** The live head of the timeline (every batch carries it). */
function timelineHead(): EngineBatch['timelineHead'] {
  const s = requireSim();
  return { t: s.now, at: s.position(), lanesRevision: lanes.revision };
}

/** The live ring's head (review batches report it: `traceQuery` answers from the live ring). */
function liveHead(): number {
  return requireSim().traceQuery({ from: 0, limit: 0 }).head;
}

/** Set on the one live batch that ends a review, so it carries `review: null`. */
let endingReview = false;

/**
 * [S1] What the store was last told: true from the first batch that carries a review until the batch that carries
 * `review: null` (or a new world, whose epoch clears the store's review). The time machine can leave review without
 * the worker asking — a seek or a review advance that fails re-parks or drops the cursor (a replay fault, a seek that
 * went wrong) — and the store must never be left mirroring a review that is gone: `settleReview` then posts the ending
 * batch, `leaveReview` always offers the way back, and no live batch reaches a store that believes it is reviewing.
 */
let storeInReview = false;

/**
 * The live world for a call that changes it: rejected while a seek or a review is active (§3.13 step 3), and the
 * journal is marked as grown for the replayers.
 */
function mutable(): Simulation {
  if (timeMachine.busy) throw new Error(REPLAY_READ_ONLY_MESSAGE);
  const s = requireSim();
  timeMachine.markJournalDirty();
  return s;
}

// ── batchers ──────────────────────────────────────────────────────────────────

const batcher = createBatcher({
  sim: requireSim,
  epoch: () => epoch,
  playing: () => clock.playing,
  rate: () => clock.rate,
  effectiveRate: (now) => clock.currentRate(now),
  wallNow: () => performance.now(),
  annotate,
});

/** [S1] Batches of the reviewed instant: the cursor replay's world (its `trace` is the review ring). */
const reviewBatcher = createBatcher({
  sim: () => {
    const view = timeMachine.reviewSim;
    if (view === undefined) throw new Error('There is no review to post from.');
    return view;
  },
  epoch: () => epoch,
  playing: () => clock.playing,
  rate: () => clock.rate,
  effectiveRate: (now) => clock.currentRate(now),
  wallNow: () => performance.now(),
  annotate: annotateReview,
});

/** The batcher every post goes through: the review one while a cursor replay serves review. */
function activeBatcher(): Batcher {
  return timeMachine.reviewing ? reviewBatcher : batcher;
}

/** Review batches carry at most this many events (the newest), whatever the subscriber asked for. */
function reviewSubscribeOptions(opts: SubscribeOptions | undefined): SubscribeOptions {
  const cap = Math.min(opts?.maxEventsPerBatch ?? REVIEW_EVENTS_PER_BATCH, REVIEW_EVENTS_PER_BATCH);
  return { ...(opts ?? {}), maxEventsPerBatch: cap };
}

/** The P1 fields that belong to the worker rather than to one call (protocol.ts EngineBatch). */
function annotate(batch: EngineBatch): void {
  batch.playbackMode = simMode.mode;
  batch.timelineHead = timelineHead();
  if (endingReview) {
    batch.review = null;
    endingReview = false;
    storeInReview = false;
  }
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

/**
 * [S1] A review batch: `review` says where the cursor replay is; `traceHead` stays the live ring's; the dropped and
 * left-out counts of the review ring are not the live stream's and are cleared. No lab is re-graded (the live world
 * cannot change during review), but a status `checkLab` asked for rides along.
 */
function annotateReview(batch: EngineBatch): void {
  batch.playbackMode = simMode.mode;
  batch.timelineHead = timelineHead();
  batch.review = timeMachine.reviewInfo() ?? null;
  storeInReview = batch.review !== null;
  batch.traceHead = liveHead();
  batch.dropped = 0;
  delete batch.eventsTruncated;
  const heads = captures.advanced();
  if (heads !== undefined) batch.captureHeads = heads;
  if (pendingLab !== undefined) {
    batch.lab = pendingLab;
    pendingLab = undefined;
  }
}

/**
 * [S1] True while the store believes it is reviewing but no cursor replay serves review: a seek in flight from inside
 * review (its cursor is not ready yet), or a review the time machine left on its own (settled at once, see
 * `settleReview`). A live batch then would be merged on top of the reviewed instant, so nothing is posted: the seek's
 * own batch (or the ending batch) follows.
 */
function reviewPending(): boolean {
  return storeInReview && !timeMachine.reviewing;
}

function post(opts: PostOptions = {}): SimSnapshot | undefined {
  if (reviewPending()) {
    settleReview();
    return undefined;
  }
  return activeBatcher().post(opts);
}

/** Post a batch that carries a fresh full snapshot and return that snapshot. */
function postFull(stopped?: StopInfo): SimSnapshot {
  const opts: PostOptions = { full: true, force: true };
  if (stopped !== undefined) opts.stopped = stopped;
  const snap = activeBatcher().post(opts);
  if (snap === undefined) throw new Error('The engine could not take a snapshot.');
  return snap;
}

/** Explicit dirty marks for calls whose effect may emit no dirtying event, then an always-posted batch. */
function postMutation(devices: readonly DeviceId[] = [], links = false): void {
  if (reviewPending()) {
    // no live batch on top of a reviewed instant (see `reviewPending`); the marks are the live batcher's own
    batcher.dirty.markDevices(devices);
    if (links) batcher.dirty.markLinks();
    settleReview();
    return;
  }
  const b = activeBatcher();
  b.dirty.markDevices(devices);
  if (links) b.dirty.markLinks();
  b.post({ mutation: true });
}

// ── simulation lifecycle ─────────────────────────────────────────────────────

/** [S1] Index the events a world emitted before the listener was attached (a scenario loaded into a fresh world). */
function seedLanes(s: Simulation): void {
  const drained = s.trace(0);
  drained.events.forEach((ev, i) => lanes.observe(ev, drained.dropped + i));
  laneCursor = drained.next;
}

function observeTrace(ev: TraceEvent): void {
  clock.observe(ev);
  lanes.observe(ev, laneCursor++);
}

function attach(s: Simulation): void {
  unsubscribeTrace?.();
  sim = s;
  epoch++;
  // [S1] the new epoch clears the store's review state
  storeInReview = false;
  clock.clear();
  batcher.reset(true);
  reviewBatcher.reset(true);
  // Live captures went with the previous world; imported ones stay in the library.
  captures.reset();
  // [S1] a new world: a new timeline and a new journal
  lanes.reset();
  timeMachine.reset();
  seedLanes(s);
  unsubscribeTrace = s.onTrace(observeTrace);
}

function buildSim(seed: number, profile: DefaultsProfile | undefined): Simulation {
  // D2: the caller's course-context profile; absent means the classic ('P1') defaults, as for every saved P1 file.
  const s = profile === undefined ? createSimulation({ seed }) : createSimulation({ seed, profile });
  attach(s);
  labs.activate(undefined);
  pendingLab = null;
  return s;
}

/** The line a routing device must show for IPv4 forwarding to be on, and the P2 default that switches it off. */
const IP_ROUTING_LINE = 'ip routing';
const NO_IP_ROUTING_LINE = 'no ip routing';

/**
 * True when a config text already decides the `ip routing` slot with a line of its own — `ip routing` (it routes)
 * or `no ip routing` (the learner switched routing off in the classic world; it must not route after the move).
 */
function decidesIpRouting(text: string | undefined): boolean {
  if (text === undefined) return false;
  return text.split(/\r?\n/).some((line) => {
    const l = line.trim();
    return l === IP_ROUTING_LINE || l === NO_IP_ROUTING_LINE;
  });
}

/**
 * @since P2 The exported world moved to the current defaults (D2 "Use current defaults"), pure:
 *  - every device whose P2 `profileConfig` replays `no ip routing` (a multilayer switch) and whose running
 *    configuration has no `ip routing` line (and no `no ip routing` line either) gets that line appended — it
 *    routed in its classic world and keeps routing once the P2 default is replayed under it (the `ip routing`
 *    slot stores both forms, §5);
 *  - `profile` becomes 'P2' and `schema` the id that can express it (`schemaIdFor`, 1.2), in the same step.
 * `modelOf` resolves a device type to its catalog model (undefined for a type this build lacks: left alone).
 */
export function withCurrentDefaults(t: Topology, modelOf: (type: string) => Pick<DeviceModel, 'profileConfig'> | undefined): Topology {
  const devices = t.devices.map((d) => {
    const replayed = modelOf(d.type)?.profileConfig?.P2 ?? [];
    if (!replayed.some((line) => line.trim() === NO_IP_ROUTING_LINE)) return d;
    const running = d.runningConfig ?? d.config;
    if (decidesIpRouting(running)) return d;
    const base = running === undefined || running === '' ? '' : running.endsWith('\n') ? running : `${running}\n`;
    return { ...d, runningConfig: `${base}${IP_ROUTING_LINE}\n` };
  });
  const next: Topology = { ...t, devices, profile: 'P2' };
  next.schema = schemaIdFor(next);
  return next;
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

/**
 * [S1] The clock slice of review: the cursor replay, which reports the live position as a stop (the filter is never
 * matched by the engine; the driver decides).
 */
const REVIEW_SLICE: SliceOptions = { stopOn: { kinds: [] }, onStop: () => undefined };

function tick(): void {
  const wall = performance.now();
  const elapsed = Math.min(MAX_SLICE_WALL_MS, Math.max(0, wall - lastTickWall));
  lastTickWall = wall;
  if (!sim) return;
  // [S1] background work first: parked replayers catch up with their targets, empty slots refill (never during review)
  try {
    timeMachine.tick();
  } catch (err) {
    // a parked replayer diverged: history is off, and the fault dropped a cursor that served review, so the store
    // must leave review too before the defect surfaces
    settleReview();
    throw err;
  }
  // [S1] a review the time machine left on its own is never left on screen (every failure path settles at once; this
  // is the net under them)
  if (reviewPending()) settleReview();
  if (!clock.playing || timeMachine.seeking) return;
  if (timeMachine.reviewing) {
    reviewTick(elapsed);
    return;
  }
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

/** [S1] Playing in review: the cursor replay moves forward at the clock's pace; at the live position review ends. */
function reviewTick(elapsed: number): void {
  try {
    clock.runSlice(timeMachine.reviewDriver(), elapsed, REVIEW_SLICE);
    if (timeMachine.atLive()) {
      // review ends by itself; the clock keeps playing, now in the present
      endReview();
      return;
    }
    post();
  } catch (err) {
    clock.setPlaying(false);
    // a replay fault ended review in the time machine: the store leaves it too
    settleReview();
    throw err;
  }
}

/**
 * [S1] End review: the cursor replay is re-parked (§3.13 step 5), the clock's legs are the live ones again and the
 * live batcher posts a full snapshot carrying `review: null`, which restores the store's mirror.
 */
function endReview(): SimSnapshot {
  timeMachine.leave();
  const s = requireSim();
  resyncInflight(s);
  clock.prune(s.now);
  endingReview = true;
  return postFull();
}

/**
 * [S1] After a seek or a review advance failed: when the time machine is no longer in review (a fault dropped the
 * cursor, a failed seek re-parked it) but the store still believes it is, post the ending batch — the full live
 * snapshot with `review: null` — so the store returns to the present. A seek still in flight is left alone (its own
 * batch follows).
 */
function settleReview(): void {
  if (storeInReview && !timeMachine.busy) endReview();
}

/** [S1] After a review advance (step, run): the live position ends review, anything else posts the new instant. */
function afterReviewAdvance(): SimSnapshot {
  if (timeMachine.atLive()) return endReview();
  const view = timeMachine.reviewSim;
  if (view !== undefined) clock.prune(view.now);
  return postFull();
}

/** [S1] One review advance (step, run): a failure that ended review is settled with the store before it surfaces. */
function reviewAdvance(advance: () => void): SimSnapshot {
  try {
    advance();
  } catch (err) {
    settleReview();
    throw err;
  }
  return afterReviewAdvance();
}

/** Load into the live simulation (atomic in the engine): flush old-generation events first, bump epoch after. */
function loadInto(s: Simulation, t: Topology): void {
  post();
  // [S1] the world restarts its clock and its journal; the events the load emits are the new timeline's first
  lanes.reset();
  timeMachine.reset();
  s.loadTopology(t);
  epoch++;
  // [S1] the new epoch clears the store's review state
  storeInReview = false;
  batcher.reset(false);
  reviewBatcher.reset(true);
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
  // [S1] the faults are journaled inputs
  timeMachine.markJournalDirty();
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

/** [S1] The review info of the live position itself (a seek that landed on the present). */
function liveReviewInfo(s: Simulation): ReviewInfo {
  const at = s.position();
  return { at, t: s.now, live: at, atLive: true };
}

// ── api ──────────────────────────────────────────────────────────────────────

const api: EngineApi = {
  async init({ seed, profile }) {
    const s = buildSim(seed, profile);
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
    const s = mutable();
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
    const s = mutable();
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
    const id = mutable().addDevice(spec);
    post({ full: true, force: true });
    return id;
  },
  async removeDevice(id: DeviceId) {
    const s = mutable();
    s.removeDevice(id);
    resyncInflight(s);
    post({ full: true, force: true });
  },
  async renameDevice(id: DeviceId, name: string) {
    mutable().renameDevice(id, name);
    postMutation([id]);
  },
  async moveDevice(id: DeviceId, position) {
    const s = mutable();
    s.moveDevice(id, position);
    // A radio device schedules `deviceMoved` at now; dispatch it at once while paused.
    if (!clock.playing) s.runUntil(s.now);
    postMutation([id]);
  },
  async setPower(id: DeviceId, on: boolean) {
    const s = mutable();
    s.setPower(id, on);
    resyncInflight(s);
    postMutation([id]);
  },
  async validateLink(spec: AddLinkSpec) {
    return requireSim().validateLink(spec);
  },
  async addLink(spec: AddLinkSpec) {
    const id = mutable().addLink(spec);
    post({ full: true, force: true });
    return id;
  },
  async removeLink(id: LinkId) {
    const s = mutable();
    s.removeLink(id);
    resyncInflight(s);
    post({ full: true, force: true });
  },
  async setImpairments(id: LinkId, imp: Partial<Impairments>) {
    const s = mutable();
    s.setImpairments(id, imp);
    postMutation(linkEnds(s, id), true);
    return s.link(id);
  },
  async insertModule(device: DeviceId, slot: SlotId, module: ModuleType) {
    const result = mutable().insertModule(device, slot, module);
    post({ full: true, force: true });
    return result;
  },
  async removeModule(device: DeviceId, slot: SlotId) {
    const s = mutable();
    const result = s.removeModule(device, slot);
    resyncInflight(s);
    post({ full: true, force: true });
    return result;
  },
  async setDeviceUi(device: DeviceId, ui: TopologyDeviceUi) {
    mutable().setDeviceUi(device, ui);
    postMutation([device]);
  },
  async setCanvasScale(metresPerUnit: number) {
    const s = mutable();
    s.setCanvasScale(metresPerUnit);
    postMutation(devicesWithRadios(s), true);
  },
  async checkLab() {
    // evaluateLab keeps reading the live world, in review too (§3.13 step 3)
    const s = requireSim();
    const status = labs.check(s);
    pendingLab = status;
    post({ mutation: true });
    return status;
  },

  // cli
  async cliOpen(device: DeviceId, via) {
    const s = mutable();
    const id = s.cli.open(device, via);
    const view = s.cli.session(id);
    if (!view) throw new Error('The console session could not be opened.');
    postMutation([device]);
    return view;
  },
  async cliExec(session: SessionId, line: string) {
    const result = mutable().cli.exec(session, line);
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
    mutable().cli.interrupt(session);
    if (clock.playing) post({ mutation: true });
    else post({ full: true, force: true });
  },
  async cliClose(session: SessionId) {
    const s = mutable();
    const device = s.cli.session(session)?.device;
    s.cli.close(session);
    postMutation(device === undefined ? [] : [device]);
  },
  async cliCanOpen(device: DeviceId, via) {
    return requireSim().cli.canOpen(device, via);
  },

  // gui
  async configure(device: DeviceId, commands: string[], opts?: ConfigureOptions) {
    const result = mutable().configure(device, commands, opts);
    postMutation([device]);
    return result;
  },
  async hostRequest(device: DeviceId, req: HostAppRequest) {
    const s = mutable();
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
    // [S1] in review, play drives the cursor replay (reviewTick); during a seek the first slice waits for it
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
    if (timeMachine.busy) {
      if (!timeMachine.reviewing) throw new Error(REPLAY_READ_ONLY_MESSAGE);
      return reviewAdvance(() => timeMachine.reviewStep());
    }
    s.step();
    clock.prune(s.now);
    return postFull();
  },
  async stepTime(dt: SimTime) {
    const s = requireSim();
    pauseInternal();
    const step = Math.round(dt);
    if (!Number.isFinite(step) || step < 0) throw new RangeError(`Step must be a non-negative duration, got ${dt}.`);
    if (timeMachine.busy) {
      if (!timeMachine.reviewing) throw new Error(REPLAY_READ_ONLY_MESSAGE);
      const view = timeMachine.reviewSim;
      return reviewAdvance(() => {
        if (view !== undefined) timeMachine.reviewRunUntil(view.now + step);
      });
    }
    s.runFor(step);
    clock.prune(s.now);
    return postFull();
  },
  async runToIdle(maxEvents?: number) {
    const s = requireSim();
    pauseInternal();
    if (timeMachine.busy) {
      // the past cannot go idle: the run goes forward to the present, where review ends
      if (!timeMachine.reviewing) throw new Error(REPLAY_READ_ONLY_MESSAGE);
      return reviewAdvance(() => timeMachine.reviewRunToLive());
    }
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
    // [S1] a run of the live world: not while looking at the past
    const s = mutable();
    pauseInternal();
    const stats = s.stepToNext(filter ?? simMode.filters.list, stepOptions(s.now));
    clock.prune(s.now);
    resyncInflight(s);
    const stopped = stopInfoOf(stats, 'step');
    const snapshot = postFull(stopped ?? undefined);
    return stopped === null ? { snapshot, stopped, ended: endedOf(stats, s.nextEventTime()) } : { snapshot, stopped };
  },
  async runUntilStop(t: SimTime, stopOn: TraceFilter): Promise<RunStopResult> {
    const s = mutable();
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
    // [S1] the instant on screen: the cursor replay's while reviewing (a resync must not jump to the present)
    return (timeMachine.reviewSim ?? requireSim()).snapshot();
  },
  async pdu(id: PduId) {
    const s = requireSim();
    return (timeMachine.reviewPdu(id) ?? s.pdu(id))?.toJSON();
  },
  async subscribe(cb: BatchListener, opts?: SubscribeOptions) {
    batcher.setListener(cb, opts);
    reviewBatcher.setListener(cb, reviewSubscribeOptions(opts));
  },
  async reset(seed: number, profile?: DefaultsProfile) {
    mutable();
    pauseInternal();
    buildSim(seed, profile);
    ensureTimer();
    return postFull();
  },
  async useCurrentDefaults() {
    const s = mutable();
    pauseInternal();
    const t = withCurrentDefaults(s.exportTopology(), (type) => s.catalog.get(type));
    loadInto(s, t);
    // The world keeps its lab, exactly as reopening the saved document would (§4.13).
    activateLab(s, t.lab === undefined ? undefined : SCENARIOS.find((x) => x.name === t.lab?.name));
    return postFull();
  },

  // time travel — P2 [SHOULD S1] (§2.14, §3.13)
  async seek(target: SeekTarget) {
    const s = requireSim();
    // the live world is paused; anything it emitted since the last batch goes out as a live batch first
    pauseInternal();
    if (!timeMachine.reviewing) post();
    let result: Awaited<ReturnType<typeof timeMachine.seek>>;
    try {
      result = await timeMachine.seek(target);
    } catch (err) {
      // a seek that failed for its own reasons (a replay fault, a seek that went wrong after it took its replayer) may
      // have ended review in the time machine: the store must hear it. A superseded seek is left to the newer call
      // (the newer seek, or leaveReview) that superseded it.
      if (!(err instanceof SeekSupersededError)) settleReview();
      throw err;
    }
    const { replayedEvents, atLive } = result;
    if (atLive) {
      // the target is the present: nothing to review
      const snapshot = endReview();
      return { snapshot, review: liveReviewInfo(s), replayedEvents };
    }
    const view = timeMachine.reviewSim;
    if (view === undefined) throw new Error('The seek did not produce a review.');
    clock.resync(view.snapshot({ devices: [] }).inflight);
    clock.prune(view.now);
    reviewBatcher.reset(true);
    const snapshot = postFull();
    const review = timeMachine.reviewInfo();
    if (review === undefined) throw new Error('The seek did not produce a review.');
    return { snapshot, review, replayedEvents };
  },
  async leaveReview() {
    const s = requireSim();
    // the way back is always offered: a store still in review hears the present even when the time machine already
    // left review on its own
    if (!timeMachine.busy) return storeInReview ? endReview() : s.snapshot();
    pauseInternal();
    return endReview();
  },
  async timelineBuckets(q: TimelineQuery) {
    requireSim();
    return lanes.buckets(q);
  },
  async timelineMarks(q: TimelineMarkQuery) {
    const s = requireSim();
    const marks = lanes.marks(q);
    const first = marks[0];
    if (first === undefined) return [];
    // one drain of the live ring from the oldest mark; marks the ring no longer retains are left out
    const drained = s.trace(first.cursor);
    const base = drained.next - drained.events.length;
    const out: { cursor: number; t: SimTime; lane: LaneId; event: TraceEvent }[] = [];
    for (const m of marks) {
      const event = drained.events[m.cursor - base];
      if (event !== undefined) out.push({ cursor: m.cursor, t: m.t, lane: m.lane, event });
    }
    return out;
  },
  async setTimeTravelBudget(b: Partial<TimeTravelBudget>) {
    // all or nothing: the time machine checks the whole budget (its lane-entry bound is the lane index's) before it
    // applies any of it, so the lane index can no longer refuse what it accepted
    timeMachine.setBudget(b);
    if (b.laneEntries !== undefined) lanes.setCapacity(b.laneEntries);
  },
  async setWatchedDevices(ids: DeviceId[]) {
    batcher.setWatched(ids);
    reviewBatcher.setWatched(ids);
    if (sim && ids.length > 0) postMutation(ids);
  },
  async traceQuery(q: TraceQuery) {
    // answers from the live ring, in review too (§3.13 step 3)
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
