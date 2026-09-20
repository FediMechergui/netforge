/**
 * Radio vocabulary and deterministic RF constants (spec §4.9; ARCHITECTURE-P1 D5, D12).
 *
 * DETERMINISM: the engine RF path (link/rf/*) uses INTEGER milli-dB arithmetic only: + - * /,
 * Math.floor, Math.sqrt (correctly rounded by ECMA-262) and Math.clz32. Math.log10 / Math.pow /
 * Math.exp are banned there (not guaranteed bit-identical across JS engines). Distances are integer
 * millimetres derived from integer canvas positions × `Topology.canvas.metresPerUnit`. The tables
 * below are committed constants: regenerating them changes RF goldens.
 *
 * Path loss (log-distance, dB): PL(d) = PL0(band) + (n10 / 10) · 10·log10(d_m) with d_m ≥ 1, plus a
 * 60 GHz oxygen term. RSSI = Ptx + Gtx + Grx − PL. SINR = RSSI − dbSum(noise floor, interferers).
 * The RSSI of a station↔AP pair used for association decisions is min(downlink, uplink).
 */
import type { MacAddress } from './addr.js';
import type { PortRef } from './ids.js';
import type { PortKind } from './port.js';
import type { PortRole } from './catalog.js';
import type { CellAttachState, WifiAssocState } from './medium.js';

export type RfBand = '2.4' | '5' | '6' | '60' | 'cell';
/** 802.11 generation (b/g/n/ac/ax, ad = 60 GHz) or the cellular table. */
export type RadioGeneration = 'b' | 'g' | 'n' | 'ac' | 'ax' | 'ad' | 'lte';
export type ChannelWidthMhz = 20 | 40 | 80 | 160 | 2160;
export type WifiSecurity = 'open' | 'wpa2-psk' | 'wpa3-sae';

/** What a radio port does, derived from its kind and effective role (never stored). */
export type RadioMode = 'ap' | 'station' | 'ptp' | 'tower' | 'ue';

/** Radio mode of a port, or undefined when the port is not a radio. */
export function radioModeOf(kind: PortKind, role: PortRole): RadioMode | undefined {
  if (kind === 'wlan') return role === 'wireless-bss' ? 'ap' : role === 'wireless-client' ? 'station' : undefined;
  if (kind === 'radio') return role === 'radio-ptp' ? 'ptp' : undefined;
  if (kind === 'cellular') return role === 'wireless-bss' ? 'tower' : role === 'cellular' ? 'ue' : undefined;
  return undefined;
}

/** Static radio capabilities of a wlan/radio/cellular port (`PortSpec.radio`, catalog data). */
export interface RadioPortSpec {
  readonly bands: readonly RfBand[];
  readonly generations: readonly RadioGeneration[];
  readonly defaultBand: RfBand;
  readonly defaultChannel: number;
  /** Integer dBm. */
  readonly maxTxPowerDbm: number;
  /** Integer dBi. */
  readonly antennaGainDbi: number;
  /** Spatial streams (rate multiplier). */
  readonly streams: number;
  readonly maxWidthMhz: ChannelWidthMhz;
  /** Hard range cut-off in metres regardless of RSSI (PtP 5 GHz 15 000, 60 GHz 1 000). */
  readonly maxRangeM: number;
  /** AP radios: max BSSs (P0.5 uses exactly one, BSS index 0; more are reserved). */
  readonly maxBss?: number;
  /** AP/tower: association limit (assoc-resp status 17 beyond it). */
  readonly maxClients?: number;
}

/**
 * Config-derived radio settings (`DeviceRuntime.radioSettings(port)`), rendered from the port's
 * `interface WlanN` / `interface Radio0` / `interface Cellular0` section. Canonical config lines
 * (cli/config-rules.ts; GUI panels write exactly these through `Simulation.configure`):
 *   ssid <rest>                      AP: advertised SSID / station: target SSID (absent = radio idle)
 *   security open|wpa2-psk|wpa3-sae  default open
 *   passphrase <rest>                secret token (masked below privilege 15, never in snapshots)
 *   band 2.4|5|6|60                  default RadioPortSpec.defaultBand
 *   channel <n>|auto                 default RadioPortSpec.defaultChannel
 *   channel-width 20|40|80|160       default 20 (60 GHz always 2160)
 *   tx-power <dBm>                   default RadioPortSpec.maxTxPowerDbm
 *   peer-key <rest>                  PtP pairing key (secret token)
 *   beacons                          extension: emit real beacon frames (default off)
 */
