import { describe, expect, it } from 'vitest';
import { deviceMacBase } from '../src/contracts/addr.js';
import { BRIDGED_ROLES, L3_ROLES, type PortRole } from '../src/contracts/catalog.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { ProcessName } from '../src/contracts/ids.js';
import { ETHERTYPE_ARP, ETHERTYPE_EAPOL, ETHERTYPE_IPV4, HDLC_PROTO_IPV4, HDLC_PROTO_IPV6, HDLC_PROTO_KEEPALIVE, type FieldValue, type Pdu } from '../src/contracts/pdu.js';
import { SPEED_1G, emptyCounters, type PortSpec, type PortState } from '../src/contracts/port.js';
import type { DemuxSelector, Process } from '../src/contracts/process.js';
import { defineModel, type ModelInput } from '../src/device/catalog/define.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { createPortState, createVirtualPortState } from '../src/device/ports.js';
import {
  ENCAP_ALLOWS,
  buildDemuxIndex,
  countIngress,
  demuxLookup,
  frameArrivalVerdict,
  ingressVerdict,
  loopIngressLayer,
  type DemuxIndex,
  type FrameArrivalInput,
  type FrameLayerLike,
  type FrameLike,
} from '../src/device/pipeline.js';
import { NF_2911_INPUT, ethInput } from './device.catalog.p0-inputs.js';
import { FRAME_ROLES } from '../src/contracts/catalog.js';

const BASE = deviceMacBase('d_0001');
const PEER = '02:00:00:00:00:99';
const OTHER = '02:00:00:00:00:77';
const BROADCAST = 'ff:ff:ff:ff:ff:ff';

const define = (input: Omit<ModelInput, 'description'>): DeviceModel => defineModel({ description: 'Model used by the pipeline role tests', ...input }, 'P0.5');
const ml = define({ type: 'mlswitch.nft3650', model: 'NF-T3650', category: 'multilayer-switches', icon: 'mlswitch', capabilities: ['layer3-switch'], ports: [ethInput('GigabitEthernet1/0/1', SPEED_1G, true)] });
const router = defineModel(NF_2911_INPUT, 'P0.5');
const hub = define({ type: 'hub.nft4', model: 'NF-T4', category: 'legacy', icon: 'hub', capabilities: ['repeater'], ports: [ethInput('Ethernet0', 10_000_000, false)] });
const ap = define({ type: 'ap.nftap', model: 'NF-TAP', category: 'wireless', icon: 'ap', capabilities: ['wifi-ap'], ports: [ethInput('GigabitEthernet0', SPEED_1G, true), { name: 'Wlan0', kind: 'wlan', speedBps: 600_000_000 }] });
const laptop = define({ type: 'laptop.nftl', model: 'NF-TL', category: 'computers', icon: 'laptop', capabilities: ['host', 'wifi-client'], ports: [ethInput('GigabitEthernet0', SPEED_1G, false), { name: 'Wlan0', kind: 'wlan', speedBps: 600_000_000 }] });

/** A live, oper-up port of `model` (optionally with spec overrides). */
function livePort(model: DeviceModel, name: string, over: Partial<PortSpec> = {}): PortState {
  const i = model.ports.findIndex((p) => p.name === name);
  const spec = { ...model.ports[i]!, ...over };
  const port = createPortState(spec, i + 1, { macBase: BASE, capabilities: model.capabilities, portsDefaultUp: true });
  port.adminUp = true;
  port.operUp = true;
  return port;
}

const pdus = createPduFactory();
function ethFrame(dst: string, type: number = ETHERTYPE_IPV4, payloadBytes = 46): Pdu {
  return pdus.build([
    { proto: 'ethernet', fields: { dst, src: PEER, type } },
    { proto: 'payload', fields: { data: new Uint8Array(payloadBytes).fill(7) } },
  ], { born: 0, origin: 'd_peer' });
}

function fakeFrame(layers: FrameLayerLike[], size: number): FrameLike {
  return { layers, size, layer: (proto) => layers.find((l) => l.proto === proto) };
}
const hdlcFrame = (protocol: number, size = 100, extra: Record<string, FieldValue> = {}): FrameLike =>
  fakeFrame([{ proto: 'hdlc', fields: { address: 0x0f, control: 0, protocol, fcsValid: true, ...extra } }, { proto: 'payload', fields: {} }], size);
