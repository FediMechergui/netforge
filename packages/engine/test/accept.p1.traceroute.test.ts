/**
 * P1 acceptance — path traces across a chain of routers (ARCHITECTURE-P1 §10.2 `accept.p1.traceroute`; §4.7).
 *
 * The test builds PC1 – R1 – R2 – R3 – PC3 with static routes on every router, then types the host form
 * (`tracert`, echo probes) on PC1 and the network-OS form (`traceroute`, UDP probes) on R1. The hop lines are read
 * back from the session output and checked against the addresses of the chain; what ended each trace is checked on
 * the PDUs the far end produced, so "reached" really means an echo reply or a closed-port message.
 *
 * ponytail: one chain builder; the broken-route and black-hole cases take the same chain and break one thing in it.
 */
import { describe, expect, it } from 'vitest';
import type { CliResult } from '../src/contracts/cli.js';
import type { SessionId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { pcConfig, routerConfig } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';
import { MASK24, cable, device, topology } from './accept.p05.harness.js';
import { ofKind, output } from './sim.harness.js';

const PC_PORT = 'GigabitEthernet0';
const G0 = 'GigabitEthernet0/0';
const G1 = 'GigabitEthernet0/1';
const BOOT = 60 * SEC;

const PC1 = '10.1.0.10';
const PC3 = '10.3.0.10';
const R1_LAN = '10.1.0.1';
const R2_NEAR = '10.0.12.2';
const R3_NEAR = '10.0.23.3';
const FAR_LINK = 'l_r2_r3';

/** PC1 – R1 – R2 – R3 – PC3, every router carrying static routes to the subnets it is not attached to. */
function chain(seed = 31): Simulation {
  const sim = createSimulation({ seed });
  sim.loadTopology(
    topology(
      [
        device('pc1', 'pc.nfpc', 'PC1', 80, 320, pcConfig('PC1', PC1, MASK24, R1_LAN)),
        device(
          'r1',
          'router.nf2911',
          'R1',
          220,
          160,
          routerConfig(
            'R1',
            [{ port: G0, address: R1_LAN, mask: MASK24 }, { port: G1, address: '10.0.12.1', mask: MASK24 }],
            [`10.0.23.0 ${MASK24} ${R2_NEAR}`, `10.3.0.0 ${MASK24} ${R2_NEAR}`],
          ),
        ),
        device(
          'r2',
          'router.nf2911',
          'R2',
          400,
          100,
          routerConfig(
            'R2',
            [{ port: G0, address: R2_NEAR, mask: MASK24 }, { port: G1, address: '10.0.23.2', mask: MASK24 }],
            [`10.1.0.0 ${MASK24} 10.0.12.1`, `10.3.0.0 ${MASK24} ${R3_NEAR}`],
          ),
        ),
        device(
          'r3',
          'router.nf2911',
          'R3',
          580,
          160,
          routerConfig(
            'R3',
            [{ port: G0, address: R3_NEAR, mask: MASK24 }, { port: G1, address: '10.3.0.1', mask: MASK24 }],
            [`10.1.0.0 ${MASK24} 10.0.23.2`, `10.0.12.0 ${MASK24} 10.0.23.2`],
          ),
        ),
        device('pc3', 'pc.nfpc', 'PC3', 720, 320, pcConfig('PC3', PC3, MASK24, '10.3.0.1')),
      ],
      [
        cable('l_pc1_r1', 'pc1', PC_PORT, 'r1', G0),
        cable('l_r1_r2', 'r1', G1, 'r2', G0),
        cable(FAR_LINK, 'r2', G1, 'r3', G0),
        cable('l_r3_pc3', 'r3', G1, 'pc3', PC_PORT),
      ],
    ),
  );
  sim.runFor(BOOT);
  return sim;
}

/** Type `line` on a fresh console of `device` and return the session, the immediate result and a text reader. */
function trace(sim: Simulation, dev: string, line: string): { session: SessionId; result: CliResult; cursor: number } {
  const cursor = sim.trace(0).next;
  const session = sim.cli.open(dev, 'console');
  const result = sim.cli.exec(session, line);
  if (result.error !== undefined) throw new Error(`"${line}" on ${dev} failed: ${result.output}`);
  return { session, result, cursor };
}

/** One parsed hop line: its number, the address that answered, and the marks of its probes. */
interface Hop {
  n: number;
  from: string;
  marks: string[];
}

/** A probe mark: an RTT, a star, or an unreachable flag. */
const MARK = /^(?:\d+ msec|\*|![A-Za-z0-9?]+)$/;

/** Hop lines of a trace, in order (`  2 10.0.12.2 1 msec 1 msec 1 msec`); `from` is empty when nobody answered. */
function hops(text: string): Hop[] {
  const out: Hop[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (m === null) continue;
    let rest = (m[2] ?? '').trim();
    let from = '';
    const first = rest.split(/\s+/)[0] ?? '';
    // The address is printed once, before the first mark; a hop nobody answered starts with a mark (a bare
    // number is the milliseconds of an RTT, never an address).
    if (!MARK.test(first) && /[.:]/.test(first)) {
      from = first;
      rest = rest.slice(first.length).trim();
    }
    out.push({ n: Number(m[1]), from, marks: rest.split(/\s+(?=\d+ msec|\*|!)/).map((s) => s.trim()).filter((s) => s !== '') });
  }
  return out;
}

describe('accept P1: traceroute across a chain of routers', () => {
  it('walks the three routers from the host and stops on the echo reply of the far host', () => {
    const sim = chain();
    const { session, result, cursor } = trace(sim, 'pc1', `tracert ${PC3}`);
    expect(result.busy).toBe(true);
    expect(sim.cli.session(session)!.job).toEqual({ process: 'traceroute', label: 'trace' });
    sim.runToIdle();

    const text = output(sim.trace(cursor).events, session);
    const walked = hops(text);
    expect(walked.map((h) => [h.n, h.from])).toEqual([[1, R1_LAN], [2, R2_NEAR], [3, R3_NEAR], [4, PC3]]);
    for (const h of walked) {
      expect(h.marks).toHaveLength(3);
      for (const mark of h.marks) expect(mark).toMatch(/^\d+ msec$/);
    }
    expect(text).toContain(`Reached ${PC3} in 4 hops.`);
    expect(sim.cli.session(session)!.busy).toBe(false);

    // The far host answered with echo replies; it was never asked for a closed port.
    const fromPc3 = ofKind(sim.trace(cursor).events, 'pduCreated').filter((e) => e.device === 'pc3').map((e) => sim.pdu(e.pdu.id)!);
    expect(fromPc3.length).toBeGreaterThan(0);
    expect(fromPc3.some((p) => p.get('icmpv4.type') === 0)).toBe(true);
    expect(fromPc3.some((p) => p.get('icmpv4.type') === 3)).toBe(false);
  });

  it('walks the remaining routers from R1 and stops on the closed port of the far host', () => {
    const sim = chain();
    const { session, result, cursor } = trace(sim, 'r1', `traceroute ${PC3}`);
    expect(result.busy).toBe(true);
    sim.runToIdle();

    const text = output(sim.trace(cursor).events, session);
    expect(hops(text).map((h) => [h.n, h.from])).toEqual([[1, R2_NEAR], [2, R3_NEAR], [3, PC3]]);
    expect(text).toContain(`Reached ${PC3} in 3 hops.`);

    // UDP probes to a port nothing listens on: the far host answers destination unreachable, port unreachable.
    const unreachable = ofKind(sim.trace(cursor).events, 'pduCreated')
      .filter((e) => e.device === 'pc3')
      .map((e) => sim.pdu(e.pdu.id)!)
      .filter((p) => p.get('icmpv4.type') === 3 && p.get('icmpv4.code') === 3);
    expect(unreachable.length).toBeGreaterThan(0);
    expect(sim.cli.session(session)!.busy).toBe(false);
  });

  it('prints the network-unreachable flag when a router on the path has no route left', () => {
    const sim = chain();
    const removed = sim.configure('r2', [`no ip route 10.3.0.0 ${MASK24} ${R3_NEAR}`]);
    expect(removed.ok).toBe(true);
    sim.runToIdle();

    const { session, cursor } = trace(sim, 'pc1', `tracert ${PC3}`);
    sim.runToIdle();
    const text = output(sim.trace(cursor).events, session);
    const walked = hops(text);
    expect(walked.map((h) => [h.n, h.from])).toEqual([[1, R1_LAN], [2, R2_NEAR], [3, R2_NEAR]]);
    expect(walked[2]!.marks).toEqual(['!N', '!N', '!N']);
    expect(text).toContain(`Stopped at hop 3: ${PC3} is unreachable.`);
    expect(sim.cli.session(session)!.busy).toBe(false);
  });

  it('prints stars into a black hole and prints a partial footer when the student aborts', () => {
    const sim = chain();
    // Everything R2 sends towards R3 disappears, and nothing answers.
    sim.setImpairments(FAR_LINK, { lossPct: 100 });

    const { session, cursor } = trace(sim, 'pc1', `tracert ${PC3}`);
    sim.runFor(25 * SEC);
    const before = hops(output(sim.trace(cursor).events, session));
    expect(before.slice(0, 2).map((h) => [h.n, h.from])).toEqual([[1, R1_LAN], [2, R2_NEAR]]);
    // Past the black hole nobody answers: every later hop is stars only, with no address.
    expect(before.length).toBeGreaterThan(2);
    for (const h of before.slice(2)) {
      expect(h.from).toBe('');
      expect(new Set(h.marks)).toEqual(new Set(['*']));
    }
    expect(sim.cli.session(session)!.busy).toBe(true);

    sim.cli.interrupt(session);
    const text = output(sim.trace(cursor).events, session);
    const footer = /Trace aborted at hop (\d+)\./.exec(text);
    expect(footer).not.toBeNull();
    expect(sim.cli.session(session)!.busy).toBe(false);
    // The footer names the hop the trace had reached, and nothing beyond it was ever printed.
    const walked = hops(text);
    expect(Number(footer![1])).toBe(walked[walked.length - 1]!.n);
    expect(text).not.toContain(`Reached ${PC3}`);
  });
});
