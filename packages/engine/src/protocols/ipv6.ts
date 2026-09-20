/**
 * protocols/ipv6.ts — the IPv6 daemon (ARCHITECTURE-P1 §4.2, §4.6, §4.8; RFC 8200 forwarding, RFC 4291 addressing,
 * RFC 4862 SLAAC/DAD, RFC 5952 text).
 *
 * Responsibilities
 *  • Interface addressing, derived from the running config every time an `ipv6 …` line changes (idempotent
 *    re-derivation, so boot replay, headless configure and `no` forms all converge on the same state):
 *      `ipv6 enable`                        → IPv6 on the port with only the automatic link-local address;
 *      `ipv6 address X/len`                 → manual address (a link-local X replaces the automatic one);
 *      `ipv6 address P/64 eui-64`           → P + modified EUI-64 of the port MAC (origin 'eui64');
 *      `ipv6 address X link-local`          → manual link-local address;
 *      `ipv6 address autoconfig`            → SLAAC from Router Advertisement prefixes (origin 'slaac').
 *    Every port with any of these lines gets the automatic link-local fe80::/64 + EUI-64 unless a manual one is
 *    configured. Addresses act only on ports whose effective role holds L3 addresses (`ROLE_TRAITS[role].l3`).
 *    New addresses start `tentative`; while the port is oper-up each one runs Duplicate Address Detection through
 *    `nd.dad` (ports without link framing, e.g. loopbacks, skip DAD). `ipv6.dadResult` makes it `preferred` (or
 *    `duplicate`, logged at severity 4; a duplicate link-local stops IPv6 on the port, RFC 4862 §5.4.5).
 *    `setPortL3` carries the ordered address list (link-local first, then configuration then learning order),
 *    `ipv6Enabled` and `groups6` (ff02::1, ff02::2 on routing devices, the solicited-node group of every
 *    non-duplicate address — tentative ones included so DAD probes from other nodes are heard).
 *  • rib6 (through a RIB arbiter, lowest AD installed per key): C (prefix of every preferred or deprecated
 *    non-link-local address, AD 0), L (/128 of each, AD 0), S (`ipv6 route P/len NH | IF [NH]`, AD 1) and ND
 *    (the default router learned from an RA on a non-forwarding device, `::/0` AD 2 via the router link-local,
 *    expiring with the router lifetime). C/L/ND routes of a port are withdrawn with reason 'link-down' when it goes
 *    down; addresses return to `tentative` and run DAD again when it comes back (RFC 4862 §5.4).
 *  • SLAAC (`ipv6.raLearned` from nd, RFC 4862 §5.5.3): a /64 prefix on a port with `autoconfig` creates
 *    `eui64Address(prefix, 64, mac)` with lifetimes; the two-hour rule protects the valid lifetime of an existing
 *    address; `preferredUntil` → `deprecated`, `validUntil` → removed. Lifetimes (and the ND default route) are
 *    served by the maintenance timer `life:<iface>` (periodic flag, D10: runToIdle does not wait for it).
 *  • Receive (Ethernet type 0x86dd on L3 roles, HDLC protocol 0x86dd on serial WAN ports, or `deliver`): packets
 *    for this device go through the upper-layer table of §4.2 — next header 58 with type 133–137 → nd, other
 *    ICMPv6 → icmpv6, 6/17 → tcp/udp when the model runs them, 59 → consumed, anything else → drop
 *    `unsupported-protocol` + `icmp6.error(4, 1, pointer)`. Hop-by-hop and destination options are skipped; a
 *    routing header of type 0 (or of an unknown type with segments left) → param problem code 0 pointing at the
 *    routing type; fragments → drop 'ipv6 reassembly not supported in P1'.
 *  • Forwarding (only with `model.ipForwarding` AND `ipv6 unicast-routing`): multicast and link-local
 *    destinations are never forwarded; a link-local source leaving its link → unreachable code 2 (beyond scope);
 *    hop limit ≤ 1 → drop `ttl-expired` + time exceeded; no route → drop `no-route` + unreachable code 0; larger than
 *    the egress MTU → packet too big (routers never fragment); otherwise `mutate('ipv6.hopLimit', h − 1,
 *    'TtlDecrement', <route line>)` and `nd.sendVia`.
 *  • `ipv6.send` (locally originated packets, `ipv6.src` already set): own unicast destination → local delivery;
 *    link-local and multicast destinations need `iface`; `iface` forces egress and skips the RIB unless the
 *    destination is off-link; otherwise the rib6 route decides. No hop-limit decrement.
 *
 * Timer keys: `life:<iface>` (periodic; SLAAC and ND-default lifetimes).
 * Debug categories: 'ipv6 packet' (rx / deliver / forward / send / drop), 'ipv6 routing' (routes, addresses, DAD).
 *
 * stateSnapshot():
 *   { process: 'ipv6', state: { forwarding, interfaces: [{ port, enabled, autoconfig, linkLocalDuplicate,
 *     addresses: [{ address, prefixLen, origin, state }], defaultRouters: [router] }], staticRoutes, forwarded,
 *     delivered, sent, dropped } }
 */
import type { Ipv6Address } from '../contracts/addr.js';
import { IPV6_ALL_NODES, IPV6_ALL_ROUTERS } from '../contracts/addr.js';
import { L3_ROLES, ROLE_TRAITS, KIND_ENCAP, defaultRoleFor, ipDefaultsFor } from '../contracts/catalog.js';
import type { PortEncap, PortRole } from '../contracts/catalog.js';
import type { ConfigDelta, ConfigNode } from '../contracts/config.js';
import type { PortId, ProcessName } from '../contracts/ids.js';
import type { DropReason } from '../contracts/link.js';
import {
  ETHERTYPE_IPV6,
  HDLC_PROTO_IPV6,
  ICMPV6_DEST_UNREACHABLE,
  ICMPV6_PACKET_TOO_BIG,
  ICMPV6_PARAM_PROBLEM,
  ICMPV6_TIME_EXCEEDED,
  ICMPV6_UNREACH_NO_ROUTE,
  IPPROTO_NONE,
  IPPROTO_TCP,
  IPPROTO_UDP,
  type LayerView,
  type Pdu,
} from '../contracts/pdu.js';
import type { Ipv6PortAddress, PortView } from '../contracts/port.js';
import type { Action, DebugEvent, DemuxSelector, Process, ProcessCtx, ProcessRequest, StateView } from '../contracts/process.js';
import type { Rng } from '../contracts/rng.js';
import { AD_CONNECTED, AD_ND, AD_STATIC, route6Key, type Lpm6Result, type Route6Row, type Table } from '../contracts/tables.js';
import { SEC, type SimTime } from '../contracts/time.js';
import {
  eui64Address,
  ipv6NetworkOf,
  ipv6Scope,
  linkLocalFromMac,
  normalizeIpv6,
  parseIpv6,
  solicitedNodeMulticast,
} from '../core/addr6.js';
import { createRibArbiter, type RibArbiter, type RibRemoveReason } from '../core/rib-arbiter.js';

/** Process name, as registered in the protocol registry. */
const NAME = 'ipv6';
/** Debug categories emitted by this daemon. */
const CAT_PACKET = 'ipv6 packet';
const CAT_ROUTING = 'ipv6 routing';
/** Number of DebugEvents retained by `debugEvents()`. */
const DEBUG_RING = 256;
/** Timer key prefix of the per-port lifetime timer. */
const TIMER_LIFE_PREFIX = 'life:';
/** Log facility of IPv6 address events. */
export const IPV6_LOG_FACILITY = 'IPV6';
/** RFC 4862 §5.5.3 (e): the two-hour floor that protects the valid lifetime of an autoconfigured address. */
export const SLAAC_TWO_HOURS_NS: SimTime = 7200 * SEC;
/** A lifetime of all ones means "infinity" (RFC 4861 §4.6.2). */
const INFINITE_LIFETIME_S = 0xffffffff;
/** Upper-layer protocol numbers that go to a transport daemon when the model runs it. */
const TRANSPORT_PROCESSES: Readonly<Record<number, ProcessName>> = Object.freeze({ [IPPROTO_TCP]: 'tcp', [IPPROTO_UDP]: 'udp' });
/** Pointer of the Next Header field inside the fixed IPv6 header (RFC 8200 §3). */
const FIXED_NEXT_HEADER_POINTER = 6;
/** Offset of the routing type inside a routing header. */
const ROUTING_TYPE_OFFSET = 2;

