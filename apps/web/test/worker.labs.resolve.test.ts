/**
 * The [S37] `resolveLab(ref)` seam of the worker (ARCHITECTURE-P3 D6, §2.13, §7 W6 web-shell; bridge/worker/labs.ts).
 *
 *   • a name resolves the built-in scenario of that name, exactly as `SCENARIOS.find` did (labs and templates alike;
 *     an unknown name, an empty one and no reference resolve to nothing);
 *   • a lab document (`netforge.lab/1`) resolves through io/lab-schema.ts and `scenarioOf`, from the typed document or
 *     from its JSON text parsed, for a lab of each course, a renamed lab no build holds and a template;
 *   • the document wins over a built-in lab of the same name, and its scenario shares nothing with it;
 *   • a document the schema refuses throws the schema's readable, path-qualified Error;
 *   • a document's lab, activated in the worker's lab bookkeeping, grades a live world exactly as the built-in lab does,
 *     unsolved and solved, one lab per course (the CCNA 2 one with scheduled faults, the CCNA 3 one on a P3 world).
 *
 * The labs module is imported directly: nothing here needs the worker or Comlink.
 */
import { describe, expect, it } from 'vitest';
import { SCENARIOS, SEC, createSimulation, labDocumentOf, labDocumentToJson } from '@netforge/engine';
import type { DeviceId, LabDocument, LabStatus, ScenarioInfo, Simulation } from '@netforge/engine';
import { createWorkerLabs, resolveLab, scenarioByName, type LabRef } from '../src/bridge/worker/labs';

/** A small guided CCNA 1 lab: two PCs and a switch the student has to address. */
const CCNA1_LAB = 'ccna1-switched-lan';
/** A CCNA 3 lab on a P3 world. */
const CCNA3_LAB = 'ccna3-ospf-single-area';
/** A plain template (no tasks). */
const TEMPLATE = 'two-pcs-and-switch';

/** Long enough for every model of a lab to boot (a router takes 45 s) and for scheduled faults to land. */
const BOOT_NS = 90 * SEC;

const builtIn = (name: string): ScenarioInfo => {
  const s = SCENARIOS.find((x) => x.name === name);
  if (s === undefined) throw new Error(`this build has no scenario called ${name}`);
  return s;
};

/** The first CCNA 2 lab with scheduled faults (a troubleshooting lab). */
const ccna2Faulted = (): ScenarioInfo => {
  const s = SCENARIOS.find((x) => x.course === 'CCNA 2' && (x.tasks?.length ?? 0) > 0 && (x.faults?.length ?? 0) > 0);
  if (s === undefined) throw new Error('this build has no CCNA 2 lab with scheduled faults');
  return s;
};

/** The document's JSON text parsed back: what a file or a postMessage hands the worker (no class, no shared member). */
const fromJson = (doc: LabDocument): unknown => JSON.parse(labDocumentToJson(doc)) as unknown;

/** Resolve a reference that must name something. */
const resolved = (ref: LabRef): ScenarioInfo => {
  const s = resolveLab(ref);
  if (s === undefined) throw new Error('the reference resolved to nothing');
  return s;
};

/** What a resolved document's lab must keep of the lab the document was made from. */
function expectSameLab(back: ScenarioInfo, lab: ScenarioInfo): void {
  expect(back.build()).toStrictEqual(lab.build());
  expect(back.tasks).toStrictEqual(lab.tasks);
  expect(back.faults).toStrictEqual(lab.faults);
  expect(back.solution).toStrictEqual(lab.solution);
  const kept = (s: ScenarioInfo) => [s.name, s.title, s.course, s.topic, s.seed, s.concept, s.instructions, s.category, s.version ?? 1];
  expect(kept(back)).toStrictEqual(kept(lab));
}

describe('resolveLab: a name', () => {
  it('resolves every built-in scenario by its name, to the scenario itself (the first of that name, as SCENARIOS.find)', () => {
    expect(SCENARIOS.length).toBeGreaterThan(0);
    for (const s of SCENARIOS) expect(resolveLab(s.name), s.name).toBe(SCENARIOS.find((x) => x.name === s.name));
    expect(resolveLab(CCNA1_LAB)).toBe(builtIn(CCNA1_LAB));
    expect(resolveLab(CCNA3_LAB)).toBe(builtIn(CCNA3_LAB));
  });

  it('resolves a template as well as a lab (loadScenario names both)', () => {
    const t = resolved(TEMPLATE);
    expect(t.name).toBe(TEMPLATE);
    expect(t.tasks).toBeUndefined();
  });

  it('resolves nothing for an unknown name, an empty name or no reference', () => {
    expect(resolveLab('no-such-lab')).toBeUndefined();
    expect(resolveLab('')).toBeUndefined();
    expect(resolveLab(undefined)).toBeUndefined();
    // names are exact: no trimming, no case folding
    expect(resolveLab(` ${CCNA1_LAB}`)).toBeUndefined();
    expect(resolveLab(CCNA1_LAB.toUpperCase())).toBeUndefined();
  });

  it('is what scenarioByName and activateByName use', () => {
    for (const name of [CCNA1_LAB, CCNA3_LAB, TEMPLATE, 'no-such-lab']) expect(scenarioByName(name)).toBe(resolveLab(name));
    const labs = createWorkerLabs();
    labs.activateByName(CCNA3_LAB);
    expect(labs.active).toBe(builtIn(CCNA3_LAB));
    labs.activateByName('no-such-lab');
    expect(labs.active).toBeUndefined();
  });
});

