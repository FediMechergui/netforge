/**
 * The zustand store (spec §3.3: UI state only; sim state is mirrored read-only; store/types.ts header).
 *
 * `applyBatch` is the ONLY write path for engine-mirrored state (`snapshot`, `snapshotIndex`, `now`, `inflight`,
 * `events`); everything else is plain UI state. The worker bridge (`bridge/client.ts`) subscribes `applyBatch` to
 * the engine's batch stream and installs the resync handler.
 *
 * Snapshots and deltas (protocol.ts header):
 *   - a full snapshot replaces the mirror and rebuilds `snapshotIndex`;
 *   - a delta is merged by index: changed devices are replaced in place in a copied array, untouched devices keep
 *     their identity (selectors and memoised components skip them), the link list is replaced only when present;
 *   - a delta that cannot be merged (no snapshot yet, topologyVersion mismatch, unknown device) is not applied and
 *     the resync handler asks the worker for a full snapshot.
 * Mirrored snapshots are shallowly frozen so immer never walks them while finalising a batch.
 *
 * Epoch change (reset/load) clears mirrored history: events, in-flight frames, markers, flashes, dropped and
 * truncated counters, the inspected PDU and PDU selection, desktop windows, the keyboard canvas focus, plus the P1
 * slices when present (sim-mode stop, live captures, lab status).
 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { castDraft, setAutoFreeze, type Draft } from 'immer';
import type { StoreApi } from 'zustand';
import {
  inflightKey,
  selectionKey,
  type DeviceSnapshot,
  type InflightFrame,
  type SessionId,
  type SimSnapshot,
  type TraceEvent,
} from '@netforge/engine';
import { DEFAULT_SIM_FILTERS, type EngineBatch, type SnapshotDelta } from '../bridge/protocol';
import { effectiveCableMedia } from '../app/cable/cable-compat';
import { attachPersistence, loadPersistedUi, RECENT_LIMIT, savePersistedUi, persistedSliceOf } from './persist';
import {
  DESKTOP_WINDOW_LIMIT,
  DROP_MARKER_MS,
  EVENT_RING,
  FLASH_MS,
  type DesktopWindow,
  type DropMarker,
  type SnapshotIndex,
  type Store,
  type TableFlash,
  type Theme,
  type WorkspaceView,
} from './types';

// Snapshots are large structured-clone objects that arrive several times a second;
// deep-freezing them on every produce() would cost more than it protects.
setAutoFreeze(false);

/** Frames that already arrived are kept this long (sim ns) so the canvas can finish the capsule. */
const INFLIGHT_GRACE_NS = 1_000_000_000;
/** Upper bound on live drop markers / flashes so a flood cannot grow the arrays unbounded. */
const MAX_DROP_MARKERS = 200;
const MAX_FLASHES = 400;

/** Desktop window geometry. */
export const DESKTOP_WINDOW_DEFAULT = Object.freeze({ w: 520, h: 380 });
export const DESKTOP_WINDOW_MIN = Object.freeze({ w: 240, h: 160 });
const DESKTOP_WINDOW_ORIGIN = 48;
const DESKTOP_WINDOW_CASCADE = 28;

/** Imported captures (`i_*`) live in the worker's library and survive a new world; live ones (`c_*`) do not. */
const isImportedCapture = (id: string): boolean => id.startsWith('i_');

export function applyThemeAttribute(t: Theme): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = t;
}

// ── snapshot index and delta merge (pure) ────────────────────────────────────

/** Build the id → position index of a full snapshot. */
export function buildSnapshotIndex(snapshot: Pick<SimSnapshot, 'devices' | 'links'> & { topologyVersion?: number }): SnapshotIndex {
  const devices: SnapshotIndex['devices'] = {};
  const links: SnapshotIndex['links'] = {};
  snapshot.devices.forEach((d, i) => {
    devices[d.id] = i;
  });
  snapshot.links.forEach((l, i) => {
    links[l.id] = i;
  });
  return Object.freeze({ topologyVersion: snapshot.topologyVersion ?? 0, devices, links });
}

