/**
 * timeline/TimelineStrip.tsx — the timeline strip [SHOULD S1] (ARCHITECTURE-P2 §2.14, §3.13, §6): its own grid row
 * between the workspace and the dock (app/App.tsx), with a header, the review banner, the position slider
 * (`Scrubber.tsx`) and the lanes (`LaneRows.tsx`).
 *
 * How it talks to the worker (bridge/protocol.ts, bridge/worker/{time-machine,lanes}.ts):
 *   - a drag, a key, a bar or a listed event becomes a `ScrubAction` (timeline-client); seeks go through ONE seek queue
 *     (`createSeekQueue`): one `engine.seek` in flight, a newer request replacing a waiting one. The batch the worker
 *     posts with `review` set moves the store (`timeline.review`), so the canvas, tables and packets show that instant;
 *   - "return to now" (the banner's button, End, Escape, or dragging to the live edge) is `engine.leaveReview()`; it
 *     also cancels a seek still waiting in the queue, so a drag that ends at "now" never re-enters the past;
 *   - the lanes are `engine.timelineBuckets` for the window on screen, asked at most every TIMELINE_QUERY_MS and only
 *     when the window, the width, the lane choice or the worker's lane index (`head.lanesRevision`) moved — so a
 *     configuration change or a power cut while paused shows at once; a lane's event list is `engine.timelineMarks`.
 *
 * Live and review look different on purpose: a "Live" or "Past" badge (text), the banner "Viewing the past — return to
 * now" with the reviewed instant, how far behind now it is and the one "Return to now" button, a diamond instead of a
 * round handle, the stretch between the handle and now shaded, and (App.tsx, timeline.css) a framed canvas with the
 * words "Viewing the past". A polite live region says when review starts and ends.
 *
 * Disabled states the strip respects (the slider is `aria-disabled`, bars and listed events do nothing, and a note says
 * why): no timeline yet (the engine is starting, or no batch has carried a timeline head); and HISTORY OFF — a seek the
 * worker rejected with a replay fault (`ReplayDivergenceError`/`ReplayExhaustedError`: the time machine drops its
 * replayers and refuses every seek until the next world, §3.13 step 6, time-machine.ts `faulted`), or an engine with no
 * time machine at all. A new world (epoch) clears it. The lanes keep working while history is off: they come from the
 * lane index, not from the replayers.
 *
 * The container (`TimelineStrip`) owns the hooks; `TimelineStripView` is a plain function of its props and the seek
 * logic is `createTimelineController`, so both are tested without a DOM (test/timeline.strip.test.ts).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, Ref } from 'react';
import { formatSimTime } from '@netforge/engine';
import type { DeviceSnapshot, LaneBucket, LaneId, SeekTarget, SimTime, TimelineMarkQuery, TimelineQuery } from '@netforge/engine';
import { engine } from '../bridge/client';
import type { EngineApi, ReviewInfo } from '../bridge/protocol';
import { store, useStore } from '../store/store';
import { LANE_ORDER } from '../vocab/lanes';
import { LaneMarks, LaneRows, type LaneMarksState } from './LaneRows';
import { SCRUBBER_HINT, Scrubber } from './Scrubber';
import {
  TIMELINE_MIN_SPAN_NS,
  TIMELINE_QUERY_MS,
  advanceWindow,
  bucketQuery,
  bucketsKey,
  clampWindow,
  createSeekQueue,
  isReviewing,
  laneRows,
  liveWindow,
  marksQuery,
  reviewBanner,
  windowSpan,
  zoomWindow,
  type LaneRow,
  type ScrubAction,
  type TimelineMark,
  type TimelineWindow,
} from './timeline-client';
import './timeline.css';

// ── wording ─────────────────────────────────────────────────────────────────

/** The note while no timeline exists yet. */
export const TIMELINE_WAITING_TEXT = 'The timeline starts once the simulation is running.';
/** The note once a replay fault turned history off (original wording). */
export const HISTORY_OFF_TEXT =
  'History is off for this network: replaying its recording gave a different result, so earlier moments cannot be shown. A new or reloaded network starts a fresh history.';
/** The note for an engine without a time machine. */
export const TIMELINE_UNAVAILABLE_TEXT = 'Going back in time is not available in this simulator build.';
/** Said (politely) when review starts and ends. */
export const REVIEW_STARTED_TEXT = 'Viewing the past. The network cannot be changed until you return to now.';
export const REVIEW_ENDED_TEXT = 'Back to the present.';

