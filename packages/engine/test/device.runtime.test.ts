import { describe, expect, it } from 'vitest';
import { deviceMacBase, portMac } from '../src/contracts/addr.js';
import { ACTION_BUDGET } from '../src/device/device.js';
import { SEC } from '../src/contracts/time.js';
import type { Action } from '../src/contracts/process.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { MAC_B, arpFrame, boot, fakeProcess, harness } from './device.harness.js';
import { FRAME_ROLES } from '../src/contracts/catalog.js';

const pcProcs = () => {
  const arp = fakeProcess('arp', { handles: [{ layer: 'ethernet', ethertype: 0x0806, roles: FRAME_ROLES }] });
  const ipv4 = fakeProcess('ipv4', { handles: [{ layer: 'ethernet', ethertype: 0x0800, roles: FRAME_ROLES }] });
  const icmpv4 = fakeProcess('icmpv4');
  const host = fakeProcess('host');
  return {
    arp, ipv4, icmpv4, host,
    processes: { arp: arp.factory, ipv4: ipv4.factory, icmpv4: icmpv4.factory, host: host.factory },
  };
};

describe('device runtime: construction and boot lifecycle', () => {
  it('creates ports from the model with deterministic MACs, default admin state, mtu 1500 and empty counters', () => {
    const h = harness({ type: 'router.nf2911', name: 'R1', power: false });
    const d = h.device;
    expect([...d.ports.keys()]).toEqual(['GigabitEthernet0/0', 'GigabitEthernet0/1', 'Serial0/0/0', 'Serial0/0/1', 'Console']);
    // D8 (§9.2): stable per-device MACs portMac(deviceMacBase(id, salt), ordinal); fixed ports use ordinal index+1
    expect(d.port('GigabitEthernet0/0')?.mac).toBe(portMac(deviceMacBase('d_1'), 1));
    expect(d.port('GigabitEthernet0/1')?.mac).toBe(portMac(deviceMacBase('d_1'), 2));
    expect(d.macBase).toBe(deviceMacBase('d_1'));
    expect(d.port('GigabitEthernet0/0')?.adminUp).toBe(false); // routers default down
    expect(d.port('Console')?.adminUp).toBe(true);
    expect(d.port('GigabitEthernet0/0')?.mtu).toBe(1500);
    expect(d.port('GigabitEthernet0/0')?.counters.inPackets).toBe(0);
    expect(d.port('GigabitEthernet0/0')?.operUp).toBe(false);
    expect(d.portView('GigabitEthernet0/0')?.id).toBe('GigabitEthernet0/0');
    expect(d.port('nope')).toBeUndefined();
    expect(d.hostname).toBe('R1');
    expect(d.power).toBe(false);
    expect(d.bootedAt).toBeUndefined();
    expect(d.uptime(1000)).toBe(0);
    expect(h.scheduler.size).toBe(0);
    expect(d.tables.cam.device).toBe('d_1');
    expect(d.tables.arp.name).toBe('arp');
    expect(d.tables.rib.size).toBe(0);
  });

  it('renders every non-console interface in the running-config, with shutdown on router ports', () => {
    const r = harness({ type: 'router.nf2911', name: 'R1', power: false });
    const text = r.device.running.render();
    expect(text).toContain('hostname R1');
    expect(text).toContain('interface GigabitEthernet0/0\n shutdown');
    expect(text).toContain('interface Serial0/0/1\n shutdown');
    expect(text).not.toContain('Console');
    const s = harness({ type: 'switch.nfc2960', name: 'S1', power: false });
    const st = s.device.running.render();
    expect(st).toContain('interface FastEthernet0/24');
    expect(st).toContain('interface GigabitEthernet0/2');
    // §9.2 "P1 W5 (catalog)": the auto Vlan1 of an L2 switch is administratively down until `no shutdown`
    expect(st).toContain('interface Vlan1\n shutdown');
    expect(st.replace('interface Vlan1\n shutdown', '')).not.toContain('shutdown');
    expect(s.device.running.query('interface')).toHaveLength(27);
  });

  it('throws for an unknown device type', () => {
    expect(() => harness({ type: 'toaster.x' })).toThrow(/unknown device type/);
  });

  it('power on schedules boot at now + bootNs and emits deviceState; onBoot instantiates processes and inits them', () => {
    const p = pcProcs();
    const h = harness({ processes: p.processes, now: 500 });
    expect(h.device.power).toBe(true);
    expect(h.kinds('deviceState')).toEqual([{ t: 500, kind: 'deviceState', device: 'd_1', power: true, booted: false }]);
    expect(h.scheduler.peekTime()).toBe(500 + 2 * SEC);
    expect(h.device.processes.size).toBe(0);

    boot(h);
    const at = 500 + 2 * SEC;
    expect(h.device.bootedAt).toBe(at);
    expect(h.device.uptime(at + 7)).toBe(7);
    expect([...h.device.processes.keys()]).toEqual(['arp', 'ipv4', 'icmpv4', 'host']);
    expect(p.arp.instances).toBe(1);
    expect(p.arp.calls.map((c) => c.kind)).toEqual(['init']);
    expect(p.host.calls.map((c) => c.kind)).toEqual(['init']);
    expect(p.arp.calls[0]?.at).toBe(at);
    expect(h.kinds('deviceState').at(-1)).toEqual({ t: at, kind: 'deviceState', device: 'd_1', power: true, booted: true });
    // ports are offered to the link model once booted
    expect(h.adminCalls).toEqual([{ ref: { device: 'd_1', port: 'GigabitEthernet0' }, adminUp: true, now: at }]);
    expect(h.device.stateSnapshots().map((s) => s.process)).toEqual(['arp', 'ipv4', 'icmpv4', 'host']);
    // ctx basics
    expect(p.arp.ctx?.deviceId).toBe('d_1');
    expect(p.arp.ctx?.hostname).toBe('PC1');
    expect(p.arp.ctx?.model.type).toBe('pc.nfpc');
    expect(p.arp.ctx?.ports.get('GigabitEthernet0')?.mac).toBe(portMac(deviceMacBase('d_1'), 1));
    expect(p.arp.ctx?.macOf('GigabitEthernet0')).toBe(portMac(deviceMacBase('d_1'), 1));
    expect(() => p.arp.ctx?.macOf('nope')).toThrow();
    expect(p.arp.ctx?.config).toBe(h.device.running);
  });

  it('each process gets its own rng sub-stream, deterministic per (seed, name)', () => {
    const a = pcProcs();
    const ha = harness({ processes: a.processes });
    boot(ha);
    const b = pcProcs();
    const hb = harness({ processes: b.processes });
    boot(hb);
    const xa = [a.arp.ctx!.rng.nextU32(), a.arp.ctx!.rng.nextU32()];
    const xb = [b.arp.ctx!.rng.nextU32(), b.arp.ctx!.rng.nextU32()];
    expect(xa).toEqual(xb);
    expect(a.arp.ctx!.rng.state()).not.toEqual(a.ipv4.ctx!.rng.state());
  });

  it('a missing process factory is logged and skipped', () => {
    const h = harness({ processes: {} });
    boot(h);
    expect(h.device.processes.size).toBe(0);
    const logs = h.kinds('log') as Extract<TraceEvent, { kind: 'log' }>[];
    // the P1 catalog derives the whole host daemon list for pc.nfpc (CATALOG_STAGE 'P1', §8.2 W5)
    expect(logs.map((l) => l.message)).toEqual([
      'Process arp is not available on this platform',
      'Process ipv4 is not available on this platform',
      'Process icmpv4 is not available on this platform',
      'Process host is not available on this platform',
      'Process ipv6 is not available on this platform',
      'Process nd is not available on this platform',
      'Process icmpv6 is not available on this platform',
      'Process udp is not available on this platform',
      'Process tcp is not available on this platform',
      'Process dhcp-client is not available on this platform',
      'Process dns-client is not available on this platform',
      'Process http-client is not available on this platform',
      'Process traceroute is not available on this platform',
    ]);
    expect(h.device.bootedAt).toBeDefined();
  });

  it('a device created powered off boots only after setPower(true)', () => {
    const p = pcProcs();
    const h = harness({ processes: p.processes, power: false });
    expect(h.kinds('deviceState')).toHaveLength(0);
    h.device.setPower(true, 100);
    expect(h.scheduler.peekTime()).toBe(100 + 2 * SEC);
    h.device.setPower(true, 200); // no-op
    expect(h.scheduler.size).toBe(1);
    boot(h);
    expect(h.device.bootedAt).toBe(100 + 2 * SEC);
  });
});

