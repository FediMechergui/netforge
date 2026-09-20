/**
 * Cable tool button with the media flyout (ARCHITECTURE-P1 §7 "Cable picker", §8.1 W6 web-inspector).
 *
 *  - The main button arms or disarms the cable tool (hotkey C belongs to the shell).
 *  - The flyout lists every picker media (cable-compat `cablePickerItems`, auto first) with the same non-colour
 *    channel the canvas draws: a line glyph (stroke kind + dash pattern), the media badge, and a clock mark on the
 *    end that becomes DCE for serial media. Media missing from the engine's media table are shown disabled.
 *  - While a cable is being drawn (`pendingCable`), the flyout lists the ports the chosen media can reach
 *    (cable-compat `compatibleTargets`, which runs the engine's own cable validator), so a cable can be finished
 *    from the keyboard, plus the serial DCE-end hint for the chosen pairing.
 *  - With the radio link media, a pairing form joins two point-to-point radio ports directly.
 *
 * Choosing a media stores it (`setCableMedia`, persisted by the store), keeps a pending cable in step and arms the
 * cable tool. Keyboard: ArrowDown on the tool opens the flyout; arrow keys, Home and End move between media;
 * Escape closes the flyout and returns focus to the button. Wording is original (§1.6).
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { portKey } from '@netforge/engine';
import type { DeviceSnapshot, MediaType, PortRef, PortSnapshot, SimSnapshot } from '@netforge/engine';
import { engine } from '../../bridge/client';
import { store, useStore } from '../../store/store';
import type { SnapshotIndex } from '../../store/types';
import './cable.css';
import { MEDIA_VOCAB, mediaDceEnd } from '../../vocab/media.js';
import type { MediaStroke } from '../../vocab/media.js';
import type { ColorToken } from '../../vocab/protocols.js';
import {
  addLinkSpecFor,
  buildCableLookup,
  cableEndLabel,
  cablePickerItems,
  compatibleTargets,
  effectiveCableMedia,
  isPickablePort,
  serialDceHint,
} from './cable-compat.js';
import type { CablePickerItem, PortCompat } from './cable-compat.js';

/** Most compatible ports listed in the flyout (the canvas shows every one). */
export const CABLE_TARGET_LIST_LIMIT = 40;

/** CSS custom property of a vocabulary colour token. */
export function colorTokenVar(token: ColorToken): string {
  switch (token) {
    case 'text':
      return 'var(--text)';
    case 'textDim':
      return 'var(--text-dim)';
    case 'accent':
      return 'var(--accent)';
    case 'ok':
      return 'var(--ok)';
    case 'warn':
      return 'var(--warn)';
    case 'err':
      return 'var(--err)';
    case 'purple':
      return 'var(--purple)';
    case 'yellow':
      return 'var(--yellow)';
    case 'blueDeep':
      return 'var(--blue-deep)';
  }
}

/** Glyph geometry of a media line: stroke widths, offsets from the centre line, and the scaled dash pattern. */
export interface MediaGlyphSpec {
  readonly lines: readonly { readonly offset: number; readonly width: number }[];
  readonly dash: string | undefined;
  /** Small antenna marks at both ends (radio beam). */
  readonly antennas: boolean;
  /** End that carries the clock (DCE) mark. */
  readonly dceEnd: 'a' | 'b' | undefined;
}

const GLYPH_DASH_SCALE = 0.6;

/** Geometry of the line glyph for a media (pure, shared by the flyout rows and the tool button). */
export function mediaGlyphSpec(media: MediaType): MediaGlyphSpec {
  const v = MEDIA_VOCAB[media];
  const lines = strokeLines(v.stroke);
  const dash = v.dash.length === 0 ? undefined : v.dash.map((n) => Math.max(0.5, Math.round(n * GLYPH_DASH_SCALE * 10) / 10)).join(' ');
  return Object.freeze({ lines, dash, antennas: v.stroke === 'beam', dceEnd: mediaDceEnd(media) });
}

function strokeLines(stroke: MediaStroke): readonly { offset: number; width: number }[] {
  switch (stroke) {
    case 'single':
      return [{ offset: 0, width: 2 }];
    case 'double':
      return [
        { offset: -2.2, width: 1.2 },
        { offset: 2.2, width: 1.2 },
      ];
    case 'thick':
      return [{ offset: 0, width: 4 }];
    case 'thin':
      return [{ offset: 0, width: 1 }];
    case 'beam':
      return [{ offset: 0, width: 3 }];
  }
}

const GLYPH_W = 44;
const GLYPH_H = 14;
const GLYPH_X0 = 5;
const GLYPH_X1 = 39;

