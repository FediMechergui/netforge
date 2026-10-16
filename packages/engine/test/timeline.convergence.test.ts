/**
 * P3c W1a sim [S8] — `measureConvergence` (timeline/convergence.ts; ARCHITECTURE-P3C §2.10, ruling R-13): what counts
 * as a change, when a protocol has settled, and the `only`, `devices`, `quietMs`, `to` and `firstCursor` options, over
 * hand-built trace events. The end-to-end measurement in a fault clone is `accept.p3c.convergence` (W4a).
 */
import { describe, expect, it } from 'vitest';
import type { FsmMachine } from '../src/contracts/process.js';
import type { TableName } from '../src/contracts/tables.js';
import { MS, SEC, type SimTime } from '../src/contracts/time.js';
import { CONVERGENCE_QUIET_MS } from '../src/contracts/timeline.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { measureConvergence } from '../src/timeline/convergence.js';

const T: SimTime = 100 * SEC;
const ROUTING_QUIET: SimTime = CONVERGENCE_QUIET_MS.routing * MS;

const write = (t: SimTime, table: string, key: string, row: Record<string, unknown>, previous?: Record<string, unknown>, device = 'r1'): TraceEvent =>
  ({ t, kind: 'tableWrite', device, table: table as TableName, key, row, ...(previous === undefined ? {} : { previous }) }) as TraceEvent;
const expire = (t: SimTime, table: string, key: string, row: Record<string, unknown>, device = 'r1'): TraceEvent =>
  ({ t, kind: 'tableExpire', device, table: table as TableName, key, row, reason: 'gone' }) as TraceEvent;
const fsm = (t: SimTime, machine: string, subject: string, device = 'r1'): TraceEvent =>
  ({
    t,
    kind: 'debug',
    event: { at: t, device, process: 'ospf', category: 'x', message: 'm', fsm: { machine: machine as FsmMachine, subject, from: 'a', to: 'b' } },
  }) as TraceEvent;
const plainDebug = (t: SimTime): TraceEvent => ({ t, kind: 'debug', event: { at: t, device: 'r1', process: 'ospf', category: 'x', message: 'm' } }) as TraceEvent;
const port = (t: SimTime): TraceEvent => ({ t, kind: 'portState', device: 'r1', port: 'p', adminUp: true, operUp: false }) as TraceEvent;
const config = (t: SimTime): TraceEvent => ({ t, kind: 'configChange', device: 'r1', line: 'x', negate: false, context: [] }) as TraceEvent;

