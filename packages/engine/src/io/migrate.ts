/**
 * io/migrate.ts — pure topology schema migration (ARCHITECTURE-P1 D11, §3.14).
 *
 * Loading is parse → migrate → validate against the catalog. `parseTopology` (io/schema.ts) accepts every id in
 * `TOPOLOGY_SCHEMA_IDS` and interprets each document by the field set of its own version (a 1.0 document never
 * carries 1.1 sections). `migrateTopology` then rewrites the document, one step at a time, up to
 * `LATEST_TOPOLOGY_SCHEMA_ID`.
 *
 * Migrations are pure: they never mutate their input, never read the clock or an rng, and return a fresh top-level
 * object. 1.0 → 1.1 is the identity on content plus the schema id, because 1.1 only adds optional sections whose
 * absence means exactly what a 1.0 file meant (default modules, salt 0, no GUI state, cable links, default scale).
 */
import {
  LATEST_TOPOLOGY_SCHEMA_ID,
  TOPOLOGY_SCHEMA_IDS,
  TOPOLOGY_SCHEMA_ID_1_0,
  TOPOLOGY_SCHEMA_ID_1_1,
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

/**
 * Migration steps keyed by their source schema id. The latest id has no entry. Every other id in
 * `TOPOLOGY_SCHEMA_IDS` has exactly one step, and following the steps from any id reaches the latest id.
 */
export const TOPOLOGY_MIGRATIONS: Readonly<Partial<Record<TopologySchemaId, TopologyMigrationStep>>> = Object.freeze({
  [TOPOLOGY_SCHEMA_ID_1_0]: Object.freeze({ from: TOPOLOGY_SCHEMA_ID_1_0, to: TOPOLOGY_SCHEMA_ID_1_1, migrate: migrate10to11 }),
});

/** True when `id` is a schema id this build can load. */
export function isTopologySchemaId(id: unknown): id is TopologySchemaId {
  return typeof id === 'string' && (TOPOLOGY_SCHEMA_IDS as readonly string[]).includes(id);
}

/**
 * Migrate a parsed topology to `LATEST_TOPOLOGY_SCHEMA_ID`.
 *
 * Pure: the input is never mutated; the result is always a new top-level object whose `schema` is the latest id
 * (nested device/link objects are shared with the input where a step leaves them unchanged). Throws an `Error` with a
 * readable message for a schema id this build does not know (only reachable when the caller skipped `parseTopology`).
 */
export function migrateTopology(t: Topology): Topology {
  if (!isTopologySchemaId(t.schema)) {
    throw new Error(`Cannot migrate a topology with schema "${String(t.schema)}"; this build reads ${TOPOLOGY_SCHEMA_IDS.join(', ')}`);
  }
  let current: Topology = { ...t };
  let guard = TOPOLOGY_SCHEMA_IDS.length;
  while (current.schema !== LATEST_TOPOLOGY_SCHEMA_ID) {
    const step = TOPOLOGY_MIGRATIONS[current.schema];
    if (step === undefined || guard-- <= 0) {
      throw new Error(`No migration path from schema "${current.schema}" to "${LATEST_TOPOLOGY_SCHEMA_ID}"`);
    }
    current = step.migrate(current);
  }
  return current;
}
