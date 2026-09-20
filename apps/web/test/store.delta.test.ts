/**
 * Store delta merge, snapshot index, persisted preferences and the P0.5 UI slices
 * (ARCHITECTURE-P1 §3.14, §7 "Shell", §8.1 W6 web-shell; store/types.ts header).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceSnapshot, LinkSnapshot, SimSnapshot } from '@netforge/engine';
import type { EngineBatch, SnapshotDelta } from '../src/bridge/protocol';
import {
  DEFAULT_OVERLAYS,
  RECENT_LIMIT,
  THEME_KEY,
  UI_PREFS_KEY,
  attachPersistence,
  defaultPersistedUi,
  loadPersistedUi,
  persistedSliceOf,
  sanitizePersistedUi,
  savePersistedUi,
} from '../src/store/persist';
import { selectDevice, selectLink, selectModel, selectedDeviceId } from '../src/store/selectors';
import { buildSnapshotIndex, mergeSnapshotDelta, setResyncHandler, store } from '../src/store/store';
import { DESKTOP_WINDOW_LIMIT } from '../src/store/types';

const dev = (id: string, extra: Partial<DeviceSnapshot> = {}): DeviceSnapshot => ({ id, name: id.toUpperCase(), ports: [], ...extra }) as unknown as DeviceSnapshot;
const link = (id: string, up = true): LinkSnapshot => ({ id, up, a: { device: 'a', port: 'p' }, b: { device: 'b', port: 'p' } }) as unknown as LinkSnapshot;

function snap(devices: DeviceSnapshot[], links: LinkSnapshot[] = [], extra: Partial<SimSnapshot> = {}): SimSnapshot {
  return { now: 0, seed: 1, topologyVersion: 4, devices, links, inflight: [], sessions: [], pduCount: 0, pendingEvents: 0, ...extra } as SimSnapshot;
}

function delta(devices: DeviceSnapshot[], extra: Partial<SnapshotDelta> = {}): SnapshotDelta {
  return { now: 5, seed: 1, topologyVersion: 4, devices, inflight: [], sessions: [], pduCount: 0, pendingEvents: 0, ...extra } as SnapshotDelta;
}

const base = { playing: false, rate: 1, effectiveRate: 1_000_000, dropped: 0 };
let epoch = 1000;

function batch(p: Partial<EngineBatch>): EngineBatch {
  return { ...base, epoch, now: 0, events: [], ...p } as EngineBatch;
}

describe('snapshot index and delta merge (pure)', () => {
  const a = dev('a');
  const b = dev('b');
  const c = dev('c');
  const l1 = link('l1');
  const l2 = link('l2');
  const full = snap([a, b, c], [l1, l2]);
  const index = buildSnapshotIndex(full);

  it('indexes devices and links by position', () => {
    expect(index).toEqual({ topologyVersion: 4, devices: { a: 0, b: 1, c: 2 }, links: { l1: 0, l2: 1 } });
    expect(Object.isFrozen(index)).toBe(true);
  });

  it('replaces changed devices in place and keeps the identity of the others', () => {
    const b2 = dev('b', { name: 'B2' });
    const r = mergeSnapshotDelta(full, index, delta([b2]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.devices).not.toBe(full.devices);
    expect(r.snapshot.devices[0]).toBe(a);
    expect(r.snapshot.devices[1]).toBe(b2);
    expect(r.snapshot.devices[2]).toBe(c);
    expect(r.snapshot.links).toBe(full.links);
    expect(r.snapshot.now).toBe(5);
    expect(r.index).toBe(index);
    expect(full.devices[1]).toBe(b);
  });

  it('keeps the device array when the delta has no devices, replaces links when present', () => {
    const l1down = link('l1', false);
    const r = mergeSnapshotDelta(full, index, delta([], { links: [l1down, l2] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.devices).toBe(full.devices);
    expect(r.snapshot.links[0]).toBe(l1down);
    expect(r.index).toBe(index);

    const reshaped = mergeSnapshotDelta(full, index, delta([], { links: [l2] }));
    expect(reshaped.ok && reshaped.index.links).toEqual({ l2: 0 });
  });

  it('refuses deltas it cannot merge', () => {
    expect(mergeSnapshotDelta(null, undefined, delta([]))).toEqual({ ok: false, reason: 'no-snapshot' });
    expect(mergeSnapshotDelta(full, index, delta([], { topologyVersion: 5 }))).toEqual({ ok: false, reason: 'topology-mismatch' });
    expect(mergeSnapshotDelta(full, index, delta([dev('zz')]))).toEqual({ ok: false, reason: 'unknown-device' });
  });
});

describe('store.applyBatch with deltas', () => {
  let resync: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    epoch += 1;
    resync = vi.fn();
    setResyncHandler(resync);
    store.getState().select(null);
    store.getState().applyBatch(batch({ snapshot: snap([dev('a'), dev('b'), dev('c')], [link('l1')]) }));
  });
  afterEach(() => {
    setResyncHandler(undefined);
  });

  it('merges a delta keeping untouched devices and the index', () => {
    const before = store.getState();
    const [a0, , c0] = before.snapshot!.devices;
    const b2 = dev('b', { name: 'Renamed' });
    store.getState().applyBatch(batch({ now: 9, delta: delta([b2], { now: 9 }) }));
    const after = store.getState();
    expect(after.snapshot!.devices[0]).toBe(a0);
    expect(after.snapshot!.devices[2]).toBe(c0);
    expect(selectDevice(after, 'b')?.name).toBe('Renamed');
    expect(after.snapshotIndex).toBe(before.snapshotIndex);
    expect(after.snapshot!.links).toBe(before.snapshot!.links);
    expect(after.now).toBe(9);
    expect(resync).not.toHaveBeenCalled();
  });

  it('a topologyVersion mismatch leaves the mirror alone and asks for a resync', () => {
    const before = store.getState().snapshot;
    store.getState().applyBatch(batch({ delta: delta([dev('a', { name: 'X' })], { topologyVersion: 99 }) }));
    expect(store.getState().snapshot).toBe(before);
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it('a delta that arrives with a new epoch is not merged', () => {
    const before = store.getState().snapshot;
    epoch += 1;
    store.getState().applyBatch(batch({ delta: delta([dev('a', { name: 'X' })]) }));
    expect(store.getState().epoch).toBe(epoch);
    expect(store.getState().snapshot).toBe(before);
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it('uses the delta in-flight list as authoritative', () => {
    const tx = {
      t: 0,
      kind: 'frameTx',
      pdu: { id: 7 },
      link: 'l1',
      from: { device: 'a', port: 'p' },
      to: { device: 'b', port: 'p' },
      txStart: 0,
      txEnd: 10,
      arrive: 5_000_000_000,
    };
    store.getState().applyBatch(batch({ events: [tx] as never }));
    expect(store.getState().inflight).toHaveLength(1);
    store.getState().applyBatch(batch({ now: 1, delta: delta([], { now: 1, inflight: [] }) }));
    expect(store.getState().inflight).toHaveLength(0);
  });

  it('prunes selections that a delta makes stale and counts truncated events', () => {
    const withAssoc = { metresPerUnit: 0.25, segments: [], bss: [], cells: [], associations: [{ id: 'as1' }] };
    store.getState().applyBatch(batch({ delta: delta([], { media: withAssoc as never }) }));
    store.getState().select({ kind: 'association', id: 'as1' });
    store.getState().applyBatch(batch({ delta: delta([], { media: withAssoc as never }), eventsTruncated: 3 }));
    expect(store.getState().selection).toEqual({ kind: 'association', id: 'as1' });
    store.getState().applyBatch(batch({ delta: delta([]), eventsTruncated: 2 }));
    expect(store.getState().selection).toBeNull();
    expect(store.getState().eventsTruncated).toBe(5);
  });

  it('prunes a slot selection whose slot vanished and keeps a live one', () => {
    const chassis = dev('a', { slots: [{ id: '0/0' }] as never });
    store.getState().applyBatch(batch({ delta: delta([chassis]) }));
    store.getState().select({ kind: 'slot', device: 'a', slot: '0/0' });
    expect(selectedDeviceId(store.getState())).toBe('a');
    store.getState().applyBatch(batch({ delta: delta([dev('a', { slots: [] as never })]) }));
    expect(store.getState().selection).toBeNull();
  });

  it('setSnapshot replaces the mirror and rebuilds the index', () => {
    store.getState().setSnapshot(snap([dev('z')], [link('l9')], { topologyVersion: 8 }));
    const st = store.getState();
    expect(st.snapshotIndex).toEqual({ topologyVersion: 8, devices: { z: 0 }, links: { l9: 0 } });
    expect(selectDevice(st, 'z')?.id).toBe('z');
    expect(selectLink(st, 'l9')?.id).toBe('l9');
    expect(selectDevice(st, 'a')).toBeUndefined();
  });
});

describe('selectors', () => {
  it('fall back to a scan when the index is stale', () => {
    const s = snap([dev('a'), dev('b')]);
    const stale = { topologyVersion: 4, devices: { a: 1, b: 0 }, links: {} };
    expect(selectDevice({ snapshot: s, snapshotIndex: stale }, 'a')?.id).toBe('a');
    expect(selectDevice({ snapshot: s, snapshotIndex: undefined }, 'b')?.id).toBe('b');
    expect(selectDevice({ snapshot: null, snapshotIndex: undefined }, 'b')).toBeUndefined();
  });

  it('look catalog models up by type', () => {
    const catalog = [{ type: 'pc.nfpc' }, { type: 'router.nf2911' }] as never;
    expect(selectModel({ catalog }, 'router.nf2911')).toEqual({ type: 'router.nf2911' });
    expect(selectModel({ catalog }, 'nope')).toBeUndefined();
  });
});

describe('P0.5 UI slices', () => {
  it('keeps at most DESKTOP_WINDOW_LIMIT windows, reuses a window per device and app, and raises on focus', () => {
    for (const w of store.getState().desktopWindows) store.getState().closeDesktopWindow(w.id);
    const first = store.getState().openDesktopWindow('a', 'desktop.ip-config');
    expect(store.getState().openDesktopWindow('a', 'desktop.ip-config')).toBe(first);
    for (let i = 0; i < DESKTOP_WINDOW_LIMIT; i++) store.getState().openDesktopWindow(`d${i}`, 'desktop.wifi');
    const wins = store.getState().desktopWindows;
    expect(wins).toHaveLength(DESKTOP_WINDOW_LIMIT);
    expect(wins.some((w) => w.id === first)).toBe(false);

    const target = wins[0]!;
    store.getState().focusDesktopWindow(target.id);
    const top = Math.max(...store.getState().desktopWindows.map((w) => w.z));
    expect(store.getState().desktopWindows.find((w) => w.id === target.id)?.z).toBe(top);

    store.getState().moveDesktopWindow(target.id, { x: 10.4, y: -5, w: 10, h: 10 });
    const moved = store.getState().desktopWindows.find((w) => w.id === target.id)!;
    expect(moved.x).toBe(10);
    expect(moved.y).toBe(0);
    expect(moved.w).toBeGreaterThan(10);
  });

  it('keeps recent models unique, newest first, bounded', () => {
    for (let i = 0; i < RECENT_LIMIT + 3; i++) store.getState().pushRecentModel(`m${i}`);
    store.getState().pushRecentModel('m5');
    const recent = store.getState().palette.recent;
    expect(recent[0]).toBe('m5');
    expect(recent).toHaveLength(RECENT_LIMIT);
    expect(new Set(recent).size).toBe(recent.length);
  });

  it('palette, cable and overlay actions replace the persisted objects they edit', () => {
    const collapsed = store.getState().palette.collapsed;
    store.getState().togglePaletteGroup('routers');
    expect(store.getState().palette.collapsed).not.toBe(collapsed);
    expect(store.getState().palette.collapsed.routers).toBe(true);

    const overlays = store.getState().overlays;
    store.getState().setOverlay('rangeRings', !overlays.rangeRings);
    expect(store.getState().overlays).not.toBe(overlays);
    store.getState().setOverlay('rangeRings', overlays.rangeRings);

    store.getState().setTool('cable');
    store.getState().setPendingCable({ from: { device: 'a', port: 'p' } });
    store.getState().setCableMedia('serial-dce');
    expect(store.getState().pendingCable?.media).toBe('serial-dce');
    store.getState().setTool('select');
    expect(store.getState().pendingCable).toBeNull();
    store.getState().setCableMedia('auto');
  });

  it('announcements get fresh ids and ignore blank text', () => {
    store.getState().announce('Link up');
    const a = store.getState().a11y.announcement;
    store.getState().announce('   ');
    expect(store.getState().a11y.announcement).toBe(a);
    store.getState().announce('Link up');
    expect(store.getState().a11y.announcement?.id).not.toBe(a?.id);
  });
});

describe('persisted preferences', () => {
  class MemoryStorage {
    data = new Map<string, string>();
    getItem(k: string): string | null {
      return this.data.get(k) ?? null;
    }
    setItem(k: string, v: string): void {
      this.data.set(k, v);
    }
    removeItem(k: string): void {
      this.data.delete(k);
    }
  }
  let mem: MemoryStorage;

  beforeEach(() => {
    mem = new MemoryStorage();
    vi.stubGlobal('localStorage', mem);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('sanitizes untrusted records', () => {
    const out = sanitizePersistedUi(
      {
        palette: { collapsed: { routers: true, bad: 'yes' }, recent: ['a', 'a', 7, 'b', ...Array.from({ length: 20 }, (_, i) => `x${i}`)] },
        cable: { media: 'string-and-cans' },
        overlays: { rangeRings: true, signalBars: 'no', extra: true },
        dock: { tab: 'no-such-tab', height: -4, inspectorWidth: 420.6 },
      },
      'light',
    );
    expect(out.theme).toBe('light');
    expect(out.palette.collapsed).toEqual({ routers: true });
    expect(out.palette.recent.slice(0, 2)).toEqual(['a', 'b']);
    expect(out.palette.recent).toHaveLength(RECENT_LIMIT);
    expect(out.cable.media).toBe('auto');
    expect(out.overlays).toEqual({ ...DEFAULT_OVERLAYS, rangeRings: true });
    // A tab this build does not show (an unknown id, or one of a later stage) is not restored.
    expect(out.dock.tab).toBe(defaultPersistedUi().dock.tab);
    expect(sanitizePersistedUi({ dock: { tab: 'netscope' } }).dock.tab).toBe('netscope');
    expect(out.dock.height).toBe(defaultPersistedUi().dock.height);
    expect(out.dock.inspectorWidth).toBe(421);
    expect(sanitizePersistedUi('garbage')).toEqual(defaultPersistedUi());
  });

  it('round-trips through storage and survives a broken record', () => {
    const prefs = defaultPersistedUi();
    prefs.theme = 'light';
    prefs.cable.media = 'fiber-mm';
    prefs.overlays.channelLabels = true;
    prefs.dock.tab = 'events';
    expect(savePersistedUi(prefs)).toBe(true);
    expect(mem.getItem(THEME_KEY)).toBe('light');
    expect(loadPersistedUi()).toEqual(prefs);

    mem.setItem(UI_PREFS_KEY, '{not json');
    expect(loadPersistedUi()).toEqual({ ...defaultPersistedUi(), theme: 'light' });
  });

  it('writes are debounced and only follow persisted fields', () => {
    vi.useFakeTimers();
    const detach = attachPersistence(store, 50);
    store.getState().setHover({ kind: 'device', id: 'nobody' });
    vi.advanceTimersByTime(100);
    expect(mem.getItem(UI_PREFS_KEY)).toBeNull();

    store.getState().setOverlay('channelLabels', !store.getState().overlays.channelLabels);
    expect(mem.getItem(UI_PREFS_KEY)).toBeNull();
    vi.advanceTimersByTime(60);
    const saved = JSON.parse(mem.getItem(UI_PREFS_KEY) ?? '{}') as { overlays?: { channelLabels?: boolean } };
    expect(saved.overlays?.channelLabels).toBe(store.getState().overlays.channelLabels);
    expect(persistedSliceOf(store.getState()).overlays).toBe(store.getState().overlays);

    store.getState().setDockHeight(123);
    detach();
    const flushed = JSON.parse(mem.getItem(UI_PREFS_KEY) ?? '{}') as { dock?: { height?: number } };
    expect(flushed.dock?.height).toBe(123);
    store.getState().setOverlay('channelLabels', DEFAULT_OVERLAYS.channelLabels);
    store.getState().setHover(null);
  });

  it('storage failures are swallowed', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    });
    expect(loadPersistedUi()).toEqual(defaultPersistedUi());
    expect(savePersistedUi(defaultPersistedUi())).toBe(false);
  });
});