/** Wire selectors: Ethernet type 0x86dd on every L3 role, HDLC protocol 0x86dd on serial WAN ports (§3.9). */
export const IPV6_HANDLES: readonly DemuxSelector[] = Object.freeze([
  Object.freeze({ layer: 'ethernet', ethertype: ETHERTYPE_IPV6, roles: L3_ROLES }),
  Object.freeze({ layer: 'hdlc', ethertype: HDLC_PROTO_IPV6, roles: Object.freeze(['wan'] as PortRole[]) }),
]) as readonly DemuxSelector[];

// ── shared helpers (also used by nd and icmpv6) ─────────────────────────────

/** The P1 IPv6 members of a `ProcessCtx`, all present. */
export interface Ipv6CtxHelpers {
  lpm6(dst: Ipv6Address): Lpm6Result;
  ownAddress6(ip: Ipv6Address): PortId | undefined;
  isLocalDestination6(ip: Ipv6Address, inPort?: PortId): boolean;
  connectedPortFor6(ip: Ipv6Address, hint?: PortId): PortId | undefined;
  sourceFor6(dst: Ipv6Address, iface?: PortId): { address: Ipv6Address; iface: PortId } | undefined;
}

/**
 * The IPv6 helpers of `ctx` (device/process-ctx.ts always provides them). A ctx without them cannot run the IPv6
 * daemons, so this throws a descriptive error instead of misrouting silently.
 */
export function ipv6Helpers(ctx: ProcessCtx): Ipv6CtxHelpers {
  const { lpm6, ownAddress6, isLocalDestination6, connectedPortFor6, sourceFor6 } = ctx;
  if (lpm6 === undefined || ownAddress6 === undefined || isLocalDestination6 === undefined || connectedPortFor6 === undefined || sourceFor6 === undefined) {
    throw new Error(`the process context of ${ctx.deviceId} lacks the IPv6 helpers (lpm6, ownAddress6, isLocalDestination6, connectedPortFor6, sourceFor6)`);
  }
  return {
    lpm6: (dst) => lpm6.call(ctx, dst),
    ownAddress6: (ip) => ownAddress6.call(ctx, ip),
    isLocalDestination6: (ip, inPort) => isLocalDestination6.call(ctx, ip, inPort),
    connectedPortFor6: (ip, hint) => connectedPortFor6.call(ctx, ip, hint),
    sourceFor6: (dst, iface) => sourceFor6.call(ctx, dst, iface),
  };
}

/**
 * Cached per-concern rng streams for one process instance: `ctx.stream(label)` when the ctx provides it, otherwise
 * `ctx.rng.split(label)` created ONCE and cached here (the same semantics: one ctx per process instance). Never
 * re-split per use (§5.1).
 */
export function createStreamCache(): (ctx: ProcessCtx, label: string) => Rng {
  const cache = new Map<string, Rng>();
  return (ctx, label) => {
    if (ctx.stream !== undefined) return ctx.stream(label);
    let s = cache.get(label);
    if (s === undefined) {
      s = ctx.rng.split(label);
      cache.set(label, s);
    }
    return s;
  };
}

/** True for ff00::/8. Invalid text is not multicast. */
export function isMulticast6(a: string): boolean {
  const b = parseIpv6(a);
  return b !== null && b[0] === 0xff;
}

/** True for fe80::/10. Invalid text is not link-local. */
export function isLinkLocal6(a: string): boolean {
  const b = parseIpv6(a);
  return b !== null && b[0] === 0xfe && ((b[1] as number) & 0xc0) === 0x80;
}

/** Link-scoped destination: fe80::/10, or multicast whose scope nibble is interface- or link-local (≤ 2). */
export function isLinkScoped6(a: string): boolean {
  const b = parseIpv6(a);
  if (b === null) return false;
  if (b[0] === 0xfe && ((b[1] as number) & 0xc0) === 0x80) return true;
  return b[0] === 0xff && ((b[1] as number) & 0x0f) <= 2;
}

/** True for `::`. */
export function isUnspecified6(a: string): boolean {
  const b = parseIpv6(a);
  return b !== null && b.every((x) => x === 0);
}

/** `Ipv6PortAddress.scope` of a unicast address: link-local, unique-local, or global (documentation counts as global). */
export function portScope6(a: Ipv6Address): Ipv6PortAddress['scope'] {
  const s = ipv6Scope(a);
  if (s === 'link-local') return 'link-local';
  if (s === 'unique-local') return 'unique-local';
  return 'global';
}

/** Hop limit of packets this device originates: `model.ipDefaults.hopLimit` (routers 255, hosts 64). */
export function originatedHopLimit(ctx: Pick<ProcessCtx, 'model'>): number {
  return ctx.model.ipDefaults?.hopLimit ?? ipDefaultsFor(ctx.model.capabilities ?? []).hopLimit;
}

/** Does the model run daemon `name`? */
export function hasProcess(ctx: Pick<ProcessCtx, 'model'>, name: ProcessName): boolean {
  return ctx.model.processes.includes(name);
}

/** Effective role of a port (live role, else spec default for the model capabilities). */
export function roleOf6(ctx: Pick<ProcessCtx, 'model'>, view: PortView): PortRole {
  return view.role ?? view.spec.role ?? defaultRoleFor(view.spec.kind, ctx.model.capabilities ?? []);
}

/** Effective encapsulation of a port view. */
export function encapOf6(view: PortView): PortEncap {
  return view.encap ?? view.spec.encap ?? KIND_ENCAP[view.spec.kind];
}

/** The first preferred link-local address of a port, if any. */
export function preferredLinkLocal(view: PortView | undefined): Ipv6Address | undefined {
  for (const a of view?.l3.ipv6 ?? []) if (a.state === 'preferred' && a.scope === 'link-local') return a.address;
  return undefined;
}

/** Token lines of the `ipv6 …` children of a config node (group form `ipv6 → leaf` or flat form). */
function ipv6LinesOf(node: ConfigNode): string[][] {
  const out: string[][] = [];
  for (const c of node.children) {
    if (c.key !== 'ipv6') continue;
    if (c.args.length === 0) {
      for (const leaf of c.children) out.push(['ipv6', leaf.key, ...leaf.args]);
    } else {
      out.push(['ipv6', ...c.args]);
    }
  }
  return out;
}

/** Case-insensitive lookup of a port name among the device's ports (exact canonical id first). */
export function findPort6(ctx: Pick<ProcessCtx, 'ports'>, name: string): PortId | undefined {
  if (ctx.ports.has(name)) return name;
  const lower = name.toLowerCase();
  for (const id of ctx.ports.keys()) if (id.toLowerCase() === lower) return id;
  return undefined;
}

/** The `interface <port>` section of the running config (exact id first, then case-insensitive). */
function interfaceSection(ctx: ProcessCtx, port: PortId): ConfigNode | undefined {
  const lower = port.toLowerCase();
  let loose: ConfigNode | undefined;
  for (const c of ctx.config.root.children) {
    if (c.key !== 'interface') continue;
    const name = c.args[0];
    if (name === port) return c;
    if (loose === undefined && name !== undefined && name.toLowerCase() === lower) loose = c;
  }
  return loose;
}

