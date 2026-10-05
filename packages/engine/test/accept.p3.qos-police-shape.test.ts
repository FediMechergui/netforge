/**
 * accept.p3.qos-police-shape — [S21] policing at the LAN edge and shaping on the serial port, wired (ARCHITECTURE-P3
 * §10.1 `accept.p3.qos-police-shape`, §3.11 step 6, D16 [S21], rulings R26, R35; §7 W4 qa).
 *
 * The §3.5 world (`accept.p3.qos.harness.ts`, `staged.world` at stage P3).
 *
 *   • Policing (§3.11 step 6, lab 27's last task): R1's input policy MARK gains `class class-default` / `police 64000
 *     conform-action transmit exceed-action drop`. PC-D's 200 kb/s data flow is policed at step 10c, after marking and
 *     before the serial queue: every exceeding datagram drops `policed` at R1 Gi0/0 with `class class-default is over
 *     its police rate of 64 kb/s`, never reaches Se0/0/0, and the line is no longer congested (no queue-full drop).
 *     The conform and exceed counts of `show policy-map interface GigabitEthernet0/0` equal the trace, and each
 *     verdict equals the pure policer (`link/qos/scheduler.ts`) replayed over the class's arrivals (engine/pure
 *     parity); the voice class is marked and never policed.
 *   • Shaping: R1 Se0/0/0 gets `policy-map SHAPE` / `class class-default` / `shape average 64000` (128 kb/s line). A
 *     bounded burst whose backlog stays below the class queue limit is delayed, not dropped: every datagram arrives,
 *     the serial port sends them no faster than the shaped rate (each gap at least one frame's bits at 64 kb/s), so the
 *     burst takes about twice as long as on the unshaped line.
 */
import { describe, expect, it } from 'vitest';
import type { PduId } from '../src/contracts/ids.js';
import { MEDIA } from '../src/contracts/link.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { FlowRow } from '../src/contracts/tables.js';
import { SEC, serializationNs } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createQosPolicer, policeQosPacket, qosPoliceBurstBytes, qosPolicedDetail, QOS_DEFAULT_QUEUE_LIMIT } from '../src/link/qos/scheduler.js';
import {
  dataFlow,
  hostExec,
  MARK_CAUSE,
  MARK_LINES,
  mutationsByPdu,
  ofKind,
  PCD_IP,
  PCV_IP,
  qosWorld,
  R_LAN,
  SE0,
  showPolicyMapInterface,
  traceFrom,
  trafficPdus,
  voiceFlow,
} from './accept.p3.qos.harness.js';

const POLICE_BPS = 64_000;
const SHAPE_BPS = 64_000;
const LINE_BPS = 128_000;

/** §3.5's MARK with lab 27's policer on class-default (§3.11 step 6). */
const MARK_POLICED: readonly string[] = [
  ...MARK_LINES.slice(0, -1),
  ' class class-default',
  `  police ${POLICE_BPS} conform-action transmit exceed-action drop`,
  '!',
];

const flowsRow = (sim: Simulation, key: string): FlowRow | undefined => sim.device('pcs')!.tables.get<FlowRow>('flows')?.get(key);

/** The frames R1 classified at Gi0/0 (step 10c: delivered, not control), in arrival order. */
function classifiedAtR1(evs: readonly TraceEvent[]): { id: PduId; t: number; size: number }[] {
  const pipelineDrops = new Set(ofKind(evs, 'drop').filter((d) => d.device === 'r1' && d.port === R_LAN && d.reason === 'not-for-me').map((d) => d.pdu.id));
  return ofKind(evs, 'frameRx')
    .filter((e) => e.device === 'r1' && e.port === R_LAN && !pipelineDrops.has(e.pdu.id) && e.pdu.proto !== 'cdp' && e.pdu.proto !== 'lldp')
    .map((e) => ({ id: e.pdu.id, t: e.t, size: e.pdu.size }));
}

