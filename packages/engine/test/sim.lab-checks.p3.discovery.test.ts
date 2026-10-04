/**
 * sim.lab-checks.p3.discovery — the disc area's checker adapter (ARCHITECTURE-P3 D5, §2.10, §3.6, §5.5; §7 W3 disc:
 * sim/lab-checks/discovery.ts), against fakes: a hand-built device with a real running configuration and fake tables,
 * the readers and sources called directly, and through the W1 frameworks (`checkNeighbor`, `checkFact`) for the
 * details a learner sees. Pinned:
 *   • NEIGHBOR_SOURCES cdp / lldp read `cdp-neighbours` / `lldp-neighbours` (rule 20): the local port, every identity the
 *     row names, the label; no state word; undefined (does not run) without the table or while the protocol is off;
 *   • cdp.enabled / lldp.enabled (configuration, plus the profile for CDP's default), device-wide and per interface,
 *     each with a wrong answer, and an unknown interface failing with the usual detail.
 */
import { describe, expect, it } from 'vitest';
import type { DefaultsProfile, PortRole } from '../src/contracts/catalog.js';
import type { ConfigAst } from '../src/contracts/config.js';
import type { DeviceRuntime, PortResolution } from '../src/contracts/device.js';
import type { PortKind, PortState } from '../src/contracts/port.js';
import type { LabAssertion, LabFactName, NeighborProtocol } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { TABLE_DESCRIPTORS, type CdpNeighbourRow, type LldpNeighbourRow, type Table, type TableName, type TableRow } from '../src/contracts/tables.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import { DISCOVERY_FACT_READERS, DISCOVERY_NEIGHBOR_SOURCES } from '../src/sim/lab-checks/discovery.js';
import { FACT_READERS, IDENTITY_SOURCES, checkFact, checkNeighbor, type FactReader, type FactReading, type IdentitySource, type IdentitySourceName, type NeighborSource } from '../src/sim/lab-checks/facts.js';

// ── fakes ────────────────────────────────────────────────────────────────────

interface FakePort {
  readonly id: string;
  readonly short: string;
  readonly kind?: PortKind;
  readonly role?: PortRole;
  readonly ipv4?: string;
  readonly mac?: string;
}

interface FakeDeviceInput {
  readonly name: string;
  readonly profile?: DefaultsProfile;
  readonly cdpDefault?: boolean;
  readonly ports?: readonly FakePort[];
  /** Tables the model keeps, with their rows (a name absent here is a table the model does not keep). */
  readonly tables?: Readonly<Record<string, readonly TableRow[]>>;
  /** Lines applied to the running configuration: [context, tokens, negate]. */
  readonly lines?: readonly (readonly [readonly (readonly string[])[], readonly string[], boolean])[];
  readonly macBase?: number;
}

function fakeTable(name: string, rows: readonly TableRow[]): Table<TableRow> {
  return {
    name,
    device: 'dev',
    size: rows.length,
    get: (key: string) => rows.find((r) => r.key === key),
    has: (key: string) => rows.some((r) => r.key === key),
    rows: () => rows.slice(),
    find: (pred: (r: TableRow) => boolean) => rows.filter(pred),
  } as unknown as Table<TableRow>;
}

function fakeDevice(input: FakeDeviceInput): DeviceRuntime {
  const running: ConfigAst = createConfigAst();
  for (const [context, tokens, negate] of input.lines ?? []) running.apply(context.map((c) => c.slice()), tokens.slice(), negate);
  const ports = new Map<string, PortState>();
  for (const p of input.ports ?? []) {
    ports.set(p.id, {
      id: p.id,
      spec: { name: p.id, short: p.short, kind: p.kind ?? 'ethernet', role: p.role ?? 'routed' },
      role: p.role ?? 'routed',
      mac: p.mac ?? '02:00:00:00:00:99',
      l3: p.ipv4 === undefined ? {} : { ipv4: { address: p.ipv4, prefixLen: 24 } },
    } as unknown as PortState);
  }
  const tables = new Map<string, Table<TableRow>>();
  for (const [name, rows] of Object.entries(input.tables ?? {})) tables.set(name, fakeTable(name, rows));
  const dev = {
    id: input.name.toLowerCase(),
    spec: { id: input.name.toLowerCase(), type: 'fake', name: input.name },
    hostname: input.name,
    model: { cdpDefault: input.cdpDefault ?? true, capabilities: [] },
    profile: input.profile ?? 'P3',
    macBase: input.macBase ?? 0x123456,
    running,
    ports,
    tables: { get: (name: TableName) => tables.get(name) },
    port: (id: string) => ports.get(id),
    portView: (id: string) => ports.get(id),
    resolvePortName(name: string): PortResolution {
      for (const p of ports.values()) if (p.id.toLowerCase() === name.toLowerCase() || p.spec.short.toLowerCase() === name.toLowerCase()) return { kind: 'existing', port: p.id };
      return { kind: 'unknown' };
    },
  };
  return dev as unknown as DeviceRuntime;
}

