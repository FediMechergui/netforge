/**
 * The one dock tab registry (ARCHITECTURE-P1 §7 "Shell"): the Dock tab strip, the digit hotkeys, the View menu and
 * the Help list all read `DOCK_TABS`. The registry is data only (no component imports), so hotkeys and menus can
 * use it without pulling panel code in; `app/Dock.tsx` maps each id to its panel.
 *
 * `stage` says when a tab ships. Tabs of a later stage stay registered (the `DockTab` union already names them) but
 * are hidden until that stage's panels exist; `DOCK_STAGE` is the stage this build ships.
 *
 * @since P3 [S2] (ARCHITECTURE-P3 §2.14, §6, §9.2 item 36b; W4 web-shell) `DOCK_STAGE` is 'P3': the `routing` tab
 * ("Link state", the LSDB browser and SPF stepper) is shown after `labs` and takes the digit hotkey 9. `dockPaneShown`
 * says whether a tab's panel is actually on screen (the dock's tab, the dock not collapsed, the tab shipped): the canvas
 * `spf` layer follows the stepper only while the link-state browser is visible (`OverlaySyncInput.routing.shown`).
 */
import type { DockTab } from '../store/types';

/** 'P3' @since P3 [S2] (ARCHITECTURE-P3 §2.14): the stage of the `routing` tab, shown since the W4 web-shell item. */
export type DockStage = 'P0' | 'P0.5' | 'P1' | 'P3';

export interface DockTabDef {
  readonly id: DockTab;
  readonly label: string;
  /** One-line description (tooltips, View menu). */
  readonly description: string;
  /** Digit hotkey '1'…'9', assigned in registry order to the available tabs. */
  readonly hotkey?: string;
  /** The panel stays mounted while hidden (terminal sessions, capture state). */
  readonly keepMounted: boolean;
  readonly stage: DockStage;
}

/** The stage of this build ('P3' since the W4 web-shell item, §9.2 item 36b: the `routing` tab is shown). */
export const DOCK_STAGE: DockStage = 'P3';

/** Dock heights (CSS pixels): at or below `DOCK_MIN_HEIGHT` the dock shows only its tab strip. */
export const DOCK_MIN_HEIGHT = 30;
export const DOCK_COLLAPSED_HEIGHT = 0;
/** Height the dock opens to when it is revealed from the collapsed state. */
export const DOCK_OPEN_HEIGHT = 260;
/** Inspector widths (CSS pixels): below `INSPECTOR_HIDDEN_BELOW` the inspector counts as hidden. */
export const INSPECTOR_HIDDEN_BELOW = 40;
export const INSPECTOR_OPEN_WIDTH = 340;

const STAGE_RANK: Readonly<Record<DockStage, number>> = Object.freeze({ P0: 0, 'P0.5': 1, P1: 2, P3: 3 });

interface DockTabInput {
  id: DockTab;
  label: string;
  description: string;
  keepMounted: boolean;
  stage: DockStage;
}

const ALL_TABS: readonly DockTabInput[] = [
  { id: 'terminal', label: 'Terminal', description: 'Console sessions on your devices.', keepMounted: true, stage: 'P0' },
  { id: 'packets', label: 'Packets', description: 'Frames put on cables and radio links.', keepMounted: false, stage: 'P0' },
  { id: 'events', label: 'Events', description: 'Everything the simulation reported, with filters.', keepMounted: false, stage: 'P0' },
  { id: 'tables', label: 'Tables', description: 'MAC, ARP and routing tables of every device.', keepMounted: false, stage: 'P0' },
  { id: 'provenance', label: 'Provenance', description: 'Why a packet changed on its way.', keepMounted: false, stage: 'P0' },
  // P1: NetScope keeps its filter text, paging position and follow-stream pane across tab switches.
  { id: 'netscope', label: 'NetScope', description: 'Capture and analyse traffic.', keepMounted: true, stage: 'P1' },
  { id: 'sim-events', label: 'Sim events', description: 'Step through matching events with breakpoints.', keepMounted: false, stage: 'P1' },
  { id: 'labs', label: 'Labs', description: 'Lab instructions and task checks.', keepMounted: false, stage: 'P1' },
  // P3 [S2] (ARCHITECTURE-P3 §2.14; registered by the architect in W0, shown by the W4 web-shell item): the ninth tab,
  // so it takes the digit hotkey 9 (app/Dock.tsx maps it to the lazy routing/LinkStatePanel).
  { id: 'routing', label: 'Link state', description: 'Link-state databases and shortest-path trees of OSPF routers.', keepMounted: false, stage: 'P3' },
];

export function isStageAvailable(stage: DockStage, build: DockStage = DOCK_STAGE): boolean {
  return STAGE_RANK[stage] <= STAGE_RANK[build];
}

/** Build the registry for a stage: available tabs only, digit hotkeys in order (at most nine). */
export function buildDockTabs(build: DockStage = DOCK_STAGE): readonly DockTabDef[] {
  const out: DockTabDef[] = [];
  for (const t of ALL_TABS) {
    if (!isStageAvailable(t.stage, build)) continue;
    const n = out.length + 1;
    out.push(Object.freeze(n <= 9 ? { ...t, hotkey: String(n) } : { ...t }));
  }
  return Object.freeze(out);
}

/** Dock tabs of this build, in strip order. */
export const DOCK_TABS: readonly DockTabDef[] = buildDockTabs();

export function dockTabDef(id: DockTab): DockTabDef | undefined {
  return DOCK_TABS.find((t) => t.id === id);
}

/** Whether `id` is a dock tab this build shows. */
export function isDockTabAvailable(id: string): id is DockTab {
  return DOCK_TABS.some((t) => t.id === id);
}

/** The tab bound to a digit key, if any. */
export function dockTabForHotkey(key: string): DockTab | undefined {
  return DOCK_TABS.find((t) => t.hotkey === key)?.id;
}

/**
 * @since P3 [S2] Whether the panel of `tab` is on screen: it is the dock's tab, the dock is open (taller than its tab
 * strip, `DOCK_MIN_HEIGHT`) and this build ships the tab. The canvas and its keyboard outline read it for the
 * `routing` tab (`OverlaySyncInput.routing.shown`), so the `spf` layer follows the SPF stepper only while the
 * link-state browser is visible.
 */
export function dockPaneShown(tab: DockTab, state: { readonly dockTab: DockTab; readonly dockHeight: number }): boolean {
  return state.dockTab === tab && state.dockHeight > DOCK_MIN_HEIGHT && isDockTabAvailable(tab);
}

/** Range text for help lists, e.g. "1 – 5". */
export function dockHotkeyRange(): string {
  const keys = DOCK_TABS.map((t) => t.hotkey).filter((k): k is string => k !== undefined);
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (first === undefined || last === undefined) return '';
  return first === last ? first : `${first} – ${last}`;
}
