import { describe, expect, it } from 'vitest';
import type { WireEvent } from '../src/contracts/capture.js';
import type { PortRole } from '../src/contracts/catalog.js';
import type { DeviceId, PortId, PortRef } from '../src/contracts/ids.js';
import { portKey } from '../src/contracts/ids.js';
import type { ArrivalVerdict, LinkModelDeps, LinkSpec, OperChanges, PortPhySettings, TxOutcome } from '../src/contracts/link.js';
import { NO_IMPAIRMENTS } from '../src/contracts/link.js';
import type { MediumEvent } from '../src/contracts/medium.js';
import type { Pdu } from '../src/contracts/pdu.js';
import { ETH_PHY_OVERHEAD } from '../src/contracts/pdu.js';
import { SPEED_100M, SPEED_10M, SPEED_1G, emptyCounters } from '../src/contracts/port.js';
import type { PortKind, PortState } from '../src/contracts/port.js';
import type { RadioPortSpec, RadioSettings } from '../src/contracts/rf.js';
import { RF } from '../src/contracts/rf.js';
import { SEC, propagationNs, serializationNs } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createRng } from '../src/core/prng.js';
import { createScheduler } from '../src/core/scheduler.js';
import { CELLULAR_UE_RADIO, WIFI5_COMPUTER_RADIO } from '../src/device/catalog/computers.js';
import { PTP5_RADIO, TOWER_RADIO } from '../src/device/catalog/radios.js';
import { AP_RADIO_24 } from '../src/device/catalog/wireless.js';
import { createLinkModel, isPlainPhy } from '../src/link/link.js';
import { defaultRadioSettings } from '../src/link/media/radio.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { arpFrame, meta } from './link.segment.harness.js';
import { testPortSpec, INERT_LINK_DEPS } from './port.fixtures.js';
import { KIND_ENCAP } from '../src/contracts/catalog.js';

// ── harness ───────────────────────────────────────────────────────────────────

interface HarnessPortSpec {
  name: PortId;
  role: PortRole;
  kind?: PortKind;
  speedBps?: number;
  radio?: RadioPortSpec;
  autoMdix?: boolean;
}

interface HarnessDevice {
  up: boolean;
  position: { x: number; y: number };
  ports: Map<PortId, PortState>;
}