/** SVG line glyph of a media (decorative: the row label says the same in words). */
export function MediaGlyph({ media }: { media: MediaType }) {
  const spec = mediaGlyphSpec(media);
  const color = colorTokenVar(MEDIA_VOCAB[media].color);
  const mid = GLYPH_H / 2;
  const clockX = spec.dceEnd === 'a' ? GLYPH_X0 : GLYPH_X1;
  return (
    <svg className="cable-glyph" width={GLYPH_W} height={GLYPH_H} viewBox={`0 0 ${GLYPH_W} ${GLYPH_H}`} aria-hidden="true">
      {spec.lines.map((l, i) => (
        <line
          key={i}
          x1={spec.dceEnd === 'a' ? GLYPH_X0 + 4 : GLYPH_X0}
          x2={spec.dceEnd === 'b' ? GLYPH_X1 - 4 : GLYPH_X1}
          y1={mid + l.offset}
          y2={mid + l.offset}
          stroke={color}
          strokeWidth={l.width}
          strokeDasharray={spec.dash}
          strokeLinecap="butt"
        />
      ))}
      {spec.antennas && (
        <>
          <path d={`M${GLYPH_X0 - 3} ${mid - 5} L${GLYPH_X0} ${mid} L${GLYPH_X0 + 3} ${mid - 5}`} fill="none" stroke={color} strokeWidth={1.2} />
          <path d={`M${GLYPH_X1 - 3} ${mid - 5} L${GLYPH_X1} ${mid} L${GLYPH_X1 + 3} ${mid - 5}`} fill="none" stroke={color} strokeWidth={1.2} />
        </>
      )}
      {spec.dceEnd !== undefined && (
        <g>
          <circle cx={clockX} cy={mid} r={4} fill="none" stroke="currentColor" strokeWidth={1.2} />
          <path d={`M${clockX} ${mid - 2.5} L${clockX} ${mid} L${clockX + 2} ${mid}`} fill="none" stroke="currentColor" strokeWidth={1} />
        </g>
      )}
    </svg>
  );
}

function CableToolGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="pv2-tool-glyph">
      <circle cx="5" cy="6" r="2.4" />
      <circle cx="19" cy="18" r="2.4" />
      <path d="M7 7.5 C 14 10, 10 14, 17 16.5" />
    </svg>
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A labelled port that the radio pairing form can offer. */
export interface RadioPortOption {
  readonly ref: PortRef;
  readonly key: string;
  readonly label: string;
}

/** Free point-to-point radio ports in snapshot order (not yet paired, pickable). */
export function freeRadioPorts(snapshot: Pick<SimSnapshot, 'devices'> | null | undefined): readonly RadioPortOption[] {
  if (snapshot === null || snapshot === undefined) return [];
  const out: RadioPortOption[] = [];
  for (const d of snapshot.devices) {
    for (const p of d.ports) {
      if (p.kind !== 'radio' || p.link !== undefined || !isPickablePort(p)) continue;
      const ref = { device: d.id, port: p.id };
      out.push(Object.freeze({ ref, key: portKey(ref), label: cableEndLabel(d, p) }));
    }
  }
  return out;
}

/** Device + port of a reference through the snapshot index when the store has one. */
export function lookupPort(s: { readonly snapshot: SimSnapshot | null; readonly snapshotIndex?: SnapshotIndex | undefined }, ref: PortRef): { device: DeviceSnapshot; port: PortSnapshot } | undefined {
  const snap = s.snapshot;
  if (snap === null) return undefined;
  const i = s.snapshotIndex?.devices[ref.device];
  const byIndex = i === undefined ? undefined : snap.devices[i];
  const device = byIndex !== undefined && byIndex.id === ref.device ? byIndex : snap.devices.find((d) => d.id === ref.device);
  const port = device?.ports.find((p) => p.id === ref.port);
  return device !== undefined && port !== undefined ? { device, port } : undefined;
}

interface MediaRowProps {
  item: CablePickerItem;
  checked: boolean;
  tabbable: boolean;
  onChoose: (media: MediaType) => void;
}

function MediaRow({ item, checked, tabbable, onChoose }: MediaRowProps) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      data-media={item.media}
      className={`cable-row ${checked ? 'is-checked' : ''}`}
      disabled={!item.available}
      tabIndex={tabbable ? 0 : -1}
      title={item.available ? `${item.description}${item.dceHint !== undefined ? `\n${item.dceHint}` : ''}` : 'This build of the simulator does not offer this cable.'}
      onClick={() => onChoose(item.media)}
    >
      <span className="cable-row-mark" aria-hidden="true">{checked ? '●' : '○'}</span>
      <MediaGlyph media={item.media} />
      <span className="cable-row-text">
        <span className="cable-row-label">{item.label}</span>
        {item.dceHint !== undefined && <span className="cable-row-hint">{item.dceHint}</span>}
      </span>
      <span className="cable-row-badge">{item.badge}</span>
    </button>
  );
}

