/**
 * accept.p3.ppp-keepalive [S19] — ARCHITECTURE-P3 §10.1: "`keepalive-missed` after 5 intervals." (§3.9 step 5 "LCP
 * echoes every 10 s, background"; §4.2 `lcp-echo:<p>` periodic, `ppp-retry:<p>` periodic, `lcp-restart:<p>` 2 s with
 * Max-Configure 10; §5.7 `keepalive [<s>]` (LCP echo on ppp); the WAN map's row: "100% loss impairment →
 * `keepalive-missed` after 5 echo intervals ± 1 interval. Recovers after the loss is removed.")
 *
 * The §3.9 world on `staged.world` at stage P3 (`accept.p3.ppp.harness.ts`), the CHAP link up. A 100 % loss impairment
 * starts right after an answered echo exchange; each end then sends one Echo-Request per keepalive interval into the
 * loss and, on the tick that finds `PPP_ECHO_MISSES` of them unanswered, reports `keepalive-missed` and renegotiates.
 * The count of intervals from the last answered echo to the report is computed from `PPP_ECHO_MISSES` (never typed)
 * and must equal the row's 5 intervals exactly; the same holds for a configured `keepalive 5`. Removing the loss brings the line back: at the next LCP restart while LCP still negotiates, or at the
 * periodic retry after LCP gave up (Max-Configure requests, `PPP_RESTART_NS` apart).
 */
import { describe, expect, it } from 'vitest';
import type { Simulation } from '../src/contracts/simulation.js';
import { HDLC_KEEPALIVE_DEFAULT_NS } from '../src/contracts/services.js';
import { MS, SEC, type SimTime } from '../src/contracts/time.js';
import { PPP_MAX_CONFIGURE, PPP_RESTART_NS } from '../src/protocols/ppp/fsm.js';
import { PPP_ECHO_MISSES, PPP_ECHO_TAG, PPP_RETRY_NS } from '../src/protocols/ppp.js';
import { canonical, frameLabel, fsmTimes, pppRow, pppWorld, SE0, serial, wireFrames } from './accept.p3.ppp.harness.js';
import { ofKind, ping } from './sim.harness.js';

/** §10.1: `keepalive-missed` after 5 intervals (exactly; counted from the last answered echo). */
const ROW_INTERVALS = 5;

interface Outage {
  readonly sim: Simulation;
  readonly interval: SimTime;
  /** The transmit start of the last Echo-Request that was answered. */
  readonly tLast: SimTime;
  /** The time both ends reported `keepalive-missed`. */
  readonly tDown: SimTime;
}

/**
 * The CHAP link up with keepalive `interval`, one echo exchange answered, then 100 % loss; run until one interval
 * after the expected report. Asserts the report, the echoes sent into the loss and the rows.
 */
