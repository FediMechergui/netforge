/**
 * ospf.self-war-bounded — rule 19 with a router id shared by two routers that are NOT neighbours (W5 fix, the ospf
 * report): lab 07's first design, where R3 started OSPF with R1's id 1.1.1.1 instead of its neighbour R2's. Once R1
 * and R2 peer, R1 and R3 re-originate their router LSA over each other's; every round re-armed the non-periodic
 * flooding and SPF work, and `runToIdle` ran 200 000 events over ~9 simulated hours without returning. Since the fix
 * (protocols/ospf.ts OSPF_SELF_WAR_MAX_COPIES) a router stops re-originating an LSA it keeps losing, so the war drains:
 * `runToIdle` returns, an hour later it still does, the conflict is logged once per router, and a grader clone of the
 * world settles.
 */
import { describe, expect, it } from 'vitest';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { OSPF_SELF_WAR_MAX_COPIES } from '../src/protocols/ospf.js';
import { LAB_CLONE_BOOT_EVENTS } from '../src/sim/lab-checks.js';
import { ccna3TroubleshootOspf as lab } from '../src/sim/scenarios/ccna3/ospf.js';
import { createSimulation } from '../src/sim/simulation.js';

const WAR = "OSPF process 1: another router also uses router ID 1.1.1.1; its link-state advertisements keep replacing this router's own.";

/** Lab 07's world with R3's hidden router id changed to R1's (1.1.1.1), booted, then R1's and R2's repairs typed. */
function sharedIdWorld(): Simulation {
  const sim = createSimulation({ seed: lab.seed ?? 1, traceCapacity: 1_000_000 });
  sim.loadTopology({ ...lab.build(), lab: { name: lab.name, version: 1 } });
  for (const f of lab.faults ?? []) {
    const lines = (f.fault.params as { lines: string[] }).lines.map((l) => l.replace('router-id 2.2.2.2', 'router-id 1.1.1.1'));
    sim.injectFault(f.at, { ...f.fault, params: { lines } });
  }
  sim.runFor(90 * SEC);
  expect(sim.runToIdle(200_000).stopped).toBeUndefined();
  for (const name of ['R1', 'R2']) {
    const id = sim.devices().find((d) => d.spec.name === name)!.id;
    expect(sim.configure(id, lab.solution?.[name] ?? []).ok).toBe(true);
  }
  return sim;
}

const logsOf = (evs: readonly TraceEvent[], d: string): string[] =>
  evs.filter((e) => e.kind === 'log' && e.device === d && e.facility === 'OSPF').map((e) => (e as { message: string }).message);

describe('ospf: a router id shared by two routers that are not neighbours (rule 19)', () => {
  it('the LSA war drains: runToIdle returns, and still returns an hour later; the conflict is logged once per router', () => {
    expect(OSPF_SELF_WAR_MAX_COPIES).toBe(8);
    const sim = sharedIdWorld();
    const idle = sim.runToIdle(200_000);
    expect(idle.stopped).toBeUndefined();
    expect(idle.events).toBeLessThan(5_000);
    const hour = sim.runFor(3600 * SEC);
    expect(hour.events).toBeLessThan(20_000);
    expect(sim.runToIdle(200_000).stopped).toBeUndefined();
    const all = sim.trace(0).events;
    expect(logsOf(all, 'r1').filter((m) => m === WAR)).toHaveLength(1);
    expect(logsOf(all, 'r3').filter((m) => m === WAR)).toHaveLength(1);
  }, 120_000);

  it('a grader clone of that world settles within its event cap', () => {
    const sim = sharedIdWorld();
    sim.runToIdle(200_000);
    const clone = createSimulation({ seed: lab.seed ?? 1 });
    clone.loadTopology(sim.exportTopology());
    expect(clone.runToIdle(LAB_CLONE_BOOT_EVENTS).stopped).toBeUndefined();
  }, 120_000);
});
