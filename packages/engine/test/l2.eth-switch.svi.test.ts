/**
 * P0.5 W3 l2l3: role-driven bridging (ARCHITECTURE-P1 D3, §3.1 step 13, §3.10).
 *  - demux rows per role: bridged ports go to eth-switch, L3 ports to arp/ipv4, serial WAN to ipv4/hdlc;
 *  - SVI data path: frames for the SVI MAC become `ingress` actions, group frames add an ingress clone,
 *    sends on the SVI come back through `eth-switch.onEgress`;
 *  - hairpin on access radios, HDLC relay on serial access lines, no flooding onto routed ports;
 *  - ipv4 applies an address only while the port routes (`switchport` / `no switchport`).
 */
import { describe, expect, it } from 'vitest';
import { defineModel } from '../src/device/catalog/define.js';
import type { ModelInput } from '../src/device/catalog/define.js';
import { buildDemuxIndex, demuxLookup } from '../src/device/pipeline.js';
import { createArp } from '../src/protocols/arp.js';
import {
  CAM_SWEEP_TIMER,
  DETAIL_FILTERED,
  DETAIL_NO_EGRESS,
  DETAIL_NO_ETHERNET,
  DETAIL_NOT_BRIDGED,
  createEthSwitch,
} from '../src/protocols/eth-switch.js';
import { createHdlc } from '../src/protocols/hdlc.js';
import { createIcmpv4 } from '../src/protocols/icmpv4.js';
import { createIpv4 } from '../src/protocols/ipv4.js';
import { MAC_BROADCAST } from '../src/contracts/addr.js';
import type { ProcessName } from '../src/contracts/ids.js';
import {
  ARP_OP_REPLY,
  ARP_OP_REQUEST,
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  HDLC_ADDRESS_BROADCAST,
  HDLC_PROTO_IPV4,
  HDLC_PROTO_KEEPALIVE,
  IPPROTO_ICMP,
} from '../src/contracts/pdu.js';
import { SPEED_1G } from '../src/contracts/port.js';
import type { Action, Process } from '../src/contracts/process.js';
import { camKey } from '../src/contracts/tables.js';
import { makeHarness } from './arp.harness.js';
import type { FakePortSpec, Harness } from './arp.harness.js';
import { ethInput } from './device.catalog.p0-inputs.js';
import { makeFake, makeSink } from './ip.fake-ctx.js';

const MLS_INPUT: ModelInput = {
  type: 'mlswitch.nfsvitest',
  model: 'NF-SVI-TEST',
  description: 'Multilayer switch fixture with three front ports',
  category: 'multilayer-switches',
  icon: 'mlswitch',
  capabilities: ['layer3-switch'],
  ports: [
    ethInput('GigabitEthernet1/0/1', SPEED_1G, true),
    ethInput('GigabitEthernet1/0/2', SPEED_1G, true),
    ethInput('GigabitEthernet1/0/3', SPEED_1G, true),
  ],
};

const AP_INPUT: ModelInput = {
  type: 'ap.nfhairpintest',
  model: 'NF-HAIRPIN-TEST',
  description: 'Access point fixture with one uplink and one access radio',
  category: 'wireless',
  icon: 'ap',
  capabilities: ['wifi-ap'],
  ports: [
    ethInput('GigabitEthernet0', SPEED_1G, true),
    { name: 'Wlan0', kind: 'wlan', speedBps: 600_000_000 },
  ],
};

const CSU_INPUT: ModelInput = {
  type: 'csu.nfrelaytest',
  model: 'NF-RELAY-TEST',
  description: 'Line bridge fixture with two serial access lines and two ethernet ports',
  category: 'wan-isp',
  icon: 'csu',
  capabilities: ['modem'],
  ports: [
    { name: 'Serial0', kind: 'serial', speedBps: 1_544_000 },
    { name: 'Serial1', kind: 'serial', speedBps: 1_544_000 },
    ethInput('GigabitEthernet0', SPEED_1G, true),
    ethInput('GigabitEthernet1', SPEED_1G, true),
  ],
};

