/**
 * protocols/ipv4.ts — the IPv4 daemon (spec §2.1 "IPv4 addressing" / "Troubleshooting",
 * §2.2 "Routing concepts": connected, static, default, longest prefix match,
 * administrative distance; §9.3 TTL provenance; §4.8 process model; ARCHITECTURE-P1 D3, §3.9, §3.10, §4.2, §4.3).
 *
 * Responsibilities
 *  • Address configuration: `ip address A M` under an interface → `setPortL3` plus a connected (C) and a local
 *    (L) route in the RIB. Addresses act only on ports whose effective role holds L3 addresses
 *    (`ROLE_TRAITS[role].l3`: routed, wan, mgmt, wireless/cellular adapters, SVIs, loopbacks). The configured
 *    address is remembered per port; it is applied (`setPortL3`) while the port is L3 and its C/L rows are
 *    installed ONLY while the port is also oper-up (`onLinkChange` installs / removes them with reason
 *    'link-down'). A role change (`switchport` / `no switchport`) re-evaluates the port. `no ip address` removes
 *    the rows and clears the port's L3 state (`setPortL3 ipv4: null`).
 *  • DHCP-managed ports (§4.3): `ip address dhcp` clears a static address (`setPortL3 ipv4: null`) and marks the port
 *    DHCP-managed. `ipv4.lease bind` (from dhcp-client) applies the leased or APIPA address with its origin and lease
 *    end, installs C/L while the port is up, offers the candidate default `D` (AD 254) via the lease router and
 *    announces the address with a gratuitous ARP; `ipv4.lease unbind` withdraws all of it. On `no ip address` of a
 *    leased port the lease is left to dhcp-client (it sends RELEASE from the leased address first, then unbinds);
 *    a device without dhcp-client drops the lease at once.
 *  • RIB arbitration (§4.2, core/rib-arbiter.ts): EVERY write to the RIB goes through one arbiter, which keeps a
 *    candidate list per key and installs the lowest AD (then metric, then the earliest offer). Candidates are kept
 *    per origin — the connected/local rows of each port, the configured static routes, each port's DHCP default and
 *    every route offered by another daemon with `ipv4.route` (the `host` daemon's `ip default-gateway`, S AD 1) — so
 *    withdrawing the installed route re-installs the next best one (removing `ip default-gateway` restores the DHCP
 *    default). Offered rows carry `RouteRow.owner` (the offering process, which drives the `ip default-gateway`
 *    provenance line); rows of ipv4's own origins keep the P0 shape without an owner. The offering daemon gets the
 *    decision back as the ProcessEvent `ext.ipv4.route` (see `RouteDecisionEvent`) and logs it itself.
 *  • Static routes: global `ip route N M <next-hop | interface>` → S row (AD 1); `0.0.0.0 0.0.0.0` is flagged
 *    `isDefault`. `no ip route …` withdraws.
 *  • Receive (`onPdu`, from the wire — Ethernet type 0x0800 on L3 roles, HDLC protocol 0x0800 on serial WAN
 *    ports — or via `deliver`): header checksum, for-me test (`ctx.isLocalDestination`) → upper-layer delivery by
 *    the protocols/ip-upper.ts table (1 → icmpv4, 6 → tcp, 17 → udp, when the device runs that daemon); any other
 *    protocol is dropped `unsupported-protocol` and answered with ICMP protocol unreachable (3/2) unless the
 *    destination is a broadcast or multicast address; not for me → forward when `model.ipForwarding`, else drop
 *    `not-for-me`.
 *  • Forwarding: LPM over the RIB, `ttl-expired` (→ ICMP time exceeded) and `no-route` (→ ICMP net unreachable)
 *    drops, TTL decrement through `ctx.mutate` with the matched route rendered as the mutation cause (§9.3), one
 *    level of recursive next-hop resolution, then `arp.sendVia` (which also changes framing across
 *    Ethernet/HDLC with a recorded rewrap).
 *  • `ipv4.send` requests (locally originated packets, `ipv4.src` already set): same routing without a TTL
 *    decrement; a packet to one of our own addresses is delivered straight back through the upper-layer table.
 *    With `iface` the LPM is skipped (§4.2): next hop = `nextHop`, else the destination itself when it is the
 *    limited broadcast, the directed broadcast of that interface or on its subnet, else the gateway of a route out
 *    of that interface, else drop `no-route`. Source 0.0.0.0 is accepted only with `iface` (DHCP). A limited
 *    broadcast without `iface` drops `no-route` ('limited broadcast needs an egress interface').
 *
 * Debug categories: 'ip packet' (rx / deliver / forward / send / drop) and 'ip routing' (route add / remove, lease).
 *
 * stateSnapshot():
 *   { process: 'ipv4', state: { forwarding, interfaces: [{ port, address, prefixLen, installed,
 *     origin?, router?, leaseExpiresAt? }], staticRoutes, forwarded, delivered, sent, dropped, dhcp? } }
 *   (`origin`/`router`/`leaseExpiresAt` only on leased interfaces; `dhcp` = DHCP-managed ports, only when any)
 */
