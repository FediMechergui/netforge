/**
 * app.traffic — the traffic generator and its receiver (ARCHITECTURE-P3 D16 M13, §2.4 TrafficFlowSpec, §2.5 the
 * discard rule, §2.6 `flows`, §3.5, §4.2; §7 W2 svc) on `staged.world` at stage P3 with the traffic factory:
 * PC1 192.168.1.10 — R1 (Gi0/0 192.168.1.1, Gi0/1 192.168.2.1) — PC2 192.168.2.10. Flows start with the
 * `traffic.start` request (the host shell's `flow` job and the app's `hostRequest` both end there).
 *
 *  • pacing: `floor(size · 8 · 10⁹ / bps)` / `floor(10⁹ / pps)` ns exactly, from datagram 0 at the start;
 *  • the receiver's delay and RFC 3550 jitter equal a recomputation from the trace, under link jitter;
 *  • loss: `lost` = (highest + 1) − received, also under random loss;
 *  • caps: 8 flows, 2 Mb/s, 1000 pps, and the 5-minute cap (`trafficFlowCap`), and a continuous flow stops at it;
 *  • the flows row: once per received second plus the final write 1 s after the last datagram;
 *  • tail losses with and without the final datagram;
 *  • the discard rule: consumed in silence only where `traffic` runs; elsewhere P1's port unreachable.
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES } from '../src/contracts/cli.js';
import type { DeviceId, LinkId } from '../src/contracts/ids.js';
import type { PduView } from '../src/contracts/pdu.js';
import type { TrafficFlowSpec } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { FlowRow } from '../src/contracts/tables.js';
import { MS, SEC, type SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import {
  createTraffic,
  decodeTrafficHeader,
  encodeTrafficPayload,
  planTrafficFlow,
  TRAFFIC_MAX_DURATION_NS,
  trafficHeaderLength,
  type TrafficHeader,
} from '../src/protocols/traffic.js';
import { createStagedSimulation } from './staged.world.js';

const PC2 = '192.168.2.10';

function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

interface Lab {
  sim: Simulation;
  /** R1 Gi0/1 — PC2. */
  last: LinkId;
}

function lab(seed: number): Lab {
  const sim = createStagedSimulation({ seed, stage: 'P3', factories: { traffic: createTraffic } });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: startup([['hostname PC1'], ['interface GigabitEthernet0', ' ip address 192.168.1.10 255.255.255.0'], ['ip default-gateway 192.168.1.1']]) });
  sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: startup([['hostname PC2'], ['interface GigabitEthernet0', ` ip address ${PC2} 255.255.255.0`], ['ip default-gateway 192.168.2.1']]) });
  sim.addDevice({
    id: 'r1', type: 'router.nf2911', name: 'R1',
    startupConfig: startup([
      ['hostname R1'],
      ['interface GigabitEthernet0/0', ' ip address 192.168.1.1 255.255.255.0', ' no shutdown'],
      ['interface GigabitEthernet0/1', ' ip address 192.168.2.1 255.255.255.0', ' no shutdown'],
    ]),
  });
  sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'r1', port: 'GigabitEthernet0/0' } });
  const last = sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/1' }, b: { device: 'pc2', port: 'GigabitEthernet0' } });
  sim.runFor(60 * SEC);
  return { sim, last };
}

function start(sim: Simulation, flow: TrafficFlowSpec, dev: DeviceId = 'pc1', session?: string): void {
  sim.device(dev)!.applyActions('sim', [{ type: 'request', to: 'traffic', req: { kind: 'traffic.start', flow, ...(session !== undefined ? { session } : {}) } }], sim.now);
}

function stop(sim: Simulation, id: string, dev: DeviceId = 'pc1'): void {
  sim.device(dev)!.applyActions('sim', [{ type: 'request', to: 'traffic', req: { kind: 'traffic.stop', id } }], sim.now);
}

/** The traffic header of a generated datagram. */
function headerOf(p: PduView): TrafficHeader | undefined {
  const udp = p.layer('udp');
  return udp === undefined ? undefined : decodeTrafficHeader(p.bytes, udp.offset + 8, udp.offset + udp.length);
}

interface Sent {
  id: number;
  t: SimTime;
  h: TrafficHeader;
  pdu: PduView;
}

