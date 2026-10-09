/**
 * P3 acceptance — OSPF adjacency and DR election on a LAN (ARCHITECTURE-P3 §10.1 `accept.p3.ospf-dr-election`; §3.1,
 * D9, §4.2, §4.5; RFC 2328 §9.4, §10.4, §10.5, §13.3; §7 W4 qa).
 *
 * §3.1's world: SW1 (NF-C2960, PortFast on Fa0/1–4) with R1, R2, R3 (NF-2911) Gi0/0 on Fa0/1–3, 10.0.123.n/24, router
 * ids n.n.n.n, priority 1, `network 10.0.123.0 0.0.0.255 area 0`. R1's and R2's cables are plugged in at U (their
 * `linkState up`), R3's at U + 65 s. Pinned:
 *   • R2 DR at U + 40 s ± 10 ms; R1's `ospf-if` transitions exactly waiting → drother (U + 40 s) → backup (less than
 *     1 ms later, on R2's DR-declaring hello), with exactly one hello from each router after each change of its (DR, BDR)
 *     pair, WHICHEVER of `hello` and `wait` the scheduler runs first: the world is run twice, once in the scheduler's
 *     own order (the `wait` armed at U runs before the `hello` re-armed at U + 30 s, so the periodic hello carries the
 *     new pair) and once with each `wait:<if>` arming moved behind the hello re-arm that lands on the same instant (so
 *     the periodic hello runs first and the DR-change hello of D9 carries the new pair) — the outcome is the same;
 *   • DR 2.2.2.2, BDR 1.1.1.1; Full at U + 40 s + ε; the first SPF with the LAN at U + 45 s + ε;
 *   • R3 (the higher router id) at U + 65 s is DROTHER through BackupSeen from R1's hello reply, Full with the DR and
 *     the BDR at U + 66 s + ε; `show ip ospf neighbor` on R3 and R1;
 *   • the network-LSA only from the DR; a non-DR's own LSU goes to 224.0.0.6 and the BDR re-floods nothing it received;
 *   • DR failover: R2 powered off at T, R1 (the former BDR) DR in [T + 30 s, T + 40 s], R3 BDR;
 *   • a priority-0 router (R4 with the highest router id) is never DR or BDR, even when the DR and then the BDR fail;
 *     DROthers are 2WAY with each other.
 * Worlds: `staged.world` at stage P3 with the flip's daemons (ospf.accept.harness.ts).
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId, LinkId } from '../src/contracts/ids.js';
import type { Action, Process, ProcessCtx, ProcessFactory } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC, type SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createOspf } from '../src/protocols/ospf.js';
import { linkUpAt, showLines, traceSince } from './ospf.accept.harness.js';
import { addRouter, cursor, debugLines, fsmOf, GI0, iface, ifRow, lsdbRows, MS_NS, nbrRows, ospfCreated, ospfView, startup } from './ospf.harness.js';
import { createStagedSimulation } from './staged.world.js';

type Order = 'scheduler' | 'hello-first';

/**
 * createOspf with each `wait:<if>` timer armed again (same key, same due time) right after the `hello:<if>` re-arm
 * that lands on or after it: re-arming a key replaces the scheduled event with a new, later sequence number, so at the
 * wait expiry the periodic hello runs FIRST. The wait stays armed throughout (so `runToIdle` still waits for it); the
 * daemon's own logic is untouched, only the scheduler's tie order of the two timers changes.
 */
function helloFirstOspf(): ProcessFactory {
  return (): Process => {
    const p = createOspf();
    const held = new Map<string, SimTime>();
    const fix = (ctx: ProcessCtx, acts: Action[]): Action[] => {
      const out: Action[] = [];
      for (const a of acts) {
        if (a.type === 'timer' && a.key.startsWith('wait:')) held.set(a.key.slice('wait:'.length), ctx.now + a.delay);
        if (a.type === 'cancelTimer' && a.key.startsWith('wait:')) held.delete(a.key.slice('wait:'.length));
        out.push(a);
        if (a.type === 'timer' && a.key.startsWith('hello:')) {
          const port = a.key.slice('hello:'.length);
          const due = held.get(port);
          if (due !== undefined && ctx.now + a.delay >= due) {
            held.delete(port);
            out.push({ type: 'timer', key: `wait:${port}`, delay: due - ctx.now });
          }
        }
      }
      return out;
    };
    const wrap =
      <A extends unknown[]>(fn: (ctx: ProcessCtx, ...rest: A) => Action[]) =>
      (ctx: ProcessCtx, ...rest: A): Action[] =>
        fix(ctx, fn(ctx, ...rest));
    return {
      ...p,
      init: p.init === undefined ? undefined : wrap(p.init.bind(p)),
      onPdu: wrap(p.onPdu.bind(p)),
      onTimer: wrap(p.onTimer.bind(p)),
      onConfig: wrap(p.onConfig.bind(p)),
      onLinkChange: p.onLinkChange === undefined ? undefined : wrap(p.onLinkChange.bind(p)),
      onRequest: p.onRequest === undefined ? undefined : wrap(p.onRequest.bind(p)),
      onEvent: p.onEvent === undefined ? undefined : wrap(p.onEvent.bind(p)),
    };
  };
}

