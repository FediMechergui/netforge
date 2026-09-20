/**
 * link/rf/mcs.ts — generation choice, MCS selection with hysteresis, rate, PER, bars, connect/drop thresholds and
 * a one-call link assessment (contracts/rf.ts MCS_TABLES, WIDTH_FACTOR_PCT, RF).
 *
 *  • Table: the best generation both radios support that is valid on the band (`BAND_GENERATIONS`).
 *  • MCS: the highest entry whose minSinrMdb ≤ SINR. With a current MCS, a downgrade applies at once and an
 *    upgrade needs SINR ≥ threshold + `RF.RATE_UPGRADE_MARGIN_MDB`.
 *  • Rate: floor(baseKbps20 × WIDTH_FACTOR_PCT / 100) × streams kbit/s.
 *  • PER: by whole-dB margin over the selected threshold (`RF.PER_BY_MARGIN_PERMILLE`); no MCS → 1000‰.
 * DETERMINISM: integers only; no Math.log10/pow/exp.
 */
import { MCS_TABLES, RF, WIDTH_FACTOR_PCT } from '../../contracts/rf.js';
import type { ChannelWidthMhz, McsEntry, RadioGeneration, RfBand } from '../../contracts/rf.js';
import { mdbToDb } from './log.js';
import { connectRssiMdb, noiseFloorMdb, pairRssi, sinrMdb } from './pathloss.js';
import type { PathLossClass, RadioEnd } from './pathloss.js';

/** Generations valid on each band, oldest first (the order used to pick the best common generation). */
export const BAND_GENERATIONS: Readonly<Record<RfBand, readonly RadioGeneration[]>> = Object.freeze({
  '2.4': Object.freeze(['b', 'g', 'n', 'ax']) as readonly RadioGeneration[],
  '5': Object.freeze(['n', 'ac', 'ax']) as readonly RadioGeneration[],
  '6': Object.freeze(['ax']) as readonly RadioGeneration[],
  '60': Object.freeze(['ad']) as readonly RadioGeneration[],
  cell: Object.freeze(['lte']) as readonly RadioGeneration[],
});

/** Signal bar count. */
export type Bars = 0 | 1 | 2 | 3 | 4;

/** Best generation valid on `band` that both radios support, or undefined when they share none. */
export function commonGeneration(
  band: RfBand,
  a: readonly RadioGeneration[],
  b: readonly RadioGeneration[],
): RadioGeneration | undefined {
  let best: RadioGeneration | undefined;
  for (const gen of BAND_GENERATIONS[band]) {
    if (a.includes(gen) && b.includes(gen)) best = gen;
  }
  return best;
}

/** Highest MCS whose minimum SINR is met, or undefined when SINR is below the lowest entry. */
export function selectMcs(table: readonly McsEntry[], sinr: number): McsEntry | undefined {
  let found: McsEntry | undefined;
  for (const entry of table) {
    if (entry.minSinrMdb <= sinr) found = entry;
  }
  return found;
}

/**
 * MCS with hysteresis. Without a current MCS (or one not in `table`) this is `selectMcs`. A lower target applies
 * at once; a higher one is taken only up to the highest entry whose threshold + upgrade margin ≤ SINR (never below
 * the current entry).
 */
export function selectMcsWithHysteresis(
  table: readonly McsEntry[],
  sinr: number,
  currentMcs: number | undefined,
): McsEntry | undefined {
  const target = selectMcs(table, sinr);
  if (currentMcs === undefined || target === undefined) return target;
  const currentIdx = table.findIndex((e) => e.mcs === currentMcs);
  const targetIdx = table.indexOf(target);
  if (currentIdx < 0 || targetIdx <= currentIdx) return target;
  let chosen = currentIdx;
  for (let i = currentIdx + 1; i <= targetIdx; i++) {
    const entry = table[i];
    if (entry !== undefined && entry.minSinrMdb + RF.RATE_UPGRADE_MARGIN_MDB <= sinr) chosen = i;
  }
  return table[chosen];
}

/** PHY rate in bit/s of an MCS entry at a channel width with `streams` spatial streams (at least 1). */
export function mcsRateBps(entry: McsEntry, widthMhz: ChannelWidthMhz, streams: number): number {
  const kbps = Math.floor((entry.baseKbps20 * WIDTH_FACTOR_PCT[widthMhz]) / 100);
  return kbps * Math.max(1, Math.floor(streams)) * 1000;
}

/** Packet error rate in permille for SINR over the selected entry (no entry → 1000). */
export function perPermille(entry: McsEntry | undefined, sinr: number): number {
  if (entry === undefined) return 1000;
  const marginDb = Math.floor((sinr - entry.minSinrMdb) / 1000);
  return RF.PER_BY_MARGIN_PERMILLE[marginDb] ?? 0;
}

/** Signal bars: one bar per `RF.BARS_MDB` threshold the RSSI meets. */
export function signalBars(rssi: number): Bars {
  let bars = 0;
  for (const threshold of RF.BARS_MDB) {
    if (rssi >= threshold) bars++;
  }
  return Math.min(bars, 4) as Bars;
}

