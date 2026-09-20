/**
 * core/table.ts — generic device table (spec §4.4 `tables: DeviceTables`, §9.4 table visualizers).
 *
 * A `Table<R>` is a `Map<string, R>` in insertion order that emits a `tableWrite` trace
 * event on every `set` and a `tableExpire` on every removal (`delete`, `clear`, `expire`).
 * Those events are what make rows flash and fade in the UI (§9.4).
 *
 * Ordering: `rows()` returns a fresh array in insertion order. `set` of an existing key
 * REPLACES the row in place — it keeps the key's original position (JS Map semantics);
 * delete + set is required to move a row to the end.
 *
 * Time stamping: `set` emits `t = row.updatedAt`; `delete`/`clear` emit `t = opts.now()`;
 * `expire(now)` emits `t = now`. Event rows are shallow plain copies of the stored row so
 * later in-place edits by a process never leak into an already-emitted event.
 */
import type { DeviceId } from '../contracts/ids.js';
import type { Table, TableFactory, TableName, TableOptions, TableRow } from '../contracts/tables.js';
import { assertSimTime, type SimTime } from '../contracts/time.js';
import type { TraceSink } from '../contracts/trace.js';

export { lpm } from './lpm.js';

type ExpireReason = 'aged' | 'cleared' | 'replaced' | 'link-down';

/** Shallow plain copy for trace events (rows are plain data objects). */
function plain<R extends TableRow>(row: R): Record<string, unknown> {
  return { ...(row as object) } as Record<string, unknown>;
}

class MapTable<R extends TableRow> implements Table<R> {
  readonly name: TableName;
  readonly device: DeviceId;
  private readonly sink: TraceSink;
  private readonly clock: () => SimTime;
  private readonly map = new Map<string, R>();

  constructor(opts: TableOptions) {
    this.name = opts.name;
    this.device = opts.device;
    this.sink = opts.sink;
    this.clock = opts.now;
  }

  get size(): number {
    return this.map.size;
  }

  get(key: string): R | undefined {
    return this.map.get(key);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  rows(): R[] {
    return Array.from(this.map.values());
  }

  set(row: R): R | undefined {
    assertSimTime(row.updatedAt, `${this.name}.updatedAt`);
    if (row.expiresAt !== undefined) assertSimTime(row.expiresAt, `${this.name}.expiresAt`);
    const previous = this.map.get(row.key);
    this.map.set(row.key, row);
    if (previous === undefined) {
      this.sink.emit({ t: row.updatedAt, kind: 'tableWrite', device: this.device, table: this.name, key: row.key, row: plain(row) });
    } else {
      this.sink.emit({
        t: row.updatedAt, kind: 'tableWrite', device: this.device, table: this.name, key: row.key,
        row: plain(row), previous: plain(previous),
      });
    }
    return previous;
  }

  delete(key: string, reason: ExpireReason = 'cleared'): R | undefined {
    const previous = this.map.get(key);
    if (previous === undefined) return undefined;
    this.map.delete(key);
    this.emitExpire(previous, this.clock(), reason);
    return previous;
  }

  clear(reason: 'cleared' | 'link-down' = 'cleared'): void {
    if (this.map.size === 0) return;
    const t = this.clock();
    const removed = this.rows();
    this.map.clear();
    for (const row of removed) this.emitExpire(row, t, reason);
  }

  expire(now: SimTime): R[] {
    assertSimTime(now, 'expire(now)');
    const removed: R[] = [];
    for (const row of this.map.values()) {
      if (row.expiresAt !== undefined && row.expiresAt <= now) removed.push(row);
    }
    for (const row of removed) {
      this.map.delete(row.key);
      this.emitExpire(row, now, 'aged');
    }
    return removed;
  }

  find(pred: (r: R) => boolean): R[] {
    const out: R[] = [];
    for (const row of this.map.values()) if (pred(row)) out.push(row);
    return out;
  }

  private emitExpire(row: R, t: SimTime, reason: ExpireReason): void {
    this.sink.emit({ t, kind: 'tableExpire', device: this.device, table: this.name, key: row.key, row: plain(row), reason });
  }
}

/** `TableFactory`: build an empty table bound to a device, a trace sink and a sim clock. */
export const createTable: TableFactory = <R extends TableRow>(opts: TableOptions): Table<R> => new MapTable<R>(opts);
