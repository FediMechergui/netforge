// Review fix (web-desktop): closing a desktop window must not drop keyboard focus on <body>. Focus goes to the next
// window in the stack, or, when none remains, back to the Desktop-tab launcher that opened the window.
// No DOM library is installed, so `document` and `requestAnimationFrame` are small stubs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/bridge/client', () => ({ engine: {} }));
vi.mock('../src/terminal/TerminalTab', () => ({ TerminalTab: () => null }));
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = {};
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useStore } from '../src/store/store';
import type { DesktopWindow } from '../src/store/types';
import {
  closeWindowAndRestoreFocus,
  desktopLauncherKey,
  nextFocusWindow,
  rememberWindowOpener,
  windowOpener,
} from '../src/desktop/WindowLayer';

interface FakeEl {
  isConnected: boolean;
  focus: () => void;
}

let active: FakeEl | 'body' = 'body';
let frames: (() => void)[] = [];
let dom: Map<string, FakeEl>;

function el(connected = true): FakeEl {
  const e: FakeEl = { isConnected: connected, focus: () => (active = e) };
  return e;
}

function flushFrames(): void {
  const run = frames;
  frames = [];
  for (const f of run) f();
}

function win(id: number, z: number, app: DesktopWindow['app'] = 'desktop.ip-config'): DesktopWindow {
  return { id, device: 'pc1', app, x: 0, y: 0, w: 300, h: 200, z } as DesktopWindow;
}

function setWindows(windows: DesktopWindow[]): void {
  (useStore as unknown as { setState: (p: Record<string, unknown>) => void }).setState({
    desktopWindows: windows,
    closeDesktopWindow: (id: number) => {
      const st = (useStore as unknown as { getState: () => { desktopWindows: DesktopWindow[] } }).getState();
      setWindows(st.desktopWindows.filter((w) => w.id !== id));
      // Closing unmounts the window: its title bar leaves the document and focus falls back to <body>.
      const bar = dom.get(`[data-window-titlebar="${id}"]`);
      if (bar !== undefined) {
        bar.isConnected = false;
        dom.delete(`[data-window-titlebar="${id}"]`);
        if (active === bar) active = 'body';
      }
    },
  });
}

beforeEach(() => {
  active = 'body';
  frames = [];
  dom = new Map();
  vi.stubGlobal('requestAnimationFrame', (f: () => void) => {
    frames.push(f);
    return frames.length;
  });
  vi.stubGlobal('document', { querySelector: (sel: string) => dom.get(sel) ?? null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('nextFocusWindow', () => {
  it('picks the remaining window with the highest z', () => {
    expect(nextFocusWindow([{ id: 1, z: 1 }, { id: 2, z: 3 }, { id: 3, z: 2 }], 2)).toBe(3);
  });
  it('returns undefined when the closing window is the only one', () => {
    expect(nextFocusWindow([{ id: 7, z: 1 }], 7)).toBeUndefined();
    expect(nextFocusWindow([], 7)).toBeUndefined();
  });
});

describe('closeWindowAndRestoreFocus', () => {
  it('moves focus to the title bar of the next window in the stack (Escape / close button)', () => {
    const bar1 = el();
    const bar2 = el();
    dom.set('[data-window-titlebar="1"]', bar1);
    dom.set('[data-window-titlebar="2"]', bar2);
    setWindows([win(1, 1), win(2, 2, 'desktop.wifi')]);
    bar2.focus();
    closeWindowAndRestoreFocus(2);
    expect(active).toBe('body'); // the unmount dropped focus...
    flushFrames();
    expect(active).toBe(bar1); // ...and it comes back to the other window, not <body>
  });

  it('returns focus to the launcher that opened the last window, and forgets the opener', () => {
    const bar = el();
    const launcher = el();
    dom.set('[data-window-titlebar="5"]', bar);
    setWindows([win(5, 1)]);
    rememberWindowOpener(5, launcher as unknown as HTMLElement);
    bar.focus();
    closeWindowAndRestoreFocus(5);
    flushFrames();
    expect(active).toBe(launcher);
    expect(windowOpener(5)).toBeUndefined();
  });

  it('prefers a connected fallback, and skips a disconnected one', () => {
    const fallback = el();
    const opener = el();
    setWindows([win(8, 1)]);
    rememberWindowOpener(8, opener as unknown as HTMLElement);
    closeWindowAndRestoreFocus(8, fallback as unknown as HTMLElement);
    flushFrames();
    expect(active).toBe(fallback);

    setWindows([win(9, 1)]);
    rememberWindowOpener(9, opener as unknown as HTMLElement);
    closeWindowAndRestoreFocus(9, el(false) as unknown as HTMLElement);
    flushFrames();
    expect(active).toBe(opener);
  });

  it('falls back to the live launcher of the window device and app when the opener is gone', () => {
    const live = el();
    dom.set(`[data-desktop-launcher-for="${desktopLauncherKey('pc1', 'desktop.wifi')}"]`, live);
    setWindows([win(11, 1, 'desktop.wifi')]);
    rememberWindowOpener(11, el(false) as unknown as HTMLElement);
    closeWindowAndRestoreFocus(11);
    flushFrames();
    expect(active).toBe(live);
  });
});

describe('DesktopTab launchers', () => {
  it('tag each launcher with its device and app so focus can find it again', async () => {
    const { DesktopTab } = await import('../src/desktop/DesktopTab');
    (useStore as unknown as { setState: (p: Record<string, unknown>) => void }).setState({
      desktopWindows: [],
      openDesktopWindow: () => 1,
      focusDesktopWindow: () => undefined,
      announce: () => undefined,
    });
    const device = { id: 'pc1', name: 'PC1', gui: ['desktop.ip-config'] } as unknown as Parameters<typeof DesktopTab>[0]['device'];
    const html = renderToStaticMarkup(createElement(DesktopTab, { device }));
    expect(html).toContain(`data-desktop-launcher-for="${desktopLauncherKey('pc1', 'desktop.ip-config')}"`);
  });
});
