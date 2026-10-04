/**
 * device.qos-egress — [S20]/[S21] the delimited QoS block of the W3 device item, against a FAKE link model
 * (ARCHITECTURE-P3 D16, §3.11, §5.4; rulings R26; §7 W3 device):
 *
 *  - `DeviceRuntime.egressPolicy(port)`: the scheduler spec compiled from a physical port's output policy when it holds a
 *    queueing action and passes the 75 % admission (reference rate: the `bandwidth` line, else the routing bandwidth),
 *    else [S21] interface `fair-queue`; undefined elsewhere; the same object while its content is unchanged;
 *  - `{qosClass}` on `deps.transmit` for a scheduler port only (the class index of the output policy); every other port
 *    keeps the three-argument call;
 *  - `service-policy output` (and [S21] `fair-queue`) is a PHY line of physical ports (`onPortPhyConfig`), and a QoS
 *    delta that changes a port's spec (a policy-map body, an interface `bandwidth`) tells the link model too; nothing
 *    else does;
 *  - [S21] input policing at step 10c after the marking, with the R26 actions (`conform-action` / `exceed-action`
 *    transmit, drop, set-dscp-transmit) and their conform / exceed counts in `qosCounters`; an output policer runs in the
 *    runtime unless the scheduler spec carries it;
 *  - R26 at the pure level: `PolicerSpec` actions (absent = transmit / drop) in `qos/config.ts` and the port scheduler.
 *
 * The fake link model records every `transmit` (argument count and options) and every `onPortPhyConfig`, and reads the
 * runtime's `egressPolicy` there as the real one does through `LinkModelDeps.egressPolicy` (W3 media builds the real
 * held queue in parallel; the two meet in a W4 acceptance row).
 */
import { describe, expect, it } from 'vitest';
import { L3_ROLES } from '../src/contracts/catalog.js';
import type { DeviceRuntime, DeviceSpec } from '../src/contracts/device.js';
import type { PortId, PortRef } from '../src/contracts/ids.js';
import type { EgressSchedulerSpec, TransmitFn, TransmitOptions } from '../src/contracts/link.js';
import { ETHERTYPE_IPV4, HDLC_ADDRESS_UNICAST, HDLC_PROTO_IPV4, IPPROTO_UDP, type LayerSpec, type Pdu } from '../src/contracts/pdu.js';
import type { SimTime } from '../src/contracts/time.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createRng } from '../src/core/prng.js';
import { createScheduler } from '../src/core/scheduler.js';
import { createTable } from '../src/core/table.js';
import { createCatalog } from '../src/device/catalog.js';
import { createDevice } from '../src/device/device.js';
import { createPortScheduler, qosPoliceConformDropDetail, qosPolicerAction } from '../src/link/qos/scheduler.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { compileQosPolicy, egressSchedulerSpecOf, qosPolicerSpecOf } from '../src/qos/config.js';
import { parseConfigText } from '../src/cli/config-ast.js';
import { fakeProcess, type FakeProcess } from './device.harness.js';

const GI0 = 'GigabitEthernet0/0';
const GI1 = 'GigabitEthernet0/1';
const SE0 = 'Serial0/0/0';
const SE1 = 'Serial0/0/1';
const PEER_MAC = '02:00:5e:00:00:01';

