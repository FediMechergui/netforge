/**
 * accept.p3.ppp-chap [S19] — ARCHITECTURE-P3 §10.1: "§3.9: exact message order; `MD5(id ‖ secret ‖ challenge)`; the
 * secret in no byte, snapshot or trace; the wrong-password retry count under `runFor(60 s)`." (§3.9, §4.1, §4.2, §4.3,
 * §5.7, §5.8; rule 19; R37, R43.)
 *
 * The §3.9 world on `staged.world` at stage P3 (`accept.p3.ppp.harness.ts`): R1 Se0/0/0 (DCE, `clock rate 64000`) ↔
 * R2 Se0/0/0 on a `serial-dce` cable, 10.1.1.0/30, `username <peer> password NetF0rge`, `encapsulation ppp` and
 * `ppp authentication chap` on both ends. The walk-through is followed step by step: the HDLC/PPP mismatch (step 1),
 * R2's `encapsulation ppp` (step 2), LCP, CHAP and IPCP on the wire in their exact order and times (steps 3–5), the
 * ping across and the background LCP echoes (step 5), then the wrong password (step 6) with its periodic retry, whose
 * count over 60 s is computed from `PPP_RETRY_NS` and the measured attempt length, never typed.
 *
 * Times come from the trace; frame times from `serializationNs` at the §3.9 clock rate (`wireNs`). Frames that start
 * at the same instant on both ends ("both ends at once") are ordered by sender (`canonical`).
 */
import { describe, expect, it } from 'vitest';
import { PPP_PROTO } from '../src/contracts/pdu.js';
import type { RouteRow } from '../src/contracts/tables.js';
import { HDLC_KEEPALIVE_DEFAULT_NS } from '../src/contracts/services.js';
import { MS, SEC, serializationNs } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { CONFIG_SECRET_MASK } from '../src/cli/config-rules.js';
import { encodeReversibleSecret, secretTokens } from '../src/cli/secrets.js';
import { chapMd5Response, md5, md5Hex } from '../src/core/md5.js';
import { PPP_ECHO_TAG, PPP_LOG_FACILITY, PPP_LOG_SEVERITY, PPP_PROCESS, PPP_RETRY_NS, PPP_TEXT } from '../src/protocols/ppp.js';
import {
  applyLine,
  asciiOf,
  canonical,
  CLOCK_BPS,
  exec,
  frameLabel,
  fsmMoves,
  fsmTimes,
  indexOfBytes,
  jsonOf,
  pppRow,
  pppWorld,
  SE0,
  SECRET,
  serial,
  SERIAL_OVERHEAD,
  wireFrames,
  wireNs,
  type WireFrame,
} from './accept.p3.ppp.harness.js';
import { ofKind, ping } from './sim.harness.js';

/** §3.9 steps 3–5 on the wire, both directions, in order. */
const UP_ORDER: readonly string[] = Object.freeze([
  'R1 LCP configure-request id 1',
  'R2 LCP configure-request id 1',
  'R1 LCP configure-ack id 1',
  'R2 LCP configure-ack id 1',
  'R1 CHAP challenge id 1',
  'R2 CHAP challenge id 1',
  'R1 CHAP response id 1',
  'R2 CHAP response id 1',
  'R1 CHAP success id 1',
  'R2 CHAP success id 1',
  'R1 IPCP configure-request id 1',
  'R2 IPCP configure-request id 1',
  'R1 IPCP configure-ack id 1',
  'R2 IPCP configure-ack id 1',
]);

