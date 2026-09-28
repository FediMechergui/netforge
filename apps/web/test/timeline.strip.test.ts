// The timeline strip [SHOULD S1] (ARCHITECTURE-P2 §2.14, §3.13, §6; W6 web-timeline): the seek controller over a
// mocked worker client (one seek in flight, the latest request wins, "return to now" cancels what is still waiting,
// a replay fault turns history off), the position slider driven by pointer and keys, the lane rows and their event
// lists, the review look against the live one, and the disabled states. No DOM: the slider and the rows are hook-free
// components called as functions (their handlers read straight off the element tree) or server-rendered, and the
// container is rendered on the server over a plain mocked store (effects never run there, so rendering never calls
// the engine).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { formatSimTime } from '@netforge/engine';
import type { LaneBucket, SeekTarget, TraceEvent } from '@netforge/engine';

const api = vi.hoisted(() => ({
  seek: vi.fn(),
  leaveReview: vi.fn(),
  timelineBuckets: vi.fn(),
  timelineMarks: vi.fn(),
}));
vi.mock('../src/bridge/client', () => ({ engine: api }));
// A plain selector store: server rendering reads the current state; setState takes a patch or an updater.
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = {};
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown> | ((s: Record<string, unknown>) => Record<string, unknown>)) =>
      Object.assign(state, typeof patch === 'function' ? patch(state) : patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

import { useStore } from '../src/store/store';
import type { ReviewInfo } from '../src/bridge/protocol';
import { LaneMarks, LaneRows, LaneRowsView, cellLabel, marksShortfall, type LaneRowsProps } from '../src/timeline/LaneRows';
import { Scrubber, effectiveReview, scrubberValueText, type ScrubberProps } from '../src/timeline/Scrubber';
import {
  HISTORY_OFF_TEXT,
  REVIEW_ENDED_TEXT,
  REVIEW_STARTED_TEXT,
  TIMELINE_UNAVAILABLE_TEXT,
  TIMELINE_WAITING_TEXT,
  TimelineStrip,
  TimelineStripView,
  createTimelineController,
  handleStripKey,
  historyOffReason,
  isQuietSeekFailure,
  lanesFilter,
  requestLaneBuckets,
  reviewAnnouncement,
  windowShowing,
  writeTimelineSeeking,
  type TimelineControllerHooks,
  type TimelineEngine,
  type TimelineStripViewProps,
} from '../src/timeline/TimelineStrip';
import {
  TIMELINE_MARKS_LIMIT,
  TIMELINE_RETURN_LABEL,
  TIMELINE_REVIEW_TITLE,
  laneRows,
  type TimelineMark,
  type TimelineWindow,
} from '../src/timeline/timeline-client';
import { LANE_ORDER } from '../src/vocab/lanes';

const SEC = 1_000_000_000;

const store = useStore as unknown as { getState(): Record<string, unknown>; setState(p: Record<string, unknown>): void };

// ── helpers ─────────────────────────────────────────────────────────────────

type El = { type: unknown; props: Record<string, unknown> };

/** Every element of a tree of host elements (function components are not expanded). */
function elements(node: unknown): El[] {
  const out: El[] = [];
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    if (n === null || typeof n !== 'object' || !('props' in n)) return;
    const el = n as El;
    out.push(el);
    visit(el.props.children);
  };
  visit(node);
  return out;
}

function find(node: unknown, pred: (el: El) => boolean): El {
  const el = elements(node).find(pred);
  if (el === undefined) throw new Error('no such element');
  return el;
}

const byRole = (role: string) => (el: El) => el.props.role === role;
const byLabelStart = (text: string) => (el: El) => typeof el.props['aria-label'] === 'string' && (el.props['aria-label'] as string).startsWith(text);
function flatText(n: unknown): string {
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(flatText).join('');
  if (n !== null && typeof n === 'object' && 'props' in n) return flatText((n as El).props.children);
  return '';
}
const byText = (text: string) => (el: El) => el.type === 'button' && flatText(el.props.children).includes(text);

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

/** Let every pending promise callback run. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A rejection as it crosses the worker boundary (bridge/errors.ts keeps the name). */
const engineError = (name: string, message = name): Error => Object.assign(new Error(message), { name });

const review = (t: number, liveNow: number): ReviewInfo => ({
  at: { dispatched: 10, now: t },
  t,
  live: { dispatched: 100, now: liveNow },
  atLive: false,
});

const seekReply = (t: number) => ({ snapshot: {} as never, review: review(t, 60 * SEC), replayedEvents: 42 });

function hooks(reviewing = false): TimelineControllerHooks & Record<keyof TimelineControllerHooks, ReturnType<typeof vi.fn>> {
  return {
    setSeeking: vi.fn(),
    setPreview: vi.fn(),
    historyOff: vi.fn(),
    report: vi.fn(),
    isReviewing: vi.fn(() => reviewing),
  };
}