const MLS = defineModel(MLS_INPUT, 'P0.5');
const AP = defineModel(AP_INPUT, 'P0.5');
const CSU = defineModel(CSU_INPUT, 'P0.5');

const G1 = 'GigabitEthernet1/0/1';
const G2 = 'GigabitEthernet1/0/2';
const G3 = 'GigabitEthernet1/0/3';
const VLAN1 = 'Vlan1';
const SVI_MAC = '02:4e:00:10:00:00';
const HOST_A = '00:1f:00:00:00:0a';
const HOST_B = '00:1f:00:00:00:0b';

const sendsOf = (actions: Action[]) => actions.filter((a): a is Extract<Action, { type: 'send' }> => a.type === 'send');
const ingressOf = (actions: Action[]) => actions.filter((a): a is Extract<Action, { type: 'ingress' }> => a.type === 'ingress');

/** A multilayer switch: G1/G2 switched, G3 routed (after `no switchport`), Vlan1 up with 10.1.1.1/24. */
function mls(overrides: { sviUp?: boolean; g3Role?: 'switched' | 'routed' } = {}): Harness {
  const ports: FakePortSpec[] = [
    { id: G1, mac: '02:4e:00:10:00:01' },
    { id: G2, mac: '02:4e:00:10:00:02' },
    { id: G3, mac: '02:4e:00:10:00:03', role: overrides.g3Role ?? 'routed' },
    { id: VLAN1, mac: SVI_MAC, kind: 'virtual', address: '10.1.1.1', prefixLen: 24, operUp: overrides.sviUp ?? true },
  ];
  return makeHarness({ deviceId: 'd_mls', model: MLS, ports });
}

function ethFrame(h: Harness, src: string, dst: string, type = ETHERTYPE_ARP) {
  if (type === ETHERTYPE_ARP) {
    return h.build([
      { proto: 'ethernet', fields: { dst, src, type: ETHERTYPE_ARP } },
      { proto: 'arp', fields: { op: ARP_OP_REQUEST, sha: src, spa: '10.1.1.10', tha: '00:00:00:00:00:00', tpa: '10.1.1.1' } },
    ]);
  }
  return h.build([
    { proto: 'ethernet', fields: { dst, src, type: ETHERTYPE_IPV4 } },
    { proto: 'ipv4', fields: { src: '10.1.1.10', dst: '10.1.1.1', protocol: IPPROTO_ICMP, ttl: 64 } },
    { proto: 'icmpv4', fields: { type: 8, code: 0, id: 1, seq: 1 } },
    { proto: 'payload', fields: { data: new Uint8Array(16) } },
  ]);
}

