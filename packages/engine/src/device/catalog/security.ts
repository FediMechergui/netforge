/**
 * device/catalog/security.ts — the Security palette category (docs/CATALOG.md "Network devices"; ARCHITECTURE-P1
 * D2, D3).
 *
 * Firewalls are routing appliances (`firewall` implies routing; zone policies arrive in P4): routed ports that
 * start administratively down, a router-style shell, Loopback interfaces. The IDS sensor is an end system: its
 * management port `mgmt` holds the address, and its monitor ports receive every frame (`promiscuous`, skipping the
 * MAC filter) without being offered as network adapters.
 *
 * All names, descriptions, labels and tags are original wording (§1.6, D13).
 */
import type { DeviceModel } from '../../contracts/device.js';
import { SPEED_100M, SPEED_10M, SPEED_1G } from '../../contracts/port.js';
import type { BuildStage } from '../../contracts/catalog.js';
import { defineModel, type ModelInput, type PortInput, type SlotInput } from './define.js';

/** Build stage the exported `SECURITY_MODELS` are defined for (device/catalog/index.ts re-defines SECURITY_INPUTS for its own stage when it differs). */
export const SECURITY_DATA_STAGE: BuildStage = 'P2';

/** Console line (9600 baud). */
const CONSOLE: PortInput = { name: 'Console', kind: 'console', speedBps: 9_600 };

/** Copper gigabit port with a fixed MDI wiring (appliance ports, like router ports). */
function gig(name: string): PortInput {
  return { name, kind: 'ethernet', speedBps: SPEED_1G, speeds: [SPEED_1G, SPEED_100M, SPEED_10M], autoMdix: false };
}

/** `count` ports `GigabitEthernet${prefix}/${first + i}` built by `make`. */
function range(make: (name: string) => PortInput, prefix: string, first: number, count: number): PortInput[] {
  return Array.from({ length: count }, (_, i) => make(`GigabitEthernet${prefix}/${first + i}`));
}

/** Gigabit SFP cage. */
function sfpCage(name: string): PortInput {
  return { name, kind: 'ethernet', speedBps: SPEED_1G, speeds: [SPEED_1G], connector: 'sfp' };
}

/** NF-FW-5506 — small stateful firewall appliance. */
export const NF_FW_5506_INPUT: ModelInput = {
  type: 'firewall.nfasa5506',
  model: 'NF-FW-5506',
  description: 'Small stateful firewall appliance: 8 routed gigabit ports and a console',
  category: 'security',
  icon: 'firewall',
  family: 'nf-fw',
  variant: 'Small office',
  tags: ['firewall', 'security', 'appliance', 'stateful', 'edge'],
  capabilities: ['firewall', 'routing'],
  ports: [...range(gig, '1', 1, 8), CONSOLE],
};

const NGFW_SFP: readonly PortInput[] = range(sfpCage, '1', 9, 4);

/** NF-NGFW-1120 — next-generation firewall with four SFP cages. */
export const NF_NGFW_1120_INPUT: ModelInput = {
  type: 'firewall.nfngfw1120',
  model: 'NF-NGFW-1120',
  description: 'Next-generation firewall: 8 routed copper gigabit ports, 4 gigabit SFP cages and a console',
  category: 'security',
  icon: 'firewall',
  family: 'nf-ngfw',
  variant: 'Branch',
  tags: ['firewall', 'security', 'appliance', 'next generation', 'sfp', 'fibre', 'edge'],
  capabilities: ['firewall', 'routing'],
  ports: [...range(gig, '1', 1, 8), ...NGFW_SFP, CONSOLE],
  slots: NGFW_SFP.map((p): SlotInput => {
    const number = p.name.replace(/^[A-Za-z]+/, '');
    return { id: `sfp${number}`, label: `SFP cage Gi${number}`, type: 'sfp', numbering: '', cage: p.name };
  }),
};

/** NF-IDS-SENSOR — network intrusion detection sensor. */
export const NF_IDS_SENSOR_INPUT: ModelInput = {
  type: 'ids.nfsensor',
  model: 'NF-IDS-SENSOR',
  description: 'Network intrusion detection sensor: 1 management port and 2 monitor ports that receive every frame',
  category: 'security',
  icon: 'ids',
  tags: ['ids', 'sensor', 'security', 'monitor', 'intrusion detection', 'span'],
  capabilities: ['host'],
  ports: [
    { ...gig('GigabitEthernet0/0'), role: 'mgmt' },
    { ...gig('GigabitEthernet0/1'), promiscuous: true },
    { ...gig('GigabitEthernet0/2'), promiscuous: true },
  ],
  hostPorts: ['GigabitEthernet0/0'],
};

/** Security inputs in palette order (CATALOG.md order). */
export const SECURITY_INPUTS: readonly ModelInput[] = Object.freeze([NF_FW_5506_INPUT, NF_NGFW_1120_INPUT, NF_IDS_SENSOR_INPUT]);

/** Security models defined for SECURITY_DATA_STAGE, in palette order. */
export const SECURITY_MODELS: readonly DeviceModel[] = Object.freeze(SECURITY_INPUTS.map((input) => defineModel(input, SECURITY_DATA_STAGE)));
