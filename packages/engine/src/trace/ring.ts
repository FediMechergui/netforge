/**
 * trace/ring.ts — bounded ring of trace events with a monotonic cursor (spec §4.4 `trace: TraceSink`, §4.3 turbo).
 *
 * `head` is the cursor of the NEXT event to be emitted and increments on every `emit`,
 * even when `capacity` is 0 (turbo mode keeps no events but consumers can still count).
 * `since(cursor)` returns the retained events from `max(cursor, oldestRetained)` and
 * reports how many the caller missed as `dropped = max(0, oldestRetained - cursor)`.
 * `clear()` forgets the retained events but keeps `head` monotonic, so a cursor taken
 * before the clear is still valid afterwards (it just sees `dropped`).
 */
import type { TraceEvent, TraceRing } from '../contracts/trace.js';

class RingBuffer implements TraceRing {
  readonly capacity: number;
  private readonly buf: (TraceEvent | undefined)[];
  private _head = 0;
  /** Number of events currently retained (≤ capacity). */
  private count = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 0) {
      throw new RangeError(`trace ring capacity must be a non-negative integer, got ${capacity}`);
    }
    this.capacity = capacity;
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

  clear(): void {
    if (this.capacity > 0) this.buf.fill(undefined);
    this.count = 0;
  }
}

/** Create a trace ring retaining at most `capacity` events (0 = retain nothing, count only). */
export function createTraceRing(capacity: number): TraceRing {
  return new RingBuffer(capacity);
}