function fakeEngine(): TimelineEngine & Record<'seek' | 'leaveReview' | 'timelineBuckets' | 'timelineMarks', ReturnType<typeof vi.fn>> {
  return {
    seek: vi.fn(async (target: SeekTarget) => seekReply('time' in target ? target.time : 0)),
    leaveReview: vi.fn(async () => ({}) as never),
    timelineBuckets: vi.fn(async () => [] as LaneBucket[]),
    timelineMarks: vi.fn(async () => []),
  };
}

const WINDOW: TimelineWindow = { from: 0, to: 60 * SEC };

/** A pointer event on a 400 px track whose left edge is at client x 100. */
function pointer(x: number, captured = true) {
  const currentTarget = {
    getBoundingClientRect: () => ({ left: 100, width: 400, top: 0, height: 30, right: 500, bottom: 30 }),
    setPointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => captured),
    releasePointerCapture: vi.fn(),
    focus: vi.fn(),
  };
  return { button: 0, clientX: 100 + x, pointerId: 7, currentTarget, preventDefault: vi.fn() };
}

const key = (k: string, shiftKey = false) => ({ key: k, shiftKey, altKey: false, ctrlKey: false, metaKey: false, preventDefault: vi.fn() });

function scrubberProps(patch: Partial<ScrubberProps> = {}): ScrubberProps {
  return { window: WINDOW, headT: 60 * SEC, review: null, previewT: null, widthPx: 400, disabled: false, onAction: vi.fn(), ...patch };
}

const slider = (props: ScrubberProps): El => find(Scrubber(props), byRole('slider'));

beforeEach(() => {
  vi.clearAllMocks();
});

// ── the seek controller ─────────────────────────────────────────────────────

