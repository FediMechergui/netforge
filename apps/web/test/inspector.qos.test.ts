// QoS in the inspectors (ARCHITECTURE-P3 §5.9 "Port inspector", §6 "Packet inspector … `QosMark` … provenance chips",
// "[S20] … the 'waited 41 ms in VOICE (priority)' chip from `frameQueued` → `frameTx`"; §7 W3 web-inspector, M13, D16):
// - the port inspector's QoS line: the input and output policies and, per class, matched and marked (and [S21] the
//   policer's conform and exceed counts) from `PortSnapshot.qos`, split by direction; "no service policy" otherwise;
// - the packet inspector's marking chips (each `QosMark` record; [C13] `Encrypt` / `Decrypt`) and wait chips.
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createPduFactory } from '@netforge/engine';
import type { EgressQueueView, Mutation, PduJson, PduSummary, PortQosView, TraceEvent } from '@netforge/engine';

vi.mock('../src/bridge/client', () => ({ engine: {}, fmtSimTime: (t: number) => `${t / 1_000_000_000} s` }));
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = {
    catalog: [], snapshot: null, snapshotIndex: undefined, epoch: 0, events: [], selection: null, now: 0, playing: false,
    timeline: { review: null, head: null, lanes: [], seeking: false, reviewEvents: [] },
  };
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

import { store } from '../src/store/store';
import {
  MARKING_GLYPH,
  PacketInspector,
  fmtWait,
  markingChipsOf,
  markingValueText,
  queueWaitText,
  queueWaitsOf,
} from '../src/inspector/PacketInspector';
import { PortInspector, qosClassText, qosSummaryText, splitQosClasses } from '../src/inspector/PortInspector';
import { device, port, snapshot } from './canvas-fixtures';

const MS = 1_000_000;

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

const POLICIES = [
  'class-map match-all VOICE',
  ' match dscp ef',
  'policy-map MARK',
  ' class VOICE',
  '  set dscp ef',
  'policy-map WAN-EDGE',
  ' class VOICE',
  '  priority 32',
  ' class class-default',
  '  fair-queue',
  'interface GigabitEthernet0/0',
  ' service-policy input MARK',
  'interface Serial0/0/0',
  ' service-policy output WAN-EDGE',
].join('\n');

const BOTH: PortQosView = {
  input: 'MARK',
  output: 'WAN-EDGE',
  classes: [
    { name: 'VOICE', matched: 120, matchedBytes: 14_400, marked: 120 },
    { name: 'class-default', matched: 30, matchedBytes: 30_000, marked: 0, police: { conform: 25, conformBytes: 25_000, exceed: 5, exceedBytes: 5_000 } },
    { name: 'VOICE', matched: 118, matchedBytes: 14_160, marked: 0 },
    { name: 'class-default', matched: 29, matchedBytes: 29_000, marked: 0 },
  ],
};

describe('the port inspector QoS line (M13)', () => {
  it('splits the classes by direction at the input policy class-default', () => {
    const lines = splitQosClasses(BOTH, POLICIES);
    expect(lines.map((l) => [l.dir, l.policy, l.classes.map((c) => c.matched)])).toEqual([
      ['input', 'MARK', [120, 30]],
      ['output', 'WAN-EDGE', [118, 29]],
    ]);
  });

  it('gives a missing input policy-map no classes, so every class is the output policy', () => {
    const q: PortQosView = { input: 'NOPE', output: 'WAN-EDGE', classes: BOTH.classes.slice(2) };
    expect(splitQosClasses(q, POLICIES).map((l) => [l.dir, l.classes.length])).toEqual([
      ['input', 0],
      ['output', 2],
    ]);
    const outOnly: PortQosView = { output: 'WAN-EDGE', classes: BOTH.classes.slice(2) };
    expect(splitQosClasses(outOnly, POLICIES).map((l) => [l.dir, l.classes.length])).toEqual([['output', 2]]);
  });

  it('words: the summary, a class and a policed class', () => {
    expect(qosSummaryText(undefined)).toBe('no service policy');
    expect(qosSummaryText(BOTH)).toBe('input MARK · output WAN-EDGE');
    expect(qosSummaryText({ output: 'WAN-EDGE', classes: [] })).toBe('output WAN-EDGE');
    expect(qosClassText(BOTH.classes[0]!)).toBe('VOICE 120 matched (14400 bytes), 120 marked');
    expect(qosClassText(BOTH.classes[1]!)).toBe('class-default 30 matched (30000 bytes), 0 marked; policed: 25 conform, 5 exceed');
  });

  function renderPort(qos: PortQosView | undefined, portId = 'GigabitEthernet0/0'): string {
    const p = port(portId, { role: 'routed', allowedRoles: ['routed'], ...(qos !== undefined ? { qos } : {}) });
    const r1 = device('r1', 0, 0, [p], { type: 'router.nf2911', model: 'NF-2911', capabilities: ['routing'], cli: { shell: 'nfos', grammar: 'nfos' }, runningConfig: POLICIES });
    store.setState({ snapshot: snapshot([r1]), snapshotIndex: undefined, events: [] });
    return text(renderToStaticMarkup(createElement(PortInspector, { port: { device: 'r1', port: portId } })));
  }

  it('a port without a policy says so (the QoS line is always there on a data port)', () => {
    const t = renderPort(undefined);
    expect(t).toContain('QoS no service policy');
  });

  it('a port with policies lists each direction and its classes', () => {
    const t = renderPort(BOTH);
    expect(t).toContain('QoS input MARK · output WAN-EDGE');
    expect(t).toContain('input MARK: VOICE 120 matched (14400 bytes), 120 marked · class-default 30 matched (30000 bytes), 0 marked; policed: 25 conform, 5 exceed');
    expect(t).toContain('output WAN-EDGE: VOICE 118 matched (14160 bytes), 0 marked · class-default 29 matched (29000 bytes), 0 marked');
    // no held queues on this port: no Policy section
    expect(t).not.toContain('Packets held on this port');
  });

  it('a console port has no QoS line', () => {
    const p = port('Console0', { kind: 'console', role: 'console', allowedRoles: ['console'] });
    const r1 = device('r1', 0, 0, [p], { capabilities: ['routing'], cli: { shell: 'nfos', grammar: 'nfos' } });
    store.setState({ snapshot: snapshot([r1]), snapshotIndex: undefined, events: [] });
    const t = text(renderToStaticMarkup(createElement(PortInspector, { port: { device: 'r1', port: 'Console0' } })));
    expect(t).not.toContain('QoS');
  });
});

