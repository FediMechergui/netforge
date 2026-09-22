/**
 * io/migrate.ts — pure topology schema migration (ARCHITECTURE-P1 D11, §3.14; ARCHITECTURE-P2 §2.9, §9.2 item 6).
 *
 * Loading is parse → migrate → validate against the catalog. `parseTopology` (io/schema.ts) accepts every id in
 * `TOPOLOGY_SCHEMA_IDS` and interprets each document by the field set of its own version (a 1.0 document never
 * carries 1.1 sections; a 1.0 or 1.1 document never carries the 1.2 `profile`). `migrateTopology` then rewrites the
 * document, one step at a time, up to `schemaIdFor(t)` — the lowest id that can express it — so a 1.0 document
 * still becomes 1.1 and a P1 document never gains the 1.2 id.
 *
 * Migrations are pure: they never mutate their input, never read the clock or an rng, and return a fresh top-level
 * object. 1.0 → 1.1 is the identity on content plus the schema id, because 1.1 only adds optional sections whose
 * absence means exactly what a 1.0 file meant (default modules, salt 0, no GUI state, cable links, default scale).
 * 1.1 → 1.2 is the identity on content plus the schema id for the same reason: 1.2 only adds `profile`, whose absence
 * means the P1 defaults.
 *
 * Migrations only move forward. A document whose own id is already later than `schemaIdFor(t)` (a hand-written 1.2
 * document without `profile`) keeps its id and its content.
 *
 * The load gate (`prepareTopologyLoad`, io/schema.ts) keeps its P1 contract and returns the document at
 * `LATEST_TOPOLOGY_SCHEMA_ID` (`migrateTopologyTo`): that in-memory copy is never written back — the exporter builds its
 * own document and writes `schemaIdFor(t)` — so a P1 file still exports as 1.1.
 */
import {
  TOPOLOGY_SCHEMA_IDS,
  TOPOLOGY_SCHEMA_ID_1_0,
  TOPOLOGY_SCHEMA_ID_1_1,
  TOPOLOGY_SCHEMA_ID_1_2,
  schemaIdFor,
  type Topology,
  type TopologySchemaId,
} from '../contracts/topology.js';

/** One migration step: rewrites a document of schema `from` into a document of schema `to`. */
export interface TopologyMigrationStep {
  /** Schema id this step accepts. */
  readonly from: TopologySchemaId;
  /** Schema id this step produces (always a later id in `TOPOLOGY_SCHEMA_IDS`). */
  readonly to: TopologySchemaId;
  /** Pure rewrite; must not mutate `t`. */
  readonly migrate: (t: Topology) => Topology;
}

/** 1.0 → 1.1: identity on content, schema id rewritten. */
function migrate10to11(t: Topology): Topology {
  return { ...t, schema: TOPOLOGY_SCHEMA_ID_1_1 };
}

/** @since P2 1.1 → 1.2: identity on content, schema id rewritten. */
function migrate11to12(t: Topology): Topology {
  return { ...t, schema: TOPOLOGY_SCHEMA_ID_1_2 };
}

/**
 * Migration steps keyed by their source schema id. The latest id has no entry. Every other id in
 * `TOPOLOGY_SCHEMA_IDS` has exactly one step, and following the steps from any id reaches the latest id.
 */
export const TOPOLOGY_MIGRATIONS: Readonly<Partial<Record<TopologySchemaId, TopologyMigrationStep>>> = Object.freeze({
  [TOPOLOGY_SCHEMA_ID_1_0]: Object.freeze({ from: TOPOLOGY_SCHEMA_ID_1_0, to: TOPOLOGY_SCHEMA_ID_1_1, migrate: migrate10to11 }),
  [TOPOLOGY_SCHEMA_ID_1_1]: Object.freeze({ from: TOPOLOGY_SCHEMA_ID_1_1, to: TOPOLOGY_SCHEMA_ID_1_2, migrate: migrate11to12 }),
});

/** True when `id` is a schema id this build can load. */
export function isTopologySchemaId(id: unknown): id is TopologySchemaId {
  return typeof id === 'string' && (TOPOLOGY_SCHEMA_IDS as readonly string[]).includes(id);
}

/** Position of a known schema id in `TOPOLOGY_SCHEMA_IDS` (older ids first). */
function rank(id: TopologySchemaId): number {
  return TOPOLOGY_SCHEMA_IDS.indexOf(id);
}

/**
 * The id `migrateTopology(t)` produces: `schemaIdFor(t)`, or the document's own id when that is already later
 * (migrations never move a document backward). `t.schema` must be a known id.
 */
export function migrationTargetOf(t: Topology): TopologySchemaId {
  const wanted = schemaIdFor(t);
  return rank(t.schema) > rank(wanted) ? t.schema : wanted;
}

/**
 * Migrate a parsed topology up to `schemaIdFor(t)` (see `migrationTargetOf`).
 *
 * Pure: the input is never mutated; the result is always a new top-level object (nested device/link objects are
 * shared with the input where a step leaves them unchanged). Throws an `Error` with a readable message for a schema id
 * this build does not know (only reachable when the caller skipped `parseTopology`).
 */
export function migrateTopology(t: Topology): Topology {
  checkKnown(t);
  return walk(t, migrationTargetOf(t));
}

/**
 * Migrate a parsed topology forward to `target` (the load gate uses `LATEST_TOPOLOGY_SCHEMA_ID`, its P1 contract).
 * Pure, like `migrateTopology`. Throws for an unknown schema id and for a target older than the document's own id
 * (migrations never move a document backward).
 */
export function migrateTopologyTo(t: Topology, target: TopologySchemaId): Topology {
  checkKnown(t);
  if (!isTopologySchemaId(target) || rank(target) < rank(t.schema)) {
    throw new Error(`Cannot migrate a topology with schema "${t.schema}" to "${String(target)}"; migrations only move forward`);
  }
  return walk(t, target);
}

function checkKnown(t: Topology): void {
  if (!isTopologySchemaId(t.schema)) {
    throw new Error(`Cannot migrate a topology with schema "${String(t.schema)}"; this build reads ${TOPOLOGY_SCHEMA_IDS.join(', ')}`);
  }
}

/** Apply the steps from `t.schema` up to `target` (a known id no older than `t.schema`); always a new object. */
function walk(t: Topology, target: TopologySchemaId): Topology {
  let current: Topology = { ...t };
  let guard = TOPOLOGY_SCHEMA_IDS.length;
  while (current.schema !== target) {
    const step = TOPOLOGY_MIGRATIONS[current.schema];
    if (step === undefined || guard-- <= 0) {
      throw new Error(`No migration path from schema "${current.schema}" to "${target}"`);
    }
    current = step.migrate(current);
  }
  return current;
}
