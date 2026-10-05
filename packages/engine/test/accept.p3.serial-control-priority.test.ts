/**
 * P3 acceptance — the control path of a serial FIFO (ARCHITECTURE-P3 §9.2 ruling R43; §7 W4 media; §10.1 row
 * `accept.p3.serial-control-priority`). Owner: W4 qa-media.
 *
 * R43: in P3-profile worlds only, a serial control frame (`link/control-frame.ts` `isSerialControlFrame`: an HDLC
 * keepalive, a PPP LCP/PAP/CHAP/IPCP/IPV6CP frame) entering a backlogged virtual FIFO is committed ahead of the queued
 * data; the later frames shift by its serialization time; P1/P2 worlds keep today's commit order byte for byte.
 *
 *  1. Real worlds (`staged.world`, stage P3, the traffic generator): PC1 — R1 Se0/0/0 (DCE, `clock rate 64000`) ⇄ R2
 *     Se0/0/0 — PC2, a continuous 256 kb/s flow of 1000-byte datagrams saturating the 64 kb/s FIFO for 120 s, HDLC
 *     and PPP: the line protocol stays up at both ends (no `portState`, no line-protocol log), the FIFO stays saturated
 *     (`queue-full` data drops, a deep `txBacklog`), every control frame R1 sends is committed ahead of a backlog of
 *     at least 10 s and waits at most the frame on the wire (plus the control frames ahead of it), it arrives when its
 *     `frameTx` said, the frames R2 receives never overlap on the wire, and the line runs at its rate.
 *     A P2-profile world under the same load keeps today's path exactly (its trace digest equals the literal digest
 *     recorded from the pre-R43 engine, cbb8b4c's link model) and still loses its line protocol: R43 is P3-only.
 *     The worlds are built through the real wiring: `sim/simulation.ts`'s `makeWorld` hands the world's profile to
 *     `sim/media-wiring.ts`, which passes `createLinkModel(deps, {profile})` (no test-side bridge).
 *  2. The link model alone (`createLinkModel(deps, {profile})`, a real scheduler, a 64 kb/s serial cable): the exact
 *     slot, the shift of the displaced frames (legs, arrivals, txCompletes, `queued`, `busyUntil`), FIFO order among
 *     control frames, an unbacklogged line unchanged, corrupted and lost displaced frames, a link abort (no aborted
 *     frame comes back), the five draws per frame, and P1/P2/absent profiles byte-identical; and the worker's
 *     `TxBacklogWatch` keeps a sender due while a moved frame still waits past its announced end (`deviceTxBusy`).
 */
import { describe, expect, it } from 'vitest';
import type { DefaultsProfile } from '../src/contracts/catalog.js';
import type { Scheduler, SimEvent } from '../src/contracts/events.js';
import type { DeviceId, PduId, PortId, PortRef } from '../src/contracts/ids.js';
import { portKey } from '../src/contracts/ids.js';
import type { Impairments, LinkModelDeps, TransmitResult } from '../src/contracts/link.js';
import { NO_IMPAIRMENTS, P2P_QUEUE_LIMIT } from '../src/contracts/link.js';
import type { LayerSpec, Pdu, PduMeta } from '../src/contracts/pdu.js';
import {
  HDLC_ADDRESS_BROADCAST,
  HDLC_ADDRESS_UNICAST,
  HDLC_PHY_OVERHEAD,
  HDLC_PROTO_IPV4,
  HDLC_PROTO_KEEPALIVE,
  IPPROTO_UDP,
  PPP_ADDRESS,
  PPP_CONTROL,
  PPP_PROTO,
} from '../src/contracts/pdu.js';
import type { PortState } from '../src/contracts/port.js';
import { emptyCounters } from '../src/contracts/port.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { MS, SEC, serializationNs, type SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createRng } from '../src/core/prng.js';
import { createScheduler } from '../src/core/scheduler.js';
import { isSerialControlFrame } from '../src/link/control-frame.js';
import { createLinkModel, type LinkModelOptions } from '../src/link/link.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { PPP_CP_CODE } from '../src/pdu/codecs/ppp.js';
import { createCdp } from '../src/protocols/cdp.js';
import { createPpp } from '../src/protocols/ppp.js';
import { createTraffic } from '../src/protocols/traffic.js';
import { createTxBacklogWatch, deviceTxBusy } from '../src/sim/snapshot-cache.js';
import { INERT_LINK_DEPS, testPortSpec } from './port.fixtures.js';
import { createStagedSimulation } from './staged.world.js';

