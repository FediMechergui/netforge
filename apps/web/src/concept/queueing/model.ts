/**
 * Queueing sandbox model (ARCHITECTURE-P3 D16, §3.5 step 7, §6; W2 web-concept): pure, DOM-free functions behind the
 * queueing concept tool (the tool itself is W3).
 *
 * The sandbox runs the two arrival patterns of the QoS walk-through — a voice flow of small packets and a data flow
 * of large ones, together more than the link can carry — through FIFO, WFQ, CBWFQ and LLQ side by side. Every run is
 * driven by the engine's pure scheduler (`core/queueing.ts` through `@netforge/engine/pure`), the same one the [S20]
 * held queue of a real port uses, so the sandbox can never disagree with the link (D10). WFQ is scheduled as deficit
 * round robin over flows, a listed deviation (R2 (21)).
 *
 * `runQueueing` replays one discipline instant by instant exactly as the engine's `simulateQueueing` does (every
 * arrival due is offered first, in arrival order, then the free link takes the scheduler's next packet), recording a
 * step for each arrival, drop and transmission with the queues as they stand after it, so the tool can step and play;
 * its departures equal `simulateQueueing`'s (the parity case of `concept.queueing.test.ts`). Every step and every
 * packet's fate is also a sentence of text (no colour-only meaning). Times are integer nanoseconds; the text shows
 * milliseconds with one decimal. All wording is original.
 */
import {
  SEC,
  createQueueScheduler,
  type QueueingArrival,
  type QueueingClassSpec,
  type QueueingClassStats,
  type QueueingDeparture,
  type QueueingSpec,
  type SimTime,
} from '@netforge/engine/pure';

// ── disciplines and traffic ─────────────────────────────────────────────────

/** The four queueing disciplines the sandbox compares. */
export type QueueingDiscipline = 'fifo' | 'wfq' | 'cbwfq' | 'llq';

/** The disciplines in display order, with what each one does. */
export const QUEUEING_DISCIPLINES: readonly { readonly id: QueueingDiscipline; readonly label: string; readonly hint: string }[] = Object.freeze([
  { id: 'fifo', label: 'FIFO', hint: 'One queue: packets leave in the order they arrived.' },
  { id: 'wfq', label: 'WFQ', hint: 'One queue per conversation, served in turn, so a few large packets cannot starve the small ones.' },
  { id: 'cbwfq', label: 'CBWFQ', hint: 'One queue per class, each served in turn in proportion to the bandwidth it was given.' },
  { id: 'llq', label: 'LLQ', hint: 'CBWFQ plus a priority queue that is always served first, up to its policed rate.' },
]);

/** The two kinds of traffic of the sandbox (the walk-through's voice and data flows). */
export type QueueingTrafficKind = 'voice' | 'data';

/** One synthetic flow: `count` packets of `bytes`, the first at `startNs`, then one every `intervalNs`. */
export interface QueueingFlow {
  readonly name: string;
  readonly kind: QueueingTrafficKind;
  readonly bytes: number;
  readonly intervalNs: number;
  readonly count: number;
  readonly startNs: number;
}

/** A sandbox setup: the link, the flows and the classes' shares. */
export interface QueueingScenario {
  /** Link rate in bits per second. */
  readonly rateBps: number;
  readonly flows: readonly QueueingFlow[];
  /** Each queue's tail-drop limit, in packets. */
  readonly queueLimit: number;
  /** CBWFQ and LLQ: the VOICE class's bandwidth (kb/s); in LLQ also the priority class's policed rate. */
  readonly voiceKbps: number;
  /** CBWFQ and LLQ: the DATA class's bandwidth (kb/s). */
  readonly dataKbps: number;
  /** CBWFQ and LLQ: class-default's share (kb/s). */
  readonly defaultKbps: number;
}

const MS = 1_000_000;

/**
 * Serialisation time of `bytes` at `bps`, rounded up to whole ns: the link model's rounding (`serializationNs` of
 * the engine's `contracts/time.ts`, which `simulateQueueing` uses). Written here so the concept chunk needs only the
 * pure entry; the parity case of `concept.queueing.test.ts` pins every departure against the engine's.
 */
function txNs(bytes: number, bps: number): number {
  return Math.ceil((bytes * 8 * SEC) / bps);
}

