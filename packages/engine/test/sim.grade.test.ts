/**
 * sim.grade — `gradeTopology(doc, submission)`, headless grading of a lab document (ARCHITECTURE-P3 D6 [S37], §2.13;
 * §7 W6 sim). The parity over every lab is test/sim.grade.parity.test.ts; this file pins the function's own rules
 * (sim/grade.ts header):
 *   • the submission is graded — not the document's own topology — with the document's tasks and name;
 *   • it boots with the submission's seed (the seed of the world it was saved from);
 *   • scheduled faults are not injected (a saved world holds what they changed; injecting one again undoes a repair),
 *     and the world is settled past the last of them, so the "still being prepared" rule never applies;
 *   • except in the document's own topology (an untouched lab file, with or without its lab stamp): that is the lab
 *     before its faults, graded as the worker loads it, so it grades as the live unsolved lab, never as repaired;
 *   • GRADE_SETTLE_MS, then idle: a router's first router advertisement is a periodic timer that `runToIdle` alone
 *     does not wait for, yet the hosts' SLAAC addresses depend on it;
 *   • pure: the same inputs give the same status, neither input changes, nothing is kept between calls;
 *   • a submission the topology schema refuses throws its TopologyLoadError.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../src/contracts/ids.js';
import { labDocumentOf, type LabDocument } from '../src/contracts/lab-document.js';
import type { LabStatus, ScenarioInfo } from '../src/contracts/scenario.js';
import { TopologyLoadError, type Simulation } from '../src/contracts/simulation.js';
import { MS, SEC } from '../src/contracts/time.js';
import type { Topology } from '../src/contracts/topology.js';
import { GRADE_SETTLE_MS, gradeTopology, isDocumentTopology, lastScheduledFaultAt } from '../src/sim/grade.js';
import { LAB_PREPARING_DETAIL, evaluateLab } from '../src/sim/lab-checks.js';
import { SCENARIOS } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';

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
