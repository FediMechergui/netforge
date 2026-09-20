/**
 * Lab activation and grading in the worker (ARCHITECTURE-P1 §4.13, §7 "Labs browser").
 *
 * The worker keeps a reference to the active `ScenarioInfo` — the engine only round-trips `topology.lab`, so
 * reopening a saved file looks the lab up in `SCENARIOS` by the name the document carried and activates it again.
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
import { SCENARIOS, evaluateLab } from '@netforge/engine';
import type { LabStatus, ScenarioInfo, Simulation, TraceEvent, TraceKind } from '@netforge/engine';

/** Wall time between automatic lab evaluations (§4.13). */
export const LAB_CHECK_EVERY_MS = 2000;

/** Events after which a lab's answer may have changed. */
export const LAB_RELEVANT_KINDS: readonly TraceKind[] = Object.freeze(['configChange', 'tableWrite', 'portState', 'assocState']);

const RELEVANT = new Set<string>(LAB_RELEVANT_KINDS);

/** Whether a batch's events warrant an automatic re-check. */
export const labRelevant = (events: readonly TraceEvent[]): boolean => events.some((ev) => RELEVANT.has(ev.kind));

/** The scenario with this name, if this build has it. */
export const scenarioByName = (name: string): ScenarioInfo | undefined => SCENARIOS.find((s) => s.name === name);

export interface WorkerLabs {
  /** The active lab, or undefined when a plain template (or nothing) is loaded. */
  readonly active: ScenarioInfo | undefined;
  /** Activate a scenario that has tasks; anything else deactivates. */
  activate(scenario: ScenarioInfo | undefined): void;
  /** Reopening a saved file: `topology.lab?.name` looked up in SCENARIOS (§4.13). */
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
      activate(name === undefined ? undefined : scenarioByName(name));
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
