/**
 * W1 device (ARCHITECTURE-P2 §3.0 "Virtual oper state", §3.4, D10, D11): the P2 parts of device/ports.ts — the
 * virtual oper rules of the new roles and the VLAN-aware SVI rule with injected lookups (without lookups the P1 rule
 * applies unchanged, which is what device.ports.test.ts pins), the subinterface factory and plan, and the canonical
 * order of subinterfaces.
 */
import { describe, expect, it } from 'vitest';
import { deviceMacBase } from '../src/contracts/addr.js';
import type { VirtualFamilySpec } from '../src/contracts/catalog.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { PortId } from '../src/contracts/ids.js';
import { SPEED_1G, type PortState } from '../src/contracts/port.js';
import { defineModel, type ModelInput } from '../src/device/catalog/define.js';
import {
  VIRTUAL_PORT_MESSAGES,
  autoVirtualPortStates,
  canonicalPortKey,
  createPortState,
  createSubinterfacePortState,
  createVirtualPortState,
  evaluateVirtualOper,
  fixedPortStates,
  insertPorts,
  planSubinterface,
  recomputeVirtualOper,
  resetPortForPowerOff,
  subinterfacePortSpec,
  subinterfacesOf,
  sviVlanOf,
  vlanMissingMessage,
  type PortBuildContext,
  type VirtualOperLookups,
} from '../src/device/ports.js';
import { NF_2911_INPUT, ethInput } from './device.catalog.p0-inputs.js';

const BASE = deviceMacBase('d_0001');
const ON = { power: true, booted: true };

const router = defineModel(NF_2911_INPUT, 'P2');
const ML_INPUT: ModelInput = {
  type: 'mlswitch.nft3650',
  model: 'NF-T3650',
  description: 'Multilayer switch of the P2 port tests',
  category: 'multilayer-switches',
  icon: 'mlswitch',
  capabilities: ['layer3-switch', 'managed-switch'],
  ports: [ethInput('GigabitEthernet1/0/1', SPEED_1G, true), ethInput('GigabitEthernet1/0/2', SPEED_1G, true)],
};
const ml = defineModel(ML_INPUT, 'P2');

const ctxOf = (model: DeviceModel): PortBuildContext => ({ macBase: BASE, capabilities: model.capabilities, portsDefaultUp: model.portsDefaultUp });
const family = (model: DeviceModel, name: string): VirtualFamilySpec => (model.virtualFamilies ?? []).find((f) => f.family === name) as VirtualFamilySpec;
const mapOf = (states: readonly PortState[]): Map<PortId, PortState> => new Map(states.map((s) => [s.id, s]));

/** A multilayer switch with its auto Vlan1, a Vlan10 SVI and a Port-channel1. */
function mlPorts(): Map<PortId, PortState> {
  const ports = mapOf([...fixedPortStates(ml, ctxOf(ml)), ...autoVirtualPortStates(ml, BASE)]);
  insertPorts(ports, ml, [
    createVirtualPortState(family(ml, 'Vlan'), 10, BASE),
    createVirtualPortState(family(ml, 'Port-channel'), 1, BASE),
    createVirtualPortState(family(ml, 'Loopback'), 0, BASE),
  ]);
  return ports;
}

