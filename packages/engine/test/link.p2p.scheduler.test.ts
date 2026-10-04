/**
 * link.p2p.scheduler — the [S20]/[S21] held queue of a cable scheduler port (ARCHITECTURE-P3 D16, §3.11, §4.2; §7 W3
 * media; link/media/p2p.ts, link/link.ts `egressQueues`, `onMediumTimer` 'qos:', `onPortChanged`).
 *
 * The device runtime is a FAKE: `LinkModelDeps.egressPolicy` reads `egressPolicy(port)` of a hand-built runtime per
 * device (the contract the W3 device item implements), exactly as the Simulation's wiring forwards it. The link is a
 * crossover cable capped at 128 kb/s (`impairments.bandwidthBps`), so a 1000-byte payload takes ≈ 66 ms to serialise.
 *
 * Cases: LLQ first; the 2:1 CBWFQ share within 5 %; queue-limit tail drops with their reason; shaping without drops
 * below the limit (the `qos:` gate); `frameQueued` then `frameTx` (the wait chip); no `frameQueued` on an uncongested
 * port; plus the five draws at dequeue, LLQ policing, parity with `simulatePortScheduler`, link-down, policy removal and
 * replacement, the display view, and the virtual FIFO byte for byte on a port without a policy.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceRuntime } from '../src/contracts/device.js';
import type { DeviceId, PduId, PortId, PortRef } from '../src/contracts/ids.js';
import { portKey } from '../src/contracts/ids.js';
import type { EgressClassSpec, EgressSchedulerSpec, Impairments, LinkModelDeps, TransmitResult, TxOutcome } from '../src/contracts/link.js';
import { MEDIA, NO_IMPAIRMENTS } from '../src/contracts/link.js';
import type { Pdu } from '../src/contracts/pdu.js';
import { ETH_PHY_OVERHEAD, ETHERTYPE_IPV4 } from '../src/contracts/pdu.js';
import type { PortState } from '../src/contracts/port.js';
import { SPEED_100M, emptyCounters } from '../src/contracts/port.js';
import { MS, SEC, propagationNs, serializationNs, type SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createRng } from '../src/core/prng.js';
import { createScheduler } from '../src/core/scheduler.js';
import { createLinkModel } from '../src/link/link.js';
import { QOS_MEDIUM_PREFIX, QOS_SHAPER_TIMER_KEY, corruptionWindow, qosMediumId, samePlainValue } from '../src/link/media/p2p.js';
import { QOS_DEFAULT_QUEUE_LIMIT, qosFlowOf, simulatePortScheduler, type PortArrival } from '../src/link/qos/scheduler.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { meta } from './link.segment.harness.js';
import { INERT_LINK_DEPS, testPortSpec } from './port.fixtures.js';

const RATE = 128_000;
const MAC_A = '02:00:00:00:00:0a';
const MAC_B = '02:00:00:00:00:0b';
const PROP = propagationNs(3, MEDIA['copper-crossover'].velocityFactor);

const cls = (name: string, kind: EgressClassSpec['kind'], weightKbps: number, extra: Partial<EgressClassSpec> = {}): EgressClassSpec => ({
  name,
  kind,
  weightKbps,
  queueLimit: QOS_DEFAULT_QUEUE_LIMIT,
  ...extra,
});

/** §3.11: VOICE priority 32 kb/s, class-default (FIFO, or [S21] fair-queue). */
const llq = (fairQueue = false): EgressSchedulerSpec => ({
  policy: 'WAN-EDGE',
  refBps: RATE,
  classes: [cls('VOICE', 'priority', 32, { rateBps: 32_000 }), cls('class-default', 'default', 96, fairQueue ? { fairQueue: true } : {})],
});

/** CBWFQ: GOLD 64 kb/s, SILVER 32 kb/s, class-default the rest. */
const cbwfq = (): EgressSchedulerSpec => ({
  policy: 'CB',
  refBps: RATE,
  classes: [cls('GOLD', 'bandwidth', 64), cls('SILVER', 'bandwidth', 32), cls('class-default', 'default', 32)],
});

type FakeRuntime = Pick<DeviceRuntime, 'egressPolicy'>;
type Offer = { readonly at: SimTime; readonly pdu: Pdu; readonly qosClass?: number };
type FrameTx = Extract<TraceEvent, { kind: 'frameTx' }>;
type FrameQueued = Extract<TraceEvent, { kind: 'frameQueued' }>;
type Drop = Extract<TraceEvent, { kind: 'drop' }>;

interface HarnessOptions {
  /** The output policy of d_a Gi0 (undefined = no policy: the fake runtime answers undefined). */
  spec?: EgressSchedulerSpec;
  /** false: the deps carry no `egressPolicy` at all (a P1/P2 Simulation before the wiring). Default true. */
  wired?: boolean;
  impairments?: Partial<Impairments>;
  seed?: number;
}