/** §3.9 step 6 on the wire: attempt `n` (from 0) of a wrong password; LCP identifiers advance by 2 per attempt. */
function failedOrder(n: number): string[] {
  const lcp = 1 + 2 * n;
  const chap = 1 + n;
  const both = (s: string): string[] => [`R1 ${s}`, `R2 ${s}`];
  return [
    ...both(`LCP configure-request id ${lcp}`),
    ...both(`LCP configure-ack id ${lcp}`),
    ...both(`CHAP challenge id ${chap}`),
    ...both(`CHAP response id ${chap}`),
    ...both(`CHAP failure id ${chap}`),
    ...both(`LCP terminate-request id ${lcp + 1}`),
    ...both(`LCP terminate-ack id ${lcp + 1}`),
  ];
}

const by = (frames: readonly WireFrame[], label: string): WireFrame => {
  const f = frames.find((x) => frameLabel(x) === label);
  if (f === undefined) throw new Error(`no frame "${label}"`);
  return f;
};
const bytesOf = (v: unknown): Uint8Array => (v instanceof Uint8Array ? v : new Uint8Array(0));
const PEER: Readonly<Record<string, string>> = Object.freeze({ R1: 'R2', R2: 'R1' });

describe('accept.p3.ppp-chap [S19] §3.9 steps 1–5: the switch, LCP, CHAP and IPCP in their exact order', () => {
  it('step 1 sends nothing; step 2 starts both LCPs at once; the 14 frames of steps 3–5 in exact order and times; LCP open within 100 ms', () => {
    // step 1: R1 has ppp, R2 still hdlc (its `ppp authentication chap` is stored, the encapsulation is not yet)
    const sim = pppWorld({ r2: { ppp: [' ppp authentication chap'] } });
    for (const d of ['r1', 'r2']) {
      expect(serial(sim, d).operUp).toBe(false);
      expect(serial(sim, d).phy).toMatchObject({ carrier: true, lineProtocol: false, lineProtocolReason: 'encapsulation-mismatch' });
    }
    expect(pppRow(sim, 'r1')).toMatchObject({ phase: 'dead', lcp: 'starting' });
    expect(pppRow(sim, 'r2')).toBeUndefined();
    let cursor = sim.trace(0).next;
    sim.runFor(30 * SEC);
    expect(wireFrames(sim, sim.trace(cursor).events)).toEqual([]);

    // step 2: R2 applies encapsulation ppp
    cursor = sim.trace(0).next;
    const tSwitch = sim.now;
    applyLine(sim, 'r2', [['interface', SE0]], ['encapsulation', 'ppp']);
    expect(serial(sim, 'r2').encap).toBe('ppp');
    expect(sim.runToIdle().stopped).toBeUndefined();
    const evs = sim.trace(cursor).events;
    const frames = canonical(wireFrames(sim, evs));

    // steps 3–5, exactly
    expect(frames.map(frameLabel)).toEqual(UP_ORDER);
    expect(frames.every((f) => f.framing === 'ppp' && !f.background)).toBe(true);
    // both ends at once at the switch; every later pair starts when the pair it answers has arrived; each frame takes
    // its serialisation at 64 kb/s (the 23-byte LCP request: ≈ 2.9 ms)
    expect(frames[0]!.txStart).toBe(tSwitch);
    for (let k = 0; k < frames.length; k += 2) {
      const a = frames[k]!;
      const b = frames[k + 1]!;
      expect(b.txStart).toBe(a.txStart);
      expect(b.arrive).toBe(a.arrive);
      for (const f of [a, b]) expect(f.txEnd - f.txStart).toBe(wireNs(f.size));
      if (k > 0) expect(a.txStart).toBe(frames[k - 1]!.arrive);
    }
    expect(frames[0]!.size + SERIAL_OVERHEAD).toBe(23);
    expect(frames[0]!.txEnd - frames[0]!.txStart).toBe(serializationNs(23, CLOCK_BPS));

    // LCP Opened on both ends on the ACK of its own request, within 100 ms of the switch (the WAN map's row)
    const tOpen = frames[3]!.arrive;
    for (const d of ['r1', 'r2']) {
      expect(fsmTimes(evs, d, 'ppp-lcp', 'opened')).toEqual([tOpen]);
      expect(fsmTimes(evs, d, 'ppp-auth', 'success')).toEqual([frames[9]!.arrive]);
      expect(fsmTimes(evs, d, 'ppp-ncp', 'opened')).toEqual([frames[13]!.arrive]);
    }
    expect(tOpen - tSwitch).toBeLessThan(100 * MS);
    expect(fsmMoves(evs, 'r2', 'ppp-lcp')).toEqual([`${SE0}: initial->starting`, `${SE0}: starting->req-sent`, `${SE0}: req-sent->ack-sent`, `${SE0}: ack-sent->opened`]);
    expect(fsmMoves(evs, 'r1', 'ppp-lcp')).toEqual([`${SE0}: starting->req-sent`, `${SE0}: req-sent->ack-sent`, `${SE0}: ack-sent->opened`]);
    for (const d of ['r1', 'r2']) {
      expect(fsmMoves(evs, d, 'ppp-auth')).toEqual([`${SE0}: pending->success`]);
      expect(fsmMoves(evs, d, 'ppp-ncp').slice(-3)).toEqual([`${SE0} IPCP: starting->req-sent`, `${SE0} IPCP: req-sent->ack-sent`, `${SE0} IPCP: ack-sent->opened`]);
    }

    // step 3: ConfReq id 1 [ppp 0xc021, lcp {code 1, authProto chap-md5, magic}]; each ACKs the other's options
    const req1 = by(frames, 'R1 LCP configure-request id 1');
    const req2 = by(frames, 'R2 LCP configure-request id 1');
    for (const r of [req1, req2]) {
      expect(r.protocol).toBe(PPP_PROTO.lcp);
      expect(r.fields).toMatchObject({ code: 1, id: 1, authProto: 'chap-md5' });
      expect(Object.keys(r.fields).filter((k) => !['code', 'id', 'length'].includes(k)).sort()).toEqual(['authProto', 'magic']);
    }
    expect(req1.fields.magic).not.toBe(req2.fields.magic);
    expect(by(frames, 'R1 LCP configure-ack id 1').fields).toMatchObject({ code: 2, id: 1, authProto: 'chap-md5', magic: req2.fields.magic });
    expect(by(frames, 'R2 LCP configure-ack id 1').fields).toMatchObject({ code: 2, id: 1, authProto: 'chap-md5', magic: req1.fields.magic });

    // step 4: Challenge {id 1, 16 bytes, name}; Response {id 1, MD5(id ‖ secret ‖ challenge), name}; Success
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72'); // RFC 1321 A.5: the digest is real MD5
    for (const me of ['R1', 'R2']) {
      const peer = PEER[me]!;
      const challenge = by(frames, `${me} CHAP challenge id 1`);
      expect(challenge.protocol).toBe(PPP_PROTO.chap);
      expect(challenge.fields).toMatchObject({ code: 1, id: 1, name: me });
      const value = bytesOf(challenge.fields.value);
      expect(value.length).toBe(16);
      const response = by(frames, `${peer} CHAP response id 1`);
      expect(response.fields).toMatchObject({ code: 2, id: 1, name: peer });
      const expected = md5(Uint8Array.of(1, ...asciiOf(SECRET), ...value));
      expect(Array.from(bytesOf(response.fields.value))).toEqual(Array.from(expected));
      expect(Array.from(chapMd5Response(1, SECRET, value))).toEqual(Array.from(expected));
      // the value is carried on the wire as is
      expect(indexOfBytes(response.bytes, Array.from(expected))).toBeGreaterThan(0);
      expect(by(frames, `${me} CHAP success id 1`).fields).toMatchObject({ code: 3, id: 1, message: PPP_TEXT.chapSuccess });
    }
    expect(Array.from(bytesOf(by(frames, 'R1 CHAP challenge id 1').fields.value))).not.toEqual(Array.from(bytesOf(by(frames, 'R2 CHAP challenge id 1').fields.value)));

    // both ends report ppp-link up at the Success, before the NCPs: operUp, onLinkChange, C and L
    const ups = ofKind(evs, 'portState').filter((e) => e.port === SE0 && e.operUp);
    expect(ups.map((e) => e.device).sort()).toEqual(['r1', 'r2']);
    expect(ups.every((e) => e.t === frames[9]!.arrive)).toBe(true);
    expect(frames[10]!.txStart).toBe(frames[9]!.arrive);

    // step 5: IPCP ConfReq/ConfAck both ways → opened, peerAddress, the peer route
    expect(by(frames, 'R1 IPCP configure-request id 1').fields).toMatchObject({ code: 1, id: 1, ipAddress: '10.1.1.1' });
    expect(by(frames, 'R2 IPCP configure-request id 1').fields).toMatchObject({ code: 1, id: 1, ipAddress: '10.1.1.2' });
    expect(by(frames, 'R1 IPCP configure-ack id 1').fields).toMatchObject({ code: 2, id: 1, ipAddress: '10.1.1.2' });
    expect(by(frames, 'R2 IPCP configure-ack id 1').fields).toMatchObject({ code: 2, id: 1, ipAddress: '10.1.1.1' });
    for (const [d, me, peer] of [['r1', '10.1.1.1', '10.1.1.2'], ['r2', '10.1.1.2', '10.1.1.1']] as const) {
      expect(pppRow(sim, d)).toMatchObject({
        phase: 'network', lcp: 'opened', authLocal: 'chap', authLocalState: 'success', authPeer: 'chap', authPeerState: 'success',
        ipcp: 'opened', peerAddress: peer, failures: 0,
      });
      expect(serial(sim, d).operUp).toBe(true);
      expect(serial(sim, d).phy).toMatchObject({ carrier: true, lineProtocol: true });
      const rib = sim.device(d)!.tables.rib;
      expect(rib.get('10.1.1.0/30')).toMatchObject({ source: 'C', iface: SE0 });
      expect(rib.get(`${me}/32`)).toMatchObject({ source: 'L', iface: SE0 });
      expect(rib.get(`${peer}/32`) as RouteRow).toMatchObject({ source: 'C', iface: SE0, owner: PPP_PROCESS });
    }
    expect(exec(sim, 'r1', `show interfaces ${SE0}`).split('\n')[0]).toBe(`${SE0}: admin up, link up`);
  });

  it('step 5: a ping crosses as ppp 0x0021, one PduId each way; LCP echoes every 10 s in the background, nothing else', () => {
    const sim = pppWorld();
    const { text, evs } = ping(sim, 'r1', '10.1.1.2');
    expect(text).toContain('!!!!!');
    const echoes = wireFrames(sim, evs).filter((f) => f.proto === 'ipv4');
    expect(echoes).toHaveLength(10);
    expect(echoes.every((f) => f.framing === 'ppp' && f.protocol === PPP_PROTO.ipv4)).toBe(true);
    // one PduId each way: every echo crossed as the PDU its sender's icmpv4 created, each id once
    const made = ofKind(evs, 'pduCreated').filter((e) => e.process === 'icmpv4');
    expect(echoes.map((f) => f.pdu).sort((a, b) => a - b)).toEqual(made.map((e) => e.pdu.id).sort((a, b) => a - b));
    expect(new Set(echoes.map((f) => f.pdu)).size).toBe(10);
    expect(echoes.filter((f) => f.from === 'r1')).toHaveLength(5);

    // LCP echoes: every keepalive interval from LCP Opened, request and reply on both ends, background, tagged
    const [tOpen] = fsmTimes(sim.trace(0).events, 'r1', 'ppp-lcp', 'opened');
    const cursor = sim.trace(0).next;
    const from = sim.now;
    sim.runFor(3 * HDLC_KEEPALIVE_DEFAULT_NS);
    const frames = canonical(wireFrames(sim, sim.trace(cursor).events));
    // tick k (k >= 1) is at tOpen + k intervals and carries LCP identifier k + 1 (identifier 1 was the request)
    const ticks = [1, 2, 3, 4, 5]
      .map((k) => ({ k, t: tOpen! + k * HDLC_KEEPALIVE_DEFAULT_NS }))
      .filter(({ t }) => t > from && t <= from + 3 * HDLC_KEEPALIVE_DEFAULT_NS);
    expect(ticks).toHaveLength(3);
    const expected: string[] = [];
    for (const { k } of ticks) expected.push(`R1 LCP echo-request id ${k + 1}`, `R2 LCP echo-request id ${k + 1}`, `R1 LCP echo-reply id ${k + 1}`, `R2 LCP echo-reply id ${k + 1}`);
    expect(frames.map(frameLabel)).toEqual(expected);
    expect(frames.filter((f) => f.fields.code === 9).map((f) => f.txStart)).toEqual(ticks.flatMap(({ t }) => [t, t]));
    expect(frames.every((f) => f.background && f.tag === PPP_ECHO_TAG)).toBe(true);
    // the echoes rewrite no row and never hold runToIdle
    expect(ofKind(sim.trace(cursor).events, 'tableWrite').filter((e) => e.table === 'ppp')).toEqual([]);
    expect(sim.runToIdle().stopped).toBeUndefined();
  });
});

