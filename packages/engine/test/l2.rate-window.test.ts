/**
 * W1 l2 (ARCHITECTURE-P3 D13, §4.1 "Snooping and DAI", §4.2, §4.5): packet counting in windows aligned to sim time,
 * shared by the DHCP snooping and DAI rate limits and the DAI log bound.
 */
import { describe, expect, it } from 'vitest';
import { MS, SEC } from '../src/contracts/time.js';
import {
  RATE_WINDOW_NS,
  countInRateWindow,
  rateExceeded,
  rateWindowCount,
  rateWindowStart,
} from '../src/protocols/l2/rate-window.js';
import type { RateWindow } from '../src/protocols/l2/rate-window.js';

describe('rateWindowStart', () => {
  it('floors to a multiple of the window length (one second by default)', () => {
    expect(RATE_WINDOW_NS).toBe(SEC);
    expect(rateWindowStart(0)).toBe(0);
    expect(rateWindowStart(SEC - 1)).toBe(0);
    expect(rateWindowStart(SEC)).toBe(SEC);
    expect(rateWindowStart(7 * SEC + 999 * MS)).toBe(7 * SEC);
    expect(rateWindowStart(7 * SEC + 999 * MS, 3 * SEC)).toBe(6 * SEC);
    expect(rateWindowStart(5 * SEC, 3 * SEC)).toBe(3 * SEC);
  });

  it('stays an exact integer far into sim time', () => {
    const late = 90 * 86400 * SEC + 123_456_789; // 90 days, below 2^53 ns
    expect(Number.isSafeInteger(late)).toBe(true);
    expect(rateWindowStart(late)).toBe(90 * 86400 * SEC);
  });

  it('refuses a non-positive or fractional length', () => {
    expect(() => rateWindowStart(5, 0)).toThrow(RangeError);
    expect(() => rateWindowStart(5, -SEC)).toThrow(RangeError);
    expect(() => rateWindowStart(5, 1.5)).toThrow(RangeError);
  });
});

describe('countInRateWindow', () => {
  it('counts packets of one window and restarts at 1 in the next (no timer, evaluated lazily)', () => {
    let w: RateWindow | undefined;
    for (let i = 0; i < 5; i++) w = countInRateWindow(w, 2 * SEC + i * 100 * MS);
    expect(w).toEqual({ start: 2 * SEC, count: 5 });
    w = countInRateWindow(w, 3 * SEC);
    expect(w).toEqual({ start: 3 * SEC, count: 1 });
    // a quiet window in between is never materialised
    w = countInRateWindow(w, 9 * SEC + 1);
    expect(w).toEqual({ start: 9 * SEC, count: 1 });
  });

  it('does not mutate the previous window', () => {
    const prev: RateWindow = Object.freeze({ start: 0, count: 3 });
    expect(countInRateWindow(prev, 10)).toEqual({ start: 0, count: 4 });
    expect(prev).toEqual({ start: 0, count: 3 });
  });

  it('a window from another instant (earlier or later) restarts the count', () => {
    expect(countInRateWindow({ start: 5 * SEC, count: 9 }, 2 * SEC)).toEqual({ start: 2 * SEC, count: 1 });
  });

  it('longer windows (a DAI burst interval) are aligned to multiples of their length', () => {
    let w: RateWindow | undefined;
    for (const t of [3 * SEC, 4 * SEC, 5 * SEC + 999 * MS]) w = countInRateWindow(w, t, 3 * SEC);
    expect(w).toEqual({ start: 3 * SEC, count: 3 });
    expect(countInRateWindow(w, 6 * SEC, 3 * SEC)).toEqual({ start: 6 * SEC, count: 1 });
  });
});

describe('rateExceeded and rateWindowCount', () => {
  it('exceeded means MORE packets than the limit (limit 10: the 11th; limit 15: the 16th)', () => {
    expect(rateExceeded({ start: 0, count: 10 }, 10)).toBe(false);
    expect(rateExceeded({ start: 0, count: 11 }, 10)).toBe(true);
    expect(rateExceeded({ start: 0, count: 15 }, 15)).toBe(false);
    expect(rateExceeded({ start: 0, count: 16 }, 15)).toBe(true);
    // a limit of 0 refuses the first packet
    expect(rateExceeded({ start: 0, count: 1 }, 0)).toBe(true);
  });

  it('rateWindowCount reads the count of the window holding now', () => {
    expect(rateWindowCount(undefined, 5)).toBe(0);
    expect(rateWindowCount({ start: SEC, count: 4 }, SEC + 999 * MS)).toBe(4);
    expect(rateWindowCount({ start: SEC, count: 4 }, 2 * SEC)).toBe(0);
    expect(rateWindowCount({ start: 3 * SEC, count: 2 }, 5 * SEC, 3 * SEC)).toBe(2);
  });

  it('two runs of the same arrivals count identically (determinism)', () => {
    const arrivals = [0, 1, 999_999_999, SEC, SEC + 1, 3 * SEC, 3 * SEC + 7];
    const run = (): RateWindow[] => {
      const out: RateWindow[] = [];
      let w: RateWindow | undefined;
      for (const t of arrivals) {
        w = countInRateWindow(w, t);
        out.push(w);
      }
      return out;
    };
    expect(run()).toEqual(run());
    expect(run().map((w) => w.count)).toEqual([1, 2, 3, 1, 2, 1, 2]);
  });
});