describe('demux rows follow port roles', () => {
  const processes = new Map<ProcessName, Process>([
    ['hdlc', createHdlc()],
    ['eth-switch', createEthSwitch()],
    ['arp', createArp()],
    ['ipv4', createIpv4()],
    ['icmpv4', createIcmpv4()],
  ]);

  it('a multilayer switch sends bridged-port frames to eth-switch and L3-port frames to arp/ipv4', () => {
    expect(MLS.processes).toEqual(['hdlc', 'eth-switch', 'arp', 'ipv4', 'icmpv4']);
    const index = buildDemuxIndex(MLS.processes, processes);
    expect(demuxLookup(index, 'switched', 'ethernet', ETHERTYPE_ARP)?.process).toBe('eth-switch');
    expect(demuxLookup(index, 'switched', 'ethernet', ETHERTYPE_IPV4)?.process).toBe('eth-switch');
    expect(demuxLookup(index, 'routed', 'ethernet', ETHERTYPE_ARP)?.process).toBe('arp');
    expect(demuxLookup(index, 'routed', 'ethernet', ETHERTYPE_IPV4)?.process).toBe('ipv4');
    expect(demuxLookup(index, 'routed', 'ethernet', 0x88b5)).toBeUndefined();
    expect(demuxLookup(index, 'svi', 'ethernet', ETHERTYPE_ARP)?.process).toBe('arp');
    expect(demuxLookup(index, 'svi', 'ethernet', ETHERTYPE_IPV4)?.process).toBe('ipv4');
    expect(demuxLookup(index, 'wireless-bss', 'ethernet', ETHERTYPE_IPV4)?.process).toBe('eth-switch');
    expect(demuxLookup(index, 'wan', 'hdlc', HDLC_PROTO_IPV4)?.process).toBe('ipv4');
    expect(demuxLookup(index, 'wan', 'hdlc', HDLC_PROTO_KEEPALIVE)?.process).toBe('hdlc');
    expect(demuxLookup(index, 'console', 'ethernet', ETHERTYPE_IPV4)).toBeUndefined();
  });

  it('a line bridge relays every HDLC frame of its serial access lines through eth-switch', () => {
    expect(CSU.processes).toEqual(['eth-switch']);
    const index = buildDemuxIndex(CSU.processes, processes);
    expect(demuxLookup(index, 'access-line', 'hdlc', HDLC_PROTO_KEEPALIVE)?.process).toBe('eth-switch');
    expect(demuxLookup(index, 'access-line', 'hdlc', HDLC_PROTO_IPV4)?.process).toBe('eth-switch');
  });
});