describe('accept.p3.ppp-chap [S19] the secret in no byte, snapshot or trace', () => {
  /** Every trace event whose JSON contains the plain secret. */
  const carriers = (evs: readonly TraceEvent[]): TraceEvent[] => evs.filter((e) => jsonOf(e).includes(SECRET));

  it('§3.9 with clear-text passwords: no PDU byte, no snapshot, no StateView or debug line; only the configuration lines themselves', () => {
    const sim = pppWorld({ settle: false });
    sim.runToIdle();
    expect(ping(sim, 'r1', '10.1.1.2').text).toContain('!!!!!');
    sim.runFor(30 * SEC);
    const evs = sim.trace(0).events;
    const ids = new Set<number>([...ofKind(evs, 'pduCreated').map((e) => e.pdu.id), ...ofKind(evs, 'frameTx').map((e) => e.pdu.id)]);
    expect(ids.size).toBeGreaterThan(20);
    for (const id of ids) expect(indexOfBytes(sim.pdu(id)!.bytes, asciiOf(SECRET)), `pdu ${id}`).toBe(-1);
    // the snapshot renders the passwords hidden; tables, StateViews and every daemon's debug ring hold no secret
    expect(jsonOf(sim.snapshot())).not.toContain(SECRET);
    for (const d of ['r1', 'r2']) {
      const dev = sim.device(d)!;
      expect(jsonOf(dev.stateSnapshots())).not.toContain(SECRET);
      expect(jsonOf(dev.tables.get('ppp')?.rows())).not.toContain(SECRET);
    }
    // no PDU, debug, log, table, transition or configuration event carries it: in a P3 world the `username … password`
    // line's `configChange` is traced masked (as R36 masks `pre-shared-key`)
    expect(carriers(evs)).toEqual([]);
    expect(
      ofKind(evs, 'configChange')
        .filter((e) => e.context.length === 0 && e.line.startsWith('username '))
        .map((e) => [e.device, e.line]),
    ).toEqual([
      ['r1', `username R2 password ${CONFIG_SECRET_MASK}`],
      ['r2', `username R1 password ${CONFIG_SECRET_MASK}`],
    ]);
  });

  it('with the nf7 form (`service password-encryption`): the secret occurs in no byte of the whole trace, snapshot or PDU, and CHAP still passes', () => {
    const stored = secretTokens(encodeReversibleSecret(SECRET)).join(' ');
    expect(stored.startsWith('nf7 ')).toBe(true);
    expect(stored).not.toContain(SECRET);
    const sim = pppWorld({ r1: { password: stored }, r2: { password: stored }, settle: false });
    sim.runToIdle();
    for (const d of ['r1', 'r2']) expect(pppRow(sim, d)).toMatchObject({ phase: 'network', authLocalState: 'success', authPeerState: 'success' });
    expect(ping(sim, 'r1', '10.1.1.2').text).toContain('!!!!!');
    sim.runFor(30 * SEC);
    const evs = sim.trace(0).events;
    expect(carriers(evs)).toEqual([]);
    expect(jsonOf(evs)).not.toContain(SECRET);
    expect(jsonOf(sim.snapshot())).not.toContain(SECRET);
    for (const e of ofKind(evs, 'frameTx')) expect(indexOfBytes(sim.pdu(e.pdu.id)!.bytes, asciiOf(SECRET))).toBe(-1);
  });
});

