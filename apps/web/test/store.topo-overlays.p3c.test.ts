/**
 * The P3c keys of the `topoOverlays` slice and the one P3c persisted-slice migration (ARCHITECTURE-P3C §2.12, RC1 (f),
 * §10.2; W1c web-canvas, the first [S7]/[S26] item, which owns the migration).
 *
 * Under test: the defaults ([S7] `routePath` false, `routeTo` null; [S26] `neighbours` false, `neighbourProtocol`
 * 'both'), equal to the canvas registry's; `setTopoOverlay` on the new keys; a record stored by a P2 or P3 build gains
 * the P3c keys at their defaults and keeps every stored value under the same storage key; a P3c record comes back as
 * stored (the destination canonical); malformed values fall back key by key; the View menu's new entries (the two
 * toggles, the destination selector offering the world's addresses, the three protocol choices).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  NEIGHBOUR_PROTOCOL_MENU,
  ROUTING_OVERLAY_MENU,
  ROUTING_SELECTOR_MENU,
  routingChoices,
} from '../src/app/TopBar';
import { TOPO_OVERLAY_DEFAULTS } from '../src/canvas/overlays/registry';
import {
  DEFAULT_TOPO_OVERLAYS,
  UI_PREFS_KEY,
  isNeighbourProtocol,
  isRouteTarget,
  persistedChanged,
  persistedSliceOf,
  sanitizePersistedUi,
} from '../src/store/persist';
import { store } from '../src/store/store';
import type { TopoOverlayState } from '../src/store/types';
import { device, port, snapshot } from './canvas-fixtures';

const P3C_DEFAULTS = { routePath: false, routeTo: null, neighbours: false, neighbourProtocol: 'both' } as const;

afterEach(() => {
  const st = store.getState();
  st.setTopoOverlay('routePath', false);
  st.setTopoOverlay('routeTo', null);
  st.setTopoOverlay('neighbours', false);
  st.setTopoOverlay('neighbourProtocol', 'both');
});

describe('the P3c keys of the slice', () => {
  it('start off, with no destination and both protocols, exactly as the canvas registry falls back to', () => {
    expect(DEFAULT_TOPO_OVERLAYS).toMatchObject(P3C_DEFAULTS);
    expect(TOPO_OVERLAY_DEFAULTS).toEqual(DEFAULT_TOPO_OVERLAYS);
    expect(store.getState().topoOverlays).toEqual(DEFAULT_TOPO_OVERLAYS);
    expect(UI_PREFS_KEY).toBe('netforge.ui.v1');
  });

  it('setTopoOverlay sets each P3c key, replacing the slice object, and the change is persisted', () => {
    const a = store.getState();
    store.getState().setTopoOverlay('routePath', true);
    store.getState().setTopoOverlay('routeTo', '10.0.2.10');
    store.getState().setTopoOverlay('neighbours', true);
    store.getState().setTopoOverlay('neighbourProtocol', 'lldp');
    const b = store.getState();
    expect(b.topoOverlays).not.toBe(a.topoOverlays);
    expect(b.topoOverlays).toEqual({ ...DEFAULT_TOPO_OVERLAYS, routePath: true, routeTo: '10.0.2.10', neighbours: true, neighbourProtocol: 'lldp' });
    expect(persistedChanged(a, b)).toBe(true);
    expect(persistedSliceOf(b).topoOverlays).toEqual(b.topoOverlays);
    const held = store.getState().topoOverlays;
    store.getState().setTopoOverlay('neighbourProtocol', 'lldp');
    expect(store.getState().topoOverlays).toBe(held);
  });
});

describe('the P3c persisted-slice migration', () => {
  it('a record stored by a P2 build keeps its values and gains every P3 and P3c key at its default', () => {
    const p2Record = {
      palette: { collapsed: { routers: true }, recent: ['router.nf2911'] },
      dock: { tab: 'tables', height: 300, inspectorWidth: 400 },
      topoOverlays: { vlan: true, stp: true, capwap: false, stpVlan: 20, vlanFocus: null },
      learn: { lastCourse: 'ccna2' },
    };
    const out = sanitizePersistedUi(p2Record, 'light');
    expect(out.topoOverlays).toEqual({ ...DEFAULT_TOPO_OVERLAYS, vlan: true, stp: true, stpVlan: 20 });
    expect(out.learn).toEqual({ lastCourse: 'ccna2' });
    expect(out.palette.recent).toEqual(['router.nf2911']);
  });

  it('a record stored by a P3 build keeps every P3 value and gains the P3c keys at their defaults', () => {
    const p3Slice = {
      vlan: false,
      stp: true,
      stpVlan: 10,
      vlanFocus: null,
      capwap: true,
      qos: true,
      ospf: true,
      ospfArea: '0.0.0.51',
      wan: false,
      eigrp: true,
      eigrpPrefix: '192.168.4.0/22',
    };
    expect(sanitizePersistedUi({ topoOverlays: p3Slice }).topoOverlays).toEqual({ ...p3Slice, ...P3C_DEFAULTS });
  });

  it('a P3c record comes back as stored, the destination in canonical form', () => {
    const slice: TopoOverlayState = { ...DEFAULT_TOPO_OVERLAYS, routePath: true, routeTo: '10.0.2.10', neighbours: true, neighbourProtocol: 'cdp' };
    expect(sanitizePersistedUi({ topoOverlays: slice }).topoOverlays).toEqual(slice);
    const v6 = sanitizePersistedUi({ topoOverlays: { routeTo: '2001:DB8:0:0::1' } }).topoOverlays;
    expect(v6.routeTo).toBe('2001:db8::1');
  });

  it('a malformed P3c value falls back to its default, key by key', () => {
    const out = sanitizePersistedUi({ topoOverlays: { routePath: 'yes', neighbours: 1, routeTo: 'r2', neighbourProtocol: 'CDP', wan: true } });
    expect(out.topoOverlays).toEqual({ ...DEFAULT_TOPO_OVERLAYS, wan: true });
    for (const bad of ['', '10.0.0', '10.0.0.0/8', '300.1.1.1', 'fe80::1::2', 'x'.repeat(60), 7, {}, [], undefined]) {
      expect(sanitizePersistedUi({ topoOverlays: { routeTo: bad } }).topoOverlays.routeTo, String(bad)).toBeNull();
      expect(sanitizePersistedUi({ topoOverlays: { neighbourProtocol: bad } }).topoOverlays.neighbourProtocol, String(bad)).toBe('both');
    }
    expect(isRouteTarget(null)).toBe(true);
    expect(isRouteTarget('192.168.1.1')).toBe(true);
    expect(isRouteTarget('::1')).toBe(true);
    expect(isRouteTarget('192.168.1')).toBe(false);
    expect(['cdp', 'lldp', 'both', 'none'].map(isNeighbourProtocol)).toEqual([true, true, true, false]);
  });
});

describe('the View menu entries', () => {
  it('lists the two toggles last in the routing section, and the destination selector with the route path', () => {
    expect(ROUTING_OVERLAY_MENU.slice(-2).map((m) => [m.id, m.key, m.label])).toEqual([
      ['topo-overlay-route-path', 'routePath', 'Path to a destination'],
      ['topo-overlay-neighbours', 'neighbours', 'Discovered neighbours'],
    ]);
    const dest = ROUTING_SELECTOR_MENU.find((s) => s.id === 'route-to')!;
    expect([dest.key, dest.shows, dest.none]).toEqual(['routeTo', 'routePath', 'No destination']);
    const world = snapshot([
      device('h1', 0, 0, [port('eth0', { l3: { ipv4: { address: '10.0.1.10', prefixLen: 24 } } })]),
      device('r1', 0, 0, [
        port('Gi0/0', { l3: { ipv4: { address: '10.0.1.1', prefixLen: 24 }, ipv6: [{ address: '2001:db8::1', prefixLen: 64, scope: 'global', origin: 'manual', state: 'preferred' }] } }),
      ]),
    ]);
    expect(routingChoices(dest, world, null)).toEqual(['10.0.1.10', '10.0.1.1', '2001:db8::1']);
    expect(routingChoices(dest, world, '10.9.9.9')).toEqual(['10.0.1.10', '10.0.1.1', '2001:db8::1', '10.9.9.9']);
  });

  it('offers the three protocol choices of the neighbours overlay, in order, with labels of their own', () => {
    expect(NEIGHBOUR_PROTOCOL_MENU.map((p) => p.value)).toEqual(['both', 'cdp', 'lldp']);
    expect(new Set(NEIGHBOUR_PROTOCOL_MENU.map((p) => p.label)).size).toBe(3);
    expect(Object.isFrozen(NEIGHBOUR_PROTOCOL_MENU)).toBe(true);
  });
});
