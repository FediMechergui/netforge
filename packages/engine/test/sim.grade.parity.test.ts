/**
 * sim.grade.parity — headless `gradeTopology` against live grading over every CCNA 1–3 lab built so far
 * (ARCHITECTURE-P3 D6 [S37], §2.13; §7 W6 sim; the W7 row `accept.p3.lab-document` builds on it).
 *
 * GENERIC over `CCNA1_LABS`, `CCNA2_LABS` and `CCNA3_LABS` (read when the file is collected, so a lab that lands later
 * is covered without an edit here). For each lab, ONE live world plays the learner: the lab loaded as the worker's
 * `loadScenario` loads it (the lab seed, the lab stamp, the scheduled faults injected), booted for 90 s and settled.
 * At two points of that world —
 *   • UNSOLVED: as loaded, every scheduled fault landed;
 *   • SOLVED: the reference solution through `configure` as written, then the actions the lab asks the learner to take
 *     before Check (labs 15 and 19: the remote logins; lab 27: the voice burst; lab 38: the RESTCONF requests — the lab
 *     files give them as data, typed here on the hosts' consoles as labs.ccna3.solutions does), settled. There the live
 *     grader must give every lab with a solution full marks, so a lab whose learner actions are missing from
 *     LEARNER_ACTIONS fails here instead of passing vacuously —
 * the world is saved (`exportTopology`) and three statuses are taken:
 *   L  the live grader on the learner's world (`evaluateLab(world, lab)`), what the app shows on Check;
 *   H  `gradeTopology(labDocumentOf(lab), saved)`, the headless grade of the saved world from the lab's document;
 *   R  the live grader on the saved world reopened in a fresh session: the saved seed, the file loaded (a reopened
 *      file activates its lab by name and injects no scheduled fault, P1 §4.13), GRADE_SETTLE_MS of simulated time,
 *      then idle, then Check with the built-in lab.
 * Asserted:
 *   1. H equals R exactly, `checkedAt` included: grading the saved world from the document on a server equals grading
 *      it in the app once it is reopened (the document carries everything grading needs, and the submission — not the
 *      document's own topology — is what is graded, with the submission's seed and profile).
 *   2. H equals L assertion for assertion, `checkedAt` aside, EXCEPT exactly the assertions RELOAD_DIFFERENCES names:
 *      a saved world carries configuration, power, cabling and host files, not runtime state, so a verdict that rests
 *      on what a reload resets differs. Each entry names the lab, the point, the task, the assertion (by its members,
 *      not its index, so an assertion added elsewhere in the task does not move it) and why. A listed assertion must
 *      really differ (a stale entry fails), every other assertion and every task without an entry must be equal, and
 *      with no entry at the point the whole status must be equal (score included).
 *   3. Grading reads its inputs only: the saved world and the document are unchanged by `gradeTopology`.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../src/contracts/ids.js';
import { labDocumentOf } from '../src/contracts/lab-document.js';
import type { LabAssertion, LabCheckResult, LabStatus, ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { MS, SEC } from '../src/contracts/time.js';
import type { Topology } from '../src/contracts/topology.js';
import { GRADE_SETTLE_MS, gradeTopology, isDocumentTopology } from '../src/sim/grade.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { ACL_STANDARD_LOGINS, CCNA3_LABS, QOS_LEARNER_FLOWS, RESTCONF_LAB_REQUESTS, SECURE_ACCESS_LOGINS } from '../src/sim/scenarios/ccna3/index.js';
import { CCNA1_LABS, CCNA2_LABS } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';

/** Long enough for every model of a lab to boot (the router takes 45 s); `runToIdle` then waits out the elections. */
const BOOT_NS = 90 * SEC;

/** Clone time after each line a learner types (a remote login's connection, login and logout; a flow command). */
const LEARNER_LINE_NS = 5 * SEC;

/** Wall-clock budget of one lab: one learner world, and per point three gradings with their clones. */
const LAB_TEST_TIMEOUT_MS = 180_000;

/** The actions a lab asks the learner to take before Check, as the lab files give them (labs.ccna3.solutions). */
const LEARNER_ACTIONS: Readonly<Record<string, readonly { readonly from: string; readonly lines: readonly string[] }[]>> = {
  'ccna3-acl-standard': ACL_STANDARD_LOGINS,
  'ccna3-secure-device-access': SECURE_ACCESS_LOGINS,
  'ccna3-qos-voice-first': QOS_LEARNER_FLOWS,
  'ccna3-restconf-change': RESTCONF_LAB_REQUESTS,
};

