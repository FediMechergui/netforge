/**
 * Tests for io/schema.ts — topology and manifest validation (spec §13.2, §17).
 */
import { describe, expect, it } from 'vitest';
import { TOPOLOGY_SCHEMA_ID, type Topology } from '../src/contracts/topology.js';
import {
  MAX_DEVICES,
  MAX_ID_CHARS,
  MAX_LINKS,
  MAX_NETFORGE_BYTES,
  MEDIA_TYPES,
  manifestSchema,
  parseManifest,
  parseTopology,
  topologySchema,
  validateManifest,
  validateTopology,
} from '../src/io/schema.js';

function sample(): Topology {
  return {
    schema: TOPOLOGY_SCHEMA_ID,
    seed: 20260913,
    devices: [
      { id: 'd_0001', type: 'pc.nfpc', name: 'PC1', position: { logical: [100, 200] }, config: 'hostname PC1\n' },
      { id: 'd_0002', type: 'switch.nfc2960', name: 'SW1', position: { logical: [300, 200] }, power: true },
      { id: 'd_0003', type: 'pc.nfpc', name: 'PC2', position: { logical: [500, 200] } },
    ],
    links: [
      { id: 'l_0001', a: { device: 'd_0001', port: 'GigabitEthernet0' }, b: { device: 'd_0002', port: 'FastEthernet0/1' }, media: 'auto' },
      {
        id: 'l_0002',
        a: { device: 'd_0003', port: 'GigabitEthernet0' },
        b: { device: 'd_0002', port: 'FastEthernet0/2' },
        media: 'copper-straight',
        length_m: 3,
        impairments: { lossPct: 5, latencyNs: 1_000_000, jitterNs: 0, corruptPct: 0 },
      },
    ],
    objectives: ['CCNA1.2.3'],
    notes: 'two PCs and a switch',
  };
}

/** Deep-clone via JSON so tests mutate a copy shaped exactly like a file would be. */
const asJson = (t: Topology): unknown => JSON.parse(JSON.stringify(t));

describe('io/schema constants', () => {
  it('exposes the documented limits', () => {
    expect(MAX_NETFORGE_BYTES).toBe(64 * 1024 * 1024);
    expect(MAX_DEVICES).toBe(2000);
    expect(MAX_LINKS).toBe(20000);
    expect(MEDIA_TYPES).toContain('copper-straight');
    expect(MEDIA_TYPES).toContain('auto');
  });
});

describe('validateTopology / parseTopology — success', () => {
  it('accepts a well-formed topology and returns an equal object', () => {
    const t = sample();
    const r = validateTopology(asJson(t));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.topology).toEqual(t);
    expect(parseTopology(asJson(t))).toEqual(t);
  });

  it('accepts the minimal document (no optional fields)', () => {
    const t = parseTopology({ schema: TOPOLOGY_SCHEMA_ID, seed: 1, devices: [], links: [] });
    expect(t.devices).toEqual([]);
    expect(t.links).toEqual([]);
    expect(t.objectives).toBeUndefined();
    expect(t.notes).toBeUndefined();
  });

  it('accepts every media type', () => {
    for (const media of MEDIA_TYPES) {
      const j = asJson(sample()) as { links: { media: string }[] };
      j.links[0]!.media = media;
      expect(validateTopology(j).ok).toBe(true);
    }
  });

  it('accepts ids of any shape up to the length limit and rejects longer ones', () => {
    const j = asJson(sample()) as { devices: { id: string }[]; links: { a: { device: string } }[] };
    j.devices[0]!.id = 'x'.repeat(MAX_ID_CHARS);
    j.links[0]!.a.device = j.devices[0]!.id;
    expect(validateTopology(j).ok).toBe(true);
    j.devices[0]!.id = 'x'.repeat(MAX_ID_CHARS + 1);
    j.links[0]!.a.device = j.devices[0]!.id;
    const r = validateTopology(j);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('devices[0].id:') && e.includes('at most'))).toBe(true);
  });

  it('strips unknown keys (untrusted input never carries extras into the engine)', () => {
    const j = asJson(sample()) as Record<string, unknown>;
    j['surprise'] = { evil: true };
    (j['devices'] as Record<string, unknown>[])[0]!['os'] = { family: 'nfos' };
    const t = parseTopology(j);
    expect('surprise' in t).toBe(false);
    expect('os' in t.devices[0]!).toBe(false);
  });
});

