/**
 * P0.5 acceptance — serial clocking and keepalives (ARCHITECTURE-P1 §10.1 `accept.p05.serial-clock`; D6, §3.1, §3.4,
 * §3.9, §12 findings 2 and 8).
 *
 * The serial pair template: two NF-2911 on a `serial-dce` cable (R1 holds the DCE end). Without a clock rate both
 * ends show "up, line protocol down" with reason `no-clock`. `clock rate` on the DTE end is stored with a note;
 * `clock rate 64000` on the DCE end brings the line up at 64 kb/s with 2 bytes of serial overhead, and a ping crosses
 * it in HDLC framing. `keepalive 0` on R2 keeps R2 up/up while R1 alone goes "up, line protocol down" with reason
 * `keepalive-missed` after three missed keepalives; `keepalive 10` on R2 recovers R1 on the next keepalive.
 */
import { describe, expect, it } from 'vitest';
import { MEDIA } from '../src/contracts/link.js';
import { HDLC_FCS, HDLC_HEADER, HDLC_PHY_OVERHEAD } from '../src/contracts/pdu.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC, serializationNs } from '../src/contracts/time.js';
import { NOTE_CLOCK_ON_DTE } from '../src/cli/handlers/serial.js';
import { LINE_PROTOCOL_REASON_TEXT } from '../src/cli/handlers/show.js';
import { SERIAL_PAIR_CLOCK_RATE_BPS, serialPair } from '../src/sim/scenarios.js';
import { createSimulation } from '../src/sim/simulation.js';
import { console, createdId, ofKind, ping } from './sim.harness.js';
import { topologyDevice } from './accept.p05.harness.js';

const SERIAL = 'Serial0/0/0';
const LINK = 'l_r1_r2';
/** Default hdlc keepalive interval (§3.9). */
const KEEPALIVE_NS = 10 * SEC;

/** The serial pair template, with or without R1's `clock rate`, booted. */
function serialWorld(clocked: boolean): Simulation {
  const topo = serialPair();
  if (!clocked) {
    const r1 = topologyDevice(topo, 'r1');
    r1.config = r1.config!.replace(` clock rate ${SERIAL_PAIR_CLOCK_RATE_BPS}\n`, '');
    expect(r1.config).not.toContain('clock rate');
  }
  const sim = createSimulation({ seed: 2 });
  sim.loadTopology(topo);
  sim.runFor(60 * SEC);
  return sim;
}

/** First line of `show interfaces Serial0/0/0` on a router. */
function statusLine(sim: Simulation, id: string): string {
  return console(sim, id, [`show interfaces ${SERIAL}`]).results[0]!.output.split('\n')[0]!;
}

