/**
 * device/catalog/mobile.ts — Mobile palette category (docs/CATALOG.md "End devices"; ARCHITECTURE-P1 D2, D3, D5).
 *
 * Handhelds have no cable ports: a Wi-Fi client radio (`wireless-client`) and, on cellular variants, a user-equipment
 * radio (`cellular`) that attaches to a tower. Both radios hold L3 addresses, so both are host adapters (Wi-Fi first).
 * All wording is original (D13).
 */
import type { DeviceModel } from '../../contracts/device.js';
import type { ModelInput } from './define.js';
import { defineModel } from './define.js';
import { END_DEVICE_STAGE, WIFI6_HANDHELD_RADIO, cellularClient, wlanClient } from './computers.js';

/** NF-SMARTPHONE — handheld with Wi-Fi and cellular radios. */
export const NF_SMARTPHONE_MODEL_INPUT: ModelInput = {
  type: 'phone.nfsmartphone',
  model: 'NF-SMARTPHONE',
  description: 'Smartphone with a dual-band wireless adapter and a cellular radio',
  category: 'mobile',
  icon: 'smartphone',
  capabilities: ['host', 'wifi-client', 'cellular-client'],
  ports: [wlanClient('Wlan0', WIFI6_HANDHELD_RADIO), cellularClient('Cellular0')],
  tags: ['phone', 'handheld', 'mobile', 'wireless', 'wi-fi', 'cellular', 'lte', 'end device'],
};

/** NF-TABLET — Wi-Fi-only tablet. */
export const NF_TABLET_MODEL_INPUT: ModelInput = {
  type: 'tablet.nftablet',
  model: 'NF-TABLET',
  description: 'Tablet with a dual-band wireless adapter',
  category: 'mobile',
  icon: 'tablet',
  capabilities: ['host', 'wifi-client'],
  ports: [wlanClient('Wlan0', WIFI6_HANDHELD_RADIO)],
  family: 'nf-tablet',
  variant: 'Wi-Fi',
  tags: ['tablet', 'handheld', 'mobile', 'wireless', 'wi-fi', 'end device'],
};

/** NF-TABLET-LTE — tablet with Wi-Fi and cellular radios. */
export const NF_TABLET_LTE_MODEL_INPUT: ModelInput = {
  type: 'tablet.nftablet-lte',
  model: 'NF-TABLET-LTE',
  description: 'Tablet with a dual-band wireless adapter and a cellular radio',
  category: 'mobile',
  icon: 'tablet',
  capabilities: ['host', 'wifi-client', 'cellular-client'],
  ports: [wlanClient('Wlan0', WIFI6_HANDHELD_RADIO), cellularClient('Cellular0')],
  family: 'nf-tablet',
  variant: 'Cellular',
  tags: ['tablet', 'handheld', 'mobile', 'wireless', 'wi-fi', 'cellular', 'lte', 'end device'],
};

/** Catalog inputs of the Mobile category, in palette order. */
export const MOBILE_MODEL_INPUTS: readonly ModelInput[] = Object.freeze([NF_SMARTPHONE_MODEL_INPUT, NF_TABLET_MODEL_INPUT, NF_TABLET_LTE_MODEL_INPUT]);

/** Mobile category models defined for END_DEVICE_STAGE, in palette order. */
export const MOBILE_MODELS: readonly DeviceModel[] = Object.freeze(MOBILE_MODEL_INPUTS.map((m) => defineModel(m, END_DEVICE_STAGE)));
