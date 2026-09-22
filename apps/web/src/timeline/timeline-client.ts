/**
 * timeline/timeline-client.ts — the pure layer under the timeline strip [SHOULD S1] (ARCHITECTURE-P2 §2.13, §2.14,
 * §3.13, §6): the scrubber's arithmetic, the queries the strip sends the worker, lane rows with their glyph and
 * intensity, the wording of a review banner and of one lane mark, and the coalescing of seeks while a learner drags.
 *
 * No React, no engine call and no store access live here, so `test/timeline-client.test.ts` drives it directly (the
 * same split as `simmode/sim-events-client.ts`).
 *
 * The model the strip works with:
 *
 * - a WINDOW `{from, to}` of sim time is what the strip shows. While it touches the live head it follows it
 *   (`advanceWindow`); a learner who pans or zooms away from the head stops following until they return to it.
 * - `bucketQuery` turns the window and the strip's pixel width into a `TimelineQuery` (about one bucket per
 *   `TIMELINE_PX_PER_BUCKET` pixels, capped), and `bucketsKey` says whether the answer still fits the current view,
 *   so the strip re-queries at most `TIMELINE_QUERY_MS` apart and only when something moved.
 * - `laneRows` turns the worker's buckets into one row per lane, in vocabulary order, with a level 1..4 per non-empty
 *   bucket relative to that lane's own peak — the glyph (vocab/lanes.ts) stays the non-colour channel.
 * - the CURSOR is where review is (`ReviewInfo.t`) or the live head. `scrubAction` and `keyAction` turn a drag or a
 *   key into a `SeekTarget`, or into "return to now" once the learner reaches the live edge.
 * - `createSeekQueue` keeps one seek in flight: a newer request replaces a waiting one (that one resolves
 *   `superseded`), so dragging the scrubber sends a seek per completed seek, never one per pixel.
 *
 * Times are integer nanoseconds everywhere (engine `SimTime`); pixels are floats and only ever leave through the
 * geometry helpers.
 */
import { REPLAY_READ_ONLY_MESSAGE, TABLE_DESCRIPTORS, formatSimTime } from '@netforge/engine';
import type { LaneBucket, LaneId, SeekTarget, SimTime, TimelineMarkQuery, TimelineQuery, TraceEvent } from '@netforge/engine';
import type { ReviewInfo } from '../bridge/protocol';
import { dropLabel } from '../vocab/drops';
import { formatDurationNs } from '../vocab/fields';
import { fsmLabel } from '../vocab/fsm';
import { LANE_ORDER, LANE_VOCAB } from '../vocab/lanes';
import { portStateReasonText, traceKindLabel } from '../vocab/trace-kinds';

// ── sizes and wording ───────────────────────────────────────────────────────

const MS = 1_000_000;
const SEC = 1_000_000_000;

/** Pixels per bucket asked for: fine enough to see a burst, coarse enough to stay cheap. */
export const TIMELINE_PX_PER_BUCKET = 6;
/** Most buckets one query asks for. */
export const TIMELINE_MAX_BUCKETS = 240;
/** Shortest window a learner can zoom to (100 ms: one forward-delay tick is still a wide bar). */
export const TIMELINE_MIN_SPAN_NS = 100 * MS;
/** The window a fresh strip shows (the last minute). */
export const TIMELINE_DEFAULT_SPAN_NS = 60 * SEC;
/** Marks one `timelineMarks` query asks for. */
export const TIMELINE_MARKS_LIMIT = 200;
/** Intensity levels of a bucket (0 = empty). */
export const TIMELINE_MARK_LEVELS = 4;
/** Shortest wall gap between bucket queries (at most 4 Hz, like the sim-mode list). */
export const TIMELINE_QUERY_MS = 250;
/** Banner shown while the canvas shows an earlier instant (§6). */
export const TIMELINE_REVIEW_TITLE = 'Viewing the past — return to now';
/** Label of the button that leaves review. */
export const TIMELINE_RETURN_LABEL = 'Return to now';

// ── the window ──────────────────────────────────────────────────────────────

/** The stretch of sim time the strip shows. */
export interface TimelineWindow {
  readonly from: SimTime;
  readonly to: SimTime;
}

/** Length of a window in ns. */
export function windowSpan(w: TimelineWindow): SimTime {
  return w.to - w.from;
}

function clampSpan(span: number, headT: SimTime): number {
  const max = Math.max(headT, TIMELINE_DEFAULT_SPAN_NS);
  return Math.round(Math.min(Math.max(span, TIMELINE_MIN_SPAN_NS), max));
}