/** `ipv6 …` lines configured under `interface <port>` (token arrays starting with 'ipv6'). */
export function interfaceIpv6Lines(ctx: ProcessCtx, port: PortId): string[][] {
  const section = interfaceSection(ctx, port);
  return section === undefined ? [] : ipv6LinesOf(section);
}

/** Global `ipv6 …` lines of the running config. */
export function globalIpv6Lines(ctx: ProcessCtx): string[][] {
  return ipv6LinesOf(ctx.config.root);
}

/** `ipv6 unicast-routing` is configured AND the model forwards IP: this device acts as an IPv6 router. */
export function ipv6RoutingEnabled(ctx: ProcessCtx): boolean {
  if (!ctx.model.ipForwarding) return false;
  return globalIpv6Lines(ctx).some((l) => l[1] === 'unicast-routing');
}

/** One configured (not learned) interface address. */
export interface ConfiguredAddress6 {
  address: Ipv6Address;
  prefixLen: number;
  origin: 'manual' | 'eui64';
}

/** The IPv6 configuration of one interface, read from the running config. */
export interface Iface6Config {
  /** Any interface ipv6 line is present. */
  enabled: boolean;
  /** `ipv6 address autoconfig`. */
  autoconfig: boolean;
  /** `ipv6 nd suppress-ra`. */
  suppressRa: boolean;
  /** Manual link-local address (replaces the automatic one). */
  linkLocal?: Ipv6Address;
  /** Configured global / unique-local addresses in configuration order. */
  addresses: ConfiguredAddress6[];
  /** Lines that could not be used (for debug). */
  rejected: string[];
}

/** Parse `X/len` into a canonical address and a length, or null. */
function parseAddressWithLength(text: string): { address: Ipv6Address; prefixLen: number } | null {
  const m = /^(.+)\/(\d{1,3})$/.exec(text.trim());
  if (m === null) return null;
  const len = Number(m[2]);
  if (!Number.isInteger(len) || len < 0 || len > 128) return null;
  const address = normalizeIpv6(m[1] as string);
  return address === null ? null : { address, prefixLen: len };
}

/** Read the IPv6 configuration of `port` (see `Iface6Config`). The port MAC feeds `eui-64` addresses. */
export function readIface6Config(ctx: ProcessCtx, port: PortId, mac: string): Iface6Config {
  const cfg: Iface6Config = { enabled: false, autoconfig: false, suppressRa: false, addresses: [], rejected: [] };
  for (const line of interfaceIpv6Lines(ctx, port)) {
    const what = line[1];
    if (what === 'enable') {
      cfg.enabled = true;
      continue;
    }
    if (what === 'nd') {
      if (line[2] === 'suppress-ra') cfg.suppressRa = true;
      continue;
    }
    if (what !== 'address') continue;
    cfg.enabled = true;
    const arg = line[2];
    const kind = line[3];
    if (arg === 'autoconfig') {
      cfg.autoconfig = true;
      continue;
    }
    if (arg === undefined) continue;
    if (kind === 'link-local') {
      const address = normalizeIpv6(arg.includes('/') ? arg.slice(0, arg.indexOf('/')) : arg);
      if (address === null || !isLinkLocal6(address)) {
        cfg.rejected.push(line.join(' '));
        continue;
      }
      cfg.linkLocal = address;
      continue;
    }
    const parsed = parseAddressWithLength(arg);
    if (parsed === null) {
      cfg.rejected.push(line.join(' '));
      continue;
    }
    if (kind === 'eui-64') {
      const address = eui64Address(parsed.address, parsed.prefixLen, mac);
      if (address === null || isLinkLocal6(address) || isMulticast6(address)) {
        cfg.rejected.push(line.join(' '));
        continue;
      }
      cfg.addresses.push({ address, prefixLen: 64, origin: 'eui64' });
      continue;
    }
    const scope = ipv6Scope(parsed.address);
    if (scope === 'multicast' || scope === 'unspecified' || scope === 'loopback') {
      cfg.rejected.push(line.join(' '));
      continue;
    }
    if (scope === 'link-local') {
      cfg.linkLocal = parsed.address;
      continue;
    }
    if (!cfg.addresses.some((a) => a.address === parsed.address)) cfg.addresses.push({ ...parsed, origin: 'manual' });
  }
  return cfg;
}

/**
 * Render a rib6 row as the configuration or event responsible for it — the `cause` of the hop-limit decrement and
 * of the neighbour send. Static: `ipv6 route P/len [IF] [NH]`; ND: `router advertisement from R on IF`; connected /
 * local: `connected via IF`.
 */
export function route6Cause(route: Route6Row): string {
  if (route.source === 'S') {
    const via = [route.iface, route.nextHop].filter((x): x is string => x !== undefined).join(' ');
    return `ipv6 route ${route.network}/${route.prefixLen} ${via === '' ? '?' : via}`;
  }
  if (route.source === 'ND') return `router advertisement from ${route.nextHop ?? '?'} on ${route.iface ?? '?'}`;
  return `connected via ${route.iface ?? '?'}`;
}

/** `"2001:db8::1 > 2001:db8::2 hlim 64 nh 58"` — the packet half of every 'ipv6 packet' line. */
function describe(ip: LayerView): string {
  return `${String(ip.fields.src)} > ${String(ip.fields.dst)} hlim ${String(ip.fields.hopLimit)} nh ${String(ip.fields.nextHeader)}`;
}

// ── daemon state ─────────────────────────────────────────────────────────────

/** Per-port IPv6 state. */
interface Port6 {
  port: PortId;
  autoconfig: boolean;
  /** Live address list, as last written with setPortL3. */
  addrs: Ipv6PortAddress[];
  /** DAD requests outstanding (addresses). */
  dadPending: Set<Ipv6Address>;
  /** The link-local address failed DAD: IPv6 is stopped on the port. */
  llDuplicate: boolean;
  /** Installed C/L candidates: `${owner}@${key}` → row. */
  routes: Map<string, { owner: ProcessName; row: Route6Row }>;
  /** Default routers learned from RAs (non-forwarding devices): router → expiry (undefined = infinite). */
  routers: Map<Ipv6Address, SimTime | undefined>;
  /** Earliest scheduled lifetime event, if armed. */
  lifeAt?: SimTime;
  /** What the last setPortL3 carried (to skip redundant writes). */
  writtenKey: string;
}

/** A static route as configured. */
interface Static6 {
  row: Route6Row;
  line: string;
}

/** Egress of a routed packet. */
interface Egress6 {
  nextHop: Ipv6Address;
  iface: PortId;
}

/**
 * Create the IPv6 daemon. Handles IPv6 from the wire (Ethernet on L3 roles, HDLC on WAN serial ports) and packets
 * delivered by other daemons; answers `ipv6.send`, `ipv6.dadResult` and `ipv6.raLearned`.
 */
