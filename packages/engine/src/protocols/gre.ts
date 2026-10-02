/**
 * protocols/gre.ts — the tunnel owner [S18], GRE mode (RFC 2784 headers; ARCHITECTURE-P3 D17, D15, D8, §2.6
 * `TunnelRow`, §3.0 (a) steps 4 and 8, §3.10, §4.2, §4.3; §7 W2 wan). `ROLE_EGRESS_OWNER.tunnel` is `gre`: every send
 * on a Tunnel port reaches `onEgress`; IP protocol 47 (and, for [C13], 50) to this router reaches `onPdu`.
 *
 * Silence (§4.3): nothing is sent or watched unless a Tunnel port has a source and a destination. A `tunnels` row
 * (key = the tunnel port) exists for every configured `interface Tunnel<n>`; the runtime derives the tunnel's line
 * protocol from it when this daemon issues `virtualChanged` (D17).
 *
 * The underlay evaluation (one rule for both modes, D27), re-run on this daemon's configuration and every non-tunnel
 * link change (synchronously: the stored lines are read from the configuration, so a line is seen in its own
 * dispatch) and on `ipv4.ribChanged` for a destination (D8: `ipv4.ribWatch {owner: 'gre', lpm: [destinations]}`,
 * registered while a tunnel has a destination, replaced when the set changes, stopped with `lpm: []`):
 *   1. `tunnel source <if|address>`: the interface (or the interface owning the address) is up and addressed, else
 *      down `no-source`;
 *   2. `tunnel destination <a>`, else down `no-destination`;
 *   3. the longest match for the destination exists, else down `no-route`, and leaves through a non-tunnel interface,
 *      else down `recursive-routing` (with a severity-5 log). Without [S36]'s hold timer (not approved) a tunnel
 *      down for recursive routing is NOT brought back by a RIB change (that would flap in the same dispatch); the
 *      next configuration or link change evaluates it again;
 *   4. up: `transportMtu` = the MTU of the interface the destination is routed through, `ipMtu` = transportMtu −
 *      `GRE_OVERHEAD` (1476 on a 1500-byte port), or `ip mtu <n>` when it is smaller (fragmentation is not
 *      simulated, D15, so a larger IP MTU cannot be carried).
 *   `tunnel mode ipsec ipv4` [C13] passes the same evaluation and then stays down `ike-negotiating` until the W3 ike
 *   item adds the SA (`ike.connect` / `tunnel.sa`, the ESP key id of ruling R21); its IP MTU is transport − 44.
 * A state change is an `ctx.transition` of machine `tunnel` (subject 'Tunnel0', states down and up, category `tunnel`);
 * the row is rewritten only when a displayed column changes (rule 20).
 *
 * Head (`onEgress`, §3.10 step 2): the inner packet must be IPv4 and at most the tunnel's IP MTU, else drop
 * `mtu-exceeded` with the detail `larger than the tunnel can carry (1476 bytes); fragmentation is not simulated` and,
 * when DF is set, `icmp.error {3, 4, param: ipMtu}` (D15, RFC 1191); `ip tcp adjust-mss <n>` clamps the MSS option of
 * a SYN; then ONE rewrap — strip the framing, push `[ipv4 {source → destination, protocol 47, ttl 255, dscp copied},
 * gre {protocolType 0x0800}]`, cause `interface Tunnel0` — and `ipv4.send`. The PduId never changes.
 * Tail (`onPdu`, §3.10 step 4): the GRE-mode tunnel whose source and destination are the outer destination and
 * source, up, strips the framing, the outer IPv4 and GRE (one rewrap, cause `interface Tunnel0`), clamps the MSS, and
 * injects the inner packet as `ingress {port: 'Tunnel0', layer: 'ipv4'}` (it counts on the tunnel).
 *
 * Debug category `tunnel` (§5.8). No timer, no randomness (§4.1, §4.2).
 * stateSnapshot(): { tunnels: [{ port, mode, state, encaps, decaps, mtuDrops, mssClamped }] } (port order).
 */
