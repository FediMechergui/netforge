/**
 * cli/handlers/errdisable.ts — `errdisable recovery cause|interval` and `show errdisable recovery` (ARCHITECTURE-P2
 * §3.8 step 6, §5.1, §5.4, D12; §7 W3 cli).
 *
 * The lines are stored as typed (one `cause` line per cause; `all` covers every cause); the daemon of each cause
 * reads them through `errdisableRecovery` (protocols/l2/port-security.ts) when it err-disables a port. The show
 * command lists, per configurable cause, whether recovery is on, the interval, and the ports currently
 * error-disabled with their cause and whether they will come back by themselves. Every string is original wording.
 */
import type { CommandCtx, CommandHandler } from '../../contracts/cli.js';
import { ERR_DISABLE_CAUSES, type ErrDisableCause } from '../../contracts/port.js';
import { SEC } from '../../contracts/time.js';
import { errdisableRecovery } from '../../protocols/l2/port-security.js';
import { ERRDISABLE_INTERVAL_MAX_S, ERRDISABLE_INTERVAL_MIN_S, ERRDISABLE_RECOVERY_CAUSES, P2_HANDLERS } from '../grammar/index.js';
import { table } from '../format.js';
import { outcomeOf } from './common.js';
import { ERR_DISABLE_REASON_TEXT } from './show.js';

/** `show errdisable recovery` with no error-disabled port. */
export const MSG_NO_ERR_DISABLED_PORT = 'No port is error-disabled.';

/** The causes `show errdisable recovery` lists: every cause a daemon can raise (`fault` is the lab's injected one). */
export const ERRDISABLE_SHOWN_CAUSES: readonly ErrDisableCause[] = ERR_DISABLE_CAUSES.filter((c) => c !== 'fault');

/** `errdisable recovery cause <cause>` / its `no` form. */
const recoveryCause: CommandHandler = (ctx, args, negate) => {
  const cause = args['cause'] ?? '';
  if (!(ERRDISABLE_RECOVERY_CAUSES as readonly string[]).includes(cause)) return { error: `% Give the cause: ${ERRDISABLE_RECOVERY_CAUSES.join(', ')}.` };
  return outcomeOf(ctx.config(['errdisable', 'recovery', 'cause', cause], negate, []));
};

/** `errdisable recovery interval <s>` / its `no` form. */
const recoveryInterval: CommandHandler = (ctx, args, negate) => {
  if (negate) return outcomeOf(ctx.config(['errdisable', 'recovery', 'interval'], true, []));
  const seconds = Number(args['seconds']);
  if (!Number.isInteger(seconds) || seconds < ERRDISABLE_INTERVAL_MIN_S || seconds > ERRDISABLE_INTERVAL_MAX_S) {
    return { error: `% Give an interval between ${ERRDISABLE_INTERVAL_MIN_S} and ${ERRDISABLE_INTERVAL_MAX_S} seconds.` };
  }
  return outcomeOf(ctx.config(['errdisable', 'recovery', 'interval', String(seconds)], false, []));
};

/** The `show errdisable recovery` text. */
export function renderErrdisableRecovery(ctx: CommandCtx): string {
  const rows: string[][] = [['Cause', 'Automatic recovery']];
  for (const cause of ERRDISABLE_SHOWN_CAUSES) rows.push([cause, errdisableRecovery(ctx.running, cause).enabled ? 'on' : 'off']);
  const interval = errdisableRecovery(ctx.running, 'psecure-violation').intervalNs / SEC;
  const lines = [table(rows), '', `Recovery interval: ${interval} s`, ''];
  const ports: string[][] = [['Port', 'Cause', 'Comes back']];
  for (const p of ctx.ports.values()) {
    if (p.errDisabled === undefined || p.errDisabled === '') continue;
    const cause = p.errDisabled as ErrDisableCause;
    const auto = ERR_DISABLE_CAUSES.includes(cause) && errdisableRecovery(ctx.running, cause).enabled;
    ports.push([p.id, ERR_DISABLE_REASON_TEXT[cause] ?? cause, auto ? `by itself, within ${interval} s` : 'after shutdown / no shutdown']);
  }
  lines.push(ports.length === 1 ? MSG_NO_ERR_DISABLED_PORT : table(ports));
  return lines.join('\n');
}

const showRecovery: CommandHandler = (ctx) => ({ output: renderErrdisableRecovery(ctx) });

/** @since P2 Registry fragment: the errdisable lines and show command. */
export const errdisableHandlers: Readonly<Record<string, CommandHandler>> = {
  [P2_HANDLERS.configErrdisableRecoveryCause]: recoveryCause,
  [P2_HANDLERS.configErrdisableRecoveryInterval]: recoveryInterval,
  [P2_HANDLERS.showErrdisableRecovery]: showRecovery,
};
