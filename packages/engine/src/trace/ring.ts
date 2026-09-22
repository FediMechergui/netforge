/**
 * trace/ring.ts — bounded ring of trace events with a monotonic cursor (spec §4.4 `trace: TraceSink`, §4.3 turbo).
 *
 * `head` is the cursor of the NEXT event to be emitted and increments on every `emit`,
 * even when `capacity` is 0 (turbo mode keeps no events but consumers can still count).
 * `since(cursor)` returns the retained events from `max(cursor, oldestRetained)` and
 * reports how many the caller missed as `dropped = max(0, oldestRetained - cursor)`.
 * `clear()` forgets the retained events but keeps `head` monotonic, so a cursor taken
 * before the clear is still valid afterwards (it just sees `dropped`).
 *
 * P2 [SHOULD S1] (ARCHITECTURE-P2 §2.13, §3.13): a ring may start at a cursor other than 0. `startHead` is the cursor
 * of the first event this ring emits (and `head` before any emit): a replay of the input journal starts its ring at the
 * trace head its origin recorded (`FacadeCounters.traceHead`), so an event has the same cursor in the replay as in the
 * live world and the two can be compared entry by entry. Cursors below `startHead` were never retained here: `since`
 * reports them as dropped. `at(cursor)` reads one retained event (the timeline marks resolve lane cursors through it)
 * without copying the window. A ring built without `startHead` behaves exactly as before.
 */
import type { TraceEvent, TraceRing } from '../contracts/trace.js';

/** @since P2 [S1] The ring this module builds: the `TraceRing` contract plus its first cursor and single-event reads. */
export interface TraceRingImpl extends TraceRing {
  /** Cursor of the first event this ring emits (0 unless the ring was built for a replay). Never changes. */
  readonly startHead: number;
  /** The retained event at `cursor`, or undefined when `cursor` is not an integer in [oldest, head). */
  at(cursor: number): TraceEvent | undefined;
}

class RingBuffer implements TraceRingImpl {
  readonly capacity: number;
  readonly startHead: number;
  private readonly buf: (TraceEvent | undefined)[];
  private _head: number;
  /** Number of events currently retained (≤ capacity). */
  private count = 0;

  constructor(capacity: number, startHead: number) {
    if (!Number.isInteger(capacity) || capacity < 0) {
      throw new RangeError(`trace ring capacity must be a non-negative integer, got ${capacity}`);
    }
    if (!Number.isSafeInteger(startHead) || startHead < 0) {
      throw new RangeError(`trace ring start head must be a non-negative integer, got ${startHead}`);
    }
    this.capacity = capacity;
    this.startHead = startHead;
    this._head = startHead;
    this.buf = capacity > 0 ? new Array<TraceEvent | undefined>(capacity).fill(undefined) : [];
  }

  get head(): number {
    return this._head;
  }

  emit(ev: TraceEvent): void {
    if (this.capacity > 0) {
      this.buf[this._head % this.capacity] = ev;
      if (this.count < this.capacity) this.count++;
    }
    this._head++;
  }

  since(cursor: number): { events: TraceEvent[]; next: number; dropped: number } {
    const from = Number.isFinite(cursor) ? Math.max(0, Math.floor(cursor)) : 0;
    const oldest = this._head - this.count;
    const start = Math.max(from, oldest);
    const dropped = Math.max(0, oldest - from);
    const n = Math.max(0, this._head - start);
    const events: TraceEvent[] = new Array(n);
    for (let i = 0; i < n; i++) {
      events[i] = this.buf[(start + i) % this.capacity]!;
    }
    return { events, next: this._head, dropped };
  }

  at(cursor: number): TraceEvent | undefined {
    if (!Number.isInteger(cursor) || cursor < this._head - this.count || cursor >= this._head) return undefined;
    return this.buf[cursor % this.capacity];
  }

  clear(): void {
    if (this.capacity > 0) this.buf.fill(undefined);
    this.count = 0;
  }
}

/**
 * Create a trace ring retaining at most `capacity` events (0 = retain nothing, count only). `startHead` (@since P2
 * [S1], default 0) is the cursor of its first event; a non-negative safe integer.
 */
export function createTraceRing(capacity: number, startHead = 0): TraceRingImpl {
  return new RingBuffer(capacity, startHead);
}
