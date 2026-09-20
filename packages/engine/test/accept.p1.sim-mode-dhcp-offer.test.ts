/**
 * P1 acceptance — simulation mode stopping on the first DHCP OFFER (ARCHITECTURE-P1 §10.2
 * `accept.p1.sim-mode-dhcp-offer`; §4.11 run control, §5 determinism).
 *
 * This is the shape of every sim-mode lesson: set a breakpoint on one message kind, run, and land on it. PC1 and
 * PC2 both ask R1 for an address, and the run is stopped by
 * `runUntil(t, {stopOn: {kinds:['frameTx'], protos:['dhcp'], tags:['dhcp-offer']}})`.
 *
 * Checked: the run stops after the whole dispatch of the FIRST offer frame leaving R1, with `now` at that event and
 * short of the horizon; resuming from breakpoint to breakpoint produces the same trace and the same snapshot, byte
 * for byte, as one uninterrupted run of the same seed; and `stepToNext` with the same filter walks from one offer
 * to the next.
 *
 * Not here: the worker batch that carries `stopped {reason 'breakpoint'}` and its snapshot — that lives in the web
 * package's sim-events client test, outside the engine.
 *
 * ponytail: each PC sits on its own router interface, so every OFFER crosses exactly one cable and the number of
 * matching `frameTx` events is the number of offers — no flooding legs to explain away.
 */
import { describe, expect, it } from 'vitest';
import type { Simulation, TraceFilter } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { pcRouterPc } from '../src/sim/scenarios.js';
import { matchesTraceFilter } from '../src/trace/filter.js';
import { booted, ofKind } from './sim.harness.js';

/** The §10.2 breakpoint: the DHCP OFFER leaving a port. */
const OFFER: TraceFilter = { kinds: ['frameTx'], protos: ['dhcp'], tags: ['dhcp-offer'] };
/** Far enough past the discover backoff for both clients to be served. */
const HORIZON_NS = 60 * SEC;

/** R1 leases both of its LANs. */
const R1_POOLS: readonly string[] = [
  'ip dhcp excluded-address 10.0.0.254',
  'ip dhcp excluded-address 10.0.1.254',
  'ip dhcp pool LAN0',
  'network 10.0.0.0 255.255.255.0',
  'default-router 10.0.0.254',
  'exit',
  'ip dhcp pool LAN1',
  'network 10.0.1.0 255.255.255.0',
  'default-router 10.0.1.254',
  'exit',
];

/**
 * A booted PC–router–PC lab whose router leases both LANs, with `ip address dhcp` just typed on both PCs and
 * nothing dispatched yet.
 */
function dhcpLab(seed: number): Simulation {
  const sim = booted(pcRouterPc(), seed);
  const r = sim.configure('r1', R1_POOLS);
  expect(r.lines.filter((l) => !l.ok)).toEqual([]);
  sim.runToIdle();
  for (const pc of ['pc1', 'pc2']) {
    const session = sim.cli.open(pc, 'console');
    expect(sim.cli.exec(session, 'ip address dhcp').error, pc).toBeUndefined();
  }
  return sim;
}

/** The whole retained trace as JSON (byte comparison). */
const traceBytes = (sim: Simulation): string => JSON.stringify(sim.trace(0).events);

/** Narrow a stop event to the frameTx it must be. */
function stopFrame(ev: TraceEvent | undefined): Extract<TraceEvent, { kind: 'frameTx' }> {
  expect(ev?.kind).toBe('frameTx');
  return ev as Extract<TraceEvent, { kind: 'frameTx' }>;
}

