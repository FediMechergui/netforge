// Settings panels (ARCHITECTURE-P1 D9, §3.7, §3.8, §3.12, §6, §7, §8.1 W6 web-inspector): the access point, home
// router, point-to-point radio and tower panels submit canonical lines through `configure` (mocked engine), map
// per-line errors back onto their form fields, and the lines they build are accepted by the real device grammar.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createSimulation } from '@netforge/engine';
import type { ConfigureOptions, ConfigureResult, DeviceSnapshot, LinkSnapshot, RadioPortSpec, Simulation } from '@netforge/engine';

vi.mock('../src/bridge/client', () => ({ engine: {} }));
// A plain selector store: server rendering reads the current state (zustand would read its initial state there).
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = { catalog: [], snapshot: null, snapshotIndex: undefined };
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
  });
  return { useStore, store: useStore };
});

import { useStore } from '../src/store/store';
import {
  MSG_CONFIGURE_FAILED,
  MSG_CONFIGURE_UNAVAILABLE,
  WirelessPanel,
  accessRadioPorts,
  appliedFormState,
  applyWirelessSettings,
  clearedRadioSecrets,
  initialFormState,
  radioSpecsOf,
  rateText,
  submitPlan,
  syncFormState,
  widthsFor,
  withBand,
  wirelessPanelPlan,
} from '../src/inspector/WirelessPanel';
import {
  DHCP_LATER_NOTE,
  HomeRouterPanel,
  appliedHomeRouterForm,
  applyHomeRouterSettings,
  homeRouterPanelFormFrom,
  homeRouterPanelPlan,
  suggestedDhcpPool,
} from '../src/inspector/HomeRouterPanel';
import type { HomeRouterPanelForm } from '../src/inspector/HomeRouterPanel';
import {
  MSG_DISTANCE_FAILED,
  MSG_LINK_LOST,
  RadioLinkPanel,
  appliedRadioLinkForm,
  applyRadioLinkSettings,
  checkDistance,
  ptpRadioPorts,
  radioLinkPanelFormFrom,
  relaidLinkSpec,
} from '../src/inspector/RadioLinkPanel';
import type { RadioLinkApi, RadioLinkPanelForm } from '../src/inspector/RadioLinkPanel';
import {
  CellTowerPanel,
  applyCellTowerSettings,
  backhaulPorts,
  cellTowerPanelFormFrom,
  cellTowerPanelPlan,
  towerRadioPorts,
} from '../src/inspector/CellTowerPanel';
import { wirelessApFormFrom } from '../src/gui/forms';
import type { WirelessApForm } from '../src/gui/forms';

// ── fixtures ─────────────────────────────────────────────────────────────────

function lab(): Simulation {
  const sim = createSimulation({ seed: 11 });
  sim.addDevice({ id: 'ap', type: 'ap.nfap-auto', name: 'AP1', position: { x: 0, y: 0 } });
  sim.addDevice({ id: 'home', type: 'wrouter.nfhome', name: 'HOME1', position: { x: 0, y: 200 } });
  sim.addDevice({ id: 'r1', type: 'radio.nfptp5', name: 'RADIO1', position: { x: 0, y: 400 } });
  sim.addDevice({ id: 'r2', type: 'radio.nfptp5', name: 'RADIO2', position: { x: 400, y: 400 } });
  sim.addDevice({ id: 'tower', type: 'cell.nftower', name: 'TOWER1', position: { x: 0, y: 800 } });
  sim.addLink({ id: 'l_radio', a: { device: 'r1', port: 'Radio0' }, b: { device: 'r2', port: 'Radio0' }, media: 'radio', kind: 'radio' });
  sim.runToIdle();
  return sim;
}

function device(sim: Simulation, id: string): DeviceSnapshot {
  const d = sim.snapshot().devices.find((x) => x.id === id);
  if (d === undefined) throw new Error(`no device ${id}`);
  return d;
}

function link(sim: Simulation, id: string): LinkSnapshot {
  const l = sim.snapshot().links.find((x) => x.id === id);
  if (l === undefined) throw new Error(`no link ${id}`);
  return l;
}

interface ConfigureCall {
  device: string;
  commands: string[];
  opts: ConfigureOptions | undefined;
}

