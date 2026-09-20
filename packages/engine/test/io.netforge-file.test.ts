/**
 * Tests for io/netforge-file.ts — .netforge write/read round-trip, caps,
 * corrupt input, checksum, plain JSON helpers (spec §13.1, §17).
 */
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';
import { TOPOLOGY_SCHEMA_ID, type NetforgeProject, type Topology } from '../src/contracts/topology.js';
import {
  NETFORGE_ENTRY,
  NETFORGE_ZIP_MTIME,
  canonicalTopology,
  checksumHex,
  configEntryName,
  deviceIdFromConfigEntry,
  parseConfigEntry,
  readNetforge,
  renderReadme,
  runningConfigEntryName,
  topologyFromJson,
  topologyToJson,
  writeNetforge,
} from '../src/io/netforge-file.js';
import { MAX_NETFORGE_BYTES } from '../src/io/schema.js';

const PC1_CFG = 'hostname PC1\n!\ninterface GigabitEthernet0\n ip address 10.0.0.1 255.255.255.0\n!\nip default-gateway 10.0.0.254\nend\n';
const SW1_CFG = 'hostname SW1\n!\nend\n';

function topology(): Topology {
  return {
    schema: TOPOLOGY_SCHEMA_ID,
    seed: 42,
    devices: [
      { id: 'd_0001', type: 'pc.nfpc', name: 'PC1', position: { logical: [100, 200] }, config: PC1_CFG },
      { id: 'd_0002', type: 'switch.nfc2960', name: 'SW1', position: { logical: [300, 200] }, power: true, config: SW1_CFG },
      { id: 'd_0003', type: 'pc.nfpc', name: 'PC2', position: { logical: [500, 200] } },
    ],
    links: [
      { id: 'l_0001', a: { device: 'd_0001', port: 'GigabitEthernet0' }, b: { device: 'd_0002', port: 'FastEthernet0/1' }, media: 'auto', length_m: 3 },
      {
        id: 'l_0002',
        a: { device: 'd_0003', port: 'GigabitEthernet0' },
        b: { device: 'd_0002', port: 'FastEthernet0/2' },
        media: 'copper-straight',
        impairments: { lossPct: 1, latencyNs: 2_000_000 },
      },
    ],
    objectives: ['CCNA1.1.1'],
    notes: 'ping lab — é ü 日本',
  };
}

function project(): NetforgeProject {
  return {
    manifest: { format: 1, app: 'netforge/0.0.1', created: '2026-09-13T10:00:00.000Z', modified: '2026-09-13T10:05:00.000Z' },
    topology: topology(),
    configs: { d_0001: PC1_CFG, d_0002: SW1_CFG },
  };
}

const entryText = (bytes: Uint8Array, name: string): string | undefined => {
  const files = unzipSync(bytes);
  const f = files[name];
  return f === undefined ? undefined : strFromU8(f);
};

describe('checksumHex (FNV-1a 64)', () => {
  it('matches the reference vectors', () => {
    expect(checksumHex(new Uint8Array(0))).toBe('cbf29ce484222325');
    expect(checksumHex(strToU8('a'))).toBe('af63dc4c8601ec8c');
    expect(checksumHex(strToU8('foobar'))).toBe('85944171f73967e8');
  });

  it('is 16 lowercase hex chars and sensitive to every byte', () => {
    const a = checksumHex(strToU8('topology'));
    const b = checksumHex(strToU8('topolog0'));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });
});

