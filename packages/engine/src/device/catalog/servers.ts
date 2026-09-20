/**
 * device/catalog/servers.ts — Servers palette category (docs/CATALOG.md "End devices"; ARCHITECTURE-P1 D2).
 *
 * Servers declare `server`, which implies `host`: in P0.5 they run the host daemons and the host shell; the service
 * daemons (dhcp-server, dns-server, http-server) and the Services panel arrive with the P1 stage derivation.
 * All wording is original (D13).
 */
import type { DeviceModel } from '../../contracts/device.js';
import { SPEED_10G, SPEED_1G } from '../../contracts/port.js';
import type { ModelInput } from './define.js';
import { defineModel } from './define.js';
import { END_DEVICE_STAGE, EXPANSION_BAY, hostEth } from './computers.js';

/** NF-SERVER — tower server with two gigabit adapters and an expansion bay. */
export const NF_SERVER_MODEL_INPUT: ModelInput = {
  type: 'server.nfserver',
  model: 'NF-SERVER',
  description: 'Tower server with two gigabit network adapters, ready to host network services',
  category: 'servers',
  icon: 'server',
  capabilities: ['server'],
  ports: [hostEth('GigabitEthernet0', SPEED_1G), hostEth('GigabitEthernet1', SPEED_1G)],
  family: 'nf-server',
  variant: 'Tower',
  tags: ['server', 'services', 'host', 'end device'],
  slots: [EXPANSION_BAY],
};

/** NF-SERVER-RACK — rack server with four gigabit and two ten-gigabit adapters. */
export const NF_SERVER_RACK_MODEL_INPUT: ModelInput = {
  type: 'server.nfrack',
  model: 'NF-SERVER-RACK',
  description: 'Rack-mounted server with four gigabit and two ten-gigabit network adapters',
  category: 'servers',
  icon: 'server-rack',
  capabilities: ['server'],
  ports: [
    hostEth('GigabitEthernet0', SPEED_1G),
    hostEth('GigabitEthernet1', SPEED_1G),
    hostEth('GigabitEthernet2', SPEED_1G),
    hostEth('GigabitEthernet3', SPEED_1G),
    hostEth('TenGigabitEthernet0', SPEED_10G, { group: 'uplink' }),
    hostEth('TenGigabitEthernet1', SPEED_10G, { group: 'uplink' }),
  ],
  family: 'nf-server',
  variant: 'Rack',
  tags: ['server', 'rack', 'data centre', 'services', '10g', 'host', 'end device'],
};

/** Catalog inputs of the Servers category, in palette order. */
export const SERVER_MODEL_INPUTS: readonly ModelInput[] = Object.freeze([NF_SERVER_MODEL_INPUT, NF_SERVER_RACK_MODEL_INPUT]);

/** Servers category models defined for END_DEVICE_STAGE, in palette order. */
export const SERVER_MODELS: readonly DeviceModel[] = Object.freeze(SERVER_MODEL_INPUTS.map((m) => defineModel(m, END_DEVICE_STAGE)));
