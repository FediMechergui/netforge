/**
 * sim.grade.harness — what the headless-grading parity proofs share (ARCHITECTURE-P3 D6 [S37], §2.13; rulings R58 (b)
 * and R59 (a)): `sim.grade.parity.test.ts` (W6 sim, the saved world against the reopened file and the learner's world),
 * `accept.p3.lab-document.test.ts` (the W7 [S37] acceptance row, the saved world against the learner's world) and
 * `sim.grade.test.ts` (the early saves of R58 (b): `savedAt`, `withoutRecord`, `landingOrder`).
 *
 * The learner's world of a lab is the lab as the worker's `loadScenario` loads it (the lab seed, the lab stamp, the
 * scheduled faults injected), booted for 90 s and settled; solving it is the reference solution through `configure` as
 * written, then the actions the lab asks the learner to take before Check (labs 15 and 19: the remote logins; lab 27:
 * the voice burst; lab 38: the RESTCONF requests; lab 40: the run of the inventory script on DEV1 — the lab files give
 * them as data, typed here on the hosts' consoles as labs.ccna3.solutions does), settled.
 *
 * The headless status H of the saved world is compared with a live status (the learner's world L, or the saved world
 * reopened R) under two lists:
 *   • NOT_GRADABLE_HEADLESS_ASSERTIONS — the R58 (b) rule's assertions: every assertion of every CCNA 1–3 lab that reads a
 *     runtime-only table (`runtimeTableOf`, sim/grade.ts). The rule, applied to the labs, must name exactly these (a
 *     lab that gains one fails here until it is listed), and H must report each with the third status, at both points.
 *     They replace the 'learner history' entries the W6 allow-list held (§9.2 W7, R58 (b): "the RELOAD_DIFFERENCES
 *     allow-list becomes that rule").
 *   • RELOAD_DIFFERENCES — against the learner's world only: the assertions whose verdict rests on what a reload resets
 *     and no save records (the err-disabled ports of a P2 world, whose save keeps its P2 bytes; access-list entries
 *     renumbered; device clocks). A listed assertion must really differ (a stale entry fails).
 * Every other assertion must grade alike; a task with neither kind of entry must give the same result; a point with
 * neither must give the same status (`checkedAt` aside against L). `expectHeadlessShape` checks how H counts its
 * not-gradable tasks (never in `score` or `total`; `notGradableHeadless` holds their points).
 */
