/**
 * sim/lab-checks/registry.ts — the grader's checker registry and the feedback envelope (ARCHITECTURE-P3 D5, §2.10,
 * §0 rule 12; §7 W1 sim).
 *
 * CHECKERS maps every `LabAssertion` kind to its checker and is exhaustive by type (`satisfies CheckerTable`): a kind
 * added to the contract without a checker does not compile. It is plain data whose entries read the checker modules
 * at call time (rule 12), so no module is read while this one evaluates. The P1 and P2 checkers (core, switching,
 * routing) are the P2 grader's functions moved verbatim; `neighbor` and `fact` run the data-driven frameworks of
 * facts.ts; the kinds whose checker a later wave item brings — `acl` and `aclDecision` (the W3 acl adapter), [S13]
 * `service`, [S18] `path` and [S20] `traffic` (W5 sim) — fail with the one original detail the W0 stubs gave, until
 * that item replaces the entry (a reviewed edit of this file).
 *
 * `runCheck` is the one dispatch: an unknown kind fails with an original detail, any error a checker throws becomes
 * the failing detail (as the closed switch of the P2 grader did), and the envelope is applied. `checkStatic` is the
 * dispatch for the static checks of `connectivity.then`, graded in the clone itself (no clone host: a follow-up check
 * cannot ping again).
 *
 * The envelope (spec §12.4, `LabAssertionNotes`): a FAILING assertion that carries `feedback` shows it after its own
 * detail, so the learner reads what is wrong and then the author's advice; a passing one shows nothing. `misconception`
 * is an analytics tag and is not shown: `LabCheckResult` has no member that could carry it (reported to the architect
 * in the W1 wave report). P1 and P2 labs carry no notes, so their status is byte-identical (`accept.p3.lab-status`).
 */
import type { LabAssertion, LabAssertionNotes } from '../../contracts/scenario.js';
import type { Simulation } from '../../contracts/simulation.js';
import {
  checkConfig,
  checkConnectivity,
  checkCounter,
  checkLink,
  checkPort,
  checkProcess,
  checkTable,
  checkTraceSeen,
  fail,
  type Check,
  type CloneHost,
} from './core.js';
import { checkFact, checkNeighbor } from './facts.js';
import { checkFhrp, checkNat, checkRoute } from './routing.js';
import { checkEtherchannel, checkPortSecurity, checkStp, checkSwitchport, checkVlan } from './switching.js';

/** @since P3 What a checker is given: the graded world and, for the live world, its clone host. */
export interface CheckContext {
  readonly sim: Simulation;
  /** The live world's clone host; undefined when `sim` is itself a clone (the static checks of `connectivity.then`). */
  readonly host: CloneHost | undefined;
}

/** @since P3 The checker of one assertion kind. */
export type Checker<K extends LabAssertion['kind']> = (ctx: CheckContext, a: Extract<LabAssertion, { kind: K }>) => Check;

/** @since P3 One checker per assertion kind. */
export type CheckerTable = { readonly [K in LabAssertion['kind']]: Checker<K> };

/** @since P3 The details of the kinds whose checker a later wave item brings (the W0 stub texts, unchanged). */
export const UNAVAILABLE_KIND_DETAILS = {
  acl: 'Access list checks are not available in this build.',
  aclDecision: 'Access list decision checks are not available in this build.',
  service: 'Remote login checks are not available in this build.',
  path: 'Path checks are not available in this build.',
  traffic: 'Traffic flow checks are not available in this build.',
} as const satisfies Partial<Record<LabAssertion['kind'], string>>;

/** The refusal of a ping inside `connectivity.then` (the text the P2 grader gives). */
const FOLLOW_UP_PING = 'A follow-up check reads state; it cannot ping again.';

/** @since P3 D5 The checker registry (file header). */
export const CHECKERS = {
  config: (ctx, a) => checkConfig(ctx.sim, a),
  port: (ctx, a) => checkPort(ctx.sim, a),
  table: (ctx, a) => checkTable(ctx.sim, a),
  process: (ctx, a) => checkProcess(ctx.sim, a),
  link: (ctx, a) => checkLink(ctx.sim, a),
  counter: (ctx, a) => checkCounter(ctx.sim, a),
  connectivity: (ctx, a) => (ctx.host === undefined ? fail(FOLLOW_UP_PING) : checkConnectivity(ctx.sim, ctx.host, a, checkStatic)),
  traceSeen: (ctx, a) => checkTraceSeen(ctx.sim, a),
  vlan: (ctx, a) => checkVlan(ctx.sim, a),
  switchport: (ctx, a) => checkSwitchport(ctx.sim, a),
  stp: (ctx, a) => checkStp(ctx.sim, a),
  etherchannel: (ctx, a) => checkEtherchannel(ctx.sim, a),
  portSecurity: (ctx, a) => checkPortSecurity(ctx.sim, a),
  route: (ctx, a) => checkRoute(ctx.sim, a),
  nat: (ctx, a) => checkNat(ctx.sim, a),
  fhrp: (ctx, a) => checkFhrp(ctx.sim, a),
  neighbor: (ctx, a) => checkNeighbor(ctx.sim, a),
  fact: (ctx, a) => checkFact(ctx.sim, a),
  acl: () => fail(UNAVAILABLE_KIND_DETAILS.acl),
  aclDecision: () => fail(UNAVAILABLE_KIND_DETAILS.aclDecision),
  service: () => fail(UNAVAILABLE_KIND_DETAILS.service),
  path: () => fail(UNAVAILABLE_KIND_DETAILS.path),
  traffic: () => fail(UNAVAILABLE_KIND_DETAILS.traffic),
} satisfies CheckerTable;

/** The checker of `kind`, or undefined for a kind this grader does not know (an untyped lab). */
function checkerOf(kind: string): ((ctx: CheckContext, a: LabAssertion) => Check) | undefined {
  if (!Object.prototype.hasOwnProperty.call(CHECKERS, kind)) return undefined;
  return (CHECKERS as unknown as Readonly<Record<string, (ctx: CheckContext, a: LabAssertion) => Check>>)[kind];
}

/** @since P3 The envelope (file header): a failing check with `feedback` shows it after its own detail. */
export function withNotes(r: Check, notes: LabAssertionNotes): Check {
  const feedback = notes.feedback?.trim();
  if (r.pass || feedback === undefined || feedback === '') return r;
  return fail(r.detail === undefined ? feedback : `${r.detail} ${feedback}`);
}

/** @since P3 Grade one assertion (file header): the registry's checker, errors as details, then the envelope. */
export function runCheck(ctx: CheckContext, a: LabAssertion): Check {
  let r: Check;
  try {
    const checker = checkerOf(a.kind);
    r = checker === undefined ? fail(`"${String((a as { kind: string }).kind)}" is not a check this grader knows.`) : checker(ctx, a);
  } catch (e) {
    r = fail(e instanceof Error ? e.message : String(e));
  }
  return withNotes(r, a);
}

/** @since P3 Every kind but `connectivity`, against `sim` (a clone, for `connectivity.then`). */
export function checkStatic(sim: Simulation, a: Exclude<LabAssertion, { kind: 'connectivity' }>): Check {
  return runCheck({ sim, host: undefined }, a);
}
