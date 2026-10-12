/**
 * sim.lab-checks.config-count — the `config` kind's `count` member (ARCHITECTURE-P3 §2.10; ruling R56, W6 sim).
 *
 * `count` is the exact number of configuration lines the path matches under its section, whatever their arguments,
 * so an extra line is a wrong answer: lab 27 requires exactly one `match` line under the VOICE class, which `equals`
 * cannot (it passes as soon as any one line matches). It is optional by meaning: an assertion without it is graded
 * exactly as before, detail for detail. With `exists`, `equals` or `contains` given as well, each must hold too.
 *
 * The world is one P3 router configured through the real CLI (rule 20: the source is the configuration). Pinned: the
 * right answer, the wrong answers (an extra line, a missing class, a wrong number) with their original details, the
 * combinations with the other members, the unchanged P1 details without `count`, the grader (a task scored through
 * `evaluateLab`, the feedback envelope after the detail), and the lab-document schema (a natural number).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { LabAssertion, LabTask, ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { labDocumentOf } from '../src/contracts/lab-document.js';
import { validateLabDocument } from '../src/io/lab-schema.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { checkConfig } from '../src/sim/lab-checks/core.js';
import { runCheck } from '../src/sim/lab-checks/registry.js';
import { createSimulation } from '../src/sim/simulation.js';

const VOICE_MATCH = 'class-map.match-all.VOICE.match';

let sim: Simulation;

/** Configure R1 through the real CLI; a refused line fails the test with its error. */
function cfg(lines: readonly string[]): void {
  const r = sim.configure('r1', lines);
  if (!r.ok) throw new Error(JSON.stringify(r.lines.filter((l) => !l.ok)));
}

/** The class map of §3.11 as lab 27's solution writes it: one match line, DSCP EF. */
function voiceClass(): void {
  cfg(['class-map match-all VOICE', 'match dscp ef']);
}

/** A config assertion on R1's VOICE match lines with `over` merged in. */
const voice = (over: Partial<Extract<LabAssertion, { kind: 'config' }>>): Extract<LabAssertion, { kind: 'config' }> => ({
  kind: 'config',
  device: 'R1',
  path: VOICE_MATCH,
  ...over,
});

/** The detail of one assertion through the registry (undefined = it passed). */
function detail(a: LabAssertion): string | undefined {
  const r = runCheck({ sim, host: undefined }, a);
  return r.pass ? undefined : (r.detail ?? '(no detail)');
}

beforeEach(() => {
  sim = createSimulation({ seed: 27, profile: 'P3' });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
  sim.runFor(60 * SEC);
});

describe('count: the exact number of lines the path matches', () => {
  it('passes the right answer: one match line under VOICE', () => {
    voiceClass();
    expect(detail(voice({ count: 1 }))).toBeUndefined();
    expect(detail(voice({ count: 1, equals: 'dscp ef' }))).toBeUndefined();
    expect(detail(voice({ count: 1, contains: 'dscp' }))).toBeUndefined();
    expect(detail(voice({ count: 1, exists: true }))).toBeUndefined();
    // the section node itself is one line too
    expect(detail({ kind: 'config', device: 'R1', path: 'class-map.match-all.VOICE', count: 1 })).toBeUndefined();
  });

  it('fails an extra match line that equals alone cannot see', () => {
    voiceClass();
    cfg(['class-map match-all VOICE', 'match cos 5']);
    // the blind spot R56 closes: one line still equals `dscp ef`
    expect(detail(voice({ equals: 'dscp ef' }))).toBeUndefined();
    const wrong = 'R1 has 2 configuration lines at class-map.match-all.VOICE.match, expected exactly 1.';
    expect(detail(voice({ count: 1 }))).toBe(wrong);
    // with equals as well, the count is checked first: the extra line is still the answer
    expect(detail(voice({ count: 1, equals: 'dscp ef' }))).toBe(wrong);
    expect(detail(voice({ count: 2 }))).toBeUndefined();
    // removing the extra line makes it right again
    cfg(['class-map match-all VOICE', 'no match cos 5']);
    expect(detail(voice({ count: 1 }))).toBeUndefined();
  });

  it('fails a missing class and a wrong number, each with its own detail', () => {
    expect(detail(voice({ count: 1 }))).toBe('R1 has no configuration line at class-map.match-all.VOICE.match, expected exactly 1.');
    voiceClass();
    expect(detail(voice({ count: 3 }))).toBe('R1 has 1 configuration line at class-map.match-all.VOICE.match, expected exactly 3.');
    expect(detail({ kind: 'config', device: 'R9', path: VOICE_MATCH, count: 1 })).toBe('There is no device called R9 in this topology.');
  });

  it('count 0 passes only when the path matches nothing', () => {
    expect(detail(voice({ count: 0 }))).toBeUndefined();
    expect(detail(voice({ count: 0, exists: false }))).toBeUndefined();
    voiceClass();
    expect(detail(voice({ count: 0 }))).toBe('R1 has 1 configuration line at class-map.match-all.VOICE.match, expected exactly 0.');
  });

  it('with exists, equals or contains given as well, each must hold too', () => {
    voiceClass();
    cfg(['class-map match-all VOICE', 'match cos 5']);
    expect(detail(voice({ count: 2, equals: 'dscp af41' }))).toBe('R1 class-map.match-all.VOICE.match is "dscp ef" / "cos 5", expected "dscp af41".');
    expect(detail(voice({ count: 2, contains: 'precedence' }))).toBe('No line at R1 class-map.match-all.VOICE.match contains "precedence".');
    expect(detail(voice({ count: 2, exists: false }))).toBe('R1 still has a configuration line at class-map.match-all.VOICE.match.');
    expect(detail(voice({ count: 2, contains: 'cos 5', exists: true }))).toBeUndefined();
  });

  it('leaves an assertion without count graded exactly as before, detail for detail', () => {
    // the P1 checks and details (sim/lab-checks/core.ts), unchanged by the new member
    expect(detail(voice({}))).toBe('R1 has no configuration line at class-map.match-all.VOICE.match.');
    expect(detail(voice({ exists: true }))).toBe('R1 has no configuration line at class-map.match-all.VOICE.match.');
    expect(detail(voice({ exists: false }))).toBeUndefined();
    voiceClass();
    cfg(['class-map match-all VOICE', 'match cos 5']);
    expect(detail(voice({}))).toBeUndefined();
    expect(detail(voice({ equals: 'dscp ef' }))).toBeUndefined();
    expect(detail(voice({ equals: ['dscp', 'af41'] }))).toBe('R1 class-map.match-all.VOICE.match is "dscp ef" / "cos 5", expected "dscp af41".');
    expect(detail(voice({ contains: 'cos' }))).toBeUndefined();
    expect(detail(voice({ exists: false }))).toBe('R1 still has a configuration line at class-map.match-all.VOICE.match.');
    // the checker itself, called directly, agrees with the registry
    expect(checkConfig(sim, voice({ count: 2 }))).toEqual({ pass: true });
    expect(checkConfig(sim, voice({ count: 1 }))).toEqual({ pass: false, detail: 'R1 has 2 configuration lines at class-map.match-all.VOICE.match, expected exactly 1.' });
  });
});

