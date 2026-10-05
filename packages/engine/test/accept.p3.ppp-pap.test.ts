/**
 * accept.p3.ppp-pap [S19] — ARCHITECTURE-P3 §10.1: "PAP in clear, as the WAN map's row." The WAN map's row: "The
 * password appears in the Authenticate-Request bytes; Ack. A peer without `sent-username` is NAKed and LCP stops after
 * Max-Failure. One-way PAP works." (D17 "PAP travels in clear on purpose"; §3.9 step 6's closing sentence; §5.7
 * `ppp authentication pap`, `ppp pap sent-username <n> password <pw>`; rule 19.)
 *
 * The §3.9 world on `staged.world` at stage P3 (`accept.p3.ppp.harness.ts`) with PAP lines instead of CHAP:
 *   - PAP both ways: each end `ppp authentication pap` and `ppp pap sent-username <own name> password NetF0rge`; the
 *     Authenticate-Request is pinned byte for byte (RFC 1334 §2.2: code, id, length, Peer-ID length, Peer-ID,
 *     Passwd-Length, Password), so the password is visibly in the clear on the wire;
 *   - one-way PAP: R1 `ppp authentication pap`, R2 only `ppp pap sent-username R2 password NetF0rge`;
 *   - a peer without `sent-username`: it naks the PAP option (suggesting CHAP, the protocol it always answers); the
 *     PAP-only authenticator asks again; after Max-Failure naks (`PPP_MAX_FAILURE`, RFC 1661 §4.6) the peer rejects the
 *     option and both LCPs stop — no PAP packet is ever sent, and `runToIdle` returns.
 * Counts follow from `PPP_MAX_FAILURE` and `PPP_RETRY_NS`, never typed.
 */
import { describe, expect, it } from 'vitest';
import { PPP_ADDRESS, PPP_CONTROL, PPP_PROTO } from '../src/contracts/pdu.js';
import { SEC } from '../src/contracts/time.js';
import { PPP_MAX_FAILURE } from '../src/protocols/ppp/fsm.js';
import { PPP_LOG_FACILITY, PPP_RETRY_NS, PPP_TEXT } from '../src/protocols/ppp.js';
import {
  asciiOf,
  canonical,
  frameLabel,
  fsmMoves,
  fsmTimes,
  indexOfBytes,
  pppRow,
  pppWorld,
  SE0,
  SECRET,
  serial,
  wireFrames,
  wireNs,
  type WireFrame,
} from './accept.p3.ppp.harness.js';
import { ofKind, ping } from './sim.harness.js';

const pap = (user: string): string[] => [' encapsulation ppp', ' ppp authentication pap', ` ppp pap sent-username ${user} password ${SECRET}`];
const by = (frames: readonly WireFrame[], label: string): WireFrame => {
  const f = frames.find((x) => frameLabel(x) === label);
  if (f === undefined) throw new Error(`no frame "${label}"`);
  return f;
};

/** The RFC 1334 Authenticate-Request inside its PPP frame (without the 2-byte FCS). */
function papRequestImage(id: number, peerId: string, password: string): number[] {
  const body = [peerId.length, ...asciiOf(peerId), password.length, ...asciiOf(password)];
  const length = 4 + body.length;
  return [PPP_ADDRESS, PPP_CONTROL, PPP_PROTO.pap >> 8, PPP_PROTO.pap & 0xff, 1, id, length >> 8, length & 0xff, ...body];
}