const fakeSim = (...devices: DeviceRuntime[]): Simulation => ({ devices: () => devices }) as unknown as Simulation;

const IF = (id: string): string[][] => [['interface', id]];
const GI1 = 'GigabitEthernet0/1';
const GI2 = 'GigabitEthernet0/2';
const FA1 = 'FastEthernet0/1';
const SE0 = 'Serial0/0/0';
const VLAN1 = 'Vlan1';

const SW1_PORTS: readonly FakePort[] = [
  { id: FA1, short: 'Fa0/1', role: 'switched' },
  { id: GI1, short: 'Gi0/1', role: 'switched' },
  { id: GI2, short: 'Gi0/2', role: 'switched' },
  { id: VLAN1, short: 'Vl1', kind: 'virtual', role: 'svi', ipv4: '10.0.0.2' },
];

const R1 = (): DeviceRuntime =>
  fakeDevice({ name: 'R1', ports: [{ id: 'GigabitEthernet0/0', short: 'Gi0/0', ipv4: '10.0.12.1', mac: '02:00:00:00:11:01' }], macBase: 0x110000 });
const SW2 = (): DeviceRuntime => fakeDevice({ name: 'SW2', ports: [{ id: GI1, short: 'Gi0/1', role: 'switched', mac: '02:00:00:00:22:01' }], macBase: 0x220000 });

const cdpRow = (localPort: string, deviceId: string, addresses: string): CdpNeighbourRow => ({
  key: `${localPort}|${deviceId}`,
  updatedAt: 0,
  expiresAt: 180_000_000_000,
  localPort,
  deviceId,
  remotePort: 'GigabitEthernet0/0',
  platform: 'NF-2911',
  capabilities: 'R',
  addresses,
  version: 'text',
  holdtimeS: 180,
  cdpVersion: 2,
});

const lldpRow = (localPort: string, chassisId: string, systemName?: string, mgmtAddress?: string): LldpNeighbourRow => {
  const r: LldpNeighbourRow = { key: `${localPort}|${chassisId}|GigabitEthernet0/1`, updatedAt: 0, localPort, chassisId, portId: 'GigabitEthernet0/1', ttlS: 120 };
  if (systemName !== undefined) r.systemName = systemName;
  if (mgmtAddress !== undefined) r.mgmtAddress = mgmtAddress;
  return r;
};

/** SW1 with its CDP rows (R1 on Gi0/1 by name and address, SW2 on Gi0/2) and its LLDP rows. */
function sw1(over: Partial<FakeDeviceInput> = {}): DeviceRuntime {
  return fakeDevice({
    name: 'SW1',
    ports: SW1_PORTS,
    tables: {
      'cdp-neighbours': [cdpRow(GI1, 'R1', '10.0.12.1'), cdpRow(GI2, 'SW2', '')],
      'lldp-neighbours': [lldpRow(GI1, '02:00:00:00:11:01', 'R1', '10.0.12.1'), lldpRow(GI2, '0200.0000.2201')],
    },
    ...over,
  });
}

const sources = (): { readonly [P in NeighborProtocol]: NeighborSource | undefined } => ({
  ospf: undefined,
  ppp: undefined,
  eigrp: undefined,
  cdp: DISCOVERY_NEIGHBOR_SOURCES.cdp,
  lldp: DISCOVERY_NEIGHBOR_SOURCES.lldp,
});

