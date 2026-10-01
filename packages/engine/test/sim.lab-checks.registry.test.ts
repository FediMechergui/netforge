/**
 * sim — the grader registry (ARCHITECTURE-P3 D5, §2.10, §7 W1 sim): sim/lab-checks/registry.ts and the frameworks of
 * sim/lab-checks/facts.ts.
 *
 * Pinned here:
 *   • CHECKERS is exhaustive: exactly one checker per `LabAssertion` kind (the typed record below fails to compile when
 *     a kind is added to the contract, and the key list is compared exactly);
 *   • the kinds a later wave item brings fail with their one original detail (the W0 texts), and so does every
 *     neighbour protocol and every fact whose source or reader is not built yet (exhaustive over NeighborProtocol and
 *     LabFactName);
 *   • the one dispatch: an unknown kind, an error thrown while reading, and the feedback envelope (a failing assertion
 *     shows its feedback after its detail; `misconception` is never shown; a passing one shows nothing);
 *   • the identity framework (names, hostnames, addresses, MACs; canonical forms), and the neighbour and fact
 *     frameworks against fake sources and readers on a real world, one passing and one failing case per member.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { portMac } from '../src/contracts/addr.js';
import type { LabAssertion, LabFactName, LabTask, NeighborProtocol, ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { Topology } from '../src/contracts/topology.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import {
  FACT_READERS,
  IDENTITY_SOURCES,
  NEIGHBOR_PROTOCOL_LABELS,
  NEIGHBOR_SOURCES,
  checkFact,
  checkNeighbor,
  identitiesOf,
  identityKey,
  type FactReader,
  type IdentitySource,
  type IdentitySourceName,
  type NeighborSource,
  type NeighborView,
} from '../src/sim/lab-checks/facts.js';
import { CHECKERS, UNAVAILABLE_KIND_DETAILS, runCheck, withNotes } from '../src/sim/lab-checks/registry.js';
import { pcRouterPc } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';

/** Every assertion kind of the contract (a missing or extra key does not compile). */
const KINDS: { readonly [K in LabAssertion['kind']]: true } = {
  config: true,
  port: true,
  table: true,
  process: true,
  link: true,
  counter: true,
  connectivity: true,
  traceSeen: true,
  vlan: true,
  switchport: true,
  stp: true,
  etherchannel: true,
  portSecurity: true,
  route: true,
  nat: true,
  fhrp: true,
  neighbor: true,
  fact: true,
  acl: true,
  aclDecision: true,
  service: true,
  path: true,
  traffic: true,
};

/** Every neighbour protocol, with the detail its W1 stub gives. */
const NEIGHBOR_STUBS: { readonly [P in NeighborProtocol]: string } = {
  ospf: 'OSPF neighbour checks are not available in this build.',
  cdp: 'CDP neighbour checks are not available in this build.',
  lldp: 'LLDP neighbour checks are not available in this build.',
  ppp: 'PPP neighbour checks are not available in this build.',
  eigrp: 'EIGRP neighbour checks are not available in this build.',
};

/** Every fact name (a missing or extra key does not compile). */
const FACTS: { readonly [F in LabFactName]: true } = {
  'ospf.routerId': true,
  'ospf.referenceBandwidthMbps': true,
  'ospf.defaultOriginate': true,
  'ospf.ifaceArea': true,
  'ospf.ifaceCost': true,
  'ospf.ifaceNetworkType': true,
  'ospf.ifaceState': true,
  'ospf.ifacePriority': true,
  'ospf.passive': true,
  'ospf.lsdbSynced': true,
  'snooping.enabled': true,
  'dai.enabled': true,
  'dai.dropped': true,
  'snooping.trusted': true,
  'dai.trusted': true,
  'snooping.bindingPort': true,
  'ssh.enabled': true,
  'ssh.version': true,
  'ssh.keyBits': true,
  'vty.transport': true,
  'vty.loginLocal': true,
  'vty.accessClass': true,
  'qos.inputPolicy': true,
  'qos.outputPolicy': true,
  'cdp.enabled': true,
  'lldp.enabled': true,
  'ntp.synced': true,
  'ntp.peer': true,
  'ntp.stratum': true,
  'clock.source': true,
  'clock.offsetMs': true,
  'vty.logins': true,
  'tunnel.up': true,
  'ppp.lcp': true,
  'ppp.ipcp': true,
  'ppp.auth': true,
  'qos.admitted': true,
  'logging.buffered': true,
  'logging.trap': true,
  'automation.lastRun': true,
  'eigrp.fd': true,
  'eigrp.successor': true,
  'eigrp.feasibleSuccessor': true,
  'eigrp.kValues': true,
  'ipsec.sa': true,
};

