// Wireless controller panel (ARCHITECTURE-P2 §3.12, §5.3, §5.5 "Controller panel", §10.2 "WlcPanel command test"; §7
// W6 web-inspector): through a mocked engine, the Interfaces page emits exactly the §5.3 `wlc-interface` lines for a
// new interface and the WLANs page exactly the `wlan` lines (with `interface <name>`) for a new WLAN; nothing is sent
// while a field is wrong; refusals come back on their fields; the access point and client pages read the capwap-aps and
// wlan-clients rows; the rendered pages carry their facts as text; the `wlc.controller` panel routes to its tab.
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TABLE_DESCRIPTORS, createSimulation } from '@netforge/engine';
import type { ConfigureOptions, ConfigureResult, DeviceSnapshot, TableSnapshot } from '@netforge/engine';

vi.mock('../src/bridge/client', () => ({ engine: {}, fmtSimTime: (t: number) => `${t / 1_000_000_000} s` }));
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = { catalog: [], snapshot: null, snapshotIndex: undefined, epoch: 0, events: [], toast: vi.fn(), announce: vi.fn() };
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

import {
  CAPWAP_STATE_TEXT,
  WLC_PAGES,
  WlcPanel,
  appliedWlanForm,
  applyWlan,
  applyWlcInterface,
  capwapApRows,
  initialWlcPage,
  removeWlan,
  removeWlcInterface,
  stepWlcPage,
  wlanClientRows,
  wlanContextOf,
  wlansByInterface,
  wlcInterfaceContextOf,
} from '../src/inspector/WlcPanel';
import type { WlcPage } from '../src/inspector/WlcPanel';
import { emptyWlanForm, emptyWlcInterfaceForm, wlanFormsFrom, wlcInterfaceFormsFrom } from '../src/gui/forms';
import type { WlanForm, WlcInterfaceForm } from '../src/gui/forms';
import { inspectorTabLabel, inspectorTabsFor, panelsForTab } from '../src/inspector/tabs';

// ── fixtures ─────────────────────────────────────────────────────────────────

interface ConfigureCall {
  device: string;
  commands: string[];
  opts: ConfigureOptions | undefined;
}

function result(commands: readonly string[], fail?: { index: number; message: string; column?: number }): ConfigureResult {
  const lines = commands.map((line, index) => {
    if (fail === undefined || index < fail.index) return { index, line, ok: true, output: '', mode: 'config' as const };
    if (index === fail.index) return { index, line, ok: false, output: '', mode: 'config' as const, error: { message: fail.message, ...(fail.column !== undefined ? { column: fail.column } : {}) } };
    return { index, line, ok: false, output: '', mode: 'config' as const, skipped: true };
  });
  return { ok: fail === undefined, lines, applied: fail === undefined ? commands.length : 0, reverted: fail !== undefined, finalMode: 'config' };
}

function mockEngine(answer: (commands: readonly string[]) => ConfigureResult = (c) => result(c)) {
  const calls: ConfigureCall[] = [];
  const api = {
    configure: vi.fn(async (device: string, commands: string[], opts?: ConfigureOptions) => {
      calls.push({ device, commands: [...commands], opts });
      return answer(commands);
    }),
  };
  return { api, calls };
}

const STAFF_IF: WlcInterfaceForm = { name: 'STAFF-IF', vlan: '20', address: '192.168.20.5', mask: '255.255.255.0', gateway: '192.168.20.1', dhcpServer: '192.168.20.1' };
const MGMT: WlcInterfaceForm = { name: 'management', vlan: '99', address: '192.168.99.5', mask: '255.255.255.0', gateway: '192.168.99.1', dhcpServer: '' };
const STAFF: WlanForm = { id: '1', profile: 'STAFF', ssid: 'LabNet', security: 'wpa2-psk', passphrase: 'lab-passphrase', hasPassphrase: false, iface: 'STAFF-IF', radio: 'all', enabled: true };

function table(name: keyof typeof TABLE_DESCRIPTORS, rows: Record<string, unknown>[]): TableSnapshot {
  const d = TABLE_DESCRIPTORS[name];
  return { name, title: d.title, columns: [...d.columns], rows };
}

