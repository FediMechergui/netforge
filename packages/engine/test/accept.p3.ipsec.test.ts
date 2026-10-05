/**
 * accept.p3.ipsec [C13] — ARCHITECTURE-P3 §10.1 row `accept.p3.ipsec.test.ts` (W4 qa; on `staged.world` at stage P3,
 * rule 14 step 1; the flip is a later, separate change): §3.13 steps 1–9 and 11 — a site-to-site IPsec VTI comes up and
 * only ESP crosses the provider.
 *
 *   - the four IKE messages in order with exact headers (every value FNV-derived, §4.1, D27), the crossing rule
 *     whichever request arrives first, IKE_AUTH marked `protectedBy: 'ike'`;
 *   - the `ipsec-sa` rows; Tunnel0 up only after both SAs of its tunnel (inbound and outbound) exist;
 *   - ping 5/5 with one PduId end to end; head provenance exactly Decapsulate ethernet, Encapsulate esp, Encrypt,
 *     Encapsulate ipv4, and tail Decrypt;
 *   - every leg at the ISP is IPv4 protocol 50 with `PduSummary.tunnel === 'ipsec'` (read from the trace; the
 *     `path.tunnelAt` kind that grades it is W5's, proved with lab 25);
 *   - the key in no byte, snapshot or trace (ruling R36);
 *   - the D15 fallback at 1456 with ICMP 3/4 (step 11).
 *
 * The world (test/tunnel.world.ts) carries the registry of the W4 flip, so it is the same world after the flip.
 * Counts and sizes that follow from constants are computed from them (§10).
 */
import { describe, expect, it } from 'vitest';
import { IPPROTO_ESP, IPPROTO_UDP, IPSEC_OVERHEAD, UDP_PORT_IKE } from '../src/contracts/pdu.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { IpsecSaRow, SocketRow } from '../src/contracts/tables.js';
import { MS } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { GRE_DEFAULT_TRANSPORT_MTU, GRE_OUTER_TTL, greMtuDetail, greTunnelCause } from '../src/protocols/gre.js';
import { IKE_DEBUG, IKE_SOCKET } from '../src/protocols/ike.js';
import {
  IKE_AUTH,
  IKE_FLAG_INITIATOR,
  IKE_FLAG_RESPONSE,
  IKE_PROPOSAL,
  IKE_PROPOSAL_LABEL,
  IKE_SA_INIT,
  IKE_SPI_ZERO,
  IKE_TRAFFIC_SELECTOR,
  ikeChildProposal,
} from '../src/protocols/ike/exchange.js';
import { espSpiOf, ikeAuthProof, ikeKeOf, ikeNonceOf, ikeSpiOf, ipsecKeyIdOf, type IkeProofInputs } from '../src/protocols/ike/proof.js';
import { ESP_NEXT_HEADER_IPV4 } from '../src/pdu/codecs/esp.js';
import { injectFrames } from './inject.js';
import { ping } from './sim.harness.js';
import {
  GI0,
  INJ_PORT,
  LAB_KEY,
  MASK24,
  PC1_ADDR,
  PC2_ADDR,
  PUBLIC_ADDRS,
  R1_WAN,
  R2_WAN,
  SE0,
  SE1,
  TU0,
  applyLine,
  containsAscii,
  ipsecTunnelLines,
  jsonOf,
  oversizeEcho,
  privateRoutes,
  saRow,
  tunnelRow,
  tunnelUp,
  tunnelWorld,
  type Created,
  type Drop,
  type FrameTx,
  type Mut,
} from './tunnel.world.js';

/** The IP MTU of a VTI on a 1500-byte transport (D27, D15). */
const ipsecIpMtu = (): number => GRE_DEFAULT_TRANSPORT_MTU - IPSEC_OVERHEAD;
const ETH_OVERHEAD = 18;
const HDLC_OVERHEAD = 6;
const PING_BYTES = 100;
const HOST_TTL = 128;
/** The provenance cause of every rewrap on Tunnel0 (read at call time, rule 12). */
const cause = (): string => greTunnelCause(TU0);
/** RFC 7296 payload type numbers: the first payload of each message (the header's `nextPayload`). */
const PAYLOAD_SA = 33;
const PAYLOAD_IDI = 35;
const PAYLOAD_IDR = 36;
const IKE_VERSION_2 = 0x20;
const IKE_HEADER_BYTES = 28;
const UDP_HEADER_BYTES = 8;
const IPV4_HEADER_BYTES = 20;

interface IkeSent {
  readonly t: number;
  readonly id: number;
  readonly device: string;
  readonly ike: Record<string, unknown>;
  readonly ipv4: Record<string, unknown>;
  readonly udp: Record<string, unknown>;
  readonly meta: { protected?: true; protectedBy?: string };
}

