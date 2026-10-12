/**
 * Lab activation and grading in the worker (ARCHITECTURE-P1 §4.13, §7 "Labs browser").
 *
 * The worker keeps a reference to the active `ScenarioInfo` — the engine only round-trips `topology.lab`, so
 * reopening a saved file looks the lab up by the name the document carried and activates it again. Every lookup goes
 * through `resolveLab(ref)` (ARCHITECTURE-P3 D6 [S37], §7 W6 web-shell), the seam P3b's assessment engine plugs into: a
 * name resolves a built-in scenario, and a lab document (`netforge.lab/1`) resolves through the zod schema of
 * io/lab-schema.ts and `scenarioOf`.
 * Grading is `evaluateLab` (sim/lab-checks.ts), which reads structured state and runs `connectivity` assertions in
 * a disposable clone: it never advances the live clock, emits trace or draws the simulation's rng.
 *
 * Automatic checks are rate-limited (§4.13): at most one every `LAB_CHECK_EVERY_MS` of wall time, and only when a
 * batch carried an event that could have changed the answer (a config line, a table write, a port coming up, a
 * radio association). `check()` (the Labs panel's button, `EngineApi.checkLab`) always evaluates now.
 *
 * ponytail: grading is synchronous inside the worker. A lab is a handful of assertions over a small world, and the
 * clone a `connectivity` assertion builds is bounded by the engine's own caps, so there is nothing to schedule.
 */
import { SCENARIOS, evaluateLab, parseLabDocument, scenarioOf } from '@netforge/engine';
import type { LabDocument, LabStatus, ScenarioInfo, Simulation, TraceEvent, TraceKind } from '@netforge/engine';

/** Wall time between automatic lab evaluations (§4.13). */
export const LAB_CHECK_EVERY_MS = 2000;

/** Events after which a lab's answer may have changed. */
export const LAB_RELEVANT_KINDS: readonly TraceKind[] = Object.freeze(['configChange', 'tableWrite', 'portState', 'assocState']);

const RELEVANT = new Set<string>(LAB_RELEVANT_KINDS);

/** Whether a batch's events warrant an automatic re-check. */
export const labRelevant = (events: readonly TraceEvent[]): boolean => events.some((ev) => RELEVANT.has(ev.kind));

/**
 * @since P3 [S37] What names a lab: a built-in scenario's name (a lab or a template, as `loadScenario` and a saved
 * file's `topology.lab.name` carry it), or a lab document (`netforge.lab/1`, contracts/lab-document.ts).
 */
export type LabRef = string | LabDocument;

/**
 * @since P3 [S37] The scenario a lab reference names (ARCHITECTURE-P3 D6, §7 W6 web-shell).
 *
 *   • a name — the built-in scenario of that name (the first one, as `SCENARIOS.find` did), or undefined when this
 *     build has none: a saved file of a lab from another build reopens as a plain world (P1 §4.13). The version a
 *     saved file carries is not compared, so a file saved before a lab's version bump still reopens its lab.
 *   • a lab document — checked by io/lab-schema.ts (`parseLabDocument`: a document reaching the worker is untrusted
 *     input, whatever its static type) and turned into the lab the engine runs by `scenarioOf`. The document's lab is
 *     returned even when a built-in lab has the same name: the document is what its author wrote. A document the
 *     schema refuses throws the schema's readable, path-qualified Error; it is a wrong file, not a missing lab.
 *
 * Pure: it reads no simulation and keeps nothing, and a document's scenario shares no member with the document.
 */
export function resolveLab(ref: LabRef | undefined): ScenarioInfo | undefined {
  if (ref === undefined) return undefined;
  if (typeof ref === 'string') return SCENARIOS.find((s) => s.name === ref);
  return scenarioOf(parseLabDocument(ref));
}

/** The scenario with this name, if this build has it (`resolveLab` of a name). */
export const scenarioByName = (name: string): ScenarioInfo | undefined => resolveLab(name);

export interface WorkerLabs {
  /** The active lab, or undefined when a plain template (or nothing) is loaded. */
  readonly active: ScenarioInfo | undefined;
  /** Activate a scenario that has tasks; anything else deactivates. */
  activate(scenario: ScenarioInfo | undefined): void;
  /** Reopening a saved file: `topology.lab?.name` resolved by `resolveLab` (§4.13). */
  activateByName(name: string | undefined): void;
  /** Evaluate now (the panel's Check button). Null when no lab is active. */
  check(sim: Simulation): LabStatus | null;
  /**
   * Evaluate after a batch when enough wall time passed and `events` could have changed the answer. Returns the
   * status only when it is worth posting (the first one, or one whose score or per-task results moved).
   */
  maybeCheck(sim: Simulation, events: readonly TraceEvent[], wallNow: number): LabStatus | null;
}

/** Cheap change test: the score and the pass flags are what the panel shows. */
function sameStatus(a: LabStatus | undefined, b: LabStatus): boolean {
  return (
    a !== undefined &&
    a.lab === b.lab &&
    a.score === b.score &&
    a.total === b.total &&
    a.results.length === b.results.length &&
    a.results.every((r, i) => r.pass === b.results[i]?.pass && r.task === b.results[i]?.task)
  );
}

export function createWorkerLabs(): WorkerLabs {
  let active: ScenarioInfo | undefined;
  let last: LabStatus | undefined;
  let lastCheckWall = Number.NEGATIVE_INFINITY;

  function evaluate(sim: Simulation): LabStatus | null {
    if (active === undefined) return null;
    const status = evaluateLab(sim, active);
    last = status;
    return status;
  }

  function activate(scenario: ScenarioInfo | undefined): void {
    active = scenario !== undefined && (scenario.tasks?.length ?? 0) > 0 ? scenario : undefined;
    last = undefined;
    lastCheckWall = Number.NEGATIVE_INFINITY;
  }

  return {
    get active() {
      return active;
    },
    activate,
    activateByName(name) {
      activate(resolveLab(name));
    },
    check(sim) {
      lastCheckWall = Number.NEGATIVE_INFINITY;
      return evaluate(sim);
    },
    maybeCheck(sim, events, wallNow) {
      if (active === undefined) return null;
      if (wallNow - lastCheckWall < LAB_CHECK_EVERY_MS) return null;
      if (!labRelevant(events)) return null;
      lastCheckWall = wallNow;
      const previous = last;
      const status = evaluate(sim);
      if (status === null || sameStatus(previous, status)) return null;
      return status;
    },
  };
}
