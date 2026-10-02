/**
 * sim.device-configure — the configure seam end to end (ARCHITECTURE-P3 D21, §2.4, §2.7, §3.0 (c), §3.8; §7 W2 sim,
 * moved from W1): the REAL device runtime's `configure` action, issued by a daemon, through the Simulation's W1
 * `deviceConfigure` handler (sim/configure.ts), on `staged.world`.
 *
 * A stand-in daemon (it replaces `hsrp` on an NF-2911) issues the action and records what it receives. Pinned:
 *   • the action is never applied inline: the runtime schedules ONE non-periodic `deviceConfigure` event at now, and
 *     only that event's own dispatch runs the lines (privilege 15, the console grammar) and answers `config.result`
 *     with the issuer's token;
 *   • every `configChange` of the run carries the action's `origin` (a typed line carries none);
 *   • never nested: a configure issued while handling `config.result` is a new event, run in a later dispatch;
 *   • a 60-line atomic configure runs within the action budget (no `action-budget` drop) and answers once;
 *   • an atomic run with a failing line reverts every line and still answers, the revert's changes carrying the origin;
 *   • `runToIdle` waits for the event (live work), and nothing is journaled by the run.
 */
import { describe, expect, it } from 'vitest';
import type { Action, ConfigOrigin, Process } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import type { ProcessEvent } from '../src/contracts/transport.js';
import { createStagedSimulation } from './staged.world.js';

const ORIGIN: ConfigOrigin = { via: 'restconf', user: 'admin', address: '192.168.1.10' };
type ConfigResultEvent = Extract<ProcessEvent, { kind: 'config.result' }>;

/** A stand-in daemon that records the events it receives; `react` may return actions for a `config.result`. */
function issuer(seen: ProcessEvent[], react?: (ev: ConfigResultEvent) => Action[]): Process {
  return {
    name: 'hsrp',
    onPdu: () => [],
    onTimer: () => [],
    onConfig: () => [],
    onEvent: (_ctx, ev) => {
      seen.push(ev);
      return ev.kind === 'config.result' && react !== undefined ? react(ev) : [];
    },
    stateSnapshot: () => ({ process: 'hsrp', state: {} }),
    debugEvents: () => [],
  };
}

/** One booted NF-2911 whose `hsrp` daemon is the stand-in, with a trace recorder. */
function world(react?: (ev: ConfigResultEvent) => Action[]) {
  const seen: ProcessEvent[] = [];
  const sim = createStagedSimulation({ seed: 9, stage: 'P2', factories: { hsrp: () => issuer(seen, react) } });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
  sim.runFor(60 * SEC);
  sim.runToIdle();
  const trace: TraceEvent[] = [];
  sim.onTrace((ev) => trace.push(ev));
  return { sim, seen, trace, dev: sim.device('r1')! };
}

const configure = (token: string, lines: readonly string[], extra: { atomic?: boolean; indentation?: boolean } = {}): Action => ({
  type: 'configure',
  token,
  lines,
  origin: ORIGIN,
  ...extra,
});

const hostname = (sim: Simulation): string[] => sim.device('r1')!.running.query('hostname').map((n) => n.args.join(' '));
const results = (seen: readonly ProcessEvent[]): ConfigResultEvent[] => seen.filter((e): e is ConfigResultEvent => e.kind === 'config.result');