import {
  broadcastOf,
  inSubnet,
  isIpv4,
  isIpv4Broadcast,
  isIpv4Multicast,
  maskToPrefixLen,
  networkOf,
  prefixLenToMask,
  type Ipv4Address,
} from '../contracts/addr.js';
import { L3_ROLES, ROLE_TRAITS, defaultRoleFor } from '../contracts/catalog.js';
import type { PortRole } from '../contracts/catalog.js';
import type { ConfigDelta, ConfigNode } from '../contracts/config.js';
import type { PortId, ProcessName } from '../contracts/ids.js';
import type { DropReason } from '../contracts/link.js';
import {
  ETHERTYPE_IPV4,
  HDLC_PROTO_IPV4,
  ICMP_DEST_UNREACHABLE,
  ICMP_TIME_EXCEEDED,
  ICMP_TTL_EXCEEDED_TRANSIT,
  ICMP_UNREACH_NET,
  ICMP_UNREACH_PROTOCOL,
  type LayerView,
  type Pdu,
} from '../contracts/pdu.js';
import type { PortIpv4Address } from '../contracts/port.js';
import type { Action, DebugEvent, DemuxSelector, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import { AD_DHCP, routeKey, type RouteRow } from '../contracts/tables.js';
import type { SimTime } from '../contracts/time.js';
import { createRibArbiter, type RibArbiter, type RibDecision, type RibRemoveReason } from '../core/rib-arbiter.js';
import { ipv4UpperProcess } from './ip-upper.js';

/** Process name, as registered in the protocol registry. */
const NAME = 'ipv4';
/** Debug categories emitted by this daemon. */
const CAT_PACKET = 'ip packet';
const CAT_ROUTING = 'ip routing';
/** Number of DebugEvents retained by `debugEvents()`. */
const DEBUG_RING = 256;
/** RIB key of the default route. */
const DEFAULT_KEY = routeKey('0.0.0.0', 0);
/** Arbiter candidate label of the configured static routes. */
const STATIC_OWNER = 'ipv4';
/** Process recorded as `RouteRow.owner` of a DHCP-learned default route. */
export const LEASE_ROUTE_OWNER: ProcessName = 'dhcp-client';
/** Kind of the ProcessEvent that reports an `ipv4.route` decision back to the offering daemon. */
export const ROUTE_DECISION_EVENT = 'ext.ipv4.route';

/**
 * Decision of an `ipv4.route` offer or withdrawal, delivered to the offering daemon with Action `event`
 * (an `ext.*` ProcessEvent). The offering daemon logs it; ipv4 itself stays quiet about offered routes.
 */
export interface RouteDecisionEvent {
  [k: string]: unknown;
  kind: typeof ROUTE_DECISION_EVENT;
  op: 'offer' | 'withdraw';
  /** RIB key of the route. */
  key: string;
  /** The daemon that offered or withdrew. */
  owner: ProcessName;
  /** The owner's candidate is installed after the step. */
  installed: boolean;
  /** The owner's candidate was installed before the step. */
  wasInstalled: boolean;
  /** The installed row before the step (any owner). */
  previous?: RouteRow;
  /** The installed row after the step (any owner). */
  current?: RouteRow;
}

/** Arbiter candidate label of the connected and local rows of `port`. */
const connectedOwner = (port: PortId): string => `connected|${port}`;
/** Arbiter candidate label of the DHCP default route learned on `port`. */
const leaseOwner = (port: PortId): string => `${LEASE_ROUTE_OWNER}|${port}`;

/** Wire selectors: Ethernet type 0x0800 on every L3 role, HDLC protocol 0x0800 on serial WAN ports (§3.9). */
export const IPV4_HANDLES: readonly DemuxSelector[] = Object.freeze([
  Object.freeze({ layer: 'ethernet', ethertype: ETHERTYPE_IPV4, roles: L3_ROLES }),
  Object.freeze({ layer: 'hdlc', ethertype: HDLC_PROTO_IPV4, roles: Object.freeze(['wan'] as PortRole[]) }),
]) as readonly DemuxSelector[];

/** A configured or leased interface address, applied while the port is L3 and installed while it is also up. */
interface IfaceAddress {
  address: Ipv4Address;
  prefixLen: number;
  /** `setPortL3` carries this address. */
  applied: boolean;
  /** C/L rows (and the lease default) are offered to the RIB. */
  installed: boolean;
  /** Leased addresses only: how the address was obtained. Absent = manual (`ip address A M`). */
  origin?: 'dhcp' | 'apipa';
  /** Leased addresses only: default router of the lease (offered as `D`). */
  router?: Ipv4Address;
  /** Leased addresses only: absolute lease end. */
  leaseExpiresAt?: SimTime;
  /** Leased addresses only: the DHCP server that granted the lease. */
  server?: Ipv4Address;
}

/** A static route as configured (mirrors the RIB row so the snapshot needs no ctx). */
interface StaticRoute {
  key: string;
  network: Ipv4Address;
  prefixLen: number;
  nextHop?: Ipv4Address;
  iface?: PortId;
}

/** Resolved egress for a routed packet. */
interface Egress {
  nextHop: Ipv4Address;
  iface: PortId;
}

/** `"10.0.0.1 > 10.0.0.2 ttl 128 proto 1"` — the packet half of every 'ip packet' line. */
function describe(ip: LayerView): string {
  return `${String(ip.fields.src)} > ${String(ip.fields.dst)} ttl ${String(ip.fields.ttl)} proto ${String(ip.fields.protocol)}`;
}

/**
 * Render a RIB row as the config line responsible for it — the `cause` of the TTL decrement and of the ARP send.
 * Static: `ip route N M NH`; a default route offered by the `host` daemon (`route.owner === 'host'`) is
 * `ip default-gateway GW`; a DHCP default: `dhcp default route via GW`; connected / local: `connected via <iface>`.
 */
export function routeCause(route: RouteRow): string {
  if (route.source === 'S') {
    const via = route.nextHop ?? route.iface ?? '?';
    if (route.owner === 'host' && route.isDefault && route.nextHop !== undefined) return `ip default-gateway ${route.nextHop}`;
    return `ip route ${route.network} ${prefixLenToMask(route.prefixLen)} ${via}`;
  }
  if (route.source === 'D') return `dhcp default route via ${route.nextHop ?? route.iface ?? '?'}`;
  return `connected via ${route.iface ?? '?'}`;
}

/** Case-insensitive lookup of a port name among the device's ports (exact canonical id first). */
function findPort(ctx: ProcessCtx, name: string): PortId | undefined {
  if (ctx.ports.has(name)) return name;
  const lower = name.toLowerCase();
  for (const id of ctx.ports.keys()) if (id.toLowerCase() === lower) return id;
  return undefined;
}

/** Is `ctx` port oper-up? Unknown ports count as down. */
function portUp(ctx: ProcessCtx, port: PortId): boolean {
  return ctx.ports.get(port)?.operUp === true;
}

/** Effective role of a port (live role, else spec default for the model capabilities); undefined for unknown ports. */
function roleOf(ctx: ProcessCtx, port: PortId): PortRole | undefined {
  const view = ctx.ports.get(port);
  if (view === undefined) return undefined;
  return view.role ?? view.spec.role ?? defaultRoleFor(view.spec.kind, ctx.model.capabilities ?? []);
}

/** May `port` hold an IPv4 address right now? Unknown ports are left to the runtime (treated as L3). */
function isL3Port(ctx: ProcessCtx, port: PortId): boolean {
  const role = roleOf(ctx, port);
  return role === undefined || ROLE_TRAITS[role].l3;
}

/** True for the interface-level `switchport` family of lines (`switchport`, `no switchport` stored form). */
function isSwitchportLine(line: readonly string[]): boolean {
  return line[0] === 'switchport' || (line[0] === 'no' && line[1] === 'switchport');
}

/** Limited broadcast, multicast, or the directed broadcast of the subnet on `port`: never answered with ICMP errors. */
function isGroupDestination(ctx: ProcessCtx, dst: Ipv4Address, port: PortId | undefined): boolean {
  if (isIpv4Broadcast(dst) || isIpv4Multicast(dst)) return true;
  const l3 = port === undefined ? undefined : ctx.ports.get(port)?.l3.ipv4;
  return l3 !== undefined && l3.prefixLen < 31 && dst === broadcastOf(l3.address, l3.prefixLen);
}

/** `setPortL3` payload of an interface address (manual addresses keep the P0 `{address, prefixLen}` shape). */
function portAddressOf(entry: IfaceAddress): PortIpv4Address {
  const out: PortIpv4Address = { address: entry.address, prefixLen: entry.prefixLen };
  if (entry.origin !== undefined) out.origin = entry.origin;
  if (entry.leaseExpiresAt !== undefined) out.leaseExpiresAt = entry.leaseExpiresAt;
  return out;
}

/**
 * Create the IPv4 daemon. Handles IPv4 frames from the wire (Ethernet on L3 roles, HDLC on WAN serial ports) and
 * packets delivered by other daemons; answers `ipv4.send`, `ipv4.route` and `ipv4.lease` requests.
 */
export function createIpv4(): Process {
  const interfaces = new Map<PortId, IfaceAddress>();
  const statics = new Map<string, StaticRoute>();
  /** Ports configured with `ip address dhcp`, in configuration order. */
  const dhcpPorts: PortId[] = [];
  const ring: DebugEvent[] = [];
  let arbiter: RibArbiter<RouteRow> | undefined;
  let forwarding = false;
  let forwarded = 0;
  let delivered = 0;
  let sent = 0;
  let dropped = 0;

  function debug(ctx: ProcessCtx, category: string, message: string, data?: Record<string, unknown>): void {
    ctx.debug(category, message, data);
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: NAME, category, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: NAME, category, message };
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  function drop(ctx: ProcessCtx, pdu: Pdu, reason: DropReason, detail: string, port?: PortId): Action {
    dropped++;
    const ip = pdu.layer('ipv4');
    debug(ctx, CAT_PACKET, `drop ${ip ? describe(ip) : `pdu ${pdu.id}`}: ${reason} (${detail})`, { reason, detail, pdu: pdu.id });
    return port === undefined ? { type: 'drop', pdu, reason, detail } : { type: 'drop', pdu, reason, detail, port };
  }

  /** The device's route arbiter, bound to its RIB (created on first use; one per process instance). */
  function rib(ctx: ProcessCtx): RibArbiter<RouteRow> {
    if (arbiter === undefined) arbiter = createRibArbiter<RouteRow>({ table: ctx.tables.rib, stampOwner: false });
    return arbiter;
  }

  function isDhcpPort(port: PortId): boolean {
    return dhcpPorts.includes(port);
  }

  function markDhcp(port: PortId, on: boolean): void {
    const at = dhcpPorts.indexOf(port);
    if (on && at < 0) dhcpPorts.push(port);
    else if (!on && at >= 0) dhcpPorts.splice(at, 1);
  }

  /** Debug line for a runner-up that became installed after a withdrawal (never happens in single-origin RIBs). */
  function reportTakeover(ctx: ProcessCtx, d: RibDecision<RouteRow>): void {
    if (!d.changed || d.after === undefined) return;
    const r = d.after;
    debug(ctx, CAT_ROUTING, `install ${r.source} ${d.key} via ${r.nextHop ?? r.iface ?? '?'} (next best candidate, distance ${r.ad})`, {
      key: d.key, source: r.source, nextHop: r.nextHop, iface: r.iface, ad: r.ad,
    });
  }

  /**
   * Withdraw candidate `owner` of `key`. When that candidate was the installed row, `report` logs the removal
   * (with the removed row) and the runner-up that takes its place, if any, is logged after it.
   */
  function withdrawRoute(ctx: ProcessCtx, key: string, owner: string, reason: RibRemoveReason, report: (row: RouteRow) => void): void {
    const arb = rib(ctx);
    const wasInstalled = arb.installedOwner(key) === owner;
    const row = arb.installed(key);
    const d = arb.withdraw(key, owner, ctx.now, reason);
    if (wasInstalled && row !== undefined) {
      report(row);
      reportTakeover(ctx, d);
    }
  }

  // ── connected / local routes ──────────────────────────────────────────────

  function installConnected(ctx: ProcessCtx, port: PortId, entry: IfaceAddress): void {
    const arb = rib(ctx);
    const owner = connectedOwner(port);
    const net = networkOf(entry.address, entry.prefixLen);
    // A /32 host address is only a local route (the connected key would collide with it).
    if (entry.prefixLen < 32) {
      const row: RouteRow = {
        key: routeKey(net, entry.prefixLen),
        network: net,
        prefixLen: entry.prefixLen,
        source: 'C',
        iface: port,
        ad: 0,
        metric: 0,
        updatedAt: ctx.now,
      };
      const d = arb.offer(row, owner);
      if (d.afterOwner === owner) debug(ctx, CAT_ROUTING, `add C ${row.key} via ${port}`, { key: row.key, source: 'C', iface: port });
      else debug(ctx, CAT_ROUTING, `C ${row.key} via ${port} kept as a candidate: ${d.after ? routeCause(d.after) : 'another route'} is installed`, { key: row.key, source: 'C', iface: port });
    }
    const local: RouteRow = {
      key: routeKey(entry.address, 32),
      network: entry.address,
      prefixLen: 32,
      source: 'L',
      iface: port,
      ad: 0,
      metric: 0,
      updatedAt: ctx.now,
    };
    const dl = arb.offer(local, owner);
    if (dl.afterOwner === owner) debug(ctx, CAT_ROUTING, `add L ${local.key} via ${port}`, { key: local.key, source: 'L', iface: port });
    else debug(ctx, CAT_ROUTING, `L ${local.key} via ${port} kept as a candidate: ${dl.after ? routeCause(dl.after) : 'another route'} is installed`, { key: local.key, source: 'L', iface: port });
    if (entry.router !== undefined) {
      const dflt: RouteRow = {
        key: DEFAULT_KEY,
        network: '0.0.0.0',
        prefixLen: 0,
        source: 'D',
        nextHop: entry.router,
        iface: port,
        ad: AD_DHCP,
        metric: 0,
        isDefault: true,
        updatedAt: ctx.now,
        owner: LEASE_ROUTE_OWNER,
      };
      const dd = arb.offer(dflt, leaseOwner(port));
      if (dd.afterOwner === leaseOwner(port)) {
        debug(ctx, CAT_ROUTING, `add D ${DEFAULT_KEY} via ${entry.router} on ${port} (distance ${AD_DHCP})`, { key: DEFAULT_KEY, source: 'D', nextHop: entry.router, iface: port });
      } else {
        debug(ctx, CAT_ROUTING, `D ${DEFAULT_KEY} via ${entry.router} kept as a candidate: ${dd.after ? routeCause(dd.after) : 'another route'} is preferred`, {
          key: DEFAULT_KEY, source: 'D', nextHop: entry.router, iface: port,
        });
      }
    }
    entry.installed = true;
  }

  function removeConnected(ctx: ProcessCtx, port: PortId, entry: IfaceAddress, reason: 'cleared' | 'replaced' | 'link-down'): void {
    const owner = connectedOwner(port);
    const report = (key: string) => (row: RouteRow): void => {
      debug(ctx, CAT_ROUTING, `remove ${row.source} ${key} via ${port} (${reason})`, { key, source: row.source, iface: port, reason });
    };
    const keys = entry.prefixLen < 32 ? [routeKey(networkOf(entry.address, entry.prefixLen), entry.prefixLen), routeKey(entry.address, 32)] : [routeKey(entry.address, 32)];
    for (const key of keys) withdrawRoute(ctx, key, owner, reason, report(key));
    const router = entry.router;
    if (router !== undefined) {
      withdrawRoute(ctx, DEFAULT_KEY, leaseOwner(port), reason, (row) => {
        debug(ctx, CAT_ROUTING, `remove ${row.source} ${DEFAULT_KEY} via ${router} on ${port} (${reason})`, { key: DEFAULT_KEY, source: row.source, nextHop: router, iface: port, reason });
      });
    }
    entry.installed = false;
  }

  /**
   * Bring the port's L3 state in line with its configured address, its effective role and `up`:
   * not L3 → routes withdrawn and L3 state cleared; L3 → `setPortL3` once, C/L rows (plus a gratuitous ARP) while
   * up, rows removed ('link-down') while down. Trusts `up` (during a role-change bounce the port view may lag).
   */
  function reconcile(ctx: ProcessCtx, port: PortId, up: boolean): Action[] {
    const entry = interfaces.get(port);
    if (entry === undefined) return [];
    const actions: Action[] = [];
    if (!isL3Port(ctx, port)) {
      if (entry.installed) removeConnected(ctx, port, entry, 'cleared');
      if (entry.applied) {
        entry.applied = false;
        actions.push({ type: 'setPortL3', port, ipv4: null });
      }
      debug(ctx, CAT_ROUTING, `interface ${port} does not route; address ${entry.address}/${entry.prefixLen} is kept until it does`, { port, role: roleOf(ctx, port) });
      return actions;
    }
    if (!entry.applied) {
      entry.applied = true;
      actions.push({ type: 'setPortL3', port, ipv4: portAddressOf(entry) });
    }
    if (up && !entry.installed) {
      installConnected(ctx, port, entry);
      actions.push({ type: 'request', to: 'arp', req: { kind: 'arp.gratuitous', iface: port } });
    } else if (!up && entry.installed) {
      removeConnected(ctx, port, entry, 'link-down');
    } else if (!up) {
      debug(ctx, CAT_ROUTING, `interface ${port} is down; connected routes for ${entry.address}/${entry.prefixLen} deferred`, { port });
    }
    return actions;
  }

  // ── address configuration ─────────────────────────────────────────────────

  function setAddress(ctx: ProcessCtx, port: PortId, address: string, mask: string): Action[] {
    const prefixLen = maskToPrefixLen(mask);
    if (!isIpv4(address) || prefixLen === null) {
      debug(ctx, CAT_ROUTING, `ignored ip address ${address} ${mask} on ${port}: invalid address or non-contiguous mask`, { port, address, mask });
      return [];
    }
    if (prefixLen < 31) {
      const net = networkOf(address, prefixLen);
      const bcast = broadcastOf(address, prefixLen);
      if (address === net || address === bcast) {
        debug(ctx, CAT_ROUTING, `ignored ip address ${address} ${mask} on ${port}: ${address === net ? 'network' : 'broadcast'} address of ${net}/${prefixLen}`, { port, address, mask });
        return [];
      }
    }
    if (isDhcpPort(port)) {
      markDhcp(port, false);
      debug(ctx, CAT_ROUTING, `interface ${port} no longer takes its address from DHCP`, { port });
    }
    const previous = interfaces.get(port);
    if (previous && previous.installed) removeConnected(ctx, port, previous, 'replaced');
    const entry: IfaceAddress = { address, prefixLen, applied: false, installed: false };
    interfaces.set(port, entry);
    debug(ctx, CAT_ROUTING, `interface ${port} address ${address}/${prefixLen}`, { port, address, prefixLen });
    return reconcile(ctx, port, portUp(ctx, port));
  }

  /** `ip address dhcp`: drop a static address, mark the port DHCP-managed (the lease arrives by `ipv4.lease`). */
  function setDhcp(ctx: ProcessCtx, port: PortId): Action[] {
    const previous = interfaces.get(port);
    const actions: Action[] = [];
    if (previous !== undefined && previous.origin === undefined) {
      if (previous.installed) removeConnected(ctx, port, previous, 'replaced');
      interfaces.delete(port);
    }
    if (!interfaces.has(port)) actions.push({ type: 'setPortL3', port, ipv4: null });
    if (!isDhcpPort(port)) {
      markDhcp(port, true);
      debug(ctx, CAT_ROUTING, `interface ${port} takes its address from DHCP`, { port });
    }
    return actions;
  }

  function unsetAddress(ctx: ProcessCtx, port: PortId): Action[] {
    const entry = interfaces.get(port);
    const wasDhcp = isDhcpPort(port);
    markDhcp(port, false);
    if (entry !== undefined && entry.origin !== undefined && ctx.model.processes.includes(LEASE_ROUTE_OWNER)) {
      // dhcp-client releases the lease (RELEASE from the leased address) and then unbinds it.
      debug(ctx, CAT_ROUTING, `interface ${port} no longer uses DHCP; ${entry.address}/${entry.prefixLen} stays until the lease is released`, { port });
      return [];
    }
    if (entry) {
      if (entry.installed) removeConnected(ctx, port, entry, 'cleared');
      interfaces.delete(port);
      debug(ctx, CAT_ROUTING, `interface ${port} address removed`, { port });
    } else if (wasDhcp) {
      debug(ctx, CAT_ROUTING, `interface ${port} no longer uses DHCP`, { port });
    }
    return [{ type: 'setPortL3', port, ipv4: null }];
  }

  // ── DHCP / APIPA leases ───────────────────────────────────────────────────

  function bindLease(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'ipv4.lease' }>): Action[] {
    const port = req.iface;
    const address = req.address;
    const prefixLen = req.prefixLen;
    if (!ctx.ports.has(port) || address === undefined || !isIpv4(address) || prefixLen === undefined || !Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > 32) {
      debug(ctx, CAT_ROUTING, `ignored lease for ${port}: ${ctx.ports.has(port) ? 'invalid address or prefix length' : 'unknown interface'}`, { port, address, prefixLen });
      return [];
    }
    const previous = interfaces.get(port);
    if (previous !== undefined && previous.origin === undefined) {
      debug(ctx, CAT_ROUTING, `ignored lease ${address}/${prefixLen} on ${port}: the interface has a static address`, { port, address, prefixLen });
      return [];
    }
    const origin = req.origin ?? 'dhcp';
    const router = req.router !== undefined && isIpv4(req.router) && origin === 'dhcp' ? req.router : undefined;
    if (previous !== undefined && previous.origin === origin && previous.address === address && previous.prefixLen === prefixLen && previous.router === router) {
      // Renewal of the same lease: only the lease end (and server) change; routes stay installed.
      if (req.leaseExpiresAt !== undefined) previous.leaseExpiresAt = req.leaseExpiresAt;
      else delete previous.leaseExpiresAt;
      if (req.server !== undefined) previous.server = req.server;
      debug(ctx, CAT_ROUTING, `interface ${port} lease of ${address}/${prefixLen} renewed`, { port, address, prefixLen, leaseExpiresAt: previous.leaseExpiresAt, server: previous.server });
      return previous.applied ? [{ type: 'setPortL3', port, ipv4: portAddressOf(previous) }] : reconcile(ctx, port, portUp(ctx, port));
    }
    const actions: Action[] = [];
    if (previous !== undefined && previous.installed) removeConnected(ctx, port, previous, 'replaced');
    const entry: IfaceAddress = { address, prefixLen, applied: false, installed: false, origin };
    if (router !== undefined) entry.router = router;
    if (req.leaseExpiresAt !== undefined) entry.leaseExpiresAt = req.leaseExpiresAt;
    if (req.server !== undefined) entry.server = req.server;
    interfaces.set(port, entry);
    const via = entry.router !== undefined ? `, default router ${entry.router}` : '';
    debug(ctx, CAT_ROUTING, `interface ${port} ${origin === 'apipa' ? 'self-assigned' : 'leased'} address ${address}/${prefixLen}${via}`, {
      port, address, prefixLen, origin, router: entry.router, server: entry.server, leaseExpiresAt: entry.leaseExpiresAt,
    });
    actions.push(...reconcile(ctx, port, portUp(ctx, port)));
    return actions;
  }

  function unbindLease(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'ipv4.lease' }>): Action[] {
    const port = req.iface;
    const entry = interfaces.get(port);
    if (entry === undefined || entry.origin === undefined || (req.address !== undefined && req.address !== entry.address)) {
      debug(ctx, CAT_ROUTING, `ignored lease release on ${port}: no matching leased address`, { port, address: req.address });
      return [];
    }
    if (entry.installed) removeConnected(ctx, port, entry, 'cleared');
    interfaces.delete(port);
    debug(ctx, CAT_ROUTING, `interface ${port} released ${entry.origin === 'apipa' ? 'self-assigned' : 'leased'} address ${entry.address}/${entry.prefixLen}`, {
      port, address: entry.address, origin: entry.origin,
    });
    return entry.applied ? [{ type: 'setPortL3', port, ipv4: null }] : [];
  }

  // ── static routes ─────────────────────────────────────────────────────────

  function setStatic(ctx: ProcessCtx, netArg: string, mask: string, via: string): void {
    const prefixLen = maskToPrefixLen(mask);
    if (!isIpv4(netArg) || prefixLen === null) {
      debug(ctx, CAT_ROUTING, `ignored ip route ${netArg} ${mask} ${via}: invalid network or non-contiguous mask`, { network: netArg, mask, via });
      return;
    }
    const network = networkOf(netArg, prefixLen);
    const key = routeKey(network, prefixLen);
    let nextHop: Ipv4Address | undefined;
    let iface: PortId | undefined;
    if (isIpv4(via)) nextHop = via;
    else {
      iface = findPort(ctx, via);
      if (iface === undefined) {
        debug(ctx, CAT_ROUTING, `ignored ip route ${netArg} ${mask} ${via}: unknown next hop or interface`, { network, prefixLen, via });
        return;
      }
    }
    const isDefault = prefixLen === 0 && network === '0.0.0.0';
    const row: RouteRow = { key, network, prefixLen, source: 'S', ad: 1, metric: 0, updatedAt: ctx.now };
    if (nextHop !== undefined) row.nextHop = nextHop;
    if (iface !== undefined) row.iface = iface;
    if (isDefault) row.isDefault = true;
    const d = rib(ctx).offer(row, STATIC_OWNER);
    const entry: StaticRoute = { key, network, prefixLen };
    if (nextHop !== undefined) entry.nextHop = nextHop;
    if (iface !== undefined) entry.iface = iface;
    statics.set(key, entry);
    if (d.afterOwner === STATIC_OWNER) {
      debug(ctx, CAT_ROUTING, `add S ${key} via ${nextHop ?? iface}${isDefault ? ' (default)' : ''}`, { key, source: 'S', nextHop, iface, isDefault });
    } else {
      debug(ctx, CAT_ROUTING, `S ${key} via ${nextHop ?? iface} kept as a candidate: ${d.after ? routeCause(d.after) : 'another route'} is installed`, {
        key, source: 'S', nextHop, iface, isDefault,
      });
    }
  }

  function unsetStatic(ctx: ProcessCtx, key: string): void {
    const entry = statics.get(key);
    if (!entry) return;
    statics.delete(key);
    withdrawRoute(ctx, key, STATIC_OWNER, 'cleared', (row) => {
      debug(ctx, CAT_ROUTING, `remove S ${key} via ${row.nextHop ?? row.iface}`, { key, source: 'S' });
    });
  }

  function unsetStaticLine(ctx: ProcessCtx, line: readonly string[]): void {
    if (line.length < 4) {
      for (const key of Array.from(statics.keys())) unsetStatic(ctx, key);
      return;
    }
    const prefixLen = maskToPrefixLen(line[3]!);
    if (!isIpv4(line[2]!) || prefixLen === null) return;
    unsetStatic(ctx, routeKey(networkOf(line[2]!, prefixLen), prefixLen));
  }

  // ── routes offered by other daemons ───────────────────────────────────────

  function routeRequest(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'ipv4.route' }>): Action[] {
    const arb = rib(ctx);
    const key = req.row.key;
    const wasInstalled = arb.installedOwner(key) === req.owner;
    let d: RibDecision<RouteRow>;
    if (req.op === 'offer') {
      d = arb.offer({ ...req.row, owner: req.owner, updatedAt: ctx.now }, req.owner);
    } else {
      d = arb.withdraw(key, req.owner, ctx.now, 'cleared');
    }
    const ev: RouteDecisionEvent = {
      kind: ROUTE_DECISION_EVENT,
      op: req.op,
      key,
      owner: req.owner,
      installed: d.afterOwner === req.owner,
      wasInstalled,
    };
    if (d.before !== undefined) ev.previous = d.before;
    if (d.after !== undefined) ev.current = d.after;
    return [{ type: 'event', to: req.owner, ev }];
  }

  // ── config replay at boot ─────────────────────────────────────────────────

  /** Pick up `ip address` / `ip route` lines already present in the running config (idempotent). */
  function syncFromConfig(ctx: ProcessCtx): Action[] {
    const actions: Action[] = [];
    const root: ConfigNode = ctx.config.root;
    for (const section of root.children) {
      if (section.key === 'interface') {
        const port = section.args[0];
        if (port === undefined || interfaces.has(port) || isDhcpPort(port)) continue;
        for (const child of section.children) {
          const leaves = child.key === 'ip' ? child.children : [];
          for (const leaf of leaves) {
            if (leaf.key !== 'address') continue;
            if (leaf.args[0] === 'dhcp') actions.push(...setDhcp(ctx, port));
            else if (leaf.args.length >= 2) actions.push(...setAddress(ctx, port, leaf.args[0]!, leaf.args[1]!));
          }
          if (child.key === 'ip' && child.args[0] === 'address') {
            if (child.args[1] === 'dhcp') actions.push(...setDhcp(ctx, port));
            else if (child.args.length >= 3) actions.push(...setAddress(ctx, port, child.args[1]!, child.args[2]!));
          }
        }
      } else if (section.key === 'ip') {
        for (const leaf of section.children) {
          if (leaf.key !== 'route' || leaf.args.length < 3) continue;
          const prefixLen = maskToPrefixLen(leaf.args[1]!);
          if (!isIpv4(leaf.args[0]!) || prefixLen === null) continue;
          if (statics.has(routeKey(networkOf(leaf.args[0]!, prefixLen), prefixLen))) continue;
          setStatic(ctx, leaf.args[0]!, leaf.args[1]!, leaf.args[2]!);
        }
        if (section.args[0] === 'route' && section.args.length >= 4) setStatic(ctx, section.args[1]!, section.args[2]!, section.args[3]!);
      }
    }
    return actions;
  }

  // ── routing ───────────────────────────────────────────────────────────────

  /**
   * Egress for a matched route: next hop = `route.nextHop` or the destination itself
   * (connected); interface = `route.iface` or the port whose subnet holds the next hop.
   * A next hop that is not directly connected is resolved recursively once.
   */
  function resolveEgress(ctx: ProcessCtx, route: RouteRow, dst: Ipv4Address): Egress | undefined {
    let nextHop = route.nextHop ?? dst;
    let iface = route.iface;
    if (iface !== undefined) return { nextHop, iface };
    iface = ctx.connectedPortFor(nextHop);
    if (iface !== undefined) return { nextHop, iface };
    const inner = ctx.lpm(nextHop).winner;
    if (!inner || inner.key === route.key) return undefined;
    if (inner.nextHop !== undefined) {
      const via = inner.iface ?? ctx.connectedPortFor(inner.nextHop);
      if (via === undefined) return undefined;
      nextHop = inner.nextHop;
      iface = via;
    } else if (inner.iface !== undefined) {
      iface = inner.iface;
    } else {
      return undefined;
    }
    return { nextHop, iface };
  }

  function icmpError(original: Pdu, type: number, code: number, inPort?: PortId): Action {
    const req: ProcessRequest =
      inPort === undefined ? { kind: 'icmp.error', original, type, code } : { kind: 'icmp.error', original, type, code, inPort };
    return { type: 'request', to: 'icmpv4', req };
  }

  /** Transit forwarding of a packet received on `port`. */
  function forward(ctx: ProcessCtx, pdu: Pdu, ip: LayerView, port: PortId): Action[] {
    const dst = String(ip.fields.dst);
    const ttl = Number(ip.fields.ttl);
    if (isIpv4Broadcast(dst) || isIpv4Multicast(dst)) {
      return [drop(ctx, pdu, 'not-for-me', 'broadcast and multicast packets are never forwarded', port)];
    }
    const route = ctx.lpm(dst).winner;
    const egress = route ? resolveEgress(ctx, route, dst) : undefined;
    if (egress !== undefined && egress.nextHop === dst) {
      const l3 = ctx.ports.get(egress.iface)?.l3.ipv4;
      if (l3 !== undefined && l3.prefixLen < 31 && dst === broadcastOf(l3.address, l3.prefixLen)) {
        return [drop(ctx, pdu, 'not-for-me', 'directed broadcasts are not forwarded (no ip directed-broadcast)', port)];
      }
    }
    if (ttl <= 1) {
      return [drop(ctx, pdu, 'ttl-expired', `ttl ${ttl} reached zero in transit`, port), icmpError(pdu, ICMP_TIME_EXCEEDED, ICMP_TTL_EXCEEDED_TRANSIT, port)];
    }
    if (!route) {
      return [drop(ctx, pdu, 'no-route', `no route to ${dst}`, port), icmpError(pdu, ICMP_DEST_UNREACHABLE, ICMP_UNREACH_NET, port)];
    }
    const cause = routeCause(route);
    if (!egress) {
      return [
        drop(ctx, pdu, 'no-route', `next hop ${route.nextHop ?? dst} of ${cause} is not on a connected network`, port),
        icmpError(pdu, ICMP_DEST_UNREACHABLE, ICMP_UNREACH_NET, port),
      ];
    }
    ctx.mutate(pdu, 'ipv4.ttl', ttl - 1, 'TtlDecrement', cause);
    forwarded++;
    debug(ctx, CAT_PACKET, `forward ${describe(pdu.layer('ipv4') ?? ip)} via ${egress.iface} next hop ${egress.nextHop} (${cause})`, {
      pdu: pdu.id,
      route: route.key,
      nextHop: egress.nextHop,
      iface: egress.iface,
      inPort: port,
    });
    return [{ type: 'request', to: 'arp', req: { kind: 'arp.sendVia', pdu, nextHop: egress.nextHop, iface: egress.iface, cause } }];
  }

  /**
   * Hand a packet addressed to this device to its upper-layer daemon (protocols/ip-upper.ts); a protocol nobody
   * handles is dropped `unsupported-protocol` and, for a unicast destination received from the wire, answered with
   * ICMP protocol unreachable.
   */
  function deliverLocal(ctx: ProcessCtx, pdu: Pdu, ip: LayerView, port: PortId, fromWire: boolean, prefix: string): Action[] {
    const protocol = Number(ip.fields.protocol);
    const target = ipv4UpperProcess(ctx.model, protocol);
    if (target !== undefined) {
      delivered++;
      debug(ctx, CAT_PACKET, `${prefix}${describe(ip)}${fromWire ? ` to ${target}` : `: own address, delivered locally`}`, { pdu: pdu.id, port });
      return [{ type: 'deliver', to: target, pdu, port }];
    }
    const actions: Action[] = [drop(ctx, pdu, 'unsupported-protocol', `ip protocol ${protocol} has no listener`, fromWire ? port : undefined)];
    if (fromWire && !isGroupDestination(ctx, String(ip.fields.dst), port)) {
      actions.push(icmpError(pdu, ICMP_DEST_UNREACHABLE, ICMP_UNREACH_PROTOCOL, port));
    }
    return actions;
  }

  /** `ipv4.send` with a forced egress interface (§4.2): no LPM. */
  function sendOut(ctx: ProcessCtx, pdu: Pdu, ip: LayerView, iface: PortId, reqNextHop: Ipv4Address | undefined, reqCause: string | undefined): Action[] {
    const dst = String(ip.fields.dst);
    const port = ctx.ports.get(iface);
    if (port === undefined) return [drop(ctx, pdu, 'other', `unknown interface ${iface}`)];
    let nextHop: Ipv4Address | undefined = reqNextHop;
    let via = 'given next hop';
    if (nextHop === undefined) {
      const l3 = port.l3.ipv4;
      if (isIpv4Broadcast(dst)) {
        nextHop = dst;
        via = 'limited broadcast';
      } else if (l3 !== undefined && (inSubnet(dst, l3.address, l3.prefixLen) || (l3.prefixLen < 31 && dst === broadcastOf(l3.address, l3.prefixLen)))) {
        nextHop = dst;
        via = 'connected';
      } else {
        for (const c of ctx.lpm(dst).candidates) {
          const e = resolveEgress(ctx, c, dst);
          if (e !== undefined && e.iface === iface && e.nextHop !== dst) {
            nextHop = e.nextHop;
            via = routeCause(c);
            break;
          }
        }
      }
    }
    if (nextHop === undefined) return [drop(ctx, pdu, 'no-route', `no gateway for ${dst} on ${iface}`)];
    const cause = reqCause ?? `sent out ${iface}`;
    sent++;
    debug(ctx, CAT_PACKET, `send ${describe(ip)} out ${iface} next hop ${nextHop} (${via})`, { pdu: pdu.id, nextHop, iface });
    return [{ type: 'request', to: 'arp', req: { kind: 'arp.sendVia', pdu, nextHop, iface, cause } }];
  }

  /** Locally originated packet (`ipv4.send`). */
  function send(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'ipv4.send' }>): Action[] {
    const pdu = req.pdu;
    const ip = pdu.layer('ipv4');
    if (!ip) return [drop(ctx, pdu, 'other', 'ipv4.send without an IPv4 header')];
    const dst = String(ip.fields.dst);
    const own = ctx.ownAddress(dst);
    if (own !== undefined && portUp(ctx, own)) return deliverLocal(ctx, pdu, ip, own, false, 'send ');
    if (req.iface !== undefined) return sendOut(ctx, pdu, ip, req.iface, req.nextHop, req.cause);
    if (String(ip.fields.src) === '0.0.0.0') return [drop(ctx, pdu, 'no-l3-address', 'source 0.0.0.0 needs an egress interface')];
    if (isIpv4Broadcast(dst)) return [drop(ctx, pdu, 'no-route', 'limited broadcast needs an egress interface')];
    const route = ctx.lpm(dst).winner;
    if (!route) return [drop(ctx, pdu, 'no-route', `no route to ${dst}`)];
    const cause = req.cause ?? routeCause(route);
    let egress = resolveEgress(ctx, route, dst);
    if (req.nextHop !== undefined) {
      const iface = ctx.connectedPortFor(req.nextHop) ?? egress?.iface;
      egress = iface === undefined ? undefined : { nextHop: req.nextHop, iface };
    }
    if (!egress) return [drop(ctx, pdu, 'no-route', `next hop ${req.nextHop ?? route.nextHop ?? dst} of ${routeCause(route)} is not on a connected network`)];
    sent++;
    debug(ctx, CAT_PACKET, `send ${describe(ip)} via ${egress.iface} next hop ${egress.nextHop} (${routeCause(route)})`, {
      pdu: pdu.id,
      route: route.key,
      nextHop: egress.nextHop,
      iface: egress.iface,
    });
    return [{ type: 'request', to: 'arp', req: { kind: 'arp.sendVia', pdu, nextHop: egress.nextHop, iface: egress.iface, cause } }];
  }

  // ── the process ───────────────────────────────────────────────────────────

  return {
    name: NAME,
    handles: IPV4_HANDLES,

    init(ctx: ProcessCtx): Action[] {
      forwarding = ctx.model.ipForwarding;
      return syncFromConfig(ctx);
    },

    onPdu(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
      forwarding = ctx.model.ipForwarding;
      const ip = pdu.layer('ipv4');
      if (!ip) return [drop(ctx, pdu, 'other', 'no IPv4 header', port)];
      if (ip.fields.checksumValid === false) {
        return [drop(ctx, pdu, 'bad-checksum', ip.error ?? 'IPv4 header checksum mismatch', port)];
      }
      const dst = String(ip.fields.dst);
      debug(ctx, CAT_PACKET, `rx ${describe(ip)} on ${port}`, { pdu: pdu.id, port });
      if (ctx.isLocalDestination(dst, port)) return deliverLocal(ctx, pdu, ip, port, true, 'deliver ');
      if (!ctx.model.ipForwarding) {
        return [drop(ctx, pdu, 'not-for-me', `${dst} is not a local address and this device does not forward`, port)];
      }
      return forward(ctx, pdu, ip, port);
    },

    onTimer(): Action[] {
      return [];
    },

    onConfig(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
      forwarding = ctx.model.ipForwarding;
      const line = delta.line;
      const ctxHead = delta.context[0];
      const ifacePort = delta.context.length === 1 && ctxHead !== undefined && ctxHead[0] === 'interface' ? ctxHead[1] : undefined;
      if (ifacePort !== undefined && isSwitchportLine(line)) {
        // The runtime changed the role before fanning the line out: re-evaluate the port.
        return reconcile(ctx, ifacePort, portUp(ctx, ifacePort));
      }
      if (line[0] !== 'ip') return [];
      if (ifacePort !== undefined && line[1] === 'address') {
        if (delta.op === 'set') {
          if (line[2] === 'dhcp' && line.length === 3) return setDhcp(ctx, ifacePort);
          if (line.length < 4) return [];
          return setAddress(ctx, ifacePort, line[2]!, line[3]!);
        }
        return unsetAddress(ctx, ifacePort);
      }
      if (delta.context.length === 0 && line[1] === 'route') {
        if (delta.op === 'set') {
          if (line.length >= 5) setStatic(ctx, line[2]!, line[3]!, line[4]!);
        } else {
          unsetStaticLine(ctx, line);
        }
      }
      return [];
    },

    onLinkChange(ctx: ProcessCtx, port: PortId, up: boolean): Action[] {
      return reconcile(ctx, port, up);
    },

    onRequest(ctx: ProcessCtx, req: ProcessRequest): Action[] {
      forwarding = ctx.model.ipForwarding;
      switch (req.kind) {
        case 'ipv4.send':
          return send(ctx, req);
        case 'ipv4.route':
          return routeRequest(ctx, req);
        case 'ipv4.lease':
          return req.op === 'bind' ? bindLease(ctx, req) : unbindLease(ctx, req);
        default:
          return [];
      }
    },

    stateSnapshot(): StateView {
      const ifaces: Record<string, unknown>[] = [];
      for (const [port, e] of interfaces) {
        const view: Record<string, unknown> = { port, address: e.address, prefixLen: e.prefixLen, installed: e.installed };
        if (e.origin !== undefined) view.origin = e.origin;
        if (e.router !== undefined) view.router = e.router;
        if (e.leaseExpiresAt !== undefined) view.leaseExpiresAt = e.leaseExpiresAt;
        if (e.server !== undefined) view.server = e.server;
        ifaces.push(view);
      }
      const state: Record<string, unknown> = { forwarding, interfaces: ifaces, staticRoutes: statics.size, forwarded, delivered, sent, dropped };
      if (dhcpPorts.length > 0) state.dhcp = dhcpPorts.slice();
      return { process: NAME, state };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}
