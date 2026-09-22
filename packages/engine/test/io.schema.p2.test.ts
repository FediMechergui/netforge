/**
 * io — topology schema 1.2 (ARCHITECTURE-P2 §2.9, D2, §7 W1 io, §9.2 item 6, §13 #14): `profile` belongs only to the
 * 1.2 field set; `schemaIdFor(t)` is the lowest id that can express a document; migration walks a document up to it
 * (never down); `TOPOLOGY_SCHEMA_ID` stays 1.1, so a P1 document exports byte-identically as 1.1.
 */
import { describe, expect, it } from 'vitest';
import {
  LATEST_TOPOLOGY_SCHEMA_ID,
  TOPOLOGY_SCHEMA_ID,
  TOPOLOGY_SCHEMA_ID_1_0,
  TOPOLOGY_SCHEMA_ID_1_1,
  TOPOLOGY_SCHEMA_ID_1_2,
  schemaIdFor,
  type Topology,
} from '../src/contracts/topology.js';
import { createCatalog } from '../src/device/catalog.js';
import { TOPOLOGY_MIGRATIONS, migrateTopology, migrateTopologyTo, migrationTargetOf } from '../src/io/migrate.js';
import { canonicalTopology, readNetforge, topologyFromJson, topologyToJson, writeNetforge } from '../src/io/netforge-file.js';
import { parseTopology, prepareTopologyLoad, validateTopology } from '../src/io/schema.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import { twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';

const catalog = createCatalog(PROCESS_FACTORIES);
const manifest = { format: 1 as const, app: 'netforge/0.0.1', created: '2026-09-21T10:00:00.000Z', modified: '2026-09-21T10:00:00.000Z' };

/** A small P1 document (schema 1.1, no profile). */
function p1Doc(): Topology {
  return {
    schema: TOPOLOGY_SCHEMA_ID,
    seed: 3,
    devices: [{ id: 'pc1', type: 'pc.nfpc', name: 'PC1', position: { logical: [1, 2] }, config: 'hostname PC1\n' }],
    links: [],
    notes: 'n',
    lab: { name: 'x', version: 1 },
  };
}

/** The same document in the P2 profile, written as every writer must: `schema = schemaIdFor(t)`. */
function p2Doc(): Topology {
  const t: Topology = { ...p1Doc(), profile: 'P2' };
  return { ...t, schema: schemaIdFor(t) };
}

/** The exact bytes `topologyToJson(p1Doc())` had before P2 (P0 keys, then the 1.1 key `lab`). */
const P1_DOC_JSON = [
  '{',
  '  "schema": "netforge.topology/1.1",',
  '  "seed": 3,',
  '  "devices": [',
  '    {',
  '      "id": "pc1",',
  '      "type": "pc.nfpc",',
  '      "name": "PC1",',
  '      "position": {',
  '        "logical": [',
  '          1,',
  '          2',
  '        ]',
  '      },',
  '      "config": "hostname PC1\\n"',
  '    }',
  '  ],',
  '  "links": [],',
  '  "notes": "n",',
  '  "lab": {',
  '    "name": "x",',
  '    "version": 1',
  '  }',
  '}',
  '',
].join('\n');

const json = (t: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(t)) as Record<string, unknown>;

describe('schemaIdFor and the id constants', () => {
  it('is 1.2 exactly when the document carries a profile; the exporter id stays 1.1', () => {
    expect(TOPOLOGY_SCHEMA_ID_1_2).toBe('netforge.topology/1.2');
    expect(TOPOLOGY_SCHEMA_ID).toBe(TOPOLOGY_SCHEMA_ID_1_1);
    expect(LATEST_TOPOLOGY_SCHEMA_ID).toBe(TOPOLOGY_SCHEMA_ID_1_2);
    expect(schemaIdFor(p1Doc())).toBe(TOPOLOGY_SCHEMA_ID_1_1);
    expect(schemaIdFor({ ...p1Doc(), schema: TOPOLOGY_SCHEMA_ID_1_0 })).toBe(TOPOLOGY_SCHEMA_ID_1_1);
    expect(schemaIdFor({ ...p1Doc(), profile: 'P2' })).toBe(TOPOLOGY_SCHEMA_ID_1_2);
    expect(schemaIdFor({ ...p1Doc(), schema: TOPOLOGY_SCHEMA_ID_1_2 })).toBe(TOPOLOGY_SCHEMA_ID_1_1);
    expect(schemaIdFor({ schema: TOPOLOGY_SCHEMA_ID_1_1, seed: 0, devices: [], links: [], profile: 'P2' })).toBe(TOPOLOGY_SCHEMA_ID_1_2);
  });
});