/** A link facade over hand-built devices with every P0.5 dependency wired, plus a run loop that dispatches through the facade. */
function facade(seed = 9) {
  const devices = new Map<DeviceId, HarnessDevice>();
  const order: DeviceId[] = [];
  const events: TraceEvent[] = [];
  const log: string[] = [];
  const notes: { ref: PortRef; ev: MediumEvent; t: number }[] = [];
  const outcomes: { ref: PortRef; o: TxOutcome; t: number }[] = [];
  const wires: WireEvent[] = [];
  const phySettings = new Map<string, PortPhySettings>();
  const radioSettings = new Map<string, RadioSettings>();
  const scheduler = createScheduler();
  const pdus = createPduFactory();
  const hooks: { onNote?: (ref: PortRef, ev: MediumEvent, t: number) => void } = {};
  let macs = 0;

  const deps: LinkModelDeps = {
    ...INERT_LINK_DEPS,
    scheduler,
    trace: {
      emit: (ev) => {
        events.push(ev);
        log.push(`trace:${ev.kind}`);
      },
    },
    rng: createRng(seed).split('links'),
    port: (ref) => devices.get(ref.device)?.ports.get(ref.port),
    deviceUp: (id) => devices.get(id)?.up ?? false,
    pdus,
    portSettings: (ref) => phySettings.get(portKey(ref)),
    radioSettings: (ref) => radioSettings.get(portKey(ref)),
    position: (id) => devices.get(id)?.position,
    metresPerUnit: 0.25,
    onTxOutcome: (ref, o, t) => outcomes.push({ ref: { device: ref.device, port: ref.port }, o, t }),
    notify: (ref, ev, t) => {
      notes.push({ ref: { device: ref.device, port: ref.port }, ev, t });
      log.push(`notify:${portKey(ref)}:${ev.kind}`);
      hooks.onNote?.(ref, ev, t);
    },
    capture: { wants: () => true, record: (ev) => wires.push(ev) },
    devices: () => order,
    devicePorts: (id) => [...(devices.get(id)?.ports.keys() ?? [])],
  };
  const model = createLinkModel(deps);

  const addDevice = (id: DeviceId, ports: readonly HarnessPortSpec[], position = { x: 0, y: 0 }): PortRef[] => {
    const map = new Map<PortId, PortState>();
    for (const p of ports) {
      macs++;
      const state: PortState = {
        id: p.name,
        spec: testPortSpec({ name: p.name, short: p.name, kind: p.kind ?? 'ethernet', speedBps: p.speedBps ?? SPEED_1G, role: p.role }),
        mac: `02:00:00:00:${Math.floor(macs / 256).toString(16).padStart(2, '0')}:${(macs % 256).toString(16).padStart(2, '0')}`,
        adminUp: true,
        operUp: false,
        mtu: 1500,
        counters: emptyCounters(),
        l3: {},
        tx: { busyUntil: 0, queue: 0 },
        role: p.role,
        ordinal: 1,
        encap: KIND_ENCAP[p.kind ?? 'ethernet'],
      };
      if (p.radio !== undefined) state.spec.radio = p.radio;
      if (p.autoMdix !== undefined) state.spec.autoMdix = p.autoMdix;
      map.set(p.name, state);
    }
    devices.set(id, { up: true, position: { ...position }, ports: map });
    order.push(id);
    return ports.map((p) => ({ device: id, port: p.name }));
  };

  const deliveries: { t: number; to: PortRef; verdict: ArrivalVerdict }[] = [];
  const timerChanges: OperChanges = [];
  /** Dispatch every pending event up to `until` (inclusive) through the facade, then advance the clock to `until`. */
  const run = (until: number): void => {
    for (let n = 0; n < 200_000; n++) {
      const at = scheduler.peekTime();
      if (at === undefined || at > until) {
        if (scheduler.now < until) scheduler.advanceTo(until);
        return;
      }
      const ev = scheduler.next();
      if (!ev) return;
      if (ev.kind === 'frameArrival') {
        deliveries.push({ t: ev.at, to: { device: ev.device, port: ev.port }, verdict: model.admit(ev, ev.at) });
      } else if (ev.kind === 'txComplete') {
        model.onTxComplete({ device: ev.device, port: ev.port }, ev.at);
      } else if (ev.kind === 'mediumTimer') {
        timerChanges.push(...model.onMediumTimer(ev.medium, ev.key, ev.at));
      }
    }
    throw new Error('the event loop did not settle');
  };

  const connect = (id: string, a: PortRef, b: PortRef, over: Partial<LinkSpec> = {}) =>
    model.add({ id, a, b, media: 'copper-straight', lengthM: 3, impairments: { ...NO_IMPAIRMENTS }, ...over }, scheduler.now);

  const port = (ref: PortRef): PortState => devices.get(ref.device)!.ports.get(ref.port)!;
  const frame = (from: PortRef, dst?: string): Pdu => pdus.build(arpFrame(port(from).mac, dst), meta());
  const clear = (): void => {
    events.length = 0;
    log.length = 0;
    notes.length = 0;
  };
  const kinds = (): string[] => events.map((e) => e.kind);

  return {
    devices, order, events, log, notes, outcomes, wires, phySettings, radioSettings, scheduler, pdus, hooks, model,
    deliveries, timerChanges, addDevice, run, connect, port, frame, clear, kinds,
  };
}

const HUB_PORTS: HarnessPortSpec[] = [0, 1, 2, 3].map((i) => ({ name: `P${i}`, role: 'repeater' as PortRole, speedBps: SPEED_10M }));
const STATION: HarnessPortSpec[] = [{ name: 'Gi0', role: 'routed' }];
const SERIAL: HarnessPortSpec[] = [{ name: 'Serial0/0/0', kind: 'serial', role: 'wan', speedBps: 2_000_000 }];
const RADIO: HarnessPortSpec[] = [{ name: 'Radio0', kind: 'radio', role: 'radio-ptp', speedBps: SPEED_1G, radio: PTP5_RADIO }];
const AUTO: PortPhySettings = { speed: 'auto', duplex: 'auto' };

