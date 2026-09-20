/**
 * P1 acceptance — duplex mismatch (ARCHITECTURE-P1 §10.2 `accept.p1.duplex-mismatch`; §3.5, §4.9).
 *
 * The classic wiring-closet fault: someone forces `speed 100` and `duplex full` on the switch port while the PC is
 * left on autonegotiation. The PC can only parallel-detect the speed, so it takes HALF duplex, and the cable becomes
 * a two-station collision domain whose two ends disagree.
 *
 * Checked on the real two-PC lab: `phyNegotiated` reports `mismatch: 'duplex'` and both port views say so; under
 * load the half-duplex end counts late collisions and drops its own frames, while the full-duplex end — which never
 * senses carrier and never sees a collision — counts the aborted frames as runts and FCS errors; the loss is
 * partial, not total, which is what makes the fault so hard to find; and putting the switch port back on
 * `speed auto` / `duplex auto` clears the mismatch and the traffic flows again.
 *
 * The load is a sweep: both PCs ping each other, with PC1 starting a few hundred nanoseconds to a few microseconds
 * after PC2. At 100 Mb/s a frame is on the wire for only a few microseconds, so that offset is exactly what decides
 * whether the switch starts transmitting inside PC1's frame and past the slot time — some rounds collide late, some
 * get through untouched, and that is the partial loss.
 *
 * ponytail: the offsets are typed in the test rather than drawn, because a deterministic engine gives a
 * deterministic collision pattern; the sweep is the load generator the CLI does not have (`ping` takes no repeat
 * count).
 */
import { describe, expect, it } from 'vitest';
import type { PortCounters } from '../src/contracts/port.js';
import { SPEED_100M } from '../src/contracts/port.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { booted, ofKind, output } from './sim.harness.js';

const SEED = 3;
const PC1_NIC = 'GigabitEthernet0';
const SW_PORT = 'FastEthernet0/1';
const CABLE = 'l_pc1_sw1';
const SEGMENT = 'seg:l_pc1_sw1';

/** The misconfiguration of §10.2, and the line pair that undoes it. */
const FORCED: readonly string[] = [`interface ${SW_PORT}`, 'speed 100', 'duplex full'];
const AUTO: readonly string[] = [`interface ${SW_PORT}`, 'speed auto', 'duplex auto'];

/** What each end ends up running: the PC parallel-detects the speed and falls back to half duplex. */
const PC_END = { speedBps: SPEED_100M, duplex: 'half', autoneg: true, via: 'parallel-detect' } as const;
const SW_END = { speedBps: SPEED_100M, duplex: 'full', autoneg: false, via: 'forced' } as const;

/** Start offsets of PC1's ping behind PC2's, in nanoseconds: less than one frame time at 100 Mb/s. */
const OFFSETS_NS: readonly number[] = [0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000];

/** Apply `lines` through the headless validator; a line that fails is a test bug. */
function configured(sim: Simulation, dev: string, lines: readonly string[]): void {
  const r = sim.configure(dev, lines);
  if (!r.ok) throw new Error(`${dev} setup failed: ${JSON.stringify(r.lines.filter((l) => !l.ok))}`);
}

/** The two-PC lab, booted, with PC1's ARP cache already warm so the sweep below measures only the mismatch. */
function lab(seed = SEED, mismatched = true): Simulation {
  const sim = booted(twoPcsAndSwitch(), seed);
  if (mismatched) configured(sim, 'sw1', FORCED);
  sim.runToIdle();
  const warm = sim.cli.open('pc1', 'console');
  sim.cli.exec(warm, 'ping 10.0.0.2');
  sim.runToIdle();
  return sim;
}

const counters = (sim: Simulation, dev: string, port: string): PortCounters => sim.device(dev)!.port(port)!.counters;

/** Echo replies a ping reported, from its own console output. */
function received(text: string): number {
  const m = /received (\d+)/.exec(text);
  if (m === null) throw new Error(`no ping summary in ${JSON.stringify(text)}`);
  return Number(m[1]);
}

/** One round: PC2 starts pinging, PC1 joins `offsetNs` later, both run to completion. */
function pingRound(sim: Simulation, offsetNs: number): { pc1: number; pc2: number } {
  const cursor = sim.trace(0).next;
  const b = sim.cli.open('pc2', 'console');
  expect(sim.cli.exec(b, 'ping 10.0.0.1').error).toBeUndefined();
  if (offsetNs > 0) sim.runFor(offsetNs);
  const a = sim.cli.open('pc1', 'console');
  expect(sim.cli.exec(a, 'ping 10.0.0.2').error).toBeUndefined();
  sim.runToIdle();
  const evs = sim.trace(cursor).events;
  return { pc1: received(output(evs, a)), pc2: received(output(evs, b)) };
}

/** The whole sweep, one round per offset, a second of quiet between rounds. */
function load(sim: Simulation): { pc1: number; pc2: number }[] {
  return OFFSETS_NS.map((offset) => {
    const round = pingRound(sim, offset);
    sim.runFor(SEC);
    return round;
  });
}

/** Echo replies delivered / echo requests sent over a sweep (5 requests per ping, two pings per round). */
function delivery(rounds: readonly { pc1: number; pc2: number }[]): { got: number; sent: number } {
  return { got: rounds.reduce((n, r) => n + r.pc1 + r.pc2, 0), sent: rounds.length * 2 * 5 };
}