/** Move a window inside [0, max(head, span)] without changing its length. */
export function clampWindow(w: TimelineWindow, headT: SimTime): TimelineWindow {
  const span = clampSpan(windowSpan(w), headT);
  const limit = Math.max(headT, span);
  const from = Math.round(Math.min(Math.max(w.from, 0), limit - span));
  return { from, to: from + span };
}

/** The window that ends at the live head (a run shorter than the span starts at 0). */
export function liveWindow(headT: SimTime, spanNs: number = TIMELINE_DEFAULT_SPAN_NS): TimelineWindow {
  const span = clampSpan(spanNs, headT);
  return headT <= span ? { from: 0, to: span } : { from: headT - span, to: headT };
}

/** True when the window shows the live edge (and so follows it). */
export function isFollowing(w: TimelineWindow, headT: SimTime): boolean {
  return w.to >= headT;
}

/** Slide a following window with the head; a window a learner panned away from stays where it is. */
export function advanceWindow(w: TimelineWindow, prevHeadT: SimTime, headT: SimTime): TimelineWindow {
  return isFollowing(w, prevHeadT) ? liveWindow(headT, windowSpan(w)) : clampWindow(w, headT);
}

/** Zoom about `anchorT` (factor < 1 zooms in), keeping the anchor at its place in the window. */
export function zoomWindow(w: TimelineWindow, factor: number, anchorT: SimTime, headT: SimTime): TimelineWindow {
  const span = windowSpan(w);
  const next = clampSpan(span * factor, headT);
  const ratio = span > 0 ? (anchorT - w.from) / span : 0.5;
  const from = Math.round(anchorT - ratio * next);
  return clampWindow({ from, to: from + next }, headT);
}

/** Pan by `dt` ns (negative = towards the past). */
export function panWindow(w: TimelineWindow, dt: number, headT: SimTime): TimelineWindow {
  const from = Math.round(w.from + dt);
  return clampWindow({ from, to: from + windowSpan(w) }, headT);
}

// ── geometry ────────────────────────────────────────────────────────────────

/** Pixel of a time in the strip (clamped to the strip). */
export function timeToX(t: SimTime, w: TimelineWindow, widthPx: number): number {
  const span = windowSpan(w);
  if (span <= 0 || widthPx <= 0) return 0;
  const x = ((t - w.from) / span) * widthPx;
  return x < 0 ? 0 : x > widthPx ? widthPx : x;
}

/** Time under a pixel (integer ns, clamped to the window). */
export function xToTime(x: number, w: TimelineWindow, widthPx: number): SimTime {
  const span = windowSpan(w);
  if (span <= 0 || widthPx <= 0) return w.from;
  const t = Math.round(w.from + (Math.min(Math.max(x, 0), widthPx) / widthPx) * span);
  return t < w.from ? w.from : t > w.to ? w.to : t;
}

// ── queries ─────────────────────────────────────────────────────────────────

/** Buckets a strip of this width asks for. */
export function bucketCount(widthPx: number, pxPerBucket: number = TIMELINE_PX_PER_BUCKET): number {
  const n = Math.floor(widthPx / Math.max(1, pxPerBucket));
  return Math.min(Math.max(n, 1), TIMELINE_MAX_BUCKETS);
}

/** The bucket query of a window (`lanes` left out = every lane). */
export function bucketQuery(w: TimelineWindow, widthPx: number, lanes?: readonly LaneId[]): TimelineQuery {
  const q: TimelineQuery = { from: w.from, to: w.to, buckets: bucketCount(widthPx) };
  return lanes === undefined ? q : { ...q, lanes: [...lanes] };
}

/** The marks query of one lane in a window. */
export function marksQuery(lane: LaneId, w: TimelineWindow, limit: number = TIMELINE_MARKS_LIMIT): TimelineMarkQuery {
  return { lane, from: w.from, to: w.to, limit };
}

/**
 * Identity of a bucket answer: window, bucket count, lanes and the worker's `lanesRevision` (the lane index grew).
 * The strip re-queries when this changes and not otherwise.
 */
export function bucketsKey(q: TimelineQuery, lanesRevision: number): string {
  return `${q.from}|${q.to}|${q.buckets}|${q.lanes === undefined ? '*' : [...q.lanes].join(',')}|${lanesRevision}`;
}

// ── lane rows ───────────────────────────────────────────────────────────────

/** One bucket of one lane that holds at least one event. */
export interface LaneCell {
  readonly index: number;
  readonly from: SimTime;
  readonly to: SimTime;
  readonly count: number;
  /** 1..TIMELINE_MARK_LEVELS, relative to the busiest bucket of the same lane. */
  readonly level: number;
  /** Ring cursor of the first event of this lane in this bucket (the seek target of a click). */
  readonly firstCursor?: number;
}

