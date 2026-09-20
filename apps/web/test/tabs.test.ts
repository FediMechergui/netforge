// Inspector derivations (ARCHITECTURE-P1 §7 "Inspector", §8.1 W6 web-inspector, §9.3, D2, D7): tabs from
// DeviceModel.gui and capabilities clamped to overview, table sections, port and console gates, module slot rules and
// wording, association phase ladder, MCS identification, O(1) lookups, generic extra tables and the slot actions.
import { describe, expect, it, vi } from 'vitest';
import {
  ALL_MODELS,
  ALL_MODULES,
  CLI_MESSAGES,
  HARDWARE_MESSAGES,
  MCS_TABLES,
  createSimulation,
  emptyCounters,
  homeWifi,
  mcsRateBps,
} from '@netforge/engine';
import type { DeviceSnapshot, HardwareResult, LinkSnapshot, PortSnapshot, SimSnapshot, Simulation } from '@netforge/engine';
import {
  CELL_PHASES,
  INSPECTOR_TAB_ORDER,
  LEGACY_INSPECTOR_TABS,
  SLOT_TYPE_NAMES,
  WIFI_PHASES,
  assocPhaseSteps,
  associationById,
  associationOfStation,
  associationsOfDevice,
  catalogModel,
  clampInspectorTab,
  consoleAvailability,
  deviceById,
  deviceTablePresence,
  formatDistance,
  formatMcs,
  hardwareMessage,
  hardwareResultText,
  holdRemainingNs,
  identifyMcs,
  inspectorTabLabel,
  inspectorTabsFor,
  isDataPort,
  linkById,
  modulePortSummary,
  modulePowerGate,
  moduleModel,
  modulesForSlot,
  panelsForTab,
  portToggleState,
  slotById,
  slotCableCount,
  slotPorts,
  stepInspectorTab,
  tableSectionsFor,
} from '../src/inspector/tabs';
import { MSG_MODULES_UNAVAILABLE, applyModuleChange, moduleName, portGroups, slotMessageValues, withArticle } from '../src/inspector/ModulesPanel';
import { genericColumns, genericRows } from '../src/inspector/TablesView';
import { linkStateText, linkTitle } from '../src/inspector/LinkInspector';
import type { InspectorTab } from '../src/store/types';

// ── fixtures ─────────────────────────────────────────────────────────────────

/** One powered, booted instance of every catalog model. */
function everyModel(): { sim: Simulation; snap: SimSnapshot } {
  const sim = createSimulation({ seed: 5 });
  ALL_MODELS.forEach((m, i) => {
    sim.addDevice({ id: `d${i}`, type: m.type, name: `D${i}`, position: { x: i * 40, y: 0 } });
  });
  sim.runToIdle(200_000);
  return { sim, snap: sim.snapshot() };
}

const WORLD = everyModel();

function byType(type: string): DeviceSnapshot {
  const d = WORLD.snap.devices.find((x) => x.type === type);
  if (d === undefined) throw new Error(`no device of type ${type}`);
  return d;
}

function tabsOf(type: string): readonly InspectorTab[] {
  return inspectorTabsFor(byType(type), catalogModel(ALL_MODELS, type));
}

function port(partial: Partial<PortSnapshot>): PortSnapshot {
  return {
    id: 'Gi0/0',
    short: 'Gi0/0',
    kind: 'ethernet',
    mac: '00:00:00:00:00:01',
    adminUp: true,
    operUp: false,
    mtu: 1500,
    counters: emptyCounters(),
    l3: {},
    txQueue: 0,
    ...partial,
  };
}

// ── tabs ─────────────────────────────────────────────────────────────────────