/** The serial line rate of the row: `clock rate 64000`. */
const RATE = 64_000;
const SE0: PortId = 'Serial0/0/0';
const PC2_IP = '192.168.2.10';
/** The flow of the row: 1000-byte datagrams at 256 kb/s (four times the line). */
const FLOW_BYTES = 1000;
const FLOW_KBPS = 256;
/** The saturation window of the row. */
const WINDOW = 120 * SEC;

// ── 1. real worlds ──────────────────────────────────────────────────────────────────────────────────────────────

/** The P3 daemons these worlds use (the flip registers them later; `staged.world` filters what has no factory). */
const FACTORIES = { traffic: createTraffic, ppp: createPpp, cdp: createCdp };

function startup(sections: readonly (readonly string[])[]): string {
  const out: string[] = [];
  for (const s of sections) out.push(...s, '!');
  out.push('end', '');
  return out.join('\n');
}

interface WorldOptions {
  readonly encap: 'hdlc' | 'ppp';
  readonly profile: DefaultsProfile;
  readonly seed?: number;
}

/**
 * The trace digest of the P2 world below (HDLC, seed 43, saturated for 50 s), recorded from the pre-R43 engine
 * (cbb8b4c's `link/link.ts` and `link/media/p2p.ts`): a P2 world keeps today's commit order byte for byte.
 */
const P2_PRE_R43_DIGEST = '30033:a03c54ad';

/** PC1 — R1 ⇄ (64 kb/s serial) ⇄ R2 — PC2, booted, the serial line up, every ARP cache warm. */
function world(o: WorldOptions): Simulation {
  const sim = createStagedSimulation({ seed: o.seed ?? 43, stage: 'P3', profile: o.profile, factories: FACTORIES });
  expect(sim.profile).toBe(o.profile);
  const enc = o.encap === 'ppp' ? [' encapsulation ppp'] : [];
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: startup([['hostname PC1'], ['interface GigabitEthernet0', ' ip address 192.168.1.10 255.255.255.0'], ['ip default-gateway 192.168.1.1']]) });
  sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: startup([['hostname PC2'], ['interface GigabitEthernet0', ` ip address ${PC2_IP} 255.255.255.0`], ['ip default-gateway 192.168.2.1']]) });
  sim.addDevice({
    id: 'r1', type: 'router.nf2911', name: 'R1',
    startupConfig: startup([
      ['hostname R1'],
      ['interface GigabitEthernet0/0', ' ip address 192.168.1.1 255.255.255.0', ' no shutdown'],
      [`interface ${SE0}`, ' ip address 10.1.1.1 255.255.255.252', ` clock rate ${RATE}`, ...enc, ' no shutdown'],
      ['ip route 192.168.2.0 255.255.255.0 10.1.1.2'],
    ]),
  });
  sim.addDevice({
    id: 'r2', type: 'router.nf2911', name: 'R2',
    startupConfig: startup([
      ['hostname R2'],
      ['interface GigabitEthernet0/0', ' ip address 192.168.2.1 255.255.255.0', ' no shutdown'],
      [`interface ${SE0}`, ' ip address 10.1.1.2 255.255.255.252', ...enc, ' no shutdown'],
      ['ip route 192.168.1.0 255.255.255.0 10.1.1.1'],
    ]),
  });
  sim.addLink({ a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'r1', port: 'GigabitEthernet0/0' } });
  sim.addLink({ a: { device: 'r1', port: SE0 }, b: { device: 'r2', port: SE0 }, media: 'serial-dce' });
  sim.addLink({ a: { device: 'r2', port: 'GigabitEthernet0/0' }, b: { device: 'pc2', port: 'GigabitEthernet0' } });
  sim.runFor(60 * SEC);
  // warm every ARP cache along the path with one bounded datagram
  expect(shell(sim, 'pc1', `flow start ${PC2_IP} pps 10 size 100 count 1`)).toMatch(/^Flow f1 started: /);
  sim.runFor(5 * SEC);
  return sim;
}

