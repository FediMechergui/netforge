/**
 * core/queueing.ts — the pure packet scheduler (ARCHITECTURE-P3 D16, §3.5 step 7, §3.11, §4.5; §7 W1 core).
 *
 * One scheduler serves the queueing sandbox (W2/W3 web-concept, over synthetic arrivals) and the [S20]/[S21] held
 * queue of a scheduler port (W3 qos, `link/qos/scheduler.ts`), so the two can never disagree (the D10 principle).
 * It is configured by the classes of a compiled output policy (`EgressClassSpec`, contracts/link.ts), in policy order:
 *
 *   • FIFO           one `default` class;
 *   • WFQ            one `default` class with `fairQueue`: flow DRR (a listed deviation: WFQ is scheduled as deficit
 *                    round robin over flows, R2 (21));
 *   • CBWFQ          `bandwidth` classes and `default`, served by class DRR with quanta proportional to `weightKbps`;
 *   • LLQ            a `priority` class served first, always, with a CONDITIONAL token-bucket policer (`rateBps`,
 *                    `burstBytes`): it polices only while the port is congested (the link busy or a packet waiting);
 *                    an uncongested priority packet passes and is not charged. Without `burstBytes` the burst is
 *                    200 ms of the rate (`llqBurstBytes`; the listed [S20] deviation "a 200 ms LLQ burst").
 *
 * Deficit round robin (Shreedhar–Varghese): each active class (and each active flow of a fair-queue class) keeps a
 * deficit; a visit adds its quantum, sends head packets while they fit, and passes the turn on; a class that empties
 * loses its deficit. Quanta are integers: a class gets `weight × base` bytes, `base = ceil(quantumBytes / smallest
 * weight)`, so the ratio of any two quanta is exactly the ratio of their weights and every quantum is at least
 * `quantumBytes` (default 1500: one visit sends at least one full-size packet). Flows in first-seen order; a flow's
 * quantum is `quantumBytes × flowWeight` (default weight 1).
 *
 * Token buckets count bits. A refill of `elapsed` ns at `rate` b/s adds floor((elapsed × rate + carry) / 10⁹) bits and
 * keeps the remainder in `carry`, computed exactly in integers below 2⁵³ (the elapsed time is capped at the bucket's
 * fill time and the products are split), so any sequence of refills adds exactly the bits one refill over the whole
 * interval would: no drift. Rates up to 2⁴⁰ b/s.
 *
 * Tail drop at each class's `queueLimit` (packets; ≤ 0 = no limit), reason 'queue-full'; a policed packet: 'policed'
 * (the contracts' drop reasons). Integer only: no floating-point maths, no randomness, no module state.
 */
import type { EgressClassSpec } from '../contracts/link.js';
import { serializationNs, type SimTime } from '../contracts/time.js';

// ── token bucket ────────────────────────────────────────────────────────────

/** @since P3 A token bucket counted in bits (mutable state owned by its user). */
export interface TokenBucket {
  readonly rateBps: number;
  readonly capacityBits: number;
  tokensBits: number;
  /** Refill remainder: `elapsed × rate` bit·ns not yet worth a whole bit, 0 ≤ carry < 10⁹. */
  carry: number;
  /** Time of the last refill. */
  at: SimTime;
}

const NS_PER_SEC = 1_000_000_000;
const TWO_20 = 1_048_576;
const MAX_RATE_BPS = 1_099_511_627_776; // 2^40

function assertBucket(rateBps: number, capacityBits: number): void {
  if (!Number.isInteger(rateBps) || rateBps <= 0 || rateBps > MAX_RATE_BPS) throw new RangeError(`token bucket rate ${rateBps} b/s out of range`);
  if (!Number.isInteger(capacityBits) || capacityBits <= 0) throw new RangeError(`token bucket capacity ${capacityBits} bits must be a positive integer`);
}

/** @since P3 A full bucket at `now`. */
export function createTokenBucket(rateBps: number, capacityBits: number, now: SimTime): TokenBucket {
  assertBucket(rateBps, capacityBits);
  return { rateBps, capacityBits, tokensBits: capacityBits, carry: 0, at: now };
}

