/**
 * device/catalog/switches.ts — the Switches palette category (docs/CATALOG.md "Network devices"; ARCHITECTURE-P1 D2,
 * D3).
 *
 * Layer-2 access switches. Copper ports are auto-MDIX (either copper cable works) and take the `switched` role
 * (MDI-X by default). SFP/SFP+ uplinks are cages bound to transceiver slots (D7). PoE models declare a power budget
 * and power-sourcing ports (data now, behaviour P2+).
 *
 * NF-C2960 is the P0 model: its input is field-for-field the P0 literal of device/catalog.ts.
 *
 * All names, descriptions, labels and tags are original wording (§1.6, D13).
 */
import type { DeviceModel } from '../../contracts/device.js';
import { SPEED_100M, SPEED_10G, SPEED_10M, SPEED_1G } from '../../contracts/port.js';
import type { BuildStage, PoeSpec, VirtualFamilySpec } from '../../contracts/catalog.js';
import { defineModel, MANAGEMENT_VLAN_FAMILY, type ModelInput, type PortInput, type SlotInput } from './define.js';

/** Build stage the exported `SWITCH_MODELS` are defined for (device/catalog/index.ts re-defines SWITCH_INPUTS for its own stage when it differs). */
export const SWITCH_DATA_STAGE: BuildStage = 'P1';

/**
 * Management SVI family of an L2 access switch (P1 W5): the auto `Vlan1` carries the switch's management address
 * and is administratively down until `no shutdown`, so a freshly placed switch still forwards nothing of its own
 * (§9.2 "P1 W5 (catalog)"). L2 switches derive no family from their capabilities, so it is catalog data here.
 *
 * Deliberate widening of §8.2 W5 / §9.2, which name NF-C2960 alone: EVERY model whose capabilities boot the host
 * stack (arp/ipv4/icmpv4/host) carries the family — the other access switches and the two learning bridges here and
 * in legacy.ts, and the APs through `deriveVirtualFamilies`. Without it those models boot a full IPv4 stack with no
 * interface that could ever hold an address, and the §6 `ip default-gateway` line they accept is dead. §9.2's own
 * CLI bullet states the precondition in the plural ("once L2 switches and APs get the Vlan family (P1 W5)").
 */
export const L2_SWITCH_VLAN_FAMILY: VirtualFamilySpec = MANAGEMENT_VLAN_FAMILY;

/** PoE+ (802.3at class) power-sourcing port, 30 W. */
const POE_PLUS: PoeSpec = { pse: { standard: 'at', maxW: 30 } };

/** Copper fast-ethernet switch port (auto-MDIX, P0 speed list). */
function fast(name: string): PortInput {
  return { name, kind: 'ethernet', speedBps: SPEED_100M, speeds: [SPEED_100M, SPEED_10M], autoMdix: true };
}

/** Copper gigabit switch port (auto-MDIX, P0 speed list). */
function gig(name: string): PortInput {
  return { name, kind: 'ethernet', speedBps: SPEED_1G, speeds: [SPEED_1G, SPEED_100M, SPEED_10M], autoMdix: true };
}

/** `count` ports `${family}${prefix}/${first + i}` built by `make`. */
function range(make: (name: string) => PortInput, family: string, prefix: string, first: number, count: number): PortInput[] {
  return Array.from({ length: count }, (_, i) => make(`${family}${prefix}/${first + i}`));
}

/** Uplink group marker for a port. */
function uplink(port: PortInput): PortInput {
  return { ...port, group: 'uplink' };
}

/** Power-sourcing copper gigabit port. */
function gigPoe(name: string): PortInput {
  return { ...gig(name), poe: POE_PLUS };
}

/** Gigabit SFP uplink cage. */
function sfpCage(name: string): PortInput {
  return { name, kind: 'ethernet', speedBps: SPEED_1G, speeds: [SPEED_1G], connector: 'sfp', group: 'uplink' };
}

/** 10-gigabit SFP+ uplink cage (accepts 10G and 1G optics). */
function sfpPlusCage(name: string): PortInput {
  return { name, kind: 'ethernet', speedBps: SPEED_10G, speeds: [SPEED_10G, SPEED_1G], connector: 'sfp+', group: 'uplink' };
}

/** Transceiver slots for cage ports, in port order (slot id `sfp<number>`, e.g. 'sfp0/25'). */
function cageSlots(type: 'sfp' | 'sfp+', ports: readonly PortInput[]): SlotInput[] {
  return ports.map((p) => {
    const number = p.name.replace(/^[A-Za-z]+/, '');
    const shortFamily = p.name.startsWith('TenGigabitEthernet') ? 'Te' : 'Gi';
    return { id: `sfp${number}`, label: `${type === 'sfp' ? 'SFP' : 'SFP+'} cage ${shortFamily}${number}`, type, numbering: '', cage: p.name };
  });
}

