/**
 * UI state store shape (spec §3.3 "State: UI state only; sim state is mirrored read-only").
 *
 * Implemented with zustand (+ immer) in `store/store.ts`. Sim state arrives
 * only through `EngineBatch`es: `applyBatch` is the single write path for
 * `snapshot`, `now`, `inflight` and `events`.
 *
 * P0.5/P1 members are optional in the type until the web wave that implements them removes the `?` (engine
 * contracts/port.ts TRANSITION RULE). P2 members tagged `@since P2` (ARCHITECTURE-P2 §0 rule 2) are required since the
 * W8 exit gate, except the ones tagged `@since P2 (optional by meaning)` (`LabUiState.checking`). Course-layer
 * members are tagged `@since course`: they are delivered and required, and the P2 transition sweep never touches
 * them. Epoch change additionally clears: simMode.stoppedAt,
 * netscope live captures (keeps i_*), lab.status, desktopWindows, a11y.canvasFocus, eventsTruncated, and (P3 [S2])
 * resets `routingUi`.
 * Persisted to localStorage (try/catch): theme, palette.collapsed/recent, cable.media, overlays, dock layout,
 * (P2 W2 web-shell) `topoOverlays` and `learn.lastCourse`, and (P2, store/store.ts `rememberEntryView`) whether the
 * last surface was the sandbox or the course layer. (P3 W2 web-shell) `topoOverlays` gains the QoS, OSPF, WAN and
 * EIGRP keys: a stored P2 record has none of them, and each takes its default (store/persist.ts).
 */
import type {
  CaptureId,
  CaptureInfo,
  ConceptToolId,
  DeviceCategory,
  DeviceId,
  DeviceModel,
  DropRule,
  GuiPanelId,
  InflightFrame,
  JournalPosition,
  LabStatus,
  LaneId,
  LinkId,
  MediaSpec,
  MediaType,
  ModuleModel,
  PduId,
  PduJson,
  PortRef,
  ScenarioMeta,
  Selection,
  SessionId,
  SimSnapshot,
  SimTime,
  TraceEvent,
  TraceFilter,
} from '@netforge/engine';
import type { EngineBatch, InitResult, PlaybackMode, ReviewInfo, StopInfo } from '../bridge/protocol';

export type Tool = 'select' | 'cable' | 'add-device' | 'pan';
/** Dock tabs; `netscope`, `sim-events` and `labs` @since P1 (one registry: apps/web/src/dock/registry.ts). */
/**
 * 'routing' @since P3 [S2] (the LSDB browser, "Link state"): registered in W0 at dock stage P3, shown since the W4
 * web-shell item set DOCK_STAGE 'P3' and mapped it to the lazy routing/LinkStatePanel (ARCHITECTURE-P3 §2.14).
 */
export type DockTab = 'terminal' | 'packets' | 'events' | 'tables' | 'provenance' | 'netscope' | 'sim-events' | 'labs' | 'routing';
export type Theme = 'dark' | 'light';

/**
 * @since course Course layer surfaces (apps/web/src/learn/**): the level chooser, one course, one lesson. They cover
 * the whole window, so the shell hides the sandbox grid behind them instead of unmounting it.
 */
export type LearnSurface = 'landing' | 'course' | 'lesson';

/**
 * @since P1 Workspace view: the topology canvas or a full-screen concept tool (Canvas stays mounted, hidden).
 * @since course …or a learn surface, which covers the whole window (`isLearnView`).
 */
export type WorkspaceView = 'topology' | 'concept' | LearnSurface;
/**
 * The concept tools a view can open. @since P3 the one engine contract `ConceptToolId` (ARCHITECTURE-P3 D24, §2.14):
 * the local union is gone, so a new tool id is added once, in the engine.
 */
export type ConceptTool = ConceptToolId;

/** The learn surfaces, in the order you meet them. */
export const LEARN_SURFACES: readonly LearnSurface[] = Object.freeze(['landing', 'course', 'lesson']);

