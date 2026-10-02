/**
 * cli/handlers/qos-queueing.ts — [S20]/[S21] the queueing actions of a policy-map class and interface WFQ
 * (ARCHITECTURE-P3 §5.4, D16; §7 W2 cli, approved items).
 *
 *   pmap-c.priority     `priority <kbps>` | `priority percent <p>` (not in class-default; not beside `bandwidth`)
 *   pmap-c.bandwidth    `bandwidth <kbps>` | `bandwidth percent <p>` | `bandwidth remaining percent <p>` (not beside
 *                       `priority`)
 *   pmap-c.queue-limit  `queue-limit <packets>`
 *   pmap-c.fair-queue   `fair-queue` (class-default only)
 *   pmap-c.police       `police <bps> [<bc>] [conform-action <a> [exceed-action <a>]]`, stored in full:
 *                       `police <bps> [<bc>] conform-action <a> exceed-action <a>` (defaults transmit / drop), where
 *                       <a> is `transmit`, `drop` or `set-dscp-transmit <v>` (a DSCP number 0-63 or name)
 *   pmap-c.shape        `shape average <bps> [<bc>]`
 *   if.fair-queue       interface `fair-queue` / `no fair-queue`
 * Every `no` form removes its line. The stored lines are the W1 rules' canonical forms (cli/config-rules.ts, the
 * [S20]/[S21] block); the runtime's policy reader and the link scheduler read them. Messages are original wording.
 */
import type { CommandCtx, CommandHandler } from '../../contracts/cli.js';
import {
  QOS_BURST_MAX,
  QOS_BURST_MIN,
  QOS_QUEUEING_HANDLERS,
  RATE_FORM_ARG,
  RATE_FORM_PERCENT,
  RATE_FORM_REMAINING,
} from '../grammar/qos-queueing.js';
import { MSG_NO_INTERFACE_SELECTED, outcomeOf, selectedInterface } from './common.js';

/** @since P3 [S20] A queueing line typed outside a class of a policy-map. */
export const MSG_NO_POLICY_CLASS = '% Enter "policy-map <name>" and then "class <name>" first.';
/** @since P3 [S20] `priority` and `bandwidth` in the same class. */
export const MSG_PRIORITY_OR_BANDWIDTH = '% A class is either the priority class or a bandwidth class, not both. Remove the other line first.';
/** @since P3 [S20] `priority` in class-default. */
export const MSG_PRIORITY_NOT_DEFAULT = '% The default class cannot be the priority class.';
/** @since P3 [S21] `fair-queue` in a class other than class-default. */
export const MSG_FAIR_QUEUE_DEFAULT_ONLY = '% Fair queueing applies to class-default only.';
/** @since P3 [S21] A `police` tail that does not read. */
export const MSG_POLICE_SYNTAX =
  '% Expected: police <bps> [<burst>] [conform-action transmit|drop|set-dscp-transmit <v> [exceed-action transmit|drop|set-dscp-transmit <v>]].';

/** @since P3 [S21] Name of the default class (every policy has one). */
export const CLASS_DEFAULT = 'class-default';

/** @since P3 [S21] DSCP names a policer may re-mark to (the standard per-hop behaviour names), with their values. */
export const DSCP_NAMES: Readonly<Record<string, number>> = Object.freeze({
  default: 0,
  cs1: 8, af11: 10, af12: 12, af13: 14,
  cs2: 16, af21: 18, af22: 20, af23: 22,
  cs3: 24, af31: 26, af32: 28, af33: 30,
  cs4: 32, af41: 34, af42: 36, af43: 38,
  cs5: 40, ef: 46,
  cs6: 48, cs7: 56,
});

/** The class entry (`['class', <c>]`) of a session inside a policy-map class, or undefined. */
function classEntry(ctx: CommandCtx): readonly string[] | undefined {
  const e = ctx.context[ctx.context.length - 1];
  const p = ctx.context[ctx.context.length - 2];
  return e !== undefined && e[0] === 'class' && p !== undefined && p[0] === 'policy-map' ? e : undefined;
}

