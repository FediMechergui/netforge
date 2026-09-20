// Regression: holding Space (OS auto-repeat) or using Space+drag pan must not
// flip play/pause repeatedly. jsdom is not a dependency of this repo, so the few
// DOM globals hotkeys.ts touches are stubbed here.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const togglePlay = vi.fn(async () => {});
const hkState = vi.hoisted(() => ({
  ready: true,
  selection: null,
  dockHeight: 0,
  setDockTab: (_t: string) => {},
  setDockHeight: (_h: number) => {},
}));

vi.mock('react', () => ({ useEffect: () => {} }));
vi.mock('../src/bridge/client', () => ({ engine: {} }));
vi.mock('../src/store/store', () => ({ store: { getState: () => hkState } }));
vi.mock('../src/app/FileMenu', () => ({ requestOpenFile: vi.fn(), saveNetforge: vi.fn() }));
vi.mock('../src/app/PlaybackControls', () => ({
  reportError: vi.fn(),
  stepEvent: vi.fn(),
  togglePlay,
}));

class FakeElement {
  isContentEditable = false;
  constructor(
    public tagName: string,
    public parent: FakeElement | null = null,
  ) {}
  closest(sel: string): FakeElement | null {
    const cls = sel.startsWith('.') ? sel.slice(1) : sel;
    for (let el: FakeElement | null = this; el; el = el.parent) if (el.tagName === cls) return el;
    return null;
  }
}

let hk: typeof import('../src/app/hotkeys');

beforeAll(async () => {
  (globalThis as Record<string, unknown>).HTMLElement = FakeElement;
  hk = await import('../src/app/hotkeys');
});

interface KeyInit {
  key: string;
  repeat?: boolean;
  target?: unknown;
}

function key(init: KeyInit): KeyboardEvent {
  return {
    key: init.key,
    repeat: init.repeat ?? false,
    target: init.target ?? new FakeElement('CANVAS'),
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    defaultPrevented: false,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
}

describe('Space hotkey', () => {
  beforeEach(() => {
    togglePlay.mockClear();
  });

  it('toggles exactly once on release despite auto-repeat keydowns', () => {
    const first = key({ key: ' ' });
    hk.handleHotkey(first);
    expect(first.preventDefault).toHaveBeenCalled();
    for (let i = 0; i < 20; i++) hk.handleHotkey(key({ key: ' ', repeat: true }));
    expect(togglePlay).not.toHaveBeenCalled();
    hk.handleHotkeyUp(key({ key: ' ' }));
    expect(togglePlay).toHaveBeenCalledTimes(1);
  });

  it('does not toggle when the press was used for a Space+drag pan', () => {
    hk.handleHotkey(key({ key: ' ' }));
    hk.markSpacePan();
    hk.handleHotkeyUp(key({ key: ' ' }));
    expect(togglePlay).not.toHaveBeenCalled();

    // the pan flag is consumed: the next plain press toggles again
    hk.handleHotkey(key({ key: ' ' }));
    hk.handleHotkeyUp(key({ key: ' ' }));
    expect(togglePlay).toHaveBeenCalledTimes(1);
  });

  it('ignores Space typed into an input', () => {
    const input = new FakeElement('INPUT');
    const down = key({ key: ' ', target: input });
    hk.handleHotkey(down);
    expect(down.preventDefault).not.toHaveBeenCalled();
    hk.handleHotkeyUp(key({ key: ' ', target: input }));
    expect(togglePlay).not.toHaveBeenCalled();
  });
});

describe('dock tab hotkeys follow the registry', () => {
  it('digits select the registered tabs in order and open a collapsed dock', async () => {
    const { DOCK_TABS, DOCK_MIN_HEIGHT } = await import('../src/dock/registry');
    const tabs: string[] = [];
    const heights: number[] = [];
    hkState.setDockTab = (t) => tabs.push(t);
    hkState.setDockHeight = (h) => heights.push(h);
    hkState.dockHeight = 0;
    for (const t of DOCK_TABS) {
      const e = key({ key: t.hotkey ?? '' });
      hk.handleHotkey(e);
      expect(e.preventDefault).toHaveBeenCalled();
    }
    expect(tabs).toEqual(DOCK_TABS.map((t) => t.id));
    expect(heights.every((h) => h > DOCK_MIN_HEIGHT)).toBe(true);

    tabs.length = 0;
    hk.handleHotkey(key({ key: String(DOCK_TABS.length + 1) }));
    hk.handleHotkey(key({ key: '0' }));
    hk.handleHotkey(key({ key: '1', target: new FakeElement('INPUT') }));
    expect(tabs).toEqual([]);
  });

  it('the Help table lists the dock range and every tool key', () => {
    const keys = hk.HOTKEYS.map((h) => h.keys);
    expect(keys).toEqual(expect.arrayContaining(['Space', '.', 'V', 'C', 'Esc', 'Del', 'Ctrl+S', 'Ctrl+O']));
    const dock = hk.HOTKEYS.find((h) => h.action.startsWith('dock tabs'));
    // P1 W7: the dock ships eight tabs (NetScope, Sim events and Labs joined the five P0 ones).
    expect(dock?.keys).toBe('1 – 8');
    expect(dock?.action).toContain('Terminal');
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('dock registry', () => {
  it('ships the tabs of this build and hides later stages', async () => {
    const r = await import('../src/dock/registry');
    // P1 W7: this build ships the P1 panels, so all eight tabs are available and numbered.
    expect(r.DOCK_STAGE).toBe('P1');
    expect(r.DOCK_TABS.map((t) => t.id)).toEqual(['terminal', 'packets', 'events', 'tables', 'provenance', 'netscope', 'sim-events', 'labs']);
    expect(r.DOCK_TABS.map((t) => t.hotkey)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(r.dockTabForHotkey('3')).toBe('events');
    expect(r.dockTabForHotkey('9')).toBeUndefined();
    expect(r.buildDockTabs('P0.5').some((t) => t.id === 'netscope')).toBe(false);
    expect(r.isDockTabAvailable('netscope')).toBe(true);
    expect(r.isDockTabAvailable('tables')).toBe(true);
    expect(r.dockTabDef('terminal')?.keepMounted).toBe(true);
    expect(Object.isFrozen(r.DOCK_TABS)).toBe(true);
  });

  it('numbers every tab of a later stage in registry order', async () => {
    const r = await import('../src/dock/registry');
    const p1 = r.buildDockTabs('P1');
    expect(p1.map((t) => t.id)).toEqual(['terminal', 'packets', 'events', 'tables', 'provenance', 'netscope', 'sim-events', 'labs']);
    expect(p1.map((t) => t.hotkey)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(r.buildDockTabs('P0')).toHaveLength(5);
    expect(new Set(p1.map((t) => t.label)).size).toBe(p1.length);
  });
});
