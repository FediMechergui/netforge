/**
 * test/staged.world.ts (ARCHITECTURE-P3 §0 rule 13, §7 W0 qa): worlds of any build stage from the real model inputs,
 * with the P3 test-only data (the §2.1 final daemon order restricted to approved names, the §2.1 P3 capability rows,
 * the §2.6 P3 tables and stage-filtered snooping tables, the test-only NF-DEVHOST of [S32]) applied at stage P3.
 *
 * The registries are spelled out with `withP3(...)`, which gives the named P3 daemons a silent stub and removes every
 * other P3 daemon, so the W4 and W6 flips (which register the real factories) cannot change the expected lists. The
 * assertions about the real contract are the ones that hold before AND after the flips (the real data is a part of
 * the test-only data); `staged.world.p3-parity.test.ts` (W4) pins equality.
 *
 * At stage P2 the helper is the P2 helper: every model equals a copy of the pre-W0 `defineP2Model` code (5263f16,
 * `test/p2.world.ts:136-146`) for several overlays, `createP2Catalog` and `createP2Simulation` are the stage-P2
 * helper, and a world built both ways is byte-identical.
 */
import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  CAPABILITY_PROCESSES,
  PROCESS_ORDER,
  expandCapabilities,
  isVlanAware,
  type Capability,
} from '../src/contracts/catalog.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { ProcessName } from '../src/contracts/ids.js';
import type { ProcessFactory } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { PROCESS_TABLES, TABLE_DESCRIPTORS } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { ALL_MODEL_INPUTS, ALL_MODELS, ALL_MODULES } from '../src/device/catalog.js';
import {
  deepFreeze,
  defineModel,
  derivePortOwners,
  deriveTables,
  moduleReachableProcesses,
  type ModelInput,
} from '../src/device/catalog/define.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { P2_DAEMONS, applyP2ModelDelta, createP2Catalog, createP2Simulation, type P2FactoryOverlay } from './p2.world.js';
import {
  NF_DEVHOST_TYPE,
  P3_CAPABILITY_PROCESS_ROWS,
  P3_DAEMONS,
  P3_PROCESS_TABLES,
  P3_STAGED_PROCESS_TABLES,
  STAGED_DAEMONS,
  STAGED_PROCESS_ORDER,
  createStagedCatalog,
  createStagedSimulation,
  defineStagedModel,
  deriveStagedProcesses,
  deriveStagedTables,
  nfDevhostTestInput,
  stagedDefaultProfile,
  stagedModelInputs,
  stagedRegistry,
  type StagedFactoryOverlay,
  type StagedRegistry,
} from './staged.world.js';

/** A silent daemon: answers nothing, sends nothing, keeps no state. */
function stub(name: ProcessName): ProcessFactory {
  return () => ({
    name,
    onPdu: () => [],
    onTimer: () => [],
    onConfig: () => [],
    stateSnapshot: () => ({ process: name, state: {} }),
    debugEvents: () => [],
  });
}

/** An overlay that gives the named P3 daemons a silent stub and removes every other P3 daemon (P2 daemons stay real). */
function withP3(...names: ProcessName[]): StagedFactoryOverlay {
  const out: Record<ProcessName, ProcessFactory | undefined> = {};
  for (const p of P3_DAEMONS) out[p] = names.includes(p) ? stub(p) : undefined;
  return out;
}

/** An overlay that gives the named P2 daemons a silent stub and removes every other P2 daemon (p2.world.test's). */
function onlyP2(...names: ProcessName[]): P2FactoryOverlay {
  const out: Record<ProcessName, ProcessFactory | undefined> = {};
  for (const p of P2_DAEMONS) out[p] = names.includes(p) ? stub(p) : undefined;
  return out;
}

const missing = (events: readonly TraceEvent[]): string[] =>
  events.flatMap((e) => (e.kind === 'log' && e.message.includes('is not available') ? [e.message] : []));

