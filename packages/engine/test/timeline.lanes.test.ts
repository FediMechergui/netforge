/**
 * `laneOf` puts every trace event in the lane §3.13 step 1 names, and nowhere else (ARCHITECTURE-P2 §2.13) [S1].
 *
 * The expected table below is written out by hand from the brief, not derived from the module, so a changed mapping
 * has to be a deliberate edit in both places.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { FsmMachine, FsmTransition } from '../src/contracts/process.js';
import type { ExtraTableName } from '../src/contracts/tables.js';
import { TABLE_DESCRIPTORS } from '../src/contracts/tables.js';
import type { LaneId } from '../src/contracts/timeline.js';
import type { PduSummary, TraceEvent, TraceKind } from '../src/contracts/trace.js';
import {
  FSM_MACHINE_LANES,
  LANE_IDS,
  LANE_INDEX,
  TABLE_LANES,
  laneOf,
  laneOfMachine,
  laneOfTable,
} from '../src/timeline/lanes.js';

const PDU = { id: 1, proto: 'ethernet', size: 64, summary: 'x' } as PduSummary;
const REF = { device: 'd1', port: 'Gi0/1' } as const;

/** One minimal event of every trace kind (the fields laneOf does not read are placeholders). */
const SAMPLE: Readonly<Record<TraceKind, TraceEvent>> = {
  frameTx: { t: 1, kind: 'frameTx', pdu: PDU, link: 'l1', from: REF, to: REF, txStart: 1, txEnd: 2, arrive: 3 },
  frameRx: { t: 1, kind: 'frameRx', pdu: PDU, device: 'd1', port: 'Gi0/1' },
  drop: { t: 1, kind: 'drop', pdu: PDU, device: 'd1', reason: 'no-route' },
  pduCreated: { t: 1, kind: 'pduCreated', pdu: PDU, device: 'd1', process: 'arp' },
  pduConsumed: { t: 1, kind: 'pduConsumed', pdu: PDU, device: 'd1', process: 'arp' },
  mutation: { t: 1, kind: 'mutation', pdu: 1, mutation: { field: 'ipv4.ttl', before: 64, after: 63, reason: 'TtlDecrement', device: 'd1', at: 1 } } as TraceEvent,
  tableWrite: { t: 1, kind: 'tableWrite', device: 'd1', table: 'cam', key: 'k', row: {} },
  tableExpire: { t: 1, kind: 'tableExpire', device: 'd1', table: 'cam', key: 'k', row: {}, reason: 'aged' },
  debug: { t: 1, kind: 'debug', event: { at: 1, device: 'd1', process: 'eth-switch', category: 'ethernet switching', message: 'learned' } },
  log: { t: 1, kind: 'log', device: 'd1', severity: 5, facility: 'LINK', message: 'm' },
  linkState: { t: 1, kind: 'linkState', link: 'l1', up: true },
  portState: { t: 1, kind: 'portState', device: 'd1', port: 'Gi0/1', adminUp: true, operUp: true },
  deviceState: { t: 1, kind: 'deviceState', device: 'd1', power: true, booted: true },
  cliOutput: { t: 1, kind: 'cliOutput', session: 's1', text: 'x' },
  cliPrompt: { t: 1, kind: 'cliPrompt', session: 's1', prompt: 'R1#', busy: false },
  configChange: { t: 1, kind: 'configChange', device: 'd1', line: 'hostname R1', negate: false, context: [] },
  topologyChanged: { t: 1, kind: 'topologyChanged', what: 'device', id: 'd1', op: 'add' },
  frameAbort: { t: 1, kind: 'frameAbort', pdu: PDU, link: 'l1', from: REF, to: REF, abortAt: 2, arrive: 3, reason: 'collision' },
  collision: { t: 1, kind: 'collision', segment: 'seg:1', stations: [REF], pdus: [1], detectAt: 1, jamUntil: 2, late: false },
  backoff: { t: 1, kind: 'backoff', device: 'd1', port: 'Gi0/1', pdu: 1, attempt: 1, slots: 1, until: 2 },
  carrierDefer: { t: 1, kind: 'carrierDefer', device: 'd1', port: 'Gi0/1', pdu: 1, until: 2 },
  phyNegotiated: { t: 1, kind: 'phyNegotiated', link: 'l1', a: {} as never, b: {} as never },
  assocState: { t: 1, kind: 'assocState', tech: 'wifi', medium: 'bss:d1/Wlan0', station: REF, state: 'associated', prev: 'handshake' },
  rfState: { t: 1, kind: 'rfState', port: REF, peer: REF, rssiDbm: -60, snrDb: 30, rateBps: 1, bars: 3 },
  segmentChanged: { t: 1, kind: 'segmentChanged', segment: 'seg:1', members: [REF], op: 'formed' },
} as Record<TraceKind, TraceEvent>;

