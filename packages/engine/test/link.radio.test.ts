import { describe, expect, it } from 'vitest';
import type { Scheduler } from '../src/contracts/events.js';
import type { DeviceId, LinkId, PortRef } from '../src/contracts/ids.js';
import { portKey } from '../src/contracts/ids.js';
import type { LinkModelDeps, LinkState, OperChanges } from '../src/contracts/link.js';
import { NO_IMPAIRMENTS } from '../src/contracts/link.js';
import type { RadioPortSpec, RadioSettings } from '../src/contracts/rf.js';
import { RF } from '../src/contracts/rf.js';
import { emptyCounters } from '../src/contracts/port.js';
import type { PortState } from '../src/contracts/port.js';
import type { Rng } from '../src/contracts/rng.js';
import { propagationNs } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createRng } from '../src/core/prng.js';
import { createScheduler } from '../src/core/scheduler.js';
import { PTP5_RADIO, PTP60_RADIO } from '../src/device/catalog/radios.js';
import { createInflightRegistry } from '../src/link/inflight.js';
import { corruptionWindow } from '../src/link/media/p2p.js';
import { createRadioLink, defaultRadioSettings, effectiveRadio, evaluateRadioPair } from '../src/link/media/radio.js';
import type { RadioLinkVerdict } from '../src/link/media/radio.js';
import type { MediumHost } from '../src/link/media/types.js';
import { assessRfLink } from '../src/link/rf/mcs.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { arpFrame, meta } from './link.segment.harness.js';
import { testPortSpec, INERT_LINK_DEPS } from './port.fixtures.js';

const PTP5_SPEED = 866_000_000;

