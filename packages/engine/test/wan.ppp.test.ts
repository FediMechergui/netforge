/**
 * wan.ppp [S19] — the PPP daemon on `staged.world` (ARCHITECTURE-P3 D17, §2.6 `PppRow`, §2.7, §3.9, §4.1–§4.3; §7 W3
 * wan): §3.9 step by step (the encapsulation mismatch and the switch, LCP both ways at once, CHAP with real MD5 in both
 * directions, IPCP with the peer route, the ping across, the wrong password with its log, Terminate exchange, Stopped,
 * the periodic retry and the corrected password), the IPv6 ping across the PPP link (§9.2 item 30b: IPv6CP), PAP in
 * the clear and its failure, the per-end line protocol, LCP echoes and `keepalive-missed`, silence and determinism.
 *
 * World (§3.9): R1 Se0/0/0 (DCE, `clock rate 64000`) ↔ R2 Se0/0/0 on a `serial-dce` cable; 10.1.1.0/30; R1 has
 * `username R2 password NetF0rge`, R2 `username R1 password NetF0rge`, both `encapsulation ppp` and `ppp
 * authentication chap` unless a case says otherwise. The ppp daemon is registered through the staged registry overlay
 * (the W4 flip registers it for real).
 */
import { describe, expect, it } from 'vitest';
import { PPP_PROTO } from '../src/contracts/pdu.js';
import type { Action, Process } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { PppRow, RouteRow } from '../src/contracts/tables.js';
import { SEC, serializationNs } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { encodeReversibleSecret, secretTokens } from '../src/cli/secrets.js';
import { chapMd5Response } from '../src/core/md5.js';
import { HDLC_PROCESS } from '../src/protocols/hdlc.js';
import { createPpp, PPP_DEBUG_AUTHENTICATION, PPP_DEBUG_NEGOTIATION, PPP_ECHO_TAG, PPP_PROCESS, PPP_TEXT, pppNoPasswordText } from '../src/protocols/ppp.js';
import { ofKind, ping } from './sim.harness.js';
import { createStagedSimulation } from './staged.world.js';

const SE0 = 'Serial0/0/0';
const MASK30 = '255.255.255.252';
const SECRET = 'NetF0rge';

interface EndOptions {
  /** Interface lines replacing the PPP defaults (`encapsulation ppp`, `ppp authentication chap`). */
  readonly ppp?: readonly string[];
  /** The `username <peer> password <pw>` password (default NetF0rge; null = no username line). */
  readonly password?: string | null;
  /** Extra interface lines (IPv6, keepalive, …). */
  readonly extra?: readonly string[];
  /** Extra global lines. */
  readonly global?: readonly string[];
}

interface WorldOptions {
  readonly r1?: EndOptions;
  readonly r2?: EndOptions;
  readonly seed?: number;
  /** Register the ppp daemon (default true). */
  readonly ppp?: boolean;
  /** Run to idle after building (default true). */
  readonly settle?: boolean;
}

const PPP_CHAP = [' encapsulation ppp', ' ppp authentication chap'];

function startup(name: string, peer: string, address: string, dce: boolean, o: EndOptions = {}): string {
  const lines = [`hostname ${name}`, '!'];
  const pw = o.password === undefined ? SECRET : o.password;
  if (pw !== null) lines.push(`username ${peer} password ${pw}`, '!');
  for (const g of o.global ?? []) lines.push(g, '!');
  lines.push(`interface ${SE0}`, ` ip address ${address} ${MASK30}`, ...(o.ppp ?? PPP_CHAP), ...(dce ? [' clock rate 64000'] : []), ...(o.extra ?? []), ' no shutdown', '!');
  lines.push('end', '');
  return lines.join('\n');
}

/** The §3.9 world (run to idle unless `settle` is false). */
function pppWorld(o: WorldOptions = {}): Simulation {
  const sim = createStagedSimulation({ seed: o.seed ?? 19, stage: 'P3', factories: o.ppp === false ? {} : { ppp: createPpp } });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: startup('R1', 'R2', '10.1.1.1', true, o.r1) });
  sim.addDevice({ id: 'r2', type: 'router.nf2911', name: 'R2', startupConfig: startup('R2', 'R1', '10.1.1.2', false, o.r2) });
  sim.addLink({ a: { device: 'r1', port: SE0 }, b: { device: 'r2', port: SE0 }, media: 'serial-dce' });
  if (o.settle !== false) sim.runToIdle();
  return sim;
}

const row = (sim: Simulation, d: string): PppRow | undefined => sim.device(d)!.tables.get<PppRow>('ppp')?.get(SE0);
const port = (sim: Simulation, d: string) => sim.device(d)!.port(SE0)!;

/** Apply one stored line on `device` at `sim.now` (the device clock synced first, as the facade does). */
function apply(sim: Simulation, device: string, context: string[][], tokens: string[], negate = false): void {
  const d = sim.device(device)!;
  d.applyActions('sim', [], sim.now);
  expect(d.applyConfigLine(context, tokens, negate)).toEqual({ ok: true });
}

/** The PPP control PDUs a device created, as [inner proto, fields] (pduCreated order). */
function created(sim: Simulation, evs: readonly TraceEvent[], device: string): { id: number; t: number; proto: string; fields: Record<string, unknown> }[] {
  const out: { id: number; t: number; proto: string; fields: Record<string, unknown> }[] = [];
  for (const e of ofKind(evs, 'pduCreated')) {
    if (e.device !== device || e.process !== PPP_PROCESS) continue;
    const view = sim.pdu(e.pdu.id)!;
    const inner = view.layers[1]!;
    out.push({ id: e.pdu.id, t: e.t, proto: inner.proto, fields: inner.fields as Record<string, unknown> });
  }
  return out;
}

