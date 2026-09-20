/**
 * capture/store.ts — the one NetScope analyser behind live captures (Simulation, ids `c_<n>`) and imported captures
 * (worker CaptureLibrary, ids `i_<n>`) (ARCHITECTURE-P1 §4.12; contracts/capture.ts `CaptureStore`,
 * `CreateCaptureStore`).
 *
 * Storage: a bounded ring of records in append order. `append` gives each record the next index (`info().head`),
 * whatever index it carried, so indices stay monotonic; the oldest records are dropped while the ring holds more
 * than `maxRecords` records or more than `maxBytes` captured bytes (the newest record is always kept). Defaults:
 * live DEFAULT_CAPTURE_MAX_RECORDS / MAX_CAPTURE_BYTES, import MAX_CAPTURE_IMPORT_RECORDS / MAX_CAPTURE_IMPORT_BYTES.
 * A live store starts running; an imported one never runs. `append` only records while running.
 *
 * Queries:
 *  • The display filter text is compiled once per text (capture/filter `compileDisplayFilter`, a small cache of
 *    recent texts). An invalid filter reports `filterError` and matches nothing; empty or blank text matches all.
 *  • Each filter frame carries number (index + 1), original length, time relative to the capture's first record,
 *    interface index and name, direction, corruption flag, decoded layers and the bytes.
 *  • `query({filter, from, limit})` scans from `max(from, oldest)` in index order and stops after `limit` matches,
 *    after CAPTURE_QUERY_SCAN_BUDGET records, or at the head. `next` is the index to continue from (`head` when the
 *    ring is exhausted); `scanned` / `matched` count this call's work. `from` must be a whole number and `limit` a
 *    whole number ≥ 0 (RangeError otherwise).
 *  • Rows and details come from a decode cache of CAPTURE_DECODE_CACHE_SIZE frames (capture/decode-row.ts).
 *  • `follow(key)` reassembles one conversation over every retained record (capture/stream.ts).
 *  • `stats(filter)` covers every retained record the filter matches (capture/stats.ts).
 *  • `export(opts)` writes the retained records the filter matches through io/pcap.ts `writeCapture`; an invalid
 *    filter throws an Error naming the problem.
 * No sim ids, no rng, no clocks: every result depends only on the records.
 */
import {
  DEFAULT_CAPTURE_MAX_RECORDS,
  MAX_CAPTURE_BYTES,
  MAX_CAPTURE_IMPORT_BYTES,
  MAX_CAPTURE_IMPORT_RECORDS,
  type CaptureExportOptions,
  type CaptureId,
  type CaptureInfo,
  type CaptureInterface,
  type CaptureQuery,
  type CaptureQueryResult,
  type CaptureRecord,
  type CaptureRecordDetail,
  type CaptureRow,
  type CaptureStatistics,
  type CaptureStore,
  type CaptureStoreInit,
  type CreateCaptureStore,
  type FollowStreamResult,
} from '../contracts/capture.js';
import { writeCapture } from '../io/pcap.js';
import { createDecodeCache, type DecodedRecord } from './decode-row.js';
import { compileDisplayFilter, type CompiledDisplayFilter } from './filter/eval.js';
import type { DisplayFilterFrame } from './filter/fields.js';
import { computeCaptureStatistics, type StatsFrame } from './stats.js';
import { followStream, type FollowFrame } from './stream.js';

/** Most records one `query` call examines before returning a continuation cursor. */
export const CAPTURE_QUERY_SCAN_BUDGET = 20_000;

/** Number of compiled display filters a store keeps. */
export const CAPTURE_FILTER_CACHE_SIZE = 8;

/** A capture store plus the operations the live tap and the tests need beyond the contract. */
export interface CaptureStoreImpl extends CaptureStore {
  readonly id: CaptureId;
  /** Add an interface (a live capture point that started carrying a new link type); returns its index. */
  addInterface(iface: Omit<CaptureInterface, 'index'>): number;
  /** The interface with this index. */
  iface(index: number): CaptureInterface | undefined;
  /** Retained records, oldest first (the store's own objects: callers must not modify them). */
  records(): readonly CaptureRecord[];
  /** Whether the store records appended frames. */
  readonly running: boolean;
}

