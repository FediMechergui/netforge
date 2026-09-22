// Port inspector, switching section (ARCHITECTURE-P2 §5.5, §6, §7 W3 web-inspector): the facts read from the
// snapshot (PortL2View plus the stp / dtp / etherchannel / port-security tables), when the section applies (port role
// and VLAN-awareness, never the device kind), the access-port quick action through a mocked engine with its error
// mapping, and the rendered section.
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TABLE_DESCRIPTORS, emptyCounters } from '@netforge/engine';
import type { ConfigureOptions, ConfigureResult, DeviceSnapshot, PortSnapshot, TableSnapshot } from '@netforge/engine';

vi.mock('../src/bridge/client', () => ({ engine: {}, fmtSimTime: (t: number) => `${t / 1_000_000_000} s` }));
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = { catalog: [], snapshot: null, snapshotIndex: undefined, epoch: 0, toast: vi.fn() };
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

import { store } from '../src/store/store';
import {
  MSG_SWITCHPORT_UNAVAILABLE,
  SWITCHPORT_MODE_LABELS,
  SwitchportSection,
  applySwitchportAccess,
  checkAccessVlan,
  extraTableRows,
  hasExtraTable,
  stpFactsOf,
  switchportFacts,
  switchportSectionApplies,
  vlanCount,
  vlanListText,
} from '../src/inspector/SwitchportSection';

// ── fixtures ─────────────────────────────────────────────────────────────────

function port(id: string, extra: Partial<PortSnapshot> = {}): PortSnapshot {
  return {
    id, short: id.replace('GigabitEthernet', 'Gi').replace('Port-channel', 'Po'), kind: 'ethernet', mac: '02:00:00:00:00:01', adminUp: true, operUp: true, mtu: 1500,
    counters: emptyCounters(), l3: {}, txQueue: 0, role: 'switched', allowedRoles: ['switched'], encap: 'ethernet', ordinal: 1, virtual: false,
    linkable: true, configurable: true, connector: 'rj45', ...extra,
  };
}

function table(name: keyof typeof TABLE_DESCRIPTORS, rows: Record<string, unknown>[]): TableSnapshot {
  const d = TABLE_DESCRIPTORS[name];
  return { name, title: d.title, columns: [...d.columns], rows };
}

function device(ports: PortSnapshot[], extra: TableSnapshot[] | undefined, more: Partial<DeviceSnapshot> = {}): DeviceSnapshot {
  return {
    id: 'sw1', type: 'switch.nfc2960', model: 'NF-C2960', kind: 'switch', name: 'SW1', position: { x: 0, y: 0 }, power: true, booted: true, uptimeNs: 0,
    ports, tables: { cam: [], arp: [], rib: [], ...(extra === undefined ? {} : { extra }) }, processes: [], runningConfig: '', hasStartupConfig: false,
    category: 'switches', family: 'NF-C2960', variant: '24 ports', icon: 'switch', capabilities: ['managed-switch', 'switching'], cli: { shell: 'nfos', grammar: 'nfos' },
    gui: ['physical'], hostPorts: ['Vlan1'], baseMac: '02:00:00:00:00:00', ...more,
  };
}

const TRUNK = port('GigabitEthernet0/1', {
  l2: { config: { mode: 'trunk', negotiate: false, accessVlan: 1, nativeVlan: 99, allowed: '1,10,20,99' }, oper: 'trunk', active: '1,10,20', forwarding: '1,10,20' },
});
const ACCESS = port('GigabitEthernet0/2', {
  l2: {
    config: { mode: 'access', negotiate: true, accessVlan: 10, voiceVlan: 150, nativeVlan: 1, allowed: '1-4094' },
    oper: 'access',
    forwarding: '10',
    security: { status: 'secure-shutdown', count: 1, max: 1, violations: 2 },
  },
  errDisabled: 'psecure-violation',
  operUp: false,
});
const MEMBER = port('GigabitEthernet0/3', {
  l2: { config: { mode: 'trunk', negotiate: true, accessVlan: 1, nativeVlan: 1, allowed: '1-4094' }, oper: 'trunk', channel: { group: 1, bundle: 'Port-channel1', state: 'bundled' } },
});
const BUNDLE = port('Port-channel1', {
  role: 'channel', virtual: true, linkable: false,
  l2: { config: { mode: 'trunk', negotiate: true, accessVlan: 1, nativeVlan: 1, allowed: '1-4094' }, oper: 'trunk', active: '1,10,20,99', forwarding: '1,10,20,99' },
});
const PLAIN = port('GigabitEthernet0/4');
const ROUTED = port('GigabitEthernet0/5', { role: 'routed', allowedRoles: ['switched', 'routed'] });

