// Desktop tab, floating windows and desktop apps (ARCHITECTURE-P1 §7 "Desktop tab", D9, §3.6, §3.8, §8.1 W6
// web-inspector, §10.1 manual smoke "the Desktop IP config app works"): pure helpers, configure round trips with a
// mocked engine (the lines are also run through the real device grammar), and server-rendered smoke tests.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RF, SEC, cellularPhones, createSimulation, homeWifi } from '@netforge/engine';
import type { ConfigureOptions, ConfigureResult, DeviceSnapshot, SimSnapshot } from '@netforge/engine';

const api = vi.hoisted(() => ({
  configure: vi.fn(),
  hostRequest: vi.fn(),
  cliCanOpen: vi.fn(),
  cliOpen: vi.fn(),
  cliClose: vi.fn(),
}));
vi.mock('../src/bridge/client', () => ({ engine: api }));
vi.mock('../src/terminal/TerminalTab', () => ({
  TerminalTab: ({ tab }: { tab: { session: string } }) => createElement('div', { 'data-terminal': tab.session }),
}));
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = {};
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

import { useStore } from '../src/store/store';
import type { DesktopWindow } from '../src/store/types';
import { ipConfigCommands } from '../src/gui/commands';
import { ipConfigFormFrom } from '../src/gui/forms';
import {
  DESKTOP_GRID_COLUMNS,
  DesktopTab,
  desktopAppAvailability,
  desktopAppsFor,
  isDesktopGridKey,
  moveGridFocus,
  windowsOfDevice,
} from '../src/desktop/DesktopTab';
import {
  WINDOW_KEEP_VISIBLE,
  WINDOW_MIN,
  WindowLayer,
  clampWindowRect,
  desktopWindowApp,
  keyAdjustedRect,
  orphanWindows,
  registerDesktopWindowApp,
  windowTitle,
} from '../src/desktop/WindowLayer';
import {
  NOTHING_TO_SEND,
  deviceBusyReason,
  deviceById,
  formatRate,
  outcomeMessages,
  portRefName,
  processPortRow,
  processState,
  signalBars,
  splitPortKey,
  submitPlan,
} from '../src/desktop/shared';
import { IpConfigApp, adapterStateText, editableAdapters, listedAdapters, sameIpForm } from '../src/desktop/apps/IpConfigApp';
import { WifiApp, requestScan, stationPort, stationStateText, wifiNetworks } from '../src/desktop/apps/WifiApp';
import { CellularApp, cellularAdapters, cellularStateText } from '../src/desktop/apps/CellularApp';
import { CommandPromptApp, openPromptSession } from '../src/desktop/apps/CommandPromptApp';

const setState = (useStore as unknown as { setState(p: Record<string, unknown>): void }).setState;

function indexOf(snapshot: SimSnapshot) {
  return {
    topologyVersion: snapshot.topologyVersion,
    devices: Object.fromEntries(snapshot.devices.map((d, i) => [d.id, i])),
    links: Object.fromEntries(snapshot.links.map((l, i) => [l.id, i])),
  };
}

function wifiLab() {
  const sim = createSimulation({ seed: 1 });
  sim.loadTopology(homeWifi());
  sim.runFor(60 * SEC);
  return sim;
}

