/**
 * sim.snapshot-txqueue — `PortSnapshot.txBacklog`, the virtual FIFO of an egress port (ARCHITECTURE-P3 D16, §2.8,
 * §3.5 step 5, §4.3, ruling R6 and R15; §7 W2 sim; sim/snapshot-cache.ts).
 *
 * On `staged.world` at stage P3, the test injector (test/inject.ts) bursts IPv4/UDP frames out of one gigabit port,
 * so they queue behind the busy transmitter (the P2P medium commits each frame's `txStart` at enqueue). Pinned:
 *   • while frames wait, the sender's port carries `txBacklog {depth, frames}`: every waiting frame counted, the first
 *     8 listed oldest first as `{pdu, summary, txStart, bytes, dscp}` (the DSCP recorded at enqueue); the frame on the
 *     wire is not waiting; the receiver and every other port carry none; the P0 count `txQueue` is untouched;
 *   • the member disappears once the backlog has drained, and no port of an UNCONGESTED world ever carries it, at any
 *     event (a ping across a switch, and a spaced injection, snapshotted after every dispatched event);
 *   • two worlds built and driven alike give byte-identical snapshots, the member included;
 *   • the dirtying (D16): `createTxBacklogWatch`, fed the drained trace, reports the sender while its backlog lasts
 *     (an enqueue that leaves a backlog, then every txComplete of that port) and once more after it, then forgets it;
 *     a frame that starts at once reports nothing;
 *   • the load behind the view (M13, ruling R5): the Traffic app's `hostRequest` rows `traffic.start` / `traffic.stop`
 *     reach the host's traffic daemon (a stand-in until the W4 flip registers the real one), refusing a malformed
 *     request without spending a ticket;
 *   • the other display source of the qos overlay, `PortSnapshot.qos`: a copy of `DeviceRuntime.qosCounters(port)`
 *     (against a fake runtime: the real counters are the W3 device item's), present only where the runtime has one.
 */
import { describe, expect, it } from 'vitest';
import type { LayerSpec } from '../src/contracts/pdu.js';
import type { Process, ProcessRequest, TrafficFlowSpec } from '../src/contracts/process.js';
import { ETHERTYPE_IPV4, IPPROTO_UDP } from '../src/contracts/pdu.js';
import type { DeviceRuntime } from '../src/contracts/device.js';
import type { PortQosView, PortSnapshot, SimSnapshot } from '../src/contracts/snapshot.js';
import type { HostAppRequest, Simulation } from '../src/contracts/simulation.js';
import { MS, SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { TX_BACKLOG_FRAMES, buildPortSnapshot, copyQosView, createTxBacklogWatch, txBacklogOf, type SnapshotSources } from '../src/sim/snapshot-cache.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { HOST_APP_PROCESS } from '../src/sim/simulation.js';
import { INJECTOR_HOST_TYPE, injectFrames, withInjector } from './inject.js';
import { createStagedSimulation } from './staged.world.js';

const GI0 = 'GigabitEthernet0';

/** An IPv4/UDP datagram to the discard port with `dscp`, from the injector to PC1. */
function datagram(dstMac: string, dscp: number): LayerSpec[] {
  return [
    { proto: 'ethernet', fields: { dst: dstMac, src: '02:00:00:00:99:01', type: ETHERTYPE_IPV4 } },
    { proto: 'ipv4', fields: { src: '10.0.0.9', dst: '10.0.0.1', protocol: IPPROTO_UDP, ttl: 64, dscp } },
    { proto: 'udp', fields: { srcPort: 40000, dstPort: 9 } },
    { proto: 'payload', fields: { data: new Uint8Array(1000) } },
  ];
}

/** INJ (the test injector host) cabled to PC1, both booted and settled. */
function injectorWorld(seed = 11): { sim: Simulation; pcMac: string } {
  const sim = createStagedSimulation({ seed, stage: 'P3', factories: withInjector() });
  sim.addDevice({ id: 'inj', type: INJECTOR_HOST_TYPE, name: 'INJ' });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: pcConfig('PC1', '10.0.0.1', '255.255.255.0') });
  sim.addLink({ a: { device: 'inj', port: GI0 }, b: { device: 'pc1', port: GI0 } });
  sim.runFor(60 * SEC);
  sim.runToIdle();
  return { sim, pcMac: sim.device('pc1')!.port(GI0)!.mac };
}

