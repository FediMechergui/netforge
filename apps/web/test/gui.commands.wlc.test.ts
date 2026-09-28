// Wireless controller builders and forms (ARCHITECTURE-P2 §3.12, §5.3, §5.5 "Controller panel"; §7 W6 web-inspector):
// the canonical `wlc-interface` and `wlan` lines of the controller panel's Interfaces and WLANs pages, the field spans
// that map a refused line back to its input, the readers of the rendered running config, the client-side checks, and
// the real controller grammar accepting every line the builders write.
import { describe, expect, it } from 'vitest';
import { createSimulation } from '@netforge/engine';
import type { ConfigureResult, Simulation } from '@netforge/engine';
import {
  PANEL_CONFIGURE_OPTIONS,
  isEmptyPlan,
  wlanCommands,
  wlanLines,
  wlanRemoveCommands,
  wlcInterfaceCommands,
  wlcInterfaceLines,
  wlcInterfaceRemoveCommands,
} from '../src/gui/commands.js';
import {
  checkWlanId,
  checkWlanSsid,
  checkWlcName,
  checkWlcVlan,
  emptyWlanForm,
  emptyWlcInterfaceForm,
  fieldAt,
  mapConfigureResult,
  nextFreeWlanId,
  sameWlanIdentity,
  validateWlanForm,
  validateWlcInterfaceForm,
  wlanFormsFrom,
  wlcInterfaceFormsFrom,
  wlcManagementInterface,
} from '../src/gui/forms.js';
import type { WlanForm, WlcInterfaceForm } from '../src/gui/forms.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

const STAFF_IF: WlcInterfaceForm = { name: 'STAFF-IF', vlan: '20', address: '192.168.20.5', mask: '255.255.255.0', gateway: '192.168.20.1', dhcpServer: '192.168.20.1' };
const MGMT: WlcInterfaceForm = { name: 'management', vlan: '99', address: '192.168.99.5', mask: '255.255.255.0', gateway: '192.168.99.1', dhcpServer: '' };
const STAFF: WlanForm = { id: '1', profile: 'STAFF', ssid: 'LabNet', security: 'wpa2-psk', passphrase: 'correct horse', hasPassphrase: false, iface: 'STAFF-IF', radio: 'all', enabled: true };

/** The §3.12 controller configuration, rendered. */
const RUNNING = [
  '! NetForge NFOS configuration',
  'hostname WLC1',
  '!',
  'wlc-interface STAFF-IF',
  ' vlan 20',
  ' address 192.168.20.5 255.255.255.0',
  ' gateway 192.168.20.1',
  ' dhcp-server 192.168.20.1',
  '!',
  'wlc-interface management',
  ' vlan 99',
  ' address 192.168.99.5 255.255.255.0',
  ' gateway 192.168.99.1',
  '!',
  'wlan 7 GUEST Visitors',
  ' security open',
  ' radio 5',
  ' shutdown',
  '!',
  'wlan 1 STAFF LabNet',
  ' security wpa2-psk',
  ' passphrase <hidden>',
  ' interface STAFF-IF',
  '!',
  'interface Vlan20',
  ' ip address 192.168.20.5 255.255.255.0',
  '!',
  'end',
].join('\n');

function failed(commands: readonly string[], index: number, message: string, column?: number): ConfigureResult {
  return {
    ok: false,
    applied: 0,
    reverted: true,
    finalMode: 'config',
    lines: commands.map((line, i) =>
      i < index
        ? { index: i, line, ok: true, output: '', mode: 'config' as const }
        : i === index
          ? { index: i, line, ok: false, output: '', mode: 'config' as const, error: { message, ...(column !== undefined ? { column } : {}) } }
          : { index: i, line, ok: false, output: '', mode: 'config' as const, skipped: true },
    ),
  };
}