/** One lane of the strip. */
export interface LaneRow {
  readonly lane: LaneId;
  readonly label: string;
  readonly glyph: string;
  readonly hint: string;
  readonly total: number;
  readonly peak: number;
  readonly cells: readonly LaneCell[];
}

/** Level of a bucket against its lane's peak (0 when empty). */
export function markLevel(count: number, peak: number): number {
  if (count <= 0 || peak <= 0) return 0;
  return Math.min(TIMELINE_MARK_LEVELS, Math.max(1, Math.ceil((count * TIMELINE_MARK_LEVELS) / peak)));
}

/** Options of `laneRows`. */
export interface LaneRowOptions {
  /** Leave out lanes with no event in the window (default false: every lane keeps its row). */
  readonly hideEmpty?: boolean;
}

/**
 * Turn the worker's buckets into rows, in lane vocabulary order. `lanes` limits and orders nothing beyond that: the
 * display order is always the vocabulary's, so lanes never jump about between two answers.
 */
export function laneRows(buckets: readonly LaneBucket[], lanes?: readonly LaneId[], opts: LaneRowOptions = {}): LaneRow[] {
  const wanted = lanes === undefined ? LANE_ORDER : LANE_ORDER.filter((l) => lanes.includes(l));
  const rows: LaneRow[] = [];
  for (const lane of wanted) {
    let total = 0;
    let peak = 0;
    for (const b of buckets) {
      const count = b.counts[lane] ?? 0;
      total += count;
      if (count > peak) peak = count;
    }
    if (total === 0 && opts.hideEmpty === true) continue;
    const cells: LaneCell[] = [];
    buckets.forEach((b, index) => {
      const count = b.counts[lane] ?? 0;
      if (count <= 0) return;
      const cursor = b.firstCursor[lane];
      cells.push({
        index,
        from: b.from,
        to: b.to,
        count,
        level: markLevel(count, peak),
        ...(cursor === undefined ? {} : { firstCursor: cursor }),
      });
    });
    const v = LANE_VOCAB[lane];
    rows.push({ lane, label: v.label, glyph: v.glyph, hint: v.hint, total, peak, cells });
  }
  return rows;
}

// ── cursor, review and seeks ────────────────────────────────────────────────

/** True while the canvas shows an earlier instant than the live world. */
export function isReviewing(review: ReviewInfo | null | undefined): review is ReviewInfo {
  return review !== null && review !== undefined && !review.atLive;
}

/** Where the scrubber's handle sits: the reviewed instant, or the live head. */
export function cursorTime(review: ReviewInfo | null | undefined, headT: SimTime): SimTime {
  return isReviewing(review) ? review.t : headT;
}

/** What a drag or a key asks the worker for. */
export type ScrubAction =
  | { readonly kind: 'seek'; readonly target: SeekTarget }
  /** Leave review (the learner reached the live edge). */
  | { readonly kind: 'live' }
  /** Nothing to do (already there). */
  | { readonly kind: 'none' };

/** The action of putting the handle at pixel `x`. */
export function scrubAction(x: number, w: TimelineWindow, widthPx: number, headT: SimTime, review: ReviewInfo | null | undefined): ScrubAction {
  const t = xToTime(x, w, widthPx);
  if (t >= headT) return isReviewing(review) ? { kind: 'live' } : { kind: 'none' };
  if (isReviewing(review) && review.t === t) return { kind: 'none' };
  return { kind: 'seek', target: { time: t } };
}

/** The action of clicking a lane cell: its first event (by ring cursor when the worker gave one, else its start). */
export function cellAction(cell: LaneCell): ScrubAction {
  return { kind: 'seek', target: cell.firstCursor === undefined ? { time: cell.from } : { cursor: cell.firstCursor } };
}

/** Keys the strip handles. */
export type TimelineKey = 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End' | 'PageUp' | 'PageDown';

/** True when the strip handles this key. */
export function isTimelineKey(key: string): key is TimelineKey {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Home' || key === 'End' || key === 'PageUp' || key === 'PageDown';
}

/**
 * Keyboard scrubbing: an arrow moves a fiftieth of the window (a tenth with shift), a page key half of it, Home goes
 * to the origin and End returns to now.
 */
