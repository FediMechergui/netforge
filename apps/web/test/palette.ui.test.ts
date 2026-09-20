// Palette v2 and cable picker UI (ARCHITECTURE-P1 §7 "Palette v2" / "Cable picker", §8.1 W6 web-inspector, §10.1
// manual smoke "the palette shows every model" and "the cable picker shows DCE glyphs"): server-rendered smoke tests
// over a mocked store, plus the pure helpers the components export.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ALL_MODELS, MEDIA, createSimulation, radioBridge } from '@netforge/engine';
import type { DeviceModel, MediaType, SimSnapshot } from '@netforge/engine';

vi.mock('../src/bridge/client', () => ({ engine: {} }));
// A plain selector store: server rendering reads the current state.
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = {};
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

import { useStore } from '../src/store/store';
import { CategoryRail, railChips } from '../src/app/palette/CategoryRail';
import { PALETTE_WIDTH_KEY, PaletteV2, navSelector, paletteIconMarkup, placedType, readPaletteWidth, rovingType, tileDetail } from '../src/app/palette/Palette';
import { PaletteSearch, isTextEntryTarget, searchSummary } from '../src/app/palette/PaletteSearch';
import { VariantChips } from '../src/app/palette/VariantChips';
import { PALETTE_WIDTH, buildPaletteIndex, categoryCounts, familyKeyOf, queryPalette, EMPTY_PALETTE_QUERY } from '../src/app/palette/palette-query';
import { CABLE_TARGET_LIST_LIMIT, CablePicker, colorTokenVar, freeRadioPorts, lookupPort, mediaGlyphSpec } from '../src/app/cable/CablePicker';
import { MEDIA_PICKER_ORDER, MEDIA_VOCAB } from '../src/vocab/media';
import { CATEGORY_VOCAB } from '../src/vocab/categories';

const setState = (useStore as unknown as { setState(p: Record<string, unknown>): void }).setState;

const MEDIA_TABLE = Object.values(MEDIA);

function baseState(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    catalog: ALL_MODELS,
    modules: [],
    media: MEDIA_TABLE,
    snapshot: null,
    snapshotIndex: undefined,
    tool: 'select',
    addDeviceType: null,
    pendingCable: null,
    palette: { query: '', category: 'all', collapsed: {}, expandedFamily: null, recent: [] },
    cable: { media: 'auto', open: false },
    setTool: vi.fn(),
    setPaletteQuery: vi.fn(),
    setPaletteCategory: vi.fn(),
    togglePaletteGroup: vi.fn(),
    setExpandedFamily: vi.fn(),
    pushRecentModel: vi.fn(),
    setCableMedia: vi.fn(),
    setCablePickerOpen: vi.fn(),
    setPendingCable: vi.fn(),
    announce: vi.fn(),
    toast: vi.fn(),
    ...patch,
  };
}

function render(el: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(el);
}

/** Text content of markup (tags removed, entities decoded). */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

beforeEach(() => {
  const s = (useStore as unknown as { getState(): Record<string, unknown> }).getState();
  for (const k of Object.keys(s)) delete s[k];
  setState(baseState());
});

// ── palette ──────────────────────────────────────────────────────────────────