// ── cables ────────────────────────────────────────────────────────────────────

describe('link facade: plain cables keep the P0 shape', () => {
  it('no phyNegotiated, no LinkState.phy, full duplex, P0 timing, carrier notified after the trace', () => {
    const h = facade();
    const [pc] = h.addDevice('d_pc1', STATION);
    const [sw] = h.addDevice('d_sw1', [{ name: 'Fa0/1', role: 'switched', speedBps: SPEED_100M, autoMdix: true }]);
    const link = h.connect('l_1', pc!, sw!);
    expect(h.kinds()).toEqual(['linkState', 'portState', 'portState']);
    expect(link.up).toBe(true);
    expect(link.negotiatedBps).toBe(SPEED_100M);
    expect(link.phy).toBeUndefined();
    expect(link.carrier).toBeUndefined();
    expect(h.port(pc!).duplex).toBe('full');
    expect(h.port(pc!).phy).toEqual({
      carrier: true, lineProtocol: true, medium: 'cable', end: { speedBps: SPEED_100M, duplex: 'full', autoneg: true, via: 'autoneg' },
    });
    expect(h.log).toEqual([
      'trace:linkState', 'trace:portState', 'trace:portState',
      `notify:${portKey(pc!)}:carrier`, `notify:${portKey(sw!)}:carrier`,
    ]);

    h.clear();
    const pdu = h.frame(pc!);
    const r = h.model.transmit(pc!, pdu, 0);
    const txEnd = serializationNs(pdu.size + ETH_PHY_OVERHEAD, SPEED_100M);
    expect(r).toEqual({ ok: true, link: 'l_1', txStart: 0, txEnd, arrive: txEnd + propagationNs(3, 0.66) });
    expect(h.events[0]).toMatchObject({ kind: 'frameTx', link: 'l_1' });
    expect(h.events[0]).not.toHaveProperty('medium');
    h.run(SEC);
    expect(h.deliveries).toEqual([{ t: txEnd + propagationNs(3, 0.66), to: sw, verdict: { deliver: true, pdu } }]);
    expect(h.wires.map((w) => [w.dir, portKey(w.port)])).toEqual([['tx', portKey(pc!)], ['rx', portKey(sw!)]]);
    expect(h.port(pc!).tx.queue).toBe(0);

    expect(h.model.linksOfDevice('d_pc1')).toEqual(['l_1']);
    expect(h.model.linksOfDevice('d_none')).toEqual([]);
    expect(h.model.media(SEC)).toEqual({ metresPerUnit: 0.25, segments: [], bss: [], cells: [], associations: [] });
    expect(h.model.onPortChanged({ device: 'd_sw1', port: 'Fa0/9' }, SEC)).toEqual([]);
  });

  it('isPlainPhy separates autonegotiated full duplex from everything else', () => {
    const full = { speedBps: SPEED_1G, duplex: 'full' as const, autoneg: true, via: 'autoneg' as const };
    expect(isPlainPhy({ a: full, b: full })).toBe(true);
    expect(isPlainPhy({ a: full, b: { ...full, via: 'parallel-detect', duplex: 'half' } })).toBe(false);
    expect(isPlainPhy({ a: full, b: { ...full, autoneg: false, via: 'forced' } })).toBe(false);
    expect(isPlainPhy({ a: full, b: full, mismatch: 'duplex' })).toBe(false);
  });
});

// ── hubs: negotiation + shared segment ───────────────────────────────────────