const dot11Frame = (fields: Record<string, FieldValue>, llcType?: number, size = 120): FrameLike =>
  fakeFrame([
    { proto: 'dot11', fields: { fcsValid: true, addr2: PEER, addr3: PEER, ...fields } },
    ...(llcType === undefined ? [] : [{ proto: 'llc', fields: { type: llcType } }]),
  ], size);

const proc = (handles: DemuxSelector[]): Pick<Process, 'handles'> => ({ handles });
function indexOf(entries: [ProcessName, DemuxSelector[]][]): DemuxIndex {
  return buildDemuxIndex(entries.map((e) => e[0]), new Map(entries.map(([name, handles]) => [name, proc(handles)])));
}

/** The P0.5 built-in selector set (process.ts header). */
const BUILTIN = indexOf([
  ['wlan-ap', [{ layer: 'dot11', roles: ['wireless-bss'] }]],
  ['wlan-client', [{ layer: 'dot11', roles: ['wireless-client'] }]],
  ['hdlc', [{ layer: 'hdlc', ethertype: HDLC_PROTO_KEEPALIVE, roles: ['wan', 'access-line'] }]],
  ['eth-switch', [{ layer: 'ethernet', roles: BRIDGED_ROLES }]],
  ['arp', [{ layer: 'ethernet', ethertype: ETHERTYPE_ARP, roles: L3_ROLES }]],
  ['ipv4', [{ layer: 'ethernet', ethertype: ETHERTYPE_IPV4, roles: L3_ROLES }, { layer: 'hdlc', ethertype: HDLC_PROTO_IPV4, roles: ['wan'] }, { layer: 'ipv4', roles: ['virtual'] }]],
]);

function arrive(port: PortState, frame: FrameLike, over: Partial<FrameArrivalInput> = {}) {
  return frameArrivalVerdict({ port, frame, booted: true, index: BUILTIN, ...over });
}

describe('device/pipeline: MAC filter by role', () => {
  it('the same device filters on a routed port and bridges on a switched port', () => {
    const port = livePort(ml, 'GigabitEthernet1/0/1');
    const unicastOther = ethFrame(OTHER);
    expect(arrive(port, unicastOther)).toEqual({ kind: 'deliver', process: 'eth-switch', layer: 'ethernet', key: ETHERTYPE_IPV4, counters: [] });
    expect(arrive(port, ethFrame(BROADCAST, ETHERTYPE_ARP))).toMatchObject({ kind: 'deliver', process: 'eth-switch', counters: ['inBroadcasts'] });
    expect(arrive(port, ethFrame(port.mac, 0x88b5))).toMatchObject({ kind: 'deliver', process: 'eth-switch' });

    port.role = 'routed'; // `no switchport`: the index row of the new role applies, no rebuild needed
    expect(arrive(port, unicastOther)).toEqual({ kind: 'drop', reason: 'not-for-me', detail: OTHER, counters: ['inDrops'] });
    expect(arrive(port, ethFrame(port.mac))).toEqual({ kind: 'deliver', process: 'ipv4', layer: 'ethernet', key: ETHERTYPE_IPV4, counters: [] });
    expect(arrive(port, ethFrame(BROADCAST, ETHERTYPE_ARP))).toEqual({ kind: 'deliver', process: 'arp', layer: 'ethernet', key: ETHERTYPE_ARP, counters: ['inBroadcasts'] });
    expect(arrive(port, ethFrame('01:00:5e:00:00:05'))).toMatchObject({ kind: 'deliver', process: 'ipv4', counters: ['inBroadcasts'] });
    expect(arrive(port, ethFrame(port.mac, 0x88b5))).toEqual({ kind: 'drop', reason: 'unsupported-ethertype', detail: '0x88b5', counters: ['inDrops'] });
  });

  it('a promiscuous L3 port skips the MAC filter', () => {
    expect(arrive(livePort(router, 'GigabitEthernet0/0'), ethFrame(OTHER))).toMatchObject({ reason: 'not-for-me' });
    expect(arrive(livePort(router, 'GigabitEthernet0/0', { promiscuous: true }), ethFrame(OTHER))).toMatchObject({ kind: 'deliver', process: 'ipv4' });
  });

  it('repeater and console roles never enter the pipeline', () => {
    expect(arrive(livePort(hub, 'Ethernet0'), ethFrame(BROADCAST))).toEqual({ kind: 'drop', reason: 'other', detail: 'no-frames-on-repeater', counters: ['inDrops'] });
    expect(arrive(livePort(router, 'Console'), ethFrame(BROADCAST))).toEqual({ kind: 'drop', reason: 'other', detail: 'no-frames-on-console', counters: ['inDrops'] });
    // the role check precedes collision and fragment handling
    expect(arrive(livePort(hub, 'Ethernet0'), ethFrame(BROADCAST), { rx: { collided: true } })).toMatchObject({ detail: 'no-frames-on-repeater' });
  });
});