/** Track width assumed before the first measurement (px). */
export const DEFAULT_TRACK_PX = 600;
/** Zoom factor of one press of the zoom buttons. */
export const TIMELINE_ZOOM_STEP = 2;

// ── the controller: seeks, return to now, queries ───────────────────────────

/**
 * The part of the engine the strip uses. The worker implements all four (EngineApi requires them since the W8 exit
 * gate); they stay optional HERE because the controller also runs over an engine without a time machine and then says
 * so (TIMELINE_UNAVAILABLE_TEXT) instead of throwing — the file header's last disabled state, pinned by
 * test/timeline.strip.test.ts "says so when the engine has no time machine".
 */
export type TimelineEngine = Partial<Pick<EngineApi, 'seek' | 'leaveReview' | 'timelineBuckets' | 'timelineMarks'>>;

/** What a seek resolves with. */
export type SeekReply = Awaited<ReturnType<EngineApi['seek']>>;

/** What the controller tells the strip. */
export interface TimelineControllerHooks {
  /** A seek is in flight or waiting (the store's `timeline.seeking`). */
  setSeeking(busy: boolean): void;
  /** The time the handle should show while a seek runs (null: show the store's review or the head). */
  setPreview(t: SimTime | null): void;
  /** Seeking is off, with the reason to show. */
  historyOff(reason: string): void;
  /** An error worth a notification. */
  report(message: string): void;
  /** The store currently shows the past. */
  isReviewing(): boolean;
}

export interface TimelineController {
  /** Carry out a drag, key, bar or list action; `hintT` is where a cursor/position target will land, for the handle. */
  act(action: ScrubAction, hintT?: SimTime): Promise<void>;
  /** Leave review now, cancelling a seek still waiting in the queue. */
  returnToNow(): Promise<void>;
  /** The buckets of `q`, or undefined when nothing changed since the last answer (or a query is in flight). */
  buckets(q: TimelineQuery, revision: number): Promise<LaneBucket[] | undefined>;
  /** The marks of one lane. */
  marks(q: TimelineMarkQuery): Promise<TimelineMark[]>;
  /** A new world: history on again, the next bucket query always runs, queued seeks are cancelled. */
  reset(): void;
  /** Why seeking is off, or null. */
  readonly disabledReason: string | null;
  /** A seek is in flight. */
  readonly busy: boolean;
}

/** Thrown to a queued seek that "return to now" cancelled before it started. */
class SeekCancelledError extends Error {
  constructor() {
    super('The seek was cancelled by a return to now.');
    this.name = 'SeekCancelledError';
  }
}

function nameOf(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'name' in err) return String((err as { name: unknown }).name);
  return '';
}

/** The error text of a rejection. */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The "history off" note a rejection calls for, or null when it is not a replay fault. */
export function historyOffReason(err: unknown): string | null {
  const name = nameOf(err);
  return name === 'ReplayDivergenceError' || name === 'ReplayExhaustedError' ? HISTORY_OFF_TEXT : null;
}

/** True for a rejection nobody needs to hear about: a newer seek or a return to now replaced this one. */
export function isQuietSeekFailure(err: unknown): boolean {
  const name = nameOf(err);
  return name === 'SeekSupersededError' || name === 'SeekCancelledError';
}