export interface RadioSettings {
  band: RfBand;
  channel: number | 'auto';
  widthMhz: ChannelWidthMhz;
  txPowerDbm: number;
  ssid?: string;
  security: WifiSecurity;
  /** Never exported in snapshots or trace. */
  passphrase?: string;
  /** PtP pairing key; never exported. */
  peerKey?: string;
  emitBeacons?: boolean;
  beaconIntervalMs?: number;
}

export interface McsEntry {
  readonly mcs: number;
  /** Minimum SINR for this MCS, milli-dB. */
  readonly minSinrMdb: number;
  /** Rate at 20 MHz, one spatial stream, kbit/s (60 GHz: the full 2160 MHz channel). */
  readonly baseKbps20: number;
}

function mcsRows(rows: readonly (readonly [baseKbps20: number, minSinrMdb: number])[], first = 0): readonly McsEntry[] {
  return Object.freeze(rows.map(([baseKbps20, minSinrMdb], i) => Object.freeze({ mcs: first + i, minSinrMdb, baseKbps20 })));
}

/**
 * Rate tables. Selection: the highest MCS whose minSinrMdb ≤ SINR, from the table of the lowest
 * common generation of the two radios. Rate = baseKbps20 × WIDTH_FACTOR_PCT[width] / 100 × min(streams).
 * Hysteresis: upgrade needs +RF.RATE_UPGRADE_MARGIN_MDB over the next threshold; downgrade at once.
 */
export const MCS_TABLES: Readonly<Record<RadioGeneration, readonly McsEntry[]>> = Object.freeze({
  b: mcsRows([[1000, 2000], [2000, 5000], [5500, 9000], [11000, 12000]]),
  g: mcsRows([[6000, 4000], [9000, 5000], [12000, 7000], [18000, 9000], [24000, 12000], [36000, 16000], [48000, 20000], [54000, 21000]]),
  n: mcsRows([[6500, 5000], [13000, 8000], [19500, 11000], [26000, 14000], [39000, 17000], [52000, 20000], [58500, 22000], [65000, 25000]]),
  ac: mcsRows([[6500, 5000], [13000, 8000], [19500, 11000], [26000, 14000], [39000, 17000], [52000, 20000], [58500, 22000], [65000, 25000], [78000, 29000], [86700, 31000]]),
  ax: mcsRows([[8600, 5000], [17200, 8000], [25800, 11000], [34400, 14000], [51600, 17000], [68800, 20000], [77400, 22000], [86000, 25000], [103200, 29000], [114700, 31000], [129000, 34000], [143400, 37000]]),
  ad: mcsRows([[385000, 1000], [770000, 3000], [1155000, 5000], [1540000, 8000], [2310000, 11000], [3080000, 14000], [3850000, 17000], [4620000, 20000]]),
  lte: mcsRows([[1500, -6000], [3000, -4000], [5000, -2000], [8000, 0], [12000, 2000], [18000, 4000], [25000, 6000], [33000, 8000], [42000, 10000], [52000, 12000], [63000, 14000], [75000, 16000], [88000, 18000], [100000, 19000], [110000, 20000]], 1),
});

/** Channel-width rate factor in percent (2160 MHz tables already carry the full rate). */
export const WIDTH_FACTOR_PCT: Readonly<Record<ChannelWidthMhz, number>> = Object.freeze({ 20: 100, 40: 207, 80: 450, 160: 900, 2160: 100 });

function range(first: number, last: number, step: number): readonly number[] {
  const out: number[] = [];
  for (let c = first; c <= last; c += step) out.push(c);
  return Object.freeze(out);
}

/** Valid channel numbers per Wi-Fi/PtP band (cellular has no user-selectable channel). */
export const CHANNELS: Readonly<Record<Exclude<RfBand, 'cell'>, readonly number[]>> = Object.freeze({
  '2.4': range(1, 13, 1),
  '5': Object.freeze([36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161, 165]),
  '6': range(1, 233, 4),
  '60': range(1, 4, 1),
});

