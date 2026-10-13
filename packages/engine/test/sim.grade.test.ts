/**
 * sim.grade — `gradeTopology(doc, submission)`, headless grading of a lab document (ARCHITECTURE-P3 D6 [S37], §2.13;
 * §7 W6 sim). The parity over every lab is test/sim.grade.parity.test.ts; this file pins the function's own rules
 * (sim/grade.ts header):
 *   • the submission is graded — not the document's own topology — with the document's tasks and name;
 *   • it boots with the submission's seed (the seed of the world it was saved from);
 *   • the document's scheduled faults are not injected (a saved world holds what they changed; injecting one again
 *     undoes a repair), and the world is settled past the last of them, so the "still being prepared" rule never applies;
 *   • except in the document's own topology (an untouched lab file, with or without its lab stamp): that is the lab
 *     before its faults, graded as the worker loads it, so it grades as the live unsolved lab, never as repaired;
 *   • GRADE_SETTLE_MS, then idle: a router's first router advertisement is a periodic timer that `runToIdle` alone
 *     does not wait for, yet the hosts' SLAAC addresses depend on it;
 *   • pure: the same inputs give the same status, neither input changes, nothing is kept between calls;
 *   • a submission the topology schema refuses throws its TopologyLoadError.
 * Ruling R58 (b) (W7 qa):
 *   • what a save of a P3 lab world records — `lab.pendingFaults` (the faults that had not landed, in landing order) and
 *     `lab.errDisabled` (the err-disabled ports and their causes) — and that a P2 save records neither (its bytes);
 *   • every P3 lab with scheduled faults, saved before they land (and after a cosmetic edit), grades on the faulted
 *     network: as the live lab once its faults have landed, never as repaired; a recorded err-disabled port is
 *     err-disabled again, as the live grader's clone does it, where the reopened file would have it working;
 *   • a malformed recorded state throws a TopologyLoadError with its path;
 *   • not gradable headless: `runtimeTableOf` names the assertions that read a runtime-only table (R59 (a): `script-runs`
 *     too, through the `automation.lastRun` fact's source; on `acl`, only an assertion naming a hit member — a row's
 *     list, entry, action or binding is configuration and is graded); `headlessStatus` marks them, keeps a task failed by a
 *     gradable assertion, counts a task it cannot grade in `notGradableHeadless` only, and leaves a lab without them
 *     untouched; lab 40 (every assertion reads a running lab's records) and lab 15 end to end.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../src/contracts/ids.js';
import { labDocumentOf, type LabDocument } from '../src/contracts/lab-document.js';
import type { LabAssertion, LabFactName, LabStatus, LabTask, ScenarioInfo } from '../src/contracts/scenario.js';
import { TopologyLoadError, type Simulation } from '../src/contracts/simulation.js';
import { MS, SEC } from '../src/contracts/time.js';
import type { Topology } from '../src/contracts/topology.js';
import {
  ACL_HIT_MEMBERS,
  GRADE_SETTLE_MS,
  NOT_GRADABLE_HEADLESS,
  RUNTIME_ONLY_TABLES,
  gradeTopology,
  headlessStatus,
  isDocumentTopology,
  lastScheduledFaultAt,
  notGradableHeadlessDetail,
  runtimeTableOf,
  type HeadlessAssertionResult,
  type HeadlessLabStatus,
} from '../src/sim/grade.js';
import { LAB_PREPARING_DETAIL, evaluateLab } from '../src/sim/lab-checks.js';
import { FACT_READERS } from '../src/sim/lab-checks/facts.js';
import { SCENARIOS } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';
import { EARLY_SAVE_NS, landingOrder, learnerWorld, savedAt, solve, withoutRecord } from './sim.grade.harness.js';

/** Long enough for every model of a lab to boot (the router takes 45 s). */
const BOOT_NS = 90 * SEC;

/** Wall-clock budget of one case (one or two lab worlds, a few gradings with their clones). */
const CASE_TIMEOUT_MS = 120_000;

function labNamed(name: string): ScenarioInfo {
  const lab = SCENARIOS.find((s) => s.name === name);
  if (lab === undefined) throw new Error(`no lab ${name}`);
  return lab;
}

function idOf(sim: Simulation, name: string): DeviceId {
  for (const d of sim.devices()) if (d.spec.name === name) return d.id;
  throw new Error(`no device called ${name}`);
}

