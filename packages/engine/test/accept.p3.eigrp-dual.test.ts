/**
 * P3 acceptance [C1] — DUAL on the §3.12 world: the feasible successor, the active phase, the indirect failure, the
 * reliable transport's limit and stuck-in-active (ARCHITECTURE-P3 §10.1 row `accept.p3.eigrp-dual`; §3.12 steps 3–5,
 * D26, §4.2, rule 19; §7 W4 qa).
 *
 * Built on `staged.world` at stage P3 with the registry the W4 flip writes (`accept.p3.eigrp.world.ts`; every router
 * configured through the grammar before the cables go in). The row, clause by clause:
 *   • step 3: the R1–R2 cable cut at T (a `cable-cut` fault): the dispatch of the fault alone drops R2 (`interface
 *     down`), promotes R3 (`eigrp-route` passive → passive, cause `feasible successor promoted`), and installs
 *     `D 10.4.0.0/24 [90/28672] via 10.0.13.3` (one rib write, at T); no query ever carries 10.4.0.0/24; R1 poisons the
 *     prefix toward R3 at T; a ping typed at T reaches 10.4.0.1 with no loss;
 *   • step 4: no feasible successor (R3 — R4 slow too, R3's own distance 28416 ≥ FD 3328): at T R1 goes active, sends
 *     one reliable query to R3 carrying the infinite distance, R3 replies 28416 at once, and R1 is passive again with
 *     `[90/30976]` within T + 5 ms (30976 computed in the test from D26's formula);
 *   • step 5: the indirect failure — R1 — SW1 — R2, the SW1–R2 cable cut at T: R1's port stays up, R2 is lost when its
 *     hold expires in [T + 10 s, T + 15 s], and R3 is promoted in that same instant;
 *   • 16 unanswered retransmissions reset a neighbour (a real fault: R2's inbound list drops every unicast EIGRP packet
 *     from R1, so the init update is never acknowledged): one send and 16 retransmissions an RTO (200 ms) apart, the
 *     reset one RTO later, `runToIdle` returns;
 *   • SIA timers are periodic (rule 19): a neighbour that acknowledges R1's query but never replies (a test wrapper on
 *     R3's daemon; no network fault can make one) leaves the route active while `runToIdle` returns; the SIA-query goes
 *     out at T + 90 s and is answered by an SIA-reply; the neighbour is reset at T + 180 s;
 *   • `runToIdle` returns within link-up + 50 ms with every route in;
 *   • lab 10's grading in the clone: `neighbor`, `route`, `fact eigrp.feasibleSuccessor` (engine/fact parity: it names
 *     R3, whose address is the topology row's feasible next hop) and `connectivity` after `cut {a: 'R1', b: 'R2',
 *     aPort: 'Gi0/0'}` pass; wrong answers fail; the live world is untouched.
 */
import { describe, expect, it } from 'vitest';
import { EIGRP_INFINITY } from '../src/contracts/pdu.js';
import type { Process, ProcessFactory } from '../src/contracts/process.js';
import type { LabAssertion, ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { EigrpStateView } from '../src/contracts/tables.js';
import { MS, SEC, type SimTime } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID } from '../src/contracts/topology.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { EIGRP_OPCODE } from '../src/pdu/codecs/eigrp.js';
import { EIGRP_MAX_RETRANSMISSIONS, EIGRP_RTO_MIN_MS, EIGRP_SIA_QUERY_NS, EIGRP_SIA_RESET_NS, createEigrp, eigrpParseRoutes } from '../src/protocols/eigrp.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import {
  GI0,
  GI1,
  LAN,
  R1,
  R2,
  R3,
  R4,
  eigrpAcceptWorld,
  eigrpCreated,
  eigrpFields,
  eventsFrom,
  neighborRows,
  ribRow,
  ribWrites,
  shown,
  topologyRow,
  transitions,
  upAt,
  type Created,
} from './accept.p3.eigrp.world.js';

/** D26's composite metric (K 1 0 1 0 0). */
const classic = (minBwKbps: number, delayUs: number): number => 256 * (Math.floor(10_000_000 / minBwKbps) + Math.floor(delayUs / 10));