const codes = (list: readonly { proto: string; fields: Record<string, unknown> }[]): string[] => list.map((p) => `${p.proto}:${String(p.fields.code)}`);

const fsm = (evs: readonly TraceEvent[], device: string, machine: string): string[] =>
  ofKind(evs, 'debug')
    .filter((e) => e.event.device === device && e.event.fsm?.machine === machine)
    .map((e) => `${e.event.fsm!.subject}: ${e.event.fsm!.from}->${e.event.fsm!.to}`);

const asciiOf = (s: string): number[] => Array.from(new TextEncoder().encode(s));
function contains(hay: Uint8Array, needle: readonly number[]): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return true;
  }
  return false;
}

describe('wan.ppp [S19] §3.9 steps 1–2: the mismatch, then the encapsulation switch', () => {
  it('R1 ppp, R2 hdlc: both ends down encapsulation-mismatch, nothing is sent; R2 applies ppp → hdlc disarms, both start LCP', () => {
    const sim = pppWorld({ r2: { ppp: [] } });
    for (const d of ['r1', 'r2']) {
      expect(port(sim, d).operUp).toBe(false);
      expect(port(sim, d).phy).toMatchObject({ carrier: true, lineProtocol: false, lineProtocolReason: 'encapsulation-mismatch' });
    }
    expect(row(sim, 'r1')).toMatchObject({ phase: 'dead', lcp: 'starting', ipcp: 'starting' });
    expect(row(sim, 'r2')).toBeUndefined();
    // R1's ppp sends nothing (line not ready), R2's HDLC keepalives are blocked (no clocked line, D6), for 30 s
    let cursor = sim.trace(0).next;
    sim.runFor(30 * SEC);
    let evs = sim.trace(cursor).events;
    expect(ofKind(evs, 'frameTx')).toEqual([]);
    expect(created(sim, evs, 'r1')).toEqual([]);

    // step 2: R2 applies encapsulation ppp
    cursor = sim.trace(0).next;
    apply(sim, 'r2', [['interface', SE0]], ['encapsulation', 'ppp']);
    expect(port(sim, 'r2').encap).toBe('ppp');
    sim.runToIdle();
    evs = sim.trace(cursor).events;
    const hdlcDebug = ofKind(evs, 'debug').filter((e) => e.event.device === 'r2' && e.event.process === HDLC_PROCESS).map((e) => e.event.message);
    expect(hdlcDebug).toEqual([`keepalives on ${SE0} stopped: the interface left HDLC (encapsulation ppp)`]);
    const hdlcView = sim.device('r2')!.stateSnapshots().find((v) => v.process === HDLC_PROCESS)!;
    expect((hdlcView.state.lines as { port: string }[]).map((l) => l.port)).not.toContain(SE0);
    // R2's daemon adopts the port (the administrative Open: Initial -> Starting); R1's LCP was Starting since boot;
    // serial-line ready reached both daemons: each ran LCP from Starting
    expect(fsm(evs, 'r2', 'ppp-lcp').slice(0, 2)).toEqual([`${SE0}: initial->starting`, `${SE0}: starting->req-sent`]);
    expect(fsm(evs, 'r1', 'ppp-lcp').slice(0, 1)).toEqual([`${SE0}: starting->req-sent`]);
    for (const d of ['r1', 'r2']) {
      expect(row(sim, d)).toMatchObject({ phase: 'network', lcp: 'opened', ipcp: 'opened' });
      expect(port(sim, d).operUp).toBe(true);
    }
  });
});