/** §3.13 step 1, kind by kind, for the samples above (the cam table and a debug line without fsm are in no lane). */
const EXPECTED_BY_KIND: Readonly<Record<TraceKind, LaneId | undefined>> = {
  frameTx: undefined,
  frameRx: undefined,
  drop: 'drops',
  pduCreated: undefined,
  pduConsumed: undefined,
  mutation: undefined,
  tableWrite: undefined,
  tableExpire: undefined,
  debug: undefined,
  log: undefined,
  linkState: 'link',
  portState: 'link',
  deviceState: undefined,
  cliOutput: undefined,
  cliPrompt: undefined,
  configChange: 'config',
  topologyChanged: undefined,
  frameAbort: undefined,
  collision: undefined,
  backoff: undefined,
  carrierDefer: undefined,
  phyNegotiated: undefined,
  assocState: undefined,
  rfState: undefined,
  segmentChanged: undefined,
};

/** Table → lane, written from the brief (tables not listed are in no lane). */
const EXPECTED_TABLES: Readonly<Record<'cam' | 'arp' | 'rib' | ExtraTableName, LaneId | undefined>> = {
  cam: undefined,
  arp: undefined,
  rib: 'routing',
  nd: undefined,
  rib6: 'routing',
  sockets: undefined,
  'dhcp-bindings': 'dhcp',
  'dns-cache': undefined,
  'dot11-assoc': 'wireless',
  vlans: 'vlan',
  dtp: 'vlan',
  stp: 'stp',
  'stp-bridge': 'stp',
  etherchannel: 'etherchannel',
  'port-security': 'security',
  nat: 'nat',
  'dhcpv6-bindings': 'dhcp',
  capwap: 'wireless',
  'capwap-aps': 'wireless',
  'wlan-clients': 'wireless',
  hsrp: 'fhrp',
};

/** Machine → lane, written from the brief. */
const EXPECTED_MACHINES: Readonly<Record<FsmMachine, LaneId>> = {
  'stp-port': 'stp',
  'stp-bridge': 'stp',
  dtp: 'vlan',
  lacp: 'etherchannel',
  channel: 'etherchannel',
  pagp: 'etherchannel',
  'port-security': 'security',
  'err-disable': 'security',
  nat: 'nat',
  dhcpv6: 'dhcp',
  'capwap-wtp': 'wireless',
  'capwap-ac': 'wireless',
  hsrp: 'fhrp',
};

function fsmEvent(machine: FsmMachine): TraceEvent {
  const fsm: FsmTransition = { machine, subject: 'VLAN0001 GigabitEthernet0/1', from: 'listening', to: 'learning' };
  return { t: 5, kind: 'debug', event: { at: 5, device: 'd1', process: 'stp', category: 'spanning-tree events', message: 'm', fsm } };
}

function tableEvent(kind: 'tableWrite' | 'tableExpire', table: string): TraceEvent {
  return kind === 'tableWrite'
    ? { t: 5, kind, device: 'd1', table, key: 'k', row: { key: 'k' } }
    : { t: 5, kind, device: 'd1', table, key: 'k', row: { key: 'k' }, reason: 'aged' };
}

