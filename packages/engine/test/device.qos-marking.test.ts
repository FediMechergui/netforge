/**
 * device.qos-marking — QoS marking in the device runtime (ARCHITECTURE-P3 D16, §3.0 (a) step 9 and (b) step 10c, §3.5
 * step 3; review T8, T9; §7 W3 device).
 *
 * Real worlds on `staged.world` at stage P3; the frames come from the test injector (`test/inject.ts`), so the test
 * owns every byte that reaches R1 (a flooded frame for another MAC, a BPDU, a tagged frame with a chosen PCP):
 *
 *   INJ Gi0 ── Gi0/0  R1 (NF-2911)       Gi0/0: 10.0.12.1/24, service-policy input MARK
 *   INJ Gi1 ── Gi0/1  R1                 Gi0/1.10: dot1Q 10, 10.0.10.1/24, service-policy input MARK, output COS5
 *
 *   ip access-list extended VOICE-PORTS / permit udp any any range 16384 32767
 *   class-map match-all VOIP / match access-group name VOICE-PORTS
 *   class-map match-any COS3 / match cos 3
 *   policy-map MARK / class VOIP / set dscp ef / class COS3 / set dscp af31
 *   policy-map COS5 / class class-default / set cos 5
 *
 * Pinned here:
 *  - step 10c on a `deliver` verdict: the provenance R1 adds is exactly `QosMark ipv4.dscp 0→46` (cause `policy-map
 *    MARK class VOIP set dscp ef`), then the derived `ChecksumRecompute ipv4.checksum` and `FcsRecompute ethernet.fcs`,
 *    from the real `Pdu.mutate`, mirrored as `mutation` trace events in that order; a frame of class-default is not
 *    rewritten; `qosCounters` counts matched (packets and bytes) and marked;
 *  - a flooded frame for another MAC and a BPDU are neither classified nor counted — on the physical port and on the
 *    subinterface (a tagged flooded frame: the subinterface's previewed verdict drops it, review T9);
 *  - on a `subif` verdict step 10c runs before the tag pop: `match cos` sees the PCP and QosMark precedes VlanTagPop;
 *  - output `set cos 5` on a subinterface writes the PCP of the tag `vlanPush` just pushed (QosMark `dot1q.pcp` 0→5
 *    after VlanTagPush), and the frame leaves R1 with PCP 5;
 *  - editing the ACL a class-map reads (through `applyConfigLine`, rule 13) changes the class of the next frame;
 *  - a world without a service policy calls nothing new: no QosMark anywhere, `qosCounters` undefined on every port.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId, PduId, PortId } from '../src/contracts/ids.js';
import {
  ETHERTYPE_IPV4,
  ETHERTYPE_VLAN,
  IPPROTO_UDP,
  LLC_SAP_STP,
  STP_GROUP_MAC,
  type LayerSpec,
  type Mutation,
} from '../src/contracts/pdu.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { MS, SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { arpFrame, INJECTOR_HOST_TYPE, injectFrames, withInjector } from './inject.js';
import { createStagedSimulation } from './staged.world.js';

const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';
const SUB = 'GigabitEthernet0/1.10';
const INJ_IP = '10.0.12.10';
const INJ_SUB_IP = '10.0.10.20';
const OTHER_MAC = '02:00:5e:10:20:30';

const QOS_LINES: readonly string[] = [
  'ip access-list extended VOICE-PORTS', ' permit udp any any range 16384 32767', '!',
  'class-map match-all VOIP', ' match access-group name VOICE-PORTS', '!',
  'class-map match-any COS3', ' match cos 3', '!',
  'policy-map MARK', ' class VOIP', '  set dscp ef', ' class COS3', '  set dscp af31', '!',
  'policy-map COS5', ' class class-default', '  set cos 5', '!',
];

function r1Config(qos: boolean): string {
  return [
    'hostname R1', '!',
    ...(qos ? QOS_LINES : []),
    `interface ${GI0}`, ' ip address 10.0.12.1 255.255.255.0', ...(qos ? [' service-policy input MARK'] : []), ' no shutdown', '!',
    `interface ${GI1}`, ' no shutdown', '!',
    `interface ${SUB}`, ' encapsulation dot1Q 10', ' ip address 10.0.10.1 255.255.255.0',
    ...(qos ? [' service-policy input MARK', ' service-policy output COS5'] : []), '!',
    'end', '',
  ].join('\n');
}

function world(qos = true): Simulation {
  const sim = createStagedSimulation({ seed: 53, stage: 'P3', factories: withInjector({}) });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: r1Config(qos) });
  sim.addDevice({ id: 'inj', type: INJECTOR_HOST_TYPE, name: 'INJ' });
  sim.addLink({ a: { device: 'inj', port: 'GigabitEthernet0' }, b: { device: 'r1', port: GI0 } });
  sim.addLink({ a: { device: 'inj', port: 'GigabitEthernet1' }, b: { device: 'r1', port: GI1 } });
  sim.runFor(70 * SEC);
  return sim;
}

const mac = (sim: Simulation, device: DeviceId, port: PortId): string => sim.device(device)!.port(port)!.mac;

interface UdpOptions {
  readonly dstMac: string;
  readonly srcMac: string;
  readonly dst: string;
  readonly dstPort: number;
  readonly dscp?: number;
  readonly vlan?: number;
  readonly pcp?: number;
  readonly src?: string;
}

/** A UDP datagram (an 802.1Q tag with `pcp` when `vlan` is given). */
function udpFrame(o: UdpOptions): LayerSpec[] {
  const l2: LayerSpec[] = o.vlan === undefined
    ? [{ proto: 'ethernet', fields: { dst: o.dstMac, src: o.srcMac, type: ETHERTYPE_IPV4 } }]
    : [
        { proto: 'ethernet', fields: { dst: o.dstMac, src: o.srcMac, type: ETHERTYPE_VLAN } },
        { proto: 'dot1q', fields: { vid: o.vlan, pcp: o.pcp ?? 0, type: ETHERTYPE_IPV4 } },
      ];
  return [
    ...l2,
    { proto: 'ipv4', fields: { src: o.src ?? (o.vlan === undefined ? INJ_IP : INJ_SUB_IP), dst: o.dst, protocol: IPPROTO_UDP, ttl: 64, dscp: o.dscp ?? 0 } },
    { proto: 'udp', fields: { srcPort: 40000, dstPort: o.dstPort } },
    { proto: 'payload', fields: {} },
  ];
}

