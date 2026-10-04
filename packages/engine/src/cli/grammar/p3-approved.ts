/**
 * cli/grammar/p3-approved.ts — the grammar fragments of the approved P3 items (ARCHITECTURE-P3 §7 W2 "Approved items
 * in W2", cli; §8.5): [C1] EIGRP, [S18]/[S19] tunnels and PPP (with the [C13] tunnel lines), [C13] the crypto
 * sections, [S20]/[S21] the queueing actions, [S24]/[S25] logging, [S13] the remote terminal client and [S32] the
 * developer host's shell. Owned by the W2 builder cli-b; cli-a folds this aggregate into `GRAMMAR`
 * (cli/grammar/index.ts): `P3_APPROVED_GRAMMAR_FRAGMENTS` after the P3 MUST fragments, `P3_APPROVED_HANDLER_IDS` into
 * `HANDLERS`, `P3_APPROVED_LITERAL_HELP` into `LITERAL_HELP` (keys the MUST fragments already define keep theirs).
 *
 * W3 cli (cli-b) adds the approved items' shows and clears (§5.8) to their fragments, and their debug categories:
 * each fragment holds its `debug <category>` specs (so `GRAMMAR` has them through the W2 fold), and
 * `P3_APPROVED_DEBUG_CATEGORIES` lists the categories, in the §5.8 table order, for the fold into `DEBUG_CATEGORY_DEFS`
 * (cli/grammar/index.ts, cli-a). Every category is scoped by capability literals like the rest of the P3 grammar (the
 * §2.1 rows of its daemon); `syslog` is registered but offered on no device (servers have the host shell, no `debug`).
 */
import type { CommandSpec } from '../../contracts/cli.js';
import { DEBUG_CATEGORY_ARG, type GrammarDebugCategory } from './core-exec.js';
import { CRYPTO_DEBUG_CATEGORIES, CRYPTO_DEBUG_OBJECTIVES, CRYPTO_GRAMMAR, CRYPTO_HANDLERS, CRYPTO_LITERAL_HELP } from './crypto.js';
import { DEVHOST_GRAMMAR, DEVHOST_HANDLERS } from './devhost.js';
import { EIGRP_DEBUG_CATEGORIES, EIGRP_DEBUG_OBJECTIVES, EIGRP_GRAMMAR, EIGRP_HANDLERS, EIGRP_LITERAL_HELP } from './eigrp.js';
import { LOGGING_DEBUG_CATEGORIES, LOGGING_DEBUG_OBJECTIVES, LOGGING_GRAMMAR, LOGGING_HANDLERS, LOGGING_LITERAL_HELP } from './logging.js';
import { QOS_QUEUEING_GRAMMAR, QOS_QUEUEING_HANDLERS, QOS_QUEUEING_LITERAL_HELP } from './qos-queueing.js';
import { REMOTE_DEBUG_CATEGORIES, REMOTE_DEBUG_OBJECTIVES, REMOTE_GRAMMAR, REMOTE_HANDLERS } from './remote.js';
import { WAN_DEBUG_CATEGORIES, WAN_DEBUG_OBJECTIVES, WAN_GRAMMAR, WAN_HANDLERS, WAN_LITERAL_HELP } from './wan.js';

export * from './crypto.js';
export * from './devhost.js';
export * from './eigrp.js';
export * from './logging.js';
export * from './qos-queueing.js';
export * from './remote.js';
export * from './wan.js';

/** @since P3 The approved items' grammar fragments by name, in table order. */
export const P3_APPROVED_GRAMMAR_FRAGMENTS: Readonly<Record<string, readonly CommandSpec[]>> = Object.freeze({
  eigrp: EIGRP_GRAMMAR, // [C1]
  wan: WAN_GRAMMAR, // [S18] [S19] (and the [C13] tunnel lines)
  crypto: CRYPTO_GRAMMAR, // [C13]
  'qos-queueing': QOS_QUEUEING_GRAMMAR, // [S20] [S21]
  logging: LOGGING_GRAMMAR, // [S24] [S25]
  remote: REMOTE_GRAMMAR, // [S13]
  devhost: DEVHOST_GRAMMAR, // [S32]
});

/** @since P3 Every approved-item spec, in `P3_APPROVED_GRAMMAR_FRAGMENTS` order. */
export const P3_APPROVED_GRAMMAR: readonly CommandSpec[] = Object.freeze(Object.values(P3_APPROVED_GRAMMAR_FRAGMENTS).flat());

/** @since P3 Handler ids of the approved items' fragments (frozen names shared with cli/handlers/p3-approved.ts). */
export const P3_APPROVED_HANDLER_IDS = Object.freeze({
  ...EIGRP_HANDLERS,
  ...WAN_HANDLERS,
  ...CRYPTO_HANDLERS,
  ...QOS_QUEUEING_HANDLERS,
  ...LOGGING_HANDLERS,
  ...REMOTE_HANDLERS,
  ...DEVHOST_HANDLERS,
});

/** @since P3 Union of every approved-item handler id. */
export type P3ApprovedHandlerId = (typeof P3_APPROVED_HANDLER_IDS)[keyof typeof P3_APPROVED_HANDLER_IDS];

/**
 * @since P3 (W3 cli) The approved items' debug categories in the §5.8 table order: [S13] `ip ssh`, `telnet`; [S18]
 * `tunnel`; [S19] `ppp negotiation`, `ppp authentication`; [S25] `syslog`; [C1] `eigrp packets`, `eigrp fsm`; [C13]
 * `crypto ikev2`. Their `debug` specs are already in the fragments above (`P3_APPROVED_DEBUG_GRAMMAR` lists them);
 * cli-a appends this list to `DEBUG_CATEGORY_DEFS`, which the `debug` handler validates against.
 */
export const P3_APPROVED_DEBUG_CATEGORIES: readonly GrammarDebugCategory[] = Object.freeze([
  ...REMOTE_DEBUG_CATEGORIES,
  ...WAN_DEBUG_CATEGORIES,
  ...LOGGING_DEBUG_CATEGORIES,
  ...EIGRP_DEBUG_CATEGORIES,
  ...CRYPTO_DEBUG_CATEGORIES,
]);

/** @since P3 (W3 cli) Objectives of the approved items' debug categories. */
export const P3_APPROVED_DEBUG_OBJECTIVES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ...REMOTE_DEBUG_OBJECTIVES,
  ...WAN_DEBUG_OBJECTIVES,
  ...LOGGING_DEBUG_OBJECTIVES,
  ...EIGRP_DEBUG_OBJECTIVES,
  ...CRYPTO_DEBUG_OBJECTIVES,
});

/** @since P3 (W3 cli) The `debug <category>` specs of the approved fragments, in `P3_APPROVED_GRAMMAR` order. */
export const P3_APPROVED_DEBUG_GRAMMAR: readonly CommandSpec[] = Object.freeze(
  P3_APPROVED_GRAMMAR.filter((s) => s.path[0] === 'debug' && s.fixedArgs?.[DEBUG_CATEGORY_ARG] !== undefined),
);

/** @since P3 Help of the approved items' intermediate keywords (the fold merges it under `LITERAL_HELP`). */
export const P3_APPROVED_LITERAL_HELP: Readonly<Record<string, string>> = Object.freeze({
  ...EIGRP_LITERAL_HELP,
  ...WAN_LITERAL_HELP,
  ...CRYPTO_LITERAL_HELP,
  ...QOS_QUEUEING_LITERAL_HELP,
  ...LOGGING_LITERAL_HELP,
});
