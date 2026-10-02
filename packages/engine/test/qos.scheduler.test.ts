// link/qos/scheduler (ARCHITECTURE-P3 D16 [S20]/[S21], §3.11, §4.2, §4.5; §7 W2 qos): the held queue's scheduler of a
// scheduler port over W1 core/queueing. The brief's cases: CBWFQ 2:1 ± 5 %, the LLQ bound, conform/exceed counts, and
// shaping without drops below the limit; plus the shaper's exact next-eligible time, the queue view (the 30-second
// offered rate), drain, the WFQ flow key, the 75 % admission function and the integer discipline.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EgressClassSpec, EgressSchedulerSpec } from '../src/contracts/link.js';
import { ETHERTYPE_ARP, ETHERTYPE_IPV4, type LayerSpec } from '../src/contracts/pdu.js';
import { MS, SEC, serializationNs } from '../src/contracts/time.js';
import { parseConfigText } from '../src/cli/config-ast.js';
import {
  createPortScheduler,
  createQosPolicer,
  createQosShaper,
  egressAdmission,
  policeQosPacket,
  qosFlowOf,
  qosPoliceBurstBytes,
  qosQueueFullDetail,
  qosPolicedDetail,
  qosShapeDefaultBcBits,
  qosShaperEligibleAt,
  qosShaperSend,
  QOS_DEFAULT_QUEUE_LIMIT,
  simulatePortScheduler,
  type PortArrival,
  type PortDeparture,
} from '../src/link/qos/scheduler.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { compileEgressScheduler } from '../src/qos/config.js';

const cls = (name: string, kind: EgressClassSpec['kind'], weightKbps: number, extra: Partial<EgressClassSpec> = {}): EgressClassSpec => ({
  name,
  kind,
  weightKbps,
  queueLimit: QOS_DEFAULT_QUEUE_LIMIT,
  ...extra,
});

/** A deterministic 32-bit LCG for test inputs. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

/** Bytes whose serialisation ended by `until`, per class. */
function sentBytes(d: readonly PortDeparture[], arrivals: readonly PortArrival[], until: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const x of d) if (x.end !== undefined && x.end <= until) out.set(x.cls, (out.get(x.cls) ?? 0) + arrivals[x.index]!.bytes);
  return out;
}

describe('link/qos/scheduler: CBWFQ by DRR (§3.11, accept.p3.qos-cbwfq)', () => {
  it('two saturated bandwidth classes share a 128 kb/s link 2:1 ± 5 %', () => {
    const spec: EgressSchedulerSpec = {
      policy: 'CB',
      refBps: 128_000,
      classes: [cls('GOLD', 'bandwidth', 64), cls('SILVER', 'bandwidth', 32), cls('class-default', 'default', 32)],
    };
    const arrivals: PortArrival[] = [];
    // each class offers 128 kb/s of 1000-byte frames: the link is overloaded 2×
    for (let t = 0; t < 60 * SEC; t += 62_500_000) {
      arrivals.push({ at: t, bytes: 1000, qosClass: 0 });
      arrivals.push({ at: t + 1, bytes: 1000, qosClass: 1 });
    }
    const d = simulatePortScheduler(spec, arrivals, 128_000);
    const bytes = sentBytes(d, arrivals, 60 * SEC);
    const ratio = bytes.get(0)! / bytes.get(1)!;
    expect(ratio).toBeGreaterThan(1.9);
    expect(ratio).toBeLessThan(2.1);
    // the link was never idle once both queues filled: about 60 s of line rate went out
    expect(bytes.get(0)! + bytes.get(1)!).toBeGreaterThan(((128_000 / 8) * 60) - 3000);
    // overloaded classes tail-drop at their limit, with the detail of §3.11
    const drop = d.find((x) => x.dropped === 'queue-full' && x.cls === 1)!;
    expect(drop.detail).toBe('class SILVER is full (64 packets)');
  });

  it('the spec compiled from configuration gives the same split (weights from `bandwidth`)', () => {
    const ast = parseConfigText([
      'class-map match-all GOLD', ' match dscp af41', 'class-map match-all SILVER', ' match dscp af21',
      'policy-map CB', ' class GOLD', '  bandwidth 64', ' class SILVER', '  bandwidth 32',
      'interface Serial0/0/0', ' bandwidth 128', ' service-policy output CB',
    ].join('\n'));
    const egress = compileEgressScheduler(ast, 'Serial0/0/0', 128_000);
    expect(egress?.source === 'policy' && egress.admission.ok).toBe(true);
    const arrivals: PortArrival[] = [];
    for (let t = 0; t < 30 * SEC; t += 62_500_000) arrivals.push({ at: t, bytes: 1000, qosClass: 0 }, { at: t, bytes: 1000, qosClass: 1 });
    const bytes = sentBytes(simulatePortScheduler(egress!.spec, arrivals, 128_000), arrivals, 30 * SEC);
    const ratio = bytes.get(0)! / bytes.get(1)!;
    expect(ratio).toBeGreaterThan(1.9);
    expect(ratio).toBeLessThan(2.1);
  });
});

