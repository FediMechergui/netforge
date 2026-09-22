/**
 * Tests for io/migrate.ts and the P0.5 (schema 1.1) parts of io/schema.ts and io/netforge-file.ts:
 * migration, per-version field sets, 1.1 limits, catalog-aware validation, the atomic load gate and
 * the save whitelists (ARCHITECTURE-P1 D11, §3.14).
 */
import { describe, expect, it } from 'vitest';
import type { ModuleModel } from '../src/contracts/catalog.js';
import type { DeviceCatalog, DeviceModel, PortResolution } from '../src/contracts/device.js';
import { TopologyLoadError } from '../src/contracts/simulation.js';
import {
  LATEST_TOPOLOGY_SCHEMA_ID,
  TOPOLOGY_SCHEMA_ID,
  TOPOLOGY_SCHEMA_IDS,
  TOPOLOGY_SCHEMA_ID_1_0,
  TOPOLOGY_SCHEMA_ID_1_1,
  type Topology,
} from '../src/contracts/topology.js';
import { createCatalog } from '../src/device/catalog.js';
import { resolvePortName } from '../src/device/catalog/names.js';
import { TOPOLOGY_MIGRATIONS, isTopologySchemaId, migrateTopology } from '../src/io/migrate.js';
import { readNetforge, topologyFromJson, topologyToJson, writeNetforge } from '../src/io/netforge-file.js';
import {
  MAX_DISTANCE_M,
  MAX_LENGTH_M,
  MAX_MAC_SALT,
  MAX_METRES_PER_UNIT,
  MAX_MODULES_PER_DEVICE,
  MAX_UI_HISTORY,
  MAX_UI_JSON_CHARS,
  MAX_UI_URL_CHARS,
  parseTopology,
  prepareTopologyLoad,
  topologyLoadError,
  validateTopology,
  validateTopologyAgainstCatalog,
} from '../src/io/schema.js';
import { testModel } from './port.fixtures.js';

// ── fixtures ────────────────────────────────────────────────────────────────

function p0Topology(schema: Topology['schema'] = TOPOLOGY_SCHEMA_ID_1_0): Topology {
  return {
    schema,
    seed: 7,
    devices: [
      { id: 'd_0001', type: 'pc.nfpc', name: 'PC1', position: { logical: [100, 200] }, config: 'hostname PC1\n' },
      { id: 'd_0002', type: 'switch.nfc2960', name: 'SW1', position: { logical: [300, 200] } },
    ],
    links: [{ id: 'l_0001', a: { device: 'd_0001', port: 'Gi0' }, b: { device: 'd_0002', port: 'Fa0/1' }, media: 'auto', length_m: 3 }],
    objectives: ['lab.1'],
    notes: 'p0',
  };
}

function v11Topology(): Topology {
  return {
    schema: TOPOLOGY_SCHEMA_ID_1_1,
    seed: 11,
    devices: [
      {
        id: 'd_r1',
        type: 'router.nftest',
        name: 'R1',
        position: { logical: [0, 0] },
        power: false,
        modules: [{ slot: '0/0', module: 'mod.ehwic-2t' }],
        hardware: { macSalt: 2 },
        ui: { desktop: { browserUrl: 'http://www.lab.nf/', browserHistory: ['http://www.lab.nf/'], pinnedApps: ['desktop.ip-config'] }, note: 'edge' },
      },
      { id: 'd_r2', type: 'router.nftest', name: 'R2', position: { logical: [400, 0] } },
    ],
    links: [
      { id: 'l_s', a: { device: 'd_r1', port: 'Serial0/0/0' }, b: { device: 'd_r2', port: 'Se0/1/0' }, media: 'serial-dte', length_m: 2, kind: 'cable', dce_end: 'a' },
      { id: 'l_r', a: { device: 'd_r1', port: 'Gi0/0' }, b: { device: 'd_r2', port: 'GigabitEthernet0/0' }, media: 'radio', kind: 'radio', distance_m: 12_000 },
    ],
    canvas: { metresPerUnit: 2 },
    lab: { name: 'ccna1-serial', version: 3 },
  };
}