describe('writeNetforge', () => {
  it('produces a zip with manifest, stripped topology, configs and README', () => {
    const bytes = writeNetforge(project());
    const files = unzipSync(bytes);
    expect(Object.keys(files)).toEqual([
      NETFORGE_ENTRY.manifest,
      NETFORGE_ENTRY.topology,
      configEntryName('d_0001'),
      configEntryName('d_0002'),
      NETFORGE_ENTRY.readme,
    ]);

    const topo = JSON.parse(strFromU8(files[NETFORGE_ENTRY.topology]!)) as { devices: Record<string, unknown>[] };
    for (const d of topo.devices) expect('config' in d).toBe(false);

    const manifest = JSON.parse(strFromU8(files[NETFORGE_ENTRY.manifest]!)) as Record<string, unknown>;
    expect(manifest['format']).toBe(1);
    expect(manifest['app']).toBe('netforge/0.0.1');
    expect(manifest['created']).toBe('2026-09-13T10:00:00.000Z');
    expect(manifest['checksum']).toBe(checksumHex(files[NETFORGE_ENTRY.topology]!));

    expect(strFromU8(files[configEntryName('d_0001')]!)).toBe(PC1_CFG);
    expect(strFromU8(files[configEntryName('d_0002')]!)).toBe(SW1_CFG);

    const readme = strFromU8(files[NETFORGE_ENTRY.readme]!);
    expect(readme).toContain('# NetForge project');
    expect(readme).toContain('- PC1 (pc.nfpc, id d_0001)');
    expect(readme).toContain('- SW1 (switch.nfc2960, id d_0002)');
    expect(readme).toContain('- PC2 (pc.nfpc, id d_0003)');
    expect(readme).not.toMatch(/cisco|ios/i);
  });

  it('is byte-for-byte deterministic', () => {
    const a = writeNetforge(project());
    const b = writeNetforge(project());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(NETFORGE_ZIP_MTIME).toBe(946_684_800_000);
  });

  it('falls back to devices[].config when project.configs lacks an entry, and keeps extra configs sorted', () => {
    const p = project();
    p.configs = { zz_extra: 'hostname Z\n', aa_extra: 'hostname A\n' };
    const files = unzipSync(writeNetforge(p));
    expect(Object.keys(files)).toEqual([
      NETFORGE_ENTRY.manifest,
      NETFORGE_ENTRY.topology,
      configEntryName('d_0001'),
      configEntryName('d_0002'),
      configEntryName('aa_extra'),
      configEntryName('zz_extra'),
      NETFORGE_ENTRY.readme,
    ]);
    expect(strFromU8(files[configEntryName('d_0001')]!)).toBe(PC1_CFG);
  });

  it('uses a caller-supplied readme verbatim', () => {
    const p = project();
    p.readme = '# My lab\n';
    expect(entryText(writeNetforge(p), NETFORGE_ENTRY.readme)).toBe('# My lab\n');
  });

  it('refuses to write an invalid topology or manifest', () => {
    const p = project();
    p.topology.links[0]!.a.device = 'ghost';
    expect(() => writeNetforge(p)).toThrow(/Invalid topology: 1 issue\n  - links\[0\]\.a\.device: unknown device "ghost"/);

    const q = project();
    q.manifest.created = 'not a date';
    expect(() => writeNetforge(q)).toThrow(/Cannot write project: invalid manifest\n  - created: must be an ISO-8601 timestamp/);
  });
});