describe('link/qos/scheduler: LLQ, the priority-queue bound (§3.11, accept.p3.qos-llq)', () => {
  const RATE = 128_000;
  const llq: EgressSchedulerSpec = {
    policy: 'WAN-EDGE',
    refBps: RATE,
    classes: [cls('VOICE', 'priority', 32, { rateBps: 32_000 }), cls('class-default', 'default', 96, { fairQueue: true })],
  };
  /** Voice: 64-byte frames every `voicePeriodNs` (1 ms after the data grid); data: 1004-byte frames every 40 ms. */
  const traffic = (voicePeriodNs: number, seconds: number): PortArrival[] => {
    const a: PortArrival[] = [];
    for (let t = 0; t < seconds * SEC; t += voicePeriodNs) a.push({ at: t + MS, bytes: 64, qosClass: 0 });
    for (let t = 0; t < seconds * SEC; t += 40 * MS) a.push({ at: t, bytes: 1004, flow: 'bulk' });
    return a;
  };

  it('no voice drop; every voice wait ≤ one data serialisation; class-default tail-drops with its detail', () => {
    const arr = traffic(20 * MS, 20);
    const d = simulatePortScheduler(llq, arr, RATE);
    const voice = d.filter((x) => x.cls === 0);
    expect(voice.length).toBe(1000);
    expect(voice.every((x) => x.dropped === undefined)).toBe(true);
    const worst = Math.max(...voice.map((x) => x.waitNs!));
    expect(worst).toBeLessThanOrEqual(serializationNs(1004, RATE));
    expect(worst).toBeGreaterThan(0);
    const dataDrops = d.filter((x) => x.cls === 1 && x.dropped !== undefined);
    expect(dataDrops.length).toBeGreaterThan(0);
    expect(new Set(dataDrops.map((x) => `${x.dropped}: ${x.detail}`))).toEqual(new Set(['queue-full: class class-default is full (64 packets)']));
  });

  it('voice above its rate during congestion drops policed, with the §3.11 detail', () => {
    const d = simulatePortScheduler(llq, traffic(10 * MS, 10), RATE);
    const policed = d.filter((x) => x.cls === 0 && x.dropped === 'policed');
    expect(policed.length).toBeGreaterThan(0);
    expect(policed[0]!.detail).toBe('priority class VOICE is over its 32 kb/s');
    expect(qosPolicedDetail('VOICE', 'priority', 154_400)).toBe('priority class VOICE is over its 154400 b/s');
  });

  it('enqueue names the queue and its depth (the frameQueued event); classOf maps absent and out-of-range classes to class-default', () => {
    const s = createPortScheduler<string>(llq, 0);
    expect(s.enqueue({ item: 'd1', bytes: 1004 }, 0, true)).toEqual({ ok: true, cls: 1, queue: 'class-default', depth: 1 });
    expect(s.enqueue({ item: 'v1', bytes: 64, qosClass: 0 }, 0, true)).toEqual({ ok: true, cls: 0, queue: 'VOICE', depth: 1 });
    expect(s.enqueue({ item: 'd2', bytes: 1004, qosClass: 7 }, 0, true)).toEqual({ ok: true, cls: 1, queue: 'class-default', depth: 2 });
    expect([s.classOf(), s.classOf(-1), s.classOf(1.5), s.classOf(0)]).toEqual([1, 1, 1, 0]);
    expect(s.depth).toBe(3);
    const order: string[] = [];
    for (let r = s.dequeue(0); r.kind === 'packet'; r = s.dequeue(0)) order.push(`${r.queue}:${r.item}`);
    expect(order).toEqual(['VOICE:v1', 'class-default:d1', 'class-default:d2']);
    expect(s.dequeue(0)).toEqual({ kind: 'empty' });
    expect(qosQueueFullDetail(llq.classes[0]!)).toBe('priority class VOICE is full (64 packets)');
  });
});

