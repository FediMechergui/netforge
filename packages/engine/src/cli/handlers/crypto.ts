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
 *   show.crypto-ikev2-sa           (W3 cli) `show crypto ikev2 sa`: one line per `ipsec-sa` row (the §5.8 example)
 *   show.crypto-ipsec-sa           (W3 cli) `show crypto ipsec sa [interface <if>]`: SPIs from the row, packet counters
 *                                  from the gre StateView (§2.17)
 *
 * The stored lines are the W1 rules' canonical forms (cli/config-rules.ts, the [C13] block); the ike daemon reads them.
 * Messages are original wording (spec §1.6).
 */
import type { CommandCtx, CommandHandler } from '../../contracts/cli.js';
import type { PortId } from '../../contracts/ids.js';
import type { IpsecSaRow, IpsecTunnelCounters } from '../../contracts/tables.js';
import { fmtSince, table } from '../format.js';
import { AUTH_SIDE_ARG, CRYPTO_HANDLERS, CRYPTO_MODES } from '../grammar/crypto.js';
import { enterMode, outcomeOf } from './common.js';
import { TUNNEL_DOWN_REASON_TEXT } from './show.js';

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

// ── W3 cli (cli-b): the shows (§2.17, §3.13, §5.8) ───────────────────────────────────────────────────────────────

/** @since P3 (W3 cli) [C13] `show crypto ikev2 sa` / `show crypto ipsec sa` with no security association. */
export const MSG_NO_IKE_SA = 'No IKEv2 security association exists.';
export const MSG_NO_IPSEC_SA = 'No IPsec security association exists.';

/** @since P3 (W3 cli) [C13] The tunnel owner, whose StateView carries each ipsec tunnel's packet counters (§2.17). */
export const GRE_PROCESS = 'gre';

/** The `ipsec-sa` rows in the device's port order. */
function ipsecRows(ctx: CommandCtx): IpsecSaRow[] {
  const order = new Map<PortId, number>();
  for (const id of ctx.ports.keys()) order.set(id, order.size);
  const rows = ctx.tables.get<IpsecSaRow>('ipsec-sa')?.rows() ?? [];
  return rows.sort((a, b) => (order.get(a.port) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.port) ?? Number.MAX_SAFE_INTEGER));
}

/**
 * `show crypto ikev2 sa` (§5.8): one line per protected tunnel — the tunnel, both ends, the role, the state and the
 * proposal chosen — then, for a failed exchange, why (it is retried every 10 s, §3.13 step 10).
 */
const showCryptoIkev2Sa: CommandHandler = (ctx) => {
  const rows = ipsecRows(ctx);
  if (rows.length === 0) return { output: MSG_NO_IKE_SA };
  const out: string[][] = [['Tunnel', 'Local', 'Remote', 'Role', 'State', 'Proposal']];
  for (const r of rows) out.push([r.port, r.local, r.peer, r.role, r.state, r.proposal ?? '-']);
  const notes = rows.filter((r) => r.state === 'failed' && r.reason !== undefined).map((r) => `${r.port}: ${TUNNEL_DOWN_REASON_TEXT[r.reason!]}; the exchange is retried every 10 s`);
  return { output: [table(out, { minWidths: [8] }), ...notes].join('\n') };
};

/** An ESP SPI as 8 hex digits, or a note while none is chosen. */
function spiText(spi: number | undefined): string {
  return spi === undefined ? 'none yet' : `0x${(spi >>> 0).toString(16).padStart(8, '0')}`;
}

/** The gre StateView's counters of one ipsec tunnel (§2.17), read defensively: a StateView is display data. */
export function ipsecTunnelCounters(ctx: Pick<CommandCtx, 'processState'>, port: PortId): Partial<IpsecTunnelCounters> {
  const tunnels = ctx.processState(GRE_PROCESS)?.state['tunnels'];
  if (!Array.isArray(tunnels)) return {};
  const t = tunnels.find((x: unknown) => typeof x === 'object' && x !== null && (x as { port?: unknown }).port === port) as Record<string, unknown> | undefined;
  const out: { -readonly [K in keyof IpsecTunnelCounters]?: number } = {};
  for (const k of ['encaps', 'decaps', 'seqOut', 'lastSeqIn', 'noSa'] as const) {
    const v = t?.[k];
    if (typeof v === 'number') out[k] = v;
  }
  return out;
}

/** One `show crypto ipsec sa` block: ends, selectors, state, SPIs and the packet counters of the tunnel owner. */
function ipsecBlock(ctx: CommandCtx, r: IpsecSaRow): string {
  const c = ipsecTunnelCounters(ctx, r.port);
  const n = (v: number | undefined): string => String(v ?? 0);
  const state = r.state === 'failed' && r.reason !== undefined ? `failed (${TUNNEL_DOWN_REASON_TEXT[r.reason]})` : r.state;
  return [
    `Interface ${r.port}, profile ${r.profile}`,
    `  Local ${r.local}, peer ${r.peer}, traffic selectors 0.0.0.0/0 both ways`,
    `  State ${state}, ${r.role}, for ${fmtSince(r.since, ctx.now)}`,
    `  Inbound ESP SA: SPI ${spiText(r.espSpiIn)}`,
    `  Outbound ESP SA: SPI ${spiText(r.espSpiOut)}`,
    `  Packets encapsulated ${n(c.encaps)}, decapsulated ${n(c.decaps)}`,
    `  Outbound sequence ${n(c.seqOut)}, last inbound sequence ${n(c.lastSeqIn)}, dropped for no SA ${n(c.noSa)}`,
  ].join('\n');
}

/** `show crypto ipsec sa [interface <if>]` (§2.17). */
const showCryptoIpsecSa: CommandHandler = (ctx, args) => {
  let rows = ipsecRows(ctx);
  const name = args['iface'];
  if (name !== undefined && name !== '') {
    const id = ctx.ports.has(name) ? name : ctx.resolvePort(name);
    if (id === undefined) return { error: `% No interface named "${name}" exists on this device.` };
    rows = rows.filter((r) => r.port === id);
    if (rows.length === 0) return { output: `No IPsec security association exists on ${id}.` };
  }
  if (rows.length === 0) return { output: MSG_NO_IPSEC_SA };
  return { output: rows.map((r) => ipsecBlock(ctx, r)).join('\n\n') };
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
  [CRYPTO_HANDLERS.showCryptoIkev2Sa]: showCryptoIkev2Sa,
  [CRYPTO_HANDLERS.showCryptoIpsecSa]: showCryptoIpsecSa,
};
