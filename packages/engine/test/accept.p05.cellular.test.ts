/**
 * P0.5 acceptance — cellular attach (ARCHITECTURE-P1 §10.1 `accept.p05.cellular`; D5, §3.8).
 *
 * The cellular template: TOWER1 (`cell.nftower`) with SRV1 on its GigabitEthernet0 backhaul and two
 * `phone.nfsmartphone` about 50 m away. Each phone attaches 300 ms after it starts attaching, and PHONE1 pings SRV1
 * behind the tower: the echo request crosses the cell, then the backhaul cable. A phone 2 km away, beyond the tower's
 * radio range, never attaches.
 */
import { describe, expect, it } from 'vitest';
import { RF } from '../src/contracts/rf.js';
import { SEC } from '../src/contracts/time.js';
import { DEFAULT_METRES_PER_UNIT } from '../src/contracts/topology.js';
import { cellularPhones } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';
import { createdId, ofKind, ping } from './sim.harness.js';
import { MASK24, configText, device, section, topologyDevice } from './accept.p05.harness.js';

const CELL = 'cell:tower1/Cellular0';
const TOWER = { device: 'tower1', port: 'Cellular0' };

describe('accept P0.5: cellular', () => {
  it('attaches smartphones 300 ms after they start attaching and pings the server behind the tower backhaul', () => {
    const sim = createSimulation({ seed: 6 });
    sim.loadTopology(cellularPhones());
    sim.runFor(60 * SEC);
    const evs = sim.trace(0).events;

    for (const phone of ['phone1', 'phone2']) {
      const states = ofKind(evs, 'assocState').filter((e) => e.tech === 'cellular' && e.station.device === phone);
      const attached = states.filter((e) => e.state === 'attached');
      expect(attached, phone).toHaveLength(1);
      const attaching = states.filter((e) => e.state === 'attaching' && e.t <= attached[0]!.t).at(-1)!;
      expect(attached[0]!.t - attaching.t, phone).toBe(RF.CELL_ATTACH_NS);
      expect(attached[0], phone).toMatchObject({ prev: 'attaching', medium: CELL, ap: TOWER });
      expect(sim.device(phone)!.port('Cellular0')!.operUp, phone).toBe(true);
    }
    const media = sim.snapshot().media!;
    expect(media.cells).toMatchObject([{ id: CELL, tower: TOWER, up: true, ues: 2 }]);
    expect(media.associations.map((a) => [a.tech, a.station.device, a.state, a.medium, a.authorized])).toEqual([
      ['cellular', 'phone1', 'attached', CELL, true],
      ['cellular', 'phone2', 'attached', CELL, true],
    ]);
    for (const a of media.associations) expect(a.distanceM).toBeLessThanOrEqual(media.cells[0]!.rangeM);

    const p = ping(sim, 'phone1', '10.20.0.100');
    expect(p.text).toContain('Sent 5, received 5, lost 0');
    const request = createdId(p.evs, 'phone1', 'ping#1');
    const legs = ofKind(p.evs, 'frameTx').filter((e) => e.pdu.id === request);
    expect(legs.map((e) => [e.from.device, e.to.device, e.link, e.medium])).toEqual([
      ['phone1', 'tower1', CELL, 'cell'],
      ['tower1', 'srv1', 'l_srv1_tower1', undefined],
    ]);
    expect(legs[0]!.rateBps).toBe(media.associations[0]!.rateBps);
    expect(legs[0]!.rssiDbm).toBe(media.associations[0]!.rssiDbm);
    const reply = createdId(p.evs, 'srv1', 'echo-reply');
    expect(ofKind(p.evs, 'frameTx').filter((e) => e.pdu.id === reply).map((e) => [e.from.device, e.to.device, e.medium])).toEqual([
      ['srv1', 'tower1', undefined],
      ['tower1', 'phone1', 'cell'],
    ]);

    // the tower bridges one phone to the other as well
    expect(ping(sim, 'phone1', '10.20.0.12').text).toContain('Sent 5, received 5, lost 0');
  });

  it('never attaches a phone 2 km away, beyond the tower radio range', () => {
    const topo = cellularPhones();
    const [x, y] = topologyDevice(topo, 'tower1').position.logical;
    topo.devices.push(
      device('phone3', 'phone.nfsmartphone', 'PHONE3', x + 2_000 / DEFAULT_METRES_PER_UNIT, y, configText([['hostname PHONE3'], section('interface Cellular0', [`ip address 10.20.0.13 ${MASK24}`])])),
    );
    const sim = createSimulation({ seed: 6 });
    sim.loadTopology(topo);
    sim.runFor(60 * SEC);

    const media = sim.snapshot().media!;
    expect(media.cells[0]!.rangeM).toBeLessThan(2_000);
    expect(media.cells[0]!.ues).toBe(2);
    expect(media.associations.filter((a) => a.state === 'attached').map((a) => a.station.device)).toEqual(['phone1', 'phone2']);
    const far = ofKind(sim.trace(0).events, 'assocState').filter((e) => e.station.device === 'phone3');
    expect(far.length).toBeGreaterThan(0);
    expect(far.filter((e) => e.state === 'attaching' || e.state === 'attached')).toEqual([]);
    expect(far.at(-1)!.state).toBe('detached');
    expect(sim.device('phone3')!.port('Cellular0')!.operUp).toBe(false);
  });
});
