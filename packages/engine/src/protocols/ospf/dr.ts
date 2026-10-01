/**
 * protocols/ospf/dr.ts — designated router election and the hello fields that trigger it (ARCHITECTURE-P3 D9, §3.1
 * steps 3, 4 and 7, §4.5; RFC 2328 §9.4, §10.4, §10.5; §7 W1 ospf). Pure; no module state.
 *
 * Election (`electDesignatedRouter`, RFC 2328 §9.4), run by the calculating router over itself and its neighbours in
 * state 2-Way or higher, keeping those with priority > 0. Each candidate carries the DR and BDR it declares (interface
 * addresses, 0.0.0.0 for none; the calculating router declares its current values):
 *   (2) BDR: among the candidates not declaring themselves DR, the best of those declaring themselves BDR, else the
 *       best of all of them;
 *   (3) DR: the best of the candidates declaring themselves DR, else the new BDR;
 *   (4) when the calculating router has newly become, or stopped being, DR or BDR, steps 2 and 3 run once more with
 *       its own declarations set to their results (so it never declares itself both);
 *   (5) its interface state becomes DR, Backup or DROther.
 * "Best" = the highest (priority, router id as u32). The election is non-preemptive: a later router with a higher
 * router id finds the DR and BDR declaring themselves and stays DROther (§3.1 step 7).
 *
 * Hello events (`drEventsFromHello`, RFC 2328 §10.5): a neighbour declaring itself DR with BDR 0.0.0.0, or declaring
 * itself BDR, is BackupSeen while the interface is Waiting; otherwise a neighbour that starts or stops declaring
 * itself DR or BDR, or changes its priority, is a NeighborChange. So a DR declaring itself with a BDR present is not
 * BackupSeen (§3.1 step 7: the BackupSeen comes from the BDR's reply). As in RFC 2328 §10.5, the daemon records every
 * hello's priority, DR and BDR on the neighbour (the `before` of the next call) but schedules these events only for a
 * hello that lists this router (2-WayReceived): processing stops at 1-WayReceived.
 */
import { ipv4ToU32, type Ipv4Address } from '../../contracts/addr.js';
import type { OspfIsmState, OspfNetworkType } from '../../contracts/tables.js';
import type { OspfIsmEvent } from './ism.js';

/** @since P3 "No DR / BDR" in hellos and rows. */
export const OSPF_NO_DR: Ipv4Address = '0.0.0.0';

/** @since P3 One router in an election: its router id, interface address, priority and what it declares. */
export interface OspfDrCandidate {
  readonly routerId: Ipv4Address;
  readonly address: Ipv4Address;
  readonly priority: number;
  /** The DR it declares (an interface address, 0.0.0.0 for none). */
  readonly dr: Ipv4Address;
  /** The BDR it declares. */
  readonly bdr: Ipv4Address;
}

/** @since P3 The result of one election, from the calculating router's point of view. */
export interface OspfDrElection {
  /** DR interface address, 0.0.0.0 for none. */
  readonly dr: Ipv4Address;
  readonly drRouterId?: Ipv4Address;
  /** BDR interface address, 0.0.0.0 for none. */
  readonly bdr: Ipv4Address;
  readonly bdrRouterId?: Ipv4Address;
  /** The calculating router's new interface state. */
  readonly state: 'dr' | 'backup' | 'drother';
  /** True when step 4 ran steps 2 and 3 again. */
  readonly reran: boolean;
}

function better(a: OspfDrCandidate, b: OspfDrCandidate): boolean {
  if (a.priority !== b.priority) return a.priority > b.priority;
  return ipv4ToU32(a.routerId) > ipv4ToU32(b.routerId);
}

function best(list: readonly OspfDrCandidate[]): OspfDrCandidate | undefined {
  let out: OspfDrCandidate | undefined;
  for (const c of list) if (out === undefined || better(c, out)) out = c;
  return out;
}

function stepsTwoThree(eligible: readonly OspfDrCandidate[]): { dr?: OspfDrCandidate; bdr?: OspfDrCandidate } {
  const notDr = eligible.filter((c) => c.dr !== c.address);
  const declaredBdr = notDr.filter((c) => c.bdr === c.address);
  const bdr = best(declaredBdr.length > 0 ? declaredBdr : notDr);
  const declaredDr = eligible.filter((c) => c.dr === c.address);
  const dr = declaredDr.length > 0 ? best(declaredDr) : bdr;
  return { ...(dr === undefined ? {} : { dr }), ...(bdr === undefined ? {} : { bdr }) };
}

