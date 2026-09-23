/**
 * Review batches in the store [SHOULD S1] (ARCHITECTURE-P2 §2.14, §10.2; W4 web-shell): a batch carrying `review`
 * shows an earlier instant — its snapshot, `now` and in-flight frames apply as a live batch's do, its events go to
 * `timeline.reviewEvents` (≤ REVIEW_EVENT_RING) and never to `events`, no marker or flash is spawned, the dropped and
 * left-out counters stay the live stream's, and the epoch never changes. `review: null` restores the mirror from the
 * full live snapshot it carries; `timelineHead` keeps `timeline.head`; a new epoch clears the review state but not the
 * strip's lane choice; the default lanes are the engine's canonical list.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { LANE_IDS } from '@netforge/engine';
import type { TraceEvent } from '@netforge/engine';
import type { EngineBatch, ReviewInfo } from '../src/bridge/protocol';
import { DEFAULT_TIMELINE_LANES, REVIEW_EVENT_RING, defaultTimelineUi, store } from '../src/store/store';

const SEC = 1_000_000_000;
const base = { playing: false, rate: 1, effectiveRate: 1, dropped: 0 };

const snap = (now: number, devices: { id: string; name: string }[] = [], topologyVersion = 1) =>
  ({ now, devices: devices.map((d) => ({ ...d, ports: [] })), links: [], inflight: [], sessions: [], topologyVersion }) as never;

function live(epoch: number, now: number, events: TraceEvent[] = [], extra: Partial<EngineBatch> = {}): EngineBatch {
  return { ...base, epoch, now, events, ...extra } as EngineBatch;
}

const reviewInfo = (t: number, liveNow: number, dispatched = 10): ReviewInfo => ({
  at: { dispatched, now: t },
  t,
  live: { dispatched: 100, now: liveNow },
  atLive: false,
});

function reviewBatch(epoch: number, info: ReviewInfo, events: TraceEvent[] = [], extra: Partial<EngineBatch> = {}): EngineBatch {
  return { ...base, epoch, now: info.t, events, review: info, ...extra } as EngineBatch;
}

let pdu = 1;
const frame = (t: number): TraceEvent =>
  ({ t, kind: 'frameTx', pdu: { id: pdu++ }, link: 'l1', from: { device: 'a', port: 'p' }, to: { device: 'b', port: 'p' }, txStart: t, txEnd: t + 4, arrive: t + 9 * SEC }) as never;
const drop = (t: number): TraceEvent => ({ t, kind: 'drop', pdu: { id: pdu++ }, device: 'a', reason: 'no-route' }) as never;
const write = (t: number, key: string): TraceEvent => ({ t, kind: 'tableWrite', device: 'a', table: 'arp', key }) as never;
const output = (t: number, text: string): TraceEvent => ({ t, kind: 'cliOutput', session: 's_1', text }) as never;

let epoch = 500;

beforeEach(() => {
  // Each case starts from an empty mirror in its own generation.
  epoch += 1;
  store.getState().applyBatch(live(epoch, 0, [], { snapshot: snap(0) }));
  store.setState({ timeline: defaultTimelineUi() });
});

describe('the default timeline slice', () => {
  it('shows every engine lane in canonical order and nothing in flight', () => {
    expect(DEFAULT_TIMELINE_LANES).toEqual([...LANE_IDS]);
    const tl = store.getState().timeline;
    expect(tl?.lanes).toEqual([...LANE_IDS]);
    expect(tl?.review).toBeNull();
    expect(tl?.head).toBeNull();
    expect(tl?.seeking).toBe(false);
    expect(tl?.reviewEvents).toEqual([]);
  });
});

describe('a review batch', () => {
  it('never touches `events` or the epoch; its events go to reviewEvents', () => {
    store.getState().applyBatch(live(epoch, 50 * SEC, [output(48 * SEC, 'live a\n'), frame(49 * SEC), write(50 * SEC, '10.0.0.1')], { snapshot: snap(50 * SEC, [{ id: 'a', name: 'A' }]) }));
    const before = store.getState();
    expect(before.events).toHaveLength(3);
    const liveEvents = before.events;

    const info = reviewInfo(20 * SEC, 50 * SEC);
    store.getState().applyBatch(reviewBatch(epoch, info, [output(18 * SEC, 'past\n'), drop(19 * SEC), write(20 * SEC, '10.0.0.9')], { snapshot: snap(20 * SEC, [{ id: 'a', name: 'A' }]) }));
    const st = store.getState();
    expect(st.epoch).toBe(epoch);
    expect(st.events).toBe(liveEvents);
    expect(st.events.map((e) => (e.kind === 'cliOutput' ? e.text : e.kind))).toEqual(['live a\n', 'frameTx', 'tableWrite']);
    expect(st.timeline?.review).toEqual(info);
    expect(st.timeline?.reviewEvents.map((e) => e.kind)).toEqual(['cliOutput', 'drop', 'tableWrite']);
    // the instant on screen is the past
    expect(st.now).toBe(20 * SEC);
    expect(st.snapshot?.now).toBe(20 * SEC);
  });

  it('spawns no drop marker and no table flash, and leaves the dropped and left-out counters alone', () => {
    store.getState().applyBatch(live(epoch, 50 * SEC, [], { snapshot: snap(50 * SEC) }));
    const info = reviewInfo(20 * SEC, 50 * SEC);
    store.getState().applyBatch(reviewBatch(epoch, info, [drop(19 * SEC), write(20 * SEC, 'k')], { snapshot: snap(20 * SEC), dropped: 77, eventsTruncated: 9 }));
    const st = store.getState();
    expect(st.dropMarkers).toEqual([]);
    expect(st.tableFlashes).toEqual([]);
    expect(st.droppedEvents).toBe(0);
    expect(st.eventsTruncated).toBe(0);
    // a live drop still spawns a marker, once review ended
    store.getState().applyBatch(live(epoch, 51 * SEC, [drop(51 * SEC)], { snapshot: snap(51 * SEC), review: null }));
    expect(store.getState().dropMarkers).toHaveLength(1);
  });

  it('keeps at most REVIEW_EVENT_RING review events, the newest', () => {
    const info = reviewInfo(20 * SEC, 50 * SEC);
    const many: TraceEvent[] = [];
    for (let i = 0; i < REVIEW_EVENT_RING + 500; i++) many.push(output(i, `${i}\n`));
    store.getState().applyBatch(reviewBatch(epoch, info, many, { snapshot: snap(20 * SEC) }));
    const evs = store.getState().timeline?.reviewEvents ?? [];
    expect(evs).toHaveLength(REVIEW_EVENT_RING);
    expect(evs[0]?.kind === 'cliOutput' && evs[0].text).toBe('500\n');
    expect(evs[evs.length - 1]?.kind === 'cliOutput' && evs[evs.length - 1]?.text).toBe(`${REVIEW_EVENT_RING + 499}\n`);
    // a later review batch appends and keeps the cap
    store.getState().applyBatch(reviewBatch(epoch, reviewInfo(21 * SEC, 50 * SEC), [output(21 * SEC, 'more\n')]));
    const next = store.getState().timeline?.reviewEvents ?? [];
    expect(next).toHaveLength(REVIEW_EVENT_RING);
    expect(next[next.length - 1]?.kind === 'cliOutput' && next[next.length - 1]?.text).toBe('more\n');
  });

  it('merges a review delta against the review snapshot and keeps the identity of untouched devices', () => {
    store.getState().applyBatch(live(epoch, 50 * SEC, [], { snapshot: snap(50 * SEC, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], 3) }));
    const info = reviewInfo(20 * SEC, 50 * SEC);
    store.getState().applyBatch(reviewBatch(epoch, info, [], { snapshot: snap(20 * SEC, [{ id: 'a', name: 'A0' }, { id: 'b', name: 'B0' }], 2) }));
    const a = store.getState().snapshot?.devices[0];
    expect(a?.name).toBe('A0');
    const delta = { now: 21 * SEC, inflight: [], sessions: [], topologyVersion: 2, devices: [{ id: 'b', name: 'B1', ports: [] }] } as never;
    store.getState().applyBatch(reviewBatch(epoch, reviewInfo(21 * SEC, 50 * SEC, 11), [], { delta }));
    const st = store.getState();
    expect(st.snapshot?.devices[0]).toBe(a);
    expect(st.snapshot?.devices[1]?.name).toBe('B1');
    expect(st.now).toBe(21 * SEC);
    expect(st.timeline?.review?.at.dispatched).toBe(11);
  });

  it('shows the in-flight frames of that instant and drops the live ones', () => {
    store.getState().applyBatch(live(epoch, 50 * SEC, [frame(49 * SEC)], { snapshot: { ...(snap(50 * SEC) as object), inflight: [] } as never }));
    // the live frame is on a cable
    store.getState().applyBatch(live(epoch, 50 * SEC + 1, [frame(50 * SEC)]));
    expect(store.getState().inflight).toHaveLength(1);
    const pastFrame = { pdu: { id: 900 }, link: 'l1', from: { device: 'a', port: 'p' }, to: { device: 'b', port: 'p' }, txStart: 19 * SEC, txEnd: 19 * SEC + 4, arrive: 20 * SEC + 5 };
    store.getState().applyBatch(reviewBatch(epoch, reviewInfo(20 * SEC, 50 * SEC), [], { snapshot: { ...(snap(20 * SEC) as object), inflight: [pastFrame] } as never }));
    const inflight = store.getState().inflight;
    expect(inflight).toHaveLength(1);
    expect(inflight[0]?.pdu.id).toBe(900);
  });
});

describe('review ends', () => {
  it('a `review: null` batch restores the live mirror and empties reviewEvents; its events are live events', () => {
    store.getState().applyBatch(live(epoch, 50 * SEC, [output(50 * SEC, 'x\n')], { snapshot: snap(50 * SEC, [{ id: 'a', name: 'A' }]) }));
    store.getState().applyBatch(reviewBatch(epoch, reviewInfo(20 * SEC, 50 * SEC), [output(20 * SEC, 'past\n')], { snapshot: snap(20 * SEC, [{ id: 'a', name: 'Old' }]) }));
    expect(store.getState().timeline?.review).not.toBeNull();
    store.getState().applyBatch(live(epoch, 50 * SEC, [output(50 * SEC, 'y\n')], { snapshot: snap(50 * SEC, [{ id: 'a', name: 'A' }]), review: null }));
    const st = store.getState();
    expect(st.epoch).toBe(epoch);
    expect(st.timeline?.review).toBeNull();
    expect(st.timeline?.reviewEvents).toEqual([]);
    expect(st.now).toBe(50 * SEC);
    expect(st.snapshot?.devices[0]?.name).toBe('A');
    expect(st.events.map((e) => (e.kind === 'cliOutput' ? e.text : ''))).toEqual(['x\n', 'y\n']);
  });

  it('a plain live batch leaves an ended review state untouched (review is only ever set by review batches)', () => {
    store.getState().applyBatch(live(epoch, 50 * SEC, [], { snapshot: snap(50 * SEC) }));
    expect(store.getState().timeline?.review).toBeNull();
    store.getState().applyBatch(live(epoch, 51 * SEC, [output(51 * SEC, 'z\n')]));
    expect(store.getState().timeline?.review).toBeNull();
    expect(store.getState().events).toHaveLength(1);
  });
});

describe('the timeline head and the strip state', () => {
  it('timelineHead keeps timeline.head on live and review batches alike (without the lane revision)', () => {
    store.getState().applyBatch(live(epoch, 50 * SEC, [], { snapshot: snap(50 * SEC), timelineHead: { t: 50 * SEC, at: { dispatched: 100, now: 50 * SEC }, lanesRevision: 7 } }));
    expect(store.getState().timeline?.head).toEqual({ t: 50 * SEC, at: { dispatched: 100, now: 50 * SEC } });
    store.getState().applyBatch(reviewBatch(epoch, reviewInfo(20 * SEC, 50 * SEC), [], { snapshot: snap(20 * SEC), timelineHead: { t: 50 * SEC, at: { dispatched: 101, now: 50 * SEC }, lanesRevision: 8 } }));
    expect(store.getState().timeline?.head?.at.dispatched).toBe(101);
    // a batch without a head leaves it
    store.getState().applyBatch(reviewBatch(epoch, reviewInfo(21 * SEC, 50 * SEC)));
    expect(store.getState().timeline?.head?.at.dispatched).toBe(101);
  });

  it('lanes and seeking belong to the strip: batches never change them', () => {
    store.setState((s) => ({ timeline: { ...(s.timeline ?? defaultTimelineUi()), lanes: ['stp', 'link'], seeking: true } }));
    store.getState().applyBatch(reviewBatch(epoch, reviewInfo(20 * SEC, 50 * SEC), [], { snapshot: snap(20 * SEC) }));
    store.getState().applyBatch(live(epoch, 50 * SEC, [], { snapshot: snap(50 * SEC), review: null }));
    expect(store.getState().timeline?.lanes).toEqual(['stp', 'link']);
    expect(store.getState().timeline?.seeking).toBe(true);
  });

  it('a new epoch clears the review state and the head but keeps the lane choice', () => {
    store.setState((s) => ({ timeline: { ...(s.timeline ?? defaultTimelineUi()), lanes: ['drops'], seeking: true } }));
    store.getState().applyBatch(live(epoch, 50 * SEC, [], { snapshot: snap(50 * SEC), timelineHead: { t: 50 * SEC, at: { dispatched: 100, now: 50 * SEC }, lanesRevision: 1 } }));
    store.getState().applyBatch(reviewBatch(epoch, reviewInfo(20 * SEC, 50 * SEC), [output(20 * SEC, 'past\n')], { snapshot: snap(20 * SEC) }));
    store.getState().applyBatch(live(epoch + 1, 0, [], { snapshot: snap(0) }));
    const tl = store.getState().timeline;
    expect(tl?.review).toBeNull();
    expect(tl?.head).toBeNull();
    expect(tl?.seeking).toBe(false);
    expect(tl?.reviewEvents).toEqual([]);
    expect(tl?.lanes).toEqual(['drops']);
    epoch += 1;
  });
});
