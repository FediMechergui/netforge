/**
 * P3 acceptance [S37] — labs as data (ARCHITECTURE-P3 D6, §2.13; §7 W7 qa; §10.1 row `accept.p3.lab-document` as
 * ruling R58 (b) amends it, with R59 (a)).
 *
 *   1. Round trip: every built-in lab (CCNA 1–3, course order) becomes a document (`labDocumentOf`); its JSON text
 *      (`labDocumentToJson`) reads back through the zod schema (`labDocumentFromJson`) to a document equal member for
 *      member, with no member added, dropped or left undefined (canonical JSON, keys sorted: the schema writes an
 *      object's keys in its own order, so the texts differ in key order only); and `scenarioOf` of that document builds
 *      a topology deep-equal to the lab's own
 *      `build()`, with the lab's name, title, version, seed, category, course, topic, concept, instructions, tasks,
 *      faults and solution.
 *   2. Versions: test/goldens/lab-versions.json holds, per lab and in course order, its version and the SHA-256 of its
 *      document text. A lab whose document changed while its version did not fails, naming the lab and saying to bump
 *      it; a bumped, new or removed lab fails until the golden is re-recorded (`NF_RECORD_LAB_VERSIONS=<lab,…|all>`), and
 *      re-recording refuses a lab that changed without a bump, or whose version went down, so the golden can never
 *      launder an edit. The checks (`labVersionProblems`, and `recordRefusal` / `recordedLabs`, what re-recording runs)
 *      are pure and are proved on edited copies of a real lab's document.
 *   3. Headless grading: for every lab, unsolved and solved (the learner's world of test/sim.grade.harness.ts), the
 *      headless grade of the saved world — `gradeTopology` with the document that went through the JSON text and the
 *      schema — equals the live grade of the learner's world for every assertion gradable headless, and names the
 *      others: the assertions R58 (b) reports as not gradable headless (a runtime-only table: `vty-logins`, `acl` hit
 *      rows, `flows`, `syslog-messages`, `restconf-log`, `script-runs`; the third status, never counted as a pass or a
 *      fail), and the reload differences no save records (a P2 world's err-disabled ports, renumbered access-list
 *      entries, device clocks). The saved world and the document are left unchanged.
 *   4. What a save records (R58 (b)): every P3 lab that schedules faults, saved at 10 s before any has landed (a JSON
 *      copy), records them as `lab.pendingFaults` in landing order; graded headless from the document text, that save
 *      equals the learner's world graded live at the unsolved point (`checkedAt` aside), and the same save with its
 *      record stripped grades otherwise, so the replay is what grades it. A P3 lab world with an err-disabled port (lab
 *      ccna3-dhcp-snooping-dai, SW1 FastEthernet0/5, cause dhcp-rate-limit) records it with its cause as
 *      `lab.errDisabled`; a port assertion on it grades headless as live, and otherwise once the record is stripped.
 *      Both records survive the app's two save formats (W7 integration finding #3): the save written as plain JSON
 *      (`topologyToJson` → `topologyFromJson`) and as a `.netforge` archive (`writeNetforge` → `readNetforge`) keeps its
 *      `lab` section and grades headless exactly as the export itself does.
 * (The reopened-file comparison and the R58 (b) unit rules are test/sim.grade.parity.test.ts and test/sim.grade.test.ts.)
 *
 * Recording the golden (the architect, or a lab's author after a version bump): `NF_RECORD_LAB_VERSIONS=all` writes every
 * lab, `NF_RECORD_LAB_VERSIONS=<lab,lab>` the named ones (keeping the others), and prints what changed.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { labDocumentOf, scenarioOf, type LabDocument } from '../src/contracts/lab-document.js';
import type { LabTask, ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { Topology } from '../src/contracts/topology.js';
import { labDocumentFromJson, labDocumentToJson } from '../src/io/lab-schema.js';
import { readNetforge, topologyFromJson, topologyToJson, writeNetforge } from '../src/io/netforge-file.js';
import { gradeTopology } from '../src/sim/grade.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import {
  EARLY_SAVE_NS,
  LABS,
  LAB_TEST_TIMEOUT_MS,
  canonical,
  LEARNER_ACTIONS,
  differingIndexes,
  expectHeadlessShape,
  expectParity,
  idOf,
  landingOrder,
  learnerWorld,
  savedAt,
  solve,
  withoutRecord,
  type Point,
} from './sim.grade.harness.js';

// ── 2. the version golden ────────────────────────────────────────────────────────────────────────────────────

/** One lab's entry of test/goldens/lab-versions.json. */
interface LabVersionEntry {
  readonly version: number;
  /** Lower-case hex SHA-256 of the lab's document text (`labDocumentToJson(labDocumentOf(lab))`). */
  readonly sha256: string;
}

