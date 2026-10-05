/**
 * P3 acceptance — the traffic generator is bounded (ARCHITECTURE-P3 D16, §2.4, §2.5, §2.6, §4.2, rule 19; §10.1 row
 * `accept.p3.traffic-bounded`), on `staged.world` at stage P3 (the catalog flip is a later step; the traffic daemon is
 * passed as a factory until then). Owner: W4 qa-media.
 *
 * The row, clause by clause (every count that follows from a constant is computed from it, §10):
 *  • caps enforced, refused with the exact messages: `TRAFFIC_MAX_FLOWS` flows per device (`trafficTooManyFlows`),
 *    `TRAFFIC_MAX_BPS` and `TRAFFIC_MAX_PPS` per flow (the daemon's rate line), `TRAFFIC_MAX_DURATION_MS` per flow
 *    (`trafficFlowCap`) — on the host shell's session (the `flow` job) and on the Traffic app's path (`hostRequest`,
 *    whose refusal is the daemon's `traffic` debug line);
 *  • a bounded flow holds `runToIdle` until its last datagram and no longer — over an uncongested path and over a
 *    congested 64 kb/s serial FIFO: the run ends exactly at the receiver's final write, `TRAFFIC_FLUSH_NS` after the
 *    final datagram arrived;
 *  • an uncongested or finished flow does not hold it: a running continuous flow over an uncongested path, a finished
 *    bounded flow, a stopped continuous flow (and, for contrast, rule 19's case: a continuous flow over a congested
 *    link does hold it);
 *  • a continuous flow stops at `TRAFFIC_MAX_DURATION_MS` (`runFor`): ceil(cap / pace) datagrams, the last one final
 *    and sent before the cap;
 *  • the receiver's final `flows` write comes `TRAFFIC_FLUSH_NS` after its last datagram; tail losses are counted when
 *    the final datagram arrives (not before, and not at all when it is lost too);
 *  • a datagram without the traffic header to a closed port still draws port unreachable, on any host: every model of
 *    the stage-P3 catalog that runs the traffic daemon, wired and wireless, answers a plain UDP datagram to its closed
 *    port 9 with ICMP 3/3, and consumes a generated datagram to the same port in silence.
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES } from '../src/contracts/cli.js';
import type { DeviceId, PduId } from '../src/contracts/ids.js';
import { TRAFFIC_MAX_DURATION_MS, type TrafficFlowSpec } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { FlowRow } from '../src/contracts/tables.js';
import { MS, SEC, type SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import {
  createTraffic,
  decodeTrafficHeader,
  TRAFFIC_FLUSH_NS,
  TRAFFIC_MAX_BPS,
  TRAFFIC_MAX_DURATION_NS,
  TRAFFIC_MAX_FLOWS,
  TRAFFIC_MAX_PPS,
  type TrafficHeader,
} from '../src/protocols/traffic.js';
import { createStagedCatalog, createStagedSimulation } from './staged.world.js';

const FACTORIES = { traffic: createTraffic };
const PC2 = '192.168.2.10';
const PC3 = '192.168.3.10';
const SE0 = 'Serial0/0/0';

/** The exact refusal texts, from the constants. */
const TOO_MANY = CLI_MESSAGES.trafficTooManyFlows.replace('{max}', String(TRAFFIC_MAX_FLOWS));
const TOO_FAST = `% A flow sends at most ${TRAFFIC_MAX_BPS / 1000} kb/s and ${TRAFFIC_MAX_PPS} packets per second.`;
const TOO_LONG = CLI_MESSAGES.trafficFlowCap.replace('{minutes}', String(TRAFFIC_MAX_DURATION_MS / 60_000));

function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

const pc = (name: string, ip: string, gw: string): string =>
  startup([[`hostname ${name}`], ['interface GigabitEthernet0', ` ip address ${ip} 255.255.255.0`], [`ip default-gateway ${gw}`]]);