/**
 * The §2.1 final daemon order as the brief writes it, unapproved names included (ARCHITECTURE-P3 §2.1), and the names
 * §8.5 did not approve. An independent transcription of the brief, so the helper's order is checked against it.
 */
const FINAL_ORDER_2_1: readonly ProcessName[] = [
  'wlan-ap', 'wlan-client', 'capwap-wtp', 'cell-client', 'hdlc', 'ppp', 'eth-switch', 'vlan', 'dtp', 'etherchannel', 'stp',
  'cdp', 'lldp', 'arp', 'ipv4', 'nat', 'acl', 'gre', 'icmpv4', 'host', 'ipv6', 'nd', 'icmpv6', 'udp', 'tcp', 'vty',
  'vty-client', 'logger', 'ntp', 'tftp', 'snmp-agent', 'snmp-manager', 'syslog-server', 'hsrp', 'ospf', 'ospfv3',
  'eigrp', 'ike', 'dhcp-client', 'dhcp-server', 'dhcpv6-client', 'dhcpv6-server', 'dns-client', 'dns-server',
  'http-client', 'http-server', 'restconf', 'traceroute', 'traffic', 'capwap-ac', 'script-host',
];
const UNAPPROVED: readonly ProcessName[] = ['tftp', 'snmp-agent', 'snmp-manager', 'ospfv3'];

/** The §2.1 `CAPABILITY_PROCESSES` additions of P3, by capability, as the brief's table lists them. */
const ROWS_2_1: Readonly<Partial<Record<Capability, readonly ProcessName[]>>> = {
  routing: ['ospf', 'acl', 'cdp', 'lldp', 'ntp', 'restconf', 'logger', 'gre', 'ppp', 'eigrp', 'ike', 'vty', 'vty-client'],
  'managed-switch': ['udp', 'tcp', 'acl', 'cdp', 'lldp', 'ntp', 'restconf', 'logger', 'vty', 'vty-client'],
  'wireless-controller': ['cdp', 'ntp', 'logger'],
  server: ['ntp', 'syslog-server'],
  host: ['traffic', 'vty-client'],
  programmable: ['script-host'],
};

const rank = (p: ProcessName): number => STAGED_PROCESS_ORDER.indexOf(p);
const byOrder = (names: readonly ProcessName[]): ProcessName[] => [...names].sort((a, b) => rank(a) - rank(b));

/** The pre-W0 P2 helper's model code (5263f16, test/p2.world.ts:136-146), kept here as the reference of stage P2. */
function referenceDefineP2Model(input: ModelInput, registry: StagedRegistry): DeviceModel {
  const base = defineModel(applyP2ModelDelta(input), 'P2', ALL_MODULES);
  const processes = base.processes.filter((p) => !P2_DAEMONS.includes(p) || Object.prototype.hasOwnProperty.call(registry, p));
  const moduleProcesses = moduleReachableProcesses(base.capabilities, base.slots, processes, 'P2', ALL_MODULES);
  return deepFreeze<DeviceModel>({
    ...base,
    processes,
    tables: deriveTables(processes),
    portOwners: derivePortOwners(base.ports, base.virtualFamilies, processes, moduleProcesses),
  });
}

