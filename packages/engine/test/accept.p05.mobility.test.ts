/**
 * P0.5 acceptance — Wi-Fi mobility (ARCHITECTURE-P1 §10.1 `accept.p05.mobility`; D5, D12, §3.6 "Mobility").
 *
 * The home Wi-Fi template at the default 0.25 m per canvas unit. Dragging the laptop from 40 m to 120 m lowers its
 * bars and rate, with an `rfState` event only when either changes. Beyond the drop threshold the association survives
 * the 2 s RF hold, then the laptop loses the signal (beacon loss). Moving back reassociates only once the signal is
 * above −82 dBm. Swinging across the thresholds never makes the association flap, and runToIdle terminates.
 */
import { describe, expect, it } from 'vitest';
import type { AssociationSnapshot } from '../src/contracts/medium.js';
import { RF } from '../src/contracts/rf.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { DEFAULT_METRES_PER_UNIT } from '../src/contracts/topology.js';
import { pairRssi } from '../src/link/rf/pathloss.js';
import { homeWifi } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';
import { ofKind } from './sim.harness.js';

const STATION = { device: 'laptop1', port: 'Wlan0' };
const AP = { device: 'home1', port: 'Wlan0' };

/** The laptop's association, if any. */
function association(sim: Simulation): AssociationSnapshot | undefined {
  return sim.snapshot().media?.associations.find((a) => a.station.device === STATION.device);
}

/** Whether the laptop's Wi-Fi adapter passes data. */
function laptopUp(sim: Simulation): boolean {
  return sim.device(STATION.device)!.port(STATION.port)!.operUp;
}

/** The home Wi-Fi template, booted, with the laptop associated 40 m from the router. */
function associated(): Simulation {
  const sim = createSimulation({ seed: 1 });
  sim.loadTopology(homeWifi());
  sim.runFor(60 * SEC);
  expect(association(sim)).toMatchObject({ state: 'associated', authorized: true, distanceM: 40 });
  return sim;
}

/** Drag the laptop to `metres` east of the router (a user move), then dispatch the coalesced move at `now`. */
function moveLaptop(sim: Simulation, metres: number): void {
  const router = sim.device(AP.device)!.spec.position;
  sim.moveDevice(STATION.device, { x: router.x + metres / DEFAULT_METRES_PER_UNIT, y: router.y });
  sim.runUntil(sim.now);
}

/** Decision RSSI (milli-dBm, the weaker direction) of the router and laptop radios `metres` apart at full power. */
function decisionRssiMdb(sim: Simulation, metres: number): number {
  const ap = sim.device(AP.device)!.port(AP.port)!.spec.radio!;
  const station = sim.device(STATION.device)!.port(STATION.port)!.spec.radio!;
  return pairRssi(
    { txPowerDbm: ap.maxTxPowerDbm, antennaGainDbi: ap.antennaGainDbi },
    { txPowerDbm: station.maxTxPowerDbm, antennaGainDbi: station.antennaGainDbi },
    '2.4',
    metres * 1000,
    'wifi',
  ).rssiMdb;
}