function harness(opts: HarnessOptions = {}) {
  const ports = new Map<string, PortState>();
  const scheduler = createScheduler();
  const pdus = createPduFactory();
  const trace: TraceEvent[] = [];
  const outcomes: { ref: PortRef; outcome: TxOutcome; now: SimTime }[] = [];
  const results = new Map<PduId, TransmitResult>();
  /** Every `mediumTimer` dispatched (the [S21] shaper gates). */
  const timers: { medium: string; key: string; at: SimTime; periodic: boolean }[] = [];
  const policies = new Map<string, EgressSchedulerSpec | undefined>();
  const policyCalls: string[] = [];
  /** The fake device runtimes: `egressPolicy(port)` answers what the test configured, and records each call. */
  const runtimes = new Map<DeviceId, FakeRuntime>();
  const runtime = (device: DeviceId): FakeRuntime => ({
    egressPolicy(port: PortId) {
      policyCalls.push(`${device}/${port}`);
      return policies.get(`${device}/${port}`);
    },
  });
  runtimes.set('d_a', runtime('d_a'));
  runtimes.set('d_b', runtime('d_b'));
  const deps: LinkModelDeps = {
    ...INERT_LINK_DEPS,
    scheduler,
    trace: { emit: (e) => trace.push(e) },
    rng: createRng(opts.seed ?? 7).split('links'),
    port: (ref) => ports.get(portKey(ref)),
    deviceUp: () => true,
    pdus,
    onTxOutcome: (ref, outcome, now) => outcomes.push({ ref: { ...ref }, outcome, now }),
    ...(opts.wired === false ? {} : { egressPolicy: (ref: PortRef) => runtimes.get(ref.device)?.egressPolicy?.(ref.port) }),
  };
  const add = (device: DeviceId, name: PortId, mac: string): PortRef => {
    const ref: PortRef = { device, port: name };
    ports.set(portKey(ref), {
      id: name,
      spec: testPortSpec({ name, short: name, kind: 'ethernet', speedBps: SPEED_100M, role: 'routed' }),
      mac,
      adminUp: true,
      operUp: false,
      mtu: 1500,
      counters: emptyCounters(),
      l3: {},
      tx: { busyUntil: 0, queue: 0 },
      role: 'routed',
      ordinal: 1,
      encap: 'ethernet',
    });
    return ref;
  };
  const a = add('d_a', 'Gi0', MAC_A);
  const b = add('d_b', 'Gi0', MAC_B);
  if (opts.spec !== undefined) policies.set(portKey(a), opts.spec);
  const model = createLinkModel(deps);
  model.add({ id: 'l_1', a, b, media: 'copper-crossover', lengthM: 3, impairments: { ...NO_IMPAIRMENTS, bandwidthBps: RATE, ...opts.impairments } }, 0);
  trace.length = 0; // the cable-up events

  /** A UDP datagram a → b with `payload` bytes, DSCP `dscp`, from source port `srcPort`. */
  const frame = (payload: number, dscp = 0, srcPort = 5000): Pdu =>
    pdus.build(
      [
        { proto: 'ethernet', fields: { dst: MAC_B, src: MAC_A, type: ETHERTYPE_IPV4 } },
        { proto: 'ipv4', fields: { src: '10.0.0.1', dst: '10.0.0.2', protocol: 17, dscp } },
        { proto: 'udp', fields: { srcPort, dstPort: 9 } },
        { proto: 'payload', fields: { data: new Uint8Array(payload) } },
      ],
      meta(),
    );

  const dispatch = (): void => {
    const ev = scheduler.next()!;
    if (ev.kind === 'txComplete') model.onTxComplete({ device: ev.device, port: ev.port }, ev.at);
    else if (ev.kind === 'frameArrival') model.admit(ev, ev.at);
    else if (ev.kind === 'mediumTimer') {
      timers.push({ medium: ev.medium, key: ev.key, at: ev.at, periodic: 'periodic' in ev });
      model.onMediumTimer(ev.medium, ev.key, ev.at);
    }
    else throw new Error(`unexpected event ${ev.kind}`);
  };

  /**
   * Offer `offers` on d_a Gi0 at their times and dispatch every event up to `until`. At equal times the offers go first
   * (as `simulatePortScheduler` offers every arrival due before it dequeues).
   */
  const play = (offers: readonly Offer[], until: SimTime): void => {
    const list = offers.map((o, i) => [o, i] as const).sort((x, y) => x[0].at - y[0].at || x[1] - y[1]).map(([o]) => o);
    let i = 0;
    for (;;) {
      const nextEv = scheduler.peekTime();
      const nextOffer = i < list.length ? list[i]!.at : Number.POSITIVE_INFINITY;
      if (nextOffer <= until && (nextEv === undefined || nextOffer <= nextEv)) {
        if (scheduler.now < nextOffer) scheduler.advanceTo(nextOffer);
        const o = list[i++]!;
        results.set(o.pdu.id, model.transmit(a, o.pdu, o.at, o.qosClass === undefined ? undefined : { qosClass: o.qosClass }));
        continue;
      }
      if (nextEv === undefined || nextEv > until) break;
      dispatch();
    }
    if (scheduler.now < until) scheduler.advanceTo(until);
  };

  const of = <K extends TraceEvent['kind']>(kind: K): Extract<TraceEvent, { kind: K }>[] =>
    trace.filter((e): e is Extract<TraceEvent, { kind: K }> => e.kind === kind);
  const txOf = (id: PduId): FrameTx | undefined => of('frameTx').find((e) => e.pdu.id === id);
  const port = (ref: PortRef): PortState => ports.get(portKey(ref))!;
  return { model, scheduler, pdus, trace, outcomes, results, timers, policies, policyCalls, a, b, frame, play, of, txOf, port };
}

