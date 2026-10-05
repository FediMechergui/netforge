/**
 * test/ospf.accept.harness.ts — shared helpers of the W4 OSPF acceptance files `accept.p3.ospf-*` (ARCHITECTURE-P3
 * §10.1, §7 W4 qa, §0 rules 13 and 14). Not a test file.
 *
 * The worlds are `staged.world` at stage P3 in the P3 profile with EVERY daemon the W4 flip registers laid over the
 * registry (`P3_FLIP_FACTORIES`: the seven MUST daemons and the eight approved ones, §7 W4 catalog) — what the real
 * catalog holds once the flip has landed, so these files pass unchanged when the lead re-runs them against the flipped
 * catalog (rule 14). In particular CDP runs on every `cdpDefault` model (D2), so OSPF assertions filter OSPF packets
 * and never count frames. Routers are configured through `startupConfig` and `applyConfigLine` (rule 13; the readers
 * of `ospf.harness.ts`), and typed commands go through a real console session (`typed`).
 */
import { expect } from 'vitest';
import type { CliResult } from '../src/contracts/cli.js';
import type { DeviceId, LinkId, ProcessName } from '../src/contracts/ids.js';
import type { ProcessFactory } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createAcl } from '../src/protocols/acl.js';
import { createCdp } from '../src/protocols/cdp.js';
import { createEigrp } from '../src/protocols/eigrp.js';
import { createGre } from '../src/protocols/gre.js';
import { createIke } from '../src/protocols/ike.js';
import { createLldp } from '../src/protocols/lldp.js';
import { createLogger } from '../src/protocols/logger.js';
import { createNtp } from '../src/protocols/ntp.js';
import { createOspf } from '../src/protocols/ospf.js';
import { createPpp } from '../src/protocols/ppp.js';
import { createRestconf } from '../src/protocols/restconf.js';
import { createSyslogServer } from '../src/protocols/syslog-server.js';
import { createTraffic } from '../src/protocols/traffic.js';
import { createVtyClient } from '../src/protocols/vty-client.js';
import { createVty } from '../src/protocols/vty.js';
import { createStagedSimulation } from './staged.world.js';

/**
 * The daemons the W4 flip registers (§7 W4 catalog): ospf, acl, cdp, lldp, ntp, restconf, traffic and the approved
 * ppp, gre, vty, vty-client, logger, syslog-server, eigrp and ike. ([S32] script-host is the W6 flip's.) Built at call
 * time (rule 12).
 */
export function p3FlipFactories(): Readonly<Record<ProcessName, ProcessFactory>> {
  return {
    ppp: createPpp,
    cdp: createCdp,
    lldp: createLldp,
    acl: createAcl,
    gre: createGre,
    vty: createVty,
    'vty-client': createVtyClient,
    logger: createLogger,
    ntp: createNtp,
    'syslog-server': createSyslogServer,
    ospf: createOspf,
    eigrp: createEigrp,
    ike: createIke,
    restconf: createRestconf,
    traffic: createTraffic,
  };
}

/** A P3-profile world on `staged.world` at stage P3 with the flip's daemons (see the file header). */
export function acceptWorld(seed: number): Simulation {
  return createStagedSimulation({ seed, stage: 'P3', factories: p3FlipFactories() });
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
