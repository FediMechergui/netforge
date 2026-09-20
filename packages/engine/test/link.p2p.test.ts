import { describe, expect, it } from 'vitest';
import type { WireEvent } from '../src/contracts/capture.js';
import type { DeviceKind } from '../src/contracts/device.js';
import type { Scheduler, SimEvent } from '../src/contracts/events.js';
import type { DeviceId, LinkId, PortId, PortRef } from '../src/contracts/ids.js';
import { portKey } from '../src/contracts/ids.js';
import type { LinkModelDeps, LinkState } from '../src/contracts/link.js';
import { MEDIA, NO_IMPAIRMENTS } from '../src/contracts/link.js';
import type { LayerView, LayerSpec, Pdu, PduMeta, ProtoName } from '../src/contracts/pdu.js';
import { ARP_OP_REQUEST, ETHERTYPE_ARP, ETH_PHY_OVERHEAD, HDLC_PROTO_KEEPALIVE } from '../src/contracts/pdu.js';
import { SPEED_1G, emptyCounters } from '../src/contracts/port.js';
import type { PortKind, PortState } from '../src/contracts/port.js';
import type { Rng } from '../src/contracts/rng.js';
import { propagationNs, serializationNs } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createRng } from '../src/core/prng.js';
import { createScheduler } from '../src/core/scheduler.js';
import { INFLIGHT_SWEEP_MIN, clearScope, compareInflight, createInflightRegistry, inflightKey } from '../src/link/inflight.js';
import { createLinkModel } from '../src/link/link.js';
import {
  OUTER_FCS_BYTES,
  OUT_OF_BAND_DETAIL,
  captureLinkTypeOf,
  corruptionWindow,
  createCableP2P,
  summarizePdu,
} from '../src/link/media/p2p.js';
import type { InflightLeg, MediumHost } from '../src/link/media/types.js';
import { createPduFactory } from '../src/pdu/factory.js';
import type { Capability } from '../src/contracts/catalog.js';
import { portStateFields, testPortSpec, INERT_LINK_DEPS } from './port.fixtures.js';

// ── helpers ───────────────────────────────────────────────────────────────────

const meta = (over: Partial<PduMeta> = {}): PduMeta => ({ born: 0, origin: 'd_a', ...over });

const arpFrame = (src = '00:1f:00:00:00:01'): LayerSpec[] => [
  { proto: 'ethernet', fields: { dst: 'ff:ff:ff:ff:ff:ff', src, type: ETHERTYPE_ARP } },
  { proto: 'arp', fields: { op: ARP_OP_REQUEST, sha: src, spa: '10.0.0.1', tha: '00:00:00:00:00:00', tpa: '10.0.0.2' } },
];

/** Capabilities of the fake device kinds (they pick the default port role and so the copper wiring, §9.2). */
const KIND_CAPS: Partial<Record<DeviceKind, readonly Capability[]>> = { pc: ['host'], router: ['routing'], switch: ['switching'], hub: ['repeater'] };

function makePort(id: PortId, kind: PortKind, speedBps: number, caps: readonly Capability[] = []): PortState {
  const spec = testPortSpec({ name: id, short: id, kind, speedBps }, caps);
  return {
    id,
    spec,
    ...portStateFields(spec),
    mac: '00:1f:00:00:00:aa',
    adminUp: true,
    operUp: false,
    mtu: 1500,
    counters: emptyCounters(),
    l3: {},
    tx: { busyUntil: 0, queue: 0 },
  };
}

/** A hand-made layer view (link codecs owned by another module are not needed for the window rules). */
function layer(proto: ProtoName, headerLength: number, length: number, trailerLength: number, fields: Record<string, number> = {}): LayerView {
  return { proto, offset: 0, length, headerLength, trailerLength, fields, fieldRanges: {} };
}

let fakeId = 10_000;
/** Minimal Pdu stand-in with a given outer layer (records corrupt calls). */
function fakePdu(outer: LayerView, over: Partial<PduMeta> = {}): Pdu & { corrupted: number[] } {
  const corrupted: number[] = [];
  const pdu = {
    id: fakeId++,
    size: outer.length,
    bytes: new Uint8Array(outer.length),
    layers: [outer],
    meta: meta(over),
    provenance: [],
    corrupted,
    topProto: () => outer.proto,
    summary: () => `${outer.proto} frame`,
    corrupt: (_ctx: unknown, off: number) => {
      corrupted.push(off);
    },
  };
  return pdu as unknown as Pdu & { corrupted: number[] };
}

