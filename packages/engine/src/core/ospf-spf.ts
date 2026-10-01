/**
 * core/ospf-spf.ts — the OSPFv2 shortest-path computation, one pure function used three times (ARCHITECTURE-P3 D10,
 * §3.1, §3.2, §4.5; RFC 2328 §16.1, §16.1.1, §16.4; §7 W1 core): by the ospf daemon (routes and the StateView's
 * trees), by the grader (`route` checks, `fact ospf.lsdbSynced`) and by the [S3] SPF stepper, whose last frame
 * equals the daemon's tree.
 *
 *   buildSpfGraph(rows, area[, now])      the area's router and network LSAs (and the AS-external LSAs), MaxAge
 *                                         copies left out;
 *   runSpf(graph, rootRid[, rootIfaces])  Dijkstra from the root router → {tree, nextHops};
 *   spfSteps(graph, rootRid[, rootIfaces]) the same run as frames: the vertex settled, the tentative list after its
 *                                         links were relaxed, and each relaxed link with its outcome;
 *   ospfRoutes(graph, result[, opts])     the intra-area routes, then the type-2 external routes, in key order.
 *
 * Vertices are keyed `R:<router id>` and `N:<DR interface address>` (`SpfVertex`, contracts/tables.ts). An edge
 * V → W is used only when W's LSA exists, is not at MaxAge and links back to V (the bidirectional check of §16.1
 * step 2(b)): a router lists V's router id in a point-to-point link or V's DR address in a transit link, a network
 * lists V in its attached routers. Candidates are settled by (cost, network before router — §16.1 step (3), so every
 * parent of a router behind a transit network is known first — vertex id as u32), never by insertion order.
 *
 * Next hops (§16.1.1): from the root, a transit network is reached directly on the root interface whose address is
 * the link's data (no next-hop address), a router over a point-to-point link through the neighbour's address on that
 * link (its link back to the root; with parallel links, the one inside the subnet of the root's stub for the link); a
 * router on a network the root reaches directly gets its own address on that network as next hop; every other
 * vertex inherits its parents' next hops. Equal-cost paths are merged (ECMP) and ordered by (the egress port's
 * position in `rootIfaces`, the canonical port order the caller gives; next-hop address as u32). A root interface
 * address missing from `rootIfaces` (or with none given) is reported as the address text itself.
 *
 * Integer costs; no module state, no randomness. Also exported from `@netforge/engine/pure`.
 */
import { inSubnet, ipv4ToU32, maskToPrefixLen, u32ToIpv4, type Ipv4Address } from '../contracts/addr.js';
import type { PortId } from '../contracts/ids.js';
import type { OspfAreaId, OspfLsaRow, SpfTree, SpfVertex } from '../contracts/tables.js';
import type { SimTime } from '../contracts/time.js';
import { lsaAgeAt, LSA_MAX_AGE_S } from './ospf-lsa.js';

/** @since P3 The LSAs one SPF run reads. */
export interface SpfGraph {
  readonly area: OspfAreaId;
  /** Router LSAs of the area, by router id. */
  readonly routers: ReadonlyMap<Ipv4Address, OspfLsaRow>;
  /** Network LSAs of the area, by link-state id (the DR's interface address); of two with one id, the higher advertising router id as u32. */
  readonly networks: ReadonlyMap<Ipv4Address, OspfLsaRow>;
  /** AS-external LSAs, by (link-state id, advertising router) as u32. */
  readonly externals: readonly OspfLsaRow[];
}

/** @since P3 One interface of the root router: its port and its address (the data of the root's router-LSA links). */
export interface SpfRootIface {
  readonly port: PortId;
  readonly address: Ipv4Address;
}

/** @since P3 One next hop of a vertex or route: the root's egress interface and, beyond a direct network, the neighbour's address. */
export type SpfNextHop = SpfVertex['nextHops'][number];

/** @since P3 The outcome of one SPF run. */
export interface SpfResult {
  readonly tree: SpfTree;
  /** Next hops by vertex key (the same values as the tree's vertices). */
  readonly nextHops: ReadonlyMap<string, readonly SpfNextHop[]>;
  /** The egress ports in the order next hops are sorted (from `rootIfaces`). */
  readonly ifaceOrder: readonly PortId[];
  /** The root interfaces the run was given (`ospfRoutes` reaches a forwarding address on a connected network through them). */
  readonly rootIfaces: readonly SpfRootIface[];
}