describe('deviceConfigure through the real runtime and the Simulation', () => {
  it('is scheduled at now and run in its own dispatch; configChange carries the origin; config.result answers', () => {
    const { sim, seen, trace, dev } = world();
    const journaled = sim.journal().entries.length;
    const before = sim.position().dispatched;
    const pending = sim.snapshot().pendingEvents;
    dev.applyActions('hsrp', [configure('t-1', ['hostname EDGE', 'interface GigabitEthernet0/0', ' description to the API'], { indentation: true })], sim.now);
    // nothing ran inline: one more pending event, the old hostname, no answer yet
    expect(sim.snapshot().pendingEvents).toBe(pending + 1);
    expect(hostname(sim)).toEqual(['R1']);
    expect(results(seen)).toEqual([]);
    expect(trace.filter((e) => e.kind === 'configChange')).toEqual([]);

    const ev = sim.step();
    expect(ev?.kind).toBe('deviceConfigure');
    expect(sim.position().dispatched).toBe(before + 1);
    expect(hostname(sim)).toEqual(['EDGE']);
    const answers = results(seen);
    expect(answers).toHaveLength(1);
    expect(answers[0]!.token).toBe('t-1');
    expect(answers[0]!.result.ok).toBe(true);
    expect(answers[0]!.result.lines.map((l) => l.ok)).toEqual([true, true, true]);
    const changes = trace.filter((e): e is Extract<TraceEvent, { kind: 'configChange' }> => e.kind === 'configChange');
    expect(changes.length).toBeGreaterThan(0);
    for (const c of changes) expect(c.origin, c.line).toEqual(ORIGIN);
    expect(changes.map((c) => c.line)).toContain('hostname EDGE');
    // the run is a consequence of replayed events: nothing new was journaled
    expect(sim.journal().entries).toHaveLength(journaled);

    // a typed line carries no origin
    trace.length = 0;
    const s = sim.cli.open('r1', 'console');
    for (const line of ['enable', 'configure terminal', 'hostname TYPED']) sim.cli.exec(s, line);
    const typed = trace.filter((e): e is Extract<TraceEvent, { kind: 'configChange' }> => e.kind === 'configChange');
    expect(typed.map((c) => c.line)).toEqual(['hostname TYPED']);
    expect(typed[0]).not.toHaveProperty('origin');
  });

  it('never nests: a configure issued while handling config.result runs in a later dispatch', () => {
    let issued = false;
    const { sim, seen, dev } = world((ev) => {
      if (ev.token !== 'first' || issued) return [];
      issued = true;
      return [configure('second', ['hostname SECOND'])];
    });
    dev.applyActions('hsrp', [configure('first', ['hostname FIRST'])], sim.now);
    sim.step();
    expect(results(seen).map((e) => e.token)).toEqual(['first']);
    expect(hostname(sim)).toEqual(['FIRST']); // the second run has not happened inside the first one
    const ev = sim.step();
    expect(ev?.kind).toBe('deviceConfigure');
    expect(hostname(sim)).toEqual(['SECOND']);
    expect(results(seen).map((e) => e.token)).toEqual(['first', 'second']);
  });

  it('a 60-line atomic configure runs within the action budget and answers once', () => {
    const { sim, seen, trace, dev } = world();
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) lines.push(`interface Loopback${i}`, ` description loopback number ${i}`);
    expect(lines).toHaveLength(60);
    dev.applyActions('hsrp', [configure('bulk', lines, { atomic: true, indentation: true })], sim.now);
    const stats = sim.runToIdle();
    expect(stats.stopped).toBeUndefined();
    const answers = results(seen);
    expect(answers).toHaveLength(1);
    expect(answers[0]!.result.ok).toBe(true);
    expect(answers[0]!.result.lines).toHaveLength(60);
    expect(answers[0]!.result.reverted).toBeUndefined();
    expect(dev.port('Loopback30')).toBeDefined();
    expect(trace.some((e) => e.kind === 'drop' && e.detail === 'action-budget')).toBe(false);
    // one configChange per stored line (entering an interface section stores nothing by itself), each with the origin
    const changes = trace.filter((e): e is Extract<TraceEvent, { kind: 'configChange' }> => e.kind === 'configChange');
    expect(changes.map((c) => c.line)).toEqual(lines.filter((l) => l.startsWith(' ')).map((l) => l.trim()));
    expect(changes.every((c) => c.origin !== undefined && c.origin.via === 'restconf')).toBe(true);
    expect(answers[0]!.result.applied).toBeGreaterThanOrEqual(changes.length);
  });

  it('an atomic run with a failing line reverts every line, still answers, and the revert carries the origin', () => {
    const { sim, seen, trace, dev } = world();
    dev.applyActions('hsrp', [configure('bad', ['hostname OTHER', 'interface NoSuchPort9/9', ' description x'], { atomic: true, indentation: true })], sim.now);
    sim.runToIdle();
    expect(hostname(sim)).toEqual(['R1']);
    const answers = results(seen);
    expect(answers).toHaveLength(1);
    expect(answers[0]!.token).toBe('bad');
    expect(answers[0]!.result.ok).toBe(false);
    expect(answers[0]!.result.reverted).toBe(true);
    const changes = trace.filter((e): e is Extract<TraceEvent, { kind: 'configChange' }> => e.kind === 'configChange');
    expect(changes.length).toBeGreaterThanOrEqual(2); // set, then the revert
    for (const c of changes) expect(c.origin).toEqual(ORIGIN);
  });

  it('runToIdle waits for the event; a powered-off device gets no run and no answer', () => {
    const { sim, seen, dev } = world();
    dev.applyActions('hsrp', [configure('idle', ['hostname IDLE'])], sim.now);
    const stats = sim.runToIdle();
    expect(stats.events).toBeGreaterThanOrEqual(1);
    expect(hostname(sim)).toEqual(['IDLE']);
    expect(results(seen).map((e) => e.token)).toEqual(['idle']);

    dev.applyActions('hsrp', [configure('late', ['hostname LATE'])], sim.now);
    sim.setPower('r1', false);
    sim.runToIdle();
    expect(results(seen).map((e) => e.token)).toEqual(['idle']);
  });
});