/**
 * PC1 192.168.1.10 — R1 Gi0/0; R1 Gi0/1 — PC2 192.168.2.10 (the uncongested path); R1 Se0/0/0 (DCE, 64 kb/s) ⇄ R2
 * Se0/0/0; R2 Gi0/0 — PC3 192.168.3.10 (the congested path). Booted, every ARP cache warm.
 */
function lab(seed: number): Simulation {
  const sim = createStagedSimulation({ seed, stage: 'P3', factories: FACTORIES });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: pc('PC1', '192.168.1.10', '192.168.1.1') });
  sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: pc('PC2', PC2, '192.168.2.1') });
  sim.addDevice({ id: 'pc3', type: 'pc.nfpc', name: 'PC3', startupConfig: pc('PC3', PC3, '192.168.3.1') });
  sim.addDevice({
    id: 'r1', type: 'router.nf2911', name: 'R1',
    startupConfig: startup([
      ['hostname R1'],
      ['interface GigabitEthernet0/0', ' ip address 192.168.1.1 255.255.255.0', ' no shutdown'],
      ['interface GigabitEthernet0/1', ' ip address 192.168.2.1 255.255.255.0', ' no shutdown'],
      [`interface ${SE0}`, ' ip address 10.1.1.1 255.255.255.252', ' clock rate 64000', ' no shutdown'],
      ['ip route 192.168.3.0 255.255.255.0 10.1.1.2'],
    ]),
  });
  sim.addDevice({
    id: 'r2', type: 'router.nf2911', name: 'R2',
    startupConfig: startup([
      ['hostname R2'],
      ['interface GigabitEthernet0/0', ' ip address 192.168.3.1 255.255.255.0', ' no shutdown'],
      [`interface ${SE0}`, ' ip address 10.1.1.2 255.255.255.252', ' no shutdown'],
      ['ip route 0.0.0.0 0.0.0.0 10.1.1.1'],
    ]),
  });
  sim.addLink({ id: 'l_pc1', a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'r1', port: 'GigabitEthernet0/0' } });
  sim.addLink({ id: 'l_pc2', a: { device: 'r1', port: 'GigabitEthernet0/1' }, b: { device: 'pc2', port: 'GigabitEthernet0' } });
  sim.addLink({ id: 'l_se', a: { device: 'r1', port: SE0 }, b: { device: 'r2', port: SE0 }, media: 'serial-dce' });
  sim.addLink({ id: 'l_pc3', a: { device: 'r2', port: 'GigabitEthernet0/0' }, b: { device: 'pc3', port: 'GigabitEthernet0' } });
  sim.runFor(60 * SEC);
  // warm every ARP cache with one bounded datagram per path
  expect(shell(sim, 'pc1', `flow start ${PC2} pps 10 size 60 count 1`).text).toMatch(/^Flow f1 started: /);
  expect(shell(sim, 'pc1', `flow start ${PC3} pps 10 size 60 count 1`).text).toMatch(/^Flow f\d started: /);
  sim.runFor(5 * SEC);
  expect(sim.runToIdle().stopped).toBeUndefined();
  return sim;
}

/** One line in a fresh console session: the command's output and its job's (one line), or the command's refusal. */
function shell(sim: Simulation, device: DeviceId, line: string): { text: string; error?: string } {
  const s = sim.cli.open(device, 'console');
  const cursor = sim.trace(0).next;
  const r = sim.cli.exec(s, line);
  sim.runFor(0);
  const job = sim.trace(cursor).events.filter((e): e is Extract<TraceEvent, { kind: 'cliOutput' }> => e.kind === 'cliOutput' && e.session === s);
  const text = (r.output + job.map((e) => e.text).join('')).trim();
  return r.error === undefined ? { text } : { text, error: r.error.message };
}