describe('readNetforge', () => {
  it('round-trips: topology equal, configs re-attached, readme present', () => {
    const original = project();
    const back = readNetforge(writeNetforge(original));

    expect(back.topology).toEqual(canonicalTopology(original.topology));
    expect(back.topology).toEqual(original.topology);
    expect(back.topology.devices[0]!.config).toBe(PC1_CFG);
    expect(back.topology.devices[1]!.config).toBe(SW1_CFG);
    expect(back.topology.devices[2]!.config).toBeUndefined();
    expect(back.configs).toEqual({ d_0001: PC1_CFG, d_0002: SW1_CFG });
    expect(back.manifest.format).toBe(1);
    expect(back.manifest.app).toBe('netforge/0.0.1');
    expect(back.manifest.created).toBe(original.manifest.created);
    expect(back.manifest.modified).toBe(original.manifest.modified);
    expect(back.manifest.checksum).toMatch(/^[0-9a-f]{16}$/);
    expect(back.readme).toContain('# NetForge project');
    expect(back.topology.notes).toBe('ping lab — é ü 日本');

    // Writing the read-back project again yields identical bytes.
    const again = writeNetforge({ ...back, readme: undefined });
    expect(Buffer.from(again).equals(Buffer.from(writeNetforge(original)))).toBe(true);
  });

  it('rejects input over the size cap before inflating', () => {
    const big = new Uint8Array(MAX_NETFORGE_BYTES + 1);
    expect(() => readNetforge(big)).toThrow(/^Archive is 67108865 bytes; the limit is 67108864$/);
  });

  it('rejects an entry whose declared uncompressed size exceeds the cap (zip-bomb guard)', () => {
    const patched = new Uint8Array(writeNetforge(project()));
    const view = new DataView(patched.buffer, patched.byteOffset, patched.byteLength);
    // Central directory file header: sig(4) vmade(2) vneed(2) flag(2) comp(2) time(2) date(2) crc(4) csize(4) usize(4) …
    // fflate takes entry sizes from the central directory; the first header there is manifest.json.
    let cd = -1;
    for (let i = 0; i + 4 <= patched.length; i++) {
      if (view.getUint32(i, true) === 0x02014b50) {
        cd = i;
        break;
      }
    }
    expect(cd).toBeGreaterThan(0);
    view.setUint32(cd + 24, MAX_NETFORGE_BYTES + 1, true);
    expect(() => readNetforge(patched)).toThrow(/Archive entry manifest\.json declares 67108865 bytes; the limit is 67108864/);
  });

  it('rejects corrupt / non-zip bytes with a readable message', () => {
    expect(() => readNetforge(strToU8('this is not a zip file at all'))).toThrow(/^Not a readable project archive: /);
    const truncated = writeNetforge(project()).slice(0, 40);
    expect(() => readNetforge(truncated)).toThrow(/^Not a readable project archive: /);
  });

  it('rejects archives missing manifest.json or topology.json', () => {
    const noManifest = zipSync({ [NETFORGE_ENTRY.topology]: [strToU8('{}'), { mtime: NETFORGE_ZIP_MTIME }] }, { mtime: NETFORGE_ZIP_MTIME });
    expect(() => readNetforge(noManifest)).toThrow(/^Archive has no manifest\.json$/);
    const manifestOnly = zipSync(
      { [NETFORGE_ENTRY.manifest]: [strToU8(JSON.stringify(project().manifest)), { mtime: NETFORGE_ZIP_MTIME }] },
      { mtime: NETFORGE_ZIP_MTIME },
    );
    expect(() => readNetforge(manifestOnly)).toThrow(/^Archive has no topology\.json$/);
  });

  it('rejects malformed JSON and invalid manifest/topology with paths', () => {
    const mk = (manifest: string, topo: string): Uint8Array =>
      zipSync(
        {
          [NETFORGE_ENTRY.manifest]: [strToU8(manifest), { mtime: NETFORGE_ZIP_MTIME }],
          [NETFORGE_ENTRY.topology]: [strToU8(topo), { mtime: NETFORGE_ZIP_MTIME }],
        },
        { mtime: NETFORGE_ZIP_MTIME },
      );
    const goodManifest = JSON.stringify(project().manifest);
    expect(() => readNetforge(mk('{ oops', '{}'))).toThrow(/^manifest\.json is not valid JSON: /);
    expect(() => readNetforge(mk(goodManifest, '[1,'))).toThrow(/^topology\.json is not valid JSON: /);
    expect(() => readNetforge(mk('{"format":3}', '{}'))).toThrow(/^Invalid manifest: \d+ issues\n  - format: must be 1/);

    const dup = topology();
    dup.devices.push({ id: 'd_0001', type: 'pc.nfpc', name: 'PC3', position: { logical: [0, 0] } });
    expect(() => readNetforge(mk(goodManifest, JSON.stringify(dup)))).toThrow(/Invalid topology: 1 issue\n  - devices\[3\]\.id: duplicate device id "d_0001"/);

    const dangling = topology();
    dangling.links[1]!.b.device = 'd_none';
    expect(() => readNetforge(mk(goodManifest, JSON.stringify(dangling)))).toThrow(/links\[1\]\.b\.device: unknown device "d_none"/);
  });

  it('detects a checksum mismatch unless verification is disabled', () => {
    const bytes = writeNetforge(project());
    const files = unzipSync(bytes);
    const edited = topology();
    edited.seed = 99;
    files[NETFORGE_ENTRY.topology] = strToU8(JSON.stringify(canonicalTopology(edited, false)));
    const entries: Zippable = {};
    for (const [k, v] of Object.entries(files)) entries[k] = [v, { mtime: NETFORGE_ZIP_MTIME }];
    const tampered = zipSync(entries, { mtime: NETFORGE_ZIP_MTIME });

    expect(() => readNetforge(tampered)).toThrow(/topology\.json does not match the manifest checksum/);
    const p = readNetforge(tampered, { verifyChecksum: false });
    expect(p.topology.seed).toBe(99);
    expect(p.topology.devices[0]!.config).toBe(PC1_CFG);
  });

  it('ignores unknown files, orphan configs and a missing README; keeps inline configs', () => {
    const t = topology();
    const stripped = canonicalTopology(t, false);
    stripped.devices[2]!.config = 'hostname PC2-inline\n';
    const topoBytes = strToU8(JSON.stringify(stripped));
    const manifest = { ...project().manifest, checksum: checksumHex(topoBytes) };
    const attrs = { mtime: NETFORGE_ZIP_MTIME };
    const bytes = zipSync(
      {
        [NETFORGE_ENTRY.manifest]: [strToU8(JSON.stringify(manifest)), attrs],
        [NETFORGE_ENTRY.topology]: [topoBytes, attrs],
        [configEntryName('d_0001')]: [strToU8(PC1_CFG), attrs],
        [configEntryName('d_9999')]: [strToU8('hostname ORPHAN\n'), attrs],
        'configs-ast/d_0001.json': [strToU8('{}'), attrs],
        'assets/floorplan.svg': [strToU8('<svg/>'), attrs],
        'configs/nested/x.cfg': [strToU8('nope'), attrs],
      },
      { mtime: NETFORGE_ZIP_MTIME },
    );
    const p = readNetforge(bytes);
    expect(p.readme).toBeUndefined();
    expect(p.configs).toEqual({ d_0001: PC1_CFG, d_0003: 'hostname PC2-inline\n' });
    expect(p.topology.devices[0]!.config).toBe(PC1_CFG);
    expect(p.topology.devices[1]!.config).toBeUndefined();
    expect(p.topology.devices[2]!.config).toBe('hostname PC2-inline\n');
  });

  it('round-trips device ids that need encoding in the config file name', () => {
    const p = project();
    p.topology.devices[0]!.id = 'weird/id with spaces';
    p.topology.links[0]!.a.device = 'weird/id with spaces';
    p.configs = { 'weird/id with spaces': PC1_CFG, d_0002: SW1_CFG };
    const name = configEntryName('weird/id with spaces');
    expect(name).toBe('configs/weird%2Fid%20with%20spaces.cfg');
    expect(deviceIdFromConfigEntry(name)).toBe('weird/id with spaces');
    expect(deviceIdFromConfigEntry('configs/%E0%A4%A.cfg')).toBeUndefined();
    expect(deviceIdFromConfigEntry('configs/.cfg')).toBeUndefined();
    expect(deviceIdFromConfigEntry('README.md')).toBeUndefined();
    const back = readNetforge(writeNetforge(p));
    expect(back.configs['weird/id with spaces']).toBe(PC1_CFG);
    expect(back.topology.devices[0]!.config).toBe(PC1_CFG);
  });
});

