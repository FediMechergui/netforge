/**
 * io — topology schema 1.3 (ARCHITECTURE-P3 §2.9, ruling R7; §7 W1 io and its approved [S32] item; §9.2 items 15, 16):
 * `schemaIdFor` gives 1.3 exactly for `profile: 'P3'` or a host's non-empty `files` store; P1, P2 and P3 documents
 * export as 1.1, 1.2 and 1.3, byte-identically; a 1.2 document keeps its `'P2'`-only profile (a `'P3'` is refused) and
 * never carries `files`; 1.2 → 1.3 is the identity plus the schema id; the files store is validated (names exactly as
 * the device store accepts them, limits, hosts only) and travels inline in `topology.json`.
 */
import { describe, expect, it } from 'vitest';
import { TopologyLoadError } from '../src/contracts/simulation.js';
import {
  LATEST_TOPOLOGY_SCHEMA_ID,
  TOPOLOGY_SCHEMA_ID,
  TOPOLOGY_SCHEMA_IDS,
  TOPOLOGY_SCHEMA_ID_1_0,
  TOPOLOGY_SCHEMA_ID_1_1,
  TOPOLOGY_SCHEMA_ID_1_2,
  TOPOLOGY_SCHEMA_ID_1_3,
  schemaIdFor,
  type Topology,
} from '../src/contracts/topology.js';
import { createCatalog } from '../src/device/catalog.js';
import { isStoredFileName } from '../src/device/device.js';
import { TOPOLOGY_MIGRATIONS, migrateTopology, migrateTopologyTo, migrationTargetOf } from '../src/io/migrate.js';
import { canonicalTopology, readNetforge, topologyFromJson, topologyToJson, writeNetforge } from '../src/io/netforge-file.js';
import {
  MAX_TOPOLOGY_FILES_PER_DEVICE,
  MAX_TOPOLOGY_FILE_CHARS,
  MAX_TOPOLOGY_FILE_NAME_CHARS,
  isTopologyFileName,
  parseTopology,
  prepareTopologyLoad,
  validateTopology,
  validateTopologyAgainstCatalog,
} from '../src/io/schema.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import { twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';

const catalog = createCatalog(PROCESS_FACTORIES);
const manifest = { format: 1 as const, app: 'netforge/0.0.1', created: '2026-10-01T10:00:00.000Z', modified: '2026-10-01T10:00:00.000Z' };

/** A small P1 document (schema 1.1, no profile, no files). */
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

/** The document in a profile, written as every writer must: `schema = schemaIdFor(t)`. */
function inProfile(profile: 'P2' | 'P3', base: Topology = p1Doc()): Topology {
  const t: Topology = { ...base, profile };
  return { ...t, schema: schemaIdFor(t) };
}

const SCRIPT = { path: 'inventory.py', content: 'print("hi")\n' };

/** The P1 document whose PC keeps one file in its `files:` store ([S32]), written with `schema = schemaIdFor(t)`. */
function hostDoc(base: Topology = p1Doc()): Topology {
  const t: Topology = { ...base, devices: base.devices.map((d) => ({ ...d, files: [{ ...SCRIPT }] })) };
  return { ...t, schema: schemaIdFor(t) };
}

/** The exact bytes `topologyToJson(p1Doc())` has had since P0.5 (P0 keys, then the 1.1 key `lab`). */
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

/** The P1 document in a profile: the schema id rewritten and `profile` after every 1.1 key. */
const profileJson = (id: string, profile: string): string =>
  P1_DOC_JSON.replace('netforge.topology/1.1', id).replace('    "version": 1\n  }\n}\n', `    "version": 1\n  },\n  "profile": "${profile}"\n}\n`);

/** `hostDoc()` as text: schema 1.3, the device's `files` after every other device key, inline. */
const HOST_DOC_JSON = P1_DOC_JSON.replace('netforge.topology/1.1', 'netforge.topology/1.3').replace(
  '      "config": "hostname PC1\\n"\n',
  [
    '      "config": "hostname PC1\\n",',
    '      "files": [',
    '        {',
    '          "path": "inventory.py",',
    '          "content": "print(\\"hi\\")\\n"',
    '        }',
    '      ]',
    '',
  ].join('\n'),
);

const json = (t: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(t)) as Record<string, unknown>;

const P2_ONLY = 'profile: must be "P2"; leave it out for the classic (P1) defaults';
const P2_OR_P3 = 'profile: must be "P2" or "P3"; leave it out for the classic (P1) defaults';

