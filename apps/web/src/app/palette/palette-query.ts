/**
 * Palette v2 query model (ARCHITECTURE-P1 §7 "Palette v2", §8.1 W2 web-inspector).
 *
 * Pure functions that turn the catalog (`DeviceModel[]`, palette order from `DeviceCatalog.list()`) and the
 * palette UI state (`PaletteUiState`: search text, category rail choice, collapsed groups, the expanded family,
 * recently placed models) into what the palette renders: category sections in DEVICE_CATEGORIES order, one
 * entry per family with its variant chips, recents, and the keyboard focus order.
 *
 * Search covers the model name, type id, variant, family, tags, category label, capability search words and the
 * description. Every query token must match some field (AND); a token scores by the best field it hits (exact
 * word, word prefix or substring, times the field weight). Ties keep catalog order, so results are stable.
 * Grouping never depends on `DeviceModel.kind` (D2): categories and families are data.
 *
 * The React components (Palette, CategoryRail, PaletteSearch, VariantChips) arrive in W6 and only call these
 * helpers. All wording is original (§1.6).
 */
import type { CategoryGroup, DeviceCategory, DeviceModel } from '@netforge/engine';
import { CATEGORY_ORDER, CATEGORY_VOCAB, UNCATEGORISED_LABEL, capabilityWords, isDeviceCategory } from '../../vocab/categories.js';

// ── constants ────────────────────────────────────────────────────────────────

/** Most recently placed models kept in `PaletteUiState.recent`. */
export const PALETTE_RECENT_LIMIT = 8;

/** Section id of models without a known category (hand-built fixtures). */
export const UNCATEGORISED_SECTION = 'uncategorised';

/** Resizable palette width limits in CSS pixels. */
export const PALETTE_WIDTH = Object.freeze({ min: 180, max: 420, default: 240 });

/** Relative weight of each searchable field (higher ranks first). */
export const SEARCH_FIELD_WEIGHTS = Object.freeze({
  model: 100,
  type: 80,
  variant: 60,
  family: 50,
  tag: 40,
  category: 30,
  capability: 20,
  description: 10,
});

/** Name of a searchable field. */
export type SearchFieldName = keyof typeof SEARCH_FIELD_WEIGHTS;

/** Score multipliers by how a token matched a field. */
const EXACT_WORD = 3;
const WORD_PREFIX = 2;
const SUBSTRING = 1;

// ── state ────────────────────────────────────────────────────────────────────

/** The part of `PaletteUiState` (store/types.ts) the query needs. */
export interface PaletteQueryInput {
  readonly query: string;
  readonly category: DeviceCategory | 'all';
  readonly collapsed: Readonly<Record<string, boolean>>;
  readonly expandedFamily: string | null;
  readonly recent: readonly string[];
}

/** Default palette state: no search, every category, nothing collapsed or expanded, no recents. */
export const EMPTY_PALETTE_QUERY: PaletteQueryInput = Object.freeze({
  query: '',
  category: 'all',
  collapsed: Object.freeze({}),
  expandedFamily: null,
  recent: Object.freeze([]),
});

// ── search index ─────────────────────────────────────────────────────────────

/** One searchable text of a model. */
export interface SearchField {
  readonly name: SearchFieldName;
  /** Normalized text (lower case, single spaces). */
  readonly text: string;
  /** `text` split into words (spaces, hyphens, slashes, dots and underscores separate words). */
  readonly words: readonly string[];
  /** `text` with everything but letters and digits removed ("nf-c2960" → "nfc2960"). */
  readonly compact: string;
  readonly weight: number;
}

/** A model with its searchable fields and catalog position. */
export interface IndexedModel {
  readonly model: DeviceModel;
  /** Position in catalog order. */
  readonly order: number;
  /** Section id: the category, or UNCATEGORISED_SECTION. */
  readonly section: string;
  /** Family key: `model.family`, else the type id. */
  readonly family: string;
  readonly fields: readonly SearchField[];
}

