/**
 * The queueing sandbox model (ARCHITECTURE-P3 D16, §3.5 step 7, §10.2 "concept.queueing"; W2 web-concept).
 *
 * Under test: the parity case — for one arrival list, the model's departures equal the engine's `simulateQueueing`
 * (`core/queueing.ts`) exactly, for FIFO, WFQ (flow DRR), CBWFQ and LLQ, on the default scenario and on a congested
 * variant with drops — every step's sentence and every packet's fate as text, the step records (queues and the
 * packet on the wire), the lesson point (LLQ protects voice, FIFO does not), and determinism.
 */
import { describe, expect, it } from 'vitest';
import { simulateQueueing } from '@netforge/engine/pure';
import {
  QUEUEING_DEFAULT_SCENARIO,
  QUEUEING_DISCIPLINES,
  compareQueueing,
  msText,
  packetFateText,
  queueingArrivals,
  queueingPackets,
  queueingSpecFor,
  runQueueing,
  type QueueingDiscipline,
  type QueueingScenario,
} from '../src/concept/queueing/model.js';

const ALL: readonly QueueingDiscipline[] = ['fifo', 'wfq', 'cbwfq', 'llq'];
const MS = 1_000_000;

/** A harder world: three flows, a short queue and a low priority rate, so tail drops and policing both happen. */
const CONGESTED: QueueingScenario = {
  rateBps: 64_000,
  flows: [
    { name: 'voice', kind: 'voice', bytes: 200, intervalNs: 10 * MS, count: 30, startNs: 0 },
    { name: 'bulk', kind: 'data', bytes: 1500, intervalNs: 15 * MS, count: 20, startNs: 3 * MS },
    { name: 'web', kind: 'data', bytes: 400, intervalNs: 25 * MS, count: 12, startNs: 1 * MS },
  ],
  queueLimit: 6,
  voiceKbps: 24,
  dataKbps: 24,
  defaultKbps: 8,
};

describe('parity with core/queueing.ts', () => {
  for (const scenario of [QUEUEING_DEFAULT_SCENARIO, CONGESTED]) {
    for (const d of ALL) {
      it(`${d} on ${scenario === CONGESTED ? 'the congested scenario' : 'the default scenario'}: departures equal simulateQueueing exactly`, () => {
        const run = runQueueing(scenario, d);
        const reference = simulateQueueing(queueingSpecFor(d, scenario), queueingArrivals(scenario, d), scenario.rateBps);
        expect(run.departures).toEqual(reference);
        expect(run.spec).toEqual(queueingSpecFor(d, scenario));
        expect(run.arrivals).toEqual(queueingArrivals(scenario, d));
      });
    }
  }

  it('the congested scenario really drops (tail drops, and the LLQ policer)', () => {
    const fifo = runQueueing(CONGESTED, 'fifo');
    expect(fifo.departures.some((x) => x.dropped === 'queue-full')).toBe(true);
    const llq = runQueueing(CONGESTED, 'llq');
    expect(llq.departures.some((x) => x.dropped === 'policed')).toBe(true);
    expect(llq.classStats[0]!.policed).toBeGreaterThan(0);
  });
});

describe('the scenario and the policies', () => {
  it('builds the walk-through pair: 25 voice packets of 80 B every 20 ms and 13 data packets of 1000 B every 40 ms', () => {
    const packets = queueingPackets(QUEUEING_DEFAULT_SCENARIO);
    expect(packets).toHaveLength(38);
    expect(packets.slice(0, 3).map((p) => [p.flow, p.seq, p.at])).toEqual([
      ['voice', 1, 0],
      ['data', 1, 0],
      ['voice', 2, 20 * MS],
    ]);
    expect(packets.filter((p) => p.kind === 'voice').every((p) => p.bytes === 80)).toBe(true);
    expect(packets.map((p) => p.index)).toEqual(packets.map((_, i) => i));
  });

  it('gives each discipline its classes, in policy order', () => {
    const sc = QUEUEING_DEFAULT_SCENARIO;
    expect(queueingSpecFor('fifo', sc).classes.map((c) => [c.name, c.kind])).toEqual([['class-default', 'default']]);
    expect(queueingSpecFor('wfq', sc).classes[0]).toMatchObject({ name: 'class-default', kind: 'default', fairQueue: true });
    expect(queueingSpecFor('cbwfq', sc).classes.map((c) => [c.name, c.kind, c.weightKbps])).toEqual([
      ['VOICE', 'bandwidth', 40],
      ['DATA', 'bandwidth', 56],
      ['class-default', 'default', 32],
    ]);
    expect(queueingSpecFor('llq', sc).classes[0]).toMatchObject({ name: 'VOICE', kind: 'priority', rateBps: 40_000 });
    // WFQ tells the scheduler each packet's conversation; the class-based ones do not need it
    expect(queueingArrivals(sc, 'wfq').every((a) => a.flow === 'voice' || a.flow === 'data')).toBe(true);
    expect(queueingArrivals(sc, 'cbwfq').every((a) => a.flow === undefined)).toBe(true);
    expect(QUEUEING_DISCIPLINES.map((d) => d.id)).toEqual([...ALL]);
  });
});