/** @since course True for the views the course layer owns; the two sandbox views ('topology', 'concept') are false. */
export function isLearnView(v: WorkspaceView | undefined): v is LearnSurface {
  return v === 'landing' || v === 'course' || v === 'lesson';
}
/** @since P0.5 Inspector tabs, derived per device from capabilities and `DeviceModel.gui` (clamped to 'overview'). */
export type InspectorTab = 'overview' | 'ports' | 'config' | 'tables' | 'processes' | 'physical' | 'desktop' | 'wireless' | 'services';

export interface TerminalTab {
  session: SessionId;
  device: DeviceId;
  title: string;
}

export interface PendingCable {
  from: PortRef;
  /** @since P0.5 Media chosen in the cable picker (`setPendingCable` fills the picker's current media when omitted). */
  media: MediaType;
}

/** A dropped-packet marker that floats at a device/link for a short wall time. */
export interface DropMarker {
  id: number;
  pdu: PduId;
  at: { device?: DeviceId; link?: LinkId; /** @since P0.5 */ association?: string };
  reason: string;
  detail?: string;
  simTime: SimTime;
  wallCreated: number;
  /**
   * @since P3 (optional by meaning; ruling R42, W4 web-shell) The policy rule behind the drop (D12, D13: an access list
   * entry, DHCP snooping, ARP inspection), copied from the drop event's `rule`; absent for every drop without one
   * (every P1/P2 drop). The marker layer names it on the detail line (`canvas/markers.ts` `dropRuleLabel`).
   */
  rule?: DropRule;
}

/** A table row that should flash (write) or fade (expire). */
export interface TableFlash {
  device: DeviceId;
  table: string;
  key: string;
  kind: 'write' | 'expire';
  wallCreated: number;
}

/** @since P0.5 O(1) lookup index rebuilt on full snapshots (deltas keep it). */
export interface SnapshotIndex {
  topologyVersion: number;
  devices: Record<DeviceId, number>;
  links: Record<LinkId, number>;
}

/** @since P0.5 Palette v2 state. */
export interface PaletteUiState {
  query: string;
  category: DeviceCategory | 'all';
  /** Persisted. */
  collapsed: Record<string, boolean>;
  /** Family whose variants are expanded. */
  expandedFamily: string | null;
  /** Persisted, most recent first, ≤ 8 model types. */
  recent: string[];
}

/** @since P0.5 */
export interface CablePickerState {
  /** Persisted; default 'auto'. */
  media: MediaType;
  open: boolean;
}

/** @since P0.5 Wireless overlay toggles (persisted). Every overlay has a non-colour channel. */
export interface WirelessOverlayState {
  rangeRings: boolean;
  associationLines: boolean;
  signalBars: boolean;
  radioBeams: boolean;
  channelLabels: boolean;
  backgroundFrames: boolean;
}

/**
 * @since P2 Switching (and controller) overlay toggles (ARCHITECTURE-P2 §2.14, D20): a NEW persisted slice, so the
 * WirelessOverlayState keys stay exactly as canvas.overlays.test.ts pins them. `stpVlan` / `vlanFocus` choose the VLAN
 * the STP overlay draws and the VLAN the VLAN overlay focuses (null = the lowest / none).
 */
export interface TopoOverlayState {
  vlan: boolean;
  stp: boolean;
  stpVlan: number | null;
  vlanFocus: number | null;
  capwap: boolean;
  /**
   * @since P3 (ARCHITECTURE-P3 §2.14, M13; W2 web-shell) FIFO stacks at congested egress ports (from
   * `PortSnapshot.txBacklog`) and cable load sleeves.
   */
  qos: boolean;
  /** @since P3 [S1] The OSPF overlay: adjacencies, DR/BDR letters, costs and area zones. */
  ospf: boolean;
  /** @since P3 [S1] The one area the OSPF overlay keeps (dotted, '0.0.0.0'); null = every area. */
  ospfArea: string | null;
  /** @since P3 [S18]/[S19] The WAN overlay: PPP phase rails and tunnels. */
  wan: boolean;
  /** @since P3 [C1] The EIGRP overlay: successors and feasible successors for one destination. */
  eigrp: boolean;
  /** @since P3 [C1] The destination the EIGRP overlay draws ('10.0.12.0/24'); null = the first one a router knows. */
  eigrpPrefix: string | null;
}

