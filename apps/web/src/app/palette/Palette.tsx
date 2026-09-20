/**
 * Palette v2 (ARCHITECTURE-P1 §7 "Palette v2", §8.1 W6 web-inspector): tools (select, cable with the media
 * picker), search, category rail, recently used models and one collapsible section per category with a tile per
 * family and variant chips. Everything the palette shows comes from `queryPalette` (palette-query.ts) over the
 * catalog and `PaletteUiState`; nothing branches on `DeviceModel.kind` (D2). Icons come from the icon registry.
 *
 * Keyboard: one tab stop for the list (roving tabindex); ArrowUp/Down, PageUp/Down, Home/End walk the focus
 * order of palette-query (recents, then open sections, expanded variants included); ArrowRight opens a family's
 * variants and ArrowLeft closes them; Enter/Space arms the model. `/` focuses the search box.
 *
 * Width: resizable between PALETTE_WIDTH.min and .max by the right-edge separator (pointer or arrow keys). The
 * width is written to the `--palette-w` CSS variable the app grid reads, and remembered in localStorage.
 *
 * Exported as `PaletteV2` (pinned name the app frame imports).
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import type { DeviceCategory, DeviceModel, DeviceSnapshot } from '@netforge/engine';
import { iconToSvg } from '../../catalog/render-svg.js';
import { visualForModel } from '../../catalog/visuals.js';
import { store, useStore } from '../../store/store';
import { CATEGORY_GROUP_VOCAB } from '../../vocab/categories.js';
import { CablePicker } from '../cable/CablePicker';
import { CategoryRail } from './CategoryRail';
import {
  PALETTE_WIDTH,
  buildPaletteIndex,
  clampPaletteWidth,
  highlightMatches,
  isPaletteNavKey,
  modelTooltip,
  movePaletteFocus,
  queryPalette,
  selectedVariant,
  toggleExpandedFamily,
} from './palette-query.js';
import type { PaletteEntry, PaletteQueryInput, PaletteSection, PaletteView } from './palette-query.js';
import { PaletteSearch } from './PaletteSearch';
import { VariantChips } from './VariantChips';
import './palette.css';

/** localStorage key of the palette width. */
export const PALETTE_WIDTH_KEY = 'netforge.palette.width';
/** Pixels one arrow key press resizes the palette by. */
export const PALETTE_RESIZE_STEP = 16;

/** Stored palette width, clamped (default when storage is unavailable or holds nothing usable). */
export function readPaletteWidth(): number {
  try {
    const raw = localStorage.getItem(PALETTE_WIDTH_KEY);
    if (raw !== null && raw.trim() !== '') return clampPaletteWidth(Number(raw));
  } catch {
    /* storage unavailable: use the default */
  }
  return PALETTE_WIDTH.default;
}

function persistPaletteWidth(width: number): void {
  try {
    localStorage.setItem(PALETTE_WIDTH_KEY, String(width));
  } catch {
    /* storage unavailable: the width simply does not persist */
  }
}

const iconCache = new Map<string, string>();

/** Inline SVG markup of a model's registry icon (generated from registry data only; cached per icon + badge). */
export function paletteIconMarkup(model: Pick<DeviceModel, 'kind' | 'icon' | 'capabilities'>): string {
  const def = visualForModel(model);
  const key = `${def.id}|${def.badge ?? ''}`;
  let svg = iconCache.get(key);
  if (svg === undefined) {
    svg = iconToSvg(def, { size: 28, className: 'pv2-svg' });
    iconCache.set(key, svg);
  }
  return svg;
}

/**
 * Type of the device a snapshot change added by placing one device: `after` has exactly one more device than
 * `before`, the new one last (snapshots list devices in creation order). Undefined otherwise (loads, removals).
 */
export function placedType(before: readonly Pick<DeviceSnapshot, 'id' | 'type'>[], after: readonly Pick<DeviceSnapshot, 'id' | 'type'>[]): string | undefined {
  if (after.length !== before.length + 1) return undefined;
  const added = after[after.length - 1];
  if (added === undefined || before.some((d) => d.id === added.id)) return undefined;
  return added.type;
}

/** Attribute selector for a model type (quotes and backslashes escaped). */
export function navSelector(type: string): string {
  return `[data-nav-type="${type.replace(/["\\]/g, '\\$&')}"]`;
}

/** The type that holds the list's tab stop: the remembered focus when still visible, else the first item. */
export function rovingType(order: readonly string[], focus: string | null): string | null {
  if (focus !== null && order.includes(focus)) return focus;
  return order[0] ?? null;
}

/**
 * Second line of a tile: the variant count for a family with several visible variants, else the variant name when
 * it says more than the model name, else the description (so a search hit in the description is visible).
 */
