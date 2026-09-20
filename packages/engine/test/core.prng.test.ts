import { describe, expect, it } from 'vitest';
import { createRng, hashLabel, rngFactory } from '../src/core/prng.js';

describe('core/prng', () => {
  it('is repeatable for the same seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = Array.from({ length: 64 }, () => a.nextU32());
    const seqB = Array.from({ length: 64 }, () => b.nextU32());
    expect(seqA).toEqual(seqB);
    expect(seqA.every((v) => Number.isInteger(v) && v >= 0 && v < 2 ** 32)).toBe(true);
  });

  it('differs for different seeds', () => {
    const a = createRng(1);
    const b = createRng(2);
    const seqA = Array.from({ length: 16 }, () => a.nextU32());
    const seqB = Array.from({ length: 16 }, () => b.nextU32());
    expect(seqA).not.toEqual(seqB);
  });

  it('split depends only on origin seed and label — not on parent draws', () => {
    const parent1 = createRng(7);
    const child1 = parent1.split('device:d_1');
    const seq1 = Array.from({ length: 32 }, () => child1.nextU32());

    const parent2 = createRng(7);
    for (let i = 0; i < 1000; i++) parent2.nextU32();
    const child2 = parent2.split('device:d_1');
    const seq2 = Array.from({ length: 32 }, () => child2.nextU32());

    expect(seq1).toEqual(seq2);
  });

  it('split never advances the parent', () => {
    const p = createRng(99);
    const before = p.state();
    p.split('x');
    p.split('y');
    expect(p.state()).toEqual(before);
  });

  it('two labels produce different streams', () => {
    const p = createRng(5);
    const a = p.split('link:l_1');
    const b = p.split('link:l_2');
    const seqA = Array.from({ length: 16 }, () => a.nextU32());
    const seqB = Array.from({ length: 16 }, () => b.nextU32());
    expect(seqA).not.toEqual(seqB);
  });

  it('nested splits are stable', () => {
    const a = createRng(3).split('device:d_1').split('process:arp');
    const b = createRng(3).split('device:d_1').split('process:arp');
    expect(a.nextU32()).toBe(b.nextU32());
  });

  it('fromState round-trips the exact sequence', () => {
    const r = createRng(1234);
    for (let i = 0; i < 10; i++) r.nextU32();
    const snap = r.state();
    const restored = rngFactory.fromState(snap);
    const seqA = Array.from({ length: 32 }, () => r.nextU32());
    const seqB = Array.from({ length: 32 }, () => restored.nextU32());
    expect(seqA).toEqual(seqB);
  });

  it('state() returns four u32 words and does not advance', () => {
    const r = createRng(8);
    const s1 = r.state();
    const s2 = r.state();
    expect(s1).toHaveLength(4);
    expect(s1).toEqual(s2);
    for (const w of s1) expect(Number.isInteger(w) && w >= 0 && w <= 0xffffffff).toBe(true);
  });

  it('fromSeed on the factory equals createRng', () => {
    expect(rngFactory.fromSeed(11).nextU32()).toBe(createRng(11).nextU32());
  });

  it('nextInt stays within [lo, hi] over 10k draws and hits both ends', () => {
    const r = createRng(2024);
    let sawLo = false;
    let sawHi = false;
    for (let i = 0; i < 10_000; i++) {
      const v = r.nextInt(-3, 4);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThanOrEqual(4);
      if (v === -3) sawLo = true;
      if (v === 4) sawHi = true;
    }
    expect(sawLo && sawHi).toBe(true);
    expect(r.nextInt(5, 5)).toBe(5);
    expect(() => r.nextInt(6, 5)).toThrow(RangeError);
  });

  it('nextFloat is in [0, 1)', () => {
    const r = createRng(77);
    for (let i = 0; i < 10_000; i++) {
      const f = r.nextFloat();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });

  it('chance always consumes exactly one draw', () => {
    const a = createRng(9);
    const b = createRng(9);
    expect(a.chance(0)).toBe(false);
    expect(a.chance(1)).toBe(true);
    b.nextU32();
    b.nextU32();
    expect(a.nextU32()).toBe(b.nextU32());
  });

  it('hashLabel is FNV-1a based, stable and seed-sensitive', () => {
    expect(hashLabel(0, 'a')).toBe(hashLabel(0, 'a'));
    expect(hashLabel(0, 'a')).not.toBe(hashLabel(1, 'a'));
    expect(hashLabel(0, 'a')).not.toBe(hashLabel(0, 'b'));
    const h = hashLabel(123, 'device:d_7f3a');
    expect(Number.isInteger(h) && h >= 0 && h <= 0xffffffff).toBe(true);
  });

  it('rejects malformed state', () => {
    expect(() => rngFactory.fromState([1, 2, 3, -1])).toThrow(RangeError);
    expect(() => rngFactory.fromState([1, 2, 3, 2 ** 32])).toThrow(RangeError);
  });
});