describe('accept P0.5: serial clocking', () => {
  it('shows both ends up with the line protocol down (no-clock) while the DCE end has no clock rate', () => {
    const sim = serialWorld(false);
    expect(sim.link(LINK)).toMatchObject({ media: 'serial-dce', up: false, carrier: true, downReason: 'no-clock', resolvedDceEnd: 'a' });

    for (const [id, dce] of [['r1', true], ['r2', false]] as const) {
      const port = sim.device(id)!.port(SERIAL)!;
      expect(port.operUp, id).toBe(false);
      expect(port.phy, id).toMatchObject({ carrier: true, lineProtocol: false, lineProtocolReason: 'no-clock', dce });
      expect(statusLine(sim, id)).toBe(`${SERIAL}: admin up, link up, line protocol down (${LINE_PROTOCOL_REASON_TEXT['no-clock']})`);
      expect(console(sim, id, ['show ip interface brief']).results[0]!.output).toMatch(/^Serial0\/0\/0\s+10\.0\.12\.[12]\s+up\s+down$/m);
    }
    const carrierOnly = ofKind(sim.trace(0).events, 'portState').filter((e) => e.port === SERIAL && e.carrier === true);
    expect(carrierOnly.map((e) => [e.device, e.operUp, e.reason])).toEqual([
      ['r1', false, 'no-clock'],
      ['r2', false, 'no-clock'],
    ]);
    expect(ping(sim, 'pc1', '10.2.0.10').text).not.toContain('received 5');
  });

  it('notes that the DTE end ignores clock rate, clocks the line from the DCE end at 64 kb/s and carries a ping in HDLC', () => {
    const sim = serialWorld(false);
    const dte = console(sim, 'r2', ['enable', 'configure terminal', `interface ${SERIAL}`, 'clock rate 64000', 'end']).results;
    expect(dte[3]!.output).toBe(NOTE_CLOCK_ON_DTE);
    sim.runFor(SEC);
    expect(sim.link(LINK)).toMatchObject({ up: false, downReason: 'no-clock' });

    const dce = console(sim, 'r1', ['enable', 'configure terminal', `interface ${SERIAL}`, 'clock rate 64000', 'end']).results;
    expect(dce[3]!.output).toBe('');
    sim.runFor(SEC);
    const link = sim.link(LINK)!;
    expect(link).toMatchObject({ up: true, negotiatedBps: SERIAL_PAIR_CLOCK_RATE_BPS });
    expect(link.carrier).toBeUndefined();
    expect(link.downReason).toBeUndefined();
    for (const id of ['r1', 'r2']) {
      expect(sim.device(id)!.port(SERIAL), id).toMatchObject({ operUp: true, speedBps: SERIAL_PAIR_CLOCK_RATE_BPS, phy: { carrier: true, lineProtocol: true } });
    }

    const p = ping(sim, 'pc1', '10.2.0.10');
    expect(p.text).toContain('Sent 5, received 5, lost 0');
    const onSerial = ofKind(p.evs, 'frameTx').filter((e) => e.link === LINK);
    expect(onSerial.length).toBeGreaterThanOrEqual(10);
    expect(MEDIA['serial-dce'].phyOverheadBytes).toBe(HDLC_PHY_OVERHEAD);
    for (const f of onSerial) expect(f.txEnd - f.txStart).toBe(serializationNs(f.pdu.size + HDLC_PHY_OVERHEAD, SERIAL_PAIR_CLOCK_RATE_BPS));

    // the 100-byte echo request crosses the serial line once, in HDLC framing: 4 header + 2 FCS bytes, 13.5 ms
    const request = createdId(p.evs, 'pc1', 'ping#1');
    const requestFrames = onSerial.filter((f) => f.pdu.id === request);
    expect(requestFrames).toHaveLength(1);
    const frame = requestFrames[0]!;
    expect(frame).toMatchObject({ from: { device: 'r1', port: SERIAL }, to: { device: 'r2', port: SERIAL } });
    expect(frame.pdu.size).toBe(100 + HDLC_HEADER + HDLC_FCS);
    expect(frame.txEnd - frame.txStart).toBe(13_500_000);
    const structural = sim
      .pdu(request)!
      .provenance.filter((m) => m.reason === 'Encapsulate' || m.reason === 'Decapsulate')
      .map((m) => [m.device, m.reason, m.field]);
    expect(structural).toEqual([
      ['pc1', 'Encapsulate', 'ethernet'],
      ['r1', 'Decapsulate', 'ethernet'],
      ['r1', 'Encapsulate', 'hdlc'],
      ['r2', 'Decapsulate', 'hdlc'],
      ['r2', 'Encapsulate', 'ethernet'],
    ]);
  });

  it('keeps R2 up/up after keepalive 0 while R1 alone loses its line protocol, and recovers R1 on the next keepalive', () => {
    const sim = serialWorld(true);
    sim.runFor(60 * SEC);
    expect(sim.link(LINK)).toMatchObject({ up: true });

    console(sim, 'r2', ['enable', 'configure terminal', `interface ${SERIAL}`, 'keepalive 0', 'end']);
    const t0 = sim.now;
    const cursor = sim.trace(0).next;
    sim.runUntil(t0 + 50 * SEC);
    const evs = sim.trace(cursor).events;

    const r1Changes = ofKind(evs, 'portState').filter((e) => e.device === 'r1' && e.port === SERIAL);
    expect(r1Changes).toHaveLength(1);
    const down = r1Changes[0]!;
    expect(down).toMatchObject({ operUp: false, carrier: true, reason: 'keepalive-missed' });
    expect(ofKind(evs, 'portState').filter((e) => e.device === 'r2' && e.port === SERIAL)).toEqual([]);
    // three keepalive intervals without hearing R2
    const lastHeard = ofKind(sim.trace(0).events, 'frameRx')
      .filter((e) => e.device === 'r1' && e.port === SERIAL && e.pdu.tag === 'keepalive' && e.t <= down.t)
      .at(-1)!;
    expect(down.t - lastHeard.t).toBeGreaterThanOrEqual(3 * KEEPALIVE_NS);
    expect(down.t - lastHeard.t).toBeLessThanOrEqual(4 * KEEPALIVE_NS);

    expect(sim.device('r1')!.port(SERIAL)).toMatchObject({ operUp: false, phy: { carrier: true, lineProtocol: false, lineProtocolReason: 'keepalive-missed' } });
    expect(sim.device('r2')!.port(SERIAL)).toMatchObject({ operUp: true, phy: { carrier: true, lineProtocol: true } });
    expect(sim.link(LINK)).toMatchObject({ up: false, carrier: true, downReason: 'keepalive-missed' });
    expect(statusLine(sim, 'r1')).toBe(`${SERIAL}: admin up, link up, line protocol down (${LINE_PROTOCOL_REASON_TEXT['keepalive-missed']})`);
    expect(statusLine(sim, 'r2')).toBe(`${SERIAL}: admin up, link up`);

    // R1, down by keepalive only, still sends its keepalives and R2 still receives them
    const sentWhileDown = ofKind(evs, 'frameTx').filter((e) => e.link === LINK && e.from.device === 'r1' && e.pdu.tag === 'keepalive' && e.t > down.t);
    expect(sentWhileDown.length).toBeGreaterThan(0);
    for (const f of sentWhileDown) {
      expect(f.background).toBe(true);
      expect(ofKind(evs, 'frameRx').some((e) => e.device === 'r2' && e.pdu.id === f.pdu.id)).toBe(true);
    }
    expect(ofKind(evs, 'drop').filter((e) => e.pdu.tag === 'keepalive')).toEqual([]);

    console(sim, 'r2', ['enable', 'configure terminal', `interface ${SERIAL}`, 'keepalive 10', 'end']);
    const t1 = sim.now;
    const again = sim.trace(0).next;
    sim.runUntil(t1 + 25 * SEC);
    const after = sim.trace(again).events;
    const heard = ofKind(after, 'frameRx').find((e) => e.device === 'r1' && e.port === SERIAL && e.pdu.tag === 'keepalive')!;
    expect(heard.t - t1).toBeLessThanOrEqual(KEEPALIVE_NS + SEC);
    const recovered = ofKind(after, 'portState').filter((e) => e.device === 'r1' && e.port === SERIAL);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ t: heard.t, operUp: true });
    expect(recovered[0]!.carrier).toBeUndefined();
    expect(sim.link(LINK)).toMatchObject({ up: true });
    expect(statusLine(sim, 'r1')).toBe(`${SERIAL}: admin up, link up`);

    expect(ping(sim, 'pc1', '10.2.0.10').text).toContain('Sent 5, received 5, lost 0');
    expect(sim.runToIdle(200_000).events).toBeLessThan(200_000);
  });
});