import { expect } from 'vitest';
import type { DeviceId } from '../src/contracts/ids.js';
import type { LabAssertion, LabCheckResult, LabStatus, ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { Topology } from '../src/contracts/topology.js';
import { NOT_GRADABLE_HEADLESS, notGradableHeadlessDetail, runtimeTableOf, type HeadlessLabStatus } from '../src/sim/grade.js';
import {
  ACL_STANDARD_LOGINS,
  CCNA3_LABS,
  QOS_LEARNER_FLOWS,
  RESTCONF_LAB_REQUESTS,
  SCRIPT_LAB_RUNS,
  SECURE_ACCESS_LOGINS,
} from '../src/sim/scenarios/ccna3/index.js';
import { CCNA1_LABS, CCNA2_LABS } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';

/** Long enough for every model of a lab to boot (the router takes 45 s); `runToIdle` then waits out the elections. */
export const BOOT_NS = 90 * SEC;

/** Clone time after each line a learner types (a remote login's connection, login and logout; a flow command). */
export const LEARNER_LINE_NS = 5 * SEC;

/** Wall-clock budget of one lab: one learner world, and per point the gradings with their clones. */
export const LAB_TEST_TIMEOUT_MS = 180_000;

/** Every CCNA 1–3 lab, in course order (read when a file is collected, so a lab that lands later is covered). */
export const LABS: readonly ScenarioInfo[] = [...CCNA1_LABS, ...CCNA2_LABS, ...CCNA3_LABS];

/** The actions a lab asks the learner to take before Check, as the lab files give them (labs.ccna3.solutions). */
export const LEARNER_ACTIONS: Readonly<Record<string, readonly { readonly from: string; readonly lines: readonly string[] }[]>> = {
  'ccna3-acl-standard': ACL_STANDARD_LOGINS,
  'ccna3-secure-device-access': SECURE_ACCESS_LOGINS,
  'ccna3-qos-voice-first': QOS_LEARNER_FLOWS,
  'ccna3-restconf-change': RESTCONF_LAB_REQUESTS,
  // §9.2 item 40m: lab 40's run of inventory.py on DEV1 (§3.8 step 8), once the solution has fixed SW3
  'ccna3-script-inventory': SCRIPT_LAB_RUNS,
};

export type Point = 'unsolved' | 'solved';

/** One assertion of a lab task, named by its members (a subset of it): exactly one assertion of the task has them all. */
export interface NamedAssertion {
  readonly lab: string;
  readonly task: string;
  readonly assertion: Readonly<Record<string, unknown>>;
}

/**
 * Every assertion of every CCNA 1–3 lab that is not gradable headless (R58 (b), R59 (a)): what the rule names, written
 * out. They are the learner's own history, which a reload empties.
 */
export const NOT_GRADABLE_HEADLESS_ASSERTIONS: readonly NamedAssertion[] = [
  // lab 15: the learner's own SSH logins and the list's vty hits (§11.2 "graded live through the remote terminal")
  { lab: 'ccna3-acl-standard', task: 'vty-logins', assertion: { kind: 'table', table: 'vty-logins', where: { proto: 'ssh', result: 'success', peer: '192.168.10.10' } } },
  { lab: 'ccna3-acl-standard', task: 'vty-logins', assertion: { kind: 'table', table: 'vty-logins', where: { proto: 'ssh', result: 'refused', reason: 'access-class 10' } } },
  ...(['permit', 'deny'] as const).map((action) => ({
    lab: 'ccna3-acl-standard',
    task: 'vty-logins',
    assertion: { kind: 'table', table: 'acl', where: { list: '10', action, lastIface: 'vty' } },
  })),
  // lab 19: the learner's own SSH login, the refused one, and the list's vty refusal
  { lab: 'ccna3-secure-device-access', task: 'own-logins', assertion: { kind: 'table', table: 'vty-logins', where: { proto: 'ssh', peer: '192.168.10.10', user: 'admin', result: 'success' } } },
  { lab: 'ccna3-secure-device-access', task: 'own-logins', assertion: { kind: 'table', table: 'vty-logins', where: { proto: 'ssh', peer: '192.168.10.11', result: 'refused' } } },
  { lab: 'ccna3-secure-device-access', task: 'own-logins', assertion: { kind: 'table', table: 'acl', where: { list: '10', action: 'deny', lastIface: 'vty' } } },
  // lab 27: the learner's voice burst, received as EF at PC-S (§3.5 step 8)
  ...(['mark-voice', 'voice-first'] as const).map((task) => ({
    lab: 'ccna3-qos-voice-first',
    task,
    assertion: { kind: 'table', device: 'PC-S', table: 'flows', where: { src: '192.168.1.10', flow: 'f1', dscp: 46 } },
  })),
  // lab 29: the server's line of the learner's own link change (the solution bounces R1's PC port)
  { lab: 'ccna3-time-and-logs', task: 'syslog', assertion: { kind: 'table', device: 'SRV1', table: 'syslog-messages', whereOps: { message: { op: 'contains', value: '%LINK-3-UPDOWN' } } } },
  // lab 38: the rows the switches' API wrote for the learner's own requests (the GET of SW2's interfaces, the PUT of
  // VLAN 30 to each switch); the VLANs the PUTs created are configuration and grade alike
  { lab: 'ccna3-restconf-change', task: 'read-interfaces', assertion: { kind: 'table', device: 'SW2', table: 'restconf-log' } },
  ...(['SW1', 'SW2', 'SW3'] as const).map((device) => ({ lab: 'ccna3-restconf-change', task: 'through-the-api', assertion: { kind: 'table', device, table: 'restconf-log' } })),
  // lab 40 (R59 (a)): DEV1's `automation.lastRun` fact reads the `script-runs` table; the run's GET of each switch's
  // interfaces is a `restconf-log` row
  { lab: 'ccna3-script-inventory', task: 'inventory-completed', assertion: { kind: 'fact', device: 'DEV1', fact: 'automation.lastRun' } },
  ...(['SW1', 'SW2', 'SW3'] as const).map((device) => ({ lab: 'ccna3-script-inventory', task: 'every-switch-read', assertion: { kind: 'table', device, table: 'restconf-log' } })),
];

/** What a reload resets and no save records, which the learner's world therefore keeps and its save does not. */
export type ReloadReason =
  /** A port a scheduled fault err-disabled in a P2 world works again after a reload (a P2 save keeps its P2 bytes, R58 (b)). */
  | 'err-disabled port (P2 save)'
  /** Access-list entries are renumbered 10, 20, … when the configuration text is read back (D12: `seq` is never rendered). */
  | 'access-list renumbered'
  /** Clocks restart unset on a reload (no hardware calendar, §12 R2 (18)): a source the live clock kept is gone. */
  | 'device clock';

/** One assertion whose verdict differs between the learner's world and its saved copy, and why. */
export interface ReloadDifference extends NamedAssertion {
  readonly point: Point;
  readonly reason: ReloadReason;
}

/** Every gradable assertion of every CCNA 1–3 lab whose headless verdict differs from the learner's live one. */
export const RELOAD_DIFFERENCES: readonly ReloadDifference[] = [
  // the bpduguard err-disable a scheduled fault puts on the port at t = 0 (P2 worlds)
  ...(['errDisabled', 'operUp'] as const).map((field) => ({
    lab: 'ccna2-stp-guards',
    point: 'unsolved' as const,
    task: 'recover-port',
    assertion: { kind: 'port', device: 'AS1', port: 'FastEthernet0/3', field },
    reason: 'err-disabled port (P2 save)' as const,
  })),
  { lab: 'ccna2-stp-guards', point: 'unsolved', task: 'recover-port', assertion: { kind: 'connectivity', from: 'PC3', to: 'SRV' }, reason: 'err-disabled port (P2 save)' },
  ...(['errDisabled', 'operUp'] as const).map((field) => ({
    lab: 'ccna2-troubleshoot-routing',
    point: 'unsolved' as const,
    task: 'server-port',
    assertion: { kind: 'port', device: 'SW2', port: 'FastEthernet0/2', field },
    reason: 'err-disabled port (P2 save)' as const,
  })),
  { lab: 'ccna2-troubleshoot-routing', point: 'unsolved', task: 'server-port', assertion: { kind: 'connectivity', from: 'PC3', to: 'SRV' }, reason: 'err-disabled port (P2 save)' },
  // lab 17: the entries the learner inserted by number (5, and the shifted 10 and 20) read back as 10, 20, 30 …
  ...(
    [
      ['kiosk-first', 'tcp', 'KIOSK', 5],
      ['kiosk-first', 'tcp', 'PC2', 10],
      ['ping-servers', 'icmp', 'PC2', 20],
      ['ping-servers', 'icmp', 'KIOSK', 20],
    ] as const
  ).map(([task, proto, src, entry]) => ({
    lab: 'ccna3-acl-edit-verify',
    point: 'solved' as const,
    task,
    assertion: { kind: 'aclDecision', list: 'SERVERS-IN', packet: { proto, src, dst: 'SRV', ...(proto === 'tcp' ? { dstPort: 80 } : {}) }, entry },
    reason: 'access-list renumbered' as const,
  })),
  // lab 34: both fail either way; only the details move — the moved web entry (35) reads back as 30, the clock the
  // removed server left (`user`) restarts unset
  { lab: 'ccna3-troubleshoot-enterprise', point: 'unsolved', task: 'branch-policy', assertion: { kind: 'aclDecision', list: 'BRANCH-POLICY', packet: { proto: 'tcp', src: 'PC2', dst: 'SRV1', dstPort: 80 }, expect: 'permit' }, reason: 'access-list renumbered' },
  { lab: 'ccna3-troubleshoot-enterprise', point: 'unsolved', task: 'time', assertion: { kind: 'fact', device: 'R2', fact: 'clock.source', equals: 'ntp' }, reason: 'device clock' },
];

/** Device id of a topology name (labs address devices by name, `configure` takes an id). */
export function idOf(sim: Simulation, name: string): DeviceId {
  for (const d of sim.devices()) if (d.spec.name === name) return d.id;
  throw new Error(`no device called ${name} in this lab`);
}

/** The learner's world as `loadScenario` builds it: the lab seed, the lab stamp, its scheduled faults, booted and settled. */
export function learnerWorld(lab: ScenarioInfo): Simulation {
  const sim = createSimulation({ seed: lab.seed ?? 1 });
  sim.loadTopology({ ...lab.build(), lab: { name: lab.name, version: lab.version ?? 1 } });
  for (const f of lab.faults ?? []) sim.injectFault(f.at, f.fault);
  sim.runFor(BOOT_NS);
  sim.runToIdle();
  return sim;
}

/** The reference solution as written, then the actions the lab asks the learner to take before Check, settled. */
export function solve(sim: Simulation, lab: ScenarioInfo): void {
  for (const [name, lines] of Object.entries(lab.solution ?? {})) {
    const r = sim.configure(idOf(sim, name), lines);
    expect(r.lines.filter((l) => !l.ok).map((l) => l.line), `${lab.name}: the solution for ${name} is refused`).toEqual([]);
  }
  sim.runToIdle();
  for (const action of LEARNER_ACTIONS[lab.name] ?? []) {
    const s = sim.cli.open(idOf(sim, action.from), 'console');
    for (const line of action.lines) {
      sim.cli.exec(s, line);
      sim.runFor(LEARNER_LINE_NS);
    }
    sim.cli.close(s);
  }
  sim.runToIdle();
}

// ── ruling R58 (b): the saves that record what a reload would lose ────────────────────────────────────────────

/** When the early saves are taken: every model has started booting, and no scheduled fault (50 s and later) has landed. */
export const EARLY_SAVE_NS = 10 * SEC;

/** The lab's world as the worker loads it, run to `at`, optionally edited, and saved (a JSON copy, as a file holds it). */
export function savedAt(lab: ScenarioInfo, at: number, edit?: (sim: Simulation) => void): Topology {
  const sim = createSimulation({ seed: lab.seed ?? 1 });
  sim.loadTopology({ ...lab.build(), lab: { name: lab.name, version: lab.version ?? 1 } });
  for (const f of lab.faults ?? []) sim.injectFault(f.at, f.fault);
  sim.runUntil(at);
  edit?.(sim);
  return JSON.parse(JSON.stringify(sim.exportTopology())) as Topology;
}

/** The same save without the state R58 (b) records (`lab.pendingFaults`, `lab.errDisabled`): what a save held before W7. */
export function withoutRecord(t: Topology): Topology {
  const { pendingFaults: _p, errDisabled: _e, ...lab } = t.lab!;
  return { ...t, lab };
}

/** The lab's scheduled faults in the order they land (instant, then the order they were injected), as plain data. */
export function landingOrder(lab: ScenarioInfo): unknown[] {
  const faults = (lab.faults ?? []).map((f, i) => ({ f, i }));
  faults.sort((a, b) => a.f.at - b.f.at || a.i - b.i);
  return faults.map(({ f }) => JSON.parse(JSON.stringify(f)) as unknown);
}

/** `v` as JSON with every object's keys sorted, so two values compare by content, whatever their key order. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const o = v as Readonly<Record<string, unknown>>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'undefined';
}

/** Whether `a` has every member of `members`, each equal by content. */
function hasMembers(a: LabAssertion, members: Readonly<Record<string, unknown>>): boolean {
  const own = a as unknown as Readonly<Record<string, unknown>>;
  return Object.entries(members).every(([k, v]) => canonical(own[k]) === canonical(v));
}

/** The assertion indexes of `task` the entries of `list` (for `lab`) name; each entry must match exactly one. */
function namedIndexes(lab: ScenarioInfo, task: string, list: readonly NamedAssertion[], what: string): Set<number> {
  const out = new Set<number>();
  const assertions = lab.tasks?.find((t) => t.id === task)?.assertions ?? [];
  for (const d of list) {
    if (d.lab !== lab.name || d.task !== task) continue;
    const hits = assertions.flatMap((a, i) => (hasMembers(a, d.assertion) ? [i] : []));
    expect(hits, `${lab.name}: ${what} entry ${JSON.stringify(d.assertion)} of task ${task} must name exactly one assertion`).toHaveLength(1);
    out.add(hits[0] as number);
  }
  return out;
}

/** The assertion indexes of `task` that are not gradable headless, by the written-out list. */
export function notGradableIndexes(lab: ScenarioInfo, task: string): Set<number> {
  return namedIndexes(lab, task, NOT_GRADABLE_HEADLESS_ASSERTIONS, 'NOT_GRADABLE_HEADLESS_ASSERTIONS');
}

/** The assertion indexes of `task` that RELOAD_DIFFERENCES names at `point`. */
export function differingIndexes(lab: ScenarioInfo, point: Point, task: string): Set<number> {
  return namedIndexes(lab, task, RELOAD_DIFFERENCES.filter((d) => d.point === point), 'RELOAD_DIFFERENCES');
}

/**
 * The rule (`runtimeTableOf`) names exactly the written-out not-gradable assertions of `lab`: the same indexes, task by
 * task.
 */
export function expectRuleNamesTheList(lab: ScenarioInfo): void {
  for (const task of lab.tasks ?? []) {
    const byRule = task.assertions.flatMap((a, i) => (runtimeTableOf(a) === undefined ? [] : [i]));
    expect(byRule, `${lab.name} task ${task.id}: the assertions R58 (b) makes not gradable headless`).toEqual([...notGradableIndexes(lab, task.id)].sort((x, y) => x - y));
  }
}

/**
 * How H reports and counts what it cannot grade (sim/grade.ts header): each not-gradable assertion is exactly the marker;
 * a task with a failing gradable assertion fails and counts in `total`; a task whose gradable assertions all pass is
 * not gradable (status, 0 points) and counts in `notGradableHeadless` only; `score` is the passing tasks' points; a
 * lab with no such assertion carries no marker at all.
 */
export function expectHeadlessShape(lab: ScenarioInfo, point: Point, headless: HeadlessLabStatus): void {
  const where = `${lab.name} (${point})`;
  const tasks = lab.tasks ?? [];
  expect(headless.results.map((r) => r.task), where).toEqual(tasks.map((t) => t.id));
  let score = 0;
  let total = 0;
  let notGradable = 0;
  headless.results.forEach((r, i) => {
    const task = tasks[i]!;
    const marked = notGradableIndexes(lab, task.id);
    r.assertions.forEach((a, j) => {
      const table = runtimeTableOf(task.assertions[j]!);
      if (marked.has(j)) expect(a, `${where} task ${task.id} assertion ${j}`).toEqual({ index: j, pass: false, detail: notGradableHeadlessDetail(table!), status: NOT_GRADABLE_HEADLESS });
      else expect(a.status, `${where} task ${task.id} assertion ${j}: marked, yet gradable headless`).toBeUndefined();
    });
    if (marked.size === 0) expect(r.status, `${where} task ${task.id}`).toBeUndefined();
    const gradableFailed = r.assertions.some((a, j) => !marked.has(j) && !a.pass);
    if (marked.size > 0 && !gradableFailed) {
      expect(r, `${where} task ${task.id}: not gradable headless`).toMatchObject({ pass: false, points: 0, status: NOT_GRADABLE_HEADLESS });
      notGradable += task.points;
      return;
    }
    expect(r.status, `${where} task ${task.id}`).toBeUndefined();
    expect(r.pass, `${where} task ${task.id}`).toBe(!gradableFailed);
    expect(r.points, `${where} task ${task.id}`).toBe(r.pass ? task.points : 0);
    total += task.points;
    if (r.pass) score += task.points;
  });
  expect([headless.score, headless.total, headless.notGradableHeadless ?? 0], `${where}: score, total, not gradable`).toEqual([score, total, notGradable]);
  if (notGradable === 0) expect(headless, where).not.toHaveProperty('notGradableHeadless');
}

/**
 * H against a live status `live` of the same lab, assertion for assertion: the not-gradable assertions are skipped (H
 * marks them), the assertions `differing` names must differ, every other one must be equal, a task with neither must
 * give the same result, and a point with neither must give the same status (`checkedAt` compared only when
 * `withCheckedAt`). Returns how many assertions were skipped or named.
 */
export function expectParity(
  lab: ScenarioInfo,
  point: Point,
  live: LabStatus,
  headless: HeadlessLabStatus,
  differing: (task: string) => Set<number>,
  against: string,
  withCheckedAt: boolean,
): void {
  const where = `${lab.name} (${point}) against ${against}`;
  expect(headless.lab, where).toBe(live.lab);
  if (withCheckedAt) expect(headless.checkedAt, where).toBe(live.checkedAt);
  expect(headless.total + (headless.notGradableHeadless ?? 0), `${where}: every task's points are graded or not gradable`).toBe(live.total);
  expect(headless.results.map((r) => r.task), where).toEqual(live.results.map((r) => r.task));
  let named = 0;
  live.results.forEach((l: LabCheckResult, i) => {
    const h = headless.results[i]!;
    const skipped = notGradableIndexes(lab, l.task);
    const differs = differing(l.task);
    named += skipped.size + differs.size;
    if (skipped.size === 0 && differs.size === 0) {
      expect(h, `${where} task ${l.task}: the headless result differs`).toEqual(l);
      return;
    }
    expect(h.assertions.length, `${where} task ${l.task}`).toBe(l.assertions.length);
    l.assertions.forEach((la, j) => {
      const ha = h.assertions[j];
      if (skipped.has(j)) return;
      if (differs.has(j)) expect(ha, `${where} task ${l.task} assertion ${j}: listed as a reload difference but grades the same (a stale entry)`).not.toEqual(la);
      else expect(ha, `${where} task ${l.task} assertion ${j}: the headless verdict differs`).toEqual(la);
    });
  });
  if (named === 0) {
    if (withCheckedAt) {
      expect(headless, `${where}: the headless status differs`).toEqual(live);
    } else {
      const { checkedAt: _l, ...l } = live;
      const { checkedAt: _h, ...h } = headless;
      expect(h, `${where}: the headless status differs`).toEqual(l);
    }
  }
}
