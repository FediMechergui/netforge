/**
 * cli/grammar/wireless.ts — radio interface lines and wireless diagnostics (ARCHITECTURE-P1 D5, §3.6, §3.7, §6):
 * under `interface WlanN` (access point or station) `ssid`, `security`, `passphrase`, `band`, `channel`,
 * `channel-width`, `tx-power` and the `beacons` extension; under `interface RadioN` `band`, `channel`,
 * `channel-width`, `tx-power` and `peer-key`; plus `show wireless` and the `wireless` debug category.
 *
 * Lines are scoped by the selected port's kind (and `beacons` by the access-radio role) and by radio capabilities.
 * Values are validated against the port's `RadioPortSpec` by the handlers. Passphrases and pairing keys are secret
 * tokens of the config rule table. Help strings are original wording (spec §1.6).
 */
import type { CommandSpec } from '../../contracts/cli.js';
import {
  choiceArg,
  debugSpecs,
  intArg,
  kindsPort,
  NFOS_ONLY,
  RADIO_CAPABILITIES,
  restArg,
  wordArg,
  type GrammarDebugCategory,
} from './core-exec.js';

/** Handler ids of the wireless fragment. */
export const WIRELESS_HANDLERS = {
  ifSsid: 'if.ssid',
  ifSecurity: 'if.security',
  ifPassphrase: 'if.passphrase',
  ifBand: 'if.band',
  ifChannel: 'if.channel',
  ifChannelWidth: 'if.channel-width',
  ifTxPower: 'if.tx-power',
  ifPeerKey: 'if.peer-key',
  ifBeacons: 'if.beacons',
  showWireless: 'show.wireless',
} as const;

/** Debug categories of the wireless fragment. */
export const WIRELESS_DEBUG_CATEGORIES: readonly GrammarDebugCategory[] = Object.freeze([
  { category: 'wireless', help: 'Trace scanning, association, key handshakes and attach', requiresAny: RADIO_CAPABILITIES, since: 'P0.5' },
]);

/** Mismatch text for Wi-Fi lines on a port that is not a Wi-Fi radio. */
export const MSG_NOT_WLAN = '% This setting applies to Wi-Fi radio interfaces only.';
/** Mismatch text for radio lines on a port that has no radio. */
export const MSG_NOT_RADIO = '% This setting applies to radio interfaces only.';
/** Mismatch text for `peer-key` on a port that is not a point-to-point radio. */
export const MSG_NOT_PTP = '% A pairing key applies to point-to-point radio interfaces only.';
/** Mismatch text for `beacons` on a port that is not an access radio. */
export const MSG_NOT_ACCESS_RADIO = '% Beacons are sent by access point radios only.';

const H = WIRELESS_HANDLERS;
const WIFI_CAPS = ['wifi-ap', 'wifi-client'] as const;
const RADIO_LINE_CAPS = ['wifi-ap', 'wifi-client', 'radio-bridge'] as const;

