/**
 * accept.p3.ipsec-failure [C13] — ARCHITECTURE-P3 §10.1 row `accept.p3.ipsec-failure.test.ts` (W4 qa; on
 * `staged.world` at stage P3, rule 14 step 1; the flip is a later, separate change): §3.13 step 10 and the failure modes
 * of D27 and §4.2.
 *
 *   - a wrong key gives `AUTHENTICATION_FAILED`, `ike-failed` rows, the logs, Tunnel0 down and the ping falling back to
 *     the default route;
 *   - the periodic retry count under `runFor(60 s)` (from `IKE_RETRY_NS`); the corrected key comes up on the next retry;
 *   - an unknown peer gives `NO_PROPOSAL_CHOSEN`;
 *   - a silent peer gives three retransmissions (1, 2, 4 s: `IKE_REXMT_DELAYS_NS`) then `ike-no-response`;
 *   - a peer reload with the old SPI in flight drops `ipsec-no-sa` until the new SA;
 *   - `tunnel protection` on a GRE-mode tunnel refused;
 *   - `runToIdle` returns in every case.
 *
 * The world (test/tunnel.world.ts) carries the registry of the W4 flip, so it is the same world after the flip.
 * Counts and times that follow from constants are computed from them, never typed (§10).
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES } from '../src/contracts/cli.js';
import { ETHERTYPE_IPV4, IPPROTO_ICMP, IPPROTO_UDP, type LayerSpec } from '../src/contracts/pdu.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { SocketRow } from '../src/contracts/tables.js';
import { MS, SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { ipsecNoSaDetail } from '../src/protocols/gre.js';
import { IKE_AUTH_FAILURE_SEVERITY, IKE_LOG_FACILITY, IKE_SOCKET, ikeAuthFailureMessage } from '../src/protocols/ike.js';
import {
  IKE_AUTH,
  IKE_FLAG_INITIATOR,
  IKE_FLAG_RESPONSE,
  IKE_NO_RESPONSE_WAIT_NS,
  IKE_NOTIFY_AUTHENTICATION_FAILED,
  IKE_NOTIFY_NO_PROPOSAL_CHOSEN,
  IKE_RETRY_NS,
  IKE_REXMT_DELAYS_NS,
  IKE_SA_INIT,
  IKE_SPI_ZERO,
} from '../src/protocols/ike/exchange.js';
import { ikeSpiOf } from '../src/protocols/ike/proof.js';
import { injectFrames } from './inject.js';
import { ping } from './sim.harness.js';
import {
  GI1,
  INJ_PORT,
  KEYRING_PEER_CTX,
  LAB_KEY,
  PC1_ADDR,
  PC2_ADDR,
  R1_WAN,
  R2_WAN,
  SE0,
  TU0,
  WRONG_KEY,
  applyLine,
  containsAscii,
  jsonOf,
  saRow,
  tunnelRow,
  tunnelUp,
  tunnelWorld,
  type Created,
  type Drop,
  type FrameTx,
  type Mut,
} from './tunnel.world.js';

/** RFC 7296 payload type of a Notify payload (the first payload of a refusal). */
const PAYLOAD_NOTIFY = 41;
const IKE_VERSION_2 = 0x20;

interface IkeSent {
  readonly t: number;
  readonly id: number;
  readonly device: string;
  readonly ike: Record<string, unknown>;
}

/** Every IKEv2 message the ike daemons created in `evs`, in creation order. */
function ikeSent(sim: Simulation, evs: readonly TraceEvent[]): IkeSent[] {
  return evs
    .filter((e): e is Created => e.kind === 'pduCreated' && e.process === 'ike')
    .map((e) => ({ t: e.t, id: e.pdu.id, device: e.device, ike: { ...sim.pdu(e.pdu.id)!.layer('ikev2')!.fields } }));
}