const CONFIG = [
  'hostname R1', '!',
  'ip access-list extended BULK-PORTS', ' permit udp any any eq 9', '!',
  'class-map match-all VOICE', ' match dscp ef', '!',
  'class-map match-all BULK', ' match access-group name BULK-PORTS', '!',
  'policy-map WAN-EDGE', ' class VOICE', '  priority 32', ' class class-default', '  fair-queue', '!',
  'policy-map WAN-BIG', ' class VOICE', '  priority 100', '!',
  'policy-map WAN-POLICE', ' class VOICE', '  priority 32', ' class class-default', '  police 64000 conform-action transmit exceed-action drop', '!',
  'policy-map EDGE-IN',
  ' class BULK', '  set dscp af11', '  police 8000 1500 conform-action transmit exceed-action drop',
  ' class VOICE', '  police 16000 1500 conform-action transmit exceed-action set-dscp-transmit af41',
  ' class class-default', '  police 8000 1500 conform-action drop exceed-action drop', '!',
  'policy-map OUT-POLICE', ' class class-default', '  set dscp cs1', '  police 8000 1500 conform-action transmit exceed-action drop', '!',
  'policy-map MARK-OUT', ' class class-default', '  set dscp af21', '!',
  `interface ${GI0}`, ' ip address 10.0.12.1 255.255.255.0', ' service-policy input EDGE-IN', ' no shutdown', '!',
  `interface ${GI1}`, ' ip address 10.0.13.1 255.255.255.0', ' service-policy output OUT-POLICE', ' no shutdown', '!',
  `interface ${SE0}`, ' bandwidth 128', ' ip address 10.0.0.1 255.255.255.252', ' service-policy output WAN-EDGE', ' no shutdown', '!',
  `interface ${SE1}`, ' bandwidth 128', ' ip address 10.0.1.1 255.255.255.252', ' service-policy output WAN-BIG', ' no shutdown', '!',
  'end', '',
].join('\n');

interface TransmitCall {
  readonly port: PortId;
  readonly pdu: Pdu;
  readonly argc: number;
  readonly opts?: TransmitOptions;
  /** The class the fake link model put the frame in (scheduler ports only). */
  readonly queue?: string;
}

interface Rig {
  readonly device: DeviceRuntime;
  readonly ipv4: FakeProcess;
  readonly events: TraceEvent[];
  readonly transmits: TransmitCall[];
  /** `onPortPhyConfig` calls with the spec the fake link model read at that moment. */
  readonly phy: { port: PortId; spec: EgressSchedulerSpec | undefined }[];
  readonly pdus: ReturnType<typeof createPduFactory>;
  now: SimTime;
}

/** A booted NF-2911 with `CONFIG`, a fake `ipv4` (the delivery target of step 10c) and a fake link model. */
function rig(config = CONFIG): Rig {
  const events: TraceEvent[] = [];
  const scheduler = createScheduler();
  const pdus = createPduFactory();
  const transmits: TransmitCall[] = [];
  const phy: Rig['phy'] = [];
  const ipv4 = fakeProcess('ipv4', { handles: [{ layer: 'ethernet', ethertype: ETHERTYPE_IPV4, roles: L3_ROLES }] });
  let device: DeviceRuntime | undefined;
  const transmit: TransmitFn = (...args) => {
    const [from, pdu, now, opts] = args;
    const spec = device!.egressPolicy(from.port);
    const call: TransmitCall = {
      port: from.port,
      pdu,
      argc: args.length,
      ...(opts === undefined ? {} : { opts: { ...opts } }),
      ...(spec === undefined ? {} : { queue: spec.classes[opts?.qosClass ?? spec.classes.length - 1]?.name ?? spec.classes.at(-1)!.name }),
    };
    transmits.push(call);
    return { ok: true, link: 'l_1', txStart: now, txEnd: now + 1000, arrive: now + 2000 };
  };
  const spec: DeviceSpec = { id: 'd_r1', type: 'router.nf2911', name: 'R1', position: { x: 0, y: 0 }, power: true, startupConfig: config, modules: [], macSalt: 0 };
  device = createDevice(
    spec,
    {
      scheduler,
      trace: { emit: (ev) => events.push(ev) },
      rng: createRng(7).split('device:d_r1'),
      pdus,
      catalog: createCatalog({ ipv4: ipv4.factory }),
      tables: createTable,
      transmit,
      onPortAdmin: () => undefined,
      onPortPhyConfig: (ref: PortRef) => phy.push({ port: ref.port, spec: device!.egressPolicy(ref.port) }),
      mediumOp: () => undefined,
      airView: () => ({ visibleBss: () => [], link: () => undefined }),
      cliSink: { output: () => undefined, done: () => undefined },
    },
    0,
  );
  // boot: dispatch the pending boot event (and nothing later)
  const t = scheduler.peekTime()!;
  while (scheduler.peekTime() !== undefined && scheduler.peekTime()! <= t) {
    const ev = scheduler.next()!;
    if (ev.kind === 'boot') device.onBoot(ev.at);
  }
  expect(device.bootedAt).toBeDefined();
  // the fake link model brings the cabled ports up (the link model alone writes operUp)
  for (const p of [GI0, GI1, SE0, SE1]) device.port(p)!.operUp = true;
  phy.length = 0; // the boot replay's own PHY lines are not what these tests look at
  return { device, ipv4, events, transmits, phy, pdus, now: 10 * SEC };
}