describe('inspector tabs from gui + capabilities', () => {
  it('derives the tab set of representative models', () => {
    expect(tabsOf('pc.nfpc')).toEqual(['overview', 'ports', 'config', 'tables', 'processes', 'physical', 'desktop']);
    expect(tabsOf('router.nf2911')).toEqual(['overview', 'ports', 'config', 'tables', 'processes', 'physical']);
    expect(tabsOf('switch.nfc2960')).toEqual(['overview', 'ports', 'config', 'tables', 'processes', 'physical']);
    expect(tabsOf('wrouter.nfhome')).toEqual(['overview', 'ports', 'config', 'tables', 'processes', 'physical', 'wireless']);
    expect(tabsOf('ap.nfap-auto')).toContain('wireless');
    // A hub has no shell, no configurable port, no table and no daemon.
    expect(tabsOf('hub.nfhub4')).toEqual(['overview', 'ports', 'physical']);
  });

  it('keeps every model in display order, always with overview, physical, and desktop exactly for hosts', () => {
    for (const m of ALL_MODELS) {
      const tabs = tabsOf(m.type);
      expect(tabs[0]).toBe('overview');
      const order = tabs.map((t) => INSPECTOR_TAB_ORDER.indexOf(t));
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(tabs).toContain('physical');
      expect(tabs.includes('desktop')).toBe((m.capabilities ?? []).includes('host'));
      expect(tabs.includes('wireless')).toBe((m.gui ?? []).some((g) => ['wireless.ap', 'home-router.setup', 'radio.link', 'cell.tower', 'modem.status'].includes(g)));
      // P1: server models offer the Services panel (§6 'the Services panel builds them').
      expect(tabs.includes('services')).toBe((m.gui ?? []).includes('services'));
    }
  });

  it('never branches on the icon family: the same capabilities give the same tabs whatever the kind', () => {
    const pc = byType('pc.nfpc');
    const renamed = { ...pc, kind: 'router' as const };
    expect(inspectorTabsFor(renamed)).toEqual(inspectorTabsFor(pc));
  });

  it('gives snapshots without catalog v2 fields the P0 tab set', () => {
    const legacy = { ports: [port({})], tables: { cam: [], arp: [], rib: [] } };
    expect(inspectorTabsFor(legacy)).toEqual(LEGACY_INSPECTOR_TABS);
  });

  it('names the settings tab after the device panel', () => {
    expect(inspectorTabLabel('wireless', byType('wrouter.nfhome'))).toBe('Router setup');
    expect(inspectorTabLabel('wireless', byType('radio.nfptp5'))).toBe('Radio link');
    expect(inspectorTabLabel('wireless', byType('cell.nftower'))).toBe('Tower');
    expect(inspectorTabLabel('wireless', byType('modem.nfdsl'))).toBe('Modem');
    expect(inspectorTabLabel('ports', byType('pc.nfpc'))).toBe('Ports');
    expect(panelsForTab(byType('laptop.nflaptop'), 'desktop')).toEqual(['desktop.ip-config', 'desktop.wifi', 'desktop.command-prompt', 'desktop.web-browser']);
  });

  it('clamps a tab the device does not offer to overview', () => {
    const routerTabs = tabsOf('router.nf2911');
    expect(clampInspectorTab('desktop', routerTabs)).toBe('overview');
    expect(clampInspectorTab('wireless', routerTabs)).toBe('overview');
    expect(clampInspectorTab('config', routerTabs)).toBe('config');
    expect(clampInspectorTab(null, routerTabs)).toBe('overview');
    expect(clampInspectorTab(undefined, routerTabs)).toBe('overview');
  });

  it('steps through tabs with wrap-around for keyboard navigation', () => {
    const tabs: InspectorTab[] = ['overview', 'ports', 'physical'];
    expect(stepInspectorTab(tabs, 'overview', 'next')).toBe('ports');
    expect(stepInspectorTab(tabs, 'physical', 'next')).toBe('overview');
    expect(stepInspectorTab(tabs, 'overview', 'prev')).toBe('physical');
    expect(stepInspectorTab(tabs, 'ports', 'first')).toBe('overview');
    expect(stepInspectorTab(tabs, 'ports', 'last')).toBe('physical');
    expect(stepInspectorTab([], 'ports', 'next')).toBe('overview');
  });
});

// ── tables ───────────────────────────────────────────────────────────────────

