/**
 * netscope-client.ts — the paging, caching and text layer between the NetScope panes and the engine
 * (ARCHITECTURE-P1 §4.12, §7 "NetScope"; contracts/capture.ts). No React, no DOM: every pane calls these
 * helpers, and `netscope-client.test.ts` (§10.2 "Web P1") drives them over a real capture store.
 *
 * Paging. The UI never holds a capture: a `RowPager` keeps ONE WINDOW of at most `NETSCOPE_ROW_WINDOW`
 * matched rows, filled page by page from `queryCapture({filter, from, limit})`. `next` is the engine's
 * continuation cursor, so "next window" starts exactly where this one stopped and the window starts it
 * opened are stacked for "previous window". A filter change or a jump restarts at a record index.
 *
 * ponytail (deliberate simplifications, all reversible):
 *  • One window at a time instead of a sliding window with scroll compensation: paging is explicit
 *    (Previous / Next window, Jump to frame), so the row array never shifts under the list.
 *  • Follow-live appends to the current window only while it is not yet full — once the window fills, the
 *    list stays where the reader put it and says so. `follow()` resumes at the engine's continuation cursor,
 *    so the rows already on screen never cross the worker boundary twice.
 *  • `capturePortOf` adapts whatever the bridge exposes: the agreed `captures()` with a one-shot fallback
 *    to the earlier `listCaptures()` spelling, and `startCapture`/`importCapture` returning either an id
 *    or a CaptureInfo. That keeps this wave independent of the shell wave's rename.
 */
import { CAPTURE_QUERY_SCAN_BUDGET } from '@netforge/engine';
import type {
  CaptureExportOptions,
  CaptureId,
  CaptureInfo,
  CaptureQuery,
  CaptureQueryResult,
  CaptureRecordDetail,
  CaptureRow,
  CaptureSpec,
  CaptureStatistics,
  DisplayFilterError,
  FollowStreamResult,
  PcapFormat,
} from '@netforge/engine';

/** Rows asked for in one `queryCapture` call. */
export const NETSCOPE_PAGE_SIZE = 200;
/** Matched rows one window holds. Beyond this the reader pages on. */
export const NETSCOPE_ROW_WINDOW = 1000;
/** `queryCapture` calls one `fill()` may chain (a filter that matches nothing still scans). */
export const NETSCOPE_FILL_CALLS = 8;
/** Decoded records kept in memory (bytes + layers). */
export const NETSCOPE_DETAIL_CACHE = 24;
/** Shortest gap between two follow-the-live-capture reads, as the sim-events list uses (§4.11 item 5). */
export const NETSCOPE_FOLLOW_MS = 250;
/** Shown when this build's bridge has no capture methods yet. */
export const NETSCOPE_NO_API = 'This build cannot capture traffic yet.';
/** Shown while no capture exists. */
export const NETSCOPE_NO_CAPTURE = 'No capture yet. Choose the capture points below and start one.';

// ── the bridge calls NetScope needs ─────────────────────────────────────────

/**
 * The capture half of `EngineApi`, as a structural port so the panes, the client and the tests share one
 * shape and none of them import the worker.
 */
export interface CapturePort {
  startCapture(spec: CaptureSpec): Promise<CaptureId>;
  stopCapture(id: CaptureId): Promise<void>;
  removeCapture(id: CaptureId): Promise<void>;
  captures(): Promise<CaptureInfo[]>;
  queryCapture(id: CaptureId, q: CaptureQuery): Promise<CaptureQueryResult>;
  captureRecord(id: CaptureId, index: number): Promise<CaptureRecordDetail | undefined>;
  followStream(id: CaptureId, key: string): Promise<FollowStreamResult>;
  captureStats(id: CaptureId, filter?: string): Promise<CaptureStatistics>;
  exportCapture(id: CaptureId, opts: CaptureExportOptions): Promise<Uint8Array>;
  importCapture(bytes: Uint8Array, name: string): Promise<CaptureId>;
}

type AnyFn = (...args: unknown[]) => unknown;

function methodOf(api: unknown, name: string): AnyFn | undefined {
  if (api === null || typeof api !== 'object') return undefined;
  const fn = (api as Record<string, unknown>)[name];
  return typeof fn === 'function' ? (fn as AnyFn) : undefined;
}

async function callOne(api: unknown, name: string, args: unknown[]): Promise<unknown> {
  const fn = methodOf(api, name);
  if (!fn) throw new Error(NETSCOPE_NO_API);
  return await (fn.apply(api, args) as Promise<unknown>);
}

