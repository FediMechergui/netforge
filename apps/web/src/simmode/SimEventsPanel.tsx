/**
 * simmode/SimEventsPanel.tsx — the simulation-mode event list (ARCHITECTURE-P1 §4.11, §7 "Sim-mode list"):
 * a virtualised list paged through `traceQuery`, the chips that compose its `TraceFilter`, the breakpoint editor
 * over `runUntilStop`, and "Next matching event" over `stepToNext`.
 *
 * Paging (§4.11 item 5): the panel opens on the last page of the ring and then runs one incremental query
 * whenever the trace head advances, at most every SIM_EVENTS_QUERY_MS. Only SIM_EVENTS_MAX_ROWS rows are held
 * and only the ones on screen are rendered, so a lab with tens of thousands of events scrolls at a fixed cost;
 * scrolling to the top fetches the page before it. No engine work happens here — every call goes to the worker.
 *
 * Keyboard and screen readers (§16): the list is one tab stop, a listbox driven by
 * Up/Down/PageUp/PageDown/Home/End with `aria-activedescendant`; Enter or Space selects the row's packet (or its
 * device, port, link or session) exactly as a click does. Every encoding has a non-colour channel (§7): the kind
 * is its vocabulary label, the protocol its badge letter, a stop its ⏸ glyph and its sentence.
 *
 * ponytail: local component state for the chips with the store mirrored through `setSimModeUi`, rather than a
 * second source of truth; one breakpoint at a time; and follow-the-tail is just "the scroller is at the bottom".
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type UIEvent } from 'react';
import type { DeviceId, TraceEvent } from '@netforge/engine';
import { engine, fmtSimTime } from '../bridge/client';
import type { PlaybackMode, StopInfo } from '../bridge/protocol';
import { deviceName, portLabel, toastError, useDeviceIndex } from '../inspector/PacketInspector';
import { store, useStore } from '../store/store';
import { protocolClassName, protocolLabel, protocolVocab } from '../vocab/protocols';
import { TRACE_KIND_VOCAB } from '../vocab/trace-kinds';
import { BreakpointEditor, StopBanner } from './BreakpointEditor';
import { FilterChips, type ChipDevice } from './FilterChips';
import {
  DEFAULT_LIST_CHIPS,
  EMPTY_PAGE,
  SIM_EVENTS_QUERY_MS,
  SIM_EVENTS_ROW_H,
  SIM_RUN_HORIZON_NS,
  appendPage,
  atBottom,
  buildTraceFilter,
  chipsFromFilter,
  describeFilter,
  eventText,
  followQuery,
  hasChips,
  initialQuery,
  moveRowFocus,
  newestQuery,
  olderQuery,
  prependPage,
  rowIndexOf,
  rowProto,
  rowWindow,
  runStopText,
  scrollForIndex,
  selectionForEvent,
  tagsOf,
  toggleChip,
  type ChipGroup,
  type ChipSelection,
  type EventPage,
  type RowNames,
} from './sim-events-client';

/** Rows a PageUp / PageDown moves when the viewport height is not known yet. */
const FALLBACK_PAGE_ROWS = 10;

