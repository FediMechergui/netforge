/**
 * link/qos/scheduler.ts — the held queue of one scheduler port (ARCHITECTURE-P3 D16 [S20]/[S21], §3.11, §4.2, §4.5;
 * §7 W2 qos).
 *
 * A scheduler port is a routed physical port whose output policy holds a queueing action (`priority`, `bandwidth`,
 * `queue-limit`, `fair-queue`, `shape`), or whose interface carries `fair-queue` [S21]. Its compiled
 * `EgressSchedulerSpec` (contracts/link.ts, built by `qos/config.ts`) configures one `PortScheduler`, which the link
 * model's held queue (W3 media, `link/media/p2p.ts`) drives:
 *
 *   • `enqueue(packet, now, linkBusy)` at `transmit`: the frame's class is `qosClass` (the position of the output-policy
 *     class in `spec.classes`; absent or out of range = class-default). An output policer [S21] (`EgressClassSpec.police`;
 *     ruling R26: its `conform` / `exceed` actions, absent = transmit / drop, `qosPolicerAction`) runs first — a `drop`
 *     action drops `policed`, a `transmit` (or a `set-dscp-transmit`, which the scheduler cannot apply: `qos/config.ts`
 *     never hands it one, the runtime polices those classes) queues the frame — then the W1 scheduler
 *     (`core/queueing.ts`): the LLQ class's
 *     CONDITIONAL policer (only while the port is congested: the link busy, a frame waiting, or the shaper holding one),
 *     then the class's tail-drop limit. The result names the queue and its depth (the `frameQueued` event) or the drop
 *     reason with its detail text (§3.11 step 4).
 *   • `dequeue(now)` when the transmitter is free: priority classes first, then class DRR (CBWFQ), with flow DRR inside
 *     a fair-queue class (WFQ, [S21]); with a shaper [S21] the picked frame may have to wait: the result is then
 *     `{kind: 'wait', at}`, the shaper's next-eligible time (the link model arms its `qos:` medium timer there, §4.2), and
 *     the frame stays held (it leaves first at `at`).
 *   • `view(now)`: the display view (`EgressQueueView`): depth, limit and counters per class, and the 30-second offered
 *     rate (a sliding window of thirty whole sim-time seconds, integer).
 *
 * The shaper is a token bucket of `shapeBcBits` at `shapeBps` that may run into debt: a frame leaves when the bucket
 * holds its bits, or, for a frame larger than the bucket, when the bucket is full; its bits are then owed, so the long-
 * run rate is exactly `shapeBps`. It is kept as a theoretical departure time `tat` plus a remainder below the rate
 * (no division chains, no drift): `bits × 10⁹ / rate` is split exactly in integers.
 *
 * Also here: the [S21] policer the runtime uses at step 10c and for output marking (`createQosPolicer`), the WFQ flow
 * key of a frame (`qosFlowOf`, the flow DRR weight is IP precedence + 1), the 75 % admission function
 * (`egressAdmission`) and a whole-run simulation over synthetic arrivals (`simulatePortScheduler`, the reference of the
 * scheduler's tests and of the media's held queue).
 *
 * Integer only (§4.5): no floating-point maths, no randomness, no clocks, no module state.
 */
import type { EgressClassSpec, EgressQueueView, EgressSchedulerSpec, PolicerAction, PolicerSpec } from '../../contracts/link.js';
import type { PduView } from '../../contracts/pdu.js';
import { SEC, serializationNs, type SimTime } from '../../contracts/time.js';
import { tupleOf } from '../../core/acl.js';
import { createQueueScheduler, createTokenBucket, defaultClassIndex, takeTokens, type QueueingPacket, type TokenBucket } from '../../core/queueing.js';

// ── constants ───────────────────────────────────────────────────────────────

/** @since P3 [S20] The default tail-drop limit of every class of a policy, in packets (§3.11: "full (64 packets)"). */
export const QOS_DEFAULT_QUEUE_LIMIT = 64;

/** @since P3 [S20] Admission: the priority and bandwidth classes may reserve at most this share of the reference rate. */
export const QOS_ADMISSION_PERCENT = 75;

/** @since P3 [S21] A shaper without a `bc` gets this much of its rate as its bucket (100 ms: `bc = rate / 10` bits). */
export const QOS_SHAPE_DEFAULT_TC_MS = 100;

