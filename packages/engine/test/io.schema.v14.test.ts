/**
 * io — topology schema 1.4 (ARCHITECTURE-P3C D2, §2.9, §3.4 steps 6–8; §7 W1a io; §9.2 item 10): 1.4 = 1.3 plus [S29]
 * `files[].fs: 'flash'`, [S30] `files[].nominalBytes` and [S31] `devices[].nvram.configRegister`. `schemaIdFor` gives 1.4
 * only when one of them is present, so every 1.1, 1.2 and 1.3 document keeps its id and exports byte-identically (the
 * P2 and P3 lab-export goldens are re-read and re-written here); 1.3 → 1.4 is the identity plus the schema id; a
 * 1.0–1.3 document never keeps a 1.4 key; the 1.4 members are validated (the image header, the register's range,
 * names unique per file system) and checked against the catalog (flash and the register need `DeviceModel.storage`,
 * which the real catalog gains only at the W4b flip, so the staged P3c catalog stands in).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TopologyLoadError } from '../src/contracts/simulation.js';
import { IMAGE_HEADER_BYTES, IMAGE_TRANSFER_SCALE } from '../src/contracts/storage.js';
import {
  LATEST_TOPOLOGY_SCHEMA_ID,
  TOPOLOGY_SCHEMA_IDS,
  TOPOLOGY_SCHEMA_ID_1_1,
  TOPOLOGY_SCHEMA_ID_1_2,
  TOPOLOGY_SCHEMA_ID_1_3,
  TOPOLOGY_SCHEMA_ID_1_4,
  hasV14Content,
  schemaIdFor,
  type Topology,
  type TopologyDevice,
} from '../src/contracts/topology.js';
import { createCatalog } from '../src/device/catalog.js';
import { TOPOLOGY_MIGRATIONS, migrateTopology, migrationTargetOf } from '../src/io/migrate.js';
import { readNetforge, topologyFromJson, topologyToJson, writeNetforge } from '../src/io/netforge-file.js';
import {
  IMAGE_HEADER_MAGIC,
  MAX_CONFIG_REGISTER,
  MAX_IMAGE_NOMINAL_BYTES,
  imageHeader,
  imageHeaderNominalBytes,
  parseTopology,
  prepareTopologyLoad,
  validateTopology,
} from '../src/io/schema.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import { createStagedCatalog } from './staged.world.js';

const MIB = 1024 * 1024;
const json = (t: Topology): unknown => JSON.parse(JSON.stringify(t)) as unknown;
const realCatalog = createCatalog(PROCESS_FACTORIES);
const p3cCatalog = createStagedCatalog({ stage: 'P3c' });

/** An image file's content (§3.4 step 7): header, then a fixed filler, ⌈nominal / IMAGE_TRANSFER_SCALE⌉ bytes. */
function imageContent(nominalBytes: number): string {
  return imageHeader(nominalBytes) + '.'.repeat(Math.ceil(nominalBytes / IMAGE_TRANSFER_SCALE) - IMAGE_HEADER_BYTES);
}

const router = (over: Partial<TopologyDevice> = {}): TopologyDevice => ({
  id: 'r1',
  type: 'router.nf2911',
  name: 'R1',
  position: { logical: [10, 20] },
  config: 'hostname R1\n',
  ...over,
});
const server = (over: Partial<TopologyDevice> = {}): TopologyDevice => ({ id: 's1', type: 'server.nfserver', name: 'SRV1', position: { logical: [0, 0] }, ...over });

/** A 1.4 document: R1 with a flash backup and register 0x2142, SRV1 with lab 31's image in files:. */
function v14Doc(): Topology {
  return {
    schema: TOPOLOGY_SCHEMA_ID_1_4,
    seed: 7,
    devices: [
      router({ files: [{ path: 'r1-confg', content: 'hostname R1\nend\n', fs: 'flash' }], nvram: { configRegister: 0x2142 } }),
      server({ files: [{ path: 'nf2900-15.9.bin', content: imageContent(40 * MIB), nominalBytes: 40 * MIB }] }),
    ],
    links: [],
    profile: 'P3',
  };
}

const errorsOf = (doc: unknown): string[] => {
  const r = validateTopology(doc);
  return r.ok ? [] : r.errors;
};