/** Link-model harness (P0 shape) with a capture tap. */
function modelHarness(seed = 7) {
  const ports = new Map<string, PortState>();
  const kinds = new Map<DeviceId, DeviceKind>();
  const events: TraceEvent[] = [];
  const wires: { ev: WireEvent; bytes: Uint8Array }[] = [];
  const scheduler: Scheduler = createScheduler();
  const deps: LinkModelDeps = {
    ...INERT_LINK_DEPS,
    scheduler,
    trace: { emit: (ev) => events.push(ev) },
    rng: createRng(seed).split('links'),
    port: (ref) => ports.get(portKey(ref)),
    deviceUp: (id) => kinds.has(id),
    hostTerminal: (id) => kinds.get(id) === 'pc',
    capture: {
      wants: (ref) => ref.device !== 'd_quiet',
      record: (ev) => wires.push({ ev, bytes: ev.pdu.bytes.slice() }),
    },
  };
  const add = (device: DeviceId, kind: DeviceKind, port: PortId, portKind: PortKind, speed = SPEED_1G): PortRef => {
    kinds.set(device, kind);
    const p = makePort(port, portKind, speed, KIND_CAPS[kind] ?? []);
    ports.set(portKey({ device, port }), p);
    return { device, port };
  };
  const drain = (): SimEvent[] => {
    const out: SimEvent[] = [];
    for (let ev = scheduler.next(); ev; ev = scheduler.next()) out.push(ev);
    return out;
  };
  const model = createLinkModel(deps);
  return { ports, events, wires, scheduler, deps, model, add, drain, pdus: createPduFactory(), port: (r: PortRef) => ports.get(portKey(r))! };
}

/** A bare MediumHost over hand-written LinkStates (radio tuning, keepalive exemption). */
function hostHarness(seed = 3) {
  const ports = new Map<string, PortState>();
  const states = new Map<LinkId, LinkState>();
  const events: TraceEvent[] = [];
  const scheduler: Scheduler = createScheduler();
  const root = createRng(seed).split('links');
  const streams = new Map<string, Rng>();
  const inflight = createInflightRegistry();
  const deps: LinkModelDeps = {
    ...INERT_LINK_DEPS,
    scheduler,
    trace: { emit: (ev) => events.push(ev) },
    rng: root,
    port: (ref) => ports.get(portKey(ref)),
    deviceUp: () => true,
  };
  const host: MediumHost = {
    deps,
    inflight,
    port: (ref) => ports.get(portKey(ref)),
    deviceUp: () => true,
    link: (id) => states.get(id),
    stream(label) {
      let s = streams.get(label);
      if (!s) {
        s = root.split(label);
        streams.set(label, s);
      }
      return s;
    },
    emit: (ev) => events.push(ev),
    schedule: (at, body) => scheduler.schedule(at, body),
    cancel: (seq) => scheduler.cancel(seq),
    txOutcome: () => undefined,
    notify: () => undefined,
    capture: () => undefined,
  };
  const A: PortRef = { device: 'd_a', port: 'P0' };
  const B: PortRef = { device: 'd_b', port: 'P0' };
  const addLink = (media: LinkState['resolvedMedia'], kind: PortKind, bps: number, over: Partial<LinkState> = {}): LinkState => {
    for (const r of [A, B]) {
      const p = makePort(r.port, kind, bps);
      p.operUp = true;
      p.link = 'l_1';
      ports.set(portKey(r), p);
    }
    const s: LinkState = {
      id: 'l_1', a: A, b: B, media, resolvedMedia: media, lengthM: 10, impairments: { ...NO_IMPAIRMENTS },
      up: true, negotiatedBps: bps, ...over,
    };
    states.set('l_1', s);
    return s;
  };
  return { ports, states, events, scheduler, host, inflight, A, B, addLink, port: (r: PortRef) => ports.get(portKey(r))! };
}

// ── inflight registry ─────────────────────────────────────────────────────────

