/**
 * timeline/convergence.ts — measure control-plane convergence from the trace (ARCHITECTURE-P3C §2.10, D7, ruling R-13)
 * [S8]. The `convergence` lab kind (sim/lab-checks/convergence.ts, W3b) and the convergence panel (web, W3b) hand it the
 * events a fault clone emitted after its faults; it is pure.
 *
 * A CHANGE is one trace event at or after `opts.from` that lies in one of the protocol's lanes
 * (`CONVERGENCE_LANES`, through `laneOf` of timeline/lanes.ts) and is a state change:
 *   • a `tableWrite` whose row differs from its `previous` once VOLATILE_ROW_KEYS are ignored (a refresh that only
 *     moves `updatedAt` / `expiresAt` is not a change; a write without `previous` is), or a `tableExpire`;
 *   • a `debug` with `event.fsm` (a state-machine transition, D19).
 * Other kinds in a lane (`portState`, `linkState`, `configChange`, `drop`) are the fault or its consequences, never the
 * protocol's convergence, so they are not changes. `opts.devices` keeps the changes of those devices only.
 * `opts.only` narrows the routing lane to one daemon: its machines (`ospf-*`, `ospf6-*` / `eigrp-*`), its tables (the
 * same prefixes) and the rib / rib6 rows it owns (`source` 'O' / 'EIGRP' on the row or on its `previous`).
 *
 * SETTLED: the first change after which `quietMs` (default CONVERGENCE_QUIET_MS[protocol]) passes with no further
 * change — the next change is at least `quietMs` later, or, for the last change, the end of the window is. `settledAt`
 * is that change's instant (the protocol has converged when its last change happened), `durationNs` = settledAt −
 * from, `changes` counts the changes up to and including it, and `last` names it: its cursor (`firstCursor` + its index
 * in `events`), its device and its subject (`<table>:<key>` or `<machine>:<subject>`). With no change at all the
 * protocol never moved: settledAt = from (duration 0) once the window reaches `from + quietMs`. A window that ends
 * before a quiet period follows the last change gives `settledAt: null`.
 *
 * The end of the window is `opts.to` when the caller gives it (the convergence check gives `from + windowMs`), else the
 * instant of the last event handed in (any kind), else `from`. `to` and `firstCursor` are local options beside the
 * contract's `ConvergenceOptions` (no contract member is added).
 *
 * Pure: no state, no clock, no rng; the events are read in the order given (trace order, `t` non-decreasing).
 */
import type { DeviceId } from '../contracts/ids.js';
import { MS, type SimTime } from '../contracts/time.js';
import {
  CONVERGENCE_LANES,
  CONVERGENCE_QUIET_MS,
  VOLATILE_ROW_KEYS,
  type ConvergenceOptions,
  type ConvergenceResult,
} from '../contracts/timeline.js';
import type { TraceEvent } from '../contracts/trace.js';
import { laneOf } from './lanes.js';

/** @since P3c [S8] `ConvergenceOptions` plus the window end and the cursor of `events[0]` (file header). */
export interface MeasureConvergenceOptions extends ConvergenceOptions {
  /** The end of the measured window; default: the last event's instant, else `from`. */
  readonly to?: SimTime;
  /** The ring cursor of `events[0]` (default 0), so `last.cursor` addresses the ring. */
  readonly firstCursor?: number;
}

/** One change: its index in `events`, its instant, device and subject. */
interface Change {
  readonly index: number;
  readonly t: SimTime;
  readonly device: DeviceId;
  readonly subject: string;
}

/** The daemon prefixes and rib source of each `only` value. */
const ONLY: Readonly<Record<'ospf' | 'eigrp', { readonly prefixes: readonly string[]; readonly source: string }>> = {
  ospf: { prefixes: ['ospf-', 'ospf6-'], source: 'O' },
  eigrp: { prefixes: ['eigrp-'], source: 'EIGRP' },
};

