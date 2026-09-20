/**
 * sim/ids.ts — deterministic identifier generation for the Simulation facade (spec §4.2 G4,
 * §13.2 stable ids).
 *
 * Device and link ids are stable strings that survive a `.netforge` round-trip. They are
 * produced by a plain counter (never by wall time or randomness), rendered as a prefix, an
 * underscore and a zero-padded lowercase hex number: `d_0001`, `d_0002`, … `l_000a`.
 * Numbers wider than the padding simply grow (`d_10000`).
 */

/** A counter-based id generator. */
export interface IdGen {
  /** The next id; advances the counter. */
  next(): string;
  /** Number of ids handed out so far. */
  readonly issued: number;
}

/** Default number of hex digits in a generated id. */
export const ID_HEX_WIDTH = 4;

/**
 * Create a generator yielding `${prefix}_0001`, `${prefix}_0002`, … (hex, zero-padded to
 * `width` digits). Two generators with the same prefix produce the same sequence.
 */
export function createIdGen(prefix: string, width: number = ID_HEX_WIDTH): IdGen {
  if (prefix === '') throw new RangeError('id prefix must not be empty');
  if (!Number.isInteger(width) || width < 1) throw new RangeError(`id width must be a positive integer, got ${width}`);
  let issued = 0;
  return {
    next(): string {
      issued++;
      return `${prefix}_${issued.toString(16).padStart(width, '0')}`;
    },
    get issued(): number {
      return issued;
    },
  };
}