interface Datagram {
  readonly dscp?: number;
  readonly dstPort?: number;
  readonly payload?: number;
}

const udp = (d: Datagram): LayerSpec[] => [
  { proto: 'ipv4', fields: { src: '10.0.12.10', dst: '10.0.13.10', protocol: IPPROTO_UDP, ttl: 64, dscp: d.dscp ?? 0 } },
  { proto: 'udp', fields: { srcPort: 40000, dstPort: d.dstPort ?? 5000 } },
  { proto: 'payload', fields: { data: new Uint8Array(d.payload ?? 100) } },
];

/** An HDLC-framed datagram for a serial port. */
const hdlcFrame = (r: Rig, d: Datagram): Pdu =>
  r.pdus.build([{ proto: 'hdlc', fields: { address: HDLC_ADDRESS_UNICAST, control: 0, protocol: HDLC_PROTO_IPV4 } }, ...udp(d)], { born: r.now, origin: 'd_r1' });

/** An Ethernet-framed datagram to `dst`. */
const ethFrame = (r: Rig, dst: string, d: Datagram): Pdu =>
  r.pdus.build([{ proto: 'ethernet', fields: { dst, src: PEER_MAC, type: ETHERTYPE_IPV4 } }, ...udp(d)], { born: r.now, origin: 'd_peer' });

/** R1 sends `pdu` out of `port` (as its ipv4 would). */
function send(r: Rig, port: PortId, pdu: Pdu): TransmitCall | undefined {
  const n = r.transmits.length;
  r.device.applyActions('ipv4', [{ type: 'send', port, pdu }], r.now);
  return r.transmits.length > n ? r.transmits.at(-1) : undefined;
}

/** A frame arrives at R1 `port` (step 10c runs on its deliver verdict). */
function arrive(r: Rig, port: PortId, pdu: Pdu): void {
  r.device.onFrameArrival(port, pdu, false, r.now);
}

const delivered = (r: Rig): Pdu[] => r.ipv4.calls.filter((c) => c.kind === 'onPdu').map((c) => c.pdu!);
const drops = (r: Rig): Extract<TraceEvent, { kind: 'drop' }>[] => r.events.filter((e): e is Extract<TraceEvent, { kind: 'drop' }> => e.kind === 'drop');
const qosMarks = (pdu: Pdu) => pdu.provenance.filter((m) => m.reason === 'QosMark').map((m) => ({ field: m.field, before: m.before, after: m.after, cause: m.cause }));

const WAN_EDGE_SPEC: EgressSchedulerSpec = {
  policy: 'WAN-EDGE',
  refBps: 128_000,
  classes: [
    { name: 'VOICE', kind: 'priority', rateBps: 32_000, weightKbps: 32, queueLimit: 64 },
    { name: 'class-default', kind: 'default', weightKbps: 96, queueLimit: 64, fairQueue: true },
  ],
};