describe('validateTopology / parseTopology — failures with readable messages', () => {
  it('rejects non-objects and missing top-level fields', () => {
    expect(validateTopology(null).ok).toBe(false);
    expect(validateTopology('nope').ok).toBe(false);
    const r = validateTopology({});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContain('schema: is required');
      expect(r.errors).toContain('seed: is required');
      expect(r.errors).toContain('devices: is required');
      expect(r.errors).toContain('links: is required');
    }
  });

  it('rejects a wrong schema id', () => {
    const j = asJson(sample()) as { schema: string };
    j.schema = 'netforge.topology/9.9';
    const r = validateTopology(j);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toBe('schema: must be one of "netforge.topology/1.0", "netforge.topology/1.1"');
  });

  it('rejects a non-integer seed', () => {
    const j = asJson(sample()) as { seed: number };
    j.seed = 1.5;
    const r = validateTopology(j);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain('seed: must be an integer (got float)');
    const k = asJson(sample()) as { seed: unknown };
    k.seed = '42';
    const r2 = validateTopology(k);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.errors).toContain('seed: must be a number (got string)');
  });

  it('rejects duplicate device ids', () => {
    const j = asJson(sample()) as { devices: { id: string }[] };
    j.devices[2]!.id = 'd_0001';
    const r = validateTopology(j);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain('devices[2].id: duplicate device id "d_0001"');
  });

  it('rejects duplicate link ids', () => {
    const j = asJson(sample()) as { links: { id: string }[] };
    j.links[1]!.id = 'l_0001';
    const r = validateTopology(j);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain('links[1].id: duplicate link id "l_0001"');
  });

  it('rejects a link whose endpoint names a missing device', () => {
    const j = asJson(sample()) as { links: { b: { device: string } }[] };
    j.links[1]!.b.device = 'd_none';
    const r = validateTopology(j);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain('links[1].b.device: unknown device "d_none"');
  });

  it('rejects two links on the same port and self-loops', () => {
    const j = asJson(sample()) as { links: { a: { device: string; port: string }; b: { device: string; port: string } }[] };
    j.links[1]!.b.port = 'FastEthernet0/1';
    let r = validateTopology(j);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain('links[1].b: port d_0002/FastEthernet0/1 is already used by link "l_0001"');

    const k = asJson(sample()) as typeof j;
    k.links[0]!.b = { ...k.links[0]!.a };
    r = validateTopology(k);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('links[0]:') && e.includes('to itself'))).toBe(true);
  });

  it('rejects an empty id, an empty name and a non-finite position', () => {
    const j = asJson(sample()) as { devices: { id: string; name: string; position: { logical: unknown } }[] };
    j.devices[0]!.id = '';
    j.devices[1]!.name = '';
    j.devices[2]!.position.logical = [1, 'two'];
    const r = validateTopology(j);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContain('devices[0].id: must not be empty');
      expect(r.errors).toContain('devices[1].name: must not be empty');
      expect(r.errors.some((e) => e.startsWith('devices[2].position.logical[1]:'))).toBe(true);
    }
    // JSON cannot carry Infinity, but an in-memory object can.
    const k = sample();
    k.devices[0]!.position.logical = [Number.POSITIVE_INFINITY, 0];
    const r2 = validateTopology(k);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.errors).toContain('devices[0].position.logical[0]: must be finite');
  });

  it('rejects an unknown media type', () => {
    const j = asJson(sample()) as { links: { media: string }[] };
    j.links[0]!.media = 'wet-string';
    const r = validateTopology(j);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/^links\[0\]\.media: must be one of copper-straight/);
  });

  it('rejects impairments out of range', () => {
    const j = asJson(sample()) as { links: { impairments?: Record<string, unknown> }[] };
    j.links[1]!.impairments = { lossPct: 101, corruptPct: -1, latencyNs: -5, jitterNs: 1.5, bandwidthBps: 0 };
    const r = validateTopology(j);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContain('links[1].impairments.lossPct: must be between 0 and 100');
      expect(r.errors).toContain('links[1].impairments.corruptPct: must be between 0 and 100');
      expect(r.errors).toContain('links[1].impairments.latencyNs: must be >= 0');
      expect(r.errors).toContain('links[1].impairments.jitterNs: must be an integer number of nanoseconds (got float)');
      expect(r.errors).toContain('links[1].impairments.bandwidthBps: must be > 0');
    }
  });

  it('rejects a negative cable length', () => {
    const j = asJson(sample()) as { links: { length_m?: number }[] };
    j.links[1]!.length_m = -1;
    const r = validateTopology(j);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain('links[1].length_m: must be >= 0');
  });

  it('enforces MAX_DEVICES and MAX_LINKS', () => {
    const devices = Array.from({ length: MAX_DEVICES + 1 }, (_, i) => ({
      id: `d_${i}`,
      type: 'pc.nfpc',
      name: `PC${i}`,
      position: { logical: [i, 0] },
    }));
    const r = validateTopology({ schema: TOPOLOGY_SCHEMA_ID, seed: 1, devices, links: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain(`devices: at most ${MAX_DEVICES} devices are allowed`);

    const two = [
      { id: 'a', type: 'pc.nfpc', name: 'A', position: { logical: [0, 0] } },
      { id: 'b', type: 'pc.nfpc', name: 'B', position: { logical: [1, 0] } },
    ];
    const links = Array.from({ length: MAX_LINKS + 1 }, (_, i) => ({
      id: `l_${i}`,
      a: { device: 'a', port: `p${i}` },
      b: { device: 'b', port: `p${i}` },
      media: 'auto',
    }));
    const r2 = validateTopology({ schema: TOPOLOGY_SCHEMA_ID, seed: 1, devices: two, links });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.errors).toContain(`links: at most ${MAX_LINKS} links are allowed`);
  });

  it('parseTopology throws an Error quoting the first issues with paths and a count', () => {
    const j = asJson(sample()) as { devices: { id: string; type: string; name: string; position: unknown }[]; links: { b: { device: string } }[] };
    j.devices.push({ id: 'd_0001', type: 'pc.nfpc', name: 'PC3', position: { logical: [0, 0] } });
    j.links[1]!.b.device = 'd_none';
    let message = '';
    try {
      parseTopology(j);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/^Invalid topology: 2 issues\n/);
    expect(message).toContain('  - devices[3].id: duplicate device id "d_0001"');
    expect(message).toContain('  - links[1].b.device: unknown device "d_none"');
  });

  it('parseTopology truncates long issue lists', () => {
    const devices = Array.from({ length: 12 }, () => ({ id: '', type: 'pc.nfpc', name: 'x', position: { logical: [0, 0] } }));
    let message = '';
    try {
      parseTopology({ schema: TOPOLOGY_SCHEMA_ID, seed: 1, devices, links: [] });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/^Invalid topology: \d+ issues\n/);
    expect(message).toMatch(/\.\.\. and \d+ more$/);
    expect(message.split('\n').length).toBe(1 + 5 + 1);
  });

  it('topologySchema is the underlying zod schema', () => {
    expect(topologySchema.safeParse(asJson(sample())).success).toBe(true);
  });
});

describe('manifest validation', () => {
  const good = { format: 1, app: 'netforge/0.0.1', created: '2026-09-13T10:00:00.000Z', modified: '2026-09-13T10:05:00+02:00' };

  it('accepts a valid manifest with or without a checksum', () => {
    expect(validateManifest(good).ok).toBe(true);
    expect(parseManifest({ ...good, checksum: 'deadbeefdeadbeef' })).toEqual({ ...good, checksum: 'deadbeefdeadbeef' });
    expect(manifestSchema.safeParse(good).success).toBe(true);
  });

  it('rejects a wrong format, a missing app and a non-ISO timestamp', () => {
    const r = validateManifest({ format: 2, created: 'yesterday', modified: good.modified });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContain('format: must be 1');
      expect(r.errors).toContain('app: is required');
      expect(r.errors).toContain('created: must be an ISO-8601 timestamp');
    }
    expect(() => parseManifest({ ...good, checksum: 'not hex!' })).toThrow(/^Invalid manifest: 1 issue\n  - checksum: must be a hex string$/);
  });
});
