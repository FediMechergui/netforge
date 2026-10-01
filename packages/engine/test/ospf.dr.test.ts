// protocols/ospf/{dr,ism} (ARCHITECTURE-P3 D9, §3.1 steps 3, 4, 7 and 8; RFC 2328 §9.3, §9.4, §10.4, §10.5; §7 W1 ospf):
// the DR election with its step-4 rerun, BackupSeen and NeighborChange from hellos, the interface state machine, and
// §3.1 played through the pure pieces: R1 Waiting → DROther → Backup, R2 DR, a late higher router id stays DROther,
// a priority-0 router is never DR or BDR, and the BDR takes over when the DR dies.
import { describe, expect, it } from 'vitest';
import type { OspfIsmState } from '../src/contracts/tables.js';
import {
  drEventsFromHello,
  electDesignatedRouter,
  ospfAdjacencyOk,
  OSPF_NO_DR,
  type OspfDrCandidate,
  type OspfDrElection,
} from '../src/protocols/ospf/dr.js';
import { ismOutcome, OSPF_ISM_EVENT_NAMES, type OspfIsmEvent } from '../src/protocols/ospf/ism.js';

const A1 = '10.0.123.1';
const A2 = '10.0.123.2';
const A3 = '10.0.123.3';
const cand = (routerId: string, address: string, dr = OSPF_NO_DR, bdr = OSPF_NO_DR, priority = 1): OspfDrCandidate => ({ routerId, address, priority, dr, bdr });

/** The interface state of one router as the pure pieces drive it. */
class Iface {
  state: OspfIsmState = 'down';
  dr = OSPF_NO_DR;
  bdr = OSPF_NO_DR;
  readonly states: OspfIsmState[] = [];
  readonly elections: OspfDrElection[] = [];
  constructor(readonly routerId: string, readonly address: string, readonly priority = 1) {}
  self(): OspfDrCandidate {
    return cand(this.routerId, this.address, this.dr, this.bdr, this.priority);
  }
  event(e: OspfIsmEvent, neighbours: readonly OspfDrCandidate[] = []): void {
    const o = ismOutcome(this.state, e, { networkType: 'broadcast', priority: this.priority });
    if (o.kind === 'none') return;
    if (o.kind === 'goto') {
      this.go(o.to);
      return;
    }
    const r = electDesignatedRouter(this.self(), neighbours);
    this.elections.push(r);
    this.dr = r.dr;
    this.bdr = r.bdr;
    this.go(r.state);
  }
  private go(to: OspfIsmState): void {
    if (to === this.state) return;
    this.state = to;
    this.states.push(to);
  }
}