/** Precomputed search data for a catalog (build once per catalog, query on every keystroke). */
export interface PaletteIndex {
  readonly models: readonly IndexedModel[];
  readonly byType: ReadonlyMap<string, IndexedModel>;
}

/** Lower-case, trimmed text with runs of whitespace folded to one space. */
export function normalizeSearchText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Distinct search tokens of a query, in typed order. */
export function searchTokens(query: string): readonly string[] {
  const out: string[] = [];
  for (const t of normalizeSearchText(query).split(' ')) {
    if (t !== '' && !out.includes(t)) out.push(t);
  }
  return out;
}

function wordsOf(text: string): string[] {
  return text.split(/[\s\-/._]+/).filter((w) => w !== '');
}

function compactOf(text: string): string {
  return text.replace(/[^a-z0-9]+/g, '');
}

function field(name: SearchFieldName, raw: string): SearchField {
  const text = normalizeSearchText(raw);
  return Object.freeze({ name, text, words: Object.freeze(wordsOf(text)), compact: compactOf(text), weight: SEARCH_FIELD_WEIGHTS[name] });
}

/** Section id of a model (its category, or UNCATEGORISED_SECTION when absent or unknown). */
export function sectionOf(model: Pick<DeviceModel, 'category'>): string {
  return model.category !== undefined && isDeviceCategory(model.category) ? model.category : UNCATEGORISED_SECTION;
}

/** Family key of a model: `family` when set, else its type id (a family of one). */
export function familyKeyOf(model: Pick<DeviceModel, 'family' | 'type'>): string {
  return model.family !== undefined && model.family !== '' ? model.family : model.type;
}

/** Searchable fields of one model, highest weight first. Empty texts are left out. */
export function modelSearchFields(model: DeviceModel): readonly SearchField[] {
  const out: SearchField[] = [field('model', model.model), field('type', model.type)];
  if (model.variant !== undefined && model.variant !== '') out.push(field('variant', model.variant));
  if (model.family !== undefined && model.family !== '') out.push(field('family', model.family));
  for (const tag of model.tags ?? []) out.push(field('tag', tag));
  const section = sectionOf(model);
  if (section !== UNCATEGORISED_SECTION) out.push(field('category', CATEGORY_VOCAB[section as DeviceCategory].label));
  for (const word of capabilityWords(model.capabilities ?? [])) out.push(field('capability', word));
  out.push(field('description', model.description));
  return Object.freeze(out.filter((f) => f.text !== ''));
}

/** Build the search index of a catalog (models in the given order). */
export function buildPaletteIndex(catalog: readonly DeviceModel[]): PaletteIndex {
  const models: IndexedModel[] = [];
  const byType = new Map<string, IndexedModel>();
  catalog.forEach((model, order) => {
    const entry: IndexedModel = Object.freeze({
      model,
      order,
      section: sectionOf(model),
      family: familyKeyOf(model),
      fields: modelSearchFields(model),
    });
    models.push(entry);
    if (!byType.has(model.type)) byType.set(model.type, entry);
  });
  return Object.freeze({ models: Object.freeze(models), byType });
}

/** Score of one token against one field (0 = no match). */
export function tokenFieldScore(token: string, f: SearchField): number {
  if (f.words.includes(token)) return f.weight * EXACT_WORD;
  if (f.words.some((w) => w.startsWith(token))) return f.weight * WORD_PREFIX;
  if (f.text.includes(token)) return f.weight * SUBSTRING;
  const compactToken = compactOf(token);
  if (compactToken !== '' && f.compact.includes(compactToken)) return f.weight * SUBSTRING;
  return 0;
}

