/**
 * cli/handlers/routing.ts — `ip routing` / `no ip routing` and [S7] `ip proxy-arp` / `no ip proxy-arp`
 * (ARCHITECTURE-P2 §3.5, §5.2, D2; §7 W2 cli).
 *
 * Both are plain config lines: `ip routing` is a `bothForms` rule (each form is stored as typed and replaces the
 * other, so a P2-profile multilayer switch that typed `ip routing` after the replayed `no ip routing` shows and
 * exports `ip routing`; ipv4 and host read the line). `ip proxy-arp` is a stored negation: `no ip proxy-arp` is
 * stored, `ip proxy-arp` clears the slot and stores nothing (the arp daemon then takes the profile default: on in a
 * P2 world for a routed interface of a routing device, off in P1 — so in a P1 world `ip proxy-arp` is a no-op, as
 * §5.2 binds). Every string is original wording (spec §1.6).
 */
import type { CommandHandler } from '../../contracts/cli.js';
import { P2_HANDLERS } from '../grammar/index.js';
import { MSG_NO_INTERFACE_SELECTED, outcomeOf, selectedInterface } from './common.js';

/** `ip routing` / `no ip routing`. */
const ipRouting: CommandHandler = (ctx, _args, negate) => outcomeOf(ctx.config(['ip', 'routing'], negate, []));

// [S7] ── proxy ARP ──────────────────────────────────────────────────────────────────────────────────────────────
/** [S7] `ip proxy-arp` / `no ip proxy-arp` on the selected interface. */
const ipProxyArp: CommandHandler = (ctx, _args, negate) => {
  if (selectedInterface(ctx) === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  return outcomeOf(ctx.config(['ip', 'proxy-arp'], negate));
};
// [S7] ── end ──────────────────────────────────────────────────────────────────────────────────────────────────

/** @since P2 Registry fragment: the routing switches. */
export const routingHandlers: Readonly<Record<string, CommandHandler>> = {
  [P2_HANDLERS.configIpRouting]: ipRouting,
  [P2_HANDLERS.ifIpProxyArp]: ipProxyArp, // [S7]
};
