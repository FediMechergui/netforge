/**
 * device/catalog/computers.ts — Computers palette category (docs/CATALOG.md "End devices"; ARCHITECTURE-P1 D2, D3, D7).
 *
 * Also the home of the small authoring helpers shared by every end-device data file (servers, mobile, voice,
 * peripherals, iot): host network adapters, Wi-Fi and cellular client radios with their capability presets, and
 * the expansion-card bay that accepts host-expansion modules. Everything behaviour-relevant (roles, encapsulation,
 * ordinals, processes, CLI, GUI, host adapters) is derived by `defineModel`; these files only state identity, ports
 * and capabilities. All names, descriptions and tags are original wording (D13).
 *
 * NF-PC keeps the P0 identity exactly: type `pc.nfpc`, one `GigabitEthernet0` (short `Gi0`, 1 Gb, speeds
 * 1 Gb/100 Mb/10 Mb, no auto-MDIX), the P0 description, hostname prefix, boot time and daemons.
 */
import type { DeviceModel } from '../../contracts/device.js';
import { SPEED_100M, SPEED_10G, SPEED_10M, SPEED_1G } from '../../contracts/port.js';
import { MCS_TABLES, WIDTH_FACTOR_PCT, type RadioPortSpec } from '../../contracts/rf.js';
import type { BuildStage, PoeStandard } from '../../contracts/catalog.js';
import { defineModel, type ModelInput, type PortInput, type SlotInput } from './define.js';

// ── shared end-device authoring helpers ─────────────────────────────────────

/**
 * Build stage the end-device data files define their models for. Equal to `CATALOG_STAGE` (device/catalog/index.ts);
 * kept here so the data files do not import the catalog index, which imports them.
 */
export const END_DEVICE_STAGE: BuildStage = 'P1';

/** Supported autonegotiation speeds of a copper host adapter whose top speed is `speedBps` (fastest first). */
export function hostSpeeds(speedBps: number): number[] {
  if (speedBps >= SPEED_10G) return [SPEED_10G, SPEED_1G, SPEED_100M];
  if (speedBps >= SPEED_1G) return [SPEED_1G, SPEED_100M, SPEED_10M];
  return [SPEED_100M, SPEED_10M];
}

/** Optional per-port additions of a host ethernet adapter. */
export interface HostEthOptions {
  /** Draws power from the cable (the model must declare `poe-powered`). */
  readonly poeDraw?: { readonly standard: PoeStandard; readonly drawW: number };
  /** Copper wiring when it differs from the role default. */
  readonly wiring?: PortInput['wiring'];
  /** Port-picker group when it differs from 'front'. */
  readonly group?: string;
}

/**
 * A fixed ethernet adapter of an end device: RJ45 copper, no auto-MDIX (the classic cabling lesson: a host takes a
 * straight cable to a switch and a crossover to another host), speeds from `hostSpeeds`. Role, encapsulation,
 * ordinal and wiring are derived by `defineModel` (hosts: routed, MDI; bridged ports: switched, MDI-X).
 */
export function hostEth(name: string, speedBps: number, opts: HostEthOptions = {}): PortInput {
  const port: PortInput = { name, kind: 'ethernet', speedBps, speeds: hostSpeeds(speedBps), autoMdix: false };
  if (opts.poeDraw !== undefined) port.poe = { pd: { standard: opts.poeDraw.standard, drawW: opts.poeDraw.drawW } };
  if (opts.wiring !== undefined) port.wiring = opts.wiring;
  if (opts.group !== undefined) port.group = opts.group;
  return port;
}

/**
 * Top PHY rate of a radio in bit/s: the fastest entry of its best listed generation at its widest channel and all
 * spatial streams, computed exactly as the RF model computes link rates (floor(base × width% / 100) × streams kbit/s).
 * Used as the port's nominal `speedBps`; the live rate always comes from the RF model.
 */
export function radioTopRateBps(radio: RadioPortSpec): number {
  let bestKbps = 0;
  for (const gen of radio.generations) {
    const table = MCS_TABLES[gen];
    const top = table[table.length - 1];
    if (top === undefined) continue;
    const width = radio.bands.includes('60') ? 2160 : radio.bands.includes('cell') ? 20 : radio.maxWidthMhz;
    const kbps = Math.floor((top.baseKbps20 * WIDTH_FACTOR_PCT[width]) / 100) * radio.streams;
    if (kbps > bestKbps) bestKbps = kbps;
  }
  return bestKbps * 1000;
}

/** Dual-band Wi-Fi 5 client adapter of a computer (two streams, up to 80 MHz). */
export const WIFI5_COMPUTER_RADIO: RadioPortSpec = Object.freeze({
  bands: Object.freeze(['2.4', '5']),
  generations: Object.freeze(['b', 'g', 'n', 'ac']),
  defaultBand: '2.4',
  defaultChannel: 1,
  maxTxPowerDbm: 17,
  antennaGainDbi: 2,
  streams: 2,
  maxWidthMhz: 80,
  maxRangeM: 300,
}) as RadioPortSpec;

/** Dual-band Wi-Fi 6 client radio of a handheld (two streams, small antenna, lower power). */
export const WIFI6_HANDHELD_RADIO: RadioPortSpec = Object.freeze({
  bands: Object.freeze(['2.4', '5']),
  generations: Object.freeze(['b', 'g', 'n', 'ac', 'ax']),
  defaultBand: '2.4',
  defaultChannel: 1,
  maxTxPowerDbm: 15,
  antennaGainDbi: 0,
  streams: 2,
  maxWidthMhz: 80,
  maxRangeM: 250,
}) as RadioPortSpec;

