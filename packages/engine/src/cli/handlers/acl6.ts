/**
 * cli/handlers/acl6.ts — the handlers of cli/grammar/acl6.ts: [S11] IPv6 access lists: `ipv6 access-list <name>` (the `config-ipv6-acl` mode), `ipv6 traffic-filter`, `ipv6 access-class`, `show ipv6 access-list`, `clear ipv6 access-list` (ARCHITECTURE-P3C §7 W3a1).
 *
 * @since P3c Registered EMPTY by the architect in W0: cli/handlers/index.ts folds this registry into
 * `HANDLER_REGISTRY`, so the W3a1 cli-acl builder fills it without editing a shared registry.
 */
import type { CommandHandler } from '../../contracts/cli.js';

/** @since P3c Handler id → handler for every id of `ACL6_HANDLERS` (empty until W3a1). */
export const acl6Handlers: Record<string, CommandHandler> = {};
