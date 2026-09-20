/**
 * Inspector "Desktop" tab of an end device (ARCHITECTURE-P1 §7 "Desktop tab", D2). Shows the device's desktop
 * apps (the `desktop.*` entries of `DeviceSnapshot.gui`, in GUI_PANELS order) as a grid of launchers. A launcher
 * opens the app in a floating, non-modal window over the canvas (`openDesktopWindow`; `WindowLayer` renders it),
 * so the canvas and the inspector stay usable while the window is open. The tab also lists the device's open
 * windows so they can be brought forward or closed from the keyboard.
 *
 * Keyboard: the launcher grid is one tab stop; arrow keys, Home and End move between launchers; Enter or Space
 * opens one. Nothing here branches on device kind: the app list is data. Wording and glyphs are original (§1.6).
 */
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { GUI_PANELS } from '@netforge/engine';
import type { DeviceSnapshot, GuiPanelId } from '@netforge/engine';
import { useStore } from '../store/store';
import type { DesktopWindow } from '../store/types';
import { GUI_PANEL_VOCAB } from '../vocab/categories.js';
import { closeWindowAndRestoreFocus, desktopLauncherKey, desktopWindowApp, focusWindowElement, registerDesktopWindowApp, rememberWindowOpener, windowTitle } from './WindowLayer';
import { BrowserApp } from './apps/BrowserApp';
import { deviceBusyReason } from './shared.js';
import './desktop.css';

// P1 W7: the web browser is registered from here, the module that owns the launchers, so a window can only be
// opened for an app this build can actually show (`desktopAppAvailability`).
registerDesktopWindowApp('desktop.web-browser', BrowserApp);

/** Launchers per row in the grid (arrow-key geometry; the CSS grid uses the same count). */
export const DESKTOP_GRID_COLUMNS = 3;

/** Desktop apps of a device: `gui` entries placed on the desktop, in GUI_PANELS order, without duplicates. */
export function desktopAppsFor(device: Pick<DeviceSnapshot, 'gui'>): readonly GuiPanelId[] {
  const listed = new Set(device.gui ?? []);
  return Object.freeze(GUI_PANELS.filter((id) => listed.has(id) && GUI_PANEL_VOCAB[id].placement === 'desktop-app'));
}

/** Whether this build can show an app in a window, with the reason when it cannot. */
export function desktopAppAvailability(app: GuiPanelId): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (desktopWindowApp(app) !== undefined) return { ok: true };
  return { ok: false, reason: `${GUI_PANEL_VOCAB[app].label} is not part of this release yet.` };
}

/** Grid keys the launcher grid handles. */
export type DesktopGridKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

/** True for keys handled by `moveGridFocus`. */
export function isDesktopGridKey(key: string): key is DesktopGridKey {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown' || key === 'Home' || key === 'End';
}

/**
 * Next focused launcher index in a grid of `count` items laid out `columns` per row. Movement clamps at the
 * edges (no wrap); a vertical move that would leave the grid stays put. Returns `index` for an empty grid.
 */
export function moveGridFocus(index: number, key: DesktopGridKey, count: number, columns: number = DESKTOP_GRID_COLUMNS): number {
  if (count <= 0) return index;
  const last = count - 1;
  const at = Math.min(last, Math.max(0, index));
  const cols = Math.max(1, Math.floor(columns));
  switch (key) {
    case 'Home':
      return 0;
    case 'End':
      return last;
    case 'ArrowLeft':
      return Math.max(0, at - 1);
    case 'ArrowRight':
      return Math.min(last, at + 1);
    case 'ArrowUp':
      return at - cols >= 0 ? at - cols : at;
    case 'ArrowDown':
      return at + cols <= last ? at + cols : at;
  }
}

/** Windows of `device`, front-most first. */
export function windowsOfDevice(windows: readonly DesktopWindow[], device: string): readonly DesktopWindow[] {
  return windows.filter((w) => w.device === device).sort((a, b) => b.z - a.z);
}

const GLYPH_PROPS = { viewBox: '0 0 32 32', width: 32, height: 32, 'aria-hidden': true } as const;

/** Launcher artwork of an app (decorative; the label names the app). */
export function DesktopAppGlyph({ app }: { app: GuiPanelId }): ReactNode {
  switch (app) {
    case 'desktop.ip-config':
      return (
        <svg {...GLYPH_PROPS} className="desk-glyph">
          <rect x="4" y="6" width="24" height="16" rx="2" />
          <line x1="12" y1="26" x2="20" y2="26" />
          <line x1="16" y1="22" x2="16" y2="26" />
          <line x1="8" y1="11" x2="18" y2="11" />
          <line x1="8" y1="15" x2="22" y2="15" />
          <line x1="8" y1="19" x2="14" y2="19" />
        </svg>
      );
    case 'desktop.wifi':
      return (
        <svg {...GLYPH_PROPS} className="desk-glyph">
          <path d="M4 13 Q16 3 28 13" />
          <path d="M8 17 Q16 10 24 17" />
          <path d="M12 21 Q16 17.5 20 21" />
          <circle cx="16" cy="25" r="2" className="is-filled" />
        </svg>
      );
    case 'desktop.cellular':
      return (
        <svg {...GLYPH_PROPS} className="desk-glyph">
          <rect x="5" y="21" width="4" height="6" className="is-filled" />
          <rect x="11" y="16" width="4" height="11" className="is-filled" />
          <rect x="17" y="11" width="4" height="16" />
          <rect x="23" y="5" width="4" height="22" />
        </svg>
      );
    case 'desktop.command-prompt':
      return (
        <svg {...GLYPH_PROPS} className="desk-glyph">
          <rect x="3" y="5" width="26" height="22" rx="2" />
          <path d="M8 12 L13 16 L8 20" />
          <line x1="15" y1="21" x2="23" y2="21" />
        </svg>
      );
    case 'desktop.web-browser':
      return (
        <svg {...GLYPH_PROPS} className="desk-glyph">
          <circle cx="16" cy="16" r="11" />
          <ellipse cx="16" cy="16" rx="5" ry="11" />
          <line x1="5" y1="16" x2="27" y2="16" />
        </svg>
      );
    default:
      return (
        <svg {...GLYPH_PROPS} className="desk-glyph">
          <rect x="6" y="6" width="20" height="20" rx="3" />
        </svg>
      );
  }
}

