/**
 * cli/grammar/files.ts — [S29] [S30] [S31] device files: the `copy` forms with the `url` argument, `dir`, `show flash:`, `delete`, `tftp-server`, `boot system`, `verify /md5`, the immediate `config-register`, and the `rommon` mode (ARCHITECTURE-P3C §5, §7 W3a2).
 *
 * @since P3c Registered EMPTY by the architect in W0 (§7 W0, the CLI registry stubs): cli/grammar/index.ts folds this
 * fragment into `GRAMMAR_FRAGMENTS`, `HANDLERS`, `DEBUG_CATEGORY_DEFS` and `LITERAL_HELP`, so the W3a2 cli-management builder
 * fills this file (specs, their shows and `debug` specs, handler ids, debug categories, literal help) without editing a
 * shared registry. Until then it holds nothing, so no help listing and no help golden moves.
 */
import type { CommandSpec } from '../../contracts/cli.js';
import type { GrammarDebugCategory } from './core-exec.js';

/** @since P3c The fragment's specs (empty until W3a2). */
export const FILES_GRAMMAR: readonly CommandSpec[] = Object.freeze([]);

/** @since P3c The fragment's handler ids (frozen names shared with cli/handlers/files.ts; empty until W3a2). */
export const FILES_HANDLERS = Object.freeze({});

/** @since P3c The fragment's debug categories (empty until W3a2). */
export const FILES_DEBUG_CATEGORIES: readonly GrammarDebugCategory[] = Object.freeze([]);

/** @since P3c Help of the fragment's intermediate literals (empty until W3a2). */
export const FILES_LITERAL_HELP: Readonly<Record<string, string>> = Object.freeze({});