describe('[S20] egressPolicy: compiled from the port output policy', () => {
  it('Se0/0/0 (bandwidth 128, WAN-EDGE): the §3.11 spec, the same object on every read', () => {
    const r = rig();
    const spec = r.device.egressPolicy(SE0);
    expect(spec).toEqual(WAN_EDGE_SPEC);
    expect(r.device.egressPolicy(SE0)).toBe(spec);
    r.now += SEC;
    send(r, SE0, hdlcFrame(r, { dscp: 46 }));
    expect(r.device.egressPolicy(SE0)).toBe(spec);
  });

  it('no spec: a marking or policing output policy (no queueing action), an input policy, no policy, a virtual port', () => {
    const r = rig();
    expect(r.device.egressPolicy(GI1)).toBeUndefined();
    expect(r.device.egressPolicy(GI0)).toBeUndefined();
    expect(r.device.egressPolicy('Console')).toBeUndefined();
    expect(r.device.egressPolicy('Nowhere0/9')).toBeUndefined();
    expect(r.device.applyConfigLine([['interface', 'Loopback0']], ['ip', 'address', '1.1.1.1', '255.255.255.255'], false)).toEqual({ ok: true });
    expect(r.device.egressPolicy('Loopback0')).toBeUndefined();
  });

  it('a policy the 75 % admission refuses gives no spec; a bandwidth line that admits it brings the spec and tells the link model', () => {
    const r = rig();
    expect(r.device.egressPolicy(SE1)).toBeUndefined(); // priority 100 kb/s > 75 % of 128 kb/s
    expect(r.device.applyConfigLine([['interface', SE1]], ['bandwidth', '1000'], false)).toEqual({ ok: true });
    const spec = r.device.egressPolicy(SE1)!;
    expect(spec).toMatchObject({ policy: 'WAN-BIG', refBps: 1_000_000, classes: [{ name: 'VOICE', kind: 'priority', rateBps: 100_000 }, { name: 'class-default', kind: 'default' }] });
    expect(r.phy).toEqual([{ port: SE1, spec }]);
  });

  it('[S21] interface fair-queue: a one-class WFQ spec at the routing bandwidth of a serial port; frames carry no class', () => {
    const r = rig();
    expect(r.device.applyConfigLine([['interface', SE1]], ['service-policy', 'output', 'WAN-BIG'], true)).toEqual({ ok: true });
    r.phy.length = 0;
    expect(r.device.applyConfigLine([['interface', SE1]], ['fair-queue'], false)).toEqual({ ok: true });
    const spec = r.device.egressPolicy(SE1)!;
    expect(spec).toEqual({ policy: '', refBps: 128_000, classes: [{ name: 'class-default', kind: 'default', weightKbps: 128, queueLimit: 256, fairQueue: true }] });
    expect(r.phy).toEqual([{ port: SE1, spec }]);
    const call = send(r, SE1, hdlcFrame(r, { dscp: 46 }))!;
    expect(call.argc).toBe(3);
    expect(call.queue).toBe('class-default');
  });
});

describe('[S20] {qosClass} on deps.transmit (a scheduler port only)', () => {
  it('Se0/0/0: EF → {qosClass: 0} (VOICE), anything else → {qosClass: 1} (class-default); counted per class', () => {
    const r = rig();
    const ef = send(r, SE0, hdlcFrame(r, { dscp: 46 }))!;
    const be = send(r, SE0, hdlcFrame(r, { dscp: 0 }))!;
    expect([ef.argc, ef.opts, ef.queue]).toEqual([4, { qosClass: 0 }, 'VOICE']);
    expect([be.argc, be.opts, be.queue]).toEqual([4, { qosClass: 1 }, 'class-default']);
    expect(r.device.qosCounters(SE0)).toEqual({
      output: 'WAN-EDGE',
      classes: [
        { name: 'VOICE', matched: 1, matchedBytes: ef.pdu.size, marked: 0 },
        { name: 'class-default', matched: 1, matchedBytes: be.pdu.size, marked: 0 },
      ],
    });
    // the counters of the port count every frame handed over, as before
    expect(r.device.port(SE0)!.counters.outPackets).toBeGreaterThanOrEqual(2);
  });

  it('a port without a policy and a marking-only output port keep the three-argument call (the marking still happens)', () => {
    const r = rig();
    expect(r.device.applyConfigLine([['interface', GI1]], ['service-policy', 'output', 'MARK-OUT'], false)).toEqual({ ok: true });
    const plain = send(r, GI0, ethFrame(r, PEER_MAC, {}))!;
    expect(plain.argc).toBe(3);
    expect(plain).not.toHaveProperty('opts');
    const marked = send(r, GI1, ethFrame(r, PEER_MAC, {}))!;
    expect(marked.argc).toBe(3);
    expect(qosMarks(marked.pdu)).toEqual([{ field: 'ipv4.dscp', before: 0, after: 18, cause: 'policy-map MARK-OUT class class-default set dscp af21' }]);
    expect(r.device.qosCounters(GI0)).toMatchObject({ input: 'EDGE-IN' });
    expect(r.device.qosCounters(GI0)).not.toHaveProperty('output');
  });
});

