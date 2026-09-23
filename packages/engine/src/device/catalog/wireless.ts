/**
 * device/catalog/wireless.ts — the Wireless palette category (docs/CATALOG.md "Network devices"; ARCHITECTURE-P1
 * D2, D3, D5).
 *
 * Access points bridge their wired uplink `GigabitEthernet0` (switched) with one `wireless-bss` radio per band
 * (`Wlan0` 2.4 GHz, `Wlan1` 5 GHz, `Wlan2` 6 GHz); eth-switch forwards between them (hairpin on the radios).
 * The wireless LAN controller is an end system with a host shell until controller behaviour arrives (P2).
 *
 * Radio figures are original teaching values chosen so that RSSI, not the hard cut-off, limits indoor range
 * (the cut-off `maxRangeM` sits beyond the distance where RSSI falls under `RF.WIFI_DROP_RSSI_MDB`).
 * All names, descriptions and tags are original wording (D13).
 */
import type { DeviceModel } from '../../contracts/device.js';
import type { RadioPortSpec } from '../../contracts/rf.js';
import { SPEED_100M, SPEED_10M, SPEED_1G } from '../../contracts/port.js';
import type { BuildStage, PoeSpec } from '../../contracts/catalog.js';
import { defineModel, type ModelInput, type PortInput } from './define.js';

/** Build stage the `*_MODELS` arrays of this file are defined for (the catalog index re-derives from the inputs). */
const DATA_STAGE: BuildStage = 'P2';

/** Speeds of a copper gigabit uplink, fastest first. */
const GIGABIT_SPEEDS: readonly number[] = [SPEED_1G, SPEED_100M, SPEED_10M];

/** An auto-MDIX gigabit copper port, optionally powered over the cable. */
function gigabitPort(name: string, poe?: PoeSpec): PortInput {
  return { name, kind: 'ethernet', speedBps: SPEED_1G, speeds: [...GIGABIT_SPEEDS], autoMdix: true, ...(poe ? { poe } : {}) };
}

/** A Wi-Fi radio port. */
function wlanPort(name: string, speedBps: number, radio: RadioPortSpec): PortInput {
  return { name, kind: 'wlan', speedBps, radio };
}

// ── radio profiles ───────────────────────────────────────────────────────────

/** Enterprise indoor 2.4 GHz access radio (802.11b/g/n, three streams). */
export const AP_RADIO_24: RadioPortSpec = {
  bands: ['2.4'],
  generations: ['b', 'g', 'n'],
  defaultBand: '2.4',
  defaultChannel: 1,
  maxTxPowerDbm: 20,
  antennaGainDbi: 4,
  streams: 3,
  maxWidthMhz: 40,
  maxRangeM: 400,
  maxBss: 16,
  maxClients: 200,
};

/** Enterprise indoor 5 GHz access radio (802.11n/ac, three streams). */
export const AP_RADIO_5: RadioPortSpec = {
  bands: ['5'],
  generations: ['n', 'ac'],
  defaultBand: '5',
  defaultChannel: 36,
  maxTxPowerDbm: 20,
  antennaGainDbi: 4,
  streams: 3,
  maxWidthMhz: 80,
  maxRangeM: 300,
  maxBss: 16,
  maxClients: 200,
};

/** Outdoor mesh 2.4 GHz radio: higher power and gain. */
export const MESH_RADIO_24: RadioPortSpec = {
  bands: ['2.4'],
  generations: ['b', 'g', 'n'],
  defaultBand: '2.4',
  defaultChannel: 6,
  maxTxPowerDbm: 23,
  antennaGainDbi: 8,
  streams: 2,
  maxWidthMhz: 40,
  maxRangeM: 600,
  maxBss: 16,
  maxClients: 100,
};

/** Outdoor mesh 5 GHz radio: higher power and gain. */
export const MESH_RADIO_5: RadioPortSpec = {
  bands: ['5'],
  generations: ['n', 'ac'],
  defaultBand: '5',
  defaultChannel: 149,
  maxTxPowerDbm: 23,
  antennaGainDbi: 8,
  streams: 2,
  maxWidthMhz: 80,
  maxRangeM: 500,
  maxBss: 16,
  maxClients: 100,
};

/** Wi-Fi 6 indoor 2.4 GHz radio (802.11b/g/n/ax, four streams). */
export const AX_RADIO_24: RadioPortSpec = {
  bands: ['2.4'],
  generations: ['b', 'g', 'n', 'ax'],
  defaultBand: '2.4',
  defaultChannel: 1,
  maxTxPowerDbm: 21,
  antennaGainDbi: 4,
  streams: 4,
  maxWidthMhz: 40,
  maxRangeM: 400,
  maxBss: 16,
  maxClients: 400,
};

/** Wi-Fi 6 indoor 5 GHz radio (802.11n/ac/ax, four streams, 160 MHz). */
export const AX_RADIO_5: RadioPortSpec = {
  bands: ['5'],
  generations: ['n', 'ac', 'ax'],
  defaultBand: '5',
  defaultChannel: 36,
  maxTxPowerDbm: 21,
  antennaGainDbi: 5,
  streams: 4,
  maxWidthMhz: 160,
  maxRangeM: 300,
  maxBss: 16,
  maxClients: 400,
};