describe('ospf/dr: the election (RFC 2328 §9.4)', () => {
  it('§3.1 step 4 at the wait expiry: R2 computes DR = BDR = itself, reruns, and ends DR with R1 as BDR', () => {
    const r = electDesignatedRouter(cand('2.2.2.2', A2), [cand('1.1.1.1', A1)]);
    expect(r).toEqual({ dr: A2, drRouterId: '2.2.2.2', bdr: A1, bdrRouterId: '1.1.1.1', state: 'dr', reran: true });
  });

  it('§3.1 step 4 at the wait expiry: R1 computes DR = BDR = R2 and, being neither, does not rerun', () => {
    const r = electDesignatedRouter(cand('1.1.1.1', A1), [cand('2.2.2.2', A2)]);
    expect(r).toEqual({ dr: A2, drRouterId: '2.2.2.2', bdr: A2, bdrRouterId: '2.2.2.2', state: 'drother', reran: false });
  });

  it('§3.1 step 4 on R2’s declaring hello: R1 reruns and becomes BDR; R2’s next election changes nothing', () => {
    const r1 = electDesignatedRouter(cand('1.1.1.1', A1, A2, A2), [cand('2.2.2.2', A2, A2, A1)]);
    expect(r1).toEqual({ dr: A2, drRouterId: '2.2.2.2', bdr: A1, bdrRouterId: '1.1.1.1', state: 'backup', reran: true });
    const r2 = electDesignatedRouter(cand('2.2.2.2', A2, A2, A1), [cand('1.1.1.1', A1, A2, A1)]);
    expect(r2).toEqual({ dr: A2, drRouterId: '2.2.2.2', bdr: A1, bdrRouterId: '1.1.1.1', state: 'dr', reran: false });
  });

  it('priority 0: never DR or BDR, as a neighbour or as the calculating router', () => {
    const zero = electDesignatedRouter(cand('9.9.9.9', '10.0.0.9', OSPF_NO_DR, OSPF_NO_DR, 0), [cand('1.1.1.1', '10.0.0.1')]);
    expect(zero).toMatchObject({ dr: '10.0.0.1', bdr: '10.0.0.1', state: 'drother' });
    const withZero = electDesignatedRouter(cand('1.1.1.1', '10.0.0.1'), [cand('9.9.9.9', '10.0.0.9', OSPF_NO_DR, OSPF_NO_DR, 0)]);
    expect(withZero).toMatchObject({ dr: '10.0.0.1', bdr: OSPF_NO_DR, state: 'dr' });
    expect(withZero.bdrRouterId).toBeUndefined();
    // a priority-0 router declaring itself DR is not a candidate either
    const declared = electDesignatedRouter(cand('1.1.1.1', '10.0.0.1'), [cand('9.9.9.9', '10.0.0.9', '10.0.0.9', OSPF_NO_DR, 0)]);
    expect(declared).toMatchObject({ dr: '10.0.0.1', state: 'dr' });
    const none = electDesignatedRouter(cand('1.1.1.1', '10.0.0.1', OSPF_NO_DR, OSPF_NO_DR, 0), [cand('2.2.2.2', '10.0.0.2', OSPF_NO_DR, OSPF_NO_DR, 0)]);
    expect(none).toEqual({ dr: OSPF_NO_DR, bdr: OSPF_NO_DR, state: 'drother', reran: false });
  });

  it('the best candidate is the highest priority, then the highest router id as u32', () => {
    const byPriority = electDesignatedRouter(cand('1.1.1.1', '10.0.0.1', OSPF_NO_DR, OSPF_NO_DR, 5), [cand('9.9.9.9', '10.0.0.9')]);
    expect(byPriority).toMatchObject({ drRouterId: '1.1.1.1', bdrRouterId: '9.9.9.9', state: 'dr' });
    // 10.0.0.1 > 9.0.0.1 as numbers, although '10…' < '9…' as text
    const byId = electDesignatedRouter(cand('10.0.0.1', '10.0.0.10'), [cand('9.0.0.1', '10.0.0.9')]);
    expect(byId).toMatchObject({ drRouterId: '10.0.0.1', bdrRouterId: '9.0.0.1', state: 'dr', reran: true });
    expect(electDesignatedRouter(cand('9.0.0.1', '10.0.0.9'), [cand('10.0.0.1', '10.0.0.10')])).toMatchObject({ drRouterId: '10.0.0.1', bdrRouterId: '10.0.0.1', state: 'drother' });
  });

  it('non-preemptive: a later higher router id finds the DR and BDR declaring themselves and stays DROther', () => {
    const r3 = electDesignatedRouter(cand('3.3.3.3', A3), [cand('1.1.1.1', A1, A2, A1), cand('2.2.2.2', A2, A2, A1)]);
    expect(r3).toEqual({ dr: A2, drRouterId: '2.2.2.2', bdr: A1, bdrRouterId: '1.1.1.1', state: 'drother', reran: false });
    // R1's reply alone (R2 not yet 2-Way): DR = BDR = R1 for a moment, corrected on R2's reply (§3.1 step 7)
    expect(electDesignatedRouter(cand('3.3.3.3', A3), [cand('1.1.1.1', A1, A2, A1)])).toMatchObject({ dr: A1, bdr: A1, state: 'drother' });
    // even with a higher priority, a DR and a BDR in place keep their roles
    expect(electDesignatedRouter(cand('3.3.3.3', A3, OSPF_NO_DR, OSPF_NO_DR, 200), [cand('1.1.1.1', A1, A2, A1), cand('2.2.2.2', A2, A2, A1)]))
      .toMatchObject({ dr: A2, bdr: A1, state: 'drother' });
  });

  it('§3.1 step 8: when the DR dies, the BDR becomes DR and the DROther becomes BDR', () => {
    const r1 = electDesignatedRouter(cand('1.1.1.1', A1, A2, A1), [cand('3.3.3.3', A3, A2, A1)]);
    expect(r1).toEqual({ dr: A1, drRouterId: '1.1.1.1', bdr: A3, bdrRouterId: '3.3.3.3', state: 'dr', reran: true });
    // R3 at its own dead timer sees DR = BDR = R1 until R1's hello declares the new pair …
    expect(electDesignatedRouter(cand('3.3.3.3', A3, A2, A1), [cand('1.1.1.1', A1, A2, A1)])).toMatchObject({ dr: A1, bdr: A1, state: 'drother', reran: false });
    // … which makes it BDR
    const r3 = electDesignatedRouter(cand('3.3.3.3', A3, A1, A1), [cand('1.1.1.1', A1, A1, A3)]);
    expect(r3).toEqual({ dr: A1, drRouterId: '1.1.1.1', bdr: A3, bdrRouterId: '3.3.3.3', state: 'backup', reran: true });
  });
});