describe('wan.ppp [S19] §3.9 steps 3–5: LCP, CHAP, IPCP', () => {
  it('LCP both ends at once: ConfReq id 1 {authProto chap-md5, magic}, 23 bytes on the wire (≈ 2.9 ms at 64 kb/s), each ACKs the other → Opened', () => {
    const sim = pppWorld({ settle: false });
    const cursor = sim.trace(0).next;
    sim.runToIdle();
    const evs = sim.trace(cursor).events;
    const r1 = created(sim, evs, 'r1');
    const r2 = created(sim, evs, 'r2');
    const req1 = r1[0]!;
    const req2 = r2[0]!;
    expect(req1.proto).toBe('lcp');
    expect(req1.fields).toMatchObject({ code: 1, id: 1, authProto: 'chap-md5' });
    expect(Object.keys(req1.fields).filter((k) => !['code', 'id', 'length'].includes(k)).sort()).toEqual(['authProto', 'magic']);
    expect(req2.fields).toMatchObject({ code: 1, id: 1, authProto: 'chap-md5' });
    expect(req1.t).toBe(req2.t); // both ends at once
    expect(req1.fields.magic).not.toBe(req2.fields.magic);
    const v = sim.pdu(req1.id)!;
    expect(v.layers.map((l) => l.proto)).toEqual(['ppp', 'lcp']);
    expect(v.layers[0]!.fields).toMatchObject({ address: 0xff, control: 0x03, protocol: PPP_PROTO.lcp });
    expect(v.size).toBe(21);
    const tx = ofKind(evs, 'frameTx').find((e) => e.pdu.id === req1.id)!;
    expect(tx.txEnd - tx.txStart).toBe(serializationNs(23, 64000));
    expect(tx.txEnd - tx.txStart).toBe(2_875_000);
    // each acknowledges the other's request with its options, then opens on the ACK of its own
    expect(r1[1]!.fields).toMatchObject({ code: 2, id: 1, authProto: 'chap-md5', magic: req2.fields.magic });
    expect(r2[1]!.fields).toMatchObject({ code: 2, id: 1, authProto: 'chap-md5', magic: req1.fields.magic });
    for (const d of ['r1', 'r2']) {
      // the administrative Open at boot, then Up (the line is ready) and Open → Req-Sent
      expect(fsm(evs, d, 'ppp-lcp')).toEqual([`${SE0}: initial->starting`, `${SE0}: starting->req-sent`, `${SE0}: req-sent->ack-sent`, `${SE0}: ack-sent->opened`]);
    }
    expect(row(sim, 'r1')).toMatchObject({ magic: req1.fields.magic, peerMagic: req2.fields.magic });
  });

  it('CHAP both directions: 16-byte challenge with the hostname, MD5(id ‖ secret ‖ challenge) response, Success; ppp-link up, operUp, C and L', () => {
    const sim = pppWorld({ settle: false });
    const cursor = sim.trace(0).next;
    sim.runToIdle();
    const evs = sim.trace(cursor).events;
    for (const [me, peer, myName, peerName] of [['r1', 'r2', 'R1', 'R2'], ['r2', 'r1', 'R2', 'R1']] as const) {
      const mine = created(sim, evs, me).filter((p) => p.proto === 'chap');
      const theirs = created(sim, evs, peer).filter((p) => p.proto === 'chap');
      const challenge = mine.find((p) => p.fields.code === 1)!;
      expect(challenge.fields).toMatchObject({ code: 1, id: 1, name: myName });
      expect((challenge.fields.value as Uint8Array).length).toBe(16);
      const response = theirs.find((p) => p.fields.code === 2)!;
      expect(response.fields).toMatchObject({ code: 2, id: 1, name: peerName });
      expect(Array.from(response.fields.value as Uint8Array)).toEqual(Array.from(chapMd5Response(1, SECRET, challenge.fields.value as Uint8Array)));
      expect(mine.find((p) => p.fields.code === 3)!.fields).toMatchObject({ code: 3, id: 1, message: PPP_TEXT.chapSuccess });
    }
    for (const d of ['r1', 'r2']) {
      expect(fsm(evs, d, 'ppp-auth')).toEqual([`${SE0}: pending->success`]);
      expect(port(sim, d).operUp).toBe(true);
      expect(port(sim, d).phy).toMatchObject({ carrier: true, lineProtocol: true });
      const ra = sim.device(d)!.tables.rib;
      expect(ra.get('10.1.1.0/30')).toMatchObject({ source: 'C', iface: SE0 });
    }
    expect(sim.device('r1')!.tables.rib.get('10.1.1.1/32')).toMatchObject({ source: 'L', iface: SE0 });
    // one ppp-link report per end: up
    const linkUp = ofKind(evs, 'linkState').filter((e) => e.up);
    expect(linkUp).toHaveLength(1);
    // the order of §3.9: LCP opened, then authentication, then the line protocol, then IPCP
    const r1Debug = ofKind(evs, 'debug').filter((e) => e.event.device === 'r1' && e.event.process === PPP_PROCESS).map((e) => e.event.message);
    const at = (s: string): number => r1Debug.findIndex((m) => m.includes(s));
    expect(at('LCP: ack-sent -> opened')).toBeLessThan(at('CHAP: sent challenge'));
    expect(at('CHAP: R2 passed')).toBeLessThan(at('line protocol up'));
    expect(at('network phase')).toBeLessThan(at('IPCP: sent configure-request'));
  });

  it('IPCP both ways → opened, peerAddress 10.1.1.2, the peer route C 10.1.1.2/32; a ping crosses as ppp 0x0021, one PduId each way', () => {
    const sim = pppWorld();
    expect(row(sim, 'r1')).toMatchObject({ ipcp: 'opened', peerAddress: '10.1.1.2' });
    expect(row(sim, 'r2')).toMatchObject({ ipcp: 'opened', peerAddress: '10.1.1.1' });
    const peerRoute = sim.device('r1')!.tables.rib.get('10.1.1.2/32') as RouteRow;
    expect(peerRoute).toMatchObject({ network: '10.1.1.2', prefixLen: 32, source: 'C', iface: SE0, ad: 0, owner: PPP_PROCESS });
    const { text, evs } = ping(sim, 'r1', '10.1.1.2');
    expect(text).toContain('!!!!!');
    const echoes = ofKind(evs, 'frameTx').filter((e) => sim.pdu(e.pdu.id)!.layers.some((l) => l.proto === 'icmpv4'));
    expect(echoes.length).toBe(10);
    for (const e of echoes) {
      const v = sim.pdu(e.pdu.id)!;
      expect(v.layers[0]!.proto).toBe('ppp');
      expect(v.layers[0]!.fields.protocol).toBe(PPP_PROTO.ipv4);
    }
    // one PduId each way per echo: every frame on the cable is a distinct PDU created by an icmpv4 daemon
    const ids = new Set(echoes.map((e) => e.pdu.id));
    expect(ids.size).toBe(10);
    // `no peer neighbor-route` withdraws the /32
    apply(sim, 'r1', [['interface', SE0]], ['peer', 'neighbor-route'], true);
    sim.runToIdle();
    expect(sim.device('r1')!.tables.rib.get('10.1.1.2/32')).toBeUndefined();
    expect(sim.device('r1')!.tables.rib.get('10.1.1.0/30')).toMatchObject({ source: 'C' });
  });

  it('the ppp row (exact), the StateView, the transitions of IPCP; the CHAP secret occurs in no PDU byte', () => {
    const sim = pppWorld({ settle: false });
    const cursor = sim.trace(0).next;
    sim.runToIdle();
    const evs = sim.trace(cursor).events;
    expect(row(sim, 'r1')).toEqual({
      key: SE0, port: SE0, phase: 'network', lcp: 'opened', authLocal: 'chap', authLocalState: 'success', authPeer: 'chap',
      authPeerState: 'success', peerName: 'R2', ipcp: 'opened', peerAddress: '10.1.1.2', magic: expect.any(Number),
      peerMagic: expect.any(Number), failures: 0, since: expect.any(Number), updatedAt: expect.any(Number),
    });
    expect(fsm(evs, 'r1', 'ppp-ncp')).toEqual([`${SE0} IPCP: initial->starting`, `${SE0} IPCP: starting->req-sent`, `${SE0} IPCP: req-sent->ack-sent`, `${SE0} IPCP: ack-sent->opened`]);
    const view = sim.device('r1')!.stateSnapshots().find((v) => v.process === PPP_PROCESS)!;
    expect(view.state).toMatchObject({ ports: [{ port: SE0, lineReady: true, phase: 'network', lcp: 'opened', ipcp: 'opened', ipv6cp: 'initial', authLocal: 'chap', authPeer: 'chap' }] });
    // no PDU created anywhere carries the secret
    for (const e of ofKind(evs, 'pduCreated')) expect(contains(sim.pdu(e.pdu.id)!.bytes, asciiOf(SECRET))).toBe(false);
    // the debug categories of §5.8
    const cats = new Set(ofKind(evs, 'debug').filter((e) => e.event.process === PPP_PROCESS).map((e) => e.event.category));
    expect([...cats].sort()).toEqual([PPP_DEBUG_AUTHENTICATION, PPP_DEBUG_NEGOTIATION].sort());
  });

  it('LCP echoes every 10 s in the background, answered; the row is not rewritten by them; runToIdle does not wait for them', () => {
    const sim = pppWorld();
    const cursor = sim.trace(0).next;
    sim.runFor(30 * SEC);
    const evs = sim.trace(cursor).events;
    const echoes = ofKind(evs, 'frameTx').filter((e) => e.pdu.tag === PPP_ECHO_TAG);
    expect(echoes.every((e) => e.background === true)).toBe(true);
    // three requests and three replies per end in 30 s
    expect(echoes).toHaveLength(12);
    expect(ofKind(evs, 'tableWrite').filter((e) => e.table === 'ppp')).toEqual([]);
    expect(sim.runToIdle().stopped).toBeUndefined();
  });
});

