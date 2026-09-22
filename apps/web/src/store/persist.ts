/**
 * Persisted UI preferences (store/types.ts header): theme, palette collapse state and recent models, the cable
 * picker media, the wireless overlay toggles, the dock layout (tab, height, inspector width) and, from P2 (W2
 * web-shell), the switching overlay slice (`topoOverlays`) and the course of the last lesson opened
 * (`learn.lastCourse`, the course context a new world takes its defaults profile from, D2).
 *
 * Everything goes through try/catch: storage may be missing (private mode, sandboxed frames, tests) and stored
 * values are untrusted, so every field is validated and unknown or malformed values fall back to the defaults.
 * The theme keeps its P0 key; the rest lives in one versioned JSON record.
 */
import { MEDIA, type MediaType } from '@netforge/engine';
import type { StoreApi } from 'zustand';
import { MEDIA_PICKER_ORDER } from '../vocab/media';
import { DOCK_OPEN_HEIGHT, INSPECTOR_OPEN_WIDTH, isDockTabAvailable } from '../dock/registry';
import type { DockTab, Store, Theme, TopoOverlayState, WirelessOverlayState } from './types';

export const THEME_KEY = 'netforge.theme';
export const UI_PREFS_KEY = 'netforge.ui.v1';
/** Most recent palette models kept (palette-query PALETTE_RECENT_LIMIT). */
export const RECENT_LIMIT = 8;
/** Bound on persisted collapse flags, so a corrupted record cannot grow without limit. */
const COLLAPSED_LIMIT = 256;
/** Debounce of preference writes (ms). */
export const PERSIST_DEBOUNCE_MS = 200;

export const DEFAULT_OVERLAYS: Readonly<WirelessOverlayState> = Object.freeze({
  rangeRings: false,
  associationLines: true,
  signalBars: true,
  radioBeams: true,
  channelLabels: false,
  backgroundFrames: false,
});

/**
 * @since P2 Every switching overlay off and no VLAN chosen (the same values as the canvas registry's
 * `TOPO_OVERLAY_DEFAULTS`, kept here so the store reads nothing from the canvas at module scope).
 */
export const DEFAULT_TOPO_OVERLAYS: Readonly<TopoOverlayState> = Object.freeze({
  vlan: false,
  stp: false,
  stpVlan: null,
  vlanFocus: null,
  capwap: false,
});
/** @since P2 Highest VLAN id a persisted selector may name (802.1Q VID range). */
export const VLAN_ID_MAX = 4094;
/** @since P2 Bound on a persisted course id. */
const COURSE_ID_LIMIT = 64;

export const DEFAULT_DOCK_TAB: DockTab = 'terminal';
export const DEFAULT_DOCK_HEIGHT = DOCK_OPEN_HEIGHT;
export const DEFAULT_INSPECTOR_WIDTH = INSPECTOR_OPEN_WIDTH;
const OVERLAY_KEYS = Object.keys(DEFAULT_OVERLAYS) as (keyof WirelessOverlayState)[];
const TOPO_TOGGLE_KEYS = ['vlan', 'stp', 'capwap'] as const;
const TOPO_VLAN_KEYS = ['stpVlan', 'vlanFocus'] as const;

export interface PersistedUi {
  theme: Theme;
  palette: { collapsed: Record<string, boolean>; recent: string[] };
  cable: { media: MediaType };
  overlays: WirelessOverlayState;
  dock: { tab: DockTab; height: number; inspectorWidth: number };
  /** @since P2 */
  topoOverlays: TopoOverlayState;
  /** @since P2 */
  learn: { lastCourse: string | null };
}

export function defaultPersistedUi(): PersistedUi {
  return {
    theme: 'dark',
    palette: { collapsed: {}, recent: [] },
    cable: { media: 'auto' },
    overlays: { ...DEFAULT_OVERLAYS },
    dock: { tab: DEFAULT_DOCK_TAB, height: DEFAULT_DOCK_HEIGHT, inspectorWidth: DEFAULT_INSPECTOR_WIDTH },
    topoOverlays: { ...DEFAULT_TOPO_OVERLAYS },
    learn: { lastCourse: null },
  };
}

