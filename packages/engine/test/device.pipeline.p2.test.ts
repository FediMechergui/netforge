/**
 * W1 device (ARCHITECTURE-P2 §3.0 "Pipeline", D4, D11): the P2 steps of device/pipeline.ts —
 *  step 10  a tagged Ethernet frame may be 4 bytes longer (1522 at MTU 1500);
 *  step 10a subinterface classification on a `routed` port (`classifySubinterface`, the `subif` verdict, the
 *           encapsulation-mismatch drop) and the continuation on the subinterface (`subinterfaceVerdict`);
 *  step 10b the link-layer control rule (`linkLayerFilter`), also in the `ingress` action;
 *  step 12  the MAC filter accepts a `virtual4` MAC.
 * Tagged frames are built structurally (`FrameLike`), so the tests do not wait for the W1 dot1q codec.
 */
import { describe, expect, it } from 'vitest';
import { deviceMacBase } from '../src/contracts/addr.js';
import { BRIDGED_ROLES, L3_ROLES, type PortRole } from '../src/contracts/catalog.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { ProcessName } from '../src/contracts/ids.js';
import { ETHERTYPE_ARP, ETHERTYPE_IPV4, NF_L2_CONTROL_MAC, type FieldValue } from '../src/contracts/pdu.js';
import { SPEED_1G, emptyCounters, type PortSpec, type PortState } from '../src/contracts/port.js';
import type { DemuxSelector, Process } from '../src/contracts/process.js';
import { defineModel, type ModelInput } from '../src/device/catalog/define.js';
import { createPortState, createSubinterfacePortState } from '../src/device/ports.js';
import {
  PIPELINE_P2_DETAILS,
  buildDemuxIndex,
  classifySubinterface,
  frameArrivalVerdict,
  ingressVerdict,
  isLinkLayerControlMac,
  linkLayerFilter,
  subinterfaceVerdict,
  tagAllowance,
  type DemuxIndex,
  type FrameArrivalInput,
  type FrameLayerLike,
  type FrameLike,
  type PipelineSubif,
} from '../src/device/pipeline.js';
import { NF_2911_INPUT, ethInput } from './device.catalog.p0-inputs.js';

const BASE = deviceMacBase('d_0001');
const PEER = '02:00:00:00:00:99';
const OTHER = '02:00:00:00:00:77';
const BROADCAST = 'ff:ff:ff:ff:ff:ff';
const STP_MAC = '01:80:c2:00:00:00';
const VIRTUAL_MAC = '00:00:0c:9f:f0:01';

const router = defineModel(NF_2911_INPUT, 'P0.5');
const ML_INPUT: Omit<ModelInput, 'description'> = {
  type: 'mlswitch.nft3650',
  model: 'NF-T3650',
  category: 'multilayer-switches',
  icon: 'mlswitch',
  capabilities: ['layer3-switch'],
  ports: [ethInput('GigabitEthernet1/0/1', SPEED_1G, true)],
};
const ml = defineModel({ description: 'Multilayer switch of the P2 pipeline tests', ...ML_INPUT }, 'P0.5');

/** A live, oper-up port of `model`. */
function livePort(model: DeviceModel, name: string, over: Partial<PortSpec> = {}): PortState {
  const i = model.ports.findIndex((p) => p.name === name);
  const spec = { ...(model.ports[i] as PortSpec), ...over };
  const port = createPortState(spec, i + 1, { macBase: BASE, capabilities: model.capabilities, portsDefaultUp: true });
  port.adminUp = true;
  port.operUp = true;
  return port;
}

function fakeFrame(layers: FrameLayerLike[], size: number): FrameLike {
  return { layers, size, layer: (proto) => layers.find((l) => l.proto === proto) };
}

/** An Ethernet frame, optionally 802.1Q tagged, as the pipeline reads it. */
function ethFrame(dst: string, opts: { type?: number; vid?: number; size?: number; src?: string } = {}): FrameLike {
  const inner: Record<string, FieldValue> = { dst, src: opts.src ?? PEER, type: opts.vid === undefined ? (opts.type ?? ETHERTYPE_IPV4) : 0x8100, fcsValid: true };
  const layers: FrameLayerLike[] = [{ proto: 'ethernet', fields: inner }];
  if (opts.vid !== undefined) layers.push({ proto: 'dot1q', fields: { pcp: 0, dei: false, vid: opts.vid, type: opts.type ?? ETHERTYPE_IPV4 } });
  layers.push({ proto: 'payload', fields: {} });
  return fakeFrame(layers, opts.size ?? 64);
}