/** A reader table holding only this area's readers (every other fact unavailable). */
function readers(): { readonly [F in LabFactName]: FactReader | undefined } {
  const none = Object.fromEntries(Object.keys(FACT_READERS).map((k) => [k, undefined]));
  return { ...none, ...DISCOVERY_FACT_READERS } as { readonly [F in LabFactName]: FactReader | undefined };
}

/** The identities every device has (name, addresses, MACs), without the router ids other areas add. */
function identities(): { readonly [N in IdentitySourceName]: IdentitySource | undefined } {
  return { name: IDENTITY_SOURCES.name, address: IDENTITY_SOURCES.address, mac: IDENTITY_SOURCES.mac, ospf: undefined, eigrp: undefined };
}

type NeighborA = Extract<LabAssertion, { kind: 'neighbor' }>;
type FactA = Extract<LabAssertion, { kind: 'fact' }>;
const neighbor = (sim: Simulation, a: Omit<NeighborA, 'kind'>): string | undefined => {
  const r = checkNeighbor(sim, { kind: 'neighbor', ...a }, sources(), identities());
  return r.pass ? undefined : (r.detail ?? '(no detail)');
};
const fact = (sim: Simulation, a: Omit<FactA, 'kind'>): string | undefined => {
  const r = checkFact(sim, { kind: 'fact', ...a }, readers(), identities());
  return r.pass ? undefined : (r.detail ?? '(no detail)');
};

const read = (name: 'cdp.enabled' | 'lldp.enabled', dev: DeviceRuntime, subject?: string): FactReading =>
  DISCOVERY_FACT_READERS[name]!.read({ sim: fakeSim(dev), dev, subject });

// ── neighbours ───────────────────────────────────────────────────────────────

describe('NEIGHBOR_SOURCES.cdp (cdp-neighbours)', () => {
  it('names its table and reads each row: local port, device id and addresses, labelled by the device id, no state', () => {
    const src = DISCOVERY_NEIGHBOR_SOURCES.cdp!;
    expect(src.table).toBe('cdp-neighbours');
    expect(src.read(sw1())).toEqual([
      { iface: GI1, peer: ['R1', '10.0.12.1'], label: 'R1' },
      { iface: GI2, peer: ['SW2'], label: 'SW2' },
    ]);
    const multi = fakeDevice({ name: 'X', tables: { 'cdp-neighbours': [cdpRow(GI1, 'R9', '10.0.0.9, 192.168.9.1,')] } });
    expect(src.read(multi)).toEqual([{ iface: GI1, peer: ['R9', '10.0.0.9', '192.168.9.1'], label: 'R9' }]);
  });

  it('a device that keeps no table, or on which CDP does not run, has no CDP neighbours', () => {
    const src = DISCOVERY_NEIGHBOR_SOURCES.cdp!;
    expect(src.read(fakeDevice({ name: 'PC1' }))).toBeUndefined();
    expect(src.read(sw1({ lines: [[[], ['cdp', 'run'], true]] }))).toBeUndefined(); // no cdp run
    expect(src.read(sw1({ profile: 'P2' }))).toBeUndefined(); // off by default before P3
    expect(src.read(sw1({ cdpDefault: false }))).toBeUndefined();
    expect(src.read(sw1({ profile: 'P1', lines: [[[], ['cdp', 'run'], false]] }))?.length).toBe(2); // typed in any profile
  });

  it('through the neighbor kind: the right neighbour passes, a wrong one fails with its detail', () => {
    const sim = fakeSim(sw1(), R1(), SW2());
    expect(neighbor(sim, { device: 'SW1', protocol: 'cdp', neighbor: 'R1', iface: 'Gi0/1' })).toBeUndefined();
    expect(neighbor(sim, { device: 'SW1', protocol: 'cdp', neighbor: 'SW2' })).toBeUndefined();
    expect(neighbor(sim, { device: 'SW1', protocol: 'cdp', count: 2 })).toBeUndefined();
    expect(neighbor(sim, { device: 'SW1', protocol: 'cdp', neighbor: 'R1', iface: 'Gi0/2' })).toBe('SW1 has no CDP neighbour R1 on Gi0/2.');
    expect(neighbor(sim, { device: 'SW1', protocol: 'cdp', neighbor: 'SW2', exists: false })).toBe('SW1 still has CDP neighbour SW2 (SW2 on Gi0/2).');
    const off = fakeSim(sw1({ lines: [[[], ['cdp', 'run'], true]] }), R1());
    expect(neighbor(off, { device: 'SW1', protocol: 'cdp', neighbor: 'R1' })).toBe('SW1 does not run CDP.');
  });
});

