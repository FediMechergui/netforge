/**
 * test/staged.world.ts, the P3c path (ARCHITECTURE-P3C §0 rule 13, §7 W0 qa): at stage 'P3c' the helper holds, as
 * test-only data, the final P3c `PROCESS_ORDER` restricted to the approved names, the P3c `CAPABILITY_PROCESSES` rows
 * (CLI models only, D6), the `storm-control` staged table [S16], the `voice-endpoint` capability on NF-IPPHONE [S35] and
 * the routers' and switches' `storage` data [S29] [S30].
 *
 * The data is checked against this file's own transcription of §2.1. The P3c catalog is then compared with the real
 * one model for model: it differs by exactly those deltas (plus the real `GUI_PANEL_SINCE` 'P3c' panels, which
 * `defineModel` derives at stage P3c from the contract itself), every other member and every other model is unchanged,
 * and every stage before P3c builds exactly what it built before. The comparisons are written as "the real model with
 * the P3c data added", so they hold before the W4b flip (a real delta) and after it (the delta is already in the real
 * models); `staged.world.p3c-parity.test.ts` (W4b) pins equality. The P3c daemons are given silent stubs with
 * `withP3c(...)` (and removed otherwise), so the flip's factory registrations cannot change the expected lists.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILD_STAGES,
  CAPABILITY_PROCESSES,
  GUI_PANELS,
  PROCESS_ORDER,
  stageIncluded,
  type BuildStage,
  type Capability,
  type GuiPanelId,
} from '../src/contracts/catalog.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { ProcessName } from '../src/contracts/ids.js';
import type { ProcessFactory } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { IMAGE_HEADER_BYTES } from '../src/contracts/storage.js';
import { PROCESS_TABLES, STAGED_PROCESS_TABLES, TABLE_DESCRIPTORS, type TableName } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { ALL_MODEL_INPUTS, ALL_MODELS, ALL_MODULES, CATALOG_STAGE } from '../src/device/catalog.js';
import { deepFreeze, defineModel, derivePortOwners, deriveProcesses, deriveTables, moduleReachableProcesses, type ModelInput } from '../src/device/catalog/define.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { P3C_APPROVED_ITEMS } from './p3c-approved-items.js';
import {
  P3C_CAPABILITY_PROCESS_ROWS,
  P3C_DAEMONS,
  P3C_MODEL_CAPABILITY_DELTAS,
  P3C_PROCESS_ORDER,
  P3C_PROCESS_TABLES,
  P3C_STAGED_DAEMONS,
  P3C_STAGED_PROCESS_TABLES,
  P3C_STORAGE,
  P3C_STORAGE_KINDS,
  STAGED_DAEMONS,
  applyP2ModelDelta,
  createStagedCatalog,
  createStagedSimulation,
  defineStagedModel,
  deriveStagedProcesses,
  deriveStagedTables,
  stagedDefaultProfile,
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

/** An overlay giving the named P3c daemons a silent stub and removing every other P3c daemon (P2/P3 daemons stay real). */
function withP3c(...names: ProcessName[]): StagedFactoryOverlay {
  const out: Record<ProcessName, ProcessFactory | undefined> = {};
  for (const p of P3C_DAEMONS) out[p] = names.includes(p) ? stub(p) : undefined;
  return out;
}

const missing = (events: readonly TraceEvent[]): string[] =>
  events.flatMap((e) => (e.kind === 'log' && e.message.includes('is not available') ? [e.message] : []));

// ── this file's transcription of ARCHITECTURE-P3C §2.1 and §7 W4b ───────────────────────────────────────────────

/** The §2.1 final P3c `PROCESS_ORDER` as the brief writes it (every P3c name is approved, §8.5c). */
const FINAL_ORDER_P3C: readonly ProcessName[] = [
  'wlan-ap', 'wlan-client', 'capwap-wtp', 'cell-client', 'hdlc', 'ppp', 'eth-switch', 'vlan', 'dtp', 'etherchannel', 'stp',
  'cdp', 'lldp', 'arp', 'ipv4', 'nat', 'acl', 'gre', 'icmpv4', 'host', 'ipv6', 'nd', 'icmpv6', 'udp', 'tcp', 'vty',
  'vty-client', 'logger', 'ntp', 'tftp', 'snmp-agent', 'snmp-manager', 'syslog-server', 'hsrp', 'ospf', 'ospfv3',
  'eigrp', 'ike', 'dhcp-client', 'dhcp-server', 'dhcpv6-client', 'dhcpv6-server', 'dns-client', 'dns-server',
  'http-client', 'http-server', 'restconf', 'traceroute', 'traffic', 'capwap-ac', 'script-host',
];
const NEW_NAMES: readonly ProcessName[] = ['tftp', 'snmp-agent', 'snmp-manager', 'ospfv3'];

