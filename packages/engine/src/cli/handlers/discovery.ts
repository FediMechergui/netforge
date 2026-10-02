/**
 * cli/handlers/discovery.ts — CDP and LLDP lines (ARCHITECTURE-P3 §5.5, D2, D18; §7 W2 cli part 1).
 *
 * The lines are stored as the W1 config rules say: `cdp run` and `cdp enable` are `bothForms` slots (each form stored
 * as typed, so `no cdp run` survives export and reload in a P3 world where CDP runs by default, and `cdp run` typed in
 * a P2 world works, D2); `cdp advertise-v2`, `lldp transmit` and `lldp receive` are stored negations (only the `no`
 * form is stored); the timers are single slots whose `no` form restores the default. The daemons read them. Every
 * string is original wording (spec §1.6).
 */
import type { CommandHandler } from '../../contracts/cli.js';
import { DISCOVERY_FORM_ARG, DISCOVERY_HANDLERS } from '../grammar/discovery.js';
import { globalContext, MSG_NO_INTERFACE_SELECTED, outcomeOf, selectedInterface } from './common.js';

/** `[no] cdp run`, `cdp timer|holdtime <s>`, `[no] cdp advertise-v2`. */
const configCdp: CommandHandler = (ctx, args, negate) => {
  const form = args[DISCOVERY_FORM_ARG] ?? '';
  if (form === 'timer' || form === 'holdtime') {
    if (negate) return outcomeOf(ctx.config(['cdp', form], true, globalContext()));
    return outcomeOf(ctx.config(['cdp', form, args['seconds'] ?? ''], false, globalContext()));
  }
  return outcomeOf(ctx.config(['cdp', form], negate, globalContext()));
};

/** `cdp enable` / `no cdp enable` on an Ethernet interface. */
const ifCdpEnable: CommandHandler = (ctx, _args, negate) => {
  if (selectedInterface(ctx) === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  return outcomeOf(ctx.config(['cdp', 'enable'], negate));
};

/** `lldp run`, `lldp timer|holdtime|reinit <s>` and their `no` forms. */
const configLldp: CommandHandler = (ctx, args, negate) => {
  const form = args[DISCOVERY_FORM_ARG] ?? '';
  if (form === 'run') return outcomeOf(ctx.config(['lldp', 'run'], negate, globalContext()));
  if (negate) return outcomeOf(ctx.config(['lldp', form], true, globalContext()));
  return outcomeOf(ctx.config(['lldp', form, args['seconds'] ?? ''], false, globalContext()));
};

/** `[no] lldp transmit`, `[no] lldp receive` on an Ethernet interface. */
const ifLldp: CommandHandler = (ctx, args, negate) => {
  if (selectedInterface(ctx) === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  return outcomeOf(ctx.config(['lldp', args[DISCOVERY_FORM_ARG] ?? ''], negate));
};

/** @since P3 Registry fragment: the CDP and LLDP lines (`DISCOVERY_HANDLERS` ids). */
export const discoveryHandlers: Readonly<Record<string, CommandHandler>> = {
  [DISCOVERY_HANDLERS.configCdp]: configCdp,
  [DISCOVERY_HANDLERS.ifCdpEnable]: ifCdpEnable,
  [DISCOVERY_HANDLERS.configLldp]: configLldp,
  [DISCOVERY_HANDLERS.ifLldp]: ifLldp,
};