describe('a P1 document exports byte-identically as 1.1', () => {
  it('topologyToJson writes exactly the pre-P2 bytes', () => {
    expect(topologyToJson(p1Doc())).toBe(P1_DOC_JSON);
    expect(topologyFromJson(P1_DOC_JSON)).toEqual(p1Doc());
    expect('profile' in canonicalTopology(p1Doc())).toBe(false);
  });

  it('a .netforge archive keeps schema 1.1 and gains no key', () => {
    const back = readNetforge(writeNetforge({ manifest, topology: p1Doc(), configs: {} }));
    expect(back.topology).toEqual(p1Doc());
    expect('profile' in back.topology).toBe(false);
  });

  it('a P1 simulation exports schema 1.1 without a profile key, and the file round-trips unchanged', () => {
    const sim = createSimulation({ seed: 5 });
    sim.loadTopology(twoPcsAndSwitch());
    const out = sim.exportTopology();
    expect(out.schema).toBe(TOPOLOGY_SCHEMA_ID_1_1);
    expect('profile' in out).toBe(false);
    const text = topologyToJson(out);
    expect(text).not.toContain('"profile"');
    expect(topologyToJson(topologyFromJson(text))).toBe(text);
    expect(migrateTopology(topologyFromJson(text))).toEqual(topologyFromJson(text));
  });
});

