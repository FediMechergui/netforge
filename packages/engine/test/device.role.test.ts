import { describe, expect, it } from 'vitest';
import { BRIDGED_ROLES, L3_ROLES } from '../src/contracts/catalog.js';
import { CLI_MESSAGES } from '../src/contracts/cli.js';
import { ETHERTYPE_ARP, ETHERTYPE_IPV4 } from '../src/contracts/pdu.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { DEVICE_CONFIG_MESSAGES } from '../src/device/device.js';
import { MAC_A, boot, echoFrame, fakeProcess, harness } from './device.harness.js';

const PORT = 'GigabitEthernet1/0/24';

function multilayer(startupConfig?: string) {
  const order: string[] = [];
  const sw = fakeProcess('eth-switch', {
    handles: [{ layer: 'ethernet', roles: BRIDGED_ROLES }],
    onLinkChange: (_c, port, up) => { if (port === PORT) order.push(`switch-link:${up}`); return []; },
  });
  const arp = fakeProcess('arp', { handles: [{ layer: 'ethernet', ethertype: ETHERTYPE_ARP, roles: L3_ROLES }] });
  const ipv4 = fakeProcess('ipv4', {
    handles: [{ layer: 'ethernet', ethertype: ETHERTYPE_IPV4, roles: L3_ROLES }],
    onConfig: (_c, delta) => { order.push(`config:${delta.op} ${delta.line.join(' ')}`); return []; },
  });
  const h = harness({
    type: 'mlswitch.nfc3650-24', name: 'SW1',
    processes: { 'eth-switch': sw.factory, arp: arp.factory, ipv4: ipv4.factory },
    ...(startupConfig !== undefined ? { startupConfig } : {}),
  });
  boot(h);
  return { h, d: h.device, sw, arp, ipv4, order };
}