/** Every port snapshot that carries a backlog, as `device/port`. */
function backlogged(snap: SimSnapshot): string[] {
  const out: string[] = [];
  for (const d of snap.devices) for (const p of d.ports) if (p.txBacklog !== undefined) out.push(`${d.id}/${p.id}`);
  return out;
}

const portOf = (snap: SimSnapshot, device: string, port: string): PortSnapshot => snap.devices.find((d) => d.id === device)!.ports.find((p) => p.id === port)!;

describe('txBacklog under congestion', () => {
  it('lists the waiting frames of the sender (8 of them, oldest first, with their DSCP) and only there', () => {
    const { sim, pcMac } = injectorWorld();
    const ticket = injectFrames(sim, { from: 'inj', port: GI0, frames: [datagram(pcMac, 46), datagram(pcMac, 0)], count: 12, spacingNs: 0 });
    sim.runUntil(ticket.lastAt); // every frame enqueued at one instant; the first is on the wire
    const snap = sim.snapshot();
    expect(backlogged(snap)).toEqual([`inj/${GI0}`]);
    const port = portOf(snap, 'inj', GI0);
    const backlog = port.txBacklog!;
    expect(backlog.depth).toBe(11);
    expect(backlog.frames).toHaveLength(TX_BACKLOG_FRAMES);
    expect(backlog.frames.map((f) => f.dscp)).toEqual([0, 46, 0, 46, 0, 46, 0, 46]);
    const starts = backlog.frames.map((f) => f.txStart);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(starts[0]).toBeGreaterThan(sim.now);
    for (const f of backlog.frames) {
      expect(f.summary.id).toBe(f.pdu);
      expect(f.bytes).toBe(f.summary.size);
      expect(f.summary.tag).toBe('injected');
    }
    // the frame on the wire is the oldest, and it is not waiting
    const wire = snap.inflight.filter((l) => l.from.device === 'inj');
    expect(wire).toHaveLength(1);
    expect(backlog.frames.some((f) => f.pdu === wire[0]!.pdu.id)).toBe(false);
    expect(backlog.frames[0]!.pdu).toBeGreaterThan(wire[0]!.pdu.id);
    // the P0 frame count is untouched: 12 accepted, none finished yet
    expect(port.txQueue).toBe(12);
    // the member is the last one of the port (appended after every older member)
    expect(Object.keys(port).at(-1)).toBe('txBacklog');
  });

  it('shrinks as frames start and is gone once the backlog has drained', () => {
    const { sim, pcMac } = injectorWorld();
    injectFrames(sim, { from: 'inj', port: GI0, frames: [datagram(pcMac, 46)], count: 12, spacingNs: 0 });
    sim.runUntil(sim.now);
    const first = portOf(sim.snapshot(), 'inj', GI0).txBacklog!;
    const second = first.frames[1]!.txStart;
    sim.runUntil(second); // two more frames have started by then
    const later = portOf(sim.snapshot(), 'inj', GI0).txBacklog!;
    expect(later.depth).toBe(first.depth - 2);
    expect(later.frames[0]!.pdu).toBe(first.frames[2]!.pdu);
    sim.runFor(10 * MS);
    expect(backlogged(sim.snapshot())).toEqual([]);
    expect(portOf(sim.snapshot(), 'inj', GI0)).not.toHaveProperty('txBacklog');
  });

  it('two worlds built and driven alike give byte-identical snapshots, the backlog included', () => {
    const run = (): string => {
      const { sim, pcMac } = injectorWorld(5);
      injectFrames(sim, { from: 'inj', port: GI0, frames: [datagram(pcMac, 10), datagram(pcMac, 46), datagram(pcMac, 0)], count: 20, spacingNs: 1000 });
      sim.runFor(50_000);
      return JSON.stringify(sim.snapshot());
    };
    const a = run();
    expect(a).toContain('"txBacklog"');
    expect(run()).toBe(a);
  });
});

