/**
 * Palette v2 category rail (ARCHITECTURE-P1 §7): "All" plus every DEVICE_CATEGORIES entry that has models,
 * grouped under the category group labels. A roving tab stop keeps the rail one Tab press; arrow keys, Home and
 * End move between chips. The chosen chip carries a check glyph and aria-pressed, never colour alone.
 */
import { useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { CategoryGroup, DeviceCategory } from '@netforge/engine';
import { CATEGORY_GROUP_VOCAB, CATEGORY_VOCAB } from '../../vocab/categories.js';

export interface CategoryCount {
  readonly id: DeviceCategory;
  readonly label: string;
  readonly count: number;
}

/** One chip of the rail. */
export interface RailChip {
  readonly id: DeviceCategory | 'all';
  readonly label: string;
  readonly count: number;
  readonly hint: string;
  /** Group heading shown before this chip (first chip of a group). */
  readonly heading?: string;
}

/** Chips in rail order: "All", then categories with at least one model, a group heading on each group's first chip. */
export function railChips(counts: readonly CategoryCount[], total: number): readonly RailChip[] {
  const out: RailChip[] = [{ id: 'all', label: 'All', count: total, hint: 'Show every device.' }];
  let group: CategoryGroup | undefined;
  for (const c of counts) {
    if (c.count === 0) continue;
    const v = CATEGORY_VOCAB[c.id];
    const chip: RailChip = v.group !== group ? { id: c.id, label: c.label, count: c.count, hint: v.hint, heading: CATEGORY_GROUP_VOCAB[v.group].label } : { id: c.id, label: c.label, count: c.count, hint: v.hint };
    group = v.group;
    out.push(chip);
  }
  return out;
}

export interface CategoryRailProps {
  counts: readonly CategoryCount[];
  total: number;
  active: DeviceCategory | 'all';
  onSelect: (category: DeviceCategory | 'all') => void;
}

export function CategoryRail({ counts, total, active, onSelect }: CategoryRailProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const chips = railChips(counts, total);
  const activeId = chips.some((c) => c.id === active) ? active : 'all';

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const buttons = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('button[data-category]') ?? []);
    const at = buttons.findIndex((b) => b === e.target);
    if (at < 0) return;
    let next = at;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = Math.min(buttons.length - 1, at + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = Math.max(0, at - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = buttons.length - 1;
    else return;
    e.preventDefault();
    buttons[next]?.focus();
  };

  return (
    <div ref={rootRef} className="pv2-rail" role="toolbar" aria-label="Device categories" onKeyDown={onKeyDown}>
      {chips.map((chip) => {
        const pressed = chip.id === activeId;
        return (
          <div key={chip.id} className="pv2-rail-item">
            {chip.heading !== undefined && <div className="pv2-rail-heading" aria-hidden="true">{chip.heading}</div>}
            <button
              type="button"
              data-category={chip.id}
              className={`pv2-chip ${pressed ? 'is-pressed' : ''}`}
              aria-pressed={pressed}
              tabIndex={pressed ? 0 : -1}
              title={chip.hint}
              onClick={() => onSelect(chip.id)}
            >
              <span className="pv2-chip-mark" aria-hidden="true">{pressed ? '✓' : ''}</span>
              <span className="pv2-chip-label">{chip.label}</span>
              <span className="pv2-chip-count" aria-label={`${chip.count} devices`}>{chip.count}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
