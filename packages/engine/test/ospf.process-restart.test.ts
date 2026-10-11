/**
 * ospf.process-restart — `no router ospf <pid>` destroys the running process at once (ARCHITECTURE-P3 D7: the router id
 * is chosen at process start; W5 fix, exposed by lab 07): a section removed and re-created in ONE instant (a paste, or
 * a paused simulation whose console does not advance the clock) restarts OSPF with the configured router id, exactly as
 * the same lines typed with simulated time between them, and the CLI does not claim the new id waits for
 * `clear ip ospf process`.
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES } from '../src/contracts/cli.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { GI0, addRouter, iface, nbrRows, ospfView, ospfWorld } from './ospf.harness.js';

const P2P = ['ip ospf network point-to-point'];

/** R1 (1.1.1.1) and R2 (2.2.2.2) on one point-to-point link, area 0, converged. */
function pair(): Simulation {
  const sim = ospfWorld(41);
  addRouter(sim, 'r1', 'R1', [iface(GI0, '10.0.12.1', '255.255.255.252', P2P), ['router ospf 1', ' router-id 1.1.1.1', ' network 10.0.12.0 0.0.0.3 area 0']]);
  addRouter(sim, 'r2', 'R2', [iface(GI0, '10.0.12.2', '255.255.255.252', P2P), ['router ospf 1', ' router-id 2.2.2.2', ' network 10.0.12.0 0.0.0.3 area 0']]);
  sim.addLink({ a: { device: 'r1', port: GI0 }, b: { device: 'r2', port: GI0 } });
  sim.runFor(100 * SEC);
  sim.runToIdle();
  return sim;
}

const RESTART = ['no router ospf 1', 'router ospf 1', 'router-id 9.9.9.9', 'network 10.0.12.0 0.0.0.3 area 0', 'end'];

describe('ospf: a process removed and re-created in one instant', () => {
  it('restarts with the configured router id, through configure', () => {
    const sim = pair();
    expect(ospfView(sim, 'r2').process?.routerId).toBe('2.2.2.2');
    const r = sim.configure('r2', RESTART);
    expect(r.ok).toBe(true);
    expect(r.lines.map((l) => l.output ?? '')).not.toContain(CLI_MESSAGES.ospfRouterIdLater);
    sim.runToIdle();
    expect(ospfView(sim, 'r2').process?.routerId).toBe('9.9.9.9');
    expect(nbrRows(sim, 'r1').map((n) => [n.routerId, n.state])).toEqual([['9.9.9.9', 'full']]);
  });

  it('gives the same id through a console session whose clock does not move between the lines', () => {
    const sim = pair();
    const s = sim.cli.open('r2', 'console');
    for (const line of ['enable', 'configure terminal']) expect(sim.cli.exec(s, line).error).toBeUndefined();
    const at = sim.now;
    const outputs = RESTART.map((line) => sim.cli.exec(s, line));
    expect(sim.now).toBe(at);
    expect(outputs.map((o) => o.error)).toEqual(RESTART.map(() => undefined));
    expect(outputs.map((o) => o.output ?? '').join('\n')).not.toContain(CLI_MESSAGES.ospfRouterIdLater);
    sim.runToIdle();
    expect(ospfView(sim, 'r2').process?.routerId).toBe('9.9.9.9');
  });

  it('a router-id typed while the same process keeps running still waits for clear ip ospf process', () => {
    const sim = pair();
    const r = sim.configure('r2', ['router ospf 1', 'router-id 9.9.9.9', 'end']);
    expect(r.lines.map((l) => l.output ?? '')).toContain(CLI_MESSAGES.ospfRouterIdLater);
    sim.runToIdle();
    expect(ospfView(sim, 'r2').process?.routerId).toBe('2.2.2.2');
  });
});
