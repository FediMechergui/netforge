/**
 * Batch assembly (protocol.ts header; ARCHITECTURE-P1 §3.14 "Worker").
 *
 * Every post drains the trace ring since the last cursor, marks dirty devices from the drained events and decides
 * what to attach:
 *   - a FULL snapshot when asked (step, load, reset, structural API calls), when the epoch or topologyVersion
 *     changed since the last full snapshot, when more than 60 % of the devices are dirty, and at least every
 *     FULL_SNAPSHOT_EVERY_MS while playing;
 *   - otherwise a DELTA (dirty devices plus watched devices; the link list only when links changed) every
 *     SNAPSHOT_EVERY_MS while playing and after every mutating API call while paused;
 *   - nothing otherwise.
 * Mutating calls always post (`mutation: true`), playing or paused, so paused edits never go stale (§12 item 24).
 * A batch without events, snapshot or delta is skipped unless forced or due as a keep-alive while playing.
 * At most `maxEventsPerBatch` events are posted (the newest); the rest are counted in `eventsTruncated`.
 */
import type { DeviceId, SimSnapshot, Simulation } from '@netforge/engine';
import {
  FULL_SNAPSHOT_EVERY_MS,
  MAX_EVENTS_PER_BATCH,
  SNAPSHOT_EVERY_MS,
  type BatchListener,
  type EngineBatch,
  type SnapshotDelta,
  type StopInfo,
  type SubscribeOptions,
} from '../protocol';
import { createDirtyTracker, preferFullSnapshot, toDelta, type DirtyTracker } from './delta';

export interface BatchHost {
  sim(): Simulation;
  epoch(): number;
  playing(): boolean;
  rate(): number;
  /** Sim ns per wall ms in force at `now`. */
  effectiveRate(now: number): number;
  /** Wall clock in ms (performance.now in the worker). */
  wallNow(): number;
  /**
   * @since P1 Last word on an assembled batch, before it is delivered: the P1 fields that belong to the worker's
   * own state rather than to a single call (playback mode, capture heads that advanced, a fresh lab status).
   */
  annotate?(batch: EngineBatch): void;
}

export interface PostOptions {
  /** Attach a full snapshot (structure changed, step, reset, load). */
  full?: boolean;
  /** Post even when nothing happened (play/pause/rate changes). */
  force?: boolean;
  /** A mutating API call: always post; attach a delta for the dirty set (or a full snapshot when required). */
  mutation?: boolean;
  /** @since P1 A breakpoint or a step stopped the clock at this event (§4.11 item 3); implies `force`. */
  stopped?: StopInfo;
}

export interface Batcher {
  readonly dirty: DirtyTracker;
  readonly cursor: number;
  readonly watched: readonly DeviceId[];
  setListener(listener: BatchListener | undefined, opts?: SubscribeOptions): void;
  setWatched(ids: readonly DeviceId[]): void;
  /**
   * A new simulation generation: require a full snapshot next and forget the dirty set. `restartCursor` is true for
   * a freshly created Simulation (its ring starts at 0) and false after `loadTopology` on the same Simulation (the
   * ring head stays monotonic across a load).
   */
  reset(restartCursor: boolean): void;
  /** Drain, decide, post. Returns the full snapshot when one was attached. */
  post(opts?: PostOptions): SimSnapshot | undefined;
}