/** Contents of test/goldens/lab-versions.json. */
interface LabVersionsGolden {
  readonly about: string;
  readonly labs: Readonly<Record<string, LabVersionEntry>>;
}

const GOLDEN_URL = new URL('./goldens/lab-versions.json', import.meta.url);

const ABOUT =
  'Lab versions ([S37], ARCHITECTURE-P3 §10.1 accept.p3.lab-document), recorded in W7: per built-in lab, in course order, ' +
  'its version and the SHA-256 of its lab document text (labDocumentToJson(labDocumentOf(lab))). Editing a lab without ' +
  'bumping its version fails; after a bump, re-record the lab with NF_RECORD_LAB_VERSIONS=<lab>.';

/** The entry of a document as it is now. */
function entryOf(doc: LabDocument): LabVersionEntry {
  return { version: doc.meta.version, sha256: createHash('sha256').update(labDocumentToJson(doc), 'utf8').digest('hex') };
}

/** Every built-in lab's current entry, in course order. */
function currentEntries(): Record<string, LabVersionEntry> {
  const out: Record<string, LabVersionEntry> = {};
  for (const lab of LABS) out[lab.name] = entryOf(labDocumentOf(lab));
  return out;
}

/**
 * What stands between `current` and `golden` (pure; one line per lab, naming it): an edit without a version bump, a
 * version that went down, a bumped or new lab the golden does not hold yet, a lab the golden holds that is gone.
 */
function labVersionProblems(golden: Readonly<Record<string, LabVersionEntry>>, current: Readonly<Record<string, LabVersionEntry>>): string[] {
  const problems: string[] = [];
  for (const [name, now] of Object.entries(current)) {
    const was = golden[name];
    if (was === undefined) problems.push(`${name}: not in lab-versions.json yet; record it (NF_RECORD_LAB_VERSIONS=${name})`);
    else if (now.sha256 !== was.sha256 && now.version === was.version) {
      problems.push(`${name}: the lab changed but its version is still ${now.version}; bump its version, then record it (NF_RECORD_LAB_VERSIONS=${name})`);
    } else if (now.version < was.version) problems.push(`${name}: its version went down from ${was.version} to ${now.version}`);
    else if (now.version !== was.version || now.sha256 !== was.sha256) {
      problems.push(`${name}: version ${was.version} became ${now.version}; record it (NF_RECORD_LAB_VERSIONS=${name})`);
    }
  }
  for (const name of Object.keys(golden)) if (!(name in current)) problems.push(`${name}: in lab-versions.json but no longer a built-in lab`);
  return problems;
}

let goldenCache: LabVersionsGolden | undefined;

function golden(): LabVersionsGolden {
  if (goldenCache === undefined) {
    if (!existsSync(GOLDEN_URL)) throw new Error('test/goldens/lab-versions.json is missing; record it with NF_RECORD_LAB_VERSIONS=all (P3 §7 W7).');
    goldenCache = JSON.parse(readFileSync(GOLDEN_URL, 'utf8')) as LabVersionsGolden;
  }
  return goldenCache;
}

const RECORD = (process.env['NF_RECORD_LAB_VERSIONS'] ?? '').trim();

/**
 * Why recording `now` over `was` (the golden's entry for `name`, if any) is refused, or undefined when it may be recorded
 * (pure): a version that went down (whatever the document), or a changed document whose version did not go up. A new
 * lab, an unchanged one and a bumped one may be recorded.
 */
function recordRefusal(name: string, was: LabVersionEntry | undefined, now: LabVersionEntry): string | undefined {
  if (was === undefined) return undefined;
  if (now.version < was.version) return `${name}: its version went down from ${was.version} to ${now.version}`;
  if (now.sha256 !== was.sha256 && now.version <= was.version) {
    return `${name} changed without a version bump (still ${now.version}): bump its version before recording it`;
  }
  return undefined;
}

/**
 * The golden's labs once `names` are recorded from `current` over `previous` (pure; throws instead of recording what
 * `recordRefusal` refuses, a name that is not a built-in lab, or a lab left out that the golden does not hold yet).
 */