function checkWhole(name: string, v: number, min?: number): void {
  if (!Number.isInteger(v) || (min !== undefined && v < min)) {
    throw new RangeError(min === undefined ? `Capture query ${name} must be a whole number, not ${v}.` : `Capture query ${name} must be a whole number of at least ${min}, not ${v}.`);
  }
}

function checkLimit(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 1) throw new RangeError(`A capture's ${name} must be a positive whole number, not ${v}.`);
}

/** Create a capture store (contracts/capture.ts `CreateCaptureStore`). */
export function createCaptureStoreImpl(init: CaptureStoreInit): CaptureStoreImpl {
  const live = init.source === 'live';
  const maxRecords = init.maxRecords ?? (live ? DEFAULT_CAPTURE_MAX_RECORDS : Math.max(MAX_CAPTURE_IMPORT_RECORDS, init.records?.length ?? 0));
  const maxBytes = init.maxBytes ?? (live ? MAX_CAPTURE_BYTES : MAX_CAPTURE_IMPORT_BYTES);
  checkLimit('record limit', maxRecords);
  checkLimit('byte limit', maxBytes);

  const interfaces: CaptureInterface[] = [];
  const ifaceByIndex = new Map<number, CaptureInterface>();
  for (const i of init.interfaces) {
    if (ifaceByIndex.has(i.index)) throw new Error(`Capture interface ${i.index} is listed twice.`);
    const copy: CaptureInterface = { ...i };
    interfaces.push(copy);
    ifaceByIndex.set(copy.index, copy);
  }

  let ring: CaptureRecord[] = [];
  let start = 0;
  let head = 0;
  let dropped = 0;
  let heldBytes = 0;
  let firstT: number | undefined;
  let running = live;
  const cache = createDecodeCache();
  const filters = new Map<string, CompiledDisplayFilter>();

  const count = (): number => ring.length - start;
  const oldest = (): number => (count() > 0 ? ring[start]!.index : head);

  const dropOldest = (): void => {
    const r = ring[start]!;
    heldBytes -= r.bytes.length;
    cache.delete(r.index);
    start++;
    dropped++;
    if (start > 1024 && start * 2 > ring.length) {
      ring = ring.slice(start);
      start = 0;
    }
  };

  const push = (rec: CaptureRecord): void => {
    const stored: CaptureRecord = { index: head, t: rec.t, iface: rec.iface, dir: rec.dir, bytes: rec.bytes, origLen: rec.origLen };
    if (rec.pdu !== undefined) stored.pdu = rec.pdu;
    if (rec.corrupted === true) stored.corrupted = true;
    if (!ifaceByIndex.has(stored.iface)) throw new Error(`Frame ${head + 1} refers to interface ${stored.iface}, which the capture does not list.`);
    if (firstT === undefined) firstT = stored.t;
    head++;
    ring.push(stored);
    heldBytes += stored.bytes.length;
    while (count() > 1 && (count() > maxRecords || heldBytes > maxBytes)) dropOldest();
  };

  for (const r of init.records ?? []) push(r);

  const compiled = (text: string | undefined): CompiledDisplayFilter | undefined => {
    const t = text ?? '';
    if (t.trim() === '') return undefined;
    let c = filters.get(t);
    if (c !== undefined) {
      filters.delete(t);
      filters.set(t, c);
      return c;
    }
    c = compileDisplayFilter(t);
    filters.set(t, c);
    if (filters.size > CAPTURE_FILTER_CACHE_SIZE) {
      const first = filters.keys().next();
      if (first.done !== true) filters.delete(first.value);
    }
    return c;
  };

  const decoded = (rec: CaptureRecord): DecodedRecord => cache.get(rec, ifaceByIndex.get(rec.iface)!);

  const frameOf = (rec: CaptureRecord, d: DecodedRecord): DisplayFilterFrame => {
    const iface = ifaceByIndex.get(rec.iface);
    const f: DisplayFilterFrame = {
      number: rec.index + 1,
      len: Math.max(rec.origLen, rec.bytes.length),
      timeRelativeNs: rec.t - (firstT ?? rec.t),
      iface: rec.iface,
      dir: rec.dir,
      layers: d.layers,
      bytes: rec.bytes,
    };
    if (iface !== undefined) f.ifaceName = iface.name;
    if (rec.corrupted === true) f.corrupted = true;
    return f;
  };

  const matches = (c: CompiledDisplayFilter | undefined, rec: CaptureRecord, d: DecodedRecord): boolean =>
    c === undefined ? true : c.test(frameOf(rec, d));

  /** Retained records the filter matches, in order, with their decodes. */
  const matching = (filter: string | undefined): { rec: CaptureRecord; d: DecodedRecord }[] => {
    const c = compiled(filter);
    const out: { rec: CaptureRecord; d: DecodedRecord }[] = [];
    if (c?.error !== undefined) return out;
    for (let i = start; i < ring.length; i++) {
      const rec = ring[i]!;
      const d = decoded(rec);
      if (matches(c, rec, d)) out.push({ rec, d });
    }
    return out;
  };

  const store: CaptureStoreImpl = {
    id: init.id,
    get running() {
      return running;
    },
    info(): CaptureInfo {
      return {
        id: init.id,
        name: init.name,
        source: init.source,
        running,
        interfaces: interfaces.map((i) => ({ ...i })),
        head,
        oldest: oldest(),
        dropped,
      };
    },
    append(rec) {
      if (!running) return;
      push(rec);
    },
    setRunning(on) {
      running = live && on;
    },
    addInterface(iface) {
      const index = interfaces.length === 0 ? 0 : Math.max(...interfaces.map((i) => i.index)) + 1;
      const copy: CaptureInterface = { ...iface, index };
      interfaces.push(copy);
      ifaceByIndex.set(index, copy);
      return index;
    },
    iface(index) {
      const i = ifaceByIndex.get(index);
      return i === undefined ? undefined : { ...i };
    },
    records() {
      return ring.slice(start);
    },
    query(q: CaptureQuery): CaptureQueryResult {
      checkWhole('start', q.from);
      checkWhole('limit', q.limit, 0);
      const c = compiled(q.filter);
      const rows: CaptureRow[] = [];
      const first = Math.max(q.from, oldest());
      if (c?.error !== undefined) return { rows, next: head, scanned: 0, matched: 0, filterError: { ...c.error } };
      let scanned = 0;
      let next = head;
      for (let i = start + (first - oldest()); i < ring.length; i++) {
        if (rows.length >= q.limit || scanned >= CAPTURE_QUERY_SCAN_BUDGET) {
          next = ring[i]!.index;
          break;
        }
        const rec = ring[i]!;
        scanned++;
        const d = decoded(rec);
        if (matches(c, rec, d)) rows.push({ ...d.row, layers: [...d.row.layers] });
      }
      if (first >= head) next = Math.max(head, first);
      return { rows, next, scanned, matched: rows.length };
    },
    record(index) {
      if (!Number.isInteger(index) || index < oldest() || index >= head) return undefined;
      const rec = ring[start + (index - oldest())]!;
      const d = decoded(rec);
      return { row: { ...d.row, layers: [...d.row.layers] }, bytes: rec.bytes.slice(), layers: [...d.layers], summary: d.summary } satisfies CaptureRecordDetail;
    },
    follow(key): FollowStreamResult {
      const frames: FollowFrame[] = [];
      for (let i = start; i < ring.length; i++) {
        const rec = ring[i]!;
        const d = decoded(rec);
        if (d.row.stream !== key) continue;
        frames.push({ index: rec.index, iface: rec.iface, dir: rec.dir, bytes: rec.bytes, layers: d.layers });
      }
      return followStream(key, frames);
    },
    stats(filter): CaptureStatistics {
      const frames: StatsFrame[] = matching(filter).map(({ rec, d }) => ({ t: rec.t, len: Math.max(rec.origLen, rec.bytes.length), layers: d.layers }));
      return computeCaptureStatistics(frames);
    },
    export(opts: CaptureExportOptions): Uint8Array {
      const c = compiled(opts.filter);
      if (c?.error !== undefined) throw new Error(`The export filter is not valid: ${c.error.message}`);
      const records = c === undefined ? ring.slice(start) : matching(opts.filter).map((m) => m.rec);
      return writeCapture({ interfaces: interfaces.map((i) => ({ ...i })), records }, opts);
    },
  };
  return store;
}

/** contracts/capture.ts `CreateCaptureStore`: Simulation captures and the worker CaptureLibrary both use it. */
export const createCaptureStore: CreateCaptureStore = (init) => createCaptureStoreImpl(init);