describe('resolveLab: a lab document', () => {
  it.each([
    ['a CCNA 1 lab', () => builtIn(CCNA1_LAB)],
    ['a CCNA 2 lab with scheduled faults', ccna2Faulted],
    ['a CCNA 3 lab', () => builtIn(CCNA3_LAB)],
  ] as const)('resolves %s through the schema and scenarioOf, typed or as parsed JSON', (_what, lab) => {
    const s = lab();
    const doc = labDocumentOf(s);
    for (const ref of [doc, fromJson(doc) as LabDocument]) {
      const back = resolved(ref);
      // a fresh scenario, never the built-in object
      expect(back).not.toBe(s);
      expectSameLab(back, s);
      // derived by scenarioOf: the sorted set of the topology's device types
      expect(back.requires).toStrictEqual([...new Set(s.build().devices.map((d) => d.type))].sort());
    }
  });

  it('resolves a document no build holds (a renamed, re-versioned lab), with the category of its course', () => {
    const doc = fromJson(labDocumentOf(builtIn(CCNA1_LAB))) as LabDocument;
    const own: LabDocument = { ...doc, meta: { ...doc.meta, name: 'my-own-lab', title: 'My own lab', version: 3 } };
    expect(resolveLab('my-own-lab')).toBeUndefined();
    const back = resolved(own);
    expect(back.name).toBe('my-own-lab');
    expect(back.title).toBe('My own lab');
    expect(back.version).toBe(3);
    expect(back.category).toBe('ccna1-lab');
    expect(back.build()).toStrictEqual(builtIn(CCNA1_LAB).build());
    // without a course, a document with tasks is a plain lab
    const { course: _course, ...meta } = own.meta;
    expect(resolved({ ...own, meta }).category).toBe('lab');
  });

  it('resolves a template document to a scenario with no tasks, which the lab bookkeeping does not activate', () => {
    const back = resolved(labDocumentOf(builtIn(TEMPLATE)));
    expect(back.category).toBe('template');
    expect(back.tasks).toEqual([]);
    expect(back.build()).toStrictEqual(builtIn(TEMPLATE).build());
    const labs = createWorkerLabs();
    labs.activate(back);
    expect(labs.active).toBeUndefined();
  });

  it('the document wins over the built-in lab of the same name', () => {
    const lab = builtIn(CCNA1_LAB);
    const doc = fromJson(labDocumentOf(lab)) as LabDocument;
    const first = doc.tasks[0];
    if (first === undefined) throw new Error(`${CCNA1_LAB} has no task`);
    const edited: LabDocument = {
      ...doc,
      meta: { ...doc.meta, title: 'An edited copy' },
      tasks: [{ ...first, points: first.points + 5 }, ...doc.tasks.slice(1)],
    };
    const back = resolved(edited);
    expect(back.name).toBe(CCNA1_LAB);
    expect(back.title).toBe('An edited copy');
    expect(back.tasks).toHaveLength(doc.tasks.length);
    expect(back.tasks?.[0]?.points).toBe(first.points + 5);
    expect(back.tasks?.slice(1)).toStrictEqual(doc.tasks.slice(1));
    // the built-in lab is untouched
    expect(resolveLab(CCNA1_LAB)).toBe(lab);
    expect(lab.title).not.toBe('An edited copy');
  });

  it('shares nothing with the document: editing the document afterwards changes nothing resolved', () => {
    const lab = builtIn(CCNA1_LAB);
    const doc = fromJson(labDocumentOf(lab)) as { meta: { title: string }; topology: { devices: { name: string }[] }; tasks: { id: string }[] };
    const back = resolved(doc as unknown as LabDocument);
    const before = { topo: back.build(), tasks: structuredClone(back.tasks), title: back.title };
    doc.meta.title = 'changed';
    for (const d of doc.topology.devices) d.name = `${d.name}-changed`;
    for (const t of doc.tasks) t.id = `${t.id}-changed`;
    expect(back.title).toBe(before.title);
    expect(back.build()).toStrictEqual(before.topo);
    expect(back.tasks).toStrictEqual(before.tasks);
    // and every build() is a fresh copy
    expect(back.build()).not.toBe(back.build());
  });

  it('refuses a wrong document with the schema readable, path-qualified Error', () => {
    const doc = fromJson(labDocumentOf(builtIn(CCNA1_LAB))) as LabDocument;
    expect(() => resolveLab({} as LabDocument)).toThrow(/^Invalid lab document: \d+ issues?/);
    expect(() => resolveLab({ ...doc, format: 'netforge.lab/2' } as unknown as LabDocument)).toThrow(/Invalid lab document[\s\S]*format/);
    expect(() => resolveLab(null as unknown as LabDocument)).toThrow(/Invalid lab document/);
    expect(() => resolveLab(42 as unknown as LabDocument)).toThrow(/Invalid lab document/);

    // a reference: a task's assertion names a device the topology does not have
    const first = doc.tasks[0];
    if (first === undefined) throw new Error(`${CCNA1_LAB} has no task`);
    const ghost = { kind: 'config', device: 'NO-SUCH-DEVICE', path: 'hostname', equals: 'X' };
    const bad = { ...doc, tasks: [{ ...first, assertions: [ghost] }, ...doc.tasks.slice(1)] } as unknown as LabDocument;
    expect(() => resolveLab(bad)).toThrow(/tasks\[0\]\.assertions\[0\]\.device: unknown device "NO-SUCH-DEVICE"/);

    // a misspelt member is refused, never dropped
    const misspelt = { ...doc, meta: { ...doc.meta, titel: 'x' } } as unknown as LabDocument;
    expect(() => resolveLab(misspelt)).toThrow(/Invalid lab document[\s\S]*meta/);
  });
});

