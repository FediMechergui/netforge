/**
 * device/catalog/peripherals.ts — networked appliances: the Peripherals category (NF-PRINTER) and the smart
 * television, which docs/CATALOG.md lists among the end devices but files under the Home & SOHO palette category
 * (ARCHITECTURE-P1 D2). Both are hosts with a fast-ethernet adapter and a Wi-Fi client radio.
 * All wording is original (D13).
 */
import type { DeviceModel } from '../../contracts/device.js';
import { SPEED_100M } from '../../contracts/port.js';
import type { ModelInput } from './define.js';
import { defineModel } from './define.js';
import { END_DEVICE_STAGE, WIFI5_APPLIANCE_RADIO, hostEth, wlanClient } from './computers.js';

/** NF-PRINTER — network printer with wired and wireless adapters. */
export const NF_PRINTER_MODEL_INPUT: ModelInput = {
  type: 'printer.nfprinter',
  model: 'NF-PRINTER',
  description: 'Network printer with a fast-ethernet adapter and a dual-band wireless adapter',
  category: 'peripherals',
  icon: 'printer',
  capabilities: ['host', 'wifi-client'],
  ports: [hostEth('FastEthernet0', SPEED_100M), wlanClient('Wlan0', WIFI5_APPLIANCE_RADIO)],
  tags: ['printer', 'peripheral', 'office', 'wireless', 'wi-fi', 'end device'],
};

/** NF-SMART-TV — connected television (Home & SOHO category). */
export const NF_SMART_TV_MODEL_INPUT: ModelInput = {
  type: 'tv.nfsmarttv',
  model: 'NF-SMART-TV',
  description: 'Connected television with a fast-ethernet adapter and a dual-band wireless adapter',
  category: 'home-soho',
  icon: 'smart-tv',
  capabilities: ['host', 'wifi-client'],
  ports: [hostEth('FastEthernet0', SPEED_100M), wlanClient('Wlan0', WIFI5_APPLIANCE_RADIO)],
  tags: ['television', 'tv', 'home', 'streaming', 'wireless', 'wi-fi', 'end device'],
};

/** Catalog inputs of the Peripherals category, in palette order. */
export const PERIPHERAL_MODEL_INPUTS: readonly ModelInput[] = Object.freeze([NF_PRINTER_MODEL_INPUT]);

/** Peripherals category models defined for END_DEVICE_STAGE, in palette order. */
export const PERIPHERAL_MODELS: readonly DeviceModel[] = Object.freeze(PERIPHERAL_MODEL_INPUTS.map((m) => defineModel(m, END_DEVICE_STAGE)));

/** Catalog inputs of the Home & SOHO end devices (placed after the home routers in palette order). */
export const HOME_END_DEVICE_MODEL_INPUTS: readonly ModelInput[] = Object.freeze([NF_SMART_TV_MODEL_INPUT]);

/** Home & SOHO end-device models defined for END_DEVICE_STAGE, in palette order. */
export const HOME_END_DEVICE_MODELS: readonly DeviceModel[] = Object.freeze(HOME_END_DEVICE_MODEL_INPUTS.map((m) => defineModel(m, END_DEVICE_STAGE)));
