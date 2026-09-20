/**
 * link/media/segment.ts — SharedSegment, the collision-domain medium with full CSMA/CD (ARCHITECTURE-P1 D4, §3.5).
 *
 * DOMAIN. A union-find over (a) every repeater-role port of a device and (b) every UP cable with an end on a repeater
 * port, an end negotiated half duplex, or a duplex mismatch. A component that holds at least one such cable is a
 * segment with id `seg:<ordinal-smallest member LinkId>`. Members are stations (the non-repeater cable ends) first,
 * then repeater ports, each ordered by device creation and then port order. Domains are rebuilt by the facade
 * (`rebuild`) whenever a member cable is added, removed or recomputed; a cable that leaves has its receivers cut and
 * its stations' queued frames dropped `link-down` with `TxOutcome dropped`.
 *
 * TIMING (bps = lowest negotiated speed of the member cables; 10 Mb with hubs):
 *   d(S,R) = Σ propagationNs over the cables of the BFS path + hops × serializationNs(1, bps)   (hops = repeater crossings)
 *   wire   = ser(size + 8)   IFG = ser(12)   slot = ser(64)   jam = ser(4)
 *
 * TRANSMIT. `transmit` queues the frame (more than 64 queued → `queue-full`) and returns `{ok:true, deferred:true}` with
 * provisional times (= now); the station attempts at once when it was idle.
 *   • attempt: a half-duplex station that senses carrier (a signal whose start has reached it and whose end has not)
 *     emits `carrierDefer`, reports `TxOutcome deferred` once per frame and arms `mediumTimer 'try:<portKey>'` at
 *     busy + IFG. Carrier that ended less than an IFG ago arms the same timer at that end + IFG (no defer trace).
 *     A full-duplex station (the full end of a duplex mismatch) never senses carrier.
 *   • start at a0 = now, a1 = a0 + wire: five draws on `link:<cable>:seg` (loss, corrupt, jitter, offset, bit — the P0
 *     order), where <cable> is the transmitting station's cable; tx capture at a0 before corruption; one receiver copy
 *     per station in member order (a clone when there is more than one receiver, or when the lone receiver's copy is
 *     corrupted, so the sender's retry keeps the clean original); `frameArrival` at a1 + d(S,R) (+ latency, jitter);
 *     one `frameTx` and in-flight leg per BFS tree cable u→v with txStart = a0 + d(u), txEnd = a1 + d(u),
 *     arrive = a1 + d(v); `txComplete` at a1.
 *
 * COLLISION (checked when a transmission starts, against every transmission still on the wire):
 *   A collides with B iff a half-duplex party is hit by the other's signal while transmitting: A (half) is hit at
 *   b0 + d when A did not sense B, and B (half, still sending) is hit at a0 + d. A full-duplex end never detects.
 *   Each detector aborts at its detection time tDet and jams until tDet + jam: every pending receiver arrival is
 *   cancelled and rescheduled at tDet + d(S,R) as a collision fragment of max(0, floor((tDet − a0)/ser(1)) − 8) bytes
 *   (half-duplex receivers get `collided`, full-duplex receivers get `fragmentBytes`), one `frameAbort` per leg, one
 *   `collision` event per collision, `TxOutcome collision {late: tDet − a0 > slot}` and `mediumTimer 'jamEnd:<portKey>'`.
 *   A half-duplex detector that also receives the other frame gets that copy flagged `collided`.
 *
 * JAM END. Late collision → drop `late-collision`; 16 collisions → drop `excessive-collisions`; otherwise
 * `slots = rng('link:<cable>:csma').nextInt(0, 2^min(n,10) − 1)`, a `backoff` trace and a `try` timer at
 * jamEnd + slots × slot. SUCCESS at a1 (`txComplete`) → `TxOutcome sent {txStart: a0}`, `repeated` in/out on the
 * cabled repeater ports, and the next queued frame is attempted.
 *
 * DUPLEX MISMATCH (§4.9). A cable whose ends negotiated different duplex modes is a two-station domain. The
 * full-duplex end never senses carrier and never detects a collision: it transmits over the half end's signal and
 * receives the half end's aborted frames as fragments (runt/CRC errors at the receiver). The half-duplex end defers
 * to the full end's carrier, and when the full end starts while it is sending it detects the collision (mostly late,
 * since the full end ignores it until well past the slot time), jams, and marks the full end's frame it was receiving
 * `collided` (dropped `collision`); a late collision drops its own frame `late-collision`.
 *
 * COLLISION STORM (FaultSpec 'collision-storm', §4.9 Faults). `startStorm(faultId, source, {burstsPerSec,
 * durationNs})` makes the source port (a station or repeater port of a domain) emit jam bursts until
 * `now + durationNs`. Draws come from the cached stream `fault:<faultId>`: one gap draw when the storm starts, then per
 * burst one length draw and one gap draw. Gap = nextInt(max(1, floor(m/2)), m + floor(m/2)) ns with
 * m = max(1, floor(SEC / burstsPerSec)); length = nextInt(JAM_BYTES, SLOT_BYTES) bytes at the domain rate. A burst is
 * carrier without a frame: half-duplex stations defer to it, a half-duplex station whose transmission it reaches
 * detects a collision at burst start + d (abort, jam, backoff as above), and each burst emits one `collision` event
 * (source first, then the detectors) and counts in the domain's collision counter. Full-duplex ends ignore bursts.
 * Bursts are scheduled with `mediumTimer 'storm:<faultId>'`; a source that is not in a domain at burst time emits
 * nothing, and the storm ends at its deadline or on `stopStorm`.
 *
 * Every rng stream is the facade's cached stream (`MediumHost.stream`), created once per label and never re-split.
 * Iteration runs over arrays and insertion-ordered Maps; every ordering is explicit.
 */
import type { CaptureLinkType, WireEvent } from '../../contracts/capture.js';
import type { PortRole } from '../../contracts/catalog.js';
import { defaultRoleFor } from '../../contracts/catalog.js';
import type { SimEventBody } from '../../contracts/events.js';
import type { DeviceId, LinkId, PortId, PortRef } from '../../contracts/ids.js';
import { portKey } from '../../contracts/ids.js';
import type { ArrivalVerdict, DropReason, FrameRxInfo, LinkState, OperChanges, TransmitResult, TxOutcome } from '../../contracts/link.js';
import { MEDIA } from '../../contracts/link.js';
import type { MediaSnapshot, MediumId, SegmentMemberSnapshot, SegmentSnapshot } from '../../contracts/medium.js';
import { CSMA } from '../../contracts/medium.js';
import type { Pdu } from '../../contracts/pdu.js';
import type { PortState } from '../../contracts/port.js';
import type { SimTime } from '../../contracts/time.js';
import { SEC, assertSimTime, propagationNs, serializationNs } from '../../contracts/time.js';
import type { PduSummary, TraceEvent } from '../../contracts/trace.js';
import type { ResolvedMedia } from '../cabling.js';
import { captureLinkTypeOf, corruptionWindow, summarizePdu } from './p2p.js';
import type { FrameArrivalBody, InflightLeg, MediumHost, MediumStrategy } from './types.js';
import { compareOrdinal, segmentId } from './types.js';

// ── pure timing helpers ─────────────────────────────────────────────────────

/** Byte-time quantities of a segment at one bit rate (all integer ns). */
export interface SegmentTiming {
  readonly bps: number;
  /** ser(1): one byte on the wire. */
  readonly byteNs: SimTime;
  /** ser(IFG_BYTES). */
  readonly ifgNs: SimTime;
  /** ser(SLOT_BYTES). */
  readonly slotNs: SimTime;
  /** ser(JAM_BYTES). */
  readonly jamNs: SimTime;
  /** ser(REPEATER_DELAY_BYTES): latency added per repeater crossing. */
  readonly repeaterNs: SimTime;
}

/** Timing constants of a segment running at `bps` (§3.5 table). */
export function segmentTiming(bps: number): SegmentTiming {
  return {
    bps,
    byteNs: serializationNs(1, bps),
    ifgNs: serializationNs(CSMA.IFG_BYTES, bps),
    slotNs: serializationNs(CSMA.SLOT_BYTES, bps),
    jamNs: serializationNs(CSMA.JAM_BYTES, bps),
    repeaterNs: serializationNs(CSMA.REPEATER_DELAY_BYTES, bps),
  };
}