describe('laneOf', () => {
  it('maps every trace kind as §3.13 step 1 says', () => {
    for (const kind of Object.keys(EXPECTED_BY_KIND) as TraceKind[]) {
      const ev = SAMPLE[kind];
      expect(ev.kind).toBe(kind);
      expect(laneOf(ev), kind).toBe(EXPECTED_BY_KIND[kind]);
    }
  });

  it('puts an fsm debug event in the lane of its machine, and a plain debug line in none', () => {
    for (const machine of Object.keys(EXPECTED_MACHINES) as FsmMachine[]) {
      expect(laneOf(fsmEvent(machine)), machine).toBe(EXPECTED_MACHINES[machine]);
      expect(laneOfMachine(machine)).toBe(EXPECTED_MACHINES[machine]);
    }
    expect(FSM_MACHINE_LANES).toEqual(EXPECTED_MACHINES);
    expect(laneOf(SAMPLE.debug)).toBeUndefined();
    expect(laneOfMachine('ospf-neighbour')).toBeUndefined();
  });

  it('maps table writes and expiries by table, for every table descriptor', () => {
    expect(Object.keys(EXPECTED_TABLES).sort()).toEqual(Object.keys(TABLE_DESCRIPTORS).sort());
    for (const table of Object.keys(EXPECTED_TABLES) as (keyof typeof EXPECTED_TABLES)[]) {
      expect(laneOf(tableEvent('tableWrite', table)), `write ${table}`).toBe(EXPECTED_TABLES[table]);
      expect(laneOf(tableEvent('tableExpire', table)), `expire ${table}`).toBe(EXPECTED_TABLES[table]);
      expect(laneOfTable(table)).toBe(EXPECTED_TABLES[table]);
    }
    expect(laneOfTable('mystery')).toBeUndefined();
    expect(laneOfTable('toString')).toBeUndefined();
    const listed = Object.entries(EXPECTED_TABLES).filter(([, lane]) => lane !== undefined);
    expect(Object.entries(TABLE_LANES).sort()).toEqual(listed.sort());
  });

  it('counts a background drop in the drops lane too', () => {
    const ev: TraceEvent = { t: 9, kind: 'drop', pdu: PDU, device: 'd1', reason: 'not-for-me', background: true };
    expect(laneOf(ev)).toBe('drops');
  });

  it('reaches every lane from some event', () => {
    const reached = new Set<LaneId>();
    for (const ev of Object.values(SAMPLE)) {
      const lane = laneOf(ev);
      if (lane !== undefined) reached.add(lane);
    }
    for (const m of Object.keys(EXPECTED_MACHINES) as FsmMachine[]) reached.add(laneOf(fsmEvent(m)) as LaneId);
    for (const t of Object.keys(EXPECTED_TABLES)) {
      const lane = laneOf(tableEvent('tableWrite', t));
      if (lane !== undefined) reached.add(lane);
    }
    expect([...reached].sort()).toEqual([...LANE_IDS].sort());
  });

  it('is pure: the same event gives the same lane and is not touched', () => {
    const ev = fsmEvent('lacp');
    const before = JSON.stringify(ev);
    expect(laneOf(ev)).toBe(laneOf(ev));
    expect(JSON.stringify(ev)).toBe(before);
  });
});

describe('lane numbering', () => {
  it('numbers the twelve lanes 0..11 in canonical order', () => {
    expect(LANE_IDS).toEqual(['link', 'stp', 'etherchannel', 'vlan', 'fhrp', 'routing', 'nat', 'dhcp', 'wireless', 'security', 'config', 'drops']);
    LANE_IDS.forEach((lane, i) => expect(LANE_INDEX[lane]).toBe(i));
    expect(Object.keys(LANE_INDEX).sort()).toEqual([...LANE_IDS].sort());
  });

  it('is exported from the engine entry', () => {
    // Read as text: importing the whole entry would couple this test to every module built in the same wave.
    const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(index).toContain("export * from './timeline/lanes.js';");
  });
});