describe('device runtime: startup-config application', () => {
  it('applies startup lines through onConfig in order (hostname, interface lines, global ip lines)', () => {
    const p = pcProcs();
    const startup = [
      'hostname PC9',
      'interface GigabitEthernet0',
      ' description uplink to switch',
      ' ip address 10.0.0.1 255.255.255.0',
      'ip default-gateway 10.0.0.254',
      'end',
    ].join('\n');
    const h = harness({ processes: p.processes, startupConfig: startup });
    expect(h.device.startup).toBeDefined();
    boot(h);
    const deltas = p.host.calls.filter((c) => c.kind === 'onConfig').map((c) => c.delta!);
    expect(deltas.map((d) => [d.op, d.context, d.line])).toEqual([
      ['set', [], ['hostname', 'PC9']],
      ['set', [['interface', 'GigabitEthernet0']], ['description', 'uplink to switch']],
      ['set', [['interface', 'GigabitEthernet0']], ['ip', 'address', '10.0.0.1', '255.255.255.0']],
      ['set', [], ['ip', 'default-gateway', '10.0.0.254']],
    ]);
    expect(deltas[0]?.before).toEqual(['PC1']);
    // every process saw the same deltas, in model order, before init
    expect(p.arp.calls.map((c) => c.kind)).toEqual(['onConfig', 'onConfig', 'onConfig', 'onConfig', 'init']);
    expect(p.ipv4.calls.filter((c) => c.kind === 'onConfig')).toHaveLength(4);
    expect(h.device.hostname).toBe('PC9');
    expect(h.device.running.get('hostname')).toEqual(['PC9']);
    expect(h.device.running.get('interface.GigabitEthernet0.ip.address')).toEqual(['10.0.0.1', '255.255.255.0']);
    expect(h.device.running.get('ip.default-gateway')).toEqual(['10.0.0.254']);
    const changes = h.kinds('configChange') as Extract<TraceEvent, { kind: 'configChange' }>[];
    expect(changes.map((c) => c.line)).toEqual([
      'hostname PC9',
      'description uplink to switch',
      'ip address 10.0.0.1 255.255.255.0',
      'ip default-gateway 10.0.0.254',
    ]);
    // the running-config round-trips the startup text
    expect(h.device.running.render()).toBe(h.device.startup!.render());
  });

  it('on a router, an interface section without shutdown brings the port admin-up', () => {
    const arp = fakeProcess('arp');
    const ipv4 = fakeProcess('ipv4');
    const icmpv4 = fakeProcess('icmpv4');
    const startup = [
      'hostname R1',
      'interface GigabitEthernet0/0',
      ' ip address 192.168.1.1 255.255.255.0',
      ' no shutdown',
      'interface GigabitEthernet0/1',
      ' shutdown',
      'ip route 0.0.0.0 0.0.0.0 192.168.1.254',
    ].join('\n');
    const h = harness({ type: 'router.nf2911', name: 'R1', processes: { arp: arp.factory, ipv4: ipv4.factory, icmpv4: icmpv4.factory }, startupConfig: startup });
    boot(h);
    expect(h.device.port('GigabitEthernet0/0')?.adminUp).toBe(true);
    expect(h.device.port('GigabitEthernet0/1')?.adminUp).toBe(false);
    expect(h.device.port('Serial0/0/0')?.adminUp).toBe(false);
    const deltas = ipv4.calls.filter((c) => c.kind === 'onConfig').map((c) => [c.delta!.op, ...c.delta!.line]);
    expect(deltas).toEqual([
      ['set', 'ip', 'address', '192.168.1.1', '255.255.255.0'],
      ['unset', 'shutdown'],
      ['set', 'ip', 'route', '0.0.0.0', '0.0.0.0', '192.168.1.254'],
    ]);
    const text = h.device.running.render();
    expect(text).toContain('interface GigabitEthernet0/0\n ip address 192.168.1.1 255.255.255.0\n!');
    expect(text).toContain('interface GigabitEthernet0/1\n shutdown');
    expect(text).toContain('ip route 0.0.0.0 0.0.0.0 192.168.1.254');
    // the link model was told about the admin change during config load, then about every port at boot
    const gi0 = h.adminCalls.filter((c) => c.ref.port === 'GigabitEthernet0/0');
    expect(gi0.map((c) => c.adminUp)).toEqual([true, true]);
    const logs = h.kinds('log') as Extract<TraceEvent, { kind: 'log' }>[];
    expect(logs.some((l) => l.facility === 'LINK' && l.message === 'Interface GigabitEthernet0/0 administratively enabled')).toBe(true);
  });

  it('unknown interfaces in the startup config are logged and skipped', () => {
    const p = pcProcs();
    const h = harness({ processes: p.processes, startupConfig: 'interface FastEthernet9/9\n ip address 1.1.1.1 255.0.0.0\n' });
    boot(h);
    expect(p.ipv4.calls.filter((c) => c.kind === 'onConfig')).toHaveLength(0);
    const logs = h.kinds('log') as Extract<TraceEvent, { kind: 'log' }>[];
    expect(logs.some((l) => l.message.includes('unknown interface FastEthernet9/9'))).toBe(true);
  });

  it('saveConfig copies running into startup; eraseStartup clears it; a reload loses unsaved changes', () => {
    const p = pcProcs();
    const h = harness({ processes: p.processes });
    boot(h);
    expect(h.device.startup).toBeUndefined();
    expect(h.device.applyConfigLine([], ['hostname', 'Saved'], false)).toEqual({ ok: true });
    h.device.saveConfig();
    expect(h.device.startup?.get('hostname')).toEqual(['Saved']);
    expect(h.device.startup).not.toBe(h.device.running);
    expect(h.device.applyConfigLine([], ['hostname', 'Unsaved'], false).ok).toBe(true);
    const t = h.device.bootedAt! + 10;
    h.device.reload(t);
    expect(h.device.power).toBe(true);
    expect(h.device.bootedAt).toBeUndefined();
    expect(h.device.hostname).toBe('PC1');
    h.run(t + 2 * SEC);
    expect(h.device.hostname).toBe('Saved');
    expect(p.arp.instances).toBe(2);
    h.device.eraseStartup();
    expect(h.device.startup).toBeUndefined();
  });
});

