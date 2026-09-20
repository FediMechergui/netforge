import { describe, expect, it } from 'vitest';
import type { PortRef } from '../src/contracts/ids.js';
import { portKey } from '../src/contracts/ids.js';
import type { MediaSnapshot } from '../src/contracts/medium.js';
import { CSMA } from '../src/contracts/medium.js';
import type { Pdu } from '../src/contracts/pdu.js';
import type { Rng } from '../src/contracts/rng.js';
import { propagationNs, serializationNs } from '../src/contracts/time.js';
import { backoffMaxSlots, fragmentBytesFor, wireNs } from '../src/link/media/segment.js';
import { hubOfThree, meta, segmentHarness } from './link.segment.harness.js';

const M10 = CSMA.REPEATER_BPS;
const PROP_1M = propagationNs(1, 0.66);
/** Station ↔ station distance across the hub with 1 m cables. */
const D = PROP_1M + 800 + PROP_1M;
const IFG = 9_600;
const SLOT = 51_200;
const JAM = 3_200;

type Harness = ReturnType<typeof segmentHarness>;

/** A 1504-byte frame (ethernet + 1486 payload bytes + FCS). */
const bigFrame = (h: Harness, from: PortRef): Pdu =>
  h.pdus.build(
    [
      { proto: 'ethernet', fields: { dst: 'ff:ff:ff:ff:ff:ff', src: h.port(from).mac, type: 0x88b5 } },
      { proto: 'payload', fields: { data: new Uint8Array(1486) } },
    ],
    meta(),
  );

/** An Rng whose integer draws always return the lower bound (every backoff picks 0 slots). */
const zeroRng = (): Rng => {
  const rng: Rng = {
    nextU32: () => 0,
    nextFloat: () => 0,
    nextInt: (lo) => lo,
    chance: () => false,
    split: () => zeroRng(),
    state: () => [0, 0, 0, 0],
  };
  return rng;
};

describe('CSMA/CD carrier sense', () => {
  it('defers while carrier is sensed, reports deferred once per frame and waits an interframe gap', () => {
    const h = hubOfThree();
    const f1 = h.frame(h.pc1);
    const f3 = h.frame(h.pc1);
    const f2 = h.frame(h.pc2);
    h.seg.transmit(h.pc1, f1, 0);
    h.seg.transmit(h.pc1, f3, 0);
    const a1 = wireNs(f1.size, M10);
    expect(D).toBe(812);

    // pc1's signal reached pc2 at D, so pc2 hears carrier at t = 1000
    h.seg.transmit(h.pc2, f2, 1_000);
    expect(h.ofKind('carrierDefer')).toEqual([{ t: 1_000, kind: 'carrierDefer', device: 'd_pc2', port: 'Gi0', pdu: f2.id, until: a1 + D }]);
    expect(h.outcomes).toEqual([{ t: 1_000, ref: h.pc2, o: { kind: 'deferred', pdu: f2.id } }]);

    h.run();
    const second = a1 + IFG; // pc1's queued frame, one gap after its first
    expect(h.ofKind('carrierDefer')).toEqual([
      { t: 1_000, kind: 'carrierDefer', device: 'd_pc2', port: 'Gi0', pdu: f2.id, until: a1 + D },
      // at a1 + D + IFG pc2 hears pc1's second frame, which started at a1 + IFG
      { t: a1 + D + IFG, kind: 'carrierDefer', device: 'd_pc2', port: 'Gi0', pdu: f2.id, until: second + a1 + D },
    ]);
    expect(h.ofKind('collision')).toEqual([]);
    const sent = h.outcomes.filter((o) => o.o.kind === 'sent').map((o) => [o.ref.device, o.o.kind === 'sent' ? o.o.txStart : -1]);
    expect(sent).toEqual([
      ['d_pc1', 0],
      ['d_pc1', second],
      ['d_pc2', second + a1 + D + IFG],
    ]);
    expect(h.outcomes.filter((o) => o.o.kind === 'deferred')).toHaveLength(1);
    const snap: MediaSnapshot = { metresPerUnit: 0.25, segments: [], bss: [], cells: [], associations: [] };
    h.seg.contribute?.(10 * a1, snap);
    expect(snap.segments[0]!.members.map((m) => [m.port.device, m.tx, m.deferred])).toEqual([
      ['d_pc1', 2, 0],
      ['d_pc2', 1, 1],
      ['d_pc3', 0, 0],
      ['d_hub', 0, 0],
      ['d_hub', 0, 0],
      ['d_hub', 0, 0],
      ['d_hub', 0, 0],
    ]);
    expect(h.deliveries.every((d) => d.verdict.deliver && d.verdict.rx?.collided === undefined)).toBe(true);
  });
});

