/**
 * P3c W0h [C32] (b) (ARCHITECTURE-P3C §2.8, §7 W0h "sim + web-shell"): `TraceFilter.vlans` in the one predicate
 * (trace/filter.ts `matchesTraceFilter`). The key is optional by meaning: absent, every filter keeps its P1/P2/P3
 * semantics; present, an event matches only when it carries a PduSummary whose `vlan` (the outermost 802.1Q VID, set
 * only on tagged frames, ARCHITECTURE-P2 §2.7) is listed. A present empty list matches nothing, like every array key.
 */
import { describe, expect, it } from 'vitest';
import type { TraceFilter } from '../src/contracts/simulation.js';
import type { PduSummary, TraceEvent } from '../src/contracts/trace.js';
import { matchesTraceFilter } from '../src/trace/filter.js';

const pdu = (over: Partial<PduSummary> = {}): PduSummary => ({
  id: 1,
  proto: 'icmpv4',
  size: 102,
  summary: 'echo request',
  layers: ['ethernet', 'dot1q', 'ipv4', 'icmpv4', 'payload'],
  ...over,
});

const tx = (vlan: number | undefined, over: Partial<Extract<TraceEvent, { kind: 'frameTx' }>> = {}): TraceEvent => ({
  t: 10,
  kind: 'frameTx',
  pdu: pdu(vlan === undefined ? { layers: ['ethernet', 'ipv4', 'icmpv4', 'payload'] } : { vlan }),
  link: 'l_1',
  from: { device: 'sw1', port: 'GigabitEthernet0/1' },
  to: { device: 'sw2', port: 'GigabitEthernet0/1' },
  txStart: 10,
  txEnd: 20,
  arrive: 25,
  ...over,
});

const rx10: TraceEvent = { t: 25, kind: 'frameRx', pdu: pdu({ vlan: 10 }), device: 'sw2', port: 'GigabitEthernet0/1' };
const drop20: TraceEvent = { t: 30, kind: 'drop', pdu: pdu({ vlan: 20 }), device: 'sw2', port: 'GigabitEthernet0/1', reason: 'vlan-filtered' };
const created10: TraceEvent = { t: 5, kind: 'pduCreated', pdu: pdu({ vlan: 10 }), device: 'sw1', process: 'eth-switch' };
const consumed10: TraceEvent = { t: 6, kind: 'pduConsumed', pdu: pdu({ vlan: 10 }), device: 'sw2', process: 'eth-switch' };
const abort10: TraceEvent = {
  t: 7, kind: 'frameAbort', pdu: pdu({ vlan: 10 }), link: 'l_1', from: { device: 'sw1', port: 'Gi0/1' }, to: { device: 'sw2', port: 'Gi0/1' },
  abortAt: 7, arrive: 9, reason: 'link-down',
} as TraceEvent;
const tableWrite: TraceEvent = {
  t: 40, kind: 'tableWrite', device: 'sw1', table: 'cam', key: '10|0000.0000.0001', row: { key: '10|0000.0000.0001', updatedAt: 40 },
} as TraceEvent;
const debug: TraceEvent = { t: 41, kind: 'debug', event: { device: 'sw1', process: 'vlan', category: 'vlan', message: 'vlan 10 created' } } as TraceEvent;

describe('TraceFilter.vlans [C32] (b)', () => {
  it('selects a summary-carrying event exactly when its PduSummary.vlan is listed', () => {
    const f: TraceFilter = { vlans: [10] };
    expect(matchesTraceFilter(f, tx(10))).toBe(true);
    expect(matchesTraceFilter(f, rx10)).toBe(true);
    expect(matchesTraceFilter(f, created10)).toBe(true);
    expect(matchesTraceFilter(f, consumed10)).toBe(true);
    expect(matchesTraceFilter(f, abort10)).toBe(true);
    expect(matchesTraceFilter(f, tx(20))).toBe(false);
    expect(matchesTraceFilter(f, drop20)).toBe(false);
  });

  it('ORs the listed VLANs', () => {
    const f: TraceFilter = { vlans: [20, 10] };
    expect(matchesTraceFilter(f, tx(10))).toBe(true);
    expect(matchesTraceFilter(f, tx(20))).toBe(true);
    expect(matchesTraceFilter(f, drop20)).toBe(true);
    expect(matchesTraceFilter(f, tx(30))).toBe(false);
  });

  it('never matches an untagged frame, or an event without a PDU, while the key is set', () => {
    const f: TraceFilter = { vlans: [1, 10, 20] };
    expect(matchesTraceFilter(f, tx(undefined))).toBe(false);
    expect(matchesTraceFilter(f, tableWrite)).toBe(false);
    expect(matchesTraceFilter(f, debug)).toBe(false);
  });

  it('a present empty list matches nothing; an absent key changes nothing', () => {
    expect(matchesTraceFilter({ vlans: [] }, tx(10))).toBe(false);
    for (const ev of [tx(10), tx(undefined), rx10, drop20, tableWrite, debug]) {
      expect(matchesTraceFilter({}, ev)).toBe(true);
      expect(matchesTraceFilter({ kinds: [ev.kind] }, ev)).toBe(true);
    }
  });

  it('ANDs with the other keys and keeps the background rule', () => {
    expect(matchesTraceFilter({ vlans: [10], kinds: ['frameTx'] }, tx(10))).toBe(true);
    expect(matchesTraceFilter({ vlans: [10], kinds: ['frameRx'] }, tx(10))).toBe(false);
    expect(matchesTraceFilter({ vlans: [10], protos: ['icmpv4'] }, tx(10))).toBe(true);
    expect(matchesTraceFilter({ vlans: [10], protos: ['arp'] }, tx(10))).toBe(false);
    expect(matchesTraceFilter({ vlans: [10], devices: ['sw2'] }, rx10)).toBe(true);
    expect(matchesTraceFilter({ vlans: [10], devices: ['sw9'] }, rx10)).toBe(false);
    const bg = tx(10, { background: true });
    expect(matchesTraceFilter({ vlans: [10] }, bg)).toBe(false);
    expect(matchesTraceFilter({ vlans: [10], includeBackground: true }, bg)).toBe(true);
  });

  it('survives a structured clone (the worker boundary) with the same answers', () => {
    const f: TraceFilter = structuredClone({ vlans: [10], kinds: ['frameTx', 'frameRx'] } satisfies TraceFilter);
    expect([tx(10), rx10, tx(20), drop20].map((ev) => matchesTraceFilter(f, ev))).toEqual([true, true, false, false]);
  });
});