const proc = (handles: DemuxSelector[]): Pick<Process, 'handles'> => ({ handles });
function indexOf(entries: [ProcessName, DemuxSelector[]][]): DemuxIndex {
  return buildDemuxIndex(entries.map((e) => e[0]), new Map(entries.map(([name, handles]) => [name, proc(handles)])));
}
const BUILTIN = indexOf([
  ['eth-switch', [{ layer: 'ethernet', roles: BRIDGED_ROLES }]],
  ['arp', [{ layer: 'ethernet', ethertype: ETHERTYPE_ARP, roles: L3_ROLES }]],
  ['ipv4', [{ layer: 'ethernet', ethertype: ETHERTYPE_IPV4, roles: L3_ROLES }]],
]);

function arrive(port: PortState, frame: FrameLike, over: Partial<FrameArrivalInput> = {}) {
  return frameArrivalVerdict({ port, frame, booted: true, index: BUILTIN, ...over });
}

describe('step 10: the tag allowance (D4)', () => {
  it('an Ethernet frame may be 4 bytes longer when it carries an 802.1Q tag', () => {
    const port = livePort(ml, 'GigabitEthernet1/0/1');
    expect(port.mtu).toBe(1500);
    expect(arrive(port, ethFrame(BROADCAST, { size: 1518 }))).toMatchObject({ kind: 'deliver', process: 'eth-switch' });
    expect(arrive(port, ethFrame(BROADCAST, { size: 1519 }))).toEqual({ kind: 'drop', reason: 'giant', detail: '1519 bytes', counters: ['giants', 'inErrors'] });
    expect(arrive(port, ethFrame(BROADCAST, { vid: 10, size: 1522 }))).toMatchObject({ kind: 'deliver', process: 'eth-switch' });
    expect(arrive(port, ethFrame(BROADCAST, { vid: 10, size: 1523 }))).toEqual({ kind: 'drop', reason: 'giant', detail: '1523 bytes', counters: ['giants', 'inErrors'] });
    expect(tagAllowance('ethernet', ethFrame(BROADCAST, { vid: 10 }))).toBe(4);
    expect(tagAllowance('ethernet', ethFrame(BROADCAST))).toBe(0);
    expect(tagAllowance('dot11', ethFrame(BROADCAST, { vid: 10 }))).toBe(0);
  });
});