/** The §2.1 `CAPABILITY_PROCESSES` additions of P3c, by capability, as the brief's table lists them. */
const ROWS_P3C: Readonly<Partial<Record<Capability, readonly ProcessName[]>>> = {
  routing: ['tftp', 'snmp-agent', 'ospfv3'],
  'managed-switch': ['tftp', 'snmp-agent'],
  server: ['tftp', 'snmp-manager'],
  programmable: ['snmp-manager'],
  'voice-endpoint': ['cdp', 'lldp'],
};

/** The §2.1 `PROCESS_TABLES` additions of P3c. */
const TABLES_P3C: Readonly<Record<ProcessName, readonly TableName[]>> = {
  ospfv3: ['ospf6-interfaces', 'ospf6-neighbors', 'ospf6-lsdb'],
  'snmp-manager': ['snmp-traps'],
};

/** The P3c GUI panels and the capability rule of each (§2.1; the real `deriveGui` derives them at stage P3c). */
const PANELS_P3C: readonly (readonly [GuiPanelId, (caps: readonly Capability[]) => boolean])[] = [
  ['desktop.snmp-manager', (c) => c.includes('server') || c.includes('programmable')],
  ['desktop.api-client', (c) => c.includes('host')],
];

/** Members the P3c path may change; every other member of every model is the real model's. */
const DELTA_KEYS = ['capabilities', 'processes', 'tables', 'gui', 'storage'] as const;

/** The models the P3c data does not touch at all (no CLI shell, no P3c capability, no host panel). */
const UNTOUCHED_TYPES: readonly string[] = [
  'hub.nfhub4', 'hub.nfhub8', 'hub.nfcoax', 'repeater.nfrep', 'bridge.nfbr2', 'bridge.nfbr4',
  'ap.nfap-auto', 'ap.nfap-lw', 'ap.nfap-mesh', 'ap.nfap-ax', 'wlc.nfwlc9800', 'wrouter.nfhome', 'wrouter.nfhome-ax',
  'radio.nfptp5', 'radio.nfptp60', 'cell.nftower', 'modem.nfdsl', 'modem.nfcable', 'modem.nfont', 'csu.nfcsu',
  'cloud.nfinternet',
];

const rank = (p: ProcessName): number => FINAL_ORDER_P3C.indexOf(p);
const byOrder = (names: Iterable<ProcessName>): ProcessName[] => [...new Set(names)].sort((a, b) => rank(a) - rank(b));
const strip = (m: DeviceModel): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...m };
  for (const k of DELTA_KEYS) delete out[k];
  return out;
};

/** The P3c daemons a real model gains: the rows of its capabilities (plus voice-endpoint on the phone), CLI models only. */
function expectedP3cDaemons(m: DeviceModel, caps: readonly Capability[]): ProcessName[] {
  if (m.cli.shell === 'none') return [];
  return caps.flatMap((c) => [...(ROWS_P3C[c] ?? [])]);
}

/** The pre-P3c `defineStagedModel` (this file's copy of the code at faf2d12), the reference of every earlier stage. */
function referenceDefineStagedModel(input: ModelInput, stage: BuildStage, registry: StagedRegistry): DeviceModel {
  const base = defineModel(applyP2ModelDelta(input), stage, ALL_MODULES);
  const processes = base.processes.filter((p) => !STAGED_DAEMONS.includes(p) || Object.prototype.hasOwnProperty.call(registry, p));
  const moduleProcesses = moduleReachableProcesses(base.capabilities, base.slots, processes, stage, ALL_MODULES);
  return deepFreeze<DeviceModel>({
    ...base,
    processes,
    tables: deriveTables(processes, base.capabilities, stage),
    portOwners: derivePortOwners(base.ports, base.virtualFamilies, processes, moduleProcesses),
  });
}

