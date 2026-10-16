/**
 * cli/handlers/files.ts — the handlers of cli/grammar/files.ts: [S29] [S30] [S31] device files: the `copy` forms with the `url` argument, `dir`, `show flash:`, `delete`, `tftp-server`, `boot system`, `verify /md5`, the immediate `config-register`, and the `rommon` mode (ARCHITECTURE-P3C §7 W3a2).
 *
 * @since P3c Registered EMPTY by the architect in W0: cli/handlers/index.ts folds this registry into
 * `HANDLER_REGISTRY`, so the W3a2 cli-management builder fills it without editing a shared registry.
 */
import type { CommandHandler } from '../../contracts/cli.js';

/** @since P3c Handler id → handler for every id of `FILES_HANDLERS` (empty until W3a2). */
export const filesHandlers: Record<string, CommandHandler> = {};