describe('link/qos/scheduler: [S21] policing, conform and exceed counts (accept.p3.qos-police-shape)', () => {
  /** An exact reference bucket in bit·ns (BigInt): conform when it holds the packet's bits. */
  function reference(rateBps: number, burstBytes: number, packets: readonly { at: number; bytes: number }[]): ('conform' | 'exceed')[] {
    const cap = BigInt(burstBytes * 8) * 1_000_000_000n;
    let tokens = cap;
    let last = 0n;
    return packets.map(({ at, bytes }) => {
      const t = BigInt(at);
      tokens += (t - last) * BigInt(rateBps);
      if (tokens > cap) tokens = cap;
      last = t;
      const need = BigInt(bytes * 8) * 1_000_000_000n;
      if (tokens >= need) {
        tokens -= need;
        return 'conform';
      }
      return 'exceed';
    });
  }

  it('the policer counts conform and exceed exactly as a token bucket of the burst at the rate', () => {
    expect([qosPoliceBurstBytes(8000), qosPoliceBurstBytes(64_000), qosPoliceBurstBytes(1_000_000)]).toEqual([1500, 2000, 31_250]);
    for (const rate of [64_000, 1_544_000, 999_999_937]) {
      const next = lcg(rate % 1009);
      const packets: { at: number; bytes: number }[] = [];
      let t = 0;
      for (let i = 0; i < 20_000; i++) {
        const bytes = 64 + (next() % 1437);
        // offered at about twice the rate
        t += Math.floor((bytes * 8 * SEC) / (2 * rate)) + (next() % 1000);
        packets.push({ at: t, bytes });
      }
      // the default burst, capped so the fast rate's bucket empties within the run
      const burst = Math.min(qosPoliceBurstBytes(rate), 20_000);
      const p = createQosPolicer({ rateBps: rate, burstBytes: burst }, 0);
      const got = packets.map((x) => policeQosPacket(p, x.bytes, x.at));
      const want = reference(rate, burst, packets);
      expect(got).toEqual(want);
      expect(p.conform).toBe(want.filter((x) => x === 'conform').length);
      expect(p.exceed).toBe(want.filter((x) => x === 'exceed').length);
      expect(p.conform).toBeGreaterThan(0);
      expect(p.exceed).toBeGreaterThan(0);
      expect(p.conformBytes + p.exceedBytes).toBe(packets.reduce((a, x) => a + x.bytes, 0));
      // what conforms never exceeds burst + rate × time
      expect(BigInt(p.conformBytes * 8) <= BigInt(burst * 8) + (BigInt(rate) * BigInt(t)) / 1_000_000_000n).toBe(true);
    }
  });

  it('a class police in the spec drops exceeding frames `policed` before they queue, with matching counts', () => {
    const spec: EgressSchedulerSpec = {
      policy: 'EDGE',
      refBps: 1_000_000,
      classes: [cls('BULK', 'bandwidth', 500, { police: { rateBps: 64_000, burstBytes: 2000 } }), cls('class-default', 'default', 250)],
    };
    const arrivals: PortArrival[] = [];
    for (let t = 0; t < 10 * SEC; t += 62_500_000) arrivals.push({ at: t, bytes: 1000, qosClass: 0 });
    const d = simulatePortScheduler(spec, arrivals, 1_000_000);
    const want = reference(64_000, 2000, arrivals);
    expect(d.map((x) => (x.dropped === 'policed' ? 'exceed' : 'conform'))).toEqual(want);
    expect(d.find((x) => x.dropped === 'policed')!.detail).toBe('class BULK is over its police rate of 64 kb/s');
    // conform frames went out unqueued on the 1 Mb/s link
    expect(d.filter((x) => x.dropped === undefined).every((x) => x.waitNs === 0)).toBe(true);
    // the live scheduler's counters and view agree with the departures
    const s = createPortScheduler<number>(spec, 0);
    for (let i = 0; i < arrivals.length; i++) {
      s.enqueue({ item: i, bytes: 1000, qosClass: 0 }, arrivals[i]!.at, false);
      s.dequeue(arrivals[i]!.at);
    }
    const exceed = want.filter((x) => x === 'exceed').length;
    expect(s.policerStats()).toEqual([{ cls: 0, name: 'BULK', conform: arrivals.length - exceed, conformBytes: (arrivals.length - exceed) * 1000, exceed, exceedBytes: exceed * 1000 }]);
    const v = s.view(10 * SEC - 1).classes[0]!;
    expect([v.matched, v.matchedBytes, v.sent, v.policed, v.tailDrops, v.depth]).toEqual([arrivals.length, arrivals.length * 1000, arrivals.length - exceed, exceed, 0, 0]);
  });
});