/** The Traffic app's path (`hostRequest traffic.start`), which has no session: a refusal is the daemon's debug line. */
function appStart(sim: Simulation, device: DeviceId, flow: TrafficFlowSpec): string[] {
  const cursor = sim.trace(0).next;
  sim.hostRequest(device, { app: 'traffic.start', flow });
  return sim
    .trace(cursor)
    .events.filter((e): e is Extract<TraceEvent, { kind: 'debug' }> => e.kind === 'debug' && e.event.process === 'traffic' && e.event.message.startsWith('flow refused: '))
    .map((e) => e.event.message);
}

/** The refusal line the daemon logs for `text` (its `% ` prefix dropped). */
const refusedLine = (text: string): string => `flow refused: ${text.replace(/^% /, '')}`;

interface Sent {
  readonly id: PduId;
  readonly t: SimTime;
  readonly h: TrafficHeader;
}

/** The datagrams `dev`'s traffic daemon built, in order. */
function sentBy(sim: Simulation, evs: readonly TraceEvent[], dev: DeviceId = 'pc1'): Sent[] {
  const out: Sent[] = [];
  for (const e of evs) {
    if (e.kind !== 'pduCreated' || e.device !== dev || e.process !== 'traffic') continue;
    const p = sim.pdu(e.pdu.id)!;
    const udp = p.layer('udp')!;
    out.push({ id: e.pdu.id, t: e.t, h: decodeTrafficHeader(p.bytes, udp.offset + 8, udp.offset + udp.length)! });
  }
  return out;
}

/** When each PDU was consumed at `dev`, by id. */
function consumedAt(evs: readonly TraceEvent[], dev: DeviceId): Map<PduId, SimTime> {
  const out = new Map<PduId, SimTime>();
  for (const e of evs) if (e.kind === 'pduConsumed' && e.device === dev) out.set(e.pdu.id, e.t);
  return out;
}

/** Every trace event from now on, through `onTrace` (the ring's capacity plays no part). */
function record(sim: Simulation): TraceEvent[] {
  const out: TraceEvent[] = [];
  sim.onTrace((e) => out.push(e));
  return out;
}

const flowWrites = (evs: readonly TraceEvent[], dev: DeviceId, key: string): Extract<TraceEvent, { kind: 'tableWrite' }>[] =>
  evs.filter((e): e is Extract<TraceEvent, { kind: 'tableWrite' }> => e.kind === 'tableWrite' && e.device === dev && e.table === 'flows' && e.key === key);
const flowState = (sim: Simulation, dev: DeviceId = 'pc1'): { id: string; state: string; sent: number }[] =>
  (sim.device(dev)!.processes.get('traffic')!.stateSnapshot().state as { flows: { id: string; state: string; sent: number }[] }).flows;