describe('accept P1: the switch port is forced, the PC is not', () => {
  it('negotiates 100 Mb/s with different duplex modes and publishes the mismatch on both ends', () => {
    const sim = lab();
    const link = sim.link(CABLE)!;
    expect(link.up).toBe(true);
    expect(link.negotiatedBps).toBe(SPEED_100M);
    expect(link.phy).toEqual({ a: PC_END, b: SW_END, mismatch: 'duplex' });
    expect(link.segment).toBe(SEGMENT);

    const negotiated = ofKind(sim.trace(0).events, 'phyNegotiated').filter((e) => e.link === CABLE).at(-1)!;
    expect(negotiated).toMatchObject({ link: CABLE, a: PC_END, b: SW_END, mismatch: 'duplex' });

    const pc = sim.device('pc1')!.port(PC1_NIC)!;
    const sw = sim.device('sw1')!.port(SW_PORT)!;
    expect([pc.duplex, sw.duplex]).toEqual(['half', 'full']);
    expect(pc.phy).toMatchObject({ duplexMismatch: true, medium: 'segment', segment: SEGMENT, end: PC_END });
    expect(sw.phy).toMatchObject({ duplexMismatch: true, medium: 'segment', segment: SEGMENT, end: SW_END });

    // A two-station collision domain, and only on this cable: PC2's link is untouched.
    const segment = sim.snapshot().media!.segments.find((s) => s.id === SEGMENT)!;
    expect(segment.members.map((m) => [m.port.device, m.duplex])).toEqual([
      ['pc1', 'half'],
      ['sw1', 'full'],
    ]);
    expect(sim.link('l_pc2_sw1')!.phy).toBeUndefined();
  });

  it('under load the half end counts late collisions and the full end counts runts and FCS errors', () => {
    const sim = lab();
    const before = { ...counters(sim, 'pc1', PC1_NIC) };
    const cursor = sim.trace(0).next;
    load(sim);

    // The half-duplex end: it detects the switch starting on top of it, well past the slot time.
    const pc = counters(sim, 'pc1', PC1_NIC);
    expect(pc.lateCollisions ?? 0).toBeGreaterThan(0);
    expect(pc.collisions).toBeGreaterThan(before.collisions);
    expect(pc.collisions).toBeGreaterThanOrEqual(pc.lateCollisions ?? 0);
    expect(pc.outDrops).toBeGreaterThan(0);

    // The full-duplex end: it never senses carrier, so it never counts a collision — it sees wreckage instead.
    const sw = counters(sim, 'sw1', SW_PORT);
    expect(sw.collisions).toBe(0);
    expect(sw.lateCollisions ?? 0).toBe(0);
    expect(sw.runts).toBeGreaterThan(0);
    expect(sw.crcErrors).toBeGreaterThan(0);
    expect(sw.runts + sw.crcErrors).toBe(sw.inErrors);

    // The wreckage is the half end's aborted frames, and it is the half end that gives up on them.
    const drops = ofKind(sim.trace(cursor).events, 'drop');
    expect(drops.filter((d) => d.device === 'pc1' && d.reason === 'late-collision').length).toBe(pc.lateCollisions);
    expect(drops.filter((d) => d.device === 'sw1' && (d.reason === 'runt' || d.reason === 'fcs-error')).length).toBe(sw.inErrors);
  });

  it('loses part of the traffic, not all of it: some rounds go through untouched', () => {
    const sim = lab();
    const rounds = load(sim);
    const { got, sent } = delivery(rounds);
    expect(got).toBeGreaterThan(0);
    expect(got).toBeLessThan(sent);
    // Both extremes are present: rounds where every echo came back, and rounds where none did.
    expect(rounds.some((r) => r.pc1 === 5 && r.pc2 === 5)).toBe(true);
    expect(rounds.some((r) => r.pc1 === 0 && r.pc2 === 0)).toBe(true);
    // Which rounds fail depends only on the offset, so the same lab loses the same frames every time.
    expect(load(lab())).toEqual(rounds);
  });

  it('putting the port back on auto clears the mismatch and the traffic flows again', () => {
    const sim = lab();
    load(sim);
    const damaged = { pc: { ...counters(sim, 'pc1', PC1_NIC) }, sw: { ...counters(sim, 'sw1', SW_PORT) } };
    expect(damaged.pc.lateCollisions ?? 0).toBeGreaterThan(0);

    configured(sim, 'sw1', AUTO);
    const link = sim.link(CABLE)!;
    expect([link.up, link.phy, link.segment, link.negotiatedBps]).toEqual([true, undefined, undefined, SPEED_100M]);
    expect(sim.device('pc1')!.port(PC1_NIC)!.phy?.duplexMismatch).toBeUndefined();
    expect(sim.device('sw1')!.port(SW_PORT)!.phy?.duplexMismatch).toBeUndefined();
    expect(sim.snapshot().media?.segments ?? []).toEqual([]);
    expect(sim.device('pc1')!.port(PC1_NIC)!.duplex).toBe('full');

    // The very same load now arrives in full, and neither end records a new error.
    const after = load(sim);
    const { got, sent } = delivery(after);
    expect(got).toBe(sent);
    const pc = counters(sim, 'pc1', PC1_NIC);
    const sw = counters(sim, 'sw1', SW_PORT);
    expect(pc.lateCollisions ?? 0).toBe(damaged.pc.lateCollisions ?? 0);
    expect(pc.collisions).toBe(damaged.pc.collisions);
    expect([sw.runts, sw.crcErrors, sw.inErrors]).toEqual([damaged.sw.runts, damaged.sw.crcErrors, damaged.sw.inErrors]);
  });

  it('a lab that was never misconfigured shows none of this', () => {
    const sim = lab(SEED, false);
    expect(sim.link(CABLE)!.phy).toBeUndefined();
    const { got, sent } = delivery(load(sim));
    expect(got).toBe(sent);
    expect(counters(sim, 'pc1', PC1_NIC).lateCollisions ?? 0).toBe(0);
    expect(counters(sim, 'sw1', SW_PORT).inErrors).toBe(0);
  });
});