describe('link facade: hub cables and the shared segment', () => {
  function hubWorld() {
    const h = facade();
    const hub = h.addDevice('d_hub', HUB_PORTS);
    const [pc1] = h.addDevice('d_pc1', STATION);
    const [pc2] = h.addDevice('d_pc2', STATION);
    const [pc3] = h.addDevice('d_pc3', STATION);
    return { ...h, hub, pc1: pc1!, pc2: pc2!, pc3: pc3! };
  }

  it('negotiates 10 Mb half duplex by parallel detection and emits linkState, phyNegotiated, portState, then segmentChanged', () => {
    const h = hubWorld();
    const link = h.connect('l_1', h.pc1, h.hub[0]!);
    expect(h.kinds()).toEqual(['linkState', 'phyNegotiated', 'portState', 'portState', 'segmentChanged']);
    expect(h.events[1]).toEqual({
      t: 0, kind: 'phyNegotiated', link: 'l_1',
      a: { speedBps: SPEED_10M, duplex: 'half', autoneg: true, via: 'parallel-detect' },
      b: { speedBps: SPEED_10M, duplex: 'half', autoneg: false, via: 'fixed' },
    });
    expect(h.events[4]).toEqual({ t: 0, kind: 'segmentChanged', segment: 'seg:l_1', op: 'formed', members: [h.pc1, ...h.hub] });
    expect(link).toMatchObject({ up: true, negotiatedBps: SPEED_10M, segment: 'seg:l_1' });
    expect(link.phy?.a.via).toBe('parallel-detect');
    const p = h.port(h.pc1);
    expect(p.duplex).toBe('half');
    expect(p.speedBps).toBe(SPEED_10M);
    expect(p.phy).toMatchObject({ carrier: true, medium: 'segment', segment: 'seg:l_1', end: { duplex: 'half' } });
    // notifications only after every trace event of the change
    expect(h.log.slice(-2)).toEqual([`notify:${portKey(h.pc1)}:carrier`, `notify:${portKey(h.hub[0]!)}:carrier`]);

    h.clear();
    h.connect('l_2', h.pc2, h.hub[1]!);
    expect(h.kinds()).toEqual(['linkState', 'phyNegotiated', 'portState', 'portState', 'segmentChanged']);
    expect(h.events[4]).toMatchObject({ op: 'changed', members: [h.pc1, h.pc2, ...h.hub] });
  });

  it('a broadcast is deferred to CSMA/CD, cloned per receiver, admitted by the segment and completed through onTxComplete', () => {
    const h = hubWorld();
    h.connect('l_1', h.pc1, h.hub[0]!);
    h.connect('l_2', h.pc2, h.hub[1]!);
    h.connect('l_3', h.pc3, h.hub[2]!);
    const media = h.model.media(0);
    expect(media.segments).toHaveLength(1);
    expect(media.segments[0]!.members.map((m) => m.role)).toEqual(['station', 'station', 'station', 'repeater', 'repeater', 'repeater', 'repeater']);

    const pdu = h.frame(h.pc1);
    const r = h.model.transmit(h.pc1, pdu, 1000);
    expect(r).toEqual({ ok: true, link: 'seg:l_1', txStart: 1000, txEnd: 1000, arrive: 1000, deferred: true });
    h.run(SEC);
    expect(h.deliveries.map((d) => d.to)).toEqual([h.pc2, h.pc3]);
    for (const d of h.deliveries) {
      if (!d.verdict.deliver) throw new Error('expected delivery');
      expect(d.verdict.pdu.id).not.toBe(pdu.id);
      expect(d.verdict.pdu.meta.parent).toBe(pdu.id);
      expect(d.verdict.rx).toEqual({ medium: 'segment' });
    }
    expect(h.outcomes.filter((o) => o.o.kind === 'sent')).toEqual([
      { ref: h.pc1, o: { kind: 'sent', pdu: pdu.id, txStart: 1000, bytes: pdu.size }, t: expect.any(Number) },
    ]);
    expect(h.port(h.pc1).tx.queue).toBe(0);
    expect(h.wires.filter((w) => w.dir === 'tx').map((w) => portKey(w.port))).toEqual([portKey(h.pc1)]);
    expect(h.wires.filter((w) => w.dir === 'rx').map((w) => portKey(w.port))).toEqual([portKey(h.pc2), portKey(h.pc3)]);
  });

  it('removing a member cable emits the port events before the segment change', () => {
    const h = hubWorld();
    h.connect('l_1', h.pc1, h.hub[0]!);
    h.connect('l_2', h.pc2, h.hub[1]!);
    h.connect('l_3', h.pc3, h.hub[2]!);
    h.clear();
    const changes = h.model.remove('l_3', 5);
    expect(changes).toEqual([{ port: h.pc3, operUp: false }, { port: h.hub[2], operUp: false }]);
    expect(h.kinds()).toEqual(['linkState', 'portState', 'portState', 'segmentChanged']);
    expect(h.events[3]).toMatchObject({ op: 'changed', members: [h.pc1, h.pc2, ...h.hub] });
    expect(h.port(h.pc3).phy).toBeUndefined();
    expect(h.notes.map((n) => [portKey(n.ref), n.ev])).toEqual([
      [portKey(h.pc3), { kind: 'carrier', up: false }],
      [portKey(h.hub[2]!), { kind: 'carrier', up: false }],
    ]);
  });
});

