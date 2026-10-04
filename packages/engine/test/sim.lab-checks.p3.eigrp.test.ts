/**
 * sim.lab-checks.p3.eigrp — the [C1] EIGRP checker adapter (ARCHITECTURE-P3 D5, D26, §2.10, §2.16, §3.12; §7 W3
 * "Approved items in W3", eigrp): sim/lab-checks/eigrp.ts, wired into sim/lab-checks/facts.ts.
 *
 * Against fakes (§7 W3): the routers run a silent stub in place of the eigrp daemon, so the model keeps the
 * `eigrp-neighbors` and `eigrp-topology` tables and nothing writes them but this test, which writes the rows the
 * daemon would (§3.12's R1: successor R2, feasible successor R3 for 10.4.0.0/24); the configuration facts and the
 * router-id identity read lines stored through the real CLI. Pinned, each with a wrong answer and its detail:
 *   • the wiring (FACT_READERS, NEIGHBOR_SOURCES, IDENTITY_SOURCES read the adapter's entries) and every reader's
 *     table or configuration source (rule 20);
 *   • NEIGHBOR_SOURCES.eigrp: the rows and their state word ('up', 'pending'); a device NAME matches through its
 *     interface address;
 *   • IDENTITY_SOURCES.eigrp: the configured `eigrp router-id`;
 *   • eigrp.fd, eigrp.successor, eigrp.feasibleSuccessor (subject a prefix, host bits cleared; an 'address' compared
 *     through a device name) and eigrp.kValues (configuration), with the absent fact and the subject problems.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ProcessFactory } from '../src/contracts/process.js';
import type { LabAssertion, LabFactName } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { EigrpNeighborRow, EigrpPath, EigrpTopologyRow, Table } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { FACT_READERS, IDENTITY_SOURCES, NEIGHBOR_SOURCES, identitiesOf } from '../src/sim/lab-checks/facts.js';
import { EIGRP_FACT_READERS, EIGRP_IDENTITY_SOURCES, EIGRP_NEIGHBOR_SOURCES } from '../src/sim/lab-checks/eigrp.js';
import { runCheck } from '../src/sim/lab-checks/registry.js';
import { createStagedSimulation } from './staged.world.js';

const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';

/** A silent daemon in place of the real one: the model keeps its tables, nothing writes them. */
const stub =
  (name: string): ProcessFactory =>
  () => ({
    name,
    onPdu: () => [],
    onTimer: () => [],
    onConfig: () => [],
    stateSnapshot: () => ({ process: name, state: {} }),
    debugEvents: () => [],
  });

let sim: Simulation;

/** Configure through the real CLI; a refused line fails the test with its error. */
function cfg(id: string, lines: readonly string[]): void {
  const r = sim.configure(id, lines);
  if (!r.ok) throw new Error(`${id}: ${JSON.stringify(r.lines.filter((l) => !l.ok))}`);
}

function table<R extends EigrpNeighborRow | EigrpTopologyRow>(id: string, name: 'eigrp-neighbors' | 'eigrp-topology'): Table<R> {
  const t = sim.device(id)!.tables.get<R>(name);
  if (t === undefined) throw new Error(`${id} keeps no ${name} table`);
  return t;
}

const path = (nextHop: string, iface: string, metric: number, rd: number): EigrpPath => ({ nextHop, iface, metric, rd });

function topo(prefix: string, over: Partial<EigrpTopologyRow>): EigrpTopologyRow {
  return { key: prefix, updatedAt: 0, prefix, state: 'passive', fd: 0, successors: [], feasible: [], others: [], ...over };
}

/**
 * §3.12's R1 (AS 100, `eigrp router-id 1.1.1.1`, `metric weights 0 1 1 1 0 0`): neighbours R2 (10.0.12.2, up) on
 * Gi0/0 and R3 (10.0.13.3, still pending) on Gi0/1; 10.4.0.0/24 through R2 (FD 3328) with R3 a feasible successor;
 * 10.5.0.0/24 through R2 with no feasible successor; 10.0.12.0/24 connected. R2 runs AS 100 with the default K values;
 * R4 only names its router id; R5 runs no EIGRP; PC1 is a host (no EIGRP tables).
 */
