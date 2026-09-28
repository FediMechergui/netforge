/**
 * timeline/LaneRows.tsx — the lanes of the timeline strip [SHOULD S1] (ARCHITECTURE-P2 §2.13, §3.13 step 1, §6).
 *
 * `LaneRows` draws one row per lane from `laneRows(...)` (timeline-client): the lane's glyph and label, how many events
 * it holds in view, and one bar per non-empty bucket whose HEIGHT is its intensity level (1..4) — the glyph (on the row
 * and, where a bar is wide enough, on the bar) and the height are the non-colour channels; the lane colour only repeats
 * them. A bar is a button that seeks to the first event of that lane in that bucket (`cellAction`). Bars stay out of
 * the tab order (a strip of 240 tab stops would trap the keyboard); the keyboard path to the same events is the lane's
 * name button, which opens `LaneMarks`: the lane's events in view as a list of buttons, each seeking to its event
 * (`markAction`) and reading as a sentence (`markText`).
 *
 * The time-travel budget shows here: the worker keeps individual marks only for its newest entries (older ones are
 * merged into counted cells, and marks whose events left the live ring are dropped), so a lane can count more events
 * than it can list. The list then says so instead of pretending the stretch was quiet.
 *
 * Both components are hook-free (the strip owns the state; `LaneRowsView` is exported for the tests, `LaneRows` is
 * its memoised form, because the strip re-renders on every batch while the rows change at most every
 * TIMELINE_QUERY_MS).
 */
import { memo } from 'react';
import { formatSimTime } from '@netforge/engine';
import type { LaneId, SimTime } from '@netforge/engine';
import { LANE_VOCAB } from '../vocab/lanes';
import type { ColorToken } from '../vocab/protocols';
import {
  TIMELINE_MARKS_LIMIT,
  cellAction,
  markAction,
  markText,
  markTooltip,
  timeToX,
  type LaneCell,
  type LaneRow,
  type ScrubAction,
  type TimelineMark,
  type TimelineWindow,
} from './timeline-client';

/** A bar at least this wide (px) also carries the lane glyph. */
export const LANE_GLYPH_MIN_PX = 16;

/** Theme variable of a vocabulary colour. */
export function laneColorVar(c: ColorToken): string {
  switch (c) {
    case 'text':
      return 'var(--text)';
    case 'textDim':
      return 'var(--text-dim)';
    case 'accent':
      return 'var(--accent)';
    case 'ok':
      return 'var(--ok)';
    case 'warn':
      return 'var(--warn)';
    case 'err':
      return 'var(--err)';
    case 'purple':
      return 'var(--purple)';
    case 'yellow':
      return 'var(--yellow)';
    case 'blueDeep':
      return 'var(--blue-deep)';
  }
}

const events = (n: number): string => `${n} ${n === 1 ? 'event' : 'events'}`;

/** The words of one bar: lane, count and stretch of time. */
export function cellLabel(row: Pick<LaneRow, 'label'>, cell: Pick<LaneCell, 'count' | 'from' | 'to'>): string {
  return `${row.label}: ${events(cell.count)} between ${formatSimTime(cell.from)} and ${formatSimTime(cell.to)}`;
}

export interface LaneRowsProps {
  rows: readonly LaneRow[];
  /** The window the strip shows; bars outside it are left out. */
  window: TimelineWindow;
  /** Track width in pixels (decides which bars are wide enough for a glyph). */
  widthPx: number;
  /** Seeking is off: bars do nothing. */
  disabled: boolean;
  /** The lane whose event list is open, if any. */
  openLane: LaneId | null;
  /** Id of the event list (the name buttons control it). */
  marksId: string;
  /** The first answer has not arrived yet. */
  loading?: boolean;
  /** `hintT`: the time the action will land near (the handle shows it while the seek runs). */
  onAction(action: ScrubAction, hintT?: SimTime): void;
  onToggleLane(lane: LaneId): void;
}