export function keyAction(
  key: TimelineKey,
  opts: { readonly window: TimelineWindow; readonly headT: SimTime; readonly review: ReviewInfo | null | undefined; readonly shift?: boolean },
): ScrubAction {
  const { window: w, headT, review } = opts;
  const cursor = cursorTime(review, headT);
  const span = windowSpan(w);
  const step = Math.max(1, Math.round(span / (opts.shift === true ? 10 : 50)));
  const page = Math.max(1, Math.round(span / 2));
  const to = (t: SimTime): ScrubAction => {
    const clamped = Math.max(0, Math.round(t));
    if (clamped >= headT) return isReviewing(review) ? { kind: 'live' } : { kind: 'none' };
    return { kind: 'seek', target: { time: clamped } };
  };
  switch (key) {
    case 'ArrowLeft':
      return to(cursor - step);
    case 'ArrowRight':
      return to(cursor + step);
    case 'PageUp':
      return to(cursor - page);
    case 'PageDown':
      return to(cursor + page);
    case 'Home':
      return to(0);
    case 'End':
      return isReviewing(review) ? { kind: 'live' } : { kind: 'none' };
  }
}

/** The review banner's four pieces of text. */
export interface ReviewBanner {
  readonly title: string;
  /** The reviewed instant, `00:01:23.456789`. */
  readonly at: string;
  /** How far back it is, "12.5 s before now". */
  readonly behind: string;
  readonly action: string;
}

/** The banner of the current review, or null when the canvas shows the live world. */
export function reviewBanner(review: ReviewInfo | null | undefined): ReviewBanner | null {
  if (!isReviewing(review)) return null;
  const behind = Math.max(0, review.live.now - review.t);
  return {
    title: TIMELINE_REVIEW_TITLE,
    at: formatSimTime(review.t),
    behind: `${formatDurationNs(behind)} before now`,
    action: TIMELINE_RETURN_LABEL,
  };
}

// ── marks ───────────────────────────────────────────────────────────────────

/** One mark of `EngineApi.timelineMarks`. */
export interface TimelineMark {
  readonly cursor: number;
  readonly t: SimTime;
  readonly lane: LaneId;
  readonly event: TraceEvent;
}

/** The action of clicking a mark: seek to its ring cursor. */
export function markAction(mark: TimelineMark): ScrubAction {
  return { kind: 'seek', target: { cursor: mark.cursor } };
}

function tableTitle(name: string): string {
  const d = (TABLE_DESCRIPTORS as Readonly<Record<string, { title: string }>>)[name];
  return d?.title ?? name;
}

/** One line describing a mark's event; `deviceName` resolves device ids when the caller can. */
export function markText(mark: TimelineMark, deviceName?: (id: string) => string): string {
  const ev = mark.event;
  const who = (id: string | undefined): string => (id === undefined ? '' : deviceName ? deviceName(id) : id);
  switch (ev.kind) {
    case 'debug': {
      const fsm = ev.event.fsm;
      if (fsm === undefined) return `${who(ev.event.device)}: ${ev.event.message}`;
      const cause = fsm.cause === undefined ? '' : ` (${fsm.cause})`;
      return `${fsmLabel(fsm.machine)} · ${fsm.subject}: ${fsm.from} → ${fsm.to}${cause}`;
    }
    case 'tableWrite':
      return `${who(ev.device)}: ${tableTitle(ev.table)} ${ev.key} written`;
    case 'tableExpire':
      return `${who(ev.device)}: ${tableTitle(ev.table)} ${ev.key} removed (${ev.reason})`;
    case 'configChange':
      return `${who(ev.device)}: ${ev.negate ? 'no ' : ''}${ev.line}`;
    case 'linkState':
      return `${ev.link} ${ev.up ? 'up' : 'down'}${ev.reason === undefined ? '' : ` (${ev.reason})`}`;
    case 'portState': {
      const reason = ev.reason === undefined ? '' : ` — ${portStateReasonText(ev.reason)}`;
      return `${who(ev.device)} ${ev.port} ${ev.operUp ? 'up' : 'down'}${reason}`;
    }
    case 'drop': {
      const detail = ev.detail === undefined ? '' : ` (${ev.detail})`;
      const at = ev.device === undefined ? '' : `${who(ev.device)}: `;
      return `${at}${dropLabel(ev.reason)}${detail}`;
    }
    default:
      return traceKindLabel(ev.kind);
  }
}

/** Tooltip of a mark: its time, its lane and the line `markText` writes. */
export function markTooltip(mark: TimelineMark, deviceName?: (id: string) => string): string {
  return `${formatSimTime(mark.t)} · ${LANE_VOCAB[mark.lane].label} · ${markText(mark, deviceName)}`;
}

// ── ticks ───────────────────────────────────────────────────────────────────

/** A tick under the scrubber. */
export interface TimelineTick {
  readonly t: SimTime;
  readonly x: number;
  readonly label: string;
}