const BPDU = (src: string): LayerSpec[] => [
  { proto: 'ethernet', fields: { dst: STP_GROUP_MAC, src, type: 0 } },
  { proto: 'llc', fields: { dsap: LLC_SAP_STP, ssap: LLC_SAP_STP, control: 3 } },
  {
    proto: 'stp',
    fields: { version: 0, bpduType: 0, rootPriority: 32769, rootMac: src, rootPathCost: 0, bridgePriority: 32769, bridgeMac: src, portId: 0x8001, messageAge: 0, maxAge: 5120, helloTime: 512, forwardDelay: 3840 },
  },
];

/** Inject `frames` from INJ's `port` 10 ms apart, run 1 s past the last, return that stretch of the trace. */
function inject(sim: Simulation, port: PortId, frames: readonly (readonly LayerSpec[])[]): TraceEvent[] {
  const cursor = sim.trace(0).next;
  const ticket = injectFrames(sim, { from: 'inj', port, frames, spacingNs: 10 * MS });
  sim.runUntil(ticket.lastAt + SEC);
  return sim.trace(cursor).events;
}

type Of<K extends TraceEvent['kind']> = Extract<TraceEvent, { kind: K }>;
const ofKind = <K extends TraceEvent['kind']>(evs: readonly TraceEvent[], kind: K): Of<K>[] => evs.filter((e): e is Of<K> => e.kind === kind);

/** The PDU ids R1 received on `port`, in order. */
const rxAt = (evs: readonly TraceEvent[], port: PortId): PduId[] => ofKind(evs, 'frameRx').filter((e) => e.device === 'r1' && e.port === port).map((e) => e.pdu.id);

/** The mutations R1 recorded on `pdu` (from the trace), without their time: reason, field, before, after, cause. */
function mutationsAt(evs: readonly TraceEvent[], pdu: PduId): Omit<Mutation, 'at' | 'device'>[] {
  return ofKind(evs, 'mutation')
    .filter((e) => e.pdu === pdu && e.mutation.device === 'r1')
    .map(({ mutation: m }) => ({ reason: m.reason, field: m.field, before: m.before, after: m.after, ...(m.cause === undefined ? {} : { cause: m.cause }) }));
}

/** The size of `pdu` as R1 received it (its frameRx summary). */
const rxSize = (evs: readonly TraceEvent[], pdu: PduId): number => ofKind(evs, 'frameRx').find((e) => e.device === 'r1' && e.pdu.id === pdu)!.pdu.size;