/** A configure result where every line succeeded, or line `fail` failed at `column` (the rest skipped). */
function result(commands: readonly string[], fail?: { index: number; message: string; column?: number }): ConfigureResult {
  const lines = commands.map((line, index) => {
    if (fail === undefined || index < fail.index) return { index, line, ok: true, output: '', mode: 'config' as const };
    if (index === fail.index) {
      return { index, line, ok: false, output: '', mode: 'config' as const, error: { message: fail.message, ...(fail.column !== undefined ? { column: fail.column } : {}) } };
    }
    return { index, line, ok: false, output: '', mode: 'config' as const, skipped: true };
  });
  return { ok: fail === undefined, lines, applied: fail === undefined ? commands.length : 0, reverted: fail !== undefined, finalMode: 'config' } as ConfigureResult;
}

/** Mocked engine: records configure calls and answers with `answer`. */
function mockEngine(answer: (commands: readonly string[]) => ConfigureResult = (c) => result(c)) {
  const calls: ConfigureCall[] = [];
  const order: string[] = [];
  const api = {
    configure: vi.fn(async (dev: string, commands: string[], opts?: ConfigureOptions) => {
      calls.push({ device: dev, commands: [...commands], opts });
      order.push('configure');
      return answer(commands);
    }),
    addLink: vi.fn(async () => {
      order.push('addLink');
      return 'l_radio';
    }),
    removeLink: vi.fn(async () => {
      order.push('removeLink');
    }),
  };
  return { api, calls, order };
}

/** The real simulation behind the EngineApi surface the panels use. */
function realEngine(sim: Simulation): RadioLinkApi {
  return {
    configure: async (dev, commands, opts) => sim.configure(dev, commands, opts),
    addLink: async (spec) => sim.addLink(spec),
    removeLink: async (id) => sim.removeLink(id),
  };
}

const PANEL_OPTS = { indentation: true, stopOnError: true, atomic: true };

// ── access point ─────────────────────────────────────────────────────────────