describe('eth-switch SVI ingress', () => {
  it('hands a unicast frame for the SVI MAC to the SVI (original pdu) after learning the source', () => {
    const h = mls();
    const sw = createEthSwitch();
    sw.init!(h.ctx);
    h.setNow(1000);
    const pdu = ethFrame(h, HOST_A, SVI_MAC, ETHERTYPE_IPV4);
    const actions = sw.onPdu(h.ctx, pdu, G1);
    expect(actions).toEqual([{ type: 'ingress', port: VLAN1, pdu }]);
    expect(h.tables.cam.get(camKey(1, HOST_A))).toMatchObject({ port: G1, expiresAt: 1000 + MLS.ipDefaults!.camAgeingNs });
    expect(h.debug.at(-1)!.message).toBe(`delivering frame for ${SVI_MAC} from ${G1} to ${VLAN1} (vlan 1)`);
    expect(sw.stateSnapshot().state).toMatchObject({ forwards: 1, floods: 0 });
  });

  it('drops a frame addressed to an SVI that is down instead of flooding it', () => {
    const h = mls({ sviUp: false });
    const sw = createEthSwitch();
    const pdu = ethFrame(h, HOST_A, SVI_MAC, ETHERTYPE_IPV4);
    expect(sw.onPdu(h.ctx, pdu, G1)).toEqual([{ type: 'drop', pdu, reason: 'other', detail: `${VLAN1} is down`, port: G1 }]);
  });

  it('floods a broadcast to the other bridged ports only and adds an ingress clone for the SVI', () => {
    const h = mls();
    const sw = createEthSwitch();
    const pdu = ethFrame(h, HOST_A, MAC_BROADCAST);
    const actions = sw.onPdu(h.ctx, pdu, G1);
    expect(actions.map((a) => [a.type, 'port' in a ? a.port : null])).toEqual([['send', G2], ['ingress', VLAN1]]);
    expect(sendsOf(actions)[0]!.pdu).toBe(pdu);
    const clone = ingressOf(actions)[0]!.pdu;
    expect(clone).not.toBe(pdu);
    expect(clone.meta.parent).toBe(pdu.id);
    expect(clone.bytes).toEqual(pdu.bytes);
    expect(h.debug.at(-1)!.message).toBe(`flooding broadcast frame for ${MAC_BROADCAST} from ${G1} to 2 port(s): ${G2}, ${VLAN1}`);
  });

  it('never floods onto a routed port, and makes no SVI clone while the SVI is down', () => {
    const h = mls({ sviUp: false });
    const sw = createEthSwitch();
    const actions = sw.onPdu(h.ctx, ethFrame(h, HOST_A, MAC_BROADCAST), G1);
    expect(actions.map((a) => [a.type, 'port' in a ? a.port : null])).toEqual([['send', G2]]);
    // an unknown unicast behaves the same way
    const unknown = sw.onPdu(h.ctx, ethFrame(h, HOST_A, HOST_B, ETHERTYPE_IPV4), G1);
    expect(unknown.map((a) => [a.type, 'port' in a ? a.port : null])).toEqual([['send', G2]]);
  });

  it('refuses frames handed to it for a port that is not a bridge member', () => {
    const h = mls();
    const sw = createEthSwitch();
    const pdu = ethFrame(h, HOST_A, MAC_BROADCAST);
    expect(sw.onPdu(h.ctx, pdu, G3)).toEqual([{ type: 'drop', pdu, reason: 'other', detail: DETAIL_NOT_BRIDGED, port: G3 }]);
    expect(h.tables.cam.size).toBe(0);
  });

  it('forwards a known unicast between switched ports but not to the routed port', () => {
    const h = mls({ g3Role: 'switched' });
    const sw = createEthSwitch();
    sw.onPdu(h.ctx, ethFrame(h, HOST_B, MAC_BROADCAST), G3);
    const pdu = ethFrame(h, HOST_A, HOST_B, ETHERTYPE_IPV4);
    expect(sw.onPdu(h.ctx, pdu, G1)).toEqual([{ type: 'send', port: G3, pdu }]);
    // flip G3 to routed: the learned row now points at a port that no longer bridges
    h.ports.get(G3)!.role = 'routed';
    const again = ethFrame(h, HOST_A, HOST_B, ETHERTYPE_IPV4);
    expect(sw.onPdu(h.ctx, again, G1)).toEqual([{ type: 'drop', pdu: again, reason: 'other', detail: DETAIL_NO_EGRESS, port: G1 }]);
  });

  it('ages CAM rows with the model ipDefaults and still arms the 15 s sweep', () => {
    const h = mls();
    const sw = createEthSwitch();
    expect(sw.init!(h.ctx)).toEqual([{ type: 'timer', key: CAM_SWEEP_TIMER, delay: 15_000_000_000, periodic: true }]);
    expect(sw.stateSnapshot().state).toMatchObject({ ageingNs: MLS.ipDefaults!.camAgeingNs });
  });
});