describe('link/qos/scheduler: [S21] shaping (accept.p3.qos-police-shape)', () => {
  it('the shaper’s next-eligible time is exact; a frame larger than the bucket waits for a full one and is owed', () => {
    expect([qosShapeDefaultBcBits(64_000), qosShapeDefaultBcBits(2_000_000), qosShapeDefaultBcBits(1)]).toEqual([6400, 200_000, 1]);
    const s = createQosShaper(64_000, 8000, 0);
    expect(qosShaperEligibleAt(s, 8000, 0)).toBe(0);
    qosShaperSend(s, 8000, 0);
    // empty bucket: 4000 bits take 62.5 ms at 64 kb/s
    expect(qosShaperEligibleAt(s, 4000, 0)).toBe(62_500_000);
    expect(qosShaperEligibleAt(s, 4000, 70_000_000)).toBe(70_000_000);
    const big = createQosShaper(64_000, 8000, 0);
    qosShaperSend(big, 12_000, 0); // 1500 bytes > the 1000-byte bucket: sent when full, 4000 bits owed
    // the next 4000 bits: the debt (62.5 ms) plus their own 62.5 ms
    expect(qosShaperEligibleAt(big, 4000, 0)).toBe(125_000_000);
    // a frame larger than the bucket waits for a full bucket: 187.5 ms
    expect(qosShaperEligibleAt(big, 12_000, 0)).toBe(187_500_000);
    expect(() => createQosShaper(0, 8000, 0)).toThrow(RangeError);
    expect(() => qosShaperEligibleAt(s, 0, 0)).toThrow(RangeError);
  });

  it('no drift: the eligible times equal the exact rational schedule (BigInt reference)', () => {
    for (const rate of [7_919, 64_000, 1_544_000, 999_999_937, 10_000_000_000]) {
      const next = lcg(rate % 1013);
      const bc = 1 + (next() % 100_000);
      const s = createQosShaper(rate, bc, 0);
      // reference TAT as a fraction tatNum / rate (ns)
      let tatNum = 0n;
      const R = BigInt(rate);
      let now = 0;
      for (let i = 0; i < 5000; i++) {
        const bits = 8 * (64 + (next() % 1437));
        now += next() % 2_000_000;
        const slack = BigInt(bc - Math.min(bits, bc));
        // eligible = ceil(TAT − slack × 10^9 / rate)
        const num = tatNum - slack * 1_000_000_000n;
        const ceil = num >= 0n ? (num + R - 1n) / R : -((-num) / R);
        const want = Number(ceil) > now ? Number(ceil) : now;
        const got = qosShaperEligibleAt(s, bits, now);
        expect(got).toBe(want);
        now = got;
        // send: TAT = max(TAT, now) + bits × 10^9 / rate
        const base = tatNum > BigInt(now) * R ? tatNum : BigInt(now) * R;
        tatNum = base + BigInt(bits) * 1_000_000_000n;
        qosShaperSend(s, bits, now);
        expect(BigInt(s.tat) * R + BigInt(s.rem)).toBe(tatNum);
      }
    }
  });

  it('a burst below the queue limit is delayed to the shaped rate without a drop', () => {
    const RATE = 64_000;
    const spec: EgressSchedulerSpec = { policy: 'SHAPE', refBps: 1_000_000, classes: [cls('class-default', 'default', 1000)], shapeBps: RATE, shapeBcBits: 8000 };
    const arrivals: PortArrival[] = [];
    for (let i = 0; i < 50; i++) arrivals.push({ at: 0, bytes: 500 });
    const d = simulatePortScheduler(spec, arrivals, 1_000_000);
    expect(d.every((x) => x.dropped === undefined && x.start !== undefined)).toBe(true);
    // the exact schedule: start_i = max(previous end, the first ns the bucket holds 4000 bits)
    let end = 0;
    let cum = 0n;
    for (const x of d) {
      cum += 4000n;
      const need = cum - 8000n;
      const eligible = need <= 0n ? 0 : Number((need * 1_000_000_000n + 63_999n) / 64_000n);
      const start = Math.max(end, eligible);
      expect(x.start).toBe(start);
      end = start + serializationNs(500, 1_000_000);
    }
    // 50 × 4000 bits at 64 kb/s ≈ 3 s, not the 0.2 s of the 1 Mb/s line
    expect(d[49]!.start!).toBe(Math.ceil(((50 * 4000 - 8000) * SEC) / RATE));
  });

  it('above the limit only the excess drops queue-full; the held frame counts in the view until it leaves', () => {
    const spec: EgressSchedulerSpec = { policy: 'SHAPE', refBps: 1_000_000, classes: [cls('class-default', 'default', 1000)], shapeBps: 64_000, shapeBcBits: 8000 };
    const burst: PortArrival[] = [];
    for (let i = 0; i < 100; i++) burst.push({ at: 0, bytes: 500 });
    const d = simulatePortScheduler(spec, burst, 1_000_000);
    expect(d.filter((x) => x.dropped === 'queue-full').length).toBe(100 - QOS_DEFAULT_QUEUE_LIMIT);
    expect(d.slice(0, QOS_DEFAULT_QUEUE_LIMIT).every((x) => x.dropped === undefined)).toBe(true);
    const s = createPortScheduler<number>(spec, 0);
    for (let i = 0; i < 3; i++) s.enqueue({ item: i, bytes: 1000 }, 0, false);
    expect(s.dequeue(0)).toEqual({ kind: 'packet', item: 0, bytes: 1000, cls: 0, queue: 'class-default' });
    // the bucket is empty: the next frame is held until the shaper allows it
    expect(s.dequeue(1)).toEqual({ kind: 'wait', at: 125_000_000 });
    expect(s.depth).toBe(2);
    expect(s.view(1).classes[0]).toMatchObject({ depth: 2, sent: 1, matched: 3 });
    expect(s.dequeue(125_000_000)).toMatchObject({ kind: 'packet', item: 1 });
    expect(s.view(125_000_000).classes[0]).toMatchObject({ depth: 1, sent: 2 });
    // drain: every held frame, never counted as sent
    expect(s.drain()).toEqual([2]);
    expect(s.depth).toBe(0);
    expect(s.view(125_000_000).classes[0]).toMatchObject({ depth: 0, sent: 2, matched: 3 });
    expect(s.dequeue(SEC)).toEqual({ kind: 'empty' });
  });
});