describe('virtual oper: the VLAN-aware SVI rule (§3.0)', () => {
  it('needs the VLAN to exist and one up bridged port that carries and forwards it', () => {
    const ports = mlPorts();
    const all = [...ports.values()];
    const vlan10 = ports.get('Vlan10') as PortState;
    vlan10.adminUp = true;
    const gi1 = ports.get('GigabitEthernet1/0/1') as PortState;
    gi1.operUp = true;

    const vlans = new Set([1, 10]);
    const carriers = new Set<string>();
    const lookups: VirtualOperLookups = { vlanExists: (v) => vlans.has(v), sviCarrier: (p, v) => carriers.has(`${p}|${v}`) };

    // the VLAN exists but no port carries it (not allowed on the trunk, or blocking)
    expect(evaluateVirtualOper(vlan10, all, ON, ml.capabilities, lookups)).toEqual({ up: false, reason: 'no-bridged-port-up' });
    carriers.add('GigabitEthernet1/0/1|10');
    expect(evaluateVirtualOper(vlan10, all, ON, ml.capabilities, lookups)).toEqual({ up: true });
    // the carrying port goes down
    gi1.operUp = false;
    expect(evaluateVirtualOper(vlan10, all, ON, ml.capabilities, lookups)).toEqual({ up: false, reason: 'no-bridged-port-up' });
    gi1.operUp = true;
    // the VLAN is deleted
    vlans.delete(10);
    expect(evaluateVirtualOper(vlan10, all, ON, ml.capabilities, lookups)).toEqual({ up: false, reason: 'vlan-missing' });
    expect(vlanMissingMessage('Vlan10', 10)).toBe('Interface Vlan10 stays down: VLAN 10 does not exist.');
  });

  it('keeps the P1 reason for Vlan1 and the P1 rule when no lookups are injected (§9.1)', () => {
    const ports = mlPorts();
    const all = [...ports.values()];
    const vlan1 = ports.get('Vlan1') as PortState;
    vlan1.adminUp = true;
    const lookups: VirtualOperLookups = { vlanExists: (v) => v === 1, sviCarrier: () => true };
    expect(evaluateVirtualOper(vlan1, all, ON, ml.capabilities, lookups)).toEqual({ up: false, reason: 'no-bridged-port-up' });
    (ports.get('GigabitEthernet1/0/1') as PortState).operUp = true;
    expect(evaluateVirtualOper(vlan1, all, ON, ml.capabilities, lookups)).toEqual({ up: true });
    // without lookups: the P1 rule (Vlan1 only, any bridged port up)
    const vlan10 = ports.get('Vlan10') as PortState;
    vlan10.adminUp = true;
    expect(evaluateVirtualOper(vlan10, all, ON, ml.capabilities)).toEqual({ up: false, reason: 'vlan-unsupported' });
    expect(evaluateVirtualOper(vlan1, all, ON, ml.capabilities)).toEqual({ up: true });
    // half a lookup pair is not enough to switch rules
    expect(evaluateVirtualOper(vlan10, all, ON, ml.capabilities, { vlanExists: () => true })).toEqual({ up: false, reason: 'vlan-unsupported' });
    expect(sviVlanOf('Vlan4094')).toBe(4094);
    expect(sviVlanOf('Vlan01')).toBe(1);
    expect(sviVlanOf('Port-channel1')).toBeUndefined();
    expect(sviVlanOf('GigabitEthernet0/0.10')).toBeUndefined();
  });
});

describe('virtual oper: Port-channel, subinterface and controller tunnel (D10, D11, D17)', () => {
  it('a Port-channel is up while one of its bundled members is up', () => {
    const ports = mlPorts();
    const all = [...ports.values()];
    const po1 = ports.get('Port-channel1') as PortState;
    expect(po1.adminUp).toBe(true); // the family starts up
    const bundled: PortId[] = [];
    const lookups: VirtualOperLookups = { bundledMembers: (b) => (b === 'Port-channel1' ? bundled : []) };
    expect(evaluateVirtualOper(po1, all, ON, ml.capabilities, lookups)).toEqual({ up: false, reason: 'no-bundled-member' });
    bundled.push('GigabitEthernet1/0/1');
    // the member is bundled but its link is down
    expect(evaluateVirtualOper(po1, all, ON, ml.capabilities, lookups)).toEqual({ up: false, reason: 'no-bundled-member' });
    (ports.get('GigabitEthernet1/0/1') as PortState).operUp = true;
    expect(evaluateVirtualOper(po1, all, ON, ml.capabilities, lookups)).toEqual({ up: true });
    // without the lookup no member is bundled
    expect(evaluateVirtualOper(po1, all, ON, ml.capabilities)).toEqual({ up: false, reason: 'no-bundled-member' });
    po1.adminUp = false;
    expect(evaluateVirtualOper(po1, all, ON, ml.capabilities, lookups)).toEqual({ up: false, reason: 'admin-down' });
  });

  it('a subinterface needs an up routed parent and an 802.1Q encapsulation', () => {
    const ports = mapOf(fixedPortStates(router, ctxOf(router)));
    const parent = ports.get('GigabitEthernet0/0') as PortState;
    insertPorts(ports, router, [createSubinterfacePortState(parent, 10)]);
    const subif = ports.get('GigabitEthernet0/0.10') as PortState;
    const all = () => [...ports.values()];

    expect(evaluateVirtualOper(subif, all(), ON, router.capabilities)).toEqual({ up: false, reason: 'parent-down' });
    parent.operUp = true;
    expect(evaluateVirtualOper(subif, all(), ON, router.capabilities)).toEqual({ up: false, reason: 'no-encapsulation' });
    subif.dot1q = { vid: 10, native: false };
    expect(evaluateVirtualOper(subif, all(), ON, router.capabilities)).toEqual({ up: true });
    // `switchport` on the parent (a routed role is required), then the parent goes down
    parent.role = 'switched';
    expect(evaluateVirtualOper(subif, all(), ON, router.capabilities)).toEqual({ up: false, reason: 'parent-down' });
    parent.role = 'routed';
    parent.operUp = false;
    expect(evaluateVirtualOper(subif, all(), ON, router.capabilities)).toEqual({ up: false, reason: 'parent-down' });
    parent.operUp = true;
    subif.adminUp = false;
    expect(evaluateVirtualOper(subif, all(), ON, router.capabilities)).toEqual({ up: false, reason: 'admin-down' });
    subif.adminUp = true;
    expect(evaluateVirtualOper(subif, all(), { power: true, booted: false }, router.capabilities)).toEqual({ up: false, reason: 'booting' });

    // power-off forgets the runtime encapsulation (the configuration replays it at the next boot)
    resetPortForPowerOff(subif, ctxOf(router), 500);
    expect(subif.dot1q).toBeUndefined();
  });

  it('a controller tunnel is up whenever the device is, and an err-disabled virtual port is down', () => {
    const tunnel = createVirtualPortState({ family: 'Capwap', short: 'Cw', role: 'wlan-tunnel', min: 0, max: 0, defaultAdminUp: false }, 0, BASE);
    expect(evaluateVirtualOper(tunnel, [], ON, ['wireless-controller'])).toEqual({ up: true });
    expect(evaluateVirtualOper(tunnel, [], { power: true, booted: false }, ['wireless-controller'])).toEqual({ up: false, reason: 'booting' });

    const ports = mlPorts();
    const po1 = ports.get('Port-channel1') as PortState;
    po1.errDisabled = 'channel-misconfig';
    expect(evaluateVirtualOper(po1, [...ports.values()], ON, ml.capabilities)).toEqual({ up: false, reason: 'err-disabled' });
  });

  it('recomputeVirtualOper passes the lookups on and writes the changes in Map order', () => {
    const ports = mlPorts();
    (ports.get('Vlan1') as PortState).adminUp = true;
    (ports.get('Vlan10') as PortState).adminUp = true;
    (ports.get('GigabitEthernet1/0/1') as PortState).operUp = true;
    const lookups: VirtualOperLookups = { vlanExists: (v) => v === 1, sviCarrier: () => true, bundledMembers: () => [] };
    expect(recomputeVirtualOper(ports, ON, ml.capabilities, 100, lookups)).toEqual([
      { port: 'Vlan1', operUp: true },
      { port: 'Loopback0', operUp: true },
    ]);
    expect((ports.get('Vlan10') as PortState).operUp).toBe(false);
    expect(recomputeVirtualOper(ports, ON, ml.capabilities, 110, lookups)).toEqual([]);
  });
});

