import { describe, expect, it } from 'vitest';
import { matchesTraceFilter } from '../src/trace/filter.js';
import type { TraceFilter } from '../src/contracts/simulation.js';
import type { PduSummary, TraceEvent } from '../src/contracts/trace.js';

const pdu = (over: Partial<PduSummary> = {}): PduSummary => ({
  id: 1,
  proto: 'icmpv4',
  size: 98,
  summary: 'echo request',
  ...over,
});

const frameTx = (over: Partial<Extract<TraceEvent, { kind: 'frameTx' }>> = {}): TraceEvent => ({
  t: 10,
  kind: 'frameTx',
  pdu: pdu({ layers: ['ethernet', 'ipv4', 'icmpv4', 'payload'] }),
  link: 'l_1',
  from: { device: 'd_1', port: 'Gi0' },
  to: { device: 'd_2', port: 'Fa0/1' },
  txStart: 10,
  txEnd: 20,
  arrive: 25,
  ...over,
});

const offer: TraceEvent = frameTx({
  pdu: pdu({ id: 9, proto: 'dhcp', tag: 'dhcp-offer', layers: ['ethernet', 'ipv4', 'udp', 'dhcp'] }),
});
const keepalive: TraceEvent = frameTx({
  pdu: pdu({ id: 3, proto: 'hdlc', tag: 'keepalive', layers: ['hdlc', 'payload'] }),
  link: 'l_7',
  background: true,
});
const frameRx: TraceEvent = { t: 25, kind: 'frameRx', pdu: pdu(), device: 'd_2', port: 'Fa0/1' };
const dropWire: TraceEvent = { t: 30, kind: 'drop', pdu: pdu(), link: 'l_1', reason: 'link-loss' };
const dropPort: TraceEvent = { t: 31, kind: 'drop', pdu: pdu(), device: 'd_3', port: 'Gi0/0', reason: 'not-for-me' };
const dropAir: TraceEvent = {
  t: 32, kind: 'drop', pdu: pdu(), device: 'd_4', reason: 'not-associated', medium: 'air:d_5/Wl0', association: 'a_1',
};
const tableWrite: TraceEvent = { t: 40, kind: 'tableWrite', device: 'd_2', table: 'cam', key: 'aa', row: { port: 'Fa0/1' } };
const tableExpire: TraceEvent = { t: 41, kind: 'tableExpire', device: 'd_1', table: 'arp', key: '10.0.0.2', row: {}, reason: 'aged' };
const debug: TraceEvent = {
  t: 50, kind: 'debug', event: { at: 50, device: 'd_6', process: 'arp', category: 'arp', message: 'rcvd' },
};
const mutation: TraceEvent = {
  t: 60, kind: 'mutation', pdu: 1,
  mutation: { at: 60, device: 'd_2', reason: 'TtlDecrement', field: 'ipv4.ttl', before: 64, after: 63 },
};
const linkState: TraceEvent = { t: 70, kind: 'linkState', link: 'l_1', up: false };
const cliOutput: TraceEvent = { t: 71, kind: 'cliOutput', session: 's_1', text: 'hello' };
const portState: TraceEvent = { t: 72, kind: 'portState', device: 'd_2', port: 'Fa0/2', adminUp: true, operUp: true };
const collision: TraceEvent = {
  t: 80, kind: 'collision', segment: 'seg:l_2',
  stations: [{ device: 'd_7', port: 'Gi0' }, { device: 'd_8', port: 'Gi0' }], pdus: [4, 5],
  detectAt: 80, jamUntil: 90, late: false,
};
const assoc: TraceEvent = {
  t: 90, kind: 'assocState', tech: 'wifi', medium: 'air:d_5/Wl0',
  station: { device: 'd_4', port: 'Wl0' }, ap: { device: 'd_5', port: 'Wl0' }, state: 'associated', prev: 'handshake',
};
const topoModule: TraceEvent = { t: 95, kind: 'topologyChanged', what: 'module', id: 'd_9/0', op: 'add' };
const topoDevice: TraceEvent = { t: 96, kind: 'topologyChanged', what: 'device', id: 'd_10', op: 'add' };
const topoLink: TraceEvent = { t: 97, kind: 'topologyChanged', what: 'link', id: 'l_11', op: 'remove' };
const backoff: TraceEvent = { t: 98, kind: 'backoff', device: 'd_7', port: 'Gi0', pdu: 4, attempt: 1, slots: 1, until: 200 };