describe('ospf/dr: interface events from hellos (RFC 2328 §10.5)', () => {
  it('BackupSeen from a neighbour declaring itself BDR while Waiting', () => {
    expect(drEventsFromHello('waiting', undefined, { address: A1, dr: A2, bdr: A1, priority: 1 })).toEqual(['backup-seen']);
    expect(drEventsFromHello('waiting', { dr: A2, bdr: A1, priority: 1 }, { address: A1, dr: A2, bdr: A1, priority: 1 })).toEqual(['backup-seen']);
  });

  it('not from one declaring itself DR with a BDR present: that is a NeighborChange (ignored while Waiting)', () => {
    expect(drEventsFromHello('waiting', undefined, { address: A2, dr: A2, bdr: A1, priority: 1 })).toEqual(['neighbor-change']);
    expect(ismOutcome('waiting', 'neighbor-change', { networkType: 'broadcast', priority: 1 })).toEqual({ kind: 'none' });
  });

  it('a DR declaring itself with no BDR is BackupSeen while Waiting', () => {
    expect(drEventsFromHello('waiting', undefined, { address: A2, dr: A2, bdr: OSPF_NO_DR, priority: 1 })).toEqual(['backup-seen']);
    expect(drEventsFromHello('drother', undefined, { address: A2, dr: A2, bdr: OSPF_NO_DR, priority: 1 })).toEqual(['neighbor-change']);
  });

  it('starting or stopping a declaration, or a priority change, is a NeighborChange; nothing else is', () => {
    const before = { dr: A2, bdr: A1, priority: 1 };
    expect(drEventsFromHello('backup', before, { address: A2, dr: A2, bdr: A1, priority: 1 })).toEqual([]);
    expect(drEventsFromHello('dr', { dr: A2, bdr: A2, priority: 1 }, { address: A1, dr: A2, bdr: A1, priority: 1 })).toEqual(['neighbor-change']);
    expect(drEventsFromHello('backup', before, { address: A2, dr: A1, bdr: A1, priority: 1 })).toEqual(['neighbor-change']);
    expect(drEventsFromHello('drother', { dr: A2, bdr: A1, priority: 1 }, { address: A3, dr: A2, bdr: A1, priority: 7 })).toEqual(['neighbor-change']);
    // a new neighbour's priority is not a change; one declaring nothing schedules nothing
    expect(drEventsFromHello('drother', undefined, { address: A3, dr: A2, bdr: A1, priority: 7 })).toEqual([]);
    expect(drEventsFromHello('waiting', undefined, { address: A3, dr: OSPF_NO_DR, bdr: OSPF_NO_DR, priority: 1 })).toEqual([]);
    // both declarations change at once: one event
    expect(drEventsFromHello('dr', { dr: A2, bdr: A1, priority: 1 }, { address: A1, dr: A1, bdr: OSPF_NO_DR, priority: 1 })).toEqual(['neighbor-change']);
  });
});