/** @since P2 A VLAN selector value: null (no choice) or an integer VLAN id in 1…VLAN_ID_MAX. */
export function isVlanChoice(v: unknown): v is number | null {
  return v === null || (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= VLAN_ID_MAX);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isMediaType(v: unknown): v is MediaType {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(MEDIA, v);
}

/** Only tabs this build shows are restored (a tab of a later stage falls back to the default). */
function isDockTab(v: unknown): v is DockTab {
  return typeof v === 'string' && isDockTabAvailable(v);
}

function size(v: unknown, fallback: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : fallback;
}

/** Validate an untrusted record (as parsed from storage) into complete preferences. */
export function sanitizePersistedUi(raw: unknown, theme: unknown = undefined): PersistedUi {
  const out = defaultPersistedUi();
  if (theme === 'light' || theme === 'dark') out.theme = theme;
  if (!isRecord(raw)) return out;

  const palette = raw.palette;
  if (isRecord(palette)) {
    if (isRecord(palette.collapsed)) {
      for (const [k, v] of Object.entries(palette.collapsed).slice(0, COLLAPSED_LIMIT)) {
        if (typeof v === 'boolean' && k.length <= 64) out.palette.collapsed[k] = v;
      }
    }
    if (Array.isArray(palette.recent)) {
      const seen = new Set<string>();
      for (const t of palette.recent) {
        if (typeof t !== 'string' || t.length === 0 || t.length > 64 || seen.has(t)) continue;
        seen.add(t);
        out.palette.recent.push(t);
        if (out.palette.recent.length >= RECENT_LIMIT) break;
      }
    }
  }

  // Only media the cable picker offers: a legacy or crafted key (e.g. 'serial') falls back to 'auto'.
  if (isRecord(raw.cable) && isMediaType(raw.cable.media) && MEDIA_PICKER_ORDER.includes(raw.cable.media)) out.cable.media = raw.cable.media;

  if (isRecord(raw.overlays)) {
    for (const k of OVERLAY_KEYS) {
      const v = raw.overlays[k];
      if (typeof v === 'boolean') out.overlays[k] = v;
    }
  }

  if (isRecord(raw.dock)) {
    if (isDockTab(raw.dock.tab)) out.dock.tab = raw.dock.tab;
    out.dock.height = size(raw.dock.height, DEFAULT_DOCK_HEIGHT, 10_000);
    out.dock.inspectorWidth = size(raw.dock.inspectorWidth, DEFAULT_INSPECTOR_WIDTH, 10_000);
  }

  // P2: the switching overlays — booleans for the toggles, a VLAN id or null for the two selectors.
  if (isRecord(raw.topoOverlays)) {
    for (const k of TOPO_TOGGLE_KEYS) {
      const v = raw.topoOverlays[k];
      if (typeof v === 'boolean') out.topoOverlays[k] = v;
    }
    for (const k of TOPO_VLAN_KEYS) {
      const v = raw.topoOverlays[k];
      if (isVlanChoice(v)) out.topoOverlays[k] = v;
    }
  }

  // P2: the course context (a course id the catalogue may or may not still know; the consumer treats it as a name).
  if (isRecord(raw.learn)) {
    const v = raw.learn.lastCourse;
    if (typeof v === 'string' && v.length > 0 && v.length <= COURSE_ID_LIMIT) out.learn.lastCourse = v;
  }
  return out;
}

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Read the stored preferences (defaults when storage is unavailable or the record is malformed). */
export function loadPersistedUi(): PersistedUi {
  const ls = storage();
  if (!ls) return defaultPersistedUi();
  let theme: string | null = null;
  let raw: unknown;
  try {
    theme = ls.getItem(THEME_KEY);
  } catch {
    theme = null;
  }
  try {
    const text = ls.getItem(UI_PREFS_KEY);
    raw = text === null ? undefined : (JSON.parse(text) as unknown);
  } catch {
    raw = undefined;
  }
  return sanitizePersistedUi(raw, theme);
}

/** The persisted slice of a store state. */
export function persistedSliceOf(
  s: Pick<Store, 'theme' | 'palette' | 'cable' | 'overlays' | 'dockTab' | 'dockHeight' | 'inspectorWidth' | 'topoOverlays' | 'learn'>,
): PersistedUi {
  return {
    theme: s.theme,
    palette: { collapsed: s.palette.collapsed, recent: s.palette.recent },
    cable: { media: s.cable.media },
    overlays: s.overlays,
    dock: { tab: s.dockTab, height: s.dockHeight, inspectorWidth: s.inspectorWidth },
    topoOverlays: s.topoOverlays,
    learn: { lastCourse: s.learn.lastCourse },
  };
}

/** Write preferences; returns false when storage refused (quota, private mode). */
export function savePersistedUi(p: PersistedUi): boolean {
  const ls = storage();
  if (!ls) return false;
  try {
    ls.setItem(THEME_KEY, p.theme);
    const { theme: _theme, ...rest } = p;
    ls.setItem(UI_PREFS_KEY, JSON.stringify(rest));
    return true;
  } catch {
    return false;
  }
}

/** True when a state change touched a persisted field (reference comparison; the store replaces what it edits). */
export function persistedChanged(a: Store, b: Store): boolean {
  return (
    a.theme !== b.theme ||
    a.palette.collapsed !== b.palette.collapsed ||
    a.palette.recent !== b.palette.recent ||
    a.cable.media !== b.cable.media ||
    a.overlays !== b.overlays ||
    a.dockTab !== b.dockTab ||
    a.dockHeight !== b.dockHeight ||
    a.inspectorWidth !== b.inspectorWidth ||
    a.topoOverlays !== b.topoOverlays ||
    a.learn.lastCourse !== b.learn.lastCourse
  );
}

/**
 * Keep storage in sync with the store (debounced; flushed on page hide). Returns the detach function.
 * Timers are only used when a window-like global exists, so tests and workers stay inert.
 */
export function attachPersistence(api: StoreApi<Store>, debounceMs = PERSIST_DEBOUNCE_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    savePersistedUi(persistedSliceOf(api.getState()));
  };
  const unsubscribe = api.subscribe((next, prev) => {
    if (!persistedChanged(next, prev)) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  });
  const onHide = (): void => {
    if (timer !== undefined) flush();
  };
  const target = typeof window !== 'undefined' ? window : undefined;
  target?.addEventListener('pagehide', onHide);
  return () => {
    unsubscribe();
    target?.removeEventListener('pagehide', onHide);
    if (timer !== undefined) flush();
  };
}