/** @since P3 [S21] The smallest default policer burst, in bytes (a full-size frame). */
export const QOS_POLICE_MIN_BURST_BYTES = 1500;

/** @since P3 [S20] The offered-rate window of the queue view, in whole sim-time seconds. */
export const QOS_OFFERED_WINDOW_S = 30;

/** Largest rate a bucket accepts (core/queueing's bound). */
const MAX_RATE_BPS = 1_099_511_627_776; // 2^40
/** Largest bucket or frame size, in bits, the shaper's exact arithmetic accepts. */
const MAX_SHAPER_BITS = 4_294_967_296; // 2^32
/** `floor(bits / rate)` must stay below this, so `bits × 10⁹ / rate` stays a safe integer. */
const MAX_WHOLE_SECONDS = 8_000_000;

// ── formatting of drop details ──────────────────────────────────────────────

/** A rate as the drop details print it: `32 kb/s` when it is a whole number of kb/s, else `154400 b/s`. */
export function qosRateText(bps: number): string {
  return bps % 1000 === 0 ? `${bps / 1000} kb/s` : `${bps} b/s`;
}

/** @since P3 [S20] The detail of a tail drop: `class class-default is full (64 packets)` (§3.11 step 4). */
export function qosQueueFullDetail(c: Pick<EgressClassSpec, 'name' | 'kind' | 'queueLimit'>): string {
  return `${c.kind === 'priority' ? 'priority class' : 'class'} ${c.name} is full (${c.queueLimit} packets)`;
}

/**
 * @since P3 [S20]/[S21] The detail of a policer drop: the LLQ policer `priority class VOICE is over its 32 kb/s` (§3.11
 * step 4); a `police` exceed `class BULK is over its police rate of 64 kb/s`.
 */
export function qosPolicedDetail(className: string, by: 'priority' | 'police', rateBps: number): string {
  return by === 'priority'
    ? `priority class ${className} is over its ${qosRateText(rateBps)}`
    : `class ${className} is over its police rate of ${qosRateText(rateBps)}`;
}

/**
 * @since P3 [S21] Ruling R26: the detail of a drop by a `conform-action drop` (a frame within the police rate that the
 * class drops anyway): `class BULK drops traffic within its police rate of 64 kb/s`.
 */
export function qosPoliceConformDropDetail(className: string, rateBps: number): string {
  return `class ${className} drops traffic within its police rate of ${qosRateText(rateBps)}`;
}

// ── admission (the 75 % rule) ───────────────────────────────────────────────

/** @since P3 [S20] The outcome of the 75 % admission check (`qosAdmission` refuses when `ok` is false). */
export interface EgressAdmission {
  readonly ok: boolean;
  /** Sum of the priority and bandwidth reservations, b/s. */
  readonly askedBps: number;
  readonly refBps: number;
  /** 75 % of the reference rate, b/s (rounded down; `ok` compares exactly: asked × 4 ≤ ref × 3). */
  readonly limitBps: number;
  /** The message's numbers: the request rounded up, the reference rounded down, in kb/s. */
  readonly askedKbps: number;
  readonly refKbps: number;
}

/**
 * @since P3 [S20] The 75 % admission function: a policy whose priority and bandwidth classes reserve more than 75 % of
 * the port's reference rate (`refBps`: the `bandwidth` line, else the negotiated rate) is refused. `reservationsBps`
 * are the reservations in b/s (`bandwidth remaining percent` reserves nothing). Exact in integers.
 */
export function egressAdmission(refBps: number, reservationsBps: readonly number[]): EgressAdmission {
  let asked = 0;
  for (const r of reservationsBps) asked += r;
  const ref = refBps > 0 ? refBps : 0;
  return {
    ok: asked * 4 <= ref * 3,
    askedBps: asked,
    refBps: ref,
    limitBps: Math.floor((ref * QOS_ADMISSION_PERCENT) / 100),
    askedKbps: Math.ceil(asked / 1000),
    refKbps: Math.floor(ref / 1000),
  };
}

// ── the policer [S21] ───────────────────────────────────────────────────────

/** @since P3 [S21] The default `police` burst for a rate: 250 ms of it (`rate / 32` bytes), at least 1500 bytes. */
export function qosPoliceBurstBytes(rateBps: number): number {
  return Math.max(QOS_POLICE_MIN_BURST_BYTES, Math.floor(rateBps / 32));
}

