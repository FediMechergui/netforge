import { describe, expect, it } from 'vitest';
import { deviceMacBase, portMac } from '../src/contracts/addr.js';
import { SPEED_1G, type PortState } from '../src/contracts/port.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { VirtualFamilySpec } from '../src/contracts/catalog.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import { defineModel, defineModule, modulePortSpecs, type ModelInput } from '../src/device/catalog/define.js';
import {
  VIRTUAL_PORT_MESSAGES,
  autoVirtualPortStates,
  canonicalPortKey,
  checkVirtualPortRemoval,
  createPortState,
  createVirtualPortState,
  defaultAdminUpFor,
  evaluateVirtualOper,
  fixedPortStates,
  insertPorts,
  parseVirtualPortName,
  planVirtualPort,
  recomputeVirtualOper,
  refillPortMap,
  removePorts,
  resetPortForPowerOff,
  seedRunningConfig,
  virtualPortSpec,
  vlanUnsupportedMessage,
  type PortBuildContext,
} from '../src/device/ports.js';
import { NF_2911_INPUT, NF_C2960_INPUT, ethInput } from './device.catalog.p0-inputs.js';
import { testPortSpec } from './port.fixtures.js';

const BASE = deviceMacBase('d_0001');
const router = defineModel(NF_2911_INPUT, 'P0.5');
const sw = defineModel(NF_C2960_INPUT, 'P0.5');

const ML_INPUT: ModelInput = {
  type: 'mlswitch.nft3650',
  model: 'NF-T3650',
  description: 'Multilayer switch used by the port tests',
  category: 'multilayer-switches',
  icon: 'mlswitch',
  capabilities: ['layer3-switch'],
  ports: [ethInput('GigabitEthernet1/0/1', SPEED_1G, true), ethInput('GigabitEthernet1/0/2', SPEED_1G, true)],
};
const ml = defineModel(ML_INPUT, 'P0.5');

const MODULAR_INPUT: ModelInput = {
  type: 'router.nft1941',
  model: 'NF-T1941',
  description: 'Modular router used by the port tests',
  category: 'routers',
  icon: 'router-modular',
  capabilities: ['routing', 'modular'],
  ports: [
    ethInput('GigabitEthernet0/0', SPEED_1G, false),
    ethInput('GigabitEthernet0/1', SPEED_1G, false),
    { name: 'Console', kind: 'console', speedBps: 9_600 },
  ],
  slots: [
    { id: '0/0', label: 'Interface card slot 0', type: 'ehwic', numbering: '0/0' },
    { id: '0/1', label: 'Interface card slot 1', type: 'ehwic', numbering: '0/1' },
  ],
};
const modular = defineModel(MODULAR_INPUT, 'P0.5');
const SERIAL_CARD = defineModule({
  type: 'mod.t-2t',
  model: 'NF-T-2T',
  description: 'Two serial ports used by the port tests',
  fits: 'ehwic',
  ports: [{ family: 'Serial', count: 2, spec: { kind: 'serial', speedBps: 2_000_000 } }],
});

const ctxOf = (model: DeviceModel): PortBuildContext => ({ macBase: BASE, capabilities: model.capabilities, portsDefaultUp: model.portsDefaultUp });
const family = (model: DeviceModel, name: string): VirtualFamilySpec => model.virtualFamilies!.find((f) => f.family === name)!;
const mapOf = (states: PortState[]): Map<string, PortState> => new Map(states.map((s) => [s.id, s]));