/** @since P3 Add the bits earned since the last refill (exact, remainder carried); never above the capacity. */
export function refillTokenBucket(b: TokenBucket, now: SimTime): void {
  const elapsed = now - b.at;
  if (elapsed <= 0) return;
  b.at = now;
  if (b.tokensBits >= b.capacityBits) {
    b.tokensBits = b.capacityBits;
    b.carry = 0;
    return;
  }
  const rate = b.rateBps;
  const secs = Math.floor(elapsed / NS_PER_SEC);
  // any whole second beyond the time a full refill takes cannot matter: cap it so every product stays below 2^53
  if (secs > Math.floor(b.capacityBits / rate) + 1) {
    b.tokensBits = b.capacityBits;
    b.carry = 0;
    return;
  }
  const subNs = elapsed - secs * NS_PER_SEC;
  // subNs × rate + carry, divided by 10^9 exactly: rate = rh × 2^20 + rl
  const rh = Math.floor(rate / TWO_20);
  const rl = rate - rh * TWO_20;
  const a = subNs * rh; // < 10^9 × 2^20
  const qa = Math.floor(a / NS_PER_SEC);
  const ra = a - qa * NS_PER_SEC;
  const num = ra * TWO_20 + subNs * rl + b.carry; // < 2^51
  const whole = Math.floor(num / NS_PER_SEC);
  const added = secs * rate + qa * TWO_20 + whole;
  const tokens = b.tokensBits + added;
  if (tokens >= b.capacityBits) {
    b.tokensBits = b.capacityBits;
    b.carry = 0;
  } else {
    b.tokensBits = tokens;
    b.carry = num - whole * NS_PER_SEC;
  }
}

/** @since P3 Refill, then take `bits` if the bucket holds them (true) or leave it untouched (false). */
export function takeTokens(b: TokenBucket, bits: number, now: SimTime): boolean {
  refillTokenBucket(b, now);
  if (bits > b.tokensBits) return false;
  b.tokensBits -= bits;
  return true;
}

/**
 * @since P3 How long after `now` the bucket will hold `bits` (0 when it already does); undefined when `bits` exceeds
 * the capacity (never). Exact integer ceiling; used by a shaper to time its next dequeue.
 */
export function tokenWaitNs(b: TokenBucket, bits: number, now: SimTime): number | undefined {
  if (bits > b.capacityBits) return undefined;
  refillTokenBucket(b, now);
  const need = bits - b.tokensBits;
  if (need <= 0) return 0;
  const rate = b.rateBps;
  // smallest t with t × rate + carry ≥ need × 10^9, by long division in steps of 10^3 (every product < 2^53)
  const qn = Math.floor(need / rate);
  const rn = need - qn * rate;
  let q = 0;
  let r = rn;
  for (let step = 0; step < 3; step++) {
    const x = r * 1000;
    const d = Math.floor(x / rate);
    q = q * 1000 + d;
    r = x - d * rate;
  }
  // need × 10^9 − carry = rate × (qn × 10^9 + q) + (r − carry), with 0 ≤ r < rate and 0 ≤ carry < 10^9
  const rest = r - b.carry;
  const adjust = rest > 0 ? 1 : -Math.floor(-rest / rate);
  return Math.max(0, qn * NS_PER_SEC + q + adjust);
}

// ── scheduler ───────────────────────────────────────────────────────────────

/** @since P3 The class fields the scheduler reads (a compiled `EgressClassSpec`, or a sandbox class). */
export type QueueingClassSpec = Pick<EgressClassSpec, 'name' | 'kind' | 'weightKbps' | 'queueLimit' | 'rateBps' | 'burstBytes' | 'fairQueue'>;

/** @since P3 A scheduler's configuration: the classes in policy order. */
export interface QueueingSpec {
  readonly classes: readonly QueueingClassSpec[];
  /** Smallest DRR quantum in bytes, and a flow's quantum at weight 1 (default `QUEUEING_QUANTUM_BYTES`). */
  readonly quantumBytes?: number;
}

/** @since P3 The default DRR quantum: one full-size Ethernet payload. */
export const QUEUEING_QUANTUM_BYTES = 1500;

/** @since P3 [S20] The LLQ policer's burst, in milliseconds of its rate (a listed deviation: not configurable). */
export const LLQ_BURST_MS = 200;

/** @since P3 [S20] The LLQ burst of a priority class policed at `rateBps`: 200 ms of the rate, in whole bytes (≥ 1). */
export function llqBurstBytes(rateBps: number): number {
  // rate × 0.2 s / 8 bits = rate / 40
  return Math.max(1, Math.floor((rateBps * LLQ_BURST_MS) / 8000));
}

/** @since P3 A packet in the scheduler: an opaque item, its size, its class index and (fair-queue classes) its flow. */
export interface QueueingPacket<T> {
  readonly item: T;
  readonly bytes: number;
  /** Index into `QueueingSpec.classes`. */
  readonly cls: number;
  /** Flow key (fair-queue classes); absent = one shared flow. */
  readonly flow?: string;
  /** A flow's DRR weight, read from the packet that opens the flow (default 1). */
  readonly flowWeight?: number;
}