describe('WirelessPanel', () => {
  let sim: Simulation;
  let ap: DeviceSnapshot;
  let baseline: WirelessApForm[];
  let specs: Readonly<Record<string, RadioPortSpec>>;

  beforeEach(() => {
    sim = lab();
    ap = device(sim, 'ap');
    baseline = accessRadioPorts(ap).map((p) => wirelessApFormFrom(ap, p.id));
    specs = radioSpecsOf(sim.catalog.list(), ap.type, ['Wlan0', 'Wlan1']);
  });

  it('lists the access radios and their catalog specs', () => {
    expect(accessRadioPorts(ap).map((p) => p.id)).toEqual(['Wlan0', 'Wlan1']);
    expect(Object.keys(specs)).toEqual(['Wlan0', 'Wlan1']);
  });

  it('sends only the changed lines of the changed radio, indented and atomic', async () => {
    const { api, calls } = mockEngine();
    const draft = baseline.map((r, i) => (i === 0 ? { ...r, ssid: 'LAB NET', security: 'wpa2-psk' as const, passphrase: 'labpass123', channel: '6' } : r));
    const out = await applyWirelessSettings(api, 'ap', draft, baseline, specs);
    expect(calls).toEqual([
      {
        device: 'ap',
        commands: ['interface Wlan0', ' channel 6', ' ssid LAB NET', ' security wpa2-psk', ' passphrase labpass123'],
        opts: PANEL_OPTS,
      },
    ]);
    expect(out.outcome).toMatchObject({ ok: true, reverted: false, fieldErrors: {}, general: [] });
    expect(out.sent).toEqual(calls[0]?.commands);
  });

  it('sends automatic channel and radio off in a safe order', () => {
    const draft = baseline.map((r, i) => (i === 1 ? { ...r, enabled: false, channel: 'auto', txPowerDbm: '15' } : r));
    expect(wirelessPanelPlan(draft, baseline).commands).toEqual(['interface Wlan1', ' shutdown', ' channel auto', ' tx-power 15']);
  });

  it('maps a refused line back to the field of the token under the caret', async () => {
    const { api } = mockEngine((c) => result(c, { index: 2, message: '% Expected a whole number between 0 and 40 at the marked position.', column: 9 }));
    const draft = baseline.map((r, i) => (i === 1 ? { ...r, channel: '40', txPowerDbm: '18' } : r));
    const out = await applyWirelessSettings(api, 'ap', draft, baseline, specs);
    expect(out.outcome?.ok).toBe(false);
    expect(out.outcome?.reverted).toBe(true);
    expect(out.outcome?.fieldErrors).toEqual({ 'radios.1.txPowerDbm': 'Expected a whole number between 0 and 40 at the marked position.' });
  });

  it('sends nothing while a field is invalid, or when nothing changed', async () => {
    const { api } = mockEngine();
    const bad = baseline.map((r, i) => (i === 0 ? { ...r, security: 'wpa3-sae' as const, passphrase: 'short' } : r));
    const invalid = await applyWirelessSettings(api, 'ap', bad, baseline, specs);
    expect(invalid.sent).toBeNull();
    expect(Object.keys(invalid.clientErrors)).toEqual(['radios.0.passphrase']);
    const wrongChannel = await applyWirelessSettings(api, 'ap', baseline.map((r) => ({ ...r, channel: '14' })), baseline, specs);
    expect(Object.keys(wrongChannel.clientErrors)).toEqual(['radios.0.channel', 'radios.1.channel']);
    const same = await applyWirelessSettings(api, 'ap', baseline, baseline, specs);
    expect(same).toMatchObject({ sent: null, outcome: null, clientErrors: {} });
    expect(api.configure).not.toHaveBeenCalled();
  });

  it('turns bridge failures into messages instead of exceptions', async () => {
    const plan = wirelessPanelPlan(baseline.map((r) => ({ ...r, ssid: 'X' })), baseline);
    const missing = await submitPlan({} as never, 'ap', plan);
    expect(missing?.general).toEqual([MSG_CONFIGURE_UNAVAILABLE]);
    const failing = await submitPlan({ configure: async () => Promise.reject(new Error('No device "ap".')) }, 'ap', plan);
    expect(failing).toMatchObject({ ok: false, general: [`${MSG_CONFIGURE_FAILED} No device "ap".`] });
    expect(await submitPlan({ configure: async () => result([]) }, 'ap', wirelessPanelPlan(baseline, baseline))).toBeNull();
  });

  it('builds lines the real access point accepts, and the snapshot reads them back', async () => {
    const draft = baseline.map((r, i) => (i === 0 ? { ...r, ssid: 'LAB NET', security: 'wpa2-psk' as const, passphrase: 'labpass123', channel: 'auto', widthMhz: '40' } : r));
    const out = await applyWirelessSettings(realEngine(sim), 'ap', draft, baseline, specs);
    expect(out.outcome).toMatchObject({ ok: true });
    const after = wirelessApFormFrom(device(sim, 'ap'), 'Wlan0');
    expect(after).toMatchObject({ ssid: 'LAB NET', security: 'wpa2-psk', hasPassphrase: true, passphrase: '', channel: 'auto', widthMhz: '40' });
    expect(clearedRadioSecrets(draft[0] as WirelessApForm)).toEqual({ ...draft[0], passphrase: '', hasPassphrase: true });
  });

  it('keeps channel and width meaningful across band changes', () => {
    const spec = specs.Wlan1;
    const five = { ...(baseline[1] as WirelessApForm), channel: '36', widthMhz: '80' };
    expect(withBand(five, '2.4', spec)).toMatchObject({ band: '2.4', channel: '1', widthMhz: '20' });
    expect(withBand({ ...five, channel: 'auto' }, '2.4', spec).channel).toBe('auto');
    expect(widthsFor('2.4', spec)).toEqual([20, 40]);
    expect(widthsFor('60', spec)).toEqual([]);
    expect(rateText(173_400_000)).toBe('173.4 Mb/s');
    expect(rateText(undefined)).toBe('—');
  });
});

// ── form state ───────────────────────────────────────────────────────────────

