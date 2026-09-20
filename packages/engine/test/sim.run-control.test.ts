/**
 * P1 W1 sim — run control (ARCHITECTURE-P1 §4.11): breakpoints (`runUntil(t, {stopOn})`), `stepToNext` with the
 * `until` horizon and `maxEvents` cap, and `traceQuery` pages over the ring.
 */
import { describe, expect, it } from 'vitest';
import type { Simulation, TraceFilter } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';
import { matchesTraceFilter } from '../src/trace/filter.js';
import { BOOT_NS, booted } from './sim.harness.js';

/** The §4.11 horizon of one sim-mode step (apps/web protocol.ts SIM_STEP_HORIZON_NS). */
const HORIZON_NS = 10 * SEC;
/** The §4.11 event cap of one sim-mode step (apps/web protocol.ts SIM_STEP_MAX_EVENTS). */
const STEP_MAX_EVENTS = 20_000;
/** The default sim-mode list filter (§4.11 step 1). */
const LIST: TraceFilter = { kinds: ['frameTx', 'drop', 'tableWrite'], includeBackground: false };
/** Stop on every ICMP echo reply leaving a port. */
const ECHO_REPLY_TX: TraceFilter = { kinds: ['frameTx'], tags: ['echo-reply'] };

/** Boot the two-PC lab and start `ping 10.0.0.2` on PC1 (nothing dispatched yet after the command). */
function pingLab(seed: number): Simulation {
  const sim = booted(twoPcsAndSwitch(), seed);
  const session = sim.cli.open('pc1', 'console');
  const r = sim.cli.exec(session, 'ping 10.0.0.2');
  expect(r.error).toBeUndefined();
  return sim;
}

/** The whole retained trace as JSON (byte comparison). */
function traceBytes(sim: Simulation): string {
  return JSON.stringify(sim.trace(0).events);
}

describe('sim/run-control: breakpoints', () => {
  it('stops after the whole dispatch of the first matching event, with now at that event and no advance', () => {
    const sim = pingLab(11);
    const cursor = sim.trace(0).next;
    const target = sim.now + 20 * SEC;
    const stats = sim.runUntil(target, { stopOn: ECHO_REPLY_TX });
    expect(stats.stopped).toBe('breakpoint');
    expect(stats.stopEvent).toBeDefined();
    const ev = stats.stopEvent!;
    expect(ev.kind).toBe('frameTx');
    expect(matchesTraceFilter(ECHO_REPLY_TX, ev)).toBe(true);
    expect(sim.now).toBe(ev.t);
    expect(stats.to).toBe(sim.now);
    expect(sim.now).toBeLessThan(target);
    // The cursor addresses the stop event in the ring, and it is the first match since the run began.
    expect(sim.trace(stats.stopCursor!).events[0]).toBe(ev);
    const since = sim.trace(cursor).events;
    expect(since.findIndex((e) => matchesTraceFilter(ECHO_REPLY_TX, e))).toBe(stats.stopCursor! - cursor);
    // Every event emitted by the stopping dispatch carries the stop time: the loop stopped after that dispatch.
    const tail = since.slice(stats.stopCursor! - cursor);
    for (const e of tail) expect(e.t).toBe(ev.t);
  });

  it('resuming after every breakpoint gives the same trace and snapshot as an uninterrupted run', () => {
    const plain = pingLab(5);
    const end = plain.now + 30 * SEC;
    plain.runUntil(end);

    const stepped = pingLab(5);
    let stops = 0;
    for (;;) {
      const stats = stepped.runUntil(end, { stopOn: ECHO_REPLY_TX });
      if (stats.stopped === undefined) break;
      expect(stats.stopped).toBe('breakpoint');
      stops++;
      expect(stops).toBeLessThan(50);
    }
    // One stop per matching dispatch: 5 replies, each leaving PC2 and then the switch.
    const matching = plain.trace(0).events.filter((e) => matchesTraceFilter(ECHO_REPLY_TX, e)).length;
    expect(matching).toBe(10);
    expect(stops).toBe(matching);
    expect(stepped.now).toBe(end);
    expect(traceBytes(stepped)).toBe(traceBytes(plain));
    expect(JSON.stringify(stepped.snapshot())).toBe(JSON.stringify(plain.snapshot()));
  });

  it('a filter that never matches runs exactly like a plain runUntil', () => {
    const a = pingLab(3);
    const b = pingLab(3);
    const t = a.now + 15 * SEC;
    const sa = a.runUntil(t);
    const sb = b.runUntil(t, { stopOn: { tags: ['no-such-tag'] } });
    expect(sb.stopped).toBeUndefined();
    expect(sb).toEqual(sa);
    expect(traceBytes(b)).toBe(traceBytes(a));
  });

  it('breakpoints ignore events emitted between runs and background frames unless asked', () => {
    const sim = booted(twoPcsAndSwitch(), 2);
    const session = sim.cli.open('pc1', 'console');
    sim.cli.exec(session, 'show version');
    // cliOutput was emitted before the run: it must not stop the run.
    const stats = sim.runFor(SEC, { stopOn: { kinds: ['cliOutput'] } });
    expect(stats.stopped).toBeUndefined();
    expect(matchesTraceFilter({ kinds: ['frameTx'] }, { ...frameTxStub(), background: true })).toBe(false);
    expect(matchesTraceFilter({ kinds: ['frameTx'], includeBackground: true }, { ...frameTxStub(), background: true })).toBe(true);
  });

  it('maxEvents stops a run early without advancing the clock', () => {
    const plain = pingLab(9);
    const end = plain.now + 10 * SEC;
    plain.runUntil(end);

    const capped = pingLab(9);
    const s = capped.runUntil(end, { maxEvents: 3 });
    expect(s.stopped).toBe('maxEvents');
    expect(s.events).toBe(3);
    expect(capped.now).toBeLessThan(end);
    capped.runUntil(end);
    expect(traceBytes(capped)).toBe(traceBytes(plain));
    expect(() => capped.runUntil(end, { maxEvents: -1 })).toThrow(RangeError);
  });
});

