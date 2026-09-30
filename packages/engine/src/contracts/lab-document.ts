/**
 * [S37] Labs as data — the P3b seam (ARCHITECTURE-P3 §2.13, D6). @since P3
 *
 * A `LabDocument` (format `netforge.lab/1`, the spec §13.1 `activity.json`) is a built-in lab as plain, structured-clone
 * safe data: its metadata, the topology its `build()` returns (exported), its tasks with their assertions, its scheduled
 * faults and its reference solution. The zod schema (`io/lab-schema.ts`), `labDocumentOf(s)` / `scenarioOf(doc)` (W5
 * io) and the headless `gradeTopology(doc, submission)` (`sim/grade.ts`, W6 sim) implement it; this file holds the
 * type only (W0, §0 rule 3).
 *
 * Two members differ from the §2.13 sketch so that the round trip and headless grading the brief requires can work:
 * `tasks` carries `LabTask` (the assertions the grader evaluates), not `LabTaskMeta`, and `faults` keeps each fault's
 * `at`, as `ScenarioInfo.faults` does (accepted as built, ruling R9). The pure helpers `labDocumentOf` / `scenarioOf`
 * land with the [S37] item as a reviewed additive edit (ruling R8).
 */
import type { FaultSpec } from './events.js';
import type { ConceptToolId, LabTask } from './scenario.js';
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
