/**
 * cli/handlers/wan.ts — [S18] tunnel interfaces (and the [C13] IPsec mode lines) and [S19] PPP (ARCHITECTURE-P3 §5.7,
 * D15, D17, D27; §7 W2 cli, approved items).
 *
 *   if.tunnel-source             `tunnel source <if|addr>` / `no tunnel source` (the tunnel itself is refused)
 *   if.tunnel-destination        `tunnel destination <addr>` / `no tunnel destination`
 *   if.tunnel-mode               `tunnel mode gre ip` (the default: it removes the stored mode) / [C13] `tunnel mode
 *                                ipsec ipv4` (stored); either `no` form returns the tunnel to GRE
 *   if.tunnel-protection         [C13] `tunnel protection ipsec profile <p>`: refused on a GRE-mode tunnel
 *                                (`ipsecProtectionVtiOnly`); an unknown profile is stored with the note
 *                                `ipsecProfileMissing` (the tunnel stays down, negotiating, until it exists)
 *   if.ip-mtu, if.ip-tcp-adjust-mss   the D15 fallback lines of a tunnel
 *   if.ppp-authentication        [S19] `ppp authentication chap|pap [chap|pap]` (two different protocols) / its `no`
 *   if.ppp-pap-sent-username     [S19] `ppp pap sent-username <n> password <pw>` / its `no` form
 *   if.peer-neighbor-route       [S19] `peer neighbor-route` (the default) / `no peer neighbor-route` (stored)
 *   config.username-password     [S19] `username <n> password <pw>` / `no username <n>`
 *
 * Passwords PPP sends or checks are stored recoverably (PAP sends them, CHAP hashes them): in the clear, or `nf7 <hex>`
 * under `service password-encryption`, exactly like `enable password`. Messages are original wording (spec §1.6).
 */
import type { CommandCtx, CommandHandler } from '../../contracts/cli.js';
import { CLI_MESSAGES } from '../../contracts/cli.js';
import { TUNNEL_MODE_ARG, TUNNEL_MODE_IPSEC, WAN_HANDLERS } from '../grammar/wan.js';
import { encodeReversibleSecret, secretTokens } from '../secrets.js';
import { fillTemplate, interfaceLine, MSG_NO_INTERFACE_SELECTED, outcomeOf, selectedInterface } from './common.js';
import { passwordEncryptionOn } from './line-auth.js';

/** @since P3 [S18] `tunnel source` naming the tunnel itself. */
export const MSG_TUNNEL_SOURCE_SELF = '% A tunnel cannot carry itself: name the interface its packets leave through.';
/** @since P3 [S19] `ppp authentication` naming one protocol twice. */
export const MSG_PPP_AUTH_TWICE = '% Name two different protocols, or one.';
/** @since P3 [S19] A password line without its text. */
export const MSG_PASSWORD_EMPTY = '% Give the password to set.';

/** Tokens of a password stored recoverably: `nf7 <hex>` under `service password-encryption`, else the plain text. */
export function recoverablePasswordTokens(ctx: CommandCtx, plain: string): string[] {
  return passwordEncryptionOn(ctx.running) ? secretTokens(encodeReversibleSecret(plain)) : [plain];
}

/** True when the selected tunnel stores `tunnel mode ipsec ipv4`. */
export function tunnelIsIpsec(ctx: CommandCtx, port: string): boolean {
  const mode = interfaceLine(ctx, port, ['tunnel', 'mode']);
  return mode?.[0] === TUNNEL_MODE_IPSEC;
}

/** True when a `crypto ipsec profile <name>` section exists. */
export function ipsecProfileExists(ctx: CommandCtx, name: string): boolean {
  return ctx.running.root.children.some((c) => c.key === 'crypto' && c.args[0] === 'ipsec' && c.args[1] === 'profile' && c.args[2] === name);
}

/** The selected interface, or an error outcome. */
function selected(ctx: CommandCtx): string | { error: string } {
  const port = selectedInterface(ctx);
  return port === undefined ? { error: MSG_NO_INTERFACE_SELECTED } : port;
}

/** `tunnel source <if|addr>` / `no tunnel source`. */
const tunnelSource: CommandHandler = (ctx, args, negate) => {
  const port = selected(ctx);
  if (typeof port !== 'string') return port;
  if (negate) return outcomeOf(ctx.config(['tunnel', 'source'], true));
  const source = args['iface'] ?? args['address'] ?? '';
  if (source === '') return { error: '% Give the source interface or address.' };
  if (source === port) return { error: MSG_TUNNEL_SOURCE_SELF };
  return outcomeOf(ctx.config(['tunnel', 'source', source], false));
};

/** `tunnel destination <addr>` / `no tunnel destination`. */
const tunnelDestination: CommandHandler = (ctx, args, negate) => {
  const port = selected(ctx);
  if (typeof port !== 'string') return port;
  if (negate) return outcomeOf(ctx.config(['tunnel', 'destination'], true));
  const address = args['address'] ?? '';
  if (address === '') return { error: '% Give the destination address.' };
  return outcomeOf(ctx.config(['tunnel', 'destination', address], false));
};

