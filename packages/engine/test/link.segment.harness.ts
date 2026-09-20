/**
 * Test harness for link/media/segment.ts: a hand-driven MediumHost over hand-written ports and LinkStates, with a
 * tiny run loop that dispatches the events the segment schedules (frameArrival → admit, txComplete, mediumTimer).
 */
import type { WireEvent } from '../src/contracts/capture.js';
import type { PortRole } from '../src/contracts/catalog.js';
import type { Scheduler } from '../src/contracts/events.js';
import type { DeviceId, LinkId, PortId, PortRef } from '../src/contracts/ids.js';
import { portKey } from '../src/contracts/ids.js';
import type { ArrivalVerdict, Impairments, LinkModelDeps, LinkState, PhyEndView, TxOutcome } from '../src/contracts/link.js';
import { NO_IMPAIRMENTS } from '../src/contracts/link.js';
import { CSMA } from '../src/contracts/medium.js';
import type { LayerSpec, PduMeta } from '../src/contracts/pdu.js';
import { ARP_OP_REQUEST, ETHERTYPE_ARP } from '../src/contracts/pdu.js';
import { SPEED_1G, emptyCounters } from '../src/contracts/port.js';
import type { PortKind, PortState } from '../src/contracts/port.js';
import type { Rng } from '../src/contracts/rng.js';
import type { SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createRng } from '../src/core/prng.js';
import { createScheduler } from '../src/core/scheduler.js';
import type { ResolvedMedia } from '../src/link/cabling.js';
import { createInflightRegistry } from '../src/link/inflight.js';
import { createSharedSegment } from '../src/link/media/segment.js';
import type { MediumHost } from '../src/link/media/types.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { testPortSpec, INERT_LINK_DEPS } from './port.fixtures.js';
import { KIND_ENCAP } from '../src/contracts/catalog.js';

/** PDU metadata for test frames. */
export const meta = (over: Partial<PduMeta> = {}): PduMeta => ({ born: 0, origin: 'd_test', ...over });

/** A 64-byte ARP request frame (broadcast unless `dst` is given). */
export const arpFrame = (src: string, dst = 'ff:ff:ff:ff:ff:ff'): LayerSpec[] => [
  { proto: 'ethernet', fields: { dst, src, type: ETHERTYPE_ARP } },
  { proto: 'arp', fields: { op: ARP_OP_REQUEST, sha: src, spa: '10.0.0.1', tha: '00:00:00:00:00:00', tpa: '10.0.0.2' } },
];

/** One port of a harness device. */
export interface HarnessPort {
  name: PortId;
  role: PortRole;
  kind?: PortKind;
  speedBps?: number;
}

/** Options of a cable created by the harness. */
export interface HarnessCable {
  lengthM?: number;
  media?: ResolvedMedia;
  impairments?: Partial<Impairments>;
  up?: boolean;
  /** Force an end's duplex (default: half when either end is a repeater port, else full). */
  duplexA?: 'full' | 'half';
  duplexB?: 'full' | 'half';
  bps?: number;
}

/** One delivered arrival. */
export interface Delivery {
  t: SimTime;
  to: PortRef;
  verdict: ArrivalVerdict;
}

/** Harness options. */
export interface SegmentHarnessOptions {
  seed?: number;
  /** Replace a cached stream (e.g. a fixed backoff source). */
  stream?(label: string, fallback: () => Rng): Rng;
}

