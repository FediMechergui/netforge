/**
 * Traffic-generator legs on the canvas (ARCHITECTURE-P3 §9.2 ruling R57(a), the W5 fix step).
 *
 * The worker clock never clamps on a leg of a traffic-generator datagram (bridge/worker/clock.ts), so such a leg spans
 * microseconds of sim time while the clock runs at the chosen rate: drawn like every other leg (only while
 * `txStart <= now < arrive`), it would almost never be on screen — a 50 pps flow is on an Ethernet hop about 0.04 % of
 * the time. R57(a) keeps the stream on the canvas, so the packet layer paces these legs itself, on wall time, without
 * holding the clock:
 *
 *  - a paced leg is drawn at the sim instant `at = min(now, txStart + p·(arrive − txStart))`, where `p` is the share of
 *    `TRAFFIC_LEG_WALL_MS` (the clamp's `minTransitWallMs`: the crossing time P1 gives every leg) of pace time since
 *    its crossing began; a leg really slower than that (a slow serial line in slow motion, a clock held by a ping) is
 *    drawn at `now`, exactly as P1 draws it;
 *  - the pace clock runs with wall time while playing and stands still while paused;
 *  - a crossing begins when the drawn clock passes the leg's `txStart`, back-dated by `(now − txStart) / effectiveRate`
 *    (a batch can deliver a leg after the extrapolated clock passed its start), so a flow's capsules keep its spacing;
 *  - on one lane (link and receiver) a crossing begins at most every `TRAFFIC_LANE_GAP_MS` of pace time, so a fast flow
 *    at a high rate draws a bounded sample of its datagrams (at most `TRAFFIC_LEG_WALL_MS / TRAFFIC_LANE_GAP_MS + 1`
 *    per lane); a leg on the wire at `now` always crosses;
 *  - a new world (epoch) forgets every paced leg.
 *
 * Every other leg is placed at `now` exactly as before. Pure (no pixi): the packet layer draws what `step` returns.
 */
import type { InflightFrame, SimTime } from '@netforge/engine';
import { inflightKey } from '@netforge/engine/web';
import { DEFAULT_CLOCK_POLICY, isTrafficDatagram } from '../bridge/protocol';

/** Wall ms a traffic leg takes to cross its link on screen: what the clamp gives every other leg. */
export const TRAFFIC_LEG_WALL_MS = DEFAULT_CLOCK_POLICY.minTransitWallMs;
/** Least pace time between the starts of two crossings on one lane (about one 60 Hz frame). */
export const TRAFFIC_LANE_GAP_MS = 16;
/** Float slack on the lane gap (back-dated starts of an evenly paced flow differ by rounding only). */
const GAP_SLACK_MS = 1e-6;

/** What the clock tells the pacer each frame. */
export interface TrafficPaceInput {
  inflight: readonly InflightFrame[];
  /** The drawn (extrapolated) sim time. */
  now: SimTime;
  /** Wall ms (the canvas's sample of it: reduced motion steps it). */
  wall: number;
  playing: boolean;
  /** Sim ns per wall ms the drawn clock runs at (the store's `effectiveRate`). */
  effectiveRate: number;
  /** The world: a new one forgets every paced leg. */
  epoch: number;
}

/** A traffic leg to draw, and the sim instant to place it at (`framePlacement(frame, at)`). */
export interface PacedLeg {
  readonly frame: InflightFrame;
  readonly at: SimTime;
  /** True while it is drawn ahead of `now` (on pace time) rather than at `now`. */
  readonly paced: boolean;
}

const laneOf = (f: InflightFrame): string => `${f.link}|${f.to.device}|${f.to.port}`;

export class TrafficLegPacer {
  private pace = 0;
  private lastWall: number | undefined;
  private epoch: number | undefined;
  /** Legs already considered (crossing or sampled out), by leg key, with their `txStart`. */
  private readonly seen = new Map<string, SimTime>();
  /** Legs crossing, by leg key: the frame (its newest copy) and the pace time its crossing began. */
  private readonly crossing = new Map<string, { frame: InflightFrame; t0: number }>();
  /** Per lane, the pace time the newest crossing began. */
  private readonly laneLast = new Map<string, number>();

  /** Pace time (ms): wall time while playing. */
  get paceMs(): number {
    return this.pace;
  }

  /** Legs crossing right now (tests). */
  get crossings(): number {
    return this.crossing.size;
  }

  reset(): void {
    this.pace = 0;
    this.lastWall = undefined;
    this.seen.clear();
    this.crossing.clear();
    this.laneLast.clear();
  }

  /** Advance to this frame and return every traffic leg to draw. */
  step(input: TrafficPaceInput): PacedLeg[] {
    if (input.epoch !== this.epoch) {
      this.reset();
      this.epoch = input.epoch;
    }
    if (this.lastWall !== undefined && input.playing) this.pace += Math.max(0, input.wall - this.lastWall);
    this.lastWall = input.wall;
    const { now } = input;
    const rate = Number.isFinite(input.effectiveRate) && input.effectiveRate > 0 ? input.effectiveRate : 0;

    const listed = new Map<string, InflightFrame>();
    const fresh: Array<{ key: string; f: InflightFrame }> = [];
    for (const f of input.inflight) {
      if (!isTrafficDatagram(f.pdu)) continue;
      const key = inflightKey(f.pdu.id, f.link, f.to);
      listed.set(key, f);
      if (this.seen.get(key) === f.txStart || f.txStart > now) continue;
      fresh.push({ key, f });
    }
    // the store drops a leg some time after it arrived; what it no longer lists is never seen again
    for (const key of this.seen.keys()) if (!listed.has(key)) this.seen.delete(key);

    fresh.sort((a, b) => a.f.txStart - b.f.txStart || a.f.pdu.id - b.f.pdu.id);
    for (const { key, f } of fresh) {
      this.seen.set(key, f.txStart);
      const t0 = this.pace - (rate > 0 ? (now - f.txStart) / rate : 0);
      const onWire = now < f.arrive;
      // a leg whose crossing is already over by pace time (and that really arrived) is not drawn
      if (!onWire && this.pace - t0 >= TRAFFIC_LEG_WALL_MS) continue;
      const lane = laneOf(f);
      const last = this.laneLast.get(lane);
      if (!onWire && last !== undefined && t0 - last < TRAFFIC_LANE_GAP_MS - GAP_SLACK_MS) continue;
      if (last === undefined || t0 > last) this.laneLast.set(lane, t0);
      this.crossing.set(key, { frame: f, t0 });
    }

    const out: PacedLeg[] = [];
    for (const [key, c] of this.crossing) {
      const newer = listed.get(key);
      if (newer !== undefined && newer.txStart === c.frame.txStart) c.frame = newer; // an abort shortens it
      const f = c.frame;
      const p = Math.min(1, Math.max(0, (this.pace - c.t0) / TRAFFIC_LEG_WALL_MS));
      const paced = f.txStart + p * (f.arrive - f.txStart);
      const at = Math.min(now, paced);
      if (at >= f.arrive || (p >= 1 && newer === undefined)) {
        this.crossing.delete(key);
        continue;
      }
      out.push({ frame: f, at, paced: at !== now });
    }
    const stale = this.pace - TRAFFIC_LEG_WALL_MS - TRAFFIC_LANE_GAP_MS;
    for (const [lane, t] of this.laneLast) if (t < stale) this.laneLast.delete(lane);
    return out;
  }
}