const TEST_ROUTER: DeviceModel = testModel({
  type: 'router.nftest',
  model: 'NF-TEST-RTR',
  kind: 'router',
  description: 'Modular test router',
  ports: [
    { name: 'GigabitEthernet0/0', short: 'Gi0/0', kind: 'ethernet', speedBps: 1_000_000_000 },
    { name: 'Console', short: 'Con', kind: 'console', speedBps: 9600 },
  ],
  processes: [],
  hostnamePrefix: 'Router',
  portsDefaultUp: false,
  bootNs: 0,
  ipForwarding: true,
  processingNs: 0,
  capabilities: ['routing', 'modular'],
  slots: [
    { id: '0/0', label: 'EHWIC slot 0', type: 'ehwic', numbering: '0/0', slotIndex: 0 },
    { id: '0/1', label: 'EHWIC slot 1', type: 'ehwic', numbering: '0/1', slotIndex: 1, defaultModule: 'mod.ehwic-2t' },
  ],
});

const TEST_HOME: DeviceModel = testModel({
  type: 'wrouter.nftest',
  model: 'NF-TEST-HOME',
  kind: 'wrouter',
  description: 'Home router with a fixed switch virtual interface',
  ports: [
    { name: 'GigabitEthernet1', short: 'Gi1', kind: 'ethernet', speedBps: 1_000_000_000, role: 'switched' },
    { name: 'Vlan1', short: 'Vl1', kind: 'virtual', speedBps: 1_000_000_000, role: 'svi' },
  ],
  processes: [],
  hostnamePrefix: 'Home',
  portsDefaultUp: true,
  bootNs: 0,
  ipForwarding: true,
  processingNs: 0,
  capabilities: ['switching', 'routing'],
  slots: [],
});

const MODULES: readonly ModuleModel[] = [
  { type: 'mod.ehwic-2t', model: 'NF-EHWIC-2T', description: 'two serial ports', fits: 'ehwic', ports: [{ family: 'Serial', count: 2, spec: { kind: 'serial', speedBps: 2_000_000 } }] },
  { type: 'mod.nim-2t', model: 'NF-NIM-2T', description: 'two serial ports', fits: 'nim', ports: [{ family: 'Serial', count: 2, spec: { kind: 'serial', speedBps: 2_000_000 } }] },
];

/** Minimal name resolver with the `resolvePort` result shapes (exact long or short name, case-insensitive). */
function fakeResolvePort(source: Parameters<DeviceCatalog['resolvePort']>[0], name: string): PortResolution {
  const lower = name.toLowerCase();
  if (lower === 'ambig0') return { kind: 'ambiguous', candidates: ['GigabitEthernet0/0', 'Console'] };
  for (const [id, p] of source.ports) {
    if (p.spec.name.toLowerCase() === lower || p.spec.short.toLowerCase() === lower) return { kind: 'existing', port: id };
  }
  const m = /^(?:vlan|loopback)(\d+)$/.exec(lower);
  if (m !== null) return { kind: 'virtual', port: `${lower.startsWith('vlan') ? 'Vlan' : 'Loopback'}${m[1]}`, family: lower.startsWith('vlan') ? 'Vlan' : 'Loopback' };
  return { kind: 'unknown' };
}

function testCatalog(withResolver: boolean): DeviceCatalog {
  const models = new Map<string, DeviceModel>([[TEST_ROUTER.type, TEST_ROUTER], [TEST_HOME.type, TEST_HOME]]);
  const catalog: DeviceCatalog = {
    get: (type) => models.get(type),
    list: () => [...models.values()],
    process: () => undefined,
    resolvePort: withResolver ? fakeResolvePort : resolvePortName,
    module: (type) => MODULES.find((m) => m.type === type),
    modules: () => MODULES,
  };
  return catalog;
}