describe('link/inflight registry keyed by (pdu, link, to)', () => {
  const leg = (id: number, link: string, to: PortRef, txStart: number, arrive: number, seq?: number): InflightLeg => {
    const l: InflightLeg = {
      pdu: { id, proto: 'arp', size: 64, summary: 's' }, link, from: { device: 'd_x', port: 'P0' }, to, txStart, txEnd: txStart + 1, arrive,
    };
    if (seq !== undefined) l.arrivalSeq = seq;
    return l;
  };
  const R1 = { device: 'd_r1', port: 'P0' };
  const R2 = { device: 'd_r2', port: 'P0' };

  it('keeps one leg per receiver of the same pdu and removes only the arriving one', () => {
    const reg = createInflightRegistry();
    reg.add(leg(5, 'seg:l_1', R2, 0, 100, 1));
    reg.add(leg(5, 'seg:l_1', R1, 0, 100, 2));
    expect(reg.size()).toBe(2);
    expect(inflightKey(5, 'seg:l_1', R1)).not.toBe(inflightKey(5, 'seg:l_1', R2));
    expect(reg.remove(5, R1)?.arrivalSeq).toBe(2);
    expect(reg.remove(5, R1)).toBeUndefined();
    expect(reg.on('seg:l_1').map((l) => l.to)).toEqual([R2]);
    // re-adding the same identity replaces the entry
    reg.add(leg(5, 'seg:l_1', R2, 0, 200, 9));
    expect(reg.size()).toBe(1);
    expect(reg.on('seg:l_1')[0]!.arrive).toBe(200);
    expect(reg.delete(5, 'seg:l_1', R2)?.arrivalSeq).toBe(9);
    expect(reg.size()).toBe(0);
    expect(reg.on('seg:l_1')).toEqual([]);
  });

  it('visible orders by (txStart, pdu.id, link, portKey(to)), hides future legs and prunes arrived ones', () => {
    const reg = createInflightRegistry();
    reg.add(leg(7, 'l_2', R2, 0, 50));
    reg.add(leg(7, 'l_1', R2, 0, 50));
    reg.add(leg(7, 'l_1', R1, 0, 50, 4));
    reg.add(leg(3, 'l_9', R1, 10, 50));
    reg.add(leg(1, 'l_1', R1, 30, 60)); // not started at 20
    const at20 = reg.visible(20);
    expect(at20.map((f) => [f.pdu.id, f.link, f.to.device])).toEqual([
      [7, 'l_1', 'd_r1'],
      [7, 'l_1', 'd_r2'],
      [7, 'l_2', 'd_r2'],
      [3, 'l_9', 'd_r1'],
    ]);
    expect(at20.every((f) => !('arrivalSeq' in f))).toBe(true);
    expect(() => structuredClone(at20)).not.toThrow();
    expect([...at20].sort(compareInflight)).toEqual(at20);
    expect(reg.visible(50).map((f) => f.pdu.id)).toEqual([1]);
    expect(reg.size()).toBe(1);
  });

  it('sweep is amortized: nothing below the threshold, a full prune once reached', () => {
    const reg = createInflightRegistry();
    for (let i = 0; i < INFLIGHT_SWEEP_MIN - 1; i++) reg.add(leg(i, 'l_1', R1, 0, 5));
    reg.sweep(10);
    expect(reg.size()).toBe(INFLIGHT_SWEEP_MIN - 1);
    reg.add(leg(99_999, 'l_1', R1, 0, 50));
    reg.sweep(10);
    expect(reg.size()).toBe(1);
    expect(clearScope(reg, 'l_1')).toBe(1);
    expect(reg.size()).toBe(0);
  });
});

// ── corruption window / capture link type ────────────────────────────────────