describe('table sections from ownership, not kind', () => {
  const sections = (type: string) => tableSectionsFor(byType(type), catalogModel(ALL_MODELS, type)).map((s) => (s.kind === 'extra' ? s.name : s.kind));

  it('shows only the tables each device owns', () => {
    expect(sections('hub.nfhub4')).toEqual([]);
    expect(sections('switch.nfc2960')).toEqual(['cam', 'arp', 'rib']); // P1: L2 switches gain arp/ipv4 for the Vlan1 SVI
    // P1: hosts own the IPv6, socket and resolver tables; routers add the DHCP bindings. An AP has no transport daemon.
    expect(sections('pc.nfpc')).toEqual(['arp', 'rib', 'rib6', 'nd', 'sockets', 'dns-cache']);
    expect(sections('router.nf2911')).toEqual(['arp', 'rib', 'rib6', 'nd', 'sockets', 'dhcp-bindings', 'dns-cache']);
    expect(sections('mlswitch.nfc3650-24')).toEqual(['cam', 'arp', 'rib', 'rib6', 'nd', 'sockets', 'dhcp-bindings', 'dns-cache']);
    expect(sections('ap.nfap-auto')).toEqual(['cam', 'arp', 'rib', 'dot11-assoc']);
    expect(sections('laptop.nflaptop')).toEqual(['arp', 'rib', 'dot11-assoc', 'rib6', 'nd', 'sockets', 'dns-cache']);
  });

  it('falls back to capabilities without a catalog entry and always shows tables that hold rows', () => {
    const hub = byType('hub.nfhub4');
    expect(deviceTablePresence(hub)).toEqual({ cam: false, arp: false, rib: false, extra: 0 });
    const withRows = { ...hub, tables: { ...hub.tables, cam: [{ key: '1/aa', vlan: 1, mac: 'aa', port: 'Ethernet0', type: 'dynamic' as const, updatedAt: 0 }] } };
    expect(deviceTablePresence(withRows).cam).toBe(true);
    expect(deviceTablePresence(byType('switch.nfc2960'))).toMatchObject({ cam: true, arp: false, rib: false });
    expect(deviceTablePresence({ tables: hub.tables })).toMatchObject({ cam: true, arp: true, rib: true });
  });

  it('renders extra tables generically from their descriptor', () => {
    const ap = byType('ap.nfap-auto');
    const table = ap.tables.extra?.find((t) => t.name === 'dot11-assoc');
    expect(table).toBeDefined();
    expect(table?.columns.map((c) => c.key)).toEqual(['port', 'station', 'bssid', 'ssid', 'state', 'rssiDbm']);
    const cols = genericColumns(table?.columns ?? [], (p) => `short(${p})`);
    expect(cols.map((c) => c.label)).toEqual(['Radio', 'Station', 'BSSID', 'SSID', 'State', 'Signal (dBm)']);
    const rows = genericRows({ rows: [{ key: 'Wlan0|aa', updatedAt: 5, port: 'Wlan0', state: 'handshake', rssiDbm: -60 }, { updatedAt: 1 }] });
    expect(rows.map((r) => r.key)).toEqual(['Wlan0|aa', '#1']);
    expect(rows[0]?.expiresAt).toBeUndefined();
    expect(cols.find((c) => c.id === 'rssiDbm')?.num).toBe(true);
    expect(cols.find((c) => c.id === 'rssiDbm')?.sort(rows[0] as never)).toBe(-60);
    expect(cols.find((c) => c.id === 'rssiDbm')?.cell(rows[0] as never, 0)).toBe('-60');
    expect(genericRows({ rows: [{ key: 'k', updatedAt: 2, expiresAt: 9 }] })[0]?.expiresAt).toBe(9);
  });
});

// ── gates ────────────────────────────────────────────────────────────────────