/** Serialisation of a frame on the 128 kb/s test link. */
const ser = (pdu: Pdu): number => serializationNs(pdu.size + ETH_PHY_OVERHEAD, RATE);

describe('link/media/p2p held queue: LLQ first, and the wait chip (§3.11 steps 2–3)', () => {
  it('voice queued behind data leaves first at the next txComplete; held frames answer deferred and report sent', () => {
    const h = harness({ spec: llq() });
    const d1 = h.frame(1000);
    const d2 = h.frame(1000);
    const d3 = h.frame(1000);
    const v1 = h.frame(160, 46, 16384);
    h.play([{ at: 0, pdu: d1 }, { at: MS, pdu: d2 }, { at: MS, pdu: d3 }, { at: 2 * MS, pdu: v1, qosClass: 0 }], 2 * SEC);

    // order on the wire: the frame already sent, then VOICE, then class-default in arrival order
    expect(h.of('frameTx').map((e) => e.pdu.id)).toEqual([d1.id, v1.id, d2.id, d3.id]);
    const t1 = h.txOf(d1.id)!;
    expect(t1.txStart).toBe(0);
    const tv = h.txOf(v1.id)!;
    expect(tv.txStart).toBe(t1.txEnd); // the priority queue is served at the data frame's txComplete
    expect(tv.t).toBe(tv.txStart); // committed at dequeue: frameTx at the start of serialisation
    expect(tv.txStart - 2 * MS).toBeLessThanOrEqual(ser(d1)); // waits at most one data serialisation
    expect(h.txOf(d2.id)!.txStart).toBe(tv.txEnd);
    expect(h.txOf(d3.id)!.txStart).toBe(h.txOf(d2.id)!.txEnd);

    // the idle port sent d1 at once with the FIFO's own result; the others were held
    const r1 = h.results.get(d1.id)!;
    expect(r1).toEqual({ ok: true, link: 'l_1', txStart: 0, txEnd: t1.txEnd, arrive: t1.arrive });
    for (const [p, at] of [[d2, MS], [d3, MS], [v1, 2 * MS]] as const) {
      expect(h.results.get(p.id)).toEqual({ ok: true, link: 'l_1', txStart: at, txEnd: at, arrive: at, deferred: true });
    }
    // counters arrive through TxOutcome sent, once per held frame, never for the frame that left at once
    expect(h.outcomes.map((o) => o.outcome)).toEqual([
      { kind: 'sent', pdu: v1.id, txStart: tv.txStart, bytes: v1.size },
      { kind: 'sent', pdu: d2.id, txStart: h.txOf(d2.id)!.txStart, bytes: d2.size },
      { kind: 'sent', pdu: d3.id, txStart: h.txOf(d3.id)!.txStart, bytes: d3.size },
    ]);
    expect(h.outcomes.every((o) => o.ref.device === 'd_a' && o.ref.port === 'Gi0')).toBe(true);
    // every frame arrived (admit pruned the legs)
    expect(h.model.__flyingSize()).toBe(0);
  });

  it('frameQueued {queue, depth} then frameTx: the wait chip, in trace order', () => {
    const h = harness({ spec: llq() });
    const d1 = h.frame(1000);
    const d2 = h.frame(1000);
    const d3 = h.frame(1000);
    const v1 = h.frame(160, 46, 16384);
    h.play([{ at: 0, pdu: d1 }, { at: MS, pdu: d2 }, { at: MS, pdu: d3 }, { at: 2 * MS, pdu: v1, qosClass: 0 }], 2 * SEC);
    const queued = h.of('frameQueued');
    expect(queued).toEqual([
      { t: MS, kind: 'frameQueued', pdu: h.txOf(d2.id)!.pdu, device: 'd_a', port: 'Gi0', queue: 'class-default', depth: 1 },
      { t: MS, kind: 'frameQueued', pdu: h.txOf(d3.id)!.pdu, device: 'd_a', port: 'Gi0', queue: 'class-default', depth: 2 },
      { t: 2 * MS, kind: 'frameQueued', pdu: h.txOf(v1.id)!.pdu, device: 'd_a', port: 'Gi0', queue: 'VOICE', depth: 1 },
    ] satisfies FrameQueued[]);
    for (const q of queued) {
      const qi = h.trace.indexOf(q);
      const tx = h.txOf(q.pdu.id)!;
      expect(h.trace.indexOf(tx)).toBeGreaterThan(qi);
      expect(tx.txStart).toBeGreaterThan(q.t); // the wait: frameQueued.t → frameTx.txStart
    }
    expect(h.txOf(v1.id)!.txStart - 2 * MS).toBe(h.txOf(d1.id)!.txEnd - 2 * MS); // "waited 64 ms in VOICE (priority)"
  });
});