describe('the seek controller', () => {
  it('turns a seek action into one engine.seek, marking the strip busy until it lands', async () => {
    const eng = fakeEngine();
    const h = hooks();
    const c = createTimelineController(eng, h);
    await c.act({ kind: 'seek', target: { time: 10 * SEC } });
    expect(eng.seek).toHaveBeenCalledTimes(1);
    expect(eng.seek).toHaveBeenCalledWith({ time: 10 * SEC });
    expect(h.setSeeking.mock.calls).toEqual([[true], [false]]);
    // the handle shows the asked-for instant at once, then the store's review takes over
    expect(h.setPreview.mock.calls).toEqual([[10 * SEC], [null]]);
    expect(h.report).not.toHaveBeenCalled();
  });

  it('keeps one seek in flight while dragging: the waiting request is replaced by the newest one', async () => {
    const eng = fakeEngine();
    const first = deferred<ReturnType<typeof seekReply>>();
    eng.seek.mockImplementationOnce(() => first.promise);
    const c = createTimelineController(eng, hooks());
    const a = c.act({ kind: 'seek', target: { time: 30 * SEC } });
    const b = c.act({ kind: 'seek', target: { time: 20 * SEC } });
    const d = c.act({ kind: 'seek', target: { time: 12 * SEC } });
    await flush();
    expect(eng.seek).toHaveBeenCalledTimes(1);
    first.resolve(seekReply(30 * SEC));
    await Promise.all([a, b, d]);
    expect(eng.seek.mock.calls.map((call) => call[0])).toEqual([{ time: 30 * SEC }, { time: 12 * SEC }]);
  });

  it('shows a cursor target at the time it was hinted (a lane bar or a listed event)', async () => {
    const eng = fakeEngine();
    const h = hooks();
    await createTimelineController(eng, h).act({ kind: 'seek', target: { cursor: 55 } }, 4 * SEC);
    expect(eng.seek).toHaveBeenCalledWith({ cursor: 55 });
    expect(h.setPreview.mock.calls[0]).toEqual([4 * SEC]);
  });

  it('returns to now through leaveReview, and does nothing when the present is already shown', async () => {
    const eng = fakeEngine();
    await createTimelineController(eng, hooks(true)).act({ kind: 'live' });
    expect(eng.leaveReview).toHaveBeenCalledTimes(1);
    await createTimelineController(eng, hooks(false)).returnToNow();
    expect(eng.leaveReview).toHaveBeenCalledTimes(1);
    await createTimelineController(eng, hooks(false)).act({ kind: 'none' });
    expect(eng.seek).not.toHaveBeenCalled();
  });

  it('cancels a seek still waiting when the learner returns to now (a drag ending at now never re-enters the past)', async () => {
    const eng = fakeEngine();
    const first = deferred<ReturnType<typeof seekReply>>();
    eng.seek.mockImplementationOnce(() => first.promise);
    const h = hooks(false);
    const c = createTimelineController(eng, h);
    const a = c.act({ kind: 'seek', target: { time: 30 * SEC } });
    const b = c.act({ kind: 'seek', target: { time: 25 * SEC } });
    const back = c.returnToNow();
    // the worker supersedes the seek in flight when leaveReview reaches it
    first.reject(engineError('SeekSupersededError', 'This seek was replaced by a newer one.'));
    await Promise.all([a, b, back]);
    expect(eng.leaveReview).toHaveBeenCalledTimes(1);
    expect(eng.seek).toHaveBeenCalledTimes(1);
    expect(h.report).not.toHaveBeenCalled();
    expect(h.setSeeking).toHaveBeenLastCalledWith(false);
    expect(h.setPreview).toHaveBeenLastCalledWith(null);
    // later seeks run again
    await c.act({ kind: 'seek', target: { time: 5 * SEC } });
    expect(eng.seek).toHaveBeenLastCalledWith({ time: 5 * SEC });
  });

  it('turns history off on a replay fault and refuses every later seek until a new world', async () => {
    for (const name of ['ReplayDivergenceError', 'ReplayExhaustedError']) {
      const eng = fakeEngine();
      eng.seek.mockRejectedValueOnce(engineError(name, 'Replay diverged at journal entry 3.'));
      const h = hooks();
      const c = createTimelineController(eng, h);
      await c.act({ kind: 'seek', target: { time: 10 * SEC } });
      expect(h.historyOff).toHaveBeenCalledWith(HISTORY_OFF_TEXT);
      expect(h.report).not.toHaveBeenCalled();
      expect(c.disabledReason).toBe(HISTORY_OFF_TEXT);
      await c.act({ kind: 'seek', target: { time: 20 * SEC } });
      expect(eng.seek).toHaveBeenCalledTimes(1);
      // the way back stays open while history is off
      await c.act({ kind: 'live' });
      c.reset();
      expect(c.disabledReason).toBeNull();
      await c.act({ kind: 'seek', target: { time: 20 * SEC } });
      expect(eng.seek).toHaveBeenCalledTimes(2);
    }
  });

  it('reports any other failure and stays usable; superseded seeks are quiet', async () => {
    const eng = fakeEngine();
    eng.seek.mockRejectedValueOnce(new Error('The engine has not been initialised yet (call init first).'));
    eng.seek.mockRejectedValueOnce(engineError('SeekSupersededError'));
    const h = hooks();
    const c = createTimelineController(eng, h);
    await c.act({ kind: 'seek', target: { time: 10 * SEC } });
    expect(h.report).toHaveBeenCalledWith('The engine has not been initialised yet (call init first).');
    await c.act({ kind: 'seek', target: { time: 11 * SEC } });
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(h.historyOff).not.toHaveBeenCalled();
    expect(c.disabledReason).toBeNull();
  });

  it('says so when the engine has no time machine', async () => {
    const h = hooks();
    const c = createTimelineController({}, h);
    await c.act({ kind: 'seek', target: { time: 10 * SEC } });
    expect(h.historyOff).toHaveBeenCalledWith(TIMELINE_UNAVAILABLE_TEXT);
    expect(await c.buckets({ from: 0, to: SEC, buckets: 10 }, 1)).toBeUndefined();
    expect(await c.marks({ lane: 'stp', from: 0, to: SEC, limit: 5 })).toEqual([]);
  });

  it('asks for buckets only when the query or the head moved, one query at a time', async () => {
    const eng = fakeEngine();
    const bucket: LaneBucket = { from: 0, to: SEC, counts: { stp: 2 }, firstCursor: { stp: 4 } };
    eng.timelineBuckets.mockResolvedValue([bucket]);
    const c = createTimelineController(eng, hooks());
    const q = { from: 0, to: SEC, buckets: 10 };
    expect(await c.buckets(q, 5)).toEqual([bucket]);
    expect(await c.buckets(q, 5)).toBeUndefined();
    const slow = deferred<LaneBucket[]>();
    eng.timelineBuckets.mockImplementationOnce(() => slow.promise);
    const inFlight = c.buckets(q, 6);
    expect(await c.buckets({ ...q, to: 2 * SEC }, 6)).toBeUndefined();
    slow.resolve([]);
    expect(await inFlight).toEqual([]);
    expect(eng.timelineBuckets).toHaveBeenCalledTimes(2);
    c.reset();
    await c.buckets(q, 6);
    expect(eng.timelineBuckets).toHaveBeenCalledTimes(3);
  });

  it('re-asks for the lanes when only the lane index grew (paused: same sim time, same dispatched count; finding #9)', async () => {
    const eng = fakeEngine();
    eng.timelineBuckets.mockResolvedValue([]);
    const c = createTimelineController(eng, hooks());
    const win = { from: 0, to: 60 * SEC };
    const head = { t: 60 * SEC, at: { dispatched: 500, now: 60 * SEC }, lanesRevision: 41 };
    expect(await requestLaneBuckets(c, head, win, 400, undefined)).toEqual([]);
    expect(await requestLaneBuckets(c, head, win, 400, undefined)).toBeUndefined();
    // a configuration change while paused: nothing dispatched, the clock still, one more event in the Config lane
    expect(await requestLaneBuckets(c, { ...head, lanesRevision: 42 }, win, 400, undefined)).toEqual([]);
    expect(eng.timelineBuckets).toHaveBeenCalledTimes(2);
    expect(eng.timelineBuckets).toHaveBeenLastCalledWith({ from: 0, to: 60 * SEC, buckets: expect.any(Number) });
  });

  it('classifies rejections by the name that crosses the worker boundary', () => {
    expect(historyOffReason(engineError('ReplayDivergenceError'))).toBe(HISTORY_OFF_TEXT);
    expect(historyOffReason(new Error('x'))).toBeNull();
    expect(historyOffReason('ReplayDivergenceError')).toBeNull();
    expect(isQuietSeekFailure(engineError('SeekSupersededError'))).toBe(true);
    expect(isQuietSeekFailure(new RangeError('bad'))).toBe(false);
  });
});