/** @since P3 What happened to one link examined while a vertex was settled. */
export type SpfRelaxOutcome = 'new' | 'better' | 'equal' | 'worse' | 'settled' | 'one-way' | 'missing';

/** @since P3 A tentative vertex as a stepper frame lists it. */
export interface SpfCandidate {
  readonly key: string;
  readonly kind: 'router' | 'network';
  readonly id: Ipv4Address;
  readonly cost: number;
  readonly parent?: string;
}

/** @since P3 One frame of the [S3] stepper. */
export interface SpfStep {
  readonly settled: SpfVertex;
  /** The tentative list after the settled vertex's links were relaxed, in settle order. */
  readonly candidates: readonly SpfCandidate[];
  readonly relaxed: readonly { readonly from: string; readonly to: string; readonly cost: number; readonly outcome: SpfRelaxOutcome }[];
}

/** @since P3 One route of `ospfRoutes`. */
export interface OspfRouteEntry {
  readonly network: Ipv4Address;
  readonly prefixLen: number;
  /** Intra-area: the path cost; E2: the external metric. */
  readonly cost: number;
  /** Absent = intra-area. ([C6] 'E1' is not approved: type-1 external LSAs are not used.) */
  readonly routeType?: 'E2';
  /** E2: the cost to the ASBR or forwarding address (the tie-break between equal external metrics). */
  readonly forwardCost?: number;
  /** Ordered as the SPF orders next hops, at most `maximumPaths`. */
  readonly nextHops: readonly SpfNextHop[];
}

/** @since P3 The vertex key of a router. */
export function spfRouterKey(routerId: Ipv4Address): string {
  return `R:${routerId}`;
}
/** @since P3 The vertex key of a transit network (its DR's interface address). */
export function spfNetworkKey(drAddress: Ipv4Address): string {
  return `N:${drAddress}`;
}

function u32(a: Ipv4Address): number {
  return ipv4ToU32(a);
}

/**
 * @since P3 The LSAs of `area` an SPF run reads: router (type 1) and network (type 2) LSAs whose scope is the area,
 * and every AS-external (type 5) LSA. Copies being flushed (`maxAge`), and with `now` those whose live age reached
 * MaxAge, are left out.
 */
export function buildSpfGraph(rows: Iterable<OspfLsaRow>, area: OspfAreaId, now?: SimTime): SpfGraph {
  const routers = new Map<Ipv4Address, OspfLsaRow>();
  const networks = new Map<Ipv4Address, OspfLsaRow>();
  const externals: OspfLsaRow[] = [];
  for (const row of rows) {
    if (row.maxAge === true) continue;
    if (now !== undefined && lsaAgeAt(row, now) >= LSA_MAX_AGE_S) continue;
    if (row.type === 5) {
      if (row.scope === 'as') externals.push(row);
      continue;
    }
    if (row.scope !== area) continue;
    if (row.type === 1) {
      if (row.lsid === row.advRouter) routers.set(row.advRouter, row);
    } else {
      const prev = networks.get(row.lsid);
      if (prev === undefined || u32(row.advRouter) > u32(prev.advRouter)) networks.set(row.lsid, row);
    }
  }
  externals.sort((a, b) => u32(a.lsid) - u32(b.lsid) || u32(a.advRouter) - u32(b.advRouter));
  return { area, routers, networks, externals };
}

interface Work {
  readonly key: string;
  readonly kind: 'router' | 'network';
  readonly id: Ipv4Address;
  readonly lsa: OspfLsaRow;
  cost: number;
  parents: string[];
  hops: SpfNextHop[];
}

/** 0 when the candidate order puts `a` first … as a comparator: (cost, network before router, id u32). */
function candidateOrder(a: { cost: number; kind: 'router' | 'network'; id: Ipv4Address }, b: { cost: number; kind: 'router' | 'network'; id: Ipv4Address }): number {
  if (a.cost !== b.cost) return a.cost - b.cost;
  if (a.kind !== b.kind) return a.kind === 'network' ? -1 : 1;
  return u32(a.id) - u32(b.id);
}