/** A lab of one task per assertion (points 1 each), graded as the worker grades it. */
function lab(assertions: readonly LabAssertion[], topo: Topology = pcRouterPc()): ScenarioInfo {
  const tasks: LabTask[] = assertions.map((a, i) => ({ id: `t${i}`, title: `t${i}`, description: '', points: 1, assertions: [a] }));
  return { name: 'registry-test', title: 'Registry test', description: '', category: 'ccna3-lab', build: () => topo, tasks };
}

/** The one detail of each task (undefined for a passing one). */
function details(sim: Simulation, assertions: readonly LabAssertion[]): (string | undefined)[] {
  return evaluateLab(sim, lab(assertions)).results.map((r) => r.assertions[0]?.detail);
}

let world: Simulation;
beforeAll(() => {
  world = createSimulation({ seed: 5 });
  world.loadTopology(pcRouterPc());
  world.runFor(60 * SEC);
  const r1 = [...world.devices()].find((d) => d.spec.name === 'R1')!;
  // a hostname that differs from the topology name, so both identities are exercised
  const res = world.configure(r1.id, ['hostname EDGE']);
  expect(res.ok).toBe(true);
});

const dev = (name: string) => [...world.devices()].find((d) => d.spec.name === name)!;

describe('the registry is exhaustive', () => {
  it('has exactly one checker per LabAssertion kind', () => {
    expect(Object.keys(CHECKERS).sort()).toEqual(Object.keys(KINDS).sort());
    for (const k of Object.keys(CHECKERS)) expect(typeof (CHECKERS as Record<string, unknown>)[k]).toBe('function');
  });

  it('every neighbour protocol and every fact has an entry (all waiting for the W3 adapters)', () => {
    expect(Object.keys(NEIGHBOR_SOURCES).sort()).toEqual(Object.keys(NEIGHBOR_STUBS).sort());
    expect(Object.keys(NEIGHBOR_PROTOCOL_LABELS).sort()).toEqual(Object.keys(NEIGHBOR_STUBS).sort());
    expect(Object.keys(FACT_READERS).sort()).toEqual(Object.keys(FACTS).sort());
    for (const p of Object.keys(NEIGHBOR_STUBS) as NeighborProtocol[]) expect(NEIGHBOR_SOURCES[p]).toBeUndefined();
    for (const f of Object.keys(FACTS) as LabFactName[]) expect(FACT_READERS[f]).toBeUndefined();
    expect(Object.keys(IDENTITY_SOURCES)).toEqual(['name', 'address', 'mac', 'ospf', 'eigrp']);
    expect(IDENTITY_SOURCES.ospf).toBeUndefined();
    expect(IDENTITY_SOURCES.eigrp).toBeUndefined();
  });
});