function outage(interval: SimTime, seconds?: number): Outage {
  const extra = seconds === undefined ? [] : [` keepalive ${seconds}`];
  const sim = pppWorld({ r1: { extra }, r2: { extra } });
  const [tOpen] = fsmTimes(sim.trace(0).events, 'r1', 'ppp-lcp', 'opened');
  expect(fsmTimes(sim.trace(0).events, 'r2', 'ppp-lcp', 'opened')).toEqual([tOpen]);
  // the first echo exchange: request and reply on both ends, one interval after LCP opened, background
  let cursor = sim.trace(0).next;
  sim.runUntil(tOpen! + interval + 100 * MS);
  const first = canonical(wireFrames(sim, sim.trace(cursor).events));
  expect(first.map(frameLabel)).toEqual(['R1 LCP echo-request id 2', 'R2 LCP echo-request id 2', 'R1 LCP echo-reply id 2', 'R2 LCP echo-reply id 2']);
  expect(first.every((f) => f.background && f.tag === PPP_ECHO_TAG)).toBe(true);
  const tLast = first[0]!.txStart;
  expect(tLast).toBe(tOpen! + interval);

  // 100 % loss from now on
  sim.setImpairments(serial(sim, 'r1').link!, { lossPct: 100 });
  cursor = sim.trace(0).next;
  const expectedDown = tLast + (PPP_ECHO_MISSES + 1) * interval;
  sim.runUntil(expectedDown + interval);
  const evs = sim.trace(cursor).events;

  // keepalive-missed on both ends, on the same tick, exactly PPP_ECHO_MISSES + 1 intervals after the last answered echo
  const downs = ofKind(evs, 'portState').filter((e) => e.port === SE0 && !e.operUp && e.reason === 'keepalive-missed');
  expect(downs.map((e) => e.device).sort()).toEqual(['r1', 'r2']);
  const tDown = downs[0]!.t;
  expect(downs.every((e) => e.t === tDown)).toBe(true);
  expect(tDown).toBe(expectedDown);
  const intervals = (tDown - tLast) / interval;
  expect(intervals).toBe(PPP_ECHO_MISSES + 1);
  expect(intervals).toBe(ROW_INTERVALS);

  // before the report: one Echo-Request per end per interval, all lost (background), nothing else
  const frames = canonical(wireFrames(sim, evs));
  const before = frames.filter((f) => f.txStart < tDown);
  const expected: string[] = [];
  for (let k = 1; k <= PPP_ECHO_MISSES; k++) expected.push(`R1 LCP echo-request id ${2 + k}`, `R2 LCP echo-request id ${2 + k}`);
  expect(before.map(frameLabel)).toEqual(expected);
  expect(before.map((f) => f.txStart)).toEqual(Array.from({ length: PPP_ECHO_MISSES }, (_v, k) => [tLast + (k + 1) * interval, tLast + (k + 1) * interval]).flat());
  const lost = ofKind(evs, 'drop').filter((e) => e.t < tDown + interval && e.reason === 'link-loss' && e.pdu.tag === PPP_ECHO_TAG);
  expect(lost).toHaveLength(2 * PPP_ECHO_MISSES);
  expect(lost.every((e) => e.background === true)).toBe(true);
  // at the report each end renegotiates at once: a fresh LCP Configure-Request
  expect(frames.filter((f) => f.txStart === tDown).map(frameLabel)).toEqual([`R1 LCP configure-request id ${3 + PPP_ECHO_MISSES}`, `R2 LCP configure-request id ${3 + PPP_ECHO_MISSES}`]);
  for (const d of ['r1', 'r2']) {
    expect(serial(sim, d).operUp).toBe(false);
    expect(serial(sim, d).phy).toMatchObject({ carrier: true, lineProtocol: false, lineProtocolReason: 'keepalive-missed' });
    expect(pppRow(sim, d)).toMatchObject({ phase: 'establish', lcp: 'req-sent', failures: 1, lastFailure: `${PPP_ECHO_MISSES} LCP echo requests went unanswered` });
  }
  return { sim, interval, tLast, tDown };
}

