/**
 * sim.lab-checks.p3.ospf — the ospf area's checker adapter (ARCHITECTURE-P3 D5, D7, D10, §2.10; §7 W3 "ospf, acl, l2,
 * qos, disc, svc, http"): sim/lab-checks/ospf.ts, wired into sim/lab-checks/facts.ts.
 *
 * Against fakes (§7 W3: each area tests against a fake of the daemon): the routers run a silent stub in place of the
 * ospf daemon, so the model keeps the three OSPF tables and nothing writes them but this test, which writes the rows
 * the daemon would (`ospf-interfaces`, `ospf-neighbors`, `ospf-lsdb`); the configuration facts read lines stored
 * through the real CLI. Pinned, each with a wrong answer and its original detail:
 *   • facts.ts's wiring over every area adapter (grader parts A and B): each registry entry is a getter that reads
 *     the adapter FACT_AREAS / NEIGHBOR_AREAS names at call time (rule 12), no entry is claimed by two adapters, and
 *     after W3 every fact, neighbour protocol and router-id identity has its entry with a declared type and source;
 *   • the wiring: FACT_READERS, NEIGHBOR_SOURCES and IDENTITY_SOURCES read the ospf adapter's entries, and every
 *     reader names its table or configuration source (rule 20);
 *   • NEIGHBOR_SOURCES.ospf: the `ospf-neighbors` rows, state and role; a device NAME matches its OSPF router id (the
 *     ospf identity: the `routerId` column of its `ospf-interfaces` rows);
 *   • every ospf.* fact: its value, a wrong answer, the absent fact, and the subject problems;
 *   • ospf.lsdbSynced over the routers of the area only, comparing LSA headers (not the age, not `self`), the
 *     AS-external LSAs included, the MaxAge flag included.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ProcessFactory } from '../src/contracts/process.js';
import type { LabAssertion, LabFactName, NeighborProtocol } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { ospfLsaKey, ospfNbrKey, type OspfInterfaceRow, type OspfLsaRow, type OspfNeighborRow, type Table } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { ACL_FACT_READERS } from '../src/sim/lab-checks/acl.js';
import { AUTOMATION_FACT_READERS } from '../src/sim/lab-checks/automation.js';
import { DISCOVERY_FACT_READERS, DISCOVERY_NEIGHBOR_SOURCES } from '../src/sim/lab-checks/discovery.js';
import { EIGRP_FACT_READERS, EIGRP_IDENTITY_SOURCES, EIGRP_NEIGHBOR_SOURCES } from '../src/sim/lab-checks/eigrp.js';
import {
  FACT_AREAS,
  FACT_READERS,
  IDENTITY_SOURCES,
  NEIGHBOR_AREAS,
  NEIGHBOR_SOURCES,
  identitiesOf,
  type FactReader,
  type NeighborSource,
} from '../src/sim/lab-checks/facts.js';
import { HARDENING_FACT_READERS } from '../src/sim/lab-checks/hardening.js';
import { OSPF_FACT_READERS, OSPF_IDENTITY_SOURCES, OSPF_NEIGHBOR_SOURCES } from '../src/sim/lab-checks/ospf.js';
import { QOS_FACT_READERS } from '../src/sim/lab-checks/qos.js';
import { TIME_FACT_READERS } from '../src/sim/lab-checks/time.js';
import { WAN_FACT_READERS, WAN_NEIGHBOR_SOURCES } from '../src/sim/lab-checks/wan.js';
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

function table<R extends OspfInterfaceRow | OspfNeighborRow | OspfLsaRow>(sim: Simulation, id: string, name: 'ospf-interfaces' | 'ospf-neighbors' | 'ospf-lsdb'): Table<R> {
  const t = sim.device(id)!.tables.get<R>(name);
  if (t === undefined) throw new Error(`${id} keeps no ${name} table`);
  return t;
}

function iface(port: string, routerId: string, area: string, over: Partial<OspfInterfaceRow> = {}): OspfInterfaceRow {
  return {
    key: port,
    updatedAt: 0,
    port,
    process: 1,
    routerId,
    area,
    networkType: 'broadcast',
    state: 'dr',
    cost: 1,
    costSource: 'bandwidth',
    priority: 1,
    helloS: 10,
    deadS: 40,
    passive: false,
    neighbors: 0,
    adjacent: 0,
    stateSince: 0,
    ...over,
  };
}

function lsa(scope: string, type: 1 | 2 | 5, lsid: string, adv: string, seq: number, over: Partial<OspfLsaRow> = {}): OspfLsaRow {
  return {
    key: ospfLsaKey(scope, type, lsid, adv),
    updatedAt: 0,
    scope,
    type,
    lsid,
    advRouter: adv,
    seq,
    ageAtInstall: 1,
    installedAt: 0,
    checksum: 0x1000 + seq,
    length: 36,
    options: 2,
    self: false,
    ...over,
  };
}

/** The area-0 database every router of area 0 holds (one type-5 LSA as well). */
const AREA0 = (): OspfLsaRow[] => [
  lsa('0.0.0.0', 1, '1.1.1.1', '1.1.1.1', 0x80000002),
  lsa('0.0.0.0', 1, '2.2.2.2', '2.2.2.2', 0x80000003),
  lsa('0.0.0.0', 1, '3.3.3.3', '3.3.3.3', 0x80000001),
  lsa('0.0.0.0', 2, '10.0.123.1', '1.1.1.1', 0x80000001),
  lsa('as', 5, '0.0.0.0', '1.1.1.1', 0x80000001),
];