/** Hook-free rows (see the file header). */
export function LaneRowsView(props: LaneRowsProps) {
  const { rows, window: w, widthPx, disabled, openLane, marksId, loading, onAction, onToggleLane } = props;
  if (rows.length === 0) {
    return <p className="tl-empty">{loading === true ? 'Reading the lanes…' : 'Nothing happened in this stretch of time.'}</p>;
  }
  return (
    <ul className="tl-lanes" aria-label="Timeline lanes">
      {rows.map((row) => {
        const v = LANE_VOCAB[row.lane];
        const open = openLane === row.lane;
        return (
          <li key={row.lane} className="tl-row tl-lane" style={{ ['--lane' as string]: laneColorVar(v.color) }}>
            <button
              type="button"
              className={`tl-lane-name${open ? ' is-open' : ''}`}
              aria-expanded={open}
              aria-controls={open ? marksId : undefined}
              title={`${row.hint} Select to list its events in view.`}
              onClick={() => onToggleLane(row.lane)}
            >
              <span className="tl-glyph" aria-hidden="true">
                {row.glyph}
              </span>
              <span className="tl-lane-label">{row.label}</span>
              <span className="tl-count">
                {row.total}
                <span className="tl-sr-only"> {row.total === 1 ? 'event' : 'events'} in view</span>
              </span>
            </button>
            <div className="tl-cells">
              {row.cells.map((cell) => {
                if (cell.to <= w.from || cell.from > w.to) return null;
                const left = timeToX(cell.from, w, 100);
                const width = Math.max(0, timeToX(cell.to, w, 100) - left);
                const label = cellLabel(row, cell);
                const wide = (width * widthPx) / 100 >= LANE_GLYPH_MIN_PX;
                return (
                  <button
                    key={cell.index}
                    type="button"
                    tabIndex={-1}
                    className={`tl-cell l${cell.level}`}
                    style={{ left: `${left.toFixed(3)}%`, width: `${width.toFixed(3)}%` }}
                    aria-label={label}
                    title={label}
                    disabled={disabled}
                    onClick={() => onAction(cellAction(cell), cell.from)}
                  >
                    {wide ? row.glyph : null}
                  </button>
                );
              })}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** The rows, memoised (see the file header). */
export const LaneRows = memo(LaneRowsView);

/** What the strip knows about the open lane's event list. */
export interface LaneMarksState {
  readonly lane: LaneId;
  /** null while the first answer is on its way. */
  readonly marks: readonly TimelineMark[] | null;
  /** Why the list could not be read. */
  readonly error?: string;
}

export interface LaneMarksProps {
  id: string;
  state: LaneMarksState;
  /** The lane's row in view (its count), when it has one. */
  row: LaneRow | undefined;
  disabled: boolean;
  deviceName?: (id: string) => string;
  onAction(action: ScrubAction, hintT?: SimTime): void;
  onClose(): void;
}

/** Why a lane lists fewer events than it counts, or null when the list is complete. */
export function marksShortfall(total: number, listed: number): string | null {
  if (listed >= TIMELINE_MARKS_LIMIT) return `Showing the first ${listed} events; zoom in to list the rest.`;
  const older = total - listed;
  if (older <= 0) return null;
  return listed === 0
    ? `${events(total)} in view are older than the kept detail: only their count remains.`
    : `${events(older)} more are older than the kept detail: only their count remains.`;
}

/** The open lane's events in view, as seek buttons (the keyboard path to what the bars show). */
export function LaneMarks(props: LaneMarksProps) {
  const { id, state, row, disabled, deviceName, onAction, onClose } = props;
  const v = LANE_VOCAB[state.lane];
  const marks = state.marks;
  const shortfall = marks === null || state.error !== undefined ? null : marksShortfall(row?.total ?? marks.length, marks.length);
  return (
    <section id={id} className="tl-marks" aria-label={`${v.label}: events in view`} style={{ ['--lane' as string]: laneColorVar(v.color) }}>
      <div className="tl-marks-head">
        <span className="tl-glyph" aria-hidden="true">
          {v.glyph}
        </span>
        <span>{v.label}: events in view</span>
        <button type="button" className="btn btn-ghost tl-small" onClick={onClose}>
          Close list
        </button>
      </div>
      {state.error !== undefined ? (
        <p className="tl-note">The events could not be read: {state.error}</p>
      ) : marks === null ? (
        <p className="tl-empty">Reading the events…</p>
      ) : marks.length === 0 && shortfall === null ? (
        <p className="tl-empty">No {v.label.toLowerCase()} events in this stretch of time.</p>
      ) : (
        <ol className="tl-marks-list">
          {marks.map((m) => (
            <li key={m.cursor}>
              <button
                type="button"
                className="tl-mark"
                disabled={disabled}
                title={markTooltip(m, deviceName)}
                onClick={() => onAction(markAction(m), m.t)}
              >
                <span className="mono tl-mark-time">{formatSimTime(m.t)}</span>
                <span className="tl-mark-text">{markText(m, deviceName)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {shortfall !== null && <p className="tl-note">{shortfall}</p>}
    </section>
  );
}
