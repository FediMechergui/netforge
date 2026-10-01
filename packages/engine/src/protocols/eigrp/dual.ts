/**
 * protocols/eigrp/dual.ts — DUAL per destination [C1] (ARCHITECTURE-P3 D26, §2.16, §3.12, §4.5; §7 W1 eigrp).
 *
 * One `DualEntry` per prefix holds each neighbour's path (its reported distance RD and the metric through it, computed
 * by the daemon with metric.ts), the feasible distance FD, the successors and, while active, the neighbours whose
 * replies are pending. `dualStep` applies one input and says what the daemon must do: offer the successors again
 * (one `ipv4.routes` batch per change), send updates, queries and replies, and record the `eigrp-route` transition.
 *
 * The rules (D26):
 *   - Feasibility: a neighbour is a feasible successor when its RD < FD. An old successor whose metric did not rise
 *     stays eligible.
 *   - Passive: the successors are the minimum-metric feasible paths (equal cost only, up to `maximum-paths`, ordered
 *     by metric, next hop u32, then interface, §4.5), and FD becomes their metric (as the verification commands show
 *     it). A better path lowers FD; the first path of an unreachable prefix is always feasible (FD is infinite).
 *   - Local computation: when a successor is lost or its metric rises and a feasible successor exists, the route stays
 *     passive in the same step; if a path that was not a successor is promoted, the transition is passive → passive
 *     with the cause `feasible successor promoted`. No query is sent.
 *   - Active: with no feasible successor the route goes active: this router's distance becomes the metric through a
 *     surviving old successor (infinite when none survives), a query carrying it goes to every up neighbour (except
 *     the neighbour whose query started the computation), and the route returns to passive when every reply is in; a
 *     neighbour that goes down counts as a reply. Leaving active, every reachable path is eligible (no feasibility
 *     condition): the minimum-metric paths become the successors and FD their metric. The reply owed to the neighbour
 *     whose query started the computation is sent then. While active, updates are recorded without a recomputation
 *     and a query from any other neighbour is answered at once with the current distance.
 *   - Split horizon: a route is not advertised out an interface that carries one of its successors
 *     (`dualSplitHorizon`); a reply or query sent out such an interface carries the infinite metric
 *     (`dualReplyDistance`). Poison reverse: when a successor moves to an interface that carried none, and this router
 *     had advertised a finite distance there, the outcome names that interface in `poison`, and the daemon sends one
 *     update with the infinite metric there (§3.12 step 3). After an active phase the queries already carried the
 *     active distance, so a route regained from infinity poisons nothing.
 *   - A directly connected network (`connected`) is its own route: FD and the distance are the interface metric, no
 *     successor is offered to ipv4 (it installs C), and split horizon never applies to it.
 * Paths with the infinite metric are not kept: an update, query or reply carrying it removes that neighbour's path.
 * Stuck-in-active timers (90 s SIA query, reset at 180 s) are the daemon's; a reset reaches DUAL as `neighbor-down`.
 *
 * Pure: no module state, no randomness, integer comparisons only.
 */
import type { Ipv4Address } from '../../contracts/addr.js';
import { ipv4ToU32 } from '../../contracts/addr.js';
import type { PortId } from '../../contracts/ids.js';
import { EIGRP_INFINITY } from '../../contracts/pdu.js';
import type { EigrpPath, EigrpTopologyRow } from '../../contracts/tables.js';
import type { SimTime } from '../../contracts/time.js';

/** A neighbour as DUAL knows it. */
export interface DualNeighbor {
  readonly iface: PortId;
  readonly address: Ipv4Address;
}

/** The `eigrp-neighbors` key of a neighbour (`${iface}|${address}`). */
export function dualNeighborKey(n: DualNeighbor): string {
  return `${n.iface}|${n.address}`;
}