/** One line in a fresh console session of `device`: the command's output, then its job's (a `flow` job prints one line). */
function shell(sim: Simulation, device: DeviceId, line: string): string {
  const s = sim.cli.open(device, 'console');
  const cursor = sim.trace(0).next;
  const r = sim.cli.exec(s, line);
  if (r.error !== undefined) throw new Error(`${device}: ${line}: ${r.error.message}`);
  sim.runFor(0);
  const job = sim.trace(cursor).events.filter((e): e is Extract<TraceEvent, { kind: 'cliOutput' }> => e.kind === 'cliOutput' && e.session === s);
  return r.output + job.map((e) => e.text).join('');
}

/** Start the row's continuous flow from PC1's shell (it runs until the 5-minute cap; the test uses `runFor`). */
function saturate(sim: Simulation): void {
  expect(shell(sim, 'pc1', `flow start ${PC2_IP} rate ${FLOW_KBPS} size ${FLOW_BYTES}`)).toMatch(/^Flow f\d+ started: /);
}

type FrameTx = Extract<TraceEvent, { kind: 'frameTx' }>;
type FrameRx = Extract<TraceEvent, { kind: 'frameRx' }>;

/** The window's events, with the serial control frames R1 transmits on Se0/0/0 (classified when emitted). */
interface Recorded {
  readonly events: TraceEvent[];
  readonly control: Set<PduId>;
}

function record(sim: Simulation): Recorded {
  const events: TraceEvent[] = [];
  const control = new Set<PduId>();
  sim.onTrace((ev) => {
    events.push(ev);
    if (ev.kind === 'frameTx' && ev.from.device === 'r1' && ev.from.port === SE0) {
      const pdu = sim.pdu(ev.pdu.id);
      if (pdu !== undefined && isSerialControlFrame(pdu)) control.add(ev.pdu.id);
    }
  });
  return { events, control };
}

const isSerialEnd = (device: string, port: string): boolean => (device === 'r1' || device === 'r2') && port === SE0;
/** Wire time of an `n`-byte frame on the 64 kb/s line (the serial PHY overhead included). */
const wire = (n: number): SimTime => serializationNs(n + HDLC_PHY_OVERHEAD, RATE);

