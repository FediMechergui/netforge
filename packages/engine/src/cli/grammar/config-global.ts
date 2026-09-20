/**
 * cli/grammar/config-global.ts — global configuration commands (spec §7.3, §7.4; ARCHITECTURE "P0 CLI surface",
 * ARCHITECTURE-P1 §6): host name, interface selection (physical, module and fixed ports), static routes, the
 * banner, the enable secret and the management default gateway.
 *
 * `interface <name>` here accepts every name that is not a virtual interface name (`PHYSICAL_NAME_PATTERN`) and
 * has no `no` form: fixed and module ports cannot be removed. Creatable virtual interfaces (`interface Vlan10`,
 * `no interface Loopback1`) are the svi.ts fragment, which shares the `config.interface` handler.
 * Help strings are original wording (spec §1.6).
 */
import type { CommandSpec } from '../../contracts/cli.js';
import {
  CONFIGURABLE_ROLES,
  ifaceArg,
  ipv4Arg,
  maskArg,
  NFOS_ONLY,
  PHYSICAL_NAME_PATTERN,
  restArg,
  secretArg,
  wordArg,
} from './core-exec.js';

/** Handler ids of the global configuration commands. */
export const CONFIG_GLOBAL_HANDLERS = {
  configHostname: 'config.hostname',
  configInterface: 'config.interface',
  configIpRoute: 'config.ip-route',
  configBanner: 'config.banner',
  configEnableSecret: 'config.enable-secret',
  configDefaultGateway: 'config.default-gateway',
} as const;

/** Mismatch text for `interface <port>` on a port that has no settings (a console line). */
export const MSG_INTERFACE_NOT_CONFIGURABLE = '% That port has no interface settings to configure.';

/** Arg name the banner handler reads the banner type from (`fixedArgs`); `banner login|exec` are in line-auth.ts. */
export const BANNER_TYPE_ARG = 'type';

const H = CONFIG_GLOBAL_HANDLERS;

/** The global configuration command table. */
export const CONFIG_GLOBAL_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    path: ['hostname', '<name>'],
    mode: 'config',
    privilege: 15,
    help: 'Set the device name shown in the prompt',
    args: { name: wordArg('New device name') },
    handler: H.configHostname,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    objectives: ['CCNA1.2.4'],
  },
  {
    path: ['interface', '<iface>'],
    mode: 'config',
    privilege: 15,
    help: 'Select an interface to configure',
    args: {
      iface: ifaceArg('Interface name, e.g. GigabitEthernet0/0 or g0/0', {
        pattern: PHYSICAL_NAME_PATTERN,
        portFilter: { roles: CONFIGURABLE_ROLES, mismatch: MSG_INTERFACE_NOT_CONFIGURABLE },
      }),
    },
    handler: H.configInterface,
    entersMode: 'config-if',
    sessionEffect: 'enter-mode',
    grammars: NFOS_ONLY,
    objectives: ['CCNA1.10.2'],
  },
  {
    path: ['ip', 'route', '<network>', '<mask>', '<nexthop>'],
    mode: 'config',
    privilege: 15,
    help: 'Add a static route',
    args: {
      network: ipv4Arg('Destination network address'),
      mask: maskArg('Destination network mask'),
      nexthop: wordArg('Next-hop address (A.B.C.D) or exit interface'),
    },
    handler: H.configIpRoute,
    allowNo: true,
    grammars: NFOS_ONLY,
    requiresAny: ['routing'],
    objectives: ['CCNA2.1.3'],
  },
  {
    path: ['ip', 'default-gateway', '<gateway>'],
    mode: 'config',
    privilege: 15,
    help: 'Gateway used by the management address of a device that does not route',
    args: { gateway: ipv4Arg('Default gateway address') },
    handler: H.configDefaultGateway,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    requiresAny: ['switching', 'wifi-ap'],
    since: 'P0.5',
    objectives: ['CCNA1.10.2'],
  },
  {
    path: ['banner', 'motd', '<text>'],
    mode: 'config',
    privilege: 15,
    help: 'Message shown before login',
    args: { text: restArg('Banner text') },
    handler: H.configBanner,
    allowNo: true,
    noArgsOptional: true,
    fixedArgs: { [BANNER_TYPE_ARG]: 'motd' },
    grammars: NFOS_ONLY,
    objectives: ['CCNA1.2.4'],
  },
  {
    path: ['enable', 'secret', '<secret>'],
    mode: 'config',
    privilege: 15,
    help: 'Password required to enter privileged mode',
    args: { secret: secretArg('The secret (stored hashed, never shown again)') },
    handler: H.configEnableSecret,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    objectives: ['CCNA1.2.4'],
  },
]);