// ── the data ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('staged.world P3c test-only data', () => {
  it('the P3c items behind the data are approved (§8.5c), and the stage exists after P3', () => {
    for (const id of ['S6', 'S16', 'S29', 'S30', 'S33', 'S35'] as const) expect([id, (P3C_APPROVED_ITEMS as readonly string[]).includes(id)]).toEqual([id, true]);
    expect(BUILD_STAGES.slice(-2)).toEqual(['P3', 'P3c']);
    expect(stagedDefaultProfile('P3c')).toBe('P3');
  });

  it('P3C_PROCESS_ORDER is the §2.1 final order restricted to the approved names; the real order is a part of it', () => {
    expect(P3C_PROCESS_ORDER).toEqual(FINAL_ORDER_P3C);
    expect(P3C_DAEMONS).toEqual(NEW_NAMES);
    expect(P3C_STAGED_DAEMONS).toEqual([...STAGED_DAEMONS, ...NEW_NAMES]);
    // every real name keeps its relative order (W0 inserts none; W4b inserts each at this position)
    expect(P3C_PROCESS_ORDER.filter((p) => !NEW_NAMES.includes(p))).toEqual(PROCESS_ORDER.filter((p) => !NEW_NAMES.includes(p)));
    expect(PROCESS_ORDER.filter((p) => P3C_PROCESS_ORDER.includes(p))).toEqual(P3C_PROCESS_ORDER.filter((p) => PROCESS_ORDER.includes(p)));
    // the constraints §2.1 relies on
    for (const later of ['tftp', 'snmp-agent', 'snmp-manager']) expect(rank('udp')).toBeLessThan(rank(later));
    for (const before of ['ipv6', 'ospf']) expect(rank(before)).toBeLessThan(rank('ospfv3'));
  });

  it('P3C_CAPABILITY_PROCESS_ROWS are the §2.1 rows, all since P3c, each capability in the final order', () => {
    expect(Object.keys(P3C_CAPABILITY_PROCESS_ROWS).sort()).toEqual(Object.keys(ROWS_P3C).sort());
    for (const [cap, names] of Object.entries(ROWS_P3C) as [Capability, readonly ProcessName[]][]) {
      const rows = P3C_CAPABILITY_PROCESS_ROWS[cap]!;
      expect([cap, rows.map((r) => r.process)]).toEqual([cap, names]);
      expect([cap, rows.every((r) => r.since === 'P3c')]).toEqual([cap, true]);
      expect([cap, byOrder(names)]).toEqual([cap, [...names]]);
    }
    // the real contract has no P3c row the test data does not hold
    for (const [cap, rows] of Object.entries(CAPABILITY_PROCESSES) as [Capability, readonly { process: ProcessName; since: BuildStage }[]][]) {
      for (const r of rows.filter((x) => x.since === 'P3c')) expect([cap, r.process, (ROWS_P3C[cap] ?? []).includes(r.process)]).toEqual([cap, r.process, true]);
    }
  });

  it('P3C_PROCESS_TABLES and the storm-control staged row are the §2.1 data, with P3c descriptors', () => {
    expect(P3C_PROCESS_TABLES).toEqual(TABLES_P3C);
    expect(P3C_STAGED_PROCESS_TABLES).toEqual([{ process: 'eth-switch', tables: ['storm-control'], since: 'P3c', requires: 'managed-switch' }]);
    for (const t of ['ospf6-interfaces', 'ospf6-neighbors', 'ospf6-lsdb', 'snmp-traps', 'storm-control'] as const) {
      expect([t, TABLE_DESCRIPTORS[t].since]).toEqual([t, 'P3c']);
    }
    // the P3 vlan row is unchanged (one row, one since)
    expect(STAGED_PROCESS_TABLES.filter((r) => r.since !== 'P3c')).toEqual([
      { process: 'vlan', tables: ['dhcp-snooping', 'arp-inspection'], since: 'P3', requires: 'managed-switch' },
    ]);
  });

  it('NF-IPPHONE is the one model that gains a capability: voice-endpoint', () => {
    expect(P3C_MODEL_CAPABILITY_DELTAS).toEqual({ 'ipphone.nfphone': ['voice-endpoint'] });
  });

  it('P3C_STORAGE covers exactly the NF-OS routers and switches, and every value is coherent', () => {
    const want = ALL_MODELS.filter((m) => P3C_STORAGE_KINDS.includes(m.kind)).map((m) => m.type);
    expect(Object.keys(P3C_STORAGE)).toEqual(want);
    expect(want.length).toBe(14);
    for (const m of ALL_MODELS.filter((x) => P3C_STORAGE_KINDS.includes(x.kind))) {
      const s = P3C_STORAGE[m.type]!;
      expect([m.type, m.cli.shell]).toEqual([m.type, 'nfos']);
      for (const n of [s.flashBytes, s.nvramBytes, s.image.nominalBytes]) expect([m.type, Number.isSafeInteger(n) && n > 0]).toEqual([m.type, true]);
      // the image fits its flash with room for lab 31's 40 MB upgrade beside it (§3.4)
      expect([m.type, s.image.nominalBytes + 40 * 1024 * 1024 <= s.flashBytes]).toEqual([m.type, true]);
      // the nominal size fits the 10 decimal digits of the 16-byte image header ('NFIMG1' + 10 digits)
      expect(IMAGE_HEADER_BYTES).toBe(16);
      expect([m.type, String(s.image.nominalBytes).length <= 10]).toEqual([m.type, true]);
      // original NetForge names: nf…-<version>.bin
      expect([m.type, /^nf[a-z0-9]+-\d+\.\d+\.bin$/.test(s.image.file), s.image.file.endsWith(`-${s.image.version}.bin`)]).toEqual([m.type, true, true]);
    }
    // NF-2911 (R1 of lab 31) runs an older version than the nf2900-15.9.bin upgrade
    expect(P3C_STORAGE['router.nf2911']!.image).toEqual({ file: 'nf2900-15.7.bin', version: '15.7', nominalBytes: 38 * 1024 * 1024 });
  });
});