describe('staged.world P3 test-only data', () => {
  it('STAGED_PROCESS_ORDER is the §2.1 final order restricted to the approved names, and the real order is a part of it', () => {
    expect(STAGED_PROCESS_ORDER).toEqual(FINAL_ORDER_2_1.filter((p) => !UNAPPROVED.includes(p)));
    expect(new Set(STAGED_PROCESS_ORDER).size).toBe(STAGED_PROCESS_ORDER.length);
    for (const p of [...UNAPPROVED, 'vtp', 'radius-server']) expect(STAGED_PROCESS_ORDER).not.toContain(p);
    // the approved P3 daemons, in their final order
    expect(P3_DAEMONS).toEqual([
      'ppp', 'cdp', 'lldp', 'acl', 'gre', 'vty', 'vty-client', 'logger', 'ntp', 'syslog-server', 'ospf', 'eigrp', 'ike',
      'restconf', 'traffic', 'script-host',
    ]);
    expect(STAGED_PROCESS_ORDER.filter((p) => P3_DAEMONS.includes(p))).toEqual(P3_DAEMONS);
    expect(STAGED_DAEMONS).toEqual([...P2_DAEMONS, ...P3_DAEMONS]);
    // every real name is there, in the real relative order (before the flips the rest are exactly the P3 daemons)
    expect(STAGED_PROCESS_ORDER.filter((p) => PROCESS_ORDER.includes(p))).toEqual(PROCESS_ORDER);
    expect(STAGED_PROCESS_ORDER.filter((p) => !P3_DAEMONS.includes(p))).toEqual(PROCESS_ORDER.filter((p) => !P3_DAEMONS.includes(p)));
    // the constraints §2.1 relies upon
    const before = (a: ProcessName, b: ProcessName): void => expect(rank(a), `${a} before ${b}`).toBeLessThan(rank(b));
    before('hdlc', 'ppp');
    for (const d of ['cdp', 'lldp']) before('eth-switch', d);
    for (const d of ['acl', 'gre']) before('ipv4', d);
    for (const d of ['ntp', 'logger', 'syslog-server', 'ike']) before('udp', d);
    for (const d of ['vty', 'restconf']) before('tcp', d);
    expect(STAGED_PROCESS_ORDER.at(-1)).toBe('script-host');
    expect(Object.isFrozen(STAGED_PROCESS_ORDER)).toBe(true);
  });

  it('P3_CAPABILITY_PROCESS_ROWS are the §2.1 rows, all since P3, each capability in the final order', () => {
    expect(Object.keys(P3_CAPABILITY_PROCESS_ROWS).sort()).toEqual(Object.keys(ROWS_2_1).sort());
    for (const [cap, names] of Object.entries(ROWS_2_1) as [Capability, readonly ProcessName[]][]) {
      const rows = P3_CAPABILITY_PROCESS_ROWS[cap] ?? [];
      expect(rows.map((r) => r.process), cap).toEqual(byOrder(names));
      expect(rows.every((r) => r.since === 'P3'), cap).toBe(true);
      expect(Object.isFrozen(rows), cap).toBe(true);
    }
    // no row for the lightweight AP (no discovery receive path, D2, D18), none for an unapproved daemon
    expect(P3_CAPABILITY_PROCESS_ROWS['lightweight-ap']).toBeUndefined();
    const named = new Set(Object.values(P3_CAPABILITY_PROCESS_ROWS).flatMap((rows) => (rows ?? []).map((r) => r.process)));
    expect([...named].filter((p) => !P3_DAEMONS.includes(p)).sort()).toEqual(['tcp', 'udp']);
    expect(P3_DAEMONS.filter((p) => !named.has(p))).toEqual([]);
    // every real `since: 'P3'` row (none before the W4 flip) is one of these rows
    for (const cap of CAPABILITIES) {
      for (const row of CAPABILITY_PROCESSES[cap].filter((r) => r.since === 'P3')) {
        expect((P3_CAPABILITY_PROCESS_ROWS[cap] ?? []).map((r) => r.process), `${cap} ${row.process}`).toContain(row.process);
      }
    }
  });

  it('P3_PROCESS_TABLES and the stage-filtered snooping row are the §2.6 data, with P3 descriptors', () => {
    expect(P3_PROCESS_TABLES).toEqual({
      ppp: ['ppp'],
      cdp: ['cdp-neighbours'],
      lldp: ['lldp-neighbours'],
      acl: ['acl'],
      gre: ['tunnels'],
      vty: ['vty-logins'],
      ntp: ['ntp-peers', 'clock'],
      'syslog-server': ['syslog-messages'],
      ospf: ['ospf-interfaces', 'ospf-neighbors', 'ospf-lsdb'],
      eigrp: ['eigrp-neighbors', 'eigrp-topology'],
      ike: ['ipsec-sa'],
      restconf: ['restconf-log'],
      traffic: ['flows'],
      'script-host': ['script-runs'],
    });
    expect(P3_STAGED_PROCESS_TABLES).toEqual([{ process: 'vlan', tables: ['dhcp-snooping', 'arp-inspection'], since: 'P3', requires: 'managed-switch' }]);
    const tables = [...Object.values(P3_PROCESS_TABLES).flatMap((t) => t ?? []), ...P3_STAGED_PROCESS_TABLES.flatMap((r) => r.tables)];
    for (const t of tables) expect([t, TABLE_DESCRIPTORS[t]?.since]).toEqual([t, 'P3']);
    for (const p of Object.keys(P3_PROCESS_TABLES)) expect(P3_DAEMONS).toContain(p);
    // the snooping tables are never plain `vlan` rows (§2.6), and a real P3 daemon's tables (after the flip) are these
    expect(PROCESS_TABLES['vlan']).not.toContain('dhcp-snooping');
    expect(PROCESS_TABLES['vlan']).not.toContain('arp-inspection');
    for (const p of P3_DAEMONS) if (PROCESS_TABLES[p] !== undefined) expect([p, PROCESS_TABLES[p]]).toEqual([p, P3_PROCESS_TABLES[p]]);
  });

  it('stagedRegistry lays the overlay over PROCESS_FACTORIES; the default profile of a stage is its own', () => {
    const cdp = stub('cdp');
    const r = stagedRegistry({ cdp, arp: undefined });
    expect(r['cdp']).toBe(cdp);
    expect('arp' in r).toBe(false);
    expect(Object.isFrozen(r)).toBe(true);
    expect(stagedDefaultProfile('P3')).toBe('P3');
    expect(stagedDefaultProfile('P2')).toBe('P2');
    expect(stagedDefaultProfile('P1')).toBe('P1');
    expect(stagedDefaultProfile('P0.5')).toBe('P1');
    expect(stagedDefaultProfile('P0')).toBe('P1');
  });
});