describe('link/media/p2p held queue: an uncongested port, and the virtual FIFO byte for byte', () => {
  /** Frames 100 ms apart (each takes ≈ 66 ms): the transmitter is always free when the next arrives. */
  const spaced = (h: ReturnType<typeof harness>): Offer[] => {
    const out: Offer[] = [];
    for (let i = 0; i < 12; i++) out.push({ at: i * 100 * MS + 3, pdu: h.frame(1000, i % 3 === 0 ? 46 : 0, 5000 + i), ...(i % 3 === 0 ? { qosClass: 0 } : {}) });
    return out;
  };
  const lossy: Partial<Impairments> = { lossPct: 20, jitterNs: 50_000, corruptPct: 10 };

  it('no frameQueued, no deferral, no outcome: each frame leaves at once with the FIFO result', () => {
    const h = harness({ spec: llq(), impairments: lossy });
    const offers = spaced(h);
    h.play(offers, 3 * SEC);
    expect(h.of('frameQueued')).toEqual([]);
    expect(h.outcomes).toEqual([]);
    for (const o of offers) {
      const r = h.results.get(o.pdu.id)!;
      expect(r.ok && r.deferred).toBe(undefined);
      expect(r.ok && r.txStart).toBe(o.at);
    }
    // the scheduler still counted them (display), every one sent
    const view = h.model.egressQueues!(h.a)!;
    expect(view.classes.map((c) => [c.name, c.matched, c.sent, c.depth])).toEqual([
      ['VOICE', 4, 4, 0],
      ['class-default', 8, 8, 0],
    ]);
  });

  it('an uncongested scheduler port and a FIFO port write the same trace and results, draw for draw', () => {
    const traces: string[] = [];
    for (const spec of [llq(), undefined]) {
      const h = harness({ ...(spec === undefined ? {} : { spec }), impairments: lossy, seed: 11 });
      h.play(spaced(h), 3 * SEC);
      traces.push(JSON.stringify([h.trace, [...h.results]]));
    }
    expect(traces[0]).toBe(traces[1]);
  });

  it('a port without a policy keeps the virtual FIFO byte for byte: unwired deps, and a runtime that answers undefined', () => {
    const runs = [false, true].map((wired) => {
      const h = harness({ wired, impairments: lossy, seed: 5 });
      // a congested burst: the FIFO commits every frame at enqueue with a future txStart
      const offers: Offer[] = [];
      for (let i = 0; i < 40; i++) offers.push({ at: i * 10 * MS, pdu: h.frame(600 + i, i % 2 === 0 ? 46 : 0), qosClass: i % 2 });
      h.play(offers.filter((o) => o.at <= 200 * MS), 200 * MS);
      const backlog = h.model.queued(h.a, 200 * MS).length;
      h.play(offers.filter((o) => o.at > 200 * MS), 5 * SEC);
      return { trace: JSON.stringify(h.trace), results: JSON.stringify([...h.results]), backlog, outcomes: h.outcomes.length, calls: h.policyCalls.length };
    });
    expect(runs[0]!.trace).toBe(runs[1]!.trace);
    expect(runs[0]!.results).toBe(runs[1]!.results);
    expect(runs[0]!.outcomes).toBe(0);
    expect(runs[1]!.outcomes).toBe(0);
    expect(runs[0]!.backlog).toBeGreaterThan(5); // congested: the FIFO's own backlog
    expect(runs[1]!.backlog).toBe(runs[0]!.backlog);
    expect(runs[0]!.calls).toBe(0); // unwired: no lookup at all
    expect(runs[1]!.calls).toBeGreaterThan(0); // wired: looked up, answered undefined, nothing changed
    // no frameQueued in either; the FIFO's own backlog view is unchanged
    expect(runs[0]!.trace).not.toContain('frameQueued');
  });
});