describe('settings form state', () => {
  const live = (v: string) => ({ value: { ssid: v }, key: JSON.stringify({ ssid: v }) });

  it('follows the device while clean and holds an edited draft', () => {
    const s0 = initialFormState(live('A'), 'ap|Wlan0');
    const s1 = syncFormState(s0, live('B'), 'ap|Wlan0');
    expect(s1.draft).toEqual({ ssid: 'B' });
    const edited = { ...s1, draft: { ssid: 'mine' }, dirty: true };
    const s2 = syncFormState(edited, live('C'), 'ap|Wlan0');
    expect(s2.draft).toEqual({ ssid: 'mine' });
    expect(s2.baselineKey).not.toBe(live('C').key);
    expect(syncFormState(edited, live('C'), 'ap2|Wlan0')).toMatchObject({ draft: { ssid: 'C' }, dirty: false, resetKey: 'ap2|Wlan0' });
  });

  it('after Apply shows the device values when they already arrived, else the applied values until they do', () => {
    const edited = { ...initialFormState(live('A'), 'k'), draft: { ssid: 'B ' }, dirty: true };
    const arrived = appliedFormState(edited, { ssid: 'B ' }, live('B'));
    expect(arrived).toMatchObject({ draft: { ssid: 'B' }, dirty: false, baselineKey: live('B').key });
    const pending = appliedFormState(edited, { ssid: 'B ' }, live('A'));
    expect(pending).toMatchObject({ draft: { ssid: 'B ' }, baseline: { ssid: 'B ' }, dirty: false, baselineKey: live('A').key });
    expect(syncFormState(pending, live('B'), 'k').draft).toEqual({ ssid: 'B' });
  });
});

// ── home router ──────────────────────────────────────────────────────────────