describe('the 1.3 id and schemaIdFor', () => {
  it('appends 1.3 to the accepted ids and makes it the latest; the exporter id stays 1.1', () => {
    expect(TOPOLOGY_SCHEMA_ID_1_3).toBe('netforge.topology/1.3');
    expect(TOPOLOGY_SCHEMA_IDS).toEqual([TOPOLOGY_SCHEMA_ID_1_0, TOPOLOGY_SCHEMA_ID_1_1, TOPOLOGY_SCHEMA_ID_1_2, TOPOLOGY_SCHEMA_ID_1_3]);
    expect(LATEST_TOPOLOGY_SCHEMA_ID).toBe(TOPOLOGY_SCHEMA_ID_1_3);
    expect(TOPOLOGY_SCHEMA_ID).toBe(TOPOLOGY_SCHEMA_ID_1_1);
  });

  it('is 1.1 for P1, 1.2 for P2 and 1.3 for P3, whatever id the document already carries', () => {
    expect(schemaIdFor(p1Doc())).toBe(TOPOLOGY_SCHEMA_ID_1_1);
    expect(schemaIdFor({ ...p1Doc(), profile: 'P2' })).toBe(TOPOLOGY_SCHEMA_ID_1_2);
    expect(schemaIdFor({ ...p1Doc(), profile: 'P3' })).toBe(TOPOLOGY_SCHEMA_ID_1_3);
    expect(schemaIdFor({ ...p1Doc(), schema: TOPOLOGY_SCHEMA_ID_1_3 })).toBe(TOPOLOGY_SCHEMA_ID_1_1);
    expect(schemaIdFor({ ...p1Doc(), schema: TOPOLOGY_SCHEMA_ID_1_0, profile: 'P3' })).toBe(TOPOLOGY_SCHEMA_ID_1_3);
  });

  it('[S32] counts a non-empty files store as 1.3 content in any profile; an empty store is no content', () => {
    expect(schemaIdFor(hostDoc())).toBe(TOPOLOGY_SCHEMA_ID_1_3);
    expect(schemaIdFor({ ...hostDoc(), profile: 'P2' })).toBe(TOPOLOGY_SCHEMA_ID_1_3);
    const empty: Topology = { ...p1Doc(), devices: p1Doc().devices.map((d) => ({ ...d, files: [] })) };
    expect(schemaIdFor(empty)).toBe(TOPOLOGY_SCHEMA_ID_1_1);
    expect(schemaIdFor({ ...empty, profile: 'P2' })).toBe(TOPOLOGY_SCHEMA_ID_1_2);
  });
});

describe('P1 exports 1.1, P2 1.2, P3 1.3, byte-identically', () => {
  it('topologyToJson writes the exact bytes of each profile and reads them back', () => {
    expect(topologyToJson(p1Doc())).toBe(P1_DOC_JSON);
    expect(topologyToJson(inProfile('P2'))).toBe(profileJson('netforge.topology/1.2', 'P2'));
    expect(topologyToJson(inProfile('P3'))).toBe(profileJson('netforge.topology/1.3', 'P3'));
    for (const t of [p1Doc(), inProfile('P2'), inProfile('P3')]) {
      const text = topologyToJson(t);
      expect(topologyFromJson(text)).toEqual(t);
      expect(topologyToJson(topologyFromJson(text))).toBe(text);
    }
  });

  it('a .netforge archive keeps each id and round-trips byte-identically', () => {
    for (const t of [p1Doc(), inProfile('P2'), inProfile('P3')]) {
      const bytes = writeNetforge({ manifest, topology: t, configs: {} });
      const back = readNetforge(bytes);
      expect(back.topology).toEqual(t);
      expect(Buffer.from(writeNetforge({ ...back, readme: undefined })).equals(Buffer.from(bytes))).toBe(true);
    }
  });

  it('a simulation of each profile exports its id, and the text round-trips unchanged', () => {
    const cases: readonly ['P1' | 'P2' | 'P3', string, string | undefined][] = [
      ['P1', TOPOLOGY_SCHEMA_ID_1_1, undefined],
      ['P2', TOPOLOGY_SCHEMA_ID_1_2, 'P2'],
      ['P3', TOPOLOGY_SCHEMA_ID_1_3, 'P3'],
    ];
    for (const [profile, id, written] of cases) {
      const sim = createSimulation({ seed: 5, profile });
      expect(sim.exportTopology()).toEqual(written === undefined ? { schema: id, seed: 5, devices: [], links: [] } : { schema: id, seed: 5, devices: [], links: [], profile: written });
      sim.loadTopology(profile === 'P1' ? twoPcsAndSwitch() : { ...twoPcsAndSwitch(), profile, schema: id as Topology['schema'] });
      const out = sim.exportTopology();
      expect(out.schema).toBe(id);
      expect(out.profile).toBe(written);
      expect(out.schema).toBe(schemaIdFor(out));
      const text = topologyToJson(out);
      expect(topologyToJson(topologyFromJson(text))).toBe(text);
    }
  });
});

