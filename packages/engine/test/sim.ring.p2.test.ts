/**
 * trace/ring.ts — `startHead` and `at` [SHOULD S1] (ARCHITECTURE-P2 §2.13, §3.13; §7 W1 sim [S1]): a replay's ring
 * starts at the live world's trace head so the same event has the same cursor in both worlds; `at(cursor)` reads one
 * retained event; `traceQuery` never pages below the ring's first cursor. A ring built without `startHead` is the P1
 * ring.
 */
import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createRunControl, createTrackedScheduler } from '../src/sim/run-control.js';
import { createTraceRing, type TraceRingImpl } from '../src/trace/ring.js';

/** A distinct log event per index. */
const ev = (i: number): TraceEvent => ({ t: i, kind: 'log', device: 'd1', severity: 6, facility: 'TEST', message: `event ${i}` });
const msg = (e: TraceEvent | undefined): string | undefined => (e?.kind === 'log' ? e.message : undefined);

function filled(capacity: number, startHead: number, count: number): TraceRingImpl {
  const ring = createTraceRing(capacity, startHead);
  for (let i = 0; i < count; i++) ring.emit(ev(i));
  return ring;
}

describe('trace ring startHead', () => {
  it('defaults to 0: the P1 ring', () => {
    const ring = createTraceRing(4);
    expect(ring.startHead).toBe(0);
    expect(ring.head).toBe(0);
    ring.emit(ev(0));
    expect(ring.head).toBe(1);
    expect(ring.since(0)).toEqual({ events: [ev(0)], next: 1, dropped: 0 });
  });

  it('starts head at startHead; cursors below it were never retained and count as dropped', () => {
    const ring = filled(8, 100, 3);
    expect(ring.startHead).toBe(100);
    expect(ring.head).toBe(103);
    expect(ring.since(0)).toEqual({ events: [ev(0), ev(1), ev(2)], next: 103, dropped: 100 });
    expect(ring.since(100)).toEqual({ events: [ev(0), ev(1), ev(2)], next: 103, dropped: 0 });
    expect(ring.since(102)).toEqual({ events: [ev(2)], next: 103, dropped: 0 });
    expect(ring.since(103)).toEqual({ events: [], next: 103, dropped: 0 });
  });

  it('aligns cursors: an event has cursor startHead + i, whatever the capacity or wrap', () => {
    const base = filled(5, 0, 12);
    const shifted = filled(5, 1000, 12);
    for (let c = 0; c <= 12; c++) {
      const a = base.since(c);
      const b = shifted.since(1000 + c);
      expect(b.events).toEqual(a.events);
      expect(b.next).toBe(a.next + 1000);
      expect(b.dropped).toBe(a.dropped);
    }
    expect(shifted.startHead).toBe(1000);
  });

  it('counts without retaining at capacity 0', () => {
    const ring = filled(0, 7, 4);
    expect(ring.head).toBe(11);
    expect(ring.since(7)).toEqual({ events: [], next: 11, dropped: 4 });
    expect(ring.at(8)).toBeUndefined();
  });

  it('refuses a negative or non-integer start', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => createTraceRing(4, bad)).toThrow(RangeError);
    }
    expect(() => createTraceRing(4, -1)).toThrow('trace ring start head must be a non-negative integer, got -1');
  });
});

describe('trace ring at(cursor)', () => {
  it('reads each retained event by cursor, and nothing outside the retained window', () => {
    const ring = filled(4, 50, 6);
    // retained: cursors 52..55 (events 2..5)
    expect(ring.head).toBe(56);
    expect(ring.at(51)).toBeUndefined();
    for (let c = 52; c < 56; c++) expect(msg(ring.at(c))).toBe(`event ${c - 50}`);
    expect(ring.at(56)).toBeUndefined();
    expect(ring.at(49)).toBeUndefined();
    expect(ring.at(53.5)).toBeUndefined();
    expect(ring.at(Number.NaN)).toBeUndefined();
    expect(ring.at(ring.head - 1)).toBe(ring.since(ring.head - 1).events[0]);
  });

  it('matches since() for every cursor, and forgets everything on clear()', () => {
    const ring = filled(3, 0, 5);
    for (let c = 0; c < 5; c++) {
      const s = ring.since(c);
      expect(ring.at(c)).toBe(s.dropped > 0 ? undefined : s.events[0]);
    }
    ring.clear();
    expect(ring.head).toBe(5);
    for (let c = 0; c < 6; c++) expect(ring.at(c)).toBeUndefined();
    ring.emit(ev(9));
    expect(msg(ring.at(5))).toBe('event 9');
  });
});

describe('traceQuery over a ring that starts at startHead', () => {
  function runControl(ring: TraceRingImpl) {
    const s = createTrackedScheduler();
    return createRunControl({ scheduler: () => s, dispatch: () => undefined, trace: ring, tap: () => () => undefined });
  }

  it('pages from the first cursor forward and backward, with cursors aligned to the live world', () => {
    const base = runControl(filled(16, 0, 5));
    const shifted = runControl(filled(16, 200, 5));
    const f0 = base.traceQuery({ from: 0, limit: 10 });
    const f1 = shifted.traceQuery({ from: 0, limit: 10 });
    expect(f1.oldest).toBe(200);
    expect(f1.head).toBe(205);
    expect(f1.next).toBe(205);
    expect(f1.events.map((e) => e.cursor)).toEqual([200, 201, 202, 203, 204]);
    expect(f1.events.map((e) => e.event)).toEqual(f0.events.map((e) => e.event));
    const b1 = shifted.traceQuery({ from: 10_000, limit: 10, direction: 'backward' });
    expect(b1.events.map((e) => e.cursor)).toEqual([204, 203, 202, 201, 200]);
    expect(b1.next).toBe(199);
    const below = shifted.traceQuery({ from: 150, limit: 10, direction: 'backward' });
    expect(below.events).toEqual([]);
    expect(below.next).toBe(199);
    const mid = shifted.traceQuery({ from: 202, limit: 2 });
    expect(mid.events.map((e) => [e.cursor, msg(e.event)])).toEqual([
      [202, 'event 2'],
      [203, 'event 3'],
    ]);
    expect(mid.next).toBe(204);
  });

  it('after the ring wraps, the oldest retained cursor is head − capacity', () => {
    const q = runControl(filled(4, 200, 10)).traceQuery({ from: 0, limit: 100 });
    expect(q.oldest).toBe(206);
    expect(q.events.map((e) => e.cursor)).toEqual([206, 207, 208, 209]);
    expect(q.events.map((e) => msg(e.event))).toEqual(['event 6', 'event 7', 'event 8', 'event 9']);
  });

  it('a ring without startHead pages exactly as before', () => {
    const q = runControl(filled(4, 0, 10)).traceQuery({ from: 0, limit: 100 });
    expect(q.oldest).toBe(6);
    expect(q.events.map((e) => e.cursor)).toEqual([6, 7, 8, 9]);
    const b = runControl(filled(8, 0, 3)).traceQuery({ from: 5, limit: 10, direction: 'backward' });
    expect(b.events.map((e) => e.cursor)).toEqual([2, 1, 0]);
    expect(b.next).toBe(-1);
  });
});