describe('[S20] service-policy output is a PHY line of physical ports; spec changes tell the link model', () => {
  it('attach and detach on Se0/0/1: one onPortPhyConfig each, reading the new spec', () => {
    const r = rig();
    expect(r.device.applyConfigLine([['interface', SE1]], ['service-policy', 'output', 'WAN-BIG'], true)).toEqual({ ok: true });
    expect(r.phy).toEqual([{ port: SE1, spec: undefined }]); // the line itself is a PHY line (no spec before, none after)
    r.phy.length = 0;
    expect(r.device.applyConfigLine([['interface', SE1]], ['service-policy', 'output', 'WAN-EDGE'], false)).toEqual({ ok: true });
    const spec = r.device.egressPolicy(SE1)!;
    expect(spec).toEqual(WAN_EDGE_SPEC);
    expect(spec).not.toBe(r.device.egressPolicy(SE0));
    expect(r.phy).toEqual([{ port: SE1, spec }]);
    r.phy.length = 0;
    expect(r.device.applyConfigLine([['interface', SE1]], ['service-policy', 'output', 'WAN-EDGE'], true)).toEqual({ ok: true });
    expect(r.phy).toEqual([{ port: SE1, spec: undefined }]);
  });

  it('an input policy, a subinterface policy and an unrelated ACL edit tell nothing; a policy-map body and a bandwidth line do', () => {
    const r = rig();
    expect(r.device.applyConfigLine([['interface', SE1]], ['service-policy', 'input', 'EDGE-IN'], false)).toEqual({ ok: true });
    expect(r.device.applyConfigLine([['interface', 'GigabitEthernet0/0.5']], ['encapsulation', 'dot1Q', '5'], false)).toEqual({ ok: true });
    expect(r.device.applyConfigLine([['interface', 'GigabitEthernet0/0.5']], ['service-policy', 'output', 'MARK-OUT'], false)).toEqual({ ok: true });
    expect(r.device.applyConfigLine([['ip', 'access-list', 'extended', 'BULK-PORTS']], ['permit', 'udp', 'any', 'any', 'eq', '19'], false)).toEqual({ ok: true });
    expect(r.phy).toEqual([]);
    const before = r.device.egressPolicy(SE0);
    expect(r.device.applyConfigLine([['policy-map', 'WAN-EDGE'], ['class', 'VOICE']], ['priority', '48'], false)).toEqual({ ok: true });
    const after = r.device.egressPolicy(SE0)!;
    expect(after).not.toBe(before);
    expect(after.classes[0]).toMatchObject({ name: 'VOICE', rateBps: 48_000, weightKbps: 48 });
    expect(r.phy).toEqual([{ port: SE0, spec: after }]);
    r.phy.length = 0;
    expect(r.device.applyConfigLine([['interface', SE0]], ['bandwidth', '256'], false)).toEqual({ ok: true });
    expect(r.phy).toEqual([{ port: SE0, spec: r.device.egressPolicy(SE0) }]);
    expect(r.device.egressPolicy(SE0)!.refBps).toBe(256_000);
  });
});

