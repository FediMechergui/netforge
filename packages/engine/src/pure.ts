/**
 * @netforge/engine/pure — the stateless, DOM-free helper entry (P1, D14).
 *
 * The web imports this entry for helpers that need no simulation: address maths (IPv4 contract helpers and
 * the IPv6 / dual-stack helpers of core/addr6), the NetScope display filter (lexer, parser, field registry,
 * evaluator, completion) and text formatters (sim time, durations, rates, byte counts, column tables).
 *
 * Rule (enforced by test/pure-entry.lint.test.ts): nothing reachable from this file may import `sim/`,
 * `device/`, `link/` or `protocols/`. Only contracts, core pure helpers, capture/filter, cli/format and (P3)
 * automation are allowed here. Everything exported here is also available from the main entry.
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

// ── P3 core (ARCHITECTURE-P3 D10, D12, D16; §7 W1 core): access lists, OSPF LSA rules and SPF, the queueing
//    scheduler — shared by the daemons, the grader and the web tools (the ACL test walk, the wildcard tool, the SPF
//    stepper, the queueing sandbox) ──
export * from './core/acl.js';
export * from './core/ospf-lsa.js';
export * from './core/ospf-spf.js';
export * from './core/queueing.js';
export type { OspfLsaRow, OspfRouterLink, SpfTree, SpfVertex } from './contracts/tables.js';
export type { PacketTuple } from './contracts/process.js';
export type { EgressClassSpec } from './contracts/link.js';

// ── P3 automation (ARCHITECTURE-P3 §7 W1 auto, [S32]): the data-format parsers, the YANG model and RESTCONF paths,
//    the NF-Py lexer and parser — for the data-formats playground and the script editor ──
export * from './automation/data/json.js';
export * from './automation/data/yaml.js';
export * from './automation/data/xml.js';
export * from './automation/yang/model.js';
export * from './automation/yang/path.js';
export * from './automation/py/lexer.js';
export * from './automation/py/parser.js';

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