describe('staged.world models at stage P3', () => {
  it('an NF-C2960 derives the §2.1 rows and the snooping tables', () => {
    const sw = createStagedCatalog({ stage: 'P3', factories: withP3(...P3_DAEMONS) }).get('switch.nfc2960')!;
    expect(sw.capabilities).toEqual(['switching', 'managed-switch']);
    expect(sw.processes).toEqual([
      'eth-switch', 'vlan', 'dtp', 'etherchannel', 'stp', 'cdp', 'lldp', 'arp', 'ipv4', 'acl', 'icmpv4', 'host', 'udp', 'tcp',
      'vty', 'vty-client', 'logger', 'ntp', 'restconf',
    ]);
    expect(sw.tables).toEqual([
      'cam', 'arp', 'rib', 'vlans', 'port-security', 'dhcp-snooping', 'arp-inspection', 'dtp', 'etherchannel', 'stp',
      'stp-bridge', 'cdp-neighbours', 'lldp-neighbours', 'acl', 'sockets', 'vty-logins', 'ntp-peers', 'clock',
      'restconf-log',
    ]);
    expect(isVlanAware(sw)).toBe(true);
    expect(Object.isFrozen(sw)).toBe(true);
    expect(Object.isFrozen(sw.processes)).toBe(true);
    // with no P3 factory the P3 daemons and their tables are left out; the dormant udp/tcp rows and the snooping tables
    // (brought by `vlan`, which has its factory) stay
    const bare = createStagedCatalog({ stage: 'P3', factories: withP3() }).get('switch.nfc2960')!;
    expect(bare.processes).toEqual(['eth-switch', 'vlan', 'dtp', 'etherchannel', 'stp', 'arp', 'ipv4', 'icmpv4', 'host', 'udp', 'tcp']);
    expect(bare.tables).toEqual([
      'cam', 'arp', 'rib', 'vlans', 'port-security', 'dhcp-snooping', 'arp-inspection', 'dtp', 'etherchannel', 'stp', 'stp-bridge', 'sockets',
    ]);
    // without `vlan` there is no snooping table either (the row is vlan's)
    const noVlan = createStagedCatalog({ stage: 'P3', factories: { ...withP3(), vlan: undefined } }).get('switch.nfc2960')!;
    expect(noVlan.tables).not.toContain('dhcp-snooping');
    expect(noVlan.tables).not.toContain('arp-inspection');
  });

  it('NF-WLC-9800 derives its cdp, logger and ntp rows and never the snooping tables', () => {
    const wlc = createStagedCatalog({ stage: 'P3', factories: withP3(...P3_DAEMONS) }).get('wlc.nfwlc9800')!;
    expect(wlc.capabilities).toEqual(['switching', 'wireless-controller']);
    expect(wlc.processes).toEqual(['eth-switch', 'vlan', 'cdp', 'arp', 'ipv4', 'icmpv4', 'host', 'udp', 'logger', 'ntp', 'capwap-ac']);
    expect(wlc.tables).toEqual(['cam', 'arp', 'rib', 'vlans', 'port-security', 'cdp-neighbours', 'sockets', 'ntp-peers', 'clock', 'capwap-aps', 'wlan-clients']);
    expect(isVlanAware(wlc)).toBe(true);
    for (const t of ['dhcp-snooping', 'arp-inspection'] as const) expect(wlc.tables).not.toContain(t);
  });

  it('every model derives its P2 daemons in order plus exactly the P3 rows of its capabilities; tables follow', () => {
    const p3 = createStagedCatalog({ stage: 'P3', factories: withP3(...P3_DAEMONS) });
    const p2 = createStagedCatalog({ stage: 'P2' });
    for (const m2 of p2.list()) {
      const m3 = p3.get(m2.type)!;
      expect(m3.capabilities, m2.type).toEqual(m2.capabilities);
      expect(m3.processes.filter((p) => m2.processes.includes(p)), m2.type).toEqual(m2.processes);
      const rowNames = new Set(m3.capabilities.flatMap((c) => (P3_CAPABILITY_PROCESS_ROWS[c] ?? []).map((r) => r.process)));
      expect(m3.processes, m2.type).toEqual(byOrder([...new Set([...m2.processes, ...rowNames])]));
      expect(m3.tables, m2.type).toEqual(deriveStagedTables(m3.processes, m3.capabilities, 'P3'));
      expect(m2.tables.every((t) => m3.tables.includes(t)), m2.type).toBe(true);
      const snooping = m3.tables.includes('dhcp-snooping');
      expect([m2.type, snooping]).toEqual([m2.type, m3.capabilities.includes('managed-switch')]);
      expect([m2.type, m3.tables.includes('arp-inspection')]).toEqual([m2.type, snooping]);
    }
    // the router derives the whole routing row (the approved items' daemons included); the lightweight AP gains nothing
    const router = p3.get('router.nf2911')!;
    for (const p of ROWS_2_1.routing!) expect(router.processes).toContain(p);
    expect(router.tables).toEqual(expect.arrayContaining(['ospf-interfaces', 'ospf-neighbors', 'ospf-lsdb', 'acl', 'tunnels', 'ppp', 'vty-logins', 'eigrp-neighbors', 'eigrp-topology', 'ipsec-sa']));
    expect(p3.get('ap.nfap-lw')!.processes).toEqual(p2.get('ap.nfap-lw')!.processes);
    // hosts gain traffic (and its Traffic panel) and vty-client; servers ntp and syslog-server
    const pc = p3.get('pc.nfpc')!;
    expect(pc.processes.filter((p) => P3_DAEMONS.includes(p))).toEqual(['vty-client', 'traffic']);
    expect(pc.gui).toContain('desktop.traffic');
    expect(p2.get('pc.nfpc')!.gui).not.toContain('desktop.traffic');
    expect(p3.get('server.nfserver')!.processes.filter((p) => P3_DAEMONS.includes(p))).toEqual(['vty-client', 'ntp', 'syslog-server', 'traffic']);
  });

  it('a P3 daemon without a factory is filtered out with its tables; the rest keep the final order', () => {
    const router = createStagedCatalog({ stage: 'P3', factories: withP3('ospf') }).get('router.nf2911')!;
    expect(router.processes.filter((p) => P3_DAEMONS.includes(p))).toEqual(['ospf']);
    expect(router.processes.indexOf('ospf')).toBe(router.processes.indexOf('hsrp') + 1);
    expect(router.tables).toEqual(expect.arrayContaining(['ospf-interfaces', 'ospf-neighbors', 'ospf-lsdb']));
    for (const t of ['acl', 'cdp-neighbours', 'ntp-peers', 'clock', 'restconf-log', 'tunnels', 'ppp'] as const) expect(router.tables).not.toContain(t);
    for (const m of createStagedCatalog({ stage: 'P3', factories: withP3('cdp', 'ntp', 'traffic') }).list()) {
      const ranks = m.processes.map(rank);
      expect(ranks.every((r) => r >= 0), m.type).toBe(true);
      expect([...ranks].sort((a, b) => a - b), m.type).toEqual(ranks);
    }
    // deriveStagedProcesses at P3 is the unfiltered list
    expect(deriveStagedProcesses(expandCapabilities(['switching', 'managed-switch']), 'P3')).toEqual(
      createStagedCatalog({ stage: 'P3', factories: withP3(...P3_DAEMONS) }).get('switch.nfc2960')!.processes,
    );
  });

  it('the test-only NF-DEVHOST is a programmable host at stage P3 only, right after the Computers models', () => {
    const inputs = stagedModelInputs('P3');
    const real = ALL_MODEL_INPUTS.some((i) => i.type === NF_DEVHOST_TYPE);
    expect(inputs.filter((i) => i.type === NF_DEVHOST_TYPE)).toHaveLength(1);
    expect(inputs.filter((i) => i.type !== NF_DEVHOST_TYPE || ALL_MODEL_INPUTS.includes(i))).toEqual(ALL_MODEL_INPUTS);
    if (!real) {
      // the test-only input (until the W6 flip puts the real model in computers.ts; then the real input is used)
      const at = inputs.findIndex((i) => i.type === NF_DEVHOST_TYPE);
      expect(inputs[at - 1]!.category).toBe('computers');
      expect(inputs.slice(at + 1).some((i) => i.category === 'computers')).toBe(false);
      expect(inputs.length).toBe(ALL_MODEL_INPUTS.length + 1);
    }
    expect(stagedModelInputs('P2')).toEqual(ALL_MODEL_INPUTS);
    expect(nfDevhostTestInput()).not.toBe(nfDevhostTestInput());
    expect(nfDevhostTestInput()).toEqual(nfDevhostTestInput());

    const dev = createStagedCatalog({ stage: 'P3', factories: withP3('script-host', 'traffic', 'vty-client') }).get(NF_DEVHOST_TYPE)!;
    expect(dev.model).toBe('NF-DEVHOST');
    expect(dev.kind).toBe('pc');
    expect(dev.category).toBe('computers');
    expect(dev.capabilities).toEqual(['host', 'programmable']);
    expect(dev.processes).toEqual([
      'arp', 'ipv4', 'icmpv4', 'host', 'ipv6', 'nd', 'icmpv6', 'udp', 'tcp', 'vty-client', 'dhcp-client', 'dhcpv6-client',
      'dns-client', 'http-client', 'traceroute', 'traffic', 'script-host',
    ]);
    expect(dev.tables).toEqual(['cam', 'arp', 'rib', 'rib6', 'nd', 'sockets', 'dns-cache', 'flows', 'script-runs']);
    expect(dev.gui).toEqual(expect.arrayContaining(['desktop.command-prompt', 'desktop.traffic', 'desktop.automation']));
    expect(dev.cli.shell).toBe('host');
    if (!real) expect(dev.ports.map((p) => p.name)).toEqual(['GigabitEthernet0']);
    expect(createStagedCatalog({ stage: 'P3', factories: withP3() }).get(NF_DEVHOST_TYPE)!.processes).not.toContain('script-host');
    expect(createStagedCatalog({ stage: 'P2' }).get(NF_DEVHOST_TYPE)).toBeUndefined();
    expect(createP2Catalog().get(NF_DEVHOST_TYPE)).toBeUndefined();
  });

  it('builds leave the real inputs, models and contract data untouched', () => {
    const inputs = JSON.stringify(ALL_MODEL_INPUTS);
    const models = JSON.stringify(ALL_MODELS);
    const order = JSON.stringify(PROCESS_ORDER);
    const rows = JSON.stringify(CAPABILITY_PROCESSES);
    const tables = JSON.stringify(PROCESS_TABLES);
    createStagedCatalog({ stage: 'P3', factories: withP3(...P3_DAEMONS) });
    createStagedCatalog({ stage: 'P1' });
    createStagedSimulation({ seed: 1, stage: 'P3' });
    expect(JSON.stringify(ALL_MODEL_INPUTS)).toBe(inputs);
    expect(JSON.stringify(ALL_MODELS)).toBe(models);
    expect(JSON.stringify(PROCESS_ORDER)).toBe(order);
    expect(JSON.stringify(CAPABILITY_PROCESSES)).toBe(rows);
    expect(JSON.stringify(PROCESS_TABLES)).toBe(tables);
  });
});

