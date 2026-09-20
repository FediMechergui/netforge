import { describe, expect, it } from 'vitest';
import type { PortRef } from '../src/contracts/ids.js';
import { portKey } from '../src/contracts/ids.js';
import { MEDIA } from '../src/contracts/link.js';
import type { MediaSnapshot } from '../src/contracts/medium.js';
import { CSMA } from '../src/contracts/medium.js';
import { propagationNs, serializationNs } from '../src/contracts/time.js';
import { corruptionWindow, summarizePdu } from '../src/link/media/p2p.js';
import type { SegmentCableInput } from '../src/link/media/segment.js';
import {
  MAX_REPEATER_HOPS,
  backoffMaxSlots,
  buildSegmentGraph,
  cableJoinsSegment,
  formSegments,
  fragmentBytesFor,
  segmentTiming,
  wireNs,
} from '../src/link/media/segment.js';
import { hubOfThree, segmentHarness } from './link.segment.harness.js';

const M10 = CSMA.REPEATER_BPS;
const ref = (device: string, port: string): PortRef => ({ device, port });
const emptyMedia = (): MediaSnapshot => ({ metresPerUnit: 0.25, segments: [], bss: [], cells: [], associations: [] });

// ── pure helpers ─────────────────────────────────────────────────────────────

describe('segment timing helpers', () => {
  it('derives byte, IFG, slot and jam times from the rate', () => {
    expect(segmentTiming(M10)).toEqual({ bps: M10, byteNs: 800, ifgNs: 9_600, slotNs: 51_200, jamNs: 3_200, repeaterNs: 800 });
    expect(segmentTiming(100_000_000).slotNs).toBe(serializationNs(64, 100_000_000));
    expect(wireNs(64, M10)).toBe(serializationNs(72, M10));
  });

  it('counts fragment bytes after the preamble and caps backoff at 2^10 − 1', () => {
    expect(fragmentBytesFor(0, 0, M10)).toBe(0);
    expect(fragmentBytesFor(0, 6_399, M10)).toBe(0);
    expect(fragmentBytesFor(100, 100 + 8_000, M10)).toBe(2);
    expect(fragmentBytesFor(0, 57_600, M10)).toBe(64);
    expect([0, 1, 2, 3, 10, 11, 16].map(backoffMaxSlots)).toEqual([0, 1, 3, 7, 1023, 1023, 1023]);
  });
});