/**
 * @since P3 RFC 2328 §9.4 run by `self` over `neighbors` (those at 2-Way or higher; ineligible ones, priority 0, are
 * left out here, as is `self` when its priority is 0).
 */
export function electDesignatedRouter(self: OspfDrCandidate, neighbors: readonly OspfDrCandidate[]): OspfDrElection {
  const eligibleOf = (me: OspfDrCandidate): OspfDrCandidate[] => [me, ...neighbors].filter((c) => c.priority > 0);
  const wasDr = self.dr === self.address;
  const wasBdr = self.bdr === self.address;
  let r = stepsTwoThree(eligibleOf(self));
  const isDr = r.dr?.routerId === self.routerId;
  const isBdr = r.bdr?.routerId === self.routerId;
  let reran = false;
  if (isDr !== wasDr || isBdr !== wasBdr) {
    const me: OspfDrCandidate = { ...self, dr: r.dr?.address ?? OSPF_NO_DR, bdr: r.bdr?.address ?? OSPF_NO_DR };
    r = stepsTwoThree(eligibleOf(me));
    reran = true;
  }
  const state = r.dr?.routerId === self.routerId ? 'dr' : r.bdr?.routerId === self.routerId ? 'backup' : 'drother';
  return {
    dr: r.dr?.address ?? OSPF_NO_DR,
    ...(r.dr === undefined ? {} : { drRouterId: r.dr.routerId }),
    bdr: r.bdr?.address ?? OSPF_NO_DR,
    ...(r.bdr === undefined ? {} : { bdrRouterId: r.bdr.routerId }),
    state,
    reran,
  };
}

/** @since P3 What a neighbour declared in its previous hello (absent for a neighbour heard for the first time). */
export interface OspfHelloDeclaration {
  readonly dr: Ipv4Address;
  readonly bdr: Ipv4Address;
  readonly priority: number;
}

/**
 * @since P3 The interface events a hello from the neighbour at `address` schedules (RFC 2328 §10.5), in order, without
 * duplicates: 'backup-seen' or 'neighbor-change'. `before` absent = a new neighbour (declared nothing before; its
 * priority is not a change).
 */
export function drEventsFromHello(
  ifaceState: OspfIsmState,
  before: OspfHelloDeclaration | undefined,
  hello: { readonly address: Ipv4Address } & OspfHelloDeclaration,
): OspfIsmEvent[] {
  const out: OspfIsmEvent[] = [];
  const add = (e: OspfIsmEvent): void => {
    if (!out.includes(e)) out.push(e);
  };
  const waiting = ifaceState === 'waiting';
  const prevDr = before?.dr ?? OSPF_NO_DR;
  const prevBdr = before?.bdr ?? OSPF_NO_DR;
  const declaresDr = hello.dr === hello.address;
  const declaredDr = prevDr === hello.address;
  if (declaresDr && hello.bdr === OSPF_NO_DR && waiting) add('backup-seen');
  else if (declaresDr !== declaredDr) add('neighbor-change');
  const declaresBdr = hello.bdr === hello.address;
  const declaredBdr = prevBdr === hello.address;
  if (declaresBdr && waiting) add('backup-seen');
  else if (declaresBdr !== declaredBdr) add('neighbor-change');
  if (before !== undefined && before.priority !== hello.priority) add('neighbor-change');
  return out;
}

/**
 * @since P3 Whether the router forms an adjacency with a neighbour (RFC 2328 §10.4): always on point-to-point
 * networks; on broadcast networks when the router itself or the neighbour is the DR or the BDR (by interface address).
 */
export function ospfAdjacencyOk(
  networkType: OspfNetworkType,
  iface: { readonly address: Ipv4Address; readonly dr: Ipv4Address; readonly bdr: Ipv4Address },
  neighbourAddress: Ipv4Address,
): boolean {
  if (networkType === 'point-to-point') return true;
  if (networkType !== 'broadcast') return false;
  return iface.dr === iface.address || iface.bdr === iface.address || iface.dr === neighbourAddress || iface.bdr === neighbourAddress;
}