describe('link/media/p2p held queue: CBWFQ, queue limits and policing', () => {
  it('two saturated bandwidth classes share the link 2:1 ± 5 %, and both tail-drop at their limit', () => {
    const h = harness({ spec: cbwfq() });
    const offers: Offer[] = [];
    const classOf = new Map<PduId, number>();
    // each class offers ≈ 128 kb/s of 1000-byte payloads: the link is overloaded 2×
    for (let t = 0; t < 30 * SEC; t += 65 * MS) {
      for (const c of [0, 1]) {
        const pdu = h.frame(1000, c === 0 ? 34 : 18, 6000 + c);
        classOf.set(pdu.id, c);
        offers.push({ at: t + c, pdu, qosClass: c });
      }
    }
    h.play(offers, 30 * SEC);
    const bytes = [0, 0];
    let busy = 0;
    for (const tx of h.of('frameTx')) {
      if (tx.txEnd > 30 * SEC) continue;
      bytes[classOf.get(tx.pdu.id)!]! += tx.pdu.size;
      busy += tx.txEnd - tx.txStart;
    }
    const ratio = bytes[0]! / bytes[1]!;
    expect(ratio).toBeGreaterThan(1.9);
    expect(ratio).toBeLessThan(2.1);
    // the link never idled once both queues filled: about 30 s of line rate went out
    expect(busy).toBeGreaterThan(29.8 * SEC);
    const details = new Set(h.of('drop').map((d) => `${d.reason}|${d.detail}|${d.device}|${d.port}`));
    expect(details).toEqual(new Set(['queue-full|class GOLD is full (64 packets)|d_a|Gi0', 'queue-full|class SILVER is full (64 packets)|d_a|Gi0']));
  });

  it('a queue-limit tail drop is refused queue-full with its detail, draws nothing, and the view counts it', () => {
    const spec: EgressSchedulerSpec = { policy: 'SMALL', refBps: RATE, classes: [cls('class-default', 'default', 128, { queueLimit: 5 })] };
    const h = harness({ spec, impairments: { jitterNs: 10_000 }, seed: 3 });
    const burst = Array.from({ length: 10 }, () => h.frame(500));
    h.play(burst.map((pdu) => ({ at: 0, pdu })), 0);
    // one on the wire, five held, four refused
    expect(burst.map((p) => {
      const r = h.results.get(p.id)!;
      return r.ok ? (r.deferred === true ? 'held' : 'sent') : r.reason;
    })).toEqual(['sent', 'held', 'held', 'held', 'held', 'held', 'queue-full', 'queue-full', 'queue-full', 'queue-full']);
    const drops = h.of('drop');
    expect(drops).toHaveLength(4);
    for (const [i, d] of drops.entries()) {
      expect(d).toEqual({ t: 0, kind: 'drop', pdu: expect.objectContaining({ id: burst[6 + i]!.id }), device: 'd_a', port: 'Gi0', reason: 'queue-full', detail: 'class class-default is full (5 packets)' } satisfies Drop);
    }
    expect(h.of('frameQueued').map((q) => q.depth)).toEqual([1, 2, 3, 4, 5]);
    let view = h.model.egressQueues!(h.a)!;
    expect(view).toMatchObject({ policy: 'SMALL', strategy: 'class-based', refBps: RATE });
    expect(view.classes[0]).toMatchObject({ name: 'class-default', kind: 'default', depth: 5, limit: 5, matched: 10, sent: 1, tailDrops: 4, policed: 0 });

    h.play([], 2 * SEC);
    view = h.model.egressQueues!(h.a)!;
    expect(view.classes[0]).toMatchObject({ depth: 0, matched: 10, sent: 6, tailDrops: 4 });
    expect(h.of('frameTx').map((e) => e.pdu.id)).toEqual(burst.slice(0, 6).map((p) => p.id));
    // refused frames drew nothing: the six sent frames took the first 30 draws of link:l_1 in order
    const rep = createRng(3).split('links').split('link:l_1');
    for (const p of burst.slice(0, 6)) {
      rep.chance(0);
      rep.chance(0);
      const jitter = rep.nextInt(0, 10_000);
      const { lo, hi } = corruptionWindow(p);
      rep.nextInt(lo, hi);
      rep.nextInt(0, 7);
      const tx = h.txOf(p.id)!;
      expect(tx.arrive - tx.txEnd - PROP).toBe(jitter);
    }
  });

  it('voice above its priority rate during congestion drops policed with the §3.11 detail, refused policed (ruling R35)', () => {
    const h = harness({ spec: llq() });
    const data = h.frame(1000);
    // ten 200-byte voice frames while the data frame is on the wire: the LLQ policer (burst 200 ms of 32 kb/s = 800 bytes)
    const voice = Array.from({ length: 10 }, (_, i) => h.frame(158, 46, 16384 + i));
    h.play([{ at: 0, pdu: data }, ...voice.map((pdu, i) => ({ at: MS + i, pdu, qosClass: 0 }))], 2 * SEC);
    const policed = h.of('drop').filter((d) => d.reason === 'policed');
    expect(policed.length).toBeGreaterThan(0);
    expect(policed.length).toBeLessThan(10);
    for (const d of policed) {
      expect(d).toMatchObject({ device: 'd_a', port: 'Gi0', reason: 'policed', detail: 'priority class VOICE is over its 32 kb/s' });
      // ruling R35 (W3 fix step): TransmitRefusal gains 'policed', so a policed frame is refused at once, with no outcome
      expect(h.results.get(d.pdu.id)).toEqual({ ok: false, reason: 'policed' });
      expect(h.outcomes.find((o) => o.outcome.kind === 'dropped' && o.outcome.pdu === d.pdu.id)).toBeUndefined();
    }
    const conform = voice.filter((p) => h.txOf(p.id) !== undefined);
    expect(conform.length + policed.length).toBe(10);
    const view = h.model.egressQueues!(h.a)!;
    expect(view.classes[0]).toMatchObject({ name: 'VOICE', kind: 'priority', matched: 10, policed: policed.length, sent: conform.length });
    // an uncongested voice frame is never charged: alone on an idle port it always leaves
    const quiet = h.frame(158, 46, 20000);
    h.play([{ at: 3 * SEC, pdu: quiet, qosClass: 0 }], 4 * SEC);
    expect(h.txOf(quiet.id)?.txStart).toBe(3 * SEC);
  });
});