describe('running-config entries', () => {
  it('writes startup and running configs to separate entries and reads both back', () => {
    const p = project();
    p.topology.devices[0]!.runningConfig = 'hostname PC1-unsaved\n!\nend\n';
    // A device with running but no startup config (after erase startup-config).
    p.topology.devices[2]!.runningConfig = 'hostname PC2-ram\n!\nend\n';
    const bytes = writeNetforge(p);
    const files = unzipSync(bytes);
    expect(strFromU8(files[configEntryName('d_0001')]!)).toBe(PC1_CFG);
    expect(strFromU8(files[runningConfigEntryName('d_0001')]!)).toBe('hostname PC1-unsaved\n!\nend\n');
    expect(files[configEntryName('d_0003')]).toBeUndefined();
    expect(strFromU8(files[runningConfigEntryName('d_0003')]!)).toBe('hostname PC2-ram\n!\nend\n');
    expect(entryText(bytes, NETFORGE_ENTRY.topology)).not.toContain('unsaved');

    const back = readNetforge(bytes);
    expect(back.topology.devices[0]!.config).toBe(PC1_CFG);
    expect(back.topology.devices[0]!.runningConfig).toBe('hostname PC1-unsaved\n!\nend\n');
    expect(back.topology.devices[1]!.runningConfig).toBeUndefined();
    expect(back.topology.devices[2]!.config).toBeUndefined();
    expect(back.topology.devices[2]!.runningConfig).toBe('hostname PC2-ram\n!\nend\n');
    expect(back.configs).toEqual({ d_0001: PC1_CFG, d_0002: SW1_CFG });
  });

  it('keeps ids containing ".running" distinct from running entries', () => {
    const p = project();
    p.topology.devices[0]!.id = 'a';
    p.topology.devices[1]!.id = 'a.running';
    p.topology.links[0]!.a.device = 'a';
    p.topology.links[0]!.b.device = 'a.running';
    p.topology.links[1]!.b.device = 'a.running';
    p.topology.devices[0]!.runningConfig = 'hostname A-ram\n';
    p.configs = { a: PC1_CFG, 'a.running': SW1_CFG };
    expect(configEntryName('a.running')).toBe('configs/a%2Erunning.cfg');
    expect(parseConfigEntry(runningConfigEntryName('a'))).toEqual({ id: 'a', kind: 'running' });
    expect(parseConfigEntry(configEntryName('a.running'))).toEqual({ id: 'a.running', kind: 'startup' });
    const back = readNetforge(writeNetforge(p));
    expect(back.topology.devices[0]!.config).toBe(PC1_CFG);
    expect(back.topology.devices[0]!.runningConfig).toBe('hostname A-ram\n');
    expect(back.topology.devices[1]!.config).toBe(SW1_CFG);
    expect(back.topology.devices[1]!.runningConfig).toBeUndefined();
  });
});

