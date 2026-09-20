import { describe, expect, it } from 'vitest';
import { deviceMacBase, portMac } from '../src/contracts/addr.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { boot, fakeProcess, harness } from './device.harness.js';

type PortStateEv = Extract<TraceEvent, { kind: 'portState' }>;
type LogEv = Extract<TraceEvent, { kind: 'log' }>;

const routerProcs = () => {
  const arp = fakeProcess('arp');
  const ipv4 = fakeProcess('ipv4');
  const icmpv4 = fakeProcess('icmpv4');
  return { arp, ipv4, processes: { arp: arp.factory, ipv4: ipv4.factory, icmpv4: icmpv4.factory } };
};

const switchProcs = () => {
  const sw = fakeProcess('eth-switch');
  const ipv4 = fakeProcess('ipv4');
  return { sw, ipv4, processes: { 'eth-switch': sw.factory, ipv4: ipv4.factory } };
};

describe('virtual interfaces: create (§3.10)', () => {
  it('interface Loopback0 creates a virtual port with the base MAC, a config section, portState virtual-created, then goes up', () => {
    const p = routerProcs();
    const h = harness({ type: 'router.nf2911', name: 'R1', processes: p.processes });
    boot(h);
    const d = h.device;
    const at = d.bootedAt!;
    const v0 = d.portsVersion ?? 0;
    h.events.length = 0;
    expect(d.applyConfigLine([['interface', 'Loopback0']], ['ip', 'address', '1.1.1.1', '255.255.255.255'], false)).toEqual({ ok: true });
    const lo = d.port('Loopback0')!;
    expect(lo.spec.kind).toBe('virtual');
    expect(lo.role).toBe('virtual');
    expect(lo.encap).toBe('none');
    expect(lo.ordinal).toBe(0);
    expect(lo.mac).toBe(portMac(deviceMacBase('d_1'), 0));
    expect(lo.adminUp).toBe(true);
    expect(lo.operUp).toBe(true);
    expect([...d.ports.keys()].at(-1)).toBe('Loopback0');
    expect(d.portsVersion).toBe(v0 + 1);
    expect(h.kinds('portState')).toEqual([
      { t: at, kind: 'portState', device: 'd_1', port: 'Loopback0', adminUp: true, operUp: false, reason: 'virtual-created' },
      { t: at, kind: 'portState', device: 'd_1', port: 'Loopback0', adminUp: true, operUp: true },
    ]);
    expect(h.events.map((e) => e.kind)).toEqual(['portState', 'portState', 'configChange']);
    const kinds = p.ipv4.calls.slice(-2).map((c) => c.kind);
    expect(kinds).toEqual(['onLinkChange', 'onConfig']);
    expect(p.ipv4.calls.at(-2)).toMatchObject({ port: 'Loopback0', up: true });
    expect(d.running.render()).toContain('interface Loopback0\n ip address 1.1.1.1 255.255.255.255');
    expect(h.adminCalls.some((c) => c.ref.port === 'Loopback0')).toBe(false);
    expect(h.phyCalls).toEqual([]);
  });

  it('ensureVirtualPort finds existing ports and refuses names outside the families with original errors', () => {
    const p = routerProcs();
    const h = harness({ type: 'router.nf2911', name: 'R1', processes: p.processes });
    boot(h);
    const d = h.device;
    const t = d.bootedAt!;
    expect(d.ensureVirtualPort?.('Loopback0', t)).toEqual({ ok: true, port: 'Loopback0', created: true });
    expect(d.ensureVirtualPort?.('Loopback0', t)).toEqual({ ok: true, port: 'Loopback0', created: false });
    expect(d.ensureVirtualPort?.('Vlan5', t)).toEqual({ ok: false, error: 'This device cannot create an interface called Vlan5.' });
    expect(d.applyConfigLine([['interface', 'Tunnel0']], ['shutdown'], false)).toEqual({ ok: false, error: 'Unknown interface Tunnel0' });
    expect(d.applyConfigLine([], ['interface', 'Loopback9'], false)).toEqual({ ok: true });
    expect(d.port('Loopback9')).toBeDefined();
    const s = harness({ type: 'mlswitch.nfc3650-24', name: 'SW1', power: false });
    expect(s.device.ensureVirtualPort?.('Vlan5000', 0)).toEqual({ ok: false, error: 'Vlan interfaces on this device are numbered 1 to 4094.' });
  });

  it('resolvePortName covers fixed ports, existing virtual ports and creatable ones', () => {
    const h = harness({ type: 'router.nf2911', name: 'R1', power: false });
    const d = h.device;
    expect(d.resolvePortName?.('gi0/0')).toEqual({ kind: 'existing', port: 'GigabitEthernet0/0' });
    expect(d.resolvePortName?.('lo 5')).toEqual({ kind: 'virtual', port: 'Loopback5', family: 'Loopback' });
    d.ensureVirtualPort?.('Loopback5', 0);
    expect(d.resolvePortName?.('Lo5')).toEqual({ kind: 'existing', port: 'Loopback5' });
  });
});