export interface DesktopTabProps {
  device: DeviceSnapshot;
}

export function DesktopTab({ device }: DesktopTabProps) {
  const apps = desktopAppsFor(device);
  const allWindows = useStore((s) => s.desktopWindows);
  const openDesktopWindow = useStore((s) => s.openDesktopWindow);
  const focusDesktopWindow = useStore((s) => s.focusDesktopWindow);
  const announce = useStore((s) => s.announce);
  const gridRef = useRef<HTMLDivElement>(null);
  const [focusIndex, setFocusIndex] = useState(0);

  const windows = windowsOfDevice(allWindows, device.id);
  const busy = deviceBusyReason(device);
  const tabIndexAt = Math.min(Math.max(0, focusIndex), Math.max(0, apps.length - 1));

  const launch = (app: GuiPanelId, opener: HTMLElement | null): void => {
    const availability = desktopAppAvailability(app);
    if (!availability.ok) {
      announce(availability.reason);
      return;
    }
    const id = openDesktopWindow(device.id, app);
    rememberWindowOpener(id, opener);
    focusWindowElement(id);
    announce(`${windowTitle(device.name, app)} opened in a window over the canvas.`);
  };

  // Launcher that focus returns to when a window is closed from the "Open windows" list.
  const launcherFor = (w: DesktopWindow): HTMLElement | null =>
    gridRef.current?.querySelector<HTMLElement>(`button[data-desktop-launcher-for="${desktopLauncherKey(w.device, w.app)}"]`) ??
    gridRef.current?.querySelector<HTMLElement>('button[data-app]') ??
    null;

  const onGridKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!isDesktopGridKey(e.key)) return;
    const buttons = Array.from(gridRef.current?.querySelectorAll<HTMLButtonElement>('button[data-app]') ?? []);
    const at = buttons.findIndex((b) => b === e.target);
    if (at < 0) return;
    e.preventDefault();
    const next = moveGridFocus(at, e.key, buttons.length);
    setFocusIndex(next);
    buttons[next]?.focus();
  };

  if (apps.length === 0) {
    return (
      <div className="desk-tab">
        <p className="desk-empty">This device has no desktop apps.</p>
      </div>
    );
  }

  return (
    <div className="desk-tab">
      <p className="desk-note">Apps open in windows over the canvas. You can keep working on the canvas while they are open.</p>
      {busy !== undefined && (
        <p className="desk-note" role="status">
          <span aria-hidden="true">⊘ </span>
          {busy}
        </p>
      )}
      <div ref={gridRef} className="desk-launchers" role="group" aria-label={`Desktop apps of ${device.name}`} onKeyDown={onGridKeyDown}>
        {apps.map((app, i) => {
          const v = GUI_PANEL_VOCAB[app];
          const availability = desktopAppAvailability(app);
          const open = windows.some((w) => w.app === app);
          const hintId = `desk-hint-${device.id}-${app}`;
          return (
            <button
              key={app}
              type="button"
              data-app={app}
              data-desktop-launcher-for={desktopLauncherKey(device.id, app)}
              className={`desk-launcher ${open ? 'is-open' : ''}`}
              tabIndex={i === tabIndexAt ? 0 : -1}
              aria-disabled={!availability.ok}
              aria-describedby={hintId}
              title={availability.ok ? v.hint : availability.reason}
              onFocus={() => setFocusIndex(i)}
              onClick={(e) => launch(app, e.currentTarget)}
            >
              <DesktopAppGlyph app={app} />
              <span className="desk-launcher-label">{v.label}</span>
              <span id={hintId} className="desk-launcher-hint">
                {availability.ok ? v.hint : availability.reason}
              </span>
              {open && (
                <span className="desk-tag">
                  <span aria-hidden="true">▣ </span>open
                </span>
              )}
            </button>
          );
        })}
      </div>

      {windows.length > 0 && (
        <section className="desk-open" aria-label="Open windows">
          <h3 className="desk-heading">Open windows</h3>
          <ul className="desk-list">
            {windows.map((w) => {
              const title = windowTitle(device.name, w.app);
              return (
                <li key={w.id} className="desk-open-row">
                  <span className="desk-open-title">{title}</span>
                  <button type="button" className="btn" onClick={() => {
                      focusDesktopWindow(w.id);
                      focusWindowElement(w.id);
                    }} aria-label={`Bring ${title} to the front`}>
                    Show
                  </button>
                  <button type="button" className="btn" onClick={() => closeWindowAndRestoreFocus(w.id, launcherFor(w))} aria-label={`Close ${title}`}>
                    Close
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