describe('steps and text', () => {
  it('records an arrival or drop for every packet and a send for every packet sent, each with a sentence', () => {
    for (const run of compareQueueing(CONGESTED)) {
      const sent = run.departures.filter((d) => d.start !== undefined).length;
      const dropped = run.departures.filter((d) => d.dropped !== undefined).length;
      expect(run.steps.filter((s) => s.kind === 'arrive')).toHaveLength(run.packets.length - dropped);
      expect(run.steps.filter((s) => s.kind === 'drop')).toHaveLength(dropped);
      expect(run.steps.filter((s) => s.kind === 'send')).toHaveLength(sent);
      for (const s of run.steps) {
        expect(typeof s.text).toBe('string');
        expect(s.text).toMatch(/^\d+\.\d ms: [A-Z]/);
        expect(s.queues).toHaveLength(run.spec.classes.length);
      }
      // steps in time order
      for (let i = 1; i < run.steps.length; i++) expect(run.steps[i]!.at).toBeGreaterThanOrEqual(run.steps[i - 1]!.at);
    }
  });

  it('shows the queues after each step and the packet on the wire', () => {
    const run = runQueueing(QUEUEING_DEFAULT_SCENARIO, 'fifo');
    const [first, second, third] = run.steps as [typeof run.steps[number], typeof run.steps[number], typeof run.steps[number]];
    expect([first.kind, first.packet, first.queues]).toEqual(['arrive', 0, [[0]]]);
    expect([second.kind, second.packet, second.queues]).toEqual(['arrive', 1, [[0, 1]]]);
    expect([third.kind, third.packet, third.queues]).toEqual(['send', 0, [[1]]]);
    expect(third.onWire).toEqual({ packet: 0, start: 0, end: 5 * MS });
    expect(third.text).toBe('0.0 ms: Voice packet 1 (80 B) starts on the wire without waiting, because it was first in the queue; sending it takes 5.0 ms.');
    expect(first.text).toBe('0.0 ms: Voice packet 1 (80 B) joins the queue (1 waiting there).');
    // the data packet goes next, the moment the voice packet is through
    const fourth = run.steps[3]!;
    expect([fourth.kind, fourth.packet, fourth.at]).toEqual(['send', 1, 5 * MS]);
    expect(fourth.text).toBe('5.0 ms: Data packet 1 (1000 B) starts on the wire after waiting 5.0 ms, because it was first in the queue; sending it takes 62.5 ms.');
  });

  it('words drops, the priority queue and each packet’s fate', () => {
    const llq = runQueueing(CONGESTED, 'llq');
    const policed = llq.steps.find((s) => s.kind === 'drop' && /policer/.test(s.text));
    expect(policed?.text).toMatch(/goes over the VOICE class’s policed rate while the link is congested, so the policer drops it\.$/);
    expect(llq.steps.some((s) => s.kind === 'send' && /the priority queue is always served first/.test(s.text))).toBe(true);
    const fifo = runQueueing(CONGESTED, 'fifo');
    const tail = fifo.steps.find((s) => s.kind === 'drop');
    expect(tail?.text).toMatch(/finds the queue full \(6 packets\), so it is dropped at the tail\.$/);
    const def = runQueueing(QUEUEING_DEFAULT_SCENARIO, 'fifo');
    expect(packetFateText(def, 0)).toBe('Voice packet 1 (80 B) arrived at 0.0 ms, waited 0.0 ms and was sent from 0.0 ms to 5.0 ms.');
    expect(packetFateText(def, 1)).toBe('Data packet 1 (1000 B) arrived at 0.0 ms, waited 5.0 ms and was sent from 5.0 ms to 67.5 ms.');
    const droppedIndex = fifo.departures.findIndex((d) => d.dropped === 'queue-full');
    expect(packetFateText(fifo, droppedIndex)).toMatch(/and was dropped: its queue was full\.$/);
    expect(() => packetFateText(def, 999)).toThrow(RangeError);
    expect(msText(62_500_000)).toBe('62.5 ms');
    expect(msText(0)).toBe('0.0 ms');
    expect(msText(1_234_567_890)).toBe('1234.6 ms');
  });

  it('makes the lesson point: LLQ keeps voice waits short where FIFO lets them grow', () => {
    const runs = compareQueueing();
    const voice = (d: QueueingDiscipline) => runs.find((r) => r.discipline === d)!.summary.find((s) => s.kind === 'voice')!;
    expect(voice('llq').maxWaitNs).toBeLessThanOrEqual(62_500_000); // at most one data frame in service
    expect(voice('fifo').maxWaitNs).toBeGreaterThan(5 * voice('llq').maxWaitNs);
    expect(voice('fifo').text).toMatch(/^Voice: average wait \d+\.\d ms, longest \d+\.\d ms, none dropped \(25 packets\)\.$/);
    expect(runs.map((r) => r.discipline)).toEqual([...ALL]);
  });

  it('is deterministic: the same scenario gives the same run', () => {
    expect(runQueueing(CONGESTED, 'wfq')).toEqual(runQueueing(CONGESTED, 'wfq'));
  });
});