beforeEach(() => {
  sim = createStagedSimulation({ seed: 4, stage: 'P3', factories: { eigrp: stub('eigrp') } });
  for (const n of [1, 2, 3, 4, 5]) sim.addDevice({ id: `r${n}`, type: 'router.nf2911', name: `R${n}` });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1' });
  sim.runFor(60 * SEC);
  cfg('r1', ['router eigrp 100', 'eigrp router-id 1.1.1.1', 'metric weights 0 1 1 1 0 0']);
  cfg('r2', ['interface GigabitEthernet0/0', 'ip address 10.0.12.2 255.255.255.0', 'exit', 'router eigrp 100']);
  cfg('r3', ['interface GigabitEthernet0/1', 'ip address 10.0.13.3 255.255.255.0']);
  cfg('r4', ['router eigrp 100', 'eigrp router-id 4.4.4.4']);
  const nbr = (iface: string, address: string, state: EigrpNeighborRow['state']): EigrpNeighborRow => ({
    key: `${iface}|${address}`,
    updatedAt: 0,
    iface,
    address,
    as: 100,
    state,
    holdS: 15,
    ...(state === 'up' ? { upSince: 0 } : {}),
    srttMs: 1,
    rtoMs: 200,
  });
  table<EigrpNeighborRow>('r1', 'eigrp-neighbors').set(nbr(GI0, '10.0.12.2', 'up'));
  table<EigrpNeighborRow>('r1', 'eigrp-neighbors').set(nbr(GI1, '10.0.13.3', 'pending'));
  const t = table<EigrpTopologyRow>('r1', 'eigrp-topology');
  t.set(topo('10.0.12.0/24', { fd: 2816, connected: GI0 }));
  t.set(topo('10.4.0.0/24', { fd: 3328, successors: [path('10.0.12.2', GI0, 3328, 2816)], feasible: [path('10.0.13.3', GI1, 3584, 3072)] }));
  t.set(topo('10.5.0.0/24', { fd: 3328, successors: [path('10.0.12.2', GI0, 3328, 2816)], others: [path('10.0.13.3', GI1, 5000, 3584)] }));
});

/** The detail of one assertion (undefined = it passed). */
function detail(a: LabAssertion): string | undefined {
  const r = runCheck({ sim, host: undefined }, a);
  return r.pass ? undefined : (r.detail ?? '(no detail)');
}

const fact = (device: string, f: LabFactName, over: { subject?: string; equals?: string | number | boolean; atLeast?: number; atMost?: number } = {}): LabAssertion => ({
  kind: 'fact',
  device,
  fact: f,
  ...over,
});

describe('the eigrp adapter is wired (rule 12) and names its sources (rule 20)', () => {
  it('FACT_READERS, NEIGHBOR_SOURCES and IDENTITY_SOURCES read the adapter’s entries', () => {
    const facts = Object.keys(EIGRP_FACT_READERS) as LabFactName[];
    expect(facts.sort()).toEqual(['eigrp.fd', 'eigrp.feasibleSuccessor', 'eigrp.kValues', 'eigrp.successor']);
    for (const f of facts) expect(FACT_READERS[f]).toBe(EIGRP_FACT_READERS[f]);
    expect(NEIGHBOR_SOURCES.eigrp).toBe(EIGRP_NEIGHBOR_SOURCES.eigrp);
    expect(IDENTITY_SOURCES.eigrp).toBe(EIGRP_IDENTITY_SOURCES.eigrp);
  });

  it('every reader names its table or configuration source', () => {
    expect(NEIGHBOR_SOURCES.eigrp?.table).toBe('eigrp-neighbors');
    expect(IDENTITY_SOURCES.eigrp?.source).toBe('configuration: router eigrp / eigrp router-id');
    const sources = Object.fromEntries(Object.entries(EIGRP_FACT_READERS).map(([f, r]) => [f, `${r.type} ${r.source}`]));
    expect(sources).toEqual({
      'eigrp.fd': 'number eigrp-topology.fd',
      'eigrp.successor': 'address eigrp-topology.successors (the first, in path order)',
      'eigrp.feasibleSuccessor': 'address eigrp-topology.feasible (the first, in path order)',
      'eigrp.kValues': 'string configuration: router eigrp / metric weights',
    });
  });
});

describe('neighbor {protocol: eigrp}', () => {
  const nb = (over: Partial<Extract<LabAssertion, { kind: 'neighbor' }>>): LabAssertion => ({ kind: 'neighbor', device: 'R1', protocol: 'eigrp', ...over });

  it('reads the eigrp-neighbors rows; a device name matches through its interface address', () => {
    expect(detail(nb({ neighbor: 'R2', state: 'up' }))).toBeUndefined();
    expect(detail(nb({ neighbor: '10.0.13.3', iface: 'Gi0/1', state: 'pending' }))).toBeUndefined();
    expect(detail(nb({ state: 'up', count: 1 }))).toBeUndefined();
    expect(detail(nb({ minCount: 2 }))).toBeUndefined();
  });

  it('wrong answers: a neighbour not up yet, a missing one, a count; a device without the table does not run EIGRP', () => {
    expect(detail(nb({ neighbor: 'R3', state: 'up' }))).toBe('R1 sees EIGRP neighbour 10.0.13.3 on Gi0/1 in state pending, expected in state up.');
    expect(detail(nb({ neighbor: 'R5' }))).toBe('R1 has no EIGRP neighbour R5.');
    expect(detail(nb({ state: 'up', count: 2 }))).toBe('R1 has 1 EIGRP neighbour in state up, expected exactly 2.');
    expect(detail(nb({ device: 'R2' }))).toBe('R2 has no EIGRP neighbour.');
    expect(detail(nb({ device: 'PC1' }))).toBe('PC1 does not run EIGRP.');
  });
});