// ── grading parity: a document's lab grades a live world as the built-in lab does ──────────────────────────────────

/** The lab's world as `loadScenario` builds it: the lab seed, the lab topology, its scheduled faults, booted and settled. */
function labWorld(lab: ScenarioInfo): Simulation {
  const sim = createSimulation({ seed: lab.seed ?? 1 });
  sim.loadTopology({ ...lab.build(), lab: { name: lab.name, version: lab.version ?? 1 } });
  // the worker injects a lab's scheduled faults right after the load (bridge/worker applyFaults)
  for (const f of lab.faults ?? []) sim.injectFault(f.at, f.fault);
  sim.runFor(BOOT_NS);
  sim.runToIdle();
  return sim;
}

/** Device id of a topology name (labs address devices by name, `configure` takes an id). */
function idOf(sim: Simulation, name: string): DeviceId {
  for (const d of sim.devices()) if (d.spec.name === name) return d.id;
  throw new Error(`no device called ${name} in this lab`);
}

/** Apply the lab's reference solution, every line accepted, then settle. */
function applySolution(sim: Simulation, lab: ScenarioInfo): void {
  for (const [name, lines] of Object.entries(lab.solution ?? {})) {
    const r = sim.configure(idOf(sim, name), lines);
    expect(r.lines.filter((l) => !l.ok).map((l) => l.line), `${lab.name} solution for ${name}`).toEqual([]);
  }
  sim.runToIdle();
}

/** The status the worker's lab bookkeeping posts for `lab` on `sim` (the panel's Check button). */
function checkWith(sim: Simulation, lab: ScenarioInfo | undefined): LabStatus | null {
  const labs = createWorkerLabs();
  labs.activate(lab);
  return labs.check(sim);
}

describe('resolveLab: a document grades as its built-in lab', () => {
  it.each([
    ['a CCNA 1 lab', () => builtIn(CCNA1_LAB)],
    ['a CCNA 2 lab with scheduled faults', ccna2Faulted],
    ['a CCNA 3 lab', () => builtIn(CCNA3_LAB)],
  ] as const)(
    '%s: unsolved and solved, the same status',
    (_what, lab) => {
      const s = lab();
      const fromDoc = resolveLab(fromJson(labDocumentOf(s)) as LabDocument);
      // the world is the document's lab's world: built from the document, not from the built-in lab
      const sim = labWorld(fromDoc ?? s);

      const unsolved = checkWith(sim, fromDoc);
      expect(unsolved).not.toBeNull();
      expect(unsolved?.lab).toBe(s.name);
      expect(unsolved).toStrictEqual(checkWith(sim, s));
      expect(unsolved?.score).toBeLessThan(unsolved?.total ?? 0);

      applySolution(sim, fromDoc ?? s);
      const solved = checkWith(sim, fromDoc);
      expect(solved).toStrictEqual(checkWith(sim, s));
      expect(solved?.score).toBe(solved?.total);
    },
    60_000,
  );
});
