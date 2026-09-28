// W6 fix (review findings #6, #7): the W6 inspector components are reachable from the inspectors, not only from their
// own tests. The NF-WLC-9800's Controller tab renders the controller panel (the device has no shell, so this panel is
// its one configuration surface; §5.5 "Controller panel"). [S14] The port inspector shows the state-machine history of
// the selected port under its switching section, and the Processes tab the device-level machines (§6 "State-machine
// history strip for the selected port/group"). Real worlds, rendered server-side with a plain selector store.
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createSimulation } from '@netforge/engine';
import type { DeviceSnapshot, SimSnapshot, TraceEvent } from '@netforge/engine';

// DeviceInspector imports the desktop tab, whose terminal needs a browser; these tests never open that tab
vi.mock('../src/desktop/DesktopTab', () => ({ DesktopTab: () => null }));
vi.mock('../src/bridge/client', () => ({ engine: {}, fmtSimTime: (t: number) => `${t / 1_000_000_000} s` }));
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = {
    catalog: [], snapshot: null, snapshotIndex: undefined, epoch: 0, events: [], timeline: undefined, select: vi.fn(), toast: vi.fn(), announce: vi.fn(),
  };
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

import { store } from '../src/store/store';
import { DEVICE_FSM_MACHINES, SettingsPanel } from '../src/inspector/DeviceInspector';
import { PortInspector } from '../src/inspector/PortInspector';
import { WLC_PAGE_LABELS, WLC_PAGES } from '../src/inspector/WlcPanel';
import { panelsForTab } from '../src/inspector/tabs';

const S = 1_000_000_000;

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

function deviceOf(snapshot: SimSnapshot, id: string): DeviceSnapshot {
  const d = snapshot.devices.find((x) => x.id === id);
  if (d === undefined) throw new Error(`no device ${id}`);
  return d;
}

describe('the controller panel is mounted on the NF-WLC-9800 Controller tab (finding #6)', () => {
  it('the tab lists the wlc.controller panel and the settings body renders its four pages', () => {
    const sim = createSimulation({ seed: 3, profile: 'P2' });
    sim.addDevice({ id: 'wlc', type: 'wlc.nfwlc9800', name: 'WLC1', position: { x: 0, y: 0 } });
    sim.runFor(30 * S);
    const snapshot = sim.snapshot();
    store.setState({ snapshot, catalog: sim.catalog.list(), events: [] });
    const wlc = deviceOf(snapshot, 'wlc');
    expect(panelsForTab(wlc, 'wireless')).toEqual(['wlc.controller']);
    const html = renderToStaticMarkup(createElement(SettingsPanel, { device: wlc, panel: 'wlc.controller' }));
    const t = text(html);
    expect(html).not.toBe('');
    for (const page of WLC_PAGES) expect(t).toContain(WLC_PAGE_LABELS[page]);
    // the management interface is the first thing a new controller needs: the panel says so in words
    expect(t.toLowerCase()).toContain('management');
  });
});

describe('[S14] the state-machine history strip is mounted (finding #7)', () => {
  function stpWorld(): { snapshot: SimSnapshot; events: TraceEvent[] } {
    const sim = createSimulation({ seed: 21, profile: 'P2' });
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', position: { x: 0, y: 0 } });
    sim.addDevice({ id: 'sw2', type: 'switch.nfc2960', name: 'SW2', position: { x: 200, y: 0 } });
    sim.addLink({ a: { device: 'sw1', port: 'GigabitEthernet0/1' }, b: { device: 'sw2', port: 'GigabitEthernet0/1' } });
    sim.runFor(70 * S);
    const snapshot = sim.snapshot();
    store.setState({ snapshot, catalog: sim.catalog.list(), snapshotIndex: undefined });
    return { snapshot, events: sim.traceQuery({ from: 0, limit: 200_000 }).events.map((e) => e.event) };
  }

  it('the port inspector shows the port\'s transitions under its switching section', () => {
    const { events } = stpWorld();
    store.setState({ events });
    const t = text(renderToStaticMarkup(createElement(PortInspector, { port: { device: 'sw1', port: 'GigabitEthernet0/1' } })));
    expect(t).toContain('Spanning-tree port VLAN0001 GigabitEthernet0/1 Now forwarding');
    expect(t.indexOf('Switching')).toBeGreaterThanOrEqual(0);
    expect(t.indexOf('Switching')).toBeLessThan(t.indexOf('Spanning-tree port VLAN0001'));
  });

  it('a port with no transition in the trace shows no strip at all', () => {
    stpWorld();
    store.setState({ events: [] });
    const html = renderToStaticMarkup(createElement(PortInspector, { port: { device: 'sw1', port: 'GigabitEthernet0/1' } }));
    expect(text(html)).not.toContain('Spanning-tree port VLAN0001');
    expect(html).not.toContain('fsm-strips');
  });

  it('the Processes tab takes the device-level machines only', () => {
    expect([...DEVICE_FSM_MACHINES]).toEqual(['stp-bridge', 'capwap-wtp', 'capwap-ac']);
  });
});