describe('the EIGRP router-id identity (configuration)', () => {
  it('a configured eigrp router-id is an identity of its device; without the line there is none', () => {
    expect(EIGRP_IDENTITY_SOURCES.eigrp?.read(sim.device('r4')!)).toEqual(['4.4.4.4']);
    expect(EIGRP_IDENTITY_SOURCES.eigrp?.read(sim.device('r2')!)).toEqual([]);
    expect(EIGRP_IDENTITY_SOURCES.eigrp?.read(sim.device('r5')!)).toEqual([]);
    expect(identitiesOf(sim.device('r4')!).has('ip:4.4.4.4')).toBe(true);
    expect(identitiesOf(sim.device('r5')!).has('ip:4.4.4.4')).toBe(false);
  });

  it('an address fact matches a device through it', () => {
    sim.device('r1')!.tables.get<EigrpTopologyRow>('eigrp-topology')!.set(topo('10.6.0.0/24', { fd: 1, successors: [path('4.4.4.4', GI0, 1, 0)] }));
    expect(detail(fact('R1', 'eigrp.successor', { subject: '10.6.0.0/24', equals: 'R4' }))).toBeUndefined();
    expect(detail(fact('R1', 'eigrp.successor', { subject: '10.6.0.0/24', equals: 'R5' }))).toBe('R1 eigrp.successor of 10.6.0.0/24 is 4.4.4.4, expected R5.');
  });
});

describe('eigrp.* facts', () => {
  it('eigrp.fd reads the prefix row (host bits cleared)', () => {
    expect(detail(fact('R1', 'eigrp.fd', { subject: '10.4.0.0/24', equals: 3328 }))).toBeUndefined();
    expect(detail(fact('R1', 'eigrp.fd', { subject: '10.4.0.9/24', atMost: 3328 }))).toBeUndefined();
    expect(detail(fact('R1', 'eigrp.fd', { subject: '10.4.0.0/24', equals: 3072 }))).toBe('R1 eigrp.fd of 10.4.0.0/24 is 3328, expected 3072.');
    expect(detail(fact('R1', 'eigrp.fd', { subject: '10.9.0.0/24', equals: 1 }))).toBe('R1 eigrp.fd of 10.9.0.0/24 is not set, expected 1.');
  });

  it('eigrp.successor: the first successor’s next hop, by address or by device name', () => {
    expect(detail(fact('R1', 'eigrp.successor', { subject: '10.4.0.0/24', equals: 'R2' }))).toBeUndefined();
    expect(detail(fact('R1', 'eigrp.successor', { subject: '10.4.0.0/24', equals: '10.0.12.2' }))).toBeUndefined();
    expect(detail(fact('R1', 'eigrp.successor', { subject: '10.4.0.0/24', equals: 'R3' }))).toBe('R1 eigrp.successor of 10.4.0.0/24 is 10.0.12.2, expected R3.');
    // a connected network has no successor
    expect(detail(fact('R1', 'eigrp.successor', { subject: '10.0.12.0/24' }))).toBe('R1 eigrp.successor of 10.0.12.0/24 is not set.');
  });

  it('eigrp.feasibleSuccessor: §3.12’s R3; none when no neighbour meets the feasibility condition', () => {
    expect(detail(fact('R1', 'eigrp.feasibleSuccessor', { subject: '10.4.0.0/24', equals: 'R3' }))).toBeUndefined();
    expect(detail(fact('R1', 'eigrp.feasibleSuccessor', { subject: '10.4.0.0/24', equals: 'R2' }))).toBe(
      'R1 eigrp.feasibleSuccessor of 10.4.0.0/24 is 10.0.13.3, expected R2.',
    );
    expect(detail(fact('R1', 'eigrp.feasibleSuccessor', { subject: '10.5.0.0/24', equals: 'R3' }))).toBe(
      'R1 eigrp.feasibleSuccessor of 10.5.0.0/24 is not set, expected R3.',
    );
  });

  it('eigrp.kValues: the metric weights line, the default without it, absent without a process', () => {
    expect(detail(fact('R1', 'eigrp.kValues', { equals: '1 1 1 0 0' }))).toBeUndefined();
    expect(detail(fact('R2', 'eigrp.kValues', { equals: '1 0 1 0 0' }))).toBeUndefined();
    expect(detail(fact('R1', 'eigrp.kValues', { equals: '1 0 1 0 0' }))).toBe('R1 eigrp.kValues is 1 1 1 0 0, expected 1 0 1 0 0.');
    expect(detail(fact('R5', 'eigrp.kValues'))).toBe('R5 eigrp.kValues is not set.');
  });

  it('a missing or malformed prefix fails', () => {
    expect(detail(fact('R1', 'eigrp.fd', { equals: 1 }))).toBe('eigrp.fd needs a prefix as its subject (10.4.0.0/24).');
    expect(detail(fact('R1', 'eigrp.successor', { subject: '10.4.0.0' }))).toBe('"10.4.0.0" is not a prefix (write it as 10.4.0.0/24).');
    expect(detail(fact('R1', 'eigrp.feasibleSuccessor', { subject: '10.4.0.0/33' }))).toBe('"10.4.0.0/33" is not a prefix (write it as 10.4.0.0/24).');
  });
});
