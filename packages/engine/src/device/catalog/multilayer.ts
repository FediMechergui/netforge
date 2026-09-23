/**
 * device/catalog/multilayer.ts — the Multilayer switches palette category (docs/CATALOG.md "Network devices";
 * ARCHITECTURE-P1 D2, D3 "L3 switches").
 *
 * `layer3-switch` implies switching and routing: every ethernet port is `switched` with allowed roles
 * [switched, routed] (`no switchport` flips it), the derived Vlan family gives SVIs with an automatic management
 * Vlan1 (administratively down) and Loopback interfaces. Copper ports are auto-MDIX; uplinks are SFP/SFP+ cages
 * bound to transceiver slots (D7).
 *
 * P2 (ARCHITECTURE-P2 D3, D5, §7 W4 catalog): both models list `managed-switch` explicitly (`layer3-switch` does
 * not imply it, D5), so at stage P2 they derive the L2 control daemons, the Vlan family widened to 1–4094, the
 * Port-channel family and the P2 profile lines (`spanning-tree mode …`, `spanning-tree extend system-id`, and
 * `no ip routing`: a multilayer switch in a P2 world routes only after `ip routing`, §4.4). NF-C9300 defaults to
 * rapid spanning tree (`stpDefaultMode: 'rapid-pvst'`, model data); NF-C3650 keeps the derived 'pvst'.
 *
 * All names, descriptions, labels and tags are original wording (§1.6, D13).
 */
import type { DeviceModel } from '../../contracts/device.js';
import { SPEED_100M, SPEED_10G, SPEED_10M, SPEED_1G } from '../../contracts/port.js';
import type { BuildStage, PoeSpec } from '../../contracts/catalog.js';
import { defineModel, type ModelInput, type PortInput, type SlotInput } from './define.js';

/** Build stage the exported `MULTILAYER_MODELS` are defined for (device/catalog/index.ts re-defines MULTILAYER_INPUTS for its own stage when it differs). */
export const MULTILAYER_DATA_STAGE: BuildStage = 'P2';

/** High-power (802.3bt class) power-sourcing port, 60 W. */
const POE_HIGH: PoeSpec = { pse: { standard: 'bt', maxW: 60 } };

/** `count` ports `${family}${prefix}/${first + i}` built by `make`. */
function range(make: (name: string) => PortInput, family: string, prefix: string, first: number, count: number): PortInput[] {
  return Array.from({ length: count }, (_, i) => make(`${family}${prefix}/${first + i}`));
}

/** Copper gigabit switch port (auto-MDIX). */
function gig(name: string): PortInput {
  return { name, kind: 'ethernet', speedBps: SPEED_1G, speeds: [SPEED_1G, SPEED_100M, SPEED_10M], autoMdix: true };
}

/** Gigabit SFP uplink cage. */
function sfpCage(name: string): PortInput {
  return { name, kind: 'ethernet', speedBps: SPEED_1G, speeds: [SPEED_1G], connector: 'sfp', group: 'uplink' };
}

/** 10-gigabit SFP+ uplink cage (accepts 10G and 1G optics). */
function sfpPlusCage(name: string): PortInput {
  return { name, kind: 'ethernet', speedBps: SPEED_10G, speeds: [SPEED_10G, SPEED_1G], connector: 'sfp+', group: 'uplink' };
}

/** Transceiver slots for cage ports, in port order (slot id `sfp<number>`). */
function cageSlots(type: 'sfp' | 'sfp+', shortFamily: string, ports: readonly PortInput[]): SlotInput[] {
  return ports.map((p) => {
    const number = p.name.replace(/^[A-Za-z]+/, '');
    return { id: `sfp${number}`, label: `${type === 'sfp' ? 'SFP' : 'SFP+'} cage ${shortFamily}${number}`, type, numbering: '', cage: p.name };
  });
}

const C3650_UPLINKS: readonly PortInput[] = range(sfpCage, 'GigabitEthernet', '1/1', 1, 4);

/** NF-C3650-24 — 24-port layer-3 switch with four SFP uplink cages. */
export const NF_C3650_24_INPUT: ModelInput = {
  type: 'mlswitch.nfc3650-24',
  model: 'NF-C3650-24',
  description: 'Layer-3 switch: 24 copper gigabit ports that switch or route, 4 SFP uplink cages, VLAN interfaces',
  category: 'multilayer-switches',
  icon: 'mlswitch',
  family: 'nf-c3650',
  variant: '24-port',
  tags: ['multilayer switch', 'layer 3', 'svi', 'inter-vlan routing', 'gigabit', 'sfp', 'fibre'],
  capabilities: ['layer3-switch', 'managed-switch'],
  ports: [...range(gig, 'GigabitEthernet', '1/0', 1, 24), ...C3650_UPLINKS],
  slots: cageSlots('sfp', 'Gi', C3650_UPLINKS),
};

const C9300_UPLINKS: readonly PortInput[] = range(sfpPlusCage, 'TenGigabitEthernet', '1/1', 1, 8);

/** NF-C9300-48U — 48-port layer-3 switch with high-power PoE and eight 10G SFP+ uplinks. */
export const NF_C9300_48_INPUT: ModelInput = {
  type: 'mlswitch.nfc9300-48',
  model: 'NF-C9300-48U',
  description: 'Layer-3 switch: 48 high-power power-sourcing copper gigabit ports, 8 ten-gigabit SFP+ uplink cages, VLAN interfaces',
  category: 'multilayer-switches',
  icon: 'mlswitch',
  family: 'nf-c9300',
  variant: '48-port high-power PoE',
  tags: ['multilayer switch', 'layer 3', 'svi', 'inter-vlan routing', 'gigabit', 'poe', 'sfp+', '10g', 'fibre', 'stackable'],
  capabilities: ['layer3-switch', 'poe-source', 'managed-switch'],
  stpDefaultMode: 'rapid-pvst',
  poeBudgetW: 1100,
  ports: [...range((n) => ({ ...gig(n), poe: POE_HIGH }), 'GigabitEthernet', '1/0', 1, 48), ...C9300_UPLINKS],
  slots: cageSlots('sfp+', 'Te', C9300_UPLINKS),
};

/** Multilayer switch inputs in palette order (CATALOG.md order). */
export const MULTILAYER_INPUTS: readonly ModelInput[] = Object.freeze([NF_C3650_24_INPUT, NF_C9300_48_INPUT]);

/** Multilayer switch models defined for MULTILAYER_DATA_STAGE, in palette order. */
export const MULTILAYER_MODELS: readonly DeviceModel[] = Object.freeze(MULTILAYER_INPUTS.map((input) => defineModel(input, MULTILAYER_DATA_STAGE)));