function controller(): Simulation {
  const sim = createSimulation({ seed: 5, profile: 'P2' });
  sim.addDevice({ id: 'wlc', type: 'wlc.nfwlc9800', name: 'WLC1', position: { x: 0, y: 0 } });
  sim.runToIdle();
  return sim;
}

function running(sim: Simulation): string {
  return sim.snapshot().devices.find((d) => d.id === 'wlc')?.runningConfig ?? '';
}

// ── controller interfaces ────────────────────────────────────────────────────

describe('wlc-interface lines', () => {
  it('writes a new interface exactly as §3.12 shows it (vlan, address, gateway, dhcp-server)', () => {
    const p = wlcInterfaceCommands(STAFF_IF);
    expect(p.grammar).toBe('nfos');
    expect(p.options).toBe(PANEL_CONFIGURE_OPTIONS.nfos);
    expect(p.commands).toEqual([
      'wlc-interface STAFF-IF',
      ' vlan 20',
      ' address 192.168.20.5 255.255.255.0',
      ' gateway 192.168.20.1',
      ' dhcp-server 192.168.20.1',
    ]);
    // the management interface of §3.12 (no DHCP server)
    expect(wlcInterfaceCommands(MGMT).commands).toEqual(['wlc-interface management', ' vlan 99', ' address 192.168.99.5 255.255.255.0', ' gateway 192.168.99.1']);
  });

  it('sends canonical addresses and masks, and a prefix mask as dotted', () => {
    const p = wlcInterfaceCommands({ ...STAFF_IF, address: ' 192.168.020.5 ', mask: '/24', gateway: '', dhcpServer: '' });
    expect(p.commands).toEqual(['wlc-interface STAFF-IF', ' vlan 20', ' address 192.168.20.5 255.255.255.0']);
  });

  it('sends only what changed, and the no forms for cleared values', () => {
    expect(isEmptyPlan(wlcInterfaceCommands(STAFF_IF, STAFF_IF))).toBe(true);
    expect(wlcInterfaceCommands({ ...STAFF_IF, gateway: '192.168.20.254' }, STAFF_IF).commands).toEqual(['wlc-interface STAFF-IF', ' gateway 192.168.20.254']);
    expect(wlcInterfaceCommands({ ...STAFF_IF, address: '', mask: '', gateway: '', dhcpServer: '' }, STAFF_IF).commands).toEqual([
      'wlc-interface STAFF-IF',
      ' no address',
      ' no gateway',
      ' no dhcp-server',
    ]);
    // the VLAN goes first: the controller moves the interface's SVI onto it before a new address lands there
    expect(wlcInterfaceCommands({ ...STAFF_IF, vlan: '30', address: '192.168.30.5' }, STAFF_IF).commands).toEqual([
      'wlc-interface STAFF-IF',
      ' vlan 30',
      ' address 192.168.30.5 255.255.255.0',
    ]);
    // a blank management row (predefined, no section yet) is a baseline like any other
    expect(wlcInterfaceCommands(MGMT, emptyWlcInterfaceForm('management')).commands).toEqual(wlcInterfaceCommands(MGMT).commands);
  });

  it('attributes every token to its field', () => {
    const p = wlcInterfaceCommands(STAFF_IF);
    expect(p.lines[0]!.spans.map((s) => s.field)).toEqual(['name', 'name']);
    expect(p.lines[1]!.spans.map((s) => s.field)).toEqual(['vlan', 'vlan']);
    expect(p.lines[2]!.spans.map((s) => s.field)).toEqual(['address', 'address', 'mask']);
    expect(p.lines[3]!.spans.map((s) => s.field)).toEqual(['gateway', 'gateway']);
    expect(p.lines[4]!.spans.map((s) => s.field)).toEqual(['dhcpServer', 'dhcpServer']);
    // a caret on the mask token (column in the sent text, indentation included) lands on `mask`
    expect(fieldAt(p, 2, 22)).toBe('mask');
    expect(wlcInterfaceLines({ ...STAFF_IF, dhcpServer: '' }, STAFF_IF)).toEqual([[['no', 'dhcpServer'], ['dhcp-server', 'dhcpServer']]]);
  });

  it('maps refusals back onto the fields (handler errors carry no column: the line decides)', () => {
    const p = wlcInterfaceCommands(STAFF_IF);
    const vlan = mapConfigureResult(p, failed(p.commands, 1, '% VLAN 20 already belongs to controller interface OTHER.'));
    expect(vlan.fieldErrors).toEqual({ vlan: 'VLAN 20 already belongs to controller interface OTHER.' });
    expect(vlan.skipped).toBe(3);
    expect(mapConfigureResult(p, failed(p.commands, 2, '% That subnet overlaps with controller interface management.')).fieldErrors).toEqual({
      address: 'That subnet overlaps with controller interface management.',
    });
    expect(mapConfigureResult(p, failed(p.commands, 0, '% A profile or interface name is 1 to 32 letters, digits, dots, dashes or underscores.')).fieldErrors.name).toBeDefined();
  });

  it('removes an interface with a field-less line (its refusal is a general message)', () => {
    const p = wlcInterfaceRemoveCommands(' STAFF-IF ');
    expect(p.commands).toEqual(['no wlc-interface STAFF-IF']);
    const out = mapConfigureResult(p, failed(p.commands, 0, '% WLAN 1 uses controller interface STAFF-IF; point it at another interface first.'));
    expect(out.fieldErrors).toEqual({});
    expect(out.general).toEqual(['no wlc-interface STAFF-IF: WLAN 1 uses controller interface STAFF-IF; point it at another interface first.']);
  });
});