/** Every IKEv2 message the ike daemons created in `evs`, in creation order, with the layers they arrived with. */
function ikeSent(sim: Simulation, evs: readonly TraceEvent[]): IkeSent[] {
  return evs
    .filter((e): e is Created => e.kind === 'pduCreated' && e.process === 'ike')
    .map((e) => {
      const p = sim.pdu(e.pdu.id)!;
      return {
        t: e.t,
        id: e.pdu.id,
        device: e.device,
        ike: { ...p.layer('ikev2')!.fields },
        ipv4: { ...p.layer('ipv4')!.fields },
        udp: { ...p.layer('udp')!.fields },
        meta: { ...(p.meta.protected === true ? { protected: true as const } : {}), ...(p.meta.protectedBy !== undefined ? { protectedBy: p.meta.protectedBy } : {}) },
      };
    });
}

/** [device, from, to, cause] of every `ike` FSM transition in `evs`. */
const ikeTransitions = (evs: readonly TraceEvent[]): string[][] =>
  evs.flatMap((e) => (e.kind === 'debug' && e.event.fsm?.machine === 'ike' ? [[e.event.device, e.event.fsm.from, e.event.fsm.to, e.event.fsm.cause ?? '']] : []));

/** A row without its timestamps (rows of two runs compared). */
const untimed = (row: IpsecSaRow | undefined): Record<string, unknown> => {
  const { since: _s, updatedAt: _u, ...rest } = row as IpsecSaRow & { updatedAt?: number };
  return rest;
};

/**
 * The derived values of the §3.13 exchange (counter values per router, §4.1): R1 starts with its counter 0; R2 starts
 * its own exchange with counter 0, abandons it (the crossing rule) and answers R1's with counter 1.
 */
function expectedExchange(): {
  spiI: string; spiR: string; nonceI: string; nonceR: string; keI: string; keR: string; r2OwnSpiI: string;
  espR1: number; espR2: number; proof: IkeProofInputs;
} {
  const spiI = ikeSpiOf('r1', TU0, 0, 'I');
  const spiR = ikeSpiOf('r2', TU0, 1, 'R');
  const nonceI = ikeNonceOf('r1', TU0, 0, 'I');
  const nonceR = ikeNonceOf('r2', TU0, 1, 'R');
  return {
    spiI,
    spiR,
    nonceI,
    nonceR,
    keI: ikeKeOf('r1', TU0, 0, 'I'),
    keR: ikeKeOf('r2', TU0, 1, 'R'),
    r2OwnSpiI: ikeSpiOf('r2', TU0, 0, 'I'),
    espR1: espSpiOf('r1', TU0, 0),
    espR2: espSpiOf('r2', TU0, 1),
    proof: { key: LAB_KEY, spiI, spiR, nonceI, nonceR },
  };
}