describe('port and console gates', () => {
  const on = { power: true, booted: true };

  it('decides the shutdown toggle from role traits and device state', () => {
    expect(portToggleState(on, port({ role: 'routed', configurable: true }))).toEqual({ ok: true });
    expect(portToggleState(on, port({ kind: 'console', role: 'console', configurable: false })).ok).toBe(false);
    expect(portToggleState(on, port({ role: 'repeater', configurable: false })).ok).toBe(false);
    expect(portToggleState({ power: false, booted: false }, port({ role: 'switched', configurable: true }))).toEqual({ ok: false, reason: 'Switch the device on first.' });
    expect(portToggleState({ power: true, booted: false }, port({ role: 'switched', configurable: true })).ok).toBe(false);
    // P0 fixture without role: console-class kinds are never toggled.
    expect(portToggleState(on, port({ kind: 'usb' })).ok).toBe(false);
    expect(portToggleState(on, port({})).ok).toBe(true);
  });

  it('every real port gets a gate that matches its configurable trait', () => {
    for (const d of WORLD.snap.devices) {
      for (const p of d.ports) {
        expect(portToggleState(on, p).ok).toBe(p.configurable === true && p.role !== 'console' && p.role !== 'repeater');
      }
    }
  });

  it('treats console-role ports as management, not data', () => {
    expect(isDataPort(port({ role: 'console' }))).toBe(false);
    expect(isDataPort(port({ role: 'switched' }))).toBe(true);
    expect(isDataPort(port({ kind: 'console' }))).toBe(false);
  });

  it('refuses a console on shell-less devices with the engine wording and points at the settings tab', () => {
    expect(consoleAvailability(byType('pc.nfpc'))).toEqual({ ok: true });
    expect(consoleAvailability(byType('router.nf2911'))).toEqual({ ok: true });
    const home = consoleAvailability(byType('wrouter.nfhome'));
    expect(home.ok).toBe(false);
    if (!home.ok) {
      expect(home.reason).toContain(CLI_MESSAGES.noShell);
      expect(home.reason).toContain('Router setup');
    }
    const hub = consoleAvailability(byType('hub.nfhub4'));
    expect(hub.ok).toBe(false);
    if (!hub.ok) expect(hub.reason).toContain('Physical');
  });
});

// ── modules ──────────────────────────────────────────────────────────────────

describe('module slots', () => {
  function chassis(power: boolean): { sim: Simulation; dev: () => DeviceSnapshot } {
    const sim = createSimulation({ seed: 3 });
    sim.addDevice({ id: 'r1', type: 'router.nf1941', name: 'R1', power });
    sim.addDevice({ id: 'r2', type: 'router.nf2911', name: 'R2' });
    return {
      sim,
      dev: () => {
        const d = sim.snapshot().devices.find((x) => x.id === 'r1');
        if (d === undefined) throw new Error('r1 missing');
        return d;
      },
    };
  }

  it('lists only modules that fit a slot, in catalog order', () => {
    const r1 = chassis(false).dev();
    const slot = slotById(r1, '0/0');
    expect(slot).toBeDefined();
    const fits = modulesForSlot(slot as never, ALL_MODULES);
    expect(fits.map((m) => m.type)).toEqual(ALL_MODULES.filter((m) => m.fits === 'ehwic').map((m) => m.type));
    expect(fits.length).toBeGreaterThan(0);
    expect(modulesForSlot({ type: 'sfp+' }, ALL_MODULES).map((m) => m.fits)).toEqual(expect.arrayContaining(['sfp', 'sfp+']));
    expect(slotById(r1, 'nope')).toBeUndefined();
  });

  it('shows the power-off gate while the device is on, in HARDWARE_MESSAGES wording', () => {
    const { sim, dev } = chassis(true);
    const r1 = dev();
    expect(modulePowerGate(r1)).toBe(HARDWARE_MESSAGES['powered-on'].replace('{device}', 'R1'));
    const result = sim.insertModule('r1', '0/0', 'mod.ehwic-2t');
    expect(result.ok).toBe(false);
    const text = hardwareResultText(result, slotMessageValues(r1, slotById(r1, '0/0') as never, 'NF-EHWIC-2T'));
    expect(text).toContain('R1');
    expect(text).toContain('not hot-swappable');
    sim.setPower('r1', false);
    expect(modulePowerGate(dev())).toBeUndefined();
  });

  it('fills message templates and falls back to them when the engine sends no text', () => {
    expect(hardwareMessage('does-not-fit', { module: 'NF-NIM-2T', slotType: SLOT_TYPE_NAMES.ehwic })).toBe('NF-NIM-2T does not fit a WAN card slot.');
    expect(hardwareMessage('slot-empty', {})).toBe('Slot {slot} is empty.');
    const empty: HardwareResult = { ok: false, code: 'slot-empty', error: '' };
    expect(hardwareResultText(empty, { slot: '0/1' })).toBe('Slot 0/1 is empty.');
    expect(hardwareResultText({ ok: true }, {})).toBeUndefined();
  });

  it('follows an inserted module to its ports and cables', () => {
    const { sim, dev } = chassis(false);
    expect(sim.insertModule('r1', '0/0', 'mod.ehwic-2t')).toEqual({ ok: true });
    const r1 = dev();
    const slot = slotById(r1, '0/0');
    expect(slot?.module).toBe('mod.ehwic-2t');
    const ports = slotPorts(r1, slot as never);
    expect(ports.map((p) => p.id)).toEqual(['Serial0/0/0', 'Serial0/0/1']);
    expect(slotCableCount(r1, slot as never)).toBe(0);
    sim.addLink({ a: { device: 'r1', port: 'Serial0/0/0' }, b: { device: 'r2', port: 'Serial0/0/0' }, media: 'serial-dce' });
    expect(slotCableCount(dev(), slotById(dev(), '0/0') as never)).toBe(1);
    const mod = moduleModel(ALL_MODULES, 'mod.ehwic-2t');
    expect(mod && modulePortSummary(mod)).toBe('2 × Serial');
    expect(moduleName(ALL_MODULES, 'mod.ehwic-2t')).toBe('NF-EHWIC-2T');
    expect(moduleName(ALL_MODULES, 'mod.unknown')).toBe('mod.unknown');
    const sfp = moduleModel(ALL_MODULES, 'mod.sfp-1g-lx');
    expect(sfp && modulePortSummary(sfp)).toBe('LC single-mode optic, 1 Gb/s, up to 10 km');
  });

  it('routes slot actions to insertModule/removeModule and reports a missing service', async () => {
    const insertModule = vi.fn(async (): Promise<HardwareResult> => ({ ok: true }));
    const removeModule = vi.fn(async (): Promise<HardwareResult> => ({ ok: false, code: 'powered-on', error: 'on' }));
    await expect(applyModuleChange({ insertModule, removeModule }, 'r1', '0/0', { op: 'insert', module: 'mod.ehwic-2t' })).resolves.toEqual({ ok: true });
    expect(insertModule).toHaveBeenCalledWith('r1', '0/0', 'mod.ehwic-2t');
    await expect(applyModuleChange({ insertModule, removeModule }, 'r1', '0/1', { op: 'remove' })).resolves.toMatchObject({ ok: false, code: 'powered-on' });
    expect(removeModule).toHaveBeenCalledWith('r1', '0/1');
    await expect(applyModuleChange({}, 'r1', '0/1', { op: 'remove' })).rejects.toThrow(MSG_MODULES_UNAVAILABLE);
  });

  it('words slot contents and hardware summaries', () => {
    expect(withArticle('interface card')).toBe('an interface card');
    expect(withArticle('network module')).toBe('a network module');
    expect(withArticle('SFP transceiver')).toBe('an SFP transceiver');
    const groups = portGroups(byType('router.nf2911').ports);
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every((g) => g.kind !== 'virtual')).toBe(true);
    expect(groups.reduce((n, g) => n + g.count, 0)).toBe(byType('router.nf2911').ports.filter((p) => p.virtual !== true).length);
  });
});