describe('device/ports: fixed and module port construction', () => {
  it('builds NF-2911 ports with role, encapsulation, ordinal, D8 MAC, admin default and MTU', () => {
    const ports = fixedPortStates(router, ctxOf(router));
    expect(ports.map((p) => [p.id, p.role, p.encap, p.ordinal, p.adminUp])).toEqual([
      ['GigabitEthernet0/0', 'routed', 'ethernet', 1, false],
      ['GigabitEthernet0/1', 'routed', 'ethernet', 2, false],
      ['Serial0/0/0', 'wan', 'hdlc', 3, false],
      ['Serial0/0/1', 'wan', 'hdlc', 4, false],
      ['Console', 'console', 'none', 5, true],
    ]);
    expect(ports[0]?.mac).toBe('02:4e:59:e8:af:01');
    expect(ports[4]?.mac).toBe(portMac(BASE, 5));
    for (const p of ports) {
      expect(p.mtu).toBe(1500);
      expect(p.operUp).toBe(false);
      expect(p.counters.inPackets).toBe(0);
      expect(p.l3).toEqual({});
      expect(p.tx).toEqual({ busyUntil: 0, queue: 0 });
      expect(p.module).toBeUndefined();
    }
  });

  it('switch ports are switched and administratively up', () => {
    const ports = fixedPortStates(sw, ctxOf(sw));
    expect(ports).toHaveLength(26);
    expect(ports.every((p) => p.role === 'switched' && p.adminUp && p.encap === 'ethernet')).toBe(true);
    expect(ports[25]?.ordinal).toBe(26);
  });

  it('spec overrides win: defaultAdminUp, mtu, ordinal; a hand-built spec carries its default role and encap', () => {
    const spec = { ...router.ports[0]!, defaultAdminUp: true, mtu: 9216, ordinal: 40 };
    const p = createPortState(spec, 1, ctxOf(router));
    expect(p).toMatchObject({ adminUp: true, mtu: 9216, ordinal: 40, mac: portMac(BASE, 40) });
    const bare = createPortState(testPortSpec({ name: 'FastEthernet0/1', short: 'Fa0/1', kind: 'ethernet', speedBps: 100_000_000 }, ['switching'], 7), 7, { macBase: BASE, capabilities: ['switching'], portsDefaultUp: true });
    expect(bare).toMatchObject({ role: 'switched', encap: 'ethernet', ordinal: 7 });
    expect(defaultAdminUpFor({ defaultAdminUp: false }, 'console', true)).toBe(true);
    expect(defaultAdminUpFor({ defaultAdminUp: false }, 'routed', true)).toBe(false);
    expect(defaultAdminUpFor({}, 'routed', false)).toBe(false);
    expect(defaultAdminUpFor({}, 'repeater', false)).toBe(true);
  });

  it('module ports carry their slot ordinal, MAC and install record', () => {
    const slot1 = modular.slots![1]!;
    const specs = modulePortSpecs(modular, slot1, SERIAL_CARD);
    const ports = specs.map((s) => createPortState(s, 0, ctxOf(modular)));
    expect(ports.map((p) => [p.id, p.ordinal, p.mac, p.role, p.encap])).toEqual([
      ['Serial0/1/0', 144, portMac(BASE, 144), 'wan', 'hdlc'],
      ['Serial0/1/1', 145, portMac(BASE, 145), 'wan', 'hdlc'],
    ]);
    expect(ports[0]?.module).toEqual({ slot: '0/1', module: 'mod.t-2t' });
  });
});

describe('device/ports: virtual interfaces', () => {
  it('builds SVI and loopback instances with ordinal 0 and the base MAC', () => {
    const vlan = family(ml, 'Vlan');
    const lo = family(ml, 'Loopback');
    expect(virtualPortSpec(vlan, 10)).toEqual({
      name: 'Vlan10', short: 'Vl10', kind: 'virtual', speedBps: SPEED_1G, role: 'svi', allowedRoles: ['svi'],
      encap: 'ethernet', ordinal: 0, connector: 'none', defaultAdminUp: false,
    });
    const v = createVirtualPortState(vlan, 10, BASE);
    expect(v).toMatchObject({ id: 'Vlan10', role: 'svi', encap: 'ethernet', ordinal: 0, mac: portMac(BASE, 0), adminUp: false, operUp: false, mtu: 1500 });
    const l = createVirtualPortState(lo, 0, BASE);
    expect(l).toMatchObject({ id: 'Loopback0', role: 'virtual', encap: 'none', ordinal: 0, mac: '02:4e:59:e8:af:00', adminUp: true, operUp: false });
    expect(autoVirtualPortStates(ml, BASE).map((p) => p.id)).toEqual(['Vlan1']);
    expect(autoVirtualPortStates(router, BASE)).toEqual([]);
    expect(parseVirtualPortName(ml, 'Vlan10')).toMatchObject({ number: 10, name: 'Vlan10' });
    expect(parseVirtualPortName(ml, 'GigabitEthernet1/0/1')).toBeUndefined();
  });

  it('plans creation: existing, creatable, out of range, not creatable', () => {
    const ports = mapOf([...fixedPortStates(ml, ctxOf(ml)), ...autoVirtualPortStates(ml, BASE)]);
    expect(planVirtualPort(ml, ports, 'Vlan1')).toEqual({ ok: true, created: false, port: 'Vlan1' });
    expect(planVirtualPort(ml, ports, 'Loopback0')).toMatchObject({ ok: true, created: true, port: 'Loopback0', number: 0, family: { family: 'Loopback' } });
    expect(planVirtualPort(ml, ports, 'Vlan4095')).toEqual({ ok: false, error: 'Vlan interfaces on this device are numbered 1 to 4094.' });
    expect(planVirtualPort(ml, ports, 'Tunnel0')).toEqual({ ok: false, error: 'This device cannot create an interface called Tunnel0.' });
    expect(planVirtualPort(ml, ports, 'Vlan01')).toEqual({ ok: false, error: 'This device cannot create an interface called Vlan01.' });
    expect(planVirtualPort(sw, mapOf(fixedPortStates(sw, ctxOf(sw))), 'Vlan1')).toMatchObject({ ok: false });
  });

  it('refuses to remove built-in, physical and missing interfaces', () => {
    const ports = mapOf([...fixedPortStates(ml, ctxOf(ml)), ...autoVirtualPortStates(ml, BASE), createVirtualPortState(family(ml, 'Loopback'), 0, BASE)]);
    expect(checkVirtualPortRemoval(ml, ports, 'Vlan1')).toEqual({ ok: false, error: 'This interface is built in and cannot be removed.' });
    expect(VIRTUAL_PORT_MESSAGES.builtIn).toBe('This interface is built in and cannot be removed.');
    expect(checkVirtualPortRemoval(ml, ports, 'Loopback0')).toEqual({ ok: true });
    expect(checkVirtualPortRemoval(ml, ports, 'GigabitEthernet1/0/1')).toEqual({ ok: false, error: 'GigabitEthernet1/0/1 is a physical interface and cannot be removed.' });
    expect(checkVirtualPortRemoval(ml, ports, 'Loopback9')).toEqual({ ok: false, error: 'There is no interface called Loopback9.' });
  });
});