/** Try `names[0]`, and on failure each later spelling once; the winner is remembered. */
function callAny(api: unknown, names: readonly string[]): (...args: unknown[]) => Promise<unknown> {
  let chosen: string | undefined;
  return async (...args: unknown[]): Promise<unknown> => {
    if (chosen !== undefined) return await callOne(api, chosen, args);
    let last: unknown;
    for (const name of names) {
      try {
        const out = await callOne(api, name, args);
        chosen = name;
        return out;
      } catch (err) {
        last = err;
      }
    }
    throw last instanceof Error ? last : new Error(NETSCOPE_NO_API);
  };
}

/** A start/import result is either the id itself or the whole CaptureInfo. */
export function captureIdOf(result: unknown): CaptureId {
  if (typeof result === 'string') return result;
  if (result !== null && typeof result === 'object') {
    const id = (result as { id?: unknown }).id;
    if (typeof id === 'string') return id;
  }
  throw new Error('The engine did not name the capture it created.');
}

/** Wrap the bridge remote (`engine`) as a `CapturePort`. */
export function capturePortOf(api: unknown): CapturePort {
  const list = callAny(api, ['captures', 'listCaptures']);
  return {
    startCapture: async (spec) => captureIdOf(await callOne(api, 'startCapture', [spec])),
    stopCapture: async (id) => void (await callOne(api, 'stopCapture', [id])),
    removeCapture: async (id) => void (await callOne(api, 'removeCapture', [id])),
    captures: async () => ((await list()) as CaptureInfo[] | undefined) ?? [],
    queryCapture: async (id, q) => (await callOne(api, 'queryCapture', [id, q])) as CaptureQueryResult,
    captureRecord: async (id, index) => (await callOne(api, 'captureRecord', [id, index])) as CaptureRecordDetail | undefined,
    followStream: async (id, key) => (await callOne(api, 'followStream', [id, key])) as FollowStreamResult,
    captureStats: async (id, filter) => (await callOne(api, 'captureStats', [id, filter])) as CaptureStatistics,
    exportCapture: async (id, opts) => (await callOne(api, 'exportCapture', [id, opts])) as Uint8Array,
    importCapture: async (bytes, name) => captureIdOf(await callOne(api, 'importCapture', [bytes, name])),
  };
}

// ── row pager ───────────────────────────────────────────────────────────────

export interface PagerState {
  /** Matched rows of this window, in capture order. */
  readonly rows: readonly CaptureRow[];
  /** Record index this window starts at. */
  readonly from: number;
  /** Engine continuation cursor: where the next window starts. */
  readonly next: number;
  /** The engine reached the end of the capture. */
  readonly done: boolean;
  /** The window holds `maxRows` and more matches follow. */
  readonly full: boolean;
  /** Records the engine examined for this window. */
  readonly scanned: number;
  /** Matches found for this window. */
  readonly matched: number;
  /** Set when the display filter did not compile (nothing matches). */
  readonly error?: DisplayFilterError;
  readonly loading: boolean;
  /** Windows opened before this one. */
  readonly depth: number;
  /** Bumped on every settled change, so React can re-render on identity. */
  readonly revision: number;
}

export interface RowPagerOptions {
  filter?: string;
  pageSize?: number;
  maxRows?: number;
}

export interface RowPager {
  readonly id: CaptureId;
  readonly filter: string;
  state(): PagerState;
  /** One more page into this window. */
  more(): Promise<PagerState>;
  /** Pages until the window is full, the capture ends, or `NETSCOPE_FILL_CALLS` calls were made. */
  fill(): Promise<PagerState>;
  /** Open the window that starts where this one stopped. */
  nextWindow(): Promise<PagerState>;
  /** Re-open the window before this one. */
  prevWindow(): Promise<PagerState>;
  /** Restart at a record index (0 = the first record kept). */
  jumpTo(index: number): Promise<PagerState>;
  /** Replace the display filter and restart at the beginning. */
  setFilter(filter: string): Promise<PagerState>;
  /** Re-read this window from the engine (the records behind it changed). */
  refresh(): Promise<PagerState>;
  /**
   * Append whatever a live capture added since this window last read it, starting at the engine's own
   * continuation cursor — the rows already on screen are never fetched again.
   */
  follow(): Promise<PagerState>;
}

/**
 * Page one capture through `queryCapture`. Every mutating call resolves with the settled state; overlapping
 * calls are serialised so the window is never assembled out of order.
 */
