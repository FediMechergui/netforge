/**
 * io — the lab document [S37] (ARCHITECTURE-P3 D6, §2.13; §7 W5 io): `labDocumentOf` / `scenarioOf`
 * (contracts/lab-document.ts, ruling R8) and the zod schema of io/lab-schema.ts.
 *
 *   • the round trip over every CCNA 1 and CCNA 2 lab: lab → document → JSON text → schema → scenario, with `build()`
 *     deep-equal and tasks, faults and solution equal (the CCNA 3 labs join in W7's `accept.p3.lab-document`);
 *   • what each helper writes and derives (version 1, the topology's seed, the sorted `requires`, the category);
 *   • every assertion kind of §2.10, each with every one of its members, passes the schema unchanged;
 *   • wrong documents are refused, each with the readable, path-qualified line it earns.
 */
import { describe, expect, it } from 'vitest';
import { labDocumentOf, scenarioOf, type LabDocument } from '../src/contracts/lab-document.js';
import type { LabAssertion, ScenarioInfo } from '../src/contracts/scenario.js';
import {
  LAB_DOCUMENT_FORMAT,
  MAX_LAB_PARAMS_DEPTH,
  MAX_LAB_TASKS,
  labDocumentFromJson,
  labDocumentSchema,
  labDocumentToJson,
  parseLabDocument,
  validateLabDocument,
} from '../src/io/lab-schema.js';
import { CCNA1_LABS } from '../src/sim/scenarios/ccna1/index.js';
import { CCNA2_LABS } from '../src/sim/scenarios/ccna2/index.js';
import { TEMPLATES } from '../src/sim/scenarios/templates.js';

