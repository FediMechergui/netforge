/**
 * NetScope — the capture and analysis dock tab (ARCHITECTURE-P1 §4.12, §7 "NetScope"; spec §10).
 *
 * This file is only the composition: the four views (frames, follow stream, statistics, captures), the
 * selection that ties the three frame panes together, and the calls into the bridge. All paging, caching
 * and text shaping lives in netscope-client.ts, which is why it can be tested without React.
 *
 * The engine owns the capture: the UI holds ONE window of rows and at most `NETSCOPE_DETAIL_CACHE` decoded
 * frames, and every filter, statistic and export is computed in the worker.
 *
 * ponytail (deliberate, reversible):
 *  • View state is local React state, not a store slice: the dock keeps this panel mounted, and nothing
 *    outside NetScope reads the selection. The one thing read from the store is `netscope.heads`, the
 *    capture heads the worker reports with each batch, which is what "follow the live capture" waits on.
 *  • Live captures belong to the world: when the epoch changes the list is re-read, every decoded frame is
 *    dropped (live ids restart at c_1, so a kept decode would be another world's frame) and a live capture
 *    that is gone leaves the panel; imported captures (i_*) survive, as the engine intends.
 *  • Following the live capture is paced at NETSCOPE_FOLLOW_MS and only while this tab is the one on screen,
 *    because the worker reports a grown head on nearly every tick; it appends the tail rather than re-reading
 *    the window, and the frame count comes from that head instead of a fresh listing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CaptureId, CaptureInfo, CaptureRow, CaptureSpec, CaptureStatistics, FollowStreamResult, PcapFormat } from '@netforge/engine';
import { engine } from '../bridge/client';
import { useStore } from '../store/store';
import { CaptureControls, capturePointsOf } from './CaptureControls';
import { DetailTree, rangeOf, type HotField } from './DetailTree';
import { FilterBar } from './FilterBar';
import { FollowStream } from './FollowStream';
import { HexPane } from './HexPane';
import { PacketList } from './PacketList';
import { Statistics } from './Statistics';
import {
  NETSCOPE_FOLLOW_MS,
  NETSCOPE_NO_CAPTURE,
  captureFileName,
  capturePortOf,
  createDetailCache,
  createRowPager,
  type PagerState,
  type RowPager,
} from './netscope-client';
import './netscope.css';

export type NetScopeView = 'packets' | 'stream' | 'stats' | 'captures';

const VIEWS: readonly { id: NetScopeView; label: string; hint: string }[] = [
  { id: 'packets', label: 'Frames', hint: 'The captured frames, their decode and their bytes.' },
  { id: 'stream', label: 'Follow stream', hint: 'One conversation, reassembled in order.' },
  { id: 'stats', label: 'Statistics', hint: 'Protocol hierarchy, conversations and endpoints.' },
  { id: 'captures', label: 'Captures', hint: 'Start, stop, save and open captures.' },
];

const EMPTY_STATE: PagerState = { rows: [], from: 0, next: 0, done: true, full: false, scanned: 0, matched: 0, loading: false, depth: 0, revision: 0 };

/** How long a saved capture's object URL stays alive after the download starts. */
export const SAVE_URL_LIFETIME_MS = 1000;

/** DOM id of a view tab, so a pane that closes itself can hand focus back to the frames list. */
const viewTabId = (id: NetScopeView): string => `ns-view-${id}`;

/** Message for anything the engine refused, in its own words when it gave one. */
export function problemText(err: unknown): string {
  if (err instanceof Error && err.message.trim() !== '') return err.message;
  return 'The engine refused that. Try again once the simulation has settled.';
}

/** Save bytes the engine returned as a file (a no-op where there is no document, e.g. server rendering). */
export function saveBytes(bytes: Uint8Array, fileName: string): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  // Copy out of the transferred buffer: a Blob part must be a plain ArrayBuffer.
  const part = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const blob = new Blob([part], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Some browsers start fetching the blob only after the click returns, so the handle is released later.
  setTimeout(() => URL.revokeObjectURL(url), SAVE_URL_LIFETIME_MS);
}