export type DeltaMergeResult =
  | { ok: true; snapshot: SimSnapshot; index: SnapshotIndex }
  | { ok: false; reason: 'no-snapshot' | 'topology-mismatch' | 'unknown-device' };

/**
 * Merge a delta into the previous full snapshot. Untouched devices (and the link list when the delta has none) are
 * the previous objects; the returned index is the previous one unless the link list changed shape.
 */
export function mergeSnapshotDelta(prev: SimSnapshot | null, index: SnapshotIndex | undefined, delta: SnapshotDelta): DeltaMergeResult {
  if (!prev || !index) return { ok: false, reason: 'no-snapshot' };
  if (delta.topologyVersion !== index.topologyVersion) return { ok: false, reason: 'topology-mismatch' };
  const { devices: changed, links: newLinks, ...rest } = delta;
  let devices: DeviceSnapshot[] = prev.devices;
  for (const d of changed) {
    const i = index.devices[d.id];
    if (i === undefined || prev.devices[i]?.id !== d.id) return { ok: false, reason: 'unknown-device' };
    if (devices === prev.devices) devices = prev.devices.slice();
    devices[i] = d;
  }
  let nextIndex = index;
  let links = prev.links;
  if (newLinks !== undefined) {
    links = newLinks;
    const sameShape = newLinks.length === prev.links.length && newLinks.every((l, i) => index.links[l.id] === i);
    if (!sameShape) nextIndex = buildSnapshotIndex({ devices, links: newLinks, topologyVersion: index.topologyVersion });
  }
  const snapshot: SimSnapshot = { ...rest, devices, links };
  return { ok: true, snapshot: Object.freeze(snapshot), index: nextIndex };
}

// ── in-flight frames ─────────────────────────────────────────────────────────

const keyOf = (f: Pick<InflightFrame, 'pdu' | 'link' | 'to'>): string => inflightKey(f.pdu.id, f.link, f.to);

function frameOf(ev: Extract<TraceEvent, { kind: 'frameTx' }>): InflightFrame {
  const f: InflightFrame = {
    pdu: ev.pdu,
    link: ev.link,
    from: ev.from,
    to: ev.to,
    txStart: ev.txStart,
    txEnd: ev.txEnd,
    arrive: ev.arrive,
  };
  if (ev.medium !== undefined) f.medium = ev.medium;
  if (ev.rateBps !== undefined) f.rateBps = ev.rateBps;
  if (ev.background === true) f.background = true;
  return f;
}

/**
 * Merge the previous frames with this batch's frame legs. `authoritative` (the in-flight list of a snapshot or
 * delta) removes frames the engine no longer carries and replaces the ones it does.
 */
export function reconcileInflight(
  previous: readonly InflightFrame[],
  events: readonly TraceEvent[],
  now: number,
  authoritative: readonly InflightFrame[] | undefined,
): InflightFrame[] {
  const merged = new Map<string, InflightFrame>();
  const floor = now - INFLIGHT_GRACE_NS;
  for (const f of previous) if (f.arrive >= floor) merged.set(keyOf(f), f);
  for (const ev of events) {
    if (ev.kind === 'frameTx') {
      const f = frameOf(ev);
      if (f.arrive >= floor) merged.set(keyOf(f), f);
    } else if (ev.kind === 'frameAbort') {
      const k = inflightKey(ev.pdu.id, ev.link, ev.to);
      const f = merged.get(k);
      if (f !== undefined) merged.set(k, { ...f, abortAt: ev.abortAt });
    }
  }
  if (authoritative) {
    // Frames still in the future that the engine no longer lists (link removed, reset, collision) are gone.
    const live = new Set(authoritative.map(keyOf));
    for (const [k, f] of merged) if (f.arrive > now && !live.has(k)) merged.delete(k);
    for (const f of authoritative) merged.set(keyOf(f), f);
  }
  return [...merged.values()];
}

// ── resync ───────────────────────────────────────────────────────────────────

let resyncHandler: (() => void) | undefined;