describe('wan.ppp [S19] §3.9 step 6: the wrong password', () => {
  it('Failure "the response does not match", a severity-5 log, Terminate-Request/Ack, both LCPs Stopped, both ends ppp-auth-failed', () => {
    const sim = pppWorld({ r2: { password: 'WRONG' }, settle: false });
    const cursor = sim.trace(0).next;
    const stats = sim.runToIdle();
    expect(stats.stopped).toBeUndefined(); // every per-attempt timer is cancelled at Stopped
    const evs = sim.trace(cursor).events;
    const r1 = created(sim, evs, 'r1');
    expect(r1.find((p) => p.proto === 'chap' && p.fields.code === 4)!.fields).toMatchObject({ code: 4, id: 1, message: PPP_TEXT.chapMismatch });
    expect(r1.find((p) => p.proto === 'lcp' && p.fields.code === 5)!.fields).toMatchObject({ code: 5, reason: PPP_TEXT.terminateAuth });
    expect(codes(r1).filter((c) => c === 'lcp:6')).toHaveLength(1); // the Terminate-Ack to R2's request
    const logs = ofKind(evs, 'log').filter((e) => e.device === 'r1' && e.facility === 'PPP');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ severity: 5, message: `${SE0}: CHAP authentication of R2 failed: ${PPP_TEXT.chapMismatch}` });
    for (const d of ['r1', 'r2']) {
      // each end refused the other (one shared secret, both directions) and heard the peer's Failure while terminating
      expect(row(sim, d)).toMatchObject({ lcp: 'stopped', phase: 'dead', authLocalState: 'failed', authPeerState: 'failed', failures: 1 });
      expect(row(sim, d)!.lastFailure).toBe(`CHAP authentication of ${d === 'r1' ? 'R2' : 'R1'} failed: ${PPP_TEXT.chapMismatch}`);
      expect(port(sim, d).operUp).toBe(false);
      expect(port(sim, d).phy).toMatchObject({ carrier: true, lineProtocol: false, lineProtocolReason: 'ppp-auth-failed' });
      expect(fsm(evs, d, 'ppp-auth')).toEqual([`${SE0}: pending->failed`]);
      expect(fsm(evs, d, 'ppp-lcp').slice(-2)).toEqual([`${SE0}: opened->stopping`, `${SE0}: stopping->stopped`]);
    }
    expect(sim.link(sim.device('r1')!.port(SE0)!.link!)!.downReason).toBe('ppp-auth-failed');
    // the connected route went with the line protocol, so the peer has no route at all
    expect(sim.device('r1')!.tables.rib.get('10.1.1.0/30')).toBeUndefined();
    expect(ping(sim, 'r1', '10.1.1.2').text).toBe('No route to 10.1.1.2 from this device.\n');
  });

  it('a ping routed out of the failed link drops link-down (a permanent static through Se0/0/0)', () => {
    const sim = pppWorld({ r2: { password: 'WRONG' }, r1: { global: [`ip route 10.2.2.0 255.255.255.0 ${SE0} permanent`] } });
    expect(port(sim, 'r1').phy?.lineProtocolReason).toBe('ppp-auth-failed');
    const p = ping(sim, 'r1', '10.2.2.2');
    expect(p.text).not.toContain('!');
    const drops = ofKind(p.evs, 'drop').filter((e) => e.device === 'r1');
    expect(drops.length).toBeGreaterThan(0);
    expect(drops.every((e) => e.reason === 'link-down')).toBe(true);
  });

  it('the periodic ppp-retry repeats the cycle every 10 s; correcting the password makes the next retry succeed', () => {
    const sim = pppWorld({ r2: { password: 'WRONG' } });
    let cursor = sim.trace(0).next;
    sim.runFor(11 * SEC);
    let evs = sim.trace(cursor).events;
    const retry = created(sim, evs, 'r1');
    expect(codes(retry).slice(0, 1)).toEqual(['lcp:1']);
    expect(row(sim, 'r1')).toMatchObject({ lcp: 'stopped', failures: 2 });
    expect(port(sim, 'r1').phy?.lineProtocolReason).toBe('ppp-auth-failed');
    // correct R2's password: the next retry succeeds
    apply(sim, 'r2', [], ['username', 'R1', 'password', SECRET]);
    cursor = sim.trace(0).next;
    sim.runFor(10 * SEC);
    evs = sim.trace(cursor).events;
    for (const d of ['r1', 'r2']) {
      expect(row(sim, d)).toMatchObject({ phase: 'network', lcp: 'opened', authLocalState: 'success', authPeerState: 'success', ipcp: 'opened', failures: 2 });
      expect(port(sim, d).operUp).toBe(true);
      expect(fsm(evs, d, 'ppp-auth')).toEqual([`${SE0}: failed->pending`, `${SE0}: pending->success`]);
    }
    expect(ping(sim, 'r1', '10.1.1.2').text).toContain('!!!!!');
  });

  it('an nf7-encoded password (service password-encryption) is the same secret; a one-way secret entry cannot be used', () => {
    const encoded = secretTokens(encodeReversibleSecret(SECRET)).join(' ');
    expect(encoded.startsWith('nf7 ')).toBe(true);
    const ok = pppWorld({ r1: { password: encoded } });
    for (const d of ['r1', 'r2']) expect(row(ok, d)).toMatchObject({ phase: 'network', authLocalState: 'success' });
    // `username R2 secret …` is a hash: CHAP cannot use it (D17), so R1 refuses R2 and cannot answer R2's challenge
    const bad = pppWorld({ r1: { password: null, global: [`username R2 secret ${SECRET}`] }, settle: false });
    const cursor = bad.trace(0).next;
    expect(bad.runToIdle().stopped).toBeUndefined();
    const evs = bad.trace(cursor).events;
    expect(created(bad, evs, 'r1').find((p) => p.proto === 'chap' && p.fields.code === 4)!.fields).toMatchObject({ message: pppNoPasswordText('R2') });
    expect(created(bad, evs, 'r1').filter((p) => p.proto === 'chap' && p.fields.code === 2)).toEqual([]);
    expect(row(bad, 'r1')).toMatchObject({ lcp: 'stopped', authLocalState: 'failed' });
  });

  it('adding ppp authentication to an open link renegotiates at once; the link comes back authenticated', () => {
    const sim = pppWorld({ r1: { ppp: [' encapsulation ppp'] }, r2: { ppp: [' encapsulation ppp'] } });
    expect(row(sim, 'r1')).toMatchObject({ phase: 'network', authLocal: 'none' });
    const cursor = sim.trace(0).next;
    apply(sim, 'r1', [['interface', SE0]], ['ppp', 'authentication', 'chap']);
    sim.runToIdle();
    const evs = sim.trace(cursor).events;
    expect(fsm(evs, 'r1', 'ppp-lcp').slice(0, 2)).toEqual([`${SE0}: opened->starting`, `${SE0}: starting->req-sent`]);
    expect(row(sim, 'r1')).toMatchObject({ phase: 'network', authLocal: 'chap', authLocalState: 'success', authPeer: 'none' });
    expect(row(sim, 'r2')).toMatchObject({ phase: 'network', authLocal: 'none', authPeer: 'chap', authPeerState: 'success' });
    for (const d of ['r1', 'r2']) expect(port(sim, d).operUp).toBe(true);
  });
});