/**
 * @since P3 [S2] The link-state browser's selection (ARCHITECTURE-P3 §2.14; W2 web-shell; read by the W3
 * `routing/*` panels). Not persisted: a new epoch resets it, since its device id belonged to the world that went.
 * `lsa` is the key of the LSA shown in detail; `spf` is the SPF stepper's frame and whether it is playing.
 */
export interface RoutingUiState {
  device: DeviceId | null;
  area: string | null;
  lsa: string | null;
  spf: { step: number; playing: boolean };
}

/**
 * @since P2 [SHOULD S1] Timeline and review state. `review` and `head` mirror the worker (batches are the only write
 * path); `reviewEvents` holds at most 2000 events of the reviewed instant and never mixes with `events`.
 * `head.lanesRevision` (W6 fix, §9.2 item 25a) is the worker's lane-index revision: it grows when an event joins a
 * lane even while sim time stands still (a configuration change while paused), so the strip keys its queries on it.
 */
export interface TimelineUiState {
  review: ReviewInfo | null;
  head: { t: SimTime; at: JournalPosition; lanesRevision: number } | null;
  lanes: LaneId[];
  seeking: boolean;
  reviewEvents: TraceEvent[];
}

/**
 * @since P1 Simulation mode as the UI knows it (§4.11). `mode`, `stoppedAt` and `traceHead` mirror the worker
 * (batches are the only write path for them); `list` and `breakOn` are what the filter chips and the breakpoint
 * editor hold, and reach the worker through `engine.setSimFilters`.
 */
export interface SimModeUiState {
  mode: PlaybackMode;
  list: TraceFilter;
  breakOn: TraceFilter | null;
  stoppedAt: StopInfo | null;
  traceHead: number;
}

/**
 * @since P1 NetScope (§4.12). `captures` and `heads` mirror the worker; the rest is what the three panes show.
 * `filterText` is the box as typed, `applied` the last text that parsed and was run — a typo therefore never
 * blanks the list.
 */
export interface NetScopeUiState {
  captures: CaptureInfo[];
  active: CaptureId | null;
  filterText: string;
  applied: string;
  selected: number | null;
  pane: 'packets' | 'stream' | 'stats';
  streamKey: string | null;
  heads: Record<CaptureId, number>;
}

/**
 * @since course Course layer state: which course the learner opened and which lesson inside it. Ids only — the
 * course catalogue itself is plain data in the engine (`COURSES`), so nothing of it is copied into the store.
 */
export interface LearnUiState {
  courseId: string | null;
  lessonId: string | null;
  /**
   * @since P2 The course of the last lesson opened (persisted; W2 web-shell). It is the course context a new world
   * takes its defaults profile from (`learn/course-profile.ts`, D2): null until a lesson has been opened.
   */
  lastCourse: string | null;
}

/** @since P1 Lab state (§4.13): the loaded lab's metadata, its last grading, and whether the catalogue is open. */
export interface LabUiState {
  active: ScenarioMeta | null;
  status: LabStatus | null;
  browserOpen: boolean;
  /**
   * @since P2 (optional by meaning) absent = no check running (W6 fix, §9.2 items 22c and 25a). True while a lab check
   * runs, whichever control started it — the Labs panel's button or Simulation → "Check the lab now" — so the panel,
   * the status bar and the menu all show the same busy state and a long check never looks like a hang.
   */
  checking?: boolean;
}