describe('link/media/p2p corruption window by outer codec', () => {
  it('ethernet keeps the P0 window [14, size-5] (padding is corruptible, the FCS is not)', () => {
    const pdu = createPduFactory().build(arpFrame(), meta());
    expect(pdu.size).toBe(64);
    expect(corruptionWindow(pdu)).toEqual({ lo: 14, hi: 59 });
    expect(OUTER_FCS_BYTES.ethernet).toBe(4);
  });

  it('hdlc skips its 4-byte header and 2-byte FCS; dot11 its 24-byte header and 4-byte FCS', () => {
    expect(corruptionWindow({ size: 30, layers: [layer('hdlc', 4, 30, 2)] })).toEqual({ lo: 4, hi: 27 });
    expect(corruptionWindow({ size: 100, layers: [layer('dot11', 24, 100, 4)] })).toEqual({ lo: 24, hi: 95 });
    // a codec without an FCS entry uses its trailer; bare IP has none
    expect(corruptionWindow({ size: 40, layers: [layer('ipv4', 20, 40, 0)] })).toEqual({ lo: 20, hi: 39 });
    // degenerate frames keep lo <= hi
    expect(corruptionWindow({ size: 3, layers: [layer('hdlc', 4, 3, 2)] })).toEqual({ lo: 2, hi: 2 });
    expect(corruptionWindow({ size: 0, layers: [] })).toEqual({ lo: -1, hi: -1 });
  });

  it('capture link type follows the outer layer', () => {
    expect(captureLinkTypeOf({ layers: [layer('ethernet', 14, 64, 4)] })).toBe('ethernet');
    expect(captureLinkTypeOf({ layers: [layer('hdlc', 4, 30, 2)] })).toBe('c_hdlc');
    expect(captureLinkTypeOf({ layers: [layer('dot11', 24, 90, 4)] })).toBe('ieee802_11');
    expect(captureLinkTypeOf({ layers: [layer('ipv6', 40, 60, 0)] })).toBe('raw');
  });

  it('a corrupted hdlc frame is flipped inside its payload window', () => {
    const h = hostHarness(11);
    h.addLink('serial-dce', 'serial', 64_000, { impairments: { ...NO_IMPAIRMENTS, corruptPct: 100 } });
    const p2p = createCableP2P(h.host, { linkOf: () => undefined });
    for (let i = 0; i < 50; i++) {
      const pdu = fakePdu(layer('hdlc', 4, 30, 2, { protocol: 0x0800 }));
      const r = p2p.transmit(h.A, pdu, i * 1_000_000_000);
      expect(r.ok && r.corrupted).toBe(true);
      expect(pdu.corrupted.length).toBe(1);
      expect(pdu.corrupted[0]!).toBeGreaterThanOrEqual(4);
      expect(pdu.corrupted[0]!).toBeLessThanOrEqual(27);
    }
  });
});

// ── pipeline through the facade ──────────────────────────────────────────────

