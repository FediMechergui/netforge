// The pure layer under the timeline strip [SHOULD S1] (ARCHITECTURE-P2 §2.13, §3.13, §6): window arithmetic, the
// queries the strip sends, lane rows, the scrub and key actions, the review banner, mark wording and seek coalescing.
import { describe, expect, it } from 'vitest';
import type { LaneBucket, TraceEvent } from '@netforge/engine';
import { REPLAY_READ_ONLY_MESSAGE } from '@netforge/engine';
import type { ReviewInfo } from '../src/bridge/protocol';
import {
  TIMELINE_DEFAULT_SPAN_NS,
  TIMELINE_MARK_LEVELS,
  TIMELINE_MAX_BUCKETS,
  TIMELINE_MIN_SPAN_NS,
  TIMELINE_RETURN_LABEL,
  TIMELINE_REVIEW_TITLE,
  advanceWindow,
  bucketCount,
  bucketQuery,
  bucketsKey,
  cellAction,
  createSeekQueue,
  cursorTime,
  isFollowing,
  isReadOnlyRejection,
  isReviewing,
  isTimelineKey,
  keyAction,
  laneRows,
  liveWindow,
  markAction,
  markLevel,
  markText,
  markTooltip,
  marksQuery,
  panWindow,
  reviewBanner,
  scrubAction,
  tickLabel,
  tickStep,
  timeToX,
  timelineTicks,
  windowSpan,
  xToTime,
  zoomWindow,
  type TimelineMark,
} from '../src/timeline/timeline-client.js';

const SEC = 1_000_000_000;
const MS = 1_000_000;

const review = (t: number, liveNow: number, atLive = false): ReviewInfo => ({
  at: { dispatched: 10, now: t },
  t,
  live: { dispatched: 100, now: liveNow },
  atLive,
});

describe('the window', () => {
  it('follows the live head and starts at the origin while the run is short', () => {
    expect(liveWindow(10 * SEC)).toEqual({ from: 0, to: TIMELINE_DEFAULT_SPAN_NS });
    expect(liveWindow(90 * SEC)).toEqual({ from: 30 * SEC, to: 90 * SEC });
    expect(liveWindow(90 * SEC, 30 * SEC)).toEqual({ from: 60 * SEC, to: 90 * SEC });
    expect(windowSpan(liveWindow(90 * SEC, 30 * SEC))).toBe(30 * SEC);
    expect(isFollowing(liveWindow(90 * SEC), 90 * SEC)).toBe(true);
  });

  it('slides a following window with the head and leaves a panned one alone', () => {
    const following = liveWindow(90 * SEC);
    expect(advanceWindow(following, 90 * SEC, 120 * SEC)).toEqual({ from: 60 * SEC, to: 120 * SEC });
    const panned = panWindow(following, -20 * SEC, 90 * SEC);
    expect(panned).toEqual({ from: 10 * SEC, to: 70 * SEC });
    expect(isFollowing(panned, 90 * SEC)).toBe(false);
    expect(advanceWindow(panned, 90 * SEC, 120 * SEC)).toEqual(panned);
  });

  it('keeps a pan and a zoom inside the run', () => {
    const w = liveWindow(120 * SEC);
    expect(panWindow(w, -1000 * SEC, 120 * SEC)).toEqual({ from: 0, to: 60 * SEC });
    expect(panWindow(w, 1000 * SEC, 120 * SEC)).toEqual({ from: 60 * SEC, to: 120 * SEC });
    const zoomed = zoomWindow(w, 0.5, 90 * SEC, 120 * SEC);
    expect(windowSpan(zoomed)).toBe(30 * SEC);
    expect(zoomed.from).toBeLessThanOrEqual(90 * SEC);
    expect(zoomed.to).toBeGreaterThanOrEqual(90 * SEC);
    expect(windowSpan(zoomWindow(w, 0.000001, 90 * SEC, 120 * SEC))).toBe(TIMELINE_MIN_SPAN_NS);
    expect(windowSpan(zoomWindow(w, 1000, 90 * SEC, 120 * SEC))).toBe(120 * SEC);
  });
});

describe('geometry', () => {
  const w = { from: 30 * SEC, to: 90 * SEC };

  it('maps time to pixels and back, clamped to the strip', () => {
    expect(timeToX(60 * SEC, w, 600)).toBe(300);
    expect(timeToX(0, w, 600)).toBe(0);
    expect(timeToX(1000 * SEC, w, 600)).toBe(600);
    expect(xToTime(300, w, 600)).toBe(60 * SEC);
    expect(xToTime(-40, w, 600)).toBe(30 * SEC);
    expect(xToTime(9999, w, 600)).toBe(90 * SEC);
    expect(Number.isInteger(xToTime(123.7, w, 600))).toBe(true);
    expect(timeToX(60 * SEC, { from: 0, to: 0 }, 600)).toBe(0);
    expect(xToTime(10, w, 0)).toBe(30 * SEC);
  });
});

