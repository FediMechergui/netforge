/**
 * accept.p3.ppp-mismatch [S19] — ARCHITECTURE-P3 §10.1: "The HDLC/PPP mismatch sends nothing." (§3.9 step 1: the
 * link model sees the mismatch, both ends down `encapsulation-mismatch`, HDLC keepalives blocked and ppp silent with
 * the line not ready; D17 hdlc's encapsulation switch; §4.3 silence; the WAN map's row: "HDLC against PPP: both ends
 * `encapsulation-mismatch`; zero LCP frames and zero HDLC keepalives on the wire after the switch. Back to hdlc:
 * keepalives resume and the line comes up.")
 *
 * The §3.9 world on `staged.world` at stage P3 (`accept.p3.ppp.harness.ts`), the two routers starting on HDLC (no
 * `encapsulation` line). One end switches to `encapsulation ppp` — the DCE end, then the DTE end — and for ten minutes
 * not one frame of any kind is put on the cable: no LCP, no HDLC keepalive, no IP packet (a ping out of the port has
 * no connected route; one routed by a permanent static drops `link-down` before the wire). Switching back to HDLC
 * brings the keepalives back and the line up. The §3.9 start (R1 with PPP and CHAP from boot, R2 on HDLC) is silent
 * the same way. Ten minutes is 60 HDLC keepalive intervals and 60 `ppp-retry` periods.
 */
import { describe, expect, it } from 'vitest';
import { HDLC_PROTO_KEEPALIVE } from '../src/contracts/pdu.js';
import { HDLC_KEEPALIVE_DEFAULT_NS } from '../src/contracts/services.js';
import { MIN } from '../src/contracts/time.js';
import { HDLC_KEEPALIVE_TAG, HDLC_PROCESS } from '../src/protocols/hdlc.js';
import { PPP_PROCESS } from '../src/protocols/ppp.js';
import { applyLine, pppRow, pppWorld, SE0, serial, wireFrames } from './accept.p3.ppp.harness.js';
import { ofKind, ping } from './sim.harness.js';
import type { Simulation } from '../src/contracts/simulation.js';

/** Long enough for 60 keepalive intervals and 60 PPP retry periods. */
const SILENT_WINDOW = 10 * MIN;
const STATIC = `ip route 10.2.2.0 255.255.255.0 ${SE0} permanent`;

/** The `sent` counter of a daemon's StateView on `device` (0 when the daemon keeps no such counter). */
function sentBy(sim: Simulation, device: string, process: string): number {
  const v = sim.device(device)!.stateSnapshots().find((s) => s.process === process);
  return typeof v?.state.sent === 'number' ? v.state.sent : 0;
}

/** Both ends down by the mismatch, carrier up. */
function expectMismatch(sim: Simulation): void {
  for (const d of ['r1', 'r2']) {
    expect(serial(sim, d).operUp).toBe(false);
    expect(serial(sim, d).phy).toMatchObject({ carrier: true, lineProtocol: false, lineProtocolReason: 'encapsulation-mismatch' });
  }
  expect(sim.link(serial(sim, 'r1').link!)!.downReason).toBe('encapsulation-mismatch');
}

/** Run `window` and prove nothing was sent: no frame on the cable, no PDU created by ppp or hdlc, counters unchanged. */
function expectSilence(sim: Simulation, window: number): void {
  const before = ['r1', 'r2'].map((d) => [sentBy(sim, d, PPP_PROCESS), sentBy(sim, d, HDLC_PROCESS)]);
  const cursor = sim.trace(0).next;
  sim.runFor(window);
  const evs = sim.trace(cursor).events;
  expect(wireFrames(sim, evs)).toEqual([]);
  expect(ofKind(evs, 'frameTx')).toEqual([]);
  expect(ofKind(evs, 'pduCreated').filter((e) => e.process === PPP_PROCESS || e.process === HDLC_PROCESS)).toEqual([]);
  expect(ofKind(evs, 'frameQueued')).toEqual([]);
  expect(['r1', 'r2'].map((d) => [sentBy(sim, d, PPP_PROCESS), sentBy(sim, d, HDLC_PROCESS)])).toEqual(before);
  expect(sim.runToIdle().stopped).toBeUndefined();
}

/** The keepalives each end sent among the frames of `window`, after which the line is up both ways. */
function expectKeepalivesAndUp(sim: Simulation): void {
  const cursor = sim.trace(0).next;
  sim.runFor(2 * HDLC_KEEPALIVE_DEFAULT_NS);
  const frames = wireFrames(sim, sim.trace(cursor).events);
  for (const d of ['r1', 'r2']) {
    const ka = frames.filter((f) => f.from === d && f.tag === HDLC_KEEPALIVE_TAG);
    expect(ka.length).toBeGreaterThanOrEqual(1);
    expect(ka.every((f) => f.framing === 'hdlc' && f.protocol === HDLC_PROTO_KEEPALIVE && f.background)).toBe(true);
    expect(serial(sim, d).operUp).toBe(true);
    expect(serial(sim, d).phy).toMatchObject({ carrier: true, lineProtocol: true });
  }
  expect(frames.some((f) => f.framing === 'ppp')).toBe(false);
}

