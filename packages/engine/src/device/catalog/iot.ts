/**
 * device/catalog/iot.ts — IoT palette category (docs/CATALOG.md "End devices"; ARCHITECTURE-P1 D2).
 *
 * Small hosts: battery or mains Wi-Fi things on a 2.4 GHz low-power radio, a PoE-powered camera and a gateway with
 * both a gigabit adapter and a dual-band radio. Hostname prefixes name the thing, not the family.
 * All wording is original (D13).
 */
import type { DeviceModel } from '../../contracts/device.js';
import { SPEED_100M, SPEED_1G } from '../../contracts/port.js';
import type { ModelInput } from './define.js';
import { defineModel } from './define.js';
import { END_DEVICE_STAGE, WIFI4_IOT_RADIO, WIFI5_APPLIANCE_RADIO, hostEth, wlanClient } from './computers.js';

/** NF-IOT-SENSOR — wireless environmental sensor. */
export const NF_IOT_SENSOR_MODEL_INPUT: ModelInput = {
  type: 'iot.nfsensor',
  model: 'NF-IOT-SENSOR',
  description: 'Wireless environmental sensor that reports readings over a low-power radio',
  category: 'iot',
  icon: 'iot-sensor',
  capabilities: ['host', 'wifi-client'],
  ports: [wlanClient('Wlan0', WIFI4_IOT_RADIO)],
  hostnamePrefix: 'Sensor',
  tags: ['sensor', 'iot', 'smart home', 'wireless', 'wi-fi', 'end device'],
};

/** NF-IP-CAMERA — PoE-powered network camera. */
export const NF_IP_CAMERA_MODEL_INPUT: ModelInput = {
  type: 'iot.nfcamera',
  model: 'NF-IP-CAMERA',
  description: 'Network video camera powered from its fast-ethernet port',
  category: 'iot',
  icon: 'ip-camera',
  capabilities: ['host', 'poe-powered'],
  ports: [hostEth('FastEthernet0', SPEED_100M, { poeDraw: { standard: 'af', drawW: 5 } })],
  hostnamePrefix: 'Camera',
  tags: ['camera', 'video', 'surveillance', 'iot', 'poe', 'end device'],
};

/** NF-THERMOSTAT — wireless thermostat. */
export const NF_THERMOSTAT_MODEL_INPUT: ModelInput = {
  type: 'iot.nfthermostat',
  model: 'NF-THERMOSTAT',
  description: 'Wireless heating and cooling controller for the home',
  category: 'iot',
  icon: 'thermostat',
  capabilities: ['host', 'wifi-client'],
  ports: [wlanClient('Wlan0', WIFI4_IOT_RADIO)],
  hostnamePrefix: 'Thermostat',
  tags: ['thermostat', 'climate', 'iot', 'smart home', 'wireless', 'wi-fi', 'end device'],
};

/** NF-SMART-PLUG — wireless switched power outlet. */
export const NF_SMART_PLUG_MODEL_INPUT: ModelInput = {
  type: 'iot.nfplug',
  model: 'NF-SMART-PLUG',
  description: 'Wireless power outlet that can be switched on and off over the network',
  category: 'iot',
  icon: 'smart-plug',
  capabilities: ['host', 'wifi-client'],
  ports: [wlanClient('Wlan0', WIFI4_IOT_RADIO)],
  hostnamePrefix: 'Plug',
  tags: ['plug', 'outlet', 'power', 'iot', 'smart home', 'wireless', 'wi-fi', 'end device'],
};

/** NF-IOT-GATEWAY — hub joining IoT things to the wired network. */
export const NF_IOT_GATEWAY_MODEL_INPUT: ModelInput = {
  type: 'iot.nfgateway',
  model: 'NF-IOT-GATEWAY',
  description: 'Gateway for connected things with a gigabit network adapter and a dual-band wireless adapter',
  category: 'iot',
  icon: 'iot-gateway',
  capabilities: ['host', 'wifi-client'],
  ports: [hostEth('GigabitEthernet0', SPEED_1G), wlanClient('Wlan0', WIFI5_APPLIANCE_RADIO)],
  hostnamePrefix: 'Gateway',
  tags: ['gateway', 'hub', 'iot', 'smart home', 'wireless', 'wi-fi', 'end device'],
};

/** Catalog inputs of the IoT category, in palette order. */
export const IOT_MODEL_INPUTS: readonly ModelInput[] = Object.freeze([
  NF_IOT_SENSOR_MODEL_INPUT,
  NF_IP_CAMERA_MODEL_INPUT,
  NF_THERMOSTAT_MODEL_INPUT,
  NF_SMART_PLUG_MODEL_INPUT,
  NF_IOT_GATEWAY_MODEL_INPUT,
]);

/** IoT category models defined for END_DEVICE_STAGE, in palette order. */
export const IOT_MODELS: readonly DeviceModel[] = Object.freeze(IOT_MODEL_INPUTS.map((m) => defineModel(m, END_DEVICE_STAGE)));
