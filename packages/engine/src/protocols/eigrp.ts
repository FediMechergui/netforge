/**
 * protocols/eigrp.ts — the classic EIGRP daemon [C1] (RFC 7868 as a published wire format; ARCHITECTURE-P3 D26, D8,
 * D11, §2.16, §3.12, §4.2, §4.3, §4.5; §7 W2 eigrp). It runs over the pure W1 modules: `eigrp/config.ts` (the stored
 * lines), `eigrp/metric.ts` (the integer composite metric) and `eigrp/dual.ts` (DUAL per destination).
 *
 * Silence (§4.3): nothing is sent, joined, armed or written unless `router eigrp <as>` is stored (and `no ip routing` is
 * not) and an interface whose primary address matches a `network` line is up. Then, per such interface:
 *   - `ipv4.group join 224.0.0.10` and a hello at once (unless passive; loopbacks are passive by nature), then every
 *     `ip hello-interval eigrp` seconds (`hello:<if>`, periodic, default 5 s). A hello carries the parameter TLV (K
 *     values, the interface's `ip hold-time eigrp`, default 15 s); it leaves as `[ipv4 {ttl 2, dscp 48, protocol 88},
 *     eigrp]` through `ipv4.send {iface}` (the multicast framing rule of arp, or the tunnel owner on a Tunnel port).
 *   - the interface's connected network enters DUAL (`connected`, the interface metric) and is advertised, passive or
 *     not; it is never offered to ipv4 (ipv4 installs C).
 *
 * Neighbours (D26). A hello from an unknown address on a running, non-passive interface, in the same AS and on the
 * interface's subnet, with the same K values, creates a `pending` neighbour (`eigrp-nbr` down → pending), arms the
 * coalesced `hello-reply:<if>` (0 ns) and queues a unicast Update with the init flag. The init Update is TRANSMITTED in
 * the hello-reply dispatch, right after that hello, so on every path the peer hears this router's hello before its
 * init (an init from an address it does not know yet would be ignored and cost one retransmission timeout). The
 * neighbour is `up` when the init Update is acknowledged (`eigrp-nbr` pending → up); then the whole topology follows as
 * reliable Updates, the last one with EOT. A hello in another AS is ignored with an `eigrp packets` debug line; a hello
 * with other K values refuses the neighbour (an existing one is reset) with ONE severity-5 log per refusal episode (a
 * matching hello from that address, the interface going down or a process restart ends the episode). An Update with the init flag from an `up` neighbour means the
 * peer restarted: the neighbour is reset and formed again at once. Every packet from a neighbour re-arms its
 * `hold:<if>:<nbr>` (periodic, the hold time the neighbour advertises): at expiry the neighbour goes down.
 *
 * Reliable transport (D26). Update, query, reply and the SIA packets are sequenced per neighbour (from 1, no draw) and
 * acknowledged by a hello carrying `ack` (no TLV), unicast. One packet per neighbour is in flight; the next leaves when
 * it is acknowledged. An unacknowledged packet is retransmitted after the RTO (`rtp:<if>:<nbr>`, never periodic):
 * RTO = max(200 ms, 6 × SRTT) capped at 5 s, SRTT measured once from the first acknowledgement (whole ms, at least 1);
 * after 16 retransmissions the neighbour is reset (cause `retry limit exceeded`), and the next attempt waits for a
 * periodic hello, so a peer that never acknowledges never holds `runToIdle` (§4.2). A received reliable packet is
 * acknowledged; a duplicate (seq ≤ the last received) is acknowledged and not processed again. Reliable packets from a
 * `pending` neighbour are processed (the init exchange gates only what this router sends).
 *
 * DUAL (D26, eigrp/dual.ts). A route TLV's reported distance is the metric of the advertised vector; the path metric
 * is the metric of that vector through the receiving interface (its delay added, its bandwidth taken as the minimum).
 * Every input is applied at once, one destination at a time; at the end of the handler (one dispatch) the daemon
 * flushes: `eigrp-topology` rows whose displayed content changed, ONE `ipv4.routes` batch (owner eigrp, source
 * 'EIGRP', AD 90, every destination's successors in (network u32, prefix length) order) when a successor set changed,
 * then per up neighbour (neighbour order: interface canonical order, then address u32) one Update (split horizon:
 * nothing out an interface carrying a successor; poison reverse: the infinite metric where a finite one had been
 * advertised), the queries and the replies. A link going down is handled in ITS dispatch (§3.12 step 3: the feasible
 * successor's batch installs at T); a link coming up and every configuration change arm `resync` (0 ns, coalesced).
 * Stuck in active: `sia:<prefix>` (periodic) sends an SIA-query to every neighbour still awaited at 90 s and resets
 * them at 180 s; an SIA-query is answered with an SIA-reply carrying the current distance, an SIA-reply only resets
 * nothing. `clear ip eigrp neighbors [<address>]` (`eigrp.clear`) resets every neighbour, or those with that address.
 *
 * Tables (rule 20): `eigrp-neighbors` (key `${iface}|${address}`) written at a state change and once when SRTT and RTO
 * are first measured; `eigrp-topology` (key prefix) written when its state, FD or a path list changes. Debug categories
 * (§5.8): `eigrp packets` (one line per packet sent or received), `eigrp fsm` (the `eigrp-nbr` and `eigrp-route`
 * transitions). No randomness (§4.1).
 *
 * stateSnapshot(): `EigrpStateView` (contracts/tables.ts): { process?: { as, routerId, kValues, maximumPaths },
 * neighbors: [{ iface, address, holdUntil, queue, lastSeq }], active: [{ prefix, since, waitingFor }] }.
 *
 * ponytail: no stub, summarisation, variance, redistribution or authentication (C2, C6, P5); load and reliability are
 * constants (D26); updates are not paced (they are split at `EIGRP_ROUTES_PER_PACKET` routes); the router id is
 * display only (no external routes need it).
 */
