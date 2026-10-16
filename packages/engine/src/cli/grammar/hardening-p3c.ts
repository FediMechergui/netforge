/**
 * cli/grammar/hardening-p3c.ts — [S15] IP source guard (`ip verify source`), [S16] storm control, [S14] ARP access lists (the `config-arp-nacl` mode) and `ip arp inspection validate`, with their shows (ARCHITECTURE-P3C §5, §7 W3a1).
 *
 * @since P3c Registered EMPTY by the architect in W0 (§7 W0, the CLI registry stubs): cli/grammar/index.ts folds this
 * fragment into `GRAMMAR_FRAGMENTS`, `HANDLERS`, `DEBUG_CATEGORY_DEFS` and `LITERAL_HELP`, so the W3a1 cli-acl builder
 * fills this file (specs, their shows and `debug` specs, handler ids, debug categories, literal help) without editing a
 * shared registry. Until then it holds nothing, so no help listing and no help golden moves.
 */
import type { CommandSpec } from '../../contracts/cli.js';
import type { GrammarDebugCategory } from './core-exec.js';

/** @since P3c The fragment's specs (empty until W3a1). */
export const HARDENING_P3C_GRAMMAR: readonly CommandSpec[] = Object.freeze([]);

/** @since P3c The fragment's handler ids (frozen names shared with cli/handlers/hardening-p3c.ts; empty until W3a1). */
export const HARDENING_P3C_HANDLERS = Object.freeze({});

/** @since P3c The fragment's debug categories (empty until W3a1). */
export const HARDENING_P3C_DEBUG_CATEGORIES: readonly GrammarDebugCategory[] = Object.freeze([]);

/** @since P3c Help of the fragment's intermediate literals (empty until W3a1). */
export const HARDENING_P3C_LITERAL_HELP: Readonly<Record<string, string>> = Object.freeze({});