describe('link/media/p2p held queue: [S21] shaping through the qos: medium timer', () => {
  const shaped = (): EgressSchedulerSpec => ({
    policy: 'SHAPE',
    refBps: RATE,
    classes: [cls('class-default', 'default', 128)],
    shapeBps: 64_000,
    shapeBcBits: 8_000,
  });

  it('a burst below the queue limit is shaped to 64 kb/s without a drop; the gate is a non-periodic qos: timer', () => {
    const h = harness({ spec: shaped() });
    const burst = Array.from({ length: 20 }, () => h.frame(500));
    h.play(burst.map((pdu) => ({ at: 0, pdu })), 0);
    // the first frame fits the full bucket and leaves at once; the rest wait
    expect(h.of('frameTx').map((e) => e.pdu.id)).toEqual([burst[0]!.id]);
    expect(h.of('frameQueued')).toHaveLength(19);

    h.play([], 20 * SEC);
    const gates = h.timers;

    expect(h.of('drop')).toEqual([]);
    const txs = h.of('frameTx');
    expect(txs.map((e) => e.pdu.id)).toEqual(burst.map((p) => p.id));
    expect(h.outcomes.filter((o) => o.outcome.kind === 'sent')).toHaveLength(19);
    expect(gates.length).toBeGreaterThan(0);
    expect(new Set(gates.map((g) => `${g.medium}|${g.key}|${String(g.periodic)}`))).toEqual(new Set([`${qosMediumId(h.a)}|${QOS_SHAPER_TIMER_KEY}|false`]));
    // each gate opened exactly when a frame left
    for (const g of gates) expect(txs.some((e) => e.txStart === g.at)).toBe(true);
    expect(qosMediumId(h.a)).toBe(`${QOS_MEDIUM_PREFIX}d_a/Gi0`);
    // the long-run rate is the shaper's, not the line's: past the full bucket (bc = 8000 bits of credit at the start),
    // the burst's bits left at exactly 64 kb/s (each departure is the exact integer ceiling of the bucket's time)
    const bits = burst.reduce((s, p) => s + p.size * 8, 0) - 8_000;
    const span = txs[19]!.txStart - txs[0]!.txStart;
    expect(Math.abs((bits * SEC) / span - 64_000)).toBeLessThan(64);
    // the line itself would have needed half the time
    expect(span).toBeGreaterThan(1.8 * burst.slice(1).reduce((s, p) => s + ser(p), 0));
  });

  it('matches simulatePortScheduler exactly: every start, under LLQ + fair-queue and under a shaper', () => {
    for (const spec of [llq(true), shaped(), cbwfq()]) {
      const h = harness({ spec });
      const offers: Offer[] = [];
      for (let t = 0; t < 4 * SEC; t += 20 * MS) offers.push({ at: t + MS + 7, pdu: h.frame(60, 46, 16384), qosClass: 0 });
      for (let t = 0; t < 4 * SEC; t += 40 * MS) offers.push({ at: t, pdu: h.frame(950, 0, 7000 + ((t / (40 * MS)) % 3)), qosClass: 1 });
      for (let t = 0; t < 4 * SEC; t += 90 * MS) offers.push({ at: t + 13, pdu: h.frame(700, 0, 9000), qosClass: 2 });
      const sorted = offers.map((o, i) => [o, i] as const).sort((x, y) => x[0].at - y[0].at || x[1] - y[1]).map(([o]) => o);
      h.play(sorted, 30 * SEC);
      const arrivals: PortArrival[] = sorted.map((o) => {
        const c = spec.classes[Math.min(o.qosClass ?? spec.classes.length, spec.classes.length - 1)]!;
        const flow = c.kind !== 'priority' && c.fairQueue === true ? qosFlowOf(o.pdu) : undefined;
        return {
          at: o.at,
          bytes: o.pdu.size,
          ...(o.qosClass === undefined ? {} : { qosClass: o.qosClass }),
          ...(flow === undefined ? {} : { flow: flow.flow, flowWeight: flow.flowWeight }),
        };
      });
      const ref = simulatePortScheduler(spec, arrivals, RATE, { overheadBytes: ETH_PHY_OVERHEAD });
      const got = sorted.map((o) => {
        const tx = h.txOf(o.pdu.id);
        if (tx !== undefined) return { start: tx.txStart, end: tx.txEnd };
        const d = h.of('drop').find((x) => x.pdu.id === o.pdu.id);
        return { dropped: d?.reason, detail: d?.detail };
      });
      const want = ref.map((d) => (d.start !== undefined ? { start: d.start, end: d.end } : { dropped: d.dropped, detail: d.detail }));
      expect(got).toEqual(want);
      // the run is not trivial: frames waited, and some were dropped (LLQ: policed voice too)
      expect(ref.filter((d) => d.waitNs !== undefined && d.waitNs > 0).length).toBeGreaterThan(20);
      expect(ref.some((d) => d.dropped === 'queue-full')).toBe(true);
      if (spec.policy === 'WAN-EDGE') expect(ref.some((d) => d.dropped === 'policed')).toBe(true);
    }
  });
});