function makeHopOrder(rootIfaces: readonly SpfRootIface[]): (a: SpfNextHop, b: SpfNextHop) => number {
  const rank = new Map<PortId, number>();
  rootIfaces.forEach((r, i) => {
    if (!rank.has(r.port)) rank.set(r.port, i);
  });
  return (a, b) => {
    const ra = rank.get(a.iface);
    const rb = rank.get(b.iface);
    if (ra !== rb) {
      if (ra === undefined) return 1;
      if (rb === undefined) return -1;
      return ra - rb;
    }
    if (ra === undefined && a.iface !== b.iface) return a.iface < b.iface ? -1 : 1;
    if (a.nextHop === b.nextHop) return 0;
    if (a.nextHop === undefined) return -1;
    if (b.nextHop === undefined) return 1;
    return u32(a.nextHop) - u32(b.nextHop);
  };
}

function mergeHops(into: SpfNextHop[], add: readonly SpfNextHop[], order: (a: SpfNextHop, b: SpfNextHop) => number): SpfNextHop[] {
  const out = into.slice();
  for (const h of add) if (!out.some((x) => x.iface === h.iface && x.nextHop === h.nextHop)) out.push(h);
  return out.sort(order);
}

function linksBack(w: Work, v: Work): boolean {
  if (w.kind === 'network') return (w.lsa.attached ?? []).includes(v.id);
  const want = v.kind === 'router' ? 'p2p' : 'transit';
  return (w.lsa.links ?? []).some((l) => l.kind === want && l.id === v.id);
}

function inMaskedSubnet(addr: Ipv4Address, network: Ipv4Address, mask: Ipv4Address): boolean {
  const m = u32(mask);
  return ((u32(addr) & m) >>> 0) === ((u32(network) & m) >>> 0);
}

/** The neighbour's address on the root's point-to-point link whose data (root address) is `rootData`. */
function p2pNeighbourAddress(root: OspfLsaRow, rootData: Ipv4Address, w: OspfLsaRow): Ipv4Address | undefined {
  const back = (w.links ?? []).filter((l) => l.kind === 'p2p' && l.id === root.advRouter);
  if (back.length <= 1) return back[0]?.data;
  const stub = (root.links ?? []).find((l) => l.kind === 'stub' && inMaskedSubnet(rootData, l.id, l.data));
  if (stub !== undefined) {
    const same = back.find((l) => inMaskedSubnet(l.data, stub.id, stub.data));
    if (same !== undefined) return same.data;
  }
  return back[0]!.data;
}

function snapshot(w: Work): SpfVertex {
  const v: { -readonly [K in keyof SpfVertex]: SpfVertex[K] } = { key: w.key, kind: w.kind, id: w.id, cost: w.cost, nextHops: w.hops.map((h) => ({ ...h })) };
  if (w.parents[0] !== undefined) v.parent = w.parents[0];
  return v;
}