describe('stub details', () => {
  it('the kinds a later item brings fail with their W0 detail', () => {
    const probe = { proto: 'tcp', src: '10.0.0.1', dst: '10.0.1.1', dstPort: 80 } as const;
    const got = details(world, [
      { kind: 'acl', device: 'R1', list: '101' },
      { kind: 'aclDecision', device: 'R1', list: '101', packet: probe, expect: 'deny' },
      { kind: 'service', from: 'PC1', to: 'R1', service: 'ssh', expect: 'success' },
      { kind: 'path', from: 'PC1', to: 'PC2', via: ['R1'] },
      { kind: 'traffic', flows: [], runMs: 1000, expect: [] },
    ]);
    expect(got).toEqual([
      'Access list checks are not available in this build.',
      'Access list decision checks are not available in this build.',
      'Remote login checks are not available in this build.',
      'Path checks are not available in this build.',
      'Traffic flow checks are not available in this build.',
    ]);
    expect(Object.values(UNAVAILABLE_KIND_DETAILS)).toEqual(got);
  });

  it('every neighbour protocol fails with its own detail', () => {
    const protocols = Object.keys(NEIGHBOR_STUBS) as NeighborProtocol[];
    const got = details(
      world,
      protocols.map((protocol): LabAssertion => ({ kind: 'neighbor', device: 'R1', protocol, state: 'full' })),
    );
    expect(got).toEqual(protocols.map((p) => NEIGHBOR_STUBS[p]));
  });

  it('every fact fails with its own detail', () => {
    const facts = Object.keys(FACTS) as LabFactName[];
    const got = details(
      world,
      facts.map((fact): LabAssertion => ({ kind: 'fact', device: 'R1', fact, equals: true })),
    );
    expect(got).toEqual(facts.map((f) => `The ${f} fact is not available in this build.`));
  });
});

describe('the dispatch', () => {
  it('refuses a kind it does not know, and one that names no known protocol or fact', () => {
    const got = details(world, [
      { kind: 'bogus' } as unknown as LabAssertion,
      { kind: 'neighbor', device: 'R1', protocol: 'rip' as NeighborProtocol },
      { kind: 'fact', device: 'R1', fact: 'rip.version' as LabFactName },
    ]);
    expect(got).toEqual([
      '"bogus" is not a check this grader knows.',
      '"rip" is not a neighbour protocol this grader knows.',
      '"rip.version" is not a fact this grader knows.',
    ]);
  });

  it('turns an error thrown while reading into the failing detail', () => {
    const broken = {
      devices() {
        throw new Error('The world could not be read.');
      },
    } as unknown as Simulation;
    expect(runCheck({ sim: broken, host: undefined }, { kind: 'config', device: 'R1', path: 'hostname' })).toEqual({
      pass: false,
      detail: 'The world could not be read.',
    });
  });

  it('refuses a ping without a clone host (a follow-up check)', () => {
    expect(runCheck({ sim: world, host: undefined }, { kind: 'connectivity', from: 'PC1', to: 'PC2', expect: 'success' })).toEqual({
      pass: false,
      detail: 'A follow-up check reads state; it cannot ping again.',
    });
  });
});

describe('the feedback envelope', () => {
  it('shows the feedback after the detail of a failing assertion, never the misconception', () => {
    const got = details(world, [
      { kind: 'config', device: 'R1', path: 'hostname', equals: 'CORE', feedback: 'Name the router as the diagram says.', misconception: 'hostname-is-topology-name' },
      { kind: 'config', device: 'R1', path: 'hostname', equals: 'EDGE', feedback: 'Never shown on a pass.' },
      { kind: 'config', device: 'R1', path: 'banner', exists: true, feedback: '   ' },
      { kind: 'config', device: 'R1', path: 'banner', exists: true, misconception: 'banners' },
    ]);
    expect(got).toEqual([
      'R1 hostname is "EDGE", expected "CORE". Name the router as the diagram says.',
      undefined,
      'R1 has no configuration line at banner.',
      'R1 has no configuration line at banner.',
    ]);
  });

  it('applies to the stub details and to the static checks of connectivity.then', () => {
    const got = details(world, [
      { kind: 'acl', device: 'R1', list: '1', feedback: 'Come back after the ACL lesson.' },
      {
        kind: 'connectivity',
        from: 'PC1',
        to: 'PC2',
        expect: 'success',
        then: [{ kind: 'config', device: 'R1', path: 'no-such-line', exists: true, feedback: 'Inner advice.' }],
        feedback: 'Outer advice.',
      },
    ]);
    expect(got).toEqual([
      'Access list checks are not available in this build. Come back after the ACL lesson.',
      'After the ping from PC1: R1 has no configuration line at no-such-line. Inner advice. Outer advice.',
    ]);
  });

  it('withNotes leaves passing checks alone and keeps a detail-less failure readable', () => {
    expect(withNotes({ pass: true }, { feedback: 'x' })).toEqual({ pass: true });
    expect(withNotes({ pass: false }, { feedback: 'Try again.' })).toEqual({ pass: false, detail: 'Try again.' });
    expect(withNotes({ pass: false, detail: 'Wrong.' }, {})).toEqual({ pass: false, detail: 'Wrong.' });
  });
});