describe('sim/run-control: stepToNext', () => {
  it('advances to the next match and then to the one after it', () => {
    const sim = pingLab(4);
    const filter: TraceFilter = { kinds: ['frameTx'], protos: ['arp'] };
    const first = sim.stepToNext(filter, { until: sim.now + HORIZON_NS, maxEvents: STEP_MAX_EVENTS });
    expect(first.stopped).toBe('breakpoint');
    expect(first.stopEvent?.kind).toBe('frameTx');
    const firstEv = first.stopEvent as Extract<TraceEvent, { kind: 'frameTx' }>;
    expect(firstEv.pdu.tag).toBe('arp-request');
    expect(sim.now).toBe(firstEv.t);
    const second = sim.stepToNext(filter, { until: sim.now + HORIZON_NS, maxEvents: STEP_MAX_EVENTS });
    expect(second.stopped).toBe('breakpoint');
    expect(second.stopCursor!).toBeGreaterThan(first.stopCursor!);
    expect(sim.now).toBe(second.stopEvent!.t);
    expect(second.stopEvent!.t).toBeGreaterThanOrEqual(firstEv.t);
  });

  it('in a quiet switch lab the 10 s horizon returns no match with now advanced by at most 10 s', () => {
    const sim = booted(twoPcsAndSwitch(), 1);
    sim.runFor(120 * SEC);
    for (let i = 0; i < 4; i++) {
      const before = sim.now;
      const head = sim.trace(0).next;
      const s = sim.stepToNext(LIST, { until: before + HORIZON_NS, maxEvents: STEP_MAX_EVENTS });
      expect(s.stopped).toBeUndefined();
      expect(s.stopEvent).toBeUndefined();
      expect(sim.now - before).toBeGreaterThan(0);
      expect(sim.now - before).toBeLessThanOrEqual(HORIZON_NS);
      expect(sim.now).toBe(before + HORIZON_NS);
      // Not idle (maintenance timers stay pending), so the worker reports 'horizon'.
      expect(sim.nextEventTime()).toBeDefined();
      for (const e of sim.trace(head).events) expect(matchesTraceFilter(LIST, e)).toBe(false);
    }
  });

  it('stops on the cap, stays put when until is in the past, and ends at until on an empty queue', () => {
    const sim = pingLab(6);
    const s = sim.stepToNext({ tags: ['no-such-tag'] }, { maxEvents: 2 });
    expect(s.stopped).toBe('maxEvents');
    expect(s.events).toBe(2);

    const now = sim.now;
    const past = sim.stepToNext(LIST, { until: now - 1 });
    expect(past).toEqual({ events: 0, from: now, to: now });

    const empty = createSimulation({ seed: 1 });
    const e = empty.stepToNext(LIST, { until: 5 * SEC });
    expect(e.stopped).toBeUndefined();
    expect(empty.now).toBe(5 * SEC);
    expect(empty.nextEventTime()).toBeUndefined();
    const noHorizon = empty.stepToNext(LIST);
    expect(noHorizon).toEqual({ events: 0, from: 5 * SEC, to: 5 * SEC });
  });
});