describe('accept.p3.ipsec [C13]: the SA comes up (§3.13 steps 1–6)', () => {
  it('the underlay asks for an SA; the four IKE messages in order with exact headers; the crossing request is discarded by the lower address; IKE_AUTH protected by ike; the ipsec-sa rows', () => {
    const sim = tunnelWorld({ mode: 'ipsec' });
    const evs = sim.trace(0).events;
    const x = expectedExchange();
    // step 1: the underlay is ready → tunnels {ipsec, down ike-negotiating, 1500 / 1456}; the SA requested (negotiating)
    const writes = (device: string, table: string): Record<string, unknown>[] =>
      evs.flatMap((e) => (e.kind === 'tableWrite' && e.device === device && e.table === table ? [e.row] : []));
    for (const [device, local, peer] of [['r1', R1_WAN, R2_WAN], ['r2', R2_WAN, R1_WAN]] as const) {
      const tunnels = writes(device, 'tunnels');
      const negotiating = tunnels.findIndex((r) => r.reason === 'ike-negotiating');
      expect(tunnels[negotiating]).toMatchObject({ mode: 'ipsec', state: 'down', reason: 'ike-negotiating', transportMtu: GRE_DEFAULT_TRANSPORT_MTU, ipMtu: ipsecIpMtu(), source: local, destination: peer });
      expect(tunnels.slice(negotiating + 1).map((r) => [r.state, r.reason ?? null])).toEqual([['up', null]]);
      expect(writes(device, 'ipsec-sa')[0]).toEqual({ key: TU0, port: TU0, local, peer, profile: 'VPN', role: 'initiator', state: 'negotiating', since: expect.any(Number), updatedAt: expect.any(Number) });
    }
    expect(ipsecIpMtu()).toBe(1456);
    // steps 2–5: R1's request, R2's crossing request (both at the same instant), then the exchange R1 started
    const sent = ikeSent(sim, evs);
    expect(sent.map((m) => m.device)).toEqual(['r1', 'r2', 'r2', 'r1', 'r2']);
    expect(sent[0]!.t).toBe(sent[1]!.t);
    for (const m of sent) {
      const [src, dst] = m.device === 'r1' ? [R1_WAN, R2_WAN] : [R2_WAN, R1_WAN];
      expect(m.ipv4).toMatchObject({ src, dst, protocol: IPPROTO_UDP, ttl: GRE_OUTER_TTL - 1 });
      expect(m.udp).toMatchObject({ srcPort: UDP_PORT_IKE, dstPort: UDP_PORT_IKE });
      expect(m.ike.length).toBe((m.udp.length as number) - UDP_HEADER_BYTES);
      expect(m.ike.length).toBe((m.ipv4.totalLength as number) - IPV4_HEADER_BYTES - UDP_HEADER_BYTES);
      expect(m.ike.length as number).toBeGreaterThan(IKE_HEADER_BYTES);
    }
    const initLength = sent[0]!.ike.length;
    const authLength = sent[3]!.ike.length;
    const [init, crossing, initResp, auth, authResp] = sent;
    // the four messages of the exchange (RFC 7296 headers; original compact payload bodies; nothing randomised)
    expect(init!.ike).toEqual({
      spiI: x.spiI, spiR: IKE_SPI_ZERO, nextPayload: PAYLOAD_SA, version: IKE_VERSION_2, exchange: IKE_SA_INIT, flags: IKE_FLAG_INITIATOR, messageId: 0, length: initLength,
      sa: IKE_PROPOSAL, ke: x.keI, nonce: x.nonceI,
    });
    expect(initResp!.ike).toEqual({
      spiI: x.spiI, spiR: x.spiR, nextPayload: PAYLOAD_SA, version: IKE_VERSION_2, exchange: IKE_SA_INIT, flags: IKE_FLAG_RESPONSE, messageId: 0, length: initLength,
      sa: IKE_PROPOSAL, ke: x.keR, nonce: x.nonceR,
    });
    expect(auth!.ike).toEqual({
      spiI: x.spiI, spiR: x.spiR, nextPayload: PAYLOAD_IDI, version: IKE_VERSION_2, exchange: IKE_AUTH, flags: IKE_FLAG_INITIATOR, messageId: 1, length: authLength,
      idi: R1_WAN, auth: ikeAuthProof(x.proof, 'I'), sa: ikeChildProposal(x.espR1), tsi: IKE_TRAFFIC_SELECTOR, tsr: IKE_TRAFFIC_SELECTOR,
    });
    expect(authResp!.ike).toEqual({
      spiI: x.spiI, spiR: x.spiR, nextPayload: PAYLOAD_IDR, version: IKE_VERSION_2, exchange: IKE_AUTH, flags: IKE_FLAG_RESPONSE, messageId: 1, length: authLength,
      idr: R2_WAN, auth: ikeAuthProof(x.proof, 'R'), sa: ikeChildProposal(x.espR2), tsi: IKE_TRAFFIC_SELECTOR, tsr: IKE_TRAFFIC_SELECTOR,
    });
    expect([initLength, authLength]).toEqual([153, 141]);
    // R2's own request, abandoned when R1's crossed it
    expect(crossing!.ike).toEqual({
      spiI: x.r2OwnSpiI, spiR: IKE_SPI_ZERO, nextPayload: PAYLOAD_SA, version: IKE_VERSION_2, exchange: IKE_SA_INIT, flags: IKE_FLAG_INITIATOR, messageId: 0, length: initLength,
      sa: IKE_PROPOSAL, ke: ikeKeOf('r2', TU0, 0, 'I'), nonce: ikeNonceOf('r2', TU0, 0, 'I'),
    });
    // only the IKE_AUTH messages are protected, by ike (D27)
    expect(sent.map((m) => m.meta)).toEqual([{}, {}, {}, { protected: true, protectedBy: 'ike' }, { protected: true, protectedBy: 'ike' }]);
    // the answers are triggered by the requests they answer
    expect(sim.pdu(initResp!.id)!.meta.triggeredBy).toBe(init!.id);
    expect(sim.pdu(auth!.id)!.meta.triggeredBy).toBe(initResp!.id);
    expect(sim.pdu(authResp!.id)!.meta.triggeredBy).toBe(auth!.id);
    // the crossing rule (D27): R1 (the lower address) discards R2's request with a crypto ikev2 line; R2 answers R1's
    const r1Debug = evs.flatMap((e) => (e.kind === 'debug' && e.event.device === 'r1' && e.event.process === 'ike' ? [[e.event.category, e.event.message]] : []));
    expect(r1Debug).toContainEqual([IKE_DEBUG, `${TU0}: crossing IKE_SA_INIT from ${R2_WAN} discarded: the lower address ${R1_WAN} keeps its own exchange`]);
    expect(ikeTransitions(evs)).toEqual([
      ['r1', 'idle', 'init-sent', 'exchange started'],
      ['r2', 'idle', 'init-sent', 'exchange started'],
      ['r2', 'init-sent', 'init-answered', `crossing request from the lower address ${R1_WAN}`],
      ['r1', 'init-sent', 'auth-sent', 'IKE_SA_INIT answered'],
      ['r2', 'init-answered', 'established', 'initiator authenticated'],
      ['r1', 'auth-sent', 'established', 'responder authenticated'],
    ]);
    // the rows: one IKE SA (the same SPIs), crosswise ESP SPIs, the fixed proposal
    expect(saRow(sim, 'r1')).toEqual({
      key: TU0, port: TU0, local: R1_WAN, peer: R2_WAN, profile: 'VPN', role: 'initiator', state: 'established',
      ikeSpiI: x.spiI, ikeSpiR: x.spiR, espSpiIn: x.espR1, espSpiOut: x.espR2, proposal: IKE_PROPOSAL_LABEL,
      since: sim.trace(0).events.find((e) => e.kind === 'debug' && e.event.device === 'r1' && e.event.fsm?.to === 'established')!.t,
      updatedAt: expect.any(Number),
    });
    expect(saRow(sim, 'r2')).toEqual({
      key: TU0, port: TU0, local: R2_WAN, peer: R1_WAN, profile: 'VPN', role: 'responder', state: 'established',
      ikeSpiI: x.spiI, ikeSpiR: x.spiR, espSpiIn: x.espR2, espSpiOut: x.espR1, proposal: IKE_PROPOSAL_LABEL,
      since: authResp!.t,
      updatedAt: expect.any(Number),
    });
    expect(writes('r1', 'ipsec-sa').map((r) => [r.role, r.state])).toEqual([['initiator', 'negotiating'], ['initiator', 'established']]);
    expect(writes('r2', 'ipsec-sa').map((r) => [r.role, r.state])).toEqual([['initiator', 'negotiating'], ['responder', 'negotiating'], ['responder', 'established']]);
    // the socket and the StateView: port 500 open on both ends, nothing outstanding
    for (const d of ['r1', 'r2']) {
      expect(sim.device(d)!.tables.get<SocketRow>('sockets')!.rows().find((r) => r.id === IKE_SOCKET)).toMatchObject({ localPort: UDP_PORT_IKE, owner: 'ike' });
      expect(sim.device(d)!.stateSnapshots().find((v) => v.process === 'ike')!.state).toEqual({ exchanges: [] });
    }
    // the ISP never saw a private address in a header it routed, and holds no private route
    expect(privateRoutes(sim, 'isp')).toEqual([]);
  });

  it('Tunnel0 comes up only after both SAs of its tunnel exist: the line protocol follows the established row (inbound and outbound SPIs), never before', () => {
    const sim = tunnelWorld({ mode: 'ipsec' });
    const evs = sim.trace(0).events;
    for (const d of ['r1', 'r2']) {
      const ups = evs.map((e, i) => [e, i] as const).filter(([e]) => e.kind === 'portState' && e.device === d && e.port === TU0 && e.operUp);
      expect(ups).toHaveLength(1);
      const [up, upAt] = ups[0]!;
      const established = evs.findIndex((e) => e.kind === 'tableWrite' && e.device === d && e.table === 'ipsec-sa' && e.row.state === 'established');
      expect(established).toBeGreaterThanOrEqual(0);
      expect(established).toBeLessThan(upAt);
      const row = (evs[established] as Extract<TraceEvent, { kind: 'tableWrite' }>).row;
      expect(typeof row.espSpiIn).toBe('number');
      expect(typeof row.espSpiOut).toBe('number');
      expect(up.t).toBe(evs[established]!.t);
      // before the SA the tunnel row was down negotiating and the static through Tunnel0 unusable
      const rowsBefore = evs.slice(0, upAt).flatMap((e) => (e.kind === 'tableWrite' && e.device === d && e.table === 'tunnels' ? [e.row] : []));
      expect(rowsBefore.filter((r) => r.state === 'up')).toHaveLength(1);
      expect(rowsBefore.at(-2)).toMatchObject({ state: 'down', reason: 'ike-negotiating' });
      expect(tunnelRow(sim, d)).toMatchObject({ mode: 'ipsec', state: 'up', ipMtu: ipsecIpMtu(), since: up.t });
      expect(tunnelRow(sim, d)!.reason).toBeUndefined();
      expect(tunnelUp(sim, d)).toBe(true);
    }
    // the responder's SA is installed when the initiator's proof arrives, the initiator's when the answer does
    const r1Up = evs.find((e) => e.kind === 'portState' && e.device === 'r1' && e.port === TU0 && e.operUp)!.t;
    const r2Up = evs.find((e) => e.kind === 'portState' && e.device === 'r2' && e.port === TU0 && e.operUp)!.t;
    expect(r2Up).toBeLessThan(r1Up);
    const rib = sim.device('r1')!.tables.rib;
    expect(rib.get('172.16.0.0/30')).toMatchObject({ source: 'C', iface: TU0 });
    expect(rib.get('192.168.2.0/24')).toMatchObject({ source: 'S', iface: TU0 });
  });

  it('the crossing rule, whichever request arrives first: R1 (the lower address) keeps its exchange, R2 answers it; the outcome equals the simultaneous start', () => {
    const reference = tunnelWorld({ mode: 'ipsec' });
    const outcome = (first: 'r1' | 'r2'): void => {
      const sim = tunnelWorld({ mode: 'ipsec', r1Tunnel: ipsecTunnelLines('172.16.0.1', R2_WAN, null), r2Tunnel: ipsecTunnelLines('172.16.0.2', R1_WAN, null) });
      expect([tunnelRow(sim, 'r1')!.reason, tunnelRow(sim, 'r2')!.reason]).toEqual(['ike-negotiating', 'ike-negotiating']);
      const second = first === 'r1' ? 'r2' : 'r1';
      const cursor = sim.trace(0).next;
      applyLine(sim, first, [['interface', TU0]], ['tunnel', 'protection', 'ipsec', 'profile', 'VPN']);
      sim.runFor(1 * MS);
      applyLine(sim, second, [['interface', TU0]], ['tunnel', 'protection', 'ipsec', 'profile', 'VPN']);
      expect(sim.runToIdle().stopped).toBeUndefined();
      const evs = sim.trace(cursor).events;
      const requests = ikeSent(sim, evs).filter((m) => m.ike.exchange === IKE_SA_INIT && m.ike.flags === IKE_FLAG_INITIATOR);
      // one request each, no retransmission: they genuinely crossed, and the first sent is the first to arrive
      expect(requests.map((m) => m.device)).toEqual([first, second]);
      const arrival = (m: IkeSent): number => evs.find((e) => e.kind === 'frameRx' && e.pdu.id === m.id && e.device === (m.device === 'r1' ? 'r2' : 'r1'))!.t;
      expect(arrival(requests[0]!)).toBeLessThan(arrival(requests[1]!));
      // each arrived while its receiver was itself in init-sent (the crossing): R1 discards, R2 abandons and answers
      expect(evs.some((e) => e.kind === 'debug' && e.event.device === 'r1' && e.event.message === `${TU0}: crossing IKE_SA_INIT from ${R2_WAN} discarded: the lower address ${R1_WAN} keeps its own exchange`)).toBe(true);
      const tr = ikeTransitions(evs);
      expect(tr.filter(([d]) => d === 'r1').map(([, f, t, c]) => [f, t, c])).toEqual([
        ['idle', 'init-sent', 'exchange started'],
        ['init-sent', 'auth-sent', 'IKE_SA_INIT answered'],
        ['auth-sent', 'established', 'responder authenticated'],
      ]);
      expect(tr.filter(([d]) => d === 'r2').map(([, f, t, c]) => [f, t, c])).toEqual([
        ['idle', 'init-sent', 'exchange started'],
        ['init-sent', 'init-answered', `crossing request from the lower address ${R1_WAN}`],
        ['init-answered', 'established', 'initiator authenticated'],
      ]);
      for (const d of ['r1', 'r2']) expect(untimed(saRow(sim, d))).toEqual(untimed(saRow(reference, d)));
      expect([tunnelUp(sim, 'r1'), tunnelUp(sim, 'r2')]).toEqual([true, true]);
      expect(ping(sim, 'pc1', PC2_ADDR).text).toContain('Sent 5, received 5, lost 0 (0% loss)');
    };
    outcome('r1');
    outcome('r2');
  });
});