describe('identities', () => {
  it('canonical keys: MACs in any notation, IPv4 and IPv6 in any valid form, else the text', () => {
    expect(identityKey('AABB.CCDD.EEFF')).toBe('mac:aa:bb:cc:dd:ee:ff');
    expect(identityKey('aa-bb-cc-dd-ee-ff')).toBe('mac:aa:bb:cc:dd:ee:ff');
    expect(identityKey(' 10.0.0.1 ')).toBe('ip:10.0.0.1');
    expect(identityKey('2001:DB8:0:0:0:0:0:1')).toBe(identityKey('2001:db8::1'));
    expect(identityKey('2001:db8::1').startsWith('ip6:')).toBe(true);
    expect(identityKey('R1')).toBe('name:R1');
  });

  it('a device is its topology name, its hostname, every interface address, its base MAC and its port MACs', () => {
    const r1 = dev('R1');
    const ids = identitiesOf(r1);
    expect(ids.has('name:R1')).toBe(true);
    expect(ids.has('name:EDGE')).toBe(true);
    expect(ids.has('ip:10.0.0.254')).toBe(true);
    expect(ids.has('ip:10.0.1.254')).toBe(true);
    expect(ids.has(`mac:${portMac(r1.macBase, 0)}`)).toBe(true);
    for (const p of r1.ports.values()) expect(ids.has(`mac:${p.mac}`)).toBe(true);
    expect(ids.has('ip:10.0.0.1')).toBe(false);
    expect(ids.has('name:PC1')).toBe(false);
  });

  it('an area adds its identities through its source (a fake router id here)', () => {
    const sources: { readonly [N in IdentitySourceName]: IdentitySource | undefined } = {
      ...IDENTITY_SOURCES,
      ospf: { source: 'ospf-interfaces.routerId', read: (d) => (d.spec.name === 'R1' ? ['1.1.1.1'] : []) },
    };
    expect(identitiesOf(dev('R1'), sources).has('ip:1.1.1.1')).toBe(true);
    expect(identitiesOf(dev('R1')).has('ip:1.1.1.1')).toBe(false);
  });
});

