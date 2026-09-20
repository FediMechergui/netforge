/**
 * protocols/nd.ts — IPv6 Neighbour Discovery (ARCHITECTURE-P1 §4.6, §3.9; RFC 4861 neighbour cache, NS/NA, RS/RA;
 * RFC 4862 §5.4 Duplicate Address Detection) and the IPv6 L3 → L2 framer.
 *
 * Responsibilities
 *  • `nd.sendVia` (from ipv6 and icmpv6), by the egress port's link framing:
 *      hdlc     → no neighbour resolution and no NdRow: encapsulate `hdlc {address 0x0f, control 0, protocol 0x86dd}`,
 *                 or rewrap a packet still framed by another link (forwarded from Ethernet);
 *      none     → (loopbacks) the bare packet is sent;
 *      ethernet → multicast next hop → 33:33 + low 32 bits (RFC 2464 §7); unicast → the neighbour cache: REACHABLE,
 *                 DELAY and PROBE send at once, STALE sends and moves to DELAY (5 s), then PROBE (unicast NS every
 *                 1 s, 3 times) until a solicited NA makes it REACHABLE (30 s, then STALE); no entry → INCOMPLETE
 *                 with a queue of 5 packets (oldest dropped `queue-full`) and a multicast NS to the solicited-node
 *                 group every 1 s, 3 times, then the queue is dropped `arp-unresolved` (address resolution failed)
 *                 with ICMPv6 address unreachable for forwarded packets (RFC 4861 §7.2.2).
 *                 Bare packets are encapsulated, Ethernet-framed ones get a MacRewrite, other framings are rewrapped.
 *  • `nd.dad`: NS `{src ::, dst solicited-node(target), hop limit 255, target}` (no source link-layer option) and
 *    timer `dad:<iface>|<addr>` (1 s). No answer → `ipv6.dadResult ok`; an NA for the target, or an NS from :: for
 *    it while the detection runs → `ipv6.dadResult` not ok. Ports without framing succeed at once.
 *  • Receive (delivered by ipv6 for ICMPv6 types 133–137; hop limit must be 255): NS → answer with a solicited NA
 *    for a preferred own target (and learn the solicitor's link-layer address as STALE); an NS from :: for a
 *    preferred own address is defended with an NA to ff02::1. NA → RFC 4861 §7.2.5 cache update (override and
 *    solicited flags). RS (routers) → solicited RA after a random 0–500 ms (`ra-solicit:<iface>`). RA (hosts) →
 *    router entry STALE + isRouter, RS retries stop, `ipv6.raLearned` to ipv6 (prefix, lifetimes, router lifetime).
 *  • Router side (`ipv6 unicast-routing` on a forwarding model, preferred link-local, no `ipv6 nd suppress-ra`):
 *    periodic RA `ra:<iface>` (first after a random 0–500 ms, then every 200 s; background traffic) from the
 *    link-local to ff02::1 with the first configured prefix of the port (on-link + autonomous), its MTU and the
 *    source link-layer address.
 *  • Host side (`ipv6 address autoconfig`, not routing): RS to ff02::2 from the link-local after a random 0–1 s once
 *    the link-local is preferred, retried every 4 s up to 3 RS, stopped by the first RA.
 *  • Link down: the port's neighbour entries (and queued packets), detections and RS/RA timers are dropped.
 *
 * Silence: nothing is sent unless an interface has IPv6 configuration (ipv6 asks for DAD) or `ipv6 unicast-routing`
 * is set (RAs); rng draws come only from the cached streams 'rs', 'ra' and 'ra-solicit' (one per delay, §5.1).
 *
 * Timer keys: `dad:<iface>|<addr>`, `nd:<iface>|<ip>` (per-neighbour state), `rs:<iface>`, `ra:<iface>` (periodic),
 * `ra-solicit:<iface>`. Debug category: 'ipv6 nd'.
 *
 * StateView: `{ process: 'nd', state: { neighbours: [{ ip, iface, mac, state, isRouter, queued }], detections:
 *   [{ iface, address }], soliciting: [{ iface, sent }], advertising: [iface], nsSent, naSent, rsSent, raSent,
 *   duplicates, resolved, failed } }`.
 */
