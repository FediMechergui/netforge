/**
 * W2 device (ARCHITECTURE-P2 D11, §3.0 step 10a, §3.4): router subinterfaces in the device runtime — creation from
 * `interface <parent>.<n>` (global line, section line, `ensureVirtualPort`), canonical order, the `encapsulation
 * dot1Q <vid> [native]` special case and its refusals, the oper rule (`no-encapsulation`, `parent-down`), the `subif`
 * ingress verdict (pop stamped with the device and the cause `encapsulation dot1Q <v>`, counted on the subinterface,
 * demux on it), the `parent` egress (count on the subinterface, push unless native, transmit on the parent), removal,
 * power-off and the boot replay. The daemons are recording fakes on the P2-stage NF-2911 (its `subinterfaces` spec).
 */
import { describe, expect, it } from 'vitest';
import { L3_ROLES } from '../src/contracts/catalog.js';
import { CLI_MESSAGES } from '../src/contracts/cli.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { PortId, ProcessName } from '../src/contracts/ids.js';
import { ARP_OP_REQUEST, ETHERTYPE_ARP, ETHERTYPE_IPV4, type LayerSpec, type Pdu } from '../src/contracts/pdu.js';
import type { PortState } from '../src/contracts/port.js';
import type { DebugEvent, Process, StateView } from '../src/contracts/process.js';
import { defineModel } from '../src/device/catalog/define.js';
import { DEVICE_CONFIG_MESSAGES, dot1qCause, parseDot1qArgs } from '../src/device/device.js';
import { VIRTUAL_PORT_MESSAGES } from '../src/device/ports.js';
import { vlanPushOp } from '../src/pdu/vlan.js';
import { NF_2911_INPUT } from './device.catalog.p0-inputs.js';
import { p2Harness, type P2Harness } from './device.p2.harness.js';

const GI0: PortId = 'GigabitEthernet0/0';
const SUB10: PortId = 'GigabitEthernet0/0.10';
const SUB20: PortId = 'GigabitEthernet0/0.20';
const SUB99: PortId = 'GigabitEthernet0/0.99';
const PC1 = '02:00:00:00:00:10';
const BROADCAST = 'ff:ff:ff:ff:ff:ff';

/** The P2-stage branch router (it declares `subinterfaces`), with only the two L3 daemons under test. */
const ROUTER: DeviceModel = { ...defineModel(NF_2911_INPUT, 'P2'), processes: ['arp', 'ipv4'] };

/** One recorded `onPdu` call of an L3 fake. */
interface Seen {
  readonly process: ProcessName;
  readonly port: PortId;
  readonly pdu: Pdu;
}

function l3Fake(name: ProcessName, ethertype: number, seen: Seen[]): () => Process {
  const proc: Process = {
    name,
    handles: [{ layer: 'ethernet', ethertype, roles: L3_ROLES }],
    init: () => [],
    onPdu(_ctx, pdu, port) {
      seen.push({ process: name, port, pdu });
      return [];
    },
    onTimer: () => [],
    onConfig: () => [],
    onLinkChange: () => [],
    stateSnapshot: (): StateView => ({ process: name, state: {} }),
    debugEvents: (): readonly DebugEvent[] => [],
  };
  return () => proc;
}

/** A booted R1 whose Gi0/0 is administratively and operationally up. */
function router(opts: { startupConfig?: string } = {}) {
  const seen: Seen[] = [];
  const h = p2Harness({
    model: ROUTER,
    processes: { arp: l3Fake('arp', ETHERTYPE_ARP, seen), ipv4: l3Fake('ipv4', ETHERTYPE_IPV4, seen) },
    name: 'R1',
    ...(opts.startupConfig !== undefined ? { startupConfig: opts.startupConfig } : {}),
  });
  h.run();
  const at = (h.device.bootedAt as number) + 1;
  const gi = h.device.port(GI0) as PortState;
  if (!gi.adminUp) h.device.applyConfigLine([['interface', GI0]], ['shutdown'], true);
  gi.operUp = true;
  h.device.onPortOper(GI0, true, at);
  h.events.length = 0;
  h.transmits.length = 0;
  return { h, seen, gi, at };
}

