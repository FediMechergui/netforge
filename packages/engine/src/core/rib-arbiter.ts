/**
 * core/rib-arbiter.ts — per-prefix route arbitration by administrative distance (P1, §4.2 "RIB arbitration").
 *
 * Several processes may offer a route for the same table key (for example `0.0.0.0/0` offered as `S` AD 1 by
 * `host` for `ip default-gateway` and as `D` AD 254 by `dhcp-client` for a DHCP lease). The arbiter keeps a
 * candidate list per key and installs exactly one of them:
 *
 *   - the lowest `ad` wins; equal AD → the lowest `metric`; still equal → the candidate offered first.
 *   - A candidate is identified by (key, owner). Offering again from the same owner replaces that owner's
 *     candidate in place (it keeps its original offer position for the tie-break).
 *   - Withdrawing the installed candidate re-installs the next best one; withdrawing the last candidate removes
 *     the key from the table.
 *
 * Table writes (optional `table`): every change of the installed row is written through `Table.set` /
 * `Table.delete`, so the usual `tableWrite` / `tableExpire` trace events appear. A write happens only when the
 * installed row changes: a better offer, a re-offer from the installed owner, a withdrawal of the installed
 * candidate, or the removal of the last candidate. Offering or withdrawing a losing candidate writes nothing.
 * A row re-installed after a withdrawal is stamped `updatedAt = now` so its trace event carries the time of the
 * change, not the time of the original offer.
 *
 * `stampOwner` (default true) copies the offering process into `row.owner` (IPv4 `RouteRow.owner`, which drives
 * the "ip default-gateway" provenance line). Leave it false for rib6, whose rows carry no owner.
 *
 * Determinism: candidates live in insertion-ordered Maps and arrays, ties break on a monotonically increasing
 * offer sequence number, and nothing draws from an rng.
 *
 * Equal-cost multipath [SHOULD S6] (ARCHITECTURE-P2 D13, §2.6). `maxPaths` (default 1) is the most paths one key
 * may install. With the default nothing below applies and every decision, table write and row is exactly the P1
 * behaviour above (core.rib-arbiter.test.ts pins it). With `maxPaths` > 1:
 *   - The path set of a key is the winner (as above) followed by the next candidates in the same order (earliest
 *     offer first) that have the winner's `ad` and `metric`, up to `maxPaths` in all — but only while the winner and
 *     each joining candidate satisfy `multipathEligible` (default: every candidate). An ineligible equal candidate
 *     is skipped; an ineligible winner installs alone.
 *   - The installed row is the winner's row with `paths` = one `{nextHop?, iface?, cause?}` per member, in path
 *     order, when the set has two or more members; `nextHop`/`iface` of the row stay the first path's. With one
 *     member the row has no `paths` key (an offered row's own `paths` is never kept). Absent members are omitted
 *     (never written as undefined); `cause` comes from `pathCause(row, owner)` when given.
 *   - The installed row changes — and is written, stamped `updatedAt = now` — whenever the path set changes: a
 *     member joins or leaves, or any member is re-offered. Offering or withdrawing a candidate outside the set
 *     writes nothing, as before.
 *   - `candidates()` marks every member installed; `installedOwner` names the first path's owner and
 *     `installedOwners` every member's, in path order.
 * Choosing among the paths per flow is the forwarding daemon's job (ECMP hash, §4.1), not the arbiter's.
 */
import type { IpAddress } from '../contracts/addr.js';
import type { PortId, ProcessName } from '../contracts/ids.js';
import type { Table, TableRow } from '../contracts/tables.js';
import { assertSimTime, type SimTime } from '../contracts/time.js';

/** @since P2 [S6] One installed path of a multipath row (`RouteRow.paths` / `Route6Row.paths` element). */
export interface RibPath {
  readonly nextHop?: IpAddress;
  readonly iface?: PortId;
  /** Provenance cause of this path (e.g. the configuration line of a static route). */
  readonly cause?: string;
}

/** Rows the arbiter can rank: any table row with an administrative distance and a metric. */
export interface ArbitratedRow extends TableRow {
  /** Administrative distance; lower wins. */
  ad: number;
  /** Tie-break after `ad`; lower wins. */
  metric: number;
  /** Offering process (stamped when `stampOwner` is on). */
  owner?: ProcessName;
  /** @since P2 [S6] Next hop of this candidate (read only to build `paths`). */
  nextHop?: IpAddress;
  /** @since P2 [S6] Exit interface of this candidate (read only to build `paths`). */
  iface?: PortId;
  /** @since P2 [S6] Written by the arbiter on an installed multipath row (two or more paths). */
  paths?: readonly RibPath[];
}