describe('queries', () => {
  const w = { from: 30 * SEC, to: 90 * SEC };

  it('asks for about one bucket per six pixels, capped', () => {
    expect(bucketCount(600)).toBe(100);
    expect(bucketCount(3)).toBe(1);
    expect(bucketCount(100_000)).toBe(TIMELINE_MAX_BUCKETS);
    expect(bucketQuery(w, 600)).toEqual({ from: 30 * SEC, to: 90 * SEC, buckets: 100 });
    expect(bucketQuery(w, 600, ['stp', 'link'])).toEqual({ from: 30 * SEC, to: 90 * SEC, buckets: 100, lanes: ['stp', 'link'] });
    expect(marksQuery('stp', w)).toEqual({ lane: 'stp', from: 30 * SEC, to: 90 * SEC, limit: 200 });
    expect(marksQuery('stp', w, 10).limit).toBe(10);
  });

  it('re-queries only when the view or the lane index moved', () => {
    const q = bucketQuery(w, 600);
    expect(bucketsKey(q, 3)).toBe(bucketsKey(bucketQuery(w, 600), 3));
    expect(bucketsKey(q, 3)).not.toBe(bucketsKey(q, 4));
    expect(bucketsKey(q, 3)).not.toBe(bucketsKey(bucketQuery(panWindow(w, -5 * SEC, 90 * SEC), 600), 3));
    expect(bucketsKey(bucketQuery(w, 600, ['stp']), 3)).not.toBe(bucketsKey(q, 3));
  });
});

describe('lane rows', () => {
  const buckets: LaneBucket[] = [
    { from: 0, to: SEC, counts: { stp: 4, drops: 1 }, firstCursor: { stp: 10, drops: 11 } },
    { from: SEC, to: 2 * SEC, counts: {}, firstCursor: {} },
    { from: 2 * SEC, to: 3 * SEC, counts: { stp: 1 }, firstCursor: { stp: 30 } },
  ];

  it('keeps the vocabulary order and only non-empty cells', () => {
    const rows = laneRows(buckets);
    expect(rows.map((r) => r.lane).slice(0, 4)).toEqual(['link', 'stp', 'etherchannel', 'vlan']);
    const stp = rows.find((r) => r.lane === 'stp');
    expect(stp).toMatchObject({ label: 'Spanning tree', glyph: 'ST', total: 5, peak: 4 });
    expect(stp?.cells.map((c) => c.index)).toEqual([0, 2]);
    expect(stp?.cells[0]).toMatchObject({ count: 4, level: TIMELINE_MARK_LEVELS, firstCursor: 10, from: 0, to: SEC });
    expect(stp?.cells[1]?.level).toBe(1);
    expect(rows.find((r) => r.lane === 'link')?.cells).toEqual([]);
  });

  it('limits the lanes and can hide the empty ones', () => {
    expect(laneRows(buckets, ['drops', 'stp']).map((r) => r.lane)).toEqual(['stp', 'drops']);
    expect(laneRows(buckets, undefined, { hideEmpty: true }).map((r) => r.lane)).toEqual(['stp', 'drops']);
    expect(laneRows([]).every((r) => r.total === 0 && r.cells.length === 0)).toBe(true);
  });

  it('levels a bucket against its own lane peak', () => {
    expect(markLevel(0, 10)).toBe(0);
    expect(markLevel(1, 10)).toBe(1);
    expect(markLevel(10, 10)).toBe(TIMELINE_MARK_LEVELS);
    expect(markLevel(5, 10)).toBe(2);
    expect(markLevel(3, 0)).toBe(0);
  });
});

