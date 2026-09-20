/**
 * PacketList — the first NetScope pane: the matched frames of ONE window, drawn virtualised
 * (ARCHITECTURE-P1 §4.12, §7; §16 keyboard operation).
 *
 * Only the rows in view (plus a small overscan) are in the DOM, and only one window of rows is in memory
 * (netscope-client `RowPager`), so a 100 000-frame capture costs the UI a screenful either way.
 *
 * Keyboard: the list is one tab stop. Up/Down move the selection, PageUp/PageDown by a screen, Home/End to
 * the window's ends, Enter opens the frame in the detail pane, and Left/Right page to the previous / next
 * window. The focused row is marked with `aria-activedescendant` and a visible ring.
 *
 * ponytail: no sortable columns (the capture is a timeline, and the engine pages it in capture order) and
 * fixed row height, which is what makes the virtualisation a subtraction rather than a measurement pass.
 */
import { memo, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { formatSimTime } from '@netforge/engine/pure';
import type { CaptureRow } from '@netforge/engine';
import { protocolLabel, protocolLetter } from '../vocab/protocols';
import { protoClass } from '../inspector/HexView';
import { directionOf, rowSummary, type PagerState } from './netscope-client';
import './netscope.css';

/** Row height in CSS pixels; the list positions rows by multiplying it (keep in step with netscope.css). */
export const NS_ROW_HEIGHT = 22;
/** Rows drawn above and below the viewport. */
export const NS_OVERSCAN = 6;
/** Height assumed before the container has been measured (server rendering, first paint). */
export const NS_ASSUMED_HEIGHT = 320;

/** Rows to draw for a scroll position: `[start, end)` into the window's rows. */
export function visibleRange(scrollTop: number, height: number, total: number, rowHeight = NS_ROW_HEIGHT, overscan = NS_OVERSCAN): { start: number; end: number } {
  if (total <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const fit = Math.ceil(Math.max(rowHeight, height) / rowHeight);
  const start = Math.max(0, first - overscan);
  const end = Math.min(total, first + fit + overscan);
  return { start, end: Math.max(start, end) };
}

/** Where a key moves the selection inside the window; -1 = the key is not ours. */
export function movedPosition(pos: number, key: string, count: number, pageRows: number): number {
  if (count <= 0) return -1;
  const clamp = (n: number): number => Math.max(0, Math.min(count - 1, n));
  const at = pos < 0 ? 0 : pos;
  switch (key) {
    case 'ArrowDown':
      return clamp(pos < 0 ? 0 : at + 1);
    case 'ArrowUp':
      return clamp(pos < 0 ? count - 1 : at - 1);
    case 'PageDown':
      return clamp(at + Math.max(1, pageRows));
    case 'PageUp':
      return clamp(at - Math.max(1, pageRows));
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return -1;
  }
}

/** Scroll offset that brings a row fully into view, or null when it already is. */
export function scrollToRow(pos: number, scrollTop: number, height: number, rowHeight = NS_ROW_HEIGHT): number | null {
  const top = pos * rowHeight;
  if (top < scrollTop) return top;
  const bottom = top + rowHeight;
  if (bottom > scrollTop + height) return bottom - height;
  return null;
}

export interface PacketListProps {
  rows: readonly CaptureRow[];
  state: PagerState;
  /** Display name of a capture interface index. */
  ifaceName(index: number): string;
  /** Selected record index (not a position in `rows`). */
  selected: number | null;
  onSelect(recordIndex: number): void;
  /** Enter, or a double click: show the frame in the detail pane. */
  onOpen(recordIndex: number): void;
  /** The reader scrolled near the end of what is loaded. */
  onNeedMore(): void;
  onNextWindow(): void;
  onPrevWindow(): void;
  /** Note shown instead of rows (no capture, nothing matched, …). */
  emptyNote: string;
}

export function PacketList({ rows, state, ifaceName, selected, onSelect, onOpen, onNeedMore, onNextWindow, onPrevWindow, emptyNote }: PacketListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(NS_ASSUMED_HEIGHT);
  const pos = selected === null ? -1 : rows.findIndex((r) => r.index === selected);
  const { start, end } = visibleRange(scrollTop, height, rows.length);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = (): void => setHeight(el.clientHeight || NS_ASSUMED_HEIGHT);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the selected row in view when it moves by keyboard.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || pos < 0) return;
    const to = scrollToRow(pos, el.scrollTop, el.clientHeight || height);
    if (to !== null) el.scrollTop = to;
  }, [pos, height]);

  // Fill the window as the reader approaches its end.
  useEffect(() => {
    if (!state.loading && !state.done && !state.full && end >= rows.length - NS_OVERSCAN) onNeedMore();
  }, [end, rows.length, state.loading, state.done, state.full, onNeedMore]);

  const pageRows = Math.max(1, Math.floor(height / NS_ROW_HEIGHT) - 1);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' && selected !== null) {
      e.preventDefault();
      onOpen(selected);
      return;
    }
    if (e.key === 'ArrowRight' && !state.done) {
      e.preventDefault();
      onNextWindow();
      return;
    }
    if (e.key === 'ArrowLeft' && state.depth > 0) {
      e.preventDefault();
      onPrevWindow();
      return;
    }
    const next = movedPosition(pos, e.key, rows.length, pageRows);
    if (next < 0) return;
    e.preventDefault();
    const row = rows[next];
    if (row) onSelect(row.index);
  };

  const listId = 'ns-packet-list';

  return (
    <div className="ns-pane">
      <h4 id="ns-packet-list-title">
        Frames{rows.length > 0 ? ` (${rows.length} in this window${state.full ? ', more follow' : ''})` : ''}
      </h4>
      <div className="ns-row ns-head" role="presentation">
        <span className="num">No.</span>
        <span>Time</span>
        <span className="dir">Dir</span>
        <span>Source</span>
        <span>Destination</span>
        <span>Protocol</span>
        <span className="num">Bytes</span>
        <span>Summary</span>
      </div>
      <div
        className="ns-scroll ns-list"
        ref={scrollRef}
        role="grid"
        id={listId}
        tabIndex={0}
        aria-labelledby="ns-packet-list-title"
        aria-rowcount={rows.length}
        aria-activedescendant={pos >= 0 ? `ns-row-${selected}` : undefined}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={onKeyDown}
      >
        {rows.length === 0 ? (
          <div className="ns-note">{state.loading ? 'Reading the capture…' : emptyNote}</div>
        ) : (
          <div role="rowgroup" style={{ height: `${rows.length * NS_ROW_HEIGHT}px`, position: 'relative' }}>
            {rows.slice(start, end).map((row, i) => (
              <PacketRow
                key={row.index}
                row={row}
                top={(start + i) * NS_ROW_HEIGHT}
                rowIndex={start + i + 1}
                iface={ifaceName(row.iface)}
                selected={row.index === selected}
                onSelect={onSelect}
                onOpen={onOpen}
              />
            ))}
          </div>
        )}
      </div>
      <div className="ns-bar">
        <button type="button" className="btn btn-ghost" onClick={onPrevWindow} disabled={state.depth === 0 || state.loading}>
          ◀ Earlier frames
        </button>
        <button type="button" className="btn btn-ghost" onClick={onNextWindow} disabled={state.done || state.loading}>
          Later frames ▶
        </button>
        <span className="spacer" />
        <span aria-live="polite">
          {state.loading
            ? 'reading…'
            : state.full
              ? 'window full — page on for later frames'
              : state.done
                ? 'end of the capture'
                : `${state.scanned} frames read`}
        </span>
      </div>
    </div>
  );
}

