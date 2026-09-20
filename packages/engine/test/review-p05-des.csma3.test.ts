/**
 * review-p05 (des lens): segment.ts detectCollisions skips a transmission already marked aborted (line 927), so a
 * station that will detect a far collider at t1 never detects a nearer third starter whose signal reaches it at t0 < t1.
 */
import { describe, expect, it } from 'vitest';
import { propagationNs } from '../src/contracts/time.js';
import type { MediaSnapshot } from '../src/contracts/medium.js';
import { hubOfThree } from './link.segment.harness.js';

const JAM = 3_200;
const REP = 800;

describe('review-p05-des CSMA three-way collision', () => {
  it('a station already colliding with a far station detects a nearer third starter at the earlier time', () => {
    const h = hubOfThree({}, { l1: { lengthM: 200 }, l2: { lengthM: 1 }, l3: { lengthM: 1 } });
    const p200 = propagationNs(200, 0.66);
    const p1 = propagationNs(1, 0.66);
    const d12 = p200 + REP + p1;
    const d23 = p1 + REP + p1;
    expect(d23).toBeLessThan(d12);
    h.seg.transmit(h.pc2, h.frame(h.pc2), 0);
    h.seg.transmit(h.pc1, h.frame(h.pc1), 0); // collides with pc2: pc2 would detect at d12
    h.seg.transmit(h.pc3, h.frame(h.pc3), 0); // pc3's signal reaches pc2 at d23 < d12
    // pc2 physically senses pc3's signal at d23, so it must stop and jam by d23 + JAM
    expect(h.port(h.pc2).tx.busyUntil).toBe(d23 + JAM);
    // the earlier detection moves the same collision; it is counted once
    expect(h.outcomes.filter((o) => o.ref.device === h.pc2.device && o.o.kind === 'collision')).toHaveLength(1);
    const snap: MediaSnapshot = { metresPerUnit: 0.25, segments: [], bss: [], cells: [], associations: [] };
    h.seg.contribute?.(0, snap);
    const m2 = snap.segments[0]!.members.find((m) => m.port.device === h.pc2.device)!;
    expect(m2.collisions).toBe(1);
    expect(m2.lateCollisions).toBe(0);
    // the frameAbort re-emitted for pc2 carries the earlier abort time
    const aborts = h.ofKind('frameAbort').filter((e) => e.from.device === h.pc2.device);
    expect(Math.min(...aborts.map((e) => e.abortAt))).toBe(d23);
    h.run();
    // the stale (later) jam timer was cancelled: pc2's first backoff starts at the earlier jam end
    expect(h.ofKind('backoff').filter((e) => e.device === h.pc2.device)[0]!.t).toBe(d23 + JAM);
  });
});