const counters = (sim: Simulation, port: PortId) => sim.device('r1')!.qosCounters(port);

describe('step 10c on a deliver verdict (R1 Gi0/0, service-policy input MARK)', () => {
  it('a voice datagram: QosMark ipv4.dscp 0→46, then ChecksumRecompute and FcsRecompute, from real calls; counted', () => {
    const sim = world();
    const r1mac = mac(sim, 'r1', GI0);
    const injmac = mac(sim, 'inj', 'GigabitEthernet0');
    const evs = inject(sim, 'GigabitEthernet0', [udpFrame({ dstMac: r1mac, srcMac: injmac, dst: '10.0.12.1', dstPort: 16384 })]);
    const [id] = rxAt(evs, GI0);
    expect(id).toBeDefined();
    const got = mutationsAt(evs, id!);
    expect(got.slice(0, 3)).toEqual([
      { reason: 'QosMark', field: 'ipv4.dscp', before: 0, after: 46, cause: 'policy-map MARK class VOIP set dscp ef' },
      // the derived records carry the same cause (Pdu.mutate)
      { reason: 'ChecksumRecompute', field: 'ipv4.checksum', before: expect.any(Number), after: expect.any(Number), cause: 'policy-map MARK class VOIP set dscp ef' },
      { reason: 'FcsRecompute', field: 'ethernet.fcs', before: expect.any(Number), after: expect.any(Number), cause: 'policy-map MARK class VOIP set dscp ef' },
    ]);
    expect(got.filter((m) => m.reason === 'QosMark')).toHaveLength(1);
    // the PDU itself: DSCP 46 and the same three records at the head of R1's part of its provenance
    const pdu = sim.pdu(id!)!;
    expect(pdu.layer('ipv4')!.fields['dscp']).toBe(46);
    const prov = pdu.provenance.filter((m) => m.device === 'r1').map((m) => m.reason);
    expect(prov.slice(0, 3)).toEqual(['QosMark', 'ChecksumRecompute', 'FcsRecompute']);
    // the mutation events come right after R1's frameRx of that frame, before anything else R1 does with it
    const rxIndex = evs.findIndex((e) => e.kind === 'frameRx' && e.device === 'r1' && e.pdu.id === id);
    expect(evs.slice(rxIndex + 1, rxIndex + 4).map((e) => (e.kind === 'mutation' ? e.mutation.reason : e.kind))).toEqual(['QosMark', 'ChecksumRecompute', 'FcsRecompute']);
    const size = rxSize(evs, id!);
    expect(counters(sim, GI0)).toEqual({
      input: 'MARK',
      classes: [
        { name: 'VOIP', matched: 1, matchedBytes: size, marked: 1 },
        { name: 'COS3', matched: 0, matchedBytes: 0, marked: 0 },
        { name: 'class-default', matched: 0, matchedBytes: 0, marked: 0 },
      ],
    });
  });

  it('a data datagram falls in class-default and is not rewritten; a datagram already EF is counted marked, unchanged', () => {
    const sim = world();
    const r1mac = mac(sim, 'r1', GI0);
    const injmac = mac(sim, 'inj', 'GigabitEthernet0');
    const evs = inject(sim, 'GigabitEthernet0', [
      udpFrame({ dstMac: r1mac, srcMac: injmac, dst: '10.0.12.1', dstPort: 5000 }),
      udpFrame({ dstMac: r1mac, srcMac: injmac, dst: '10.0.12.1', dstPort: 20000, dscp: 46 }),
    ]);
    const [data, ef] = rxAt(evs, GI0);
    expect(mutationsAt(evs, data!).filter((m) => m.reason === 'QosMark')).toEqual([]);
    expect(sim.pdu(data!)!.layer('ipv4')!.fields['dscp']).toBe(0);
    // a rewrite that would not change the value records nothing, but the frame still counts as marked
    expect(mutationsAt(evs, ef!).filter((m) => m.reason === 'QosMark')).toEqual([]);
    const view = counters(sim, GI0)!;
    expect(view.classes.map((c) => [c.name, c.matched, c.marked])).toEqual([['VOIP', 1, 1], ['COS3', 0, 0], ['class-default', 1, 0]]);
  });
});

