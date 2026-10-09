/**
 * [C1] eigrp at the scheduler (ARCHITECTURE-P3 §4.3 "eigrp: silent in P1/P2", ruling R50; the W4b fix step, finding 5):
 * an unconfigured eigrp arms no timer. `ip routing` and `no ip routing` are EIGRP lines (they start or stop a configured
 * process), but while no `router eigrp` section is stored they schedule nothing — the P2 profile's `no ip routing`
 * replay on a multilayer switch and a learner's `ip routing` on a router used to arm an idle `resync` in worlds that
 * never configure EIGRP. With the section stored the same lines still start and stop the process.
 */
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../src/contracts/events.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { createSimulation } from '../src/sim/simulation.js';

/** Step to `t` one event at a time, returning the eigrp events dispatched on the way (time, device, timer key). */
function eigrpEventsUntil(sim: Simulation, t: number): string[] {
  const out: string[] = [];
  for (let next = sim.nextEventTime(); next !== undefined && next <= t; next = sim.nextEventTime()) {
    const e: SimEvent | undefined = sim.step();
    if (e === undefined) break;
    if (e.kind === 'timer' && e.process === 'eigrp') out.push(`${e.at / SEC}s ${e.device} ${e.key}`);
  }
  sim.runUntil(t);
  return out;
}

describe('eigrp arms no timer while unconfigured (R50)', () => {
  it('the P2 profile replay of `no ip routing` on a multilayer switch, then `ip routing`: no eigrp event', () => {
    const sim = createSimulation({ seed: 1, profile: 'P2' });
    sim.addDevice({ id: 'mls1', type: 'mlswitch.nfc3650-24', name: 'MLS1' });
    expect(sim.device('mls1')!.model.processes).toContain('eigrp');
    expect(eigrpEventsUntil(sim, 90 * SEC)).toEqual([]);
    expect(sim.configure('mls1', ['ip routing']).ok).toBe(true);
    expect(sim.configure('mls1', ['no ip routing']).ok).toBe(true);
    expect(eigrpEventsUntil(sim, 120 * SEC)).toEqual([]);
  });

  it('`ip routing` typed on a router in a P1 world: no eigrp event', () => {
    const sim = createSimulation({ seed: 1, profile: 'P1' });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
    expect(eigrpEventsUntil(sim, 60 * SEC)).toEqual([]);
    expect(sim.configure('r1', ['ip routing', 'no ip routing', 'ip routing']).ok).toBe(true);
    expect(eigrpEventsUntil(sim, 90 * SEC)).toEqual([]);
  });

  it('with `router eigrp` stored the process still starts, and `no ip routing` / `ip routing` still stop and restart it', () => {
    const sim = createSimulation({ seed: 1, profile: 'P3' });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
    eigrpEventsUntil(sim, 60 * SEC);
    expect(sim.configure('r1', ['router eigrp 10', 'network 10.0.0.0 0.255.255.255']).ok).toBe(true);
    const started = eigrpEventsUntil(sim, 61 * SEC);
    expect(started.filter((k) => k.endsWith(' resync')).length).toBeGreaterThan(0);
    expect(sim.configure('r1', ['no ip routing']).ok).toBe(true);
    expect(eigrpEventsUntil(sim, 62 * SEC).filter((k) => k.endsWith(' resync'))).toEqual(['61s r1 resync']);
    expect(sim.configure('r1', ['ip routing']).ok).toBe(true);
    expect(eigrpEventsUntil(sim, 63 * SEC).filter((k) => k.endsWith(' resync'))).toEqual(['62s r1 resync']);
  });
});