describe('device runtime: config lines', () => {
  it('rejects an unknown interface context and empty lines', () => {
    const p = pcProcs();
    const h = harness({ processes: p.processes });
    boot(h);
    expect(h.device.applyConfigLine([['interface', 'Gi9']], ['ip', 'address', '1.1.1.1', '255.0.0.0'], false)).toEqual({ ok: false, error: 'Unknown interface Gi9' });
    expect(h.device.applyConfigLine([], [], false).ok).toBe(false);
    expect(h.device.applyConfigLine([], ['hostname'], false).ok).toBe(false);
    expect(p.arp.calls.filter((c) => c.kind === 'onConfig')).toHaveLength(0);
  });

  it('fans the delta out to every process in model order and applies collected actions afterwards', () => {
    const order: string[] = [];
    const arp = fakeProcess('arp', { onConfig: () => { order.push('arp.onConfig'); return [{ type: 'log', severity: 6, facility: 'T', message: 'from-arp' }]; } });
    const ipv4 = fakeProcess('ipv4', { onConfig: () => { order.push('ipv4.onConfig'); return [{ type: 'log', severity: 6, facility: 'T', message: 'from-ipv4' }]; } });
    const icmpv4 = fakeProcess('icmpv4', { onConfig: () => { order.push('icmpv4.onConfig'); return []; } });
    const host = fakeProcess('host', { onConfig: () => { order.push('host.onConfig'); return []; } });
    const h = harness({ processes: { arp: arp.factory, ipv4: ipv4.factory, icmpv4: icmpv4.factory, host: host.factory } });
    boot(h);
    h.events.length = 0;
    const res = h.device.applyConfigLine([['interface', 'GigabitEthernet0']], ['ip', 'address', '10.0.0.1', '255.255.255.0'], false);
    expect(res).toEqual({ ok: true });
    expect(order).toEqual(['arp.onConfig', 'ipv4.onConfig', 'icmpv4.onConfig', 'host.onConfig']);
    const kinds = h.events.map((e) => e.kind);
    // all onConfig calls happen before any action is applied; configChange is last
    expect(kinds).toEqual(['log', 'log', 'configChange']);
    const logs = h.kinds('log') as Extract<TraceEvent, { kind: 'log' }>[];
    expect(logs.map((l) => l.message)).toEqual(['from-arp', 'from-ipv4']);
    expect(h.kinds('configChange')[0]).toEqual({
      t: h.device.bootedAt, kind: 'configChange', device: 'd_1', line: 'ip address 10.0.0.1 255.255.255.0', negate: false, context: [['interface', 'GigabitEthernet0']],
    });
    // a no-op re-set produces no delta, no fan-out and no trace
    order.length = 0;
    h.events.length = 0;
    expect(h.device.applyConfigLine([['interface', 'GigabitEthernet0']], ['ip', 'address', '10.0.0.1', '255.255.255.0'], false)).toEqual({ ok: true });
    expect(order).toEqual([]);
    expect(h.events).toEqual([]);
    // negate
    expect(h.device.applyConfigLine([['interface', 'GigabitEthernet0']], ['ip', 'address'], true)).toEqual({ ok: true });
    expect(arp.calls.at(-1)?.delta).toMatchObject({ op: 'unset', line: ['ip', 'address'], before: ['10.0.0.1', '255.255.255.0'] });
    expect(h.device.running.get('interface.GigabitEthernet0.ip.address')).toBeUndefined();
  });

  it('hostname updates the device name; no hostname restores the default', () => {
    const p = pcProcs();
    const h = harness({ processes: p.processes });
    boot(h);
    h.device.applyConfigLine([], ['hostname', 'Alpha'], false);
    expect(h.device.hostname).toBe('Alpha');
    expect(p.arp.ctx?.hostname).toBe('Alpha');
    h.device.applyConfigLine([], ['hostname'], true);
    expect(h.device.hostname).toBe('PC1');
    expect(h.device.running.get('hostname')).toEqual(['PC1']);
  });

  it('a global no-line that removes nothing is kept as a "no" node', () => {
    const p = pcProcs();
    const h = harness({ processes: p.processes });
    boot(h);
    // a line with no rule of its own: `ip domain-lookup` is a stored negation from P1 W5 (§6), so it is no
    // longer an example of the `no …` fallback node this test is about
    expect(h.device.applyConfigLine([], ['snmp-server', 'community', 'lab'], true)).toEqual({ ok: true });
    expect(h.device.running.render()).toContain('no snmp-server community lab');
    expect(p.arp.calls.at(-1)?.delta?.line).toEqual(['no', 'snmp-server', 'community', 'lab']);
  });

  it('shutdown / no shutdown drive setPortAdmin, portState, a LINK log and deps.onPortAdmin', () => {
    const p = pcProcs();
    const h = harness({ processes: p.processes });
    boot(h);
    h.adminCalls.length = 0;
    h.events.length = 0;
    const at = h.device.bootedAt!;
    expect(h.device.applyConfigLine([['interface', 'GigabitEthernet0']], ['shutdown'], false)).toEqual({ ok: true });
    expect(h.device.port('GigabitEthernet0')?.adminUp).toBe(false);
    expect(h.device.running.render()).toContain('interface GigabitEthernet0\n shutdown');
    expect(h.adminCalls).toEqual([{ ref: { device: 'd_1', port: 'GigabitEthernet0' }, adminUp: false, now: at }]);
    expect(h.kinds('portState')).toEqual([{ t: at, kind: 'portState', device: 'd_1', port: 'GigabitEthernet0', adminUp: false, operUp: false, reason: 'admin-down' }]);
    expect(h.kinds('log')).toEqual([{ t: at, kind: 'log', device: 'd_1', severity: 3, facility: 'LINK', message: 'Interface GigabitEthernet0 administratively down' }]);
    expect(h.events.map((e) => e.kind)).toEqual(['portState', 'log', 'configChange']);
    expect(p.ipv4.calls.at(-1)?.delta).toMatchObject({ op: 'set', line: ['shutdown'], context: [['interface', 'GigabitEthernet0']] });
    // repeated shutdown is a no-op everywhere
    h.adminCalls.length = 0;
    h.device.applyConfigLine([['interface', 'GigabitEthernet0']], ['shutdown'], false);
    expect(h.adminCalls).toEqual([]);
    // no shutdown
    h.device.applyConfigLine([['interface', 'GigabitEthernet0']], ['shutdown'], true);
    expect(h.device.port('GigabitEthernet0')?.adminUp).toBe(true);
    expect(h.adminCalls).toEqual([{ ref: { device: 'd_1', port: 'GigabitEthernet0' }, adminUp: true, now: at }]);
    expect(h.device.running.render()).not.toContain('shutdown');
    expect(p.ipv4.calls.at(-1)?.delta).toMatchObject({ op: 'unset', line: ['shutdown'] });
  });

  it('setPortAdmin called directly keeps the running-config in step and ignores console ports', () => {
    const h = harness({ type: 'router.nf2911', name: 'R1', power: false });
    h.device.setPortAdmin('GigabitEthernet0/0', true, 5);
    expect(h.device.port('GigabitEthernet0/0')?.adminUp).toBe(true);
    expect(h.device.running.query('interface.GigabitEthernet0/0.shutdown')).toHaveLength(0);
    expect(h.adminCalls).toHaveLength(1);
    h.device.setPortAdmin('Console', false, 5);
    expect(h.device.port('Console')?.adminUp).toBe(true);
    h.device.setPortAdmin('nope', false, 5);
    expect(h.adminCalls).toHaveLength(1);
  });
});