/** @since P3 [S21] A single-rate two-colour policer's verdict for one packet. */
export type QosPolicerResult = 'conform' | 'exceed';

/** @since P3 [S21] A policer (mutable state owned by its user: the runtime per port, direction and class, or a scheduler). */
export interface QosPolicer {
  readonly spec: PolicerSpec;
  readonly bucket: TokenBucket;
  conform: number;
  conformBytes: number;
  exceed: number;
  exceedBytes: number;
}

/** @since P3 [S21] A policer at `spec.rateBps` with a bucket of `spec.burstBytes`, full at `now`. */
export function createQosPolicer(spec: PolicerSpec, now: SimTime): QosPolicer {
  return { spec, bucket: createTokenBucket(spec.rateBps, spec.burstBytes * 8, now), conform: 0, conformBytes: 0, exceed: 0, exceedBytes: 0 };
}

/**
 * @since P3 [S21] Police one packet of `bytes` at `now`: it conforms when the bucket holds its bits (they are taken),
 * else it exceeds (the bucket is untouched). Counts conform and exceed packets and bytes.
 */
export function policeQosPacket(p: QosPolicer, bytes: number, now: SimTime): QosPolicerResult {
  if (takeTokens(p.bucket, bytes * 8, now)) {
    p.conform++;
    p.conformBytes += bytes;
    return 'conform';
  }
  p.exceed++;
  p.exceedBytes += bytes;
  return 'exceed';
}

const POLICE_TRANSMIT: PolicerAction = Object.freeze({ kind: 'transmit' });
const POLICE_DROP: PolicerAction = Object.freeze({ kind: 'drop' });

/**
 * @since P3 [S21] Ruling R26: the action a policer of `spec` takes for a verdict — its `conform` / `exceed` action,
 * absent = transmit / drop (the W0 behaviour).
 */
export function qosPolicerAction(spec: Pick<PolicerSpec, 'conform' | 'exceed'>, verdict: QosPolicerResult): PolicerAction {
  return verdict === 'conform' ? (spec.conform ?? POLICE_TRANSMIT) : (spec.exceed ?? POLICE_DROP);
}

// ── the shaper [S21] ────────────────────────────────────────────────────────

/** @since P3 [S21] The default shaper bucket of a rate: 100 ms of it, in bits (≥ 1). */
export function qosShapeDefaultBcBits(rateBps: number): number {
  return Math.max(1, Math.floor((rateBps * QOS_SHAPE_DEFAULT_TC_MS) / 1000));
}

/**
 * @since P3 [S21] A port shaper (mutable, owned by its scheduler). The bucket is full when the theoretical departure
 * time `tat + rem / rateBps` ns is at or before now; it holds `bcBits − rateBps × (TAT − now)` bits otherwise.
 */
export interface QosShaper {
  readonly rateBps: number;
  readonly bcBits: number;
  /** Whole ns of the theoretical departure time. */
  tat: SimTime;
  /** Remainder: the departure time is `tat + rem / rateBps` ns; 0 ≤ rem < rateBps. */
  rem: number;
}

function assertShaperBits(bits: number, rate: number, what: string): void {
  if (!Number.isInteger(bits) || bits <= 0 || bits > MAX_SHAPER_BITS || Math.floor(bits / rate) >= MAX_WHOLE_SECONDS) {
    throw new RangeError(`shaper ${what} ${bits} bits out of range at ${rate} b/s`);
  }
}

/** @since P3 [S21] A shaper at `rateBps` with a bucket of `bcBits`, full at `now`. */
export function createQosShaper(rateBps: number, bcBits: number, now: SimTime): QosShaper {
  if (!Number.isInteger(rateBps) || rateBps <= 0 || rateBps > MAX_RATE_BPS) throw new RangeError(`shaper rate ${rateBps} b/s out of range`);
  assertShaperBits(bcBits, rateBps, 'bucket');
  return { rateBps, bcBits, tat: now, rem: 0 };
}