/** The prefixes an EIGRP packet carries, with the distance each is advertised at (`inf` → EIGRP_INFINITY). */
function carried(sim: Simulation, c: Created): Record<string, number> {
  const out: Record<string, number> = {};
  const routes = eigrpFields(sim, c)['routes'];
  for (const r of eigrpParseRoutes(typeof routes === 'string' ? routes : '')) {
    out[r.prefix] = r.vector.delayUs === 0xffff_ffff ? EIGRP_INFINITY : classic(r.vector.bwKbps, r.vector.delayUs);
  }
  return out;
}

const opcodeOf = (sim: Simulation, c: Created): number => Number(eigrpFields(sim, c)['opcode']);

/** Cut `link` at T with a `cable-cut` fault and dispatch exactly that event; returns T and the cursor before it. */
function cutAt(sim: Simulation, link: string, T: SimTime): { cursor: number } {
  sim.injectFault(T, { id: 'cut', kind: 'cable-cut', target: { link } });
  sim.runUntil(T - 1);
  const cursor = sim.trace(0).next;
  const ev = sim.step();
  expect(ev).toMatchObject({ kind: 'fault', at: T });
  return { cursor };
}

/** The text a console session printed among `evs`. */
const printed = (evs: readonly TraceEvent[], s: string): string => evs.flatMap((e) => (e.kind === 'cliOutput' && e.session === s ? [e.text] : [])).join('');

describe('accept.p3.eigrp-dual [C1]: §3.12 step 3, the feasible successor', () => {
  it('the R1–R2 cable cut at T: R3 promoted and [90/28672] installed in the fault dispatch, no query for the prefix', () => {
    const { sim, links } = eigrpAcceptWorld();
    sim.runToIdle();
    sim.runFor(10 * SEC);
    expect(topologyRow(sim, R1, LAN)).toMatchObject({ fd: 3328, feasible: [{ nextHop: '10.0.13.3', iface: GI1, metric: 28672, rd: 3072 }] });
    // a ping before the cut goes through R2
    const s = sim.cli.open(R1, 'console');
    sim.cli.exec(s, 'ping 10.4.0.1');
    sim.runFor(1 * SEC);
    const T = sim.now + 1 * SEC;
    const { cursor } = cutAt(sim, links.r1r2, T);
    // everything below happened in the dispatch of the fault event alone
    expect(sim.now).toBe(T);
    const atT = eventsFrom(sim, cursor);
    expect(transitions(atT, R1, 'eigrp-nbr').map((x) => [x.t, x.subject, x.from, x.to, x.cause])).toEqual([[T, `${GI0} 10.0.12.2`, 'up', 'down', 'interface down']]);
    expect(transitions(atT, R1, 'eigrp-route').filter((x) => x.subject === LAN).map((x) => [x.t, x.from, x.to, x.cause])).toEqual([[T, 'passive', 'passive', 'feasible successor promoted']]);
    expect(ribWrites(atT, R1, LAN).map((w) => [w.t, w.row['nextHop'], w.row['iface'], w.row['metric'], w.row['ad'], w.row['source']])).toEqual([[T, '10.0.13.3', GI1, 28672, 90, 'EIGRP']]);
    expect(topologyRow(sim, R1, LAN)).toMatchObject({
      state: 'passive',
      fd: 28672,
      successors: [{ nextHop: '10.0.13.3', iface: GI1, metric: 28672, rd: 3072 }],
      feasible: [],
      others: [],
    });
    // poison reverse: R3 is now the successor, so R1 tells R3 the prefix is unreachable through R1, at T
    const toR3 = eigrpCreated(atT, R1, 'ipv4:10.0.13.1>10.0.13.3:eigrp').filter((c) => opcodeOf(sim, c) === EIGRP_OPCODE.update && LAN in carried(sim, c));
    expect(toR3.map((c) => [c.t, carried(sim, c)[LAN]])).toEqual([[T, EIGRP_INFINITY]]);
    // a ping typed at T goes through R3 at once, with no loss
    const p = sim.trace(0).next;
    sim.cli.exec(s, 'ping 10.4.0.1');
    sim.runToIdle();
    const after = eventsFrom(sim, cursor);
    expect(printed(eventsFrom(sim, p), s)).toContain('Sent 5, received 5, lost 0 (0% loss)');
    // no query ever carried 10.4.0.0/24 (the lost connected network 10.0.12.0/24, which had no feasible successor, is queried)
    const queries = eigrpCreated(after, R1).filter((c) => opcodeOf(sim, c) === EIGRP_OPCODE.query);
    for (const q of queries) expect(Object.keys(carried(sim, q))).not.toContain(LAN);
    expect(shown(sim, R1, 'show ip route').at(-1)).toBe(`D    10.4.0.0/24  via 10.0.13.3 [90/28672] ${GI1}`);
    expect(shown(sim, R1, 'show ip eigrp topology').slice(-2)).toEqual(['P 10.4.0.0/24, 1 successor, FD 28672', `        via 10.0.13.3 (28672/3072), ${GI1}`]);
    // stable afterwards
    sim.runFor(30 * SEC);
    expect(ribRow(sim, R1, LAN)).toMatchObject({ nextHop: '10.0.13.3', metric: 28672 });
    expect(neighborRows(sim, R1).map((r) => r.address)).toEqual(['10.0.13.3']);
  });
});