describe('the neighbour framework (fake sources on a real world)', () => {
  const r1 = (): ReturnType<typeof dev> => dev('R1');
  /** R1 sees PC1 on Gi0/0 (full, dr) by its address and PC2 on Gi0/1 (2way, drother) by its MAC; nothing elsewhere. */
  function sources(): { readonly [P in NeighborProtocol]: NeighborSource | undefined } {
    const views = (): NeighborView[] => [
      { iface: 'GigabitEthernet0/0', peer: ['10.0.0.1', '9.9.9.1'], label: '9.9.9.1', state: 'full', role: 'dr' },
      { iface: 'GigabitEthernet0/1', peer: [[...dev('PC2').ports.values()][0]!.mac.toUpperCase()], label: 'PC2', state: '2way', role: 'drother' },
    ];
    return { ...NEIGHBOR_SOURCES, ospf: { table: 'ospf-neighbors', read: (d) => (d.id === r1().id ? views() : undefined) } };
  }
  const check = (a: Omit<Extract<LabAssertion, { kind: 'neighbor' }>, 'kind' | 'protocol'>) =>
    checkNeighbor(world, { kind: 'neighbor', protocol: 'ospf', ...a }, sources());

  it('finds a neighbour by device name through any identity (an address, a MAC in another notation)', () => {
    expect(check({ device: 'R1', neighbor: 'PC1' })).toEqual({ pass: true });
    expect(check({ device: 'R1', neighbor: 'PC2', state: '2WAY', role: 'drother' })).toEqual({ pass: true });
    expect(check({ device: 'R1', neighbor: '9.9.9.1', iface: 'Gi0/0', state: 'full', role: 'dr' })).toEqual({ pass: true });
  });

  it('names what it found when the state or role is wrong, or the neighbour is missing', () => {
    expect(check({ device: 'R1', neighbor: 'PC2', state: 'full' })).toEqual({
      pass: false,
      detail: 'R1 sees OSPF neighbour PC2 on Gi0/1 in state 2way, expected in state full.',
    });
    expect(check({ device: 'R1', neighbor: 'PC1', role: 'bdr' })).toEqual({ pass: false, detail: 'R1 sees OSPF neighbour 9.9.9.1 on Gi0/0 as dr, expected as bdr.' });
    expect(check({ device: 'R1', neighbor: 'PC1', iface: 'Gi0/1' })).toEqual({ pass: false, detail: 'R1 has no OSPF neighbour PC1 on Gi0/1.' });
    expect(check({ device: 'PC1' })).toEqual({ pass: false, detail: 'PC1 does not run OSPF.' });
  });

  it('exists false, count and minCount count the rows that match every given field', () => {
    expect(check({ device: 'R1', neighbor: 'PC1', exists: false })).toEqual({ pass: false, detail: 'R1 still has OSPF neighbour PC1 (9.9.9.1 on Gi0/0).' });
    expect(check({ device: 'R1', neighbor: 'PC1', state: 'init', exists: false })).toEqual({ pass: true });
    expect(check({ device: 'PC1', exists: false })).toEqual({ pass: true });
    expect(check({ device: 'R1', count: 2 })).toEqual({ pass: true });
    expect(check({ device: 'R1', state: 'full', count: 2 })).toEqual({ pass: false, detail: 'R1 has 1 OSPF neighbour in state full, expected exactly 2.' });
    expect(check({ device: 'R1', minCount: 1, state: 'full' })).toEqual({ pass: true });
    expect(check({ device: 'R1', minCount: 3 })).toEqual({ pass: false, detail: 'R1 has 2 OSPF neighbours, expected at least 3.' });
    expect(check({ device: 'PC1', count: 0 })).toEqual({ pass: true });
  });

  it('fails readably for an unknown device, interface or neighbour name', () => {
    expect(check({ device: 'R9' })).toEqual({ pass: false, detail: 'There is no device called R9 in this topology.' });
    expect(check({ device: 'R1', iface: 'Gi9/9' })).toEqual({ pass: false, detail: 'R1 has no interface called Gi9/9.' });
    expect(check({ device: 'R1', neighbor: 'Nowhere' })).toEqual({ pass: false, detail: 'There is no device called Nowhere in this topology.' });
  });
});

