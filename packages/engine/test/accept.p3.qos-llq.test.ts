/**
 * accept.p3.qos-llq — [S20] LLQ protects voice on a congested serial link, wired (ARCHITECTURE-P3 §10.1
 * `accept.p3.qos-llq`, §3.11, D16, rulings R32–R35; §7 W4 qa).
 *
 * The §3.5 world (`accept.p3.qos.harness.ts`, `staged.world` at stage P3) with §3.11's output policy on R1 Se0/0/0:
 * `class-map match-all VOICE` / `match dscp ef`; `policy-map WAN-EDGE` / `class VOICE` / `priority 32` / `class
 * class-default` / `fair-queue` [S21]; `interface Se0/0/0` / `bandwidth 128` / `service-policy output WAN-EDGE`. The voice
 * flow (marked EF at R1 Gi0/0 by §3.5's MARK) and the 200 kb/s data flow are bounded, so the world converges after the
 * held queue drains (rule 19).
 *
 * Pinned (the row): no voice datagram is dropped; every voice wait at R1 Se0/0/0 (enqueue → serialisation start) is at
 * most one 1008-byte serialisation at 128 kb/s (the largest data frame on the wire: 1006 bytes of HDLC frame plus the
 * serial PHY overhead) + 1 ms; the class-default tail drop carries `class class-default is full (64 packets)`; and
 * `show policy-map interface Serial0/0/0` — per class matched packets and bytes, depth / limit, sent, tail drops and
 * policed — equals the counts derived from the trace. Also §3.11 step 1 (the typed `service-policy output` is admitted
 * at 32 ≤ 96 kb/s, installs the held queue on a port already congested by the virtual FIFO, and the frames that FIFO had
 * committed keep their times) and step 4's second half (voice above its 32 kb/s while congested drops `policed`, `priority
 * class VOICE is over its 32 kb/s`).
 */