/** Installed by the bridge: called when a delta could not be merged (the handler fetches a full snapshot). */
export function setResyncHandler(fn: (() => void) | undefined): void {
  resyncHandler = fn;
}

// ── entry view (P2 course layer) ─────────────────────────────────────────────

/**
 * Where a visit starts. A first visit opens the landing page; someone who was last in the sandbox comes back to
 * the sandbox instead of being sent through the course layer again. Only that one bit is kept: which lesson they
 * were reading is not worth restoring, and restoring it would be one more stale id to validate.
 *
 * ponytail: its own key rather than a field of `persist.ts`'s versioned record — this is a single enum the store
 * writes on every view change, not a preference the UI edits; fold it in if the record ever needs it.
 */
export const ENTRY_VIEW_KEY = 'netforge.entry.v1';

/** The sandbox for anything sandbox-shaped, the landing page for everything else (including junk from storage). */
export function entryViewOf(v: unknown): WorkspaceView {
  return v === 'topology' || v === 'concept' ? 'topology' : 'landing';
}

function readEntryView(): WorkspaceView {
  try {
    return entryViewOf(typeof localStorage === 'undefined' ? null : localStorage.getItem(ENTRY_VIEW_KEY));
  } catch {
    return 'landing';
  }
}

/** Remember which side of the product the visitor is on. Storage may refuse; the entry view is a convenience. */
function rememberEntryView(v: WorkspaceView): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(ENTRY_VIEW_KEY, entryViewOf(v));
  } catch {
    /* private mode, quota, sandboxed frame: nothing to do */
  }
}

let nextMarkerId = 1;
let nextWindowId = 1;
let nextAnnouncementId = 1;

const persisted = loadPersistedUi();

