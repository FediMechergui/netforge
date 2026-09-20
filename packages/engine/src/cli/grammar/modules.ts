/**
 * cli/grammar/modules.ts — hardware inventory of modular devices (ARCHITECTURE-P1 D7, §3.11, §3.13):
 * `show inventory` lists the chassis, every slot with its installed module or transceiver, and the ports each
 * module adds. Modules are inserted and removed from the Physical panel while the device is off, not from the CLI.
 * Help strings are original wording (spec §1.6).
 */
import type { CommandSpec } from '../../contracts/cli.js';
import { NFOS_ONLY } from './core-exec.js';

/** Handler ids of the modules fragment. */
export const MODULES_HANDLERS = {
  showInventory: 'show.inventory',
} as const;

/** The modules command table. */
export const MODULES_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    path: ['show', 'inventory'],
    mode: '@exec',
    privilege: 1,
    help: 'Chassis, slots, installed modules and transceivers',
    handler: MODULES_HANDLERS.showInventory,
    filterable: true,
    grammars: NFOS_ONLY,
    requiresAny: ['modular'],
    since: 'P0.5',
    objectives: ['CCNA1.4.1'],
  },
]);
