/**
 * P0.5 acceptance — point-to-point radio bridge (ARCHITECTURE-P1 §10.1 `accept.p05.radio-bridge`; D5, §3.4, §3.7).
 *
 * The radio bridge template: PC1 – SW1 – RADIO1 ~ 10 km ~ RADIO2 – SW2 – PC2 with two `radio.nfptp5` on channel 149
 * and the same pairing key. The link comes up at the rate the 802.11ac table gives for its SINR, carries a ping with
 * velocity factor 1.0 propagation, and joins both LANs. A pairing key mismatch downs it with `radio-key-mismatch`;
 * two `radio.nfptp60` 1.5 km apart stay down `out-of-range` (their cut-off is 1 km).
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES } from '../src/contracts/cli.js';
import { ETH_PHY_OVERHEAD } from '../src/contracts/pdu.js';
import { MCS_TABLES, RF, WIDTH_FACTOR_PCT } from '../src/contracts/rf.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC, propagationNs, serializationNs } from '../src/contracts/time.js';
import { PTP5_RADIO, PTP60_RADIO } from '../src/device/catalog/radios.js';
import { RADIO_BRIDGE_CHANNEL, RADIO_BRIDGE_DISTANCE_M, RADIO_BRIDGE_PEER_KEY, radioBridge } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';
import { ofKind, ping } from './sim.harness.js';
import { device, topology } from './accept.p05.harness.js';

const LINK = 'l_radio1_radio2';

/** The radio bridge template, booted. */
function bridge(): Simulation {
  const sim = createSimulation({ seed: 4 });
  sim.loadTopology(radioBridge());
  sim.runFor(60 * SEC);
  return sim;
}

describe('accept P0.5: radio bridge', () => {
  it('joins two LANs over 5 GHz radios 10 km apart and carries a ping at the MCS-table rate', () => {
    const sim = bridge();
    const link = sim.link(LINK)!;
    expect(link).toMatchObject({ up: true, kind: 'radio', media: 'radio', distanceOverrideM: RADIO_BRIDGE_DISTANCE_M });
    const radio = link.radio!;
    expect(radio).toMatchObject({ distanceM: RADIO_BRIDGE_DISTANCE_M, distanceSource: 'override', band: '5', channel: RADIO_BRIDGE_CHANNEL });
    expect(radio.rssiDbm * 1000).toBeGreaterThanOrEqual(RF.PTP_CONNECT_RSSI_MDB);

    // both radios speak 802.11n/ac: on 5 GHz the ac table applies, at the default 20 MHz width, with two streams each;
    // the SINR clears the top entry, so the link runs at its rate
    const top = MCS_TABLES.ac[MCS_TABLES.ac.length - 1]!;
    expect(radio.snrDb * 1000).toBeGreaterThanOrEqual(top.minSinrMdb);
    const tableRate = Math.floor((top.baseKbps20 * WIDTH_FACTOR_PCT[20]) / 100) * PTP5_RADIO.streams * 1000;
    expect(tableRate).toBe(173_400_000);
    expect(link.negotiatedBps).toBe(tableRate);
    expect(radio.rateBps).toBe(tableRate);

    const p = ping(sim, 'pc1', '10.0.0.2');
    expect(p.text).toContain('Sent 5, received 5, lost 0');
    const overTheAir = ofKind(p.evs, 'frameTx').filter((e) => e.link === LINK);
    expect(overTheAir.length).toBeGreaterThanOrEqual(12);
    for (const f of overTheAir) {
      expect(f).toMatchObject({ medium: 'radio', rateBps: tableRate, rssiDbm: radio.rssiDbm });
      expect(f.arrive - f.txEnd).toBe(propagationNs(RADIO_BRIDGE_DISTANCE_M, 1.0));
      expect(f.txEnd - f.txStart).toBe(serializationNs(f.pdu.size + ETH_PHY_OVERHEAD, tableRate));
    }

    // one LAN: each switch and each radio learned the far PC behind the radio link
    const pc1 = sim.device('pc1')!.port('GigabitEthernet0')!.mac;
    const pc2 = sim.device('pc2')!.port('GigabitEthernet0')!.mac;
    expect(sim.device('sw1')!.tables.cam.rows().find((r) => r.mac === pc2)?.port).toBe('GigabitEthernet0/1');
    expect(sim.device('sw2')!.tables.cam.rows().find((r) => r.mac === pc1)?.port).toBe('GigabitEthernet0/1');
    expect(sim.device('radio1')!.tables.cam.rows().find((r) => r.mac === pc2)?.port).toBe('Radio0');
    expect(sim.device('radio2')!.tables.cam.rows().find((r) => r.mac === pc1)?.port).toBe('Radio0');
  });

  it('drops the link with radio-key-mismatch when one pairing key changes, and restores it with the shared key', () => {
    const sim = bridge();
    expect(sim.cli.canOpen('radio2', 'console')).toEqual({ ok: false, reason: CLI_MESSAGES.noShell });
    const cursor = sim.trace(0).next;
    expect(sim.configure('radio2', ['interface Radio0', ' peer-key another-key-9'], { indentation: true }).ok).toBe(true);
    sim.runFor(SEC);
    expect(sim.link(LINK)).toMatchObject({ up: false, downReason: 'radio-key-mismatch' });
    expect(ofKind(sim.trace(cursor).events, 'linkState')).toMatchObject([{ link: LINK, up: false, reason: 'radio-key-mismatch' }]);
    expect(ping(sim, 'pc1', '10.0.0.2').text).toContain('received 0');

    expect(sim.configure('radio2', ['interface Radio0', ` peer-key ${RADIO_BRIDGE_PEER_KEY}`], { indentation: true }).ok).toBe(true);
    sim.runFor(SEC);
    expect(sim.link(LINK)!.up).toBe(true);
    expect(sim.link(LINK)!.downReason).toBeUndefined();
    expect(ping(sim, 'pc1', '10.0.0.2').text).toContain('Sent 5, received 5, lost 0');
  });

  it('keeps two 60 GHz radios 1.5 km apart down out-of-range, beyond their 1 km cut-off', () => {
    const pair = (distanceM: number): Simulation => {
      const sim = createSimulation({ seed: 4 });
      sim.loadTopology(
        topology(
          [device('a', 'radio.nfptp60', 'A', 0, 0), device('b', 'radio.nfptp60', 'B', 100, 0)],
          [{ id: 'l_ab', a: { device: 'a', port: 'Radio0' }, b: { device: 'b', port: 'Radio0' }, media: 'radio', kind: 'radio', distance_m: distanceM }],
        ),
      );
      sim.runFor(60 * SEC);
      return sim;
    };
    expect(1_500).toBeGreaterThan(PTP60_RADIO.maxRangeM);
    const far = pair(1_500);
    expect(far.link('l_ab')).toMatchObject({ up: false, downReason: 'out-of-range', radio: { distanceM: 1_500, distanceSource: 'override', band: '60' } });
    expect(far.device('a')!.port('Radio0')!.operUp).toBe(false);

    const near = pair(900);
    expect(near.link('l_ab')).toMatchObject({ up: true, radio: { distanceM: 900, band: '60' } });
    expect(near.link('l_ab')!.negotiatedBps).toBeGreaterThan(0);
  });
});