/**
 * The walk-through's pair on a 128 kb/s serial line (§3.5): voice, 80-byte packets every 20 ms (32 kb/s), and data,
 * 1000-byte packets every 40 ms (200 kb/s), for half a second. Together they ask for 232 kb/s, so a queue builds.
 */
export const QUEUEING_DEFAULT_SCENARIO: QueueingScenario = Object.freeze({
  rateBps: 128_000,
  flows: Object.freeze([
    Object.freeze({ name: 'voice', kind: 'voice', bytes: 80, intervalNs: 20 * MS, count: 25, startNs: 0 }),
    Object.freeze({ name: 'data', kind: 'data', bytes: 1000, intervalNs: 40 * MS, count: 13, startNs: 0 }),
  ] as QueueingFlow[]),
  queueLimit: 64,
  voiceKbps: 40,
  dataKbps: 56,
  defaultKbps: 32,
});

/** The class names the sandbox's policies use (`class-default` as on a device). */
export const QUEUEING_CLASS_NAMES = Object.freeze({ voice: 'VOICE', data: 'DATA', default: 'class-default' });

/** The scheduler classes of one discipline, in policy order. */
export function queueingSpecFor(discipline: QueueingDiscipline, scenario: QueueingScenario): QueueingSpec {
  const limit = scenario.queueLimit;
  const def = (weightKbps: number, fairQueue?: boolean): QueueingClassSpec => ({
    name: QUEUEING_CLASS_NAMES.default,
    kind: 'default',
    weightKbps,
    queueLimit: limit,
    ...(fairQueue === true ? { fairQueue } : {}),
  });
  const data: QueueingClassSpec = { name: QUEUEING_CLASS_NAMES.data, kind: 'bandwidth', weightKbps: scenario.dataKbps, queueLimit: limit };
  switch (discipline) {
    case 'fifo':
      return { classes: [def(0)] };
    case 'wfq':
      return { classes: [def(0, true)] };
    case 'cbwfq':
      return {
        classes: [{ name: QUEUEING_CLASS_NAMES.voice, kind: 'bandwidth', weightKbps: scenario.voiceKbps, queueLimit: limit }, data, def(scenario.defaultKbps)],
      };
    case 'llq':
      return {
        classes: [
          { name: QUEUEING_CLASS_NAMES.voice, kind: 'priority', weightKbps: 0, queueLimit: limit, rateBps: scenario.voiceKbps * 1000 },
          data,
          def(scenario.defaultKbps),
        ],
      };
  }
}

/** The class a kind of traffic falls in under a discipline (an index into `queueingSpecFor(…).classes`). */
export function queueingClassOf(discipline: QueueingDiscipline, kind: QueueingTrafficKind): number {
  if (discipline === 'fifo' || discipline === 'wfq') return 0;
  return kind === 'voice' ? 0 : 1;
}

/** One packet of a scenario: which flow sent it and when. `index` is its arrival number (0-based). */
export interface QueueingPacketInfo {
  readonly index: number;
  readonly flow: string;
  readonly kind: QueueingTrafficKind;
  /** 1-based number of the packet within its flow. */
  readonly seq: number;
  readonly bytes: number;
  readonly at: SimTime;
}

/** Every packet of a scenario, in arrival order (equal times: flow order). */
export function queueingPackets(scenario: QueueingScenario): QueueingPacketInfo[] {
  const raw: { flowIndex: number; f: QueueingFlow; seq: number; at: SimTime }[] = [];
  scenario.flows.forEach((f, flowIndex) => {
    for (let i = 0; i < f.count; i++) raw.push({ flowIndex, f, seq: i + 1, at: f.startNs + i * f.intervalNs });
  });
  raw.sort((a, b) => a.at - b.at || a.flowIndex - b.flowIndex || a.seq - b.seq);
  return raw.map((r, index) => ({ index, flow: r.f.name, kind: r.f.kind, seq: r.seq, bytes: r.f.bytes, at: r.at }));
}

/** The scheduler arrivals of a scenario under a discipline (same order as `queueingPackets`). */
export function queueingArrivals(scenario: QueueingScenario, discipline: QueueingDiscipline): QueueingArrival[] {
  return queueingPackets(scenario).map((p) => ({
    at: p.at,
    bytes: p.bytes,
    cls: queueingClassOf(discipline, p.kind),
    ...(discipline === 'wfq' ? { flow: p.flow } : {}),
  }));
}

// ── a run ────────────────────────────────────────────────────────────────────

