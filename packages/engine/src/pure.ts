/**
 * @netforge/engine/pure — the stateless, DOM-free helper entry (P1, D14).
 *
 * The web imports this entry for helpers that need no simulation: address maths (IPv4 contract helpers and
 * the IPv6 / dual-stack helpers of core/addr6), the NetScope display filter (lexer, parser, field registry,
 * evaluator, completion) and text formatters (sim time, durations, rates, byte counts, column tables).
 *
 * Rule (enforced by test/pure-entry.lint.test.ts): nothing reachable from this file may import `sim/`,
 * `device/`, `link/` or `protocols/`. Only contracts, core pure helpers, capture/filter and cli/format are
 * allowed here. Everything exported here is also available from the main entry.
 */

// ── address helpers ─────────────────────────────────────────────────────────
export * from './contracts/addr.js';
export * from './core/addr6.js';

// ── display filters (NetScope) ──────────────────────────────────────────────
export * from './capture/filter/lexer.js';
export * from './capture/filter/parser.js';
export * from './capture/filter/fields.js';
export * from './capture/filter/eval.js';
export * from './capture/filter/complete.js';
export type {
  DisplayFieldDef,
  DisplayFilterAst,
  DisplayFilterCompletion,
  DisplayFilterError,
  DisplayFilterValue,
} from './contracts/capture.js';
export type { FieldSpec, FieldType, ProtoFieldTable } from './contracts/fields.js';
export { PROTO_FIELDS } from './contracts/fields.js';
export type { FieldValue, LayerView, ProtoName } from './contracts/pdu.js';

// ── formatters ──────────────────────────────────────────────────────────────
export { HOUR, MIN, MS, NS, SEC, US, formatSimTime, type SimTime } from './contracts/time.js';
export {
  fmtBps,
  fmtBytes,
  fmtDuration,
  fmtSince,
  fmtUptime,
  minutesBetween,
  padLeft,
  padRight,
  table,
  type TableOptions as TextTableOptions,
} from './cli/format.js';
