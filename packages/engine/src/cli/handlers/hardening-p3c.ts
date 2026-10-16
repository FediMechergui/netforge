/**
 * cli/handlers/hardening-p3c.ts — the handlers of cli/grammar/hardening-p3c.ts: [S15] IP source guard (`ip verify source`), [S16] storm control, [S14] ARP access lists (the `config-arp-nacl` mode) and `ip arp inspection validate`, with their shows (ARCHITECTURE-P3C §7 W3a1).
 *
 * @since P3c Registered EMPTY by the architect in W0: cli/handlers/index.ts folds this registry into
 * `HANDLER_REGISTRY`, so the W3a1 cli-acl builder fills it without editing a shared registry.
 */
import type { CommandHandler } from '../../contracts/cli.js';

/** @since P3c Handler id → handler for every id of `HARDENING_P3C_HANDLERS` (empty until W3a1). */
export const hardeningP3cHandlers: Record<string, CommandHandler> = {};