describe('[S21] policing at R1 Gi0/0 (§3.11 step 6)', () => {
  it('exceeding data drops policed before the serial queue; conform/exceed counts equal the trace and the pure policer', () => {
    const sim = qosWorld({ seed: 331, r1Qos: MARK_POLICED });
    const SECONDS = 20;
    const cursor = sim.trace(0).next;
    hostExec(sim, 'pcv', voiceFlow(SECONDS * 50));
    hostExec(sim, 'pcd', dataFlow(SECONDS * 25));
    expect(sim.runToIdle().stopped).not.toBe('maxEvents');
    const evs = traceFrom(sim, cursor);
    const voice = new Set(trafficPdus(evs, 'pcv'));
    const data = trafficPdus(evs, 'pcd');

    // the exceeding datagrams: dropped policed at R1 Gi0/0 with the police detail, only data, never on the serial port
    const detail = qosPolicedDetail('class-default', 'police', POLICE_BPS);
    expect(detail).toBe('class class-default is over its police rate of 64 kb/s');
    const policed = ofKind(evs, 'drop').filter((d) => d.reason === 'policed');
    expect(policed.length).toBeGreaterThan(0);
    for (const d of policed) expect([d.device, d.port, d.detail]).toEqual(['r1', R_LAN, detail]);
    const policedIds = new Set(policed.map((d) => d.pdu.id));
    const dataSet = new Set(data);
    expect([...policedIds].every((id) => dataSet.has(id))).toBe(true);
    expect(ofKind(evs, 'frameTx').filter((e) => policedIds.has(e.pdu.id) && e.from.device === 'r1')).toEqual([]);
    // dropped at step 10c: class-default sets nothing, so R1 recorded no mutation at all (no TTL decrement, no rewrite)
    const atR1 = mutationsByPdu(evs, 'r1');
    for (const id of policedIds) expect(atR1(id)).toEqual([]);
    // the policed line is no longer congested: no tail drop on R1 Se0/0/0
    expect(ofKind(evs, 'drop').filter((d) => d.device === 'r1' && d.port === SE0)).toEqual([]);
    // voice is marked and never policed; PC-S lost exactly the policed data
    for (const id of voice) expect(atR1(id)[0]).toMatchObject({ reason: 'QosMark', cause: MARK_CAUSE });
    expect(flowsRow(sim, `${PCV_IP}|f1`)).toMatchObject({ dscp: 46, received: voice.size, lost: 0 });
    // (§2.6 `flows`: losses after the highest sequence received count only when the final datagram arrives)
    const delivered = data.map((id, seq) => [id, seq] as const).filter(([id]) => !policedIds.has(id));
    const highest = delivered.at(-1)![1];
    expect(flowsRow(sim, `${PCD_IP}|f1`)).toMatchObject({
      received: data.length - policedIds.size,
      lost: highest + 1 - delivered.length,
      ended: highest === data.length - 1,
    });

    // conform / exceed over the whole run: class-default's frames in arrival order, through the pure policer
    const all = traceFrom(sim, 0);
    const marked = new Set(ofKind(all, 'mutation').filter((e) => e.mutation.device === 'r1' && e.mutation.reason === 'QosMark').map((e) => e.pdu));
    const policedAll = new Set(ofKind(all, 'drop').filter((d) => d.device === 'r1' && d.reason === 'policed').map((d) => d.pdu.id));
    const classDefault = classifiedAtR1(all).filter((c) => !marked.has(c.id));
    const spec = { rateBps: POLICE_BPS, burstBytes: qosPoliceBurstBytes(POLICE_BPS) };
    const pure = createQosPolicer(spec, classDefault[0]!.t);
    for (const c of classDefault) {
      const verdict = policeQosPacket(pure, c.size, c.t);
      expect([c.id, verdict]).toEqual([c.id, policedAll.has(c.id) ? 'exceed' : 'conform']);
    }
    const conformed = classDefault.length - policedAll.size;
    expect([pure.conform, pure.exceed]).toEqual([conformed, policedAll.size]);
    const lines = showPolicyMapInterface(sim, 'r1', R_LAN).split('\n');
    expect(lines).toContain(
      `      Police: ${POLICE_BPS} b/s, burst ${spec.burstBytes} bytes, conform transmit, exceed drop; ${conformed} conformed, ${policedAll.size} exceeded`,
    );
    expect(lines).toContain(`    Class class-default: ${classDefault.length} packets (${classDefault.reduce((n, c) => n + c.size, 0)} bytes) matched`);
    // the runtime's view carries the same counts (R26, R35)
    const view = sim.device('r1')!.qosCounters(R_LAN)!;
    expect(view.classes.at(-1)).toMatchObject({ name: 'class-default', matched: classDefault.length, police: { conform: conformed, exceed: policedAll.size } });
  }, 180_000);
});

