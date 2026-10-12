/**
 * Traffic-generator legs on the canvas (ARCHITECTURE-P3 §9.2 ruling R57(a); the W5 fix step, review finding 0).
 *
 * The worker clock never clamps on a traffic leg, so the leg spans microseconds of sim time at the chosen rate; placed
 * at `now` like every other leg it is on screen in no render frame, while R57(a) keeps the stream on the canvas. Under
 * test, in a real P3 world (PC1, router R1, PC2) played through `createWorkerClock` in the worker's 16 ms ticks, its
 * batches merged by the store's `reconcileInflight` and drawn at 60 fps on instants not aligned with the flow's pace
 * (`extrapolatedNow`), through the real `PacketLayer`:
 *  - the defect: without the pacer no frame holds a capsule;
 *  - with it every frame does, on both Ethernet hops, each lane carrying the flow's 20 ms spacing (20 capsules on a
 *    400 ms crossing at rate 1) and a bounded sample at rate 10 (the store has already dropped most of those legs);
 *  - pausing freezes the stream; a leg really slower than the pace is drawn at `now`; a new world forgets the stream;
 *    every other leg is placed exactly as before.
 */
import { describe, expect, it } from 'vitest';
import { Container } from 'pixi.js';
import { createSimulation, MS, SEC, type InflightFrame, type LinkSnapshot, type Simulation, type TraceEvent } from '@netforge/engine';
import { createWorkerClock } from '../src/bridge/worker/clock';
import { DEFAULT_CLOCK_POLICY, isTrafficDatagram, TRAFFIC_DATAGRAM_TAG } from '../src/bridge/protocol';
import { framePlacement, PacketLayer, type PacketUpdateInput } from '../src/canvas/packets';
import { TRAFFIC_LANE_GAP_MS, TRAFFIC_LEG_WALL_MS, TrafficLegPacer, type PacedLeg } from '../src/canvas/traffic-legs';
import { reconcileInflight } from '../src/store/store';
import { extrapolatedNow } from '../src/store/selectors';
import { TEST_THEME } from './canvas-fixtures.js';

const PC1_GI0 = { device: 'pc1', port: 'GigabitEthernet0' };
const PC2_GI0 = { device: 'pc2', port: 'GigabitEthernet0' };
const R1_G0 = { device: 'r1', port: 'GigabitEthernet0/0' };
const R1_G1 = { device: 'r1', port: 'GigabitEthernet0/1' };
const PC2 = '192.168.2.10';
/** The worker's tick (index.ts TICK_MS). */
const TICK_MS = 16;
/** 60 Hz render frames, 7 ms out of phase with the ticks (never on a datagram's send instant). */
const FRAME_MS = 1000 / 60;
const PHASE_MS = 7;

function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

const pc = (name: string, ip: string, gw: string): string =>
  startup([[`hostname ${name}`], ['interface GigabitEthernet0', ` ip address ${ip} 255.255.255.0`], [`ip default-gateway ${gw}`]]);

/** PC1 192.168.1.10 — R1 — PC2 192.168.2.10, a P3 world with warm ARP caches, a continuous 50 pps flow running. */
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
  sim.addLink({ id: 'l1', a: PC1_GI0, b: R1_G0 });
  sim.addLink({ id: 'l2', a: R1_G1, b: PC2_GI0 });
  sim.runFor(60 * SEC);
  shell(sim, 'pc1', `flow start ${PC2} pps 50 size 60 count 1`);
  sim.runFor(5 * SEC);
  expect(shell(sim, 'pc1', `flow start ${PC2} pps 50 size 60`)).toMatch(/^Flow f\d started: 50 packets per second/);
  return sim;
}

function shell(sim: Simulation, device: string, line: string): string {
  const s = sim.cli.open(device, 'console');
  const cursor = sim.trace(0).next;
  const r = sim.cli.exec(s, line);
  sim.runFor(0);
  const job = sim.trace(cursor).events.filter((e): e is Extract<TraceEvent, { kind: 'cliOutput' }> => e.kind === 'cliOutput' && e.session === s);
  return (r.output + job.map((e) => e.text).join('')).trim();
}

const LINKS = new Map<string, LinkSnapshot>([
  ['l1', { id: 'l1', a: PC1_GI0, b: R1_G0 } as LinkSnapshot],
  ['l2', { id: 'l2', a: R1_G1, b: PC2_GI0 } as LinkSnapshot],
]);
const GEOM = { p0: { x: 0, y: 0 }, p1: { x: 30, y: 0 }, p2: { x: 70, y: 0 }, p3: { x: 100, y: 0 } };

