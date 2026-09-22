// link/media/p2p queue cap (ARCHITECTURE-P2 D23): a P2P egress port holds at most P2P_QUEUE_LIMIT (256) frames
// whose serialization has not ended; the next is refused `queue-full` before any rng draw. The test also MEASURES
// the scheduler events per delivered frame and pins it as P2P_EVENTS_PER_FRAME (test/p2p.constants.ts), which
// accept.p2.loop-storm-bounded uses for its line-rate event bound.
import { describe, expect, it } from 'vitest';
import type { DeviceKind } from '../src/contracts/device.js';
import type { Scheduler, SimEvent } from '../src/contracts/events.js';
import type { DeviceId, LinkId, PortId, PortRef } from '../src/contracts/ids.js';
import { portKey } from '../src/contracts/ids.js';
import type { LinkModelDeps, LinkSpec, LinkState } from '../src/contracts/link.js';
import { NO_IMPAIRMENTS, P2P_QUEUE_LIMIT } from '../src/contracts/link.js';
import { ARP_OP_REQUEST, ETHERTYPE_ARP, ETH_PHY_OVERHEAD } from '../src/contracts/pdu.js';
import type { LayerSpec, Pdu, PduMeta } from '../src/contracts/pdu.js';
import { SPEED_100M, emptyCounters } from '../src/contracts/port.js';
import type { PortKind, PortState } from '../src/contracts/port.js';
import type { Rng } from '../src/contracts/rng.js';
import { serializationNs } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import type { Capability } from '../src/contracts/catalog.js';
import { createRng } from '../src/core/prng.js';
import { createScheduler } from '../src/core/scheduler.js';
import { createInflightRegistry } from '../src/link/inflight.js';
import { createLinkModel } from '../src/link/link.js';
import { createCableP2P, summarizePdu } from '../src/link/media/p2p.js';
import type { MediumHost } from '../src/link/media/types.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { INERT_LINK_DEPS, portStateFields, testPortSpec } from './port.fixtures.js';
import { P2P_EVENTS_PER_FRAME } from './p2p.constants.js';

// ── harness: two switches joined by one 100 Mb/s cable, driven by a real scheduler ──────────────────────────

const KIND_CAPS: Partial<Record<DeviceKind, readonly Capability[]>> = { pc: ['host'], switch: ['switching'] };

function makePort(id: PortId, kind: PortKind, speedBps: number, mac: string, caps: readonly Capability[]): PortState {
  const spec = testPortSpec({ name: id, short: id, kind, speedBps }, caps);
  const p: PortState = {
    id,
    spec,
    ...portStateFields(spec),
    mac,
    adminUp: true,
    operUp: false,
    mtu: 1500,
    counters: emptyCounters(),
    l3: {},
    tx: { busyUntil: 0, queue: 0 },
  };
  p.spec.autoMdix = true;
  return p;
}

const meta = (over: Partial<PduMeta> = {}): PduMeta => ({ born: 0, origin: 'd_sw1', ...over });
const arpFrame = (src = '02:00:00:00:00:01'): LayerSpec[] => [
  { proto: 'ethernet', fields: { dst: 'ff:ff:ff:ff:ff:ff', src, type: ETHERTYPE_ARP } },
  { proto: 'arp', fields: { op: ARP_OP_REQUEST, sha: src, spa: '10.0.0.1', tha: '00:00:00:00:00:00', tpa: '10.0.0.2' } },
];