/**
 * Loss percentage with a derived PER folded in: 100 − (100 − lossPct)(1000 − perMille)/1000, so the single
 * existing loss draw carries both (contracts/link.ts).
 */
export function foldPerIntoLossPct(lossPct: number, perMilleValue: number): number {
  const loss = Math.min(100, Math.max(0, lossPct));
  const per = Math.min(1000, Math.max(0, perMilleValue));
  return 100 - ((100 - loss) * (1000 - per)) / 1000;
}

/** A link may come up: RSSI ≥ the class connect threshold and SINR ≥ the lowest MCS threshold of `table`. */
export function meetsConnect(cls: PathLossClass, rssi: number, sinr: number, table: readonly McsEntry[]): boolean {
  const lowest = table[0];
  if (lowest === undefined) return false;
  return rssi >= connectRssiMdb(cls, lowest.minSinrMdb) && sinr >= lowest.minSinrMdb;
}

/**
 * An established link has fallen below the drop threshold: SINR < lowest MCS threshold − `SINR_DROP_MARGIN_MDB`,
 * or RSSI below `WIFI_DROP_RSSI_MDB` (wifi) / `PTP_DROP_RSSI_MDB` (ptp). Cellular drops on SINR alone.
 */
export function belowDrop(cls: PathLossClass, rssi: number, sinr: number, table: readonly McsEntry[]): boolean {
  const lowest = table[0];
  if (lowest === undefined) return true;
  if (sinr < lowest.minSinrMdb - RF.SINR_DROP_MARGIN_MDB) return true;
  if (cls === 'wifi') return rssi < RF.WIFI_DROP_RSSI_MDB;
  if (cls === 'ptp') return rssi < RF.PTP_DROP_RSSI_MDB;
  return false;
}

/** One radio end of an assessed link: power, gain and capabilities. */
export interface RfLinkEnd extends RadioEnd {
  readonly generations: readonly RadioGeneration[];
  readonly streams: number;
}

/** Input of `assessRfLink`. */
export interface RfLinkInput {
  readonly band: RfBand;
  readonly cls: PathLossClass;
  readonly widthMhz: ChannelWidthMhz;
  readonly distanceMm: number;
  readonly a: RfLinkEnd;
  readonly b: RfLinkEnd;
  /** Interference levels at the receiver (from `interferersMdb`), milli-dBm. */
  readonly interferersMdb?: readonly number[];
  /** MCS currently in use, for hysteresis. */
  readonly currentMcs?: number;
}

/** Result of `assessRfLink`: milli-dB values, rounded views and the selected MCS/rate/PER. */
export interface RfAssessment {
  readonly generation: RadioGeneration | undefined;
  readonly pathLossMdb: number;
  /** Decision RSSI min(a→b, b→a), milli-dBm. */
  readonly rssiMdb: number;
  readonly noiseMdb: number;
  readonly sinrMdb: number;
  readonly mcs: McsEntry | undefined;
  readonly rateBps: number;
  readonly perPermille: number;
  readonly bars: Bars;
  readonly rssiDbm: number;
  readonly snrDb: number;
  /** RSSI/SINR meet the connect thresholds. */
  readonly canConnect: boolean;
  /** RSSI/SINR are below the drop thresholds. */
  readonly belowDrop: boolean;
}

/** Full RF evaluation of a radio pair: path loss → RSSI → SINR → MCS (with hysteresis) → rate, PER, bars. */
export function assessRfLink(input: RfLinkInput): RfAssessment {
  const generation = commonGeneration(input.band, input.a.generations, input.b.generations);
  const table: readonly McsEntry[] = generation === undefined ? [] : MCS_TABLES[generation];
  const pair = pairRssi(input.a, input.b, input.band, input.distanceMm, input.cls);
  const noise = noiseFloorMdb(input.band, input.widthMhz);
  const sinr = sinrMdb(pair.rssiMdb, noise, input.interferersMdb ?? []);
  const mcs = selectMcsWithHysteresis(table, sinr, input.currentMcs);
  const streams = Math.min(input.a.streams, input.b.streams);
  const width: ChannelWidthMhz = input.band === '60' ? 2160 : input.band === 'cell' ? 20 : input.widthMhz;
  return {
    generation,
    pathLossMdb: pair.pathLossMdb,
    rssiMdb: pair.rssiMdb,
    noiseMdb: noise,
    sinrMdb: sinr,
    mcs,
    rateBps: mcs === undefined ? 0 : mcsRateBps(mcs, width, streams),
    perPermille: perPermille(mcs, sinr),
    bars: signalBars(pair.rssiMdb),
    rssiDbm: mdbToDb(pair.rssiMdb),
    snrDb: mdbToDb(sinr),
    canConnect: meetsConnect(input.cls, pair.rssiMdb, sinr, table),
    belowDrop: belowDrop(input.cls, pair.rssiMdb, sinr, table),
  };
}