describe('device runtime: power', () => {
  it('setPower(off) clears tables, processes, timers, running-config and port state, and lowers every port', () => {
    const p = pcProcs();
    const arp = fakeProcess('arp', { init: () => [{ type: 'timer', key: 'age', delay: 1000 }] });
    const h = harness({ processes: { ...p.processes, arp: arp.factory } });
    boot(h);
    const at = h.device.bootedAt!;
    h.device.tables.arp.set({ key: '10.0.0.2', ip: '10.0.0.2', mac: MAC_B, iface: 'GigabitEthernet0', type: 'dynamic', updatedAt: at });
    h.device.applyConfigLine([], ['hostname', 'Gone'], false);
    h.device.applyActions('ipv4', [{ type: 'setPortL3', port: 'GigabitEthernet0', ipv4: { address: '10.0.0.1', prefixLen: 24 } }], at);
    h.device.port('GigabitEthernet0')!.counters.inPackets = 7;
    expect(h.scheduler.size).toBe(1); // the arp timer
    h.events.length = 0;
    h.adminCalls.length = 0;

    h.device.setPower(false, at + 5);
    expect(h.device.power).toBe(false);
    expect(h.device.bootedAt).toBeUndefined();
    expect(h.device.processes.size).toBe(0);
    expect(h.device.tables.arp.size).toBe(0);
    expect(h.device.hostname).toBe('PC1');
    expect(h.device.running.get('hostname')).toEqual(['PC1']);
    expect(h.device.port('GigabitEthernet0')?.l3).toEqual({});
    expect(h.device.port('GigabitEthernet0')?.counters.inPackets).toBe(0);
    expect(h.device.stateSnapshots()).toEqual([]);
    expect(h.device.recentDebug()).toEqual([]);
    expect(h.kinds('tableExpire')).toHaveLength(1);
    expect(h.kinds('deviceState')).toEqual([{ t: at + 5, kind: 'deviceState', device: 'd_1', power: false, booted: false }]);
    expect(h.adminCalls).toEqual([{ ref: { device: 'd_1', port: 'GigabitEthernet0' }, adminUp: false, now: at + 5 }]);
    // the pending timer was cancelled: nothing fires
    expect(h.run()).toBe(0);
    expect(h.device.uptime(at + 100)).toBe(0);
    // powering off again is a no-op
    h.events.length = 0;
    h.device.setPower(false, at + 6);
    expect(h.events).toEqual([]);
  });

  it('powering off before boot cancels the pending boot event', () => {
    const p = pcProcs();
    const h = harness({ processes: p.processes });
    expect(h.scheduler.size).toBe(1);
    h.device.setPower(false, 1);
    expect(h.run()).toBe(0);
    expect(h.device.bootedAt).toBeUndefined();
    expect(p.arp.instances).toBe(0);
  });

  it('onBoot is ignored when the device is off or already booted', () => {
    const p = pcProcs();
    const h = harness({ processes: p.processes });
    boot(h);
    h.device.onBoot(h.device.bootedAt! + 1);
    expect(p.arp.instances).toBe(1);
    h.device.setPower(false, h.device.bootedAt! + 2);
    h.device.onBoot(h.device.bootedAt ?? 10);
    expect(h.device.processes.size).toBe(0);
  });
});

