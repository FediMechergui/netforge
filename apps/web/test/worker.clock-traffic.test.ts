/**
 * The worker clock and generated traffic (ARCHITECTURE-P3 §9.2 ruling R57(a); P1 §3.14 the clamp; the W5 fix step).
 *
 * Under test: legs of traffic-generator datagrams (protocols/traffic.ts, PDU tag 'traffic') never clamp the clock —
 * like background legs, for the clamp only, and unconditionally — so a continuous 50 pps flow, which always has a
 * frame in flight, plays at exactly the chosen rate in a real P3 world driven through `createWorkerClock`; its legs
 * still reach the trace (the Packets list, the canvas) and a capture without "Keep keepalives and beacons"; and a
 * ping's legs clamp exactly as before: the clock's rate at every slice equals that of a clock that never saw a
 * traffic leg, and a ping leg's slice is stretched to `minTransitWallMs` of wall exactly.
 */
import { describe, expect, it } from 'vitest';
import { createSimulation, matchesTraceFilter, MS, SEC, type InflightFrame, type SimTime, type Simulation, type TraceEvent } from '@netforge/engine';
import { createWorkerClock, isTrafficDatagram, MAX_SUBSTEPS, TRAFFIC_DATAGRAM_TAG } from '../src/bridge/worker/clock';
import { DEFAULT_CLOCK_POLICY } from '../src/bridge/protocol';

type FrameTx = Extract<TraceEvent, { kind: 'frameTx' }>;

const PC1_GI0 = { device: 'pc1', port: 'GigabitEthernet0' };
const PC2_GI0 = { device: 'pc2', port: 'GigabitEthernet0' };
const PC2 = '192.168.2.10';
/** The worker's tick is ~16–20 ms of wall; 20 ms keeps every slice boundary on a datagram's send time. */
const SLICE_MS = 20;
/** 50 packets per second: one datagram every 20 ms of sim time. */
const PACE_NS = 20 * MS;

function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

const pc = (name: string, ip: string, gw: string): string =>
  startup([[`hostname ${name}`], ['interface GigabitEthernet0', ` ip address ${ip} 255.255.255.0`], [`ip default-gateway ${gw}`]]);

/** PC1 192.168.1.10 — R1 — PC2 192.168.2.10 (a routed path: the router's copy keeps the tag), a shipped P3 world. */
function world(): Simulation {
  const sim = createSimulation({ seed: 3, profile: 'P3' });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: pc('PC1', '192.168.1.10', '192.168.1.1') });
  sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: pc('PC2', PC2, '192.168.2.1') });
  sim.addDevice({
    id: 'r1',
    type: 'router.nf2911',
    name: 'R1',
    startupConfig: startup([
      ['hostname R1'],
      ['interface GigabitEthernet0/0', ' ip address 192.168.1.1 255.255.255.0', ' no shutdown'],
      ['interface GigabitEthernet0/1', ' ip address 192.168.2.1 255.255.255.0', ' no shutdown'],
    ]),
  });
  sim.addLink({ id: 'l1', a: PC1_GI0, b: { device: 'r1', port: 'GigabitEthernet0/0' } });
  sim.addLink({ id: 'l2', a: { device: 'r1', port: 'GigabitEthernet0/1' }, b: PC2_GI0 });
  sim.runFor(60 * SEC);
  // warm every ARP cache with one bounded datagram, so the measured window holds the flow's own legs only
  expect(shell(sim, 'pc1', `flow start ${PC2} pps 50 size 60 count 1`)).toMatch(/^Flow f1 started: /);
  sim.runFor(5 * SEC);
  return sim;
}

/** One line in a fresh console session: the command's output and its job's. */
function shell(sim: Simulation, device: string, line: string): string {
  const s = sim.cli.open(device, 'console');
  const cursor = sim.trace(0).next;
  const r = sim.cli.exec(s, line);
  sim.runFor(0);
  const job = sim.trace(cursor).events.filter((e): e is Extract<TraceEvent, { kind: 'cliOutput' }> => e.kind === 'cliOutput' && e.session === s);
  return (r.output + job.map((e) => e.text).join('')).trim();
}

