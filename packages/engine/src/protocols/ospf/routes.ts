/**
 * protocols/ospf/routes.ts — from the link-state database to one `ipv4.routes` batch (ARCHITECTURE-P3 D8, D10, D11,
 * §3.2, §4.5; §7 W2 ospf). Pure: it calls the one SPF of core/ospf-spf.ts (D10) per area and turns the routes into
 * `RouteRow`s. No module state.
 *
 *   • Per area: `buildSpfGraph(rows, area, now)` → `runSpf(graph, routerId, rootIfaces)` → `ospfRoutes(graph, result,
 *     {maximumPaths})`; the root interfaces are the area's OSPF interfaces with an address, in canonical port order, so
 *     equal-cost next hops are ordered (egress port canonical order, next hop u32, §4.5).
 *   • Across areas (P3a computes intra-area and E2 routes only: [S4] is not approved): per prefix, an intra-area route
 *     beats an E2 one; then the lower cost (E2: the lower external metric, then the lower forwarding cost); equal ones
 *     merge their next hops (SPF order, cut at `maximum-paths`).
 *   • Rows: one `RouteRow` per next hop, rows of one prefix adjacent and in path order (D8: they are equal-cost paths),
 *     prefixes in key order (network u32, prefix length): source 'O', AD 110, metric = the route cost (E2: the external
 *     metric), `routeType: 'E2'` on external routes, `isDefault` on 0.0.0.0/0, `iface` the egress port and `nextHop` the
 *     neighbour's address when the SPF gives one.
 */
import { ipv4ToU32, type Ipv4Address } from '../../contracts/addr.js';
// (SpfRootIface and SpfNextHop are core/ospf-spf.ts's types; the daemon imports them from there.)
import { AD_OSPF, routeKey, type OspfAreaId, type OspfLsaRow, type RouteRow, type SpfTree } from '../../contracts/tables.js';
import type { SimTime } from '../../contracts/time.js';
import { buildSpfGraph, ospfRoutes, runSpf, type OspfRouteEntry, type SpfNextHop, type SpfRootIface } from '../../core/ospf-spf.js';

/** @since P3 One area to compute: its id and the router's interfaces in it (canonical port order). */
export interface OspfAreaRoot {
  readonly area: OspfAreaId;
  readonly rootIfaces: readonly SpfRootIface[];
}

/** @since P3 The outcome of one computation: the batch rows, the routes behind them and the tree of each area. */
export interface OspfRouteComputation {
  readonly rows: RouteRow[];
  readonly routes: OspfRouteEntry[];
  readonly trees: { area: OspfAreaId; tree: SpfTree }[];
}

function better(a: OspfRouteEntry, b: OspfRouteEntry): number {
  const ea = a.routeType === 'E2' ? 1 : 0;
  const eb = b.routeType === 'E2' ? 1 : 0;
  if (ea !== eb) return ea - eb;
  if (a.cost !== b.cost) return a.cost - b.cost;
  return (a.forwardCost ?? 0) - (b.forwardCost ?? 0);
}

function mergeHops(a: readonly SpfNextHop[], b: readonly SpfNextHop[], max: number): SpfNextHop[] {
  const out = a.slice();
  for (const h of b) if (!out.some((x) => x.iface === h.iface && x.nextHop === h.nextHop)) out.push(h);
  return out.slice(0, max);
}

/**
 * @since P3 Run the SPF of every area over `lsdb` from `routerId` and merge the routes (the module header). Areas are
 * computed in the order given; the trees keep that order.
 */
export function computeOspfRoutes(
  lsdb: readonly OspfLsaRow[],
  routerId: Ipv4Address,
  areas: readonly OspfAreaRoot[],
  opts: { readonly maximumPaths: number; readonly now: SimTime },
): OspfRouteComputation {
  const trees: { area: OspfAreaId; tree: SpfTree }[] = [];
  const best = new Map<string, OspfRouteEntry>();
  for (const a of areas) {
    const graph = buildSpfGraph(lsdb, a.area, opts.now);
    const result = runSpf(graph, routerId, a.rootIfaces);
    trees.push({ area: a.area, tree: result.tree });
    for (const r of ospfRoutes(graph, result, { maximumPaths: opts.maximumPaths })) {
      const key = routeKey(r.network, r.prefixLen);
      const prev = best.get(key);
      if (prev === undefined) {
        best.set(key, r);
        continue;
      }
      const cmp = better(r, prev);
      if (cmp < 0) best.set(key, r);
      else if (cmp === 0) best.set(key, { ...prev, nextHops: mergeHops(prev.nextHops, r.nextHops, opts.maximumPaths) });
    }
  }
  const routes = [...best.values()].sort((x, y) => ipv4ToU32(x.network) - ipv4ToU32(y.network) || x.prefixLen - y.prefixLen);
  return { rows: ospfRouteRows(routes, opts.now), routes, trees };
}

/** @since P3 The `ipv4.routes` rows of `routes` (the module header), in the order given. */
export function ospfRouteRows(routes: readonly OspfRouteEntry[], now: SimTime): RouteRow[] {
  const out: RouteRow[] = [];
  for (const r of routes) {
    for (const h of r.nextHops) {
      const row: RouteRow = {
        key: routeKey(r.network, r.prefixLen),
        network: r.network,
        prefixLen: r.prefixLen,
        source: 'O',
        ad: AD_OSPF,
        metric: r.cost,
        iface: h.iface,
        updatedAt: now,
      };
      if (h.nextHop !== undefined) row.nextHop = h.nextHop;
      if (r.routeType === 'E2') row.routeType = 'E2';
      if (r.prefixLen === 0 && r.network === '0.0.0.0') row.isDefault = true;
      out.push(row);
    }
  }
  return out;
}

/** @since P3 'O 10.3.0.0/24 [110/3] via 10.0.12.2' — one row in `ip ospf spf` lines. */
export function ospfRouteText(r: Pick<RouteRow, 'network' | 'prefixLen' | 'metric' | 'routeType' | 'nextHop' | 'iface'>): string {
  const code = r.routeType === 'E2' ? (r.prefixLen === 0 ? 'O*E2' : 'O E2') : 'O';
  return `${code} ${r.network}/${r.prefixLen} [${AD_OSPF}/${r.metric}] via ${r.nextHop ?? r.iface ?? '?'}`;
}