const cfg = (h: P2Harness, context: string[][], line: string, negate = false) => h.device.applyConfigLine(context, line.split(' '), negate);
const portStates = (h: P2Harness) => h.kinds('portState').map((e) => [e.port, e.operUp, e.reason]);

const arpLayers = (dst = BROADCAST): LayerSpec[] => [
  { proto: 'ethernet', fields: { dst, src: PC1, type: ETHERTYPE_ARP } },
  { proto: 'arp', fields: { op: ARP_OP_REQUEST, sha: PC1, spa: '192.168.10.10', tha: '00:00:00:00:00:00', tpa: '192.168.10.1' } },
];

/** An ARP request as a switch would hand it over: tagged with `vid` (or untagged when undefined). */
function frame(h: P2Harness, vid?: number, dst = BROADCAST): Pdu {
  const pdu = h.pdus.build(arpLayers(dst), { born: 0, origin: 'd_sw1' });
  if (vid !== undefined) pdu.rewrap({ now: 0, device: 'd_sw1' }, vlanPushOp(vid), 'switchport mode trunk');
  return pdu;
}

const reasons = (pdu: Pdu) => pdu.provenance.map((m) => `${m.reason}@${m.device}`);

describe('subinterface creation (§3.4 step 1)', () => {
  it('interface GigabitEthernet0/0.10 creates a subif port with the parent MAC, ordinal and MTU, administratively up, down until encapsulated', () => {
    const { h, gi, at } = router();
    const v0 = h.device.portsVersion;
    expect(cfg(h, [], `interface ${SUB10}`)).toEqual({ ok: true });
    const sub = h.device.port(SUB10) as PortState;
    expect(sub.spec.kind).toBe('virtual');
    expect(sub.spec.parent).toBe(GI0);
    expect(sub.role).toBe('subif');
    expect(sub.mac).toBe(gi.mac);
    expect(sub.ordinal).toBe(gi.ordinal);
    expect(sub.mtu).toBe(gi.mtu);
    expect(sub.adminUp).toBe(true);
    expect(sub.operUp).toBe(false);
    expect(sub.dot1q).toBeUndefined();
    expect(h.device.portsVersion).toBe(v0 + 1);
    expect(portStates(h)).toEqual([[SUB10, false, 'virtual-created']]);
    expect(h.device.running.render()).toContain(`interface ${SUB10}\n`);
    expect(h.device.running.render()).not.toContain(`interface ${SUB10}\n shutdown`);
    // found, not created, the second time; the CLI's own path gives the same answer
    expect(h.device.ensureVirtualPort(SUB10, at)).toEqual({ ok: true, port: SUB10, created: false });
    expect(h.device.resolvePortName('g0/0.10')).toEqual({ kind: 'existing', port: SUB10 });
  });

  it('a section line creates the subinterface on the way, and subinterfaces sort last by (parent, n)', () => {
    const { h } = router();
    expect(cfg(h, [['interface', SUB20]], 'description second')).toEqual({ ok: true });
    expect(cfg(h, [['interface', SUB10]], 'description first')).toEqual({ ok: true });
    expect(h.device.ensureVirtualPort('Loopback0', 5)).toMatchObject({ ok: true, created: true });
    const keys = [...h.device.ports.keys()];
    expect(keys.slice(-3)).toEqual(['Loopback0', SUB10, SUB20]);
    expect(h.device.running.render()).toContain(`interface ${SUB20}\n description second`);
  });

  it('refuses a number outside the range, a parent that cannot carry subinterfaces and a model without them', () => {
    const { h, at } = router();
    expect(h.device.ensureVirtualPort('GigabitEthernet0/0.0', at)).toEqual({ ok: false, error: 'Subinterfaces on this device are numbered 1 to 65535.' });
    expect(h.device.ensureVirtualPort('GigabitEthernet0/0.65536', at)).toEqual({ ok: false, error: 'Subinterfaces on this device are numbered 1 to 65535.' });
    expect(h.device.ensureVirtualPort('GigabitEthernet0/0.010', at)).toEqual({ ok: false, error: 'This device cannot create an interface called GigabitEthernet0/0.010.' });
    expect(cfg(h, [], 'interface GigabitEthernet0/9.10')).toEqual({ ok: false, error: 'This device cannot create an interface called GigabitEthernet0/9.10.' });
    // a subinterface of a virtual port is never a subinterface
    expect(cfg(h, [], 'interface Loopback0.1')).toEqual({ ok: false, error: 'This device cannot create an interface called Loopback0.1.' });
    expect(VIRTUAL_PORT_MESSAGES.subinterfaceOutOfRange).toBe('Subinterfaces on this device are numbered 1 to {max}.');
  });
});