type Point = 'unsolved' | 'solved';

/** What a reload resets, which a saved world therefore cannot carry. */
type ReloadReason =
  /** A port a scheduled fault err-disabled works again after a reload (err-disable is runtime port state). */
  | 'err-disabled port'
  /** Access-list entries are renumbered 10, 20, … when the configuration text is read back (D12: `seq` is never rendered). */
  | 'access-list renumbered'
  /** Clocks restart unset on a reload (no hardware calendar, §12 R2 (18)): a source the live clock kept is gone. */
  | 'device clock'
  /** Rows the learner's own actions wrote — remote logins, list hit counts, a generated flow, a syslog line — are
   *  runtime tables a reload empties. */
  | 'learner history';

/** One assertion whose verdict differs between the learner's world and its saved copy, and why. */
interface ReloadDifference {
  readonly lab: string;
  readonly point: Point;
  readonly task: string;
  /** Members the assertion has (a subset of it); exactly one assertion of the task must have them all. */
  readonly assertion: Readonly<Record<string, unknown>>;
  readonly reason: ReloadReason;
}

/** Every assertion of every CCNA 1–3 lab whose headless verdict differs from the live one (file header, 2). */
const RELOAD_DIFFERENCES: readonly ReloadDifference[] = [
  // the bpduguard err-disable a scheduled fault puts on the port at t = 0
  ...(['errDisabled', 'operUp'] as const).map((field) => ({
    lab: 'ccna2-stp-guards',
    point: 'unsolved' as const,
    task: 'recover-port',
    assertion: { kind: 'port', device: 'AS1', port: 'FastEthernet0/3', field },
    reason: 'err-disabled port' as const,
  })),
  { lab: 'ccna2-stp-guards', point: 'unsolved', task: 'recover-port', assertion: { kind: 'connectivity', from: 'PC3', to: 'SRV' }, reason: 'err-disabled port' },
  ...(['errDisabled', 'operUp'] as const).map((field) => ({
    lab: 'ccna2-troubleshoot-routing',
    point: 'unsolved' as const,
    task: 'server-port',
    assertion: { kind: 'port', device: 'SW2', port: 'FastEthernet0/2', field },
    reason: 'err-disabled port' as const,
  })),
  { lab: 'ccna2-troubleshoot-routing', point: 'unsolved', task: 'server-port', assertion: { kind: 'connectivity', from: 'PC3', to: 'SRV' }, reason: 'err-disabled port' },
  // lab 15: the learner's own SSH logins and the list's vty hits (§11.2 "graded live through the remote terminal")
  { lab: 'ccna3-acl-standard', point: 'solved', task: 'vty-logins', assertion: { kind: 'table', table: 'vty-logins', where: { proto: 'ssh', result: 'success', peer: '192.168.10.10' } }, reason: 'learner history' },
  { lab: 'ccna3-acl-standard', point: 'solved', task: 'vty-logins', assertion: { kind: 'table', table: 'vty-logins', where: { proto: 'ssh', result: 'refused', reason: 'access-class 10' } }, reason: 'learner history' },
  ...(['permit', 'deny'] as const).map((action) => ({
    lab: 'ccna3-acl-standard',
    point: 'solved' as const,
    task: 'vty-logins',
    assertion: { kind: 'table', table: 'acl', where: { list: '10', action, lastIface: 'vty' } },
    reason: 'learner history' as const,
  })),
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
  // lab 19: the learner's own SSH login, the refused one, and the list's vty refusal
  { lab: 'ccna3-secure-device-access', point: 'solved', task: 'own-logins', assertion: { kind: 'table', table: 'vty-logins', where: { proto: 'ssh', peer: '192.168.10.10', user: 'admin', result: 'success' } }, reason: 'learner history' },
  { lab: 'ccna3-secure-device-access', point: 'solved', task: 'own-logins', assertion: { kind: 'table', table: 'vty-logins', where: { proto: 'ssh', peer: '192.168.10.11', result: 'refused' } }, reason: 'learner history' },
  { lab: 'ccna3-secure-device-access', point: 'solved', task: 'own-logins', assertion: { kind: 'table', table: 'acl', where: { list: '10', action: 'deny', lastIface: 'vty' } }, reason: 'learner history' },
  // lab 27: the learner's voice burst, received as EF at PC-S (§3.5 step 8)
  ...(['mark-voice', 'voice-first'] as const).map((task) => ({
    lab: 'ccna3-qos-voice-first',
    point: 'solved' as const,
    task,
    assertion: { kind: 'table', device: 'PC-S', table: 'flows', where: { src: '192.168.1.10', flow: 'f1', dscp: 46 } },
    reason: 'learner history' as const,
  })),
  // lab 29: the server's line of the learner's own link change (the solution bounces R1's PC port)
  { lab: 'ccna3-time-and-logs', point: 'solved', task: 'syslog', assertion: { kind: 'table', device: 'SRV1', table: 'syslog-messages', whereOps: { message: { op: 'contains', value: '%LINK-3-UPDOWN' } } }, reason: 'learner history' },
  // lab 38: the rows the switches' API wrote for the learner's own requests (the GET of SW2's interfaces, the PUT of
  // VLAN 30 to each switch); the VLANs the PUTs created are configuration and grade the same. Each task reads one
  // restconf-log row per switch, so the device and the table name the assertion.
  { lab: 'ccna3-restconf-change', point: 'solved', task: 'read-interfaces', assertion: { kind: 'table', device: 'SW2', table: 'restconf-log' }, reason: 'learner history' },
  ...(['SW1', 'SW2', 'SW3'] as const).map((device) => ({
    lab: 'ccna3-restconf-change',
    point: 'solved' as const,
    task: 'through-the-api',
    assertion: { kind: 'table', device, table: 'restconf-log' },
    reason: 'learner history' as const,
  })),
  // lab 34: both fail either way; only the details move — the moved web entry (35) reads back as 30, the clock the
  // removed server left (`user`) restarts unset
  { lab: 'ccna3-troubleshoot-enterprise', point: 'unsolved', task: 'branch-policy', assertion: { kind: 'aclDecision', list: 'BRANCH-POLICY', packet: { proto: 'tcp', src: 'PC2', dst: 'SRV1', dstPort: 80 }, expect: 'permit' }, reason: 'access-list renumbered' },
  { lab: 'ccna3-troubleshoot-enterprise', point: 'unsolved', task: 'time', assertion: { kind: 'fact', device: 'R2', fact: 'clock.source', equals: 'ntp' }, reason: 'device clock' },
];