// ── the slider ──────────────────────────────────────────────────────────────

describe('the position slider', () => {
  it('seeks to the instant under the pointer, and keeps seeking while dragged', () => {
    const props = scrubberProps();
    const s = slider(props);
    const down = pointer(100);
    (s.props.onPointerDown as (e: unknown) => void)(down);
    expect(down.currentTarget.setPointerCapture).toHaveBeenCalledWith(7);
    expect(props.onAction).toHaveBeenLastCalledWith({ kind: 'seek', target: { time: 15 * SEC } });
    (s.props.onPointerMove as (e: unknown) => void)(pointer(50));
    expect(props.onAction).toHaveBeenLastCalledWith({ kind: 'seek', target: { time: 7.5 * SEC } });
    // a pointer merely passing over the track (no button held, no capture) seeks nothing
    (s.props.onPointerMove as (e: unknown) => void)(pointer(20, false));
    expect(props.onAction).toHaveBeenCalledTimes(2);
  });

  it('a drag through the controller sends one seek per completed seek, the last position winning', async () => {
    const eng = fakeEngine();
    const first = deferred<ReturnType<typeof seekReply>>();
    eng.seek.mockImplementationOnce(() => first.promise);
    const c = createTimelineController(eng, hooks());
    const pending: Promise<void>[] = [];
    const s = slider(scrubberProps({ onAction: (a) => void pending.push(c.act(a)) }));
    (s.props.onPointerDown as (e: unknown) => void)(pointer(200));
    for (const x of [180, 160, 140, 120]) (s.props.onPointerMove as (e: unknown) => void)(pointer(x));
    first.resolve(seekReply(30 * SEC));
    await Promise.all(pending);
    expect(eng.seek.mock.calls.map((call) => call[0])).toEqual([{ time: 30 * SEC }, { time: 18 * SEC }]);
  });

  it('dragging to the live edge while reviewing returns to now', () => {
    const props = scrubberProps({ review: review(20 * SEC, 60 * SEC) });
    (slider(props).props.onPointerDown as (e: unknown) => void)(pointer(400));
    expect(props.onAction).toHaveBeenCalledWith({ kind: 'live' });
  });

  it('steps with the arrows, jumps with Home and End', () => {
    const live = scrubberProps();
    const onKey = slider(live).props.onKeyDown as (e: unknown) => void;
    const left = key('ArrowLeft');
    onKey(left);
    expect(left.preventDefault).toHaveBeenCalled();
    expect(live.onAction).toHaveBeenLastCalledWith({ kind: 'seek', target: { time: 58_800_000_000 } });
    onKey(key('ArrowLeft', true));
    expect(live.onAction).toHaveBeenLastCalledWith({ kind: 'seek', target: { time: 54 * SEC } });
    onKey(key('Home'));
    expect(live.onAction).toHaveBeenLastCalledWith({ kind: 'seek', target: { time: 0 } });
    onKey(key('End'));
    expect(live.onAction).toHaveBeenLastCalledWith({ kind: 'none' });

    const past = scrubberProps({ review: review(20 * SEC, 60 * SEC) });
    const onPastKey = slider(past).props.onKeyDown as (e: unknown) => void;
    onPastKey(key('ArrowRight'));
    expect(past.onAction).toHaveBeenLastCalledWith({ kind: 'seek', target: { time: 21_200_000_000 } });
    onPastKey(key('End'));
    expect(past.onAction).toHaveBeenLastCalledWith({ kind: 'live' });

    // a key that is not the slider's is left alone
    const other = key('a');
    onKey(other);
    expect(other.preventDefault).not.toHaveBeenCalled();
  });

  it('moves on from the handle while a seek is still in flight (held keys never repeat one target)', () => {
    const props = scrubberProps({ previewT: 30 * SEC });
    (slider(props).props.onKeyDown as (e: unknown) => void)(key('ArrowLeft'));
    expect(props.onAction).toHaveBeenLastCalledWith({ kind: 'seek', target: { time: 28_800_000_000 } });
    expect(effectiveReview(null, 30 * SEC, 60 * SEC)?.t).toBe(30 * SEC);
    expect(effectiveReview(null, null, 60 * SEC)).toBeNull();
  });

  it('does nothing while disabled, and says so to assistive technology', () => {
    const props = scrubberProps({ disabled: true, describedBy: 'why' });
    const s = slider(props);
    (s.props.onPointerDown as (e: unknown) => void)(pointer(100));
    (s.props.onKeyDown as (e: unknown) => void)(key('Home'));
    expect(props.onAction).not.toHaveBeenCalled();
    const html = renderToStaticMarkup(createElement(Scrubber, props));
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('aria-describedby="why"');
  });

  it('reads its value in words: live, or how far behind now', () => {
    const live = renderToStaticMarkup(createElement(Scrubber, scrubberProps()));
    expect(live).toContain('role="slider"');
    expect(live).toContain(`aria-valuetext="${formatSimTime(60 * SEC)}, now (live)"`);
    expect(live).toContain('aria-valuenow="60000"');
    const past = renderToStaticMarkup(createElement(Scrubber, scrubberProps({ review: review(15 * SEC, 60 * SEC) })));
    expect(past).toContain(`aria-valuetext="${formatSimTime(15 * SEC)}, 45 s before now"`);
    expect(past).toContain('tl-handle is-past');
    expect(past).toContain('tl-ahead');
    expect(scrubberValueText(10 * SEC, 12.5 * SEC, true)).toBe(`${formatSimTime(10 * SEC)}, 2.5 s before now`);
  });
});