// ── serial ────────────────────────────────────────────────────────────────────

describe('link facade: serial clocking and keepalive latches', () => {
  function serialWorld(clockRateBps?: number) {
    const h = facade();
    const [r1] = h.addDevice('d_r1', SERIAL);
    const [r2] = h.addDevice('d_r2', SERIAL);
    h.phySettings.set(portKey(r1!), clockRateBps === undefined ? { ...AUTO } : { ...AUTO, clockRateBps });
    h.phySettings.set(portKey(r2!), { ...AUTO });
    return { ...h, r1: r1!, r2: r2! };
  }

  it('without a clock rate the carrier is up and the line protocol down (no-clock); a clock rate brings the link up', () => {
    const h = serialWorld();
    const link = h.connect('l_s', h.r1, h.r2, { media: 'serial-dce', lengthM: 2 });
    expect(link).toMatchObject({ up: false, carrier: true, downReason: 'no-clock', resolvedDceEnd: 'a' });
    expect(link.negotiatedBps).toBeUndefined();
    expect(h.events).toEqual([
      { t: 0, kind: 'portState', device: 'd_r1', port: 'Serial0/0/0', adminUp: true, operUp: false, reason: 'cable-connected', carrier: true },
      { t: 0, kind: 'portState', device: 'd_r2', port: 'Serial0/0/0', adminUp: true, operUp: false, reason: 'cable-connected', carrier: true },
    ]);
    expect(h.port(h.r1).phy).toEqual({ carrier: true, lineProtocol: false, lineProtocolReason: 'no-clock', dce: true, medium: 'cable' });
    expect(h.port(h.r2).phy).toMatchObject({ dce: false, lineProtocolReason: 'no-clock' });
    expect(h.notes.map((n) => n.ev)).toEqual([{ kind: 'carrier', up: true }, { kind: 'carrier', up: true }]);
    expect(h.model.transmit(h.r1, h.frame(h.r1), 0)).toEqual({ ok: false, reason: 'link-down' });

    h.clear();
    h.phySettings.set(portKey(h.r1), { ...AUTO, clockRateBps: 64_000 });
    const changes = h.model.onPortChanged(h.r1, 1000);
    expect(changes).toEqual([{ port: h.r1, operUp: true }, { port: h.r2, operUp: true }]);
    expect(h.model.get('l_s')).toMatchObject({ up: true, negotiatedBps: 64_000 });
    expect(h.model.get('l_s')!.carrier).toBeUndefined();
    expect(h.events).toEqual([
      { t: 1000, kind: 'linkState', link: 'l_s', up: true },
      { t: 1000, kind: 'portState', device: 'd_r1', port: 'Serial0/0/0', adminUp: true, operUp: true },
      { t: 1000, kind: 'portState', device: 'd_r2', port: 'Serial0/0/0', adminUp: true, operUp: true },
    ]);
    expect(h.notes).toEqual([]); // carrier did not change
  });

  it('a keepalive latch downs only the reporting end; the report clears it and losing carrier clears it too', () => {
    const h = serialWorld(64_000);
    h.connect('l_s', h.r1, h.r2, { media: 'serial-dce', lengthM: 2 });
    expect(h.model.get('l_s')!.up).toBe(true);

    h.clear();
    expect(h.model.mediumOp(h.r2, { op: 'line-protocol', up: false, reason: 'keepalive-missed' }, 10)).toEqual([{ port: h.r2, operUp: false }]);
    expect(h.model.get('l_s')).toMatchObject({ up: false, carrier: true, downReason: 'keepalive-missed', negotiatedBps: 64_000 });
    expect(h.port(h.r1).operUp).toBe(true);
    expect(h.events).toEqual([
      { t: 10, kind: 'linkState', link: 'l_s', up: false, reason: 'keepalive-missed' },
      { t: 10, kind: 'portState', device: 'd_r2', port: 'Serial0/0/0', adminUp: true, operUp: false, reason: 'keepalive-missed', carrier: true },
    ]);
    expect(h.model.transmit(h.r2, h.frame(h.r2), 11)).toEqual({ ok: false, reason: 'link-down' });
    expect(h.model.transmit(h.r1, h.frame(h.r1), 11).ok).toBe(true);
    expect(h.model.mediumOp(h.r2, { op: 'line-protocol', up: false }, 12)).toEqual([]);

    expect(h.model.mediumOp(h.r2, { op: 'line-protocol', up: true }, 13)).toEqual([{ port: h.r2, operUp: true }]);
    expect(h.model.get('l_s')!.up).toBe(true);

    h.model.mediumOp(h.r2, { op: 'line-protocol', up: false }, 14);
    h.clear();
    expect(h.model.cut('l_s', true, 20)).toEqual([{ port: h.r1, operUp: false }]);
    expect(h.notes.map((n) => [portKey(n.ref), n.ev.kind])).toEqual([[portKey(h.r1), 'carrier'], [portKey(h.r2), 'carrier']]);
    expect(h.model.cut('l_s', false, 30)).toEqual([{ port: h.r1, operUp: true }, { port: h.r2, operUp: true }]);
    expect(h.port(h.r2).phy?.lineProtocolReason).toBeUndefined();
  });

  it('delivers notifications after the state change, and a re-entrant medium request from a notified daemon is safe', () => {
    const h = serialWorld(64_000);
    h.hooks.onNote = (ref, ev, t) => {
      if (ev.kind === 'carrier' && ev.up && ref.device === 'd_r2') h.model.mediumOp(ref, { op: 'line-protocol', up: false }, t);
    };
    h.connect('l_s', h.r1, h.r2, { media: 'serial-dce', lengthM: 2 });
    expect(h.port(h.r1).operUp).toBe(true);
    expect(h.port(h.r2).operUp).toBe(false);
    expect(h.model.get('l_s')!.downReason).toBe('keepalive-missed');
    expect(h.log).toEqual([
      'trace:linkState', 'trace:portState', 'trace:portState',
      `notify:${portKey(h.r1)}:carrier`, `notify:${portKey(h.r2)}:carrier`,
      'trace:linkState', 'trace:portState',
    ]);
  });
});