/** Search score of a model for `tokens`: the sum of each token's best field score, or 0 when any token misses. No tokens → 1. */
export function scoreModel(entry: Pick<IndexedModel, 'fields'>, tokens: readonly string[]): number {
  if (tokens.length === 0) return 1;
  let total = 0;
  for (const token of tokens) {
    let best = 0;
    for (const f of entry.fields) {
      const s = tokenFieldScore(token, f);
      if (s > best) best = s;
    }
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

// ── query result ─────────────────────────────────────────────────────────────

/** One palette tile: a family of variants (or a single model). */
export interface PaletteEntry {
  /** Family key (stable React key; `PaletteUiState.expandedFamily` names it). */
  readonly key: string;
  /** Visible variants in catalog order (search results keep only matching variants). */
  readonly models: readonly DeviceModel[];
  /** The model the tile places by default: the first visible variant. */
  readonly primary: DeviceModel;
  /** More than one visible variant: the tile shows variant chips. */
  readonly hasVariants: boolean;
  /** The family is expanded (its variants take part in keyboard order). */
  readonly expanded: boolean;
  /** Best variant score (1 without a search). */
  readonly score: number;
}

/** One category section of the palette. */
export interface PaletteSection {
  /** Category id or UNCATEGORISED_SECTION. */
  readonly id: string;
  readonly category?: DeviceCategory;
  readonly label: string;
  readonly hint: string;
  /** Undefined for the uncategorised section. */
  readonly group?: CategoryGroup;
  /** Collapsed sections hide their entries; a search always shows them expanded. */
  readonly collapsed: boolean;
  readonly entries: readonly PaletteEntry[];
  /** Visible models in the section. */
  readonly count: number;
}

/** Everything the palette renders for one state. */
export interface PaletteView {
  readonly tokens: readonly string[];
  /** A non-empty search is active. */
  readonly searching: boolean;
  readonly category: DeviceCategory | 'all';
  readonly sections: readonly PaletteSection[];
  /** Recently placed models still in the catalog (empty while searching). */
  readonly recent: readonly DeviceModel[];
  /** Models matching search and category. */
  readonly matched: number;
  /** Models in the catalog. */
  readonly total: number;
  /** Model counts per category over the whole catalog (the category rail badges), in palette order. */
  readonly categoryCounts: readonly { readonly id: DeviceCategory; readonly label: string; readonly count: number }[];
  /** Model types in keyboard focus order: recents, then each open section's tiles (expanded families list every variant). */
  readonly order: readonly string[];
}

function isIndex(x: PaletteIndex | readonly DeviceModel[]): x is PaletteIndex {
  return !Array.isArray(x);
}

/**
 * Compute the palette view for `input` over a catalog or a prebuilt index.
 * Sections follow DEVICE_CATEGORIES order (uncategorised last); without a search, tiles keep catalog order;
 * with a search, tiles are ordered by score (ties keep catalog order) and sections containing no match are
 * left out. Empty sections are always left out.
 */
export function queryPalette(source: PaletteIndex | readonly DeviceModel[], input: PaletteQueryInput): PaletteView {
  const index = isIndex(source) ? source : buildPaletteIndex(source);
  const tokens = searchTokens(input.query);
  const searching = tokens.length > 0;

  const perSection = new Map<string, Map<string, { models: DeviceModel[]; score: number; first: number }>>();
  let matched = 0;
  for (const entry of index.models) {
    if (input.category !== 'all' && entry.section !== input.category) continue;
    const score = scoreModel(entry, tokens);
    if (score === 0) continue;
    matched++;
    let families = perSection.get(entry.section);
    if (families === undefined) {
      families = new Map();
      perSection.set(entry.section, families);
    }
    const fam = families.get(entry.family);
    if (fam === undefined) families.set(entry.family, { models: [entry.model], score, first: entry.order });
    else {
      fam.models.push(entry.model);
      if (score > fam.score) fam.score = score;
    }
  }

  const sectionIds: string[] = [...CATEGORY_ORDER, UNCATEGORISED_SECTION];
  const sections: PaletteSection[] = [];
  for (const id of sectionIds) {
    const families = perSection.get(id);
    if (families === undefined || families.size === 0) continue;
    const list = [...families.entries()].map(([key, fam]) => ({ key, ...fam }));
    if (searching) list.sort((a, b) => b.score - a.score || a.first - b.first);
    else list.sort((a, b) => a.first - b.first);
    const entries: PaletteEntry[] = list.map((fam) =>
      Object.freeze({
        key: fam.key,
        models: Object.freeze([...fam.models]),
        primary: fam.models[0] as DeviceModel,
        hasVariants: fam.models.length > 1,
        expanded: input.expandedFamily === fam.key && fam.models.length > 1,
        score: fam.score,
      }),
    );
    const count = entries.reduce((n, e) => n + e.models.length, 0);
    const collapsed = !searching && input.collapsed[id] === true;
    if (id === UNCATEGORISED_SECTION) {
      sections.push(Object.freeze({ id, label: UNCATEGORISED_LABEL, hint: 'Devices without a palette category.', collapsed, entries: Object.freeze(entries), count }));
    } else {
      const v = CATEGORY_VOCAB[id as DeviceCategory];
      sections.push(Object.freeze({ id, category: v.id, label: v.label, hint: v.hint, group: v.group, collapsed, entries: Object.freeze(entries), count }));
    }
  }

  const recent = searching ? [] : recentModels(index, input.recent);
  const order: string[] = [];
  const pushOrder = (type: string): void => {
    if (!order.includes(type)) order.push(type);
  };
  for (const m of recent) pushOrder(m.type);
  for (const s of sections) {
    if (s.collapsed) continue;
    for (const e of s.entries) {
      if (e.expanded) for (const m of e.models) pushOrder(m.type);
      else pushOrder(e.primary.type);
    }
  }

  return Object.freeze({
    tokens,
    searching,
    category: input.category,
    sections: Object.freeze(sections),
    recent: Object.freeze(recent),
    matched,
    total: index.models.length,
    categoryCounts: categoryCounts(index),
    order: Object.freeze(order),
  });
}

/** Model counts per category over the whole index, in palette order (categories without models included with 0). */
export function categoryCounts(index: PaletteIndex): readonly { readonly id: DeviceCategory; readonly label: string; readonly count: number }[] {
  const counts = new Map<string, number>();
  for (const m of index.models) counts.set(m.section, (counts.get(m.section) ?? 0) + 1);
  return Object.freeze(CATEGORY_ORDER.map((id) => Object.freeze({ id, label: CATEGORY_VOCAB[id].label, count: counts.get(id) ?? 0 })));
}

/** Models named by `recent` that exist in the index, in `recent` order, without duplicates. */
export function recentModels(index: PaletteIndex, recent: readonly string[]): DeviceModel[] {
  const out: DeviceModel[] = [];
  for (const type of recent) {
    const m = index.byType.get(type);
    if (m !== undefined && !out.includes(m.model)) out.push(m.model);
  }
  return out;
}

/** The variant of `entry` that is currently chosen by the add-device tool, else the primary model. */
export function selectedVariant(entry: PaletteEntry, addDeviceType: string | null): DeviceModel {
  return entry.models.find((m) => m.type === addDeviceType) ?? entry.primary;
}

/** Chip label of a variant: `variant`, else the model name. */
export function variantLabel(model: Pick<DeviceModel, 'variant' | 'model'>): string {
  return model.variant !== undefined && model.variant !== '' ? model.variant : model.model;
}

/** Tooltip text of a palette tile (original wording). */
export function modelTooltip(model: DeviceModel): string {
  const section = sectionOf(model);
  const category = section === UNCATEGORISED_SECTION ? UNCATEGORISED_LABEL : CATEGORY_VOCAB[section as DeviceCategory].label;
  return `${model.model} (${category})\n${model.description}\nClick, then click the canvas to place one.`;
}

// ── state updates ────────────────────────────────────────────────────────────

/** `recent` with `type` moved to the front, de-duplicated and cut to `limit`. */
export function pushRecent(recent: readonly string[], type: string, limit: number = PALETTE_RECENT_LIMIT): string[] {
  const out = [type, ...recent.filter((t) => t !== type)];
  return out.slice(0, Math.max(0, limit));
}

/** `recent` without types missing from the catalog (and without duplicates). */
export function pruneRecent(recent: readonly string[], catalog: readonly Pick<DeviceModel, 'type'>[]): string[] {
  const known = new Set(catalog.map((m) => m.type));
  const out: string[] = [];
  for (const t of recent) if (known.has(t) && !out.includes(t)) out.push(t);
  return out;
}

/** `collapsed` with section `id` toggled; expanded sections are removed so the persisted record stays small. */
export function toggleCollapsed(collapsed: Readonly<Record<string, boolean>>, id: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(collapsed)) if (k !== id && v) out[k] = true;
  if (collapsed[id] !== true) out[id] = true;
  return out;
}

/** Expanded family after a click on a tile's variant toggle (a second click closes it). */
export function toggleExpandedFamily(current: string | null, key: string): string | null {
  return current === key ? null : key;
}

/** Collapsed record read from storage: only `true` boolean values with non-empty keys survive. */
export function sanitizeCollapsed(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (k !== '' && v === true) out[k] = true;
  return out;
}

/** Recent list read from storage: strings only, de-duplicated, cut to `limit`. */
export function sanitizeRecent(raw: unknown, limit: number = PALETTE_RECENT_LIMIT): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) if (typeof v === 'string' && v !== '' && !out.includes(v)) out.push(v);
  return out.slice(0, Math.max(0, limit));
}

