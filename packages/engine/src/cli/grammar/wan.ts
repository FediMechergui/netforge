/**
 * cli/grammar/wan.ts — [S18] tunnel interfaces (with the [C13] IPsec mode lines) and [S19] PPP on serial lines
 * (ARCHITECTURE-P3 §5.7, D15, D17, D27; §7 W2 cli, approved items).
 *
 * Tunnel interface (`interface Tunnel<n>`, role `tunnel`; the interface itself is the existing `interface` line):
 * `tunnel source <if|addr>`, `tunnel destination <addr>`, `tunnel mode gre ip` (the default, never rendered) and
 * [C13] `tunnel mode ipsec ipv4`, [C13] `tunnel protection ipsec profile <p>` (IPsec mode only), `ip mtu <n>` and
 * `ip tcp adjust-mss <n>` (the D15 fallback: fragmentation is not simulated, so a tunnel refuses what does not fit
 * and clamps TCP). `ip address`, `bandwidth` and [C1] `delay` are the shared lines.
 *
 * Serial interface ([S19]): `encapsulation hdlc|ppp` is the existing serial line (its PPP refusal is gone);
 * `ppp authentication chap|pap|chap pap|pap chap`, `ppp pap sent-username <n> password <pw>`, `peer neighbor-route`
 * / `no peer neighbor-route` (executable, not listed by `?`: the serial help list of §9.2 item 21 has no `peer`), and
 * the global `username <n> password <pw>` (the password CHAP hashes, stored recoverably; the `nf7` form under
 * `service password-encryption`).
 *
 * Scope: tunnels exist only on models with `routing` (TUNNEL_FAMILY), so the tunnel lines need no capability gate of
 * their own beyond the port role; the PPP lines need a serial WAN port (a serial access line stays HDLC-only, D17). Help strings are original wording.
 *
 * W3 cli (cli-b, §5.8): `show ppp interface [<if>]` [S19], `show interfaces tunnel [<n>]` [S18] (executable, hidden from
 * `?` so the `show interfaces ?` port list stays), and the `tunnel`, `ppp negotiation`, `ppp authentication` debug
 * categories.
 */
import type { CommandSpec } from '../../contracts/cli.js';
import { L3_ROLES, type PortRole } from '../../contracts/catalog.js';
import {
  choiceArg,
  debugSpecs,
  ifaceArg,
  intArg,
  ipv4Arg,
  kindsPort,
  NFOS_ONLY,
  secretArg,
  wordArg,
  type GrammarDebugCategory,
} from './core-exec.js';

/** @since P3 [S18]/[S19]/[C13] Handler ids of the WAN fragment. Never rename. */
export const WAN_HANDLERS = {
  ifTunnelSource: 'if.tunnel-source',
  ifTunnelDestination: 'if.tunnel-destination',
  ifTunnelMode: 'if.tunnel-mode',
  ifTunnelProtection: 'if.tunnel-protection',
  ifIpMtu: 'if.ip-mtu',
  ifIpTcpAdjustMss: 'if.ip-tcp-adjust-mss',
  ifPppAuthentication: 'if.ppp-authentication',
  ifPppPapSentUsername: 'if.ppp-pap-sent-username',
  ifPeerNeighborRoute: 'if.peer-neighbor-route',
  configUsernamePassword: 'config.username-password',
  // W3 cli (cli-b): the shows of §5.8
  showInterfacesTunnel: 'show.interfaces-tunnel',
  showPppInterface: 'show.ppp-interface',
} as const;

/** @since P3 [S18] The role of a tunnel interface. */
export const TUNNEL_ROLES: readonly PortRole[] = Object.freeze(['tunnel'] as PortRole[]);
/** @since P3 [S18] Mismatch of a tunnel line typed on another interface. */
export const MSG_NOT_TUNNEL = '% This setting applies to tunnel interfaces only (interface Tunnel<n>).';

/** @since P3 [S18]/[C13] Arg name (`fixedArgs`) naming the tunnel mode a `tunnel mode …` spec sets. */
export const TUNNEL_MODE_ARG = 'mode';
/** @since P3 [S18] The default tunnel mode (`tunnel mode gre ip`, never rendered). */
export const TUNNEL_MODE_GRE = 'gre';
/** @since P3 [C13] The IPsec tunnel mode (`tunnel mode ipsec ipv4`). */
export const TUNNEL_MODE_IPSEC = 'ipsec';

/** @since P3 [S18] Smallest and largest `ip mtu` of a tunnel (the IPv4 minimum; a 1500-byte transport). */
export const TUNNEL_IP_MTU_MIN = 68;
export const TUNNEL_IP_MTU_MAX = 1500;
/** @since P3 [S18] Range of `ip tcp adjust-mss`. */
export const ADJUST_MSS_MIN = 500;
export const ADJUST_MSS_MAX = 1460;

/** @since P3 (W3 cli) [S18] Highest tunnel number `show interfaces tunnel <n>` takes. */
export const TUNNEL_NUMBER_MAX = 2_147_483_647;