describe('step 10a: subinterface classification (D11, §3.4)', () => {
  const parent = (): PortState => livePort(router, 'GigabitEthernet0/0');
  const sub = (id: string, vid: number, native = false): PipelineSubif => ({ id, dot1q: { vid, native } });

  it('hands a tagged frame to the subinterface that carries its VLAN, and pops the tag', () => {
    const port = parent();
    const subs = [sub('GigabitEthernet0/0.10', 10), sub('GigabitEthernet0/0.20', 20), sub('GigabitEthernet0/0.99', 99, true)];
    expect(arrive(port, ethFrame(port.mac, { vid: 10 }), { subinterfaces: subs })).toEqual({ kind: 'subif', port: 'GigabitEthernet0/0.10', pop: true, counters: [] });
    expect(arrive(port, ethFrame(port.mac, { vid: 20 }), { subinterfaces: subs })).toEqual({ kind: 'subif', port: 'GigabitEthernet0/0.20', pop: true, counters: [] });
    // a tagged frame of the native VLAN is accepted by the native subinterface and popped too
    expect(arrive(port, ethFrame(port.mac, { vid: 99 }), { subinterfaces: subs })).toEqual({ kind: 'subif', port: 'GigabitEthernet0/0.99', pop: true, counters: [] });
  });

  it('drops a tagged frame no subinterface carries as encapsulation-mismatch', () => {
    const port = parent();
    const subs = [sub('GigabitEthernet0/0.10', 10)];
    expect(arrive(port, ethFrame(port.mac, { vid: 30 }), { subinterfaces: subs })).toEqual({
      kind: 'drop',
      reason: 'encapsulation-mismatch',
      detail: 'tagged frame for VLAN 30; no subinterface carries it',
      counters: ['inDrops'],
    });
    // and on a routed port with no subinterface at all (the state of every router before W2)
    expect(arrive(port, ethFrame(port.mac, { vid: 10 }))).toEqual({
      kind: 'drop',
      reason: 'encapsulation-mismatch',
      detail: 'tagged frame for VLAN 10; no subinterface carries it',
      counters: ['inDrops'],
    });
    // a subinterface without `encapsulation dot1Q` carries nothing
    expect(arrive(port, ethFrame(port.mac, { vid: 10 }), { subinterfaces: [{ id: 'GigabitEthernet0/0.10' }] })).toMatchObject({ reason: 'encapsulation-mismatch' });
  });

  it('gives an untagged frame to the native subinterface without popping, or leaves it on the parent', () => {
    const port = parent();
    expect(arrive(port, ethFrame(port.mac), { subinterfaces: [sub('GigabitEthernet0/0.99', 99, true)] })).toEqual({
      kind: 'subif',
      port: 'GigabitEthernet0/0.99',
      pop: false,
      counters: [],
    });
    // no native subinterface: the parent itself continues at step 10b
    expect(arrive(port, ethFrame(port.mac), { subinterfaces: [sub('GigabitEthernet0/0.10', 10)] })).toEqual({
      kind: 'deliver',
      process: 'ipv4',
      layer: 'ethernet',
      key: ETHERTYPE_IPV4,
      counters: [],
    });
  });

  it('runs only on a routed port and only after the earlier steps', () => {
    const switched = livePort(ml, 'GigabitEthernet1/0/1');
    // a bridged port carries tags to eth-switch, which classifies the VLAN itself (D5)
    expect(arrive(switched, ethFrame(BROADCAST, { vid: 10 }))).toMatchObject({ kind: 'deliver', process: 'eth-switch', counters: ['inBroadcasts'] });
    const port = parent();
    port.adminUp = false;
    expect(arrive(port, ethFrame(port.mac, { vid: 10 }))).toEqual({ kind: 'drop', reason: 'port-admin-down', counters: ['inDrops'] });
    port.adminUp = true;
    port.errDisabled = 'bpduguard';
    expect(arrive(port, ethFrame(port.mac, { vid: 10 }))).toMatchObject({ reason: 'port-err-disabled' });
    delete port.errDisabled;
    // step 10 precedes 10a: an oversized tagged frame is a giant, not an encapsulation mismatch
    expect(arrive(port, ethFrame(port.mac, { vid: 10, size: 1523 }))).toMatchObject({ reason: 'giant' });
  });

  it('classifySubinterface is pure: the first matching subinterface in port order wins', () => {
    const subs = [{ id: 'Gi0/0.10', dot1q: { vid: 10, native: false } }, { id: 'Gi0/0.11', dot1q: { vid: 10, native: false } }];
    expect(classifySubinterface(ethFrame(PEER, { vid: 10 }), subs)).toMatchObject({ port: 'Gi0/0.10' });
    expect(classifySubinterface(ethFrame(PEER), [])).toBeUndefined();
  });

  it('subinterfaceVerdict runs steps 10b–14 on the subinterface, which carries its parent MAC', () => {
    const port = parent();
    const subif = createSubinterfacePortState(port, 10);
    expect(subif.mac).toBe(port.mac);
    const ctx = { index: BUILTIN, capabilities: router.capabilities };
    expect(subinterfaceVerdict({ port: subif, frame: ethFrame(subif.mac), ...ctx })).toEqual({ kind: 'deliver', process: 'ipv4', layer: 'ethernet', key: ETHERTYPE_IPV4, counters: [] });
    expect(subinterfaceVerdict({ port: subif, frame: ethFrame(BROADCAST, { type: ETHERTYPE_ARP }), ...ctx })).toEqual({
      kind: 'deliver',
      process: 'arp',
      layer: 'ethernet',
      key: ETHERTYPE_ARP,
      counters: ['inBroadcasts'],
    });
    expect(subinterfaceVerdict({ port: subif, frame: ethFrame(OTHER), ...ctx })).toEqual({ kind: 'drop', reason: 'not-for-me', detail: OTHER, counters: ['inDrops'] });
    expect(subinterfaceVerdict({ port: subif, frame: ethFrame(STP_MAC), ...ctx })).toEqual({
      kind: 'drop',
      reason: 'not-for-me',
      detail: PIPELINE_P2_DETAILS.linkLayerControl,
      counters: [],
    });
  });
});

