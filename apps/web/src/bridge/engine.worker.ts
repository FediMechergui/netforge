/**
 * Engine worker entry kept at its P0 path: the implementation lives in ./worker/ (index.ts wires the Simulation,
 * clock.ts runs the clock policy, batch.ts and delta.ts assemble batches). Importing this module exposes the
 * `EngineApi` through Comlink exactly like importing ./worker/index.ts (the P0 regression tests import this path).
 */
import './worker/index';
