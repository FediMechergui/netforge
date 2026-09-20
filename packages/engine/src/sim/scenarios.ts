/**
 * sim/scenarios.ts — re-export shim for the scenario tree (ARCHITECTURE-P1 §8.2 W6).
 *
 * The templates and the CCNA 1 labs live in `sim/scenarios/` (index.ts, templates.ts, ccna1/*.ts) since P1 W6. This
 * file stays so that every `sim/scenarios.js` import — the engine barrel, the worker, the P0/P0.5 acceptance tests —
 * keeps resolving to the same names.
 */
export * from './scenarios/index.js';