describe('device/pipeline: check order', () => {
  it('admin, receive gate, boot, err-disabled, collision, fragment', () => {
    const port = livePort(router, 'GigabitEthernet0/0');
    const f = ethFrame(port.mac);
    port.adminUp = false;
    expect(arrive(port, f)).toEqual({ kind: 'drop', reason: 'port-admin-down', counters: ['inDrops'] });
    port.adminUp = true;
    port.operUp = false;
    expect(arrive(port, f)).toEqual({ kind: 'drop', reason: 'link-down', counters: ['inDrops'] });
    port.operUp = true;
    expect(arrive(port, f, { booted: false })).toEqual({ kind: 'drop', reason: 'link-down', counters: ['inDrops'] });
    port.errDisabled = 'bpduguard';
    expect(arrive(port, f)).toEqual({ kind: 'drop', reason: 'port-err-disabled', detail: 'bpduguard', counters: ['inDrops'] });
    delete port.errDisabled;
    expect(arrive(port, f, { rx: { collided: true } })).toEqual({ kind: 'drop', reason: 'collision', counters: [] });
    expect(arrive(port, f, { rx: { fragmentBytes: 30 } })).toEqual({ kind: 'drop', reason: 'runt', detail: '30 bytes', counters: ['runts', 'inErrors'] });
    expect(arrive(port, f, { rx: { fragmentBytes: 500 } })).toEqual({ kind: 'drop', reason: 'fcs-error', counters: ['crcErrors', 'inErrors'] });
    expect(arrive(port, f)).toMatchObject({ kind: 'deliver', process: 'ipv4' });
  });

  it('wlan ports gate on carrier, not on operUp', () => {
    const wlan = livePort(laptop, 'Wlan0');
    wlan.operUp = false;
    const beacon = dot11Frame({ frameType: 'mgmt', subtype: 'beacon', addr1: BROADCAST });
    expect(arrive(wlan, beacon)).toEqual({ kind: 'drop', reason: 'link-down', counters: ['inDrops'] });
    wlan.phy = { carrier: true, lineProtocol: false, lineProtocolReason: 'not-associated' };
    expect(arrive(wlan, beacon)).toEqual({ kind: 'deliver', process: 'wlan-client', layer: 'dot11', counters: ['inBroadcasts'] });
  });

  it('a serial end down only by keepalive still receives keepalives, nothing else', () => {
    const se = livePort(router, 'Serial0/0/0');
    se.operUp = false;
    se.phy = { carrier: true, lineProtocol: false, lineProtocolReason: 'keepalive-missed' };
    expect(arrive(se, hdlcFrame(HDLC_PROTO_KEEPALIVE, 18, { address: 0x8f }))).toEqual({ kind: 'deliver', process: 'hdlc', layer: 'hdlc', key: HDLC_PROTO_KEEPALIVE, counters: [] });
    expect(arrive(se, hdlcFrame(HDLC_PROTO_IPV4))).toEqual({ kind: 'drop', reason: 'link-down', counters: ['inDrops'] });
    se.phy = { carrier: true, lineProtocol: false, lineProtocolReason: 'no-clock' };
    expect(arrive(se, hdlcFrame(HDLC_PROTO_KEEPALIVE, 18))).toMatchObject({ reason: 'link-down' });
    se.phy = { carrier: false, lineProtocol: false, lineProtocolReason: 'keepalive-missed' };
    expect(arrive(se, hdlcFrame(HDLC_PROTO_KEEPALIVE, 18))).toMatchObject({ reason: 'link-down' });
  });
});