/** The scroll sync must run before paint in the browser; on the server there is no layout to read. */
const useScrollSync = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function SimEventsPanel() {
  const epoch = useStore((s) => s.epoch);
  const traceHead = useStore((s) => s.simMode?.traceHead ?? 0);
  // New events reach the store even before the sim-mode slice does; either one means "query again".
  const pulse = useStore((s) => s.events.length + s.droppedEvents);
  const storedMode = useStore((s) => s.simMode?.mode ?? 'realtime');
  const storedStop = useStore((s) => s.simMode?.stoppedAt ?? null);
  const snapshotDevices = useStore((s) => s.snapshot?.devices);
  const index = useDeviceIndex();

  const [listSel, setListSel] = useState<ChipSelection>(() => {
    const stored = store.getState().simMode?.list;
    return stored === undefined ? DEFAULT_LIST_CHIPS : chipsFromFilter(stored);
  });
  const [breakSel, setBreakSel] = useState<ChipSelection>(() => chipsFromFilter(store.getState().simMode?.breakOn));
  const [armed, setArmed] = useState(() => (store.getState().simMode?.breakOn ?? null) !== null);
  const [breakOpen, setBreakOpen] = useState(false);
  const [page, setPage] = useState<EventPage>(EMPTY_PAGE);
  const [focus, setFocus] = useState(-1);
  const [note, setNote] = useState<string | null>(null);
  const [localStop, setLocalStop] = useState<StopInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const [follow, setFollow] = useState(true);

  const listFilter = useMemo(() => buildTraceFilter(listSel), [listSel]);
  const breakFilter = useMemo(() => (armed && hasChips(breakSel) ? buildTraceFilter(breakSel) : null), [armed, breakSel]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef(page);
  pageRef.current = page;
  const headRef = useRef(traceHead);
  headRef.current = traceHead;
  const queryingRef = useRef(false);
  const lastQueryRef = useRef(0);

  const names: RowNames = useMemo(
    () => ({ device: (id: DeviceId) => deviceName(index, id), port: (ref) => portLabel(index, ref) }),
    [index],
  );
  const devices: ChipDevice[] = useMemo(
    () => (snapshotDevices ?? []).map((d) => ({ id: d.id, name: d.name })),
    [snapshotDevices],
  );
  const tags = useMemo(() => tagsOf(page, listSel.tags.concat(breakSel.tags)), [page, listSel.tags, breakSel.tags]);
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const row of page.rows) c.set(row.event.kind, (c.get(row.event.kind) ?? 0) + 1);
    return c;
  }, [page]);

  // The worker owns the filters: it runs them over the trace sink and over the clock clamp (§4.11 items 1–2).
  useEffect(() => {
    void engine.setSimFilters({ list: listFilter, breakOn: breakFilter }).catch(toastError);
    store.getState().setSimModeUi?.({ list: listFilter, breakOn: breakFilter });
  }, [listFilter, breakFilter]);

  // A new generation restarts the cursors, and a new filter invalidates every loaded row.
  useEffect(() => {
    setPage(EMPTY_PAGE);
    setFocus(-1);
    setLocalStop(null);
    setNote(null);
    setFollow(true);
    lastQueryRef.current = 0;
  }, [epoch, listFilter]);

  // Incremental paging, at most every SIM_EVENTS_QUERY_MS (§4.11 item 5).
  useEffect(() => {
    let alive = true;
    const query = async (): Promise<void> => {
      if (!alive || queryingRef.current) return;
      queryingRef.current = true;
      lastQueryRef.current = Date.now();
      try {
        const current = pageRef.current;
        if (current.rows.length === 0 && headRef.current === 0) {
          const r = await engine.traceQuery(newestQuery(listFilter));
          if (alive) setPage((cur) => prependPage(cur, r));
        } else {
          const q = current.rows.length === 0 ? initialQuery(headRef.current, listFilter) : followQuery(current, listFilter);
          const r = await engine.traceQuery(q);
          if (alive) setPage((cur) => appendPage(cur, r));
        }
      } catch (err) {
        if (alive) toastError(err);
      } finally {
        queryingRef.current = false;
      }
    };
    const wait = Math.max(0, SIM_EVENTS_QUERY_MS - (Date.now() - lastQueryRef.current));
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (wait === 0) void query();
    else timer = setTimeout(() => void query(), wait);
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [epoch, traceHead, pulse, listFilter]);

  const loadOlder = useCallback((): void => {
    const q = olderQuery(pageRef.current, listFilter);
    if (q === undefined || queryingRef.current) return;
    queryingRef.current = true;
    engine
      .traceQuery(q)
      .then((r) => setPage((cur) => prependPage(cur, r)))
      .catch(toastError)
      .finally(() => {
        queryingRef.current = false;
      });
  }, [listFilter]);

  useScrollSync(() => {
    const el = scrollRef.current;
    if (el === null) return;
    if (el.clientHeight !== viewportH) setViewportH(el.clientHeight);
    if (follow) el.scrollTop = el.scrollHeight;
  }, [page, follow, viewportH]);

  const rows = page.rows;
  const pageRows = viewportH > 0 ? Math.max(1, Math.floor(viewportH / SIM_EVENTS_ROW_H)) : FALLBACK_PAGE_ROWS;
  const win = rowWindow(rows.length, scrollTop, viewportH);

  const onScroll = (e: UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    setViewportH(el.clientHeight);
    setFollow(atBottom(el.scrollTop, el.clientHeight, rows.length));
    if (el.scrollTop <= SIM_EVENTS_ROW_H && page.more) loadOlder();
  };

  const revealRow = useCallback((i: number): void => {
    setFocus(i);
    const el = scrollRef.current;
    if (el === null) return;
    const next = scrollForIndex(i, el.scrollTop, el.clientHeight);
    if (next !== undefined) {
      el.scrollTop = next;
      setScrollTop(next);
      setFollow(false);
    }
  }, []);

  const activate = useCallback((ev: TraceEvent): void => {
    const sel = selectionForEvent(ev);
    if (sel !== null) store.getState().select(sel);
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      const row = rows[focus];
      if (row !== undefined) {
        e.preventDefault();
        activate(row.event);
      }
      return;
    }
    const next = moveRowFocus(e.key, focus, rows.length, pageRows);
    if (next === null) return;
    e.preventDefault();
    revealRow(next);
    const row = rows[next];
    if (next === 0 && page.more) loadOlder();
    if (row !== undefined) activate(row.event);
  };

  // Leaving simulation mode disarms the breakpoint in the worker (§4.11 item 6), so coming back re-sends the
  // filters the chips still show — otherwise the toolbar claims an armed breakpoint the clock would run past.
  const setMode = (mode: PlaybackMode): void => {
    void engine
      .setPlaybackMode(mode)
      .then(() => (mode === 'simulation' ? engine.setSimFilters({ list: listFilter, breakOn: breakFilter }) : undefined))
      .catch(toastError);
    store.getState().setSimModeUi?.({ mode });
  };

  const onStep = (): void => {
    setBusy(true);
    setNote(null);
    engine
      .stepToNext()
      .then((res) => {
        setLocalStop(res.stopped);
        setNote(res.stopped === null ? runStopText(res) : null);
      })
      .catch(toastError)
      .finally(() => setBusy(false));
  };

  const onRun = (): void => {
    if (breakFilter === null) return;
    setBusy(true);
    setNote(null);
    engine
      .runUntilStop(store.getState().now + SIM_RUN_HORIZON_NS, breakFilter)
      .then((res) => {
        setLocalStop(res.stopped);
        setNote(res.stopped === null ? runStopText(res) : null);
      })
      .catch(toastError)
      .finally(() => setBusy(false));
  };

  const stop = storedStop ?? localStop;
  const listId = 'sim-events-list';
  const breakId = 'sim-events-breakpoint';
  const activeRow = rows[focus];

  return (
    <div className="dock-panel">
      <div className="dock-toolbar">
        <span className="mode-label">Playback</span>
        <button
          type="button"
          className={`btn${storedMode === 'simulation' ? ' is-active' : ''}`}
          aria-pressed={storedMode === 'simulation'}
          title="Pause the clock and move through the simulation event by event."
          onClick={() => setMode(storedMode === 'simulation' ? 'realtime' : 'simulation')}
        >
          {storedMode === 'simulation' ? '⏸ Event by event' : '▶ Free running'}
        </button>
        <button type="button" className="btn" disabled={busy} title={describeFilter(listFilter, (id) => deviceName(index, id))} onClick={onStep}>
          ⏭ Next matching event
        </button>
        <button
          type="button"
          className={`btn${breakOpen ? ' is-active' : ''}`}
          aria-expanded={breakOpen}
          aria-controls={breakId}
          onClick={() => setBreakOpen(!breakOpen)}
        >
          {armed ? '● Breakpoint' : '○ Breakpoint'}
        </button>
        <span className="fill" />
        <button
          type="button"
          className={`btn${follow ? ' is-active' : ''}`}
          aria-pressed={follow}
          onClick={() => setFollow(!follow)}
          title={follow ? 'Stop moving to each new event' : 'Move to each new event as it arrives'}
        >
          {follow ? '⤓ Following' : '⏸ Held'}
        </button>
        <span>
          {rows.length} row{rows.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="dock-toolbar" role="group" aria-label="Which events are listed">
        <span className="mode-label">List</span>
        <span className="dock-hint">{describeFilter(listFilter, (id) => deviceName(index, id))}</span>
        <span className="fill" />
        <button type="button" className="btn btn-ghost" disabled={!page.more} onClick={loadOlder}>
          Load earlier events
        </button>
      </div>
      <FilterChips
        idPrefix="sim-events-list-chips"
        selection={listSel}
        onToggle={(group: ChipGroup, value: string) => setListSel(toggleChip(listSel, group, value))}
        onBackground={(next) => setListSel({ ...listSel, background: next })}
        devices={devices}
        tags={tags}
        counts={counts}
      />

      {breakOpen && (
        <BreakpointEditor
          id={breakId}
          selection={breakSel}
          onSelection={setBreakSel}
          armed={armed}
          onArm={setArmed}
          onRun={onRun}
          busy={busy}
          devices={devices}
          tags={tags}
          deviceName={(id) => deviceName(index, id)}
        />
      )}

      <StopBanner
        stopped={stop}
        text={stop === null ? '' : eventText(stop.event, names)}
        note={note}
        onReveal={() => {
          if (stop === null) return;
          const i = rowIndexOf(page, stop.cursor);
          if (i >= 0) revealRow(i);
          activate(stop.event);
        }}
      />

      <div
        className="dock-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        role="listbox"
        tabIndex={0}
        aria-label="Simulation events"
        aria-activedescendant={activeRow === undefined ? undefined : `${listId}-${activeRow.cursor}`}
      >
        {rows.length === 0 ? (
          <div className="dock-hint">No event matches yet. Run the simulation, or switch chips on above.</div>
        ) : (
          <>
            <div style={{ height: win.padTop }} role="presentation" />
            {rows.slice(win.start, win.end).map((row, i) => (
              <SimEventRow
                key={row.cursor}
                id={`${listId}-${row.cursor}`}
                event={row.event}
                text={eventText(row.event, names)}
                position={win.start + i + 1}
                total={rows.length}
                focused={win.start + i === focus}
                stopped={stop !== null && stop.cursor === row.cursor}
                onActivate={() => {
                  revealRow(win.start + i);
                  activate(row.event);
                }}
              />
            ))}
            <div style={{ height: win.padBottom }} role="presentation" />
          </>
        )}
      </div>
    </div>
  );
}

/** One row: time, kind label, protocol badge letter and the sentence. Fixed height — the window maths needs it. */
export function SimEventRow({
  id,
  event,
  text,
  position,
  total,
  focused,
  stopped,
  onActivate,
}: {
  id: string;
  event: TraceEvent;
  text: string;
  position: number;
  total: number;
  focused: boolean;
  stopped: boolean;
  onActivate(): void;
}) {
  const proto = rowProto(event);
  const kind = TRACE_KIND_VOCAB[event.kind];
  const vocab = proto === undefined ? undefined : protocolVocab(proto);
  const label = `${fmtSimTime(event.t)} ${kind.label}${vocab === undefined ? '' : ` ${vocab.label}`}: ${text}`;
  return (
    <div
      id={id}
      role="option"
      aria-selected={focused}
      aria-posinset={position}
      aria-setsize={total}
      aria-label={stopped ? `Stopped here. ${label}` : label}
      className={`ev-msg${focused ? ' is-selected' : ''}`}
      style={{ height: SIM_EVENTS_ROW_H, display: 'flex', gap: 8, alignItems: 'center', overflow: 'hidden', cursor: 'pointer' }}
      onClick={onActivate}
    >
      <span className="mono" aria-hidden="true">
        {stopped ? '⏸' : ' '}
      </span>
      <span className="mono">{fmtSimTime(event.t)}</span>
      <span className={`ev-kind ${event.kind}`} title={kind.help}>
        {kind.label}
      </span>
      {vocab === undefined ? (
        <span className="chip tiny" aria-hidden="true">
          —
        </span>
      ) : (
        <span
          className={`proto-chip ${protocolClassName(vocab.proto)}`}
          title={`${protocolLabel(vocab.proto)} — ${vocab.hint} Drawn as a ${vocab.shape} badged ${vocab.letter}.`}
        >
          {vocab.letter} {vocab.label}
        </span>
      )}
      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</span>
    </div>
  );
}