const isRequest = (m: IkeSent, exchange: number): boolean => m.ike.exchange === exchange && m.ike.flags === IKE_FLAG_INITIATOR;

/** [device, from, to, cause] of every `ike` FSM transition in `evs`, with its time. */
const ikeTransitions = (evs: readonly TraceEvent[]): { t: number; device: string; from: string; to: string; cause: string }[] =>
  evs.flatMap((e) => (e.kind === 'debug' && e.event.fsm?.machine === 'ike' ? [{ t: e.t, device: e.event.device, from: e.event.fsm.from, to: e.event.fsm.to, cause: e.event.fsm.cause ?? '' }] : []));

const idle = (sim: Simulation): void => {
  expect(sim.runToIdle().stopped).toBeUndefined();
};

describe('accept.p3.ipsec-failure [C13]: a wrong key (§3.13 step 10)', () => {
  it('AUTHENTICATION_FAILED; ike-failed rows and a severity-4 log on both ends; Tunnel0 down ike-failed; the ping falls back to the default route and the ISP answers unreachable', () => {
    const sim = tunnelWorld({ mode: 'ipsec', r2Key: WRONG_KEY });
    const evs = sim.trace(0).events;
    const sent = ikeSent(sim, evs);
    // the exchange runs to IKE_AUTH; R2's expected proof differs, so it answers with the notify alone
    const auth = sent.find((m) => m.device === 'r1' && isRequest(m, IKE_AUTH))!;
    const refusal = sent.find((m) => m.device === 'r2' && m.ike.exchange === IKE_AUTH)!;
    expect(refusal.ike).toEqual({
      spiI: auth.ike.spiI, spiR: auth.ike.spiR, nextPayload: PAYLOAD_NOTIFY, version: IKE_VERSION_2, exchange: IKE_AUTH, flags: IKE_FLAG_RESPONSE, messageId: 1,
      length: refusal.ike.length, notify: IKE_NOTIFY_AUTHENTICATION_FAILED,
    });
    expect(sim.pdu(refusal.id)!.meta).toMatchObject({ protected: true, protectedBy: 'ike', triggeredBy: auth.id });
    expect(sent.filter((m) => m.ike.exchange === IKE_AUTH).map((m) => m.device)).toEqual(['r1', 'r2']);
    // both ends fail: rows, transitions, logs, the tunnel down ike-failed
    expect(saRow(sim, 'r1')).toEqual({ key: TU0, port: TU0, local: R1_WAN, peer: R2_WAN, profile: 'VPN', role: 'initiator', state: 'failed', reason: 'ike-failed', since: expect.any(Number), updatedAt: expect.any(Number) });
    expect(saRow(sim, 'r2')).toEqual({ key: TU0, port: TU0, local: R2_WAN, peer: R1_WAN, profile: 'VPN', role: 'responder', state: 'failed', reason: 'ike-failed', since: refusal.t, updatedAt: expect.any(Number) });
    expect(ikeTransitions(evs).filter((x) => x.to === 'failed').map((x) => [x.device, x.from, x.cause])).toEqual([
      ['r2', 'init-answered', 'the initiator proof does not match the pre-shared key'],
      ['r1', 'auth-sent', 'the responder refused the proof'],
    ]);
    for (const [d, peer] of [['r1', R2_WAN], ['r2', R1_WAN]] as const) {
      expect(evs.filter((e) => e.kind === 'log' && e.device === d && e.facility === IKE_LOG_FACILITY).map((e) => [(e as { severity: number }).severity, (e as { message: string }).message])).toEqual([
        [IKE_AUTH_FAILURE_SEVERITY, ikeAuthFailureMessage(TU0, peer)],
      ]);
      expect(tunnelRow(sim, d)).toMatchObject({ mode: 'ipsec', state: 'down', reason: 'ike-failed' });
      expect(tunnelUp(sim, d)).toBe(false);
      expect(evs.some((e) => e.kind === 'portState' && e.device === d && e.port === TU0 && e.operUp)).toBe(false);
    }
    expect(IKE_AUTH_FAILURE_SEVERITY).toBe(4);
    // the static through the down tunnel is unusable, so PC1's ping follows R1's default route, in clear, to the ISP,
    // which has no private route and answers destination unreachable
    expect(sim.device('r1')!.tables.rib.get('192.168.2.0/24')).toBeUndefined();
    const r = ping(sim, 'pc1', PC2_ADDR);
    expect(r.text).not.toContain('!');
    const requests = r.evs.filter((e): e is Created => e.kind === 'pduCreated' && e.device === 'pc1' && e.pdu.summary.startsWith('ICMP echo request'));
    expect(requests).toHaveLength(5);
    for (const req of requests) {
      const muts = sim.pdu(req.pdu.id)!.provenance as readonly Mut[];
      expect(muts.find((m) => m.device === 'r1' && m.reason === 'TtlDecrement')!.cause).toBe('ip route 0.0.0.0 0.0.0.0 209.165.200.226');
      expect(muts.some((m) => m.reason === 'Encrypt' || m.field === 'esp' || m.field === 'gre')).toBe(false);
      const legs = r.evs.filter((e): e is FrameTx => e.kind === 'frameTx' && e.pdu.id === req.pdu.id);
      expect(legs.map((l) => [l.from.device, l.to.device, l.pdu.tunnel ?? null])).toEqual([
        ['pc1', 'r1', null],
        ['r1', 'isp', null],
      ]);
      const drop = r.evs.find((e): e is Drop => e.kind === 'drop' && e.pdu.id === req.pdu.id)!;
      expect([drop.device, drop.reason]).toEqual(['isp', 'no-route']);
      const unreach = r.evs.find((e): e is Created => e.kind === 'pduCreated' && e.device === 'isp' && e.process === 'icmpv4' && sim.pdu(e.pdu.id)!.meta.triggeredBy === req.pdu.id)!;
      expect(sim.pdu(unreach.pdu.id)!.layer('icmpv4')!.fields).toMatchObject({ type: 3 });
      expect(sim.pdu(unreach.pdu.id)!.layer('ipv4')!.fields).toMatchObject({ src: '209.165.200.226', dst: PC1_ADDR });
    }
    // the key occurs in no PDU byte and in no trace event
    for (const e of sim.trace(0).events) {
      if (e.kind === 'pduCreated') expect(containsAscii(sim.pdu(e.pdu.id)!.bytes, LAB_KEY) || containsAscii(sim.pdu(e.pdu.id)!.bytes, WRONG_KEY)).toBe(false);
    }
    expect(sim.trace(0).events.filter((e) => jsonOf(e).includes(LAB_KEY) || jsonOf(e).includes(WRONG_KEY))).toEqual([]);
    idle(sim);
  });

  it('the periodic retry repeats the exchange every IKE_RETRY_NS under runFor(60 s) without holding runToIdle; the corrected key comes up on the next retry', () => {
    const sim = tunnelWorld({ mode: 'ipsec', r2Key: WRONG_KEY });
    const W = 60 * SEC;
    const start = sim.now;
    const firstFailures = ikeTransitions(sim.trace(0).events).filter((x) => x.to === 'failed');
    expect(firstFailures.map((x) => x.device)).toEqual(['r2', 'r1']);
    expect(firstFailures[1]!.t).toBe(start);
    const cursor = sim.trace(0).next;
    sim.runFor(W);
    const evs = sim.trace(cursor).events;
    const sent = ikeSent(sim, evs);
    const tr = ikeTransitions(evs);
    // each failure arms the periodic retry: every exchange of R1 (the lower address, whose exchange always continues)
    // starts exactly IKE_RETRY_NS after its previous failure, and fails again at IKE_AUTH
    const r1Failures = [firstFailures[1]!.t, ...tr.filter((x) => x.device === 'r1' && x.to === 'failed').map((x) => x.t)];
    const r1Retries = sent.filter((m) => m.device === 'r1' && isRequest(m, IKE_SA_INIT)).map((m) => m.t);
    expect(r1Retries.length).toBeGreaterThan(0);
    r1Retries.forEach((t, k) => expect(t - r1Failures[k]!).toBe(IKE_RETRY_NS));
    // the retry count follows from the constant: a cycle lasts IKE_RETRY_NS plus the exchange (Δ), so W holds the k
    // retries with k·IKE_RETRY_NS + (k − 1)·Δ ≤ W; and the retry after the last failure falls outside the window
    const delta = Math.max(...r1Retries.map((t, k) => r1Failures[k + 1]! - t));
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThan(10 * MS);
    expect(r1Retries.length).toBe(Math.floor((W + delta) / (IKE_RETRY_NS + delta)));
    expect(r1Failures.at(-1)! + IKE_RETRY_NS).toBeGreaterThan(start + W);
    // every retry is refused the same way: R2 answers each of R1's exchanges with AUTHENTICATION_FAILED
    expect(sent.filter((m) => m.ike.notify === IKE_NOTIFY_AUTHENTICATION_FAILED).map((m) => m.device)).toEqual(r1Retries.map(() => 'r2'));
    expect(tr.filter((x) => x.to === 'auth-sent').map((x) => x.device)).toEqual(r1Retries.map(() => 'r1'));
    // each cycle is a fresh exchange (a new SPI from the per-process counter)
    const spis = sent.filter((m) => m.device === 'r1' && isRequest(m, IKE_SA_INIT)).map((m) => m.ike.spiI);
    expect(new Set(spis).size).toBe(spis.length);
    expect(spis).toEqual(spis.map((_, k) => ikeSpiOf('r1', TU0, k + 1, 'I')));
    expect([saRow(sim, 'r1')!.state, saRow(sim, 'r2')!.state]).toEqual(['failed', 'failed']);
    idle(sim);
    // the corrected key: nothing happens before the next periodic retry, which succeeds
    const fixedAt = sim.now;
    applyLine(sim, 'r2', KEYRING_PEER_CTX('R1'), ['pre-shared-key', LAB_KEY]);
    idle(sim);
    expect(saRow(sim, 'r2')!.state).toBe('failed');
    // R2 failed first in the last cycle (when it refused), so its retry fires first; R1's follows and keeps its own
    // exchange (the crossing rule), which now succeeds
    const nextRetryR1 = r1Failures.at(-1)! + IKE_RETRY_NS;
    const r2Failures = [firstFailures[0]!.t, ...tr.filter((x) => x.device === 'r2' && x.to === 'failed').map((x) => x.t)];
    const nextRetryR2 = r2Failures.at(-1)! + IKE_RETRY_NS;
    expect(nextRetryR2).toBeLessThan(nextRetryR1);
    expect(nextRetryR2).toBeGreaterThan(fixedAt);
    sim.runUntil(nextRetryR2 - 1);
    expect([saRow(sim, 'r1')!.state, saRow(sim, 'r2')!.state]).toEqual(['failed', 'failed']);
    const c2 = sim.trace(0).next;
    sim.runUntil(nextRetryR1 + 10 * MS);
    const after = ikeSent(sim, sim.trace(c2).events);
    expect(after.filter((m) => isRequest(m, IKE_SA_INIT)).map((m) => [m.device, m.t])).toEqual([['r2', nextRetryR2], ['r1', nextRetryR1]]);
    expect(after.filter((m) => m.ike.notify !== undefined)).toEqual([]);
    expect([saRow(sim, 'r1')!.state, saRow(sim, 'r2')!.state]).toEqual(['established', 'established']);
    expect([tunnelUp(sim, 'r1'), tunnelUp(sim, 'r2')]).toEqual([true, true]);
    expect([tunnelRow(sim, 'r1')!.state, tunnelRow(sim, 'r2')!.state]).toEqual(['up', 'up']);
    idle(sim);
    expect(ping(sim, 'pc1', PC2_ADDR).text).toContain('Sent 5, received 5, lost 0 (0% loss)');
    // the keys (both) in no PDU byte, row or view
    for (const e of sim.trace(0).events) {
      if (e.kind === 'pduCreated') expect(containsAscii(sim.pdu(e.pdu.id)!.bytes, LAB_KEY) || containsAscii(sim.pdu(e.pdu.id)!.bytes, WRONG_KEY)).toBe(false);
    }
    for (const d of ['r1', 'isp', 'r2']) {
      const dev = sim.device(d)!;
      const text = jsonOf([dev.tables.names().map((n) => dev.tables.get(n)?.rows()), dev.stateSnapshots()]);
      expect(text.includes(LAB_KEY) || text.includes(WRONG_KEY)).toBe(false);
    }
  });
});