import { ipv4ToU32, isIpv4, type Ipv4Address } from '../contracts/addr.js';
import type { ConfigDelta, ConfigNode } from '../contracts/config.js';
import type { PortId } from '../contracts/ids.js';
import {
  ETHERTYPE_IPV4,
  GRE_OVERHEAD,
  ICMP_DEST_UNREACHABLE,
  ICMP_UNREACH_FRAG_NEEDED,
  IPPROTO_ESP,
  IPPROTO_GRE,
  IPSEC_OVERHEAD,
  type LayerSpec,
  type Pdu,
} from '../contracts/pdu.js';
import type { Action, DebugEvent, FsmTransition, Process, ProcessCtx, StateView } from '../contracts/process.js';
import type { RouteRow, Table, TunnelDownReason, TunnelRow } from '../contracts/tables.js';
import type { ProcessEvent } from '../contracts/transport.js';
import { configTextLinesOf } from '../cli/config-text.js';

const NAME = 'gre';
const DEBUG_RING = 256;
/** Recursion depth when the route to a destination names only a next hop. */
const NEXT_HOP_DEPTH = 4;

/** Debug category of the tunnel owner, both modes (§5.8; `debug tunnel`). */
export const GRE_DEBUG = 'tunnel';
/** Facility of the recursive-routing log. */
export const GRE_LOG_FACILITY = 'TUNNEL';
/** TTL of the outer IPv4 header (§3.10 step 2). */
export const GRE_OUTER_TTL = 255;
/** IPv4 flags bit "don't fragment" (`ipv4.flags` is the 3-bit field). */
export const GRE_IPV4_DF = 0x2;
/** The MTU a tunnel assumes when its transport is unknown (no usable source or route). */
export const GRE_DEFAULT_TRANSPORT_MTU = 1500;

/** The D15 drop detail of a packet larger than the tunnel's IP MTU. */
export function greMtuDetail(ipMtu: number): string {
  return `larger than the tunnel can carry (${ipMtu} bytes); fragmentation is not simulated`;
}

/** The provenance cause of every rewrap and clamp on `port` (§3.10). */
export function greTunnelCause(port: PortId): string {
  return `interface ${port}`;
}

/** The stored lines of one `interface Tunnel<n>` section (§5.7). */
export interface GreTunnelConfig {
  readonly port: PortId;
  /** `tunnel source <if>`. */
  readonly sourceIface?: PortId;
  /** `tunnel source <address>`. */
  readonly sourceAddress?: Ipv4Address;
  readonly destination?: Ipv4Address;
  readonly mode: 'gre' | 'ipsec';
  /** `ip mtu <n>`. */
  readonly ipMtu?: number;
  /** `ip tcp adjust-mss <n>`. */
  readonly adjustMss?: number;
}

const posInt = (t: string | undefined, lo: number, hi: number): number | undefined => {
  if (t === undefined || !/^\d+$/.test(t)) return undefined;
  const v = Number(t);
  return v >= lo && v <= hi ? v : undefined;
};

/** Every `interface Tunnel<n>` section of `root` naming a tunnel port in `isTunnel`, with its tunnel lines. */
export function readGreTunnels(root: ConfigNode, isTunnel: (port: PortId) => boolean): GreTunnelConfig[] {
  const acc = new Map<PortId, { sourceIface?: PortId; sourceAddress?: Ipv4Address; destination?: Ipv4Address; mode: 'gre' | 'ipsec'; ipMtu?: number; adjustMss?: number }>();
  for (const n of root.children) {
    if (n.key === 'interface' && n.args[0] !== undefined && isTunnel(n.args[0]) && !acc.has(n.args[0])) acc.set(n.args[0], { mode: 'gre' });
  }
  for (const l of configTextLinesOf(root)) {
    const head = l.context[0];
    if (l.context.length !== 1 || head?.[0] !== 'interface' || l.negate) continue;
    const c = acc.get(head[1] ?? '');
    if (c === undefined) continue;
    const t = l.tokens;
    if (t[0] === 'tunnel' && t[1] === 'source' && t[2] !== undefined) {
      if (isIpv4(t[2])) {
        c.sourceAddress = t[2];
        delete c.sourceIface;
      } else {
        c.sourceIface = t[2];
        delete c.sourceAddress;
      }
    } else if (t[0] === 'tunnel' && t[1] === 'destination' && t[2] !== undefined && isIpv4(t[2])) c.destination = t[2];
    else if (t[0] === 'tunnel' && t[1] === 'mode') c.mode = t[2] === 'ipsec' ? 'ipsec' : 'gre';
    else if (t[0] === 'ip' && t[1] === 'mtu') {
      const v = posInt(t[2], 68, 9216);
      if (v !== undefined) c.ipMtu = v;
    } else if (t[0] === 'ip' && t[1] === 'tcp' && t[2] === 'adjust-mss') {
      const v = posInt(t[3], 500, 1460);
      if (v !== undefined) c.adjustMss = v;
    }
  }
  return [...acc].map(([port, c]) => ({ port, ...c }));
}

