/**
 * DetailTree — the second NetScope pane: the decoded layers of the selected frame, with bidirectional
 * highlight linking to the hex pane (ARCHITECTURE-P1 §4.12; spec §10 three-pane layout).
 *
 * `CaptureRecordDetail.layers` is the engine's own decode (codec registry, no PduIds), so a frame read back
 * from an imported file reads exactly like a live one. Selecting a layer highlights its bytes softly;
 * focusing or hovering a field highlights that field's bytes strongly — and focus does it too, so the link
 * works from the keyboard (§16).
 *
 * ponytail: layers are expanded sections rather than a generic tree widget — the depth is always 2 (layer,
 * field), so a tree's roving state would buy nothing over ordinary tab stops.
 */
import { memo } from 'react';
import type { CaptureRecordDetail, LayerView } from '@netforge/engine';
import { protoClass } from '../inspector/HexView';
import { formatField } from '../vocab/fields';
import { protocolLabel } from '../vocab/protocols';
import './netscope.css';

export interface HotField {
  layer: number;
  field: string;
}

export interface DetailTreeProps {
  detail: CaptureRecordDetail | undefined;
  loading?: boolean;
  selectedLayer: number | null;
  onSelectLayer(index: number | null): void;
  hot: HotField | null;
  onHot(hot: HotField | null): void;
  /** Shown when no frame is selected. */
  note: string;
}

/** Byte range of a layer, or of one of its fields, inside the frame. */
export function rangeOf(layers: readonly LayerView[], selectedLayer: number | null, hot: HotField | null): { selected: readonly [number, number] | null; hot: readonly [number, number] | null } {
  const layer = selectedLayer === null ? undefined : layers[selectedLayer];
  const hotLayer = hot === null ? undefined : layers[hot.layer];
  return {
    selected: layer ? [layer.offset, layer.length] : null,
    hot: hotLayer && hot ? (hotLayer.fieldRanges[hot.field] ?? null) : null,
  };
}

export function DetailTree({ detail, loading, selectedLayer, onSelectLayer, hot, onHot, note }: DetailTreeProps) {
  return (
    <div className="ns-pane">
      <h4 id="ns-detail-title">Frame detail{detail ? ` — frame ${detail.row.index + 1}` : ''}</h4>
      <div className="ns-scroll ns-tree" aria-labelledby="ns-detail-title">
        {!detail ? (
          <div className="ns-note">{loading === true ? 'Decoding the frame…' : note}</div>
        ) : (
          <>
            <div className="ns-note">
              <b>{detail.summary}</b>
            </div>
            {detail.layers.length === 0 && <div className="ns-note">The decoders found no layers in these bytes.</div>}
            {detail.layers.map((layer, i) => (
              <LayerSection
                key={`${i}:${layer.proto}:${layer.offset}`}
                layer={layer}
                index={i}
                selected={selectedLayer === i}
                hotField={hot && hot.layer === i ? hot.field : null}
                onSelectLayer={onSelectLayer}
                onHot={onHot}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

interface LayerSectionProps {
  layer: LayerView;
  index: number;
  selected: boolean;
  hotField: string | null;
  onSelectLayer(index: number | null): void;
  onHot(hot: HotField | null): void;
}

const LayerSection = memo(function LayerSection({ layer, index, selected, hotField, onSelectLayer, onHot }: LayerSectionProps) {
  const end = layer.offset + layer.length - 1;
  const fields = Object.entries(layer.fields);
  return (
    <div className={`pk-layer ${protoClass(layer.proto)}${selected ? ' is-selected' : ''}`}>
      <button
        type="button"
        className="pk-layer-head"
        aria-pressed={selected}
        aria-expanded={selected}
        title={selected ? 'Hide this layer in the bytes' : 'Show this layer in the bytes'}
        onClick={() => onSelectLayer(selected ? null : index)}
      >
        <span className="proto">{protocolLabel(layer.proto)}</span>
        <span className="dim">
          {layer.headerLength} B header{layer.trailerLength ? ` + ${layer.trailerLength} B trailer` : ''}
        </span>
        {layer.error !== undefined && <span className="err">⚠ {layer.error}</span>}
        <span className="range">
          bytes {layer.offset}–{end}
        </span>
      </button>
      {selected && fields.length > 0 && (
        <dl className="pk-fields" onMouseLeave={() => onHot(null)}>
          {fields.map(([name, value]) => {
            const text = formatField(layer.proto, name, value, layer.fields);
            const known = layer.fieldRanges[name] !== undefined;
            const enter = (): void => onHot(known ? { layer: index, field: name } : null);
            return (
              <div
                key={name}
                className={`ns-field${hotField === name ? ' is-hot' : ''}`}
                tabIndex={0}
                role="group"
                aria-label={`${name}: ${text}${known ? '' : ' (no byte range)'}`}
                onMouseEnter={enter}
                onFocus={enter}
                onBlur={() => onHot(null)}
              >
                <dt>{name}</dt>
                <dd>{text}</dd>
              </div>
            );
          })}
        </dl>
      )}
    </div>
  );
});