describe('accept.p3.ppp-mismatch [S19] the HDLC/PPP mismatch sends nothing', () => {
  it('a working HDLC link; the DCE end switches to PPP: both ends encapsulation-mismatch and ten silent minutes; back to HDLC: keepalives and the line return', () => {
    const sim = pppWorld({ r1: { ppp: [], global: [STATIC] }, r2: { ppp: [] } });
    // the HDLC link works: keepalives both ways, line up, a ping crosses
    expectKeepalivesAndUp(sim);
    expect(ping(sim, 'r1', '10.1.1.2').text).toContain('!!!!!');
    sim.runToIdle();

    // the switch (at an idle point: nothing in flight)
    applyLine(sim, 'r1', [['interface', SE0]], ['encapsulation', 'ppp']);
    expect(serial(sim, 'r1').encap).toBe('ppp');
    expect(sim.runToIdle().stopped).toBeUndefined();
    expectMismatch(sim);
    // R1's ppp has the port but the line is not ready (Starting); R2 runs no ppp; R1's hdlc let the port go
    expect(pppRow(sim, 'r1')).toMatchObject({ phase: 'dead', lcp: 'starting' });
    expect(pppRow(sim, 'r2')).toBeUndefined();
    const hdlcLines = (d: string): string[] =>
      ((sim.device(d)!.stateSnapshots().find((v) => v.process === HDLC_PROCESS)!.state.lines as { port: string }[]) ?? []).map((l) => l.port);
    expect(hdlcLines('r1')).not.toContain(SE0);
    expect(hdlcLines('r2')).toContain(SE0);
    expectSilence(sim, SILENT_WINDOW);

    // IP sends nothing either: no connected route; a permanent static drops link-down before the wire
    const noRoute = ping(sim, 'r1', '10.1.1.2');
    expect(noRoute.text).toBe('No route to 10.1.1.2 from this device.\n');
    expect(ofKind(noRoute.evs, 'frameTx')).toEqual([]);
    const routed = ping(sim, 'r1', '10.2.2.2');
    expect(routed.text).not.toContain('!');
    const drops = ofKind(routed.evs, 'drop').filter((e) => e.device === 'r1' && e.pdu.proto === 'icmpv4');
    expect(drops).toHaveLength(5);
    expect(drops.every((e) => e.reason === 'link-down')).toBe(true);
    expect(ofKind(routed.evs, 'frameTx')).toEqual([]);

    // back to HDLC: ppp lets the port go, keepalives resume, the line comes up
    applyLine(sim, 'r1', [['interface', SE0]], ['encapsulation', 'hdlc']);
    expect(pppRow(sim, 'r1')).toBeUndefined();
    expectKeepalivesAndUp(sim);
    expect(hdlcLines('r1')).toContain(SE0);
    const back = ping(sim, 'r1', '10.1.1.2');
    expect(back.text).toContain('!!!!!');
    expect(wireFrames(sim, back.evs).filter((f) => f.proto === 'ipv4').every((f) => f.framing === 'hdlc')).toBe(true);
  });

  it('the DTE end switches to PPP: the same silence, and back to HDLC the line returns', () => {
    const sim = pppWorld({ r1: { ppp: [] }, r2: { ppp: [] } });
    expectKeepalivesAndUp(sim);
    sim.runToIdle();
    applyLine(sim, 'r2', [['interface', SE0]], ['encapsulation', 'ppp']);
    expect(sim.runToIdle().stopped).toBeUndefined();
    expectMismatch(sim);
    expect(pppRow(sim, 'r2')).toMatchObject({ phase: 'dead', lcp: 'starting' });
    expectSilence(sim, SILENT_WINDOW);
    applyLine(sim, 'r2', [['interface', SE0]], ['encapsulation', 'hdlc']);
    expectKeepalivesAndUp(sim);
  });

  it('§3.9 step 1 from boot: R1 with PPP and CHAP, R2 on HDLC — nothing is ever sent, by either daemon', () => {
    const sim = pppWorld({ r2: { ppp: [] }, settle: false });
    const stats = sim.runToIdle();
    expect(stats.stopped).toBeUndefined();
    expectMismatch(sim);
    expect(pppRow(sim, 'r1')).toMatchObject({ phase: 'dead', lcp: 'starting', failures: 0 });
    expectSilence(sim, SILENT_WINDOW);
    // since boot, not one frame on the cable and not one PDU from either daemon
    const all = sim.trace(0).events;
    expect(ofKind(all, 'frameTx')).toEqual([]);
    expect(ofKind(all, 'pduCreated').filter((e) => e.process === PPP_PROCESS || e.process === HDLC_PROCESS)).toEqual([]);
    for (const d of ['r1', 'r2']) {
      expect(sentBy(sim, d, PPP_PROCESS)).toBe(0);
      expect(sentBy(sim, d, HDLC_PROCESS)).toBe(0);
    }
  });
});