function run(graph: SpfGraph, rootRid: Ipv4Address, rootIfaces: readonly SpfRootIface[], steps: SpfStep[] | undefined): SpfResult {
  const hopOrder = makeHopOrder(rootIfaces);
  const ifaceOf = (address: Ipv4Address): PortId => rootIfaces.find((r) => r.address === address)?.port ?? address;
  const ifaceOrder = rootIfaces.map((r) => r.port).filter((p, i, a) => a.indexOf(p) === i);
  const rootLsa = graph.routers.get(rootRid);
  const rootKey = spfRouterKey(rootRid);
  if (rootLsa === undefined) {
    const root: SpfVertex = { key: rootKey, kind: 'router', id: rootRid, cost: 0, nextHops: [] };
    steps?.push({ settled: root, candidates: [], relaxed: [] });
    return { tree: { root: rootRid, vertices: [root] }, nextHops: new Map([[rootKey, []]]), ifaceOrder, rootIfaces };
  }
  const settled = new Map<string, SpfVertex>();
  const candidates = new Map<string, Work>();
  let v: Work = { key: rootKey, kind: 'router', id: rootRid, lsa: rootLsa, cost: 0, parents: [], hops: [] };
  for (;;) {
    const vertex = snapshot(v);
    settled.set(v.key, vertex);
    const relaxed: { from: string; to: string; cost: number; outcome: SpfRelaxOutcome }[] = [];
    // the links of V, in LSA order: point-to-point and transit links of a router, attached routers of a network
    const edges: { kind: 'router' | 'network'; id: Ipv4Address; metric: number; data?: Ipv4Address }[] = [];
    if (v.kind === 'router') {
      for (const l of v.lsa.links ?? []) {
        if (l.kind === 'p2p') edges.push({ kind: 'router', id: l.id, metric: l.metric, data: l.data });
        else if (l.kind === 'transit') edges.push({ kind: 'network', id: l.id, metric: l.metric, data: l.data });
      }
    } else {
      for (const r of v.lsa.attached ?? []) edges.push({ kind: 'router', id: r, metric: 0 });
    }
    for (const e of edges) {
      const key = e.kind === 'router' ? spfRouterKey(e.id) : spfNetworkKey(e.id);
      const cost = v.cost + e.metric;
      if (key === rootKey || settled.has(key)) {
        relaxed.push({ from: v.key, to: key, cost, outcome: 'settled' });
        continue;
      }
      const lsa = e.kind === 'router' ? graph.routers.get(e.id) : graph.networks.get(e.id);
      if (lsa === undefined) {
        relaxed.push({ from: v.key, to: key, cost, outcome: 'missing' });
        continue;
      }
      const existing = candidates.get(key);
      const w: Work = existing ?? { key, kind: e.kind, id: e.id, lsa, cost, parents: [], hops: [] };
      if (!linksBack(w, v)) {
        relaxed.push({ from: v.key, to: key, cost, outcome: 'one-way' });
        continue;
      }
      // next hops W gains through V
      let via: SpfNextHop[];
      if (v.key === rootKey) {
        const iface = ifaceOf(e.data!);
        if (e.kind === 'network') via = [{ iface }];
        else {
          const nh = p2pNeighbourAddress(rootLsa, e.data!, lsa);
          via = [nh === undefined ? { iface } : { iface, nextHop: nh }];
        }
      } else if (v.kind === 'network' && e.kind === 'router') {
        const own = (lsa.links ?? []).find((l) => l.kind === 'transit' && l.id === v.id)?.data;
        via = v.hops.map((h) => (h.nextHop === undefined && own !== undefined ? { iface: h.iface, nextHop: own } : h));
      } else {
        via = v.hops;
      }
      if (existing === undefined) {
        w.hops = mergeHops([], via, hopOrder);
        w.parents = [v.key];
        candidates.set(key, w);
        relaxed.push({ from: v.key, to: key, cost, outcome: 'new' });
      } else if (cost < existing.cost) {
        existing.cost = cost;
        existing.hops = mergeHops([], via, hopOrder);
        existing.parents = [v.key];
        relaxed.push({ from: v.key, to: key, cost, outcome: 'better' });
      } else if (cost === existing.cost) {
        existing.hops = mergeHops(existing.hops, via, hopOrder);
        if (!existing.parents.includes(v.key)) existing.parents.push(v.key);
        relaxed.push({ from: v.key, to: key, cost, outcome: 'equal' });
      } else {
        relaxed.push({ from: v.key, to: key, cost, outcome: 'worse' });
      }
    }
    let next: Work | undefined;
    for (const c of candidates.values()) if (next === undefined || candidateOrder(c, next) < 0) next = c;
    if (steps !== undefined) {
      const list = [...candidates.values()].sort(candidateOrder).map((c) => {
        const out: { -readonly [K in keyof SpfCandidate]: SpfCandidate[K] } = { key: c.key, kind: c.kind, id: c.id, cost: c.cost };
        if (c.parents[0] !== undefined) out.parent = c.parents[0];
        return out;
      });
      steps.push({ settled: vertex, candidates: list, relaxed });
    }
    if (next === undefined) break;
    candidates.delete(next.key);
    v = next;
  }
  const vertices = [...settled.values()];
  return { tree: { root: rootRid, vertices }, nextHops: new Map(vertices.map((x) => [x.key, x.nextHops])), ifaceOrder, rootIfaces };
}

/**
 * @since P3 Dijkstra over `graph` from router `rootRid` (RFC 2328 §16.1): the tree in settle order, with each
 * vertex's cost, first parent and next hops. A root without a router-LSA yields a tree holding the root alone.
 */
export function runSpf(graph: SpfGraph, rootRid: Ipv4Address, rootIfaces: readonly SpfRootIface[] = []): SpfResult {
  return run(graph, rootRid, rootIfaces, undefined);
}