describe('the fact framework (fake readers on a real world)', () => {
  const reader = (type: FactReader['type'], values: Record<string, string | number | boolean | undefined>): FactReader => ({
    type,
    source: 'test data',
    read: ({ dev: d, subject }) => {
      if (subject === 'bad') return { problem: `${d.spec.name} has no interface called bad.` };
      return { value: values[`${d.spec.name}|${subject ?? ''}`] };
    },
  });
  const readers = {
    ...FACT_READERS,
    'ospf.routerId': reader('address', { 'R1|': '10.0.1.254', 'PC1|': undefined }),
    'ospf.ifaceCost': reader('number', { 'R1|Gi0/0': 10, 'R1|Gi0/1': 64 }),
    'ospf.passive': reader('boolean', { 'R1|Gi0/0': true }),
    'clock.source': reader('string', { 'R1|': 'ntp' }),
  };
  const check = (a: Omit<Extract<LabAssertion, { kind: 'fact' }>, 'kind'>) => checkFact(world, { kind: 'fact', ...a }, readers);

  it('compares strings, numbers and booleans by text', () => {
    expect(check({ device: 'R1', fact: 'clock.source', equals: 'ntp' })).toEqual({ pass: true });
    expect(check({ device: 'R1', fact: 'clock.source', equals: 'user' })).toEqual({ pass: false, detail: 'R1 clock.source is ntp, expected user.' });
    expect(check({ device: 'R1', fact: 'ospf.ifaceCost', subject: 'Gi0/0', equals: 10 })).toEqual({ pass: true });
    expect(check({ device: 'R1', fact: 'ospf.ifaceCost', subject: 'Gi0/0', equals: '10' })).toEqual({ pass: true });
    expect(check({ device: 'R1', fact: 'ospf.passive', subject: 'Gi0/0', equals: true })).toEqual({ pass: true });
    expect(check({ device: 'R1', fact: 'ospf.passive', subject: 'Gi0/0', equals: false })).toEqual({ pass: false, detail: 'R1 ospf.passive of Gi0/0 is true, expected false.' });
  });

  it('compares an address fact against a device name through its identities, or against a literal address', () => {
    expect(check({ device: 'R1', fact: 'ospf.routerId', equals: 'R1' })).toEqual({ pass: true });
    expect(check({ device: 'R1', fact: 'ospf.routerId', equals: '10.0.1.254' })).toEqual({ pass: true });
    expect(check({ device: 'R1', fact: 'ospf.routerId', equals: 'PC2' })).toEqual({ pass: false, detail: 'R1 ospf.routerId is 10.0.1.254, expected PC2.' });
    expect(check({ device: 'R1', fact: 'ospf.routerId', equals: 'Nowhere' })).toEqual({ pass: false, detail: 'There is no device called Nowhere in this topology.' });
  });

  it('bounds a number with atLeast and atMost, and refuses bounds on other types', () => {
    expect(check({ device: 'R1', fact: 'ospf.ifaceCost', subject: 'Gi0/1', atLeast: 64, atMost: 64 })).toEqual({ pass: true });
    expect(check({ device: 'R1', fact: 'ospf.ifaceCost', subject: 'Gi0/1', atMost: 10 })).toEqual({
      pass: false,
      detail: 'R1 ospf.ifaceCost of Gi0/1 is 64, expected at most 10.',
    });
    expect(check({ device: 'R1', fact: 'ospf.ifaceCost', subject: 'Gi0/0', equals: 10, atLeast: 20 })).toEqual({
      pass: false,
      detail: 'R1 ospf.ifaceCost of Gi0/0 is 10, expected 10 and at least 20.',
    });
    expect(check({ device: 'R1', fact: 'clock.source', atLeast: 1 })).toEqual({ pass: false, detail: 'clock.source is not a number, so it cannot be bounded with atLeast or atMost.' });
  });

  it('with nothing to compare, the fact must be present; an absent fact never equals anything', () => {
    expect(check({ device: 'R1', fact: 'clock.source' })).toEqual({ pass: true });
    expect(check({ device: 'PC1', fact: 'ospf.routerId' })).toEqual({ pass: false, detail: 'PC1 ospf.routerId is not set.' });
    expect(check({ device: 'PC1', fact: 'ospf.routerId', equals: 'R1' })).toEqual({ pass: false, detail: 'PC1 ospf.routerId is not set, expected R1.' });
    expect(check({ device: 'R1', fact: 'ospf.ifaceCost', subject: 'Gi0/2', atLeast: 1 })).toEqual({ pass: false, detail: 'R1 ospf.ifaceCost of Gi0/2 is not set, expected at least 1.' });
  });

  it("passes a reader's problem through, and an unknown device fails as usual", () => {
    expect(check({ device: 'R1', fact: 'ospf.ifaceCost', subject: 'bad', equals: 1 })).toEqual({ pass: false, detail: 'R1 has no interface called bad.' });
    expect(check({ device: 'R9', fact: 'clock.source', equals: 'ntp' })).toEqual({ pass: false, detail: 'There is no device called R9 in this topology.' });
  });
});
