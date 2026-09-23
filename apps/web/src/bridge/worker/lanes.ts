/**
 * The worker's lane index [SHOULD S1] (ARCHITECTURE-P2 §2.13, §3.13 step 1, §12.2 R8; W4 web-shell).
 *
 * Every trace event the live world emits is classified once by the engine's `laneOf` (timeline/lanes.ts) and, when it
 * belongs to a lane, stored as `(t, cursor, lane)` in three typed arrays: about 17 bytes an entry, so the default
 * budget of 250 000 entries is about 4 MB. The index answers the two timeline queries of the protocol:
 *
 *   - `buckets(q)` — `TimelineQuery` → one `LaneBucket` per bucket of `[from, to]`: the events per lane and the ring
 *     cursor of each lane's first event in that bucket (the seek target of a click on the cell);
 *   - `marks(q)` — `TimelineMarkQuery` → the individual `(cursor, t, lane)` marks of one lane inside `[from, to]`,
 *     oldest first, at most `limit`. The worker resolves the events from the live ring (index.ts).
 *
 * When the fine tier is full its oldest half is MERGED INTO COARSE CELLS (R8: "merged into buckets when full"): fixed
 * cells of `coarseNs` sim time that keep per-lane counts and first cursors but no individual marks. A coarse cell that
 * crosses a query bucket boundary is counted in the bucket that holds its start. When the coarse tier itself grows past
 * `COARSE_CELLS_MAX`, the cell width doubles and neighbouring cells merge, so the whole index stays bounded whatever the
 * length of the run. The newest events (the ones a learner scrubs through) are always in the fine tier.
 *
 * Background drops (`drop` with `background: true`: BPDUs a host discards, keepalives) are not indexed: §2.7 hides
 * background traffic by default, and one such drop every 2 s per host would bury the drops lane.
 *
 * Trace events arrive in non-decreasing `t` (the scheduler dispatches in time order), so both tiers are time-ordered
 * and every query is a binary search plus a scan of the window. `revision` counts the entries indexed since the last
 * reset; it rides every batch as `timelineHead.lanesRevision` so the strip re-queries only when the index grew.
 *
 * Pure bookkeeping: no clock, no randomness, no engine object kept. The `laneOf` tables are read at call time (§0 rule
 * 12), never at module scope.
 */
import { LANE_IDS, LANE_INDEX, laneOf } from '@netforge/engine';
import type { LaneBucket, LaneId, SimTime, TimelineMarkQuery, TimelineQuery, TraceEvent } from '@netforge/engine';

/** Entries of the fine tier before the oldest half is folded into coarse cells (`TimeTravelBudget.laneEntries`). */
export const DEFAULT_LANE_ENTRIES = 250_000;
/** Width of a coarse cell when the first fold happens (1 s); it doubles whenever the coarse tier overflows. */
export const COARSE_CELL_NS = 1_000_000_000;
/** Coarse cells kept before neighbouring cells merge. */
export const COARSE_CELLS_MAX = 4096;
/** Most buckets one query may ask for. */
export const MAX_QUERY_BUCKETS = 10_000;
/** Most marks one query may ask for. */
export const MAX_QUERY_MARKS = 10_000;

/** One mark of the fine tier. */
export interface LaneMark {
  readonly cursor: number;
  readonly t: SimTime;
  readonly lane: LaneId;
}

/** The lane index (file header). */
export interface LaneIndex {
  /** Entries in the fine tier. */
  readonly size: number;
  /** Fine-tier capacity (`laneEntries`). */
  readonly capacity: number;
  /** Entries indexed since the last reset (grows by one per indexed event; coarse folds do not change it). */
  readonly revision: number;
  /** Coarse cells (tests, status). */
  readonly coarseCells: number;
  /** Events indexed in total, fine and coarse (tests). */
  readonly total: number;
  /** Index one event at its ring cursor; events in no lane and background drops are ignored. */
  observe(ev: TraceEvent, cursor: number): void;
  /** Forget everything (a new world). */
  reset(): void;
  /** Change the fine-tier capacity (folds the excess into coarse cells when shrinking). */
  setCapacity(n: number): void;
  buckets(q: TimelineQuery): LaneBucket[];
  marks(q: TimelineMarkQuery): LaneMark[];
}

/** Number of lanes (`LANE_IDS.length`), read at call time. */
const laneCount = (): number => LANE_IDS.length;