describe('[S21] input policing at step 10c, after the marking (ruling R26 actions)', () => {
  it('BULK: set dscp af11, then police 8000 transmit/drop — the second datagram at the same instant drops policed, marked first', () => {
    const r = rig();
    const mac = r.device.port(GI0)!.mac;
    const inDrops = r.device.port(GI0)!.counters.inDrops;
    const a = ethFrame(r, mac, { dstPort: 9, payload: 1000 });
    const b = ethFrame(r, mac, { dstPort: 9, payload: 1000 });
    arrive(r, GI0, a);
    arrive(r, GI0, b);
    expect(delivered(r)).toEqual([a]);
    const cause = 'policy-map EDGE-IN class BULK set dscp af11';
    expect(qosMarks(a)).toEqual([{ field: 'ipv4.dscp', before: 0, after: 10, cause }]);
    expect(qosMarks(b)).toEqual([{ field: 'ipv4.dscp', before: 0, after: 10, cause }]);
    expect(drops(r).map((d) => [d.port, d.reason, d.detail, d.pdu.id])).toEqual([[GI0, 'policed', 'class BULK is over its police rate of 8 kb/s', b.id]]);
    expect(r.device.port(GI0)!.counters.inDrops).toBe(inDrops + 1);
    const bulk = r.device.qosCounters(GI0)!.classes.find((c) => c.name === 'BULK')!;
    expect(bulk).toEqual({ name: 'BULK', matched: 2, matchedBytes: a.size + b.size, marked: 2, police: { conform: 1, conformBytes: a.size, exceed: 1, exceedBytes: b.size } });
    // a second later the bucket has refilled 8000 bits: enough for one more such datagram, not for two
    r.now += SEC;
    arrive(r, GI0, ethFrame(r, mac, { dstPort: 9, payload: 1000 }));
    arrive(r, GI0, ethFrame(r, mac, { dstPort: 9, payload: 1000 }));
    expect(delivered(r)).toHaveLength(2);
    expect(drops(r)).toHaveLength(2);
  });

  it('VOICE: exceed-action set-dscp-transmit af41 rewrites the DSCP of the exceeding datagram (QosMark) and delivers it', () => {
    const r = rig();
    const mac = r.device.port(GI0)!.mac;
    const first = ethFrame(r, mac, { dscp: 46, payload: 1000 });
    const second = ethFrame(r, mac, { dscp: 46, payload: 1000 });
    arrive(r, GI0, first);
    arrive(r, GI0, second);
    expect(delivered(r)).toEqual([first, second]);
    expect(qosMarks(first)).toEqual([]);
    expect(qosMarks(second)).toEqual([{ field: 'ipv4.dscp', before: 46, after: 34, cause: 'policy-map EDGE-IN class VOICE police exceed-action set-dscp-transmit af41' }]);
    expect(second.layer('ipv4')!.fields['dscp']).toBe(34);
    const voice = r.device.qosCounters(GI0)!.classes.find((c) => c.name === 'VOICE')!;
    expect(voice.police).toEqual({ conform: 1, conformBytes: first.size, exceed: 1, exceedBytes: second.size });
    expect(voice.marked).toBe(0);
  });

  it('class-default: conform-action drop drops even the conforming datagram, with its own detail', () => {
    const r = rig();
    const mac = r.device.port(GI0)!.mac;
    const pdu = ethFrame(r, mac, { dstPort: 7000, payload: 10 });
    arrive(r, GI0, pdu);
    expect(delivered(r)).toEqual([]);
    expect(drops(r).map((d) => [d.reason, d.detail])).toEqual([['policed', qosPoliceConformDropDetail('class-default', 8000)]]);
    expect(qosPoliceConformDropDetail('class-default', 8000)).toBe('class class-default drops traffic within its police rate of 8 kb/s');
    const def = r.device.qosCounters(GI0)!.classes.at(-1)!;
    expect(def.police).toEqual({ conform: 1, conformBytes: pdu.size, exceed: 0, exceedBytes: 0 });
  });
});