// ── lanes ───────────────────────────────────────────────────────────────────

const BUCKETS: LaneBucket[] = [
  { from: 0, to: 10 * SEC, counts: { stp: 3 }, firstCursor: { stp: 11 } },
  { from: 10 * SEC, to: 20 * SEC, counts: { link: 2 }, firstCursor: { link: 20 } },
  { from: 20 * SEC, to: 30 * SEC, counts: { stp: 1 }, firstCursor: { stp: 40 } },
  { from: 30 * SEC, to: 40 * SEC, counts: {}, firstCursor: {} },
];
const W40: TimelineWindow = { from: 0, to: 40 * SEC };

function rowsProps(patch: Partial<LaneRowsProps> = {}): LaneRowsProps {
  return {
    rows: laneRows(BUCKETS, undefined, { hideEmpty: true }),
    window: W40,
    widthPx: 400,
    disabled: false,
    openLane: null,
    marksId: 'marks',
    onAction: vi.fn(),
    onToggleLane: vi.fn(),
    ...patch,
  };
}

describe('the lane rows', () => {
  it('draws each active lane with its glyph, label and count, and one height-coded bar per busy bucket', () => {
    const html = renderToStaticMarkup(createElement(LaneRows, rowsProps()));
    const t = text(html);
    expect(t).toContain('ST Spanning tree 4 events in view');
    expect(t).toContain('L Links and ports 2 events in view');
    expect(t).not.toContain('Drops');
    expect(html).toContain(`aria-label="Spanning tree: 3 events between ${formatSimTime(0)} and ${formatSimTime(10 * SEC)}"`);
    expect(html).toContain('tl-cell l4');
    expect(html).toContain('tl-cell l2');
    // bars stay out of the tab order; the lane's name is the keyboard path
    expect(html.match(/tabindex="-1"/g)?.length).toBe(3);
    // a 100 px bar is wide enough to carry the lane glyph as well
    expect(html).toMatch(/tl-cell l4[^>]*>ST</);
  });

  it('a bar seeks to its first event by ring cursor; the lane name opens its list', () => {
    const props = rowsProps();
    const tree = LaneRowsView(props);
    (find(tree, byLabelStart('Spanning tree: 1 event')).props.onClick as () => void)();
    expect(props.onAction).toHaveBeenCalledWith({ kind: 'seek', target: { cursor: 40 } }, 20 * SEC);
    const name = find(tree, (el) => el.type === 'button' && el.props['aria-expanded'] === false && flatText(el.props.children).includes('Links and ports'));
    (name.props.onClick as () => void)();
    expect(props.onToggleLane).toHaveBeenCalledWith('link');
  });

  it('leaves out bars outside the window, disables them while seeking is off, and says when nothing happened', () => {
    const html = renderToStaticMarkup(createElement(LaneRows, rowsProps({ window: { from: 20 * SEC, to: 40 * SEC } })));
    expect(html).not.toContain('Spanning tree: 3 events');
    expect(html).toContain('Spanning tree: 1 event between');
    const off = renderToStaticMarkup(createElement(LaneRows, rowsProps({ disabled: true })));
    expect(off.match(/disabled=""/g)?.length).toBe(3);
    expect(text(renderToStaticMarkup(createElement(LaneRows, rowsProps({ rows: [] }))))).toContain('Nothing happened in this stretch of time.');
    expect(text(renderToStaticMarkup(createElement(LaneRows, rowsProps({ rows: [], loading: true }))))).toContain('Reading the lanes');
    expect(cellLabel({ label: 'Drops' }, { count: 1, from: 0, to: SEC })).toBe(`Drops: 1 event between ${formatSimTime(0)} and ${formatSimTime(SEC)}`);
  });
});

