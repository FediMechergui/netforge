/**
 * Live-region announcements for the canvas (spec §16 "describe what just happened"; ARCHITECTURE-P1 §7).
 *
 *  - `describeEvent` turns a trace event into one original sentence (association and attach changes, link up/down,
 *    cables/devices/modules added or removed, collisions); drops are coalesced per batch by `summarizeEvents`.
 *  - `createAnnouncer` throttles: at most one announcement per `minGapMs`; texts arriving in between are merged
 *    (capped, with an "and N more updates" tail) so a busy simulation never floods a screen reader.
 *  - `announce(text)` writes through the store action `announce` (`UiState.a11y.announcement`); until the store
 *    provides it, a module-level fallback channel carries the text to `LiveRegion` subscribers.
 *  - `attachCanvasAnnouncer(store)` follows the store's event ring and announces new events.
 *
 * Wording is original (§1.6); every sentence names the objects so colour is never needed.
 */
import type { StoreApi } from 'zustand';
import type { TraceEvent } from '@netforge/engine';
import { dropLabel } from '../../vocab/drops.js';
import type { Store } from '../../store/types.js';
import { associationStateText, linkById, linkStateText, nameBook, type NameBook } from './keyboard-nav.js';

/** Minimum wall time between two announcements. */
export const ANNOUNCE_MIN_GAP_MS = 1500;
/** Longest announcement text; merged updates beyond it are counted instead. */
export const ANNOUNCE_MAX_LENGTH = 320;
/** Most distinct drop reasons named in one drop summary. */
const DROP_REASONS_NAMED = 3;

// ── event wording ────────────────────────────────────────────────────────────

/** One sentence for an event, or null when the event is not announced (frames, timers, table churn, moves…). */
export function describeEvent(ev: TraceEvent, names: NameBook, linkEnds?: (id: string) => { a: { device: string; port: string }; b: { device: string; port: string } } | undefined): string | null {
  switch (ev.kind) {
    case 'assocState': {
      const station = names.port(ev.station);
      const ap = ev.ap !== undefined ? names.port(ev.ap) : undefined;
      if (ev.tech === 'wifi') {
        if (ev.state === 'associated') return `${station} joined Wi-Fi${ap !== undefined ? ` on ${ap}` : ''}${ev.rssiDbm !== undefined ? ` at ${ev.rssiDbm} dBm` : ''}.`;
        if (ev.state === 'failed') return `${station} could not join Wi-Fi${ev.reason !== undefined ? `: ${reasonWords(ev.reason)}` : ''}.`;
        if (ev.prev === 'associated') return `${station} lost its Wi-Fi association${ev.reason !== undefined ? `: ${reasonWords(ev.reason)}` : ''}.`;
        return null;
      }
      if (ev.state === 'attached') return `${station} attached to the cell${ap !== undefined ? ` on ${ap}` : ''}.`;
      if (ev.state === 'detached') return `${station} detached from the cell${ev.reason !== undefined ? `: ${reasonWords(ev.reason)}` : ''}.`;
      if (ev.prev === 'attached') return `${station} lost the cell and is ${associationStateText(ev.state)}${ev.reason !== undefined ? `: ${reasonWords(ev.reason)}` : ''}.`;
      return null;
    }
    case 'linkState': {
      const ends = linkEnds?.(ev.link);
      const what = ends !== undefined ? `Cable ${names.port(ends.a)} to ${names.port(ends.b)}` : 'A cable';
      if (ev.up) return `${what} is up.`;
      if (ends === undefined) return `${what} went down.`;
      const link = { a: ends.a, b: ends.b, up: false, ...(ev.reason !== undefined ? { downReason: ev.reason } : {}) };
      return `${what} is ${linkStateText(link, names)}.`;
    }
    case 'topologyChanged': {
      if (ev.op === 'move') return null;
      const verb = ev.op === 'add' ? 'added' : 'removed';
      if (ev.what === 'device') return ev.op === 'add' ? `${names.device(ev.id)} added to the workspace.` : 'A device was removed from the workspace.';
      if (ev.what === 'link') {
        const ends = ev.op === 'add' ? linkEnds?.(ev.id) : undefined;
        return ends !== undefined ? `Cable ${names.port(ends.a)} to ${names.port(ends.b)} added.` : `Cable ${verb}.`;
      }
      return `Module ${verb}.`;
    }
    case 'collision': {
      const who = ev.stations.map((s) => names.device(s.device));
      const unique = who.filter((n, i) => who.indexOf(n) === i);
      return `${ev.late ? 'Late collision' : 'Collision'} on a shared segment between ${joinWords(unique)}.`;
    }
    default:
      return null;
  }
}