/** `bits × 10⁹ = q × rate + r` exactly (0 ≤ r < rate), by long division in steps of 10³ (every product below 2⁵³). */
function bitsToNs(bits: number, rate: number): { q: number; r: number } {
  const qn = Math.floor(bits / rate);
  let r = bits - qn * rate;
  let q = 0;
  for (let step = 0; step < 3; step++) {
    const x = r * 1000;
    const d = Math.floor(x / rate);
    q = q * 1000 + d;
    r = x - d * rate;
  }
  return { q: qn * SEC + q, r };
}

/**
 * @since P3 [S21] The shaper's next-eligible time for a frame of `bits` (≥ `now`): the first whole ns at which the
 * bucket holds `min(bits, bcBits)` bits. Exact integer ceiling.
 */
export function qosShaperEligibleAt(s: QosShaper, bits: number, now: SimTime): SimTime {
  assertShaperBits(bits, s.rateBps, 'frame');
  // eligible when TAT − now ≤ slack / rate, slack = bc − min(bits, bc): at E = ceil(TAT − slack × 10⁹ / rate)
  const slack = s.bcBits - Math.min(bits, s.bcBits);
  const { q, r } = bitsToNs(slack, s.rateBps);
  // TAT − slack/rate = (tat − q) + (rem − r) / rate
  const e = s.rem > r ? s.tat - q + 1 : s.tat - q;
  return e > now ? e : now;
}

/** @since P3 [S21] Charge a frame of `bits` sent at `now` (call only at or after its eligible time). */
export function qosShaperSend(s: QosShaper, bits: number, now: SimTime): void {
  assertShaperBits(bits, s.rateBps, 'frame');
  if (s.tat < now || (s.tat === now && s.rem === 0)) {
    s.tat = now;
    s.rem = 0;
  }
  const { q, r } = bitsToNs(bits, s.rateBps);
  let rem = s.rem + r;
  let tat = s.tat + q;
  if (rem >= s.rateBps) {
    rem -= s.rateBps;
    tat += 1;
  }
  s.tat = tat;
  s.rem = rem;
}

// ── WFQ flows [S21] ─────────────────────────────────────────────────────────

/** @since P3 [S21] The flow of a frame in a fair-queue class: its key and its DRR weight. */
export interface QosFlowKey {
  readonly flow: string;
  /** IP precedence + 1 (classic WFQ: a flow's share grows with its precedence); 1 for a frame without IP. */
  readonly flowWeight: number;
}

function uintField(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
}

/**
 * @since P3 [S21] The WFQ flow of a frame, from its first IP layer: IPv4 by (protocol, source, source port,
 * destination, destination port) through `tupleOf`, IPv6 by (next header, source, destination); a frame without IP is
 * one shared flow `''`. The weight is the IP precedence (DSCP ≫ 3) + 1.
 */
export function qosFlowOf(pdu: Pick<PduView, 'layers'>): QosFlowKey {
  const ip = pdu.layers.find((l) => l.proto === 'ipv4' || l.proto === 'ipv6');
  if (ip === undefined) return { flow: '', flowWeight: 1 };
  if (ip.proto === 'ipv4') {
    const t = tupleOf(pdu);
    const dscp = uintField(ip.fields['dscp']) ?? 0;
    if (t === undefined) return { flow: '', flowWeight: (dscp >> 3) + 1 };
    return { flow: `4|${t.proto}|${t.src}|${t.srcPort ?? ''}|${t.dst}|${t.dstPort ?? ''}`, flowWeight: (dscp >> 3) + 1 };
  }
  const tc = uintField(ip.fields['trafficClass']) ?? 0;
  const f = ip.fields;
  return { flow: `6|${String(f['nextHeader'] ?? '')}|${String(f['src'] ?? '')}|${String(f['dst'] ?? '')}`, flowWeight: (tc >> 5) + 1 };
}

// ── the port scheduler ──────────────────────────────────────────────────────

/** @since P3 [S20] A frame offered to a scheduler port. */
export interface PortSchedulerPacket<T> {
  readonly item: T;
  /** Frame size on the wire (bytes, a positive integer): what the shaper, the policers and DRR count. */
  readonly bytes: number;
  /** The position of the frame's output-policy class in `spec.classes`; absent or out of range = class-default. */
  readonly qosClass?: number;
  /** Fair-queue classes: the flow (`qosFlowOf`); absent = one shared flow. */
  readonly flow?: string;
  readonly flowWeight?: number;
}