describe('virtual interfaces: remove (§3.10)', () => {
  it('no interface unsets the section lines for every process, lowers the port and emits portState virtual-removed', () => {
    const p = routerProcs();
    const h = harness({ type: 'router.nf2911', name: 'R1', processes: p.processes });
    boot(h);
    const d = h.device;
    const at = d.bootedAt!;
    d.applyConfigLine([['interface', 'Loopback0']], ['ip', 'address', '1.1.1.1', '255.255.255.255'], false);
    d.applyConfigLine([['interface', 'Loopback0']], ['description', 'router id'], false);
    const v = d.portsVersion ?? 0;
    const from = p.ipv4.calls.length;
    h.events.length = 0;
    expect(d.applyConfigLine([], ['interface', 'Loopback0'], true)).toEqual({ ok: true });
    expect(d.port('Loopback0')).toBeUndefined();
    expect([...d.ports.keys()]).not.toContain('Loopback0');
    expect(d.portsVersion).toBe(v + 1);
    const seen = p.ipv4.calls.slice(from).map((c) => (c.kind === 'onConfig' ? `${c.delta!.op} ${c.delta!.line.join(' ')}` : `${c.kind} ${c.port} ${c.up}`));
    // section lines are unset in stored (insertion) order, then the section itself
    expect(seen).toEqual(['unset ip address 1.1.1.1 255.255.255.255', 'unset description router id', 'unset interface Loopback0', 'onLinkChange Loopback0 false']);
    expect(h.events.map((e) => e.kind)).toEqual(['configChange', 'configChange', 'configChange', 'portState']);
    expect(h.kinds('portState')).toEqual([{ t: at, kind: 'portState', device: 'd_1', port: 'Loopback0', adminUp: true, operUp: false, reason: 'virtual-removed' }]);
    expect(d.running.render()).not.toContain('Loopback0');
  });

  it('refuses physical, missing and built-in interfaces', () => {
    const r = harness({ type: 'router.nf2911', name: 'R1', power: false });
    expect(r.device.applyConfigLine([], ['interface', 'GigabitEthernet0/0'], true)).toEqual({ ok: false, error: 'GigabitEthernet0/0 is a physical interface and cannot be removed.' });
    expect(r.device.applyConfigLine([], ['interface', 'Loopback7'], true)).toEqual({ ok: false, error: 'There is no interface called Loopback7.' });
    const s = harness({ type: 'mlswitch.nfc3650-24', name: 'SW1', power: false });
    expect(s.device.removeVirtualPort?.('Vlan1', 0)).toEqual({ ok: false, error: 'This interface is built in and cannot be removed.' });
    expect(s.device.port('Vlan1')).toBeDefined();
  });
});

