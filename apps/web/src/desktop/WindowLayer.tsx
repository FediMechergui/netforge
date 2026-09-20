/**
 * Floating, non-modal GUI windows over the canvas (ARCHITECTURE-P1 §7 "Desktop tab"; store `desktopWindows`).
 *
 * The shell mounts `<WindowLayer />` inside the canvas area. Each `DesktopWindow` renders as a dialog
 * (aria-modal false) with a title bar that drags the window, a corner grip that resizes it, and a close button.
 * Dragging writes the element style directly and commits the rectangle to the store once, on release (no
 * per-frame React state). Keyboard: with the title bar focused, arrow keys move the window (Shift + arrows resize
 * it), Escape closes it. Pressing anywhere in a window brings it to the front.
 *
 * Window contents come from a registry keyed by `GuiPanelId`; the four P0.5 Desktop apps are built in and later
 * owners add theirs with `registerDesktopWindowApp`. Windows whose device disappears close themselves.
 */
import { useEffect, useRef, type ComponentType, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { GuiPanelId } from '@netforge/engine';
import { store, useStore } from '../store/store';
import type { DesktopWindow } from '../store/types';
import { GUI_PANEL_VOCAB } from '../vocab/categories.js';
import { CellularApp } from './apps/CellularApp';
import { CommandPromptApp } from './apps/CommandPromptApp';
import { IpConfigApp } from './apps/IpConfigApp';
import { WifiApp } from './apps/WifiApp';
import { deviceById, useDeviceById } from './shared.js';
import type { DesktopAppProps } from './shared.js';
import './desktop.css';

/** Smallest window size (CSS pixels). */
export const WINDOW_MIN = Object.freeze({ w: 260, h: 160 });
/** Pixels an arrow key moves or resizes a window by. */
export const WINDOW_KEY_STEP = 16;
/** Part of a window that must stay inside the layer (so its title bar can always be grabbed). */
export const WINDOW_KEEP_VISIBLE = 48;

/** A window rectangle. */
export interface WindowRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Clamp a window to the layer: at least WINDOW_MIN in size, no larger than the layer, the title bar inside the
 * top edge and at least WINDOW_KEEP_VISIBLE pixels inside the other edges. Values are rounded.
 */
export function clampWindowRect(rect: WindowRect, bounds: { readonly w: number; readonly h: number }): WindowRect {
  const bw = Math.max(0, Math.round(bounds.w));
  const bh = Math.max(0, Math.round(bounds.h));
  const w = Math.round(Math.max(WINDOW_MIN.w, bw > 0 ? Math.min(rect.w, bw) : rect.w));
  const h = Math.round(Math.max(WINDOW_MIN.h, bh > 0 ? Math.min(rect.h, bh) : rect.h));
  const keep = WINDOW_KEEP_VISIBLE;
  const x = bw > 0 ? Math.round(Math.min(Math.max(rect.x, keep - w), bw - keep)) : Math.round(rect.x);
  const y = bh > 0 ? Math.round(Math.min(Math.max(rect.y, 0), bh - keep)) : Math.round(Math.max(0, rect.y));
  return { x, y, w, h };
}

/** Rectangle after a keyboard move (arrows) or resize (Shift + arrows); undefined for other keys. */
export function keyAdjustedRect(rect: WindowRect, key: string, resize: boolean, step: number = WINDOW_KEY_STEP): WindowRect | undefined {
  const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
  const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
  if (dx === 0 && dy === 0) return undefined;
  return resize ? { ...rect, w: rect.w + dx, h: rect.h + dy } : { ...rect, x: rect.x + dx, y: rect.y + dy };
}

/** A window content component. */
export type DesktopWindowApp = ComponentType<DesktopAppProps>;

const APPS = new Map<GuiPanelId, DesktopWindowApp>([
  ['desktop.ip-config', IpConfigApp],
  ['desktop.wifi', WifiApp],
  ['desktop.cellular', CellularApp],
  ['desktop.command-prompt', CommandPromptApp],
]);

/** Register (or replace) the component a window of `app` shows. Later owners use it for their panels. */
export function registerDesktopWindowApp(app: GuiPanelId, component: DesktopWindowApp): void {
  APPS.set(app, component);
}

/** Component registered for `app`, if any. */
export function desktopWindowApp(app: GuiPanelId): DesktopWindowApp | undefined {
  return APPS.get(app);
}

/** Title of a window: `PC1 · IP configuration`. */
export function windowTitle(deviceName: string | undefined, app: GuiPanelId): string {
  const label = GUI_PANEL_VOCAB[app].label;
  return deviceName === undefined ? label : `${deviceName} · ${label}`;
}

function UnknownApp({ deviceId, app }: { deviceId: string; app: GuiPanelId }) {
  const select = useStore((s) => s.select);
  return (
    <div className="desk-app">
      <p className="desk-empty">{GUI_PANEL_VOCAB[app].hint}</p>
      <p className="desk-note">This panel is shown in the inspector.</p>
      <div className="desk-actions">
        <button type="button" className="btn" onClick={() => select({ kind: 'device', id: deviceId })}>
          Show the device in the inspector
        </button>
      </div>
    </div>
  );
}

type DragMode = 'move' | 'resize';

interface DragState {
  mode: DragMode;
  pointer: number;
  startX: number;
  startY: number;
  rect: WindowRect;
  latest: WindowRect;
}

function layerBounds(el: HTMLElement | null): { w: number; h: number } {
  const parent = el?.parentElement;
  return { w: parent?.clientWidth ?? 0, h: parent?.clientHeight ?? 0 };
}

function applyRect(el: HTMLElement | null, r: WindowRect): void {
  if (el === null) return;
  el.style.left = `${r.x}px`;
  el.style.top = `${r.y}px`;
  el.style.width = `${r.w}px`;
  el.style.height = `${r.h}px`;
}

function WindowFrame({ win, top }: { win: DesktopWindow; top: boolean }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  const device = useDeviceById(win.device);
  const focusWindow = useStore((s) => s.focusDesktopWindow);
  const moveWindow = useStore((s) => s.moveDesktopWindow);
  const title = windowTitle(device?.name, win.app);
  const titleId = `desk-win-${win.id}-title`;
  const App = APPS.get(win.app);

  const rect: WindowRect = { x: win.x, y: win.y, w: win.w, h: win.h };

  // Keep the element in step with the store whenever no drag is running.
  useEffect(() => {
    if (drag.current === null) applyRect(frameRef.current, { x: win.x, y: win.y, w: win.w, h: win.h });
  }, [win.x, win.y, win.w, win.h]);

  const bringToFront = (): void => {
    if (!top) focusWindow(win.id);
  };

  const startDrag = (mode: DragMode) => (e: ReactPointerEvent<HTMLElement>): void => {
    if (e.button !== 0) return;
    if (mode === 'move' && e.target instanceof HTMLElement && e.target.closest('button') !== null) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { mode, pointer: e.pointerId, startX: e.clientX, startY: e.clientY, rect, latest: rect };
    bringToFront();
  };

  const onDragMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const d = drag.current;
    if (d === null || d.pointer !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    const next = d.mode === 'move' ? { ...d.rect, x: d.rect.x + dx, y: d.rect.y + dy } : { ...d.rect, w: d.rect.w + dx, h: d.rect.h + dy };
    d.latest = clampWindowRect(next, layerBounds(frameRef.current));
    applyRect(frameRef.current, d.latest);
  };

  const endDrag = (e: ReactPointerEvent<HTMLElement>): void => {
    const d = drag.current;
    if (d === null || d.pointer !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const r = d.latest;
    if (r.x !== win.x || r.y !== win.y || r.w !== win.w || r.h !== win.h) moveWindow(win.id, r);
  };

  const onTitleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeWindowAndRestoreFocus(win.id);
      return;
    }
    const next = keyAdjustedRect(rect, e.key, e.shiftKey);
    if (next === undefined) return;
    e.preventDefault();
    moveWindow(win.id, clampWindowRect(next, layerBounds(frameRef.current)));
  };

  return (
    <div
      ref={frameRef}
      className={`desk-window ${top ? 'is-top' : ''}`}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      style={{ left: win.x, top: win.y, width: win.w, height: win.h, zIndex: win.z }}
      onPointerDownCapture={bringToFront}
      onFocusCapture={bringToFront}
    >
      <div
        className="desk-titlebar"
        data-window-titlebar={win.id}
        tabIndex={0}
        aria-label={`${title}. Arrow keys move the window, Shift and arrow keys resize it, Escape closes it.`}
        onPointerDown={startDrag('move')}
        onPointerMove={onDragMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onTitleKeyDown}
      >
        <span id={titleId} className="desk-title">
          {title}
        </span>
        <button type="button" className="btn btn-ghost btn-icon desk-close" aria-label={`Close ${title}`} title="Close (Escape on the title bar)" onClick={() => closeWindowAndRestoreFocus(win.id)}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <div className="desk-body">
        {App !== undefined ? <App deviceId={win.device} windowId={win.id} /> : <UnknownApp deviceId={win.device} app={win.app} />}
      </div>
      <div
        className="desk-grip"
        aria-hidden="true"
        title="Drag to resize"
        onPointerDown={startDrag('resize')}
        onPointerMove={onDragMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
    </div>
  );
}

/** Move keyboard focus to the title bar of window `id` once it is rendered (no-op without a DOM). */
export function focusWindowElement(id: number): void {
  if (typeof document === 'undefined' || typeof requestAnimationFrame === 'undefined') return;
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(`[data-window-titlebar="${id}"]`)?.focus();
  });
}