interface TargetListProps {
  snapshot: SimSnapshot;
  from: PortRef;
  media: MediaType;
  onConnect: (to: PortRef) => void;
}

function TargetList({ snapshot, from, media, onConnect }: TargetListProps) {
  const catalog = useStore((s) => s.catalog);
  const modules = useStore((s) => s.modules);
  const lookup = useMemo(() => buildCableLookup(catalog, modules), [catalog, modules]);
  const targets = useMemo(() => compatibleTargets(snapshot, lookup, from, media), [snapshot, lookup, from, media]);
  const source = lookupPort({ snapshot }, from);
  const fromLabel = source !== undefined ? cableEndLabel(source.device, source.port) : `${from.device} ${from.port}`;
  const shown: readonly PortCompat[] = targets.slice(0, CABLE_TARGET_LIST_LIMIT);
  const nameOf = (ref: PortRef): string => {
    const hit = lookupPort({ snapshot }, ref);
    return hit !== undefined ? cableEndLabel(hit.device, hit.port) : `${ref.device} ${ref.port}`;
  };
  const dce = serialDceHint(media, from, undefined, { from: fromLabel });
  return (
    <div className="cable-section" role="group" aria-label="Finish the cable">
      <div className="cable-section-title">From {fromLabel}</div>
      {dce !== undefined && (
        <p className="cable-note">
          <span aria-hidden="true">◷ </span>
          {dce.text}
        </p>
      )}
      <p className="cable-note" role="status">
        {targets.length === 0
          ? 'No free port can take this cable. Try another cable type.'
          : targets.length === 1
            ? '1 port can take this cable.'
            : `${targets.length} ports can take this cable.`}
      </p>
      {shown.length > 0 && (
        <ul className="cable-targets">
          {shown.map((t) => {
            const label = nameOf(t.ref);
            const hint = serialDceHint(media, from, t.ref, { from: fromLabel, to: label });
            const via = t.resolvedMedia !== undefined && media === 'auto' ? ` (${MEDIA_VOCAB[t.resolvedMedia].short})` : '';
            return (
              <li key={portKey(t.ref)}>
                <button type="button" className="cable-target" title={hint?.text ?? 'Connect the cable to this port'} onClick={() => onConnect(t.ref)}>
                  <span aria-hidden="true">✓ </span>
                  {label}
                  {via}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {targets.length > shown.length && <p className="cable-note">…and {targets.length - shown.length} more on the canvas.</p>}
    </div>
  );
}

interface RadioPairingProps {
  snapshot: SimSnapshot | null;
  onPair: (a: PortRef, b: PortRef) => void;
}

function RadioPairing({ snapshot, onPair }: RadioPairingProps) {
  const options = useMemo(() => freeRadioPorts(snapshot), [snapshot]);
  const [aKey, setAKey] = useState('');
  const [bKey, setBKey] = useState('');
  const aId = useId();
  const bId = useId();
  const a = options.find((o) => o.key === aKey);
  const b = options.find((o) => o.key === bKey);
  const sameDevice = a !== undefined && b !== undefined && a.ref.device === b.ref.device;
  const ready = a !== undefined && b !== undefined && a.key !== b.key && !sameDevice;
  if (options.length < 2) {
    return (
      <div className="cable-section" role="group" aria-label="Pair two radios">
        <div className="cable-section-title">Pair two radios</div>
        <p className="cable-note">Place two point-to-point radios with free radio ports to pair them here.</p>
      </div>
    );
  }
  return (
    <form
      className="cable-section cable-pair"
      aria-label="Pair two radios"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onPair(a.ref, b.ref);
      }}
    >
      <div className="cable-section-title">Pair two radios</div>
      <label htmlFor={aId}>First radio</label>
      <select id={aId} className="select" value={aKey} onChange={(e) => setAKey(e.target.value)}>
        <option value="">Choose a radio port</option>
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
      <label htmlFor={bId}>Second radio</label>
      <select id={bId} className="select" value={bKey} onChange={(e) => setBKey(e.target.value)}>
        <option value="">Choose a radio port</option>
        {options
          .filter((o) => o.key !== aKey)
          .map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
      </select>
      {sameDevice && <p className="cable-note" role="alert">Choose radios on two different devices.</p>}
      <p className="cable-note">The link comes up when both radios use the same band, channel and pairing key and are in range.</p>
      <button type="submit" className="btn btn-primary" disabled={!ready}>
        Pair radios
      </button>
    </form>
  );
}

/** The cable tool button and its media flyout (rendered inside the palette's tool row). */
export function CablePicker() {
  const tool = useStore((s) => s.tool);
  const cable = useStore((s) => s.cable);
  const mediaTable = useStore((s) => s.media);
  const pending = useStore((s) => s.pendingCable);
  const snapshot = useStore((s) => s.snapshot);
  const setTool = useStore((s) => s.setTool);
  const setCableMedia = useStore((s) => s.setCableMedia);
  const setCablePickerOpen = useStore((s) => s.setCablePickerOpen);
  const setPendingCable = useStore((s) => s.setPendingCable);
  const announce = useStore((s) => s.announce);
  const toast = useStore((s) => s.toast);

  const open = cable.open;
  const setOpen = setCablePickerOpen;

  const items = useMemo(() => cablePickerItems(mediaTable), [mediaTable]);
  const media = effectiveCableMedia(cable.media, mediaTable);
  const active = tool === 'cable';
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const flyoutId = useId();
  const current = MEDIA_VOCAB[media];

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (e: PointerEvent): void => {
      if (rootRef.current !== null && e.target instanceof Node && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer, true);
    const raf = requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][tabindex="0"]')?.focus();
    });
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      cancelAnimationFrame(raf);
    };
  }, [open, setOpen]);

  const choose = (m: MediaType): void => {
    setCableMedia(m);
    const p = store.getState().pendingCable;
    if (p !== null && p.media !== m) setPendingCable({ ...p, media: m });
    if (tool !== 'cable') setTool('cable');
    announce(`Cable type: ${MEDIA_VOCAB[m].short}.`);
    if (m !== 'radio') {
      setOpen(false);
      toggleRef.current?.focus();
    }
  };

  const connect = async (a: PortRef, b: PortRef, m: MediaType): Promise<void> => {
    try {
      await engine.addLink(addLinkSpecFor(a, b, m));
      const st = store.getState();
      if (st.pendingCable !== null) st.setPendingCable(null);
      const an = lookupPort(st, a);
      const bn = lookupPort(st, b);
      const text = an !== undefined && bn !== undefined ? `Connected ${cableEndLabel(an.device, an.port)} to ${cableEndLabel(bn.device, bn.port)}.` : 'Connected.';
      st.announce(text);
      setOpen(false);
      toggleRef.current?.focus();
    } catch (err) {
      toast(`The connection could not be made: ${errorText(err)}`, 'error');
    }
  };

  const onToolClick = (): void => {
    if (active) setTool('select');
    else setTool('cable');
  };

  const onToolKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onFlyoutKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      toggleRef.current?.focus();
      return;
    }
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)') ?? []);
    const at = rows.findIndex((r) => r === e.target);
    if (at < 0) return;
    let next = at;
    if (e.key === 'ArrowDown') next = Math.min(rows.length - 1, at + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, at - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = rows.length - 1;
    else return;
    e.preventDefault();
    rows[next]?.focus();
  };

  const firstAvailable = items.find((i) => i.available)?.media;
  const tabbableMedia = items.some((i) => i.media === media && i.available) ? media : firstAvailable;

  return (
    <div ref={rootRef} className="cable-picker">
      <div className="cable-tool-row">
        <button
          type="button"
          className={`btn pv2-tool cable-tool ${active ? 'is-active' : ''}`}
          aria-pressed={active}
          aria-keyshortcuts="C"
          title={`Cable (C): click a port, then another port. Cable type: ${current.short}. Press ArrowDown to choose another type.`}
          onClick={onToolClick}
          onKeyDown={onToolKeyDown}
        >
          <CableToolGlyph />
          <span>Cable</span>
          <span className="cable-tool-badge" aria-label={`cable type ${current.short}`}>
            {current.badge}
          </span>
        </button>
        <button
          ref={toggleRef}
          type="button"
          className={`btn btn-icon cable-flyout-toggle ${open ? 'is-active' : ''}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? flyoutId : undefined}
          aria-label="Choose the cable type"
          title="Choose the cable type"
          onClick={() => setOpen(!open)}
        >
          <span aria-hidden="true">{open ? '▴' : '▾'}</span>
        </button>
      </div>
      {open && (
        <div id={flyoutId} className="cable-flyout" onKeyDown={onFlyoutKeyDown}>
          <div ref={listRef} role="menu" aria-label="Cable types" className="cable-rows">
            {items.map((item) => (
              <MediaRow key={item.media} item={item} checked={item.media === media} tabbable={item.media === tabbableMedia} onChoose={choose} />
            ))}
          </div>
          <p className="cable-note">{current.description}</p>
          {pending !== null && snapshot !== null && (
            <TargetList snapshot={snapshot} from={pending.from} media={media} onConnect={(to) => void connect(pending.from, to, media)} />
          )}
          {media === 'radio' && pending === null && <RadioPairing snapshot={snapshot} onPair={(a, b) => void connect(a, b, 'radio')} />}
        </div>
      )}
    </div>
  );
}