describe('staged.world at stage P2 is the P2 helper', () => {
  const OVERLAYS: readonly [string, P2FactoryOverlay][] = [
    ['default registry', {}],
    ['no P2 daemon', onlyP2()],
    ['vlan only', onlyP2('vlan')],
    ['every P2 daemon stubbed', onlyP2(...P2_DAEMONS)],
    ['arp removed', { arp: undefined }],
    ['capwap-wtp only', onlyP2('capwap-wtp')],
  ];

  it('every model equals the pre-W0 defineP2Model code, for every overlay', () => {
    for (const [what, overlay] of OVERLAYS) {
      const registry = stagedRegistry(overlay);
      for (const input of ALL_MODEL_INPUTS) {
        const expected = JSON.stringify(referenceDefineP2Model(input, registry));
        expect([what, input.type, JSON.stringify(defineStagedModel(input, 'P2', registry))]).toEqual([what, input.type, expected]);
      }
      const catalog = createStagedCatalog({ stage: 'P2', factories: overlay });
      expect(JSON.stringify(catalog.list()), what).toBe(JSON.stringify(ALL_MODEL_INPUTS.map((i) => referenceDefineP2Model(i, registry))));
      expect(JSON.stringify(createP2Catalog(overlay).list()), what).toBe(JSON.stringify(catalog.list()));
      for (const name of Object.keys(registry)) expect(catalog.process(name)).toBe(registry[name]);
    }
  });

  it('derivations at stages up to P2 are the real ones', () => {
    for (const stage of ['P1', 'P2'] as const) {
      for (const input of ALL_MODEL_INPUTS) {
        const model = defineModel(input, stage);
        expect([stage, input.type, deriveStagedProcesses(model.capabilities, stage)]).toEqual([stage, input.type, model.processes]);
        expect([stage, input.type, deriveStagedTables(model.processes, model.capabilities, stage)]).toEqual([stage, input.type, model.tables]);
      }
    }
  });

  it('createStagedSimulation at stage P2 builds the world createP2Simulation builds, byte for byte', () => {
    const build = (make: () => Simulation): string => {
      const sim = make();
      sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1' });
      sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
      sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: pcConfig('PC1', '10.0.0.1', '255.255.255.0') });
      sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: pcConfig('PC2', '10.0.0.2', '255.255.255.0') });
      sim.addLink({ id: 'l1', a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
      sim.addLink({ id: 'l2', a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/2' } });
      sim.runFor(50 * SEC);
      const s = sim.cli.open('pc1', 'console');
      sim.cli.exec(s, 'ping 10.0.0.2');
      sim.runFor(10 * SEC);
      return JSON.stringify([sim.profile, sim.trace(0).events, sim.snapshot()]);
    };
    const staged = build(() => createStagedSimulation({ seed: 7, stage: 'P2', factories: onlyP2('vlan', 'stp') }));
    expect(staged).toBe(build(() => createP2Simulation({ seed: 7, factories: onlyP2('vlan', 'stp') })));
    expect(JSON.parse(staged)[0]).toBe('P2');
    const p1 = build(() => createStagedSimulation({ seed: 7, stage: 'P2', profile: 'P1' }));
    expect(p1).toBe(build(() => createP2Simulation({ seed: 7, profile: 'P1' })));
  });
});