/** Tick steps in ns, 1-2-5 per decade from a millisecond, then the minute and hour steps a lab needs. */
const TICK_STEPS: readonly number[] = Object.freeze([
  MS,
  2 * MS,
  5 * MS,
  10 * MS,
  20 * MS,
  50 * MS,
  100 * MS,
  200 * MS,
  500 * MS,
  SEC,
  2 * SEC,
  5 * SEC,
  10 * SEC,
  15 * SEC,
  30 * SEC,
  60 * SEC,
  2 * 60 * SEC,
  5 * 60 * SEC,
  10 * 60 * SEC,
  15 * 60 * SEC,
  30 * 60 * SEC,
  60 * 60 * SEC,
]);

/** The tick step that keeps at least `minGapPx` between two ticks. */
export function tickStep(w: TimelineWindow, widthPx: number, minGapPx = 80): number {
  const span = windowSpan(w);
  if (span <= 0 || widthPx <= 0) return TICK_STEPS[TICK_STEPS.length - 1] as number;
  const wanted = (span * minGapPx) / widthPx;
  return TICK_STEPS.find((s) => s >= wanted) ?? (TICK_STEPS[TICK_STEPS.length - 1] as number);
}

/** Label of a tick: `m:ss`, `h:mm:ss` past an hour, and milliseconds while the step is below a second. */
export function tickLabel(t: SimTime, step: number): string {
  const totalMs = Math.round(t / MS);
  const ms = totalMs % 1000;
  const totalS = Math.floor(totalMs / 1000);
  const s = totalS % 60;
  const m = Math.floor(totalS / 60) % 60;
  const h = Math.floor(totalS / 3600);
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  const base = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  return step < SEC ? `${base}.${pad(ms, 3)}` : base;
}

/** Every tick of a window, left to right. */
export function timelineTicks(w: TimelineWindow, widthPx: number, minGapPx = 80): TimelineTick[] {
  const step = tickStep(w, widthPx, minGapPx);
  const out: TimelineTick[] = [];
  const first = Math.ceil(w.from / step) * step;
  for (let t = first; t <= w.to; t += step) out.push({ t, x: timeToX(t, w, widthPx), label: tickLabel(t, step) });
  return out;
}

// ── seek coalescing ─────────────────────────────────────────────────────────

/** What a queued seek did. */
export type SeekOutcome<R> =
  | { readonly status: 'done'; readonly result: R }
  /** A newer seek replaced this one before it ran. */
  | { readonly status: 'superseded' }
  | { readonly status: 'failed'; readonly error: unknown };

/** One seek at a time; the latest request wins (§3.13 step 3: a newer seek cancels an older one). */
export interface SeekQueue<R> {
  request(target: SeekTarget): Promise<SeekOutcome<R>>;
  /** A seek is in flight (the strip's "seeking" state). */
  readonly busy: boolean;
  /** The target waiting for the one in flight, if any. */
  readonly pending: SeekTarget | null;
}

/** Build a queue around `run` (normally `EngineApi.seek`). */
export function createSeekQueue<R>(run: (target: SeekTarget) => Promise<R>): SeekQueue<R> {
  type Waiting = { target: SeekTarget; resolve: (o: SeekOutcome<R>) => void };
  let busy = false;
  let pending: Waiting | null = null;

  /** Clear the queue BEFORE resolving, so a caller waiting on the outcome sees `busy` as it is afterwards. */
  const finish = (w: Waiting, outcome: SeekOutcome<R>): void => {
    busy = false;
    const next = pending;
    pending = null;
    w.resolve(outcome);
    if (next !== null) start(next);
  };

  const start = (w: Waiting): void => {
    busy = true;
    let p: Promise<R>;
    try {
      p = run(w.target);
    } catch (error) {
      p = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    void p.then(
      (result) => finish(w, { status: 'done', result }),
      (error: unknown) => finish(w, { status: 'failed', error }),
    );
  };

  return {
    request(target: SeekTarget): Promise<SeekOutcome<R>> {
      return new Promise<SeekOutcome<R>>((resolve) => {
        const waiting: Waiting = { target, resolve };
        if (!busy) start(waiting);
        else {
          pending?.resolve({ status: 'superseded' });
          pending = waiting;
        }
      });
    },
    get busy(): boolean {
      return busy;
    },
    get pending(): SeekTarget | null {
      return pending === null ? null : pending.target;
    },
  };
}

/**
 * True when a rejection is the engine refusing a change while reviewing (`REPLAY_READ_ONLY_MESSAGE`), so the UI can
 * show the banner's "return to now" instead of an error.
 */
export function isReadOnlyRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === REPLAY_READ_ONLY_MESSAGE;
}