describe('device runtime: timers', () => {
  it('arms, re-arms (cancelling the old event), cancels, and ignores stale firings', () => {
    let fired: string[] = [];
    const arp = fakeProcess('arp', {
      init: () => [{ type: 'timer', key: 'retry', delay: 1000 }],
      onTimer: (_ctx, key) => { fired.push(key); return []; },
    });
    const p = pcProcs();
    const h = harness({ processes: { ...p.processes, arp: arp.factory } });
    boot(h);
    const at = h.device.bootedAt!;
    expect(h.scheduler.peekTime()).toBe(at + 1000);
    // re-arm: the old event is tombstoned, the new one fires once at the new time
    h.device.applyActions('arp', [{ type: 'timer', key: 'retry', delay: 2000 }], at + 100);
    expect(h.run()).toBe(1);
    expect(fired).toEqual(['retry']);
    expect(arp.calls.at(-1)).toMatchObject({ kind: 'onTimer', key: 'retry', at: at + 2100 });
    // a stale firing (wrong time or no entry) is ignored
    fired = [];
    h.device.onTimer('arp', 'retry', at + 5000);
    expect(fired).toEqual([]);
    // cancel
    h.device.applyActions('arp', [{ type: 'timer', key: 'retry', delay: 500 }], at + 3000);
    h.device.applyActions('arp', [{ type: 'cancelTimer', key: 'retry' }], at + 3000);
    expect(h.run()).toBe(0);
    expect(fired).toEqual([]);
    // timers are keyed per process: the same key on another process is independent
    h.device.applyActions('arp', [{ type: 'timer', key: 'k', delay: 10 }], at + 4000);
    h.device.applyActions('ipv4', [{ type: 'timer', key: 'k', delay: 20 }], at + 4000);
    expect(h.run()).toBe(2);
    expect(fired).toEqual(['k']);
    expect(p.ipv4.calls.at(-1)).toMatchObject({ kind: 'onTimer', key: 'k', at: at + 4020 });
    // fractional delays are rounded so SimTime stays integral
    h.device.applyActions('arp', [{ type: 'timer', key: 'f', delay: 10.4 }], at + 5000);
    expect(h.scheduler.peekTime()).toBe(at + 5010);
    h.run();
    // a timer for an unknown process is ignored without throwing
    h.device.onTimer('ghost', 'x', at + 6000);
  });
});