describe('wan.ppp [S19] PAP', () => {
  const pap = (user: string, pw: string): string[] => [' encapsulation ppp', ' ppp authentication pap', ` ppp pap sent-username ${user} password ${pw}`];

  it('PAP both ways: the password travels in the clear (on purpose); Ack; the link comes up', () => {
    const sim = pppWorld({ r1: { ppp: pap('R1', SECRET) }, r2: { ppp: pap('R2', SECRET) }, settle: false });
    const cursor = sim.trace(0).next;
    sim.runToIdle();
    const evs = sim.trace(cursor).events;
    const req = created(sim, evs, 'r1').find((p) => p.proto === 'pap' && p.fields.code === 1)!;
    expect(req.fields).toMatchObject({ code: 1, id: 1, peerId: 'R1', password: SECRET });
    expect(contains(sim.pdu(req.id)!.bytes, asciiOf(SECRET))).toBe(true);
    expect(created(sim, evs, 'r2').find((p) => p.proto === 'pap' && p.fields.code === 2)!.fields).toMatchObject({ code: 2, id: 1, message: PPP_TEXT.papSuccess });
    const lcpReq = created(sim, evs, 'r1').find((p) => p.proto === 'lcp' && p.fields.code === 1)!;
    expect(lcpReq.fields.authProto).toBe('pap');
    for (const d of ['r1', 'r2']) {
      expect(row(sim, d)).toMatchObject({ phase: 'network', authLocal: 'pap', authLocalState: 'success', authPeer: 'pap', authPeerState: 'success' });
      expect(port(sim, d).operUp).toBe(true);
    }
    expect(ping(sim, 'r2', '10.1.1.1').text).toContain('!!!!!');
  });

  it('a wrong PAP password: Nak, the log, the attempt ends; both ends ppp-auth-failed', () => {
    const sim = pppWorld({ r1: { ppp: pap('R1', SECRET) }, r2: { ppp: pap('R2', 'oops') }, settle: false });
    const cursor = sim.trace(0).next;
    expect(sim.runToIdle().stopped).toBeUndefined();
    const evs = sim.trace(cursor).events;
    expect(created(sim, evs, 'r1').find((p) => p.proto === 'pap' && p.fields.code === 3)!.fields).toMatchObject({ code: 3, message: PPP_TEXT.papMismatch });
    expect(ofKind(evs, 'log').filter((e) => e.device === 'r1' && e.facility === 'PPP').map((e) => e.message)).toEqual([`${SE0}: PAP authentication of R2 failed: ${PPP_TEXT.papMismatch}`]);
    expect(row(sim, 'r1')).toMatchObject({ lcp: 'stopped', authLocalState: 'failed' });
    expect(row(sim, 'r2')).toMatchObject({ lcp: 'stopped', authPeerState: 'failed' });
    for (const d of ['r1', 'r2']) expect(port(sim, d).phy?.lineProtocolReason).toBe('ppp-auth-failed');
  });

  it('chap pap: the peer naks nothing (it can answer either), so CHAP is used', () => {
    const sim = pppWorld({ r1: { ppp: [' encapsulation ppp', ' ppp authentication chap pap'] }, r2: { ppp: [' encapsulation ppp'] } });
    expect(row(sim, 'r1')).toMatchObject({ phase: 'network', authLocal: 'chap', authLocalState: 'success', authPeer: 'none' });
    expect(row(sim, 'r2')).toMatchObject({ phase: 'network', authLocal: 'none', authPeer: 'chap', authPeerState: 'success' });
    expect(row(sim, 'r2')!.authLocalState).toBeUndefined();
  });
});