/** Why a key was removed from the table when its last candidate went away. */
export type RibRemoveReason = 'aged' | 'cleared' | 'replaced' | 'link-down';

/** One candidate for a key, as reported by `candidates()` (best first). */
export interface RibCandidate<R extends ArbitratedRow> {
  /** The offering process. */
  readonly owner: ProcessName;
  /** The offered row (with `owner` stamped when `stampOwner` is on). */
  readonly row: R;
  /** True for the candidate that is currently installed. */
  readonly installed: boolean;
}

/** Result of one arbitration step for one key. */
export interface RibDecision<R extends ArbitratedRow> {
  /** The table key the step applied to. */
  readonly key: string;
  /** Installed row before the step (undefined when the key had no candidate). */
  readonly before?: R;
  /** Installed row after the step (undefined when the key has no candidate left). */
  readonly after?: R;
  /** Owner of `after`. */
  readonly afterOwner?: ProcessName;
  /** True when the installed row changed (a table write happened when a table is attached). */
  readonly changed: boolean;
}

/** Construction options for `createRibArbiter`. */
export interface RibArbiterOptions<R extends ArbitratedRow> {
  /** Table the installed rows are written to. Without it the arbiter only computes decisions. */
  table?: Table<R>;
  /** Copy the offering process into `row.owner` (default true). */
  stampOwner?: boolean;
  /**
   * @since P2 [S6] Most paths installed for one key: an integer ≥ 1 (default 1 = one winner per key, the P1
   * behaviour, unchanged). See the module header.
   */
  maxPaths?: number;
  /** @since P2 [S6] Whether a candidate may share its key with equal-cost candidates (default: every candidate). */
  multipathEligible?: (row: R) => boolean;
  /** @since P2 [S6] The `cause` recorded on each path of a multipath row (default: none). */
  pathCause?: (row: R, owner: ProcessName) => string | undefined;
}

/** Candidate lists per key with lowest-AD installation (see the module header). */
export interface RibArbiter<R extends ArbitratedRow> {
  /**
   * Offer (or replace) `owner`'s candidate for `row.key`. The row's `updatedAt` is the time of the offer.
   * Returns the decision for that key.
   */
  offer(row: R, owner: ProcessName): RibDecision<R>;
  /**
   * Withdraw `owner`'s candidate for `key` at `now`. Unknown (key, owner) pairs change nothing.
   * `reason` is used for the `tableExpire` event when the last candidate goes (default 'cleared').
   */
  withdraw(key: string, owner: ProcessName, now: SimTime, reason?: RibRemoveReason): RibDecision<R>;
  /**
   * Withdraw every candidate for which `pred` is true (e.g. all routes out of an interface that went down).
   * Keys are visited in first-offer order; returns one decision per affected key, in that order.
   */
  withdrawWhere(pred: (row: R, owner: ProcessName) => boolean, now: SimTime, reason?: RibRemoveReason): RibDecision<R>[];
  /** The installed row for `key`, if any. */
  installed(key: string): R | undefined;
  /** Owner of the installed row for `key`, if any (with multipath: the first path's owner). */
  installedOwner(key: string): ProcessName | undefined;
  /** @since P2 [S6] Owners of every installed path of `key`, in path order (one at most without multipath). */
  installedOwners(key: string): ProcessName[];
  /** Every candidate for `key`, best first (the installed one first; with multipath every path is installed). */
  candidates(key: string): RibCandidate<R>[];
  /** Keys that have at least one candidate, in first-offer order. */
  keys(): string[];
  /** Forget every candidate without writing to the table (the device cleared its tables, e.g. power-off). */
  reset(): void;
}

interface Entry<R extends ArbitratedRow> {
  owner: ProcessName;
  row: R;
  seq: number;
}

/** Candidate order: lowest AD, then lowest metric, then the earliest offer. */
function better<R extends ArbitratedRow>(a: Entry<R>, b: Entry<R>): number {
  if (a.row.ad !== b.row.ad) return a.row.ad - b.row.ad;
  if (a.row.metric !== b.row.metric) return a.row.metric - b.row.metric;
  return a.seq - b.seq;
}

/** [S6] One member of an installed path set, with the row it had when the set was installed. */
interface Member<R extends ArbitratedRow> {
  readonly entry: Entry<R>;
  readonly row: R;
}

