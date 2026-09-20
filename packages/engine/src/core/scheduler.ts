/**
 * core/scheduler.ts — discrete-event scheduler (spec §4.1, §4.2).
 *
 * A binary min-heap ordered by `(at, seq)`. `seq` is a monotonic counter assigned at
 * schedule time and is THE determinism tiebreaker: two events at the same time fire in
 * the order they were scheduled. Cancellation is a tombstone: the entry stays in the
 * heap but is skipped by `next()`/`peekTime()` and excluded from `size`.
 *
 * Time only moves forward: `schedule` refuses `at < now`, `advanceTo` refuses to step
 * back or to jump over a live event.
 */
import type { Scheduler, SimEvent, SimEventBody } from '../contracts/events.js';
import { assertSimTime, type SimTime } from '../contracts/time.js';

/** `a` should fire before `b`. */
function before(a: SimEvent, b: SimEvent): boolean {
  return a.at < b.at || (a.at === b.at && a.seq < b.seq);
}

class HeapScheduler implements Scheduler {
  private heap: SimEvent[] = [];
  /** seqs scheduled and neither fired nor cancelled. Membership only — never iterated for ordering. */
  private readonly pending = new Set<number>();
  /** seqs cancelled while still in the heap; removed when the entry is popped. */
  private readonly tombstones = new Set<number>();
  private seqCounter = 0;
  private _now: SimTime = 0;

  get now(): SimTime {
    return this._now;
  }

  get size(): number {
    return this.pending.size;
  }

  schedule(at: SimTime, body: SimEventBody): number {
    assertSimTime(at, 'schedule(at)');
    if (at < this._now) {
      throw new RangeError(`cannot schedule in the past: at=${at} < now=${this._now}`);
    }
    const seq = ++this.seqCounter;
    const ev = { ...body, at, seq } as SimEvent;
    this.pending.add(seq);
    this.push(ev);
    return seq;
  }

  cancel(seq: number): boolean {
    if (!this.pending.delete(seq)) return false;
    this.tombstones.add(seq);
    return true;
  }

  next(): SimEvent | undefined {
    this.purge();
    const ev = this.pop();
    if (ev === undefined) return undefined;
    this.pending.delete(ev.seq);
    this._now = ev.at;
    return ev;
  }

  peekTime(): SimTime | undefined {
    this.purge();
    const top = this.heap[0];
    return top === undefined ? undefined : top.at;
  }

  advanceTo(t: SimTime): void {
    assertSimTime(t, 'advanceTo(t)');
    if (t < this._now) {
      throw new RangeError(`cannot move time backwards: t=${t} < now=${this._now}`);
    }
    const nextAt = this.peekTime();
    if (nextAt !== undefined && nextAt < t) {
      throw new RangeError(`cannot advance to ${t}: a pending event is due at ${nextAt}`);
    }
    this._now = t;
  }

  // ── heap primitives ──────────────────────────────────────────────────────

  /** Drop tombstoned entries from the top of the heap so `heap[0]` is live (or the heap is empty). */
  private purge(): void {
    while (this.heap.length > 0) {
      const top = this.heap[0]!;
      if (!this.tombstones.has(top.seq)) return;
      this.tombstones.delete(top.seq);
      this.pop();
    }
  }

  private push(ev: SimEvent): void {
    const heap = this.heap;
    heap.push(ev);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const p = heap[parent]!;
      if (!before(ev, p)) break;
      heap[i] = p;
      i = parent;
    }
    heap[i] = ev;
  }

  private pop(): SimEvent | undefined {
    const heap = this.heap;
    const n = heap.length;
    if (n === 0) return undefined;
    const top = heap[0]!;
    const last = heap.pop()!;
    if (n === 1) return top;
    let i = 0;
    const half = (n - 1) >> 1;
    while (i < half) {
      let child = 2 * i + 1;
      const right = child + 1;
      if (right < n - 1 && before(heap[right]!, heap[child]!)) child = right;
      const c = heap[child]!;
      if (!before(c, last)) break;
      heap[i] = c;
      i = child;
    }
    heap[i] = last;
    return top;
  }
}

/** Create an empty scheduler with `now = 0` and `seq` starting at 1. */
export function createScheduler(): Scheduler {
  return new HeapScheduler();
}