describe('device runtime: actions', () => {
  it('send counts outPackets/outBytes on success and outDrops on link-down', () => {
    const p = pcProcs();
    const h = harness({ processes: p.processes });
    boot(h);
    const at = h.device.bootedAt!;
    const f = arpFrame(h);
    h.device.applyActions('arp', [{ type: 'send', port: 'GigabitEthernet0', pdu: f }], at);
    const port = h.device.port('GigabitEthernet0')!;
    expect(h.transmits).toHaveLength(1);
    expect(h.transmits[0]?.from).toEqual({ device: 'd_1', port: 'GigabitEthernet0' });
    expect(port.counters.outPackets).toBe(1);
    expect(port.counters.outBytes).toBe(f.size);
    expect(port.lastOutput).toBe(at);
    h.setTransmit(() => ({ ok: false, reason: 'link-down' }));
    h.device.applyActions('arp', [{ type: 'send', port: 'GigabitEthernet0', pdu: f }], at);
    expect(port.counters.outPackets).toBe(1);
    expect(port.counters.outDrops).toBe(1);
    // unknown port → drop
    h.device.applyActions('arp', [{ type: 'send', port: 'Gi9', pdu: f }], at);
    expect(h.transmits).toHaveLength(2);
    expect(h.kinds('drop').at(-1)).toMatchObject({ reason: 'other', detail: 'unknown-port:Gi9' });
  });

  it('deliver, request, drop, consume, cliOutput, cliDone, setPortL3 and log map to their targets', () => {
    const icmpv4 = fakeProcess('icmpv4', {
      onPdu: (_c, pdu) => [{ type: 'consume', pdu }],
      onRequest: () => [{ type: 'cliOutput', session: 's_1', text: '!' }, { type: 'cliDone', session: 's_1' }],
    });
    const p = pcProcs();
    const h = harness({ processes: { ...p.processes, icmpv4: icmpv4.factory } });
    boot(h);
    const at = h.device.bootedAt!;
    h.events.length = 0;
    const f = arpFrame(h);
    const actions: Action[] = [
      { type: 'deliver', to: 'icmpv4', pdu: f, port: 'GigabitEthernet0' },
      { type: 'request', to: 'icmpv4', req: { kind: 'icmp.abort', session: 's_1' } },
      { type: 'drop', pdu: f, reason: 'no-route', detail: '10.9.9.9', port: 'GigabitEthernet0' },
      { type: 'setPortL3', port: 'GigabitEthernet0', ipv4: { address: '10.0.0.1', prefixLen: 24 } },
      { type: 'log', severity: 5, facility: 'SYS', message: 'hello' },
      { type: 'request', to: 'ghost', req: { kind: 'icmp.abort', session: 's_1' } },
      { type: 'deliver', to: 'ghost', pdu: f, port: 'GigabitEthernet0' },
      // §9.2 / §0 rule 2: the member-less clear went at the W8 exit gate; ipv4 clears with `ipv4: null`.
      { type: 'setPortL3', port: 'GigabitEthernet0', ipv4: null },
    ];
    h.device.applyActions('ipv4', actions, at);
    expect(icmpv4.calls.map((c) => c.kind)).toEqual(['init', 'onPdu', 'onRequest']);
    expect(h.cli.output).toEqual([{ session: 's_1', text: '!', now: at }]);
    expect(h.cli.done).toEqual([{ session: 's_1', now: at }]);
    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toEqual(['pduCreated', 'pduConsumed', 'drop', 'log', 'debug', 'drop'].filter((k) => k !== 'pduCreated'));
    expect(h.kinds('pduConsumed')[0]).toMatchObject({ device: 'd_1', process: 'icmpv4', pdu: { id: f.id, proto: 'arp' } });
    expect(h.kinds('drop')[0]).toMatchObject({ device: 'd_1', port: 'GigabitEthernet0', reason: 'no-route', detail: '10.9.9.9' });
    expect(h.kinds('drop')[1]).toMatchObject({ reason: 'unsupported-protocol', detail: 'no process ghost' });
    expect(h.kinds('log')[0]).toMatchObject({ severity: 5, facility: 'SYS', message: 'hello' });
    expect(h.kinds('debug')[0]).toMatchObject({ event: { process: 'ipv4', category: 'runtime' } });
    expect(h.device.port('GigabitEthernet0')?.l3).toEqual({});
    expect(h.device.recentDebug(10)).toHaveLength(1);
  });

  it('applies actions depth-first in returned order', () => {
    const seen: string[] = [];
    const a = fakeProcess('arp', { onPdu: () => { seen.push('arp'); return [{ type: 'log', severity: 6, facility: 'T', message: 'inner' }]; } });
    const p = pcProcs();
    const h = harness({ processes: { ...p.processes, arp: a.factory } });
    boot(h);
    const f = arpFrame(h);
    h.events.length = 0;
    h.device.applyActions('ipv4', [
      { type: 'log', severity: 6, facility: 'T', message: 'first' },
      { type: 'deliver', to: 'arp', pdu: f, port: 'GigabitEthernet0' },
      { type: 'log', severity: 6, facility: 'T', message: 'last' },
    ], h.device.bootedAt!);
    const logs = h.kinds('log') as Extract<TraceEvent, { kind: 'log' }>[];
    expect(logs.map((l) => l.message)).toEqual(['first', 'inner', 'last']);
  });

  it('stops at the action budget without throwing and drops the pdus still in hand', () => {
    let calls = 0;
    const arp = fakeProcess('arp', {
      onPdu: (_c, pdu, port) => { calls++; return [{ type: 'deliver', to: 'arp', pdu, port }, { type: 'deliver', to: 'arp', pdu, port }]; },
    });
    const p = pcProcs();
    const h = harness({ processes: { ...p.processes, arp: arp.factory } });
    boot(h);
    const f = arpFrame(h);
    h.events.length = 0;
    expect(() => h.device.applyActions('ipv4', [{ type: 'deliver', to: 'arp', pdu: f, port: 'GigabitEthernet0' }], h.device.bootedAt!)).not.toThrow();
    expect(calls).toBe(ACTION_BUDGET);
    const drops = h.kinds('drop') as Extract<TraceEvent, { kind: 'drop' }>[];
    expect(drops.length).toBeGreaterThan(0);
    expect(drops.every((d) => d.reason === 'other' && d.detail === 'action-budget' && d.pdu.id === f.id)).toBe(true);
    // the next top-level call has a fresh budget
    calls = 0;
    h.device.applyActions('ipv4', [{ type: 'deliver', to: 'arp', pdu: f, port: 'GigabitEthernet0' }], h.device.bootedAt!);
    expect(calls).toBe(ACTION_BUDGET);
  });
});

describe('device runtime: link changes', () => {
  it('onPortOper fans onLinkChange out to processes and applies their actions', () => {
    const arp = fakeProcess('arp', { onLinkChange: (_c, port, up) => [{ type: 'log', severity: 6, facility: 'T', message: `${port}:${up}` }] });
    const p = pcProcs();
    const h = harness({ processes: { ...p.processes, arp: arp.factory } });
    boot(h);
    h.events.length = 0;
    h.device.onPortOper('GigabitEthernet0', true, h.device.bootedAt! + 1);
    expect(arp.calls.at(-1)).toMatchObject({ kind: 'onLinkChange', port: 'GigabitEthernet0', up: true });
    expect(p.ipv4.calls.at(-1)).toMatchObject({ kind: 'onLinkChange', port: 'GigabitEthernet0', up: true });
    expect(h.kinds('log')[0]).toMatchObject({ message: 'GigabitEthernet0:true' });
    h.device.onPortOper('nope', true, h.device.bootedAt! + 2);
    expect(arp.calls.filter((c) => c.kind === 'onLinkChange')).toHaveLength(1);
  });
});
