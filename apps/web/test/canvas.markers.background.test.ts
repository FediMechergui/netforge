/**
 * Background drops spawn no drop marker (ARCHITECTURE-P2 §2.7, §6, §10.2 `canvas.markers.background`; W3 web-canvas):
 * 60 s of synthetic background drops — the BPDUs an idle current-defaults world with two PCs discards at their host
 * ports, one every 2 s per PC — spawn no marker through the markers rule, none through the store, and the marker
 * layer therefore has nothing to place; a non-background drop still spawns one that anchors above its device, and
 * the "Background frames" overlay lets background drops through.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { DeviceId, TraceEvent } from '@netforge/engine';
import type { EngineBatch } from '../src/bridge/protocol';
import { dropEventsToMark, markerAnchor, spawnsDropMarker, type MarkerAnchorSource } from '../src/canvas/markers.js';
import { computeLayout } from '../src/canvas/ports.js';
import { store } from '../src/store/store';
import { device, port, snapshot } from './canvas-fixtures.js';

const SEC = 1_000_000_000;
const PCS: DeviceId[] = ['pc1', 'pc2'];

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

let epoch = 1200;
function batch(events: TraceEvent[]): EngineBatch {
  return { epoch, now: events[events.length - 1]?.t ?? 0, events, playing: false, rate: 1, effectiveRate: 1, dropped: 0 } as EngineBatch;
}

afterEach(() => {
  epoch += 1;
  store.getState().applyBatch(batch([]));
  store.getState().setOverlay('backgroundFrames', false);
});

describe('the markers rule (canvas/markers.ts)', () => {
  it('spawns nothing for 60 s of background drops', () => {
    const events = idleWorldDrops();
    expect(events.length).toBe(60);
    for (const ev of events) expect(spawnsDropMarker(ev, false)).toBe(false);
    expect(dropEventsToMark(events, false)).toEqual([]);
  });

  it('still spawns for a non-background drop, and never for other kinds', () => {
    const plain = drop(61 * SEC, PCS[0]!, false);
    expect(spawnsDropMarker(plain, false)).toBe(true);
    expect(dropEventsToMark([...idleWorldDrops(), plain], false)).toEqual([plain]);
    const frame = { t: 1, kind: 'frameTx', background: true } as unknown as TraceEvent;
    expect(spawnsDropMarker(frame, true)).toBe(false);
    const write = { t: 1, kind: 'tableWrite' } as unknown as TraceEvent;
    expect(spawnsDropMarker(write, true)).toBe(false);
  });

  it('lets background drops through while background frames are shown', () => {
    const events = idleWorldDrops();
    expect(dropEventsToMark(events, true).length).toBe(60);
    for (const ev of events) expect(spawnsDropMarker(ev, true)).toBe(true);
  });
});

describe('the store spawn agrees with the rule, so the marker layer has nothing to place', () => {
  it('keeps the marker list empty over 60 s of background drops', () => {
    store.getState().applyBatch(batch(idleWorldDrops()));
    expect(store.getState().dropMarkers).toEqual([]);
  });

  it('spawns one marker for a non-background drop, anchored above its device on the canvas', () => {
    const plain = drop(61 * SEC, PCS[1]!, false);
    store.getState().applyBatch(batch([...idleWorldDrops(), plain]));
    const markers = store.getState().dropMarkers;
    expect(markers.length).toBe(1);
    expect(markers[0]?.at).toEqual({ device: 'pc2' });
    expect(markers[0]?.reason).toBe('other');

    const pc2 = device('pc2', 300, 120, [port('Gi0')]);
    const layout = computeLayout(snapshot([pc2]), new Map());
    const src: MarkerAnchorSource = { layout, linkGeometry: () => undefined, assocGeometry: () => undefined };
    const anchor = markerAnchor(markers[0]!.at, src);
    expect(anchor?.key).toBe('d:pc2');
    expect(anchor?.x).toBe(300);
    expect(anchor?.y).toBeLessThan(120);
  });

  it('spawns the background drops too once background frames are shown', () => {
    store.getState().setOverlay('backgroundFrames', true);
    store.getState().applyBatch(batch(idleWorldDrops()));
    expect(store.getState().dropMarkers.length).toBe(60);
  });
});