describe('link/media/p2p through the link model', () => {
  it('serial media serialize with a 2-byte overhead', () => {
    const h = modelHarness();
    const a = h.add('d_r1', 'router', 'Serial0/0/0', 'serial', 64_000);
    const b = h.add('d_r2', 'router', 'Serial0/0/0', 'serial', 64_000);
    const s = h.model.add({ id: 'l_s', a, b, media: 'serial-dce', lengthM: 2, impairments: { ...NO_IMPAIRMENTS } }, 0);
    expect(s.up).toBe(true);
    expect(MEDIA['serial-dce'].phyOverheadBytes).toBe(2);
    const pdu = h.pdus.build(arpFrame(), meta());
    const r = h.model.transmit(a, pdu, 0);
    const txEnd = serializationNs(pdu.size + 2, 64_000);
    expect(txEnd).not.toBe(serializationNs(pdu.size + ETH_PHY_OVERHEAD, 64_000));
    expect(r).toEqual({ ok: true, link: 'l_s', txStart: 0, txEnd, arrive: txEnd + propagationNs(2, MEDIA['serial-dce'].velocityFactor) });
  });

  it('console cables refuse data frames as out-of-band, with the drop emitted and nothing scheduled', () => {
    const h = modelHarness();
    // rollover: the PC's ethernet (terminal) port to the router console line
    const a = h.add('d_pc1', 'pc', 'Gi0', 'ethernet');
    const b = h.add('d_r1', 'router', 'Console', 'console');
    const s = h.model.add({ id: 'l_c', a, b, media: 'console', lengthM: 2, impairments: { ...NO_IMPAIRMENTS } }, 0);
    expect(s.up).toBe(true);
    h.events.length = 0;
    const pdu = h.pdus.build(arpFrame(), meta());
    expect(h.model.transmit(a, pdu, 5)).toEqual({ ok: false, reason: 'out-of-band' });
    expect(h.events).toEqual([
      { t: 5, kind: 'drop', pdu: summarizePdu(pdu), device: 'd_pc1', port: 'Gi0', reason: 'out-of-band', detail: OUT_OF_BAND_DETAIL },
    ]);
    expect(h.scheduler.size).toBe(0);
    expect(h.port(a).tx.queue).toBe(0);
    expect(h.model.inflight(5)).toEqual([]);
    expect(h.wires).toEqual([]);
  });

  it('a console cable between two device console lines is refused, and the host-terminal dep marks computers', () => {
    const h = modelHarness();
    const r1 = h.add('d_r1', 'router', 'Console', 'console');
    const r2 = h.add('d_r2', 'router', 'Console', 'console');
    const v = h.model.validate(r1, r2, 'console', 2);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('both ends are device console lines');
    // a switch port is not a terminal; with the hostTerminal dep saying so, it becomes one
    const sw = h.add('d_s1', 'switch', 'Fa0/1', 'ethernet');
    expect(h.model.validate(r1, sw, 'console', 2).ok).toBe(false);
    h.deps.hostTerminal = (id) => id === 'd_s1';
    expect(h.model.validate(r1, sw, 'console', 2)).toEqual({ ok: true, resolvedMedia: 'console' });
  });

  it('captures tx before corruption and rx after it; admit-side pruning uses the receiver', () => {
    const h = modelHarness();
    const a = h.add('d_pc1', 'pc', 'Gi0', 'ethernet');
    const b = h.add('d_pc2', 'pc', 'Gi0', 'ethernet');
    h.model.add({ id: 'l_1', a, b, media: 'copper-crossover', lengthM: 1, impairments: { ...NO_IMPAIRMENTS, corruptPct: 100 } }, 0);
    const pdu = h.pdus.build(arpFrame(), meta());
    const clean = pdu.bytes.slice();
    const r = h.model.transmit(a, pdu, 0);
    expect(r.ok && r.corrupted).toBe(true);
    expect(h.wires.length).toBe(1);
    expect(h.wires[0]!.ev).toMatchObject({ t: 0, dir: 'tx', port: a, linkType: 'ethernet' });
    expect(h.wires[0]!.ev.corrupted).toBeUndefined();
    expect(h.wires[0]!.bytes).toEqual(clean);

    const arrival = h.drain().find((e) => e.kind === 'frameArrival')!;
    if (arrival.kind !== 'frameArrival') throw new Error('expected an arrival');
    // a different receiver does not remove the leg
    h.model.onFrameArrival(pdu.id, a, arrival.at);
    expect(h.model.__flyingSize()).toBe(1);

    const p2p = createCableP2P(
      {
        deps: h.deps,
        inflight: createInflightRegistry(),
        port: h.deps.port,
        deviceUp: h.deps.deviceUp,
        link: () => undefined,
        stream: (l) => h.deps.rng.split(l),
        emit: () => undefined,
        schedule: () => 0,
        cancel: () => false,
        txOutcome: () => undefined,
        notify: () => undefined,
        capture: (ev) => h.wires.push({ ev, bytes: ev.pdu.bytes.slice() }),
      },
      { linkOf: () => undefined },
    );
    const verdict = p2p.admit(arrival, arrival.at);
    expect(verdict).toEqual({ deliver: true, pdu, corrupted: true });
    expect(h.wires[1]!.ev).toMatchObject({ dir: 'rx', port: b, corrupted: true, t: arrival.at });
    expect(h.wires[1]!.bytes).not.toEqual(clean);

    h.model.onFrameArrival(pdu.id, b, arrival.at);
    expect(h.model.__flyingSize()).toBe(0);
  });

  it('no capture is recorded for a port the tap does not want', () => {
    const h = modelHarness();
    const a = h.add('d_quiet', 'pc', 'Gi0', 'ethernet');
    const b = h.add('d_pc2', 'pc', 'Gi0', 'ethernet');
    h.model.add({ id: 'l_1', a, b, media: 'copper-crossover', lengthM: 1, impairments: { ...NO_IMPAIRMENTS } }, 0);
    h.model.transmit(a, h.pdus.build(arpFrame(), meta()), 0);
    expect(h.wires).toEqual([]);
  });

  it('link down aborts legs with a link-down drop followed by a frameAbort', () => {
    const h = modelHarness();
    const a = h.add('d_pc1', 'pc', 'Gi0', 'ethernet');
    const b = h.add('d_pc2', 'pc', 'Gi0', 'ethernet');
    h.model.add({ id: 'l_1', a, b, media: 'copper-crossover', lengthM: 1, impairments: { ...NO_IMPAIRMENTS, latencyNs: 1_000_000 } }, 0);
    const pdu = h.pdus.build(arpFrame(), meta());
    const r = h.model.transmit(a, pdu, 0);
    if (!r.ok) throw new Error('expected ok');
    h.events.length = 0;
    h.model.cut('l_1', true, 100);
    const media = h.events.filter((e) => e.kind === 'drop' || e.kind === 'frameAbort');
    expect(media).toEqual([
      { t: 100, kind: 'drop', pdu: summarizePdu(pdu), link: 'l_1', reason: 'link-down', detail: 'cut' },
      { t: 100, kind: 'frameAbort', pdu: summarizePdu(pdu), link: 'l_1', from: a, to: b, abortAt: 100, arrive: r.arrive, reason: 'link-down' },
    ]);
  });

  it('background frames are flagged on frameTx and in flight', () => {
    const h = modelHarness();
    const a = h.add('d_pc1', 'pc', 'Gi0', 'ethernet');
    const b = h.add('d_pc2', 'pc', 'Gi0', 'ethernet');
    h.model.add({ id: 'l_1', a, b, media: 'copper-crossover', lengthM: 1, impairments: { ...NO_IMPAIRMENTS } }, 0);
    h.events.length = 0;
    h.model.transmit(a, h.pdus.build(arpFrame(), meta({ background: true, tag: 'keepalive' })), 0);
    expect(h.events[0]).toMatchObject({ kind: 'frameTx', background: true });
    expect(h.model.inflight(0)[0]!.background).toBe(true);
  });
});