describe('caps, refused with the exact messages', () => {
  it(`${TRAFFIC_MAX_FLOWS} flows per device: the next one is refused on the session and on the app path`, () => {
    const sim = lab(301);
    for (let i = 0; i < TRAFFIC_MAX_FLOWS; i++) expect(shell(sim, 'pc1', `flow start ${PC2} pps 1 size 60`).text).toMatch(/^Flow f\d+ started: /);
    expect(flowState(sim).filter((f) => f.state === 'running')).toHaveLength(TRAFFIC_MAX_FLOWS);
    expect(shell(sim, 'pc1', `flow start ${PC2} pps 1 size 60`)).toEqual({ text: TOO_MANY });
    expect(appStart(sim, 'pc1', { dst: PC2, pps: 1, sizeBytes: 60 })).toEqual([refusedLine(TOO_MANY)]);
    expect(flowState(sim).filter((f) => f.state === 'running')).toHaveLength(TRAFFIC_MAX_FLOWS);
    // another device has its own allowance
    expect(shell(sim, 'pc2', 'flow start 192.168.1.10 pps 1 size 60').text).toMatch(/^Flow f1 started: /);
  });

  it(`${TRAFFIC_MAX_BPS / 1000} kb/s and ${TRAFFIC_MAX_PPS} packets per second per flow`, () => {
    const sim = lab(302);
    // the largest legal flows start: the packet-rate cap at the size that exactly fills the bit-rate cap, and the
    // bit-rate cap at the size that exactly fills the packet-rate cap
    const fullSize = TRAFFIC_MAX_BPS / (8 * TRAFFIC_MAX_PPS);
    expect(shell(sim, 'pc1', `flow start ${PC2} pps ${TRAFFIC_MAX_PPS} size ${fullSize} count 1`).text).toMatch(/^Flow f\d+ started: /);
    expect(shell(sim, 'pc1', `flow start ${PC2} rate ${TRAFFIC_MAX_BPS / 1000} size ${fullSize} count 1`).text).toMatch(/^Flow f\d+ started: /);
    sim.runToIdle();
    // one more byte per packet, or a smaller packet at the full bit rate, is over a cap: the daemon refuses
    expect(shell(sim, 'pc1', `flow start ${PC2} pps ${TRAFFIC_MAX_PPS} size ${fullSize + 1}`)).toEqual({ text: TOO_FAST });
    expect(shell(sim, 'pc1', `flow start ${PC2} rate ${TRAFFIC_MAX_BPS / 1000} size ${fullSize - 1}`)).toEqual({ text: TOO_FAST });
    // beyond the shell grammar's bounds, the app path reaches the daemon, which refuses with the same line
    expect(appStart(sim, 'pc1', { dst: PC2, pps: TRAFFIC_MAX_PPS + 1, sizeBytes: 60 })).toEqual([refusedLine(TOO_FAST)]);
    expect(appStart(sim, 'pc1', { dst: PC2, rateKbps: TRAFFIC_MAX_BPS / 1000 + 1, sizeBytes: 1500 })).toEqual([refusedLine(TOO_FAST)]);
    expect(flowState(sim).filter((f) => f.state === 'running')).toEqual([]);
  });

  it(`${TRAFFIC_MAX_DURATION_MS / 1000} s per flow: a count or a duration beyond it is refused, the exact cap is not`, () => {
    const sim = lab(303);
    const pps = 50;
    const fits = Math.floor(TRAFFIC_MAX_DURATION_NS / Math.floor(SEC / pps));
    const secs = TRAFFIC_MAX_DURATION_MS / 1000;
    // the shell refuses before any job starts
    expect(shell(sim, 'pc1', `flow start ${PC2} pps ${pps} size 60 count ${fits + 1}`)).toEqual({ text: TOO_LONG, error: TOO_LONG });
    expect(shell(sim, 'pc1', `flow start ${PC2} pps ${pps} size 60 for ${secs + 1}`)).toEqual({ text: TOO_LONG, error: TOO_LONG });
    // the daemon refuses the same on the app path
    expect(appStart(sim, 'pc1', { dst: PC2, pps, sizeBytes: 60, count: fits + 1 })).toEqual([refusedLine(TOO_LONG)]);
    expect(appStart(sim, 'pc1', { dst: PC2, pps, sizeBytes: 60, durationMs: TRAFFIC_MAX_DURATION_MS + 1 })).toEqual([refusedLine(TOO_LONG)]);
    // exactly the cap starts
    expect(shell(sim, 'pc1', `flow start ${PC2} pps ${pps} size 60 count ${fits}`).text).toMatch(new RegExp(`^Flow f\\d+ started: .*, ${fits} packets\\.$`));
    expect(shell(sim, 'pc1', `flow start ${PC2} pps ${pps} size 60 for ${secs}`).text).toMatch(/^Flow f\d+ started: /);
    expect(flowState(sim).filter((f) => f.state === 'running')).toHaveLength(2);
  });
});

