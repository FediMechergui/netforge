/**
 * P1 W1 media: config-driven speed/duplex negotiation (ARCHITECTURE-P1 §4.9), the duplex-mismatch symptoms on the
 * shared segment (§3.5) and the collision-storm fault (§4.9 Faults, rng `fault:<id>`).
 *
 * Reference semantics: IEEE 802.3 clause 28 (autonegotiation: highest common denominator, full before half at the
 * same speed; parallel detection learns speed only, so the detecting end runs half duplex) and clause 4 (CSMA/CD:
 * only a half-duplex MAC defers and detects collisions; a collision after the slot time is a late collision).
 */
import { describe, expect, it } from 'vitest';
import type { PortRole } from '../src/contracts/catalog.js';
import { KIND_ENCAP } from '../src/contracts/catalog.js';
import type { DeviceId, PortId, PortRef } from '../src/contracts/ids.js';
import { portKey } from '../src/contracts/ids.js';
import type { ArrivalVerdict, LinkModelDeps, PortPhySettings, TxOutcome } from '../src/contracts/link.js';
import { NO_IMPAIRMENTS } from '../src/contracts/link.js';
import { CSMA } from '../src/contracts/medium.js';
import type { Pdu } from '../src/contracts/pdu.js';
import { SPEED_100M, SPEED_10G, SPEED_10M, SPEED_1G, emptyCounters } from '../src/contracts/port.js';
import type { PortState } from '../src/contracts/port.js';
import type { Rng } from '../src/contracts/rng.js';
import { SEC, propagationNs, serializationNs } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createRng } from '../src/core/prng.js';
import { createScheduler } from '../src/core/scheduler.js';
import { createLinkModel } from '../src/link/link.js';
import { stormGapBounds } from '../src/link/media/segment.js';
import { endAutonegotiates, hardwareDuplexes, negotiate, type NegotiationEnd } from '../src/link/negotiation.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';
import { hubOfThree, meta, segmentHarness } from './link.segment.harness.js';
import { INERT_LINK_DEPS, testPortSpec } from './port.fixtures.js';

const AUTO: PortPhySettings = { speed: 'auto', duplex: 'auto' };
const set = (speed: PortPhySettings['speed'], duplex: PortPhySettings['duplex']): PortPhySettings => ({ speed, duplex });

const pc = (over: Partial<NegotiationEnd> = {}): NegotiationEnd => ({
  kind: 'ethernet', role: 'routed', speedBps: SPEED_1G, speeds: [SPEED_1G, SPEED_100M, SPEED_10M], label: 'PC1 Gi0', ...over,
});
const fa = (over: Partial<NegotiationEnd> = {}): NegotiationEnd => ({
  kind: 'ethernet', role: 'switched', speedBps: SPEED_100M, speeds: [SPEED_100M, SPEED_10M], label: 'S1 Fa0/1', ...over,
});
const hub = (over: Partial<NegotiationEnd> = {}): NegotiationEnd => ({ kind: 'ethernet', role: 'repeater', speedBps: SPEED_10M, label: 'H1 P0', ...over });

// ── pure negotiation (§4.9 table) ───────────────────────────────────────────