describe('accept.p3.ipsec [C13]: the protected ping (§3.13 steps 7–9)', () => {
  it('ping 5/5, each echo one PduId end to end: head Decapsulate ethernet, Encapsulate esp, Encrypt, Encapsulate ipv4 at R1; tail Decrypt at R2; ESP sequence numbers from 1 on each SA', () => {
    const sim = tunnelWorld({ mode: 'ipsec' });
    const x = expectedExchange();
    const keyId = ipsecKeyIdOf(x.proof);
    const r = ping(sim, 'pc1', PC2_ADDR);
    expect(r.text).toContain('!!!!!');
    expect(r.text).toContain('Sent 5, received 5, lost 0 (0% loss)');
    const created = r.evs.filter((e): e is Created => e.kind === 'pduCreated');
    const requests = created.filter((e) => e.device === 'pc1' && e.pdu.summary.startsWith('ICMP echo request'));
    const replies = created.filter((e) => e.device === 'pc2' && e.pdu.summary.startsWith('ICMP echo reply'));
    expect([requests.length, replies.length]).toEqual([5, 5]);
    const legsOf = (id: number): FrameTx[] => r.evs.filter((e): e is FrameTx => e.kind === 'frameTx' && e.pdu.id === id);
    const espBytes = PING_BYTES + IPSEC_OVERHEAD + HDLC_OVERHEAD;
    for (const req of requests) {
      const id = req.pdu.id;
      expect(legsOf(id).map((l) => [l.from.device, l.to.device, l.pdu.size, l.pdu.tunnel ?? null])).toEqual([
        ['pc1', 'r1', PING_BYTES + ETH_OVERHEAD, null],
        ['r1', 'isp', espBytes, 'ipsec'],
        ['isp', 'r2', espBytes, 'ipsec'],
        ['r2', 'pc2', PING_BYTES + ETH_OVERHEAD, null],
      ]);
      expect(r.evs.some((e) => e.kind === 'frameRx' && e.device === 'pc2' && e.pdu.id === id)).toBe(true);
      const muts = sim.pdu(id)!.provenance as readonly Mut[];
      const at = (d: string): unknown[][] => muts.filter((m) => m.device === d).map((m) => [m.reason, m.field, m.cause ?? '']);
      // head: the inner TTL by the static through Tunnel0, then Decapsulate ethernet, Encapsulate esp, Encrypt,
      // Encapsulate ipv4 (cause interface Tunnel0), then the serial framing
      expect(at('r1')).toEqual([
        ['TtlDecrement', 'ipv4.ttl', `ip route 192.168.2.0 ${MASK24} ${TU0}`],
        ['ChecksumRecompute', 'ipv4.checksum', `ip route 192.168.2.0 ${MASK24} ${TU0}`],
        ['FcsRecompute', 'ethernet.fcs', `ip route 192.168.2.0 ${MASK24} ${TU0}`],
        ['Decapsulate', 'ethernet', cause()],
        ['Encapsulate', 'esp', cause()],
        ['Encrypt', 'esp.keyId', cause()],
        ['Encapsulate', 'ipv4', cause()],
        ['Encapsulate', 'hdlc', cause()],
      ]);
      expect(at('isp')).toEqual([
        ['TtlDecrement', 'ipv4.ttl', `connected via ${SE1}`],
        ['ChecksumRecompute', 'ipv4.checksum', `connected via ${SE1}`],
        ['FcsRecompute', 'hdlc.fcs', `connected via ${SE1}`],
      ]);
      // tail: Decrypt (which clears the protected mark), ONE strip-only rewrap (hdlc, ipv4, esp), the inner TTL
      expect(at('r2')).toEqual([
        ['Decrypt', 'esp.keyId', cause()],
        ['Decapsulate', 'hdlc', cause()],
        ['Decapsulate', 'ipv4', cause()],
        ['Decapsulate', 'esp', cause()],
        ['TtlDecrement', 'ipv4.ttl', `connected via ${GI0}`],
        ['ChecksumRecompute', 'ipv4.checksum', `connected via ${GI0}`],
        ['Encapsulate', 'ethernet', `connected via ${GI0}`],
      ]);
      // the Encrypt and Decrypt records carry the SA's key id (both ends derive the same), never the key
      expect(muts.filter((m) => m.reason === 'Encrypt' || m.reason === 'Decrypt').map((m) => [m.device, m.reason, m.before, m.after])).toEqual([
        ['r1', 'Encrypt', null, keyId],
        ['r2', 'Decrypt', null, keyId],
      ]);
      expect(muts.filter((m) => m.reason === 'TtlDecrement').map((m) => [m.device, m.before, m.after])).toEqual([
        ['r1', HOST_TTL, HOST_TTL - 1],
        ['isp', GRE_OUTER_TTL, GRE_OUTER_TTL - 1],
        ['r2', HOST_TTL - 1, HOST_TTL - 2],
      ]);
      // delivered in clear: the mark cleared at the tail, the inner packet alone
      const view = sim.pdu(id)!;
      expect(view.meta.protected).toBeUndefined();
      expect(view.meta.protectedBy).toBeUndefined();
      expect(view.layers.map((l) => l.proto)).toEqual(['ethernet', 'ipv4', 'icmpv4', 'payload']);
    }
    for (const rep of replies) {
      expect(legsOf(rep.pdu.id).map((l) => [l.from.device, l.to.device, l.pdu.tunnel ?? null])).toEqual([
        ['pc2', 'r2', null],
        ['r2', 'isp', 'ipsec'],
        ['isp', 'r1', 'ipsec'],
        ['r1', 'pc1', null],
      ]);
      const muts = sim.pdu(rep.pdu.id)!.provenance as readonly Mut[];
      expect(muts.filter((m) => m.reason === 'Encrypt' || m.reason === 'Decrypt').map((m) => [m.device, m.reason, m.after])).toEqual([
        ['r2', 'Encrypt', keyId],
        ['r1', 'Decrypt', keyId],
      ]);
    }
    // each end counted its own SA from sequence 1: five out, five in
    for (const d of ['r1', 'r2']) {
      const view = (sim.device(d)!.stateSnapshots().find((v) => v.process === 'gre')!.state as { tunnels: Record<string, unknown>[] }).tunnels[0]!;
      expect(view).toMatchObject({ port: TU0, mode: 'ipsec', state: 'up', encaps: 5, decaps: 5, seqOut: 5, lastSeqIn: 5, noSa: 0, mtuDrops: 0 });
    }
  });

  it('only ESP crosses the provider (step 8): every leg at the ISP is IPv4 protocol 50 between the public ends with PduSummary.tunnel ipsec in the trace; the inner packet travels only inside ESP', () => {
    const sim = tunnelWorld({ mode: 'ipsec' });
    const cap = sim.startCapture({ ports: [{ device: 'isp', port: SE0 }, { device: 'isp', port: SE1 }], name: 'ISP' });
    const cursor = sim.trace(0).next;
    const r = ping(sim, 'pc1', PC2_ADDR);
    expect(r.text).toContain('!!!!!');
    // the trace: every frame the ISP sent or received in the ping (background serial keepalives aside) is a tunnel leg
    // tagged ipsec
    const atIsp = sim.trace(cursor).events.filter((e): e is FrameTx => e.kind === 'frameTx' && e.background !== true && (e.from.device === 'isp' || e.to.device === 'isp'));
    expect(atIsp).toHaveLength(4 * 5);
    for (const l of atIsp) expect(l.pdu.tunnel).toBe('ipsec');
    // the wire: each of those legs (seen arriving at one ISP port and leaving the other) is IPv4 protocol 50 + ESP
    const rows = sim.queryCapture(cap, { from: 0, limit: 1000 }).rows;
    expect(rows).toHaveLength(atIsp.length);
    const r1 = saRow(sim, 'r1')!;
    const r2 = saRow(sim, 'r2')!;
    const seqs: Record<string, number[]> = {};
    for (const row of rows) {
      const rec = sim.captureRecord(cap, row.index)!;
      expect(rec.layers.slice(0, 4).map((l) => l.proto)).toEqual(['hdlc', 'ipv4', 'esp', 'ipv4']);
      const outer = rec.layers[1]!.fields;
      expect(outer.protocol).toBe(IPPROTO_ESP);
      expect(PUBLIC_ADDRS.includes(String(outer.src)) && PUBLIC_ADDRS.includes(String(outer.dst))).toBe(true);
      const esp = rec.layers[2]!.fields;
      expect(esp.spi).toBe(outer.src === R1_WAN ? r1.espSpiOut : r2.espSpiOut);
      expect(esp.nextHeader).toBe(ESP_NEXT_HEADER_IPV4);
      expect(esp.icvValid).toBe(true);
      if (row.dir === 'rx') (seqs[String(outer.src)] ??= []).push(Number(esp.seq));
    }
    expect(seqs).toEqual({ [R1_WAN]: [1, 2, 3, 4, 5], [R2_WAN]: [1, 2, 3, 4, 5] });
    expect(sim.queryCapture(cap, { filter: 'esp', from: 0, limit: 1000 }).matched).toBe(rows.length);
    expect(privateRoutes(sim, 'isp')).toEqual([]);
  });

  it('the key is in no byte, snapshot or trace (R36): not on the wire of any port (the IKE exchange and the ping), not in any PDU, row, view or snapshot, not in any trace event', () => {
    let cap = '';
    const sim = tunnelWorld({ mode: 'ipsec', beforeRun: (s) => (cap = s.startCapture({ includeBackground: true, maxRecords: 100_000, name: 'ALL' })) });
    expect(ping(sim, 'pc1', PC2_ADDR).text).toContain('!!!!!');
    const n = sim.captures().find((c) => c.id === cap)!.head;
    const rows = sim.queryCapture(cap, { from: 0, limit: n }).rows;
    expect(rows.length).toBe(n);
    // the IKE_AUTH messages (which carry the proofs) are among the captured frames
    expect(rows.filter((row) => sim.captureRecord(cap, row.index)!.layers.some((l) => l.proto === 'ikev2' && l.fields.exchange === IKE_AUTH)).length).toBeGreaterThanOrEqual(2);
    for (const row of rows) expect(containsAscii(sim.captureRecord(cap, row.index)!.bytes, LAB_KEY)).toBe(false);
    expect(containsAscii(sim.exportCapture(cap, { format: 'pcapng' }), LAB_KEY)).toBe(false);
    const events = sim.trace(0).events;
    for (const e of events) if (e.kind === 'pduCreated') expect(containsAscii(sim.pdu(e.pdu.id)!.bytes, LAB_KEY)).toBe(false);
    expect(events.filter((e) => jsonOf(e).includes(LAB_KEY))).toEqual([]);
    expect(jsonOf(sim.snapshot()).includes(LAB_KEY)).toBe(false);
    for (const d of ['r1', 'isp', 'r2']) {
      const dev = sim.device(d)!;
      expect(jsonOf([dev.tables.names().map((t) => dev.tables.get(t)?.rows()), dev.stateSnapshots()]).includes(LAB_KEY)).toBe(false);
    }
  });
});