/** `tunnel mode gre ip` / `tunnel mode ipsec ipv4` and their `no` forms (GRE is the unrendered default). */
const tunnelMode: CommandHandler = (ctx, args, negate) => {
  const port = selected(ctx);
  if (typeof port !== 'string') return port;
  if (negate || args[TUNNEL_MODE_ARG] !== TUNNEL_MODE_IPSEC) {
    // back to GRE: the default line is not stored
    return interfaceLine(ctx, port, ['tunnel', 'mode']) === undefined ? {} : outcomeOf(ctx.config(['tunnel', 'mode'], true));
  }
  return outcomeOf(ctx.config(['tunnel', 'mode', 'ipsec', 'ipv4'], false));
};

/** [C13] `tunnel protection ipsec profile <p>` / `no tunnel protection [ipsec profile [<p>]]`. */
const tunnelProtection: CommandHandler = (ctx, args, negate) => {
  const port = selected(ctx);
  if (typeof port !== 'string') return port;
  if (negate) return outcomeOf(ctx.config(['tunnel', 'protection'], true));
  const name = args['name'] ?? '';
  if (name === '') return { error: '% Give the IPsec profile name.' };
  if (!tunnelIsIpsec(ctx, port)) return { error: CLI_MESSAGES.ipsecProtectionVtiOnly };
  const error = ctx.config(['tunnel', 'protection', 'ipsec', 'profile', name], false);
  if (error !== undefined) return { error };
  return ipsecProfileExists(ctx, name) ? {} : { output: fillTemplate(CLI_MESSAGES.ipsecProfileMissing, { name }) };
};

/** A numeric interface line `<head…> <n>` / `no <head…>`. */
function numericLine(head: readonly string[], arg: string): CommandHandler {
  return (ctx, args, negate) => {
    const port = selected(ctx);
    if (typeof port !== 'string') return port;
    if (negate) return outcomeOf(ctx.config([...head], true));
    const value = args[arg] ?? '';
    if (value === '') return { error: '% Give the value in bytes.' };
    return outcomeOf(ctx.config([...head, String(Number(value))], false));
  };
}

/** [S19] `ppp authentication <first> [<second>]` / `no ppp authentication`. */
const pppAuthentication: CommandHandler = (ctx, args, negate) => {
  const port = selected(ctx);
  if (typeof port !== 'string') return port;
  if (negate) return outcomeOf(ctx.config(['ppp', 'authentication'], true));
  const first = args['first'] ?? '';
  const second = args['second'];
  if (first === '') return { error: '% Give the authentication protocol (chap or pap).' };
  if (second !== undefined && second === first) return { error: MSG_PPP_AUTH_TWICE };
  return outcomeOf(ctx.config(['ppp', 'authentication', first, ...(second === undefined ? [] : [second])], false));
};

/** [S19] `ppp pap sent-username <n> password <pw>` / `no ppp pap sent-username`. */
const pppPapSentUsername: CommandHandler = (ctx, args, negate) => {
  const port = selected(ctx);
  if (typeof port !== 'string') return port;
  if (negate) return outcomeOf(ctx.config(['ppp', 'pap', 'sent-username'], true));
  const name = args['name'] ?? '';
  const plain = args['secret'] ?? '';
  if (name === '') return { error: '% Give the user name to send.' };
  if (plain === '') return { error: MSG_PASSWORD_EMPTY };
  return outcomeOf(ctx.config(['ppp', 'pap', 'sent-username', name, 'password', ...recoverablePasswordTokens(ctx, plain)], false));
};

/** [S19] `peer neighbor-route` (the default: clears the stored negation) / `no peer neighbor-route` (stored). */
const peerNeighborRoute: CommandHandler = (ctx, _args, negate) => {
  const port = selected(ctx);
  if (typeof port !== 'string') return port;
  return outcomeOf(ctx.config(['peer', 'neighbor-route'], negate));
};

/** [S19] `username <n> password <pw>` / `no username <n>` (one entry per user: it replaces a `secret` entry). */
const usernamePassword: CommandHandler = (ctx, args, negate) => {
  const name = args['name'] ?? '';
  if (name === '') return { error: '% Give the user name.' };
  if (negate) return outcomeOf(ctx.config(['username', name], true, []));
  const plain = args['secret'] ?? '';
  if (plain === '') return { error: MSG_PASSWORD_EMPTY };
  return outcomeOf(ctx.config(['username', name, 'password', ...recoverablePasswordTokens(ctx, plain)], false, []));
};

/** @since P3 [S18]/[S19]/[C13] Registry fragment: WAN handler id → handler. */
export const wanHandlers: Readonly<Record<string, CommandHandler>> = {
  [WAN_HANDLERS.ifTunnelSource]: tunnelSource,
  [WAN_HANDLERS.ifTunnelDestination]: tunnelDestination,
  [WAN_HANDLERS.ifTunnelMode]: tunnelMode,
  [WAN_HANDLERS.ifTunnelProtection]: tunnelProtection,
  [WAN_HANDLERS.ifIpMtu]: numericLine(['ip', 'mtu'], 'bytes'),
  [WAN_HANDLERS.ifIpTcpAdjustMss]: numericLine(['ip', 'tcp', 'adjust-mss'], 'bytes'),
  [WAN_HANDLERS.ifPppAuthentication]: pppAuthentication,
  [WAN_HANDLERS.ifPppPapSentUsername]: pppPapSentUsername,
  [WAN_HANDLERS.ifPeerNeighborRoute]: peerNeighborRoute,
  [WAN_HANDLERS.configUsernamePassword]: usernamePassword,
};
