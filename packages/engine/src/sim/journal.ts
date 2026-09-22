/**
 * sim/journal.ts — the input journal recorder behind time travel (ARCHITECTURE-P2 D18, §2.13, §3.13 step 1) [SHOULD S1].
 *
 * The Simulation facade owns one recorder. Every mutating facade method runs through `apply(op, fn)`: when the call is
 * OUTERMOST (depth 0) and recording is on, the recorder notes `{at: position(), op, traceHead}` — the world's position
 * BEFORE the call, a `structuredClone` of the op taken BEFORE the call runs (a caller that mutates its spec afterwards
 * cannot change the journal), and the trace head right AFTER it. A call that throws is recorded with `threw: true` and
 * the error is rethrown, so a replay expects (and swallows) the same failure.
 *
 * Depth is what keeps the §2.13 rules: a facade method reached from inside another one (`removeDevice` closing
 * sessions and removing links, `sim.configure` going through the CLI wrapper's `configure`) or from inside a dispatch
 * (`handleFault` config fragments, `userCommand` events calling `cli.exec`) sees depth > 0 and records nothing. The
 * run methods (`runUntil`, `step`, …) are not inputs — a replay reaches positions by event count — but they run
 * `nested`, so nothing dispatched inside them can ever record.
 *
 * `reset(origin)` starts a new journal (construction, and `loadTopology`, whose origin holds the counters from BEFORE
 * the load). `journal()` hands out a structured-clone copy; the recorder's own arrays never leave this module.
 *
 * Pure bookkeeping: no clock, no randomness, no I/O.
 */
import type { JournalEntry, JournalOp, JournalOrigin, JournalPosition, SimJournal } from '../contracts/journal.js';

/** What the recorder reads from the facade at record time. */
export interface JournalRecorderHost {
  /** The world's position (`Simulation.position()`). */
  position(): JournalPosition;
  /** The facade's trace head (cursor of the next event to be emitted). */
  traceHead(): number;
}

/** The recorder the facade drives (file header). */
export interface JournalRecorder {
  /** True when recording is on (`SimulationOptions.journal`, default true). */
  readonly enabled: boolean;
  /** Current call depth: 0 between facade calls. */
  readonly depth: number;
  /** Entries recorded since the last `reset` (a live view for the facade; never handed out). */
  readonly length: number;
  /** Start a new journal from `origin` (deep-copied). */
  reset(origin: JournalOrigin): void;
  /**
   * Run `fn` as a facade call. Records `op` when this is the outermost call and recording is on; a call that throws
   * is recorded with `threw: true` and the error is rethrown. `op` undefined runs `fn` nested (never recorded).
   */
  apply<T>(op: JournalOp | undefined, fn: () => T): T;
  /** Run `fn` at depth + 1: neither it nor anything it calls records. */
  nested<T>(fn: () => T): T;
  /** A structured-clone copy of the journal. */
  journal(): SimJournal;
  /** The origin (a structured-clone copy). */
  origin(): JournalOrigin;
}

/**
 * Order two positions: by `dispatched`, then by `now` (a world at the same event count can only have advanced its
 * clock). Negative when `a` is before `b`, 0 when equal, positive when after.
 */
export function comparePositions(a: JournalPosition, b: JournalPosition): number {
  if (a.dispatched !== b.dispatched) return a.dispatched < b.dispatched ? -1 : 1;
  if (a.now !== b.now) return a.now < b.now ? -1 : 1;
  return 0;
}

/** True when `p` is a well-formed position (non-negative safe integers). */
export function isJournalPosition(p: unknown): p is JournalPosition {
  if (p === null || typeof p !== 'object') return false;
  const r = p as Record<string, unknown>;
  const ok = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  return ok(r['dispatched']) && ok(r['now']);
}

/** Create a recorder. `origin` is the journal's first origin; `enabled` false keeps the origin but records no entry. */
export function createJournalRecorder(host: JournalRecorderHost, origin: JournalOrigin, enabled = true): JournalRecorder {
  let current: JournalOrigin = structuredClone(origin);
  let entries: JournalEntry[] = [];
  let depth = 0;

  const nested = <T>(fn: () => T): T => {
    depth++;
    try {
      return fn();
    } finally {
      depth--;
    }
  };

  return {
    get enabled(): boolean {
      return enabled;
    },
    get depth(): number {
      return depth;
    },
    get length(): number {
      return entries.length;
    },
    reset(next: JournalOrigin): void {
      current = structuredClone(next);
      entries = [];
    },
    apply<T>(op: JournalOp | undefined, fn: () => T): T {
      if (op === undefined || !enabled || depth > 0) return nested(fn);
      const at = host.position();
      const copy = structuredClone(op);
      let threw = false;
      depth++;
      try {
        return fn();
      } catch (e) {
        threw = true;
        throw e;
      } finally {
        depth--;
        const entry: JournalEntry = threw ? { at, op: copy, traceHead: host.traceHead(), threw: true } : { at, op: copy, traceHead: host.traceHead() };
        entries.push(entry);
      }
    },
    nested,
    journal(): SimJournal {
      return structuredClone({ version: 1 as const, origin: current, entries });
    },
    origin(): JournalOrigin {
      return structuredClone(current);
    },
  };
}
