// core/queueing (ARCHITECTURE-P3 D16, §3.5 step 7, §3.11, §4.5; §7 W1 core): FIFO, flow DRR (WFQ), class DRR (CBWFQ),
// strict priority with a conditional token-bucket policer (LLQ), integer only. The brief's tolerances: a DRR ratio of
// 2:1 within 5 %, the priority-queue bound, and no drift over 10^6 packets.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { serializationNs, SEC } from '../src/contracts/time.js';
import {
  createQueueScheduler,
  createTokenBucket,
  defaultClassIndex,
  llqBurstBytes,
  LLQ_BURST_MS,
  refillTokenBucket,
  simulateQueueing,
  takeTokens,
  tokenWaitNs,
  type QueueingArrival,
  type QueueingClassSpec,
  type QueueingSpec,
} from '../src/core/queueing.js';

const cls = (name: string, kind: QueueingClassSpec['kind'], weightKbps: number, queueLimit = 0, extra: Partial<QueueingClassSpec> = {}): QueueingClassSpec =>
  ({ name, kind, weightKbps, queueLimit, ...extra });

/** A deterministic 32-bit LCG for test inputs. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

describe('core/queueing: token bucket', () => {
  it('starts full, takes only what it holds, and refills at its rate', () => {
    const b = createTokenBucket(32_000, 6400, 0);
    expect(b.tokensBits).toBe(6400);
    expect(takeTokens(b, 480, 0)).toBe(true);
    expect(b.tokensBits).toBe(5920);
    expect(takeTokens(b, 6000, 0)).toBe(false);
    expect(b.tokensBits).toBe(5920);
    // 32 kb/s: 15 ms earns 480 bits
    expect(takeTokens(b, 6400, 15_000_000)).toBe(true);
    expect(b.tokensBits).toBe(0);
    refillTokenBucket(b, 15_000_000 + 10 * SEC);
    expect(b.tokensBits).toBe(6400);
    expect(b.carry).toBe(0);
    expect(() => createTokenBucket(0, 10, 0)).toThrow(RangeError);
    expect(() => createTokenBucket(1000, 0, 0)).toThrow(RangeError);
  });

  it('no drift: 10^6 irregular refills add exactly floor(total × rate / 10^9) bits', () => {
    for (const rate of [7, 128_000, 1_544_000, 999_999_937, 10_000_000_000, 400_000_000_000]) {
      const cap = 1_125_899_906_842_624; // 2^50: never reached in the run
      const b = createTokenBucket(rate, cap, 0);
      b.tokensBits = 0;
      const next = lcg(rate % 1000);
      let now = 0;
      for (let i = 0; i < 1_000_000; i++) {
        now += next() % 20_000;
        refillTokenBucket(b, now);
      }
      const exact = (BigInt(now) * BigInt(rate)) / 1_000_000_000n;
      const rest = (BigInt(now) * BigInt(rate)) % 1_000_000_000n;
      expect(BigInt(b.tokensBits), `rate ${rate}`).toBe(exact);
      expect(BigInt(b.carry), `rate ${rate}`).toBe(rest);
    }
  });

  it('tokenWaitNs is the exact ceiling: enough at now + wait, not enough 1 ns earlier', () => {
    for (const rate of [7, 128_000, 1_544_000, 999_999_937, 10_000_000_000]) {
      const next = lcg(rate % 977);
      for (let k = 0; k < 50; k++) {
        const cap = 1 + (next() % 5_000_000);
        const b = createTokenBucket(rate, cap, 0);
        b.tokensBits = next() % cap;
        b.carry = next() % 1_000_000_000;
        const want = 1 + (next() % cap);
        const w = tokenWaitNs(b, want, 0)!;
        const probe = (t: number): number => {
          const c = { ...b };
          refillTokenBucket(c, t);
          return c.tokensBits;
        };
        if (w === 0) {
          expect(b.tokensBits).toBeGreaterThanOrEqual(want);
        } else {
          expect(probe(w), `rate ${rate} cap ${cap} want ${want}`).toBeGreaterThanOrEqual(want);
          expect(probe(w - 1), `rate ${rate} cap ${cap} want ${want}`).toBeLessThan(want);
        }
      }
    }
    expect(tokenWaitNs(createTokenBucket(1000, 100, 0), 101, 0)).toBeUndefined();
  });
});

describe('core/queueing: scheduler', () => {
  it('FIFO: one default class, arrival order, tail drop at the queue limit', () => {
    const s = createQueueScheduler<string>({ classes: [cls('class-default', 'default', 1, 3)] });
    const r = ['a', 'b', 'c', 'd'].map((item) => s.enqueue({ item, bytes: 100, cls: 0 }, 0, true));
    expect(r).toEqual([{ ok: true, depth: 1 }, { ok: true, depth: 2 }, { ok: true, depth: 3 }, { ok: false, reason: 'queue-full' }]);
    expect([s.dequeue(0)?.item, s.dequeue(0)?.item, s.dequeue(0)?.item, s.dequeue(0)]).toEqual(['a', 'b', 'c', undefined]);
    expect(s.classStats()).toEqual([{
      name: 'class-default', kind: 'default', depth: 0, limit: 3, matched: 4, matchedBytes: 400, sent: 3, sentBytes: 300, tailDrops: 1, policed: 0, flows: 0,
    }]);
  });

  it('class DRR, by hand: weights 2:1, quantum 100 → A1 A2 B1 A3 B2 B3 at 100 ms each on 8 kb/s', () => {
    const spec: QueueingSpec = { classes: [cls('A', 'bandwidth', 2), cls('B', 'bandwidth', 1)], quantumBytes: 100 };
    const arrivals: QueueingArrival[] = [0, 0, 0, 1, 1, 1].map((c) => ({ at: 0, bytes: 100, cls: c }));
    const d = simulateQueueing(spec, arrivals, 8000);
    const order = [...d].sort((a, b) => a.start! - b.start!).map((x) => x.index);
    expect(order).toEqual([0, 1, 3, 2, 4, 5]);
    expect(d.map((x) => x.start)).toEqual([0, 100_000_000, 300_000_000, 200_000_000, 400_000_000, 500_000_000]);
    expect(d[5]).toEqual({ index: 5, arrival: 0, cls: 1, start: 500_000_000, end: 600_000_000, waitNs: 500_000_000 });
  });

  it('CBWFQ: two backlogged classes at 64 and 32 kb/s share bytes 2:1 within 5 %', () => {
    const s = createQueueScheduler<number>({ classes: [cls('GOLD', 'bandwidth', 64), cls('SILVER', 'bandwidth', 32), cls('class-default', 'default', 1)] });
    const next = lcg(7);
    const size = (): number => 64 + (next() % 1437);
    for (let i = 0; i < 64; i++) {
      s.enqueue({ item: 0, bytes: size(), cls: 0 }, 0, true);
      s.enqueue({ item: 1, bytes: size(), cls: 1 }, 0, true);
    }
    const bytes = [0, 0];
    for (let i = 0; i < 20_000; i++) {
      const p = s.dequeue(0)!;
      bytes[p.cls] = bytes[p.cls]! + p.bytes;
      s.enqueue({ item: p.cls, bytes: size(), cls: p.cls }, 0, true);
    }
    const ratio = bytes[0]! / bytes[1]!;
    expect(ratio).toBeGreaterThan(1.9);
    expect(ratio).toBeLessThan(2.1);
  });

  it('no drift over 10^6 packets: bytes stay within a fixed bound of the exact 2:1 share', () => {
    const quantumBytes = 1500;
    const s = createQueueScheduler<number>({ classes: [cls('A', 'bandwidth', 2), cls('B', 'bandwidth', 1)], quantumBytes });
    const next = lcg(99);
    const size = (): number => 40 + (next() % 1461);
    for (let i = 0; i < 8; i++) {
      s.enqueue({ item: 0, bytes: size(), cls: 0 }, 0, true);
      s.enqueue({ item: 1, bytes: size(), cls: 1 }, 0, true);
    }
    const bytes = [0, 0];
    let worst = 0;
    for (let i = 1; i <= 1_000_000; i++) {
      const p = s.dequeue(0)!;
      bytes[p.cls] = bytes[p.cls]! + p.bytes;
      s.enqueue({ item: p.cls, bytes: size(), cls: p.cls }, 0, true);
      if (i % 1000 === 0) worst = Math.max(worst, Math.abs(bytes[0]! - 2 * bytes[1]!));
    }
    // DRR's deficit bound: at most a quantum plus a packet per class, whatever the run length
    expect(worst).toBeLessThanOrEqual(2 * (2 * quantumBytes + 1500) + 2 * (quantumBytes + 1500));
    expect(bytes[0]! + bytes[1]!).toBeGreaterThan(700_000_000);
  });

  it('flow DRR (WFQ): flows share bytes equally whatever their packet sizes; a weight-2 flow gets twice', () => {
    const s = createQueueScheduler<string>({ classes: [cls('class-default', 'default', 1, 0, { fairQueue: true })] });
    const push = (flow: string, bytes: number, flowWeight?: number): void => {
      s.enqueue({ item: flow, bytes, cls: 0, flow, ...(flowWeight === undefined ? {} : { flowWeight }) }, 0, true);
    };
    for (let i = 0; i < 10; i++) {
      push('bulk', 1500);
      push('small', 100);
      push('gold', 1000, 2);
    }
    expect(s.classStats()[0]!.flows).toBe(3);
    const bytes: Record<string, number> = { bulk: 0, small: 0, gold: 0 };
    for (let i = 0; i < 20_000; i++) {
      const p = s.dequeue(0)!;
      bytes[p.item] = bytes[p.item]! + p.bytes;
      push(p.item, p.bytes, p.item === 'gold' ? 2 : undefined);
    }
    expect(Math.abs(bytes['bulk']! - bytes['small']!)).toBeLessThanOrEqual(3000);
    const r = bytes['gold']! / bytes['bulk']!;
    expect(r).toBeGreaterThan(1.95);
    expect(r).toBeLessThan(2.05);
  });

  it('flows are served in first-seen order and leave when empty', () => {
    const s = createQueueScheduler<string>({ classes: [cls('class-default', 'default', 1, 0, { fairQueue: true })], quantumBytes: 100 });
    for (const [item, flow] of [['x1', 'x'], ['y1', 'y'], ['x2', 'x'], ['z1', 'z']] as const) s.enqueue({ item, bytes: 100, cls: 0, flow }, 0, true);
    const out: string[] = [];
    for (let p = s.dequeue(0); p !== undefined; p = s.dequeue(0)) out.push(p.item);
    expect(out).toEqual(['x1', 'y1', 'z1', 'x2']);
    expect(s.classStats()[0]!.flows).toBe(0);
  });

  it('a priority class is always served first', () => {
    const s = createQueueScheduler<string>({ classes: [cls('VOICE', 'priority', 32), cls('class-default', 'default', 1)] });
    s.enqueue({ item: 'd1', bytes: 1000, cls: 1 }, 0, true);
    s.enqueue({ item: 'd2', bytes: 1000, cls: 1 }, 0, true);
    s.enqueue({ item: 'v1', bytes: 60, cls: 0 }, 0, true);
    expect(s.dequeue(0)?.item).toBe('v1');
    s.enqueue({ item: 'v2', bytes: 60, cls: 0 }, 0, true);
    expect([s.dequeue(0)?.item, s.dequeue(0)?.item, s.dequeue(0)?.item]).toEqual(['v2', 'd1', 'd2']);
    expect(defaultClassIndex({ classes: [cls('VOICE', 'priority', 32), cls('class-default', 'default', 1)] })).toBe(1);
    expect(defaultClassIndex({ classes: [cls('A', 'bandwidth', 1), cls('B', 'bandwidth', 1)] })).toBe(1);
    expect(() => s.enqueue({ item: 'bad', bytes: 60, cls: 2 }, 0, true)).toThrow(RangeError);
  });
});

describe('core/queueing: LLQ, the priority-queue bound (§3.11)', () => {
  const RATE = 128_000;
  const llq: QueueingSpec = {
    classes: [cls('VOICE', 'priority', 32, 0, { rateBps: 32_000, burstBytes: 800 }), cls('class-default', 'default', 96, 64)],
  };
  const traffic = (voicePeriodNs: number, seconds: number): QueueingArrival[] => {
    const a: QueueingArrival[] = [];
    for (let t = 0; t < seconds * SEC; t += voicePeriodNs) a.push({ at: t + 1_000_000, bytes: 60, cls: 0 });
    for (let t = 0; t < seconds * SEC; t += 40_000_000) a.push({ at: t, bytes: 1004, cls: 1 });
    return a;
  };

  it('voice within its rate is never policed and waits at most one data frame', () => {
    const arr = traffic(20_000_000, 10);
    const d = simulateQueueing(llq, arr, RATE);
    const voice = d.filter((x) => x.cls === 0);
    expect(voice.every((x) => x.dropped === undefined)).toBe(true);
    const maxWait = Math.max(...voice.map((x) => x.waitNs!));
    expect(maxWait).toBeLessThanOrEqual(serializationNs(1004, RATE));
    expect(maxWait).toBeGreaterThan(0);
    // the data class is overloaded (≈ 200 kb/s on 128 kb/s): it tail-drops
    expect(d.some((x) => x.cls === 1 && x.dropped === 'queue-full')).toBe(true);
  });

  it('voice above its rate is policed during congestion; the others keep the rest of the link', () => {
    const seconds = 10;
    const arr = traffic(10_000_000, seconds);
    const d = simulateQueueing(llq, arr, RATE);
    const voice = d.filter((x) => x.cls === 0);
    const policed = voice.filter((x) => x.dropped === 'policed').length;
    expect(policed).toBeGreaterThan(0);
    const sentVoiceBits = voice.filter((x) => x.dropped === undefined).length * 60 * 8;
    // the bucket admits at most rate × time + burst while the port is congested (the whole run here)
    expect(sentVoiceBits).toBeLessThanOrEqual(32_000 * seconds + 800 * 8 + 60 * 8);
    const dataBits = d.filter((x) => x.cls === 1 && x.end !== undefined && x.end <= seconds * SEC).length * 1004 * 8;
    expect(dataBits).toBeGreaterThanOrEqual((RATE - 32_000) * seconds - 2 * 1004 * 8);
  });

  it('an uncongested priority packet is not charged to the bucket (the conditional policer)', () => {
    // 60-byte voice every 5 ms = 96 kb/s, three times the rate, on an otherwise idle 1 Mb/s link: never congested
    const a: QueueingArrival[] = [];
    for (let t = 0; t < SEC; t += 5_000_000) a.push({ at: t, bytes: 60, cls: 0 });
    const d = simulateQueueing(llq, a, 1_000_000);
    expect(d.every((x) => x.dropped === undefined && x.waitNs === 0)).toBe(true);
  });

  it('without burstBytes the burst is 200 ms of the rate (the listed [S20] deviation)', () => {
    expect(LLQ_BURST_MS).toBe(200);
    expect(llqBurstBytes(32_000)).toBe(800);
    expect(llqBurstBytes(64_000)).toBe(1600);
    expect(llqBurstBytes(1)).toBe(1);
    const implicit: QueueingSpec = { classes: [cls('VOICE', 'priority', 32, 0, { rateBps: 32_000 }), cls('class-default', 'default', 96, 64)] };
    const arr = traffic(10_000_000, 3);
    expect(simulateQueueing(implicit, arr, RATE)).toEqual(simulateQueueing(llq, arr, RATE));
  });

  it('is deterministic: the same arrivals give the same departures', () => {
    const arr = traffic(10_000_000, 3);
    const once = simulateQueueing(llq, arr, RATE);
    expect(simulateQueueing(llq, arr, RATE)).toEqual(once);
    // the input order does not matter, only the times (no two arrivals share a time here)
    const n = arr.length;
    const reversed = simulateQueueing(llq, [...arr].reverse(), RATE);
    for (let i = 0; i < n; i++) {
      const { index: _a, ...x } = once[i]!;
      const { index: _b, ...y } = reversed[n - 1 - i]!;
      expect(y).toEqual(x);
    }
  });
});

describe('core/queueing: integer discipline (§4.5)', () => {
  it('uses no floating-point maths, exponentiation, randomness or clocks', () => {
    const BANNED = /Math\.(log10|log2|log|pow|exp|random)\s*\(|Date\.now|performance\.now|new Date\(|setTimeout|[\w)\]]\s*\*\*\s*[\w(]/;
    const src = readFileSync(new URL('../src/core/queueing.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(BANNED);
  });
});