/** Every lab this parity covers, in course order (read when the file is collected). */
const LABS: readonly ScenarioInfo[] = [...CCNA1_LABS, ...CCNA2_LABS, ...CCNA3_LABS];

/** Device id of a topology name (labs address devices by name, `configure` takes an id). */
function idOf(sim: Simulation, name: string): DeviceId {
  for (const d of sim.devices()) if (d.spec.name === name) return d.id;
  throw new Error(`no device called ${name} in this lab`);
}

/** The learner's world as `loadScenario` builds it: the lab seed, the lab stamp, its scheduled faults, booted and settled. */
function learnerWorld(lab: ScenarioInfo): Simulation {
  const sim = createSimulation({ seed: lab.seed ?? 1 });
  sim.loadTopology({ ...lab.build(), lab: { name: lab.name, version: lab.version ?? 1 } });
  for (const f of lab.faults ?? []) sim.injectFault(f.at, f.fault);
  sim.runFor(BOOT_NS);
  sim.runToIdle();
  return sim;
}

/** The reference solution as written, then the actions the lab asks the learner to take before Check, settled. */
function solve(sim: Simulation, lab: ScenarioInfo): void {
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

/** R: the saved file reopened in a fresh session and checked once settled (file header). */
function reopenedStatus(lab: ScenarioInfo, saved: Topology): LabStatus {
  const sim = createSimulation({ seed: saved.seed });
  sim.loadTopology(saved);
  sim.runFor(GRADE_SETTLE_MS * MS);
  sim.runToIdle();
  return evaluateLab(sim, lab);
}

/** `v` as JSON with every object's keys sorted, so two values compare by content, whatever their key order. */
function canonical(v: unknown): string {
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

/** The assertion indexes of `task` that RELOAD_DIFFERENCES names at this point (each entry matches exactly one). */
function differingIndexes(lab: ScenarioInfo, point: Point, task: string): Set<number> {
  const out = new Set<number>();
  const assertions = lab.tasks?.find((t) => t.id === task)?.assertions ?? [];
  for (const d of RELOAD_DIFFERENCES) {
    if (d.lab !== lab.name || d.point !== point || d.task !== task) continue;
    const hits = assertions.flatMap((a, i) => (hasMembers(a, d.assertion) ? [i] : []));
    expect(hits, `${lab.name} ${point}: RELOAD_DIFFERENCES entry ${JSON.stringify(d.assertion)} of task ${task} must name exactly one assertion`).toHaveLength(1);
    out.add(hits[0] as number);
  }
  return out;
}

/** Assertion 2 of the file header: H against L, with the named reload differences. */
function expectLiveParity(lab: ScenarioInfo, point: Point, live: LabStatus, headless: LabStatus): void {
  const where = `${lab.name} (${point})`;
  expect(headless.lab, where).toBe(live.lab);
  expect(headless.total, where).toBe(live.total);
  expect(headless.results.map((r) => r.task), where).toEqual(live.results.map((r) => r.task));
  let named = 0;
  live.results.forEach((l: LabCheckResult, i) => {
    const h = headless.results[i] as LabCheckResult;
    const differing = differingIndexes(lab, point, l.task);
    named += differing.size;
    if (differing.size === 0) {
      expect(h, `${where} task ${l.task}: the headless result differs from the live one`).toEqual(l);
      return;
    }
    expect(h.assertions.length, `${where} task ${l.task}`).toBe(l.assertions.length);
    l.assertions.forEach((la, j) => {
      const ha = h.assertions[j];
      if (differing.has(j)) expect(ha, `${where} task ${l.task} assertion ${j}: listed as a reload difference but grades the same (a stale entry)`).not.toEqual(la);
      else expect(ha, `${where} task ${l.task} assertion ${j}: the headless verdict differs from the live one`).toEqual(la);
    });
  });
  if (named === 0) {
    const { checkedAt: _l, ...l } = live;
    const { checkedAt: _h, ...h } = headless;
    expect(h, `${where}: the headless status differs from the live one`).toEqual(l);
  }
}

/** Grade one point: L, H and R, with assertions 1–3 of the file header. */
function gradePoint(lab: ScenarioInfo, point: Point, sim: Simulation): void {
  const doc = labDocumentOf(lab);
  const saved = sim.exportTopology();
  const docText = JSON.stringify(doc);
  const savedText = JSON.stringify(saved);
  // a booted world's save is never the document's own topology (that one is graded with its scheduled faults)
  expect(isDocumentTopology(doc, saved), `${lab.name} (${point}): the saved world reads as the document's topology`).toBe(false);
  const live = evaluateLab(sim, lab);
  const headless = gradeTopology(doc, saved);
  expect(JSON.stringify(doc), `${lab.name} (${point}): gradeTopology changed the document`).toBe(docText);
  expect(JSON.stringify(saved), `${lab.name} (${point}): gradeTopology changed the submission`).toBe(savedText);
  expect(headless, `${lab.name} (${point}): the headless status differs from the reopened file's`).toEqual(reopenedStatus(lab, saved));
  expectLiveParity(lab, point, live, headless);
}

describe('RELOAD_DIFFERENCES names labs, points and tasks that exist', () => {
  it('every entry names a lab of the parity and a task of that lab', () => {
    for (const d of RELOAD_DIFFERENCES) {
      const lab = LABS.find((l) => l.name === d.lab);
      expect(lab, `${d.lab} is not a CCNA 1–3 lab`).toBeDefined();
      expect(lab?.tasks?.some((t) => t.id === d.task), `${d.lab} has no task ${d.task}`).toBe(true);
    }
  });
});

describe('gradeTopology equals live grading', () => {
  it('covers every CCNA 1, 2 and 3 lab built so far', () => {
    expect(LABS.length).toBeGreaterThanOrEqual(15 + 20 + 19);
    expect(new Set(LABS.map((l) => l.name)).size).toBe(LABS.length);
  });

  for (const lab of LABS) {
    it(
      `${lab.name}: the saved world, unsolved and solved, grades as live`,
      () => {
        const sim = learnerWorld(lab);
        gradePoint(lab, 'unsolved', sim);
        solve(sim, lab);
        if (lab.solution !== undefined || LEARNER_ACTIONS[lab.name] !== undefined) {
          // the solved point is solved: a lab whose learner actions are missing from LEARNER_ACTIONS fails here
          const solved = evaluateLab(sim, lab);
          expect(solved.score, `${lab.name}: the solution and the learner actions do not earn full marks live`).toBe(solved.total);
        }
        gradePoint(lab, 'solved', sim);
      },
      LAB_TEST_TIMEOUT_MS,
    );
  }
});