/** A real NF-WLC-9800 configured through the builders (the §3.12 controller), with its CAPWAP rows filled in. */
function configuredController(): DeviceSnapshot {
  const sim = createSimulation({ seed: 9, profile: 'P2' });
  sim.addDevice({ id: 'wlc', type: 'wlc.nfwlc9800', name: 'WLC1', position: { x: 0, y: 0 } });
  sim.runToIdle();
  const lines = [
    'wlc-interface management',
    ' vlan 99',
    ' address 192.168.99.5 255.255.255.0',
    ' gateway 192.168.99.1',
    'wlc-interface STAFF-IF',
    ' vlan 20',
    ' address 192.168.20.5 255.255.255.0',
    ' gateway 192.168.20.1',
    ' dhcp-server 192.168.20.1',
    'wlan 1 STAFF LabNet',
    ' security wpa2-psk',
    ' passphrase lab-passphrase',
    ' interface STAFF-IF',
  ];
  expect(sim.configure('wlc', lines, { indentation: true, stopOnError: true, atomic: true }).ok).toBe(true);
  sim.runToIdle();
  const d = sim.snapshot().devices.find((x) => x.id === 'wlc') as DeviceSnapshot;
  const extra = (d.tables.extra ?? []).filter((t) => t.name !== 'capwap-aps' && t.name !== 'wlan-clients');
  extra.push(
    table('capwap-aps', [
      { key: '02:00:00:00:0b:00', apMac: '02:00:00:00:0b:00', apIp: '192.168.99.21', name: 'LAP2', state: 'join', clients: 0, updatedAt: 0 },
      { key: '02:00:00:00:0a:00', apMac: '02:00:00:00:0a:00', apIp: '192.168.99.20', name: 'LAP1', state: 'run', clients: 1, updatedAt: 0 },
    ]),
    table('wlan-clients', [
      { key: '02:00:00:00:0c:01', station: '02:00:00:00:0c:01', ap: '02:00:00:00:0a:00', bssid: '02:00:00:00:0a:10', wlanId: 1, ssid: 'LabNet', vlan: 20, iface: 'STAFF-IF', state: 'associated', updatedAt: 0 },
    ]),
  );
  return { ...d, tables: { ...d.tables, extra } };
}

const WLC = configuredController();

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

function render(page: WlcPage, device: DeviceSnapshot = WLC): string {
  return renderToStaticMarkup(createElement(WlcPanel, { device, initialPage: page }));
}

// ── §10.2: the command test ──────────────────────────────────────────────────