describe('runToIdle and flows', () => {
  for (const path of ['uncongested', 'congested'] as const) {
    it(`a bounded flow (${path} path) holds runToIdle until its last datagram and no longer`, () => {
      const sim = lab(path === 'uncongested' ? 311 : 312);
      const evs = record(sim);
      const dst = path === 'uncongested' ? PC2 : PC3;
      const rx: DeviceId = path === 'uncongested' ? 'pc2' : 'pc3';
      // congested: 40 × 500-byte datagrams at 256 kb/s into a 64 kb/s line (a backlog, no drop: 40 < the queue limit)
      const count = path === 'uncongested' ? 20 : 40;
      expect(shell(sim, 'pc1', path === 'uncongested' ? `flow start ${dst} pps 50 size 200 count ${count}` : `flow start ${dst} rate 256 size 500 count ${count}`).text).toMatch(/^Flow f\d+ started: /);
      const run = sim.runToIdle();
      expect(run.stopped).toBeUndefined();
      const sent = sentBy(sim, evs);
      expect(sent).toHaveLength(count);
      expect(sent.map((s) => s.h.final)).toEqual(sent.map((_, i) => i === count - 1));
      const arrive = consumedAt(evs, rx);
      expect(sent.every((s) => arrive.has(s.id))).toBe(true);
      const lastArrival = arrive.get(sent.at(-1)!.id)!;
      if (path === 'congested') expect(lastArrival - sent.at(-1)!.t).toBeGreaterThan(1 * SEC); // the FIFO drained after the last send
      // the run ends at the receiver's final write, TRAFFIC_FLUSH_NS after the final datagram: no later, no earlier
      expect(run.to).toBe(lastArrival + TRAFFIC_FLUSH_NS);
      const key = `192.168.1.10|${flowState(sim).at(-1)!.id}`;
      const writes = flowWrites(evs, rx, key);
      expect(writes.at(-1)).toMatchObject({ t: lastArrival + TRAFFIC_FLUSH_NS, row: { received: count, lost: 0, ended: true } });
      // and the flow is finished: a second run has nothing to do
      expect(sim.runToIdle()).toEqual({ events: 0, from: run.to, to: run.to });
    });
  }

  it('an uncongested continuous flow does not hold runToIdle; a finished or stopped flow does not either', () => {
    const sim = lab(313);
    const evs = record(sim);
    const t0 = sim.now;
    const pace = Math.floor(SEC / 100);
    expect(shell(sim, 'pc1', `flow start ${PC2} pps 100 size 100`).text).toMatch(/^Flow f\d+ started: .*until stopped/);
    const id = flowState(sim).at(-1)!.id;
    // datagram 0 is delivered and the run returns, long before the next datagram is due
    const first = sim.runToIdle();
    expect(first.stopped).toBeUndefined();
    expect(first.to - t0).toBeLessThan(pace);
    expect(flowState(sim).find((f) => f.id === id)!.state).toBe('running');
    // the flow keeps running under runFor, and still never holds runToIdle
    sim.runFor(3 * SEC);
    const mid = sim.runToIdle();
    expect(mid.stopped).toBeUndefined();
    expect(mid.to - mid.from).toBeLessThan(pace);
    expect(sentBy(sim, evs).filter((s) => s.h.flow === id).length).toBeGreaterThanOrEqual(300);
    // stopped: nothing of it holds a run (its receiver's flush after a continuous datagram is periodic)
    expect(shell(sim, 'pc1', `flow stop ${id}`).text).toMatch(new RegExp(`^Flow ${id} stopped after \\d+ packets\\.$`));
    const stopped = sim.runToIdle();
    expect(stopped.stopped).toBeUndefined();
    expect(stopped.to - stopped.from).toBeLessThan(pace);
    // the receiver still writes its final row (under runFor): a second after the last datagram it saw, or at that
    // datagram when it opened a new second (then nothing changed since), with every datagram counted
    const got = consumedAt(evs, 'pc2');
    const lastArrival = Math.max(...got.values());
    sim.runFor(2 * SEC);
    const last = flowWrites(evs, 'pc2', `192.168.1.10|${id}`).at(-1)!;
    expect([lastArrival, lastArrival + TRAFFIC_FLUSH_NS]).toContain(last.t);
    expect(last.row).toMatchObject({ received: got.size, lost: 0, ended: false });
    // finished: a bounded flow that ended leaves nothing behind — a one-datagram flow too, which ends inside the
    // dispatch that starts it (W4 fix: its 5-minute cap timer was armed after it had ended, and held runToIdle)
    for (const count of [5, 1]) {
      const before = new Set(consumedAt(evs, 'pc2').keys());
      expect(shell(sim, 'pc1', `flow start ${PC2} pps 100 size 100 count ${count}`).text).toMatch(/^Flow f\d+ started: /);
      const bounded = sim.runToIdle();
      expect(bounded.stopped).toBeUndefined();
      const arrivals = [...consumedAt(evs, 'pc2')].filter(([pdu]) => !before.has(pdu)).map(([, t]) => t);
      expect(arrivals).toHaveLength(count);
      expect(bounded.to, `count ${count}`).toBe(Math.max(...arrivals) + TRAFFIC_FLUSH_NS);
      expect(sim.runToIdle().events).toBe(0);
    }
  });

  it('for contrast (rule 19): a continuous flow over a congested link does hold runToIdle', () => {
    const sim = lab(314);
    expect(shell(sim, 'pc1', `flow start ${PC3} rate 256 size 1000`).text).toMatch(/^Flow f\d+ started: /);
    const cap = 5_000;
    const run = sim.runToIdle(cap);
    expect(run).toMatchObject({ events: cap, stopped: 'maxEvents' });
  });

  it('a continuous flow stops at TRAFFIC_MAX_DURATION_MS (runFor): ceil(cap / pace) datagrams, the last one final', () => {
    const sim = lab(315);
    const evs = record(sim);
    const pps = 3; // a pace that does not divide the cap
    const pace = Math.floor(SEC / pps);
    const t0 = sim.now;
    expect(shell(sim, 'pc1', `flow start ${PC2} pps ${pps} size 60`).text).toMatch(/^Flow f\d+ started: /);
    sim.runFor(TRAFFIC_MAX_DURATION_NS + 10 * SEC);
    const sent = sentBy(sim, evs);
    const limit = Math.ceil(TRAFFIC_MAX_DURATION_NS / pace);
    expect(sent).toHaveLength(limit);
    expect(sent.map((s) => s.t)).toEqual(Array.from({ length: limit }, (_, k) => t0 + k * pace));
    expect(sent.at(-1)!.t).toBeLessThan(t0 + TRAFFIC_MAX_DURATION_NS);
    expect(sent.map((s) => s.h.final)).toEqual(sent.map((_, i) => i === limit - 1));
    const f = flowState(sim).at(-1)!;
    expect([f.state, f.sent]).toEqual(['ended', limit]);
    const row = sim.device('pc2')!.tables.get<FlowRow>('flows')!.get(`192.168.1.10|${f.id}`);
    expect(row).toMatchObject({ received: limit, lost: 0, ended: true });
  });
});