import { MAC_ZERO, normalizeMac, type Ipv6Address, type MacAddress } from '../contracts/addr.js';
import { IPV6_ALL_NODES, IPV6_ALL_ROUTERS, IPV6_ANY } from '../contracts/addr.js';
import type { ConfigDelta } from '../contracts/config.js';
import type { PortId } from '../contracts/ids.js';
import {
  ETHERTYPE_IPV6,
  HDLC_ADDRESS_UNICAST,
  HDLC_PROTO_IPV6,
  ICMPV6_DEST_UNREACHABLE,
  ICMPV6_NA,
  ICMPV6_NS,
  ICMPV6_RA,
  ICMPV6_RS,
  ICMPV6_UNREACH_ADDRESS,
  IPPROTO_ICMPV6,
  IPV6_ND_HOP_LIMIT,
  type LayerSpec,
  type LayerView,
  type Pdu,
  type PduMeta,
  type RewrapOp,
} from '../contracts/pdu.js';
import type { PortView } from '../contracts/port.js';
import type { Action, DebugEvent, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import {
  ND_DAD_TIMEOUT_NS,
  ND_DELAY_NS,
  ND_MAX_MULTICAST_SOLICIT,
  ND_MAX_UNICAST_SOLICIT,
  ND_QUEUE_MAX,
  ND_RA_INTERVAL_NS,
  ND_RA_PREFERRED_LIFETIME_S,
  ND_RA_RESPONSE_MAX_DELAY_NS,
  ND_RA_VALID_LIFETIME_S,
  ND_REACHABLE_NS,
  ND_RETRANS_NS,
  ND_RS_INTERVAL_NS,
  ND_RS_MAX,
  ND_RS_MAX_DELAY_NS,
} from '../contracts/services.js';
import { ndKey, type NdRow, type Table } from '../contracts/tables.js';
import { flowKey, ipv6MulticastMac, ipv6NetworkOf, normalizeIpv6, solicitedNodeMulticast } from '../core/addr6.js';
import { ICMPV6_RA_DEFAULT_HOP_LIMIT, ICMPV6_RA_DEFAULT_LIFETIME_S } from '../pdu/codecs/icmpv6.js';
import {
  createStreamCache,
  encapOf6,
  findPort6,
  interfaceIpv6Lines,
  ipv6Helpers,
  ipv6RoutingEnabled,
  isLinkLocal6,
  isMulticast6,
  isUnspecified6,
  preferredLinkLocal,
} from './ipv6.js';

/** Process name, as registered in the protocol registry. */
const NAME = 'nd';
/** Debug category. */
const CAT = 'ipv6 nd';
/** Debug events retained per daemon (newest last). */
const DEBUG_RING = 256;
const TIMER_DAD = 'dad:';
const TIMER_NBR = 'nd:';
const TIMER_RS = 'rs:';
const TIMER_RA = 'ra:';
const TIMER_RA_SOLICIT = 'ra-solicit:';
/** Link framing protocols that the framer strips when a packet changes framing. */
const LINK_FRAMING_PROTOS: readonly string[] = Object.freeze(['ethernet', 'hdlc', 'dot11', 'llc']);

/** How a port frames IPv6: Ethernet (also wireless adapters, whose data frames are Ethernet at the daemons), HDLC, or none. */
type Framing = 'ethernet' | 'hdlc' | 'none';

/** A packet waiting for a resolution, with the cause its sender gave. */
interface Queued {
  pdu: Pdu;
  cause?: string;
}

/** One neighbour cache entry (the table row mirrors it). */
interface Nbr {
  key: string;
  iface: PortId;
  ip: Ipv6Address;
  mac: MacAddress;
  state: NdRow['state'];
  isRouter: boolean;
  /** Solicitations sent in the current INCOMPLETE or PROBE episode. */
  probes: number;
  queue: Queued[];
}

/** Number of outermost layers of `pdu` that are link framing (0 for a bare IP packet). */
function leadingFraming(pdu: Pick<Pdu, 'layers'>): number {
  let n = 0;
  while (n < pdu.layers.length && LINK_FRAMING_PROTOS.includes(pdu.layers[n]!.proto)) n++;
  return n;
}

/** Framing of a port view. */
function framingOf(view: PortView): Framing {
  const encap = encapOf6(view);
  if (encap === 'hdlc' || encap === 'ppp') return 'hdlc';
  if (encap === 'none') return 'none';
  return 'ethernet';
}

/** Structural rewrap through the ctx (trace-mirrored) when available, else directly on the PDU (still recorded). */
function rewrapPdu(ctx: ProcessCtx, pdu: Pdu, op: RewrapOp, cause: string | undefined): void {
  if (ctx.rewrap !== undefined) ctx.rewrap(pdu, op, cause);
  else pdu.rewrap({ now: ctx.now, device: ctx.deviceId }, op, cause);
}

/** The icmpv6 layer following the first ipv6 layer, if any. */
function ndLayer(pdu: Pdu): { ip: LayerView; icmp: LayerView } | undefined {
  let ip: LayerView | undefined;
  for (const l of pdu.layers) {
    if (ip === undefined) {
      if (l.proto === 'ipv6') ip = l;
      continue;
    }
    if (l.proto === 'icmpv6') return { ip, icmp: l };
  }
  return undefined;
}

/** Canonical MAC of an option field, or undefined. */
function llaOf(v: unknown): MacAddress | undefined {
  if (typeof v !== 'string') return undefined;
  return normalizeMac(v) ?? undefined;
}

/** Parse `<iface>|<address>` timer suffixes. */
function splitKey(rest: string): { iface: PortId; ip: Ipv6Address } | undefined {
  const sep = rest.indexOf('|');
  if (sep <= 0) return undefined;
  return { iface: rest.slice(0, sep), ip: rest.slice(sep + 1) };
}

/** The nd daemon (`Process` named `'nd'`), one instance per device. */
export function createNd(): Process {
  const nbrs = new Map<string, Nbr>();
  const detections = new Map<string, { iface: PortId; address: Ipv6Address }>();
  const soliciting = new Map<PortId, { sent: number }>();
  /** Ports whose RS episode ended with an RA (no new RS until the link bounces or the config changes). */
  const solicited = new Set<PortId>();
  const advertising = new Set<PortId>();
  const solicitPending = new Set<PortId>();
  /** The RS that caused a pending solicited RA, per port (for `triggeredBy`). */
  const solicitTrigger = new Map<PortId, number>();
  const ring: DebugEvent[] = [];
  const stream = createStreamCache();
  let nsSent = 0;
  let naSent = 0;
  let rsSent = 0;
  let raSent = 0;
  let duplicates = 0;
  let resolved = 0;
  let failed = 0;

  function debug(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(CAT, message, data);
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: NAME, category: CAT, message };
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  function table(ctx: ProcessCtx): Table<NdRow> | undefined {
    return ctx.tables.get<NdRow>('nd');
  }

  function writeRow(ctx: ProcessCtx, n: Nbr): void {
    table(ctx)?.set({ key: n.key, ip: n.ip, mac: n.mac, iface: n.iface, state: n.state, isRouter: n.isRouter, type: 'dynamic', updatedAt: ctx.now });
  }

  function forget(ctx: ProcessCtx, n: Nbr, reason: 'aged' | 'cleared' | 'link-down', out: Action[]): void {
    nbrs.delete(n.key);
    out.push({ type: 'cancelTimer', key: `${TIMER_NBR}${n.key}` });
    const t = table(ctx);
    if (t !== undefined && t.has(n.key)) t.delete(n.key, reason);
  }

  // ── framing ─────────────────────────────────────────────────────────────

  /** Put an Ethernet header for `dstMac` on `pdu` out of `iface`: encapsulate, rewrite the MACs, or rewrap. */
  function frameEthernet(ctx: ProcessCtx, pdu: Pdu, dstMac: MacAddress, iface: PortId, cause?: string): void {
    const src = ctx.macOf(iface);
    const framing = leadingFraming(pdu);
    if (framing === 0) {
      ctx.encapsulate(pdu, { proto: 'ethernet', fields: { dst: dstMac, src, type: ETHERTYPE_IPV6 } }, cause);
    } else if (framing === 1 && pdu.layers[0]!.proto === 'ethernet') {
      ctx.mutate(pdu, 'ethernet.src', src, 'MacRewrite', cause);
      ctx.mutate(pdu, 'ethernet.dst', dstMac, 'MacRewrite', cause);
    } else {
      rewrapPdu(ctx, pdu, { strip: framing, push: [{ proto: 'ethernet', fields: { dst: dstMac, src, type: ETHERTYPE_IPV6 } }] }, cause);
    }
  }

  /** Put an HDLC header on `pdu` (serial point-to-point: nothing to resolve). */
  function frameHdlc(ctx: ProcessCtx, pdu: Pdu, cause?: string): void {
    const outer: LayerSpec = { proto: 'hdlc', fields: { address: HDLC_ADDRESS_UNICAST, control: 0, protocol: HDLC_PROTO_IPV6 } };
    const framing = leadingFraming(pdu);
    if (framing === 0) ctx.encapsulate(pdu, outer, cause);
    else if (framing === 1 && pdu.layers[0]!.proto === 'hdlc') return;
    else rewrapPdu(ctx, pdu, { strip: framing, push: [outer] }, cause);
  }

  /** Remove any link framing (a packet leaving through a port without framing). */
  function frameNone(ctx: ProcessCtx, pdu: Pdu, cause?: string): void {
    const framing = leadingFraming(pdu);
    if (framing > 0 && framing < pdu.layers.length) rewrapPdu(ctx, pdu, { strip: framing, push: [] }, cause);
  }

  /** Link layer spec for an ND message built by this daemon. */
  function linkLayer(ctx: ProcessCtx, view: PortView, dstMac: MacAddress): LayerSpec | undefined {
    const framing = framingOf(view);
    if (framing === 'hdlc') return { proto: 'hdlc', fields: { address: HDLC_ADDRESS_UNICAST, control: 0, protocol: HDLC_PROTO_IPV6 } };
    if (framing === 'none') return undefined;
    return { proto: 'ethernet', fields: { dst: dstMac, src: ctx.macOf(view.id), type: ETHERTYPE_IPV6 } };
  }

  /** Build an ND message (link layer + IPv6 with hop limit 255 + ICMPv6). */
  function buildNd(
    ctx: ProcessCtx,
    view: PortView,
    src: Ipv6Address,
    dst: Ipv6Address,
    dstMac: MacAddress,
    icmp: Record<string, unknown>,
    meta: Partial<PduMeta>,
  ): Pdu {
    const layers: LayerSpec[] = [];
    const link = linkLayer(ctx, view, dstMac);
    if (link !== undefined) layers.push(link);
    layers.push({ proto: 'ipv6', fields: { src, dst, nextHeader: IPPROTO_ICMPV6, hopLimit: IPV6_ND_HOP_LIMIT } });
    layers.push({ proto: 'icmpv6', fields: icmp as LayerSpec['fields'] });
    return ctx.newPdu(layers, { flow: flowKey(6, src, dst, 'icmpv6'), ...meta });
  }

  // ── neighbour resolution ────────────────────────────────────────────────

  /** Source for an NS about `target` on `iface`: the address selection result, else the link-local. */
  function solicitSource(ctx: ProcessCtx, view: PortView, target: Ipv6Address): Ipv6Address | undefined {
    return ipv6Helpers(ctx).sourceFor6(target, view.id)?.address ?? preferredLinkLocal(view);
  }

  /** Send an NS for `n`: multicast to the solicited-node group, or unicast to the cached address (PROBE). */
  function sendSolicit(ctx: ProcessCtx, view: PortView, n: Nbr, unicast: boolean, out: Action[], triggeredBy?: number): boolean {
    const src = solicitSource(ctx, view, n.ip);
    if (src === undefined) return false;
    const dst = unicast ? n.ip : solicitedNodeMulticast(n.ip);
    const dstMac = unicast ? n.mac : ipv6MulticastMac(dst);
    const icmp: Record<string, unknown> = { type: ICMPV6_NS, code: 0, target: n.ip };
    if (framingOf(view) === 'ethernet') icmp.sourceLla = ctx.macOf(view.id);
    const meta: Partial<PduMeta> = triggeredBy !== undefined ? { tag: 'nd-ns', triggeredBy } : { tag: 'nd-ns' };
    const pdu = buildNd(ctx, view, src, dst, dstMac, icmp, meta);
    nsSent++;
    n.probes++;
    out.push({ type: 'send', port: view.id, pdu });
    debug(ctx, `solicit ${n.ip} on ${view.id} (${unicast ? 'unicast probe' : 'multicast'} ${n.probes})`, { ip: n.ip, iface: view.id, pdu: pdu.id, unicast });
    return true;
  }

  function enqueue(ctx: ProcessCtx, n: Nbr, pdu: Pdu, cause: string | undefined, out: Action[]): void {
    if (n.queue.length >= ND_QUEUE_MAX) {
      const oldest = n.queue.shift()!;
      debug(ctx, `queue for ${n.ip} on ${n.iface} is full: discarding the oldest packet`, { ip: n.ip, iface: n.iface, pdu: oldest.pdu.id });
      out.push({ type: 'drop', pdu: oldest.pdu, reason: 'queue-full', detail: `${ND_QUEUE_MAX} packets already waiting for ${n.ip}`, port: n.iface });
    }
    n.queue.push(cause !== undefined ? { pdu, cause } : { pdu });
  }

  /** Send every packet waiting for `n` in queue order. */
  function flush(ctx: ProcessCtx, n: Nbr, out: Action[]): void {
    if (n.queue.length === 0) return;
    const queue = n.queue;
    n.queue = [];
    resolved++;
    debug(ctx, `releasing ${queue.length} packet(s) waiting for ${n.ip} on ${n.iface}`, { ip: n.ip, iface: n.iface, count: queue.length });
    for (const q of queue) {
      frameEthernet(ctx, q.pdu, n.mac, n.iface, q.cause);
      out.push({ type: 'send', port: n.iface, pdu: q.pdu });
    }
  }

  function sendVia(ctx: ProcessCtx, pdu: Pdu, nextHopText: Ipv6Address, iface: PortId, cause: string | undefined): Action[] {
    const out: Action[] = [];
    const view = ctx.ports.get(iface);
    if (view === undefined || !view.operUp) {
      debug(ctx, `cannot reach ${nextHopText}: ${iface} is down`, { ip: nextHopText, iface, pdu: pdu.id });
      out.push({ type: 'drop', pdu, reason: 'link-down', detail: `${iface} is down`, port: iface });
      return out;
    }
    const framing = framingOf(view);
    if (framing === 'hdlc') {
      frameHdlc(ctx, pdu, cause);
      debug(ctx, `framing for ${nextHopText} on ${iface}: serial HDLC link, no neighbour resolution`, { ip: nextHopText, iface, pdu: pdu.id });
      out.push({ type: 'send', port: iface, pdu });
      return out;
    }
    if (framing === 'none') {
      frameNone(ctx, pdu, cause);
      out.push({ type: 'send', port: iface, pdu });
      return out;
    }
    const nextHop = normalizeIpv6(nextHopText);
    if (nextHop === null) {
      out.push({ type: 'drop', pdu, reason: 'no-route', detail: `invalid next hop ${nextHopText}`, port: iface });
      return out;
    }
    if (isMulticast6(nextHop)) {
      const mac = ipv6MulticastMac(nextHop);
      frameEthernet(ctx, pdu, mac, iface, cause);
      debug(ctx, `sending to multicast ${nextHop} on ${iface} (${mac})`, { ip: nextHop, iface, pdu: pdu.id });
      out.push({ type: 'send', port: iface, pdu });
      return out;
    }
    const key = ndKey(iface, nextHop);
    const n = nbrs.get(key);
    if (n !== undefined && n.state !== 'INCOMPLETE') {
      frameEthernet(ctx, pdu, n.mac, iface, cause);
      out.push({ type: 'send', port: iface, pdu });
      if (n.state === 'STALE') {
        n.state = 'DELAY';
        n.probes = 0;
        writeRow(ctx, n);
        out.push({ type: 'timer', key: `${TIMER_NBR}${key}`, delay: ND_DELAY_NS });
        debug(ctx, `${nextHop} on ${iface}: stale entry used, waiting ${ND_DELAY_NS / 1_000_000_000} s before probing`, { ip: nextHop, iface, pdu: pdu.id });
      } else {
        debug(ctx, `cache hit for ${nextHop}: ${n.mac} on ${iface} (${n.state})`, { ip: nextHop, mac: n.mac, iface, pdu: pdu.id });
      }
      return out;
    }
    if (n !== undefined) {
      enqueue(ctx, n, pdu, cause, out);
      debug(ctx, `queued packet for ${nextHop} on ${iface} (resolution in progress, ${n.queue.length} waiting)`, { ip: nextHop, iface, pdu: pdu.id });
      return out;
    }
    if (solicitSource(ctx, view, nextHop) === undefined) {
      debug(ctx, `cannot resolve ${nextHop}: ${iface} has no usable IPv6 address`, { ip: nextHop, iface, pdu: pdu.id });
      out.push({ type: 'drop', pdu, reason: 'no-l3-address', detail: `${iface} has no IPv6 address to solicit from`, port: iface });
      return out;
    }
    const fresh: Nbr = { key, iface, ip: nextHop, mac: MAC_ZERO, state: 'INCOMPLETE', isRouter: false, probes: 0, queue: [] };
    nbrs.set(key, fresh);
    enqueue(ctx, fresh, pdu, cause, out);
    writeRow(ctx, fresh);
    debug(ctx, `cache miss for ${nextHop} on ${iface}: resolving`, { ip: nextHop, iface, pdu: pdu.id });
    sendSolicit(ctx, view, fresh, false, out, pdu.id);
    out.push({ type: 'timer', key: `${TIMER_NBR}${key}`, delay: ND_RETRANS_NS });
    return out;
  }

  /** Resolution of `n` failed: drop its queue (address unreachable for forwarded packets) and forget it. */
  function resolutionFailed(ctx: ProcessCtx, n: Nbr, out: Action[]): void {
    failed++;
    const detail = `no neighbour advertisement from ${n.ip} after ${n.probes} solicitations`;
    debug(ctx, `giving up on ${n.ip} on ${n.iface}: ${detail}; discarding ${n.queue.length} packet(s)`, { ip: n.ip, iface: n.iface, queued: n.queue.length });
    const h = ipv6Helpers(ctx);
    for (const q of n.queue) {
      out.push({ type: 'drop', pdu: q.pdu, reason: 'arp-unresolved', detail, port: n.iface });
      const src = q.pdu.get('ipv6.src');
      if (typeof src === 'string' && h.ownAddress6(src) === undefined) {
        out.push({
          type: 'request', to: 'icmpv6',
          req: { kind: 'icmp6.error', original: q.pdu, type: ICMPV6_DEST_UNREACHABLE, code: ICMPV6_UNREACH_ADDRESS, inPort: n.iface },
        });
      }
    }
    n.queue = [];
    forget(ctx, n, 'aged', out);
  }

  function onNeighbourTimer(ctx: ProcessCtx, key: string): Action[] {
    const out: Action[] = [];
    const n = nbrs.get(key);
    if (n === undefined) return out;
    const view = ctx.ports.get(n.iface);
    if (view === undefined || !view.operUp) {
      for (const q of n.queue) out.push({ type: 'drop', pdu: q.pdu, reason: 'link-down', detail: `${n.iface} is down`, port: n.iface });
      n.queue = [];
      forget(ctx, n, 'link-down', out);
      return out;
    }
    switch (n.state) {
      case 'INCOMPLETE':
        if (n.probes < ND_MAX_MULTICAST_SOLICIT && sendSolicit(ctx, view, n, false, out)) {
          out.push({ type: 'timer', key: `${TIMER_NBR}${key}`, delay: ND_RETRANS_NS });
        } else {
          resolutionFailed(ctx, n, out);
        }
        return out;
      case 'REACHABLE':
        n.state = 'STALE';
        writeRow(ctx, n);
        debug(ctx, `${n.ip} on ${n.iface}: reachable time over, entry is stale`, { ip: n.ip, iface: n.iface });
        return out;
      case 'DELAY':
        n.state = 'PROBE';
        n.probes = 0;
        writeRow(ctx, n);
        debug(ctx, `${n.ip} on ${n.iface}: probing`, { ip: n.ip, iface: n.iface });
        if (sendSolicit(ctx, view, n, true, out)) out.push({ type: 'timer', key: `${TIMER_NBR}${key}`, delay: ND_RETRANS_NS });
        else forget(ctx, n, 'aged', out);
        return out;
      case 'PROBE':
        if (n.probes < ND_MAX_UNICAST_SOLICIT && sendSolicit(ctx, view, n, true, out)) {
          out.push({ type: 'timer', key: `${TIMER_NBR}${key}`, delay: ND_RETRANS_NS });
        } else {
          failed++;
          debug(ctx, `${n.ip} on ${n.iface} did not answer ${n.probes} probes: entry removed`, { ip: n.ip, iface: n.iface });
          forget(ctx, n, 'aged', out);
        }
        return out;
      default:
        return out;
    }
  }

  /**
   * Learn `mac` for `ip` from a solicitation or an advertisement that is not an answer (RFC 4861 §7.2.3, §6.3.4):
   * a new entry is STALE; a changed address makes it STALE; an INCOMPLETE entry is completed and flushed.
   */
  function learnUnsolicited(ctx: ProcessCtx, iface: PortId, ip: Ipv6Address, mac: MacAddress, isRouter: boolean | undefined, out: Action[]): void {
    const key = ndKey(iface, ip);
    const n = nbrs.get(key);
    if (n === undefined) {
      const fresh: Nbr = { key, iface, ip, mac, state: 'STALE', isRouter: isRouter === true, probes: 0, queue: [] };
      nbrs.set(key, fresh);
      writeRow(ctx, fresh);
      debug(ctx, `learned ${ip} is at ${mac} on ${iface} (stale)`, { ip, mac, iface });
      return;
    }
    const wasIncomplete = n.state === 'INCOMPLETE';
    const changed = n.mac !== mac;
    if (wasIncomplete || changed) {
      n.mac = mac;
      n.state = 'STALE';
      n.probes = 0;
      out.push({ type: 'cancelTimer', key: `${TIMER_NBR}${key}` });
    }
    if (isRouter !== undefined) n.isRouter = isRouter;
    writeRow(ctx, n);
    debug(ctx, `${ip} on ${iface} is at ${mac}${wasIncomplete ? ' (resolved, stale)' : changed ? ' (changed, stale)' : ''}`, { ip, mac, iface });
    if (wasIncomplete) flush(ctx, n, out);
  }

  // ── DAD ─────────────────────────────────────────────────────────────────

  function startDad(ctx: ProcessCtx, iface: PortId, addressText: Ipv6Address): Action[] {
    const out: Action[] = [];
    const address = normalizeIpv6(addressText);
    const view = ctx.ports.get(iface);
    if (address === null || view === undefined) return out;
    if (!view.operUp) {
      debug(ctx, `duplicate address detection for ${address} on ${iface} waits for the link`, { iface, address });
      return out;
    }
    if (framingOf(view) === 'none') {
      out.push({ type: 'request', to: 'ipv6', req: { kind: 'ipv6.dadResult', iface, address, ok: true } });
      return out;
    }
    const key = `${iface}|${address}`;
    detections.set(key, { iface, address });
    const dst = solicitedNodeMulticast(address);
    const pdu = buildNd(ctx, view, IPV6_ANY, dst, ipv6MulticastMac(dst), { type: ICMPV6_NS, code: 0, target: address }, { tag: 'dad-ns' });
    nsSent++;
    out.push({ type: 'send', port: iface, pdu });
    out.push({ type: 'timer', key: `${TIMER_DAD}${key}`, delay: ND_DAD_TIMEOUT_NS });
    debug(ctx, `checking that ${address} is unique on ${iface}`, { iface, address, pdu: pdu.id });
    return out;
  }

  /** A detection found a duplicate: stop it and report. */
  function dadFailed(ctx: ProcessCtx, iface: PortId, address: Ipv6Address, why: string, out: Action[]): void {
    const key = `${iface}|${address}`;
    detections.delete(key);
    duplicates++;
    out.push({ type: 'cancelTimer', key: `${TIMER_DAD}${key}` });
    debug(ctx, `${address} on ${iface} is already in use (${why})`, { iface, address });
    out.push({ type: 'request', to: 'ipv6', req: { kind: 'ipv6.dadResult', iface, address, ok: false } });
  }

  function onDadTimer(ctx: ProcessCtx, rest: string): Action[] {
    const out: Action[] = [];
    const k = splitKey(rest);
    if (k === undefined || !detections.has(rest)) return out;
    detections.delete(rest);
    debug(ctx, `${k.ip} on ${k.iface}: no answer, the address is unique`, { iface: k.iface, address: k.ip });
    out.push({ type: 'request', to: 'ipv6', req: { kind: 'ipv6.dadResult', iface: k.iface, address: k.ip, ok: true } });
    if (isLinkLocal6(k.ip)) {
      // the link-local becomes preferred as ipv6 applies the result: start router or host behaviour
      out.push(...armRa(ctx, k.iface, false));
      out.push(...armRs(ctx, k.iface, false));
    }
    return out;
  }

  // ── router and host discovery ───────────────────────────────────────────

  function suppressRa(ctx: ProcessCtx, iface: PortId): boolean {
    return interfaceIpv6Lines(ctx, iface).some((l) => l[1] === 'nd' && l[2] === 'suppress-ra');
  }

  function autoconfig(ctx: ProcessCtx, iface: PortId): boolean {
    return interfaceIpv6Lines(ctx, iface).some((l) => l[1] === 'address' && l[2] === 'autoconfig');
  }

  /** May `iface` advertise? `needLinkLocal` also requires a preferred link-local in the port view. */
  function mayAdvertise(ctx: ProcessCtx, iface: PortId, needLinkLocal: boolean): boolean {
    const view = ctx.ports.get(iface);
    if (view === undefined || !view.operUp || !ipv6RoutingEnabled(ctx) || suppressRa(ctx, iface)) return false;
    if (interfaceIpv6Lines(ctx, iface).length === 0) return false;
    return !needLinkLocal || (view.l3.ipv6Enabled === true && preferredLinkLocal(view) !== undefined);
  }

  /** May `iface` solicit routers? `needLinkLocal` also requires a preferred link-local in the port view. */
  function maySolicit(ctx: ProcessCtx, iface: PortId, needLinkLocal: boolean): boolean {
    const view = ctx.ports.get(iface);
    if (view === undefined || !view.operUp || ipv6RoutingEnabled(ctx) || !autoconfig(ctx, iface)) return false;
    return !needLinkLocal || (view.l3.ipv6Enabled === true && preferredLinkLocal(view) !== undefined);
  }

  /** Start periodic RAs on `iface` (first after a random 0–500 ms from the cached 'ra' stream). */
  function armRa(ctx: ProcessCtx, iface: PortId, needLinkLocal: boolean): Action[] {
    if (advertising.has(iface) || !mayAdvertise(ctx, iface, needLinkLocal)) return [];
    advertising.add(iface);
    const delay = stream(ctx, 'ra').nextInt(0, ND_RA_RESPONSE_MAX_DELAY_NS);
    debug(ctx, `router advertisements on ${iface} start in ${delay} ns`, { iface, delay });
    return [{ type: 'timer', key: `${TIMER_RA}${iface}`, delay, periodic: true }];
  }

  function stopRa(ctx: ProcessCtx, iface: PortId, out: Action[]): void {
    if (advertising.delete(iface)) {
      out.push({ type: 'cancelTimer', key: `${TIMER_RA}${iface}` });
      debug(ctx, `router advertisements on ${iface} stopped`, { iface });
    }
    if (solicitPending.delete(iface)) out.push({ type: 'cancelTimer', key: `${TIMER_RA_SOLICIT}${iface}` });
  }

  /** Start router solicitation on `iface` (first after a random 0–1 s from the cached 'rs' stream). */
  function armRs(ctx: ProcessCtx, iface: PortId, needLinkLocal: boolean): Action[] {
    if (soliciting.has(iface) || solicited.has(iface) || !maySolicit(ctx, iface, needLinkLocal)) return [];
    soliciting.set(iface, { sent: 0 });
    const delay = stream(ctx, 'rs').nextInt(0, ND_RS_MAX_DELAY_NS);
    debug(ctx, `router solicitation on ${iface} in ${delay} ns`, { iface, delay });
    return [{ type: 'timer', key: `${TIMER_RS}${iface}`, delay }];
  }

  function stopRs(iface: PortId, out: Action[]): void {
    if (soliciting.delete(iface)) out.push({ type: 'cancelTimer', key: `${TIMER_RS}${iface}` });
  }

  /** Build and send one RA out `iface` (periodic ones are background traffic). */
  function sendRa(ctx: ProcessCtx, view: PortView, periodic: boolean, triggeredBy?: number): Action[] {
    const ll = preferredLinkLocal(view) as Ipv6Address;
    const icmp: Record<string, unknown> = {
      type: ICMPV6_RA,
      code: 0,
      curHopLimit: ICMPV6_RA_DEFAULT_HOP_LIMIT,
      managedFlag: false,
      otherFlag: false,
      routerLifetimeS: ICMPV6_RA_DEFAULT_LIFETIME_S,
      mtu: view.mtu,
    };
    if (framingOf(view) === 'ethernet') icmp.sourceLla = ctx.macOf(view.id);
    const prefixAddr = (view.l3.ipv6 ?? []).find((a) => a.scope !== 'link-local' && a.state === 'preferred' && (a.origin === 'manual' || a.origin === 'eui64') && a.prefixLen <= 64);
    if (prefixAddr !== undefined) {
      icmp.prefix = ipv6NetworkOf(prefixAddr.address, prefixAddr.prefixLen);
      icmp.prefixLen = prefixAddr.prefixLen;
      icmp.validLifetimeS = ND_RA_VALID_LIFETIME_S;
      icmp.preferredLifetimeS = ND_RA_PREFERRED_LIFETIME_S;
    }
    const meta: Partial<PduMeta> = { tag: 'nd-ra' };
    if (periodic) (meta as { background?: boolean }).background = true;
    if (triggeredBy !== undefined) (meta as { triggeredBy?: number }).triggeredBy = triggeredBy;
    const pdu = buildNd(ctx, view, ll, IPV6_ALL_NODES, ipv6MulticastMac(IPV6_ALL_NODES), icmp, meta);
    raSent++;
    debug(ctx, `router advertisement on ${view.id}${prefixAddr !== undefined ? ` prefix ${String(icmp.prefix)}/${prefixAddr.prefixLen}` : ''}${periodic ? '' : ' (solicited)'}`, {
      iface: view.id, pdu: pdu.id,
    });
    return [{ type: 'send', port: view.id, pdu }];
  }

  function onRsTimer(ctx: ProcessCtx, iface: PortId): Action[] {
    const out: Action[] = [];
    const s = soliciting.get(iface);
    if (s === undefined) return out;
    const view = ctx.ports.get(iface);
    if (view === undefined || !maySolicit(ctx, iface, true)) {
      soliciting.delete(iface);
      debug(ctx, `router solicitation on ${iface} stopped`, { iface });
      return out;
    }
    const ll = preferredLinkLocal(view) as Ipv6Address;
    const icmp: Record<string, unknown> = { type: ICMPV6_RS, code: 0 };
    if (framingOf(view) === 'ethernet') icmp.sourceLla = ctx.macOf(iface);
    const pdu = buildNd(ctx, view, ll, IPV6_ALL_ROUTERS, ipv6MulticastMac(IPV6_ALL_ROUTERS), icmp, { tag: 'nd-rs' });
    s.sent++;
    rsSent++;
    out.push({ type: 'send', port: iface, pdu });
    debug(ctx, `router solicitation ${s.sent}/${ND_RS_MAX} on ${iface}`, { iface, pdu: pdu.id });
    if (s.sent < ND_RS_MAX) out.push({ type: 'timer', key: `${TIMER_RS}${iface}`, delay: ND_RS_INTERVAL_NS });
    else {
      soliciting.delete(iface);
      debug(ctx, `no router answered on ${iface} after ${ND_RS_MAX} solicitations`, { iface });
    }
    return out;
  }

  function onRaTimer(ctx: ProcessCtx, iface: PortId, periodic: boolean): Action[] {
    const out: Action[] = [];
    if (periodic) {
      if (!advertising.has(iface)) return out;
    } else {
      if (!solicitPending.delete(iface)) return out;
    }
    const view = ctx.ports.get(iface);
    if (view === undefined || !mayAdvertise(ctx, iface, true)) {
      if (periodic) {
        advertising.delete(iface);
        debug(ctx, `router advertisements on ${iface} stopped`, { iface });
      }
      return out;
    }
    out.push(...sendRa(ctx, view, periodic, periodic ? undefined : solicitTrigger.get(iface)));
    if (!periodic) solicitTrigger.delete(iface);
    if (periodic) out.push({ type: 'timer', key: `${TIMER_RA}${iface}`, delay: ND_RA_INTERVAL_NS, periodic: true });
    return out;
  }

  // ── receive ─────────────────────────────────────────────────────────────

  function receive(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
    const out: Action[] = [];
    const found = ndLayer(pdu);
    const view = ctx.ports.get(port);
    if (found === undefined || view === undefined) {
      out.push({ type: 'drop', pdu, reason: 'other', detail: 'not a neighbour discovery message', port });
      return out;
    }
    const { ip, icmp } = found;
    const type = Number(icmp.fields.type);
    const src = normalizeIpv6(String(ip.fields.src)) ?? String(ip.fields.src);
    const dst = normalizeIpv6(String(ip.fields.dst)) ?? String(ip.fields.dst);
    if (icmp.fields.checksumValid === false) {
      out.push({ type: 'drop', pdu, reason: 'bad-checksum', detail: 'ICMPv6 checksum mismatch', port });
      return out;
    }
    if (Number(ip.fields.hopLimit) !== IPV6_ND_HOP_LIMIT) {
      debug(ctx, `ignoring type ${type} from ${src} on ${port}: hop limit ${String(ip.fields.hopLimit)} is not 255`, { pdu: pdu.id, port });
      out.push({ type: 'drop', pdu, reason: 'other', detail: `neighbour discovery with hop limit ${String(ip.fields.hopLimit)} (must be 255)`, port });
      return out;
    }
    if (Number(icmp.fields.code ?? 0) !== 0 || icmp.error !== undefined) {
      out.push({ type: 'drop', pdu, reason: 'other', detail: icmp.error ?? `neighbour discovery code ${String(icmp.fields.code)}`, port });
      return out;
    }
    switch (type) {
      case ICMPV6_NS:
        return onSolicit(ctx, pdu, view, src, dst, icmp);
      case ICMPV6_NA:
        return onAdvert(ctx, pdu, view, dst, icmp);
      case ICMPV6_RS:
        return onRouterSolicit(ctx, pdu, view, src, icmp);
      case ICMPV6_RA:
        return onRouterAdvert(ctx, pdu, view, src, icmp);
      default:
        debug(ctx, `ignored ICMPv6 type ${type} from ${src} on ${port}`, { pdu: pdu.id, type, port });
        out.push({ type: 'consume', pdu });
        return out;
    }
  }

  function onSolicit(ctx: ProcessCtx, pdu: Pdu, view: PortView, src: Ipv6Address, dst: Ipv6Address, icmp: LayerView): Action[] {
    const out: Action[] = [];
    const port = view.id;
    const target = normalizeIpv6(String(icmp.fields.target ?? ''));
    if (target === null || isMulticast6(target)) {
      out.push({ type: 'drop', pdu, reason: 'other', detail: 'neighbour solicitation with an invalid target', port });
      return out;
    }
    const own = (view.l3.ipv6 ?? []).find((a) => a.address === target);
    const fromUnspecified = isUnspecified6(src);
    if (fromUnspecified) {
      if (dst !== solicitedNodeMulticast(target)) {
        out.push({ type: 'drop', pdu, reason: 'other', detail: 'duplicate address probe not sent to the solicited-node group', port });
        return out;
      }
      out.push({ type: 'consume', pdu });
      const key = `${port}|${target}`;
      if (detections.has(key)) {
        dadFailed(ctx, port, target, 'another node is probing for it', out);
        return out;
      }
      if (own !== undefined && (own.state === 'preferred' || own.state === 'deprecated')) {
        // defend the address (RFC 4861 §7.2.4): unsolicited NA to all nodes
        out.push(...advertise(ctx, view, target, IPV6_ALL_NODES, ipv6MulticastMac(IPV6_ALL_NODES), false, pdu.id));
        debug(ctx, `defending ${target} on ${port} against a duplicate address probe`, { target, port, pdu: pdu.id });
        return out;
      }
      debug(ctx, `duplicate address probe for ${target} on ${port} does not concern this interface`, { target, port, pdu: pdu.id });
      return out;
    }
    if (own === undefined) {
      debug(ctx, `solicitation for ${target} from ${src} on ${port} is for another node`, { target, port, pdu: pdu.id });
      out.push({ type: 'drop', pdu, reason: 'not-for-me', detail: `${target} is not an address of ${port}`, port });
      return out;
    }
    out.push({ type: 'consume', pdu });
    if (own.state !== 'preferred' && own.state !== 'deprecated') {
      debug(ctx, `solicitation for ${target} on ${port} ignored: the address is ${own.state}`, { target, port, pdu: pdu.id });
      return out;
    }
    const lla = llaOf(icmp.fields.sourceLla);
    const ethernet = framingOf(view) === 'ethernet';
    if (lla !== undefined && ethernet) learnUnsolicited(ctx, port, src, lla, undefined, out);
    if (!ethernet) {
      out.push(...advertise(ctx, view, target, src, MAC_ZERO, true, pdu.id));
    } else if (lla !== undefined) {
      out.push(...advertise(ctx, view, target, src, lla, true, pdu.id));
    } else {
      // no link-layer option: the answer goes through normal resolution (RFC 4861 §7.2.4)
      const reply = buildAdvert(ctx, view, target, src, true, pdu.id);
      naSent++;
      debug(ctx, `answering ${src} for ${target} on ${port} (resolving the solicitor first)`, { target, port, pdu: reply.id });
      out.push(...sendVia(ctx, reply, src, port, 'neighbour advertisement'));
    }
    return out;
  }

  /** A bare NA packet (no link layer) for `target`. */
  function buildAdvert(ctx: ProcessCtx, view: PortView, target: Ipv6Address, dst: Ipv6Address, solicitedReply: boolean, triggeredBy?: number): Pdu {
    const icmp: Record<string, unknown> = {
      type: ICMPV6_NA,
      code: 0,
      target,
      routerFlag: ipv6RoutingEnabled(ctx),
      solicitedFlag: solicitedReply,
      overrideFlag: true,
    };
    if (framingOf(view) === 'ethernet') icmp.targetLla = ctx.macOf(view.id);
    const meta: Partial<PduMeta> = triggeredBy !== undefined ? { tag: 'nd-na', triggeredBy } : { tag: 'nd-na' };
    return ctx.newPdu(
      [
        { proto: 'ipv6', fields: { src: target, dst, nextHeader: IPPROTO_ICMPV6, hopLimit: IPV6_ND_HOP_LIMIT } },
        { proto: 'icmpv6', fields: icmp as LayerSpec['fields'] },
      ],
      { flow: flowKey(6, target, dst, 'icmpv6'), ...meta },
    );
  }

  /** Send an NA for `target` to `dst` framed straight to `dstMac` (Ethernet) or HDLC. */
  function advertise(ctx: ProcessCtx, view: PortView, target: Ipv6Address, dst: Ipv6Address, dstMac: MacAddress, solicitedReply: boolean, triggeredBy: number): Action[] {
    const icmp: Record<string, unknown> = {
      type: ICMPV6_NA,
      code: 0,
      target,
      routerFlag: ipv6RoutingEnabled(ctx),
      solicitedFlag: solicitedReply,
      overrideFlag: true,
    };
    if (framingOf(view) === 'ethernet') icmp.targetLla = ctx.macOf(view.id);
    const pdu = buildNd(ctx, view, target, dst, dstMac, icmp, { tag: 'nd-na', triggeredBy });
    naSent++;
    debug(ctx, `advertising ${target} to ${dst} on ${view.id}${solicitedReply ? ' (solicited)' : ''}`, { target, dst, port: view.id, pdu: pdu.id });
    return [{ type: 'send', port: view.id, pdu }];
  }

  function onAdvert(ctx: ProcessCtx, pdu: Pdu, view: PortView, dst: Ipv6Address, icmp: LayerView): Action[] {
    const out: Action[] = [];
    const port = view.id;
    const target = normalizeIpv6(String(icmp.fields.target ?? ''));
    const solicitedFlag = icmp.fields.solicitedFlag === true;
    const override = icmp.fields.overrideFlag === true;
    const routerFlag = icmp.fields.routerFlag === true;
    if (target === null || isMulticast6(target)) {
      out.push({ type: 'drop', pdu, reason: 'other', detail: 'neighbour advertisement with an invalid target', port });
      return out;
    }
    if (solicitedFlag && isMulticast6(dst)) {
      out.push({ type: 'drop', pdu, reason: 'other', detail: 'solicited neighbour advertisement sent to a multicast group', port });
      return out;
    }
    out.push({ type: 'consume', pdu });
    const dadKey = `${port}|${target}`;
    if (detections.has(dadKey)) {
      dadFailed(ctx, port, target, 'another node advertised it', out);
      return out;
    }
    if ((view.l3.ipv6 ?? []).some((a) => a.address === target)) {
      debug(ctx, `another node advertises my address ${target} on ${port}`, { target, port, pdu: pdu.id });
      return out;
    }
    if (framingOf(view) !== 'ethernet') return out;
    const key = ndKey(port, target);
    const n = nbrs.get(key);
    if (n === undefined) {
      debug(ctx, `unsolicited advertisement for ${target} on ${port} ignored: no cache entry`, { target, port, pdu: pdu.id });
      return out;
    }
    const lla = llaOf(icmp.fields.targetLla);
    if (n.state === 'INCOMPLETE') {
      if (lla === undefined) {
        debug(ctx, `advertisement for ${target} on ${port} carries no link-layer address`, { target, port, pdu: pdu.id });
        return out;
      }
      n.mac = lla;
      n.isRouter = routerFlag;
      n.probes = 0;
      if (solicitedFlag) {
        n.state = 'REACHABLE';
        out.push({ type: 'timer', key: `${TIMER_NBR}${key}`, delay: ND_REACHABLE_NS });
      } else {
        n.state = 'STALE';
        out.push({ type: 'cancelTimer', key: `${TIMER_NBR}${key}` });
      }
      writeRow(ctx, n);
      debug(ctx, `resolved ${target} to ${lla} on ${port} (${n.state.toLowerCase()})`, { target, mac: lla, port, pdu: pdu.id });
      flush(ctx, n, out);
      return out;
    }
    const same = lla === undefined || lla === n.mac;
    if (!override && !same) {
      if (n.state === 'REACHABLE') {
        n.state = 'STALE';
        out.push({ type: 'cancelTimer', key: `${TIMER_NBR}${key}` });
        writeRow(ctx, n);
        debug(ctx, `${target} on ${port} advertised another address without override: entry is stale`, { target, port, pdu: pdu.id });
      }
      return out;
    }
    if (lla !== undefined) n.mac = lla;
    n.isRouter = routerFlag;
    if (solicitedFlag) {
      n.state = 'REACHABLE';
      n.probes = 0;
      out.push({ type: 'timer', key: `${TIMER_NBR}${key}`, delay: ND_REACHABLE_NS });
    } else if (!same) {
      n.state = 'STALE';
      out.push({ type: 'cancelTimer', key: `${TIMER_NBR}${key}` });
    }
    writeRow(ctx, n);
    debug(ctx, `${target} on ${port} is at ${n.mac} (${n.state.toLowerCase()})`, { target, mac: n.mac, port, pdu: pdu.id });
    return out;
  }

  function onRouterSolicit(ctx: ProcessCtx, pdu: Pdu, view: PortView, src: Ipv6Address, icmp: LayerView): Action[] {
    const out: Action[] = [{ type: 'consume', pdu }];
    const port = view.id;
    if (!mayAdvertise(ctx, port, true)) {
      debug(ctx, `router solicitation from ${src} on ${port} ignored: not advertising here`, { port, pdu: pdu.id });
      return out;
    }
    const lla = llaOf(icmp.fields.sourceLla);
    if (lla !== undefined && !isUnspecified6(src) && framingOf(view) === 'ethernet') learnUnsolicited(ctx, port, src, lla, false, out);
    if (solicitPending.has(port)) {
      debug(ctx, `router solicitation from ${src} on ${port}: an answer is already scheduled`, { port, pdu: pdu.id });
      return out;
    }
    solicitPending.add(port);
    solicitTrigger.set(port, pdu.id);
    const delay = stream(ctx, 'ra-solicit').nextInt(0, ND_RA_RESPONSE_MAX_DELAY_NS);
    debug(ctx, `router solicitation from ${src} on ${port}: answering in ${delay} ns`, { port, pdu: pdu.id, delay });
    out.push({ type: 'timer', key: `${TIMER_RA_SOLICIT}${port}`, delay });
    return out;
  }

  function onRouterAdvert(ctx: ProcessCtx, pdu: Pdu, view: PortView, src: Ipv6Address, icmp: LayerView): Action[] {
    const out: Action[] = [];
    const port = view.id;
    if (!isLinkLocal6(src)) {
      out.push({ type: 'drop', pdu, reason: 'other', detail: 'router advertisement from a non-link-local source', port });
      return out;
    }
    out.push({ type: 'consume', pdu });
    if (ipv6RoutingEnabled(ctx)) {
      debug(ctx, `router advertisement from ${src} on ${port} ignored: this device routes IPv6`, { port, pdu: pdu.id });
      return out;
    }
    const f = icmp.fields;
    const lifetime = typeof f.routerLifetimeS === 'number' ? f.routerLifetimeS : 0;
    const lla = llaOf(f.sourceLla);
    if (lla !== undefined && framingOf(view) === 'ethernet') learnUnsolicited(ctx, port, src, lla, true, out);
    else {
      const n = nbrs.get(ndKey(port, src));
      if (n !== undefined && !n.isRouter) {
        n.isRouter = true;
        writeRow(ctx, n);
      }
    }
    if (soliciting.has(port)) debug(ctx, `router ${src} answered on ${port}: solicitation stops`, { port, pdu: pdu.id });
    stopRs(port, out);
    solicited.add(port);
    const req: Extract<ProcessRequest, { kind: 'ipv6.raLearned' }> = {
      kind: 'ipv6.raLearned',
      iface: port,
      router: src,
      managed: f.managedFlag === true,
      other: f.otherFlag === true,
      routerLifetimeS: lifetime,
    };
    if (typeof f.prefix === 'string') req.prefix = f.prefix;
    if (typeof f.prefixLen === 'number') req.prefixLen = f.prefixLen;
    if (typeof f.validLifetimeS === 'number') req.validLifetimeS = f.validLifetimeS;
    if (typeof f.preferredLifetimeS === 'number') req.preferredLifetimeS = f.preferredLifetimeS;
    debug(ctx, `router advertisement from ${src} on ${port}: lifetime ${lifetime} s${req.prefix !== undefined ? `, prefix ${req.prefix}/${String(req.prefixLen)}` : ''}`, {
      port, pdu: pdu.id, router: src,
    });
    out.push({ type: 'request', to: 'ipv6', req });
    return out;
  }

  /** Forget everything tied to `iface` (link down, IPv6 removed). */
  function purgeIface(ctx: ProcessCtx, iface: PortId, why: string): Action[] {
    const out: Action[] = [];
    const gone: Nbr[] = [];
    for (const n of nbrs.values()) if (n.iface === iface) gone.push(n);
    for (const n of gone) {
      for (const q of n.queue) out.push({ type: 'drop', pdu: q.pdu, reason: 'link-down', detail: `${iface} ${why}`, port: iface });
      n.queue = [];
      forget(ctx, n, 'link-down', out);
    }
    let dads = 0;
    for (const [key, d] of Array.from(detections)) {
      if (d.iface !== iface) continue;
      detections.delete(key);
      out.push({ type: 'cancelTimer', key: `${TIMER_DAD}${key}` });
      dads++;
    }
    stopRs(iface, out);
    solicited.delete(iface);
    stopRa(ctx, iface, out);
    solicitTrigger.delete(iface);
    if (gone.length > 0 || dads > 0) {
      debug(ctx, `${iface} ${why}: removed ${gone.length} neighbour entr${gone.length === 1 ? 'y' : 'ies'} and ${dads} detection(s)`, { iface });
    }
    return out;
  }

  return {
    name: NAME,

    onPdu(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
      return receive(ctx, pdu, port);
    },

    onTimer(ctx: ProcessCtx, key: string): Action[] {
      if (key.startsWith(TIMER_DAD)) return onDadTimer(ctx, key.slice(TIMER_DAD.length));
      if (key.startsWith(TIMER_NBR)) return onNeighbourTimer(ctx, key.slice(TIMER_NBR.length));
      if (key.startsWith(TIMER_RS)) return onRsTimer(ctx, key.slice(TIMER_RS.length));
      if (key.startsWith(TIMER_RA_SOLICIT)) return onRaTimer(ctx, key.slice(TIMER_RA_SOLICIT.length), false);
      if (key.startsWith(TIMER_RA)) return onRaTimer(ctx, key.slice(TIMER_RA.length), true);
      return [];
    },

    onConfig(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
      const out: Action[] = [];
      const line = delta.line;
      const head = delta.context[0];
      const named = delta.context.length === 1 && head !== undefined && head[0] === 'interface' ? head[1] : undefined;
      if (named !== undefined && line[0] === 'ipv6') {
        const iface = findPort6(ctx, named);
        if (iface === undefined) return out;
        if (interfaceIpv6Lines(ctx, iface).length === 0) return purgeIface(ctx, iface, 'has no IPv6 configuration');
        if (!mayAdvertise(ctx, iface, false)) stopRa(ctx, iface, out);
        else out.push(...armRa(ctx, iface, true));
        if (!maySolicit(ctx, iface, false)) {
          stopRs(iface, out);
          solicited.delete(iface);
        } else {
          out.push(...armRs(ctx, iface, true));
        }
        return out;
      }
      if (delta.context.length === 0 && (line[0] === 'ipv6' || (line[0] === 'no' && line[1] === 'ipv6'))) {
        for (const id of ctx.ports.keys()) {
          if (!mayAdvertise(ctx, id, false)) stopRa(ctx, id, out);
          else out.push(...armRa(ctx, id, true));
          if (ipv6RoutingEnabled(ctx)) stopRs(id, out);
        }
      }
      return out;
    },

    onLinkChange(ctx: ProcessCtx, port: PortId, up: boolean): Action[] {
      if (up) return [];
      return purgeIface(ctx, port, 'went down');
    },

    onRequest(ctx: ProcessCtx, req: ProcessRequest): Action[] {
      if (req.kind === 'nd.sendVia') return sendVia(ctx, req.pdu, req.nextHop, req.iface, req.cause);
      if (req.kind === 'nd.dad') return startDad(ctx, req.iface, req.address);
      return [];
    },

    stateSnapshot(): StateView {
      const neighbours: Record<string, unknown>[] = [];
      for (const n of nbrs.values()) neighbours.push({ ip: n.ip, iface: n.iface, mac: n.mac, state: n.state, isRouter: n.isRouter, queued: n.queue.length });
      const dads: Record<string, unknown>[] = [];
      for (const d of detections.values()) dads.push({ iface: d.iface, address: d.address });
      const rs: Record<string, unknown>[] = [];
      for (const [iface, s] of soliciting) rs.push({ iface, sent: s.sent });
      return {
        process: NAME,
        state: {
          neighbours,
          detections: dads,
          soliciting: rs,
          advertising: Array.from(advertising),
          nsSent,
          naSent,
          rsSent,
          raSent,
          duplicates,
          resolved,
          failed,
        },
      };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}