export function tileDetail(entry: Pick<PaletteEntry, 'hasVariants' | 'models'>, model: Pick<DeviceModel, 'model' | 'variant' | 'description'>): string {
  if (entry.hasVariants) return `${entry.models.length} variants`;
  if (model.variant !== undefined && model.variant !== '' && model.variant !== model.model) return model.variant;
  return model.description;
}

function Highlighted({ text, tokens }: { text: string; tokens: readonly string[] }) {
  if (tokens.length === 0) return <>{text}</>;
  return (
    <>
      {highlightMatches(text, tokens).map((seg, i) =>
        seg.match ? (
          <mark key={i} className="pv2-hit">
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

function SelectGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="pv2-tool-glyph">
      <polygon points="6,3 18,13 12,14 15,21 13,22 10,15 6,19" />
    </svg>
  );
}

interface TileProps {
  entry: PaletteEntry;
  tokens: readonly string[];
  armedType: string | null;
  tabType: string | null;
  compact: boolean;
  onPick: (model: DeviceModel) => void;
  onFocusType: (type: string) => void;
  onToggleVariants: (key: string) => void;
}

function PaletteTile({ entry, tokens, armedType, tabType, compact, onPick, onFocusType, onToggleVariants }: TileProps) {
  const variantsId = useId();
  const model = selectedVariant(entry, armedType);
  const armed = entry.models.some((m) => m.type === armedType);
  const navType = entry.primary.type;
  const detail = tileDetail(entry, model);
  return (
    <li className={`pv2-entry ${compact ? 'is-compact' : ''}`}>
      <div className="pv2-tile-row">
        <button
          type="button"
          data-nav-type={navType}
          data-family={entry.key}
          className={`pv2-tile ${armed ? 'is-armed' : ''}`}
          aria-pressed={armed}
          aria-keyshortcuts={entry.hasVariants ? 'ArrowRight ArrowLeft' : undefined}
          tabIndex={tabType === navType ? 0 : -1}
          title={modelTooltip(model)}
          onFocus={() => onFocusType(navType)}
          onClick={() => onPick(model)}
        >
          <span className="pv2-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: paletteIconMarkup(model) }} />
          <span className="pv2-tile-text">
            <span className="pv2-model">
              <Highlighted text={model.model} tokens={tokens} />
            </span>
            {!compact && (
              <span className="pv2-detail">
                <Highlighted text={detail} tokens={tokens} />
              </span>
            )}
          </span>
          {armed && (
            <span className="pv2-armed" title="Armed: click the canvas to place it">
              <span aria-hidden="true">✓</span>
              <span className="pv2-sr-only">armed for placing</span>
            </span>
          )}
        </button>
        {entry.hasVariants && !compact && (
          <button
            type="button"
            className="btn btn-ghost pv2-variant-toggle"
            aria-expanded={entry.expanded}
            aria-controls={entry.expanded ? variantsId : undefined}
            aria-label={`${entry.expanded ? 'Hide' : 'Show'} the ${entry.models.length} variants of ${entry.primary.model}`}
            title={`${entry.expanded ? 'Hide' : 'Show'} variants (ArrowRight / ArrowLeft)`}
            tabIndex={-1}
            onClick={() => onToggleVariants(entry.key)}
          >
            <span aria-hidden="true">{entry.models.length}</span>
            <span aria-hidden="true" className="pv2-caret">{entry.expanded ? '▾' : '▸'}</span>
          </button>
        )}
      </div>
      {entry.expanded && !compact && (
        <VariantChips entry={entry} armedType={armedType} focusType={tabType} id={variantsId} onPick={onPick} onFocusType={onFocusType} />
      )}
    </li>
  );
}

interface SectionProps {
  section: PaletteSection;
  view: PaletteView;
  armedType: string | null;
  tabType: string | null;
  recentTypes: ReadonlySet<string>;
  heading?: string;
  onToggle: (id: string) => void;
  onPick: (model: DeviceModel) => void;
  onFocusType: (type: string) => void;
  onToggleVariants: (key: string) => void;
}

function Section({ section, view, armedType, tabType, recentTypes, heading, onToggle, onPick, onFocusType, onToggleVariants }: SectionProps) {
  const listId = useId();
  const open = !section.collapsed;
  // A model shown in "Recently used" keeps its tab stop there, so the section copy never duplicates it.
  const sectionTab = tabType !== null && recentTypes.has(tabType) ? null : tabType;
  return (
    <section className="pv2-section" aria-label={section.label}>
      {heading !== undefined && <h2 className="pv2-group-heading">{heading}</h2>}
      <h3 className="pv2-section-heading">
        <button
          type="button"
          className="pv2-section-toggle"
          aria-expanded={open}
          aria-controls={listId}
          disabled={view.searching}
          title={view.searching ? section.hint : `${section.hint} ${open ? 'Click to collapse.' : 'Click to expand.'}`}
          onClick={() => onToggle(section.id)}
        >
          <span className="pv2-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span className="pv2-section-label">{section.label}</span>
          <span className="pv2-section-count" aria-label={`${section.count} devices`}>{section.count}</span>
        </button>
      </h3>
      {open && (
        <ul id={listId} className="pv2-list">
          {section.entries.map((entry) => (
            <PaletteTile
              key={entry.key}
              entry={entry}
              tokens={view.tokens}
              armedType={armedType}
              tabType={sectionTab}
              compact={false}
              onPick={onPick}
              onFocusType={onFocusType}
              onToggleVariants={onToggleVariants}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface ResizerProps {
  width: number;
  navRef: RefObject<HTMLElement>;
  onWidth: (width: number) => void;
  onCommit: (width: number) => void;
}

function PaletteResizer({ width, navRef, onWidth, onCommit }: ResizerProps) {
  const dragging = useRef(false);
  const latest = useRef(width);
  latest.current = width;

  const fromPointer = (clientX: number): number => {
    const left = navRef.current?.getBoundingClientRect().left ?? 0;
    return clampPaletteWidth(clientX - left);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return;
    onWidth(fromPointer(e.clientX));
  };
  const finish = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return;
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    onCommit(latest.current);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    let next: number | undefined;
    if (e.key === 'ArrowLeft') next = width - PALETTE_RESIZE_STEP;
    else if (e.key === 'ArrowRight') next = width + PALETTE_RESIZE_STEP;
    else if (e.key === 'Home') next = PALETTE_WIDTH.min;
    else if (e.key === 'End') next = PALETTE_WIDTH.max;
    if (next === undefined) return;
    e.preventDefault();
    const w = clampPaletteWidth(next);
    onWidth(w);
    onCommit(w);
  };

  return (
    <div
      className="pv2-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the device palette"
      aria-valuemin={PALETTE_WIDTH.min}
      aria-valuemax={PALETTE_WIDTH.max}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag, or use the arrow keys, to resize the palette"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onKeyDown={onKeyDown}
    />
  );
}

export function PaletteV2() {
  const catalog = useStore((s) => s.catalog);
  const palette = useStore((s) => s.palette);
  const tool = useStore((s) => s.tool);
  const addDeviceType = useStore((s) => s.addDeviceType);
  const setTool = useStore((s) => s.setTool);
  const setPaletteQuery = useStore((s) => s.setPaletteQuery);
  const setPaletteCategory = useStore((s) => s.setPaletteCategory);
  const togglePaletteGroup = useStore((s) => s.togglePaletteGroup);
  const setExpandedFamily = useStore((s) => s.setExpandedFamily);
  const announce = useStore((s) => s.announce);

  const navRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>(readPaletteWidth);
  const [focusType, setFocusType] = useState<string | null>(null);

  const index = useMemo(() => buildPaletteIndex(catalog), [catalog]);
  const input: PaletteQueryInput = palette;
  const view = useMemo(() => queryPalette(index, input), [index, input]);
  const armedType = tool === 'add-device' ? addDeviceType : null;
  const tabType = rovingType(view.order, focusType);
  const recentTypes = useMemo(() => new Set(view.recent.map((m) => m.type)), [view.recent]);

  useEffect(() => {
    const root = typeof document === 'undefined' ? undefined : document.documentElement;
    root?.style.setProperty('--palette-w', `${width}px`);
  }, [width]);
  useEffect(
    () => () => {
      if (typeof document !== 'undefined') document.documentElement.style.removeProperty('--palette-w');
    },
    [],
  );

  const focusNav = useCallback((type: string): void => {
    const el = listRef.current?.querySelector<HTMLElement>(navSelector(type));
    el?.focus();
    el?.scrollIntoView({ block: 'nearest' });
  }, []);

  // Recents are models actually placed: remember the armed type and record it when the next snapshot gains
  // exactly one device of that type (placing selects the new device and returns to the select tool, possibly
  // before the snapshot arrives, so the tool state alone cannot tell).
  const armedRef = useRef<string | null>(null);
  useEffect(() => {
    let previous = store.getState().snapshot?.devices;
    return store.subscribe((s) => {
      const devices = s.snapshot?.devices;
      if (devices === previous) return;
      const before = previous;
      previous = devices;
      const armed = armedRef.current;
      if (armed === null || devices === undefined || before === undefined) return;
      const type = placedType(before, devices);
      if (type !== armed) return;
      armedRef.current = null;
      s.pushRecentModel(type);
    });
  }, []);

  const pick = useCallback(
    (model: DeviceModel): void => {
      setFocusType(model.type);
      if (tool === 'add-device' && addDeviceType === model.type) {
        armedRef.current = null;
        setTool('select');
        announce(`${model.model} is no longer armed.`);
        return;
      }
      armedRef.current = model.type;
      setTool('add-device', model.type);
      announce(`${model.model} armed. Click the canvas to place it.`);
    },
    [tool, addDeviceType, setTool, announce],
  );

  const toggleVariants = useCallback(
    (key: string): void => {
      setExpandedFamily(toggleExpandedFamily(palette.expandedFamily, key));
    },
    [palette.expandedFamily, setExpandedFamily],
  );

  const onListKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const target = e.target instanceof HTMLElement ? e.target : null;
    const current = target?.closest('[data-nav-type]')?.getAttribute('data-nav-type') ?? tabType;
    if (isPaletteNavKey(e.key)) {
      const next = movePaletteFocus(view.order, current, e.key);
      if (next === undefined) return;
      e.preventDefault();
      setFocusType(next);
      focusNav(next);
      return;
    }
    const family = target?.getAttribute('data-family') ?? target?.closest('.pv2-entry')?.querySelector('[data-family]')?.getAttribute('data-family');
    if (family === null || family === undefined) return;
    const entry = view.sections.flatMap((s) => s.entries).find((x) => x.key === family);
    if (entry === undefined || !entry.hasVariants) return;
    if (e.key === 'ArrowRight' && !entry.expanded) {
      e.preventDefault();
      setExpandedFamily(entry.key);
    } else if (e.key === 'ArrowLeft' && entry.expanded) {
      e.preventDefault();
      setExpandedFamily(null);
      setFocusType(entry.primary.type);
      focusNav(entry.primary.type);
    }
  };

  const enterList = (): void => {
    const first = view.order[0];
    if (first === undefined) return;
    setFocusType(first);
    focusNav(first);
  };

  const onCategory = (c: DeviceCategory | 'all'): void => setPaletteCategory(c);

  let lastGroup: string | undefined;
  return (
    <nav ref={navRef} className="pv2" aria-label="Tools and devices" style={{ width: `${width}px` }}>
      <div className="pv2-tools" role="group" aria-label="Tools">
        <button
          type="button"
          className={`btn pv2-tool ${tool === 'select' ? 'is-active' : ''}`}
          aria-pressed={tool === 'select'}
          title="Select and move (V)"
          aria-keyshortcuts="V"
          onClick={() => setTool('select')}
        >
          <SelectGlyph />
          <span>Select</span>
        </button>
        <CablePicker />
      </div>

      <PaletteSearch
        query={palette.query}
        searching={view.searching}
        matched={view.matched}
        total={view.total}
        onChange={(q) => setPaletteQuery(q)}
        onEnterList={enterList}
      />
      <CategoryRail counts={view.categoryCounts} total={view.total} active={palette.category} onSelect={onCategory} />

      <div ref={listRef} className="pv2-scroll" onKeyDown={onListKeyDown}>
        {catalog.length === 0 && <p className="pv2-empty">Loading the device catalog…</p>}
        {catalog.length > 0 && view.matched === 0 && (
          <div className="pv2-empty" role="status">
            <p>{view.searching ? `No device matches “${palette.query.trim()}”.` : 'This category has no devices.'}</p>
            {view.searching && (
              <button type="button" className="btn" onClick={() => setPaletteQuery('')}>
                Clear the search
              </button>
            )}
          </div>
        )}

        {view.recent.length > 0 && (
          <section className="pv2-section pv2-recent" aria-label="Recently used">
            <h3 className="pv2-section-heading pv2-static-heading">Recently used</h3>
            <ul className="pv2-list pv2-recent-list">
              {view.recent.map((m) => (
                <PaletteTile
                  key={m.type}
                  entry={{ key: `recent:${m.type}`, models: [m], primary: m, hasVariants: false, expanded: false, score: 1 }}
                  tokens={view.tokens}
                  armedType={armedType}
                  tabType={tabType}
                  compact
                  onPick={pick}
                  onFocusType={setFocusType}
                  onToggleVariants={toggleVariants}
                />
              ))}
            </ul>
          </section>
        )}

        {view.sections.map((section) => {
          const groupLabel = section.group !== undefined ? CATEGORY_GROUP_VOCAB[section.group].label : undefined;
          const heading = palette.category === 'all' && groupLabel !== undefined && groupLabel !== lastGroup ? groupLabel : undefined;
          if (groupLabel !== undefined) lastGroup = groupLabel;
          return (
            <Section
              key={section.id}
              section={section}
              view={view}
              armedType={armedType}
              tabType={tabType}
              recentTypes={recentTypes}
              heading={heading}
              onToggle={(id) => togglePaletteGroup(id)}
              onPick={pick}
              onFocusType={setFocusType}
              onToggleVariants={toggleVariants}
            />
          );
        })}
      </div>

      <PaletteResizer width={width} navRef={navRef} onWidth={setWidth} onCommit={persistPaletteWidth} />
    </nav>
  );
}