describe('HomeRouterPanel', () => {
  let sim: Simulation;
  let home: DeviceSnapshot;
  let baseline: HomeRouterPanelForm;
  let specs: Readonly<Record<string, RadioPortSpec>>;

  beforeEach(() => {
    sim = lab();
    home = device(sim, 'home');
    baseline = homeRouterPanelFormFrom(home);
    specs = radioSpecsOf(sim.catalog.list(), home.type, ['Wlan0', 'Wlan1']);
  });

  it('reads the LAN interface, the internet port and both radios', () => {
    expect(baseline.lan.port).toBe('Vlan1');
    expect(baseline.wan.port).toBe('Internet');
    expect(baseline.wanMode).toBe('none');
    expect(baseline.radios.map((r) => r.port)).toEqual(['Wlan0', 'Wlan1']);
  });

  it('sends LAN addressing, a fixed internet address with its default route and a radio in one call', async () => {
    const { api, calls } = mockEngine();
    const draft: HomeRouterPanelForm = {
      ...baseline,
      lan: { ...baseline.lan, address: '192.168.1.1', mask: '/24' },
      wanMode: 'static',
      wan: { ...baseline.wan, address: '203.0.113.2', mask: '255.255.255.252', gateway: '203.0.113.1' },
      radios: baseline.radios.map((r, i) => (i === 0 ? { ...r, ssid: 'HOME', security: 'wpa2-psk' as const, passphrase: 'homepass1' } : r)),
    };
    const out = await applyHomeRouterSettings(api, 'home', draft, baseline, specs);
    expect(out.clientErrors).toEqual({});
    expect(calls[0]?.commands).toEqual([
      'interface Vlan1',
      ' ip address 192.168.1.1 255.255.255.0',
      'interface Internet',
      ' ip address 203.0.113.2 255.255.255.252',
      'ip route 0.0.0.0 0.0.0.0 203.0.113.1',
      'interface Wlan0',
      ' ssid HOME',
      ' security wpa2-psk',
      ' passphrase homepass1',
    ]);
    expect(calls[0]?.opts).toEqual(PANEL_OPTS);

    // The same lines on the real router, then "not connected" removes the address and the route again.
    const real = await applyHomeRouterSettings(realEngine(sim), 'home', draft, baseline, specs);
    expect(real.outcome).toMatchObject({ ok: true });
    const stored = homeRouterPanelFormFrom(device(sim, 'home'));
    expect(stored).toMatchObject({ wanMode: 'static', lan: { address: '192.168.1.1', mask: '255.255.255.0' }, wan: { gateway: '203.0.113.1' } });
    expect(stored.radios[0]).toMatchObject({ ssid: 'HOME', hasPassphrase: true });
    const unplug = { ...stored, wanMode: 'none' as const };
    expect(homeRouterPanelPlan(unplug, stored).commands).toEqual(['interface Internet', ' no ip address', 'no ip route 0.0.0.0 0.0.0.0 203.0.113.1']);
    const cleared = await applyHomeRouterSettings(realEngine(sim), 'home', unplug, stored, specs);
    expect(cleared.outcome).toMatchObject({ ok: true });
    expect(homeRouterPanelFormFrom(device(sim, 'home'))).toMatchObject({ wanMode: 'none', wan: { address: '', gateway: '' } });
    expect(appliedHomeRouterForm(unplug).wan).toEqual({ port: 'Internet', address: '', mask: '', gateway: '' });
  });

  it('lets a fresh router set up Wi-Fi first, but never removes the LAN address', async () => {
    const { api } = mockEngine();
    const wifiOnly = { ...baseline, radios: baseline.radios.map((r, i) => (i === 1 ? { ...r, ssid: 'FAST' } : r)) };
    const out = await applyHomeRouterSettings(api, 'home', wifiOnly, baseline, specs);
    expect(out.sent).toEqual(['interface Wlan1', ' ssid FAST']);
    const withLan = { ...baseline, lan: { ...baseline.lan, address: '10.0.0.1', mask: '24' } };
    const removed = await applyHomeRouterSettings(api, 'home', baseline, withLan, specs);
    expect(removed.sent).toBeNull();
    expect(removed.clientErrors['lan.address']).toBe('The local network needs an address.');
  });

  it('refuses automatic internet addressing until P1 and asks for a complete fixed address', async () => {
    const { api } = mockEngine();
    const dhcp = await applyHomeRouterSettings(api, 'home', { ...baseline, wanMode: 'dhcp' }, baseline, specs);
    expect(dhcp.sent).toBeNull();
    expect(dhcp.clientErrors['wan.address']).toMatch(/not available in this release/);
    const partial = await applyHomeRouterSettings(api, 'home', { ...baseline, wanMode: 'static', wan: { ...baseline.wan, address: '198.51.100.7' } }, baseline, specs);
    expect(partial.clientErrors).toMatchObject({ 'wan.mask': expect.any(String) });
    const badGateway = await applyHomeRouterSettings(
      api,
      'home',
      { ...baseline, wanMode: 'static', wan: { ...baseline.wan, address: '198.51.100.7', mask: '/24', gateway: '10.9.9.9' } },
      baseline,
      specs,
    );
    expect(badGateway.clientErrors['wan.gateway']).toBe('The gateway must be in the same subnet as the address.');
    expect(api.configure).not.toHaveBeenCalled();
  });

  it('puts router errors on the LAN, WAN and radio fields', async () => {
    const draft: HomeRouterPanelForm = {
      ...baseline,
      lan: { ...baseline.lan, address: '192.168.1.1', mask: '255.255.255.0' },
      radios: baseline.radios.map((r, i) => (i === 1 ? { ...r, ssid: 'FAST' } : r)),
    };
    const { api } = mockEngine((c) => result(c, { index: 3, message: '% This network name is already used by another radio.', column: 1 }));
    const out = await applyHomeRouterSettings(api, 'home', draft, baseline, specs);
    expect(out.sent).toEqual(['interface Vlan1', ' ip address 192.168.1.1 255.255.255.0', 'interface Wlan1', ' ssid FAST']);
    expect(out.outcome?.fieldErrors).toEqual({ 'radios.1.ssid': 'This network name is already used by another radio.' });
    const lanFail = mockEngine((c) => result(c, { index: 1, message: '% Bad mask', column: 23 }));
    const lan = await applyHomeRouterSettings(lanFail.api, 'home', draft, baseline, specs);
    expect(lan.outcome?.fieldErrors).toEqual({ 'lan.mask': 'Bad mask' });
    expect(lan.outcome?.skipped).toBe(2);
  });

  it('plans the DHCP address pool from the LAN subnet (behaviour arrives in P1)', () => {
    expect(suggestedDhcpPool('192.168.1.1', '255.255.255.0')).toEqual({ start: '192.168.1.100', end: '192.168.1.199', size: 100 });
    expect(suggestedDhcpPool('192.168.1.150', '/24')).toEqual({ start: '192.168.1.100', end: '192.168.1.199', size: 99 });
    expect(suggestedDhcpPool('10.0.0.1', '/29')).toEqual({ start: '10.0.0.2', end: '10.0.0.6', size: 5 });
    expect(suggestedDhcpPool('10.0.0.1', '/31')).toBeUndefined();
    expect(suggestedDhcpPool('nope', '/24')).toBeUndefined();
    expect(DHCP_LATER_NOTE).toMatch(/next stage/);
  });
});

