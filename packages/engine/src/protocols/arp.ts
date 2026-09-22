/**
 * protocols/arp.ts — the ARP daemon and the L3 → L2 framer for hosts, routers and every device with an IP stack.
 *
 * Implements spec §2.1 (ARP row: request/reply, cache with timers, gratuitous ARP), §4.8 (process model: actions
 * out, `stateSnapshot()` is the UI truth, every transition emits a DebugEvent) and §9.4 (ARP cache visualizer:
 * every cache change goes through `tables.arp`), plus the ARCHITECTURE "Ping flow" (`arp.sendVia`), "Config flow"
 * (gratuitous ARP after `ip address`) and ARCHITECTURE-P1 §3.9 (IP over serial HDLC).
 *
 * Responsibilities
 *  • Receive (L3 roles only): answer requests for one of this device's addresses, learn the sender, flush packets
 *    waiting for that sender. Requests for other hosts refresh an existing row only.
 *  • `arp.sendVia` (from ipv4), by the egress port's effective encapsulation:
 *      hdlc     → no resolution: a bare packet is encapsulated in `hdlc {address 0x0f, control 0, protocol 0x0800}`,
 *                 a packet still carrying another link framing (forwarded from Ethernet) is rewrapped
 *                 `{strip: <framing layers>, push: [hdlc]}`, an HDLC-framed packet is sent unchanged;
 *      ethernet → cache hit → a bare packet is encapsulated, an Ethernet-framed packet gets its MAC pair rewritten
 *                 (MacRewrite), a packet framed by anything else (arrived over HDLC) is rewrapped
 *                 `{strip: <framing layers>, push: [ethernet]}` with a fresh header; miss → queue the packet
 *                 (5 per next hop, oldest dropped `queue-full`), write an Incomplete row, broadcast a request and
 *                 retry every `ARP_REQUEST_RETRY_NS` up to `ARP_REQUEST_RETRIES` requests, then drop the queue
 *                 `arp-unresolved` and remove the row.
 *  • `arp.gratuitous` request / `garp:<iface>` timer: announce an interface address (never on HDLC ports). P2
 *    (ARCHITECTURE-P2 §2.4, D15): with `address`/`mac` the request announces a VIRTUAL address from its MAC (sha and
 *    the Ethernet source are that MAC), as ipv4 asks after an `ipv4.virtual` add with `local` true.
 *  • Virtual addresses (P2 D15): a request for an address in the port's `l3.virtual4` list (an HSRP virtual IP, a
 *    NAT pool or static inside-global address) is answered with the virtual MAC, whatever its `local` flag.
 *  • Proxy ARP [S7] (P2 §5.2, D2; the delimited `[S7]` block): on a routing device, a request on an L3 port for a
 *    target that is not on that port's subnet but reachable through ANOTHER interface is answered with the port's
 *    own MAC. The two-state read of `proxyArpEnabled`: a stored `no ip proxy-arp` on the interface means off; an
 *    empty slot means the profile default (`ctx.profile`: on in P2 for a routed interface of a routing device, off
 *    in P1). A typed `ip proxy-arp` clears the slot and stores nothing, so in a P1 world it is a no-op.
 *  • `arp.probe` request (P1, APIPA conflict detection after RFC 5227 §2.1): `count` probes (default 3) sent
 *    `intervalNs` apart (default 1 s) on the non-periodic timer `arp-probe:<token>` — broadcast requests with
 *    spa 0.0.0.0, sha = the port MAC, tha 0 and tpa = the candidate address; no port address is needed. While the
 *    probe runs, a received ARP on that port whose spa is the candidate, or a request from spa 0.0.0.0 for the
 *    candidate from another MAC (a simultaneous probe), is a conflict: the timer is cancelled, the owner gets
 *    ProcessEvent `arp.probeResult {conflict: true, mac}` and the ARP cache is NOT touched. When the interval after
 *    the last probe ends without a conflict, the owner gets `{conflict: false}`.
 *  • Frames with sender address 0.0.0.0 (probes of other hosts) never create or refresh cache rows; a probe for one
 *    of our addresses is answered, which lets the prober see the conflict.
 *  • Cache ageing: periodic `arp-sweep` timer every 60 s calls `tables.arp.expire(now)`.
 *  • Link down: purge rows learned on the port and drop its pending packets.
 *
 * Cache lifetime comes from data, never from the device kind: `model.ipDefaults.arpTimeoutNs` (4 h on routing
 * devices, 20 min on hosts), else `ipDefaultsFor(model.capabilities)`.
 *
 * Timer keys (process-local): `arp-sweep` (periodic), `arp-retry:<iface>:<nextHop>`, `garp:<iface>`,
 * `arp-probe:<token>` (never periodic).
 *
 * StateView: `{ process: 'arp', state: { pending: [{ ip, iface, retries, requests, queued }],
 *   requestsSent, repliesSent, gratuitousSent, resolved, failed, probes?, proxyRepliesSent? } }` — `retries` counts
 *   retransmissions (requests - 1) for the entry still being resolved; `probes` (only while any runs) lists
 *   `[{ token, owner, iface, address, sent, count }]`; `proxyRepliesSent` [S7] appears once a proxy reply was sent.
 *
 * Debug category: `arp`.
 */