describe('link/qos/scheduler: the queue view, WFQ flows and admission', () => {
  it('reports the 30-second offered rate per class over whole sim-time seconds', () => {
    const spec: EgressSchedulerSpec = { policy: 'P', refBps: 1_000_000, classes: [cls('A', 'bandwidth', 500), cls('class-default', 'default', 250, { fairQueue: true })] };
    const s = createPortScheduler<number>(spec, 0);
    for (let k = 0; k < 400; k++) {
      s.enqueue({ item: k, bytes: 1000, qosClass: 0 }, k * 100 * MS, false);
      s.dequeue(k * 100 * MS);
    }
    const v = s.view(39_950 * MS);
    expect(v).toMatchObject({ policy: 'P', strategy: 'class-based', refBps: 1_000_000 });
    expect(v.classes[0]).toEqual({ name: 'A', kind: 'bandwidth', depth: 0, limit: 64, matched: 400, matchedBytes: 400_000, sent: 400, tailDrops: 0, policed: 0, offeredBps30s: 80_000 });
    expect(v.classes[1]).toEqual({ name: 'class-default', kind: 'default', depth: 0, limit: 64, matched: 0, matchedBytes: 0, sent: 0, tailDrops: 0, policed: 0, offeredBps30s: 0, flows: 0 });
    // the window slides: 25 s later only the last 5 s of offers are inside it
    expect(s.view(64_950 * MS).classes[0]!.offeredBps30s).toBe(Math.floor((50 * 1000 * 8) / 30));
    expect(s.view(80 * SEC).classes[0]!.offeredBps30s).toBe(0);
    // interface fair-queue has no policy name
    const fair = createPortScheduler<number>({ policy: '', refBps: 64_000, classes: [cls('class-default', 'default', 64, { fairQueue: true })] }, 0);
    expect(fair.view(0)).toMatchObject({ strategy: 'fair', refBps: 64_000 });
    expect('policy' in fair.view(0)).toBe(false);
  });

  it('qosFlowOf: one flow per IPv4 5-tuple, weighted by IP precedence + 1; frames without IP share one flow', () => {
    const f = createPduFactory();
    const meta = { born: 0, origin: 'R1' as const };
    const eth: LayerSpec = { proto: 'ethernet', fields: { dst: '00:50:79:66:68:02', src: '00:50:79:66:68:01', type: ETHERTYPE_IPV4 } };
    const pkt = (sport: number, dscp: number) =>
      f.build([eth, { proto: 'ipv4', fields: { src: '10.0.0.1', dst: '10.0.0.2', protocol: 17, ttl: 64, dscp } }, { proto: 'udp', fields: { srcPort: sport, dstPort: 9 } }], meta);
    expect(qosFlowOf(pkt(5000, 0))).toEqual({ flow: '4|17|10.0.0.1|5000|10.0.0.2|9', flowWeight: 1 });
    expect(qosFlowOf(pkt(5001, 46))).toEqual({ flow: '4|17|10.0.0.1|5001|10.0.0.2|9', flowWeight: 6 });
    const arp = f.build([{ ...eth, fields: { ...eth.fields, type: ETHERTYPE_ARP } }, { proto: 'arp', fields: { op: 1, sha: '00:50:79:66:68:01', spa: '10.0.0.1', tha: '00:00:00:00:00:00', tpa: '10.0.0.2' } }], meta);
    expect(qosFlowOf(arp)).toEqual({ flow: '', flowWeight: 1 });
  });

  it('WFQ in class-default: flows share it equally whatever their frame sizes', () => {
    const spec: EgressSchedulerSpec = { policy: 'W', refBps: 128_000, classes: [cls('class-default', 'default', 128, { fairQueue: true, queueLimit: 0 })] };
    const arrivals: PortArrival[] = [];
    for (let t = 0; t < 20 * SEC; t += 50 * MS) arrivals.push({ at: t, bytes: 1500, flow: 'big' }, { at: t, bytes: 300, flow: 'small' }, { at: t, bytes: 300, flow: 'small' }, { at: t, bytes: 300, flow: 'small' });
    const d = simulatePortScheduler(spec, arrivals, 128_000);
    const by = new Map<string, number>();
    for (const x of d) if (x.end !== undefined && x.end <= 20 * SEC) by.set(arrivals[x.index]!.flow!, (by.get(arrivals[x.index]!.flow!) ?? 0) + arrivals[x.index]!.bytes);
    const r = by.get('big')! / by.get('small')!;
    expect(r).toBeGreaterThan(0.95);
    expect(r).toBeLessThan(1.05);
  });

  it('admission: ok iff the reservations ask at most 75 % of the reference rate (exact)', () => {
    expect(egressAdmission(128_000, [32_000])).toEqual({ ok: true, askedBps: 32_000, refBps: 128_000, limitBps: 96_000, askedKbps: 32, refKbps: 128 });
    expect(egressAdmission(128_000, [64_000, 32_000]).ok).toBe(true);
    expect(egressAdmission(128_000, [64_000, 32_001])).toMatchObject({ ok: false, askedKbps: 97 });
    expect(egressAdmission(1_544_000, [1_158_000]).ok).toBe(true);
    expect(egressAdmission(1_544_000, [1_158_001]).ok).toBe(false);
    expect(egressAdmission(0, []).ok).toBe(true);
    expect(egressAdmission(0, [1]).ok).toBe(false);
  });

  it('is deterministic: the same arrivals give the same departures', () => {
    const spec: EgressSchedulerSpec = {
      policy: 'ALL',
      refBps: 256_000,
      classes: [cls('VOICE', 'priority', 64, { rateBps: 64_000 }), cls('GOLD', 'bandwidth', 64, { police: { rateBps: 96_000, burstBytes: 3000 } }), cls('class-default', 'default', 64, { fairQueue: true })],
      shapeBps: 200_000,
      shapeBcBits: 20_000,
    };
    const next = lcg(7);
    const arrivals: PortArrival[] = [];
    for (let i = 0; i < 3000; i++) arrivals.push({ at: (next() % (10 * SEC)), bytes: 64 + (next() % 1437), qosClass: next() % 3, flow: `f${next() % 5}` });
    const once = simulatePortScheduler(spec, arrivals, 256_000);
    expect(simulatePortScheduler(spec, arrivals, 256_000)).toEqual(once);
    expect(once.filter((x) => x.dropped === undefined).length + once.filter((x) => x.dropped !== undefined).length).toBe(3000);
  });
});

describe('link/qos/: integer discipline (§4.5)', () => {
  it('uses no floating-point maths, exponentiation, randomness or clocks', () => {
    const BANNED = /Math\.(log10|log2|log|pow|exp|random)\s*\(|Date\.now|performance\.now|new Date\(|setTimeout|[\w)\]]\s*\*\*\s*[\w(]/;
    expect(readFileSync(new URL('../src/link/qos/scheduler.ts', import.meta.url), 'utf8')).not.toMatch(BANNED);
  });
});