describe('ospf/ism: the interface state machine (RFC 2328 §9.3)', () => {
  const b = { networkType: 'broadcast' as const, priority: 1 };
  it('InterfaceUp by network type and priority', () => {
    expect(ismOutcome('down', 'interface-up', b)).toEqual({ kind: 'goto', to: 'waiting', startWait: true });
    expect(ismOutcome('down', 'interface-up', { ...b, priority: 0 })).toEqual({ kind: 'goto', to: 'drother' });
    expect(ismOutcome('down', 'interface-up', { networkType: 'point-to-point', priority: 1 })).toEqual({ kind: 'goto', to: 'point-to-point' });
    expect(ismOutcome('down', 'interface-up', { networkType: 'loopback', priority: 1 })).toEqual({ kind: 'goto', to: 'loopback' });
    expect(ismOutcome('waiting', 'interface-up', b)).toEqual({ kind: 'none' });
  });

  it('the election runs on WaitTimer and BackupSeen while Waiting, and on NeighborChange once elected', () => {
    const all: OspfIsmState[] = ['down', 'loopback', 'waiting', 'point-to-point', 'drother', 'backup', 'dr'];
    const elects = (e: OspfIsmEvent): OspfIsmState[] => all.filter((s) => ismOutcome(s, e, b).kind === 'elect');
    expect(elects('wait-timer')).toEqual(['waiting']);
    expect(elects('backup-seen')).toEqual(['waiting']);
    expect(elects('neighbor-change')).toEqual(['drother', 'backup', 'dr']);
    expect(elects('interface-up')).toEqual([]);
  });

  it('InterfaceDown, LoopInd and UnloopInd', () => {
    for (const s of ['loopback', 'waiting', 'point-to-point', 'drother', 'backup', 'dr'] as const) {
      expect(ismOutcome(s, 'interface-down', b)).toEqual({ kind: 'goto', to: 'down' });
    }
    expect(ismOutcome('down', 'interface-down', b)).toEqual({ kind: 'none' });
    expect(ismOutcome('dr', 'loop-ind', b)).toEqual({ kind: 'goto', to: 'loopback' });
    expect(ismOutcome('loopback', 'unloop-ind', b)).toEqual({ kind: 'goto', to: 'down' });
    expect(ismOutcome('loopback', 'unloop-ind', { networkType: 'loopback', priority: 1 })).toEqual({ kind: 'none' });
    expect(ismOutcome('dr', 'unloop-ind', b)).toEqual({ kind: 'none' });
    expect(Object.values(OSPF_ISM_EVENT_NAMES)).toEqual(['InterfaceUp', 'WaitTimer', 'BackupSeen', 'NeighborChange', 'LoopInd', 'UnloopInd', 'InterfaceDown']);
  });
});