export const useStore = create<Store>()(
  immer((set, get) => ({
    // ── engine mirror ────────────────────────────────────────────────────
    ready: false,
    epoch: -1,
    catalog: [],
    snapshot: null,
    snapshotIndex: undefined,
    now: 0,
    nowWall: 0,
    playing: false,
    rate: 1,
    effectiveRate: 1_000_000,
    inflight: [],
    events: [],
    droppedEvents: 0,
    eventsTruncated: 0,
    inspectedPdu: null,
    modules: [],
    media: [],

    // ── ui state ─────────────────────────────────────────────────────────
    theme: persisted.theme,
    tool: 'select',
    addDeviceType: null,
    selection: null,
    hover: null,
    pendingCable: null,
    dockTab: persisted.dock.tab,
    dockHeight: persisted.dock.height,
    inspectorWidth: persisted.dock.inspectorWidth,
    terminals: [],
    activeTerminal: null,
    dropMarkers: [],
    tableFlashes: [],
    colourByFlow: false,
    camera: { x: 0, y: 0, zoom: 1 },
    toastMessage: null,
    palette: {
      query: '',
      category: 'all',
      collapsed: persisted.palette.collapsed,
      expandedFamily: null,
      recent: persisted.palette.recent,
    },
    cable: { media: persisted.cable.media, open: false },
    overlays: persisted.overlays,
    inspectorTab: 'overview',
    desktopWindows: [],
    a11y: { canvasFocus: null, announcement: null },

    // ── P1 ───────────────────────────────────────────────────────────────
    // P2: a first visit opens the landing page; a visitor who left from the sandbox comes back to it.
    view: readEntryView(),
    conceptTool: 'subnetting',
    simMode: { mode: 'realtime', list: { ...DEFAULT_SIM_FILTERS.list }, breakOn: null, stoppedAt: null, traceHead: 0 },
    netscope: { captures: [], active: null, filterText: '', applied: '', selected: null, pane: 'packets', streamKey: null, heads: {} },
    lab: { active: null, status: null, browserOpen: true },
    learn: { courseId: null, lessonId: null },

    // ── actions ──────────────────────────────────────────────────────────
    applyBatch(batch: EngineBatch) {
      const wall = performance.now();
      const prev = get();
      const epochChanged = batch.epoch !== prev.epoch;

      let nextSnapshot: SimSnapshot | undefined;
      let nextIndex: SnapshotIndex | undefined;
      let needResync = false;
      if (batch.snapshot) {
        nextSnapshot = Object.isFrozen(batch.snapshot) ? batch.snapshot : Object.freeze(batch.snapshot);
        nextIndex = buildSnapshotIndex(nextSnapshot);
      } else if (batch.delta) {
        const merged = epochChanged ? ({ ok: false, reason: 'no-snapshot' } as const) : mergeSnapshotDelta(prev.snapshot, prev.snapshotIndex, batch.delta);
        if (merged.ok) {
          nextSnapshot = merged.snapshot;
          nextIndex = merged.index;
        } else {
          needResync = true;
        }
      }
      const authoritative = batch.snapshot?.inflight ?? (nextSnapshot !== undefined ? batch.delta?.inflight : undefined);

      set((s) => {
        if (epochChanged) clearHistory(s, batch.epoch);
        s.now = batch.now;
        s.nowWall = wall;
        s.playing = batch.playing;
        s.rate = batch.rate;
        s.effectiveRate = batch.effectiveRate;
        if (batch.dropped > 0) s.droppedEvents += batch.dropped;
        if (batch.eventsTruncated !== undefined && batch.eventsTruncated > 0) s.eventsTruncated += batch.eventsTruncated;

        if (batch.events.length > 0) {
          for (const ev of batch.events) s.events.push(castDraft(Object.isFrozen(ev) ? ev : Object.freeze(ev)));
          const excess = s.events.length - EVENT_RING;
          if (excess > 0) s.events.splice(0, excess);
        }

        if (batch.events.length > 0 || authoritative !== undefined || s.inflight.length > 0) {
          s.inflight = castDraft(reconcileInflight(s.inflight as InflightFrame[], batch.events, batch.now, authoritative));
        }

        recordMarkersAndFlashes(s, batch.events, wall);
        applyP1Fields(s, batch);

        if (nextSnapshot !== undefined && nextIndex !== undefined) {
          s.snapshot = castDraft(nextSnapshot);
          s.snapshotIndex = nextIndex;
          pruneAfterSnapshot(s, nextSnapshot, nextIndex);
        }
      });
      if (needResync) resyncHandler?.();
    },

    setSnapshot(snapshot) {
      const frozen = Object.isFrozen(snapshot) ? snapshot : Object.freeze(snapshot);
      const index = buildSnapshotIndex(frozen);
      set((s) => {
        s.now = frozen.now;
        s.nowWall = performance.now();
        s.inflight = castDraft(reconcileInflight(s.inflight as InflightFrame[], [], frozen.now, frozen.inflight));
        s.snapshot = castDraft(frozen);
        s.snapshotIndex = index;
        pruneAfterSnapshot(s, frozen, index);
      });
    },

    setReady(init) {
      const catalog = Object.freeze([...init.catalog]);
      const modules = Object.freeze([...init.modules]);
      const media = Object.freeze([...init.media]);
      set((s) => {
        s.ready = true;
        s.catalog = castDraft(catalog as typeof init.catalog);
        s.modules = castDraft(modules as typeof init.modules);
        s.media = castDraft(media as typeof init.media);
        // Recent models that no longer exist in this build are forgotten.
        const known = new Set(catalog.map((m) => m.type));
        const recent = s.palette.recent.filter((t) => known.has(t));
        if (recent.length !== s.palette.recent.length) s.palette.recent = recent;
      });
      // Media the engine does not offer: the picker shows 'auto', so the canvas must use it too.
      const st = get();
      const effective = effectiveCableMedia(st.cable.media, st.media);
      if (effective !== st.cable.media) st.setCableMedia(effective);
    },

    setTheme(t) {
      applyThemeAttribute(t);
      set((s) => {
        s.theme = t;
      });
      savePersistedUi(persistedSliceOf(get()));
    },

    setTool(t, addDeviceType) {
      set((s) => {
        s.tool = t;
        s.addDeviceType = t === 'add-device' ? (addDeviceType ?? s.addDeviceType) : null;
        if (t !== 'cable') {
          s.pendingCable = null;
          s.cable.open = false;
        }
      });
    },

    select(sel) {
      set((s) => {
        s.selection = sel;
        if (!sel || sel.kind !== 'pdu') s.inspectedPdu = null;
      });
    },

    setHover(sel) {
      if (sameSelection(get().hover, sel)) return;
      set((s) => {
        s.hover = sel;
      });
    },

    setPendingCable(p) {
      set((s) => {
        s.pendingCable = p === null ? null : { ...p, media: p.media ?? s.cable.media };
      });
    },

    setDockTab(t) {
      set((s) => {
        s.dockTab = t;
      });
    },

    setDockHeight(h) {
      set((s) => {
        s.dockHeight = Math.max(0, Math.round(h));
      });
    },

    setInspectorWidth(w) {
      set((s) => {
        s.inspectorWidth = Math.max(0, Math.round(w));
      });
    },

    addTerminal(tab) {
      set((s) => {
        if (!s.terminals.some((t) => t.session === tab.session)) s.terminals.push(tab);
        s.activeTerminal = tab.session;
        s.dockTab = 'terminal';
      });
    },

    removeTerminal(session) {
      set((s) => {
        const i = s.terminals.findIndex((t) => t.session === session);
        if (i >= 0) s.terminals.splice(i, 1);
        if (s.activeTerminal === session) {
          const next = s.terminals[Math.min(Math.max(i, 0), s.terminals.length - 1)];
          s.activeTerminal = next ? next.session : null;
        }
      });
    },

    setActiveTerminal(session) {
      set((s) => {
        s.activeTerminal = session;
      });
    },

    setInspectedPdu(p) {
      set((s) => {
        s.inspectedPdu = castDraft(p);
      });
    },

    setCamera(c) {
      set((s) => {
        s.camera = c;
      });
    },

    setColourByFlow(v) {
      set((s) => {
        s.colourByFlow = v;
      });
    },

    toast(text, kind = 'info') {
      set((s) => {
        s.toastMessage = { id: nextMarkerId++, text, kind };
      });
    },

    dismissToast() {
      set((s) => {
        s.toastMessage = null;
      });
    },

    tickWall(wallNow) {
      const st = get();
      const markerFloor = wallNow - DROP_MARKER_MS;
      const flashFloor = wallNow - FLASH_MS;
      const staleMarkers = st.dropMarkers.some((m) => m.wallCreated < markerFloor);
      const staleFlashes = st.tableFlashes.some((f) => f.wallCreated < flashFloor);
      if (!staleMarkers && !staleFlashes) return;
      set((s) => {
        if (staleMarkers) s.dropMarkers = s.dropMarkers.filter((m) => m.wallCreated >= markerFloor);
        if (staleFlashes) s.tableFlashes = s.tableFlashes.filter((f) => f.wallCreated >= flashFloor);
      });
    },

    // ── P0.5 ─────────────────────────────────────────────────────────────
    setPaletteQuery(q) {
      if (get().palette.query === q) return;
      set((s) => {
        s.palette.query = q;
      });
    },

    setPaletteCategory(c) {
      if (get().palette.category === c) return;
      set((s) => {
        s.palette.category = c;
      });
    },

    togglePaletteGroup(id) {
      set((s) => {
        // A fresh object, so persistence sees the change by reference.
        s.palette.collapsed = { ...s.palette.collapsed, [id]: !(s.palette.collapsed[id] ?? false) };
      });
    },

    setExpandedFamily(f) {
      if (get().palette.expandedFamily === f) return;
      set((s) => {
        s.palette.expandedFamily = f;
      });
    },

    pushRecentModel(type) {
      const cur = get().palette.recent;
      if (cur[0] === type) return;
      const next = [type, ...cur.filter((t) => t !== type)].slice(0, RECENT_LIMIT);
      set((s) => {
        s.palette.recent = next;
      });
    },

    setCableMedia(m) {
      if (get().cable.media === m) return;
      set((s) => {
        s.cable.media = m;
        if (s.pendingCable) s.pendingCable.media = m;
      });
    },

    setCablePickerOpen(open) {
      if (get().cable.open === open) return;
      set((s) => {
        s.cable.open = open;
      });
    },

    setOverlay(k, v) {
      if (get().overlays[k] === v) return;
      set((s) => {
        s.overlays = { ...s.overlays, [k]: v };
      });
    },

    setInspectorTab(t) {
      if (get().inspectorTab === t) return;
      set((s) => {
        s.inspectorTab = t;
      });
    },

    openDesktopWindow(device, app) {
      const existing = get().desktopWindows.find((w) => w.device === device && w.app === app);
      if (existing) {
        get().focusDesktopWindow(existing.id);
        return existing.id;
      }
      const id = nextWindowId++;
      set((s) => {
        const wins = s.desktopWindows;
        while (wins.length >= DESKTOP_WINDOW_LIMIT) {
          let oldest = 0;
          for (let i = 1; i < wins.length; i++) if ((wins[i]?.z ?? 0) < (wins[oldest]?.z ?? 0)) oldest = i;
          wins.splice(oldest, 1);
        }
        const offset = (wins.length % DESKTOP_WINDOW_LIMIT) * DESKTOP_WINDOW_CASCADE;
        const win: DesktopWindow = {
          id,
          device,
          app,
          x: DESKTOP_WINDOW_ORIGIN + offset,
          y: DESKTOP_WINDOW_ORIGIN + offset,
          w: DESKTOP_WINDOW_DEFAULT.w,
          h: DESKTOP_WINDOW_DEFAULT.h,
          z: topZ(wins) + 1,
        };
        wins.push(win);
      });
      return id;
    },

    closeDesktopWindow(id) {
      if (!get().desktopWindows.some((w) => w.id === id)) return;
      set((s) => {
        s.desktopWindows = s.desktopWindows.filter((w) => w.id !== id);
      });
    },

    focusDesktopWindow(id) {
      const wins = get().desktopWindows;
      const target = wins.find((w) => w.id === id);
      if (!target) return;
      const top = topZ(wins);
      if (target.z === top && wins.filter((w) => w.z === top).length === 1) return;
      set((s) => {
        const w = s.desktopWindows.find((x) => x.id === id);
        if (w) w.z = top + 1;
      });
    },

    moveDesktopWindow(id, rect) {
      set((s) => {
        const w = s.desktopWindows.find((x) => x.id === id);
        if (!w) return;
        w.x = Math.round(Number.isFinite(rect.x) ? rect.x : w.x);
        w.y = Math.round(Number.isFinite(rect.y) ? Math.max(0, rect.y) : w.y);
        w.w = Math.round(Math.max(DESKTOP_WINDOW_MIN.w, Number.isFinite(rect.w) ? rect.w : w.w));
        w.h = Math.round(Math.max(DESKTOP_WINDOW_MIN.h, Number.isFinite(rect.h) ? rect.h : w.h));
      });
    },

    // ── P1 ───────────────────────────────────────────────────────────────
    setView(v, tool) {
      rememberEntryView(v);
      const st = get();
      if (st.view === v && (tool === undefined || st.conceptTool === tool)) return;
      set((s) => {
        s.view = v;
        if (tool !== undefined) s.conceptTool = tool;
      });
    },

    showLearn(surface, ids) {
      rememberEntryView(surface);
      set((s) => {
        s.view = surface;
        if (ids?.courseId !== undefined) s.learn.courseId = ids.courseId;
        if (ids?.lessonId !== undefined) s.learn.lessonId = ids.lessonId;
      });
    },

    setSimModeUi(p) {
      set((s) => {
        s.simMode = castDraft({ ...get().simMode, ...p });
      });
    },

    setNetscope(p) {
      set((s) => {
        s.netscope = castDraft({ ...get().netscope, ...p });
      });
    },

    setLab(p) {
      set((s) => {
        s.lab = castDraft({ ...get().lab, ...p });
      });
    },

    setCanvasFocus(id) {
      if (get().a11y.canvasFocus === id) return;
      set((s) => {
        s.a11y.canvasFocus = id;
      });
    },

    announce(text) {
      const trimmed = text.trim();
      if (trimmed === '') return;
      set((s) => {
        s.a11y.announcement = { id: nextAnnouncementId++, text: trimmed };
      });
    },
  })),
);