describe('wan.ppp [S19] IPv6 across the PPP link (§9.2 item 30b: IPv6CP)', () => {
  it('IPv6CP opens with the interface identifiers; ping 2001:db8:12::2 crosses as ppp 0x0057', () => {
    const sim = pppWorld({ r1: { extra: [' ipv6 address 2001:db8:12::1/64'] }, r2: { extra: [' ipv6 address 2001:db8:12::2/64'] } });
    expect(row(sim, 'r1')).toMatchObject({ ipcp: 'opened', ipv6cp: 'opened' });
    expect(row(sim, 'r2')).toMatchObject({ ipv6cp: 'opened' });
    const { text, evs } = ping(sim, 'r1', '2001:db8:12::2');
    expect(text).toContain('!!!!!');
    const frames = ofKind(evs, 'frameTx').filter((e) => sim.pdu(e.pdu.id)!.layers.some((l) => l.proto === 'icmpv6' && (l.fields.type === 128 || l.fields.type === 129)));
    expect(frames.length).toBeGreaterThanOrEqual(10);
    for (const e of frames) expect(sim.pdu(e.pdu.id)!.layers[0]!.fields.protocol).toBe(PPP_PROTO.ipv6);
  });

  it('IPv6 on one end only: the other end rejects IPv6CP with a Protocol-Reject; IPv6CP stops; IPv4 is unaffected', () => {
    const sim = pppWorld({ r1: { extra: [' ipv6 address 2001:db8:12::1/64'] }, settle: false });
    const cursor = sim.trace(0).next;
    sim.runToIdle();
    const evs = sim.trace(cursor).events;
    const rej = created(sim, evs, 'r2').find((p) => p.proto === 'lcp' && p.fields.code === 8)!;
    expect(rej.fields).toMatchObject({ code: 8, rejected: '0x8057' });
    expect(row(sim, 'r1')).toMatchObject({ ipcp: 'opened', ipv6cp: 'stopped' });
    expect(row(sim, 'r2')!.ipv6cp).toBeUndefined();
    expect(ping(sim, 'r1', '10.1.1.2').text).toContain('!!!!!');
  });
});