/** SW1 Fa0/24 ↔ SW2 Fa0/24, 3 m, 100 Mb/s. */
function world(seed = 7, spec: Partial<LinkSpec> = {}) {
  const ports = new Map<string, PortState>();
  const events: TraceEvent[] = [];
  const scheduler: Scheduler = createScheduler();
  const add = (device: DeviceId, kind: DeviceKind, port: PortId, mac: string): PortRef => {
    ports.set(portKey({ device, port }), makePort(port, 'ethernet', SPEED_100M, mac, KIND_CAPS[kind] ?? []));
    return { device, port };
  };
  const A = add('d_sw1', 'switch', 'FastEthernet0/24', '02:00:00:00:01:18');
  const B = add('d_sw2', 'switch', 'FastEthernet0/24', '02:00:00:00:02:18');
  const deps: LinkModelDeps = {
    ...INERT_LINK_DEPS,
    scheduler,
    trace: { emit: (ev) => events.push(ev) },
    rng: createRng(seed).split('links'),
    port: (ref) => ports.get(portKey(ref)),
    deviceUp: () => true,
  };
  const model = createLinkModel(deps);
  const link = model.add({ id: 'l_1', a: A, b: B, media: 'copper-straight', lengthM: 3, impairments: { ...NO_IMPAIRMENTS }, ...spec }, 0);
  const pdus = createPduFactory();
  const port = (r: PortRef): PortState => ports.get(portKey(r))!;
  const frame = (): Pdu => pdus.build(arpFrame(), meta());
  /** Dispatch every event up to `until` through the facade, calling `onArrival` for each delivered frame. Returns the count. */
  const run = (until: number, onArrival?: (to: PortRef, pdu: Pdu, at: number) => void, onDispatch?: () => void): { events: number; delivered: number } => {
    let dispatched = 0;
    let delivered = 0;
    for (;;) {
      const at = scheduler.peekTime();
      if (at === undefined || at > until) {
        if (scheduler.now < until) scheduler.advanceTo(until);
        return { events: dispatched, delivered };
      }
      const ev = scheduler.next() as SimEvent;
      dispatched++;
      if (ev.kind === 'txComplete') model.onTxComplete({ device: ev.device, port: ev.port }, ev.at);
      else if (ev.kind === 'frameArrival') {
        const v = model.admit(ev, ev.at);
        if (v.deliver) {
          delivered++;
          onArrival?.({ device: ev.device, port: ev.port }, v.pdu, ev.at);
        }
      }
      onDispatch?.();
    }
  };
  return { ports, events, scheduler, model, link, pdus, A, B, port, frame, run };
}

/** Wire time of one ARP frame (64 bytes + preamble/IFG) at 100 Mb/s: the 6.72 µs slot of §10.1. */
const SLOT = serializationNs(64 + ETH_PHY_OVERHEAD, SPEED_100M);

const drops = (events: TraceEvent[]): Extract<TraceEvent, { kind: 'drop' }>[] =>
  events.filter((e): e is Extract<TraceEvent, { kind: 'drop' }> => e.kind === 'drop');