/** Wire time of a frame of `size` bytes including its preamble: ser(size + 8). */
export function wireNs(size: number, bps: number): SimTime {
  return serializationNs(size + CSMA.PREAMBLE_BYTES, bps);
}

/** Bytes of a frame that made it onto the wire before an abort: max(0, floor((abortAt − start)/ser(1)) − 8). */
export function fragmentBytesFor(start: SimTime, abortAt: SimTime, bps: number): number {
  const byteNs = serializationNs(1, bps);
  return Math.max(0, Math.floor((abortAt - start) / byteNs) - CSMA.PREAMBLE_BYTES);
}

/** Highest backoff slot count after `collisions` collisions: 2^min(n, BACKOFF_LIMIT) − 1. */
export function backoffMaxSlots(collisions: number): number {
  const n = Math.max(0, Math.min(Math.floor(collisions), CSMA.BACKOFF_LIMIT));
  return (1 << n) - 1;
}

// ── pure domain formation ───────────────────────────────────────────────────

/** One cable as domain formation sees it. */
export interface SegmentCableInput {
  id: LinkId;
  a: PortRef;
  b: PortRef;
  /** Carrier is up. Down cables never join a domain. */
  up: boolean;
  roleA: PortRole;
  roleB: PortRole;
  /** Negotiated duplex of each end (absent = unknown, treated as not half). */
  duplexA?: 'full' | 'half';
  duplexB?: 'full' | 'half';
  /** The negotiation reported a duplex mismatch. */
  mismatch?: boolean;
  /** Negotiated speed. */
  bps?: number;
}

/** Inputs of `formSegments`. */
export interface SegmentFormationInput {
  /** Every cable, in creation order. */
  cables: readonly SegmentCableInput[];
  /** Repeater-role ports of a device, in port order. */
  repeaterPorts(device: DeviceId): readonly PortId[];
  /** Device creation index (smaller = older). */
  deviceOrder(device: DeviceId): number;
  /** Port order within its device. */
  portOrder(ref: PortRef): number;
}

/** One collision domain. */
export interface SegmentDomain {
  id: MediumId;
  /** Member cables in creation order. */
  links: LinkId[];
  /** Stations in device-creation then port order. */
  stations: PortRef[];
  /** Repeater ports in device-creation then port order. */
  repeaters: PortRef[];
  /** Station port key → its cable. */
  stationLinks: Map<string, LinkId>;
  /** Lowest negotiated speed of the member cables (REPEATER_BPS when none is known). */
  bps: number;
}

/** A cable joins a collision domain: up, and a repeater end, a half-duplex end or a duplex mismatch. */
export function cableJoinsSegment(c: SegmentCableInput): boolean {
  if (!c.up) return false;
  return c.roleA === 'repeater' || c.roleB === 'repeater' || c.duplexA === 'half' || c.duplexB === 'half' || c.mismatch === true;
}

/** Union-find over port keys (path halving, attach to the ordinal-smaller root so roots are stable). */
class PortUnion {
  private readonly parent = new Map<string, string>();

  add(key: string): void {
    if (!this.parent.has(key)) this.parent.set(key, key);
  }

  find(key: string): string {
    this.add(key);
    let k = key;
    let p = this.parent.get(k) as string;
    while (p !== k) {
      const gp = this.parent.get(p) as string;
      this.parent.set(k, gp);
      k = p;
      p = this.parent.get(k) as string;
    }
    return k;
  }

  union(x: string, y: string): void {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx === ry) return;
    if (compareOrdinal(rx, ry) < 0) this.parent.set(ry, rx);
    else this.parent.set(rx, ry);
  }
}

/** Form the collision domains of a set of cables (§3.5 Domain). Result ordered by segment id (ordinal). */
export function formSegments(input: SegmentFormationInput): SegmentDomain[] {
  const uf = new PortUnion();
  const refs = new Map<string, PortRef>();
  const remember = (r: PortRef): string => {
    const k = portKey(r);
    if (!refs.has(k)) refs.set(k, { device: r.device, port: r.port });
    uf.add(k);
    return k;
  };
  const joining = input.cables.filter(cableJoinsSegment);
  const repeaterDevices: DeviceId[] = [];
  for (const c of joining) {
    uf.union(remember(c.a), remember(c.b));
    if (c.roleA === 'repeater' && !repeaterDevices.includes(c.a.device)) repeaterDevices.push(c.a.device);
    if (c.roleB === 'repeater' && !repeaterDevices.includes(c.b.device)) repeaterDevices.push(c.b.device);
  }
  const repeaterKeys = new Set<string>();
  for (const device of repeaterDevices) {
    const ports = input.repeaterPorts(device);
    let first: string | undefined;
    for (const port of ports) {
      const k = remember({ device, port });
      repeaterKeys.add(k);
      if (first === undefined) first = k;
      else uf.union(first, k);
    }
  }
  for (const c of joining) {
    if (c.roleA === 'repeater') repeaterKeys.add(portKey(c.a));
    if (c.roleB === 'repeater') repeaterKeys.add(portKey(c.b));
  }

  const byRoot = new Map<string, SegmentDomain>();
  for (const c of joining) {
    const root = uf.find(portKey(c.a));
    let dom = byRoot.get(root);
    if (!dom) {
      dom = { id: '', links: [], stations: [], repeaters: [], stationLinks: new Map(), bps: 0 };
      byRoot.set(root, dom);
    }
    dom.links.push(c.id);
    if (c.bps !== undefined && (dom.bps === 0 || c.bps < dom.bps)) dom.bps = c.bps;
    for (const [end, role] of [[c.a, c.roleA], [c.b, c.roleB]] as const) {
      if (role === 'repeater') continue;
      const k = portKey(end);
      if (!dom.stationLinks.has(k)) {
        dom.stationLinks.set(k, c.id);
        dom.stations.push({ device: end.device, port: end.port });
      }
    }
  }
  for (const k of repeaterKeys) {
    const dom = byRoot.get(uf.find(k));
    const ref = refs.get(k);
    if (dom && ref) dom.repeaters.push(ref);
  }

  const order = (x: PortRef, y: PortRef): number =>
    input.deviceOrder(x.device) - input.deviceOrder(y.device) ||
    compareOrdinal(x.device, y.device) ||
    input.portOrder(x) - input.portOrder(y) ||
    compareOrdinal(x.port, y.port);
  const out: SegmentDomain[] = [];
  for (const dom of byRoot.values()) {
    dom.id = segmentId(dom.links);
    dom.stations.sort(order);
    dom.repeaters.sort(order);
    if (dom.bps === 0) dom.bps = CSMA.REPEATER_BPS;
    out.push(dom);
  }
  out.sort((x, y) => compareOrdinal(x.id, y.id));
  return out;
}

// ── distance graph ──────────────────────────────────────────────────────────

/** One cable of a domain's distance graph. */
export interface SegmentGraphCable {
  id: LinkId;
  a: PortRef;
  b: PortRef;
  /** propagationNs(lengthM, velocityFactor). */
  ns: SimTime;
}

interface GraphEdge {
  to: string;
  link?: LinkId;
  ns: SimTime;
}

interface GraphNode {
  ref: PortRef;
  repeater: boolean;
  cabled: boolean;
  edges: GraphEdge[];
}

/** One port reached by a BFS from a station. */
export interface SegmentReach {
  ref: PortRef;
  /** d(S, port) in ns. */
  ns: SimTime;
  /** Repeater crossings on the path. */
  hops: number;
  /** Port the BFS came from (undefined for the source). */
  via?: string;
  /** Cable of the last edge (undefined for the source and repeater crossings). */
  link?: LinkId;
  /** Cables of the whole path, source outward. */
  path: readonly LinkId[];
  repeater: boolean;
  cabled: boolean;
}

/** BFS result from one station: reach per port key, and port keys in discovery order. */
export interface SegmentBfs {
  reach: Map<string, SegmentReach>;
  order: string[];
}

/** Distance graph of one domain (ports as nodes; cables and repeater crossings as edges). */
export interface SegmentGraph {
  has(key: string): boolean;
  /** BFS from a port (cached until the graph is rebuilt). */
  bfs(fromKey: string): SegmentBfs;
  /** d(from, to), or undefined when not connected. */
  distance(fromKey: string, toKey: string): SimTime | undefined;
  /** Upper bound of any distance in the domain. */
  readonly spanNs: SimTime;
  /** Largest number of repeater crossings between two stations. */
  maxStationHops(stations: readonly PortRef[]): number;
}