/** @since P3 The outcome of `enqueue`. */
export type QueueingEnqueueResult =
  | { readonly ok: true; /** The class's depth after the enqueue. */ readonly depth: number }
  | { readonly ok: false; readonly reason: 'queue-full' | 'policed' };

/** @since P3 Counters of one class (display; the [S20] queue view is built from them). */
export interface QueueingClassStats {
  readonly name: string;
  readonly kind: QueueingClassSpec['kind'];
  readonly depth: number;
  /** `queueLimit` (≤ 0 = none). */
  readonly limit: number;
  /** Packets and bytes offered to the class (enqueue calls). */
  readonly matched: number;
  readonly matchedBytes: number;
  readonly sent: number;
  readonly sentBytes: number;
  readonly tailDrops: number;
  readonly policed: number;
  /** Active flows of a fair-queue class (0 otherwise). */
  readonly flows: number;
}

/** @since P3 A scheduler instance (one per egress port or sandbox run). */
export interface QueueScheduler<T> {
  /**
   * Offer a packet at `now`; `linkBusy` = the transmitter is still serialising a frame (congestion, with a waiting packet).
   * `held` (default 0): packets of the same class already taken out for service but not yet sent (a shaper's staged
   * packet, `link/qos/scheduler.ts`); they count toward the class's tail-drop limit, so its depth never exceeds it.
   */
  enqueue(p: QueueingPacket<T>, now: SimTime, linkBusy: boolean, held?: number): QueueingEnqueueResult;
  /** The next packet to transmit (priority classes first, then DRR), removed; undefined when every queue is empty. */
  dequeue(now: SimTime): QueueingPacket<T> | undefined;
  /** Packets waiting in all classes. */
  readonly depth: number;
  classStats(): QueueingClassStats[];
}

/** A FIFO of packets with O(1) push and shift. */
class Fifo<T> {
  private items: T[] = [];
  private head = 0;
  get size(): number {
    return this.items.length - this.head;
  }
  push(x: T): void {
    this.items.push(x);
  }
  peek(): T | undefined {
    return this.items[this.head];
  }
  shift(): T | undefined {
    const x = this.items[this.head];
    if (x === undefined) return undefined;
    this.head++;
    if (this.head >= 1024 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return x;
  }
}

interface DrrMember {
  deficit: number;
  inService: boolean;
  readonly quantum: number;
}

interface FlowQueue<T> extends DrrMember {
  readonly key: string;
  readonly q: Fifo<QueueingPacket<T>>;
}

/** Deficit round robin over the flows of one fair-queue class. */
class FlowDrr<T> {
  private readonly flows = new Map<string, FlowQueue<T>>();
  private readonly active: FlowQueue<T>[] = [];
  private armed: FlowQueue<T> | undefined;
  size = 0;
  constructor(private readonly quantumBytes: number) {}

  get flowCount(): number {
    return this.flows.size;
  }

  push(p: QueueingPacket<T>): void {
    const key = p.flow ?? '';
    let f = this.flows.get(key);
    if (f === undefined) {
      const w = p.flowWeight !== undefined && Number.isInteger(p.flowWeight) && p.flowWeight > 0 ? p.flowWeight : 1;
      f = { key, q: new Fifo(), deficit: 0, inService: false, quantum: this.quantumBytes * w };
      this.flows.set(key, f);
      this.active.push(f);
    }
    f.q.push(p);
    this.size++;
  }

  /** The flow DRR would serve next (its quantum already added for this visit). */
  private arm(): FlowQueue<T> | undefined {
    if (this.armed !== undefined) return this.armed;
    while (this.active.length > 0) {
      const f = this.active[0]!;
      if (!f.inService) {
        f.deficit += f.quantum;
        f.inService = true;
      }
      if (f.q.peek()!.bytes <= f.deficit) {
        this.armed = f;
        return f;
      }
      f.inService = false;
      this.active.shift();
      this.active.push(f);
    }
    return undefined;
  }

  peek(): QueueingPacket<T> | undefined {
    return this.arm()?.q.peek();
  }

