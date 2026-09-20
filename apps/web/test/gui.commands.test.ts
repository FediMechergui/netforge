// GUI command builders and forms (ARCHITECTURE-P1 D9, §3.12, §6, §8.1 W2 web-inspector): canonical config lines
// from settings forms, snapshot readers, validation, and per-line configure errors mapped to form fields.
import { describe, expect, it } from 'vitest';
import { emptyCounters } from '@netforge/engine';
import type { ConfigureResult, DeviceSnapshot, PortSnapshot, RadioPortSpec } from '@netforge/engine';
import {
  PANEL_CONFIGURE_OPTIONS,
  cellTowerCommands,
  emptyPlan,
  homeRouterCommands,
  interfaceAddressCommands,
  ipConfigCommands,
  isEmptyPlan,
  mergePlans,
  portAdminCommands,
  radioLinkCommands,
  wifiClientCommands,
  wirelessApCommands,
} from '../src/gui/commands.js';
import {
  checkChannel,
  checkGateway,
  checkInterfaceAddress,
  checkMask,
  checkPassphrase,
  checkSsid,
  checkTxPower,
  checkWidth,
  cleanCliMessage,
  configValue,
  defaultAdapter,
  deviceGrammar,
  fieldAt,
  globalConfigLines,
  hasErrors,
  homeRouterFormFrom,
  interfaceConfigLines,
  ipConfigFormFrom,
  mapConfigureResult,
  normalizeMask,
  radioLinkFormFrom,
  validateHomeRouterForm,
  validateIpConfigForm,
  validateRadioLinkForm,
  validateWifiClientForm,
  validateWirelessApForm,
  wifiClientFormFrom,
  wirelessApFormFrom,
} from '../src/gui/forms.js';
import type { HomeRouterForm, IpConfigForm, WifiClientForm, WirelessApForm } from '../src/gui/forms.js';

const AP_FORM: WirelessApForm = {
  port: 'Wlan0', enabled: true, ssid: 'Lab Net', security: 'wpa2-psk', passphrase: '', hasPassphrase: true,
  band: '2.4', channel: 'auto', widthMhz: '20', txPowerDbm: '20',
};

const SPEC_24: RadioPortSpec = {
  bands: ['2.4', '5'], generations: ['n', 'ac'], defaultBand: '2.4', defaultChannel: 1, maxTxPowerDbm: 20,
  antennaGainDbi: 2, streams: 2, maxWidthMhz: 80, maxRangeM: 300,
};

function port(id: string, extra: Partial<PortSnapshot> = {}): PortSnapshot {
  return { id, short: id, kind: 'ethernet', mac: '02:00:00:00:00:01', adminUp: true, operUp: true, mtu: 1500, counters: emptyCounters(), l3: {}, txQueue: 0, ...extra };
}

function device(ports: PortSnapshot[], runningConfig: string, extra: Partial<DeviceSnapshot> = {}): DeviceSnapshot {
  return {
    id: 'd1', type: 'x.y', model: 'NF-X', kind: 'ap', name: 'AP1', position: { x: 0, y: 0 }, power: true, booted: true, uptimeNs: 0,
    ports, tables: { cam: [], arp: [], rib: [] }, processes: [], runningConfig, hasStartupConfig: false, ...extra,
  };
}

function result(lines: ConfigureResult['lines'], ok = false, reverted = true): ConfigureResult {
  return { ok, lines, applied: 0, reverted, finalMode: 'config' };
}