describe('NEIGHBOR_SOURCES.lldp (lldp-neighbours)', () => {
  const on: FakeDeviceInput['lines'] = [[[], ['lldp', 'run'], false]];

  it('names its table and reads each row: chassis id, system name and management address, labelled by the name', () => {
    const src = DISCOVERY_NEIGHBOR_SOURCES.lldp!;
    expect(src.table).toBe('lldp-neighbours');
    expect(src.read(sw1({ lines: on }))).toEqual([
      { iface: GI1, peer: ['02:00:00:00:11:01', 'R1', '10.0.12.1'], label: 'R1' },
      { iface: GI2, peer: ['0200.0000.2201'], label: '0200.0000.2201' },
    ]);
  });

  it('LLDP is off by default everywhere: no lldp run → it does not run', () => {
    expect(DISCOVERY_NEIGHBOR_SOURCES.lldp!.read(sw1())).toBeUndefined();
    expect(DISCOVERY_NEIGHBOR_SOURCES.lldp!.read(fakeDevice({ name: 'PC1', lines: on }))).toBeUndefined();
  });

  it('through the neighbor kind: a neighbour named only by its chassis MAC is found by device name', () => {
    const sim = fakeSim(sw1({ lines: on }), R1(), SW2());
    expect(neighbor(sim, { device: 'SW1', protocol: 'lldp', neighbor: 'SW2', iface: 'Gi0/2' })).toBeUndefined();
    expect(neighbor(sim, { device: 'SW1', protocol: 'lldp', neighbor: 'R1' })).toBeUndefined();
    expect(neighbor(sim, { device: 'SW1', protocol: 'lldp', neighbor: 'SW2', iface: 'Gi0/1' })).toBe('SW1 has no LLDP neighbour SW2 on Gi0/1.');
    expect(neighbor(fakeSim(sw1(), R1()), { device: 'SW1', protocol: 'lldp' })).toBe('SW1 does not run LLDP.');
  });
});

// ── facts ────────────────────────────────────────────────────────────────────

describe('the readers name their source (rule 20)', () => {
  it('cdp.enabled and lldp.enabled are booleans read from the configuration', () => {
    expect(DISCOVERY_FACT_READERS['cdp.enabled']).toMatchObject({ type: 'boolean', source: 'configuration' });
    expect(DISCOVERY_FACT_READERS['lldp.enabled']).toMatchObject({ type: 'boolean', source: 'configuration' });
    expect(Object.keys(DISCOVERY_FACT_READERS).sort()).toEqual(['cdp.enabled', 'lldp.enabled']);
    for (const s of Object.values(DISCOVERY_NEIGHBOR_SOURCES)) expect(Object.keys(TABLE_DESCRIPTORS)).toContain(s!.table);
  });
});

