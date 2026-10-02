/**
 * sim.lab-checks.p3 — ruling R18 (ARCHITECTURE-P3 §2.10, §9.2 "W1 rulings"; §7 W2 sim): the widened `route` and
 * `table` assertion members and the envelope's `LabCheckResult.misconception`, each with its wrong answers
 * (sim/lab-checks/routing.ts, sim/lab-checks/core.ts, sim/lab-checks.ts).
 *
 * The OSPF daemon that writes `'O'` rows is another W2 item, so the routes are written straight into a real router's
 * `rib` table on `staged.world` (the checker reads only the table): an intra-area route with two equal-cost paths and an
 * external type-2 default. Pinned:
 *   • `route`: `metric`, `routeType: 'E2'` and `minPaths` pass on the right answer and fail on a wrong one with an
 *     original detail naming what was expected and what the winner has, after the P2 items; without them the P2 check
 *     and detail are unchanged;
 *   • `table`: `whereOps` (`lt` `le` `gt` `ge` numeric, `ne`, `contains`, port columns in any written form) and the
 *     `minCount` / `maxCount` bounds on the matching rows (with `exists` keeping its P2 meaning), each wrong answer with
 *     its exact detail; without them the P2 check and detail are unchanged;
 *   • `misconception`: a failed task carries the tag of its first failing assertion that has one (trimmed); a passing
 *     task, or one whose failing assertions carry none, has no such key — so every P1/P2 status keeps its bytes —
 *     and `feedback` is still shown after the detail.
 */
