/**
 * protocols/ipv4.ts — the IPv4 daemon (spec §2.1 "IPv4 addressing" / "Troubleshooting",
 * §2.2 "Routing concepts": connected, static, default, longest prefix match,
 * administrative distance; §9.3 TTL provenance; §4.8 process model; ARCHITECTURE-P1 D3, §3.9, §3.10, §4.2, §4.3;
 * ARCHITECTURE-P2 D13 static routing, D14 NAT hooks, D15 virtual addresses, §3.5 `ip routing`, [S2] groups,
 * [S6] equal-cost multipath).
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
 *    per origin — the connected/local rows of each port, each configured static route line, each port's DHCP default
 *    and every route offered by another daemon with `ipv4.route` (the `host` daemon's `ip default-gateway`, S AD 1)
 *    — so withdrawing the installed route re-installs the next best one (removing `ip default-gateway` restores the
 *    DHCP default). Offered rows carry `RouteRow.owner` (the offering process, which drives the `ip default-gateway`
 *    provenance line); rows of ipv4's own origins keep the P0 shape without an owner. The offering daemon gets the
 *    decision back as the ProcessEvent `ext.ipv4.route` (see `RouteDecisionEvent`) and logs it itself.
 *  • Static routes (P2 D13): global `ip route N M <next-hop | interface [next-hop]> [<distance 1-255>] [permanent]`.
 *    ONE candidate per configuration line, arbiter owner `static|<line>` (the canonical line text), so two lines for
 *    one prefix are two candidates and the lowest distance wins (floating statics). A line's candidate is offered
 *    only while it is USABLE, exactly: (a) with an exit interface, that interface is oper up and has an address (a
 *    fully specified route also needs its next hop inside that interface's subnet); (b) with a next hop only, the
 *    next hop is directly connected, else its longest match in the RIB — ignoring every route of this line's own
 *    prefix — is an installed route, followed through static routes recursively to depth `STATIC_RECURSION_MAX`;
 *    `permanent` skips the test. "Up, addressed, directly connected" are read from ipv4's own interface record first
 *    (the port view lags one step behind a re-address), then `ctx.connectedPortFor` for a port ipv4 does not
 *    manage (W5 fix; the D13 rule is unchanged in meaning). Usability is re-evaluated after every connected/local/offered
 *    route change, so a static is INSTALLED WHEN IT BECOMES USABLE (at link-up, not at configuration time) and
 *    withdrawn when it stops being usable. `0.0.0.0 0.0.0.0` is flagged `isDefault`. `no ip route …` withdraws the
 *    exact line; `no ip route` alone withdraws every static.
 *  • Equal-cost multipath [S6]: the arbiter runs with `maxPaths` `IPV4_MAX_PATHS`; only `ip route` candidates are
 *    multipath-eligible, so two usable lines for one prefix with the same distance install one row whose `paths`
 *    lists both (with their line as `cause`). Forwarding picks the path with the fixed flow hash `ecmpIndex`
 *    (§4.1: `h = u32(src) ^ u32(dst); h ^= h >>> 16; i = h % n`). A single path installs exactly as in P1 (no `paths`).
 *  • `ip routing` / `no ip routing` (§3.5, D2): forwarding is enabled iff `model.ipForwarding` and the running config
 *    holds no stored `no ip routing`. With the line present a transit packet is dropped `no-route` with the detail
 *    `IP routing is switched off on this device (ip routing)`. Local delivery and locally originated packets are
 *    unaffected. `ipRoutingSwitchedOff(ctx)` is the one reader (the host daemon uses it too).
 *  • NAT hooks (D14, §3.9): `ip nat inside|outside` under an interface is read from the config deltas. When the model
 *    runs `nat`: a packet arriving on an outside port is handed to nat (`nat.inbound`) BEFORE the for-me test and
 *    comes back as `ipv4.resume`, which continues at the for-me test (never handed to nat again); a forwarded packet
 *    whose input port is inside and whose egress is outside goes to nat (`nat.outbound`) after the TTL decrement
 *    instead of to arp. With no such line, or without the nat daemon, the paths are exactly P1's.
 *  • Virtual addresses (D15): `ipv4.virtual add|remove` from nat (and hsrp) merges by (owner, address) per interface
 *    and writes `setPortL3 virtual4` (ordered by owner, then address; `null` when the list empties); an add with
 *    `local` true also sends `arp.gratuitous {iface, address, mac}`. A packet to a LOCAL virtual address of an up
 *    port is for this device. [S2] `ipv4.group join|leave` merges by (owner, group) and writes `setPortL3 groups4`;
 *    a packet to a group joined on its input port is for this device.
 *  • Receive (`onPdu`, from the wire — Ethernet type 0x0800 on L3 roles, HDLC protocol 0x0800 on serial WAN
 *    ports — or via `deliver`): header checksum, NAT inbound hook, for-me test (`ctx.isLocalDestination`, local
 *    virtual addresses, joined groups) → upper-layer delivery by the protocols/ip-upper.ts table (1 → icmpv4,
 *    6 → tcp, 17 → udp, when the device runs that daemon); any other protocol is dropped `unsupported-protocol` and
 *    answered with ICMP protocol unreachable (3/2) unless the destination is a broadcast or multicast address; not
 *    for me → forward when forwarding is enabled, else drop `not-for-me` (or `no-route` under `no ip routing`).
 *  • Forwarding: LPM over the RIB, `ttl-expired` (→ ICMP time exceeded) and `no-route` (→ ICMP net unreachable)
 *    drops, TTL decrement through `ctx.mutate` with the matched route (or path) rendered as the mutation cause
 *    (§9.3), recursive next-hop resolution (depth ≤ `STATIC_RECURSION_MAX`), then `arp.sendVia` (which also changes
 *    framing across Ethernet/HDLC with a recorded rewrap), or the NAT outbound hook.
 *  • `ipv4.send` requests (locally originated packets, `ipv4.src` already set): same routing without a TTL
 *    decrement; a packet to one of our own addresses is delivered straight back through the upper-layer table.
 *    With `iface` the LPM is skipped (§4.2): next hop = `nextHop`, else the destination itself when it is the
 *    limited broadcast, the directed broadcast of that interface or on its subnet, else the gateway of a route out
 *    of that interface, else drop `no-route`. Source 0.0.0.0 is accepted only with `iface` (DHCP). A limited
 *    broadcast without `iface` drops `no-route` ('limited broadcast needs an egress interface').
 *
 * P3 (ARCHITECTURE-P3 D8, D11, D22, §3.0 (a); W1 l3):
 *  • `ipv4.routes {owner, rows}` (D8) REPLACES the owner's candidate set: rows sharing a key are equal-cost paths,
 *    offered to the arbiter as `${owner}|${slot}` (an unchanged row keeps its slot, a changed one takes its own index,
 *    `planSlots`), so a changed next hop is a re-offer in place (one tableWrite). The installed `paths` follow the
 *    batch order (§4.5: OSPF sends them in canonical next-hop order), through the arbiter's `pathOrder` on each slot's
 *    batch position, whatever the offer history (a flapped path returns in a fresh slot); a batch that only reorders
 *    unchanged paths offers and writes nothing. Keys are applied in ascending (network u32, prefix
 *    length) order: re-offer changed slots, offer new ones, withdraw vanished ones; then `settleStatics` once; no
 *    decision event; one 'ip routing' debug line per installed-row change. Rows are stamped `owner` (the process) and
 *    `updatedAt` = now. An owner's paths through an interface that goes down are withdrawn at link-down (before the
 *    daemon recomputes); the next batch offers them again when it still carries them.
 *  • Multipath: `O` and [C1] `EIGRP` rows share a prefix up to `IPV4_MAX_PATHS` (with `ip route` lines, as in P2).
 *  • `routeCause` renders `ospf 1: O 10.3.0.0/24 [110/3] via 10.0.12.2` ([C1] `eigrp 100: D …`), the process number
 *    read from the configuration when a ctx is given.
 *  • `ipv4.ribWatch {owner, keys?, lpm?}` registers (replaces) the owner's watch, answered at once and after every
 *    handler that changed a watched result with ProcessEvent `ipv4.ribChanged` to that owner only (`{key, row?}` per
 *    exact key, `{lpm: {address, row?}}` per longest-match address; `row` absent = none). Both lists empty = stop.
 *    A world that registers no watch never sees the event.
 *  • The dormant switch transport (D22): on a device whose udp / tcp come only from `managed-switch`
 *    (`dormantTransportEligible`), protocols 17 / 6 are treated as having no listener — P2's `unsupported-protocol`
 *    and ICMP 3/2 — until a `DORMANT_TRANSPORT_OWNERS` line is stored (protocols/ip-upper.ts). Internal state (not in
 *    the StateView, no handle), recomputed at `init` and in every `onConfig`.
 *    [S13] Rulings R17/R27 (W3): an outbound telnet/ssh client session opened from the switch itself also wakes it,
 *    for as long as the session lasts: `ext.ipv4.transportHold {owner, key, hold}` (protocols/ip-upper.ts
 *    `transportHoldRequest`, sent by vty-client) sets or releases a hold; the transport is awake while a configured
 *    line OR a hold exists. Internal state (no debug line, not in the StateView); a world that never opens a client
 *    session on a switch never sets one.
 *  • `ipv4.send` with `iface` and a multicast destination and no `nextHop`: the next hop is the group itself (arp's
 *    IPv4-multicast framing rule then frames it to `01:00:5e` + the low 23 bits).
 *  • [S18] a third wire selector `{layer: 'ipv4', roles: ['tunnel']}`: the tunnel owner's `ingress {port: 'Tunnel0',
 *    layer: 'ipv4'}` reaches ipv4.
 *
 * P3 (ARCHITECTURE-P3 D12, §3.0 (a) steps 2, 6 and 7; W2 l3) — the ACL hooks, copied from NAT's pattern; they exist
 * only while an `ip access-group <list> in|out` line is stored AND the model runs `acl`, so a world without the line
 * runs P2's path byte for byte:
 *  • `ip access-group` per interface and direction is read from the configuration (`readAccessGroups`, the reader acl
 *    uses too) at every delta of the line, at an interface removal and at boot; a changed binding is one 'ip routing'
 *    debug line. Internal state, not in the StateView (§9.1).
 *  • Inbound: right after the header checksum and the rx line, BEFORE the NAT inbound hook and the for-me test, a
 *    packet on a port with an inbound list goes to acl as `acl.filter {family 4, dir 'in', iface, pdu, onPermit:
 *    request ipv4 'ipv4.resume' {pdu, inPort, after: 'acl-in'}}`. The resumed packet continues at the NAT inbound hook
 *    and is never filtered again (traffic to the router itself is filtered too).
 *  • Outbound (transit packets only, after routing and the TTL decrement): when the egress port has an outbound list,
 *    a NAT inside → outside packet goes to nat with `filterOut: true` (nat translates, then hands it to acl); any other
 *    packet goes to acl as `acl.filter {dir 'out', iface: egress, inPort: the ingress port, pdu, onPermit: request arp
 *    'arp.sendVia'}`. Locally originated packets (`ipv4.send`) never pass the outbound hook.
 *  • [S19] a wire selector `{layer: 'ppp', ethertype: 0x0021, roles: ['wan']}` (placed after the HDLC one): an IPv4
 *    packet in a PPP frame on a serial WAN port reaches ipv4.
 *
 * Debug categories: 'ip packet' (rx / deliver / forward / send / drop) and 'ip routing' (route add / remove, lease).
 *
 * stateSnapshot():
 *   { process: 'ipv4', state: { forwarding, interfaces: [{ port, address, prefixLen, installed,
 *     origin?, router?, leaseExpiresAt? }], staticRoutes, forwarded, delivered, sent, dropped, dhcp?, nat?,
 *     virtual?, groups? } }
 *   (`origin`/`router`/`leaseExpiresAt` only on leased interfaces; `dhcp` = DHCP-managed ports, `nat` = the
 *   `ip nat` roles, `virtual` = virtual addresses per port, `groups` = joined groups per port — each only when any)
 */