describe('CSMA/CD collisions', () => {
  it('two simultaneous starts collide: both detect, jam, abort every leg and deliver collision fragments', () => {
    const h = hubOfThree();
    const f1 = h.frame(h.pc1);
    const f3 = h.frame(h.pc3);
    h.seg.transmit(h.pc1, f1, 0);
    h.events.length = 0;
    h.outcomes.length = 0;
    h.seg.transmit(h.pc3, f3, 0);

    expect(h.ofKind('collision')).toEqual([
      { t: 0, kind: 'collision', segment: 'seg:l_1', stations: [h.pc1, h.pc3], pdus: [f3.id, f1.id], detectAt: D, jamUntil: D + JAM, late: false },
    ]);
    const aborts = h.ofKind('frameAbort');
    expect(aborts.map((e) => [e.link, portKey(e.from), portKey(e.to), e.abortAt, e.arrive, e.reason])).toEqual([
      ['l_1', 'd_pc1/Gi0', 'd_hub/P0', D, D + PROP_1M, 'collision'],
      ['l_2', 'd_hub/P1', 'd_pc2/Gi0', D + PROP_1M + 800, 2 * D, 'collision'],
      ['l_3', 'd_hub/P2', 'd_pc3/Gi0', D + PROP_1M + 800, 2 * D, 'collision'],
      ['l_3', 'd_pc3/Gi0', 'd_hub/P2', D, D + PROP_1M, 'collision'],
      ['l_1', 'd_hub/P0', 'd_pc1/Gi0', D + PROP_1M + 800, 2 * D, 'collision'],
      ['l_2', 'd_hub/P1', 'd_pc2/Gi0', D + PROP_1M + 800, 2 * D, 'collision'],
    ]);
    const fragment = fragmentBytesFor(0, D, M10);
    expect(fragment).toBe(0);
    expect(h.outcomes).toEqual([
      { t: 0, ref: h.pc1, o: { kind: 'collision', pdu: f1.id, late: false, attempt: 1 } },
      { t: 0, ref: h.hub[0], o: { kind: 'repeated', bytes: fragment, dir: 'in', fragment: true } },
      { t: 0, ref: h.hub[1], o: { kind: 'repeated', bytes: fragment, dir: 'out', fragment: true } },
      { t: 0, ref: h.hub[2], o: { kind: 'repeated', bytes: fragment, dir: 'out', fragment: true } },
      { t: 0, ref: h.pc3, o: { kind: 'collision', pdu: f3.id, late: false, attempt: 1 } },
      { t: 0, ref: h.hub[2], o: { kind: 'repeated', bytes: fragment, dir: 'in', fragment: true } },
      { t: 0, ref: h.hub[0], o: { kind: 'repeated', bytes: fragment, dir: 'out', fragment: true } },
      { t: 0, ref: h.hub[1], o: { kind: 'repeated', bytes: fragment, dir: 'out', fragment: true } },
    ]);
    expect(h.port(h.pc1).tx.busyUntil).toBe(D + JAM);
    expect(h.inflight.visible(D).every((l) => l.abortAt !== undefined)).toBe(true);

    // the first arrivals are the collision fragments, received as collisions by the half-duplex stations
    h.run(2 * D);
    expect(h.deliveries.map((d) => [d.t, portKey(d.to), d.verdict.deliver && d.verdict.rx])).toEqual([
      [2 * D, 'd_pc2/Gi0', { medium: 'segment', collided: true }],
      [2 * D, 'd_pc3/Gi0', { medium: 'segment', collided: true }],
      [2 * D, 'd_pc1/Gi0', { medium: 'segment', collided: true }],
      [2 * D, 'd_pc2/Gi0', { medium: 'segment', collided: true }],
    ]);
    expect(h.wires.filter((w) => w.dir === 'rx')).toHaveLength(4);

    // after the jam each station backs off with draws from link:<its cable>:csma, and both frames get through
    h.run();
    const sent = h.outcomes.filter((o) => o.o.kind === 'sent').map((o) => o.ref.device).sort();
    expect(sent).toEqual(['d_pc1', 'd_pc3']);
    for (const [station, cable] of [[h.pc1, 'l_1'], [h.pc3, 'l_3']] as const) {
      const backoffs = h.ofKind('backoff').filter((e) => e.device === station.device);
      const collisions = h.outcomes.filter((o) => o.ref.device === station.device && o.o.kind === 'collision');
      expect(backoffs).toHaveLength(collisions.length);
      const reference = h.root.split(`link:${cable}:csma`);
      for (const b of backoffs) {
        expect(b.slots).toBe(reference.nextInt(0, backoffMaxSlots(b.attempt)));
        expect(b.until).toBe(b.t + b.slots * SLOT);
      }
      expect(backoffs[0]).toMatchObject({ t: D + JAM, attempt: 1, pdu: station === h.pc1 ? f1.id : f3.id });
    }
    const complete = h.deliveries.filter((d) => d.verdict.deliver && d.verdict.rx?.collided === undefined);
    expect(complete.map((d) => d.to.device).sort()).toEqual(['d_pc1', 'd_pc2', 'd_pc2', 'd_pc3']);
    const retried = h.ofKind('frameTx').filter((e) => e.attempt !== undefined);
    expect(retried.length).toBeGreaterThan(0);
  });

  it('drops a frame after 16 collisions', () => {
    const h = hubOfThree({ stream: (label, fallback) => (label.endsWith(':csma') ? zeroRng() : fallback()) });
    const f1 = h.frame(h.pc1);
    const f3 = h.frame(h.pc3);
    h.seg.transmit(h.pc1, f1, 0);
    h.seg.transmit(h.pc3, f3, 0);
    h.run();
    expect(h.ofKind('collision')).toHaveLength(CSMA.MAX_ATTEMPTS);
    for (const [station, pdu] of [[h.pc1, f1], [h.pc3, f3]] as const) {
      const mine = h.outcomes.filter((o) => o.ref.device === station.device);
      const attempts = mine.flatMap((o) => (o.o.kind === 'collision' ? [o.o.attempt] : []));
      expect(attempts).toEqual(Array.from({ length: CSMA.MAX_ATTEMPTS }, (_, i) => i + 1));
      expect(mine.filter((o) => o.o.kind === 'deferred')).toHaveLength(1);
      expect(mine.at(-1)!.o).toEqual({ kind: 'dropped', pdu: pdu.id, reason: 'excessive-collisions' });
      expect(h.ofKind('backoff').filter((e) => e.device === station.device)).toHaveLength(CSMA.MAX_ATTEMPTS - 1);
    }
    expect(h.ofKind('drop').map((e) => [e.device, e.reason, e.detail, e.medium])).toEqual([
      ['d_pc1', 'excessive-collisions', '16 collisions', 'seg:l_1'],
      ['d_pc3', 'excessive-collisions', '16 collisions', 'seg:l_1'],
    ]);
    expect(h.outcomes.some((o) => o.o.kind === 'sent')).toBe(false);
    expect(h.port(h.pc1).tx.queue).toBe(0);
  });

  it('a collision detected after the slot time is late: no retry, drop late-collision', () => {
    const h = hubOfThree({}, { l3: { lengthM: 20_000 } });
    const d = PROP_1M + 800 + propagationNs(20_000, 0.66);
    expect(d).toBeGreaterThan(SLOT);
    const f1 = bigFrame(h, h.pc1);
    const f3 = bigFrame(h, h.pc3);
    expect(wireNs(f1.size, M10)).toBeGreaterThan(d);
    h.seg.transmit(h.pc1, f1, 0);
    h.seg.transmit(h.pc3, f3, 0);
    expect(h.ofKind('collision')).toEqual([
      expect.objectContaining({ stations: [h.pc1, h.pc3], detectAt: d, jamUntil: d + JAM, late: true }),
    ]);
    expect(new Set(h.ofKind('frameAbort').map((e) => e.reason))).toEqual(new Set(['late-collision']));
    h.run();
    expect(h.ofKind('backoff')).toEqual([]);
    expect(h.ofKind('drop').map((e) => [e.device, e.reason])).toEqual([
      ['d_pc1', 'late-collision'],
      ['d_pc3', 'late-collision'],
    ]);
    expect(h.outcomes.filter((o) => o.o.kind === 'collision').map((o) => o.o.kind === 'collision' && o.o.late)).toEqual([true, true]);
    const snap: MediaSnapshot = { metresPerUnit: 0.25, segments: [], bss: [], cells: [], associations: [] };
    h.seg.contribute?.(0, snap);
    expect(snap.segments[0]!.members.slice(0, 3).map((m) => [m.collisions, m.lateCollisions])).toEqual([[1, 1], [0, 0], [1, 1]]);
    expect(snap.segments[0]!.collisions).toBe(1);
  });

  it('the full-duplex end of a mismatch transmits over carrier; the half end detects, the full end gets a fragment', () => {
    const h = segmentHarness();
    const r1 = h.addStation('d_r1');
    const r2 = h.addStation('d_r2');
    h.cable('l_m', r1, r2, { duplexA: 'full', duplexB: 'half' });
    h.seg.rebuild(0);
    expect(h.seg.segments().map((s) => [s.id, s.stations.length, s.repeaters.length])).toEqual([['seg:l_m', 2, 0]]);
    const bps = 1_000_000_000;
    const slot = serializationNs(64, bps);
    const fHalf = bigFrame(h, r2);
    const fFull = bigFrame(h, r1);
    h.seg.transmit(r2, fHalf, 0);
    h.seg.transmit(r1, fFull, 5_000);
    expect(h.ofKind('carrierDefer')).toEqual([]);
    const tDet = 5_000 + PROP_1M;
    expect(tDet).toBeGreaterThan(slot);
    expect(h.ofKind('collision')).toEqual([
      { t: 5_000, kind: 'collision', segment: 'seg:l_m', stations: [r2], pdus: [fFull.id, fHalf.id], detectAt: tDet, jamUntil: tDet + serializationNs(4, bps), late: true },
    ]);
    h.run();
    const at = (device: string) => h.deliveries.filter((x) => x.to.device === device).map((x) => x.verdict.deliver && x.verdict.rx);
    // the half end was transmitting while the full end's frame arrived: collision
    expect(at('d_r2')).toEqual([{ medium: 'segment', collided: true }]);
    // the full end receives what made it onto the wire before the abort
    expect(at('d_r1')).toEqual([{ medium: 'segment', fragmentBytes: fragmentBytesFor(0, tDet, bps) }]);
    expect(h.outcomes.filter((o) => o.ref.device === 'd_r1').map((o) => o.o.kind)).toEqual(['sent']);
    expect(h.outcomes.filter((o) => o.ref.device === 'd_r2').map((o) => o.o.kind)).toEqual(['collision', 'dropped']);
  });

  it('is deterministic: the same seed gives identical traces and outcomes', () => {
    const once = (): string => {
      const h = hubOfThree({ seed: 42 });
      for (let i = 0; i < 3; i++) {
        h.seg.transmit(h.pc1, h.frame(h.pc1), 0);
        h.seg.transmit(h.pc2, h.frame(h.pc2), 0);
        h.seg.transmit(h.pc3, h.frame(h.pc3), 0);
      }
      h.run();
      return JSON.stringify({ events: h.events, outcomes: h.outcomes, deliveries: h.deliveries.map((d) => [d.t, d.to, d.verdict.deliver && d.verdict.rx]) });
    };
    const first = once();
    expect(once()).toBe(first);
    expect(JSON.parse(first).outcomes.filter((o: { o: { kind: string } }) => o.o.kind === 'sent')).toHaveLength(9);
  });
});