/** @since P3 (W3 cli) [S19] `show ppp interface <if>` naming an interface that is not serial. */
export const MSG_PPP_SHOW_PORT = '% Only serial interfaces run PPP.';

/**
 * @since P3 (W3 cli) [S18]/[S19] The debug categories of the tunnel owner and of PPP (§5.8): `tunnel` (gre, both
 * modes), `ppp negotiation` and `ppp authentication` (ppp). Scoped by capability literals like the rest of the P3
 * grammar (cli/grammar/index.ts): `routing`, the row of gre and ppp in §2.1.
 */
export const WAN_DEBUG_CATEGORIES: readonly GrammarDebugCategory[] = Object.freeze([
  { category: 'tunnel', help: 'Trace tunnel state changes, encapsulation and refused packets', requiresAny: ['routing'], since: 'P3' },
  { category: 'ppp negotiation', help: 'Trace LCP, IPCP and IPV6CP negotiation and the link echo', requiresAny: ['routing'], since: 'P3' },
  { category: 'ppp authentication', help: 'Trace PAP and CHAP exchanges and their results', requiresAny: ['routing'], since: 'P3' },
]);

/** @since P3 (W3 cli) Objectives of the WAN debug categories. */
export const WAN_DEBUG_OBJECTIVES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  tunnel: ['CCNA3.wan.6'],
  'ppp negotiation': ['CCNA3.wan.3'],
  'ppp authentication': ['CCNA3.wan.3', 'CCNA3.wan.4'],
});

/** @since P3 [S19] Authentication protocols `ppp authentication` offers, in help order. */
export const PPP_AUTH_PROTOCOLS: readonly string[] = Object.freeze(['chap', 'pap']);

const H = WAN_HANDLERS;
const TUNNEL_PORT = { roles: TUNNEL_ROLES, mismatch: MSG_NOT_TUNNEL };
/**
 * @since P3 [S19] The PPP lines: a router's serial WAN port only. A serial access line (NF-CSU-DSU, NF-INTERNET) stays
 * HDLC-only (D17; the device refuses `encapsulation ppp` there), so it neither offers nor takes them (W2 fix, verified
 * finding 3).
 */
export const MSG_PPP_PORT = '% PPP settings apply to serial WAN interfaces only.';
const PPP_PORT = { kinds: ['serial'], roles: ['wan'], mismatch: MSG_PPP_PORT } as const;

const TUNNEL_LINE = {
  mode: 'config-if',
  privilege: 15,
  allowNo: true,
  noArgsOptional: true,
  grammars: NFOS_ONLY,
  portRequires: TUNNEL_PORT,
  since: 'P3',
} as const;

const PPP_LINE = {
  mode: 'config-if',
  privilege: 15,
  allowNo: true,
  noArgsOptional: true,
  grammars: NFOS_ONLY,
  portRequires: PPP_PORT,
  since: 'P3',
} as const;