class RibArbiterImpl<R extends ArbitratedRow> implements RibArbiter<R> {
  private readonly table: Table<R> | undefined;
  private readonly stampOwner: boolean;
  /** [S6] 1 = the P1 single-winner path (`settle`); > 1 = `settleMulti`. */
  private readonly maxPaths: number;
  private readonly eligible: ((row: R) => boolean) | undefined;
  private readonly pathCause: ((row: R, owner: ProcessName) => string | undefined) | undefined;
  /** key → candidates (unsorted, insertion order). */
  private readonly lists = new Map<string, Entry<R>[]>();
  /** key → installed entry. */
  private readonly winners = new Map<string, Entry<R>>();
  /** key → the row last written as installed (the `before` of the next change, even after a re-offer). */
  private readonly installedRows = new Map<string, R>();
  /** [S6] key → the installed path set (only with maxPaths > 1). */
  private readonly members = new Map<string, readonly Member<R>[]>();
  private seq = 0;

  constructor(opts: RibArbiterOptions<R>) {
    this.table = opts.table;
    this.stampOwner = opts.stampOwner ?? true;
    const maxPaths = opts.maxPaths ?? 1;
    if (!Number.isInteger(maxPaths) || maxPaths < 1) throw new RangeError(`maxPaths must be an integer >= 1 (got ${maxPaths})`);
    this.maxPaths = maxPaths;
    this.eligible = opts.multipathEligible;
    this.pathCause = opts.pathCause;
  }

  offer(row: R, owner: ProcessName): RibDecision<R> {
    assertSimTime(row.updatedAt, 'route.updatedAt');
    if (!Number.isFinite(row.ad) || !Number.isFinite(row.metric)) {
      throw new RangeError(`route ${row.key}: ad and metric must be finite numbers`);
    }
    const stored: R = this.stampOwner ? { ...row, owner } : row;
    const key = row.key;
    let list = this.lists.get(key);
    if (list === undefined) {
      list = [];
      this.lists.set(key, list);
    }
    const existing = list.find((e) => e.owner === owner);
    if (existing !== undefined) existing.row = stored;
    else list.push({ owner, row: stored, seq: this.seq++ });
    if (this.maxPaths > 1) return this.settleMulti(key, row.updatedAt, 'cleared');
    return this.settle(key, row.updatedAt, existing !== undefined && this.winners.get(key) === existing, 'cleared');
  }

  withdraw(key: string, owner: ProcessName, now: SimTime, reason: RibRemoveReason = 'cleared'): RibDecision<R> {
    assertSimTime(now, 'now');
    const list = this.lists.get(key);
    const before = this.winners.get(key);
    const idx = list === undefined ? -1 : list.findIndex((e) => e.owner === owner);
    if (list === undefined || idx < 0) {
      const row = this.installedRows.get(key);
      return before === undefined || row === undefined
        ? { key, changed: false }
        : { key, before: row, after: row, afterOwner: before.owner, changed: false };
    }
    list.splice(idx, 1);
    if (list.length === 0) this.lists.delete(key);
    if (this.maxPaths > 1) return this.settleMulti(key, now, reason);
    return this.settle(key, now, false, reason);
  }

  withdrawWhere(pred: (row: R, owner: ProcessName) => boolean, now: SimTime, reason: RibRemoveReason = 'cleared'): RibDecision<R>[] {
    assertSimTime(now, 'now');
    const out: RibDecision<R>[] = [];
    for (const [key, list] of Array.from(this.lists.entries())) {
      const keep = list.filter((e) => !pred(e.row, e.owner));
      if (keep.length === list.length) continue;
      if (keep.length === 0) this.lists.delete(key);
      else this.lists.set(key, keep);
      out.push(this.maxPaths > 1 ? this.settleMulti(key, now, reason) : this.settle(key, now, false, reason));
    }
    return out;
  }

  installed(key: string): R | undefined {
    return this.installedRows.get(key);
  }

  installedOwner(key: string): ProcessName | undefined {
    return this.winners.get(key)?.owner;
  }

  installedOwners(key: string): ProcessName[] {
    const set = this.members.get(key);
    if (set !== undefined) return set.map((m) => m.entry.owner);
    const win = this.winners.get(key);
    return win === undefined ? [] : [win.owner];
  }

  candidates(key: string): RibCandidate<R>[] {
    const list = this.lists.get(key);
    if (list === undefined) return [];
    const win = this.winners.get(key);
    const set = this.members.get(key);
    const isInstalled = (e: Entry<R>): boolean => (set === undefined ? e === win : set.some((m) => m.entry === e));
    return list.slice().sort(better).map((e) => ({ owner: e.owner, row: e.row, installed: isInstalled(e) }));
  }

  keys(): string[] {
    return Array.from(this.lists.keys());
  }

  reset(): void {
    this.lists.clear();
    this.winners.clear();
    this.installedRows.clear();
    this.members.clear();
  }

