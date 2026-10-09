/**
 * test/ospf.accept.harness.ts — shared helpers of the W4 OSPF acceptance files `accept.p3.ospf-*` (ARCHITECTURE-P3
 * §10.1, §7 W4 qa, §0 rules 13 and 14). Not a test file.
 *
 * The worlds are `staged.world` at stage P3 in the P3 profile, whose registry is the real one: since the W4 catalog
 * flip it holds every daemon the flip registered (the seven MUST daemons and the eight approved ones), so the world is
 * the flipped catalog's (ruling R47 removed the pre-flip overlay, `p3FlipFactories`). In particular CDP runs on every
 * `cdpDefault` model (D2), so OSPF assertions filter OSPF packets
 * and never count frames. Routers are configured through `startupConfig` and `applyConfigLine` (rule 13; the readers
 * of `ospf.harness.ts`), and typed commands go through a real console session (`typed`).
 */
import { expect } from 'vitest';
import type { CliResult } from '../src/contracts/cli.js';
import type { DeviceId, LinkId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createStagedSimulation } from './staged.world.js';

/** A P3-profile world on `staged.world` at stage P3: the flipped catalog's world (see the file header). */
export function acceptWorld(seed: number): Simulation {
  return createStagedSimulation({ seed, stage: 'P3' });
}

/** The time of the `linkState up` event of `link` in `evs` (the "link-up" of §10.1). */
export function linkUpAt(evs: readonly TraceEvent[], link: LinkId): SimTime {
  const e = evs.find((x) => x.kind === 'linkState' && x.link === link && x.up);
  if (e === undefined) throw new Error(`no linkState up for ${link}`);
  return e.t;
}

/** Open a console on `device`, enter privileged mode and run `lines`; each line's result. */
export function typed(sim: Simulation, device: DeviceId, lines: readonly string[]): CliResult[] {
  const s = sim.cli.open(device, 'console');
  const out: CliResult[] = [];
  for (const line of ['enable', ...lines]) out.push(sim.cli.exec(s, line));
  return out.slice(1);
}

/** The output lines of one exec command typed on a console. */
export function showLines(sim: Simulation, device: DeviceId, command: string): string[] {
  const [r] = typed(sim, device, [command]);
  expect(r!.error, `${command} on ${device}`).toBeUndefined();
  return (r!.output ?? '').split('\n');
}

/** Configure through the real CLI (`Simulation.configure`); a refused line fails the test with its error. */
export function configureOk(sim: Simulation, device: DeviceId, lines: readonly string[]): void {
  const r = sim.configure(device, lines);
  if (!r.ok) throw new Error(`${device}: ${JSON.stringify(r.lines.filter((l) => !l.ok))}`);
}

/** Every trace event since `from`, failing when the ring dropped any of them. */
export function traceSince(sim: Simulation, from: number): TraceEvent[] {
  const t = sim.trace(from);
  expect(t.dropped, 'trace events dropped from the ring').toBe(0);
  return t.events;
}