describe('accept.p3.ipsec [C13]: determinism (§10, §4.1)', () => {
  it('one seed, three runs: the exchange and a protected ping give byte-identical trace and snapshot JSON (no stream is drawn)', () => {
    const run = (): string => {
      const sim = tunnelWorld({ mode: 'ipsec' });
      ping(sim, 'pc1', PC2_ADDR);
      return jsonOf([sim.trace(0).events, sim.snapshot()]);
    };
    const first = run();
    expect(run()).toBe(first);
    expect(run()).toBe(first);
  });
});

describe('accept.p3.ipsec [C13]: too big (§3.13 step 11, D15)', () => {
  it('1500 bytes with DF drop mtu-exceeded at R1 (1456) and PC1 receives ICMP 3/4 with next-hop MTU 1456; without DF the drop alone; exactly 1456 bytes cross', () => {
    const sim = tunnelWorld({ mode: 'ipsec' });
    const cursor = sim.trace(0).next;
    const big = GRE_DEFAULT_TRANSPORT_MTU;
    injectFrames(sim, { from: 'inj', port: INJ_PORT, frames: [oversizeEcho(sim, big, true), oversizeEcho(sim, ipsecIpMtu() + 1, false), oversizeEcho(sim, ipsecIpMtu(), true)], spacingNs: 10 * MS });
    expect(sim.runToIdle().stopped).toBeUndefined();
    const evs = sim.trace(cursor).events;
    const injected = evs.filter((e): e is Created => e.kind === 'pduCreated' && e.device === 'inj').map((e) => e.pdu.id);
    expect(injected).toHaveLength(3);
    expect(evs.filter((e): e is Drop => e.kind === 'drop' && e.reason === 'mtu-exceeded').map((d) => [d.device, d.port, d.pdu.id, d.detail])).toEqual([
      ['r1', TU0, injected[0], greMtuDetail(ipsecIpMtu())],
      ['r1', TU0, injected[1], greMtuDetail(ipsecIpMtu())],
    ]);
    expect(greMtuDetail(ipsecIpMtu())).toBe('larger than the tunnel can carry (1456 bytes); fragmentation is not simulated');
    const errors = evs.filter((e): e is Created => e.kind === 'pduCreated' && e.device === 'r1' && e.process === 'icmpv4');
    expect(errors).toHaveLength(1);
    const icmp = sim.pdu(errors[0]!.pdu.id)!;
    expect(icmp.layer('icmpv4')!.fields).toMatchObject({ type: 3, code: 4, unused: ipsecIpMtu() });
    expect(icmp.layer('ipv4')!.fields).toMatchObject({ dst: PC1_ADDR });
    expect(icmp.meta.triggeredBy).toBe(injected[0]);
    expect(evs.some((e) => e.kind === 'frameRx' && e.device === 'pc1' && e.pdu.id === errors[0]!.pdu.id)).toBe(true);
    // nothing of the refused datagrams was encrypted
    for (const id of injected.slice(0, 2)) expect((sim.pdu(id)!.provenance as readonly Mut[]).some((m) => m.reason === 'Encrypt')).toBe(false);
    // exactly the IP MTU crosses: 1456 + 44 = 1500 bytes inside HDLC on the provider's links, then reaches PC2
    const leg = evs.find((e): e is FrameTx => e.kind === 'frameTx' && e.pdu.id === injected[2] && e.from.device === 'r1')!;
    expect([leg.to.device, leg.pdu.size, leg.pdu.tunnel]).toEqual(['isp', GRE_DEFAULT_TRANSPORT_MTU + HDLC_OVERHEAD, 'ipsec']);
    expect(evs.some((e) => e.kind === 'frameRx' && e.device === 'pc2' && e.pdu.id === injected[2])).toBe(true);
  });
});