/** One coarse cell: `[from, from + width)` with per-lane counts and first cursors (`-1` = none). */
interface CoarseCell {
  from: number;
  counts: Uint32Array;
  first: Float64Array;
}

function checkCapacity(n: number): number {
  if (!Number.isInteger(n) || n < 2) throw new RangeError(`The lane index needs at least two entries, got ${String(n)}.`);
  return n;
}

function checkRange(from: number, to: number, what: string): void {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from) {
    throw new RangeError(`${what} needs 0 <= from <= to, got from ${String(from)} and to ${String(to)}.`);
  }
}

/** First index in `times[0, n)` whose value is >= `t` (times are non-decreasing). */
function lowerBound(times: Float64Array, n: number, t: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((times[mid] as number) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Create a lane index with a fine tier of `capacity` entries. */
export function createLaneIndex(capacity: number = DEFAULT_LANE_ENTRIES): LaneIndex {
  let cap = checkCapacity(capacity);
  let times = new Float64Array(cap);
  let cursors = new Float64Array(cap);
  let lanes = new Uint8Array(cap);
  let size = 0;
  let revision = 0;
  let coarse: CoarseCell[] = [];
  let coarseNs = COARSE_CELL_NS;
  let coarseTotal = 0;

  const newCell = (from: number): CoarseCell => ({ from, counts: new Uint32Array(laneCount()), first: new Float64Array(laneCount()).fill(-1) });

  /** Add one entry to the coarse tier (entries arrive in time order, so only the last cell can receive it). */
  const addCoarse = (t: number, cursor: number, lane: number): void => {
    const from = Math.floor(t / coarseNs) * coarseNs;
    let cell = coarse[coarse.length - 1];
    if (cell === undefined || cell.from !== from) {
      cell = newCell(from);
      coarse.push(cell);
    }
    cell.counts[lane] = (cell.counts[lane] as number) + 1;
    const first = cell.first[lane] as number;
    if (first < 0 || cursor < first) cell.first[lane] = cursor;
    coarseTotal++;
  };

  /** Double the cell width and merge neighbours until the coarse tier fits. */
  const compactCoarse = (): void => {
    while (coarse.length > COARSE_CELLS_MAX) {
      coarseNs *= 2;
      const merged: CoarseCell[] = [];
      for (const c of coarse) {
        const from = Math.floor(c.from / coarseNs) * coarseNs;
        let into = merged[merged.length - 1];
        if (into === undefined || into.from !== from) {
          into = newCell(from);
          merged.push(into);
        }
        for (let l = 0; l < laneCount(); l++) {
          into.counts[l] = (into.counts[l] as number) + (c.counts[l] as number);
          const f = c.first[l] as number;
          const g = into.first[l] as number;
          if (f >= 0 && (g < 0 || f < g)) into.first[l] = f;
        }
      }
      coarse = merged;
    }
  };

  /** Fold the oldest `n` fine entries into the coarse tier. */
  const fold = (n: number): void => {
    for (let i = 0; i < n; i++) addCoarse(times[i] as number, cursors[i] as number, lanes[i] as number);
    times.copyWithin(0, n, size);
    cursors.copyWithin(0, n, size);
    lanes.copyWithin(0, n, size);
    size -= n;
    compactCoarse();
  };

  return {
    get size(): number {
      return size;
    },
    get capacity(): number {
      return cap;
    },
    get revision(): number {
      return revision;
    },
    get coarseCells(): number {
      return coarse.length;
    },
    get total(): number {
      return size + coarseTotal;
    },
    observe(ev, cursor) {
      if (ev.kind === 'drop' && ev.background === true) return;
      const lane = laneOf(ev);
      if (lane === undefined) return;
      if (size >= cap) fold(Math.max(1, cap >>> 1));
      times[size] = ev.t;
      cursors[size] = cursor;
      lanes[size] = LANE_INDEX[lane];
      size++;
      revision++;
    },
    reset() {
      size = 0;
      revision = 0;
      coarse = [];
      coarseNs = COARSE_CELL_NS;
      coarseTotal = 0;
    },
    setCapacity(n) {
      const next = checkCapacity(n);
      if (next === cap) return;
      // shrinking below the fill: fold the oldest entries so half of the new tier stays free
      if (size > next) fold(size - Math.max(1, next >>> 1));
      const t2 = new Float64Array(next);
      const c2 = new Float64Array(next);
      const l2 = new Uint8Array(next);
      t2.set(times.subarray(0, size));
      c2.set(cursors.subarray(0, size));
      l2.set(lanes.subarray(0, size));
      times = t2;
      cursors = c2;
      lanes = l2;
      cap = next;
    },
    buckets(q) {
      checkRange(q.from, q.to, 'timelineBuckets');
      if (!Number.isInteger(q.buckets) || q.buckets < 1 || q.buckets > MAX_QUERY_BUCKETS) {
        throw new RangeError(`timelineBuckets needs 1 to ${MAX_QUERY_BUCKETS} buckets, got ${String(q.buckets)}.`);
      }
      const n = q.buckets;
      const L = laneCount();
      const wanted = new Uint8Array(L);
      if (q.lanes === undefined) wanted.fill(1);
      else for (const lane of q.lanes) if (Object.prototype.hasOwnProperty.call(LANE_INDEX, lane)) wanted[LANE_INDEX[lane]] = 1;
      const span = q.to - q.from;
      /** Start of bucket b (b = n is the query's end): the ONE edge function, used to report and to place alike. */
      const edge = (b: number): number => q.from + Math.floor((b * span) / n);
      /**
       * The bucket whose reported `[from, to)` holds `t` (the last bucket is closed at `to`): a proportional guess,
       * corrected against the reported edges, so an event is never counted in a cell whose own range excludes it.
       */
      const place = (t: number): number => {
        if (span <= 0) return n - 1;
        let i = Math.floor(((t - q.from) * n) / span);
        if (i < 0) i = 0;
        else if (i > n - 1) i = n - 1;
        while (i + 1 < n && edge(i + 1) <= t) i++;
        while (i > 0 && edge(i) > t) i--;
        return i;
      };
      const counts = new Uint32Array(n * L);
      const first = new Float64Array(n * L).fill(-1);
      const add = (bucket: number, lane: number, count: number, cursor: number): void => {
        if (wanted[lane] !== 1) return;
        const k = bucket * L + lane;
        counts[k] = (counts[k] as number) + count;
        const f = first[k] as number;
        if (cursor >= 0 && (f < 0 || cursor < f)) first[k] = cursor;
      };
      // coarse cells whose range meets the query (a cell is counted in the bucket that holds its clamped start)
      for (const c of coarse) {
        if (c.from + coarseNs <= q.from || c.from > q.to) continue;
        const b = place(Math.max(c.from, q.from));
        for (let l = 0; l < L; l++) {
          const count = c.counts[l] as number;
          if (count > 0) add(b, l, count, c.first[l] as number);
        }
      }
      // fine entries inside [from, to]
      for (let i = lowerBound(times, size, q.from); i < size; i++) {
        const t = times[i] as number;
        if (t > q.to) break;
        add(place(t), lanes[i] as number, 1, cursors[i] as number);
      }
      const out: LaneBucket[] = [];
      for (let b = 0; b < n; b++) {
        const bucket: LaneBucket = { from: edge(b), to: edge(b + 1), counts: {}, firstCursor: {} };
        for (let l = 0; l < L; l++) {
          const count = counts[b * L + l] as number;
          if (count === 0) continue;
          const lane = LANE_IDS[l] as LaneId;
          bucket.counts[lane] = count;
          const f = first[b * L + l] as number;
          if (f >= 0) bucket.firstCursor[lane] = f;
        }
        out.push(bucket);
      }
      return out;
    },
    marks(q) {
      checkRange(q.from, q.to, 'timelineMarks');
      if (!Number.isInteger(q.limit) || q.limit < 0 || q.limit > MAX_QUERY_MARKS) {
        throw new RangeError(`timelineMarks needs a limit of 0 to ${MAX_QUERY_MARKS}, got ${String(q.limit)}.`);
      }
      if (!Object.prototype.hasOwnProperty.call(LANE_INDEX, q.lane)) throw new RangeError(`There is no timeline lane called "${String(q.lane)}".`);
      const lane = LANE_INDEX[q.lane];
      const out: LaneMark[] = [];
      for (let i = lowerBound(times, size, q.from); i < size && out.length < q.limit; i++) {
        const t = times[i] as number;
        if (t > q.to) break;
        if (lanes[i] !== lane) continue;
        out.push({ cursor: cursors[i] as number, t, lane: q.lane });
      }
      return out;
    },
  };
}
