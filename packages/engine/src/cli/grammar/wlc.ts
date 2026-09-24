/**
 * cli/grammar/wlc.ts — the wireless controller and lightweight access point lines (ARCHITECTURE-P2 §3.12, §5.3, §5.4,
 * D17; §7 W5 cli).
 *
 * Controller (`wireless-controller`): the `wlc-interface <name>` section (mode `config-wlc-if`) with `vlan <v>`,
 * `address <a> <mask>`, `gateway <a>` and `dhcp-server <a>`, and the `wlan <id> <profile> <ssid>` section (mode
 * `config-wlan`) with `security open|wpa2-psk|wpa3-sae`, `passphrase <text>` (secret), `interface <name>` (a
 * controller interface; `management` when absent), `radio 2.4|5|all` and `shutdown`. The `wlc-interface` handlers
 * keep the lines the interface stands for (cli/handlers/wlc.ts): the VLAN in the controller's VLAN list, the SVI that
 * carries the address (`interface Vlan<v>` / `ip address` / `no shutdown`, as `channel-group` keeps its
 * Port-channel) and, for the management interface, `ip default-gateway`.
 *
 * Lightweight access point (`lightweight-ap`): `capwap enable` (replayed by the P2 profile; `no capwap enable` makes
 * the access point autonomous) and `capwap controller <ip>` (several). Both sides: `show capwap`.
 *
 * Scope is capability-driven (`wireless-controller`, `lightweight-ap`); no spec names a device kind. The `capwap`
 * debug category of capwap-wtp and capwap-ac (§5.4) is declared here, keyed on the daemons' capability rows (the W6
 * catalog item adds them), so it is registered now and offered where the daemons run. [S11] enterprise security and
 * `radius-server` are not built (§8.5).
 *
 * Every name this fragment exports is `WLC_`-prefixed: the package root re-exports the grammar with `export *`, so a
 * generic name (`CAPWAP_DEBUG_CATEGORY`, `WLAN_ID_MAX`) could collide with the capwap daemons' own exports. Help
 * strings are original wording (spec §1.6).
 */
import type { CommandSpec } from '../../contracts/cli.js';
import type { Capability } from '../../contracts/catalog.js';
import { capabilitiesRunning, choiceArg, type GrammarDebugCategory, intArg, ipv4Arg, maskArg, NFOS_ONLY, secretArg, wordArg } from './core-exec.js';

/** Handler ids of the controller and lightweight access point fragment. Never rename. */
export const WLC_HANDLERS = {
  configWlcInterface: 'config.wlc-interface',
  wlcIfVlan: 'wlc-if.vlan',
  wlcIfAddress: 'wlc-if.address',
  wlcIfGateway: 'wlc-if.gateway',
  wlcIfDhcpServer: 'wlc-if.dhcp-server',
  configWlan: 'config.wlan',
  wlanSecurity: 'wlan.security',
  wlanPassphrase: 'wlan.passphrase',
  wlanInterface: 'wlan.interface',
  wlanRadio: 'wlan.radio',
  wlanShutdown: 'wlan.shutdown',
  configCapwapEnable: 'config.capwap-enable',
  configCapwapController: 'config.capwap-controller',
  showCapwap: 'show.capwap',
} as const;

/**
 * The argument limits the grammar checks and the handlers re-check (they can be called directly): controller
 * interface and WLAN profile names, the SSID token, the WLAN number range, the personal security modes, the radios
 * and the passphrase length.
 */
export const WLC_ARG_LIMITS = Object.freeze({
  /** The predefined management interface (§5.3): a WLAN may always name it, and it cannot be removed. */
  managementInterface: 'management',
  nameMaxLength: 32,
  /** Letters, digits, `.`, `_` and `-`, starting with a letter or digit. */
  namePattern: '[A-Za-z0-9][A-Za-z0-9._-]{0,31}',
  /** 1-32 printable characters without spaces or `:` (the CAPWAP WLAN field separator, §2.3). */
  ssidPattern: '[!-9;-~]{1,32}',
  wlanIdMin: 1,
  wlanIdMax: 512,
  /** Personal security only: [S11] enterprise is not built. */
  securityModes: Object.freeze(['open', 'wpa2-psk', 'wpa3-sae'] as const),
  radios: Object.freeze(['2.4', '5', 'all'] as const),
  passphraseMin: 8,
  passphraseMax: 63,
});

