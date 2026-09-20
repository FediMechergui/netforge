/**
 * P0.5 acceptance — hub collision domain (ARCHITECTURE-P1 §10.1 `accept.p05.hub-collision`; D4, §3.2, §3.4, §3.5).
 *
 * The hub template: PC1–PC3 on `hub.nfhub4`. The station cables negotiate 10 Mb half duplex by parallel detection and
 * form one segment of 3 stations and 4 repeater ports. A ping PC1 → PC3 reaches PC2 too, as a clone that PC2 drops as
 * not for it. Two pings started together collide, back off with slot counts drawn from `link:<station cable>:csma`,
 * and both complete; the collision counters agree between the medium and the ports, and `show interfaces` prints them.
 */
import { describe, expect, it } from 'vitest';
import { CSMA } from '../src/contracts/medium.js';
import { SPEED_10M } from '../src/contracts/port.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC, serializationNs } from '../src/contracts/time.js';
import { createRng } from '../src/core/prng.js';
import { hubCollision } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';
import { createdId, ofKind, output } from './sim.harness.js';
import { countIn, typeLines } from './accept.p05.harness.js';

const SEED = 1;
const NIC = 'GigabitEthernet0';
const SEGMENT = 'seg:l_pc1_hub1';
/** Station → its cable to the hub. */
const CABLE = { pc1: 'l_pc1_hub1', pc2: 'l_pc2_hub1', pc3: 'l_pc3_hub1' } as const;
const STATIONS = ['pc1', 'pc2', 'pc3'] as const;

/** The hub template, booted. */
function hubWorld(): Simulation {
  const sim = createSimulation({ seed: SEED });
  sim.loadTopology(hubCollision());
  sim.runFor(60 * SEC);
  return sim;
}