function layerInput(inflight: readonly InflightFrame[], now: number, pace?: PacketUpdateInput['pace']): PacketUpdateInput {
  const input: PacketUpdateInput = {
    inflight,
    now,
    paths: { links: LINKS, cable: () => GEOM, beam: () => undefined, air: () => undefined },
    theme: TEST_THEME,
    colourByFlow: false,
    selectedPdu: null,
    trails: true,
    showBackground: false,
    zoom: 0.5, // no letters: no text to render
    view: { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 },
    textResolution: 1,
  };
  if (pace !== undefined) input.pace = pace;
  return input;
}

interface Frame {
  wall: number;
  now: number;
  /** Legs `PacketLayer` drew without the pacer (P1: every leg at `now`). */
  drawnAtNow: number;
  /** Legs `PacketLayer` drew with the pacer (the canvas since R57(a)). */
  drawnPaced: number;
  /** What the pacer returned, per lane (link → receiver). */
  lanes: Map<string, PacedLeg[]>;
}

/**
 * Play `wallMs` of wall time as the app does: worker ticks of 16 ms (the clock's slice, then a batch the store merges),
 * render frames at 60 Hz between them, each drawing `extrapolatedNow` with and without the pacer.
 */
function play(sim: Simulation, rate: number, wallMs: number, playing: (wall: number) => boolean = () => true): Frame[] {
  const clock = createWorkerClock();
  const pending: TraceEvent[] = [];
  clock.resync(sim.snapshot({ devices: [] }).inflight);
  const off = sim.onTrace((ev) => {
    clock.observe(ev);
    pending.push(ev);
  });
  clock.setRate(rate);
  const p1 = new PacketLayer(new Container());
  const paced = new PacketLayer(new Container());
  const pacer = new TrafficLegPacer();
  let inflight: InflightFrame[] = reconcileInflight([], [], sim.now, sim.snapshot({ devices: [] }).inflight);
  let state = { now: sim.now, nowWall: 0, playing: true, effectiveRate: rate * MS };
  const frames: Frame[] = [];
  let render = PHASE_MS;
  for (let tick = TICK_MS; tick <= wallMs; tick += TICK_MS) {
    while (render < tick) {
      const now = extrapolatedNow(state, render);
      const pace = { wall: render, playing: state.playing, effectiveRate: state.effectiveRate, epoch: 0 };
      const lanes = new Map<string, PacedLeg[]>();
      for (const l of pacer.step({ ...pace, inflight, now })) {
        const lane = `${l.frame.link}>${l.frame.to.device}`;
        lanes.set(lane, [...(lanes.get(lane) ?? []), l]);
      }
      frames.push({ wall: render, now, drawnAtNow: p1.update(layerInput(inflight, now)), drawnPaced: paced.update(layerInput(inflight, now, pace)), lanes });
      render += FRAME_MS;
    }
    const on = playing(tick);
    clock.setPlaying(on);
    if (on) clock.runSlice(sim, TICK_MS);
    inflight = reconcileInflight(inflight, pending.splice(0), sim.now, undefined);
    state = { now: sim.now, nowWall: tick, playing: on, effectiveRate: clock.currentRate(sim.now) };
  }
  off();
  return frames;
}

/** The share of its crossing a paced leg has made (`at` on the leg's own span). */
const progress = (l: PacedLeg): number => (l.at - l.frame.txStart) / (l.frame.arrive - l.frame.txStart);