/** @since P3 The same run as `runSpf`, one frame per settled vertex (the [S3] stepper); the settled vertices, in order, are the tree. */
export function spfSteps(graph: SpfGraph, rootRid: Ipv4Address, rootIfaces: readonly SpfRootIface[] = []): SpfStep[] {
  const steps: SpfStep[] = [];
  run(graph, rootRid, rootIfaces, steps);
  return steps;
}

function prefixOf(address: Ipv4Address, mask: Ipv4Address): { network: Ipv4Address; prefixLen: number } | undefined {
  const len = maskToPrefixLen(mask);
  if (len === null) return undefined;
  return { network: u32ToIpv4((u32(address) & u32(mask)) >>> 0), prefixLen: len };
}

function routeKeyOf(network: Ipv4Address, prefixLen: number): string {
  return `${network}/${prefixLen}`;
}


interface RouteDraft {
  network: Ipv4Address;
  prefixLen: number;
  cost: number;
  hops: SpfNextHop[];
  routeType?: 'E2';
  forwardCost?: number;
}

/**
 * @since P3 The routes of one SPF result (RFC 2328 §16.1 stage 2, §16.4), sorted by (network as u32, prefix length):
 *   • intra-area: every transit network in the tree (its LSA's id and mask) at the network's cost, and every stub link
 *     of a router in the tree at the router's cost + the link's metric; per prefix the lowest cost, equal costs merged.
 *     A prefix the root itself is on (one of its stub links, or a transit network its router-LSA links to) is left to
 *     the connected routes, as real routers never show it as an OSPF route;
 *   • type-2 external: each AS-external LSA with the E bit from another router whose ASBR is in the tree (forwarding
 *     address 0.0.0.0: the ASBR's next hops; otherwise the longest OSPF prefix that holds the forwarding address, as
 *     RFC 2328 §16.4 step (3) looks it up in the routing table: an intra-area route (its next hops and cost) or a
 *     network the root is on (directly through the root's interface on it, the forwarding address as next hop, at
 *     that link's cost; a forwarding address that is one of the root's own addresses is not used), for a prefix with
 *     no intra-area route; per prefix the lowest metric, then the lowest forwarding cost, equal ones merged.
 * Next hops keep the SPF order and are cut at `maximumPaths` (default 4).
 */