// ── serial keepalive exemption ───────────────────────────────────────────────

describe('link/media/p2p serial line protocol gate', () => {
  const latch = (p: PortState): void => {
    p.operUp = false;
    p.phy = { carrier: true, lineProtocol: false, lineProtocolReason: 'keepalive-missed', dce: true };
  };

  it('an end down only by its keepalive latch still sends keepalives, and nothing else', () => {
    const h = hostHarness();
    h.addLink('serial-dce', 'serial', 64_000, { up: false, carrier: true, downReason: 'keepalive-missed' });
    latch(h.port(h.A));
    const p2p = createCableP2P(h.host, { linkOf: () => undefined });

    const ka = fakePdu(layer('hdlc', 4, 18, 2, { protocol: HDLC_PROTO_KEEPALIVE }), { tag: 'keepalive', background: true });
    const r = p2p.transmit(h.A, ka, 0);
    expect(r.ok).toBe(true);
    expect(h.events.at(-1)).toMatchObject({ kind: 'frameTx', background: true, to: h.B });

    h.events.length = 0;
    const data = fakePdu(layer('hdlc', 4, 40, 2, { protocol: 0x0800 }));
    expect(p2p.transmit(h.A, data, 1)).toEqual({ ok: false, reason: 'link-down' });
    expect(h.events).toEqual([
      { t: 1, kind: 'drop', pdu: summarizePdu(data), device: 'd_a', port: 'P0', reason: 'link-down', detail: 'keepalive-missed' },
    ]);

    // the peer keeps operUp and its data flows although LinkState.up is false (display only)
    const back = fakePdu(layer('hdlc', 4, 40, 2, { protocol: 0x0800 }));
    expect(p2p.transmit(h.B, back, 2).ok).toBe(true);
  });

  it('no-clock keeps keepalives blocked too', () => {
    const h = hostHarness();
    h.addLink('serial-dce', 'serial', 64_000, { up: false, carrier: true, downReason: 'no-clock', negotiatedBps: undefined });
    const pa = h.port(h.A);
    pa.operUp = false;
    pa.phy = { carrier: true, lineProtocol: false, lineProtocolReason: 'no-clock', dce: true };
    const p2p = createCableP2P(h.host, { linkOf: () => undefined });
    const ka = fakePdu(layer('hdlc', 4, 18, 2, { protocol: HDLC_PROTO_KEEPALIVE }));
    expect(p2p.transmit(h.A, ka, 0)).toEqual({ ok: false, reason: 'link-down' });
    expect(h.events[0]).toMatchObject({ kind: 'drop', reason: 'link-down', detail: 'no-clock' });
  });

  it('without carrier nothing is sent, even with a stale operUp', () => {
    const h = hostHarness();
    h.addLink('copper-crossover', 'ethernet', SPEED_1G, { up: false, downReason: 'cut' });
    const p2p = createCableP2P(h.host, { linkOf: () => undefined });
    const pdu = createPduFactory().build(arpFrame(), meta());
    expect(p2p.transmit(h.A, pdu, 0)).toEqual({ ok: false, reason: 'link-down' });
    expect(h.events[0]).toMatchObject({ detail: 'cut' });
  });

  it('an unknown port or a port without a link reports no cable', () => {
    const h = hostHarness();
    const p2p = createCableP2P(h.host, { linkOf: () => undefined });
    const pdu = createPduFactory().build(arpFrame(), meta());
    expect(p2p.transmit({ device: 'd_none', port: 'x' }, pdu, 0)).toEqual({ ok: false, reason: 'link-down' });
    expect(h.events[0]).toMatchObject({ kind: 'drop', device: 'd_none', port: 'x', detail: 'no cable' });
  });
});

