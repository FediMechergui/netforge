/**
 * The `topoOverlays` store slice and the "Switching overlays" menu (ARCHITECTURE-P2 §2.14, §6, §10.2; W2 web-shell).
 *
 * Under test: the slice's defaults (the same values the canvas registry falls back to), `setTopoOverlay` replacing the
 * slice object so persistence and the canvas sync see the change, the persisted shape (`topoOverlays` and
 * `learn.lastCourse` next to the P1 preferences) with its validation of stored values, the change detector, and the
 * menu model the View menu renders: one toggle per registered overlay, one selector per VLAN key, stable ids, and
 * the VLAN ids a selector offers.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { DeviceSnapshot, SimSnapshot } from '@netforge/engine';
import { OVERLAY_MENU, TOPO_OVERLAY_MENU, VLAN_MENU_MAX, VLAN_SELECTOR_MENU, vlanChoices } from '../src/app/TopBar';
import { OVERLAY_MODULES, TOPO_OVERLAY_DEFAULTS } from '../src/canvas/overlays/registry';
import {
  DEFAULT_TOPO_OVERLAYS,
  VLAN_ID_MAX,
  defaultPersistedUi,
  isVlanChoice,
  persistedChanged,
  persistedSliceOf,
  sanitizePersistedUi,
} from '../src/store/persist';
import { store } from '../src/store/store';
import type { Store, TopoOverlayState } from '../src/store/types';
import { device, link, port, snapshot } from './canvas-fixtures';

const TOGGLE_KEYS: readonly (keyof TopoOverlayState)[] = ['vlan', 'stp', 'capwap'];
const VLAN_KEYS: readonly (keyof TopoOverlayState)[] = ['stpVlan', 'vlanFocus'];

function resetSlice(): void {
  for (const k of TOGGLE_KEYS) store.getState().setTopoOverlay(k as 'vlan', false);
  for (const k of VLAN_KEYS) store.getState().setTopoOverlay(k as 'stpVlan', null);
  store.getState().setLastCourse(null);
}

afterEach(resetSlice);

describe('the slice', () => {
  it('starts with every overlay off and no VLAN chosen — the values the canvas registry falls back to', () => {
    expect(store.getState().topoOverlays).toEqual(DEFAULT_TOPO_OVERLAYS);
    expect(DEFAULT_TOPO_OVERLAYS).toEqual(TOPO_OVERLAY_DEFAULTS);
    expect(Object.keys(DEFAULT_TOPO_OVERLAYS).sort()).toEqual(['capwap', 'stp', 'stpVlan', 'vlan', 'vlanFocus']);
    expect(Object.isFrozen(DEFAULT_TOPO_OVERLAYS)).toBe(true);
  });

  it('setTopoOverlay replaces the slice object and changes only the key named', () => {
    const before = store.getState().topoOverlays;
    store.getState().setTopoOverlay('vlan', true);
    const after = store.getState().topoOverlays;
    expect(after).not.toBe(before);
    expect(after).toEqual({ ...before, vlan: true });
    expect(before.vlan).toBe(false);

    store.getState().setTopoOverlay('stpVlan', 10);
    expect(store.getState().topoOverlays).toEqual({ ...before, vlan: true, stpVlan: 10 });
    store.getState().setTopoOverlay('vlanFocus', 20);
    store.getState().setTopoOverlay('stp', true);
    store.getState().setTopoOverlay('capwap', true);
    expect(store.getState().topoOverlays).toEqual({ vlan: true, stp: true, capwap: true, stpVlan: 10, vlanFocus: 20 });
    store.getState().setTopoOverlay('stpVlan', null);
    expect(store.getState().topoOverlays.stpVlan).toBeNull();
  });

  it('setting the value already held is a no-op that keeps the same object', () => {
    store.getState().setTopoOverlay('stp', true);
    const held = store.getState().topoOverlays;
    store.getState().setTopoOverlay('stp', true);
    store.getState().setTopoOverlay('stpVlan', null);
    expect(store.getState().topoOverlays).toBe(held);
  });

  it('keeps the wireless overlay slice untouched (its keys are pinned by canvas.overlays.test.ts)', () => {
    const wireless = store.getState().overlays;
    store.getState().setTopoOverlay('vlan', true);
    store.getState().setTopoOverlay('vlanFocus', 30);
    expect(store.getState().overlays).toBe(wireless);
    expect(Object.keys(wireless)).not.toContain('vlan');
    expect(Object.keys(wireless)).not.toContain('stp');
  });

  it('setLastCourse records the course context and is a no-op for the value already held', () => {
    expect(store.getState().learn.lastCourse).toBeNull();
    store.getState().setLastCourse('ccna1');
    expect(store.getState().learn.lastCourse).toBe('ccna1');
    const learn = store.getState().learn;
    store.getState().setLastCourse('ccna1');
    expect(store.getState().learn).toBe(learn);
    store.getState().setLastCourse(null);
    expect(store.getState().learn.lastCourse).toBeNull();
  });
});

describe('persistence', () => {
  it('the persisted shape carries the slice and the course context next to the P1 preferences', () => {
    store.getState().setTopoOverlay('stp', true);
    store.getState().setTopoOverlay('stpVlan', 99);
    store.getState().setLastCourse('ccna2');
    const slice = persistedSliceOf(store.getState());
    expect(slice.topoOverlays).toEqual({ ...DEFAULT_TOPO_OVERLAYS, stp: true, stpVlan: 99 });
    expect(slice.learn).toEqual({ lastCourse: 'ccna2' });
    expect(slice.overlays).toBe(store.getState().overlays);
    expect(defaultPersistedUi().topoOverlays).toEqual(DEFAULT_TOPO_OVERLAYS);
    expect(defaultPersistedUi().learn).toEqual({ lastCourse: null });
  });

  it('a stored slice comes back as stored when every value is valid', () => {
    const raw = { topoOverlays: { vlan: true, stp: false, capwap: true, stpVlan: 4094, vlanFocus: 1 }, learn: { lastCourse: 'ccna1' } };
    const out = sanitizePersistedUi(raw);
    expect(out.topoOverlays).toEqual(raw.topoOverlays);
    expect(out.learn).toEqual({ lastCourse: 'ccna1' });
  });

  it('a missing, malformed or out-of-range stored value falls back to the default, key by key', () => {
    expect(sanitizePersistedUi({}).topoOverlays).toEqual(DEFAULT_TOPO_OVERLAYS);
    expect(sanitizePersistedUi({}).learn).toEqual({ lastCourse: null });
    expect(sanitizePersistedUi({ topoOverlays: 'vlan', learn: 7 }).topoOverlays).toEqual(DEFAULT_TOPO_OVERLAYS);
    expect(sanitizePersistedUi(null).topoOverlays).toEqual(DEFAULT_TOPO_OVERLAYS);

    const out = sanitizePersistedUi({
      topoOverlays: { vlan: 'yes', stp: 1, capwap: true, stpVlan: 0, vlanFocus: '10' },
      learn: { lastCourse: '' },
    });
    expect(out.topoOverlays).toEqual({ ...DEFAULT_TOPO_OVERLAYS, capwap: true });
    expect(out.learn.lastCourse).toBeNull();

    for (const bad of [VLAN_ID_MAX + 1, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, undefined, {}, []]) {
      expect(sanitizePersistedUi({ topoOverlays: { stpVlan: bad, vlanFocus: bad } }).topoOverlays).toEqual(DEFAULT_TOPO_OVERLAYS);
    }
    expect(sanitizePersistedUi({ learn: { lastCourse: 'x'.repeat(65) } }).learn.lastCourse).toBeNull();
    expect(sanitizePersistedUi({ learn: { lastCourse: 'x'.repeat(64) } }).learn.lastCourse).toBe('x'.repeat(64));
    expect(sanitizePersistedUi({ learn: { lastCourse: 12 } }).learn.lastCourse).toBeNull();
    expect(sanitizePersistedUi({ learn: { lastCourse: null } }).learn.lastCourse).toBeNull();
  });

  it('isVlanChoice accepts null and an integer VLAN id in 1…4094 only', () => {
    expect(VLAN_ID_MAX).toBe(4094);
    expect(isVlanChoice(null)).toBe(true);
    expect(isVlanChoice(1)).toBe(true);
    expect(isVlanChoice(4094)).toBe(true);
    expect(isVlanChoice(0)).toBe(false);
    expect(isVlanChoice(4095)).toBe(false);
    expect(isVlanChoice(2.5)).toBe(false);
    expect(isVlanChoice('1')).toBe(false);
    expect(isVlanChoice(undefined)).toBe(false);
  });

  it('persistedChanged sees a slice change and a course-context change, and nothing else', () => {
    const a = store.getState();
    expect(persistedChanged(a, a)).toBe(false);
    store.getState().setTopoOverlay('capwap', true);
    const b = store.getState();
    expect(persistedChanged(a, b)).toBe(true);
    expect(persistedChanged(b, b)).toBe(false);
    store.getState().setLastCourse('ccna1');
    const c = store.getState();
    expect(persistedChanged(b, c)).toBe(true);
    // A non-persisted change (the selection) does not count.
    store.getState().select(null);
    const d = store.getState();
    expect(persistedChanged(c, d)).toBe(false);
  });
});

describe('the "Switching overlays" menu model', () => {
  it('lists one toggle per registered overlay, in registry order, with stable ids', () => {
    expect(TOPO_OVERLAY_MENU.map((m) => m.key)).toEqual(OVERLAY_MODULES.map((m) => m.toggle));
    expect(TOPO_OVERLAY_MENU.map((m) => m.id)).toEqual(['topo-overlay-vlan', 'topo-overlay-stp', 'topo-overlay-capwap']);
    expect(TOPO_OVERLAY_MENU.map((m) => m.label)).toEqual(OVERLAY_MODULES.map((m) => m.label));
    expect(new Set(TOPO_OVERLAY_MENU.map((m) => m.id)).size).toBe(TOPO_OVERLAY_MENU.length);
    expect(Object.isFrozen(TOPO_OVERLAY_MENU)).toBe(true);
  });

  it('is exhaustive over the slice: every boolean has a toggle, every VLAN key a selector', () => {
    const booleans = Object.entries(DEFAULT_TOPO_OVERLAYS)
      .filter(([, v]) => typeof v === 'boolean')
      .map(([k]) => k)
      .sort();
    expect(TOPO_OVERLAY_MENU.map((m) => m.key).sort()).toEqual(booleans);
    const vlanKeys = Object.entries(DEFAULT_TOPO_OVERLAYS)
      .filter(([, v]) => v === null)
      .map(([k]) => k)
      .sort();
    expect(VLAN_SELECTOR_MENU.map((s) => s.key).sort()).toEqual(vlanKeys);
    expect(VLAN_SELECTOR_MENU.map((s) => s.id)).toEqual(['stp-vlan', 'vlan-focus']);
    for (const sel of VLAN_SELECTOR_MENU) expect(TOPO_OVERLAY_MENU.some((m) => m.key === sel.shows)).toBe(true);
  });

  it('uses labels of its own, never one of the wireless overlay menu, and never a vendor name', () => {
    const wireless = new Set(OVERLAY_MENU.map((o) => o.label));
    const labels = [...TOPO_OVERLAY_MENU.map((m) => m.label), ...VLAN_SELECTOR_MENU.map((s) => s.label), ...VLAN_SELECTOR_MENU.map((s) => s.none)];
    for (const l of labels) expect(wireless.has(l)).toBe(false);
    expect(new Set(labels).size).toBe(labels.length);
    const texts = [...labels, ...TOPO_OVERLAY_MENU.map((m) => m.hint), ...VLAN_SELECTOR_MENU.map((s) => s.hint)].join(' ');
    expect(texts).not.toMatch(/cisco|packet tracer|ios\b/i);
  });
});

describe('the VLAN ids a selector offers', () => {
  function sw(id: string, vlans: number[], access: number | undefined): DeviceSnapshot {
    const extra = { name: 'vlans', title: 'VLANs', columns: [], rows: vlans.map((v) => ({ key: String(v), vlan: v, name: `V${v}`, status: 'active', source: 'config' })) };
    const l2 = access === undefined ? {} : { l2: { mode: 'access', accessVlan: access, nativeVlan: 1, allowed: 'all' } as unknown as DeviceSnapshot['ports'][number]['l2'] };
    return device(id, 0, 0, [port('Fa0/1', { short: 'Fa0/1', role: 'switched', operUp: true, link: 'l1', ...l2 })], {
      kind: 'switch',
      tables: { cam: [], arp: [], rib: [], extra: [extra] },
    });
  }

  it('is the ascending union of what every device knows, VLAN 1 included, plus the current choice', () => {
    const world: SimSnapshot = snapshot(
      [sw('sw1', [10, 20], undefined), sw('sw2', [20, 30], undefined), device('pc1', 0, 0, [port('Gi0', { role: 'routed', operUp: true, link: 'l1' })])],
      [link('l1', ['sw1', 'Fa0/1'], ['pc1', 'Gi0'])],
    );
    expect(vlanChoices(world, null)).toEqual([1, 10, 20, 30]);
    expect(vlanChoices(world, 20)).toEqual([1, 10, 20, 30]);
    expect(vlanChoices(world, 99)).toEqual([1, 10, 20, 30, 99]);
  });

  it('offers only the current choice without a snapshot, and nothing at all without one or a choice', () => {
    expect(vlanChoices(null, null)).toEqual([]);
    expect(vlanChoices(undefined, 5)).toEqual([5]);
    expect(vlanChoices(snapshot([]), null)).toEqual([]);
  });

  it('caps the list at VLAN_MENU_MAX ids and still lists the current choice beyond it', () => {
    const many = Array.from({ length: VLAN_MENU_MAX + 10 }, (_, i) => 100 + i);
    const world = snapshot([sw('sw1', many, undefined)]);
    const out = vlanChoices(world, null);
    expect(out).toHaveLength(VLAN_MENU_MAX);
    expect(out[0]).toBe(1);
    expect(out).toEqual([...out].sort((a, b) => a - b));
    const withCurrent = vlanChoices(world, 4000);
    expect(withCurrent).toHaveLength(VLAN_MENU_MAX + 1);
    expect(withCurrent[withCurrent.length - 1]).toBe(4000);
  });

  it('derives from the store state the menu reads (topoOverlays plus snapshot), typed as the Store', () => {
    const s: Pick<Store, 'topoOverlays' | 'snapshot'> = store.getState();
    expect(vlanChoices(s.snapshot, s.topoOverlays.stpVlan)).toEqual([]);
  });
});