describe('a lane event list', () => {
  const fsm: TraceEvent = {
    t: 30 * SEC,
    kind: 'debug',
    event: {
      at: 30 * SEC,
      device: 'd1',
      process: 'stp',
      category: 'spanning-tree',
      message: 'Gi0/1 learning -> forwarding',
      fsm: { machine: 'stp-port', subject: 'Gi0/1 VLAN 1', from: 'learning', to: 'forwarding', cause: 'forward delay expired' },
    },
  } as TraceEvent;
  const write: TraceEvent = { t: 31 * SEC, kind: 'tableWrite', device: 'd1', table: 'stp', key: '1|Gi0/1' } as TraceEvent;
  const MARKS: TimelineMark[] = [
    { cursor: 100, t: 30 * SEC, lane: 'stp', event: fsm },
    { cursor: 101, t: 31 * SEC, lane: 'stp', event: write },
  ];
  const stpRow = laneRows(BUCKETS)[1]!;

  const render = (patch: Partial<Parameters<typeof LaneMarks>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(LaneMarks, {
        id: 'm',
        state: { lane: 'stp', marks: MARKS },
        row: { ...stpRow, total: 2 },
        disabled: false,
        deviceName: (id: string) => (id === 'd1' ? 'SW1' : id),
        onAction: vi.fn(),
        onClose: vi.fn(),
        ...patch,
      }),
    );

  it('lists each event in words with its time, each a button that seeks to it', () => {
    const t = text(render());
    expect(t).toContain('Spanning tree: events in view');
    expect(t).toContain(`${formatSimTime(30 * SEC)} `);
    expect(t).toContain('Gi0/1 VLAN 1: learning → forwarding (forward delay expired)');
    expect(t).toContain('SW1:');
    expect(t).not.toContain('older than the kept detail');
    const onAction = vi.fn();
    const tree = LaneMarks({ id: 'm', state: { lane: 'stp', marks: MARKS }, row: stpRow, disabled: false, onAction, onClose: vi.fn() });
    (find(tree, (el) => el.type === 'button' && el.props.className === 'tl-mark').props.onClick as () => void)();
    expect(onAction).toHaveBeenCalledWith({ kind: 'seek', target: { cursor: 100 } }, 30 * SEC);
  });

  it('says when the kept detail is shorter than the count (the time-travel budget), and when it is loading or failed', () => {
    expect(text(render({ row: { ...stpRow, total: 5 } }))).toContain('3 events more are older than the kept detail');
    expect(text(render({ state: { lane: 'stp', marks: [] }, row: { ...stpRow, total: 3 } }))).toContain('3 events in view are older than the kept detail');
    expect(text(render({ state: { lane: 'stp', marks: [] }, row: undefined }))).toContain('No spanning tree events in this stretch of time.');
    expect(text(render({ state: { lane: 'stp', marks: null } }))).toContain('Reading the events');
    expect(text(render({ state: { lane: 'stp', marks: [], error: 'boom' } }))).toContain('The events could not be read: boom');
    expect(marksShortfall(900, TIMELINE_MARKS_LIMIT)).toContain('zoom in');
    expect(marksShortfall(2, 2)).toBeNull();
  });
});

// ── the strip ───────────────────────────────────────────────────────────────

