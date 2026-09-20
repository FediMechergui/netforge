import { describe, expect, it } from 'vitest';
import { createTraceRing } from '../src/trace/ring.js';
import type { TraceEvent } from '../src/contracts/trace.js';

const log = (t: number): TraceEvent => ({ t, kind: 'log', device: 'd_1', severity: 6, facility: 'TEST', message: `m${t}` });
const times = (evs: TraceEvent[]): number[] => evs.map((e) => e.t);

describe('trace/ring', () => {
  it('starts empty with head 0', () => {
    const r = createTraceRing(4);
    expect(r.capacity).toBe(4);
    expect(r.head).toBe(0);
    expect(r.since(0)).toEqual({ events: [], next: 0, dropped: 0 });
  });

  it('retains events under capacity and drains from a cursor', () => {
    const r = createTraceRing(8);
    for (let i = 0; i < 3; i++) r.emit(log(i));
    expect(r.head).toBe(3);
    const a = r.since(0);
    expect(times(a.events)).toEqual([0, 1, 2]);
    expect(a.next).toBe(3);
    expect(a.dropped).toBe(0);
    r.emit(log(3));
    const b = r.since(a.next);
    expect(times(b.events)).toEqual([3]);
    expect(b.next).toBe(4);
    expect(b.dropped).toBe(0);
    expect(r.since(4)).toEqual({ events: [], next: 4, dropped: 0 });
  });

  it('wraps and reports dropped events once capacity is exceeded', () => {
    const r = createTraceRing(4);
    for (let i = 0; i < 10; i++) r.emit(log(i));
    expect(r.head).toBe(10);
    const all = r.since(0);
    expect(times(all.events)).toEqual([6, 7, 8, 9]);
    expect(all.next).toBe(10);
    expect(all.dropped).toBe(6);
    const partial = r.since(8);
    expect(times(partial.events)).toEqual([8, 9]);
    expect(partial.dropped).toBe(0);
    const late = r.since(3);
    expect(times(late.events)).toEqual([6, 7, 8, 9]);
    expect(late.dropped).toBe(3);
  });

  it('keeps insertion order across many wraps', () => {
    const r = createTraceRing(7);
    for (let i = 0; i < 100; i++) r.emit(log(i));
    expect(times(r.since(0).events)).toEqual([93, 94, 95, 96, 97, 98, 99]);
  });

  it('capacity 0 counts but retains nothing', () => {
    const r = createTraceRing(0);
    for (let i = 0; i < 5; i++) r.emit(log(i));
    expect(r.head).toBe(5);
    expect(r.since(0)).toEqual({ events: [], next: 5, dropped: 5 });
    expect(r.since(3)).toEqual({ events: [], next: 5, dropped: 2 });
    expect(r.since(5)).toEqual({ events: [], next: 5, dropped: 0 });
  });

  it('clear forgets retained events but keeps head monotonic', () => {
    const r = createTraceRing(4);
    for (let i = 0; i < 3; i++) r.emit(log(i));
    r.clear();
    expect(r.head).toBe(3);
    expect(r.since(0)).toEqual({ events: [], next: 3, dropped: 3 });
    r.emit(log(3));
    expect(r.head).toBe(4);
    const s = r.since(0);
    expect(times(s.events)).toEqual([3]);
    expect(s.dropped).toBe(3);
    expect(r.since(3)).toEqual({ events: [log(3)], next: 4, dropped: 0 });
  });

  it('clamps a negative or future cursor', () => {
    const r = createTraceRing(4);
    r.emit(log(0));
    expect(r.since(-5)).toEqual({ events: [log(0)], next: 1, dropped: 0 });
    expect(r.since(50)).toEqual({ events: [], next: 1, dropped: 0 });
  });

  it('rejects an invalid capacity', () => {
    expect(() => createTraceRing(-1)).toThrow(RangeError);
    expect(() => createTraceRing(1.5)).toThrow(RangeError);
  });
});
