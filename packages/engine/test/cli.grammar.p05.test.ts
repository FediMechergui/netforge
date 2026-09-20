/**
 * cli/grammar P0.5 fragments on real catalog models (ARCHITECTURE-P1 §3.10, §3.13, §6): virtual interfaces,
 * switchport, serial lines, radio lines, the host shell Wi-Fi and adapter commands, show inventory/controllers/
 * wireless/interfaces status and the debug registry — each scoped by grammar, effective capabilities and the selected
 * port, never by device kind. The P0 help lists of the P0 models stay identical.
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES, type CliMode } from '../src/contracts/cli.js';
import type { PortView } from '../src/contracts/port.js';
import {
  GRAMMAR,
  HANDLERS,
  MSG_NOT_PTP,
  MSG_NOT_SERIAL,
  MSG_NOT_WLAN,
  PHYSICAL_NAME_PATTERN,
  VIRTUAL_NAME_PATTERN,
} from '../src/cli/grammar/index.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import { help, matchCommand, MSG_UNKNOWN_INTERFACE, refusedThroughDo, type MatchContext } from '../src/cli/parser.js';
import { catalogModel, devicePortViews, matchContextFor, type MatchContextOptions } from './cli.p05.fixture.js';

function on(type: string, mode: CliMode, opts: MatchContextOptions = {}): MatchContext {
  return matchContextFor(catalogModel(type), mode, opts);
}

function ok(c: MatchContext, line: string) {
  const r = matchCommand(GRAMMAR, c, line);
  if (!r.ok) throw new Error(`expected "${line}" to match, got ${r.kind}: ${r.error.message}`);
  return r;
}

function fail(c: MatchContext, line: string) {
  const r = matchCommand(GRAMMAR, c, line);
  if (r.ok) throw new Error(`expected "${line}" to fail, matched ${r.spec.handler}`);
  return r;
}

const tokens = (c: MatchContext, partial: string): string[] => help(GRAMMAR, c, partial).items.map((i) => i.token);

describe('registry and name patterns', () => {
  it('every handler id has an implementation (the runtime binds debug, undebug all and do)', () => {
    const runtimeBound = new Set<string>([HANDLERS.execDebug, HANDLERS.execUndebugAll, HANDLERS.execDo]);
    for (const id of Object.values(HANDLERS)) {
      if (runtimeBound.has(id)) continue;
      expect(HANDLER_REGISTRY[id], id).toBeDefined();
    }
  });

  it('virtual and physical interface name patterns partition typed names', () => {
    const virtual = new RegExp(`^(?:${VIRTUAL_NAME_PATTERN})$`);
    const physical = new RegExp(`^(?:${PHYSICAL_NAME_PATTERN})$`);
    for (const n of ['Vlan1', 'vl10', 'v5', 'Loopback0', 'lo7', 'LOOP3']) {
      expect(virtual.test(n), n).toBe(true);
      expect(physical.test(n), n).toBe(false);
    }
    for (const n of ['g0/0', 'GigabitEthernet0/1', 'Serial0/0/0', 'Wlan0', 'Internet', 'vlan', 'Console']) {
      expect(virtual.test(n), n).toBe(false);
      expect(physical.test(n), n).toBe(true);
    }
  });

  it('mode-entering and session-changing specs are refused through do', () => {
    for (const s of GRAMMAR) {
      if (s.entersMode !== undefined || s.sessionEffect !== undefined) expect(refusedThroughDo(s), s.path.join(' ')).toBe(true);
    }
    expect(ok(on('ap.nfap-auto', 'config'), 'do show wireless')).toMatchObject({ doPrefix: true, spec: { handler: HANDLERS.showWireless } });
  });
});

describe('virtual interfaces (router, multilayer switch, home router)', () => {
  const r1 = on('router.nf2911', 'config');

  it('interface Loopback<n> is created through the virtual spec and has a no form', () => {
    expect(ok(r1, 'interface loopback 0')).toMatchObject({ spec: { handler: HANDLERS.configInterface, entersMode: 'config-if' }, args: { iface: 'Loopback0' }, negated: false });
    expect(ok(r1, 'int lo5').args.iface).toBe('Loopback5');
    expect(ok(r1, 'no interface Loopback5')).toMatchObject({ negated: true, args: { iface: 'Loopback5' } });
  });

  it('fixed ports keep having no no form and the console is not an interface', () => {
    const r = fail(r1, 'no interface g0/0');
    expect(r.kind).toBe('unrecognized');
    expect(r.error.column).toBe(3);
    expect(ok(r1, 'interface g0/0').args.iface).toBe('GigabitEthernet0/0');
    expect(fail(r1, 'interface Console').ok).toBe(false);
    expect(fail(r1, 'interface Aux 1')).toMatchObject({ kind: 'invalid-arg', error: { column: 10 } });
  });

  it('a multilayer switch and (P1) an L2 switch resolve the auto Vlan1 as existing', () => {
    const ml = on('mlswitch.nfc3650-24', 'config');
    expect(ok(ml, 'interface vlan 1').args.iface).toBe('Vlan1');
    expect(ok(ml, 'interface Vlan20').args.iface).toBe('Vlan20');
    expect(ok(ml, 'no interface Vlan1').negated).toBe(true);
    // §9.2 (P1 W5): the NF-C2960 gained the auto Vlan1 management SVI, so `interface vlan 1` resolves there too and
    // `ip address` on it is accepted (it no longer needs the routing capability).
    expect(ok(on('switch.nfc2960', 'config'), 'interface vlan 1').args.iface).toBe('Vlan1');
    const svi = on('switch.nfc2960', 'config-if', { iface: 'Vlan1' });
    expect(ok(svi, 'ip address 10.0.0.1 255.255.255.0').spec.handler).toBe(HANDLERS.ifIpAddress);
    expect(tokens(svi, '')).toEqual(['description', 'do', 'end', 'exit', 'ip', 'no', 'shutdown']);
    expect(fail(on('switch.nfc2960', 'config'), 'interface FastEthernet0/99')).toMatchObject({ kind: 'invalid-arg', error: { message: MSG_UNKNOWN_INTERFACE } });
  });

  it('the home router (shell none, grammar nfos) configures Vlan1 and its radios headlessly', () => {
    const home = catalogModel('wrouter.nfhome');
    expect(ok(matchContextFor(home, 'config'), 'interface Vlan1').args.iface).toBe('Vlan1');
    expect(ok(matchContextFor(home, 'config-if', { iface: 'Vlan1' }), 'ip address 192.168.1.1 255.255.255.0').spec.handler).toBe(HANDLERS.ifIpAddress);
    expect(ok(matchContextFor(home, 'config-if', { iface: 'Wlan0' }), 'ssid HOME NET').args.name).toBe('HOME NET');
  });
});

describe('switchport and routed ports', () => {
  it('an L2 switch port offers switchport (the handler answers roleLocked) but never ip address', () => {
    const sw = on('switch.nfc2960', 'config-if', { iface: 'FastEthernet0/1' });
    expect(ok(sw, 'no switchport')).toMatchObject({ negated: true, spec: { handler: HANDLERS.ifSwitchport } });
    // §9.2 (P1): a switched port now answers with the portRequires mismatch instead of hiding `ip address`.
    expect(fail(sw, 'ip address 10.0.0.1 255.255.255.0')).toMatchObject({ kind: 'port-unsupported', error: { message: CLI_MESSAGES.switchedPort, column: 0 } });
  });

  it('a switched port of a multilayer switch reports switchedPort; the routed port accepts the address', () => {
    const model = catalogModel('mlswitch.nfc3650-24');
    const switched = matchContextFor(model, 'config-if', { iface: 'GigabitEthernet1/0/24' });
    expect(matchCommand(GRAMMAR, switched, 'ip address 10.1.1.1 255.255.255.0')).toEqual({
      ok: false, kind: 'port-unsupported', error: { message: CLI_MESSAGES.switchedPort, column: 0 },
    });
    const ports = devicePortViews(model, { patch: { 'GigabitEthernet1/0/24': { role: 'routed' } } });
    const routed = matchContextFor(model, 'config-if', { iface: 'GigabitEthernet1/0/24', ports });
    expect(ok(routed, 'ip address 10.1.1.1 255.255.255.0').spec.handler).toBe(HANDLERS.ifIpAddress);
    expect(ok(routed, 'switchport').negated).toBe(false);
  });

  it('routers do not see switchport unless a switch module adds switching', () => {
    const r1941 = catalogModel('router.nf1941');
    expect(fail(matchContextFor(r1941, 'config-if', { iface: 'GigabitEthernet0/0' }), 'no switchport').kind).toBe('unrecognized');
    const modules = [{ slot: '0/0', module: 'mod.ehwic-4esg' }];
    const ports = devicePortViews(r1941, { modules });
    const modulePort = [...ports.values()].find((p) => p.module !== undefined)!;
    const c = matchContextFor(r1941, 'config-if', { ifaceView: modulePort, ports, modules });
    expect(ok(c, 'no switchport').spec.handler).toBe(HANDLERS.ifSwitchport);
    expect(ok(matchContextFor(r1941, 'priv-exec', { ports, modules }), 'show mac address-table').spec.handler).toBe(HANDLERS.showMac);
  });
});

describe('serial lines', () => {
  const model = catalogModel('router.nf2911');
  const serial = matchContextFor(model, 'config-if', { iface: 'Serial0/0/0' });
  const gig = matchContextFor(model, 'config-if', { iface: 'GigabitEthernet0/0' });

  it('clock rate, encapsulation, bandwidth and keepalive exist on serial ports', () => {
    expect(ok(serial, 'clock rate 64000')).toMatchObject({ spec: { handler: HANDLERS.ifClockRate }, args: { bps: '64000' } });
    expect(ok(serial, 'encapsulation hdlc').args.framing).toBe('hdlc');
    expect(ok(serial, 'encapsulation ppp').args.framing).toBe('ppp');
    expect(ok(serial, 'bandwidth 1544').args.kbps).toBe('1544');
    expect(ok(serial, 'keepalive').args).toEqual({});
    expect(ok(serial, 'keepalive 0').args.seconds).toBe('0');
    expect(ok(serial, 'no keepalive').negated).toBe(true);
    expect(ok(serial, 'no clock rate').negated).toBe(true);
    expect(ok(serial, 'ip address 10.0.0.1 255.255.255.252').spec.handler).toBe(HANDLERS.ifIpAddress);
  });

  it('serial lines on an Ethernet port and Ethernet lines on a serial port report the port mismatch', () => {
    expect(matchCommand(GRAMMAR, gig, 'clock rate 64000')).toEqual({ ok: false, kind: 'port-unsupported', error: { message: MSG_NOT_SERIAL, column: 0 } });
    expect(matchCommand(GRAMMAR, serial, 'duplex full')).toEqual({ ok: false, kind: 'port-unsupported', error: { message: CLI_MESSAGES.portUnsupported, column: 0 } });
    expect(fail(serial, 'clock rate 100').kind).toBe('invalid-arg');
  });

  it('help lists the serial lines on a serial port only', () => {
    expect(tokens(serial, '')).toEqual(['bandwidth', 'clock', 'description', 'do', 'encapsulation', 'end', 'exit', 'ip', 'ipv6', 'keepalive', 'no', 'shutdown']);
    expect(tokens(gig, '')).toEqual(['description', 'do', 'duplex', 'end', 'exit', 'ip', 'ipv6', 'mac-address', 'no', 'shutdown', 'speed']);
  });

  it('show controllers serial and debug serial run but are not listed', () => {
    const priv = matchContextFor(model, 'priv-exec');
    expect(ok(priv, 'show controllers serial se0/0/0').args.iface).toBe('Serial0/0/0');
    expect(ok(priv, 'show controllers serial').args).toEqual({});
    expect(fail(priv, 'show controllers serial gi0/0')).toMatchObject({ kind: 'invalid-arg', error: { column: 24 } });
    expect(tokens(priv, 'show ')).not.toContain('controllers');
    expect(ok(priv, 'debug serial').args.category).toBe('serial');
    expect(tokens(priv, 'debug ')).toEqual(['all', 'arp', 'dhcp', 'dns', 'ethernet', 'ip', 'ipv6', 'tcp', 'traceroute', 'udp']);
  });
});

describe('radio lines', () => {
  it('an access point radio takes the Wi-Fi lines; its Ethernet port does not', () => {
    const model = catalogModel('ap.nfap-auto');
    const wl0 = matchContextFor(model, 'config-if', { iface: 'Wlan0' });
    expect(ok(wl0, 'ssid LAB NET').args.name).toBe('LAB NET');
    expect(ok(wl0, 'security wpa2-psk').args.mode).toBe('wpa2-psk');
    expect(ok(wl0, 'passphrase correct horse battery').args.text).toBe('correct horse battery');
    expect(ok(wl0, 'band 2.4').args.band).toBe('2.4');
    expect(ok(wl0, 'channel auto').args.channel).toBe('auto');
    expect(ok(wl0, 'channel 11').args.channel).toBe('11');
    expect(ok(wl0, 'channel-width 40').args.mhz).toBe('40');
    expect(ok(wl0, 'tx-power 17').args.dbm).toBe('17');
    expect(ok(wl0, 'beacons').spec.handler).toBe(HANDLERS.ifBeacons);
    expect(fail(wl0, 'channel eleven').kind).toBe('invalid-arg');
    expect(fail(wl0, 'peer-key abcd').kind).toBe('unrecognized');
    expect(tokens(wl0, '')).toEqual([
      'band', 'beacons', 'channel', 'channel-width', 'description', 'do', 'end', 'exit', 'no', 'passphrase', 'security', 'shutdown', 'ssid', 'tx-power',
    ]);
    const gi0 = matchContextFor(model, 'config-if', { iface: 'GigabitEthernet0' });
    expect(matchCommand(GRAMMAR, gi0, 'ssid LAB')).toEqual({ ok: false, kind: 'port-unsupported', error: { message: MSG_NOT_WLAN, column: 0 } });
    expect(fail(gi0, 'ip address 10.0.0.2 255.255.255.0')).toMatchObject({ kind: 'port-unsupported', error: { message: CLI_MESSAGES.switchedPort } });
    expect(ok(matchContextFor(model, 'config'), 'ip default-gateway 10.0.0.1').spec.handler).toBe(HANDLERS.configDefaultGateway);
    expect(tokens(matchContextFor(model, 'priv-exec'), 'debug ')).toEqual(['all', 'arp', 'ethernet', 'ip', 'wireless']);
    expect(ok(matchContextFor(model, 'user-exec'), 'show wireless').spec.handler).toBe(HANDLERS.showWireless);
  });

  it('a point-to-point radio takes band, channel, power and the pairing key but no Wi-Fi lines', () => {
    const model = catalogModel('radio.nfptp5');
    const rd0 = matchContextFor(model, 'config-if', { iface: 'Radio0' });
    expect(ok(rd0, 'peer-key site-a to site-b').args.key).toBe('site-a to site-b');
    expect(ok(rd0, 'channel 149').args.channel).toBe('149');
    expect(fail(rd0, 'ssid LAB').kind).toBe('unrecognized');
    expect(fail(rd0, 'beacons').kind).toBe('unrecognized');
    const gi0 = matchContextFor(model, 'config-if', { iface: 'GigabitEthernet0' });
    expect(matchCommand(GRAMMAR, gi0, 'peer-key abcd')).toEqual({ ok: false, kind: 'port-unsupported', error: { message: MSG_NOT_PTP, column: 0 } });
  });
});

describe('host shell', () => {
  it('a laptop has the Wi-Fi commands; adapter runs but is not listed', () => {
    const laptop = on('laptop.nflaptop', 'user-exec');
    expect(ok(laptop, 'wifi connect LAB').args).toEqual({ ssid: 'LAB' });
    expect(ok(laptop, 'wifi connect LAB key secret123').args).toEqual({ ssid: 'LAB', key: 'secret123' });
    expect(ok(laptop, 'wifi disconnect').spec.handler).toBe(HANDLERS.hostWifiDisconnect);
    expect(ok(laptop, 'wifi list').spec.handler).toBe(HANDLERS.hostWifiList);
    expect(ok(laptop, 'adapter wl0 down').args).toEqual({ iface: 'Wlan0', state: 'down' });
    expect(tokens(laptop, '')).toEqual([
      'adapter', 'arp', 'exit', 'ip', 'ipconfig', 'ipv6', 'ipv6config', 'netstat', 'no', 'nslookup', 'ping', 'show', 'tracert', 'wifi',
    ]);
    expect(tokens(laptop, 'show ')).toEqual(['arp', 'history', 'hosts', 'interfaces', 'ip', 'running-config', 'version', 'wireless']);
    expect(tokens(laptop, 'wifi ')).toEqual(['connect', 'disconnect', 'list']);
  });

  it('the NF-PC gains the P1 host commands; wifi needs a Wi-Fi adapter; adapter works', () => {
    // §9.2 (P1): the PC top-level help list gains tracert, nslookup, netstat, ipv6config and adapter.
    const pc = on('pc.nfpc', 'user-exec');
    expect(tokens(pc, '')).toEqual([
      'adapter', 'arp', 'exit', 'ip', 'ipconfig', 'ipv6', 'ipv6config', 'netstat', 'no', 'nslookup', 'ping', 'show', 'tracert',
    ]);
    expect(fail(pc, 'wifi list')).toMatchObject({ kind: 'unrecognized', error: { column: 0 } });
    expect(ok(pc, 'adapter GigabitEthernet0 up').args).toEqual({ iface: 'GigabitEthernet0', state: 'up' });
  });

  it('host devices never see network OS modes or commands', () => {
    const phone = on('ipphone.nfphone', 'user-exec');
    expect(ok(phone, 'ip address 10.0.0.5 255.255.255.0 10.0.0.1').spec.handler).toBe(HANDLERS.pcIpAddress);
    expect(fail(phone, 'enable').kind).toBe('unrecognized');
    expect(fail(phone, 'show mac address-table').kind).toBe('unrecognized');
  });
});

describe('inventory and status tables', () => {
  it('show inventory exists on modular devices only', () => {
    expect(ok(on('router.nf1941', 'user-exec'), 'show inventory').spec.handler).toBe(HANDLERS.showInventory);
    expect(fail(on('router.nf2911', 'user-exec'), 'show inventory')).toMatchObject({ kind: 'unrecognized', error: { column: 5 } });
  });

  it('show interfaces status exists on bridging devices; routers keep the P0 show list', () => {
    expect(ok(on('switch.nfc2960', 'priv-exec'), 'show interfaces status').spec.handler).toBe(HANDLERS.showInterfacesStatus);
    const r1 = on('router.nf2911', 'priv-exec');
    expect(tokens(r1, 'show ')).toEqual(['arp', 'history', 'hosts', 'interfaces', 'ip', 'ipv6', 'running-config', 'startup-config', 'version']);
    expect(ok(r1, 'show interfaces serial0/0/0').args.iface).toBe('Serial0/0/0');
  });

  it('interface views of every catalog model resolve through the fixture', () => {
    const model = catalogModel('cloud.nfinternet');
    const ports: PortView[] = [...devicePortViews(model).values()];
    expect(ports.length).toBe(model.ports.length);
  });
});
