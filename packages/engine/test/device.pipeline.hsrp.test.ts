/**
 * W1 device [SHOULD S2] (ARCHITECTURE-P2 §3.0 step 10b, §3.10, D15): the multicast-group rule of the pipeline's
 * link-layer filter — an IPv4 multicast frame of a group the port has not joined (`PortL3.groups4`, written by ipv4 on
 * `ipv4.group`) is dropped `not-for-me`, detail `multicast group not joined`, with no counter. The all-hosts group is
 * always joined (RFC 1112), and the rule runs only when the device runtime switches it on, so every P1 unit fixture
 * and every P1-profile trace keeps today's decisions.
 */
import { describe, expect, it } from 'vitest';
import { deviceMacBase } from '../src/contracts/addr.js';
import { BRIDGED_ROLES, L3_ROLES } from '../src/contracts/catalog.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { ProcessName } from '../src/contracts/ids.js';
import { ETHERTYPE_IPV4, HSRP_V1_GROUP, HSRP_V2_GROUP, IPPROTO_UDP, UDP_PORT_HSRP, type FieldValue } from '../src/contracts/pdu.js';
import { SPEED_1G, type PortSpec, type PortState } from '../src/contracts/port.js';
import type { DemuxSelector, Process, StateView, DebugEvent } from '../src/contracts/process.js';
import { defineModel, type ModelInput } from '../src/device/catalog/define.js';
import { NF_PC } from '../src/device/catalog.js';
import { createPortState } from '../src/device/ports.js';
import {
  IPV4_ALL_HOSTS_GROUP,
  PIPELINE_P2_DETAILS,
  buildDemuxIndex,
  frameArrivalVerdict,
  ingressVerdict,
  ipv4MulticastMacBits,
  multicastGroupFilter,
  type DemuxIndex,
  type FrameArrivalInput,
  type FrameLayerLike,
  type FrameLike,
} from '../src/device/pipeline.js';
import { NF_2911_INPUT, ethInput } from './device.catalog.p0-inputs.js';
import { p2Harness } from './device.p2.harness.js';

const BASE = deviceMacBase('d_0001');
const PEER = '02:00:00:00:00:99';
/** 224.0.0.102 (HSRP v2) and 224.0.0.2 (HSRP v1) as Ethernet groups. */
const HSRP_V2_MAC = '01:00:5e:00:00:66';
const HSRP_V1_MAC = '01:00:5e:00:00:02';
const ALL_HOSTS_MAC = '01:00:5e:00:00:01';

const router = defineModel(NF_2911_INPUT, 'P0.5');
const ML_INPUT: Omit<ModelInput, 'description'> = {
  type: 'mlswitch.nft3650',
  model: 'NF-T3650',
  category: 'multilayer-switches',
  icon: 'mlswitch',
  capabilities: ['layer3-switch'],
  ports: [ethInput('GigabitEthernet1/0/1', SPEED_1G, true)],
};
const ml = defineModel({ description: 'Multilayer switch of the HSRP pipeline tests', ...ML_INPUT }, 'P0.5');

function livePort(model: DeviceModel, name: string): PortState {
  const i = model.ports.findIndex((p) => p.name === name);
  const port = createPortState(model.ports[i] as PortSpec, i + 1, { macBase: BASE, capabilities: model.capabilities, portsDefaultUp: true });
  port.adminUp = true;
  port.operUp = true;
  return port;
}

/** An HSRP-hello-shaped frame (the codec itself is the pdu owner's W1 item). */
function hsrpFrame(dst: string, size = 64): FrameLike {
  const layers: FrameLayerLike[] = [
    { proto: 'ethernet', fields: { dst, src: PEER, type: ETHERTYPE_IPV4, fcsValid: true } as Record<string, FieldValue> },
    { proto: 'ipv4', fields: { src: '192.168.1.2', dst: dst === HSRP_V1_MAC ? HSRP_V1_GROUP : HSRP_V2_GROUP, protocol: IPPROTO_UDP, ttl: 1 } },
    { proto: 'udp', fields: { srcPort: UDP_PORT_HSRP, dstPort: UDP_PORT_HSRP } },
  ];
  return { layers, size, layer: (proto) => layers.find((l) => l.proto === proto) };
}

