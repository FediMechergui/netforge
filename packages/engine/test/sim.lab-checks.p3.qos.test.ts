/**
 * sim.lab-checks.p3.qos — the qos area's checker adapter (ARCHITECTURE-P3 D5, D16, §2.10, §3.5, §3.11; §7 W3 "ospf,
 * acl, l2, qos, disc, svc, http" and "Approved items in W3", qos): qos.inputPolicy, qos.outputPolicy and the approved
 * [S20] qos.admitted of sim/lab-checks/qos.ts, wired into sim/lab-checks/facts.ts.
 *
 * Configuration facts (rule 20), so the "fake" is the configuration itself, stored through the real CLI: §3.5's
 * marking policy MARK input on Gi0/0, §3.11's WAN-EDGE (priority 32 kb/s) output on Se0/0/0 with `bandwidth 128`,
 * MARK output on Gi0/1. Pinned, each with a wrong answer and its original detail: the policy names; the admission
 * (32 ≤ 96 accepted; false once a lowered `bandwidth` or a larger priority rate breaks the 75 % rule after the attach,
 * since the fact recomputes it; a marking-only policy is always admitted); the absent fact and the subject problems.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { LabAssertion, LabFactName } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { FACT_READERS } from '../src/sim/lab-checks/facts.js';
import { QOS_FACT_READERS } from '../src/sim/lab-checks/qos.js';
import { runCheck } from '../src/sim/lab-checks/registry.js';
import { createStagedSimulation } from './staged.world.js';

let sim: Simulation;

/** Configure through the real CLI; a refused line fails the test with its error. */
function cfg(id: string, lines: readonly string[]): void {
  const r = sim.configure(id, lines);
  if (!r.ok) throw new Error(`${id}: ${JSON.stringify(r.lines.filter((l) => !l.ok))}`);
}

beforeEach(() => {
  sim = createStagedSimulation({ seed: 9, stage: 'P3' });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
  sim.addDevice({ id: 'r2', type: 'router.nf2911', name: 'R2' });
  sim.runFor(60 * SEC);
  cfg('r1', [
    'class-map match-all VOICE',
    'match dscp ef',
    'exit',
    'policy-map MARK',
    'class VOICE',
    'set dscp ef',
    'exit',
    'exit',
    'policy-map WAN-EDGE',
    'class VOICE',
    'priority 32',
    'exit',
    'exit',
    'interface GigabitEthernet0/0',
    'service-policy input MARK',
    'exit',
    'interface GigabitEthernet0/1',
    'service-policy output MARK',
    'exit',
    'interface Serial0/0/0',
    'bandwidth 128',
    'service-policy output WAN-EDGE',
  ]);
});

/** The detail of one assertion (undefined = it passed). */
function detail(a: LabAssertion): string | undefined {
  const r = runCheck({ sim, host: undefined }, a);
  return r.pass ? undefined : (r.detail ?? '(no detail)');
}

const fact = (device: string, f: LabFactName, over: { subject?: string; equals?: string | number | boolean } = {}): LabAssertion => ({
  kind: 'fact',
  device,
  fact: f,
  ...over,
});

describe('the qos adapter is wired (rule 12) and names its sources (rule 20)', () => {
  it('FACT_READERS reads the adapter’s entries, each with its type and source', () => {
    for (const f of Object.keys(QOS_FACT_READERS) as LabFactName[]) expect(FACT_READERS[f]).toBe(QOS_FACT_READERS[f]);
    const sources = Object.fromEntries(Object.entries(QOS_FACT_READERS).map(([f, r]) => [f, `${r.type} ${r.source}`]));
    expect(sources).toEqual({
      'qos.inputPolicy': 'string configuration: interface service-policy input',
      'qos.outputPolicy': 'string configuration: interface service-policy output',
      'qos.admitted': 'boolean configuration: interface service-policy output, its policy-map and the port bandwidth',
    });
  });
});

describe('qos.inputPolicy and qos.outputPolicy', () => {
  it('the policy names per direction (§3.5 grading: qos.inputPolicy of Gi0/0 is MARK)', () => {
    expect(detail(fact('R1', 'qos.inputPolicy', { subject: 'Gi0/0', equals: 'MARK' }))).toBeUndefined();
    expect(detail(fact('R1', 'qos.outputPolicy', { subject: 'Serial0/0/0', equals: 'WAN-EDGE' }))).toBeUndefined();
    expect(detail(fact('R1', 'qos.outputPolicy', { subject: 'Gi0/1', equals: 'MARK' }))).toBeUndefined();
  });

  it('wrong answers: another policy, the other direction, an interface without one', () => {
    expect(detail(fact('R1', 'qos.inputPolicy', { subject: 'Gi0/0', equals: 'WAN-EDGE' }))).toBe('R1 qos.inputPolicy of Gi0/0 is MARK, expected WAN-EDGE.');
    expect(detail(fact('R1', 'qos.outputPolicy', { subject: 'Gi0/0', equals: 'MARK' }))).toBe('R1 qos.outputPolicy of Gi0/0 is not set, expected MARK.');
    expect(detail(fact('R2', 'qos.inputPolicy', { subject: 'Gi0/0' }))).toBe('R2 qos.inputPolicy of Gi0/0 is not set.');
  });

  it('a missing or unknown interface fails', () => {
    expect(detail(fact('R1', 'qos.inputPolicy', { equals: 'MARK' }))).toBe('qos.inputPolicy needs an interface as its subject.');
    expect(detail(fact('R1', 'qos.outputPolicy', { subject: 'Gi0/7', equals: 'MARK' }))).toBe('R1 has no interface called Gi0/7.');
  });
});

describe('[S20] qos.admitted', () => {
  it('§3.11: 32 kb/s of priority on a 128 kb/s port is within 75 %; a marking policy is always admitted', () => {
    expect(detail(fact('R1', 'qos.admitted', { subject: 'Se0/0/0', equals: true }))).toBeUndefined();
    expect(detail(fact('R1', 'qos.admitted', { subject: 'Gi0/1', equals: true }))).toBeUndefined();
  });

  it('recomputed from the current configuration: a lowered bandwidth breaks it', () => {
    cfg('r1', ['interface Serial0/0/0', 'bandwidth 40']);
    expect(detail(fact('R1', 'qos.admitted', { subject: 'Se0/0/0', equals: true }))).toBe('R1 qos.admitted of Se0/0/0 is false, expected true.');
  });

  it('recomputed from the current configuration: a larger priority rate breaks it', () => {
    cfg('r1', ['policy-map WAN-EDGE', 'class VOICE', 'priority 100']);
    expect(detail(fact('R1', 'qos.admitted', { subject: 'Se0/0/0', equals: true }))).toBe('R1 qos.admitted of Se0/0/0 is false, expected true.');
    expect(detail(fact('R1', 'qos.admitted', { subject: 'Se0/0/0', equals: false }))).toBeUndefined();
  });

  it('absent without an output policy; a missing subject fails', () => {
    expect(detail(fact('R1', 'qos.admitted', { subject: 'Gi0/0', equals: true }))).toBe('R1 qos.admitted of Gi0/0 is not set, expected true.');
    expect(detail(fact('R1', 'qos.admitted', { equals: true }))).toBe('qos.admitted needs an interface as its subject.');
  });
});
