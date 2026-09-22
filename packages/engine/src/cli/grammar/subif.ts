/**
 * cli/grammar/subif.ts — interface selection beyond one physical port (ARCHITECTURE-P2 §2.11, §3.4, §5.1, §5.2, D11;
 * §7 W2 cli): the `encapsulation dot1Q <vid> [native]` line of a router subinterface, and `interface range <ranges>`
 * (mode `config-if-range`: the session holds the port list and applies each line to each port, cli/runtime.ts).
 *
 * A subinterface itself is entered through the `interface <iface>` spec below, which accepts only subinterface names
 * (`SUBIF_NAME_PATTERN`; `g0/0.10` resolves to a creatable `subinterface` virtual port, names.ts) so that it never
 * competes with the physical spec of config-global.ts or the virtual one of svi.ts, and which — like the virtual
 * one — has a `no` form (`no interface g0/0.10` removes the subinterface through `removeVirtualPort`). Its handler
 * (`config.subinterface`: the P1 `interface` handler registered under a P2 id, cli/handlers/subif.ts) enters
 * `config-subif`, where the runtime offers every `config-if` line whose port requirement the subinterface meets
 * (`ip address`, `shutdown`, `description`, the IPv6 lines). `encapsulation dot1Q` is offered on routed Ethernet
 * ports too, so that a learner who types it on the physical port is told where it belongs
 * (`CLI_MESSAGES.encapNotHere`) instead of "unrecognized".
 * Help strings are original wording (spec §1.6).
 */
import type { CommandSpec } from '../../contracts/cli.js';
import { CONFIGURABLE_ROLES, SUBIF_NAME_PATTERN, choiceArg, ifaceArg, intArg, NFOS_ONLY } from './core-exec.js';
import { MSG_INTERFACE_NOT_CONFIGURABLE } from './config-global.js';

/** Handler ids of the subinterface / interface-range fragment. Never rename. */
export const SUBIF_HANDLERS = {
  /** `interface <parent>.<n>` / `no interface <parent>.<n>`: the P1 `config.interface` handler under a P2 id. */
  configSubinterface: 'config.subinterface',
  configInterfaceRange: 'config.interface-range',
  ifEncapsulationDot1q: 'if.encapsulation-dot1q',
} as const;

/** The 802.1Q keyword as the running configuration stores it (`encapsulation dot1Q 10`, §5.2); typed in any case. */
export const DOT1Q_KEYWORD = 'dot1Q';
/** The keyword as the grammar lists it (path literals are lower case; the parser matches typed tokens case-blind). */
export const DOT1Q_LITERAL = 'dot1q';

/** Arg name of the optional `native` keyword. */
export const DOT1Q_NATIVE_ARG = 'native';

const H = SUBIF_HANDLERS;

/** The subinterface and interface-range command table. */
export const SUBIF_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    path: ['interface', '<iface>'],
    mode: 'config',
    privilege: 15,
    help: 'Select an interface to configure',
    args: {
      iface: ifaceArg('Subinterface name, e.g. GigabitEthernet0/0.10 or g0/0.10', {
        pattern: SUBIF_NAME_PATTERN,
        portFilter: { kinds: ['virtual'] },
      }),
    },
    handler: H.configSubinterface,
    entersMode: 'config-subif',
    sessionEffect: 'enter-mode',
    allowNo: true,
    grammars: NFOS_ONLY,
    requiresAny: ['routing'],
    since: 'P2',
    objectives: ['CCNA2.3.1'],
  },
  {
    path: ['interface', 'range', '<range>'],
    mode: 'config',
    privilege: 15,
    help: 'Select several interfaces at once, e.g. fa0/1 - 12, gi0/1',
    args: {
      range: {
        type: 'if-range',
        help: 'Interfaces and ranges, e.g. fa0/1 - 12, gi0/1',
        portFilter: { roles: CONFIGURABLE_ROLES, mismatch: MSG_INTERFACE_NOT_CONFIGURABLE },
      },
    },
    handler: H.configInterfaceRange,
    entersMode: 'config-if-range',
    sessionEffect: 'enter-mode',
    grammars: NFOS_ONLY,
    // §5.1 lists the range under switching: devices that bridge (an L2 or multilayer switch, a router with a switch
    // module). A plain router's `interface ?` listing therefore keeps its P1 tokens (cli.runtime.sessions.test.ts).
    requiresAny: ['switching'],
    since: 'P2',
    objectives: ['CCNA2.4.1'],
  },
  {
    path: ['encapsulation', DOT1Q_LITERAL, '<vid>', `<${DOT1Q_NATIVE_ARG}>`],
    mode: 'config-if',
    privilege: 15,
    help: '802.1Q VLAN this subinterface carries (native: the untagged VLAN of the link)',
    args: {
      vid: intArg('VLAN number carried by this subinterface', 1, 4094),
      [DOT1Q_NATIVE_ARG]: choiceArg('This subinterface takes the untagged frames', ['native'], true),
    },
    handler: H.ifEncapsulationDot1q,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    requiresAny: ['routing'],
    portRequires: { kinds: ['ethernet', 'virtual'], roles: ['routed', 'subif'] },
    since: 'P2',
    objectives: ['CCNA2.3.1'],
  },
]);