const ALL: TraceEvent[] = [
  frameTx(), offer, keepalive, frameRx, dropWire, dropPort, dropAir, tableWrite, tableExpire, debug, mutation,
  linkState, cliOutput, portState, collision, assoc, topoModule, topoDevice, topoLink, backoff,
];

const matching = (f: TraceFilter): TraceEvent[] => ALL.filter((ev) => matchesTraceFilter(f, ev));

describe('trace/filter matchesTraceFilter', () => {
  it('an empty filter matches everything except background frames', () => {
    expect(matching({})).toEqual(ALL.filter((e) => e !== keepalive));
    expect(matching({ includeBackground: true })).toEqual(ALL);
  });

  it('background frames are excluded whatever else matches, unless includeBackground is true', () => {
    expect(matchesTraceFilter({ kinds: ['frameTx'], links: ['l_7'] }, keepalive)).toBe(false);
    expect(matchesTraceFilter({ kinds: ['frameTx'], includeBackground: false }, keepalive)).toBe(false);
    expect(matchesTraceFilter({ kinds: ['frameTx'], includeBackground: true }, keepalive)).toBe(true);
    expect(matchesTraceFilter({ kinds: ['frameTx'] }, frameTx({ background: false }))).toBe(true);
  });

  it('kinds matches event.kind (OR over members)', () => {
    expect(matching({ kinds: ['frameRx', 'linkState'] })).toEqual([frameRx, linkState]);
    expect(matching({ kinds: [] })).toEqual([]);
  });

  it('protos matches any layer of the stack, and falls back to proto without layers', () => {
    expect(matching({ protos: ['udp'] })).toEqual([offer]);
    expect(matching({ protos: ['ethernet'] })).toEqual([frameTx(), offer]);
    // frameRx/drops carry summaries without `layers`: only their `proto` counts.
    expect(matching({ protos: ['icmpv4'] })).toEqual([frameTx(), frameRx, dropWire, dropPort, dropAir]);
    expect(matchesTraceFilter({ protos: ['ipv4'] }, frameRx)).toBe(false);
    expect(matchesTraceFilter({ protos: ['icmpv4'] }, frameTx({ pdu: pdu({ layers: ['ethernet', 'arp'] }) }))).toBe(false);
  });

  it('events without a PduSummary never match protos or tags', () => {
    for (const ev of [tableWrite, debug, mutation, linkState, cliOutput, collision, backoff]) {
      expect(matchesTraceFilter({ protos: ['icmpv4', 'ethernet'] }, ev)).toBe(false);
      expect(matchesTraceFilter({ tags: ['keepalive'] }, ev)).toBe(false);
    }
  });

  it('tags match PduSummary.tag exactly', () => {
    expect(matching({ tags: ['dhcp-offer'] })).toEqual([offer]);
    expect(matching({ tags: ['dhcp'] })).toEqual([]);
    expect(matching({ tags: ['keepalive'], includeBackground: true })).toEqual([keepalive]);
  });

  it('the DHCP OFFER breakpoint of §4.11 matches only the offer frame', () => {
    const breakOn: TraceFilter = { kinds: ['frameTx'], protos: ['dhcp'], tags: ['dhcp-offer'] };
    expect(matching(breakOn)).toEqual([offer]);
    const rxOffer: TraceEvent = { t: 26, kind: 'frameRx', pdu: (offer as { pdu: PduSummary }).pdu, device: 'd_2', port: 'Fa0/1' };
    expect(matchesTraceFilter(breakOn, rxOffer)).toBe(false);
  });

  it('devices match device fields, the debug payload, port refs and topology subjects', () => {
    // keepalive also reaches d_2 but is background
    expect(matching({ devices: ['d_2'] })).toEqual([frameTx(), offer, frameRx, tableWrite, mutation, portState]);
    expect(matching({ devices: ['d_6'] })).toEqual([debug]);
    expect(matching({ devices: ['d_8'] })).toEqual([collision]);
    expect(matching({ devices: ['d_5'] })).toEqual([assoc]);
    expect(matching({ devices: ['d_4'] })).toEqual([dropAir, assoc]);
    expect(matching({ devices: ['d_9'] })).toEqual([topoModule]);
    expect(matching({ devices: ['d_1'] })).toEqual([frameTx(), offer, tableExpire]);
    expect(matching({ devices: ['d_10'] })).toEqual([topoDevice]);
    // a device id that is only a prefix of a module's device id does not match
    expect(matchesTraceFilter({ devices: ['d_'] }, topoModule)).toBe(false);
    expect(matching({ devices: ['d_1', 'd_6'] })).toEqual([frameTx(), offer, tableExpire, debug]);
  });

  it('links match link and medium ids', () => {
    expect(matching({ links: ['l_1'] })).toEqual([frameTx(), offer, dropWire, linkState]);
    expect(matching({ links: ['air:d_5/Wl0'] })).toEqual([dropAir, assoc]);
    expect(matching({ links: ['seg:l_2'] })).toEqual([collision]);
    expect(matching({ links: ['l_11'] })).toEqual([topoLink]);
    expect(matching({ links: ['l_7'], includeBackground: true })).toEqual([keepalive]);
  });

  it('ports match (device, port) pairs from refs and device+port fields', () => {
    expect(matching({ ports: [{ device: 'd_2', port: 'Fa0/1' }] })).toEqual([frameTx(), offer, frameRx]);
    expect(matching({ ports: [{ device: 'd_3', port: 'Gi0/0' }] })).toEqual([dropPort]);
    expect(matching({ ports: [{ device: 'd_7', port: 'Gi0' }] })).toEqual([collision, backoff]);
    expect(matching({ ports: [{ device: 'd_5', port: 'Wl0' }] })).toEqual([assoc]);
    expect(matching({ ports: [{ device: 'd_2', port: 'Fa0/2' }] })).toEqual([portState]);
    // a drop with only a device has no port ref
    expect(matching({ ports: [{ device: 'd_4', port: 'Wl0' }] })).toEqual([assoc]);
    // device and port must match on the same ref
    expect(matching({ ports: [{ device: 'd_1', port: 'Fa0/1' }] })).toEqual([]);
  });

  it('tables match tableWrite and tableExpire only', () => {
    expect(matching({ tables: ['cam', 'arp'] })).toEqual([tableWrite, tableExpire]);
    expect(matching({ tables: ['rib'] })).toEqual([]);
  });

  it('present keys AND together', () => {
    expect(matching({ kinds: ['frameTx'], devices: ['d_1'] })).toEqual([frameTx(), offer]);
    expect(matching({ kinds: ['frameTx'], devices: ['d_1'], protos: ['udp'] })).toEqual([offer]);
    expect(matching({ kinds: ['tableWrite'], tables: ['arp'] })).toEqual([]);
    expect(matching({ kinds: ['drop'], links: ['l_1'], devices: ['d_3'] })).toEqual([]);
  });

  it('the default sim-mode list filter keeps frames, drops and table writes but not keepalives', () => {
    const list: TraceFilter = { kinds: ['frameTx', 'drop', 'tableWrite'], includeBackground: false };
    expect(matching(list)).toEqual([frameTx(), offer, dropWire, dropPort, dropAir, tableWrite]);
  });

  it('gives the same answers for a structured clone of the filter and never mutates its inputs', () => {
    const f: TraceFilter = { kinds: ['frameTx', 'drop'], devices: ['d_1', 'd_3'], ports: [{ device: 'd_3', port: 'Gi0/0' }, { device: 'd_1', port: 'Gi0' }] };
    const frozenInputs = JSON.stringify({ f, ALL });
    const clone = structuredClone(f);
    expect(ALL.map((e) => matchesTraceFilter(clone, e))).toEqual(ALL.map((e) => matchesTraceFilter(f, e)));
    expect(matching(f)).toEqual([frameTx(), offer, dropPort]);
    expect(JSON.stringify({ f, ALL })).toBe(frozenInputs);
  });
});