describe('accept.p3.ppp-pap [S19] the password in the clear', () => {
  it('PAP both ways: the password is in the Authenticate-Request bytes (RFC 1334 image); Ack; the link comes up and carries a ping', () => {
    const sim = pppWorld({ r1: { ppp: pap('R1') }, r2: { ppp: pap('R2') }, settle: false });
    expect(sim.runToIdle().stopped).toBeUndefined();
    const evs = sim.trace(0).events;
    const frames = canonical(wireFrames(sim, evs));
    expect(frames.map(frameLabel)).toEqual([
      'R1 LCP configure-request id 1',
      'R2 LCP configure-request id 1',
      'R1 LCP configure-ack id 1',
      'R2 LCP configure-ack id 1',
      'R1 PAP authenticate-request id 1',
      'R2 PAP authenticate-request id 1',
      'R1 PAP authenticate-ack id 1',
      'R2 PAP authenticate-ack id 1',
      'R1 IPCP configure-request id 1',
      'R2 IPCP configure-request id 1',
      'R1 IPCP configure-ack id 1',
      'R2 IPCP configure-ack id 1',
    ]);
    for (const f of frames) expect(f.txEnd - f.txStart).toBe(wireNs(f.size));
    // LCP asks for PAP (option 3, 0xc023) and each end acknowledges it (both have sent-username)
    for (const me of ['R1', 'R2']) {
      expect(by(frames, `${me} LCP configure-request id 1`).fields).toMatchObject({ code: 1, id: 1, authProto: 'pap' });
      expect(by(frames, `${me} LCP configure-ack id 1`).fields).toMatchObject({ code: 2, id: 1, authProto: 'pap' });
    }
    for (const me of ['R1', 'R2']) {
      const req = by(frames, `${me} PAP authenticate-request id 1`);
      expect(req.protocol).toBe(PPP_PROTO.pap);
      expect(req.fields).toMatchObject({ code: 1, id: 1, peerId: me, password: SECRET });
      // byte for byte: the password sits in the clear right after its length byte
      const image = papRequestImage(1, me, SECRET);
      expect(Array.from(req.bytes.subarray(0, image.length))).toEqual(image);
      expect(req.bytes.length).toBe(image.length + 2); // + the FCS
      expect(indexOfBytes(req.bytes, asciiOf(SECRET))).toBe(image.length - SECRET.length);
      expect(by(frames, `${me} PAP authenticate-ack id 1`).fields).toMatchObject({ code: 2, id: 1, message: PPP_TEXT.papSuccess });
    }
    // the Ack answers the request it received: each Ack starts when the peer's request has arrived
    expect(by(frames, 'R1 PAP authenticate-ack id 1').txStart).toBe(by(frames, 'R2 PAP authenticate-request id 1').arrive);
    for (const d of ['r1', 'r2']) {
      expect(pppRow(sim, d)).toMatchObject({ phase: 'network', lcp: 'opened', authLocal: 'pap', authLocalState: 'success', authPeer: 'pap', authPeerState: 'success', ipcp: 'opened', failures: 0 });
      expect(serial(sim, d).operUp).toBe(true);
      expect(fsmMoves(evs, d, 'ppp-auth')).toEqual([`${SE0}: pending->success`]);
    }
    expect(pppRow(sim, 'r1')!.peerName).toBe('R2');
    expect(ping(sim, 'r2', '10.1.1.1').text).toContain('!!!!!');
  });

  it('one-way PAP works: R1 requires PAP, R2 sends its sent-username credentials; the line comes up on both ends', () => {
    const sim = pppWorld({ r1: { ppp: [' encapsulation ppp', ' ppp authentication pap'] }, r2: { ppp: [' encapsulation ppp', ` ppp pap sent-username R2 password ${SECRET}`] }, settle: false });
    expect(sim.runToIdle().stopped).toBeUndefined();
    const evs = sim.trace(0).events;
    const frames = canonical(wireFrames(sim, evs));
    expect(frames.map(frameLabel)).toEqual([
      'R1 LCP configure-request id 1',
      'R2 LCP configure-request id 1',
      'R1 LCP configure-ack id 1',
      'R2 LCP configure-ack id 1',
      'R2 PAP authenticate-request id 1',
      'R1 PAP authenticate-ack id 1',
      // R1 enters the Network phase when it sends its Ack, R2 when the Ack arrives: R1's IPCP request leaves first,
      // and so R2's acknowledgement of it does too
      'R1 IPCP configure-request id 1',
      'R2 IPCP configure-request id 1',
      'R2 IPCP configure-ack id 1',
      'R1 IPCP configure-ack id 1',
    ]);
    // the network phase: R1 at its Ack (its IPCP request follows the Ack on the wire), R2 when the Ack arrives
    const ack = by(frames, 'R1 PAP authenticate-ack id 1');
    expect(by(frames, 'R1 IPCP configure-request id 1').txStart).toBe(ack.txEnd);
    expect(by(frames, 'R2 IPCP configure-request id 1').txStart).toBe(ack.arrive);
    expect(by(frames, 'R1 LCP configure-request id 1').fields).toMatchObject({ authProto: 'pap' });
    expect(by(frames, 'R2 LCP configure-request id 1').fields.authProto).toBeUndefined();
    expect(by(frames, 'R2 LCP configure-ack id 1').fields).toMatchObject({ authProto: 'pap' });
    const req = by(frames, 'R2 PAP authenticate-request id 1');
    expect(req.fields).toMatchObject({ peerId: 'R2', password: SECRET });
    expect(Array.from(req.bytes.subarray(0, papRequestImage(1, 'R2', SECRET).length))).toEqual(papRequestImage(1, 'R2', SECRET));
    expect(pppRow(sim, 'r1')).toMatchObject({ phase: 'network', authLocal: 'pap', authLocalState: 'success', authPeer: 'none', peerName: 'R2' });
    expect(pppRow(sim, 'r2')).toMatchObject({ phase: 'network', authLocal: 'none', authPeer: 'pap', authPeerState: 'success' });
    expect(pppRow(sim, 'r2')!.authLocalState).toBeUndefined();
    for (const d of ['r1', 'r2']) expect(serial(sim, d).operUp).toBe(true);
    expect(ping(sim, 'r1', '10.1.1.2').text).toContain('!!!!!');
  });
});