describe('accept.p3.ipsec-failure [C13]: an unknown peer and a silent peer (D27, §4.2)', () => {
  it('an unknown peer: R2 has no keyring peer for R1, sends nothing of its own and refuses R1 with NO_PROPOSAL_CHOSEN; both ends ike-no-proposal', () => {
    const sim = tunnelWorld({ mode: 'ipsec', r2KeyringPeer: '209.165.200.99' });
    const evs = sim.trace(0).events;
    const sent = ikeSent(sim, evs);
    expect(sent.map((m) => [m.device, m.ike.exchange, m.ike.flags])).toEqual([
      ['r1', IKE_SA_INIT, IKE_FLAG_INITIATOR],
      ['r2', IKE_SA_INIT, IKE_FLAG_RESPONSE],
    ]);
    expect(sent[1]!.ike).toEqual({
      spiI: sent[0]!.ike.spiI, spiR: IKE_SPI_ZERO, nextPayload: PAYLOAD_NOTIFY, version: IKE_VERSION_2, exchange: IKE_SA_INIT, flags: IKE_FLAG_RESPONSE, messageId: 0,
      length: sent[1]!.ike.length, notify: IKE_NOTIFY_NO_PROPOSAL_CHOSEN,
    });
    expect(saRow(sim, 'r1')).toMatchObject({ role: 'initiator', state: 'failed', reason: 'ike-no-proposal' });
    expect(saRow(sim, 'r2')).toMatchObject({ state: 'failed', reason: 'ike-no-proposal' });
    for (const d of ['r1', 'r2']) {
      expect(tunnelRow(sim, d)).toMatchObject({ mode: 'ipsec', state: 'down', reason: 'ike-no-proposal' });
      expect(tunnelUp(sim, d)).toBe(false);
    }
    // no authentication was attempted, and no log (the authentication-failure log is for a wrong key)
    expect(sent.some((m) => m.ike.exchange === IKE_AUTH)).toBe(false);
    expect(evs.filter((e) => e.kind === 'log' && e.facility === IKE_LOG_FACILITY)).toEqual([]);
    idle(sim);
  });

  it('a silent peer: the request and three retransmissions at 1, 2 and 4 s, then ike-no-response after the final wait; the periodic retry starts a fresh exchange', () => {
    const sim = tunnelWorld({ mode: 'ipsec', r2Silent: true });
    const evs = sim.trace(0).events;
    const sent = ikeSent(sim, evs);
    expect(sent.map((m) => [m.device, m.ike.exchange, m.ike.flags])).toEqual(Array.from({ length: 1 + IKE_REXMT_DELAYS_NS.length }, () => ['r1', IKE_SA_INIT, IKE_FLAG_INITIATOR]));
    // the same request each time (one SPI), at the cumulative delays
    expect(new Set(sent.map((m) => m.ike.spiI)).size).toBe(1);
    const t0 = sent[0]!.t;
    const offsets = IKE_REXMT_DELAYS_NS.reduce<number[]>((acc, d) => [...acc, acc.at(-1)! + d], [0]);
    expect(sent.map((m) => m.t - t0)).toEqual(offsets);
    expect(IKE_REXMT_DELAYS_NS).toEqual([1 * SEC, 2 * SEC, 4 * SEC]);
    const failed = ikeTransitions(evs).find((x) => x.to === 'failed')!;
    expect([failed.device, failed.from, failed.cause]).toEqual(['r1', 'init-sent', 'no response from the peer']);
    expect(failed.t - t0).toBe(offsets.at(-1)! + IKE_NO_RESPONSE_WAIT_NS);
    expect(saRow(sim, 'r1')).toMatchObject({ role: 'initiator', state: 'failed', reason: 'ike-no-response' });
    expect(tunnelRow(sim, 'r1')).toMatchObject({ state: 'down', reason: 'ike-no-response' });
    expect(tunnelUp(sim, 'r1')).toBe(false);
    // runToIdle returned at the failure: the periodic retry does not hold it
    expect(sim.now).toBe(failed.t);
    const cursor = sim.trace(0).next;
    sim.runFor(IKE_RETRY_NS + IKE_REXMT_DELAYS_NS[0]!);
    const retry = ikeSent(sim, sim.trace(cursor).events);
    expect(retry.map((m) => m.t - failed.t)).toEqual([IKE_RETRY_NS, IKE_RETRY_NS + IKE_REXMT_DELAYS_NS[0]!]);
    expect(retry[0]!.ike.spiI).toBe(retry[1]!.ike.spiI);
    expect(retry[0]!.ike.spiI).not.toBe(sent[0]!.ike.spiI);
    // the peer has no IKE socket: nothing of ike runs there
    expect(sim.device('r2')!.tables.get<SocketRow>('sockets')?.rows().find((r) => r.id === IKE_SOCKET)).toBeUndefined();
    idle(sim);
  });
});