describe('accept.p3.eigrp-dual [C1]: §3.12 step 4, no feasible successor', () => {
  it('R3 is not feasible (28416 ≥ 3328): active at T, one query, the reply 28416, passive at [90/30976] within T + 5 ms', () => {
    const { sim, links } = eigrpAcceptWorld({ variant: 'no-fs' });
    sim.runToIdle();
    const rdR3 = classic(100_000, 100 + 10); // R3 → R4 (100 Mb/s, 100 µs) + R4's LAN
    const viaR3 = classic(100_000, 100 + 100 + 10);
    expect([rdR3, viaR3]).toEqual([28416, 30976]);
    expect(topologyRow(sim, R1, LAN)).toMatchObject({
      fd: 3328,
      successors: [{ nextHop: '10.0.12.2', metric: 3328, rd: 3072 }],
      feasible: [],
      others: [{ nextHop: '10.0.13.3', iface: GI1, metric: viaR3, rd: rdR3 }],
    });
    const T = sim.now + 1 * SEC;
    const { cursor } = cutAt(sim, links.r1r2, T);
    // active at T: no route for the prefix while the query is out
    expect(topologyRow(sim, R1, LAN)).toMatchObject({ state: 'active', pendingReplies: 1 });
    expect(ribRow(sim, R1, LAN)).toBeUndefined();
    expect(sim.runToIdle().stopped).toBeUndefined();
    const evs = eventsFrom(sim, cursor);
    const route = transitions(evs, R1, 'eigrp-route').filter((x) => x.subject === LAN);
    expect(route.map((x) => [x.from, x.to, x.cause])).toEqual([
      ['passive', 'active', 'no feasible successor: querying neighbours'],
      ['active', 'passive', 'all replies received'],
    ]);
    expect(route[0]!.t).toBe(T);
    expect(route[1]!.t - T).toBeLessThan(5 * MS);
    // exactly one query (R1 → R3, the infinite distance) and one reply (R3 → R1, R3's own distance)
    const q = eigrpCreated(evs, R1).filter((c) => opcodeOf(sim, c) === EIGRP_OPCODE.query && LAN in carried(sim, c));
    expect(q.map((c) => [c.pdu.flow, carried(sim, c)[LAN]])).toEqual([['ipv4:10.0.13.1>10.0.13.3:eigrp', EIGRP_INFINITY]]);
    const r = eigrpCreated(evs, R3).filter((c) => opcodeOf(sim, c) === EIGRP_OPCODE.reply && LAN in carried(sim, c));
    expect(r.map((c) => [c.pdu.flow, carried(sim, c)[LAN]])).toEqual([['ipv4:10.0.13.3>10.0.13.1:eigrp', rdR3]]);
    expect(topologyRow(sim, R1, LAN)).toMatchObject({ state: 'passive', fd: viaR3, successors: [{ nextHop: '10.0.13.3', iface: GI1, metric: viaR3, rd: rdR3 }] });
    expect(ribRow(sim, R1, LAN)).toMatchObject({ source: 'EIGRP', nextHop: '10.0.13.3', iface: GI1, metric: viaR3, ad: 90 });
    expect(ribWrites(evs, R1, LAN).at(-1)!.t).toBe(route[1]!.t);
    const view = sim.device(R1)!.processes.get('eigrp')!.stateSnapshot().state as unknown as EigrpStateView;
    expect(view.active).toEqual([]);
  });
});