/** Build a segment harness. */
export function segmentHarness(opts: SegmentHarnessOptions = {}) {
  const seed = opts.seed ?? 7;
  const ports = new Map<string, PortState>();
  const devicePorts = new Map<DeviceId, PortId[]>();
  const deviceOrder: DeviceId[] = [];
  const links = new Map<LinkId, LinkState>();
  const linkOrder: LinkId[] = [];
  const events: TraceEvent[] = [];
  const outcomes: { t: SimTime; ref: PortRef; o: TxOutcome }[] = [];
  const wires: WireEvent[] = [];
  const deliveries: Delivery[] = [];
  const scheduler: Scheduler = createScheduler();
  const root = createRng(seed).split('links');
  const streams = new Map<string, Rng>();
  const inflight = createInflightRegistry();
  const pdus = createPduFactory();
  let macCounter = 0;

  const deps: LinkModelDeps = {
    ...INERT_LINK_DEPS,
    scheduler,
    trace: { emit: (ev) => events.push(ev) },
    rng: root,
    port: (ref) => ports.get(portKey(ref)),
    deviceUp: (id) => devicePorts.has(id),
    pdus,
  };
  const host: MediumHost = {
    deps,
    inflight,
    port: (ref) => ports.get(portKey(ref)),
    deviceUp: (id) => devicePorts.has(id),
    link: (id) => links.get(id),
    stream(label) {
      let s = streams.get(label);
      if (!s) {
        const fallback = (): Rng => root.split(label);
        s = opts.stream ? opts.stream(label, fallback) : fallback();
        streams.set(label, s);
      }
      return s;
    },
    emit: (ev) => events.push(ev),
    schedule: (at, body) => scheduler.schedule(at, body),
    cancel: (seq) => scheduler.cancel(seq),
    txOutcome: (ref, o, t) => outcomes.push({ t, ref: { device: ref.device, port: ref.port }, o }),
    notify: () => undefined,
    capture: (ev) => wires.push(ev),
  };

  const seg = createSharedSegment(host, {
    links: () => linkOrder,
    deviceOrder: (id) => deviceOrder.indexOf(id),
    devicePorts: (id) => devicePorts.get(id) ?? [],
  });

  const addDevice = (id: DeviceId, list: readonly HarnessPort[]): PortRef[] => {
    deviceOrder.push(id);
    devicePorts.set(id, list.map((p) => p.name));
    return list.map((p) => {
      macCounter++;
      const mac = `02:00:00:00:00:${macCounter.toString(16).padStart(2, '0')}`;
      const state: PortState = {
        id: p.name,
        spec: testPortSpec({ name: p.name, short: p.name, kind: p.kind ?? 'ethernet', speedBps: p.speedBps ?? SPEED_1G, role: p.role }),
        mac,
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
      ports.set(portKey({ device: id, port: p.name }), state);
      return { device: id, port: p.name };
    });
  };

  /** A station with one routed Ethernet port `Gi0`. */
  const addStation = (id: DeviceId): PortRef => addDevice(id, [{ name: 'Gi0', role: 'routed' }])[0] as PortRef;

  /** A hub with `n` repeater ports P0..P(n-1). */
  const addHub = (id: DeviceId, n = 4): PortRef[] =>
    addDevice(id, Array.from({ length: n }, (_, i) => ({ name: `P${i}`, role: 'repeater' as PortRole })));

  const cable = (id: LinkId, a: PortRef, b: PortRef, over: HarnessCable = {}): LinkState => {
    const pa = ports.get(portKey(a)) as PortState;
    const pb = ports.get(portKey(b)) as PortState;
    const repeater = pa.role === 'repeater' || pb.role === 'repeater';
    const bps = over.bps ?? (repeater ? CSMA.REPEATER_BPS : Math.min(pa.spec.speedBps, pb.spec.speedBps));
    const up = over.up ?? true;
    const endView = (duplex: 'full' | 'half', isRepeater: boolean): PhyEndView =>
      isRepeater ? { speedBps: bps, duplex: 'half', autoneg: false, via: 'fixed' } : { speedBps: bps, duplex, autoneg: true, via: repeater ? 'parallel-detect' : 'autoneg' };
    const duplexA = over.duplexA ?? (repeater ? 'half' : 'full');
    const duplexB = over.duplexB ?? (repeater ? 'half' : 'full');
    const media = over.media ?? 'copper-straight';
    const state: LinkState = {
      id, a, b, media, resolvedMedia: media, lengthM: over.lengthM ?? 1,
      impairments: { ...NO_IMPAIRMENTS, ...(over.impairments ?? {}) },
      up, kind: 'cable',
    };
    if (up) {
      state.negotiatedBps = bps;
      state.phy = { a: endView(duplexA, pa.role === 'repeater'), b: endView(duplexB, pb.role === 'repeater') };
      if (duplexA !== duplexB && !repeater) state.phy.mismatch = 'duplex';
    } else {
      state.downReason = 'cut';
    }
    links.set(id, state);
    linkOrder.push(id);
    for (const [p, end, duplex] of [[pa, state.phy?.a, duplexA], [pb, state.phy?.b, duplexB]] as const) {
      p.link = id;
      p.operUp = up;
      if (up) {
        p.speedBps = bps;
        p.duplex = duplex;
        p.phy = { carrier: true, lineProtocol: true, end: end as PhyEndView, medium: 'segment' };
      }
    }
    return state;
  };

  /** Take a cable down (carrier lost on both ends). */
  const setDown = (id: LinkId): void => {
    const s = links.get(id) as LinkState;
    s.up = false;
    s.downReason = 'cut';
    delete s.negotiatedBps;
    delete s.phy;
    for (const ref of [s.a, s.b]) {
      const p = ports.get(portKey(ref)) as PortState;
      p.operUp = false;
      delete p.phy;
      delete p.duplex;
    }
  };

  /** Dispatch every pending event up to `until` (inclusive; default: until idle). */
  const run = (until = Number.MAX_SAFE_INTEGER, maxEvents = 200_000): void => {
    for (let n = 0; n < maxEvents; n++) {
      const at = scheduler.peekTime();
      if (at === undefined || at > until) return;
      const ev = scheduler.next();
      if (!ev) return;
      if (ev.kind === 'frameArrival') {
        deliveries.push({ t: ev.at, to: { device: ev.device, port: ev.port }, verdict: seg.admit(ev, ev.at) });
      } else if (ev.kind === 'txComplete') {
        seg.onTxComplete?.({ device: ev.device, port: ev.port }, ev.at);
      } else if (ev.kind === 'mediumTimer') {
        seg.onMediumTimer?.(ev.medium, ev.key, ev.at);
      }
    }
    throw new Error('run loop did not go idle');
  };

  return {
    ports, links, events, outcomes, wires, deliveries, scheduler, root, host, inflight, pdus, seg,
    addDevice, addStation, addHub, cable, setDown, run,
    port: (r: PortRef): PortState => ports.get(portKey(r)) as PortState,
    frame: (from: PortRef, dst?: string) => pdus.build(arpFrame((ports.get(portKey(from)) as PortState).mac, dst), meta()),
    ofKind: <K extends TraceEvent['kind']>(kind: K) => events.filter((e): e is Extract<TraceEvent, { kind: K }> => e.kind === kind),
  };
}

/** Three stations on a four-port hub: hub first, then pc1..pc3 on P0..P2 (links l_1..l_3), rebuilt at t=0. */
export function hubOfThree(opts: SegmentHarnessOptions = {}, cables: { l1?: HarnessCable; l2?: HarnessCable; l3?: HarnessCable } = {}) {
  const h = segmentHarness(opts);
  const hub = h.addHub('d_hub');
  const pc1 = h.addStation('d_pc1');
  const pc2 = h.addStation('d_pc2');
  const pc3 = h.addStation('d_pc3');
  h.cable('l_1', pc1, hub[0] as PortRef, cables.l1);
  h.cable('l_2', pc2, hub[1] as PortRef, cables.l2);
  h.cable('l_3', pc3, hub[2] as PortRef, cables.l3);
  h.seg.rebuild(0);
  return { ...h, hub, pc1, pc2, pc3 };
}