describe('the profile field set of each version', () => {
  it('a 1.2 document carrying "P3" is refused with the 1.2 value message, by the parser and by the load gate', () => {
    const doc = { ...json(inProfile('P2')), profile: 'P3' };
    expect(validateTopology(doc)).toEqual({ ok: false, errors: [P2_ONLY] });
    expect(() => parseTopology(doc)).toThrow(`Invalid topology: 1 issue\n  - ${P2_ONLY}`);
    let error: unknown;
    try {
      prepareTopologyLoad(doc, catalog);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TopologyLoadError);
    expect((error as TopologyLoadError).problems).toEqual([{ message: P2_ONLY }]);
  });

  it('a 1.3 document accepts "P2" and "P3" and refuses anything else with the 1.3 message', () => {
    expect(validateTopology(json(inProfile('P3')))).toEqual({ ok: true, topology: inProfile('P3') });
    const p2in13: Topology = { ...inProfile('P2'), schema: TOPOLOGY_SCHEMA_ID_1_3 };
    expect(validateTopology(json(p2in13))).toEqual({ ok: true, topology: p2in13 });
    for (const bad of ['P1', 'P4', 'p3', 3, null, true]) {
      expect(validateTopology({ ...json(inProfile('P3')), profile: bad })).toEqual({ ok: false, errors: [P2_OR_P3] });
    }
  });

  it('a 1.1 or 1.0 document carrying "P3" is read without it and loads as P1', () => {
    for (const id of [TOPOLOGY_SCHEMA_ID_1_1, TOPOLOGY_SCHEMA_ID_1_0]) {
      const doc = { ...json(p1Doc()), schema: id, profile: 'P3' };
      const before = JSON.stringify(doc);
      const t = parseTopology(doc);
      expect(JSON.stringify(doc)).toBe(before);
      const { lab, ...p0Keys } = p1Doc();
      expect(lab).toBeDefined();
      // a 1.0 document also loses the 1.1 key `lab`, as it always has
      expect(t).toEqual(id === TOPOLOGY_SCHEMA_ID_1_1 ? { ...p1Doc(), schema: id } : { ...p0Keys, schema: id });
      expect('profile' in t).toBe(false);
    }
  });

  it('the load gate keeps a 1.3 profile and normalises the in-memory id to 1.3; the exporter id stays per profile', () => {
    const loaded = prepareTopologyLoad(json(inProfile('P3')), catalog);
    expect(loaded).toEqual(inProfile('P3'));
    const p2 = prepareTopologyLoad(json(inProfile('P2')), catalog);
    expect(p2).toEqual({ ...inProfile('P2'), schema: TOPOLOGY_SCHEMA_ID_1_3 });
    expect(schemaIdFor(p2)).toBe(TOPOLOGY_SCHEMA_ID_1_2);
    const p1 = prepareTopologyLoad(json(p1Doc()), catalog);
    expect(p1).toEqual({ ...p1Doc(), schema: TOPOLOGY_SCHEMA_ID_1_3 });
    expect(schemaIdFor(p1)).toBe(TOPOLOGY_SCHEMA_ID_1_1);
  });
});