describe('device/pipeline: encapsulation validators', () => {
  it('pins the allowed outer framings per encapsulation', () => {
    expect(ENCAP_ALLOWS).toEqual({ ethernet: ['ethernet'], hdlc: ['hdlc'], dot11: ['dot11', 'ethernet'], ppp: [], none: [] });
  });

  it('refuses a framing the port encapsulation does not carry', () => {
    expect(arrive(livePort(router, 'Serial0/0/0'), ethFrame(BROADCAST))).toEqual({ kind: 'drop', reason: 'other', detail: 'no-hdlc-layer', counters: ['inDrops'] });
    expect(arrive(livePort(router, 'GigabitEthernet0/0'), hdlcFrame(HDLC_PROTO_IPV4))).toEqual({ kind: 'drop', reason: 'other', detail: 'no-ethernet-layer', counters: ['inDrops'] });
    const wlan = livePort(laptop, 'Wlan0');
    wlan.phy = { carrier: true, lineProtocol: true };
    // air data after the admit rewrap arrives as Ethernet on a dot11 port
    expect(arrive(wlan, ethFrame(wlan.mac))).toMatchObject({ kind: 'deliver', process: 'ipv4', layer: 'ethernet' });
  });

  it('ethernet: FCS, runt at 64 B and giant above mtu+18', () => {
    const gi = livePort(router, 'GigabitEthernet0/0');
    expect(arrive(gi, ethFrame(gi.mac), { corrupted: true })).toEqual({ kind: 'drop', reason: 'fcs-error', counters: ['crcErrors', 'inErrors'] });
    expect(arrive(gi, fakeFrame([{ proto: 'ethernet', fields: { dst: gi.mac, type: ETHERTYPE_IPV4, fcsValid: false } }], 80))).toMatchObject({ reason: 'fcs-error' });
    expect(arrive(gi, fakeFrame([{ proto: 'ethernet', fields: { dst: gi.mac, type: ETHERTYPE_IPV4, fcsValid: true } }], 40))).toEqual({ kind: 'drop', reason: 'runt', detail: '40 bytes', counters: ['runts', 'inErrors'] });
    const big = ethFrame(gi.mac, ETHERTYPE_IPV4, 1600);
    expect(arrive(gi, big)).toEqual({ kind: 'drop', reason: 'giant', detail: `${big.size} bytes`, counters: ['giants', 'inErrors'] });
    expect(arrive(gi, ethFrame(gi.mac, ETHERTYPE_IPV4, 1500))).toMatchObject({ kind: 'deliver' }); // exactly 1518 B
    expect(arrive(livePort(router, 'GigabitEthernet0/0', { mtu: 9216 }), big)).toMatchObject({ kind: 'deliver', process: 'ipv4' });
  });

  it('hdlc: no runts, giant above mtu+6, never MAC-filtered, demux on protocol', () => {
    const se = livePort(router, 'Serial0/0/0');
    expect(arrive(se, hdlcFrame(HDLC_PROTO_IPV4, 10))).toEqual({ kind: 'deliver', process: 'ipv4', layer: 'hdlc', key: HDLC_PROTO_IPV4, counters: [] });
    expect(arrive(se, hdlcFrame(HDLC_PROTO_IPV4, 1506))).toMatchObject({ kind: 'deliver' });
    expect(arrive(se, hdlcFrame(HDLC_PROTO_IPV4, 1507))).toEqual({ kind: 'drop', reason: 'giant', detail: '1507 bytes', counters: ['giants', 'inErrors'] });
    expect(arrive(se, hdlcFrame(HDLC_PROTO_IPV4, 100, { fcsValid: false }))).toEqual({ kind: 'drop', reason: 'fcs-error', counters: ['crcErrors', 'inErrors'] });
    expect(arrive(se, hdlcFrame(HDLC_PROTO_IPV6))).toEqual({ kind: 'drop', reason: 'unsupported-ethertype', detail: '0x86dd', counters: ['inDrops'] });
  });

  it('dot11: giant above DOT11_MAX_FRAME, no runts', () => {
    const wlan = livePort(ap, 'Wlan0');
    wlan.phy = { carrier: true, lineProtocol: true };
    const beacon = (size: number) => dot11Frame({ frameType: 'mgmt', subtype: 'beacon', addr1: BROADCAST }, undefined, size);
    expect(arrive(wlan, beacon(30))).toMatchObject({ kind: 'deliver', process: 'wlan-ap' });
    expect(arrive(wlan, beacon(2346))).toMatchObject({ kind: 'deliver' });
    expect(arrive(wlan, beacon(2347))).toEqual({ kind: 'drop', reason: 'giant', detail: '2347 bytes', counters: ['giants', 'inErrors'] });
  });
});

