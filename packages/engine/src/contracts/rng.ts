/**
 * Deterministic, splittable pseudo-random source (spec §4.2, G4).
 *
 * The simulation owns ONE root `Rng` seeded from the scenario seed. Every
 * entity (device, process, link) receives a *derived sub-stream* via
 * `split(label)` where `label` is a stable string such as `"device:d_7f3a"`
 * or `"link:l_02c1"`. Because the sub-stream depends only on (seed, label),
 * adding a device never perturbs the random sequence of existing devices.
 *
 * Implementation (core/prng.ts): 64-bit state held as two u32 halves
 * (xoshiro128** or splitmix32 family); `split` hashes the label (FNV-1a or
 * similar) into the parent seed. Must be pure integer arithmetic — no
 * `Math.random`, no floats in state.
 */
export interface Rng {
  /** Uniform u32 in [0, 2^32). */
  nextU32(): number;
  /** Uniform float in [0, 1). Derived from `nextU32` — never `Math.random`. */
  nextFloat(): number;
  /** Uniform integer in [lo, hi] inclusive. */
  nextInt(lo: number, hi: number): number;
  /** True with probability `p` (0..1). */
  chance(p: number): boolean;
  /** A new independent stream derived from this one and a stable label. Does not advance `this`. */
  split(label: string): Rng;
  /** Serializable state for snapshots / time-travel. */
  state(): readonly [number, number, number, number];
}

export interface RngFactory {
  fromSeed(seed: number): Rng;
  fromState(state: readonly [number, number, number, number]): Rng;
}