/** The wireless command table. */
export const WIRELESS_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    path: ['ssid', '<name>'],
    mode: 'config-if',
    privilege: 15,
    help: 'Network name this radio advertises (access point) or joins (station)',
    args: { name: restArg('Network name, up to 32 characters', 32) },
    handler: H.ifSsid,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    requiresAny: WIFI_CAPS,
    portRequires: kindsPort(['wlan'], MSG_NOT_WLAN),
    since: 'P0.5',
    objectives: ['CCNA1.13.2'],
  },
  {
    path: ['security', '<mode>'],
    mode: 'config-if',
    privilege: 15,
    help: 'Authentication and encryption of the wireless network',
    args: { mode: choiceArg('Security mode', ['open', 'wpa2-psk', 'wpa3-sae']) },
    handler: H.ifSecurity,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    requiresAny: WIFI_CAPS,
    portRequires: kindsPort(['wlan'], MSG_NOT_WLAN),
    since: 'P0.5',
    objectives: ['CCNA1.13.3'],
  },
  {
    path: ['passphrase', '<text>'],
    mode: 'config-if',
    privilege: 15,
    help: 'Shared passphrase of a protected wireless network (8 to 63 characters)',
    args: { text: restArg('Passphrase', 63) },
    handler: H.ifPassphrase,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    requiresAny: WIFI_CAPS,
    portRequires: kindsPort(['wlan'], MSG_NOT_WLAN),
    since: 'P0.5',
    objectives: ['CCNA1.13.3'],
  },
  {
    path: ['band', '<band>'],
    mode: 'config-if',
    privilege: 15,
    help: 'Frequency band of this radio in gigahertz',
    args: { band: choiceArg('Band (2.4, 5, 6 or 60)', ['2.4', '5', '6', '60']) },
    handler: H.ifBand,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    requiresAny: RADIO_LINE_CAPS,
    portRequires: kindsPort(['wlan', 'radio'], MSG_NOT_RADIO),
    since: 'P0.5',
    objectives: ['CCNA1.13.2'],
  },
  {
    path: ['channel', '<channel>'],
    mode: 'config-if',
    privilege: 15,
    help: 'Channel number, or auto to pick the quietest channel',
    args: { channel: wordArg('Channel number or auto', { pattern: 'auto|[0-9]{1,3}' }) },
    handler: H.ifChannel,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    requiresAny: RADIO_LINE_CAPS,
    portRequires: kindsPort(['wlan', 'radio'], MSG_NOT_RADIO),
    since: 'P0.5',
    objectives: ['CCNA1.13.2'],
  },
  {
    path: ['channel-width', '<mhz>'],
    mode: 'config-if',
    privilege: 15,
    help: 'Channel width in megahertz',
    args: { mhz: choiceArg('Width (20, 40, 80 or 160)', ['20', '40', '80', '160']) },
    handler: H.ifChannelWidth,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    requiresAny: RADIO_LINE_CAPS,
    portRequires: kindsPort(['wlan', 'radio'], MSG_NOT_RADIO),
    since: 'P0.5',
    objectives: ['CCNA1.13.2'],
  },
  {
    path: ['tx-power', '<dbm>'],
    mode: 'config-if',
    privilege: 15,
    help: 'Transmit power in dBm',
    args: { dbm: intArg('Transmit power in dBm', 0, 40) },
    handler: H.ifTxPower,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    requiresAny: RADIO_LINE_CAPS,
    portRequires: kindsPort(['wlan', 'radio'], MSG_NOT_RADIO),
    since: 'P0.5',
    objectives: ['CCNA1.13.2'],
  },
  {
    path: ['peer-key', '<key>'],
    mode: 'config-if',
    privilege: 15,
    help: 'Pairing key both ends of a point-to-point radio link must share',
    args: { key: restArg('Pairing key, 4 to 64 characters', 64) },
    handler: H.ifPeerKey,
    allowNo: true,
    noArgsOptional: true,
    grammars: NFOS_ONLY,
    requiresAny: ['radio-bridge'],
    portRequires: kindsPort(['radio'], MSG_NOT_PTP),
    since: 'P0.5',
    objectives: ['CCNA1.13.1'],
  },
  {
    path: ['beacons'],
    mode: 'config-if',
    privilege: 15,
    help: 'Send periodic beacon frames that captures can show (NetForge extension)',
    handler: H.ifBeacons,
    allowNo: true,
    extension: true,
    grammars: NFOS_ONLY,
    requiresAny: ['wifi-ap'],
    portRequires: { kinds: ['wlan'], roles: ['wireless-bss'], mismatch: MSG_NOT_ACCESS_RADIO },
    since: 'P0.5',
    objectives: ['CCNA1.13.2'],
  },
  {
    path: ['show', 'wireless'],
    mode: '@exec',
    privilege: 1,
    help: 'Radio settings, wireless networks and associations',
    handler: H.showWireless,
    filterable: true,
    requiresAny: RADIO_CAPABILITIES,
    since: 'P0.5',
    objectives: ['CCNA1.13.2'],
  },
  ...debugSpecs(WIRELESS_DEBUG_CATEGORIES, { wireless: ['CCNA1.13.2'] }),
]);
