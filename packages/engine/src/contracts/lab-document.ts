/**
 * [S37] Labs as data — the P3b seam (ARCHITECTURE-P3 §2.13, D6). @since P3
 *
 * A `LabDocument` (format `netforge.lab/1`, the spec §13.1 `activity.json`) is a built-in lab as plain, structured-clone
 * safe data: its metadata, the topology its `build()` returns (exported), its tasks with their assertions, its scheduled
 * faults and its reference solution. The zod schema (`io/lab-schema.ts`), `labDocumentOf(s)` / `scenarioOf(doc)` (W5
 * io) and the headless `gradeTopology(doc, submission)` (`sim/grade.ts`, W6 sim) implement it; W0 wrote the type only
 * (§0 rule 3), and the two pure helpers below joined in W5.
 *
 * Two members differ from the §2.13 sketch so that the round trip and headless grading the brief requires can work:
 * `tasks` carries `LabTask` (the assertions the grader evaluates), not `LabTaskMeta`, and `faults` keeps each fault's
 * `at`, as `ScenarioInfo.faults` does (accepted as built, ruling R9). The pure helpers `labDocumentOf` / `scenarioOf`
 * land with the [S37] item as a reviewed additive edit (ruling R8).
 */
import type { FaultSpec } from './events.js';
import type { ConceptToolId, LabTask, ScenarioCategory, ScenarioInfo } from './scenario.js';
import type { SimTime } from './time.js';
import type { Topology } from './topology.js';

/** @since P3 [S37] One lab as data. */
export interface LabDocument {
  readonly format: 'netforge.lab/1';
  readonly meta: {
    name: string;
    version: number;
    title: string;
    course?: string;
    topic?: string;
    seed: number;
    concept?: ConceptToolId;
    instructions?: string;
  };
  /** The build() result, exported. */
  readonly topology: Topology;
  readonly tasks: readonly LabTask[];
  readonly faults?: readonly { readonly at: SimTime; readonly fault: FaultSpec }[];
  readonly solution?: Readonly<Record<string, readonly string[]>>;
}

// ── [S37] the pure helpers (W5 io; ruling R8: a reviewed additive edit of this file) ──────────────────────────────

/**
 * @since P3 [S37] A copy of `v` made only of plain data: arrays and objects are copied member by member, and an object
 * member whose value is `undefined` is left out (JSON would drop it), so `JSON.parse(JSON.stringify(copy))` equals the
 * copy strictly. Primitives are returned as they are.
 */
function plainCopy<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x: unknown) => plainCopy(x)) as T;
  if (typeof v === 'object' && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = plainCopy(x);
    return out as T;
  }
  return v;
}

/**
 * @since P3 [S37] The category a document's lab is listed under, which the document does not carry: `ccna<n>-lab` for
 * the course `CCNA <n>` (every built-in lab), else `template` for a document with no tasks and `lab` for one with tasks.
 */
function labCategoryOf(course: string | undefined, tasks: number): ScenarioCategory {
  const n = course === undefined ? undefined : /^CCNA ([1-9])$/.exec(course)?.[1];
  if (n !== undefined) return `ccna${n}-lab`;
  return tasks === 0 ? 'template' : 'lab';
}

/**
 * @since P3 [S37] A built-in lab as a document: its metadata, the topology its `build()` returns, its tasks with their
 * assertions, its scheduled faults and its reference solution, all copied as plain data (no member is shared with the
 * lab, and no member is `undefined`, so the JSON text of the document parses back to an equal document). A lab without
 * a `version` is version 1; one without a `seed` takes its topology's seed. The members a document has no place for
 * (`description`, `category`, `labType`, `objectives`, `tags`, `difficulty`, `estimatedMinutes` and `requires`) are
 * left out. Pure: calls `s.build()` once.
 */
export function labDocumentOf(s: ScenarioInfo): LabDocument {
  const topology = s.build();
  const meta: LabDocument['meta'] = { name: s.name, version: s.version ?? 1, title: s.title, seed: s.seed ?? topology.seed };
  if (s.course !== undefined) meta.course = s.course;
  if (s.topic !== undefined) meta.topic = s.topic;
  if (s.concept !== undefined) meta.concept = s.concept;
  if (s.instructions !== undefined) meta.instructions = s.instructions;
  const doc: { -readonly [K in keyof LabDocument]: LabDocument[K] } = {
    format: 'netforge.lab/1',
    meta,
    topology: plainCopy(topology),
    tasks: plainCopy(s.tasks ?? []),
  };
  if (s.faults !== undefined) doc.faults = plainCopy(s.faults);
  if (s.solution !== undefined) doc.solution = plainCopy(s.solution);
  return doc;
}

/**
 * @since P3 [S37] The lab a document describes, as the engine runs it: `build()` returns a fresh copy of the document's
 * topology on every call, and tasks, faults and solution are copies taken now. The members the document does not carry
 * are derived: `requires` is the sorted set of the topology's device types, `category` is `ccna<n>-lab` for the course
 * `CCNA <n>` (else `template` without tasks, `lab` with tasks) and `description` is empty. So, for every built-in lab
 * `s`, `scenarioOf(labDocumentOf(s)).build()` deep-equals `s.build()`, and its tasks, faults and solution equal the
 * lab's. The document is trusted as given; validate untrusted input with `io/lab-schema.ts` first.
 */
export function scenarioOf(doc: LabDocument): ScenarioInfo {
  const { meta } = doc;
  const topology = plainCopy(doc.topology);
  const s: ScenarioInfo = {
    name: meta.name,
    title: meta.title,
    description: '',
    category: labCategoryOf(meta.course, doc.tasks.length),
    requires: [...new Set(topology.devices.map((d) => d.type))].sort(),
    seed: meta.seed,
    version: meta.version,
    build: () => plainCopy(topology),
    tasks: plainCopy(doc.tasks),
  };
  if (meta.course !== undefined) s.course = meta.course;
  if (meta.topic !== undefined) s.topic = meta.topic;
  if (meta.concept !== undefined) s.concept = meta.concept;
  if (meta.instructions !== undefined) s.instructions = meta.instructions;
  if (doc.faults !== undefined) s.faults = plainCopy(doc.faults);
  if (doc.solution !== undefined) s.solution = plainCopy(doc.solution);
  return s;
}