describe('[S21] output policers: the runtime unless the scheduler spec carries them', () => {
  it('Gi0/1 (OUT-POLICE, no queueing): marked, then policed before the link; the drop never reaches deps.transmit', () => {
    const r = rig();
    const first = send(r, GI1, ethFrame(r, PEER_MAC, { payload: 1000 }))!;
    expect(first.argc).toBe(3);
    const n = r.transmits.length;
    const outDrops = r.device.port(GI1)!.counters.outDrops;
    const second = ethFrame(r, PEER_MAC, { payload: 1000 });
    expect(send(r, GI1, second)).toBeUndefined();
    expect(r.transmits).toHaveLength(n);
    expect(qosMarks(second)).toEqual([{ field: 'ipv4.dscp', before: 0, after: 8, cause: 'policy-map OUT-POLICE class class-default set dscp cs1' }]);
    expect(drops(r).map((d) => [d.port, d.reason, d.detail])).toEqual([[GI1, 'policed', 'class class-default is over its police rate of 8 kb/s']]);
    expect(r.device.port(GI1)!.counters.outDrops).toBe(outDrops + 1);
    expect(r.device.qosCounters(GI1)).toEqual({
      output: 'OUT-POLICE',
      classes: [{ name: 'class-default', matched: 2, matchedBytes: first.pdu.size + second.size, marked: 2, police: { conform: 1, conformBytes: first.pdu.size, exceed: 1, exceedBytes: second.size } }],
    });
  });

  it('a scheduler port whose spec carries the transmit/drop policer: the runtime hands every frame over with its class, counts no police', () => {
    const r = rig();
    expect(r.device.applyConfigLine([['interface', SE1]], ['service-policy', 'output', 'WAN-POLICE'], false)).toEqual({ ok: true });
    const spec = r.device.egressPolicy(SE1)!;
    expect(spec.classes[1]).toEqual({ name: 'class-default', kind: 'default', weightKbps: 96, queueLimit: 64, police: { rateBps: 64_000, burstBytes: 2000 } });
    const calls = [0, 1, 2, 3].map(() => send(r, SE1, hdlcFrame(r, { payload: 1400 })));
    expect(calls.map((c) => c?.opts)).toEqual([{ qosClass: 1 }, { qosClass: 1 }, { qosClass: 1 }, { qosClass: 1 }]);
    expect(drops(r)).toEqual([]);
    const def = r.device.qosCounters(SE1)!.classes.at(-1)!;
    expect(def).toEqual({ name: 'class-default', matched: 4, matchedBytes: 4 * calls[0]!.pdu.size, marked: 0 });
  });

  it('both directions on one port: the input policy classes, then the output policy classes', () => {
    const r = rig();
    expect(r.device.applyConfigLine([['interface', GI0]], ['service-policy', 'output', 'MARK-OUT'], false)).toEqual({ ok: true });
    const view = r.device.qosCounters(GI0)!;
    expect([view.input, view.output]).toEqual(['EDGE-IN', 'MARK-OUT']);
    expect(view.classes.map((c) => c.name)).toEqual(['BULK', 'VOICE', 'class-default', 'class-default']);
  });

  it('detaching and attaching again starts the counters from zero, with no frame in between', () => {
    const r = rig();
    send(r, SE0, hdlcFrame(r, { dscp: 46 }));
    expect(r.device.qosCounters(SE0)!.classes[0]!.matched).toBe(1);
    expect(r.device.applyConfigLine([['interface', SE0]], ['service-policy', 'output', 'WAN-EDGE'], true)).toEqual({ ok: true });
    expect(r.device.qosCounters(SE0)).toBeUndefined();
    expect(r.device.applyConfigLine([['interface', SE0]], ['service-policy', 'output', 'WAN-EDGE'], false)).toEqual({ ok: true });
    expect(r.device.qosCounters(SE0)!.classes.map((c) => c.matched)).toEqual([0, 0]);
    // the input policy of another port is untouched by it
    const mac = r.device.port(GI0)!.mac;
    arrive(r, GI0, ethFrame(r, mac, { dstPort: 9, payload: 10 }));
    expect(r.device.applyConfigLine([['interface', GI0]], ['service-policy', 'output', 'MARK-OUT'], false)).toEqual({ ok: true });
    expect(r.device.qosCounters(GI0)!.classes[0]).toMatchObject({ name: 'BULK', matched: 1 });
  });

  it('power-off forgets the counters, the compiled policies and the specs (RAM)', () => {
    const r = rig();
    send(r, SE0, hdlcFrame(r, { dscp: 46 }));
    expect(r.device.qosCounters(SE0)!.classes[0]!.matched).toBe(1);
    r.device.setPower(false, r.now);
    expect(r.device.qosCounters(SE0)).toBeUndefined();
    expect(r.device.egressPolicy(SE0)).toBeUndefined();
  });
});

