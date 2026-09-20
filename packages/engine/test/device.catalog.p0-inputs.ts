/**
 * The three P0 models re-authored as catalog inputs for `defineModel` (shared by the catalog W1 tests).
 * Port speeds, names and descriptions are exactly those of device/catalog.ts.
 */
import type { ModelInput, PortInput } from '../src/device/catalog/define.js';
import { SPEED_100M, SPEED_1G } from '../src/contracts/port.js';

/** P0 ethernet port helper (same speeds list as device/catalog.ts). */
export function ethInput(name: string, speedBps: number, autoMdix: boolean): PortInput {
  const speeds = speedBps >= SPEED_1G ? [SPEED_1G, SPEED_100M, 10_000_000] : [SPEED_100M, 10_000_000];
  return { name, kind: 'ethernet', speedBps, speeds, autoMdix };
}

/** `count` ports `${family}${slot}/${first + i}`. */
export function ethRangeInput(family: string, slot: string, first: number, count: number, speedBps: number, autoMdix: boolean): PortInput[] {
  const out: PortInput[] = [];
  for (let i = 0; i < count; i++) out.push(ethInput(`${family}${slot}/${first + i}`, speedBps, autoMdix));
  return out;
}

export const NF_PC_INPUT: ModelInput = {
  type: 'pc.nfpc',
  model: 'NF-PC',
  description: 'Workstation with one gigabit network adapter and a host shell',
  category: 'computers',
  icon: 'pc',
  capabilities: ['host'],
  ports: [ethInput('GigabitEthernet0', SPEED_1G, false)],
};

export const NF_C2960_INPUT: ModelInput = {
  type: 'switch.nfc2960',
  model: 'NF-C2960',
  description: 'Layer-2 access switch: 24 fast-ethernet ports and 2 gigabit uplinks',
  category: 'switches',
  icon: 'switch',
  capabilities: ['switching'],
  ports: [
    ...ethRangeInput('FastEthernet', '0', 1, 24, SPEED_100M, true),
    ...ethRangeInput('GigabitEthernet', '0', 1, 2, SPEED_1G, true),
  ],
};

export const NF_2911_INPUT: ModelInput = {
  type: 'router.nf2911',
  model: 'NF-2911',
  description: 'Branch router: 2 gigabit ethernet ports, 2 serial WAN ports, console',
  category: 'routers',
  icon: 'router',
  capabilities: ['routing'],
  ports: [
    ...ethRangeInput('GigabitEthernet', '0', 0, 2, SPEED_1G, false),
    { name: 'Serial0/0/0', short: 'Se0/0/0', kind: 'serial', speedBps: 2_000_000, serial: {} },
    { name: 'Serial0/0/1', short: 'Se0/0/1', kind: 'serial', speedBps: 2_000_000, serial: {} },
    { name: 'Console', short: 'Con', kind: 'console', speedBps: 9_600 },
  ],
};

/** Inputs in P0 palette order. */
export const P0_INPUTS: readonly ModelInput[] = [NF_PC_INPUT, NF_C2960_INPUT, NF_2911_INPUT];