describe('[S21] shaping on R1 Se0/0/0', () => {
  /** A bounded burst of `count` 1000-byte datagrams at 200 kb/s from PC-D, with or without the shaper. */
  function burst(seed: number, shaped: boolean, count: number): { sim: Simulation; evs: TraceEvent[]; data: PduId[] } {
    const shape = ['policy-map SHAPE', ' class class-default', `  shape average ${SHAPE_BPS}`, '!'];
    const sim = qosWorld({ seed, r1Qos: [...MARK_LINES, ...shape], r1Serial: shaped ? ['bandwidth 128', 'service-policy output SHAPE'] : [] });
    const cursor = sim.trace(0).next;
    hostExec(sim, 'pcd', dataFlow(count));
    expect(sim.runToIdle().stopped).not.toBe('maxEvents');
    const evs = traceFrom(sim, cursor);
    return { sim, evs, data: trafficPdus(evs, 'pcd') };
  }

  it('delays a burst below the queue limit to the shaped rate, without a drop', () => {
    const COUNT = 40;
    const shaped = burst(332, true, COUNT);
    expect(shaped.sim.device('r1')!.egressPolicy(SE0)).toMatchObject({ policy: 'SHAPE', shapeBps: SHAPE_BPS });
    const { evs, data } = shaped;
    expect(data).toHaveLength(COUNT);
    // no drop anywhere on the path; PC-S received every datagram
    expect(ofKind(evs, 'drop').filter((d) => data.includes(d.pdu.id))).toEqual([]);
    expect(flowsRow(shaped.sim, `${PCD_IP}|f1`)).toMatchObject({ received: COUNT, lost: 0, ended: true });
    // the burst waited in class-default (held, below its limit)
    const depths = ofKind(evs, 'frameQueued').filter((q) => q.device === 'r1' && q.port === SE0).map((q) => q.depth);
    expect(depths.length).toBeGreaterThan(0);
    expect(Math.max(...depths)).toBeLessThan(QOS_DEFAULT_QUEUE_LIMIT);
    // the port sends them no faster than the shaper allows: each gap ≥ one frame's bits at 64 kb/s
    const tx = ofKind(evs, 'frameTx').filter((e) => e.from.device === 'r1' && e.from.port === SE0 && data.includes(e.pdu.id));
    expect(tx).toHaveLength(COUNT);
    const gaps = tx.slice(1).map((e, i) => e.txStart - tx[i]!.txStart);
    const shapedGap = serializationNs(tx[0]!.pdu.size, SHAPE_BPS);
    expect(shapedGap).toBeGreaterThan(serializationNs(tx[0]!.pdu.size + MEDIA['serial-dce'].phyOverheadBytes!, LINE_BPS));
    expect(Math.min(...gaps.slice(1))).toBeGreaterThanOrEqual(shapedGap);
    // in the long run exactly the shaped rate (within one keepalive serialisation of slack per gap)
    expect(tx.at(-1)!.txStart - tx[1]!.txStart).toBeLessThanOrEqual((COUNT - 2) * shapedGap + 10 * serializationNs(20, LINE_BPS));

    // the same burst on the unshaped line leaves at line rate: the shaped burst ends later by about the rate ratio
    const plain = burst(332, false, COUNT);
    const plainTx = ofKind(plain.evs, 'frameTx').filter((e) => e.from.device === 'r1' && e.from.port === SE0 && plain.data.includes(e.pdu.id));
    expect(ofKind(plain.evs, 'drop').filter((d) => plain.data.includes(d.pdu.id))).toEqual([]);
    const span = (xs: readonly { txStart: number }[]): number => xs.at(-1)!.txStart - xs[0]!.txStart;
    expect(span(tx)).toBeGreaterThan(span(plainTx));
    // PC-S's delay grows with the shaper (display numbers in the receiver's row)
    expect(flowsRow(shaped.sim, `${PCD_IP}|f1`)!.delayMaxNs).toBeGreaterThan(flowsRow(plain.sim, `${PCD_IP}|f1`)!.delayMaxNs + SEC);
    // the burst's datagrams were never policed or marked: the shaper only delays
    expect(ofKind(evs, 'drop').some((d) => d.reason === 'policed')).toBe(false);
  }, 180_000);
});
