/**
 * cli/grammar/hardening.ts — access-layer hardening on managed switches (ARCHITECTURE-P3 §5.3, D13; §7 W2 cli part 1:
 * "every §5.1–§5.6 configuration line").
 *
 *   global     `ip dhcp snooping`, `ip dhcp snooping vlan <list>`, `no ip dhcp snooping verify mac-address`, `no ip dhcp
 *              snooping information option` (accepted and stored; option 82 is never inserted), `ip source binding
 *              <mac> vlan <v> <ip> interface <if>`, `ip arp inspection vlan <list>`
 *   interface  `ip dhcp snooping trust`, `ip dhcp snooping limit rate <pps>`, `ip arp inspection trust`, `ip arp
 *              inspection limit rate <pps> [burst interval <s>]` / `ip arp inspection limit none`
 * eth-switch reads the lines (protocols/l2/{dhcp-snooping,arp-inspection}.ts, steps 7b/7c); the VLAN lists are
 * stored one line per VLAN (the config rules' `<vlan-list>` element). The `errdisable recovery cause` choices gain
 * `dhcp-rate-limit` and `arp-inspection` in errdisable.ts. The shows are W3's.
 *
 * Scope: `managed-switch` (D13: the decisions run in the VLAN-aware path of managed switches; the controller, which
 * also runs `vlan`, never derives the tables). Interface lines take switched ports and Port-channels. Help strings are
 * original wording (spec §1.6).
 */
import type { ArgSpec, CommandSpec, PortRequirement } from '../../contracts/cli.js';
import type { Capability } from '../../contracts/catalog.js';
import { ifaceArg, intArg, ipv4Arg, NFOS_ONLY } from './core-exec.js';

/** Handler ids of the hardening fragment. Never rename. */
export const HARDENING_HANDLERS = {
  configDhcpSnooping: 'config.ip-dhcp-snooping',
  configIpSourceBinding: 'config.ip-source-binding',
  configArpInspection: 'config.ip-arp-inspection',
  ifDhcpSnooping: 'if.ip-dhcp-snooping',
  ifArpInspection: 'if.ip-arp-inspection',
} as const;

/** @since P3 Capabilities that run the access-layer checks (D13). */
export const HARDENING_CAPABILITIES: readonly Capability[] = Object.freeze(['managed-switch']);

/** @since P3 `fixedArgs` key naming the sub-form of a hardening line. */
export const HARDENING_FORM_ARG = 'form';

/** @since P3 Highest `ip dhcp snooping limit rate` / `ip arp inspection limit rate` (packets per second). */
export const HARDENING_RATE_MAX = 2048;
/** @since P3 Highest `burst interval` of `ip arp inspection limit rate` (seconds). */
export const HARDENING_BURST_MAX_S = 15;

const H = HARDENING_HANDLERS;
const OBJ_SNOOP = ['CCNA3.hardening.3'];
const OBJ_DAI = ['CCNA3.hardening.4'];

const GLOBAL = {
  mode: 'config',
  privilege: 15,
  allowNo: true,
  grammars: NFOS_ONLY,
  requiresAny: HARDENING_CAPABILITIES,
  since: 'P3',
} as const;

/** Interface lines: switched ports and Port-channels. */
const SWITCHED_PORT: PortRequirement = Object.freeze<PortRequirement>({
  roles: ['switched', 'channel'],
  mismatch: '% This setting applies to switched ports; enter "switchport" first.',
});

const IF_LINE = {
  mode: 'config-if',
  privilege: 15,
  allowNo: true,
  grammars: NFOS_ONLY,
  requiresAny: HARDENING_CAPABILITIES,
  portRequires: SWITCHED_PORT,
  since: 'P3',
} as const;

const VLAN_LIST_ARG: ArgSpec = Object.freeze({ type: 'vlan-list', help: 'VLANs: a list such as 10,20,30-35' });
const RATE_ARG: ArgSpec = intArg('Packets per second', 1, HARDENING_RATE_MAX);