export function createBatcher(host: BatchHost): Batcher {
  let cursor = 0;
  let listener: BatchListener | undefined;
  let maxEvents = MAX_EVENTS_PER_BATCH;
  let watched: DeviceId[] = [];
  /** topologyVersion of the last full snapshot of this epoch; undefined = a full snapshot is required. */
  let lastTopology: number | undefined;
  let lastEpoch = -1;
  let lastFullWall = Number.NEGATIVE_INFINITY;
  let lastSnapshotWall = Number.NEGATIVE_INFINITY;
  let lastPostWall = Number.NEGATIVE_INFINITY;

  const dirty = createDirtyTracker((id) => {
    const l = host.sim().link(id);
    return l === undefined ? undefined : [l.a.device, l.b.device];
  });

  function full(s: Simulation, wall: number): SimSnapshot {
    const snap = s.snapshot();
    dirty.clear();
    lastTopology = snap.topologyVersion;
    lastEpoch = host.epoch();
    lastFullWall = wall;
    lastSnapshotWall = wall;
    return snap;
  }

  return {
    dirty,
    get cursor() {
      return cursor;
    },
    get watched() {
      return watched;
    },
    setListener(l, opts) {
      listener = l;
      if (opts?.maxEventsPerBatch !== undefined) {
        const n = Math.floor(opts.maxEventsPerBatch);
        if (!Number.isFinite(n) || n < 1) throw new RangeError('maxEventsPerBatch must be a positive integer.');
        maxEvents = n;
      }
      if (opts?.watchDevices !== undefined) watched = [...opts.watchDevices];
    },
    setWatched(ids) {
      watched = [...ids];
    },
    reset(restartCursor) {
      if (restartCursor) cursor = 0;
      dirty.clear();
      lastTopology = undefined;
      lastFullWall = Number.NEGATIVE_INFINITY;
      lastSnapshotWall = Number.NEGATIVE_INFINITY;
    },
    post(opts = {}) {
      const s = host.sim();
      const wall = host.wallNow();
      const playing = host.playing();
      const drained = s.trace(cursor);
      cursor = drained.next;
      for (const ev of drained.events) dirty.observe(ev);

      let events = drained.events;
      let truncated = 0;
      if (events.length > maxEvents) {
        truncated = events.length - maxEvents;
        events = events.slice(truncated);
      }

      let snapshot: SimSnapshot | undefined;
      let delta: SnapshotDelta | undefined;
      const needFull =
        opts.full === true ||
        lastTopology === undefined ||
        lastEpoch !== host.epoch() ||
        (playing && wall - lastFullWall >= FULL_SNAPSHOT_EVERY_MS);
      if (needFull) {
        snapshot = full(s, wall);
      } else if (opts.mutation === true || (playing && wall - lastSnapshotWall >= SNAPSHOT_EVERY_MS)) {
        const ids = dirty.devices(watched);
        if (ids.length > 0 || dirty.linksDirty) {
          if (preferFullSnapshot(ids.length, s.devices().length)) {
            snapshot = full(s, wall);
          } else {
            const subset = s.snapshot({ devices: ids });
            if (subset.topologyVersion !== lastTopology) {
              snapshot = full(s, wall);
            } else {
              delta = toDelta(subset, dirty.linksDirty);
              dirty.clear();
              lastSnapshotWall = wall;
            }
          }
        }
      }

      const keepAlive = playing && wall - lastPostWall >= SNAPSHOT_EVERY_MS;
      const force = opts.force === true || opts.mutation === true || opts.stopped !== undefined;
      if (!force && !snapshot && !delta && events.length === 0 && drained.dropped === 0 && truncated === 0 && !keepAlive) {
        return undefined;
      }

      const now = s.now;
      const batch: EngineBatch = {
        epoch: host.epoch(),
        now,
        events,
        playing,
        rate: host.rate(),
        effectiveRate: host.effectiveRate(now),
        dropped: drained.dropped,
        traceHead: cursor,
      };
      if (snapshot) batch.snapshot = snapshot;
      else if (delta) batch.delta = delta;
      if (truncated > 0) batch.eventsTruncated = truncated;
      if (opts.stopped !== undefined) batch.stopped = opts.stopped;
      host.annotate?.(batch);
      lastPostWall = wall;
      if (listener) {
        // Comlink proxies return promises; a failed delivery must not kill the clock.
        try {
          void Promise.resolve(listener(batch)).catch(() => undefined);
        } catch {
          /* a throwing listener is the UI's problem, not the engine's */
        }
      }
      return snapshot;
    },
  };
}