// ── associations and radios ─────────────────────────────────────────────────

describe('associations', () => {
  it('builds the phase ladder with a non-colour mark per step', () => {
    expect(assocPhaseSteps('wifi', 'handshake').map((s) => s.mark)).toEqual(['✓', '✓', '✓', '▶', '·']);
    expect(assocPhaseSteps('wifi', 'associated').every((s) => s.status === 'done')).toBe(true);
    expect(assocPhaseSteps('wifi', 'failed').every((s) => s.status === 'todo')).toBe(true);
    expect(assocPhaseSteps('wifi', 'scanning')[0]?.status).toBe('current');
    expect(assocPhaseSteps('cellular', 'attaching').map((s) => s.status)).toEqual(['done', 'current', 'todo']);
    expect(assocPhaseSteps('wifi', 'x' as never).map((s) => s.state)).toEqual(WIFI_PHASES);
    expect(assocPhaseSteps('cellular', 'attached').map((s) => s.state)).toEqual(CELL_PHASES);
  });

  it('counts down the RF hold', () => {
    expect(holdRemainingNs({}, 10)).toBeUndefined();
    expect(holdRemainingNs({ holdUntil: 2_000 }, 500)).toBe(1_500);
    expect(holdRemainingNs({ holdUntil: 2_000 }, 5_000)).toBe(0);
  });

  it('finds a live Wi-Fi association and explains its rate', () => {
    const sim = createSimulation({ seed: 9 });
    sim.loadTopology(homeWifi());
    sim.runToIdle(200_000);
    const snap = sim.snapshot();
    const assoc = snap.media?.associations[0];
    expect(assoc).toBeDefined();
    if (assoc === undefined) return;
    expect(associationById(snap, assoc.id)).toBe(assoc);
    expect(associationById(snap, 'missing')).toBeUndefined();
    expect(associationById(null, assoc.id)).toBeUndefined();
    expect(associationOfStation(snap, assoc.station)).toBe(assoc);
    expect(associationsOfDevice(snap, assoc.station.device)).toContain(assoc);
    if (assoc.ap !== undefined) expect(associationsOfDevice(snap, assoc.ap.device)).toContain(assoc);
    expect(assoc.state).toBe('associated');
    const bss = snap.media?.bss.find((b) => b.id === assoc.medium);
    const mcs = identifyMcs(assoc.band, assoc.rateBps, bss?.widthMhz);
    expect(mcs).toBeDefined();
    if (mcs !== undefined) {
      const entry = MCS_TABLES[mcs.generation].find((e) => e.mcs === mcs.mcs);
      expect(entry && mcsRateBps(entry, mcs.widthMhz, mcs.streams)).toBe(assoc.rateBps);
    }
  });

  it('identifies MCS entries and formats them', () => {
    const ad = MCS_TABLES.ad[3];
    const lte = MCS_TABLES.lte[0];
    expect(ad && identifyMcs('60', mcsRateBps(ad, 2160, 1))).toEqual({ generation: 'ad', mcs: 3, widthMhz: 2160, streams: 1 });
    expect(lte && identifyMcs('cell', mcsRateBps(lte, 20, 1))).toEqual({ generation: 'lte', mcs: 1, widthMhz: 20, streams: 1 });
    const ac7 = MCS_TABLES.ac[7];
    const rate = ac7 ? mcsRateBps(ac7, 80, 2) : 0;
    const found = identifyMcs('5', rate, 80);
    expect(found).toBeDefined();
    if (found !== undefined) {
      const entry = MCS_TABLES[found.generation].find((e) => e.mcs === found.mcs);
      expect(entry && mcsRateBps(entry, found.widthMhz, found.streams)).toBe(rate);
    }
    expect(identifyMcs('5', 1)).toBeUndefined();
    expect(identifyMcs('5', 0)).toBeUndefined();
    expect(formatMcs({ generation: 'ac', mcs: 7, widthMhz: 80, streams: 2 })).toBe('MCS 7 · 802.11ac · 2 streams');
    expect(formatMcs({ generation: 'n', mcs: 0, widthMhz: 20, streams: 1 })).toBe('MCS 0 · 802.11n · 1 stream');
    expect(formatDistance(40)).toBe('40 m');
    expect(formatDistance(1500)).toBe('1.5 km');
    expect(formatDistance(-1)).toBe('—');
  });
});