describe('migration 1.2 → 1.3', () => {
  it('is one identity step plus the schema id, never mutating its input; 1.3 has no step', () => {
    const step = TOPOLOGY_MIGRATIONS[TOPOLOGY_SCHEMA_ID_1_2];
    expect(step?.from).toBe(TOPOLOGY_SCHEMA_ID_1_2);
    expect(step?.to).toBe(TOPOLOGY_SCHEMA_ID_1_3);
    const inputs: readonly Topology[] = [inProfile('P2'), { ...inProfile('P2'), profile: 'P3' }, { ...hostDoc(), schema: TOPOLOGY_SCHEMA_ID_1_2 }];
    for (const input of inputs) {
      const before = JSON.stringify(input);
      const out = step!.migrate(input);
      expect(out).not.toBe(input);
      expect(out).toEqual({ ...input, schema: TOPOLOGY_SCHEMA_ID_1_3 });
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(TOPOLOGY_MIGRATIONS[TOPOLOGY_SCHEMA_ID_1_3]).toBeUndefined();
  });

  it('migrateTopology walks a document up to schemaIdFor(t) and never further or down', () => {
    expect(migrationTargetOf(inProfile('P2'))).toBe(TOPOLOGY_SCHEMA_ID_1_2);
    expect(migrateTopology(inProfile('P2'))).toEqual(inProfile('P2'));
    const unparsed: Topology = { ...p1Doc(), profile: 'P3' };
    expect(migrationTargetOf(unparsed)).toBe(TOPOLOGY_SCHEMA_ID_1_3);
    expect(migrateTopology(unparsed)).toEqual(inProfile('P3'));
    const p0 = { ...p1Doc(), schema: TOPOLOGY_SCHEMA_ID_1_0, profile: 'P3' } as Topology;
    expect(migrateTopology(p0)).toEqual(inProfile('P3'));
    const files11: Topology = { ...hostDoc(), schema: TOPOLOGY_SCHEMA_ID_1_1 };
    expect(migrateTopology(files11)).toEqual(hostDoc());
    const bare13: Topology = { ...p1Doc(), schema: TOPOLOGY_SCHEMA_ID_1_3 };
    expect(migrationTargetOf(bare13)).toBe(TOPOLOGY_SCHEMA_ID_1_3);
    expect(migrateTopology(bare13)).toEqual(bare13);
    expect(migrateTopologyTo(inProfile('P2'), TOPOLOGY_SCHEMA_ID_1_3)).toEqual({ ...inProfile('P2'), schema: TOPOLOGY_SCHEMA_ID_1_3 });
    expect(() => migrateTopologyTo(inProfile('P3'), TOPOLOGY_SCHEMA_ID_1_2)).toThrow(
      'Cannot migrate a topology with schema "netforge.topology/1.3" to "netforge.topology/1.2"; migrations only move forward',
    );
  });
});

describe('[S32] the hosts\' files store in schema 1.3', () => {
  it('a host with files exports 1.3: files after every other device key, inline, read back exactly', () => {
    const t = hostDoc();
    expect(t.schema).toBe(TOPOLOGY_SCHEMA_ID_1_3);
    const text = topologyToJson(t);
    expect(text).toBe(HOST_DOC_JSON);
    expect(Object.keys((JSON.parse(text) as { devices: object[] }).devices[0]!)).toEqual(['id', 'type', 'name', 'position', 'config', 'files']);
    expect(topologyFromJson(text)).toEqual(t);
    expect(prepareTopologyLoad(json(t), catalog)).toEqual(t);
    expect(topologyToJson(hostDoc(inProfile('P2')))).toBe(HOST_DOC_JSON.replace('    "version": 1\n  }\n}\n', '    "version": 1\n  },\n  "profile": "P2"\n}\n'));
  });

  it('a .netforge archive keeps the files inline in topology.json and round-trips byte-identically', () => {
    const bytes = writeNetforge({ manifest, topology: hostDoc(), configs: {} });
    const back = readNetforge(bytes);
    expect(back.topology).toEqual(hostDoc());
    expect(canonicalTopology(back.topology, false).devices[0]!.files).toEqual([SCRIPT]);
    expect(Buffer.from(writeNetforge({ ...back, readme: undefined })).equals(Buffer.from(bytes))).toBe(true);
  });

  it('a P2 document without files still exports 1.2 byte-identically; an empty store writes nothing', () => {
    expect(topologyToJson(inProfile('P2'))).toBe(profileJson('netforge.topology/1.2', 'P2'));
    const empty: Topology = { ...inProfile('P2'), devices: inProfile('P2').devices.map((d) => ({ ...d, files: [] })) };
    expect(schemaIdFor(empty)).toBe(TOPOLOGY_SCHEMA_ID_1_2);
    expect(topologyToJson(empty)).toBe(profileJson('netforge.topology/1.2', 'P2'));
    expect('files' in canonicalTopology(empty).devices[0]!).toBe(false);
  });

  it('a 1.0, 1.1 or 1.2 document never carries files: they are stripped (even invalid ones), without mutating it', () => {
    for (const id of [TOPOLOGY_SCHEMA_ID_1_0, TOPOLOGY_SCHEMA_ID_1_1, TOPOLOGY_SCHEMA_ID_1_2]) {
      const doc = json({ ...hostDoc(), schema: id });
      (doc['devices'] as Record<string, unknown>[]).push({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', position: { logical: [3, 4] }, files: 'not a list' });
      const before = JSON.stringify(doc);
      const t = parseTopology(doc);
      expect(JSON.stringify(doc)).toBe(before);
      expect(t.schema).toBe(id);
      for (const d of t.devices) expect('files' in d).toBe(false);
    }
  });

  it('validates the store: an array of {path, content}, distinct names, the limits', () => {
    const errorsOf = (files: unknown): string[] => {
      const doc = json(hostDoc());
      (doc['devices'] as Record<string, unknown>[])[0]!['files'] = files;
      const r = validateTopology(doc);
      return r.ok ? [] : r.errors;
    };
    expect(errorsOf([SCRIPT, { path: 'my script.py', content: '' }])).toEqual([]);
    expect(errorsOf('x')).toEqual(['devices[0].files: must be an array (got string)']);
    expect(errorsOf([SCRIPT, { ...SCRIPT, content: 'again' }])).toEqual(['devices[0].files[1].path: file "inventory.py" is listed more than once']);
    expect(errorsOf([{ path: '', content: '' }])).toEqual(['devices[0].files[0].path: must not be empty']);
    expect(errorsOf([{ path: 'dir/a.py', content: '' }])).toEqual(['devices[0].files[0].path: must be a plain file name (no folders, no control characters, not "." or "..")']);
    expect(errorsOf([{ path: 'a'.repeat(MAX_TOPOLOGY_FILE_NAME_CHARS + 1), content: '' }])).toEqual([
      `devices[0].files[0].path: must be at most ${MAX_TOPOLOGY_FILE_NAME_CHARS} characters`,
    ]);
    expect(errorsOf([{ path: 'a.py', content: 'x'.repeat(MAX_TOPOLOGY_FILE_CHARS + 1) }])).toEqual([
      `devices[0].files[0].content: must be at most ${MAX_TOPOLOGY_FILE_CHARS} characters`,
    ]);
    expect(errorsOf([{ path: 'a.py', content: 7 }])).toEqual(['devices[0].files[0].content: must be a string (got number)']);
    expect(errorsOf([{ path: 'a.py' }])).toEqual(['devices[0].files[0].content: is required']);
    const many = Array.from({ length: MAX_TOPOLOGY_FILES_PER_DEVICE + 1 }, (_, i) => ({ path: `f${i}.py`, content: '' }));
    expect(errorsOf(many)).toEqual([`devices[0].files: at most ${MAX_TOPOLOGY_FILES_PER_DEVICE} files are allowed`]);
    expect(errorsOf(many.slice(0, MAX_TOPOLOGY_FILES_PER_DEVICE))).toEqual([]);
  });

  it('accepts exactly the names the device store accepts (isStoredFileName), so every stored file survives export', () => {
    const names = ['inventory.py', 'a', 'my script.py', 'v1.2.json', '...x', '.hidden', 'é.txt', '', '.', '..', 'dir/file.py', 'dir\\file.py', 'tab\tname', 'nul\u0000', 'del\u007f', 'line\nbreak'];
    for (const n of names) expect(isTopologyFileName(n), JSON.stringify(n)).toBe(isStoredFileName(n));
  });

  it('keeps the store to hosts: files on a router are a catalog problem, on a PC none', () => {
    expect(validateTopologyAgainstCatalog(hostDoc(), catalog)).toEqual([]);
    const router: Topology = {
      ...hostDoc(),
      devices: [{ id: 'r1', type: 'router.nf2911', name: 'R1', position: { logical: [0, 0] }, files: [{ ...SCRIPT }] }],
    };
    const model = catalog.get('router.nf2911')!.model;
    expect(validateTopologyAgainstCatalog(router, catalog)).toEqual([
      { device: 'r1', message: `Device "R1" (r1) carries files, but a ${model} has no files: store (only hosts keep files)` },
    ]);
    expect(() => prepareTopologyLoad(json(router), catalog)).toThrow(TopologyLoadError);
    const emptyRouter: Topology = { ...router, devices: router.devices.map((d) => ({ ...d, files: [] })) };
    expect(validateTopologyAgainstCatalog(emptyRouter, catalog)).toEqual([]);
  });
});