/** DUAL's state for one destination. */
export interface DualEntry {
  readonly prefix: string;
  readonly state: 'passive' | 'active';
  /** Feasible distance; `EIGRP_INFINITY` while the prefix is unreachable. */
  readonly fd: number;
  /** The distance this router advertises (its reported distance to its neighbours). */
  readonly distance: number;
  /** Every reachable path, one per neighbour, in path order. */
  readonly paths: readonly EigrpPath[];
  /** The successors, in path order (none for a connected network, and none while unreachable). */
  readonly successors: readonly EigrpPath[];
  /** A network directly connected on `iface`, with that interface's metric. */
  readonly connected?: { readonly iface: PortId; readonly metric: number };
  /** Active only: the neighbours whose replies are pending, in query order. */
  readonly waiting: readonly DualNeighbor[];
  /** Active only: the neighbour whose query started the computation (it is answered on return to passive). */
  readonly replyTo?: DualNeighbor;
}

/** The daemon's context for a step. */
export interface DualContext {
  /** `maximum-paths` (1–4). */
  readonly maximumPaths: number;
  /** Every neighbour that is up, in neighbour order (§4.5: interface canonical order, then address u32). */
  readonly neighbors: readonly DualNeighbor[];
}

/** One input for a destination. `rd` and `metric` are `EIGRP_INFINITY` for an unreachable route. */
export type DualInput =
  | { readonly kind: 'update'; readonly from: DualNeighbor; readonly rd: number; readonly metric: number }
  | { readonly kind: 'query'; readonly from: DualNeighbor; readonly rd: number; readonly metric: number }
  | { readonly kind: 'reply'; readonly from: DualNeighbor; readonly rd: number; readonly metric: number }
  | { readonly kind: 'neighbor-down'; readonly neighbor: DualNeighbor }
  | { readonly kind: 'connected'; readonly iface: PortId; readonly metric: number }
  | { readonly kind: 'connected-down' }
  /** Re-select under a changed `maximum-paths` (no path changed). */
  | { readonly kind: 'recompute' };

/** The `eigrp-route` causes (original wording). */
export const DUAL_CAUSE = Object.freeze({
  promoted: 'feasible successor promoted',
  active: 'no feasible successor: querying neighbours',
  replies: 'all replies received',
  connected: 'network became directly connected',
});

/** What one step does. */
export interface DualOutcome {
  readonly entry: DualEntry;
  /** The `eigrp-route` transition, when there is one. */
  readonly transition?: { readonly from: 'passive' | 'active'; readonly to: 'passive' | 'active'; readonly cause: string };
  /** The successors (next hops or metric) changed: offer the owner's routes again. */
  readonly routesChanged: boolean;
  /** This router's distance changed: send updates (split horizon applies). */
  readonly distanceChanged: boolean;
  /** Send a query carrying `entry.distance` (infinite out a successor's interface) to each, in order. */
  readonly queries: readonly DualNeighbor[];
  /** Replies to send now. */
  readonly replies: readonly { readonly to: DualNeighbor; readonly distance: number }[];
  /** Interfaces that now carry a successor and did not: one update with the infinite metric out each (poison reverse). */
  readonly poison: readonly PortId[];
}

/** A destination nobody reaches yet: passive, FD infinite. */
export function dualEntry(prefix: string): DualEntry {
  return { prefix, state: 'passive', fd: EIGRP_INFINITY, distance: EIGRP_INFINITY, paths: [], successors: [], waiting: [] };
}

const sameNbr = (a: { iface: PortId; nextHop?: Ipv4Address; address?: Ipv4Address }, b: { iface: PortId; nextHop?: Ipv4Address; address?: Ipv4Address }): boolean =>
  a.iface === b.iface && (a.nextHop ?? a.address) === (b.nextHop ?? b.address);

/** Path order (§4.5): metric, next hop u32, interface. */
export function dualPathOrder(a: EigrpPath, b: EigrpPath): number {
  if (a.metric !== b.metric) return a.metric < b.metric ? -1 : 1;
  const na = ipv4ToU32(a.nextHop);
  const nb = ipv4ToU32(b.nextHop);
  if (na !== nb) return na < nb ? -1 : 1;
  return a.iface < b.iface ? -1 : a.iface > b.iface ? 1 : 0;
}

