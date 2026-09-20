/**
 * cli/grammar.ts — compatibility entry point of the command table (ARCHITECTURE-P1 §8.1 W3 cli).
 *
 * The grammar is split into fragments under cli/grammar/ and assembled by cli/grammar/index.ts (`GRAMMAR`,
 * `HANDLERS`, `DEBUG_CATEGORIES`, `LITERAL_HELP`, `PSEUDO_HELP`, the fragment tables and their helpers). This module
 * re-exports all of it so existing `./grammar.js` imports keep resolving to the same objects.
 */
export * from './grammar/index.js';