// ── point-to-point radio ─────────────────────────────────────────────────────

describe('RadioLinkPanel', () => {
  let sim: Simulation;
  let r1: DeviceSnapshot;
  let l: LinkSnapshot;
  let baseline: RadioLinkPanelForm;
  let spec: RadioPortSpec | undefined;

  beforeEach(() => {
    sim = lab();
    r1 = device(sim, 'r1');
    l = link(sim, 'l_radio');
    baseline = radioLinkPanelFormFrom(r1, 'Radio0', l);
    spec = radioSpecsOf(sim.catalog.list(), r1.type, ['Radio0']).Radio0;
  });

  it('reads the radio and its link', () => {
    expect(ptpRadioPorts(r1).map((p) => p.id)).toEqual(['Radio0']);
    expect(baseline).toMatchObject({ port: 'Radio0', band: '5', channel: '149', hasPeerKey: false, distanceM: '' });
    expect(l.radio?.distanceSource).toBe('canvas');
  });

  it('sends channel, power and pairing key lines', async () => {
    const { api, calls, order } = mockEngine();
    const draft = { ...baseline, channel: '157', txPowerDbm: '20', peerKey: 'shared key' };
    const out = await applyRadioLinkSettings(api, 'r1', draft, baseline, spec, l);
    expect(calls).toEqual([
      { device: 'r1', commands: ['interface Radio0', ' channel 157', ' tx-power 20', ' peer-key shared key'], opts: PANEL_OPTS },
    ]);
    expect(order).toEqual(['configure']);
    expect(out.outcome?.ok).toBe(true);
    expect(appliedRadioLinkForm(draft)).toMatchObject({ peerKey: '', hasPeerKey: true });
  });

  it('checks the key, the channel and the distance before sending', async () => {
    const { api } = mockEngine();
    const out = await applyRadioLinkSettings(api, 'r1', { ...baseline, peerKey: 'abc', channel: 'auto', distanceM: '12 km' }, baseline, spec, l);
    expect(out.sent).toBeNull();
    expect(Object.keys(out.clientErrors).sort()).toEqual(['channel', 'distanceM', 'peerKey']);
    expect(checkDistance('100001')).toMatch(/at most 100000 m/);
    expect(checkDistance('2500.5')).toBeUndefined();
    expect(checkDistance('')).toBeUndefined();
    const unlinked = await applyRadioLinkSettings(api, 'r1', { ...baseline, distanceM: '500' }, baseline, spec, undefined);
    expect(unlinked.clientErrors.distanceM).toMatch(/Connect this radio/);
    expect(api.configure).not.toHaveBeenCalled();
  });

  it('maps a device refusal onto the pairing key and does not touch the link', async () => {
    const { api, order } = mockEngine((c) => result(c, { index: 1, message: '% A pairing key has 4 to 64 printable characters.' }));
    const out = await applyRadioLinkSettings(api, 'r1', { ...baseline, peerKey: 'k'.repeat(40), distanceM: '900' }, baseline, spec, l);
    expect(out.outcome?.fieldErrors).toEqual({ peerKey: 'A pairing key has 4 to 64 printable characters.' });
    expect(order).toEqual(['configure']);
  });

  it('lays the link again for a new distance, after the radio lines', async () => {
    const { api, order } = mockEngine();
    const out = await applyRadioLinkSettings(api, 'r1', { ...baseline, channel: '153', distanceM: '10000' }, baseline, spec, l);
    expect(order).toEqual(['configure', 'removeLink', 'addLink']);
    expect(api.removeLink).toHaveBeenCalledWith('l_radio');
    expect(api.addLink).toHaveBeenCalledWith({
      id: 'l_radio',
      a: { device: 'r1', port: 'Radio0' },
      b: { device: 'r2', port: 'Radio0' },
      media: 'radio',
      lengthM: 3,
      impairments: { lossPct: 0, latencyNs: 0, jitterNs: 0, corruptPct: 0 },
      kind: 'radio',
      distanceOverrideM: 10000,
    });
    expect(out.outcome?.ok).toBe(true);

    const distanceOnly = mockEngine();
    const only = await applyRadioLinkSettings(distanceOnly.api, 'r1', { ...baseline, distanceM: '250' }, baseline, spec, l);
    expect(distanceOnly.order).toEqual(['removeLink', 'addLink']);
    expect(only.sent).toEqual([]);
    expect(only.outcome?.ok).toBe(true);
    expect(relaidLinkSpec({ ...l, distanceOverrideM: 250 }, undefined).distanceOverrideM).toBeUndefined();
  });

  it('restores the original link when the new one is refused', async () => {
    const { api } = mockEngine();
    api.addLink.mockRejectedValueOnce(new Error('refused'));
    const out = await applyRadioLinkSettings(api, 'r1', { ...baseline, distanceM: '400' }, baseline, spec, l);
    expect(api.addLink).toHaveBeenCalledTimes(2);
    expect(api.addLink.mock.calls[1]).toEqual([relaidLinkSpec(l, undefined)]);
    expect(out.outcome).toMatchObject({ ok: false, fieldErrors: { distanceM: `${MSG_DISTANCE_FAILED} refused` } });

    const lost = mockEngine();
    lost.api.addLink.mockRejectedValue(new Error('gone'));
    const worse = await applyRadioLinkSettings(lost.api, 'r1', { ...baseline, channel: '153', distanceM: '400' }, baseline, spec, l);
    expect(worse.outcome?.fieldErrors.distanceM).toBe(`${MSG_DISTANCE_FAILED} gone ${MSG_LINK_LOST}`);
    expect(worse.outcome?.general).toEqual(['The radio settings were kept; only the distance is unchanged.']);
  });

  it('drives the real link: a key mismatch, then an override distance out of range', async () => {
    const engine = realEngine(sim);
    const keyed = await applyRadioLinkSettings(engine, 'r1', { ...baseline, peerKey: 'alpha-key' }, baseline, spec, l);
    expect(keyed.outcome?.ok).toBe(true);
    sim.runToIdle();
    expect(link(sim, 'l_radio')).toMatchObject({ up: false, downReason: 'radio-key-mismatch' });
    const r2 = device(sim, 'r2');
    const r2Base = radioLinkPanelFormFrom(r2, 'Radio0', link(sim, 'l_radio'));
    expect((await applyRadioLinkSettings(engine, 'r2', { ...r2Base, peerKey: 'alpha-key' }, r2Base, spec, link(sim, 'l_radio'))).outcome?.ok).toBe(true);
    sim.runToIdle();
    expect(link(sim, 'l_radio').up).toBe(true);

    const now = radioLinkPanelFormFrom(device(sim, 'r1'), 'Radio0', link(sim, 'l_radio'));
    expect(now.hasPeerKey).toBe(true);
    const far = await applyRadioLinkSettings(engine, 'r1', { ...now, distanceM: '20000' }, now, spec, link(sim, 'l_radio'));
    expect(far.outcome?.ok).toBe(true);
    sim.runToIdle();
    const relaid = link(sim, 'l_radio');
    expect(relaid).toMatchObject({ distanceOverrideM: 20000, up: false, downReason: 'out-of-range' });
    expect(radioLinkPanelFormFrom(device(sim, 'r1'), 'Radio0', relaid).distanceM).toBe('20000');
  });
});