import { describe, expect, it } from 'vitest';
import type { LabAssertion, LabTask, ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { routeKey, type RouteRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { evaluateLab, misconceptionOf } from '../src/sim/lab-checks.js';
import { whereOpHolds } from '../src/sim/lab-checks/core.js';
import { runCheck } from '../src/sim/lab-checks/registry.js';
import { createStagedSimulation } from './staged.world.js';

const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';

/** R1 with two OSPF routes written into its RIB: 10.9.0.0/24 over two equal-cost paths (metric 20) and an E2 default. */
function world(): Simulation {
  const sim = createStagedSimulation({ seed: 13, stage: 'P3' });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
  sim.runFor(60 * SEC);
  const rib = sim.device('r1')!.tables.rib;
  const at = sim.now;
  const intra: RouteRow = {
    key: routeKey('10.9.0.0', 24),
    updatedAt: at,
    network: '10.9.0.0',
    prefixLen: 24,
    source: 'O',
    nextHop: '10.0.0.2',
    iface: GI0,
    ad: 110,
    metric: 20,
    owner: 'ospf',
    paths: [
      { nextHop: '10.0.0.2', iface: GI0 },
      { nextHop: '10.0.1.2', iface: GI1 },
    ],
  };
  const external: RouteRow = {
    key: routeKey('0.0.0.0', 0),
    updatedAt: at,
    network: '0.0.0.0',
    prefixLen: 0,
    source: 'O',
    routeType: 'E2',
    nextHop: '10.0.1.2',
    iface: GI1,
    ad: 110,
    metric: 1,
    isDefault: true,
    owner: 'ospf',
  };
  rib.set(intra);
  rib.set(external);
  return sim;
}

/** The detail of one assertion graded on `sim` (undefined = it passed). */
function detail(sim: Simulation, a: LabAssertion): string | undefined {
  const r = runCheck({ sim, host: undefined }, a);
  return r.pass ? undefined : (r.detail ?? '(no detail)');
}

const route = (over: Partial<Extract<LabAssertion, { kind: 'route' }>>): LabAssertion => ({ kind: 'route', device: 'R1', destination: '10.9.0.5', ...over });
const table = (over: Partial<Extract<LabAssertion, { kind: 'table' }>>): LabAssertion => ({ kind: 'table', device: 'R1', table: 'rib', where: { source: 'O' }, exists: true, ...over });

const INTRA_TEXT = 'R1 reaches 10.9.0.5 through 10.9.0.0/24 (O, distance 110, via 10.0.0.2, out GigabitEthernet0/0, GigabitEthernet0/1)';

describe('route: metric, routeType, minPaths (R18)', () => {
  it('pass on the right answers', () => {
    const sim = world();
    expect(detail(sim, route({ source: 'O', metric: 20, minPaths: 2 }))).toBeUndefined();
    expect(detail(sim, route({ minPaths: 1 }))).toBeUndefined();
    expect(detail(sim, route({ destination: '8.8.8.8', source: 'O', routeType: 'E2', metric: 1, minPaths: 1 }))).toBeUndefined();
  });

  it('a wrong metric names the expected one and the winner’s', () => {
    expect(detail(world(), route({ metric: 30 }))).toBe(`${INTRA_TEXT}; expected metric 30 (it has 20).`);
  });

  it('an intra-area route is not E2', () => {
    expect(detail(world(), route({ routeType: 'E2' }))).toBe(`${INTRA_TEXT}; expected route type E2 (it is not an external route).`);
  });

  it('too few equal-cost paths, counting a single-path row as one', () => {
    const sim = world();
    expect(detail(sim, route({ minPaths: 3 }))).toBe(`${INTRA_TEXT}; expected at least 3 equal-cost paths (it has 2).`);
    expect(detail(sim, route({ destination: '8.8.8.8', minPaths: 2 }))).toBe(
      'R1 reaches 8.8.8.8 through 0.0.0.0/0 (O, distance 110, via 10.0.1.2, out GigabitEthernet0/1); expected at least 2 equal-cost paths (it has 1).',
    );
  });

  it('the new items follow the P2 ones in one detail; without them the P2 detail is unchanged', () => {
    const sim = world();
    expect(detail(sim, route({ ad: 90, metric: 21, routeType: 'E2', minPaths: 4 }))).toBe(
      `${INTRA_TEXT}; expected distance 90, metric 21 (it has 20), route type E2 (it is not an external route), at least 4 equal-cost paths (it has 2).`,
    );
    expect(detail(sim, route({ ad: 90 }))).toBe(`${INTRA_TEXT}; expected distance 90.`);
    expect(detail(sim, route({ destination: '10.9.0.5', none: true }))).toBe(`R1 still routes 10.9.0.5 through 10.9.0.0/24 (O, distance 110, via 10.0.0.2, out GigabitEthernet0/0, GigabitEthernet0/1).`);
  });
});

describe('table: whereOps, minCount, maxCount (R18)', () => {
  it('pass on the right answers', () => {
    const sim = world();
    expect(detail(sim, table({ minCount: 2, maxCount: 2 }))).toBeUndefined();
    expect(detail(sim, table({ whereOps: { metric: { op: 'ge', value: 20 } } }))).toBeUndefined();
    expect(detail(sim, table({ whereOps: { metric: { op: 'lt', value: '2' } } }))).toBeUndefined(); // a number written as text
    expect(detail(sim, table({ whereOps: { metric: { op: 'le', value: 1 }, nextHop: { op: 'contains', value: '10.0.1.' } }, maxCount: 1 }))).toBeUndefined();
    expect(detail(sim, table({ whereOps: { metric: { op: 'gt', value: 1 } }, minCount: 1, maxCount: 1 }))).toBeUndefined();
    // port columns compare in canonical form, whatever form the author writes
    expect(detail(sim, table({ whereOps: { iface: { op: 'ne', value: 'Gi0/0' } }, minCount: 1, maxCount: 1 }))).toBeUndefined();
    expect(detail(sim, table({ where: { source: 'S' }, exists: false, whereOps: { metric: { op: 'ge', value: 0 } } }))).toBeUndefined();
  });

  it('a comparison no row meets fails with every condition in the detail', () => {
    expect(detail(world(), table({ whereOps: { metric: { op: 'lt', value: 1 } } }))).toBe('The rib table of R1 has no row with source=O metric < 1.');
    expect(detail(world(), table({ where: {}, whereOps: { nextHop: { op: 'contains', value: '192.168.' }, ad: { op: 'ge', value: 100 } } }))).toBe(
      'The rib table of R1 has no row with nextHop contains 192.168. ad >= 100.',
    );
  });

  it('a row that should not exist still matching fails as in P2', () => {
    expect(detail(world(), table({ exists: false, whereOps: { metric: { op: 'gt', value: 5 } } }))).toBe('The rib table of R1 still has a row with source=O metric > 5.');
  });

  it('too few or too many matching rows', () => {
    const sim = world();
    expect(detail(sim, table({ minCount: 3 }))).toBe('The rib table of R1 has 2 rows with source=O, expected at least 3.');
    expect(detail(sim, table({ maxCount: 1 }))).toBe('The rib table of R1 has 2 rows with source=O, expected at most 1.');
    expect(detail(sim, table({ whereOps: { metric: { op: 'ne', value: 20 } }, minCount: 2 }))).toBe('The rib table of R1 has 1 row with source=O metric != 20, expected at least 2.');
    // exists keeps its P2 meaning: no matching row fails on exists before any bound
    expect(detail(sim, table({ where: { source: 'S' }, minCount: 0 }))).toBe('The rib table of R1 has no row with source=S.');
  });

  it('without the P3 members the P2 detail is unchanged', () => {
    const sim = world();
    expect(detail(sim, table({ where: { source: 'S', metric: 1 } }))).toBe('The rib table of R1 has no row with source=S metric=1.');
    expect(detail(sim, table({ exists: false }))).toBe('The rib table of R1 still has a row with source=O.');
  });

  it('whereOpHolds: numeric comparisons need numbers on both sides; ne and contains compare text', () => {
    expect(whereOpHolds(5, 'lt', 6)).toBe(true);
    expect(whereOpHolds('5', 'le', '5')).toBe(true);
    expect(whereOpHolds(5, 'gt', 5)).toBe(false);
    expect(whereOpHolds(-1.5, 'ge', -2)).toBe(true);
    expect(whereOpHolds('up', 'gt', 1)).toBe(false);
    expect(whereOpHolds(undefined, 'lt', 1)).toBe(false);
    expect(whereOpHolds(true, 'ge', 0)).toBe(false);
    expect(whereOpHolds('10', 'ne', 10)).toBe(false);
    expect(whereOpHolds(undefined, 'ne', 'x')).toBe(true);
    expect(whereOpHolds('vlan-list=30', 'contains', 'list=3')).toBe(true);
    expect(whereOpHolds(undefined, 'contains', '')).toBe(false);
    expect(whereOpHolds(1234, 'contains', 23)).toBe(true);
  });
});

describe('LabCheckResult.misconception (R18)', () => {
  const pass = (notes: { feedback?: string; misconception?: string } = {}): LabAssertion => ({ ...route({ metric: 20 }), ...notes });
  const wrong = (notes: { feedback?: string; misconception?: string } = {}): LabAssertion => ({ ...route({ metric: 99 }), ...notes });
  const lab = (tasks: readonly LabTask[]): ScenarioInfo => ({ name: 'r18', title: 'R18', description: 'R18', category: 'template', build: () => ({}) as never, tasks });
  const task = (id: string, assertions: readonly LabAssertion[]): LabTask => ({ id, title: id, points: 1, assertions }) as LabTask;

  it('a failed task carries the trimmed tag of its first failing assertion that has one', () => {
    const status = evaluateLab(
      world(),
      lab([task('t', [pass({ misconception: 'passed-tag' }), wrong(), wrong({ misconception: '  metric-is-cost  ' }), wrong({ misconception: 'later' })])]),
    );
    const r = status.results[0]!;
    expect(r.pass).toBe(false);
    expect(r.misconception).toBe('metric-is-cost');
    expect(Object.keys(r)).toEqual(['task', 'pass', 'points', 'assertions', 'misconception']);
    expect(JSON.stringify(r.assertions)).not.toContain('metric-is-cost'); // an analytics tag, never shown
  });

  it('a passing task, and a failed one without tags, have no such key; feedback is still shown', () => {
    const status = evaluateLab(
      world(),
      lab([
        task('ok', [pass({ misconception: 'unused' })]),
        task('plain', [wrong({ feedback: 'Compare the costs on both paths.' }), wrong({ misconception: '   ' })]),
      ]),
    );
    expect(status.results.map((r) => Object.keys(r))).toEqual([
      ['task', 'pass', 'points', 'assertions'],
      ['task', 'pass', 'points', 'assertions'],
    ]);
    expect(status.results[1]!.assertions[0]!.detail).toBe(`${INTRA_TEXT}; expected metric 99 (it has 20). Compare the costs on both paths.`);
    expect(status.score).toBe(1);
  });

  it('misconceptionOf reads failing assertions only, in order', () => {
    const a = [pass({ misconception: 'x' }), wrong({ misconception: 'y' })];
    expect(misconceptionOf(a, [{ pass: false }, { pass: false }])).toBe('x');
    expect(misconceptionOf(a, [{ pass: true }, { pass: false }])).toBe('y');
    expect(misconceptionOf(a, [{ pass: true }, { pass: true }])).toBeUndefined();
    expect(misconceptionOf([], [])).toBeUndefined();
  });
});
