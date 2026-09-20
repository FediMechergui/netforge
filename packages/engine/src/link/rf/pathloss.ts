/**
 * link/rf/pathloss.ts — distance, log-distance path loss, RSSI, noise floor, SINR and range (contracts/rf.ts).
 *
 *   PL(d)  = PL0(band) + (n10 / 10) · 10·log10(d_m), d_m ≥ 1   (+ 15 mdB/m oxygen absorption at 60 GHz)
 *   RSSI   = (Ptx + Gtx + Grx) · 1000 − PL                      (milli-dBm)
 *   SINR   = RSSI − powerSum(noise floor, interferers)
 * The RSSI of a pair used for association/link decisions is min(a→b, b→a).
 *
 * DETERMINISM: integer milli-dB; Math.sqrt (correctly rounded) only for canvas distances. No Math.log10/pow/exp.
 */
import { NOISE_FLOOR_MDB, RF } from '../../contracts/rf.js';
import type { ChannelWidthMhz, RadioMode, RfBand } from '../../contracts/rf.js';
import { divRound, powerSumMdb, tenLog10Udb } from './log.js';

/** Which path-loss exponent applies: Wi-Fi (AP/station), point-to-point bridges, or cellular. */
export type PathLossClass = keyof typeof RF.PATH_LOSS_EXP_X10;

/** Transmit/receive parameters of one radio end (integer dBm / dBi). */
export interface RadioEnd {
  readonly txPowerDbm: number;
  readonly antennaGainDbi: number;
}

/** Upper bound of the `rangeMetres` search when the radio has no hard cut-off, metres. */
export const RANGE_SEARCH_LIMIT_M = 1_000_000;

/** Path-loss class of a radio mode: ap/station → wifi, ptp → ptp, tower/ue → cell. */
export function pathLossClassOf(mode: RadioMode): PathLossClass {
  switch (mode) {
    case 'ap':
    case 'station':
      return 'wifi';
    case 'ptp':
      return 'ptp';
    case 'tower':
    case 'ue':
      return 'cell';
  }
}

/**
 * Distance in integer millimetres between two canvas points (integer canvas units) at `metresPerUnit`.
 * Rounded to the nearest millimetre; a non-finite or negative scale yields 0.
 */
export function canvasDistanceMm(dx: number, dy: number, metresPerUnit: number): number {
  if (!Number.isFinite(metresPerUnit) || metresPerUnit <= 0) return 0;
  const units = Math.sqrt(dx * dx + dy * dy);
  return Math.round(units * metresPerUnit * 1000);
}

/** Integer millimetres → metres (rounded), for `distanceM` views. */
export function mmToMetres(mm: number): number {
  return divRound(mm, 1000);
}

/**
 * Log-distance path loss in milli-dB for `distanceMm` on `band` with the exponent of `cls`.
 * Distances below 1 m are clamped to 1 m. 60 GHz adds oxygen absorption per metre (rounded).
 */
export function pathLossMdb(band: RfBand, distanceMm: number, cls: PathLossClass): number {
  const mm = Math.max(1000, Math.floor(distanceMm));
  // 10·log10(d_m) = 10·log10(d_mm) − 30 dB, in micro-dB.
  const tenLogMetresUdb = tenLog10Udb(mm) - 30_000_000;
  const n10 = RF.PATH_LOSS_EXP_X10[cls];
  let loss = RF.PL0_MDB[band] + divRound(n10 * tenLogMetresUdb, 10_000);
  if (band === '60') loss += divRound(RF.O2_LOSS_MDB_PER_M_60 * mm, 1000);
  return loss;
}

/** RSSI at the receiver in milli-dBm: (Ptx + Gtx + Grx) · 1000 − path loss. */
export function rssiMdb(tx: RadioEnd, rx: RadioEnd, pathLoss: number): number {
  return (tx.txPowerDbm + tx.antennaGainDbi + rx.antennaGainDbi) * 1000 - pathLoss;
}

/** Both directions of a radio pair and the decision RSSI min(a→b, b→a), milli-dBm. */
export interface PairRssi {
  readonly pathLossMdb: number;
  readonly aToBMdb: number;
  readonly bToAMdb: number;
  readonly rssiMdb: number;
}

/** RSSI of a radio pair at `distanceMm` (both directions and their minimum). */
export function pairRssi(a: RadioEnd, b: RadioEnd, band: RfBand, distanceMm: number, cls: PathLossClass): PairRssi {
  const pl = pathLossMdb(band, distanceMm, cls);
  const aToBMdb = rssiMdb(a, b, pl);
  const bToAMdb = rssiMdb(b, a, pl);
  return { pathLossMdb: pl, aToBMdb, bToAMdb, rssiMdb: Math.min(aToBMdb, bToAMdb) };
}

/**
 * Thermal noise floor in milli-dBm: cellular uses the LTE 20 MHz floor; 60 GHz always uses the 2160 MHz floor;
 * other bands use the configured channel width.
 */
export function noiseFloorMdb(band: RfBand, widthMhz: ChannelWidthMhz): number {
  if (band === 'cell') return RF.NOISE_LTE20_MDB;
  if (band === '60') return NOISE_FLOOR_MDB[2160];
  return NOISE_FLOOR_MDB[widthMhz];
}

/** SINR in milli-dB: RSSI − powerSum(noise floor, interferer levels). */
export function sinrMdb(rssi: number, noiseMdb: number, interferersMdb: readonly number[] = []): number {
  return rssi - (interferersMdb.length === 0 ? noiseMdb : powerSumMdb([noiseMdb, ...interferersMdb]));
}

/**
 * Minimum RSSI (milli-dBm) at which a link of this class may come up: Wi-Fi `WIFI_CONNECT_RSSI_MDB`, PtP
 * `PTP_CONNECT_RSSI_MDB`, cellular the LTE noise floor plus the lowest LTE MCS threshold (no RSSI constant exists
 * for cells, so the SINR threshold with no interference is used).
 */
export function connectRssiMdb(cls: PathLossClass, lowestMcsSinrMdb: number): number {
  if (cls === 'wifi') return RF.WIFI_CONNECT_RSSI_MDB;
  if (cls === 'ptp') return RF.PTP_CONNECT_RSSI_MDB;
  return RF.NOISE_LTE20_MDB + lowestMcsSinrMdb;
}

/**
 * Largest whole number of metres (≤ `maxRangeM`, or `RANGE_SEARCH_LIMIT_M` when absent) at which the pair's
 * decision RSSI is still ≥ `thresholdMdb`; 0 when even 1 m is below it. Binary search over a monotone path loss.
 */
export function rangeMetres(
  a: RadioEnd,
  b: RadioEnd,
  band: RfBand,
  cls: PathLossClass,
  thresholdMdb: number,
  maxRangeM?: number,
): number {
  const limit = Math.max(0, Math.floor(maxRangeM ?? RANGE_SEARCH_LIMIT_M));
  const ok = (m: number): boolean => pairRssi(a, b, band, m * 1000, cls).rssiMdb >= thresholdMdb;
  if (limit < 1 || !ok(1)) return 0;
  if (ok(limit)) return limit;
  let lo = 1;
  let hi = limit;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}