describe('device/pipeline: demux index', () => {
  it('dot11 management matches key-less selectors only; EAPOL data demuxes on llc.type', () => {
    const index = indexOf([
      ['wlan-client', [{ layer: 'dot11', ethertype: ETHERTYPE_EAPOL, roles: ['wireless-client'] }]],
      ['host', [{ layer: 'dot11', roles: ['wireless-client'] }]],
    ]);
    const wlan = livePort(laptop, 'Wlan0');
    wlan.phy = { carrier: true, lineProtocol: false };
    const mgmt = dot11Frame({ frameType: 'mgmt', subtype: 'assoc-resp', addr1: wlan.mac });
    expect(arrive(wlan, mgmt, { index })).toEqual({ kind: 'deliver', process: 'host', layer: 'dot11', counters: [] });
    const eapol = dot11Frame({ frameType: 'data', subtype: 'data', addr1: wlan.mac }, ETHERTYPE_EAPOL);
    expect(arrive(wlan, eapol, { index })).toEqual({ kind: 'deliver', process: 'wlan-client', layer: 'dot11', key: ETHERTYPE_EAPOL, counters: [] });
    expect(arrive(wlan, dot11Frame({ frameType: 'data', subtype: 'data', addr1: wlan.mac }, ETHERTYPE_IPV4), { index })).toMatchObject({ process: 'host', key: ETHERTYPE_IPV4 });
    // wireless-client is an L3 role: unicast for another station is filtered on addr1
    expect(arrive(wlan, dot11Frame({ frameType: 'mgmt', subtype: 'probe-resp', addr1: OTHER }), { index })).toEqual({ kind: 'drop', reason: 'not-for-me', detail: OTHER, counters: ['inDrops'] });
  });

  it('dot11 management without a handler drops with the subtype; wireless-bss is not filtered', () => {
    const wlan = livePort(ap, 'Wlan0');
    wlan.phy = { carrier: true, lineProtocol: true };
    const index = indexOf([['eth-switch', [{ layer: 'ethernet', roles: BRIDGED_ROLES }]]]);
    expect(arrive(wlan, dot11Frame({ frameType: 'mgmt', subtype: 'probe-req', addr1: OTHER }), { index })).toEqual({ kind: 'drop', reason: 'other', detail: 'no-handler-dot11-probe-req', counters: ['inDrops'] });
    expect(arrive(wlan, dot11Frame({ frameType: 'data', subtype: 'data', addr1: OTHER }), { index })).toEqual({ kind: 'drop', reason: 'unsupported-ethertype', detail: 'no-ethertype', counters: ['inDrops'] });
  });

  it('selectors listing FRAME_ROLES cover every frame role; specificity beats order; ties follow model order', () => {
    const index = indexOf([
      ['icmpv4', [{ layer: 'ethernet', roles: FRAME_ROLES }]],
      ['arp', [{ layer: 'ethernet', roles: FRAME_ROLES }]],
      ['ipv4', [{ layer: 'ethernet', ethertype: ETHERTYPE_IPV4, roles: FRAME_ROLES }]],
    ]);
    const roles: PortRole[] = ['switched', 'routed', 'wireless-bss', 'svi', 'virtual'];
    for (const role of roles) {
      expect(demuxLookup(index, role, 'ethernet', ETHERTYPE_ARP)?.process).toBe('icmpv4');
      expect(demuxLookup(index, role, 'ethernet', ETHERTYPE_IPV4)?.process).toBe('ipv4');
    }
    expect(index.repeater.ethernet).toBeUndefined();
    expect(index.console.ethernet).toBeUndefined();
    expect(index.routed.ethernet?.map((e) => [e.process, e.score, e.order])).toEqual([['ipv4', 2, 2], ['icmpv4', 1, 0], ['arp', 1, 1]]);
    expect(demuxLookup(index, 'routed', 'hdlc', HDLC_PROTO_IPV4)).toBeUndefined();
    // role-scoped selectors stay in their rows
    expect(BUILTIN.switched.ethernet?.map((e) => e.process)).toEqual(['eth-switch']);
    expect(BUILTIN.wan.hdlc?.map((e) => e.process)).toEqual(['hdlc', 'ipv4']);
    expect(BUILTIN['access-line'].hdlc?.map((e) => e.process)).toEqual(['hdlc']);
    expect(Object.isFrozen(BUILTIN.routed)).toBe(true);
  });

  it('processes that are missing or have no handles contribute nothing', () => {
    const index = buildDemuxIndex(['eth-switch', 'arp', 'ipv4'], new Map<ProcessName, Pick<Process, 'handles'>>([['arp', {}]]));
    expect(index.routed.ethernet).toBeUndefined();
    expect(index.switched.ethernet).toBeUndefined();
  });
});

