/**
 * link/rf/log.ts — integer logarithm and decibel arithmetic for the RF model (ARCHITECTURE-P1 D5, D12, §5.4).
 *
 * DETERMINISM: only + - * /, Math.floor and Math.clz32 are used. Math.log10 / Math.pow / Math.exp are banned
 * here because they are not guaranteed bit-identical across JS engines. Both lookup tables below are COMMITTED
 * CONSTANTS (generated once offline); regenerating them changes every RF golden value.
 *
 * Units: `udB` = micro-dB (internal precision), `mdB` = milli-dB (the RF model unit).
 */

/** 10·log10(2) in micro-dB. */
export const TEN_LOG10_2_UDB = 3_010_300;

/** Number of steps per octave in `LOG_FRACTION_UDB`. */
const FRACTION_STEPS = 64;

/**
 * 10·log10(1 + i/64) in micro-dB for i = 0..64 (the fractional part of one octave).
 * Linear interpolation between entries is accurate to about 0.2 mdB.
 */
const LOG_FRACTION_UDB: readonly number[] = Object.freeze([
  0, 67334, 133640, 198948, 263289, 326691, 389181, 450784,
  511525, 571429, 630517, 688813, 746336, 803108, 859146, 914471,
  969100, 1023050, 1076339, 1128981, 1180993, 1232390, 1283185, 1333393,
  1383027, 1432100, 1480625, 1528614, 1576079, 1623030, 1669479, 1715436,
  1760913, 1805918, 1850461, 1894552, 1938200, 1981414, 2024202, 2066573,
  2108534, 2150093, 2191259, 2232038, 2272438, 2312465, 2352127, 2391430,
  2430380, 2468985, 2507249, 2545179, 2582780, 2620059, 2657020, 2693670,
  2730013, 2766054, 2801799, 2837251, 2872417, 2907300, 2941906, 2976237,
  3010300,
]);

/** Step of `POWER_SUM_OFFSET_UDB`, micro-dB (0.25 dB). */
const POWER_SUM_STEP_UDB = 250_000;

/**
 * 10·log10(1 + 10^(−d/10)) in micro-dB for d = 0, 0.25, … 40 dB: the amount added to the stronger of two
 * powers `d` dB apart when they are summed. Beyond 40 dB the offset is taken as 0 (< 0.5 mdB).
 */
const POWER_SUM_OFFSET_UDB: readonly number[] = Object.freeze([
  3010300, 2887099, 2767492, 2651470, 2539019, 2430118, 2324741, 2222856,
  2124426, 2029409, 1937759, 1849424, 1764349, 1682473, 1603736, 1528069,
  1455405, 1385671, 1318795, 1254700, 1193310, 1134548, 1078332, 1024586,
  973228, 924179, 877360, 832693, 790097, 749498, 710819, 673984,
  638920, 605557, 573822, 543649, 514969, 487720, 461836, 437258,
  413927, 391785, 370778, 350852, 331956, 314042, 297062, 280970,
  265724, 251281, 237602, 224648, 212384, 200774, 189784, 179384,
  169543, 160232, 151423, 143090, 135209, 127756, 120708, 114043,
  107742, 101785, 96154, 90831, 85800, 81045, 76551, 72304,
  68291, 64499, 60916, 57531, 54333, 51312, 48457, 45761,
  43214, 40808, 38535, 36388, 34361, 32446, 30637, 28929,
  27316, 25793, 24354, 22995, 21712, 20500, 19356, 18276,
  17255, 16292, 15382, 14523, 13712, 12946, 12223, 11540,
  10895, 10287, 9712, 9169, 8657, 8173, 7716, 7285,
  6878, 6493, 6130, 5788, 5464, 5159, 4870, 4598,
  4341, 4098, 3869, 3653, 3448, 3256, 3073, 2902,
  2739, 2586, 2442, 2305, 2176, 2054, 1939, 1831,
  1729, 1632, 1541, 1454, 1373, 1296, 1224, 1155,
  1091, 1030, 972, 918, 866, 818, 772, 729,
  688, 650, 613, 579, 547, 516, 487, 460,
  434,
]);

const TWO_POW_32 = 4_294_967_296;

/**
 * Integer division rounded half toward +∞ (`b` must be a positive integer).
 * Used everywhere a finer unit is folded into a coarser one (udB → mdB, mdB → dB).
 */
export function divRound(a: number, b: number): number {
  return Math.floor((2 * a + b) / (2 * b));
}

/**
 * 10·log10(x) in micro-dB for a positive integer `x` (non-integers are floored; values < 1 are treated as 1).
 * Octave from Math.clz32, fraction from the committed 64-step table with integer linear interpolation.
 */
export function tenLog10Udb(x: number): number {
  let v = Number.isFinite(x) ? Math.floor(x) : TWO_POW_32;
  if (v < 1) v = 1;
  let octaves = 0;
  while (v >= TWO_POW_32) {
    v = Math.floor(v / 2);
    octaves++;
  }
  const k = 31 - Math.clz32(v);
  const span = (1 << k) >>> 0;
  const scaled = (v - span) * FRACTION_STEPS;
  const idx = Math.floor(scaled / span);
  const rem = scaled - idx * span;
  const lo = LOG_FRACTION_UDB[idx] ?? 0;
  const hi = LOG_FRACTION_UDB[idx + 1] ?? lo;
  const fraction = lo + Math.floor(((hi - lo) * rem) / span);
  return (k + octaves) * TEN_LOG10_2_UDB + fraction;
}

/** 10·log10(x) in milli-dB (rounded) for a positive integer `x`. */
export function tenLog10Mdb(x: number): number {
  return divRound(tenLog10Udb(x), 1000);
}

/** Offset added to the stronger of two powers `diffUdb` (≥ 0) micro-dB apart when summing them, micro-dB. */
function powerSumOffsetUdb(diffUdb: number): number {
  const d = diffUdb < 0 ? -diffUdb : diffUdb;
  const idx = Math.floor(d / POWER_SUM_STEP_UDB);
  const last = POWER_SUM_OFFSET_UDB.length - 1;
  if (idx >= last) return 0;
  const lo = POWER_SUM_OFFSET_UDB[idx] ?? 0;
  const hi = POWER_SUM_OFFSET_UDB[idx + 1] ?? 0;
  const rem = d - idx * POWER_SUM_STEP_UDB;
  return lo + Math.floor(((hi - lo) * rem) / POWER_SUM_STEP_UDB);
}

/**
 * Power sum of levels given in milli-dB(m): 10·log10(Σ 10^(Lᵢ/10)), in milli-dB(m), rounded.
 * Levels are folded strongest first (explicit descending sort) so the result is independent of input order.
 * Throws RangeError on an empty list (a sum of no powers has no level).
 */
export function powerSumMdb(levelsMdb: readonly number[]): number {
  if (levelsMdb.length === 0) throw new RangeError('powerSumMdb needs at least one level');
  const sorted = [...levelsMdb].sort((a, b) => b - a);
  let accUdb = (sorted[0] ?? 0) * 1000;
  for (let i = 1; i < sorted.length; i++) {
    const levelUdb = (sorted[i] ?? 0) * 1000;
    accUdb += powerSumOffsetUdb(accUdb - levelUdb);
  }
  return divRound(accUdb, 1000);
}

/** Milli-dB → whole dB (rounded half toward +∞), for views such as `rssiDbm` / `snrDb`. */
export function mdbToDb(mdb: number): number {
  return divRound(mdb, 1000);
}

/** Whole dB(m) → milli-dB(m). */
export function dbToMdb(db: number): number {
  return Math.round(db) * 1000;
}