describe('accept.p3.eigrp-dual [C1]: §3.12 step 5, the indirect failure', () => {
  it('R1 — SW1 — R2, the SW1–R2 cable cut at T: R1 keeps its port, loses R2 in [T + 10 s, T + 15 s] and promotes R3 then', () => {
    const { sim, links } = eigrpAcceptWorld({ variant: 'switch' });
    sim.runFor(30 * SEC);
    sim.runToIdle();
    expect(topologyRow(sim, R1, LAN)).toMatchObject({ fd: 3328, successors: [{ nextHop: '10.0.12.2' }], feasible: [{ nextHop: '10.0.13.3', metric: 28672 }] });
    const T = sim.now + 1 * SEC;
    sim.injectFault(T, { id: 'cut', kind: 'cable-cut', target: { link: links.swR2! } });
    const cursor = sim.trace(0).next;
    sim.runUntil(T + 10 * SEC - 1);
    expect(neighborRows(sim, R1).map((r) => r.address).sort()).toEqual(['10.0.12.2', '10.0.13.3']);
    expect(ribRow(sim, R1, LAN)).toMatchObject({ nextHop: '10.0.12.2', metric: 3328 });
    sim.runUntil(T + 15 * SEC);
    const evs = eventsFrom(sim, cursor);
    expect(sim.device(R1)!.ports.get(GI0)!.operUp).toBe(true);
    const down = transitions(evs, R1, 'eigrp-nbr').filter((x) => x.to === 'down');
    expect(down.map((x) => [x.subject, x.from, x.cause])).toEqual([[`${GI0} 10.0.12.2`, 'up', 'hold time expired']]);
    const t = down[0]!.t;
    expect(t).toBeGreaterThanOrEqual(T + 10 * SEC);
    expect(t).toBeLessThanOrEqual(T + 15 * SEC);
    // then as step 3, in that same instant
    expect(transitions(evs, R1, 'eigrp-route').filter((x) => x.subject === LAN).map((x) => [x.t, x.cause])).toEqual([[t, 'feasible successor promoted']]);
    expect(ribWrites(evs, R1, LAN).map((w) => [w.t, w.row['nextHop'], w.row['metric']])).toEqual([[t, '10.0.13.3', 28672]]);
  });
});

