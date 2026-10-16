/**
 * cli/handlers/monitor.ts — the handlers of cli/grammar/monitor.ts: [S34] local SPAN: `monitor session <n> source|destination …`, `no monitor session`, `show monitor session` (ARCHITECTURE-P3C §7 W3a2).
 *
 * @since P3c Registered EMPTY by the architect in W0: cli/handlers/index.ts folds this registry into
 * `HANDLER_REGISTRY`, so the W3a2 cli-management builder fills it without editing a shared registry.
 */
import type { CommandHandler } from '../../contracts/cli.js';

/** @since P3c Handler id → handler for every id of `MONITOR_HANDLERS` (empty until W3a2). */
export const monitorHandlers: Record<string, CommandHandler> = {};