describe('PaletteV2', () => {
  it('shows one tile per family for the whole catalog, in category sections', () => {
    const html = render(createElement(PaletteV2));
    const families = new Map<string, DeviceModel>();
    for (const m of ALL_MODELS) if (!families.has(familyKeyOf(m))) families.set(familyKeyOf(m), m);
    const tiles = html.match(/data-family="/g) ?? [];
    expect(tiles.length).toBe(families.size);
    for (const [key, model] of families) {
      expect(html).toContain(`data-family="${escapeHtml(key)}"`);
      expect(text(html)).toContain(model.model);
    }
    const sections = new Set(ALL_MODELS.map((m) => m.category));
    for (const c of sections) if (c !== undefined) expect(html).toContain(`aria-label="${escapeHtml(CATEGORY_VOCAB[c].label)}"`);
    expect(text(html)).toContain(`${ALL_MODELS.length} devices`);
  });

  it('renders registry icons and exactly one tab stop in the list', () => {
    const html = render(createElement(PaletteV2));
    expect(html).toContain('class="pv2-svg"');
    const list = html.slice(html.indexOf('class="pv2-scroll"'));
    const stops = list.match(/data-nav-type="[^"]*"[^>]*tabindex="0"/g) ?? [];
    expect(stops).toHaveLength(1);
    expect(html).toContain('role="separator"');
    expect(html).toContain(`aria-valuenow="${PALETTE_WIDTH.default}"`);
  });

  it('filters by search text and shows the match count', () => {
    setState({ palette: { query: 'serial', category: 'all', collapsed: {}, expandedFamily: null, recent: [] } });
    const html = render(createElement(PaletteV2));
    const view = queryPalette(ALL_MODELS, { ...EMPTY_PALETTE_QUERY, query: 'serial' });
    expect(view.matched).toBeGreaterThan(0);
    expect(text(html)).toContain(searchSummary(true, view.matched, view.total));
    expect(html).toContain('<mark class="pv2-hit">');
    const tiles = html.match(/data-family="/g) ?? [];
    expect(tiles.length).toBe(view.sections.reduce((n, s) => n + s.entries.length, 0));
  });

  it('says so when nothing matches and offers to clear the search', () => {
    setState({ palette: { query: 'zzqqxx', category: 'all', collapsed: {}, expandedFamily: null, recent: [] } });
    const html = text(render(createElement(PaletteV2)));
    expect(html).toContain('No device matches “zzqqxx”.');
    expect(html).toContain('Clear the search');
  });

  it('limits the list to the chosen category', () => {
    setState({ palette: { query: '', category: 'routers', collapsed: {}, expandedFamily: null, recent: [] } });
    const html = render(createElement(PaletteV2));
    const routers = ALL_MODELS.filter((m) => m.category === 'routers');
    const other = ALL_MODELS.find((m) => m.category !== 'routers' && !routers.some((r) => r.model === m.model));
    expect(routers.length).toBeGreaterThan(0);
    const list = html.slice(html.indexOf('class="pv2-scroll"'));
    for (const r of routers) expect(list).toContain(`data-family="${escapeHtml(familyKeyOf(r))}"`);
    expect(other).toBeDefined();
    expect(text(list)).not.toContain(` ${other!.model} `);
    expect(html).toMatch(/data-category="routers"[^>]*aria-pressed="true"/);
  });

  it('shows recently used models first and marks the armed model', () => {
    const recent = ALL_MODELS[0]!;
    setState({
      tool: 'add-device',
      addDeviceType: recent.type,
      palette: { query: '', category: 'all', collapsed: {}, expandedFamily: null, recent: [recent.type] },
    });
    const html = render(createElement(PaletteV2));
    expect(html).toContain('aria-label="Recently used"');
    expect(html.indexOf('Recently used')).toBeLessThan(html.indexOf('pv2-section-toggle'));
    expect(text(html)).toContain('armed for placing');
    expect(html).toMatch(/class="pv2-tile is-armed"[^>]*aria-pressed="true"/);
  });

  it('hides a collapsed section but keeps its heading and count', () => {
    setState({ palette: { query: '', category: 'all', collapsed: { routers: true }, expandedFamily: null, recent: [] } });
    const html = render(createElement(PaletteV2));
    const section = html.slice(html.indexOf('aria-label="Routers"'));
    const heading = section.slice(0, section.indexOf('</section>'));
    expect(heading).toContain('aria-expanded="false"');
    expect(heading).not.toContain('class="pv2-list"');
  });

  it('lists the variants of the expanded family as chips', () => {
    const view = queryPalette(ALL_MODELS, EMPTY_PALETTE_QUERY);
    const entry = view.sections.flatMap((s) => s.entries).find((e) => e.hasVariants);
    expect(entry).toBeDefined();
    setState({ palette: { query: '', category: 'all', collapsed: {}, expandedFamily: entry!.key, recent: [] } });
    const html = render(createElement(PaletteV2));
    expect(html).toContain(`aria-label="Variants of ${escapeHtml(entry!.primary.model)}"`);
    for (const m of entry!.models) expect(html).toContain(`data-nav-type="${escapeHtml(m.type)}"`);
    expect(html).toMatch(/aria-expanded="true"[^>]*aria-label="Hide the \d+ variants/);
  });

  it('shows a loading line before the catalog arrives', () => {
    setState({ catalog: [] });
    expect(text(render(createElement(PaletteV2)))).toContain('Loading the device catalog');
  });
});

describe('palette parts', () => {
  it('builds the category rail with group headings and skips empty categories', () => {
    const counts = categoryCounts(buildPaletteIndex(ALL_MODELS));
    const chips = railChips(counts, ALL_MODELS.length);
    expect(chips[0]).toMatchObject({ id: 'all', count: ALL_MODELS.length });
    expect(chips.slice(1).every((c) => c.count > 0)).toBe(true);
    expect(chips.slice(1).reduce((n, c) => n + c.count, 0)).toBe(ALL_MODELS.length);
    expect(chips[1]?.heading).toBeDefined();
    const html = render(createElement(CategoryRail, { counts, total: ALL_MODELS.length, active: 'all', onSelect: () => undefined }));
    expect(html).toContain('role="toolbar"');
    expect((html.match(/tabindex="0"/g) ?? []).length).toBe(1);
    expect(html).toMatch(/data-category="all"[^>]*aria-pressed="true"/);
    expect(text(html)).toContain('✓');
  });

  it('renders the search box with its shortcut and a clear button when typed', () => {
    const empty = render(createElement(PaletteSearch, { query: '', searching: false, matched: 3, total: 3, onChange: () => undefined, onEnterList: () => undefined }));
    expect(empty).toContain('aria-keyshortcuts="/"');
    expect(empty).not.toContain('Clear the search');
    const typed = render(createElement(PaletteSearch, { query: 'hub', searching: true, matched: 1, total: 3, onChange: () => undefined, onEnterList: () => undefined }));
    expect(typed).toContain('aria-label="Clear the search"');
    expect(text(typed)).toContain('1 of 3 devices matches');
  });

  it('words the search summary', () => {
    expect(searchSummary(false, 0, 1)).toBe('1 device');
    expect(searchSummary(false, 0, 54)).toBe('54 devices');
    expect(searchSummary(true, 0, 54)).toBe('No device matches');
    expect(searchSummary(true, 2, 54)).toBe('2 of 54 devices match');
    expect(isTextEntryTarget(null)).toBe(false);
  });

  it('renders variant chips with the armed chip checked', () => {
    const view = queryPalette(ALL_MODELS, EMPTY_PALETTE_QUERY);
    const entry = view.sections.flatMap((s) => s.entries).find((e) => e.hasVariants)!;
    const armed = entry.models[1]!.type;
    const html = render(createElement(VariantChips, { entry, armedType: armed, focusType: armed, id: 'v', onPick: () => undefined, onFocusType: () => undefined }));
    expect((html.match(/<button/g) ?? []).length).toBe(entry.models.length);
    expect(html).toMatch(new RegExp(`data-nav-type="${escapeHtml(armed).replace(/[.]/g, '\\.')}"[^>]*aria-pressed="true"[^>]*tabindex="0"`));
    expect(text(html)).toContain('✓');
  });

  it('detects a single placed device', () => {
    const a = { id: 'a', type: 'pc.nfpc' };
    const b = { id: 'b', type: 'hub.nfhub4' };
    expect(placedType([a], [a, b])).toBe('hub.nfhub4');
    expect(placedType([a], [a])).toBeUndefined();
    expect(placedType([], [a, b])).toBeUndefined();
    expect(placedType([a], [b, a])).toBeUndefined();
  });

  it('keeps the roving tab stop on a visible item', () => {
    expect(rovingType(['x', 'y'], 'y')).toBe('y');
    expect(rovingType(['x', 'y'], 'gone')).toBe('x');
    expect(rovingType([], null)).toBeNull();
    expect(navSelector('a"b\\c')).toBe('[data-nav-type="a\\"b\\\\c"]');
  });

  it('picks the tile detail line', () => {
    const one = { hasVariants: false, models: [] };
    expect(tileDetail({ hasVariants: true, models: [ALL_MODELS[0]!, ALL_MODELS[1]!] }, ALL_MODELS[0]!)).toBe('2 variants');
    expect(tileDetail(one, { model: 'NF-X', variant: '48-port', description: 'd' })).toBe('48-port');
    expect(tileDetail(one, { model: 'NF-X', variant: 'NF-X', description: 'd' })).toBe('d');
    expect(tileDetail(one, { model: 'NF-X', description: 'd' })).toBe('d');
  });

  it('falls back to the default width without storage and caches icons', () => {
    expect(PALETTE_WIDTH_KEY).toBe('netforge.palette.width');
    expect(readPaletteWidth()).toBe(PALETTE_WIDTH.default);
    const m = ALL_MODELS[0]!;
    expect(paletteIconMarkup(m)).toBe(paletteIconMarkup(m));
    expect(paletteIconMarkup(m)).toContain('<svg');
  });
});

// ── cable picker ─────────────────────────────────────────────────────────────

function radioSnapshot(): SimSnapshot {
  const sim = createSimulation({ seed: 3 });
  sim.loadTopology(radioBridge());
  return sim.snapshot();
}

describe('CablePicker', () => {
  it('shows the tool with the chosen cable badge while closed', () => {
    setState({ cable: { media: 'serial-dce', open: false }, tool: 'cable' });
    const html = render(createElement(CablePicker));
    expect(html).toMatch(/class="btn pv2-tool cable-tool is-active"[^>]*aria-pressed="true"/);
    expect(text(html)).toContain('DCE');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="menu"');
  });

  it('lists every picker media with a glyph, a badge and the DCE hints', () => {
    setState({ cable: { media: 'serial-dce', open: true } });
    const html = render(createElement(CablePicker));
    const rows = html.match(/role="menuitemradio"/g) ?? [];
    expect(rows).toHaveLength(MEDIA_PICKER_ORDER.length);
    for (const m of MEDIA_PICKER_ORDER) {
      expect(html).toContain(`data-media="${m}"`);
      expect(text(html)).toContain(MEDIA_VOCAB[m].badge);
    }
    expect((html.match(/class="cable-glyph"/g) ?? []).length).toBeGreaterThanOrEqual(MEDIA_PICKER_ORDER.length);
    expect(html).toMatch(/data-media="serial-dce"[^>]*class="cable-row is-checked"/);
    expect(html).toMatch(/aria-checked="true"[^>]*data-media="serial-dce"/);
    expect(text(html)).toContain(MEDIA_VOCAB['serial-dce'].dceHint!);
    expect(text(html)).toContain(MEDIA_VOCAB['serial-dte'].dceHint!);
    // the clock mark is drawn for both serial rows
    expect((html.match(/<circle/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('disables media the engine does not offer and falls back to automatic', () => {
    const table = MEDIA_TABLE.filter((m) => m.media !== 'coax');
    setState({ cable: { media: 'coax', open: true }, media: table });
    const html = render(createElement(CablePicker));
    expect(html).toMatch(/data-media="coax"[^>]*disabled=""/);
    expect(html).toMatch(/aria-checked="true"[^>]*data-media="auto"/);
  });

  it('offers radio pairing for the radio link media', () => {
    const snap = radioSnapshot();
    const detached: SimSnapshot = {
      ...snap,
      links: snap.links.filter((l) => l.kind !== 'radio'),
      devices: snap.devices.map((d) => ({ ...d, ports: d.ports.map((p) => (p.kind === 'radio' ? { ...p, link: undefined } : p)) })),
    };
    setState({ cable: { media: 'radio', open: true }, snapshot: detached });
    const html = render(createElement(CablePicker));
    expect(html).toContain('aria-label="Pair two radios"');
    expect(text(html)).toContain('RADIO1 Radio0');
    expect(text(html)).toContain('Pair radios');
    setState({ snapshot: snap });
    expect(text(render(createElement(CablePicker)))).toContain('Place two point-to-point radios');
  });

  it('lists the ports a pending cable can reach', () => {
    const sim = createSimulation({ seed: 5 });
    sim.addDevice({ id: 'pc', type: 'pc.nfpc', name: 'PC1', position: { x: 0, y: 0 } });
    sim.addDevice({ id: 'sw', type: 'switch.nfc2960', name: 'SW1', position: { x: 100, y: 0 } });
    const snapshot = sim.snapshot();
    const from = { device: 'pc', port: snapshot.devices[0]!.ports[0]!.id };
    setState({ cable: { media: 'copper-straight', open: true }, snapshot, pendingCable: { from, media: 'copper-straight' }, tool: 'cable' });
    const html = text(render(createElement(CablePicker)));
    expect(html).toContain(`From PC1 ${from.port}`);
    expect(html).toContain('SW1 FastEthernet0/1');
    expect(html).toMatch(/\d+ ports can take this cable/);
    expect(html).not.toContain(`✓ PC1`);
    const count = Number(/(\d+) ports can take this cable/.exec(html)![1]);
    if (count > CABLE_TARGET_LIST_LIMIT) expect(html).toContain('more on the canvas');
  });

  it('shows the DCE-end hint for a pending serial cable', () => {
    const sim = createSimulation({ seed: 5 });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', position: { x: 0, y: 0 } });
    const snapshot = sim.snapshot();
    const serial = snapshot.devices[0]!.ports.find((p) => p.kind === 'serial');
    expect(serial).toBeDefined();
    setState({ cable: { media: 'serial-dce', open: true }, snapshot, pendingCable: { from: { device: 'r1', port: serial!.id } }, tool: 'cable' });
    const html = text(render(createElement(CablePicker)));
    expect(html).toContain(`R1 ${serial!.id} gets the DCE end and needs "clock rate".`);
  });
});

describe('cable picker helpers', () => {
  it('gives every picker media a distinct line style', () => {
    const keys = MEDIA_PICKER_ORDER.map((m: MediaType) => {
      const g = mediaGlyphSpec(m);
      return `${g.lines.map((l) => `${l.offset}:${l.width}`).join('/')}|${g.dash ?? ''}|${g.antennas}|${g.dceEnd ?? ''}`;
    });
    expect(new Set(keys).size).toBe(keys.length);
    expect(mediaGlyphSpec('serial-dce').dceEnd).toBe('a');
    expect(mediaGlyphSpec('serial-dte').dceEnd).toBe('b');
    expect(mediaGlyphSpec('copper-straight').dash).toBeUndefined();
    expect(mediaGlyphSpec('radio').antennas).toBe(true);
    expect(colorTokenVar('blueDeep')).toBe('var(--blue-deep)');
  });

  it('finds free radio ports and looks ports up through the index', () => {
    const snap = radioSnapshot();
    expect(freeRadioPorts(snap)).toEqual([]);
    expect(freeRadioPorts(null)).toEqual([]);
    const free = freeRadioPorts({ devices: snap.devices.map((d) => ({ ...d, ports: d.ports.map((p) => ({ ...p, link: undefined })) })) });
    expect(free.map((o) => o.label)).toEqual(['RADIO1 Radio0', 'RADIO2 Radio0']);
    const index = { topologyVersion: snap.topologyVersion, devices: Object.fromEntries(snap.devices.map((d, i) => [d.id, i])), links: {} };
    const hit = lookupPort({ snapshot: snap, snapshotIndex: index }, { device: 'radio2', port: 'Radio0' });
    expect(hit?.device.name).toBe('RADIO2');
    expect(lookupPort({ snapshot: snap }, { device: 'radio2', port: 'Nope' })).toBeUndefined();
    expect(lookupPort({ snapshot: null }, { device: 'radio2', port: 'Radio0' })).toBeUndefined();
  });
});