export function createIpv6(): Process {
  const ports = new Map<PortId, Port6>();
  const statics = new Map<string, Static6>();
  const ring: DebugEvent[] = [];
  let arbiter: RibArbiter<Route6Row> | undefined;
  let routing = false;
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
    const ip = pdu.layer('ipv6');
    debug(ctx, CAT_PACKET, `drop ${ip ? describe(ip) : `pdu ${pdu.id}`}: ${reason} (${detail})`, { reason, detail, pdu: pdu.id });
    return port === undefined ? { type: 'drop', pdu, reason, detail } : { type: 'drop', pdu, reason, detail, port };
  }

  function icmpError(original: Pdu, type: number, code: number, inPort: PortId | undefined, param?: number): Action {
    const req: ProcessRequest = { kind: 'icmp6.error', original, type, code };
    if (param !== undefined) req.param = param;
    if (inPort !== undefined) req.inPort = inPort;
    return { type: 'request', to: 'icmpv6', req };
  }

  function rib(ctx: ProcessCtx): RibArbiter<Route6Row> {
    if (arbiter === undefined) {
      const table = ctx.tables.get<Route6Row>('rib6') as Table<Route6Row> | undefined;
      arbiter = createRibArbiter<Route6Row>(table === undefined ? { stampOwner: false } : { table, stampOwner: false });
    }
    return arbiter;
  }

  function isForwarding(ctx: ProcessCtx): boolean {
    return ctx.model.ipForwarding && routing;
  }

  function portUp(ctx: ProcessCtx, port: PortId): boolean {
    return ctx.ports.get(port)?.operUp === true;
  }

  function isL3(ctx: ProcessCtx, port: PortId): boolean {
    const view = ctx.ports.get(port);
    return view !== undefined && ROLE_TRAITS[roleOf6(ctx, view)].l3;
  }

  /** Ports without link framing (loopbacks) need no DAD: nothing else can share the link. */
  function needsDad(ctx: ProcessCtx, port: PortId): boolean {
    const view = ctx.ports.get(port);
    return view !== undefined && encapOf6(view) !== 'none';
  }

  // ── routes ──────────────────────────────────────────────────────────────

  /** Bring the C/L candidates of `p` in line with its preferred/deprecated addresses and the port state. */
  function syncPortRoutes(ctx: ProcessCtx, p: Port6, up: boolean, reason: RibRemoveReason): void {
    const desired = new Map<string, { owner: ProcessName; row: Route6Row }>();
    if (up && !p.llDuplicate) {
      for (const a of p.addrs) {
        if (a.scope === 'link-local' || (a.state !== 'preferred' && a.state !== 'deprecated')) continue;
        if (a.prefixLen < 128) {
          const network = ipv6NetworkOf(a.address, a.prefixLen);
          const key = route6Key(network, a.prefixLen);
          const owner = `connected:${p.port}`;
          if (!desired.has(`${owner}@${key}`)) {
            desired.set(`${owner}@${key}`, {
              owner,
              row: { key, network, prefixLen: a.prefixLen, source: 'C', iface: p.port, ad: AD_CONNECTED, metric: 0, updatedAt: ctx.now },
            });
          }
        }
        const lkey = route6Key(a.address, 128);
        const lowner = `local:${p.port}`;
        desired.set(`${lowner}@${lkey}`, {
          owner: lowner,
          row: { key: lkey, network: a.address, prefixLen: 128, source: 'L', iface: p.port, ad: AD_CONNECTED, metric: 0, updatedAt: ctx.now },
        });
      }
    }
    const r = rib(ctx);
    for (const [id, cur] of Array.from(p.routes)) {
      if (desired.has(id)) continue;
      p.routes.delete(id);
      r.withdraw(cur.row.key, cur.owner, ctx.now, reason);
      debug(ctx, CAT_ROUTING, `remove ${cur.row.source} ${cur.row.key} via ${p.port} (${reason})`, { key: cur.row.key, source: cur.row.source, iface: p.port, reason });
    }
    for (const [id, want] of desired) {
      if (p.routes.has(id)) continue;
      p.routes.set(id, want);
      r.offer(want.row, want.owner);
      debug(ctx, CAT_ROUTING, `add ${want.row.source} ${want.row.key} via ${p.port}`, { key: want.row.key, source: want.row.source, iface: p.port });
    }
  }

  /** Withdraw every ND default route learned on `p`. */
  function dropRouters(ctx: ProcessCtx, p: Port6, reason: RibRemoveReason): void {
    for (const router of Array.from(p.routers.keys())) {
      p.routers.delete(router);
      rib(ctx).withdraw(route6Key('::', 0), `nd:${p.port}|${router}`, ctx.now, reason);
      debug(ctx, CAT_ROUTING, `remove ND ::/0 via ${router} on ${p.port} (${reason})`, { router, iface: p.port, reason });
    }
  }

  /** Re-derive the static routes from the global config: offer new or changed ones, withdraw removed ones. */
  function syncStatics(ctx: ProcessCtx): void {
    const desired = new Map<string, Static6>();
    for (const line of globalIpv6Lines(ctx)) {
      if (line[1] !== 'route') continue;
      const text = line.join(' ');
      const prefix = line[2] === undefined ? null : parseAddressWithLength(line[2]);
      if (prefix === null) {
        debug(ctx, CAT_ROUTING, `ignored ${text}: invalid prefix`, { line: text });
        continue;
      }
      const network = ipv6NetworkOf(prefix.address, prefix.prefixLen);
      let iface: PortId | undefined;
      let nextHop: Ipv6Address | undefined;
      for (const tok of line.slice(3)) {
        const asAddr = normalizeIpv6(tok);
        if (asAddr !== null && nextHop === undefined) nextHop = asAddr;
        else if (iface === undefined) iface = findPort6(ctx, tok);
      }
      if (nextHop === undefined && iface === undefined) {
        debug(ctx, CAT_ROUTING, `ignored ${text}: unknown next hop or interface`, { line: text });
        continue;
      }
      if (nextHop !== undefined && isLinkLocal6(nextHop) && iface === undefined) {
        debug(ctx, CAT_ROUTING, `ignored ${text}: a link-local next hop needs an interface`, { line: text });
        continue;
      }
      const key = route6Key(network, prefix.prefixLen);
      const row: Route6Row = { key, network, prefixLen: prefix.prefixLen, source: 'S', ad: AD_STATIC, metric: 0, updatedAt: ctx.now };
      if (nextHop !== undefined) row.nextHop = nextHop;
      if (iface !== undefined) row.iface = iface;
      if (prefix.prefixLen === 0) row.isDefault = true;
      // one static per prefix (the last line wins, as a later `ipv6 route` for the same prefix replaces it)
      desired.set(key, { row, line: text });
    }
    const r = rib(ctx);
    for (const [key, cur] of Array.from(statics)) {
      const want = desired.get(key);
      if (want !== undefined && want.line === cur.line) continue;
      statics.delete(key);
      r.withdraw(key, 'static', ctx.now, 'cleared');
      debug(ctx, CAT_ROUTING, `remove S ${key} (${cur.line})`, { key, source: 'S' });
    }
    for (const [key, want] of desired) {
      if (statics.has(key)) continue;
      statics.set(key, want);
      r.offer(want.row, 'static');
      debug(ctx, CAT_ROUTING, `add S ${key} via ${[want.row.iface, want.row.nextHop].filter((x) => x !== undefined).join(' ')}`, { key, source: 'S' });
    }
  }

  // ── addresses ───────────────────────────────────────────────────────────

  function groupsOf(ctx: ProcessCtx, p: Port6): Ipv6Address[] {
    const out: Ipv6Address[] = [IPV6_ALL_NODES];
    if (isForwarding(ctx)) out.push(IPV6_ALL_ROUTERS);
    for (const a of p.addrs) {
      if (a.state === 'duplicate') continue;
      const g = solicitedNodeMulticast(a.address);
      if (!out.includes(g)) out.push(g);
    }
    return out;
  }

  /** Write the port's L3 IPv6 state when it changed. */
  function writePort(ctx: ProcessCtx, p: Port6): Action[] {
    const groups6 = groupsOf(ctx, p);
    const ipv6Enabled = !p.llDuplicate;
    const addrs = p.addrs.map((a) => ({ ...a }));
    const key = JSON.stringify([addrs, ipv6Enabled, groups6]);
    if (key === p.writtenKey) return [];
    p.writtenKey = key;
    return [{ type: 'setPortL3', port: p.port, ipv6: addrs, ipv6Enabled, groups6 }];
  }

  /** Earliest lifetime event of `p` (address preferred/valid ends, default-router expiry). */
  function nextLifeEvent(p: Port6): SimTime | undefined {
    let next: SimTime | undefined;
    const consider = (t: SimTime | undefined): void => {
      if (t !== undefined && (next === undefined || t < next)) next = t;
    };
    for (const a of p.addrs) {
      if (a.origin !== 'slaac') continue;
      if (a.state === 'preferred') consider(a.preferredUntil);
      consider(a.validUntil);
    }
    for (const t of p.routers.values()) consider(t);
    return next;
  }

  /** Arm (or cancel) `life:<iface>` for the earliest lifetime event. */
  function armLife(ctx: ProcessCtx, p: Port6): Action[] {
    const next = nextLifeEvent(p);
    const key = `${TIMER_LIFE_PREFIX}${p.port}`;
    if (next === undefined) {
      if (p.lifeAt === undefined) return [];
      delete p.lifeAt;
      return [{ type: 'cancelTimer', key }];
    }
    if (p.lifeAt === next) return [];
    p.lifeAt = next;
    return [{ type: 'timer', key, delay: Math.max(0, next - ctx.now), periodic: true }];
  }

  /** Ask nd to run DAD for every tentative address of an up port that has no request outstanding. */
  function startDad(ctx: ProcessCtx, p: Port6): Action[] {
    const out: Action[] = [];
    if (p.llDuplicate || !portUp(ctx, p.port)) return out;
    const dad = needsDad(ctx, p.port);
    for (const a of p.addrs) {
      if (a.state !== 'tentative' || p.dadPending.has(a.address)) continue;
      if (!dad) {
        a.state = slaacState(ctx, a);
        debug(ctx, CAT_ROUTING, `${a.address} on ${p.port} is ${a.state} (no link framing, no duplicate detection)`, { port: p.port, address: a.address });
        continue;
      }
      p.dadPending.add(a.address);
      debug(ctx, CAT_ROUTING, `duplicate address detection for ${a.address} on ${p.port}`, { port: p.port, address: a.address });
      out.push({ type: 'request', to: 'nd', req: { kind: 'nd.dad', iface: p.port, address: a.address } });
    }
    return out;
  }

  /** State an address takes when DAD succeeds: deprecated when its preferred lifetime already ran out. */
  function slaacState(ctx: ProcessCtx, a: Ipv6PortAddress): Ipv6PortAddress['state'] {
    return a.preferredUntil !== undefined && a.preferredUntil <= ctx.now ? 'deprecated' : 'preferred';
  }

  /**
   * Bring `port` in line with its configuration, its role and `up`. Trusts `up` (during a role-change bounce the
   * port view may lag). Idempotent.
   */
  function reconcile(ctx: ProcessCtx, port: PortId, up: boolean): Action[] {
    const view = ctx.ports.get(port);
    const existing = ports.get(port);
    const cfg = view === undefined ? undefined : readIface6Config(ctx, port, view.mac);
    const active = view !== undefined && cfg !== undefined && cfg.enabled && isL3(ctx, port);
    if (!active || cfg === undefined || view === undefined) {
      if (existing === undefined) return [];
      const out: Action[] = [];
      existing.addrs = [];
      syncPortRoutes(ctx, existing, false, 'cleared');
      dropRouters(ctx, existing, 'cleared');
      ports.delete(port);
      if (existing.lifeAt !== undefined) out.push({ type: 'cancelTimer', key: `${TIMER_LIFE_PREFIX}${port}` });
      debug(ctx, CAT_ROUTING, `IPv6 is off on ${port}`, { port });
      out.push({ type: 'setPortL3', port, ipv6: null, ipv6Enabled: null, groups6: null });
      return out;
    }
    for (const r of cfg.rejected) debug(ctx, CAT_ROUTING, `ignored ${r} on ${port}: not a usable interface address`, { port, line: r });
    const p: Port6 = existing ?? {
      port,
      autoconfig: false,
      addrs: [],
      dadPending: new Set(),
      llDuplicate: false,
      routes: new Map(),
      routers: new Map(),
      writtenKey: '',
    };
    if (existing === undefined) {
      ports.set(port, p);
      debug(ctx, CAT_ROUTING, `IPv6 is on for ${port}`, { port });
    }
    p.autoconfig = cfg.autoconfig;
    const old = p.addrs;
    const find = (address: Ipv6Address): Ipv6PortAddress | undefined => old.find((a) => a.address === address);
    const next: Ipv6PortAddress[] = [];
    const add = (address: Ipv6Address, prefixLen: number, origin: Ipv6PortAddress['origin'], keep?: Ipv6PortAddress): void => {
      if (next.some((a) => a.address === address)) return;
      const prev = keep ?? find(address);
      if (prev !== undefined) {
        // configuration wins over learning: a configured address that SLAAC also produced becomes configured
        const kept: Ipv6PortAddress = { ...prev, prefixLen, origin };
        if (origin !== 'slaac') {
          delete kept.preferredUntil;
          delete kept.validUntil;
        }
        next.push(kept);
        return;
      }
      next.push({ address, prefixLen, scope: portScope6(address), origin, state: 'tentative' });
      debug(ctx, CAT_ROUTING, `address ${address}/${prefixLen} (${origin}) on ${port} is tentative`, { port, address, prefixLen, origin });
    };
    const ll = cfg.linkLocal ?? linkLocalFromMac(view.mac);
    add(ll, 64, cfg.linkLocal !== undefined ? 'manual' : 'auto-link-local');
    for (const a of cfg.addresses) add(a.address, a.prefixLen, a.origin);
    if (cfg.autoconfig) {
      for (const a of old) if (a.origin === 'slaac') add(a.address, a.prefixLen, 'slaac', a);
    }
    for (const a of old) {
      if (next.some((n) => n.address === a.address)) continue;
      p.dadPending.delete(a.address);
      debug(ctx, CAT_ROUTING, `address ${a.address}/${a.prefixLen} removed from ${port}`, { port, address: a.address });
    }
    const oldLl = old[0];
    if (oldLl === undefined || oldLl.address !== ll) p.llDuplicate = false;
    const nextLl = next[0];
    if (nextLl !== undefined && nextLl.state === 'duplicate') p.llDuplicate = true;
    p.addrs = next;
    const out: Action[] = [];
    if (!up) {
      for (const a of p.addrs) if (a.state === 'preferred' || a.state === 'deprecated') a.state = 'tentative';
      p.dadPending.clear();
      syncPortRoutes(ctx, p, false, 'link-down');
      dropRouters(ctx, p, 'link-down');
    } else {
      out.push(...startDad(ctx, p));
      syncPortRoutes(ctx, p, true, 'cleared');
    }
    if (!cfg.autoconfig || isForwarding(ctx)) dropRouters(ctx, p, 'cleared');
    out.unshift(...writePort(ctx, p));
    out.push(...armLife(ctx, p));
    return out;
  }

  /** Every port the daemon knows or the config mentions, in port order. */
  function reconcileAll(ctx: ProcessCtx): Action[] {
    const out: Action[] = [];
    for (const [id, view] of ctx.ports) out.push(...reconcile(ctx, id, view.operUp));
    for (const id of Array.from(ports.keys())) if (!ctx.ports.has(id)) out.push(...reconcile(ctx, id, false));
    return out;
  }

  function onDadResult(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'ipv6.dadResult' }>): Action[] {
    const p = ports.get(req.iface);
    const address = normalizeIpv6(req.address);
    if (p === undefined || address === null) return [];
    p.dadPending.delete(address);
    const a = p.addrs.find((x) => x.address === address);
    if (a === undefined || a.state !== 'tentative') {
      debug(ctx, CAT_ROUTING, `stale duplicate address detection result for ${address} on ${req.iface} ignored`, { port: req.iface, address });
      return [];
    }
    const out: Action[] = [];
    if (req.ok) {
      if (!portUp(ctx, p.port)) {
        debug(ctx, CAT_ROUTING, `${address} on ${p.port}: detection finished while the port is down; it stays tentative`, { port: p.port, address });
        return [];
      }
      a.state = slaacState(ctx, a);
      debug(ctx, CAT_ROUTING, `${address} on ${p.port} is unique: ${a.state}`, { port: p.port, address, state: a.state });
      syncPortRoutes(ctx, p, true, 'cleared');
    } else {
      a.state = 'duplicate';
      const isLl = a.scope === 'link-local';
      debug(ctx, CAT_ROUTING, `${address} on ${p.port} is a duplicate${isLl ? '; IPv6 stops on this interface' : ''}`, { port: p.port, address });
      out.push({ type: 'log', severity: 4, facility: IPV6_LOG_FACILITY, message: `Duplicate address ${address} on ${p.port}` });
      if (isLl) {
        p.llDuplicate = true;
        syncPortRoutes(ctx, p, false, 'cleared');
        dropRouters(ctx, p, 'cleared');
      } else {
        syncPortRoutes(ctx, p, true, 'cleared');
      }
    }
    out.unshift(...writePort(ctx, p));
    out.push(...armLife(ctx, p));
    return out;
  }

  /** RFC 4862 §5.5.3: SLAAC from one prefix information option; plus the ND default router (hosts only). */
  function onRaLearned(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'ipv6.raLearned' }>): Action[] {
    const p = ports.get(req.iface);
    const router = normalizeIpv6(req.router);
    if (p === undefined || router === null || p.llDuplicate) return [];
    const out: Action[] = [];
    // default router (a forwarding device never takes one from an RA)
    if (!isForwarding(ctx) && p.autoconfig) {
      const lifetimeS = req.routerLifetimeS;
      const owner = `nd:${p.port}|${router}`;
      const key = route6Key('::', 0);
      if (lifetimeS === 0) {
        if (p.routers.delete(router)) {
          rib(ctx).withdraw(key, owner, ctx.now, 'cleared');
          debug(ctx, CAT_ROUTING, `router ${router} on ${p.port} is no longer a default router`, { router, iface: p.port });
        }
      } else if (portUp(ctx, p.port)) {
        const expiresAt = lifetimeS === undefined ? undefined : ctx.now + lifetimeS * SEC;
        const isNew = !p.routers.has(router);
        p.routers.set(router, expiresAt);
        const row: Route6Row = {
          key, network: '::', prefixLen: 0, source: 'ND', nextHop: router, iface: p.port, ad: AD_ND, metric: 0, isDefault: true, updatedAt: ctx.now,
        };
        if (expiresAt !== undefined) row.expiresAt = expiresAt;
        rib(ctx).offer(row, owner);
        if (isNew) debug(ctx, CAT_ROUTING, `add ND ::/0 via ${router} on ${p.port}`, { router, iface: p.port, lifetimeS });
      }
    }
    // stateless address autoconfiguration
    const prefix = req.prefix === undefined ? null : normalizeIpv6(req.prefix);
    const valid = req.validLifetimeS;
    const preferred = req.preferredLifetimeS;
    if (p.autoconfig && prefix !== null && req.prefixLen !== undefined) {
      const view = ctx.ports.get(p.port);
      const scope = ipv6Scope(prefix);
      if (view === undefined || scope === 'link-local' || scope === 'multicast') {
        debug(ctx, CAT_ROUTING, `prefix ${prefix}/${req.prefixLen} from ${router} ignored: not a global prefix`, { prefix });
      } else if (req.prefixLen !== 64) {
        debug(ctx, CAT_ROUTING, `prefix ${prefix}/${req.prefixLen} from ${router} ignored: SLAAC needs a /64`, { prefix, prefixLen: req.prefixLen });
      } else if (valid === undefined || preferred === undefined || preferred > valid || valid === 0) {
        debug(ctx, CAT_ROUTING, `prefix ${prefix}/64 from ${router} ignored: unusable lifetimes`, { prefix, valid, preferred });
      } else {
        const address = eui64Address(prefix, 64, view.mac) as Ipv6Address;
        const receivedValid = valid === INFINITE_LIFETIME_S ? undefined : valid * SEC;
        const preferredUntil = preferred === INFINITE_LIFETIME_S ? undefined : ctx.now + preferred * SEC;
        const existing = p.addrs.find((a) => a.address === address);
        if (existing === undefined) {
          const a: Ipv6PortAddress = { address, prefixLen: 64, scope: portScope6(address), origin: 'slaac', state: 'tentative' };
          if (preferredUntil !== undefined) a.preferredUntil = preferredUntil;
          if (receivedValid !== undefined) a.validUntil = ctx.now + receivedValid;
          p.addrs.push(a);
          debug(ctx, CAT_ROUTING, `autoconfigured ${address}/64 on ${p.port} from ${router} is tentative`, { port: p.port, address, router });
          out.push(...startDad(ctx, p));
        } else if (existing.origin === 'slaac') {
          // RFC 4862 §5.5.3 (e): the two-hour rule
          const remaining = existing.validUntil === undefined ? undefined : existing.validUntil - ctx.now;
          if (receivedValid === undefined) delete existing.validUntil;
          else if (remaining === undefined) {
            // an infinite lifetime is only shortened down to two hours
            existing.validUntil = ctx.now + Math.max(receivedValid, SLAAC_TWO_HOURS_NS);
          } else if (receivedValid > SLAAC_TWO_HOURS_NS || receivedValid > remaining) existing.validUntil = ctx.now + receivedValid;
          else if (remaining > SLAAC_TWO_HOURS_NS) existing.validUntil = ctx.now + SLAAC_TWO_HOURS_NS;
          if (preferredUntil === undefined) delete existing.preferredUntil;
          else existing.preferredUntil = preferredUntil;
          if (existing.state === 'deprecated' && (preferredUntil === undefined || preferredUntil > ctx.now)) existing.state = 'preferred';
          else if (existing.state === 'preferred' && preferredUntil !== undefined && preferredUntil <= ctx.now) existing.state = 'deprecated';
          syncPortRoutes(ctx, p, portUp(ctx, p.port), 'cleared');
        }
      }
    }
    out.unshift(...writePort(ctx, p));
    out.push(...armLife(ctx, p));
    return out;
  }

  /** `life:<iface>` fired: deprecate / expire autoconfigured addresses and default routers. */
  function onLife(ctx: ProcessCtx, port: PortId): Action[] {
    const p = ports.get(port);
    if (p === undefined) return [];
    delete p.lifeAt;
    const kept: Ipv6PortAddress[] = [];
    for (const a of p.addrs) {
      if (a.origin === 'slaac' && a.validUntil !== undefined && a.validUntil <= ctx.now) {
        p.dadPending.delete(a.address);
        debug(ctx, CAT_ROUTING, `autoconfigured ${a.address} on ${port} expired`, { port, address: a.address });
        continue;
      }
      if (a.origin === 'slaac' && a.state === 'preferred' && a.preferredUntil !== undefined && a.preferredUntil <= ctx.now) {
        a.state = 'deprecated';
        debug(ctx, CAT_ROUTING, `autoconfigured ${a.address} on ${port} is deprecated`, { port, address: a.address });
      }
      kept.push(a);
    }
    p.addrs = kept;
    for (const [router, t] of Array.from(p.routers)) {
      if (t === undefined || t > ctx.now) continue;
      p.routers.delete(router);
      rib(ctx).withdraw(route6Key('::', 0), `nd:${port}|${router}`, ctx.now, 'aged');
      debug(ctx, CAT_ROUTING, `default router ${router} on ${port} timed out`, { router, iface: port });
    }
    syncPortRoutes(ctx, p, portUp(ctx, port), 'aged');
    return [...writePort(ctx, p), ...armLife(ctx, p)];
  }

  // ── packet paths ────────────────────────────────────────────────────────

  /** Index of the first ipv6 layer of `pdu`, or -1. */
  function ipIndex(pdu: Pdu): number {
    for (let i = 0; i < pdu.layers.length; i++) if (pdu.layers[i]!.proto === 'ipv6') return i;
    return -1;
  }

  /**
   * Deliver a packet addressed to this device: walk the extension headers and hand the upper layer to its daemon
   * (§4.2 table), or answer with the RFC 8200 parameter-problem errors.
   */
  function deliverLocal(ctx: ProcessCtx, pdu: Pdu, idx: number, port: PortId): Action[] {
    const ip = pdu.layers[idx]!;
    let nextHeaderPointer = FIXED_NEXT_HEADER_POINTER;
    let nextHeader = Number(ip.fields.nextHeader);
    for (let i = idx + 1; i < pdu.layers.length; i++) {
      const l = pdu.layers[i]!;
      const rel = l.offset - ip.offset;
      if (l.proto === 'ipv6-hopopts' || l.proto === 'ipv6-dstopts') {
        nextHeaderPointer = rel;
        nextHeader = Number(l.fields.nextHeader);
        continue;
      }
      if (l.proto === 'ipv6-route') {
        const routingType = Number(l.fields.routingType);
        const left = Number(l.fields.segmentsLeft ?? 0);
        if (routingType === 0 || left > 0) {
          const why = routingType === 0 ? 'routing header type 0 is deprecated' : `routing type ${routingType} is not supported`;
          return [drop(ctx, pdu, 'other', why, port), icmpError(pdu, ICMPV6_PARAM_PROBLEM, 0, port, rel + ROUTING_TYPE_OFFSET)];
        }
        nextHeaderPointer = rel;
        nextHeader = Number(l.fields.nextHeader);
        continue;
      }
      if (l.proto === 'ipv6-frag') {
        return [drop(ctx, pdu, 'other', 'ipv6 reassembly not supported in P1', port)];
      }
      if (l.proto === 'icmpv6') {
        const type = Number(l.fields.type);
        const to: ProcessName = type >= 133 && type <= 137 ? 'nd' : 'icmpv6';
        delivered++;
        debug(ctx, CAT_PACKET, `deliver ${describe(ip)} to ${to}`, { pdu: pdu.id, port, to });
        return [{ type: 'deliver', to, pdu, port }];
      }
      if (l.proto === 'tcp' || l.proto === 'udp') {
        const proc = l.proto;
        if (hasProcess(ctx, proc)) {
          delivered++;
          debug(ctx, CAT_PACKET, `deliver ${describe(ip)} to ${proc}`, { pdu: pdu.id, port, to: proc });
          return [{ type: 'deliver', to: proc, pdu, port }];
        }
        break;
      }
      break;
    }
    if (nextHeader === IPPROTO_NONE) {
      delivered++;
      debug(ctx, CAT_PACKET, `consume ${describe(ip)}: no next header`, { pdu: pdu.id, port });
      return [{ type: 'consume', pdu }];
    }
    const transport = TRANSPORT_PROCESSES[nextHeader];
    const detail = transport !== undefined ? `next header ${nextHeader} (${transport}) has no listener` : `next header ${nextHeader} has no listener`;
    return [drop(ctx, pdu, 'unsupported-protocol', detail, port), icmpError(pdu, ICMPV6_PARAM_PROBLEM, 1, port, nextHeaderPointer)];
  }

  /**
   * Egress for a matched route: next hop = `route.nextHop` or the destination (connected); interface =
   * `route.iface`, else the port on whose prefix the next hop lies, else one level of recursion.
   */
  function resolveEgress(ctx: ProcessCtx, route: Route6Row, dst: Ipv6Address): Egress6 | undefined {
    const h = ipv6Helpers(ctx);
    const nextHop = route.nextHop ?? dst;
    if (route.iface !== undefined) return { nextHop, iface: route.iface };
    const direct = h.connectedPortFor6(nextHop);
    if (direct !== undefined) return { nextHop, iface: direct };
    const inner = h.lpm6(nextHop).winner;
    if (inner === undefined || inner.key === route.key || inner.source === 'L') return undefined;
    if (inner.nextHop !== undefined) {
      const via = inner.iface ?? h.connectedPortFor6(inner.nextHop);
      return via === undefined ? undefined : { nextHop: inner.nextHop, iface: via };
    }
    return inner.iface === undefined ? undefined : { nextHop, iface: inner.iface };
  }

  /** Transit forwarding of a packet received on `port`. */
  function forward(ctx: ProcessCtx, pdu: Pdu, ip: LayerView, port: PortId): Action[] {
    const h = ipv6Helpers(ctx);
    const src = String(ip.fields.src);
    const dst = String(ip.fields.dst);
    const hopLimit = Number(ip.fields.hopLimit);
    if (isMulticast6(dst)) return [drop(ctx, pdu, 'not-for-me', 'multicast packets are not routed', port)];
    if (isLinkLocal6(dst)) return [drop(ctx, pdu, 'not-for-me', 'link-local destinations are never forwarded', port)];
    if (isUnspecified6(src)) return [drop(ctx, pdu, 'other', 'packets from the unspecified address are never forwarded', port)];
    if (hopLimit <= 1) {
      return [drop(ctx, pdu, 'ttl-expired', `hop limit ${hopLimit} reached zero in transit`, port), icmpError(pdu, ICMPV6_TIME_EXCEEDED, 0, port)];
    }
    const route = h.lpm6(dst).winner;
    if (route === undefined) {
      return [drop(ctx, pdu, 'no-route', `no IPv6 route to ${dst}`, port), icmpError(pdu, ICMPV6_DEST_UNREACHABLE, ICMPV6_UNREACH_NO_ROUTE, port)];
    }
    const cause = route6Cause(route);
    if (route.source === 'L') return [drop(ctx, pdu, 'not-for-me', `${dst} is an own address that is not ready yet`, port)];
    const egress = resolveEgress(ctx, route, dst);
    if (egress === undefined) {
      return [
        drop(ctx, pdu, 'no-route', `next hop ${route.nextHop ?? dst} of ${cause} is not on a connected prefix`, port),
        icmpError(pdu, ICMPV6_DEST_UNREACHABLE, ICMPV6_UNREACH_NO_ROUTE, port),
      ];
    }
    if (isLinkLocal6(src) && egress.iface !== port) {
      return [drop(ctx, pdu, 'no-route', `link-local source ${src} cannot leave ${port}`, port), icmpError(pdu, ICMPV6_DEST_UNREACHABLE, 2, port)];
    }
    const out = ctx.ports.get(egress.iface);
    if (out !== undefined && ip.length > out.mtu) {
      return [
        drop(ctx, pdu, 'other', `packet of ${ip.length} bytes is larger than the ${out.mtu}-byte MTU of ${egress.iface}`, port),
        icmpError(pdu, ICMPV6_PACKET_TOO_BIG, 0, port, out.mtu),
      ];
    }
    ctx.mutate(pdu, 'ipv6.hopLimit', hopLimit - 1, 'TtlDecrement', cause);
    forwarded++;
    debug(ctx, CAT_PACKET, `forward ${describe(pdu.layer('ipv6') ?? ip)} via ${egress.iface} next hop ${egress.nextHop} (${cause})`, {
      pdu: pdu.id, route: route.key, nextHop: egress.nextHop, iface: egress.iface, inPort: port,
    });
    return [{ type: 'request', to: 'nd', req: { kind: 'nd.sendVia', pdu, nextHop: egress.nextHop, iface: egress.iface, cause } }];
  }

  /** Locally originated packet (`ipv6.send`). */
  function send(ctx: ProcessCtx, req: Extract<ProcessRequest, { kind: 'ipv6.send' }>): Action[] {
    const h = ipv6Helpers(ctx);
    const pdu = req.pdu;
    const idx = ipIndex(pdu);
    if (idx < 0) return [drop(ctx, pdu, 'other', 'ipv6.send without an IPv6 header')];
    const ip = pdu.layers[idx]!;
    const dst = String(ip.fields.dst);
    if (!isMulticast6(dst)) {
      const own = h.ownAddress6(dst);
      if (own !== undefined && h.isLocalDestination6(dst)) {
        sent++;
        debug(ctx, CAT_PACKET, `send ${describe(ip)}: own address, delivered locally`, { pdu: pdu.id, port: own });
        return deliverLocal(ctx, pdu, idx, own);
      }
    }
    let egress: Egress6 | undefined;
    let cause = req.cause;
    if (req.iface !== undefined) {
      const view = ctx.ports.get(req.iface);
      if (view === undefined || view.l3.ipv6Enabled !== true) {
        return [drop(ctx, pdu, 'no-l3-address', `IPv6 is not enabled on ${req.iface}`, req.iface)];
      }
      if (req.nextHop !== undefined) egress = { nextHop: req.nextHop, iface: req.iface };
      else if (isLinkScoped6(dst) || h.connectedPortFor6(dst, req.iface) === req.iface) egress = { nextHop: dst, iface: req.iface };
      else {
        const viaIface = h.lpm6(dst).candidates.find((r) => r.iface === req.iface && r.source !== 'L');
        if (viaIface !== undefined) {
          egress = { nextHop: viaIface.nextHop ?? dst, iface: req.iface };
          cause ??= route6Cause(viaIface);
        }
      }
      if (egress === undefined) return [drop(ctx, pdu, 'no-route', `no IPv6 route to ${dst} out ${req.iface}`, req.iface)];
    } else {
      if (isLinkScoped6(dst)) return [drop(ctx, pdu, 'no-route', 'link-local and multicast destinations need an egress interface')];
      const route = h.lpm6(dst).winner;
      if (route === undefined) return [drop(ctx, pdu, 'no-route', `no IPv6 route to ${dst}`)];
      egress = resolveEgress(ctx, route, dst);
      cause ??= route6Cause(route);
      if (egress === undefined) return [drop(ctx, pdu, 'no-route', `next hop ${route.nextHop ?? dst} of ${route6Cause(route)} is not on a connected prefix`)];
    }
    sent++;
    debug(ctx, CAT_PACKET, `send ${describe(ip)} via ${egress.iface} next hop ${egress.nextHop}`, { pdu: pdu.id, nextHop: egress.nextHop, iface: egress.iface });
    const sendReq: ProcessRequest = { kind: 'nd.sendVia', pdu, nextHop: egress.nextHop, iface: egress.iface };
    if (cause !== undefined) sendReq.cause = cause;
    return [{ type: 'request', to: 'nd', req: sendReq }];
  }

  function syncGlobal(ctx: ProcessCtx): Action[] {
    const before = routing;
    routing = globalIpv6Lines(ctx).some((l) => l[1] === 'unicast-routing');
    syncStatics(ctx);
    const out: Action[] = [];
    if (before !== routing) {
      debug(ctx, CAT_ROUTING, `IPv6 unicast routing ${routing ? 'on' : 'off'}${routing && !ctx.model.ipForwarding ? ' (this device does not forward)' : ''}`, { routing });
      for (const p of ports.values()) {
        if (isForwarding(ctx)) dropRouters(ctx, p, 'cleared');
        out.push(...writePort(ctx, p));
        out.push(...armLife(ctx, p));
      }
    }
    return out;
  }

  // ── the process ─────────────────────────────────────────────────────────

  return {
    name: NAME,
    handles: IPV6_HANDLES,

    init(ctx: ProcessCtx): Action[] {
      return [...syncGlobal(ctx), ...reconcileAll(ctx)];
    },

    onPdu(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
      const h = ipv6Helpers(ctx);
      const idx = ipIndex(pdu);
      if (idx < 0) return [drop(ctx, pdu, 'other', 'no IPv6 header', port)];
      const ip = pdu.layers[idx]!;
      if (ip.error !== undefined) return [drop(ctx, pdu, 'other', ip.error, port)];
      if (Number(ip.fields.version) !== 6) return [drop(ctx, pdu, 'other', `version ${String(ip.fields.version)} is not 6`, port)];
      const view = ctx.ports.get(port);
      if (view === undefined || view.l3.ipv6Enabled !== true || !ports.has(port)) {
        return [drop(ctx, pdu, 'unsupported-protocol', `IPv6 is not enabled on ${port}`, port)];
      }
      const src = String(ip.fields.src);
      const dst = String(ip.fields.dst);
      if (isMulticast6(src)) return [drop(ctx, pdu, 'other', 'multicast source address', port)];
      debug(ctx, CAT_PACKET, `rx ${describe(ip)} on ${port}`, { pdu: pdu.id, port });
      if (h.isLocalDestination6(dst, port)) return deliverLocal(ctx, pdu, idx, port);
      if (!isForwarding(ctx)) {
        return [drop(ctx, pdu, 'not-for-me', `${dst} is not a local address and this device does not route IPv6`, port)];
      }
      return forward(ctx, pdu, ip, port);
    },

    onTimer(ctx: ProcessCtx, key: string): Action[] {
      if (key.startsWith(TIMER_LIFE_PREFIX)) return onLife(ctx, key.slice(TIMER_LIFE_PREFIX.length));
      return [];
    },

    onConfig(ctx: ProcessCtx, delta: ConfigDelta): Action[] {
      const line = delta.line;
      const head = delta.context[0];
      const ifacePort = delta.context.length === 1 && head !== undefined && head[0] === 'interface' ? head[1] : undefined;
      const switchport = line[0] === 'switchport' || (line[0] === 'no' && line[1] === 'switchport');
      if (ifacePort !== undefined && (line[0] === 'ipv6' || switchport)) {
        const port = findPort6(ctx, ifacePort) ?? ifacePort;
        return reconcile(ctx, port, portUp(ctx, port));
      }
      if (delta.context.length === 0 && (line[0] === 'ipv6' || (line[0] === 'no' && line[1] === 'ipv6'))) return syncGlobal(ctx);
      if (delta.context.length === 0 && line[0] === 'interface') {
        // `no interface LoopbackN` removes a virtual port together with its section
        const out: Action[] = [];
        for (const id of Array.from(ports.keys())) if (!ctx.ports.has(id)) out.push(...reconcile(ctx, id, false));
        return out;
      }
      return [];
    },

    onLinkChange(ctx: ProcessCtx, port: PortId, up: boolean): Action[] {
      const p = ports.get(port);
      if (p !== undefined && up) {
        // RFC 4862 §5.4: every address (duplicates included) runs detection again when the link comes back
        for (const a of p.addrs) a.state = 'tentative';
        p.llDuplicate = false;
        p.dadPending.clear();
      }
      return reconcile(ctx, port, up);
    },

    onRequest(ctx: ProcessCtx, req: ProcessRequest): Action[] {
      switch (req.kind) {
        case 'ipv6.send':
          return send(ctx, req);
        case 'ipv6.dadResult':
          return onDadResult(ctx, req);
        case 'ipv6.raLearned':
          return onRaLearned(ctx, req);
        default:
          return [];
      }
    },

    stateSnapshot(): StateView {
      const interfaces: Record<string, unknown>[] = [];
      for (const p of ports.values()) {
        interfaces.push({
          port: p.port,
          enabled: !p.llDuplicate,
          autoconfig: p.autoconfig,
          linkLocalDuplicate: p.llDuplicate,
          addresses: p.addrs.map((a) => ({ address: a.address, prefixLen: a.prefixLen, origin: a.origin, state: a.state })),
          defaultRouters: Array.from(p.routers.keys()),
        });
      }
      return {
        process: NAME,
        state: { forwarding: routing, interfaces, staticRoutes: statics.size, forwarded, delivered, sent, dropped },
      };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}
