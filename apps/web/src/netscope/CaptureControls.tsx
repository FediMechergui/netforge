/**
 * CaptureControls — the capture list and the controls that create, stop, remove, save and open captures
 * (ARCHITECTURE-P1 §4.12 "Start" / "Export" / "Import"; §10.2 accept.p1.pcapng-export).
 *
 * Capture points are ports of the loaded topology: one port, or every port at once (the promiscuous lab
 * capture the engine takes when a spec names neither ports nor links). Live captures die with the world;
 * imported ones (ids i_*) survive a reset, which the list says in words next to a lettered badge.
 *
 * ponytail: the picker offers one port or all of them — the engine also accepts a list of ports and links,
 * which the panel does not need before someone asks for a SPAN-like selection.
 */
import { useMemo, useRef, useState } from 'react';
import type { CaptureId, CaptureInfo, CaptureSpec, DeviceSnapshot, PcapFormat, PortRef } from '@netforge/engine';
import { runningBadge, sourceBadge } from './netscope-client';
import './netscope.css';

export interface CapturePoint {
  /** Stable option value: 'device/port'. */
  key: string;
  /** 'PC1 Gi0'. */
  label: string;
  ref: PortRef;
}

/** Every port that can carry frames, device order then port order. Virtual ports and consoles cannot. */
export function capturePointsOf(snapshot: { devices: readonly DeviceSnapshot[] } | null | undefined): CapturePoint[] {
  const out: CapturePoint[] = [];
  for (const d of snapshot?.devices ?? []) {
    for (const p of d.ports) {
      if (p.virtual || p.kind === 'console') continue;
      out.push({ key: `${d.id}/${p.id}`, label: `${d.name} ${p.short || p.id}`, ref: { device: d.id, port: p.id } });
    }
  }
  return out;
}

/** The spec the form describes. An empty `point` captures on every port. */
export function buildSpec(point: CapturePoint | undefined, dir: 'tx' | 'rx' | 'both', background: boolean, name: string): CaptureSpec {
  const trimmed = name.trim();
  return {
    ...(point ? { ports: [point.ref] } : {}),
    dir,
    includeBackground: background,
    name: trimmed === '' ? (point ? point.label : 'Every port') : trimmed,
  };
}

export interface CaptureControlsProps {
  captures: readonly CaptureInfo[];
  activeId: CaptureId | null;
  points: readonly CapturePoint[];
  busy?: boolean;
  /** Last thing that went wrong (an export of mixed link types, a refused file, …). */
  problem?: string;
  onSelect(id: CaptureId): void;
  onStart(spec: CaptureSpec): void;
  onStop(id: CaptureId): void;
  onRemove(id: CaptureId): void;
  onExport(id: CaptureId, format: PcapFormat): void;
  onImport(file: File): void;
}

export function CaptureControls({ captures, activeId, points, busy, problem, onSelect, onStart, onStop, onRemove, onExport, onImport }: CaptureControlsProps) {
  const [pointKey, setPointKey] = useState('');
  const [dir, setDir] = useState<'tx' | 'rx' | 'both'>('both');
  const [background, setBackground] = useState(false);
  const [name, setName] = useState('');
  const [format, setFormat] = useState<PcapFormat>('pcapng');
  const fileRef = useRef<HTMLInputElement>(null);
  const active = useMemo(() => captures.find((c) => c.id === activeId), [captures, activeId]);
  const point = useMemo(() => points.find((p) => p.key === pointKey), [points, pointKey]);

  return (
    <div className="ns-pane">
      <h4 id="ns-captures-title">Captures</h4>

      <div className="ns-form">
        <label htmlFor="ns-point">Capture point</label>
        <select id="ns-point" className="select" value={pointKey} onChange={(e) => setPointKey(e.target.value)}>
          <option value="">Every port (promiscuous)</option>
          {points.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>

        <label htmlFor="ns-dir">Direction</label>
        <select id="ns-dir" className="select" value={dir} onChange={(e) => setDir(e.target.value as 'tx' | 'rx' | 'both')}>
          <option value="both">Both ways</option>
          <option value="tx">Sent only</option>
          <option value="rx">Received only</option>
        </select>

        <label>
          <input type="checkbox" checked={background} onChange={(e) => setBackground(e.target.checked)} />
          Keep keepalives and beacons
        </label>

        <label htmlFor="ns-name">Name</label>
        <input id="ns-name" className="input" type="text" value={name} placeholder="optional" onChange={(e) => setName(e.target.value)} />

        <button type="button" className="btn btn-primary" disabled={busy === true} onClick={() => onStart(buildSpec(point, dir, background, name))}>
          ● Start capture
        </button>
      </div>

      <div className="ns-scroll" aria-labelledby="ns-captures-title">
        {problem !== undefined && (
          <div className="ns-err" role="alert">
            ⚠ {problem}
          </div>
        )}
        {captures.length === 0 ? (
          <div className="ns-note">No capture yet. Choose a capture point above and start one, or open a capture file.</div>
        ) : (
          <ul className="ns-cap-list">
            {captures.map((c) => {
              const badge = sourceBadge(c.source);
              const state = runningBadge(c);
              const on = c.id === activeId;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    className={`btn ns-cap${on ? ' is-active' : ''}`}
                    aria-pressed={on}
                    onClick={() => onSelect(c.id)}
                    title={`${c.interfaces.length} interface${c.interfaces.length === 1 ? '' : 's'}: ${c.interfaces.map((i) => i.name).join(', ')}`}
                  >
                    <span className="ns-letter" aria-hidden="true">
                      {badge.letter}
                    </span>
                    <span>{c.name}</span>
                    <span className="dim">
                      {state.glyph} {state.text} · {badge.text} · {c.head} frame{c.head === 1 ? '' : 's'}
                      {c.dropped > 0 ? ` · ${c.dropped} dropped from the start` : ''}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="ns-bar">
        <button type="button" className="btn" disabled={!active || !active.running || busy === true} onClick={() => active && onStop(active.id)}>
          ■ Stop
        </button>
        <button type="button" className="btn" disabled={!active || busy === true} onClick={() => active && onRemove(active.id)}>
          Remove
        </button>
        <span className="spacer" />
        <label htmlFor="ns-format">Save as</label>
        <select id="ns-format" className="select" value={format} onChange={(e) => setFormat(e.target.value as PcapFormat)}>
          <option value="pcapng">pcapng (every link type)</option>
          <option value="pcap">pcap (one link type)</option>
        </select>
        <button type="button" className="btn" disabled={!active || busy === true} onClick={() => active && onExport(active.id, format)}>
          Save capture
        </button>
        <button type="button" className="btn" disabled={busy === true} onClick={() => fileRef.current?.click()}>
          Open a capture file
        </button>
        <input
          ref={fileRef}
          id="ns-import"
          type="file"
          accept=".pcap,.pcapng,.cap"
          aria-label="Open a capture file"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) onImport(file);
          }}
        />
      </div>
    </div>
  );
}