describe('the 1.4 id and schemaIdFor', () => {
  it('1.4 is the fifth and latest id', () => {
    expect(TOPOLOGY_SCHEMA_ID_1_4).toBe('netforge.topology/1.4');
    expect(TOPOLOGY_SCHEMA_IDS.at(-1)).toBe(TOPOLOGY_SCHEMA_ID_1_4);
    expect(LATEST_TOPOLOGY_SCHEMA_ID).toBe(TOPOLOGY_SCHEMA_ID_1_4);
  });

  it('is 1.4 only when a 1.4 member is present, whatever the profile', () => {
    const bare: Topology = { schema: TOPOLOGY_SCHEMA_ID_1_1, seed: 1, devices: [router()], links: [] };
    expect(schemaIdFor(bare)).toBe(TOPOLOGY_SCHEMA_ID_1_1);
    expect(schemaIdFor({ ...bare, profile: 'P2' })).toBe(TOPOLOGY_SCHEMA_ID_1_2);
    expect(schemaIdFor({ ...bare, profile: 'P3' })).toBe(TOPOLOGY_SCHEMA_ID_1_3);
    expect(schemaIdFor({ ...bare, devices: [server({ files: [{ path: 'a.py', content: 'x' }] })] })).toBe(TOPOLOGY_SCHEMA_ID_1_3);
    const cases: readonly TopologyDevice[] = [
      router({ nvram: { configRegister: 0x2142 } }),
      router({ files: [{ path: 'a', content: 'x', fs: 'flash' }] }),
      server({ files: [{ path: 'i.bin', content: imageContent(MIB), nominalBytes: MIB }] }),
    ];
    for (const d of cases) {
      expect(hasV14Content(d)).toBe(true);
      for (const profile of [undefined, 'P2', 'P3'] as const) {
        const t: Topology = { ...bare, devices: [d] };
        if (profile !== undefined) t.profile = profile;
        expect(schemaIdFor(t)).toBe(TOPOLOGY_SCHEMA_ID_1_4);
      }
    }
    // an `nvram` without a register is no content, like an empty `files`
    expect(hasV14Content(router({ nvram: {} }))).toBe(false);
    expect(schemaIdFor({ ...bare, devices: [router({ nvram: {}, files: [] })] })).toBe(TOPOLOGY_SCHEMA_ID_1_1);
  });
});

describe('migration 1.3 → 1.4', () => {
  it('is one identity step plus the schema id, never mutating its input; 1.4 has no step', () => {
    const step = TOPOLOGY_MIGRATIONS[TOPOLOGY_SCHEMA_ID_1_3];
    expect(step?.from).toBe(TOPOLOGY_SCHEMA_ID_1_3);
    expect(step?.to).toBe(TOPOLOGY_SCHEMA_ID_1_4);
    const input: Topology = { ...v14Doc(), schema: TOPOLOGY_SCHEMA_ID_1_3 };
    const before = JSON.stringify(input);
    const out = step!.migrate(input);
    expect(out).not.toBe(input);
    expect(out).toEqual({ ...input, schema: TOPOLOGY_SCHEMA_ID_1_4 });
    expect(JSON.stringify(input)).toBe(before);
    expect(TOPOLOGY_MIGRATIONS[TOPOLOGY_SCHEMA_ID_1_4]).toBeUndefined();
  });

  it('migrateTopology walks to 1.4 only for 1.4 content; a P3 document stays 1.3', () => {
    const unparsed: Topology = { ...v14Doc(), schema: TOPOLOGY_SCHEMA_ID_1_1 };
    expect(migrationTargetOf(unparsed)).toBe(TOPOLOGY_SCHEMA_ID_1_4);
    expect(migrateTopology(unparsed)).toEqual(v14Doc());
    const p3: Topology = { schema: TOPOLOGY_SCHEMA_ID_1_3, seed: 1, devices: [router()], links: [], profile: 'P3' };
    expect(migrateTopology(p3)).toEqual(p3);
  });
});