// ── the packet inspector's chips ────────────────────────────────────────────

const factory = createPduFactory();

function voicePacket(provenance: Mutation[]): PduJson {
  const json = factory
    .build(
      [
        { proto: 'ethernet', fields: { src: '02:00:00:00:01:00', dst: '02:00:00:00:02:00', type: 0x0800 } },
        { proto: 'ipv4', fields: { src: '192.168.1.10', dst: '10.2.0.10', protocol: 17, ttl: 63, dscp: 46 } },
        { proto: 'udp', fields: { srcPort: 40000, dstPort: 9 } },
      ],
      { born: 1_000 * MS, origin: 'pc1' },
    )
    .toJSON();
  return { ...json, provenance };
}

const MARK: Mutation = { at: 1_001 * MS, device: 'r1', reason: 'QosMark', field: 'ipv4.dscp', before: 0, after: 46, cause: 'policy-map MARK class VOICE set dscp ef' };

describe('marking chips (QosMark; [C13] Encrypt / Decrypt)', () => {
  it('reads the QosMark, Encrypt and Decrypt records only, oldest first', () => {
    const prov: Mutation[] = [
      { at: 1, device: 'r1', reason: 'TtlDecrement', field: 'ipv4.ttl', before: 64, after: 63 },
      MARK,
      { at: 3, device: 'r1', reason: 'QosMark', field: 'dot1q.pcp', before: 0, after: 5, cause: 'policy-map OUT class VOICE set cos 5' },
      { at: 4, device: 'r1', reason: 'Encrypt', field: 'esp.keyId', before: null, after: 7, cause: 'interface Tunnel0' },
      { at: 5, device: 'r2', reason: 'Decrypt', field: 'esp.keyId', before: 7, after: 7, cause: 'interface Tunnel0' },
    ];
    const chips = markingChipsOf(prov);
    expect(chips.map((c) => [c.reason, c.device, c.text, c.cause])).toEqual([
      ['QosMark', 'r1', 'DSCP 0 (default) → 46 (ef)', 'policy-map MARK class VOICE set dscp ef'],
      ['QosMark', 'r1', 'CoS 0 → 5', 'policy-map OUT class VOICE set cos 5'],
      ['Encrypt', 'r1', 'encrypted', 'interface Tunnel0'],
      ['Decrypt', 'r2', 'decrypted', 'interface Tunnel0'],
    ]);
    expect(MARKING_GLYPH).toEqual({ QosMark: 'Q', Encrypt: 'E', Decrypt: 'D' });
    expect(markingValueText('ipv4.dscp', 0)).toBe('0 (default)');
    expect(markingValueText('ipv4.dscp', 26)).toBe('26 (af31)');
    expect(markingValueText('ipv4.dscp', 5)).toBe('5');
    expect(markingValueText('dot1q.pcp', 5)).toBe('5');
  });

  it('renders a QosMark chip in the packet header with its device and cause', () => {
    const r1 = device('r1', 0, 0, [], { name: 'R1' });
    store.setState({ snapshot: snapshot([r1]), snapshotIndex: undefined, events: [] });
    const html = renderToStaticMarkup(createElement(PacketInspector, { pdu: voicePacket([MARK]) }));
    const t = text(html);
    expect(t).toContain('Q DSCP 0 (default) → 46 (ef) on R1');
    expect(html).toContain('title="DSCP 0 (default) → 46 (ef) — policy-map MARK class VOICE set dscp ef"');
    // the DSCP field of the layer card has its name too
    expect(t).toContain('dscp 46 (ef)');
  });

  it('a packet with no marking record shows no chip row', () => {
    store.setState({ snapshot: snapshot([]), snapshotIndex: undefined, events: [] });
    const html = renderToStaticMarkup(createElement(PacketInspector, { pdu: voicePacket([]) }));
    expect(html).not.toContain('aria-label="Marking and queueing"');
  });
});