describe('eth-switch SVI egress (onEgress)', () => {
  it('sends a frame from the SVI out the learned member port', () => {
    const h = mls();
    const sw = createEthSwitch();
    sw.onPdu(h.ctx, ethFrame(h, HOST_A, MAC_BROADCAST), G2);
    const reply = h.ctx.newPdu([
      { proto: 'ethernet', fields: { dst: HOST_A, src: SVI_MAC, type: ETHERTYPE_ARP } },
      { proto: 'arp', fields: { op: ARP_OP_REPLY, sha: SVI_MAC, spa: '10.1.1.1', tha: HOST_A, tpa: '10.1.1.10' } },
    ]);
    expect(sw.onEgress!(h.ctx, reply, VLAN1)).toEqual([{ type: 'send', port: G2, pdu: reply }]);
    expect(h.debug.at(-1)!.message).toBe(`bridging frame for ${HOST_A} from ${VLAN1} out ${G2} (vlan 1)`);
  });

  it('floods a broadcast or unknown destination from the SVI to every forwarding bridged port', () => {
    const h = mls();
    const sw = createEthSwitch();
    const request = h.ctx.newPdu([
      { proto: 'ethernet', fields: { dst: MAC_BROADCAST, src: SVI_MAC, type: ETHERTYPE_ARP } },
      { proto: 'arp', fields: { op: ARP_OP_REQUEST, sha: SVI_MAC, spa: '10.1.1.1', tha: '00:00:00:00:00:00', tpa: '10.1.1.10' } },
    ]);
    const actions = sw.onEgress!(h.ctx, request, VLAN1);
    expect(actions.map((a) => [a.type, 'port' in a ? a.port : null])).toEqual([['send', G1], ['send', G2]]);
    expect(sendsOf(actions)[0]!.pdu).toBe(request);
    expect(sendsOf(actions)[1]!.pdu.meta.parent).toBe(request.id);
    expect(h.tables.cam.size).toBe(0);
  });

  it('drops when no bridged port forwards, when the member port is down, and when there is no ethernet header', () => {
    const h = mls();
    const sw = createEthSwitch();
    sw.onPdu(h.ctx, ethFrame(h, HOST_A, MAC_BROADCAST), G1);
    h.ports.get(G1)!.operUp = false;
    h.ports.get(G2)!.operUp = false;
    const toA = h.ctx.newPdu([{ proto: 'ethernet', fields: { dst: HOST_A, src: SVI_MAC, type: ETHERTYPE_ARP } }, { proto: 'payload', fields: { data: new Uint8Array(28) } }]);
    expect(sw.onEgress!(h.ctx, toA, VLAN1)).toEqual([{ type: 'drop', pdu: toA, reason: 'other', detail: DETAIL_NO_EGRESS, port: VLAN1 }]);
    const flood = h.ctx.newPdu([{ proto: 'ethernet', fields: { dst: MAC_BROADCAST, src: SVI_MAC, type: ETHERTYPE_ARP } }, { proto: 'payload', fields: { data: new Uint8Array(28) } }]);
    expect(sw.onEgress!(h.ctx, flood, VLAN1)).toEqual([{ type: 'drop', pdu: flood, reason: 'other', detail: DETAIL_NO_EGRESS, port: VLAN1 }]);
    const bare = h.ctx.newPdu([{ proto: 'payload', fields: { data: new Uint8Array(4) } }]);
    expect(sw.onEgress!(h.ctx, bare, VLAN1)).toEqual([{ type: 'drop', pdu: bare, reason: 'other', detail: DETAIL_NO_ETHERNET, port: VLAN1 }]);
  });

  it('carries an ARP exchange with the SVI end to end: flood + ingress clone, arp reply on Vlan1, egress to the member port', () => {
    const h = mls();
    const sw = createEthSwitch();
    const arp = createArp();
    const request = ethFrame(h, HOST_A, MAC_BROADCAST);
    const bridged = sw.onPdu(h.ctx, request, G1);
    const toSvi = ingressOf(bridged)[0]!;
    const answered = arp.onPdu(h.ctx, toSvi.pdu, toSvi.port);
    const reply = sendsOf(answered)[0]!;
    expect(reply.port).toBe(VLAN1);
    expect(reply.pdu.get('ethernet.src')).toBe(SVI_MAC);
    expect(reply.pdu.get('arp.spa')).toBe('10.1.1.1');
    expect(h.tables.arp.get('10.1.1.10')).toMatchObject({ mac: HOST_A, iface: VLAN1 });
    expect(sw.onEgress!(h.ctx, reply.pdu, VLAN1)).toEqual([{ type: 'send', port: G1, pdu: reply.pdu }]);
  });
});

