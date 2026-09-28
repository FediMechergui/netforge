/**
 * device/catalog/wireless.ts — the Wireless palette category (docs/CATALOG.md "Network devices"; ARCHITECTURE-P1
 * D2, D3, D5; ARCHITECTURE-P2 D17, §7 W6 catalog).
 *
 * Access points bridge their wired uplink `GigabitEthernet0` (switched) with one `wireless-bss` radio per band
 * (`Wlan0` 2.4 GHz, `Wlan1` 5 GHz, `Wlan2` 6 GHz); eth-switch forwards between them (hairpin on the radios).
 *
 * P2 (the W6 catalog item): NF-AP-1832 is the lightweight access point (`lightweight-ap`). define.ts derives its P2
 * profile lines (`capwap enable`, `interface Vlan1` / ` ip address dhcp` / ` no shutdown`), so in a P2 world it takes
 * an address by DHCP and joins a controller; in a P1 world nothing is replayed and it works on its own, silent
 * (capwap-wtp needs `capwap enable`). NF-WLC-9800 is the wireless LAN controller appliance (`wireless-controller`):
 * a GUI appliance (no shell, the NFOS grammar for headless configure), four distribution ports that are intrinsic
 * trunks, and the automatic tunnel port `Capwap0` (define.ts derives the shell, the `wlc.controller` panel and the
 * Vlan and tunnel families from the capability). NF-WLC-3504 stays the end system with a host shell that P1 files
 * placed; the palette shows it in the Legacy category (its input stays in this file: the catalog index orders the
 * palette by category).
 *
 * Radio figures are original teaching values chosen so that RSSI, not the hard cut-off, limits indoor range
 * (the cut-off `maxRangeM` sits beyond the distance where RSSI falls under `RF.WIFI_DROP_RSSI_MDB`).
 * All names, descriptions and tags are original wording (D13).
 */
import type { DeviceModel } from '../../contracts/device.js';
import type { RadioPortSpec } from '../../contracts/rf.js';
import { SPEED_100M, SPEED_10M, SPEED_1G } from '../../contracts/port.js';
import type { BuildStage, PoeSpec } from '../../contracts/catalog.js';
import { SEC } from '../../contracts/time.js';
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

/** NF-AP-1832: lightweight access point; it joins a wireless LAN controller over CAPWAP (ARCHITECTURE-P2 D17). */
export const NF_AP_1832_INPUT: ModelInput = {
  type: 'ap.nfap-lw',
  model: 'NF-AP-1832',
  description: 'Lightweight dual-band access point that joins a wireless LAN controller over CAPWAP; with CAPWAP turned off it works on its own',
  category: 'wireless',
  icon: 'ap',
  family: 'nf-ap',
  variant: 'Lightweight',
  tags: ['wifi', 'access point', 'wlan', 'lightweight', 'poe'],
  capabilities: ['wifi-ap', 'poe-powered', 'lightweight-ap'],
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

/** The controller's console port. */
function consolePort(): PortInput {
  return { name: 'Console', kind: 'console', speedBps: 9_600 };
}

/**
 * NF-WLC-9800: the wireless LAN controller appliance (ARCHITECTURE-P2 D17, §3.12, §7 W6 catalog). `wireless-controller`
 * implies `switching`, so it derives eth-switch, vlan, arp, ipv4, icmpv4, host, udp and capwap-ac; no shell (the
 * `wlc.controller` panel writes its lines through `configure`); four distribution ports (intrinsic 802.1Q trunks, one
 * active at a time), a console and the automatic `Capwap0`; no `defaultConfig` (it answers only once its management
 * interface has an address, §4.3).
 */
export const NF_WLC_9800_INPUT: ModelInput = {
  type: 'wlc.nfwlc9800',
  model: 'NF-WLC-9800',
  description: 'Wireless LAN controller appliance: lightweight access points join it over CAPWAP and it switches their client traffic into VLANs',
  category: 'wireless',
  icon: 'wlc',
  tags: ['wifi', 'controller', 'wlan', 'appliance', 'capwap', 'lightweight'],
  capabilities: ['wireless-controller'],
  ports: [
    gigabitPort('GigabitEthernet0/1'),
    gigabitPort('GigabitEthernet0/2'),
    gigabitPort('GigabitEthernet0/3'),
    gigabitPort('GigabitEthernet0/4'),
    consolePort(),
  ],
};

/**
 * NF-WLC-3504: the controller model of P1 files, kept as the end system they placed (ARCHITECTURE-P2 D17): the
 * palette shows it in the Legacy category; its capabilities, shell, panels, ports and boot time are unchanged (the
 * boot time is pinned to the Wireless category's, which the Legacy category would otherwise shorten).
 */
export const NF_WLC_3504_INPUT: ModelInput = {
  type: 'wlc.nfwlc3504',
  model: 'NF-WLC-3504',
  description: 'Earlier wireless LAN controller kept for older projects: an end system with four gigabit ports and a console that manages no access points (the NF-WLC-9800 does)',
  category: 'legacy',
  icon: 'wlc',
  tags: ['wifi', 'controller', 'wlan', 'appliance'],
  capabilities: ['host'],
  // the Wireless category's boot time (define.ts CATEGORY_BOOT_NS.wireless), as a literal: no module-scope read of
  // another catalog module (rule 12)
  bootNs: 20 * SEC,
  ports: [
    gigabitPort('GigabitEthernet0/1'),
    gigabitPort('GigabitEthernet0/2'),
    gigabitPort('GigabitEthernet0/3'),
    gigabitPort('GigabitEthernet0/4'),
    consolePort(),
  ],
};

/**
 * The inputs of this file in palette order: the Wireless category, then NF-WLC-3504, which the palette shows in the
 * Legacy category (the catalog index orders every input by category, keeping file order inside one).
 */
export const WIRELESS_INPUTS: readonly ModelInput[] = Object.freeze([
  NF_AP_2600_INPUT,
  NF_AP_1832_INPUT,
  NF_AP_1562_INPUT,
  NF_AP_9120_INPUT,
  NF_WLC_9800_INPUT,
  NF_WLC_3504_INPUT,
]);

/** The models of this file (defined for DATA_STAGE), in WIRELESS_INPUTS order. */
export const WIRELESS_MODELS: readonly DeviceModel[] = Object.freeze(WIRELESS_INPUTS.map((input) => defineModel(input, DATA_STAGE)));
