/**
 * Simulation time (spec §4.2).
 *
 * `SimTime` is an INTEGER number of nanoseconds since scenario epoch 0, stored
 * in a JS `number`. Doubles represent every integer exactly up to 2^53, which
 * is ~104 days of simulated time — far beyond any lab. Every module MUST keep
 * SimTime integral: use `Math.round`/`Math.floor` after any division and never
 * store fractional ns. (Nanosecond resolution matters: a 64-byte frame on a
 * 10 Gbps link serialises in 51.2 ns.)
 *
 * Wall-clock time NEVER enters the engine. `Date.now()`, `performance.now()`
 * and `Math.random()` are banned inside `packages/engine` (determinism, G4).
 */
export type SimTime = number;

export const NS = 1;
export const US = 1_000;
export const MS = 1_000_000;
export const SEC = 1_000_000_000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;

export const MAX_SIM_TIME: SimTime = Number.MAX_SAFE_INTEGER;

export function assertSimTime(t: SimTime, what = 'SimTime'): void {
  if (!Number.isInteger(t) || t < 0 || t > MAX_SIM_TIME) {
    throw new RangeError(`${what} must be a non-negative integer ns, got ${t}`);
  }
}

/** `00:01:23.456789` — hours:minutes:seconds.microseconds */
export function formatSimTime(t: SimTime): string {
  const totalUs = Math.floor(t / US);
  const us = totalUs % 1_000_000;
  const totalS = Math.floor(totalUs / 1_000_000);
  const s = totalS % 60;
  const m = Math.floor(totalS / 60) % 60;
  const h = Math.floor(totalS / 3600);
  const pad = (n: number, w: number) => n.toString().padStart(w, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(us, 6)}`;
}

/** Serialization delay of `bytes` on a link of `bps`, rounded up to whole ns. */
export function serializationNs(bytes: number, bps: number): SimTime {
  if (bps <= 0) throw new RangeError('bps must be > 0');
  return Math.ceil((bytes * 8 * SEC) / bps);
}

/** Speed of light in vacuum, m/s. */
export const C_LIGHT = 299_792_458;

/** Propagation delay over `lengthM` metres at `velocityFactor`·c, rounded up to whole ns. */
export function propagationNs(lengthM: number, velocityFactor: number): SimTime {
  if (lengthM < 0) throw new RangeError('length must be >= 0');
  return Math.ceil((lengthM / (velocityFactor * C_LIGHT)) * SEC);
}