/** A document as plain JSON, edited by the wrong-document cases. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = { [key: string]: any };

const jsonCopy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ── the round trip ────────────────────────────────────────────────────────

const LABS: readonly ScenarioInfo[] = [...CCNA1_LABS, ...CCNA2_LABS];

describe('the round trip over every CCNA 1 and CCNA 2 lab: JSON → schema → scenario', () => {
  it('covers both courses, every lab once', () => {
    expect(CCNA1_LABS.length).toBeGreaterThan(0);
    expect(CCNA2_LABS.length).toBeGreaterThan(0);
    expect(new Set(LABS.map((l) => l.name)).size).toBe(LABS.length);
    expect(LABS.every((l) => (l.tasks?.length ?? 0) > 0)).toBe(true);
  });

  it.each(LABS.map((lab) => [lab.name, lab] as const))('%s', (_name, lab) => {
    const doc = labDocumentOf(lab);
    const parsed = labDocumentFromJson(labDocumentToJson(doc));
    // the schema keeps every member of the document, unchanged
    expect(parsed).toStrictEqual(doc);

    const back = scenarioOf(parsed);
    expect(back.build()).toStrictEqual(lab.build());
    expect(back.tasks).toStrictEqual(lab.tasks);
    expect(back.faults).toStrictEqual(lab.faults);
    expect(back.solution).toStrictEqual(lab.solution);
    const kept = (s: ScenarioInfo) => [s.name, s.title, s.course, s.topic, s.seed, s.concept, s.instructions, s.category];
    expect(kept(back)).toStrictEqual(kept(lab));
    // derived: the catalog types the topology uses, as a sorted set (every lab lists exactly those)
    expect(back.requires).toStrictEqual([...new Set(lab.requires)].sort());
    expect(back.version).toBe(1);

    // and back again: the scenario's document is the same document
    expect(labDocumentOf(back)).toStrictEqual(doc);
  });

  it('also carries every template (no tasks, no seed of its own): build() deep-equal, category template', () => {
    for (const t of TEMPLATES) {
      const back = scenarioOf(labDocumentFromJson(labDocumentToJson(labDocumentOf(t))));
      expect(back.build(), t.name).toStrictEqual(t.build());
      expect(back.category, t.name).toBe('template');
      expect(back.tasks, t.name).toEqual([]);
    }
  });
});

// ── what the helpers write ────────────────────────────────────────────────

describe('labDocumentOf and scenarioOf', () => {
  const lab = CCNA2_LABS.find((l) => (l.faults?.length ?? 0) > 0)!;

  it('writes the format, the metadata it has a place for, the built topology, tasks, faults and solution', () => {
    const doc = labDocumentOf(lab);
    expect(doc.format).toBe(LAB_DOCUMENT_FORMAT);
    expect(doc.format).toBe('netforge.lab/1');
    expect(Object.keys(doc)).toEqual(['format', 'meta', 'topology', 'tasks', 'faults', 'solution']);
    expect(doc.meta).toStrictEqual({ name: lab.name, version: 1, title: lab.title, seed: lab.seed, course: lab.course, topic: lab.topic, instructions: lab.instructions });
    expect(doc.topology).toStrictEqual(lab.build());
    // JSON-exact: no member is undefined, so the text parses back to the same data
    expect(JSON.parse(JSON.stringify(doc))).toStrictEqual(doc);
  });

  it('keeps a lab version, falls back to the topology seed, and leaves out undefined members', () => {
    const base = TEMPLATES[0]!;
    const versioned: ScenarioInfo = { ...base, version: 4, tasks: [{ id: 't', title: 'T', description: '', points: 1, hint: undefined, assertions: [{ kind: 'link', a: 'PC1', b: 'SW1' }] }] };
    const doc = labDocumentOf(versioned);
    expect(doc.meta.version).toBe(4);
    expect(doc.meta.seed).toBe(base.build().seed);
    expect(doc.tasks[0]).not.toHaveProperty('hint');
    expect(doc).not.toHaveProperty('faults');
    expect(doc).not.toHaveProperty('solution');
  });

  it('shares nothing with the lab or the document: build() is a fresh copy on every call', () => {
    const doc = labDocumentOf(lab);
    (doc.tasks[0]!.assertions as LabAssertion[]).length = 0;
    expect(lab.tasks![0]!.assertions.length).toBeGreaterThan(0);

    const fresh = labDocumentOf(lab);
    const s = scenarioOf(fresh);
    const first = s.build();
    first.devices.length = 0;
    expect(s.build().devices.length).toBe(fresh.topology.devices.length);
    expect(fresh.topology.devices.length).toBeGreaterThan(0);
    (fresh.tasks as unknown as unknown[]).length = 0;
    expect(s.tasks!.length).toBe(lab.tasks!.length);
  });

  it('derives what a document does not carry: requires, category and an empty description', () => {
    const doc = labDocumentOf(lab);
    const s = scenarioOf(doc);
    expect(s.requires).toStrictEqual([...new Set(doc.topology.devices.map((d) => d.type))].sort());
    expect(s.description).toBe('');
    expect(s.category).toBe('ccna2-lab');
    expect(scenarioOf({ ...doc, meta: { ...doc.meta, course: 'CCNA 3' } }).category).toBe('ccna3-lab');
    const { course: _course, ...noCourse } = doc.meta;
    expect(scenarioOf({ ...doc, meta: noCourse }).category).toBe('lab');
    expect(scenarioOf({ ...doc, meta: noCourse, tasks: [] }).category).toBe('template');
    for (const member of ['labType', 'objectives', 'tags', 'difficulty', 'estimatedMinutes', 'customChecks']) expect(s).not.toHaveProperty(member);
  });
});

// ── every assertion kind, every member ────────────────────────────────────

type Kind = LabAssertion['kind'];

/** One assertion of every kind of §2.10 with EVERY member set (the compiler holds both lists complete). */
const EVERY_KIND: { readonly [K in Kind]: Required<Extract<LabAssertion, { kind: K }>> } = {
  config: { kind: 'config', device: 'R1', path: 'interface GigabitEthernet0/0/ip address', equals: ['192.168.1.1 255.255.255.0'], exists: true, contains: '192.168', count: 1, feedback: 'Address the LAN side.', misconception: 'mask' },
  port: { kind: 'port', device: 'R1', port: 'Gi0/0', field: 'operUp', equals: true, feedback: 'f', misconception: 'm' },
  table: {
    kind: 'table',
    device: 'R1',
    table: 'ospf-neighbors',
    where: { state: 'full', priority: 1, dr: false },
    exists: true,
    minCount: 1,
    maxCount: 3,
    whereOps: { deadMs: { op: 'lt', value: 40000 }, iface: { op: 'contains', value: 'Gigabit' } },
    feedback: 'f',
    misconception: 'm',
  },
  process: { kind: 'process', device: 'PC1', process: 'dhcp-client', path: 'leases.iface=GigabitEthernet0.state', equals: 'bound', feedback: 'f', misconception: 'm' },
  link: { kind: 'link', a: 'PC1', b: 'SW1', media: 'copper-straight', up: true, feedback: 'f', misconception: 'm' },
  counter: { kind: 'counter', device: 'R1', port: 'GigabitEthernet0/0', counter: 'aclDenies', op: 'gt', value: 0, feedback: 'f', misconception: 'm' },
  connectivity: {
    kind: 'connectivity',
    from: 'PC1',
    to: 'R2',
    family: 4,
    byName: false,
    expect: 'fail',
    timeoutMs: 3000,
    after: [
      { cut: { a: 'R1', b: 'R2', aPort: 'GigabitEthernet0/1', bPort: 'GigabitEthernet0/1' } },
      { powerOff: 'PC2' },
      { shutdown: { device: 'R1', port: 'GigabitEthernet0/0' } },
      { config: { device: 'R2', lines: ['interface GigabitEthernet0/1', ' shutdown'] } },
    ],
    settleMs: 60000,
    then: [{ kind: 'nat', device: 'R1', minCount: 1 }],
    proto: 'tcp',
    port: 80,
    toIface: 'Loopback0',
    toAddress: '10.2.2.2',
    source: 'GigabitEthernet0/0',
    droppedAt: 'R1',
    dropReason: 'acl-deny',
    feedback: 'f',
    misconception: 'm',
  },
  traceSeen: {
    kind: 'traceSeen',
    filter: {
      kinds: ['frameTx', 'frameQueued'],
      protos: ['ospf'],
      devices: ['r1'],
      links: ['l_r1_r2'],
      ports: [{ device: 'r1', port: 'GigabitEthernet0/1' }],
      tables: ['rib'],
      tags: ['ospf-hello'],
      includeBackground: true,
      machines: ['ospf-nbr', 'ike'],
    },
    min: 2,
    feedback: 'f',
    misconception: 'm',
  },
  vlan: { kind: 'vlan', device: 'SW1', vlan: 10, exists: true, name: 'STAFF', accessPorts: ['Fa0/1'], match: 'exactly', feedback: 'f', misconception: 'm' },
  switchport: {
    kind: 'switchport',
    device: 'SW1',
    port: 'GigabitEthernet0/1',
    oper: 'trunk',
    mode: 'dynamic-desirable',
    accessVlan: 10,
    voiceVlan: 20,
    nativeVlan: 99,
    allowedVlans: [10, 20, 99],
    feedback: 'f',
    misconception: 'm',
  },
  stp: {
    kind: 'stp',
    device: 'SW1',
    vlan: 10,
    root: false,
    rootBridge: 'SW1',
    port: 'Fa0/1',
    role: 'designated',
    state: 'forwarding',
    edge: true,
    mode: 'rapid-pvst',
    feedback: 'f',
    misconception: 'm',
  },
  etherchannel: { kind: 'etherchannel', device: 'SW1', group: 1, protocol: 'lacp', up: true, bundled: ['Gi0/1', 'Gi0/2'], minBundled: 2, feedback: 'f', misconception: 'm' },
  portSecurity: {
    kind: 'portSecurity',
    device: 'SW1',
    port: 'Fa0/1',
    enabled: true,
    status: 'secure-up',
    violation: 'restrict',
    max: 2,
    stickyMac: '0011.2233.4455',
    minViolations: 1,
    feedback: 'f',
    misconception: 'm',
  },
  route: {
    kind: 'route',
    device: 'R1',
    family: 4,
    destination: '10.2.2.2',
    source: 'O',
    network: '10.2.2.0/24',
    nextHop: '10.0.12.2',
    iface: 'GigabitEthernet0/1',
    ad: 110,
    none: false,
    metric: 2,
    routeType: 'E2',
    minPaths: 1,
    feedback: 'f',
    misconception: 'm',
  },
  nat: {
    kind: 'nat',
    device: 'R1',
    insideLocal: '192.168.1.10',
    insideGlobal: '203.0.113.1',
    outsideGlobal: '198.51.100.10',
    proto: 'icmp',
    kindOf: 'overload',
    exists: true,
    minCount: 1,
    feedback: 'f',
    misconception: 'm',
  },
  fhrp: { kind: 'fhrp', device: 'R1', iface: 'Gi0/0', group: 1, state: 'active', virtualIp: '192.168.1.254', priority: 110, preempt: true, feedback: 'f', misconception: 'm' },
  neighbor: {
    kind: 'neighbor',
    device: 'R1',
    protocol: 'ospf',
    neighbor: '2.2.2.2',
    iface: 'GigabitEthernet0/1',
    state: 'full',
    role: 'dr',
    exists: true,
    count: 1,
    minCount: 1,
    feedback: 'f',
    misconception: 'm',
  },
  fact: { kind: 'fact', device: 'R1', fact: 'eigrp.feasibleSuccessor', subject: '10.4.0.0/24', equals: 'R2', atLeast: 0, atMost: 10, feedback: 'f', misconception: 'm' },
  acl: {
    kind: 'acl',
    device: 'R1',
    list: 'VTY',
    family: 4,
    type: 'standard',
    exists: true,
    entries: ['permit 192.168.1.0 0.0.0.255'],
    match: 'includes',
    applied: [{ vty: true, dir: 'in' }, { iface: 'GigabitEthernet0/0', dir: 'out' }],
    entry: 'implicit',
    minMatches: 1,
    feedback: 'f',
    misconception: 'm',
  },
  aclDecision: {
    kind: 'aclDecision',
    device: 'R1',
    list: '101',
    family: 4,
    packet: { proto: 'tcp', src: '192.168.1.10', dst: '10.2.2.2', srcPort: 49152, dstPort: 80, established: false },
    expect: 'deny',
    entry: 20,
    feedback: 'f',
    misconception: 'm',
  },
  service: {
    kind: 'service',
    from: 'PC1',
    to: 'R1',
    service: 'ssh',
    user: 'admin',
    password: 'not-a-real-secret',
    expect: 'refused',
    timeoutMs: 5000,
    after: [{ powerOff: 'PC2' }],
    feedback: 'f',
    misconception: 'm',
  },
  path: {
    kind: 'path',
    from: 'PC1',
    to: 'PC2',
    toIface: 'GigabitEthernet0',
    toAddress: '10.2.2.10',
    family: 4,
    via: ['R1', 'R2'],
    notVia: ['SW1'],
    after: [{ cut: { a: 'R1', b: 'R2' } }],
    settleMs: 30000,
    tunnelAt: { device: 'R2', tunnel: 'ipsec' },
    feedback: 'f',
    misconception: 'm',
  },
  traffic: {
    kind: 'traffic',
    flows: [
      {
        id: 'f1',
        dst: '10.2.2.10',
        dstPort: 5004,
        sizeBytes: 200,
        rateKbps: 64,
        pps: 50,
        dscp: 46,
        count: 500,
        durationMs: 10000,
        preset: 'voice-g711',
        from: 'PC1',
        to: 'PC2',
      },
    ],
    runMs: 10000,
    expect: [{ receiver: 'PC2', flow: 'f1', maxLossPct: 0, maxDelayMs: 100, maxJitterMs: 30 }],
    feedback: 'f',
    misconception: 'm',
  },
  // ARCHITECTURE-P3C §2.10 (W0): the [S8] and [S38] kinds join the contract and the schema
  convergence: {
    kind: 'convergence',
    fault: { cut: { a: 'R1', b: 'R2' } },
    protocol: 'routing',
    only: 'ospf',
    withinMs: 25000,
    atLeastMs: 1000,
    windowMs: 120000,
    feedback: 'f',
    misconception: 'm',
  },
  packetSeen: {
    kind: 'packetSeen',
    at: { device: 'SW1', port: 'Fa0/24' },
    filter: 'snmp.community == "NMS-RO"',
    dir: 'both',
    expect: 'seen',
    min: 1,
    drive: { snmp: { from: 'PC1', to: 'R1', community: 'NMS-RO', oid: '1.3.6.1.2.1.1.5.0' }, runMs: 5000 },
    includeBackground: false,
    after: [{ powerOff: 'PC2' }],
    settleMs: 1000,
    feedback: 'f',
    misconception: 'm',
  },
};