describe('WlcPanel command test (§10.2)', () => {
  it('the Interfaces page sends exactly the §5.3 wlc-interface lines for a new interface', async () => {
    const { api, calls } = mockEngine();
    const interfaces = [MGMT];
    const out = await applyWlcInterface(api, 'wlc', STAFF_IF, undefined, wlcInterfaceContextOf(interfaces, undefined));
    expect(calls).toEqual([
      {
        device: 'wlc',
        commands: ['wlc-interface STAFF-IF', ' vlan 20', ' address 192.168.20.5 255.255.255.0', ' gateway 192.168.20.1', ' dhcp-server 192.168.20.1'],
        opts: { indentation: true, stopOnError: true, atomic: true },
      },
    ]);
    expect(out.sent).toEqual(calls[0]!.commands);
    expect(out.outcome?.ok).toBe(true);
  });

  it('the Interfaces page sets the predefined management interface (VLAN, address, gateway)', async () => {
    const { api, calls } = mockEngine();
    const blank = emptyWlcInterfaceForm('management');
    await applyWlcInterface(api, 'wlc', MGMT, blank, wlcInterfaceContextOf([blank], blank));
    expect(calls[0]!.commands).toEqual(['wlc-interface management', ' vlan 99', ' address 192.168.99.5 255.255.255.0', ' gateway 192.168.99.1']);
  });

  it('the WLANs page sends exactly the wlan lines, with interface <name>, for a new WLAN', async () => {
    const { api, calls } = mockEngine();
    const interfaces = [MGMT, STAFF_IF];
    const out = await applyWlan(api, 'wlc', STAFF, undefined, wlanContextOf([], interfaces, undefined));
    expect(calls).toEqual([
      {
        device: 'wlc',
        commands: ['wlan 1 STAFF LabNet', ' security wpa2-psk', ' passphrase lab-passphrase', ' interface STAFF-IF', ' no shutdown'],
        opts: { indentation: true, stopOnError: true, atomic: true },
      },
    ]);
    expect(out.outcome?.ok).toBe(true);
  });

  it('sends nothing while a field is wrong, and nothing when nothing changed', async () => {
    const { api, calls } = mockEngine();
    const bad = await applyWlcInterface(api, 'wlc', { ...STAFF_IF, vlan: '99' }, undefined, wlcInterfaceContextOf([MGMT], undefined));
    expect(bad.sent).toBeNull();
    expect(bad.clientErrors).toEqual({ vlan: 'VLAN 99 already belongs to the interface management.' });
    const noIface = await applyWlan(api, 'wlc', STAFF, undefined, wlanContextOf([], [MGMT], undefined));
    expect(Object.keys(noIface.clientErrors)).toEqual(['iface']);
    const same = await applyWlcInterface(api, 'wlc', STAFF_IF, STAFF_IF, wlcInterfaceContextOf([MGMT, STAFF_IF], STAFF_IF));
    expect(same).toEqual({ sent: null, clientErrors: {}, outcome: null });
    expect(calls).toEqual([]);
  });

  it('puts the controller refusal next to the input that produced it', async () => {
    const { api } = mockEngine((c) => result(c, { index: 2, message: '% That subnet overlaps with the address already on Vlan99.' }));
    const out = await applyWlcInterface(api, 'wlc', STAFF_IF, undefined, wlcInterfaceContextOf([], undefined));
    expect(out.outcome?.ok).toBe(false);
    expect(out.outcome?.reverted).toBe(true);
    expect(out.outcome?.fieldErrors).toEqual({ address: 'That subnet overlaps with the address already on Vlan99.' });
    expect(out.outcome?.skipped).toBe(2);
    const { api: api2 } = mockEngine((c) => result(c, { index: 0, message: '% Invalid input', column: 13 }));
    const wlan = await applyWlan(api2, 'wlc', STAFF, undefined, wlanContextOf([], [MGMT, STAFF_IF], undefined));
    expect(Object.keys(wlan.outcome?.fieldErrors ?? {})).toEqual(['ssid']);
  });

  it('removes interfaces and WLANs with one field-less line each', async () => {
    const { api, calls } = mockEngine((c) => result(c, c[0] === 'no wlc-interface STAFF-IF' ? { index: 0, message: '% WLAN 1 uses controller interface STAFF-IF; point it at another interface first.' } : undefined));
    const refused = await removeWlcInterface(api, 'wlc', 'STAFF-IF');
    expect(refused.outcome?.general).toEqual(['no wlc-interface STAFF-IF: WLAN 1 uses controller interface STAFF-IF; point it at another interface first.']);
    const ok = await removeWlan(api, 'wlc', '1');
    expect(ok.outcome?.ok).toBe(true);
    expect(calls.map((c) => c.commands)).toEqual([['no wlc-interface STAFF-IF'], ['no wlan 1']]);
  });

  it('the lines it sends are the ones the real controller stores', () => {
    const interfaces = wlcInterfaceFormsFrom(WLC.runningConfig);
    expect(interfaces).toEqual([MGMT, STAFF_IF]);
    expect(wlanFormsFrom(WLC.runningConfig)).toEqual([appliedWlanForm(STAFF)]);
  });
});

// ── models ───────────────────────────────────────────────────────────────────

