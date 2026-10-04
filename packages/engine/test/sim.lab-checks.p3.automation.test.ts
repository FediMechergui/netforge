/**
 * sim.lab-checks.p3.automation — the http area's checker adapter (ARCHITECTURE-P3 D5, D21, §2.10, §3.8; §7 W3 http:
 * sim/lab-checks/automation.ts with the approved [S32] fact), against fakes: a hand-built host with a fake
 * `script-runs` table, the reader called directly and through the W1 `checkFact` framework. Pinned:
 *   • automation.lastRun reads `script-runs.state` of the newest run (rule 20: never the script host's StateView), of
 *     one file when the subject names it; the newest is the one started last, the higher run number on a tie (r10 is
 *     newer than r9); absent without a run or without the table;
 *   • the wrong answers fail with what was found.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceRuntime } from '../src/contracts/device.js';
import type { LabAssertion, LabFactName } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { TABLE_DESCRIPTORS, type ScriptRunRow, type Table, type TableName, type TableRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import { AUTOMATION_FACT_READERS } from '../src/sim/lab-checks/automation.js';
import { FACT_READERS, IDENTITY_SOURCES, checkFact, type FactReader, type FactReading, type IdentitySource, type IdentitySourceName } from '../src/sim/lab-checks/facts.js';

// ── fakes ────────────────────────────────────────────────────────────────────

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

/** A host named `name` whose model keeps `script-runs` with `runs`, or no such table when `runs` is undefined. */
function fakeHost(name: string, runs: readonly ScriptRunRow[] | undefined): DeviceRuntime {
  const tables = new Map<string, Table<TableRow>>();
  if (runs !== undefined) tables.set('script-runs', fakeTable('script-runs', runs));
  const dev = {
    id: name.toLowerCase(),
    spec: { id: name.toLowerCase(), type: 'fake', name },
    hostname: name,
    model: { capabilities: [] },
    profile: 'P3',
    running: createConfigAst(),
    macBase: 0x4000,
    ports: new Map(),
    tables: { get: (t: TableName) => tables.get(t) },
    port: () => undefined,
    resolvePortName: () => ({ kind: 'unknown' }),
  };
  return dev as unknown as DeviceRuntime;
}

const fakeSim = (...devices: DeviceRuntime[]): Simulation => ({ devices: () => devices }) as unknown as Simulation;

function readers(): { readonly [F in LabFactName]: FactReader | undefined } {
  const none = Object.fromEntries(Object.keys(FACT_READERS).map((k) => [k, undefined]));
  return { ...none, ...AUTOMATION_FACT_READERS } as { readonly [F in LabFactName]: FactReader | undefined };
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

const read = (dev: DeviceRuntime, subject?: string): FactReading => AUTOMATION_FACT_READERS['automation.lastRun']!.read({ sim: fakeSim(dev), dev, subject });

const run = (n: number, file: string, state: ScriptRunRow['state'], startedS: number): ScriptRunRow => {
  const r: ScriptRunRow = { key: `r${n}`, updatedAt: startedS * SEC, run: `r${n}`, file, state, startedAt: startedS * SEC, requests: 3 };
  if (state !== 'running') r.endedAt = (startedS + 2) * SEC;
  if (state === 'failed') r.error = "KeyError: 'name'";
  return r;
};

/** DEV1: inventory.py completed, then other.py failed, then inventory.py ran again and completed. */
const dev1 = (): DeviceRuntime =>
  fakeHost('DEV1', [run(1, 'inventory.py', 'completed', 100), run(2, 'other.py', 'failed', 200), run(3, 'inventory.py', 'completed', 300)]);

describe('automation.lastRun (script-runs.state)', () => {
  it('names its source', () => {
    expect(AUTOMATION_FACT_READERS['automation.lastRun']).toMatchObject({ type: 'string', source: 'script-runs.state' });
    expect(Object.keys(AUTOMATION_FACT_READERS)).toEqual(['automation.lastRun']);
    expect('script-runs' in TABLE_DESCRIPTORS).toBe(true);
  });

  it('the newest run, of any file or of the file the subject names', () => {
    expect(read(dev1())).toEqual({ value: 'completed' });
    expect(read(dev1(), 'inventory.py')).toEqual({ value: 'completed' });
    expect(read(dev1(), 'other.py')).toEqual({ value: 'failed' });
    const running = fakeHost('DEV1', [run(1, 'inventory.py', 'completed', 100), run(2, 'inventory.py', 'running', 150)]);
    expect(read(running, 'inventory.py')).toEqual({ value: 'running' });
  });

  it('newest = started last, the higher run number on a tie, whatever the table order', () => {
    const shuffled = fakeHost('DEV1', [run(10, 'a.py', 'stopped', 50), run(9, 'a.py', 'completed', 50), run(4, 'a.py', 'failed', 40)]);
    expect(read(shuffled)).toEqual({ value: 'stopped' });
    const later = fakeHost('DEV1', [run(7, 'a.py', 'failed', 90), run(6, 'a.py', 'completed', 80)]);
    expect(read(later)).toEqual({ value: 'failed' });
  });

  it('no run of the file, no run at all, or no table: no value', () => {
    expect(read(dev1(), 'missing.py')).toEqual({ value: undefined });
    expect(read(dev1(), 'Inventory.py')).toEqual({ value: undefined }); // file names compare exactly
    expect(read(fakeHost('DEV1', []))).toEqual({ value: undefined });
    expect(read(fakeHost('R1', undefined))).toEqual({ value: undefined });
  });

  it('wrong answers fail with what was found', () => {
    const sim = fakeSim(dev1());
    expect(fact(sim, { device: 'DEV1', fact: 'automation.lastRun', subject: 'inventory.py', equals: 'completed' })).toBeUndefined();
    expect(fact(sim, { device: 'DEV1', fact: 'automation.lastRun', subject: 'other.py', equals: 'completed' })).toBe(
      'DEV1 automation.lastRun of other.py is failed, expected completed.',
    );
    expect(fact(sim, { device: 'DEV1', fact: 'automation.lastRun', subject: 'missing.py', equals: 'completed' })).toBe(
      'DEV1 automation.lastRun of missing.py is not set, expected completed.',
    );
    expect(fact(fakeSim(fakeHost('DEV1', [])), { device: 'DEV1', fact: 'automation.lastRun' })).toBe('DEV1 automation.lastRun is not set.');
  });
});
