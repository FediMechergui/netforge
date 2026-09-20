/**
 * device/catalog/datacentre.ts — the Data centre palette category (docs/CATALOG.md "Network devices";
 * ARCHITECTURE-P1 D2, D3).
 *
 * Leaf and spine switches with `layer3-switch` (switched ports that may be routed, SVIs, loopbacks) and jumbo MTU.
 * A model has at most MAX_SLOTS transceiver slots, fewer than these port counts, so the ports carry their physical
 * layer built in rather than as cages:
 *   - 10G `Ethernet` leaf access ports are auto-MDIX copper RJ-45 (10G/1G/100M);
 *   - 40G `FortyGigabitEthernet` ports have fixed multimode LC optics (fibre cables only).
 *
 * All names, descriptions, labels and tags are original wording (§1.6, D13).
 */
import type { DeviceModel } from '../../contracts/device.js';
import { JUMBO_MTU, SPEED_100M, SPEED_10G, SPEED_1G, SPEED_40G } from '../../contracts/port.js';
import type { BuildStage } from '../../contracts/catalog.js';
import { defineModel, type ModelInput, type PortInput } from './define.js';

/** Build stage the exported `DATACENTRE_MODELS` are defined for (device/catalog/index.ts re-defines DATACENTRE_INPUTS for its own stage when it differs). */
export const DATACENTRE_DATA_STAGE: BuildStage = 'P1';

/** `count` ports `${family}1/${first + i}` built by `make`. */
function range(make: (name: string) => PortInput, family: string, first: number, count: number): PortInput[] {
  return Array.from({ length: count }, (_, i) => make(`${family}1/${first + i}`));
}

/** 10-gigabit copper access port with jumbo MTU. */
function tenGigCopper(name: string): PortInput {
  return { name, kind: 'ethernet', speedBps: SPEED_10G, speeds: [SPEED_10G, SPEED_1G, SPEED_100M], autoMdix: true, mtu: JUMBO_MTU };
}

/** 40-gigabit port with fixed multimode LC optics and jumbo MTU. */
function fortyGigOptic(name: string): PortInput {
  return { name, kind: 'ethernet', speedBps: SPEED_40G, speeds: [SPEED_40G], connector: 'lc', mtu: JUMBO_MTU };
}

/** NF-N9K-48X — top-of-rack leaf: 48 × 10G access, 6 × 40G fabric uplinks. */
export const NF_N9K_48_INPUT: ModelInput = {
  type: 'dcswitch.nfn9k-48',
  model: 'NF-N9K-48X',
  description: 'Top-of-rack leaf switch: 48 ten-gigabit copper server ports and 6 forty-gigabit optical fabric uplinks, jumbo frames',
  category: 'data-centre',
  icon: 'dc-leaf',
  family: 'nf-n9k',
  variant: 'Leaf 48x10G',
  tags: ['data centre', 'leaf', 'top of rack', 'layer 3', '10g', '40g', 'jumbo', 'fibre'],
  capabilities: ['layer3-switch'],
  ports: [...range(tenGigCopper, 'Ethernet', 1, 48), ...range((n) => ({ ...fortyGigOptic(n), group: 'uplink' }), 'FortyGigabitEthernet', 49, 6)],
};

/** NF-N9K-32F — spine: 32 × 40G optical fabric ports. */
export const NF_N9K_32_INPUT: ModelInput = {
  type: 'dcswitch.nfn9k-32',
  model: 'NF-N9K-32F',
  description: 'Spine switch: 32 forty-gigabit optical fabric ports, jumbo frames',
  category: 'data-centre',
  icon: 'dc-spine',
  family: 'nf-n9k',
  variant: 'Spine 32x40G',
  tags: ['data centre', 'spine', 'fabric', 'layer 3', '40g', 'jumbo', 'fibre'],
  capabilities: ['layer3-switch'],
  ports: range(fortyGigOptic, 'FortyGigabitEthernet', 1, 32),
};

/** Data-centre inputs in palette order (CATALOG.md order). */
export const DATACENTRE_INPUTS: readonly ModelInput[] = Object.freeze([NF_N9K_48_INPUT, NF_N9K_32_INPUT]);

/** Data-centre models defined for DATACENTRE_DATA_STAGE, in palette order. */
export const DATACENTRE_MODELS: readonly DeviceModel[] = Object.freeze(DATACENTRE_INPUTS.map((input) => defineModel(input, DATACENTRE_DATA_STAGE)));