function recordedLabs(
  previous: Readonly<Record<string, LabVersionEntry>>,
  current: Readonly<Record<string, LabVersionEntry>>,
  names: readonly string[],
): Record<string, LabVersionEntry> {
  for (const name of names) if (!(name in current)) throw new Error(`NF_RECORD_LAB_VERSIONS names ${name}, which is not a built-in lab`);
  const labs: Record<string, LabVersionEntry> = {};
  for (const [name, now] of Object.entries(current)) {
    const was = previous[name];
    if (!names.includes(name)) {
      if (was === undefined) throw new Error(`${name} has no entry in lab-versions.json yet; record it too`);
      labs[name] = was;
      continue;
    }
    const refusal = recordRefusal(name, was, now);
    if (refusal !== undefined) throw new Error(refusal);
    labs[name] = now;
  }
  return labs;
}

/** Record the labs `RECORD` names (`all` = every lab), keeping the others; `recordRefusal` refuses a laundered edit. */
function record(): void {
  const current = currentEntries();
  const names = RECORD === 'all' ? Object.keys(current) : RECORD.split(',').map((s) => s.trim()).filter((s) => s !== '');
  const previous = existsSync(GOLDEN_URL) ? golden().labs : {};
  const labs = recordedLabs(previous, current, names);
  for (const name of names) {
    const was = previous[name];
    const now = labs[name]!;
    if (was !== undefined) console.log(`${name}: ${was.sha256 === now.sha256 && was.version === now.version ? 'unchanged' : `recorded at version ${now.version}`}`);
  }
  const file: LabVersionsGolden = { about: ABOUT, labs };
  writeFileSync(GOLDEN_URL, JSON.stringify(file, null, 2) + '\n', 'utf8');
  goldenCache = file;
}

if (RECORD !== '') record();

// ── 3. headless grading ──────────────────────────────────────────────────────────────────────────────────────

/** The document of `lab` as a file carries it: JSON text read back through the schema. */
function documentFromText(lab: ScenarioInfo): LabDocument {
  return labDocumentFromJson(labDocumentToJson(labDocumentOf(lab)));
}

/** Grade one point of the learner's world: the live grade L against the headless grade H of its save (file header 3). */
function gradePoint(lab: ScenarioInfo, point: Point, sim: Simulation): void {
  const doc = documentFromText(lab);
  const saved = sim.exportTopology();
  const before = JSON.stringify([doc, saved]);
  const live = evaluateLab(sim, lab);
  const headless = gradeTopology(doc, saved);
  expect(JSON.stringify([doc, saved]), `${lab.name} (${point}): grading changed the document or the saved world`).toBe(before);
  expectHeadlessShape(lab, point, headless);
  expectParity(lab, point, live, headless, (task) => differingIndexes(lab, point, task), "the learner's world", false);
}

// ── the cases ────────────────────────────────────────────────────────────────────────────────────────────────

describe('[S37] every built-in lab round-trips JSON → schema → scenario', () => {
  it('covers the CCNA 1, 2 and 3 labs, each once, in course order', () => {
    expect(LABS.length).toBe(15 + 20 + 21);
    expect(new Set(LABS.map((l) => l.name)).size).toBe(LABS.length);
    expect(LABS.map((l) => l.category)).toEqual([...Array(15).fill('ccna1-lab'), ...Array(20).fill('ccna2-lab'), ...Array(21).fill('ccna3-lab')]);
  });

  for (const lab of LABS) {
    it(`${lab.name}: the document text reads back equal, and its scenario builds the lab's topology`, () => {
      const doc = labDocumentOf(lab);
      const text = labDocumentToJson(doc);
      const parsed = labDocumentFromJson(text);
      expect(parsed).toEqual(doc);
      expect(canonical(parsed)).toBe(canonical(JSON.parse(text)));
      expect(canonical(JSON.parse(labDocumentToJson(parsed)))).toBe(canonical(doc));
      const s = scenarioOf(parsed);
      expect(s.build()).toEqual(lab.build());
      // a fresh copy on every call, sharing nothing with the document
      expect(s.build()).not.toBe(s.build());
      expect(s.build()).not.toBe(parsed.topology);
      expect([s.name, s.title, s.version, s.seed, s.category]).toEqual([lab.name, lab.title, lab.version ?? 1, lab.seed ?? lab.build().seed, lab.category]);
      expect([s.course, s.topic, s.concept, s.instructions]).toEqual([lab.course, lab.topic, lab.concept, lab.instructions]);
      expect(s.tasks).toEqual(lab.tasks ?? []);
      expect(s.faults).toEqual(lab.faults);
      expect(s.solution).toEqual(lab.solution);
    });
  }
});