/** The worker's wiring (index.ts `attach`): resync from the engine's in-flight list, then observe every event. */
function attachClock(sim: Simulation, clock = createWorkerClock()): { clock: ReturnType<typeof createWorkerClock>; frames: FrameTx[] } {
  const frames: FrameTx[] = [];
  clock.resync(sim.snapshot({ devices: [] }).inflight);
  sim.onTrace((ev) => {
    clock.observe(ev);
    if (ev.kind === 'frameTx') frames.push(ev);
  });
  clock.setPlaying(true);
  return { clock, frames };
}

const inflightTraffic = (sim: Simulation): InflightFrame[] => sim.snapshot({ devices: [] }).inflight.filter((f) => isTrafficDatagram(f.pdu));

describe('R57(a): a traffic-generator flow does not hold the clock in slow motion', () => {
  it('a continuous 50 pps flow plays at the chosen rate, with a datagram always in flight', () => {
    const sim = world();
    expect(shell(sim, 'pc1', `flow start ${PC2} pps 50 size 60`)).toMatch(/^Flow f\d started: 50 packets per second .*until stopped/);
    // datagram 0 left in the command's own dispatch and is on the wire now: the resync must not clamp on it either
    expect(inflightTraffic(sim).length).toBe(1);
    const capture = sim.startCapture({ ports: [PC2_GI0], dir: 'rx' }); // "Keep keepalives and beacons" off
    const { clock, frames } = attachClock(sim);
    expect(clock.policy).toEqual(DEFAULT_CLOCK_POLICY);
    expect(clock.clampingFlights).toBe(0);

    // rate 1: 2 s of wall is exactly 2 s of sim time
    clock.setRate(1);
    const t0 = sim.now;
    let sawInflight = 0;
    for (let i = 0; i < 100; i++) {
      const advanced = clock.runSlice(sim, SLICE_MS);
      expect(advanced).toBe(SLICE_MS * MS);
      // every slice ends on a datagram's send time: one of its legs is in flight, and the clock is at full rate
      if (inflightTraffic(sim).length > 0) sawInflight++;
      expect(clock.clampingFlights).toBe(0);
      expect(clock.currentRate(sim.now)).toBe(MS);
    }
    expect(sim.now - t0).toBe(2 * SEC);
    expect(sawInflight).toBe(100);

    // rate 2 (the chosen rate): 1 s of wall is exactly 2 s of sim time
    clock.setRate(2);
    const t1 = sim.now;
    for (let i = 0; i < 50; i++) expect(clock.runSlice(sim, SLICE_MS)).toBe(2 * SLICE_MS * MS);
    expect(sim.now - t1).toBe(2 * SEC);
    expect(clock.currentRate(sim.now)).toBe(2 * MS);

    // 4 s of sim at 50 pps: datagrams 1..200 left PC1 (datagram 0 before the window, 200 at its last instant), and
    // every leg is the daemon's tagged, non-background frame (the Packets list and the canvas get it unchanged)
    const fromPc1 = frames.filter((f) => f.from.device === 'pc1');
    expect(fromPc1.length).toBe((4 * SEC) / PACE_NS);
    expect(fromPc1.map((f) => f.txStart - t0)).toEqual(Array.from({ length: 200 }, (_, k) => (k + 1) * PACE_NS));
    // datagrams 0..199 crossed R1 to PC2; datagram 200 is still on the first link
    expect(frames.filter((f) => f.to.device === 'pc2').length).toBe(200);
    expect(inflightTraffic(sim).map((f) => f.link)).toEqual(['l1']);
    expect(frames.every((f) => f.pdu.tag === TRAFFIC_DATAGRAM_TAG && f.background !== true)).toBe(true);
    // NetScope without "Keep keepalives and beacons" records every one that reached PC2
    expect(sim.captures().find((c) => c.id === capture)?.head).toBe(200);
  });

  it('the defect R57(a) records: the same flow with its legs re-tagged (ordinary frames) plays in slow motion', () => {
    // the same world and wiring, but every traffic leg reaches the clock without the daemon's tag: that is what the
    // clock saw before the fix (it clamped on every non-background leg), so the first case is not met by accident
    const sim = world();
    shell(sim, 'pc1', `flow start ${PC2} pps 50 size 60`);
    const old = createWorkerClock();
    old.resync(sim.snapshot({ devices: [] }).inflight.map((f) => ({ ...f, pdu: { ...f.pdu, tag: 'untagged' } })));
    sim.onTrace((ev) => old.observe(ev.kind === 'frameTx' ? { ...ev, pdu: { ...ev.pdu, tag: 'untagged' } } : ev));
    old.setPlaying(true);
    old.setRate(1);
    const t0 = sim.now;
    for (let i = 0; i < 100; i++) old.runSlice(sim, SLICE_MS);
    // 2 s of wall played well under a tenth of 2 s of sim time
    expect(sim.now - t0).toBeLessThan((2 * SEC) / 10);
  });

  it('a ping still clamps exactly as before while the flow runs', () => {
    const sim = world();
    shell(sim, 'pc1', `flow start ${PC2} pps 50 size 60`);
    const { clock, frames } = attachClock(sim);
    // the reference: a clock that never sees a traffic leg, i.e. the pre-R57 clock on the same world without the flow's legs
    const reference = createWorkerClock();
    reference.resync(sim.snapshot({ devices: [] }).inflight.filter((f) => !isTrafficDatagram(f.pdu)));
    sim.onTrace((ev) => {
      if (ev.kind === 'frameTx' && isTrafficDatagram(ev.pdu)) return;
      reference.observe(ev);
    });
    reference.setPlaying(true);
    clock.setRate(1);
    reference.setRate(1);

    const tPing = sim.now;
    expect(shell(sim, 'pc1', `ping ${PC2}`)).not.toBe('');
    const pings = (): FrameTx[] => frames.filter((f) => !isTrafficDatagram(f.pdu));
    expect(pings().length).toBeGreaterThan(0);
    let clampedSlices = 0;
    for (let i = 0; i < 3000 && sim.now < tPing + 8 * SEC; i++) {
      const rate = clock.currentRate(sim.now);
      expect(rate).toBe(reference.currentRate(sim.now));
      expect(clock.clampingFlights).toBe(reference.clampingFlights);
      if (rate < MS) {
        clampedSlices++;
        // P1 §3.14: the shortest clamping leg on the wire (or queued behind a datagram: its frameTx is out) spans
        // exactly minTransitWallMs of wall; the traffic legs in flight with it take no part
        const legs = pings().filter((f) => f.background !== true && f.arrive > sim.now);
        expect(legs.length).toBe(clock.clampingFlights);
        expect(legs.every((f) => /^ping#|^echo-reply$|^arp-/.test(f.pdu.tag ?? ''))).toBe(true);
        const minDur = Math.min(...legs.map((f) => Math.max(1, f.arrive - f.txStart)));
        expect(rate).toBe(minDur / DEFAULT_CLOCK_POLICY.minTransitWallMs);
      }
      clock.runSlice(sim, SLICE_MS);
    }
    // the ping's echo requests and replies were each drawn in slow motion: many clamped slices (400 ms per leg)
    const echo = pings().filter((f) => /^ping#|^echo-reply$/.test(f.pdu.tag ?? ''));
    expect(echo.length).toBeGreaterThanOrEqual(8);
    expect(clampedSlices).toBeGreaterThanOrEqual(echo.length * ((DEFAULT_CLOCK_POLICY.minTransitWallMs / SLICE_MS) - 1));
  });

  it('a traffic leg never clamps, whatever the policy or the simulation-mode filter; any other leg clamps as before', () => {
    const leg = (id: number, tag: string | undefined, span: number, background = false): TraceEvent => {
      const ev = {
        t: 0,
        kind: 'frameTx',
        pdu: { id, proto: 'ethernet', size: 78, summary: 'x', layers: ['ethernet', 'ipv4', 'udp', 'payload'], ...(tag !== undefined ? { tag } : {}) },
        link: 'l1',
        from: { device: 'a', port: 'p' },
        to: { device: 'b', port: 'p' },
        txStart: 0,
        txEnd: span / 2,
        arrive: span,
      } as FrameTx;
      if (background) ev.background = true;
      return ev;
    };
    const clock = createWorkerClock({ minTransitWallMs: 400 });
    clock.setPlaying(true);
    const traffic = leg(1, TRAFFIC_DATAGRAM_TAG, 800);
    clock.observe(traffic);
    expect(clock.clampingFlights).toBe(0);
    expect(clock.currentRate(0)).toBe(MS);
    // "Background frames" on: background legs clamp, a traffic leg still does not
    clock.setPolicy({ ignoreBackground: false });
    expect(clock.clampingFlights).toBe(0);
    // simulation mode with a filter the traffic leg matches: still no clamp
    const udp = { kinds: ['frameTx' as const], protos: ['udp'] };
    expect(matchesTraceFilter(udp, traffic)).toBe(true);
    clock.setClampFilter(udp);
    expect(clock.clampingFlights).toBe(0);
    clock.setClampFilter(null);
    clock.setPolicy({ ignoreBackground: true });

    // a ping leg beside it clamps on its own span, exactly as before (the shorter traffic leg takes no part)
    clock.observe(leg(2, 'ping#0', 4_000));
    expect(clock.clampingFlights).toBe(1);
    expect(clock.currentRate(0)).toBe(4_000 / 400);
    // an untagged leg and any other tag clamp too; a background leg only under "Background frames"
    clock.observe(leg(3, undefined, 2_000));
    expect(clock.currentRate(0)).toBe(2_000 / 400);
    clock.observe(leg(4, 'keepalive', 1_000, true));
    expect(clock.currentRate(0)).toBe(2_000 / 400);
    clock.setPolicy({ ignoreBackground: false });
    expect(clock.currentRate(0)).toBe(1_000 / 400);
    expect(clock.clampingFlights).toBe(3);

    // a resync from the engine's in-flight list keeps the exemption (the leg is rebuilt from InflightFrame)
    const inflight = (id: number, tag: string): InflightFrame => ({
      pdu: { id, proto: 'ethernet', size: 78, summary: 'x', tag },
      link: 'l1',
      from: { device: 'a', port: 'p' },
      to: { device: 'b', port: 'p' },
      txStart: 0,
      txEnd: 400,
      arrive: 800,
    });
    clock.resync([inflight(5, TRAFFIC_DATAGRAM_TAG)]);
    expect(clock.clampingFlights).toBe(0);
    expect(clock.currentRate(0)).toBe(MS);
    clock.resync([inflight(5, TRAFFIC_DATAGRAM_TAG), inflight(6, 'ping#1')]);
    expect(clock.clampingFlights).toBe(1);
    expect(clock.currentRate(0)).toBe(800 / 400);
  });
});

/**
 * Review finding 1 (W5 fix step): an unclamped flow at a high rate can outrun the engine — a slice ends on the sub-step
 * bound, or the worker caps a late tick's catch-up — and the rate the batch reports (`currentRate`, the canvas's
 * extrapolation and the "slow-motion" chip) must be the rate sim time really advances at.
 */
describe('R57(a): the reported rate is the rate the clock really achieves', () => {
  type SliceSim = Parameters<ReturnType<typeof createWorkerClock>['runSlice']>[0];
  /** A simulation with an event every `stepNs` (or none), whose `runUntil` just moves the clock. */
  const fakeSim = (stepNs: number | undefined): SliceSim => {
    let now = 0;
    return {
      get now() {
        return now;
      },
      nextEventTime: () => (stepNs === undefined ? undefined : now + stepNs),
      runUntil: (t: SimTime) => {
        now = t;
        return { events: 0, now, stopped: undefined };
      },
    } as unknown as SliceSim;
  };

  it('a slice cut by MAX_SUBSTEPS reports what it achieved; a slice that covers its wall time the full rate', () => {
    const clock = createWorkerClock();
    clock.setPlaying(true);
    clock.setRate(100);
    const dense = fakeSim(1_000);
    const advanced = clock.runSlice(dense, 16);
    // 5000 sub-steps of 1 µs: 5 ms of sim time instead of 1.6 s
    expect(advanced).toBe(MAX_SUBSTEPS * 1_000);
    const achieved = advanced / 16;
    expect(Math.abs(clock.currentRate(dense.now) - achieved) / achieved).toBeLessThan(1e-9);
    expect(clock.throughput).toBeLessThan(1);
    // paused: the chosen rate, whatever the last slice did
    clock.setPlaying(false);
    expect(clock.currentRate(dense.now)).toBe(100 * MS);
    clock.setPlaying(true);
    expect(clock.throughput).toBe(1);
    clock.runSlice(dense, 16);
    expect(clock.currentRate(dense.now)).toBeLessThan(100 * MS);
    // a new rate starts from the full rate; an idle slice that covers its wall time keeps it
    clock.setRate(100);
    expect(clock.currentRate(dense.now)).toBe(100 * MS);
    clock.runSlice(dense, 16);
    const idle = fakeSim(undefined);
    expect(clock.runSlice(idle, 16)).toBe(16 * 100 * MS);
    expect(clock.throughput).toBe(1);
    expect(clock.currentRate(idle.now)).toBe(100 * MS);
  });

  it('a capped catch-up (wall time that really passed above the slice) reports the share it covered', () => {
    const clock = createWorkerClock();
    clock.setPlaying(true);
    clock.setRate(100);
    const idle = fakeSim(undefined);
    // the worker gives at most 250 ms per slice; 385 ms really passed (the engine took that long)
    expect(clock.runSlice(idle, 250, { wallMs: 385 })).toBe(250 * 100 * MS);
    expect(clock.currentRate(idle.now)).toBe(100 * MS * (250 / 385));
    // the extrapolation over the next 385 ms lands where the next capped slice ends
    const predicted = idle.now + clock.currentRate(idle.now) * 385;
    clock.runSlice(idle, 250, { wallMs: 385 });
    expect(Math.abs(predicted - idle.now)).toBeLessThan(1e-3);
    // a wall time not above the slice changes nothing
    clock.runSlice(idle, 16, { wallMs: 16 });
    expect(clock.currentRate(idle.now)).toBe(100 * MS);
    clock.runSlice(idle, 16, { wallMs: 10 });
    expect(clock.currentRate(idle.now)).toBe(100 * MS);
    // a new world starts from the full rate
    clock.runSlice(idle, 250, { wallMs: 500 });
    expect(clock.throughput).toBe(0.5);
    clock.resync([]);
    expect(clock.currentRate(idle.now)).toBe(100 * MS);
  });

  it('a 1000 pps flow: exactly the chosen rate at 10x; at 100x each batch predicts where the next one lands', () => {
    const sim = world();
    expect(shell(sim, 'pc1', `flow start ${PC2} pps 1000 size 60`)).toMatch(/^Flow f\d started: 1000 packets per second/);
    const { clock } = attachClock(sim);
    clock.setRate(10);
    for (let i = 0; i < 20; i++) {
      expect(clock.runSlice(sim, 16)).toBe(10 * 16 * MS);
      expect(clock.currentRate(sim.now)).toBe(10 * MS);
    }
    clock.setRate(100);
    let rate = clock.currentRate(sim.now);
    let before = sim.now;
    for (let i = 0; i < 20; i++) {
      const advanced = clock.runSlice(sim, 16);
      // the sub-step bound cuts the slice well short of 1.6 s
      expect(advanced).toBeLessThan(0.8 * 100 * 16 * MS);
      if (i > 0) {
        // the canvas, extrapolating 16 ms from the last batch with its effectiveRate, lands within 2 % of this one
        // (before the fix it reported the chosen 100x and ran ahead by more than half a slice every batch)
        expect(Math.abs(before + rate * 16 - sim.now)).toBeLessThan(0.02 * advanced);
      }
      rate = clock.currentRate(sim.now);
      expect(rate).toBeLessThan(100 * MS);
      expect(Math.abs(rate * 16 - advanced) / advanced).toBeLessThan(1e-9);
      before = sim.now;
    }
  });
});