// ── tower ────────────────────────────────────────────────────────────────────

describe('CellTowerPanel', () => {
  let sim: Simulation;
  let tower: DeviceSnapshot;

  beforeEach(() => {
    sim = lab();
    tower = device(sim, 'tower');
  });

  it('reads the tower radio and the backhaul', () => {
    expect(towerRadioPorts(tower).map((p) => p.id)).toEqual(['Cellular0']);
    expect(backhaulPorts(tower).map((p) => p.id)).toEqual(['GigabitEthernet0']);
    expect(cellTowerPanelFormFrom(tower)).toEqual({
      radios: [{ port: 'Cellular0', enabled: true, txPowerDbm: '43' }],
      backhaul: [{ port: 'GigabitEthernet0', enabled: true }],
    });
  });

  it('turns the radio off before the backhaul and on after it, never sending a power line', async () => {
    const base = cellTowerPanelFormFrom(tower);
    const off = { radios: [{ port: 'Cellular0', enabled: false, txPowerDbm: '10' }], backhaul: [{ port: 'GigabitEthernet0', enabled: false }] };
    expect(cellTowerPanelPlan(off, base).commands).toEqual(['interface Cellular0', ' shutdown', 'interface GigabitEthernet0', ' shutdown']);
    const on = cellTowerPanelPlan(base, off);
    expect(on.commands).toEqual(['interface GigabitEthernet0', ' no shutdown', 'interface Cellular0', ' no shutdown']);

    const { api, calls } = mockEngine((c) => result(c, { index: 3, message: '% Refused', column: 1 }));
    const out = await applyCellTowerSettings(api, 'tower', base, off);
    expect(calls[0]).toEqual({ device: 'tower', commands: on.commands, opts: PANEL_OPTS });
    expect(out.outcome?.fieldErrors).toEqual({ 'radios.0.enabled': 'Refused' });
    const gone = await applyCellTowerSettings(api, 'tower', { ...base, radios: [{ port: 'Cellular9', enabled: true, txPowerDbm: '' }] }, base);
    expect(gone.sent).toBeNull();
    expect(Object.keys(gone.clientErrors)).toEqual(['radios.0.enabled']);
    const backhaulFail = mockEngine((c) => result(c, { index: 1, message: '% Refused' }));
    expect((await applyCellTowerSettings(backhaulFail.api, 'tower', base, off)).outcome?.fieldErrors).toEqual({ 'backhaul.0.enabled': 'Refused' });
  });

  it('switches the real tower radio off and on', async () => {
    const base = cellTowerPanelFormFrom(tower);
    const off = { ...base, radios: base.radios.map((r) => ({ ...r, enabled: false })) };
    expect((await applyCellTowerSettings(realEngine(sim), 'tower', off, base)).outcome?.ok).toBe(true);
    expect(cellTowerPanelFormFrom(device(sim, 'tower')).radios[0]?.enabled).toBe(false);
    const back = cellTowerPanelFormFrom(device(sim, 'tower'));
    expect((await applyCellTowerSettings(realEngine(sim), 'tower', base, back)).outcome?.ok).toBe(true);
    expect(device(sim, 'tower').ports.find((p) => p.id === 'Cellular0')?.adminUp).toBe(true);
  });
});