/** One step of a run: an arrival joins a queue, an arrival is dropped, or the link starts sending a packet. */
export interface QueueingStep {
  readonly at: SimTime;
  readonly kind: 'arrive' | 'drop' | 'send';
  readonly packet: number;
  /** What happened, as a sentence. */
  readonly text: string;
  /** The packets waiting in each class after the step (indices, in arrival order), one list per class. */
  readonly queues: readonly (readonly number[])[];
  /** The packet on the wire after the step, or null when the link is idle. */
  readonly onWire: { readonly packet: number; readonly start: SimTime; readonly end: SimTime } | null;
}

/** How one kind of traffic fared in a run. */
export interface QueueingKindSummary {
  readonly kind: QueueingTrafficKind;
  readonly packets: number;
  readonly sent: number;
  readonly dropped: number;
  /** Average and longest wait of the packets sent (whole ns; 0 when none was sent). */
  readonly averageWaitNs: number;
  readonly maxWaitNs: number;
  readonly text: string;
}

/** A whole run of one discipline. */
export interface QueueingRun {
  readonly discipline: QueueingDiscipline;
  readonly scenario: QueueingScenario;
  readonly spec: QueueingSpec;
  readonly packets: readonly QueueingPacketInfo[];
  readonly arrivals: readonly QueueingArrival[];
  /** One per packet, in packet order: the same values the engine's `simulateQueueing` returns. */
  readonly departures: readonly QueueingDeparture[];
  readonly steps: readonly QueueingStep[];
  /** The scheduler's per-class counters at the end. */
  readonly classStats: readonly QueueingClassStats[];
  readonly summary: readonly QueueingKindSummary[];
}

/** `ns` as milliseconds with one decimal ("62.5 ms"). */
export function msText(ns: number): string {
  const tenths = Math.round(ns / 100_000);
  return `${Math.floor(tenths / 10)}.${tenths % 10} ms`;
}

function packetName(p: QueueingPacketInfo): string {
  return `${p.kind} packet ${p.seq} (${p.bytes} B)`;
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Why the scheduler picked this packet, by discipline and class kind. */
function sendReason(discipline: QueueingDiscipline, cls: QueueingClassSpec): string {
  if (discipline === 'fifo') return 'it was first in the queue';
  if (cls.kind === 'priority') return 'the priority queue is always served first';
  if (discipline === 'wfq') return 'it is its conversation’s turn';
  return `it is the ${cls.name} queue’s turn`;
}

function queueName(discipline: QueueingDiscipline, cls: QueueingClassSpec): string {
  return discipline === 'fifo' || discipline === 'wfq' ? 'the queue' : `the ${cls.name} queue`;
}

/** Run one discipline over a scenario (file header). Pure: the same input always gives the same run. */
export function runQueueing(scenario: QueueingScenario, discipline: QueueingDiscipline): QueueingRun {
  const spec = queueingSpecFor(discipline, scenario);
  const packets = queueingPackets(scenario);
  const arrivals = queueingArrivals(scenario, discipline);
  const rateBps = scenario.rateBps;

  // The loop of the engine's simulateQueueing, step for step (the parity case pins it).
  const order = arrivals.map((_, i) => i).sort((a, b) => arrivals[a]!.at - arrivals[b]!.at || a - b);
  const sched = createQueueScheduler<number>(spec, order.length > 0 ? arrivals[order[0]!]!.at : 0);
  const out: (QueueingDeparture | undefined)[] = new Array(arrivals.length);
  const waiting: number[][] = spec.classes.map(() => []);
  const steps: QueueingStep[] = [];
  let wire: QueueingStep['onWire'] = null;
  const record = (at: SimTime, kind: QueueingStep['kind'], packet: number, text: string): void => {
    steps.push({
      at,
      kind,
      packet,
      text,
      queues: waiting.map((q) => [...q]),
      onWire: wire !== null && wire.end > at ? wire : null,
    });
  };

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
      const p = packets[index]!;
      const cls = spec.classes[a.cls]!;
      const r = sched.enqueue(
        { item: index, bytes: a.bytes, cls: a.cls, ...(a.flow === undefined ? {} : { flow: a.flow }), ...(a.flowWeight === undefined ? {} : { flowWeight: a.flowWeight }) },
        now,
        busyUntil > now,
      );
      if (r.ok) {
        waiting[a.cls]!.push(index);
        const n = waiting[a.cls]!.length;
        record(now, 'arrive', index, `${msText(now)}: ${capital(packetName(p))} joins ${queueName(discipline, cls)} (${n} waiting there).`);
      } else {
        out[index] = { index, arrival: a.at, cls: a.cls, dropped: r.reason };
        const why =
          r.reason === 'policed'
            ? `goes over the ${cls.name} class’s policed rate while the link is congested, so the policer drops it`
            : `finds ${queueName(discipline, cls)} full (${cls.queueLimit} packets), so it is dropped at the tail`;
        record(now, 'drop', index, `${msText(now)}: ${capital(packetName(p))} ${why}.`);
      }
      i++;
    }
    if (busyUntil <= now && sched.depth > 0) {
      const sent = sched.dequeue(now)!;
      const a = arrivals[sent.item]!;
      const p = packets[sent.item]!;
      const end = now + txNs(sent.bytes, rateBps);
      out[sent.item] = { index: sent.item, arrival: a.at, cls: a.cls, start: now, end, waitNs: now - a.at };
      busyUntil = end;
      const q = waiting[a.cls]!;
      q.splice(q.indexOf(sent.item), 1);
      wire = { packet: sent.item, start: now, end };
      const waited = now === a.at ? 'without waiting' : `after waiting ${msText(now - a.at)}`;
      record(
        now,
        'send',
        sent.item,
        `${msText(now)}: ${capital(packetName(p))} starts on the wire ${waited}, because ${sendReason(discipline, spec.classes[a.cls]!)}; sending it takes ${msText(end - now)}.`,
      );
    }
  }
  const departures = out.map((d, index) => d ?? { index, arrival: arrivals[index]!.at, cls: arrivals[index]!.cls });
  return {
    discipline,
    scenario,
    spec,
    packets,
    arrivals,
    departures,
    steps,
    classStats: sched.classStats(),
    summary: (['voice', 'data'] as const).map((kind) => summarise(kind, packets, departures)),
  };
}