describe('encapsulation dot1Q (§3.4 step 2)', () => {
  it('sets dot1q on a subinterface, brings it up while the parent is up, and stores the line', () => {
    const { h, at } = router();
    cfg(h, [], `interface ${SUB10}`);
    h.events.length = 0;
    expect(cfg(h, [['interface', SUB10]], 'encapsulation dot1Q 10')).toEqual({ ok: true });
    const sub = h.device.port(SUB10) as PortState;
    expect(sub.dot1q).toEqual({ vid: 10, native: false });
    expect(sub.operUp).toBe(true);
    expect(sub.lastChange).toBe(at);
    expect(h.events.map((e) => e.kind)).toEqual(['configChange', 'portState']);
    expect(portStates(h)).toEqual([[SUB10, true, undefined]]);
    expect(h.device.running.render()).toContain(`interface ${SUB10}\n encapsulation dot1Q 10`);
    // the native form and the lower-case keyword
    cfg(h, [], `interface ${SUB99}`);
    expect(cfg(h, [['interface', SUB99]], 'encapsulation dot1q 99 native')).toEqual({ ok: true });
    expect(h.device.port(SUB99)?.dot1q).toEqual({ vid: 99, native: true });
    expect(h.device.port(SUB99)?.operUp).toBe(true);
  });

  it('the no form clears the tag and takes the subinterface down with reason no-encapsulation', () => {
    const { h } = router();
    cfg(h, [['interface', SUB10]], 'encapsulation dot1Q 10');
    h.events.length = 0;
    expect(cfg(h, [['interface', SUB10]], 'encapsulation dot1Q 10', true)).toEqual({ ok: true });
    expect(h.device.port(SUB10)?.dot1q).toBeUndefined();
    expect(h.device.port(SUB10)?.operUp).toBe(false);
    expect(portStates(h)).toEqual([[SUB10, false, 'no-encapsulation']]);
    expect(h.device.running.render()).not.toContain('encapsulation dot1Q');
  });

  it('is refused on a physical port, for a VLAN a sibling carries, for bad arguments and for other encapsulations', () => {
    const { h } = router();
    cfg(h, [['interface', SUB10]], 'encapsulation dot1Q 10');
    expect(cfg(h, [['interface', GI0]], 'encapsulation dot1Q 10')).toEqual({ ok: false, error: '% 802.1Q encapsulation belongs on a subinterface such as GigabitEthernet0/0.10.' });
    expect(cfg(h, [['interface', SUB20]], 'encapsulation dot1Q 10')).toEqual({ ok: false, error: '% VLAN 10 is already carried by GigabitEthernet0/0.10 on this interface.' });
    expect(cfg(h, [['interface', SUB20]], 'encapsulation dot1Q 4095')).toEqual({ ok: false, error: DEVICE_CONFIG_MESSAGES.dot1qArguments });
    expect(cfg(h, [['interface', SUB20]], 'encapsulation dot1Q')).toEqual({ ok: false, error: DEVICE_CONFIG_MESSAGES.dot1qArguments });
    expect(cfg(h, [['interface', SUB20]], 'encapsulation dot1Q 20 second-dot1q')).toEqual({ ok: false, error: DEVICE_CONFIG_MESSAGES.dot1qArguments });
    expect(cfg(h, [['interface', SUB20]], 'encapsulation hdlc')).toEqual({ ok: false, error: DEVICE_CONFIG_MESSAGES.subinterfaceEncapsulation });
    expect(h.device.port(SUB20)?.dot1q).toBeUndefined();
    expect(h.device.running.render()).not.toContain(`interface ${SUB20}\n encapsulation`);
    // the same VID on another parent is fine; a serial line keeps its own encapsulation rule
    expect(cfg(h, [['interface', 'GigabitEthernet0/1.10']], 'encapsulation dot1Q 10')).toEqual({ ok: true });
    expect(cfg(h, [['interface', 'Serial0/0/0']], 'encapsulation hdlc')).toEqual({ ok: true });
    expect(cfg(h, [['interface', 'Serial0/0/0']], 'encapsulation ppp')).toEqual({ ok: false, error: DEVICE_CONFIG_MESSAGES.pppUnavailable });
    expect(CLI_MESSAGES.encapNotHere).toBe('% 802.1Q encapsulation belongs on a subinterface such as {port}.10.');
    expect(parseDot1qArgs(['dot1Q', '10'])).toEqual({ vid: 10, native: false });
    expect(parseDot1qArgs(['DOT1Q', '99', 'native'])).toEqual({ vid: 99, native: true });
    expect(parseDot1qArgs(['dot1Q', '0'])).toBeUndefined();
    expect(parseDot1qArgs(['isl', '10'])).toBeUndefined();
  });

  it('a subinterface follows its parent: down with reason parent-down, up again with it (§3.4 step 6)', () => {
    const { h, gi, at } = router();
    cfg(h, [['interface', SUB10]], 'encapsulation dot1Q 10');
    cfg(h, [['interface', SUB20]], 'encapsulation dot1Q 20');
    h.events.length = 0;
    gi.operUp = false;
    h.device.onPortOper(GI0, false, at + 1);
    expect(portStates(h)).toEqual([[SUB10, false, 'parent-down'], [SUB20, false, 'parent-down']]);
    h.events.length = 0;
    gi.operUp = true;
    h.device.onPortOper(GI0, true, at + 2);
    expect(portStates(h)).toEqual([[SUB10, true, undefined], [SUB20, true, undefined]]);
  });
});