describe('count in a lab: right and wrong answers through the grader', () => {
  const FEEDBACK = 'VOICE needs exactly one match line: under match-all a packet must pass every one of them.';
  const task: LabTask = {
    id: 'voice-class',
    title: 'One match line for voice',
    description: 'The class map VOICE matches DSCP EF with exactly one match line.',
    points: 10,
    assertions: [voice({ equals: 'dscp ef' }), voice({ count: 1, feedback: FEEDBACK })],
  };
  const lab = (): ScenarioInfo => ({ name: 'count-lab', title: 'Count', description: '', category: 'lab', build: () => sim.exportTopology(), tasks: [task] });

  it('scores the right answer, fails the extra line with the feedback after the detail, and scores the repair', () => {
    voiceClass();
    const right = evaluateLab(sim, lab());
    expect([right.score, right.total]).toEqual([10, 10]);
    expect(right.results[0]!.assertions).toEqual([
      { index: 0, pass: true },
      { index: 1, pass: true },
    ]);

    cfg(['class-map match-all VOICE', 'match cos 5']);
    const wrong = evaluateLab(sim, lab());
    expect([wrong.score, wrong.total]).toEqual([0, 10]);
    expect(wrong.results[0]).toEqual({
      task: 'voice-class',
      pass: false,
      points: 0,
      assertions: [
        { index: 0, pass: true },
        { index: 1, pass: false, detail: `R1 has 2 configuration lines at class-map.match-all.VOICE.match, expected exactly 1. ${FEEDBACK}` },
      ],
    });

    cfg(['class-map match-all VOICE', 'no match cos 5']);
    expect(evaluateLab(sim, lab()).score).toBe(10);
  });

  it('a lab document carries count, and its schema takes only a natural number', () => {
    const doc = JSON.parse(JSON.stringify(labDocumentOf(lab()))) as { tasks: { assertions: Record<string, unknown>[] }[] };
    expect(doc.tasks[0]!.assertions[1]).toEqual({ kind: 'config', device: 'R1', path: VOICE_MATCH, count: 1, feedback: FEEDBACK });
    const accepted = validateLabDocument(doc);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.document.tasks[0]!.assertions[1]).toEqual(task.assertions[1]);
    const refused = (count: unknown): string[] => {
      const d = JSON.parse(JSON.stringify(doc)) as typeof doc;
      d.tasks[0]!.assertions[1]!['count'] = count;
      const r = validateLabDocument(d);
      return r.ok ? [] : r.errors;
    };
    expect(refused(-1)).toEqual(['tasks[0].assertions[1].count: must be >= 0']);
    expect(refused(1.5)).toEqual(['tasks[0].assertions[1].count: must be an integer (got float)']);
    expect(refused('1')).toEqual(['tasks[0].assertions[1].count: must be a number (got string)']);
  });
});
