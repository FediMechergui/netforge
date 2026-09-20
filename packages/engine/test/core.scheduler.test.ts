import { describe, expect, it } from 'vitest';
import { createScheduler } from '../src/core/scheduler.js';
import type { SimEventBody } from '../src/contracts/events.js';

const boot = (device: string): SimEventBody => ({ kind: 'boot', device });

describe('core/scheduler', () => {
  it('starts at now=0, empty', () => {
    const s = createScheduler();
    expect(s.now).toBe(0);
    expect(s.size).toBe(0);
    expect(s.peekTime()).toBeUndefined();
    expect(s.next()).toBeUndefined();
  });

  it('pops events in time order and advances now', () => {
    const s = createScheduler();
    s.schedule(300, boot('c'));
    s.schedule(100, boot('a'));
    s.schedule(200, boot('b'));
    expect(s.size).toBe(3);
    expect(s.peekTime()).toBe(100);
    const order: string[] = [];
    let ev = s.next();
    while (ev) {
      if (ev.kind === 'boot') order.push(ev.device);
      ev = s.next();
    }
    expect(order).toEqual(['a', 'b', 'c']);
    expect(s.now).toBe(300);
    expect(s.size).toBe(0);
  });

  it('assigns seq from 1 monotonically and orders equal times by seq', () => {
    const s = createScheduler();
    const seqs: number[] = [];
    for (let i = 0; i < 50; i++) seqs.push(s.schedule(1000, boot(`d${i}`)));
    expect(seqs[0]).toBe(1);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1]! + 1);
    for (let i = 0; i < 50; i++) {
      const ev = s.next()!;
      expect(ev.at).toBe(1000);
      expect(ev.seq).toBe(i + 1);
      expect(ev.kind === 'boot' && ev.device).toBe(`d${i}`);
    }
  });

  it('interleaves many random-ish times correctly (heap invariant)', () => {
    const s = createScheduler();
    const times: number[] = [];
    let x = 12345;
    for (let i = 0; i < 2000; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      const t = x % 500;
      times.push(t);
      s.schedule(t, boot(`d${i}`));
    }
    const expected = times
      .map((t, i) => ({ t, seq: i + 1 }))
      .sort((a, b) => a.t - b.t || a.seq - b.seq);
    for (const e of expected) {
      const ev = s.next()!;
      expect([ev.at, ev.seq]).toEqual([e.t, e.seq]);
    }
    expect(s.next()).toBeUndefined();
  });

  it('cancel tombstones an event: skipped by next/peekTime and excluded from size', () => {
    const s = createScheduler();
    const a = s.schedule(10, boot('a'));
    const b = s.schedule(20, boot('b'));
    const c = s.schedule(30, boot('c'));
    expect(s.cancel(a)).toBe(true);
    expect(s.size).toBe(2);
    expect(s.peekTime()).toBe(20);
    expect(s.cancel(a)).toBe(false);
    expect(s.cancel(9999)).toBe(false);
    expect(s.cancel(c)).toBe(true);
    expect(s.size).toBe(1);
    const ev = s.next()!;
    expect(ev.seq).toBe(b);
    expect(s.cancel(b)).toBe(false);
    expect(s.next()).toBeUndefined();
    expect(s.size).toBe(0);
    expect(s.peekTime()).toBeUndefined();
  });

  it('cancelling everything leaves an empty queue', () => {
    const s = createScheduler();
    const seqs = [s.schedule(5, boot('a')), s.schedule(5, boot('b'))];
    for (const q of seqs) s.cancel(q);
    expect(s.size).toBe(0);
    expect(s.peekTime()).toBeUndefined();
    expect(s.next()).toBeUndefined();
    expect(s.now).toBe(0);
  });

  it('schedule rejects the past and non-integer times', () => {
    const s = createScheduler();
    s.schedule(100, boot('a'));
    s.next();
    expect(s.now).toBe(100);
    expect(() => s.schedule(99, boot('b'))).toThrow(RangeError);
    expect(() => s.schedule(100.5, boot('b'))).toThrow(RangeError);
    expect(() => s.schedule(-1, boot('b'))).toThrow(RangeError);
    expect(s.schedule(100, boot('c'))).toBeGreaterThan(0);
  });

  it('advanceTo moves time forward without popping', () => {
    const s = createScheduler();
    s.schedule(500, boot('a'));
    s.advanceTo(400);
    expect(s.now).toBe(400);
    expect(s.size).toBe(1);
    s.advanceTo(500);
    expect(s.now).toBe(500);
    expect(s.next()!.at).toBe(500);
  });

  it('advanceTo guards: never backwards, never past a live event', () => {
    const s = createScheduler();
    s.advanceTo(100);
    expect(() => s.advanceTo(50)).toThrow(RangeError);
    expect(() => s.advanceTo(100.1)).toThrow(RangeError);
    const seq = s.schedule(200, boot('a'));
    expect(() => s.advanceTo(300)).toThrow(RangeError);
    s.cancel(seq);
    s.advanceTo(300);
    expect(s.now).toBe(300);
  });

  it('returns the body fields alongside at/seq', () => {
    const s = createScheduler();
    s.schedule(1, { kind: 'timer', device: 'd_1', process: 'arp', key: 'retry' });
    const ev = s.next()!;
    expect(ev).toEqual({ kind: 'timer', device: 'd_1', process: 'arp', key: 'retry', at: 1, seq: 1 });
  });
});