describe('device/ports: canonical Map order', () => {
  it('refills fixed, module (slot order) then virtual (family order, ascending number) in the same Map object', () => {
    const ctx = ctxOf(modular);
    const fixed = fixedPortStates(modular, ctx);
    const slot0 = modulePortSpecs(modular, modular.slots![0]!, SERIAL_CARD).map((s) => createPortState(s, 0, ctx));
    const slot1 = modulePortSpecs(modular, modular.slots![1]!, SERIAL_CARD).map((s) => createPortState(s, 0, ctx));
    const lo = family(modular, 'Loopback');
    const shuffled = [createVirtualPortState(lo, 10, BASE), slot1[1]!, fixed[2]!, createVirtualPortState(lo, 2, BASE), slot0[0]!, fixed[0]!, slot1[0]!, slot0[1]!, fixed[1]!];
    const ports = mapOf(shuffled);
    const identity = ports;
    refillPortMap(ports, modular);
    expect(ports).toBe(identity);
    expect([...ports.keys()]).toEqual([
      'GigabitEthernet0/0', 'GigabitEthernet0/1', 'Console',
      'Serial0/0/0', 'Serial0/0/1', 'Serial0/1/0', 'Serial0/1/1',
      'Loopback2', 'Loopback10',
    ]);
    expect(canonicalPortKey(modular, slot1[0]!.spec)).toEqual([1, 1, 144]);
  });

  it('orders SVIs before loopbacks and numbers numerically; insert and remove keep the order', () => {
    const ports = mapOf(fixedPortStates(ml, ctxOf(ml)));
    insertPorts(ports, ml, [createVirtualPortState(family(ml, 'Loopback'), 0, BASE), createVirtualPortState(family(ml, 'Vlan'), 10, BASE), createVirtualPortState(family(ml, 'Vlan'), 2, BASE)]);
    expect([...ports.keys()]).toEqual(['GigabitEthernet1/0/1', 'GigabitEthernet1/0/2', 'Vlan2', 'Vlan10', 'Loopback0']);
    expect(removePorts(ports, ml, ['Loopback0', 'Vlan2', 'Nope0'])).toEqual(['Vlan2', 'Loopback0']);
    expect([...ports.keys()]).toEqual(['GigabitEthernet1/0/1', 'GigabitEthernet1/0/2', 'Vlan10']);
  });
});

describe('device/ports: running-config seeding and power-off reset', () => {
  it('seeds hostname and one interface section per configurable port, shutdown when down', () => {
    const ast = createConfigAst();
    seedRunningConfig(ast, 'R1', fixedPortStates(router, ctxOf(router)), router.capabilities);
    expect(ast.get('hostname')).toEqual(['R1']);
    const sections = ast.query('interface');
    expect(sections.map((n) => n.args[0])).toEqual(['GigabitEthernet0/0', 'GigabitEthernet0/1', 'Serial0/0/0', 'Serial0/0/1']);
    expect(sections.every((n) => n.children.map((c) => c.key).join() === 'shutdown')).toBe(true);

    const swAst = createConfigAst();
    seedRunningConfig(swAst, 'S1', fixedPortStates(sw, ctxOf(sw)), sw.capabilities);
    expect(swAst.query('interface')).toHaveLength(26);
    expect(swAst.render()).not.toContain('shutdown');

    const mlAst = createConfigAst();
    seedRunningConfig(mlAst, 'M1', [...fixedPortStates(ml, ctxOf(ml)), ...autoVirtualPortStates(ml, BASE)], ml.capabilities);
    const vlan1 = mlAst.query('interface').find((n) => n.args[0] === 'Vlan1');
    expect(vlan1?.children.map((c) => c.key)).toEqual(['shutdown']);
  });

  it('power-off resets role, encapsulation, admin state, counters, L3 and virtual oper state', () => {
    const ports = fixedPortStates(ml, ctxOf(ml));
    const p = ports[0]!;
    p.role = 'routed';
    p.adminUp = false;
    p.counters.inPackets = 9;
    p.l3 = { ipv4: { address: '10.1.1.1', prefixLen: 24 } };
    p.errDisabled = 'loop';
    resetPortForPowerOff(p, ctxOf(ml), 50);
    expect(p).toMatchObject({ role: 'switched', encap: 'ethernet', adminUp: true, l3: {} });
    expect(p.counters.inPackets).toBe(0);
    expect(p.errDisabled).toBeUndefined();
    expect(p.lastChange).toBeUndefined();

    const lo = createVirtualPortState(family(ml, 'Loopback'), 0, BASE);
    lo.operUp = true;
    resetPortForPowerOff(lo, ctxOf(ml), 70);
    expect(lo).toMatchObject({ operUp: false, lastChange: 70, adminUp: true, role: 'virtual', encap: 'none' });
  });
});