function reasonWords(reason: string): string {
  return reason.replace(/[-_]/g, ' ');
}

/** `A`, `A and B`, `A, B and C` */
export function joinWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

/**
 * Sentences for a run of events, in order, with all drops folded into one trailing summary:
 * `2 packets dropped: not for this device (1), no route (1).` Drops of background frames (keepalives, beacons —
 * PDUs whose `frameTx` in the same run carries `background`) and consecutive duplicate sentences are skipped.
 */
export function summarizeEvents(events: readonly TraceEvent[], names: NameBook, linkEnds?: Parameters<typeof describeEvent>[2]): string[] {
  const out: string[] = [];
  const drops = new Map<string, number>();
  let dropCount = 0;
  const background = new Set<number>();
  for (const ev of events) if (ev.kind === 'frameTx' && ev.background === true) background.add(ev.pdu.id);
  for (const ev of events) {
    if (ev.kind === 'drop') {
      if (background.has(ev.pdu.id)) continue;
      dropCount += 1;
      const label = dropLabel(ev.reason);
      drops.set(label, (drops.get(label) ?? 0) + 1);
      continue;
    }
    const text = describeEvent(ev, names, linkEnds);
    if (text !== null && out[out.length - 1] !== text) out.push(text);
  }
  if (dropCount > 0) {
    const ranked = [...drops.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const named = ranked.slice(0, DROP_REASONS_NAMED).map(([label, n]) => `${label} (${n})`);
    const rest = ranked.length - DROP_REASONS_NAMED;
    out.push(`${dropCount} ${dropCount === 1 ? 'packet' : 'packets'} dropped: ${named.join(', ')}${rest > 0 ? ` and ${rest} other ${rest === 1 ? 'reason' : 'reasons'}` : ''}.`);
  }
  return out;
}

/**
 * Events appended to the ring after `lastSeen`. `lastSeen` null → none (history is never read out on mount).
 * When `lastSeen` has left the ring, the events later in sim time than it are taken.
 */
export function newEventsSince(events: readonly TraceEvent[], lastSeen: TraceEvent | null): TraceEvent[] {
  if (lastSeen === null) return [];
  const at = events.lastIndexOf(lastSeen);
  if (at >= 0) return events.slice(at + 1);
  return events.filter((e) => e.t > lastSeen.t);
}

// ── throttled announcer ──────────────────────────────────────────────────────

export interface AnnouncerOptions {
  emit(text: string): void;
  now?(): number;
  minGapMs?: number;
  maxLength?: number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export interface Announcer {
  /** Queue one or more sentences. */
  push(...texts: string[]): void;
  /** Emit what is queued now, ignoring the gap. */
  flush(): void;
  dispose(): void;
}

/** Merge queued sentences into one text of at most `maxLength` characters. */
export function mergeAnnouncements(texts: readonly string[], maxLength = ANNOUNCE_MAX_LENGTH): string {
  let text = '';
  let used = 0;
  for (const t of texts) {
    const next = text === '' ? t : `${text} ${t}`;
    if (next.length > maxLength && used > 0) break;
    text = next;
    used += 1;
  }
  const rest = texts.length - used;
  return rest > 0 ? `${text} And ${rest} more ${rest === 1 ? 'update' : 'updates'}.` : text;
}

export function createAnnouncer(opts: AnnouncerOptions): Announcer {
  const now = opts.now ?? (() => Date.now());
  const gap = opts.minGapMs ?? ANNOUNCE_MIN_GAP_MS;
  const max = opts.maxLength ?? ANNOUNCE_MAX_LENGTH;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let queue: string[] = [];
  let lastEmit = -Infinity;
  let timer: unknown = null;
  let disposed = false;

  const flush = (): void => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (disposed || queue.length === 0) return;
    const text = mergeAnnouncements(queue, max);
    queue = [];
    lastEmit = now();
    opts.emit(text);
  };

  return {
    push(...texts: string[]) {
      if (disposed) return;
      for (const t of texts) if (t.trim() !== '') queue.push(t.trim());
      if (queue.length === 0) return;
      const wait = lastEmit + gap - now();
      if (wait <= 0) flush();
      else if (timer === null) timer = setTimer(flush, wait);
    },
    flush,
    dispose() {
      disposed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      queue = [];
    },
  };
}

// ── store channel ────────────────────────────────────────────────────────────

type Listener = (a: { id: number; text: string }) => void;
const fallbackListeners = new Set<Listener>();
let fallbackId = 0;

/** Put `text` in the canvas live region (store action when present, else the fallback channel). */
export function announceWith(api: StoreApi<Store>, text: string): void {
  const st = api.getState();
  if (st.announce !== undefined) {
    st.announce(text);
    return;
  }
  fallbackId += 1;
  const a = { id: fallbackId, text };
  for (const l of fallbackListeners) l(a);
}

/** Fallback channel subscription (LiveRegion uses it while the store has no `announce`). */
export function subscribeFallbackAnnouncements(listener: Listener): () => void {
  fallbackListeners.add(listener);
  return () => {
    fallbackListeners.delete(listener);
  };
}

/**
 * Follow the store's event ring and announce new events through a throttled announcer. An epoch change
 * (reset / load) restarts from the new ring without reading its history. Returns the detach function.
 */
export function attachCanvasAnnouncer(api: StoreApi<Store>, opts: Partial<Omit<AnnouncerOptions, 'emit'>> = {}): () => void {
  const announcer = createAnnouncer({ ...opts, emit: (text) => announceWith(api, text) });
  const initial = api.getState();
  let epoch = initial.epoch;
  let lastSeen: TraceEvent | null = initial.events[initial.events.length - 1] ?? null;
  let primed = lastSeen !== null;

  const unsubscribe = api.subscribe((state, prev) => {
    if (state.events === prev.events && state.epoch === epoch) return;
    if (state.epoch !== epoch) {
      epoch = state.epoch;
      lastSeen = state.events[state.events.length - 1] ?? null;
      // An empty new ring leaves us unprimed so the run's first batch is announced in full.
      primed = lastSeen !== null;
      return;
    }
    let fresh: TraceEvent[];
    if (!primed) {
      // The ring was empty when we attached: everything in it now is new.
      fresh = [...state.events];
      primed = true;
    } else {
      fresh = newEventsSince(state.events, lastSeen);
    }
    lastSeen = state.events[state.events.length - 1] ?? lastSeen;
    if (fresh.length === 0) return;
    const snapshot = state.snapshot;
    const names = nameBook(snapshot);
    const linkEnds = (id: string): { a: { device: string; port: string }; b: { device: string; port: string } } | undefined => {
      const l = linkById(snapshot, state.snapshotIndex, id);
      return l === undefined ? undefined : { a: l.a, b: l.b };
    };
    const texts = summarizeEvents(fresh, names, linkEnds);
    if (texts.length > 0) announcer.push(...texts);
  });

  return () => {
    unsubscribe();
    announcer.dispose();
  };
}
