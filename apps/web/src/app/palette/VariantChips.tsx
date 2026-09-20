/**
 * Palette v2 family variant chips (ARCHITECTURE-P1 §7): the variants of one family tile, in catalog order.
 * Each chip arms the add-device tool for its model. Chips take part in the palette's roving focus order
 * (`data-nav-type`), so arrow keys walk through them like tiles. The armed chip shows a check glyph.
 */
import type { DeviceModel } from '@netforge/engine';
import type { PaletteEntry } from './palette-query.js';
import { modelTooltip, variantLabel } from './palette-query.js';

export interface VariantChipsProps {
  entry: PaletteEntry;
  /** Model type armed by the add-device tool, if any. */
  armedType: string | null;
  /** Model type that owns the palette's tab stop. */
  focusType: string | null;
  /** DOM id (the tile's variant toggle points at it with aria-controls). */
  id: string;
  onPick: (model: DeviceModel) => void;
  onFocusType: (type: string) => void;
}

export function VariantChips({ entry, armedType, focusType, id, onPick, onFocusType }: VariantChipsProps) {
  return (
    <div id={id} className="pv2-variants" role="group" aria-label={`Variants of ${entry.primary.model}`}>
      {entry.models.map((m) => {
        const armed = armedType === m.type;
        return (
          <button
            key={m.type}
            type="button"
            data-nav-type={m.type}
            className={`pv2-variant ${armed ? 'is-armed' : ''}`}
            aria-pressed={armed}
            tabIndex={focusType === m.type ? 0 : -1}
            title={modelTooltip(m)}
            onFocus={() => onFocusType(m.type)}
            onClick={() => onPick(m)}
          >
            <span className="pv2-variant-mark" aria-hidden="true">{armed ? '✓' : '·'}</span>
            <span className="pv2-variant-label">{variantLabel(m)}</span>
            <span className="pv2-sr-only"> ({m.model})</span>
          </button>
        );
      })}
    </div>
  );
}
