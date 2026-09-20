/**
 * sim — media wiring end to end (ARCHITECTURE-P1 §3.2, §3.4–§3.8, §3.6 mobility): deferred segment counters through
 * onTxOutcome, carrier MediumEvents reaching the hdlc daemon, serial clocking via configure, Wi-Fi association and
 * air data through admit, cellular attach, coalesced deviceMoved events, canvas scale and device removal.
 */
import { describe, expect, it } from 'vitest';
import type { Simulation } from '../src/contracts/simulation.js';
import { RF } from '../src/contracts/rf.js';
import { SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID, type Topology, type TopologyDevice, type TopologyLink } from '../src/contracts/topology.js';
import { createSimulation } from '../src/sim/simulation.js';
import { hasRadioPort } from '../src/sim/media-wiring.js';
import { BOOT_NS, ofKind, ping } from './sim.harness.js';

const dev = (id: string, type: string, name: string, x = 0, y = 0): TopologyDevice => ({ id, type, name, position: { logical: [x, y] } });
const cable = (id: string, a: string, ap: string, b: string, bp: string, media: TopologyLink['media'] = 'auto'): TopologyLink => ({
  id, a: { device: a, port: ap }, b: { device: b, port: bp }, media, length_m: 3,
});
const topology = (devices: TopologyDevice[], links: TopologyLink[]): Topology => ({ schema: TOPOLOGY_SCHEMA_ID, seed: 1, devices, links });

function start(topo: Topology, seed = 1): Simulation {
  const sim = createSimulation({ seed });
  sim.loadTopology(topo);
  sim.runFor(BOOT_NS);
  return sim;
}

describe('sim: shared segment through the facade', () => {
  it('pings across a hub with deferred counters and a clone seen by the third station', () => {
    const sim = start(
      topology(
        [dev('pc1', 'pc.nfpc', 'PC1'), dev('pc2', 'pc.nfpc', 'PC2'), dev('pc3', 'pc.nfpc', 'PC3'), dev('hub', 'hub.nfhub4', 'Hub1')],
        [cable('l1', 'pc1', 'GigabitEthernet0', 'hub', 'Ethernet0'), cable('l2', 'pc2', 'GigabitEthernet0', 'hub', 'Ethernet1'), cable('l3', 'pc3', 'GigabitEthernet0', 'hub', 'Ethernet2')],
      ),
    );
    for (const [id, ip] of [['pc1', '10.0.0.1'], ['pc2', '10.0.0.2'], ['pc3', '10.0.0.3']] as const) {
      expect(sim.configure(id, [`ip address ${ip} 255.255.255.0`]).ok).toBe(true);
    }
    const p = ping(sim, 'pc1', '10.0.0.3');
    expect(p.text).toContain('Sent 5, received 5, lost 0');
    expect(p.evs.some((e) => e.kind === 'drop' && e.device === 'pc2' && e.reason === 'not-for-me')).toBe(true);
    const snap = sim.snapshot();
    const seg = snap.media!.segments[0]!;
    expect(seg.members.filter((m) => m.role === 'station').length).toBe(3);
    expect(seg.members.filter((m) => m.role === 'repeater').length).toBe(4);
    const nic = snap.devices.find((d) => d.id === 'pc1')!.ports[0]!;
    expect(nic.counters.outPackets).toBeGreaterThanOrEqual(5);
    expect(nic.duplex).toBe('half');
    const hubPort = snap.devices.find((d) => d.id === 'hub')!.ports[0]!;
    expect(hubPort.counters.inPackets).toBeGreaterThan(0);
  });
});

describe('sim: serial clocking and hdlc carrier events', () => {
  it('brings a serial pair up after clock rate on the DCE and arms keepalives from the carrier event', () => {
    const sim = start(topology([dev('r1', 'router.nf2911', 'R1'), dev('r2', 'router.nf2911', 'R2')], [cable('s', 'r1', 'Serial0/0/0', 'r2', 'Serial0/0/0', 'serial-dce')]));
    for (const [id, ip] of [['r1', '10.0.12.1'], ['r2', '10.0.12.2']] as const) {
      expect(sim.configure(id, ['interface Serial0/0/0', ` ip address ${ip} 255.255.255.252`, ' no shutdown'], { indentation: true }).ok).toBe(true);
    }
    sim.runFor(SEC);
    expect(sim.link('s')).toMatchObject({ up: false, downReason: 'no-clock', carrier: true });
    const r1Serial = sim.snapshot().devices.find((d) => d.id === 'r1')!.ports.find((p) => p.id === 'Serial0/0/0')!;
    expect(r1Serial.phy).toMatchObject({ carrier: true, lineProtocol: false, lineProtocolReason: 'no-clock', dce: true });

    expect(sim.configure('r1', ['interface Serial0/0/0', ' clock rate 64000'], { indentation: true }).ok).toBe(true);
    sim.runFor(SEC);
    expect(sim.link('s')).toMatchObject({ up: true, negotiatedBps: 64_000 });
    const hdlc = sim.device('r1')!.processes.get('hdlc')!.stateSnapshot();
    expect(JSON.stringify(hdlc.state)).toContain('"armed":true');
    expect(ping(sim, 'r1', '10.0.12.2').text).toContain('Sent 5, received 5, lost 0');
    expect(sim.runToIdle(200_000).events).toBeLessThan(200_000);
  });
});