describe('txBacklog on an uncongested world', () => {
  it('a spaced injection never queues: no port carries the member after any event', () => {
    const { sim, pcMac } = injectorWorld();
    const ticket = injectFrames(sim, { from: 'inj', port: GI0, frames: [datagram(pcMac, 46)], count: 10, spacingNs: 100_000 });
    let steps = 0;
    while (sim.nextEventTime() !== undefined && sim.nextEventTime()! <= ticket.lastAt + MS) {
      sim.step();
      steps++;
      expect(backlogged(sim.snapshot()), `after event ${steps}`).toEqual([]);
    }
    expect(steps).toBeGreaterThan(20);
  });

  it('a ping across a switch never queues', () => {
    const sim = createStagedSimulation({ seed: 3, stage: 'P3' });
    sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: pcConfig('PC1', '10.0.0.1', '255.255.255.0') });
    sim.addDevice({ id: 'pc2', type: 'pc.nfpc', name: 'PC2', startupConfig: pcConfig('PC2', '10.0.0.2', '255.255.255.0') });
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1' });
    sim.addLink({ a: { device: 'pc1', port: GI0 }, b: { device: 'sw1', port: 'FastEthernet0/1' } });
    sim.addLink({ a: { device: 'pc2', port: GI0 }, b: { device: 'sw1', port: 'FastEthernet0/2' } });
    sim.runFor(60 * SEC);
    sim.runToIdle();
    const s = sim.cli.open('pc1', 'console');
    sim.cli.exec(s, 'ping 10.0.0.2');
    let steps = 0;
    let frames = 0;
    const off = sim.onTrace((ev) => {
      if (ev.kind === 'frameTx') frames++;
    });
    // every event until the ping job ends: the echoes, the replies and everything the devices do meanwhile
    for (; steps < 20_000 && sim.cli.session(s)!.busy && sim.step() !== undefined; steps++) expect(backlogged(sim.snapshot()), `after event ${steps}`).toEqual([]);
    off();
    expect(frames).toBeGreaterThan(8);
  });

  it('txBacklogOf: none without a waiting frame', () => {
    expect(txBacklogOf([])).toBeUndefined();
  });
});

describe('the dirtying of a backlog (createTxBacklogWatch)', () => {
  it('reports the sender while its backlog lasts and once more after, then forgets it', () => {
    const { sim, pcMac } = injectorWorld();
    const watch = createTxBacklogWatch();
    let cursor = sim.trace(0).next;
    const feed = (): void => {
      const drained = sim.trace(cursor);
      cursor = drained.next;
      for (const ev of drained.events) watch.observe(ev);
    };
    injectFrames(sim, { from: 'inj', port: GI0, frames: [datagram(pcMac, 46)], count: 4, spacingNs: 0 });
    sim.runUntil(sim.now);
    feed();
    const t0 = sim.now;
    expect(watch.drain(t0)).toEqual(['inj']);
    const last = portOf(sim.snapshot(), 'inj', GI0).txBacklog!.frames.at(-1)!;
    sim.runUntil(last.txStart); // the backlog has just emptied: still due until the last frame ends
    feed();
    expect(portOf(sim.snapshot(), 'inj', GI0)).not.toHaveProperty('txBacklog');
    expect(watch.drain(sim.now)).toEqual(['inj']);
    sim.runFor(MS);
    feed();
    expect(watch.drain(sim.now)).toEqual(['inj']); // the last frame ended since the last drain: reported once more
    expect(watch.drain(sim.now)).toEqual([]);
  });

  it('a frame that starts at once, and every other event, reports nothing; clear forgets', () => {
    const watch = createTxBacklogWatch();
    const pdu = { id: 1, proto: 'ipv4' as const, size: 100, summary: 'x' };
    const tx = (t: number, txStart: number): TraceEvent => ({
      t, kind: 'frameTx', pdu, link: 'l_1', from: { device: 'd_a', port: 'Gi0' }, to: { device: 'd_b', port: 'Gi0' }, txStart, txEnd: txStart + 10, arrive: txStart + 12,
    });
    watch.observe(tx(5, 5));
    watch.observe({ t: 5, kind: 'frameRx', pdu, device: 'd_b', port: 'Gi0' });
    expect(watch.drain(5)).toEqual([]);
    watch.observe(tx(5, 15));
    watch.observe(tx(5, 25));
    watch.clear();
    expect(watch.drain(5)).toEqual([]);
    watch.observe(tx(5, 15));
    expect(watch.drain(100)).toEqual(['d_a']);
    expect(watch.drain(100)).toEqual([]);
  });
});

