/**
 * device/catalog/home.ts — the Home & SOHO network devices (docs/CATALOG.md "Network devices"; ARCHITECTURE-P1 D3,
 * D9).
 *
 * A home router combines a routed WAN port, a four-port LAN switch and Wi-Fi access radios (D3):
 *   `Internet`            role `wan` (MDI, not auto-MDIX: the classic uplink lesson),
 *   `GigabitEthernet1–4`  role `switched` (auto-MDIX),
 *   `Wlan0/1(/2)`         role `wireless-bss`, bridged with the LAN ports by eth-switch,
 *   auto `Vlan1`          the LAN SVI that routes towards the WAN (derived HOME_ROUTER_VLAN_FAMILY, starts up).
 * It is a GUI-only appliance: shell `none` with the `nfos` grammar for headless configure (D9).
 * The Home & SOHO end devices (smart TV) are catalog data of the end-device files.
 * Radio figures and all wording are original (D13).
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

/** A gigabit copper port. */
function gigabitPort(name: string, autoMdix: boolean): PortInput {
  return { name, kind: 'ethernet', speedBps: SPEED_1G, speeds: [...GIGABIT_SPEEDS], autoMdix };
}

/** The routed WAN port (`Internet`, short `Inet`). */
function internetPort(): PortInput {
  return { ...gigabitPort('Internet', false), role: 'wan', group: 'uplink' };
}

/** The four LAN switch ports `GigabitEthernet1`–`GigabitEthernet4`. */
function lanPorts(): PortInput[] {
  return [1, 2, 3, 4].map((n) => gigabitPort(`GigabitEthernet${n}`, true));
}

/** A Wi-Fi radio port. */
function wlanPort(name: string, speedBps: number, radio: RadioPortSpec): PortInput {
  return { name, kind: 'wlan', speedBps, radio };
}

// ── radio profiles ───────────────────────────────────────────────────────────

/** Home Wi-Fi 5 router, 2.4 GHz radio (802.11b/g/n). */
export const HOME_RADIO_24: RadioPortSpec = {
  bands: ['2.4'],
  generations: ['b', 'g', 'n'],
  defaultBand: '2.4',
  defaultChannel: 1,
  maxTxPowerDbm: 20,
  antennaGainDbi: 3,
  streams: 2,
  maxWidthMhz: 40,
  maxRangeM: 300,
  maxBss: 4,
  maxClients: 32,
};

/** Home Wi-Fi 5 router, 5 GHz radio (802.11n/ac). */
export const HOME_RADIO_5: RadioPortSpec = {
  bands: ['5'],
  generations: ['n', 'ac'],
  defaultBand: '5',
  defaultChannel: 36,
  maxTxPowerDbm: 20,
  antennaGainDbi: 3,
  streams: 2,
  maxWidthMhz: 80,
  maxRangeM: 250,
  maxBss: 4,
  maxClients: 32,
};

/** Home Wi-Fi 6 router, 2.4 GHz radio (802.11b/g/n/ax). */
export const HOME_AX_RADIO_24: RadioPortSpec = {
  bands: ['2.4'],
  generations: ['b', 'g', 'n', 'ax'],
  defaultBand: '2.4',
  defaultChannel: 1,
  maxTxPowerDbm: 20,
  antennaGainDbi: 4,
  streams: 2,
  maxWidthMhz: 40,
  maxRangeM: 300,
  maxBss: 4,
  maxClients: 64,
};

/** Home Wi-Fi 6 router, 5 GHz radio (802.11n/ac/ax). */
export const HOME_AX_RADIO_5: RadioPortSpec = {
  bands: ['5'],
  generations: ['n', 'ac', 'ax'],
  defaultBand: '5',
  defaultChannel: 36,
  maxTxPowerDbm: 20,
  antennaGainDbi: 4,
  streams: 4,
  maxWidthMhz: 160,
  maxRangeM: 250,
  maxBss: 4,
  maxClients: 64,
};

/** Home Wi-Fi 6E router, 6 GHz radio (802.11ax only). */
export const HOME_AX_RADIO_6: RadioPortSpec = {
  bands: ['6'],
  generations: ['ax'],
  defaultBand: '6',
  defaultChannel: 5,
  maxTxPowerDbm: 18,
  antennaGainDbi: 4,
  streams: 2,
  maxWidthMhz: 160,
  maxRangeM: 200,
  maxBss: 4,
  maxClients: 64,
};

// ── models ───────────────────────────────────────────────────────────────────

/** Capabilities of every home router: LAN switch, WAN routing, Wi-Fi access, DHCP service and translation. */
const HOME_ROUTER_CAPABILITIES = ['wifi-ap', 'switching', 'routing', 'dhcp-server', 'nat-gateway'] as const;

/** NF-HOMEROUTER: home wireless router (Wi-Fi 5, dual band). */
export const NF_HOMEROUTER_INPUT: ModelInput = {
  type: 'wrouter.nfhome',
  model: 'NF-HOMEROUTER',
  description: 'Home wireless router: an Internet port, a four-port gigabit LAN switch and dual-band Wi-Fi, set up from its settings panel',
  category: 'home-soho',
  icon: 'home-router',
  family: 'nf-homerouter',
  variant: 'Wi-Fi 5 dual-band',
  tags: ['home', 'soho', 'wireless router', 'wifi', 'dhcp', 'gateway'],
  capabilities: [...HOME_ROUTER_CAPABILITIES],
  ports: [
    internetPort(),
    ...lanPorts(),
    wlanPort('Wlan0', 300_000_000, HOME_RADIO_24),
    wlanPort('Wlan1', 866_000_000, HOME_RADIO_5),
  ],
};

/** NF-HOMEROUTER-AX: Wi-Fi 6 home router with an extra 6 GHz radio. */
export const NF_HOMEROUTER_AX_INPUT: ModelInput = {
  type: 'wrouter.nfhome-ax',
  model: 'NF-HOMEROUTER-AX',
  description: 'Wi-Fi 6 home router: an Internet port, a four-port gigabit LAN switch and radios for 2.4 GHz, 5 GHz and 6 GHz',
  category: 'home-soho',
  icon: 'home-router',
  family: 'nf-homerouter',
  variant: 'Wi-Fi 6 tri-band',
  tags: ['home', 'soho', 'wireless router', 'wifi', 'wifi 6', 'dhcp', 'gateway'],
  capabilities: [...HOME_ROUTER_CAPABILITIES],
  ports: [
    internetPort(),
    ...lanPorts(),
    wlanPort('Wlan0', 574_000_000, HOME_AX_RADIO_24),
    wlanPort('Wlan1', 2_400_000_000, HOME_AX_RADIO_5),
    wlanPort('Wlan2', 1_200_000_000, HOME_AX_RADIO_6),
  ],
};

/** Home & SOHO network-device inputs in palette order. */
export const HOME_INPUTS: readonly ModelInput[] = Object.freeze([NF_HOMEROUTER_INPUT, NF_HOMEROUTER_AX_INPUT]);

/** Home & SOHO network-device models (defined for stage P0.5), in palette order. */
export const HOME_MODELS: readonly DeviceModel[] = Object.freeze(HOME_INPUTS.map((input) => defineModel(input, DATA_STAGE)));