/** Vanilla store api (getState / setState / subscribe) for non-React code (bridge, hotkeys). */
export const store: StoreApi<Store> = useStore;

/** Start writing preferences to localStorage (App mounts it once); returns the detach function. */
export function startPersistence(): () => void {
  return attachPersistence(store);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function topZ(wins: readonly DesktopWindow[]): number {
  let z = 0;
  for (const w of wins) if (w.z > z) z = w.z;
  return z;
}

/** New simulation generation: ids restart, so everything mirrored from the previous run is discarded. */
function clearHistory(s: Draft<Store>, epoch: number): void {
  s.epoch = epoch;
  s.events = [];
  s.inflight = [];
  s.dropMarkers = [];
  s.tableFlashes = [];
  s.droppedEvents = 0;
  s.eventsTruncated = 0;
  s.inspectedPdu = null;
  if (s.selection?.kind === 'pdu') s.selection = null;
  if (s.hover?.kind === 'pdu') s.hover = null;
  s.desktopWindows = [];
  s.a11y.canvasFocus = null;
  s.simMode.stoppedAt = null;
  // Live captures (c_*) died with the world; imported ones (i_*) are the worker's and survive.
  const ns = s.netscope;
  ns.captures = ns.captures.filter((c) => isImportedCapture(c.id));
  const heads: Record<string, number> = {};
  for (const [id, head] of Object.entries(ns.heads)) if (isImportedCapture(id)) heads[id] = head;
  ns.heads = heads;
  if (ns.active !== null && !isImportedCapture(ns.active)) {
    ns.active = null;
    ns.selected = null;
    ns.streamKey = null;
  }
  // The lab belonged to the world that just went: the panel offers the catalogue again until the worker
  // reports a lab on a batch (loadScenario, or a reopened project carrying one — §4.13).
  s.lab = castDraft({ active: null, status: null, browserOpen: true });
}

/**
 * Mirror the P1 batch fields (protocol.ts EngineBatch): the worker owns the playback mode, the trace head, where a
 * breakpoint stopped, the capture heads that advanced and the lab status. Resuming clears the stop marker, so the
 * sim-events panel never keeps pointing at an event the clock has left behind.
 */
function applyP1Fields(s: Draft<Store>, batch: EngineBatch): void {
  if (batch.playbackMode !== undefined) s.simMode.mode = batch.playbackMode;
  if (batch.traceHead !== undefined) s.simMode.traceHead = batch.traceHead;
  if (batch.stopped !== undefined) s.simMode.stoppedAt = castDraft(batch.stopped);
  else if (batch.playing) s.simMode.stoppedAt = null;
  if (batch.captureHeads !== undefined) s.netscope.heads = { ...s.netscope.heads, ...batch.captureHeads };
  if (batch.lab !== undefined) {
    s.lab.status = castDraft(batch.lab);
    // `null` is the worker saying no lab is active any more: the panel must stop showing the old one.
    if (batch.lab === null) {
      s.lab.active = null;
      s.lab.browserOpen = true;
    }
  }
}

function recordMarkersAndFlashes(s: Draft<Store>, events: readonly TraceEvent[], wall: number): void {
  let flashIndex: Map<string, number> | undefined;
  for (const ev of events) {
    if (ev.kind === 'drop') {
      const at: DropMarker['at'] = {};
      if (ev.device !== undefined) at.device = ev.device;
      if (ev.link !== undefined) at.link = ev.link;
      if (ev.association !== undefined) at.association = ev.association;
      const marker: DropMarker = {
        id: nextMarkerId++,
        pdu: ev.pdu.id,
        at,
        reason: ev.reason,
        simTime: ev.t,
        wallCreated: wall,
      };
      if (ev.detail !== undefined) marker.detail = ev.detail;
      s.dropMarkers.push(marker);
    } else if (ev.kind === 'tableWrite' || ev.kind === 'tableExpire') {
      const flash: TableFlash = {
        device: ev.device,
        table: ev.table,
        key: ev.key,
        kind: ev.kind === 'tableWrite' ? 'write' : 'expire',
        wallCreated: wall,
      };
      if (flashIndex === undefined) {
        flashIndex = new Map();
        s.tableFlashes.forEach((f, i) => flashIndex?.set(`${f.device}|${f.table}|${f.key}`, i));
      }
      const k = `${flash.device}|${flash.table}|${flash.key}`;
      const i = flashIndex.get(k);
      if (i !== undefined) s.tableFlashes[i] = flash;
      else {
        flashIndex.set(k, s.tableFlashes.length);
        s.tableFlashes.push(flash);
      }
    }
    // 'cliPrompt' for a session without a terminal tab is ignored: tabs are opened explicitly through
    // addTerminal by whoever called engine.cliOpen.
  }
  if (s.dropMarkers.length > MAX_DROP_MARKERS) s.dropMarkers.splice(0, s.dropMarkers.length - MAX_DROP_MARKERS);
  if (s.tableFlashes.length > MAX_FLASHES) s.tableFlashes.splice(0, s.tableFlashes.length - MAX_FLASHES);
}

function hasDevice(snapshot: SimSnapshot, index: SnapshotIndex, id: string): boolean {
  const i = index.devices[id];
  return i !== undefined && snapshot.devices[i]?.id === id;
}

function hasLink(snapshot: SimSnapshot, index: SnapshotIndex, id: string): boolean {
  const i = index.links[id];
  return i !== undefined && snapshot.links[i]?.id === id;
}

/** Whether a selection still points at something in the snapshot (PDU selections are pruned by epoch only). */
function selectionAlive(sel: NonNullable<Store['selection']>, snapshot: SimSnapshot, index: SnapshotIndex, live: ReadonlySet<SessionId>): boolean {
  switch (sel.kind) {
    case 'device':
      return hasDevice(snapshot, index, sel.id);
    case 'link':
      return hasLink(snapshot, index, sel.id);
    case 'port':
      return hasDevice(snapshot, index, sel.ref.device);
    case 'session':
      return live.has(sel.id);
    case 'association':
      return snapshot.media?.associations.some((a) => a.id === sel.id) ?? false;
    case 'slot': {
      const i = index.devices[sel.device];
      const dev = i === undefined ? undefined : snapshot.devices[i];
      return dev?.id === sel.device && (dev.slots?.some((x) => x.id === sel.slot) ?? false);
    }
    case 'pdu':
      return true;
  }
}

function pruneAfterSnapshot(s: Draft<Store>, snapshot: SimSnapshot, index: SnapshotIndex): void {
  // Sessions that no longer exist (reset, load, device removed) lose their terminal tabs.
  const live = new Set<SessionId>(snapshot.sessions.map((v) => v.id));
  if (s.terminals.some((t) => !live.has(t.session))) {
    s.terminals = s.terminals.filter((t) => live.has(t.session));
    if (s.activeTerminal !== null && !live.has(s.activeTerminal)) {
      const first = s.terminals[0];
      s.activeTerminal = first ? first.session : null;
    }
  }
  // A selection or hover pointing at something that vanished is cleared.
  if (s.selection && !selectionAlive(s.selection, snapshot, index, live)) s.selection = null;
  if (s.hover && !selectionAlive(s.hover, snapshot, index, live)) s.hover = null;
  const pc = s.pendingCable;
  if (pc && !hasDevice(snapshot, index, pc.from.device)) s.pendingCable = null;
  const focus = s.a11y.canvasFocus;
  if (focus !== null && !hasDevice(snapshot, index, focus)) s.a11y.canvasFocus = null;
  if (s.desktopWindows.some((w) => !hasDevice(snapshot, index, w.device))) {
    s.desktopWindows = s.desktopWindows.filter((w) => hasDevice(snapshot, index, w.device));
  }
}

function sameSelection(a: Store['hover'], b: Store['hover']): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  return selectionKey(a) === selectionKey(b);
}