describe('accept.p3.ppp-chap [S19] §3.9 step 6: the wrong password', () => {
  it('Failure, the severity-5 log, Terminate-Request/Ack, both LCPs Stopped, ppp-auth-failed on both ends; runToIdle returns in < 5 000 events', () => {
    const sim = pppWorld({ r2: { password: 'WRONG' }, settle: false });
    const stats = sim.runToIdle();
    expect(stats.stopped).toBeUndefined(); // every per-attempt timer is cancelled at Stopped (rule 19)
    expect(stats.events).toBeLessThan(5_000);
    const evs = sim.trace(0).events;
    const frames = canonical(wireFrames(sim, evs));
    expect(frames.map(frameLabel)).toEqual(failedOrder(0));
    // each end answers with the password it holds for the other's name and checks with the same one: R1 expects
    // MD5(1 ‖ NetF0rge ‖ challenge) and R2 answered with WRONG; R2 expects MD5(1 ‖ WRONG ‖ challenge) and R1 answered
    // with NetF0rge — no match, both ways
    const holds: Readonly<Record<string, string>> = { R1: SECRET, R2: 'WRONG' };
    for (const me of ['R1', 'R2']) {
      const peer = PEER[me]!;
      const challenge = bytesOf(by(frames, `${me} CHAP challenge id 1`).fields.value);
      const answer = Array.from(bytesOf(by(frames, `${peer} CHAP response id 1`).fields.value));
      expect(answer).toEqual(Array.from(chapMd5Response(1, holds[peer]!, challenge)));
      expect(answer).not.toEqual(Array.from(chapMd5Response(1, holds[me]!, challenge)));
      expect(by(frames, `${me} CHAP failure id 1`).fields).toMatchObject({ code: 4, id: 1, message: PPP_TEXT.chapMismatch });
      expect(by(frames, `${me} LCP terminate-request id 2`).fields).toMatchObject({ code: 5, id: 2, reason: PPP_TEXT.terminateAuth });
      expect(by(frames, `${me} LCP terminate-ack id 2`).fields).toMatchObject({ code: 6, id: 2 });
    }
    const logs = ofKind(evs, 'log').filter((e) => e.facility === PPP_LOG_FACILITY);
    expect(logs.map((e) => [e.device, e.severity, e.message])).toEqual([
      ['r1', PPP_LOG_SEVERITY, `${SE0}: CHAP authentication of R2 failed: ${PPP_TEXT.chapMismatch}`],
      ['r2', PPP_LOG_SEVERITY, `${SE0}: CHAP authentication of R1 failed: ${PPP_TEXT.chapMismatch}`],
    ]);
    for (const d of ['r1', 'r2']) {
      expect(pppRow(sim, d)).toMatchObject({ phase: 'dead', lcp: 'stopped', authLocalState: 'failed', authPeerState: 'failed', failures: 1 });
      expect(serial(sim, d).operUp).toBe(false);
      expect(serial(sim, d).phy).toMatchObject({ carrier: true, lineProtocol: false, lineProtocolReason: 'ppp-auth-failed' });
      expect(fsmMoves(evs, d, 'ppp-auth')).toEqual([`${SE0}: pending->failed`]);
      expect(fsmMoves(evs, d, 'ppp-lcp').slice(-2)).toEqual([`${SE0}: opened->stopping`, `${SE0}: stopping->stopped`]);
      // both Stopped when the Terminate-Acks arrive
      expect(fsmTimes(evs, d, 'ppp-lcp', 'stopped')).toEqual([frames[frames.length - 1]!.arrive]);
    }
    expect(sim.link(serial(sim, 'r1').link!)!.downReason).toBe('ppp-auth-failed');
    expect(exec(sim, 'r1', `show interfaces ${SE0}`).split('\n')[0]).toBe(`${SE0}: admin up, link up, line protocol down (authentication failed)`);
    // R37: with the connected route gone the CLI answers "No route…" and nothing is traced
    const p = ping(sim, 'r1', '10.1.1.2');
    expect(p.text).toBe('No route to 10.1.1.2 from this device.\n');
    expect(wireFrames(sim, p.evs)).toEqual([]);
  });

  it('a ping routed out of the failed link (a permanent static, R37) drops link-down and never reaches the wire', () => {
    const sim = pppWorld({ r2: { password: 'WRONG' }, r1: { global: [`ip route 10.2.2.0 255.255.255.0 ${SE0} permanent`] } });
    expect(serial(sim, 'r1').phy?.lineProtocolReason).toBe('ppp-auth-failed');
    const p = ping(sim, 'r1', '10.2.2.2');
    expect(p.text).not.toContain('!');
    const drops = ofKind(p.evs, 'drop').filter((e) => e.device === 'r1' && e.pdu.proto === 'icmpv4');
    expect(drops).toHaveLength(5);
    expect(drops.every((e) => e.reason === 'link-down')).toBe(true);
    // (the periodic ppp-retry may run while the ping waits; no IP packet reaches the wire)
    expect(wireFrames(sim, p.evs).filter((f) => f.protocol === PPP_PROTO.ipv4)).toEqual([]);
  });

  it('the periodic ppp-retry: the retry count under runFor(60 s) from PPP_RETRY_NS; correcting the password makes the next retry succeed', () => {
    const sim = pppWorld({ r2: { password: 'WRONG' }, settle: false });
    sim.runToIdle();
    const first = canonical(wireFrames(sim, sim.trace(0).events));
    const [tStop0] = fsmTimes(sim.trace(0).events, 'r1', 'ppp-lcp', 'stopped');
    expect(fsmTimes(sim.trace(0).events, 'r2', 'ppp-lcp', 'stopped')).toEqual([tStop0]);
    expect(sim.now).toBe(tStop0); // runToIdle returned at the end of the attempt
    const attemptNs = tStop0! - first[0]!.txStart; // one attempt: LCP, CHAP, Failure, Terminate exchange

    const WINDOW = 60 * SEC;
    const cursor = sim.trace(0).next;
    sim.runFor(WINDOW);
    const evs = sim.trace(cursor).events;
    const frames = canonical(wireFrames(sim, evs));
    // each retry starts PPP_RETRY_NS after both ends stopped, and takes as long as the first attempt
    let expectedRetries = 0;
    while ((expectedRetries + 1) * (PPP_RETRY_NS + attemptNs) <= WINDOW) expectedRetries++;
    expect(expectedRetries).toBe(Math.floor(WINDOW / PPP_RETRY_NS) - 1); // with the first attempt: 6 attempts in 60 s
    const starts = frames.filter((f) => f.from === 'r1' && f.proto === 'lcp' && f.fields.code === 1).map((f) => f.txStart);
    expect(starts).toEqual(Array.from({ length: expectedRetries }, (_v, k) => tStop0! + (k + 1) * PPP_RETRY_NS + k * attemptNs));
    const expectedOrder: string[] = [];
    for (let n = 1; n <= expectedRetries; n++) expectedOrder.push(...failedOrder(n));
    expect(frames.map(frameLabel)).toEqual(expectedOrder);
    for (const d of ['r1', 'r2']) {
      expect(pppRow(sim, d)).toMatchObject({ lcp: 'stopped', phase: 'dead', failures: 1 + expectedRetries });
      expect(fsmMoves(evs, d, 'ppp-auth')).toEqual(Array.from({ length: expectedRetries }, () => [`${SE0}: failed->pending`, `${SE0}: pending->failed`]).flat());
      expect(serial(sim, d).phy?.lineProtocolReason).toBe('ppp-auth-failed');
    }
    expect(ofKind(evs, 'log').filter((e) => e.device === 'r1' && e.facility === PPP_LOG_FACILITY)).toHaveLength(expectedRetries);
    // between attempts only periodic timers remain
    expect(sim.runToIdle().stopped).toBeUndefined();

    // correct R2's password: the next retry (PPP_RETRY_NS after the last stop) comes up, within 10 s + ε
    const stops = fsmTimes(sim.trace(0).events, 'r1', 'ppp-lcp', 'stopped');
    expect(stops).toHaveLength(1 + expectedRetries);
    const lastStop = stops[stops.length - 1]!;
    const c1 = sim.trace(0).next;
    applyLine(sim, 'r2', [], ['username', 'R1', 'password', SECRET]);
    // the corrected password is traced masked too (the secret in no trace)
    expect(ofKind(sim.trace(c1).events, 'configChange').map((e) => e.line)).toEqual([`username R1 password ${CONFIG_SECRET_MASK}`]);
    const c2 = sim.trace(0).next;
    sim.runUntil(lastStop + PPP_RETRY_NS + attemptNs);
    const evs2 = sim.trace(c2).events;
    expect(jsonOf(sim.trace(c1).events)).not.toContain(SECRET);
    const up = canonical(wireFrames(sim, evs2));
    expect(up[0]!.txStart).toBe(lastStop + PPP_RETRY_NS);
    const n = 1 + expectedRetries;
    expect(up.map(frameLabel).slice(0, 10)).toEqual([
      `R1 LCP configure-request id ${1 + 2 * n}`, `R2 LCP configure-request id ${1 + 2 * n}`,
      `R1 LCP configure-ack id ${1 + 2 * n}`, `R2 LCP configure-ack id ${1 + 2 * n}`,
      `R1 CHAP challenge id ${1 + n}`, `R2 CHAP challenge id ${1 + n}`,
      `R1 CHAP response id ${1 + n}`, `R2 CHAP response id ${1 + n}`,
      `R1 CHAP success id ${1 + n}`, `R2 CHAP success id ${1 + n}`,
    ]);
    for (const d of ['r1', 'r2']) {
      expect(pppRow(sim, d)).toMatchObject({ phase: 'network', lcp: 'opened', authLocalState: 'success', authPeerState: 'success', ipcp: 'opened', failures: n });
      expect(serial(sim, d).operUp).toBe(true);
      expect(fsmMoves(evs2, d, 'ppp-auth')).toEqual([`${SE0}: failed->pending`, `${SE0}: pending->success`]);
    }
    expect(ping(sim, 'r1', '10.1.1.2').text).toContain('!!!!!');
  });

  it('the same seed gives the same trace and snapshot, failure and retries included', () => {
    const run = (): string => {
      const sim = pppWorld({ r2: { password: 'WRONG' }, settle: false });
      sim.runFor(25 * SEC);
      return jsonOf({ trace: sim.trace(0).events, snapshot: sim.snapshot() });
    };
    const a = run();
    expect(run()).toBe(a);
    expect(run()).toBe(a);
  });
});