describe('negotiation: config-driven speed and duplex (§4.9)', () => {
  it('autonegotiation stays on unless both speed and duplex are forced; repeaters and autoneg-less PHYs never negotiate', () => {
    expect(endAutonegotiates(pc())).toBe(true);
    expect(endAutonegotiates(pc({ settings: AUTO }))).toBe(true);
    expect(endAutonegotiates(pc({ settings: set(SPEED_100M, 'auto') }))).toBe(true);
    expect(endAutonegotiates(pc({ settings: set('auto', 'full') }))).toBe(true);
    expect(endAutonegotiates(pc({ settings: set(SPEED_100M, 'full') }))).toBe(false);
    expect(endAutonegotiates(pc({ autoneg: false }))).toBe(false);
    expect(endAutonegotiates(hub({ settings: AUTO }))).toBe(false);
  });

  it('half duplex exists only at 1 Gb/s and below; duplexModes restricts the hardware', () => {
    expect(hardwareDuplexes(pc(), SPEED_1G)).toEqual(['full', 'half']);
    expect(hardwareDuplexes(pc(), SPEED_10G)).toEqual(['full']);
    expect(hardwareDuplexes(pc({ duplexModes: ['full'] }), SPEED_100M)).toEqual(['full']);
    expect(hardwareDuplexes(pc({ duplexModes: ['half'] }), SPEED_100M)).toEqual(['half']);
  });

  it('both autoneg: the best common ability, highest speed first, full before half', () => {
    // A configured speed on an autonegotiating end narrows what it advertises; the result stays plain autonegotiation.
    const r = negotiate(pc(), fa({ settings: set(SPEED_10M, 'auto') }));
    expect(r).toEqual({
      ok: true, bps: SPEED_10M, shared: false,
      a: { speedBps: SPEED_10M, duplex: 'full', autoneg: true, via: 'autoneg' },
      b: { speedBps: SPEED_10M, duplex: 'full', autoneg: true, via: 'autoneg' },
    });
    // A configured half duplex (speed auto) keeps autonegotiation: both ends settle on the fastest half-duplex speed.
    const h = negotiate(pc(), fa({ settings: set('auto', 'half') }));
    expect(h.ok && [h.bps, h.a.duplex, h.b.duplex, h.a.via, h.shared, h.mismatch]).toEqual([SPEED_100M, 'half', 'half', 'autoneg', true, undefined]);
    // Nothing in common: speed-mismatch with an original explanation naming both ends.
    const none = negotiate(pc({ settings: set(SPEED_1G, 'auto') }), fa());
    expect(none.ok).toBe(false);
    if (!none.ok) {
      expect(none.code).toBe('speed-mismatch');
      expect(none.reason).toContain('PC1 Gi0');
      expect(none.reason).toContain('S1 Fa0/1');
    }
    // Unconfigured cables keep the P0 numbers exactly.
    expect(negotiate(pc({ settings: AUTO }), fa({ settings: AUTO }))).toEqual(negotiate(pc(), fa()));
  });

  it('switch forced 100/full vs PC auto: the PC parallel-detects 100 Mb/s and takes HALF duplex → duplex mismatch', () => {
    const r = negotiate(fa({ settings: set(SPEED_100M, 'full') }), pc());
    expect(r).toEqual({
      ok: true, bps: SPEED_100M, shared: true, mismatch: 'duplex',
      a: { speedBps: SPEED_100M, duplex: 'full', autoneg: false, via: 'forced' },
      b: { speedBps: SPEED_100M, duplex: 'half', autoneg: true, via: 'parallel-detect' },
    });
    // Forcing half on the switch instead: both ends half, no mismatch, still a (two-station) collision domain.
    const half = negotiate(fa({ settings: set(SPEED_100M, 'half') }), pc());
    expect(half.ok && [half.a.duplex, half.b.duplex, half.mismatch, half.shared]).toEqual(['half', 'half', undefined, true]);
  });

  it('parallel detection at 1 Gb/s and above takes FULL duplex (no mismatch against a forced full end)', () => {
    const r = negotiate(pc({ settings: set(SPEED_1G, 'full'), label: 'R1 Gi0/0' }), pc());
    expect(r).toEqual({
      ok: true, bps: SPEED_1G, shared: false,
      a: { speedBps: SPEED_1G, duplex: 'full', autoneg: false, via: 'forced' },
      b: { speedBps: SPEED_1G, duplex: 'full', autoneg: true, via: 'parallel-detect' },
    });
  });

  it('a configured duplex on the detecting end wins over the parallel-detection default', () => {
    const r = negotiate(fa({ settings: set(SPEED_100M, 'full') }), pc({ settings: set('auto', 'full') }));
    expect(r.ok && [r.b.duplex, r.b.via, r.mismatch, r.shared]).toEqual(['full', 'parallel-detect', undefined, false]);
  });

  it('the detecting end must be able to run at the forced speed', () => {
    const r = negotiate(fa({ settings: set(SPEED_100M, 'full') }), pc({ settings: set(SPEED_10M, 'auto') }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('S1 Fa0/1');
  });

  it('both forced: equal speeds, each end keeps its own duplex; unequal speeds → speed-mismatch', () => {
    const r = negotiate(fa({ settings: set(SPEED_100M, 'full') }), pc({ settings: set(SPEED_100M, 'half') }));
    expect(r.ok && [r.bps, r.a, r.b, r.mismatch, r.shared]).toEqual([
      SPEED_100M,
      { speedBps: SPEED_100M, duplex: 'full', autoneg: false, via: 'forced' },
      { speedBps: SPEED_100M, duplex: 'half', autoneg: false, via: 'forced' },
      'duplex',
      true,
    ]);
    const same = negotiate(fa({ settings: set(SPEED_100M, 'full') }), pc({ settings: set(SPEED_100M, 'full') }));
    expect(same.ok && [same.mismatch, same.shared, same.a.via, same.b.via]).toEqual([undefined, false, 'forced', 'forced']);
    const diff = negotiate(fa({ settings: set(SPEED_10M, 'full') }), pc({ settings: set(SPEED_100M, 'full') }));
    expect(diff.ok).toBe(false);
    if (!diff.ok) {
      expect(diff.code).toBe('speed-mismatch');
      expect(diff.reason).toContain('10 Mb/s');
      expect(diff.reason).toContain('100 Mb/s');
    }
  });

  it('forced values the hardware cannot use are speed-mismatch', () => {
    const tooFast = negotiate(fa({ settings: set(SPEED_1G, 'full') }), pc());
    expect(tooFast.ok).toBe(false);
    const tenGig: NegotiationEnd = { kind: 'ethernet', role: 'routed', speedBps: SPEED_10G, label: 'R4 Te0/1/0', settings: set(SPEED_10G, 'half') };
    const r = negotiate(tenGig, { ...tenGig, label: 'R5 Te0/1/0', settings: AUTO });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('half duplex');
  });

  it('a PHY without autonegotiation runs fixed at its top speed, full duplex', () => {
    const r = negotiate(fa({ autoneg: false }), pc());
    expect(r.ok && [r.a, r.b, r.mismatch]).toEqual([
      { speedBps: SPEED_100M, duplex: 'full', autoneg: false, via: 'fixed' },
      { speedBps: SPEED_100M, duplex: 'half', autoneg: true, via: 'parallel-detect' },
      'duplex',
    ]);
  });

  it('hub ports stay 10 Mb/s half whatever their config; a station forced full on a hub is mismatched', () => {
    const r = negotiate(hub({ settings: set(SPEED_100M, 'full') }), pc());
    expect(r.ok && [r.bps, r.a.via, r.a.duplex, r.b.duplex, r.b.via]).toEqual([SPEED_10M, 'fixed', 'half', 'half', 'parallel-detect']);
    const forced = negotiate(pc({ settings: set(SPEED_10M, 'full') }), hub());
    expect(forced.ok && [forced.a.duplex, forced.b.duplex, forced.mismatch, forced.shared]).toEqual(['full', 'half', 'duplex', true]);
    const fullAuto = negotiate(pc({ settings: set('auto', 'full') }), hub());
    expect(fullAuto.ok && [fullAuto.a.via, fullAuto.a.duplex, fullAuto.mismatch]).toEqual(['parallel-detect', 'full', 'duplex']);
    const fast = negotiate(pc({ settings: set(SPEED_100M, 'full') }), hub());
    expect(fast.ok).toBe(false);
    if (!fast.ok) expect(fast.reason).toMatch(/^PC1 Gi0 runs at 100 Mb\/s and H1 P0 at 10 Mb\/s/);
  });

  it('results are independent structured-clone-safe objects and deterministic', () => {
    const a = negotiate(fa({ settings: set(SPEED_100M, 'full') }), pc());
    expect(structuredClone(a)).toEqual(a);
    expect(negotiate(fa({ settings: set(SPEED_100M, 'full') }), pc())).toEqual(a);
  });
});

// ── the facade: config → negotiation → segment ──────────────────────────────

interface HPort {
  name: PortId;
  role: PortRole;
  speedBps: number;
  autoMdix?: boolean;
}

/** A link facade over hand-built devices with per-port PHY settings. */
function facade(seed = 11) {
  const devices = new Map<DeviceId, Map<PortId, PortState>>();
  const order: DeviceId[] = [];
  const events: TraceEvent[] = [];
  const outcomes: { ref: PortRef; o: TxOutcome; t: number }[] = [];
  const deliveries: { t: number; to: PortRef; verdict: ArrivalVerdict }[] = [];
  const settings = new Map<string, PortPhySettings>();
  const scheduler = createScheduler();
  const pdus = createPduFactory();
  let macs = 0;
  const deps: LinkModelDeps = {
    ...INERT_LINK_DEPS,
    scheduler,
    trace: { emit: (ev) => events.push(ev) },
    rng: createRng(seed).split('links'),
    port: (ref) => devices.get(ref.device)?.get(ref.port),
    deviceUp: (id) => devices.has(id),
    pdus,
    portSettings: (ref) => settings.get(portKey(ref)),
    onTxOutcome: (ref, o, t) => outcomes.push({ ref: { device: ref.device, port: ref.port }, o, t }),
    devices: () => order,
    devicePorts: (id) => [...(devices.get(id)?.keys() ?? [])],
  };
  const model = createLinkModel(deps);
  const addDevice = (id: DeviceId, p: HPort): PortRef => {
    macs++;
    const state: PortState = {
      id: p.name,
      spec: testPortSpec({ name: p.name, short: p.name, kind: 'ethernet', speedBps: p.speedBps, role: p.role }),
      mac: `02:00:00:00:00:${macs.toString(16).padStart(2, '0')}`,
      adminUp: true, operUp: false, mtu: 1500, counters: emptyCounters(), l3: {}, tx: { busyUntil: 0, queue: 0 },
      role: p.role, ordinal: 1, encap: KIND_ENCAP.ethernet,
    };
    if (p.autoMdix !== undefined) state.spec.autoMdix = p.autoMdix;
    devices.set(id, new Map([[p.name, state]]));
    order.push(id);
    return { device: id, port: p.name };
  };
  const run = (until: number): void => {
    for (let n = 0; n < 500_000; n++) {
      const at = scheduler.peekTime();
      if (at === undefined || at > until) {
        if (scheduler.now < until) scheduler.advanceTo(until);
        return;
      }
      const ev = scheduler.next();
      if (!ev) return;
      if (ev.kind === 'frameArrival') deliveries.push({ t: ev.at, to: { device: ev.device, port: ev.port }, verdict: model.admit(ev, ev.at) });
      else if (ev.kind === 'txComplete') model.onTxComplete({ device: ev.device, port: ev.port }, ev.at);
      else if (ev.kind === 'mediumTimer') model.onMediumTimer(ev.medium, ev.key, ev.at);
    }
    throw new Error('the event loop did not settle');
  };
  const port = (ref: PortRef): PortState => devices.get(ref.device)!.get(ref.port)!;
  /** A 1500-byte frame (well past the slot time on the wire). */
  const bigFrame = (from: PortRef): Pdu =>
    pdus.build(
      [
        { proto: 'ethernet', fields: { dst: 'ff:ff:ff:ff:ff:ff', src: port(from).mac, type: 0x88b5 } },
        { proto: 'payload', fields: { data: new Uint8Array(1486) } },
      ],
      meta(),
    );
  const ofKind = <K extends TraceEvent['kind']>(kind: K) => events.filter((e): e is Extract<TraceEvent, { kind: K }> => e.kind === kind);
  return { model, scheduler, events, outcomes, deliveries, settings, addDevice, run, port, bigFrame, ofKind };
}

describe('link facade: duplex mismatch from config (accept.p1.duplex-mismatch shape)', () => {
  const build = (seed?: number) => {
    const h = facade(seed);
    const pcRef = h.addDevice('d_pc1', { name: 'Gi0', role: 'routed', speedBps: SPEED_1G });
    const swRef = h.addDevice('d_sw1', { name: 'Fa0/1', role: 'switched', speedBps: SPEED_100M, autoMdix: true });
    h.settings.set(portKey(swRef), set(SPEED_100M, 'full'));
    h.settings.set(portKey(pcRef), AUTO);
    const link = h.model.add({ id: 'l_1', a: pcRef, b: swRef, media: 'copper-straight', lengthM: 3, impairments: { ...NO_IMPAIRMENTS } }, 0);
    return { h, pcRef, swRef, link };
  };

  /** Traffic in both directions: the switch every 200 µs, the PC every 170 µs (offset 30 µs), 40 frames each. */
  const load = (h: ReturnType<typeof facade>, pcRef: PortRef, swRef: PortRef): void => {
    const sends: { t: number; from: PortRef }[] = [];
    for (let i = 0; i < 40; i++) {
      sends.push({ t: i * 200_000, from: swRef });
      sends.push({ t: 30_000 + i * 170_000, from: pcRef });
    }
    sends.sort((x, y) => x.t - y.t || portKey(x.from).localeCompare(portKey(y.from)));
    for (const s of sends) {
      h.run(s.t);
      const r = h.model.transmit(s.from, h.bigFrame(s.from), s.t);
      expect(r.ok).toBe(true);
    }
    h.run(SEC);
  };

  it('publishes the mismatch on phyNegotiated, LinkState.phy and both PortPhy views, and forms a two-station segment', () => {
    const { h, pcRef, swRef, link } = build();
    const pcEnd = { speedBps: SPEED_100M, duplex: 'half', autoneg: true, via: 'parallel-detect' } as const;
    const swEnd = { speedBps: SPEED_100M, duplex: 'full', autoneg: false, via: 'forced' } as const;
    expect(link.up).toBe(true);
    expect(link.negotiatedBps).toBe(SPEED_100M);
    expect(link.phy).toEqual({ a: pcEnd, b: swEnd, mismatch: 'duplex' });
    expect(link.segment).toBe('seg:l_1');
    expect(h.ofKind('phyNegotiated')).toEqual([{ t: 0, kind: 'phyNegotiated', link: 'l_1', a: pcEnd, b: swEnd, mismatch: 'duplex' }]);
    expect(h.port(pcRef).duplex).toBe('half');
    expect(h.port(swRef).duplex).toBe('full');
    expect(h.port(pcRef).phy).toEqual({ carrier: true, lineProtocol: true, end: pcEnd, duplexMismatch: true, medium: 'segment', segment: 'seg:l_1' });
    expect(h.port(swRef).phy).toEqual({ carrier: true, lineProtocol: true, end: swEnd, duplexMismatch: true, medium: 'segment', segment: 'seg:l_1' });
    expect(h.ofKind('segmentChanged')).toEqual([{ t: 0, kind: 'segmentChanged', segment: 'seg:l_1', members: [pcRef, swRef], op: 'formed' }]);
    const seg = h.model.media(0).segments[0]!;
    expect(seg.members.map((m) => [m.role, m.duplex])).toEqual([['station', 'half'], ['station', 'full']]);
    expect(seg.bps).toBe(SPEED_100M);
  });

  it('under load the half end sees late collisions and drops what it received, the full end gets fragments; loss is partial', () => {
    const { h, pcRef, swRef } = build();
    load(h, pcRef, swRef);

    const mine = (ref: PortRef) => h.outcomes.filter((o) => o.ref.device === ref.device).map((o) => o.o);
    // The full-duplex end never defers and never detects: all 40 frames are sent.
    expect(mine(swRef).filter((o) => o.kind === 'sent')).toHaveLength(40);
    expect(mine(swRef).some((o) => o.kind === 'collision' || o.kind === 'deferred')).toBe(false);
    // The half-duplex end detects collisions, and they are late ones (the full end starts mid-frame).
    const pcCollisions = mine(pcRef).filter((o): o is Extract<TxOutcome, { kind: 'collision' }> => o.kind === 'collision');
    expect(pcCollisions.length).toBeGreaterThan(0);
    expect(pcCollisions.every((o) => o.late)).toBe(true);
    const pcDropped = mine(pcRef).filter((o) => o.kind === 'dropped');
    expect(pcDropped.length).toBe(pcCollisions.length);
    expect(pcDropped.every((o) => o.kind === 'dropped' && o.reason === 'late-collision')).toBe(true);
    expect(mine(pcRef).filter((o) => o.kind === 'sent').length).toBeGreaterThan(0);
    const member = h.model.media(SEC).segments[0]!.members;
    expect(member[0]!.lateCollisions).toBe(pcCollisions.length);
    expect(member[1]!.collisions).toBe(0);

    const at = (ref: PortRef) => h.deliveries.filter((d) => d.to.device === ref.device).map((d) => (d.verdict.deliver ? d.verdict.rx : undefined));
    // Full end: the half end's aborted frames arrive as fragments (runts/CRC errors at the receiver), the rest whole.
    const toSw = at(swRef);
    const fragments = toSw.filter((rx) => rx?.fragmentBytes !== undefined);
    expect(fragments.length).toBe(pcCollisions.length);
    expect(fragments.every((rx) => (rx!.fragmentBytes as number) > 0 && (rx!.fragmentBytes as number) < 1500)).toBe(true);
    expect(toSw.filter((rx) => rx?.fragmentBytes === undefined && rx?.collided !== true).length).toBeGreaterThan(0);
    // Half end: frames that arrived while it was transmitting are collided (dropped `collision`); others are clean.
    const toPc = at(pcRef);
    expect(toPc).toHaveLength(40);
    const collided = toPc.filter((rx) => rx?.collided === true).length;
    expect(collided).toBeGreaterThan(0);
    expect(collided).toBeLessThan(40);
  });

  it('auto/auto clears it: plain autoneg full duplex again, the segment dissolves, traffic stops colliding', () => {
    const { h, pcRef, swRef } = build();
    h.run(1_000);
    h.events.length = 0;
    h.settings.set(portKey(swRef), AUTO);
    h.model.onPortChanged(swRef, 1_000, 'config');
    const plain = { speedBps: SPEED_100M, duplex: 'full', autoneg: true, via: 'autoneg' } as const;
    expect(h.ofKind('phyNegotiated')).toEqual([{ t: 1_000, kind: 'phyNegotiated', link: 'l_1', a: plain, b: plain }]);
    expect(h.ofKind('segmentChanged')).toEqual([{ t: 1_000, kind: 'segmentChanged', segment: 'seg:l_1', members: [], op: 'dissolved' }]);
    const state = h.model.get('l_1')!;
    expect(state.phy).toBeUndefined();
    expect(state.segment).toBeUndefined();
    expect(h.port(pcRef).phy).toEqual({ carrier: true, lineProtocol: true, end: plain, medium: 'cable' });
    expect(h.port(swRef).duplex).toBe('full');
    // a link that stays up is not bounced
    expect(h.ofKind('linkState')).toEqual([]);

    h.outcomes.length = 0;
    const base = h.scheduler.now;
    for (let i = 0; i < 5; i++) {
      h.run(base + i * 50_000);
      const t = base + i * 50_000;
      expect(h.model.transmit(swRef, h.bigFrame(swRef), t).ok).toBe(true);
      expect(h.model.transmit(pcRef, h.bigFrame(pcRef), t).ok).toBe(true);
    }
    h.run(SEC);
    expect(h.outcomes.filter((o) => o.o.kind === 'collision')).toEqual([]);
    expect(h.model.media(SEC).segments).toEqual([]);
  });

  it('a speed mismatch between two forced ends takes the link down with speed-mismatch; fixing it brings it up', () => {
    const { h, pcRef, swRef } = build();
    h.settings.set(portKey(pcRef), set(SPEED_10M, 'full'));
    h.model.onPortChanged(pcRef, 10);
    const down = h.model.get('l_1')!;
    expect([down.up, down.downReason, down.segment]).toEqual([false, 'speed-mismatch', undefined]);
    expect(h.port(pcRef).operUp).toBe(false);
    h.settings.set(portKey(pcRef), set(SPEED_100M, 'full'));
    h.model.onPortChanged(pcRef, 20);
    const up = h.model.get('l_1')!;
    expect([up.up, up.phy?.mismatch, up.segment]).toEqual([true, undefined, undefined]);
    expect(up.phy?.a.via).toBe('forced');
    expect(h.ofKind('phyNegotiated').at(-1)).toMatchObject({ t: 20, link: 'l_1', a: { via: 'forced', duplex: 'full' }, b: { via: 'forced', duplex: 'full' } });
    expect(h.ofKind('phyNegotiated').at(-1)).not.toHaveProperty('mismatch');
  });

  it('is deterministic: the same seed gives the same trace, outcomes and deliveries', () => {
    const once = (): string => {
      const { h, pcRef, swRef } = build(5);
      load(h, pcRef, swRef);
      return JSON.stringify({ e: h.events, o: h.outcomes, d: h.deliveries.map((d) => [d.t, d.to, d.verdict.deliver && d.verdict.rx]) });
    };
    expect(once()).toBe(once());
  });
});

// ── collision storm ─────────────────────────────────────────────────────────

/** A scripted rng: `nextInt` returns the queued values in order (clamped to the range) and logs every call. */
function scripted(values: number[], log: string[]): Rng {
  const rng: Rng = {
    nextU32: () => 0,
    nextFloat: () => 0,
    nextInt(lo, hi) {
      const v = values.shift();
      if (v === undefined) throw new Error('scripted rng exhausted');
      log.push(`${lo}..${hi}`);
      return Math.min(hi, Math.max(lo, v));
    },
    chance: () => false,
    split: () => rng,
    state: () => [0, 0, 0, 0],
  };
  return rng;
}

describe('segment: collision-storm fault (rng fault:<id>)', () => {
  const PROP_1M = propagationNs(1, 0.66);
  const BYTE = 800; // one byte at 10 Mb/s
  const bigFrame = (h: ReturnType<typeof segmentHarness>, from: PortRef): Pdu =>
    h.pdus.build(
      [
        { proto: 'ethernet', fields: { dst: 'ff:ff:ff:ff:ff:ff', src: h.port(from).mac, type: 0x88b5 } },
        { proto: 'payload', fields: { data: new Uint8Array(1486) } },
      ],
      meta(),
    );

  it('gap bounds average to the configured rate', () => {
    expect(stormGapBounds(1000)).toEqual({ lo: 500_000, hi: 1_500_000 });
    expect(stormGapBounds(3)).toEqual({ lo: 166_666_666, hi: 499_999_999 });
    expect(stormGapBounds(SEC * 4)).toEqual({ lo: 1, hi: 1 });
  });

  it('bursts jam the segment: a sender is hit (late collision), a waiting station defers to the burst, draws follow the documented order', () => {
    const log: string[] = [];
    const labels: string[] = [];
    // start gap 500 µs · burst 1: 64 bytes, gap 1.5 ms · burst 2: 4 bytes, gap 500 µs (past the deadline → storm ends)
    const fault = scripted([500_000, 64, 1_500_000, 4, 500_000], log);
    const h = hubOfThree({
      stream: (label, fallback) => {
        labels.push(label);
        return label === 'fault:f_storm' ? fault : fallback();
      },
    });
    const source = h.hub[3] as PortRef; // the free hub port
    expect(h.seg.startStorm('f_storm', source, { burstsPerSec: 1000, durationNs: 2_100_000 }, 0)).toBe(true);
    expect(h.seg.storms()).toEqual(['f_storm']);

    const f1 = bigFrame(h, h.pc1);
    h.run(400_000);
    h.seg.transmit(h.pc1, f1, 400_000);
    h.run(520_000);
    const f2 = h.frame(h.pc2);
    h.seg.transmit(h.pc2, f2, 520_000);
    h.run();

    const hitPc1 = 500_000 + BYTE + PROP_1M; // one repeater crossing + the pc1 cable
    const burstEnd = 500_000 + 64 * BYTE;
    const collisions = h.ofKind('collision');
    expect(collisions).toEqual([
      { t: 500_000, kind: 'collision', segment: 'seg:l_1', stations: [source, h.pc1], pdus: [f1.id], detectAt: 500_000, jamUntil: burstEnd, late: true },
      { t: 2_000_000, kind: 'collision', segment: 'seg:l_1', stations: [source], pdus: [], detectAt: 2_000_000, jamUntil: 2_000_000 + 4 * BYTE, late: false },
    ]);
    // pc1 was 100 µs into its frame: late collision, the frame is dropped after the jam.
    const pc1 = h.outcomes.filter((o) => o.ref.device === 'd_pc1').map((o) => o.o);
    expect(pc1).toEqual([
      { kind: 'collision', pdu: f1.id, late: true, attempt: 1 },
      { kind: 'dropped', pdu: f1.id, reason: 'late-collision' },
    ]);
    expect(h.ofKind('frameAbort').filter((e) => e.from.device === 'd_pc1').every((e) => e.abortAt === hitPc1 && e.reason === 'late-collision')).toBe(true);
    // pc2 wanted to send while the burst was on the wire: it defers until the burst has passed it.
    const defer = h.ofKind('carrierDefer').find((e) => e.device === 'd_pc2');
    expect(defer).toEqual({ t: 520_000, kind: 'carrierDefer', device: 'd_pc2', port: 'Gi0', pdu: f2.id, until: burstEnd + BYTE + PROP_1M });
    expect(h.outcomes.filter((o) => o.ref.device === 'd_pc2').map((o) => o.o.kind)).toEqual(['deferred', 'sent']);
    // draws: start gap, then (length, gap) per burst — all on fault:f_storm and nowhere else
    expect(log).toEqual(['500000..1500000', '4..64', '500000..1500000', '4..64', '500000..1500000']);
    expect(labels.filter((l) => l.startsWith('fault:'))).toEqual(['fault:f_storm']);
    // the storm ended at its deadline; bursts count in the domain's collision counter
    expect(h.seg.storms()).toEqual([]);
    const snap = { metresPerUnit: 0.25, segments: [], bss: [], cells: [], associations: [] };
    h.seg.contribute?.(SEC, snap);
    expect((snap.segments as { collisions: number }[])[0]!.collisions).toBe(2);
  });

  it('the full-duplex end of a mismatch ignores bursts; the half end is hit', () => {
    const h = segmentHarness();
    const r1 = h.addStation('d_r1');
    const r2 = h.addStation('d_r2');
    h.cable('l_m', r1, r2, { duplexA: 'full', duplexB: 'half', bps: SPEED_100M });
    h.seg.rebuild(0);
    expect(h.seg.startStorm('f_x', r1, { burstsPerSec: 10_000, durationNs: 1_000_000 }, 0)).toBe(true);
    h.seg.transmit(r1, bigFrame(h, r1), 0);
    h.seg.transmit(r2, bigFrame(h, r2), 0);
    h.run();
    const kinds = (ref: PortRef) => h.outcomes.filter((o) => o.ref.device === ref.device).map((o) => o.o.kind);
    expect(kinds(r1)).toEqual(['sent']);
    const bursts = h.ofKind('collision').filter((c) => c.stations[0]!.device === 'd_r1');
    expect(bursts.length).toBeGreaterThan(0);
    expect(bursts.every((c) => c.stations.slice(1).every((s) => s.device === 'd_r2'))).toBe(true);
    expect(bursts.some((c) => c.stations.length === 2)).toBe(true);
    expect(kinds(r2)).toContain('collision');
  });

  it('refuses ports outside a collision domain and bad parameters; stopStorm cancels the pending burst', () => {
    const h = hubOfThree();
    const lone = h.addStation('d_lone');
    expect(h.seg.startStorm('f_1', lone, { burstsPerSec: 10, durationNs: SEC }, 0)).toBe(false);
    expect(h.seg.storms()).toEqual([]);
    expect(() => h.seg.startStorm('f_1', h.pc1, { burstsPerSec: 0, durationNs: SEC }, 0)).toThrow(RangeError);
    expect(() => h.seg.startStorm('f_1', h.pc1, { burstsPerSec: 10, durationNs: 1.5 }, 0)).toThrow(RangeError);
    expect(h.seg.startStorm('f_1', h.pc1, { burstsPerSec: 10, durationNs: 10 * SEC }, 0)).toBe(true);
    expect(h.scheduler.peekTime()).toBeDefined();
    expect(h.seg.stopStorm('f_1', 0)).toBe(true);
    expect(h.seg.stopStorm('f_1', 0)).toBe(false);
    h.run();
    expect(h.ofKind('collision')).toEqual([]);
  });

  it('is deterministic per seed and fault id, and bounded by its duration', () => {
    const once = (seed: number, id: string): string => {
      const h = hubOfThree({ seed });
      h.seg.startStorm(id, h.hub[3] as PortRef, { burstsPerSec: 2_000, durationNs: 20_000_000 }, 0);
      for (let i = 0; i < 20; i++) {
        h.run(i * 900_000);
        for (const st of [h.pc1, h.pc2, h.pc3]) h.seg.transmit(st, bigFrame(h, st), i * 900_000);
      }
      h.run();
      expect(h.seg.storms()).toEqual([]);
      const last = h.ofKind('collision').filter((c) => c.stations[0]!.port === 'P3').at(-1);
      expect(last!.t).toBeLessThan(20_000_000);
      expect(h.ofKind('collision').length).toBeGreaterThan(10);
      return JSON.stringify({ e: h.events, o: h.outcomes });
    };
    const a = once(3, 'f_a');
    expect(once(3, 'f_a')).toBe(a);
    expect(once(3, 'f_b')).not.toBe(a);
  });

  it('a refused storm schedules and draws nothing, so the hub trace is unchanged', () => {
    const run = (withStorm: boolean): string => {
      const h = hubOfThree({ seed: 9 });
      // a storm on another domain's port must not perturb this one: here it is refused, so nothing changes
      if (withStorm) expect(h.seg.startStorm('f_z', { device: 'd_nowhere', port: 'X' }, { burstsPerSec: 1, durationNs: SEC }, 0)).toBe(false);
      h.seg.transmit(h.pc1, h.frame(h.pc1), 0);
      h.seg.transmit(h.pc3, h.frame(h.pc3), 0);
      h.run();
      return JSON.stringify(h.events);
    };
    expect(run(true)).toBe(run(false));
    expect(CSMA.JAM_BYTES).toBeLessThan(CSMA.SLOT_BYTES);
    expect(serializationNs(CSMA.SLOT_BYTES, CSMA.REPEATER_BPS)).toBe(51_200);
  });
});

// ── through the simulation: the config lines drive negotiation ─────────────

describe('simulation: `speed` / `duplex` lines renegotiate the cable', () => {
  it('SW1 Fa0/1 `speed 100` + `duplex full` vs PC1 auto → mismatch on that cable only; `speed auto` + `duplex auto` clears it', () => {
    const sim = createSimulation({ seed: 1 });
    sim.loadTopology(twoPcsAndSwitch());
    sim.runFor(60 * SEC);
    const r = sim.configure('sw1', ['interface FastEthernet0/1', 'speed 100', 'duplex full']);
    expect(r.ok).toBe(true);
    const link = sim.link('l_pc1_sw1')!;
    expect(link.up).toBe(true);
    expect(link.phy).toEqual({
      a: { speedBps: SPEED_100M, duplex: 'half', autoneg: true, via: 'parallel-detect' },
      b: { speedBps: SPEED_100M, duplex: 'full', autoneg: false, via: 'forced' },
      mismatch: 'duplex',
    });
    expect(link.segment).toBe('seg:l_pc1_sw1');
    expect(sim.device('pc1')!.port('GigabitEthernet0')!.phy?.duplexMismatch).toBe(true);
    // the other cable is untouched
    expect(sim.link('l_pc2_sw1')!.phy).toBeUndefined();

    const clear = sim.configure('sw1', ['interface FastEthernet0/1', 'speed auto', 'duplex auto']);
    expect(clear.ok).toBe(true);
    const back = sim.link('l_pc1_sw1')!;
    expect([back.up, back.phy, back.segment, back.negotiatedBps]).toEqual([true, undefined, undefined, SPEED_100M]);
    expect(sim.snapshot().media?.segments ?? []).toEqual([]);
  });
});