describe('R57(a): traffic-generator legs stay on the canvas', () => {
  it('rate 1: placed at `now` the stream is never drawn; paced, every frame draws it with the flow spacing', () => {
    const sim = world();
    const frames = play(sim, 1, 6000);
    expect(frames.length).toBeGreaterThanOrEqual(355);
    // the defect: an 800 ns leg every 20 ms is on the wire at no 60 Hz instant
    expect(frames.every((f) => f.drawnAtNow === 0)).toBe(true);
    // paced: from the first frame on, the layer draws the stream
    expect(frames.every((f) => f.drawnPaced > 0)).toBe(true);
    // once a full crossing time has passed, each Ethernet hop carries 20 capsules (a 400 ms crossing, one start every
    // 20 ms; 19 while the newest datagram's batch is still on its way), spaced by exactly one datagram's pace
    const settled = frames.filter((f) => f.wall >= TRAFFIC_LEG_WALL_MS + TICK_MS);
    for (const f of settled) {
      for (const lane of ['l1>r1', 'l2>pc2']) {
        const legs = f.lanes.get(lane) ?? [];
        expect(legs.length === 19 || legs.length === 20, `${lane} at ${f.wall}: ${legs.length}`).toBe(true);
        expect(legs.every((l) => l.paced && isTrafficDatagram(l.frame.pdu) && framePlacement(l.frame, l.at) !== undefined)).toBe(true);
        const p = legs.map(progress).sort((a, b) => a - b);
        for (let i = 1; i < p.length; i++) expect(p[i]! - p[i - 1]!).toBeCloseTo((20 * MS) / MS / TRAFFIC_LEG_WALL_MS, 6);
      }
    }
    // a capsule moves forward from frame to frame (the same leg, further along)
    const a = settled[0]!.lanes.get('l1>r1')!;
    const b = settled[1]!.lanes.get('l1>r1')!;
    const leg = a.find((l) => b.some((m) => m.frame.pdu.id === l.frame.pdu.id))!;
    const next = b.find((m) => m.frame.pdu.id === leg.frame.pdu.id)!;
    expect(progress(next) - progress(leg)).toBeCloseTo(FRAME_MS / TRAFFIC_LEG_WALL_MS, 6);
  });

  it('rate 10: every frame draws the stream, at most one crossing per lane every 16 ms of pace', () => {
    const sim = world();
    const frames = play(sim, 10, 3000);
    expect(frames.every((f) => f.drawnAtNow === 0)).toBe(true);
    expect(frames.every((f) => f.drawnPaced > 0)).toBe(true);
    const bound = Math.floor(TRAFFIC_LEG_WALL_MS / TRAFFIC_LANE_GAP_MS) + 1;
    for (const f of frames.filter((x) => x.wall >= TRAFFIC_LEG_WALL_MS + TICK_MS)) {
      for (const lane of ['l1>r1', 'l2>pc2']) {
        const n = f.lanes.get(lane)?.length ?? 0;
        expect(n).toBeGreaterThanOrEqual(bound - 3);
        expect(n).toBeLessThanOrEqual(bound);
      }
    }
  });

  it('pausing freezes the stream where it is; playing again moves it on', () => {
    const sim = world();
    // play 1 s, pause 1 s, play 1 s
    const frames = play(sim, 1, 3000, (wall) => wall <= 1000 || wall > 2000);
    const paused = frames.filter((f) => f.wall > 1000 + TICK_MS && f.wall < 2000);
    expect(paused.length).toBeGreaterThan(50);
    const key = (f: Frame): string =>
      [...f.lanes.values()]
        .flat()
        .map((l) => `${l.frame.pdu.id}@${l.at}`)
        .sort()
        .join(',');
    expect(paused[0]!.drawnPaced).toBeGreaterThan(0);
    for (const f of paused) expect(key(f)).toBe(key(paused[0]!));
    const after = frames.filter((f) => f.wall > 2000 + TICK_MS);
    expect(key(after[0]!)).not.toBe(key(paused[0]!));
    expect(after.every((f) => f.drawnPaced > 0)).toBe(true);
  });
});