// ── radio tuning ─────────────────────────────────────────────────────────────

describe('link/media/p2p radio tuning', () => {
  const outcomes = (tune: boolean, perMille: number): string => {
    const h = hostHarness(21);
    h.addLink('radio', 'radio', 100_000_000, { lengthM: 3000, impairments: { ...NO_IMPAIRMENTS, lossPct: 20, jitterNs: 900 } });
    const p2p = createCableP2P(h.host, {
      kind: 'radio',
      linkOf: () => undefined,
      tune: tune ? () => ({ perMille, velocityFactor: 1.0, medium: 'radio', rateBps: 54_000_000, rssiDbm: -61 }) : undefined,
    });
    const f = createPduFactory();
    const out: string[] = [];
    for (let i = 0; i < 60; i++) {
      const r = p2p.transmit(h.A, f.build(arpFrame(), meta()), i * 1_000_000);
      if (!r.ok) throw new Error('down');
      out.push(`${r.lost ? 'L' : '.'}${r.arrive - r.txEnd}`);
    }
    return out.join(' ');
  };

  it('PER is folded into the single loss draw: the jitter sequence is unchanged by any PER', () => {
    const jitter = (s: string): string => s.split(' ').map((t) => t.slice(1)).join(' ');
    const base = outcomes(true, 0);
    expect(jitter(outcomes(true, 400))).toBe(jitter(base));
    expect(jitter(outcomes(true, 1000))).toBe(jitter(base));
    expect(outcomes(true, 1000).split(' ').every((t) => t.startsWith('L'))).toBe(true);
    // perMille 0 draws exactly like no tuning at all (loss decisions identical)
    expect(outcomes(true, 0).split(' ').map((t) => t[0]).join('')).toBe(outcomes(false, 0).split(' ').map((t) => t[0]).join(''));
  });

  it('radio legs use velocity factor 1.0, the tuned distance and carry medium/rate/rssi', () => {
    const h = hostHarness();
    h.addLink('radio', 'radio', 100_000_000, { lengthM: 10 });
    const p2p = createCableP2P(h.host, {
      kind: 'radio',
      linkOf: () => undefined,
      tune: () => ({ lengthM: 10_000, velocityFactor: 1.0, medium: 'radio', rateBps: 54_000_000, rssiDbm: -61 }),
    });
    expect(p2p.kind).toBe('radio');
    const pdu = createPduFactory().build(arpFrame(), meta());
    const r = p2p.transmit(h.A, pdu, 0);
    if (!r.ok) throw new Error('down');
    expect(r.arrive - r.txEnd).toBe(propagationNs(10_000, 1.0));
    expect(h.events.at(-1)).toMatchObject({ kind: 'frameTx', medium: 'radio', rateBps: 54_000_000, rssiDbm: -61 });
    expect(h.inflight.visible(0)[0]).toMatchObject({ medium: 'radio', rateBps: 54_000_000 });
    // the default stream label is link:<id>
    const again = hostHarness();
    again.addLink('radio', 'radio', 100_000_000);
    expect(again.host.stream('link:l_1').nextU32()).toBe(createRng(3).split('links').split('link:l_1').nextU32());
  });

  it('onTxComplete never drops the queue below zero', () => {
    const h = hostHarness();
    h.addLink('copper-crossover', 'ethernet', SPEED_1G);
    const p2p = createCableP2P(h.host, { linkOf: () => undefined });
    p2p.transmit(h.A, createPduFactory().build(arpFrame(), meta()), 0);
    expect(h.port(h.A).tx.queue).toBe(1);
    p2p.onTxComplete?.(h.A, 1);
    p2p.onTxComplete?.(h.A, 2);
    expect(h.port(h.A).tx.queue).toBe(0);
  });
});