// ── the P3c catalog against the real one ──────────────────────────────────────────────────────────────────────

describe('staged.world at stage P3c differs from the real catalog by exactly the P3c deltas', () => {
  const staged = createStagedCatalog({ stage: 'P3c', factories: withP3c(...P3C_DAEMONS) });

  it('holds every real model, in palette order, and nothing else', () => {
    expect(staged.list().map((m) => m.type)).toEqual(ALL_MODELS.map((m) => m.type));
  });

  it('every member outside the deltas is the real model\'s, model for model', () => {
    for (const real of ALL_MODELS) {
      const m = staged.get(real.type)!;
      expect([real.type, JSON.stringify(strip(m))]).toEqual([real.type, JSON.stringify(strip(real))]);
    }
  });

  it('capabilities, daemons, tables, panels and storage are the real ones plus the P3c data', () => {
    for (const real of ALL_MODELS) {
      const m = staged.get(real.type)!;
      const caps = [...real.capabilities, ...(real.type === 'ipphone.nfphone' && !real.capabilities.includes('voice-endpoint') ? (['voice-endpoint'] as const) : [])];
      expect([real.type, m.capabilities]).toEqual([real.type, caps]);
      const processes = byOrder([...real.processes, ...expectedP3cDaemons(real, caps)]);
      expect([real.type, m.processes]).toEqual([real.type, processes]);
      // tables: the real ones plus the new daemons' tables and storm-control on managed switches, in daemon order
      const tables: TableName[] = ['cam', 'arp', 'rib'];
      const add = (t: TableName): void => {
        if (!tables.includes(t)) tables.push(t);
      };
      for (const p of processes) {
        for (const t of PROCESS_TABLES[p] ?? []) add(t);
        for (const t of TABLES_P3C[p] ?? []) add(t);
        if (p === 'vlan' && caps.includes('managed-switch')) for (const t of ['dhcp-snooping', 'arp-inspection']) add(t);
        if (p === 'eth-switch' && caps.includes('managed-switch')) add('storm-control');
      }
      expect([real.type, m.tables]).toEqual([real.type, tables]);
      const gui = GUI_PANELS.filter((id) => (real.gui ?? []).includes(id) || PANELS_P3C.some(([p, rule]) => p === id && rule(caps)));
      expect([real.type, m.gui]).toEqual([real.type, gui]);
      expect([real.type, m.storage]).toEqual([real.type, P3C_STORAGE[real.type]]);
    }
  });

  it('the P3c rows derive only on models with a CLI shell: home routers and the controller gain no daemon', () => {
    for (const type of ['wrouter.nfhome', 'wrouter.nfhome-ax', 'wlc.nfwlc9800']) {
      const real = ALL_MODELS.find((m) => m.type === type)!;
      expect([type, real.cli.shell, staged.get(type)!.processes]).toEqual([type, 'none', real.processes]);
    }
    expect(ALL_MODELS.find((m) => m.type === 'wrouter.nfhome')!.capabilities).toContain('routing');
  });

  it('spot checks: a router, a switch, a multilayer switch, a server, NF-DEVHOST and NF-IPPHONE', () => {
    const p3cOf = (type: string): ProcessName[] => {
      const real = ALL_MODELS.find((m) => m.type === type)!;
      return staged.get(type)!.processes.filter((p) => !real.processes.includes(p));
    };
    const pre = CATALOG_STAGE !== 'P3c'; // before the W4b flip the real models lack the P3c data
    if (pre) {
      expect(p3cOf('router.nf2911')).toEqual(['tftp', 'snmp-agent', 'ospfv3']);
      expect(p3cOf('switch.nfc2960')).toEqual(['tftp', 'snmp-agent']);
      expect(p3cOf('mlswitch.nfc3650-24')).toEqual(['tftp', 'snmp-agent', 'ospfv3']);
      expect(p3cOf('firewall.nfasa5506')).toEqual(['tftp', 'snmp-agent', 'ospfv3']);
      expect(p3cOf('server.nfserver')).toEqual(['tftp', 'snmp-manager']);
      expect(p3cOf('pc.nfdevhost')).toEqual(['snmp-manager']);
      expect(p3cOf('ipphone.nfphone')).toEqual(['cdp', 'lldp']);
      expect(p3cOf('pc.nfpc')).toEqual([]);
    }
    const r1 = staged.get('router.nf2911')!.processes;
    expect(r1.slice(r1.indexOf('ntp'), r1.indexOf('ntp') + 3)).toEqual(['ntp', 'tftp', 'snmp-agent']);
    expect(r1.slice(r1.indexOf('ospf'), r1.indexOf('ospf') + 3)).toEqual(['ospf', 'ospfv3', 'eigrp']);
    const srv = staged.get('server.nfserver')!.processes;
    expect(srv.slice(srv.indexOf('ntp'), srv.indexOf('ntp') + 4)).toEqual(['ntp', 'tftp', 'snmp-manager', 'syslog-server']);
    const sw = staged.get('switch.nfc2960')!;
    expect(sw.tables.slice(0, 4)).toEqual(['cam', 'arp', 'rib', 'storm-control']);
    expect(staged.get('mlswitch.nfc3650-24')!.tables).toEqual(expect.arrayContaining(['storm-control', 'ospf6-interfaces', 'ospf6-neighbors', 'ospf6-lsdb']));
    expect(staged.get('router.nf2911')!.tables).not.toContain('storm-control');
    expect(staged.get('wlc.nfwlc9800')!.tables).not.toContain('storm-control'); // eth-switch and vlan, but no managed-switch
    expect(staged.get('server.nfserver')!.tables).toContain('snmp-traps');
    expect(staged.get('ipphone.nfphone')!.tables).toEqual(expect.arrayContaining(['cdp-neighbours', 'lldp-neighbours']));
    expect(staged.get('ipphone.nfphone')!.cdpDefault).toBeUndefined(); // answer-driven (D9), no new default
    expect(staged.get('firewall.nfasa5506')!.storage).toBeUndefined();
  });

  it('exactly the untouched models are equal to the real ones; every other model changes (before the flip)', () => {
    const same = ALL_MODELS.filter((real) => JSON.stringify(staged.get(real.type)) === JSON.stringify(real)).map((m) => m.type);
    if (CATALOG_STAGE === 'P3c') expect(same).toEqual(ALL_MODELS.map((m) => m.type));
    else expect(same).toEqual(UNTOUCHED_TYPES);
  });

  it('the derivations: deriveStagedProcesses and deriveStagedTables build the P3c models from the capabilities', () => {
    for (const m of staged.list()) {
      expect([m.type, deriveStagedProcesses(m.capabilities, 'P3c', m.cli)]).toEqual([m.type, m.processes]);
      expect([m.type, deriveStagedTables(m.processes, m.capabilities, 'P3c')]).toEqual([m.type, m.tables]);
    }
    // the shell defaults to the derived one: a home router's capabilities derive no P3c daemon
    const home = ALL_MODELS.find((m) => m.type === 'wrouter.nfhome')!;
    expect(deriveStagedProcesses(home.capabilities, 'P3c')).toEqual(home.processes.filter((p) => P3C_PROCESS_ORDER.includes(p)));
    expect(deriveStagedProcesses(home.capabilities, 'P3c', { shell: 'nfos' })).toEqual(expect.arrayContaining(['tftp', 'snmp-agent', 'ospfv3']));
  });

  it('a P3c daemon without a factory is left off with its tables; the rest keep the final order', () => {
    const none = createStagedCatalog({ stage: 'P3c', factories: withP3c() });
    for (const m of none.list()) for (const p of NEW_NAMES) expect([m.type, m.processes.includes(p)]).toEqual([m.type, false]);
    const r1 = none.get('router.nf2911')!;
    expect(r1.tables.filter((t) => t.startsWith('ospf6-'))).toEqual([]);
    expect(r1.storage).toEqual(P3C_STORAGE['router.nf2911']); // model data, not a daemon
    // the phone's cdp and lldp are real daemons with real factories, so they stay
    expect(none.get('ipphone.nfphone')!.processes).toEqual(expect.arrayContaining(['cdp', 'lldp']));
    expect(none.get('switch.nfc2960')!.tables).toContain('storm-control'); // eth-switch has a factory
    const one = createStagedCatalog({ stage: 'P3c', factories: withP3c('ospfv3') }).get('router.nf2911')!;
    expect(one.processes.filter((p) => NEW_NAMES.includes(p))).toEqual(['ospfv3']);
    expect(stagedRegistry(withP3c('tftp')).tftp).toBeTypeOf('function');
  });
});

