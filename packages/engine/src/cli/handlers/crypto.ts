/**
 * cli/handlers/crypto.ts — [C13] the IKEv2 keyring, the IKEv2 profile and the IPsec profile sections
 * (ARCHITECTURE-P3 §2.17, §5.7, D27; §7 W2 cli, approved items).
 *
 *   config.crypto-ikev2-keyring    `crypto ikev2 keyring <k>` → mode config-ikev2-keyring (context
 *                                  `[['crypto', 'ikev2', 'keyring', <k>]]`); `no …` removes the keyring
 *   keyring.peer                   `peer <n>` → mode config-ikev2-keyring-peer (context gains `['peer', <n>]`)
 *   keyring-peer.address           `address <a>` / `no address`
 *   keyring-peer.pre-shared-key    `pre-shared-key <k>` / `no pre-shared-key` (stored as typed: the ike daemon needs the
 *                                  key itself, and it never travels in a packet)
 *   config.crypto-ikev2-profile    `crypto ikev2 profile <p>` → mode config-ikev2-profile
 *   ikev2-profile.match-identity   `match identity remote address <a> [<mask>]` (255.255.255.255 when left out)
 *   ikev2-profile.authentication   `authentication local|remote pre-share` / their `no` forms
 *   ikev2-profile.keyring          `keyring local <k>` / `no keyring local`
 *   config.crypto-ipsec-profile    `crypto ipsec profile <p>` → mode config-ipsec-profile
 *   ipsec-profile.set-ikev2-profile `set ikev2-profile <p>` / `no set ikev2-profile`
 *
 * The stored lines are the W1 rules' canonical forms (cli/config-rules.ts, the [C13] block); the ike daemon reads them.
 * Messages are original wording (spec §1.6).
 */
import type { CommandCtx, CommandHandler } from '../../contracts/cli.js';
import { AUTH_SIDE_ARG, CRYPTO_HANDLERS, CRYPTO_MODES } from '../grammar/crypto.js';
import { enterMode, outcomeOf } from './common.js';

/** @since P3 [C13] A keyring line typed outside `crypto ikev2 keyring`. */
export const MSG_NO_KEYRING = '% Enter "crypto ikev2 keyring <name>" first.';
/** @since P3 [C13] A peer line typed outside a keyring's `peer` section. */
export const MSG_NO_KEYRING_PEER = '% Enter "peer <name>" inside a keyring first.';
/** @since P3 [C13] A profile line typed outside `crypto ikev2 profile`. */
export const MSG_NO_IKEV2_PROFILE = '% Enter "crypto ikev2 profile <name>" first.';
/** @since P3 [C13] A line typed outside `crypto ipsec profile`. */
export const MSG_NO_IPSEC_PROFILE = '% Enter "crypto ipsec profile <name>" first.';

/** The innermost context entry when it starts with `head`. */
function innermost(ctx: CommandCtx, head: readonly string[]): readonly string[] | undefined {
  const e = ctx.context[ctx.context.length - 1];
  return e !== undefined && head.every((t, i) => e[i] === t) ? e : undefined;
}

/** The tokens of the first stored line starting with `head` in the session's innermost section, or undefined. */
function storedChild(ctx: CommandCtx, head: readonly string[]): string[] | undefined {
  let nodes = ctx.running.root.children;
  for (const entry of ctx.context) {
    const node = nodes.find((c) => [c.key, ...c.args].join(' ') === entry.join(' '));
    if (node === undefined) return undefined;
    nodes = node.children;
  }
  for (const c of nodes) {
    const t = [c.key, ...c.args];
    if (head.every((x, i) => t[i] === x)) return t;
  }
  return undefined;
}

/** A global crypto section line (`crypto ikev2 keyring|profile <n>`, `crypto ipsec profile <n>`) entering `mode`. */
function cryptoSection(head: readonly string[], mode: string): CommandHandler {
  return (ctx, args, negate) => {
    const name = args['name'] ?? '';
    if (name === '') return { error: '% Give the name.' };
    const line = [...head, name];
    if (negate) return outcomeOf(ctx.config(line, true, []));
    const error = ctx.config(line, false, []);
    if (error !== undefined) return { error };
    enterMode(ctx, mode, [line]);
    return {};
  };
}