/** Wi-Fi 6E indoor 6 GHz radio (802.11ax only, four streams, 160 MHz). */
export const AX_RADIO_6: RadioPortSpec = {
  bands: ['6'],
  generations: ['ax'],
  defaultBand: '6',
  defaultChannel: 5,
  maxTxPowerDbm: 20,
  antennaGainDbi: 5,
  streams: 4,
  maxWidthMhz: 160,
  maxRangeM: 250,
  maxBss: 16,
  maxClients: 400,
};

// ── models ───────────────────────────────────────────────────────────────────

/** NF-AP-2600: autonomous dual-band access point, powered over its uplink. */
export const NF_AP_2600_INPUT: ModelInput = {
  type: 'ap.nfap-auto',
  model: 'NF-AP-2600',
  description: 'Autonomous dual-band access point: a PoE-powered gigabit uplink and one radio each for 2.4 GHz and 5 GHz',
  category: 'wireless',
  icon: 'ap',
  family: 'nf-ap',
  variant: 'Dual-band autonomous',
  tags: ['wifi', 'access point', 'wlan', 'dual-band', 'poe'],
  capabilities: ['wifi-ap', 'poe-powered'],
  ports: [
    gigabitPort('GigabitEthernet0', { pd: { standard: 'at', drawW: 25.5 } }),
    wlanPort('Wlan0', 450_000_000, AP_RADIO_24),
    wlanPort('Wlan1', 1_300_000_000, AP_RADIO_5),
  ],
};

/** NF-AP-1832: lightweight access point that behaves autonomously until controllers arrive. */
export const NF_AP_1832_INPUT: ModelInput = {
  type: 'ap.nfap-lw',
  model: 'NF-AP-1832',
  description: 'Lightweight dual-band access point; it works on its own until wireless controllers are simulated',
  category: 'wireless',
  icon: 'ap',
  family: 'nf-ap',
  variant: 'Lightweight',
  tags: ['wifi', 'access point', 'wlan', 'lightweight', 'poe'],
  capabilities: ['wifi-ap', 'poe-powered'],
  ports: [
    gigabitPort('GigabitEthernet0', { pd: { standard: 'af', drawW: 13 } }),
    wlanPort('Wlan0', 450_000_000, AP_RADIO_24),
    wlanPort('Wlan1', 1_300_000_000, AP_RADIO_5),
  ],
};

/** NF-AP-1562: weatherproof outdoor mesh access point with a locally powered uplink. */
export const NF_AP_1562_INPUT: ModelInput = {
  type: 'ap.nfap-mesh',
  model: 'NF-AP-1562',
  description: 'Weatherproof outdoor mesh access point with high-gain 2.4 GHz and 5 GHz radios',
  category: 'wireless',
  icon: 'ap-outdoor',
  family: 'nf-ap',
  variant: 'Outdoor mesh',
  tags: ['wifi', 'access point', 'wlan', 'outdoor', 'mesh'],
  capabilities: ['wifi-ap'],
  ports: [
    gigabitPort('GigabitEthernet0'),
    wlanPort('Wlan0', 300_000_000, MESH_RADIO_24),
    wlanPort('Wlan1', 866_000_000, MESH_RADIO_5),
  ],
};

/** NF-AP-9120: tri-band Wi-Fi 6/6E access point. */
export const NF_AP_9120_INPUT: ModelInput = {
  type: 'ap.nfap-ax',
  model: 'NF-AP-9120',
  description: 'Tri-band Wi-Fi 6 and 6E access point with radios for 2.4 GHz, 5 GHz and 6 GHz',
  category: 'wireless',
  icon: 'ap',
  family: 'nf-ap',
  variant: 'Wi-Fi 6E tri-band',
  tags: ['wifi', 'access point', 'wlan', 'wifi 6', '6e', 'tri-band', 'poe'],
  capabilities: ['wifi-ap', 'poe-powered'],
  ports: [
    gigabitPort('GigabitEthernet0', { pd: { standard: 'bt', drawW: 30 } }),
    wlanPort('Wlan0', 600_000_000, AX_RADIO_24),
    wlanPort('Wlan1', 4_800_000_000, AX_RADIO_5),
    wlanPort('Wlan2', 4_800_000_000, AX_RADIO_6),
  ],
};

/** NF-WLC-3504: wireless LAN controller appliance; an end system until the controller plane arrives (P2). */
export const NF_WLC_3504_INPUT: ModelInput = {
  type: 'wlc.nfwlc3504',
  model: 'NF-WLC-3504',
  description: 'Wireless LAN controller appliance with four gigabit ports and a console; access point management arrives in a later release',
  category: 'wireless',
  icon: 'wlc',
  tags: ['wifi', 'controller', 'wlan', 'appliance'],
  capabilities: ['host'],
  ports: [
    gigabitPort('GigabitEthernet0/1'),
    gigabitPort('GigabitEthernet0/2'),
    gigabitPort('GigabitEthernet0/3'),
    gigabitPort('GigabitEthernet0/4'),
    { name: 'Console', kind: 'console', speedBps: 9_600 },
  ],
};

/** Wireless category inputs in palette order. */
export const WIRELESS_INPUTS: readonly ModelInput[] = Object.freeze([
  NF_AP_2600_INPUT,
  NF_AP_1832_INPUT,
  NF_AP_1562_INPUT,
  NF_AP_9120_INPUT,
  NF_WLC_3504_INPUT,
]);

/** Wireless category models (defined for stage P0.5), in palette order. */
export const WIRELESS_MODELS: readonly DeviceModel[] = Object.freeze(WIRELESS_INPUTS.map((input) => defineModel(input, DATA_STAGE)));