const L = WLC_ARG_LIMITS;

/** Capabilities of the controller appliance (NF-WLC-9800, D17). */
const CONTROLLER: readonly Capability[] = Object.freeze(['wireless-controller']);
/** Capabilities of an access point run by a controller (NF-AP-1832 from the W6 catalog item). */
const LIGHTWEIGHT_AP: readonly Capability[] = Object.freeze(['lightweight-ap']);
/** `show capwap` exists at both ends of the controller link. */
const BOTH_ENDS: readonly Capability[] = Object.freeze(['lightweight-ap', 'wireless-controller']);

/** Debug category of capwap-wtp and capwap-ac (§5.4, binding; the daemons pass the same string). */
const DEBUG_CATEGORY = 'capwap';

/** The CAPWAP debug category (offered where either daemon runs, §2.1). */
export const WLC_DEBUG_CATEGORIES: readonly GrammarDebugCategory[] = Object.freeze([
  { category: DEBUG_CATEGORY, help: 'Trace controller discovery, joining, configuration, echoes and client reports', requiresAny: capabilitiesRunning('capwap-wtp', 'capwap-ac'), since: 'P2' },
]);

/** Objectives of the CAPWAP debug category. */
export const WLC_DEBUG_OBJECTIVES: Readonly<Record<string, readonly string[]>> = { [DEBUG_CATEGORY]: ['CCNA2.12.2'] };

const H = WLC_HANDLERS;

const WLC_IF_LINE = {
  mode: 'config-wlc-if',
  privilege: 15,
  allowNo: true,
  noArgsOptional: true,
  grammars: NFOS_ONLY,
  requiresAny: CONTROLLER,
  since: 'P2',
  objectives: ['CCNA2.12.1'],
} as const;

const WLAN_LINE = {
  mode: 'config-wlan',
  privilege: 15,
  allowNo: true,
  grammars: NFOS_ONLY,
  requiresAny: CONTROLLER,
  since: 'P2',
  objectives: ['CCNA2.12.1'],
} as const;

const CAPWAP_LINE = {
  mode: 'config',
  privilege: 15,
  allowNo: true,
  grammars: NFOS_ONLY,
  requiresAny: LIGHTWEIGHT_AP,
  since: 'P2',
  objectives: ['CCNA2.12.2'],
} as const;

const NAME_ARG = (help: string) => wordArg(help, { maxLength: L.nameMaxLength, pattern: L.namePattern });