const proc = (handles: DemuxSelector[]): Pick<Process, 'handles'> => ({ handles });
const BUILTIN: DemuxIndex = buildDemuxIndex(['eth-switch', 'ipv4'], new Map<ProcessName, Pick<Process, 'handles'>>([
  ['eth-switch', proc([{ layer: 'ethernet', roles: BRIDGED_ROLES }])],
  ['ipv4', proc([{ layer: 'ethernet', ethertype: ETHERTYPE_IPV4, roles: L3_ROLES }])],
]));

function arrive(port: PortState, frame: FrameLike, over: Partial<FrameArrivalInput> = {}) {
  return frameArrivalVerdict({ port, frame, booted: true, index: BUILTIN, groupFilter: true, ...over });
}

describe('multicastGroupFilter (pure)', () => {
  it('maps the low 23 bits of an IPv4 multicast MAC and passes only joined groups', () => {
    expect(ipv4MulticastMacBits(HSRP_V2_MAC)).toBe(0x66);
    expect(ipv4MulticastMacBits('01:00:5e:7f:ff:fa')).toBe(0x7ffffa);
    expect(ipv4MulticastMacBits('01:00:5e:80:00:01')).toBeUndefined(); // outside the IPv4 multicast block
    expect(ipv4MulticastMacBits('ff:ff:ff:ff:ff:ff')).toBeUndefined();
    expect(ipv4MulticastMacBits('33:33:00:00:00:01')).toBeUndefined();

    expect(multicastGroupFilter(HSRP_V2_MAC, undefined)).toEqual({ kind: 'drop', reason: 'not-for-me', detail: PIPELINE_P2_DETAILS.groupNotJoined, counters: [] });
    expect(multicastGroupFilter(HSRP_V2_MAC, [])).toMatchObject({ reason: 'not-for-me' });
    expect(multicastGroupFilter(HSRP_V2_MAC, [HSRP_V2_GROUP])).toBeUndefined();
    expect(multicastGroupFilter(HSRP_V1_MAC, [HSRP_V2_GROUP])).toMatchObject({ reason: 'not-for-me' });
    expect(multicastGroupFilter(HSRP_V1_MAC, [HSRP_V1_GROUP, HSRP_V2_GROUP])).toBeUndefined();
    // the all-hosts group is a permanent member of every interface
    expect(multicastGroupFilter(ALL_HOSTS_MAC, undefined)).toBeUndefined();
    expect(IPV4_ALL_HOSTS_GROUP).toBe('224.0.0.1');
    // the MAC carries 23 bits, so a group that aliases onto the same MAC passes (as on real hardware)
    expect(multicastGroupFilter(HSRP_V2_MAC, ['225.128.0.102'])).toBeUndefined();
    // unicast and broadcast destinations are not this rule's business
    expect(multicastGroupFilter(PEER, undefined)).toBeUndefined();
    expect(multicastGroupFilter('ff:ff:ff:ff:ff:ff', undefined)).toBeUndefined();
  });
});

describe('step 10b: the multicast-group rule in the pipeline', () => {
  it('drops an unjoined group on an L3 port without counting, and delivers a joined one', () => {
    const port = livePort(router, 'GigabitEthernet0/0');
    expect(arrive(port, hsrpFrame(HSRP_V2_MAC))).toEqual({ kind: 'drop', reason: 'not-for-me', detail: 'multicast group not joined', counters: [] });
    port.l3 = { groups4: [HSRP_V2_GROUP] };
    expect(arrive(port, hsrpFrame(HSRP_V2_MAC))).toEqual({ kind: 'deliver', process: 'ipv4', layer: 'ethernet', key: ETHERTYPE_IPV4, counters: ['inBroadcasts'] });
    // a group joined on another port does not help this one
    expect(arrive(port, hsrpFrame(HSRP_V1_MAC))).toMatchObject({ reason: 'not-for-me', detail: 'multicast group not joined' });
  });

  it('is off unless the caller switches it on, so every P1 pipeline fixture keeps its decision', () => {
    const port = livePort(router, 'GigabitEthernet0/0');
    expect(frameArrivalVerdict({ port, frame: hsrpFrame(HSRP_V2_MAC), booted: true, index: BUILTIN })).toMatchObject({ kind: 'deliver', process: 'ipv4' });
    expect(ingressVerdict({ port, frame: hsrpFrame(HSRP_V2_MAC), index: BUILTIN, capabilities: router.capabilities })).toMatchObject({ kind: 'deliver', process: 'ipv4' });
    expect(ingressVerdict({ port, frame: hsrpFrame(HSRP_V2_MAC), index: BUILTIN, capabilities: router.capabilities, groupFilter: true })).toMatchObject({
      reason: 'not-for-me',
      detail: 'multicast group not joined',
    });
  });

  it('never filters a bridged port: the switch floods the hellos in their VLAN', () => {
    expect(arrive(livePort(ml, 'GigabitEthernet1/0/1'), hsrpFrame(HSRP_V2_MAC))).toMatchObject({ kind: 'deliver', process: 'eth-switch', counters: ['inBroadcasts'] });
  });
});

