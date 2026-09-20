/**
 * cli/handlers P0.5 (ARCHITECTURE-P1 §3.9, §3.10, §3.13, §6): mode navigation through `enterMode`, virtual interface
 * creation and removal, switchport role locks, serial and radio line validation, host shell Wi-Fi/adapter expansions,
 * multi-adapter ipconfig, and the show outputs for serial line state, secrets, controllers, wireless, inventory and the
 * switch-port status table. Handlers run against a recording CommandCtx over real catalog models.
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES, type CommandHandler } from '../src/contracts/cli.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import { CONFIG_SECRET_MASK } from '../src/cli/config-rules.js';
import { HANDLERS, MSG_INTERFACE_NOT_CONFIGURABLE, MSG_NOT_ACCESS_RADIO, MSG_NOT_SERIAL } from '../src/cli/grammar/index.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import { MSG_CANNOT_CREATE_INTERFACE } from '../src/cli/handlers/config.js';
import { MSG_NO_WIFI_ADAPTER, visibleNetworks } from '../src/cli/handlers/host.js';
import { MSG_PPP_NOT_AVAILABLE, NOTE_CLOCK_ON_DTE } from '../src/cli/handlers/serial.js';
import { maskConfigSecrets } from '../src/cli/handlers/show.js';
import { MSG_AUTO_CHANNEL_PTP, MSG_WIDTH_FIXED_60 } from '../src/cli/handlers/wireless.js';
import { testPortSpec } from './port.fixtures.js';
import { catalogModel, commandCtxFor, devicePortViews, type CommandCtxOptions, type RecordingCtx } from './cli.p05.fixture.js';

function handler(id: string): CommandHandler {
  const h = HANDLER_REGISTRY[id];
  if (h === undefined) throw new Error(`no handler ${id}`);
  return h;
}

function run(rec: RecordingCtx, id: string, args: Record<string, string> = {}, negate = false) {
  return handler(id)(rec.ctx, args, negate);
}

function device(type: string, opts: CommandCtxOptions = {}): RecordingCtx {
  return commandCtxFor(catalogModel(type), opts);
}

const lines = (s: string | undefined): string[] => (s ?? '').split('\n');

describe('mode navigation', () => {
  it('exit pops config-if to config and config to priv-exec; exec modes close the session', () => {
    const inIf = device('router.nf2911', { iface: 'GigabitEthernet0/0' });
    run(inIf, HANDLERS.execExit);
    expect(inIf.enterModeCalls).toEqual([{ mode: 'config', opts: { context: [] } }]);
    const inConfig = device('router.nf2911', { mode: 'config' });
    run(inConfig, HANDLERS.execExit);
    expect(inConfig.enterModeCalls).toEqual([{ mode: 'priv-exec', opts: { context: [] } }]);
    const inExec = device('router.nf2911', { mode: 'priv-exec' });
    run(inExec, HANDLERS.execExit);
    expect(inExec.closed.value).toBe(true);
    expect(inExec.enterModeCalls).toEqual([]);
  });

  it('end, configure, enable and disable enter their modes through enterMode (the P0 setMode shape is gone)', () => {
    const r = device('router.nf2911', { iface: 'GigabitEthernet0/0' });
    run(r, HANDLERS.execEnd);
    run(r, HANDLERS.execConfigure);
    expect(r.enterModeCalls.map((c) => c.mode)).toEqual(['priv-exec', 'config']);
    const inIf = device('router.nf2911', { iface: 'GigabitEthernet0/0' });
    run(inIf, HANDLERS.execExit);
    run(inIf, HANDLERS.execEnable);
    expect(inIf.enterModeCalls).toEqual([{ mode: 'config', opts: { context: [] } }, { mode: 'priv-exec', opts: { context: [] } }]);
    expect(inIf.setModeCalls).toEqual([]);
    expect(inIf.deviceCalls).toContain('setPrivilege 15');
  });
});

describe('interface selection and virtual interfaces', () => {
  it('creates a missing virtual interface, writes the section and enters config-if', () => {
    const r = device('router.nf2911');
    expect(run(r, HANDLERS.configInterface, { iface: 'Loopback0' })).toEqual({});
    expect(r.deviceCalls).toEqual(['ensureVirtualPort Loopback0']);
    expect(r.configCalls).toEqual([{ line: ['interface', 'Loopback0'], negate: false, context: [] }]);
    expect(r.enterModeCalls).toEqual([{ mode: 'config-if', opts: { iface: 'Loopback0', context: [['interface', 'Loopback0']] } }]);
  });

  it('reports the device refusal, a runtime without virtual ports and a non-configurable port', () => {
    const refused = device('router.nf2911', { ensureVirtualPort: () => ({ ok: false, error: 'Loopback interfaces on this device are numbered 0 to 9.' }) });
    expect(run(refused, HANDLERS.configInterface, { iface: 'Loopback99' }).error).toBe('% Loopback interfaces on this device are numbered 0 to 9.');
    expect(refused.configCalls).toEqual([]);
    const cannot = device('router.nf2911', { ensureVirtualPort: () => ({ ok: false, error: MSG_CANNOT_CREATE_INTERFACE }) });
    expect(run(cannot, HANDLERS.configInterface, { iface: 'Loopback0' }).error).toBe(MSG_CANNOT_CREATE_INTERFACE);
    expect(run(device('router.nf2911'), HANDLERS.configInterface, { iface: 'Console' }).error).toBe(MSG_INTERFACE_NOT_CONFIGURABLE);
    const existing = device('router.nf2911');
    run(existing, HANDLERS.configInterface, { iface: 'GigabitEthernet0/1' });
    expect(existing.deviceCalls).toEqual([]);
    expect(existing.enterModeCalls[0]?.opts).toEqual({ iface: 'GigabitEthernet0/1', context: [['interface', 'GigabitEthernet0/1']] });
  });

  it('no interface removes virtual interfaces only', () => {
    const ml = device('mlswitch.nfc3650-24', { removeVirtualPort: (n) => (n === 'Vlan1' ? { ok: false, error: 'This interface is built in and cannot be removed.' } : { ok: true }) });
    expect(run(ml, HANDLERS.configInterface, { iface: 'Vlan1' }, true).error).toBe('% This interface is built in and cannot be removed.');
    expect(run(ml, HANDLERS.configInterface, { iface: 'Vlan20' }, true)).toEqual({});
    expect(ml.deviceCalls).toEqual(['removeVirtualPort Vlan1', 'removeVirtualPort Vlan20']);
    expect(run(ml, HANDLERS.configInterface, { iface: 'GigabitEthernet1/0/1' }, true).error).toMatch(/physical interface and cannot be removed/);
    const noOps = device('router.nf2911', { removeVirtualPort: () => ({ ok: false }) });
    expect(run(noOps, HANDLERS.configInterface, { iface: 'Loopback3' }, true).error).toMatch(/no interface called Loopback3/);
  });

  it('ip default-gateway validates and writes the global line', () => {
    const ap = device('ap.nfap-auto');
    expect(run(ap, HANDLERS.configDefaultGateway, { gateway: '224.0.0.1' }).error).toMatch(/cannot be used as a default gateway/);
    run(ap, HANDLERS.configDefaultGateway, { gateway: '10.0.0.1' });
    run(ap, HANDLERS.configDefaultGateway, {}, true);
    expect(ap.configCalls).toEqual([
      { line: ['ip', 'default-gateway', '10.0.0.1'], negate: false, context: [] },
      { line: ['ip', 'default-gateway'], negate: true, context: [] },
    ]);
  });
});

describe('switchport', () => {
  it('an L2 switch port and a router port are role-locked', () => {
    const sw = device('switch.nfc2960', { iface: 'FastEthernet0/1' });
    expect(run(sw, HANDLERS.ifSwitchport, {}, true).error).toBe(CLI_MESSAGES.roleLocked);
    expect(sw.configCalls).toEqual([]);
    expect(run(device('router.nf2911', { iface: 'GigabitEthernet0/0' }), HANDLERS.ifSwitchport).error).toBe(CLI_MESSAGES.roleLocked);
  });

  it('a multilayer switch port writes the stored negation', () => {
    const ml = device('mlswitch.nfc3650-24', { iface: 'GigabitEthernet1/0/24' });
    expect(run(ml, HANDLERS.ifSwitchport, {}, true)).toEqual({});
    expect(ml.configCalls).toEqual([{ line: ['switchport'], negate: true, context: undefined }]);
    expect(ml.running.render()).toContain('interface GigabitEthernet1/0/24\n no switchport');
  });
});

describe('serial lines', () => {
  it('clock rate accepts standard rates and notes a DTE end', () => {
    const r = device('router.nf2911', { iface: 'Serial0/0/0' });
    expect(run(r, HANDLERS.ifClockRate, { bps: '64000' })).toEqual({});
    expect(run(r, HANDLERS.ifClockRate, { bps: '65000' }).error).toMatch(/not a supported clock rate/);
    expect(r.configCalls).toEqual([{ line: ['clock', 'rate', '64000'], negate: false, context: undefined }]);
    const ports = devicePortViews(catalogModel('router.nf2911'), { patch: { 'Serial0/0/0': { phy: { carrier: true, lineProtocol: true, dce: false } } } });
    const dte = device('router.nf2911', { iface: 'Serial0/0/0', ports });
    expect(run(dte, HANDLERS.ifClockRate, { bps: '64000' })).toEqual({ output: NOTE_CLOCK_ON_DTE });
    expect(run(device('router.nf2911', { iface: 'GigabitEthernet0/0' }), HANDLERS.ifClockRate, { bps: '64000' }).error).toBe(MSG_NOT_SERIAL);
  });

  it('encapsulation refuses ppp, keepalive and bandwidth write their lines', () => {
    const r = device('router.nf2911', { iface: 'Serial0/0/1' });
    expect(run(r, HANDLERS.ifEncapsulation, { framing: 'ppp' }).error).toBe(MSG_PPP_NOT_AVAILABLE);
    run(r, HANDLERS.ifEncapsulation, { framing: 'hdlc' });
    run(r, HANDLERS.ifKeepalive, {});
    run(r, HANDLERS.ifKeepalive, { seconds: '0' });
    run(r, HANDLERS.ifKeepalive, {}, true);
    run(r, HANDLERS.ifBandwidth, { kbps: '1544' });
    expect(r.configCalls.map((c) => [c.line, c.negate])).toEqual([
      [['encapsulation', 'hdlc'], false],
      [['keepalive'], false],
      [['keepalive', '0'], false],
      [['keepalive'], true],
      [['bandwidth', '1544'], false],
    ]);
    expect(r.running.render()).toContain(' no keepalive');
  });
});

describe('radio lines', () => {
  it('validates band, channel, width and power against the access point radio', () => {
    const ap = device('ap.nfap-auto', { iface: 'Wlan0' });
    expect(run(ap, HANDLERS.ifBand, { band: '5' }).error).toMatch(/does not support the 5 GHz band/);
    expect(run(ap, HANDLERS.ifChannel, { channel: '36' }).error).toMatch(/Channel 36 does not exist on the 2.4 GHz band/);
    expect(run(ap, HANDLERS.ifChannelWidth, { mhz: '80' }).error).toMatch(/up to 40 MHz/);
    expect(run(ap, HANDLERS.ifTxPower, { dbm: '25' }).error).toMatch(/20 dBm at most/);
    expect(run(ap, HANDLERS.ifPassphrase, { text: 'short' }).error).toMatch(/8 to 63/);
    run(ap, HANDLERS.ifChannel, { channel: '11' });
    run(ap, HANDLERS.ifChannel, { channel: 'auto' });
    run(ap, HANDLERS.ifChannelWidth, { mhz: '40' });
    run(ap, HANDLERS.ifTxPower, { dbm: '18' });
    run(ap, HANDLERS.ifSsid, { name: 'LAB NET' });
    run(ap, HANDLERS.ifSecurity, { mode: 'wpa2-psk' });
    run(ap, HANDLERS.ifPassphrase, { text: 'long enough phrase' });
    run(ap, HANDLERS.ifBeacons);
    expect(ap.configCalls.map((c) => c.line)).toEqual([
      ['channel', '11'], ['channel', 'auto'], ['channel-width', '40'], ['tx-power', '18'],
      ['ssid', 'LAB NET'], ['security', 'wpa2-psk'], ['passphrase', 'long enough phrase'], ['beacons'],
    ]);
  });

  it('a band change clears a channel the new band lacks', () => {
    const laptop = device('laptop.nflaptop', { iface: 'Wlan0' });
    run(laptop, HANDLERS.ifChannel, { channel: '11' });
    const r = run(laptop, HANDLERS.ifBand, { band: '5' });
    expect(r.output).toMatch(/Channel 11 does not exist on the 5 GHz band/);
    expect(laptop.configCalls.map((c) => [c.line, c.negate])).toEqual([[['channel', '11'], false], [['band', '5'], false], [['channel'], true]]);
    expect(run(laptop, HANDLERS.ifChannel, { channel: '36' })).toEqual({});
    expect(run(laptop, HANDLERS.ifBeacons).error).toBe(MSG_NOT_ACCESS_RADIO);
  });

  it('point-to-point radios need a fixed channel, a fixed 60 GHz width and a pairing key of 4+ characters', () => {
    const ptp = device('radio.nfptp60', { iface: 'Radio0' });
    expect(run(ptp, HANDLERS.ifChannel, { channel: 'auto' }).error).toBe(MSG_AUTO_CHANNEL_PTP);
    expect(run(ptp, HANDLERS.ifChannelWidth, { mhz: '80' }).error).toBe(MSG_WIDTH_FIXED_60);
    expect(run(ptp, HANDLERS.ifPeerKey, { key: 'abc' }).error).toMatch(/4 to 64/);
    expect(run(ptp, HANDLERS.ifPeerKey, { key: 'abcd' })).toEqual({});
    expect(run(ptp, HANDLERS.ifChannel, { channel: '3' })).toEqual({});
  });
});

describe('host shell', () => {
  it('wifi connect writes security, passphrase and ssid (last) under the Wi-Fi adapter', () => {
    const laptop = device('laptop.nflaptop', { mode: 'user-exec' });
    const r = run(laptop, HANDLERS.hostWifiConnect, { ssid: 'LAB', key: 'secret123' });
    expect(r.output).toMatch(/^Wlan0 is joining "LAB" with WPA2 personal security/);
    const ctx = [['interface', 'Wlan0']];
    expect(laptop.configCalls).toEqual([
      { line: ['security', 'wpa2-psk'], negate: false, context: ctx },
      { line: ['passphrase', 'secret123'], negate: false, context: ctx },
      { line: ['ssid', 'LAB'], negate: false, context: ctx },
    ]);
    const open = device('laptop.nflaptop', { mode: 'user-exec' });
    run(open, HANDLERS.hostWifiConnect, { ssid: 'CAFE' });
    expect(open.configCalls.map((c) => [c.line, c.negate])).toEqual([[['security', 'open'], false], [['passphrase'], true], [['ssid', 'CAFE'], false]]);
    expect(run(open, HANDLERS.hostWifiConnect, { ssid: 'LAB', key: 'short' }).error).toMatch(/8 to 63/);
    expect(run(device('pc.nfpc', { mode: 'user-exec' }), HANDLERS.hostWifiConnect, { ssid: 'LAB' }).error).toBe(MSG_NO_WIFI_ADAPTER);
  });

  it('wifi disconnect removes the ssid; wifi list shows the association and the scan list', () => {
    const laptop = device('laptop.nflaptop', { mode: 'user-exec' });
    expect(run(laptop, HANDLERS.hostWifiDisconnect).output).toBe('Wlan0 is not connected to a wireless network.');
    run(laptop, HANDLERS.hostWifiConnect, { ssid: 'LAB' });
    laptop.configCalls.length = 0;
    expect(run(laptop, HANDLERS.hostWifiDisconnect).output).toBe('Wlan0 has left "LAB".');
    expect(laptop.configCalls).toEqual([{ line: ['ssid'], negate: true, context: [['interface', 'Wlan0']] }]);

    const bss = { ssid: 'LAB', bssid: '02:00:00:00:00:10', band: '2.4', channel: 1, security: 'wpa2-psk', rssiDbm: -50, snrDb: 40, canAssociate: true };
    const withScan = device('laptop.nflaptop', { mode: 'user-exec', processStates: { 'wlan-client': { process: 'wlan-client', state: { ports: { Wlan0: { visible: [bss, { junk: 1 }] } } } } } });
    run(withScan, HANDLERS.hostWifiConnect, { ssid: 'LAB' });
    withScan.assoc.set({ key: 'Wlan0|02:00:00:00:00:20', port: 'Wlan0', station: '02:00:00:00:00:20', bssid: bss.bssid, ssid: 'LAB', state: 'associated', rssiDbm: -50, updatedAt: 0 });
    const out = lines(run(withScan, HANDLERS.hostWifiList).output);
    expect(out[0]).toBe('Wlan0: network "LAB", associated, signal -50 dBm.');
    expect(out[3]).toMatch(/^LAB\s+wpa2-psk\s+2\.4 GHz\s+1\s+-50 dBm$/);
    expect(withScan.requests).toEqual([{ to: 'wlan-client', req: { kind: 'wlan.scan', port: 'Wlan0' } }]);
    expect(visibleNetworks({ scan: { Wlan0: [bss] } }, 'Wlan0')).toEqual([bss]);
    expect(visibleNetworks(undefined, 'Wlan0')).toEqual([]);
  });

  it('adapter toggles shutdown; ip address uses the first host port (an SVI on the IP phone)', () => {
    const laptop = device('laptop.nflaptop', { mode: 'user-exec' });
    expect(run(laptop, HANDLERS.hostAdapter, { iface: 'Wlan0', state: 'down' }).output).toBe('Wlan0 is now disabled.');
    expect(laptop.configCalls).toEqual([{ line: ['shutdown'], negate: false, context: [['interface', 'Wlan0']] }]);
    const phone = device('ipphone.nfphone', { mode: 'user-exec' });
    run(phone, HANDLERS.pcIpAddress, { address: '10.0.0.5', mask: '255.255.255.0' });
    expect(phone.configCalls[0]?.context).toEqual([['interface', 'Vlan1']]);
  });

  it('ipconfig prints one block per adapter, with the Wi-Fi network', () => {
    const laptop = device('laptop.nflaptop', { mode: 'user-exec' });
    run(laptop, HANDLERS.hostWifiConnect, { ssid: 'LAB' });
    const out = run(laptop, HANDLERS.pcIpconfig).output ?? '';
    const blocks = out.split('\n\n');
    expect(blocks).toHaveLength(2);
    expect(lines(blocks[0])[0]).toBe('GigabitEthernet0 (link up)');
    expect(lines(blocks[1])).toEqual([
      'Wlan0 (link up)',
      '  Physical address ....: 00:00:00:00:00:01',
      '  Wireless network ....: LAB (connected)',
      '  IPv4 address ........: not set',
      '  Subnet mask .........: not set',
      '  Default gateway .....: not set',
    ]);
  });
});

describe('show outputs', () => {
  it('show interfaces prints the serial line protocol state, framing without MAC, bandwidth and role', () => {
    const model = catalogModel('router.nf2911');
    const ports = devicePortViews(model, {
      patch: { 'Serial0/0/0': { operUp: false, link: 'l_1', phy: { carrier: true, lineProtocol: false, lineProtocolReason: 'no-clock', dce: true } } },
    });
    const r = device('router.nf2911', { mode: 'priv-exec', ports });
    run(r, HANDLERS.ifBandwidth, { kbps: '64' });
    const noop = r.configCalls.length;
    expect(noop).toBe(0);
    r.running.set([['interface', 'Serial0/0/0']], ['bandwidth', '64']);
    const out = lines(run(r, HANDLERS.showInterfaces, { iface: 'Serial0/0/0' }).output);
    expect(out[0]).toBe('Serial0/0/0: admin up, link up, line protocol down (no clock rate on the DCE end)');
    expect(out[1]).toBe('  Serial port, HDLC framing, no hardware address');
    expect(out[2]).toBe('  MTU 1500 bytes, bandwidth 64 kb/s');
    expect(out).toContain('  Role: WAN interface');
    expect(run(r, HANDLERS.showInterfaces).output).not.toContain('Console:');
  });

  it('virtual interfaces print their role label; the SVI has a MAC, a loopback does not', () => {
    const ml = device('mlswitch.nfc3650-24', { mode: 'priv-exec' });
    expect(lines(run(ml, HANDLERS.showInterfaces, { iface: 'Vlan1' }).output)[1]).toBe('  Switch virtual interface, MAC 0000.0000.0001 (00:00:00:00:00:01)');
    const model = catalogModel('router.nf2911');
    const ports = devicePortViews(model);
    ports.set('Loopback0', { ...ports.get('GigabitEthernet0/0')!, id: 'Loopback0', role: 'virtual', encap: 'none', spec: testPortSpec({ name: 'Loopback0', short: 'Lo0', kind: 'virtual', speedBps: 0, role: 'virtual', encap: 'none' }, [], 0) });
    const r = device('router.nf2911', { mode: 'priv-exec', ports });
    expect(lines(run(r, HANDLERS.showInterfaces, { iface: 'Loopback0' }).output)[1]).toBe('  Virtual interface, no hardware address');
    expect(lines(run(r, HANDLERS.showIpIntBrief).output).map((l) => l.split(/\s+/)[0])).toEqual([
      'Interface', 'GigabitEthernet0/0', 'GigabitEthernet0/1', 'Serial0/0/0', 'Serial0/0/1', 'Loopback0',
    ]);
  });

  it('secrets are masked below privilege 15 and shown at 15', () => {
    const running = createConfigAst();
    running.set([], ['enable', 'secret', 's3cr3t']);
    running.set([['interface', 'Wlan0']], ['passphrase', 'my wifi passphrase']);
    running.set([['interface', 'Wlan0']], ['ssid', 'LAB']);
    const low = device('ap.nfap-auto', { mode: 'user-exec', privilege: 1, running });
    const out = run(low, HANDLERS.showRunning).output ?? '';
    expect(out).not.toContain('s3cr3t');
    expect(out).not.toContain('my wifi passphrase');
    expect(out).toContain(`enable secret ${CONFIG_SECRET_MASK}`);
    expect(out).toContain(` passphrase ${CONFIG_SECRET_MASK}`);
    expect(out).toContain(' ssid LAB');
    expect(run(device('ap.nfap-auto', { mode: 'priv-exec', running }), HANDLERS.showRunning).output).toContain(' passphrase my wifi passphrase');
    expect(maskConfigSecrets('hostname R1')).toBe('hostname R1');
  });

  it('show controllers serial reports the cable end, clock, framing and line', () => {
    const model = catalogModel('router.nf2911');
    const ports = devicePortViews(model, {
      patch: {
        'Serial0/0/0': { link: 'l_1', operUp: true, phy: { carrier: true, lineProtocol: true, dce: true } },
        'Serial0/0/1': { link: 'l_2', operUp: false, phy: { carrier: true, lineProtocol: false, lineProtocolReason: 'keepalive-missed', dce: false } },
      },
    });
    const r = device('router.nf2911', { mode: 'priv-exec', ports });
    r.running.set([['interface', 'Serial0/0/0']], ['clock', 'rate', '64000']);
    r.running.unset([['interface', 'Serial0/0/1']], ['keepalive']);
    const blocks = (run(r, HANDLERS.showControllers).output ?? '').split('\n\n');
    expect(lines(blocks[0])).toEqual([
      'Serial0/0/0: DCE end of the serial cable',
      '  Clock: supplied at 64000 bit/s',
      '  Framing: HDLC, keepalive every 10 s',
      '  Line: carrier up, protocol up',
    ]);
    expect(lines(blocks[1])).toEqual([
      'Serial0/0/1: DTE end of the serial cable',
      '  Clock: taken from the DCE end',
      '  Framing: HDLC, keepalives off',
      '  Line: carrier up, protocol down (keepalives from the other end stopped arriving)',
    ]);
    expect(run(device('switch.nfc2960', { mode: 'priv-exec' }), HANDLERS.showControllers).error).toMatch(/no serial interfaces/);
  });

  it('show wireless lists radio settings and associated stations', () => {
    const ap = device('ap.nfap-auto', { mode: 'priv-exec' });
    ap.running.set([['interface', 'Wlan0']], ['ssid', 'LAB']);
    ap.running.set([['interface', 'Wlan0']], ['security', 'wpa2-psk']);
    ap.assoc.set({ key: 'Wlan0|02:00:00:00:00:20', port: 'Wlan0', station: '02:00:00:00:00:20', bssid: '02:00:00:00:00:10', ssid: 'LAB', state: 'associated', aid: 1, rssiDbm: -55, rateBps: 54_000_000, updatedAt: 0 });
    const blocks = (run(ap, HANDLERS.showWireless).output ?? '').split('\n\n');
    const wl0 = lines(blocks[0]);
    expect(wl0[0]).toBe('Wlan0: access point radio, admin up, operating');
    expect(wl0[1]).toBe('  Band 2.4 GHz, channel 1, width 20 MHz, transmit power 20 dBm');
    expect(wl0[2]).toBe('  Network: "LAB", security wpa2-psk');
    expect(wl0[3]).toMatch(/^\s+Station\s+State\s+AID\s+Signal\s+Rate$/);
    expect(wl0[4]).toMatch(/^\s+0200\.0000\.0020\s+associated\s+1\s+-55 dBm\s+54 Mb\/s$/);
    expect(lines(blocks[1])).toContain('  No stations associated.');
    expect(run(device('router.nf2911', { mode: 'priv-exec' }), HANDLERS.showWireless).error).toMatch(/no radio interfaces/);
  });

  it('show inventory lists slots with installed modules and ports', () => {
    const modules = [{ slot: '0/0', module: 'mod.ehwic-2t' }];
    const r = device('router.nf1941', { mode: 'priv-exec', modules });
    const out = lines(run(r, HANDLERS.showInventory).output);
    expect(out[0]).toBe('Chassis: NF-1941 (' + catalogModel('router.nf1941').description + ')');
    expect(out[1]).toMatch(/^Slot\s+Kind\s+Installed\s+Adds$/);
    expect(out[2]).toMatch(/^0\/0\s+Interface card slot\s+NF-EHWIC-2T\s+Se0\/0\/0, Se0\/0\/1$/);
    expect(out[3]).toMatch(/^0\/1\s+Interface card slot\s+empty\s+-$/);
    expect(out).toContain('Installed modules:');
    expect(run(device('router.nf2911', { mode: 'priv-exec' }), HANDLERS.showInventory).output).toContain('This device has no module slots.');
    const cage = device('router.nf4331', { mode: 'priv-exec', modules: [{ slot: 'sfp0/0/2', module: 'mod.sfp-1g-sx' }] });
    expect(run(cage, HANDLERS.showInventory).output).toMatch(/sfp0\/0\/2\s+SFP cage\s+NF-SFP-1G-SX\s+optics for Gi0\/0\/2/);
  });

  it('show interfaces status lists physical ports with role and connector', () => {
    const sw = device('switch.nfc2960-24pg', { mode: 'priv-exec' });
    sw.running.set([['interface', 'GigabitEthernet0/1']], ['description', 'uplink to the core switch room']);
    const out = lines(run(sw, HANDLERS.showInterfacesStatus).output);
    expect(out[0]).toMatch(/^Port\s+Description\s+Status\s+Role\s+Duplex\s+Speed\s+Type$/);
    expect(out[1]).toMatch(/^GigabitEthernet0\/1\s+uplink to the cor~\s+connected\s+Switched port\s+auto\s+auto\s+rj45$/);
    expect(out.find((l) => l.startsWith('GigabitEthernet0/25'))).toMatch(/sfp$/);
    expect(out).toHaveLength(29);
  });
});