describe('accept P1: runUntil stops on the first DHCP OFFER', () => {
  it('stops right after the offer frame, with now at that event and the horizon not reached', () => {
    const sim = dhcpLab(11);
    const cursor = sim.trace(0).next;
    const target = sim.now + HORIZON_NS;
    const stats = sim.runUntil(target, { stopOn: OFFER });

    expect(stats.stopped).toBe('breakpoint');
    const ev = stopFrame(stats.stopEvent);
    expect(ev.pdu.tag).toBe('dhcp-offer');
    expect(ev.pdu.layers ?? [ev.pdu.proto]).toContain('dhcp');
    expect(ev.from.device).toBe('r1');
    expect(matchesTraceFilter(OFFER, ev)).toBe(true);

    // `now` is the event's own time, not the horizon: the clock was never advanced past the breakpoint.
    expect(sim.now).toBe(ev.t);
    expect(stats.to).toBe(sim.now);
    expect(sim.now).toBeLessThan(target);

    // It is the FIRST offer: nothing before it in the trace matched, and the cursor addresses it in the ring.
    const since = sim.trace(cursor).events;
    const at = since.findIndex((e) => matchesTraceFilter(OFFER, e));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(cursor + at).toBe(stats.stopCursor);
    expect(sim.trace(stats.stopCursor!).events[0]).toBe(ev);
    // The whole dispatch that emitted it ran: every event after it carries the same time.
    for (const e of since.slice(at)) expect(e.t).toBe(ev.t);
    // The discover it answers came first (it leaves as the command is typed), and no client is bound yet.
    const all = sim.trace(0).events;
    const offerAt = all.indexOf(ev);
    expect(offerAt).toBeGreaterThan(0);
    expect(all.slice(0, offerAt).some((e) => e.kind === 'frameTx' && e.pdu.tag === 'dhcp-discover')).toBe(true);
    expect(sim.device('pc1')!.port('GigabitEthernet0')!.l3.ipv4?.origin).not.toBe('dhcp');
  });

  it('resuming from breakpoint to breakpoint gives the same trace and snapshot as one uninterrupted run', () => {
    const plain = dhcpLab(11);
    const end = plain.now + HORIZON_NS;
    plain.runUntil(end);

    const stepped = dhcpLab(11);
    let stops = 0;
    for (;;) {
      const stats = stepped.runUntil(end, { stopOn: OFFER });
      if (stats.stopped === undefined) break;
      expect(stats.stopped).toBe('breakpoint');
      stops++;
      expect(stops).toBeLessThan(20);
    }
    // One stop per offer frame, and both PCs really were served.
    const offers = plain.trace(0).events.filter((e) => matchesTraceFilter(OFFER, e)).length;
    expect(offers).toBe(2);
    expect(stops).toBe(offers);
    expect(stepped.now).toBe(end);
    expect(traceBytes(stepped)).toBe(traceBytes(plain));
    expect(JSON.stringify(stepped.snapshot())).toBe(JSON.stringify(plain.snapshot()));
    for (const pc of ['pc1', 'pc2']) expect(stepped.device(pc)!.port('GigabitEthernet0')!.l3.ipv4?.origin, pc).toBe('dhcp');
  });

  it('stepToNext advances to the next matching offer', () => {
    const sim = dhcpLab(11);
    const first = sim.stepToNext(OFFER, { until: sim.now + HORIZON_NS });
    expect(first.stopped).toBe('breakpoint');
    const firstEv = stopFrame(first.stopEvent);
    expect(firstEv.pdu.tag).toBe('dhcp-offer');
    expect(sim.now).toBe(firstEv.t);

    const second = sim.stepToNext(OFFER, { until: sim.now + HORIZON_NS });
    expect(second.stopped).toBe('breakpoint');
    const secondEv = stopFrame(second.stopEvent);
    expect(secondEv.pdu.tag).toBe('dhcp-offer');
    expect(second.stopCursor!).toBeGreaterThan(first.stopCursor!);
    expect(secondEv.t).toBeGreaterThanOrEqual(firstEv.t);
    expect(secondEv.pdu.id).not.toBe(firstEv.pdu.id);
    expect(sim.now).toBe(secondEv.t);
    // The two offers went to the two different clients.
    expect([firstEv.to.device, secondEv.to.device].sort()).toEqual(['pc1', 'pc2']);

    // There is no third: the run ends at the horizon with nothing left to stop on.
    const third = sim.stepToNext(OFFER, { until: sim.now + HORIZON_NS });
    expect(third.stopped).toBeUndefined();
    expect(third.stopEvent).toBeUndefined();
  });

  it('lands on the same offer whichever way the run was driven', () => {
    const byRun = dhcpLab(11);
    const byStep = dhcpLab(11);
    const a = byRun.runUntil(byRun.now + HORIZON_NS, { stopOn: OFFER });
    const b = byStep.stepToNext(OFFER, { until: byStep.now + HORIZON_NS });
    expect(byStep.now).toBe(byRun.now);
    expect(JSON.stringify(b.stopEvent)).toBe(JSON.stringify(a.stopEvent));
    expect(b.stopCursor).toBe(a.stopCursor);
    expect(traceBytes(byStep)).toBe(traceBytes(byRun));
    // The offer really is the first DHCP answer of the lab, not an arbitrary frame.
    expect(ofKind(byRun.trace(0).events, 'frameTx').filter((e) => e.from.device === 'r1' && e.pdu.tag === 'dhcp-offer')).toHaveLength(1);
  });
});