describe('plans', () => {
  it('uses indented atomic runs for nfos and flat atomic runs for the host shell', () => {
    expect(PANEL_CONFIGURE_OPTIONS.nfos).toEqual({ indentation: true, stopOnError: true, atomic: true });
    expect(PANEL_CONFIGURE_OPTIONS.host).toEqual({ stopOnError: true, atomic: true });
    expect(isEmptyPlan(emptyPlan('nfos'))).toBe(true);
    const merged = mergePlans('nfos', [portAdminCommands('nfos', 'Gi0/0', true), portAdminCommands('nfos', 'Gi0/1', false)]);
    expect(merged.commands).toEqual(['interface Gi0/0', ' no shutdown', 'interface Gi0/1', ' shutdown']);
    expect(merged.options).toBe(PANEL_CONFIGURE_OPTIONS.nfos);
    expect(() => mergePlans('host', [portAdminCommands('nfos', 'Gi0/0', true)])).toThrow(RangeError);
  });

  it('shuts ports through interface lines or the host adapter command', () => {
    expect(portAdminCommands('nfos', 'GigabitEthernet0/1', false).commands).toEqual(['interface GigabitEthernet0/1', ' shutdown']);
    expect(portAdminCommands('host', 'GigabitEthernet0', true).commands).toEqual(['adapter GigabitEthernet0 up']);
    expect(portAdminCommands('host', 'Wlan0', false).commands).toEqual(['adapter Wlan0 down']);
  });

  it('records the field and columns of every token', () => {
    const p = ipConfigCommands('nfos', { adapter: 'Vlan1', address: '10.0.0.2', mask: '/24', gateway: '' });
    expect(p.commands).toEqual(['interface Vlan1', ' ip address 10.0.0.2 255.255.255.0']);
    expect(p.lines[1]!.indent).toBe(1);
    expect(p.lines[1]!.spans.map((s) => [s.start, s.end, s.field])).toEqual([
      [1, 3, 'address'], [4, 11, 'address'], [12, 20, 'address'], [21, 34, 'mask'],
    ]);
    expect(p.lines[0]!.spans.every((s) => s.field === null)).toBe(true);
  });
});