describe('the traffic pacer', () => {
  const leg = (id: number, txStart: number, span: number, tag: string | undefined = TRAFFIC_DATAGRAM_TAG, link = 'l1'): InflightFrame => ({
    pdu: { id, proto: 'ethernet', size: 78, summary: 'x', ...(tag !== undefined ? { tag } : {}) },
    link,
    from: PC1_GI0,
    to: R1_G0,
    txStart,
    txEnd: txStart + span / 2,
    arrive: txStart + span,
  });
  const at = (pacer: TrafficLegPacer, inflight: InflightFrame[], now: number, wall: number, epoch = 0, playing = true): PacedLeg[] =>
    pacer.step({ inflight, now, wall, playing, effectiveRate: MS, epoch });

  it('crosses a leg in TRAFFIC_LEG_WALL_MS of wall (the clamp span) and then lets it go', () => {
    expect(TRAFFIC_LEG_WALL_MS).toBe(DEFAULT_CLOCK_POLICY.minTransitWallMs);
    const pacer = new TrafficLegPacer();
    const f = leg(1, 0, 800);
    expect(at(pacer, [f], 0, 0)).toEqual([{ frame: f, at: 0, paced: false }]);
    // rate 1: 100 ms of wall later the leg arrived long ago in sim time, and is drawn a quarter of the way along
    const q = at(pacer, [f], 100 * MS, 100);
    expect(q.length).toBe(1);
    expect(q[0]!.at).toBe(200);
    expect(q[0]!.paced).toBe(true);
    // the store dropped it: it still finishes its crossing, then is gone
    expect(at(pacer, [], 300 * MS, 300)[0]!.at).toBe(600);
    expect(at(pacer, [], 400 * MS, 400)).toEqual([]);
    expect(pacer.crossings).toBe(0);
  });

  it('a leg slower than the pace is drawn at `now`, as P1 draws it; a non-traffic leg is not the pacer\'s', () => {
    const pacer = new TrafficLegPacer();
    const slow = leg(1, 0, 2 * SEC);
    const ping = leg(2, 0, 800, 'ping#0');
    for (const wall of [0, 100, 400, 1000, 1900]) {
      const out = at(pacer, [slow, ping], wall * MS, wall);
      expect(out).toEqual([{ frame: slow, at: wall * MS, paced: false }]);
    }
    expect(at(pacer, [slow, ping], 2 * SEC, 2000)).toEqual([]);
  });

  it('a leg delivered late is back-dated to where the drawn clock passed its start', () => {
    const pacer = new TrafficLegPacer();
    at(pacer, [], 0, 0);
    // first seen 100 ms of wall after it started (rate 1): already a quarter of the way along
    const out = at(pacer, [leg(1, 0, 800)], 100 * MS, 100);
    expect(out).toEqual([{ frame: leg(1, 0, 800), at: 200, paced: true }]);
    // first seen a whole crossing after it started (and long arrived): never drawn
    const late = new TrafficLegPacer();
    at(late, [], 0, 0);
    expect(at(late, [leg(2, 0, 800)], TRAFFIC_LEG_WALL_MS * MS, TRAFFIC_LEG_WALL_MS)).toEqual([]);
    expect(late.crossings).toBe(0);
  });

  it('a pause stands the pace clock still; a new world forgets every crossing', () => {
    const pacer = new TrafficLegPacer();
    const f = leg(1, 0, 800);
    at(pacer, [f], 0, 0);
    const before = at(pacer, [f], 100 * MS, 100);
    expect(at(pacer, [f], 100 * MS, 700, 0, false)).toEqual(before);
    expect(pacer.paceMs).toBe(100);
    expect(at(pacer, [], 100 * MS, 800, 1)).toEqual([]);
    expect(pacer.crossings).toBe(0);
    expect(pacer.paceMs).toBe(0);
  });

  it('samples a lane: two starts within TRAFFIC_LANE_GAP_MS of pace give one crossing; another lane is its own', () => {
    const pacer = new TrafficLegPacer();
    at(pacer, [], 0, 0);
    const a = leg(1, 10 * MS, 800);
    const b = leg(2, 10 * MS + (TRAFFIC_LANE_GAP_MS - 1) * MS, 800);
    const c = leg(3, 10 * MS + (TRAFFIC_LANE_GAP_MS - 1) * MS, 800, TRAFFIC_DATAGRAM_TAG, 'l2');
    const d = leg(4, 10 * MS + TRAFFIC_LANE_GAP_MS * MS, 800);
    const out = at(pacer, [a, b, c, d], 40 * MS, 40);
    expect(out.map((l) => l.frame.pdu.id).sort()).toEqual([1, 3, 4]);
  });

  it('places every other leg exactly as before: the layer draws the same with and without the pacer', () => {
    const ping = leg(2, 0, 800, 'ping#0');
    const arp = leg(3, 100, 800, 'arp-request');
    for (const now of [0, 300, 799, 850, 1000]) {
      const p1 = new PacketLayer(new Container()).update(layerInput([ping, arp], now));
      const paced = new PacketLayer(new Container()).update(layerInput([ping, arp], now, { wall: now, playing: true, effectiveRate: MS, epoch: 0 }));
      expect(paced).toBe(p1);
      expect(p1).toBe([ping, arp].filter((f) => framePlacement(f, now) !== undefined).length);
    }
  });
});