describe('accept P0.5: Wi-Fi mobility', () => {
  it('lowers bars and rate while the laptop is dragged from 40 m to 120 m, reporting rfState only on changes', () => {
    const sim = associated();
    const start = association(sim)!;
    const cursor = sim.trace(0).next;
    for (let metres = 41; metres <= 120; metres++) moveLaptop(sim, metres);

    const end = association(sim)!;
    expect(end).toMatchObject({ state: 'associated', authorized: true, distanceM: 120 });
    expect(end.bars).toBeLessThan(start.bars);
    expect(end.rateBps).toBeLessThan(start.rateBps);
    expect(end.rssiDbm).toBeLessThan(start.rssiDbm);
    expect(end.rssiDbm * 1000).toBeGreaterThanOrEqual(RF.WIFI_DROP_RSSI_MDB);
    expect(end.holdUntil).toBeUndefined();
    expect(laptopUp(sim)).toBe(true);

    const evs = sim.trace(cursor).events;
    expect(ofKind(evs, 'topologyChanged').filter((e) => e.op === 'move' && e.id === STATION.device)).toHaveLength(80);
    const rf = ofKind(evs, 'rfState');
    expect(rf.length).toBeGreaterThan(0);
    expect(rf.length).toBeLessThan(80);
    let previous = { bars: start.bars, rateBps: start.rateBps };
    for (const e of rf) {
      expect(e.port).toEqual(STATION);
      expect(e.peer).toEqual(AP);
      expect(e.bars !== previous.bars || e.rateBps !== previous.rateBps).toBe(true);
      previous = { bars: e.bars, rateBps: e.rateBps };
    }
    expect(previous).toEqual({ bars: end.bars, rateBps: end.rateBps });
    expect(ofKind(evs, 'assocState')).toEqual([]);
    expect(ofKind(evs, 'portState')).toEqual([]);
  });

  it('keeps the association through the 2 s RF hold beyond the drop threshold, then loses the signal', () => {
    const sim = associated();
    const cursor = sim.trace(0).next;
    moveLaptop(sim, 200);
    const t = sim.now;
    expect(decisionRssiMdb(sim, 200)).toBeLessThan(RF.WIFI_DROP_RSSI_MDB);
    const held = association(sim)!;
    expect(held.rssiDbm * 1000).toBeLessThan(RF.WIFI_DROP_RSSI_MDB);
    expect(held).toMatchObject({ state: 'associated', authorized: true, holdUntil: t + RF.RF_HOLD_NS });

    sim.runUntil(t + RF.RF_HOLD_NS - 1);
    expect(laptopUp(sim)).toBe(true);
    expect(association(sim)).toBeDefined();

    sim.runUntil(t + RF.RF_HOLD_NS);
    expect(laptopUp(sim)).toBe(false);
    expect(association(sim)).toBeUndefined();
    const evs = sim.trace(cursor).events;
    expect(ofKind(evs, 'portState').filter((e) => e.device === STATION.device)).toMatchObject([
      { t: t + RF.RF_HOLD_NS, port: STATION.port, operUp: false, reason: 'disassociated' },
    ]);
    // §10.1 "then beacon-loss": the medium tells the station it lost the beacons of its BSS ...
    const bssid = held.bssid;
    const lost = sim.device(STATION.device)!.recentDebug().filter((d) => d.message === `${STATION.port}: lost the signal of ${bssid}`);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ at: t + RF.RF_HOLD_NS, process: 'wlan-client', data: { port: STATION.port, bssid } });
    // ... and the station reacts to the beacon loss: it scans again with reason out-of-range
    expect(ofKind(evs, 'assocState').filter((e) => e.station.device === STATION.device)[0]).toMatchObject({
      t: t + RF.RF_HOLD_NS,
      state: 'scanning',
      prev: 'associated',
      reason: 'out-of-range',
    });
    expect(sim.device(AP.device)!.tables.get?.('dot11-assoc')?.rows()).toEqual([]);
  });

  it('reassociates a laptop that moves back only once the signal is above −82 dBm', () => {
    const sim = associated();
    moveLaptop(sim, 200);
    sim.runFor(RF.RF_HOLD_NS + SEC);
    expect(laptopUp(sim)).toBe(false);

    moveLaptop(sim, 160);
    expect(decisionRssiMdb(sim, 160)).toBeLessThan(RF.WIFI_CONNECT_RSSI_MDB);
    expect(decisionRssiMdb(sim, 160)).toBeGreaterThanOrEqual(RF.WIFI_DROP_RSSI_MDB);
    const cursor = sim.trace(0).next;
    sim.runFor(20 * SEC);
    const tries = ofKind(sim.trace(cursor).events, 'assocState').filter((e) => e.station.device === STATION.device);
    expect(tries.some((e) => e.state === 'scanning')).toBe(true);
    expect(tries.filter((e) => e.state !== 'scanning' && e.state !== 'failed')).toEqual([]);
    expect(laptopUp(sim)).toBe(false);

    moveLaptop(sim, 120);
    expect(decisionRssiMdb(sim, 120)).toBeGreaterThanOrEqual(RF.WIFI_CONNECT_RSSI_MDB);
    sim.runFor(20 * SEC);
    expect(laptopUp(sim)).toBe(true);
    const back = association(sim)!;
    expect(back).toMatchObject({ state: 'associated', authorized: true, distanceM: 120 });
    expect(back.rssiDbm * 1000).toBeGreaterThanOrEqual(RF.WIFI_CONNECT_RSSI_MDB);
  });

  it('never flaps while the laptop swings across the thresholds, and runToIdle terminates', () => {
    // below the connect threshold on both sides of the drop threshold: at most one teardown, never a reassociation
    const straddle = associated();
    const first = straddle.trace(0).next;
    for (let i = 0; i < 40; i++) {
      moveLaptop(straddle, i % 2 === 0 ? 200 : 160);
      straddle.runFor(SEC / 2);
    }
    const s1 = straddle.trace(first).events;
    expect(ofKind(s1, 'portState').filter((e) => e.device === STATION.device && !e.operUp).length).toBeLessThanOrEqual(1);
    expect(ofKind(s1, 'assocState').filter((e) => e.station.device === STATION.device && e.state === 'associated')).toEqual([]);
    expect(straddle.runToIdle(500_000).events).toBeLessThan(500_000);

    // back above the connect threshold within every hold: the association is never torn down
    const swing = associated();
    const second = swing.trace(0).next;
    for (let i = 0; i < 10; i++) {
      moveLaptop(swing, i % 2 === 0 ? 200 : 120);
      swing.runFor(SEC);
      expect(laptopUp(swing)).toBe(true);
    }
    const s2 = swing.trace(second).events;
    expect(ofKind(s2, 'portState').filter((e) => e.device === STATION.device)).toEqual([]);
    expect(ofKind(s2, 'assocState').filter((e) => e.station.device === STATION.device)).toEqual([]);
    const rf = ofKind(s2, 'rfState');
    expect(rf.length).toBeGreaterThan(0);
    rf.slice(1).forEach((e, i) => expect(e.bars !== rf[i]!.bars || e.rateBps !== rf[i]!.rateBps).toBe(true));
    expect(association(swing)).toMatchObject({ state: 'associated', authorized: true });
    expect(swing.runToIdle(500_000).events).toBeLessThan(500_000);
  });
});