/** Build the strip's controller over `engine` (normally the worker client). */
export function createTimelineController(api: TimelineEngine, hooks: TimelineControllerHooks): TimelineController {
  /** Bumped by "return to now" and by a new world: a queued seek of an older generation never starts. */
  let generation = 0;
  const generationOf = new WeakMap<SeekTarget, number>();
  let offReason: string | null = null;
  let lastKey = '';
  let fetching = false;

  const queue = createSeekQueue<SeekReply>((target) => {
    if (generationOf.get(target) !== generation) return Promise.reject(new SeekCancelledError());
    if (typeof api.seek !== 'function') return Promise.reject(Object.assign(new Error(TIMELINE_UNAVAILABLE_TEXT), { name: 'TimelineUnavailable' }));
    return api.seek(target);
  });

  const turnOff = (reason: string): void => {
    if (offReason !== null) return;
    offReason = reason;
    hooks.historyOff(reason);
  };

  const settle = (): void => {
    if (queue.busy || queue.pending !== null) return;
    hooks.setPreview(null);
    hooks.setSeeking(false);
  };

  const returnToNow = async (): Promise<void> => {
    generation++;
    const wasBusy = queue.busy || queue.pending !== null;
    hooks.setPreview(null);
    if (!wasBusy && !hooks.isReviewing()) return;
    if (typeof api.leaveReview !== 'function') return;
    try {
      await api.leaveReview();
    } catch (err) {
      hooks.report(messageOf(err));
    } finally {
      settle();
    }
  };

  return {
    async act(action, hintT) {
      if (action.kind === 'none') return;
      if (action.kind === 'live') return returnToNow();
      if (offReason !== null) return;
      if (typeof api.seek !== 'function') {
        turnOff(TIMELINE_UNAVAILABLE_TEXT);
        return;
      }
      const target = action.target;
      generationOf.set(target, generation);
      hooks.setPreview('time' in target ? target.time : (hintT ?? null));
      hooks.setSeeking(true);
      const outcome = await queue.request(target);
      settle();
      if (outcome.status !== 'failed' || isQuietSeekFailure(outcome.error)) return;
      const reason = nameOf(outcome.error) === 'TimelineUnavailable' ? TIMELINE_UNAVAILABLE_TEXT : historyOffReason(outcome.error);
      if (reason !== null) turnOff(reason);
      else hooks.report(messageOf(outcome.error));
    },
    returnToNow,
    async buckets(q, revision) {
      const key = bucketsKey(q, revision);
      if (key === lastKey || fetching || typeof api.timelineBuckets !== 'function') return undefined;
      fetching = true;
      try {
        const answer = await api.timelineBuckets(q);
        lastKey = key;
        return answer;
      } catch {
        // a refused query is not retried until something moves (the key changes)
        lastKey = key;
        return undefined;
      } finally {
        fetching = false;
      }
    },
    async marks(q) {
      if (typeof api.timelineMarks !== 'function') return [];
      return api.timelineMarks(q);
    },
    reset() {
      generation++;
      offReason = null;
      lastKey = '';
    },
    get disabledReason() {
      return offReason;
    },
    get busy() {
      return queue.busy;
    },
  };
}

// ── small pure helpers ──────────────────────────────────────────────────────

/**
 * The lane query of window `w` at `head`, keyed on the worker's lane-index revision (`head.lanesRevision`), never on
 * sim time or the dispatched-event count: a change made while paused (a configuration line, a power cut) adds lane
 * events without dispatching anything, and the lanes must show it at once. `undefined` = nothing moved, or a query is
 * already in flight.
 */
export function requestLaneBuckets(
  controller: Pick<TimelineController, 'buckets'>,
  head: { readonly lanesRevision: number },
  w: TimelineWindow,
  widthPx: number,
  lanes: readonly LaneId[] | undefined,
): Promise<LaneBucket[] | undefined> {
  return controller.buckets(bucketQuery(w, widthPx, lanesFilter(lanes)), head.lanesRevision);
}

/** Escape anywhere in the strip returns to now while the past is shown (or a seek is on its way). */
export function handleStripKey(
  e: Pick<KeyboardEvent, 'key' | 'preventDefault' | 'stopPropagation'>,
  ctx: { reviewing: boolean; returnToNow(): void },
): boolean {
  if (e.key !== 'Escape' || !ctx.reviewing) return false;
  e.preventDefault();
  // the global hotkeys would also clear the selection; leaving the past is all this key does here
  e.stopPropagation();
  ctx.returnToNow();
  return true;
}

/** The lanes to ask for: undefined when the choice is every lane (the worker's default). */
export function lanesFilter(lanes: readonly LaneId[] | undefined): LaneId[] | undefined {
  if (lanes === undefined) return undefined;
  return LANE_ORDER.every((l) => lanes.includes(l)) ? undefined : [...lanes];
}

/** The window, moved so the instant `t` is in view (a quarter from its left edge) when it is outside it. */
export function windowShowing(w: TimelineWindow, t: SimTime, headT: SimTime): TimelineWindow {
  if (t >= w.from && t <= w.to) return w;
  const span = windowSpan(w);
  const from = Math.round(t - span / 4);
  return clampWindow({ from, to: from + span }, headT);
}

const sameWindow = (a: TimelineWindow, b: TimelineWindow): boolean => a.from === b.from && a.to === b.to;

/** The store's `timeline.seeking`, written as the strip's own UI state (batches never touch it). */
export function writeTimelineSeeking(busy: boolean): void {
  const tl = store.getState().timeline;
  if (tl.seeking === busy) return;
  store.setState({ timeline: { ...tl, seeking: busy } });
}

// ── the view ────────────────────────────────────────────────────────────────