/** A MediumHost plus a minimal facade recompute that applies the radio verdict to LinkState and ports. */
function radioHarness(seed = 5) {
  const ports = new Map<string, PortState>();
  const links = new Map<LinkId, LinkState>();
  const order: LinkId[] = [];
  const events: TraceEvent[] = [];
  const scheduler: Scheduler = createScheduler();
  const root = createRng(seed).split('links');
  const streams = new Map<string, Rng>();
  const positions = new Map<DeviceId, { x: number; y: number }>();
  const settings = new Map<string, RadioSettings>();
  const calls: string[] = [];
  const verdicts = new Map<LinkId, RadioLinkVerdict | undefined>();
  const deps: LinkModelDeps = {
    ...INERT_LINK_DEPS,
    scheduler,
    trace: { emit: (ev) => events.push(ev) },
    rng: root,
    port: (ref) => ports.get(portKey(ref)),
    deviceUp: () => true,
    position: (id) => positions.get(id),
    radioSettings: (ref) => settings.get(portKey(ref)),
  };
  const host: MediumHost = {
    deps,
    inflight: createInflightRegistry(),
    port: (ref) => ports.get(portKey(ref)),
    deviceUp: () => true,
    link: (id) => links.get(id),
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

  const recompute = (id: LinkId, now: number, reason?: string): OperChanges => {
    calls.push(`${id}:${reason ?? ''}`);
    const state = links.get(id)!;
    const v = radio.evaluate(id, now);
    verdicts.set(id, v);
    const up = v?.up === true;
    state.up = up;
    if (up) {
      delete state.downReason;
      state.negotiatedBps = v!.negotiatedBps;
    } else {
      state.downReason = v?.downReason ?? 'power-off:a';
      delete state.negotiatedBps;
    }
    if (v) state.radio = v.view;
    const changes: OperChanges = [];
    for (const ref of [state.a, state.b]) {
      const p = ports.get(portKey(ref))!;
      if (p.operUp !== up) changes.push({ port: ref, operUp: up });
      p.operUp = up;
    }
    return changes;
  };

  const radio = createRadioLink(host, { linkOf: (ref) => ports.get(portKey(ref))?.link, links: () => order, recompute });

  const addPort = (device: DeviceId, spec: RadioPortSpec, link: LinkId): PortRef => {
    const ref = { device, port: 'Radio0' };
    ports.set(portKey(ref), {
      id: 'Radio0',
      spec: testPortSpec({ name: 'Radio0', short: 'Rd0', kind: 'radio', speedBps: PTP5_SPEED, role: 'radio-ptp', radio: spec }),
      mac: `02:00:00:00:01:${(ports.size + 1).toString(16).padStart(2, '0')}`,
      adminUp: true,
      operUp: false,
      mtu: 1500,
      counters: emptyCounters(),
      l3: {},
      tx: { busyUntil: 0, queue: 0 },
      role: 'radio-ptp',
      ordinal: 1,
      encap: 'ethernet',
      link,
    });
    return ref;
  };

  const addLink = (id: LinkId, devA: DeviceId, devB: DeviceId, specA: RadioPortSpec = PTP5_RADIO, specB: RadioPortSpec = specA, over: Partial<LinkState> = {}): LinkState => {
    const a = addPort(devA, specA, id);
    const b = addPort(devB, specB, id);
    const s: LinkState = {
      id, a, b, media: 'radio', resolvedMedia: 'radio', kind: 'radio', lengthM: 0, impairments: { ...NO_IMPAIRMENTS }, up: false, ...over,
    };
    links.set(id, s);
    order.push(id);
    return s;
  };

  return { ports, links, events, scheduler, root, host, positions, settings, calls, verdicts, radio, recompute, addLink };
}

describe('radio settings and pair evaluation', () => {
  it('defaults to the catalog band/channel, 20 MHz (2160 at 60 GHz), full power and open security', () => {
    expect(defaultRadioSettings(PTP5_RADIO)).toEqual({ band: '5', channel: 149, widthMhz: 20, txPowerDbm: 27, security: 'open' });
    expect(defaultRadioSettings(PTP60_RADIO)).toMatchObject({ band: '60', channel: 2, widthMhz: 2160 });
  });

  it('clamps unsupported bands, invalid channels, wide channels and excess power', () => {
    expect(effectiveRadio(PTP5_RADIO, { band: '2.4', channel: 11, widthMhz: 160, txPowerDbm: 40, security: 'open', peerKey: 'k' })).toEqual({
      band: '5', channel: 149, widthMhz: 80, txPowerDbm: 27, peerKey: 'k',
    });
    expect(effectiveRadio(PTP5_RADIO, { band: '5', channel: 'auto', widthMhz: 40, txPowerDbm: 10, security: 'open' })).toEqual({
      band: '5', channel: 36, widthMhz: 40, txPowerDbm: 10,
    });
  });

  it('checks band, then channel, then peer key; RF comes from link/rf with the PtP exponent', () => {
    const at = (distanceMm: number, a?: Partial<RadioSettings>, b?: Partial<RadioSettings>) =>
      evaluateRadioPair({
        a: { spec: PTP5_RADIO, settings: { ...defaultRadioSettings(PTP5_RADIO), ...a } },
        b: { spec: PTP5_RADIO, settings: { ...defaultRadioSettings(PTP5_RADIO), ...b } },
        distanceMm,
      });
    const ok = at(10_000_000, { peerKey: 'lab' }, { peerKey: 'lab' });
    expect(ok.config).toBeUndefined();
    expect(ok.canConnect).toBe(true);
    expect(ok.withinRange).toBe(true);
    const expected = assessRfLink({
      band: '5', cls: 'ptp', widthMhz: 20, distanceMm: 10_000_000,
      a: { txPowerDbm: 27, antennaGainDbi: 23, generations: ['n', 'ac'], streams: 2 },
      b: { txPowerDbm: 27, antennaGainDbi: 23, generations: ['n', 'ac'], streams: 2 },
    });
    expect(ok.rf).toEqual(expected);
    expect(ok.rf.rssiDbm).toBeGreaterThanOrEqual(RF.PTP_CONNECT_RSSI_MDB / 1000);

    expect(at(10_000_000, { peerKey: 'lab' }, { peerKey: 'other' }).config).toBe('radio-key-mismatch');
    expect(at(10_000_000, { peerKey: 'lab' }).config).toBe('radio-key-mismatch');
    expect(at(10_000_000, { channel: 153, peerKey: 'x' }, { peerKey: 'y' }).config).toBe('radio-channel-mismatch');
    const bands = evaluateRadioPair({ a: { spec: PTP5_RADIO }, b: { spec: PTP60_RADIO }, distanceMm: 100_000 });
    expect(bands.config).toBe('radio-band-mismatch');
    expect(bands.canConnect).toBe(false);
    expect(bands.belowDrop).toBe(false);

    const far60 = evaluateRadioPair({ a: { spec: PTP60_RADIO }, b: { spec: PTP60_RADIO }, distanceMm: 1_500_000 });
    expect(far60.config).toBeUndefined();
    expect(far60.withinRange).toBe(false);
    expect(far60.canConnect).toBe(false);
    expect(far60.belowDrop).toBe(true);
  });
});

describe('radio link strategy', () => {
  it('comes up at 10 km with a table-derived rate and carries it on frames with velocity factor 1.0', () => {
    const h = radioHarness();
    const s = h.addLink('l_r', 'd_a', 'd_b', PTP5_RADIO, PTP5_RADIO, { distanceOverrideM: 10_000 });
    const changes = h.recompute('l_r', 0, 'cable-connected');
    expect(changes.map((c) => c.operUp)).toEqual([true, true]);
    const v = h.verdicts.get('l_r')!;
    const pair = evaluateRadioPair({ a: { spec: PTP5_RADIO }, b: { spec: PTP5_RADIO }, distanceMm: 10_000_000 });
    expect(v).toEqual({
      up: true,
      negotiatedBps: Math.min(pair.rf.rateBps, PTP5_SPEED),
      view: {
        distanceM: 10_000, distanceSource: 'override', band: '5', channel: 149,
        rssiDbm: pair.rf.rssiDbm, snrDb: pair.rf.snrDb, rateBps: Math.min(pair.rf.rateBps, PTP5_SPEED), bars: pair.rf.bars,
      },
    });
    expect(h.events.filter((e) => e.kind === 'rfState')).toHaveLength(1);

    const pdu = createPduFactory().build(arpFrame('02:00:00:00:01:01'), meta());
    h.events.length = 0;
    const r = h.radio.transmit(s.a, pdu, 0);
    if (!r.ok) throw new Error('expected the radio link to carry the frame');
    expect(r.arrive - r.txEnd).toBe(propagationNs(10_000, 1.0));
    expect(h.events).toEqual([
      expect.objectContaining({ kind: 'frameTx', link: 'l_r', medium: 'radio', rateBps: v.negotiatedBps, rssiDbm: v.view.rssiDbm }),
    ]);
    // five draws on link:<id>, nothing else
    const ref5 = h.root.split('link:l_r');
    const { lo, hi } = corruptionWindow(pdu);
    ref5.chance(0);
    ref5.chance(0);
    ref5.nextInt(0, 0);
    ref5.nextInt(lo, hi);
    ref5.nextInt(0, 7);
    expect(h.host.stream('link:l_r').nextU32()).toBe(ref5.nextU32());
    expect(h.radio.kind).toBe('radio');
  });

  it('uses canvas distance × metresPerUnit when no override is set, and rescales', () => {
    const h = radioHarness();
    h.addLink('l_r', 'd_a', 'd_b');
    h.positions.set('d_a', { x: 0, y: 0 });
    h.positions.set('d_b', { x: 30_000, y: 40_000 }); // 50 000 units
    h.recompute('l_r', 0);
    expect(h.verdicts.get('l_r')!.view).toMatchObject({ distanceM: 12_500, distanceSource: 'canvas' });
    expect(h.radio.metresPerUnit()).toBe(0.25);
    h.calls.length = 0;
    const changes = h.radio.setScale!(0.1, 5);
    expect(h.calls).toEqual(['l_r:scale-changed']);
    expect(changes).toEqual([]);
    expect(h.verdicts.get('l_r')!.view.distanceM).toBe(5_000);
    expect(() => h.radio.setScale!(0, 5)).toThrow(RangeError);
  });

  it('refuses config mismatches at once and out-of-range links that never connected', () => {
    const h = radioHarness();
    h.addLink('l_k', 'd_a', 'd_b', PTP5_RADIO, PTP5_RADIO, { distanceOverrideM: 1_000 });
    h.settings.set('d_a/Radio0', { ...defaultRadioSettings(PTP5_RADIO), peerKey: 'one' });
    h.settings.set('d_b/Radio0', { ...defaultRadioSettings(PTP5_RADIO), peerKey: 'two' });
    h.recompute('l_k', 0);
    expect(h.verdicts.get('l_k')).toMatchObject({ up: false, downReason: 'radio-key-mismatch' });

    h.addLink('l_60', 'd_c', 'd_d', PTP60_RADIO, PTP60_RADIO, { distanceOverrideM: 1_500 });
    h.recompute('l_60', 0);
    expect(h.verdicts.get('l_60')).toMatchObject({ up: false, downReason: 'out-of-range' });
    expect(h.scheduler.size).toBe(0);

    h.addLink('l_mix', 'd_e', 'd_f', PTP5_RADIO, PTP60_RADIO, { distanceOverrideM: 100 });
    h.recompute('l_mix', 0);
    expect(h.verdicts.get('l_mix')).toMatchObject({ up: false, downReason: 'radio-band-mismatch' });
  });

  it('an out-of-range link reports no rate and no bars, but keeps RSSI/SNR for diagnosis', () => {
    const h = radioHarness();
    expect(PTP5_RADIO.maxRangeM).toBe(15_000);
    h.addLink('l_far', 'd_a', 'd_b', PTP5_RADIO, PTP5_RADIO, { distanceOverrideM: 60_000 });
    h.recompute('l_far', 0, 'cable-connected');
    const v = h.verdicts.get('l_far')!;
    expect(v.up).toBe(false);
    expect(v.downReason).toBe('out-of-range');
    expect(v.view.rateBps).toBe(0);
    expect(v.view.bars).toBe(0);
    // the RF itself is still above the connect threshold at 60 km; only the hard cut-off forbids the link
    expect(v.view.rssiDbm).toBeGreaterThan(RF.PTP_CONNECT_RSSI_MDB / 1000);
    for (const e of h.events) {
      if (e.kind === 'rfState') {
        expect(e.rateBps).toBe(0);
        expect(e.bars).toBe(0);
      }
    }
    // a configuration fault reports no usable rate either
    h.addLink('l_key', 'd_c', 'd_d', PTP5_RADIO, PTP5_RADIO, { distanceOverrideM: 1_000 });
    h.settings.set('d_c/Radio0', { ...defaultRadioSettings(PTP5_RADIO), peerKey: 'one' });
    h.settings.set('d_d/Radio0', { ...defaultRadioSettings(PTP5_RADIO), peerKey: 'two' });
    h.recompute('l_key', 0);
    expect(h.verdicts.get('l_key')).toMatchObject({ up: false, downReason: 'radio-key-mismatch', view: { rateBps: 0, bars: 0 } });
  });

  it('holds an RF drop for PTP_HOLD_NS, then goes down out-of-range', () => {
    const h = radioHarness();
    const s = h.addLink('l_r', 'd_a', 'd_b', PTP5_RADIO, PTP5_RADIO, { distanceOverrideM: 10_000 });
    h.recompute('l_r', 0);
    expect(s.up).toBe(true);

    s.distanceOverrideM = 16_000; // beyond the 15 km cut-off
    h.recompute('l_r', 1_000);
    expect(h.verdicts.get('l_r')).toMatchObject({ up: true, holdUntil: 1_000 + RF.PTP_HOLD_NS });
    expect(s.up).toBe(true);

    const timer = h.scheduler.next()!;
    expect(timer).toMatchObject({ kind: 'mediumTimer', medium: 'l_r', key: 'hold:l_r', at: 1_000 + RF.PTP_HOLD_NS });
    if (timer.kind !== 'mediumTimer') throw new Error('expected a medium timer');
    const changes = h.radio.onMediumTimer!(timer.medium, timer.key, timer.at);
    expect(h.calls.at(-1)).toBe('l_r:rf-hold-expired');
    expect(changes.map((c) => c.operUp)).toEqual([false, false]);
    expect(h.verdicts.get('l_r')).toMatchObject({ up: false, downReason: 'out-of-range' });

    // back in range: connects again straight away
    s.distanceOverrideM = 10_000;
    h.recompute('l_r', timer.at + 1);
    expect(s.up).toBe(true);
    expect(h.verdicts.get('l_r')!.holdUntil).toBeUndefined();
  });

  it('coming back above the connect threshold during the hold cancels it; a config mismatch skips the hold', () => {
    const h = radioHarness();
    const s = h.addLink('l_r', 'd_a', 'd_b', PTP5_RADIO, PTP5_RADIO, { distanceOverrideM: 10_000 });
    h.recompute('l_r', 0);
    s.distanceOverrideM = 16_000;
    h.recompute('l_r', 10);
    expect(h.scheduler.size).toBe(1);
    s.distanceOverrideM = 9_000;
    h.recompute('l_r', 20);
    expect(h.verdicts.get('l_r')).toMatchObject({ up: true });
    expect(h.verdicts.get('l_r')!.holdUntil).toBeUndefined();
    expect(h.scheduler.next()).toBeUndefined(); // the hold timer was cancelled

    h.settings.set('d_a/Radio0', { ...defaultRadioSettings(PTP5_RADIO), channel: 153 });
    h.recompute('l_r', 30);
    expect(h.verdicts.get('l_r')).toMatchObject({ up: false, downReason: 'radio-channel-mismatch' });
    expect(h.scheduler.size).toBe(0);
  });

  it('emits rfState only when bars or rate change', () => {
    const h = radioHarness();
    const s = h.addLink('l_r', 'd_a', 'd_b', PTP5_RADIO, PTP5_RADIO, { distanceOverrideM: 2_000 });
    h.recompute('l_r', 0);
    h.recompute('l_r', 1);
    const near = evaluateRadioPair({ a: { spec: PTP5_RADIO }, b: { spec: PTP5_RADIO }, distanceMm: 2_000_000 });
    const far = evaluateRadioPair({ a: { spec: PTP5_RADIO }, b: { spec: PTP5_RADIO }, distanceMm: 14_000_000 });
    expect(far.rf.bars === near.rf.bars && far.rf.rateBps === near.rf.rateBps).toBe(false);
    const rf = (): TraceEvent[] => h.events.filter((e) => e.kind === 'rfState');
    expect(rf()).toHaveLength(1);
    s.distanceOverrideM = 14_000;
    h.recompute('l_r', 2);
    expect(rf()).toHaveLength(2);
    expect(rf()[1]).toMatchObject({ t: 2, port: s.a, peer: s.b, bars: far.rf.bars, rateBps: far.rf.rateBps, rssiDbm: far.rf.rssiDbm });
  });

  it('moves re-evaluate the moved links first, then other links on the same band and channel', () => {
    const h = radioHarness();
    h.addLink('l_1', 'd_a', 'd_b', PTP5_RADIO, PTP5_RADIO, { distanceOverrideM: 1_000 });
    h.addLink('l_2', 'd_c', 'd_d', PTP5_RADIO, PTP5_RADIO, { distanceOverrideM: 1_000 });
    h.addLink('l_3', 'd_e', 'd_f', PTP5_RADIO, PTP5_RADIO, { distanceOverrideM: 1_000 });
    h.settings.set('d_e/Radio0', { ...defaultRadioSettings(PTP5_RADIO), channel: 153 });
    h.settings.set('d_f/Radio0', { ...defaultRadioSettings(PTP5_RADIO), channel: 153 });
    for (const id of ['l_1', 'l_2', 'l_3']) h.recompute(id, 0);
    h.calls.length = 0;
    h.radio.onDevicesMoved!(['d_c'], 5);
    expect(h.calls).toEqual(['l_2:device-moved', 'l_1:device-moved']);
    h.calls.length = 0;
    expect(h.radio.onDevicesMoved!(['d_zzz'], 6)).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.radio.onPortChanged!({ device: 'd_e', port: 'Radio0' }, 7, 'radio-config')).toEqual([]);
    expect(h.calls).toEqual(['l_3:radio-config']);
  });

  it('clear forgets the link and cancels a running hold', () => {
    const h = radioHarness();
    const s = h.addLink('l_r', 'd_a', 'd_b', PTP5_RADIO, PTP5_RADIO, { distanceOverrideM: 10_000 });
    h.recompute('l_r', 0);
    s.distanceOverrideM = 20_000;
    h.recompute('l_r', 1);
    expect(h.scheduler.size).toBe(1);
    h.radio.clear('l_r');
    expect(h.scheduler.next()).toBeUndefined();
    expect(h.radio.onMediumTimer!('l_r', 'hold:l_r', RF.PTP_HOLD_NS + 1)).toEqual([]);
    expect(h.radio.evaluate('l_missing', 0)).toBeUndefined();
  });
});
