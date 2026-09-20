/**
 * device/catalog/radios.ts — the Radios palette category: point-to-point radio bridges and the cellular tower
 * (docs/CATALOG.md "Network devices"; ARCHITECTURE-P1 D3, D5, §3.7, §3.8).
 *
 * A radio bridge has `GigabitEthernet0` (switched) and `Radio0` (radio-ptp), bridged by eth-switch so the two
 * wired LANs join across the PtP link (§3.7). The tower bridges `Cellular0` (wireless-bss, hairpin: one
 * multipoint access radio) with its `GigabitEthernet0` backhaul (§3.8).
 *
 * Link budgets (original teaching values, checked in device.catalog.wireless-wan.test.ts):
 *   NF-RADIO-PTP5  at 10 km on 5 GHz: EIRP 27+23 dBm, RSSI about −54 dBm, well above RF.PTP_CONNECT_RSSI_MDB;
 *                  hard cut-off 15 km.
 *   NF-RADIO-PTP60 at 1 km on 60 GHz (oxygen loss included): RSSI about −66 dBm, SINR above the lowest 802.11ad
 *                  threshold; hard cut-off 1 km, so 1.5 km is out of range.
 * All names, descriptions and tags are original wording (D13).
 */
import type { DeviceModel } from '../../contracts/device.js';
import type { RadioPortSpec } from '../../contracts/rf.js';
import { SPEED_100M, SPEED_10M, SPEED_1G } from '../../contracts/port.js';
import type { BuildStage } from '../../contracts/catalog.js';
import { defineModel, type ModelInput, type PortInput } from './define.js';

/** Build stage the `*_MODELS` arrays of this file are defined for (the catalog index re-derives from the inputs). */
const DATA_STAGE: BuildStage = 'P1';

/** Speeds of a copper gigabit port, fastest first. */
const GIGABIT_SPEEDS: readonly number[] = [SPEED_1G, SPEED_100M, SPEED_10M];

/** The auto-MDIX gigabit copper port of a radio unit. */
function gigabitPort(name: string): PortInput {
  return { name, kind: 'ethernet', speedBps: SPEED_1G, speeds: [...GIGABIT_SPEEDS], autoMdix: true };
}

// ── radio profiles ───────────────────────────────────────────────────────────

/** 5 GHz outdoor point-to-point radio with a high-gain dish (802.11n/ac, two streams, up to 15 km). */
export const PTP5_RADIO: RadioPortSpec = {
  bands: ['5'],
  generations: ['n', 'ac'],
  defaultBand: '5',
  defaultChannel: 149,
  maxTxPowerDbm: 27,
  antennaGainDbi: 23,
  streams: 2,
  maxWidthMhz: 80,
  maxRangeM: 15_000,
};

/** 60 GHz short-range high-capacity radio with a narrow-beam antenna (802.11ad, up to 1 km). */
export const PTP60_RADIO: RadioPortSpec = {
  bands: ['60'],
  generations: ['ad'],
  defaultBand: '60',
  defaultChannel: 2,
  maxTxPowerDbm: 16,
  antennaGainDbi: 30,
  streams: 1,
  maxWidthMhz: 2160,
  maxRangeM: 1_000,
};

/** Cellular base-station access radio (LTE table, two streams). */
export const TOWER_RADIO: RadioPortSpec = {
  bands: ['cell'],
  generations: ['lte'],
  defaultBand: 'cell',
  defaultChannel: 1,
  maxTxPowerDbm: 43,
  antennaGainDbi: 18,
  streams: 2,
  maxWidthMhz: 20,
  maxRangeM: 10_000,
  maxClients: 256,
};

// ── models ───────────────────────────────────────────────────────────────────

/** NF-RADIO-PTP5: 5 GHz outdoor point-to-point bridge. */
export const NF_RADIO_PTP5_INPUT: ModelInput = {
  type: 'radio.nfptp5',
  model: 'NF-RADIO-PTP5',
  description: 'Outdoor 5 GHz point-to-point radio bridge that joins two wired networks up to 15 km apart',
  category: 'radios',
  icon: 'radio-ptp',
  family: 'nf-radio-ptp',
  variant: '5 GHz long range',
  tags: ['radio', 'point-to-point', 'wireless bridge', 'backhaul', 'outdoor', '5 ghz'],
  capabilities: ['radio-bridge'],
  ports: [gigabitPort('GigabitEthernet0'), { name: 'Radio0', kind: 'radio', speedBps: 866_000_000, radio: PTP5_RADIO }],
};

/** NF-RADIO-PTP60: 60 GHz short-range high-capacity bridge. */
export const NF_RADIO_PTP60_INPUT: ModelInput = {
  type: 'radio.nfptp60',
  model: 'NF-RADIO-PTP60',
  description: 'Short-range 60 GHz point-to-point radio bridge with multi-gigabit capacity over at most 1 km',
  category: 'radios',
  icon: 'radio-ptp',
  family: 'nf-radio-ptp',
  variant: '60 GHz high capacity',
  tags: ['radio', 'point-to-point', 'wireless bridge', 'backhaul', 'millimetre wave', '60 ghz'],
  capabilities: ['radio-bridge'],
  ports: [gigabitPort('GigabitEthernet0'), { name: 'Radio0', kind: 'radio', speedBps: 4_620_000_000, radio: PTP60_RADIO }],
};

/** NF-CELL-TOWER: cellular base station with an Ethernet backhaul. */
export const NF_CELL_TOWER_INPUT: ModelInput = {
  type: 'cell.nftower',
  model: 'NF-CELL-TOWER',
  description: 'Cellular base station that serves phones and tablets in range and bridges them to its wired backhaul',
  category: 'radios',
  icon: 'cell-tower',
  tags: ['cellular', 'mobile network', 'base station', 'lte', '5g', 'tower'],
  capabilities: ['cellular-cell'],
  ports: [
    { ...gigabitPort('GigabitEthernet0'), group: 'uplink' },
    { name: 'Cellular0', kind: 'cellular', speedBps: 300_000_000, radio: TOWER_RADIO },
  ],
};

/** Radios category inputs in palette order. */
export const RADIO_INPUTS: readonly ModelInput[] = Object.freeze([NF_RADIO_PTP5_INPUT, NF_RADIO_PTP60_INPUT, NF_CELL_TOWER_INPUT]);

/** Radios category models (defined for stage P0.5), in palette order. */
export const RADIO_MODELS: readonly DeviceModel[] = Object.freeze(RADIO_INPUTS.map((input) => defineModel(input, DATA_STAGE)));