// ── every earlier stage is untouched ──────────────────────────────────────────────────────────────────────────

describe('staged.world before stage P3c is unchanged by the P3c path', () => {
  const earlier = BUILD_STAGES.filter((s) => !stageIncluded('P3c', s));

  it('the stages before P3c are P0 to P3', () => {
    expect(earlier).toEqual(['P0', 'P0.5', 'P1', 'P2', 'P3']);
  });

  it('every model of every earlier stage equals the pre-P3c code, with and without P3c stubs', () => {
    for (const stage of earlier) {
      for (const overlay of [{}, withP3c(...P3C_DAEMONS)]) {
        const registry = stagedRegistry(overlay);
        const catalog = createStagedCatalog({ stage, factories: overlay });
        for (const input of ALL_MODEL_INPUTS) {
          const expected = JSON.stringify(referenceDefineStagedModel(input, stage, registry));
          expect([stage, input.type, JSON.stringify(defineStagedModel(input, stage, registry))]).toEqual([stage, input.type, expected]);
          expect([stage, input.type, JSON.stringify(catalog.get(input.type))]).toEqual([stage, input.type, expected]);
        }
      }
    }
  });

  it('no earlier stage derives a P3c daemon, table, capability, panel or storage', () => {
    const p3cTables = ['ospf6-interfaces', 'ospf6-neighbors', 'ospf6-lsdb', 'snmp-traps', 'storm-control'];
    for (const stage of earlier) {
      for (const m of createStagedCatalog({ stage, factories: withP3c(...P3C_DAEMONS) }).list()) {
        expect([stage, m.type, m.processes.filter((p) => NEW_NAMES.includes(p))]).toEqual([stage, m.type, []]);
        expect([stage, m.type, m.tables.filter((t) => p3cTables.includes(t))]).toEqual([stage, m.type, []]);
        expect([stage, m.type, m.capabilities.includes('voice-endpoint')]).toEqual([stage, m.type, false]);
        expect([stage, m.type, (m.gui ?? []).filter((g) => PANELS_P3C.some(([p]) => p === g))]).toEqual([stage, m.type, []]);
        expect([stage, m.type, m.storage]).toEqual([stage, m.type, undefined]);
      }
    }
  });

  it('the staged derivations at earlier stages are the real ones, whatever the shell', () => {
    for (const stage of earlier) {
      for (const m of ALL_MODELS) {
        expect([stage, m.type, deriveStagedProcesses(m.capabilities, stage, m.cli)]).toEqual([stage, m.type, deriveProcesses(m.capabilities, stage)]);
        expect([stage, m.type, deriveStagedProcesses(m.capabilities, stage, { shell: 'none' })]).toEqual([stage, m.type, deriveProcesses(m.capabilities, stage)]);
        expect([stage, m.type, deriveStagedTables(m.processes, m.capabilities, stage)]).toEqual([stage, m.type, deriveTables(m.processes, m.capabilities, stage)]);
      }
    }
  });

  it('at the real catalog stage with the real registry the helper still returns the real models', () => {
    expect(JSON.stringify(createStagedCatalog({ stage: CATALOG_STAGE }).list())).toBe(JSON.stringify(ALL_MODELS));
  });

  it('builds leave the real inputs, models and contract data untouched', () => {
    const before = JSON.stringify([ALL_MODEL_INPUTS, ALL_MODELS, PROCESS_ORDER, CAPABILITY_PROCESSES, PROCESS_TABLES, STAGED_PROCESS_TABLES]);
    createStagedCatalog({ stage: 'P3c', factories: withP3c(...P3C_DAEMONS) });
    createStagedCatalog({ stage: 'P3c' });
    createStagedSimulation({ seed: 1, stage: 'P3c' });
    expect(JSON.stringify([ALL_MODEL_INPUTS, ALL_MODELS, PROCESS_ORDER, CAPABILITY_PROCESSES, PROCESS_TABLES, STAGED_PROCESS_TABLES])).toBe(before);
  });
});