export function createRowPager(port: CapturePort, id: CaptureId, opts: RowPagerOptions = {}): RowPager {
  const pageSize = Math.max(1, opts.pageSize ?? NETSCOPE_PAGE_SIZE);
  const maxRows = Math.max(pageSize, opts.maxRows ?? NETSCOPE_ROW_WINDOW);
  let filter = opts.filter ?? '';
  let rows: CaptureRow[] = [];
  let from = 0;
  let next = 0;
  let done = false;
  let scanned = 0;
  let matched = 0;
  let error: DisplayFilterError | undefined;
  let loading = false;
  let stack: number[] = [];
  let revision = 0;
  let queue: Promise<PagerState> = Promise.resolve(snap());

  function snap(): PagerState {
    return {
      rows,
      from,
      next,
      done,
      full: rows.length >= maxRows && !done,
      scanned,
      matched,
      ...(error ? { error } : {}),
      loading,
      depth: stack.length,
      revision,
    };
  }

  function restart(at: number): void {
    rows = [];
    from = Math.max(0, Math.trunc(at));
    next = from;
    done = false;
    scanned = 0;
    matched = 0;
    error = undefined;
  }

  /**
   * One `queryCapture` call; returns the rows it added. The engine's scan stops at the capture head, at
   * `limit` matches or at `CAPTURE_QUERY_SCAN_BUDGET` records, so fewer matches than `limit` within the
   * budget means the head was reached: that is the end of the capture.
   */
  async function page(): Promise<number> {
    if (done || rows.length >= maxRows) return 0;
    const limit = Math.min(pageSize, maxRows - rows.length);
    const res = await port.queryCapture(id, { filter, from: next, limit });
    error = res.filterError;
    scanned += res.scanned;
    matched += res.matched;
    for (const row of res.rows) rows.push(row);
    const before = next;
    next = res.next;
    if (res.rows.length < limit && res.scanned < CAPTURE_QUERY_SCAN_BUDGET) done = true;
    // Guard against a cursor that cannot advance (a store that reports neither rows nor progress).
    if (res.rows.length === 0 && res.next === before) done = true;
    return res.rows.length;
  }

  function run(work: () => Promise<void>): Promise<PagerState> {
    const started = queue.then(async () => {
      loading = true;
      try {
        await work();
      } finally {
        loading = false;
        revision++;
      }
      return snap();
    });
    queue = started.catch(() => snap());
    return started;
  }

  async function fillWindow(): Promise<void> {
    for (let i = 0; i < NETSCOPE_FILL_CALLS; i++) {
      if (done || rows.length >= maxRows) break;
      await page();
    }
  }

  return {
    id,
    get filter() {
      return filter;
    },
    state: snap,
    more: () => run(async () => void (await page())),
    fill: () => run(fillWindow),
    nextWindow: () =>
      run(async () => {
        if (done) return;
        const start = next;
        stack.push(from);
        restart(start);
        await fillWindow();
      }),
    prevWindow: () =>
      run(async () => {
        const back = stack.pop();
        if (back === undefined) return;
        restart(back);
        await fillWindow();
      }),
    jumpTo: (index) =>
      run(async () => {
        stack = [];
        restart(index);
        await fillWindow();
      }),
    setFilter: (text) =>
      run(async () => {
        filter = text;
        stack = [];
        restart(0);
        await fillWindow();
      }),
    refresh: () =>
      run(async () => {
        const start = from;
        const keep = stack.slice();
        restart(start);
        stack = keep;
        await fillWindow();
      }),
    follow: () =>
      run(async () => {
        if (rows.length >= maxRows) return;
        // The window ended at the head the engine reported then; that head has moved, so scan on from it.
        done = false;
        await fillWindow();
      }),
  };
}

// ── decoded-record cache ────────────────────────────────────────────────────

export interface DetailCache {
  /** Cached detail, or undefined when it has not been fetched. */
  peek(id: CaptureId, index: number): CaptureRecordDetail | undefined;
  get(id: CaptureId, index: number): Promise<CaptureRecordDetail | undefined>;
  /** Drop everything, or one capture's records. */
  clear(id?: CaptureId): void;
  size(): number;
}

/** Least-recently-used cache of decoded records, with one flight per key. */
export function createDetailCache(port: CapturePort, max: number = NETSCOPE_DETAIL_CACHE): DetailCache {
  const held = new Map<string, CaptureRecordDetail>();
  const flights = new Map<string, Promise<CaptureRecordDetail | undefined>>();
  const key = (id: CaptureId, index: number): string => `${id}#${index}`;

  return {
    peek(id, index) {
      return held.get(key(id, index));
    },
    async get(id, index) {
      const k = key(id, index);
      const hit = held.get(k);
      if (hit) {
        held.delete(k);
        held.set(k, hit);
        return hit;
      }
      const flying = flights.get(k);
      if (flying) return await flying;
      const flight = port
        .captureRecord(id, index)
        .then((detail) => {
          if (detail) {
            held.set(k, detail);
            while (held.size > max) {
              const oldest = held.keys().next();
              if (oldest.done === true) break;
              held.delete(oldest.value);
            }
          }
          return detail;
        })
        .finally(() => {
          flights.delete(k);
        });
      flights.set(k, flight);
      return await flight;
    },
    clear(id) {
      if (id === undefined) {
        held.clear();
        return;
      }
      for (const k of [...held.keys()]) if (k.startsWith(`${id}#`)) held.delete(k);
    },
    size: () => held.size,
  };
}