describe('accept.p3.ppp-keepalive [S19] keepalive-missed after 5 intervals', () => {
  it('100 % loss after an answered echo: keepalive-missed on both ends after PPP_ECHO_MISSES unanswered echoes, exactly 5 intervals', () => {
    expect(PPP_ECHO_MISSES + 1).toBe(ROW_INTERVALS);
    outage(HDLC_KEEPALIVE_DEFAULT_NS);
  });

  it('the interval is the configured one: `keepalive 5` reports after the same number of 5-second intervals', () => {
    const o = outage(5 * SEC, 5);
    expect(o.tDown - o.tLast).toBe(ROW_INTERVALS * 5 * SEC);
  });

  it('recovers after the loss is removed while LCP still renegotiates: at the next LCP restart', () => {
    const { sim, tDown } = outage(HDLC_KEEPALIVE_DEFAULT_NS);
    // the renegotiation sends a Configure-Request every PPP_RESTART_NS; remove the loss halfway between two of them
    sim.runUntil(sim.now + PPP_RESTART_NS / 2);
    const removeAt = sim.now;
    expect(removeAt).toBeLessThan(tDown + (PPP_MAX_CONFIGURE - 1) * PPP_RESTART_NS);
    sim.setImpairments(serial(sim, 'r1').link!, { lossPct: 0 });
    const nextRequest = tDown + (Math.floor((removeAt - tDown) / PPP_RESTART_NS) + 1) * PPP_RESTART_NS;
    const cursor = sim.trace(0).next;
    sim.runUntil(nextRequest + 100 * MS);
    const evs = sim.trace(cursor).events;
    const frames = canonical(wireFrames(sim, evs));
    expect(frames[0]!.txStart).toBe(nextRequest);
    expect(frames.slice(0, 2).map((f) => f.fields.code)).toEqual([1, 1]);
    for (const d of ['r1', 'r2']) {
      expect(pppRow(sim, d)).toMatchObject({ phase: 'network', lcp: 'opened', ipcp: 'opened', authLocalState: 'success', authPeerState: 'success', failures: 1 });
      expect(serial(sim, d).operUp).toBe(true);
    }
    expect(ofKind(evs, 'portState').filter((e) => e.port === SE0 && e.operUp).every((e) => e.t > nextRequest && e.t < nextRequest + 100 * MS)).toBe(true);
    expect(ping(sim, 'r1', '10.1.1.2').text).toContain('!!!!!');
  });

  it('recovers after the loss is removed once LCP gave up (Max-Configure requests): at the periodic retry, PPP_RETRY_NS later', () => {
    const { sim, tDown } = outage(HDLC_KEEPALIVE_DEFAULT_NS);
    // LCP sends Max-Configure requests PPP_RESTART_NS apart, then stops on the last timeout; runToIdle returns there
    const tStopped = tDown + PPP_MAX_CONFIGURE * PPP_RESTART_NS;
    const cursor = sim.trace(0).next;
    expect(sim.runToIdle().stopped).toBeUndefined();
    expect(sim.now).toBe(tStopped);
    const tries = canonical(wireFrames(sim, sim.trace(cursor).events));
    expect(tries.every((f) => f.proto === 'lcp' && f.fields.code === 1)).toBe(true);
    for (const d of ['r1', 'r2']) {
      expect(fsmTimes(sim.trace(0).events, d, 'ppp-lcp', 'stopped')).toEqual([tStopped]);
      expect(pppRow(sim, d)).toMatchObject({ phase: 'dead', lcp: 'stopped' });
      expect(serial(sim, d).phy?.lineProtocolReason).toBe('keepalive-missed');
    }
    // every request of the renegotiation, PPP_RESTART_NS apart (those before `now` were already counted by outage())
    const all = canonical(wireFrames(sim, sim.trace(0).events)).filter((f) => f.from === 'r1' && f.proto === 'lcp' && f.fields.code === 1 && f.txStart >= tDown);
    expect(all.map((f) => f.txStart)).toEqual(Array.from({ length: PPP_MAX_CONFIGURE }, (_v, k) => tDown + k * PPP_RESTART_NS));

    sim.setImpairments(serial(sim, 'r1').link!, { lossPct: 0 });
    const c2 = sim.trace(0).next;
    sim.runUntil(tStopped + PPP_RETRY_NS + 100 * MS);
    const frames = canonical(wireFrames(sim, sim.trace(c2).events));
    expect(frames[0]!.txStart).toBe(tStopped + PPP_RETRY_NS);
    for (const d of ['r1', 'r2']) {
      expect(pppRow(sim, d)).toMatchObject({ phase: 'network', lcp: 'opened', ipcp: 'opened', failures: 2 });
      expect(serial(sim, d).operUp).toBe(true);
    }
    expect(ping(sim, 'r1', '10.1.1.2').text).toContain('!!!!!');
  });
});