const TABLES: TableSnapshot[] = [
  table('vlans', [{ key: '10', vlan: 10, name: 'SALES', status: 'active', source: 'config', updatedAt: 0 }]),
  table('dtp', [{ key: 'GigabitEthernet0/1', port: 'GigabitEthernet0/1', admin: 'trunk', oper: 'trunk', status: 'static', updatedAt: 0 }]),
  table('stp', [
    { key: '10|GigabitEthernet0/1', vlan: 10, port: 'GigabitEthernet0/1', role: 'designated', state: 'forwarding', protocol: 'rstp', cost: 4, portId: '128.1', designatedBridge: '32778/02:00:00:00:00:00', designatedPort: '128.1', edge: false, stateSince: 30_000_000_000, updatedAt: 0 },
    { key: '1|GigabitEthernet0/1', vlan: 1, port: 'GigabitEthernet0/1', role: 'root', state: 'listening', protocol: 'stp', cost: 4, portId: '128.1', designatedBridge: '4097/02:00:00:00:00:00', designatedPort: '128.2', edge: false, inconsistent: 'pvid', stateSince: 30_000_000_000, nextTransitionAt: 45_000_000_000, updatedAt: 0 },
    { key: '10|GigabitEthernet0/2', vlan: 10, port: 'GigabitEthernet0/2', role: 'designated', state: 'forwarding', protocol: 'rstp', cost: 19, portId: '128.2', designatedBridge: '32778/02:00:00:00:00:00', designatedPort: '128.2', edge: true, bpduGuard: true, stateSince: 30_000_000_000, updatedAt: 0 },
    { key: '1|Port-channel1', vlan: 1, port: 'Port-channel1', role: 'alternate', state: 'discarding', protocol: 'rstp', cost: 3, portId: '128.1025', designatedBridge: '4097/02:00:00:00:00:00', designatedPort: '128.3', edge: false, stateSince: 31_000_000_000, updatedAt: 0 },
  ]),
  table('etherchannel', [
    { key: 'GigabitEthernet0/3', port: 'GigabitEthernet0/3', group: 1, bundle: 'Port-channel1', protocol: 'lacp', mode: 'active', state: 'bundled', partnerSystem: '02:00:00:00:01:00', updatedAt: 0 },
    { key: 'GigabitEthernet0/4', port: 'GigabitEthernet0/4', group: 1, bundle: 'Port-channel1', protocol: 'lacp', mode: 'active', state: 'suspended', reason: 'configuration differs from Port-channel1 (access VLAN)', updatedAt: 0 },
  ]),
  table('port-security', [
    { key: 'GigabitEthernet0/2', port: 'GigabitEthernet0/2', max: 1, count: 1, violation: 'shutdown', sticky: true, violations: 2, status: 'secure-shutdown', lastViolationMac: '02:00:00:00:00:99', updatedAt: 0 },
  ]),
];

const SW = device([TRUNK, ACCESS, MEMBER, BUNDLE, PLAIN, ROUTED], TABLES);