describe('every 1.1, 1.2 and 1.3 document exports byte-identically', () => {
  const golden = (name: string): Record<string, Topology> =>
    (JSON.parse(readFileSync(new URL(`./goldens/${name}.json`, import.meta.url), 'utf8')) as { labs: Record<string, Topology> }).labs;

  it('the P2 (1.2) and P3 (1.3) lab exports, and each as a P1 (1.1) document, keep their id and their bytes', () => {
    const docs: Topology[] = [];
    for (const [name, want] of [['p2-lab-exports', TOPOLOGY_SCHEMA_ID_1_2], ['p3-lab-exports', TOPOLOGY_SCHEMA_ID_1_3]] as const) {
      const labs = Object.values(golden(name));
      expect(labs.length).toBeGreaterThan(0);
      for (const t of labs) {
        expect(t.schema).toBe(want);
        docs.push(t);
        // the same network as a P1 (1.1) document, where it can be one (no host files, which need 1.3)
        if (t.devices.some((d) => d.files !== undefined)) continue;
        const { profile: _p, lab, ...rest } = t;
        docs.push({ ...rest, schema: TOPOLOGY_SCHEMA_ID_1_1, ...(lab !== undefined ? { lab: { name: lab.name, version: lab.version } } : {}) });
      }
    }
    for (const t of docs) {
      expect(schemaIdFor(t)).toBe(t.schema);
      const text = topologyToJson(t);
      expect(text).toBe(JSON.stringify(t, null, 2) + '\n');
      expect(topologyToJson(topologyFromJson(text))).toBe(text);
      expect(migrateTopology(parseTopology(json(t)))).toEqual(parseTopology(json(t)));
    }
  });

  it('a 1.0–1.3 document never keeps a 1.4 key', () => {
    for (const schema of [TOPOLOGY_SCHEMA_ID_1_1, TOPOLOGY_SCHEMA_ID_1_2, TOPOLOGY_SCHEMA_ID_1_3]) {
      const doc = { ...v14Doc(), schema } as Topology;
      if (schema !== TOPOLOGY_SCHEMA_ID_1_3) delete doc.profile;
      const t = parseTopology(json(doc));
      for (const d of t.devices) {
        expect('nvram' in d, schema).toBe(false);
        for (const f of d.files ?? []) expect(Object.keys(f), schema).toEqual(['path', 'content']);
      }
      expect(schemaIdFor(t)).not.toBe(TOPOLOGY_SCHEMA_ID_1_4);
    }
  });
});