describe('cdp.enabled (configuration + profile; subject: optional interface)', () => {
  it('device-wide: on by default in a P3 world on a cdpDefault model; both stored forms win', () => {
    expect(read('cdp.enabled', sw1())).toEqual({ value: true });
    expect(read('cdp.enabled', sw1({ profile: 'P2' }))).toEqual({ value: false });
    expect(read('cdp.enabled', sw1({ cdpDefault: false }))).toEqual({ value: false });
    expect(read('cdp.enabled', sw1({ lines: [[[], ['cdp', 'run'], true]] }))).toEqual({ value: false });
    expect(read('cdp.enabled', sw1({ profile: 'P1', lines: [[[], ['cdp', 'run'], false]] }))).toEqual({ value: true });
  });

  it('per interface: no cdp enable turns one port off; a port that takes no part (serial, SVI) reads false', () => {
    const hardened = sw1({ ports: [...SW1_PORTS, { id: SE0, short: 'Se0/0/0', kind: 'serial', role: 'wan' }], lines: [[IF(FA1), ['cdp', 'enable'], true]] });
    expect(read('cdp.enabled', hardened, 'Fa0/1')).toEqual({ value: false });
    expect(read('cdp.enabled', hardened, FA1)).toEqual({ value: false });
    expect(read('cdp.enabled', hardened, 'Gi0/1')).toEqual({ value: true });
    expect(read('cdp.enabled', hardened, 'Se0/0/0')).toEqual({ value: false });
    expect(read('cdp.enabled', hardened, 'Vl1')).toEqual({ value: false });
    expect(read('cdp.enabled', sw1({ lines: [[[], ['cdp', 'run'], true]] }), 'Gi0/1')).toEqual({ value: false }); // CDP off
  });

  it('an interface the device does not have fails with the usual detail', () => {
    expect(read('cdp.enabled', sw1(), 'Gi0/9')).toEqual({ problem: 'SW1 has no interface called Gi0/9.' });
  });

  it('wrong answers fail with what was found', () => {
    const sim = fakeSim(sw1(), R1());
    expect(fact(sim, { device: 'SW1', fact: 'cdp.enabled', subject: 'Fa0/1', equals: false })).toBe('SW1 cdp.enabled of Fa0/1 is true, expected false.');
    expect(fact(fakeSim(sw1({ profile: 'P2' })), { device: 'SW1', fact: 'cdp.enabled', equals: true })).toBe('SW1 cdp.enabled is false, expected true.');
    expect(fact(sim, { device: 'SW1', fact: 'cdp.enabled', subject: 'Gi0/9', equals: false })).toBe('SW1 has no interface called Gi0/9.');
  });
});

describe('lldp.enabled (configuration; subject: optional interface)', () => {
  const on: FakeDeviceInput['lines'] = [[[], ['lldp', 'run'], false]];

  it('device-wide: only a stored lldp run, in every profile', () => {
    expect(read('lldp.enabled', sw1())).toEqual({ value: false });
    expect(read('lldp.enabled', sw1({ lines: on }))).toEqual({ value: true });
    expect(read('lldp.enabled', sw1({ profile: 'P1', lines: on }))).toEqual({ value: true });
  });

  it('per interface: off only when both directions are off; a port that takes no part reads false', () => {
    const txOff = sw1({ lines: [...on!, [IF(FA1), ['lldp', 'transmit'], true]] });
    expect(read('lldp.enabled', txOff, 'Fa0/1')).toEqual({ value: true });
    const bothOff = sw1({ lines: [...on!, [IF(FA1), ['lldp', 'transmit'], true], [IF(FA1), ['lldp', 'receive'], true]] });
    expect(read('lldp.enabled', bothOff, 'Fa0/1')).toEqual({ value: false });
    expect(read('lldp.enabled', bothOff, 'Gi0/1')).toEqual({ value: true });
    expect(read('lldp.enabled', bothOff, 'Vl1')).toEqual({ value: false });
    expect(read('lldp.enabled', sw1(), 'Gi0/1')).toEqual({ value: false }); // LLDP not running
    expect(read('lldp.enabled', sw1({ lines: on }), 'Te1/0/1')).toEqual({ problem: 'SW1 has no interface called Te1/0/1.' });
  });

  it('wrong answers fail with what was found', () => {
    expect(fact(fakeSim(sw1()), { device: 'SW1', fact: 'lldp.enabled', equals: true })).toBe('SW1 lldp.enabled is false, expected true.');
    const txOff = sw1({ lines: [...on!, [IF(FA1), ['lldp', 'transmit'], true]] });
    expect(fact(fakeSim(txOff), { device: 'SW1', fact: 'lldp.enabled', subject: 'Fa0/1', equals: false })).toBe('SW1 lldp.enabled of Fa0/1 is true, expected false.');
  });
});