  pop(): QueueingPacket<T> | undefined {
    const f = this.arm();
    if (f === undefined) return undefined;
    const p = f.q.shift()!;
    this.armed = undefined;
    this.size--;
    f.deficit -= p.bytes;
    if (f.q.size === 0) {
      f.deficit = 0;
      f.inService = false;
      this.active.shift();
      this.flows.delete(f.key);
    }
    return p;
  }
}

interface ClassState<T> extends DrrMember {
  readonly spec: QueueingClassSpec;
  readonly fifo?: Fifo<QueueingPacket<T>>;
  readonly flows?: FlowDrr<T>;
  readonly bucket?: TokenBucket;
  matched: number;
  matchedBytes: number;
  sent: number;
  sentBytes: number;
  tailDrops: number;
  policed: number;
}

function classSize<T>(c: ClassState<T>): number {
  return c.flows !== undefined ? c.flows.size : c.fifo!.size;
}
function classPeek<T>(c: ClassState<T>): QueueingPacket<T> | undefined {
  return c.flows !== undefined ? c.flows.peek() : c.fifo!.peek();
}
function classPop<T>(c: ClassState<T>): QueueingPacket<T> | undefined {
  return c.flows !== undefined ? c.flows.pop() : c.fifo!.shift();
}

/** @since P3 The index of the first `default` class (where unclassified packets go), or the last class. */
export function defaultClassIndex(spec: QueueingSpec): number {
  const i = spec.classes.findIndex((c) => c.kind === 'default');
  return i >= 0 ? i : spec.classes.length - 1;
}

/**
 * @since P3 A scheduler over `spec`'s classes, its policer buckets full at `now`. Priority classes are served first
 * (in class order, each FIFO); the other classes share the link by class DRR, a fair-queue class by flow DRR inside.
 */
export function createQueueScheduler<T>(spec: QueueingSpec, now: SimTime = 0): QueueScheduler<T> {
  if (spec.classes.length === 0) throw new RangeError('a queueing spec needs at least one class');
  const quantumBytes = spec.quantumBytes ?? QUEUEING_QUANTUM_BYTES;
  if (!Number.isInteger(quantumBytes) || quantumBytes <= 0) throw new RangeError(`quantum ${quantumBytes} must be a positive integer`);
  const weightOf = (c: QueueingClassSpec): number => (Number.isInteger(c.weightKbps) && c.weightKbps > 0 ? c.weightKbps : 1);
  let minWeight = 0;
  for (const c of spec.classes) if (c.kind !== 'priority' && (minWeight === 0 || weightOf(c) < minWeight)) minWeight = weightOf(c);
  const base = minWeight === 0 ? quantumBytes : Math.ceil(quantumBytes / minWeight);
  const classes: ClassState<T>[] = spec.classes.map((c) => {
    const policed = c.kind === 'priority' && c.rateBps !== undefined && c.rateBps > 0;
    const burstBits = (c.burstBytes !== undefined && c.burstBytes > 0 ? c.burstBytes : llqBurstBytes(c.rateBps ?? 0)) * 8;
    const fair = c.kind !== 'priority' && c.fairQueue === true;
    return {
      spec: c,
      ...(fair ? { flows: new FlowDrr<T>(quantumBytes) } : { fifo: new Fifo<QueueingPacket<T>>() }),
      ...(policed ? { bucket: createTokenBucket(c.rateBps!, burstBits, now) } : {}),
      quantum: weightOf(c) * base,
      deficit: 0,
      inService: false,
      matched: 0,
      matchedBytes: 0,
      sent: 0,
      sentBytes: 0,
      tailDrops: 0,
      policed: 0,
    };
  });
  const priority = classes.filter((c) => c.spec.kind === 'priority');
  const active: ClassState<T>[] = [];
  let depth = 0;

  const sent = (c: ClassState<T>, p: QueueingPacket<T>): QueueingPacket<T> => {
    c.sent++;
    c.sentBytes += p.bytes;
    depth--;
    return p;
  };

  return {
    get depth(): number {
      return depth;
    },
    enqueue(p: QueueingPacket<T>, at: SimTime, linkBusy: boolean, held = 0): QueueingEnqueueResult {
      const c = classes[p.cls];
      if (c === undefined) throw new RangeError(`packet class ${p.cls} is not one of the ${classes.length} classes`);
      if (!Number.isInteger(p.bytes) || p.bytes <= 0) throw new RangeError(`packet size ${p.bytes} must be a positive integer`);
      c.matched++;
      c.matchedBytes += p.bytes;
      if (c.bucket !== undefined && (linkBusy || depth > 0) && !takeTokens(c.bucket, p.bytes * 8, at)) {
        c.policed++;
        return { ok: false, reason: 'policed' };
      }
      const size = classSize(c);
      if (c.spec.queueLimit > 0 && size + held >= c.spec.queueLimit) {
        c.tailDrops++;
        return { ok: false, reason: 'queue-full' };
      }
      if (c.flows !== undefined) c.flows.push(p);
      else c.fifo!.push(p);
      depth++;
      if (size === 0 && c.spec.kind !== 'priority') {
        c.deficit = 0;
        c.inService = false;
        active.push(c);
      }
      return { ok: true, depth: size + 1 };
    },
    dequeue(): QueueingPacket<T> | undefined {
      for (const c of priority) {
        const p = c.fifo!.shift();
        if (p !== undefined) return sent(c, p);
      }
      while (active.length > 0) {
        const c = active[0]!;
        if (!c.inService) {
          c.deficit += c.quantum;
          c.inService = true;
        }
        const head = classPeek(c)!;
        if (head.bytes <= c.deficit) {
          c.deficit -= head.bytes;
          const p = classPop(c)!;
          if (classSize(c) === 0) {
            c.deficit = 0;
            c.inService = false;
            active.shift();
          }
          return sent(c, p);
        }
        c.inService = false;
        active.shift();
        active.push(c);
      }
      return undefined;
    },
    classStats(): QueueingClassStats[] {
      return classes.map((c) => ({
        name: c.spec.name,
        kind: c.spec.kind,
        depth: classSize(c),
        limit: c.spec.queueLimit,
        matched: c.matched,
        matchedBytes: c.matchedBytes,
        sent: c.sent,
        sentBytes: c.sentBytes,
        tailDrops: c.tailDrops,
        policed: c.policed,
        flows: c.flows?.flowCount ?? 0,
      }));
    },
  };
}

// ── a whole run over synthetic arrivals (the sandbox; the parity reference of concept.queueing.test.ts) ──────────

/** @since P3 One synthetic arrival. */
export interface QueueingArrival {
  readonly at: SimTime;
  readonly bytes: number;
  readonly cls: number;
  readonly flow?: string;
  readonly flowWeight?: number;
}

/** @since P3 What happened to one arrival (same index as the input). */
export interface QueueingDeparture {
  readonly index: number;
  readonly arrival: SimTime;
  readonly cls: number;
  /** Serialisation start and end (absent when dropped). */
  readonly start?: SimTime;
  readonly end?: SimTime;
  /** start − arrival. */
  readonly waitNs?: number;
  readonly dropped?: 'queue-full' | 'policed';
}

/**
 * @since P3 Run `arrivals` through a scheduler on one link of `rateBps` (serialisation `serializationNs(bytes +
 * overheadBytes, rateBps)`, the link model's rounding). At each instant every arrival due is offered first (in index
 * order among equal times, `linkBusy` = a frame still serialising), then, if the link is free, the scheduler picks
 * the next packet. Returns one departure per arrival, in input order.
 */
export function simulateQueueing(
  spec: QueueingSpec,
  arrivals: readonly QueueingArrival[],
  rateBps: number,
  opts: { readonly overheadBytes?: number } = {},
): QueueingDeparture[] {
  const overhead = opts.overheadBytes ?? 0;
  const order = arrivals.map((_, i) => i).sort((a, b) => arrivals[a]!.at - arrivals[b]!.at || a - b);
  const sched = createQueueScheduler<number>(spec, order.length > 0 ? arrivals[order[0]!]!.at : 0);
  const out: (QueueingDeparture | undefined)[] = new Array(arrivals.length);
  let i = 0;
  let busyUntil = 0;
  let now = 0;
  for (;;) {
    const nextArrival = i < order.length ? arrivals[order[i]!]!.at : Number.POSITIVE_INFINITY;
    const nextFree = sched.depth > 0 ? Math.max(busyUntil, now) : Number.POSITIVE_INFINITY;
    const t = Math.min(nextArrival, nextFree);
    if (t === Number.POSITIVE_INFINITY) break;
    now = t;
    while (i < order.length && arrivals[order[i]!]!.at === now) {
      const index = order[i]!;
      const a = arrivals[index]!;
      const r = sched.enqueue(
        { item: index, bytes: a.bytes, cls: a.cls, ...(a.flow === undefined ? {} : { flow: a.flow }), ...(a.flowWeight === undefined ? {} : { flowWeight: a.flowWeight }) },
        now,
        busyUntil > now,
      );
      if (!r.ok) out[index] = { index, arrival: a.at, cls: a.cls, dropped: r.reason };
      i++;
    }
    if (busyUntil <= now && sched.depth > 0) {
      const p = sched.dequeue(now)!;
      const a = arrivals[p.item]!;
      const end = now + serializationNs(p.bytes + overhead, rateBps);
      out[p.item] = { index: p.item, arrival: a.at, cls: a.cls, start: now, end, waitNs: now - a.at };
      busyUntil = end;
    }
  }
  return out.map((d, index) => d ?? { index, arrival: arrivals[index]!.at, cls: arrivals[index]!.cls });
}