describe('eth-switch hairpin and relay', () => {
  function ap(): Harness {
    return makeHarness({
      deviceId: 'd_ap',
      model: AP,
      ports: [
        { id: 'GigabitEthernet0', mac: '02:4e:00:20:00:01' },
        { id: 'Wlan0', mac: '02:4e:00:20:00:02', kind: 'wlan' },
      ],
    });
  }

  it('sends a frame between two stations of the same radio back out that radio', () => {
    const h = ap();
    expect(h.ports.get('Wlan0')!.role).toBe('wireless-bss');
    const sw = createEthSwitch();
    sw.onPdu(h.ctx, ethFrame(h, HOST_B, MAC_BROADCAST), 'Wlan0');
    const pdu = ethFrame(h, HOST_A, HOST_B, ETHERTYPE_IPV4);
    expect(sw.onPdu(h.ctx, pdu, 'Wlan0')).toEqual([{ type: 'send', port: 'Wlan0', pdu }]);
    expect(h.debug.at(-1)!.message).toBe(`forwarding frame for ${HOST_B} back out Wlan0 (same radio, vlan 1)`);
    expect(sw.stateSnapshot().state).toMatchObject({ filtered: 0, forwards: 1 });
  });

  it('floods a broadcast from a station to the uplink and back onto the radio', () => {
    const h = ap();
    const sw = createEthSwitch();
    const actions = sw.onPdu(h.ctx, ethFrame(h, HOST_A, MAC_BROADCAST), 'Wlan0');
    expect(actions.map((a) => [a.type, 'port' in a ? a.port : null])).toEqual([['send', 'GigabitEthernet0'], ['send', 'Wlan0']]);
  });

  it('still filters on a non-hairpin port', () => {
    const h = ap();
    const sw = createEthSwitch();
    sw.onPdu(h.ctx, ethFrame(h, HOST_B, MAC_BROADCAST), 'GigabitEthernet0');
    const pdu = ethFrame(h, HOST_A, HOST_B, ETHERTYPE_IPV4);
    expect(sw.onPdu(h.ctx, pdu, 'GigabitEthernet0')).toEqual([{ type: 'drop', pdu, reason: 'other', detail: DETAIL_FILTERED, port: 'GigabitEthernet0' }]);
  });

  function csu(): Harness {
    return makeHarness({
      deviceId: 'd_csu',
      model: CSU,
      ports: [
        { id: 'Serial0', mac: '02:4e:00:30:00:01', kind: 'serial' },
        { id: 'Serial1', mac: '02:4e:00:30:00:02', kind: 'serial' },
        { id: 'GigabitEthernet0', mac: '02:4e:00:30:00:03' },
        { id: 'GigabitEthernet1', mac: '02:4e:00:30:00:04' },
      ],
    });
  }

  it('relays HDLC frames between serial access lines without learning and never onto ethernet ports', () => {
    const h = csu();
    expect(h.ports.get('Serial0')).toMatchObject({ role: 'access-line', encap: 'hdlc' });
    const sw = createEthSwitch();
    const keepalive = h.build([
      { proto: 'hdlc', fields: { address: HDLC_ADDRESS_BROADCAST, control: 0, protocol: HDLC_PROTO_KEEPALIVE } },
      { proto: 'payload', fields: { data: new Uint8Array(12) } },
    ]);
    const actions = sw.onPdu(h.ctx, keepalive, 'Serial0');
    expect(actions).toEqual([{ type: 'send', port: 'Serial1', pdu: keepalive }]);
    expect(h.tables.cam.size).toBe(0);
    expect(h.debug.at(-1)!.message).toBe('relaying hdlc frame from Serial0 to 1 port(s): Serial1');
    h.ports.get('Serial1')!.operUp = false;
    const lost = h.build([{ proto: 'hdlc', fields: { protocol: HDLC_PROTO_IPV4 } }, { proto: 'payload', fields: { data: new Uint8Array(20) } }]);
    expect(sw.onPdu(h.ctx, lost, 'Serial0')).toEqual([{ type: 'drop', pdu: lost, reason: 'other', detail: DETAIL_NO_EGRESS, port: 'Serial0' }]);
  });

  it('floods ethernet frames only onto ports that carry ethernet', () => {
    const h = csu();
    const sw = createEthSwitch();
    const actions = sw.onPdu(h.ctx, ethFrame(h, HOST_A, MAC_BROADCAST), 'GigabitEthernet0');
    expect(actions.map((a) => [a.type, 'port' in a ? a.port : null])).toEqual([['send', 'GigabitEthernet1']]);
  });
});