describe('device/pipeline: ingress action and loop egress', () => {
  it('SVI ingress runs group counting, the MAC filter and demux on the svi row', () => {
    const vlan1 = createVirtualPortState(ml.virtualFamilies!.find((f) => f.family === 'Vlan')!, 1, BASE);
    expect(ingressVerdict({ port: vlan1, frame: ethFrame(vlan1.mac), index: BUILTIN })).toEqual({ kind: 'deliver', process: 'ipv4', layer: 'ethernet', key: ETHERTYPE_IPV4, counters: [] });
    expect(ingressVerdict({ port: vlan1, frame: ethFrame(BROADCAST, ETHERTYPE_ARP), index: BUILTIN })).toEqual({ kind: 'deliver', process: 'arp', layer: 'ethernet', key: ETHERTYPE_ARP, counters: ['inBroadcasts'] });
    expect(ingressVerdict({ port: vlan1, frame: ethFrame(OTHER), index: BUILTIN })).toEqual({ kind: 'drop', reason: 'not-for-me', detail: OTHER, counters: ['inDrops'] });
    expect(ingressVerdict({ port: vlan1, frame: ethFrame(vlan1.mac), layer: 'hdlc', index: BUILTIN })).toEqual({ kind: 'drop', reason: 'other', detail: 'no-hdlc-layer', counters: ['inDrops'] });
  });

  it('loopback ingress at the IP layer matches key-less ipv4 selectors', () => {
    const lo = createVirtualPortState(router.virtualFamilies!.find((f) => f.family === 'Loopback')!, 0, BASE);
    const packet = fakeFrame([{ proto: 'ipv4', fields: { src: '10.9.9.9', dst: '10.9.9.9', protocol: 1 } }], 84);
    expect(loopIngressLayer(packet)).toBe('ipv4');
    expect(ingressVerdict({ port: lo, frame: packet, layer: loopIngressLayer(packet), index: BUILTIN })).toEqual({ kind: 'deliver', process: 'ipv4', layer: 'ipv4', counters: [] });
    expect(ingressVerdict({ port: lo, frame: packet, index: indexOf([]) })).toEqual({ kind: 'drop', reason: 'unsupported-protocol', detail: 'no-handler-ipv4', counters: ['inDrops'] });
    expect(loopIngressLayer(ethFrame(BROADCAST))).toBe('ethernet');
    expect(loopIngressLayer(fakeFrame([{ proto: 'payload', fields: {} }], 10))).toBe('ipv4');
    expect(ingressVerdict({ port: lo, frame: fakeFrame([{ proto: 'payload', fields: {} }], 10), index: BUILTIN })).toEqual({ kind: 'drop', reason: 'other', detail: 'no-demux-layer', counters: ['inDrops'] });
  });

  it('countIngress applies a verdict counter list', () => {
    const c = emptyCounters();
    countIngress(c, ['inBroadcasts', 'inDrops']);
    countIngress(c, ['crcErrors', 'inErrors']);
    expect(c).toMatchObject({ inBroadcasts: 1, inDrops: 1, crcErrors: 1, inErrors: 1, runts: 0, giants: 0 });
  });
});