describe('subif ingress (§3.0 step 10a, §3.4 step 3)', () => {
  it('pops a tagged frame at the subinterface that carries its VLAN, stamped with the device and the encapsulation line', () => {
    const { h, seen, gi, at } = router();
    cfg(h, [['interface', SUB10]], 'encapsulation dot1Q 10');
    const sub = h.device.port(SUB10) as PortState;
    h.events.length = 0;
    const pdu = frame(h, 10);
    const taggedSize = pdu.size;
    h.device.onFrameArrival(GI0, pdu, false, at);

    expect(seen.map((s) => [s.process, s.port, s.pdu.id])).toEqual([['arp', SUB10, pdu.id]]);
    expect(pdu.layers.map((l) => l.proto)).toEqual(['ethernet', 'arp']);
    expect(reasons(pdu)).toEqual(['VlanTagPush@d_sw1', 'FcsRecompute@d_sw1', 'VlanTagPop@d_1', 'FcsRecompute@d_1']);
    expect(pdu.provenance[2]).toEqual({ at, device: 'd_1', reason: 'VlanTagPop', field: 'dot1q.vid', before: 10, after: null, cause: 'encapsulation dot1Q 10' });
    expect(dot1qCause(10)).toBe('encapsulation dot1Q 10');
    // the two new provenance entries are mirrored as mutation events, after the frameRx of the parent
    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toEqual(['frameRx', 'mutation', 'mutation']);
    const mutations = h.kinds('mutation');
    expect(mutations.map((m) => [m.pdu, m.mutation.reason, m.mutation.device])).toEqual([[pdu.id, 'VlanTagPop', 'd_1'], [pdu.id, 'FcsRecompute', 'd_1']]);
    expect(h.kinds('frameRx')[0]).toMatchObject({ device: 'd_1', port: GI0 });
    // counted on the parent at arrival (step 2) and on the subinterface after the pop
    expect([gi.counters.inPackets, gi.counters.inBytes]).toEqual([1, taggedSize]);
    expect([sub.counters.inPackets, sub.counters.inBytes, sub.counters.inBroadcasts, sub.lastInput]).toEqual([1, pdu.size, 1, at]);
    expect(gi.counters.inDrops).toBe(0);
  });

  it('drops a tagged frame no subinterface carries as encapsulation-mismatch on the parent', () => {
    const { h, seen, gi, at } = router();
    cfg(h, [['interface', SUB10]], 'encapsulation dot1Q 10');
    h.events.length = 0;
    const pdu = frame(h, 30);
    h.device.onFrameArrival(GI0, pdu, false, at);
    expect(seen).toEqual([]);
    expect(h.kinds('drop')).toEqual([
      { t: at, kind: 'drop', pdu: expect.objectContaining({ id: pdu.id }), device: 'd_1', reason: 'encapsulation-mismatch', port: GI0, detail: 'tagged frame for VLAN 30; no subinterface carries it' },
    ]);
    expect(gi.counters.inDrops).toBe(1);
    expect(reasons(pdu)).toEqual(['VlanTagPush@d_sw1', 'FcsRecompute@d_sw1']);
    // a subinterface without encapsulation carries nothing either
    cfg(h, [], `interface ${SUB20}`);
    h.device.onFrameArrival(GI0, frame(h, 20), false, at + 1);
    expect(h.kinds('drop').at(-1)).toMatchObject({ reason: 'encapsulation-mismatch', detail: 'tagged frame for VLAN 20; no subinterface carries it' });
  });

  it('a shut subinterface receives nothing: a tagged frame for it is dropped port-admin-down on the subinterface, without a pop', () => {
    const { h, seen, gi, at } = router();
    cfg(h, [['interface', SUB10]], 'encapsulation dot1Q 10');
    cfg(h, [['interface', SUB10]], 'shutdown');
    const sub = h.device.port(SUB10) as PortState;
    expect([sub.adminUp, sub.operUp]).toEqual([false, false]);
    h.events.length = 0;
    const pdu = frame(h, 10);
    h.device.onFrameArrival(GI0, pdu, false, at);
    expect(seen).toEqual([]);
    expect(h.kinds('drop')).toEqual([
      { t: at, kind: 'drop', pdu: expect.objectContaining({ id: pdu.id, vlan: 10 }), device: 'd_1', reason: 'port-admin-down', port: SUB10 },
    ]);
    expect([sub.counters.inDrops, sub.counters.inPackets, gi.counters.inDrops, gi.counters.inPackets]).toEqual([1, 0, 0, 1]);
    expect(reasons(pdu)).toEqual(['VlanTagPush@d_sw1', 'FcsRecompute@d_sw1']);
    // back up: the same frame is handed over again
    cfg(h, [['interface', SUB10]], 'shutdown', true);
    h.device.onFrameArrival(GI0, frame(h, 10), false, at + 1);
    expect(seen.map((s) => s.port)).toEqual([SUB10]);
  });

  it('gives an untagged frame to the native subinterface without a pop, or to the parent itself when there is none', () => {
    const { h, seen, at } = router();
    cfg(h, [['interface', SUB10]], 'encapsulation dot1Q 10');
    const first = frame(h);
    h.device.onFrameArrival(GI0, first, false, at);
    expect(seen.map((s) => [s.port, s.pdu.id])).toEqual([[GI0, first.id]]);

    cfg(h, [['interface', SUB99]], 'encapsulation dot1Q 99 native');
    const sub99 = h.device.port(SUB99) as PortState;
    h.events.length = 0;
    const second = frame(h);
    h.device.onFrameArrival(GI0, second, false, at + 1);
    expect(seen.map((s) => [s.port, s.pdu.id])).toEqual([[GI0, first.id], [SUB99, second.id]]);
    expect(second.provenance).toEqual([]);
    expect(h.kinds('mutation')).toEqual([]);
    expect(sub99.counters.inPackets).toBe(1);
    // a frame tagged with the native VLAN is accepted there too, and popped
    const third = frame(h, 99);
    h.device.onFrameArrival(GI0, third, false, at + 2);
    expect(seen.at(-1)?.port).toBe(SUB99);
    expect(reasons(third).slice(2)).toEqual(['VlanTagPop@d_1', 'FcsRecompute@d_1']);
  });

  it('applies the MAC filter and the demux on the subinterface (its MAC is the parent MAC)', () => {
    const { h, seen, gi, at } = router();
    cfg(h, [['interface', SUB10]], 'encapsulation dot1Q 10');
    const sub = h.device.port(SUB10) as PortState;
    h.device.onFrameArrival(GI0, frame(h, 10, gi.mac), false, at);
    expect(seen.map((s) => s.port)).toEqual([SUB10]);
    h.events.length = 0;
    const other = frame(h, 10, '02:00:00:00:00:77');
    h.device.onFrameArrival(GI0, other, false, at + 1);
    expect(seen).toHaveLength(1);
    expect(h.kinds('drop')).toEqual([
      { t: at + 1, kind: 'drop', pdu: expect.objectContaining({ id: other.id }), device: 'd_1', reason: 'not-for-me', port: SUB10, detail: '02:00:00:00:00:77' },
    ]);
    expect(sub.counters.inDrops).toBe(1);
    expect(gi.counters.inDrops).toBe(0);
  });
});

