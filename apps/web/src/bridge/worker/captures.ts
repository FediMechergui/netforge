/**
 * Worker capture desk (ARCHITECTURE-P1 §4.12, §7 "NetScope"): the one place the UI's capture calls land.
 *
 * Live captures (`c_<n>`) belong to the Simulation and die with the world; imported ones (`i_<n>`) belong to this
 * module's library, survive reset/load, and use no sim id or rng. Every call is routed by the id prefix, so the UI
 * never has to know which side a capture came from — and never holds an engine object: rows, details, statistics
 * and pcap bytes cross the bridge as plain structured-clone data.
 *
 * Both sides run the SAME analyser: the Simulation's capture facade and `createCaptureStore` here are the same
 * engine module, so a filter, a follow stream or an export behaves identically on a live and on an imported
 * capture.
 *
 * ponytail: the library is a plain Map and import ids are a counter — imports are user-initiated and rare, so
 * there is nothing to pool or index.
 */
import { createCaptureStore, readCapture } from '@netforge/engine';
import type {
  CaptureExportOptions,
  CaptureId,
  CaptureInfo,
  CaptureQuery,
  CaptureQueryResult,
  CaptureRecordDetail,
  CaptureSpec,
  CaptureStatistics,
  CaptureStore,
  FollowStreamResult,
  Simulation,
} from '@netforge/engine';

/** Ids of imported captures start with this; live ones come from the engine as `c_<n>`. */
export const IMPORT_ID_PREFIX = 'i_';

export const isImportedCaptureId = (id: CaptureId): boolean => id.startsWith(IMPORT_ID_PREFIX);

/** The Simulation's capture facade (P1 members of `Simulation`, present once the engine ships them). */
type LiveCaptures = Required<
  Pick<Simulation, 'startCapture' | 'stopCapture' | 'removeCapture' | 'captures' | 'queryCapture' | 'captureRecord' | 'followStream' | 'captureStats' | 'exportCapture'>
>;

export interface WorkerCaptures {
  start(spec: CaptureSpec): CaptureInfo;
  stop(id: CaptureId): void;
  remove(id: CaptureId): void;
  /** Live captures of the current world first, then imported ones in import order. */
  list(): CaptureInfo[];
  query(id: CaptureId, q: CaptureQuery): CaptureQueryResult;
  record(id: CaptureId, index: number): CaptureRecordDetail | undefined;
  follow(id: CaptureId, key: string): FollowStreamResult;
  stats(id: CaptureId, filter?: string): CaptureStatistics;
  export(id: CaptureId, opts: CaptureExportOptions): Uint8Array;
  /** Parse pcap/pcapng bytes into the library (`readCapture` bounds and validates them). */
  import(bytes: Uint8Array, name: string): CaptureInfo;
  /**
   * Heads that grew since the previous call, for `EngineBatch.captureHeads` (the UI repages only what moved).
   * Undefined when nothing advanced.
   */
  advanced(): Record<CaptureId, number> | undefined;
  /** New simulation generation: live captures went with the world; imports stay. */
  reset(): void;
}

export function createWorkerCaptures(sim: () => Simulation): WorkerCaptures {
  const library = new Map<CaptureId, CaptureStore>();
  const seenHeads = new Map<CaptureId, number>();
  let imports = 0;

  /** Fail with wording the UI can show, not a TypeError, if this build's engine has no capture facade. */
  function live(): LiveCaptures {
    const s = sim();
    if (typeof s.startCapture !== 'function' || typeof s.captures !== 'function') {
      throw new Error('Packet capture is not available in this release of the engine.');
    }
    return s as LiveCaptures;
  }

  function imported(id: CaptureId): CaptureStore {
    const store = library.get(id);
    if (store === undefined) throw new Error(`There is no imported capture "${id}".`);
    return store;
  }

  function list(): CaptureInfo[] {
    const s = sim();
    const liveList = typeof s.captures === 'function' ? s.captures() : [];
    return [...liveList, ...[...library.values()].map((c) => c.info())];
  }

  return {
    start(spec) {
      const api = live();
      const id = api.startCapture(spec);
      const info = api.captures().find((c) => c.id === id);
      if (info === undefined) throw new Error('The capture was started but the engine did not list it.');
      return info;
    },

    stop(id) {
      if (isImportedCaptureId(id)) imported(id).setRunning(false);
      else live().stopCapture(id);
    },

    remove(id) {
      if (isImportedCaptureId(id)) {
        if (!library.delete(id)) throw new Error(`There is no imported capture "${id}".`);
      } else {
        live().removeCapture(id);
      }
      seenHeads.delete(id);
    },

    list,

    query(id, q) {
      return isImportedCaptureId(id) ? imported(id).query(q) : live().queryCapture(id, q);
    },

    record(id, index) {
      return isImportedCaptureId(id) ? imported(id).record(index) : live().captureRecord(id, index);
    },

    follow(id, key) {
      return isImportedCaptureId(id) ? imported(id).follow(key) : live().followStream(id, key);
    },

    stats(id, filter) {
      return isImportedCaptureId(id) ? imported(id).stats(filter) : live().captureStats(id, filter);
    },

    export(id, opts) {
      return isImportedCaptureId(id) ? imported(id).export(opts) : live().exportCapture(id, opts);
    },

    import(bytes, name) {
      const file = readCapture(bytes);
      const id = `${IMPORT_ID_PREFIX}${++imports}`;
      const store = createCaptureStore({ id, name, source: 'import', interfaces: file.interfaces, records: file.records });
      library.set(id, store);
      return store.info();
    },

    advanced() {
      let out: Record<CaptureId, number> | undefined;
      for (const info of list()) {
        if (seenHeads.get(info.id) === info.head) continue;
        seenHeads.set(info.id, info.head);
        (out ??= {})[info.id] = info.head;
      }
      return out;
    },

    reset() {
      for (const id of [...seenHeads.keys()]) if (!isImportedCaptureId(id)) seenHeads.delete(id);
    },
  };
}