describe('the device runtime switches the rule on', () => {
  /** A PC whose only daemon is a recording fake ipv4. */
  function pc() {
    const seen: string[] = [];
    const ipv4: Process = {
      name: 'ipv4',
      handles: [{ layer: 'ethernet', ethertype: ETHERTYPE_IPV4, roles: L3_ROLES }],
      init: () => [],
      onPdu: (_ctx, pdu) => {
        seen.push(String(pdu.get('ipv4.dst')));
        return [];
      },
      onTimer: () => [],
      onConfig: () => [],
      stateSnapshot: (): StateView => ({ process: 'ipv4', state: {} }),
      debugEvents: (): readonly DebugEvent[] => [],
    };
    const h = p2Harness({ model: { ...NF_PC, processes: ['ipv4'] }, processes: { ipv4: () => ipv4 }, name: 'PC1' });
    h.run();
    const port = h.device.port('GigabitEthernet0') as PortState;
    port.operUp = true;
    h.events.length = 0;
    return { h, seen, port, at: (h.device.bootedAt as number) + 1 };
  }

  /** A real IPv4/UDP frame to `dst`. */
  function udpTo(h: ReturnType<typeof p2Harness>, mac: string, group: string) {
    return h.pdus.build(
      [
        { proto: 'ethernet', fields: { dst: mac, src: PEER, type: ETHERTYPE_IPV4 } },
        { proto: 'ipv4', fields: { src: '192.168.1.2', dst: group, protocol: IPPROTO_UDP, ttl: 1 } },
        { proto: 'udp', fields: { srcPort: UDP_PORT_HSRP, dstPort: UDP_PORT_HSRP } },
        { proto: 'payload', fields: { data: new Uint8Array(20).fill(3) } },
      ],
      { born: 0, origin: 'd_peer', tag: 'hsrp-hello' },
    );
  }

  it('a host drops a hello of a group it has not joined, and keeps taking the all-hosts group', () => {
    const { h, seen, port, at } = pc();
    h.device.onFrameArrival('GigabitEthernet0', udpTo(h, HSRP_V2_MAC, HSRP_V2_GROUP), false, at);
    expect(seen).toEqual([]);
    expect(h.kinds('drop')).toEqual([
      { t: at, kind: 'drop', pdu: expect.objectContaining({ tag: 'hsrp-hello' }), device: 'd_1', reason: 'not-for-me', port: 'GigabitEthernet0', detail: 'multicast group not joined' },
    ]);
    expect(port.counters.inDrops).toBe(0);
    expect(port.counters.inBroadcasts).toBe(0);

    h.device.onFrameArrival('GigabitEthernet0', udpTo(h, ALL_HOSTS_MAC, IPV4_ALL_HOSTS_GROUP), false, at + 1);
    expect(seen).toEqual([IPV4_ALL_HOSTS_GROUP]);

    // once ipv4 has joined the group on the port (the hsrp path), the hellos are delivered
    port.l3 = { groups4: [HSRP_V2_GROUP] };
    h.device.onFrameArrival('GigabitEthernet0', udpTo(h, HSRP_V2_MAC, HSRP_V2_GROUP), false, at + 2);
    expect(seen).toEqual([IPV4_ALL_HOSTS_GROUP, HSRP_V2_GROUP]);
  });
});