describe('subif egress: the parent trait (§3.4 step 3, D11)', () => {
  it('counts on the subinterface, pushes the tag with the encapsulation line as cause and transmits on the parent', () => {
    const { h, gi, at } = router();
    cfg(h, [['interface', SUB10]], 'encapsulation dot1Q 10');
    const sub = h.device.port(SUB10) as PortState;
    h.events.length = 0;
    const pdu = h.pdus.build(arpLayers(), { born: at, origin: 'd_1' });
    const untaggedSize = pdu.size;
    h.device.applyActions('arp', [{ type: 'send', port: SUB10, pdu }], at);

    expect(h.transmits.map((t) => [t.from.port, t.pdu.id])).toEqual([[GI0, pdu.id]]);
    expect(pdu.layers.map((l) => l.proto)).toEqual(['ethernet', 'dot1q', 'arp']);
    expect(pdu.get('dot1q.vid')).toBe(10);
    expect(pdu.provenance).toEqual([
      { at, device: 'd_1', reason: 'VlanTagPush', field: 'dot1q.vid', before: null, after: 10, cause: 'encapsulation dot1Q 10' },
      expect.objectContaining({ at, device: 'd_1', reason: 'FcsRecompute', field: 'ethernet.fcs' }),
    ]);
    expect(h.kinds('mutation').map((m) => m.mutation.reason)).toEqual(['VlanTagPush', 'FcsRecompute']);
    expect([sub.counters.outPackets, sub.counters.outBytes, sub.lastOutput]).toEqual([1, untaggedSize, at]);
    expect([gi.counters.outPackets, gi.counters.outBytes]).toEqual([1, pdu.size]);
    expect(h.kinds('drop')).toEqual([]);
  });

  it('leaves the native subinterface untagged, and drops a send on one without encapsulation', () => {
    const { h, at } = router();
    cfg(h, [['interface', SUB99]], 'encapsulation dot1Q 99 native');
    const native = h.pdus.build(arpLayers(), { born: at, origin: 'd_1' });
    h.device.applyActions('arp', [{ type: 'send', port: SUB99, pdu: native }], at);
    expect(h.transmits.map((t) => t.from.port)).toEqual([GI0]);
    expect(native.layers.map((l) => l.proto)).toEqual(['ethernet', 'arp']);
    expect(native.provenance).toEqual([]);

    cfg(h, [], `interface ${SUB20}`);
    h.events.length = 0;
    const bare = h.pdus.build(arpLayers(), { born: at, origin: 'd_1' });
    h.device.applyActions('arp', [{ type: 'send', port: SUB20, pdu: bare }], at + 1);
    expect(h.transmits).toHaveLength(1);
    expect(h.kinds('drop')).toEqual([
      { t: at + 1, kind: 'drop', pdu: expect.objectContaining({ id: bare.id }), device: 'd_1', reason: 'other', port: SUB20, detail: 'no-encapsulation' },
    ]);
  });
});