/** The datagrams `dev`'s traffic daemon built, in order. */
function sentBy(sim: Simulation, dev: DeviceId, evs: readonly TraceEvent[] = sim.trace(0).events): Sent[] {
  const out: Sent[] = [];
  for (const e of evs) {
    if (e.kind !== 'pduCreated' || e.device !== dev || e.process !== 'traffic') continue;
    const pdu = sim.pdu(e.pdu.id)!;
    out.push({ id: e.pdu.id, t: e.t, h: headerOf(pdu)!, pdu });
  }
  return out;
}

/** When each PDU was consumed at `dev`, by id. */
function consumedAt(sim: Simulation, dev: DeviceId, evs: readonly TraceEvent[] = sim.trace(0).events): Map<number, SimTime> {
  const out = new Map<number, SimTime>();
  for (const e of evs) if (e.kind === 'pduConsumed' && e.device === dev) out.set(e.pdu.id, e.t);
  return out;
}

const flowRow = (sim: Simulation, key: string, dev: DeviceId = 'pc2'): FlowRow | undefined => sim.device(dev)!.tables.get<FlowRow>('flows')?.get(key);
const flowWrites = (sim: Simulation, key: string): Extract<TraceEvent, { kind: 'tableWrite' }>[] =>
  sim.trace(0).events.filter((e): e is Extract<TraceEvent, { kind: 'tableWrite' }> => e.kind === 'tableWrite' && e.device === 'pc2' && e.table === 'flows' && e.key === key);
const trafficState = (sim: Simulation, dev: DeviceId = 'pc1'): Record<string, unknown> => sim.device(dev)!.processes.get('traffic')!.stateSnapshot().state;

/** RFC 3550 appendix A.8 jitter over transit times in arrival order, as the receiver keeps it (×16, integer). */
function rfcJitter(transits: readonly number[]): number {
  let j16 = 0;
  for (let i = 1; i < transits.length; i++) j16 += Math.abs(transits[i]! - transits[i - 1]!) - Math.floor((j16 + 8) / 16);
  return Math.floor(j16 / 16);
}

describe('app.traffic: the traffic header', () => {
  it('round-trips, carries a 53-bit send time, and refuses anything else', () => {
    const h: TrafficHeader = { flow: 'voice-1', seq: 0xfffffffe, sentAt: 9_007_199_254_740_991, final: true };
    const bytes = encodeTrafficPayload(h, 40);
    expect(bytes.length).toBe(40);
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x4e, 0x46, 0x54, 0x47]);
    expect(decodeTrafficHeader(bytes)).toEqual(h);
    expect(trafficHeaderLength(7)).toBe(25);
    expect(decodeTrafficHeader(new TextEncoder().encode('NFPRsession'))).toBeUndefined();
    expect(decodeTrafficHeader(bytes, 0, 10)).toBeUndefined();
  });
});