describe('accept.p3.ppp-pap [S19] a peer without sent-username is NAKed and LCP stops after Max-Failure', () => {
  /** R1 PAP-only, R2 with `encapsulation ppp` alone (no `ppp pap sent-username`). */
  const world = () => pppWorld({ r1: { ppp: [' encapsulation ppp', ' ppp authentication pap'] }, r2: { ppp: [' encapsulation ppp'] }, settle: false });

  /**
   * One attempt on the wire, from its first request: R1 asks for PAP, R2 naks (suggesting chap-md5) and R1 asks again;
   * R2's first nak goes out before R1's Configure-Ack reaches it (a received Ack does not reset R2's count: RFC 1661
   * §4.6 counts naks sent without a Configure-Ack sent), so Max-Failure naks in all, then the Configure-Reject.
   * `first` is the attempt's first LCP identifier on each end.
   */
  function attemptOrder(first: { r1: number; r2: number }, r2First: boolean): string[] {
    const out: string[] = r2First
      ? [`R2 LCP configure-request id ${first.r2}`, `R1 LCP configure-request id ${first.r1}`, `R1 LCP configure-ack id ${first.r2}`, `R2 LCP configure-nak id ${first.r1}`]
      : [`R1 LCP configure-request id ${first.r1}`, `R2 LCP configure-request id ${first.r2}`, `R1 LCP configure-ack id ${first.r2}`, `R2 LCP configure-nak id ${first.r1}`];
    for (let k = 1; k < PPP_MAX_FAILURE; k++) out.push(`R1 LCP configure-request id ${first.r1 + k}`, `R2 LCP configure-nak id ${first.r1 + k}`);
    out.push(`R1 LCP configure-request id ${first.r1 + PPP_MAX_FAILURE}`, `R2 LCP configure-reject id ${first.r1 + PPP_MAX_FAILURE}`);
    return out;
  }

  it('R2 naks PAP with chap-md5 until Max-Failure, then rejects it; both LCPs stop; no PAP packet; ppp-auth-failed; runToIdle returns', () => {
    const sim = world();
    const stats = sim.runToIdle();
    expect(stats.stopped).toBeUndefined();
    expect(stats.events).toBeLessThan(5_000);
    const evs = sim.trace(0).events;
    const frames = canonical(wireFrames(sim, evs));
    // the two first requests start at once, so canonical order puts R1's first
    expect(frames.map(frameLabel)).toEqual(attemptOrder({ r1: 1, r2: 1 }, false));
    expect(frames.every((f) => f.proto === 'lcp')).toBe(true); // no PAP (nor CHAP) packet at all
    for (const f of frames.filter((x) => x.from === 'r1' && x.fields.code === 1)) expect(f.fields).toMatchObject({ authProto: 'pap' });
    for (const f of frames.filter((x) => x.fields.code === 3)) expect(f.fields).toMatchObject({ code: 3, authProto: 'chap-md5' });
    const reject = frames[frames.length - 1]!;
    expect(reject.fields).toMatchObject({ code: 4, rejected: 'auth-proto', authProto: 'pap' });
    // exactly Max-Failure naks went out in the attempt (RFC 1661 §4.6: R2 never sent a Configure-Ack), one of them
    // before R1's Configure-Ack reached R2, then the reject
    const ackArrive = by(frames, 'R1 LCP configure-ack id 1').arrive;
    expect(frames.filter((f) => f.fields.code === 3)).toHaveLength(PPP_MAX_FAILURE);
    expect(frames.filter((f) => f.fields.code === 3 && f.txStart >= ackArrive)).toHaveLength(PPP_MAX_FAILURE - 1);
    // each request answers the nak that just arrived (as soon as R1's transmitter is free)
    const r1Frames = frames.filter((f) => f.from === 'r1');
    for (let i = 1; i < r1Frames.length; i++) {
      const f = r1Frames[i]!;
      if (f.fields.code !== 1) continue;
      const nak = by(frames, `R2 LCP configure-nak id ${Number(f.fields.id) - 1}`);
      expect(f.txStart).toBe(Math.max(nak.arrive, r1Frames[i - 1]!.txEnd));
    }
    // LCP stops on both ends: R2 at its reject, R1 when the reject arrives; neither ever opened
    expect(fsmTimes(evs, 'r2', 'ppp-lcp', 'stopped')).toEqual([reject.txStart]);
    expect(fsmTimes(evs, 'r1', 'ppp-lcp', 'stopped')).toEqual([reject.arrive]);
    for (const d of ['r1', 'r2']) {
      expect(fsmTimes(evs, d, 'ppp-lcp', 'opened')).toEqual([]);
      expect(pppRow(sim, d)).toMatchObject({ phase: 'dead', lcp: 'stopped', failures: 1 });
      expect(serial(sim, d).operUp).toBe(false);
      expect(serial(sim, d).phy).toMatchObject({ carrier: true, lineProtocol: false, lineProtocolReason: 'ppp-auth-failed' });
    }
    expect(pppRow(sim, 'r1')).toMatchObject({ authLocal: 'pap', lastFailure: 'the peer refuses to authenticate' });
    expect(pppRow(sim, 'r2')!.lastFailure).toBe('the peer asks for PAP, and no ppp pap sent-username is configured here');
    expect(ofKind(evs, 'log').filter((e) => e.facility === PPP_LOG_FACILITY)).toEqual([]); // no authentication ran
  });

  it('the periodic retry repeats the same bounded exchange every PPP_RETRY_NS; adding sent-username makes the next retry succeed', () => {
    const sim = world();
    sim.runToIdle();
    const [stop0] = fsmTimes(sim.trace(0).events, 'r1', 'ppp-lcp', 'stopped');
    const WINDOW = 30 * SEC;
    const cursor = sim.trace(0).next;
    sim.runFor(WINDOW);
    const evs = sim.trace(cursor).events;
    const frames = canonical(wireFrames(sim, evs));
    expect(frames.every((f) => f.proto === 'lcp')).toBe(true);
    // every attempt ends in R2's reject after Max-Failure naks; each attempt starts PPP_RETRY_NS after an
    // end stopped (R2 stops first, at its reject, so its retry opens the next attempt)
    const rejects = frames.filter((f) => f.fields.code === 4);
    const r2Stops = fsmTimes(sim.trace(0).events, 'r2', 'ppp-lcp', 'stopped');
    expect(rejects.length).toBe(r2Stops.length - 1);
    expect(rejects.length).toBeGreaterThanOrEqual(Math.floor(WINDOW / PPP_RETRY_NS) - 1);
    const firstOfAttempt = frames.filter((f) => f.from === 'r2' && f.fields.code === 1).map((f) => f.txStart);
    expect(firstOfAttempt).toEqual(r2Stops.slice(0, firstOfAttempt.length).map((t) => t + PPP_RETRY_NS));
    for (const d of ['r1', 'r2']) {
      expect(pppRow(sim, d)).toMatchObject({ lcp: 'stopped', failures: 1 + rejects.length });
      expect(serial(sim, d).phy?.lineProtocolReason).toBe('ppp-auth-failed');
    }
    expect(stop0).toBeLessThan(firstOfAttempt[0]!);
    expect(sim.runToIdle().stopped).toBeUndefined();

    // R2 gains its PAP credentials: the next retry acknowledges PAP and the line comes up
    const d2 = sim.device('r2')!;
    d2.applyActions('sim', [], sim.now);
    expect(d2.applyConfigLine([['interface', SE0]], ['ppp', 'pap', 'sent-username', 'R2', 'password', SECRET], false)).toEqual({ ok: true });
    const c2 = sim.trace(0).next;
    sim.runFor(PPP_RETRY_NS + SEC);
    const up = canonical(wireFrames(sim, sim.trace(c2).events));
    expect(up.filter((f) => f.proto === 'pap').map(frameLabel)).toEqual(['R2 PAP authenticate-request id 1', 'R1 PAP authenticate-ack id 1']);
    for (const d of ['r1', 'r2']) {
      expect(pppRow(sim, d)).toMatchObject({ phase: 'network', lcp: 'opened', ipcp: 'opened' });
      expect(serial(sim, d).operUp).toBe(true);
    }
    expect(pppRow(sim, 'r1')).toMatchObject({ authLocal: 'pap', authLocalState: 'success' });
  });

  it('a PAP-or-CHAP authenticator (`pap chap`) takes the suggested CHAP instead: the line comes up', () => {
    const sim = pppWorld({ r1: { ppp: [' encapsulation ppp', ' ppp authentication pap chap'] }, r2: { ppp: [' encapsulation ppp'] }, settle: false });
    expect(sim.runToIdle().stopped).toBeUndefined();
    const frames = canonical(wireFrames(sim, sim.trace(0).events));
    expect(frames.map(frameLabel).slice(0, 6)).toEqual([
      'R1 LCP configure-request id 1',
      'R2 LCP configure-request id 1',
      'R1 LCP configure-ack id 1',
      'R2 LCP configure-nak id 1',
      'R1 LCP configure-request id 2',
      'R2 LCP configure-ack id 2',
    ]);
    expect(by(frames, 'R1 LCP configure-request id 2').fields).toMatchObject({ authProto: 'chap-md5' });
    expect(frames.some((f) => f.proto === 'pap')).toBe(false);
    expect(pppRow(sim, 'r1')).toMatchObject({ phase: 'network', authLocal: 'chap', authLocalState: 'success' });
    for (const d of ['r1', 'r2']) expect(serial(sim, d).operUp).toBe(true);
  });
});