describe('cursor, scrubbing and keys', () => {
  const w = { from: 0, to: 60 * SEC };
  const head = 60 * SEC;

  it('knows when the canvas shows the past', () => {
    expect(isReviewing(null)).toBe(false);
    expect(isReviewing(undefined)).toBe(false);
    expect(isReviewing(review(30 * SEC, head))).toBe(true);
    expect(isReviewing(review(head, head, true))).toBe(false);
    expect(cursorTime(null, head)).toBe(head);
    expect(cursorTime(review(30 * SEC, head), head)).toBe(30 * SEC);
  });

  it('turns a drag into a seek, and a drag to the live edge into a return', () => {
    expect(scrubAction(300, w, 600, head, null)).toEqual({ kind: 'seek', target: { time: 30 * SEC } });
    expect(scrubAction(600, w, 600, head, null)).toEqual({ kind: 'none' });
    expect(scrubAction(600, w, 600, head, review(30 * SEC, head))).toEqual({ kind: 'live' });
    expect(scrubAction(300, w, 600, head, review(30 * SEC, head))).toEqual({ kind: 'none' });
  });

  it('seeks to a lane cell by its first cursor, and to a mark by its own', () => {
    expect(cellAction({ index: 0, from: 5 * SEC, to: 6 * SEC, count: 2, level: 2, firstCursor: 42 })).toEqual({ kind: 'seek', target: { cursor: 42 } });
    expect(cellAction({ index: 0, from: 5 * SEC, to: 6 * SEC, count: 2, level: 2 })).toEqual({ kind: 'seek', target: { time: 5 * SEC } });
    const mark: TimelineMark = { cursor: 7, t: SEC, lane: 'stp', event: { t: SEC, kind: 'linkState', link: 'l1', up: true } };
    expect(markAction(mark)).toEqual({ kind: 'seek', target: { cursor: 7 } });
  });

  it('steps with the keyboard and returns to now at the end', () => {
    const opts = { window: w, headT: head, review: review(30 * SEC, head) };
    expect(isTimelineKey('ArrowLeft')).toBe(true);
    expect(isTimelineKey('Enter')).toBe(false);
    expect(keyAction('ArrowLeft', opts)).toEqual({ kind: 'seek', target: { time: 30 * SEC - (60 * SEC) / 50 } });
    expect(keyAction('ArrowLeft', { ...opts, shift: true })).toEqual({ kind: 'seek', target: { time: 30 * SEC - (60 * SEC) / 10 } });
    expect(keyAction('ArrowRight', opts)).toEqual({ kind: 'seek', target: { time: 30 * SEC + (60 * SEC) / 50 } });
    expect(keyAction('PageDown', opts)).toEqual({ kind: 'live' });
    expect(keyAction('PageUp', opts)).toEqual({ kind: 'seek', target: { time: 0 } });
    expect(keyAction('Home', opts)).toEqual({ kind: 'seek', target: { time: 0 } });
    expect(keyAction('End', opts)).toEqual({ kind: 'live' });
    expect(keyAction('End', { ...opts, review: null })).toEqual({ kind: 'none' });
    expect(keyAction('ArrowRight', { ...opts, review: null })).toEqual({ kind: 'none' });
  });
});

describe('the review banner', () => {
  it('says what is shown and how far back it is', () => {
    expect(reviewBanner(null)).toBeNull();
    expect(reviewBanner(review(60 * SEC, 60 * SEC, true))).toBeNull();
    expect(reviewBanner(review(47.5 * SEC, 60 * SEC))).toEqual({
      title: TIMELINE_REVIEW_TITLE,
      at: '00:00:47.500000',
      behind: '12.5 s before now',
      action: TIMELINE_RETURN_LABEL,
    });
    expect(TIMELINE_REVIEW_TITLE).toBe('Viewing the past — return to now');
  });
});

describe('mark wording', () => {
  const mark = (event: TraceEvent, lane: TimelineMark['lane'] = 'stp'): TimelineMark => ({ cursor: 1, t: 30 * SEC, lane, event });
  const names = (id: string): string => id.toUpperCase();

  it('writes one line per event kind', () => {
    const fsm = mark({
      t: 30 * SEC,
      kind: 'debug',
      event: {
        at: 30 * SEC,
        device: 'sw1',
        process: 'stp',
        category: 'spanning-tree events',
        message: 'x',
        fsm: { machine: 'stp-port', subject: 'VLAN0001 GigabitEthernet0/2', from: 'listening', to: 'learning', cause: 'forward delay expired' },
      },
    });
    expect(markText(fsm)).toBe('Spanning-tree port · VLAN0001 GigabitEthernet0/2: listening → learning (forward delay expired)');
    expect(markText(mark({ t: 1, kind: 'tableWrite', device: 'sw1', table: 'stp', key: '1|Gi0/1', row: {} }), names)).toBe('SW1: Spanning tree ports 1|Gi0/1 written');
    expect(markText(mark({ t: 1, kind: 'tableExpire', device: 'sw1', table: 'cam', key: '1|aa', row: {}, reason: 'aged' }))).toBe('sw1: MAC address table 1|aa removed (aged)');
    expect(markText(mark({ t: 1, kind: 'configChange', device: 'sw1', line: 'switchport mode trunk', negate: false, context: [] }))).toBe('sw1: switchport mode trunk');
    expect(markText(mark({ t: 1, kind: 'configChange', device: 'sw1', line: 'vlan 10', negate: true, context: [] }))).toBe('sw1: no vlan 10');
    expect(markText(mark({ t: 1, kind: 'linkState', link: 'l1', up: false, reason: 'cut' }))).toBe('l1 down (cut)');
    expect(markText(mark({ t: 1, kind: 'portState', device: 'sw1', port: 'Gi0/1', adminUp: true, operUp: false, reason: 'err-disabled' }))).toContain('error-disabled');
    expect(markText(mark({ t: 1, kind: 'drop', pdu: { id: 1, proto: 'ethernet', size: 64, summary: '' }, device: 'sw1', reason: 'vlan-filtered', detail: 'VLAN 10 does not exist' }))).toBe(
      'sw1: The frame belongs to a VLAN this port does not carry, or to a VLAN that does not exist on the switch (VLAN 10 does not exist)',
    );
    expect(markText(mark({ t: 1, kind: 'deviceState', device: 'sw1', power: true, booted: true }))).toBe('Device');
  });

  it('puts the time and the lane in the tooltip', () => {
    const m = mark({ t: 30 * SEC, kind: 'linkState', link: 'l1', up: true });
    expect(markTooltip(m)).toBe('00:00:30.000000 · Spanning tree · l1 up');
  });
});

