/**
 * Synchronized hex dump for the packet inspector (spec §9.2): 16 bytes per row,
 * offset column, hex + ASCII. Every byte is tinted by the innermost layer that
 * covers it (colour + underline), the selected layer gets a soft background and
 * the hovered field a strong, bold highlight — so colour is never the only cue.
 */
import { memo, useMemo } from 'react';
import type { LayerView } from '@netforge/engine';

/** `[offset, length]` inside the PDU bytes. */
export type ByteRange = readonly [number, number];

const KNOWN_PROTOS = new Set(['ethernet', 'arp', 'ipv4', 'icmpv4', 'udp', 'tcp', 'payload']);

/** CSS class carrying `--layer` for a protocol name (see inspector.css). */
export function protoClass(proto: string): string {
  return KNOWN_PROTOS.has(proto) ? `p-${proto}` : 'p-other';
}

const BYTES_PER_ROW = 16;

interface HexViewProps {
  bytes: Uint8Array;
  layers: readonly LayerView[];
  /** Soft highlight (a clicked layer). */
  selected: ByteRange | null;
  /** Strong highlight (a hovered field). */
  hot: ByteRange | null;
}

function clip(range: ByteRange | null, rowStart: number): [number, number] {
  if (!range) return [-1, -1];
  const start = Math.max(range[0], rowStart);
  const end = Math.min(range[0] + range[1], rowStart + BYTES_PER_ROW);
  return start < end ? [start, end] : [-1, -1];
}

export const HexView = memo(function HexView({ bytes, layers, selected, hot }: HexViewProps) {
  // owner[b] = index of the innermost layer covering byte b (later layers are nested deeper).
  const owners = useMemo(() => {
    const o = new Int16Array(bytes.length).fill(-1);
    layers.forEach((layer, i) => {
      const end = Math.min(bytes.length, layer.offset + layer.length);
      for (let b = Math.max(0, layer.offset); b < end; b++) o[b] = i;
    });
    return o;
  }, [bytes, layers]);

  const rows: JSX.Element[] = [];
  for (let off = 0; off < bytes.length; off += BYTES_PER_ROW) {
    const [selStart, selEnd] = clip(selected, off);
    const [hotStart, hotEnd] = clip(hot, off);
    rows.push(
      <HexRow
        key={off}
        offset={off}
        bytes={bytes}
        owners={owners}
        layers={layers}
        selStart={selStart}
        selEnd={selEnd}
        hotStart={hotStart}
        hotEnd={hotEnd}
      />,
    );
  }

  if (bytes.length === 0) return <div className="hex">(no bytes)</div>;
  return (
    <div className="hex" role="table" aria-label="Packet bytes in hexadecimal and ASCII">
      {rows}
    </div>
  );
});

interface HexRowProps {
  offset: number;
  bytes: Uint8Array;
  owners: Int16Array;
  layers: readonly LayerView[];
  selStart: number;
  selEnd: number;
  hotStart: number;
  hotEnd: number;
}

const HexRow = memo(function HexRow({ offset, bytes, owners, layers, selStart, selEnd, hotStart, hotEnd }: HexRowProps) {
  const hex: JSX.Element[] = [];
  const ascii: JSX.Element[] = [];
  for (let i = 0; i < BYTES_PER_ROW; i++) {
    const b = offset + i;
    const gap = i === 7 ? ' gap8' : '';
    if (b >= bytes.length) {
      hex.push(<span key={i} className={`hx hex-b${gap}`}>{'  '}</span>);
      ascii.push(<span key={i} className="hx hex-a">{' '}</span>);
      continue;
    }
    const value = bytes[b] ?? 0;
    const owner = owners[b] ?? -1;
    const layer = owner >= 0 ? layers[owner] : undefined;
    let cls = layer ? ` in-layer ${protoClass(layer.proto)}` : '';
    if (b >= selStart && b < selEnd) cls += ' hx-sel';
    if (b >= hotStart && b < hotEnd) cls += ' hx-strong';
    const title = layer ? `byte ${b} · ${layer.proto}` : `byte ${b}`;
    hex.push(
      <span key={i} className={`hx hex-b${gap}${cls}`} title={title}>
        {value.toString(16).padStart(2, '0')}
      </span>,
    );
    ascii.push(
      <span key={i} className={`hx hex-a${cls}`}>
        {value >= 0x20 && value < 0x7f ? String.fromCharCode(value) : '.'}
      </span>,
    );
  }
  return (
    <div className="hex-row" role="row">
      <span className="hex-off">{offset.toString(16).padStart(4, '0')}</span>
      <span className="hex-bytes">{hex}</span>
      <span className="hex-ascii">{ascii}</span>
    </div>
  );
});
