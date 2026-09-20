/**
 * Session output plumbing: reads `cliOutput` / `cliPrompt` trace events for one CLI
 * session out of the store's event ring without ever handing the same event out twice.
 *
 * The ring is capped (old events are spliced off the front), so an array index is not a
 * stable cursor. Instead the cursor remembers the last event object it has seen (the store
 * keeps event identity) and resumes right after it; if that event has been evicted, every
 * retained event is newer by construction.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { SessionId, TraceEvent } from '@netforge/engine';
import { store } from '../store/store';

export type SessionEvent = Extract<TraceEvent, { kind: 'cliOutput' | 'cliPrompt' }>;

function isSessionEvent(ev: TraceEvent, session: SessionId): ev is SessionEvent {
  return (ev.kind === 'cliOutput' || ev.kind === 'cliPrompt') && ev.session === session;
}

export class SessionCursor {
  private last: TraceEvent | null = null;

  constructor(readonly session: SessionId) {}

  /** Start again from the oldest retained event (a freshly mounted terminal replays its session). */
  reset(): void {
    this.last = null;
  }

  /** True when the ring holds events for this session that `take` has not returned yet. */
  hasNew(events: readonly TraceEvent[] = store.getState().events): boolean {
    for (let i = this.startIndex(events); i < events.length; i++) {
      const ev = events[i];
      if (ev !== undefined && isSessionEvent(ev, this.session)) return true;
    }
    return false;
  }

  /** New events for this session, oldest first; advances the cursor past everything in the ring. */
  take(events: readonly TraceEvent[] = store.getState().events): SessionEvent[] {
    const out: SessionEvent[] = [];
    for (let i = this.startIndex(events); i < events.length; i++) {
      const ev = events[i];
      if (ev !== undefined && isSessionEvent(ev, this.session)) out.push(ev);
    }
    const newest = events[events.length - 1];
    if (newest !== undefined) this.last = newest;
    return out;
  }

  private startIndex(events: readonly TraceEvent[]): number {
    if (this.last === null) return 0;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i] === this.last) return i + 1;
    }
    return 0;
  }
}

/** Resolve on the next store change or after `timeoutMs`, whichever comes first. */
export function nextStoreChange(timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe?.();
      resolve();
    };
    unsubscribe = store.subscribe(finish);
    timer = setTimeout(finish, Math.max(0, timeoutMs));
  });
}

/**
 * Subscribe to the store's event ring for `session`. `onNew` (always the latest callback)
 * fires whenever a batch brings events for this session that the returned cursor has not
 * consumed; the caller pulls them with `cursor.take()` and writes them to its terminal.
 */
export function useSessionOutput(session: SessionId, onNew: () => void): SessionCursor {
  const cursor = useMemo(() => new SessionCursor(session), [session]);
  const onNewRef = useRef(onNew);

  useEffect(() => {
    onNewRef.current = onNew;
  }, [onNew]);

  useEffect(
    () =>
      store.subscribe((state, prev) => {
        if (state.events !== prev.events && cursor.hasNew(state.events)) onNewRef.current();
      }),
    [cursor],
  );

  return cursor;
}