describe('port roles: switchport / no switchport (§3.10)', () => {
  it('no switchport flips a multilayer port to routed: role, demux, portsVersion, stored negation, PHY notification', () => {
    const { h, d, sw, ipv4, order } = multilayer();
    const port = d.port(PORT)!;
    port.operUp = true;
    const at = d.bootedAt! + 1;
    expect(port.role).toBe('switched');
    expect(port.spec.allowedRoles).toEqual(['switched', 'routed']);
    d.onFrameArrival(PORT, echoFrame(h, MAC_A), false, at);
    expect(sw.calls.filter((c) => c.kind === 'onPdu')).toHaveLength(1);

    const v0 = d.portsVersion ?? 0;
    h.events.length = 0;
    h.phyCalls.length = 0;
    order.length = 0;
    expect(d.applyConfigLine([['interface', PORT]], ['switchport'], true)).toEqual({ ok: true });
    expect(port.role).toBe('routed');
    expect(d.portsVersion).toBe(v0 + 1);
    expect(h.kinds('portState')).toEqual([{ t: at, kind: 'portState', device: 'd_1', port: PORT, adminUp: true, operUp: true, reason: 'role-change' }]);
    expect(order).toEqual(['switch-link:false', 'switch-link:true', 'config:unset switchport']);
    expect(d.running.render()).toContain(`interface ${PORT}\n no switchport`);
    expect(h.phyCalls).toEqual([{ ref: { device: 'd_1', port: PORT }, now: at }]);

    // the MAC filter and demux now follow the routed role
    h.events.length = 0;
    d.onFrameArrival(PORT, echoFrame(h, MAC_A), false, at + 1);
    expect(h.kinds('drop').at(-1)).toMatchObject({ reason: 'not-for-me', detail: MAC_A });
    d.onFrameArrival(PORT, echoFrame(h, port.mac), false, at + 2);
    expect(ipv4.calls.filter((c) => c.kind === 'onPdu')).toHaveLength(1);
    expect(sw.calls.filter((c) => c.kind === 'onPdu')).toHaveLength(1);
    // a repeated no switchport changes nothing
    const v1 = d.portsVersion;
    expect(d.applyConfigLine([['interface', PORT]], ['switchport'], true)).toEqual({ ok: true });
    expect(d.portsVersion).toBe(v1);
  });

  it('switchport withdraws the address first, bounces the port and reports role-change', () => {
    const { h, d, order } = multilayer();
    const port = d.port(PORT)!;
    port.operUp = true;
    const at = d.bootedAt! + 1;
    d.applyConfigLine([['interface', PORT]], ['switchport'], true);
    d.applyConfigLine([['interface', PORT]], ['ip', 'address', '10.1.1.1', '255.255.255.0'], false);
    d.applyActions('ipv4', [{ type: 'setPortL3', port: PORT, ipv4: { address: '10.1.1.1', prefixLen: 24 } }], at);
    h.events.length = 0;
    order.length = 0;
    expect(d.applyConfigLine([['interface', PORT]], ['switchport'], false)).toEqual({ ok: true });
    expect(order).toEqual(['config:unset ip address', 'switch-link:false', 'switch-link:true', 'config:set switchport']);
    expect(h.events.map((e) => e.kind)).toEqual(['configChange', 'portState', 'configChange']);
    expect((h.kinds('portState')[0] as Extract<TraceEvent, { kind: 'portState' }>).reason).toBe('role-change');
    expect(port.role).toBe('switched');
    const text = d.running.render();
    expect(text).not.toContain('no switchport');
    expect(text).not.toContain('ip address 10.1.1.1');
  });

  it('a port whose allowed roles lack routed refuses no switchport with CLI_MESSAGES.roleLocked', () => {
    const h = harness({ type: 'switch.nfc2960', name: 'S1' });
    boot(h);
    const d = h.device;
    const v = d.portsVersion;
    expect(d.applyConfigLine([['interface', 'FastEthernet0/1']], ['switchport'], true)).toEqual({ ok: false, error: CLI_MESSAGES.roleLocked });
    expect(d.running.render()).not.toContain('no switchport');
    expect(d.port('FastEthernet0/1')?.role).toBe('switched');
    expect(d.portsVersion).toBe(v);
    expect(h.phyCalls).toEqual([]);
    const t = d.bootedAt!;
    expect(d.setPortRole?.('FastEthernet0/1', 'routed', t)).toEqual({ ok: false, error: CLI_MESSAGES.roleLocked });
    expect(d.setPortRole?.('FastEthernet0/1', 'switched', t)).toEqual({ ok: true });
    expect(d.setPortRole?.('Nope0', 'routed', t)).toEqual({ ok: false, error: 'Unknown interface Nope0' });
  });

  it('the stored negation survives save and reload; power-off resets roles to the spec role', () => {
    const { h, d } = multilayer();
    d.applyConfigLine([['interface', PORT]], ['switchport'], true);
    d.saveConfig();
    const v = d.portsVersion ?? 0;
    const t = d.bootedAt! + 10;
    d.reload(t);
    expect(d.port(PORT)?.role).toBe('switched');
    expect(d.portsVersion).toBe(v + 1);
    h.run(t + d.model.bootNs);
    expect(d.bootedAt).toBe(t + d.model.bootNs);
    expect(d.port(PORT)?.role).toBe('routed');
    expect(d.running.render()).toContain(`interface ${PORT}\n no switchport`);
  });
});

