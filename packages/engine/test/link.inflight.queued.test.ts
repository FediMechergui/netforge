/**
 * link.inflight.queued — the virtual FIFO of an egress port (ARCHITECTURE-P3 D16, §2.8, ruling R15; §7 W2 media;
 * link/inflight.ts `queued`, link/link.ts `LinkModelImpl.queued`, link/media/p2p.ts).
 *
 * `queued(ref, now)` lists the legs port `ref` has committed with `txStart > now` — the frames waiting behind its busy
 * transmitter — oldest first in the `visible` order `(txStart, pdu.id, link, to)`, each with the DSCP its medium
 * recorded at enqueue (`frameDscp`: the outermost IPv4 `dscp` or IPv6 `trafficClass >> 2`; absent without an IP
 * header). It is a pure read (nothing pruned, copies returned), an uncongested port returns none, and a frame that
 * starts at once records no DSCP at all, so the P0 legs keep their shape.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId, PduId, PortId, PortRef } from '../src/contracts/ids.js';
import { portKey } from '../src/contracts/ids.js';
import type { LinkModelDeps } from '../src/contracts/link.js';
import { NO_IMPAIRMENTS } from '../src/contracts/link.js';
import type { LayerSpec, Pdu } from '../src/contracts/pdu.js';
import { ETH_PHY_OVERHEAD, ETHERTYPE_IPV4, ETHERTYPE_IPV6 } from '../src/contracts/pdu.js';
import { SPEED_100M, emptyCounters } from '../src/contracts/port.js';
import type { PortState } from '../src/contracts/port.js';
import type { PduSummary } from '../src/contracts/trace.js';
import { serializationNs } from '../src/contracts/time.js';
import { createRng } from '../src/core/prng.js';
import { createScheduler } from '../src/core/scheduler.js';
import { createInflightRegistry, frameDscp } from '../src/link/inflight.js';
import { createLinkModel } from '../src/link/link.js';
import type { InflightLeg } from '../src/link/media/types.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { arpFrame, meta } from './link.segment.harness.js';
import { INERT_LINK_DEPS, testPortSpec } from './port.fixtures.js';

const A: PortRef = { device: 'd_a', port: 'Gi0' };
const B: PortRef = { device: 'd_b', port: 'Gi0' };
const C: PortRef = { device: 'd_c', port: 'Gi0' };

const summary = (id: PduId): PduSummary => ({ id, proto: 'ipv4', size: 100, summary: `frame ${id}` });
const leg = (id: PduId, from: PortRef, to: PortRef, txStart: number, extra: Partial<InflightLeg> = {}): InflightLeg => ({
  pdu: summary(id),
  link: 'l_1',
  from,
  to,
  txStart,
  txEnd: txStart + 10,
  arrive: txStart + 15,
  ...extra,
});

describe('InflightRegistry.queued', () => {
  it('lists only the legs of that sender that have not started, oldest first, with their recorded DSCP', () => {
    const reg = createInflightRegistry();
    reg.add(leg(4, A, B, 30, { dscp: 46, arrivalSeq: 9 }));
    reg.add(leg(2, A, B, 10)); // on the wire at now = 10
    reg.add(leg(3, A, B, 20, { dscp: 0 }));
    reg.add(leg(5, B, A, 40, { dscp: 10 })); // another sender
    reg.add(leg(1, A, C, 30, { link: 'l_2' })); // same txStart as pdu 4: pdu id breaks the tie
    const q = reg.queued(A, 10);
    expect(q.map((f) => f.pdu.id)).toEqual([3, 1, 4]);
    expect(q[0]).toEqual({ pdu: summary(3), link: 'l_1', from: A, to: B, txStart: 20, txEnd: 30, arrive: 35, dscp: 0 });
    expect(q[1]).not.toHaveProperty('dscp');
    expect(q[2]!.dscp).toBe(46);
    expect(q[2]).not.toHaveProperty('arrivalSeq'); // a public copy
    expect(reg.queued(B, 10).map((f) => [f.pdu.id, f.dscp])).toEqual([[5, 10]]);
    expect(reg.queued(C, 10)).toEqual([]);
    expect(reg.queued({ device: 'd_x', port: 'Gi9' }, 10)).toEqual([]);
  });

  it('is a pure read: nothing is pruned, and the visible list still sees the frame on the wire', () => {
    const reg = createInflightRegistry();
    reg.add(leg(1, A, B, 0)); // arrived by 50
    reg.add(leg(2, A, B, 60));
    expect(reg.queued(A, 50).map((f) => f.pdu.id)).toEqual([2]);
    expect(reg.size()).toBe(2);
    expect(reg.visible(50)).toEqual([]); // pdu 1 arrived (pruned by visible), pdu 2 has not started
    expect(reg.size()).toBe(1);
    expect(reg.queued(A, 59).map((f) => f.pdu.id)).toEqual([2]);
    expect(reg.queued(A, 60)).toEqual([]); // starting now is not waiting
  });

  it('follows removal, deletion, replacement and clearing of a leg', () => {
    const reg = createInflightRegistry();
    reg.add(leg(1, A, B, 10));
    reg.add(leg(2, A, B, 20));
    reg.add(leg(3, A, B, 30));
    reg.remove(1, B);
    reg.delete(2, 'l_1', B);
    expect(reg.queued(A, 0).map((f) => f.pdu.id)).toEqual([3]);
    reg.add(leg(3, A, B, 40, { dscp: 18 })); // same identity: replaced, still one
    expect(reg.queued(A, 0).map((f) => [f.pdu.id, f.txStart, f.dscp])).toEqual([[3, 40, 18]]);
    reg.add(leg(6, A, C, 50, { link: 'l_2' }));
    reg.sweep(1000); // below the sweep threshold: no pass
    expect(reg.queued(A, 0)).toHaveLength(2);
    for (const l of reg.on('l_1')) reg.delete(l.pdu.id, l.link, l.to);
    expect(reg.queued(A, 0).map((f) => f.pdu.id)).toEqual([6]);
  });
});

describe('frameDscp', () => {
  const pdus = createPduFactory();
  const build = (layers: LayerSpec[]): Pdu => pdus.build(layers, meta());
  const eth = (type: number): LayerSpec => ({ proto: 'ethernet', fields: { dst: '02:00:00:00:00:02', src: '02:00:00:00:00:01', type } });
  const udp: LayerSpec[] = [{ proto: 'udp', fields: { srcPort: 1, dstPort: 9 } }, { proto: 'payload', fields: { data: new Uint8Array(4) } }];

  it('reads the outermost IP header: IPv4 dscp, IPv6 traffic class >> 2; none without IP', () => {
    expect(frameDscp(build([eth(ETHERTYPE_IPV4), { proto: 'ipv4', fields: { src: '10.0.0.1', dst: '10.0.0.2', protocol: 17, dscp: 46 } }, ...udp]))).toBe(46);
    expect(frameDscp(build([eth(ETHERTYPE_IPV4), { proto: 'ipv4', fields: { src: '10.0.0.1', dst: '10.0.0.2', protocol: 17 } }, ...udp]))).toBe(0);
    expect(frameDscp(build([eth(ETHERTYPE_IPV6), { proto: 'ipv6', fields: { src: '2001:db8::1', dst: '2001:db8::2', nextHeader: 17, trafficClass: 0xb8 } }, ...udp]))).toBe(46);
    expect(frameDscp(build(arpFrame('02:00:00:00:00:01')))).toBeUndefined();
    expect(frameDscp({ layers: [] })).toBeUndefined();
  });
});

describe('LinkModelImpl.queued over the P2P virtual FIFO', () => {
  function cable() {
    const ports = new Map<string, PortState>();
    const scheduler = createScheduler();
    const pdus = createPduFactory();
    const deps: LinkModelDeps = {
      ...INERT_LINK_DEPS,
      scheduler,
      trace: { emit: () => undefined },
      rng: createRng(2).split('links'),
      port: (ref) => ports.get(portKey(ref)),
      deviceUp: () => true,
      pdus,
    };
    const add = (device: DeviceId, name: PortId, mac: string): PortRef => {
      const ref: PortRef = { device, port: name };
      ports.set(portKey(ref), {
        id: name,
        spec: testPortSpec({ name, short: name, kind: 'ethernet', speedBps: SPEED_100M, role: 'routed' }),
        mac,
        adminUp: true,
        operUp: false,
        mtu: 1500,
        counters: emptyCounters(),
        l3: {},
        tx: { busyUntil: 0, queue: 0 },
        role: 'routed',
        ordinal: 1,
        encap: 'ethernet',
      });
      return ref;
    };
    const a = add('d_a', 'Gi0', '02:00:00:00:00:0a');
    const b = add('d_b', 'Gi0', '02:00:00:00:00:0b');
    const model = createLinkModel(deps);
    model.add({ id: 'l_1', a, b, media: 'copper-crossover', lengthM: 3, impairments: { ...NO_IMPAIRMENTS } }, 0);
    const ip = (dscp: number): Pdu =>
      pdus.build(
        [
          { proto: 'ethernet', fields: { dst: '02:00:00:00:00:0b', src: '02:00:00:00:00:0a', type: ETHERTYPE_IPV4 } },
          { proto: 'ipv4', fields: { src: '10.0.0.1', dst: '10.0.0.2', protocol: 17, dscp } },
          { proto: 'udp', fields: { srcPort: 5000, dstPort: 9 } },
          { proto: 'payload', fields: { data: new Uint8Array(900) } },
        ],
        meta(),
      );
    /** Dispatch every txComplete and arrival up to `until` through the model, then advance the clock. */
    const run = (until: number): void => {
      for (;;) {
        const at = scheduler.peekTime();
        if (at === undefined || at > until) break;
        const ev = scheduler.next()!;
        if (ev.kind === 'txComplete') model.onTxComplete({ device: ev.device, port: ev.port }, ev.at);
        else if (ev.kind === 'frameArrival') model.admit(ev, ev.at);
      }
      if (scheduler.now < until) scheduler.advanceTo(until);
    };
    return { model, scheduler, pdus, a, b, ip, run, port: (ref: PortRef) => ports.get(portKey(ref))! };
  }

  it('a burst leaves the first frame on the wire and the rest waiting, oldest first with their DSCP; it drains', () => {
    const h = cable();
    const frames = [h.ip(46), h.ip(0), h.ip(46), h.pdus.build(arpFrame('02:00:00:00:00:0a'), meta())];
    const results = frames.map((f) => h.model.transmit(h.a, f, 0));
    expect(results.every((r) => r.ok)).toBe(true);
    const tx = serializationNs(frames[0]!.size + ETH_PHY_OVERHEAD, SPEED_100M);
    const q = h.model.queued(h.a, 0);
    expect(q.map((f) => f.pdu.id)).toEqual(frames.slice(1).map((f) => f.id));
    expect(q.map((f) => f.dscp)).toEqual([0, 46, undefined]);
    expect(q[0]!.txStart).toBe(tx);
    expect(h.model.inflight(0).map((f) => f.pdu.id)).toEqual([frames[0]!.id]); // the visible list shows the wire only
    expect(h.model.queued(h.b, 0)).toEqual([]);
    expect(h.port(h.a).tx.queue).toBe(4);

    h.run(tx); // the first frame ends; the second starts
    expect(h.model.queued(h.a, tx).map((f) => f.pdu.id)).toEqual(frames.slice(2).map((f) => f.id));
    h.run(10 * tx);
    expect(h.model.queued(h.a, 10 * tx)).toEqual([]);
  });

  it('an uncongested port never waits: frames sent one after another start at once and record no DSCP', () => {
    const h = cable();
    let t = 0;
    for (let i = 0; i < 5; i++) {
      const r = h.model.transmit(h.a, h.ip(46), t);
      expect(r.ok && r.txStart).toBe(t);
      expect(h.model.queued(h.a, t)).toEqual([]);
      t += 1_000_000; // 1 ms apart, far longer than a frame takes
      h.run(t);
    }
  });
});