/**
 * Build the distance graph of a domain: cables in the given (creation) order, then repeater crossings between every
 * pair of repeater ports of the same device (cost ser(REPEATER_DELAY_BYTES, bps)), in member order.
 */
export function buildSegmentGraph(domain: Pick<SegmentDomain, 'repeaters' | 'bps'>, cables: readonly SegmentGraphCable[]): SegmentGraph {
  const timing = segmentTiming(domain.bps);
  const nodes = new Map<string, GraphNode>();
  const node = (ref: PortRef, repeater: boolean): GraphNode => {
    const k = portKey(ref);
    let n = nodes.get(k);
    if (!n) {
      n = { ref: { device: ref.device, port: ref.port }, repeater, cabled: false, edges: [] };
      nodes.set(k, n);
    }
    if (repeater) n.repeater = true;
    return n;
  };
  const repeaterKeys = new Set(domain.repeaters.map(portKey));
  let span = 0;
  for (const c of cables) {
    const na = node(c.a, repeaterKeys.has(portKey(c.a)));
    const nb = node(c.b, repeaterKeys.has(portKey(c.b)));
    na.cabled = true;
    nb.cabled = true;
    na.edges.push({ to: portKey(c.b), link: c.id, ns: c.ns });
    nb.edges.push({ to: portKey(c.a), link: c.id, ns: c.ns });
    span += c.ns;
  }
  const byDevice = new Map<DeviceId, PortRef[]>();
  for (const r of domain.repeaters) {
    node(r, true);
    const list = byDevice.get(r.device);
    if (list) list.push(r);
    else byDevice.set(r.device, [r]);
  }
  for (const list of byDevice.values()) {
    span += timing.repeaterNs;
    for (const x of list) {
      const nx = nodes.get(portKey(x)) as GraphNode;
      for (const y of list) {
        if (x === y) continue;
        nx.edges.push({ to: portKey(y), ns: timing.repeaterNs });
      }
    }
  }

  const cache = new Map<string, SegmentBfs>();
  const bfs = (fromKey: string): SegmentBfs => {
    const hit = cache.get(fromKey);
    if (hit) return hit;
    const reach = new Map<string, SegmentReach>();
    const order: string[] = [];
    const src = nodes.get(fromKey);
    if (src) {
      reach.set(fromKey, { ref: src.ref, ns: 0, hops: 0, path: [], repeater: src.repeater, cabled: src.cabled });
      order.push(fromKey);
      for (let i = 0; i < order.length; i++) {
        const k = order[i] as string;
        const cur = reach.get(k) as SegmentReach;
        const n = nodes.get(k) as GraphNode;
        for (const e of n.edges) {
          if (reach.has(e.to)) continue;
          const target = nodes.get(e.to) as GraphNode;
          const r: SegmentReach = {
            ref: target.ref,
            ns: cur.ns + e.ns,
            hops: cur.hops + (e.link === undefined ? 1 : 0),
            via: k,
            path: e.link === undefined ? cur.path : [...cur.path, e.link],
            repeater: target.repeater,
            cabled: target.cabled,
          };
          if (e.link !== undefined) r.link = e.link;
          reach.set(e.to, r);
          order.push(e.to);
        }
      }
    }
    const out = { reach, order };
    cache.set(fromKey, out);
    return out;
  };

  return {
    has: (key) => nodes.has(key),
    bfs,
    distance: (fromKey, toKey) => bfs(fromKey).reach.get(toKey)?.ns,
    spanNs: span,
    maxStationHops(stations) {
      let max = 0;
      for (const s of stations) {
        const reach = bfs(portKey(s)).reach;
        for (const t of stations) {
          const r = reach.get(portKey(t));
          if (r && r.hops > max) max = r.hops;
        }
      }
      return max;
    },
  };
}

// ── strategy ────────────────────────────────────────────────────────────────

/** Most repeaters a station-to-station path may cross before the domain is flagged (the classic repeater rule). */
export const MAX_REPEATER_HOPS = 4;

/** Parameters of a collision-storm fault (`FaultSpec.params` of kind 'collision-storm'). */
export interface CollisionStormParams {
  /** Mean number of jam bursts per simulated second (> 0). */
  burstsPerSec: number;
  /** How long the storm lasts from its start, ns (integer >= 0). */
  durationNs: SimTime;
}

/** Bounds of one storm gap draw (ns) for a mean burst rate: [max(1, floor(m/2)), m + floor(m/2)], m = max(1, floor(SEC / rate)). */
export function stormGapBounds(burstsPerSec: number): { lo: SimTime; hi: SimTime } {
  const mean = Math.max(1, Math.floor(SEC / burstsPerSec));
  const half = Math.floor(mean / 2);
  return { lo: Math.max(1, half), hi: mean + half };
}

/** Receive-side flags carried on a scheduled arrival. */
interface ArrivalFlags {
  corrupted?: boolean;
  fragmentBytes?: number;
  collided?: boolean;
}

/** Construction options of the shared segment (supplied by the link facade). */
export interface SharedSegmentOptions {
  /** Every link id, in creation order. */
  links(): readonly LinkId[];
  /** Device creation index (smaller = older). */
  deviceOrder(device: DeviceId): number;
  /** Ports of a device in its canonical port order. */
  devicePorts(device: DeviceId): readonly PortId[];
  /** Effective role of a port; default `port.role ?? port.spec.role ?? defaultRoleFor(kind, [])`. */
  roleOf?(ref: PortRef): PortRole | undefined;
  /** Link attached to a port when `PortState.link` is unset. */
  linkOf?(ref: PortRef): LinkId | undefined;
}

/** Read-only view of a domain for the facade (routing, LinkState.segment). */
export interface SegmentView {
  id: MediumId;
  links: readonly LinkId[];
  stations: readonly PortRef[];
  repeaters: readonly PortRef[];
  bps: number;
}

/** The shared segment strategy plus the domain hooks the facade drives. */
export interface SharedSegmentStrategy extends MediumStrategy {
  readonly kind: 'segment';
  /**
   * Re-form every collision domain from the facade's links (after add/remove/recompute of a cable). Writes
   * `LinkState.segment` and `PortState.phy.segment` (when phy exists), cuts receivers on cables that left, drops the
   * queues of stations that left, and emits `segmentChanged` (dissolved, then formed/changed in id order).
   */
  rebuild(now: SimTime): void;
  /** Segment of a member cable. */
  segmentOfLink(id: LinkId): MediumId | undefined;
  /** Segment of a member port (station or repeater). */
  segmentOfPort(ref: PortRef): MediumId | undefined;
  /** Current domains in id order. */
  segments(): readonly SegmentView[];
  /**
   * Start (or restart, replacing a storm with the same id) a collision storm sourced at `source` (see the file
   * header). Returns false, and schedules nothing, when the source is not a member of a collision domain.
   * Throws RangeError on invalid parameters.
   */
  startStorm(faultId: string, source: PortRef, params: CollisionStormParams, now: SimTime): boolean;
  /** Stop a running storm; false when no storm has this id. Bursts already on the wire run out normally. */
  stopStorm(faultId: string, now: SimTime): boolean;
  /** Ids of the running storms, in start order. */
  storms(): readonly string[];
}

interface StationStats {
  tx: number;
  collisions: number;
  lateCollisions: number;
  deferred: number;
}

interface QueuedFrame {
  pdu: Pdu;
  collisions: number;
  deferredReported: boolean;
}

interface SegLeg {
  link: LinkId;
  from: PortRef;
  to: PortRef;
  fromNs: SimTime;
  toNs: SimTime;
  summary: PduSummary;
  path: readonly LinkId[];
  receiver?: Receiver;
  arrive: SimTime;
  cut: boolean;
}

interface Receiver {
  ref: PortRef;
  key: string;
  pdu: Pdu;
  summary: PduSummary;
  ns: SimTime;
  half: boolean;
  seq?: number;
  arrive?: SimTime;
  collided: boolean;
  fragmentBytes?: number;
  corrupted: boolean;
  settled: boolean;
  leg?: SegLeg;
}

