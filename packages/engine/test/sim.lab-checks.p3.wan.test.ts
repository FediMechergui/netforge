/**
 * sim.lab-checks.p3.wan — the wan area's checker adapter for the approved [S18] GRE, [S19] PPP and [C13] IPsec items
 * (ARCHITECTURE-P3 D5, D17, D27, §2.10, §3.9, §3.10, §3.13; §7 W3 "Approved items in W3", wan: sim/lab-checks/wan.ts),
 * against fakes: hand-built routers with fake `tunnels`, `ppp` and `ipsec-sa` tables, the readers and the source called
 * directly, and through the W1 frameworks (`checkNeighbor`, `checkFact`) for the details a learner sees. Pinned, each
 * with a wrong answer:
 *   • NEIGHBOR_SOURCES.ppp reads the `ppp` rows (rule 20): the local port, the peer's learnt name and address, the label,
 *     state = the LCP state; undefined (does not run PPP) without the table;
 *   • tunnel.up (tunnels.state), ppp.lcp / ppp.ipcp / ppp.auth (the ppp row) and ipsec.sa (ipsec-sa.state), by subject
 *     interface (long or short); an unknown interface fails with the usual detail; without a subject the only row is
 *     read and several rows ask for a subject.
 */
import { describe, expect, it } from 'vitest';
import type { PortRole } from '../src/contracts/catalog.js';
import type { DeviceRuntime, PortResolution } from '../src/contracts/device.js';
import type { PortKind, PortState } from '../src/contracts/port.js';
import type { LabAssertion, LabFactName, NeighborProtocol } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { TABLE_DESCRIPTORS, type IpsecSaRow, type PppRow, type Table, type TableName, type TableRow, type TunnelRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import { FACT_READERS, IDENTITY_SOURCES, checkFact, checkNeighbor, type FactReader, type FactReading, type IdentitySource, type IdentitySourceName, type NeighborSource } from '../src/sim/lab-checks/facts.js';
import { WAN_FACT_READERS, WAN_NEIGHBOR_SOURCES } from '../src/sim/lab-checks/wan.js';

// ── fakes ────────────────────────────────────────────────────────────────────

interface FakePort {
  readonly id: string;
  readonly short: string;
  readonly kind: PortKind;
  readonly role: PortRole;
  readonly ipv4?: string;
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

/** A device with `ports` whose model keeps the tables given (a name absent here is a table the model does not keep). */
function fakeDevice(name: string, ports: readonly FakePort[], tableRows: Readonly<Record<string, readonly TableRow[]>>, macBase: number): DeviceRuntime {
  const byId = new Map<string, PortState>();
  let n = 0;
  for (const p of ports) {
    n += 1;
    byId.set(p.id, {
      id: p.id,
      spec: { name: p.id, short: p.short, kind: p.kind, role: p.role },
      role: p.role,
      mac: `02:00:00:${macBase.toString(16).padStart(2, '0')}:00:${n.toString(16).padStart(2, '0')}`,
      l3: p.ipv4 === undefined ? {} : { ipv4: { address: p.ipv4, prefixLen: 30 } },
    } as unknown as PortState);
  }
  const tables = new Map<string, Table<TableRow>>();
  for (const [t, rows] of Object.entries(tableRows)) tables.set(t, fakeTable(t, rows));
  const dev = {
    id: name.toLowerCase(),
    spec: { id: name.toLowerCase(), type: 'fake', name },
    hostname: name,
    model: { capabilities: [] },
    profile: 'P3',
    running: createConfigAst(),
    macBase: macBase * 0x10000,
    ports: byId,
    tables: { get: (t: TableName) => tables.get(t) },
    port: (id: string) => byId.get(id),
    portView: (id: string) => byId.get(id),
    resolvePortName(text: string): PortResolution {
      for (const p of byId.values()) if (p.id.toLowerCase() === text.toLowerCase() || p.spec.short.toLowerCase() === text.toLowerCase()) return { kind: 'existing', port: p.id };
      return { kind: 'unknown' };
    },
  };
  return dev as unknown as DeviceRuntime;
}

const fakeSim = (...devices: DeviceRuntime[]): Simulation => ({ devices: () => devices }) as unknown as Simulation;

const SE0 = 'Serial0/0/0';
const SE1 = 'Serial0/0/1';
const GI0 = 'GigabitEthernet0/0';
const TU0 = 'Tunnel0';
const TU1 = 'Tunnel1';

const ppp = (port: string, over: Partial<PppRow> = {}): PppRow => ({
  key: port,
  updatedAt: 3 * SEC,
  port,
  phase: 'network',
  lcp: 'opened',
  authLocal: 'chap',
  authLocalState: 'success',
  authPeer: 'chap',
  authPeerState: 'success',
  peerName: 'R2',
  ipcp: 'opened',
  peerAddress: '10.1.1.2',
  magic: 0x1234,
  peerMagic: 0x5678,
  failures: 0,
  since: 3 * SEC,
  ...over,
});

const tunnel = (port: string, over: Partial<TunnelRow> = {}): TunnelRow => ({
  key: port,
  updatedAt: 2 * SEC,
  port,
  mode: 'gre',
  source: '209.165.200.225',
  sourceIface: SE0,
  destination: '209.165.200.230',
  state: 'up',
  transportMtu: 1500,
  ipMtu: 1476,
  since: 2 * SEC,
  ...over,
});

const sa = (port: string, over: Partial<IpsecSaRow> = {}): IpsecSaRow => ({
  key: port,
  updatedAt: 4 * SEC,
  port,
  local: '209.165.200.225',
  peer: '209.165.200.230',
  profile: 'VPN',
  role: 'initiator',
  state: 'established',
  proposal: 'aes-cbc-256 sha256 group14',
  since: 4 * SEC,
  ...over,
});

const R1_PORTS: readonly FakePort[] = [
  { id: GI0, short: 'Gi0/0', kind: 'ethernet', role: 'routed', ipv4: '192.168.1.1' },
  { id: SE0, short: 'Se0/0/0', kind: 'serial', role: 'wan', ipv4: '10.1.1.1' },
  { id: SE1, short: 'Se0/0/1', kind: 'serial', role: 'wan' },
  { id: TU0, short: 'Tu0', kind: 'virtual', role: 'tunnel', ipv4: '172.16.0.1' },
  { id: TU1, short: 'Tu1', kind: 'virtual', role: 'tunnel' },
];

/** R1: PPP up with CHAP on Se0/0/0; Tunnel0 up and protected (SA established). */
const r1 = (rows: Readonly<Record<string, readonly TableRow[]>> = {}): DeviceRuntime =>
  fakeDevice('R1', R1_PORTS, { ppp: [ppp(SE0)], tunnels: [tunnel(TU0, { mode: 'ipsec', ipMtu: 1456 })], 'ipsec-sa': [sa(TU0)], ...rows }, 1);
const r2 = (): DeviceRuntime => fakeDevice('R2', [{ id: SE0, short: 'Se0/0/0', kind: 'serial', role: 'wan', ipv4: '10.1.1.2' }], { ppp: [] }, 2);
const r3 = (): DeviceRuntime => fakeDevice('R3', [{ id: SE0, short: 'Se0/0/0', kind: 'serial', role: 'wan', ipv4: '10.3.3.3' }], {}, 3);

const sources = (): { readonly [P in NeighborProtocol]: NeighborSource | undefined } => ({
  ospf: undefined,
  cdp: undefined,
  lldp: undefined,
  eigrp: undefined,
  ppp: WAN_NEIGHBOR_SOURCES.ppp,
});

function readers(): { readonly [F in LabFactName]: FactReader | undefined } {
  const none = Object.fromEntries(Object.keys(FACT_READERS).map((k) => [k, undefined]));
  return { ...none, ...WAN_FACT_READERS } as { readonly [F in LabFactName]: FactReader | undefined };
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

type WanFact = 'tunnel.up' | 'ppp.lcp' | 'ppp.ipcp' | 'ppp.auth' | 'ipsec.sa';
const read = (name: WanFact, dev: DeviceRuntime, subject?: string): FactReading => WAN_FACT_READERS[name]!.read({ sim: fakeSim(dev), dev, subject });

// ── the source and the readers ───────────────────────────────────────────────

describe('the readers and the source name their table (rule 20)', () => {
  it('each fact declares its type and its table column', () => {
    expect(Object.fromEntries(Object.entries(WAN_FACT_READERS).map(([k, r]) => [k, `${r!.type} ${r!.source}`]))).toEqual({
      'tunnel.up': 'boolean tunnels.state',
      'ppp.lcp': 'string ppp.lcp',
      'ppp.ipcp': 'string ppp.ipcp',
      'ppp.auth': 'string ppp.authLocal',
      'ipsec.sa': 'string ipsec-sa.state',
    });
    for (const r of Object.values(WAN_FACT_READERS)) expect(r!.source.split('.')[0]! in TABLE_DESCRIPTORS).toBe(true);
    expect(WAN_NEIGHBOR_SOURCES.ppp!.table).toBe('ppp');
    expect(Object.keys(WAN_NEIGHBOR_SOURCES)).toEqual(['ppp']);
  });
});

describe('[S19] NEIGHBOR_SOURCES.ppp (the ppp rows; state = the LCP state)', () => {
  it('one neighbour per PPP port: the learnt name and address, labelled by the name, else the address', () => {
    const dev = r1({ ppp: [ppp(SE0), ppp(SE1, { lcp: 'req-sent', phase: 'establish', peerName: undefined, peerAddress: undefined, ipcp: 'initial', authLocalState: undefined }), ppp('Serial0/1/0', { peerName: undefined })] });
    expect(WAN_NEIGHBOR_SOURCES.ppp!.read(dev)).toEqual([
      { iface: SE0, peer: ['R2', '10.1.1.2'], label: 'R2', state: 'opened' },
      { iface: SE1, peer: [], label: 'unidentified', state: 'req-sent' },
      { iface: 'Serial0/1/0', peer: ['10.1.1.2'], label: '10.1.1.2', state: 'opened' },
    ]);
  });

  it('a device whose model keeps no ppp table does not run PPP; an empty table has no neighbours', () => {
    expect(WAN_NEIGHBOR_SOURCES.ppp!.read(r3())).toBeUndefined();
    expect(WAN_NEIGHBOR_SOURCES.ppp!.read(r2())).toEqual([]);
  });

  it('through the neighbor kind: opened passes; a stopped link, a wrong peer or none fail with their details', () => {
    const sim = fakeSim(r1(), r2(), r3());
    expect(neighbor(sim, { device: 'R1', protocol: 'ppp', state: 'opened' })).toBeUndefined();
    expect(neighbor(sim, { device: 'R1', protocol: 'ppp', neighbor: 'R2', iface: 'Se0/0/0', state: 'opened' })).toBeUndefined();
    const failed = fakeSim(r1({ ppp: [ppp(SE0, { lcp: 'stopped', phase: 'dead', authLocalState: 'failed', ipcp: 'initial', peerAddress: undefined })] }), r2());
    expect(neighbor(failed, { device: 'R1', protocol: 'ppp', neighbor: 'R2', state: 'opened' })).toBe('R1 sees PPP neighbour R2 on Se0/0/0 in state stopped, expected in state opened.');
    expect(neighbor(sim, { device: 'R1', protocol: 'ppp', neighbor: 'R3' })).toBe('R1 has no PPP neighbour R3.');
    expect(neighbor(sim, { device: 'R2', protocol: 'ppp', state: 'opened' })).toBe('R2 has no PPP neighbour in state opened.');
    expect(neighbor(sim, { device: 'R3', protocol: 'ppp' })).toBe('R3 does not run PPP.');
  });
});

describe('[S18] tunnel.up (tunnels.state)', () => {
  it('up and down, by long or short name', () => {
    expect(read('tunnel.up', r1(), 'Tunnel0')).toEqual({ value: true });
    expect(read('tunnel.up', r1(), 'tu0')).toEqual({ value: true });
    const down = r1({ tunnels: [tunnel(TU0, { state: 'down', reason: 'no-route' })] });
    expect(read('tunnel.up', down, 'Tu0')).toEqual({ value: false });
  });

  it('an interface without a row has no value; an unknown interface fails with the usual detail', () => {
    expect(read('tunnel.up', r1(), 'Tu1')).toEqual({ value: undefined });
    expect(read('tunnel.up', r1(), 'Gi0/0')).toEqual({ value: undefined });
    expect(read('tunnel.up', r1(), 'Tunnel7')).toEqual({ problem: 'R1 has no interface called Tunnel7.' });
  });

  it('without a subject: the only row, none, or a detail asking for a subject when there are several', () => {
    expect(read('tunnel.up', r1())).toEqual({ value: true });
    expect(read('tunnel.up', r2())).toEqual({ value: undefined });
    const two = r1({ tunnels: [tunnel(TU0), tunnel(TU1, { state: 'down', reason: 'no-source' })] });
    expect(read('tunnel.up', two)).toEqual({ problem: 'R1 has 2 tunnels (Tu0, Tu1), so tunnel.up needs a subject naming one.' });
  });

  it('wrong answers fail with what was found', () => {
    const down = fakeSim(r1({ tunnels: [tunnel(TU0, { state: 'down', reason: 'ike-negotiating' })] }));
    expect(fact(down, { device: 'R1', fact: 'tunnel.up', subject: 'Tunnel0', equals: true })).toBe('R1 tunnel.up of Tunnel0 is false, expected true.');
    expect(fact(fakeSim(r1()), { device: 'R1', fact: 'tunnel.up', subject: 'Tunnel0', equals: true })).toBeUndefined();
    expect(fact(fakeSim(r1()), { device: 'R1', fact: 'tunnel.up', subject: 'Tunnel1', equals: true })).toBe('R1 tunnel.up of Tunnel1 is not set, expected true.');
    expect(fact(fakeSim(r1()), { device: 'R1', fact: 'tunnel.up', subject: 'Tunnel9', equals: true })).toBe('R1 has no interface called Tunnel9.');
  });
});

describe('[S19] ppp.lcp, ppp.ipcp and ppp.auth (the ppp row)', () => {
  it('read from the subject port’s row', () => {
    const dev = r1({ ppp: [ppp(SE0), ppp(SE1, { lcp: 'ack-sent', ipcp: 'initial', authLocal: 'pap', authLocalState: undefined })] });
    expect(read('ppp.lcp', dev, 'Se0/0/0')).toEqual({ value: 'opened' });
    expect(read('ppp.ipcp', dev, 'Se0/0/0')).toEqual({ value: 'opened' });
    expect(read('ppp.auth', dev, 'Se0/0/0')).toEqual({ value: 'chap' });
    expect(read('ppp.lcp', dev, SE1)).toEqual({ value: 'ack-sent' });
    expect(read('ppp.ipcp', dev, SE1)).toEqual({ value: 'initial' });
    expect(read('ppp.auth', dev, SE1)).toEqual({ value: 'pap' });
    expect(read('ppp.auth', r1({ ppp: [ppp(SE0, { authLocal: 'none', authLocalState: undefined })] }), 'Se0/0/0')).toEqual({ value: 'none' });
  });

  it('no row: no value; several rows and no subject: a detail; an unknown interface: the usual detail', () => {
    expect(read('ppp.lcp', r1(), 'Se0/0/1')).toEqual({ value: undefined });
    expect(read('ppp.ipcp', r1())).toEqual({ value: 'opened' }); // the only row
    const two = r1({ ppp: [ppp(SE0), ppp(SE1)] });
    expect(read('ppp.ipcp', two)).toEqual({ problem: 'R1 has 2 PPP interfaces (Se0/0/0, Se0/0/1), so ppp.ipcp needs a subject naming one.' });
    expect(read('ppp.auth', r1(), 'Se0/3/0')).toEqual({ problem: 'R1 has no interface called Se0/3/0.' });
  });

  it('wrong answers fail with what was found', () => {
    const failed = fakeSim(r1({ ppp: [ppp(SE0, { lcp: 'stopped', ipcp: 'initial', authLocal: 'pap' })] }));
    expect(fact(failed, { device: 'R1', fact: 'ppp.lcp', subject: 'Se0/0/0', equals: 'opened' })).toBe('R1 ppp.lcp of Se0/0/0 is stopped, expected opened.');
    expect(fact(failed, { device: 'R1', fact: 'ppp.ipcp', equals: 'opened' })).toBe('R1 ppp.ipcp is initial, expected opened.');
    expect(fact(failed, { device: 'R1', fact: 'ppp.auth', subject: 'Se0/0/0', equals: 'chap' })).toBe('R1 ppp.auth of Se0/0/0 is pap, expected chap.');
    expect(fact(fakeSim(r1()), { device: 'R1', fact: 'ppp.auth', subject: 'Se0/0/0', equals: 'chap' })).toBeUndefined();
  });
});

describe('[C13] ipsec.sa (ipsec-sa.state)', () => {
  it('the SA state of the subject tunnel', () => {
    expect(read('ipsec.sa', r1(), 'Tunnel0')).toEqual({ value: 'established' });
    expect(read('ipsec.sa', r1({ 'ipsec-sa': [sa(TU0, { state: 'negotiating' })] }), 'Tu0')).toEqual({ value: 'negotiating' });
    expect(read('ipsec.sa', r1(), 'Tu1')).toEqual({ value: undefined });
    expect(read('ipsec.sa', r3(), 'Se0/0/0')).toEqual({ value: undefined }); // no ipsec-sa table
    expect(read('ipsec.sa', r1(), 'Tunnel5')).toEqual({ problem: 'R1 has no interface called Tunnel5.' });
    const two = r1({ 'ipsec-sa': [sa(TU0), sa(TU1)] });
    expect(read('ipsec.sa', two)).toEqual({ problem: 'R1 has 2 protected tunnels (Tu0, Tu1), so ipsec.sa needs a subject naming one.' });
  });

  it('wrong answers fail with what was found', () => {
    const wrongKey = fakeSim(r1({ 'ipsec-sa': [sa(TU0, { state: 'failed', reason: 'ike-failed' })] }));
    expect(fact(wrongKey, { device: 'R1', fact: 'ipsec.sa', subject: 'Tunnel0', equals: 'established' })).toBe('R1 ipsec.sa of Tunnel0 is failed, expected established.');
    expect(fact(fakeSim(r1()), { device: 'R1', fact: 'ipsec.sa', subject: 'Tunnel0', equals: 'established' })).toBeUndefined();
  });
});