import { inSubnet, ipv4ToU32, isIpv4, networkOf, type Ipv4Address } from '../contracts/addr.js';
import { ROLE_TRAITS } from '../contracts/catalog.js';
import type { ConfigDelta } from '../contracts/config.js';
import type { PduId, PortId } from '../contracts/ids.js';
import { EIGRP_GROUP, EIGRP_HELLO_S, EIGRP_HOLD_S, EIGRP_INFINITY, IPPROTO_EIGRP, type FieldValue, type Pdu } from '../contracts/pdu.js';
import type { Action, DebugEvent, FsmTransition, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import { AD_EIGRP, routeKey, type EigrpNeighborRow, type EigrpStateView, type EigrpTopologyRow, type RouteRow, type Table } from '../contracts/tables.js';
import { MS, SEC, type SimTime } from '../contracts/time.js';
import { EIGRP_FLAG, EIGRP_OPCODE, eigrpOpcodeText } from '../pdu/codecs/eigrp.js';
import { eigrpInterfaceEnabled, eigrpInterfacePassive, eigrpRouterIdOf, readEigrpInterfaces, readEigrpProcess, type EigrpProcessConfig } from './eigrp/config.js';
import {
  dualEntry,
  dualIsEmpty,
  dualReplyDistance,
  dualSplitHorizon,
  dualStep,
  dualTopologyRow,
  type DualContext,
  type DualEntry,
  type DualInput,
  type DualNeighbor,
} from './eigrp/dual.js';
import {
  EIGRP_DEFAULT_MTU,
  EIGRP_DELAY_UNREACHABLE,
  eigrpBandwidthKbps,
  eigrpConnectedVector,
  eigrpDelayUs,
  eigrpKValuesMatch,
  eigrpMetric,
  eigrpUnreachable,
  eigrpUnreachableVector,
  eigrpVectorThrough,
  type EigrpKValues,
  type EigrpLink,
  type EigrpVector,
} from './eigrp/metric.js';
import { ipRoutingSwitchedOff } from './ipv4.js';

const NAME = 'eigrp';
const DEBUG_RING = 256;

/** Debug category of every packet sent or received (§5.8; `debug eigrp packets`). */
export const EIGRP_DEBUG_PACKETS = 'eigrp packets';
/** Debug category of the neighbour and DUAL transitions (§5.8; `debug eigrp fsm`). */
export const EIGRP_DEBUG_FSM = 'eigrp fsm';
/** Facility of the K-value refusal log. */
export const EIGRP_LOG_FACILITY = 'EIGRP';
/** IP TTL of every EIGRP packet (a link-local protocol). */
export const EIGRP_IP_TTL = 2;
/** DSCP of every EIGRP packet (CS6, the classic TOS 0xc0). */
export const EIGRP_IP_DSCP = 48;
/** RTO bounds (D26): max(200 ms, 6 × SRTT), capped at 5 s. */
export const EIGRP_RTO_MIN_MS = 200;
export const EIGRP_RTO_MAX_MS = 5000;
export const EIGRP_RTO_SRTT_FACTOR = 6;
/** Retransmissions of one reliable packet before the neighbour is reset (D26). */
export const EIGRP_MAX_RETRANSMISSIONS = 16;
/** Stuck in active (D26): an SIA-query at 90 s, the awaited neighbours reset at 180 s. */
export const EIGRP_SIA_QUERY_NS: SimTime = 90 * SEC;
export const EIGRP_SIA_RESET_NS: SimTime = 180 * SEC;
/** Route TLVs per reliable packet (a full table is split so every packet fits a 1500-byte MTU). */
export const EIGRP_ROUTES_PER_PACKET = 40;

/** Causes of the `eigrp-nbr` transitions (original wording). */
export const EIGRP_NEIGHBOR_CAUSE = Object.freeze({
  discovered: 'hello received',
  up: 'init update acknowledged',
  holdExpired: 'hold time expired',
  retryLimit: 'retry limit exceeded',
  interfaceDown: 'interface down',
  interfaceRemoved: 'interface no longer runs EIGRP',
  passive: 'interface became passive',
  kMismatch: 'K-value mismatch',
  restarted: 'peer restarted',
  cleared: 'neighbours cleared',
  sia: 'stuck in active',
  processRemoved: 'EIGRP process removed',
  asChanged: 'autonomous system changed',
  kChanged: 'K values changed',
});

type NbrState = EigrpNeighborRow['state'];

/** One running-or-enabled interface. */
interface Iface {
  readonly port: PortId;
  address: Ipv4Address;
  prefixLen: number;
  /** The connected network, 'a.b.c.d/len'. */
  prefix: string;
  passive: boolean;
  helloS: number;
  holdS: number;
  link: EigrpLink;
  /** Running: the port is up (hellos, neighbours, the connected network in DUAL). */
  up: boolean;
  /** 224.0.0.10 joined on the port. */
  joined: boolean;
}

/** One reliable packet in a neighbour's queue. */
interface Reliable {
  readonly opcode: number;
  readonly flags: number;
  readonly seq: number;
  readonly routes: string;
  readonly count: number;
}

interface Nbr {
  readonly key: string;
  readonly iface: PortId;
  readonly address: Ipv4Address;
  state: NbrState;
  holdS: number;
  holdUntil: SimTime;
  upSince?: SimTime;
  srttMs: number;
  rtoMs: number;
  measured: boolean;
  nextSeq: number;
  lastSeqIn: number;
  queue: Reliable[];
  retries: number;
  sentAt: SimTime;
  initSeq: number;
  /** The init update waits for the hello-reply of its interface. */
  held: boolean;
}

/** One route TLV, parsed. */
interface RouteTlv {
  readonly prefix: string;
  readonly vector: EigrpVector;
}

const nbrKey = (iface: PortId, address: Ipv4Address): string => `${iface}|${address}`;

/** 'a.b.c.d/len' → [network u32, len] (sort key). */
function prefixParts(prefix: string): [number, number] {
  const [a, l] = prefix.split('/');
  return [a !== undefined && isIpv4(a) ? ipv4ToU32(a) : 0, Number(l ?? 0)];
}

/** Prefix order (§4.5): network u32, then prefix length. */
export function eigrpPrefixOrder(a: string, b: string): number {
  const [na, la] = prefixParts(a);
  const [nb, lb] = prefixParts(b);
  return na !== nb ? (na < nb ? -1 : 1) : la - lb;
}

/** One `routes` entry of the eigrp codec for `prefix` and `v` (next hop 0.0.0.0: the sender). */
export function eigrpRouteEntry(prefix: string, v: EigrpVector): string {
  const delay = eigrpUnreachable(v) ? 'inf' : String(v.delayUs);
  return `${prefix},${delay},${v.bwKbps},${v.mtu},${v.hops},${v.reliability},${v.load},0.0.0.0`;
}

/** Parse the codec's `routes` field (entries joined by ';'); malformed entries are skipped. */
export function eigrpParseRoutes(text: string): RouteTlv[] {
  const out: RouteTlv[] = [];
  for (const entry of text.split(';')) {
    const p = entry.split(',');
    if (p.length !== 8) continue;
    const [addr, lenText] = (p[0] ?? '').split('/');
    const len = Number(lenText);
    if (addr === undefined || !isIpv4(addr) || !Number.isInteger(len) || len < 0 || len > 32) continue;
    const nums = p.slice(2, 7).map((x) => Number(x));
    if (nums.some((n) => !Number.isInteger(n) || n < 0)) continue;
    const delayUs = p[1] === 'inf' ? EIGRP_DELAY_UNREACHABLE : Number(p[1]);
    if (!Number.isInteger(delayUs) || delayUs < 0) continue;
    out.push({
      prefix: `${networkOf(addr, len)}/${len}`,
      vector: { delayUs, bwKbps: nums[0]!, mtu: nums[1]!, hops: nums[2]!, reliability: nums[3]!, load: nums[4]! },
    });
  }
  return out;
}

/** The RTO (ms) of a measured SRTT (D26). */
export function eigrpRtoMs(srttMs: number): number {
  return Math.min(EIGRP_RTO_MAX_MS, Math.max(EIGRP_RTO_MIN_MS, EIGRP_RTO_SRTT_FACTOR * srttMs));
}

export function createEigrp(): Process {
  let cfg: EigrpProcessConfig | undefined;
  let routerId: Ipv4Address | undefined;
  const ifaces = new Map<PortId, Iface>();
  const nbrs = new Map<string, Nbr>();
  const topo = new Map<string, DualEntry>();
  /** prefix → neighbour key → the vector the neighbour advertised (before the receiving interface is added). */
  const received = new Map<string, Map<string, EigrpVector>>();
  /** neighbour key → prefix → the distance last sent to that neighbour (update, query or reply). */
  const advertised = new Map<string, Map<string, number>>();
  /** prefix → fingerprint of the last `eigrp-topology` row written. */
  const written = new Map<string, string>();
  /** prefix → when it went active. */
  const activeSince = new Map<string, SimTime>();
  /** K-value refusal episodes (`${iface}|${address}`), one log each. */
  const refused = new Set<string>();
  let lastBatch = '';
  const ring: DebugEvent[] = [];

  // per-dispatch accumulators, emptied by `flush`
  let out: Action[] = [];
  let routesDirty = false;
  const dirty = new Set<string>();
  const fullTable = new Set<string>();
  const queries = new Map<string, string[]>();
  const replies = new Map<string, { prefix: string; distance: number; entry: string }[]>();

  // ── helpers ──

  function record(ctx: ProcessCtx, category: string, message: string, data?: Record<string, unknown>): void {
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: NAME, category, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: NAME, category, message };
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  function debug(ctx: ProcessCtx, category: string, message: string, data?: Record<string, unknown>): void {
    ctx.debug(category, message, data);
    record(ctx, category, message, data);
  }

  function transition(ctx: ProcessCtx, fsm: FsmTransition, message: string): void {
    ctx.transition(EIGRP_DEBUG_FSM, message, fsm);
    record(ctx, EIGRP_DEBUG_FSM, message, { fsm });
  }

  const timer = (key: string, delay: SimTime, periodic = false): Action =>
    periodic ? { type: 'timer', key, delay, periodic: true } : { type: 'timer', key, delay };
  const cancel = (key: string): Action => ({ type: 'cancelTimer', key });
  const nbrTable = (ctx: ProcessCtx): Table<EigrpNeighborRow> | undefined => ctx.tables.get<EigrpNeighborRow>('eigrp-neighbors');
  const topoTable = (ctx: ProcessCtx): Table<EigrpTopologyRow> | undefined => ctx.tables.get<EigrpTopologyRow>('eigrp-topology');
  const kOf = (): EigrpKValues => cfg!.kValues;
  const holdKey = (n: Nbr): string => `hold:${n.iface}:${n.address}`;
  const rtpKey = (n: Nbr): string => `rtp:${n.iface}:${n.address}`;

  /** The canonical port order last seen (the StateView, which has no ctx, sorts by it). */
  let lastPortOrder = new Map<PortId, number>();

  function portOrder(ctx: ProcessCtx): Map<PortId, number> {
    const m = new Map<PortId, number>();
    let i = 0;
    for (const id of ctx.ports.keys()) m.set(id, i++);
    lastPortOrder = m;
    return m;
  }

  /** Neighbours in neighbour order (§4.5): interface canonical order, then address u32. */
  function byNeighborOrder(list: Nbr[], order: Map<PortId, number>): Nbr[] {
    return list.sort((a, b) => {
      const ia = order.get(a.iface) ?? Number.MAX_SAFE_INTEGER;
      const ib = order.get(b.iface) ?? Number.MAX_SAFE_INTEGER;
      if (ia !== ib) return ia - ib;
      return ipv4ToU32(a.address) - ipv4ToU32(b.address);
    });
  }

  /** Neighbours in neighbour order, optionally only the up ones. */
  function sortedNbrs(ctx: ProcessCtx, upOnly: boolean): Nbr[] {
    return byNeighborOrder([...nbrs.values()].filter((n) => !upOnly || n.state === 'up'), portOrder(ctx));
  }

  function dualContext(ctx: ProcessCtx): DualContext {
    return { maximumPaths: cfg?.maximumPaths ?? 4, neighbors: sortedNbrs(ctx, true).map((n): DualNeighbor => ({ iface: n.iface, address: n.address })) };
  }

  // ── sending ──

  function send(ctx: ProcessCtx, iface: Iface, dst: Ipv4Address, fields: Record<string, FieldValue>, tag: string, background: boolean, what: string, triggeredBy?: PduId): void {
    const pdu = ctx.newPdu(
      [
        { proto: 'ipv4', fields: { src: iface.address, dst, protocol: IPPROTO_EIGRP, ttl: EIGRP_IP_TTL, dscp: EIGRP_IP_DSCP } },
        { proto: 'eigrp', fields },
      ],
      { tag, flow: `ipv4:${iface.address}>${dst}:eigrp`, ...(background ? { background: true } : {}), ...(triggeredBy !== undefined ? { triggeredBy } : {}) },
    );
    debug(ctx, EIGRP_DEBUG_PACKETS, `sent ${what} to ${dst} on ${iface.port}`, { pdu: pdu.id, port: iface.port, dst, opcode: fields.opcode });
    const req: ProcessRequest = dst === EIGRP_GROUP ? { kind: 'ipv4.send', pdu, iface: iface.port } : { kind: 'ipv4.send', pdu, iface: iface.port, nextHop: dst };
    out.push({ type: 'request', to: 'ipv4', req });
  }

  function sendHello(ctx: ProcessCtx, iface: Iface, reason: string): void {
    send(
      ctx,
      iface,
      EIGRP_GROUP,
      { opcode: EIGRP_OPCODE.hello, flags: 0, seq: 0, ack: 0, as: cfg!.as, kValues: kOf().join(','), holdS: iface.holdS },
      'eigrp-hello',
      true,
      `hello (AS ${cfg!.as}, hold ${iface.holdS} s${reason !== '' ? `, ${reason}` : ''})`,
    );
  }

  function sendAck(ctx: ProcessCtx, nbr: Nbr, seq: number, triggeredBy: PduId): void {
    const iface = ifaces.get(nbr.iface);
    if (iface === undefined) return;
    send(ctx, iface, nbr.address, { opcode: EIGRP_OPCODE.hello, flags: 0, seq: 0, ack: seq, as: cfg!.as }, 'eigrp-ack', true, `acknowledgement of seq ${seq}`, triggeredBy);
  }

  function flagsText(flags: number): string {
    const f: string[] = [];
    if (flags & EIGRP_FLAG.init) f.push('init');
    if (flags & EIGRP_FLAG.eot) f.push('EOT');
    return f.length > 0 ? `, ${f.join(' ')}` : '';
  }

  function transmitHead(ctx: ProcessCtx, nbr: Nbr): void {
    const head = nbr.queue[0];
    const iface = ifaces.get(nbr.iface);
    if (head === undefined || iface === undefined || nbr.held) return;
    nbr.sentAt = ctx.now;
    const fields: Record<string, FieldValue> = { opcode: head.opcode, flags: head.flags, seq: head.seq, ack: 0, as: cfg!.as };
    if (head.routes !== '') fields.routes = head.routes;
    const tag = `eigrp-${eigrpOpcodeText(head.opcode).replace(/ /g, '-').toLowerCase()}`;
    const retry = nbr.retries > 0 ? `, retransmission ${nbr.retries} of ${EIGRP_MAX_RETRANSMISSIONS}` : '';
    send(ctx, iface, nbr.address, fields, tag, false, `${eigrpOpcodeText(head.opcode)} seq ${head.seq}${flagsText(head.flags)}, ${head.count} ${head.count === 1 ? 'route' : 'routes'}${retry}`);
    out.push(timer(rtpKey(nbr), nbr.rtoMs * MS));
  }

  function enqueue(ctx: ProcessCtx, nbr: Nbr, opcode: number, flags: number, entries: readonly string[]): void {
    const pkt: Reliable = { opcode, flags, seq: nbr.nextSeq, routes: entries.join(';'), count: entries.length };
    nbr.nextSeq = nbr.nextSeq >= 0xffff_ffff ? 1 : nbr.nextSeq + 1;
    nbr.queue.push(pkt);
    if (nbr.queue.length === 1) transmitHead(ctx, nbr);
  }

  /** Queue `entries` as packets of `opcode`, split at EIGRP_ROUTES_PER_PACKET; `lastFlags` on the last one. */
  function enqueueRoutes(ctx: ProcessCtx, nbr: Nbr, opcode: number, entries: readonly string[], lastFlags: number): void {
    for (let i = 0; i < entries.length; i += EIGRP_ROUTES_PER_PACKET) {
      const chunk = entries.slice(i, i + EIGRP_ROUTES_PER_PACKET);
      enqueue(ctx, nbr, opcode, i + EIGRP_ROUTES_PER_PACKET >= entries.length ? lastFlags : 0, chunk);
    }
  }

  // ── neighbours ──

  function writeNbrRow(ctx: ProcessCtx, n: Nbr): void {
    const row: EigrpNeighborRow = {
      key: n.key,
      iface: n.iface,
      address: n.address,
      as: cfg!.as,
      state: n.state,
      holdS: n.holdS,
      srttMs: n.srttMs,
      rtoMs: n.rtoMs,
      updatedAt: ctx.now,
    };
    if (n.upSince !== undefined) row.upSince = n.upSince;
    nbrTable(ctx)?.set(row);
  }

  function nbrTransition(ctx: ProcessCtx, n: Nbr, from: NbrState | 'down', to: NbrState | 'down', cause: string, pdu?: PduId): void {
    const subject = `${n.iface} ${n.address}`;
    const fsm: FsmTransition = { machine: 'eigrp-nbr', subject, port: n.iface, from, to, cause, ...(pdu !== undefined ? { pdu } : {}) };
    transition(ctx, fsm, `neighbour ${n.address} (${n.iface}): ${from} -> ${to} (${cause})`);
  }

  function touchHold(n: Nbr, now: SimTime): void {
    n.holdUntil = now + n.holdS * SEC;
    out.push(timer(holdKey(n), n.holdS * SEC, true));
  }

  function createNeighbor(ctx: ProcessCtx, iface: Iface, address: Ipv4Address, holdS: number, held: boolean, pdu?: PduId): Nbr {
    const n: Nbr = {
      key: nbrKey(iface.port, address),
      iface: iface.port,
      address,
      state: 'pending',
      holdS,
      holdUntil: ctx.now + holdS * SEC,
      srttMs: 0,
      rtoMs: EIGRP_RTO_MIN_MS,
      measured: false,
      nextSeq: 1,
      lastSeqIn: 0,
      queue: [],
      retries: 0,
      sentAt: ctx.now,
      initSeq: 1,
      held,
    };
    nbrs.set(n.key, n);
    nbrTransition(ctx, n, 'down', 'pending', EIGRP_NEIGHBOR_CAUSE.discovered, pdu);
    writeNbrRow(ctx, n);
    touchHold(n, ctx.now);
    if (held) out.push(timer(`hello-reply:${iface.port}`, 0));
    enqueue(ctx, n, EIGRP_OPCODE.update, EIGRP_FLAG.init, []);
    return n;
  }

  function neighborUp(ctx: ProcessCtx, n: Nbr, pdu?: PduId): void {
    n.state = 'up';
    n.upSince = ctx.now;
    nbrTransition(ctx, n, 'pending', 'up', EIGRP_NEIGHBOR_CAUSE.up, pdu);
    writeNbrRow(ctx, n);
    fullTable.add(n.key);
  }

  /** Reset a neighbour: its row, timers, queue and paths go (a neighbour that goes down counts as a reply). */
  function neighborDown(ctx: ProcessCtx, n: Nbr, cause: string, reason: 'aged' | 'cleared' | 'link-down' = 'cleared'): void {
    if (nbrs.get(n.key) !== n) return;
    nbrs.delete(n.key);
    nbrTransition(ctx, n, n.state, 'down', cause);
    nbrTable(ctx)?.delete(n.key, reason);
    out.push(cancel(holdKey(n)), cancel(rtpKey(n)));
    advertised.delete(n.key);
    fullTable.delete(n.key);
    queries.delete(n.key);
    replies.delete(n.key);
    const gone: DualNeighbor = { iface: n.iface, address: n.address };
    for (const prefix of [...topo.keys()].sort(eigrpPrefixOrder)) {
      received.get(prefix)?.delete(n.key);
      step(ctx, prefix, { kind: 'neighbor-down', neighbor: gone });
    }
  }

  // ── DUAL ──

  function linkOf(iface: PortId): EigrpLink | undefined {
    return ifaces.get(iface)?.link;
  }

  /** The vector this router advertises for `entry` (connected, the first successor's, or unreachable). */
  function vectorOf(entry: DualEntry | undefined): EigrpVector {
    if (entry === undefined) return eigrpUnreachableVector();
    if (entry.connected !== undefined) {
      const link = linkOf(entry.connected.iface);
      return link !== undefined ? eigrpConnectedVector(link) : eigrpUnreachableVector();
    }
    const s = entry.successors[0];
    if (s === undefined) return eigrpUnreachableVector();
    const v = received.get(entry.prefix)?.get(nbrKey(s.iface, s.nextHop));
    const link = linkOf(s.iface);
    return v !== undefined && link !== undefined ? eigrpVectorThrough(v, link) : eigrpUnreachableVector();
  }

  function entryFor(prefix: string, distance: number): string {
    return eigrpRouteEntry(prefix, distance >= EIGRP_INFINITY ? eigrpUnreachableVector() : vectorOf(topo.get(prefix)));
  }

  function step(ctx: ProcessCtx, prefix: string, input: DualInput): void {
    const before = topo.get(prefix) ?? dualEntry(prefix);
    const o = dualStep(before, input, dualContext(ctx));
    const e = o.entry;
    if (dualIsEmpty(e)) {
      topo.delete(prefix);
      received.delete(prefix);
    } else topo.set(prefix, e);
    dirty.add(prefix);
    if (o.routesChanged) routesDirty = true;
    if (o.transition !== undefined) {
      const t = o.transition;
      const fsm: FsmTransition = { machine: 'eigrp-route', subject: prefix, from: t.from, to: t.to, cause: t.cause };
      const detail = e.state === 'passive' && e.fd < EIGRP_INFINITY ? `, FD ${e.fd}` : e.state === 'active' ? `, querying ${e.waiting.length}` : '';
      transition(ctx, fsm, `route ${prefix}: ${t.from} -> ${t.to} (${t.cause}${detail})`);
      if (t.to === 'active' && t.from === 'passive') {
        activeSince.set(prefix, ctx.now);
        out.push(timer(`sia:${prefix}`, EIGRP_SIA_QUERY_NS, true));
      } else if (t.to === 'passive' && t.from === 'active') {
        activeSince.delete(prefix);
        out.push(cancel(`sia:${prefix}`));
      }
    }
    for (const q of o.queries) {
      const k = nbrKey(q.iface, q.address);
      const list = queries.get(k) ?? [];
      if (!list.includes(prefix)) list.push(prefix);
      queries.set(k, list);
    }
    for (const r of o.replies) {
      const k = nbrKey(r.to.iface, r.to.address);
      const list = (replies.get(k) ?? []).filter((x) => x.prefix !== prefix);
      list.push({ prefix, distance: r.distance, entry: entryFor(prefix, r.distance) });
      replies.set(k, list);
    }
  }

  /** The `ipv4.routes` rows: every destination's successors, prefix order (connected networks excluded). */
  function routeRows(ctx: ProcessCtx): RouteRow[] {
    const rows: RouteRow[] = [];
    for (const prefix of [...topo.keys()].sort(eigrpPrefixOrder)) {
      const e = topo.get(prefix)!;
      if (e.connected !== undefined) continue;
      const [network, prefixLen] = prefix.split('/') as [string, string];
      for (const s of e.successors) {
        rows.push({ key: routeKey(network, Number(prefixLen)), network, prefixLen: Number(prefixLen), source: 'EIGRP', nextHop: s.nextHop, iface: s.iface, ad: AD_EIGRP, metric: s.metric, updatedAt: ctx.now });
      }
    }
    return rows;
  }

  function writeTopologyRow(ctx: ProcessCtx, prefix: string): void {
    const t = topoTable(ctx);
    const e = topo.get(prefix);
    if (e === undefined) {
      if (written.delete(prefix)) t?.delete(prefix, 'cleared');
      return;
    }
    const row = dualTopologyRow(e, ctx.now);
    const { updatedAt: _u, ...shown } = row;
    const fp = JSON.stringify(shown);
    if (written.get(prefix) === fp) return;
    written.set(prefix, fp);
    t?.set(row);
  }

  /** The distance to advertise to `n` for `prefix`, or undefined for nothing to send (D26 split horizon, poison reverse). */
  function desiredAdvert(n: Nbr, prefix: string): number | undefined {
    const e = topo.get(prefix);
    const prev = advertised.get(n.key)?.get(prefix);
    if (e?.state === 'active') return undefined;
    const finiteBefore = prev !== undefined && prev < EIGRP_INFINITY;
    let want: number | undefined;
    if (e === undefined || e.distance >= EIGRP_INFINITY || dualSplitHorizon(e, n.iface)) want = finiteBefore ? EIGRP_INFINITY : undefined;
    else want = e.distance;
    return want === undefined || want === prev ? undefined : want;
  }

  function remember(n: Nbr, prefix: string, distance: number): void {
    let m = advertised.get(n.key);
    if (m === undefined) {
      m = new Map();
      advertised.set(n.key, m);
    }
    m.set(prefix, distance);
  }

  /** Emit what this dispatch decided: rows, one route batch, then per up neighbour its update, queries and replies. */
  function flush(ctx: ProcessCtx): Action[] {
    if (cfg !== undefined || dirty.size > 0 || routesDirty) {
      for (const prefix of [...dirty].sort(eigrpPrefixOrder)) writeTopologyRow(ctx, prefix);
      if (routesDirty) {
        const rows = routeRows(ctx);
        const fp = JSON.stringify(rows.map((r) => [r.key, r.nextHop, r.iface, r.metric]));
        if (fp !== lastBatch) {
          lastBatch = fp;
          out.push({ type: 'request', to: 'ipv4', req: { kind: 'ipv4.routes', owner: NAME, rows } });
        }
      }
      if (cfg !== undefined) {
        for (const n of sortedNbrs(ctx, true)) {
          const full = fullTable.has(n.key);
          const candidates = full ? new Set([...topo.keys(), ...(advertised.get(n.key)?.keys() ?? [])]) : dirty;
          const updates: string[] = [];
          for (const prefix of [...candidates].sort(eigrpPrefixOrder)) {
            const want = desiredAdvert(n, prefix);
            if (want === undefined) continue;
            remember(n, prefix, want);
            updates.push(entryFor(prefix, want));
          }
          if (updates.length > 0) enqueueRoutes(ctx, n, EIGRP_OPCODE.update, updates, full ? EIGRP_FLAG.eot : 0);
          const qs: string[] = [];
          for (const prefix of (queries.get(n.key) ?? []).sort(eigrpPrefixOrder)) {
            const e = topo.get(prefix);
            if (e === undefined || e.state !== 'active' || !e.waiting.some((w) => w.iface === n.iface && w.address === n.address)) continue;
            const d = dualReplyDistance(e, n.iface);
            remember(n, prefix, d);
            qs.push(entryFor(prefix, d));
          }
          if (qs.length > 0) enqueueRoutes(ctx, n, EIGRP_OPCODE.query, qs, 0);
          const rs = (replies.get(n.key) ?? []).sort((a, b) => eigrpPrefixOrder(a.prefix, b.prefix));
          for (const r of rs) remember(n, r.prefix, r.distance);
          if (rs.length > 0) enqueueRoutes(ctx, n, EIGRP_OPCODE.reply, rs.map((r) => r.entry), 0);
        }
      }
    }
    dirty.clear();
    routesDirty = false;
    fullTable.clear();
    queries.clear();
    replies.clear();
    const actions = out;
    out = [];
    return actions;
  }

  // ── interfaces ──

  /** The interfaces that run EIGRP under `c` (an address matched by a network line), in port order. */
  function desiredInterfaces(ctx: ProcessCtx, c: EigrpProcessConfig): Map<PortId, Omit<Iface, 'joined'>> {
    const lines = readEigrpInterfaces(ctx.config.root, c.as);
    const want = new Map<PortId, Omit<Iface, 'joined'>>();
    for (const [id, port] of ctx.ports) {
      if (!ROLE_TRAITS[port.role]?.l3) continue;
      const v4 = port.l3.ipv4;
      if (v4 === undefined || !eigrpInterfaceEnabled(c, v4.address)) continue;
      const l = lines.get(id);
      const info = { kind: port.spec.kind, role: port.role, speedBps: port.speedBps ?? port.spec.speedBps };
      const link: EigrpLink = { delayUs: eigrpDelayUs(info, l?.delayTens), bwKbps: eigrpBandwidthKbps(info, l?.bandwidthKbps), mtu: port.mtu > 0 ? port.mtu : EIGRP_DEFAULT_MTU };
      want.set(id, {
        port: id,
        address: v4.address,
        prefixLen: v4.prefixLen,
        prefix: `${networkOf(v4.address, v4.prefixLen)}/${v4.prefixLen}`,
        // a loopback has no neighbour to greet: its network is advertised, nothing is sent on it
        passive: eigrpInterfacePassive(c, id) || port.role === 'virtual',
        helloS: l?.helloS ?? EIGRP_HELLO_S,
        holdS: l?.holdS ?? EIGRP_HOLD_S,
        link,
        up: port.adminUp && port.operUp,
      });
    }
    return want;
  }

  function connectedMetric(i: Iface): number {
    return eigrpMetric(eigrpConnectedVector(i.link), kOf());
  }

  function bringUp(ctx: ProcessCtx, i: Iface): void {
    i.up = true;
    debug(ctx, EIGRP_DEBUG_FSM, `interface ${i.port} ${i.prefix} runs EIGRP${i.passive ? ' (passive)' : ''}`, { port: i.port, prefix: i.prefix });
    step(ctx, i.prefix, { kind: 'connected', iface: i.port, metric: connectedMetric(i) });
    if (i.passive) return;
    if (!i.joined) {
      i.joined = true;
      out.push({ type: 'request', to: 'ipv4', req: { kind: 'ipv4.group', op: 'join', iface: i.port, group: EIGRP_GROUP, owner: NAME } });
    }
    sendHello(ctx, i, 'interface up');
    out.push(timer(`hello:${i.port}`, i.helloS * SEC, true));
  }

  function bringDown(ctx: ProcessCtx, i: Iface, cause: string, leave: boolean): void {
    if (i.up) {
      i.up = false;
      for (const n of sortedNbrs(ctx, false)) if (n.iface === i.port) neighborDown(ctx, n, cause, cause === EIGRP_NEIGHBOR_CAUSE.interfaceDown ? 'link-down' : 'cleared');
      step(ctx, i.prefix, { kind: 'connected-down' });
      out.push(cancel(`hello:${i.port}`), cancel(`hello-reply:${i.port}`));
      for (const k of [...refused]) if (k.startsWith(`${i.port}|`)) refused.delete(k);
      debug(ctx, EIGRP_DEBUG_FSM, `interface ${i.port} ${i.prefix} stopped running EIGRP (${cause})`, { port: i.port, prefix: i.prefix });
    }
    if (leave && i.joined) {
      i.joined = false;
      out.push({ type: 'request', to: 'ipv4', req: { kind: 'ipv4.group', op: 'leave', iface: i.port, group: EIGRP_GROUP, owner: NAME } });
    }
  }

  /** The interface's delay or bandwidth changed: its connected metric and every path learned on it. */
  function relink(ctx: ProcessCtx, i: Iface): void {
    step(ctx, i.prefix, { kind: 'connected', iface: i.port, metric: connectedMetric(i) });
    for (const prefix of [...received.keys()].sort(eigrpPrefixOrder)) {
      for (const n of sortedNbrs(ctx, false)) {
        if (n.iface !== i.port) continue;
        const v = received.get(prefix)?.get(n.key);
        if (v === undefined) continue;
        step(ctx, prefix, { kind: 'update', from: { iface: n.iface, address: n.address }, rd: eigrpMetric(v, kOf()), metric: eigrpMetric(eigrpVectorThrough(v, i.link), kOf()) });
      }
    }
  }

  /** Tear the whole process down (removal, a new AS or new K values). */
  function stop(ctx: ProcessCtx, cause: string): void {
    for (const n of sortedNbrs(ctx, false)) {
      nbrs.delete(n.key);
      nbrTransition(ctx, n, n.state, 'down', cause);
      nbrTable(ctx)?.delete(n.key, 'cleared');
      out.push(cancel(holdKey(n)), cancel(rtpKey(n)));
    }
    for (const i of ifaces.values()) {
      out.push(cancel(`hello:${i.port}`), cancel(`hello-reply:${i.port}`));
      if (i.joined) out.push({ type: 'request', to: 'ipv4', req: { kind: 'ipv4.group', op: 'leave', iface: i.port, group: EIGRP_GROUP, owner: NAME } });
    }
    for (const prefix of [...written.keys()].sort(eigrpPrefixOrder)) topoTable(ctx)?.delete(prefix, 'cleared');
    for (const prefix of activeSince.keys()) out.push(cancel(`sia:${prefix}`));
    if (lastBatch !== '' && lastBatch !== '[]') out.push({ type: 'request', to: 'ipv4', req: { kind: 'ipv4.routes', owner: NAME, rows: [] } });
    lastBatch = '';
    ifaces.clear();
    topo.clear();
    received.clear();
    advertised.clear();
    written.clear();
    activeSince.clear();
    refused.clear();
    dirty.clear();
    routesDirty = false;
    fullTable.clear();
    queries.clear();
    replies.clear();
    debug(ctx, EIGRP_DEBUG_FSM, `EIGRP AS ${cfg?.as ?? '?'} stopped (${cause})`);
    cfg = undefined;
    routerId = undefined;
  }

  function runningConfig(ctx: ProcessCtx): EigrpProcessConfig | undefined {
    if (!ctx.model.ipForwarding || ipRoutingSwitchedOff(ctx)) return undefined;
    return readEigrpProcess(ctx.config.root);
  }

  function computeRouterId(ctx: ProcessCtx, c: EigrpProcessConfig): Ipv4Address | undefined {
    const candidates = [...ctx.ports.values()]
      .filter((p) => p.l3.ipv4 !== undefined)
      .map((p) => ({ address: p.l3.ipv4!.address, loopback: p.role === 'virtual', up: p.adminUp && p.operUp }));
    return eigrpRouterIdOf(c, candidates);
  }

  /** Re-read the configuration and the ports; bring interfaces up and down (the `resync` timer). */
  function resync(ctx: ProcessCtx): void {
    const next = runningConfig(ctx);
    if (next === undefined) {
      if (cfg !== undefined) stop(ctx, EIGRP_NEIGHBOR_CAUSE.processRemoved);
      return;
    }
    if (cfg !== undefined && cfg.as !== next.as) stop(ctx, EIGRP_NEIGHBOR_CAUSE.asChanged);
    else if (cfg !== undefined && !eigrpKValuesMatch(cfg.kValues, next.kValues)) stop(ctx, EIGRP_NEIGHBOR_CAUSE.kChanged);
    const starting = cfg === undefined;
    const prevMaxPaths = cfg?.maximumPaths;
    cfg = next;
    if (starting) {
      routerId = undefined;
      debug(ctx, EIGRP_DEBUG_FSM, `EIGRP AS ${next.as} started (K values ${next.kValues.join(' ')})`, { as: next.as });
    }
    if (next.routerId !== undefined || routerId === undefined) routerId = computeRouterId(ctx, next);
    const want = desiredInterfaces(ctx, next);
    for (const [port, cur] of [...ifaces]) {
      const d = want.get(port);
      const same = d !== undefined && d.prefix === cur.prefix && d.address === cur.address;
      if (!same) {
        bringDown(ctx, cur, d === undefined ? EIGRP_NEIGHBOR_CAUSE.interfaceRemoved : EIGRP_NEIGHBOR_CAUSE.interfaceDown, true);
        ifaces.delete(port);
        continue;
      }
      if (cur.up && !d.up) bringDown(ctx, cur, EIGRP_NEIGHBOR_CAUSE.interfaceDown, false);
      else if (cur.up && d.passive !== cur.passive) bringDown(ctx, cur, EIGRP_NEIGHBOR_CAUSE.passive, d.passive);
    }
    for (const [port, d] of want) {
      let cur = ifaces.get(port);
      let relinked = false;
      let helloChanged = false;
      if (cur === undefined) {
        cur = { ...d, up: false, joined: false };
        ifaces.set(port, cur);
      } else {
        relinked = cur.link.delayUs !== d.link.delayUs || cur.link.bwKbps !== d.link.bwKbps || cur.link.mtu !== d.link.mtu;
        helloChanged = cur.helloS !== d.helloS;
        cur.passive = d.passive;
        cur.helloS = d.helloS;
        cur.holdS = d.holdS;
        cur.link = d.link;
        if (cur.passive && cur.joined && !cur.up) {
          cur.joined = false;
          out.push({ type: 'request', to: 'ipv4', req: { kind: 'ipv4.group', op: 'leave', iface: port, group: EIGRP_GROUP, owner: NAME } });
        }
      }
      if (d.up && !cur.up) bringUp(ctx, cur);
      else if (cur.up) {
        if (relinked) relink(ctx, cur);
        if (helloChanged && !cur.passive) out.push(timer(`hello:${port}`, cur.helloS * SEC, true));
      }
    }
    if (prevMaxPaths !== undefined && prevMaxPaths !== next.maximumPaths) {
      for (const prefix of [...topo.keys()].sort(eigrpPrefixOrder)) step(ctx, prefix, { kind: 'recompute' });
    }
  }

  // ── receiving ──

  function drop(pdu: Pdu, detail: string, port: PortId, reason: 'other' | 'unsupported-protocol' | 'bad-checksum' = 'other'): Action {
    return { type: 'drop', pdu, reason, detail, port };
  }

  function onAck(ctx: ProcessCtx, n: Nbr, ack: number, pdu: PduId): void {
    const head = n.queue[0];
    if (head === undefined || head.seq !== ack) return;
    n.queue.shift();
    n.retries = 0;
    out.push(cancel(rtpKey(n)));
    let rewrite = false;
    if (!n.measured) {
      n.measured = true;
      n.srttMs = Math.max(1, Math.ceil((ctx.now - n.sentAt) / MS));
      n.rtoMs = eigrpRtoMs(n.srttMs);
      rewrite = true;
    }
    if (head.seq === n.initSeq && head.flags & EIGRP_FLAG.init && n.state === 'pending') neighborUp(ctx, n, pdu);
    else if (rewrite) writeNbrRow(ctx, n);
    if (n.queue.length > 0) transmitHead(ctx, n);
  }

  function onHello(ctx: ProcessCtx, i: Iface, src: Ipv4Address, f: Readonly<Record<string, FieldValue>>, pdu: Pdu): Action {
    const key = nbrKey(i.port, src);
    const ack = typeof f.ack === 'number' ? f.ack : 0;
    let n = nbrs.get(key);
    if (f.kValues === undefined || f.kValues === null) {
      // an acknowledgement: a hello without the parameter TLV
      if (n === undefined) return drop(pdu, `acknowledgement from ${src}, which is not an EIGRP neighbour on ${i.port}`, i.port);
      touchHold(n, ctx.now);
      if (ack !== 0) onAck(ctx, n, ack, pdu.id);
      return { type: 'consume', pdu };
    }
    const theirs = String(f.kValues).split(',').map((x) => Number(x));
    const holdS = typeof f.holdS === 'number' && f.holdS > 0 ? f.holdS : EIGRP_HOLD_S;
    if (theirs.length !== 5 || !eigrpKValuesMatch(kOf(), theirs as unknown as EigrpKValues)) {
      if (n !== undefined) neighborDown(ctx, n, EIGRP_NEIGHBOR_CAUSE.kMismatch);
      if (!refused.has(key)) {
        refused.add(key);
        out.push({ type: 'log', severity: 5, facility: EIGRP_LOG_FACILITY, message: `EIGRP ${cfg!.as}: neighbour ${src} (${i.port}) refused: K-value mismatch (theirs ${theirs.join(' ')}, ours ${kOf().join(' ')})` });
      }
      debug(ctx, EIGRP_DEBUG_PACKETS, `refused hello from ${src} on ${i.port}: K-value mismatch`, { port: i.port, src });
      return drop(pdu, `K-value mismatch with ${src}: theirs ${theirs.join(' ')}, ours ${kOf().join(' ')}`, i.port);
    }
    refused.delete(key);
    if (n === undefined) n = createNeighbor(ctx, i, src, holdS, true, pdu.id);
    else {
      if (n.holdS !== holdS) {
        n.holdS = holdS;
        writeNbrRow(ctx, n);
      }
      touchHold(n, ctx.now);
    }
    if (ack !== 0) onAck(ctx, n, ack, pdu.id);
    return { type: 'consume', pdu };
  }

  function onReliable(ctx: ProcessCtx, i: Iface, src: Ipv4Address, f: Readonly<Record<string, FieldValue>>, opcode: number, pdu: Pdu): Action {
    const key = nbrKey(i.port, src);
    let n = nbrs.get(key);
    if (n === undefined) return drop(pdu, `${eigrpOpcodeText(opcode)} from ${src}, which is not an EIGRP neighbour on ${i.port}`, i.port);
    touchHold(n, ctx.now);
    const ack = typeof f.ack === 'number' ? f.ack : 0;
    const seq = typeof f.seq === 'number' ? f.seq : 0;
    const flags = typeof f.flags === 'number' ? f.flags : 0;
    if (ack !== 0) onAck(ctx, n, ack, pdu.id);
    if (opcode === EIGRP_OPCODE.update && flags & EIGRP_FLAG.init && n.state === 'up') {
      // the peer restarted: reset, then form again at once (it already knows this router)
      const holdS = n.holdS;
      neighborDown(ctx, n, EIGRP_NEIGHBOR_CAUSE.restarted);
      n = createNeighbor(ctx, i, src, holdS, false, pdu.id);
    }
    if (seq !== 0) {
      sendAck(ctx, n, seq, pdu.id);
      if (seq <= n.lastSeqIn && n.lastSeqIn - seq < 0x8000_0000) {
        debug(ctx, EIGRP_DEBUG_PACKETS, `duplicate ${eigrpOpcodeText(opcode)} seq ${seq} from ${src} acknowledged again`, { port: i.port, src, seq });
        return { type: 'consume', pdu };
      }
      n.lastSeqIn = seq;
    }
    const routes = typeof f.routes === 'string' && f.routes !== '' ? eigrpParseRoutes(f.routes) : [];
    if (opcode === EIGRP_OPCODE.siaQuery) {
      const list: { prefix: string; distance: number; entry: string }[] = [];
      for (const r of routes) {
        const e = topo.get(r.prefix);
        const d = e === undefined ? EIGRP_INFINITY : dualReplyDistance(e, n.iface);
        list.push({ prefix: r.prefix, distance: d, entry: entryFor(r.prefix, d) });
      }
      // the SIA-reply goes out as its own packet (opcode 11), not through DUAL
      if (list.length > 0) {
        for (const r of list) remember(n, r.prefix, r.distance);
        enqueueRoutes(ctx, n, EIGRP_OPCODE.siaReply, list.map((r) => r.entry), 0);
      }
      return { type: 'consume', pdu };
    }
    if (opcode === EIGRP_OPCODE.siaReply) return { type: 'consume', pdu };
    const from: DualNeighbor = { iface: n.iface, address: n.address };
    const kind = opcode === EIGRP_OPCODE.query ? 'query' : opcode === EIGRP_OPCODE.reply ? 'reply' : 'update';
    for (const r of routes) {
      const rd = eigrpMetric(r.vector, kOf());
      const metric = rd >= EIGRP_INFINITY ? EIGRP_INFINITY : eigrpMetric(eigrpVectorThrough(r.vector, i.link), kOf());
      let m = received.get(r.prefix);
      if (metric >= EIGRP_INFINITY) m?.delete(n.key);
      else {
        if (m === undefined) {
          m = new Map();
          received.set(r.prefix, m);
        }
        m.set(n.key, r.vector);
      }
      step(ctx, r.prefix, { kind, from, rd, metric });
    }
    return { type: 'consume', pdu };
  }

  function receive(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action {
    const ip = pdu.layer('ipv4');
    const e = pdu.layer('eigrp');
    if (ip === undefined || e === undefined) return drop(pdu, 'not an EIGRP packet', port, 'unsupported-protocol');
    const src = String(ip.fields.src);
    if (cfg === undefined) return drop(pdu, 'EIGRP is not running on this device', port, 'unsupported-protocol');
    if (e.fields.checksumValid === false) return drop(pdu, 'EIGRP checksum mismatch', port, 'bad-checksum');
    const opcode = typeof e.fields.opcode === 'number' ? e.fields.opcode : -1;
    const as = typeof e.fields.as === 'number' ? e.fields.as : -1;
    if (!isIpv4(src) || ctx.ownAddress(src) !== undefined) return drop(pdu, `EIGRP packet from this device's own address ${src}`, port);
    if (as !== cfg.as) {
      debug(ctx, EIGRP_DEBUG_PACKETS, `ignored ${eigrpOpcodeText(opcode)} from ${src} on ${port}: AS ${as}, this router runs AS ${cfg.as}`, { port, src, as });
      return drop(pdu, `EIGRP ${eigrpOpcodeText(opcode)} for AS ${as} ignored: this router runs AS ${cfg.as}`, port);
    }
    const i = ifaces.get(port);
    if (i === undefined || !i.up) return drop(pdu, `EIGRP is not running on ${port}`, port);
    if (i.passive) return drop(pdu, `${port} is a passive EIGRP interface`, port);
    if (!inSubnet(src, i.address, i.prefixLen)) return drop(pdu, `${src} is not on the subnet of ${port}`, port);
    const seq = typeof e.fields.seq === 'number' ? e.fields.seq : 0;
    const ack = typeof e.fields.ack === 'number' ? e.fields.ack : 0;
    const flags = typeof e.fields.flags === 'number' ? e.fields.flags : 0;
    const count = typeof e.fields.routes === 'string' && e.fields.routes !== '' ? e.fields.routes.split(';').length : 0;
    const what =
      opcode === EIGRP_OPCODE.hello
        ? e.fields.kValues === undefined
          ? `acknowledgement of seq ${ack}`
          : `hello (hold ${String(e.fields.holdS ?? '?')} s)`
        : `${eigrpOpcodeText(opcode)} seq ${seq}${flagsText(flags)}, ${count} ${count === 1 ? 'route' : 'routes'}`;
    debug(ctx, EIGRP_DEBUG_PACKETS, `received ${what} from ${src} on ${port}`, { pdu: pdu.id, port, src, opcode });
    switch (opcode) {
      case EIGRP_OPCODE.hello:
        return onHello(ctx, i, src, e.fields, pdu);
      case EIGRP_OPCODE.update:
      case EIGRP_OPCODE.query:
      case EIGRP_OPCODE.reply:
      case EIGRP_OPCODE.siaQuery:
      case EIGRP_OPCODE.siaReply:
        return onReliable(ctx, i, src, e.fields, opcode, pdu);
      default:
        return drop(pdu, `EIGRP opcode ${opcode} is not simulated`, port, 'unsupported-protocol');
    }
  }

  // ── timers ──

  function onTimerKey(ctx: ProcessCtx, key: string): void {
    if (key === 'resync') {
      resync(ctx);
      return;
    }
    if (cfg === undefined) return;
    const colon = key.indexOf(':');
    const kind = colon < 0 ? key : key.slice(0, colon);
    const rest = colon < 0 ? '' : key.slice(colon + 1);
    switch (kind) {
      case 'hello': {
        const i = ifaces.get(rest);
        if (i === undefined || !i.up || i.passive) return;
        sendHello(ctx, i, '');
        out.push(timer(`hello:${i.port}`, i.helloS * SEC, true));
        return;
      }
      case 'hello-reply': {
        const i = ifaces.get(rest);
        if (i === undefined || !i.up || i.passive) return;
        sendHello(ctx, i, 'reply to a new neighbour');
        for (const n of sortedNbrs(ctx, false)) {
          if (n.iface !== i.port || !n.held) continue;
          n.held = false;
          transmitHead(ctx, n);
        }
        return;
      }
      case 'hold':
      case 'rtp': {
        const at = rest.lastIndexOf(':');
        const n = nbrs.get(nbrKey(rest.slice(0, at), rest.slice(at + 1)));
        if (n === undefined) return;
        if (kind === 'hold') {
          neighborDown(ctx, n, EIGRP_NEIGHBOR_CAUSE.holdExpired, 'aged');
          return;
        }
        if (n.queue.length === 0) return;
        n.retries++;
        if (n.retries > EIGRP_MAX_RETRANSMISSIONS) {
          neighborDown(ctx, n, EIGRP_NEIGHBOR_CAUSE.retryLimit);
          return;
        }
        transmitHead(ctx, n);
        return;
      }
      case 'sia': {
        const e = topo.get(rest);
        const since = activeSince.get(rest);
        if (e === undefined || e.state !== 'active' || since === undefined) return;
        const waiting = e.waiting.map((w) => nbrs.get(nbrKey(w.iface, w.address))).filter((n): n is Nbr => n !== undefined);
        if (ctx.now - since >= EIGRP_SIA_RESET_NS) {
          for (const n of waiting) neighborDown(ctx, n, EIGRP_NEIGHBOR_CAUSE.sia);
          return;
        }
        for (const n of waiting) enqueue(ctx, n, EIGRP_OPCODE.siaQuery, 0, [entryFor(rest, dualReplyDistance(e, n.iface))]);
        out.push(timer(`sia:${rest}`, EIGRP_SIA_RESET_NS - EIGRP_SIA_QUERY_NS, true));
        return;
      }
      default:
        return;
    }
  }

  const isEigrpLine = (delta: ConfigDelta): boolean => {
    const head = delta.context[0];
    if (head !== undefined) return head[0] === 'router' && head[1] === 'eigrp';
    const l = delta.line;
    return (l[0] === 'router' && l[1] === 'eigrp') || (l[0] === 'ip' && l[1] === 'routing' && l.length === 2);
  };

  // ── the process ──

  return {
    name: NAME,

    init(ctx: ProcessCtx): Action[] {
      return readEigrpProcess(ctx.config.root) !== undefined ? [timer('resync', 0)] : [];
    },

    onConfig(_ctx: ProcessCtx, delta: ConfigDelta): Action[] {
      if (cfg === undefined && !isEigrpLine(delta)) return [];
      return [timer('resync', 0)];
    },

    onLinkChange(ctx: ProcessCtx, port: PortId, up: boolean): Action[] {
      if (cfg === undefined) return [];
      if (up) return [timer('resync', 0)];
      const i = ifaces.get(port);
      if (i !== undefined && i.up) bringDown(ctx, i, EIGRP_NEIGHBOR_CAUSE.interfaceDown, false);
      return flush(ctx);
    },

    onPdu(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
      const final = receive(ctx, pdu, port);
      return [final, ...flush(ctx)];
    },

    onTimer(ctx: ProcessCtx, key: string): Action[] {
      onTimerKey(ctx, key);
      return flush(ctx);
    },

    onRequest(ctx: ProcessCtx, req: ProcessRequest): Action[] {
      if (req.kind !== 'eigrp.clear' || cfg === undefined) return [];
      for (const n of sortedNbrs(ctx, false)) {
        if (req.neighbor === undefined || req.neighbor === n.address) neighborDown(ctx, n, EIGRP_NEIGHBOR_CAUSE.cleared);
      }
      return flush(ctx);
    },

    stateSnapshot(): StateView {
      const state: EigrpStateView = {
        ...(cfg !== undefined ? { process: { as: cfg.as, routerId: routerId ?? '0.0.0.0', kValues: [...cfg.kValues], maximumPaths: cfg.maximumPaths } } : {}),
        neighbors: byNeighborOrder([...nbrs.values()], lastPortOrder).map((n) => ({ iface: n.iface, address: n.address, holdUntil: n.holdUntil, queue: n.queue.length, lastSeq: n.lastSeqIn })),
        active: [...activeSince.keys()].sort(eigrpPrefixOrder).map((prefix) => ({
          prefix,
          since: activeSince.get(prefix)!,
          waitingFor: (topo.get(prefix)?.waiting ?? []).map((w) => w.address),
        })),
      };
      return { process: NAME, state: state as unknown as Record<string, unknown> };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}
