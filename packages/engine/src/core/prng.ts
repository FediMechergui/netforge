/**
 * core/prng.ts — deterministic, splittable pseudo-random source (spec §4.2 "Determinism (G4)").
 *
 * Implements the `Rng` / `RngFactory` contracts with:
 *   • xoshiro128** as the generator (four u32 words of state, pure integer arithmetic);
 *   • splitmix32 to expand a 32-bit seed into the four state words;
 *   • FNV-1a (32-bit) to derive sub-stream seeds from `(originSeed, label)`.
 *
 * Every stream remembers the seed it was created from (its *origin*). `split(label)`
 * depends ONLY on that origin and the label — never on how many numbers have been
 * drawn — so adding a device or drawing extra numbers on a parent never perturbs the
 * sequence any child observes. `split` never advances the parent.
 *
 * Streams restored with `fromState` have no recorded origin; their origin is derived
 * deterministically from the four state words (see `originFromState`). Splitting such a
 * stream is therefore reproducible across restores, but not identical to splitting the
 * pre-snapshot stream — split at construction time, not after time-travel.
 */
import type { Rng, RngFactory } from '../contracts/rng.js';

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const TWO_POW_32 = 4294967296;

/** Rotate a u32 left by `k` bits. */
function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** Fold an arbitrary JS number (integer of any size, or a float) into a u32 seed. */
function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed)) return 0;
  const truncated = Math.trunc(seed);
  const lo = truncated >>> 0;
  const hi = Math.floor(Math.abs(truncated) / TWO_POW_32) >>> 0;
  const sign = truncated < 0 ? 0x5bd1e995 : 0;
  return (lo ^ Math.imul(hi, 0x9e3779b1) ^ sign) >>> 0;
}

/**
 * FNV-1a 32-bit hash of `label`, mixed with `seed`: the seed's four bytes are fed first,
 * then every UTF-16 code unit of the label as two bytes (low, high). Pure integer math.
 */
export function hashLabel(seed: number, label: string): number {
  let h = FNV_OFFSET;
  const s = normalizeSeed(seed);
  h = Math.imul(h ^ (s & 0xff), FNV_PRIME);
  h = Math.imul(h ^ ((s >>> 8) & 0xff), FNV_PRIME);
  h = Math.imul(h ^ ((s >>> 16) & 0xff), FNV_PRIME);
  h = Math.imul(h ^ ((s >>> 24) & 0xff), FNV_PRIME);
  for (let i = 0; i < label.length; i++) {
    const c = label.charCodeAt(i);
    h = Math.imul(h ^ (c & 0xff), FNV_PRIME);
    h = Math.imul(h ^ (c >>> 8), FNV_PRIME);
  }
  return h >>> 0;
}

/** splitmix32: expand a u32 seed into four u32 state words (never all zero). */
function seedState(seed32: number): [number, number, number, number] {
  let a = seed32 | 0;
  const next = (): number => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    t = t ^ (t >>> 15);
    return t >>> 0;
  };
  const state: [number, number, number, number] = [next(), next(), next(), next()];
  if ((state[0] | state[1] | state[2] | state[3]) === 0) state[0] = 1;
  return state;
}

/** Deterministic origin seed for a stream restored from raw state words. */
function originFromState(s: readonly [number, number, number, number]): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < 4; i++) {
    const w = s[i]! >>> 0;
    h = Math.imul(h ^ (w & 0xff), FNV_PRIME);
    h = Math.imul(h ^ ((w >>> 8) & 0xff), FNV_PRIME);
    h = Math.imul(h ^ ((w >>> 16) & 0xff), FNV_PRIME);
    h = Math.imul(h ^ ((w >>> 24) & 0xff), FNV_PRIME);
  }
  return h >>> 0;
}

/** xoshiro128** stream. */
class Xoshiro128StarStar implements Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;
  private readonly origin: number;

  constructor(state: readonly [number, number, number, number], origin: number) {
    this.s0 = state[0] >>> 0;
    this.s1 = state[1] >>> 0;
    this.s2 = state[2] >>> 0;
    this.s3 = state[3] >>> 0;
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
    this.origin = origin >>> 0;
  }

  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  nextFloat(): number {
    return this.nextU32() / TWO_POW_32;
  }

  nextInt(lo: number, hi: number): number {
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi) {
      throw new RangeError(`nextInt: invalid range [${lo}, ${hi}]`);
    }
    const span = hi - lo + 1;
    return lo + Math.floor(this.nextFloat() * span);
  }

  chance(p: number): boolean {
    // Always draws exactly once so stream position stays deterministic (link model rule).
    return this.nextFloat() < p;
  }

  split(label: string): Rng {
    const childSeed = hashLabel(this.origin, label);
    return new Xoshiro128StarStar(seedState(childSeed), childSeed);
  }

  state(): readonly [number, number, number, number] {
    return [this.s0, this.s1, this.s2, this.s3];
  }
}

/** Create a root stream from a scenario seed (any finite number; folded into a u32). */
export function createRng(seed: number): Rng {
  const seed32 = normalizeSeed(seed);
  return new Xoshiro128StarStar(seedState(seed32), seed32);
}

/**
 * Restore a stream from the four u32 words returned by `Rng.state()`. The restored
 * stream continues the exact same sequence; its split origin is derived from the words.
 */
export function rngFromState(state: readonly [number, number, number, number]): Rng {
  if (state.length !== 4) throw new RangeError('rng state must have exactly 4 words');
  for (let i = 0; i < 4; i++) {
    const w = state[i];
    if (w === undefined || !Number.isInteger(w) || w < 0 || w > 0xffffffff) {
      throw new RangeError(`rng state word ${i} must be a u32, got ${w}`);
    }
  }
  return new Xoshiro128StarStar(state, originFromState(state));
}

/** The `RngFactory` handed to the simulation. */
export const rngFactory: RngFactory = {
  fromSeed: createRng,
  fromState: rngFromState,
};