/** Dual-band Wi-Fi 5 single-stream radio of an appliance (printer, television). */
export const WIFI5_APPLIANCE_RADIO: RadioPortSpec = Object.freeze({
  bands: Object.freeze(['2.4', '5']),
  generations: Object.freeze(['b', 'g', 'n', 'ac']),
  defaultBand: '2.4',
  defaultChannel: 1,
  maxTxPowerDbm: 16,
  antennaGainDbi: 2,
  streams: 1,
  maxWidthMhz: 40,
  maxRangeM: 250,
}) as RadioPortSpec;

/** 2.4 GHz-only low-power single-stream radio of a small IoT device (20 MHz). */
export const WIFI4_IOT_RADIO: RadioPortSpec = Object.freeze({
  bands: Object.freeze(['2.4']),
  generations: Object.freeze(['b', 'g', 'n']),
  defaultBand: '2.4',
  defaultChannel: 1,
  maxTxPowerDbm: 14,
  antennaGainDbi: 0,
  streams: 1,
  maxWidthMhz: 20,
  maxRangeM: 150,
}) as RadioPortSpec;

/** Cellular user-equipment radio (LTE table, two streams; the cell band has no user channel). */
export const CELLULAR_UE_RADIO: RadioPortSpec = Object.freeze({
  bands: Object.freeze(['cell']),
  generations: Object.freeze(['lte']),
  defaultBand: 'cell',
  defaultChannel: 0,
  maxTxPowerDbm: 23,
  antennaGainDbi: 0,
  streams: 2,
  maxWidthMhz: 20,
  maxRangeM: 30_000,
}) as RadioPortSpec;

/** A Wi-Fi client radio port (`Wlan<n>`); `defineModel` makes it `wireless-client` with dot11 framing. */
export function wlanClient(name: string, radio: RadioPortSpec): PortInput {
  return { name, kind: 'wlan', speedBps: radioTopRateBps(radio), radio };
}

/** A cellular user-equipment port (`Cellular<n>`); `defineModel` makes it `cellular`. */
export function cellularClient(name: string, radio: RadioPortSpec = CELLULAR_UE_RADIO): PortInput {
  return { name, kind: 'cellular', speedBps: radioTopRateBps(radio), radio };
}

/** Expansion-card bay of a desktop-class host: accepts host-expansion modules (the Wi-Fi card adds `Wlan0`). */
export const EXPANSION_BAY: SlotInput = Object.freeze({
  id: 'exp0',
  label: 'Expansion card bay',
  type: 'host-expansion',
  numbering: '',
}) as SlotInput;

// ── computers ────────────────────────────────────────────────────────────────

/** NF-PC — the P0 workstation (identity and port unchanged), with an expansion bay for a Wi-Fi card. */
export const NF_PC_MODEL_INPUT: ModelInput = {
  type: 'pc.nfpc',
  model: 'NF-PC',
  description: 'Workstation with one gigabit network adapter and a host shell',
  category: 'computers',
  icon: 'pc',
  capabilities: ['host'],
  ports: [hostEth('GigabitEthernet0', SPEED_1G)],
  family: 'nf-pc',
  variant: 'Wired',
  tags: ['desktop', 'workstation', 'computer', 'host', 'end device'],
  slots: [EXPANSION_BAY],
};

/** NF-PC-WIFI — the workstation with a built-in dual-band wireless adapter. */
export const NF_PC_WIFI_MODEL_INPUT: ModelInput = {
  type: 'pc.nfpc-wifi',
  model: 'NF-PC-WIFI',
  description: 'Workstation with a gigabit network adapter, a built-in dual-band wireless adapter and a host shell',
  category: 'computers',
  icon: 'pc-wifi',
  capabilities: ['host', 'wifi-client'],
  ports: [hostEth('GigabitEthernet0', SPEED_1G), wlanClient('Wlan0', WIFI5_COMPUTER_RADIO)],
  family: 'nf-pc',
  variant: 'Wi-Fi',
  tags: ['desktop', 'workstation', 'computer', 'wireless', 'wi-fi', 'host', 'end device'],
};

/** NF-LAPTOP — portable computer with wired and wireless adapters. */
export const NF_LAPTOP_MODEL_INPUT: ModelInput = {
  type: 'laptop.nflaptop',
  model: 'NF-LAPTOP',
  description: 'Portable computer with a gigabit network adapter, a dual-band wireless adapter and a host shell',
  category: 'computers',
  icon: 'laptop',
  capabilities: ['host', 'wifi-client'],
  // Usb0: USB-A socket for a USB console cable to a device console line (the terminal end; no network traffic).
  ports: [hostEth('GigabitEthernet0', SPEED_1G), wlanClient('Wlan0', WIFI5_COMPUTER_RADIO), { name: 'Usb0', kind: 'usb', connector: 'usb', speedBps: 9_600 }],
  tags: ['notebook', 'portable', 'computer', 'wireless', 'wi-fi', 'host', 'end device'],
};

/** Catalog inputs of the Computers category, in palette order. */
export const COMPUTER_MODEL_INPUTS: readonly ModelInput[] = Object.freeze([NF_PC_MODEL_INPUT, NF_PC_WIFI_MODEL_INPUT, NF_LAPTOP_MODEL_INPUT]);

/** Computers category models defined for END_DEVICE_STAGE, in palette order. */
export const COMPUTER_MODELS: readonly DeviceModel[] = Object.freeze(COMPUTER_MODEL_INPUTS.map((m) => defineModel(m, END_DEVICE_STAGE)));