describe('subif egress on a down subinterface', () => {
  it('a shut subinterface transmits nothing (port-admin-down); one whose parent is down drops link-down', () => {
    const { h, gi, at } = router();
    cfg(h, [['interface', SUB10]], 'encapsulation dot1Q 10');
    cfg(h, [['interface', SUB10]], 'shutdown');
    const sub = h.device.port(SUB10) as PortState;
    h.events.length = 0;
    const pdu = h.pdus.build(arpLayers(), { born: at, origin: 'd_1' });
    h.device.applyActions('arp', [{ type: 'send', port: SUB10, pdu }], at);
    expect(h.transmits).toEqual([]);
    expect(h.kinds('drop')).toEqual([
      { t: at, kind: 'drop', pdu: expect.objectContaining({ id: pdu.id }), device: 'd_1', reason: 'port-admin-down', port: SUB10 },
    ]);
    expect([sub.counters.outDrops, sub.counters.outPackets, gi.counters.outPackets]).toEqual([1, 0, 0]);
    expect(pdu.layers.map((l) => l.proto)).toEqual(['ethernet', 'arp']);
    expect(pdu.provenance).toEqual([]);

    cfg(h, [['interface', SUB10]], 'shutdown', true);
    gi.operUp = false;
    h.device.onPortOper(GI0, false, at + 1);
    expect([sub.adminUp, sub.operUp]).toEqual([true, false]);
    h.events.length = 0;
    const second = h.pdus.build(arpLayers(), { born: at, origin: 'd_1' });
    h.device.applyActions('arp', [{ type: 'send', port: SUB10, pdu: second }], at + 2);
    expect(h.transmits).toEqual([]);
    expect(h.kinds('drop')).toEqual([
      { t: at + 2, kind: 'drop', pdu: expect.objectContaining({ id: second.id }), device: 'd_1', reason: 'link-down', port: SUB10 },
    ]);
    expect(sub.counters.outDrops).toBe(2);
  });
});