import { describe, expect, it } from 'vitest';
import type { PduId } from '../src/contracts/ids.js';
import { MEDIA } from '../src/contracts/link.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { FlowRow } from '../src/contracts/tables.js';
import { MS, SEC, serializationNs, type SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { QOS_DEFAULT_QUEUE_LIMIT, qosPolicedDetail, qosQueueFullDetail } from '../src/link/qos/scheduler.js';
import {
  dataFlow,
  hostExec,
  MARK_LINES,
  ofKind,
  PCD_IP,
  PCS_IP,
  PCV_IP,
  qosWorld,
  routerExec,
  SE0,
  showPolicyMapInterface,
  traceFrom,
  trafficPdus,
  voiceFlow,
} from './accept.p3.qos.harness.js';

const VOICE_PPS = 50;
const DATA_PPS = 25;
const LINE_BPS = 128_000;
const SERIAL_PHY = MEDIA['serial-dce'].phyOverheadBytes!;

/** §3.11's queueing policy (VOICE priority 32 kb/s, class-default fair-queue). */
const WAN_EDGE: readonly string[] = [
  'class-map match-all VOICE',
  ' match dscp ef',
  '!',
  'policy-map WAN-EDGE',
  ' class VOICE',
  '  priority 32',
  ' class class-default',
  '  fair-queue',
  '!',
];
const ATTACH = ['bandwidth 128', 'service-policy output WAN-EDGE'];

/** The largest frame of the run on R1 Se0/0/0: a 1000-byte datagram in HDLC (1006 bytes), plus the serial PHY bytes. */
const DATA_FRAME_ON_WIRE = 1006 + SERIAL_PHY;

const flowsRow = (sim: Simulation, key: string): FlowRow | undefined => sim.device('pcs')!.tables.get<FlowRow>('flows')?.get(key);

interface PortRecord {
  /** When R1 offered the frame to Se0/0/0: its frameQueued, or (an idle port) its frameTx. */
  enqueuedAt: SimTime;
  queued: boolean;
  txStart?: SimTime;
  bytes: number;
}

/** What happened to each datagram at R1 Se0/0/0, by PDU (keepalives excluded: they never reach a class queue). */
function atSerial(evs: readonly TraceEvent[]): Map<PduId, PortRecord> {
  const out = new Map<PduId, PortRecord>();
  for (const e of evs) {
    if (e.kind === 'frameQueued' && e.device === 'r1' && e.port === SE0) {
      out.set(e.pdu.id, { enqueuedAt: e.t, queued: true, bytes: e.pdu.size });
    } else if (e.kind === 'frameTx' && e.from.device === 'r1' && e.from.port === SE0 && e.pdu.tag !== 'keepalive') {
      const r = out.get(e.pdu.id);
      if (r === undefined) out.set(e.pdu.id, { enqueuedAt: e.t, queued: false, txStart: e.txStart, bytes: e.pdu.size });
      else r.txStart = e.txStart;
    }
  }
  return out;
}

/** Drops at R1 Se0/0/0, by PDU. */
const serialDrops = (evs: readonly TraceEvent[]): Extract<TraceEvent, { kind: 'drop' }>[] =>
  ofKind(evs, 'drop').filter((d) => d.device === 'r1' && d.port === SE0);

/** The §3.11 world with WAN-EDGE attached from the startup configuration; bounded flows run to idle. */
function llqRun(seed: number, seconds: number, voice: string = voiceFlow(seconds * VOICE_PPS)): { sim: Simulation; evs: TraceEvent[] } {
  const sim = qosWorld({ seed, r1Qos: [...MARK_LINES, ...WAN_EDGE], r1Serial: ATTACH });
  const cursor = sim.trace(0).next;
  hostExec(sim, 'pcv', voice);
  hostExec(sim, 'pcd', dataFlow(seconds * DATA_PPS));
  expect(sim.runToIdle().stopped).not.toBe('maxEvents');
  return { sim, evs: traceFrom(sim, cursor) };
}

describe('§3.11: LLQ on R1 Se0/0/0 under the §3.5 congestion', () => {
  it('no voice drop; every voice wait ≤ one 1008-byte serialisation + 1 ms; the class-default drop detail; show equals the trace', () => {
    const SECONDS = 30;
    const { sim, evs } = llqRun(311, SECONDS);
    // step 1: the compiled spec the link model reads (reference rate = the bandwidth line)
    expect(sim.device('r1')!.egressPolicy(SE0)).toMatchObject({
      policy: 'WAN-EDGE',
      refBps: LINE_BPS,
      classes: [
        { name: 'VOICE', kind: 'priority', rateBps: 32_000, queueLimit: QOS_DEFAULT_QUEUE_LIMIT },
        { name: 'class-default', kind: 'default', fairQueue: true, queueLimit: QOS_DEFAULT_QUEUE_LIMIT },
      ],
    });
    const voice = trafficPdus(evs, 'pcv');
    const data = trafficPdus(evs, 'pcd');
    expect(voice).toHaveLength(SECONDS * VOICE_PPS);
    expect(data).toHaveLength(SECONDS * DATA_PPS);
    const voiceSet = new Set(voice);

    // the port was congested: frames were held (R32) and data was tail-dropped
    const records = atSerial(evs);
    expect([...records.values()].some((r) => r.queued)).toBe(true);
    const drops = serialDrops(evs);
    expect(drops.length).toBeGreaterThan(0);

    // no voice drop, anywhere; PC-S received every voice datagram, marked EF
    expect(ofKind(evs, 'drop').filter((d) => voiceSet.has(d.pdu.id))).toEqual([]);
    expect(flowsRow(sim, `${PCV_IP}|f1`)).toMatchObject({ dscp: 46, received: voice.length, lost: 0, ended: true });

    // every voice wait ≤ one data frame's serialisation (1008 bytes on the wire at 128 kb/s) + 1 ms
    const bound = serializationNs(DATA_FRAME_ON_WIRE, LINE_BPS) + MS;
    let worst = 0;
    for (const id of voice) {
      const r = records.get(id)!;
      expect(r.txStart).toBeDefined();
      const wait = r.txStart! - r.enqueuedAt;
      expect(wait, `voice ${id}`).toBeLessThanOrEqual(bound);
      worst = Math.max(worst, wait);
    }
    // the bound is met with the data frames actually on the wire (some voice did wait behind one)
    expect(worst).toBeGreaterThan(serializationNs(DATA_FRAME_ON_WIRE, LINE_BPS) / 2);

    // step 4: data waits in class-default; frame 65 drops queue-full with the class's detail
    const tail = drops.filter((d) => d.reason === 'queue-full');
    expect(tail.length).toBeGreaterThan(0);
    const detail = qosQueueFullDetail({ name: 'class-default', kind: 'default', queueLimit: QOS_DEFAULT_QUEUE_LIMIT });
    expect(detail).toBe(`class class-default is full (${QOS_DEFAULT_QUEUE_LIMIT} packets)`);
    for (const d of tail) expect([d.pdu.proto, d.detail]).toEqual(['udp', detail]);
    expect(drops.filter((d) => d.reason !== 'queue-full')).toEqual([]);
    // the queue that overflowed held exactly the limit (the depth of the frameQueued events never passes it)
    const depths = ofKind(evs, 'frameQueued').filter((q) => q.device === 'r1' && q.port === SE0 && q.queue === 'class-default').map((q) => q.depth);
    expect(Math.max(...depths)).toBe(QOS_DEFAULT_QUEUE_LIMIT);

    // step 5: show policy-map interface equals the trace (after idle: every queue empty)
    const all = traceFrom(sim, 0);
    const recAll = atSerial(all);
    const dropsAll = serialDrops(all);
    const classOf = (id: PduId): 'VOICE' | 'class-default' => (voiceSet.has(id) ? 'VOICE' : 'class-default');
    const expected = (name: 'VOICE' | 'class-default') => {
      const offered = [...recAll].filter(([id]) => classOf(id) === name);
      const dropped = dropsAll.filter((d) => classOf(d.pdu.id) === name);
      const sent = offered.filter(([, r]) => r.txStart !== undefined).length;
      const matched = offered.length + dropped.length;
      const matchedBytes = offered.reduce((n, [, r]) => n + r.bytes, 0) + dropped.reduce((n, d) => n + d.pdu.size, 0);
      return { matched, matchedBytes, sent, tailDrops: dropped.filter((d) => d.reason === 'queue-full').length, policed: dropped.filter((d) => d.reason === 'policed').length };
    };
    const v = expected('VOICE');
    const d = expected('class-default');
    expect(v).toMatchObject({ matched: voice.length, sent: voice.length, tailDrops: 0, policed: 0 });
    expect(d.sent + d.tailDrops).toBe(d.matched);
    const pmap = showPolicyMapInterface(sim, 'r1', SE0).split('\n');
    expect(pmap.slice(0, 3)).toEqual([SE0, '  Output policy WAN-EDGE', `    Queueing: class-based, policy WAN-EDGE, reference rate 128 kb/s`]);
    expect(pmap).toContain(`    Class VOICE: ${v.matched} packets (${v.matchedBytes} bytes) matched`);
    expect(pmap).toContain(`    Class class-default: ${d.matched} packets (${d.matchedBytes} bytes) matched`);
    const queueLines = pmap.filter((l) => l.startsWith('      Queue: '));
    expect(queueLines).toHaveLength(2);
    expect(queueLines[0]).toMatch(new RegExp(`^      Queue: 0/${QOS_DEFAULT_QUEUE_LIMIT} packets waiting, ${v.sent} sent, ${v.tailDrops} dropped \\(queue full\\), ${v.policed} policed; offered `));
    expect(queueLines[1]).toMatch(new RegExp(`^      Queue: 0/${QOS_DEFAULT_QUEUE_LIMIT} packets waiting, ${d.sent} sent, ${d.tailDrops} dropped \\(queue full\\), ${d.policed} policed, \\d+ flows?; offered `));
    // the same numbers in the snapshot's queue view (PortSnapshot.qos.queue, R32)
    const port = sim.snapshot().devices.find((x) => x.id === 'r1')!.ports.find((p) => p.id === SE0)!;
    expect(port.qos?.queue?.classes.map((c) => [c.name, c.depth, c.matched, c.matchedBytes, c.sent, c.tailDrops, c.policed])).toEqual([
      ['VOICE', 0, v.matched, v.matchedBytes, v.sent, v.tailDrops, v.policed],
      ['class-default', 0, d.matched, d.matchedBytes, d.sent, d.tailDrops, d.policed],
    ]);
    // every datagram R1 offered the port is in the trace once: sent or dropped
    expect(v.matched + d.matched).toBe([...recAll.keys()].length + dropsAll.length);
    // PC-S lost exactly the data datagrams the class-default queue dropped
    const dataSet = new Set(data);
    expect(flowsRow(sim, `${PCD_IP}|f1`)!.lost).toBe(dropsAll.filter((x) => dataSet.has(x.pdu.id)).length);
  }, 180_000);

  it('voice above its 32 kb/s while the port is congested drops policed with the priority detail', () => {
    // g711-sized voice: 50 pps of 200-byte datagrams (≈ 83 kb/s on the wire), marked EF at R1 Gi0/0
    const SECONDS = 10;
    const { evs } = llqRun(312, SECONDS, `flow start ${PCS_IP} pps 50 size 200 port 16384 count ${SECONDS * VOICE_PPS}`);
    const voice = new Set(trafficPdus(evs, 'pcv'));
    const policed = serialDrops(evs).filter((d) => d.reason === 'policed');
    expect(policed.length).toBeGreaterThan(0);
    for (const p of policed) {
      expect(voice.has(p.pdu.id)).toBe(true);
      expect(p.detail).toBe(qosPolicedDetail('VOICE', 'priority', 32_000));
    }
    expect(qosPolicedDetail('VOICE', 'priority', 32_000)).toBe('priority class VOICE is over its 32 kb/s');
    // what the policer let through still left first: no voice was tail-dropped
    expect(serialDrops(evs).filter((d) => d.reason === 'queue-full' && voice.has(d.pdu.id))).toEqual([]);
  }, 180_000);
});

describe('§3.11 step 1: service-policy output typed on a port the virtual FIFO already congests', () => {
  it('admitted (32 ≤ 96 kb/s), the held queue engages, and the frames the FIFO committed keep their times', () => {
    const sim = qosWorld({ seed: 313, r1Qos: [...MARK_LINES, ...WAN_EDGE] });
    const cursor = sim.trace(0).next;
    hostExec(sim, 'pcv', voiceFlow(20 * VOICE_PPS));
    hostExec(sim, 'pcd', dataFlow(20 * DATA_PPS));
    sim.runFor(5 * SEC);
    expect(sim.device('r1')!.egressPolicy(SE0)).toBeUndefined();
    // the FIFO's committed frames on R1 Se0/0/0 (frameTx with a future txStart)
    const committed = ofKind(traceFrom(sim, cursor), 'frameTx').filter((e) => e.from.device === 'r1' && e.from.port === SE0 && e.txStart > sim.now);
    expect(committed.length).toBeGreaterThan(8);
    const busyUntil = Math.max(...committed.map((e) => e.txEnd));
    const typedAt = sim.now;
    const typed = routerExec(sim, 'r1', ['enable', 'configure terminal', `interface ${SE0}`, 'bandwidth 128', 'service-policy output WAN-EDGE', 'end']);
    expect(typed.map((r) => r.error)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(sim.device('r1')!.egressPolicy(SE0)).toMatchObject({ policy: 'WAN-EDGE', refBps: LINE_BPS });
    expect(sim.runToIdle().stopped).not.toBe('maxEvents');
    const evs = traceFrom(sim, cursor);
    // the committed frames were not re-timed: one frameTx each, and they arrived at R2 at their committed times
    for (const c of committed) {
      expect(ofKind(evs, 'frameTx').filter((e) => e.pdu.id === c.pdu.id && e.from.device === 'r1')).toHaveLength(1);
      expect(ofKind(evs, 'frameRx').find((e) => e.device === 'r2' && e.pdu.id === c.pdu.id)?.t).toBe(c.arrive);
    }
    // the held queue engaged after the typing, and nothing it held started before the FIFO's busyUntil
    const queued = ofKind(evs, 'frameQueued').filter((q) => q.device === 'r1' && q.port === SE0);
    expect(queued.length).toBeGreaterThan(0);
    expect(queued.every((q) => q.t >= typedAt)).toBe(true);
    const heldIds = new Set(queued.map((q) => q.pdu.id));
    const heldTx = ofKind(evs, 'frameTx').filter((e) => e.from.device === 'r1' && e.from.port === SE0 && heldIds.has(e.pdu.id));
    expect(heldTx.length).toBe(heldIds.size - serialDrops(evs).filter((d) => heldIds.has(d.pdu.id)).length);
    expect(heldTx.every((e) => e.txStart >= busyUntil)).toBe(true);
    // a dequeued frame starts at once (txStart = the dispatch time of its frameTx)
    for (const e of heldTx) expect(e.txStart).toBe(e.t);
  }, 180_000);
});