// ── rendering ────────────────────────────────────────────────────────────────

describe('panel rendering', () => {
  it('renders every panel with labelled inputs and text states', () => {
    const sim = lab();
    const snapshot = sim.snapshot();
    useStore.setState({ catalog: [...sim.catalog.list()], snapshot } as never);
    const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

    const ap = html(createElement(WirelessPanel, { device: device(sim, 'ap') }));
    expect(ap).toContain('Network name (SSID)');
    expect(ap).toContain('Automatic (quietest channel)');
    expect(ap).toContain('No wireless clients are connected to this radio.');

    const home = html(createElement(HomeRouterPanel, { device: device(sim, 'home') }));
    expect(home).toContain('Local network');
    expect(home).toContain('Automatic from the provider (DHCP)');
    expect(home).toContain('next stage');
    expect(home).toContain('192.168.1.1');

    const radio = html(createElement(RadioLinkPanel, { device: device(sim, 'r1') }));
    expect(radio).toContain('Pairing key');
    expect(radio).toContain('RADIO2');
    expect(radio).toContain('measured on the canvas');
    expect(radio).toContain('4 of 4 bars');

    const towerHtml = html(createElement(CellTowerPanel, { device: device(sim, 'tower') }));
    expect(towerHtml).toContain('fixed by the tower hardware');
    expect(towerHtml).toContain('No phone or tablet is attached to this radio.');
    expect(towerHtml).toContain('GigabitEthernet0');

    expect(html(createElement(RadioLinkPanel, { device: device(sim, 'ap') }))).toContain('no point-to-point radio');
    sim.setPower('ap', false);
    expect(html(createElement(WirelessPanel, { device: device(sim, 'ap') }))).toContain('The device is powered off.');
  });
});
