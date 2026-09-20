/**
 * cli/grammar/svi.ts — creatable virtual interfaces (ARCHITECTURE-P1 §3.10, §3.13, §6): `interface Vlan<n>`,
 * `interface Loopback<n>` (also typed as `interface vlan 1`) and `no interface …`.
 *
 * The spec accepts only virtual interface names (`VIRTUAL_NAME_PATTERN`), so it never competes with the physical
 * `interface <name>` spec of config-global.ts, and it is the only `interface` form with a `no` form: fixed and module
 * ports cannot be removed (`no interface Gi0/0` reports that the command has no `no` form). Creation goes through
 * `CommandCtx.device.ensureVirtualPort` and the `interface` section line; removal through `removeVirtualPort`
 * (auto instances such as a home router's Vlan1 answer the built-in error). Help strings are original (spec §1.6).
 */
import type { CommandSpec } from '../../contracts/cli.js';
import { ifaceArg, NFOS_ONLY, VIRTUAL_NAME_PATTERN } from './core-exec.js';
import { CONFIG_GLOBAL_HANDLERS } from './config-global.js';

/** The virtual interface command table. */
export const SVI_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    path: ['interface', '<iface>'],
    mode: 'config',
    privilege: 15,
    help: 'Select an interface to configure',
    args: {
      iface: ifaceArg('Interface name, e.g. GigabitEthernet0/0 or g0/0', {
        pattern: VIRTUAL_NAME_PATTERN,
        portFilter: { kinds: ['virtual'] },
      }),
    },
    handler: CONFIG_GLOBAL_HANDLERS.configInterface,
    entersMode: 'config-if',
    sessionEffect: 'enter-mode',
    allowNo: true,
    grammars: NFOS_ONLY,
    // `wifi-ap` is in the set because an access point carries the same management Vlan1 as an L2 switch, and it
    // has neither `routing` nor `switching` of its own (its bridge comes from the wifi-ap daemon list).
    requiresAny: ['routing', 'switching', 'wifi-ap'],
    since: 'P0.5',
    objectives: ['CCNA1.10.2', 'CCNA2.4.1'],
  },
]);