/** A device of the test topologies. */
const dev = (id: string, type: string, name: string, x: number): LabDocument['topology']['devices'][number] => ({
  id,
  type,
  name,
  position: { logical: [x, 0] },
});

/** A P3 document using every kind, every member, every fault form, and every optional document member. */
function everyKindDoc(): LabDocument {
  return {
    format: 'netforge.lab/1',
    meta: { name: 'every-kind', version: 2, title: 'Every kind', course: 'CCNA 3', topic: 'Grading', seed: 42, concept: 'wildcard', instructions: '## Do it' },
    topology: {
      schema: 'netforge.topology/1.3',
      seed: 42,
      devices: [dev('pc1', 'pc.nfpc', 'PC1', 0), dev('sw1', 'switch.nfc2960', 'SW1', 100), dev('r1', 'router.nf2911', 'R1', 200), dev('r2', 'router.nf2911', 'R2', 300), dev('pc2', 'pc.nfpc', 'PC2', 400)],
      links: [
        { id: 'l_pc1_sw1', a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' }, media: 'auto', length_m: 3 },
        { id: 'l_r1_r2', a: { device: 'r1', port: 'GigabitEthernet0/1' }, b: { device: 'r2', port: 'GigabitEthernet0/1' }, media: 'auto' },
      ],
      profile: 'P3',
    },
    tasks: [
      { id: 'base', title: 'Base', description: 'The first task.', points: 1, assertions: [EVERY_KIND.link] },
      {
        id: 'everything',
        title: 'Everything',
        description: 'One assertion of every kind.',
        points: 10,
        hint: 'Read the brief.',
        dependsOn: ['base'],
        assertions: Object.values(EVERY_KIND),
        feedbackOnFail: 'Not yet.',
      },
    ],
    faults: [
      {
        at: 5_000_000_000,
        fault: {
          id: 'errdisable:sw1:FastEthernet0/1',
          kind: 'err-disable',
          target: { device: 'sw1', port: 'FastEthernet0/1', link: 'l_pc1_sw1', medium: 'm1', band: '2.4', channel: 6 },
          params: { cause: 'psecure-violation', nested: { list: [1, 'two', null, true] } },
          hiddenFromStudent: true,
        },
      },
    ],
    solution: { R1: ['interface GigabitEthernet0/0', ' no shutdown'], PC1: [] },
  };
}

describe('every assertion kind of §2.10, each with every member', () => {
  it('lists all 25 kinds', () => {
    // 23 at P3a; ARCHITECTURE-P3C §2.10 (W0) adds [S8] convergence and [S38] packetSeen
    expect(Object.keys(EVERY_KIND)).toHaveLength(25);
  });

  it('passes the schema unchanged, through JSON, and through scenarioOf', () => {
    const doc = everyKindDoc();
    const r = validateLabDocument(jsonCopy(doc));
    expect(r.ok ? [] : r.errors).toEqual([]);
    expect(r.ok && r.document).toStrictEqual(doc);
    const s = scenarioOf(labDocumentFromJson(labDocumentToJson(doc)));
    expect(s.tasks).toStrictEqual(doc.tasks);
    expect(s.faults).toStrictEqual(doc.faults);
    expect(s.solution).toStrictEqual(doc.solution);
    expect(s.build()).toStrictEqual(doc.topology);
    expect(s.concept).toBe('wildcard');
    expect(labDocumentOf(s)).toStrictEqual(doc);
  });

  it('accepts a byName connectivity whose target is a DNS name, and an address as a neighbour', () => {
    const doc = jsonCopy(everyKindDoc()) as Json;
    doc.tasks[0].assertions = [
      { kind: 'connectivity', from: 'PC1', to: 'www.example.test', byName: true, expect: 'success' },
      { kind: 'neighbor', device: 'R1', protocol: 'eigrp', neighbor: '10.0.12.2', state: 'up' },
    ];
    expect(validateLabDocument(doc)).toMatchObject({ ok: true });
  });
});

// ── wrong documents ───────────────────────────────────────────────────────

/** A small valid document the wrong-document cases edit. */
function baseDoc(): LabDocument {
  return {
    format: 'netforge.lab/1',
    meta: { name: 'test-lab', version: 1, title: 'A test lab', course: 'CCNA 3', seed: 7 },
    topology: {
      schema: 'netforge.topology/1.1',
      seed: 7,
      devices: [dev('r1', 'router.nf2911', 'R1', 0), dev('pc1', 'pc.nfpc', 'PC1', 100)],
      links: [{ id: 'l1', a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'r1', port: 'GigabitEthernet0/0' }, media: 'auto' }],
    },
    tasks: [
      { id: 'gateway', title: 'Address the gateway', description: 'Give R1 an address.', points: 10, assertions: [{ kind: 'port', device: 'R1', port: 'GigabitEthernet0/0', field: 'ipv4', equals: '192.168.1.1/24' }] },
      { id: 'reach', title: 'Reach the gateway', description: 'Ping it.', points: 10, dependsOn: ['gateway'], assertions: [{ kind: 'connectivity', from: 'PC1', to: 'R1', expect: 'success' }] },
    ],
    faults: [{ at: 0, fault: { id: 'cut:l1', kind: 'cable-cut', target: { link: 'l1' } } }],
    solution: { R1: ['interface GigabitEthernet0/0', ' ip address 192.168.1.1 255.255.255.0', ' no shutdown'] },
  };
}