// ── WLANs ────────────────────────────────────────────────────────────────────

describe('wlan lines', () => {
  it('writes a new WLAN exactly as §3.12 shows it, naming its interface', () => {
    const p = wlanCommands(STAFF);
    expect(p.commands).toEqual(['wlan 1 STAFF LabNet', ' security wpa2-psk', ' passphrase correct horse', ' interface STAFF-IF', ' no shutdown']);
    expect(p.options).toBe(PANEL_CONFIGURE_OPTIONS.nfos);
    // a new WLAN names its interface even when it is the management interface
    expect(wlanCommands({ ...STAFF, iface: 'management' }).commands).toContain(' interface management');
    // open security, 5 GHz only, not offered
    expect(wlanCommands({ ...STAFF, id: '7', profile: 'GUEST', ssid: 'Visitors', security: 'open', passphrase: '', radio: '5', enabled: false, iface: 'management' }).commands).toEqual([
      'wlan 7 GUEST Visitors',
      ' shutdown',
      ' security open',
      ' interface management',
      ' radio 5',
    ]);
  });

  it('attributes the header tokens to id, profile and ssid, and each line to its field', () => {
    const p = wlanCommands(STAFF);
    expect(p.lines[0]!.spans.map((s) => s.field)).toEqual(['id', 'id', 'profile', 'ssid']);
    expect(fieldAt(p, 0, 13)).toBe('ssid');
    expect(fieldAt(p, 0, 7)).toBe('profile');
    expect(p.lines[1]!.spans.every((s) => s.field === 'security')).toBe(true);
    expect(p.lines[2]!.spans.every((s) => s.field === 'passphrase')).toBe(true);
    expect(p.lines[3]!.spans.every((s) => s.field === 'iface')).toBe(true);
    expect(p.lines[4]!.spans.every((s) => s.field === 'enabled')).toBe(true);
    const out = mapConfigureResult(p, failed(p.commands, 3, '% There is no controller interface named STAFF-IF. Create it first under "wlc-interface STAFF-IF".'));
    expect(Object.keys(out.fieldErrors)).toEqual(['iface']);
  });

  it('edits in place: shut first, open drops the stored passphrase, back to every radio is `no radio`, offer last', () => {
    const stored: WlanForm = { ...STAFF, passphrase: '', hasPassphrase: true, radio: '5' };
    expect(isEmptyPlan(wlanCommands(stored, stored))).toBe(true);
    expect(wlanCommands({ ...stored, security: 'open', radio: 'all', enabled: false }, stored).commands).toEqual([
      'wlan 1 STAFF LabNet',
      ' shutdown',
      ' security open',
      ' no passphrase',
      ' no radio',
    ]);
    const shut = { ...stored, enabled: false };
    expect(wlanCommands({ ...shut, enabled: true, iface: 'management', passphrase: 'another secret' }, shut).commands).toEqual([
      'wlan 1 STAFF LabNet',
      ' passphrase another secret',
      ' interface management',
      ' no shutdown',
    ]);
    // an empty passphrase keeps the stored one
    expect(wlanLines({ ...stored, security: 'wpa3-sae' }, stored)).toEqual([[['security', 'security'], ['wpa3-sae', 'security']]]);
  });

  it('replaces the WLAN when its number, profile or network name changes', () => {
    const stored: WlanForm = { ...STAFF, passphrase: '', hasPassphrase: true };
    expect(sameWlanIdentity(STAFF, { ...STAFF, id: ' 01 ' })).toBe(true);
    expect(sameWlanIdentity(STAFF, { ...STAFF, ssid: 'Other' })).toBe(false);
    const p = wlanCommands({ ...stored, ssid: 'LabNet2', passphrase: 'new secret!' }, stored);
    expect(p.commands).toEqual(['no wlan 1', 'wlan 1 STAFF LabNet2', ' security wpa2-psk', ' passphrase new secret!', ' interface STAFF-IF', ' no shutdown']);
    expect(p.lines[0]!.spans.every((s) => s.field === null)).toBe(true);
    expect(wlanCommands({ ...stored, id: '2', enabled: false, passphrase: 'new secret!' }, stored).commands.slice(0, 3)).toEqual(['no wlan 1', 'wlan 2 STAFF LabNet', ' shutdown']);
    expect(wlanRemoveCommands(' 7 ').commands).toEqual(['no wlan 7']);
  });
});

