/**
 * cli/grammar/crypto.ts — [C13] the site-to-site IPsec sections (ARCHITECTURE-P3 §2.17, §5.7, D27; §7 W2 cli, approved
 * items). The tunnel lines (`tunnel mode ipsec ipv4`, `tunnel protection ipsec profile <p>`) are in wan.ts.
 *
 *   crypto ikev2 keyring <k>                   mode config-ikev2-keyring        (prompt `(config-ikev2-keyring)#`)
 *     peer <n>                                 mode config-ikev2-keyring-peer   (prompt `(config-ikev2-keyring-peer)#`)
 *       address <a>
 *       pre-shared-key <k>                     (a secret: stored as typed, never carried in a PDU)
 *   crypto ikev2 profile <p>                   mode config-ikev2-profile        (prompt `(config-ikev2-profile)#`)
 *     match identity remote address <a> [<mask>]
 *     authentication local pre-share
 *     authentication remote pre-share
 *     keyring local <k>
 *   crypto ipsec profile <p>                   mode config-ipsec-profile        (prompt `(ipsec-profile)#`)
 *     set ikev2-profile <p>
 *
 * Scope: the `routing` capability (the [C13] `ike` daemon row of §2.1). Help strings are original wording (spec §1.6).
 */
import type { CommandSpec } from '../../contracts/cli.js';
import { ipv4Arg, maskArg, NFOS_ONLY, secretArg, wordArg } from './core-exec.js';

/** @since P3 [C13] Handler ids of the crypto fragment. Never rename. */
export const CRYPTO_HANDLERS = {
  configCryptoIkev2Keyring: 'config.crypto-ikev2-keyring',
  keyringPeer: 'keyring.peer',
  keyringPeerAddress: 'keyring-peer.address',
  keyringPeerPreSharedKey: 'keyring-peer.pre-shared-key',
  configCryptoIkev2Profile: 'config.crypto-ikev2-profile',
  ikev2ProfileMatchIdentity: 'ikev2-profile.match-identity',
  ikev2ProfileAuthentication: 'ikev2-profile.authentication',
  ikev2ProfileKeyring: 'ikev2-profile.keyring',
  configCryptoIpsecProfile: 'config.crypto-ipsec-profile',
  ipsecProfileSetIkev2Profile: 'ipsec-profile.set-ikev2-profile',
} as const;

/** @since P3 [C13] The four crypto modes (contracts/cli.ts MODES). */
export const CRYPTO_MODES = Object.freeze({
  keyring: 'config-ikev2-keyring',
  peer: 'config-ikev2-keyring-peer',
  ikev2Profile: 'config-ikev2-profile',
  ipsecProfile: 'config-ipsec-profile',
} as const);

/** @since P3 [C13] Arg name (`fixedArgs`) naming the side an `authentication local|remote pre-share` line sets. */
export const AUTH_SIDE_ARG = 'side';

/** @since P3 [C13] Longest name of a keyring, peer or profile. */
export const CRYPTO_NAME_MAX = 64;

const H = CRYPTO_HANDLERS;

const NAME_ARG = (help: string) => wordArg(help, { maxLength: CRYPTO_NAME_MAX });

const SECTION_LINE = {
  privilege: 15,
  allowNo: true,
  grammars: NFOS_ONLY,
  requiresAny: ['routing'],
  since: 'P3',
  objectives: ['CCNA3.wan.7'],
} as const;