// ── PtP radio ─────────────────────────────────────────────────────────────────

describe('link facade: point-to-point radio links', () => {
  function radioWorld(bPosition = { x: 4000, y: 0 }) {
    const h = facade();
    const [a] = h.addDevice('d_ra', RADIO, { x: 0, y: 0 });
    const [b] = h.addDevice('d_rb', RADIO, bPosition);
    return { ...h, a: a!, b: b! };
  }

  it('is carried by the radio medium with an RF-derived rate and goes down on a pairing key mismatch', () => {
    const h = radioWorld();
    const link = h.connect('l_r', h.a, h.b, { media: 'radio', kind: 'radio', lengthM: 0, distanceOverrideM: 10_000 });
    expect(link).toMatchObject({ up: true, kind: 'radio', radio: { distanceM: 10_000, distanceSource: 'override', band: '5' } });
    expect(link.negotiatedBps).toBeGreaterThan(0);
    expect(link.negotiatedBps).toBeLessThanOrEqual(SPEED_1G);
    expect(link.phy).toBeUndefined();
    expect(h.port(h.a).phy).toMatchObject({ carrier: true, medium: 'radio' });

    h.clear();
    const r = h.model.transmit(h.a, h.frame(h.a), 0);
    expect(r.ok).toBe(true);
    expect(h.events.find((e) => e.kind === 'frameTx')).toMatchObject({ medium: 'radio', link: 'l_r', rateBps: link.negotiatedBps });
    h.run(SEC);
    expect(h.deliveries.map((d) => [d.to, d.verdict.deliver])).toEqual([[h.b, true]]);

    expect(h.model.radioPortView(h.a)).toMatchObject({ mode: 'ptp', band: '5', up: true, peer: h.b });

    h.radioSettings.set(portKey(h.a), { ...defaultRadioSettings(PTP5_RADIO), peerKey: 'north' });
    expect(h.model.onPortChanged(h.a, SEC)).toEqual([{ port: h.a, operUp: false }, { port: h.b, operUp: false }]);
    expect(h.model.get('l_r')!.downReason).toBe('radio-key-mismatch');
  });

  it('a move out of range starts the RF hold; its expiry takes the link down through onMediumTimer', () => {
    const h = radioWorld();
    h.connect('l_r', h.a, h.b, { media: 'radio', kind: 'radio', lengthM: 0 });
    expect(h.model.get('l_r')).toMatchObject({ up: true, radio: { distanceM: 1000, distanceSource: 'canvas' } });

    h.devices.get('d_rb')!.position = { x: 80_000, y: 0 }; // 20 km at 0.25 m/unit, beyond the 15 km cut-off
    expect(h.model.onDevicesMoved(['d_rb'], 1000)).toEqual([]);
    expect(h.model.get('l_r')!.up).toBe(true);
    h.run(1000 + RF.PTP_HOLD_NS);
    expect(h.timerChanges).toEqual([{ port: h.a, operUp: false }, { port: h.b, operUp: false }]);
    expect(h.model.get('l_r')!.downReason).toBe('out-of-range');
  });

  it('setScale validates its input and rescales every medium', () => {
    const h = radioWorld({ x: 400, y: 0 });
    h.connect('l_r', h.a, h.b, { media: 'radio', kind: 'radio', lengthM: 0 });
    expect(() => h.model.setScale(0, 0)).toThrow(RangeError);
    expect(() => h.model.setScale(Number.NaN, 0)).toThrow(RangeError);
    expect(h.model.setScale(0.5, 10)).toEqual([]);
    expect(h.model.metresPerUnit()).toBe(0.5);
    expect(h.model.media(10).metresPerUnit).toBe(0.5);
    expect(h.model.get('l_r')!.radio?.distanceM).toBe(200);
  });
});