describe('ospf/dr: §3.1 played through the pure pieces', () => {
  it('R1: Waiting → DROther (wait expiry) → Backup (R2’s declaring hello); R2: Waiting → DR', () => {
    const r1 = new Iface('1.1.1.1', A1);
    const r2 = new Iface('2.2.2.2', A2);
    r1.event('interface-up');
    r2.event('interface-up');
    expect([r1.state, r2.state]).toEqual(['waiting', 'waiting']);
    // U + 1 s: the hello replies declare nothing: no BackupSeen, no NeighborChange
    expect(drEventsFromHello(r1.state, undefined, { address: A2, dr: OSPF_NO_DR, bdr: OSPF_NO_DR, priority: 1 })).toEqual([]);
    // U + 40 s: both wait timers (whatever order the hellos and timers run in, no declaring hello has arrived yet)
    r2.event('wait-timer', [r1.self()]);
    r1.event('wait-timer', [cand('2.2.2.2', A2)]);
    expect([r2.state, r2.dr, r2.bdr]).toEqual(['dr', A2, A1]);
    expect([r1.state, r1.dr, r1.bdr]).toEqual(['drother', A2, A2]);
    // R2's triggered hello declares DR A2, BDR A1: a NeighborChange at R1, whose election makes it Backup
    const events = drEventsFromHello(r1.state, { dr: OSPF_NO_DR, bdr: OSPF_NO_DR, priority: 1 }, { address: A2, dr: r2.dr, bdr: r2.bdr, priority: 1 });
    expect(events).toEqual(['neighbor-change']);
    for (const e of events) r1.event(e, [r2.self()]);
    expect([r1.state, r1.dr, r1.bdr]).toEqual(['backup', A2, A1]);
    expect(r1.states).toEqual(['waiting', 'drother', 'backup']);
    expect(r1.elections.map((x) => x.reran)).toEqual([false, true]);
    // R1's hello declaring itself BDR is a NeighborChange at R2 whose election changes nothing
    const back = drEventsFromHello(r2.state, { dr: A2, bdr: A2, priority: 1 }, { address: A1, dr: r1.dr, bdr: r1.bdr, priority: 1 });
    expect(back).toEqual(['neighbor-change']);
    for (const e of back) r2.event(e, [r1.self()]);
    expect([r2.state, r2.dr, r2.bdr]).toEqual(['dr', A2, A1]);
    expect(r2.states).toEqual(['waiting', 'dr']);
    // adjacencies: both are DR or BDR
    expect(ospfAdjacencyOk('broadcast', { address: A1, dr: r1.dr, bdr: r1.bdr }, A2)).toBe(true);
  });

  it('R3 joins at U + 65 s: BackupSeen from R1’s reply, DROther, adjacent to the DR and BDR only', () => {
    const r3 = new Iface('3.3.3.3', A3);
    r3.event('interface-up');
    const r1Reply = { address: A1, dr: A2, bdr: A1, priority: 1 };
    const r2Reply = { address: A2, dr: A2, bdr: A1, priority: 1 };
    // R1's reply first
    const seen = drEventsFromHello(r3.state, undefined, r1Reply);
    expect(seen).toEqual(['backup-seen']);
    for (const e of seen) r3.event(e, [cand('1.1.1.1', A1, A2, A1)]);
    expect([r3.state, r3.dr, r3.bdr]).toEqual(['drother', A1, A1]);
    for (const e of drEventsFromHello(r3.state, undefined, r2Reply)) r3.event(e, [cand('1.1.1.1', A1, A2, A1), cand('2.2.2.2', A2, A2, A1)]);
    expect([r3.state, r3.dr, r3.bdr]).toEqual(['drother', A2, A1]);
    // R2's reply first: not BackupSeen, R3 keeps waiting until R1's reply
    const other = new Iface('3.3.3.3', A3);
    other.event('interface-up');
    for (const e of drEventsFromHello(other.state, undefined, r2Reply)) other.event(e, [cand('2.2.2.2', A2, A2, A1)]);
    expect(other.state).toBe('waiting');
    for (const e of drEventsFromHello(other.state, undefined, r1Reply)) other.event(e, [cand('2.2.2.2', A2, A2, A1), cand('1.1.1.1', A1, A2, A1)]);
    expect([other.state, other.dr, other.bdr]).toEqual(['drother', A2, A1]);
    // R3 forms adjacencies with the DR and the BDR; two DROthers stay 2-Way
    const view = { address: A3, dr: A2, bdr: A1 };
    expect([ospfAdjacencyOk('broadcast', view, A2), ospfAdjacencyOk('broadcast', view, A1), ospfAdjacencyOk('broadcast', view, '10.0.123.4')]).toEqual([true, true, false]);
    expect(ospfAdjacencyOk('point-to-point', { address: A3, dr: OSPF_NO_DR, bdr: OSPF_NO_DR }, A1)).toBe(true);
    expect(ospfAdjacencyOk('loopback', view, A1)).toBe(false);
  });

  it('a priority-0 router goes straight to DROther and stays there', () => {
    const r = new Iface('9.9.9.9', '10.0.123.9', 0);
    r.event('interface-up');
    expect(r.state).toBe('drother');
    r.event('neighbor-change', [cand('1.1.1.1', A1, A2, A1), cand('2.2.2.2', A2, A2, A1)]);
    expect([r.state, r.dr, r.bdr]).toEqual(['drother', A2, A1]);
    r.event('neighbor-change', [cand('1.1.1.1', A1, A2, A1)]);
    expect([r.state, r.dr, r.bdr]).toEqual(['drother', A1, A1]);
  });
});