function withPath(paths: readonly EigrpPath[], from: DualNeighbor, rd: number, metric: number): readonly EigrpPath[] {
  const rest = paths.filter((p) => !sameNbr(p, from));
  if (metric >= EIGRP_INFINITY) return rest;
  return [...rest, { nextHop: from.address, iface: from.iface, metric, rd }].sort(dualPathOrder);
}

function withoutNbr<T extends { iface: PortId }>(list: readonly T[], n: DualNeighbor): readonly T[] {
  return list.filter((x) => !sameNbr(x, n));
}

function bestOf(paths: readonly EigrpPath[], maximumPaths: number): readonly EigrpPath[] {
  if (paths.length === 0) return [];
  const m = paths.reduce((acc, p) => (p.metric < acc ? p.metric : acc), EIGRP_INFINITY);
  return paths.filter((p) => p.metric === m).sort(dualPathOrder).slice(0, Math.max(1, maximumPaths));
}

/** Whether `iface` carries a successor of `entry` (split horizon: the route is not advertised there). */
export function dualSplitHorizon(entry: DualEntry, iface: PortId): boolean {
  return entry.connected === undefined && entry.successors.some((s) => s.iface === iface);
}

/** The distance a reply or query out `iface` carries: infinite out a successor's interface, else `entry.distance`. */
export function dualReplyDistance(entry: DualEntry, iface: PortId): number {
  return dualSplitHorizon(entry, iface) ? EIGRP_INFINITY : entry.distance;
}

/** Whether a passive entry holds nothing (no path, no connected network): the daemon may forget it. */
export function dualIsEmpty(entry: DualEntry): boolean {
  return entry.state === 'passive' && entry.connected === undefined && entry.paths.length === 0 && entry.successors.length === 0;
}

const sameSuccessors = (a: readonly EigrpPath[], b: readonly EigrpPath[]): boolean =>
  a.length === b.length && a.every((p, i) => sameNbr(p, b[i]!) && p.metric === b[i]!.metric && p.rd === b[i]!.rd);

/**
 * Poison reverse: an interface that now carries a successor and did not, where this router had advertised a finite
 * distance (the route was reachable before the step and the interface was not split-horizoned). A route learned for
 * the first time, or regained after an active phase whose queries already carried the infinite metric, poisons
 * nothing.
 */
function poisonOf(before: DualEntry, entry: DualEntry): PortId[] {
  const poison: PortId[] = [];
  if (before.distance >= EIGRP_INFINITY) return poison;
  const oldIfaces = new Set(before.connected !== undefined ? [] : before.successors.map((s) => s.iface));
  for (const s of entry.successors) if (!oldIfaces.has(s.iface) && !poison.includes(s.iface)) poison.push(s.iface);
  return poison;
}

function outcome(before: DualEntry, entry: DualEntry, extra: Pick<DualOutcome, 'transition' | 'queries' | 'replies'>): DualOutcome {
  const poison = poisonOf(before, entry);
  return {
    entry,
    ...(extra.transition !== undefined ? { transition: extra.transition } : {}),
    routesChanged: !sameSuccessors(before.successors, entry.successors),
    distanceChanged: before.distance !== entry.distance,
    queries: extra.queries,
    replies: extra.replies,
    poison,
  };
}

/** Leave (or skip) the active phase: every reachable path eligible, no feasibility condition. */
function settle(e: DualEntry, ctx: DualContext): DualEntry {
  const base = { prefix: e.prefix, state: 'passive' as const, paths: e.paths, waiting: [] as readonly DualNeighbor[] };
  if (e.connected !== undefined) return { ...base, connected: e.connected, fd: e.connected.metric, distance: e.connected.metric, successors: [] };
  const succ = bestOf(e.paths, ctx.maximumPaths);
  const m = succ.length > 0 ? succ[0]!.metric : EIGRP_INFINITY;
  return { ...base, fd: m, distance: m, successors: succ };
}

