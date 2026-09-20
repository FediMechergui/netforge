/**
 * Determinism (G4, spec §12.5): the same seed and inputs give byte-identical traces and snapshots.
 */
import { describe, expect, it } from 'vitest';
import { SEC } from '../src/contracts/time.js';
import { pcRouterPc } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';

function runOnce(lossy: boolean): { trace: string; snapshot: string; linkLoss: number } {
  const sim = createSimulation({ seed: 20260914 });
  sim.loadTopology(pcRouterPc());
  if (lossy) sim.setImpairments('l_r1_pc2', { lossPct: 30 });
  sim.runFor(60 * SEC);
  const session = sim.cli.open('pc1', 'console');
  sim.cli.exec(session, 'ping 10.0.1.1');
  sim.runToIdle();
  const events = sim.trace(0).events;
  return {
    trace: JSON.stringify(events),
    snapshot: JSON.stringify(sim.snapshot()),
    linkLoss: events.filter((e) => e.kind === 'drop' && e.reason === 'link-loss').length,
  };
}

describe('sim/determinism', () => {
  it('three runs of pcRouterPc with the same seed match byte for byte', () => {
    const runs = [runOnce(false), runOnce(false), runOnce(false)];
    expect(runs[0]!.trace.length).toBeGreaterThan(1000);
    expect(runs[1]!.trace).toBe(runs[0]!.trace);
    expect(runs[2]!.trace).toBe(runs[0]!.trace);
    expect(runs[1]!.snapshot).toBe(runs[0]!.snapshot);
    expect(runs[2]!.snapshot).toBe(runs[0]!.snapshot);
  });

  it('stays identical with 30% loss on a link, and loss really happens', () => {
    const runs = [runOnce(true), runOnce(true), runOnce(true)];
    expect(runs[0]!.linkLoss).toBeGreaterThan(0);
    expect(runs[1]!.trace).toBe(runs[0]!.trace);
    expect(runs[2]!.trace).toBe(runs[0]!.trace);
    expect(runs[1]!.snapshot).toBe(runs[0]!.snapshot);
    expect(runs[2]!.snapshot).toBe(runs[0]!.snapshot);
    expect(runs[0]!.trace).not.toBe(runOnce(false).trace);
  });
});