describe('segment domain formation', () => {
  const c = (id: string, a: PortRef, b: PortRef, over: Partial<SegmentCableInput> = {}): SegmentCableInput => ({
    id, a, b, up: true, roleA: 'routed', roleB: 'repeater', bps: M10, ...over,
  });
  const order = ['d_hub', 'd_pc1', 'd_pc2', 'd_pc3', 'd_hub2', 'd_r1', 'd_r2'];
  const base = {
    repeaterPorts: (d: string) => (d.startsWith('d_hub') ? ['P0', 'P1', 'P2', 'P3'] : []),
    deviceOrder: (d: string) => order.indexOf(d),
    portOrder: (r: PortRef) => Number(r.port.slice(1)) || 0,
  };

  it('joins cables with a repeater end, a half-duplex end or a mismatch, and only when up', () => {
    expect(cableJoinsSegment(c('l_1', ref('d_pc1', 'Gi0'), ref('d_hub', 'P0')))).toBe(true);
    expect(cableJoinsSegment(c('l_1', ref('d_pc1', 'Gi0'), ref('d_hub', 'P0'), { up: false }))).toBe(false);
    const p2p = { roleA: 'routed', roleB: 'routed' } as const;
    expect(cableJoinsSegment(c('l_2', ref('d_r1', 'Gi0'), ref('d_r2', 'Gi0'), { ...p2p, duplexA: 'full', duplexB: 'full' }))).toBe(false);
    expect(cableJoinsSegment(c('l_2', ref('d_r1', 'Gi0'), ref('d_r2', 'Gi0'), { ...p2p, duplexA: 'half', duplexB: 'half' }))).toBe(true);
    expect(cableJoinsSegment(c('l_2', ref('d_r1', 'Gi0'), ref('d_r2', 'Gi0'), { ...p2p, mismatch: true }))).toBe(true);
  });

  it('forms one domain per component: id from the smallest link, stations then all repeater ports in creation order', () => {
    const doms = formSegments({
      ...base,
      cables: [
        c('l_9', ref('d_pc3', 'Gi0'), ref('d_hub', 'P2')),
        c('l_10', ref('d_pc1', 'Gi0'), ref('d_hub', 'P0')),
        c('l_2', ref('d_pc2', 'Gi0'), ref('d_hub', 'P1')),
        c('l_7', ref('d_r1', 'Gi0'), ref('d_r2', 'Gi0'), { roleB: 'routed', duplexA: 'full', duplexB: 'full', bps: 1_000_000_000 }),
      ],
    });
    expect(doms).toHaveLength(1);
    const d = doms[0]!;
    expect(d.id).toBe('seg:l_10');
    expect(d.links).toEqual(['l_9', 'l_10', 'l_2']);
    expect(d.stations).toEqual([ref('d_pc1', 'Gi0'), ref('d_pc2', 'Gi0'), ref('d_pc3', 'Gi0')]);
    expect(d.repeaters).toEqual(['P0', 'P1', 'P2', 'P3'].map((p) => ref('d_hub', p)));
    expect(d.stationLinks.get('d_pc2/Gi0')).toBe('l_2');
    expect(d.bps).toBe(M10);
  });

  it('merges hubs joined by a cable, keeps separate hubs apart (ordered by id) and forms half-duplex pairs', () => {
    const hubs = [
      c('l_1', ref('d_pc1', 'Gi0'), ref('d_hub', 'P0')),
      c('l_3', ref('d_pc2', 'Gi0'), ref('d_hub2', 'P0')),
    ];
    const apart = formSegments({ ...base, cables: hubs });
    expect(apart.map((d) => d.id)).toEqual(['seg:l_1', 'seg:l_3']);
    const joined = formSegments({ ...base, cables: [...hubs, c('l_0', ref('d_hub', 'P3'), ref('d_hub2', 'P3'), { roleA: 'repeater' })] });
    expect(joined).toHaveLength(1);
    expect(joined[0]!.id).toBe('seg:l_0');
    expect(joined[0]!.repeaters.map(portKey)).toEqual([
      'd_hub/P0', 'd_hub/P1', 'd_hub/P2', 'd_hub/P3', 'd_hub2/P0', 'd_hub2/P1', 'd_hub2/P2', 'd_hub2/P3',
    ]);
    const pair = formSegments({
      ...base,
      cables: [c('l_5', ref('d_r1', 'Gi0'), ref('d_r2', 'Gi0'), { roleB: 'routed', duplexA: 'half', duplexB: 'half', bps: 100_000_000 })],
    });
    expect(pair).toEqual([
      expect.objectContaining({ id: 'seg:l_5', repeaters: [], stations: [ref('d_r1', 'Gi0'), ref('d_r2', 'Gi0')], bps: 100_000_000 }),
    ]);
    expect(formSegments({ ...base, cables: [c('l_1', ref('d_pc1', 'Gi0'), ref('d_hub', 'P0'), { up: false })] })).toEqual([]);
  });

  it('distances sum cable propagation and one byte time per repeater crossing', () => {
    const cables = [
      c('l_1', ref('d_pc1', 'Gi0'), ref('d_hub', 'P0')),
      c('l_3', ref('d_pc3', 'Gi0'), ref('d_hub', 'P2')),
    ];
    const [dom] = formSegments({ ...base, cables });
    const p1 = propagationNs(2, 0.66);
    const p3 = propagationNs(50, 0.66);
    const g = buildSegmentGraph(dom!, [
      { id: 'l_1', a: cables[0]!.a, b: cables[0]!.b, ns: p1 },
      { id: 'l_3', a: cables[1]!.a, b: cables[1]!.b, ns: p3 },
    ]);
    const reach = g.bfs('d_pc1/Gi0').reach.get('d_pc3/Gi0')!;
    expect(reach).toMatchObject({ ns: p1 + 800 + p3, hops: 1, path: ['l_1', 'l_3'], link: 'l_3', via: 'd_hub/P2' });
    expect(g.distance('d_pc3/Gi0', 'd_pc1/Gi0')).toBe(p1 + 800 + p3);
    expect(g.distance('d_pc1/Gi0', 'd_hub/P3')).toBe(p1 + 800);
    expect(g.spanNs).toBe(p1 + p3 + 800);
    expect(g.maxStationHops(dom!.stations)).toBe(1);
    expect(g.has('d_nope/Gi0')).toBe(false);
  });
});

