/**
 * device/catalog/routers.ts — the Routers palette category (docs/CATALOG.md "Network devices"; ARCHITECTURE-P1 D2,
 * D7).
 *
 * Authored as `ModelInput` data; everything behavioural (daemons, roles, CLI, panels, virtual families) is derived
 * by `defineModel`. Router ethernet ports are fixed MDI (no auto-MDIX), matching the P0 NF-2911, so cable-type
 * lessons keep working. SFP/SFP+ ports are cages: each has a transceiver slot naming it (D7), and a fibre cable
 * needs a transceiver module installed while the router is powered off.
 *
 * NF-2911 is the P0 model: its input is field-for-field the P0 literal of device/catalog.ts (§9.2: only the
 * derived daemon list gains `hdlc` at P0.5, the P1 stack at P1 and, at P2, `nat`, `hsrp`, `dhcpv6-client` and
 * `dhcpv6-server` with routed subinterfaces — ARCHITECTURE-P2 §7 W4 catalog, §9.2 W4 item 13; no data edit).
 *
 * All names, descriptions, labels and tags are original wording (§1.6, D13).
 */
import type { DeviceModel } from '../../contracts/device.js';
import { SPEED_100M, SPEED_10G, SPEED_10M, SPEED_1G } from '../../contracts/port.js';
import type { BuildStage } from '../../contracts/catalog.js';
import { defineModel, type ModelInput, type PortInput, type SlotInput } from './define.js';

/** Build stage the exported `ROUTER_MODELS` are defined for (device/catalog/index.ts re-defines ROUTER_INPUTS for its own stage when it differs). */
export const ROUTER_DATA_STAGE: BuildStage = 'P2';

/** Serial WAN port speed (2 Mbit/s, as on the P0 NF-2911). */
const SERIAL_BPS = 2_000_000;
/** Console and auxiliary line rate (9600 baud). */
const CONSOLE_BPS = 9_600;

/** Copper gigabit routed port (fixed MDI, P0 speed list). */
function gig(name: string): PortInput {
  return { name, kind: 'ethernet', speedBps: SPEED_1G, speeds: [SPEED_1G, SPEED_100M, SPEED_10M], autoMdix: false };
}

/** `count` copper gigabit ports `GigabitEthernet${prefix}/${first + i}`. */
function gigRange(prefix: string, first: number, count: number): PortInput[] {
  return Array.from({ length: count }, (_, i) => gig(`GigabitEthernet${prefix}/${first + i}`));
}

/** Gigabit SFP cage (1G optics only). */
function sfpCage(name: string): PortInput {
  return { name, kind: 'ethernet', speedBps: SPEED_1G, speeds: [SPEED_1G], connector: 'sfp' };
}

/** 10-gigabit SFP+ cage (accepts 10G and 1G optics). */
function sfpPlusCage(name: string): PortInput {
  return { name, kind: 'ethernet', speedBps: SPEED_10G, speeds: [SPEED_10G, SPEED_1G], connector: 'sfp+' };
}

/** Console line. */
const CONSOLE: PortInput = { name: 'Console', kind: 'console', speedBps: CONSOLE_BPS };
/** Auxiliary (modem) line; a console-class port. */
const AUX: PortInput = { name: 'Aux', kind: 'console', speedBps: CONSOLE_BPS };

/** Transceiver slot bound to cage port `port` (short name `short`, e.g. 'Gi0/0/2' → slot id 'sfp0/0/2'). */
function cageSlot(type: 'sfp' | 'sfp+', port: string, short: string): SlotInput {
  const number = short.replace(/^[A-Za-z]+/, '');
  return { id: `sfp${number}`, label: `${type === 'sfp' ? 'SFP' : 'SFP+'} cage ${short}`, type, numbering: '', cage: port };
}

/** NF-1941 — small modular branch router. */
export const NF_1941_INPUT: ModelInput = {
  type: 'router.nf1941',
  model: 'NF-1941',
  description: 'Small modular branch router: 2 gigabit ethernet ports, 2 interface card slots, console and auxiliary lines',
  category: 'routers',
  icon: 'router-modular',
  tags: ['router', 'branch', 'modular', 'interface card', 'wan'],
  capabilities: ['routing', 'modular'],
  ports: [...gigRange('0', 0, 2), CONSOLE, AUX],
  slots: [
    { id: '0/0', label: 'Interface card slot 0', type: 'ehwic', numbering: '0/0' },
    { id: '0/1', label: 'Interface card slot 1', type: 'ehwic', numbering: '0/1' },
  ],
};