// ── a real P3c world ──────────────────────────────────────────────────────────────────────────────────────────

describe('createStagedSimulation at stage P3c', () => {
  const world = (seed: number): Simulation => {
    const sim = createStagedSimulation({ seed, stage: 'P3c', factories: withP3c(...P3C_DAEMONS) });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1' });
    sim.addDevice({ id: 'srv1', type: 'server.nfserver', name: 'SRV1' });
    sim.addDevice({ id: 'ph1', type: 'ipphone.nfphone', name: 'PH1' });
    sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: pcConfig('PC1', '10.0.0.1', '255.255.255.0') });
    sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: pcConfig('PC2', '10.0.0.2', '255.255.255.0') });
    sim.addLink({ id: 'l1', a: { device: 'ph1', port: 'FastEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
    sim.addLink({ id: 'l2', a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'ph1', port: 'FastEthernet1' } });
    sim.addLink({ id: 'l3', a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/2' } });
    sim.addLink({ id: 'l4', a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
    sim.runFor(60 * SEC);
    const s = sim.cli.open('pc1', 'console');
    sim.cli.exec(s, 'ping 10.0.0.2');
    sim.runFor(10 * SEC);
    return sim;
  };

  it('boots: the P3c daemons run where derived, their tables exist empty, the models carry storage, nothing is missing', () => {
    const sim = world(5);
    expect(sim.profile).toBe('P3');
    const r1 = sim.device('r1')!;
    for (const p of ['tftp', 'snmp-agent', 'ospfv3']) expect([p, r1.processes.has(p)]).toEqual([p, true]);
    expect(r1.tables.names()).toEqual(expect.arrayContaining(['ospf6-interfaces', 'ospf6-neighbors', 'ospf6-lsdb']));
    expect(r1.model.storage).toEqual(P3C_STORAGE['router.nf2911']);
    const sw = sim.device('sw1')!;
    expect([sw.processes.has('tftp'), sw.processes.has('snmp-agent'), sw.processes.has('ospfv3')]).toEqual([true, true, false]);
    expect(sw.tables.get('storm-control')!.rows()).toEqual([]);
    const srv = sim.device('srv1')!;
    expect([srv.processes.has('tftp'), srv.processes.has('snmp-manager')]).toEqual([true, true]);
    expect(srv.tables.get('snmp-traps')!.rows()).toEqual([]);
    expect(srv.model.storage).toBeUndefined();
    const ph = sim.device('ph1')!;
    expect([ph.processes.has('cdp'), ph.processes.has('lldp')]).toEqual([true, true]);
    expect(ph.model.capabilities).toContain('voice-endpoint');
    expect(missing(sim.trace(0).events)).toEqual([]);
    const replies = sim.trace(0).events.filter((e) => e.kind === 'pduCreated' && e.device === 'pc2' && e.pdu.tag === 'echo-reply');
    expect(replies).toHaveLength(5);
  });

  it('two P3c worlds built with the same inputs are byte-identical', () => {
    const json = (sim: Simulation): string => JSON.stringify([sim.trace(0).events, sim.snapshot()]);
    expect(json(world(13))).toBe(json(world(13)));
  });
});