/** @since P3 [S20] The outcome of `PortScheduler.enqueue`: the queue joined, or the drop with its detail. */
export type PortEnqueueResult =
  | { readonly ok: true; readonly cls: number; readonly queue: string; /** The class's depth after the enqueue. */ readonly depth: number }
  | { readonly ok: false; readonly cls: number; readonly queue: string; readonly reason: 'queue-full' | 'policed'; readonly detail: string };

/** @since P3 [S20]/[S21] The outcome of `PortScheduler.dequeue`. */
export type PortDequeueResult<T> =
  | { readonly kind: 'packet'; readonly item: T; readonly bytes: number; readonly cls: number; readonly queue: string }
  /** [S21] The shaper holds the next frame until `at` (> now); nothing leaves before then. */
  | { readonly kind: 'wait'; readonly at: SimTime }
  | { readonly kind: 'empty' };

/** @since P3 [S21] The counters of a class's output policer (display: conform and exceed). */
export interface PortPolicerStats {
  readonly cls: number;
  readonly name: string;
  readonly conform: number;
  readonly conformBytes: number;
  readonly exceed: number;
  readonly exceedBytes: number;
}

/** @since P3 [S20] The scheduler of one egress port (one per scheduler port, owned by the link model). */
export interface PortScheduler<T> {
  readonly spec: EgressSchedulerSpec;
  /** Frames held in every class (the one a shaper holds included). */
  readonly depth: number;
  /** The class index a frame with `qosClass` joins (class-default when absent or out of range). */
  classOf(qosClass?: number): number;
  /** Offer a frame at `now`; `linkBusy` = the transmitter is still serialising a frame. */
  enqueue(p: PortSchedulerPacket<T>, now: SimTime, linkBusy: boolean): PortEnqueueResult;
  /** The next frame to transmit at `now` (call when the transmitter is free), or the shaper's wait, or empty. */
  dequeue(now: SimTime): PortDequeueResult<T>;
  /** Remove every held frame (link down, policy replaced), in the order they would have left; they count as never sent. */
  drain(): T[];
  view(now: SimTime): EgressQueueView;
  /** Output policers of the classes that have one, in class order. */
  policerStats(): PortPolicerStats[];
}

interface OfferedWindow {
  readonly sec: number[];
  readonly bytes: number[];
}

function newWindow(): OfferedWindow {
  return { sec: new Array<number>(QOS_OFFERED_WINDOW_S).fill(-1), bytes: new Array<number>(QOS_OFFERED_WINDOW_S).fill(0) };
}

function windowAdd(w: OfferedWindow, now: SimTime, bytes: number): void {
  const s = Math.floor(now / SEC);
  const i = s % QOS_OFFERED_WINDOW_S;
  if (w.sec[i] !== s) {
    w.sec[i] = s;
    w.bytes[i] = 0;
  }
  w.bytes[i] = w.bytes[i]! + bytes;
}

/** Offered b/s over the thirty whole seconds ending with the current one: floor(bytes × 8 / 30). */
function windowBps(w: OfferedWindow, now: SimTime): number {
  const s = Math.floor(now / SEC);
  let total = 0;
  for (let i = 0; i < QOS_OFFERED_WINDOW_S; i++) {
    const at = w.sec[i]!;
    if (at >= 0 && at <= s && at > s - QOS_OFFERED_WINDOW_S) total += w.bytes[i]!;
  }
  return Math.floor((total * 8) / QOS_OFFERED_WINDOW_S);
}

interface PreCounters {
  matched: number;
  matchedBytes: number;
  policed: number;
  flushed: number;
}

/**
 * @since P3 [S20]/[S21] A scheduler for a port configured by `spec`, its policers full and its shaper idle at `now`.
 * Throws RangeError for a spec without classes or with an out-of-range rate.
 */
