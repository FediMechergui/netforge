/**
 * protocols/ospf/flood.ts — the flooding and acknowledgement rules (ARCHITECTURE-P3 D9, §3.1 step 6, §4.5, §13 T33;
 * RFC 2328 §13.3, §13.5; §7 W2 ospf). Pure: given an interface, its neighbours and where an LSA came from, it says
 * whether the LSA leaves on that interface, to which address, which neighbours must acknowledge it (their
 * retransmission lists) and which request-list entries it settles. No module state.
 *
 * Out of one interface `I`, for a new LSA (received on interface `R` from neighbour `S`, or originated here):
 *   1. every neighbour on `I` at Exchange or later is examined: while it is not yet Full (Exchange, Loading) and its
 *      request list holds an instance of the LSA, the request is settled when the new LSA is at least as recent
 *      (removed), and when it is the same instance or older the neighbour needs nothing (RFC §13.3 (1b));
 *   2. the sender `S` itself needs nothing;
 *   3. on a broadcast network a router that is not the DR never floods back out the interface it received the LSA on:
 *      the DR does that (§3.1 step 6: the BDR only listens, ready to take over; a DROther is only adjacent to the DR and
 *      the BDR, which both heard the LSU);
 *   4. the destination (D7, §3.1 step 6, §13 T33): point-to-point → AllSPFRouters (224.0.0.5); broadcast → 224.0.0.5
 *      from the DR, AllDRouters (224.0.0.6) from any other router, the BDR included;
 *   5. the neighbours that must acknowledge are the ones the packet reaches: every remaining neighbour when the
 *      destination is 224.0.0.5, only the DR and the BDR (the listeners of 224.0.0.6) otherwise;
 *   6. when no neighbour must acknowledge, nothing leaves on `I` (RFC §13.3 (2)) — so with the sender as its only
 *      adjacency, a DR acknowledges directly instead of re-flooding.
 * A DR re-flooding a DROther's or the BDR's LSA to 224.0.0.5 is that router's implicit acknowledgement.
 *
 * Acknowledgements (D9: direct and immediate, a listed deviation; RFC §13.5 otherwise):
 *   newer LSA, flooded back out the receiving interface  → none (the re-flood is the acknowledgement)
 *   newer LSA, not flooded back                          → direct, to the sender
 *   duplicate already on our retransmission list for the sender (an implied acknowledgement) → none
 *   any other duplicate                                  → direct
 *   MaxAge LSA with no database copy (no neighbour exchanging) → direct
 * Direct packets go to the neighbour's address on a broadcast network and to 224.0.0.5 on point-to-point networks
 * (every OSPF packet on a point-to-point network goes to AllSPFRouters, RFC 2328 §8.1).
 */
import type { Ipv4Address } from '../../contracts/addr.js';
import { OSPF_ALL_DROUTERS, OSPF_ALL_ROUTERS } from '../../contracts/pdu.js';
import type { OspfIsmState, OspfNetworkType, OspfNsmState } from '../../contracts/tables.js';
import { compareLsaInstances, type LsaInstance } from '../../core/ospf-lsa.js';
import { nsmAtLeast } from './nsm.js';

/** @since P3 One neighbour as the flooding rules see it. */
export interface FloodNeighbor {
  readonly routerId: Ipv4Address;
  readonly address: Ipv4Address;
  readonly state: OspfNsmState;
  /** The instance on its link-state request list for this LSA, if any. */
  readonly requested?: LsaInstance;
}

/** @since P3 One interface as the flooding rules see it. */
export interface FloodIface {
  readonly networkType: OspfNetworkType;
  readonly state: OspfIsmState;
  /** DR and BDR interface addresses (0.0.0.0 for none). */
  readonly dr: Ipv4Address;
  readonly bdr: Ipv4Address;
  /** Neighbours in router-id order. */
  readonly neighbors: readonly FloodNeighbor[];
}

/** @since P3 What flooding one LSA does on one interface. */
export interface FloodVerdict {
  /** The LSA leaves on this interface (in the per-dispatch update of `dst`). */
  readonly send: boolean;
  readonly dst?: Ipv4Address;
  /** Neighbours that must acknowledge it (added to their retransmission lists), router-id order. */
  readonly retransmitTo: readonly Ipv4Address[];
  /** Neighbours whose request for this LSA is settled (removed from their request lists). */
  readonly settledRequests: readonly Ipv4Address[];
}

/** @since P3 Where an LSU this interface floods goes (rule 4 of the module header). */
export function floodDestination(networkType: OspfNetworkType, state: OspfIsmState): Ipv4Address {
  if (networkType !== 'broadcast') return OSPF_ALL_ROUTERS;
  return state === 'dr' ? OSPF_ALL_ROUTERS : OSPF_ALL_DROUTERS;
}

/** @since P3 Where a packet for one neighbour goes: its address on a broadcast network, 224.0.0.5 on point-to-point. */
export function directDestination(networkType: OspfNetworkType, neighbourAddress: Ipv4Address): Ipv4Address {
  return networkType === 'broadcast' ? neighbourAddress : OSPF_ALL_ROUTERS;
}

/**
 * @since P3 Flood an LSA whose instance is `lsa` out `iface` (the module header). `from` is the neighbour it came from
 * when it arrived on this interface (absent for a self-originated LSA or one received on another interface).
 */
export function floodOut(iface: FloodIface, lsa: LsaInstance, from?: Ipv4Address): FloodVerdict {
  const settled: Ipv4Address[] = [];
  const candidates: FloodNeighbor[] = [];
  for (const n of iface.neighbors) {
    if (!nsmAtLeast(n.state, 'exchange')) continue;
    if (n.state !== 'full' && n.requested !== undefined) {
      const cmp = compareLsaInstances(lsa, n.requested);
      if (cmp < 0) continue;
      settled.push(n.routerId);
      if (cmp === 0) continue;
    }
    if (from !== undefined && n.routerId === from) continue;
    candidates.push(n);
  }
  const none: FloodVerdict = { send: false, retransmitTo: [], settledRequests: settled };
  if (from !== undefined && iface.networkType === 'broadcast' && iface.state !== 'dr') return none;
  const dst = floodDestination(iface.networkType, iface.state);
  const reached = dst === OSPF_ALL_DROUTERS ? candidates.filter((n) => n.address === iface.dr || n.address === iface.bdr) : candidates;
  if (reached.length === 0) return none;
  return { send: true, dst, retransmitTo: reached.map((n) => n.routerId), settledRequests: settled };
}

/** @since P3 How a received LSA is acknowledged (D9: direct and immediate). */
export type OspfAckCase = 'newer-flooded-back' | 'newer' | 'duplicate-implied' | 'duplicate' | 'maxage-unknown';

/** @since P3 Whether to send a direct acknowledgement in `c` (the table of the module header). */
export function ackDirectly(c: OspfAckCase): boolean {
  return c === 'newer' || c === 'duplicate' || c === 'maxage-unknown';
}
