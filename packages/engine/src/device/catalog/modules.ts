/**
 * device/catalog/modules.ts — the module catalog (docs/CATALOG.md "Modules"; ARCHITECTURE-P1 D7).
 *
 * Interface cards (EHWIC), network modules (NIM), SFP-class transceivers and the host expansion Wi-Fi card.
 * Module ports are named `${family}${slot.numbering}/${index}` (Serial0/1/0) by `modulePortSpecs`, or absolutely
 * (`Wlan0`) for host-expansion cards. Transceivers add no ports: installed in a cage slot they become the cage
 * port's `transceiver` (fibre cabling checks read their optics).
 *
 * Switchport modules contribute `switching` while installed so their bridged ports have a bridge on a router;
 * the Wi-Fi card contributes `wifi-client`.
 *
 * All names and descriptions are original wording (§1.6, D13).
 */
import { SPEED_100M, SPEED_10G, SPEED_10M, SPEED_1G } from '../../contracts/port.js';
import type { ModuleModel } from '../../contracts/catalog.js';
import type { RadioPortSpec } from '../../contracts/rf.js';
import { defineModule } from './module-define.js';

/** Serial module port speed (2 Mbit/s, as on the fixed NF-2911 serial ports). */
const SERIAL_BPS = 2_000_000;

/** Gigabit copper speeds, fastest first. */
const GIG_SPEEDS = [SPEED_1G, SPEED_100M, SPEED_10M];

/** Dual-band station radio of the expansion Wi-Fi card (2×2 streams, 802.11n/ac). */
const WLAN_CARD_RADIO: RadioPortSpec = {
  bands: ['2.4', '5'],
  generations: ['n', 'ac'],
  defaultBand: '2.4',
  defaultChannel: 6,
  maxTxPowerDbm: 20,
  antennaGainDbi: 2,
  streams: 2,
  maxWidthMhz: 80,
  maxRangeM: 150,
};

/** NF-EHWIC-2T — two serial WAN ports on an interface card. */
export const MOD_EHWIC_2T: ModuleModel = defineModule({
  type: 'mod.ehwic-2t',
  model: 'NF-EHWIC-2T',
  description: 'Interface card with 2 synchronous serial WAN ports',
  fits: 'ehwic',
  ports: [{ family: 'Serial', count: 2, spec: { kind: 'serial', speedBps: SERIAL_BPS } }],
});

/** NF-EHWIC-4ESG — four gigabit switchports on an interface card. */
export const MOD_EHWIC_4ESG: ModuleModel = defineModule({
  type: 'mod.ehwic-4esg',
  model: 'NF-EHWIC-4ESG',
  description: 'Interface card with 4 gigabit switch ports that bridge inside the router',
  fits: 'ehwic',
  ports: [{ family: 'GigabitEthernet', count: 4, spec: { kind: 'ethernet', speedBps: SPEED_1G, speeds: GIG_SPEEDS, autoMdix: true, role: 'switched' } }],
  capabilitiesAdded: ['switching'],
});

/** NF-NIM-2T — two serial WAN ports on a network module. */
export const MOD_NIM_2T: ModuleModel = defineModule({
  type: 'mod.nim-2t',
  model: 'NF-NIM-2T',
  description: 'Network module with 2 synchronous serial WAN ports',
  fits: 'nim',
  ports: [{ family: 'Serial', count: 2, spec: { kind: 'serial', speedBps: SERIAL_BPS } }],
});

/** NF-NIM-ES2-4 — four gigabit switchports on a network module. */
export const MOD_NIM_ES2_4: ModuleModel = defineModule({
  type: 'mod.nim-es2-4',
  model: 'NF-NIM-ES2-4',
  description: 'Network module with 4 gigabit switch ports that bridge inside the router',
  fits: 'nim',
  ports: [{ family: 'GigabitEthernet', count: 4, spec: { kind: 'ethernet', speedBps: SPEED_1G, speeds: GIG_SPEEDS, autoMdix: true, role: 'switched' } }],
  capabilitiesAdded: ['switching'],
});

/** NF-NIM-2GE — two gigabit routed ports on a network module. */
export const MOD_NIM_2GE: ModuleModel = defineModule({
  type: 'mod.nim-2ge',
  model: 'NF-NIM-2GE',
  description: 'Network module with 2 routed gigabit ethernet ports',
  fits: 'nim',
  ports: [{ family: 'GigabitEthernet', count: 2, spec: { kind: 'ethernet', speedBps: SPEED_1G, speeds: GIG_SPEEDS, autoMdix: false, role: 'routed' } }],
});

/** NF-SFP-1G-SX — gigabit multimode short-reach transceiver. */
export const MOD_SFP_1G_SX: ModuleModel = defineModule({
  type: 'mod.sfp-1g-sx',
  model: 'NF-SFP-1G-SX',
  description: 'Gigabit multimode fibre transceiver, LC connector, 850 nm, up to 550 m',
  fits: 'sfp',
  ports: [],
  transceiver: { connector: 'lc', mode: 'mm', speedBps: SPEED_1G, maxLengthM: 550, wavelengthNm: 850 },
});

/** NF-SFP-1G-LX — gigabit single-mode long-reach transceiver. */
export const MOD_SFP_1G_LX: ModuleModel = defineModule({
  type: 'mod.sfp-1g-lx',
  model: 'NF-SFP-1G-LX',
  description: 'Gigabit single-mode fibre transceiver, LC connector, 1310 nm, up to 10 km',
  fits: 'sfp',
  ports: [],
  transceiver: { connector: 'lc', mode: 'sm', speedBps: SPEED_1G, maxLengthM: 10_000, wavelengthNm: 1310 },
});

/** NF-SFP-10G-SR — 10-gigabit multimode short-reach transceiver. */
export const MOD_SFP_10G_SR: ModuleModel = defineModule({
  type: 'mod.sfp-10g-sr',
  model: 'NF-SFP-10G-SR',
  description: 'Ten-gigabit multimode fibre transceiver for SFP+ cages, LC connector, 850 nm, up to 300 m',
  fits: 'sfp+',
  ports: [],
  transceiver: { connector: 'lc', mode: 'mm', speedBps: SPEED_10G, maxLengthM: 300, wavelengthNm: 850 },
});

/** NF-WLAN-CARD — Wi-Fi adapter for a host expansion bay. */
export const MOD_WLAN_CARD: ModuleModel = defineModule({
  type: 'mod.wlan-card',
  model: 'NF-WLAN-CARD',
  description: 'Dual-band Wi-Fi adapter card that adds a wireless network adapter to an end device',
  fits: 'host-expansion',
  ports: [{ family: 'Wlan', count: 1, absolute: true, spec: { kind: 'wlan', speedBps: 867_000_000, radio: WLAN_CARD_RADIO } }],
  capabilitiesAdded: ['wifi-client'],
});

/** Every module in catalog order (CATALOG.md order). */
export const MODULE_MODELS: readonly ModuleModel[] = Object.freeze([
  MOD_EHWIC_2T,
  MOD_EHWIC_4ESG,
  MOD_NIM_2T,
  MOD_NIM_ES2_4,
  MOD_NIM_2GE,
  MOD_SFP_1G_SX,
  MOD_SFP_1G_LX,
  MOD_SFP_10G_SR,
  MOD_WLAN_CARD,
]);
