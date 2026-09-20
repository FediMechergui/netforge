/**
 * HexPane — the third NetScope pane: the frame's bytes, hex and text, tied to the layer or field the
 * detail pane has highlighted (ARCHITECTURE-P1 §4.12; spec §10).
 *
 * ponytail: the grid itself is the packet inspector's `HexView` (inspector/HexView.tsx) — same offsets,
 * same per-layer tint with an underline so colour is never alone, same soft/strong highlights. This pane
 * only adds the heading, the legend and the byte-range read-out.
 */
import type { CaptureRecordDetail } from '@netforge/engine';
import { HexView, protoClass, type ByteRange } from '../inspector/HexView';
import { protocolLabel } from '../vocab/protocols';
import './netscope.css';

export interface HexPaneProps {
  detail: CaptureRecordDetail | undefined;
  /** The worker is still fetching the frame; `note` would be untrue until it answers. */
  loading?: boolean;
  /** Soft highlight: the selected layer's bytes. */
  selected: ByteRange | null;
  /** Strong highlight: the focused field's bytes. */
  hot: ByteRange | null;
  /** Shown when no frame is selected. */
  note: string;
}

/** "bytes 14–33 (20)" for a range, or the whole frame when nothing is highlighted. */
export function rangeText(range: ByteRange | null, total: number): string {
  if (!range) return `${total} byte${total === 1 ? '' : 's'} in the frame`;
  const [offset, length] = range;
  return `bytes ${offset}–${offset + Math.max(1, length) - 1} (${length} of ${total})`;
}

export function HexPane({ detail, loading, selected, hot, note }: HexPaneProps) {
  if (!detail) {
    return (
      <div className="ns-pane">
        <h4>Bytes</h4>
        <div className="ns-note">{loading === true ? 'Reading the bytes…' : note}</div>
      </div>
    );
  }
  const total = detail.bytes.length;
  return (
    <div className="ns-pane">
      <h4 id="ns-hex-title">Bytes — {rangeText(hot ?? selected, total)}</h4>
      <div className="ns-scroll" aria-labelledby="ns-hex-title">
        <div className="pk-legend">
          {detail.layers.map((layer, i) => (
            <span key={`${i}:${layer.proto}`} className={protoClass(layer.proto)}>
              <span className="sw" aria-hidden="true" />
              {protocolLabel(layer.proto)} {layer.offset}–{layer.offset + layer.length - 1}
            </span>
          ))}
          <span>underlined = inside a layer · bold = the focused field</span>
        </div>
        <HexView bytes={detail.bytes} layers={detail.layers} selected={selected} hot={hot} />
      </div>
    </div>
  );
}