interface Transmission {
  station: string;
  from: PortRef;
  cable: LinkId;
  segment: MediumId;
  pdu: Pdu;
  summary: PduSummary;
  attempt: number;
  half: boolean;
  timing: SegmentTiming;
  start: SimTime;
  wireEnd: SimTime;
  end: SimTime;
  extraNs: SimTime;
  aborted: boolean;
  abortAt?: SimTime;
  late: boolean;
  lost: boolean;
  txCompleteSeq?: number;
  jamSeq?: number;
  receivers: Receiver[];
  legs: SegLeg[];
  repeaters: { ref: PortRef; dir: 'in' | 'out' }[];
  done: boolean;
}

interface Station {
  ref: PortRef;
  key: string;
  queue: QueuedFrame[];
  phase: 'idle' | 'wait' | 'tx' | 'jam';
  timerSeq?: number;
  current?: Transmission;
  cable?: LinkId;
  segment?: MediumId;
  stats: StationStats;
}

/** One jam burst on the wire (carrier without a frame). */
interface Burst {
  fault: string;
  source: string;
  segment: MediumId;
  start: SimTime;
  end: SimTime;
}

/** A running collision storm. */
interface Storm {
  id: string;
  source: PortRef;
  key: string;
  until: SimTime;
  params: CollisionStormParams;
  timerSeq?: number;
}

interface LiveDomain extends SegmentDomain {
  graph: SegmentGraph;
  timing: SegmentTiming;
  coaxLengthM: number;
}

const TRY_PREFIX = 'try:';
const JAM_PREFIX = 'jamEnd:';
const STORM_PREFIX = 'storm:';

/** Default effective role of a port without catalog data. */
function fallbackRole(p: PortState): PortRole {
  return p.role ?? p.spec.role ?? defaultRoleFor(p.spec.kind, []);
}

/** A port negotiated full duplex (the full end of a mismatch); everything else on a segment is half duplex. */
function isFullDuplex(p: PortState | undefined): boolean {
  const duplex = p?.phy?.end?.duplex ?? p?.duplex;
  return duplex === 'full';
}