/** Element that opened each window (a Desktop-tab launcher), used to return focus when the window closes. */
const WINDOW_OPENERS = new Map<number, HTMLElement>();

/** Value of a launcher's `data-desktop-launcher-for` attribute: `<device id>:<app>`. */
export function desktopLauncherKey(device: string, app: GuiPanelId): string {
  return `${device}:${app}`;
}

/** Record the element that opened window `id`, so focus can go back to it when the window closes. */
export function rememberWindowOpener(id: number, el: Element | null | undefined): void {
  if (el === null || el === undefined || typeof (el as HTMLElement).focus !== 'function') return;
  WINDOW_OPENERS.set(id, el as HTMLElement);
}

/** Opener recorded for window `id`, if any (tests and diagnostics). */
export function windowOpener(id: number): HTMLElement | undefined {
  return WINDOW_OPENERS.get(id);
}

/** Id of the window that should take focus when `closing` closes: the remaining window with the highest z. */
export function nextFocusWindow(windows: readonly Pick<DesktopWindow, 'id' | 'z'>[], closing: number): number | undefined {
  let best: Pick<DesktopWindow, 'id' | 'z'> | undefined;
  for (const w of windows) {
    if (w.id === closing) continue;
    if (best === undefined || w.z > best.z) best = w;
  }
  return best?.id;
}

