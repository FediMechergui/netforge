/**
 * device/catalog/legacy.ts — the Legacy palette category (docs/CATALOG.md "Network devices"; ARCHITECTURE-P1 D3, D4).
 *
 * Hubs, the thin-coax multiport transceiver and the 2-port repeater have `repeater` ports: no daemons, the link layer
 * forms one shared collision domain (10 Mb half duplex, CSMA/CD). Learning bridges have `switching` on 10 Mb ports.
 * A learning bridge boots the same host stack as an access switch, so it carries the same management Vlan1 family
 * (administratively down until `no shutdown`).
 * Legacy twisted-pair ports are fixed MDI-X (no auto-MDIX, from the role wiring trait), so a station uses a straight
 * cable and hub-to-hub needs a crossover.
 *
 * All names, descriptions, labels and tags are original wording (§1.6, D13).
 */
import type { DeviceModel } from '../../contracts/device.js';
import { SPEED_10M } from '../../contracts/port.js';
import type { BuildStage } from '../../contracts/catalog.js';
import { defineModel, type ModelInput, type PortInput } from './define.js';
import { L2_SWITCH_VLAN_FAMILY } from './switches.js';

/** Build stage the exported `LEGACY_MODELS` are defined for (device/catalog/index.ts re-defines LEGACY_INPUTS for its own stage when it differs). */
export const LEGACY_DATA_STAGE: BuildStage = 'P2';

/** `count` 10 Mb twisted-pair ports `Ethernet0..`. */
function tenBaseT(count: number): PortInput[] {
  return Array.from({ length: count }, (_, i): PortInput => ({ name: `Ethernet${i}`, kind: 'ethernet', speedBps: SPEED_10M, speeds: [SPEED_10M], autoMdix: false }));
}

/** `count` 10 Mb thin-coax taps `Coax0..`. */
function thinCoax(count: number): PortInput[] {
  return Array.from({ length: count }, (_, i): PortInput => ({ name: `Coax${i}`, kind: 'coax', speedBps: SPEED_10M, speeds: [SPEED_10M] }));
}

/** NF-HUB-4 — 4-port 10 Mb hub. */
export const NF_HUB_4_INPUT: ModelInput = {
  type: 'hub.nfhub4',
  model: 'NF-HUB-4',
  description: '4-port 10 Mb hub: repeats every bit to all other ports in one shared collision domain',
  category: 'legacy',
  icon: 'hub',
  family: 'nf-hub',
  variant: '4-port',
  tags: ['hub', 'legacy', 'repeater', 'collision domain', 'half duplex', '10base-t'],
  capabilities: ['repeater'],
  ports: tenBaseT(4),
};

/** NF-HUB-8 — 8-port 10 Mb hub. */
export const NF_HUB_8_INPUT: ModelInput = {
  type: 'hub.nfhub8',
  model: 'NF-HUB-8',
  description: '8-port 10 Mb hub: repeats every bit to all other ports in one shared collision domain',
  category: 'legacy',
  icon: 'hub',
  family: 'nf-hub',
  variant: '8-port',
  tags: ['hub', 'legacy', 'repeater', 'collision domain', 'half duplex', '10base-t'],
  capabilities: ['repeater'],
  ports: tenBaseT(8),
};

/** NF-COAX-TAP — thin-coax multiport transceiver. */
export const NF_COAX_TAP_INPUT: ModelInput = {
  type: 'hub.nfcoax',
  model: 'NF-COAX-TAP',
  description: 'Thin-coax multiport transceiver: 4 BNC taps sharing one 10 Mb bus segment',
  category: 'legacy',
  icon: 'coax-tap',
  tags: ['coax', 'bus', 'legacy', 'repeater', 'collision domain', '10base2', 'bnc'],
  capabilities: ['repeater'],
  ports: thinCoax(4),
};

/** NF-REPEATER — 2-port signal repeater. */
export const NF_REPEATER_INPUT: ModelInput = {
  type: 'repeater.nfrep',
  model: 'NF-REPEATER',
  description: '2-port signal repeater: regenerates 10 Mb signals to extend a segment, without filtering',
  category: 'legacy',
  icon: 'repeater',
  tags: ['repeater', 'legacy', 'layer 1', 'collision domain', 'extend segment'],
  capabilities: ['repeater'],
  ports: tenBaseT(2),
};

/** NF-BRIDGE-2 — 2-port learning bridge. */
export const NF_BRIDGE_2_INPUT: ModelInput = {
  type: 'bridge.nfbr2',
  model: 'NF-BRIDGE-2',
  description: '2-port learning bridge: learns addresses and forwards between two 10 Mb segments, splitting the collision domain',
  category: 'legacy',
  icon: 'bridge',
  family: 'nf-bridge',
  variant: '2-port',
  tags: ['bridge', 'legacy', 'layer 2', 'mac learning', 'collision domain'],
  capabilities: ['switching'],
  ports: tenBaseT(2),
  virtualFamilies: [L2_SWITCH_VLAN_FAMILY],
};

/** NF-BRIDGE-4 — 4-port learning bridge. */
export const NF_BRIDGE_4_INPUT: ModelInput = {
  type: 'bridge.nfbr4',
  model: 'NF-BRIDGE-4',
  description: '4-port learning bridge: learns addresses and forwards between four 10 Mb segments, one collision domain per port',
  category: 'legacy',
  icon: 'bridge',
  family: 'nf-bridge',
  variant: '4-port',
  tags: ['bridge', 'legacy', 'layer 2', 'mac learning', 'collision domain'],
  capabilities: ['switching'],
  ports: tenBaseT(4),
  virtualFamilies: [L2_SWITCH_VLAN_FAMILY],
};

/** Legacy inputs in palette order (CATALOG.md order). */
export const LEGACY_INPUTS: readonly ModelInput[] = Object.freeze([
  NF_HUB_4_INPUT,
  NF_HUB_8_INPUT,
  NF_COAX_TAP_INPUT,
  NF_REPEATER_INPUT,
  NF_BRIDGE_2_INPUT,
  NF_BRIDGE_4_INPUT,
]);

/** Legacy models defined for LEGACY_DATA_STAGE, in palette order. */
export const LEGACY_MODELS: readonly DeviceModel[] = Object.freeze(LEGACY_INPUTS.map((input) => defineModel(input, LEGACY_DATA_STAGE)));
