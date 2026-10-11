/**
 * cli.logging-short-forms — ruling R47 (ARCHITECTURE-P3 §9.2, W5 cli item; §5.7 [S24]): the short negation
 * `no service timestamps debug` (and `… log`) is accepted and does exactly what the long negation
 * `no service timestamps debug datetime msec` does — the same running configuration, the same logger timestamps. The
 * bare spec is hidden, so no help list changes; the bare positive form `service timestamps debug` stores uptime, as a
 * real router does, so `?`'s `<cr>` and Enter agree (W5 fix #21).
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId, SessionId } from '../src/contracts/ids.js';
import type { LoggerStateView } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { createSimulation } from '../src/sim/simulation.js';

/** Two NF-2911 routers in a P3 world (both [S24] timestamps lines replayed), booted. */
function routers(): Simulation {
  const sim = createSimulation({ seed: 2_947, profile: 'P3' });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
  sim.addDevice({ id: 'r2', type: 'router.nf2911', name: 'R2' });
  sim.runFor(60 * SEC);
  return sim;
}

function config(sim: Simulation, dev: DeviceId): SessionId {
  const s = sim.cli.open(dev, 'console');
  for (const line of ['enable', 'configure terminal']) expect(sim.cli.exec(s, line).error, line).toBeUndefined();
  return s;
}

const render = (sim: Simulation, dev: DeviceId): string => sim.device(dev)!.running.render();
const timestamps = (sim: Simulation, dev: DeviceId): LoggerStateView['timestamps'] =>
  (sim.device(dev)!.processes.get('logger')!.stateSnapshot().state as unknown as LoggerStateView).timestamps;

describe('ruling R47: no service timestamps <kind>, the short form', () => {
  it('is accepted, and leaves the same configuration and stamps as the long form', () => {
    const sim = routers();
    expect(render(sim, 'r1')).toContain('\nservice timestamps debug datetime msec\n');
    const short = config(sim, 'r1');
    expect(sim.cli.exec(short, 'no service timestamps debug').error).toBeUndefined();
    const long = config(sim, 'r2');
    expect(sim.cli.exec(long, 'no service timestamps debug datetime msec').error).toBeUndefined();
    expect(render(sim, 'r1')).not.toContain('service timestamps debug datetime');
    expect(render(sim, 'r1').replace('hostname R1', 'hostname R2')).toBe(render(sim, 'r2'));
    expect(timestamps(sim, 'r1')).toEqual(timestamps(sim, 'r2'));
    expect(timestamps(sim, 'r1').log).toBe('datetime msec');
    // the log kind too, and through the configure seam (pasted configuration)
    expect(sim.configure('r1', ['no service timestamps log']).ok).toBe(true);
    expect(sim.configure('r2', ['no service timestamps log datetime msec']).ok).toBe(true);
    expect(render(sim, 'r1').replace('hostname R1', 'hostname R2')).toBe(render(sim, 'r2'));
    expect(render(sim, 'r1')).not.toContain('service timestamps log datetime');
    expect(timestamps(sim, 'r1')).toEqual(timestamps(sim, 'r2'));
  });

  it('the bare positive form stores uptime as a real router does: ? offers <cr> and Enter agrees; the help lists are unchanged (W5 fix #21)', () => {
    const sim = routers();
    const s = config(sim, 'r1');
    // `?` after the kind offers the two forms and <cr>; the hidden bare spec is never listed as a word
    const help = sim.cli.help(s, 'service timestamps debug ');
    expect(help.items.map((i) => i.token).sort()).toEqual(['datetime', 'uptime']);
    expect(help.cr).toBe(true);
    const negated = sim.cli.help(s, 'no service timestamps debug ');
    expect(negated.items.map((i) => i.token).sort()).toEqual(['datetime', 'uptime']);
    expect(negated.cr).toBe(true);
    // Enter does what <cr> promised: the bare form is the uptime form
    const r = sim.cli.exec(s, 'service timestamps debug');
    expect(r.error).toBeUndefined();
    expect(render(sim, 'r1')).toContain('service timestamps debug uptime\n');
    expect(render(sim, 'r1')).not.toContain('service timestamps debug datetime');
    const t = config(sim, 'r2');
    expect(sim.cli.exec(t, 'service timestamps debug uptime').error).toBeUndefined();
    expect(render(sim, 'r1').replace('hostname R1', 'hostname R2')).toBe(render(sim, 'r2'));
  });
});
