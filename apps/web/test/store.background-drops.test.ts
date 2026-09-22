/**
 * Background drops stay hidden by default (ARCHITECTURE-P2 §2.7, §6, §10.2; W2 web-shell): 60 s of synthetic
 * background drops — the BPDUs an idle current-defaults world with two PCs discards at their host ports, one every
 * 2 s per PC — spawn no drop marker in the store, mark no device dirty in the worker's delta tracker and are not
 * listed by the sim-mode chips by default; a non-background drop still does all three, and the "Background frames"
 * overlay lets the markers through.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { DeviceId, TraceEvent } from '@netforge/engine';
import { createDirtyTracker } from '../src/bridge/worker/delta';
import type { EngineBatch } from '../src/bridge/protocol';
import { DEFAULT_LIST_CHIPS, NO_CHIPS, buildTraceFilter, isBackgroundEvent, listsBackground } from '../src/simmode/sim-events-client';
import { store } from '../src/store/store';

const SEC = 1_000_000_000;
const PCS: DeviceId[] = ['pc1', 'pc2'] as DeviceId[];

let pduSeq = 1;
function drop(t: number, dev: DeviceId, background: boolean): TraceEvent {
  const ev = {
    t,
    kind: 'drop',
    pdu: { id: pduSeq++, kind: 'frame', summary: 'BPDU', proto: 'stp' },
    device: dev,
    port: 'Gi0',
    reason: 'other',
    detail: 'no bridge process on a host port',
    ...(background ? { background: true as const } : {}),
  };
  return ev as unknown as TraceEvent;
}

/** 60 s of BPDU drops at two idle PCs: one per PC every 2 s (hello time), so 60 events. */
function idleWorldDrops(): TraceEvent[] {
  const out: TraceEvent[] = [];
  for (let t = 2 * SEC; t <= 60 * SEC; t += 2 * SEC) for (const dev of PCS) out.push(drop(t, dev, true));
  return out;
}

let epoch = 900;
function batch(events: TraceEvent[]): EngineBatch {
  return { epoch, now: events[events.length - 1]?.t ?? 0, events, playing: false, rate: 1, effectiveRate: 1, dropped: 0 } as EngineBatch;
}

afterEach(() => {
  // A new epoch clears markers and flashes; the overlay goes back to its default.
  epoch += 1;
  store.getState().applyBatch(batch([]));
  store.getState().setOverlay('backgroundFrames', false);
});

describe('the synthetic idle world', () => {
  it('produces 60 background drops over 60 s, every one flagged', () => {
    const events = idleWorldDrops();
    expect(events).toHaveLength(60);
    for (const ev of events) {
      expect(ev.kind).toBe('drop');
      expect(ev.kind === 'drop' && ev.background).toBe(true);
    }
  });
});

describe('drop markers (store/store.ts spawn line)', () => {
  it('spawn no marker for a background drop by default', () => {
    store.getState().applyBatch(batch(idleWorldDrops()));
    expect(store.getState().dropMarkers).toEqual([]);
  });

  it('still spawn one for a non-background drop', () => {
    const events = [...idleWorldDrops(), drop(61 * SEC, PCS[0]!, false)];
    store.getState().applyBatch(batch(events));
    const markers = store.getState().dropMarkers;
    expect(markers).toHaveLength(1);
    expect(markers[0]?.at.device).toBe('pc1');
    expect(markers[0]?.simTime).toBe(61 * SEC);
  });

  it('spawn one per background drop once the "Background frames" overlay is on', () => {
    store.getState().setOverlay('backgroundFrames', true);
    store.getState().applyBatch(batch(idleWorldDrops()));
    expect(store.getState().dropMarkers).toHaveLength(60);
  });

  it('keep the events themselves in the ring (only the marker is skipped)', () => {
    store.getState().applyBatch(batch(idleWorldDrops()));
    expect(store.getState().events.filter((e) => e.kind === 'drop')).toHaveLength(60);
  });
});

describe('the worker delta tracker (bridge/worker/delta.ts)', () => {
  it('marks nothing dirty for 60 s of background drops', () => {
    const tracker = createDirtyTracker(() => undefined);
    for (const ev of idleWorldDrops()) tracker.observe(ev);
    expect(tracker.empty).toBe(true);
    expect(tracker.deviceCount).toBe(0);
    expect(tracker.linksDirty).toBe(false);
    expect(tracker.devices()).toEqual([]);
  });

  it('marks the device of a non-background drop', () => {
    const tracker = createDirtyTracker(() => undefined);
    for (const ev of idleWorldDrops()) tracker.observe(ev);
    tracker.observe(drop(61 * SEC, PCS[1]!, false));
    expect(tracker.empty).toBe(false);
    expect(tracker.devices()).toEqual(['pc2']);
  });
});

describe('the sim-mode list (simmode/sim-events-client.ts)', () => {
  it('treats a background drop as a background event, like a background frame', () => {
    for (const ev of idleWorldDrops()) expect(isBackgroundEvent(ev)).toBe(true);
    expect(isBackgroundEvent(drop(1, PCS[0]!, false))).toBe(false);
    const frame = { t: 1, kind: 'frameTx', background: true } as unknown as TraceEvent;
    expect(isBackgroundEvent(frame)).toBe(true);
    const write = { t: 1, kind: 'tableWrite', background: true } as unknown as TraceEvent;
    expect(isBackgroundEvent(write)).toBe(false);
  });

  it('lists nothing of it by default (no chips, and the §4.11 default list alike), a non-background drop always', () => {
    for (const ev of idleWorldDrops()) {
      expect(listsBackground(NO_CHIPS, ev)).toBe(false);
      expect(listsBackground(DEFAULT_LIST_CHIPS, ev)).toBe(false);
    }
    expect(listsBackground(NO_CHIPS, drop(1, PCS[0]!, false))).toBe(true);
    expect(listsBackground({ ...NO_CHIPS, background: true }, idleWorldDrops()[0]!)).toBe(true);
  });

  it('sends the engine a filter that leaves background events out unless the background chip is on', () => {
    expect(buildTraceFilter(NO_CHIPS).includeBackground).toBe(false);
    expect(buildTraceFilter(DEFAULT_LIST_CHIPS).includeBackground).toBe(false);
    expect(buildTraceFilter({ ...NO_CHIPS, background: true }).includeBackground).toBe(true);
  });
});