describe('link/media/p2p held queue: the five draws at dequeue', () => {
  it('held frames draw link:<id> in the order they leave (voice overtakes data), five draws each', () => {
    const h = harness({ spec: llq(), impairments: { jitterNs: 40_000 }, seed: 21 });
    const d = Array.from({ length: 4 }, (_, i) => h.frame(900 + i));
    const v = Array.from({ length: 3 }, (_, i) => h.frame(120, 46, 16384 + i));
    h.play([
      ...d.map((pdu, i) => ({ at: i * MS, pdu })),
      ...v.map((pdu, i) => ({ at: 10 * MS + i * 30 * MS, pdu, qosClass: 0 })),
    ], 5 * SEC);
    const order = h.of('frameTx').map((e) => e.pdu.id);
    // the dequeue order differs from the offer order
    expect(order).not.toEqual([...d, ...v].map((p) => p.id));
    expect(order.indexOf(v[0]!.id)).toBeLessThan(order.indexOf(d[2]!.id));
    const byId = new Map([...d, ...v].map((p) => [p.id, p] as const));
    const rep = createRng(21).split('links').split('link:l_1');
    for (const id of order) {
      rep.chance(0);
      rep.chance(0);
      const jitter = rep.nextInt(0, 40_000);
      const { lo, hi } = corruptionWindow(byId.get(id)!);
      rep.nextInt(lo, hi);
      rep.nextInt(0, 7);
      const tx = h.txOf(id)!;
      expect(tx.arrive - tx.txEnd - PROP).toBe(jitter);
    }
  });
});