describe('frames the pipeline drops are never classified or counted (review T9)', () => {
  it('a flooded datagram for another MAC and a BPDU at Gi0/0: dropped not-for-me, no QosMark, no count', () => {
    const sim = world();
    const injmac = mac(sim, 'inj', 'GigabitEthernet0');
    const evs = inject(sim, 'GigabitEthernet0', [udpFrame({ dstMac: OTHER_MAC, srcMac: injmac, dst: '10.0.12.1', dstPort: 16384 }), BPDU(injmac)]);
    const drops = ofKind(evs, 'drop').filter((d) => d.device === 'r1');
    expect(drops.map((d) => [d.port, d.reason, d.pdu.proto])).toEqual([[GI0, 'not-for-me', 'udp'], [GI0, 'not-for-me', 'stp']]);
    expect(ofKind(evs, 'mutation').filter((e) => e.mutation.reason === 'QosMark')).toEqual([]);
    expect(counters(sim, GI0)!.classes.every((c) => c.matched === 0 && c.matchedBytes === 0 && c.marked === 0)).toBe(true);
  });

  it('a tagged flooded datagram for another MAC on the subinterface: dropped there, never classified', () => {
    const sim = world();
    const injmac = mac(sim, 'inj', 'GigabitEthernet1');
    const evs = inject(sim, 'GigabitEthernet1', [udpFrame({ dstMac: OTHER_MAC, srcMac: injmac, dst: '10.0.10.1', dstPort: 16384, vlan: 10, pcp: 3 })]);
    const drops = ofKind(evs, 'drop').filter((d) => d.device === 'r1');
    expect(drops.map((d) => [d.port, d.reason])).toEqual([[SUB, 'not-for-me']]);
    expect(ofKind(evs, 'mutation').filter((e) => e.mutation.reason === 'QosMark')).toEqual([]);
    const view = counters(sim, SUB)!;
    expect(view.classes.slice(0, 3).every((c) => c.matched === 0 && c.marked === 0)).toBe(true);
  });
});

describe('step 10c on a subif verdict runs before the tag pop', () => {
  it('match cos sees the 802.1Q PCP, and QosMark precedes VlanTagPop in the provenance', () => {
    const sim = world();
    const r1mac = mac(sim, 'r1', GI1);
    const injmac = mac(sim, 'inj', 'GigabitEthernet1');
    const evs = inject(sim, 'GigabitEthernet1', [udpFrame({ dstMac: r1mac, srcMac: injmac, dst: '10.0.10.1', dstPort: 5000, vlan: 10, pcp: 3 })]);
    const [id] = rxAt(evs, GI1);
    const got = mutationsAt(evs, id!);
    expect(got.slice(0, 5).map((m) => [m.reason, m.field])).toEqual([
      ['QosMark', 'ipv4.dscp'],
      ['ChecksumRecompute', 'ipv4.checksum'],
      ['FcsRecompute', 'ethernet.fcs'],
      ['VlanTagPop', 'dot1q.vid'],
      ['FcsRecompute', 'ethernet.fcs'],
    ]);
    expect(got[0]).toEqual({ reason: 'QosMark', field: 'ipv4.dscp', before: 0, after: 26, cause: 'policy-map MARK class COS3 set dscp af31' });
    const view = counters(sim, SUB)!;
    expect(view.input).toBe('MARK');
    expect(view.output).toBe('COS5');
    // matchedBytes: the frame as it arrived, tag included
    expect(view.classes[1]).toEqual({ name: 'COS3', matched: 1, matchedBytes: rxSize(evs, id!), marked: 1 });
    // the physical port's own policy never saw it (the subinterface's policy applies to a subif frame)
    expect(counters(sim, GI0)!.classes.every((c) => c.matched === 0)).toBe(true);
  });
});