/** The controller and lightweight access point command table. */
export const WLC_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  // ── controller interfaces ──────────────────────────────────────────────────────────────────────────────────────
  {
    path: ['wlc-interface', '<name>'],
    mode: 'config',
    privilege: 15,
    help: 'Create or edit a controller interface: the VLAN, address and gateway a WLAN reaches the wired network through',
    args: { name: NAME_ARG('Interface name (management is the built-in management interface)') },
    handler: H.configWlcInterface,
    entersMode: 'config-wlc-if',
    sessionEffect: 'enter-mode',
    allowNo: true,
    grammars: NFOS_ONLY,
    requiresAny: CONTROLLER,
    since: 'P2',
    objectives: ['CCNA2.12.1'],
  },
  {
    ...WLC_IF_LINE,
    path: ['vlan', '<vlan>'],
    help: 'VLAN of this interface (the controller adds it to its VLAN list)',
    args: { vlan: intArg('VLAN number', 1, 4094) },
    handler: H.wlcIfVlan,
  },
  {
    ...WLC_IF_LINE,
    path: ['address', '<address>', '<mask>'],
    help: 'Address of this interface on its VLAN (the controller answers on it)',
    args: { address: ipv4Arg('Interface address'), mask: maskArg('Subnet mask') },
    handler: H.wlcIfAddress,
  },
  {
    ...WLC_IF_LINE,
    path: ['gateway', '<address>'],
    help: 'Router of this interface\'s subnet (for management: the controller\'s default gateway)',
    args: { address: ipv4Arg('Gateway address') },
    handler: H.wlcIfGateway,
  },
  {
    ...WLC_IF_LINE,
    path: ['dhcp-server', '<address>'],
    help: 'DHCP server for the clients of this interface\'s WLANs (recorded; client requests are bridged to the VLAN)',
    args: { address: ipv4Arg('DHCP server address') },
    handler: H.wlcIfDhcpServer,
  },
  // ── WLANs ──────────────────────────────────────────────────────────────────────────────────────────────────────
  {
    path: ['wlan', '<id>', '<profile>', '<ssid>'],
    mode: 'config',
    privilege: 15,
    help: 'Create or edit a WLAN: its number, profile name and the network name clients see',
    args: {
      id: intArg('WLAN number', L.wlanIdMin, L.wlanIdMax),
      profile: NAME_ARG('Profile name'),
      ssid: wordArg('Network name (SSID) clients join, up to 32 characters without spaces', { maxLength: 32, pattern: L.ssidPattern }),
    },
    handler: H.configWlan,
    entersMode: 'config-wlan',
    sessionEffect: 'enter-mode',
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    requiresAny: CONTROLLER,
    since: 'P2',
    objectives: ['CCNA2.12.1'],
  },
  {
    ...WLAN_LINE,
    path: ['security', '<mode>'],
    help: 'How clients of this WLAN authenticate and encrypt',
    args: { mode: choiceArg('open, wpa2-psk or wpa3-sae (personal: one shared passphrase)', L.securityModes) },
    handler: H.wlanSecurity,
    noArgsOptional: true,
  },
  {
    ...WLAN_LINE,
    path: ['passphrase', '<text>'],
    help: 'Shared passphrase of this WLAN (8 to 63 characters)',
    args: { text: secretArg('Passphrase', L.passphraseMax) },
    handler: H.wlanPassphrase,
    noArgsOptional: true,
  },
  {
    ...WLAN_LINE,
    path: ['interface', '<name>'],
    help: 'Controller interface this WLAN\'s clients reach the wired network through (default: management)',
    args: { name: NAME_ARG('Controller interface name') },
    handler: H.wlanInterface,
    noArgsOptional: true,
  },
  {
    ...WLAN_LINE,
    path: ['radio', '<band>'],
    help: 'Radios the access points offer this WLAN on',
    args: { band: choiceArg('2.4, 5 or all', L.radios) },
    handler: H.wlanRadio,
    noArgsOptional: true,
  },
  {
    ...WLAN_LINE,
    path: ['shutdown'],
    help: 'Stop offering this WLAN (no shutdown offers it again)',
    handler: H.wlanShutdown,
  },
  // ── lightweight access point ───────────────────────────────────────────────────────────────────────────────────
  {
    ...CAPWAP_LINE,
    path: ['capwap', 'enable'],
    help: 'Join a controller once this access point has an address (no capwap enable: work on its own)',
    handler: H.configCapwapEnable,
  },
  {
    ...CAPWAP_LINE,
    path: ['capwap', 'controller', '<address>'],
    help: 'Ask this controller directly instead of searching the local subnet (repeat for several)',
    args: { address: ipv4Arg('Controller management address') },
    handler: H.configCapwapController,
    noArgsOptional: true,
  },
  // ── show ───────────────────────────────────────────────────────────────────────────────────────────────────────
  {
    path: ['show', 'capwap'],
    mode: '@exec',
    privilege: 1,
    help: 'The controller link of this access point, or the access points and wireless clients of this controller',
    handler: H.showCapwap,
    filterable: true,
    grammars: NFOS_ONLY,
    requiresAny: BOTH_ENDS,
    since: 'P2',
    objectives: ['CCNA2.12.2'],
  },
]);