export function ospfRoutes(graph: SpfGraph, result: SpfResult, opts: { readonly maximumPaths?: number } = {}): OspfRouteEntry[] {
  const maxPaths = Math.max(1, opts.maximumPaths ?? 4);
  const hopOrder = makeHopOrder(result.ifaceOrder.map((port) => ({ port, address: '0.0.0.0' })));
  const intra = new Map<string, RouteDraft>();
  const offer = (network: Ipv4Address, prefixLen: number, cost: number, hops: readonly SpfNextHop[]): void => {
    const key = routeKeyOf(network, prefixLen);
    const prev = intra.get(key);
    if (prev === undefined || cost < prev.cost) {
      intra.set(key, { network, prefixLen, cost, hops: mergeHops([], hops, hopOrder) });
    } else if (cost === prev.cost) {
      prev.hops = mergeHops(prev.hops, hops, hopOrder);
    }
  };
  // the prefixes the root is on: its stub links and the transit networks its router-LSA links to; each with the root's
  // egress port on it when known (its own address on a transit network, else a root interface inside the prefix, else
  // its point-to-point link inside it), for a forwarding address on a connected network (§16.4 step (3))
  const connected = new Set<string>();
  const connectedNets: { network: Ipv4Address; prefixLen: number; cost: number; iface: PortId }[] = [];
  const rootLsa = graph.routers.get(result.tree.root);
  const portOf = (address: Ipv4Address): PortId => result.rootIfaces.find((r) => r.address === address)?.port ?? address;
  for (const l of rootLsa?.links ?? []) {
    const mask = l.kind === 'stub' ? l.data : l.kind === 'transit' ? graph.networks.get(l.id)?.mask : undefined;
    const p = mask === undefined ? undefined : prefixOf(l.id, mask);
    if (p === undefined) continue;
    connected.add(routeKeyOf(p.network, p.prefixLen));
    const own =
      l.kind === 'transit'
        ? l.data
        : (result.rootIfaces.find((r) => inSubnet(r.address, p.network, p.prefixLen))?.address ??
          (rootLsa?.links ?? []).find((x) => x.kind === 'p2p' && inSubnet(x.data, p.network, p.prefixLen))?.data);
    if (own !== undefined) connectedNets.push({ network: p.network, prefixLen: p.prefixLen, cost: l.metric, iface: portOf(own) });
  }
  const ownAddress = (a: Ipv4Address): boolean =>
    result.rootIfaces.some((r) => r.address === a) || (rootLsa?.links ?? []).some((l) => l.kind !== 'stub' && l.data === a);
  for (const v of result.tree.vertices) {
    if (v.kind === 'network') {
      const lsa = graph.networks.get(v.id);
      const p = lsa?.mask === undefined ? undefined : prefixOf(v.id, lsa.mask);
      if (p !== undefined) offer(p.network, p.prefixLen, v.cost, v.nextHops);
    } else {
      const lsa = graph.routers.get(v.id);
      for (const l of lsa?.links ?? []) {
        if (l.kind !== 'stub') continue;
        const p = prefixOf(l.id, l.data);
        if (p !== undefined) offer(p.network, p.prefixLen, v.cost + l.metric, v.nextHops);
      }
    }
  }
  const routes = [...intra.entries()].filter(([key, r]) => !connected.has(key) && r.hops.length > 0).map(([, r]) => r);
  const external = new Map<string, RouteDraft>();
  const vertexOf = new Map(result.tree.vertices.map((x) => [x.key, x]));
  for (const lsa of graph.externals) {
    if (lsa.advRouter === result.tree.root || lsa.mask === undefined || lsa.external?.e2 !== true) continue;
    const asbr = vertexOf.get(spfRouterKey(lsa.advRouter));
    if (asbr === undefined) continue;
    let hops: readonly SpfNextHop[] = asbr.nextHops;
    let forwardCost = asbr.cost;
    const forward = lsa.external.forward;
    if (forward !== '0.0.0.0') {
      if (ownAddress(forward)) continue;
      let best: RouteDraft | undefined;
      for (const r of routes) {
        if (!inSubnet(forward, r.network, r.prefixLen)) continue;
        if (best === undefined || r.prefixLen > best.prefixLen) best = r;
      }
      let direct: (typeof connectedNets)[number] | undefined;
      for (const c of connectedNets) {
        if (!inSubnet(forward, c.network, c.prefixLen)) continue;
        if (direct === undefined || c.prefixLen > direct.prefixLen) direct = c;
      }
      if (direct !== undefined && (best === undefined || direct.prefixLen >= best.prefixLen)) {
        hops = [{ iface: direct.iface, nextHop: forward }];
        forwardCost = direct.cost;
      } else if (best !== undefined) {
        hops = best.hops;
        forwardCost = best.cost;
      } else continue;
    }
    if (hops.length === 0) continue;
    const p = prefixOf(lsa.lsid, lsa.mask);
    if (p === undefined) continue;
    const key = routeKeyOf(p.network, p.prefixLen);
    if (intra.has(key) || connected.has(key)) continue;
    const metric = lsa.metric ?? 0;
    const prev = external.get(key);
    if (prev === undefined || metric < prev.cost || (metric === prev.cost && forwardCost < prev.forwardCost!)) {
      external.set(key, { network: p.network, prefixLen: p.prefixLen, cost: metric, hops: mergeHops([], hops, hopOrder), routeType: 'E2', forwardCost });
    } else if (metric === prev.cost && forwardCost === prev.forwardCost) {
      prev.hops = mergeHops(prev.hops, hops, hopOrder);
    }
  }
  return [...routes, ...external.values()]
    .sort((a, b) => u32(a.network) - u32(b.network) || a.prefixLen - b.prefixLen)
    .map((r) => {
      const out: { -readonly [K in keyof OspfRouteEntry]: OspfRouteEntry[K] } = {
        network: r.network,
        prefixLen: r.prefixLen,
        cost: r.cost,
        nextHops: r.hops.slice(0, maxPaths),
      };
      if (r.routeType !== undefined) {
        out.routeType = r.routeType;
        out.forwardCost = r.forwardCost!;
      }
      return out;
    });
}