/** The lab's world as the worker loads it (seed, stamp, scheduled faults), booted, settled, optionally solved; saved. */
function savedWorld(lab: ScenarioInfo, solved: boolean): Topology {
  const sim = createSimulation({ seed: lab.seed ?? 1 });
  sim.loadTopology({ ...lab.build(), lab: { name: lab.name, version: lab.version ?? 1 } });
  for (const f of lab.faults ?? []) sim.injectFault(f.at, f.fault);
  sim.runFor(BOOT_NS);
  sim.runToIdle();
  if (solved) {
    for (const [name, lines] of Object.entries(lab.solution ?? {})) expect(sim.configure(idOf(sim, name), lines).ok).toBe(true);
    sim.runToIdle();
  }
  return sim.exportTopology();
}

/** The live grader on `saved` reopened with `seed`, after GRADE_SETTLE_MS and idle. */
function reopened(lab: ScenarioInfo, saved: Topology, seed: number): LabStatus {
  const sim = createSimulation({ seed });
  sim.loadTopology(saved);
  sim.runFor(GRADE_SETTLE_MS * MS);
  sim.runToIdle();
  return evaluateLab(sim, lab);
}

const every = (s: LabStatus): { pass: boolean; detail?: string }[] => s.results.flatMap((r) => r.assertions);