function result(commands: readonly string[], fail?: { index: number; message: string; column?: number }): ConfigureResult {
  const lines = commands.map((line, index) => {
    if (fail === undefined || index < fail.index) return { index, line, ok: true, output: '', mode: 'config-if' as const };
    if (index === fail.index) return { index, line, ok: false, output: '', mode: 'config-if' as const, error: { message: fail.message, ...(fail.column !== undefined ? { column: fail.column } : {}) } };
    return { index, line, ok: false, output: '', mode: 'config-if' as const, skipped: true };
  });
  return { ok: fail === undefined, lines, applied: fail === undefined ? commands.length : 0, reverted: fail !== undefined, finalMode: 'config-if' };
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

// ── facts ────────────────────────────────────────────────────────────────────

describe('switchport facts from the snapshot', () => {
  it('reads extra tables generically', () => {
    expect(hasExtraTable(SW, 'vlans')).toBe(true);
    expect(hasExtraTable(SW, 'nat')).toBe(false);
    expect(extraTableRows(SW, 'dtp')).toHaveLength(1);
    expect(extraTableRows(device([], undefined), 'dtp')).toEqual([]);
  });

  it('describes a static trunk: config, operating mode, negotiation, active and forwarding lists, per-VLAN spanning tree', () => {
    const f = switchportFacts(SW, TRUNK)!;
    expect(f).toMatchObject({ oper: 'trunk', defaults: false, active: '1,10,20', forwarding: '1,10,20', channel: undefined, security: undefined, members: [] });
    expect(f.config).toEqual({ mode: 'trunk', negotiate: false, accessVlan: 1, nativeVlan: 99, allowed: '1,10,20,99' });
    expect(f.dtp).toEqual({ status: 'static', neighborMode: undefined, neighbor: undefined });
    expect(f.stp.map((s) => [s.vlan, s.role, s.state, s.protocol, s.inconsistent, s.nextTransitionAt])).toEqual([
      [1, 'root', 'listening', 'stp', 'pvid', 45_000_000_000],
      [10, 'designated', 'forwarding', 'rstp', undefined, undefined],
    ]);
    expect(stpFactsOf(SW, 'GigabitEthernet0/9')).toEqual([]);
  });

  it('describes an access port with a voice VLAN and its port-security row', () => {
    const f = switchportFacts(SW, ACCESS)!;
    expect(f.config.accessVlan).toBe(10);
    expect(f.config.voiceVlan).toBe(150);
    expect(f.oper).toBe('access');
    expect(f.security).toEqual({ status: 'secure-shutdown', count: 1, max: 1, violations: 2, violation: 'shutdown', sticky: true, lastViolationMac: '02:00:00:00:00:99' });
    expect(f.stp[0]).toMatchObject({ vlan: 10, edge: true, bpduGuard: true });
  });

  it('falls back to the PortL2View summaries when the tables carry no row', () => {
    const noTables = device([ACCESS, MEMBER], [table('vlans', [])]);
    expect(switchportFacts(noTables, ACCESS)!.security).toEqual({ status: 'secure-shutdown', count: 1, max: 1, violations: 2, violation: undefined, sticky: undefined, lastViolationMac: undefined });
    expect(switchportFacts(noTables, MEMBER)!.channel).toEqual({ group: 1, bundle: 'Port-channel1', state: 'bundled', protocol: undefined, mode: undefined, reason: undefined });
  });

  it('describes channel members and the bundle with its members', () => {
    const m = switchportFacts(SW, MEMBER)!;
    expect(m.channel).toEqual({ group: 1, bundle: 'Port-channel1', state: 'bundled', protocol: 'lacp', mode: 'active', reason: undefined });
    expect(m.stp).toEqual([]);
    const b = switchportFacts(SW, BUNDLE)!;
    expect(b.members.map((x) => [x.state, x.reason])).toEqual([['bundled', undefined], ['suspended', 'configuration differs from Port-channel1 (access VLAN)']]);
    expect(b.stp.map((s) => [s.vlan, s.role, s.state])).toEqual([[1, 'alternate', 'discarding']]);
  });

  it('uses the default switchport settings for a port without an l2 view and nothing for a routed port', () => {
    const f = switchportFacts(SW, PLAIN)!;
    expect(f.defaults).toBe(true);
    expect(f.config).toEqual({ mode: 'dynamic-auto', negotiate: true, accessVlan: 1, nativeVlan: 1, allowed: '1-4094' });
    expect(f.oper).toBe('access');
    expect(f.channel).toMatchObject({ state: 'suspended' });
    expect(switchportFacts(SW, ROUTED)).toBeUndefined();
  });

  it('applies to bridged ports of VLAN-aware devices only', () => {
    expect(switchportSectionApplies(SW, TRUNK)).toBe(true);
    expect(switchportSectionApplies(SW, PLAIN)).toBe(true); // the device declares the vlans table
    expect(switchportSectionApplies(SW, ROUTED)).toBe(false);
    const legacy = device([PLAIN], undefined);
    expect(switchportSectionApplies(legacy, PLAIN)).toBe(false);
    expect(switchportSectionApplies(legacy, PLAIN, { processes: ['eth-switch', 'arp', 'ipv4'] })).toBe(false);
    expect(switchportSectionApplies(legacy, PLAIN, { processes: ['eth-switch', 'vlan', 'stp'] })).toBe(true);
    expect(switchportSectionApplies(legacy, TRUNK)).toBe(true); // the port carries an l2 view
    expect(switchportSectionApplies(legacy, { role: 'channel' })).toBe(false);
  });

  it('words lists and checks the VLAN input', () => {
    expect(vlanListText('1-4094')).toBe('all (1-4094)');
    expect(vlanListText('')).toBe('none');
    expect(vlanListText('1,10,20')).toBe('1,10,20');
    expect(vlanCount('1,10-12')).toBe(4);
    expect(checkAccessVlan('10')).toBeUndefined();
    expect(checkAccessVlan(' 4094 ')).toBeUndefined();
    expect(checkAccessVlan('0')).toBeDefined();
    expect(checkAccessVlan('4095')).toBeDefined();
    expect(checkAccessVlan('ten')).toBeDefined();
    expect(checkAccessVlan('')).toBeDefined();
    expect(Object.keys(SWITCHPORT_MODE_LABELS)).toEqual(['access', 'trunk', 'dynamic-auto', 'dynamic-desirable']);
  });
});

// ── quick action ─────────────────────────────────────────────────────────────

describe('access-port quick action', () => {
  it('sends the two canonical lines through configure, indented and atomic', async () => {
    const configure = vi.fn(async (_d: string, commands: string[], _o?: ConfigureOptions) => result(commands));
    const outcome = await applySwitchportAccess({ configure }, 'sw1', 'GigabitEthernet0/2', ' 20 ');
    expect(outcome).toMatchObject({ ok: true, reverted: false, fieldErrors: {}, general: [] });
    expect(configure).toHaveBeenCalledTimes(1);
    expect(configure.mock.calls[0]![0]).toBe('sw1');
    expect(configure.mock.calls[0]![1]).toEqual(['interface GigabitEthernet0/2', ' switchport mode access', ' switchport access vlan 20']);
    expect(configure.mock.calls[0]![2]).toEqual({ indentation: true, stopOnError: true, atomic: true });
  });

  it('maps a refused VLAN to the accessVlan field and a refused mode to the mode field', async () => {
    const vlanRefused = vi.fn(async (_d: string, commands: string[]) => result(commands, { index: 2, message: '% VLAN 5000 is out of range', column: 24 }));
    const out = await applySwitchportAccess({ configure: vlanRefused }, 'sw1', 'GigabitEthernet0/2', '5000');
    expect(out.ok).toBe(false);
    expect(out.reverted).toBe(true);
    expect(out.fieldErrors).toEqual({ accessVlan: 'VLAN 5000 is out of range' });
    const modeRefused = vi.fn(async (_d: string, commands: string[]) => result(commands, { index: 1, message: '% Port-channel members take their mode from the bundle' }));
    const out2 = await applySwitchportAccess({ configure: modeRefused }, 'sw1', 'GigabitEthernet0/3', '10');
    expect(out2.fieldErrors).toEqual({ mode: 'Port-channel members take their mode from the bundle' });
    expect(out2.skipped).toBe(1);
  });

  it('turns a missing or failing bridge into a general message', async () => {
    expect((await applySwitchportAccess({}, 'sw1', 'GigabitEthernet0/2', '10')).general).toEqual([MSG_SWITCHPORT_UNAVAILABLE]);
    const failing = await applySwitchportAccess({ configure: async () => Promise.reject(new Error('No device "sw1".')) }, 'sw1', 'GigabitEthernet0/2', '10');
    expect(failing.ok).toBe(false);
    expect(failing.general[0]).toContain('No device "sw1".');
  });
});

// ── rendering ────────────────────────────────────────────────────────────────

describe('SwitchportSection rendering', () => {
  const html = (p: PortSnapshot, d: DeviceSnapshot = SW) => text(renderToStaticMarkup(createElement(SwitchportSection, { device: d, port: p, now: 31_000_000_000 })));

  it('shows the trunk facts, the per-VLAN spanning-tree state with text and the pending change', () => {
    const t = html(TRUNK);
    expect(t).toContain('Switching');
    expect(t).toContain('trunk (fixed)');
    expect(t).toContain('operating as a trunk');
    expect(t).toContain('negotiation static');
    expect(t).toContain('negotiation off');
    expect(t).toContain('Native VLAN');
    expect(t).toContain('99');
    expect(t).toContain('Allowed VLANs 1,10,20,99');
    expect(t).toContain('Active VLANs 1,10,20');
    expect(t).toContain('Forwarding in 1,10,20');
    expect(t).toContain('VLAN 1 : root port (towards the root bridge), ◔ listening');
    expect(t).toContain('pvid inconsistent');
    expect(t).toContain('next state change at 45 s');
    expect(t).toContain('VLAN 10 : designated port, ● forwarding');
    expect(t).toContain('Port security off');
    expect(t).toContain('Make an access port');
  });

  it('shows the access port with its voice VLAN and port-security state', () => {
    const t = html(ACCESS);
    expect(t).toContain('access (fixed)');
    expect(t).toContain('Access VLAN 10');
    expect(t).toContain('Voice VLAN 150');
    expect(t).not.toContain('Native VLAN');
    expect(t).toContain('shut by a violation (err-disabled)');
    expect(t).toContain('1 of 1 address learned');
    expect(t).toContain('on violation: shutdown');
    expect(t).toContain('sticky');
    expect(t).toContain('2 violations');
    expect(t).toContain('02:00:00:00:00:99');
    expect(t).toContain('edge port');
    expect(t).toContain('BPDU guard');
  });

  it('shows channel membership on a member and the members on the bundle, without the quick action there', () => {
    const m = html(MEMBER);
    expect(m).toContain('Port-channel1 (group 1, lacp active)');
    expect(m).toContain('bundled (carries traffic)');
    expect(m).toContain('runs on the bundle, not on this member');
    const b = html(BUNDLE);
    expect(b).toContain('Members');
    expect(b).toContain('suspended (no traffic)');
    expect(b).toContain('configuration differs from Port-channel1 (access VLAN)');
    expect(b).toContain('alternate port (backup path to the root), ✕ discarding');
    expect(b).not.toContain('Make an access port');
  });

  it('shows the defaults for an untouched port and nothing for a routed one', () => {
    const p = html(PLAIN);
    expect(p).toContain('dynamic auto');
    expect(p).toContain('default settings');
    expect(p).toContain('operating as an access port');
    expect(p).toContain('nothing negotiated yet');
    expect(p).toContain('not running on this port');
    expect(renderToStaticMarkup(createElement(SwitchportSection, { device: SW, port: ROUTED }))).toBe('');
    const off = html(TRUNK, { ...SW, power: false });
    expect(off).not.toContain('Make an access port');
    expect((store.getState() as unknown as { toast: unknown }).toast).toBeDefined();
  });
});