describe('R26 at the pure level: PolicerSpec actions', () => {
  it('qosPolicerSpecOf keeps the W0 shape for the defaults and carries any other action', () => {
    const ast = parseConfigText(['policy-map P', ' class class-default', '  police 64000 conform-action drop exceed-action transmit', ''].join('\n'));
    const policy = compileQosPolicy(ast, 'P')!;
    expect(qosPolicerSpecOf(policy.classes[0]!.police!)).toEqual({ rateBps: 64_000, burstBytes: 2000, conform: { kind: 'drop' }, exceed: { kind: 'transmit' } });
    expect(qosPolicerSpecOf({ rateBps: 8000, burstBytes: 1500, conform: { kind: 'transmit' }, exceed: { kind: 'drop' } })).toEqual({ rateBps: 8000, burstBytes: 1500 });
    expect(qosPolicerSpecOf({ rateBps: 8000, burstBytes: 1500, conform: { kind: 'transmit' }, exceed: { kind: 'set-dscp-transmit', dscp: 10 } })).toEqual({
      rateBps: 8000, burstBytes: 1500, exceed: { kind: 'set-dscp-transmit', dscp: 10 },
    });
    // a non-default pair is not the scheduler's (qosPoliceInScheduler): the spec leaves it to the runtime
    expect(egressSchedulerSpecOf({ ...policy, queueing: true }, 1_000_000)!.classes[0]).not.toHaveProperty('police');
  });

  it('qosPolicerAction: absent conform = transmit, absent exceed = drop; the scheduler honours drop and transmit', () => {
    expect(qosPolicerAction({}, 'conform')).toEqual({ kind: 'transmit' });
    expect(qosPolicerAction({}, 'exceed')).toEqual({ kind: 'drop' });
    expect(qosPolicerAction({ exceed: { kind: 'transmit' } }, 'exceed')).toEqual({ kind: 'transmit' });
    const base = { policy: 'P', refBps: 1_000_000 } as const;
    const exceedTransmits = createPortScheduler<number>(
      { ...base, classes: [{ name: 'class-default', kind: 'default', weightKbps: 1000, queueLimit: 64, police: { rateBps: 8000, burstBytes: 1500, exceed: { kind: 'transmit' } } }] },
      0,
    );
    const got = [0, 1, 2].map((i) => exceedTransmits.enqueue({ item: i, bytes: 1000 }, 0, true));
    expect(got.map((g) => g.ok)).toEqual([true, true, true]);
    expect(exceedTransmits.policerStats()[0]).toMatchObject({ conform: 1, exceed: 2 });
    const conformDrops = createPortScheduler<number>(
      { ...base, classes: [{ name: 'class-default', kind: 'default', weightKbps: 1000, queueLimit: 64, police: { rateBps: 8000, burstBytes: 1500, conform: { kind: 'drop' } } }] },
      0,
    );
    const first = conformDrops.enqueue({ item: 0, bytes: 1000 }, 0, true);
    const second = conformDrops.enqueue({ item: 1, bytes: 1000 }, 0, true);
    expect(first).toEqual({ ok: false, cls: 0, queue: 'class-default', reason: 'policed', detail: 'class class-default drops traffic within its police rate of 8 kb/s' });
    expect(second).toEqual({ ok: false, cls: 0, queue: 'class-default', reason: 'policed', detail: 'class class-default is over its police rate of 8 kb/s' });
  });
});
