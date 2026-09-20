// Palette v2 query model (ARCHITECTURE-P1 §7, §8.1 W2 web-inspector): category sections in palette order,
// family variants, search over model/description/tags/capability words, recents, collapse and keyboard order.
import { describe, expect, it } from 'vitest';
import { DEVICE_CATEGORIES, defineModel } from '@netforge/engine';
import type { DeviceModel } from '@netforge/engine';
import {
  EMPTY_PALETTE_QUERY,
  PALETTE_RECENT_LIMIT,
  PALETTE_WIDTH,
  UNCATEGORISED_SECTION,
  buildPaletteIndex,
  clampPaletteWidth,
  familyKeyOf,
  highlightMatches,
  modelTooltip,
  movePaletteFocus,
  pruneRecent,
  pushRecent,
  queryPalette,
  sanitizeCollapsed,
  sanitizeRecent,
  searchTokens,
  selectedVariant,
  toggleCollapsed,
  toggleExpandedFamily,
  variantLabel,
} from '../src/app/palette/palette-query.js';
import type { PaletteQueryInput } from '../src/app/palette/palette-query.js';

const eth = (name: string, speedBps = 1_000_000_000, autoMdix = false) => ({ name, kind: 'ethernet' as const, speedBps, autoMdix });

const ROUTER = defineModel({
  type: 'router.nf2911', model: 'NF-2911', description: 'Branch router with serial WAN ports', category: 'routers', icon: 'router',
  capabilities: ['routing'], ports: [eth('GigabitEthernet0/0'), eth('GigabitEthernet0/1')],
}, 'P0.5');
const SWITCH_24 = defineModel({
  type: 'switch.nfc2960', model: 'NF-C2960', description: 'Access switch with 24 ports', category: 'switches', icon: 'switch',
  capabilities: ['switching'], family: 'nf-c2960', variant: '24-port', ports: [eth('FastEthernet0/1', 100_000_000, true)],
}, 'P0.5');
const SWITCH_8 = defineModel({
  type: 'switch.nfc2960-8', model: 'NF-C2960-8TC', description: 'Compact access switch', category: 'switches', icon: 'switch',
  capabilities: ['switching'], family: 'nf-c2960', variant: '8-port', tags: ['Compact', 'desk'], ports: [eth('FastEthernet0/1', 100_000_000, true)],
}, 'P0.5');
const HUB = defineModel({
  type: 'hub.nfhub4', model: 'NF-HUB-4', description: 'Four-port shared segment', category: 'legacy', icon: 'hub',
  capabilities: ['repeater'], ports: [eth('Ethernet0', 10_000_000)],
}, 'P0.5');
const PC = defineModel({
  type: 'pc.nfpc', model: 'NF-PC', description: 'Workstation with one network adapter', category: 'computers', icon: 'pc',
  capabilities: ['host'], ports: [eth('GigabitEthernet0')],
}, 'P0.5');
const FIXTURE: DeviceModel = { ...PC, type: 'pc.fixture', model: 'NF-FIXTURE', family: undefined, category: undefined, description: 'Hand-built test model' };

// Deliberately not in category order: sections must follow DEVICE_CATEGORIES, not the list.
const CATALOG: readonly DeviceModel[] = [PC, FIXTURE, SWITCH_24, HUB, ROUTER, SWITCH_8];

const q = (patch: Partial<PaletteQueryInput> = {}): PaletteQueryInput => ({ ...EMPTY_PALETTE_QUERY, ...patch });