describe('sim: wireless mediums', () => {
  function wifi(): Simulation {
    const sim = start(topology([dev('home', 'wrouter.nfhome', 'Home1', 0, 0), dev('lap', 'laptop.nflaptop', 'Laptop1', 160, 0)], []));
    expect(sim.configure('home', ['interface Wlan0', ' ssid LAB', ' security wpa2-psk', ' passphrase labpass123'], { indentation: true }).ok).toBe(true);
    const station = sim.configure('lap', ['wifi connect LAB key labpass123']);
    expect(station.ok).toBe(true);
    sim.runFor(10 * SEC);
    return sim;
  }

  it('associates a laptop with a home router through daemons, medium ops and admit', () => {
    const sim = wifi();
    const states = ofKind(sim.trace(0).events, 'assocState').filter((e) => e.station.device === 'lap').map((e) => e.state);
    expect(states).toContain('handshake');
    expect(states.at(-1)).toBe('associated');
    expect(sim.device('lap')!.port('Wlan0')!.operUp).toBe(true);
    const snap = sim.snapshot();
    expect(snap.media!.associations).toMatchObject([{ tech: 'wifi', state: 'associated', authorized: true, station: { device: 'lap', port: 'Wlan0' } }]);
    expect(snap.devices.find((d) => d.id === 'lap')!.ports.find((p) => p.id === 'Wlan0')!.radio).toMatchObject({ mode: 'station', state: 'associated' });
    expect(ofKind(sim.trace(0).events, 'frameTx').some((e) => e.medium === 'air')).toBe(true);
  });

  it('coalesces moves into one deviceMoved event, tears down after the RF hold and reassociates when back', () => {
    const sim = wifi();
    sim.runToIdle(100_000);
    const pending = sim.snapshot().pendingEvents;
    sim.moveDevice('home', { x: 1, y: 0 });
    expect(sim.snapshot().pendingEvents).toBe(pending + 1);
    sim.moveDevice('home', { x: 0, y: 0 });
    expect(sim.snapshot().pendingEvents).toBe(pending + 1);
    sim.runUntil(sim.now);
    expect(sim.snapshot().pendingEvents).toBe(pending);

    sim.moveDevice('lap', { x: 40_000, y: 0 });
    sim.moveDevice('lap', { x: 40_000, y: 1 });
    sim.runUntil(sim.now);
    expect(sim.device('lap')!.port('Wlan0')!.operUp).toBe(true);
    sim.runFor(RF.RF_HOLD_NS + SEC);
    expect(sim.device('lap')!.port('Wlan0')!.operUp).toBe(false);
    expect(sim.snapshot().media?.associations ?? []).toEqual([]);

    sim.moveDevice('lap', { x: 160, y: 0 });
    sim.runUntil(sim.now);
    sim.runFor(15 * SEC);
    expect(sim.device('lap')!.port('Wlan0')!.operUp).toBe(true);
    expect(sim.runToIdle(500_000).events).toBeLessThan(500_000);
  });

  it('never schedules moves for devices without radio ports; the canvas scale is validated and exported', () => {
    const sim = wifi();
    sim.addDevice({ id: 'pc', type: 'pc.nfpc' });
    expect(hasRadioPort(sim.device('pc')!)).toBe(false);
    expect(hasRadioPort(sim.device('lap')!)).toBe(true);
    const pending = sim.snapshot().pendingEvents;
    sim.moveDevice('pc', { x: 5, y: 5 });
    expect(sim.snapshot().pendingEvents).toBe(pending);

    expect(() => sim.setCanvasScale(0)).toThrow(RangeError);
    expect(() => sim.setCanvasScale(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    sim.setCanvasScale(0.5);
    expect(sim.snapshot().media!.metresPerUnit).toBe(0.5);
    expect(sim.exportTopology().canvas).toEqual({ metresPerUnit: 0.5 });
  });

  it('tears the association down when the access point is removed', () => {
    const sim = wifi();
    sim.removeDevice('home');
    sim.runFor(SEC);
    expect(sim.device('lap')!.port('Wlan0')!.operUp).toBe(false);
    expect(sim.snapshot().media?.associations ?? []).toEqual([]);
  });

  it('attaches a smartphone to a tower 300 ms after the attach request, re-searching until the tower is up', () => {
    const sim = createSimulation({ seed: 3 });
    sim.loadTopology(topology([dev('tower', 'cell.nftower', 'Tower1', 0, 0), dev('phone', 'phone.nfsmartphone', 'Phone1', 400, 0)], []));
    // The phone boots first: its boot search finds no cell, and the periodic re-search (§3.8) is what attaches it,
    // so runToIdle (which never waits for periodic timers) returns before the tower is found.
    sim.runToIdle(100_000);
    expect(sim.device('phone')!.port('Cellular0')!.operUp).toBe(false);
    sim.runFor(30 * SEC);
    const evs = ofKind(sim.trace(0).events, 'assocState').filter((e) => e.tech === 'cellular' && e.station.device === 'phone');
    expect(evs[1]).toMatchObject({ state: 'detached', reason: 'no-cell' });
    const attaching = evs.find((e) => e.state === 'attaching')!;
    const attached = evs.find((e) => e.state === 'attached')!;
    expect(attached.t - attaching.t).toBe(RF.CELL_ATTACH_NS);
    expect(sim.device('phone')!.port('Cellular0')!.operUp).toBe(true);
    const cellClient = sim.device('phone')!.processes.get('cell-client')!.stateSnapshot();
    expect(JSON.stringify(cellClient.state)).toContain('"phase":"attached"');
    expect(sim.snapshot().media!.cells[0]).toMatchObject({ ues: 1, up: true });
  });
});