// ── Wi-Fi ─────────────────────────────────────────────────────────────────────

describe('link facade: Wi-Fi radios', () => {
  it('routes port changes, grants, air view, data and snapshots to the air medium', () => {
    const h = facade();
    const [ap] = h.addDevice('d_ap', [{ name: 'Wlan0', kind: 'wlan', role: 'wireless-bss', speedBps: 450_000_000, radio: AP_RADIO_24 }], { x: 0, y: 0 });
    const [sta] = h.addDevice('d_sta', [{ name: 'Wlan0', kind: 'wlan', role: 'wireless-client', speedBps: 866_000_000, radio: WIFI5_COMPUTER_RADIO }], { x: 40, y: 0 });
    h.radioSettings.set(portKey(ap!), { ...defaultRadioSettings(AP_RADIO_24), ssid: 'LAB' });

    expect(h.model.onPortChanged(ap!, 0, 'boot')).toEqual([{ port: ap, operUp: true }]);
    expect(h.model.onPortChanged(sta!, 0, 'boot')).toEqual([]);
    expect(h.port(sta!).phy).toMatchObject({ carrier: true, lineProtocol: false, medium: 'air' });
    expect(h.notes.map((n) => [portKey(n.ref), n.ev])).toEqual([
      [portKey(ap!), { kind: 'carrier', up: true }],
      [portKey(sta!), { kind: 'carrier', up: true }],
    ]);

    const staMac = h.port(sta!).mac;
    expect(h.model.mediumOp(ap!, { op: 'assoc', station: staMac, state: 'associated', aid: 1 }, 1)).toEqual([]);
    expect(h.model.mediumOp(ap!, { op: 'authorize', station: staMac }, 1)).toEqual([{ port: sta, operUp: true }]);
    expect(h.model.airView('d_sta').visibleBss('Wlan0').map((b) => b.ssid)).toEqual(['LAB']);
    const media = h.model.media(1);
    expect(media.bss.map((b) => [b.id, b.up])).toEqual([[`bss:${portKey(ap!)}`, true]]);
    expect(media.associations).toHaveLength(1);
    expect(media.associations[0]).toMatchObject({ tech: 'wifi', authorized: true, station: sta });
    expect(h.model.radioPortView(ap!)).toMatchObject({ mode: 'ap', ssid: 'LAB', clients: 1 });

    const r = h.model.transmit(sta!, h.frame(sta!), 1000);
    expect(r).toMatchObject({ ok: true, link: `bss:${portKey(ap!)}` });
    h.run(1000 + SEC);
    expect(h.deliveries).toHaveLength(1);
    const d = h.deliveries[0]!;
    expect(d.to).toEqual(ap);
    if (!d.verdict.deliver) throw new Error('expected delivery');
    expect(d.verdict.pdu.layers[0]!.proto).toBe('ethernet');
    expect(d.verdict.rx).toEqual({ medium: 'air' });

    h.devices.delete('d_sta');
    h.order.splice(h.order.indexOf('d_sta'), 1);
    h.clear();
    expect(h.model.forgetDevice('d_sta', 2 * SEC)).toEqual([]);
    expect(h.model.media(2 * SEC).associations).toEqual([]);
    expect(h.notes.map((n) => [portKey(n.ref), n.ev.kind])).toEqual([[portKey(ap!), 'station-lost']]);
  });
});