describe('ticks', () => {
  it('picks a 1-2-5 step that keeps the labels apart', () => {
    expect(tickStep({ from: 0, to: 60 * SEC }, 600)).toBe(10 * SEC);
    expect(tickStep({ from: 0, to: 600 * MS }, 600)).toBe(100 * MS);
    expect(tickStep({ from: 0, to: 0 }, 600)).toBeGreaterThan(0);
    expect(tickLabel(90 * SEC, SEC)).toBe('1:30');
    expect(tickLabel(3725 * SEC, SEC)).toBe('1:02:05');
    expect(tickLabel(1500 * MS, 100 * MS)).toBe('0:01.500');
  });

  it('places every tick inside the window', () => {
    const w = { from: 30 * SEC, to: 90 * SEC };
    const ticks = timelineTicks(w, 600);
    expect(ticks.length).toBeGreaterThan(2);
    for (const t of ticks) {
      expect(t.t).toBeGreaterThanOrEqual(w.from);
      expect(t.t).toBeLessThanOrEqual(w.to);
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.x).toBeLessThanOrEqual(600);
    }
    expect(ticks[0]?.label).toBe('0:30');
  });
});

describe('seek coalescing', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it('runs one seek at a time and lets the newest request win', async () => {
    const calls: number[] = [];
    const gates = [deferred<string>(), deferred<string>()];
    let n = 0;
    const queue = createSeekQueue<string>((target) => {
      calls.push('time' in target ? target.time : -1);
      return gates[n++]!.promise;
    });

    const first = queue.request({ time: 10 });
    expect(queue.busy).toBe(true);
    const second = queue.request({ time: 20 });
    const third = queue.request({ time: 30 });
    expect(queue.pending).toEqual({ time: 30 });
    expect(await second).toEqual({ status: 'superseded' });

    gates[0]!.resolve('a');
    expect(await first).toEqual({ status: 'done', result: 'a' });
    await Promise.resolve();
    gates[1]!.resolve('b');
    expect(await third).toEqual({ status: 'done', result: 'b' });
    expect(calls).toEqual([10, 30]);
    expect(queue.busy).toBe(false);
    expect(queue.pending).toBeNull();
  });

  it('reports a failure without blocking the next seek', async () => {
    const queue = createSeekQueue<string>((target) => ('time' in target && target.time === 1 ? Promise.reject(new Error('nope')) : Promise.resolve('ok')));
    const failed = await queue.request({ time: 1 });
    expect(failed.status).toBe('failed');
    expect((failed as { error: Error }).error.message).toBe('nope');
    expect(await queue.request({ time: 2 })).toEqual({ status: 'done', result: 'ok' });
    expect(queue.busy).toBe(false);
  });

  it('survives a runner that throws at once', async () => {
    const queue = createSeekQueue<string>(() => {
      throw new Error('sync');
    });
    const out = await queue.request({ time: 1 });
    expect(out.status).toBe('failed');
  });

  it('knows the engine refusing a change while reviewing', () => {
    expect(isReadOnlyRejection(new Error(REPLAY_READ_ONLY_MESSAGE))).toBe(true);
    expect(isReadOnlyRejection(new Error('something else'))).toBe(false);
    expect(isReadOnlyRejection(REPLAY_READ_ONLY_MESSAGE)).toBe(true);
  });
});