describe('createStagedSimulation at stage P3', () => {
  const world = (seed: number): Simulation => {
    const sim = createStagedSimulation({ seed, stage: 'P3', factories: withP3('cdp', 'ntp', 'traffic', 'script-host') });
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1' });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
    sim.addDevice({ id: 'wlc1', type: 'wlc.nfwlc9800', name: 'WLC1' });
    sim.addDevice({ id: 'dev1', type: NF_DEVHOST_TYPE, name: 'DEV1' });
    sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: pcConfig('PC1', '10.0.0.1', '255.255.255.0') });
    sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: pcConfig('PC2', '10.0.0.2', '255.255.255.0') });
    sim.addLink({ id: 'l1', a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
    sim.addLink({ id: 'l2', a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/2' } });
    sim.addLink({ id: 'l3', a: { device: 'wlc1', port: 'GigabitEthernet0/1' }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
    sim.runFor(60 * SEC);
    const s = sim.cli.open('pc1', 'console');
    sim.cli.exec(s, 'ping 10.0.0.2');
    sim.runFor(10 * SEC);
    return sim;
  };

  it('boots a real P3 world: P3 daemons with a factory run, the snooping tables exist empty on the switch only, nothing is missing', () => {
    const sim = world(3);
    expect(sim.profile).toBe('P3');
    expect(createStagedSimulation({ seed: 1, stage: 'P3', profile: 'P2' }).profile).toBe('P2');
    const sw = sim.device('sw1')!;
    for (const p of ['cdp', 'ntp', 'udp', 'tcp']) expect([p, sw.processes.has(p)]).toEqual([p, true]);
    expect(sw.processes.has('acl')).toBe(false);
    expect(sw.tables.names()).toEqual(expect.arrayContaining(['dhcp-snooping', 'arp-inspection', 'cdp-neighbours', 'ntp-peers', 'clock']));
    expect(sw.tables.get('dhcp-snooping')!.rows()).toEqual([]);
    expect(sw.tables.get('arp-inspection')!.rows()).toEqual([]);
    const wlc = sim.device('wlc1')!;
    expect(wlc.processes.has('cdp')).toBe(true);
    expect(wlc.tables.names()).not.toContain('dhcp-snooping');
    expect(wlc.tables.names()).not.toContain('arp-inspection');
    expect(sim.device('r1')!.processes.has('ntp')).toBe(true);
    const dev = sim.device('dev1')!;
    expect(dev.processes.has('script-host')).toBe(true);
    expect(dev.tables.names()).toContain('script-runs');
    expect(missing(sim.trace(0).events)).toEqual([]);
    const replies = sim.trace(0).events.filter((e) => e.kind === 'pduCreated' && e.device === 'pc2' && e.pdu.tag === 'echo-reply');
    expect(replies).toHaveLength(5);
  });

  it('two P3 worlds built with the same inputs are byte-identical', () => {
    const json = (sim: Simulation): string => JSON.stringify([sim.trace(0).events, sim.snapshot()]);
    expect(json(world(11))).toBe(json(world(11)));
  });
});