describe('accept.p3.eigrp-dual [C1]: the reliable transport and stuck-in-active (rule 19)', () => {
  it('16 unanswered retransmissions reset a neighbour; runToIdle returns', () => {
    // R2's inbound list drops every unicast EIGRP packet from R1: the hellos pass, the init update is never acknowledged
    const w = eigrpAcceptWorld({
      lines: {
        [R2]: ['ip access-list extended NO-EIGRP-UNICAST', 'deny eigrp host 10.0.12.1 host 10.0.12.2', 'permit ip any any', 'exit', `interface ${GI0}`, 'ip access-group NO-EIGRP-UNICAST in', 'exit'],
      },
    });
    const { sim } = w;
    expect(sim.runToIdle().stopped).toBeUndefined();
    const evs = eventsFrom(sim, w.cursor);
    const inits = eigrpCreated(evs, R1, 'ipv4:10.0.12.1>10.0.12.2:eigrp').filter((c) => c.pdu.tag === 'eigrp-update');
    expect(inits).toHaveLength(1 + EIGRP_MAX_RETRANSMISSIONS);
    for (const c of inits) expect(eigrpFields(sim, c)).toMatchObject({ opcode: 1, flags: 1, seq: 1 });
    for (let i = 1; i < inits.length; i++) expect(inits[i]!.t - inits[i - 1]!.t).toBe(EIGRP_RTO_MIN_MS * MS);
    // each one died in R2's list
    const denied = evs.filter((e) => e.kind === 'drop' && e.device === R2 && e.reason === 'acl-deny' && e.pdu.tag === 'eigrp-update' && e.pdu.flow === 'ipv4:10.0.12.1>10.0.12.2:eigrp');
    expect(denied).toHaveLength(1 + EIGRP_MAX_RETRANSMISSIONS);
    const nbr = transitions(evs, R1, 'eigrp-nbr').filter((x) => x.subject === `${GI0} 10.0.12.2`);
    expect(nbr.map((x) => [x.from, x.to, x.cause])).toEqual([
      ['down', 'pending', 'hello received'],
      ['pending', 'down', 'retry limit exceeded'],
    ]);
    expect(nbr[1]!.t - inits.at(-1)!.t).toBe(EIGRP_RTO_MIN_MS * MS);
    expect(neighborRows(sim, R1).map((r) => [r.address, r.state])).toEqual([['10.0.13.3', 'up']]);
    // the next attempt waits for R2's next periodic hello
    const later = sim.trace(0).next;
    sim.runFor(6 * SEC);
    expect(transitions(eventsFrom(sim, later), R1, 'eigrp-nbr').filter((x) => x.subject === `${GI0} 10.0.12.2`)[0]).toMatchObject({ from: 'down', to: 'pending' });
  });

  it('SIA timers are periodic: a query acknowledged and never answered leaves the route active and runToIdle returns', () => {
    // R3's daemon acknowledges R1's queries as if they were updates and so never replies (a stuck neighbour)
    const stuck: ProcessFactory = (): Process => {
      const inner = createEigrp();
      return {
        ...inner,
        onPdu: (ctx, pdu, port) => {
          const e = pdu.layer('eigrp');
          if (ctx.deviceId === R3 && e !== undefined && e.fields['opcode'] === EIGRP_OPCODE.query) {
            ctx.mutate(pdu, 'eigrp.opcode', EIGRP_OPCODE.update, 'Other', 'test fault: R3 never replies to a query');
          }
          return inner.onPdu(ctx, pdu, port);
        },
      };
    };
    const { sim, links } = eigrpAcceptWorld({ variant: 'no-fs', eigrp: stuck });
    sim.runToIdle();
    const T = sim.now + 1 * SEC;
    const { cursor } = cutAt(sim, links.r1r2, T);
    // the query is acknowledged, no reply comes: only periodic timers are left, so runToIdle returns while active
    expect(sim.runToIdle().stopped).toBeUndefined();
    expect(sim.now).toBeLessThan(T + EIGRP_SIA_QUERY_NS);
    expect(topologyRow(sim, R1, LAN)).toMatchObject({ state: 'active', pendingReplies: 1 });
    const view = (): EigrpStateView => sim.device(R1)!.processes.get('eigrp')!.stateSnapshot().state as unknown as EigrpStateView;
    expect(view().active.find((a) => a.prefix === LAN)).toEqual({ prefix: LAN, since: T, waitingFor: ['10.0.13.3'] });
    expect(neighborRows(sim, R1).map((r) => r.address)).toEqual(['10.0.13.3']);
    // at T + 90 s the SIA-queries (one per active prefix, one reliable packet at a time), each answered by an SIA-reply
    sim.runUntil(T + EIGRP_SIA_QUERY_NS - 1);
    const siaOf = (evs: readonly TraceEvent[]): Created[] => eigrpCreated(evs, R1, 'ipv4:10.0.13.1>10.0.13.3:eigrp').filter((c) => opcodeOf(sim, c) === EIGRP_OPCODE.siaQuery);
    expect(siaOf(eventsFrom(sim, cursor))).toEqual([]);
    sim.runFor(1 * SEC + 1);
    const sia = siaOf(eventsFrom(sim, cursor));
    expect(sia[0]!.t).toBe(T + EIGRP_SIA_QUERY_NS);
    for (const c of sia) expect(c.t - (T + EIGRP_SIA_QUERY_NS)).toBeLessThan(10 * MS);
    expect(sia.flatMap((c) => Object.keys(carried(sim, c)))).toContain(LAN);
    const answers = eigrpCreated(eventsFrom(sim, cursor), R3, 'ipv4:10.0.13.3>10.0.13.1:eigrp').filter((c) => opcodeOf(sim, c) === EIGRP_OPCODE.siaReply);
    expect(answers).toHaveLength(sia.length);
    expect(topologyRow(sim, R1, LAN)).toMatchObject({ state: 'active' });
    // at T + 180 s the neighbour still awaited is reset
    sim.runUntil(T + EIGRP_SIA_RESET_NS);
    const evs = eventsFrom(sim, cursor);
    const reset = transitions(evs, R1, 'eigrp-nbr').filter((x) => x.subject === `${GI1} 10.0.13.3` && x.to === 'down');
    expect(reset.map((x) => [x.t, x.from, x.cause])).toEqual([[T + EIGRP_SIA_RESET_NS, 'up', 'stuck in active']]);
    expect(view().active).toEqual([]);
  });

  it('three runs of the no-FS failover with one seed give byte-identical trace and snapshot JSON (§10 definition of done)', () => {
    const run = (): string => {
      const { sim, links } = eigrpAcceptWorld({ variant: 'no-fs' });
      sim.runToIdle();
      sim.injectFault(sim.now + 1 * SEC, { id: 'cut', kind: 'cable-cut', target: { link: links.r1r2 } });
      sim.runToIdle();
      sim.runFor(20 * SEC);
      return JSON.stringify({ trace: sim.trace(0).events, snapshot: sim.snapshot() });
    };
    const first = run();
    expect(run()).toBe(first);
    expect(run()).toBe(first);
  });

  it('runToIdle returns within link-up + 50 ms with every route in', () => {
    const w = eigrpAcceptWorld();
    const stats = w.sim.runToIdle();
    const evs = eventsFrom(w.sim, w.cursor);
    const linkUp = upAt(evs, R1, GI0);
    expect(stats.stopped).toBeUndefined();
    expect(stats.to - linkUp).toBeLessThan(50 * MS);
    for (const [d, n] of [[R1, 3], [R2, 3], [R3, 3], [R4, 2]] as const) {
      expect(w.sim.device(d)!.tables.rib.rows().filter((r) => r.source === 'EIGRP'), d).toHaveLength(n);
    }
  });
});