/** @since P3 [S18]/[S19]/[C13] The WAN command table. */
export const WAN_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  // ── [S18] tunnel interfaces ──
  {
    ...TUNNEL_LINE,
    path: ['tunnel', 'source', '<address>'],
    help: 'Address the tunnel\'s outer packets leave from',
    args: { address: ipv4Arg('Local address of the tunnel') },
    handler: H.ifTunnelSource,
    objectives: ['CCNA3.wan.6'],
  },
  {
    ...TUNNEL_LINE,
    path: ['tunnel', 'source', '<iface>'],
    help: 'Interface whose address the tunnel\'s outer packets leave from',
    args: { iface: ifaceArg('Interface that carries the tunnel', { completion: 'interfaces', portFilter: { roles: L3_ROLES } }) },
    handler: H.ifTunnelSource,
    objectives: ['CCNA3.wan.6'],
  },
  {
    ...TUNNEL_LINE,
    path: ['tunnel', 'destination', '<address>'],
    help: 'Address of the far end of the tunnel',
    args: { address: ipv4Arg('Remote address of the tunnel') },
    handler: H.ifTunnelDestination,
    objectives: ['CCNA3.wan.6'],
  },
  {
    ...TUNNEL_LINE,
    path: ['tunnel', 'mode', 'gre', 'ip'],
    help: 'Carry packets in GRE over IPv4 (the default)',
    handler: H.ifTunnelMode,
    fixedArgs: { [TUNNEL_MODE_ARG]: TUNNEL_MODE_GRE },
    objectives: ['CCNA3.wan.6'],
  },
  // [C13] the IPsec mode and its protection profile
  {
    ...TUNNEL_LINE,
    path: ['tunnel', 'mode', 'ipsec', 'ipv4'],
    help: 'Make this an IPsec tunnel that encrypts every packet it carries',
    handler: H.ifTunnelMode,
    fixedArgs: { [TUNNEL_MODE_ARG]: TUNNEL_MODE_IPSEC },
    objectives: ['CCNA3.wan.7'],
  },
  {
    ...TUNNEL_LINE,
    path: ['tunnel', 'protection', 'ipsec', 'profile', '<name>'],
    help: 'IPsec profile whose keys protect this tunnel',
    args: { name: wordArg('IPsec profile name', { maxLength: 64 }) },
    handler: H.ifTunnelProtection,
    objectives: ['CCNA3.wan.7'],
  },
  {
    ...TUNNEL_LINE,
    path: ['ip', 'mtu', '<bytes>'],
    help: 'Largest packet this tunnel carries without refusing it',
    args: { bytes: intArg('IP MTU in bytes', TUNNEL_IP_MTU_MIN, TUNNEL_IP_MTU_MAX) },
    handler: H.ifIpMtu,
    objectives: ['CCNA3.wan.6'],
  },
  {
    ...TUNNEL_LINE,
    path: ['ip', 'tcp', 'adjust-mss', '<bytes>'],
    help: 'Lower the segment size TCP connections through this tunnel agree on',
    args: { bytes: intArg('Maximum segment size in bytes', ADJUST_MSS_MIN, ADJUST_MSS_MAX) },
    handler: H.ifIpTcpAdjustMss,
    objectives: ['CCNA3.wan.6'],
  },
  // ── [S19] PPP on serial lines ──
  {
    ...PPP_LINE,
    path: ['ppp', 'authentication', '<first>', '<second>'],
    help: 'Make the peer prove who it is before the link comes up',
    args: {
      first: choiceArg('Protocol tried first: chap sends a hash, pap sends the password in the clear', PPP_AUTH_PROTOCOLS),
      second: choiceArg('Protocol tried when the peer refuses the first', PPP_AUTH_PROTOCOLS, true),
    },
    handler: H.ifPppAuthentication,
    objectives: ['CCNA3.wan.3'],
  },
  {
    ...PPP_LINE,
    path: ['ppp', 'pap', 'sent-username', '<name>', 'password', '<secret>'],
    help: 'Name and password this end sends when the peer asks for PAP',
    args: { name: wordArg('User name sent to the peer', { maxLength: 32 }), secret: secretArg('Password sent to the peer') },
    handler: H.ifPppPapSentUsername,
    objectives: ['CCNA3.wan.4'],
  },
  {
    ...PPP_LINE,
    path: ['peer', 'neighbor-route'],
    help: 'Add a host route to the peer\'s address learned through PPP',
    handler: H.ifPeerNeighborRoute,
    noArgsOptional: false,
    hidden: true,
    objectives: ['CCNA3.wan.3'],
  },
  {
    path: ['username', '<name>', 'password', '<secret>'],
    mode: 'config',
    privilege: 15,
    help: 'Define a user name and a password the device can read back (what CHAP needs)',
    args: { name: wordArg('User name (for CHAP, the peer\'s host name)', { maxLength: 32 }), secret: secretArg('The password') },
    handler: H.configUsernamePassword,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    since: 'P3',
    objectives: ['CCNA3.wan.3'],
  },
  // ── W3 cli (cli-b): the shows and the debug categories of §5.8 ──
  {
    // [S18]/[C13] executable but not listed by `?`, so a router's `show interfaces ?` list stays its ports (no §9
    // migration moves it): the tunnel blocks of `show interfaces`, for every tunnel or for Tunnel<n>
    path: ['show', 'interfaces', 'tunnel', '<number>'],
    mode: '@exec',
    privilege: 1,
    help: 'Tunnel interfaces: source, destination, mode, MTU and why a tunnel is down',
    args: { number: intArg('Tunnel number (every tunnel when left out)', 0, TUNNEL_NUMBER_MAX, true) },
    handler: H.showInterfacesTunnel,
    filterable: true,
    hidden: true,
    grammars: NFOS_ONLY,
    requiresAny: ['routing'],
    since: 'P3',
    objectives: ['CCNA3.wan.6', 'CCNA3.wan.7'],
  },
  {
    // [S19]
    path: ['show', 'ppp', 'interface', '<iface>'],
    mode: '@exec',
    privilege: 1,
    help: 'PPP on serial interfaces: link phase, LCP, authentication and the network protocols',
    args: { iface: ifaceArg('Limit the output to one serial interface', { optional: true, portFilter: kindsPort(['serial'], MSG_PPP_SHOW_PORT) }) },
    handler: H.showPppInterface,
    filterable: true,
    grammars: NFOS_ONLY,
    requiresAny: ['routing'],
    since: 'P3',
    objectives: ['CCNA3.wan.3'],
  },
  ...debugSpecs(WAN_DEBUG_CATEGORIES, WAN_DEBUG_OBJECTIVES),
]);

/** @since P3 [S18]/[S19] Help of the intermediate WAN keywords (merged into `LITERAL_HELP` by the fold). */
export const WAN_LITERAL_HELP: Readonly<Record<string, string>> = Object.freeze({
  tunnel: 'Tunnel settings',
  ppp: 'PPP settings',
  pap: 'PAP settings',
  tcp: 'TCP settings',
  peer: 'Peer settings',
});
