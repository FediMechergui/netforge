/**
 * P2 acceptance — a multiplying loop stays bounded (ARCHITECTURE-P2 D23, §4.4, §7 W1 media, §10.1 row
 * `accept.p2.loop-storm-bounded`), on real worlds of `test/p2.world.ts`.
 *
 * Topology: two NF-C2960 joined by THREE parallel FastEthernet (100 Mb/s) cables, one PC on each switch, one
 * broadcast (PC1's ARP request for PC2).
 *  • P1 profile (no spanning tree), `runFor(1 s)` from the broadcast: `queue-full` drops are present; at the end, on
 *    every P2P port, queued plus in-flight frames ≤ `P2P_QUEUE_LIMIT + 1` (the memory bound); the events dispatched in
 *    that second are ≤ `links × 2 × ⌈1 s / slot⌉ × P2P_EVENTS_PER_FRAME × 1.1` with slot = 84 bytes × 8 / 100 Mb/s
 *    = 6.72 µs (the line-rate event bound; `P2P_EVENTS_PER_FRAME` is the W1 media measurement). No fixed
 *    events-per-second constant appears here: the bound follows from the link count, their speed and the slot.
 *  • P2 profile: after convergence (`runFor(65 s)` first), the same broadcast gives zero `queue-full` drops and each
 *    PC receives it exactly once.
 *
 * `links` counts every P2P cable of the world (the three parallel cables and the two PC cables): the storm's copies
 * are flooded onto the PC ports too, and every cable runs at 100 Mb/s (the PCs' gigabit NICs negotiate down to the
 * switches' FastEthernet ports; the test asserts it).
 */
import { describe, expect, it } from 'vitest';
import type { PortId } from '../src/contracts/ids.js';
import { P2P_QUEUE_LIMIT } from '../src/contracts/link.js';
import { ETH_PHY_OVERHEAD } from '../src/contracts/pdu.js';
import { SPEED_100M } from '../src/contracts/port.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { configText } from '../src/sim/scenarios/kit.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { createP2Simulation } from './p2.world.js';
import { P2P_EVENTS_PER_FRAME } from './p2p.constants.js';
import { ofKind, output } from './sim.harness.js';

const SWITCH = 'switch.nfc2960';
const PC = 'pc.nfpc';
const FA1: PortId = 'FastEthernet0/1';
/** The three parallel cables: Fa0/22–24 on both switches. */
const PARALLEL: readonly PortId[] = ['FastEthernet0/22', 'FastEthernet0/23', 'FastEthernet0/24'];
const PARALLEL_LINKS = ['l_a', 'l_b', 'l_c'] as const;
/** Every P2P cable of the world once the parallel ones are cabled. */
const ALL_LINKS: readonly [link: string, switchEnd: [string, PortId]][] = [
  ['l_pc1', ['sw1', FA1]],
  ['l_pc2', ['sw2', FA1]],
  ...PARALLEL.map((p, i): [string, [string, PortId]] => [PARALLEL_LINKS[i]!, ['sw1', p]]),
];
/** A minimum-size frame on the wire: 64 bytes plus preamble, SFD and inter-frame gap. */
const SLOT_BYTES = 64 + ETH_PHY_OVERHEAD;
const SLOT_NS_100M = (SLOT_BYTES * 8 * 1_000_000_000) / SPEED_100M;

/** Two switches with a PC each. With `cabled`, the three parallel cables are present from the start. */
function stormWorld(profile: 'P1' | 'P2', cabled: boolean): Simulation {
  const sim = createP2Simulation({ seed: 7, profile });
  sim.addDevice({ id: 'sw1', type: SWITCH, name: 'SW1', startupConfig: configText([['hostname SW1']]) });
  sim.addDevice({ id: 'sw2', type: SWITCH, name: 'SW2', startupConfig: configText([['hostname SW2']]) });
  sim.addDevice({ id: 'pc1', type: PC, name: 'PC1', startupConfig: pcConfig('PC1', '10.0.0.1', '255.255.255.0') });
  sim.addDevice({ id: 'pc2', type: PC, name: 'PC2', startupConfig: pcConfig('PC2', '10.0.0.2', '255.255.255.0') });
  sim.addLink({ id: 'l_pc1', a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: FA1 } });
  sim.addLink({ id: 'l_pc2', a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: 'sw2', port: FA1 } });
  if (cabled) cableParallel(sim);
  return sim;
}

function cableParallel(sim: Simulation): void {
  PARALLEL.forEach((port, i) => sim.addLink({ id: PARALLEL_LINKS[i]!, a: { device: 'sw1', port }, b: { device: 'sw2', port } }));
}