const VOLATILE: ReadonlySet<string> = new Set<string>(VOLATILE_ROW_KEYS);

/** True when two rows differ in a member other than VOLATILE_ROW_KEYS. */
function rowsDiffer(a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (VOLATILE.has(k)) continue;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return true;
  }
  return false;
}

const hasPrefix = (name: string, prefixes: readonly string[]): boolean => prefixes.some((p) => name.startsWith(p));

/** Does a rib / rib6 row (or the row it replaced) belong to `source`? */
function ribOwned(row: Readonly<Record<string, unknown>>, previous: Readonly<Record<string, unknown>> | undefined, source: string): boolean {
  return row['source'] === source || previous?.['source'] === source;
}

/** The change `ev` is, or undefined (file header). */
function changeOf(ev: TraceEvent, index: number, opts: ConvergenceOptions): Change | undefined {
  if (ev.t < opts.from) return undefined;
  const lane = laneOf(ev);
  if (lane === undefined || !CONVERGENCE_LANES[opts.protocol].includes(lane)) return undefined;
  const only = opts.protocol === 'routing' && opts.only !== undefined ? ONLY[opts.only] : undefined;
  let change: Change | undefined;
  switch (ev.kind) {
    case 'tableWrite':
    case 'tableExpire': {
      const previous = ev.kind === 'tableWrite' ? ev.previous : undefined;
      if (ev.kind === 'tableWrite' && previous !== undefined && !rowsDiffer(ev.row, previous)) return undefined;
      if (only !== undefined) {
        const rib = ev.table === 'rib' || ev.table === 'rib6';
        if (rib ? !ribOwned(ev.row, previous, only.source) : !hasPrefix(ev.table, only.prefixes)) return undefined;
      }
      change = { index, t: ev.t, device: ev.device, subject: `${ev.table}:${ev.key}` };
      break;
    }
    case 'debug': {
      const fsm = ev.event.fsm;
      if (fsm === undefined) return undefined;
      if (only !== undefined && !hasPrefix(fsm.machine, only.prefixes)) return undefined;
      change = { index, t: ev.t, device: ev.event.device, subject: `${fsm.machine}:${fsm.subject}` };
      break;
    }
    default:
      return undefined;
  }
  if (opts.devices !== undefined && !opts.devices.includes(change.device)) return undefined;
  return change;
}

/** @since P3c [S8] Measure when `opts.protocol` settled after `opts.from` in `events` (file header). */
export function measureConvergence(events: readonly TraceEvent[], opts: MeasureConvergenceOptions): ConvergenceResult {
  const quietNs: SimTime = (opts.quietMs ?? CONVERGENCE_QUIET_MS[opts.protocol]) * MS;
  const end: SimTime = opts.to ?? (events.length > 0 ? events[events.length - 1]!.t : opts.from);
  const base = opts.firstCursor ?? 0;
  const changes: Change[] = [];
  for (let i = 0; i < events.length; i++) {
    const c = changeOf(events[i]!, i, opts);
    if (c !== undefined) changes.push(c);
  }
  const head = { protocol: opts.protocol, from: opts.from };
  if (changes.length === 0) {
    const settled = end - opts.from >= quietNs;
    return { ...head, settledAt: settled ? opts.from : null, durationNs: settled ? 0 : null, changes: 0 };
  }
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i]!;
    const nextAt = i + 1 < changes.length ? changes[i + 1]!.t : end;
    if (nextAt - c.t >= quietNs) {
      return {
        ...head,
        settledAt: c.t,
        durationNs: c.t - opts.from,
        changes: i + 1,
        last: { cursor: base + c.index, device: c.device, subject: c.subject },
      };
    }
  }
  const last = changes[changes.length - 1]!;
  return {
    ...head,
    settledAt: null,
    durationNs: null,
    changes: changes.length,
    last: { cursor: base + last.index, device: last.device, subject: last.subject },
  };
}