function focusIfConnected(el: HTMLElement | null | undefined): boolean {
  if (el === null || el === undefined || el.isConnected !== true) return false;
  el.focus();
  return true;
}

/**
 * Close window `id` and keep keyboard focus in a sensible place: the next window in the stack (its title bar),
 * or, when no window remains, `fallback` if it is still in the document, else the launcher that opened the window.
 */
export function closeWindowAndRestoreFocus(id: number, fallback?: HTMLElement | null): void {
  const st = store.getState();
  const next = nextFocusWindow(st.desktopWindows, id);
  const closing = st.desktopWindows.find((w) => w.id === id);
  const opener = WINDOW_OPENERS.get(id);
  WINDOW_OPENERS.delete(id);
  st.closeDesktopWindow(id);
  if (next !== undefined) {
    focusWindowElement(next);
    return;
  }
  if (typeof document === 'undefined' || typeof requestAnimationFrame === 'undefined') return;
  requestAnimationFrame(() => {
    if (focusIfConnected(fallback)) return;
    if (focusIfConnected(opener)) return;
    // The recorded opener may have been re-rendered: look up the live launcher of the window's device and app.
    if (closing !== undefined) document.querySelector<HTMLElement>(`[data-desktop-launcher-for="${desktopLauncherKey(closing.device, closing.app)}"]`)?.focus();
  });
}

/** Ids of windows whose device is no longer in the snapshot. */
export function orphanWindows(windows: readonly Pick<DesktopWindow, 'id' | 'device'>[], hasDevice: (id: string) => boolean): readonly number[] {
  return windows.filter((w) => !hasDevice(w.device)).map((w) => w.id);
}

export function WindowLayer() {
  const windows = useStore((s) => s.desktopWindows);
  const snapshot = useStore((s) => s.snapshot);

  // Close windows of removed devices (after the snapshot that removed them).
  useEffect(() => {
    if (snapshot === null || windows.length === 0) return;
    const st = store.getState();
    for (const id of orphanWindows(windows, (d) => deviceById(snapshot, st.snapshotIndex, d) !== undefined)) st.closeDesktopWindow(id);
  }, [snapshot, windows]);

  if (windows.length === 0) return null;
  let topZ = -Infinity;
  for (const w of windows) if (w.z > topZ) topZ = w.z;
  return (
    <div className="desk-layer">
      {windows.map((w) => (
        <WindowFrame key={w.id} win={w} top={w.z === topZ} />
      ))}
    </div>
  );
}