describe('link/media/p2p: the queue cap (D23)', () => {
  it('pins the contract limit and the 6.72 µs slot', () => {
    expect(P2P_QUEUE_LIMIT).toBe(256);
    expect(SLOT).toBe(6720);
  });

  it('accepts 256 frames at one instant and refuses the 257th queue-full, with the drop at the port and nothing scheduled', () => {
    const w = world();
    expect(w.link.up).toBe(true);
    w.events.length = 0;
    const accepted: number[] = [];
    for (let i = 0; i < P2P_QUEUE_LIMIT; i++) {
      const r = w.model.transmit(w.A, w.frame(), 0);
      if (!r.ok) throw new Error(`frame ${i} refused`);
      accepted.push(r.txEnd);
    }
    // the frames serialize back to back
    expect(accepted[0]).toBe(SLOT);
    expect(accepted[P2P_QUEUE_LIMIT - 1]).toBe(P2P_QUEUE_LIMIT * SLOT);
    expect(w.port(w.A).tx.queue).toBe(P2P_QUEUE_LIMIT);
    const scheduled = w.scheduler.size;
    expect(scheduled).toBe(2 * P2P_QUEUE_LIMIT);

    const extra = w.frame();
    expect(w.model.transmit(w.A, extra, 0)).toEqual({ ok: false, reason: 'queue-full' });
    expect(drops(w.events)).toEqual([
      { t: 0, kind: 'drop', pdu: summarizePdu(extra), device: 'd_sw1', port: 'FastEthernet0/24', reason: 'queue-full', detail: '256 frames already queued' },
    ]);
    expect(w.scheduler.size).toBe(scheduled);
    expect(w.port(w.A).tx.queue).toBe(P2P_QUEUE_LIMIT);
    expect(w.events.filter((e) => e.kind === 'frameTx')).toHaveLength(P2P_QUEUE_LIMIT);
    expect(w.model.inflight(0).some((f) => f.pdu.id === extra.id)).toBe(false);
    // the other direction has its own queue
    expect(w.model.transmit(w.B, w.frame(), 0).ok).toBe(true);
  });

  it('a frame whose serialization ends exactly now still counts; one nanosecond later there is room again', () => {
    const w = world();
    for (let i = 0; i < P2P_QUEUE_LIMIT; i++) w.model.transmit(w.A, w.frame(), 0);
    // no txComplete is dispatched here: the count follows the txEnd times, not the run loop
    expect(w.model.transmit(w.A, w.frame(), SLOT)).toEqual({ ok: false, reason: 'queue-full' });
    const r = w.model.transmit(w.A, w.frame(), SLOT + 1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.txEnd).toBe((P2P_QUEUE_LIMIT + 1) * SLOT);
    expect(w.model.transmit(w.A, w.frame(), SLOT + 1)).toEqual({ ok: false, reason: 'queue-full' });
    // after the whole backlog has left the wire, a full burst fits again
    const later = (P2P_QUEUE_LIMIT + 2) * SLOT;
    for (let i = 0; i < P2P_QUEUE_LIMIT; i++) expect(w.model.transmit(w.A, w.frame(), later).ok).toBe(true);
    expect(w.model.transmit(w.A, w.frame(), later).ok).toBe(false);
  });

  it('with the run loop dispatching, tx.queue never exceeds the limit', () => {
    const w = world();
    let max = 0;
    const watch = (): void => {
      max = Math.max(max, w.port(w.A).tx.queue);
    };
    // bursts of 300 frames every 100 slots for 2000 slots: the queue saturates and drains repeatedly
    let refused = 0;
    for (let k = 0; k < 20; k++) {
      const t = k * 100 * SLOT;
      w.run(t, undefined, watch);
      for (let i = 0; i < 300; i++) {
        if (!w.model.transmit(w.A, w.frame(), t).ok) refused++;
        watch();
      }
    }
    w.run(Number.MAX_SAFE_INTEGER, undefined, watch);
    expect(max).toBe(P2P_QUEUE_LIMIT);
    expect(refused).toBeGreaterThan(0);
    expect(drops(w.events).every((d) => d.reason === 'queue-full')).toBe(true);
    expect(drops(w.events)).toHaveLength(refused);
    expect(w.port(w.A).tx.queue).toBe(0);
  });

  it('frames paced slower than line rate never fill the queue, even when txComplete is never dispatched', () => {
    // link.model.test.ts sends 10 000 frames 10 µs apart on 100 Mb/s without a run loop: tx.queue climbs past 256
    // there, but the wire is idle between frames, so nothing is queued and nothing may be refused.
    const w = world();
    for (let i = 0; i < 1_000; i++) expect(w.model.transmit(w.A, w.frame(), i * 10_000).ok).toBe(true);
    expect(w.port(w.A).tx.queue).toBe(1_000);
    expect(drops(w.events)).toEqual([]);
  });

  it('a refused frame draws nothing: the frames after it keep the loss and jitter pattern', () => {
    const pattern = (withRefusals: boolean): string => {
      const w = world(42, { impairments: { ...NO_IMPAIRMENTS, lossPct: 30, jitterNs: 5_000 } });
      for (let i = 0; i < P2P_QUEUE_LIMIT; i++) w.model.transmit(w.A, w.frame(), 0);
      if (withRefusals) for (let i = 0; i < 100; i++) expect(w.model.transmit(w.A, w.frame(), 0).ok).toBe(false);
      const out: string[] = [];
      const t = (P2P_QUEUE_LIMIT + 1) * SLOT;
      for (let i = 0; i < 50; i++) {
        const r = w.model.transmit(w.A, w.frame(), t + i * 10 * SLOT);
        if (!r.ok) throw new Error('refused');
        out.push(`${r.lost ? 'L' : '.'}${r.arrive - r.txEnd}`);
      }
      return out.join(' ');
    };
    expect(pattern(true)).toBe(pattern(false));
  });

  it('a transmitter reset elsewhere (power-on) starts with an empty queue', () => {
    const w = world();
    for (let i = 0; i < P2P_QUEUE_LIMIT; i++) w.model.transmit(w.A, w.frame(), 0);
    expect(w.model.transmit(w.A, w.frame(), 0).ok).toBe(false);
    // a rebuilt port state (new tx object)
    w.port(w.A).tx = { busyUntil: 0, queue: 0 };
    expect(w.model.transmit(w.A, w.frame(), 0).ok).toBe(true);
    for (let i = 1; i < P2P_QUEUE_LIMIT; i++) w.model.transmit(w.A, w.frame(), 0);
    expect(w.model.transmit(w.A, w.frame(), 0).ok).toBe(false);
    // a transmitter reset in place
    w.port(w.A).tx.busyUntil = 0;
    expect(w.model.transmit(w.A, w.frame(), 0).ok).toBe(true);
  });

  it('point-to-point radio links use the same strategy and the same cap', () => {
    const ports = new Map<string, PortState>();
    const states = new Map<LinkId, LinkState>();
    const events: TraceEvent[] = [];
    const scheduler = createScheduler();
    const root = createRng(3).split('links');
    const streams = new Map<string, Rng>();
    const deps: LinkModelDeps = { ...INERT_LINK_DEPS, scheduler, trace: { emit: (ev) => events.push(ev) }, rng: root, port: (r) => ports.get(portKey(r)), deviceUp: () => true };
    const host: MediumHost = {
      deps,
      inflight: createInflightRegistry(),
      port: (r) => ports.get(portKey(r)),
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
    const A: PortRef = { device: 'd_a', port: 'Radio0' };
    const B: PortRef = { device: 'd_b', port: 'Radio0' };
    for (const r of [A, B]) {
      const p = makePort(r.port, 'ethernet', SPEED_100M, '02:00:00:00:00:aa', []);
      p.operUp = true;
      p.link = 'l_r';
      ports.set(portKey(r), p);
    }
    states.set('l_r', { id: 'l_r', a: A, b: B, media: 'copper-straight', resolvedMedia: 'copper-straight', lengthM: 10, impairments: { ...NO_IMPAIRMENTS }, up: true, negotiatedBps: SPEED_100M });
    const radio = createCableP2P(host, { kind: 'radio', linkOf: () => undefined, tune: () => ({ medium: 'radio', lengthM: 2_000, velocityFactor: 1 }) });
    const pdus = createPduFactory();
    for (let i = 0; i < P2P_QUEUE_LIMIT; i++) expect(radio.transmit(A, pdus.build(arpFrame(), meta()), 0).ok).toBe(true);
    expect(radio.transmit(A, pdus.build(arpFrame(), meta()), 0)).toEqual({ ok: false, reason: 'queue-full' });
    expect(events.filter((e) => e.kind === 'drop').map((e) => (e.kind === 'drop' ? [e.reason, e.device, e.port] : []))).toEqual([['queue-full', 'd_a', 'Radio0']]);
  });
});

describe('link/media/p2p: scheduler events per delivered frame (P2P_EVENTS_PER_FRAME)', () => {
  it('a burst: every delivered frame costs one txComplete and one frameArrival', () => {
    const w = world();
    for (let i = 0; i < 300; i++) w.model.transmit(w.A, w.frame(), 0);
    const { events, delivered } = w.run(Number.MAX_SAFE_INTEGER);
    expect(delivered).toBe(P2P_QUEUE_LIMIT);
    expect(events).toBe(P2P_EVENTS_PER_FRAME * delivered);
  });

  it('a stream paced by txComplete at line rate: the same ratio', () => {
    const w = world();
    let sent = 0;
    const pump = (at: number): void => {
      if (sent >= 1_000) return;
      sent++;
      w.model.transmit(w.A, w.frame(), at);
    };
    pump(0);
    let events = 0;
    let delivered = 0;
    for (let ev = w.scheduler.next(); ev; ev = w.scheduler.next()) {
      events++;
      if (ev.kind === 'txComplete') {
        w.model.onTxComplete({ device: ev.device, port: ev.port }, ev.at);
        pump(ev.at);
      } else if (ev.kind === 'frameArrival' && w.model.admit(ev, ev.at).deliver) delivered++;
    }
    expect(delivered).toBe(1_000);
    expect(events / delivered).toBe(P2P_EVENTS_PER_FRAME);
  });

  it('a multiplying loop: memory stays within the cap and the event count within the line-rate bound', () => {
    // every frame that arrives is sent back twice out of the port it came in on (a loop that multiplies frames)
    const w = world();
    const duration = 5_000_000; // 5 ms: long enough to fill the queue (it grows by one frame per slot)
    let maxQueue = 0;
    const watch = (): void => {
      maxQueue = Math.max(maxQueue, w.port(w.A).tx.queue, w.port(w.B).tx.queue);
    };
    w.model.transmit(w.A, w.frame(), 0);
    const { events, delivered } = w.run(duration, (to, _pdu, at) => {
      for (let i = 0; i < 2; i++) w.model.transmit(to, w.frame(), at);
      watch();
    }, watch);
    const full = drops(w.events).filter((d) => d.reason === 'queue-full');
    expect(full.length).toBeGreaterThan(0);
    expect(maxQueue).toBeLessThanOrEqual(P2P_QUEUE_LIMIT);
    // memory: frames scheduled but not yet dispatched are the two ports' queues plus the frames propagating
    const pending = w.scheduler.size;
    expect(pending).toBeLessThanOrEqual(2 * P2P_EVENTS_PER_FRAME * (P2P_QUEUE_LIMIT + 1));
    // event rate: the line rate, not the cap, bounds it (§10.1 formula with one link)
    const bound = 1 * 2 * Math.ceil(duration / SLOT) * P2P_EVENTS_PER_FRAME * 1.1;
    expect(events).toBeLessThanOrEqual(bound);
    // and the loop really ran at line rate in both directions
    expect(delivered).toBeGreaterThan(2 * Math.floor(duration / SLOT) - 4);
  });
});
