/**
 * cli.w3-fix-seams — the CLI seams settled by the W3 fix step's rulings, on real worlds (`staged.world` at stage P3;
 * ARCHITECTURE-P3 §5.8, §9.2 rulings R38, R39, R40):
 *   • R38: `clear logging` (`ext.logging.clear`) empties the logger's buffer — its lines and used bytes — and keeps every
 *     counter;
 *   • R39: `clear cdp counters` (`cdp.clearCounters`) zeroes the counters `show cdp traffic` prints, the neighbours stay;
 *   • R40: `runToIdle` reports `stopped: 'maxEvents'` only when non-periodic work is still pending after its cap, so a
 *     run that reaches idle on exactly its last allowed event is not capped.
 */
import { describe, expect, it } from 'vitest';
import type { LoggerStateView } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { LOGGING_CLEAR_REQUEST } from '../src/cli/handlers/logging.js';
import { createCdp } from '../src/protocols/cdp.js';
import { createLogger, LOGGER_CLEAR_REQUEST } from '../src/protocols/logger.js';
import { twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { booted } from './sim.harness.js';
import { createStagedSimulation } from './staged.world.js';

const GI0 = 'GigabitEthernet0/0';

function routerConfig(name: string, address: string): string {
  return [`hostname ${name}`, '!', `interface ${GI0}`, ` ip address ${address} 255.255.255.0`, ' no shutdown', '!', 'end', ''].join('\n');
}

/** R1 Gi0/0 ⇄ R2 Gi0/0 with the logger and CDP registered, booted and settled. */
function world(seed = 3): Simulation {
  const sim = createStagedSimulation({ seed, stage: 'P3', factories: { logger: createLogger, cdp: createCdp } });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: routerConfig('R1', '10.0.0.1') });
  sim.addDevice({ id: 'r2', type: 'router.nf2911', name: 'R2', startupConfig: routerConfig('R2', '10.0.0.2') });
  sim.addLink({ a: { device: 'r1', port: GI0 }, b: { device: 'r2', port: GI0 } });
  sim.runFor(200 * SEC);
  return sim;
}

/** Run `lines` on a fresh privileged console of `device`; each line's output. */
function cli(sim: Simulation, device: string, lines: readonly string[]): string[] {
  const s = sim.cli.open(device, 'console');
  sim.cli.exec(s, 'enable');
  return lines.map((l) => sim.cli.exec(s, l).output);
}

const loggerView = (sim: Simulation, device: string): LoggerStateView =>
  sim.device(device)!.processes.get('logger')!.stateSnapshot().state as unknown as LoggerStateView;

describe('R38: clear logging', () => {
  it('empties the buffer lines and used bytes and keeps every counter', () => {
    const sim = world();
    // a configuration change and a shutdown leave lines in R1's buffer
    cli(sim, 'r1', ['configure terminal', `interface ${GI0}`, 'shutdown', 'no shutdown', 'end']);
    sim.runFor(5 * SEC);
    const before = loggerView(sim, 'r1');
    expect(before.entries.length).toBeGreaterThan(0);
    expect(before.buffered.usedBytes).toBeGreaterThan(0);
    const [shown] = cli(sim, 'r1', ['show logging']);
    expect(shown).toContain(`Log buffer (${before.entries.length} line`);
    const [cleared, after] = cli(sim, 'r1', ['clear logging', 'show logging']);
    expect(cleared).toBe('');
    const view = loggerView(sim, 'r1');
    expect(view.entries).toEqual([]);
    expect(view.buffered.usedBytes).toBe(0);
    expect(view.counts).toEqual(before.counts);
    expect(after).toContain('Log buffer: empty');
    expect(after).toContain(`${view.buffered.sizeBytes} bytes (0 used)`);
    // the CLI's request kind and the logger's are one text
    expect(LOGGING_CLEAR_REQUEST).toBe(LOGGER_CLEAR_REQUEST);
  });
});

describe('R39: clear cdp counters', () => {
  it('zeroes the counters show cdp traffic prints; the neighbour table stays', () => {
    const sim = world();
    const [traffic, neighbours] = cli(sim, 'r1', ['show cdp traffic', 'show cdp neighbors']);
    expect(traffic).toMatch(/Announcements sent: [1-9]/);
    expect(traffic).toMatch(/Announcements received: [1-9]/);
    expect(neighbours).toContain('R2');
    const [cleared, after, still] = cli(sim, 'r1', ['clear cdp counters', 'show cdp traffic', 'show cdp neighbors']);
    expect(cleared).toBe('');
    expect(after).toBe(['CDP counters', '  Announcements sent: 0', '  Announcements received: 0', '  Errors: 0'].join('\n'));
    expect(still).toBe(neighbours);
    // the counters count again from zero
    sim.runFor(120 * SEC);
    const [later] = cli(sim, 'r1', ['show cdp traffic']);
    expect(later).toMatch(/Announcements sent: [1-9]/);
  });
});

describe('R40: runToIdle reports the cap only when work is still pending', () => {
  /** The two-PC lab with a ping started (nothing dispatched yet after the command). */
  const pingLab = (): Simulation => {
    const sim = booted(twoPcsAndSwitch(), 7);
    sim.cli.exec(sim.cli.open('pc1', 'console'), 'ping 10.0.0.2');
    return sim;
  };

  it('idle on exactly the last allowed event is not capped; one event short is', () => {
    const free = pingLab().runToIdle(1_000_000);
    expect(free.stopped).toBeUndefined();
    const n = free.events;
    expect(n).toBeGreaterThan(10);
    const exact = pingLab().runToIdle(n);
    expect(exact).toEqual(free);
    expect(exact.stopped).toBeUndefined();
    const short = pingLab();
    const capped = short.runToIdle(n - 1);
    expect(capped.events).toBe(n - 1);
    expect(capped.stopped).toBe('maxEvents');
    // the capped world finishes with the one event left
    expect(short.runToIdle(1)).toMatchObject({ events: 1 });
  });
});