describe('output marking on a subinterface writes the pushed tag', () => {
  it('set cos 5: VlanTagPush, then QosMark dot1q.pcp 0→5, and the frame leaves R1 with PCP 5', () => {
    const sim = world();
    const injmac = mac(sim, 'inj', 'GigabitEthernet1');
    // an ARP request for R1's subinterface address: R1's reply leaves Gi0/1.10, tagged by the push
    const evs = inject(sim, 'GigabitEthernet1', [arpFrame({ sha: injmac, spa: INJ_SUB_IP, tpa: '10.0.10.1', vlan: 10 })]);
    const tx = ofKind(evs, 'frameTx').filter((e) => e.from.device === 'r1' && e.from.port === GI1);
    expect(tx.length).toBeGreaterThan(0);
    const reply = tx.find((e) => e.pdu.proto === 'arp');
    expect(reply).toBeDefined();
    const got = mutationsAt(evs, reply!.pdu.id);
    const push = got.findIndex((m) => m.reason === 'VlanTagPush');
    expect(push).toBeGreaterThanOrEqual(0);
    expect(got.slice(push).map((m) => [m.reason, m.field])).toEqual([
      ['VlanTagPush', 'dot1q.vid'],
      ['FcsRecompute', 'ethernet.fcs'],
      ['QosMark', 'dot1q.pcp'],
      ['FcsRecompute', 'ethernet.fcs'],
    ]);
    expect(got[push + 2]).toEqual({ reason: 'QosMark', field: 'dot1q.pcp', before: 0, after: 5, cause: 'policy-map COS5 class class-default set cos 5' });
    const pdu = sim.pdu(reply!.pdu.id)!;
    expect(pdu.layer('dot1q')!.fields).toMatchObject({ vid: 10, pcp: 5 });
    const out = counters(sim, SUB)!.classes.at(-1)!;
    expect(out.name).toBe('class-default');
    expect(out.matched).toBeGreaterThanOrEqual(1);
    expect(out.marked).toBe(out.matched);
  });
});

describe('the policy cache follows the configuration generation', () => {
  it('editing the ACL the class-map reads changes the class of the next frame', () => {
    const sim = world();
    const r1 = sim.device('r1')!;
    const r1mac = mac(sim, 'r1', GI0);
    const injmac = mac(sim, 'inj', 'GigabitEthernet0');
    const frame = udpFrame({ dstMac: r1mac, srcMac: injmac, dst: '10.0.12.1', dstPort: 5060 });
    const before = inject(sim, 'GigabitEthernet0', [frame]);
    const [first] = rxAt(before, GI0);
    expect(mutationsAt(before, first!).filter((m) => m.reason === 'QosMark')).toEqual([]);
    expect(counters(sim, GI0)!.classes.map((c) => [c.name, c.matched])).toEqual([['VOIP', 0], ['COS3', 0], ['class-default', 1]]);

    expect(r1.applyConfigLine([['ip', 'access-list', 'extended', 'VOICE-PORTS']], ['permit', 'udp', 'any', 'any', 'eq', '5060'], false)).toEqual({ ok: true });
    const after = inject(sim, 'GigabitEthernet0', [frame]);
    const [second] = rxAt(after, GI0);
    expect(mutationsAt(after, second!)[0]).toEqual({ reason: 'QosMark', field: 'ipv4.dscp', before: 0, after: 46, cause: 'policy-map MARK class VOIP set dscp ef' });
    // the counters of the same policy-map are kept across the recompile
    expect(counters(sim, GI0)!.classes.map((c) => [c.name, c.matched, c.marked])).toEqual([['VOIP', 1, 1], ['COS3', 0, 0], ['class-default', 1, 0]]);

    // removing the attachment removes the view; attaching again starts from zero
    expect(r1.applyConfigLine([['interface', GI0]], ['service-policy', 'input', 'MARK'], true)).toEqual({ ok: true });
    expect(counters(sim, GI0)).toBeUndefined();
    const detached = inject(sim, 'GigabitEthernet0', [frame]);
    expect(ofKind(detached, 'mutation').filter((e) => e.mutation.reason === 'QosMark')).toEqual([]);
    expect(r1.applyConfigLine([['interface', GI0]], ['service-policy', 'input', 'MARK'], false)).toEqual({ ok: true });
    expect(counters(sim, GI0)!.classes.every((c) => c.matched === 0)).toBe(true);
  });
});

describe('a world without a service policy', () => {
  it('records no QosMark and has no QoS view on any port; the same frames take the same path', () => {
    const plain = world(false);
    const r1 = plain.device('r1')!;
    for (const p of [GI0, GI1, SUB, 'Serial0/0/0']) expect(r1.qosCounters(p)).toBeUndefined();
    for (const p of [GI0, GI1, 'Serial0/0/0']) expect(r1.egressPolicy(p)).toBeUndefined();
    const r1mac = mac(plain, 'r1', GI0);
    const injmac = mac(plain, 'inj', 'GigabitEthernet0');
    const evs = inject(plain, 'GigabitEthernet0', [udpFrame({ dstMac: r1mac, srcMac: injmac, dst: '10.0.12.1', dstPort: 16384 })]);
    expect(ofKind(evs, 'mutation').filter((e) => e.mutation.reason === 'QosMark')).toEqual([]);
    expect(rxAt(evs, GI0)).toHaveLength(1);
  });
});