  /**
   * Recompute the winner of `key` after a candidate change and write the table when the installed row changed.
   * `rewritten` is true when the installed entry itself was re-offered (same owner, new row).
   */
  private settle(key: string, now: SimTime, rewritten: boolean, reason: RibRemoveReason): RibDecision<R> {
    const prev = this.winners.get(key);
    const before = this.installedRows.get(key);
    const list = this.lists.get(key);
    let best: Entry<R> | undefined;
    if (list !== undefined) {
      for (const e of list) if (best === undefined || better(e, best) < 0) best = e;
    }
    if (best === undefined) {
      this.winners.delete(key);
      this.installedRows.delete(key);
      if (before === undefined) return { key, changed: false };
      if (this.table !== undefined && this.table.has(key)) this.table.delete(key, reason);
      return { key, before, changed: true };
    }
    if (best === prev && !rewritten) {
      return { key, before: best.row, after: best.row, afterOwner: best.owner, changed: false };
    }
    // A candidate offered earlier and only now installed carries a stale updatedAt: stamp the change time.
    if (best !== prev && best.row.updatedAt !== now) best.row = { ...best.row, updatedAt: now };
    this.winners.set(key, best);
    this.installedRows.set(key, best.row);
    if (this.table !== undefined) this.table.set(best.row);
    return before === undefined
      ? { key, after: best.row, afterOwner: best.owner, changed: true }
      : { key, before, after: best.row, afterOwner: best.owner, changed: true };
  }

  // ── [S6] equal-cost multipath (maxPaths > 1 only) ──────────────────────────

  /** The path set of `list`: the winner, then equal-cost eligible candidates in candidate order (module header). */
  private pathSet(list: readonly Entry<R>[]): Entry<R>[] {
    const sorted = list.slice().sort(better);
    const best = sorted[0];
    if (best === undefined) return [];
    const set = [best];
    if (this.eligible !== undefined && !this.eligible(best.row)) return set;
    for (let i = 1; i < sorted.length && set.length < this.maxPaths; i++) {
      const e = sorted[i]!;
      if (e.row.ad !== best.row.ad || e.row.metric !== best.row.metric) break;
      if (this.eligible === undefined || this.eligible(e.row)) set.push(e);
    }
    return set;
  }

  /** One `paths` element; absent members are omitted, never written as undefined. */
  private pathOf(e: Entry<R>): RibPath {
    const p: { nextHop?: IpAddress; iface?: PortId; cause?: string } = {};
    if (e.row.nextHop !== undefined) p.nextHop = e.row.nextHop;
    if (e.row.iface !== undefined) p.iface = e.row.iface;
    const cause = this.pathCause?.(e.row, e.owner);
    if (cause !== undefined) p.cause = cause;
    return p;
  }

  /** `settle` for maxPaths > 1: the installed row changes whenever its path set (or a member's row) changes. */
  private settleMulti(key: string, now: SimTime, reason: RibRemoveReason): RibDecision<R> {
    const before = this.installedRows.get(key);
    const prev = this.members.get(key);
    const list = this.lists.get(key);
    const set = list === undefined ? [] : this.pathSet(list);
    const best = set[0];
    if (best === undefined) {
      this.winners.delete(key);
      this.installedRows.delete(key);
      this.members.delete(key);
      if (before === undefined) return { key, changed: false };
      if (this.table !== undefined && this.table.has(key)) this.table.delete(key, reason);
      return { key, before, changed: true };
    }
    const same = prev !== undefined && prev.length === set.length && set.every((e, i) => prev[i]!.entry === e && prev[i]!.row === e.row);
    if (same && before !== undefined) return { key, before, after: before, afterOwner: best.owner, changed: false };
    let row: R = best.row;
    if ('paths' in row) {
      const copy: R = { ...row };
      delete copy.paths;
      row = copy;
    }
    if (set.length > 1) row = { ...row, paths: set.map((e) => this.pathOf(e)) };
    if (row.updatedAt !== now) row = { ...row, updatedAt: now };
    this.winners.set(key, best);
    this.installedRows.set(key, row);
    this.members.set(key, set.map((e) => ({ entry: e, row: e.row })));
    if (this.table !== undefined) this.table.set(row);
    return before === undefined
      ? { key, after: row, afterOwner: best.owner, changed: true }
      : { key, before, after: row, afterOwner: best.owner, changed: true };
  }
}

/** Create a route arbiter (see the module header). */
export function createRibArbiter<R extends ArbitratedRow>(opts: RibArbiterOptions<R> = {}): RibArbiter<R> {
  return new RibArbiterImpl<R>(opts);
}
