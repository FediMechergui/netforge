/**
 * sim [S1] — observation purity (ARCHITECTURE-P2 §2.13 journal rules; §7 W2 sim [S1]): the reads of the facade —
 * snapshot, trace, traceQuery, pdu, captures, cli.complete/help/canOpen/session/sessions, validateLink, link, device,
 * nextEventTime, exportTopology, position, journal, evaluateLab — are never recorded and never change state: the
 * journal, the position, the trace head and the snapshot are the same before and after them, and a world that was
 * read all along ends byte-identical to a twin that was never read.
 */
import { describe, expect, it } from 'vitest';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { CCNA1_LABS, twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { createSimulation } from '../src/sim/simulation.js';

const PC1_NIC = { device: 'pc1', port: 'GigabitEthernet0' };

/** Every read of the facade, exercised once. Returns nothing; throws only for a broken read. */
function readEverything(sim: Simulation, capture: string, session: string): void {
  sim.snapshot();
  sim.snapshot({ devices: ['pc1'] });
  sim.snapshot({ devices: [] });
  sim.trace(0);
  sim.trace(sim.trace(0).next - 3);
  sim.traceQuery({ from: 0, limit: 20 });
  sim.traceQuery({ from: 1_000_000, limit: 5, direction: 'backward', filter: { kinds: ['frameTx'] } });
  sim.pdu(1);
  sim.pdu(999_999);
  sim.captures();
  sim.queryCapture(capture, { from: 0, limit: 10 });
  sim.captureRecord(capture, 0);
  sim.captureStats(capture);
  sim.captureStats(capture, 'arp');
  sim.exportCapture(capture, { format: 'pcapng', baseWallNs: 0n });
  sim.cli.complete(session, 'sh');
  sim.cli.help(session, 'show ');
  sim.cli.canOpen('pc1', 'console');
  sim.cli.canOpen('nope', 'vty');
  sim.cli.session(session);
  sim.cli.sessions();
  sim.validateLink({ a: { device: 'pc1', port: 'gi0' }, b: { device: 'sw1', port: 'fa0/9' } });
  sim.validateLink({ a: { device: 'pc1', port: 'gi0' }, b: { device: 'sw1', port: 'nope' } });
  sim.link('l_pc1_sw1');
  sim.link('l_none');
  sim.device('pc1');
  sim.device('none');
  sim.devices();
  sim.nextEventTime();
  sim.exportTopology();
  sim.position();
  sim.journal();
  sim.catalog.list();
  const lab = CCNA1_LABS[0]!;
  evaluateLab(sim, lab);
}

/** Load the P0 two-PC template, boot it, open a console and a capture (the mutating part of the script). */
function prepare(sim: Simulation): { capture: string; session: string } {
  sim.loadTopology(twoPcsAndSwitch());
  sim.runFor(40 * SEC);
  const capture = sim.startCapture({ ports: [PC1_NIC], name: 'PC1 NIC' });
  const session = sim.cli.open('pc1', 'console');
  return { capture, session };
}

/** The observable state a read must not change. */
function fingerprint(sim: Simulation): { journal: string; position: string; head: number; snapshot: string; trace: string } {
  return {
    journal: JSON.stringify(sim.journal()),
    position: JSON.stringify(sim.position()),
    head: sim.trace(Number.MAX_SAFE_INTEGER).next,
    snapshot: JSON.stringify(sim.snapshot()),
    trace: JSON.stringify(sim.trace(0).events),
  };
}

describe('observation purity', () => {
  it('reads leave the journal, the position, the trace and the snapshot exactly as they were', () => {
    const sim = createSimulation({ seed: 21 });
    const { capture, session } = prepare(sim);
    sim.cli.exec(session, 'ping 10.0.0.2');
    sim.runFor(2 * SEC);
    const before = fingerprint(sim);
    expect(sim.journal().entries.map((e) => e.op.op)).toEqual(['cliOpen', 'cliExec']);
    readEverything(sim, capture, session);
    readEverything(sim, capture, session);
    expect(fingerprint(sim)).toEqual(before);
    // mid-run reads, then the rest of the ping
    sim.runFor(SEC);
    const mid = fingerprint(sim);
    readEverything(sim, capture, session);
    expect(fingerprint(sim)).toEqual(mid);
  });

  it('a world read all along ends byte-identical to a twin that was never read', () => {
    const read = createSimulation({ seed: 22 });
    const quiet = createSimulation({ seed: 22 });
    const a = prepare(read);
    const b = prepare(quiet);
    expect(a).toEqual(b);
    const script = (sim: Simulation, s: string, peek: () => void): void => {
      peek();
      sim.cli.exec(s, 'ping 10.0.0.2');
      peek();
      sim.runFor(SEC);
      peek();
      sim.step();
      peek();
      sim.runFor(2 * SEC, { stopOn: { kinds: ['pduCreated'] } });
      peek();
      sim.injectFault(sim.now + SEC, { id: 'cut', kind: 'cable-cut', target: { link: 'l_pc2_sw1' }, params: { durationNs: SEC } });
      peek();
      sim.runToIdle();
      peek();
      sim.configure('sw1', ['hostname Peeked']);
      peek();
      sim.runFor(5 * SEC);
      peek();
    };
    script(read, a.session, () => readEverything(read, a.capture, a.session));
    script(quiet, b.session, () => undefined);
    expect(fingerprint(read)).toEqual(fingerprint(quiet));
    expect(read.journal()).toEqual(quiet.journal());
    expect(read.exportCapture(a.capture, { format: 'pcapng', baseWallNs: 0n })).toEqual(quiet.exportCapture(b.capture, { format: 'pcapng', baseWallNs: 0n }));
  });

  it('evaluateLab reads the live world without touching it, even with connectivity checks', () => {
    const lab = CCNA1_LABS.find((l) => l.tasks?.some((t) => t.assertions.some((x) => x.kind === 'connectivity'))) ?? CCNA1_LABS[0]!;
    const sim = createSimulation({ seed: 23 });
    sim.loadTopology(lab.build());
    sim.runFor(60 * SEC);
    const before = fingerprint(sim);
    const status = evaluateLab(sim, lab);
    expect(status).toBeDefined();
    evaluateLab(sim, lab);
    expect(fingerprint(sim)).toEqual(before);
  });
});