/** `peer <n>` inside a keyring / `no peer <n>`. */
const keyringPeer: CommandHandler = (ctx, args, negate) => {
  const keyring = innermost(ctx, ['crypto', 'ikev2', 'keyring']);
  if (keyring === undefined) return { error: MSG_NO_KEYRING };
  const name = args['name'] ?? '';
  if (name === '') return { error: '% Give the peer name.' };
  const line = ['peer', name];
  if (negate) return outcomeOf(ctx.config(line, true));
  const error = ctx.config(line, false);
  if (error !== undefined) return { error };
  enterMode(ctx, CRYPTO_MODES.peer, [[...keyring], line]);
  return {};
};

/** A one-value line inside `section` (`address <a>`, `pre-shared-key <k>`, `keyring local <k>`, …) and its `no` form. */
function sectionValue(section: readonly string[], refusal: string, head: readonly string[], arg: string): CommandHandler {
  return (ctx, args, negate) => {
    if (innermost(ctx, section) === undefined) return { error: refusal };
    if (negate) return outcomeOf(ctx.config([...head], true));
    const value = args[arg] ?? '';
    if (value === '') return { error: '% Give the value.' };
    return outcomeOf(ctx.config([...head, value], false));
  };
}

/** `match identity remote address <a> [<mask>]` / its `no` form. */
const matchIdentity: CommandHandler = (ctx, args, negate) => {
  if (innermost(ctx, ['crypto', 'ikev2', 'profile']) === undefined) return { error: MSG_NO_IKEV2_PROFILE };
  const head = ['match', 'identity', 'remote', 'address'];
  const address = args['address'];
  if (negate && (address === undefined || address === '')) {
    // the identity of the line includes the address: remove the stored line by its full tokens
    const stored = storedChild(ctx, head);
    return stored === undefined ? {} : outcomeOf(ctx.config(stored, true));
  }
  if (address === undefined || address === '') return { error: '% Give the peer address.' };
  const mask = args['mask'] === undefined || args['mask'] === '' ? '255.255.255.255' : args['mask'];
  return outcomeOf(ctx.config([...head, address, mask], negate));
};

/** `authentication local|remote pre-share` / their `no` forms. */
const authentication: CommandHandler = (ctx, args, negate) => {
  if (innermost(ctx, ['crypto', 'ikev2', 'profile']) === undefined) return { error: MSG_NO_IKEV2_PROFILE };
  const side = args[AUTH_SIDE_ARG] === 'remote' ? 'remote' : 'local';
  if (negate) return outcomeOf(ctx.config(['authentication', side], true));
  return outcomeOf(ctx.config(['authentication', side, 'pre-share'], false));
};

/** @since P3 [C13] Registry fragment: crypto handler id → handler. */
export const cryptoHandlers: Readonly<Record<string, CommandHandler>> = {
  [CRYPTO_HANDLERS.configCryptoIkev2Keyring]: cryptoSection(['crypto', 'ikev2', 'keyring'], CRYPTO_MODES.keyring),
  [CRYPTO_HANDLERS.keyringPeer]: keyringPeer,
  [CRYPTO_HANDLERS.keyringPeerAddress]: sectionValue(['peer'], MSG_NO_KEYRING_PEER, ['address'], 'address'),
  [CRYPTO_HANDLERS.keyringPeerPreSharedKey]: sectionValue(['peer'], MSG_NO_KEYRING_PEER, ['pre-shared-key'], 'secret'),
  [CRYPTO_HANDLERS.configCryptoIkev2Profile]: cryptoSection(['crypto', 'ikev2', 'profile'], CRYPTO_MODES.ikev2Profile),
  [CRYPTO_HANDLERS.ikev2ProfileMatchIdentity]: matchIdentity,
  [CRYPTO_HANDLERS.ikev2ProfileAuthentication]: authentication,
  [CRYPTO_HANDLERS.ikev2ProfileKeyring]: sectionValue(['crypto', 'ikev2', 'profile'], MSG_NO_IKEV2_PROFILE, ['keyring', 'local'], 'name'),
  [CRYPTO_HANDLERS.configCryptoIpsecProfile]: cryptoSection(['crypto', 'ipsec', 'profile'], CRYPTO_MODES.ipsecProfile),
  [CRYPTO_HANDLERS.ipsecProfileSetIkev2Profile]: sectionValue(['crypto', 'ipsec', 'profile'], MSG_NO_IPSEC_PROFILE, ['set', 'ikev2-profile'], 'name'),
};