describe('gradeTopology grades the submission with the document', () => {
  it(
    'grades the saved world, not the document topology, under the document name',
    () => {
      const lab = labNamed('ccna1-default-gateway');
      const doc = labDocumentOf(lab);
      const solved = gradeTopology(doc, savedWorld(lab, true));
      expect(solved.lab).toBe('ccna1-default-gateway');
      expect([solved.score, solved.total]).toEqual([40, 40]);
      // the document's own topology is the lab as built: graded as a submission, it is the unsolved world
      const unsolved = gradeTopology(doc, doc.topology);
      expect([unsolved.score, unsolved.total]).toEqual([0, 40]);
      expect(unsolved.results.every((r) => !r.pass)).toBe(true);
      // the status carries the document's name, whatever the submission's stamp says
      const renamed: LabDocument = { ...doc, meta: { ...doc.meta, name: 'my-copy-of-the-lab' } };
      expect(gradeTopology(renamed, savedWorld(lab, true)).lab).toBe('my-copy-of-the-lab');
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'boots with the submission seed, as the live grader clones the world it was saved from',
    () => {
      const lab = labNamed('ccna1-dhcpv4-server');
      const doc = labDocumentOf(lab);
      const saved = savedWorld(lab, true);
      expect(saved.seed).toBe(doc.meta.seed);
      const other: Topology = { ...saved, seed: saved.seed + 1000 };
      expect(gradeTopology(doc, saved)).toEqual(reopened(lab, saved, saved.seed));
      expect(gradeTopology(doc, other)).toEqual(reopened(lab, other, other.seed));

      // a value the world draws from its seed: a DHCP client's transaction id (`xid:<iface>` stream)
      const xidOf = (seed: number): { device: string; xid: number } => {
        const sim = createSimulation({ seed });
        sim.loadTopology(saved);
        sim.runFor(GRADE_SETTLE_MS * MS);
        sim.runToIdle();
        for (const d of sim.devices()) {
          const view = d.processes.get('dhcp-client')?.stateSnapshot().state as { clients?: { xid: number }[] } | undefined;
          const xid = view?.clients?.[0]?.xid;
          if (xid !== undefined && xid !== 0) return { device: d.spec.name, xid };
        }
        throw new Error('no DHCP client drew a transaction id');
      };
      const own = xidOf(saved.seed);
      expect(xidOf(other.seed).xid).not.toBe(own.xid);
      // a document whose one task is that value, under the document's own seed
      const xidDoc: LabDocument = {
        ...doc,
        tasks: [{ id: 'xid', title: 'The seed', description: '', points: 1, assertions: [{ kind: 'process', device: own.device, process: 'dhcp-client', path: 'clients.0.xid', equals: own.xid }] }],
      };
      expect(gradeTopology(xidDoc, saved).score).toBe(1);
      expect(gradeTopology(xidDoc, other).score).toBe(0);
    },
    CASE_TIMEOUT_MS,
  );
});

describe('scheduled faults', () => {
  it('lastScheduledFaultAt is the latest fault instant, or 0', () => {
    expect(lastScheduledFaultAt(labDocumentOf(labNamed('ccna1-default-gateway')))).toBe(0);
    expect(lastScheduledFaultAt(labDocumentOf(labNamed('ccna2-troubleshoot-vlans')))).toBe(50 * SEC);
    expect(lastScheduledFaultAt(labDocumentOf(labNamed('ccna3-troubleshoot-enterprise')))).toBe(53 * SEC);
  });

  it(
    'injects none (a repair stays repaired) and grades past the last one, never "being prepared"',
    () => {
      const lab = labNamed('ccna2-troubleshoot-vlans');
      const doc = labDocumentOf(lab);
      const saved = savedWorld(lab, true);
      const status = gradeTopology(doc, saved);
      // the three faults would break three tasks again if they were injected
      expect([status.score, status.total]).toEqual([100, 100]);
      expect(status.checkedAt).toBeGreaterThanOrEqual(GRADE_SETTLE_MS * MS);

      // the same faults scheduled after the settle: the world runs to the last of them first
      const late = 150 * SEC;
      const lateDoc: LabDocument = { ...doc, faults: (doc.faults ?? []).map((f, i) => ({ ...f, at: late - i * SEC })) };
      expect(lastScheduledFaultAt(lateDoc)).toBe(late);
      const graded = gradeTopology(lateDoc, saved);
      expect(graded.checkedAt).toBeGreaterThanOrEqual(late);
      expect(every(graded).some((a) => a.detail === LAB_PREPARING_DETAIL)).toBe(false);
      expect([graded.score, graded.total]).toEqual([100, 100]);
    },
    CASE_TIMEOUT_MS,
  );
});

/** The live grader on the lab's world as the worker loads it (seed, stamp, scheduled faults), booted and settled. */
function liveUnsolved(lab: ScenarioInfo): LabStatus {
  const sim = createSimulation({ seed: lab.seed ?? 1 });
  sim.loadTopology({ ...lab.build(), lab: { name: lab.name, version: lab.version ?? 1 } });
  for (const f of lab.faults ?? []) sim.injectFault(f.at, f.fault);
  sim.runFor(BOOT_NS);
  sim.runToIdle();
  return evaluateLab(sim, lab);
}

/** Every CCNA 1–3 lab that schedules faults (the troubleshooting labs and the labs that break a world for the learner). */
const FAULTED_LABS: readonly ScenarioInfo[] = SCENARIOS.filter((s) => /^ccna[1-3]-lab$/.test(s.category) && (s.faults?.length ?? 0) > 0);

describe('the document topology: an untouched lab file grades as the unsolved lab, never as repaired', () => {
  it('covers every CCNA 1–3 lab that schedules faults', () => {
    expect(FAULTED_LABS.map((s) => s.name)).toEqual(
      expect.arrayContaining([
        'ccna2-stp-guards',
        'ccna2-troubleshoot-vlans',
        'ccna2-troubleshoot-routing',
        'ccna3-acl-edit-verify',
        'ccna3-troubleshoot-ospf',
        'ccna3-troubleshoot-eigrp',
        'ccna3-troubleshoot-enterprise',
      ]),
    );
  });

  it('recognises the document topology with or without its lab stamp, and nothing else', () => {
    const lab = labNamed('ccna2-troubleshoot-vlans');
    const doc = labDocumentOf(lab);
    expect(isDocumentTopology(doc, doc.topology)).toBe(true);
    expect(isDocumentTopology(doc, JSON.parse(JSON.stringify(doc.topology)) as Topology)).toBe(true);
    expect(isDocumentTopology(doc, { ...doc.topology, lab: { name: doc.meta.name, version: doc.meta.version } })).toBe(true);
    expect(isDocumentTopology(doc, { ...doc.topology, seed: doc.topology.seed + 1 })).toBe(false);
    expect(isDocumentTopology(doc, { ...doc.topology, devices: doc.topology.devices.slice(1) })).toBe(false);
  });

  for (const lab of FAULTED_LABS) {
    it(
      `${lab.name}: the document topology grades as the live lab once its faults have landed`,
      () => {
        const doc = labDocumentOf(lab);
        const live = liveUnsolved(lab);
        const headless = gradeTopology(doc, doc.topology);
        // no task the unsolved live world fails passes headless (before the fix: up to 100/100 for an untouched file)
        const liveFails = new Set(live.results.filter((r) => !r.pass).map((r) => r.task));
        expect(headless.results.filter((r) => r.pass && liveFails.has(r.task)).map((r) => r.task)).toEqual([]);
        expect(headless.score).toBe(live.score);
        // the same world exactly: the document's seed, every fault at its instant
        const { checkedAt: _h, ...h } = headless;
        const { checkedAt: _l, ...l } = live;
        expect(h).toEqual(l);
        expect(every(headless).some((a) => a.detail === LAB_PREPARING_DETAIL)).toBe(false);
      },
      CASE_TIMEOUT_MS,
    );
  }

  it(
    'the stamped document topology grades the same',
    () => {
      const lab = labNamed('ccna3-troubleshoot-eigrp');
      const doc = labDocumentOf(lab);
      const stamped: Topology = { ...doc.topology, lab: { name: doc.meta.name, version: doc.meta.version } };
      const graded = gradeTopology(doc, stamped);
      expect(graded).toEqual(gradeTopology(doc, doc.topology));
      expect(graded.score).toBeLessThan(graded.total);
    },
    CASE_TIMEOUT_MS,
  );
});

describe('the settle', () => {
  it(
    'waits for the first router advertisement: the SLAAC lab grades in full once saved and reopened',
    () => {
      const lab = labNamed('ccna1-ipv6-slaac');
      const doc = labDocumentOf(lab);
      const saved = savedWorld(lab, true);
      const status = gradeTopology(doc, saved);
      expect([status.score, status.total]).toEqual([100, 100]);
      // runToIdle alone returns once the router has booted, before its first advertisement (a periodic timer)
      const sim = createSimulation({ seed: saved.seed });
      sim.loadTopology(saved);
      sim.runToIdle();
      expect(sim.now).toBeLessThan(GRADE_SETTLE_MS * MS);
      expect(evaluateLab(sim, lab).score).toBeLessThan(100);
    },
    CASE_TIMEOUT_MS,
  );
});

describe('purity', () => {
  it(
    'gives the same status twice and changes neither input',
    () => {
      const lab = labNamed('ccna3-ospf-single-area');
      const doc = labDocumentOf(lab);
      const saved = savedWorld(lab, true);
      const before = JSON.stringify([doc, saved]);
      const first = gradeTopology(doc, saved);
      const second = gradeTopology(doc, saved);
      expect(second).toEqual(first);
      expect(second).not.toBe(first);
      expect(JSON.stringify([doc, saved])).toBe(before);
      expect([first.score, first.total]).toEqual([100, 100]);
    },
    CASE_TIMEOUT_MS,
  );

  it('throws the TopologyLoadError of a submission the topology schema refuses', () => {
    const lab = labNamed('ccna1-default-gateway');
    const doc = labDocumentOf(lab);
    const broken: Topology = { ...doc.topology, devices: [...doc.topology.devices, { id: 'x1', type: 'no.such.model', name: 'X1', position: { logical: [0, 0] } }] };
    expect(() => gradeTopology(doc, broken)).toThrow(TopologyLoadError);
  });
});

// ── ruling R58 (b): what a save of a P3 lab world records, and what headless grading replays ───────────────────

// (the early saves — EARLY_SAVE_NS, savedAt, withoutRecord, landingOrder — are test/sim.grade.harness.ts's, shared with
// the [S37] acceptance row accept.p3.lab-document)

/** The CCNA 3 labs that schedule faults: P3 worlds, whose saves record the faults still pending. */
const P3_FAULTED_LABS: readonly ScenarioInfo[] = FAULTED_LABS.filter((s) => s.build().profile === 'P3');

describe('R58 (b): what a save records', () => {
  it('a P3 lab saved before its faults land records every one, in landing order; after the last has landed, none', () => {
    expect(P3_FAULTED_LABS.map((s) => s.name)).toEqual(
      expect.arrayContaining(['ccna3-acl-edit-verify', 'ccna3-troubleshoot-ospf', 'ccna3-troubleshoot-eigrp', 'ccna3-troubleshoot-enterprise']),
    );
    for (const lab of P3_FAULTED_LABS) {
      const early = savedAt(lab, EARLY_SAVE_NS);
      expect(early.profile, lab.name).toBe('P3');
      expect(early.lab, lab.name).toEqual({ name: lab.name, version: lab.version ?? 1, pendingFaults: landingOrder(lab) });
      expect(Object.keys(early.lab ?? {}), lab.name).toEqual(['name', 'version', 'pendingFaults']);
      // one instant before the last fault lands, only the faults of that instant are still pending
      const last = lastScheduledFaultAt(labDocumentOf(lab));
      const late = savedAt(lab, last - 1);
      expect(late.lab?.pendingFaults, lab.name).toEqual(landingOrder(lab).filter((f) => (f as { at: number }).at === last));
      // once every fault has landed, nothing is pending: the stamp alone, as before
      expect(savedAt(lab, last).lab, lab.name).toEqual({ name: lab.name, version: lab.version ?? 1 });
    }
  });

  it('a P2 lab records neither its pending faults nor its err-disabled ports: its save keeps its P2 bytes', () => {
    const vlans = labNamed('ccna2-troubleshoot-vlans');
    expect((vlans.faults ?? []).length).toBeGreaterThan(0);
    const early = savedAt(vlans, EARLY_SAVE_NS);
    expect(early.profile).toBe('P2');
    expect(early.lab).toEqual({ name: vlans.name, version: vlans.version ?? 1 });
    // the guards lab's bpduguard port is err-disabled live at 90 s, and its save says nothing of it
    const guards = labNamed('ccna2-stp-guards');
    const sim = createSimulation({ seed: guards.seed ?? 1 });
    sim.loadTopology({ ...guards.build(), lab: { name: guards.name, version: guards.version ?? 1 } });
    for (const f of guards.faults ?? []) sim.injectFault(f.at, f.fault);
    sim.runFor(BOOT_NS);
    expect(sim.device(idOf(sim, 'AS1'))?.port('FastEthernet0/3')?.errDisabled).toBe('bpduguard');
    expect(sim.exportTopology().lab).toEqual({ name: guards.name, version: guards.version ?? 1 });
  });
});

describe('R58 (b): a save made before the faults land grades on the faulted network', () => {
  for (const lab of P3_FAULTED_LABS) {
    it(
      `${lab.name}: saved at 10 s, it grades as the live lab once its faults have landed, never as repaired`,
      () => {
        const doc = labDocumentOf(lab);
        const early = savedAt(lab, EARLY_SAVE_NS);
        expect(isDocumentTopology(doc, early)).toBe(false);
        const headless = gradeTopology(doc, early);
        const live = liveUnsolved(lab);
        const { checkedAt: _h, ...h } = headless;
        const { checkedAt: _l, ...l } = live;
        expect(h).toEqual(l);
        expect(every(headless).some((a) => a.detail === LAB_PREPARING_DETAIL)).toBe(false);
        // without the record (a save before W7) the same world was graded as one the faults never broke
        expect(gradeTopology(doc, withoutRecord(early)).results).not.toEqual(headless.results);
      },
      CASE_TIMEOUT_MS,
    );
  }

  it(
    'a cosmetic edit before the faults land (a device moved one unit) keeps the record: still graded on the faulted network',
    () => {
      const lab = labNamed('ccna3-troubleshoot-ospf');
      const doc = labDocumentOf(lab);
      const moved = savedAt(lab, EARLY_SAVE_NS, (sim) => {
        const d = sim.devices()[0]!;
        sim.moveDevice(d.id, { x: d.spec.position.x + 1, y: d.spec.position.y });
      });
      expect(moved.devices[0]!.position.logical[0]).toBe(doc.topology.devices[0]!.position.logical[0] + 1);
      expect(moved.lab?.pendingFaults).toEqual(landingOrder(lab));
      expect(gradeTopology(doc, moved).results).toEqual(liveUnsolved(lab).results);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "a recorded err-disabled port is err-disabled again (the live grader's clone does the same); the reopened file has it working",
    () => {
      const lab = labNamed('ccna3-dhcp-snooping-dai');
      const sim = createSimulation({ seed: lab.seed ?? 1 });
      sim.loadTopology({ ...lab.build(), lab: { name: lab.name, version: lab.version ?? 1 } });
      sim.runFor(BOOT_NS);
      sim.runToIdle();
      const sw1 = idOf(sim, 'SW1');
      sim.injectFault(sim.now, { id: 'test-rate-limit', kind: 'err-disable', target: { device: sw1, port: 'FastEthernet0/5' }, params: { cause: 'dhcp-rate-limit' } });
      sim.runToIdle();
      const saved = JSON.parse(JSON.stringify(sim.exportTopology())) as Topology;
      expect(saved.lab).toEqual({ name: lab.name, version: lab.version ?? 1, errDisabled: [{ device: sw1, port: 'FastEthernet0/5', cause: 'dhcp-rate-limit' }] });
      // a document whose one task reads that port
      const task: LabTask = {
        id: 'attacker-port',
        title: 'The attacker port',
        description: '',
        points: 10,
        assertions: [
          { kind: 'port', device: 'SW1', port: 'FastEthernet0/5', field: 'errDisabled', equals: 'dhcp-rate-limit' },
          { kind: 'port', device: 'SW1', port: 'FastEthernet0/5', field: 'operUp', equals: false },
        ],
      };
      const doc: LabDocument = { ...labDocumentOf(lab), tasks: [task] };
      const portLab: ScenarioInfo = { ...lab, tasks: [task] };
      expect(evaluateLab(sim, portLab).score).toBe(10);
      expect(gradeTopology(doc, saved).score).toBe(10);
      expect(reopened(portLab, saved, saved.seed).score).toBe(0);
      expect(gradeTopology(doc, withoutRecord(saved)).score).toBe(0);
    },
    CASE_TIMEOUT_MS,
  );

  it('a malformed recorded state throws a TopologyLoadError naming its path', () => {
    const lab = labNamed('ccna3-troubleshoot-ospf');
    const doc = labDocumentOf(lab);
    const early = savedAt(lab, EARLY_SAVE_NS);
    const fault = early.lab!.pendingFaults![0]!.fault;
    const cases: [Topology, string][] = [
      [{ ...early, lab: { ...early.lab!, pendingFaults: [{ at: -1, fault }] } }, 'lab.pendingFaults[0].at: must be >= 0'],
      [{ ...early, lab: { ...early.lab!, pendingFaults: [{ at: SEC, fault: { ...fault, kind: 'meltdown' as never } }] } }, 'lab.pendingFaults[0].fault.kind: must be one of'],
      [{ ...early, lab: { name: lab.name, version: 1, errDisabled: [{ device: 'r1', port: 'GigabitEthernet0/0', cause: 'overheated' as never }] } }, 'lab.errDisabled[0].cause: must be one of'],
      [{ ...early, lab: { name: lab.name, version: 1, errDisabled: [{ device: 'r1', port: 'GigabitEthernet0/0', cause: 'fault', extra: 1 } as never] } }, 'lab.errDisabled[0]: unknown keys: extra'],
    ];
    for (const [bad, message] of cases) {
      let thrown: unknown;
      try {
        gradeTopology(doc, bad);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, message).toBeInstanceOf(TopologyLoadError);
      expect((thrown as TopologyLoadError).problems.map((p) => p.message).join('\n'), message).toContain(message);
    }
  });
});

// ── rulings R58 (b) and R59 (a): not gradable headless ──────────────────────────────────────────────────────────

describe('R58 (b): an assertion that reads a runtime-only table is not gradable headless', () => {
  it('runtimeTableOf: a table assertion on a runtime-only table, an acl hit count, a fact whose source names one; nothing else', () => {
    expect(RUNTIME_ONLY_TABLES).toEqual(['vty-logins', 'acl', 'flows', 'syslog-messages', 'restconf-log', 'script-runs']);
    const table = (t: string): LabAssertion => ({ kind: 'table', device: 'R1', table: t, where: {}, exists: true });
    // §9.2 W7 (qa-labdoc, the review's finding on "`acl` hit rows"): the `acl` case names a hit member; the rest as before
    const hitRow: LabAssertion = { kind: 'table', device: 'R1', table: 'acl', where: { lastIface: 'vty' }, exists: true };
    for (const t of RUNTIME_ONLY_TABLES) expect(runtimeTableOf(t === 'acl' ? hitRow : table(t)), t).toBe(t);
    for (const t of ['cam', 'arp', 'rib', 'ospf-neighbors', 'dhcp-snooping', 'ntp-peers', 'clock', 'ipsec-sa']) expect(runtimeTableOf(table(t)), t).toBeUndefined();
    // an `acl` row is configuration (one per entry of a list applied as a filter, rebuilt alike by a reload); only its hit
    // members — in `where` or in `whereOps` — rest on what happened while the lab ran (R58 (b): "`acl` hit rows")
    expect(ACL_HIT_MEMBERS).toEqual(['matches', 'lastPdu', 'lastAt', 'lastIface', 'lastDir', 'updatedAt']);
    const acl = (where: Record<string, string | number>, whereOps?: Record<string, { op: 'ge'; value: number }>): LabAssertion => ({
      kind: 'table',
      device: 'R1',
      table: 'acl',
      where,
      ...(whereOps === undefined ? {} : { whereOps }),
      exists: true,
    });
    expect(runtimeTableOf(acl({ list: '10', applied: 'vty in' }))).toBeUndefined();
    expect(runtimeTableOf(acl({}))).toBeUndefined();
    expect(runtimeTableOf(acl({ list: '10', action: 'deny', entry: 'deny any', type: 'standard' }))).toBeUndefined();
    for (const m of ACL_HIT_MEMBERS) {
      expect(runtimeTableOf(acl({ list: '10', [m]: 1 })), `where ${m}`).toBe('acl');
      expect(runtimeTableOf(acl({ list: '10' }, { [m]: { op: 'ge', value: 1 } })), `whereOps ${m}`).toBe('acl');
    }
    expect(runtimeTableOf(acl({ list: '10', action: 'permit', lastIface: 'vty' }, { matches: { op: 'ge', value: 1 } }))).toBe('acl');
    expect(runtimeTableOf({ kind: 'acl', device: 'R1', list: '10', minMatches: 1 })).toBe('acl');
    expect(runtimeTableOf({ kind: 'acl', device: 'R1', list: '10', entry: 10, minMatches: 1 })).toBe('acl');
    expect(runtimeTableOf({ kind: 'acl', device: 'R1', list: '10', entries: ['permit any'], applied: [{ vty: true, dir: 'in' }] })).toBeUndefined();
    expect(runtimeTableOf({ kind: 'aclDecision', device: 'R1', list: '10', packet: { proto: 'ip', src: 'PC1', dst: 'R1' }, expect: 'permit' })).toBeUndefined();
    // the facts whose reader names a runtime-only table (R59 (a): `script-runs` through `automation.lastRun`)
    const facts = (Object.keys(FACT_READERS) as LabFactName[]).filter((fact) => runtimeTableOf({ kind: 'fact', device: 'R1', fact }) !== undefined);
    expect(facts.sort()).toEqual(['automation.lastRun', 'vty.logins']);
    expect(runtimeTableOf({ kind: 'fact', device: 'DEV1', fact: 'automation.lastRun' })).toBe('script-runs');
    expect(runtimeTableOf({ kind: 'fact', device: 'R1', fact: 'vty.logins', subject: 'ssh' })).toBe('vty-logins');
    // a follow-up check reads the clone's own tables, which grade alike live and headless
    expect(
      runtimeTableOf({ kind: 'connectivity', from: 'PC1', to: 'R1', expect: 'success', then: [{ kind: 'table', device: 'R1', table: 'acl', where: {}, exists: true }] }),
    ).toBeUndefined();
  });

  it('headlessStatus marks them, keeps a task failed by a gradable assertion, and counts a task it cannot grade apart', () => {
    const logins: LabAssertion = { kind: 'table', device: 'R1', table: 'vty-logins', where: { result: 'success' }, exists: true, misconception: 'never-logged-in' };
    const gradable = (misconception?: string): LabAssertion => ({ kind: 'config', device: 'R1', path: 'hostname', equals: 'R1', ...(misconception === undefined ? {} : { misconception }) });
    const task = (id: string, points: number, assertions: LabAssertion[]): LabTask => ({ id, title: id, description: '', points, assertions });
    const tasks = [
      task('configuration', 10, [gradable()]),
      task('fails-anyway', 20, [logins, gradable('wrong-hostname')]),
      task('cannot-tell', 30, [logins, gradable()]),
      task('records-only', 40, [logins]),
      task('records-pass', 5, [logins]),
    ];
    const lab: ScenarioInfo = { name: 'synthetic', title: 'Synthetic', description: '', category: 'lab', build: () => labDocumentOf(labNamed('ccna1-default-gateway')).topology, tasks };
    const live: LabStatus = {
      lab: 'synthetic',
      checkedAt: 7,
      score: 15,
      total: 105,
      results: [
        { task: 'configuration', pass: true, points: 10, assertions: [{ index: 0, pass: true }] },
        { task: 'fails-anyway', pass: false, points: 0, assertions: [{ index: 0, pass: false, detail: 'no row' }, { index: 1, pass: false, detail: 'wrong' }], misconception: 'never-logged-in' },
        { task: 'cannot-tell', pass: false, points: 0, assertions: [{ index: 0, pass: false, detail: 'no row' }, { index: 1, pass: true }], misconception: 'never-logged-in' },
        { task: 'records-only', pass: false, points: 0, assertions: [{ index: 0, pass: false, detail: 'no row' }], misconception: 'never-logged-in' },
        { task: 'records-pass', pass: true, points: 5, assertions: [{ index: 0, pass: true }] },
      ],
    };
    const marker: HeadlessAssertionResult = { index: 0, pass: false, detail: notGradableHeadlessDetail('vty-logins'), status: NOT_GRADABLE_HEADLESS };
    const expected: HeadlessLabStatus = {
      lab: 'synthetic',
      checkedAt: 7,
      score: 10,
      total: 30,
      results: [
        live.results[0]!,
        // a gradable assertion fails, so the task fails as it must live; its tag is the gradable assertion's
        { task: 'fails-anyway', pass: false, points: 0, assertions: [marker, { index: 1, pass: false, detail: 'wrong' }], misconception: 'wrong-hostname' },
        { task: 'cannot-tell', pass: false, points: 0, assertions: [marker, { index: 1, pass: true }], status: NOT_GRADABLE_HEADLESS },
        { task: 'records-only', pass: false, points: 0, assertions: [marker], status: NOT_GRADABLE_HEADLESS },
        // even a record that happens to pass in the graded world is not counted as a pass
        { task: 'records-pass', pass: false, points: 0, assertions: [marker], status: NOT_GRADABLE_HEADLESS },
      ],
      notGradableHeadless: 75,
    };
    expect(headlessStatus(lab, live)).toEqual(expected);
    expect(notGradableHeadlessDetail('script-runs')).toBe(
      'Not graded from a saved file: this check reads the script-runs table, which records what happened while the lab was running and is empty once the file is reopened.',
    );
    // a lab none of whose assertions reads a runtime-only table gets the live status itself
    const plain: ScenarioInfo = { ...lab, tasks: [tasks[0]!] };
    const plainLive: LabStatus = { ...live, score: 10, total: 10, results: [live.results[0]!] };
    expect(headlessStatus(plain, plainLive)).toBe(plainLive);
  });

  it(
    'lab 40: every assertion reads what a running lab records, so its saved world is graded on nothing: 0 / 0, 100 points not gradable',
    () => {
      const lab = labNamed('ccna3-script-inventory');
      const doc = labDocumentOf(lab);
      const sim = learnerWorld(lab);
      const expectNothingGraded = (status: HeadlessLabStatus): void => {
        expect([status.score, status.total, status.notGradableHeadless]).toEqual([0, 0, 100]);
        expect(status.results.map((r) => [r.task, r.pass, r.points, r.status])).toEqual([
          ['inventory-completed', false, 0, NOT_GRADABLE_HEADLESS],
          ['every-switch-read', false, 0, NOT_GRADABLE_HEADLESS],
        ]);
        expect(status.results[0]!.assertions).toEqual([{ index: 0, pass: false, detail: notGradableHeadlessDetail('script-runs'), status: NOT_GRADABLE_HEADLESS }]);
        expect(status.results[1]!.assertions.map((a) => a.detail)).toEqual([0, 1, 2].map(() => notGradableHeadlessDetail('restconf-log')));
      };
      expectNothingGraded(gradeTopology(doc, sim.exportTopology()));
      solve(sim, lab);
      expect(evaluateLab(sim, lab).score).toBe(100);
      expectNothingGraded(gradeTopology(doc, sim.exportTopology()));
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'lab 15: the login task fails headless while its list is not bound to the lines, and is not gradable once it is',
    () => {
      const lab = labNamed('ccna3-acl-standard');
      const doc = labDocumentOf(lab);
      const sim = learnerWorld(lab);
      const before = gradeTopology(doc, sim.exportTopology());
      const loginsBefore = before.results.find((r) => r.task === 'vty-logins')!;
      expect(loginsBefore).not.toHaveProperty('status');
      expect(loginsBefore.assertions.map((a) => a.status ?? (a.pass ? 'pass' : 'fail'))).toEqual([
        NOT_GRADABLE_HEADLESS,
        NOT_GRADABLE_HEADLESS,
        'fail',
        NOT_GRADABLE_HEADLESS,
        NOT_GRADABLE_HEADLESS,
      ]);
      expect(before).not.toHaveProperty('notGradableHeadless');
      expect(before.total).toBe(evaluateLab(sim, lab).total);
      solve(sim, lab);
      const live = evaluateLab(sim, lab);
      expect(live.score).toBe(live.total);
      const after = gradeTopology(doc, sim.exportTopology());
      const loginsAfter = after.results.find((r) => r.task === 'vty-logins')!;
      expect([loginsAfter.pass, loginsAfter.points, loginsAfter.status]).toEqual([false, 0, NOT_GRADABLE_HEADLESS]);
      const points = (lab.tasks ?? []).find((t) => t.id === 'vty-logins')!.points;
      expect([after.score, after.total, after.notGradableHeadless]).toEqual([live.total - points, live.total - points, points]);
    },
    CASE_TIMEOUT_MS,
  );
});
