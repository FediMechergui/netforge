/**
 * test/sim.harness.ts — shared helpers for the sim acceptance tests (not a test file).
 */
import type { CliResult } from '../src/contracts/cli.js';
import type { SessionId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { Topology } from '../src/contracts/topology.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createSimulation } from '../src/sim/simulation.js';

/** Long enough for every P0 model to boot (router 45 s) and links to settle. */
export const BOOT_NS = 60 * SEC;

/** Load `topo` into a fresh simulation and run through boot. */
export function booted(topo: Topology, seed = 1, bootNs = BOOT_NS): Simulation {
  const sim = createSimulation({ seed });
  sim.loadTopology(topo);
  sim.runFor(bootNs);
  return sim;
}

/** Open a console on `device` and run `lines`; every line must succeed. */
export function console(sim: Simulation, device: string, lines: readonly string[]): { session: SessionId; results: CliResult[] } {
  const session = sim.cli.open(device, 'console');
  const results: CliResult[] = [];
  for (const line of lines) {
    const r = sim.cli.exec(session, line);
    if (r.error !== undefined) throw new Error(`"${line}" on ${device} failed: ${r.output}`);
    results.push(r);
  }
  return { session, results };
}

/** All retained trace events. */
export function events(sim: Simulation): TraceEvent[] {
  return sim.trace(0).events;
}

/** Concatenated asynchronous output of a session. */
export function output(evs: readonly TraceEvent[], session: SessionId): string {
  let s = '';
  for (const e of evs) if (e.kind === 'cliOutput' && e.session === session) s += e.text;
  return s;
}

/** Narrow helper. */
export function ofKind<K extends TraceEvent['kind']>(evs: readonly TraceEvent[], kind: K): Extract<TraceEvent, { kind: K }>[] {
  return evs.filter((e): e is Extract<TraceEvent, { kind: K }> => e.kind === kind);
}

/** Id of the first PDU created on `device` with `tag`. */
export function createdId(evs: readonly TraceEvent[], device: string, tag: string): number {
  const e = ofKind(evs, 'pduCreated').find((x) => x.device === device && x.pdu.tag === tag);
  if (e === undefined) throw new Error(`no pduCreated ${tag} on ${device}`);
  return e.pdu.id;
}

/** Ping from `device` to `target`, run until idle, return the session output and the events emitted since. */
export function ping(sim: Simulation, device: string, target: string): { session: SessionId; text: string; evs: TraceEvent[]; result: CliResult } {
  const cursor = sim.trace(0).next;
  const session = sim.cli.open(device, 'console');
  const result = sim.cli.exec(session, `ping ${target}`);
  sim.runToIdle();
  const evs = sim.trace(cursor).events;
  return { session, text: output(evs, session), evs, result };
}