describe('virtual interfaces: oper state', () => {
  it('Vlan1 on a multilayer switch is built in, admin down, and follows the bridged ports once enabled', () => {
    const p = switchProcs();
    const h = harness({ type: 'mlswitch.nfc3650-24', name: 'SW1', processes: p.processes });
    const d = h.device;
    const vlan = d.port('Vlan1')!;
    expect(vlan.role).toBe('svi');
    expect(vlan.adminUp).toBe(false);
    expect(vlan.mac).toBe(portMac(deviceMacBase('d_1'), 0));
    expect(d.running.render()).toContain('interface Vlan1\n shutdown');
    boot(h);
    expect(h.adminCalls.some((c) => c.ref.port === 'Vlan1')).toBe(false);
    const t = d.bootedAt! + 1;
    h.adminCalls.length = 0;
    d.applyConfigLine([['interface', 'Vlan1']], ['shutdown'], true);
    expect(vlan.adminUp).toBe(true);
    expect(vlan.operUp).toBe(false);
    expect(h.adminCalls).toEqual([]);

    h.events.length = 0;
    const gi = d.port('GigabitEthernet1/0/1')!;
    gi.operUp = true;
    d.onPortOper('GigabitEthernet1/0/1', true, t);
    expect(vlan.operUp).toBe(true);
    expect(vlan.lastChange).toBe(t);
    expect(h.kinds('portState')).toEqual([{ t, kind: 'portState', device: 'd_1', port: 'Vlan1', adminUp: true, operUp: true }]);
    expect(p.ipv4.calls.slice(-2).map((c) => [c.kind, c.port, c.up])).toEqual([['onLinkChange', 'GigabitEthernet1/0/1', true], ['onLinkChange', 'Vlan1', true]]);

    h.events.length = 0;
    gi.operUp = false;
    d.onPortOper('GigabitEthernet1/0/1', false, t + 1);
    expect(vlan.operUp).toBe(false);
    expect((h.kinds('portState') as PortStateEv[]).map((e) => e.reason)).toEqual(['no-bridged-port-up']);
  });

  it('an SVI other than Vlan1 stays down and logs why when enabled', () => {
    const p = switchProcs();
    const h = harness({ type: 'mlswitch.nfc3650-24', name: 'SW1', processes: p.processes });
    boot(h);
    const d = h.device;
    const gi = d.port('GigabitEthernet1/0/2')!;
    gi.operUp = true;
    d.onPortOper('GigabitEthernet1/0/2', true, d.bootedAt! + 1);
    h.events.length = 0;
    expect(d.applyConfigLine([['interface', 'Vlan10']], ['shutdown'], true)).toEqual({ ok: true });
    const v10 = d.port('Vlan10')!;
    expect(v10.adminUp).toBe(true);
    expect(v10.operUp).toBe(false);
    const logs = (h.kinds('log') as LogEv[]).map((l) => l.message);
    expect(logs).toContain('Interface Vlan10 stays down: only VLAN 1 is available in this release.');
  });

  it('shutdown on a loopback is runtime-owned: no link model call, oper follows admin', () => {
    const p = routerProcs();
    const h = harness({ type: 'router.nf2911', name: 'R1', processes: p.processes });
    boot(h);
    const d = h.device;
    d.ensureVirtualPort?.('Loopback0', d.bootedAt!);
    h.adminCalls.length = 0;
    h.events.length = 0;
    d.applyConfigLine([['interface', 'Loopback0']], ['shutdown'], false);
    expect(d.port('Loopback0')?.adminUp).toBe(false);
    expect(d.port('Loopback0')?.operUp).toBe(false);
    expect(h.adminCalls).toEqual([]);
    // the admin change is reported first (as on physical ports), then the runtime-owned oper change
    expect((h.kinds('portState') as PortStateEv[]).map((e) => [e.operUp, e.reason])).toEqual([[true, 'admin-down'], [false, 'admin-down']]);
    expect(p.ipv4.calls.at(-2)).toMatchObject({ kind: 'onLinkChange', port: 'Loopback0', up: false });
  });

  it('boot replay creates virtual interfaces from the startup-config; power-off removes them again', () => {
    const p = routerProcs();
    const startup = ['hostname R1', 'interface Loopback3', ' ip address 3.3.3.3 255.255.255.255', 'interface Bogus7', ' description nothing'].join('\n');
    const h = harness({ type: 'router.nf2911', name: 'R1', processes: p.processes, startupConfig: startup });
    boot(h);
    const d = h.device;
    expect(d.port('Loopback3')?.operUp).toBe(true);
    expect(p.ipv4.calls.some((c) => c.kind === 'onConfig' && c.delta?.line.join(' ') === 'ip address 3.3.3.3 255.255.255.255')).toBe(true);
    expect((h.kinds('log') as LogEv[]).some((l) => l.message === 'Startup configuration refers to an unknown interface Bogus7')).toBe(true);
    const v = d.portsVersion ?? 0;
    const off = d.bootedAt! + 5;
    h.events.length = 0;
    h.adminCalls.length = 0;
    d.setPower(false, off);
    expect(d.port('Loopback3')).toBeUndefined();
    expect(d.portsVersion).toBe(v + 1);
    expect(h.kinds('portState')).toEqual([{ t: off, kind: 'portState', device: 'd_1', port: 'Loopback3', adminUp: true, operUp: false, reason: 'power-off' }]);
    expect(h.adminCalls.every((c) => !c.ref.port.startsWith('Loopback'))).toBe(true);
    // the next boot replays the startup-config and creates it again
    d.setPower(true, off + 1);
    h.run();
    expect(d.port('Loopback3')?.operUp).toBe(true);
  });
});