describe('hostRequest: the Traffic app (M13)', () => {
  /** A stand-in traffic daemon that records the requests it receives. */
  function traffic(seen: ProcessRequest[]): Process {
    return {
      name: 'traffic',
      onPdu: () => [],
      onTimer: () => [],
      onConfig: () => [],
      onRequest: (_ctx, req) => {
        seen.push(req);
        return [];
      },
      stateSnapshot: () => ({ process: 'traffic', state: {} }),
      debugEvents: () => [],
    };
  }

  it('maps traffic.start and traffic.stop to the traffic daemon; a malformed request spends no ticket', () => {
    expect(HOST_APP_PROCESS['traffic.start']).toBe('traffic');
    expect(HOST_APP_PROCESS['traffic.stop']).toBe('traffic');
    const seen: ProcessRequest[] = [];
    const sim = createStagedSimulation({ seed: 8, stage: 'P3', factories: { traffic: () => traffic(seen) } });
    sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1' });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
    sim.runFor(60 * SEC);
    const bad = [
      { app: 'traffic.start' },
      { app: 'traffic.start', flow: null },
      { app: 'traffic.start', flow: { sizeBytes: 100, pps: 50 } },
      { app: 'traffic.start', flow: { dst: ' ', sizeBytes: 100, pps: 50 } },
      { app: 'traffic.stop' },
      { app: 'traffic.stop', id: 7 },
    ] as unknown as HostAppRequest[];
    for (const req of bad) {
      let message = '';
      try {
        sim.hostRequest('pc1', req);
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message, JSON.stringify(req)).not.toBe('');
      expect(message).not.toMatch(/TypeError|undefined|is not a function/);
    }
    const flow: TrafficFlowSpec = { dst: '10.0.0.2', sizeBytes: 60, pps: 50, dscp: 46, count: 10 };
    expect(sim.hostRequest('pc1', { app: 'traffic.start', flow })).toEqual({ requestId: 'r_1', process: 'traffic' });
    expect(sim.hostRequest('pc1', { app: 'traffic.stop', id: 'f1' })).toEqual({ requestId: 'r_2', process: 'traffic' });
    expect(seen).toEqual([
      { kind: 'traffic.start', flow },
      { kind: 'traffic.stop', id: 'f1' },
    ]);
    expect((seen[0] as Extract<ProcessRequest, { kind: 'traffic.start' }>).flow).not.toBe(flow); // a copy
    // a router runs no traffic daemon
    expect(() => sim.hostRequest('r1', { app: 'traffic.stop', id: 'f1' })).toThrow(/traffic/);
  });
});

describe('PortSnapshot.qos (a fake runtime with QoS counters)', () => {
  it('copies the runtime view of a port with a policy, last but the backlog; ports without one carry none', () => {
    const { sim } = injectorWorld();
    const real = sim.device('pc1')!;
    const view: PortQosView = {
      input: 'MARK',
      classes: [
        { name: 'VOIP', matched: 3, matchedBytes: 180, marked: 3 },
        { name: 'class-default', matched: 2, matchedBytes: 2008, marked: 0 },
      ],
      queue: {
        policy: 'LLQ',
        strategy: 'class-based',
        refBps: 128_000,
        classes: [{ name: 'VOIP', kind: 'priority', depth: 0, limit: 64, matched: 3, matchedBytes: 180, sent: 3, tailDrops: 0, policed: 0, offeredBps30s: 26_000 }],
      },
    };
    const asked: string[] = [];
    // the real runtime, with QoS counters on its one port (the W3 device item implements the real ones)
    const fake = new Proxy(real, {
      get: (target, key) =>
        key === 'qosCounters'
          ? (port: string): PortQosView | undefined => {
              asked.push(port);
              return port === GI0 ? view : undefined;
            }
          : Reflect.get(target, key, target),
    }) as DeviceRuntime;
    const links = { radioPortView: () => undefined, queued: () => [] } as unknown as SnapshotSources['links'];
    const s = buildPortSnapshot(fake, real.port(GI0)!, { links }, sim.now);
    expect(asked).toEqual([GI0]);
    expect(s.qos).toEqual(view);
    expect(s.qos).not.toBe(view);
    expect(s.qos!.classes[0]).not.toBe(view.classes[0]);
    expect(s.qos!.queue).not.toBe(view.queue);
    expect(Object.keys(s).at(-1)).toBe('qos');
    // the real runtime reports none yet: no port of the world carries the member
    for (const d of sim.snapshot().devices) for (const p of d.ports) expect(p, `${d.id}/${p.id}`).not.toHaveProperty('qos');
    expect(copyQosView({ classes: [] })).toEqual({ classes: [] });
  });
});