interface Lan {
  readonly sim: Simulation;
  /** The cable of router n (1-based) to SW1, once plugged in. */
  readonly links: Map<number, LinkId>;
  readonly plug: (n: number) => LinkId;
}

/** §3.1's world with `routers` routers (priorities by router, default 1); every router's cable still unplugged. */
function lan(seed: number, order: Order, priorities: readonly number[] = [1, 1, 1], routers = 3): Lan {
  const factories = order === 'hello-first' ? { ospf: helloFirstOspf() } : {};
  const sim = createStagedSimulation({ seed, stage: 'P3', factories });
  sim.addDevice({
    id: 'sw1',
    type: 'switch.nfc2960',
    name: 'SW1',
    startupConfig: startup([['hostname SW1'], ...[1, 2, 3, 4].map((k) => [`interface FastEthernet0/${k}`, ' spanning-tree portfast'])]),
  });
  for (let n = 1; n <= routers; n++) {
    const pri = priorities[n - 1] ?? 1;
    addRouter(sim, `r${n}`, `R${n}`, [
      iface(GI0, `10.0.123.${n}`, '255.255.255.0', pri === 1 ? [] : [`ip ospf priority ${pri}`]),
      ['router ospf 1', ` router-id ${n}.${n}.${n}.${n}`, ' network 10.0.123.0 0.0.0.255 area 0'],
    ]);
  }
  sim.runFor(90 * SEC);
  const links = new Map<number, LinkId>();
  const plug = (n: number): LinkId => {
    const id = sim.addLink({ a: { device: `r${n}`, port: GI0 }, b: { device: 'sw1', port: `FastEthernet0/${n}` } });
    links.set(n, id);
    return id;
  };
  return { sim, links, plug };
}

/** The index in `evs` of the `ospf-if` transition of `device` to `to` (the first after index `from`). */
function ifChangeAt(evs: readonly TraceEvent[], device: DeviceId, to: string, from = 0): number {
  return evs.findIndex((e, k) => k >= from && e.kind === 'debug' && e.event.device === device && e.event.fsm?.machine === 'ospf-if' && e.event.fsm.to === to);
}

/** Hellos `device` created at trace indices in [from, to): their declared pair and the debug reason. */
function hellosBetween(evs: readonly TraceEvent[], device: DeviceId, from: number, to: number): { pair: string; why: string }[] {
  const out: { pair: string; why: string }[] = [];
  let why = '';
  for (let k = from; k < to; k++) {
    const e = evs[k]!;
    if (e.kind === 'debug' && e.event.device === device && e.event.category === 'ip ospf hello' && e.event.message.includes('hello sent')) {
      why = /hello sent \(([^)]*)\)/.exec(e.event.message)![1]!;
    }
    if (e.kind === 'pduCreated' && e.device === device && e.process === 'ospf' && e.pdu.tag === 'ospf-hello') {
      out.push({ pair: e.pdu.summary.slice(e.pdu.summary.indexOf(', DR ') + 2), why });
    }
  }
  return out;
}

/** The PduId of the last OSPF hello `device` received before trace index `before`. */
function lastHelloRx(evs: readonly TraceEvent[], device: DeviceId, before: number): number {
  for (let k = before - 1; k >= 0; k--) {
    const e = evs[k]!;
    if (e.kind === 'frameRx' && e.device === device && e.pdu.summary.startsWith('OSPF hello')) return e.pdu.id;
  }
  throw new Error(`no hello received by ${device}`);
}

/** A hello's sender router id and its declared DR and BDR. */
function helloFields(sim: Simulation, pdu: number): unknown[] {
  const ospf = sim.pdu(pdu)!.layers.find((l) => l.proto === 'ospf')!;
  return [ospf.fields.routerId, ospf.fields.dr, ospf.fields.bdr];
}