/** The hardening command table. */
export const HARDENING_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    ...GLOBAL,
    path: ['ip', 'dhcp', 'snooping'],
    help: 'Check DHCP messages on the VLANs listed by "ip dhcp snooping vlan"',
    handler: H.configDhcpSnooping,
    fixedArgs: { [HARDENING_FORM_ARG]: 'on' },
    objectives: OBJ_SNOOP,
  },
  {
    ...GLOBAL,
    path: ['ip', 'dhcp', 'snooping', 'vlan', '<vlans>'],
    help: 'VLANs whose DHCP messages are checked',
    args: { vlans: VLAN_LIST_ARG },
    handler: H.configDhcpSnooping,
    fixedArgs: { [HARDENING_FORM_ARG]: 'vlan' },
    objectives: OBJ_SNOOP,
  },
  {
    ...GLOBAL,
    path: ['ip', 'dhcp', 'snooping', 'verify', 'mac-address'],
    help: 'Check that a client\'s hardware address matches the frame source (no form stops the check)',
    handler: H.configDhcpSnooping,
    fixedArgs: { [HARDENING_FORM_ARG]: 'verify' },
    objectives: OBJ_SNOOP,
  },
  {
    ...GLOBAL,
    path: ['ip', 'dhcp', 'snooping', 'information', 'option'],
    help: 'Relay information option (stored only: this switch never inserts it)',
    handler: H.configDhcpSnooping,
    fixedArgs: { [HARDENING_FORM_ARG]: 'option' },
    objectives: OBJ_SNOOP,
  },
  {
    ...GLOBAL,
    path: ['ip', 'source', 'binding', '<mac>', 'vlan', '<vlan>', '<address>', 'interface', '<iface>'],
    help: 'A fixed address binding for a host with a static address',
    args: {
      mac: { type: 'mac-any', help: 'Hardware address of the host' },
      vlan: intArg('VLAN of the host', 1, 4094),
      address: ipv4Arg('IPv4 address of the host'),
      iface: ifaceArg('Port the host is on'),
    },
    handler: H.configIpSourceBinding,
    noArgsOptional: true,
    objectives: OBJ_DAI,
  },
  {
    ...GLOBAL,
    path: ['ip', 'arp', 'inspection', 'vlan', '<vlans>'],
    help: 'VLANs whose ARP messages are checked against the snooping bindings',
    args: { vlans: VLAN_LIST_ARG },
    handler: H.configArpInspection,
    objectives: OBJ_DAI,
  },
  {
    ...IF_LINE,
    path: ['ip', 'dhcp', 'snooping', 'trust'],
    help: 'Trust DHCP server messages arriving on this port (the port toward the real server)',
    handler: H.ifDhcpSnooping,
    fixedArgs: { [HARDENING_FORM_ARG]: 'trust' },
    objectives: OBJ_SNOOP,
  },
  {
    ...IF_LINE,
    path: ['ip', 'dhcp', 'snooping', 'limit', 'rate', '<pps>'],
    help: 'DHCP messages per second this port may receive before it is error-disabled',
    args: { pps: RATE_ARG },
    handler: H.ifDhcpSnooping,
    fixedArgs: { [HARDENING_FORM_ARG]: 'limit' },
    noArgsOptional: true,
    objectives: OBJ_SNOOP,
  },
  {
    ...IF_LINE,
    path: ['ip', 'arp', 'inspection', 'trust'],
    help: 'Do not check the ARP messages arriving on this port',
    handler: H.ifArpInspection,
    fixedArgs: { [HARDENING_FORM_ARG]: 'trust' },
    objectives: OBJ_DAI,
  },
  {
    ...IF_LINE,
    path: ['ip', 'arp', 'inspection', 'limit', 'rate', '<pps>'],
    help: 'ARP messages per second this port may receive before it is error-disabled (default 15)',
    args: { pps: intArg('Packets per second', 0, HARDENING_RATE_MAX) },
    handler: H.ifArpInspection,
    fixedArgs: { [HARDENING_FORM_ARG]: 'limit' },
    noArgsOptional: true,
    objectives: OBJ_DAI,
  },
  {
    ...IF_LINE,
    path: ['ip', 'arp', 'inspection', 'limit', 'rate', '<pps>', 'burst', 'interval', '<seconds>'],
    help: 'Measure the limit over several seconds',
    args: { pps: intArg('Packets per second', 0, HARDENING_RATE_MAX), seconds: intArg('Seconds', 1, HARDENING_BURST_MAX_S) },
    handler: H.ifArpInspection,
    fixedArgs: { [HARDENING_FORM_ARG]: 'limit' },
    objectives: OBJ_DAI,
  },
  {
    ...IF_LINE,
    path: ['ip', 'arp', 'inspection', 'limit', 'none'],
    help: 'No limit on this port',
    handler: H.ifArpInspection,
    fixedArgs: { [HARDENING_FORM_ARG]: 'limit-none' },
    objectives: OBJ_DAI,
  },
]);