describe('a P2 document is 1.2', () => {
  it('writes profile after every 1.1 key under schema 1.2 and reads it back', () => {
    const t = p2Doc();
    expect(t.schema).toBe(TOPOLOGY_SCHEMA_ID_1_2);
    const text = topologyToJson(t);
    expect(Object.keys(JSON.parse(text) as object)).toEqual(['schema', 'seed', 'devices', 'links', 'notes', 'lab', 'profile']);
    expect(text).toBe(P1_DOC_JSON.replace('netforge.topology/1.1', 'netforge.topology/1.2').replace('    "version": 1\n  }\n}\n', '    "version": 1\n  },\n  "profile": "P2"\n}\n'));
    expect(topologyFromJson(text)).toEqual(t);
  });

  it('round-trips through a .netforge archive byte-identically', () => {
    const bytes = writeNetforge({ manifest, topology: p2Doc(), configs: {} });
    const back = readNetforge(bytes);
    expect(back.topology).toEqual(p2Doc());
    expect(Buffer.from(writeNetforge({ ...back, readme: undefined })).equals(Buffer.from(bytes))).toBe(true);
  });

  it('a 1.2 document loads as P2: the load gate keeps the profile', () => {
    const loaded = prepareTopologyLoad(json(p2Doc()), catalog);
    expect(loaded.schema).toBe(LATEST_TOPOLOGY_SCHEMA_ID);
    expect(loaded.profile).toBe('P2');
    expect(loaded).toEqual(p2Doc());
  });

  it('refuses any profile value other than "P2" in a 1.2 document', () => {
    for (const bad of ['P1', 'p2', 2, null, true]) {
      const r = validateTopology({ ...json(p2Doc()), profile: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors).toEqual(['profile: must be "P2"; leave it out for the classic (P1) defaults']);
    }
  });
});

describe('profile belongs only to the 1.2 field set', () => {
  it('a 1.1 document carrying profile is read without it and loads as P1', () => {
    const doc = { ...json(p1Doc()), profile: 'P2' };
    const before = JSON.stringify(doc);
    const t = parseTopology(doc);
    expect(JSON.stringify(doc)).toBe(before);
    expect('profile' in t).toBe(false);
    expect(t).toEqual(p1Doc());
    const loaded = prepareTopologyLoad(doc, catalog);
    expect('profile' in loaded).toBe(false);
    // the load gate keeps its P1 contract and normalises the in-memory copy to the latest id; the exporter still
    // writes schemaIdFor(t), so the file stays 1.1
    expect(loaded.schema).toBe(LATEST_TOPOLOGY_SCHEMA_ID);
    expect(schemaIdFor(loaded)).toBe(TOPOLOGY_SCHEMA_ID_1_1);
    const sim = createSimulation({ seed: 5 });
    sim.loadTopology({ ...twoPcsAndSwitch(), profile: 'P2' });
    expect(sim.profile).toBe('P1');
  });

  it('strips even an invalid profile from a 1.1 or 1.0 document (like any unknown key)', () => {
    expect(validateTopology({ ...json(p1Doc()), profile: 'bogus' })).toEqual({ ok: true, topology: p1Doc() });
    const t10 = parseTopology({ ...json(p1Doc()), schema: TOPOLOGY_SCHEMA_ID_1_0, profile: 'P2' });
    expect(t10.schema).toBe(TOPOLOGY_SCHEMA_ID_1_0);
    expect('profile' in t10).toBe(false);
  });

  it('writers never migrate: a 1.1 document handed a profile keeps 1.1 and the archive drops the key', () => {
    const t: Topology = { ...p1Doc(), profile: 'P2' };
    const back = readNetforge(writeNetforge({ manifest, topology: t, configs: {} }));
    expect(back.topology.schema).toBe(TOPOLOGY_SCHEMA_ID_1_1);
    expect('profile' in back.topology).toBe(false);
  });
});

describe('migration 1.1 → 1.2', () => {
  it('is one identity step plus the schema id, never mutating its input', () => {
    const step = TOPOLOGY_MIGRATIONS[TOPOLOGY_SCHEMA_ID_1_1];
    expect(step?.from).toBe(TOPOLOGY_SCHEMA_ID_1_1);
    expect(step?.to).toBe(TOPOLOGY_SCHEMA_ID_1_2);
    const input: Topology = { ...p1Doc(), profile: 'P2' };
    const before = JSON.stringify(input);
    const out = step!.migrate(input);
    expect(out).not.toBe(input);
    expect(out).toEqual({ ...input, schema: TOPOLOGY_SCHEMA_ID_1_2 });
    expect(JSON.stringify(input)).toBe(before);
    expect(TOPOLOGY_MIGRATIONS[TOPOLOGY_SCHEMA_ID_1_2]).toBeUndefined();
  });

  it('migrateTopology walks a document up to schemaIdFor(t) and never down', () => {
    const p0 = { ...p1Doc(), schema: TOPOLOGY_SCHEMA_ID_1_0 } as Topology;
    expect(migrationTargetOf(p0)).toBe(TOPOLOGY_SCHEMA_ID_1_1);
    expect(migrateTopology(p0)).toEqual(p1Doc());
    expect(migrationTargetOf(p1Doc())).toBe(TOPOLOGY_SCHEMA_ID_1_1);
    expect(migrateTopology(p1Doc())).toEqual(p1Doc());
    expect(migrationTargetOf(p2Doc())).toBe(TOPOLOGY_SCHEMA_ID_1_2);
    expect(migrateTopology(p2Doc())).toEqual(p2Doc());
    const unparsed: Topology = { ...p1Doc(), profile: 'P2' };
    expect(migrateTopology(unparsed)).toEqual(p2Doc());
    const bare12: Topology = { ...p1Doc(), schema: TOPOLOGY_SCHEMA_ID_1_2 };
    expect(migrationTargetOf(bare12)).toBe(TOPOLOGY_SCHEMA_ID_1_2);
    const out = migrateTopology(bare12);
    expect(out).not.toBe(bare12);
    expect(out).toEqual(bare12);
  });

  it('a 1.2 document without profile loads as P1, and migrateTopologyTo never moves a document backward', () => {
    const loaded = prepareTopologyLoad({ ...json(p1Doc()), schema: TOPOLOGY_SCHEMA_ID_1_2 }, catalog);
    expect(loaded.schema).toBe(TOPOLOGY_SCHEMA_ID_1_2);
    expect('profile' in loaded).toBe(false);
    const p0 = { ...p1Doc(), schema: TOPOLOGY_SCHEMA_ID_1_0 } as Topology;
    expect(migrateTopologyTo(p0, TOPOLOGY_SCHEMA_ID_1_2)).toEqual({ ...p1Doc(), schema: TOPOLOGY_SCHEMA_ID_1_2 });
    expect(() => migrateTopologyTo(p1Doc(), TOPOLOGY_SCHEMA_ID_1_0)).toThrow(
      'Cannot migrate a topology with schema "netforge.topology/1.1" to "netforge.topology/1.0"; migrations only move forward',
    );
  });
});
