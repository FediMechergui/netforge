/**
 * cli/grammar/host-shell.ts — the end-device host shell (ARCHITECTURE "P0 CLI surface", ARCHITECTURE-P1 §3.13, §6):
 * a single `user-exec` mode at privilege 15 with `ip address A M [GW]`, `ipconfig [/all|/release|/renew]`, `arp -a`,
 * the Wi-Fi commands `wifi list|connect|disconnect` (devices with a Wi-Fi adapter) and `adapter <if> up|down`, plus
 * the P1 additions of §6: `ip address dhcp`, `ip dns`, `ipv6 address`, `ipv6 autoconfig` and `ipv6config`, and the
 * P2 expansions of ARCHITECTURE-P2 §5.5: `ipv6 address dhcp [<adapter>]` (the IP configuration app's "automatic
 * with DHCPv6" choice) and [S4] `voice vlan <v>` (the IP phone's Voice VLAN field, hosts with a built-in bridge).
 *
 * The shared `ping`, `exit`, `nslookup`, `netstat`, `tracert` and `show …` subset come from core-exec.ts, show.ts and
 * the feature fragments. Every host command expands into the canonical config lines of §6 (the same lines a network
 * OS stores), so running-config text and GUI panels need no host-specific parsing. `adapter` is listed by `?` from
 * P1 on, with the other host additions (ARCHITECTURE-P1 §9.2). Help strings are original (spec §1.6).
 */
import type { CommandSpec } from '../../contracts/cli.js';
import {
  choiceArg,
  CONFIGURABLE_ROLES,
  HOST_ONLY,
  ifaceArg,
  intArg,
  IPV6_CAPABILITIES,
  ipArg,
  ipv4Arg,
  maskArg,
  prefix6Arg,
  wordArg,
} from './core-exec.js';
import { DHCP_CLIENT_CAPABILITIES } from './dhcp.js';
import { DNS_CLIENT_CAPABILITIES } from './dns.js';

/** Handler ids of the host shell. */
export const HOST_SHELL_HANDLERS = {
  pcIpAddress: 'pc.ip-address',
  pcIpconfig: 'pc.ipconfig',
  pcArp: 'pc.arp',
  hostWifiList: 'host.wifi-list',
  hostWifiConnect: 'host.wifi-connect',
  hostWifiDisconnect: 'host.wifi-disconnect',
  hostAdapter: 'host.adapter',
  hostIpAddressDhcp: 'host.ip-address-dhcp',
  hostIpDns: 'host.ip-dns',
  hostIpv6Address: 'host.ipv6-address',
  hostIpv6Autoconfig: 'host.ipv6-autoconfig',
  hostIpv6config: 'host.ipv6config',
  /** @since P2 `ipv6 address dhcp [<adapter>]` (§5.5 host-shell expansion: the IP configuration app's DHCPv6 choice). */
  hostIpv6AddressDhcp: 'host.ipv6-address-dhcp',
  /** @since P2 [S4] `voice vlan <v>` (the IP phone's Voice VLAN field, §5.5). */
  hostVoiceVlan: 'host.voice-vlan',
} as const;

/** Arg name of the `ipconfig` option, and the options it takes (`fixedArgs`-free: one spec, one handler). */
export const IPCONFIG_OPTION_ARG = 'option';
export const IPCONFIG_ALL = '/all';
export const IPCONFIG_RENEW = '/renew';
export const IPCONFIG_RELEASE = '/release';
/** Options `ipconfig` accepts, in help order. */
export const IPCONFIG_OPTIONS: readonly string[] = Object.freeze([IPCONFIG_ALL, IPCONFIG_RELEASE, IPCONFIG_RENEW]);

/** Adapter argument of a host command: an existing adapter of this host, completed from `model.hostPorts`. */
function adapterArg(optional: boolean): ReturnType<typeof ifaceArg> {
  return ifaceArg('Network adapter name (the first adapter when left out)', {
    ...(optional ? { optional: true } : {}),
    completion: 'host-adapters',
    portFilter: { roles: CONFIGURABLE_ROLES },
  });
}