describe('app.traffic: planning and caps (§2.4)', () => {
  const none = new Set<string>();
  it('pacing is floor(size · 8 · 10⁹ / bps) or floor(10⁹ / pps); a continuous flow is capped at 5 minutes', () => {
    expect(planTrafficFlow({ dst: PC2, sizeBytes: 1000, rateKbps: 200 }, none)).toMatchObject({ ok: true, plan: { id: 'f1', paceNs: 40_000_000, dstPort: 9, dscp: 0, mode: 'continuous', limit: 7500 } });
    expect(planTrafficFlow({ dst: PC2, sizeBytes: 60, pps: 3 }, none)).toMatchObject({ ok: true, plan: { paceNs: 333_333_333, limit: 901 } });
    expect(planTrafficFlow({ dst: PC2, sizeBytes: 77, rateKbps: 7, count: 4 }, none)).toMatchObject({ ok: true, plan: { paceNs: Math.floor((77 * 8 * 1e9) / 7000), limit: 4, mode: 'count' } });
    expect(planTrafficFlow({ dst: PC2, sizeBytes: 60, pps: 50, durationMs: 1010 }, none)).toMatchObject({ ok: true, plan: { paceNs: 20_000_000, limit: 51, mode: 'duration' } });
    expect(planTrafficFlow({ dst: PC2, sizeBytes: 1500, preset: 'voice-g711' }, none)).toMatchObject({ ok: true, plan: { sizeBytes: 200, pps: 50, dscp: 46 } });
    expect(planTrafficFlow({ dst: PC2, sizeBytes: 1500, preset: 'voice-g729', dscp: 34 }, none)).toMatchObject({ ok: true, plan: { sizeBytes: 60, pps: 50, dscp: 34 } });
    expect(planTrafficFlow({ dst: PC2, sizeBytes: 60, pps: 50 }, new Set(['f1', 'f2', 'f4']))).toMatchObject({ ok: true, plan: { id: 'f3' } });
  });

  it('refuses beyond the caps with the CLI messages', () => {
    const cap = CLI_MESSAGES.trafficFlowCap.replace('{minutes}', '5');
    const fast = '% A flow sends at most 2000 kb/s and 1000 packets per second.';
    const no = (spec: TrafficFlowSpec, busy: ReadonlySet<string> = none): string => {
      const r = planTrafficFlow(spec, busy);
      return r.ok ? 'ok' : r.error;
    };
    expect(no({ dst: PC2, sizeBytes: 60, pps: 1 }, new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']))).toBe(CLI_MESSAGES.trafficTooManyFlows.replace('{max}', '8'));
    expect(no({ dst: PC2, sizeBytes: 1000, rateKbps: 2001 })).toBe(fast);
    expect(no({ dst: PC2, sizeBytes: 60, pps: 1001 })).toBe(fast);
    expect(no({ dst: PC2, sizeBytes: 300, pps: 834 })).toBe(fast); // 834 × 300 × 8 > 2 Mb/s
    expect(no({ dst: PC2, sizeBytes: 60, rateKbps: 2000 })).toBe(fast); // 4166 packets per second
    expect(no({ dst: PC2, sizeBytes: 60, pps: 50, count: 15_000 })).toBe('ok'); // exactly 5 minutes
    expect(no({ dst: PC2, sizeBytes: 60, pps: 50, count: 15_001 })).toBe(cap);
    expect(no({ dst: PC2, sizeBytes: 60, pps: 50, durationMs: 300_000 })).toBe('ok');
    expect(no({ dst: PC2, sizeBytes: 60, pps: 50, durationMs: 300_001 })).toBe(cap);
    expect(no({ dst: PC2, sizeBytes: 59, pps: 1 })).toBe("% A flow's packets are 60 to 1500 bytes long.");
    expect(no({ dst: PC2, sizeBytes: 1501, pps: 1 })).toBe("% A flow's packets are 60 to 1500 bytes long.");
    expect(no({ dst: PC2, sizeBytes: 60 })).toBe('% Give exactly one of a rate (kb/s) or a packet rate (packets per second).');
    expect(no({ dst: PC2, sizeBytes: 60, pps: 1, rateKbps: 1 })).toBe('% Give exactly one of a rate (kb/s) or a packet rate (packets per second).');
    expect(no({ dst: PC2, sizeBytes: 60, pps: 1, dscp: 64 })).toBe('% DSCP values run from 0 to 63.');
    expect(no({ dst: PC2, sizeBytes: 60, pps: 1, count: 2, durationMs: 2 })).toBe('% Give a packet count or a duration, not both.');
    expect(no({ dst: '255.255.255.255', sizeBytes: 60, pps: 1 })).toMatch(/unicast IPv4 destination/);
    expect(no({ dst: PC2, sizeBytes: 60, pps: 1, id: 'f1' }, new Set(['f1']))).toMatch(/already running/);
  });
});

describe('app.traffic: a flow end to end (staged.world)', () => {
  it('paces exactly from datagram 0, marks only the last one final, and the receiver counts all of them', () => {
    const { sim } = lab(71);
    const t0 = sim.now;
    start(sim, { dst: PC2, pps: 50, sizeBytes: 60, count: 10, dscp: 46 });
    expect(sim.device('pc1')!.tables.get('sockets')!.rows().map((r) => (r as { id?: string }).id)).toEqual(['traffic#f1']);
    sim.runToIdle(500_000);
    const sent = sentBy(sim, 'pc1');
    expect(sent.map((s) => s.t)).toEqual(Array.from({ length: 10 }, (_, k) => t0 + k * 20 * MS));
    expect(sent.map((s) => s.h.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(sent.map((s) => s.h.final)).toEqual([false, false, false, false, false, false, false, false, false, true]);
    expect(sent.map((s) => s.h.sentAt)).toEqual(sent.map((s) => s.t));
    const p = sent[0]!.pdu;
    expect([p.get('ipv4.totalLength'), p.get('ipv4.dscp'), p.get('udp.dstPort')]).toEqual([60, 46, 9]);
    expect(Number(p.get('udp.srcPort'))).toBeGreaterThanOrEqual(49152);
    // the flow is over: its socket closed
    expect(sim.device('pc1')!.tables.get('sockets')!.rows()).toEqual([]);
    expect((trafficState(sim).flows as { state: string; sent: number }[])[0]).toMatchObject({ id: 'f1', state: 'ended', sent: 10 });
    const row = flowRow(sim, '192.168.1.10|f1')!;
    const arrive = consumedAt(sim, 'pc2');
    const transits = sent.map((s) => arrive.get(s.id)! - s.t);
    expect(row).toMatchObject({
      flow: 'f1', src: '192.168.1.10', dst: PC2, dstPort: 9, dscp: 46, received: 10, lost: 0, ended: true,
      delayMinNs: Math.min(...transits), delayMaxNs: Math.max(...transits), delayAvgNs: Math.floor(transits.reduce((a, b) => a + b, 0) / 10),
      jitterNs: rfcJitter(transits), firstAt: arrive.get(sent[0]!.id), lastAt: arrive.get(sent[9]!.id),
    });
    // consumed silently: no drop, no ICMP at PC2
    expect(sim.trace(0).events.filter((e) => e.kind === 'drop' && e.device === 'pc2' && sent.some((s) => s.id === e.pdu.id))).toEqual([]);
    expect(sim.trace(0).events.filter((e) => e.kind === 'pduCreated' && e.device === 'pc2' && e.process === 'icmpv4')).toEqual([]);
  });

  it('a rate in kb/s paces floor(size · 8 · 10⁹ / bps)', () => {
    const { sim } = lab(72);
    const t0 = sim.now;
    start(sim, { dst: PC2, rateKbps: 200, sizeBytes: 1000, count: 3 });
    sim.runToIdle(500_000);
    expect(sentBy(sim, 'pc1').map((s) => s.t)).toEqual([t0, t0 + 40_000_000, t0 + 80_000_000]);
  });

  it('delay and RFC 3550 jitter under link jitter equal a recomputation from the trace', () => {
    const { sim, last } = lab(73);
    sim.setImpairments(last, { jitterNs: 3 * MS, latencyNs: 1 * MS });
    start(sim, { dst: PC2, pps: 100, sizeBytes: 200, count: 50 });
    sim.runToIdle(500_000);
    const sent = sentBy(sim, 'pc1');
    const arrive = consumedAt(sim, 'pc2');
    const order = sent.filter((s) => arrive.has(s.id)).sort((a, b) => arrive.get(a.id)! - arrive.get(b.id)! || a.id - b.id);
    const transits = order.map((s) => arrive.get(s.id)! - s.t);
    const row = flowRow(sim, '192.168.1.10|f1')!;
    expect(row.received).toBe(50);
    expect(row.jitterNs).toBe(rfcJitter(transits));
    expect(row.jitterNs).toBeGreaterThan(0);
    expect(row.delayMaxNs).toBe(Math.max(...transits));
    expect(row.delayMinNs).toBe(Math.min(...transits));
  });

  it('random loss: lost = (highest + 1) − received, as the trace shows', () => {
    const { sim, last } = lab(74);
    // warm the ARP caches first, so every loss below is a link loss
    start(sim, { dst: PC2, pps: 100, sizeBytes: 100, count: 1, id: 'warm' });
    sim.runFor(1 * SEC);
    sim.setImpairments(last, { lossPct: 30 });
    start(sim, { dst: PC2, pps: 100, sizeBytes: 100, count: 60 });
    sim.runToIdle(500_000);
    const sent = sentBy(sim, 'pc1').filter((s) => s.h.flow === 'f1');
    const arrive = consumedAt(sim, 'pc2');
    const got = sent.filter((s) => arrive.has(s.id));
    const lostOnLink = sim.trace(0).events.filter((e) => e.kind === 'drop' && e.reason === 'link-loss' && sent.some((s) => s.id === e.pdu.id)).length;
    expect(lostOnLink).toBeGreaterThan(0);
    expect(got.length + lostOnLink).toBe(60);
    const highest = Math.max(...got.map((s) => s.h.seq));
    const row = flowRow(sim, '192.168.1.10|f1')!;
    expect(row.received).toBe(got.length);
    expect(row.lost).toBe(highest + 1 - got.length);
    expect(row.ended).toBe(arrive.has(sent[59]!.id));
  });
});

describe('app.traffic: the flows row (§2.6)', () => {
  it('is written at the first datagram of each received second, plus the final write 1 s after the last datagram', () => {
    const { sim } = lab(81);
    // start 100 ms after a whole second, so the three datagrams arrive within one sim-time second
    sim.runUntil(Math.ceil(sim.now / SEC) * SEC + 100 * MS);
    start(sim, { dst: PC2, pps: 10, sizeBytes: 60, count: 3 });
    sim.runToIdle(500_000);
    const sent = sentBy(sim, 'pc1');
    const arrive = consumedAt(sim, 'pc2');
    const writes = flowWrites(sim, '192.168.1.10|f1');
    expect(writes.map((w) => w.t)).toEqual([arrive.get(sent[0]!.id)!, arrive.get(sent[2]!.id)! + SEC]);
    expect(writes.map((w) => w.row.received)).toEqual([1, 3]);
    expect(writes[1]!.row.ended).toBe(true);
    // a longer flow: at most one write per received second, and the flush
    start(sim, { dst: PC2, pps: 50, sizeBytes: 60, count: 150, id: 'f9' });
    sim.runToIdle(500_000);
    const w9 = flowWrites(sim, '192.168.1.10|f9');
    const seconds = w9.slice(0, -1).map((w) => Math.floor(w.t / SEC));
    expect(new Set(seconds).size).toBe(seconds.length);
    expect(w9.length).toBeLessThanOrEqual(5);
    expect(w9.at(-1)!.row).toMatchObject({ received: 150, lost: 0, ended: true });
  });

  it('tail losses: counted when the final datagram arrives, not counted when it is lost too', () => {
    for (const lostFinal of [false, true]) {
      const { sim, last } = lab(82);
      const t0 = sim.now;
      start(sim, { dst: PC2, pps: 10, sizeBytes: 60, count: 10 });
      sim.runUntil(t0 + 650 * MS);
      sim.setImpairments(last, { lossPct: 100 });
      sim.runUntil(t0 + 850 * MS);
      if (!lostFinal) sim.setImpairments(last, { lossPct: 0 });
      sim.runFor(3 * SEC);
      const row = flowRow(sim, '192.168.1.10|f1')!;
      if (lostFinal) expect(row).toMatchObject({ received: 7, lost: 0, ended: false });
      else expect(row).toMatchObject({ received: 8, lost: 2, ended: true });
    }
  });
});

describe('app.traffic: caps and control in a world', () => {
  it('a continuous flow stops at the 5-minute cap: its last datagram is final and leaves before the cap', () => {
    const { sim } = lab(91);
    const t0 = sim.now;
    start(sim, { dst: PC2, pps: 1, sizeBytes: 60 });
    sim.runFor(TRAFFIC_MAX_DURATION_NS + 10 * SEC);
    const sent = sentBy(sim, 'pc1');
    expect(sent).toHaveLength(300);
    expect(sent.at(-1)!.t).toBe(t0 + 299 * SEC);
    expect(sent.at(-1)!.h.final).toBe(true);
    expect(sent.slice(0, -1).every((s) => !s.h.final)).toBe(true);
    expect(flowRow(sim, '192.168.1.10|f1')).toMatchObject({ received: 300, lost: 0, ended: true });
    expect((trafficState(sim).flows as { state: string }[])[0]!.state).toBe('ended');
  });

  it('eight flows at most: the ninth is refused on the session; stop ends a flow without a final datagram', () => {
    const { sim } = lab(92);
    // warm the ARP caches: eight datagrams 0 queued behind one ARP resolution would overflow its queue
    start(sim, { dst: PC2, pps: 1, sizeBytes: 60, count: 1, id: 'warm' });
    sim.runFor(2 * SEC);
    const session = sim.cli.open('pc1', 'console');
    for (let i = 0; i < 8; i++) start(sim, { dst: PC2, pps: 1, sizeBytes: 60 });
    const cursor = sim.trace(0).next;
    start(sim, { dst: PC2, pps: 1, sizeBytes: 60 }, 'pc1', session);
    const out = sim.trace(cursor).events.filter((e) => e.kind === 'cliOutput').map((e) => (e as { text: string }).text);
    expect(out).toEqual([`${CLI_MESSAGES.trafficTooManyFlows.replace('{max}', '8')}\n`]);
    expect((trafficState(sim).flows as { state: string }[]).filter((f) => f.state === 'running').length).toBe(8);
    sim.runFor(5 * SEC);
    stop(sim, 'f3');
    sim.runFor(5 * SEC);
    const f3 = sentBy(sim, 'pc1').filter((s) => s.h.flow === 'f3');
    expect(f3.every((s) => !s.h.final)).toBe(true);
    expect(flowRow(sim, '192.168.1.10|f3')).toMatchObject({ ended: false, lost: 0 });
    expect((trafficState(sim).flows as { id: string; state: string }[]).find((f) => f.id === 'f3')!.state).toBe('stopped');
    // a free id is reused by the next flow
    start(sim, { dst: PC2, pps: 1, sizeBytes: 60 }, 'pc1', session);
    expect(sim.trace(0).events.filter((e) => e.kind === 'cliOutput').map((e) => (e as { text: string }).text).at(-1)).toMatch(/^Flow f3 started: /);
  });

  it('the discard rule needs the traffic daemon: R1 answers a generated datagram with P1 port unreachable', () => {
    const { sim } = lab(93);
    start(sim, { dst: '192.168.1.1', pps: 10, sizeBytes: 60, count: 2 });
    sim.runToIdle(500_000);
    const sent = sentBy(sim, 'pc1');
    const drops = sim.trace(0).events.filter((e) => e.kind === 'drop' && e.device === 'r1' && sent.some((s) => s.id === e.pdu.id));
    expect(drops.map((d) => `${(d as { reason: string }).reason}|${(d as { detail?: string }).detail ?? ''}`)).toEqual(['unsupported-protocol|udp port 9 closed', 'unsupported-protocol|udp port 9 closed']);
    // the first error reaches the flow; the final datagram's arrives after the flow closed its socket
    expect((trafficState(sim).flows as { errors: number }[])[0]!.errors).toBe(1);
    // and an ordinary datagram to PC2's closed port keeps the P1 path there
    const cursor = sim.trace(0).next;
    sim.device('pc1')!.applyActions('sim', [{ type: 'request', to: 'udp', req: { kind: 'udp.probe', session: 'x', dst: PC2, port: 9, timeoutNs: 3 * SEC } }], sim.now);
    sim.runFor(1 * SEC);
    const evs = sim.trace(cursor).events;
    expect(evs.filter((e) => e.kind === 'drop' && e.device === 'pc2').map((e) => (e as { detail?: string }).detail)).toEqual(['udp port 9 closed']);
    expect(evs.filter((e) => e.kind === 'pduCreated' && e.device === 'pc2' && e.process === 'icmpv4')).toHaveLength(1);
    expect(sim.device('pc2')!.tables.get('flows')!.rows()).toEqual([]);
  });

  it('silence: a device that never starts a flow sends nothing and writes nothing', () => {
    const { sim } = lab(94);
    sim.runFor(120 * SEC);
    const evs = sim.trace(0).events;
    expect(evs.filter((e) => (e.kind === 'pduCreated' && e.process === 'traffic') || (e.kind === 'debug' && e.event.process === 'traffic'))).toEqual([]);
    expect(evs.filter((e) => e.kind === 'tableWrite' && e.table === 'flows')).toEqual([]);
    expect(trafficState(sim)).toEqual({ flows: [], receiving: 0, received: 0 });
  });
});

