/**
 * link/rf/channels.ts — channel validity, widths, interference coupling, airtime contention and auto channel.
 *
 * Interference model (ARCHITECTURE-P1 D5):
 *  • Channels are compared by channel number on the same band (primary channel; wide channels are not expanded).
 *  • Co-channel radios hearing each other at or above `RF.CS_THRESHOLD_MDB` share airtime (contention) and do not
 *    add to the noise; weaker co-channel radios add their full RSSI as interference.
 *  • 2.4 GHz partial overlap (channel distance 1..4) adds RSSI − `RF.ACR_24_MDB[distance]`, only while the
 *    interfering BSS is loaded. Distance ≥ 5 and other bands' different channels never interfere.
 * Auto channel is deterministic: the lowest coupling score in `CHANNELS` order, ties to the earliest channel.
 */
import { CHANNELS, RF } from '../../contracts/rf.js';
import type { ChannelWidthMhz, RfBand } from '../../contracts/rf.js';
import { powerSumMdb } from './log.js';

/** Another radio as seen from a receiver: its band/channel, its RSSI at the receiver, and whether it carries traffic. */
export interface ChannelNeighbour {
  readonly band: RfBand;
  readonly channel: number;
  /** RSSI of the neighbour at the receiver, milli-dBm. */
  readonly rssiMdb: number;
  /** At least one associated station (partial-overlap interference counts only while loaded). */
  readonly loaded: boolean;
}

/** Widths allowed per band (60 GHz is always 2160 MHz; cellular uses the 20 MHz LTE table). */
export const BAND_WIDTHS: Readonly<Record<RfBand, readonly ChannelWidthMhz[]>> = Object.freeze({
  '2.4': Object.freeze([20, 40]) as readonly ChannelWidthMhz[],
  '5': Object.freeze([20, 40, 80, 160]) as readonly ChannelWidthMhz[],
  '6': Object.freeze([20, 40, 80, 160]) as readonly ChannelWidthMhz[],
  '60': Object.freeze([2160]) as readonly ChannelWidthMhz[],
  cell: Object.freeze([20]) as readonly ChannelWidthMhz[],
});

/** Valid channel numbers of a band in `CHANNELS` order (cellular has none). */
export function channelsOf(band: RfBand): readonly number[] {
  return band === 'cell' ? [] : CHANNELS[band];
}

/** True when `channel` is a valid channel number on `band`. */
export function isValidChannel(band: RfBand, channel: number): boolean {
  return channelsOf(band).includes(channel);
}

/** Default channel width of a band: 2160 MHz at 60 GHz, otherwise 20 MHz. */
export function defaultWidthMhz(band: RfBand): ChannelWidthMhz {
  return band === '60' ? 2160 : 20;
}

/** True when `widthMhz` is allowed on `band`. */
export function isValidWidth(band: RfBand, widthMhz: ChannelWidthMhz): boolean {
  return BAND_WIDTHS[band].includes(widthMhz);
}

/** Effective width on a band: the configured width when allowed, else the band default. */
export function effectiveWidthMhz(band: RfBand, widthMhz: ChannelWidthMhz): ChannelWidthMhz {
  return isValidWidth(band, widthMhz) ? widthMhz : defaultWidthMhz(band);
}

/** True when two radios share airtime: same band, same channel, and hearing each other at ≥ CS threshold. */
export function sharesAirtime(band: RfBand, channel: number, other: ChannelNeighbour): boolean {
  return other.band === band && other.channel === channel && other.rssiMdb >= RF.CS_THRESHOLD_MDB;
}

/**
 * Interference level (milli-dBm) a neighbour adds at a receiver on `band`/`channel`, or undefined when it adds
 * none (different band, contention instead of interference, idle partial overlap, or channels ≥ 5 apart).
 */
export function interferenceMdb(band: RfBand, channel: number, other: ChannelNeighbour): number | undefined {
  if (other.band !== band) return undefined;
  if (other.channel === channel) return other.rssiMdb >= RF.CS_THRESHOLD_MDB ? undefined : other.rssiMdb;
  if (band !== '2.4' || !other.loaded) return undefined;
  const distance = Math.abs(other.channel - channel);
  const rejection = RF.ACR_24_MDB[distance];
  return rejection === undefined ? undefined : other.rssiMdb - rejection;
}

/** Interference levels of every neighbour at a receiver, in neighbour order (for `sinrMdb`). */
export function interferersMdb(band: RfBand, channel: number, neighbours: readonly ChannelNeighbour[]): number[] {
  const out: number[] = [];
  for (const n of neighbours) {
    const level = interferenceMdb(band, channel, n);
    if (level !== undefined) out.push(level);
  }
  return out;
}

/**
 * Coupling score of a candidate channel for auto selection, milli-dBm: the power sum of every co-channel
 * neighbour's RSSI (contention and interference alike) and every loaded 2.4 GHz partial-overlap neighbour's
 * RSSI − ACR. Undefined when nothing couples (a quiet channel).
 */
export function channelScoreMdb(band: RfBand, channel: number, neighbours: readonly ChannelNeighbour[]): number | undefined {
  const levels: number[] = [];
  for (const n of neighbours) {
    if (n.band !== band) continue;
    if (n.channel === channel) {
      levels.push(n.rssiMdb);
      continue;
    }
    if (band !== '2.4' || !n.loaded) continue;
    const rejection = RF.ACR_24_MDB[Math.abs(n.channel - channel)];
    if (rejection !== undefined) levels.push(n.rssiMdb - rejection);
  }
  return levels.length === 0 ? undefined : powerSumMdb(levels);
}

/**
 * Auto channel: the channel of `band` with the lowest coupling score, scanning `CHANNELS` order; a quiet channel
 * beats any scored one and ties keep the earliest channel. Returns undefined for cellular (no channels).
 */
export function autoChannel(band: RfBand, neighbours: readonly ChannelNeighbour[]): number | undefined {
  let best: number | undefined;
  let bestScore: number | undefined;
  for (const channel of channelsOf(band)) {
    const score = channelScoreMdb(band, channel, neighbours);
    if (score === undefined) return channel;
    if (best === undefined || bestScore === undefined || score < bestScore) {
      best = channel;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Operating channel for configured settings: a valid configured number is used as is; 'auto' runs `autoChannel`;
 * an invalid number falls back to `defaultChannel` (or the band's first channel when that is invalid too).
 * Cellular returns 0.
 */
export function resolveChannel(
  band: RfBand,
  configured: number | 'auto',
  defaultChannel: number,
  neighbours: readonly ChannelNeighbour[],
): number {
  if (band === 'cell') return 0;
  if (configured === 'auto') return autoChannel(band, neighbours) ?? 0;
  if (isValidChannel(band, configured)) return configured;
  if (isValidChannel(band, defaultChannel)) return defaultChannel;
  return channelsOf(band)[0] ?? 0;
}