/** The errors of `baseDoc()` after `edit`. */
function errorsAfter(edit: (d: Json) => void): string[] {
  const d = jsonCopy(baseDoc()) as Json;
  edit(d);
  const r = validateLabDocument(d);
  expect(r.ok).toBe(false);
  return r.ok ? [] : r.errors;
}

const KIND_LIST =
  'config, port, table, process, link, counter, traceSeen, vlan, switchport, stp, etherchannel, portSecurity, route, nat, fhrp, neighbor, fact, acl, aclDecision, service, path, traffic, connectivity, convergence, packetSeen';
/** The kinds a follow-up check (`connectivity.then`) may be: no connectivity and no clone kind (W5 fix #26). */
const FOLLOW_UP_KIND_LIST = 'config, port, table, process, link, counter, traceSeen, vlan, switchport, stp, etherchannel, portSecurity, route, nat, fhrp, neighbor, fact, acl, aclDecision';
const FOLLOW_UP_REFUSAL = `must be one of ${FOLLOW_UP_KIND_LIST} (a follow-up check reads state in the same clone, so it cannot be a connectivity, service, path or traffic check)`;

describe('wrong documents are refused with readable messages', () => {
  it('accepts the base document the cases edit', () => {
    expect(validateLabDocument(jsonCopy(baseDoc()))).toEqual({ ok: true, document: baseDoc() });
  });

  it('refuses what is not a document, a wrong format and a missing member', () => {
    expect(validateLabDocument('activity')).toEqual({ ok: false, errors: ['(root): must be an object (got string)'] });
    expect(errorsAfter((d) => (d.format = 'netforge.lab/2'))).toEqual(['format: must be "netforge.lab/1"']);
    expect(errorsAfter((d) => delete d.format)).toEqual(['format: is required']);
    expect(errorsAfter((d) => delete d.topology)).toEqual(['topology: is required']);
    expect(errorsAfter((d) => (d.tasks = {}))).toEqual(['tasks: must be an array (got object)']);
    expect(errorsAfter((d) => (d.extra = 1))).toEqual(['(root): unknown keys: extra']);
  });

  it('refuses wrong metadata', () => {
    expect(errorsAfter((d) => (d.meta.name = 'Test Lab'))).toEqual(['meta.name: must be a kebab-case id (lowercase letters and digits joined by single hyphens)']);
    expect(errorsAfter((d) => (d.meta.version = 0))).toEqual(['meta.version: must be between 1 and 1000000']);
    expect(errorsAfter((d) => (d.meta.version = 1.5))).toEqual(['meta.version: must be an integer (got float)']);
    expect(errorsAfter((d) => (d.meta.seed = '7'))).toEqual(['meta.seed: must be a number (got string)']);
    expect(errorsAfter((d) => (d.meta.title = ''))).toEqual(['meta.title: must not be empty']);
    expect(errorsAfter((d) => (d.meta.concept = 'trigonometry'))).toEqual(['meta.concept: must be one of subnetting, ipv6, queueing, data-formats, wildcard, wan, yang, sdn']);
    expect(errorsAfter((d) => (d.meta.author = 'me'))).toEqual(['meta: unknown keys: author']);
  });

  it('reports a topology problem with the topology schema message, under its path', () => {
    expect(errorsAfter((d) => (d.topology.links[0].a.device = 'zz'))).toEqual(['topology.links[0].a.device: unknown device "zz"']);
    expect(errorsAfter((d) => (d.topology.schema = 'netforge.topology/9'))).toEqual([
      // ARCHITECTURE-P3C §9.2 item 10 (W1a io): the message lists the five ids
      'topology.schema: must be one of "netforge.topology/1.0", "netforge.topology/1.1", "netforge.topology/1.2", "netforge.topology/1.3", "netforge.topology/1.4"',
    ]);
    // a topology refused together with a wrong reference: the structure is reported, nothing throws
    expect(
      errorsAfter((d) => {
        d.topology.devices = 'none';
        d.tasks[0].assertions[0].device = 'R9';
      }),
    ).toEqual(['topology.devices: must be an array (got string)']);
  });

  it('refuses a wrong assertion: kind, missing or misspelt member, value out of its vocabulary or range', () => {
    const at = 'tasks[0].assertions[0]';
    expect(errorsAfter((d) => (d.tasks[0].assertions[0].kind = 'ping'))).toEqual([`${at}.kind: must be one of ${KIND_LIST}`]);
    expect(errorsAfter((d) => (d.tasks[0].assertions[0] = 'port'))).toEqual([`${at}: must be an object (got string)`]);
    expect(errorsAfter((d) => delete d.tasks[0].assertions[0].device)).toEqual([`${at}.device: is required`]);
    expect(
      errorsAfter((d) => {
        d.tasks[0].assertions[0].equal = d.tasks[0].assertions[0].equals;
        delete d.tasks[0].assertions[0].equals;
      }),
    ).toEqual([`${at}.equals: must be text, a number or true/false`, `${at}: unknown keys: equal`]);
    expect(errorsAfter((d) => (d.tasks[0].assertions[0].field = 'mtu'))).toEqual([
      `${at}.field: must be one of operUp, adminUp, ipv4, ipv6, duplex, speedBps, role, errDisabled`,
    ]);
    expect(errorsAfter((d) => (d.tasks[0].assertions[0] = { kind: 'vlan', device: 'R1', vlan: 5000 }))).toEqual([`${at}.vlan: must be between 1 and 4094`]);
    expect(errorsAfter((d) => (d.tasks[0].assertions[0] = { kind: 'fact', device: 'R1', fact: 'ospf.area' }))[0]).toMatch(
      new RegExp(`^${at.replace(/[[\]]/g, '\\$&')}\\.fact: must be one of ospf\\.routerId, .*, ipsec\\.sa, ospf\\.abr, ospf\\.asbr, ospfv3\\.routerId, ospfv3\\.ifaceArea, ospfv3\\.ifaceCost, ipsg\\.enabled, storage\\.file, device\\.imageVersion, device\\.configRegister$`),
    );
    expect(errorsAfter((d) => (d.tasks[1].assertions[0].dropReason = 'firewall'))[0]).toMatch(/^tasks\[1\]\.assertions\[0\]\.dropReason: must be one of link-down, .*, ipsec-no-sa, ip-source-guard, storm-control, span-destination$/);
    expect(errorsAfter((d) => (d.tasks[1].assertions[0].family = 5))).toEqual(['tasks[1].assertions[0].family: must be 4 or 6']);
  });

  it('refuses a device an assertion, a grader fault or the solution names but the topology lacks', () => {
    expect(errorsAfter((d) => (d.tasks[0].assertions[0].device = 'R9'))).toEqual(['tasks[0].assertions[0].device: unknown device "R9"']);
    expect(errorsAfter((d) => (d.tasks[1].assertions[0].to = 'r1'))).toEqual(['tasks[1].assertions[0].to: unknown device "r1"']);
    expect(errorsAfter((d) => (d.tasks[1].assertions[0].after = [{ cut: { a: 'R1', b: 'PC9' } }]))).toEqual(['tasks[1].assertions[0].after[0].cut.b: unknown device "PC9"']);
    expect(errorsAfter((d) => (d.tasks[1].assertions[0].then = [{ kind: 'nat', device: 'R2' }]))).toEqual(['tasks[1].assertions[0].then[0].device: unknown device "R2"']);
    expect(errorsAfter((d) => (d.tasks[0].assertions[0] = { kind: 'path', from: 'PC1', to: 'R1', via: ['R1', 'ISP'] }))).toEqual(['tasks[0].assertions[0].via[1]: unknown device "ISP"']);
    expect(errorsAfter((d) => (d.solution.R2 = ['hostname R2']))).toEqual(['solution.R2: unknown device "R2"']);
    expect(errorsAfter((d) => (d.topology.devices[1].name = 'R1'))).toEqual([
      'topology.devices[1].name: another device is already named "R1" (a lab names its devices, so names must be unique)',
      'tasks[1].assertions[0].from: unknown device "PC1"',
    ]);
  });

  it('refuses a follow-up check that pings again, and a grader fault that is not exactly one fault', () => {
    expect(KIND_LIST.replace(', service, path, traffic, connectivity, convergence, packetSeen', '')).toBe(FOLLOW_UP_KIND_LIST);
    expect(errorsAfter((d) => (d.tasks[1].assertions[0].then = [{ kind: 'connectivity', from: 'PC1', to: 'R1', expect: 'success' }]))).toEqual([
      `tasks[1].assertions[0].then[0].kind: ${FOLLOW_UP_REFUSAL}`,
    ]);
    // the clone kinds the grader refuses inside `then` are refused by the schema too (W5 fix #26)
    for (const follow of [
      { kind: 'service', from: 'PC1', to: 'R1', service: 'ssh', expect: 'success' },
      { kind: 'path', from: 'PC1', to: 'R1' },
      { kind: 'traffic', flows: [{ from: 'PC1', to: 'R1', pps: 1 }], runMs: 1000, expect: [{ receiver: 'R1', flow: 'f1' }] },
    ]) {
      expect(errorsAfter((d) => (d.tasks[1].assertions[0].then = [follow])), follow.kind).toEqual([`tasks[1].assertions[0].then[0].kind: ${FOLLOW_UP_REFUSAL}`]);
    }
    expect(errorsAfter((d) => (d.tasks[1].assertions[0].after = [{ powerOff: 'PC1', shutdown: { device: 'R1', port: 'Gi0/0' } }]))).toEqual([
      'tasks[1].assertions[0].after[0]: must name exactly one fault: cut, powerOff, shutdown or config',
    ]);
    expect(errorsAfter((d) => (d.tasks[1].assertions[0].after = [{}]))).toEqual(['tasks[1].assertions[0].after[0]: must name exactly one fault: cut, powerOff, shutdown or config']);
  });

  it('refuses wrong tasks: duplicate ids, unknown or circular dependencies, no assertions, bad points', () => {
    expect(errorsAfter((d) => (d.tasks[1].id = 'gateway'))).toEqual(['tasks[1].id: task "gateway" is listed more than once', 'tasks[1].dependsOn[0]: task "gateway" cannot depend on itself']);
    expect(errorsAfter((d) => (d.tasks[1].dependsOn = ['addressing']))).toEqual(['tasks[1].dependsOn[0]: unknown task "addressing"']);
    expect(errorsAfter((d) => (d.tasks[0].assertions = []))).toEqual(['tasks[0].assertions: a task needs at least one assertion']);
    expect(errorsAfter((d) => (d.tasks[0].points = -1))).toEqual(['tasks[0].points: must be between 0 and 1000']);
    expect(errorsAfter((d) => (d.tasks = Array.from({ length: MAX_LAB_TASKS + 1 }, (_, i) => ({ ...d.tasks[0], id: `t${i}` }))))).toEqual([
      `tasks: must have at most ${MAX_LAB_TASKS} entries`,
    ]);
  });

  it('refuses wrong scheduled faults and trace filters, which name devices and links by id', () => {
    expect(errorsAfter((d) => (d.faults[0].fault.target = { link: 'l9' }))).toEqual(['faults[0].fault.target.link: unknown link id "l9"']);
    expect(errorsAfter((d) => (d.faults[0].fault.target = { device: 'R1' }))).toEqual(['faults[0].fault.target.device: unknown device id "R1" (a scheduled fault names devices by id)']);
    expect(errorsAfter((d) => (d.faults[0].fault.kind = 'meteor'))[0]).toMatch(/^faults\[0\]\.fault\.kind: must be one of cable-cut, .*, err-disable$/);
    expect(errorsAfter((d) => (d.faults[0].at = -1))).toEqual(['faults[0].at: must be >= 0']);
    let deep: unknown = 'leaf';
    for (let i = 0; i < MAX_LAB_PARAMS_DEPTH + 1; i++) deep = [deep];
    expect(errorsAfter((d) => (d.faults[0].fault.params = { deep }))[0]).toMatch(/^faults\[0\]\.fault\.params\.deep: must be JSON data/);
    expect(errorsAfter((d) => (d.tasks[0].assertions[0] = { kind: 'traceSeen', filter: { devices: ['R1'], kinds: ['frameTx'] } }))).toEqual([
      'tasks[0].assertions[0].filter.devices[0]: unknown device id "R1" (a trace filter names devices by id)',
    ]);
    expect(errorsAfter((d) => (d.tasks[0].assertions[0] = { kind: 'traceSeen', filter: { machines: ['bgp'] } }))[0]).toMatch(
      /^tasks\[0\]\.assertions\[0\]\.filter\.machines\[0\]: must be one of stp-port, .*, ike, ospf6-if, ospf6-nbr$/,
    );
  });

  it('refuses a wrong solution', () => {
    expect(errorsAfter((d) => (d.solution.R1 = 'no shutdown'))).toEqual(['solution.R1: must be an array (got string)']);
    expect(errorsAfter((d) => (d.solution.R1 = [1]))).toEqual(['solution.R1[0]: must be a string (got number)']);
  });

  it('lists every issue; parseLabDocument throws them, labDocumentFromJson also refuses bad JSON text', () => {
    const two = errorsAfter((d) => {
      d.meta.version = 0;
      d.tasks[0].points = 'ten';
    });
    expect(two).toEqual(['meta.version: must be between 1 and 1000000', 'tasks[0].points: must be a number (got string)']);

    const d = jsonCopy(baseDoc()) as Json;
    d.meta.version = 0;
    d.tasks[0].points = 'ten';
    expect(() => parseLabDocument(d)).toThrow(
      new Error(['Invalid lab document: 2 issues', '  - meta.version: must be between 1 and 1000000', '  - tasks[0].points: must be a number (got string)'].join('\n')),
    );
    expect(() => labDocumentFromJson('{"format":')).toThrow(/^lab document is not valid JSON: /);
    expect(() => labDocumentFromJson('[]')).toThrow(/^Invalid lab document: 1 issue\n {2}- \(root\): must be an object \(got array\)$/);
    expect(parseLabDocument(jsonCopy(baseDoc()))).toStrictEqual(baseDoc());
  });

  it('is a zod schema: safeParse gives the same verdict', () => {
    expect(labDocumentSchema.safeParse(jsonCopy(baseDoc())).success).toBe(true);
    const r = labDocumentSchema.safeParse({ ...jsonCopy(baseDoc()), format: 'x' });
    expect(r.success).toBe(false);
  });
});