// ── readers ──────────────────────────────────────────────────────────────────

describe('reading the controller sections', () => {
  it('lists the management interface first, then the others in config order', () => {
    const forms = wlcInterfaceFormsFrom(RUNNING);
    expect(forms).toEqual([MGMT, STAFF_IF]);
    expect(wlcManagementInterface()).toBe('management');
    // the management interface is predefined: a blank row before its section exists
    expect(wlcInterfaceFormsFrom('hostname WLC1\n!\nend')).toEqual([emptyWlcInterfaceForm('management')]);
  });

  it('reads WLANs by number, never their passphrase', () => {
    expect(wlanFormsFrom(RUNNING)).toEqual([
      { ...STAFF, passphrase: '', hasPassphrase: true },
      { id: '7', profile: 'GUEST', ssid: 'Visitors', security: 'open', passphrase: '', hasPassphrase: false, iface: 'management', radio: '5', enabled: false },
    ]);
    expect(nextFreeWlanId(wlanFormsFrom(RUNNING))).toBe('2');
    expect(nextFreeWlanId([])).toBe('1');
    expect(emptyWlanForm('3')).toEqual({ id: '3', profile: '', ssid: '', security: 'wpa2-psk', passphrase: '', hasPassphrase: false, iface: 'management', radio: 'all', enabled: true });
  });
});

// ── validation ───────────────────────────────────────────────────────────────