/** Every trace event of a run, collected through `onTrace` so the ring's capacity plays no part. */
function collect(sim: Simulation): TraceEvent[] {
  const out: TraceEvent[] = [];
  sim.onTrace((ev) => out.push(ev));
  return out;
}

/** Queued plus in-flight frames of every P2P port of every device, by `device/port`. */
function occupancy(sim: Simulation): Map<string, number> {
  const out = new Map<string, number>();
  for (const dev of sim.devices()) {
    for (const [id, port] of dev.ports) {
      if (port.spec.kind !== 'ethernet') continue;
      out.set(`${dev.id}/${id}`, port.tx.queue);
    }
  }
  for (const f of sim.snapshot().inflight) {
    const key = `${f.from.device}/${f.from.port}`;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/** PC1's broadcast: the ARP request its ping for PC2 sends first. */
function broadcast(sim: Simulation): { session: ReturnType<Simulation['cli']['open']> } {
  const session = sim.cli.open('pc1', 'console');
  const r = sim.cli.exec(session, 'ping 10.0.0.2');
  expect(r.error).toBeUndefined();
  return { session };
}

describe('accept P2 loop-storm-bounded: P1 profile (no spanning tree)', () => {
  it('one broadcast over three parallel cables storms, yet memory stays at the queue cap and events at line rate', () => {
    const sim = stormWorld('P1', false);
    // the switches boot at 30 s with their PC links; the loop is cabled afterwards so the only broadcast is PC1's
    sim.runUntil(40 * SEC);
    const cabledAt = sim.trace(0).next;
    cableParallel(sim);
    sim.runUntil(41 * SEC);
    for (const [link, [dev, port]] of ALL_LINKS) {
      expect(sim.link(link)!.up, link).toBe(true);
      expect(sim.device(dev)!.portView(port)!.speedBps, `${dev} ${port}`).toBe(SPEED_100M);
    }
    expect(ofKind(sim.trace(cabledAt).events, 'frameTx')).toEqual([]);
    const cursor = sim.trace(0).next;
    broadcast(sim);
    const window = sim.runFor(1 * SEC);
    // the storm is real: the ARP request multiplied until the egress queues filled (the ring keeps the window's tail)
    const tail = sim.trace(cursor);
    const queueFull = ofKind(tail.events, 'drop').filter((e) => e.reason === 'queue-full');
    expect(queueFull.length).toBeGreaterThan(0);
    expect(tail.events.length + tail.dropped).toBeGreaterThan(1000);
    // memory bound (D23): no P2P port holds more than the queue cap plus the frame on the wire
    const occ = occupancy(sim);
    expect(occ.size).toBeGreaterThan(0);
    for (const [key, n] of occ) expect(n, key).toBeLessThanOrEqual(P2P_QUEUE_LIMIT + 1);
    expect(Math.max(...occ.values())).toBeGreaterThanOrEqual(P2P_QUEUE_LIMIT);
    // event bound = line rate: links × 2 directions × slots per second × events per frame × 1.1
    const bound = ALL_LINKS.length * 2 * Math.ceil((1 * SEC) / SLOT_NS_100M) * P2P_EVENTS_PER_FRAME * 1.1;
    expect(SLOT_NS_100M).toBe(6720);
    expect(window.events).toBeLessThanOrEqual(bound);
    expect(window.events).toBeGreaterThan(0);
  }, 300_000); // one simulated second at line rate on five links is a few million scheduler events
});

describe('accept P2 loop-storm-bounded: P2 profile (spanning tree)', () => {
  it('after convergence the same broadcast is delivered once to each PC with no queue-full drop', () => {
    const sim = stormWorld('P2', true);
    const evs = collect(sim);
    sim.runFor(65 * SEC);
    for (const [link] of ALL_LINKS) expect(sim.link(link)!.up, link).toBe(true);
    const before = evs.length;
    const { session } = broadcast(sim);
    sim.runToIdle();
    const since = evs.slice(before);
    expect(ofKind(since, 'drop').filter((e) => e.reason === 'queue-full')).toEqual([]);
    expect(output(since, session)).toContain('Sent 5, received 5, lost 0');
    const request = ofKind(since, 'pduCreated').find((e) => e.device === 'pc1' && e.pdu.tag === 'arp-request');
    expect(request).toBeDefined();
    const copies = ofKind(since, 'frameRx').filter((e) => e.pdu.proto === 'arp' && e.pdu.summary.includes('tell 10.0.0.1'));
    expect(copies.filter((e) => e.device === 'pc2')).toHaveLength(1);
    expect(copies.filter((e) => e.device === 'pc1')).toHaveLength(0);
    expect(ofKind(evs, 'drop').filter((e) => e.reason === 'queue-full')).toEqual([]);
  });
});
