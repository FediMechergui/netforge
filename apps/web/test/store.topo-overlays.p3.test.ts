/**
 * The P3 keys of the `topoOverlays` slice, the [S2] `routingUi` slice and the concept-view routing (ARCHITECTURE-P3
 * §2.14, §6, §9.2 item 23, §10.2; W2 web-shell).
 *
 * Under test: the slice's P3 defaults (equal to the canvas registry's), `setTopoOverlay` on the new keys, the one
 * persisted-slice migration (a stored P2 record gains the P3 keys at their defaults; a P3 record comes back as stored;
 * malformed selectors fall back), the "Routing, WAN and QoS overlays" menu model (one toggle per P3 boolean, one
 * selector per P3 selector key, stable ids, original labels, the choices the world's OSPF and EIGRP rows offer), the
 * `routingUi` slice (defaults, merge, no-op, reset by a new epoch, never persisted), and the concept registry keyed by
 * `ConceptToolId` (exhaustive; the P3 tools not built yet show the "not available" note; the View menu lists built
 * tools only).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConceptToolId, DeviceSnapshot, EigrpTopologyRow, OspfInterfaceRow, SimSnapshot } from '@netforge/engine';
import {
  CONCEPT_MENU,
  ROUTING_OVERLAY_MENU,
  ROUTING_SELECTOR_MENU,
  TOPO_OVERLAY_MENU,
  VLAN_MENU_MAX,
  VLAN_SELECTOR_MENU,
  conceptMenuEntries,
  routingChoices,
} from '../src/app/TopBar';
import { TOPO_OVERLAY_DEFAULTS } from '../src/canvas/overlays/registry';
import { CONCEPT_TOOLS, CONCEPT_TOOL_VIEWS, ConceptView, isConceptToolBuilt, type ConceptViewProps } from '../src/concept/ConceptView';
import {
  DEFAULT_TOPO_OVERLAYS,
  isAreaChoice,
  isPrefixChoice,
  persistedChanged,
  persistedSliceOf,
  sanitizePersistedUi,
} from '../src/store/persist';
import { defaultRoutingUi, store } from '../src/store/store';
import type { TopoOverlayState } from '../src/store/types';
import { device, port, snapshot } from './canvas-fixtures';

const P3_DEFAULTS = { qos: false, ospf: false, ospfArea: null, wan: false, eigrp: false, eigrpPrefix: null } as const;

function resetSlice(): void {
  for (const k of ['qos', 'ospf', 'wan', 'eigrp'] as const) store.getState().setTopoOverlay(k, false);
  store.getState().setTopoOverlay('ospfArea', null);
  store.getState().setTopoOverlay('eigrpPrefix', null);
  store.getState().setRoutingUi(defaultRoutingUi());
}

afterEach(resetSlice);

describe('the P3 keys of the slice', () => {
  it('start with every P3 overlay off and nothing chosen, exactly as the canvas registry falls back to', () => {
    expect(DEFAULT_TOPO_OVERLAYS).toEqual({ vlan: false, stp: false, stpVlan: null, vlanFocus: null, capwap: false, ...P3_DEFAULTS });
    expect(TOPO_OVERLAY_DEFAULTS).toEqual(DEFAULT_TOPO_OVERLAYS);
    expect(store.getState().topoOverlays).toEqual(DEFAULT_TOPO_OVERLAYS);
  });

  it('setTopoOverlay sets a P3 toggle or selector, replacing the slice object and nothing else', () => {
    const before = store.getState().topoOverlays;
    store.getState().setTopoOverlay('qos', true);
    const after = store.getState().topoOverlays;
    expect(after).not.toBe(before);
    expect(after).toEqual({ ...before, qos: true });
    store.getState().setTopoOverlay('ospf', true);
    store.getState().setTopoOverlay('ospfArea', '0.0.0.1');
    store.getState().setTopoOverlay('wan', true);
    store.getState().setTopoOverlay('eigrp', true);
    store.getState().setTopoOverlay('eigrpPrefix', '10.4.0.0/24');
    expect(store.getState().topoOverlays).toEqual({
      vlan: false,
      stp: false,
      stpVlan: null,
      vlanFocus: null,
      capwap: false,
      qos: true,
      ospf: true,
      ospfArea: '0.0.0.1',
      wan: true,
      eigrp: true,
      eigrpPrefix: '10.4.0.0/24',
    });
    const held = store.getState().topoOverlays;
    store.getState().setTopoOverlay('ospfArea', '0.0.0.1');
    expect(store.getState().topoOverlays).toBe(held);
  });

  it('a P3 key change is a persisted change, and the persisted shape carries it', () => {
    const a = store.getState();
    store.getState().setTopoOverlay('wan', true);
    const b = store.getState();
    expect(persistedChanged(a, b)).toBe(true);
    expect(persistedSliceOf(b).topoOverlays).toEqual({ ...DEFAULT_TOPO_OVERLAYS, wan: true });
  });
});

describe('the persisted-slice migration (§9.2 item 23)', () => {
  it('a record stored by a P2 build keeps its values and gains every P3 key at its default', () => {
    const p2Record = {
      palette: { collapsed: { routers: true }, recent: ['router.nf2911'] },
      cable: { media: 'auto' },
      overlays: { rangeRings: true },
      dock: { tab: 'tables', height: 300, inspectorWidth: 400 },
      topoOverlays: { vlan: true, stp: true, capwap: false, stpVlan: 20, vlanFocus: null },
      learn: { lastCourse: 'ccna2' },
    };
    const out = sanitizePersistedUi(p2Record, 'light');
    expect(out.topoOverlays).toEqual({ vlan: true, stp: true, capwap: false, stpVlan: 20, vlanFocus: null, ...P3_DEFAULTS });
    expect(out.learn).toEqual({ lastCourse: 'ccna2' });
    expect(out.theme).toBe('light');
    expect(out.palette.recent).toEqual(['router.nf2911']);
  });

  it('a P3 record comes back as stored when every value is valid', () => {
    const slice: TopoOverlayState = {
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
    expect(sanitizePersistedUi({ topoOverlays: slice }).topoOverlays).toEqual(slice);
  });

  it('a malformed P3 value falls back to its default, key by key', () => {
    const out = sanitizePersistedUi({
      topoOverlays: { qos: 'on', ospf: 1, wan: true, eigrp: null, ospfArea: 0, eigrpPrefix: '10.0.0.0' },
    });
    expect(out.topoOverlays).toEqual({ ...DEFAULT_TOPO_OVERLAYS, wan: true });
    for (const bad of ['', 'area 0', '0.0.0', '256.0.0.0', '01.0.0.0', '0.0.0.0.0', 7, {}, [], undefined]) {
      expect(sanitizePersistedUi({ topoOverlays: { ospfArea: bad } }).topoOverlays.ospfArea, String(bad)).toBeNull();
    }
    for (const bad of ['10.0.0.0', '10.0.0.0/33', '10.0.0.0/024', '10.0.0/8', 'x/8', '10.0.0.0/', 24, null]) {
      expect(sanitizePersistedUi({ topoOverlays: { eigrpPrefix: bad } }).topoOverlays.eigrpPrefix, String(bad)).toBeNull();
    }
  });

  it('isAreaChoice and isPrefixChoice accept null and the well-formed values only', () => {
    expect(isAreaChoice(null)).toBe(true);
    expect(isAreaChoice('0.0.0.0')).toBe(true);
    expect(isAreaChoice('255.255.255.255')).toBe(true);
    expect(isAreaChoice('0')).toBe(false);
    expect(isAreaChoice(0)).toBe(false);
    expect(isPrefixChoice(null)).toBe(true);
    expect(isPrefixChoice('0.0.0.0/0')).toBe(true);
    expect(isPrefixChoice('10.4.0.0/24')).toBe(true);
    expect(isPrefixChoice('10.4.0.0/32')).toBe(true);
    expect(isPrefixChoice('10.4.0.0/33')).toBe(false);
    expect(isPrefixChoice('10.4.0.0')).toBe(false);
  });
});

function ospfRouter(id: string, areas: string[]): DeviceSnapshot {
  const rows = areas.map((area, i) => ({ key: `Gi0/${i}`, port: `Gi0/${i}`, area, state: 'dr', cost: 1, routerId: '1.1.1.1' }) as unknown as OspfInterfaceRow);
  return device(id, 0, 0, [port('Gi0/0')], {
    kind: 'router',
    tables: { cam: [], arp: [], rib: [], extra: [{ name: 'ospf-interfaces', title: 'OSPF interfaces', columns: [], rows: rows as unknown as Record<string, unknown>[] }] },
  });
}

function eigrpRouter(id: string, prefixes: string[]): DeviceSnapshot {
  const rows = prefixes.map((prefix) => ({ key: prefix, prefix, state: 'passive', fd: 2816, successors: [], feasible: [], others: [] }) as unknown as EigrpTopologyRow);
  return device(id, 0, 0, [port('Gi0/0')], {
    kind: 'router',
    tables: { cam: [], arp: [], rib: [], extra: [{ name: 'eigrp-topology', title: 'EIGRP topology', columns: [], rows: rows as unknown as Record<string, unknown>[] }] },
  });
}

describe('the "Routing, WAN and QoS overlays" menu model', () => {
  it('lists one toggle per P3 boolean, in §2.14 order, with stable ids and its own labels', () => {
    expect(ROUTING_OVERLAY_MENU.map((m) => m.key)).toEqual(['qos', 'ospf', 'wan', 'eigrp']);
    expect(ROUTING_OVERLAY_MENU.map((m) => m.id)).toEqual(['topo-overlay-qos', 'topo-overlay-ospf', 'topo-overlay-wan', 'topo-overlay-eigrp']);
    expect(Object.isFrozen(ROUTING_OVERLAY_MENU)).toBe(true);
    for (const m of ROUTING_OVERLAY_MENU) expect(Object.isFrozen(m)).toBe(true);
    // no id or label shared with the P2 section
    const p2Ids = new Set(TOPO_OVERLAY_MENU.map((m) => m.id));
    const p2Labels = new Set(TOPO_OVERLAY_MENU.map((m) => m.label));
    for (const m of ROUTING_OVERLAY_MENU) {
      expect(p2Ids.has(m.id as never)).toBe(false);
      expect(p2Labels.has(m.label)).toBe(false);
    }
  });

  it('has one selector per P3 selector key, each shown with its overlay', () => {
    expect(ROUTING_SELECTOR_MENU.map((s) => [s.id, s.key, s.shows])).toEqual([
      ['ospf-area', 'ospfArea', 'ospf'],
      ['eigrp-prefix', 'eigrpPrefix', 'eigrp'],
    ]);
    const vlanIds = new Set(VLAN_SELECTOR_MENU.map((s) => s.id));
    for (const s of ROUTING_SELECTOR_MENU) {
      expect(vlanIds.has(s.id as never)).toBe(false);
      expect(ROUTING_OVERLAY_MENU.some((m) => m.key === s.shows)).toBe(true);
    }
    expect(ROUTING_SELECTOR_MENU[0]!.choiceLabel('0.0.0.1')).toBe('Area 0.0.0.1');
    expect(ROUTING_SELECTOR_MENU[1]!.choiceLabel('10.4.0.0/24')).toBe('10.4.0.0/24');
  });

  it('words every entry originally: unique labels, hints present, no vendor name', () => {
    const labels = [...ROUTING_OVERLAY_MENU.map((m) => m.label), ...ROUTING_SELECTOR_MENU.map((s) => s.label), ...ROUTING_SELECTOR_MENU.map((s) => s.none)];
    expect(new Set(labels).size).toBe(labels.length);
    const texts = [...labels, ...ROUTING_OVERLAY_MENU.map((m) => m.hint), ...ROUTING_SELECTOR_MENU.map((s) => s.hint)];
    for (const t of texts) expect(t.length).toBeGreaterThan(0);
    expect(texts.join(' ')).not.toMatch(/cisco|packet tracer|ios\b/i);
  });

  it('offers the areas and destinations the world names, in their order, plus a persisted choice', () => {
    const [area, prefix] = ROUTING_SELECTOR_MENU as [(typeof ROUTING_SELECTOR_MENU)[number], (typeof ROUTING_SELECTOR_MENU)[number]];
    const world: SimSnapshot = snapshot([
      ospfRouter('r1', ['0.0.0.1', '0.0.0.0']),
      ospfRouter('r2', ['0.0.0.0', '0.0.0.10']),
      eigrpRouter('r3', ['10.9.0.0/24', '9.0.0.0/8']),
    ]);
    expect(routingChoices(area, world, null)).toEqual(['0.0.0.0', '0.0.0.1', '0.0.0.10']);
    expect(routingChoices(area, world, '0.0.0.1')).toEqual(['0.0.0.0', '0.0.0.1', '0.0.0.10']);
    expect(routingChoices(area, world, '0.0.0.7')).toEqual(['0.0.0.0', '0.0.0.1', '0.0.0.10', '0.0.0.7']);
    expect(routingChoices(prefix, world, null)).toEqual(['9.0.0.0/8', '10.9.0.0/24']);
    expect(routingChoices(prefix, null, null)).toEqual([]);
    expect(routingChoices(prefix, undefined, '10.4.0.0/24')).toEqual(['10.4.0.0/24']);
    expect(routingChoices(area, snapshot([]), null)).toEqual([]);
  });

  it('caps the choices at VLAN_MENU_MAX and still lists the current choice beyond them', () => {
    const prefix = ROUTING_SELECTOR_MENU[1]!;
    const many = Array.from({ length: VLAN_MENU_MAX + 5 }, (_, i) => `10.${i}.0.0/16`);
    const world = snapshot([eigrpRouter('r1', many)]);
    expect(routingChoices(prefix, world, null)).toHaveLength(VLAN_MENU_MAX);
    const withCurrent = routingChoices(prefix, world, `10.${VLAN_MENU_MAX + 2}.0.0/16`);
    expect(withCurrent).toHaveLength(VLAN_MENU_MAX + 1);
    expect(withCurrent[VLAN_MENU_MAX]).toBe(`10.${VLAN_MENU_MAX + 2}.0.0/16`);
  });
});

describe('the [S2] routingUi slice', () => {
  it('starts empty: no router, area or LSA, the stepper at its first frame and stopped', () => {
    expect(defaultRoutingUi()).toEqual({ device: null, area: null, lsa: null, spf: { step: 0, playing: false } });
    expect(store.getState().routingUi).toEqual(defaultRoutingUi());
  });

  it('setRoutingUi merges what it is given and replaces the slice object (spf whole)', () => {
    const before = store.getState().routingUi;
    store.getState().setRoutingUi({ device: 'r1', area: '0.0.0.0' });
    const after = store.getState().routingUi;
    expect(after).not.toBe(before);
    expect(after).toEqual({ device: 'r1', area: '0.0.0.0', lsa: null, spf: { step: 0, playing: false } });
    expect(after.spf).not.toBe(before.spf);
    store.getState().setRoutingUi({ lsa: 'router|1.1.1.1|1.1.1.1', spf: { step: 3, playing: true } });
    expect(store.getState().routingUi).toEqual({ device: 'r1', area: '0.0.0.0', lsa: 'router|1.1.1.1|1.1.1.1', spf: { step: 3, playing: true } });
    // undefined members leave the value alone; null clears it
    store.getState().setRoutingUi({ device: undefined, lsa: null });
    expect(store.getState().routingUi).toEqual({ device: 'r1', area: '0.0.0.0', lsa: null, spf: { step: 3, playing: true } });
  });

  it('is a no-op that keeps the same object when nothing changes', () => {
    store.getState().setRoutingUi({ device: 'r2', spf: { step: 1, playing: false } });
    const held = store.getState().routingUi;
    store.getState().setRoutingUi({ device: 'r2', spf: { step: 1, playing: false } });
    store.getState().setRoutingUi({});
    expect(store.getState().routingUi).toBe(held);
  });

  it('is not persisted', () => {
    const a = store.getState();
    store.getState().setRoutingUi({ device: 'r9' });
    const b = store.getState();
    expect(persistedChanged(a, b)).toBe(false);
    expect(Object.keys(persistedSliceOf(b))).not.toContain('routingUi');
  });

  it('is reset by a new epoch (its device ids belonged to the world that went), and kept by the same epoch', () => {
    const empty = { now: 0, seed: 1, topologyVersion: 1, devices: [], links: [], sessions: [], inflight: [], pduCount: 0, pendingEvents: 0 } as unknown as SimSnapshot;
    const batch = (epoch: number) => ({ epoch, now: 0, playing: false, rate: 1, effectiveRate: 1_000_000, dropped: 0, events: [], snapshot: empty });
    const st = store.getState();
    st.applyBatch(batch(40));
    store.getState().setRoutingUi({ device: 'r1', area: '0.0.0.0', lsa: 'x', spf: { step: 2, playing: true } });
    store.getState().applyBatch(batch(40));
    expect(store.getState().routingUi.device).toBe('r1');
    store.getState().applyBatch(batch(41));
    expect(store.getState().routingUi).toEqual(defaultRoutingUi());
  });
});

describe('concept-view routing by ConceptToolId (D24)', () => {
  const ALL: readonly ConceptToolId[] = ['subnetting', 'ipv6', 'queueing', 'data-formats', 'wildcard'];

  it('has one registry entry per ConceptToolId; the P3 tools are not built yet', () => {
    expect(Object.keys(CONCEPT_TOOL_VIEWS).sort()).toEqual([...ALL].sort());
    expect(ALL.filter((t) => isConceptToolBuilt(t))).toEqual(['subnetting', 'ipv6']);
    expect(CONCEPT_TOOLS.every((t) => CONCEPT_TOOL_VIEWS[t.id] !== null)).toBe(true);
  });

  it('routes a built id to its tool and an unbuilt one to the "not available" note', () => {
    const ipv6 = renderToStaticMarkup(createElement<ConceptViewProps>(ConceptView, { tool: 'ipv6' }));
    expect(ipv6).toContain('Shorten or write out');
    for (const t of ['queueing', 'data-formats', 'wildcard'] as const) {
      const html = renderToStaticMarkup(createElement<ConceptViewProps>(ConceptView, { tool: t }));
      expect(html, t).toContain('This concept tool is not available in this build.');
      expect(html, t).not.toContain('Bits and mask');
    }
  });

  it('the View menu lists the P1 entries, then only the other tools this build has', () => {
    const entries = conceptMenuEntries();
    expect(entries.slice(0, CONCEPT_MENU.length)).toEqual([...CONCEPT_MENU]);
    for (const e of entries) expect(isConceptToolBuilt(e.tool), e.tool).toBe(true);
    expect(entries.map((e) => e.tool)).toEqual(['subnetting', 'ipv6']);
  });
});