describe('client-side checks', () => {
  it('checks names, VLANs, WLAN numbers and network names like the controller grammar', () => {
    expect(checkWlcName('STAFF-IF', 'interface')).toBeUndefined();
    expect(checkWlcName('', 'interface')).toBe('Give the interface a name.');
    expect(checkWlcName('-bad', 'profile')).toMatch(/starts with a letter or digit/);
    expect(checkWlcName('a'.repeat(33), 'profile')).toBeDefined();
    expect(checkWlcVlan('20')).toBeUndefined();
    expect(checkWlcVlan('')).toBe('Every controller interface needs a VLAN.');
    expect(checkWlcVlan('4095')).toBe('Enter a VLAN number from 1 to 4094.');
    expect(checkWlcVlan('1003')).toMatch(/reserved/);
    expect(checkWlanId('512')).toBeUndefined();
    expect(checkWlanId('0')).toBe('Enter a WLAN number from 1 to 512.');
    expect(checkWlanSsid('LabNet')).toBeUndefined();
    expect(checkWlanSsid('Lab Net')).toMatch(/without spaces or colons/);
    expect(checkWlanSsid('Lab:Net')).toMatch(/without spaces or colons/);
    expect(checkWlanSsid('')).toBe('Enter the network name clients will see.');
  });

  it('validates an interface against the others', () => {
    const others = [MGMT];
    expect(validateWlcInterfaceForm(STAFF_IF, { others, isNew: true })).toEqual({});
    expect(validateWlcInterfaceForm({ ...STAFF_IF, name: 'management' }, { others: [], isNew: true }).name).toMatch(/already an interface named management/);
    expect(validateWlcInterfaceForm({ ...STAFF_IF, vlan: '99' }, { others, isNew: true }).vlan).toBe('VLAN 99 already belongs to the interface management.');
    expect(validateWlcInterfaceForm({ ...STAFF_IF, address: '192.168.99.7' }, { others, isNew: true }).address).toBe('This subnet overlaps with the interface management.');
    expect(validateWlcInterfaceForm({ ...STAFF_IF, address: '192.168.20.0' }, { others, isNew: true }).address).toMatch(/network address/);
    expect(validateWlcInterfaceForm({ ...STAFF_IF, mask: '' }, { others, isNew: true }).mask).toBeDefined();
    expect(validateWlcInterfaceForm({ ...STAFF_IF, gateway: '10.0.0.1' }, { others, isNew: true }).gateway).toBe('The gateway must be in the same subnet as the address.');
    expect(validateWlcInterfaceForm({ ...STAFF_IF, dhcpServer: '224.0.0.5' }, { others, isNew: true }).dhcpServer).toBe('That address cannot be a DHCP server.');
    // an interface without an address is fine; its gateway only has to be a host
    expect(validateWlcInterfaceForm({ ...STAFF_IF, address: '', mask: '', gateway: '10.0.0.1' }, { others, isNew: false })).toEqual({});
    expect(validateWlcInterfaceForm({ ...emptyWlcInterfaceForm('X') }, { others, isNew: true }).vlan).toBe('Every controller interface needs a VLAN.');
  });

  it('validates a WLAN: unique number, a known interface, and a passphrase whenever none can be kept', () => {
    const ctx = { others: [{ id: '7', profile: 'GUEST', ssid: 'Visitors' }], interfaces: ['management', 'STAFF-IF'] };
    expect(validateWlanForm(STAFF, undefined, ctx)).toEqual({});
    expect(validateWlanForm({ ...STAFF, id: '7' }, undefined, ctx).id).toBe('WLAN 7 already exists; choose another number.');
    expect(validateWlanForm({ ...STAFF, iface: 'NOPE' }, undefined, ctx).iface).toMatch(/create it on the Interfaces page first/);
    expect(validateWlanForm({ ...STAFF, iface: 'management' }, undefined, { ...ctx, interfaces: [] })).toEqual({});
    expect(validateWlanForm({ ...STAFF, passphrase: '' }, undefined, ctx).passphrase).toBe('Enter the password for this secured network.');
    expect(validateWlanForm({ ...STAFF, passphrase: 'short' }, undefined, ctx).passphrase).toMatch(/between 8 and 63/);
    const stored: WlanForm = { ...STAFF, passphrase: '', hasPassphrase: true };
    expect(validateWlanForm(stored, stored, ctx)).toEqual({});
    // replacing the WLAN loses the stored passphrase
    expect(validateWlanForm({ ...stored, ssid: 'LabNet2' }, stored, ctx).passphrase).toBeDefined();
    // leaving open security needs one too
    expect(validateWlanForm(stored, { ...stored, security: 'open' }, ctx).passphrase).toBeDefined();
    expect(validateWlanForm({ ...STAFF, security: 'open', passphrase: '' }, undefined, ctx)).toEqual({});
  });
});