/** Passive evaluation after the paths (or the connected network) of `next` changed; `old` is the entry before. */
function evaluatePassive(old: DualEntry, next: DualEntry, ctx: DualContext, querier: DualNeighbor | undefined): DualOutcome {
  const replyNow = (e: DualEntry): DualOutcome['replies'] => (querier !== undefined ? [{ to: querier, distance: dualReplyDistance(e, querier.iface) }] : []);
  if (next.connected !== undefined) {
    const e = settle(next, ctx);
    return outcome(old, e, { queries: [], replies: replyNow(e) });
  }
  const oldSucc = old.successors;
  const retained = (p: EigrpPath): boolean => oldSucc.some((s) => sameNbr(s, p)) && p.metric <= old.fd;
  const lostOrRose = old.connected !== undefined || oldSucc.some((s) => !next.paths.some((p) => sameNbr(p, s) && p.metric <= s.metric));
  const feasible = next.paths.filter((p) => p.rd < old.fd || retained(p));
  if (feasible.length > 0) {
    const succ = bestOf(feasible, ctx.maximumPaths);
    const m = succ[0]!.metric;
    const e: DualEntry = { ...next, state: 'passive', fd: m, distance: m, successors: succ, waiting: [] };
    const promoted = lostOrRose && succ.some((p) => !oldSucc.some((s) => sameNbr(s, p)));
    return outcome(old, e, {
      ...(promoted ? { transition: { from: 'passive', to: 'passive', cause: DUAL_CAUSE.promoted } } : {}),
      queries: [],
      replies: replyNow(e),
    });
  }
  // No feasible path. A prefix that had no route stays unreachable; a lost route goes active.
  if (oldSucc.length === 0 && old.connected === undefined) {
    const e: DualEntry = { ...next, state: 'passive', fd: EIGRP_INFINITY, distance: EIGRP_INFINITY, successors: [], waiting: [] };
    return outcome(old, e, { queries: [], replies: replyNow(e) });
  }
  const targets = ctx.neighbors.filter((n) => querier === undefined || !sameNbr(n, querier));
  if (targets.length === 0) {
    const e = settle(next, ctx);
    return outcome(old, e, { queries: [], replies: replyNow(e) });
  }
  const survivors = next.paths.filter((p) => oldSucc.some((s) => sameNbr(s, p)));
  const distance = survivors.length > 0 ? survivors[0]!.metric : EIGRP_INFINITY;
  const e: DualEntry = {
    prefix: next.prefix,
    state: 'active',
    fd: old.fd,
    distance,
    paths: next.paths,
    successors: survivors,
    waiting: targets,
    ...(querier !== undefined ? { replyTo: querier } : {}),
  };
  return outcome(old, e, { transition: { from: 'passive', to: 'active', cause: DUAL_CAUSE.active }, queries: targets, replies: [] });
}

/** Finish the active phase of `e` (all replies in, or a connected network appeared). */
function finishActive(old: DualEntry, e: DualEntry, ctx: DualContext, cause: string): DualOutcome {
  const done = settle(e, ctx);
  const replies = e.replyTo !== undefined ? [{ to: e.replyTo, distance: dualReplyDistance(done, e.replyTo.iface) }] : [];
  return outcome(old, done, { transition: { from: 'active', to: 'passive', cause }, queries: [], replies });
}