function device(snapshot: SimSnapshot, id: string): DeviceSnapshot {
  const d = snapshot.devices.find((x) => x.id === id);
  if (d === undefined) throw new Error(`no device ${id}`);
  return d;
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function useSnapshot(snapshot: SimSnapshot | null, patch: Record<string, unknown> = {}): void {
  setState({
    snapshot,
    snapshotIndex: snapshot === null ? undefined : indexOf(snapshot),
    playing: false,
    desktopWindows: [],
    openDesktopWindow: vi.fn(() => 1),
    focusDesktopWindow: vi.fn(),
    closeDesktopWindow: vi.fn(),
    moveDesktopWindow: vi.fn(),
    announce: vi.fn(),
    select: vi.fn(),
    ...patch,
  });
}

beforeEach(() => {
  const s = (useStore as unknown as { getState(): Record<string, unknown> }).getState();
  for (const k of Object.keys(s)) delete s[k];
  useSnapshot(null);
  for (const f of Object.values(api)) f.mockReset();
});

// ── desktop tab ──────────────────────────────────────────────────────────────

describe('DesktopTab', () => {
  const sim = wifiLab();
  const snap = sim.snapshot();

  it('lists the desktop apps a device offers, in panel order', () => {
    // P1: hosts gain the browser app (contracts/catalog.ts GUI_PANELS: 'desktop.web-browser' and 'services' arrive in P1).
    expect(desktopAppsFor(device(snap, 'laptop1'))).toEqual(['desktop.ip-config', 'desktop.wifi', 'desktop.command-prompt', 'desktop.web-browser']);
    expect(desktopAppsFor(device(snap, 'pc1'))).toEqual(['desktop.ip-config', 'desktop.command-prompt', 'desktop.web-browser']);
    expect(desktopAppsFor(device(snap, 'home1'))).toEqual([]);
    expect(desktopAppsFor({ gui: ['desktop.wifi', 'physical', 'desktop.ip-config', 'desktop.wifi'] })).toEqual(['desktop.ip-config', 'desktop.wifi']);
    expect(desktopAppsFor({})).toEqual([]);
  });

  it('knows which apps this build can open', () => {
    // P1 W7 (web-learn): DesktopTab registers the browser app, so it joins the four P0.5 apps.
    for (const app of ['desktop.ip-config', 'desktop.wifi', 'desktop.cellular', 'desktop.command-prompt', 'desktop.web-browser'] as const) {
      expect(desktopAppAvailability(app)).toEqual({ ok: true });
      expect(desktopWindowApp(app)).toBeDefined();
    }
  });

  it('moves the launcher focus in a grid', () => {
    expect(DESKTOP_GRID_COLUMNS).toBe(3);
    expect(moveGridFocus(0, 'ArrowRight', 5)).toBe(1);
    expect(moveGridFocus(4, 'ArrowRight', 5)).toBe(4);
    expect(moveGridFocus(0, 'ArrowLeft', 5)).toBe(0);
    expect(moveGridFocus(1, 'ArrowDown', 5)).toBe(4);
    expect(moveGridFocus(2, 'ArrowDown', 5)).toBe(2);
    expect(moveGridFocus(4, 'ArrowUp', 5)).toBe(1);
    expect(moveGridFocus(0, 'ArrowUp', 5)).toBe(0);
    expect(moveGridFocus(3, 'Home', 5)).toBe(0);
    expect(moveGridFocus(0, 'End', 5)).toBe(4);
    expect(moveGridFocus(9, 'ArrowLeft', 5)).toBe(3);
    expect(moveGridFocus(2, 'End', 0)).toBe(2);
    expect(isDesktopGridKey('ArrowUp')).toBe(true);
    expect(isDesktopGridKey('Enter')).toBe(false);
  });

  it('renders launchers with one tab stop and the open windows of the device', () => {
    const wins: DesktopWindow[] = [
      { id: 1, device: 'laptop1', app: 'desktop.wifi', x: 0, y: 0, w: 300, h: 200, z: 1 },
      { id: 2, device: 'pc1', app: 'desktop.ip-config', x: 0, y: 0, w: 300, h: 200, z: 3 },
      { id: 3, device: 'laptop1', app: 'desktop.ip-config', x: 0, y: 0, w: 300, h: 200, z: 2 },
    ];
    expect(windowsOfDevice(wins, 'laptop1').map((w) => w.id)).toEqual([3, 1]);
    useSnapshot(snap, { desktopWindows: wins });
    const html = renderToStaticMarkup(createElement(DesktopTab, { device: device(snap, 'laptop1') }));
    expect((html.match(/data-app="/g) ?? []).length).toBe(4); // P1: + the browser launcher
    expect((html.match(/tabindex="0"/g) ?? []).length).toBe(1);
    expect(html).toMatch(/data-app="desktop.wifi"[^>]*class="desk-launcher is-open"/);
    const t = text(html);
    expect(t).toContain('IP configuration');
    expect(t).toContain('Command prompt');
    expect(t).toContain('Open windows');
    expect(t).toContain('LAPTOP1 · IP configuration');
    expect(t).not.toContain('PC1 ·');
  });

  it('says when a device has no apps and when it is off', () => {
    useSnapshot(snap);
    expect(text(renderToStaticMarkup(createElement(DesktopTab, { device: device(snap, 'home1') })))).toContain('This device has no desktop apps.');
    const off = { ...device(snap, 'pc1'), power: false };
    expect(text(renderToStaticMarkup(createElement(DesktopTab, { device: off })))).toContain('The device is switched off.');
  });
});

// ── window layer ─────────────────────────────────────────────────────────────

describe('WindowLayer', () => {
  it('clamps windows to the layer', () => {
    const bounds = { w: 800, h: 600 };
    expect(clampWindowRect({ x: 10, y: 10, w: 300, h: 200 }, bounds)).toEqual({ x: 10, y: 10, w: 300, h: 200 });
    expect(clampWindowRect({ x: 10, y: 10, w: 10, h: 10 }, bounds)).toEqual({ x: 10, y: 10, w: WINDOW_MIN.w, h: WINDOW_MIN.h });
    expect(clampWindowRect({ x: 5000, y: 5000, w: 300, h: 200 }, bounds)).toEqual({ x: 800 - WINDOW_KEEP_VISIBLE, y: 600 - WINDOW_KEEP_VISIBLE, w: 300, h: 200 });
    expect(clampWindowRect({ x: -5000, y: -20, w: 300, h: 200 }, bounds)).toEqual({ x: WINDOW_KEEP_VISIBLE - 300, y: 0, w: 300, h: 200 });
    expect(clampWindowRect({ x: 0, y: 0, w: 2000, h: 2000 }, bounds)).toEqual({ x: 0, y: 0, w: 800, h: 600 });
    expect(clampWindowRect({ x: 1.4, y: -3, w: 300.6, h: 200 }, { w: 0, h: 0 })).toEqual({ x: 1, y: 0, w: 301, h: 200 });
  });

  it('moves and resizes from the keyboard', () => {
    const r = { x: 50, y: 50, w: 300, h: 200 };
    expect(keyAdjustedRect(r, 'ArrowLeft', false)).toEqual({ x: 34, y: 50, w: 300, h: 200 });
    expect(keyAdjustedRect(r, 'ArrowDown', false, 10)).toEqual({ x: 50, y: 60, w: 300, h: 200 });
    expect(keyAdjustedRect(r, 'ArrowRight', true)).toEqual({ x: 50, y: 50, w: 316, h: 200 });
    expect(keyAdjustedRect(r, 'ArrowUp', true)).toEqual({ x: 50, y: 50, w: 300, h: 184 });
    expect(keyAdjustedRect(r, 'Enter', false)).toBeUndefined();
  });

  it('names windows and finds orphans', () => {
    expect(windowTitle('PC1', 'desktop.ip-config')).toBe('PC1 · IP configuration');
    expect(windowTitle(undefined, 'desktop.wifi')).toBe('Wi-Fi');
    const wins = [
      { id: 1, device: 'a' },
      { id: 2, device: 'b' },
    ];
    expect(orphanWindows(wins, (d) => d === 'a')).toEqual([2]);
  });

  it('renders non-modal dialogs with the front window marked', () => {
    const sim = wifiLab();
    const snap = sim.snapshot();
    registerDesktopWindowApp('services', () => createElement('p', null, 'custom panel'));
    useSnapshot(snap, {
      desktopWindows: [
        { id: 4, device: 'pc1', app: 'desktop.ip-config', x: 10, y: 20, w: 400, h: 300, z: 1 },
        { id: 5, device: 'pc1', app: 'services', x: 30, y: 40, w: 400, h: 300, z: 2 },
        { id: 6, device: 'pc1', app: 'modem.status', x: 30, y: 40, w: 400, h: 300, z: 0 },
      ],
    });
    const html = renderToStaticMarkup(createElement(WindowLayer));
    expect((html.match(/role="dialog"/g) ?? []).length).toBe(3);
    expect((html.match(/aria-modal="false"/g) ?? []).length).toBe(3);
    expect((html.match(/class="desk-window is-top"/g) ?? []).length).toBe(1);
    expect(html).toContain('data-window-titlebar="4"');
    expect(html).toContain('left:10px;top:20px;width:400px;height:300px;z-index:1');
    const t = text(html);
    expect(t).toContain('PC1 · IP configuration');
    expect(t).toContain('custom panel');
    expect(t).toContain('This panel is shown in the inspector.');
    useSnapshot(snap);
    expect(renderToStaticMarkup(createElement(WindowLayer))).toBe('');
  });
});

// ── shared ───────────────────────────────────────────────────────────────────

describe('desktop shared helpers', () => {
  it('finds devices through the index and names port keys', () => {
    const snap = wifiLab().snapshot();
    const index = indexOf(snap);
    expect(deviceById(snap, index, 'laptop1')?.name).toBe('LAPTOP1');
    expect(deviceById(snap, { devices: { laptop1: 0 } }, 'laptop1')?.name).toBe('LAPTOP1');
    expect(deviceById(snap, undefined, 'nope')).toBeUndefined();
    expect(deviceById(null, index, 'laptop1')).toBeUndefined();
    expect(splitPortKey('home1/Wlan0')).toEqual({ device: 'home1', port: 'Wlan0' });
    expect(splitPortKey('sw1/FastEthernet0/1')).toEqual({ device: 'sw1', port: 'FastEthernet0/1' });
    expect(splitPortKey('bad')).toBeUndefined();
    expect(portRefName(snap, index, 'home1/Wlan0')).toBe('HOME1 Wlan0');
    expect(portRefName(snap, index, { device: 'x', port: 'P' })).toBe('x P');
    expect(portRefName(snap, index, 'bad')).toBe('bad');
  });

  it('reads process port rows', () => {
    const snap = wifiLab().snapshot();
    const state = processState(device(snap, 'laptop1'), 'wlan-client');
    expect(processPortRow(state, 'Wlan0')?.['state']).toBe('associated');
    expect(processPortRow(state, 'Wlan9')).toBeUndefined();
    expect(processPortRow(undefined, 'Wlan0')).toBeUndefined();
    expect(processState(device(snap, 'pc1'), 'wlan-client')).toBeUndefined();
  });

  it('turns levels into bars and rates into text', () => {
    expect(signalBars(undefined)).toBe(0);
    expect(signalBars(Number.NaN)).toBe(0);
    expect(signalBars(0)).toBe(Math.min(4, RF.BARS_MDB.length));
    expect(signalBars(-200)).toBe(0);
    const levels = [-95, -85, -75, -65, -55, -45].map((l) => signalBars(l));
    for (let i = 1; i < levels.length; i++) expect(levels[i]!).toBeGreaterThanOrEqual(levels[i - 1]!);
    expect(formatRate(54_000_000)).toBe('54 Mb/s');
    expect(formatRate(1_200_000_000)).toBe('1.2 Gb/s');
    expect(formatRate(600_000)).toBe('600 kb/s');
    expect(formatRate(12)).toBe('12 b/s');
    expect(formatRate(0)).toBe('no data rate');
    expect(formatRate(undefined)).toBe('no data rate');
  });

  it('explains why a device cannot take settings', () => {
    expect(deviceBusyReason({ power: false, booted: false })).toContain('switched off');
    expect(deviceBusyReason({ power: true, booted: false })).toContain('starting up');
    expect(deviceBusyReason({ power: true, booted: true })).toBeUndefined();
    expect(outcomeMessages({ ok: false, reverted: true, fieldErrors: {}, general: ['x'], skipped: 2 })).toEqual([
      'x',
      'Nothing was changed: the device undid the settings it had already taken.',
    ]);
    expect(outcomeMessages({ ok: false, reverted: false, fieldErrors: {}, general: [], skipped: 1 })).toEqual(['1 later setting was not applied.']);
  });
});

// ── IP configuration ─────────────────────────────────────────────────────────

describe('IpConfigApp', () => {
  it('picks the adapters a device can edit', () => {
    const snap = wifiLab().snapshot();
    const pc = device(snap, 'pc1');
    const laptop = device(snap, 'laptop1');
    const home = device(snap, 'home1');
    expect(editableAdapters(pc)).toEqual(['GigabitEthernet0']);
    expect(editableAdapters(laptop)).toEqual(['GigabitEthernet0']);
    expect(listedAdapters(laptop).map((p) => p.id)).toEqual(['GigabitEthernet0', 'Wlan0']);
    const routed = editableAdapters(home);
    expect(routed).toContain('Vlan1');
    expect(routed).not.toContain('GigabitEthernet1');
    expect(adapterStateText({ adminUp: false, operUp: false }).text).toBe('disabled');
    expect(adapterStateText({ adminUp: true, operUp: true }).glyph).toBe('▲');
    expect(adapterStateText({ adminUp: true, operUp: false }).text).toBe('not connected');
    const f = { adapter: 'G', address: '10.0.0.1 ', mask: '255.0.0.0', gateway: '' };
    expect(sameIpForm(f, { ...f, address: '10.0.0.1' })).toBe(true);
    expect(sameIpForm(f, { ...f, gateway: '10.0.0.254' })).toBe(false);
  });

  it('applies a form through configure, and the lines are accepted by the device', async () => {
    const sim = wifiLab();
    const pc = device(sim.snapshot(), 'pc1');
    const before = ipConfigFormFrom(pc, 'GigabitEthernet0');
    const next = { ...before, address: '192.168.1.20', mask: '255.255.255.0', gateway: '192.168.1.1' };
    const plan = ipConfigCommands('host', next, before, 'GigabitEthernet0');
    api.configure.mockImplementation((dev: string, commands: string[], opts?: ConfigureOptions): ConfigureResult => sim.configure(dev, commands, opts));
    const outcome = await submitPlan('pc1', plan);
    expect(outcome.ok).toBe(true);
    expect(api.configure).toHaveBeenCalledTimes(1);
    expect(api.configure.mock.calls[0]![0]).toBe('pc1');
    const port = device(sim.snapshot(), 'pc1').ports.find((p) => p.id === 'GigabitEthernet0')!;
    expect(port.l3.ipv4).toMatchObject({ address: '192.168.1.20', prefixLen: 24 });
  });

  it('maps device errors and worker failures to messages', async () => {
    const sim = wifiLab();
    sim.setPower('pc1', false);
    api.configure.mockImplementation((dev: string, commands: string[], opts?: ConfigureOptions): ConfigureResult => sim.configure(dev, commands, opts));
    const pc = device(sim.snapshot(), 'pc1');
    const before = ipConfigFormFrom(pc, 'GigabitEthernet0');
    const plan = ipConfigCommands('host', { ...before, address: '10.1.1.1', mask: '255.255.255.0', gateway: '' }, before, 'GigabitEthernet0');
    const off = await submitPlan('pc1', plan);
    expect(off.ok).toBe(false);
    expect(Object.keys(off.fieldErrors).length + off.general.length).toBeGreaterThan(0);
    api.configure.mockRejectedValueOnce(new Error('worker gone'));
    const failed = await submitPlan('pc1', plan);
    expect(failed.ok).toBe(false);
    expect(failed.general[0]).toContain('worker gone');
    expect(await submitPlan('pc1', { ...plan, commands: [], lines: [] })).toBe(NOTHING_TO_SEND);
  });

  it('renders the adapter table and the address form', () => {
    const snap = wifiLab().snapshot();
    useSnapshot(snap);
    const html = renderToStaticMarkup(createElement(IpConfigApp, { deviceId: 'laptop1', windowId: 1 }));
    const t = text(html);
    expect(t).toContain('Network adapters');
    expect(t).toContain('Wlan0');
    expect(t).toContain('IP address');
    expect(t).toContain('Subnet mask');
    expect(t).toContain('Default gateway');
    expect(t).toContain('Apply');
    expect(t).toContain('Disable adapter');
    expect(renderToStaticMarkup(createElement(IpConfigApp, { deviceId: 'gone', windowId: 1 }))).toContain('no longer on the canvas');
  });
});

// ── Wi-Fi ────────────────────────────────────────────────────────────────────

describe('WifiApp', () => {
  it('merges scan candidates into networks, strongest first', () => {
    const nets = wifiNetworks([
      { bssid: 'aa', ssid: 'LAB', security: 'wpa2-psk', band: '2.4', channel: 6, rssiDbm: -70 },
      { bssid: 'bb', ssid: 'LAB', security: 'wpa2-psk', band: '5', channel: 36, rssiDbm: -60 },
      { bssid: 'cc', ssid: 'CAFE', security: 'open', rssiDbm: -50 },
      { bssid: 'dd', ssid: 'QUIET', security: 'open' },
      { bssid: 'ee', ssid: '', security: 'open', rssiDbm: -40 },
      { bssid: 'ff', ssid: 'ODD', security: 'wep' },
      null,
      'junk',
    ]);
    expect(nets.map((n) => n.ssid)).toEqual(['CAFE', 'LAB', 'QUIET']);
    const lab = nets[1]!;
    expect(lab).toMatchObject({ key: 'LAB|wpa2-psk', rssiDbm: -60, bands: ['2.4', '5'], channels: [6, 36], bssids: ['aa', 'bb'] });
    expect(lab.bars).toBe(signalBars(-60));
    expect(nets[2]!.rssiDbm).toBeUndefined();
    expect(nets[2]!.bars).toBe(0);
    expect(wifiNetworks(undefined)).toEqual([]);
  });

  it('words the station state', () => {
    expect(stationStateText('associated', 'LAB')).toEqual({ glyph: '✓', text: 'Connected to “LAB”.' });
    expect(stationStateText('failed', 'LAB', 'wrong-key').text).toBe('Could not join “LAB”. The password was not accepted.');
    expect(stationStateText('failed', 'LAB', 'mystery').text).toContain('Trying again shortly.');
    expect(stationStateText('handshake', 'LAB').text).toContain('Checking the password');
    expect(stationStateText(undefined, '').text).toBe('Not connected to a wireless network.');
    expect(stationStateText('idle', 'LAB').text).toBe('Waiting to join “LAB”.');
  });

  it('scans through hostRequest, falling back to the host shell line', async () => {
    const sim = wifiLab();
    api.hostRequest.mockResolvedValueOnce({ requestId: 'r_1', process: 'wlan-client' });
    await requestScan('laptop1', 'Wlan0', 'host');
    expect(api.hostRequest).toHaveBeenCalledWith('laptop1', { app: 'wifi.scan', port: 'Wlan0' });
    expect(api.configure).not.toHaveBeenCalled();

    api.hostRequest.mockRejectedValue(new Error('not available'));
    api.configure.mockImplementation((dev: string, commands: string[], opts?: ConfigureOptions): ConfigureResult => sim.configure(dev, commands, opts));
    await requestScan('laptop1', 'Wlan0', 'host');
    expect(api.configure).toHaveBeenCalledWith('laptop1', ['wifi list'], { stopOnError: true });

    await expect(requestScan('pc1', 'GigabitEthernet0', 'host')).rejects.toThrow();
    await expect(requestScan('home1', 'Wlan0', 'nfos')).rejects.toThrow('not available');
  });

  it('shows the association and the networks heard', () => {
    const snap = wifiLab().snapshot();
    const laptop = device(snap, 'laptop1');
    expect(stationPort(laptop)?.id).toBe('Wlan0');
    expect(stationPort(device(snap, 'pc1'))).toBeUndefined();
    const withCandidates: DeviceSnapshot = {
      ...laptop,
      processes: laptop.processes.map((p) =>
        p.process !== 'wlan-client'
          ? p
          : { ...p, state: { ports: [{ port: 'Wlan0', state: 'associated', ssid: 'LAB', security: 'wpa2-psk', candidates: [{ bssid: 'aa', ssid: 'LAB', security: 'wpa2-psk', band: '2.4', channel: 1, rssiDbm: -58 }] }] } },
      ),
    };
    const patched: SimSnapshot = { ...snap, devices: snap.devices.map((d) => (d.id === 'laptop1' ? withCandidates : d)) };
    useSnapshot(patched);
    const html = renderToStaticMarkup(createElement(WifiApp, { deviceId: 'laptop1', windowId: 1 }));
    const t = text(html);
    expect(t).toContain('Connected to “LAB”.');
    expect(t).toContain('dBm');
    expect(t).toContain('Networks in range');
    expect(t).toContain('LAB');
    expect(t).toContain('chosen');
    expect(t).toContain('Disconnect');
    expect(html).toContain('role="img"');
    expect(html).toContain(`aria-label="Signal ${signalBars(-58)} of 4, -58 dBm"`);
    useSnapshot(snap);
    expect(text(renderToStaticMarkup(createElement(WifiApp, { deviceId: 'pc1', windowId: 1 })))).toContain('no Wi-Fi adapter');
  });

  it('joins with a passphrase through the host shell line', async () => {
    const sim = createSimulation({ seed: 1 });
    const topo = homeWifi();
    sim.loadTopology(topo);
    sim.runFor(5 * SEC);
    const { wifiClientCommands } = await import('../src/gui/commands');
    const { wifiClientFormFrom } = await import('../src/gui/forms');
    const laptop = device(sim.snapshot(), 'laptop1');
    const current = wifiClientFormFrom(laptop, 'Wlan0');
    const plan = wifiClientCommands('host', { ...current, ssid: 'OTHER', security: 'wpa2-psk', passphrase: 'secret-pass' }, current);
    expect(plan.commands).toEqual(['wifi connect OTHER key secret-pass']);
    api.configure.mockImplementation((dev: string, commands: string[], opts?: ConfigureOptions): ConfigureResult => sim.configure(dev, commands, opts));
    const outcome = await submitPlan('laptop1', plan);
    expect(outcome.ok).toBe(true);
    expect(device(sim.snapshot(), 'laptop1').runningConfig).toContain('OTHER');
  });
});

// ── cellular ─────────────────────────────────────────────────────────────────

describe('CellularApp', () => {
  it('finds cellular adapters and words the attach phases', () => {
    const sim = createSimulation({ seed: 2 });
    sim.loadTopology(cellularPhones());
    sim.runFor(5 * SEC);
    const snap = sim.snapshot();
    const phone = snap.devices.find((d) => d.type === 'phone.nfsmartphone')!;
    expect(cellularAdapters(phone).map((p) => p.kind)).toEqual(['cellular']);
    expect(cellularAdapters(snap.devices.find((d) => d.type === 'server.nfserver')!)).toEqual([]);
    expect(cellularStateText({ adminUp: false }).text).toBe('Mobile data is off.');
    expect(cellularStateText({ adminUp: true, phase: 'attached', towerName: 'TOWER1 Cellular0' }).text).toBe('Connected through TOWER1 Cellular0.');
    expect(cellularStateText({ adminUp: true, state: 'searching' }).text).toBe('Searching for a tower.');
    expect(cellularStateText({ adminUp: true, phase: 'detached', reason: 'out-of-range' }).text).toBe('No service (out of range). Searching again shortly.');
    expect(cellularStateText({ adminUp: true }).glyph).toBe('○');

    useSnapshot(snap);
    const html = renderToStaticMarkup(createElement(CellularApp, { deviceId: phone.id, windowId: 1 }));
    const t = text(html);
    const assoc = snap.media?.associations.find((a) => a.tech === 'cellular' && a.station.device === phone.id);
    if (assoc !== undefined && assoc.state === 'attached') {
      expect(t).toContain('Connected');
      expect(t).toContain('from the tower');
    }
    expect(t).toContain('Turn mobile data off');
    expect(t).toContain('Physical address');
    expect(text(renderToStaticMarkup(createElement(CellularApp, { deviceId: 'srv1', windowId: 1 })))).toMatch(/no mobile data adapter|no longer on the canvas/);
  });
});

// ── command prompt ───────────────────────────────────────────────────────────

describe('CommandPromptApp', () => {
  it('opens a console, reports refusals and closes sessions of closed windows', async () => {
    api.cliCanOpen.mockResolvedValueOnce({ ok: false, reason: 'No console here.' });
    expect(await openPromptSession('home1', () => false)).toEqual({ phase: 'refused', reason: 'No console here.' });

    api.cliCanOpen.mockResolvedValueOnce({ ok: true });
    api.cliOpen.mockResolvedValueOnce({ id: 's_1' });
    expect(await openPromptSession('pc1', () => false)).toEqual({ phase: 'open', session: 's_1' });

    let cancelled = false;
    api.cliCanOpen.mockResolvedValueOnce({ ok: true });
    api.cliOpen.mockImplementationOnce(async () => {
      cancelled = true;
      return { id: 's_2' };
    });
    api.cliClose.mockResolvedValue(undefined);
    expect(await openPromptSession('pc1', () => cancelled)).toBeUndefined();
    expect(api.cliClose).toHaveBeenCalledWith('s_2');

    api.cliCanOpen.mockRejectedValueOnce(new Error('old engine'));
    api.cliOpen.mockRejectedValueOnce(new Error('Device is off.'));
    expect(await openPromptSession('pc1', () => false)).toEqual({ phase: 'refused', reason: 'Device is off.' });
  });

  it('shows the opening state first', () => {
    const snap = wifiLab().snapshot();
    useSnapshot(snap);
    expect(text(renderToStaticMarkup(createElement(CommandPromptApp, { deviceId: 'pc1', windowId: 1 })))).toContain('Opening a command prompt');
  });
});