describe('the receiver: the final write and tail losses', () => {
  /**
   * PC1 → PC2, `count` datagrams at 10 pps from `t0`; the datagrams sent in `lose` (sequence numbers) are lost on the
   * R1 — PC2 link (100 % loss around their sends). Returns the sent datagrams, PC2's arrivals and its flows writes.
   */
  function tail(seed: number, t0: SimTime, count: number, lose: readonly number[]) {
    const sim = lab(seed);
    expect(sim.now).toBeLessThan(t0);
    sim.runUntil(t0);
    const evs = record(sim);
    expect(shell(sim, 'pc1', `flow start ${PC2} pps 10 size 60 count ${count}`).text).toMatch(/^Flow f\d+ started: /);
    const pace = 100 * MS;
    for (const seq of lose) {
      sim.runUntil(t0 + seq * pace - 10 * MS);
      sim.setImpairments('l_pc2', { lossPct: 100 });
      sim.runUntil(t0 + seq * pace + 10 * MS);
      sim.setImpairments('l_pc2', { lossPct: 0 });
    }
    sim.runFor(5 * SEC);
    const sent = sentBy(sim, evs);
    const arrive = consumedAt(evs, 'pc2');
    const key = `192.168.1.10|${flowState(sim).at(-1)!.id}`;
    const losses = evs.filter((e) => e.kind === 'drop' && e.reason === 'link-loss' && sent.some((s) => s.id === e.pdu.id)).length;
    return { sent, arrive, writes: flowWrites(evs, 'pc2', key), losses };
  }

  /** The first whole second after the lab has settled. */
  const second = (n: number): SimTime => n * SEC;

  it('the final write comes TRAFFIC_FLUSH_NS after the last datagram; the tail losses appear only once the final datagram arrived', () => {
    // 8 datagrams from S + 100 ms: only datagram 0 opens a second, so the rows are its write and the flush
    const S = second(70);
    const { sent, arrive, writes, losses } = tail(321, S + 100 * MS, 8, [5, 6]);
    expect(losses).toBe(2);
    const final = arrive.get(sent[7]!.id)!;
    expect(writes.map((w) => w.t)).toEqual([arrive.get(sent[0]!.id)!, final + TRAFFIC_FLUSH_NS]);
    // before the final datagram: no loss counted although two were lost; after it: both
    expect(writes.filter((w) => w.t < final).map((w) => w.row.lost)).toEqual([0]);
    expect(writes.at(-1)!.row).toMatchObject({ received: 6, lost: 2, ended: true });
  });

  it('a final datagram that opens a new second is written at once, already counting the tail losses', () => {
    // 8 datagrams from S − 650 ms: datagram 7 arrives at S + 50 ms, the first of second S
    const S = second(71);
    const { sent, arrive, writes } = tail(322, S - 650 * MS, 8, [5, 6]);
    const final = arrive.get(sent[7]!.id)!;
    expect(final).toBeGreaterThanOrEqual(S);
    expect(writes.filter((w) => w.t < final).every((w) => w.row.lost === 0)).toBe(true);
    expect(writes.find((w) => w.t === final)?.row).toMatchObject({ received: 6, lost: 2, ended: true });
    // nothing changed since, so the flush writes nothing more
    expect(writes.at(-1)!.t).toBe(final);
  });

  it('when the final datagram is lost too, the tail losses are never counted and the flow never ends', () => {
    const S = second(72);
    const { sent, arrive, writes, losses } = tail(323, S + 100 * MS, 8, [5, 6, 7]);
    expect(losses).toBe(3);
    const last = arrive.get(sent[4]!.id)!;
    expect(writes.at(-1)).toMatchObject({ t: last + TRAFFIC_FLUSH_NS, row: { received: 5, lost: 0, ended: false } });
  });
});