// ── strategy ─────────────────────────────────────────────────────────────────

describe('shared segment transmit and fan-out', () => {
  it('queues the frame, reports deferred, and repeats it to every other station on each BFS tree cable', () => {
    const h = hubOfThree();
    const pdu = h.frame(h.pc1);
    h.events.length = 0;
    const r = h.seg.transmit(h.pc1, pdu, 0);
    expect(r).toEqual({ ok: true, link: 'seg:l_1', txStart: 0, txEnd: 0, arrive: 0, deferred: true });

    const prop = propagationNs(1, MEDIA['copper-straight'].velocityFactor);
    const a1 = wireNs(pdu.size, M10);
    const txs = h.ofKind('frameTx');
    expect(txs.map((e) => [e.link, portKey(e.from), portKey(e.to), e.txStart, e.txEnd, e.arrive])).toEqual([
      ['l_1', 'd_pc1/Gi0', 'd_hub/P0', 0, a1, a1 + prop],
      ['l_2', 'd_hub/P1', 'd_pc2/Gi0', prop + 800, a1 + prop + 800, a1 + 2 * prop + 800],
      ['l_3', 'd_hub/P2', 'd_pc3/Gi0', prop + 800, a1 + prop + 800, a1 + 2 * prop + 800],
    ]);
    expect(txs.every((e) => e.medium === 'segment' && e.attempt === undefined)).toBe(true);
    // the first leg carries the sender's frame, receiver legs carry each receiver's clone
    expect(txs[0]!.pdu).toEqual(summarizePdu(pdu));
    expect(txs[1]!.pdu.parent).toBe(pdu.id);
    expect(txs[2]!.pdu.parent).toBe(pdu.id);
    expect(txs[1]!.pdu.id).not.toBe(txs[2]!.pdu.id);
    expect(h.port(h.pc1).tx).toEqual({ busyUntil: a1, queue: 1 });
    expect(h.wires).toEqual([expect.objectContaining({ t: 0, dir: 'tx', port: h.pc1, pdu })]);

    const legs = h.inflight.visible(prop + 800);
    expect(legs.map((l) => [l.link, l.to.device, l.medium])).toEqual([
      ['l_1', 'd_hub', 'segment'],
      ['l_2', 'd_pc2', 'segment'],
      ['l_3', 'd_pc3', 'segment'],
    ]);

    h.run();
    expect(h.deliveries.map((d) => [d.t, portKey(d.to)])).toEqual([
      [a1 + 2 * prop + 800, 'd_pc2/Gi0'],
      [a1 + 2 * prop + 800, 'd_pc3/Gi0'],
    ]);
    for (const d of h.deliveries) {
      expect(d.verdict).toMatchObject({ deliver: true, rx: { medium: 'segment' } });
      if (!d.verdict.deliver) throw new Error('expected delivery');
      expect(d.verdict.pdu.meta.parent).toBe(pdu.id);
      expect(d.verdict.corrupted).toBeUndefined();
    }
    expect(h.inflight.size()).toBe(1); // only the repeater leg, which never arrives, is left to pruning
    expect(h.inflight.visible(a1 + 10 * prop)).toEqual([]);
    expect(h.outcomes).toEqual([
      { t: a1, ref: h.pc1, o: { kind: 'sent', pdu: pdu.id, txStart: 0, bytes: pdu.size } },
      { t: a1, ref: h.hub[0], o: { kind: 'repeated', bytes: pdu.size, dir: 'in' } },
      { t: a1, ref: h.hub[1], o: { kind: 'repeated', bytes: pdu.size, dir: 'out' } },
      { t: a1, ref: h.hub[2], o: { kind: 'repeated', bytes: pdu.size, dir: 'out' } },
    ]);
    expect(h.port(h.pc1).tx.queue).toBe(0);
    expect(h.wires.filter((w) => w.dir === 'rx').map((w) => portKey(w.port))).toEqual(['d_pc2/Gi0', 'd_pc3/Gi0']);
  });

  it('delivers the original frame when there is a single receiver', () => {
    const h = segmentHarness();
    const hub = h.addHub('d_hub', 2);
    const a = h.addStation('d_a');
    const b = h.addStation('d_b');
    h.cable('l_1', a, hub[0]!);
    h.cable('l_2', b, hub[1]!);
    h.seg.rebuild(0);
    const pdu = h.frame(a);
    h.seg.transmit(a, pdu, 0);
    h.run();
    expect(h.deliveries).toHaveLength(1);
    expect(h.deliveries[0]!.verdict).toMatchObject({ deliver: true, pdu });
  });

  it('takes exactly five draws on link:<station cable>:seg per attempt and none on the P0 stream', () => {
    const h = hubOfThree({ seed: 9 });
    const pdu = h.frame(h.pc2);
    h.seg.transmit(h.pc2, pdu, 0);
    const ref5 = h.root.split('link:l_2:seg');
    const { lo, hi } = corruptionWindow(pdu);
    ref5.chance(0);
    ref5.chance(0);
    ref5.nextInt(0, 0);
    ref5.nextInt(lo, hi);
    ref5.nextInt(0, 7);
    expect(h.host.stream('link:l_2:seg').nextU32()).toBe(ref5.nextU32());
    expect(h.host.stream('link:l_2').nextU32()).toBe(h.root.split('link:l_2').nextU32());
  });

  it('a lost frame still occupies the wire and reports sent, but nobody receives it', () => {
    const h = hubOfThree({}, { l1: { impairments: { lossPct: 100 } } });
    const pdu = h.frame(h.pc1);
    h.events.length = 0;
    h.seg.transmit(h.pc1, pdu, 0);
    expect(h.ofKind('drop')).toEqual([
      { t: 0, kind: 'drop', pdu: summarizePdu(pdu), link: 'l_1', reason: 'link-loss', detail: 'loss 100%', medium: 'seg:l_1' },
    ]);
    expect(h.ofKind('frameTx')).toHaveLength(3);
    h.run();
    expect(h.deliveries).toEqual([]);
    expect(h.outcomes[0]).toMatchObject({ o: { kind: 'sent', pdu: pdu.id } });
  });

  it('corrupts every receiver copy but never the sender original', () => {
    const h = hubOfThree({}, { l1: { impairments: { corruptPct: 100 } } });
    const pdu = h.frame(h.pc1);
    const clean = pdu.bytes.slice();
    h.seg.transmit(h.pc1, pdu, 0);
    h.run();
    expect(pdu.bytes).toEqual(clean);
    expect(h.deliveries).toHaveLength(2);
    for (const d of h.deliveries) expect(d.verdict).toMatchObject({ deliver: true, corrupted: true });
  });

  it('refuses a 65th queued frame with queue-full', () => {
    const h = hubOfThree();
    for (let i = 0; i < CSMA.SEGMENT_TX_QUEUE_LIMIT; i++) expect(h.seg.transmit(h.pc1, h.frame(h.pc1), 0).ok).toBe(true);
    expect(h.port(h.pc1).tx.queue).toBe(64);
    const extra = h.frame(h.pc1);
    h.events.length = 0;
    expect(h.seg.transmit(h.pc1, extra, 0)).toEqual({ ok: false, reason: 'queue-full' });
    expect(h.events).toEqual([
      { t: 0, kind: 'drop', pdu: summarizePdu(extra), device: 'd_pc1', port: 'Gi0', reason: 'queue-full', detail: '64 frames already queued', medium: 'seg:l_1' },
    ]);
  });

  it('sends queued frames one after another, an interframe gap apart', () => {
    const h = hubOfThree();
    const f1 = h.frame(h.pc1);
    const f2 = h.frame(h.pc1);
    h.seg.transmit(h.pc1, f1, 0);
    h.seg.transmit(h.pc1, f2, 0);
    h.run();
    const starts = h.ofKind('frameTx').filter((e) => e.link === 'l_1').map((e) => [e.pdu.id, e.txStart]);
    const a1 = wireNs(f1.size, M10);
    expect(starts).toEqual([[f1.id, 0], [f2.id, a1 + 9_600]]);
    expect(h.outcomes.filter((o) => o.o.kind === 'sent').map((o) => o.o.kind === 'sent' && o.o.txStart)).toEqual([0, a1 + 9_600]);
  });

  it('refuses frames from ports without a cable or outside any collision domain', () => {
    const h = segmentHarness();
    const lone = h.addStation('d_lone');
    const r1 = h.addStation('d_r1');
    const r2 = h.addStation('d_r2');
    h.cable('l_1', r1, r2); // full duplex point-to-point
    h.seg.rebuild(0);
    expect(h.seg.segments()).toEqual([]);
    expect(h.seg.transmit(lone, h.frame(lone), 0)).toEqual({ ok: false, reason: 'link-down' });
    expect(h.seg.transmit(r1, h.frame(r1), 0)).toEqual({ ok: false, reason: 'link-down' });
    expect(h.ofKind('drop').map((e) => e.detail)).toEqual(['no cable', 'no collision domain']);
  });
});