/** Thermal noise floor per channel width, milli-dBm. */
export const NOISE_FLOOR_MDB: Readonly<Record<ChannelWidthMhz, number>> = Object.freeze({ 20: -95_000, 40: -92_000, 80: -89_000, 160: -86_000, 2160: -73_000 });

/** RF model constants (integer milli-dB / ns). */
export const RF = Object.freeze({
  /** PL0 at 1 m per band, milli-dB. */
  PL0_MDB: Object.freeze({ '2.4': 40_200, '5': 47_300, '6': 48_700, '60': 68_000, cell: 37_600 }) as Readonly<Record<RfBand, number>>,
  /** Path-loss exponent × 10. */
  PATH_LOSS_EXP_X10: Object.freeze({ wifi: 30, ptp: 20, cell: 35 }),
  /** 60 GHz oxygen absorption, milli-dB per metre. */
  O2_LOSS_MDB_PER_M_60: 15,
  NOISE_LTE20_MDB: -96_000,
  /** 2.4 GHz adjacent-channel rejection by channel distance 0..4 (≥5 → no interference), milli-dB. */
  ACR_24_MDB: Object.freeze([0, 3_000, 7_000, 15_000, 30_000]) as readonly number[],
  /** Radios hearing each other at or above this RSSI share airtime (co-channel contention). */
  CS_THRESHOLD_MDB: -82_000,
  WIFI_CONNECT_RSSI_MDB: -82_000,
  WIFI_DROP_RSSI_MDB: -86_000,
  SINR_DROP_MARGIN_MDB: 2_000,
  PTP_CONNECT_RSSI_MDB: -80_000,
  PTP_DROP_RSSI_MDB: -84_000,
  RATE_UPGRADE_MARGIN_MDB: 2_000,
  /** A below-threshold link survives this long before teardown (no flapping while dragging). */
  RF_HOLD_NS: 2_000_000_000,
  PTP_HOLD_NS: 1_000_000_000,
  /** Signal bars: RSSI ≥ each threshold adds a bar (≥ -82 → 1 … ≥ -55 → 4). */
  BARS_MDB: Object.freeze([-82_000, -75_000, -67_000, -55_000]) as readonly number[],
  /** Packet error rate by whole-dB margin above the selected MCS threshold (0, 1, 2 dB); ≥ 3 dB → 0. */
  PER_BY_MARGIN_PERMILLE: Object.freeze([100, 40, 10]) as readonly number[],
  OFDM_PREAMBLE_NS: 20_000,
  SLOT_NS: 9_000,
  SIFS_NS: 16_000,
  DIFS_NS: 34_000,
  CW_MIN: 15,
  CW_MAX: 1023,
  RETRY_LIMIT: 7,
  ACK_BYTES: 14,
  SCAN_DWELL_NS: 100_000_000,
  RESCAN_NS: 5_000_000_000,
  STEP_TIMEOUT_NS: 200_000_000,
  EAPOL_TIMEOUT_NS: 1_000_000_000,
  CELL_ATTACH_NS: 300_000_000,
});

/** Radio part of a PortSnapshot. NEVER contains passphrase or peer key. */
export interface RadioPortView {
  mode: RadioMode;
  band: RfBand;
  channel: number;
  widthMhz: ChannelWidthMhz;
  txPowerDbm: number;
  ssid?: string;
  /** AP: BSSID of BSS 0 (`bssidFor(port mac, 0)`); station: associated BSSID. */
  bssid?: MacAddress;
  security?: WifiSecurity;
  /** AP / tower: radio operating (admin up, powered, ssid set). */
  up: boolean;
  clients?: number;
  /** Station / UE. */
  state?: WifiAssocState | CellAttachState;
  peer?: PortRef;
  rssiDbm?: number;
  snrDb?: number;
  rateBps?: number;
  bars?: 0 | 1 | 2 | 3 | 4;
  /**
   * Distance at which RSSI crosses the connect threshold, capped at the radio's hard maxRangeM cut-off
   * (range ring radius = rangeM / metresPerUnit).
   */
  rangeM: number;
}

/** RF detail of a PtP radio link (`LinkState.radio`). */
export interface RadioLinkView {
  distanceM: number;
  distanceSource: 'canvas' | 'override';
  band: RfBand;
  channel: number;
  rssiDbm: number;
  snrDb: number;
  rateBps: number;
  bars: 0 | 1 | 2 | 3 | 4;
}
