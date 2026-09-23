/**
 * device/catalog/wan.ts — the WAN & ISP palette category: access-line modems, the serial line unit and the provider
 * cloud (docs/CATALOG.md "Network devices"; ARCHITECTURE-P1 D3, D6, §3.4, §3.9).
 *
 * Every device here is a transparent bridge (eth-switch) without a shell:
 *   modems        `GigabitEthernet0` (switched LAN side) + one `access-line` port (phone RJ11, coax F-type, fibre PON SC);
 *   NF-CSU-DSU    `Serial0` towards the customer router and `Serial1` towards the provider line, both `access-line`.
 *                 `Serial0` generates line clock (`clockSource`), so a router cabled to it needs no `clock rate` (D6);
 *   NF-INTERNET   eight gigabit ports plus four each of phone, coax, fibre PON and serial access-line ports. Provider
 *                 serial ports generate clock, like a carrier's line.
 * Access-line ports of a modem and of the cloud share connector and speed, so negotiation (§3.4) picks the line rate.
 * Coax plant ports use F-type connectors (the legacy thin-coax tap uses BNC; the two do not mate).
 * All names, descriptions and tags are original wording (D13).
 */
import type { DeviceModel } from '../../contracts/device.js';
import { SPEED_100M, SPEED_10M, SPEED_1G } from '../../contracts/port.js';
import type { BuildStage } from '../../contracts/catalog.js';
import { defineModel, type ModelInput, type PortInput } from './define.js';

/** Build stage the `*_MODELS` arrays of this file are defined for (the catalog index re-derives from the inputs). */
const DATA_STAGE: BuildStage = 'P2';

/** Speeds of a copper gigabit port, fastest first. */
const GIGABIT_SPEEDS: readonly number[] = [SPEED_1G, SPEED_100M, SPEED_10M];

/** DSL line rate (VDSL-class loop). */
export const DSL_LINE_BPS = 100_000_000;
/** Cable plant line rate. */
export const CABLE_LINE_BPS = 1_000_000_000;
/** Fibre PON line rate. */
export const PON_LINE_BPS = 2_500_000_000;
/** Leased serial line rate (T1-class). */
export const SERIAL_LINE_BPS = 1_544_000;

/** An auto-MDIX gigabit copper port. */
function gigabitPort(name: string): PortInput {
  return { name, kind: 'ethernet', speedBps: SPEED_1G, speeds: [...GIGABIT_SPEEDS], autoMdix: true };
}

/** A DSL phone-line port (RJ11). */
function phonePort(name: string): PortInput {
  return { name, kind: 'phone', speedBps: DSL_LINE_BPS, connector: 'rj11', group: 'uplink' };
}

/** A cable-plant coax port (F-type). */
function coaxPort(name: string): PortInput {
  return { name, kind: 'coax', speedBps: CABLE_LINE_BPS, connector: 'f-type', group: 'uplink' };
}

/** A fibre PON port (SC). */
function ponPort(name: string): PortInput {
  return { name, kind: 'fiber-pon', speedBps: PON_LINE_BPS, connector: 'sc', group: 'uplink' };
}

/** A serial line port (DB-60); `clockSource` when the port generates the line clock. */
function serialPort(name: string, clockSource: boolean): PortInput {
  return { name, kind: 'serial', speedBps: SERIAL_LINE_BPS, connector: 'db60', ...(clockSource ? { clockSource: true } : {}) };
}

/** `count` port inputs `${family}0`…`${family}${count - 1}` built by `make`. */
function numbered(family: string, count: number, make: (name: string) => PortInput): PortInput[] {
  return Array.from({ length: count }, (_, i) => make(`${family}${i}`));
}

// ── models ───────────────────────────────────────────────────────────────────

