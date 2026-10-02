/**
 * protocols/ospf/originate.ts — the LSAs a router originates and when (ARCHITECTURE-P3 D7, D9, §3.1 steps 1 and 6,
 * §3.2, §4.2, §4.5; RFC 2328 §12.4; §7 W2 ospf). Pure; no module state.
 *
 * Router-LSA of an area (RFC 2328 §12.4.1), one link list over the area's interfaces in canonical port order:
 *   Down                         nothing;
 *   loopback (network type)      a host stub: id = the address, data = 255.255.255.255, metric = the cost (D7: a /32);
 *   point-to-point               a p2p link per Full neighbour (id = its router id, data = the own address), then a
 *                                stub for the subnet (id = network, data = mask) — a point-to-point loopback or a
 *                                passive interface has no neighbour and keeps only the stub;
 *   broadcast                    Waiting → a stub for the subnet (no DR yet, §3.1 step 1); else a transit link (id = the
 *                                DR's address, data = the own address) when this router is DR with a Full neighbour or
 *                                is Full with the DR; otherwise a stub (§3.1 step 6).
 *   Flags: B when the router has interfaces in more than one area (no summaries are built: [S4] is not approved), E while
 *   it originates an AS-external LSA (`default-information originate`), V never.
 * Network-LSA (§12.4.2): by the DR of a broadcast segment with at least one Full neighbour; id = the DR's interface
 *   address, mask = the interface's, attached = the DR's router id, then its Full neighbours in router-id order (§3.1
 *   step 6: {2.2.2.2, 1.1.1.1}).
 * AS-external default (`default-information originate`, D8): 0.0.0.0/0, type 2 (E2), metric 1, forwarding address
 *   0.0.0.0, tag 0 — while the routing table holds a default route from another source, or always with `always`.
 *
 * Timing (D9, §4.2): `lsaGenAt` — an LSA's first origination is immediate, later ones wait until MinLSInterval (5 s)
 * after the previous one; the daemon arms `lsa-gen:<key>` for the deferred ones, and its `spf` runs every due
 * `lsa-gen` first.
 */
import { networkOf, prefixLenToMask, type Ipv4Address } from '../../contracts/addr.js';
import type { PortId } from '../../contracts/ids.js';
import type { OspfAreaId, OspfIsmState, OspfNetworkType, OspfRouterLink } from '../../contracts/tables.js';
import type { SimTime } from '../../contracts/time.js';
import { LSA_MIN_INTERVAL_NS } from '../../core/ospf-lsa.js';
import { OSPF_OPTIONS, type OspfLsaBody } from './lsdb.js';

/** @since P3 One OSPF interface as the router-LSA sees it. */
export interface OriginIface {
  readonly port: PortId;
  readonly area: OspfAreaId;
  readonly networkType: OspfNetworkType;
  readonly state: OspfIsmState;
  readonly address?: Ipv4Address;
  readonly prefixLen?: number;
  readonly cost: number;
  /** The DR's interface address (0.0.0.0 for none). */
  readonly dr: Ipv4Address;
  /** Neighbours in state Full, router-id order. */
  readonly fullNeighbors: readonly { readonly routerId: Ipv4Address; readonly address: Ipv4Address }[];
}

/** @since P3 The metric of the AS-external default route (`O*E2 0.0.0.0/0 [110/1]`). */
export const OSPF_DEFAULT_EXTERNAL_METRIC = 1;

function stubOf(i: OriginIface): OspfRouterLink | undefined {
  if (i.address === undefined || i.prefixLen === undefined) return undefined;
  return { kind: 'stub', id: networkOf(i.address, i.prefixLen), data: prefixLenToMask(i.prefixLen), metric: i.cost };
}

/** @since P3 The links one interface adds to its area's router-LSA (the module header). */
export function routerLinksOf(i: OriginIface): OspfRouterLink[] {
  if (i.state === 'down' || i.address === undefined) return [];
  if (i.networkType === 'loopback') return [{ kind: 'stub', id: i.address, data: '255.255.255.255', metric: i.cost }];
  if (i.networkType === 'point-to-point') {
    const out: OspfRouterLink[] = i.fullNeighbors.map((n) => ({ kind: 'p2p', id: n.routerId, data: i.address!, metric: i.cost }));
    const stub = stubOf(i);
    if (stub !== undefined) out.push(stub);
    return out;
  }
  if (i.state !== 'waiting') {
    const isDr = i.dr === i.address;
    const transit = isDr ? i.fullNeighbors.length > 0 : i.fullNeighbors.some((n) => n.address === i.dr);
    if (transit) return [{ kind: 'transit', id: i.dr, data: i.address, metric: i.cost }];
  }
  const stub = stubOf(i);
  return stub === undefined ? [] : [stub];
}

/** @since P3 The body of the router-LSA of `area` over `ifaces` (canonical port order; others' areas are skipped). */
export function routerLsaBody(
  routerId: Ipv4Address,
  area: OspfAreaId,
  ifaces: readonly OriginIface[],
  flags: { readonly areaBorder: boolean; readonly asbr: boolean },
): OspfLsaBody & { links: OspfRouterLink[] } {
  const links: OspfRouterLink[] = [];
  for (const i of ifaces) if (i.area === area) links.push(...routerLinksOf(i));
  return {
    type: 1,
    lsid: routerId,
    advRouter: routerId,
    options: OSPF_OPTIONS,
    flags: { b: flags.areaBorder, e: flags.asbr, v: false },
    links,
  };
}

/** @since P3 The network-LSA a DR originates for `iface`, or undefined when it originates none (the module header). */
export function networkLsaBody(routerId: Ipv4Address, iface: OriginIface): OspfLsaBody | undefined {
  if (iface.networkType !== 'broadcast' || iface.state !== 'dr' || iface.address === undefined || iface.prefixLen === undefined) return undefined;
  if (iface.dr !== iface.address || iface.fullNeighbors.length === 0) return undefined;
  return {
    type: 2,
    lsid: iface.address,
    advRouter: routerId,
    options: OSPF_OPTIONS,
    mask: prefixLenToMask(iface.prefixLen),
    attached: [routerId, ...iface.fullNeighbors.map((n) => n.routerId)],
  };
}

/** @since P3 The AS-external default LSA of `default-information originate` (the module header). */
export function defaultExternalBody(routerId: Ipv4Address): OspfLsaBody {
  return {
    type: 5,
    lsid: '0.0.0.0',
    advRouter: routerId,
    options: OSPF_OPTIONS,
    mask: '0.0.0.0',
    metric: OSPF_DEFAULT_EXTERNAL_METRIC,
    external: { e2: true, forward: '0.0.0.0', tag: 0 },
  };
}

/**
 * @since P3 When an LSA may next be originated (D9 MinLSInterval): now for a first origination, else not before 5 s
 * after the previous one.
 */
export function lsaGenAt(lastOriginatedAt: SimTime | undefined, now: SimTime): SimTime {
  if (lastOriginatedAt === undefined) return now;
  return Math.max(now, lastOriginatedAt + LSA_MIN_INTERVAL_NS);
}