describe('a datagram without the traffic header to a closed port still draws port unreachable, on any host', () => {
  it('every model running the traffic daemon, wired or wireless, answers ICMP 3/3 and consumes a generated datagram in silence', () => {
    const catalog = createStagedCatalog({ stage: 'P3', factories: FACTORIES });
    const hosts = catalog.list().filter((m) => m.processes.includes('traffic'));
    expect(hosts.length).toBeGreaterThanOrEqual(10);
    const sim = createStagedSimulation({ seed: 331, stage: 'P3', factories: FACTORIES });
    // one 192.168.1.0/24 LAN: SW1 for the wired hosts, HOME1's Wi-Fi network LAB for the wireless ones
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: startup([['hostname SW1']]) });
    sim.addDevice({
      id: 'home1', type: 'wrouter.nfhome', name: 'HOME1', position: { x: 300, y: 300 },
      startupConfig: startup([['hostname HOME1'], ['interface Vlan1', ' ip address 192.168.1.1 255.255.255.0'], ['interface Wlan0', ' ssid LAB', ' security wpa2-psk', ' passphrase nf-lab-pass']]),
    });
    sim.addLink({ a: { device: 'home1', port: 'GigabitEthernet1' }, b: { device: 'sw1', port: 'GigabitEthernet0/1' } });
    sim.addDevice({ id: 'src', type: 'pc.nfpc', name: 'SRC', startupConfig: pc('SRC', '192.168.1.200', '192.168.1.1') });
    sim.addLink({ a: { device: 'src', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
    const targets: { id: DeviceId; type: string; ip: string }[] = [];
    let swPort = 2;
    let radio = 0;
    hosts.forEach((m, i) => {
      const id = `h${i}`;
      const ip = `192.168.1.${20 + i}`;
      const iface = m.hostPorts[0]!;
      const wired = m.ports.find((p) => p.kind === 'ethernet');
      const wireless = wired === undefined;
      const lines = [` ip address ${ip} 255.255.255.0`, ...(wireless ? [' ssid LAB', ' security wpa2-psk', ' passphrase nf-lab-pass'] : []), ' no shutdown'];
      const position = wireless ? { x: 300 + 20 * Math.cos(radio), y: 300 + 20 * Math.sin(radio) } : { x: 600, y: 60 * i };
      if (wireless) radio += 1;
      sim.addDevice({ id, type: m.type, name: `H${i}`, position: { x: Math.round(position.x), y: Math.round(position.y) }, startupConfig: startup([[`hostname H${i}`], [`interface ${iface}`, ...lines]]) });
      if (!wireless) sim.addLink({ a: { device: id, port: wired.name }, b: { device: 'sw1', port: `FastEthernet0/${swPort++}` } });
      targets.push({ id, type: m.type, ip });
    });
    sim.runFor(90 * SEC);
    const evs = record(sim);
    // a plain UDP datagram (udp.probe: no traffic header) to each target's closed port 9, one at a time
    targets.forEach((t, i) => {
      sim.device('src')!.applyActions('sim', [{ type: 'request', to: 'udp', req: { kind: 'udp.probe', session: `p${i}`, dst: t.ip, port: 9, timeoutNs: 3 * SEC } }], sim.now);
      sim.runFor(4 * SEC);
    });
    // a generated datagram (with the header) to the same port: consumed in silence
    const flowsAt = evs.length;
    targets.forEach((t) => {
      expect(shell(sim, 'src', `flow start ${t.ip} pps 10 size 60 count 1`).text, t.type).toMatch(/^Flow f\d+ started: /);
      sim.runFor(2 * SEC);
    });
    for (const t of targets) {
      const probes = evs.slice(0, flowsAt);
      const closed = probes.filter((e) => e.kind === 'drop' && e.device === t.id && e.detail === 'udp port 9 closed');
      expect(closed.length, `${t.type}: closed-port drop`).toBe(1);
      const icmp = probes
        .filter((e): e is Extract<TraceEvent, { kind: 'pduCreated' }> => e.kind === 'pduCreated' && e.device === t.id && e.process === 'icmpv4')
        .map((e) => sim.pdu(e.pdu.id)!)
        .map((p) => [p.get('icmpv4.type'), p.get('icmpv4.code')]);
      expect(icmp, `${t.type}: ICMP port unreachable`).toEqual([[3, 3]]);
      const generated = evs.slice(flowsAt);
      expect(generated.filter((e) => e.kind === 'drop' && e.device === t.id && e.detail === 'udp port 9 closed'), `${t.type}: generated datagram`).toEqual([]);
      expect(generated.filter((e) => e.kind === 'pduCreated' && e.device === t.id && e.process === 'icmpv4'), `${t.type}: no ICMP`).toEqual([]);
      expect(sim.device(t.id)!.tables.get<FlowRow>('flows')!.rows(), `${t.type}: flows row`).toHaveLength(1);
    }
  }, 120_000);
});