describe('shared segment rebuild', () => {
  it('writes segment ids, and emits formed, changed and dissolved', () => {
    const h = hubOfThree();
    expect(h.ofKind('segmentChanged')).toEqual([
      {
        t: 0, kind: 'segmentChanged', segment: 'seg:l_1', op: 'formed',
        members: [h.pc1, h.pc2, h.pc3, ...h.hub],
      },
    ]);
    expect(['l_1', 'l_2', 'l_3'].map((id) => h.links.get(id)!.segment)).toEqual(['seg:l_1', 'seg:l_1', 'seg:l_1']);
    expect(h.port(h.pc2).phy?.segment).toBe('seg:l_1');
    expect(h.seg.segmentOfLink('l_2')).toBe('seg:l_1');
    expect(h.seg.segmentOfPort(h.hub[3]!)).toBe('seg:l_1');

    h.events.length = 0;
    h.seg.rebuild(5);
    expect(h.ofKind('segmentChanged')).toEqual([]);

    h.setDown('l_3');
    h.seg.rebuild(10);
    expect(h.ofKind('segmentChanged')).toEqual([
      { t: 10, kind: 'segmentChanged', segment: 'seg:l_1', op: 'changed', members: [h.pc1, h.pc2, ...h.hub] },
    ]);
    expect(h.links.get('l_3')!.segment).toBeUndefined();
    expect(h.seg.segmentOfPort(h.pc3)).toBeUndefined();

    h.events.length = 0;
    h.setDown('l_1');
    h.seg.rebuild(20);
    expect(h.ofKind('segmentChanged')).toEqual([
      { t: 20, kind: 'segmentChanged', segment: 'seg:l_1', op: 'dissolved', members: [] },
      { t: 20, kind: 'segmentChanged', segment: 'seg:l_2', op: 'formed', members: [h.pc2, ...h.hub] },
    ]);
    h.events.length = 0;
    h.setDown('l_2');
    h.seg.rebuild(30);
    expect(h.ofKind('segmentChanged')).toEqual([{ t: 30, kind: 'segmentChanged', segment: 'seg:l_2', op: 'dissolved', members: [] }]);
    expect(h.seg.segments()).toEqual([]);
  });

  it('a cable leaving the domain cuts the receivers behind it; the others still receive', () => {
    const h = hubOfThree();
    const pdu = h.frame(h.pc1);
    h.seg.transmit(h.pc1, pdu, 0);
    const toPc2 = h.ofKind('frameTx').find((e) => e.to.device === 'd_pc2')!;
    h.events.length = 0;
    h.setDown('l_2');
    h.seg.rebuild(100);
    expect(h.events.filter((e) => e.kind === 'drop' || e.kind === 'frameAbort')).toEqual([
      { t: 100, kind: 'drop', pdu: toPc2.pdu, link: 'l_2', reason: 'link-down', medium: 'seg:l_1', detail: 'left-segment' },
      { t: 100, kind: 'frameAbort', pdu: toPc2.pdu, link: 'l_2', from: h.hub[1], to: h.pc2, abortAt: 100, arrive: toPc2.arrive, reason: 'link-down' },
    ]);
    h.run();
    expect(h.deliveries.map((d) => d.to.device)).toEqual(['d_pc3']);
    expect(h.outcomes.filter((o) => o.o.kind === 'sent')).toHaveLength(1);
  });

  it('abort on a station cable drops the frame on the wire and every queued frame', () => {
    const h = hubOfThree();
    const frames = [h.frame(h.pc1), h.frame(h.pc1), h.frame(h.pc1)];
    for (const f of frames) h.seg.transmit(h.pc1, f, 0);
    h.events.length = 0;
    h.setDown('l_1');
    h.seg.abort('l_1', 10, 'cut');
    const drops = h.ofKind('drop');
    expect(drops.filter((d) => d.link !== undefined).map((d) => [d.link, d.reason])).toEqual([
      ['l_2', 'link-down'],
      ['l_3', 'link-down'],
    ]);
    expect(drops.filter((d) => d.device === 'd_pc1').map((d) => [d.pdu.id, d.reason, d.detail])).toEqual(frames.map((f) => [f.id, 'link-down', 'cut']));
    expect(h.ofKind('frameAbort').map((e) => e.link)).toEqual(['l_1', 'l_2', 'l_3']);
    expect(h.outcomes.map((o) => o.o)).toEqual(frames.map((f) => ({ kind: 'dropped', pdu: f.id, reason: 'link-down' })));
    expect(h.port(h.pc1).tx.queue).toBe(0);
    h.seg.rebuild(10);
    h.run();
    expect(h.deliveries).toEqual([]);
    expect(h.outcomes.some((o) => o.o.kind === 'sent')).toBe(false);
  });

  it('abort on the segment id drops every station', () => {
    const h = hubOfThree();
    h.seg.transmit(h.pc1, h.frame(h.pc1), 0);
    h.seg.transmit(h.pc3, h.frame(h.pc3), 0);
    h.outcomes.length = 0;
    h.seg.abort('seg:l_1', 1, 'power-off');
    expect(h.outcomes.map((o) => [o.ref.device, o.o.kind])).toEqual([
      ['d_pc1', 'dropped'],
      ['d_pc3', 'dropped'],
    ]);
    h.run();
    expect(h.deliveries).toEqual([]);
  });
});