describe('the 1.4 field set', () => {
  it('reads and writes the 1.4 members: files keep path and content first, nvram after files; .netforge round trip', () => {
    const t = v14Doc();
    expect(schemaIdFor(t)).toBe(TOPOLOGY_SCHEMA_ID_1_4);
    const text = topologyToJson(t);
    const doc = JSON.parse(text) as { devices: Record<string, unknown>[] };
    expect(Object.keys(doc.devices[0]!)).toEqual(['id', 'type', 'name', 'position', 'config', 'files', 'nvram']);
    expect(Object.keys((doc.devices[0]!['files'] as object[])[0]!)).toEqual(['path', 'content', 'fs']);
    expect(Object.keys((doc.devices[1]!['files'] as object[])[0]!)).toEqual(['path', 'content', 'nominalBytes']);
    expect(topologyFromJson(text)).toEqual(t);
    expect(topologyToJson(topologyFromJson(text))).toBe(text);
    const bytes = writeNetforge({ manifest: { format: 1, app: 'netforge/test', created: '2026-10-16T00:00:00Z', modified: '2026-10-16T00:00:00Z' }, topology: t, configs: {} });
    expect(readNetforge(bytes).topology).toEqual(t);
  });

  it('a file system may hold a name another one holds; one file system may not hold a name twice', () => {
    const ok = v14Doc();
    ok.devices[0] = router({ files: [{ path: 'x', content: 'a', fs: 'flash' }, { path: 'x', content: 'b' }] });
    expect(errorsOf(json(ok))).toEqual([]);
    const dup = v14Doc();
    dup.devices[0] = router({ files: [{ path: 'x', content: 'a', fs: 'flash' }, { path: 'x', content: 'b', fs: 'flash' }] });
    expect(errorsOf(json(dup))).toEqual(['devices[0].files[1].path: file "flash:x" is listed more than once']);
  });

  it('refuses a wrong fs, a nominal size without or against the header, and a register out of range', () => {
    const bad = (d: TopologyDevice): string[] => errorsOf(json({ ...v14Doc(), devices: [d] }));
    expect(bad(router({ files: [{ path: 'a', content: 'x', fs: 'nvram' as 'flash' }] }))).toEqual(['devices[0].files[0].fs: must be "flash"; leave it out for the files: store']);
    expect(bad(server({ files: [{ path: 'a', content: 'plain text', nominalBytes: 100 }] }))).toEqual([
      'devices[0].files[0].nominalBytes: is set, but the content does not start with an image header',
    ]);
    expect(bad(server({ files: [{ path: 'a', content: imageContent(MIB), nominalBytes: MIB + 1 }] }))).toEqual([
      `devices[0].files[0].nominalBytes: must equal the image header's size ${MIB}`,
    ]);
    expect(bad(server({ files: [{ path: 'a', content: 'x', nominalBytes: 0 }] }))[0]).toBe(`devices[0].files[0].nominalBytes: must be between 1 and ${MAX_IMAGE_NOMINAL_BYTES}`);
    expect(bad(router({ nvram: { configRegister: MAX_CONFIG_REGISTER + 1 } }))).toEqual(['devices[0].nvram.configRegister: must be between 0 and 65535 (0xFFFF)']);
    expect(bad(router({ nvram: { configRegister: -1 } }))).toEqual(['devices[0].nvram.configRegister: must be between 0 and 65535 (0xFFFF)']);
    expect(bad(router({ nvram: { configRegister: 1.5 } }))).toEqual(['devices[0].nvram.configRegister: must be an integer (got float)']);
    expect(bad(router({ nvram: { configRegister: 0 } }))).toEqual([]);
  });

  it('the catalog check: flash and the register need DeviceModel.storage; files: needs a host', () => {
    // the real catalog has no storage before the W4b flip: a 1.4 router document is refused, honestly, by name
    try {
      prepareTopologyLoad(json(v14Doc()), realCatalog);
      expect.unreachable();
    } catch (e) {
      expect((e as TopologyLoadError).problems.map((p) => p.message)).toEqual([
        'Device "R1" (r1) carries flash: files, but a NF-2911 has no flash: file system',
        'Device "R1" (r1) carries a configuration register, but a NF-2911 has no nvram: file system',
      ]);
    }
    // the staged P3c catalog (P3C_STORAGE) loads it; the in-memory id is the latest, the content unchanged
    expect(prepareTopologyLoad(json(v14Doc()), p3cCatalog)).toEqual(v14Doc());
    // a host carries no flash:; a router carries no files: (P3a's rule, unchanged)
    const wrong: Topology = {
      ...v14Doc(),
      devices: [router({ files: [{ path: 'a.py', content: 'x' }] }), server({ files: [{ path: 'a', content: 'x', fs: 'flash' }], nvram: { configRegister: 0x2142 } })],
    };
    try {
      prepareTopologyLoad(json(wrong), p3cCatalog);
      expect.unreachable();
    } catch (e) {
      expect((e as TopologyLoadError).problems.map((p) => p.message)).toEqual([
        'Device "R1" (r1) carries files, but a NF-2911 has no files: store (only hosts keep files)',
        'Device "SRV1" (s1) carries flash: files, but a NF-SERVER has no flash: file system',
        'Device "SRV1" (s1) carries a configuration register, but a NF-SERVER has no nvram: file system',
      ]);
    }
  });
});

describe('the image header ([S30])', () => {
  it('is the magic and the nominal size as 10 decimal digits, 16 bytes', () => {
    expect(IMAGE_HEADER_MAGIC.length + 10).toBe(IMAGE_HEADER_BYTES);
    expect(imageHeader(40 * MIB)).toBe('NFIMG10041943040');
    expect(imageHeader(1)).toBe('NFIMG10000000001');
    expect(imageHeader(MAX_IMAGE_NOMINAL_BYTES)).toBe('NFIMG19999999999');
    for (const bad of [0, -1, 1.5, MAX_IMAGE_NOMINAL_BYTES + 1]) expect(() => imageHeader(bad), String(bad)).toThrow(RangeError);
  });

  it('reads the size back only from a valid header', () => {
    expect(imageHeaderNominalBytes(imageContent(40 * MIB))).toBe(40 * MIB);
    expect(imageHeaderNominalBytes(imageHeader(5))).toBe(5);
    for (const bad of ['', 'NFIMG1004194304', 'NFIMG20041943040', 'NFIMG1004194304x', 'NFIMG10000000000', ' NFIMG10041943040']) {
      expect(imageHeaderNominalBytes(bad), JSON.stringify(bad)).toBeUndefined();
    }
    // lab 31's image moves ⌈nominal / 1024⌉ = 40 960 bytes
    expect(imageContent(40 * MIB).length).toBe(40960);
  });
});