describe('port settings rendered from running-config', () => {
  it('encapsulation: hdlc is accepted on serial ports, ppp and others are refused, ethernet ports refuse the line', () => {
    const h = harness({ type: 'router.nf2911', name: 'R1' });
    boot(h);
    const d = h.device;
    const ctx = [['interface', 'Serial0/0/0']];
    expect(d.port('Serial0/0/0')?.encap).toBe('hdlc');
    expect(d.applyConfigLine(ctx, ['encapsulation', 'ppp'], false)).toEqual({ ok: false, error: DEVICE_CONFIG_MESSAGES.pppUnavailable });
    expect(d.applyConfigLine(ctx, ['encapsulation', 'frame-relay'], false)).toEqual({ ok: false, error: 'Encapsulation frame-relay is not supported on this interface.' });
    expect(d.running.render()).not.toContain('encapsulation');
    expect(h.phyCalls).toEqual([]);
    expect(d.applyConfigLine(ctx, ['encapsulation', 'hdlc'], false)).toEqual({ ok: true });
    expect(d.port('Serial0/0/0')?.encap).toBe('hdlc');
    expect(h.phyCalls.map((c) => c.ref.port)).toEqual(['Serial0/0/0']);
    expect(d.applyConfigLine(ctx, ['encapsulation'], true)).toEqual({ ok: true });
    expect(d.applyConfigLine([['interface', 'GigabitEthernet0/0']], ['encapsulation', 'hdlc'], false)).toEqual({ ok: false, error: DEVICE_CONFIG_MESSAGES.encapsulationNotSerial });
  });

  it('phySettings renders speed, duplex and clock rate', () => {
    const h = harness({ type: 'router.nf2911', name: 'R1' });
    boot(h);
    const d = h.device;
    expect(d.phySettings?.('Serial0/0/0')).toEqual({ speed: 'auto', duplex: 'auto' });
    d.applyConfigLine([['interface', 'Serial0/0/0']], ['clock', 'rate', '64000'], false);
    expect(d.phySettings?.('Serial0/0/0')).toEqual({ speed: 'auto', duplex: 'auto', clockRateBps: 64000 });
    d.applyConfigLine([['interface', 'GigabitEthernet0/0']], ['speed', '100'], false);
    d.applyConfigLine([['interface', 'GigabitEthernet0/0']], ['duplex', 'full'], false);
    expect(d.phySettings?.('GigabitEthernet0/0')).toEqual({ speed: 100_000_000, duplex: 'full' });
    d.applyConfigLine([['interface', 'GigabitEthernet0/0']], ['speed', 'auto'], false);
    expect(d.phySettings?.('GigabitEthernet0/0')).toEqual({ speed: 'auto', duplex: 'full' });
    expect(d.phySettings?.('Nope9')).toEqual({ speed: 'auto', duplex: 'auto' });
    expect(h.phyCalls.map((c) => c.ref.port)).toEqual(['Serial0/0/0', 'GigabitEthernet0/0', 'GigabitEthernet0/0', 'GigabitEthernet0/0']);
    // description is not PHY-relevant
    d.applyConfigLine([['interface', 'GigabitEthernet0/0']], ['description', 'uplink'], false);
    expect(h.phyCalls).toHaveLength(4);
  });

  it('radioSettings renders the radio lines over the catalog radio defaults', () => {
    const h = harness({ type: 'wrouter.nfhome', name: 'HR1' });
    boot(h);
    const d = h.device;
    const radio = d.port('Wlan0')!.spec.radio!;
    expect(d.radioSettings?.('Wlan0')).toEqual({ band: radio.defaultBand, channel: radio.defaultChannel, widthMhz: 20, txPowerDbm: radio.maxTxPowerDbm, security: 'open' });
    const ctx = [['interface', 'Wlan0']];
    d.applyConfigLine(ctx, ['ssid', 'LAB', 'NET'], false);
    d.applyConfigLine(ctx, ['security', 'wpa2-psk'], false);
    d.applyConfigLine(ctx, ['passphrase', 'correct', 'horse'], false);
    d.applyConfigLine(ctx, ['channel', '6'], false);
    d.applyConfigLine(ctx, ['channel-width', '40'], false);
    d.applyConfigLine(ctx, ['tx-power', '99'], false);
    d.applyConfigLine(ctx, ['beacons'], false);
    expect(d.radioSettings?.('Wlan0')).toEqual({
      band: radio.defaultBand, channel: 6, widthMhz: radio.maxWidthMhz >= 40 ? 40 : 20, txPowerDbm: radio.maxTxPowerDbm,
      security: 'wpa2-psk', ssid: 'LAB NET', passphrase: 'correct horse', emitBeacons: true,
    });
    d.applyConfigLine(ctx, ['channel', 'auto'], false);
    expect(d.radioSettings?.('Wlan0')?.channel).toBe('auto');
    expect(h.phyCalls.filter((c) => c.ref.port === 'Wlan0')).toHaveLength(8);
    expect(d.radioSettings?.('Internet')).toBeUndefined();
    expect(d.radioSettings?.('Vlan1')).toBeUndefined();
  });
});
