// [S2] The `routing` dock tab shown (ARCHITECTURE-P3 §2.14, §6, §9.2 item 36b, §10.2 "dock.routing.test.ts (from W4:
// the routing tab and hotkey 9)"; W4 web-shell): DOCK_STAGE is 'P3', so the registry ships "Link state" as the ninth
// tab with the digit hotkey 9; app/Dock.tsx maps it to the W3 routing/LinkStatePanel as a lazy chunk inside a Suspense
// boundary; and the canvas `spf` layer follows the SPF stepper only while that panel is on screen (`dockPaneShown`
// feeds `OverlaySyncInput.routing.shown`: the dock's tab, the dock not collapsed).
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const dockState = vi.hoisted(() => ({
  dockTab: 'routing' as string,
  dockHeight: 260,
  setDockTab: (_t: string) => {},
  setDockHeight: (_h: number) => {},
  terminals: [] as unknown[],
  events: [] as unknown[],
  droppedEvents: 0,
  eventsTruncated: 0,
  snapshot: null,
  routingUi: { device: null, area: null, lsa: null, spf: { step: 0, playing: false } },
}));

vi.mock('../src/bridge/client', () => ({ engine: {}, fmtSimTime: (t: number) => String(t) }));
vi.mock('../src/store/store', () => {
  const useStore = Object.assign((selector: (s: typeof dockState) => unknown) => selector(dockState), {
    getState: () => dockState,
    setState: (patch: Partial<typeof dockState>) => Object.assign(dockState, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});
// the other panels are not under test here (the terminal needs a browser)
vi.mock('../src/terminal/TerminalPanel', () => ({ TerminalPanel: () => createElement('p', null, 'terminal panel') }));
vi.mock('../src/netscope/NetScope', () => ({ NetScope: () => createElement('p', null, 'netscope panel') }));
vi.mock('../src/simmode/SimEventsPanel', () => ({ SimEventsPanel: () => createElement('p', null, 'sim events panel') }));
vi.mock('../src/labs/LabPanel', () => ({ LabPanel: () => createElement('p', null, 'lab panel') }));
vi.mock('../src/inspector/DockPanels', () => ({
  EventsPanel: () => createElement('p', null, 'events panel'),
  PacketsPanel: () => createElement('p', null, 'packets panel'),
  ProvenancePanel: () => createElement('p', null, 'provenance panel'),
  TablesPanel: () => createElement('p', null, 'tables panel'),
}));
vi.mock('../src/app/ResizeHandle', () => ({ ResizeHandle: () => null }));

import { SPF_OVERLAY, TOPO_OVERLAY_DEFAULTS, type OverlayRoutingInput } from '../src/canvas/overlays/registry';
import {
  DOCK_COLLAPSED_HEIGHT,
  DOCK_MIN_HEIGHT,
  DOCK_OPEN_HEIGHT,
  DOCK_STAGE,
  DOCK_TABS,
  buildDockTabs,
  dockHotkeyRange,
  dockPaneShown,
  dockTabDef,
  dockTabForHotkey,
  isDockTabAvailable,
} from '../src/dock/registry';
import { DOCK_PANELS, DOCK_PANE_LOADING, Dock, loadLinkStatePanel } from '../src/app/Dock';
import type { RoutingUiState } from '../src/store/types';
import { AREA0, T0, world } from './routing-fixtures';

const LAZY = Symbol.for('react.lazy');

describe('the routing tab in the registry', () => {
  it('is the ninth tab of this build, "Link state", on the digit hotkey 9', () => {
    expect(DOCK_STAGE).toBe('P3');
    const last = DOCK_TABS[DOCK_TABS.length - 1];
    expect(DOCK_TABS).toHaveLength(9);
    expect(last).toMatchObject({ id: 'routing', label: 'Link state', hotkey: '9', keepMounted: false, stage: 'P3' });
    expect(dockTabForHotkey('9')).toBe('routing');
    expect(dockTabDef('routing')?.description).toBe('Link-state databases and shortest-path trees of OSPF routers.');
    expect(isDockTabAvailable('routing')).toBe(true);
    expect(dockHotkeyRange()).toBe('1 – 9');
  });

  it('stays hidden in a build of an earlier stage, and every earlier tab keeps its hotkey', () => {
    expect(buildDockTabs('P1').map((t) => t.id)).not.toContain('routing');
    expect(buildDockTabs('P1').map((t) => t.hotkey)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    const p3 = buildDockTabs('P3');
    expect(p3.slice(0, 8).map((t) => [t.id, t.hotkey])).toEqual(buildDockTabs('P1').map((t) => [t.id, t.hotkey]));
  });
});

describe('when the routing panel is on screen', () => {
  it('only while it is the dock tab and the dock is open', () => {
    expect(dockPaneShown('routing', { dockTab: 'routing', dockHeight: DOCK_OPEN_HEIGHT })).toBe(true);
    expect(dockPaneShown('routing', { dockTab: 'routing', dockHeight: DOCK_MIN_HEIGHT + 1 })).toBe(true);
    // collapsed to its strip, or fully: the pane is hidden
    expect(dockPaneShown('routing', { dockTab: 'routing', dockHeight: DOCK_MIN_HEIGHT })).toBe(false);
    expect(dockPaneShown('routing', { dockTab: 'routing', dockHeight: DOCK_COLLAPSED_HEIGHT })).toBe(false);
    // another tab is the dock's
    expect(dockPaneShown('routing', { dockTab: 'netscope', dockHeight: DOCK_OPEN_HEIGHT })).toBe(false);
    expect(dockPaneShown('netscope', { dockTab: 'netscope', dockHeight: DOCK_OPEN_HEIGHT })).toBe(true);
  });

  it('drives the spf layer: a frame only while the link-state browser is visible', () => {
    const snap = world();
    const ui: RoutingUiState = { device: 'r1', area: AREA0, lsa: null, spf: { step: 1, playing: false } };
    const input = (state: { dockTab: 'routing' | 'labs'; dockHeight: number }) => {
      const routing: OverlayRoutingInput = { ui, shown: dockPaneShown('routing', state) };
      return SPF_OVERLAY.sync({ state: TOPO_OVERLAY_DEFAULTS, snapshot: snap, now: T0 + 5_000_000_000, routing });
    };
    expect(input({ dockTab: 'labs', dockHeight: DOCK_OPEN_HEIGHT })).toBeNull();
    expect(input({ dockTab: 'routing', dockHeight: DOCK_COLLAPSED_HEIGHT })).toBeNull();
    expect(input({ dockTab: 'routing', dockHeight: DOCK_OPEN_HEIGHT })).not.toBeNull();
  });
});

describe('app/Dock.tsx maps the routing tab to the link-state browser', () => {
  it('as a lazy chunk whose module default-exports routing/LinkStatePanel', async () => {
    const panel = DOCK_PANELS.routing as unknown as { $$typeof: symbol };
    expect(panel.$$typeof).toBe(LAZY);
    const mod = await loadLinkStatePanel();
    expect(mod.default).toBe(mod.LinkStatePanel);
    expect(typeof mod.default).toBe('function');
  });

  it('every tab of the build has a panel, and the strip lists "Link state" with its hotkey', () => {
    for (const t of DOCK_TABS) expect(DOCK_PANELS[t.id], t.id).toBeDefined();
    dockState.dockTab = 'labs';
    const html = renderToStaticMarkup(createElement(Dock));
    expect(html).toContain('id="dock-tab-routing"');
    expect(html).toContain('title="Link state (9): Link-state databases and shortest-path trees of OSPF routers."');
    // not the active tab, and not kept mounted: no routing pane
    expect(html).not.toContain('id="dock-pane-routing"');
  });

  it('opens the routing pane inside a Suspense boundary (the loading line until the chunk arrives)', () => {
    dockState.dockTab = 'routing';
    const html = renderToStaticMarkup(createElement(Dock));
    expect(html).toMatch(/id="dock-tab-routing"[^>]*aria-selected="true"/);
    expect(html).toContain('id="dock-pane-routing"');
    expect(html).toContain(DOCK_PANE_LOADING);
    expect(html).not.toContain('not available in this build');
  });
});
