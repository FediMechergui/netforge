/**
 * Global keyboard shortcuts. Ignored while typing in inputs, selects,
 * contenteditable regions or the terminal (xterm owns its keys).
 *
 *   Space      play / pause (on release; not if used for Space+drag pan)
 *   .          step one event
 *   Delete     remove selection      Escape     select tool, clear cabling / selection
 *   Ctrl+S     save .netforge        Ctrl+O     open a file
 *   V / C      select / cable tool   1-9        dock tabs (from the dock registry)
 *
 * `HOTKEYS` lists the same bindings as data for the Help menu, so the list and the handler cannot drift.
 */
import { useEffect } from 'react';
import { engine } from '../bridge/client';
import { DOCK_MIN_HEIGHT, DOCK_OPEN_HEIGHT, DOCK_TABS, dockHotkeyRange, dockTabForHotkey } from '../dock/registry';
import { store } from '../store/store';
import { requestOpenFile, saveNetforge } from './FileMenu';
import { reportError, stepEvent, togglePlay } from './PlaybackControls';

export interface HotkeyHelp {
  readonly keys: string;
  readonly action: string;
}

/** Every global binding, in Help menu order. */
export const HOTKEYS: readonly HotkeyHelp[] = Object.freeze([
  { keys: 'Space', action: 'play / pause' },
  { keys: '.', action: 'step one event' },
  { keys: 'V', action: 'select tool' },
  { keys: 'C', action: 'cable tool' },
  { keys: 'Esc', action: 'cancel cabling / back to select' },
  { keys: 'Del', action: 'remove the selected device or link' },
  ...(DOCK_TABS.some((t) => t.hotkey !== undefined) ? [{ keys: dockHotkeyRange(), action: `dock tabs (${DOCK_TABS.filter((t) => t.hotkey !== undefined).map((t) => t.label).join(', ')})` }] : []),
  { keys: 'Ctrl+S', action: 'save .netforge' },
  { keys: 'Ctrl+O', action: 'open a project' },
]);

/** Set when the current Space press started a canvas pan; consumed on Space keyup. */
let spaceUsedForPan = false;

/** Called by the canvas when a Space+drag pan begins, so releasing Space does not toggle play. */
export function markSpacePan(): void {
  spaceUsedForPan = true;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return true;
  return target.closest('.xterm') !== null;
}

/** Remove whatever is selected (device or link). Ports and packets cannot be deleted. */
export async function deleteSelection(): Promise<void> {
  const { selection, ready } = store.getState();
  if (!ready || !selection) return;
  try {
    if (selection.kind === 'device') {
      await engine.removeDevice(selection.id);
      store.getState().select(null);
    } else if (selection.kind === 'link') {
      await engine.removeLink(selection.id);
      store.getState().select(null);
    }
  } catch (err) {
    reportError(err);
  }
}

export function handleHotkey(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.isComposing) return;
  const s = store.getState();
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && !e.altKey && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    void saveNetforge();
    return;
  }
  if (ctrl && !e.altKey && (e.key === 'o' || e.key === 'O')) {
    e.preventDefault();
    requestOpenFile();
    return;
  }

  if (isTypingTarget(e.target)) return;
  if (ctrl || e.altKey) return;

  switch (e.key) {
    case ' ':
      // Only suppress page scroll here. The toggle happens on keyup so that OS
      // auto-repeat while holding Space (e.g. for Space+drag pan) cannot flip
      // play/pause dozens of times.
      e.preventDefault();
      if (!e.repeat) spaceUsedForPan = false;
      return;
    case '.':
      e.preventDefault();
      void stepEvent();
      return;
    case 'Delete':
    case 'Backspace':
      if (s.selection && (s.selection.kind === 'device' || s.selection.kind === 'link')) {
        e.preventDefault();
        void deleteSelection();
      }
      return;
    case 'Escape':
      if (s.pendingCable) s.setPendingCable(null);
      else if (s.tool !== 'select') s.setTool('select');
      else if (s.selection) s.select(null);
      return;
    case 'v':
    case 'V':
      s.setTool('select');
      return;
    case 'c':
    case 'C':
      s.setTool('cable');
      return;
    default:
      break;
  }
  const tab = dockTabForHotkey(e.key);
  if (tab !== undefined) {
    e.preventDefault();
    s.setDockTab(tab);
    if (s.dockHeight <= DOCK_MIN_HEIGHT) s.setDockHeight(DOCK_OPEN_HEIGHT);
  }
}

/** Space released: toggle play/pause unless the press was used for a Space+drag pan. */
export function handleHotkeyUp(e: KeyboardEvent): void {
  if (e.key !== ' ') return;
  if (isTypingTarget(e.target)) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const panned = spaceUsedForPan;
  spaceUsedForPan = false;
  if (!panned) void togglePlay();
}

/** Install the global key listeners for the lifetime of the component. */
export function useHotkeys(): void {
  useEffect(() => {
    window.addEventListener('keydown', handleHotkey);
    window.addEventListener('keyup', handleHotkeyUp);
    return () => {
      window.removeEventListener('keydown', handleHotkey);
      window.removeEventListener('keyup', handleHotkeyUp);
    };
  }, []);
}