function viewProps(patch: Partial<TimelineStripViewProps> = {}): TimelineStripViewProps {
  return {
    headT: 60 * SEC,
    review: null,
    previewT: null,
    seeking: false,
    window: WINDOW,
    widthPx: 400,
    note: null,
    rows: laneRows(BUCKETS, undefined, { hideEmpty: true }),
    hiddenLanes: LANE_ORDER.length - 2,
    lanesLoading: false,
    lanesOpen: true,
    showQuiet: false,
    openLane: null,
    marks: null,
    ids: { note: 'n', hint: 'h', lanes: 'l', marks: 'm' },
    announcement: '',
    on: {
      action: vi.fn(),
      returnToNow: vi.fn(),
      zoom: vi.fn(),
      wholeRun: vi.fn(),
      toggleLanes: vi.fn(),
      toggleQuiet: vi.fn(),
      toggleLane: vi.fn(),
      closeMarks: vi.fn(),
      keyDown: vi.fn(),
    },
    ...patch,
  };
}

describe('the strip: live against review', () => {
  it('live: a Live badge, the head time, no banner, the slider usable and the lanes drawn', () => {
    const html = renderToStaticMarkup(createElement(TimelineStripView, viewProps()));
    const t = text(html);
    expect(t).toContain('Live');
    expect(t).toContain(`Now ${formatSimTime(60 * SEC)}`);
    expect(t).not.toContain(TIMELINE_REVIEW_TITLE);
    expect(t).not.toContain(TIMELINE_RETURN_LABEL);
    expect(html).toContain('data-review="false"');
    expect(html).not.toContain('aria-disabled');
    expect(html).toContain('aria-describedby="h"');
    expect(t).toContain('Spanning tree');
    expect(t).toContain(`Show ${LANE_ORDER.length - 2} quiet lanes`);
  });

  it('review: a Past badge and the banner with the instant, how far back, and the one way back to now', () => {
    const p = viewProps({ review: review(30 * SEC, 60 * SEC), announcement: REVIEW_STARTED_TEXT });
    const html = renderToStaticMarkup(createElement(TimelineStripView, p));
    const t = text(html);
    expect(t).toContain('Past');
    expect(t).toContain(TIMELINE_REVIEW_TITLE);
    expect(t).toContain(formatSimTime(30 * SEC));
    expect(t).toContain('30 s before now');
    expect(t).toContain(TIMELINE_RETURN_LABEL);
    expect(t).toContain('or press Escape');
    expect(t).toContain(REVIEW_STARTED_TEXT);
    expect(html).toContain('data-review="true"');
    expect(html).toContain('tl-badge is-past');
    const back = find(TimelineStripView(p), byText(TIMELINE_RETURN_LABEL));
    (back.props.onClick as () => void)();
    expect(p.on.returnToNow).toHaveBeenCalledTimes(1);
  });

  it('a review that reached the live position is the present again', () => {
    const t = text(renderToStaticMarkup(createElement(TimelineStripView, viewProps({ review: { ...review(60 * SEC, 60 * SEC), atLive: true } }))));
    expect(t).not.toContain(TIMELINE_REVIEW_TITLE);
    expect(t).toContain('Live');
  });

  it('shows the replaying state while a seek runs', () => {
    expect(text(renderToStaticMarkup(createElement(TimelineStripView, viewProps({ seeking: true }))))).toContain('Replaying');
  });

  it('history off: the strip says why and the slider is disabled', () => {
    const html = renderToStaticMarkup(createElement(TimelineStripView, viewProps({ note: HISTORY_OFF_TEXT })));
    expect(text(html)).toContain(HISTORY_OFF_TEXT);
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('aria-describedby="n"');
    expect(html.match(/tl-cell [^"]*" [^>]*disabled=""/g)?.length).toBe(3);
  });

  it('the header buttons zoom, show the whole run and hide the lanes', () => {
    const p = viewProps();
    const tree = TimelineStripView(p);
    (find(tree, byLabelStart('Zoom in')).props.onClick as () => void)();
    expect(p.on.zoom).toHaveBeenCalledWith(0.5);
    (find(tree, byLabelStart('Zoom out')).props.onClick as () => void)();
    expect(p.on.zoom).toHaveBeenLastCalledWith(2);
    (find(tree, byText('Whole run')).props.onClick as () => void)();
    expect(p.on.wholeRun).toHaveBeenCalled();
    (find(tree, byText('Hide lanes')).props.onClick as () => void)();
    expect(p.on.toggleLanes).toHaveBeenCalled();
    const closed = text(renderToStaticMarkup(createElement(TimelineStripView, viewProps({ lanesOpen: false }))));
    expect(closed).toContain('Show lanes');
    expect(closed).not.toContain('Spanning tree');
  });
});

describe('Escape in the strip', () => {
  it('returns to now while the past is shown, and keeps the key from the global hotkeys', () => {
    const e = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() };
    const back = vi.fn();
    expect(handleStripKey(e, { reviewing: true, returnToNow: back })).toBe(true);
    expect(back).toHaveBeenCalledTimes(1);
    expect(e.stopPropagation).toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('leaves Escape (and every other key) alone in the present', () => {
    const e = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() };
    const back = vi.fn();
    expect(handleStripKey(e, { reviewing: false, returnToNow: back })).toBe(false);
    expect(handleStripKey({ ...e, key: 'ArrowLeft' }, { reviewing: true, returnToNow: back })).toBe(false);
    expect(back).not.toHaveBeenCalled();
    expect(e.stopPropagation).not.toHaveBeenCalled();
  });
});

describe('the strip container over the store', () => {
  const timeline = (patch: Record<string, unknown> = {}) => ({
    review: null,
    head: { t: 60 * SEC, at: { dispatched: 500, now: 60 * SEC } },
    lanes: [...LANE_ORDER],
    seeking: false,
    reviewEvents: [],
    ...patch,
  });

  beforeEach(() => {
    const s = store.getState();
    for (const k of Object.keys(s)) delete s[k];
    store.setState({ ready: true, epoch: 3, snapshot: null, timeline: timeline(), toast: vi.fn() });
  });

  it('renders the live strip without calling the engine', () => {
    const html = renderToStaticMarkup(createElement(TimelineStrip));
    expect(text(html)).toContain(`Now ${formatSimTime(60 * SEC)}`);
    expect(html).toContain('role="slider"');
    expect(html).not.toContain('aria-disabled');
    expect(text(html)).toContain('Reading the lanes');
    for (const fn of Object.values(api)) expect(fn).not.toHaveBeenCalled();
  });

  it('mirrors the store review: banner and Past badge', () => {
    store.setState({ timeline: timeline({ review: review(45 * SEC, 60 * SEC), seeking: true }) });
    const t = text(renderToStaticMarkup(createElement(TimelineStrip)));
    expect(t).toContain(TIMELINE_REVIEW_TITLE);
    expect(t).toContain('15 s before now');
    expect(t).toContain('Replaying');
  });

  it('is disabled until the simulation has a timeline', () => {
    store.setState({ timeline: timeline({ head: null }) });
    const html = renderToStaticMarkup(createElement(TimelineStrip));
    expect(text(html)).toContain(TIMELINE_WAITING_TEXT);
    expect(html).toContain('aria-disabled="true"');
    store.setState({ ready: false, timeline: timeline() });
    expect(renderToStaticMarkup(createElement(TimelineStrip))).toContain('aria-disabled="true"');
  });

  it('writes the seeking flag into its own slice, leaving the rest of it as it was', () => {
    writeTimelineSeeking(true);
    const tl = store.getState().timeline as { seeking: boolean; lanes: string[]; head: unknown };
    expect(tl.seeking).toBe(true);
    expect(tl.lanes).toEqual([...LANE_ORDER]);
    expect(tl.head).toEqual({ t: 60 * SEC, at: { dispatched: 500, now: 60 * SEC } });
    const before = store.getState().timeline;
    writeTimelineSeeking(true);
    expect(store.getState().timeline).toBe(before);
  });
});

describe('small helpers', () => {
  it('asks the worker for every lane unless the strip shows fewer', () => {
    expect(lanesFilter(undefined)).toBeUndefined();
    expect(lanesFilter([...LANE_ORDER])).toBeUndefined();
    expect(lanesFilter(['stp', 'link'])).toEqual(['stp', 'link']);
  });

  it('pans the window to a reviewed instant outside it, and leaves it alone otherwise', () => {
    const w = { from: 60 * SEC, to: 120 * SEC };
    expect(windowShowing(w, 90 * SEC, 120 * SEC)).toBe(w);
    expect(windowShowing(w, 10 * SEC, 120 * SEC)).toEqual({ from: 0, to: 60 * SEC });
    expect(windowShowing(w, 30 * SEC, 120 * SEC)).toEqual({ from: 15 * SEC, to: 75 * SEC });
  });

  it('announces review starting and ending, and nothing before the first review', () => {
    expect(reviewAnnouncement(false, false)).toBe('');
    expect(reviewAnnouncement(true, true)).toBe(REVIEW_STARTED_TEXT);
    expect(reviewAnnouncement(false, true)).toBe(REVIEW_ENDED_TEXT);
  });

});

// keep the element helpers honest
describe('test helpers', () => {
  it('walk host elements only', () => {
    const tree = { type: 'div', props: { children: [{ type: 'b', props: { children: 'x' } }, 'y'] } } as unknown as ReactElement;
    expect(elements(tree).map((e) => e.type)).toEqual(['div', 'b']);
    expect(flatText(tree)).toBe('xy');
  });
});