interface PacketRowProps {
  row: CaptureRow;
  top: number;
  rowIndex: number;
  iface: string;
  selected: boolean;
  onSelect(index: number): void;
  onOpen(index: number): void;
}

const PacketRow = memo(function PacketRow({ row, top, rowIndex, iface, selected, onSelect, onOpen }: PacketRowProps) {
  const dir = directionOf(row.dir);
  const damaged = row.corrupted === true;
  return (
    <div
      id={`ns-row-${row.index}`}
      role="row"
      aria-rowindex={rowIndex}
      aria-selected={selected}
      aria-label={rowSummary(row, iface)}
      className={`ns-row is-clickable${selected ? ' is-selected' : ''}${damaged ? ' is-damaged' : ''}`}
      style={{ position: 'absolute', top: `${top}px`, left: 0, right: 0 }}
      onClick={() => onSelect(row.index)}
      onDoubleClick={() => onOpen(row.index)}
    >
      <span className="num" role="gridcell">
        {row.index + 1}
      </span>
      <span className="mono" role="gridcell">
        {formatSimTime(row.t)}
      </span>
      <span className="dir" role="gridcell" title={`${dir.text} on ${iface}`}>
        {dir.glyph}
      </span>
      <span role="gridcell">{row.src}</span>
      <span role="gridcell">{row.dst}</span>
      <span role="gridcell" className={`ns-proto ${protoClass(row.proto)}`}>
        <span className="ns-letter" aria-hidden="true">
          {protocolLetter(row.proto)}
        </span>
        {protocolLabel(row.proto)}
      </span>
      <span className="num" role="gridcell">
        {row.len}
      </span>
      <span className="info" role="gridcell" title={row.info}>
        {row.info}
      </span>
    </div>
  );
});
