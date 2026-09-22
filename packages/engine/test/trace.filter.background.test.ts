/**
 * W2 device (ARCHITECTURE-P2 §2.7): a `drop` event of a background PDU carries `background: true`, and the trace filter
 * skips such a drop unless `includeBackground` is true — exactly as it already skips a background `frameTx`. The
 * device runtime sets the key from `PduMeta.background` on every drop it emits (a pipeline drop and a daemon's
 * `drop` action alike) and never on a drop of ordinary traffic, so P1 drop events keep their bytes.
 */
import { describe, expect, it } from 'vitest';
import { L3_ROLES } from '../src/contracts/catalog.js';
import { ETHERTYPE_IPV4, type LayerSpec } from '../src/contracts/pdu.js';
import type { PortState } from '../src/contracts/port.js';
import type { DebugEvent, Process, StateView } from '../src/contracts/process.js';
import type { TraceFilter } from '../src/contracts/simulation.js';
import type { PduSummary, TraceEvent } from '../src/contracts/trace.js';
import { NF_PC } from '../src/device/catalog.js';
import { matchesTraceFilter } from '../src/trace/filter.js';
import { p2Harness } from './device.p2.harness.js';

const pdu = (over: Partial<PduSummary> = {}): PduSummary => ({ id: 1, proto: 'stp', size: 60, summary: 'configuration BPDU', tag: 'bpdu', ...over });

const backgroundDrop: TraceEvent = { t: 10, kind: 'drop', pdu: pdu(), device: 'd_1', port: 'GigabitEthernet0', reason: 'not-for-me', detail: 'link-layer control frame', background: true };
const plainDrop: TraceEvent = { t: 11, kind: 'drop', pdu: pdu({ id: 2, proto: 'icmpv4', tag: undefined, summary: 'echo request' }), device: 'd_1', port: 'GigabitEthernet0', reason: 'not-for-me' };
const wireDrop: TraceEvent = { t: 12, kind: 'drop', pdu: pdu({ id: 3, proto: 'hdlc', tag: 'keepalive' }), link: 'l_7', reason: 'link-loss', background: true };
const backgroundTx: TraceEvent = {
  t: 13, kind: 'frameTx', pdu: pdu({ id: 4, proto: 'hdlc', tag: 'keepalive' }), link: 'l_7', from: { device: 'd_1', port: 'Serial0/0/0' }, to: { device: 'd_2', port: 'Serial0/0/0' },
  txStart: 13, txEnd: 14, arrive: 15, background: true,
};
const ALL = [backgroundDrop, plainDrop, wireDrop, backgroundTx];
const matching = (f: TraceFilter): TraceEvent[] => ALL.filter((ev) => matchesTraceFilter(f, ev));

describe('matchesTraceFilter: background drops (§2.7)', () => {
  it('never matches a background drop unless background traffic is included, whatever the other keys say', () => {
    expect(matching({})).toEqual([plainDrop]);
    expect(matching({ kinds: ['drop'] })).toEqual([plainDrop]);
    expect(matching({ devices: ['d_1'] })).toEqual([plainDrop]);
    expect(matching({ ports: [{ device: 'd_1', port: 'GigabitEthernet0' }] })).toEqual([plainDrop]);
    expect(matching({ links: ['l_7'] })).toEqual([]);
    expect(matching({ tags: ['bpdu', 'keepalive'] })).toEqual([]);
    expect(matching({ protos: ['stp', 'hdlc'] })).toEqual([]);
  });

  it('matches them like any other event once includeBackground is true', () => {
    expect(matching({ includeBackground: true })).toEqual(ALL);
    expect(matching({ includeBackground: true, kinds: ['drop'] })).toEqual([backgroundDrop, plainDrop, wireDrop]);
    expect(matching({ includeBackground: true, tags: ['bpdu'] })).toEqual([backgroundDrop]);
    expect(matching({ includeBackground: true, links: ['l_7'] })).toEqual([wireDrop, backgroundTx]);
    // `false` is the default, not an inclusion
    expect(matching({ includeBackground: false, kinds: ['drop'] })).toEqual([plainDrop]);
  });
});

describe('the device runtime marks a dropped background PDU', () => {
  const PEER = '02:00:00:00:00:99';
  const OTHER = '02:00:00:00:00:77';
  const layers = (dst: string): LayerSpec[] => [
    { proto: 'ethernet', fields: { dst, src: PEER, type: ETHERTYPE_IPV4 } },
    { proto: 'ipv4', fields: { src: '10.0.0.2', dst: '10.0.0.1', protocol: 17, ttl: 1 } },
    { proto: 'payload', fields: { data: new Uint8Array(20).fill(1) } },
  ];

  function pc() {
    const ipv4: Process = {
      name: 'ipv4',
      handles: [{ layer: 'ethernet', ethertype: ETHERTYPE_IPV4, roles: L3_ROLES }],
      init: () => [],
      onPdu: (_ctx, pdu, port) => [{ type: 'drop', pdu, reason: 'no-route', detail: 'nowhere to send', port }],
      onTimer: () => [],
      onConfig: () => [],
      stateSnapshot: (): StateView => ({ process: 'ipv4', state: {} }),
      debugEvents: (): readonly DebugEvent[] => [],
    };
    const h = p2Harness({ model: { ...NF_PC, processes: ['ipv4'] }, processes: { ipv4: () => ipv4 }, name: 'PC1' });
    h.run();
    const port = h.device.port('GigabitEthernet0') as PortState;
    port.operUp = true;
    h.events.length = 0;
    return { h, port, at: (h.device.bootedAt as number) + 1 };
  }

  it('a pipeline drop and a daemon drop of a background PDU carry background: true; ordinary drops do not', () => {
    const { h, port, at } = pc();
    const hello = h.pdus.build(layers(OTHER), { born: 0, origin: 'd_peer', tag: 'hsrp-hello', background: true });
    h.device.onFrameArrival('GigabitEthernet0', hello, false, at);
    const routed = h.pdus.build(layers(port.mac), { born: 0, origin: 'd_peer', tag: 'keepalive', background: true });
    h.device.onFrameArrival('GigabitEthernet0', routed, false, at + 1);
    const plain = h.pdus.build(layers(OTHER), { born: 0, origin: 'd_peer' });
    h.device.onFrameArrival('GigabitEthernet0', plain, false, at + 2);

    expect(h.kinds('drop')).toEqual([
      { t: at, kind: 'drop', pdu: expect.objectContaining({ id: hello.id, tag: 'hsrp-hello' }), device: 'd_1', reason: 'not-for-me', port: 'GigabitEthernet0', detail: OTHER, background: true },
      { t: at + 1, kind: 'drop', pdu: expect.objectContaining({ id: routed.id, tag: 'keepalive' }), device: 'd_1', reason: 'no-route', port: 'GigabitEthernet0', detail: 'nowhere to send', background: true },
      { t: at + 2, kind: 'drop', pdu: expect.objectContaining({ id: plain.id }), device: 'd_1', reason: 'not-for-me', port: 'GigabitEthernet0', detail: OTHER },
    ]);
    expect(Object.keys(h.kinds('drop')[2] as object)).not.toContain('background');
    // the filter hides the two background drops by default
    const drops = h.kinds('drop');
    expect(drops.filter((e) => matchesTraceFilter({ kinds: ['drop'] }, e)).map((e) => e.pdu.id)).toEqual([plain.id]);
    expect(drops.filter((e) => matchesTraceFilter({ kinds: ['drop'], includeBackground: true }, e)).map((e) => e.pdu.id)).toEqual([hello.id, routed.id, plain.id]);
  });
});
