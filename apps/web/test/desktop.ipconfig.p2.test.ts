// Desktop IP configuration app, P2 additions (ARCHITECTURE-P2 §5.5 "IP configuration app", §5.2 `ipv6 address dhcp`;
// [S4] "IP phone": the Voice VLAN field; W3 web-inspector): the IPv6 choice read from the config lines and written
// through configure (mocked engine, the P1 autoconfig line also through the real host shell), the phone's Voice VLAN
// line, per-field error mapping, and the rendered form.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createSimulation } from '@netforge/engine';
import type { ConfigureOptions, ConfigureResult, DeviceSnapshot, SimSnapshot, Simulation } from '@netforge/engine';

const api = vi.hoisted(() => ({ configure: vi.fn() }));
vi.mock('../src/bridge/client', () => ({ engine: api }));
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
import { submitPlan } from '../src/desktop/shared';
import {
  IPV6_MODE_LABELS,
  IpConfigApp,
  checkVoiceVlan,
  ipConfigPanelFormFrom,
  ipConfigPanelPlan,
  ipv6AddressLines,
  ipv6AddressModeFrom,
  sameIpPanelForm,
  validateIpConfigPanelForm,
  voiceVlanCapable,
  voiceVlanFrom,
} from '../src/desktop/apps/IpConfigApp';
import type { IpConfigPanelForm } from '../src/desktop/apps/IpConfigApp';

const setState = (useStore as unknown as { setState(p: Record<string, unknown>): void }).setState;

function lab(): Simulation {
  const sim = createSimulation({ seed: 3 });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', position: { x: 0, y: 0 } });
  sim.addDevice({ id: 'phone1', type: 'ipphone.nfphone', name: 'PHONE1', position: { x: 0, y: 100 } });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', position: { x: 0, y: 200 } });
  sim.runToIdle();
  return sim;
}

function device(snapshot: SimSnapshot, id: string): DeviceSnapshot {
  const d = snapshot.devices.find((x) => x.id === id);
  if (d === undefined) throw new Error(`no device ${id}`);
  return d;
}

function indexOf(snapshot: SimSnapshot) {
  return {
    topologyVersion: snapshot.topologyVersion,
    devices: Object.fromEntries(snapshot.devices.map((d, i) => [d.id, i])),
    links: Object.fromEntries(snapshot.links.map((l, i) => [l.id, i])),
  };
}