// ── filter text helpers (pure) ──────────────────────────────────────────────

/** "Column 12: …" — the parser's column is 0-based, readers count from 1. */
export function describeFilterError(err: DisplayFilterError): string {
  return `Column ${err.column + 1}: ${err.message}`;
}

/** Caret row under the filter text, so the bad span is marked without relying on colour. */
export function caretLine(err: DisplayFilterError): string {
  return `${' '.repeat(Math.max(0, err.column))}${'^'.repeat(Math.max(1, err.length))}`;
}

/** Replace the completion's span with `label`; returns the new text and where the caret lands. */
export function applyCompletion(text: string, span: { from: number; to: number }, label: string): { text: string; cursor: number } {
  const from = Math.max(0, Math.min(span.from, text.length));
  const to = Math.max(from, Math.min(span.to, text.length));
  return { text: `${text.slice(0, from)}${label}${text.slice(to)}`, cursor: from + label.length };
}

// ── row and statistics presentation (pure) ──────────────────────────────────

/** Direction as a glyph plus the word it stands for (colour is never the only cue). */
export function directionOf(dir: CaptureRow['dir']): { glyph: string; text: string } {
  if (dir === 'tx') return { glyph: '→', text: 'sent' };
  if (dir === 'rx') return { glyph: '←', text: 'received' };
  return { glyph: '·', text: 'direction unknown' };
}

/** One row read aloud: number, direction, addresses, protocol, length, damage. */
export function rowSummary(row: CaptureRow, ifaceName?: string): string {
  const dir = directionOf(row.dir);
  const where = ifaceName ? ` on ${ifaceName}` : '';
  const damaged = row.corrupted === true ? ', damaged on the wire' : '';
  return `Frame ${row.index + 1}${where}, ${dir.text}, ${row.src} to ${row.dst}, ${row.proto}, ${row.len} bytes${damaged}. ${row.info}`;
}

export interface HierarchyNode {
  path: string;
  /** Last segment: the protocol at this level. */
  label: string;
  depth: number;
  frames: number;
  bytes: number;
  /** Share of the capture's frames, 0–1. */
  share: number;
}

/**
 * Turn the engine's flat `path` hierarchy ('ethernet/ipv4/tcp') into indented nodes. Paths keep the engine's
 * order; `share` is of `total` frames (0 when the capture is empty).
 */
export function hierarchyTree(stats: Pick<CaptureStatistics, 'hierarchy' | 'total'>): HierarchyNode[] {
  return stats.hierarchy.map((h) => {
    const parts = h.path.split('/');
    return {
      path: h.path,
      label: parts[parts.length - 1] ?? h.path,
      depth: parts.length - 1,
      frames: h.frames,
      bytes: h.bytes,
      share: stats.total > 0 ? h.frames / stats.total : 0,
    };
  });
}

/** Share as a run of blocks plus its percentage — a bar that survives a screen reader. */
export function shareBar(share: number, width = 10): { bar: string; text: string } {
  const filled = Math.max(0, Math.min(width, Math.round(share * width)));
  return { bar: `${'▮'.repeat(filled)}${'▯'.repeat(width - filled)}`, text: `${(share * 100).toFixed(share >= 0.1 ? 0 : 1)}%` };
}

/** File name offered for a saved capture: the capture's name, made safe, plus the format's extension. */
export function captureFileName(info: Pick<CaptureInfo, 'id' | 'name'>, format: PcapFormat): string {
  const base = (info.name || info.id).trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${base === '' ? 'capture' : base}.${format}`;
}

/** Live/imported as a lettered badge plus the word, never colour alone. */
export function sourceBadge(source: CaptureInfo['source']): { letter: string; text: string } {
  return source === 'live' ? { letter: 'L', text: 'live capture' } : { letter: 'F', text: 'from a file' };
}

/** Running state as a glyph plus its word. */
export function runningBadge(info: Pick<CaptureInfo, 'running' | 'source'>): { glyph: string; text: string } {
  if (info.running) return { glyph: '●', text: 'recording' };
  return { glyph: '■', text: info.source === 'live' ? 'stopped' : 'file' };
}