/** The stored children of the session's class section (empty when it is not stored yet). */
function classChildren(ctx: CommandCtx): readonly { key: string; args: readonly string[] }[] {
  const policy = ctx.context[ctx.context.length - 2];
  const cls = ctx.context[ctx.context.length - 1];
  if (policy === undefined || cls === undefined) return [];
  const pnode = ctx.running.root.children.find((c) => c.key === 'policy-map' && c.args[0] === policy[1]);
  const cnode = pnode?.children.find((c) => c.key === 'class' && c.args[0] === cls[1]);
  return cnode?.children ?? [];
}

const hasLine = (ctx: CommandCtx, key: string): boolean => classChildren(ctx).some((c) => c.key === key);

/** `priority <kbps>` | `priority percent <p>` / `no priority`. */
const priority: CommandHandler = (ctx, args, negate) => {
  const cls = classEntry(ctx);
  if (cls === undefined) return { error: MSG_NO_POLICY_CLASS };
  if (negate) return outcomeOf(ctx.config(['priority'], true));
  if (cls[1] === CLASS_DEFAULT) return { error: MSG_PRIORITY_NOT_DEFAULT };
  if (hasLine(ctx, 'bandwidth')) return { error: MSG_PRIORITY_OR_BANDWIDTH };
  const tokens = args[RATE_FORM_ARG] === RATE_FORM_PERCENT ? ['priority', 'percent', String(Number(args['percent'] ?? ''))] : ['priority', String(Number(args['kbps'] ?? ''))];
  return outcomeOf(ctx.config(tokens, false));
};

/** `bandwidth <kbps>` | `bandwidth percent <p>` | `bandwidth remaining percent <p>` / `no bandwidth`. */
const bandwidth: CommandHandler = (ctx, args, negate) => {
  if (classEntry(ctx) === undefined) return { error: MSG_NO_POLICY_CLASS };
  if (negate) return outcomeOf(ctx.config(['bandwidth'], true));
  if (hasLine(ctx, 'priority')) return { error: MSG_PRIORITY_OR_BANDWIDTH };
  const form = args[RATE_FORM_ARG];
  const tokens =
    form === RATE_FORM_REMAINING
      ? ['bandwidth', 'remaining', 'percent', String(Number(args['percent'] ?? ''))]
      : form === RATE_FORM_PERCENT
        ? ['bandwidth', 'percent', String(Number(args['percent'] ?? ''))]
        : ['bandwidth', String(Number(args['kbps'] ?? ''))];
  return outcomeOf(ctx.config(tokens, false));
};

/** `queue-limit <packets>` / `no queue-limit`. */
const queueLimit: CommandHandler = (ctx, args, negate) => {
  if (classEntry(ctx) === undefined) return { error: MSG_NO_POLICY_CLASS };
  if (negate) return outcomeOf(ctx.config(['queue-limit'], true));
  return outcomeOf(ctx.config(['queue-limit', String(Number(args['packets'] ?? ''))], false));
};

/** `fair-queue` in class-default / `no fair-queue`. */
const classFairQueue: CommandHandler = (ctx, _args, negate) => {
  const cls = classEntry(ctx);
  if (cls === undefined) return { error: MSG_NO_POLICY_CLASS };
  if (negate) return outcomeOf(ctx.config(['fair-queue'], true));
  if (cls[1] !== CLASS_DEFAULT) return { error: MSG_FAIR_QUEUE_DEFAULT_ONLY };
  return outcomeOf(ctx.config(['fair-queue'], false));
};