/** NF-DSL-MODEM: DSL modem. */
export const NF_DSL_MODEM_INPUT: ModelInput = {
  type: 'modem.nfdsl',
  model: 'NF-DSL-MODEM',
  description: 'DSL modem that bridges a telephone-line connection to a gigabit Ethernet LAN port',
  category: 'wan-isp',
  icon: 'modem-dsl',
  family: 'nf-modem',
  variant: 'DSL',
  tags: ['modem', 'dsl', 'phone line', 'broadband', 'wan'],
  capabilities: ['modem'],
  ports: [gigabitPort('GigabitEthernet0'), phonePort('Phone0')],
};

/** NF-CABLE-MODEM: cable modem. */
export const NF_CABLE_MODEM_INPUT: ModelInput = {
  type: 'modem.nfcable',
  model: 'NF-CABLE-MODEM',
  description: 'Cable modem that bridges a coaxial cable-plant connection to a gigabit Ethernet LAN port',
  category: 'wan-isp',
  icon: 'modem-cable',
  family: 'nf-modem',
  variant: 'Cable',
  tags: ['modem', 'cable', 'coax', 'broadband', 'wan'],
  capabilities: ['modem'],
  ports: [gigabitPort('GigabitEthernet0'), coaxPort('Coax0')],
};

/** NF-FIBER-ONT: fibre optical network terminal. */
export const NF_FIBER_ONT_INPUT: ModelInput = {
  type: 'modem.nfont',
  model: 'NF-FIBER-ONT',
  description: 'Optical network terminal that bridges a passive optical network fibre to a gigabit Ethernet LAN port',
  category: 'wan-isp',
  icon: 'ont',
  family: 'nf-modem',
  variant: 'Fibre',
  tags: ['modem', 'fibre', 'fiber', 'pon', 'ont', 'broadband', 'wan'],
  capabilities: ['modem'],
  ports: [gigabitPort('GigabitEthernet0'), ponPort('Fiber0')],
};

/** NF-CSU-DSU: serial line unit between a router and a leased line. */
export const NF_CSU_DSU_INPUT: ModelInput = {
  type: 'csu.nfcsu',
  model: 'NF-CSU-DSU',
  description: 'Serial line unit: Serial0 faces the customer router and supplies its clock, Serial1 connects to the provider line',
  category: 'wan-isp',
  icon: 'csu',
  tags: ['serial', 'leased line', 'line unit', 'clocking', 'wan'],
  capabilities: ['modem'],
  ports: [serialPort('Serial0', true), { ...serialPort('Serial1', false), group: 'uplink' }],
};

/** NF-INTERNET: provider network abstraction (transparent bridge; provider mode is deferred). */
export const NF_INTERNET_INPUT: ModelInput = {
  type: 'cloud.nfinternet',
  model: 'NF-INTERNET',
  description: 'Internet service provider cloud with Ethernet, phone-line, coax, fibre and serial connections that it bridges together',
  category: 'wan-isp',
  icon: 'cloud',
  tags: ['internet', 'isp', 'provider', 'cloud', 'wan'],
  capabilities: ['cloud'],
  ports: [
    ...numbered('GigabitEthernet', 8, gigabitPort),
    ...numbered('Phone', 4, phonePort),
    ...numbered('Coax', 4, coaxPort),
    ...numbered('Fiber', 4, ponPort),
    ...numbered('Serial', 4, (name) => serialPort(name, true)),
  ],
};

/** WAN & ISP category inputs in palette order. */
export const WAN_INPUTS: readonly ModelInput[] = Object.freeze([
  NF_DSL_MODEM_INPUT,
  NF_CABLE_MODEM_INPUT,
  NF_FIBER_ONT_INPUT,
  NF_CSU_DSU_INPUT,
  NF_INTERNET_INPUT,
]);

/** WAN & ISP category models (defined for stage P0.5), in palette order. */
export const WAN_MODELS: readonly DeviceModel[] = Object.freeze(WAN_INPUTS.map((input) => defineModel(input, DATA_STAGE)));