export interface TimelineStripViewProps {
  headT: SimTime;
  review: ReviewInfo | null;
  previewT: SimTime | null;
  seeking: boolean;
  window: TimelineWindow;
  widthPx: number;
  /** Why seeking is off (shown, and the slider's description), or null. */
  note: string | null;
  rows: readonly LaneRow[];
  /** Lanes left out because they are quiet in view. */
  hiddenLanes: number;
  /** No bucket answer yet. */
  lanesLoading: boolean;
  lanesOpen: boolean;
  showQuiet: boolean;
  openLane: LaneId | null;
  marks: LaneMarksState | null;
  deviceName?: (id: string) => string;
  ids: { note: string; hint: string; lanes: string; marks: string };
  /** What the polite live region says (review started / ended; empty before the first review). */
  announcement: string;
  trackRef?: Ref<HTMLDivElement>;
  on: {
    action(action: ScrubAction, hintT?: SimTime): void;
    returnToNow(): void;
    zoom(factor: number): void;
    wholeRun(): void;
    toggleLanes(): void;
    toggleQuiet(): void;
    toggleLane(lane: LaneId): void;
    closeMarks(): void;
    keyDown(e: KeyboardEvent<HTMLDivElement>): void;
  };
}

/** The strip as a plain function of its state (see the file header). */
export function TimelineStripView(p: TimelineStripViewProps) {
  const past = isReviewing(p.review);
  const banner = reviewBanner(p.review);
  const disabled = p.note !== null;
  const openRow = p.openLane === null ? undefined : p.rows.find((r) => r.lane === p.openLane);
  return (
    <div className={`tl${past ? ' tl-review' : ' tl-live'}`} data-review={past ? 'true' : 'false'} onKeyDown={p.on.keyDown}>
      <div className="tl-head">
        <span className={`tl-badge ${past ? 'is-past' : 'is-live'}`}>{past ? 'Past' : 'Live'}</span>
        <h2 className="tl-title">Timeline</h2>
        <span className="tl-readout mono">{banner !== null ? `${banner.at} · ${banner.behind}` : `Now ${formatSimTime(p.headT)}`}</span>
        {p.seeking && (
          <span className="chip accent" title="The simulator is replaying the recording up to the chosen instant.">
            Replaying…
          </span>
        )}
        <span className="tl-spacer" />
        <button type="button" className="btn btn-ghost btn-icon tl-small" aria-label="Zoom in" title="Zoom in (show a shorter stretch of time)" onClick={() => p.on.zoom(1 / TIMELINE_ZOOM_STEP)}>
          +
        </button>
        <button type="button" className="btn btn-ghost btn-icon tl-small" aria-label="Zoom out" title="Zoom out (show a longer stretch of time)" onClick={() => p.on.zoom(TIMELINE_ZOOM_STEP)}>
          −
        </button>
        <button type="button" className="btn btn-ghost tl-small" title="Show the whole run" onClick={p.on.wholeRun}>
          Whole run
        </button>
        <button type="button" className="btn btn-ghost tl-small" aria-expanded={p.lanesOpen} aria-controls={p.ids.lanes} onClick={p.on.toggleLanes}>
          {p.lanesOpen ? 'Hide lanes' : 'Show lanes'}
        </button>
      </div>
      {banner !== null && (
        <div className="tl-banner" role="group" aria-label="Viewing the past">
          <strong className="tl-banner-title">{banner.title}</strong>
          <span className="mono">{banner.at}</span>
          <span>({banner.behind})</span>
          <button type="button" className="btn btn-primary tl-small" onClick={p.on.returnToNow}>
            {banner.action}
          </button>
          <span className="tl-banner-hint">or press Escape</span>
        </div>
      )}
      <div className="tl-sr-only" role="status" aria-live="polite">
        {p.announcement}
      </div>
      {p.note !== null && (
        <p id={p.ids.note} className="tl-note tl-disabled-note">
          {p.note}
        </p>
      )}
      <span id={p.ids.hint} className="tl-sr-only">
        {SCRUBBER_HINT}
      </span>
      <Scrubber
        window={p.window}
        headT={p.headT}
        review={p.review}
        previewT={p.previewT}
        widthPx={p.widthPx}
        disabled={disabled}
        describedBy={disabled ? p.ids.note : p.ids.hint}
        trackRef={p.trackRef}
        onAction={p.on.action}
      />
      {p.lanesOpen && (
        <div id={p.ids.lanes} className="tl-lanes-wrap">
          <LaneRows
            rows={p.rows}
            window={p.window}
            widthPx={p.widthPx}
            disabled={disabled}
            openLane={p.openLane}
            marksId={p.ids.marks}
            loading={p.lanesLoading}
            onAction={p.on.action}
            onToggleLane={p.on.toggleLane}
          />
          {(p.hiddenLanes > 0 || p.showQuiet) && (
            <button type="button" className="btn btn-ghost tl-small tl-quiet" onClick={p.on.toggleQuiet}>
              {p.showQuiet ? 'Hide quiet lanes' : `Show ${p.hiddenLanes} quiet ${p.hiddenLanes === 1 ? 'lane' : 'lanes'}`}
            </button>
          )}
          {p.marks !== null && (
            <LaneMarks
              id={p.ids.marks}
              state={p.marks}
              row={openRow}
              disabled={disabled}
              deviceName={p.deviceName}
              onAction={p.on.action}
              onClose={p.on.closeMarks}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── the container ───────────────────────────────────────────────────────────

/** Device id → name for the event list (the raw id when the device is gone). */
export function deviceNamesOf(devices: readonly Pick<DeviceSnapshot, 'id' | 'name'>[] | undefined): (id: string) => string {
  const names = new Map<string, string>();
  for (const d of devices ?? []) names.set(d.id, d.name);
  return (id) => names.get(id) ?? id;
}

/** The live region's words: nothing before the first review, then whether the past or the present is shown. */
export function reviewAnnouncement(past: boolean, everPast: boolean): string {
  if (past) return REVIEW_STARTED_TEXT;
  return everPast ? REVIEW_ENDED_TEXT : '';
}

/** The timeline row (App.tsx puts it between the workspace and the dock). */
export function TimelineStrip() {
  const ready = useStore((s) => s.ready);
  const epoch = useStore((s) => s.epoch);
  const head = useStore((s) => s.timeline.head);
  const review = useStore((s) => s.timeline.review);
  const seeking = useStore((s) => s.timeline.seeking);
  const storeLanes = useStore((s) => s.timeline.lanes);
  const devices = useStore((s) => s.snapshot?.devices);

  const headT = head?.t ?? 0;
  const [win, setWin] = useState<TimelineWindow>(() => liveWindow(headT));
  const [answer, setAnswer] = useState<readonly LaneBucket[] | null>(null);
  const [previewT, setPreviewT] = useState<SimTime | null>(null);
  const [off, setOff] = useState<string | null>(null);
  const [lanesOpen, setLanesOpen] = useState(true);
  const [showQuiet, setShowQuiet] = useState(false);
  const [openLane, setOpenLane] = useState<LaneId | null>(null);
  const [marks, setMarks] = useState<LaneMarksState | null>(null);
  const [width, setWidth] = useState(DEFAULT_TRACK_PX);

  const winRef = useRef(win);
  const headRef = useRef(headT);
  const widthRef = useRef(width);
  const lanesRef = useRef(storeLanes);
  lanesRef.current = storeLanes;
  const trackRef = useRef<HTMLDivElement>(null);
  const base = useId();
  const ids = useMemo(() => ({ note: `${base}-note`, hint: `${base}-hint`, lanes: `${base}-lanes`, marks: `${base}-marks` }), [base]);

  const controller = useMemo(
    () =>
      createTimelineController(engine, {
        setSeeking: writeTimelineSeeking,
        setPreview: setPreviewT,
        historyOff: setOff,
        report: (message) => store.getState().toast(message, 'error'),
        isReviewing: () => isReviewing(store.getState().timeline.review),
      }),
    [],
  );

  const applyWindow = useCallback((next: TimelineWindow): void => {
    if (sameWindow(next, winRef.current)) return;
    winRef.current = next;
    setWin(next);
  }, []);

  /** Ask for the buckets of the window on screen when something moved (at most one query in flight). */
  const refresh = useCallback((): void => {
    const h = store.getState().timeline.head;
    if (h === null) return;
    void requestLaneBuckets(controller, h, winRef.current, widthRef.current, lanesRef.current).then((buckets) => {
      if (buckets !== undefined) setAnswer(buckets);
    });
  }, [controller]);

  // a new world: a fresh history, the live window, nothing listed
  useEffect(() => {
    controller.reset();
    setOff(null);
    setAnswer(null);
    setPreviewT(null);
    setOpenLane(null);
    setMarks(null);
    const h = store.getState().timeline.head?.t ?? 0;
    headRef.current = h;
    applyWindow(liveWindow(h, windowSpan(winRef.current)));
  }, [epoch, controller, applyWindow]);

  // the window follows the live head (when it shows it) and the lanes refresh, at most every TIMELINE_QUERY_MS
  useEffect(() => {
    const tick = (): void => {
      const h = store.getState().timeline.head;
      if (h === null) return;
      const prev = headRef.current;
      headRef.current = h.t;
      applyWindow(advanceWindow(winRef.current, prev, h.t));
      refresh();
    };
    tick();
    const id = setInterval(tick, TIMELINE_QUERY_MS);
    return () => clearInterval(id);
  }, [applyWindow, refresh]);

  // the track's width decides the bucket count and the tick density
  useEffect(() => {
    const el = trackRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const px = Math.max(1, Math.round(el.clientWidth));
      if (px === widthRef.current) return;
      widthRef.current = px;
      setWidth(px);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // the reviewed instant stays in view (a seek to an instant outside the window pans to it)
  const reviewT = isReviewing(review) ? review.t : null;
  useEffect(() => {
    if (reviewT !== null) applyWindow(windowShowing(winRef.current, reviewT, headRef.current));
  }, [reviewT, applyWindow]);

  // the open lane's events, re-read whenever the lanes are
  useEffect(() => {
    if (openLane === null) return;
    let alive = true;
    controller.marks(marksQuery(openLane, winRef.current)).then(
      (list) => {
        if (alive) setMarks({ lane: openLane, marks: list });
      },
      (err: unknown) => {
        if (alive) setMarks({ lane: openLane, marks: [], error: messageOf(err) });
      },
    );
    return () => {
      alive = false;
    };
  }, [openLane, answer, controller]);

  const returnToNow = useCallback((): void => {
    applyWindow(liveWindow(headRef.current, windowSpan(winRef.current)));
    void controller.returnToNow();
  }, [controller, applyWindow]);

  const onAction = useCallback(
    (action: ScrubAction, hintT?: SimTime): void => {
      if (action.kind === 'live') returnToNow();
      else void controller.act(action, hintT);
    },
    [controller, returnToNow],
  );

  // stable, so the memoised lane rows re-render only when their rows or window change (never on a plain batch)
  const openRef = useRef(openLane);
  openRef.current = openLane;
  const toggleLane = useCallback((lane: LaneId): void => {
    const next = openRef.current === lane ? null : lane;
    setOpenLane(next);
    setMarks(next === null ? null : { lane: next, marks: null });
  }, []);

  const { rows, hiddenLanes } = useMemo(() => {
    if (answer === null) return { rows: [] as LaneRow[], hiddenLanes: 0 };
    const all = laneRows(answer, storeLanes);
    const shown = showQuiet ? all : all.filter((r) => r.total > 0);
    return { rows: shown, hiddenLanes: all.length - shown.length };
  }, [answer, storeLanes, showQuiet]);

  const deviceName = useMemo(() => deviceNamesOf(devices), [devices]);

  const note = !ready || head === null ? TIMELINE_WAITING_TEXT : off;
  const past = isReviewing(review);
  const everPast = useRef(false);
  if (past) everPast.current = true;
  const reviewing = past || previewT !== null;

  return (
    <TimelineStripView
      headT={headT}
      review={review}
      previewT={previewT}
      seeking={seeking}
      window={win}
      widthPx={width}
      note={note}
      rows={rows}
      hiddenLanes={hiddenLanes}
      lanesLoading={answer === null}
      lanesOpen={lanesOpen}
      showQuiet={showQuiet}
      openLane={openLane}
      marks={marks}
      deviceName={deviceName}
      ids={ids}
      announcement={reviewAnnouncement(past, everPast.current)}
      trackRef={trackRef}
      on={{
        action: onAction,
        returnToNow,
        zoom: (factor) => applyWindow(zoomWindow(winRef.current, factor, previewT ?? (reviewT ?? headT), headRef.current)),
        wholeRun: () => applyWindow(liveWindow(headRef.current, Math.max(headRef.current, TIMELINE_MIN_SPAN_NS))),
        toggleLanes: () => setLanesOpen((v) => !v),
        toggleQuiet: () => setShowQuiet((v) => !v),
        toggleLane,
        closeMarks: () => {
          setOpenLane(null);
          setMarks(null);
        },
        keyDown: (e) => {
          handleStripKey(e, { reviewing, returnToNow });
        },
      }}
    />
  );
}