/** @since P0.5 A floating non-modal GUI window (Desktop apps, pop-out settings panels). */
export interface DesktopWindow {
  id: number;
  device: DeviceId;
  app: GuiPanelId;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

/** @since P0.5 Keyboard canvas navigation and live announcements (§16). */
export interface A11yState {
  canvasFocus: DeviceId | null;
  announcement: { id: number; text: string } | null;
}

export interface UiState {
  // ── engine mirror (read-only, written only by applyBatch/setSnapshot) ──
  ready: boolean;
  /**
   * Simulation generation of the last applied batch (`EngineBatch.epoch`); -1 before the
   * first. A change means reset/load: ids restart, so mirrored history is discarded.
   */
  epoch: number;
  catalog: DeviceModel[];
  snapshot: SimSnapshot | null;
  /** Sim time at the last batch. The canvas extrapolates between batches: `now + effectiveRate × wallElapsedMs` while playing. */
  now: SimTime;
  /** Wall time (performance.now()) when `now` was received — for extrapolation. */
  nowWall: number;
  playing: boolean;
  rate: number;
  /** From the last batch: sim ns per wall ms actually achieved (clock policy may clamp below rate). */
  effectiveRate: number;
  /** Frames currently animating; pruned when `arrive < now - grace`. Identity `(pdu.id, link, to)` from P0.5. */
  inflight: InflightFrame[];
  /** Ring of recent trace events (newest last), capped at `EVENT_RING`. */
  events: TraceEvent[];
  droppedEvents: number;
  /** Selected PDU details, fetched on demand. */
  inspectedPdu: PduJson | null;

  // ── ui state ───────────────────────────────────────────────────────────
  theme: Theme;
  tool: Tool;
  /** Catalog type chosen for the add-device tool. */
  addDeviceType: string | null;
  selection: Selection | null;
  hover: Selection | null;
  pendingCable: PendingCable | null;
  dockTab: DockTab;
  dockHeight: number;
  inspectorWidth: number;
  terminals: TerminalTab[];
  activeTerminal: SessionId | null;
  dropMarkers: DropMarker[];
  tableFlashes: TableFlash[];
  /** Follow this device's packets / auto-open provenance for a flow. */
  colourByFlow: boolean;
  /** Camera (canvas) — owned by the canvas module but mirrored for the minimap/status bar. */
  camera: { x: number; y: number; zoom: number };
  /**
   * The visible notification, if any. (Named `toastMessage` because `UiActions.toast()` is
   * the action that shows one; the two cannot share a key in `Store = UiState & UiActions`.)
   */
  toastMessage: { id: number; text: string; kind: 'info' | 'warn' | 'error' } | null;

  // ── P0.5 / P1 ──
  /** Undefined until the first full snapshot. */
  snapshotIndex: SnapshotIndex | undefined;
  /** Events the worker left out of batches because of the per-batch cap (since the last epoch). */
  eventsTruncated: number;
  modules: ModuleModel[];
  media: MediaSpec[];
  view: WorkspaceView;
  conceptTool: ConceptTool;
  palette: PaletteUiState;
  cable: CablePickerState;
  overlays: WirelessOverlayState;
  simMode: SimModeUiState;
  netscope: NetScopeUiState;
  lab: LabUiState;
  /** @since course */
  learn: LearnUiState;
  inspectorTab: InspectorTab;
  desktopWindows: DesktopWindow[];
  a11y: A11yState;

  // ── P2 ──
  /** @since P2 Switching overlay toggles and VLAN selectors (persisted). Required since W2 web-shell. */
  topoOverlays: TopoOverlayState;
  /**
   * @since P2 [SHOULD S1] Timeline and review (W4 web-shell; required since the W8 exit gate). Not persisted: the
   * store's initial state holds `defaultTimelineUi()` and a new epoch resets it in place, so the slice always exists.
   */
  timeline: TimelineUiState;

