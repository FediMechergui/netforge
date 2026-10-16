/**
 * cli/handlers/snmp.ts — the handlers of cli/grammar/snmp.ts: [S33] [C23] the SNMP agent lines (`snmp-server community|host|location|contact|enable traps|user|group`) and their shows (ARCHITECTURE-P3C §7 W3a2).
 *
 * @since P3c Registered EMPTY by the architect in W0: cli/handlers/index.ts folds this registry into
 * `HANDLER_REGISTRY`, so the W3a2 cli-management builder fills it without editing a shared registry.
 */
import type { CommandHandler } from '../../contracts/cli.js';

/** @since P3c Handler id → handler for every id of `SNMP_HANDLERS` (empty until W3a2). */
export const snmpHandlers: Record<string, CommandHandler> = {};