describe('IP configuration', () => {
  const base: IpConfigForm = { adapter: 'GigabitEthernet0', address: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' };

  it('writes the host shell line on the default adapter and only when something changed', () => {
    expect(ipConfigCommands('host', base, undefined, 'GigabitEthernet0').commands).toEqual(['ip address 192.168.1.10 255.255.255.0 192.168.1.1']);
    expect(isEmptyPlan(ipConfigCommands('host', { ...base, mask: '/24', address: '192.168.001.010' }, base, 'GigabitEthernet0'))).toBe(true);
    expect(ipConfigCommands('host', { ...base, gateway: '' }, base, 'GigabitEthernet0').commands).toEqual(['no ip address', 'ip address 192.168.1.10 255.255.255.0']);
    expect(ipConfigCommands('host', { ...base, address: '', mask: '', gateway: '' }, base, 'GigabitEthernet0').commands).toEqual(['no ip address']);
    expect(isEmptyPlan(ipConfigCommands('host', { ...base, address: '', mask: '', gateway: '' }, undefined, 'GigabitEthernet0'))).toBe(true);
    expect(() => ipConfigCommands('host', { ...base, adapter: 'Wlan0' }, undefined, 'GigabitEthernet0')).toThrow(RangeError);
  });

  it('writes interface and global lines on nfos devices', () => {
    const prev = { ...base, adapter: 'Vlan1' };
    expect(ipConfigCommands('nfos', prev).commands).toEqual(['interface Vlan1', ' ip address 192.168.1.10 255.255.255.0', 'ip default-gateway 192.168.1.1']);
    expect(ipConfigCommands('nfos', { ...prev, gateway: '' }, prev).commands).toEqual(['no ip default-gateway']);
    expect(ipConfigCommands('nfos', { ...prev, address: '', mask: '' }, prev).commands).toEqual(['interface Vlan1', ' no ip address']);
    expect(interfaceAddressCommands({ port: 'Gi0/0', address: '10.1.1.1', mask: '30' }).commands).toEqual(['interface Gi0/0', ' ip address 10.1.1.1 255.255.255.252']);
  });

  it('validates addresses, masks and gateways', () => {
    const ctx = { grammar: 'host' as const, defaultAdapter: 'GigabitEthernet0' };
    expect(validateIpConfigForm(base, ctx)).toEqual({});
    expect(validateIpConfigForm({ ...base, address: '', mask: '', gateway: '' }, ctx)).toEqual({});
    expect(Object.keys(validateIpConfigForm({ ...base, adapter: 'Wlan0' }, ctx))).toEqual(['adapter']);
    expect(Object.keys(validateIpConfigForm({ ...base, address: '192.168.1.0' }, ctx))).toEqual(['address']);
    expect(Object.keys(validateIpConfigForm({ ...base, mask: '255.0.255.0' }, ctx))).toEqual(['mask']);
    expect(Object.keys(validateIpConfigForm({ ...base, gateway: '10.0.0.1' }, ctx))).toEqual(['gateway']);
    expect(Object.keys(validateIpConfigForm({ ...base, address: '' }, ctx))).toEqual(['address']);
    expect(checkInterfaceAddress('192.168.1.255', '/24')).toContain('broadcast');
    expect(checkInterfaceAddress('127.0.0.1', '/8')).toContain('loopback');
    expect(checkInterfaceAddress('224.0.0.5', '/24')).toContain('multicast');
    expect(checkInterfaceAddress('10.0.0.0', '/31')).toBeUndefined();
    expect(checkGateway('192.168.1.10', '192.168.1.10', '/24')).toContain('another device');
    expect(checkMask('')).toBeDefined();
    expect(normalizeMask('/0')).toBeUndefined();
    expect(normalizeMask('0.0.0.0')).toBeUndefined();
    expect(normalizeMask('255.255.255.128')).toBe('255.255.255.128');
  });
});

describe('wireless radios', () => {
  it('emits only changed lines in a safe order', () => {
    expect(isEmptyPlan(wirelessApCommands(AP_FORM, AP_FORM))).toBe(true);
    const next: WirelessApForm = { ...AP_FORM, band: '5', channel: '36', widthMhz: '40', ssid: 'Guest', passphrase: 'correct horse' };
    expect(wirelessApCommands(next, AP_FORM).commands).toEqual([
      'interface Wlan0', ' band 5', ' channel 36', ' channel-width 40', ' ssid Guest', ' passphrase correct horse',
    ]);
    expect(wirelessApCommands({ ...AP_FORM, enabled: false, channel: '6' }, AP_FORM).commands).toEqual(['interface Wlan0', ' shutdown', ' channel 6']);
    expect(wirelessApCommands({ ...AP_FORM, enabled: true, txPowerDbm: '15' }, { ...AP_FORM, enabled: false }).commands).toEqual([
      'interface Wlan0', ' tx-power 15', ' no shutdown',
    ]);
  });

  it('removes the passphrase when the network becomes open and clears the name with no ssid', () => {
    expect(wirelessApCommands({ ...AP_FORM, security: 'open' }, AP_FORM).commands).toEqual(['interface Wlan0', ' security open', ' no passphrase']);
    expect(isEmptyPlan(wirelessApCommands({ ...AP_FORM, security: 'open', hasPassphrase: true }, { ...AP_FORM, security: 'open', hasPassphrase: true }))).toBe(true);
    expect(wirelessApCommands({ ...AP_FORM, ssid: '' }, AP_FORM).commands).toEqual(['interface Wlan0', ' no ssid']);
  });

  it('emits every value without a baseline and skips the width on 60 GHz', () => {
    const full = wirelessApCommands({ ...AP_FORM, band: '60', channel: '2', widthMhz: '2160', passphrase: 'abcdefgh' });
    expect(full.commands).toEqual([
      'interface Wlan0', ' band 60', ' channel 2', ' tx-power 20', ' ssid Lab Net', ' security wpa2-psk', ' passphrase abcdefgh', ' no shutdown',
    ]);
  });

  it('prefixes field keys for nested forms', () => {
    const p = wirelessApCommands({ ...AP_FORM, ssid: 'X' }, AP_FORM, 'radios.1.');
    expect(p.lines[1]!.spans.map((s) => s.field)).toEqual(['radios.1.ssid', 'radios.1.ssid']);
  });

  it('joins and leaves networks from the host shell or with interface lines', () => {
    const station: WifiClientForm = { port: 'Wlan0', ssid: 'LAB', security: 'wpa2-psk', passphrase: 'secret123', hasPassphrase: false };
    expect(wifiClientCommands('host', station).commands).toEqual(['wifi connect LAB key secret123']);
    expect(wifiClientCommands('host', { ...station, security: 'open', passphrase: '' }).commands).toEqual(['wifi connect LAB']);
    expect(wifiClientCommands('host', { ...station, ssid: '' }, station).commands).toEqual(['wifi disconnect']);
    expect(isEmptyPlan(wifiClientCommands('host', { ...station, passphrase: '' }, { ...station, passphrase: '' }))).toBe(true);
    expect(() => wifiClientCommands('host', { ...station, passphrase: '' })).toThrow(RangeError);
    expect(wifiClientCommands('nfos', station).commands).toEqual(['interface Wlan0', ' ssid LAB', ' security wpa2-psk', ' passphrase secret123']);
    expect(wifiClientCommands('nfos', { ...station, ssid: '' }, station).commands).toEqual(['interface Wlan0', ' no ssid']);
  });

  it('configures point-to-point radios and towers', () => {
    const radio = { port: 'Radio0', enabled: true, band: '5', channel: '36', txPowerDbm: '23', peerKey: '', hasPeerKey: true };
    expect(isEmptyPlan(radioLinkCommands(radio, radio))).toBe(true);
    expect(radioLinkCommands({ ...radio, channel: '40', peerKey: 'site a to b' }, radio).commands).toEqual([
      'interface Radio0', ' channel 40', ' peer-key site a to b',
    ]);
    expect(radioLinkCommands({ ...radio, band: '60', channel: '36', enabled: false }, radio).commands).toEqual([
      'interface Radio0', ' shutdown', ' band 60', ' channel 36',
    ]);
    const tower = { port: 'Cellular0', enabled: false, txPowerDbm: '40' };
    expect(cellTowerCommands({ ...tower, enabled: true, txPowerDbm: '43' }, tower).commands).toEqual(['interface Cellular0', ' tx-power 43', ' no shutdown']);
  });

  it('validates radio settings', () => {
    expect(validateWirelessApForm(AP_FORM, AP_FORM, SPEC_24)).toEqual({});
    expect(Object.keys(validateWirelessApForm({ ...AP_FORM, hasPassphrase: false }, AP_FORM))).toEqual(['passphrase']);
    expect(Object.keys(validateWirelessApForm({ ...AP_FORM, security: 'wpa3-sae' }, { ...AP_FORM, security: 'open' }))).toEqual(['passphrase']);
    expect(Object.keys(validateWirelessApForm({ ...AP_FORM, band: '6' }, AP_FORM, SPEC_24))).toEqual(['band']);
    expect(Object.keys(validateWirelessApForm({ ...AP_FORM, band: '6', channel: '36' }, AP_FORM, SPEC_24)).sort()).toEqual(['band', 'channel']);
    expect(checkChannel('5', '37', true)).toContain('does not exist');
    expect(checkChannel('2.4', 'auto', false)).toBeDefined();
    expect(checkChannel('2.4', '13', false)).toBeUndefined();
    expect(checkWidth('2.4', '80')).toContain('20 or 40');
    expect(checkWidth('5', '160', SPEC_24)).toContain('80 MHz');
    expect(checkWidth('60', 'anything')).toBeUndefined();
    expect(checkTxPower('21', SPEC_24)).toContain('0 to 20');
    expect(checkTxPower('-1')).toBeDefined();
    expect(checkSsid('a'.repeat(33))).toContain('32');
    expect(checkSsid(' lead')).toContain('start or end');
    expect(checkSsid('two  spaces')).toContain('two spaces');
    expect(checkSsid('two words', true)).toContain('spaces');
    expect(checkSsid('')).toBeUndefined();
    expect(checkPassphrase('wpa2-psk', 'short', false)).toContain('between 8 and 63');
    expect(checkPassphrase('open', '', true)).toBeUndefined();
    const station: WifiClientForm = { port: 'Wlan0', ssid: 'LAB', security: 'wpa3-sae', passphrase: 'secret123', hasPassphrase: true };
    expect(Object.keys(validateWifiClientForm(station, 'host'))).toEqual(['security']);
    expect(Object.keys(validateWifiClientForm({ ...station, security: 'wpa2-psk', passphrase: '' }, 'host', { ...station, security: 'wpa2-psk' }))).toEqual(['passphrase']);
    expect(validateWifiClientForm({ ...station, passphrase: '' }, 'nfos', station)).toEqual({});
    expect(Object.keys(validateRadioLinkForm({ port: 'Radio0', enabled: true, band: '5', channel: 'auto', txPowerDbm: '10', peerKey: 'k', hasPeerKey: false }))).toEqual(['channel']);
    expect(hasErrors({})).toBe(false);
  });
});

describe('home router', () => {
  const prev: HomeRouterForm = {
    lan: { port: 'Vlan1', address: '192.168.0.1', mask: '255.255.255.0' },
    wan: { port: 'Internet', address: '203.0.113.2', mask: '255.255.255.252', gateway: '203.0.113.1' },
    radios: [AP_FORM, { ...AP_FORM, port: 'Wlan1', band: '5', channel: '36' }],
  };

  it('replaces the default route and prefixes each part', () => {
    const next: HomeRouterForm = {
      ...prev,
      lan: { ...prev.lan, address: '192.168.10.1' },
      wan: { ...prev.wan, address: '198.51.100.6', gateway: '198.51.100.5' },
      radios: [prev.radios[0]!, { ...prev.radios[1]!, ssid: 'Fast' }],
    };
    const p = homeRouterCommands(next, prev);
    expect(p.commands).toEqual([
      'interface Vlan1', ' ip address 192.168.10.1 255.255.255.0',
      'interface Internet', ' ip address 198.51.100.6 255.255.255.252',
      'no ip route 0.0.0.0 0.0.0.0 203.0.113.1', 'ip route 0.0.0.0 0.0.0.0 198.51.100.5',
      'interface Wlan1', ' ssid Fast',
    ]);
    expect(p.lines[1]!.spans.at(-1)!.field).toBe('lan.mask');
    expect(p.lines[7]!.spans[1]!.field).toBe('radios.1.ssid');
    expect(isEmptyPlan(homeRouterCommands(prev, prev))).toBe(true);
  });

  it('validates every part with dotted field keys', () => {
    expect(validateHomeRouterForm(prev, prev)).toEqual({});
    const errors = validateHomeRouterForm({
      lan: { port: 'Vlan1', address: '', mask: '' },
      wan: { ...prev.wan, gateway: '10.9.9.9' },
      radios: [{ ...prev.radios[0]!, channel: '99' }],
    }, prev);
    expect(Object.keys(errors).sort()).toEqual(['lan.address', 'radios.0.channel', 'wan.gateway']);
  });
});

describe('snapshot readers', () => {
  const config = [
    'hostname AP1',
    '!',
    'interface GigabitEthernet0',
    ' ip address 10.0.0.2 255.255.255.0',
    '!',
    'interface Wlan0',
    ' ssid Lab Net',
    ' security wpa2-psk',
    ' passphrase secret123',
    ' channel auto',
    ' shutdown',
    '!',
    'interface Radio0',
    ' band 5',
    ' peer-key abc',
    '!',
    'ip default-gateway 10.0.0.1',
    'ip route 0.0.0.0 0.0.0.0 203.0.113.1',
    'end',
  ].join('\n');

  const radio = { mode: 'ap' as const, band: '2.4' as const, channel: 6, widthMhz: 20 as const, txPowerDbm: 17, up: false, rangeM: 100 };
  const dev = device(
    [
      port('GigabitEthernet0', { role: 'switched' }),
      port('Wlan0', { kind: 'wlan', role: 'wireless-bss', adminUp: false, radio }),
      port('Radio0', { kind: 'radio', role: 'radio-ptp', radio: { ...radio, mode: 'ptp', band: '5', channel: 36 } }),
      port('Vlan1', { kind: 'virtual', role: 'svi', l3: { ipv4: { address: '192.168.0.1', prefixLen: 24 } } }),
      port('Internet', { role: 'wan' }),
    ],
    config,
    { hostPorts: ['Vlan1'], cli: { shell: 'none', grammar: 'nfos' } },
  );

  it('reads interface and global lines of the rendered config', () => {
    const wlan = interfaceConfigLines(config, 'Wlan0');
    expect(configValue(wlan, ['ssid'])).toBe('Lab Net');
    expect(configValue(wlan, ['channel'])).toBe('auto');
    expect(configValue(wlan, ['band'])).toBeUndefined();
    expect(configValue(globalConfigLines(config), ['ip', 'default-gateway'])).toBe('10.0.0.1');
    expect(interfaceConfigLines(config, 'Missing')).toEqual([]);
  });

  it('builds forms from configured lines, live radio state and port addresses', () => {
    expect(wirelessApFormFrom(dev, 'Wlan0')).toEqual({
      port: 'Wlan0', enabled: false, ssid: 'Lab Net', security: 'wpa2-psk', passphrase: '', hasPassphrase: true,
      band: '2.4', channel: 'auto', widthMhz: '20', txPowerDbm: '17',
    });
    expect(wifiClientFormFrom(dev, 'Wlan0')).toEqual({ port: 'Wlan0', ssid: 'Lab Net', security: 'wpa2-psk', passphrase: '', hasPassphrase: true });
    expect(radioLinkFormFrom(dev, 'Radio0')).toEqual({ port: 'Radio0', enabled: true, band: '5', channel: '36', txPowerDbm: '17', peerKey: '', hasPeerKey: true });
    expect(ipConfigFormFrom(dev)).toEqual({ adapter: 'Vlan1', address: '192.168.0.1', mask: '255.255.255.0', gateway: '10.0.0.1' });
    expect(ipConfigFormFrom(dev, 'GigabitEthernet0')).toEqual({ adapter: 'GigabitEthernet0', address: '10.0.0.2', mask: '255.255.255.0', gateway: '10.0.0.1' });
    const home = homeRouterFormFrom(dev);
    expect(home.lan).toEqual({ port: 'Vlan1', address: '192.168.0.1', mask: '255.255.255.0' });
    expect(home.wan).toEqual({ port: 'Internet', address: '', mask: '', gateway: '203.0.113.1' });
    expect(home.radios.map((r) => r.port)).toEqual(['Wlan0']);
    expect(defaultAdapter(dev)).toBe('Vlan1');
    expect(defaultAdapter(device([port('Gi0')], ''))).toBe('Gi0');
    expect(deviceGrammar(dev)).toBe('nfos');
    expect(deviceGrammar(device([], '', { cli: { shell: 'host', grammar: 'host' } }))).toBe('host');
  });

  it('round-trips a loaded form into an empty plan', () => {
    const form = wirelessApFormFrom(dev, 'Wlan0');
    expect(isEmptyPlan(wirelessApCommands(form, form))).toBe(true);
    const home = homeRouterFormFrom(dev);
    expect(isEmptyPlan(homeRouterCommands(home, home))).toBe(true);
  });
});

describe('configure result mapping', () => {
  const p = ipConfigCommands('nfos', { adapter: 'Vlan1', address: '10.0.0.2', mask: '255.0.255.0', gateway: '10.0.0.1' });

  it('maps caret columns to fields with or without indentation in the column', () => {
    expect(p.commands[1]).toBe(' ip address 10.0.0.2 255.0.255.0');
    expect(fieldAt(p, 1, 21)).toBe('mask');
    expect(fieldAt(p, 1, 20)).toBe('mask');
    expect(fieldAt(p, 1, 11)).toBe('address');
    expect(fieldAt(p, 1)).toBe('address');
    expect(fieldAt(p, 2, 19)).toBe('gateway');
    expect(fieldAt(p, 0, 0)).toBeNull();
    expect(fieldAt(p, 9, 0)).toBeNull();
  });

  it('collects field errors, general errors and skipped lines', () => {
    const outcome = mapConfigureResult(p, result([
      { index: 0, line: 'interface Vlan1', ok: true, output: '', mode: 'config-if' },
      { index: 1, line: p.commands[1]!, ok: false, output: '', error: { message: '% Invalid input detected at the marked position', column: 21 }, mode: 'config-if' },
      { index: 2, line: p.commands[2]!, ok: false, output: '', mode: 'config', skipped: true },
    ]));
    expect(outcome).toEqual({
      ok: false, reverted: true, fieldErrors: { mask: 'Invalid input detected at the marked position' }, general: [], skipped: 1,
    });
    const general = mapConfigureResult(p, result([{ index: 0, line: 'interface Vlan1', ok: false, output: '% Unknown interface', mode: 'config' }], false, false));
    expect(general.general).toEqual(['interface Vlan1: Unknown interface']);
    expect(general.reverted).toBe(false);
    expect(mapConfigureResult(p, result([], false, false)).general).toEqual(['The device did not accept these settings.']);
    expect(mapConfigureResult(p, result([], true, false)).ok).toBe(true);
    expect(cleanCliMessage('%  Bad mask ')).toBe('Bad mask');
  });
});