/** The static IPv4 address stored on `port` (`ip address A M`), `'dhcp'`, or undefined. */
function storedAddress(root: ConfigNode, port: PortId): Ipv4Address | 'dhcp' | undefined {
  let out: Ipv4Address | 'dhcp' | undefined;
  for (const l of configTextLinesOf(root)) {
    const head = l.context[0];
    if (l.context.length !== 1 || head?.[0] !== 'interface' || head[1] !== port || l.negate) continue;
    const t = l.tokens;
    if (t[0] !== 'ip' || t[1] !== 'address') continue;
    if (t[2] === 'dhcp') out = 'dhcp';
    else if (t[2] !== undefined && isIpv4(t[2]) && t[4] === undefined) out = t[2];
  }
  return out;
}

/** What the evaluation decided for one tunnel (the displayed columns of its row). */
interface Verdict {
  mode: 'gre' | 'ipsec';
  source?: Ipv4Address;
  sourceIface?: PortId;
  destination?: Ipv4Address;
  state: 'up' | 'down';
  reason?: TunnelDownReason;
  transportMtu: number;
  ipMtu: number;
}

interface Counters {
  encaps: number;
  decaps: number;
  mtuDrops: number;
  mssClamped: number;
}

export function createGre(): Process {
  /** port → the last row written (its displayed columns) and the configuration it was evaluated from. */
  const rows = new Map<PortId, { verdict: Verdict; since: number; cfg: GreTunnelConfig }>();
  const counters = new Map<PortId, Counters>();
  /** The destinations watched (`ipv4.ribWatch`), sorted and joined; '' = no watch. */
  let watched = '';
  /** The canonical port order last seen (the StateView, which has no ctx, lists tunnels in it). */
  let portOrder = new Map<PortId, number>();
  const ring: DebugEvent[] = [];

  function debug(ctx: ProcessCtx, message: string, data?: Record<string, unknown>): void {
    ctx.debug(GRE_DEBUG, message, data);
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: NAME, category: GRE_DEBUG, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: NAME, category: GRE_DEBUG, message };
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  const table = (ctx: ProcessCtx): Table<TunnelRow> | undefined => ctx.tables.get<TunnelRow>('tunnels');
  const isTunnelPort = (ctx: ProcessCtx, port: PortId): boolean => {
    const p = ctx.ports.get(port);
    return p !== undefined && (p.role === 'tunnel' || p.spec.role === 'tunnel');
  };
  const countersOf = (port: PortId): Counters => {
    let c = counters.get(port);
    if (c === undefined) {
      c = { encaps: 0, decaps: 0, mtuDrops: 0, mssClamped: 0 };
      counters.set(port, c);
    }
    return c;
  };

  /** The interface a route leaves through (a next-hop-only route is followed, at most NEXT_HOP_DEPTH times). */
  function egressOf(ctx: ProcessCtx, route: RouteRow | undefined, depth = 0): PortId | undefined {
    if (route === undefined) return undefined;
    if (route.iface !== undefined) return route.iface;
    if (route.nextHop === undefined || depth >= NEXT_HOP_DEPTH) return undefined;
    const direct = ctx.connectedPortFor(route.nextHop);
    if (direct !== undefined) return direct;
    const inner = ctx.lpm(route.nextHop).winner;
    return inner === route ? undefined : egressOf(ctx, inner, depth + 1);
  }

  /** The source of a tunnel: its interface and address, when that interface is up and addressed. */
  function sourceOf(ctx: ProcessCtx, c: GreTunnelConfig): { iface?: PortId; address?: Ipv4Address; usable: boolean } {
    let iface = c.sourceIface;
    if (iface === undefined && c.sourceAddress !== undefined) {
      for (const id of ctx.ports.keys()) {
        if (storedAddress(ctx.config.root, id) === c.sourceAddress) {
          iface = id;
          break;
        }
      }
      iface ??= ctx.ownAddress(c.sourceAddress);
    }
    if (iface === undefined) return c.sourceAddress !== undefined ? { address: c.sourceAddress, usable: false } : { usable: false };
    const p = ctx.ports.get(iface);
    const stored = storedAddress(ctx.config.root, iface);
    const address = c.sourceAddress ?? (stored === 'dhcp' ? p?.l3.ipv4?.address : stored);
    const usable = p !== undefined && p.adminUp && p.operUp && address !== undefined && p.role !== 'tunnel';
    return address !== undefined ? { iface, address, usable } : { iface, usable };
  }

  function evaluate(ctx: ProcessCtx, c: GreTunnelConfig): Verdict {
    const src = sourceOf(ctx, c);
    const overhead = c.mode === 'ipsec' ? IPSEC_OVERHEAD : GRE_OVERHEAD;
    const ipMtuOf = (transport: number): number => Math.min(transport - overhead, c.ipMtu ?? Number.MAX_SAFE_INTEGER);
    const sourceMtu = src.iface !== undefined ? ctx.ports.get(src.iface)?.mtu ?? GRE_DEFAULT_TRANSPORT_MTU : GRE_DEFAULT_TRANSPORT_MTU;
    const v: Verdict = { mode: c.mode, state: 'down', transportMtu: sourceMtu, ipMtu: ipMtuOf(sourceMtu) };
    if (src.address !== undefined) v.source = src.address;
    if (src.iface !== undefined) v.sourceIface = src.iface;
    if (c.destination !== undefined) v.destination = c.destination;
    if (!src.usable) return { ...v, reason: 'no-source' };
    if (c.destination === undefined) return { ...v, reason: 'no-destination' };
    const egress = egressOf(ctx, ctx.lpm(c.destination).winner);
    if (egress === undefined) return { ...v, reason: 'no-route' };
    if (isTunnelPort(ctx, egress)) return { ...v, reason: 'recursive-routing' };
    const transport = ctx.ports.get(egress)?.mtu ?? GRE_DEFAULT_TRANSPORT_MTU;
    const up: Verdict = { ...v, transportMtu: transport, ipMtu: ipMtuOf(transport) };
    // [C13] ipsec mode waits for its SA (the W3 ike item: ike.connect / tunnel.sa)
    if (c.mode === 'ipsec') return { ...up, reason: 'ike-negotiating' };
    return { ...up, state: 'up' };
  }

  const fingerprint = (v: Verdict): string =>
    JSON.stringify([v.mode, v.source ?? null, v.sourceIface ?? null, v.destination ?? null, v.state, v.reason ?? null, v.transportMtu, v.ipMtu]);

  /** Evaluate every tunnel; write changed rows; keep the RIB watch; `fromRib`: a recursive-routing tunnel stays down. */
  function evaluateAll(ctx: ProcessCtx, fromRib: boolean): Action[] {
    const out: Action[] = [];
    let changed = false;
    portOrder = new Map([...ctx.ports.keys()].map((id, i) => [id, i]));
    const tunnels = readGreTunnels(ctx.config.root, (p) => isTunnelPort(ctx, p));
    const present = new Set(tunnels.map((t) => t.port));
    for (const port of [...rows.keys()]) {
      if (present.has(port)) continue;
      rows.delete(port);
      counters.delete(port);
      table(ctx)?.delete(port, 'cleared');
      debug(ctx, `${port} removed`, { port });
      changed = true;
    }
    for (const c of tunnels) {
      const prev = rows.get(c.port);
      if (fromRib && prev !== undefined && prev.verdict.reason === 'recursive-routing' && prev.cfg.destination === c.destination) continue;
      const v = evaluate(ctx, c);
      const fp = fingerprint(v);
      if (prev !== undefined && fingerprint(prev.verdict) === fp) {
        prev.cfg = c;
        continue;
      }
      const stateChanged = prev === undefined || prev.verdict.state !== v.state;
      const since = stateChanged ? ctx.now : prev.since;
      rows.set(c.port, { verdict: v, since, cfg: c });
      const row: TunnelRow = { key: c.port, port: c.port, mode: v.mode, state: v.state, transportMtu: v.transportMtu, ipMtu: v.ipMtu, since, updatedAt: ctx.now };
      if (v.source !== undefined) row.source = v.source;
      if (v.sourceIface !== undefined) row.sourceIface = v.sourceIface;
      if (v.destination !== undefined) row.destination = v.destination;
      if (v.reason !== undefined) row.reason = v.reason;
      table(ctx)?.set(row);
      if (prev === undefined || prev.verdict.state !== v.state || prev.verdict.reason !== v.reason) changed = true;
      const from = prev?.verdict.state ?? 'down';
      const why = v.state === 'up' ? `${v.source ?? '?'} to ${v.destination ?? '?'} via ${v.transportMtu}-byte transport, IP MTU ${v.ipMtu}` : (v.reason ?? 'no-source');
      if (from !== v.state) {
        const fsm: FsmTransition = { machine: 'tunnel', subject: c.port, port: c.port, from, to: v.state, cause: why };
        ctx.transition(GRE_DEBUG, `${c.port}: ${from} -> ${v.state} (${why})`, fsm);
        ring.push({ at: ctx.now, device: ctx.deviceId, process: NAME, category: GRE_DEBUG, message: `${c.port}: ${from} -> ${v.state} (${why})`, data: { fsm } });
        if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
      } else {
        debug(ctx, `${c.port} ${v.state}${v.reason !== undefined ? ` (${v.reason})` : ''}`, { port: c.port, reason: v.reason });
      }
      if (v.reason === 'recursive-routing' && prev?.verdict.reason !== 'recursive-routing') {
        out.push({ type: 'log', severity: 5, facility: GRE_LOG_FACILITY, message: `${c.port} is down: its destination ${v.destination ?? '?'} is routed through a tunnel (recursive routing)` });
      }
    }
    const dests = Array.from(new Set(tunnels.map((t) => t.destination).filter((d): d is Ipv4Address => d !== undefined))).sort((a, b) => ipv4ToU32(a) - ipv4ToU32(b));
    const w = dests.join(',');
    if (w !== watched) {
      const stop = w === '';
      if (!(stop && watched === '')) out.push({ type: 'request', to: 'ipv4', req: { kind: 'ipv4.ribWatch', owner: NAME, lpm: dests } });
      watched = w;
    }
    // the runtime reads the rows; the watch answers (events) follow it
    if (changed) out.unshift({ type: 'virtualChanged' });
    return out;
  }

  const hasTunnels = (ctx: ProcessCtx): boolean => {
    if (rows.size > 0) return true;
    for (const p of ctx.ports.values()) if (p.role === 'tunnel' || p.spec.role === 'tunnel') return true;
    return false;
  };

  /** `ip tcp adjust-mss`: clamp the MSS option of a TCP SYN (both directions). */
  function clampMss(ctx: ProcessCtx, pdu: Pdu, port: PortId, mss: number | undefined): void {
    if (mss === undefined) return;
    const tcp = pdu.layer('tcp');
    const flags = tcp?.fields.flags;
    const cur = tcp?.fields.mss;
    if (typeof flags !== 'string' || !flags.includes('S') || typeof cur !== 'number' || cur <= mss) return;
    ctx.mutate(pdu, 'tcp.mss', mss, 'Other', `ip tcp adjust-mss ${mss} on ${port}`);
    countersOf(port).mssClamped++;
  }

  /** Head (§3.10 step 2): wrap and hand to ipv4, or the D15 fallback. */
  function head(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
    const t = rows.get(port);
    if (t === undefined || t.verdict.state !== 'up' || t.verdict.source === undefined || t.verdict.destination === undefined) {
      return [{ type: 'drop', pdu, reason: 'link-down', detail: `${port} is down`, port }];
    }
    const i = pdu.layers.findIndex((l) => l.proto === 'ipv4');
    const inner = i < 0 ? undefined : pdu.layers[i];
    if (inner === undefined) return [{ type: 'drop', pdu, reason: 'unsupported-ethertype', detail: `${port} carries IPv4 only`, port }];
    const size = typeof inner.fields.totalLength === 'number' ? inner.fields.totalLength : inner.length;
    if (size > t.verdict.ipMtu) {
      countersOf(port).mtuDrops++;
      const detail = greMtuDetail(t.verdict.ipMtu);
      debug(ctx, `${port}: dropped a ${size}-byte packet (${detail})`, { pdu: pdu.id, port, size, ipMtu: t.verdict.ipMtu });
      const out: Action[] = [{ type: 'drop', pdu, reason: 'mtu-exceeded', detail, port }];
      const flags = typeof inner.fields.flags === 'number' ? inner.fields.flags : 0;
      if ((flags & GRE_IPV4_DF) !== 0) {
        out.push({ type: 'request', to: 'icmpv4', req: { kind: 'icmp.error', original: pdu, type: ICMP_DEST_UNREACHABLE, code: ICMP_UNREACH_FRAG_NEEDED, param: t.verdict.ipMtu } });
      }
      return out;
    }
    clampMss(ctx, pdu, port, t.cfg.adjustMss);
    const dscp = typeof inner.fields.dscp === 'number' ? inner.fields.dscp : 0;
    const push: LayerSpec[] = [
      { proto: 'ipv4', fields: { src: t.verdict.source, dst: t.verdict.destination, protocol: IPPROTO_GRE, ttl: GRE_OUTER_TTL, dscp } },
      { proto: 'gre', fields: { protocolType: ETHERTYPE_IPV4 } },
    ];
    const cause = greTunnelCause(port);
    ctx.rewrap(pdu, { strip: i, push }, cause);
    countersOf(port).encaps++;
    debug(ctx, `${port}: encapsulated ${String(inner.fields.src)} > ${String(inner.fields.dst)} in GRE to ${t.verdict.destination}`, { pdu: pdu.id, port });
    return [{ type: 'request', to: 'ipv4', req: { kind: 'ipv4.send', pdu, cause } }];
  }

  /** Tail (§3.10 step 4): find the tunnel, strip, inject on the tunnel port. */
  function tail(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
    const o = pdu.layers.findIndex((l) => l.proto === 'ipv4');
    const outer = o < 0 ? undefined : pdu.layers[o];
    if (outer === undefined) return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: 'not an IPv4 packet', port }];
    const src = String(outer.fields.src);
    const dst = String(outer.fields.dst);
    if (Number(outer.fields.protocol) === IPPROTO_ESP) {
      // [C13] ipsec mode is the W3 ike item's: until then no security association exists
      return [{ type: 'drop', pdu, reason: 'ipsec-no-sa', detail: `no IPsec security association for ESP from ${src}`, port }];
    }
    const g = pdu.layers[o + 1];
    if (g === undefined || g.proto !== 'gre') return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: 'not a GRE packet', port }];
    let match: PortId | undefined;
    for (const [p, t] of rows) {
      if (t.verdict.mode === 'gre' && t.verdict.destination === src && t.verdict.source === dst) {
        match = p;
        break;
      }
    }
    if (match === undefined) return [{ type: 'drop', pdu, reason: 'unsupported-protocol', detail: `no tunnel from ${src} to ${dst}`, port }];
    const t = rows.get(match)!;
    if (t.verdict.state !== 'up') return [{ type: 'drop', pdu, reason: 'link-down', detail: `${match} is down`, port }];
    const inner = pdu.layers[o + 2];
    if (g.fields.protocolType !== ETHERTYPE_IPV4 || inner === undefined || inner.proto !== 'ipv4') {
      return [{ type: 'drop', pdu, reason: 'unsupported-ethertype', detail: `${match} carries IPv4 only`, port }];
    }
    ctx.rewrap(pdu, { strip: o + 2, push: [] }, greTunnelCause(match));
    clampMss(ctx, pdu, match, t.cfg.adjustMss);
    countersOf(match).decaps++;
    debug(ctx, `${match}: decapsulated ${String(inner.fields.src)} > ${String(inner.fields.dst)} from ${src}`, { pdu: pdu.id, port: match });
    return [{ type: 'ingress', port: match, pdu, layer: 'ipv4' }];
  }

  return {
    name: NAME,

    init(ctx: ProcessCtx): Action[] {
      return hasTunnels(ctx) ? evaluateAll(ctx, false) : [];
    },

    onConfig(ctx: ProcessCtx, _delta: ConfigDelta): Action[] {
      return hasTunnels(ctx) ? evaluateAll(ctx, false) : [];
    },

    onLinkChange(ctx: ProcessCtx, port: PortId): Action[] {
      // the tunnel's own line protocol is this daemon's doing
      if (isTunnelPort(ctx, port) || !hasTunnels(ctx)) return [];
      return evaluateAll(ctx, false);
    },

    onEvent(ctx: ProcessCtx, ev: ProcessEvent): Action[] {
      if (ev.kind !== 'ipv4.ribChanged' || rows.size === 0) return [];
      return evaluateAll(ctx, true);
    },

    onEgress(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
      return head(ctx, pdu, port);
    },

    onPdu(ctx: ProcessCtx, pdu: Pdu, port: PortId): Action[] {
      return tail(ctx, pdu, port);
    },

    onTimer(): Action[] {
      return [];
    },

    stateSnapshot(): StateView {
      return {
        process: NAME,
        state: {
          tunnels: [...rows]
            .sort(([a], [b]) => (portOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (portOrder.get(b) ?? Number.MAX_SAFE_INTEGER))
            .map(([port, t]) => ({ port, mode: t.verdict.mode, state: t.verdict.state, ...(counters.get(port) ?? { encaps: 0, decaps: 0, mtuDrops: 0, mssClamped: 0 }) })),
        },
      };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}