describe('wan.ppp [S19] the per-end line protocol', () => {
  it('one-way CHAP: the authenticator reaches the Network phase first; its end is up while the peer end still negotiates', () => {
    const sim = pppWorld({ r2: { ppp: [' encapsulation ppp'] }, settle: false });
    const ups: { t: number; device: string }[] = [];
    const off = sim.onTrace((e) => {
      if (e.kind === 'portState' && e.port === SE0 && e.operUp) ups.push({ t: e.t, device: e.device });
    });
    let r2AtR1Up: boolean | undefined;
    const off2 = sim.onTrace((e) => {
      if (e.kind === 'portState' && e.device === 'r1' && e.port === SE0 && e.operUp) r2AtR1Up = port(sim, 'r2').operUp;
    });
    sim.runToIdle();
    off();
    off2();
    expect(ups.map((u) => u.device)).toEqual(['r1', 'r2']);
    expect(ups[1]!.t).toBeGreaterThan(ups[0]!.t);
    expect(r2AtR1Up).toBe(false);
    expect(row(sim, 'r1')).toMatchObject({ authLocal: 'chap', authLocalState: 'success', authPeer: 'none' });
    expect(row(sim, 'r2')).toMatchObject({ authLocal: 'none', authPeer: 'chap', authPeerState: 'success' });
  });

  it('no authentication: LCP then straight to the Network phase; no authentication states', () => {
    const sim = pppWorld({ r1: { ppp: [' encapsulation ppp'] }, r2: { ppp: [' encapsulation ppp'] } });
    for (const d of ['r1', 'r2']) {
      const r = row(sim, d)!;
      expect(r).toMatchObject({ phase: 'network', authLocal: 'none', authPeer: 'none', ipcp: 'opened' });
      expect(r.authLocalState).toBeUndefined();
      expect(r.authPeerState).toBeUndefined();
    }
  });

  it('the line goes away (shutdown) and comes back: both ends Dead, then a fresh negotiation', () => {
    const sim = pppWorld();
    apply(sim, 'r2', [['interface', SE0]], ['shutdown']);
    sim.runToIdle();
    expect(row(sim, 'r1')).toMatchObject({ phase: 'dead', lcp: 'starting', ipcp: 'starting' });
    expect(row(sim, 'r1')!.peerAddress).toBeUndefined();
    expect(sim.device('r1')!.tables.rib.get('10.1.1.2/32')).toBeUndefined();
    expect(port(sim, 'r1').operUp).toBe(false);
    apply(sim, 'r2', [['interface', SE0]], ['shutdown'], true);
    sim.runToIdle();
    for (const d of ['r1', 'r2']) expect(row(sim, d)).toMatchObject({ phase: 'network', lcp: 'opened', ipcp: 'opened' });
  });

  it('LCP echoes unanswered (a cable losing every frame): keepalive-missed after three; the next retry after the loss ends succeeds', () => {
    const sim = pppWorld();
    const link = sim.device('r1')!.port(SE0)!.link!;
    sim.setImpairments(link, { lossPct: 100 });
    sim.runFor(41 * SEC);
    for (const d of ['r1', 'r2']) {
      expect(port(sim, d).operUp).toBe(false);
      expect(port(sim, d).phy?.lineProtocolReason).toBe('keepalive-missed');
      expect(row(sim, d)).toMatchObject({ failures: 1, lastFailure: '3 LCP echo requests went unanswered' });
    }
    sim.setImpairments(link, { lossPct: 0 });
    sim.runFor(40 * SEC);
    for (const d of ['r1', 'r2']) {
      expect(row(sim, d)).toMatchObject({ phase: 'network', lcp: 'opened' });
      expect(port(sim, d).operUp).toBe(true);
    }
  });

  it('removing PPP (encapsulation hdlc on both ends): the rows go, no PPP timer is left, HDLC keepalives come back', () => {
    const sim = pppWorld();
    apply(sim, 'r1', [['interface', SE0]], ['encapsulation', 'hdlc']);
    apply(sim, 'r2', [['interface', SE0]], ['encapsulation', 'hdlc']);
    sim.runToIdle();
    expect(row(sim, 'r1')).toBeUndefined();
    expect(row(sim, 'r2')).toBeUndefined();
    expect(sim.device('r1')!.tables.rib.get('10.1.1.2/32')).toBeUndefined();
    const cursor = sim.trace(0).next;
    sim.runFor(20 * SEC);
    const evs = sim.trace(cursor).events;
    expect(created(sim, evs, 'r1')).toEqual([]);
    expect(ofKind(evs, 'frameTx').filter((e) => e.pdu.tag === 'keepalive').length).toBeGreaterThan(0);
    for (const d of ['r1', 'r2']) expect(port(sim, d).operUp).toBe(true);
  });
});

describe('wan.ppp [S19] silence and determinism', () => {
  it('a router without a ppp port: the daemon sends nothing, arms nothing, writes no row', () => {
    const sim = pppWorld({ r1: { ppp: [] }, r2: { ppp: [] } });
    sim.runFor(30 * SEC);
    const evs = sim.trace(0).events;
    expect(ofKind(evs, 'pduCreated').filter((e) => e.process === PPP_PROCESS)).toEqual([]);
    expect(ofKind(evs, 'tableWrite').filter((e) => e.table === 'ppp')).toEqual([]);
    expect(ofKind(evs, 'debug').filter((e) => e.event.process === PPP_PROCESS)).toEqual([]);
    const view = sim.device('r1')!.stateSnapshots().find((v) => v.process === PPP_PROCESS)!;
    expect(view.state).toEqual({ ports: [], sent: 0, received: 0 });
    expect(port(sim, 'r1').operUp).toBe(true);
  });

  it('the same seed gives the same trace, failure and retry included', () => {
    const run = (): string => {
      const sim = pppWorld({ r2: { password: 'WRONG' }, settle: false });
      sim.runFor(25 * SEC);
      return JSON.stringify(sim.trace(0).events, (_k, v: unknown) => (v instanceof Uint8Array ? Array.from(v) : v));
    };
    expect(run()).toBe(run());
  });
});

// ── W3 fix step (verified finding 0): a lost CHAP Success no longer leaves a line in the Authenticate phase ──────────