/** Create the shared segment medium (CSMA/CD collision domains, §3.5). */
export function createSharedSegment(host: MediumHost, options: SharedSegmentOptions): SharedSegmentStrategy {
  let domains: LiveDomain[] = [];
  const domainById = new Map<MediumId, LiveDomain>();
  const domainByPort = new Map<string, LiveDomain>();
  const domainByLink = new Map<LinkId, LiveDomain>();
  const stations = new Map<string, Station>();
  const collisionCount = new Map<MediumId, number>();
  /** Transmissions still relevant (carrier memory or pending receivers), in start order. */
  let records: Transmission[] = [];
  /** `${pduId}|${portKey(to)}` → pending receiver. */
  const arrivals = new Map<string, { tx: Transmission; rx: Receiver }>();
  /** Jam bursts still relevant for carrier sense and collision detection, in start order. */
  let bursts: Burst[] = [];
  /** Running collision storms, in start order. */
  const stormsById = new Map<string, Storm>();

  const roleOf = (ref: PortRef): PortRole | undefined => {
    const explicit = options.roleOf?.(ref);
    if (explicit !== undefined) return explicit;
    const p = host.port(ref);
    return p ? fallbackRole(p) : undefined;
  };

  const stationOf = (ref: PortRef): Station => {
    const key = portKey(ref);
    let st = stations.get(key);
    if (!st) {
      st = { ref: { device: ref.device, port: ref.port }, key, queue: [], phase: 'idle', stats: { tx: 0, collisions: 0, lateCollisions: 0, deferred: 0 } };
      stations.set(key, st);
    }
    return st;
  };

  const syncQueue = (st: Station): void => {
    const p = host.port(st.ref);
    if (p) p.tx.queue = st.queue.length;
  };

  const mediumTimer = (at: SimTime, medium: MediumId, key: string): number =>
    host.schedule(at, { kind: 'mediumTimer', medium, key });

  const cancelTimer = (st: Station): void => {
    if (st.timerSeq !== undefined) {
      host.cancel(st.timerSeq);
      delete st.timerSeq;
    }
  };

  const dropEvent = (pdu: PduSummary, st: Station, reason: DropReason, now: SimTime, detail?: string): TraceEvent => {
    const ev: TraceEvent = { t: now, kind: 'drop', pdu, device: st.ref.device, port: st.ref.port, reason };
    if (detail !== undefined) ev.detail = detail;
    const seg = domainByPort.get(st.key)?.id ?? st.segment;
    if (seg !== undefined) ev.medium = seg;
    return ev;
  };

  const outcome = (ref: PortRef, o: TxOutcome, now: SimTime): void => host.txOutcome(ref, o, now);

  // ── receivers and legs ────────────────────────────────────────────────────

  const settleReceiver = (rx: Receiver): void => {
    if (rx.seq !== undefined) {
      host.cancel(rx.seq);
      delete rx.seq;
    }
    rx.settled = true;
    arrivals.delete(`${rx.pdu.id}|${rx.key}`);
    if (rx.leg) host.inflight.delete(rx.pdu.id, rx.leg.link, rx.ref);
  };

  const scheduleArrival = (tx: Transmission, rx: Receiver, at: SimTime, flags: ArrivalFlags): void => {
    const ev: SimEventBody = { kind: 'frameArrival', device: rx.ref.device, port: rx.ref.port, pdu: rx.pdu, medium: tx.segment };
    if (flags.corrupted === true) ev.corrupted = true;
    if (flags.fragmentBytes !== undefined) ev.fragmentBytes = flags.fragmentBytes;
    if (flags.collided === true) ev.collided = true;
    rx.seq = host.schedule(at, ev);
    rx.arrive = at;
    arrivals.set(`${rx.pdu.id}|${rx.key}`, { tx, rx });
  };

  const legRecord = (tx: Transmission, leg: SegLeg, abortAt?: SimTime): InflightLeg => {
    const out: InflightLeg = {
      pdu: leg.summary, link: leg.link, from: leg.from, to: leg.to,
      txStart: tx.start + leg.fromNs, txEnd: tx.wireEnd + leg.fromNs, arrive: leg.arrive, medium: 'segment',
    };
    if (abortAt !== undefined) out.abortAt = abortAt;
    if (tx.pdu.meta.background === true) out.background = true;
    if (leg.receiver?.seq !== undefined) out.arrivalSeq = leg.receiver.seq;
    return out;
  };

  /** Cut legs (and their receivers) whose path satisfies `cut`; emits drop link-down per receiver and frameAbort per leg. */
  const cutLegs = (tx: Transmission, cut: (leg: SegLeg) => boolean, now: SimTime, detail: string | undefined): void => {
    for (const leg of tx.legs) {
      if (leg.cut || !cut(leg)) continue;
      leg.cut = true;
      const rx = leg.receiver;
      const pending = rx !== undefined && !rx.settled && rx.seq !== undefined;
      if (!pending && leg.arrive <= now) continue;
      if (rx && pending) {
        settleReceiver(rx);
        const drop: TraceEvent = { t: now, kind: 'drop', pdu: rx.summary, link: leg.link, reason: 'link-down', medium: tx.segment };
        if (detail !== undefined) drop.detail = detail;
        host.emit(drop);
      } else {
        host.inflight.delete(leg.summary.id, leg.link, leg.to);
        if (rx) rx.settled = true;
      }
      host.emit({
        t: now, kind: 'frameAbort', pdu: leg.summary, link: leg.link, from: leg.from, to: leg.to, abortAt: now, arrive: leg.arrive, reason: 'link-down',
      });
    }
  };

  // ── carrier sense ─────────────────────────────────────────────────────────

  const carrierAt = (st: Station, dom: LiveDomain, now: SimTime, own: boolean): { busyUntil: SimTime; lastEnd?: SimTime } => {
    let busyUntil = now;
    let lastEnd: SimTime | undefined;
    for (const tx of records) {
      let d: SimTime | undefined;
      if (tx.station === st.key) d = 0;
      else if (own) continue;
      else if (dom.graph.has(tx.station)) d = dom.graph.distance(tx.station, st.key);
      if (d === undefined) continue;
      const begin = tx.start + d;
      const finish = tx.end + d;
      if (tx.station !== st.key && begin <= now && now < finish && finish > busyUntil) busyUntil = finish;
      if (finish <= now && (lastEnd === undefined || finish > lastEnd)) lastEnd = finish;
    }
    if (!own) {
      for (const b of bursts) {
        if (!dom.graph.has(b.source)) continue;
        const d = b.source === st.key ? 0 : dom.graph.distance(b.source, st.key);
        if (d === undefined) continue;
        const begin = b.start + d;
        const finish = b.end + d;
        if (begin <= now && now < finish && finish > busyUntil) busyUntil = finish;
        if (finish <= now && (lastEnd === undefined || finish > lastEnd)) lastEnd = finish;
      }
    }
    return lastEnd === undefined ? { busyUntil } : { busyUntil, lastEnd };
  };

  const prune = (now: SimTime): void => {
    let span = 0;
    let ifg = 0;
    for (const dom of domains) {
      if (dom.graph.spanNs > span) span = dom.graph.spanNs;
      if (dom.timing.ifgNs > ifg) ifg = dom.timing.ifgNs;
    }
    records = records.filter((tx) => {
      const pending = tx.receivers.some((rx) => !rx.settled);
      const current = stations.get(tx.station)?.current === tx;
      return pending || current || tx.end + span + ifg >= now;
    });
    bursts = bursts.filter((b) => b.end + span + ifg >= now);
  };

  // ── queue handling ────────────────────────────────────────────────────────

  const armTry = (st: Station, at: SimTime, seg: MediumId): void => {
    cancelTimer(st);
    st.timerSeq = mediumTimer(at, seg, `${TRY_PREFIX}${st.key}`);
    st.phase = 'wait';
  };

  const dropHead = (st: Station, reason: DropReason, now: SimTime, detail?: string): void => {
    const head = st.queue.shift();
    syncQueue(st);
    if (!head) return;
    host.emit(dropEvent(summarizePdu(head.pdu), st, reason, now, detail));
    outcome(st.ref, { kind: 'dropped', pdu: head.pdu.id, reason }, now);
  };

  /** Drop everything a station has in progress or queued (cable gone, sender down). */
  const dropStation = (st: Station, now: SimTime, detail: string | undefined): void => {
    cancelTimer(st);
    const tx = st.current;
    if (tx && !tx.done) {
      if (tx.txCompleteSeq !== undefined) host.cancel(tx.txCompleteSeq);
      if (tx.jamSeq !== undefined) host.cancel(tx.jamSeq);
      delete tx.txCompleteSeq;
      delete tx.jamSeq;
      cutLegs(tx, () => true, now, detail);
      if (tx.end > now) tx.end = now;
      tx.done = true;
    }
    delete st.current;
    st.phase = 'idle';
    while (st.queue.length > 0) dropHead(st, 'link-down', now, detail);
    const p = host.port(st.ref);
    if (p && p.tx.busyUntil > now) p.tx.busyUntil = now;
  };

  const attempt = (st: Station, now: SimTime): void => {
    if (st.phase === 'tx' || st.phase === 'jam') return;
    cancelTimer(st);
    const head = st.queue[0];
    if (!head) {
      st.phase = 'idle';
      return;
    }
    const dom = domainByPort.get(st.key);
    const port = host.port(st.ref);
    if (!dom || !port || !port.operUp) {
      dropStation(st, now, dom ? 'port-down' : 'no collision domain');
      return;
    }
    prune(now);
    const half = !isFullDuplex(port);
    const sense = carrierAt(st, dom, now, !half);
    if (half && sense.busyUntil > now) {
      host.emit({ t: now, kind: 'carrierDefer', device: st.ref.device, port: st.ref.port, pdu: head.pdu.id, until: sense.busyUntil });
      if (!head.deferredReported) {
        head.deferredReported = true;
        st.stats.deferred++;
        outcome(st.ref, { kind: 'deferred', pdu: head.pdu.id }, now);
      }
      armTry(st, sense.busyUntil + dom.timing.ifgNs, dom.id);
      return;
    }
    if (sense.lastEnd !== undefined && sense.lastEnd + dom.timing.ifgNs > now) {
      armTry(st, sense.lastEnd + dom.timing.ifgNs, dom.id);
      return;
    }
    start(st, dom, head, half, now);
  };

  const finishAndContinue = (st: Station, now: SimTime): void => {
    delete st.current;
    st.phase = 'idle';
    attempt(st, now);
  };

  // ── start of a transmission ───────────────────────────────────────────────

  const start = (st: Station, dom: LiveDomain, head: QueuedFrame, half: boolean, now: SimTime): void => {
    const cable = dom.stationLinks.get(st.key) as LinkId;
    const state = host.link(cable) as LinkState;
    const port = host.port(st.ref) as PortState;
    const timing = dom.timing;
    const pdu = head.pdu;
    const imp = state.impairments;
    const rng = host.stream(`link:${cable}:seg`);

    // Five draws per attempt, P0 order: loss, corrupt, jitter, corrupt-offset, corrupt-bit.
    const lost = rng.chance(imp.lossPct / 100);
    const corrupted = rng.chance(imp.corruptPct / 100);
    const jitter = rng.nextInt(0, imp.jitterNs);
    const { lo, hi } = corruptionWindow(pdu);
    const byteOffset = rng.nextInt(lo, hi);
    const bitMask = 1 << rng.nextInt(0, 7);

    const a0 = now;
    const a1 = a0 + wireNs(pdu.size, timing.bps);
    const linkType: CaptureLinkType = captureLinkTypeOf(pdu);
    host.capture({ t: a0, dir: 'tx', port: { device: st.ref.device, port: st.ref.port }, pdu, linkType });

    const summary = summarizePdu(pdu);
    const tx: Transmission = {
      station: st.key, from: st.ref, cable, segment: dom.id, pdu, summary, attempt: head.collisions + 1, half, timing,
      start: a0, wireEnd: a1, end: a1, extraNs: imp.latencyNs + jitter, aborted: false, late: false, lost,
      receivers: [], legs: [], repeaters: [], done: false,
    };

    const bfs = dom.graph.bfs(st.key);
    const targets = dom.stations.filter((r) => portKey(r) !== st.key && bfs.reach.has(portKey(r)));
    const clones = targets.length > 1 || corrupted;
    const receiverByKey = new Map<string, Receiver>();
    if (!lost) {
      for (const ref of targets) {
        const key = portKey(ref);
        let copy = pdu;
        if (clones) {
          const factory = host.deps.pdus;
          if (!factory) throw new Error('segment media need LinkModelDeps.pdus to give every receiver its own copy');
          copy = factory.clone(pdu, now);
        }
        if (corrupted) copy.corrupt({ now, device: st.ref.device }, byteOffset, bitMask);
        const rp = host.port(ref);
        const rx: Receiver = {
          ref: { device: ref.device, port: ref.port }, key, pdu: copy, summary: summarizePdu(copy),
          ns: (bfs.reach.get(key) as SegmentReach).ns, half: !isFullDuplex(rp), collided: false, corrupted, settled: false,
        };
        tx.receivers.push(rx);
        receiverByKey.set(key, rx);
      }
    } else {
      host.emit({ t: now, kind: 'drop', pdu: summary, link: cable, reason: 'link-loss', detail: `loss ${imp.lossPct}%`, medium: dom.id });
    }

    for (const rx of tx.receivers) scheduleArrival(tx, rx, a1 + rx.ns + tx.extraNs, { corrupted: rx.corrupted });

    for (const k of bfs.order) {
      const r = bfs.reach.get(k) as SegmentReach;
      if (r.via === undefined) continue;
      if (r.repeater) {
        if (r.cabled) tx.repeaters.push({ ref: r.ref, dir: r.link === undefined ? 'out' : 'in' });
      }
      if (r.link === undefined) continue;
      const fromReach = bfs.reach.get(r.via) as SegmentReach;
      const rx = receiverByKey.get(k);
      const leg: SegLeg = {
        link: r.link, from: fromReach.ref, to: r.ref, fromNs: fromReach.ns, toNs: r.ns,
        summary: rx ? rx.summary : summary, path: r.path, arrive: a1 + r.ns + (rx ? tx.extraNs : 0), cut: false,
      };
      if (rx) {
        leg.receiver = rx;
        rx.leg = leg;
      }
      tx.legs.push(leg);
      const ev: Extract<TraceEvent, { kind: 'frameTx' }> = {
        t: now, kind: 'frameTx', pdu: leg.summary, link: leg.link, from: leg.from, to: leg.to,
        txStart: a0 + leg.fromNs, txEnd: a1 + leg.fromNs, arrive: leg.arrive, medium: 'segment',
      };
      if (pdu.meta.background === true) ev.background = true;
      if (tx.attempt > 1) ev.attempt = tx.attempt;
      host.emit(ev);
    }
    host.inflight.sweep(now);
    for (const leg of tx.legs) host.inflight.add(legRecord(tx, leg));

    port.tx.busyUntil = a1;
    tx.txCompleteSeq = host.schedule(a1, { kind: 'txComplete', device: st.ref.device, port: st.ref.port });
    st.current = tx;
    st.phase = 'tx';
    st.cable = cable;
    st.segment = dom.id;
    records.push(tx);

    detectCollisions(tx, dom, now);
  };

  // ── collisions ────────────────────────────────────────────────────────────

  const detectCollisions = (a: Transmission, dom: LiveDomain, now: SimTime): void => {
    const detections = new Map<Transmission, SimTime>();
    const involved: Transmission[] = [];
    const hits: { victim: Transmission; by: Transmission }[] = [];
    const note = (t: Transmission, at: SimTime): void => {
      const prev = detections.get(t);
      if (prev === undefined || at < prev) detections.set(t, at);
    };
    for (const b of records) {
      if (b === a || b.station === a.station) continue;
      if (!dom.graph.has(b.station)) continue;
      const d = dom.graph.distance(b.station, a.station);
      if (d === undefined || b.end + d <= now) continue;
      let collided = false;
      // A (half duplex) is hit by B's signal when it reaches A while A is still sending.
      const tA = b.start + d;
      if (a.half && !a.aborted && tA > a.start && tA < a.wireEnd) {
        note(a, tA);
        hits.push({ victim: a, by: b });
        collided = true;
      }
      // B (half duplex, still sending its frame) is hit by A's signal. A B whose abort is already scheduled
      // is still hit when A's signal reaches it before that scheduled detection (three-way collision).
      const tB = a.start + d;
      if (b.half && (!b.aborted || tB < (b.abortAt as SimTime)) && stations.get(b.station)?.current === b && tB < b.wireEnd) {
        note(b, tB);
        hits.push({ victim: b, by: a });
        collided = true;
      }
      if (collided) involved.push(b);
    }
    // A (half duplex) is hit by a storm burst whose signal reaches it while it is sending.
    if (a.half && !a.aborted) {
      for (const burst of bursts) {
        if (!dom.graph.has(burst.source)) continue;
        const d = burst.source === a.station ? 0 : dom.graph.distance(burst.source, a.station);
        if (d === undefined || burst.end + d <= now) continue;
        const tA = burst.start + d;
        if (tA > a.start && tA < a.wireEnd) note(a, tA);
      }
    }
    if (detections.size === 0) return;

    const memberIndex = (key: string): number => dom.stations.findIndex((r) => portKey(r) === key);
    const detectors = [...detections.keys()].sort((x, y) => memberIndex(x.station) - memberIndex(y.station) || compareOrdinal(x.station, y.station));
    let detectAt = Number.MAX_SAFE_INTEGER;
    let jamUntil = 0;
    let late = false;
    for (const t of detectors) {
      const at = detections.get(t) as SimTime;
      if (at < detectAt) detectAt = at;
      if (at + t.timing.jamNs > jamUntil) jamUntil = at + t.timing.jamNs;
      if (at - t.start > t.timing.slotNs) late = true;
    }
    collisionCount.set(dom.id, (collisionCount.get(dom.id) ?? 0) + 1);
    host.emit({
      t: now, kind: 'collision', segment: dom.id, stations: detectors.map((t) => ({ device: t.from.device, port: t.from.port })),
      pdus: [a.pdu.id, ...involved.map((t) => t.pdu.id)], detectAt, jamUntil, late,
    });
    // A half-duplex detector that also receives the other frame receives it as a collision.
    for (const { victim, by } of hits) {
      const rx = by.receivers.find((r) => r.key === victim.station);
      if (rx && rx.half) rx.collided = true;
    }
    for (const t of detectors) abortForCollision(t, detections.get(t) as SimTime, dom, now);
  };

  const abortForCollision = (tx: Transmission, tDet: SimTime, dom: LiveDomain, now: SimTime): void => {
    // Already detecting a collision at or before tDet: the later detection changes nothing.
    if (tx.aborted && tx.abortAt !== undefined && tx.abortAt <= tDet) return;
    const st = stations.get(tx.station) as Station;
    const head = st.queue[0];
    const timing = tx.timing;
    // Re-abort: a nearer station's signal reaches tx before its already-scheduled detection. The collision is
    // the same one (counted once); only its timing moves earlier.
    const reabort = tx.aborted === true;
    const wasLate = tx.late === true;
    tx.aborted = true;
    tx.abortAt = tDet;
    tx.late = tDet - tx.start > timing.slotNs;
    tx.end = tDet + timing.jamNs;
    if (tx.txCompleteSeq !== undefined) {
      host.cancel(tx.txCompleteSeq);
      delete tx.txCompleteSeq;
    }
    if (reabort && tx.jamSeq !== undefined) {
      host.cancel(tx.jamSeq);
      delete tx.jamSeq;
    }
    const port = host.port(st.ref);
    if (port) port.tx.busyUntil = tx.end;
    const fragment = fragmentBytesFor(tx.start, tDet, timing.bps);
    if (!reabort) {
      if (head) head.collisions++;
      st.stats.collisions++;
      if (tx.late) st.stats.lateCollisions++;
    } else if (wasLate && !tx.late) {
      st.stats.lateCollisions--;
    }
    const reason = tx.late ? 'late-collision' : 'collision';

    for (const leg of tx.legs) {
      if (leg.cut) continue;
      const rx = leg.receiver;
      const abortAt = tDet + leg.fromNs;
      if (rx && !rx.settled && rx.seq !== undefined) {
        host.cancel(rx.seq);
        arrivals.delete(`${rx.pdu.id}|${rx.key}`);
        if (rx.half) {
          rx.collided = true;
          scheduleArrival(tx, rx, tDet + rx.ns + tx.extraNs, { collided: true });
        } else {
          rx.fragmentBytes = fragment;
          scheduleArrival(tx, rx, tDet + rx.ns + tx.extraNs, { fragmentBytes: fragment });
        }
        leg.arrive = rx.arrive as SimTime;
      } else {
        leg.arrive = tDet + leg.toNs + (rx ? tx.extraNs : 0);
      }
      host.emit({ t: now, kind: 'frameAbort', pdu: leg.summary, link: leg.link, from: leg.from, to: leg.to, abortAt, arrive: leg.arrive, reason });
      host.inflight.add(legRecord(tx, leg, abortAt));
    }
    if (!reabort) {
      outcome(st.ref, { kind: 'collision', pdu: tx.pdu.id, late: tx.late, attempt: head?.collisions ?? tx.attempt }, now);
      for (const r of tx.repeaters) outcome(r.ref, { kind: 'repeated', bytes: fragment, dir: r.dir, fragment: true }, now);
    }
    tx.jamSeq = mediumTimer(tx.end, dom.id, `${JAM_PREFIX}${st.key}`);
    st.phase = 'jam';
  };

  // ── timers ────────────────────────────────────────────────────────────────

  const onJamEnd = (st: Station, now: SimTime): void => {
    const tx = st.current;
    if (!tx || st.phase !== 'jam') return;
    delete tx.jamSeq;
    tx.done = true;
    const head = st.queue[0];
    if (!head) {
      finishAndContinue(st, now);
      return;
    }
    if (tx.late) {
      delete st.current;
      st.phase = 'idle';
      dropHead(st, 'late-collision', now);
      attempt(st, now);
      return;
    }
    if (head.collisions >= CSMA.MAX_ATTEMPTS) {
      delete st.current;
      st.phase = 'idle';
      dropHead(st, 'excessive-collisions', now, `${head.collisions} collisions`);
      attempt(st, now);
      return;
    }
    const slots = host.stream(`link:${tx.cable}:csma`).nextInt(0, backoffMaxSlots(head.collisions));
    const until = now + slots * tx.timing.slotNs;
    host.emit({ t: now, kind: 'backoff', device: st.ref.device, port: st.ref.port, pdu: head.pdu.id, attempt: head.collisions, slots, until });
    delete st.current;
    armTry(st, until, domainByPort.get(st.key)?.id ?? tx.segment);
  };

  // ── collision storm ───────────────────────────────────────────────────────

  const stormRng = (id: string) => host.stream(`fault:${id}`);

  /** Draw the next gap and arm the burst timer, unless the next burst would fall at or after the deadline. */
  const armStorm = (storm: Storm, now: SimTime): void => {
    const { lo, hi } = stormGapBounds(storm.params.burstsPerSec);
    const at = now + stormRng(storm.id).nextInt(lo, hi);
    if (at >= storm.until) {
      stormsById.delete(storm.id);
      return;
    }
    const medium = domainByPort.get(storm.key)?.id ?? `seg:${storm.id}`;
    storm.timerSeq = mediumTimer(at, medium, `${STORM_PREFIX}${storm.id}`);
  };

  /** One jam burst from the storm source: carrier on the domain, collisions for every half-duplex sender it reaches. */
  const burst = (storm: Storm, now: SimTime): void => {
    delete storm.timerSeq;
    const bytes = stormRng(storm.id).nextInt(CSMA.JAM_BYTES, CSMA.SLOT_BYTES);
    const dom = domainByPort.get(storm.key);
    if (dom !== undefined) {
      prune(now);
      const b: Burst = { fault: storm.id, source: storm.key, segment: dom.id, start: now, end: now + serializationNs(bytes, dom.timing.bps) };
      bursts.push(b);
      const detections: { tx: Transmission; at: SimTime }[] = [];
      for (const tx of records) {
        if (!tx.half || stations.get(tx.station)?.current !== tx || !dom.graph.has(tx.station)) continue;
        const d = tx.station === storm.key ? 0 : dom.graph.distance(storm.key, tx.station);
        if (d === undefined) continue;
        const at = now + d;
        if (at >= tx.wireEnd || (tx.aborted && at >= (tx.abortAt as SimTime))) continue;
        detections.push({ tx, at });
      }
      const memberIndex = (key: string): number => dom.stations.findIndex((r) => portKey(r) === key);
      detections.sort((x, y) => memberIndex(x.tx.station) - memberIndex(y.tx.station) || compareOrdinal(x.tx.station, y.tx.station));
      let jamUntil = b.end;
      let late = false;
      for (const { tx, at } of detections) {
        if (at + tx.timing.jamNs > jamUntil) jamUntil = at + tx.timing.jamNs;
        if (at - tx.start > tx.timing.slotNs) late = true;
      }
      collisionCount.set(dom.id, (collisionCount.get(dom.id) ?? 0) + 1);
      host.emit({
        t: now, kind: 'collision', segment: dom.id,
        stations: [{ device: storm.source.device, port: storm.source.port }, ...detections.map((x) => ({ device: x.tx.from.device, port: x.tx.from.port }))],
        pdus: detections.map((x) => x.tx.pdu.id), detectAt: now, jamUntil, late,
      });
      for (const { tx, at } of detections) abortForCollision(tx, at, dom, now);
    }
    armStorm(storm, now);
  };

  const stopStorm = (faultId: string, _now: SimTime): boolean => {
    const storm = stormsById.get(faultId);
    if (storm === undefined) return false;
    if (storm.timerSeq !== undefined) host.cancel(storm.timerSeq);
    stormsById.delete(faultId);
    return true;
  };

  const startStorm = (faultId: string, source: PortRef, params: CollisionStormParams, now: SimTime): boolean => {
    if (typeof params.burstsPerSec !== 'number' || !Number.isFinite(params.burstsPerSec) || params.burstsPerSec <= 0) {
      throw new RangeError(`collision storm ${faultId}: burstsPerSec must be a positive number, got ${params.burstsPerSec}`);
    }
    assertSimTime(params.durationNs, `collision storm ${faultId}: durationNs`);
    const key = portKey(source);
    if (!domainByPort.has(key)) return false;
    stopStorm(faultId, now);
    const storm: Storm = {
      id: faultId, source: { device: source.device, port: source.port }, key, until: now + params.durationNs,
      params: { burstsPerSec: params.burstsPerSec, durationNs: params.durationNs },
    };
    stormsById.set(faultId, storm);
    armStorm(storm, now);
    return true;
  };

  // ── domain rebuild ────────────────────────────────────────────────────────

  const rebuild = (now: SimTime): void => {
    const cables: SegmentCableInput[] = [];
    const states = new Map<LinkId, LinkState>();
    for (const id of options.links()) {
      const s = host.link(id);
      if (!s || (s.kind ?? 'cable') !== 'cable') continue;
      const pa = host.port(s.a);
      const pb = host.port(s.b);
      const roleA = roleOf(s.a);
      const roleB = roleOf(s.b);
      if (!pa || !pb || roleA === undefined || roleB === undefined) continue;
      states.set(id, s);
      const c: SegmentCableInput = { id, a: s.a, b: s.b, up: s.carrier ?? s.up, roleA, roleB };
      const da = s.phy?.a.duplex ?? (pa.duplex === 'half' || pa.duplex === 'full' ? pa.duplex : undefined);
      const db = s.phy?.b.duplex ?? (pb.duplex === 'half' || pb.duplex === 'full' ? pb.duplex : undefined);
      if (da !== undefined) c.duplexA = da;
      if (db !== undefined) c.duplexB = db;
      if (s.phy?.mismatch === 'duplex') c.mismatch = true;
      if (s.negotiatedBps !== undefined) c.bps = s.negotiatedBps;
      cables.push(c);
    }
    const portIndex = (ref: PortRef): number => {
      const i = options.devicePorts(ref.device).indexOf(ref.port);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    const formed = formSegments({
      cables,
      repeaterPorts: (device) => options.devicePorts(device).filter((port) => roleOf({ device, port }) === 'repeater'),
      deviceOrder: (device) => options.deviceOrder(device),
      portOrder: portIndex,
    });

    const next: LiveDomain[] = formed.map((dom) => {
      const graphCables: SegmentGraphCable[] = [];
      let coax = 0;
      for (const id of dom.links) {
        const s = states.get(id) as LinkState;
        const media: ResolvedMedia = s.resolvedMedia;
        graphCables.push({ id, a: s.a, b: s.b, ns: propagationNs(s.lengthM, MEDIA[media].velocityFactor) });
        if (media === 'coax') coax += s.lengthM;
      }
      return { ...dom, graph: buildSegmentGraph(dom, graphCables), timing: segmentTiming(dom.bps), coaxLengthM: coax };
    });

    const oldDomains = domains;
    const oldLinks = new Map(domainByLink);
    const oldPorts = new Map(domainByPort);
    domains = next;
    domainById.clear();
    domainByPort.clear();
    domainByLink.clear();
    for (const dom of next) {
      domainById.set(dom.id, dom);
      for (const id of dom.links) domainByLink.set(id, dom);
      for (const r of dom.stations) domainByPort.set(portKey(r), dom);
      for (const r of dom.repeaters) domainByPort.set(portKey(r), dom);
    }

    // Cables that left: cut every leg crossing them, then drop the queues of stations that left.
    const departed: LinkId[] = [];
    for (const id of oldLinks.keys()) if (!domainByLink.has(id)) departed.push(id);
    for (const id of departed) {
      for (const tx of records) cutLegs(tx, (leg) => leg.path.includes(id), now, 'left-segment');
      const s = host.link(id);
      if (s && s.segment !== undefined) delete s.segment;
    }
    for (const [key, dom] of oldPorts) {
      if (domainByPort.has(key)) continue;
      const ref = [...dom.stations, ...dom.repeaters].find((r) => portKey(r) === key);
      if (!ref) continue;
      const st = stations.get(key);
      if (st && dom.stationLinks.has(key)) dropStation(st, now, 'left-segment');
      const p = host.port(ref);
      if (p?.phy && p.phy.segment !== undefined) delete p.phy.segment;
    }
    for (const dom of next) {
      for (const id of dom.links) {
        const s = host.link(id);
        if (s) s.segment = dom.id;
      }
      for (const r of [...dom.stations, ...dom.repeaters]) {
        const p = host.port(r);
        if (p?.phy) p.phy.segment = dom.id;
        const st = stations.get(portKey(r));
        if (st) {
          st.segment = dom.id;
          const cable = dom.stationLinks.get(portKey(r));
          if (cable !== undefined) st.cable = cable;
        }
      }
    }

    const membersOf = (dom: SegmentDomain): PortRef[] => [...dom.stations, ...dom.repeaters].map((r) => ({ device: r.device, port: r.port }));
    const sameMembers = (x: SegmentDomain, y: SegmentDomain): boolean => {
      const mx = membersOf(x).map(portKey);
      const my = membersOf(y).map(portKey);
      return mx.length === my.length && mx.every((k, i) => k === my[i]) && x.links.join(',') === y.links.join(',');
    };
    for (const old of oldDomains) {
      if (!domainById.has(old.id)) {
        host.emit({ t: now, kind: 'segmentChanged', segment: old.id, members: [], op: 'dissolved' });
        collisionCount.delete(old.id);
      }
    }
    for (const dom of next) {
      const old = oldDomains.find((d) => d.id === dom.id);
      if (!old) host.emit({ t: now, kind: 'segmentChanged', segment: dom.id, members: membersOf(dom), op: 'formed' });
      else if (!sameMembers(old, dom)) host.emit({ t: now, kind: 'segmentChanged', segment: dom.id, members: membersOf(dom), op: 'changed' });
    }
  };

  // ── strategy ──────────────────────────────────────────────────────────────

  const strategy: SharedSegmentStrategy = {
    kind: 'segment',

    transmit(from, pdu, now): TransmitResult {
      const port = host.port(from);
      const cable = port?.link ?? options.linkOf?.(from);
      const state = cable === undefined ? undefined : host.link(cable);
      const refuse = (reason: 'link-down' | 'queue-full', detail: string | undefined, medium?: MediumId): TransmitResult => {
        const ev: TraceEvent = { t: now, kind: 'drop', pdu: summarizePdu(pdu), device: from.device, port: from.port, reason };
        if (detail !== undefined) ev.detail = detail;
        if (medium !== undefined) ev.medium = medium;
        host.emit(ev);
        return { ok: false, reason };
      };
      if (!port || !state) return refuse('link-down', 'no cable');
      if (!(state.carrier ?? state.up) || !port.operUp) return refuse('link-down', state.downReason ?? port.phy?.lineProtocolReason);
      const dom = domainByPort.get(portKey(from));
      if (!dom || !dom.stationLinks.has(portKey(from))) return refuse('link-down', 'no collision domain');
      const st = stationOf(from);
      if (st.queue.length >= CSMA.SEGMENT_TX_QUEUE_LIMIT) return refuse('queue-full', `${CSMA.SEGMENT_TX_QUEUE_LIMIT} frames already queued`, dom.id);
      st.queue.push({ pdu, collisions: 0, deferredReported: false });
      st.cable = dom.stationLinks.get(st.key);
      st.segment = dom.id;
      syncQueue(st);
      if (st.phase === 'idle') attempt(st, now);
      return { ok: true, link: dom.id, txStart: now, txEnd: now, arrive: now, deferred: true };
    },

    admit(ev: FrameArrivalBody, now: SimTime): ArrivalVerdict {
      const to: PortRef = { device: ev.device, port: ev.port };
      const key = `${ev.pdu.id}|${portKey(to)}`;
      const entry = arrivals.get(key);
      arrivals.delete(key);
      host.inflight.remove(ev.pdu.id, to);
      let collided = ev.collided === true;
      if (entry) {
        entry.rx.settled = true;
        delete entry.rx.seq;
        if (entry.rx.collided) collided = true;
      }
      const fragment = ev.fragmentBytes;
      const wire: WireEvent = { t: now, dir: 'rx', port: to, pdu: ev.pdu, linkType: captureLinkTypeOf(ev.pdu) };
      if (ev.corrupted === true) wire.corrupted = true;
      if (fragment !== undefined) wire.fragmentBytes = fragment;
      host.capture(wire);
      const rx: FrameRxInfo = { medium: 'segment' };
      if (collided) rx.collided = true;
      else if (fragment !== undefined) rx.fragmentBytes = fragment;
      const verdict: ArrivalVerdict = { deliver: true, pdu: ev.pdu, rx };
      if (ev.corrupted === true) verdict.corrupted = true;
      return verdict;
    },

    onTxComplete(ref: PortRef, now: SimTime): void {
      const st = stations.get(portKey(ref));
      const tx = st?.current;
      if (!st || !tx || st.phase !== 'tx' || tx.aborted) return;
      delete tx.txCompleteSeq;
      tx.done = true;
      st.stats.tx++;
      st.queue.shift();
      syncQueue(st);
      outcome(st.ref, { kind: 'sent', pdu: tx.pdu.id, txStart: tx.start, bytes: tx.pdu.size }, now);
      for (const r of tx.repeaters) outcome(r.ref, { kind: 'repeated', bytes: tx.pdu.size, dir: r.dir }, now);
      finishAndContinue(st, now);
    },

    onMediumTimer(_medium: MediumId, key: string, now: SimTime): OperChanges {
      if (key.startsWith(TRY_PREFIX)) {
        const st = stations.get(key.slice(TRY_PREFIX.length));
        if (st && st.phase === 'wait') {
          delete st.timerSeq;
          st.phase = 'idle';
          attempt(st, now);
        }
      } else if (key.startsWith(JAM_PREFIX)) {
        const st = stations.get(key.slice(JAM_PREFIX.length));
        if (st) onJamEnd(st, now);
      } else if (key.startsWith(STORM_PREFIX)) {
        const storm = stormsById.get(key.slice(STORM_PREFIX.length));
        if (storm !== undefined && storm.timerSeq !== undefined) burst(storm, now);
      }
      return [];
    },

    onPortChanged(_ref: PortRef, now: SimTime): OperChanges {
      rebuild(now);
      return [];
    },

    abort(scope: LinkId | MediumId, now: SimTime, detail?: string): void {
      const dom = domainById.get(scope);
      if (dom) {
        for (const r of dom.stations) {
          const st = stations.get(portKey(r));
          if (st) dropStation(st, now, detail);
        }
        return;
      }
      for (const st of stations.values()) {
        if (st.cable === scope && (st.current !== undefined || st.queue.length > 0)) dropStation(st, now, detail);
      }
      for (const tx of records) cutLegs(tx, (leg) => leg.path.includes(scope), now, detail);
    },

    contribute(now: SimTime, into: MediaSnapshot): void {
      for (const dom of domains) {
        const member = (ref: PortRef, role: 'station' | 'repeater'): SegmentMemberSnapshot => {
          const st = stations.get(portKey(ref));
          const p = host.port(ref);
          return {
            port: { device: ref.device, port: ref.port },
            role,
            duplex: role === 'station' && isFullDuplex(p) ? 'full' : 'half',
            tx: st?.stats.tx ?? 0,
            collisions: st?.stats.collisions ?? 0,
            lateCollisions: st?.stats.lateCollisions ?? 0,
            deferred: st?.stats.deferred ?? 0,
          };
        };
        const active: SegmentSnapshot['active'] = [];
        for (const tx of records) {
          if (!dom.stationLinks.has(tx.station) || tx.start > now || now >= tx.end) continue;
          const a: SegmentSnapshot['active'][number] = { pdu: tx.pdu.id, from: { device: tx.from.device, port: tx.from.port }, txStart: tx.start, txEnd: tx.end };
          if (tx.aborted) a.aborted = true;
          active.push(a);
        }
        const jamming = bursts.some((b) => b.segment === dom.id && b.start <= now && now < b.end);
        const snap: SegmentSnapshot = {
          id: dom.id,
          bps: dom.bps,
          members: [...dom.stations.map((r) => member(r, 'station')), ...dom.repeaters.map((r) => member(r, 'repeater'))],
          links: [...dom.links],
          busy: active.length > 0 || jamming,
          active,
          collisions: collisionCount.get(dom.id) ?? 0,
        };
        const warnings: NonNullable<SegmentSnapshot['warnings']> = [];
        if (dom.coaxLengthM > MEDIA.coax.maxLengthM) warnings.push('coax-segment-too-long');
        if (dom.graph.maxStationHops(dom.stations) > MAX_REPEATER_HOPS) warnings.push('repeater-rule-exceeded');
        if (warnings.length > 0) snap.warnings = warnings;
        into.segments.push(snap);
      }
    },

    rebuild,

    segmentOfLink: (id) => domainByLink.get(id)?.id,

    segmentOfPort: (ref) => domainByPort.get(portKey(ref))?.id,

    segments: () =>
      domains.map((d) => ({ id: d.id, links: [...d.links], stations: d.stations.map((r) => ({ ...r })), repeaters: d.repeaters.map((r) => ({ ...r })), bps: d.bps })),

    startStorm,

    stopStorm,

    storms: () => [...stormsById.keys()],
  };
  return strategy;
}