const H = HOST_SHELL_HANDLERS;

/** The host shell command table. */
export const HOST_SHELL_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    path: ['ip', 'address', '<address>', '<mask>', '<gateway>'],
    mode: 'user-exec',
    privilege: 15,
    help: 'Set this host\'s IPv4 address, mask and optional default gateway',
    args: {
      address: ipv4Arg('IPv4 address of this host'),
      mask: maskArg('Subnet mask'),
      gateway: ipv4Arg('Default gateway address', true),
    },
    handler: H.pcIpAddress,
    allowNo: true,
    noArgsOptional: true,
    grammars: HOST_ONLY,
    objectives: ['CCNA1.10.1'],
  },
  {
    path: ['ipconfig', '<option>'],
    mode: 'user-exec',
    privilege: 15,
    help: 'Show this host\'s network adapter settings',
    args: {
      option: choiceArg('/all adds the lease and name servers; /release and /renew act on the DHCP lease', IPCONFIG_OPTIONS, true),
    },
    handler: H.pcIpconfig,
    grammars: HOST_ONLY,
    objectives: ['CCNA1.10.1'],
  },
  {
    path: ['ip', 'address', 'dhcp', '<adapter>'],
    mode: 'user-exec',
    privilege: 15,
    help: 'Ask a DHCP server for this host\'s address',
    args: { adapter: adapterArg(true) },
    handler: H.hostIpAddressDhcp,
    allowNo: true,
    noArgsOptional: true,
    grammars: HOST_ONLY,
    requiresAny: DHCP_CLIENT_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.11.2'],
  },
  {
    path: ['ip', 'dns', '<first>', '<second>'],
    mode: 'user-exec',
    privilege: 15,
    help: 'Name servers this host asks to resolve names',
    args: { first: ipArg('Name server address'), second: ipArg('Second name server address', true) },
    handler: H.hostIpDns,
    allowNo: true,
    noArgsOptional: true,
    grammars: HOST_ONLY,
    requiresAny: DNS_CLIENT_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.11.1'],
  },
  // P2 (§5.5): the literal `dhcp` forms come before the `<prefix>` forms so the keyword wins the match.
  {
    path: ['ipv6', 'address', 'dhcp'],
    mode: 'user-exec',
    privilege: 15,
    help: 'Ask a DHCPv6 server for this host\'s IPv6 address',
    handler: H.hostIpv6AddressDhcp,
    allowNo: true,
    noArgsOptional: true,
    grammars: HOST_ONLY,
    requiresAny: IPV6_CAPABILITIES,
    since: 'P2',
    objectives: ['CCNA2.10.2'],
  },
  {
    path: ['ipv6', 'address', 'dhcp', '<adapter>'],
    mode: 'user-exec',
    privilege: 15,
    help: 'Ask a DHCPv6 server for the IPv6 address of one adapter',
    args: { adapter: adapterArg(false) },
    handler: H.hostIpv6AddressDhcp,
    allowNo: true,
    grammars: HOST_ONLY,
    requiresAny: IPV6_CAPABILITIES,
    since: 'P2',
    objectives: ['CCNA2.10.2'],
  },
  {
    path: ['ipv6', 'address', '<prefix>'],
    mode: 'user-exec',
    privilege: 15,
    help: 'Set this host\'s IPv6 address',
    args: { prefix: prefix6Arg('IPv6 address with its prefix length') },
    handler: H.hostIpv6Address,
    allowNo: true,
    noArgsOptional: true,
    grammars: HOST_ONLY,
    requiresAny: IPV6_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.12.2'],
  },
  {
    path: ['ipv6', 'address', '<adapter>', '<prefix>'],
    mode: 'user-exec',
    privilege: 15,
    help: 'Set the IPv6 address of one adapter',
    args: { adapter: adapterArg(false), prefix: prefix6Arg('IPv6 address with its prefix length') },
    handler: H.hostIpv6Address,
    grammars: HOST_ONLY,
    requiresAny: IPV6_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.12.2'],
  },
  {
    path: ['ipv6', 'autoconfig', '<adapter>'],
    mode: 'user-exec',
    privilege: 15,
    help: 'Build this host\'s IPv6 address from what a router advertises',
    args: { adapter: adapterArg(true) },
    handler: H.hostIpv6Autoconfig,
    allowNo: true,
    noArgsOptional: true,
    grammars: HOST_ONLY,
    requiresAny: IPV6_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.12.4'],
  },
  // [S4] the IP phone's voice VLAN (§5.5): a host with a built-in bridge tags its own frames with it
  {
    path: ['voice', 'vlan', '<vlan>'],
    mode: 'user-exec',
    privilege: 15,
    help: 'VLAN this phone tags its own traffic with on its network port',
    args: { vlan: intArg('VLAN number', 1, 4094) },
    handler: H.hostVoiceVlan,
    allowNo: true,
    noArgsOptional: true,
    grammars: HOST_ONLY,
    requiresAny: ['switching'],
    since: 'P2',
    objectives: ['CCNA2.2.1'],
  },
  {
    path: ['ipv6config'],
    mode: 'user-exec',
    privilege: 15,
    help: 'Show this host\'s IPv6 addresses, router and neighbours',
    handler: H.hostIpv6config,
    filterable: true,
    grammars: HOST_ONLY,
    requiresAny: IPV6_CAPABILITIES,
    since: 'P1',
    objectives: ['CCNA1.12.2'],
  },
  {
    path: ['arp', '-a'],
    mode: 'user-exec',
    privilege: 15,
    help: 'List the ARP cache of this host',
    handler: H.pcArp,
    grammars: HOST_ONLY,
    objectives: ['CCNA1.9.2'],
  },
  {
    path: ['wifi', 'list'],
    mode: 'user-exec',
    privilege: 15,
    help: 'Show the wireless networks in range and the current connection',
    handler: H.hostWifiList,
    grammars: HOST_ONLY,
    requiresAny: ['wifi-client'],
    since: 'P0.5',
    objectives: ['CCNA1.13.2'],
  },
  {
    path: ['wifi', 'connect', '<ssid>'],
    mode: 'user-exec',
    privilege: 15,
    help: 'Join an open wireless network',
    args: { ssid: wordArg('Network name', { maxLength: 32, completion: 'ssids-seen' }) },
    handler: H.hostWifiConnect,
    grammars: HOST_ONLY,
    requiresAny: ['wifi-client'],
    since: 'P0.5',
    objectives: ['CCNA1.13.2'],
  },
  {
    path: ['wifi', 'connect', '<ssid>', 'key', '<key>'],
    mode: 'user-exec',
    privilege: 15,
    help: 'Join a protected wireless network with its passphrase',
    args: {
      ssid: wordArg('Network name', { maxLength: 32, completion: 'ssids-seen' }),
      key: wordArg('Passphrase, 8 to 63 characters', { maxLength: 63 }),
    },
    handler: H.hostWifiConnect,
    grammars: HOST_ONLY,
    requiresAny: ['wifi-client'],
    since: 'P0.5',
    objectives: ['CCNA1.13.3'],
  },
  {
    path: ['wifi', 'disconnect'],
    mode: 'user-exec',
    privilege: 15,
    help: 'Leave the current wireless network',
    handler: H.hostWifiDisconnect,
    grammars: HOST_ONLY,
    requiresAny: ['wifi-client'],
    since: 'P0.5',
    objectives: ['CCNA1.13.2'],
  },
  {
    path: ['adapter', '<iface>', '<state>'],
    mode: 'user-exec',
    privilege: 15,
    help: 'Enable or disable a network adapter',
    args: {
      iface: ifaceArg('Network adapter name', { portFilter: { roles: CONFIGURABLE_ROLES } }),
      state: choiceArg('up enables the adapter, down disables it', ['up', 'down']),
    },
    handler: H.hostAdapter,
    grammars: HOST_ONLY,
    since: 'P0.5',
    objectives: ['CCNA1.10.1'],
  },
]);
