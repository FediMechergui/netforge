/**
 * sim.lab-checks.p3.time — the svc area's checker adapter (ARCHITECTURE-P3 D5, D19, D20, §2.10, §3.7, §5.5, §5.7; §7 W3
 * svc: sim/lab-checks/time.ts with the approved [S24]/[S25] logging facts), against fakes: a hand-built device with fake
 * `ntp-peers` / `clock` tables and a real running configuration, the readers called directly, and through the W1
 * `checkFact` framework for the details a learner sees. Pinned, each with a wrong answer:
 *   • ntp.synced / ntp.peer from the sys-peer row of `ntp-peers` (ntp.peer compares against a device NAME through the
 *     identities); ntp.stratum, clock.source (without the row, the model's boot clock: 'host' on a host or server,
 *     else 'unset'; ruling R41) and clock.offsetMs from the `clock` row (rule 20: never the runtime's clock);
 *   • logging.buffered (the buffered level keyword; absent when buffering is off) and logging.trap (the trap level
 *     keyword, informational by default) from the configuration.
 */
import { describe, expect, it } from 'vitest';
import type { ConfigAst } from '../src/contracts/config.js';
import type { DeviceRuntime } from '../src/contracts/device.js';
import type { PortState } from '../src/contracts/port.js';
import type { LabAssertion, LabFactName } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { TABLE_DESCRIPTORS, type ClockRow, type NtpPeerRow, type Table, type TableName, type TableRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import { FACT_READERS, IDENTITY_SOURCES, checkFact, type FactReader, type FactReading, type IdentitySource, type IdentitySourceName } from '../src/sim/lab-checks/facts.js';
import { TIME_FACT_READERS } from '../src/sim/lab-checks/time.js';

// ── fakes ────────────────────────────────────────────────────────────────────

interface FakeDeviceInput {
  readonly name: string;
  readonly ipv4?: string;
  /** Tables the model keeps, with their rows (a name absent here is a table the model does not keep). */
  readonly tables?: Readonly<Record<string, readonly TableRow[]>>;
  /** Global lines applied to the running configuration: [tokens, negate]. */
  readonly lines?: readonly (readonly [readonly string[], boolean])[];
  /** Global lines stored as written (`no logging buffered`). */
  readonly stored?: readonly (readonly string[])[];
  /** The model's (expanded) capabilities; none by default. */
  readonly capabilities?: readonly string[];
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
  for (const [tokens, negate] of input.lines ?? []) running.apply([], tokens.slice(), negate);
  for (const tokens of input.stored ?? []) running.set([], tokens.slice());
  const ports = new Map<string, PortState>();
  if (input.ipv4 !== undefined) {
    ports.set('GigabitEthernet0/0', {
      id: 'GigabitEthernet0/0',
      spec: { name: 'GigabitEthernet0/0', short: 'Gi0/0', kind: 'ethernet', role: 'routed' },
      role: 'routed',
      mac: `02:00:00:00:00:${input.name.length.toString(16).padStart(2, '0')}`,
      l3: { ipv4: { address: input.ipv4, prefixLen: 24 } },
    } as unknown as PortState);
  }
  const tables = new Map<string, Table<TableRow>>();
  for (const [name, rows] of Object.entries(input.tables ?? {})) tables.set(name, fakeTable(name, rows));
  const dev = {
    id: input.name.toLowerCase(),
    spec: { id: input.name.toLowerCase(), type: 'fake', name: input.name },
    hostname: input.name,
    model: { capabilities: input.capabilities ?? [] },
    profile: 'P3',
    macBase: input.name.length * 0x1000,
    running,
    ports,
    tables: { get: (name: TableName) => tables.get(name) },
    port: (id: string) => ports.get(id),
    resolvePortName: () => ({ kind: 'unknown' }),
  };
  return dev as unknown as DeviceRuntime;
}

const fakeSim = (...devices: DeviceRuntime[]): Simulation => ({ devices: () => devices }) as unknown as Simulation;

function readers(): { readonly [F in LabFactName]: FactReader | undefined } {
  const none = Object.fromEntries(Object.keys(FACT_READERS).map((k) => [k, undefined]));
  return { ...none, ...TIME_FACT_READERS } as { readonly [F in LabFactName]: FactReader | undefined };
}

/** The identities every device has (name, addresses, MACs), without the router ids other areas add. */
function identities(): { readonly [N in IdentitySourceName]: IdentitySource | undefined } {
  return { name: IDENTITY_SOURCES.name, address: IDENTITY_SOURCES.address, mac: IDENTITY_SOURCES.mac, ospf: undefined, eigrp: undefined };
}

type FactA = Extract<LabAssertion, { kind: 'fact' }>;
const fact = (sim: Simulation, a: Omit<FactA, 'kind'>): string | undefined => {
  const r = checkFact(sim, { kind: 'fact', ...a }, readers(), identities());
  return r.pass ? undefined : (r.detail ?? '(no detail)');
};

type TimeFact = 'ntp.synced' | 'ntp.peer' | 'ntp.stratum' | 'clock.source' | 'clock.offsetMs' | 'logging.buffered' | 'logging.trap';
const read = (name: TimeFact, dev: DeviceRuntime, subject?: string): FactReading => TIME_FACT_READERS[name]!.read({ sim: fakeSim(dev), dev, subject });

const peerRow = (address: string, selected: NtpPeerRow['selected'], stratum = 1): NtpPeerRow => ({
  key: address,
  updatedAt: 70 * SEC,
  address,
  configured: true,
  refId: 'LOCL',
  stratum,
  lastRxAt: 70 * SEC,
  pollS: 64,
  reach: 1,
  selected,
});

const clockRow = (over: Partial<ClockRow>): ClockRow => ({
  key: 'clock',
  updatedAt: 70 * SEC,
  source: 'ntp',
  stratum: 2,
  reference: '10.0.0.10',
  offsetMs: -12,
  offsetSubMsNs: 250_000,
  since: 70 * SEC,
  ...over,
});

/** R1 synchronised to SRV1 (10.0.0.10) at stratum 2, with a second, rejected server. */
const r1Synced = (): DeviceRuntime =>
  fakeDevice({
    name: 'R1',
    ipv4: '10.0.0.1',
    tables: { 'ntp-peers': [peerRow('10.9.9.9', 'unreached'), peerRow('10.0.0.10', 'sys-peer')], clock: [clockRow({})] },
  });
/** R1 configured with a server it has not reached: an unset clock. */
const r1Unsynced = (): DeviceRuntime => fakeDevice({ name: 'R1', ipv4: '10.0.0.1', tables: { 'ntp-peers': [peerRow('10.0.0.10', 'candidate')], clock: [] } });
const srv1 = (): DeviceRuntime => fakeDevice({ name: 'SRV1', ipv4: '10.0.0.10', tables: { 'ntp-peers': [], clock: [clockRow({ source: 'master', stratum: 1, reference: 'LOCL', offsetMs: 0, offsetSubMsNs: 0 })] } });
const pc = (): DeviceRuntime => fakeDevice({ name: 'PC1', ipv4: '10.0.0.50' });

describe('the readers name their source (rule 20)', () => {
  it('each fact declares its type and its table column or the configuration', () => {
    expect(Object.fromEntries(Object.entries(TIME_FACT_READERS).map(([k, r]) => [k, `${r!.type} ${r!.source}`]))).toEqual({
      'ntp.synced': 'boolean ntp-peers.selected',
      'ntp.peer': 'address ntp-peers.address',
      'ntp.stratum': 'number clock.stratum',
      'clock.source': "string clock.source, else the model's boot clock (catalog)",
      'clock.offsetMs': 'number clock.offsetMs',
      'logging.buffered': 'string configuration',
      'logging.trap': 'string configuration',
    });
    for (const r of Object.values(TIME_FACT_READERS)) {
      const table = r!.source.split('.')[0]!;
      expect(r!.source === 'configuration' || table in TABLE_DESCRIPTORS).toBe(true);
    }
  });
});

describe('ntp.synced and ntp.peer (the sys-peer row of ntp-peers)', () => {
  it('a sys-peer row: synchronised, to that server', () => {
    expect(read('ntp.synced', r1Synced())).toEqual({ value: true });
    expect(read('ntp.peer', r1Synced())).toEqual({ value: '10.0.0.10' });
  });

  it('no sys-peer: not synchronised and no peer; an ntp master follows nobody; no table: no value', () => {
    expect(read('ntp.synced', r1Unsynced())).toEqual({ value: false });
    expect(read('ntp.peer', r1Unsynced())).toEqual({ value: undefined });
    expect(read('ntp.synced', srv1())).toEqual({ value: false });
    expect(read('ntp.synced', pc())).toEqual({ value: undefined });
    expect(read('ntp.peer', pc())).toEqual({ value: undefined });
  });

  it('through the fact kind: the peer is graded by device name or address; wrong answers name what was found', () => {
    const sim = fakeSim(r1Synced(), srv1(), pc());
    expect(fact(sim, { device: 'R1', fact: 'ntp.synced', equals: true })).toBeUndefined();
    expect(fact(sim, { device: 'R1', fact: 'ntp.peer', equals: 'SRV1' })).toBeUndefined();
    expect(fact(sim, { device: 'R1', fact: 'ntp.peer', equals: '10.0.0.10' })).toBeUndefined();
    expect(fact(sim, { device: 'R1', fact: 'ntp.peer', equals: 'PC1' })).toBe('R1 ntp.peer is 10.0.0.10, expected PC1.');
    const unsynced = fakeSim(r1Unsynced(), srv1());
    expect(fact(unsynced, { device: 'R1', fact: 'ntp.synced', equals: true })).toBe('R1 ntp.synced is false, expected true.');
    expect(fact(unsynced, { device: 'R1', fact: 'ntp.peer', equals: 'SRV1' })).toBe('R1 ntp.peer is not set, expected SRV1.');
    expect(fact(unsynced, { device: 'R1', fact: 'ntp.peer' })).toBe('R1 ntp.peer is not set.');
  });
});

describe('ntp.stratum, clock.source and clock.offsetMs (the clock row)', () => {
  it('read from the row', () => {
    expect(read('ntp.stratum', r1Synced())).toEqual({ value: 2 });
    expect(read('clock.source', r1Synced())).toEqual({ value: 'ntp' });
    expect(read('clock.offsetMs', r1Synced())).toEqual({ value: -12 });
    expect(read('ntp.stratum', srv1())).toEqual({ value: 1 });
    expect(read('clock.source', srv1())).toEqual({ value: 'master' });
    const userSet = fakeDevice({ name: 'SW1', tables: { clock: [clockRow({ source: 'user', stratum: undefined, reference: undefined, offsetMs: 5000 })] } });
    expect(read('clock.source', userSet)).toEqual({ value: 'user' });
    expect(read('ntp.stratum', userSet)).toEqual({ value: undefined });
  });

  it('without the row the clock was never set: source unset, no stratum, no offset', () => {
    for (const dev of [r1Unsynced(), pc()]) {
      expect(read('clock.source', dev)).toEqual({ value: 'unset' });
      expect(read('ntp.stratum', dev)).toEqual({ value: undefined });
      expect(read('clock.offsetMs', dev)).toEqual({ value: undefined });
    }
  });

  it("ruling R41: without the row, a host or server reads its boot clock 'host' (true time, §3.7); a router stays unset", () => {
    const server = fakeDevice({ name: 'SRV2', ipv4: '10.0.0.11', capabilities: ['host'] });
    expect(read('clock.source', server)).toEqual({ value: 'host' });
    expect(read('ntp.stratum', server)).toEqual({ value: undefined });
    const router = fakeDevice({ name: 'R9', capabilities: ['routing', 'host'] });
    expect(read('clock.source', router)).toEqual({ value: 'unset' });
    expect(fact(fakeSim(server), { device: 'SRV2', fact: 'clock.source', equals: 'ntp' })).toBe('SRV2 clock.source is host, expected ntp.');
  });

  it('through the fact kind, with bounds; wrong answers name what was found', () => {
    const sim = fakeSim(r1Synced(), srv1());
    expect(fact(sim, { device: 'R1', fact: 'ntp.stratum', equals: 2 })).toBeUndefined();
    expect(fact(sim, { device: 'R1', fact: 'ntp.stratum', atMost: 3 })).toBeUndefined();
    expect(fact(sim, { device: 'R1', fact: 'clock.offsetMs', atLeast: -100, atMost: 100 })).toBeUndefined();
    expect(fact(sim, { device: 'R1', fact: 'ntp.stratum', equals: 3 })).toBe('R1 ntp.stratum is 2, expected 3.');
    expect(fact(sim, { device: 'R1', fact: 'clock.source', equals: 'master' })).toBe('R1 clock.source is ntp, expected master.');
    expect(fact(sim, { device: 'R1', fact: 'clock.offsetMs', atLeast: 0 })).toBe('R1 clock.offsetMs is -12, expected at least 0.');
    expect(fact(fakeSim(r1Unsynced()), { device: 'R1', fact: 'clock.source', equals: 'ntp' })).toBe('R1 clock.source is unset, expected ntp.');
    expect(fact(fakeSim(r1Unsynced()), { device: 'R1', fact: 'clock.offsetMs' })).toBe('R1 clock.offsetMs is not set.');
  });
});

describe('[S24] logging.buffered (configuration)', () => {
  it('on by default at debugging; the configured level as its keyword', () => {
    expect(read('logging.buffered', pc())).toEqual({ value: 'debugging' });
    expect(read('logging.buffered', fakeDevice({ name: 'R1', lines: [[['logging', 'buffered', '8192', 'informational'], false]] }))).toEqual({ value: 'informational' });
    expect(read('logging.buffered', fakeDevice({ name: 'R1', lines: [[['logging', 'buffered', '3'], false]] }))).toEqual({ value: 'errors' });
    expect(read('logging.buffered', fakeDevice({ name: 'R1', lines: [[['logging', 'buffered', '16384'], false]] }))).toEqual({ value: 'debugging' });
  });

  it('a stored no logging buffered turns it off: no value', () => {
    expect(read('logging.buffered', fakeDevice({ name: 'R1', stored: [['no', 'logging', 'buffered']] }))).toEqual({ value: undefined });
  });

  it('wrong answers name what was found', () => {
    const r1 = fakeDevice({ name: 'R1', lines: [[['logging', 'buffered', '8192', 'warnings'], false]] });
    expect(fact(fakeSim(r1), { device: 'R1', fact: 'logging.buffered', equals: 'warnings' })).toBeUndefined();
    expect(fact(fakeSim(r1), { device: 'R1', fact: 'logging.buffered', equals: 'informational' })).toBe('R1 logging.buffered is warnings, expected informational.');
    expect(fact(fakeSim(fakeDevice({ name: 'R1', stored: [['no', 'logging', 'buffered']] })), { device: 'R1', fact: 'logging.buffered' })).toBe('R1 logging.buffered is not set.');
  });
});

describe('[S25] logging.trap (configuration)', () => {
  it('informational without the line; a keyword or a number reads as its keyword', () => {
    expect(read('logging.trap', pc())).toEqual({ value: 'informational' });
    expect(read('logging.trap', fakeDevice({ name: 'R1', lines: [[['logging', 'trap', 'warnings'], false]] }))).toEqual({ value: 'warnings' });
    expect(read('logging.trap', fakeDevice({ name: 'R1', lines: [[['logging', 'trap', '4'], false]] }))).toEqual({ value: 'warnings' });
    expect(read('logging.trap', fakeDevice({ name: 'R1', lines: [[['logging', 'trap', '4'], false], [['logging', 'trap', '4'], true]] }))).toEqual({ value: 'informational' });
  });

  it('wrong answers name what was found', () => {
    const r1 = fakeDevice({ name: 'R1', lines: [[['logging', 'host', '10.0.0.10'], false], [['logging', 'trap', 'errors'], false]] });
    expect(fact(fakeSim(r1), { device: 'R1', fact: 'logging.trap', equals: 'errors' })).toBeUndefined();
    expect(fact(fakeSim(r1), { device: 'R1', fact: 'logging.trap', equals: 'warnings' })).toBe('R1 logging.trap is errors, expected warnings.');
    expect(fact(fakeSim(pc()), { device: 'PC1', fact: 'logging.trap', equals: 'warnings' })).toBe('PC1 logging.trap is informational, expected warnings.');
  });
});
