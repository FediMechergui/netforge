/**
 * device/catalog/voice.ts — Voice palette category (docs/CATALOG.md "End devices"; ARCHITECTURE-P1 D2, D3, §3.10).
 *
 * NF-IPPHONE is a host with a built-in two-port bridge: `FastEthernet0` goes to the network (and draws PoE),
 * `FastEthernet1` passes a desk computer through. Both ports are `switched` bridge members, so the phone's own
 * address lives on the auto switch virtual interface `Vlan1`, which starts up (unlike a switch's management SVI) and
 * whose egress belongs to eth-switch. `Vlan1` is therefore the phone's only host adapter. The network port is wired
 * MDI (a straight cable to an access switch); the pass-through port keeps the bridged-role MDI-X wiring (a straight
 * cable from the computer). All wording is original (D13).
 */
import type { DeviceModel } from '../../contracts/device.js';
import { SPEED_100M } from '../../contracts/port.js';
import type { VirtualFamilySpec } from '../../contracts/catalog.js';
import type { ModelInput } from './define.js';
import { defineModel } from './define.js';
import { END_DEVICE_STAGE, hostEth } from './computers.js';

/** The phone's virtual interface family: only `Vlan1`, created at construction and administratively up. */
export const IP_PHONE_VLAN_FAMILY: VirtualFamilySpec = Object.freeze({
  family: 'Vlan',
  short: 'Vl',
  role: 'svi',
  min: 1,
  max: 1,
  defaultAdminUp: true,
  auto: Object.freeze([1]),
}) as VirtualFamilySpec;

/** NF-IPPHONE — desk phone with a network port and a computer pass-through port. */
export const NF_IPPHONE_MODEL_INPUT: ModelInput = {
  type: 'ipphone.nfphone',
  model: 'NF-IPPHONE',
  description: 'Desk telephone for voice over IP, powered from its network port, with a pass-through port for a computer',
  category: 'voice',
  icon: 'ip-phone',
  capabilities: ['host', 'switching', 'poe-powered'],
  ports: [
    hostEth('FastEthernet0', SPEED_100M, { poeDraw: { standard: 'af', drawW: 6.5 }, wiring: 'MDI', group: 'uplink' }),
    hostEth('FastEthernet1', SPEED_100M),
  ],
  virtualFamilies: [IP_PHONE_VLAN_FAMILY],
  tags: ['voip', 'telephone', 'desk phone', 'voice', 'poe', 'pass-through', 'end device'],
};

/** Catalog inputs of the Voice category, in palette order. */
export const VOICE_MODEL_INPUTS: readonly ModelInput[] = Object.freeze([NF_IPPHONE_MODEL_INPUT]);

/** Voice category models defined for END_DEVICE_STAGE, in palette order. */
export const VOICE_MODELS: readonly DeviceModel[] = Object.freeze(VOICE_MODEL_INPUTS.map((m) => defineModel(m, END_DEVICE_STAGE)));