// ── [S20] wait chips ────────────────────────────────────────────────────────

function summary(id: number): PduSummary {
  return { id, proto: 'udp', size: 60, summary: 'UDP 40000 → 9' };
}

function queued(t: number, id: number, queue: string, depth: number, dev = 'r1', p = 'Serial0/0/0'): TraceEvent {
  return { t, kind: 'frameQueued', pdu: summary(id), device: dev, port: p, queue, depth };
}

function tx(t: number, id: number, dev = 'r1', p = 'Serial0/0/0'): TraceEvent {
  return {
    t,
    kind: 'frameTx',
    pdu: summary(id),
    link: 'l1',
    from: { device: dev, port: p },
    to: { device: 'r2', port: 'Serial0/0/0' },
    txStart: t,
    txEnd: t + 5 * MS,
    arrive: t + 5 * MS,
  };
}

const QUEUE: EgressQueueView = {
  policy: 'WAN-EDGE',
  strategy: 'class-based',
  refBps: 128_000,
  classes: [
    { name: 'VOICE', kind: 'priority', depth: 0, limit: 64, matched: 10, matchedBytes: 600, sent: 10, tailDrops: 0, policed: 0, offeredBps30s: 16_000 },
    { name: 'class-default', kind: 'default', depth: 3, limit: 64, matched: 40, matchedBytes: 40_000, sent: 37, tailDrops: 1, policed: 0, offeredBps30s: 120_000 },
  ],
};

describe('[S20] the wait chip: frameQueued → frameTx', () => {
  it('pairs each frameQueued of the PDU with its next frameTx from the same port', () => {
    const events: TraceEvent[] = [
      queued(1_000 * MS, 7, 'VOICE', 1),
      queued(1_000 * MS, 8, 'class-default', 4), // another PDU
      tx(1_041 * MS, 7),
      tx(1_100 * MS, 7, 'r2', 'GigabitEthernet0/0'), // a later hop, never queued there
      queued(1_200 * MS, 7, 'class-default', 2, 'r2', 'Serial0/0/1'), // a later queue, still waiting
    ];
    expect(queueWaitsOf(events, 7)).toEqual([
      { device: 'r1', port: 'Serial0/0/0', queue: 'VOICE', depth: 1, queuedAt: 1_000 * MS, sentAt: 1_041 * MS, waitNs: 41 * MS },
      { device: 'r2', port: 'Serial0/0/1', queue: 'class-default', depth: 2, queuedAt: 1_200 * MS },
    ]);
    expect(queueWaitsOf(events, 9)).toEqual([]);
  });

  it('says "waited 41 ms in VOICE (priority)"', () => {
    expect(queueWaitText({ queue: 'VOICE', waitNs: 41 * MS }, 'priority')).toBe('waited 41 ms in VOICE (priority)');
    expect(queueWaitText({ queue: 'DATA', waitNs: 3_500_000 }, 'bandwidth')).toBe('waited 3.5 ms in DATA (bandwidth)');
    expect(queueWaitText({ queue: 'class-default', waitNs: 63 * MS }, 'default')).toBe('waited 63 ms in class-default');
    expect(queueWaitText({ queue: 'VOICE' }, 'priority')).toBe('waiting in VOICE (priority)');
    expect(queueWaitText({ queue: 'VOICE', waitNs: 41 * MS })).toBe('waited 41 ms in VOICE');
    expect([fmtWait(0), fmtWait(200_000), fmtWait(41 * MS), fmtWait(1_250 * MS)]).toEqual(['0.0 ms', '0.2 ms', '41 ms', '1.25 s']);
  });

  it('renders the chip with the class kind read from the port queue view', () => {
    const se = port('Serial0/0/0', { short: 'Se0/0/0', kind: 'serial', role: 'routed', allowedRoles: ['routed'], qos: { output: 'WAN-EDGE', classes: [], queue: QUEUE } });
    const r1 = device('r1', 0, 0, [se], { name: 'R1' });
    const pdu = voicePacket([]);
    store.setState({ snapshot: snapshot([r1]), snapshotIndex: undefined, events: [queued(1_000 * MS, pdu.id, 'VOICE', 1), tx(1_041 * MS, pdu.id)] });
    const t = text(renderToStaticMarkup(createElement(PacketInspector, { pdu })));
    expect(t).toContain('waited 41 ms in VOICE (priority) at R1 Se0/0/0');
  });
});
