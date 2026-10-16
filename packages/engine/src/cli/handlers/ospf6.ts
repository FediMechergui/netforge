/**
 * cli/handlers/ospf6.ts — the handlers of cli/grammar/ospf6.ts: [S6] OSPFv3: `ipv6 router ospf <pid>` (the `config-rtr` mode), `ipv6 ospf <pid> area <a>` and the interface lines, `show ipv6 ospf …`, `clear ipv6 ospf process`, the `debug ipv6 ospf …` categories (ARCHITECTURE-P3C §7 W3a1).
 *
 * @since P3c Registered EMPTY by the architect in W0: cli/handlers/index.ts folds this registry into
 * `HANDLER_REGISTRY`, so the W3a1 cli-routing builder fills it without editing a shared registry.
 */
import type { CommandHandler } from '../../contracts/cli.js';

/** @since P3c Handler id → handler for every id of `OSPF6_HANDLERS` (empty until W3a1). */
export const ospf6Handlers: Record<string, CommandHandler> = {};