// ── cellular ──────────────────────────────────────────────────────────────────

describe('link facade: cellular radios', () => {
  it('routes the attach request, the attach timer, data and snapshots to the cellular medium', () => {
    const h = facade();
    const [tower] = h.addDevice('d_tw', [{ name: 'Cellular0', kind: 'cellular', role: 'wireless-bss', speedBps: 300_000_000, radio: TOWER_RADIO }], { x: 0, y: 0 });
    const [ue] = h.addDevice('d_ph', [{ name: 'Cellular0', kind: 'cellular', role: 'cellular', speedBps: 150_000_000, radio: CELLULAR_UE_RADIO }], { x: 400, y: 0 });

    expect(h.model.onPortChanged(tower!, 0, 'boot')).toEqual([{ port: tower, operUp: true }]);
    expect(h.model.onPortChanged(ue!, 0, 'boot')).toEqual([]);
    expect(h.model.mediumOp(ue!, { op: 'cell-attach' }, 0)).toEqual([]);
    h.run(RF.CELL_ATTACH_NS);
    expect(h.timerChanges).toEqual([{ port: ue, operUp: true }]);
    expect(h.notes.map((n) => [portKey(n.ref), n.ev.kind])).toEqual([[portKey(ue!), 'cell-attached']]);

    const media = h.model.media(RF.CELL_ATTACH_NS);
    expect(media.cells).toMatchObject([{ id: `cell:${portKey(tower!)}`, up: true, ues: 1 }]);
    expect(media.associations.map((a) => [a.tech, a.state])).toEqual([['cellular', 'attached']]);
    expect(h.model.radioPortView(ue!)).toMatchObject({ mode: 'ue', state: 'attached', peer: tower, up: true });
    expect(h.model.radioPortView(tower!)).toMatchObject({ mode: 'tower', up: true, clients: 1 });

    const t = RF.CELL_ATTACH_NS + 1;
    const r = h.model.transmit(ue!, h.frame(ue!), t);
    expect(r).toMatchObject({ ok: true, link: `cell:${portKey(tower!)}` });
    h.run(t + SEC);
    expect(h.deliveries.map((d) => [d.to, d.verdict.deliver ? d.verdict.rx : undefined])).toEqual([[tower, { medium: 'cell' }]]);
  });
});