describe('shared segment snapshot', () => {
  it('lists stations then repeater ports, the carrier on the wire and member statistics', () => {
    const h = hubOfThree();
    const pdu = h.frame(h.pc1);
    h.seg.transmit(h.pc1, pdu, 0);
    const during = emptyMedia();
    h.seg.contribute?.(1_000, during);
    const a1 = wireNs(pdu.size, M10);
    expect(during.segments).toEqual([
      {
        id: 'seg:l_1',
        bps: M10,
        members: [
          ...[h.pc1, h.pc2, h.pc3].map((port) => ({ port, role: 'station', duplex: 'half', tx: 0, collisions: 0, lateCollisions: 0, deferred: 0 })),
          ...h.hub.map((port) => ({ port, role: 'repeater', duplex: 'half', tx: 0, collisions: 0, lateCollisions: 0, deferred: 0 })),
        ],
        links: ['l_1', 'l_2', 'l_3'],
        busy: true,
        active: [{ pdu: pdu.id, from: h.pc1, txStart: 0, txEnd: a1 }],
        collisions: 0,
      },
    ]);
    expect(() => structuredClone(during)).not.toThrow();
    h.run();
    const after = emptyMedia();
    h.seg.contribute?.(a1 + 1_000_000, after);
    expect(after.segments[0]).toMatchObject({ busy: false, active: [] });
    expect(after.segments[0]!.members[0]).toMatchObject({ tx: 1 });
  });

  it('warns about an over-long coax segment and a path over too many repeaters', () => {
    const coax = segmentHarness();
    const hub = coax.addHub('d_hub', 2);
    const a = coax.addStation('d_a');
    const b = coax.addStation('d_b');
    coax.cable('l_1', a, hub[0]!, { media: 'coax', lengthM: 300 });
    coax.cable('l_2', b, hub[1]!, { media: 'coax', lengthM: 300 });
    coax.seg.rebuild(0);
    const snap = emptyMedia();
    coax.seg.contribute?.(0, snap);
    expect(snap.segments[0]!.warnings).toEqual(['coax-segment-too-long']);

    const chain = segmentHarness();
    const hubs = Array.from({ length: MAX_REPEATER_HOPS + 1 }, (_, i) => chain.addHub(`d_h${i}`, 2));
    const x = chain.addStation('d_x');
    const y = chain.addStation('d_y');
    chain.cable('l_x', x, hubs[0]![0]!);
    for (let i = 0; i < MAX_REPEATER_HOPS; i++) chain.cable(`l_c${i}`, hubs[i]![1]!, hubs[i + 1]![0]!);
    chain.cable('l_y', y, hubs[MAX_REPEATER_HOPS]![1]!);
    chain.seg.rebuild(0);
    const snap2 = emptyMedia();
    chain.seg.contribute?.(0, snap2);
    expect(snap2.segments).toHaveLength(1);
    expect(snap2.segments[0]!.warnings).toEqual(['repeater-rule-exceeded']);
    expect(snap2.segments[0]!.members.filter((m) => m.role === 'station').map((m) => m.port.device)).toEqual(['d_x', 'd_y']);
  });
});