export function createPortScheduler<T>(spec: EgressSchedulerSpec, now: SimTime): PortScheduler<T> {
  const core = createQueueScheduler<T>({ classes: spec.classes }, now);
  const defaultIndex = defaultClassIndex({ classes: spec.classes });
  const policers: (QosPolicer | undefined)[] = spec.classes.map((c) =>
    c.police !== undefined && c.police.rateBps > 0 ? createQosPolicer(c.police, now) : undefined,
  );
  const shaper =
    spec.shapeBps !== undefined && spec.shapeBps > 0
      ? createQosShaper(spec.shapeBps, spec.shapeBcBits !== undefined && spec.shapeBcBits > 0 ? spec.shapeBcBits : qosShapeDefaultBcBits(spec.shapeBps), now)
      : undefined;
  const pre: PreCounters[] = spec.classes.map(() => ({ matched: 0, matchedBytes: 0, policed: 0, flushed: 0 }));
  const offered: OfferedWindow[] = spec.classes.map(() => newWindow());
  let staged: QueueingPacket<T> | undefined;

  const classOf = (qosClass?: number): number =>
    qosClass !== undefined && Number.isInteger(qosClass) && qosClass >= 0 && qosClass < spec.classes.length ? qosClass : defaultIndex;

  const take = (p: QueueingPacket<T>): PortDequeueResult<T> => ({ kind: 'packet', item: p.item, bytes: p.bytes, cls: p.cls, queue: spec.classes[p.cls]!.name });

  return {
    spec,
    get depth(): number {
      return core.depth + (staged === undefined ? 0 : 1);
    },
    classOf,
    enqueue(p: PortSchedulerPacket<T>, at: SimTime, linkBusy: boolean): PortEnqueueResult {
      const cls = classOf(p.qosClass);
      const c = spec.classes[cls]!;
      windowAdd(offered[cls]!, at, p.bytes);
      const policer = policers[cls];
      if (policer !== undefined) {
        const verdict = policeQosPacket(policer, p.bytes, at);
        if (qosPolicerAction(policer.spec, verdict).kind === 'drop') {
          const k = pre[cls]!;
          k.matched++;
          k.matchedBytes += p.bytes;
          k.policed++;
          const rate = policer.spec.rateBps;
          const detail = verdict === 'exceed' ? qosPolicedDetail(c.name, 'police', rate) : qosPoliceConformDropDetail(c.name, rate);
          return { ok: false, cls, queue: c.name, reason: 'policed', detail };
        }
      }
      const r = core.enqueue(
        {
          item: p.item,
          bytes: p.bytes,
          cls,
          ...(p.flow === undefined ? {} : { flow: p.flow }),
          ...(p.flowWeight === undefined ? {} : { flowWeight: p.flowWeight }),
        },
        at,
        linkBusy || staged !== undefined,
      );
      if (r.ok) return { ok: true, cls, queue: c.name, depth: r.depth + (staged !== undefined && staged.cls === cls ? 1 : 0) };
      const detail = r.reason === 'policed' ? qosPolicedDetail(c.name, 'priority', c.rateBps ?? 0) : qosQueueFullDetail(c);
      return { ok: false, cls, queue: c.name, reason: r.reason, detail };
    },
    dequeue(at: SimTime): PortDequeueResult<T> {
      if (staged === undefined) {
        staged = core.dequeue(at);
        if (staged === undefined) return { kind: 'empty' };
      }
      if (shaper !== undefined) {
        const bits = staged.bytes * 8;
        const eligible = qosShaperEligibleAt(shaper, bits, at);
        if (eligible > at) return { kind: 'wait', at: eligible };
        qosShaperSend(shaper, bits, at);
      }
      const p = staged;
      staged = undefined;
      return take(p);
    },
    drain(): T[] {
      const out: T[] = [];
      const flush = (p: QueueingPacket<T>): void => {
        pre[p.cls]!.flushed++;
        out.push(p.item);
      };
      if (staged !== undefined) flush(staged);
      staged = undefined;
      for (let p = core.dequeue(0); p !== undefined; p = core.dequeue(0)) flush(p);
      return out;
    },
    view(at: SimTime): EgressQueueView {
      const stats = core.classStats();
      return {
        ...(spec.policy === '' ? {} : { policy: spec.policy }),
        strategy: spec.policy === '' ? 'fair' : 'class-based',
        refBps: spec.refBps,
        classes: spec.classes.map((c, i) => {
          const s = stats[i]!;
          const k = pre[i]!;
          const held = staged !== undefined && staged.cls === i ? 1 : 0;
          return {
            name: c.name,
            kind: c.kind,
            depth: s.depth + held,
            limit: c.queueLimit,
            matched: s.matched + k.matched,
            matchedBytes: s.matchedBytes + k.matchedBytes,
            sent: s.sent - held - k.flushed,
            tailDrops: s.tailDrops,
            policed: s.policed + k.policed,
            offeredBps30s: windowBps(offered[i]!, at),
            ...(c.kind !== 'priority' && c.fairQueue === true ? { flows: s.flows } : {}),
          };
        }),
      };
    },
    policerStats(): PortPolicerStats[] {
      const out: PortPolicerStats[] = [];
      policers.forEach((p, cls) => {
        if (p !== undefined) {
          out.push({ cls, name: spec.classes[cls]!.name, conform: p.conform, conformBytes: p.conformBytes, exceed: p.exceed, exceedBytes: p.exceedBytes });
        }
      });
      return out;
    },
  };
}