describe('ipv4 acts only on ports whose role routes', () => {
  const PORT = 'GigabitEthernet0/0';
  const iface = [['interface', PORT]];

  it('keeps an address configured on a switched port pending, applies it on no switchport and withdraws it on switchport', () => {
    const fake = makeFake({ kind: 'router', ports: [{ id: PORT, mac: '02:4e:00:40:00:01', role: 'switched' }] });
    const ipv4 = createIpv4();
    const arp = makeSink('arp');
    fake.register(arp);

    const pending = fake.run(ipv4.onConfig(fake.ctx, { op: 'set', context: iface, line: ['ip', 'address', '10.1.1.1', '255.255.255.0'] }));
    expect(pending).toEqual([]);
    expect(fake.tables.rib.size).toBe(0);
    expect(fake.ctx.ports.get(PORT)!.l3.ipv4).toBeUndefined();
    expect(fake.debug.at(-1)!.message).toContain('does not route');

    fake.setRole(PORT, 'routed');
    const routed = fake.run(ipv4.onConfig(fake.ctx, { op: 'unset', context: iface, line: ['switchport'] }));
    expect(routed).toEqual([
      { type: 'setPortL3', port: PORT, ipv4: { address: '10.1.1.1', prefixLen: 24 } },
      { type: 'request', to: 'arp', req: { kind: 'arp.gratuitous', iface: PORT } },
    ]);
    expect(fake.tables.rib.rows().map((r) => [r.key, r.source])).toEqual([['10.1.1.0/24', 'C'], ['10.1.1.1/32', 'L']]);

    fake.setRole(PORT, 'switched');
    const switched = fake.run(ipv4.onConfig(fake.ctx, { op: 'set', context: iface, line: ['switchport'] }));
    // P1 W3 (§9.2, contracts/process.ts setPortL3): ipv4 clears explicitly with `ipv4: null` (the member-less fallback goes at W8).
    expect(switched).toEqual([{ type: 'setPortL3', port: PORT, ipv4: null }]);
    expect(fake.tables.rib.size).toBe(0);
    const expired = fake.trace.filter((e) => e.kind === 'tableExpire');
    expect(expired.map((e) => (e.kind === 'tableExpire' ? e.reason : null))).toEqual(['cleared', 'cleared']);
  });

  it('re-evaluates the role during the runtime bounce (down, role change, up) and trusts the up argument', () => {
    const fake = makeFake({ kind: 'router', ports: [{ id: PORT, mac: '02:4e:00:40:00:01', role: 'switched' }] });
    const ipv4 = createIpv4();
    fake.run(ipv4.onConfig(fake.ctx, { op: 'set', context: iface, line: ['ip', 'address', '10.1.1.1', '255.255.255.0'] }));
    expect(ipv4.onLinkChange!(fake.ctx, PORT, false)).toEqual([]);
    fake.setRole(PORT, 'routed');
    const up = fake.run(ipv4.onLinkChange!(fake.ctx, PORT, true));
    expect(up.map((a) => a.type)).toEqual(['setPortL3', 'request']);
    expect(fake.tables.rib.size).toBe(2);
  });

  it('applies an address on an SVI like on any routed interface', () => {
    const fake = makeFake({ kind: 'router', ports: [{ id: VLAN1, mac: SVI_MAC, kind: 'virtual', role: 'svi' }] });
    const ipv4 = createIpv4();
    const actions = fake.run(ipv4.onConfig(fake.ctx, { op: 'set', context: [['interface', VLAN1]], line: ['ip', 'address', '10.1.1.1', '255.255.255.0'] }));
    expect(actions.map((a) => a.type)).toEqual(['setPortL3', 'request']);
  });
});