describe('link/media/p2p held queue: link down, policy removal and replacement, the display view', () => {
  /** d1 on the wire, d2 and d3 held in class-default, v1 held in VOICE, at 3 ms. */
  const congested = (spec: EgressSchedulerSpec = llq()) => {
    const h = harness({ spec });
    const d1 = h.frame(1000);
    const d2 = h.frame(1000);
    const d3 = h.frame(1000);
    const v1 = h.frame(160, 46, 16384);
    h.play([{ at: 0, pdu: d1 }, { at: MS, pdu: d2 }, { at: MS, pdu: d3 }, { at: 2 * MS, pdu: v1, qosClass: 0 }], 3 * MS);
    return { h, d1, d2, d3, v1 };
  };

  it('a link that stops carrying data drops every held frame link-down, with device, port and outcome', () => {
    const { h, d1, d2, d3, v1 } = congested();
    h.model.cut('l_1', true, 3 * MS);
    const drops = h.of('drop');
    // d1 was on the wire: aborted on the link; the held ones, in the order they would have left, at the port
    expect(drops.map((d) => [d.pdu.id, d.reason, d.link ?? `${d.device}/${d.port}`, d.detail])).toEqual([
      [d1.id, 'link-down', 'l_1', 'cut'],
      [v1.id, 'link-down', 'd_a/Gi0', 'cut'],
      [d2.id, 'link-down', 'd_a/Gi0', 'cut'],
      [d3.id, 'link-down', 'd_a/Gi0', 'cut'],
    ]);
    expect(h.outcomes.map((o) => o.outcome)).toEqual([
      { kind: 'dropped', pdu: v1.id, reason: 'link-down' },
      { kind: 'dropped', pdu: d2.id, reason: 'link-down' },
      { kind: 'dropped', pdu: d3.id, reason: 'link-down' },
    ]);
    expect(h.model.egressQueues!(h.a)!.classes.map((c) => c.depth)).toEqual([0, 0]);
    h.play([], 2 * SEC);
    expect(h.of('frameTx').map((e) => e.pdu.id)).toEqual([d1.id]); // nothing else ever left
  });

  it('a link that goes down cancels a pending shaper gate', () => {
    const spec: EgressSchedulerSpec = { policy: 'SHAPE', refBps: RATE, classes: [cls('class-default', 'default', 128)], shapeBps: 8_000, shapeBcBits: 8_000 };
    const h = harness({ spec });
    const burst = Array.from({ length: 4 }, () => h.frame(500));
    h.play(burst.map((pdu) => ({ at: 0, pdu })), 50 * MS); // past the first frame's txComplete and arrival: the gate is armed
    expect(h.scheduler.size).toBe(1);
    h.model.cut('l_1', true, 50 * MS);
    expect(h.scheduler.size).toBe(0); // the gate is gone
    expect(h.outcomes.filter((o) => o.outcome.kind === 'dropped')).toHaveLength(3);
  });

  it('removing the policy hands the held frames, in leaving order, to the virtual FIFO behind busyUntil', () => {
    const { h, d1, d2, d3, v1 } = congested();
    h.policies.set(portKey(h.a), undefined);
    h.model.onPortChanged(h.a, 3 * MS); // `no service-policy output`: a PHY line of a scheduler port
    const t1 = h.txOf(d1.id)!;
    const txs = h.of('frameTx');
    expect(txs.map((e) => e.pdu.id)).toEqual([d1.id, v1.id, d2.id, d3.id]);
    expect(txs.slice(1).map((e) => e.t)).toEqual([3 * MS, 3 * MS, 3 * MS]); // committed now, with future starts
    expect(h.txOf(v1.id)!.txStart).toBe(t1.txEnd);
    expect(h.model.queued(h.a, 3 * MS).map((f) => f.pdu.id)).toEqual([v1.id, d2.id, d3.id]); // the FIFO's backlog
    expect(h.outcomes.map((o) => o.outcome.kind)).toEqual(['sent', 'sent', 'sent']);
    expect(h.model.egressQueues!(h.a)).toBeUndefined();
    // later frames take the FIFO
    const d4 = h.frame(100);
    h.play([{ at: 4 * MS, pdu: d4, qosClass: 0 }], 4 * MS);
    expect(h.results.get(d4.id)).toMatchObject({ ok: true, txStart: h.txOf(d3.id)!.txEnd });
    expect(h.results.get(d4.id)).not.toHaveProperty('deferred');
  });

  it('an equal recompiled spec keeps the queue and its counters; a different one starts a new queue', () => {
    const { h, d2, d3, v1 } = congested();
    const before = h.model.egressQueues!(h.a)!;
    h.policies.set(portKey(h.a), JSON.parse(JSON.stringify(llq())) as EgressSchedulerSpec); // a new, equal object
    h.model.onPortChanged(h.a, 3 * MS);
    expect(h.model.egressQueues!(h.a)).toEqual(before);
    expect(h.of('frameTx')).toHaveLength(1);
    expect(samePlainValue(llq(), { ...llq(), shapeBps: undefined })).toBe(true);
    expect(samePlainValue(llq(), cbwfq())).toBe(false);

    const bigger = llq();
    h.policies.set(portKey(h.a), { ...bigger, classes: [bigger.classes[0]!, { ...bigger.classes[1]!, queueLimit: 100 }] });
    h.model.onPortChanged(h.a, 3 * MS);
    // the old queue's frames went to the FIFO; the new queue starts empty with fresh counters
    expect(h.of('frameTx').map((e) => e.pdu.id).slice(1)).toEqual([v1.id, d2.id, d3.id]);
    const view = h.model.egressQueues!(h.a)!;
    expect(view.classes.map((c) => [c.name, c.limit, c.matched, c.depth])).toEqual([
      ['VOICE', 64, 0, 0],
      ['class-default', 100, 0, 0],
    ]);
  });

  it('the display view: none on a FIFO port, the empty view before traffic, counts equal to the trace', () => {
    const fifo = harness();
    expect(fifo.model.egressQueues!(fifo.a)).toBeUndefined();
    const h = harness({ spec: cbwfq() });
    expect(h.model.egressQueues!(h.b)).toBeUndefined(); // the other end has no policy
    const empty = h.model.egressQueues!(h.a)!;
    expect(empty).toEqual({
      policy: 'CB',
      strategy: 'class-based',
      refBps: RATE,
      classes: cbwfq().classes.map((c) => ({
        name: c.name, kind: c.kind, depth: 0, limit: 64, matched: 0, matchedBytes: 0, sent: 0, tailDrops: 0, policed: 0, offeredBps30s: 0,
      })),
    });
    const offers: Offer[] = [];
    for (let i = 0; i < 90; i++) offers.push({ at: i * MS, pdu: h.frame(400), qosClass: i % 3 });
    h.play(offers, 100 * MS);
    const view = h.model.egressQueues!(h.a)!;
    const sentBy = [0, 0, 0];
    const queuedBy = [0, 0, 0];
    const classOfPdu = new Map(offers.map((o) => [o.pdu.id, o.qosClass!] as const));
    for (const tx of h.of('frameTx')) sentBy[classOfPdu.get(tx.pdu.id)!]!++;
    for (const q of h.of('frameQueued')) queuedBy[classOfPdu.get(q.pdu.id)!]!++;
    view.classes.forEach((c, i) => {
      expect(c.matched).toBe(30);
      expect(c.sent).toBe(sentBy[i]);
      expect(c.tailDrops).toBe(h.of('drop').filter((d) => classOfPdu.get(d.pdu.id) === i).length);
      expect(c.depth).toBe(30 - c.sent - c.tailDrops);
      expect(c.offeredBps30s).toBe(Math.floor((30 * offers[0]!.pdu.size * 8) / 30));
    });
    expect(queuedBy.reduce((s, n) => s + n, 0)).toBe(89); // all but the first frame waited
  });
});