// ── a whole run over synthetic arrivals (the reference of the held queue) ───

/** @since P3 [S20] One synthetic arrival at a scheduler port. */
export interface PortArrival {
  readonly at: SimTime;
  readonly bytes: number;
  readonly qosClass?: number;
  readonly flow?: string;
  readonly flowWeight?: number;
}

/** @since P3 [S20] What happened to one arrival (same index as the input). */
export interface PortDeparture {
  readonly index: number;
  readonly arrival: SimTime;
  /** The class the frame joined (`PortScheduler.classOf`). */
  readonly cls: number;
  /** Serialisation start and end (absent when dropped, or still held when the arrivals end: never, the run drains). */
  readonly start?: SimTime;
  readonly end?: SimTime;
  readonly waitNs?: number;
  readonly dropped?: 'queue-full' | 'policed';
  readonly detail?: string;
}

/**
 * @since P3 [S20]/[S21] Run `arrivals` through a port scheduler on one link of `rateBps` (serialisation
 * `serializationNs(bytes + overheadBytes, rateBps)`). At each instant every arrival due is offered first (index order
 * among equal times; `linkBusy` = a frame still serialising), then, when the link is free and no shaper wait is pending,
 * the scheduler picks the next frame or names the shaper's next-eligible time. One departure per arrival, input order.
 */
export function simulatePortScheduler(
  spec: EgressSchedulerSpec,
  arrivals: readonly PortArrival[],
  rateBps: number,
  opts: { readonly overheadBytes?: number } = {},
): PortDeparture[] {
  const overhead = opts.overheadBytes ?? 0;
  const order = arrivals.map((_, i) => i).sort((a, b) => arrivals[a]!.at - arrivals[b]!.at || a - b);
  const start = order.length > 0 ? arrivals[order[0]!]!.at : 0;
  const sched = createPortScheduler<number>(spec, start);
  const out: (PortDeparture | undefined)[] = new Array(arrivals.length);
  let i = 0;
  let busyUntil = 0;
  let gate = 0;
  let now = start;
  for (;;) {
    const nextArrival = i < order.length ? arrivals[order[i]!]!.at : Number.POSITIVE_INFINITY;
    const nextService = sched.depth > 0 ? Math.max(busyUntil, gate, now) : Number.POSITIVE_INFINITY;
    const t = Math.min(nextArrival, nextService);
    if (t === Number.POSITIVE_INFINITY) break;
    now = t;
    while (i < order.length && arrivals[order[i]!]!.at === now) {
      const index = order[i]!;
      const a = arrivals[index]!;
      const r = sched.enqueue(
        {
          item: index,
          bytes: a.bytes,
          ...(a.qosClass === undefined ? {} : { qosClass: a.qosClass }),
          ...(a.flow === undefined ? {} : { flow: a.flow }),
          ...(a.flowWeight === undefined ? {} : { flowWeight: a.flowWeight }),
        },
        now,
        busyUntil > now,
      );
      if (!r.ok) out[index] = { index, arrival: a.at, cls: r.cls, dropped: r.reason, detail: r.detail };
      i++;
    }
    if (busyUntil <= now && gate <= now && sched.depth > 0) {
      const r = sched.dequeue(now);
      if (r.kind === 'packet') {
        const a = arrivals[r.item]!;
        const end = now + serializationNs(r.bytes + overhead, rateBps);
        out[r.item] = { index: r.item, arrival: a.at, cls: r.cls, start: now, end, waitNs: now - a.at };
        busyUntil = end;
      } else if (r.kind === 'wait') {
        gate = r.at;
      }
    }
  }
  return out.map((d, index) => d ?? { index, arrival: arrivals[index]!.at, cls: sched.classOf(arrivals[index]!.qosClass) });
}