/** NF-C2960-8TC — compact 8-port access switch with one gigabit uplink. */
export const NF_C2960_8_INPUT: ModelInput = {
  type: 'switch.nfc2960-8',
  model: 'NF-C2960-8TC',
  description: 'Compact layer-2 access switch: 8 fast-ethernet ports and 1 dual-purpose gigabit uplink used as copper',
  category: 'switches',
  icon: 'switch',
  family: 'nf-c2960',
  variant: '8-port compact',
  tags: ['switch', 'access', 'layer 2', 'compact', 'desktop'],
  capabilities: ['switching'],
  ports: [...range(fast, 'FastEthernet', '0', 1, 8), uplink(gig('GigabitEthernet0/1'))],
  virtualFamilies: [L2_SWITCH_VLAN_FAMILY],
};

/** NF-C2960 — the P0 24-port access switch (identical P0 fields). */
export const NF_C2960_INPUT: ModelInput = {
  type: 'switch.nfc2960',
  model: 'NF-C2960',
  description: 'Layer-2 access switch: 24 fast-ethernet ports and 2 gigabit uplinks',
  category: 'switches',
  icon: 'switch',
  family: 'nf-c2960',
  variant: '24-port',
  tags: ['switch', 'access', 'layer 2'],
  capabilities: ['switching'],
  ports: [
    ...range((name) => ({ ...fast(name), short: `Fa${name.slice('FastEthernet'.length)}` }), 'FastEthernet', '0', 1, 24),
    ...range((name) => ({ ...gig(name), short: `Gi${name.slice('GigabitEthernet'.length)}` }), 'GigabitEthernet', '0', 1, 2),
  ],
  virtualFamilies: [L2_SWITCH_VLAN_FAMILY],
};

/** NF-C2960-48TT — 48-port access switch. */
export const NF_C2960_48_INPUT: ModelInput = {
  type: 'switch.nfc2960-48',
  model: 'NF-C2960-48TT',
  description: 'Layer-2 access switch: 48 fast-ethernet ports and 2 gigabit uplinks',
  category: 'switches',
  icon: 'switch',
  family: 'nf-c2960',
  variant: '48-port',
  tags: ['switch', 'access', 'layer 2', 'high density'],
  capabilities: ['switching'],
  ports: [...range(fast, 'FastEthernet', '0', 1, 48), ...range((n) => uplink(gig(n)), 'GigabitEthernet', '0', 1, 2)],
  virtualFamilies: [L2_SWITCH_VLAN_FAMILY],
};

const C2960_24PG_SFP: readonly PortInput[] = range(sfpCage, 'GigabitEthernet', '0', 25, 4);

/** NF-C2960-24PG — 24-port gigabit PoE+ switch with four SFP uplink cages. */
export const NF_C2960_24PG_INPUT: ModelInput = {
  type: 'switch.nfc2960-24pg',
  model: 'NF-C2960-24PG',
  description: 'Layer-2 gigabit access switch: 24 power-sourcing copper ports and 4 SFP uplink cages',
  category: 'switches',
  icon: 'switch-poe',
  family: 'nf-c2960',
  variant: '24-port gigabit PoE+',
  tags: ['switch', 'access', 'layer 2', 'gigabit', 'poe', 'sfp', 'fibre'],
  capabilities: ['switching', 'poe-source'],
  poeBudgetW: 370,
  ports: [...range(gigPoe, 'GigabitEthernet', '0', 1, 24), ...C2960_24PG_SFP],
  slots: cageSlots('sfp', C2960_24PG_SFP),
  virtualFamilies: [L2_SWITCH_VLAN_FAMILY],
};

const C9200_48_UPLINKS: readonly PortInput[] = range(sfpPlusCage, 'TenGigabitEthernet', '1/1', 1, 4);

/** NF-C9200-48P — 48-port gigabit PoE+ access switch with four 10G SFP+ uplinks. */
export const NF_C9200_48_INPUT: ModelInput = {
  type: 'switch.nfc9200-48',
  model: 'NF-C9200-48P',
  description: 'Layer-2 gigabit access switch: 48 power-sourcing copper ports and 4 ten-gigabit SFP+ uplink cages',
  category: 'switches',
  icon: 'switch-poe',
  family: 'nf-c9200',
  variant: '48-port gigabit PoE+',
  tags: ['switch', 'access', 'layer 2', 'gigabit', 'poe', 'sfp+', '10g', 'fibre', 'stackable'],
  capabilities: ['switching', 'poe-source'],
  poeBudgetW: 740,
  ports: [...range(gigPoe, 'GigabitEthernet', '1/0', 1, 48), ...C9200_48_UPLINKS],
  slots: cageSlots('sfp+', C9200_48_UPLINKS),
  virtualFamilies: [L2_SWITCH_VLAN_FAMILY],
};

/** Switch inputs in palette order (CATALOG.md order). */
export const SWITCH_INPUTS: readonly ModelInput[] = Object.freeze([
  NF_C2960_8_INPUT,
  NF_C2960_INPUT,
  NF_C2960_48_INPUT,
  NF_C2960_24PG_INPUT,
  NF_C9200_48_INPUT,
]);

/** Switch models defined for SWITCH_DATA_STAGE, in palette order. */
export const SWITCH_MODELS: readonly DeviceModel[] = Object.freeze(SWITCH_INPUTS.map((input) => defineModel(input, SWITCH_DATA_STAGE)));
