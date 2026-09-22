/**
 * sim — the world's defaults profile (ARCHITECTURE-P2 D2, §2.9, §7 W1 sim) and the tracked scheduler's `dispatched`
 * count (§2.13 `JournalPosition.dispatched`).
 *
 * `SimulationOptions.profile` (default 'P1') is the profile of the initial world; `Simulation.profile` reads it; every
 * device the world builds gets it as `DeviceSpec.profile`, written only when it is not 'P1' (optional by meaning), so a
 * P1 world is byte-identical to one built before P2. Loading a topology with a profile is the W2 sim item and is not
 * pinned here.
 */
import { describe, expect, it } from 'vitest';
import type { DefaultsProfile } from '../src/contracts/catalog.js';
import type { SimEventBody } from '../src/contracts/events.js';
import { SEC } from '../src/contracts/time.js';
import { twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { createRunControl, createTrackedScheduler } from '../src/sim/run-control.js';
import { createSimulation } from '../src/sim/simulation.js';
import { createTraceRing } from '../src/trace/ring.js';

/** Load the P0 two-PC template, ping once, and return the trace and snapshot bytes. */
function run(profile: DefaultsProfile | undefined): { trace: string; snapshot: string } {
  const sim = createSimulation(profile === undefined ? { seed: 7 } : { seed: 7, profile });
  sim.loadTopology(twoPcsAndSwitch());
  sim.runFor(40 * SEC);
  const s = sim.cli.open('pc1', 'console');
  sim.cli.exec(s, 'ping 10.0.0.2');
  sim.runFor(10 * SEC);
  return { trace: JSON.stringify(sim.trace(0).events), snapshot: JSON.stringify(sim.snapshot()) };
}

describe('Simulation.profile', () => {
  it("defaults to 'P1'; P1 devices carry no profile in their spec", () => {
    const sim = createSimulation({ seed: 1 });
    expect(sim.profile).toBe('P1');
    const pc = sim.addDevice({ type: 'pc.nfpc' });
    expect('profile' in sim.device(pc)!.spec).toBe(false);
    const explicit = createSimulation({ seed: 1, profile: 'P1' });
    expect(explicit.profile).toBe('P1');
    expect('profile' in explicit.device(explicit.addDevice({ type: 'switch.nfc2960' }))!.spec).toBe(false);
  });

  it("a P2 world reports 'P2' and plumbs it into every device it builds", () => {
    const sim = createSimulation({ seed: 1, profile: 'P2' });
    expect(sim.profile).toBe('P2');
    const sw = sim.addDevice({ type: 'switch.nfc2960' });
    const r = sim.addDevice({ type: 'router.nf2911', name: 'R1' });
    expect(sim.device(sw)!.spec.profile).toBe('P2');
    expect(sim.device(r)!.spec.profile).toBe('P2');
  });

  it('refuses an unknown profile before anything is built', () => {
    expect(() => createSimulation({ seed: 1, profile: 'P3' as DefaultsProfile })).toThrow(new RangeError('profile must be one of P1, P2, got P3'));
  });

  it('a loaded P1 document in a P1 world stays P1 and its devices carry no profile', () => {
    const sim = createSimulation({ seed: 1 });
    sim.loadTopology(twoPcsAndSwitch());
    expect(sim.profile).toBe('P1');
    for (const dev of sim.devices()) expect('profile' in dev.spec).toBe(false);
  });

  it('naming the P1 profile changes no byte of trace or snapshot', () => {
    const implicit = run(undefined);
    const explicit = run('P1');
    expect(explicit.trace).toBe(implicit.trace);
    expect(explicit.snapshot).toBe(implicit.snapshot);
    expect(implicit.trace.length).toBeGreaterThan(1000);
  });
});

describe('TrackedScheduler.dispatched', () => {
  const tick = (key: string): Extract<SimEventBody, { kind: 'timer' }> => ({ kind: 'timer', device: 'd1', process: 'p', key });

  it('counts the events next() hands out, never cancelled ones or empty pops', () => {
    const s = createTrackedScheduler();
    expect(s.dispatched).toBe(0);
    s.schedule(10, tick('a'));
    const b = s.schedule(20, tick('b'));
    s.schedule(30, { ...tick('c'), periodic: true });
    expect(s.cancel(b)).toBe(true);
    expect(s.dispatched).toBe(0);
    expect(s.next()?.at).toBe(10);
    expect(s.dispatched).toBe(1);
    expect(s.next()?.at).toBe(30);
    expect(s.dispatched).toBe(2);
    expect(s.next()).toBeUndefined();
    expect(s.dispatched).toBe(2);
    expect(s.size).toBe(0);
  });

  it('equals the run loop event counts, and maxEvents stops at an exact position', () => {
    const s = createTrackedScheduler();
    for (let i = 1; i <= 10; i++) s.schedule(i * 100, tick(`t${i}`));
    const seen: number[] = [];
    const ring = createTraceRing(16);
    const run = createRunControl({ scheduler: () => s, dispatch: (ev) => seen.push(ev.at), trace: ring, tap: () => () => undefined });
    const a = run.runUntil(1000, { maxEvents: 3 });
    expect(a.events).toBe(3);
    expect(s.dispatched).toBe(3);
    expect(s.now).toBe(300);
    run.step();
    expect(s.dispatched).toBe(4);
    const b = run.runToIdle(100);
    expect(s.dispatched).toBe(4 + b.events);
    expect(s.dispatched).toBe(10);
    expect(seen).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
  });

  it('a fresh world starts a fresh count, and the same inputs give the same count', () => {
    const count = (): number => {
      const s = createTrackedScheduler();
      s.schedule(5, tick('x'));
      s.schedule(5, tick('y'));
      s.next();
      return s.dispatched;
    };
    expect(count()).toBe(1);
    expect(count()).toBe(1);
  });
});