// ── lookups and links ────────────────────────────────────────────────────────

describe('lookups and link wording', () => {
  it('resolves devices and links through the snapshot index and survives a stale index', () => {
    const snap = WORLD.snap;
    const devices: Record<string, number> = {};
    snap.devices.forEach((d, i) => (devices[d.id] = i));
    const index = { topologyVersion: snap.topologyVersion, devices, links: {} };
    const target = snap.devices[7];
    expect(deviceById({ snapshot: snap, snapshotIndex: index }, target?.id)).toBe(target);
    const stale = { ...index, devices: { [target?.id ?? '']: 0 } };
    expect(deviceById({ snapshot: snap, snapshotIndex: stale }, target?.id)).toBe(target);
    expect(deviceById({ snapshot: snap }, 'nope')).toBeUndefined();
    expect(deviceById({ snapshot: null }, target?.id)).toBeUndefined();
    expect(linkById({ snapshot: snap }, 'nope')).toBeUndefined();
  });

  it('words link states with a glyph and names radio links', () => {
    const base = { up: false } as Pick<LinkSnapshot, 'up' | 'carrier'>;
    expect(linkStateText({ up: true })).toMatchObject({ glyph: '●', text: 'up' });
    expect(linkStateText({ ...base, carrier: true })).toMatchObject({ glyph: '◐' });
    expect(linkStateText(base)).toMatchObject({ glyph: '▲', text: 'down' });
    expect(linkTitle({ id: 'l1', kind: 'radio' })).toBe('Radio link l1');
    expect(linkTitle({ id: 'l2' })).toBe('Cable l2');
  });
});
