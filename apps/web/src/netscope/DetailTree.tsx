/**
 * DetailTree — the second NetScope pane: the decoded layers of the selected frame, with bidirectional
 * highlight linking to the hex pane (ARCHITECTURE-P1 §4.12; spec §10 three-pane layout).
 *
 * `CaptureRecordDetail.layers` is the engine's own decode (codec registry, no PduIds), so a frame read back
 * from an imported file reads exactly like a live one. Selecting a layer highlights its bytes softly;
 * focusing or hovering a field highlights that field's bytes strongly — and focus does it too, so the link
 * works from the keyboard (§16).
 *
 * @since P3 (ARCHITECTURE-P3 §9.2 ruling R57(b); §3.8 step 2, §3.13 step 8; W6 web-inspector) The protected banner of the
 * Packet inspector (`ProtectedBanner`, its titles from `protectedBannerTitle`) sits under the summary of a frame whose
 * layers carry the protection: "Encrypted (ESP, simulated)" for a frame with an ESP header — what the provider sees —
 * and "Protected (TLS / SSH / IKE, simulated)" for a segment the engine marked (`frameProtection`); each layer the
 * protection covers carries the simulated-plaintext mark. A CAPWAP control frame (P2's DTLS) keeps its P2 view.
 *
 * ponytail: layers are expanded sections rather than a generic tree widget — the depth is always 2 (layer,
 * field), so a tree's roving state would buy nothing over ordinary tab stops.
 */
import { memo } from 'react';
import type { CaptureRecordDetail, LayerView, PduMeta } from '@netforge/engine';
import { protoClass } from '../inspector/HexView';
import { PROTECTED_LAYER_MARK, ProtectedBanner, protectedLayerIndexes, type ProtectionKind } from '../inspector/PacketInspector';
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
  /**
   * @since P3 (ruling R57(b); optional by meaning) The channel protecting the frame (`frameProtection`): the banner
   * and the simulated mark on the layers it covers. Absent: no banner, as before P3.
   */
  protection?: ProtectionKind;
}

/**
 * @since P3 (ruling R57(b)) The banner of a captured frame: 'esp' when the frame holds an ESP header (the provider's view;
 * the PDU's own mark is cleared where the tunnel ends, so the header decides); otherwise the channel the engine marked
 * the frame's PDU with — 'tls', 'ssh' or 'ike', which mark a segment end to end (except a segment that crossed an
 * IPsec tunnel: the tail clears the single mark slot, D27, so its TLS/SSH mark is gone). A CAPWAP control message
 * (P2's DTLS: `protected` without `protectedBy`) keeps NetScope's P2 view, without a banner; so does a frame outside an
 * ESP tunnel whose packet happens to be inside one now (its mark is 'esp' but the frame has no ESP header).
 */
export function frameProtection(
  layers: readonly Pick<LayerView, 'proto'>[],
  meta?: Pick<PduMeta, 'protected' | 'protectedBy'>,
): ProtectionKind | undefined {
  if (layers.some((l) => l.proto === 'esp')) return 'esp';
  if (meta?.protected !== true) return undefined;
  const by = meta.protectedBy;
  return by === 'tls' || by === 'ssh' || by === 'ike' ? by : undefined;
}

/** @since P3 (ruling R57(b)) Whether a frame's banner hangs on its PDU's mark: no ESP header, and a TCP or UDP segment. */
export function frameNeedsMark(layers: readonly Pick<LayerView, 'proto'>[]): boolean {
  return !layers.some((l) => l.proto === 'esp') && layers.some((l) => l.proto === 'tcp' || l.proto === 'udp');
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

export function DetailTree({ detail, loading, selectedLayer, onSelectLayer, hot, onHot, note, protection }: DetailTreeProps) {
  const covered = detail !== undefined && protection !== undefined ? protectedLayerIndexes(detail.layers, protection) : undefined;
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
            {protection !== undefined && <ProtectedBanner layers={detail.layers} by={protection} />}
            {detail.layers.length === 0 && <div className="ns-note">The decoders found no layers in these bytes.</div>}
            {detail.layers.map((layer, i) => (
              <LayerSection
                key={`${i}:${layer.proto}:${layer.offset}`}
                layer={layer}
                index={i}
                selected={selectedLayer === i}
                hotField={hot && hot.layer === i ? hot.field : null}
                simulated={covered?.has(i) === true}
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
  /** @since P3 (R57(b)) The layer is inside the protected payload: marked as simulated plaintext. */
  simulated?: boolean;
  onSelectLayer(index: number | null): void;
  onHot(hot: HotField | null): void;
}

const LayerSection = memo(function LayerSection({ layer, index, selected, hotField, simulated = false, onSelectLayer, onHot }: LayerSectionProps) {
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
        {simulated && <span className="chip tiny">{PROTECTED_LAYER_MARK}</span>}
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
