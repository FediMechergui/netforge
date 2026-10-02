/**
 * cli/handlers/p3-approved.ts — the handlers of the approved P3 items' grammar (ARCHITECTURE-P3 §7 W2 "Approved items
 * in W2", cli). Owned by the W2 builder cli-b; cli-a folds this registry into `HANDLER_REGISTRY`
 * (cli/handlers/index.ts). Every id of `P3_APPROVED_HANDLER_IDS` (cli/grammar/p3-approved.ts) has an entry here: none
 * of them is runtime-bound (the runtime adds what they need through cli/command-ctx-p3.ts).
 */
import type { CommandHandler } from '../../contracts/cli.js';
import { cryptoHandlers } from './crypto.js';
import { devhostHandlers } from './devhost.js';
import { eigrpHandlers } from './eigrp.js';
import { loggingHandlers } from './logging.js';
import { qosQueueingHandlers } from './qos-queueing.js';
import { remoteHandlers } from './remote.js';
import { wanHandlers } from './wan.js';

/** @since P3 Handler id → handler, for every command of `P3_APPROVED_GRAMMAR_FRAGMENTS`. */
export const P3_APPROVED_HANDLERS: Record<string, CommandHandler> = {
  ...eigrpHandlers, // [C1]
  ...wanHandlers, // [S18] [S19] [C13]
  ...cryptoHandlers, // [C13]
  ...qosQueueingHandlers, // [S20] [S21]
  ...loggingHandlers, // [S24] [S25]
  ...remoteHandlers, // [S13]
  ...devhostHandlers, // [S32]
};