describe('controller panel models', () => {
  it('builds the validation contexts from everything but the edited item', () => {
    expect(wlcInterfaceContextOf([MGMT, STAFF_IF], STAFF_IF)).toEqual({ others: [MGMT], isNew: false });
    expect(wlcInterfaceContextOf([MGMT, STAFF_IF], undefined)).toEqual({ others: [MGMT, STAFF_IF], isNew: true });
    const wlans = [appliedWlanForm(STAFF), { ...emptyWlanForm('7'), profile: 'GUEST', ssid: 'Visitors' }];
    expect(wlanContextOf(wlans, [MGMT, STAFF_IF], wlans[0])).toEqual({ others: [wlans[1]], interfaces: ['management', 'STAFF-IF'] });
    expect(wlansByInterface(wlans).get('STAFF-IF')).toEqual(['1']);
    expect(wlansByInterface(wlans).get('management')).toEqual(['7']);
  });

  it('forgets a typed passphrase once applied, keeping only its presence', () => {
    expect(appliedWlanForm(STAFF)).toEqual({ ...STAFF, passphrase: '', hasPassphrase: true });
    expect(appliedWlanForm({ ...STAFF, security: 'open', passphrase: '' })).toMatchObject({ passphrase: '', hasPassphrase: false });
  });

  it('reads the access points and clients, ordered, and words every join state', () => {
    expect(capwapApRows(WLC).map((a) => a.name)).toEqual(['LAP1', 'LAP2']);
    expect(wlanClientRows(WLC).map((c) => c.station)).toEqual(['02:00:00:00:0c:01']);
    for (const s of ['idle', 'discovery', 'dtls', 'join', 'configure', 'data-check', 'run'] as const) {
      expect(CAPWAP_STATE_TEXT[s].text).not.toBe('');
      expect(CAPWAP_STATE_TEXT[s].glyph).not.toBe('');
    }
    expect(capwapApRows({ tables: { cam: [], arp: [], rib: [] } })).toEqual([]);
  });

  it('opens on the Interfaces page until the management interface has an address', () => {
    expect(initialWlcPage(WLC)).toBe('aps');
    expect(initialWlcPage({ runningConfig: 'hostname WLC1\n!\nend' })).toBe('interfaces');
    expect(WLC_PAGES).toEqual(['aps', 'interfaces', 'wlans', 'clients']);
    expect(stepWlcPage('aps', 'next')).toBe('interfaces');
    expect(stepWlcPage('aps', 'prev')).toBe('clients');
    expect(stepWlcPage('wlans', 'first')).toBe('aps');
    expect(stepWlcPage('interfaces', 'last')).toBe('clients');
  });
});

// ── rendering ────────────────────────────────────────────────────────────────