describe('accept.p3.eigrp-dual [C1]: lab 10 grading in the clone; engine/fact parity', () => {
  function lab(assertions: readonly LabAssertion[]): ScenarioInfo {
    return {
      name: 'accept-eigrp-dual',
      title: 'EIGRP failover',
      description: 'Graded by the acceptance row',
      category: 'ccna3-lab',
      build: () => ({ schema: TOPOLOGY_SCHEMA_ID, seed: 1, devices: [], links: [] }),
      tasks: [{ id: 'only', title: 'Only task', description: 'One task', points: 10, assertions }],
    };
  }
  const verdicts = (sim: Simulation, assertions: readonly LabAssertion[]): (string | undefined)[] =>
    evaluateLab(sim, lab(assertions)).results[0]!.assertions.map((r) => (r.pass ? undefined : (r.detail ?? '(no detail)')));

  it('neighbor, route, fact eigrp.feasibleSuccessor and connectivity after cut {aPort} pass; wrong answers fail', () => {
    const { sim } = eigrpAcceptWorld();
    sim.runToIdle();
    // engine/fact parity: the fact names the device whose address is the topology row's first feasible next hop
    const fs = topologyRow(sim, R1, LAN)!.feasible[0]!;
    expect(fs.nextHop).toBe(sim.device(R3)!.ports.get(GI0)!.l3.ipv4!.address);
    const fingerprint = (): string => JSON.stringify({ now: sim.now, head: sim.trace(0).next, topo: sim.exportTopology(), snapshot: sim.snapshot() });
    const before = fingerprint();
    const cut: Extract<LabAssertion, { kind: 'connectivity' }> = {
      kind: 'connectivity',
      from: 'R1',
      to: 'PC4',
      expect: 'success',
      after: [{ cut: { a: 'R1', b: 'R2', aPort: 'Gi0/0' } }],
      settleMs: 5000,
    };
    const got = verdicts(sim, [
      /* 0 */ { kind: 'neighbor', device: 'R1', protocol: 'eigrp', neighbor: 'R3', state: 'up' },
      /* 1 */ { kind: 'route', device: 'R1', destination: '10.4.0.10', network: '10.4.0.0/24', source: 'EIGRP', nextHop: '10.0.12.2', metric: 3328 },
      /* 2 */ { kind: 'fact', device: 'R1', fact: 'eigrp.feasibleSuccessor', subject: '10.4.0.0/24', equals: 'R3' },
      /* 3 */ cut,
      /* 4 */ { kind: 'fact', device: 'R1', fact: 'eigrp.successor', subject: '10.4.0.0/24', equals: 'R2' },
      /* 5 */ { kind: 'fact', device: 'R1', fact: 'eigrp.fd', subject: '10.4.0.0/24', equals: 3328 },
      /* 6 */ { kind: 'fact', device: 'R1', fact: 'eigrp.feasibleSuccessor', subject: '10.4.0.0/24', equals: 'R2' },
      /* 7 */ { ...cut, expect: 'fail' },
      /* 8 */ { kind: 'route', device: 'R1', destination: '10.4.0.10', source: 'EIGRP', nextHop: '10.0.13.3' },
    ]);
    expect(got.slice(0, 6)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(got[6]).toBeDefined();
    expect(got[7]).toBeDefined();
    expect(got[8]).toBeDefined();
    expect(fingerprint()).toBe(before);
  });
});