describe('removal, power-off and the boot replay', () => {
  it('no interface removes a subinterface (its lines withdrawn first); power-off drops every subinterface', () => {
    const { h, at } = router();
    cfg(h, [['interface', SUB10]], 'encapsulation dot1Q 10');
    cfg(h, [['interface', SUB10]], 'ip address 192.168.10.1 255.255.255.0');
    cfg(h, [['interface', SUB20]], 'encapsulation dot1Q 20');
    h.events.length = 0;
    expect(cfg(h, [], `interface ${SUB10}`, true)).toEqual({ ok: true });
    expect(h.device.ports.has(SUB10)).toBe(false);
    expect(h.device.running.render()).not.toContain(SUB10);
    const changes = h.kinds('configChange').map((e) => `${e.negate ? 'no ' : ''}${e.line}`);
    expect(changes).toEqual(['no encapsulation dot1Q 10', 'no ip address 192.168.10.1 255.255.255.0', `no interface ${SUB10}`]);
    expect(h.kinds('portState').at(-1)).toMatchObject({ port: SUB10, operUp: false, reason: 'virtual-removed' });
    expect(cfg(h, [], `interface ${SUB10}`, true)).toEqual({ ok: false, error: 'There is no interface called GigabitEthernet0/0.10.' });
    expect(cfg(h, [], `interface ${GI0}`, true)).toEqual({ ok: false, error: 'GigabitEthernet0/0 is a physical interface and cannot be removed.' });

    h.device.setPower(false, at + 10);
    expect(h.device.ports.has(SUB20)).toBe(false);
    expect([...h.device.ports.keys()].some((k) => k.includes('.'))).toBe(false);
  });

  it('a saved configuration recreates the subinterfaces with their encapsulation at boot', () => {
    const text = [
      `interface ${GI0}`,
      ' no shutdown',
      `interface ${SUB10}`,
      ' encapsulation dot1Q 10',
      ' ip address 192.168.10.1 255.255.255.0',
      `interface ${SUB99}`,
      ' encapsulation dot1Q 99 native',
      '',
    ].join('\n');
    const { h } = router({ startupConfig: text });
    expect(h.device.port(SUB10)?.dot1q).toEqual({ vid: 10, native: false });
    expect(h.device.port(SUB99)?.dot1q).toEqual({ vid: 99, native: true });
    expect(h.device.port(SUB10)?.operUp).toBe(true);
    expect(h.device.port(SUB99)?.operUp).toBe(true);
    expect(h.device.running.render()).toContain(`interface ${SUB10}\n encapsulation dot1Q 10\n ip address 192.168.10.1 255.255.255.0`);
    // the same text again after a reload (the running configuration is rebuilt from NVRAM)
    h.device.saveConfig();
    const before = h.device.running.render();
    h.device.reload(1_000_000);
    h.run();
    expect(h.device.running.render()).toBe(before);
    expect(h.device.port(SUB10)?.dot1q).toEqual({ vid: 10, native: false });
    expect(h.kinds('portState').filter((e) => e.port === SUB10).map((e) => e.reason)).toContain('virtual-created');
  });
});