describe('palette sections and families', () => {
  it('orders sections by DEVICE_CATEGORIES and puts uncategorised models last', () => {
    const view = queryPalette(CATALOG, q());
    const order = DEVICE_CATEGORIES.map((c) => c.id as string);
    const ids = view.sections.map((s) => s.id);
    expect(ids).toEqual(['routers', 'switches', 'legacy', 'computers', UNCATEGORISED_SECTION]);
    const known = ids.filter((id) => id !== UNCATEGORISED_SECTION).map((id) => order.indexOf(id));
    expect([...known].sort((a, b) => a - b)).toEqual(known);
    expect(view.total).toBe(6);
    expect(view.matched).toBe(6);
    expect(view.sections.find((s) => s.id === 'switches')?.label).toBe('Switches');
    expect(view.sections.at(-1)?.label).toBe('Uncategorised');
  });

  it('groups variants of one family into one tile in catalog order', () => {
    const switches = queryPalette(CATALOG, q()).sections.find((s) => s.id === 'switches');
    expect(switches?.entries).toHaveLength(1);
    const tile = switches!.entries[0]!;
    expect(tile.key).toBe('nf-c2960');
    expect(tile.models.map((m) => m.type)).toEqual(['switch.nfc2960', 'switch.nfc2960-8']);
    expect(tile.primary.type).toBe('switch.nfc2960');
    expect(tile.hasVariants).toBe(true);
    expect(switches!.count).toBe(2);
    expect(variantLabel(SWITCH_8)).toBe('8-port');
    expect(variantLabel({ model: 'NF-X', variant: undefined })).toBe('NF-X');
    expect(selectedVariant(tile, 'switch.nfc2960-8').type).toBe('switch.nfc2960-8');
    expect(selectedVariant(tile, 'router.nf2911').type).toBe('switch.nfc2960');
    expect(familyKeyOf({ type: 'pc.fixture', family: undefined })).toBe('pc.fixture');
  });

  it('counts models per category over the whole catalog for the rail', () => {
    const counts = queryPalette(CATALOG, q({ query: 'router' })).categoryCounts;
    expect(counts.map((c) => c.id)).toEqual(DEVICE_CATEGORIES.map((c) => c.id));
    expect(counts.find((c) => c.id === 'switches')?.count).toBe(2);
    expect(counts.find((c) => c.id === 'iot')?.count).toBe(0);
  });

  it('filters by the chosen category', () => {
    const view = queryPalette(CATALOG, q({ category: 'legacy' }));
    expect(view.sections.map((s) => s.id)).toEqual(['legacy']);
    expect(view.matched).toBe(1);
  });
});

describe('palette search', () => {
  it('normalizes tokens', () => {
    expect(searchTokens('  NF-C2960   poe  poe ')).toEqual(['nf-c2960', 'poe']);
    expect(searchTokens('   ')).toEqual([]);
  });

  it('requires every token and keeps only matching variants', () => {
    const view = queryPalette(CATALOG, q({ query: 'c2960 8' }));
    expect(view.searching).toBe(true);
    const tiles = view.sections.flatMap((s) => s.entries);
    expect(tiles).toHaveLength(1);
    expect(tiles[0]!.models.map((m) => m.type)).toEqual(['switch.nfc2960-8']);
    expect(tiles[0]!.hasVariants).toBe(false);
    expect(queryPalette(CATALOG, q({ query: 'switch zebra' })).matched).toBe(0);
  });

  it('matches tags, capability words, description and compact model names', () => {
    const types = (query: string): string[] => queryPalette(CATALOG, q({ query })).sections.flatMap((s) => s.entries.flatMap((e) => e.models.map((m) => m.type)));
    expect(types('desk')).toEqual(['switch.nfc2960-8']);
    expect(types('collision')).toEqual(['hub.nfhub4']);
    expect(types('workstation')).toEqual(['pc.nfpc']);
    expect(types('nfc2960')).toEqual(['switch.nfc2960', 'switch.nfc2960-8']);
    expect(types('Legacy')).toEqual(['hub.nfhub4']);
  });

  it('ranks a model-name hit above a description hit and keeps catalog order on ties', () => {
    const catalog: DeviceModel[] = [
      { ...PC, type: 'pc.a', model: 'NF-ALPHA', family: 'a', description: 'Talks to the router upstairs' },
      { ...PC, type: 'pc.b', model: 'NF-ROUTER-LAB', family: 'b', description: 'Plain box' },
      { ...PC, type: 'pc.c', model: 'NF-GAMMA', family: 'c', description: 'Near a router too' },
    ];
    const tiles = queryPalette(catalog, q({ query: 'router' })).sections[0]!.entries.map((e) => e.key);
    expect(tiles).toEqual(['b', 'a', 'c']);
  });

  it('shows collapsed sections expanded and hides recents while searching', () => {
    const view = queryPalette(CATALOG, q({ query: 'switch', collapsed: { switches: true }, recent: ['pc.nfpc'] }));
    expect(view.sections.find((s) => s.id === 'switches')?.collapsed).toBe(false);
    expect(view.recent).toEqual([]);
  });

  it('accepts a prebuilt index with identical results', () => {
    const index = buildPaletteIndex(CATALOG);
    expect(queryPalette(index, q({ query: 'hub' }))).toEqual(queryPalette(CATALOG, q({ query: 'hub' })));
  });

  it('splits text into highlighted runs', () => {
    expect(highlightMatches('NF-C2960-8TC', 'c29 8t')).toEqual([
      { text: 'NF-', match: false },
      { text: 'C29', match: true },
      { text: '60-', match: false },
      { text: '8T', match: true },
      { text: 'C', match: false },
    ]);
    expect(highlightMatches('abc', '')).toEqual([{ text: 'abc', match: false }]);
    expect(highlightMatches('', 'x')).toEqual([]);
  });

  it('writes an original tooltip naming the category', () => {
    expect(modelTooltip(HUB)).toBe('NF-HUB-4 (Legacy)\nFour-port shared segment\nClick, then click the canvas to place one.');
  });
});