let sim: Simulation;

/** Configure through the real CLI; a refused line fails the test with its error. */
function cfg(id: string, lines: readonly string[]): void {
  const r = sim.configure(id, lines);
  if (!r.ok) throw new Error(`${id}: ${JSON.stringify(r.lines.filter((l) => !l.ok))}`);
}

/**
 * R1, R2, R3 in area 0 (R1 also in area 1 on Gi0/1, passive); R4 in area 1 only; R5 a router without OSPF; PC1 a
 * host (no OSPF tables). R1 stores `auto-cost reference-bandwidth 1000` and `default-information originate always`;
 * R2 a bare `router ospf 1`.
 */
beforeEach(() => {
  sim = createStagedSimulation({ seed: 3, stage: 'P3', factories: { ospf: stub('ospf') } });
  for (const n of [1, 2, 3, 4, 5]) sim.addDevice({ id: `r${n}`, type: 'router.nf2911', name: `R${n}` });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1' });
  sim.runFor(60 * SEC);
  cfg('r1', ['router ospf 1', 'auto-cost reference-bandwidth 1000', 'default-information originate always']);
  cfg('r2', ['router ospf 1']);
  table<OspfInterfaceRow>(sim, 'r1', 'ospf-interfaces').set(iface(GI0, '1.1.1.1', '0.0.0.0'));
  table<OspfInterfaceRow>(sim, 'r1', 'ospf-interfaces').set(
    iface(GI1, '1.1.1.1', '0.0.0.1', { networkType: 'point-to-point', state: 'point-to-point', cost: 64, priority: 0, passive: true }),
  );
  table<OspfInterfaceRow>(sim, 'r2', 'ospf-interfaces').set(iface(GI0, '2.2.2.2', '0.0.0.0', { state: 'backup' }));
  table<OspfInterfaceRow>(sim, 'r3', 'ospf-interfaces').set(iface(GI0, '3.3.3.3', '0.0.0.0', { state: 'drother' }));
  table<OspfInterfaceRow>(sim, 'r4', 'ospf-interfaces').set(iface(GI0, '4.4.4.4', '0.0.0.1'));
  for (const id of ['r1', 'r2', 'r3']) {
    const t = table<OspfLsaRow>(sim, id, 'ospf-lsdb');
    for (const row of AREA0()) t.set(id === 'r1' && row.advRouter === '1.1.1.1' ? { ...row, self: true } : id === 'r2' ? { ...row, ageAtInstall: 900, installedAt: 5 * SEC } : row);
  }
  // R4 holds only area 1, which says nothing about area 0
  table<OspfLsaRow>(sim, 'r4', 'ospf-lsdb').set(lsa('0.0.0.1', 1, '4.4.4.4', '4.4.4.4', 0x80000009));
  const nbr = table<OspfNeighborRow>(sim, 'r1', 'ospf-neighbors');
  const n = (routerId: string, address: string, state: OspfNeighborRow['state'], role: OspfNeighborRow['role']): OspfNeighborRow => ({
    key: ospfNbrKey(GI0, routerId),
    updatedAt: 0,
    port: GI0,
    routerId,
    address,
    priority: 1,
    state,
    role,
    dr: '10.0.123.2',
    bdr: '10.0.123.1',
    stateSince: 0,
  });
  nbr.set(n('2.2.2.2', '10.0.123.2', 'full', 'dr'));
  nbr.set(n('3.3.3.3', '10.0.123.3', '2way', 'drother'));
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

describe('facts.ts wiring over every area adapter (rule 12: read at call time; rule 18: one adapter per entry)', () => {
  const FACT_TABLES: readonly Partial<Record<LabFactName, FactReader>>[] = [
    OSPF_FACT_READERS,
    ACL_FACT_READERS,
    HARDENING_FACT_READERS,
    QOS_FACT_READERS,
    EIGRP_FACT_READERS,
    DISCOVERY_FACT_READERS,
    TIME_FACT_READERS,
    AUTOMATION_FACT_READERS,
    WAN_FACT_READERS,
  ];
  const NEIGHBOR_TABLES: readonly Partial<Record<NeighborProtocol, NeighborSource>>[] = [
    OSPF_NEIGHBOR_SOURCES,
    EIGRP_NEIGHBOR_SOURCES,
    DISCOVERY_NEIGHBOR_SOURCES,
    WAN_NEIGHBOR_SOURCES,
  ];

  it('every registry entry is a getter that reads the adapter its area map names', () => {
    expect(Object.keys(FACT_READERS)).toEqual(Object.keys(FACT_AREAS));
    expect(Object.keys(NEIGHBOR_SOURCES)).toEqual(Object.keys(NEIGHBOR_AREAS));
    for (const f of Object.keys(FACT_AREAS) as LabFactName[]) {
      const d = Object.getOwnPropertyDescriptor(FACT_READERS, f)!;
      expect(typeof d.get).toBe('function');
      expect('value' in d).toBe(false);
      expect(FACT_READERS[f]).toBe(FACT_AREAS[f]()[f]);
    }
    for (const p of Object.keys(NEIGHBOR_AREAS) as NeighborProtocol[]) {
      expect(typeof Object.getOwnPropertyDescriptor(NEIGHBOR_SOURCES, p)!.get).toBe('function');
      expect(NEIGHBOR_SOURCES[p]).toBe(NEIGHBOR_AREAS[p]()[p]);
    }
    for (const n of ['ospf', 'eigrp'] as const) expect(typeof Object.getOwnPropertyDescriptor(IDENTITY_SOURCES, n)!.get).toBe('function');
    expect(Object.keys(IDENTITY_SOURCES)).toEqual(['name', 'address', 'mac', 'ospf', 'eigrp']);
    expect(IDENTITY_SOURCES.eigrp).toBe(EIGRP_IDENTITY_SOURCES.eigrp);
  });

  it('every adapter entry is wired where the area map says, so no entry is claimed by two adapters', () => {
    for (const t of FACT_TABLES) for (const f of Object.keys(t) as LabFactName[]) expect(FACT_AREAS[f]()).toBe(t);
    for (const t of NEIGHBOR_TABLES) for (const p of Object.keys(t) as NeighborProtocol[]) expect(NEIGHBOR_AREAS[p]()).toBe(t);
  });

  it('after W3 every fact, neighbour protocol and router-id identity has its entry, with a type and a source', () => {
    for (const f of Object.keys(FACT_AREAS) as LabFactName[]) {
      const r = FACT_READERS[f];
      expect(r, f).toBeDefined();
      expect(['string', 'number', 'boolean', 'address', 'port']).toContain(r!.type);
      expect(r!.source.length, f).toBeGreaterThan(0);
    }
    for (const p of Object.keys(NEIGHBOR_AREAS) as NeighborProtocol[]) expect(NEIGHBOR_SOURCES[p]?.table, p).toBeDefined();
    expect(IDENTITY_SOURCES.ospf).toBeDefined();
    expect(IDENTITY_SOURCES.eigrp).toBeDefined();
  });
});

describe('the ospf adapter is wired (rule 12: read at call time) and names its sources (rule 20)', () => {
  it('FACT_READERS, NEIGHBOR_SOURCES and IDENTITY_SOURCES read the adapter’s entries', () => {
    const facts = Object.keys(OSPF_FACT_READERS) as LabFactName[];
    expect(facts.sort()).toEqual(
      [
        'ospf.routerId',
        'ospf.referenceBandwidthMbps',
        'ospf.defaultOriginate',
        'ospf.ifaceArea',
        'ospf.ifaceCost',
        'ospf.ifaceNetworkType',
        'ospf.ifaceState',
        'ospf.ifacePriority',
        'ospf.passive',
        'ospf.lsdbSynced',
      ].sort(),
    );
    for (const f of facts) expect(FACT_READERS[f]).toBe(OSPF_FACT_READERS[f]);
    expect(NEIGHBOR_SOURCES.ospf).toBe(OSPF_NEIGHBOR_SOURCES.ospf);
    expect(IDENTITY_SOURCES.ospf).toBe(OSPF_IDENTITY_SOURCES.ospf);
  });

  it('every reader names its table or configuration source', () => {
    expect(NEIGHBOR_SOURCES.ospf?.table).toBe('ospf-neighbors');
    expect(IDENTITY_SOURCES.ospf?.source).toBe('ospf-interfaces.routerId');
    const sources = Object.fromEntries(Object.entries(OSPF_FACT_READERS).map(([f, r]) => [f, `${r.type} ${r.source}`]));
    expect(sources).toEqual({
      'ospf.routerId': 'address ospf-interfaces.routerId',
      'ospf.referenceBandwidthMbps': 'number configuration: router ospf / auto-cost reference-bandwidth',
      'ospf.defaultOriginate': 'string configuration: router ospf / default-information originate',
      'ospf.ifaceArea': 'string ospf-interfaces.area',
      'ospf.ifaceCost': 'number ospf-interfaces.cost',
      'ospf.ifaceNetworkType': 'string ospf-interfaces.networkType',
      'ospf.ifaceState': 'string ospf-interfaces.state',
      'ospf.ifacePriority': 'number ospf-interfaces.priority',
      'ospf.passive': 'boolean ospf-interfaces.passive',
      'ospf.lsdbSynced': 'boolean ospf-lsdb (every router with an interface in the area)',
    });
  });
});

describe('neighbor {protocol: ospf}', () => {
  const nb = (over: Partial<Extract<LabAssertion, { kind: 'neighbor' }>>): LabAssertion => ({ kind: 'neighbor', device: 'R1', protocol: 'ospf', ...over });

  it('reads the ospf-neighbors rows: state, role, interface and count', () => {
    expect(detail(nb({ neighbor: 'R2', state: 'full', role: 'dr' }))).toBeUndefined();
    expect(detail(nb({ neighbor: '3.3.3.3', iface: 'Gi0/0', state: '2WAY', role: 'drother' }))).toBeUndefined();
    expect(detail(nb({ neighbor: '10.0.123.3' }))).toBeUndefined();
    expect(detail(nb({ state: 'full', count: 1 }))).toBeUndefined();
    expect(detail(nb({ minCount: 2 }))).toBeUndefined();
  });

  it('a device name matches through its OSPF router id (the ospf identity), which no interface address gives', () => {
    const r2 = sim.device('r2')!;
    expect([...r2.ports.values()].some((p) => p.l3.ipv4?.address === '2.2.2.2' || p.l3.ipv4?.address === '10.0.123.2')).toBe(false);
    expect(identitiesOf(r2).has('ip:2.2.2.2')).toBe(true);
    expect(identitiesOf(sim.device('r5')!).has('ip:2.2.2.2')).toBe(false);
    expect(OSPF_IDENTITY_SOURCES.ospf?.read(sim.device('r1')!)).toEqual(['1.1.1.1']);
    expect(OSPF_IDENTITY_SOURCES.ospf?.read(sim.device('r5')!)).toEqual([]);
  });

  it('wrong answers: the state, the role, the neighbour, the count; a device without the table does not run OSPF', () => {
    expect(detail(nb({ neighbor: 'R3', state: 'full' }))).toBe('R1 sees OSPF neighbour 3.3.3.3 on Gi0/0 in state 2way, expected in state full.');
    expect(detail(nb({ neighbor: 'R2', role: 'bdr' }))).toBe('R1 sees OSPF neighbour 2.2.2.2 on Gi0/0 as dr, expected as bdr.');
    expect(detail(nb({ neighbor: 'R4' }))).toBe('R1 has no OSPF neighbour R4.');
    expect(detail(nb({ neighbor: 'R2', iface: 'Gi0/1' }))).toBe('R1 has no OSPF neighbour R2 on Gi0/1.');
    expect(detail(nb({ state: 'full', count: 2 }))).toBe('R1 has 1 OSPF neighbour in state full, expected exactly 2.');
    expect(detail(nb({ neighbor: 'R2', exists: false }))).toBe('R1 still has OSPF neighbour R2 (2.2.2.2 on Gi0/0).');
    expect(detail(nb({ device: 'R5' }))).toBe('R5 has no OSPF neighbour.');
    expect(detail(nb({ device: 'PC1' }))).toBe('PC1 does not run OSPF.');
  });
});

describe('ospf.* facts', () => {
  it('ospf.routerId: the id in use, compared as an address or through a device name', () => {
    expect(detail(fact('R1', 'ospf.routerId', { equals: '1.1.1.1' }))).toBeUndefined();
    expect(detail(fact('R1', 'ospf.routerId', { equals: 'R1' }))).toBeUndefined();
    expect(detail(fact('R1', 'ospf.routerId', { equals: '2.2.2.2' }))).toBe('R1 ospf.routerId is 1.1.1.1, expected 2.2.2.2.');
    expect(detail(fact('R1', 'ospf.routerId', { equals: 'R2' }))).toBe('R1 ospf.routerId is 1.1.1.1, expected R2.');
    expect(detail(fact('R5', 'ospf.routerId'))).toBe('R5 ospf.routerId is not set.');
  });

  it('the id in use, not a router-id line typed later (applied only at clear or reload, D7)', () => {
    cfg('r1', ['router ospf 1', 'router-id 9.9.9.9']);
    expect(detail(fact('R1', 'ospf.routerId', { equals: '1.1.1.1' }))).toBeUndefined();
    expect(detail(fact('R1', 'ospf.routerId', { equals: '9.9.9.9' }))).toBe('R1 ospf.routerId is 1.1.1.1, expected 9.9.9.9.');
  });

  it('ospf.referenceBandwidthMbps: the configured line, 100 by default, absent without a process', () => {
    expect(detail(fact('R1', 'ospf.referenceBandwidthMbps', { equals: 1000 }))).toBeUndefined();
    expect(detail(fact('R1', 'ospf.referenceBandwidthMbps', { atLeast: 1000 }))).toBeUndefined();
    expect(detail(fact('R2', 'ospf.referenceBandwidthMbps', { equals: 100 }))).toBeUndefined();
    expect(detail(fact('R1', 'ospf.referenceBandwidthMbps', { equals: 100 }))).toBe('R1 ospf.referenceBandwidthMbps is 1000, expected 100.');
    expect(detail(fact('R5', 'ospf.referenceBandwidthMbps', { equals: 100 }))).toBe('R5 ospf.referenceBandwidthMbps is not set, expected 100.');
  });

  it('ospf.defaultOriginate: on, always or off; absent without a process', () => {
    expect(detail(fact('R1', 'ospf.defaultOriginate', { equals: 'always' }))).toBeUndefined();
    expect(detail(fact('R2', 'ospf.defaultOriginate', { equals: 'off' }))).toBeUndefined();
    expect(detail(fact('R1', 'ospf.defaultOriginate', { equals: 'on' }))).toBe('R1 ospf.defaultOriginate is always, expected on.');
    expect(detail(fact('R5', 'ospf.defaultOriginate'))).toBe('R5 ospf.defaultOriginate is not set.');
  });

  it('the interface facts read the subject’s ospf-interfaces row', () => {
    expect(detail(fact('R1', 'ospf.ifaceArea', { subject: 'Gi0/1', equals: '0.0.0.1' }))).toBeUndefined();
    expect(detail(fact('R1', 'ospf.ifaceCost', { subject: 'GigabitEthernet0/1', equals: 64 }))).toBeUndefined();
    expect(detail(fact('R1', 'ospf.ifaceNetworkType', { subject: 'Gi0/1', equals: 'point-to-point' }))).toBeUndefined();
    expect(detail(fact('R2', 'ospf.ifaceState', { subject: 'Gi0/0', equals: 'backup' }))).toBeUndefined();
    expect(detail(fact('R1', 'ospf.ifacePriority', { subject: 'Gi0/1', equals: 0 }))).toBeUndefined();
    expect(detail(fact('R1', 'ospf.passive', { subject: 'Gi0/1', equals: true }))).toBeUndefined();
    expect(detail(fact('R1', 'ospf.passive', { subject: 'Gi0/0', equals: false }))).toBeUndefined();
  });

  it('a wrong answer for each interface fact', () => {
    expect(detail(fact('R1', 'ospf.ifaceArea', { subject: 'Gi0/1', equals: '0.0.0.0' }))).toBe('R1 ospf.ifaceArea of Gi0/1 is 0.0.0.1, expected 0.0.0.0.');
    expect(detail(fact('R1', 'ospf.ifaceCost', { subject: 'Gi0/1', atMost: 10 }))).toBe('R1 ospf.ifaceCost of Gi0/1 is 64, expected at most 10.');
    expect(detail(fact('R1', 'ospf.ifaceNetworkType', { subject: 'Gi0/0', equals: 'point-to-point' }))).toBe(
      'R1 ospf.ifaceNetworkType of Gi0/0 is broadcast, expected point-to-point.',
    );
    expect(detail(fact('R3', 'ospf.ifaceState', { subject: 'Gi0/0', equals: 'dr' }))).toBe('R3 ospf.ifaceState of Gi0/0 is drother, expected dr.');
    expect(detail(fact('R1', 'ospf.ifacePriority', { subject: 'Gi0/0', equals: 0 }))).toBe('R1 ospf.ifacePriority of Gi0/0 is 1, expected 0.');
    expect(detail(fact('R1', 'ospf.passive', { subject: 'Gi0/0', equals: true }))).toBe('R1 ospf.passive of Gi0/0 is false, expected true.');
  });

  it('an interface without a row has no value; a missing or unknown subject fails', () => {
    expect(detail(fact('R1', 'ospf.ifaceArea', { subject: 'Se0/0/0', equals: '0.0.0.0' }))).toBe('R1 ospf.ifaceArea of Se0/0/0 is not set, expected 0.0.0.0.');
    expect(detail(fact('R1', 'ospf.ifaceCost', { equals: 1 }))).toBe('ospf.ifaceCost needs an interface as its subject.');
    expect(detail(fact('R1', 'ospf.passive', { subject: 'Gi9/9', equals: true }))).toBe('R1 has no interface called Gi9/9.');
  });
});

describe('ospf.lsdbSynced', () => {
  const synced = (device: string, subject?: string, equals: boolean = true): LabAssertion => fact(device, 'ospf.lsdbSynced', subject === undefined ? { equals } : { subject, equals });

  it('true when every router of the area holds the same headers (the age and self are not compared)', () => {
    expect(detail(synced('R1', '0.0.0.0'))).toBeUndefined();
    expect(detail(synced('R3', '0'))).toBeUndefined();
  });

  it('a different sequence on one router of the area makes every router of the area unsynchronised', () => {
    table<OspfLsaRow>(sim, 'r3', 'ospf-lsdb').set(lsa('0.0.0.0', 1, '2.2.2.2', '2.2.2.2', 0x80000002));
    expect(detail(synced('R1', '0.0.0.0'))).toBe('R1 ospf.lsdbSynced of 0.0.0.0 is false, expected true.');
    expect(detail(synced('R2', '0.0.0.0', false))).toBeUndefined();
  });

  it('a missing AS-external LSA, or one at MaxAge, breaks it too', () => {
    table<OspfLsaRow>(sim, 'r2', 'ospf-lsdb').delete(ospfLsaKey('as', 5, '0.0.0.0', '1.1.1.1'));
    expect(detail(synced('R1', '0.0.0.0'))).toBe('R1 ospf.lsdbSynced of 0.0.0.0 is false, expected true.');
    table<OspfLsaRow>(sim, 'r2', 'ospf-lsdb').set(lsa('as', 5, '0.0.0.0', '1.1.1.1', 0x80000001, { maxAge: true }));
    expect(detail(synced('R1', '0.0.0.0'))).toBe('R1 ospf.lsdbSynced of 0.0.0.0 is false, expected true.');
  });

  it('only the routers of the area count; a router outside it has no value', () => {
    // R4 is in area 1 only, with a database unlike anyone's
    expect(detail(synced('R1', '0.0.0.0'))).toBeUndefined();
    // area 1: R1 (Gi0/1) and R4 hold different databases
    expect(detail(synced('R4', '0.0.0.1'))).toBe('R4 ospf.lsdbSynced of 0.0.0.1 is false, expected true.');
    expect(detail(synced('R5', '0.0.0.0'))).toBe('R5 ospf.lsdbSynced of 0.0.0.0 is not set, expected true.');
  });

  it('a missing or malformed area fails', () => {
    expect(detail(synced('R1'))).toBe('ospf.lsdbSynced needs an OSPF area as its subject (0.0.0.0).');
    expect(detail(synced('R1', 'backbone'))).toBe('"backbone" is not an OSPF area (write it as 0.0.0.0 or 0).');
  });
});