function summarise(kind: QueueingTrafficKind, packets: readonly QueueingPacketInfo[], departures: readonly QueueingDeparture[]): QueueingKindSummary {
  let count = 0;
  let sent = 0;
  let dropped = 0;
  let total = 0;
  let max = 0;
  for (const p of packets) {
    if (p.kind !== kind) continue;
    count++;
    const d = departures[p.index]!;
    if (d.dropped !== undefined) dropped++;
    else if (d.waitNs !== undefined) {
      sent++;
      total += d.waitNs;
      if (d.waitNs > max) max = d.waitNs;
    }
  }
  const averageWaitNs = sent === 0 ? 0 : Math.floor(total / sent);
  const lost = dropped === 0 ? 'none dropped' : `${dropped} dropped`;
  const text =
    count === 0
      ? `${capital(kind)}: no packets.`
      : sent === 0
        ? `${capital(kind)}: ${count} packets, every one dropped.`
        : `${capital(kind)}: average wait ${msText(averageWaitNs)}, longest ${msText(max)}, ${lost} (${count} packets).`;
  return { kind, packets: count, sent, dropped, averageWaitNs, maxWaitNs: max, text };
}

/** Every discipline over the same scenario, side by side, in `QUEUEING_DISCIPLINES` order. */
export function compareQueueing(scenario: QueueingScenario = QUEUEING_DEFAULT_SCENARIO): QueueingRun[] {
  return QUEUEING_DISCIPLINES.map((d) => runQueueing(scenario, d.id));
}

/** What happened to one packet of a run, as a sentence ("every packet's wait as text"). */
export function packetFateText(run: QueueingRun, index: number): string {
  const p = run.packets[index];
  const d = run.departures[index];
  if (p === undefined || d === undefined) throw new RangeError(`packet ${index} is not one of the run's ${run.packets.length}`);
  const head = `${capital(packetName(p))} arrived at ${msText(p.at)}`;
  if (d.dropped === 'policed') return `${head} and was dropped by the priority class’s policer.`;
  if (d.dropped === 'queue-full') return `${head} and was dropped: its queue was full.`;
  if (d.start === undefined || d.end === undefined || d.waitNs === undefined) return `${head} and was still waiting when the run ended.`;
  return `${head}, waited ${msText(d.waitNs)} and was sent from ${msText(d.start)} to ${msText(d.end)}.`;
}