/** The ppp daemon with the first CHAP Success it sends suppressed (as if the line lost it). */
function pppLosingFirstSuccess(): Process {
  const inner = createPpp();
  let lost = false;
  const keep = (actions: Action[]): Action[] =>
    actions.filter((a) => {
      if (lost || a.type !== 'send') return true;
      const l = a.pdu.layers[1];
      if (l?.proto === 'chap' && l.fields.code === 3) {
        lost = true;
        return false;
      }
      return true;
    });
  return {
    ...inner,
    init: (ctx) => keep(inner.init?.(ctx) ?? []),
    onPdu: (ctx, pdu, p) => keep(inner.onPdu(ctx, pdu, p)),
    onTimer: (ctx, key) => keep(inner.onTimer(ctx, key)),
    onConfig: (ctx, delta) => keep(inner.onConfig(ctx, delta)),
    onMediumEvent: (ctx, p, ev) => keep(inner.onMediumEvent!(ctx, p, ev)),
  };
}

describe('wan.ppp: CHAP recovers a lost Success (RFC 1994 §4.2; W3 fix step)', () => {
  it('the peer resends its Response after 2 s, the authenticator answers Success again, and both ends reach Network', () => {
    const sim = createStagedSimulation({ seed: 19, stage: 'P3', factories: { ppp: pppLosingFirstSuccess } });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: startup('R1', 'R2', '10.1.1.1', true) });
    sim.addDevice({ id: 'r2', type: 'router.nf2911', name: 'R2', startupConfig: startup('R2', 'R1', '10.1.1.2', false) });
    sim.addLink({ a: { device: 'r1', port: SE0 }, b: { device: 'r2', port: SE0 }, media: 'serial-dce' });
    const s1 = sim.cli.open('r1', 'console');
    sim.cli.exec(s1, 'enable');
    sim.cli.exec(s1, 'debug ppp authentication');
    const s2 = sim.cli.open('r2', 'console');
    sim.cli.exec(s2, 'enable');
    sim.cli.exec(s2, 'debug ppp authentication');
    sim.runToIdle();
    for (const d of ['r1', 'r2']) {
      expect(row(sim, d)).toMatchObject({ phase: 'network', lcp: 'opened', ipcp: 'opened', authLocalState: 'success', authPeerState: 'success', failures: 0 });
      expect(port(sim, d).operUp).toBe(true);
    }
    const lines = ofKind(sim.trace(0).events, 'debug').filter((e) => e.event.category === PPP_DEBUG_AUTHENTICATION).map((e) => `${e.event.device}: ${e.event.message}`);
    // each end lost its first Success: its peer resent the same Response, and it answered with Success again
    expect(lines).toContain(`r1: ${SE0} CHAP: no verdict yet; sent the response id 1 again`);
    expect(lines).toContain(`r2: ${SE0} CHAP: no verdict yet; sent the response id 1 again`);
    expect(lines).toContain(`r1: ${SE0} CHAP: R2 repeated response id 1; sent success again`);
    expect(lines).toContain(`r2: ${SE0} CHAP: R1 repeated response id 1; sent success again`);
    // and the line carries a ping
    expect(ping(sim, 'r1', '10.1.1.2').text).toContain('!!!!!');
  });

  it('loss during the negotiation, then a clean line: both ends reach Network (the seeds that stuck before the fix)', () => {
    for (const seed of [8, 18, 42]) {
      const sim = pppWorld({ seed, settle: false });
      const link = port(sim, 'r1').link!;
      sim.runUntil(44 * SEC);
      sim.setImpairments(link, { lossPct: 25 });
      sim.runUntil(50 * SEC);
      sim.setImpairments(link, { lossPct: 0 });
      sim.runFor(600 * SEC);
      for (const d of ['r1', 'r2']) {
        expect(row(sim, d), `seed ${seed} ${d}`).toMatchObject({ phase: 'network', lcp: 'opened', authLocalState: 'success', authPeerState: 'success' });
        expect(port(sim, d).operUp, `seed ${seed} ${d}`).toBe(true);
      }
    }
  });

  it('the peer gives up after 10 unanswered Responses, as the PAP peer does (authentication failed, end of the attempt)', () => {
    // R2 never answers R1's Responses: its ppp daemon drops every CHAP Response it receives
    const deaf = (): Process => {
      const inner = createPpp();
      return {
        ...inner,
        onPdu: (ctx, pdu, p) => {
          const l = pdu.layers[1];
          return l?.proto === 'chap' && l.fields.code === 2 ? [{ type: 'consume', pdu }] : inner.onPdu(ctx, pdu, p);
        },
      };
    };
    const sim = createStagedSimulation({ seed: 23, stage: 'P3', factories: { ppp: deaf } });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: startup('R1', 'R2', '10.1.1.1', true) });
    sim.addDevice({ id: 'r2', type: 'router.nf2911', name: 'R2', startupConfig: startup('R2', 'R1', '10.1.1.2', false) });
    sim.addLink({ a: { device: 'r1', port: SE0 }, b: { device: 'r2', port: SE0 }, media: 'serial-dce' });
    sim.runFor(120 * SEC);
    // R2 never accepts R1, so neither end reaches Network; every attempt ends (no timer is left pending forever)
    for (const d of ['r1', 'r2']) {
      expect(row(sim, d)?.phase).not.toBe('network');
      expect(port(sim, d).operUp).toBe(false);
      expect(row(sim, d)!.failures).toBeGreaterThan(0);
    }
  });
});
