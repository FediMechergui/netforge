/**
 * cli/grammar/config-if.ts — interface configuration commands shared by every port family (spec §7.3, §7.4;
 * ARCHITECTURE "P0 CLI surface", ARCHITECTURE-P1 §3.13, §6): address, shutdown, description, duplex, speed and the
 * MAC override extension.
 *
 * Per-port scoping (`portRequires`) reads the selected interface: `ip address` needs a port whose effective role
 * holds L3 addresses (`L3_PORT`), so a switched port prints `CLI_MESSAGES.switchedPort` while a switch's Vlan
 * interface accepts the line — the P1 rule of ARCHITECTURE-P1 §9.2, which drops the old `requiresAny: ['routing']`
 * now that L2 switches carry an SVI. Duplex, speed and the MAC override exist only on Ethernet ports. Serial,
 * switchport, IPv6, DHCP and radio lines are their own fragments. Help strings are original wording (spec §1.6).
 */
import type { CommandSpec } from '../../contracts/cli.js';
import { choiceArg, ipv4Arg, kindsPort, L3_PORT, maskArg, NFOS_ONLY, restArg } from './core-exec.js';

/** Handler ids of the shared interface commands. */
export const CONFIG_IF_HANDLERS = {
  ifIpAddress: 'if.ip-address',
  ifShutdown: 'if.shutdown',
  ifDescription: 'if.description',
  ifDuplex: 'if.duplex',
  ifSpeed: 'if.speed',
  ifMacAddress: 'if.mac-address',
} as const;

const H = CONFIG_IF_HANDLERS;

/** The shared interface configuration command table. */
export const CONFIG_IF_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    path: ['ip', 'address', '<address>', '<mask>'],
    mode: 'config-if',
    privilege: 15,
    help: 'Set the IPv4 address of this interface',
    args: { address: ipv4Arg('IPv4 address'), mask: maskArg('Subnet mask') },
    handler: H.ifIpAddress,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    portRequires: L3_PORT,
    objectives: ['CCNA1.10.2'],
  },
  {
    path: ['shutdown'],
    mode: 'config-if',
    privilege: 15,
    help: 'Disable this interface (no shutdown enables it)',
    handler: H.ifShutdown,
    allowNo: true,
    grammars: NFOS_ONLY,
    objectives: ['CCNA1.10.2'],
  },
  {
    path: ['description', '<text>'],
    mode: 'config-if',
    privilege: 15,
    help: 'Free-form note about this interface',
    args: { text: restArg('Description text', 240) },
    handler: H.ifDescription,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    objectives: ['CCNA1.10.2'],
  },
  {
    path: ['duplex', '<mode>'],
    mode: 'config-if',
    privilege: 15,
    help: 'Set the duplex mode',
    args: { mode: choiceArg('Duplex mode', ['auto', 'full', 'half']) },
    handler: H.ifDuplex,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    portRequires: kindsPort(['ethernet']),
    objectives: ['CCNA1.4.2'],
  },
  {
    path: ['speed', '<rate>'],
    mode: 'config-if',
    privilege: 15,
    help: 'Set the port speed in megabits per second',
    args: { rate: choiceArg('Speed (auto, 10, 100 or 1000)', ['auto', '10', '100', '1000']) },
    handler: H.ifSpeed,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    portRequires: kindsPort(['ethernet']),
    objectives: ['CCNA1.4.2'],
  },
  {
    path: ['mac-address', '<mac>'],
    mode: 'config-if',
    privilege: 15,
    help: 'Override the hardware address of this interface (NetForge extension)',
    args: { mac: { type: 'mac', help: 'MAC address (H.H.H or HH:HH:HH:HH:HH:HH)' } },
    handler: H.ifMacAddress,
    allowNo: true,
    noArgsOptional: true,
    extension: true,
    grammars: NFOS_ONLY,
    portRequires: kindsPort(['ethernet']),
    objectives: ['CCNA1.7.1'],
  },
]);