describe('[S37] lab-versions.json: an edited lab needs a version bump', () => {
  it('every built-in lab is recorded at its version and document, in course order', () => {
    const labs = golden().labs;
    expect(Object.keys(labs)).toEqual(LABS.map((l) => l.name));
    expect(labVersionProblems(labs, currentEntries())).toEqual([]);
    for (const entry of Object.values(labs)) expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('an edit without a version bump fails, naming the lab; a bump, a new lab and a removed lab ask for the record', () => {
    const lab = LABS.find((l) => l.name === 'ccna3-script-inventory')!;
    const doc = labDocumentOf(lab);
    const recorded = { [lab.name]: entryOf(doc) };
    expect(labVersionProblems(recorded, { [lab.name]: entryOf(labDocumentOf(lab)) })).toEqual([]);
    // the lab's documents, edited: a task worth more, a scheduled fault, a different topology, another instruction
    const edits: LabDocument[] = [
      { ...doc, tasks: doc.tasks.map((t, i) => (i === 0 ? { ...t, points: t.points + 10 } : t)) },
      { ...doc, faults: [{ at: 0, fault: { id: 'extra', kind: 'cable-cut', target: { link: doc.topology.links[0]!.id } } }] },
      { ...doc, topology: { ...doc.topology, devices: doc.topology.devices.map((d, i) => (i === 0 ? { ...d, name: 'DEV9' } : d)) } },
      { ...doc, meta: { ...doc.meta, instructions: `${doc.meta.instructions ?? ''}\nOne more line.` } },
    ];
    for (const edited of edits) {
      expect(labVersionProblems(recorded, { [lab.name]: entryOf(edited) })).toEqual([
        `${lab.name}: the lab changed but its version is still 1; bump its version, then record it (NF_RECORD_LAB_VERSIONS=${lab.name})`,
      ]);
      const bumped: LabDocument = { ...edited, meta: { ...edited.meta, version: 2 } };
      expect(labVersionProblems(recorded, { [lab.name]: entryOf(bumped) })).toEqual([`${lab.name}: version 1 became 2; record it (NF_RECORD_LAB_VERSIONS=${lab.name})`]);
      // once recorded, the bumped lab is in order again
      expect(labVersionProblems({ [lab.name]: entryOf(bumped) }, { [lab.name]: entryOf(bumped) })).toEqual([]);
      // re-recording (what `NF_RECORD_LAB_VERSIONS=<lab>` runs) refuses the edit without a bump, records the bumped one
      const unbumped = `${lab.name} changed without a version bump (still 1): bump its version before recording it`;
      expect(recordRefusal(lab.name, recorded[lab.name], entryOf(edited))).toBe(unbumped);
      expect(() => recordedLabs(recorded, { [lab.name]: entryOf(edited) }, [lab.name])).toThrow(unbumped);
      expect(recordRefusal(lab.name, recorded[lab.name], entryOf(bumped))).toBeUndefined();
      expect(recordedLabs(recorded, { [lab.name]: entryOf(bumped) }, [lab.name])).toEqual({ [lab.name]: entryOf(bumped) });
      // nor can a later edit launder itself by going back below the recorded version (an edit reverted to version 1)
      const atTwo = { [lab.name]: entryOf(bumped) };
      const wentDown = `${lab.name}: its version went down from 2 to 1`;
      for (const back of [edited, doc]) {
        expect(recordRefusal(lab.name, atTwo[lab.name], entryOf(back))).toBe(wentDown);
        expect(() => recordedLabs(atTwo, { [lab.name]: entryOf(back) }, [lab.name])).toThrow(wentDown);
      }
      // the same version with another document, recorded over a bump: refused as an edit without a bump
      const sameTwo: LabDocument = { ...doc, meta: { ...doc.meta, version: 2 } };
      expect(recordRefusal(lab.name, atTwo[lab.name], entryOf(sameTwo))).toBe(
        `${lab.name} changed without a version bump (still 2): bump its version before recording it`,
      );
    }
    // a lab recorded unchanged, a new lab, and a lab left out of the record keep their entries
    expect(recordedLabs(recorded, recorded, [lab.name])).toEqual(recorded);
    expect(recordedLabs({}, recorded, [lab.name])).toEqual(recorded);
    expect(recordRefusal(lab.name, undefined, recorded[lab.name]!)).toBeUndefined();
    expect(recordedLabs(recorded, { [lab.name]: entryOf({ ...doc, meta: { ...doc.meta, version: 2 } }) }, [])).toEqual(recorded);
    expect(() => recordedLabs({}, recorded, [])).toThrow(`${lab.name} has no entry in lab-versions.json yet; record it too`);
    expect(() => recordedLabs(recorded, recorded, ['no-such-lab'])).toThrow('NF_RECORD_LAB_VERSIONS names no-such-lab, which is not a built-in lab');
    const down: LabDocument = { ...doc, meta: { ...doc.meta, version: 2 } };
    expect(labVersionProblems({ [lab.name]: entryOf(down) }, recorded)).toEqual([`${lab.name}: its version went down from 2 to 1`]);
    expect(labVersionProblems({}, recorded)).toEqual([`${lab.name}: not in lab-versions.json yet; record it (NF_RECORD_LAB_VERSIONS=${lab.name})`]);
    expect(labVersionProblems(recorded, {})).toEqual([`${lab.name}: in lab-versions.json but no longer a built-in lab`]);
  });
});

describe('[S37] headless gradeTopology equals live grading for every assertion gradable headless, and names the others (R58 (b))', () => {
  for (const lab of LABS) {
    it(
      `${lab.name}: the saved world, unsolved and solved, graded from the document text`,
      () => {
        const sim = learnerWorld(lab);
        gradePoint(lab, 'unsolved', sim);
        solve(sim, lab);
        if (lab.solution !== undefined || LEARNER_ACTIONS[lab.name] !== undefined) {
          const solved = evaluateLab(sim, lab);
          expect(solved.score, `${lab.name}: the solution and the learner actions do not earn full marks live`).toBe(solved.total);
        }
        gradePoint(lab, 'solved', sim);
      },
      LAB_TEST_TIMEOUT_MS,
    );
  }
});

// ── 4. what a save of a P3 lab world records, and what gradeTopology replays (R58 (b)) ────────────────────────────

/** The manifest of a `.netforge` save (the caller's timestamps; nothing here reads the clock). */
const SAVE_MANIFEST = { format: 1 as const, app: 'netforge/accept', created: '2026-10-13T10:00:00.000Z', modified: '2026-10-13T10:00:00.000Z' };

/**
 * The save `saved` written in the app's two formats and read back (FileMenu's "Save as JSON" and "Save project"): each
 * keeps the recorded lab section, and `gradeTopology` grades each exactly as it grades the export itself.
 */
function expectSaveFormatsKeepTheRecord(lab: ScenarioInfo, doc: LabDocument, saved: Topology, headless: ReturnType<typeof gradeTopology>): void {
  const reread: readonly [string, Topology][] = [
    ['topologyToJson → topologyFromJson', topologyFromJson(topologyToJson(saved))],
    ['writeNetforge → readNetforge', readNetforge(writeNetforge({ manifest: SAVE_MANIFEST, topology: saved, configs: {} })).topology],
  ];
  for (const [format, back] of reread) {
    expect(back.lab, `${lab.name}: ${format} kept the lab section`).toEqual(saved.lab);
    expect(gradeTopology(doc, back), `${lab.name}: ${format} grades as the export`).toEqual(headless);
  }
}

/** Every built-in lab whose world is P3 and that schedules faults: its save records the faults still pending. */
const P3_FAULTED_LABS: readonly ScenarioInfo[] = LABS.filter((l) => l.build().profile === 'P3' && (l.faults?.length ?? 0) > 0);

/** The lab whose err-disabled port part 4 records: SW1's attacker port, err-disabled by the DHCP rate limit. */
const ERR_DISABLE_LAB = 'ccna3-dhcp-snooping-dai';
const ERR_DISABLE_PORT = 'FastEthernet0/5';

describe('[S37] a P3 lab save records its pending faults and err-disabled ports, which gradeTopology replays (R58 (b))', () => {
  it('covers the CCNA 3 labs that schedule faults', () => {
    expect(P3_FAULTED_LABS.map((l) => l.name)).toEqual(
      expect.arrayContaining(['ccna3-acl-edit-verify', 'ccna3-troubleshoot-ospf', 'ccna3-troubleshoot-eigrp', 'ccna3-troubleshoot-enterprise']),
    );
    for (const lab of P3_FAULTED_LABS) expect(lab.category, lab.name).toBe('ccna3-lab');
  });

  for (const lab of P3_FAULTED_LABS) {
    it(
      `${lab.name}: saved at 10 s, before its faults land, it records them and grades as the learner's world once they have`,
      () => {
        const doc = documentFromText(lab);
        const saved = savedAt(lab, EARLY_SAVE_NS);
        expect(saved.profile).toBe('P3');
        expect(saved.lab, `${lab.name}: the save's lab section`).toEqual({ name: lab.name, version: lab.version ?? 1, pendingFaults: landingOrder(lab) });
        const before = JSON.stringify([doc, saved]);
        const headless = gradeTopology(doc, saved);
        expect(JSON.stringify([doc, saved]), `${lab.name}: grading changed the document or the saved world`).toBe(before);
        expectHeadlessShape(lab, 'unsolved', headless);
        // replayed from t = 0 with the faults at their instants, the save is the learner's world itself: no reload difference
        expectParity(lab, 'unsolved', evaluateLab(learnerWorld(lab), lab), headless, () => new Set(), "the learner's world (save at 10 s)", false);
        // the replay is what grades it so: without its record the same save is a network its faults never broke
        const stripped = gradeTopology(doc, withoutRecord(saved));
        expect(stripped.results, `${lab.name}: graded alike without the recorded faults`).not.toEqual(headless.results);
        // and a file the learner saves (either format) carries the record: it grades as the export does
        expectSaveFormatsKeepTheRecord(lab, doc, saved, headless);
      },
      LAB_TEST_TIMEOUT_MS,
    );
  }

  it(
    `${ERR_DISABLE_LAB}: an err-disabled port is recorded with its cause, and a port assertion on it grades as live`,
    () => {
      const lab = LABS.find((l) => l.name === ERR_DISABLE_LAB)!;
      expect(lab.build().profile).toBe('P3');
      const sim = learnerWorld(lab);
      const stamp = { name: lab.name, version: lab.version ?? 1 };
      expect(sim.exportTopology().lab, 'nothing to record before the port is err-disabled').toEqual(stamp);
      const sw1 = idOf(sim, 'SW1');
      sim.injectFault(sim.now, { id: 'accept-rate-limit', kind: 'err-disable', target: { device: sw1, port: ERR_DISABLE_PORT }, params: { cause: 'dhcp-rate-limit' } });
      sim.runToIdle();
      expect(sim.device(sw1)?.port(ERR_DISABLE_PORT)?.errDisabled).toBe('dhcp-rate-limit');
      const saved = JSON.parse(JSON.stringify(sim.exportTopology())) as Topology;
      expect(saved.lab).toEqual({ ...stamp, errDisabled: [{ device: sw1, port: ERR_DISABLE_PORT, cause: 'dhcp-rate-limit' }] });
      // a document whose one task reads that port
      const task: LabTask = {
        id: 'attacker-port',
        title: 'The attacker port',
        description: '',
        points: 10,
        assertions: [
          { kind: 'port', device: 'SW1', port: ERR_DISABLE_PORT, field: 'errDisabled', equals: 'dhcp-rate-limit' },
          { kind: 'port', device: 'SW1', port: ERR_DISABLE_PORT, field: 'operUp', equals: false },
        ],
      };
      const doc: LabDocument = { ...documentFromText(lab), tasks: [task] };
      const portLab: ScenarioInfo = { ...lab, tasks: [task] };
      const live = evaluateLab(sim, portLab);
      expect([live.score, live.total]).toEqual([10, 10]);
      const headless = gradeTopology(doc, saved);
      expectHeadlessShape(portLab, 'unsolved', headless);
      expectParity(portLab, 'unsolved', live, headless, () => new Set(), "the learner's world (err-disabled port)", false);
      // without the record the reopened port works again: both assertions fail
      const stripped = gradeTopology(doc, withoutRecord(saved));
      expect(stripped.results[0]!.assertions.map((a) => a.pass)).toEqual([false, false]);
      expect([stripped.score, stripped.total]).toEqual([0, 10]);
      // and a file the learner saves (either format) carries the record: it grades as the export does
      expectSaveFormatsKeepTheRecord(portLab, doc, saved, headless);
    },
    LAB_TEST_TIMEOUT_MS,
  );
});