function useSnapshot(snapshot: SimSnapshot): void {
  setState({ snapshot, snapshotIndex: indexOf(snapshot), playing: false, desktopWindows: [] });
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

function result(commands: readonly string[], fail?: { index: number; message: string; column?: number }): ConfigureResult {
  const lines = commands.map((line, index) => {
    if (fail === undefined || index < fail.index) return { index, line, ok: true, output: '', mode: 'user-exec' as const };
    if (index === fail.index) return { index, line, ok: false, output: '', mode: 'user-exec' as const, error: { message: fail.message, ...(fail.column !== undefined ? { column: fail.column } : {}) } };
    return { index, line, ok: false, output: '', mode: 'user-exec' as const, skipped: true };
  });
  return { ok: fail === undefined, lines, applied: fail === undefined ? commands.length : 0, reverted: fail !== undefined, finalMode: 'user-exec' };
}

beforeEach(() => {
  api.configure.mockReset();
});

describe('readers', () => {
  it('reads the IPv6 choice and the voice VLAN from the config lines', () => {
    const cfg = ['interface GigabitEthernet0', ' ip address 10.0.0.2 255.255.255.0', ' ipv6 enable', ' ipv6 address dhcp', '!', 'interface Wlan0', ' ipv6 address autoconfig', '!', 'voice vlan 150', 'end'].join('\n');
    expect(ipv6AddressModeFrom({ runningConfig: cfg }, 'GigabitEthernet0')).toBe('dhcp');
    expect(ipv6AddressModeFrom({ runningConfig: cfg }, 'Wlan0')).toBe('autoconfig');
    expect(ipv6AddressModeFrom({ runningConfig: cfg }, 'Missing')).toBe('none');
    expect(voiceVlanFrom({ runningConfig: cfg })).toBe('150');
    expect(voiceVlanFrom({ runningConfig: 'hostname X\nend' })).toBe('');
  });

  it('offers the voice VLAN to hosts with a built-in bridge only (capabilities, not kind)', () => {
    const snap = lab().snapshot();
    expect(voiceVlanCapable(device(snap, 'phone1'))).toBe(true);
    expect(voiceVlanCapable(device(snap, 'pc1'))).toBe(false);
    expect(voiceVlanCapable(device(snap, 'r1'))).toBe(false);
    expect(voiceVlanCapable({ capabilities: ['host', 'switching', 'routing'] })).toBe(false);
    expect(voiceVlanCapable({ capabilities: undefined as never })).toBe(false);
  });

  it('builds the panel form from the snapshot and compares it with the P2 fields included', () => {
    const snap = lab().snapshot();
    const form = ipConfigPanelFormFrom(device(snap, 'phone1'));
    expect(form).toMatchObject({ adapter: 'Vlan1', ipv6: 'none', voiceVlan: '' });
    expect(sameIpPanelForm(form, { ...form, voiceVlan: ' ' })).toBe(true);
    expect(sameIpPanelForm(form, { ...form, ipv6: 'dhcp' })).toBe(false);
    expect(sameIpPanelForm(form, { ...form, voiceVlan: '150' })).toBe(false);
    expect(IPV6_MODE_LABELS.dhcp).toBe('Automatic with DHCPv6');
  });

  it('lists IPv6 addresses with how they were obtained', () => {
    const lines = ipv6AddressLines({
      l3: {
        ipv6: [
          { address: 'fe80::1', prefixLen: 64, scope: 'link-local', origin: 'auto-link-local', state: 'preferred' },
          { address: '2001:db8:1::2', prefixLen: 128, scope: 'global', origin: 'dhcpv6', state: 'preferred' },
          { address: '2001:db8:1:0:200:ff:fe00:1', prefixLen: 64, scope: 'global', origin: 'slaac', state: 'tentative' },
        ],
      },
    });
    expect(lines).toEqual(['2001:db8:1::2/128 (from DHCPv6)', '2001:db8:1:0:200:ff:fe00:1/64 (from a router advertisement, tentative)']);
    expect(ipv6AddressLines({ l3: {} })).toEqual([]);
  });
});

describe('validation and plans', () => {
  const base: IpConfigPanelForm = { adapter: 'Vlan1', address: '10.0.0.5', mask: '255.255.255.0', gateway: '10.0.0.1', ipv6: 'none', voiceVlan: '' };
  const ctx = { grammar: 'host' as const, defaultAdapter: 'Vlan1', voiceVlan: true };

  it('validates the voice VLAN only where the field is shown', () => {
    expect(validateIpConfigPanelForm(base, ctx)).toEqual({});
    expect(validateIpConfigPanelForm({ ...base, voiceVlan: '150' }, ctx)).toEqual({});
    expect(Object.keys(validateIpConfigPanelForm({ ...base, voiceVlan: '4095' }, ctx))).toEqual(['voiceVlan']);
    expect(Object.keys(validateIpConfigPanelForm({ ...base, voiceVlan: 'x' }, { ...ctx, voiceVlan: false }))).toEqual([]);
    expect(Object.keys(validateIpConfigPanelForm({ ...base, address: '', voiceVlan: '0' }, ctx)).sort()).toEqual(['address', 'voiceVlan']);
    expect(checkVoiceVlan('')).toBeUndefined();
    expect(checkVoiceVlan(' 12 ')).toBeUndefined();
    expect(checkVoiceVlan('12a')).toContain('1 to 4094');
  });

  it('merges the address lines, the IPv6 choice and the voice VLAN into one plan', () => {
    const next: IpConfigPanelForm = { ...base, address: '10.0.0.6', ipv6: 'dhcp', voiceVlan: '150' };
    const p = ipConfigPanelPlan('host', next, base, { defaultAdapter: 'Vlan1', voiceVlan: true });
    expect(p.commands).toEqual(['ip address 10.0.0.6 255.255.255.0 10.0.0.1', 'ipv6 address dhcp', 'voice vlan 150']);
    expect(p.options).toEqual({ stopOnError: true, atomic: true });
    expect(p.lines[1]!.spans.every((s) => s.field === 'ipv6')).toBe(true);
    expect(p.lines[2]!.spans.every((s) => s.field === 'voiceVlan')).toBe(true);
    // Only the changed parts are sent; the voice VLAN is skipped where the field is not shown.
    expect(ipConfigPanelPlan('host', { ...base, ipv6: 'dhcp' }, base, { defaultAdapter: 'Vlan1', voiceVlan: true }).commands).toEqual(['ipv6 address dhcp']);
    expect(ipConfigPanelPlan('host', { ...base, voiceVlan: '150' }, base, { defaultAdapter: 'Vlan1', voiceVlan: false }).commands).toEqual([]);
    expect(ipConfigPanelPlan('host', { ...base, ipv6: 'none' }, { ...base, ipv6: 'dhcp' }, { defaultAdapter: 'Vlan1', voiceVlan: true }).commands).toEqual(['no ipv6 address dhcp']);
    // nfos: the IPv6 line joins the adapter's interface section.
    const nfos = ipConfigPanelPlan('nfos', { ...base, adapter: 'GigabitEthernet0/0', gateway: '', ipv6: 'dhcp' }, { ...base, adapter: 'GigabitEthernet0/0', gateway: '' }, { voiceVlan: false });
    expect(nfos.commands).toEqual(['interface GigabitEthernet0/0', ' ipv6 address dhcp']);
  });
});

describe('through configure', () => {
  it('sends the DHCPv6 line and the voice VLAN of a phone, and maps a refused line back to its field', async () => {
    const sim = lab();
    const phone = device(sim.snapshot(), 'phone1');
    const before = ipConfigPanelFormFrom(phone);
    const plan = ipConfigPanelPlan('host', { ...before, ipv6: 'dhcp', voiceVlan: '150' }, before, { defaultAdapter: 'Vlan1', voiceVlan: true });
    api.configure.mockImplementation(async (_d: string, commands: string[], _o?: ConfigureOptions) => result(commands));
    const ok = await submitPlan('phone1', plan);
    expect(ok.ok).toBe(true);
    expect(api.configure).toHaveBeenCalledTimes(1);
    expect(api.configure.mock.calls[0]![0]).toBe('phone1');
    expect(api.configure.mock.calls[0]![1]).toEqual(['ipv6 address dhcp', 'voice vlan 150']);
    expect(api.configure.mock.calls[0]![2]).toEqual({ stopOnError: true, atomic: true });

    api.configure.mockImplementation(async (_d: string, commands: string[]) => result(commands, { index: 1, message: '% VLAN 150 does not exist yet', column: 11 }));
    const refused = await submitPlan('phone1', plan);
    expect(refused.ok).toBe(false);
    expect(refused.fieldErrors).toEqual({ voiceVlan: 'VLAN 150 does not exist yet' });
    api.configure.mockImplementation(async (_d: string, commands: string[]) => result(commands, { index: 0, message: '% This adapter does not run IPv6' }));
    expect((await submitPlan('phone1', plan)).fieldErrors).toEqual({ ipv6: 'This adapter does not run IPv6' });
  });

  it('writes the router-advertisement choice the real host shell already accepts, and reads it back', async () => {
    const sim = lab();
    const pc = device(sim.snapshot(), 'pc1');
    const before = ipConfigPanelFormFrom(pc, 'GigabitEthernet0');
    expect(before.ipv6).toBe('none');
    const plan = ipConfigPanelPlan('host', { ...before, ipv6: 'autoconfig' }, before, { defaultAdapter: 'GigabitEthernet0', voiceVlan: false });
    expect(plan.commands).toEqual(['ipv6 autoconfig']);
    api.configure.mockImplementation(async (dev: string, commands: string[], opts?: ConfigureOptions) => sim.configure(dev, commands, opts));
    const outcome = await submitPlan('pc1', plan);
    expect(outcome.ok).toBe(true);
    const after = ipConfigPanelFormFrom(device(sim.snapshot(), 'pc1'), 'GigabitEthernet0');
    expect(after.ipv6).toBe('autoconfig');
    const back = ipConfigPanelPlan('host', { ...after, ipv6: 'none' }, after, { defaultAdapter: 'GigabitEthernet0', voiceVlan: false });
    expect(back.commands).toEqual(['no ipv6 autoconfig']);
    expect((await submitPlan('pc1', back)).ok).toBe(true);
    expect(ipConfigPanelFormFrom(device(sim.snapshot(), 'pc1'), 'GigabitEthernet0').ipv6).toBe('none');
  });
});

describe('through the real host shell (ARCHITECTURE-P2 §5.5 expansions)', () => {
  it('writes the DHCPv6 choice and the phone\'s voice VLAN through configure, reads both back, and clears them again', async () => {
    const sim = lab();
    api.configure.mockImplementation(async (dev: string, commands: string[], opts?: ConfigureOptions) => sim.configure(dev, commands, opts));
    const phone = device(sim.snapshot(), 'phone1');
    const before = ipConfigPanelFormFrom(phone);
    expect(before).toMatchObject({ adapter: 'Vlan1', ipv6: 'none', voiceVlan: '' });
    const plan = ipConfigPanelPlan('host', { ...before, ipv6: 'dhcp', voiceVlan: '150' }, before, { defaultAdapter: 'Vlan1', voiceVlan: true });
    expect(plan.commands).toEqual(['ipv6 address dhcp', 'voice vlan 150']);
    const outcome = await submitPlan('phone1', plan);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    const after = ipConfigPanelFormFrom(device(sim.snapshot(), 'phone1'));
    expect(after).toMatchObject({ ipv6: 'dhcp', voiceVlan: '150' });
    const back = ipConfigPanelPlan('host', { ...after, ipv6: 'none', voiceVlan: '' }, after, { defaultAdapter: 'Vlan1', voiceVlan: true });
    expect(back.commands).toEqual(['no ipv6 address dhcp', 'no voice vlan']);
    expect((await submitPlan('phone1', back)).ok).toBe(true);
    expect(ipConfigPanelFormFrom(device(sim.snapshot(), 'phone1'))).toMatchObject({ ipv6: 'none', voiceVlan: '' });
    // a PC takes the DHCPv6 choice too, on its own adapter
    const pc = ipConfigPanelFormFrom(device(sim.snapshot(), 'pc1'), 'GigabitEthernet0');
    const pcPlan = ipConfigPanelPlan('host', { ...pc, ipv6: 'dhcp' }, pc, { defaultAdapter: 'GigabitEthernet0', voiceVlan: false });
    expect(pcPlan.commands).toEqual(['ipv6 address dhcp']);
    expect((await submitPlan('pc1', pcPlan)).ok).toBe(true);
    expect(ipConfigPanelFormFrom(device(sim.snapshot(), 'pc1'), 'GigabitEthernet0').ipv6).toBe('dhcp');
  });
});

describe('rendering', () => {
  it('shows the IPv6 choice on every host and the Voice VLAN field on the phone only', () => {
    const snap = lab().snapshot();
    useSnapshot(snap);
    const phone = text(renderToStaticMarkup(createElement(IpConfigApp, { deviceId: 'phone1', windowId: 1 })));
    expect(phone).toContain('IPv6 address');
    expect(phone).toContain('Automatic with DHCPv6');
    expect(phone).toContain('Automatic from router advertisements');
    expect(phone).toContain('Voice VLAN');
    const pc = text(renderToStaticMarkup(createElement(IpConfigApp, { deviceId: 'pc1', windowId: 2 })));
    expect(pc).toContain('Automatic with DHCPv6');
    expect(pc).not.toContain('Voice VLAN');
  });
});
