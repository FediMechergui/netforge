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
 */
import type { ProcessName } from '../contracts/ids.js';
import type { Table, TableRow } from '../contracts/tables.js';
import { assertSimTime, type SimTime } from '../contracts/time.js';

/** Rows the arbiter can rank: any table row with an administrative distance and a metric. */
export interface ArbitratedRow extends TableRow {
  /** Administrative distance; lower wins. */
  ad: number;
  /** Tie-break after `ad`; lower wins. */
  metric: number;
  /** Offering process (stamped when `stampOwner` is on). */
  owner?: ProcessName;
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
  /** Owner of the installed row for `key`, if any. */
  installedOwner(key: string): ProcessName | undefined;
  /** Every candidate for `key`, best first (the installed one first). */
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

class RibArbiterImpl<R extends ArbitratedRow> implements RibArbiter<R> {
  private readonly table: Table<R> | undefined;
  private readonly stampOwner: boolean;
  /** key → candidates (unsorted, insertion order). */
  private readonly lists = new Map<string, Entry<R>[]>();
  /** key → installed entry. */
  private readonly winners = new Map<string, Entry<R>>();
  /** key → the row last written as installed (the `before` of the next change, even after a re-offer). */
  private readonly installedRows = new Map<string, R>();
  private seq = 0;

  constructor(opts: RibArbiterOptions<R>) {
    this.table = opts.table;
    this.stampOwner = opts.stampOwner ?? true;
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
      out.push(this.settle(key, now, false, reason));
    }
    return out;
  }

  installed(key: string): R | undefined {
    return this.installedRows.get(key);
  }

  installedOwner(key: string): ProcessName | undefined {
    return this.winners.get(key)?.owner;
  }

  candidates(key: string): RibCandidate<R>[] {
    const list = this.lists.get(key);
    if (list === undefined) return [];
    const win = this.winners.get(key);
    return list.slice().sort(better).map((e) => ({ owner: e.owner, row: e.row, installed: e === win }));
  }

  keys(): string[] {
    return Array.from(this.lists.keys());
  }

  reset(): void {
    this.lists.clear();
    this.winners.clear();
    this.installedRows.clear();
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
}

/** Create a route arbiter (see the module header). */
export function createRibArbiter<R extends ArbitratedRow>(opts: RibArbiterOptions<R> = {}): RibArbiter<R> {
  return new RibArbiterImpl<R>(opts);
}
