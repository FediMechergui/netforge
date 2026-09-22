/**
 * Main-thread side of the bridge: a lazily created Comlink remote of the engine worker, `initEngine()` which wires
 * the store (batches, resync requests, watched devices, and the worker clock policy: the View menu's
 * `backgroundFrames` overlay maps to `ClockPolicy.ignoreBackground = !backgroundFrames`, sent once after init and on
 * every toggle, so keepalives and beacons slow the clock enough to be drawn) and the sim-time formatters.
 */
import * as Comlink from 'comlink';
import './errors';
import type { DefaultsProfile, DeviceId, SimTime } from '@netforge/engine';
import { profileForCourse } from '../learn/course-profile';
import { setResyncHandler, store } from '../store/store';
import type { EngineApi, EngineBatch } from './protocol';

let worker: Worker | undefined;
let remote: EngineApi | undefined;

function connect(): EngineApi {
  if (!remote) {
    worker = new Worker(new URL('./worker/index.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('error', (e) => {
      const msg = e.message ? `Engine worker fault: ${e.message}` : 'Engine worker fault.';
      store.getState().toast(msg, 'error');
    });
    remote = Comlink.wrap<EngineApi>(worker) as unknown as EngineApi;
  }
  return remote;
}

/**
 * The engine, as a Comlink remote. Every method returns a promise. The worker is created on first property access,
 * so importing this module has no side effect.
 */
export const engine: EngineApi = new Proxy({} as EngineApi, {
  get(_target, prop) {
    const r = connect() as unknown as Record<string | symbol, unknown>;
    return r[prop];
  },
});

/** Devices whose snapshot the worker refreshes on every delta: the device shown in the inspector. */
export function watchedDevicesOf(state: ReturnType<typeof store.getState>): DeviceId[] {
  const sel = state.selection;
  if (!sel) return [];
  switch (sel.kind) {
    case 'device':
      return [sel.id];
    case 'port':
      return [sel.ref.device];
    case 'slot':
      return [sel.device];
    default:
      return [];
  }
}

let resyncPending = false;

/** Ask the worker for a full snapshot (the store saw a delta it could not merge). */
async function resync(api: EngineApi): Promise<void> {
  if (resyncPending) return;
  resyncPending = true;
  try {
    const snap = await api.snapshot();
    store.getState().setSnapshot(snap);
  } catch {
    /* the next full snapshot (at most FULL_SNAPSHOT_EVERY_MS away while playing) repairs the mirror */
  } finally {
    resyncPending = false;
  }
}

let initPromise: Promise<void> | undefined;

/**
 * The profile the app-start world takes (ARCHITECTURE-P2 D2, §2.14): the course context the store restored — the
 * classic defaults after a CCNA 1 lesson, the current ones after any other lesson or none.
 */
export function startupProfile(): DefaultsProfile {
  return profileForCourse(store.getState().learn.lastCourse);
}

/**
 * Create the worker, initialise the simulation with `seed` (and, since P2, the `profile` of the course context) and
 * subscribe the store's `applyBatch` to the batch stream. Loads no topology. Idempotent.
 */
export function initEngine(seed = defaultSeed(), profile: DefaultsProfile = startupProfile()): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const api = connect();
      const onBatch = (batch: EngineBatch): void => {
        store.getState().applyBatch(batch);
      };
      setResyncHandler(() => void resync(api));
      await api.subscribe(Comlink.proxy(onBatch), { watchDevices: watchedDevicesOf(store.getState()) });
      const init = await api.init({ seed, profile });
      store.getState().setReady(init);

      // Background frames only clamp the clock (and so stay on screen long enough to draw) when the overlay is on.
      let bg = store.getState().overlays.backgroundFrames;
      void api.setClockPolicy({ ignoreBackground: !bg }).catch(() => undefined);
      store.subscribe((state) => {
        const nextBg = state.overlays.backgroundFrames;
        if (nextBg === bg) return;
        bg = nextBg;
        void api.setClockPolicy({ ignoreBackground: !nextBg }).catch(() => undefined);
      });

      let watched = watchedDevicesOf(store.getState()).join('\n');
      store.subscribe((state) => {
        const ids = watchedDevicesOf(state);
        const key = ids.join('\n');
        if (key === watched) return;
        watched = key;
        void api.setWatchedDevices(ids).catch(() => undefined);
      });
    })().catch((err: unknown) => {
      initPromise = undefined;
      throw err;
    });
  }
  return initPromise;
}

/** A fresh seed for "New": any 31-bit integer; the engine folds seeds to u32 anyway. */
export function defaultSeed(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0] ?? 1) & 0x7fffffff;
}

/**
 * `hh:mm:ss.mmm µµµ`: sim ns formatted for the playback clock. Milliseconds and microseconds are separated by a
 * space so the eye can find the ms boundary.
 */
export function fmtSimTime(t: SimTime): string {
  const ns = Math.max(0, Math.floor(t));
  const totalUs = Math.floor(ns / 1_000);
  const us = totalUs % 1_000;
  const totalMs = Math.floor(totalUs / 1_000);
  const ms = totalMs % 1_000;
  const totalS = Math.floor(totalMs / 1_000);
  const s = totalS % 60;
  const m = Math.floor(totalS / 60) % 60;
  const h = Math.floor(totalS / 3600);
  const p = (n: number, w: number): string => n.toString().padStart(w, '0');
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)}.${p(ms, 3)} ${p(us, 3)}`;
}

/** Short duration for tooltips / status ("1.2 ms", "830 ns", "2.0 s"). */
export function fmtDuration(ns: SimTime): string {
  const a = Math.abs(ns);
  if (a < 1_000) return `${ns} ns`;
  if (a < 1_000_000) return `${(ns / 1_000).toFixed(1)} µs`;
  if (a < 1_000_000_000) return `${(ns / 1_000_000).toFixed(1)} ms`;
  return `${(ns / 1_000_000_000).toFixed(2)} s`;
}