/** Palette width clamped to PALETTE_WIDTH and rounded to whole pixels (non-finite → default). */
export function clampPaletteWidth(width: number): number {
  if (!Number.isFinite(width)) return PALETTE_WIDTH.default;
  return Math.min(PALETTE_WIDTH.max, Math.max(PALETTE_WIDTH.min, Math.round(width)));
}

// ── keyboard ─────────────────────────────────────────────────────────────────

/** Keys the palette list handles itself. */
export type PaletteNavKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End' | 'PageDown' | 'PageUp';

/** Rows moved by PageDown / PageUp. */
export const PALETTE_PAGE_STEP = 5;

/** True for keys handled by `movePaletteFocus`. */
export function isPaletteNavKey(key: string): key is PaletteNavKey {
  return key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End' || key === 'PageDown' || key === 'PageUp';
}

/**
 * Next focused model type in `order` for a navigation key. Movement clamps at both ends (no wrap). With no
 * current focus (or a type no longer visible) ArrowDown/Home/PageDown go to the first item and the rest to the last.
 * Undefined when `order` is empty.
 */
export function movePaletteFocus(order: readonly string[], current: string | null | undefined, key: PaletteNavKey): string | undefined {
  if (order.length === 0) return undefined;
  const last = order.length - 1;
  const i = current === null || current === undefined ? -1 : order.indexOf(current);
  if (key === 'Home') return order[0];
  if (key === 'End') return order[last];
  if (i < 0) return key === 'ArrowDown' || key === 'PageDown' ? order[0] : order[last];
  const step = key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : key === 'PageDown' ? PALETTE_PAGE_STEP : -PALETTE_PAGE_STEP;
  return order[Math.min(last, Math.max(0, i + step))];
}

// ── highlighting ─────────────────────────────────────────────────────────────

/** A run of text, marked when it matches a search token. */
export interface HighlightSegment {
  readonly text: string;
  readonly match: boolean;
}

/** Split `text` into matched and unmatched runs for the query tokens (case-insensitive; overlapping hits merge). */
export function highlightMatches(text: string, query: string | readonly string[]): readonly HighlightSegment[] {
  const tokens = typeof query === 'string' ? searchTokens(query) : query;
  if (text === '') return [];
  const lower = text.toLowerCase();
  const marks = new Array<boolean>(text.length).fill(false);
  for (const token of tokens) {
    if (token === '') continue;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(token, from);
      if (at < 0) break;
      for (let k = at; k < at + token.length; k++) marks[k] = true;
      from = at + 1;
    }
  }
  const out: HighlightSegment[] = [];
  let start = 0;
  for (let k = 1; k <= text.length; k++) {
    if (k === text.length || marks[k] !== marks[start]) {
      out.push(Object.freeze({ text: text.slice(start, k), match: marks[start] === true }));
      start = k;
    }
  }
  return Object.freeze(out);
}