// ── the real controller grammar ──────────────────────────────────────────────

describe('the controller accepts every line the builders write', () => {
  it('builds the §3.12 controller through configure, then edits and removes', () => {
    const sim = controller();
    const run = (commands: readonly string[]): ConfigureResult => sim.configure('wlc', [...commands], { ...PANEL_CONFIGURE_OPTIONS.nfos });
    for (const p of [wlcInterfaceCommands(MGMT, emptyWlcInterfaceForm('management')), wlcInterfaceCommands(STAFF_IF), wlanCommands(STAFF)]) {
      const r = run(p.commands);
      expect(r.lines.filter((l) => !l.ok).map((l) => `${l.line} ${l.error?.message ?? ''}`)).toEqual([]);
    }
    sim.runToIdle();
    expect(wlcInterfaceFormsFrom(running(sim))).toEqual([MGMT, STAFF_IF]);
    const read = wlanFormsFrom(running(sim));
    expect(read).toEqual([{ ...STAFF, passphrase: '', hasPassphrase: true }]);
    expect(running(sim)).toContain('ip default-gateway 192.168.99.1');

    // edit: open, 5 GHz only, not offered, on the management interface
    const stored = read[0] as WlanForm;
    const edited: WlanForm = { ...stored, security: 'open', radio: '5', enabled: false, iface: 'management' };
    expect(run(wlanCommands(edited, stored).commands).ok).toBe(true);
    expect(wlanFormsFrom(running(sim))).toEqual([{ ...edited, hasPassphrase: false }]);

    // replace (new network name), then remove the interface nothing uses any more and the WLAN
    const renamed = wlanCommands({ ...edited, hasPassphrase: false, ssid: 'LabNet2' }, { ...edited, hasPassphrase: false });
    expect(run(renamed.commands).ok).toBe(true);
    expect(wlanFormsFrom(running(sim)).map((w) => w.ssid)).toEqual(['LabNet2']);
    expect(run(wlcInterfaceCommands({ ...STAFF_IF, gateway: '', dhcpServer: '' }, STAFF_IF).commands).ok).toBe(true);
    expect(wlcInterfaceFormsFrom(running(sim))[1]).toEqual({ ...STAFF_IF, gateway: '', dhcpServer: '' });
    expect(run(wlcInterfaceRemoveCommands('STAFF-IF').commands).ok).toBe(true);
    expect(run(wlanRemoveCommands('1').commands).ok).toBe(true);
    expect(wlcInterfaceFormsFrom(running(sim)).map((i) => i.name)).toEqual(['management']);
    expect(wlanFormsFrom(running(sim))).toEqual([]);
  });

  it('refuses what the controller refuses, on the right field', () => {
    const sim = controller();
    // a WLAN naming an interface that does not exist
    const p = wlanCommands({ ...STAFF, iface: 'NOPE' });
    const out = mapConfigureResult(p, sim.configure('wlc', [...p.commands], { ...p.options }));
    expect(out.ok).toBe(false);
    expect(out.reverted).toBe(true);
    expect(Object.keys(out.fieldErrors)).toEqual(['iface']);
    // the management interface cannot be removed
    const rm = wlcInterfaceRemoveCommands('management');
    const gone = mapConfigureResult(rm, sim.configure('wlc', [...rm.commands], { ...rm.options }));
    expect(gone.general).toEqual(['no wlc-interface management: The management interface is built in and cannot be removed.']);
  });
});