describe('device/ports: virtual oper state', () => {
  function mlPorts(): Map<string, PortState> {
    const ports = mapOf([...fixedPortStates(ml, ctxOf(ml)), ...autoVirtualPortStates(ml, BASE)]);
    insertPorts(ports, ml, [createVirtualPortState(family(ml, 'Loopback'), 0, BASE)]);
    return ports;
  }

  it('SVI needs power, boot, admin up, VLAN 1 and a bridged port up; loopback needs power, boot and admin up', () => {
    const ports = mlPorts();
    const all = [...ports.values()];
    const vlan1 = ports.get('Vlan1')!;
    const lo = ports.get('Loopback0')!;
    const on = { power: true, booted: true };
    expect(evaluateVirtualOper(vlan1, all, { power: false, booted: false }, ml.capabilities)).toEqual({ up: false, reason: 'power-off' });
    expect(evaluateVirtualOper(lo, all, { power: true, booted: false }, ml.capabilities)).toEqual({ up: false, reason: 'booting' });
    expect(evaluateVirtualOper(vlan1, all, on, ml.capabilities)).toEqual({ up: false, reason: 'admin-down' });
    vlan1.adminUp = true;
    expect(evaluateVirtualOper(vlan1, all, on, ml.capabilities)).toEqual({ up: false, reason: 'no-bridged-port-up' });
    expect(evaluateVirtualOper(lo, all, on, ml.capabilities)).toEqual({ up: true });
    ports.get('GigabitEthernet1/0/1')!.operUp = true;
    expect(evaluateVirtualOper(vlan1, all, on, ml.capabilities)).toEqual({ up: true });
    lo.adminUp = false;
    expect(evaluateVirtualOper(lo, all, on, ml.capabilities)).toEqual({ up: false, reason: 'admin-down' });

    const vlan10 = createVirtualPortState(family(ml, 'Vlan'), 10, BASE);
    vlan10.adminUp = true;
    expect(evaluateVirtualOper(vlan10, all, on, ml.capabilities)).toEqual({ up: false, reason: 'vlan-unsupported' });
    expect(vlanUnsupportedMessage('Vlan10')).toBe('Interface Vlan10 stays down: only VLAN 1 is available in this release.');
    // a physical port reports its link-model oper state unchanged
    expect(evaluateVirtualOper(ports.get('GigabitEthernet1/0/2')!, all, on, ml.capabilities)).toEqual({ up: false });
  });

  it('recompute writes changed virtual ports in Map order and follows role changes of bridged ports', () => {
    const ports = mlPorts();
    ports.get('Vlan1')!.adminUp = true;
    const gi = ports.get('GigabitEthernet1/0/1')!;
    gi.operUp = true;
    const on = { power: true, booted: true };
    expect(recomputeVirtualOper(ports, on, ml.capabilities, 100)).toEqual([
      { port: 'Vlan1', operUp: true },
      { port: 'Loopback0', operUp: true },
    ]);
    expect(ports.get('Vlan1')!.lastChange).toBe(100);
    expect(gi.lastChange).toBeUndefined();
    expect(recomputeVirtualOper(ports, on, ml.capabilities, 110)).toEqual([]);
    gi.role = 'routed'; // `no switchport`: no bridged port is up any more
    expect(recomputeVirtualOper(ports, on, ml.capabilities, 120)).toEqual([{ port: 'Vlan1', operUp: false, reason: 'no-bridged-port-up' }]);
    expect(recomputeVirtualOper(ports, { power: false, booted: false }, ml.capabilities, 130)).toEqual([{ port: 'Loopback0', operUp: false, reason: 'power-off' }]);
  });
});