describe('palette state, recents and keyboard', () => {
  it('keeps recents most recent first, de-duplicated and capped', () => {
    let recent: string[] = [];
    for (let i = 0; i < PALETTE_RECENT_LIMIT + 3; i++) recent = pushRecent(recent, `t${i}`);
    expect(recent).toHaveLength(PALETTE_RECENT_LIMIT);
    expect(recent[0]).toBe(`t${PALETTE_RECENT_LIMIT + 2}`);
    expect(pushRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    expect(pruneRecent(['pc.nfpc', 'gone', 'pc.nfpc', 'hub.nfhub4'], CATALOG)).toEqual(['pc.nfpc', 'hub.nfhub4']);
    expect(sanitizeRecent(['a', 3, 'a', '', 'b'])).toEqual(['a', 'b']);
    expect(sanitizeRecent('nope')).toEqual([]);
  });

  it('builds keyboard order from recents, open sections and expanded families', () => {
    const closed = queryPalette(CATALOG, q({ recent: ['hub.nfhub4', 'missing'], collapsed: { computers: true } }));
    expect(closed.recent.map((m) => m.type)).toEqual(['hub.nfhub4']);
    expect(closed.order).toEqual(['hub.nfhub4', 'router.nf2911', 'switch.nfc2960', 'pc.fixture']);
    const open = queryPalette(CATALOG, q({ expandedFamily: 'nf-c2960' }));
    expect(open.sections.find((s) => s.id === 'switches')?.entries[0]?.expanded).toBe(true);
    expect(open.order).toEqual(['router.nf2911', 'switch.nfc2960', 'switch.nfc2960-8', 'hub.nfhub4', 'pc.nfpc', 'pc.fixture']);
  });

  it('moves focus with clamping at both ends', () => {
    const order = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    expect(movePaletteFocus(order, null, 'ArrowDown')).toBe('a');
    expect(movePaletteFocus(order, null, 'ArrowUp')).toBe('g');
    expect(movePaletteFocus(order, 'a', 'ArrowUp')).toBe('a');
    expect(movePaletteFocus(order, 'g', 'ArrowDown')).toBe('g');
    expect(movePaletteFocus(order, 'b', 'PageDown')).toBe('g');
    expect(movePaletteFocus(order, 'f', 'PageUp')).toBe('a');
    expect(movePaletteFocus(order, 'c', 'Home')).toBe('a');
    expect(movePaletteFocus(order, 'c', 'End')).toBe('g');
    expect(movePaletteFocus(order, 'gone', 'PageUp')).toBe('g');
    expect(movePaletteFocus([], 'a', 'ArrowDown')).toBeUndefined();
  });

  it('toggles and sanitizes collapse state, expanded family and width', () => {
    const once = toggleCollapsed({ routers: true, legacy: false }, 'switches');
    expect(once).toEqual({ routers: true, switches: true });
    expect(toggleCollapsed(once, 'routers')).toEqual({ switches: true });
    expect(sanitizeCollapsed({ a: true, b: 'yes', c: false, '': true })).toEqual({ a: true });
    expect(sanitizeCollapsed([true])).toEqual({});
    expect(toggleExpandedFamily(null, 'x')).toBe('x');
    expect(toggleExpandedFamily('x', 'x')).toBeNull();
    expect(clampPaletteWidth(10)).toBe(PALETTE_WIDTH.min);
    expect(clampPaletteWidth(9999)).toBe(PALETTE_WIDTH.max);
    expect(clampPaletteWidth(250.6)).toBe(251);
    expect(clampPaletteWidth(Number.NaN)).toBe(PALETTE_WIDTH.default);
  });
});