describe('step 10b: the link-layer control rule', () => {
  it('drops the reserved IEEE groups and the NF control group on a port that does not bridge, with no counter', () => {
    const port = livePort(router, 'GigabitEthernet0/0');
    for (const dst of [STP_MAC, '01:80:c2:00:00:02', '01:80:c2:00:00:0f', NF_L2_CONTROL_MAC]) {
      expect(arrive(port, ethFrame(dst, { type: 0x88b5 }))).toEqual({ kind: 'drop', reason: 'not-for-me', detail: 'link-layer control frame', counters: [] });
    }
    // just outside the reserved block: an ordinary group frame, which the demux then refuses by ethertype
    expect(arrive(port, ethFrame('01:80:c2:00:00:10'))).toMatchObject({ kind: 'deliver', process: 'ipv4', counters: ['inBroadcasts'] });
    expect(isLinkLayerControlMac('01:80:c2:00:00:0e')).toBe(true);
    expect(isLinkLayerControlMac('01:80:C2:00:00:00')).toBe(true);
    expect(isLinkLayerControlMac('01:80:c2:00:00:10')).toBe(false);
    expect(isLinkLayerControlMac(NF_L2_CONTROL_MAC)).toBe(true);
  });

  it('never applies to a bridged port or a promiscuous one', () => {
    expect(arrive(livePort(ml, 'GigabitEthernet1/0/1'), ethFrame(STP_MAC))).toMatchObject({ kind: 'deliver', process: 'eth-switch' });
    expect(arrive(livePort(router, 'GigabitEthernet0/0', { promiscuous: true }), ethFrame(STP_MAC))).toMatchObject({ kind: 'deliver', process: 'ipv4' });
    // HDLC frames have no destination and pass
    const hdlc = fakeFrame([{ proto: 'hdlc', fields: { address: 0x0f, control: 0, protocol: 0x0800, fcsValid: true } }, { proto: 'payload', fields: {} }], 100);
    expect(linkLayerFilter('wan', 'hdlc', hdlc.layers[0] as FrameLayerLike, { spec: {} })).toBeUndefined();
  });

  it('also guards the ingress action (the SVI clone eth-switch hands over)', () => {
    const svi: PortState = {
      ...createPortState({ name: 'Vlan1', short: 'Vl1', kind: 'virtual', speedBps: SPEED_1G, role: 'svi', allowedRoles: ['svi'], encap: 'ethernet', ordinal: 0, connector: 'none' }, 0, {
        macBase: BASE,
        capabilities: ml.capabilities,
        portsDefaultUp: true,
      }),
      counters: emptyCounters(),
    };
    expect(ingressVerdict({ port: svi, frame: ethFrame(STP_MAC), index: BUILTIN, capabilities: ml.capabilities })).toEqual({
      kind: 'drop',
      reason: 'not-for-me',
      detail: PIPELINE_P2_DETAILS.linkLayerControl,
      counters: [],
    });
    expect(ingressVerdict({ port: svi, frame: ethFrame(svi.mac), index: BUILTIN, capabilities: ml.capabilities })).toMatchObject({ kind: 'deliver', process: 'ipv4' });
  });

  it('applies to every non-bridged role that takes frames', () => {
    const roles: PortRole[] = ['routed', 'wan', 'mgmt', 'wireless-client', 'cellular', 'svi', 'subif'];
    for (const role of roles) {
      expect(linkLayerFilter(role, 'ethernet', ethFrame(STP_MAC).layers[0] as FrameLayerLike, { spec: {} })).toMatchObject({ reason: 'not-for-me' });
    }
    for (const role of ['switched', 'wireless-bss', 'radio-ptp', 'channel', 'wlan-tunnel'] as PortRole[]) {
      expect(linkLayerFilter(role, 'ethernet', ethFrame(STP_MAC).layers[0] as FrameLayerLike, { spec: {} })).toBeUndefined();
    }
  });
});

describe('step 12: the MAC filter accepts a virtual address MAC (D15)', () => {
  it('a frame for a virtual4 MAC is delivered; another unicast is still not-for-me', () => {
    const port = livePort(router, 'GigabitEthernet0/0');
    expect(arrive(port, ethFrame(VIRTUAL_MAC))).toEqual({ kind: 'drop', reason: 'not-for-me', detail: VIRTUAL_MAC, counters: ['inDrops'] });
    port.l3 = { virtual4: [{ address: '192.168.1.1', mac: VIRTUAL_MAC, owner: 'hsrp', local: true }] };
    expect(arrive(port, ethFrame(VIRTUAL_MAC))).toEqual({ kind: 'deliver', process: 'ipv4', layer: 'ethernet', key: ETHERTYPE_IPV4, counters: [] });
    expect(arrive(port, ethFrame(OTHER))).toEqual({ kind: 'drop', reason: 'not-for-me', detail: OTHER, counters: ['inDrops'] });
    expect(arrive(port, ethFrame(port.mac))).toMatchObject({ kind: 'deliver', process: 'ipv4' });
    // the same through the ingress action
    expect(ingressVerdict({ port, frame: ethFrame(VIRTUAL_MAC), index: BUILTIN, capabilities: router.capabilities })).toMatchObject({ kind: 'deliver', process: 'ipv4' });
  });
});