/** One policer action read from `tokens` at `i`: the action tokens and the index after them, or undefined. */
function readAction(tokens: readonly string[], i: number): { action: string[]; next: number } | undefined {
  const a = tokens[i]?.toLowerCase();
  if (a === 'transmit' || a === 'drop') return { action: [a], next: i + 1 };
  if (a === 'set-dscp-transmit') {
    const v = tokens[i + 1]?.toLowerCase();
    if (v === undefined) return undefined;
    if (/^\d+$/.test(v) && Number(v) <= 63) return { action: [a, String(Number(v))], next: i + 2 };
    if (DSCP_NAMES[v] !== undefined) return { action: [a, v], next: i + 2 };
  }
  return undefined;
}

/**
 * @since P3 [S21] The canonical tokens after `police <bps>` of a typed tail (`[<bc>] [conform-action <a> [exceed-action
 * <a>]]`): the burst when given, then both actions (defaults transmit and drop); undefined when the tail does not read.
 */
export function policeTail(tail: string): string[] | undefined {
  const tokens = tail.trim() === '' ? [] : tail.trim().split(/\s+/);
  let i = 0;
  const out: string[] = [];
  const first = tokens[0];
  if (first !== undefined && /^\d+$/.test(first)) {
    const bc = Number(first);
    if (bc < QOS_BURST_MIN || bc > QOS_BURST_MAX) return undefined;
    out.push(String(bc));
    i = 1;
  }
  let conform = ['transmit'];
  let exceed = ['drop'];
  if (tokens[i]?.toLowerCase() === 'conform-action') {
    const r = readAction(tokens, i + 1);
    if (r === undefined) return undefined;
    conform = r.action;
    i = r.next;
  }
  if (tokens[i]?.toLowerCase() === 'exceed-action') {
    const r = readAction(tokens, i + 1);
    if (r === undefined) return undefined;
    exceed = r.action;
    i = r.next;
  }
  if (i !== tokens.length) return undefined;
  return [...out, 'conform-action', ...conform, 'exceed-action', ...exceed];
}

/** `police <bps> …` / `no police`. */
const police: CommandHandler = (ctx, args, negate) => {
  if (classEntry(ctx) === undefined) return { error: MSG_NO_POLICY_CLASS };
  if (negate) return outcomeOf(ctx.config(['police'], true));
  const tail = policeTail(args['actions'] ?? '');
  if (tail === undefined) return { error: MSG_POLICE_SYNTAX };
  return outcomeOf(ctx.config(['police', String(Number(args['bps'] ?? '')), ...tail], false));
};

/** `shape average <bps> [<bc>]` / `no shape average`. */
const shape: CommandHandler = (ctx, args, negate) => {
  if (classEntry(ctx) === undefined) return { error: MSG_NO_POLICY_CLASS };
  if (negate) return outcomeOf(ctx.config(['shape', 'average'], true));
  const burst = args['burst'];
  return outcomeOf(ctx.config(['shape', 'average', String(Number(args['bps'] ?? '')), ...(burst === undefined ? [] : [String(Number(burst))])], false));
};

/** Interface `fair-queue` / `no fair-queue`. */
const ifFairQueue: CommandHandler = (ctx, _args, negate) => {
  if (selectedInterface(ctx) === undefined) return { error: MSG_NO_INTERFACE_SELECTED };
  return outcomeOf(ctx.config(['fair-queue'], negate));
};

/** @since P3 [S20]/[S21] Registry fragment: queueing handler id → handler. */
export const qosQueueingHandlers: Readonly<Record<string, CommandHandler>> = {
  [QOS_QUEUEING_HANDLERS.pmapClassPriority]: priority,
  [QOS_QUEUEING_HANDLERS.pmapClassBandwidth]: bandwidth,
  [QOS_QUEUEING_HANDLERS.pmapClassQueueLimit]: queueLimit,
  [QOS_QUEUEING_HANDLERS.pmapClassFairQueue]: classFairQueue,
  [QOS_QUEUEING_HANDLERS.pmapClassPolice]: police,
  [QOS_QUEUEING_HANDLERS.pmapClassShape]: shape,
  [QOS_QUEUEING_HANDLERS.ifFairQueue]: ifFairQueue,
};