describe('plain JSON helpers', () => {
  it('topologyToJson keeps inline configs and canonical key order; topologyFromJson validates', () => {
    const t = topology();
    const text = topologyToJson(t);
    expect(text.endsWith('\n')).toBe(true);
    const keys = Object.keys(JSON.parse(text) as Record<string, unknown>);
    expect(keys).toEqual(['schema', 'seed', 'devices', 'links', 'objectives', 'notes']);
    expect(text).toContain('"config": "hostname PC1');
    expect(topologyFromJson(text)).toEqual(t);
  });

  it('topologyFromJson reports bad syntax and schema problems readably', () => {
    expect(() => topologyFromJson('{')).toThrow(/^topology\.json is not valid JSON: /);
    expect(() => topologyFromJson('{"schema":"x"}')).toThrow(/^Invalid topology: \d+ issues\n  - schema: must be one of "netforge\.topology\/1\.0", "netforge\.topology\/1\.1"/);
  });

  it('canonicalTopology drops undefined-valued optionals and copies arrays', () => {
    const t = topology();
    t.devices[2]!.power = undefined;
    const c = canonicalTopology(t);
    expect('power' in c.devices[2]!).toBe(false);
    expect(c.objectives).not.toBe(t.objectives);
    expect(c.objectives).toEqual(t.objectives);
  });

  it('renderReadme lists devices and links with original wording', () => {
    const md = renderReadme(topology());
    expect(md).toContain('## Devices (3)');
    expect(md).toContain('- PC1 GigabitEthernet0 <-> SW1 FastEthernet0/1 (auto)');
    expect(md).toContain('## Notes');
    expect(renderReadme({ schema: TOPOLOGY_SCHEMA_ID, seed: 0, devices: [], links: [] })).toContain('_none_');
  });
});