/** Summary line under the filter box. */
export function statusText(state: PagerState, info: CaptureInfo | undefined): string {
  if (!info) return 'no capture selected';
  const shown = `${state.rows.length} frame${state.rows.length === 1 ? '' : 's'} shown`;
  const of = `of ${info.head} captured`;
  return state.error ? `${of} — the filter did not compile` : `${shown} ${of}`;
}

export function NetScope() {
  const port = useMemo(() => capturePortOf(engine), []);
  const details = useMemo(() => createDetailCache(port), [port]);
  const snapshot = useStore((s) => s.snapshot);
  const epoch = useStore((s) => s.epoch);
  const points = useMemo(() => capturePointsOf(snapshot), [snapshot]);

  const [captures, setCaptures] = useState<CaptureInfo[]>([]);
  const [activeId, setActiveId] = useState<CaptureId | null>(null);
  const [view, setView] = useState<NetScopeView>('captures');
  const [text, setText] = useState('');
  const [applied, setApplied] = useState('');
  const [state, setState] = useState<PagerState>(EMPTY_STATE);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof details.get>>>(undefined);
  const [layer, setLayer] = useState<number | null>(null);
  const [hot, setHot] = useState<HotField | null>(null);
  const [stream, setStream] = useState<FollowStreamResult | undefined>(undefined);
  const [stats, setStats] = useState<CaptureStatistics | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [follow, setFollow] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  // The stream and the statistics live in different views, so one flag covers both.
  const [paneLoading, setPaneLoading] = useState(false);
  const pagerRef = useRef<RowPager | null>(null);
  const lastFollowRef = useRef(0);

  const liveHead = useStore((s) => (activeId === null ? 0 : (s.netscope?.heads?.[activeId] ?? 0)));
  const shown = useStore((s) => s.dockTab === 'netscope');
  // The head the worker reports on each batch is newer than the listing; count with it rather than asking
  // the worker for the list again.
  const known = useMemo(
    () => captures.map((c) => (c.id === activeId && liveHead > c.head ? { ...c, head: liveHead } : c)),
    [captures, activeId, liveHead],
  );
  const active = known.find((c) => c.id === activeId);
  const selectedRow: CaptureRow | undefined = state.rows.find((r) => r.index === selected);

  // Listing is a background read: it never clears a refusal the student has not seen yet (`guard` owns that).
  const listCaptures = useCallback(async (): Promise<CaptureInfo[]> => {
    try {
      const list = await port.captures();
      setCaptures(list);
      return list;
    } catch (err) {
      setProblem(problemText(err));
      return [];
    }
  }, [port]);

  // The capture list belongs to the world: re-read it when the simulation is rebuilt. Live ids restart with
  // the new world, so every decode of the old one goes with it.
  useEffect(() => {
    details.clear();
    setSelected(null);
    setDetail(undefined);
    setStream(undefined);
    setStats(undefined);
    setLayer(null);
    setHot(null);
    setProblem(undefined); // whatever the old world refused is no longer true of this one
    void listCaptures().then((list) => {
      setActiveId((cur) => (cur !== null && list.some((c) => c.id === cur) ? cur : (list[list.length - 1]?.id ?? null)));
    });
  }, [details, listCaptures, epoch]);

  // One pager per capture and applied filter; it holds the only rows the UI keeps.
  useEffect(() => {
    if (activeId === null) {
      pagerRef.current = null;
      setState(EMPTY_STATE);
      return;
    }
    const pager = createRowPager(port, activeId, { filter: applied });
    pagerRef.current = pager;
    setSelected(null);
    setDetail(undefined);
    let live = true;
    void pager.fill().then((s) => {
      if (live && pagerRef.current === pager) setState(s);
    });
    return () => {
      live = false;
    };
  }, [port, activeId, applied]);

  const drive = useCallback((run: (p: RowPager) => Promise<PagerState>) => {
    const pager = pagerRef.current;
    if (!pager) return;
    void run(pager).then((s) => {
      if (pagerRef.current === pager) setState(s);
    });
  }, []);

  // The worker reports every capture head that grew (EngineBatch.captureHeads) — which is nearly every tick
  // while traffic flows. Append at most every NETSCOPE_FOLLOW_MS, and only while this panel is the one on
  // screen, so a hidden pane costs the worker nothing (§4.11 item 5 sets the same pace next door).
  useEffect(() => {
    if (!shown || !follow || activeId === null || liveHead === 0) return undefined;
    const pager = pagerRef.current;
    if (!pager) return undefined;
    const readTail = (): void => {
      lastFollowRef.current = Date.now();
      const now = pager.state();
      if (now.loading || now.full) return;
      void pager.follow().then((s) => {
        if (pagerRef.current === pager) setState(s);
      });
    };
    const wait = Math.max(0, NETSCOPE_FOLLOW_MS - (Date.now() - lastFollowRef.current));
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (wait === 0) readTail();
    else timer = setTimeout(readTail, wait);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [shown, follow, activeId, liveHead]);

  // The selected frame's decode, from the cache. The previous frame's decode goes first, so the panes never
  // show one frame's bytes beside another frame's row while the worker answers.
  useEffect(() => {
    setDetail(undefined);
    setLayer(null);
    setHot(null);
    if (activeId === null || selected === null) {
      setDetailLoading(false);
      return;
    }
    let live = true;
    setDetailLoading(true);
    void details.get(activeId, selected).then((d) => {
      if (!live) return;
      setDetail(d);
      setDetailLoading(false);
    });
    return () => {
      live = false;
    };
  }, [details, activeId, selected]);

  // Follow stream and statistics are read when their view is opened. Each drops what it holds before it
  // asks, so a refused or still-running query can never leave the previous capture's numbers on screen.
  useEffect(() => {
    if (view !== 'stream') return;
    setStream(undefined);
    const key = selectedRow?.stream;
    if (activeId === null || key === undefined) {
      setPaneLoading(false);
      return;
    }
    let live = true;
    setPaneLoading(true);
    void port
      .followStream(activeId, key)
      .then((r) => {
        if (!live) return;
        setStream(r);
        setProblem(undefined);
      })
      .catch((err: unknown) => {
        if (live) setProblem(problemText(err));
      })
      .finally(() => {
        if (live) setPaneLoading(false);
      });
    return () => {
      live = false;
    };
  }, [port, view, activeId, selectedRow?.stream]);

  useEffect(() => {
    if (view !== 'stats') return;
    setStats(undefined);
    if (activeId === null) {
      setPaneLoading(false);
      return;
    }
    let live = true;
    setPaneLoading(true);
    void port
      .captureStats(activeId, applied === '' ? undefined : applied)
      .then((s) => {
        if (!live) return;
        setStats(s);
        setProblem(undefined);
      })
      .catch((err: unknown) => {
        if (live) setProblem(problemText(err));
      })
      .finally(() => {
        if (live) setPaneLoading(false);
      });
    return () => {
      live = false;
    };
  }, [port, view, activeId, applied]);

  const guard = useCallback(async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await work();
      setProblem(undefined);
    } catch (err) {
      setProblem(problemText(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const onStart = (spec: CaptureSpec): void => {
    void guard(async () => {
      const id = await port.startCapture(spec);
      await listCaptures();
      setActiveId(id);
      setView('packets');
    });
  };

  const onStop = (id: CaptureId): void => {
    void guard(async () => {
      await port.stopCapture(id);
      await listCaptures();
    });
  };

  const onRemove = (id: CaptureId): void => {
    void guard(async () => {
      await port.removeCapture(id);
      details.clear(id);
      const list = await listCaptures();
      if (activeId === id) setActiveId(list[list.length - 1]?.id ?? null);
    });
  };

  const onExport = (id: CaptureId, format: PcapFormat): void => {
    void guard(async () => {
      const info = captures.find((c) => c.id === id);
      const bytes = await port.exportCapture(id, {
        format,
        ...(applied === '' ? {} : { filter: applied }),
        baseWallNs: BigInt(Date.now()) * 1_000_000n,
      });
      saveBytes(bytes, captureFileName(info ?? { id, name: id }, format));
    });
  };

  const onImport = (file: File): void => {
    void guard(async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const id = await port.importCapture(bytes, file.name);
      await listCaptures();
      setActiveId(id);
      setView('packets');
    });
  };

  // Closing a pane unmounts the button that has focus, so focus goes back to the tab that reopens it (§16).
  const backToFrames = useCallback((): void => {
    setView('packets');
    if (typeof document === 'undefined') return;
    queueMicrotask(() => document.getElementById(viewTabId('packets'))?.focus());
  }, []);

  const onNeedMore = useCallback(() => drive((p) => p.more()), [drive]);
  const onNextWindow = useCallback(() => drive((p) => p.nextWindow()), [drive]);
  const onPrevWindow = useCallback(() => drive((p) => p.prevWindow()), [drive]);

  const ifaceName = useCallback((index: number): string => active?.interfaces.find((i) => i.index === index)?.name ?? `interface ${index}`, [active]);

  const ranges = rangeOf(detail?.layers ?? [], layer, hot);
  const emptyNote = activeId === null ? NETSCOPE_NO_CAPTURE : applied === '' ? 'Nothing captured yet. Send traffic, or play the simulation.' : 'No frame in this capture matches the filter.';

  return (
    <div className="ns dock-panel">
      <FilterBar
        text={text}
        onText={setText}
        onApply={(t) => {
          setApplied(t);
          setView('packets');
        }}
        engineError={state.error}
        status={statusText(state, active)}
        busy={busy}
      />

      {/*
        A group of toggles, not a tablist: the strip also holds the stream button and the follow checkbox,
        which a tablist may not contain, and a toggle owes no arrow-key model (§16).
      */}
      <div className="ns-bar" role="group" aria-label="NetScope views">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            id={viewTabId(v.id)}
            type="button"
            className={`btn${view === v.id ? ' is-active' : ''}`}
            aria-pressed={view === v.id}
            title={v.hint}
            onClick={() => setView(v.id)}
          >
            {v.label}
          </button>
        ))}
        <span className="spacer" />
        <button
          type="button"
          className="btn"
          disabled={selectedRow?.stream === undefined}
          title={selectedRow?.stream === undefined ? 'Select a TCP or UDP frame first.' : `Reassemble ${selectedRow.stream}`}
          onClick={() => setView('stream')}
        >
          Follow this stream
        </button>
        <label>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Follow the live capture
        </label>
      </div>

      {view === 'captures' ? (
        <div className="ns-panes is-wide">
          <CaptureControls
            captures={known}
            activeId={activeId}
            points={points}
            busy={busy}
            problem={problem}
            onSelect={(id) => {
              setActiveId(id);
              setView('packets');
            }}
            onStart={onStart}
            onStop={onStop}
            onRemove={onRemove}
            onExport={onExport}
            onImport={onImport}
          />
        </div>
      ) : (
        <div className={`ns-panes${view === 'packets' ? '' : ' is-split'}`}>
          <PacketList
            rows={state.rows}
            state={state}
            ifaceName={ifaceName}
            selected={selected}
            onSelect={setSelected}
            onOpen={(index) => {
              setSelected(index);
              setView('packets');
            }}
            onNeedMore={onNeedMore}
            onNextWindow={onNextWindow}
            onPrevWindow={onPrevWindow}
            emptyNote={emptyNote}
          />
          {view === 'packets' && (
            <>
              <DetailTree
                detail={detail}
                loading={detailLoading}
                selectedLayer={layer}
                onSelectLayer={setLayer}
                hot={hot}
                onHot={setHot}
                note={selected === null ? 'Select a frame to decode it. Arrow keys walk the list, Enter opens the frame.' : 'That frame is no longer in the capture.'}
              />
              <HexPane detail={detail} loading={detailLoading} selected={ranges.selected} hot={ranges.hot} note="Select a frame to see its bytes." />
            </>
          )}
          {view === 'stream' && (
            <FollowStream
              result={stream}
              loading={paneLoading}
              error={problem}
              note="Select a TCP or UDP frame, then choose “Follow this stream”."
              onClose={backToFrames}
            />
          )}
          {view === 'stats' && (
            <Statistics stats={stats} loading={paneLoading} error={problem} filter={applied} note="Select a capture to count its frames." onClose={backToFrames} />
          )}
        </div>
      )}
    </div>
  );
}