describe('the subinterface factory and plan (D11)', () => {
  const parentOf = (): PortState => (mapOf(fixedPortStates(router, ctxOf(router))).get('GigabitEthernet0/0') as PortState);

  it('builds a subinterface from its parent: MAC, ordinal, MTU, admin up, role subif', () => {
    const parent = parentOf();
    parent.mtu = 1400;
    const subif = createSubinterfacePortState(parent, 10);
    expect(subif).toMatchObject({
      id: 'GigabitEthernet0/0.10',
      mac: parent.mac,
      ordinal: parent.ordinal,
      mtu: 1400,
      adminUp: true,
      operUp: false,
      role: 'subif',
      encap: 'ethernet',
    });
    expect(subif.dot1q).toBeUndefined();
    expect(subif.spec).toMatchObject({
      name: 'GigabitEthernet0/0.10',
      short: 'Gi0/0.10',
      kind: 'virtual',
      role: 'subif',
      allowedRoles: ['subif'],
      connector: 'none',
      parent: 'GigabitEthernet0/0',
      speedBps: parent.spec.speedBps,
    });
    expect(subinterfacePortSpec(parent, 4094).name).toBe('GigabitEthernet0/0.4094');
  });

  it('plans creation only on a routed parent of a model that supports subinterfaces, inside the number range', () => {
    const ports = mapOf(fixedPortStates(router, ctxOf(router)));
    const caps = router.capabilities;
    expect(router.subinterfaces).toEqual({ roles: ['routed'], max: 65535 });
    expect(planSubinterface(router, ports, 'GigabitEthernet0/0.10', caps)).toEqual({
      ok: true,
      created: true,
      port: 'GigabitEthernet0/0.10',
      parent: 'GigabitEthernet0/0',
      number: 10,
    });
    insertPorts(ports, router, [createSubinterfacePortState(ports.get('GigabitEthernet0/0') as PortState, 10)]);
    expect(planSubinterface(router, ports, 'GigabitEthernet0/0.10', caps)).toEqual({ ok: true, created: false, port: 'GigabitEthernet0/0.10' });

    expect(planSubinterface(router, ports, 'GigabitEthernet0/0.0', caps)).toEqual({ ok: false, error: 'Subinterfaces on this device are numbered 1 to 65535.' });
    expect(planSubinterface(router, ports, 'GigabitEthernet0/0.65536', caps)).toEqual({ ok: false, error: 'Subinterfaces on this device are numbered 1 to 65535.' });
    expect(planSubinterface(router, ports, 'Serial0/0/0.1', caps)).toEqual({
      ok: false,
      error: 'Serial0/0/0 is not a routed interface, so it cannot carry subinterfaces.',
    });
    expect(planSubinterface(router, ports, 'GigabitEthernet0/9.1', caps)).toEqual({ ok: false, error: 'This device cannot create an interface called GigabitEthernet0/9.1.' });
    expect(planSubinterface(router, ports, 'GigabitEthernet0/0', caps)).toEqual({ ok: true, created: false, port: 'GigabitEthernet0/0' });
    // a model without subinterface support, and a subinterface of a subinterface
    expect(planSubinterface({}, ports, 'GigabitEthernet0/1.10', caps)).toEqual({ ok: false, error: 'This device cannot create an interface called GigabitEthernet0/1.10.' });
    expect(planSubinterface(router, ports, 'GigabitEthernet0/0.10.5', caps)).toEqual({ ok: false, error: 'This device cannot create an interface called GigabitEthernet0/0.10.5.' });
    expect(planSubinterface(router, ports, 'GigabitEthernet0/1.010', caps)).toEqual({ ok: false, error: 'This device cannot create an interface called GigabitEthernet0/1.010.' });
    expect(VIRTUAL_PORT_MESSAGES.subinterfaceOutOfRange).toBe('Subinterfaces on this device are numbered 1 to {max}.');
  });

  it('sorts subinterfaces after every other virtual port, by parent position and number', () => {
    const ports = mapOf([...fixedPortStates(router, ctxOf(router)), ...autoVirtualPortStates(router, BASE)]);
    const gi0 = ports.get('GigabitEthernet0/0') as PortState;
    const gi1 = ports.get('GigabitEthernet0/1') as PortState;
    insertPorts(ports, router, [
      createSubinterfacePortState(gi1, 2),
      createSubinterfacePortState(gi0, 20),
      createVirtualPortState(family(router, 'Loopback'), 0, BASE),
      createSubinterfacePortState(gi0, 3),
    ]);
    expect([...ports.keys()]).toEqual([
      'GigabitEthernet0/0',
      'GigabitEthernet0/1',
      'Serial0/0/0',
      'Serial0/0/1',
      'Console',
      'Loopback0',
      'GigabitEthernet0/0.3',
      'GigabitEthernet0/0.20',
      'GigabitEthernet0/1.2',
    ]);
    expect(canonicalPortKey(router, (ports.get('GigabitEthernet0/0.20') as PortState).spec)).toEqual([3, 0, 0, 0, 20]);
    expect(canonicalPortKey(router, (ports.get('Loopback0') as PortState).spec)).toEqual([2, 0, 0]);
    expect(subinterfacesOf(ports.values(), 'GigabitEthernet0/0').map((p) => p.id)).toEqual(['GigabitEthernet0/0.3', 'GigabitEthernet0/0.20']);
    expect(subinterfacesOf(ports.values(), 'Serial0/0/0')).toEqual([]);
  });

  it('keeps module ports as parents in module order', () => {
    const modular = defineModel(
      {
        type: 'router.nft1941',
        model: 'NF-T1941',
        description: 'Modular router of the P2 port tests',
        category: 'routers',
        icon: 'router-modular',
        capabilities: ['routing'],
        ports: [ethInput('GigabitEthernet0/0', SPEED_1G, false)],
      },
      'P2',
    );
    const ports = mapOf(fixedPortStates(modular, ctxOf(modular)));
    // a port the model does not list (a module port) sorts after the fixed ones, and so do its subinterfaces
    const extra = createPortState({ name: 'GigabitEthernet0/1/0', short: 'Gi0/1/0', kind: 'ethernet', speedBps: SPEED_1G, role: 'routed', allowedRoles: ['routed'], encap: 'ethernet', ordinal: 144, connector: 'rj45', slot: '0/1', module: 'mod.test' }, 144, ctxOf(modular));
    insertPorts(ports, modular, [extra, createSubinterfacePortState(extra, 5), createSubinterfacePortState(ports.get('GigabitEthernet0/0') as PortState, 7)]);
    expect([...ports.keys()]).toEqual(['GigabitEthernet0/0', 'GigabitEthernet0/1/0', 'GigabitEthernet0/0.7', 'GigabitEthernet0/1/0.5']);
  });
});