/** NF-2911 — the P0 branch router (identical P0 fields). */
export const NF_2911_INPUT: ModelInput = {
  type: 'router.nf2911',
  model: 'NF-2911',
  description: 'Branch router: 2 gigabit ethernet ports, 2 serial WAN ports, console',
  category: 'routers',
  icon: 'router',
  tags: ['router', 'branch', 'serial', 'wan'],
  capabilities: ['routing'],
  ports: [
    { name: 'GigabitEthernet0/0', short: 'Gi0/0', kind: 'ethernet', speedBps: SPEED_1G, speeds: [SPEED_1G, SPEED_100M, SPEED_10M], autoMdix: false },
    { name: 'GigabitEthernet0/1', short: 'Gi0/1', kind: 'ethernet', speedBps: SPEED_1G, speeds: [SPEED_1G, SPEED_100M, SPEED_10M], autoMdix: false },
    { name: 'Serial0/0/0', short: 'Se0/0/0', kind: 'serial', speedBps: SERIAL_BPS, serial: {} },
    { name: 'Serial0/0/1', short: 'Se0/0/1', kind: 'serial', speedBps: SERIAL_BPS, serial: {} },
    { name: 'Console', short: 'Con', kind: 'console', speedBps: CONSOLE_BPS },
  ],
};

/** NF-4331 — mid-size services router with network module slots and one SFP cage. */
export const NF_4331_INPUT: ModelInput = {
  type: 'router.nf4331',
  model: 'NF-4331',
  description: 'Mid-size services router: 2 copper gigabit ports, 1 gigabit SFP cage, 2 network module slots, console and auxiliary lines',
  category: 'routers',
  icon: 'router-modular',
  tags: ['router', 'services', 'modular', 'network module', 'sfp', 'fibre'],
  capabilities: ['routing', 'modular'],
  ports: [...gigRange('0/0', 0, 2), sfpCage('GigabitEthernet0/0/2'), CONSOLE, AUX],
  slots: [
    { id: '0/1', label: 'Network module slot 1', type: 'nim', numbering: '0/1' },
    { id: '0/2', label: 'Network module slot 2', type: 'nim', numbering: '0/2' },
    cageSlot('sfp', 'GigabitEthernet0/0/2', 'Gi0/0/2'),
  ],
};

/** NF-4451 — enterprise edge router with 10G SFP+ cages and three network module slots. */
export const NF_4451_INPUT: ModelInput = {
  type: 'router.nf4451',
  model: 'NF-4451',
  description: 'Enterprise edge router: 4 copper gigabit ports, 2 ten-gigabit SFP+ cages, 3 network module slots, console',
  category: 'routers',
  icon: 'router-modular',
  tags: ['router', 'edge', 'enterprise', 'modular', 'network module', 'sfp+', '10g', 'fibre'],
  capabilities: ['routing', 'modular'],
  ports: [
    ...gigRange('0/0', 0, 4),
    sfpPlusCage('TenGigabitEthernet0/1/0'),
    sfpPlusCage('TenGigabitEthernet0/1/1'),
    CONSOLE,
  ],
  slots: [
    { id: '0/2', label: 'Network module slot 2', type: 'nim', numbering: '0/2' },
    { id: '0/3', label: 'Network module slot 3', type: 'nim', numbering: '0/3' },
    { id: '0/4', label: 'Network module slot 4', type: 'nim', numbering: '0/4' },
    cageSlot('sfp+', 'TenGigabitEthernet0/1/0', 'Te0/1/0'),
    cageSlot('sfp+', 'TenGigabitEthernet0/1/1', 'Te0/1/1'),
  ],
};

/** NF-RTR-EMPTY — teaching chassis: a console and eight empty module bays. */
export const NF_RTR_EMPTY_INPUT: ModelInput = {
  type: 'router.nfgeneric',
  model: 'NF-RTR-EMPTY',
  description: 'Teaching router chassis: console only, 8 empty module bays that take interface cards or network modules',
  category: 'routers',
  icon: 'router-chassis',
  family: 'nf-rtr-empty',
  variant: 'Empty chassis',
  tags: ['router', 'chassis', 'modular', 'empty', 'teaching', 'build your own'],
  capabilities: ['routing', 'modular'],
  ports: [CONSOLE],
  slots: Array.from({ length: 8 }, (_, i): SlotInput => ({ id: `0/${i}`, label: `Module bay ${i}`, type: 'generic', numbering: `0/${i}` })),
};

/** Router inputs in palette order (CATALOG.md order). */
export const ROUTER_INPUTS: readonly ModelInput[] = Object.freeze([NF_1941_INPUT, NF_2911_INPUT, NF_4331_INPUT, NF_4451_INPUT, NF_RTR_EMPTY_INPUT]);

/** Router models defined for ROUTER_DATA_STAGE, in palette order. */
export const ROUTER_MODELS: readonly DeviceModel[] = Object.freeze(ROUTER_INPUTS.map((input) => defineModel(input, ROUTER_DATA_STAGE)));