describe('timeline/convergence [S8]: measureConvergence', () => {
  it('a direct cut: the rib rows move at T + 5 s, then nothing; settled there', () => {
    const evs = [port(T), write(T + 5 * SEC, 'rib', '10.0.0.0/24', { source: 'O', nextHop: '10.0.12.2' }, { source: 'O', nextHop: '10.0.13.3' })];
    const r = measureConvergence(evs, { protocol: 'routing', from: T, to: T + 120 * SEC });
    expect(r).toEqual({
      protocol: 'routing',
      from: T,
      settledAt: T + 5 * SEC,
      durationNs: 5 * SEC,
      changes: 1,
      last: { cursor: 1, device: 'r1', subject: 'rib:10.0.0.0/24' },
    });
  });

  it('settles at the first change followed by a full quiet period; later changes are not part of it', () => {
    const late = T + 3 * SEC + ROUTING_QUIET;
    const evs = [
      fsm(T + SEC, 'ospf-nbr', '2.2.2.2'),
      write(T + 3 * SEC, 'ospf-lsdb', 'k', { seq: 2 }, { seq: 1 }),
      write(late, 'ospf-lsdb', 'k', { seq: 3 }, { seq: 2 }),
    ];
    const r = measureConvergence(evs, { protocol: 'routing', from: T, to: late + 60 * SEC });
    expect(r.settledAt).toBe(T + 3 * SEC);
    expect(r.changes).toBe(2);
    expect(r.last).toEqual({ cursor: 1, device: 'r1', subject: 'ospf-lsdb:k' });
    // one ns less of quiet and the next change still belongs to the burst
    const close = measureConvergence([evs[0]!, evs[1]!, write(late - 1, 'ospf-lsdb', 'k', { seq: 3 }, { seq: 2 })], { protocol: 'routing', from: T, to: late + 60 * SEC });
    expect(close.settledAt).toBe(late - 1);
    expect(close.changes).toBe(3);
  });

  it('a window that ends before a quiet period follows the last change gives null', () => {
    const evs = [write(T + 50 * SEC, 'rib', 'a', { source: 'O' })];
    const r = measureConvergence(evs, { protocol: 'routing', from: T, to: T + 50 * SEC + ROUTING_QUIET - 1 });
    expect(r).toEqual({ protocol: 'routing', from: T, settledAt: null, durationNs: null, changes: 1, last: { cursor: 0, device: 'r1', subject: 'rib:a' } });
    expect(measureConvergence(evs, { protocol: 'routing', from: T, to: T + 50 * SEC + ROUTING_QUIET }).settledAt).toBe(T + 50 * SEC);
  });

  it('no change at all: settled at the fault instant once the window covers a quiet period', () => {
    expect(measureConvergence([port(T)], { protocol: 'routing', from: T, to: T + ROUTING_QUIET })).toEqual({
      protocol: 'routing',
      from: T,
      settledAt: T,
      durationNs: 0,
      changes: 0,
    });
    expect(measureConvergence([], { protocol: 'routing', from: T, to: T + ROUTING_QUIET - 1 }).settledAt).toBeNull();
  });

  it('counts only state changes in the protocol lanes, at or after the fault', () => {
    const evs = [
      write(T - 1, 'rib', 'before', { source: 'O' }), // before the fault
      write(T + SEC, 'rib', 'refresh', { source: 'O', updatedAt: 2 }, { source: 'O', updatedAt: 1 }), // volatile only
      write(T + SEC, 'cam', 'mac', { port: 'p' }), // no lane
      write(T + SEC, 'stp', 'v1', { role: 'root' }), // another lane
      plainDebug(T + SEC), // no fsm
      fsm(T + SEC, 'stp-port', 'Gi0/1'), // another lane
      port(T + 2 * SEC),
      config(T + 2 * SEC),
    ];
    expect(measureConvergence(evs, { protocol: 'routing', from: T, to: T + 60 * SEC }).changes).toBe(0);
    const stp = measureConvergence(evs, { protocol: 'stp', from: T, to: T + 60 * SEC });
    expect(stp.changes).toBe(2);
    expect(stp.settledAt).toBe(T + SEC);
    expect(stp.last?.subject).toBe('stp-port:Gi0/1');
    // a write without `previous` and an expiry are changes
    const r = measureConvergence([write(T + SEC, 'rib', 'new', { source: 'O' }), expire(T + 2 * SEC, 'rib6', 'old', { source: 'O' })], { protocol: 'routing', from: T, to: T + 60 * SEC });
    expect(r.changes).toBe(2);
    expect(r.last?.subject).toBe('rib6:old');
  });

  it('`only` narrows the routing lane to one daemon, its tables and the rib rows it owns', () => {
    const evs = [
      write(T + 1 * SEC, 'eigrp-topology', 'e', { x: 1 }),
      fsm(T + 2 * SEC, 'eigrp-nbr', '10.0.0.2'),
      write(T + 3 * SEC, 'rib', 'eigrp', { source: 'EIGRP' }),
      write(T + 4 * SEC, 'rib', 'static', { source: 'S' }),
      write(T + 5 * SEC, 'rib', 'was-ospf', { source: 'S' }, { source: 'O' }),
      fsm(T + 6 * SEC, 'ospf6-if', 'Gi0/0'),
      write(T + 7 * SEC, 'ospf-neighbors', 'n', { state: 'full' }),
    ];
    const ospf = measureConvergence(evs, { protocol: 'routing', from: T, to: T + 60 * SEC, only: 'ospf' });
    expect(ospf.changes).toBe(3);
    expect(ospf.settledAt).toBe(T + 7 * SEC);
    const eigrp = measureConvergence(evs, { protocol: 'routing', from: T, to: T + 60 * SEC, only: 'eigrp' });
    expect(eigrp.changes).toBe(3);
    expect(eigrp.settledAt).toBe(T + 3 * SEC);
    expect(measureConvergence(evs, { protocol: 'routing', from: T, to: T + 60 * SEC }).changes).toBe(7);
  });

  it('`devices`, `quietMs`, the default window end and `firstCursor`', () => {
    const evs = [write(T + SEC, 'rib', 'a', { source: 'O' }, undefined, 'r2'), write(T + 2 * SEC, 'rib', 'b', { source: 'O' }), port(T + 30 * SEC)];
    const r1 = measureConvergence(evs, { protocol: 'routing', from: T, devices: ['r1'], quietMs: 5_000, firstCursor: 40 });
    // the default end is the last event's instant (T + 30 s), past T + 2 s + 5 s
    expect(r1).toEqual({ protocol: 'routing', from: T, settledAt: T + 2 * SEC, durationNs: 2 * SEC, changes: 1, last: { cursor: 41, device: 'r1', subject: 'rib:b' } });
    // with the routing default of 12 s the gap of 1 s does not settle at T + 1 s
    const both = measureConvergence(evs, { protocol: 'routing', from: T });
    expect(both.settledAt).toBe(T + 2 * SEC);
    expect(both.changes).toBe(2);
  });

  it('is pure: the same events give the same result', () => {
    const evs = [fsm(T + SEC, 'ospf-nbr', 'x'), write(T + 2 * SEC, 'rib', 'a', { source: 'O' })];
    const opts = { protocol: 'routing', from: T, to: T + 60 * SEC } as const;
    expect(JSON.stringify(measureConvergence(evs, opts))).toBe(JSON.stringify(measureConvergence(evs, opts)));
  });
});