describe('accept P0.5: hub collision domain', () => {
  it('forms one 10 Mb half-duplex segment of 3 stations and 4 repeater ports, negotiated by parallel detection', () => {
    const sim = hubWorld();
    const segments = sim.snapshot().media!.segments;
    expect(segments).toHaveLength(1);
    const segment = segments[0]!;
    expect(segment).toMatchObject({ id: SEGMENT, bps: SPEED_10M, links: [CABLE.pc1, CABLE.pc2, CABLE.pc3] });
    expect(segment.members.map((m) => [m.port.device, m.port.port, m.role, m.duplex])).toEqual([
      ['pc1', NIC, 'station', 'half'],
      ['pc2', NIC, 'station', 'half'],
      ['pc3', NIC, 'station', 'half'],
      ['hub1', 'Ethernet0', 'repeater', 'half'],
      ['hub1', 'Ethernet1', 'repeater', 'half'],
      ['hub1', 'Ethernet2', 'repeater', 'half'],
      ['hub1', 'Ethernet3', 'repeater', 'half'],
    ]);

    for (const station of STATIONS) {
      const link = sim.link(CABLE[station])!;
      expect(link, station).toMatchObject({ up: true, negotiatedBps: SPEED_10M, segment: SEGMENT });
      expect(link.phy, station).toEqual({
        a: { speedBps: SPEED_10M, duplex: 'half', autoneg: true, via: 'parallel-detect' },
        b: { speedBps: SPEED_10M, duplex: 'half', autoneg: false, via: 'fixed' },
      });
      const nic = sim.device(station)!.port(NIC)!;
      expect(nic, station).toMatchObject({ speedBps: SPEED_10M, duplex: 'half', phy: { medium: 'segment', segment: SEGMENT, end: { via: 'parallel-detect', duplex: 'half' } } });
    }
    expect(ofKind(sim.trace(0).events, 'phyNegotiated').map((e) => [e.link, e.a.via, e.a.duplex, e.b.duplex])).toEqual(
      STATIONS.map((s) => [CABLE[s], 'parallel-detect', 'half', 'half']),
    );
  });

  it('delivers a PC1 → PC3 ping to PC2 too, as a clone that PC2 drops as not for it', () => {
    const sim = hubWorld();
    const cursor = sim.trace(0).next;
    const { session } = typeLines(sim, 'pc1', ['ping 10.0.0.3']);
    sim.runToIdle();
    const evs = sim.trace(cursor).events;
    expect(output(evs, session)).toContain('Sent 5, received 5, lost 0');

    const request = createdId(evs, 'pc1', 'ping#1');
    const heardByPc2 = ofKind(evs, 'frameRx').filter((e) => e.device === 'pc2' && e.pdu.parent === request);
    expect(heardByPc2).toHaveLength(1);
    const clone = heardByPc2[0]!.pdu.id;
    expect(clone).not.toBe(request);
    expect(sim.pdu(clone)!.meta.parent).toBe(request);
    expect(ofKind(evs, 'drop').filter((e) => e.pdu.id === clone)).toMatchObject([{ device: 'pc2', port: NIC, reason: 'not-for-me' }]);
    expect(ofKind(evs, 'frameRx').some((e) => e.device === 'pc3' && e.pdu.parent === request)).toBe(true);

    // PC2 hears all ten echo frames of the conversation and keeps none
    const pc2Echo = ofKind(evs, 'drop').filter((e) => e.device === 'pc2' && e.reason === 'not-for-me' && (e.pdu.tag?.startsWith('ping#') === true || e.pdu.tag === 'echo-reply'));
    expect(pc2Echo).toHaveLength(10);
    expect(ofKind(evs, 'pduConsumed').filter((e) => e.device === 'pc2')).toEqual([]);
    expect(ofKind(evs, 'collision')).toEqual([]);
  });

  it("makes two pings started together collide, back off with draws from each station cable's csma stream, and complete", () => {
    const sim = hubWorld();
    const cursor = sim.trace(0).next;
    const a = sim.cli.open('pc1', 'console');
    const b = sim.cli.open('pc2', 'console');
    expect(sim.cli.exec(a, 'ping 10.0.0.3').busy).toBe(true);
    expect(sim.cli.exec(b, 'ping 10.0.0.3').busy).toBe(true);
    expect(sim.runToIdle().events).toBeLessThan(1_000_000);
    const evs = sim.trace(cursor).events;
    expect(output(evs, a)).toContain('Sent 5, received 5, lost 0');
    expect(output(evs, b)).toContain('Sent 5, received 5, lost 0');

    const jamNs = serializationNs(CSMA.JAM_BYTES, SPEED_10M);
    const collisions = ofKind(evs, 'collision');
    expect(collisions.length).toBeGreaterThanOrEqual(1);
    for (const c of collisions) {
      expect(c).toMatchObject({ segment: SEGMENT, late: false });
      expect(c.stations.length).toBeGreaterThanOrEqual(1);
      expect(c.pdus.length).toBeGreaterThanOrEqual(2);
      expect(c.jamUntil - c.detectAt).toBeGreaterThanOrEqual(jamNs);
    }
    // the two ARP broadcasts start at the same instant: PC1 and PC2 both detect the first collision
    expect(collisions[0]!.stations.map((s) => s.device)).toEqual(['pc1', 'pc2']);
    expect(ofKind(evs, 'frameAbort').filter((e) => e.reason === 'collision').length).toBeGreaterThan(0);
    expect(ofKind(evs, 'drop').some((e) => e.reason === 'collision')).toBe(true);
    expect(ofKind(evs, 'drop').filter((e) => e.reason === 'late-collision' || e.reason === 'excessive-collisions')).toEqual([]);

    // Backoff slot counts are exactly the draws of rng 'link:<station cable>:csma': one draw per backoff, from a stream
    // created once and never re-split. Each stream is replayed over every backoff since the world started, because the
    // three PCs already collided at boot when their gratuitous ARPs left at the same instant.
    expect(ofKind(evs, 'backoff').length).toBeGreaterThanOrEqual(1);
    const links = createRng(SEED).split('links');
    const slotNs = serializationNs(CSMA.SLOT_BYTES, SPEED_10M);
    const allBackoffs = ofKind(sim.trace(0).events, 'backoff');
    for (const station of STATIONS) {
      const stream = links.split(`link:${CABLE[station]}:csma`);
      for (const bo of allBackoffs.filter((e) => e.device === station)) {
        expect(bo.port).toBe(NIC);
        expect(bo.slots, `${station} backoff at ${bo.t}`).toBe(stream.nextInt(0, 2 ** Math.min(bo.attempt, CSMA.BACKOFF_LIMIT) - 1));
        expect(bo.until).toBe(bo.t + bo.slots * slotNs);
      }
    }

    // the medium's statistics and the port counters agree; show interfaces prints the counter
    const members = sim.snapshot().media!.segments[0]!.members;
    for (const station of STATIONS) {
      const counters = sim.device(station)!.port(NIC)!.counters;
      const member = members.find((m) => m.port.device === station)!;
      expect(counters.collisions, station).toBe(member.collisions);
      expect(counters.deferred ?? 0, station).toBe(member.deferred);
    }
    for (const c of collisions) {
      for (const s of c.stations) expect(sim.device(s.device)!.port(s.port)!.counters.collisions).toBeGreaterThan(0);
    }
    for (const station of ['pc1', 'pc2']) {
      const counted = sim.device(station)!.port(NIC)!.counters.collisions;
      expect(counted, station).toBeGreaterThan(0);
      const shown = typeLines(sim, station, ['show interfaces']).results[0]!;
      expect(shown.error, station).toBeUndefined();
      expect(countIn(shown.output, 'collisions'), station).toBe(counted);
    }
  });
});