describe('WlcPanel rendering', () => {
  it('has a keyboard tab list of the four pages', () => {
    const html = render('aps');
    expect(html.match(/role="tab"/g)?.length).toBe(4);
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tabpanel"');
    expect(html.match(/aria-selected="true"/g)?.length).toBe(1);
    expect(html.match(/tabindex="0"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(text(html)).toContain('Access points (2)');
    expect(text(html)).toContain('Clients (1)');
  });

  it('Access points: the joined access points with their state in words', () => {
    const t = text(render('aps'));
    expect(t).toContain('Access points join on the management interface: 192.168.99.5 in VLAN 99');
    expect(t).toContain('LAP1 02:00:00:00:0a:00 192.168.99.20 ● running 1');
    expect(t).toContain('LAP2 02:00:00:00:0b:00 192.168.99.21 ▲ joining 0');
    const bare = { ...WLC, runningConfig: 'hostname WLC1\n!\nend', tables: { cam: [], arp: [], rib: [] } };
    const empty = text(render('aps', bare));
    expect(empty).toContain('The management interface has no address yet, so no access point can join.');
    expect(empty).toContain('No access point has joined yet.');
  });

  it('Interfaces: management first, what uses each interface, and the editor on management', () => {
    const t = text(render('interfaces'));
    const mgmt = t.indexOf('management (built in) 99 192.168.99.5 255.255.255.0 192.168.99.1 — no WLAN');
    const staff = t.indexOf('STAFF-IF 20 192.168.20.5 255.255.255.0 192.168.20.1 192.168.20.1 WLAN 1');
    expect(mgmt).toBeGreaterThan(-1);
    expect(staff).toBeGreaterThan(mgmt);
    expect(t).toContain('Interface management');
    expect(t).toContain('it is also the default gateway of the controller');
    expect(t).toContain('+ Add an interface');
    expect(t).toContain('Save the interface');
    const html = render('interfaces');
    // management cannot be removed; STAFF-IF is used by WLAN 1, so its Remove is disabled with the reason in the table
    expect(html).not.toContain('aria-label="Remove the interface management"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Remove the interface STAFF-IF"/);
    expect(html).toContain('value="192.168.99.5"');
  });

  it('WLANs: the list and the editor on the first WLAN, which keeps its stored passphrase', () => {
    const t = text(render('wlans'));
    expect(t).toContain('1 STAFF LabNet WPA2 personal STAFF-IF Every radio ● yes');
    expect(t).toContain('WLAN 1');
    expect(t).toContain('A passphrase is stored; leave this empty to keep it.');
    expect(t).toContain('+ Add a WLAN');
    const html = render('wlans');
    expect(html).toContain('type="password"');
    expect(html).not.toContain('lab-passphrase');
    expect(html).toMatch(/<option value="STAFF-IF" selected="">STAFF-IF \(VLAN 20\)<\/option>/);
  });

  it('WLANs: a controller without WLANs opens a new one on the management interface', () => {
    const bare = { ...WLC, runningConfig: WLC.runningConfig.replace(/wlan 1 STAFF LabNet[\s\S]*?!\n/, '') };
    expect(wlanFormsFrom(bare.runningConfig)).toEqual([]);
    const t = text(render('wlans', bare));
    expect(t).toContain('No WLAN yet');
    expect(t).toContain('New WLAN');
    expect(t).toContain('Create the WLAN');
    expect(render('wlans', bare)).toContain('value="1"');
  });

  it('Clients: each client with its access point, WLAN, VLAN and interface', () => {
    const t = text(render('clients'));
    expect(t).toContain('02:00:00:00:0c:01 LAP1 1 (LabNet) 20 STAFF-IF ● connected');
    const none = { ...WLC, tables: { cam: [], arp: [], rib: [] } };
    expect(text(render('clients', none))).toContain('No wireless client is connected.');
  });

  it('refuses to apply while the controller is off', () => {
    const t = text(render('interfaces', { ...WLC, power: false }));
    expect(t).toContain('The device is powered off.');
  });
});

// ── routing ──────────────────────────────────────────────────────────────────

describe('the wlc.controller panel routes to its tab', () => {
  it('the controller shows a Controller tab hosting the panel', () => {
    expect(WLC.gui).toContain('wlc.controller');
    expect(inspectorTabsFor(WLC)).toContain('wireless');
    expect(panelsForTab(WLC, 'wireless')).toEqual(['wlc.controller']);
    expect(inspectorTabLabel('wireless', WLC)).toBe('Controller');
  });

  it('its default surface and the panel open that tab; a console is refused with a pointer to it', async () => {
    const { resolveDeviceSurface } = await import('../src/shared/openDeviceSurface');
    expect(resolveDeviceSurface(WLC, 'default')).toEqual({ kind: 'tab', tab: 'wireless' });
    expect(resolveDeviceSurface(WLC, 'wlc.controller')).toEqual({ kind: 'tab', tab: 'wireless' });
    const refused = resolveDeviceSurface(WLC, 'console');
    expect(refused.kind).toBe('unavailable');
    expect(refused.kind === 'unavailable' ? refused.reason : '').toContain('Its settings are under Controller in the inspector.');
  });

  it('the settings panel of a device skips the Physical hardware view unless it is the only one', async () => {
    const { resolveDeviceSurface, settingsPanelOf } = await import('../src/shared/openDeviceSurface');
    expect(settingsPanelOf(WLC)).toBe('wlc.controller');
    expect(settingsPanelOf({ gui: ['physical', 'home-router.setup'] })).toBe('home-router.setup');
    expect(settingsPanelOf({ gui: ['physical'] })).toBe('physical');
    expect(settingsPanelOf({ gui: ['desktop.ip-config'] })).toBeUndefined();
    const home = { name: 'HOME1', cli: { shell: 'none', grammar: 'nfos' }, gui: ['physical', 'home-router.setup'] } as const;
    expect(resolveDeviceSurface(home as never, 'default')).toEqual({ kind: 'tab', tab: 'wireless' });
    const hub = { name: 'HUB1', cli: { shell: 'none', grammar: 'nfos' }, gui: ['physical'] } as const;
    expect(resolveDeviceSurface(hub as never, 'default')).toEqual({ kind: 'tab', tab: 'physical' });
  });
});