function stepActive(old: DualEntry, input: DualInput, ctx: DualContext): DualOutcome {
  switch (input.kind) {
    case 'update': {
      const paths = withPath(old.paths, input.from, input.rd, input.metric);
      const successors = old.successors.flatMap((s) => (sameNbr(s, input.from) ? paths.filter((p) => sameNbr(p, s)) : [s]));
      return outcome(old, { ...old, paths, successors }, { queries: [], replies: [] });
    }
    case 'reply': {
      const paths = withPath(old.paths, input.from, input.rd, input.metric);
      const successors = old.successors.flatMap((s) => (sameNbr(s, input.from) ? paths.filter((p) => sameNbr(p, s)) : [s]));
      const waiting = withoutNbr(old.waiting, input.from);
      const e: DualEntry = { ...old, paths, successors, waiting };
      if (waiting.length === 0) return finishActive(old, e, ctx, DUAL_CAUSE.replies);
      return outcome(old, e, { queries: [], replies: [] });
    }
    case 'query': {
      const paths = withPath(old.paths, input.from, input.rd, input.metric);
      const successors = old.successors.flatMap((s) => (sameNbr(s, input.from) ? paths.filter((p) => sameNbr(p, s)) : [s]));
      const e: DualEntry = { ...old, paths, successors };
      const deferred = old.replyTo !== undefined && sameNbr(old.replyTo, input.from);
      return outcome(old, e, { queries: [], replies: deferred ? [] : [{ to: input.from, distance: dualReplyDistance(e, input.from.iface) }] });
    }
    case 'neighbor-down': {
      const n = input.neighbor;
      const waiting = withoutNbr(old.waiting, n);
      const replyTo = old.replyTo !== undefined && sameNbr(old.replyTo, n) ? undefined : old.replyTo;
      const e: DualEntry = {
        prefix: old.prefix,
        state: 'active',
        fd: old.fd,
        distance: old.distance,
        paths: withoutNbr(old.paths, n),
        successors: withoutNbr(old.successors, n),
        waiting,
        ...(replyTo !== undefined ? { replyTo } : {}),
      };
      if (waiting.length === 0) return finishActive(old, e, ctx, DUAL_CAUSE.replies);
      return outcome(old, e, { queries: [], replies: [] });
    }
    case 'connected':
      return finishActive(old, { ...old, connected: { iface: input.iface, metric: input.metric } }, ctx, DUAL_CAUSE.connected);
    case 'connected-down':
    case 'recompute':
      return outcome(old, old, { queries: [], replies: [] });
  }
}

function stepPassive(old: DualEntry, input: DualInput, ctx: DualContext): DualOutcome {
  switch (input.kind) {
    case 'update':
    case 'reply':
      return evaluatePassive(old, { ...old, paths: withPath(old.paths, input.from, input.rd, input.metric) }, ctx, undefined);
    case 'query':
      return evaluatePassive(old, { ...old, paths: withPath(old.paths, input.from, input.rd, input.metric) }, ctx, input.from);
    case 'neighbor-down':
      return evaluatePassive(old, { ...old, paths: withoutNbr(old.paths, input.neighbor) }, ctx, undefined);
    case 'connected':
      return evaluatePassive(old, { ...old, connected: { iface: input.iface, metric: input.metric } }, ctx, undefined);
    case 'connected-down': {
      if (old.connected === undefined) return outcome(old, old, { queries: [], replies: [] });
      const { connected: _gone, ...rest } = old;
      return evaluatePassive(old, rest, ctx, undefined);
    }
    case 'recompute':
      return evaluatePassive(old, old, ctx, undefined);
  }
}

/** Apply one input to one destination. */
export function dualStep(entry: DualEntry, input: DualInput, ctx: DualContext): DualOutcome {
  return entry.state === 'active' ? stepActive(entry, input, ctx) : stepPassive(entry, input, ctx);
}

/** The `eigrp-topology` row of an entry (§2.16): successors, feasible successors (RD < FD) and the other paths. */
export function dualTopologyRow(entry: DualEntry, now: SimTime): EigrpTopologyRow {
  const rest = entry.paths.filter((p) => !entry.successors.some((s) => sameNbr(s, p)));
  return {
    key: entry.prefix,
    updatedAt: now,
    prefix: entry.prefix,
    state: entry.state,
    fd: entry.fd,
    successors: entry.successors,
    feasible: rest.filter((p) => p.rd < entry.fd),
    others: rest.filter((p) => p.rd >= entry.fd),
    ...(entry.connected !== undefined ? { connected: entry.connected.iface } : {}),
    ...(entry.state === 'active' ? { pendingReplies: entry.waiting.length } : {}),
  };
}