const messages = (t: Topology, c: DeviceCatalog): string[] => validateTopologyAgainstCatalog(t, c).map((p) => p.message);

// ── migrate ─────────────────────────────────────────────────────────────────

describe('migrateTopology', () => {
  it('the exporter id stays 1.1; the latest id is 1.2', () => {
    expect(TOPOLOGY_SCHEMA_ID).toBe('netforge.topology/1.1');
    expect(LATEST_TOPOLOGY_SCHEMA_ID).toBe('netforge.topology/1.2');
    expect(TOPOLOGY_SCHEMA_IDS).toEqual(['netforge.topology/1.0', 'netforge.topology/1.1', 'netforge.topology/1.2']);
  });

  it('1.0 → 1.1 is the identity plus the schema id, and never mutates the input', () => {
    const input = p0Topology();
    const before = JSON.stringify(input);
    const out = migrateTopology(input);
    expect(out).not.toBe(input);
    expect(out.schema).toBe(TOPOLOGY_SCHEMA_ID_1_1);
    expect({ ...out, schema: TOPOLOGY_SCHEMA_ID_1_0 }).toEqual(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('a 1.1 document keeps its content in a new object', () => {
    const input = v11Topology();
    const out = migrateTopology(input);
    expect(out).not.toBe(input);
    expect(out).toEqual(input);
  });

  it('every non-latest id has one step and the steps reach the latest id', () => {
    for (const id of TOPOLOGY_SCHEMA_IDS) {
      let current = id;
      let hops = 0;
      while (current !== LATEST_TOPOLOGY_SCHEMA_ID) {
        const step = TOPOLOGY_MIGRATIONS[current];
        expect(step).toBeDefined();
        expect(step!.from).toBe(current);
        current = step!.to;
        hops++;
        expect(hops).toBeLessThanOrEqual(TOPOLOGY_SCHEMA_IDS.length);
      }
    }
    expect(TOPOLOGY_MIGRATIONS[LATEST_TOPOLOGY_SCHEMA_ID]).toBeUndefined();
  });

  it('rejects an unknown schema id with a readable message', () => {
    const bad = { ...p0Topology(), schema: 'netforge.topology/0.9' } as unknown as Topology;
    expect(() => migrateTopology(bad)).toThrow(/^Cannot migrate a topology with schema "netforge\.topology\/0\.9"; this build reads netforge\.topology\/1\.0, netforge\.topology\/1\.1, netforge\.topology\/1\.2$/);
    expect(isTopologySchemaId('netforge.topology/1.0')).toBe(true);
    expect(isTopologySchemaId('netforge.topology/2.0')).toBe(false);
    expect(isTopologySchemaId(11)).toBe(false);
  });
});

// ── per-version field sets ─────────────────────────────────────────────────

describe('parseTopology — schema versions', () => {
  it('reads a 1.1 document with every new section intact', () => {
    const t = v11Topology();
    expect(parseTopology(JSON.parse(JSON.stringify(t)))).toEqual(t);
  });

  it('reads a 1.0 document with the 1.0 field set (1.1 keys stripped, even invalid ones), without mutating it', () => {
    const j = JSON.parse(JSON.stringify({ ...v11Topology(), schema: TOPOLOGY_SCHEMA_ID_1_0 })) as Record<string, unknown>;
    (j['devices'] as Record<string, unknown>[])[1]!['hardware'] = { macSalt: -5 };
    (j['links'] as Record<string, unknown>[])[0]!['dce_end'] = 'z';
    j['canvas'] = { metresPerUnit: 0 };
    const before = JSON.stringify(j);
    const t = parseTopology(j);
    expect(JSON.stringify(j)).toBe(before);
    expect(t.schema).toBe(TOPOLOGY_SCHEMA_ID_1_0);
    expect('canvas' in t).toBe(false);
    expect('lab' in t).toBe(false);
    for (const d of t.devices) {
      expect('modules' in d).toBe(false);
      expect('hardware' in d).toBe(false);
      expect('ui' in d).toBe(false);
    }
    for (const l of t.links) {
      expect('kind' in l).toBe(false);
      expect('dce_end' in l).toBe(false);
      expect('distance_m' in l).toBe(false);
    }
    expect(t.devices[0]!.power).toBe(false);
    expect(t.links[0]!.length_m).toBe(2);
  });

  it('keeps stripping unknown keys inside the 1.1 sections', () => {
    const j = JSON.parse(JSON.stringify(v11Topology())) as { devices: Record<string, unknown>[]; lab: Record<string, unknown> };
    (j.devices[0]!['ui'] as Record<string, unknown>)['secret'] = 'x';
    (j.devices[0]!['hardware'] as Record<string, unknown>)['macBase'] = 1;
    j.lab['extra'] = true;
    const t = parseTopology(j);
    expect('secret' in t.devices[0]!.ui!).toBe(false);
    expect(t.devices[0]!.hardware).toEqual({ macSalt: 2 });
    expect(t.lab).toEqual({ name: 'ccna1-serial', version: 3 });
  });
});

// ── 1.1 limits ─────────────────────────────────────────────────────────────

describe('validateTopology — 1.1 limits', () => {
  const errorsOf = (mutate: (j: { devices: Record<string, unknown>[]; links: Record<string, unknown>[] } & Record<string, unknown>) => void): string[] => {
    const j = JSON.parse(JSON.stringify(v11Topology())) as { devices: Record<string, unknown>[]; links: Record<string, unknown>[] } & Record<string, unknown>;
    mutate(j);
    const r = validateTopology(j);
    return r.ok ? [] : r.errors;
  };

  it('modules: at most MAX_MODULES_PER_DEVICE, one per slot, non-empty ids', () => {
    expect(errorsOf((j) => {
      j.devices[0]!['modules'] = Array.from({ length: MAX_MODULES_PER_DEVICE + 1 }, (_, i) => ({ slot: `s${i}`, module: 'mod.ehwic-2t' }));
    })).toContain(`devices[0].modules: at most ${MAX_MODULES_PER_DEVICE} modules are allowed`);
    expect(errorsOf((j) => {
      j.devices[0]!['modules'] = [{ slot: '0/0', module: 'mod.ehwic-2t' }, { slot: '0/0', module: 'mod.nim-2t' }];
    })).toEqual(['devices[0].modules[1].slot: slot "0/0" is listed more than once']);
    expect(errorsOf((j) => {
      j.devices[0]!['modules'] = [{ slot: '', module: 'mod.ehwic-2t' }];
    })).toEqual(['devices[0].modules[0].slot: must not be empty']);
  });

  it('hardware.macSalt: integer between 0 and MAX_MAC_SALT', () => {
    expect(errorsOf((j) => { j.devices[0]!['hardware'] = { macSalt: -1 }; })).toEqual([`devices[0].hardware.macSalt: must be between 0 and ${MAX_MAC_SALT}`]);
    expect(errorsOf((j) => { j.devices[0]!['hardware'] = { macSalt: MAX_MAC_SALT + 1 }; })).toEqual([`devices[0].hardware.macSalt: must be between 0 and ${MAX_MAC_SALT}`]);
    expect(errorsOf((j) => { j.devices[0]!['hardware'] = { macSalt: 1.5 }; })).toEqual(['devices[0].hardware.macSalt: must be an integer (got float)']);
    expect(errorsOf((j) => { j.devices[0]!['hardware'] = { macSalt: MAX_MAC_SALT }; })).toEqual([]);
  });

  it('ui: url and history bounds, and the total JSON size cap', () => {
    expect(errorsOf((j) => {
      j.devices[0]!['ui'] = { desktop: { browserHistory: Array.from({ length: MAX_UI_HISTORY + 1 }, () => 'http://a/') } };
    })).toEqual([`devices[0].ui.desktop.browserHistory: at most ${MAX_UI_HISTORY} entries are allowed`]);
    expect(errorsOf((j) => {
      j.devices[0]!['ui'] = { desktop: { browserUrl: 'h'.repeat(MAX_UI_URL_CHARS + 1) } };
    })).toEqual([`devices[0].ui.desktop.browserUrl: must be at most ${MAX_UI_URL_CHARS} characters`]);
    const big = errorsOf((j) => { j.devices[0]!['ui'] = { note: 'n'.repeat(MAX_UI_JSON_CHARS) }; });
    expect(big).toHaveLength(1);
    expect(big[0]).toMatch(new RegExp(`^devices\\[0\\]\\.ui: must serialise to at most ${MAX_UI_JSON_CHARS} characters \\(got \\d+\\)$`));
  });

  it('canvas.metresPerUnit in (0, MAX_METRES_PER_UNIT]', () => {
    const msg = `canvas.metresPerUnit: must be greater than 0 and at most ${MAX_METRES_PER_UNIT}`;
    expect(errorsOf((j) => { j['canvas'] = { metresPerUnit: 0 }; })).toEqual([msg]);
    expect(errorsOf((j) => { j['canvas'] = { metresPerUnit: MAX_METRES_PER_UNIT + 0.5 }; })).toEqual([msg]);
    expect(errorsOf((j) => { j['canvas'] = { metresPerUnit: MAX_METRES_PER_UNIT }; })).toEqual([]);
    expect(errorsOf((j) => { j['canvas'] = {}; })).toEqual(['canvas.metresPerUnit: is required']);
  });

  it('link kind, dce_end and distance_m', () => {
    expect(errorsOf((j) => { j.links[0]!['kind'] = 'laser'; })).toEqual(['links[0].kind: must be one of cable, radio']);
    expect(errorsOf((j) => { j.links[0]!['dce_end'] = 'c'; })).toEqual(['links[0].dce_end: must be "a" or "b"']);
    expect(errorsOf((j) => { j.links[1]!['distance_m'] = MAX_DISTANCE_M + 1; })).toEqual([`links[1].distance_m: must be at most ${MAX_DISTANCE_M}`]);
    expect(errorsOf((j) => { j.links[1]!['distance_m'] = -1; })).toEqual(['links[1].distance_m: must be >= 0']);
  });

  it('MAX_LENGTH_M applies to cables; radio links are exempt', () => {
    expect(errorsOf((j) => { j.links[0]!['length_m'] = MAX_LENGTH_M + 1; })).toEqual([`links[0].length_m: must be at most ${MAX_LENGTH_M}`]);
    expect(errorsOf((j) => { j.links[1]!['length_m'] = MAX_LENGTH_M + 1; })).toEqual([]);
    expect(errorsOf((j) => { j.links[0]!['length_m'] = -1; })).toEqual(['links[0].length_m: must be >= 0']);
  });

  it('lab name and version', () => {
    expect(errorsOf((j) => { j['lab'] = { name: '', version: 1 }; })).toEqual(['lab.name: must not be empty']);
    expect(errorsOf((j) => { j['lab'] = { name: 'x', version: 0 }; })).toEqual(['lab.version: must be between 1 and 1000000']);
    expect(errorsOf((j) => { j['lab'] = { name: 'x', version: 1.5 }; })).toEqual(['lab.version: must be an integer (got float)']);
  });
});

// ── catalog-aware validation ───────────────────────────────────────────────

describe('validateTopologyAgainstCatalog', () => {
  for (const withResolver of [false, true]) {
    const label = withResolver ? 'with a fake resolvePort' : 'with the catalog name resolver';

    it(`accepts a valid 1.1 topology, resolving short and module port names (${label})`, () => {
      expect(validateTopologyAgainstCatalog(v11Topology(), testCatalog(withResolver))).toEqual([]);
    });

    it(`default modules apply only when modules is absent; [] is an empty chassis (${label})`, () => {
      const c = testCatalog(withResolver);
      const t = v11Topology();
      // d_r2 has no modules → default EHWIC-2T in slot 0/1 → Serial0/1/0 exists but Serial0/0/0 does not.
      t.links[0]!.b.port = 'Serial0/0/1';
      expect(messages(t, c)).toEqual(['Link "l_s": Device "R2" (d_r2) has no port named "Serial0/0/1"']);
      // d_r1 lists slot 0/0 only → the default module of 0/1 is not installed.
      const u = v11Topology();
      u.links[0]!.a.port = 'Serial0/1/0';
      expect(messages(u, c)).toEqual(['Link "l_s": Device "R1" (d_r1) has no port named "Serial0/1/0"']);
      const v = v11Topology();
      v.devices[1]!.modules = [];
      expect(messages(v, c)).toEqual(['Link "l_s": Device "R2" (d_r2) has no port named "Se0/1/0"']);
    });

    it(`reports unknown types, slots, modules and misfits with HARDWARE_MESSAGES wording (${label})`, () => {
      const t = v11Topology();
      t.devices.push({ id: 'd_x', type: 'router.nf9999', name: 'X', position: { logical: [0, 0] } });
      t.links.push({ id: 'l_x', a: { device: 'd_x', port: 'Gi0/0' }, b: { device: 'd_r1', port: 'Console' }, media: 'console' });
      t.devices[0]!.modules = [
        { slot: '0/0', module: 'mod.ehwic-2t' },
        { slot: '9/9', module: 'mod.ehwic-2t' },
        { slot: '0/1', module: 'mod.nim-2t' },
      ];
      t.devices[1]!.modules = [{ slot: '0/1', module: 'mod.flux-capacitor' }];
      t.links[0]!.b.port = 'Gi0/0';
      t.links[1]!.b.port = 'Console';
      const problems = validateTopologyAgainstCatalog(t, testCatalog(withResolver));
      expect(problems).toEqual([
        { device: 'd_r1', message: 'Device "R1" (d_r1): NF-TEST-RTR has no slot 9/9.' },
        { device: 'd_r1', message: 'Device "R1" (d_r1): NF-NIM-2T does not fit a ehwic slot.' },
        { device: 'd_r2', message: 'Device "R2" (d_r2): There is no module called mod.flux-capacitor in the catalog.' },
        { device: 'd_x', message: 'Device "X" (d_x) has type "router.nf9999", which this build\'s catalog does not contain' },
      ]);
    });

    it(`catches one port used twice through different spellings, and self-loops (${label})`, () => {
      const c = testCatalog(withResolver);
      const t = v11Topology();
      t.links[1]!.a.port = 'gi0/0';
      t.links.push({ id: 'l_dup', a: { device: 'd_r1', port: 'GigabitEthernet0/0' }, b: { device: 'd_r2', port: 'Con' }, media: 'console' });
      expect(validateTopologyAgainstCatalog(t, c)).toEqual([
        { device: 'd_r1', link: 'l_dup', message: 'Link "l_dup": Device "R1" (d_r1) port GigabitEthernet0/0 is already used by link "l_r"' },
      ]);
      const u = v11Topology();
      u.links[1]!.b = { device: 'd_r1', port: 'Gi0/0' };
      u.links[1]!.a = { device: 'd_r1', port: 'GigabitEthernet0/0' };
      expect(messages(u, c)).toEqual(['Link "l_r" connects Device "R1" (d_r1) port GigabitEthernet0/0 to itself']);
    });

    it(`refuses a virtual interface as a link endpoint (${label})`, () => {
      const t: Topology = {
        schema: TOPOLOGY_SCHEMA_ID_1_1,
        seed: 1,
        devices: [
          { id: 'h1', type: 'wrouter.nftest', name: 'Home', position: { logical: [0, 0] } },
          { id: 'r1', type: 'router.nftest', name: 'R1', position: { logical: [1, 0] } },
        ],
        links: [{ id: 'l1', a: { device: 'h1', port: 'Vlan1' }, b: { device: 'r1', port: 'Gi0/0' }, media: 'auto' }],
      };
      // resolvePort finds the fixed Vlan1 as 'existing'; its svi role is virtual, so both paths refuse it the same way.
      expect(messages(t, testCatalog(withResolver))).toEqual([
        'Link "l1": Device "Home" (h1): Vlan1 is a virtual interface and cannot terminate a link',
      ]);
    });
  }

  it('reports resolvePort ambiguity and creatable virtual names', () => {
    const t = v11Topology();
    t.links[1]!.a.port = 'ambig0';
    t.links[1]!.b.port = 'Loopback0';
    expect(messages(t, testCatalog(true))).toEqual([
      'Link "l_r": Device "R1" (d_r1): port name "ambig0" is ambiguous (GigabitEthernet0/0, Console)',
      'Link "l_r": Device "R2" (d_r2): Loopback0 is a virtual interface and cannot terminate a link',
    ]);
  });

  it('accepts a P0 topology against the P0 catalog (short names resolve)', () => {
    expect(validateTopologyAgainstCatalog(p0Topology(), createCatalog({}))).toEqual([]);
    const t = p0Topology();
    t.links[0]!.b.port = 'Fa0/99';
    expect(messages(t, createCatalog({}))).toEqual(['Link "l_0001": Device "SW1" (d_0002) has no port named "Fa0/99"']);
  });
});

// ── atomic load gate ───────────────────────────────────────────────────────

describe('prepareTopologyLoad', () => {
  it('parses, migrates to the latest id and validates; the input is untouched', () => {
    const json = JSON.parse(JSON.stringify(p0Topology())) as unknown;
    const before = JSON.stringify(json);
    const t = prepareTopologyLoad(json, createCatalog({}));
    expect(t.schema).toBe(LATEST_TOPOLOGY_SCHEMA_ID);
    expect({ ...t, schema: TOPOLOGY_SCHEMA_ID_1_0 }).toEqual(p0Topology());
    expect(JSON.stringify(json)).toBe(before);
  });

  it('turns schema issues into a TopologyLoadError with device and link ids', () => {
    const j = JSON.parse(JSON.stringify(v11Topology())) as { devices: Record<string, unknown>[]; links: Record<string, unknown>[] };
    j.devices[1]!['hardware'] = { macSalt: -1 };
    j.links[1]!['media'] = 'wet-string';
    let error: unknown;
    try {
      prepareTopologyLoad(j, testCatalog(true));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TopologyLoadError);
    const le = error as TopologyLoadError;
    expect(le.name).toBe('TopologyLoadError');
    expect(le.problems).toHaveLength(2);
    expect(le.problems[0]).toEqual({ device: 'd_r2', message: `devices[1].hardware.macSalt: must be between 0 and ${MAX_MAC_SALT}` });
    expect(le.problems[1]!.link).toBe('l_r');
    expect(le.problems[1]!.message).toMatch(/^links\[1\]\.media: must be one of /);
    expect(le.message).toMatch(/^Invalid topology: 2 issues\n  - devices\[1\]\.hardware\.macSalt: /);
  });

  it('turns catalog problems into a TopologyLoadError', () => {
    const t = v11Topology();
    t.devices[0]!.type = 'router.gone';
    expect(() => prepareTopologyLoad(t, testCatalog(false))).toThrow(TopologyLoadError);
    try {
      prepareTopologyLoad(t, testCatalog(false));
    } catch (e) {
      const le = e as TopologyLoadError;
      expect(le.problems).toEqual([{ device: 'd_r1', message: 'Device "R1" (d_r1) has type "router.gone", which this build\'s catalog does not contain' }]);
      expect(le.message).toBe('Invalid topology: 1 issue\n  - Device "R1" (d_r1) has type "router.gone", which this build\'s catalog does not contain');
    }
  });

  it('topologyLoadError truncates long problem lists like parseTopology', () => {
    const problems = Array.from({ length: 8 }, (_, i) => ({ message: `problem ${i}` }));
    const e = topologyLoadError(problems);
    expect(e.problems).toBe(problems);
    expect(e.message.split('\n')).toEqual(['Invalid topology: 8 issues', '  - problem 0', '  - problem 1', '  - problem 2', '  - problem 3', '  - problem 4', '  ... and 3 more']);
  });
});

// ── save whitelists ────────────────────────────────────────────────────────

describe('netforge-file whitelists (1.1 sections)', () => {
  const manifest = { format: 1 as const, app: 'netforge/0.0.1', created: '2026-09-14T10:00:00.000Z', modified: '2026-09-14T10:00:00.000Z' };

  it('topologyToJson writes the 1.1 keys after every P0 key and reads them back', () => {
    const t = v11Topology();
    const text = topologyToJson(t);
    const doc = JSON.parse(text) as { devices: Record<string, unknown>[]; links: Record<string, unknown>[] } & Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(['schema', 'seed', 'devices', 'links', 'canvas', 'lab']);
    expect(Object.keys(doc.devices[0]!)).toEqual(['id', 'type', 'name', 'position', 'power', 'modules', 'hardware', 'ui']);
    expect(Object.keys(doc.links[0]!)).toEqual(['id', 'a', 'b', 'media', 'length_m', 'kind', 'dce_end']);
    expect(Object.keys(doc.links[1]!)).toEqual(['id', 'a', 'b', 'media', 'kind', 'distance_m']);
    expect(topologyFromJson(text)).toEqual(t);
  });

  it('a P0-shaped document serialises exactly as before apart from the schema id', () => {
    const t = p0Topology(TOPOLOGY_SCHEMA_ID_1_1);
    const doc = JSON.parse(topologyToJson(t)) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(['schema', 'seed', 'devices', 'links', 'objectives', 'notes']);
    expect(topologyToJson(t)).toBe(topologyToJson(p0Topology(TOPOLOGY_SCHEMA_ID_1_0)).replace('netforge.topology/1.0', 'netforge.topology/1.1'));
  });

  it('drops a hardware block without macSalt and keys outside the whitelists', () => {
    const t = v11Topology();
    t.devices[1]!.hardware = {};
    (t.devices[0]!.ui as Record<string, unknown>)['transient'] = { open: true };
    const doc = JSON.parse(topologyToJson(t)) as { devices: Record<string, unknown>[] };
    expect('hardware' in doc.devices[1]!).toBe(false);
    expect(Object.keys(doc.devices[0]!['ui'] as Record<string, unknown>)).toEqual(['desktop', 'note']);
  });

  it('.netforge round-trips every 1.1 section byte-identically', () => {
    const project = { manifest, topology: v11Topology(), configs: {} };
    const bytes = writeNetforge(project);
    const back = readNetforge(bytes);
    expect(back.topology).toEqual(v11Topology());
    expect(Buffer.from(writeNetforge({ ...back, readme: undefined })).equals(Buffer.from(bytes))).toBe(true);
  });

  it('writers never migrate: a 1.0 document keeps its id and loses no P0 field', () => {
    const back = readNetforge(writeNetforge({ manifest, topology: p0Topology(), configs: {} }));
    expect(back.topology.schema).toBe(TOPOLOGY_SCHEMA_ID_1_0);
    expect(back.topology).toEqual(p0Topology());
  });
});
