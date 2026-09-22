/**
 * sim — `SimulationOptions.catalog` (ARCHITECTURE-P2 §2.9, §0 rule 13; tests and tooling only, never passed by
 * apps/web): the given catalog replaces `createCatalog(PROCESS_FACTORIES)` everywhere the facade needs one — device
 * creation, the daemon registry used at boot, the load gate and the CLI runtime. Without it nothing changes.
 */
import { describe, expect, it } from 'vitest';
import type { ProcessName } from '../src/contracts/ids.js';
import type { ProcessFactory } from '../src/contracts/process.js';
import { TopologyLoadError } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { ALL_MODELS, NF_C2960, NF_PC, createCatalog } from '../src/device/catalog.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import { twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { createSimulation } from '../src/sim/simulation.js';

/** Two addressed PCs cabled back to back (both are in a PC-only catalog). */
function twoPcs(sim: ReturnType<typeof createSimulation>): void {
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: pcConfig('PC1', '10.0.0.1', '255.255.255.0') });
  sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: pcConfig('PC2', '10.0.0.2', '255.255.255.0') });
  sim.addLink({ id: 'l1', a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'pc2', port: 'GigabitEthernet0' } });
}

const missing = (events: readonly TraceEvent[]): string[] =>
  events.flatMap((e) => (e.kind === 'log' && e.message.includes('is not available') ? [`${e.device}: ${e.message}`] : []));

describe('SimulationOptions.catalog', () => {
  it('is absent by default: the facade builds the built-in catalog from PROCESS_FACTORIES', () => {
    const sim = createSimulation({ seed: 1 });
    expect(sim.catalog.list()).toBe(ALL_MODELS);
    expect(sim.catalog.get('switch.nfc2960')).toBe(NF_C2960);
    for (const name of Object.keys(PROCESS_FACTORIES)) expect(sim.catalog.process(name)).toBe(PROCESS_FACTORIES[name]);
  });

  it('when given, is the catalog the facade exposes and builds devices from', () => {
    const catalog = createCatalog(PROCESS_FACTORIES, { models: [NF_PC] });
    const sim = createSimulation({ seed: 1, catalog });
    expect(sim.catalog).toBe(catalog);
    const pc = sim.addDevice({ type: 'pc.nfpc' });
    expect(sim.device(pc)!.model).toBe(NF_PC);
    expect(() => sim.addDevice({ type: 'switch.nfc2960' })).toThrow('Unknown device type "switch.nfc2960".');
  });

  it('the load gate validates against the given catalog, before the world changes', () => {
    const sim = createSimulation({ seed: 1, catalog: createCatalog(PROCESS_FACTORIES, { models: [NF_PC] }) });
    twoPcs(sim);
    const before = JSON.stringify(sim.snapshot());
    let err: unknown;
    try {
      sim.loadTopology(twoPcsAndSwitch());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TopologyLoadError);
    expect((err as TopologyLoadError).problems).toEqual([
      { device: 'sw1', message: 'Device "SW1" (sw1) has type "switch.nfc2960", which this build\'s catalog does not contain' },
    ]);
    expect(JSON.stringify(sim.snapshot())).toBe(before);
    expect(() => createSimulation({ seed: 1 }).loadTopology(twoPcsAndSwitch())).not.toThrow();
  });

  it("devices boot their daemons from the given catalog's registry", () => {
    const made: ProcessName[] = [];
    const counting: Record<ProcessName, ProcessFactory> = {};
    for (const [name, factory] of Object.entries(PROCESS_FACTORIES)) {
      counting[name] = () => {
        made.push(name);
        return factory();
      };
    }
    delete counting['traceroute'];
    const sim = createSimulation({ seed: 1, catalog: createCatalog(counting, { models: [NF_PC] }) });
    twoPcs(sim);
    sim.runFor(10 * SEC);
    const perPc = NF_PC.processes.filter((p) => p !== 'traceroute');
    expect(made).toEqual([...perPc, ...perPc]);
    expect(missing(sim.trace(0).events)).toEqual(['pc1: Process traceroute is not available on this platform', 'pc2: Process traceroute is not available on this platform']);
  });

  it('the CLI runtime works against the given catalog, and a second simulation is unaffected', () => {
    const sim = createSimulation({ seed: 3, catalog: createCatalog(PROCESS_FACTORIES, { models: [NF_PC] }) });
    twoPcs(sim);
    sim.runFor(10 * SEC);
    expect(sim.cli.canOpen('pc1', 'console')).toEqual({ ok: true });
    const s = sim.cli.open('pc1', 'console');
    expect(sim.cli.exec(s, 'ping 10.0.0.2').error).toBeUndefined();
    sim.runFor(10 * SEC);
    const replies = sim.trace(0).events.filter((e) => e.kind === 'pduCreated' && e.device === 'pc2' && e.pdu.tag === 'echo-reply');
    expect(replies).toHaveLength(5);
    expect(missing(sim.trace(0).events)).toEqual([]);
    const other = createSimulation({ seed: 3 });
    expect(other.catalog.get('switch.nfc2960')).toBe(NF_C2960);
    expect(sim.catalog.get('switch.nfc2960')).toBeUndefined();
  });
});