  // ── P3 ──
  /** @since P3 [S2] The link-state browser's selection (not persisted; reset by a new epoch). */
  routingUi: RoutingUiState;
}

export interface UiActions {
  /** P0.5: merges `batch.delta` by index (identity of untouched devices kept); resyncs on topologyVersion mismatch. */
  applyBatch(batch: EngineBatch): void;
  setSnapshot(s: SimSnapshot): void;
  /** Engine initialised: catalog, module catalog and media table (P0.5). */
  setReady(init: InitResult): void;
  setTheme(t: Theme): void;
  setTool(t: Tool, addDeviceType?: string): void;
  select(sel: Selection | null): void;
  setHover(sel: Selection | null): void;
  /** Start or clear a pending cable; `media` defaults to the picker's current media (`cable.media`). */
  setPendingCable(p: (Omit<PendingCable, 'media'> & { media?: MediaType }) | null): void;
  setDockTab(t: DockTab): void;
  setDockHeight(h: number): void;
  setInspectorWidth(w: number): void;
  addTerminal(tab: TerminalTab): void;
  removeTerminal(session: SessionId): void;
  setActiveTerminal(session: SessionId | null): void;
  setInspectedPdu(p: PduJson | null): void;
  setCamera(c: { x: number; y: number; zoom: number }): void;
  setColourByFlow(v: boolean): void;
  toast(text: string, kind?: 'info' | 'warn' | 'error'): void;
  dismissToast(): void;
  /** Called from a wall-clock ticker to expire drop markers / flashes. */
  tickWall(wallNow: number): void;

  // ── P0.5 / P1 ──
  setView(v: WorkspaceView, tool?: ConceptTool): void;
  setPaletteQuery(q: string): void;
  setPaletteCategory(c: DeviceCategory | 'all'): void;
  togglePaletteGroup(id: string): void;
  setExpandedFamily(f: string | null): void;
  pushRecentModel(type: string): void;
  setCableMedia(m: MediaType): void;
  setCablePickerOpen(open: boolean): void;
  setOverlay<K extends keyof WirelessOverlayState>(k: K, v: boolean): void;
  setSimModeUi(p: Partial<SimModeUiState>): void;
  setNetscope(p: Partial<NetScopeUiState>): void;
  setLab(p: Partial<LabUiState>): void;
  /**
   * @since course Show a learn surface and, with it, what that surface shows. Ids left out keep their value, so
   * going back from a lesson to its course never loses which course it was.
   */
  showLearn(surface: LearnSurface, ids?: Partial<LearnUiState>): void;
  setInspectorTab(t: InspectorTab): void;
  /** Opens (or focuses the existing) window for `device`/`app`; returns its id. The least recently focused window closes beyond DESKTOP_WINDOW_LIMIT. */
  openDesktopWindow(device: DeviceId, app: GuiPanelId): number;
  closeDesktopWindow(id: number): void;
  focusDesktopWindow(id: number): void;
  moveDesktopWindow(id: number, rect: { x: number; y: number; w: number; h: number }): void;
  setCanvasFocus(id: DeviceId | null): void;
  announce(text: string): void;

  // ── P2 ──
  /** @since P2 Set one switching overlay toggle or selector (the slice object is replaced, so persistence sees it). */
  setTopoOverlay<K extends keyof TopoOverlayState>(k: K, v: TopoOverlayState[K]): void;
  /** @since P2 Record the course of the lesson just opened (`learn.lastCourse`, persisted; W2 web-shell). */
  setLastCourse(courseId: string | null): void;

  // ── P3 ──
  /**
   * @since P3 [S2] Merge into the link-state browser's selection. The slice object is replaced when anything changed
   * (`spf` is replaced whole when given) and kept when nothing did.
   */
  setRoutingUi(p: Partial<RoutingUiState>): void;
}

export type Store = UiState & UiActions;

export const EVENT_RING = 5000;
export const DROP_MARKER_MS = 2500;
export const FLASH_MS = 900;
/** @since P0.5 */
export const DESKTOP_WINDOW_LIMIT = 6;