import { IPV4_ANY, MAC_BROADCAST, MAC_ZERO, broadcastOf, inSubnet, isIpv4, isIpv4Broadcast, normalizeMac } from '../contracts/addr.js';
import type { Ipv4Address, MacAddress } from '../contracts/addr.js';
import { KIND_ENCAP, L3_ROLES, ROLE_TRAITS, defaultRoleFor, ipDefaultsFor } from '../contracts/catalog.js';
import type { PortEncap, PortRole } from '../contracts/catalog.js';
import type { ConfigDelta } from '../contracts/config.js';
import type { PortId, ProcessName } from '../contracts/ids.js';
import { ARP_OP_REPLY, ARP_OP_REQUEST, ETHERTYPE_ARP, ETHERTYPE_IPV4, HDLC_ADDRESS_UNICAST, HDLC_PROTO_IPV4 } from '../contracts/pdu.js';
import type { LayerSpec, Pdu, RewrapOp } from '../contracts/pdu.js';
import type { PortView } from '../contracts/port.js';
import type { Action, DebugEvent, DemuxSelector, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import { ARP_REQUEST_RETRIES, ARP_REQUEST_RETRY_NS } from '../contracts/tables.js';
import type { ArpRow } from '../contracts/tables.js';
import { SEC } from '../contracts/time.js';
import type { SimTime } from '../contracts/time.js';
import { APIPA_PROBES, APIPA_PROBE_INTERVAL_NS } from '../contracts/services.js';
import type { ArpProbeResultEvent } from '../contracts/transport.js';
import { ipForwardingEnabled, virtualMacFor } from './ipv4.js';

/** Interval of the cache-ageing sweep. */
export const ARP_SWEEP_NS: SimTime = 60 * SEC;
/** Maximum packets queued per (iface, next-hop) while a resolution is outstanding. */
export const ARP_QUEUE_LIMIT = 5;
/** ARP frames from the wire, on ports whose role holds L3 addresses. */
export const ARP_HANDLES: readonly DemuxSelector[] = Object.freeze([
  Object.freeze({ layer: 'ethernet', ethertype: ETHERTYPE_ARP, roles: L3_ROLES }),
]) as readonly DemuxSelector[];
/** Link framing protocols that `arp.sendVia` strips when a packet changes framing (P2: an 802.1Q tag counts as framing). */
export const LINK_FRAMING_PROTOS: readonly string[] = Object.freeze(['ethernet', 'dot1q', 'hdlc', 'dot11', 'llc']);
/** Debug events retained per daemon (newest last). */
const DEBUG_RING = 256;
const TIMER_SWEEP = 'arp-sweep';
const TIMER_RETRY_PREFIX = 'arp-retry:';
const TIMER_GARP_PREFIX = 'garp:';
const TIMER_PROBE_PREFIX = 'arp-probe:';
const CATEGORY = 'arp';

/** A packet waiting for a resolution, with the cause its sender gave (matched route line). */
interface Queued {
  pdu: Pdu;
  cause?: string;
}

/** One outstanding resolution: `(iface, ip)` → queued packets and request count. */
interface Pending {
  ip: Ipv4Address;
  iface: PortId;
  /** Requests sent so far (the first one included). */
  requests: number;
  queue: Queued[];
}

/** Last gratuitous announcement per interface, used to collapse duplicates issued at the same instant. */
interface Announced {
  at: SimTime;
  address: Ipv4Address;
}

/** One running address probe (`arp.probe`). */
interface AddressProbe {
  owner: ProcessName;
  token: string;
  iface: PortId;
  address: Ipv4Address;
  /** Probes to send in total. */
  count: number;
  intervalNs: SimTime;
  /** Probes sent so far. */
  sent: number;
}

const pendingKey = (iface: PortId, ip: Ipv4Address): string => `${iface}|${ip}`;
const probeTimerKey = (token: string): string => `${TIMER_PROBE_PREFIX}${token}`;
const retryKey = (iface: PortId, ip: Ipv4Address): string => `${TIMER_RETRY_PREFIX}${iface}:${ip}`;
const garpKey = (iface: PortId): string => `${TIMER_GARP_PREFIX}${iface}`;

/** Effective encapsulation of a port: live encap, else the spec default for its kind. */
function encapOf(view: PortView): PortEncap {
  return view.encap ?? view.spec.encap ?? KIND_ENCAP[view.spec.kind];
}

/** Number of outermost layers of `pdu` that are link framing (0 for a bare IP packet). */
export function leadingFramingLayers(pdu: Pick<Pdu, 'layers'>): number {
  let n = 0;
  while (n < pdu.layers.length && LINK_FRAMING_PROTOS.includes(pdu.layers[n]!.proto)) n++;
  return n;
}

/** ARP cache lifetime of the device: `model.ipDefaults.arpTimeoutNs`, else the capability-derived default. */
export function arpCacheTimeout(ctx: Pick<ProcessCtx, 'model'>): SimTime {
  return ctx.model.ipDefaults?.arpTimeoutNs ?? ipDefaultsFor(ctx.model.capabilities ?? []).arpTimeoutNs;
}

/** Structural rewrap through the ctx (trace-mirrored) when available, else directly on the PDU (still recorded). */
function rewrapPdu(ctx: ProcessCtx, pdu: Pdu, op: RewrapOp, cause: string | undefined): void {
  if (ctx.rewrap !== undefined) ctx.rewrap(pdu, op, cause);
  else pdu.rewrap({ now: ctx.now, device: ctx.deviceId }, op, cause);
}

// ── [S7] proxy ARP ───────────────────────────────────────────────────────────

/** Effective role of a port view (live role, else the spec default for the model capabilities). */
function roleOfView(ctx: Pick<ProcessCtx, 'model'>, view: PortView): PortRole {
  return view.role ?? view.spec.role ?? defaultRoleFor(view.spec.kind, ctx.model.capabilities ?? []);
}

/**
 * [S7] The two-state proxy ARP read of `iface` (ARCHITECTURE-P2 §5.2, D2): a stored `no ip proxy-arp` under
 * `interface <iface>` means off; an empty slot means the profile default — on in the P2 profile for a routed (L3)
 * interface of a routing device, off in the P1 profile. `ip proxy-arp` stores nothing (storeNegation), so typing it
 * in a P1 world changes nothing.
 */
export function proxyArpEnabled(ctx: Pick<ProcessCtx, 'config' | 'profile' | 'model' | 'ports'>, iface: PortId): boolean {
  const lower = iface.toLowerCase();
  for (const section of ctx.config.root.children) {
    if (section.key !== 'interface') continue;
    const name = section.args[0];
    if (name === undefined || (name !== iface && name.toLowerCase() !== lower)) continue;
    for (const c of section.children) {
      if (c.key === 'no' && c.args.length === 2 && c.args[0] === 'ip' && c.args[1] === 'proxy-arp') return false;
    }
  }
  if (ctx.profile !== 'P2' || !ctx.model.ipForwarding) return false;
  const view = ctx.ports.get(iface);
  return view !== undefined && ROLE_TRAITS[roleOfView(ctx, view)].l3;
}

/**
 * [S7] The egress interface through which this device would forward to `target`, when proxy ARP on `port` should
 * answer for it: proxy ARP on, routing on, the target off the port's own subnet and reachable through another
 * interface. Undefined otherwise.
 */
function proxyArpVia(ctx: ProcessCtx, port: PortId, target: Ipv4Address): PortId | undefined {
  if (!proxyArpEnabled(ctx, port) || !ipForwardingEnabled(ctx)) return undefined;
  const l3 = ctx.ports.get(port)?.l3.ipv4;
  if (l3 === undefined || inSubnet(target, l3.address, l3.prefixLen)) return undefined;
  const via = ctx.sourceFor(target)?.iface;
  return via === undefined || via === port ? undefined : via;
}

// ── end [S7] ─────────────────────────────────────────────────────────────────

/** The arp daemon (`Process` with name `'arp'`), one instance per device. */
export function createArp(): Process {
  const pending = new Map<string, Pending>();
  const announced = new Map<PortId, Announced>();
  const probes = new Map<string, AddressProbe>();
  const debugRing: DebugEvent[] = [];
  let requestsSent = 0;
  let repliesSent = 0;
  let gratuitousSent = 0;
  let resolved = 0;
  let failed = 0;
  /** [S7] Proxy replies sent (shown only once non-zero). */
  let proxyRepliesSent = 0;

  function debug(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: CATEGORY, category: CATEGORY, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: CATEGORY, category: CATEGORY, message };
    debugRing.push(ev);
    if (debugRing.length > DEBUG_RING) debugRing.splice(0, debugRing.length - DEBUG_RING);
    ctx.debug(CATEGORY, message, data);
  }

  function addressOf(ctx: ProcessCtx, iface: PortId): Ipv4Address | undefined {
    return ctx.ports.get(iface)?.l3.ipv4?.address;
  }

  /** Put an Ethernet header on `pdu` for `dstMac` out of `iface`: encapsulate, rewrite the MACs, or rewrap. */
  function frameEthernet(ctx: ProcessCtx, pdu: Pdu, dstMac: MacAddress, iface: PortId, cause?: string): void {
    const src = ctx.macOf(iface);
    const framing = leadingFramingLayers(pdu);
    if (framing === 0) {
      ctx.encapsulate(pdu, { proto: 'ethernet', fields: { dst: dstMac, src, type: ETHERTYPE_IPV4 } }, cause);
    } else if (framing === 1 && pdu.layers[0]!.proto === 'ethernet') {
      ctx.mutate(pdu, 'ethernet.src', src, 'MacRewrite', cause);
      ctx.mutate(pdu, 'ethernet.dst', dstMac, 'MacRewrite', cause);
    } else {
      const outer: LayerSpec = { proto: 'ethernet', fields: { dst: dstMac, src, type: ETHERTYPE_IPV4 } };
      rewrapPdu(ctx, pdu, { strip: framing, push: [outer] }, cause);
    }
  }

  /** Put an HDLC header on `pdu` (serial point-to-point: no addresses to resolve). */
  function frameHdlc(ctx: ProcessCtx, pdu: Pdu, cause?: string): void {
    const outer: LayerSpec = { proto: 'hdlc', fields: { address: HDLC_ADDRESS_UNICAST, control: 0, protocol: HDLC_PROTO_IPV4 } };
    const framing = leadingFramingLayers(pdu);
    if (framing === 0) ctx.encapsulate(pdu, outer, cause);
    else if (framing === 1 && pdu.layers[0]!.proto === 'hdlc') return;
    else rewrapPdu(ctx, pdu, { strip: framing, push: [outer] }, cause);
  }

  /** Write (or refresh) a complete row for `ip`, then release anything queued for it on `iface`. */
  function learn(ctx: ProcessCtx, ip: Ipv4Address, mac: MacAddress, iface: PortId, out: Action[]): void {
    const previous = ctx.tables.arp.get(ip);
    const row: ArpRow = {
      key: ip,
      ip,
      mac,
      iface,
      type: 'dynamic',
      updatedAt: ctx.now,
      expiresAt: ctx.now + arpCacheTimeout(ctx),
    };
    ctx.tables.arp.set(row);
    if (previous === undefined) {
      debug(ctx, `learned ${ip} is at ${mac} on ${iface}`, { ip, mac, iface });
    } else if (previous.incomplete) {
      debug(ctx, `resolved ${ip} to ${mac} on ${iface}`, { ip, mac, iface });
    } else if (previous.mac !== mac || previous.iface !== iface) {
      debug(ctx, `updated ${ip}: now at ${mac} on ${iface} (was ${previous.mac} on ${previous.iface})`, { ip, mac, iface, previousMac: previous.mac });
    } else {
      debug(ctx, `refreshed ${ip} at ${mac} on ${iface}`, { ip, mac, iface });
    }
    flush(ctx, ip, mac, iface, out);
  }

  /** Send every packet waiting for `ip` on `iface`, in queue order, and forget the resolution. */
  function flush(ctx: ProcessCtx, ip: Ipv4Address, mac: MacAddress, iface: PortId, out: Action[]): void {
    const key = pendingKey(iface, ip);
    const p = pending.get(key);
    if (p === undefined) return;
    pending.delete(key);
    out.push({ type: 'cancelTimer', key: retryKey(iface, ip) });
    resolved++;
    debug(ctx, `releasing ${p.queue.length} packet(s) waiting for ${ip} on ${iface}`, { ip, iface, count: p.queue.length });
    for (let i = 0; i < p.queue.length; i++) {
      const q = p.queue[i]!;
      frameEthernet(ctx, q.pdu, mac, iface, q.cause);
      out.push({ type: 'send', port: iface, pdu: q.pdu });
    }
  }

  /** Drop every queued packet of `p` and forget it (row removal is the caller's choice). */
  function abandon(ctx: ProcessCtx, p: Pending, reason: 'arp-unresolved' | 'link-down' | 'no-l3-address', detail: string, out: Action[]): void {
    pending.delete(pendingKey(p.iface, p.ip));
    out.push({ type: 'cancelTimer', key: retryKey(p.iface, p.ip) });
    for (let i = 0; i < p.queue.length; i++) {
      out.push({ type: 'drop', pdu: p.queue[i]!.pdu, reason, detail, port: p.iface });
    }
  }

  function sendRequest(ctx: ProcessCtx, p: Pending, out: Action[]): boolean {
    const spa = addressOf(ctx, p.iface);
    if (spa === undefined) return false;
    const sha = ctx.macOf(p.iface);
    const first = p.queue[0];
    const meta = first ? { triggeredBy: first.pdu.id, tag: 'arp-request' } : { tag: 'arp-request' };
    const req = ctx.newPdu(
      [
        { proto: 'ethernet', fields: { dst: MAC_BROADCAST, src: sha, type: ETHERTYPE_ARP } },
        { proto: 'arp', fields: { op: ARP_OP_REQUEST, sha, spa, tha: MAC_ZERO, tpa: p.ip } },
      ],
      meta,
    );
    p.requests++;
    requestsSent++;
    out.push({ type: 'send', port: p.iface, pdu: req });
    out.push({ type: 'timer', key: retryKey(p.iface, p.ip), delay: ARP_REQUEST_RETRY_NS });
    debug(ctx, `sending request ${p.requests}/${ARP_REQUEST_RETRIES} for ${p.ip} on ${p.iface} (${spa} asking)`, {
      ip: p.ip, iface: p.iface, request: p.requests, pdu: req.id,
    });
    return true;
  }

  function sendVia(ctx: ProcessCtx, pdu: Pdu, nextHop: Ipv4Address, iface: PortId, cause: string | undefined): Action[] {
    const out: Action[] = [];
    const port = ctx.ports.get(iface);
    if (port === undefined || !port.operUp) {
      debug(ctx, `cannot reach ${nextHop}: ${iface} is down`, { ip: nextHop, iface, pdu: pdu.id });
      out.push({ type: 'drop', pdu, reason: 'link-down', detail: `${iface} is down`, port: iface });
      return out;
    }
    // Serial point-to-point: the far end is the only station, nothing to resolve.
    if (encapOf(port) === 'hdlc') {
      frameHdlc(ctx, pdu, cause);
      debug(ctx, `framing for ${nextHop} on ${iface}: serial HDLC link, no address resolution`, { ip: nextHop, iface, pdu: pdu.id });
      out.push({ type: 'send', port: iface, pdu });
      return out;
    }
    // Limited or directed subnet broadcast: never resolved, framed to ff:ff:ff:ff:ff:ff.
    const l3 = port.l3.ipv4;
    if (isIpv4Broadcast(nextHop) || (l3 !== undefined && l3.prefixLen < 31 && nextHop === broadcastOf(l3.address, l3.prefixLen))) {
      debug(ctx, `sending to broadcast ${nextHop} on ${iface}`, { ip: nextHop, iface, pdu: pdu.id });
      frameEthernet(ctx, pdu, MAC_BROADCAST, iface, cause);
      out.push({ type: 'send', port: iface, pdu });
      return out;
    }
    const row = ctx.tables.arp.get(nextHop);
    if (row !== undefined && !row.incomplete && row.mac !== MAC_ZERO) {
      debug(ctx, `cache hit for ${nextHop}: ${row.mac} on ${iface}`, { ip: nextHop, mac: row.mac, iface, pdu: pdu.id });
      frameEthernet(ctx, pdu, row.mac, iface, cause);
      out.push({ type: 'send', port: iface, pdu });
      return out;
    }
    const key = pendingKey(iface, nextHop);
    let p = pending.get(key);
    if (p !== undefined) {
      enqueue(ctx, p, pdu, cause, out);
      debug(ctx, `queued packet for ${nextHop} on ${iface} (resolution already in progress, ${p.queue.length} waiting)`, {
        ip: nextHop, iface, pdu: pdu.id, queued: p.queue.length,
      });
      return out;
    }
    if (addressOf(ctx, iface) === undefined) {
      debug(ctx, `cannot resolve ${nextHop}: ${iface} has no address`, { ip: nextHop, iface, pdu: pdu.id });
      out.push({ type: 'drop', pdu, reason: 'no-l3-address', detail: `${iface} has no address to ask from`, port: iface });
      return out;
    }
    p = { ip: nextHop, iface, requests: 0, queue: [] };
    pending.set(key, p);
    enqueue(ctx, p, pdu, cause, out);
    ctx.tables.arp.set({
      key: nextHop,
      ip: nextHop,
      mac: MAC_ZERO,
      iface,
      type: 'dynamic',
      incomplete: true,
      updatedAt: ctx.now,
      expiresAt: ctx.now + ARP_REQUEST_RETRIES * ARP_REQUEST_RETRY_NS + SEC,
    });
    debug(ctx, `cache miss for ${nextHop} on ${iface}: resolving`, { ip: nextHop, iface, pdu: pdu.id });
    sendRequest(ctx, p, out);
    return out;
  }

  function enqueue(ctx: ProcessCtx, p: Pending, pdu: Pdu, cause: string | undefined, out: Action[]): void {
    if (p.queue.length >= ARP_QUEUE_LIMIT) {
      const oldest = p.queue.shift()!;
      debug(ctx, `queue for ${p.ip} on ${p.iface} is full: discarding oldest packet`, { ip: p.ip, iface: p.iface, pdu: oldest.pdu.id });
      out.push({ type: 'drop', pdu: oldest.pdu, reason: 'queue-full', detail: `${ARP_QUEUE_LIMIT} packets already waiting for ${p.ip}`, port: p.iface });
    }
    p.queue.push(cause !== undefined ? { pdu, cause } : { pdu });
  }

  /**
   * Announce the interface address from the port MAC, or (P2, D15) `virtualAddress` from `virtualMac` (default: the
   * port MAC). A virtual announcement is deduplicated per (iface, address); the interface one per iface, as before.
   */
  function gratuitous(ctx: ProcessCtx, iface: PortId, virtualAddress?: Ipv4Address, virtualMac?: MacAddress): Action[] {
    const out: Action[] = [];
    const port = ctx.ports.get(iface);
    const address = virtualAddress ?? port?.l3.ipv4?.address;
    if (port === undefined || !port.operUp || address === undefined) {
      debug(ctx, `no announcement for ${iface}: ${port === undefined ? 'unknown port' : !port.operUp ? 'port is down' : 'no address'}`, { iface });
      return out;
    }
    if (encapOf(port) !== 'ethernet') {
      debug(ctx, `no announcement for ${iface}: the link does not use ARP`, { iface, address });
      return out;
    }
    const dedupeKey = virtualAddress === undefined ? iface : `${iface}|${virtualAddress}`;
    const last = announced.get(dedupeKey);
    if (last !== undefined && last.at === ctx.now && last.address === address) {
      debug(ctx, `announcement of ${address} on ${iface} already sent`, { iface, address });
      return out;
    }
    announced.set(dedupeKey, { at: ctx.now, address });
    const mac = virtualAddress !== undefined ? (virtualMac ?? ctx.macOf(iface)) : ctx.macOf(iface);
    const pdu = ctx.newPdu(
      [
        { proto: 'ethernet', fields: { dst: MAC_BROADCAST, src: mac, type: ETHERTYPE_ARP } },
        { proto: 'arp', fields: { op: ARP_OP_REQUEST, sha: mac, spa: address, tha: MAC_ZERO, tpa: address } },
      ],
      { tag: 'arp-gratuitous' },
    );
    gratuitousSent++;
    out.push({ type: 'send', port: iface, pdu });
    debug(ctx, `announcing ${address} is at ${mac} on ${iface}${virtualAddress !== undefined ? ' (virtual address)' : ''}`, { iface, address, mac, pdu: pdu.id });
    return out;
  }

  /** Remove rows learned on `iface` and drop packets waiting on it. */
  function purgeIface(ctx: ProcessCtx, iface: PortId, rowReason: 'link-down' | 'cleared', dropReason: 'link-down' | 'no-l3-address', detail: string, out: Action[]): void {
    const rows = ctx.tables.arp.find((r) => r.iface === iface);
    for (let i = 0; i < rows.length; i++) ctx.tables.arp.delete(rows[i]!.key, rowReason);
    const gone: Pending[] = [];
    for (const p of pending.values()) if (p.iface === iface) gone.push(p);
    for (let i = 0; i < gone.length; i++) abandon(ctx, gone[i]!, dropReason, detail, out);
    if (rows.length > 0 || gone.length > 0) {
      debug(ctx, `${detail}: removed ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} and ${gone.length} pending resolution(s) on ${iface}`, {
        iface, rows: rows.length, pending: gone.length,
      });
    }
  }

  function onRetry(ctx: ProcessCtx, iface: PortId, ip: Ipv4Address): Action[] {
    const out: Action[] = [];
    const p = pending.get(pendingKey(iface, ip));
    if (p === undefined) return out;
    const port = ctx.ports.get(iface);
    if (port === undefined || !port.operUp) {
      failed++;
      debug(ctx, `giving up on ${ip}: ${iface} is down`, { ip, iface });
      abandon(ctx, p, 'link-down', `${iface} is down`, out);
      ctx.tables.arp.delete(ip, 'link-down');
      return out;
    }
    if (p.requests < ARP_REQUEST_RETRIES) {
      if (!sendRequest(ctx, p, out)) {
        failed++;
        debug(ctx, `giving up on ${ip}: ${iface} has no address`, { ip, iface });
        abandon(ctx, p, 'no-l3-address', `${iface} has no address to ask from`, out);
        ctx.tables.arp.delete(ip, 'cleared');
      }
      return out;
    }
    failed++;
    const detail = `no reply from ${ip} after ${p.requests} requests`;
    debug(ctx, `giving up on ${ip}: ${detail}; discarding ${p.queue.length} packet(s)`, { ip, iface, queued: p.queue.length });
    abandon(ctx, p, 'arp-unresolved', detail, out);
    ctx.tables.arp.delete(ip, 'aged');
    return out;
  }

  function onSweep(ctx: ProcessCtx): Action[] {
    const removed = ctx.tables.arp.expire(ctx.now);
    for (let i = 0; i < removed.length; i++) {
      const r = removed[i]!;
      debug(ctx, `entry for ${r.ip} on ${r.iface} timed out`, { ip: r.ip, iface: r.iface, mac: r.mac });
    }
    return [{ type: 'timer', key: TIMER_SWEEP, delay: ARP_SWEEP_NS, periodic: true }];
  }

  // ── address probes (APIPA conflict detection) ────────────────────────────

  /** Report a probe outcome to its owner and forget the probe. */
  function probeResult(ctx: ProcessCtx, probe: AddressProbe, conflict: boolean, mac: MacAddress | undefined, out: Action[]): void {
    probes.delete(probe.token);
    out.push({ type: 'cancelTimer', key: probeTimerKey(probe.token) });
    const ev: ArpProbeResultEvent = mac === undefined
      ? { kind: 'arp.probeResult', token: probe.token, iface: probe.iface, address: probe.address, conflict }
      : { kind: 'arp.probeResult', token: probe.token, iface: probe.iface, address: probe.address, conflict, mac };
    out.push({ type: 'event', to: probe.owner, ev });
    if (conflict) {
      debug(ctx, `probe for ${probe.address} on ${probe.iface}: address already used by ${mac ?? 'another station'}`, {
        token: probe.token, iface: probe.iface, ip: probe.address, mac, conflict,
      });
    } else {
      debug(ctx, `probe for ${probe.address} on ${probe.iface}: no answer after ${probe.sent} probe(s), address is free`, {
        token: probe.token, iface: probe.iface, ip: probe.address, conflict,
      });
    }
  }

  /** Send the next probe of `probe` and arm the interval timer. */
  function sendProbe(ctx: ProcessCtx, probe: AddressProbe, out: Action[]): void {
    const sha = ctx.macOf(probe.iface);
    const pdu = ctx.newPdu(
      [
        { proto: 'ethernet', fields: { dst: MAC_BROADCAST, src: sha, type: ETHERTYPE_ARP } },
        { proto: 'arp', fields: { op: ARP_OP_REQUEST, sha, spa: IPV4_ANY, tha: MAC_ZERO, tpa: probe.address } },
      ],
      { tag: 'arp-probe' },
    );
    probe.sent++;
    out.push({ type: 'send', port: probe.iface, pdu });
    out.push({ type: 'timer', key: probeTimerKey(probe.token), delay: probe.intervalNs });
    debug(ctx, `probe ${probe.sent}/${probe.count} for ${probe.address} on ${probe.iface}`, {
      token: probe.token, iface: probe.iface, ip: probe.address, probe: probe.sent, pdu: pdu.id,
    });
  }

  function startProbe(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'arp.probe' }>): Action[] {
    const out: Action[] = [];
    const previous = probes.get(req.token);
    if (previous !== undefined) {
      probes.delete(req.token);
      out.push({ type: 'cancelTimer', key: probeTimerKey(req.token) });
    }
    const probe: AddressProbe = {
      owner: req.owner,
      token: req.token,
      iface: req.iface,
      address: req.address,
      count: Math.max(1, Math.floor(req.count ?? APIPA_PROBES)),
      intervalNs: Math.max(0, Math.round(req.intervalNs ?? APIPA_PROBE_INTERVAL_NS)),
      sent: 0,
    };
    const port = ctx.ports.get(req.iface);
    if (port === undefined || !isIpv4(req.address) || encapOf(port) !== 'ethernet') {
      const why = port === undefined ? 'unknown interface' : !isIpv4(req.address) ? 'invalid address' : 'the link does not use ARP';
      debug(ctx, `probe for ${req.address} on ${req.iface} not sent: ${why}`, { token: req.token, iface: req.iface, ip: req.address });
      const ev: ArpProbeResultEvent = { kind: 'arp.probeResult', token: req.token, iface: req.iface, address: req.address, conflict: false };
      out.push({ type: 'event', to: req.owner, ev });
      return out;
    }
    probes.set(probe.token, probe);
    sendProbe(ctx, probe, out);
    return out;
  }

  function onProbeTimer(ctx: ProcessCtx, token: string): Action[] {
    const out: Action[] = [];
    const probe = probes.get(token);
    if (probe === undefined) return out;
    if (probe.sent < probe.count) sendProbe(ctx, probe, out);
    else probeResult(ctx, probe, false, undefined, out);
    return out;
  }

  /**
   * Conflict check of a received ARP against the probes running on `port` (RFC 5227 §2.1.1): the sender claims the
   * candidate, or another station probes the same candidate. Returns true when at least one probe ended.
   */
  function probeConflicts(ctx: ProcessCtx, port: PortId, op: unknown, sha: MacAddress, spa: Ipv4Address, tpa: Ipv4Address, out: Action[]): boolean {
    if (probes.size === 0) return false;
    const myMac = ctx.macOf(port);
    const hit: AddressProbe[] = [];
    for (const p of probes.values()) {
      if (p.iface !== port) continue;
      if (spa === p.address || (op === ARP_OP_REQUEST && spa === IPV4_ANY && tpa === p.address && sha !== myMac)) hit.push(p);
    }
    for (let i = 0; i < hit.length; i++) probeResult(ctx, hit[i]!, true, sha, out);
    return hit.length > 0;
  }

  function receive(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
    const out: Action[] = [];
    const arp = pdu.layer('arp');
    if (arp === undefined) {
      out.push({ type: 'drop', pdu, reason: 'other', detail: 'frame carries no ARP header', port });
      return out;
    }
    const f = arp.fields;
    const op = f.op;
    const sha = typeof f.sha === 'string' ? normalizeMac(f.sha) : null;
    const tha = typeof f.tha === 'string' ? normalizeMac(f.tha) : null;
    const spa = typeof f.spa === 'string' && isIpv4(f.spa) ? f.spa : null;
    const tpa = typeof f.tpa === 'string' && isIpv4(f.tpa) ? f.tpa : null;
    let problem: string | undefined;
    if (arp.error !== undefined) problem = arp.error;
    else if (op !== ARP_OP_REQUEST && op !== ARP_OP_REPLY) problem = `unsupported operation ${String(op)}`;
    else if (f.hlen !== 6 || f.plen !== 4) problem = `unsupported address sizes (hardware ${String(f.hlen)}, protocol ${String(f.plen)})`;
    else if (sha === null || tha === null || spa === null || tpa === null) problem = 'malformed addresses';
    if (problem !== undefined || sha === null || tha === null || spa === null || tpa === null) {
      debug(ctx, `ignoring frame on ${port}: ${problem ?? 'malformed addresses'}`, { port, pdu: pdu.id });
      out.push({ type: 'drop', pdu, reason: 'other', detail: problem ?? 'malformed addresses', port });
      return out;
    }
    if (probeConflicts(ctx, port, op, sha, spa, tpa, out)) return out;
    const myMac = ctx.macOf(port);
    if (spa === IPV4_ANY) {
      // A probe from a station without an address (RFC 5227): never cached; a probe for our address is answered.
      if (op === ARP_OP_REQUEST && ctx.ownAddress(tpa) === port && sha !== myMac) {
        const reply = ctx.newPdu(
          [
            { proto: 'ethernet', fields: { dst: sha, src: myMac, type: ETHERTYPE_ARP } },
            { proto: 'arp', fields: { op: ARP_OP_REPLY, sha: myMac, spa: tpa, tha: sha, tpa: IPV4_ANY } },
          ],
          { triggeredBy: pdu.id, tag: 'arp-reply' },
        );
        repliesSent++;
        out.push({ type: 'consume', pdu });
        out.push({ type: 'send', port, pdu: reply });
        debug(ctx, `probe from ${sha} on ${port} asks for my address ${tpa}: defending it`, { port, ip: tpa, mac: sha, pdu: pdu.id, reply: reply.id });
      } else {
        debug(ctx, `probe from ${sha} for ${tpa} on ${port} ignored (no sender address)`, { port, target: tpa, mac: sha, pdu: pdu.id });
      }
      return out;
    }
    if (ctx.ownAddress(spa) !== undefined) {
      if (sha !== myMac) {
        debug(ctx, `another station (${sha}) claims my address ${spa} on ${port}`, { port, ip: spa, mac: sha, pdu: pdu.id });
      } else {
        debug(ctx, `ignoring my own frame for ${spa} seen back on ${port}`, { port, ip: spa, pdu: pdu.id });
      }
      return out;
    }
    const known = ctx.tables.arp.get(spa);
    if (op === ARP_OP_REQUEST) {
      if (ctx.ownAddress(tpa) === port) {
        debug(ctx, `request for ${tpa} from ${spa} (${sha}) on ${port}: replying`, { port, ip: spa, mac: sha, target: tpa, pdu: pdu.id });
        out.push({ type: 'consume', pdu });
        learn(ctx, spa, sha, port, out);
        const reply = ctx.newPdu(
          [
            { proto: 'ethernet', fields: { dst: sha, src: myMac, type: ETHERTYPE_ARP } },
            { proto: 'arp', fields: { op: ARP_OP_REPLY, sha: myMac, spa: tpa, tha: sha, tpa: spa } },
          ],
          { triggeredBy: pdu.id, tag: 'arp-reply' },
        );
        repliesSent++;
        out.push({ type: 'send', port, pdu: reply });
        debug(ctx, `replied to ${spa}: ${tpa} is at ${myMac}`, { port, ip: tpa, mac: myMac, to: spa, pdu: reply.id });
        return out;
      }
      // P2 (D15): a virtual address of this port is answered with its virtual MAC (the Ethernet source too)
      const virtualMac = virtualMacFor(ctx.ports.get(port), tpa);
      if (virtualMac !== undefined) {
        debug(ctx, `request for virtual address ${tpa} from ${spa} (${sha}) on ${port}: replying from ${virtualMac}`, { port, ip: spa, mac: sha, target: tpa, pdu: pdu.id });
        out.push({ type: 'consume', pdu });
        learn(ctx, spa, sha, port, out);
        const reply = ctx.newPdu(
          [
            { proto: 'ethernet', fields: { dst: sha, src: virtualMac, type: ETHERTYPE_ARP } },
            { proto: 'arp', fields: { op: ARP_OP_REPLY, sha: virtualMac, spa: tpa, tha: sha, tpa: spa } },
          ],
          { triggeredBy: pdu.id, tag: 'arp-reply' },
        );
        repliesSent++;
        out.push({ type: 'send', port, pdu: reply });
        debug(ctx, `replied to ${spa}: ${tpa} is at ${virtualMac}`, { port, ip: tpa, mac: virtualMac, to: spa, pdu: reply.id });
        return out;
      }
      // [S7] proxy ARP: answer for a target reachable through another interface with this port's own MAC
      const proxyVia = proxyArpVia(ctx, port, tpa);
      if (proxyVia !== undefined) {
        debug(ctx, `proxy reply to ${spa} for ${tpa} on ${port}: reachable through ${proxyVia}`, { port, ip: spa, target: tpa, via: proxyVia, pdu: pdu.id });
        out.push({ type: 'consume', pdu });
        learn(ctx, spa, sha, port, out);
        const reply = ctx.newPdu(
          [
            { proto: 'ethernet', fields: { dst: sha, src: myMac, type: ETHERTYPE_ARP } },
            { proto: 'arp', fields: { op: ARP_OP_REPLY, sha: myMac, spa: tpa, tha: sha, tpa: spa } },
          ],
          { triggeredBy: pdu.id, tag: 'arp-reply' },
        );
        repliesSent++;
        proxyRepliesSent++;
        out.push({ type: 'send', port, pdu: reply });
        debug(ctx, `replied to ${spa} on behalf of ${tpa}: at ${myMac} (proxy)`, { port, ip: tpa, mac: myMac, to: spa, pdu: reply.id });
        return out;
      }
      if (known !== undefined && !known.incomplete) {
        learn(ctx, spa, sha, port, out);
      } else {
        debug(ctx, `request for ${tpa} from ${spa} on ${port} is for another host`, { port, ip: spa, target: tpa, pdu: pdu.id });
      }
      return out;
    }
    // reply
    const ethDst = pdu.get('ethernet.dst');
    const forMe = ctx.ownAddress(tpa) === port || tha === myMac || (typeof ethDst === 'string' && normalizeMac(ethDst) === myMac);
    if (forMe) {
      debug(ctx, `reply on ${port}: ${spa} is at ${sha}`, { port, ip: spa, mac: sha, pdu: pdu.id });
      out.push({ type: 'consume', pdu });
      learn(ctx, spa, sha, port, out);
      return out;
    }
    if (known !== undefined && !known.incomplete) {
      learn(ctx, spa, sha, port, out);
    } else {
      debug(ctx, `reply on ${port} from ${spa} is for another host (${tpa})`, { port, ip: spa, target: tpa, pdu: pdu.id });
    }
    return out;
  }

  return {
    name: 'arp',
    handles: ARP_HANDLES,

    init(ctx: ProcessCtx): Action[] {
      const timeout = arpCacheTimeout(ctx);
      debug(ctx, `cache ageing every ${ARP_SWEEP_NS / SEC} s, entries live ${timeout / SEC} s`, {
        sweepNs: ARP_SWEEP_NS, timeoutNs: timeout,
      });
      return [{ type: 'timer', key: TIMER_SWEEP, delay: ARP_SWEEP_NS, periodic: true }];
    },

    onPdu(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
      return receive(ctx, pdu, port);
    },

    onTimer(ctx: ProcessCtx, key: string): Action[] {
      if (key === TIMER_SWEEP) return onSweep(ctx);
      if (key.startsWith(TIMER_RETRY_PREFIX)) {
        const rest = key.slice(TIMER_RETRY_PREFIX.length);
        const sep = rest.lastIndexOf(':');
        if (sep <= 0) return [];
        return onRetry(ctx, rest.slice(0, sep), rest.slice(sep + 1));
      }
      if (key.startsWith(TIMER_GARP_PREFIX)) return gratuitous(ctx, key.slice(TIMER_GARP_PREFIX.length));
      if (key.startsWith(TIMER_PROBE_PREFIX)) return onProbeTimer(ctx, key.slice(TIMER_PROBE_PREFIX.length));
      return [];
    },

    onConfig(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
      const out: Action[] = [];
      const section = delta.context[0];
      if (delta.context.length !== 1 || section === undefined || section[0] !== 'interface') return out;
      const iface = section[1];
      if (iface === undefined || delta.line[0] !== 'ip' || delta.line[1] !== 'address') return out;
      if (delta.op === 'set') {
        const before = delta.before?.[0];
        if (before !== undefined && before !== delta.line[2]) {
          purgeIface(ctx, iface, 'cleared', 'no-l3-address', `address of ${iface} changed`, out);
        }
        // The ipv4 daemon applies the address after this hook (process order); announce
        // from a separate event once every process has seen the delta.
        out.push({ type: 'timer', key: garpKey(iface), delay: 0 });
        return out;
      }
      out.push({ type: 'cancelTimer', key: garpKey(iface) });
      purgeIface(ctx, iface, 'cleared', 'no-l3-address', `address removed from ${iface}`, out);
      return out;
    },

    onLinkChange(ctx: ProcessCtx, port: PortId, up: boolean): Action[] {
      const out: Action[] = [];
      if (up) return out;
      purgeIface(ctx, port, 'link-down', 'link-down', `${port} went down`, out);
      return out;
    },

    onRequest(ctx: ProcessCtx, req: ProcessRequest): Action[] {
      if (req.kind === 'arp.sendVia') return sendVia(ctx, req.pdu, req.nextHop, req.iface, req.cause);
      if (req.kind === 'arp.gratuitous') return gratuitous(ctx, req.iface, req.address, req.mac);
      if (req.kind === 'arp.probe') return startProbe(ctx, req);
      return [];
    },

    stateSnapshot(): StateView {
      const list: Record<string, unknown>[] = [];
      for (const p of pending.values()) {
        list.push({ ip: p.ip, iface: p.iface, retries: Math.max(0, p.requests - 1), requests: p.requests, queued: p.queue.length });
      }
      const state: Record<string, unknown> = { pending: list, requestsSent, repliesSent, gratuitousSent, resolved, failed };
      if (probes.size > 0) {
        const running: Record<string, unknown>[] = [];
        for (const p of probes.values()) running.push({ token: p.token, owner: p.owner, iface: p.iface, address: p.address, sent: p.sent, count: p.count });
        state.probes = running;
      }
      if (proxyRepliesSent > 0) state.proxyRepliesSent = proxyRepliesSent;
      return { process: 'arp', state };
    },

    debugEvents(): readonly DebugEvent[] {
      return debugRing;
    },
  };
}