/** Index of the first event at or after time `t`. */
const indexAt = (evs: readonly TraceEvent[], t: SimTime): number => {
  const k = evs.findIndex((e) => e.t >= t);
  return k === -1 ? evs.length : k;
};

describe.each(['scheduler', 'hello-first'] as const)('accept.p3.ospf-dr-election: §3.1 steps 1–6 (%s order at the wait expiry)', (order) => {
  it('R2 DR at U + 40 s; R1 waiting → drother → backup within 1 ms; one hello per (DR, BDR) change; Full; the first SPF with the LAN at U + 45 s + ε', () => {
    const { sim, plug } = lan(31, order);
    const c = cursor(sim);
    const l1 = plug(1);
    const l2 = plug(2);
    expect(sim.runToIdle().stopped).toBeUndefined();
    const evs = traceSince(sim, c);
    const U = linkUpAt(evs, l1);
    expect(linkUpAt(evs, l2)).toBe(U);
    // R2: Waiting at U, DR at U + 40 s
    const r2if = fsmOf(evs, 'r2', 'ospf-if', GI0);
    expect(r2if.map((f) => `${f.from}>${f.to}:${f.cause}`)).toEqual(['down>waiting:InterfaceUp', 'waiting>dr:WaitTimer']);
    expect(r2if[0]!.t).toBe(U);
    expect(Math.abs(r2if[1]!.t - (U + 40 * SEC))).toBeLessThanOrEqual(10 * MS_NS);
    // R1: exactly waiting → drother (U + 40 s) → backup (less than 1 ms later)
    const r1if = fsmOf(evs, 'r1', 'ospf-if', GI0);
    expect(r1if.map((f) => `${f.from}>${f.to}:${f.cause}`)).toEqual(['down>waiting:InterfaceUp', 'waiting>drother:WaitTimer', 'drother>backup:NeighborChange']);
    expect(r1if[1]!.t).toBe(U + 40 * SEC);
    expect(r1if[2]!.t - r1if[1]!.t).toBeGreaterThan(0);
    expect(r1if[2]!.t - r1if[1]!.t).toBeLessThan(MS_NS);
    // R1's backup came from R2's DR-declaring hello
    expect(helloFields(sim, lastHelloRx(evs, 'r1', ifChangeAt(evs, 'r1', 'backup')))).toEqual(['2.2.2.2', '10.0.123.2', '10.0.123.1']);
    // exactly one hello from each router after each change of its (DR, BDR) pair, before the next periodic one
    const end = indexAt(evs, U + 41 * SEC);
    const r2dr = ifChangeAt(evs, 'r2', 'dr');
    const r1drother = ifChangeAt(evs, 'r1', 'drother');
    const r1backup = ifChangeAt(evs, 'r1', 'backup');
    const r2after = hellosBetween(evs, 'r2', r2dr, end);
    const r1first = hellosBetween(evs, 'r1', r1drother, r1backup);
    const r1second = hellosBetween(evs, 'r1', r1backup, end);
    expect(r2after.map((h) => h.pair)).toEqual(['DR 10.0.123.2, BDR 10.0.123.1']);
    expect(r1first.map((h) => h.pair)).toEqual(['DR 10.0.123.2, BDR 10.0.123.2']);
    expect(r1second.map((h) => h.pair)).toEqual(['DR 10.0.123.2, BDR 10.0.123.1']);
    // which branch of D9 carried the new pair: the periodic hello when it runs after the election, else dr-hello
    const viaWait = order === 'scheduler' ? 'periodic' : 'DR or BDR changed';
    expect([r2after[0]!.why, r1first[0]!.why]).toEqual([viaWait, viaWait]);
    expect(r1second[0]!.why).toBe('DR or BDR changed');
    // in the hello-first order the periodic hello left just before the election, still declaring no DR
    const atWait = hellosBetween(evs, 'r2', indexAt(evs, U + 40 * SEC), r2dr);
    expect(atWait.map((h) => [h.pair, h.why])).toEqual(order === 'scheduler' ? [] : [['DR 0.0.0.0, BDR 0.0.0.0', 'periodic']]);
    // R1's elections, in the debug: both runs, ending with the final one
    expect(debugLines(evs, 'r1', 'ip ospf adj').filter((l) => l.message.includes('election')).map((l) => l.message)).toEqual([
      'GigabitEthernet0/0 election: DR 2.2.2.2 (10.0.123.2), BDR 2.2.2.2 (10.0.123.2)',
      'GigabitEthernet0/0 election: DR 2.2.2.2 (10.0.123.2), BDR 1.1.1.1 (10.0.123.1)',
    ]);
    // DR 2.2.2.2, BDR 1.1.1.1 on both routers
    for (const d of ['r1', 'r2']) expect(ifRow(sim, d, GI0)).toMatchObject({ dr: '2.2.2.2', drAddress: '10.0.123.2', bdr: '1.1.1.1', bdrAddress: '10.0.123.1', neighbors: 1, adjacent: 1 });
    expect(ifRow(sim, 'r1', GI0)!.state).toBe('backup');
    expect(ifRow(sim, 'r2', GI0)!.state).toBe('dr');
    // ExStart at U + 40 s, Full at U + 40 s + ε
    for (const [d, peer] of [['r1', '2.2.2.2'], ['r2', '1.1.1.1']] as const) {
      const nbr = fsmOf(evs, d, 'ospf-nbr', `${GI0} ${peer}`);
      expect(nbr.find((f) => f.to === 'exstart')!.t).toBe(U + 40 * SEC);
      const full = nbr.find((f) => f.to === 'full')!;
      expect(full.t - (U + 40 * SEC)).toBeGreaterThan(0);
      expect(full.t - (U + 40 * SEC)).toBeLessThan(10 * MS_NS);
    }
    // the first SPF with the LAN at U + 45 s + ε: R1 → N 10.0.123.2 → R2
    for (const d of ['r1', 'r2']) {
      const runs = debugLines(evs, d, 'ip ospf spf').filter((l) => l.message.startsWith('SPF run') && l.t > U + 40 * SEC);
      expect(runs[0]!.t - (U + 45 * SEC)).toBeGreaterThan(0);
      expect(runs[0]!.t - (U + 45 * SEC)).toBeLessThan(10 * MS_NS);
      expect(runs[0]!.message).toMatch(/: 3 vertices, /);
    }
    expect(ospfView(sim, 'r1').trees[0]!.tree.vertices.map((v) => v.key)).toEqual(['R:1.1.1.1', 'N:10.0.123.2', 'R:2.2.2.2']);
  });

  it('R3 (the highest router id) joins at U + 65 s: DROTHER through BackupSeen from R1’s reply, Full with the DR and the BDR at U + 66 s + ε', () => {
    const { sim, plug } = lan(32, order);
    const c = cursor(sim);
    const l1 = plug(1);
    plug(2);
    sim.runFor(SEC);
    const U = linkUpAt(traceSince(sim, c), l1);
    sim.runUntil(U + 65 * SEC);
    const c3 = cursor(sim);
    const l3 = plug(3);
    expect(sim.runToIdle().stopped).toBeUndefined();
    const evs = traceSince(sim, c3);
    expect(linkUpAt(evs, l3)).toBe(U + 65 * SEC);
    const r3if = fsmOf(evs, 'r3', 'ospf-if', GI0);
    expect(r3if.map((f) => `${f.from}>${f.to}:${f.cause}`)).toEqual(['down>waiting:InterfaceUp', 'waiting>drother:BackupSeen']);
    expect(r3if[1]!.t - (U + 66 * SEC)).toBeGreaterThanOrEqual(0);
    expect(r3if[1]!.t - (U + 66 * SEC)).toBeLessThan(10 * MS_NS);
    // the BackupSeen came from R1's hello reply (R1 declares itself BDR)
    expect(helloFields(sim, lastHelloRx(evs, 'r3', ifChangeAt(evs, 'r3', 'drother')))).toEqual(['1.1.1.1', '10.0.123.2', '10.0.123.1']);
    expect(ifRow(sim, 'r3', GI0)).toMatchObject({ state: 'drother', dr: '2.2.2.2', bdr: '1.1.1.1', neighbors: 2, adjacent: 2 });
    // Full with the DR and the BDR at U + 66 s + ε
    for (const peer of ['2.2.2.2', '1.1.1.1']) {
      const full = fsmOf(evs, 'r3', 'ospf-nbr', `${GI0} ${peer}`).find((f) => f.to === 'full')!;
      expect(full.t - (U + 66 * SEC)).toBeGreaterThan(0);
      expect(full.t - (U + 66 * SEC)).toBeLessThan(10 * MS_NS);
    }
    const nbr = (d: string) => showLines(sim, d, 'show ip ospf neighbor').slice(1).filter((l) => l.trim() !== '').map((l) => l.split(/ +/).slice(0, 3).join(' '));
    expect(nbr('r3').sort()).toEqual(['1.1.1.1 1 FULL/BDR', '2.2.2.2 1 FULL/DR']);
    expect(nbr('r1').sort()).toEqual(['2.2.2.2 1 FULL/DR', '3.3.3.3 1 FULL/DROTHER']);
    // the DR adds 3.3.3.3 to its network-LSA
    expect(lsdbRows(sim, 'r3').filter((r) => r.type === 2).map((r) => [r.lsid, r.advRouter, r.attached])).toEqual([['10.0.123.2', '2.2.2.2', ['2.2.2.2', '1.1.1.1', '3.3.3.3']]]);
  });
});