/** @since P3 [C13] The crypto command table. */
export const CRYPTO_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    ...SECTION_LINE,
    path: ['crypto', 'ikev2', 'keyring', '<name>'],
    mode: 'config',
    help: 'Keyring holding the pre-shared keys of IKEv2 peers',
    args: { name: NAME_ARG('Keyring name') },
    handler: H.configCryptoIkev2Keyring,
    entersMode: CRYPTO_MODES.keyring,
    sessionEffect: 'enter-mode',
  },
  {
    ...SECTION_LINE,
    path: ['peer', '<name>'],
    mode: CRYPTO_MODES.keyring,
    help: 'One peer of this keyring and the key it shares',
    args: { name: NAME_ARG('Peer name') },
    handler: H.keyringPeer,
    entersMode: CRYPTO_MODES.peer,
    sessionEffect: 'enter-mode',
  },
  {
    ...SECTION_LINE,
    path: ['address', '<address>'],
    mode: CRYPTO_MODES.peer,
    help: 'Address this peer sends its IKE messages from',
    args: { address: ipv4Arg('Peer address') },
    handler: H.keyringPeerAddress,
    noArgsOptional: true,
  },
  {
    ...SECTION_LINE,
    path: ['pre-shared-key', '<secret>'],
    mode: CRYPTO_MODES.peer,
    help: 'Key both ends prove they know (it never travels in a packet)',
    args: { secret: secretArg('Pre-shared key', 128) },
    handler: H.keyringPeerPreSharedKey,
    noArgsOptional: true,
  },
  {
    ...SECTION_LINE,
    path: ['crypto', 'ikev2', 'profile', '<name>'],
    mode: 'config',
    help: 'IKEv2 profile: which peer to accept and how both ends authenticate',
    args: { name: NAME_ARG('Profile name') },
    handler: H.configCryptoIkev2Profile,
    entersMode: CRYPTO_MODES.ikev2Profile,
    sessionEffect: 'enter-mode',
  },
  {
    ...SECTION_LINE,
    path: ['match', 'identity', 'remote', 'address', '<address>', '<mask>'],
    mode: CRYPTO_MODES.ikev2Profile,
    help: 'Use this profile for the peer with this address',
    args: { address: ipv4Arg('Peer address'), mask: { ...maskArg('Mask (255.255.255.255 when left out)'), optional: true } },
    handler: H.ikev2ProfileMatchIdentity,
    noArgsOptional: true,
  },
  {
    ...SECTION_LINE,
    path: ['authentication', 'local', 'pre-share'],
    mode: CRYPTO_MODES.ikev2Profile,
    help: 'This end proves itself with the pre-shared key',
    handler: H.ikev2ProfileAuthentication,
    fixedArgs: { [AUTH_SIDE_ARG]: 'local' },
  },
  {
    ...SECTION_LINE,
    path: ['authentication', 'remote', 'pre-share'],
    mode: CRYPTO_MODES.ikev2Profile,
    help: 'The peer proves itself with the pre-shared key',
    handler: H.ikev2ProfileAuthentication,
    fixedArgs: { [AUTH_SIDE_ARG]: 'remote' },
  },
  {
    ...SECTION_LINE,
    path: ['keyring', 'local', '<name>'],
    mode: CRYPTO_MODES.ikev2Profile,
    help: 'Keyring whose keys this profile uses',
    args: { name: NAME_ARG('Keyring name') },
    handler: H.ikev2ProfileKeyring,
    noArgsOptional: true,
  },
  {
    ...SECTION_LINE,
    path: ['crypto', 'ipsec', 'profile', '<name>'],
    mode: 'config',
    help: 'IPsec profile a tunnel interface uses for protection',
    args: { name: NAME_ARG('Profile name') },
    handler: H.configCryptoIpsecProfile,
    entersMode: CRYPTO_MODES.ipsecProfile,
    sessionEffect: 'enter-mode',
  },
  {
    ...SECTION_LINE,
    path: ['set', 'ikev2-profile', '<name>'],
    mode: CRYPTO_MODES.ipsecProfile,
    help: 'IKEv2 profile that negotiates this profile\'s keys',
    args: { name: NAME_ARG('IKEv2 profile name') },
    handler: H.ipsecProfileSetIkev2Profile,
    noArgsOptional: true,
  },
]);

/** @since P3 [C13] Help of the intermediate crypto keywords (merged into `LITERAL_HELP` by the fold). */
export const CRYPTO_LITERAL_HELP: Readonly<Record<string, string>> = Object.freeze({
  crypto: 'Encryption and key settings',
  ikev2: 'IKEv2 settings',
  ipsec: 'IPsec settings',
  identity: 'Peer identity',
  remote: 'Remote end',
  local: 'Local end',
  authentication: 'Authentication method',
  keyring: 'Keyring settings',
  set: 'Set a value',
});