/** FNV-1a 32 over the JSON of every event: a byte-level digest of a run's trace. */
function digestOf(events: readonly TraceEvent[]): string {
  let h = 0x811c9dc5;
  for (const e of events) {
    const s = JSON.stringify(e);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return `${events.length}:${h.toString(16)}`;
}

describe('R43 in a P3 world: a 64 kb/s serial FIFO saturated by the traffic generator for 120 s keeps its line protocol up', () => {
  for (const encap of ['hdlc', 'ppp'] as const) {
    it(`${encap.toUpperCase()}: control frames are committed ahead of the queued data, the line stays up and runs at its rate`, () => {
      const sim = world({ encap, profile: 'P3' });
      for (const d of ['r1', 'r2']) expect(sim.device(d)!.port(SE0)!.operUp, `${d} ${SE0} before`).toBe(true);
      const rec = record(sim);
      const t0 = sim.now;
      saturate(sim);
      sim.runFor(WINDOW);
      const evs = rec.events;

      // the line protocol never moved, at either end
      expect(evs.filter((e) => e.kind === 'portState' && isSerialEnd(e.device, e.port))).toEqual([]);
      expect(evs.filter((e) => e.kind === 'log' && /line protocol/.test(e.message))).toEqual([]);
      for (const d of ['r1', 'r2']) expect(sim.device(d)!.port(SE0)!.operUp, `${d} ${SE0} after`).toBe(true);

      // the FIFO was saturated: data tail-dropped at R1 Se0/0/0, never a control frame, and a deep backlog at the end
      const fifoDrops = evs.filter((e): e is Extract<TraceEvent, { kind: 'drop' }> => e.kind === 'drop' && e.device === 'r1' && e.port === SE0 && e.reason === 'queue-full');
      expect(fifoDrops.length).toBeGreaterThan(100);
      expect(fifoDrops.filter((d) => d.pdu.tag === 'keepalive' || d.pdu.tag === 'lcp' || d.pdu.tag === 'lcp-echo')).toEqual([]);
      const backlog = sim.snapshot().devices.find((d) => d.id === 'r1')!.ports.find((p) => p.id === SE0)!.txBacklog;
      expect(backlog?.depth ?? 0).toBeGreaterThanOrEqual(P2P_QUEUE_LIMIT - 1);

      // every control frame R1 sent once the backlog had built: committed ahead of ≥ 10 s of data, it waits at most the
      // frame on the wire and the control frames already ahead of it, and arrives exactly when its frameTx said
      const txs = evs.filter((e): e is FrameTx => e.kind === 'frameTx' && e.from.device === 'r1' && e.from.port === SE0);
      const rx = new Map<PduId, FrameRx>();
      for (const e of evs) if (e.kind === 'frameRx' && isSerialEnd(e.device, e.port)) rx.set(e.pdu.id, e);
      const maxData = Math.max(...txs.filter((t) => !rec.control.has(t.pdu.id)).map((t) => t.pdu.size));
      const late = txs.filter((t) => rec.control.has(t.pdu.id) && t.t >= t0 + 40 * SEC && t.arrive <= sim.now);
      expect(late.length).toBeGreaterThanOrEqual(5);
      for (const c of late) {
        const lastData = txs.filter((t) => t.t <= c.t && !rec.control.has(t.pdu.id)).at(-1)!;
        expect(lastData.txStart - lastData.t, `data backlog at ${c.t}`).toBeGreaterThanOrEqual(10 * SEC);
        const ahead = txs.filter((t) => rec.control.has(t.pdu.id) && t.t < c.t && t.txStart > c.t).reduce((n, t) => n + (t.txEnd - t.txStart), 0);
        expect(c.txStart - c.t, `control frame ${c.pdu.id} wait`).toBeLessThanOrEqual(wire(maxData) + ahead);
        expect(rx.get(c.pdu.id)?.t, `control frame ${c.pdu.id} arrival`).toBe(c.arrive);
      }

      // the frames R2 receives never overlap on the wire (the control path borrows no line time), and the line is full
      const got = evs.filter((e): e is FrameRx => e.kind === 'frameRx' && e.device === 'r2' && e.port === SE0 && e.t >= t0 + 20 * SEC);
      for (let i = 1; i < got.length; i++) {
        expect(got[i]!.t - got[i - 1]!.t, `frame ${got[i]!.pdu.id}`).toBeGreaterThanOrEqual(wire(got[i]!.pdu.size));
      }
      const bits = got.slice(1).reduce((n, e) => n + (e.pdu.size + HDLC_PHY_OVERHEAD) * 8, 0);
      const span = got.at(-1)!.t - got[0]!.t;
      expect(bits * SEC).toBeGreaterThanOrEqual(0.99 * RATE * span);
    }, 180_000);
  }
});

describe('R43 is P3-only: a P2 world under the same load keeps today\'s commit order', () => {
  it('its trace digest equals the pre-R43 engine\'s, and its line protocol still drops on missed keepalives', () => {
    const sim = world({ encap: 'hdlc', profile: 'P2' });
    const rec = record(sim);
    saturate(sim);
    sim.runFor(50 * SEC);
    expect(digestOf(rec.events)).toBe(P2_PRE_R43_DIGEST);
    const downs = rec.events.filter((e) => e.kind === 'portState' && isSerialEnd(e.device, e.port) && !e.operUp);
    expect(downs.length).toBeGreaterThan(0);
  }, 180_000);
});

// ── 2. the link model alone ─────────────────────────────────────────────────────────────────────────────────────

const R1: PortRef = { device: 'd_r1', port: SE0 };
const R2: PortRef = { device: 'd_r2', port: SE0 };
/** A 1000-byte IPv4 datagram over HDLC is a 1006-byte frame; 125.75 ms on the wire at 64 kb/s. */
const DATA_PAYLOAD = FLOW_BYTES - 28;

interface SerialOptions {
  readonly options: LinkModelOptions;
  readonly encap?: 'hdlc' | 'ppp';
  readonly impairments?: Partial<Impairments>;
  readonly seed?: number;
}

/** What one dispatch did: a delivered (or corrupted) arrival, or a txComplete. */
interface Dispatched {
  readonly at: SimTime;
  readonly kind: 'arrival' | 'complete';
  readonly pdu?: PduId;
  readonly corrupted?: boolean;
}

/** R1 Se0/0/0 (DCE, 64 kb/s) ⇄ R2 Se0/0/0 on a serial cable, a real scheduler, the link model under test. */
function serial(o: SerialOptions) {
  const ports = new Map<string, PortState>();
  const scheduler: Scheduler = createScheduler();
  const pdus = createPduFactory();
  const trace: TraceEvent[] = [];
  const encap = o.encap ?? 'hdlc';
  const deps: LinkModelDeps = {
    ...INERT_LINK_DEPS,
    scheduler,
    trace: { emit: (e) => trace.push(e) },
    rng: createRng(o.seed ?? 11).split('links'),
    port: (ref) => ports.get(portKey(ref)),
    deviceUp: () => true,
    pdus,
    portSettings: (ref) => (ref.device === R1.device ? { speed: 'auto', duplex: 'auto', clockRateBps: RATE } : { speed: 'auto', duplex: 'auto' }),
  };
  const add = (device: DeviceId, mac: string): void => {
    ports.set(portKey({ device, port: SE0 }), {
      id: SE0,
      spec: testPortSpec({ name: SE0, short: 'Se0/0/0', kind: 'serial', speedBps: 2_000_000, role: 'routed' }),
      mac,
      adminUp: true,
      operUp: false,
      mtu: 1500,
      counters: emptyCounters(),
      l3: {},
      tx: { busyUntil: 0, queue: 0 },
      role: 'routed',
      ordinal: 1,
      encap,
    });
  };
  add(R1.device, '02:00:00:00:00:a1');
  add(R2.device, '02:00:00:00:00:a2');
  const model = createLinkModel(deps, o.options);
  model.add({ id: 'l_se', a: R1, b: R2, media: 'serial-dce', lengthM: 3, impairments: { ...NO_IMPAIRMENTS, ...o.impairments } }, 0);
  if (encap === 'ppp') {
    // the ppp daemons' reports: LCP open and authenticated at both ends
    model.mediumOp(R1, { op: 'ppp-link', up: true }, 0);
    model.mediumOp(R2, { op: 'ppp-link', up: true }, 0);
  }
  const port = (r: PortRef): PortState => ports.get(portKey(r))!;
  expect(port(R1).operUp && port(R2).operUp).toBe(true);
  expect(model.get('l_se')!.negotiatedBps).toBe(RATE);
  trace.length = 0;

  const meta = (over: Partial<PduMeta> = {}): PduMeta => ({ born: 0, origin: R1.device, ...over });
  const outer = (protocol: 'ipv4' | 'control'): LayerSpec =>
    encap === 'ppp'
      ? { proto: 'ppp', fields: { address: PPP_ADDRESS, control: PPP_CONTROL, protocol: protocol === 'ipv4' ? PPP_PROTO.ipv4 : PPP_PROTO.lcp } }
      : { proto: 'hdlc', fields: { address: protocol === 'ipv4' ? HDLC_ADDRESS_UNICAST : HDLC_ADDRESS_BROADCAST, control: 0, protocol: protocol === 'ipv4' ? HDLC_PROTO_IPV4 : HDLC_PROTO_KEEPALIVE } };
  /** A 1000-byte IPv4/UDP datagram R1 → R2 (or one carrying a `payload`-byte UDP payload). */
  const data = (payload: number = DATA_PAYLOAD): Pdu =>
    pdus.build(
      [
        outer('ipv4'),
        { proto: 'ipv4', fields: { src: '10.1.1.1', dst: '10.1.1.2', protocol: IPPROTO_UDP, ttl: 64 } },
        { proto: 'udp', fields: { srcPort: 40000, dstPort: 9 } },
        { proto: 'payload', fields: { data: new Uint8Array(payload) } },
      ],
      meta(),
    );
  /** The serial control frame of the encapsulation: an HDLC keepalive, or a PPP LCP echo request. */
  const control = (): Pdu =>
    pdus.build(
      encap === 'ppp'
        ? [outer('control'), { proto: 'lcp', fields: { code: PPP_CP_CODE.echoRequest, id: 1, echoMagic: 0x5a5a5a5a } }]
        : [outer('control'), { proto: 'payload', fields: { data: new Uint8Array(18) } }],
      meta({ background: true, tag: encap === 'ppp' ? 'lcp-echo' : 'keepalive' }),
    );

  const dispatched: Dispatched[] = [];
  /** Dispatch every event up to `until` through the facade. */
  const run = (until: SimTime): void => {
    for (;;) {
      const at = scheduler.peekTime();
      if (at === undefined || at > until) {
        if (scheduler.now < until) scheduler.advanceTo(until);
        return;
      }
      const ev = scheduler.next() as SimEvent;
      if (ev.kind === 'txComplete') {
        model.onTxComplete({ device: ev.device, port: ev.port }, ev.at);
        dispatched.push({ at: ev.at, kind: 'complete' });
      } else if (ev.kind === 'frameArrival') {
        const v = model.admit(ev, ev.at);
        if (v.deliver) dispatched.push(v.corrupted === true ? { at: ev.at, kind: 'arrival', pdu: v.pdu.id, corrupted: true } : { at: ev.at, kind: 'arrival', pdu: v.pdu.id });
      }
    }
  };
  /** Transmit at `at` (advancing the clock first, dispatching what is due). */
  const send = (pdu: Pdu, at: SimTime): Extract<TransmitResult, { ok: true }> => {
    run(at);
    const r = model.transmit(R1, pdu, at);
    if (!r.ok) throw new Error(`refused: ${r.reason}`);
    return r;
  };
  const arrivalOf = (id: PduId): Dispatched | undefined => dispatched.find((d) => d.kind === 'arrival' && d.pdu === id);
  const completes = (): SimTime[] => dispatched.filter((d) => d.kind === 'complete').map((d) => d.at);
  return { model, scheduler, trace, port, data, control, send, run, dispatched, arrivalOf, completes };
}

describe('R43 in the link model: the slot, the shift, the order', () => {
  for (const encap of ['hdlc', 'ppp'] as const) {
    it(`${encap.toUpperCase()}: with profile P3 a control frame takes the first queued data frame's slot and the data behind it moves by its wire time`, () => {
      const h = serial({ options: { profile: 'P3' }, encap });
      const d = [h.data(), h.data(), h.data()];
      const sent = d.map((p) => h.send(p, 0));
      const s = wire(d[0]!.size);
      expect(sent.map((r) => [r.txStart, r.txEnd])).toEqual([[0, s], [s, 2 * s], [2 * s, 3 * s]]);
      const prop = sent[0]!.arrive - sent[0]!.txEnd;
      const k = h.control();
      const kr = h.send(k, 10 * MS);
      const kw = wire(k.size);
      // the control frame takes D1's slot: it waits only for the frame on the wire
      expect([kr.txStart, kr.txEnd, kr.arrive]).toEqual([s, s + kw, s + kw + prop]);
      // the legs of D1 and D2 moved by kw (the snapshot's txBacklog reads them), the control frame between
      expect(h.model.queued(R1, 10 * MS).map((q) => [q.pdu.id, q.txStart, q.txEnd, q.arrive])).toEqual([
        [k.id, s, s + kw, s + kw + prop],
        [d[1]!.id, s + kw, 2 * s + kw, 2 * s + kw + prop],
        [d[2]!.id, 2 * s + kw, 3 * s + kw, 3 * s + kw + prop],
      ]);
      expect(h.port(R1).tx.busyUntil).toBe(3 * s + kw);
      expect(h.port(R1).tx.queue).toBe(4);
      // the frameTx events keep what they announced; the arrivals and txCompletes carry the moved times
      const tx = h.trace.filter((e): e is Extract<TraceEvent, { kind: 'frameTx' }> => e.kind === 'frameTx');
      expect(tx.map((e) => e.pdu.id)).toEqual([d[0]!.id, d[1]!.id, d[2]!.id, k.id]);
      expect(tx[1]!.txStart).toBe(s);
      h.run(10 * SEC);
      expect([d[0]!, k, d[1]!, d[2]!].map((p) => h.arrivalOf(p.id)?.at)).toEqual([s + prop, s + kw + prop, 2 * s + kw + prop, 3 * s + kw + prop]);
      expect(h.completes()).toEqual([s, s + kw, 2 * s + kw, 3 * s + kw]);
      expect(h.port(R1).tx.queue).toBe(0);
      // a frame sent after the shift starts where the moved data ends
      const after = h.send(h.data(), 20 * SEC);
      expect(after.txStart).toBe(20 * SEC);
    });
  }

  it('with profile P2, P1 or none the control frame waits behind the queue and nothing moves; the three runs are byte-identical', () => {
    const runs = ([{ profile: 'P2' }, { profile: 'P1' }, {}] as const).map((options) => {
      const h = serial({ options, impairments: { jitterNs: 2 * MS, lossPct: 10 } });
      const d = [h.data(), h.data(), h.data()];
      const sent = d.map((p) => h.send(p, 0));
      const kr = h.send(h.control(), 10 * MS);
      expect(kr.txStart).toBe(sent[2]!.txEnd);
      h.run(10 * SEC);
      return { trace: JSON.stringify(h.trace), dispatched: JSON.stringify(h.dispatched) };
    });
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });

  it('control frames keep their order among themselves: each new one goes behind those already ahead, before the data', () => {
    const h = serial({ options: { profile: 'P3' } });
    const d = [h.data(), h.data(), h.data()];
    d.forEach((p) => h.send(p, 0));
    const k1 = h.control();
    const k2 = h.control();
    h.send(k1, 10 * MS);
    h.send(k2, 20 * MS);
    h.run(10 * SEC);
    const order = h.dispatched.filter((x) => x.kind === 'arrival').map((x) => x.pdu);
    expect(order).toEqual([d[0]!.id, k1.id, k2.id, d[1]!.id, d[2]!.id]);
    const s = wire(d[0]!.size);
    const kw = wire(k1.size);
    expect(h.completes()).toEqual([s, s + kw, s + 2 * kw, 2 * s + 2 * kw, 3 * s + 2 * kw]);
  });

  it('a line that is not backlogged (only the frame on the wire) commits the control frame the FIFO way, in P3 as in P2', () => {
    const runs = (['P3', 'P2'] as const).map((profile) => {
      const h = serial({ options: { profile } });
      const d0 = h.send(h.data(), 0);
      const kr = h.send(h.control(), 10 * MS);
      expect(kr.txStart).toBe(d0.txEnd);
      h.run(10 * SEC);
      return JSON.stringify([h.trace, h.dispatched]);
    });
    expect(runs[0]).toBe(runs[1]);
  });

  it('a corrupted displaced frame still arrives corrupted, a lost one never arrives, and both txCompletes move', () => {
    for (const impairments of [{ corruptPct: 100 }, { lossPct: 100 }]) {
      const h = serial({ options: { profile: 'P3' }, impairments });
      const d = [h.data(), h.data()];
      d.forEach((p) => h.send(p, 0));
      const k = h.control();
      h.send(k, 10 * MS);
      h.run(10 * SEC);
      const s = wire(d[0]!.size);
      const kw = wire(k.size);
      expect(h.completes()).toEqual([s, s + kw, 2 * s + kw]);
      const arrivals = h.dispatched.filter((x) => x.kind === 'arrival');
      if (impairments.corruptPct === 100) {
        expect(arrivals.map((a) => [a.pdu, a.corrupted])).toEqual([[d[0]!.id, true], [k.id, true], [d[1]!.id, true]]);
      } else {
        expect(arrivals).toEqual([]);
      }
    }
  });

  it('the five draws per frame are untouched: a displaced frame keeps its jitter and loss outcome', () => {
    const outcome = (profile: DefaultsProfile) => {
      const h = serial({ options: { profile }, impairments: { jitterNs: 3 * MS, lossPct: 30 }, seed: 5 });
      const d = Array.from({ length: 6 }, () => h.data());
      const sent = d.map((p) => h.send(p, 0));
      const k = h.control();
      h.send(k, 10 * MS);
      h.run(10 * SEC);
      // per data frame: lost, or its arrival past the end of its serialization (moved by the control frame in P3)
      const moved = profile === 'P3' ? wire(k.size) : 0;
      return d.map((p, i) => (sent[i]!.lost === true ? 'lost' : h.arrivalOf(p.id)!.at - sent[i]!.txEnd - (i === 0 ? 0 : moved)));
    };
    expect(outcome('P3')).toEqual(outcome('P2'));
  });

  it('the worker\'s backlog watch keeps the sender due while a moved frame still waits past its announced end', () => {
    // a small last data frame behind the backlog; three control frames move it past the txEnd its frameTx announced
    const h = serial({ options: { profile: 'P3' } });
    const watch = createTxBacklogWatch();
    const watchOld = createTxBacklogWatch();
    [h.data(), h.data()].forEach((p) => h.send(p, 0));
    const tail = h.data(8);
    const tailTx = h.send(tail, 0);
    const ks = [h.control(), h.control(), h.control()];
    ks.forEach((k, i) => h.send(k, (i + 1) * 10 * MS));
    for (const e of h.trace) {
      watch.observe(e);
      watchOld.observe(e);
    }
    const announced = tailTx.txEnd;
    const moved = ks.reduce((n, k) => n + wire(k.size), 0);
    expect(moved).toBeGreaterThan(wire(tail.size)); // the tail frame has not even started at its announced end
    const real = announced + moved;
    expect(h.port(R1).tx.busyUntil).toBe(real);
    const busyAt =
      (t: SimTime) =>
      (id: DeviceId): boolean =>
        id === R1.device && deviceTxBusy({ ports: new Map([[SE0, h.port(R1)]]) }, t);
    h.run(announced);
    expect(h.model.queued(R1, announced).map((q) => q.pdu.id)).toEqual([tail.id]);
    // without the probe the sender is forgotten at the announced end while the tail frame still waits (a stale backlog)
    expect(watchOld.drain(announced)).toEqual([R1.device]);
    expect(watchOld.drain(announced + 1)).toEqual([]);
    // with it the sender stays due until its transmitter is idle, then is reported once more and forgotten
    expect(watch.drain(announced, busyAt(announced))).toEqual([R1.device]);
    h.run(real - 1);
    expect(watch.drain(real - 1, busyAt(real - 1))).toEqual([R1.device]);
    h.run(real);
    expect(h.model.queued(R1, real)).toEqual([]);
    expect(watch.drain(real, busyAt(real))).toEqual([R1.device]);
    expect(watch.drain(real + 1, busyAt(real + 1))).toEqual([]);
  });

  it('a link abort cancels the queued frames for good: a control frame after the restore never brings one back', () => {
    const h = serial({ options: { profile: 'P3' } });
    const d = [h.data(), h.data(), h.data()];
    const sent = d.map((p) => h.send(p, 0));
    h.run(10 * MS);
    h.model.cut('l_se', true, 10 * MS);
    expect(h.trace.filter((e) => e.kind === 'frameAbort').map((e) => (e as { pdu: { id: PduId } }).pdu.id)).toEqual(d.map((p) => p.id));
    h.model.cut('l_se', false, 20 * MS);
    expect(h.port(R1).operUp).toBe(true);
    // the aborted frames still occupy the transmitter (their txCompletes are pending) but have no record: FIFO slot
    const kr = h.send(h.control(), 30 * MS);
    expect(kr.txStart).toBe(sent[2]!.txEnd);
    h.run(10 * SEC);
    for (const p of d) expect(h.arrivalOf(p.id), `aborted ${p.id}`).toBeUndefined();
  });
});