describe('accept.p3.ospf-dr-election: flooding, failover and priority 0', () => {
  it('the network-LSA only from the DR; a non-DR’s own LSU goes to 224.0.0.6; the BDR re-floods nothing it received; DR failover in [T + 30 s, T + 40 s] with the former BDR as DR', () => {
    const { sim, plug } = lan(33, 'scheduler');
    const c = cursor(sim);
    const l1 = plug(1);
    plug(2);
    sim.runFor(SEC);
    const U = linkUpAt(traceSince(sim, c), l1);
    sim.runUntil(U + 65 * SEC);
    plug(3);
    expect(sim.runToIdle().stopped).toBeUndefined();
    const evs = traceSince(sim, c);
    // the network-LSA: only the DR originates it; every database holds only the DR's
    for (const d of ['r1', 'r2', 'r3']) {
      expect(lsdbRows(sim, d).filter((r) => r.type === 2).map((r) => [r.advRouter, r.self])).toEqual([['2.2.2.2', d === 'r2']]);
    }
    const type2Writers = evs.filter((e) => e.kind === 'tableWrite' && e.table === 'ospf-lsdb' && e.row.type === 2 && e.row.self === true).map((e) => (e as { device: string }).device);
    expect(new Set(type2Writers)).toEqual(new Set(['r2']));
    // LSUs: who sent what to which group
    const lsus = ospfCreated(evs).filter((p) => p.kind === 'lsu');
    const advOf = (pdu: number): string[] => sim.pdu(pdu)!.layers.filter((l) => l.proto === 'ospf-lsa').map((l) => String(l.fields.advRouter));
    for (const [d, rid] of [['r1', '1.1.1.1'], ['r3', '3.3.3.3']] as const) {
      const multicast = lsus.filter((p) => p.device === d && p.dst.startsWith('224.'));
      expect(multicast.length).toBeGreaterThan(0);
      // a non-DR floods only its own LSAs, and only to AllDRouters
      for (const p of multicast) {
        expect(p.dst).toBe('224.0.0.6');
        expect(new Set(advOf(p.pdu))).toEqual(new Set([rid]));
      }
    }
    // the DR floods to AllSPFRouters and re-floods there R3's new router-LSA (which R1 needs, RFC 2328 §13.3); R1, the
    // BDR, only listens: no multicast update of R1 carries R3's LSA
    const drFloods = lsus.filter((p) => p.device === 'r2' && p.dst.startsWith('224.'));
    expect(new Set(drFloods.map((p) => p.dst))).toEqual(new Set(['224.0.0.5']));
    expect(drFloods.some((p) => advOf(p.pdu).includes('3.3.3.3'))).toBe(true);
    expect(lsus.some((p) => p.device === 'r1' && p.dst.startsWith('224.') && advOf(p.pdu).includes('3.3.3.3'))).toBe(false);

    // DR failure at T: R2 powered off; R1 (BDR) becomes DR within [T + 30 s, T + 40 s], R3 BDR
    sim.runFor(3 * SEC);
    const cf = cursor(sim);
    const T = sim.now;
    sim.setPower('r2', false);
    sim.runFor(60 * SEC);
    const fail = traceSince(sim, cf);
    const toDr = fsmOf(fail, 'r1', 'ospf-if', GI0);
    expect(toDr.map((f) => `${f.from}>${f.to}`)).toEqual(['backup>dr']);
    expect(toDr[0]!.t - T).toBeGreaterThanOrEqual(30 * SEC);
    expect(toDr[0]!.t - T).toBeLessThanOrEqual(40 * SEC);
    expect(fsmOf(fail, 'r1', 'ospf-nbr', `${GI0} 2.2.2.2`).find((f) => f.to === 'down')!.cause).toBe('InactivityTimer');
    expect(fsmOf(fail, 'r3', 'ospf-if', GI0).map((f) => `${f.from}>${f.to}`)).toEqual(['drother>backup']);
    expect(ifRow(sim, 'r1', GI0)).toMatchObject({ state: 'dr', dr: '1.1.1.1', bdr: '3.3.3.3' });
    expect(ifRow(sim, 'r3', GI0)).toMatchObject({ state: 'backup', dr: '1.1.1.1', bdr: '3.3.3.3' });
    expect(lsdbRows(sim, 'r3').filter((r) => r.type === 2 && r.advRouter === '1.1.1.1' && r.maxAge !== true).map((r) => [r.lsid, r.attached])).toEqual([['10.0.123.1', ['1.1.1.1', '3.3.3.3']]]);
  });

  it('a priority-0 router is never DR or BDR, even when the DR and then the BDR fail; DROthers are 2WAY with each other', () => {
    // R4 has the highest router id and priority 0
    const { sim, plug } = lan(34, 'scheduler', [1, 1, 1, 0], 4);
    const c = cursor(sim);
    for (const n of [1, 2, 3, 4]) plug(n);
    expect(sim.runToIdle().stopped).toBeUndefined();
    expect(ifRow(sim, 'r4', GI0)).toMatchObject({ state: 'drother', priority: 0, dr: '3.3.3.3', bdr: '2.2.2.2' });
    expect(ifRow(sim, 'r3', GI0)!.state).toBe('dr');
    expect(ifRow(sim, 'r2', GI0)!.state).toBe('backup');
    expect(ifRow(sim, 'r1', GI0)!.state).toBe('drother');
    // the two DROthers see each other 2-Way; each is Full with the DR and the BDR
    expect(nbrRows(sim, 'r1').map((r) => [r.routerId, r.state, r.role]).sort()).toEqual([['2.2.2.2', 'full', 'bdr'], ['3.3.3.3', 'full', 'dr'], ['4.4.4.4', '2way', 'drother']]);
    expect(nbrRows(sim, 'r4').map((r) => [r.routerId, r.state, r.role]).sort()).toEqual([['1.1.1.1', '2way', 'drother'], ['2.2.2.2', 'full', 'bdr'], ['3.3.3.3', 'full', 'dr']]);
    expect(showLines(sim, 'r1', 'show ip ospf neighbor').find((l) => l.startsWith('4.4.4.4 '))!.split(/ +/).slice(0, 3)).toEqual(['4.4.4.4', '0', '2WAY/DROTHER']);
    // the DR fails: R2 DR, R1 BDR; then the BDR fails too: R1 DR and no BDR — R4 never takes a role
    sim.setPower('r3', false);
    sim.runFor(60 * SEC);
    expect([ifRow(sim, 'r2', GI0)!.state, ifRow(sim, 'r1', GI0)!.state, ifRow(sim, 'r4', GI0)!.state]).toEqual(['dr', 'backup', 'drother']);
    sim.setPower('r2', false);
    sim.runFor(60 * SEC);
    expect(ifRow(sim, 'r1', GI0)).toMatchObject({ state: 'dr', dr: '1.1.1.1' });
    expect(ifRow(sim, 'r1', GI0)!.bdr).toBeUndefined();
    expect(ifRow(sim, 'r4', GI0)).toMatchObject({ state: 'drother', dr: '1.1.1.1' });
    const evs = traceSince(sim, c);
    // over the whole run: R4 never entered DR or Backup, no router ever named it DR or BDR, its hellos say priority 0
    expect(fsmOf(evs, 'r4', 'ospf-if').map((f) => f.to)).toEqual(['drother']);
    const named = evs.filter((e) => e.kind === 'tableWrite' && e.table === 'ospf-interfaces' && (e.row.dr === '4.4.4.4' || e.row.bdr === '4.4.4.4'));
    expect(named).toEqual([]);
    const r4hellos = ospfCreated(evs, 'r4').filter((p) => p.kind === 'hello');
    expect(r4hellos.length).toBeGreaterThan(0);
    for (const h of r4hellos) expect(sim.pdu(h.pdu)!.layers.find((l) => l.proto === 'ospf')!.fields.priority).toBe(0);
  });
});