describe('accept.p3.ipsec-failure [C13]: a peer reload (D27)', () => {
  it('R2 reloads while R1 keeps its SA: ESP on the old SPI in flight drops ipsec-no-sa at R2 until the new SA; R2\'s new exchange replaces R1\'s SA; then the traffic crosses again', () => {
    const sim = tunnelWorld({ mode: 'ipsec' });
    const old1 = saRow(sim, 'r1')!;
    const old2 = saRow(sim, 'r2')!;
    const bootNs = sim.device('r2')!.model.bootNs;
    const cursor = sim.trace(0).next;
    const t0 = sim.now;
    sim.setPower('r2', false);
    sim.setPower('r2', true);
    // R1 keeps sending through its SA (no dead-peer detection): echo requests from PC1's address every millisecond,
    // from 10 ms before R2's boot ends to 30 ms after it
    const r1Mac = sim.device('r1')!.port(GI1)!.mac;
    const injMac = sim.device('inj')!.port(INJ_PORT)!.mac;
    const echo = (seq: number): LayerSpec[] => [
      { proto: 'ethernet', fields: { dst: r1Mac, src: injMac, type: ETHERTYPE_IPV4 } },
      { proto: 'ipv4', fields: { src: PC1_ADDR, dst: PC2_ADDR, protocol: IPPROTO_ICMP, ttl: 64 } },
      { proto: 'icmpv4', fields: { type: 8, code: 0, id: 77, seq } },
    ];
    const count = 40;
    injectFrames(sim, { from: 'inj', port: INJ_PORT, frames: Array.from({ length: count }, (_, k) => echo(k)), spacingNs: 1 * MS, startNs: bootNs - 10 * MS });
    idle(sim);
    const evs = sim.trace(cursor).events;
    const bootAt = t0 + bootNs;
    const injected = evs.filter((e): e is Created => e.kind === 'pduCreated' && e.device === 'inj').map((e) => e.pdu.id);
    expect(injected).toHaveLength(count);
    // R2 came back with its startup configuration and initiated at once: its new exchange replaced R1's SA
    const r2Est = ikeTransitions(evs).find((x) => x.device === 'r2' && x.to === 'established')!;
    expect(ikeTransitions(evs).filter((x) => x.device === 'r1').map((x) => [x.from, x.to, x.cause])).toEqual([
      ['established', 'init-answered', 'new exchange from the peer replaces the SA'],
      ['init-answered', 'established', 'initiator authenticated'],
    ]);
    const new1 = saRow(sim, 'r1')!;
    const new2 = saRow(sim, 'r2')!;
    expect(new1).toMatchObject({ role: 'responder', state: 'established' });
    expect(new2).toMatchObject({ role: 'initiator', state: 'established', espSpiIn: new1.espSpiOut, espSpiOut: new1.espSpiIn });
    expect(new1.espSpiIn).not.toBe(old1.espSpiIn);
    expect(new1.espSpiOut).not.toBe(old1.espSpiOut);
    expect(new2.ikeSpiI).not.toBe(old2.ikeSpiI);
    // the old SPI in flight: ESP that reached the rebooted R2 before the new SA drops ipsec-no-sa, naming R1's old
    // outbound SPI (R2's lost inbound one)
    const noSa = evs.filter((e): e is Drop => e.kind === 'drop' && e.reason === 'ipsec-no-sa');
    expect(noSa.length).toBeGreaterThan(0);
    for (const d of noSa) {
      // dropped where it arrived (the SA, and so its tunnel, is unknown); counted on the tunnel its outer addresses name
      expect([d.device, d.port, d.detail]).toEqual(['r2', SE0, ipsecNoSaDetail(old1.espSpiOut!, R1_WAN)]);
      expect(d.t).toBeGreaterThanOrEqual(bootAt);
      expect(d.t).toBeLessThan(r2Est.t);
      expect(injected).toContain(d.pdu.id);
      expect((sim.pdu(d.pdu.id)!.provenance as readonly Mut[]).find((m) => m.reason === 'Encrypt')!.device).toBe('r1');
    }
    expect((sim.device('r2')!.stateSnapshots().find((v) => v.process === 'gre')!.state as { tunnels: { noSa: number }[] }).tunnels[0]!.noSa).toBe(noSa.length);
    // R1's tunnel went down while the new exchange ran, and came back with the new SA
    expect(evs.filter((e) => e.kind === 'portState' && e.device === 'r1' && e.port === TU0).map((e) => [(e as { operUp: boolean }).operUp, (e as { reason?: string }).reason ?? null])).toEqual([
      [false, 'ike-negotiating'],
      [true, null],
    ]);
    // until the new SA nothing reached PC2; from it on every echo R1 encrypted crosses on the new SPI
    const reached = evs.filter((e): e is Extract<TraceEvent, { kind: 'frameRx' }> => e.kind === 'frameRx' && e.device === 'pc2' && injected.includes(e.pdu.id));
    expect(reached.length).toBeGreaterThan(0);
    for (const e of reached) {
      expect(e.t).toBeGreaterThan(r2Est.t);
      const enc = (sim.pdu(e.pdu.id)!.provenance as readonly Mut[]).filter((m) => m.reason === 'Encrypt');
      expect(enc).toHaveLength(1);
    }
    expect(evs.filter((e): e is Drop => e.kind === 'drop' && e.reason === 'ipsec-no-sa' && e.t > r2Est.t)).toEqual([]);
    const lastSent = Math.max(...evs.filter((e): e is Created => e.kind === 'pduCreated' && e.device === 'inj').map((e) => e.t));
    expect(lastSent).toBeGreaterThan(r2Est.t);
    const sentAfter = evs.filter((e): e is Created => e.kind === 'pduCreated' && e.device === 'inj' && e.t > r2Est.t).map((e) => e.pdu.id);
    for (const id of sentAfter) expect(reached.some((e) => e.pdu.id === id)).toBe(true);
    expect(ping(sim, 'pc1', PC2_ADDR).text).toContain('Sent 5, received 5, lost 0 (0% loss)');
    idle(sim);
  });
});