describe('sim/run-control: traceQuery', () => {
  it('pages forward and backward through the ring with a filter', () => {
    const sim = pingLab(8);
    sim.runToIdle();
    const all = sim.trace(0).events;
    const head = sim.trace(0).next;
    const want = all.map((event, cursor) => ({ cursor, event })).filter((x) => matchesTraceFilter(LIST, x.event));
    expect(want.length).toBeGreaterThan(20);

    const page1 = sim.traceQuery({ from: 0, filter: LIST, limit: 10 });
    expect(page1.oldest).toBe(0);
    expect(page1.head).toBe(head);
    expect(page1.events).toEqual(want.slice(0, 10));
    expect(page1.next).toBe(want[9]!.cursor + 1);
    const page2 = sim.traceQuery({ from: page1.next, filter: LIST, limit: 10 });
    expect(page2.events).toEqual(want.slice(10, 20));

    const rest = sim.traceQuery({ from: page2.next, filter: LIST, limit: 100_000 });
    expect(rest.events).toEqual(want.slice(20));
    expect(rest.next).toBe(head);

    const back = sim.traceQuery({ from: head - 1, filter: LIST, limit: 5, direction: 'backward' });
    expect(back.events).toEqual(want.slice(-5).reverse());
    expect(back.next).toBe(want[want.length - 5]!.cursor - 1);
    const backAll = sim.traceQuery({ from: head + 100, filter: LIST, limit: 1_000_000, direction: 'backward' });
    expect(backAll.events).toEqual([...want].reverse());
    expect(backAll.next).toBe(-1);

    const unfiltered = sim.traceQuery({ from: head - 3, limit: 10 });
    expect(unfiltered.events.map((x) => x.cursor)).toEqual([head - 3, head - 2, head - 1]);
    expect(unfiltered.events.map((x) => x.event)).toEqual(all.slice(-3));

    expect(sim.traceQuery({ from: 5, limit: 0 }).events).toEqual([]);
    expect(() => sim.traceQuery({ from: 0.5, limit: 1 })).toThrow(RangeError);
    expect(() => sim.traceQuery({ from: 0, limit: -1 })).toThrow(RangeError);
  });

  it('clamps to the retained window of a bounded ring', () => {
    const sim = createSimulation({ seed: 1, traceCapacity: 64 });
    sim.loadTopology(twoPcsAndSwitch());
    sim.runFor(BOOT_NS);
    const session = sim.cli.open('pc1', 'console');
    sim.cli.exec(session, 'ping 10.0.0.2');
    sim.runToIdle();
    const head = sim.trace(0).next;
    expect(head).toBeGreaterThan(64);
    const retained = sim.trace(0).events;
    const q = sim.traceQuery({ from: 0, limit: 1_000 });
    expect(q.oldest).toBe(head - 64);
    expect(q.events.length).toBe(64);
    expect(q.events[0]!.cursor).toBe(head - 64);
    expect(q.events.map((x) => x.event)).toEqual(retained);
    const b = sim.traceQuery({ from: head - 1, limit: 1_000, direction: 'backward' });
    expect(b.events.length).toBe(64);
    expect(b.next).toBe(head - 65);
    expect(sim.traceQuery({ from: 3, limit: 5, direction: 'backward' }).events).toEqual([]);
  });
});

/** A minimal frameTx event for direct filter checks. */
function frameTxStub(): Extract<TraceEvent, { kind: 'frameTx' }> {
  return {
    t: 0,
    kind: 'frameTx',
    pdu: { id: 1, proto: 'ethernet', size: 64, summary: 'stub' },
    link: 'l1',
    from: { device: 'a', port: 'p' },
    to: { device: 'b', port: 'p' },
    txStart: 0,
    txEnd: 1,
    arrive: 2,
  };
}