import {
  broadcastOf,
  inSubnet,
  ipv4ToU32,
  isIpv4,
  isIpv4Broadcast,
  isIpv4Multicast,
  maskToPrefixLen,
  networkOf,
  prefixLenToMask,
  type Ipv4Address,
  type MacAddress,
} from '../contracts/addr.js';
import { L3_ROLES, ROLE_TRAITS, defaultRoleFor } from '../contracts/catalog.js';
import type { PortRole } from '../contracts/catalog.js';
import type { ConfigDelta, ConfigNode } from '../contracts/config.js';
import type { PortId, ProcessName } from '../contracts/ids.js';
import type { DropReason } from '../contracts/link.js';
import {
  ETHERTYPE_IPV4,
  HDLC_PROTO_IPV4,
  PPP_PROTO,
  ICMP_DEST_UNREACHABLE,
  ICMP_TIME_EXCEEDED,
  ICMP_TTL_EXCEEDED_TRANSIT,
  ICMP_UNREACH_NET,
  ICMP_UNREACH_PROTOCOL,
  type LayerView,
  type Pdu,
} from '../contracts/pdu.js';
import type { DeviceModel } from '../contracts/device.js';
import type { PortIpv4Address, VirtualIpv4 } from '../contracts/port.js';
import type { Action, DebugEvent, DemuxSelector, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import { AD_DHCP, AD_STATIC, routeKey, type RouteRow } from '../contracts/tables.js';
import type { SimTime } from '../contracts/time.js';
import type { RibChangedEvent } from '../contracts/transport.js';
import { createRibArbiter, type RibArbiter, type RibDecision, type RibRemoveReason } from '../core/rib-arbiter.js';
import { readAccessGroups, type AclInterfaceGroups } from './acl.js';
import { dormantTransportEligible, ipv4UpperProcess, TRANSPORT_HOLD_REQUEST, transportWakeLine } from './ip-upper.js';

/** Process name, as registered in the protocol registry. */
const NAME = 'ipv4';
/** Debug categories emitted by this daemon. */
const CAT_PACKET = 'ip packet';
const CAT_ROUTING = 'ip routing';
/** Number of DebugEvents retained by `debugEvents()`. */
const DEBUG_RING = 256;
/** RIB key of the default route. */
const DEFAULT_KEY = routeKey('0.0.0.0', 0);
/** Process recorded as `RouteRow.owner` of a DHCP-learned default route. */
export const LEASE_ROUTE_OWNER: ProcessName = 'dhcp-client';
/** Kind of the ProcessEvent that reports an `ipv4.route` decision back to the offering daemon. */
export const ROUTE_DECISION_EVENT = 'ext.ipv4.route';
/** @since P2 Arbiter owner prefix of a static route line: `static|<canonical line>` (D13). */
export const STATIC_OWNER_PREFIX = 'static|';
/** @since P2 How many static routes a next hop may be resolved through (D13: recursion ≤ 8). */
export const STATIC_RECURSION_MAX = 8;
/** @since P2 [S6] Most equal-cost static paths installed for one prefix. */
export const IPV4_MAX_PATHS = 4;
/** @since P2 Drop detail of a transit packet on a device whose routing is switched off (§3.5). */
export const IP_ROUTING_OFF_DETAIL = 'IP routing is switched off on this device (ip routing)';
/** @since P2 The daemon that answers the NAT hooks (D14). */
const NAT_PROCESS: ProcessName = 'nat';
/** @since P3 The daemon that answers the ACL hooks (D12). */
const ACL_HOOK_PROCESS: ProcessName = 'acl';

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
/** Arbiter candidate label of a static route line. */
const staticOwner = (line: string): string => `${STATIC_OWNER_PREFIX}${line}`;

/**
 * Wire selectors: Ethernet type 0x0800 on every L3 role, HDLC protocol 0x0800 on serial WAN ports (§3.9); [S19] PPP
 * protocol 0x0021 on serial WAN ports (ARCHITECTURE-P3 D17, §9.2 item 30); [S18] a bare IPv4 packet the tunnel owner
 * injects on a tunnel port (`ingress {port, layer: 'ipv4'}`, ARCHITECTURE-P3 D17).
 */
export const IPV4_HANDLES: readonly DemuxSelector[] = Object.freeze([
  Object.freeze({ layer: 'ethernet', ethertype: ETHERTYPE_IPV4, roles: L3_ROLES }),
  Object.freeze({ layer: 'hdlc', ethertype: HDLC_PROTO_IPV4, roles: Object.freeze(['wan'] as PortRole[]) }),
  // ── [S19] PPP framing on a serial WAN port ──
  Object.freeze({ layer: 'ppp', ethertype: PPP_PROTO.ipv4, roles: Object.freeze(['wan'] as PortRole[]) }),
  // ── end [S19] ──
  // ── [S18] the tunnel tail ──
  Object.freeze({ layer: 'ipv4', roles: Object.freeze(['tunnel'] as PortRole[]) }),
  // ── end [S18] ──
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

/** @since P2 One `ip route` line (D13): a candidate offered while usable. */
export interface StaticLine {
  /** Canonical line text (`ip route N M [IF] [NH] [AD] [permanent]`); the arbiter owner suffix and the cause. */
  readonly line: string;
  readonly key: string;
  readonly network: Ipv4Address;
  readonly prefixLen: number;
  readonly nextHop?: Ipv4Address;
  readonly iface?: PortId;
  readonly ad: number;
  readonly permanent: boolean;
  readonly isDefault: boolean;
}

/** A static line together with its offer state. */
interface StaticEntry {
  readonly def: StaticLine;
  /** The candidate is currently offered to the RIB (usable). */
  offered: boolean;
}

/** A joined IPv4 group of one port [S2]. */
interface JoinedGroup {
  owner: ProcessName;
  group: Ipv4Address;
}

/** Resolved egress for a routed packet. */
interface Egress {
  nextHop: Ipv4Address;
  iface: PortId;
}

/** @since P3 One registered RIB watch (D8): what the owner watches and the last answer it got for each item. */
interface RibWatch {
  readonly keys: readonly string[];
  readonly lpm: readonly Ipv4Address[];
  /** Fingerprint of the last answer per exact key ('' = no row). */
  readonly lastKeys: Map<string, string>;
  /** Fingerprint of the last answer per address ('' = no route). */
  readonly lastLpm: Map<Ipv4Address, string>;
}

/** @since P3 Arbiter owner of slot `slot` of `owner`'s `ipv4.routes` set (D8). */
export const routeSlotOwner = (owner: ProcessName, slot: number): string => `${owner}|${slot}`;

/** (network u32, prefix length) of a RIB key `a.b.c.d/len`, for the D8 batch order. */
function keyOrder(key: string): [number, number] {
  const slash = key.indexOf('/');
  const net = slash < 0 ? key : key.slice(0, slash);
  const len = slash < 0 ? 32 : Number(key.slice(slash + 1));
  return [isIpv4(net) ? ipv4ToU32(net) : 0, Number.isFinite(len) ? len : 0];
}

/** Ascending (network u32, prefix length), then the key text (a total, deterministic order). */
function compareKeys(a: string, b: string): number {
  const [na, la] = keyOrder(a);
  const [nb, lb] = keyOrder(b);
  if (na !== nb) return na - nb;
  if (la !== lb) return la - lb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A row's content, key order independent, without its timestamp and owner stamp ('' for none). */
function rowFingerprint(row: RouteRow | undefined, withOwner: boolean): string {
  if (row === undefined) return '';
  const rec = row as unknown as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(rec).sort()) {
    if (k === 'updatedAt' || (!withOwner && k === 'owner') || rec[k] === undefined) continue;
    parts.push(`${k}=${JSON.stringify(rec[k])}`);
  }
  return parts.join('|');
}

/** `10.0.12.2` or, for a multipath row, every path's next hop (or interface), comma-joined. */
function hopsOf(row: RouteRow): string {
  if (row.paths !== undefined && row.paths.length > 1) return row.paths.map((p) => p.nextHop ?? p.iface ?? '?').join(', ');
  return row.nextHop ?? row.iface ?? '?';
}

/** `O 10.3.0.0/24 via 10.0.12.2 [110/3]` — one installed row in an 'ip routing' line. */
function installedText(row: RouteRow): string {
  return `${routeSourceCode(row)} ${row.key} via ${hopsOf(row)} [${row.ad}/${row.metric}]`;
}

/** `"10.0.0.1 > 10.0.0.2 ttl 128 proto 1"` — the packet half of every 'ip packet' line. */
function describe(ip: LayerView): string {
  return `${String(ip.fields.src)} > ${String(ip.fields.dst)} ttl ${String(ip.fields.ttl)} proto ${String(ip.fields.protocol)}`;
}

/**
 * @since P3 The `show ip route` code of a row (D11): `C`, `L`, `S` / `S*`, `D*` (the DHCP default), `O`, `O E2`,
 * `O*E2`, [C1] `D` / `D*` for an `'EIGRP'` row (the machine source keeps the two apart; D11).
 */
export function routeSourceCode(route: Pick<RouteRow, 'source' | 'routeType' | 'isDefault' | 'network' | 'prefixLen'>): string {
  const star = route.isDefault === true || (route.prefixLen === 0 && route.network === '0.0.0.0');
  switch (route.source) {
    case 'O':
      if (route.routeType === 'E2') return star ? 'O*E2' : 'O E2';
      return star ? 'O*' : 'O';
    case 'EIGRP':
      return star ? 'D*' : 'D';
    case 'S':
    case 'D':
      return star ? `${route.source}*` : route.source;
    default:
      return route.source;
  }
}

/**
 * @since P3 The number of the configured routing process of `protocol` (`router ospf 1` → '1', [C1] `router eigrp 100`
 * → '100'), read from the running configuration; undefined when none is stored.
 */
export function routingProcessId(ctx: Pick<ProcessCtx, 'config'>, protocol: 'ospf' | 'eigrp'): string | undefined {
  for (const node of ctx.config.root.children) {
    if (node.key === 'router' && node.args[0] === protocol && node.args[1] !== undefined) return node.args[1];
  }
  return undefined;
}

/**
 * Render a RIB row as the config line responsible for it — the `cause` of the TTL decrement and of the ARP send.
 * Static: `ip route N M [IF] [NH] [AD]` (a P1 row has one of IF/NH and distance 1, so its text is unchanged); a
 * default route offered by the `host` daemon (`route.owner === 'host'`) is `ip default-gateway GW`; a DHCP default:
 * `dhcp default route via GW`; connected / local: `connected via <iface>`.
 * P3 (D11): an OSPF row renders `ospf 1: O 10.3.0.0/24 [110/3] via 10.0.12.2` and a [C1] EIGRP row `eigrp 100: D
 * 10.4.0.0/24 [90/3328] via 10.0.12.2`; the process number comes from `ctx`'s configuration (left out without a ctx).
 */
export function routeCause(route: RouteRow, ctx?: Pick<ProcessCtx, 'config'>): string {
  if (route.source === 'S') {
    if (route.owner === 'host' && route.isDefault && route.nextHop !== undefined) return `ip default-gateway ${route.nextHop}`;
    const via = [route.iface, route.nextHop].filter((x): x is string => x !== undefined).join(' ');
    const ad = route.ad !== AD_STATIC ? ` ${route.ad}` : '';
    return `ip route ${route.network} ${prefixLenToMask(route.prefixLen)} ${via === '' ? '?' : via}${ad}`;
  }
  if (route.source === 'D') return `dhcp default route via ${route.nextHop ?? route.iface ?? '?'}`;
  if (route.source === 'O' || route.source === 'EIGRP') {
    const protocol = route.source === 'O' ? 'ospf' : 'eigrp';
    const id = ctx === undefined ? undefined : routingProcessId(ctx, protocol);
    return `${protocol}${id === undefined ? '' : ` ${id}`}: ${routeSourceCode(route)} ${route.network}/${route.prefixLen} [${route.ad}/${route.metric}] via ${route.nextHop ?? route.iface ?? '?'}`;
  }
  return `connected via ${route.iface ?? '?'}`;
}

/**
 * @since P2 [S6] The equal-cost path index of a flow (§4.1, a fixed integer function):
 * `h = u32(src) ^ u32(dst); h ^= h >>> 16; i = h % n`.
 */
export function ecmpIndex(src: Ipv4Address, dst: Ipv4Address, n: number): number {
  if (n <= 1) return 0;
  let h = (ipv4ToU32(src) ^ ipv4ToU32(dst)) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h % n;
}

/**
 * @since P2 True when the running configuration holds the stored negation `no ip routing` (§3.5, D2): the device's
 * forwarding is switched off by configuration. Read at call time; a device without `model.ipForwarding` never
 * forwards whatever the line says.
 */
export function ipRoutingSwitchedOff(ctx: Pick<ProcessCtx, 'config'>): boolean {
  for (const c of ctx.config.root.children) {
    if (c.key === 'no' && c.args.length === 2 && c.args[0] === 'ip' && c.args[1] === 'routing') return true;
  }
  return false;
}

/** @since P2 Effective forwarding: the model forwards and routing is not switched off. */
export function ipForwardingEnabled(ctx: Pick<ProcessCtx, 'config' | 'model'>): boolean {
  return ctx.model.ipForwarding && !ipRoutingSwitchedOff(ctx);
}

/** Case-insensitive lookup of a port name among the device's ports (exact canonical id first). */
function findPort(ctx: Pick<ProcessCtx, 'ports'>, name: string): PortId | undefined {
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

/** Does the model run daemon `name`? */
function hasProcess(ctx: Pick<ProcessCtx, 'model'>, name: ProcessName): boolean {
  return ctx.model.processes.includes(name);
}

/** Order of `virtual4` entries: owner, then address (numeric). */
function compareVirtual(a: VirtualIpv4, b: VirtualIpv4): number {
  if (a.owner !== b.owner) return a.owner < b.owner ? -1 : 1;
  return ipv4ToU32(a.address) - ipv4ToU32(b.address);
}

/**
 * @since P2 Parse the tokens after `ip route` (D13, §5.2): `N M <NH | IF [NH]> [AD] [permanent]`. Returns the canonical
 * line, or a reason it is refused. `ctx` resolves interface names.
 */
export function parseStaticRoute(ctx: Pick<ProcessCtx, 'ports'>, args: readonly string[]): { ok: true; def: StaticLine } | { ok: false; reason: string } {
  const [netArg, mask, ...rest] = args;
  const prefixLen = mask === undefined ? null : maskToPrefixLen(mask);
  if (netArg === undefined || !isIpv4(netArg) || prefixLen === null) return { ok: false, reason: 'invalid network or non-contiguous mask' };
  const network = networkOf(netArg, prefixLen);
  const via = rest[0];
  if (via === undefined) return { ok: false, reason: 'missing next hop or interface' };
  let nextHop: Ipv4Address | undefined;
  let iface: PortId | undefined;
  let i = 1;
  if (isIpv4(via)) nextHop = via;
  else {
    iface = findPort(ctx, via);
    if (iface === undefined) return { ok: false, reason: 'unknown next hop or interface' };
    const nh = rest[1];
    if (nh !== undefined && isIpv4(nh)) {
      nextHop = nh;
      i = 2;
    }
  }
  let ad = AD_STATIC;
  let permanent = false;
  const adTok = rest[i];
  if (adTok !== undefined && /^\d{1,3}$/.test(adTok)) {
    ad = Number(adTok);
    if (ad < 1 || ad > 255) return { ok: false, reason: `distance ${adTok} is out of range (1-255)` };
    i++;
  }
  if (rest[i] === 'permanent') {
    permanent = true;
    i++;
  }
  if (i < rest.length) return { ok: false, reason: `unexpected token ${rest[i] ?? ''}` };
  const parts = ['ip', 'route', network, prefixLenToMask(prefixLen)];
  if (iface !== undefined) parts.push(iface);
  if (nextHop !== undefined) parts.push(nextHop);
  if (ad !== AD_STATIC) parts.push(String(ad));
  if (permanent) parts.push('permanent');
  const def: StaticLine = {
    line: parts.join(' '),
    key: routeKey(network, prefixLen),
    network,
    prefixLen,
    ad,
    permanent,
    isDefault: prefixLen === 0 && network === '0.0.0.0',
    ...(nextHop !== undefined ? { nextHop } : {}),
    ...(iface !== undefined ? { iface } : {}),
  };
  return { ok: true, def };
}

/**
 * Create the IPv4 daemon. Handles IPv4 frames from the wire (Ethernet on L3 roles, HDLC on WAN serial ports) and
 * packets delivered by other daemons; answers `ipv4.send`, `ipv4.route`, `ipv4.lease`, `ipv4.resume`,
 * `ipv4.virtual` and `ipv4.group` requests.
 */
export function createIpv4(): Process {
  const interfaces = new Map<PortId, IfaceAddress>();
  /** Static route lines by canonical text, in configuration order. */
  const statics = new Map<string, StaticEntry>();
  /** Ports configured with `ip address dhcp`, in configuration order. */
  const dhcpPorts: PortId[] = [];
  /** `ip nat inside|outside` per interface (D14). */
  const natRoles = new Map<PortId, 'inside' | 'outside'>();
  /** @since P3 `ip access-group` per interface and direction (D12), by port id; empty in a world without the line. */
  let aclGroups: ReadonlyMap<PortId, AclInterfaceGroups> = new Map();
  /** Virtual addresses per interface (D15), ordered by (owner, address). */
  const virtuals = new Map<PortId, VirtualIpv4[]>();
  /** Joined groups per interface [S2]. */
  const groups = new Map<PortId, JoinedGroup[]>();
  /**
   * @since P3 `ipv4.routes` candidate sets (D8): owner → key → the rows by slot as the owner sent them (a slot is
   * `undefined` after its path was withdrawn at link-down). Owners in first-batch order.
   */
  const routeSets = new Map<ProcessName, Map<string, (RouteRow | undefined)[]>>();
  /**
   * @since P3 D8, §4.5: owner → key → each slot's position in the owner's latest batch. The arbiter's `pathOrder`
   * installs one owner's equal-cost paths in batch order (OSPF's canonical next-hop order), not in offer history.
   */
  const routeOrder = new Map<ProcessName, Map<string, (number | undefined)[]>>();
  /** @since P3 RIB watches by owner (D8), in registration order. */
  const watches = new Map<ProcessName, RibWatch>();
  /** @since P3 D22: a `DORMANT_TRANSPORT_OWNERS` line is stored, so a managed switch's udp/tcp answer. */
  let transportAwake = false;
  /** @since P3 D22: which of udp / tcp are dormant-eligible on the model last seen (recomputed when the model changes). */
  let dormantModel: { model: DeviceModel; udp: boolean; tcp: boolean } | undefined;
  /** @since P3 [S13] R17/R27: outbound client sessions holding the dormant transport awake, by `${owner}|${key}`. */
  const transportHolds = new Set<string>();
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
    if (arbiter === undefined) {
      arbiter = createRibArbiter<RouteRow>({
        table: ctx.tables.rib,
        stampOwner: false,
        maxPaths: IPV4_MAX_PATHS,
        // [S6] `ip route` lines share a prefix; P3 (D8) so do OSPF paths and [C1] EIGRP successors; offered
        // `ipv4.route` rows (owner set), C/L and D rows install alone
        multipathEligible: (row) => (row.source === 'S' && row.owner === undefined) || row.source === 'O' || row.source === 'EIGRP',
        pathCause: (row) => routeCause(row, ctx),
        // P3 (D8, §4.5): two paths of one `ipv4.routes` owner install in its batch order; every other pair keeps the
        // P1/P2 offer order (no batch in a P1/P2 world, so their bytes are unchanged)
        pathOrder: (a, aOwner, b, bOwner) => {
          if (a.owner === undefined || a.owner !== b.owner) return 0;
          const pa = batchPosition(a, aOwner);
          const pb = batchPosition(b, bOwner);
          return pa === undefined || pb === undefined ? 0 : pa - pb;
        },
      });
    }
    return arbiter;
  }

  /** P3 (D8): the batch position of an `ipv4.routes` slot candidate (`${owner}|${slot}`), else undefined. */
  function batchPosition(row: RouteRow, arbOwner: ProcessName): number | undefined {
    const owner = row.owner;
    if (owner === undefined || !arbOwner.startsWith(`${owner}|`)) return undefined;
    const slot = Number(arbOwner.slice(owner.length + 1));
    return Number.isInteger(slot) ? routeOrder.get(owner)?.get(row.key)?.[slot] : undefined;
  }

  /** Recompute the effective forwarding flag (model data and the `ip routing` line). */
  function syncForwarding(ctx: ProcessCtx): void {
    forwarding = ipForwardingEnabled(ctx);
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
    const wasInstalled = arb.installedOwners(key).includes(owner);
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
      else debug(ctx, CAT_ROUTING, `C ${row.key} via ${port} kept as a candidate: ${d.after ? routeCause(d.after, ctx) : 'another route'} is installed`, { key: row.key, source: 'C', iface: port });
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
    else debug(ctx, CAT_ROUTING, `L ${local.key} via ${port} kept as a candidate: ${dl.after ? routeCause(dl.after, ctx) : 'another route'} is installed`, { key: local.key, source: 'L', iface: port });
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
        debug(ctx, CAT_ROUTING, `D ${DEFAULT_KEY} via ${entry.router} kept as a candidate: ${dd.after ? routeCause(dd.after, ctx) : 'another route'} is preferred`, {
          key: DEFAULT_KEY, source: 'D', nextHop: entry.router, iface: port,
        });
      }
    }
    entry.installed = true;
    settleStatics(ctx);
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
    settleStatics(ctx);
  }

  /**
   * Bring the port's L3 state in line with its configured address, its effective role and `up`:
   * not L3 → routes withdrawn and L3 state cleared; L3 → `setPortL3` once, C/L rows (plus a gratuitous ARP) while
   * up, rows removed ('link-down') while down. Trusts `up` (during a role-change bounce the port view may lag).
   */
  function reconcile(ctx: ProcessCtx, port: PortId, up: boolean): Action[] {
    const entry = interfaces.get(port);
    if (entry === undefined) {
      // no address here, but a static route may leave through this interface (exit-interface form)
      settleStatics(ctx);
      return [];
    }
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
    if (entry !== undefined && entry.origin !== undefined && hasProcess(ctx, LEASE_ROUTE_OWNER)) {
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

  // ── static routes (D13) ───────────────────────────────────────────────────

  /** The static line that installed the row of `key` (its first path), if the installed row is one of ours. */
  function staticInstalledAt(ctx: ProcessCtx, key: string): StaticEntry | undefined {
    const owner = rib(ctx).installedOwner(key);
    if (owner === undefined || !owner.startsWith(STATIC_OWNER_PREFIX)) return undefined;
    return statics.get(owner.slice(STATIC_OWNER_PREFIX.length));
  }

  /**
   * Is `nextHop` on a subnet whose connected route this daemon has installed? ipv4's own record answers first: the
   * port view lags one step behind `setAddress` (the runtime applies the returned `setPortL3` after the handler
   * returns), so a re-addressed port would still answer with its OLD subnet (W5 fix). `ctx.connectedPortFor` still
   * answers for a port whose address ipv4 does not manage (a hand-built view in a unit fixture, §9.1 arp.host).
   */
  function directlyConnected(ctx: ProcessCtx, nextHop: Ipv4Address): boolean {
    for (const e of interfaces.values()) if (e.installed && inSubnet(nextHop, e.address, e.prefixLen)) return true;
    const port = ctx.connectedPortFor(nextHop);
    return port !== undefined && !interfaces.has(port);
  }

  /** The address an exit interface holds for D13 (ipv4's own record first, as `directlyConnected`); undefined when down or unaddressed. */
  function exitAddress(ctx: ProcessCtx, port: PortId): { address: Ipv4Address; prefixLen: number } | undefined {
    const own = interfaces.get(port);
    if (own !== undefined) return own.installed ? own : undefined;
    const view = ctx.ports.get(port);
    return view !== undefined && view.operUp ? view.l3.ipv4 : undefined;
  }

  /**
   * D13 "usable": exit interface up and addressed (a fully specified route also needs its next hop on that subnet);
   * or the next hop directly connected, or resolved through the RIB — ignoring every route of the line's own prefix
   * (its own candidate and a floating or equal-cost twin alike, as `resolveVia` does; W5 fix: resolving through a
   * twin made the table flip-flop until the round limit) — recursively through static lines up to
   * `STATIC_RECURSION_MAX` deep. `permanent` lines are always usable.
   */
  function usable(ctx: ProcessCtx, entry: StaticEntry, depth: number, visiting: Set<string>): boolean {
    const s = entry.def;
    if (s.permanent) return true;
    if (s.iface !== undefined) {
      const l3 = exitAddress(ctx, s.iface);
      if (l3 === undefined) return false;
      return s.nextHop === undefined || inSubnet(s.nextHop, l3.address, l3.prefixLen);
    }
    const nextHop = s.nextHop as Ipv4Address;
    if (directlyConnected(ctx, nextHop)) return true;
    if (depth >= STATIC_RECURSION_MAX) return false;
    const added = !visiting.has(s.key);
    visiting.add(s.key);
    try {
      for (const inner of ctx.lpm(nextHop).candidates) {
        if (inner.source === 'L') return false;
        if (visiting.has(inner.key)) continue; // a route of the line's own prefix (or one already on the path): ignored
        const via = staticInstalledAt(ctx, inner.key);
        if (via === undefined) return true; // connected, DHCP default or a route offered by another daemon
        return usable(ctx, via, depth + 1, visiting);
      }
      return false;
    } finally {
      if (added) visiting.delete(s.key);
    }
  }

  function staticRow(ctx: ProcessCtx, s: StaticLine): RouteRow {
    const row: RouteRow = { key: s.key, network: s.network, prefixLen: s.prefixLen, source: 'S', ad: s.ad, metric: 0, updatedAt: ctx.now };
    if (s.nextHop !== undefined) row.nextHop = s.nextHop;
    if (s.iface !== undefined) row.iface = s.iface;
    if (s.isDefault) row.isDefault = true;
    return row;
  }

  function offerStatic(ctx: ProcessCtx, entry: StaticEntry): void {
    const s = entry.def;
    const owner = staticOwner(s.line);
    entry.offered = true;
    const d = rib(ctx).offer(staticRow(ctx, s), owner);
    const via = [s.iface, s.nextHop].filter((x): x is string => x !== undefined).join(' ');
    // the P1 data shape, byte for byte; the distance only when it is not the default
    const data: Record<string, unknown> = { key: s.key, source: 'S', nextHop: s.nextHop, iface: s.iface, isDefault: s.isDefault };
    if (s.ad !== AD_STATIC) data.ad = s.ad;
    if (rib(ctx).installedOwners(s.key).includes(owner)) {
      const paths = d.after?.paths;
      const extra = paths !== undefined && paths.length > 1 ? ` (equal-cost path ${paths.length} of ${paths.length})` : '';
      debug(ctx, CAT_ROUTING, `add S ${s.key} via ${via}${s.isDefault ? ' (default)' : ''}${s.ad !== AD_STATIC ? ` (distance ${s.ad})` : ''}${extra}`, data);
    } else {
      debug(ctx, CAT_ROUTING, `S ${s.key} via ${via} kept as a candidate: ${d.after ? routeCause(d.after, ctx) : 'another route'} is installed`, data);
    }
  }

  /**
   * Withdraw a line's candidate. Without `why` (the line was removed by `no ip route`) the P1 wording and data are
   * kept byte for byte; with `why` the line stopped being usable (P2 D13).
   */
  function withdrawStatic(ctx: ProcessCtx, entry: StaticEntry, why?: string): void {
    const s = entry.def;
    entry.offered = false;
    const via = [s.iface, s.nextHop].filter((x): x is string => x !== undefined).join(' ');
    withdrawRoute(ctx, s.key, staticOwner(s.line), 'cleared', () => {
      if (why === undefined) debug(ctx, CAT_ROUTING, `remove S ${s.key} via ${via}`, { key: s.key, source: 'S' });
      else debug(ctx, CAT_ROUTING, `remove S ${s.key} via ${via} (${why})`, { key: s.key, source: 'S', nextHop: s.nextHop, iface: s.iface, reason: why });
    });
  }

  /** Offer every usable static line and withdraw every unusable one, to a fixed point (bounded by the line count). */
  function settleStatics(ctx: ProcessCtx): void {
    if (statics.size === 0) return;
    let changed = true;
    for (let round = 0; changed && round <= statics.size; round++) {
      changed = false;
      for (const entry of statics.values()) {
        const ok = usable(ctx, entry, 0, new Set());
        if (ok && !entry.offered) {
          offerStatic(ctx, entry);
          changed = true;
        } else if (!ok && entry.offered) {
          withdrawStatic(ctx, entry, entry.def.iface !== undefined ? `${entry.def.iface} is not usable` : `next hop ${entry.def.nextHop ?? '?'} is not reachable`);
          changed = true;
        }
      }
    }
  }

  /** `ip route …` (set): remember the line; it is installed when usable. */
  function addStatic(ctx: ProcessCtx, args: readonly string[]): void {
    const parsed = parseStaticRoute(ctx, args);
    if (!parsed.ok) {
      debug(ctx, CAT_ROUTING, `ignored ip route ${args.join(' ')}: ${parsed.reason}`, { line: `ip route ${args.join(' ')}`, reason: parsed.reason });
      return;
    }
    const def = parsed.def;
    if (statics.has(def.line)) {
      settleStatics(ctx);
      return;
    }
    // a line that is not usable yet is silent (§9.3 (a): only the install moves; no event is added); it is
    // installed, with its `add S` line, in the step in which its next hop becomes reachable
    statics.set(def.line, { def, offered: false });
    settleStatics(ctx);
  }

  function removeStatic(ctx: ProcessCtx, entry: StaticEntry): void {
    statics.delete(entry.def.line);
    if (entry.offered) withdrawStatic(ctx, entry);
    settleStatics(ctx);
  }

  /** `no ip route …`: the exact line, or every static when no arguments follow. */
  function unsetStaticLine(ctx: ProcessCtx, line: readonly string[]): void {
    if (line.length <= 2) {
      for (const entry of Array.from(statics.values())) removeStatic(ctx, entry);
      return;
    }
    const parsed = parseStaticRoute(ctx, line.slice(2));
    if (!parsed.ok) return;
    const entry = statics.get(parsed.def.line);
    if (entry !== undefined) removeStatic(ctx, entry);
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
    settleStatics(ctx);
    return [{ type: 'event', to: req.owner, ev }];
  }

  // ── P3: route batches and the RIB watch (D8) ──────────────────────────────

  /** One 'ip routing' line for a change of the installed row of `key` (none when it did not change). */
  function reportInstalled(ctx: ProcessCtx, key: string, before: RouteRow | undefined, after: RouteRow | undefined, why: string): void {
    if (before === after) return;
    if (after === undefined && before !== undefined) {
      debug(ctx, CAT_ROUTING, `remove ${installedText(before)} (${why})`, { key, source: before.source, nextHop: before.nextHop, iface: before.iface, reason: why });
    } else if (after !== undefined && before === undefined) {
      debug(ctx, CAT_ROUTING, `add ${installedText(after)} (${why})`, { key, source: after.source, nextHop: after.nextHop, iface: after.iface, ad: after.ad, metric: after.metric });
    } else if (after !== undefined && before !== undefined) {
      debug(ctx, CAT_ROUTING, `change ${installedText(after)} (${why}; was ${installedText(before)})`, {
        key, source: after.source, nextHop: after.nextHop, iface: after.iface, ad: after.ad, metric: after.metric,
      });
    }
  }

  /** The row `owner` offers for one slot: the owner's row stamped with the owner and now, never carrying `paths`. */
  function slotRow(ctx: ProcessCtx, owner: ProcessName, r: RouteRow): RouteRow {
    const row: RouteRow = { ...r, owner, updatedAt: ctx.now };
    if ('paths' in row) delete row.paths;
    return row;
  }

  /** A row `ipv4.routes` can offer: a canonical key for its network and prefix length, finite AD and metric. */
  function validBatchRow(r: RouteRow): boolean {
    return (
      isIpv4(r.network) && Number.isInteger(r.prefixLen) && r.prefixLen >= 0 && r.prefixLen <= 32 &&
      r.key === routeKey(networkOf(r.network, r.prefixLen), r.prefixLen) && r.network === networkOf(r.network, r.prefixLen) &&
      Number.isFinite(r.ad) && Number.isFinite(r.metric)
    );
  }

  /**
   * The slots of one key after a batch (D8): a new row identical to a stored one keeps that stored slot (no write); every
   * other new row takes its own index when that slot is free, else the lowest free slot — a changed next hop in a
   * single-path set is a re-offer of slot 0 in place (one tableWrite). Returns the new slot array, each slot's position
   * in the batch (`order`, read by the arbiter's `pathOrder`) and the steps in the D8 order: re-offers of changed
   * slots, offers into empty slots, withdrawals of vanished ones.
   */
  function planSlots(old: readonly (RouteRow | undefined)[], fresh: readonly RouteRow[]): {
    slots: (RouteRow | undefined)[];
    order: (number | undefined)[];
    reoffer: number[];
    offer: number[];
    withdraw: number[];
  } {
    const oldFp = old.map((r) => (r === undefined ? undefined : rowFingerprint(r, false)));
    const claimed = new Set<number>();
    const placed: (number | undefined)[] = fresh.map(() => undefined);
    const newFp = fresh.map((r) => rowFingerprint(r, false));
    // 1. unchanged rows keep their slot: the same index first, then any other stored slot holding the same row
    for (let j = 0; j < fresh.length; j++) {
      if (oldFp[j] !== undefined && oldFp[j] === newFp[j] && !claimed.has(j)) {
        placed[j] = j;
        claimed.add(j);
      }
    }
    for (let j = 0; j < fresh.length; j++) {
      if (placed[j] !== undefined) continue;
      const k = oldFp.findIndex((fp, i) => fp !== undefined && fp === newFp[j] && !claimed.has(i));
      if (k >= 0) {
        placed[j] = k;
        claimed.add(k);
      }
    }
    // 2. the others: their own index when free, else the lowest free slot
    for (let j = 0; j < fresh.length; j++) {
      if (placed[j] !== undefined) continue;
      let k = claimed.has(j) ? -1 : j;
      if (k < 0) for (k = 0; claimed.has(k); k++);
      placed[j] = k;
      claimed.add(k);
    }
    const size = Math.max(old.length, ...placed.map((k) => (k ?? 0) + 1));
    const slots: (RouteRow | undefined)[] = Array.from({ length: size }, () => undefined);
    const order: (number | undefined)[] = Array.from({ length: size }, () => undefined);
    const reoffer: number[] = [];
    const offer: number[] = [];
    for (let j = 0; j < fresh.length; j++) {
      const k = placed[j]!;
      slots[k] = fresh[j];
      order[k] = j;
      if (oldFp[k] === newFp[j]) continue;
      if (oldFp[k] !== undefined) reoffer.push(k);
      else offer.push(k);
    }
    const withdraw: number[] = [];
    for (let k = 0; k < old.length; k++) if (oldFp[k] !== undefined && !claimed.has(k)) withdraw.push(k);
    reoffer.sort((a, b) => a - b);
    offer.sort((a, b) => a - b);
    // trailing empty slots carry nothing
    while (slots.length > 0 && slots[slots.length - 1] === undefined) slots.pop();
    order.length = slots.length;
    return { slots, order, reoffer, offer, withdraw };
  }

  /**
   * `ipv4.routes {owner, rows}` (D8): replace `owner`'s candidate set. Keys in ascending (network u32, prefix length)
   * order; per key, re-offer the changed slots, offer the new ones, withdraw the vanished ones (`planSlots`);
   * `settleStatics` once; no decision event.
   */
  function routesRequest(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'ipv4.routes' }>): Action[] {
    const owner = req.owner;
    const arb = rib(ctx);
    const next = new Map<string, RouteRow[]>();
    for (const r of req.rows) {
      if (!validBatchRow(r)) {
        debug(ctx, CAT_ROUTING, `ignored route ${String(r.key)} from ${owner}: invalid network, prefix length or distance`, { key: r.key, owner });
        continue;
      }
      const copy: RouteRow = { ...r };
      const list = next.get(r.key);
      if (list === undefined) next.set(r.key, [copy]);
      else list.push(copy);
    }
    const prev = routeSets.get(owner) ?? new Map<string, (RouteRow | undefined)[]>();
    const set = new Map<string, (RouteRow | undefined)[]>();
    const order = new Map<string, (number | undefined)[]>();
    routeOrder.set(owner, order);
    const keys = Array.from(new Set([...prev.keys(), ...next.keys()])).sort(compareKeys);
    for (const key of keys) {
      const plan = planSlots(prev.get(key) ?? [], next.get(key) ?? []);
      // the batch positions first, so every settle of this key orders the owner's paths by the new batch
      if (plan.slots.length > 0) order.set(key, plan.order);
      const before = arb.installed(key);
      for (const k of plan.reoffer) arb.offer(slotRow(ctx, owner, plan.slots[k]!), routeSlotOwner(owner, k));
      for (const k of plan.offer) arb.offer(slotRow(ctx, owner, plan.slots[k]!), routeSlotOwner(owner, k));
      for (const k of plan.withdraw) arb.withdraw(key, routeSlotOwner(owner, k), ctx.now, 'cleared');
      reportInstalled(ctx, key, before, arb.installed(key), owner);
      if (plan.slots.length > 0) set.set(key, plan.slots);
    }
    if (set.size === 0) {
      routeSets.delete(owner);
      routeOrder.delete(owner);
    } else routeSets.set(owner, set);
    settleStatics(ctx);
    return [];
  }

  /**
   * D8: at link-down, withdraw every `ipv4.routes` path through `port` (before the owner recomputes); the slot is
   * forgotten, so the owner's next batch offers it again if it still carries it.
   */
  function withdrawPathsVia(ctx: ProcessCtx, port: PortId): void {
    if (routeSets.size === 0) return;
    const arb = rib(ctx);
    let changed = false;
    for (const [owner, set] of routeSets) {
      for (const key of Array.from(set.keys()).sort(compareKeys)) {
        const slots = set.get(key)!;
        const before = arb.installed(key);
        let hit = false;
        for (let i = 0; i < slots.length; i++) {
          if (slots[i]?.iface !== port) continue;
          slots[i] = undefined;
          arb.withdraw(key, routeSlotOwner(owner, i), ctx.now, 'link-down');
          hit = true;
        }
        if (!hit) continue;
        changed = true;
        reportInstalled(ctx, key, before, arb.installed(key), `${owner}: ${port} went down`);
      }
    }
    if (changed) settleStatics(ctx);
  }

  /** The current answer of a watch item. */
  const keyAnswer = (ctx: ProcessCtx, key: string): RouteRow | undefined => ctx.tables.rib.get(key);
  const lpmAnswer = (ctx: ProcessCtx, address: Ipv4Address): RouteRow | undefined => ctx.lpm(address).winner;

  function keyEvent(owner: ProcessName, key: string, row: RouteRow | undefined): Action {
    const ev: RibChangedEvent = row === undefined ? { kind: 'ipv4.ribChanged', key } : { kind: 'ipv4.ribChanged', key, row: { ...row } };
    return { type: 'event', to: owner, ev };
  }

  function lpmEvent(owner: ProcessName, address: Ipv4Address, row: RouteRow | undefined): Action {
    const ev: RibChangedEvent = { kind: 'ipv4.ribChanged', lpm: row === undefined ? { address } : { address, row: { ...row } } };
    return { type: 'event', to: owner, ev };
  }

  /** `ipv4.ribWatch` (D8): register (replace) the owner's watch and answer every item at once; empty lists stop it. */
  function ribWatchRequest(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'ipv4.ribWatch' }>): Action[] {
    const keys = Array.from(new Set(req.keys ?? []));
    const lpm = Array.from(new Set((req.lpm ?? []).filter((a) => isIpv4(a))));
    if (keys.length === 0 && lpm.length === 0) {
      watches.delete(req.owner);
      return [];
    }
    const w: RibWatch = { keys, lpm, lastKeys: new Map(), lastLpm: new Map() };
    watches.set(req.owner, w);
    const out: Action[] = [];
    for (const key of keys) {
      const row = keyAnswer(ctx, key);
      w.lastKeys.set(key, rowFingerprint(row, true));
      out.push(keyEvent(req.owner, key, row));
    }
    for (const address of lpm) {
      const row = lpmAnswer(ctx, address);
      w.lastLpm.set(address, rowFingerprint(row, true));
      out.push(lpmEvent(req.owner, address, row));
    }
    return out;
  }

  /** `ipv4.ribChanged` for every watched item whose answer changed since it was last sent (nothing without watches). */
  function watchEvents(ctx: ProcessCtx): Action[] {
    if (watches.size === 0) return [];
    const out: Action[] = [];
    for (const [owner, w] of watches) {
      for (const key of w.keys) {
        const row = keyAnswer(ctx, key);
        const fp = rowFingerprint(row, true);
        if (w.lastKeys.get(key) === fp) continue;
        w.lastKeys.set(key, fp);
        out.push(keyEvent(owner, key, row));
      }
      for (const address of w.lpm) {
        const row = lpmAnswer(ctx, address);
        const fp = rowFingerprint(row, true);
        if (w.lastLpm.get(address) === fp) continue;
        w.lastLpm.set(address, fp);
        out.push(lpmEvent(owner, address, row));
      }
    }
    return out;
  }

  /** `actions` followed by the watch answers the handler's RIB changes caused (the same array when there are none). */
  function withWatches(ctx: ProcessCtx, actions: Action[]): Action[] {
    if (watches.size === 0) return actions;
    const evs = watchEvents(ctx);
    return evs.length === 0 ? actions : [...actions, ...evs];
  }

  // ── P3: the dormant switch transport (D22) ────────────────────────────────

  /** Re-read the stored configuration: is a line of `DORMANT_TRANSPORT_OWNERS` present? Only on an eligible device. */
  function syncTransport(ctx: ProcessCtx): void {
    const e = dormantEligibility(ctx);
    if (!e.udp && !e.tcp) return;
    transportAwake = transportWakeLine(ctx.config.root) !== undefined;
  }

  function dormantEligibility(ctx: ProcessCtx): { udp: boolean; tcp: boolean } {
    if (dormantModel === undefined || dormantModel.model !== ctx.model) {
      dormantModel = { model: ctx.model, udp: dormantTransportEligible(ctx.model, 'udp'), tcp: dormantTransportEligible(ctx.model, 'tcp') };
    }
    return dormantModel;
  }

  /** D22: `target` (udp or tcp) is dormant on this device — treated as having no listener. */
  function transportDormant(ctx: ProcessCtx, target: ProcessName): boolean {
    // [S13] R27: an outbound client session's hold wakes it like a configured service line
    if (transportAwake || transportHolds.size > 0 || (target !== 'udp' && target !== 'tcp')) return false;
    const e = dormantEligibility(ctx);
    return target === 'udp' ? e.udp : e.tcp;
  }

  /** [S13] R17/R27: set or release an outbound session's hold on the dormant transport (`ext.ipv4.transportHold`). */
  function transportHold(req: ProcessRequest): Action[] {
    const r = req as { owner?: unknown; key?: unknown; hold?: unknown };
    if (typeof r.owner !== 'string' || typeof r.key !== 'string' || typeof r.hold !== 'boolean') return [];
    const id = `${r.owner}|${r.key}`;
    if (r.hold) transportHolds.add(id);
    else transportHolds.delete(id);
    return [];
  }

  // ── NAT roles, virtual addresses and groups (D14, D15, S2) ────────────────

  function setNatRole(ctx: ProcessCtx, port: PortId, side: string | undefined, on: boolean): void {
    if (!on || side === undefined) {
      if (natRoles.delete(port)) debug(ctx, CAT_ROUTING, `interface ${port} is no longer a NAT interface`, { port });
      return;
    }
    if (side !== 'inside' && side !== 'outside') return;
    if (natRoles.get(port) === side) return;
    natRoles.set(port, side);
    debug(ctx, CAT_ROUTING, `interface ${port} is a NAT ${side} interface`, { port, side });
  }

  function natHooked(ctx: ProcessCtx): boolean {
    return natRoles.size > 0 && hasProcess(ctx, NAT_PROCESS);
  }

  // ── P3: the ACL hooks (D12) ───────────────────────────────────────────────

  /**
   * Re-read every `ip access-group` binding from the configuration (the reader acl uses, so the two never disagree);
   * one 'ip routing' line per (port, direction) whose list changed. Nothing is logged in a world without the line.
   */
  function syncAccessGroups(ctx: ProcessCtx): void {
    const next = new Map<PortId, AclInterfaceGroups>();
    for (const [name, g] of readAccessGroups(ctx.config)) next.set(findPort(ctx, name) ?? name, g);
    const ports = Array.from(new Set([...aclGroups.keys(), ...next.keys()]));
    for (const port of ports) {
      for (const dir of ['in', 'out'] as const) {
        const before = aclGroups.get(port)?.[dir];
        const after = next.get(port)?.[dir];
        if (before === after) continue;
        const word = dir === 'in' ? 'inbound' : 'outbound';
        if (after === undefined) debug(ctx, CAT_ROUTING, `interface ${port} no longer filters ${word} packets (access list ${before ?? '?'})`, { port, dir });
        else debug(ctx, CAT_ROUTING, `interface ${port} filters ${word} packets with access list ${after}`, { port, dir, list: after });
      }
    }
    aclGroups = next;
  }

  /** The list bound on `port` for `dir`, when the hooks exist (a line is stored and the model runs acl). */
  function aclListOn(ctx: ProcessCtx, port: PortId, dir: 'in' | 'out'): string | undefined {
    if (aclGroups.size === 0 || !hasProcess(ctx, ACL_HOOK_PROCESS)) return undefined;
    return aclGroups.get(port)?.[dir];
  }

  /** Is this delta an `ip access-group` line, or the removal of an interface that carried a binding? */
  function isAccessGroupDelta(delta: ConfigDelta): boolean {
    const head = delta.context[0];
    if (delta.context.length === 1 && head !== undefined && head[0] === 'interface') return delta.line[0] === 'ip' && delta.line[1] === 'access-group';
    return delta.context.length === 0 && delta.op === 'unset' && delta.line[0] === 'interface' && aclGroups.size > 0;
  }

  function virtualRequest(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'ipv4.virtual' }>): Action[] {
    if (!ctx.ports.has(req.iface) || !isIpv4(req.address)) {
      debug(ctx, CAT_ROUTING, `ignored virtual address ${req.address} on ${req.iface}: ${ctx.ports.has(req.iface) ? 'invalid address' : 'unknown interface'}`, { port: req.iface, address: req.address });
      return [];
    }
    const list = (virtuals.get(req.iface) ?? []).filter((v) => !(v.owner === req.owner && v.address === req.address));
    const out: Action[] = [];
    if (req.op === 'add') {
      list.push({ address: req.address, mac: req.mac, owner: req.owner, local: req.local });
      list.sort(compareVirtual);
      virtuals.set(req.iface, list);
      debug(ctx, CAT_ROUTING, `virtual address ${req.address} (${req.mac}) on ${req.iface} for ${req.owner}${req.local ? ', delivered locally' : ', answered only'}`, {
        port: req.iface, address: req.address, mac: req.mac, owner: req.owner, local: req.local,
      });
      out.push({ type: 'setPortL3', port: req.iface, virtual4: list.map((v) => ({ ...v })) });
      if (req.local) out.push({ type: 'request', to: 'arp', req: { kind: 'arp.gratuitous', iface: req.iface, address: req.address, mac: req.mac } });
      return out;
    }
    if (list.length === 0) virtuals.delete(req.iface);
    else virtuals.set(req.iface, list);
    debug(ctx, CAT_ROUTING, `virtual address ${req.address} on ${req.iface} for ${req.owner} removed`, { port: req.iface, address: req.address, owner: req.owner });
    out.push({ type: 'setPortL3', port: req.iface, virtual4: list.length === 0 ? null : list.map((v) => ({ ...v })) });
    return out;
  }

  /** [S2] `ipv4.group`: joined groups per port, written as the sorted unique list. */
  function groupRequest(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'ipv4.group' }>): Action[] {
    if (!ctx.ports.has(req.iface) || !isIpv4(req.group) || !isIpv4Multicast(req.group)) {
      debug(ctx, CAT_ROUTING, `ignored group ${req.group} on ${req.iface}: ${ctx.ports.has(req.iface) ? 'not a multicast group' : 'unknown interface'}`, { port: req.iface, group: req.group });
      return [];
    }
    const list = (groups.get(req.iface) ?? []).filter((g) => !(g.owner === req.owner && g.group === req.group));
    if (req.op === 'join') list.push({ owner: req.owner, group: req.group });
    if (list.length === 0) groups.delete(req.iface);
    else groups.set(req.iface, list);
    const joined = Array.from(new Set(list.map((g) => g.group))).sort((a, b) => ipv4ToU32(a) - ipv4ToU32(b));
    debug(ctx, CAT_ROUTING, `${req.owner} ${req.op === 'join' ? 'joined' : 'left'} group ${req.group} on ${req.iface}`, { port: req.iface, group: req.group, owner: req.owner, groups: joined });
    return [{ type: 'setPortL3', port: req.iface, groups4: joined.length === 0 ? null : joined }];
  }

  /** A LOCAL virtual address of an up port (D15): the packet is for this device. */
  function isLocalVirtual(ctx: ProcessCtx, dst: Ipv4Address): boolean {
    for (const [port, list] of virtuals) {
      if (!portUp(ctx, port)) continue;
      for (const v of list) if (v.local && v.address === dst) return true;
    }
    return false;
  }

  /** [S2] A group joined on `port`. */
  function isJoinedGroup(dst: Ipv4Address, port: PortId): boolean {
    const list = groups.get(port);
    return list !== undefined && list.some((g) => g.group === dst);
  }

  // ── config replay at boot ─────────────────────────────────────────────────

  /** Pick up `ip address` / `ip nat` / `ip route` lines already present in the running config (idempotent). */
  function syncFromConfig(ctx: ProcessCtx): Action[] {
    const actions: Action[] = [];
    const root: ConfigNode = ctx.config.root;
    for (const section of root.children) {
      if (section.key === 'interface') {
        const port = section.args[0];
        if (port === undefined) continue;
        for (const child of section.children) {
          const lines: string[][] = [];
          if (child.key === 'ip' && child.args.length === 0) for (const leaf of child.children) lines.push([leaf.key, ...leaf.args]);
          else if (child.key === 'ip') lines.push(child.args.slice());
          for (const l of lines) {
            if (l[0] === 'address' && !interfaces.has(port) && !isDhcpPort(port)) {
              if (l[1] === 'dhcp') actions.push(...setDhcp(ctx, port));
              else if (l.length >= 3) actions.push(...setAddress(ctx, port, l[1]!, l[2]!));
            } else if (l[0] === 'nat') {
              setNatRole(ctx, port, l[1], true);
            }
          }
        }
      } else if (section.key === 'ip') {
        if (section.args.length === 0) {
          for (const leaf of section.children) if (leaf.key === 'route') addStatic(ctx, leaf.args);
        } else if (section.args[0] === 'route') {
          addStatic(ctx, section.args.slice(1));
        }
      }
    }
    return actions;
  }

  // ── routing ───────────────────────────────────────────────────────────────

  /**
   * Egress for a next hop / interface pair: interface = `iface`, or the port whose subnet holds the next hop, or
   * the egress of the next hop's own longest match, recursively (depth ≤ `STATIC_RECURSION_MAX`). The match walks
   * the candidates the way D13 `usable` does: a route's own candidate (and any route already on the recursion path)
   * is skipped, so a static whose next hop lies inside its own prefix forwards through the covering route that
   * installed it; an `L` row stops the walk.
   */
  function resolveVia(ctx: ProcessCtx, key: string, nextHop: Ipv4Address, iface: PortId | undefined, depth: number, visiting: Set<string> = new Set()): Egress | undefined {
    if (iface !== undefined) return { nextHop, iface };
    const direct = ctx.connectedPortFor(nextHop);
    if (direct !== undefined) return { nextHop, iface: direct };
    if (depth >= STATIC_RECURSION_MAX) return undefined;
    visiting.add(key);
    for (const inner of ctx.lpm(nextHop).candidates) {
      if (inner.source === 'L') return undefined;
      if (visiting.has(inner.key)) continue; // the route's own candidate (or a loop): ignored
      if (inner.nextHop !== undefined) return resolveVia(ctx, inner.key, inner.nextHop, inner.iface, depth + 1, visiting);
      if (inner.iface !== undefined) return { nextHop, iface: inner.iface };
      return undefined;
    }
    return undefined;
  }

  /**
   * Egress for a matched route: next hop = `route.nextHop` or the destination itself (connected); with several
   * equal-cost paths [S6] the flow hash picks one. Returns the egress and the cause (the path's line or the route's).
   */
  function resolveEgress(ctx: ProcessCtx, route: RouteRow, src: Ipv4Address, dst: Ipv4Address): { egress: Egress | undefined; cause: string } {
    const paths = route.paths;
    if (paths !== undefined && paths.length > 1) {
      const path = paths[ecmpIndex(src, dst, paths.length)]!;
      return { egress: resolveVia(ctx, route.key, path.nextHop ?? dst, path.iface, 0), cause: path.cause ?? routeCause(route, ctx) };
    }
    return { egress: resolveVia(ctx, route.key, route.nextHop ?? dst, route.iface, 0), cause: routeCause(route, ctx) };
  }

  function icmpError(original: Pdu, type: number, code: number, inPort?: PortId): Action {
    const req: ProcessRequest =
      inPort === undefined ? { kind: 'icmp.error', original, type, code } : { kind: 'icmp.error', original, type, code, inPort };
    return { type: 'request', to: 'icmpv4', req };
  }

  /** Transit forwarding of a packet received on `port`. */
  function forward(ctx: ProcessCtx, pdu: Pdu, ip: LayerView, port: PortId): Action[] {
    const src = String(ip.fields.src);
    const dst = String(ip.fields.dst);
    const ttl = Number(ip.fields.ttl);
    if (isIpv4Broadcast(dst) || isIpv4Multicast(dst)) {
      return [drop(ctx, pdu, 'not-for-me', 'broadcast and multicast packets are never forwarded', port)];
    }
    const route = ctx.lpm(dst).winner;
    const resolved = route ? resolveEgress(ctx, route, src, dst) : undefined;
    const egress = resolved?.egress;
    if (egress !== undefined && egress.nextHop === dst) {
      const l3 = ctx.ports.get(egress.iface)?.l3.ipv4;
      if (l3 !== undefined && l3.prefixLen < 31 && dst === broadcastOf(l3.address, l3.prefixLen)) {
        return [drop(ctx, pdu, 'not-for-me', 'directed broadcasts are not forwarded (no ip directed-broadcast)', port)];
      }
    }
    if (ttl <= 1) {
      return [drop(ctx, pdu, 'ttl-expired', `ttl ${ttl} reached zero in transit`, port), icmpError(pdu, ICMP_TIME_EXCEEDED, ICMP_TTL_EXCEEDED_TRANSIT, port)];
    }
    if (!route || resolved === undefined) {
      return [drop(ctx, pdu, 'no-route', `no route to ${dst}`, port), icmpError(pdu, ICMP_DEST_UNREACHABLE, ICMP_UNREACH_NET, port)];
    }
    const cause = resolved.cause;
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
    // P3 (D12): the outbound list of the egress port, when the hooks exist
    const outList = aclListOn(ctx, egress.iface, 'out');
    if (natHooked(ctx) && natRoles.get(port) === 'inside' && natRoles.get(egress.iface) === 'outside') {
      debug(ctx, CAT_PACKET, `translating ${describe(pdu.layer('ipv4') ?? ip)} on the way out ${egress.iface} (ip nat inside → outside)`, { pdu: pdu.id, inPort: port, iface: egress.iface });
      // §3.0 (a) step 6: NAT translates first, then hands the packet to the outbound list (filterOut)
      const req: Extract<ProcessRequest, { kind: 'nat.outbound' }> = outList === undefined
        ? { kind: 'nat.outbound', pdu, inPort: port, iface: egress.iface, nextHop: egress.nextHop, cause }
        : { kind: 'nat.outbound', pdu, inPort: port, iface: egress.iface, nextHop: egress.nextHop, cause, filterOut: true };
      return [{ type: 'request', to: NAT_PROCESS, req }];
    }
    const sendVia: Action = { type: 'request', to: 'arp', req: { kind: 'arp.sendVia', pdu, nextHop: egress.nextHop, iface: egress.iface, cause } };
    if (outList !== undefined) {
      // §3.0 (a) step 7: the outbound list; a deny's ICMP is sourced from the ingress port (inPort)
      debug(ctx, CAT_PACKET, `filtering ${describe(pdu.layer('ipv4') ?? ip)} on the way out ${egress.iface} (ip access-group ${outList} out)`, { pdu: pdu.id, inPort: port, iface: egress.iface, list: outList });
      return [{ type: 'request', to: ACL_HOOK_PROCESS, req: { kind: 'acl.filter', family: 4, dir: 'out', iface: egress.iface, inPort: port, pdu, onPermit: sendVia } }];
    }
    return [sendVia];
  }

  /**
   * Hand a packet addressed to this device to its upper-layer daemon (protocols/ip-upper.ts); a protocol nobody
   * handles is dropped `unsupported-protocol` and, for a unicast destination received from the wire, answered with
   * ICMP protocol unreachable.
   */
  function deliverLocal(ctx: ProcessCtx, pdu: Pdu, ip: LayerView, port: PortId, fromWire: boolean, prefix: string): Action[] {
    const protocol = Number(ip.fields.protocol);
    const upper = ipv4UpperProcess(ctx.model, protocol);
    // D22: a managed switch's udp/tcp answer nothing until a P3 service line is stored (P2's path, byte for byte)
    const target = upper !== undefined && transportDormant(ctx, upper) ? undefined : upper;
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

  /** The receive path after the inbound list (P3, D12): the NAT inbound hook (D14), else the for-me test. */
  function afterInboundAcl(ctx: ProcessCtx, pdu: Pdu, ip: LayerView, port: PortId): Action[] {
    if (natHooked(ctx) && natRoles.get(port) === 'outside') {
      // D14: an outside port hands the packet to nat BEFORE the for-me test; it comes back as ipv4.resume
      debug(ctx, CAT_PACKET, `translating ${describe(ip)} from ${port} before the local test (ip nat outside)`, { pdu: pdu.id, port });
      return [{ type: 'request', to: NAT_PROCESS, req: { kind: 'nat.inbound', pdu, inPort: port } }];
    }
    return receiveLocalOrForward(ctx, pdu, ip, port);
  }

  /** The for-me test and what follows it (the receive path after any NAT inbound translation). */
  function receiveLocalOrForward(ctx: ProcessCtx, pdu: Pdu, ip: LayerView, port: PortId): Action[] {
    const dst = String(ip.fields.dst);
    if (ctx.isLocalDestination(dst, port) || isLocalVirtual(ctx, dst) || isJoinedGroup(dst, port)) {
      return deliverLocal(ctx, pdu, ip, port, true, 'deliver ');
    }
    if (!ctx.model.ipForwarding) {
      return [drop(ctx, pdu, 'not-for-me', `${dst} is not a local address and this device does not forward`, port)];
    }
    if (ipRoutingSwitchedOff(ctx)) return [drop(ctx, pdu, 'no-route', IP_ROUTING_OFF_DETAIL, port)];
    return forward(ctx, pdu, ip, port);
  }

  /** `ipv4.send` with a forced egress interface (§4.2): no LPM. */
  function sendOut(ctx: ProcessCtx, pdu: Pdu, ip: LayerView, iface: PortId, reqNextHop: Ipv4Address | undefined, reqCause: string | undefined): Action[] {
    const src = String(ip.fields.src);
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
      } else if (isIpv4Multicast(dst)) {
        // P3 (D7): a group on the given interface is never routed; arp frames it to 01:00:5e + the low 23 bits
        nextHop = dst;
        via = 'multicast group';
      } else if (l3 !== undefined && (inSubnet(dst, l3.address, l3.prefixLen) || (l3.prefixLen < 31 && dst === broadcastOf(l3.address, l3.prefixLen)))) {
        nextHop = dst;
        via = 'connected';
      } else {
        for (const c of ctx.lpm(dst).candidates) {
          const e = resolveEgress(ctx, c, src, dst).egress;
          if (e !== undefined && e.iface === iface && e.nextHop !== dst) {
            nextHop = e.nextHop;
            via = routeCause(c, ctx);
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
    const src = String(ip.fields.src);
    const dst = String(ip.fields.dst);
    const own = ctx.ownAddress(dst);
    if (own !== undefined && portUp(ctx, own)) return deliverLocal(ctx, pdu, ip, own, false, 'send ');
    if (req.iface !== undefined) return sendOut(ctx, pdu, ip, req.iface, req.nextHop, req.cause);
    if (src === '0.0.0.0') return [drop(ctx, pdu, 'no-l3-address', 'source 0.0.0.0 needs an egress interface')];
    if (isIpv4Broadcast(dst)) return [drop(ctx, pdu, 'no-route', 'limited broadcast needs an egress interface')];
    const route = ctx.lpm(dst).winner;
    if (!route) return [drop(ctx, pdu, 'no-route', `no route to ${dst}`)];
    const resolved = resolveEgress(ctx, route, src, dst);
    const cause = req.cause ?? resolved.cause;
    let egress = resolved.egress;
    if (req.nextHop !== undefined) {
      const iface = ctx.connectedPortFor(req.nextHop) ?? egress?.iface;
      egress = iface === undefined ? undefined : { nextHop: req.nextHop, iface };
    }
    if (!egress) return [drop(ctx, pdu, 'no-route', `next hop ${req.nextHop ?? route.nextHop ?? dst} of ${resolved.cause} is not on a connected network`)];
    sent++;
    debug(ctx, CAT_PACKET, `send ${describe(ip)} via ${egress.iface} next hop ${egress.nextHop} (${resolved.cause})`, {
      pdu: pdu.id,
      route: route.key,
      nextHop: egress.nextHop,
      iface: egress.iface,
    });
    return [{ type: 'request', to: 'arp', req: { kind: 'arp.sendVia', pdu, nextHop: egress.nextHop, iface: egress.iface, cause } }];
  }

  /** `onConfig` of the P1/P2 lines (the P3 transport and watch steps wrap it). */
  function configDelta(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
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
    if (ifacePort !== undefined && line[1] === 'nat') {
      const port = findPort(ctx, ifacePort) ?? ifacePort;
      setNatRole(ctx, port, line[2], delta.op === 'set');
      return [];
    }
    if (delta.context.length === 0 && line[1] === 'route') {
      if (delta.op === 'set') {
        if (line.length >= 5) addStatic(ctx, line.slice(2));
      } else {
        unsetStaticLine(ctx, line);
      }
      return [];
    }
    if (delta.context.length === 0 && line[1] === 'routing' && line.length === 2) {
      debug(ctx, CAT_ROUTING, `IP routing ${forwarding ? 'on' : 'off'}${!ctx.model.ipForwarding ? ' (this device does not forward)' : ''}`, { forwarding });
    }
    return [];
  }

  /** `onRequest` without the watch step. */
  function request(ctx: ProcessCtx, req: ProcessRequest): Action[] {
    switch (req.kind) {
      case 'ipv4.send':
        return send(ctx, req);
      case 'ipv4.route':
        return routeRequest(ctx, req);
      case 'ipv4.lease':
        return req.op === 'bind' ? bindLease(ctx, req) : unbindLease(ctx, req);
      case 'ipv4.resume': {
        const ip = req.pdu.layer('ipv4');
        if (!ip) return [drop(ctx, req.pdu, 'other', 'ipv4.resume without an IPv4 header', req.inPort)];
        if (req.after === 'acl-in') {
          // P3 (D12): the packet passed the inbound list; it continues at the NAT inbound hook, never filtered again
          debug(ctx, CAT_PACKET, `resume ${describe(ip)} on ${req.inPort} after the inbound access list`, { pdu: req.pdu.id, port: req.inPort });
          return afterInboundAcl(ctx, req.pdu, ip, req.inPort);
        }
        debug(ctx, CAT_PACKET, `resume ${describe(ip)} on ${req.inPort} after translation`, { pdu: req.pdu.id, port: req.inPort });
        return receiveLocalOrForward(ctx, req.pdu, ip, req.inPort);
      }
      case 'ipv4.virtual':
        return virtualRequest(ctx, req);
      case 'ipv4.group':
        return groupRequest(ctx, req);
      // ── P3 (D8) ──
      case 'ipv4.routes':
        return routesRequest(ctx, req);
      case 'ipv4.ribWatch':
        return ribWatchRequest(ctx, req);
      // ── P3 [S13] R17/R27 ──
      case TRANSPORT_HOLD_REQUEST:
        return transportHold(req);
      default:
        return [];
    }
  }

  // ── the process ───────────────────────────────────────────────────────────

  return {
    name: NAME,
    handles: IPV4_HANDLES,

    init(ctx: ProcessCtx): Action[] {
      syncForwarding(ctx);
      syncTransport(ctx);
      syncAccessGroups(ctx);
      return withWatches(ctx, syncFromConfig(ctx));
    },

    onPdu(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
      syncForwarding(ctx);
      const ip = pdu.layer('ipv4');
      if (!ip) return [drop(ctx, pdu, 'other', 'no IPv4 header', port)];
      if (ip.fields.checksumValid === false) {
        return [drop(ctx, pdu, 'bad-checksum', ip.error ?? 'IPv4 header checksum mismatch', port)];
      }
      debug(ctx, CAT_PACKET, `rx ${describe(ip)} on ${port}`, { pdu: pdu.id, port });
      const inList = aclListOn(ctx, port, 'in');
      if (inList !== undefined) {
        // P3 (D12, §3.0 (a) step 2): the inbound list runs BEFORE NAT inbound and the for-me test; acl answers with
        // the resume (after 'acl-in') or a drop
        debug(ctx, CAT_PACKET, `filtering ${describe(ip)} on ${port} (ip access-group ${inList} in)`, { pdu: pdu.id, port, list: inList });
        const onPermit: Action = { type: 'request', to: NAME, req: { kind: 'ipv4.resume', pdu, inPort: port, after: 'acl-in' } };
        return [{ type: 'request', to: ACL_HOOK_PROCESS, req: { kind: 'acl.filter', family: 4, dir: 'in', iface: port, pdu, onPermit } }];
      }
      return afterInboundAcl(ctx, pdu, ip, port);
    },

    onTimer(): Action[] {
      return [];
    },

    onConfig(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
      syncForwarding(ctx);
      syncTransport(ctx);
      if (isAccessGroupDelta(delta)) syncAccessGroups(ctx);
      return withWatches(ctx, configDelta(ctx, delta));
    },

    onLinkChange(ctx: ProcessCtx, port: PortId, up: boolean): Action[] {
      const actions = reconcile(ctx, port, up);
      if (!up) withdrawPathsVia(ctx, port);
      return withWatches(ctx, actions);
    },

    onRequest(ctx: ProcessCtx, req: ProcessRequest): Action[] {
      syncForwarding(ctx);
      const actions = request(ctx, req);
      // only these requests change the RIB (a packet send, resume, virtual address or group never does)
      return req.kind === 'ipv4.route' || req.kind === 'ipv4.lease' || req.kind === 'ipv4.routes' ? withWatches(ctx, actions) : actions;
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
      if (natRoles.size > 0) {
        const nat: Record<string, string> = {};
        for (const [port, side] of natRoles) nat[port] = side;
        state.nat = nat;
      }
      if (virtuals.size > 0) {
        const virtual: Record<string, unknown[]> = {};
        for (const [port, list] of virtuals) virtual[port] = list.map((v) => ({ ...v }));
        state.virtual = virtual;
      }
      if (groups.size > 0) {
        const joined: Record<string, unknown[]> = {};
        for (const [port, list] of groups) joined[port] = list.map((g) => ({ ...g }));
        state.groups = joined;
      }
      return { process: NAME, state };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}

/** @since P2 The MAC to answer for a virtual address of `port` (D15), or undefined when `port` has none for `address`. */
export function virtualMacFor(view: { l3: { virtual4?: readonly VirtualIpv4[] } } | undefined, address: Ipv4Address): MacAddress | undefined {
  for (const v of view?.l3.virtual4 ?? []) if (v.address === address) return v.mac;
  return undefined;
}