describe('accept.p3.ipsec-failure [C13]: determinism (§10, §4.1)', () => {
  it('one seed, three runs: a wrong key retried for 60 s, then a silent peer, give byte-identical trace and snapshot JSON', () => {
    const run = (): string => {
      const wrong = tunnelWorld({ mode: 'ipsec', r2Key: WRONG_KEY });
      wrong.runFor(60 * SEC);
      const silent = tunnelWorld({ mode: 'ipsec', r2Silent: true });
      silent.runFor(IKE_RETRY_NS);
      return jsonOf([wrong.trace(0).events, wrong.snapshot(), silent.trace(0).events, silent.snapshot()]);
    };
    const first = run();
    expect(run()).toBe(first);
    expect(run()).toBe(first);
  });
});

describe('accept.p3.ipsec-failure [C13]: protection is for IPsec tunnels only (§2.17)', () => {
  it('tunnel protection on a GRE-mode tunnel is refused with ipsecProtectionVtiOnly: nothing is stored, no SA is asked for, the GRE tunnel stays up', () => {
    const sim = tunnelWorld({ mode: 'gre' });
    const session = sim.cli.open('r1', 'console');
    for (const l of ['enable', 'configure terminal', `interface ${TU0}`]) expect(sim.cli.exec(session, l).error).toBeUndefined();
    const cursor = sim.trace(0).next;
    const r = sim.cli.exec(session, 'tunnel protection ipsec profile VPN');
    expect(r.error?.message).toBe(CLI_MESSAGES.ipsecProtectionVtiOnly);
    expect(r.output).toBe(CLI_MESSAGES.ipsecProtectionVtiOnly);
    expect(CLI_MESSAGES.ipsecProtectionVtiOnly).toBe('% Tunnel protection applies to IPsec tunnels here ("tunnel mode ipsec ipv4"); GRE over IPsec is not simulated.');
    idle(sim);
    const evs = sim.trace(cursor).events;
    expect(evs.filter((e) => e.kind === 'configChange')).toEqual([]);
    expect(sim.device('r1')!.running.render()).not.toContain('tunnel protection');
    expect(sim.device('r1')!.tables.get('ipsec-sa')!.size).toBe(0);
    expect(sim.device('r1')!.tables.get<SocketRow>('sockets')?.rows().find((x) => x.id === IKE_SOCKET)).toBeUndefined();
    expect(evs.filter((e) => (e.kind === 'pduCreated' && e.process === 'ike') || (e.kind === 'tableWrite' && e.table === 'ipsec-sa'))).toEqual([]);
    expect(tunnelRow(sim, 'r1')).toMatchObject({ mode: 'gre', state: 'up' });
    expect(tunnelUp(sim, 'r1')).toBe(true);
    // the same line on the ipsec-mode tunnel is accepted (the VTI): the mode decides
    for (const l of ['tunnel mode ipsec ipv4', 'tunnel protection ipsec profile VPN']) expect(sim.cli.exec(session, l).error).toBeUndefined();
    idle(sim);
    expect(tunnelRow(sim, 'r1')).toMatchObject({ mode: 'ipsec' });
    expect(sim.device('r1')!.running.render()).toContain(' tunnel protection ipsec profile VPN');
    // a GRE packet still never carries a UDP 500 exchange of its own: the refused line asked for nothing
    expect(evs.some((e) => e.kind === 'pduCreated' && sim.pdu(e.pdu.id)!.layer('udp')?.fields.dstPort === 500 && sim.pdu(e.pdu.id)!.layer('ipv4')?.fields.protocol === IPPROTO_UDP)).toBe(false);
  });
});
