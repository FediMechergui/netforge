/**
 * Keyboard cabling dialog (spec §16 "every canvas action has a keyboard path"; ARCHITECTURE-P1 §7).
 *
 * Flow: choose the cable (the same media rows as the pointer cable picker, from `cablePickerItems`) → choose the
 * first port (skipped when the request already names one) → choose the other port from the ports the engine's
 * cable validator accepts (refused ports are listed, disabled, with the reason) → confirm with the live
 * `validateLink` verdict and the serial DCE-end hint → `engine.addLink`.
 *
 * Opened by `requestKeyboardCabling` (the outline's C key) and by the canvas through `CanvasA11yApi.beginCable`.
 * While a first port is chosen the store's `pendingCable` mirrors it, so the canvas draws the same preview as
 * for a pointer cable. The dialog is non-destructive until Connect; Escape closes it and focus returns to where
 * it came from. Nothing here branches on device kind (D2/D3); wording is original (§1.6).
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { samePort } from '@netforge/engine';
import type { CableValidation, DeviceId, MediaType, PortRef } from '@netforge/engine';
import { engine } from '../../bridge/client';
import { store, useStore } from '../../store/store';
import {
  addLinkSpecFor,
  buildCableLookup,
  cablePickerItems,
  isPickablePort,
  serialDceHint,
  validationKey,
  verdictText,
  type CablePickerItem,
} from '../../app/cable/cable-compat.js';
import { MEDIA_VOCAB } from '../../vocab/media.js';
import { announceWith } from './announcer';
import {
  cablingSources,
  cablingTargets,
  deviceById,
  filterCandidates,
  type CablingCandidate,
} from './keyboard-nav.js';

// ── request channel ──────────────────────────────────────────────────────────

/** Open the dialog for a device (choose the first port) or from a known first port. */
export type KeyboardCablingRequest = { readonly device: DeviceId } | { readonly from: PortRef };

type RequestListener = (req: KeyboardCablingRequest) => void;
const requestListeners = new Set<RequestListener>();

/** Ask the mounted dialog to open. Returns false when no dialog is mounted. */
export function requestKeyboardCabling(req: KeyboardCablingRequest): boolean {
  if (requestListeners.size === 0) return false;
  for (const l of requestListeners) l(req);
  return true;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const DIALOG_WIDTH = 380;
const DIALOG_GAP = 24;

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'Something went wrong.';
}

function focusables(root: HTMLElement): HTMLElement[] {
  const list = root.querySelectorAll<HTMLElement>('button, input, select, [tabindex]:not([tabindex="-1"])');
  return [...list].filter((el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0 && el.getClientRects().length > 0);
}

/** Line glyph of a media row: dash pattern and stroke weight carry the meaning, never colour alone. */
function MediaGlyph({ item }: { item: CablePickerItem }) {
  const dash = item.dash.length > 0 ? item.dash.join(' ') : undefined;
  const width = item.stroke === 'thick' ? 4 : item.stroke === 'thin' ? 1 : 2;
  return (
    <svg className="nf-kc-glyph" width="44" height="12" viewBox="0 0 44 12" aria-hidden="true" focusable="false">
      {item.stroke === 'double' ? (
        <>
          <line x1="2" y1="4" x2="42" y2="4" stroke="currentColor" strokeWidth="1.5" strokeDasharray={dash} />
          <line x1="2" y1="8" x2="42" y2="8" stroke="currentColor" strokeWidth="1.5" strokeDasharray={dash} />
        </>
      ) : (
        <line x1="2" y1="6" x2={item.stroke === 'beam' ? 36 : 42} y2="6" stroke="currentColor" strokeWidth={width} strokeDasharray={dash} />
      )}
      {item.stroke === 'beam' && <path d="M36 2 L42 6 L36 10" fill="none" stroke="currentColor" strokeWidth="1.5" />}
    </svg>
  );
}

// ── component ────────────────────────────────────────────────────────────────

export interface KeyboardCablingProps {
  /** Canvas-local pixel position of a device (the dialog opens beside it); null → centred. */
  pointFor?(id: DeviceId): { x: number; y: number } | null;
}

interface OpenState {
  readonly seq: number;
  readonly device: DeviceId;
  readonly from: PortRef | null;
  readonly returnFocus: HTMLElement | null;
}

/** Mount once inside the canvas container. Renders nothing until a request arrives. */
export function KeyboardCabling({ pointFor }: KeyboardCablingProps) {
  const [open, setOpen] = useState<OpenState | null>(null);
  const openRef = useRef<OpenState | null>(null);
  openRef.current = open;
  const seq = useRef(0);

  useEffect(() => {
    const listener: RequestListener = (req) => {
      seq.current += 1;
      const active = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const from = 'from' in req ? { device: req.from.device, port: req.from.port } : null;
      const device = 'from' in req ? req.from.device : req.device;
      const returnFocus = openRef.current?.returnFocus ?? active;
      setOpen({ seq: seq.current, device, from, returnFocus });
    };
    requestListeners.add(listener);
    return () => {
      requestListeners.delete(listener);
    };
  }, []);

  const close = useCallback((restore: boolean) => {
    const target = openRef.current?.returnFocus ?? null;
    setOpen(null);
    if (restore && target !== null) {
      queueMicrotask(() => {
        if (target.isConnected) target.focus();
      });
    }
  }, []);

  if (open === null) return null;
  return <CablingDialog key={open.seq} request={open} onClose={close} pointFor={pointFor} />;
}

type Step = 'source' | 'target' | 'confirm';

interface DialogProps {
  request: OpenState;
  onClose(restoreFocus: boolean): void;
  pointFor: ((id: DeviceId) => { x: number; y: number } | null) | undefined;
}

function CablingDialog({ request, onClose, pointFor }: DialogProps) {
  const uid = useId();
  const titleId = `${uid}-title`;
  const listId = `${uid}-list`;
  const statusId = `${uid}-status`;
  const mediaId = `${uid}-media`;

  const snapshot = useStore((s) => s.snapshot);
  const snapshotIndex = useStore((s) => s.snapshotIndex);
  const epoch = useStore((s) => s.epoch);
  const catalog = useStore((s) => s.catalog);
  const modules = useStore((s) => s.modules);
  const mediaTable = useStore((s) => s.media);
  const storeMedia = useStore((s) => s.cable?.media);

  const [localMedia, setLocalMedia] = useState<MediaType>('auto');
  const [from, setFrom] = useState<PortRef | null>(request.from);
  const [to, setTo] = useState<PortRef | null>(null);
  const [query, setQuery] = useState('');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [validation, setValidation] = useState<{ key: string; result: CableValidation } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const connectRef = useRef<HTMLButtonElement>(null);
  const startEpoch = useRef(epoch);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const items = useMemo(() => cablePickerItems(mediaTable), [mediaTable]);
  const chosen = storeMedia ?? localMedia;
  const media: MediaType = items.some((i) => i.media === chosen && i.available) ? chosen : 'auto';
  const mediaItem = items.find((i) => i.media === media) ?? items[0];
  const lookup = useMemo(() => buildCableLookup(catalog, modules ?? []), [catalog, modules]);

  const step: Step = from === null ? 'source' : to === null ? 'target' : 'confirm';
  const device = deviceById(snapshot, snapshotIndex, from?.device ?? request.device);

  // Close when the world changes underneath (reset/load) or the chosen device disappears.
  useEffect(() => {
    if (epoch !== startEpoch.current || snapshot === null || device === undefined) onClose(false);
  }, [epoch, snapshot, device, onClose]);

  // A chosen port that vanished or got cabled elsewhere sends the flow back a step.
  useEffect(() => {
    if (snapshot === null) return;
    if (from !== null) {
      const d = deviceById(snapshot, snapshotIndex, from.device);
      const p = d?.ports.find((x) => x.id === from.port);
      if (p === undefined || p.link !== undefined || !isPickablePort(p)) {
        setFrom(null);
        setTo(null);
        return;
      }
    }
    if (to !== null) {
      const d = deviceById(snapshot, snapshotIndex, to.device);
      const p = d?.ports.find((x) => x.id === to.port);
      if (p === undefined || p.link !== undefined) setTo(null);
    }
  }, [snapshot, snapshotIndex, from, to]);

  // Mirror the first port into the store so the canvas previews the cable; clear it when this dialog ends.
  useEffect(() => {
    if (from === null) return undefined;
    store.getState().setPendingCable({ from, media });
    return () => {
      const st = store.getState();
      if (st.pendingCable !== null && samePort(st.pendingCable.from, from)) st.setPendingCable(null);
    };
  }, [from, media]);

  const candidates = useMemo((): { enabled: CablingCandidate[]; disabled: CablingCandidate[] } => {
    if (snapshot === null || device === undefined || step === 'confirm') return { enabled: [], disabled: [] };
    if (step === 'source') {
      const all = cablingSources(snapshot, lookup, media, device);
      const enabled = all.filter((c) => c.compat.status === 'eligible');
      const disabled = all.filter((c) => c.compat.status !== 'eligible');
      return { enabled: filterCandidates(enabled, query), disabled: filterCandidates(disabled, query) };
    }
    const t = cablingTargets(snapshot, lookup, from as PortRef, media);
    return { enabled: filterCandidates(t.compatible, query), disabled: filterCandidates(t.incompatible, query) };
  }, [snapshot, device, step, lookup, media, from, query]);

  // Keep the active option on an enabled candidate.
  const enabledKeys = candidates.enabled.map((c) => c.key);
  const active = activeKey !== null && enabledKeys.includes(activeKey) ? activeKey : (enabledKeys[0] ?? null);

  // Live validation of the confirm step (same request the pointer tool sends).
  const spec = from !== null && to !== null ? addLinkSpecFor(from, to, media) : null;
  const specKey = spec === null ? null : validationKey(spec);
  useEffect(() => {
    if (spec === null || specKey === null) return undefined;
    let cancelled = false;
    engine
      .validateLink(spec)
      .then((result) => {
        if (!cancelled) setValidation({ key: specKey, result });
      })
      .catch((err: unknown) => {
        if (!cancelled) setValidation({ key: specKey, result: { ok: false, reason: messageOf(err) } });
      });
    return () => {
      cancelled = true;
    };
    // `spec` is fully described by `specKey` (both ends, media, length).
  }, [specKey]);

  // Focus: the filter box on list steps, Connect on the confirm step.
  useEffect(() => {
    if (step === 'confirm') connectRef.current?.focus();
    else inputRef.current?.focus();
  }, [step]);

  // Place the dialog beside the device, inside the canvas container.
  const anchorDevice = from?.device ?? request.device;
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = dialogRef.current;
    const parent = el?.offsetParent instanceof HTMLElement ? el.offsetParent : null;
    const point = pointFor?.(anchorDevice) ?? null;
    if (el === null || parent === null || point === null) {
      setPlacement(null);
      return;
    }
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    const width = Math.min(DIALOG_WIDTH, w - 16);
    let left = point.x + DIALOG_GAP;
    if (left + width > w - 8) left = point.x - DIALOG_GAP - width;
    left = Math.max(8, Math.min(left, w - width - 8));
    const top = Math.max(8, Math.min(point.y - 40, h - el.offsetHeight - 8));
    setPlacement((prev) => (prev !== null && prev.left === left && prev.top === top ? prev : { left, top }));
  }, [pointFor, anchorDevice, step]);

  if (snapshot === null || device === undefined) return null;

  const names = (ref: PortRef): string => {
    const d = deviceById(snapshot, snapshotIndex, ref.device);
    return `${d?.name ?? ref.device} ${ref.port}`;
  };

  const chooseMedia = (m: MediaType): void => {
    const st = store.getState();
    if (st.setCableMedia !== undefined) st.setCableMedia(m);
    else setLocalMedia(m);
    setValidation(null);
    setError(null);
  };

  const pick = (c: CablingCandidate): void => {
    setError(null);
    setQuery('');
    setActiveKey(null);
    if (step === 'source') setFrom(c.ref);
    else setTo(c.ref);
  };

  const back = (): void => {
    setError(null);
    setValidation(null);
    if (step === 'confirm') setTo(null);
    else if (step === 'target' && request.from === null) setFrom(null);
    else onClose(true);
  };

  const connect = async (): Promise<void> => {
    if (spec === null || busy) return;
    setBusy(true);
    setError(null);
    const known = validation !== null && validation.key === specKey ? validation.result : null;
    try {
      await engine.addLink(spec);
      if (!alive.current) return;
      const st = store.getState();
      if (st.pendingCable !== null && samePort(st.pendingCable.from, spec.a)) st.setPendingCable(null);
      if (known !== null && !known.ok) {
        st.toast(`Cable added, but the link will stay down: ${known.reason ?? 'these ports cannot work over it.'}`, 'warn');
      }
      onClose(true);
    } catch (err) {
      if (!alive.current) return;
      const text = messageOf(err);
      setError(text);
      announceWith(store, `The cable was not added: ${text}`);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const moveActive = (delta: number): void => {
    if (enabledKeys.length === 0) return;
    const at = active === null ? -1 : enabledKeys.indexOf(active);
    const next = Math.max(0, Math.min(enabledKeys.length - 1, at + delta));
    setActiveKey(enabledKeys[next] ?? null);
  };

  const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveActive(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveActive(-1);
        break;
      case 'PageDown':
        e.preventDefault();
        moveActive(8);
        break;
      case 'PageUp':
        e.preventDefault();
        moveActive(-8);
        break;
      case 'Enter': {
        e.preventDefault();
        const c = candidates.enabled.find((x) => x.key === active);
        if (c !== undefined) pick(c);
        break;
      }
      default:
        break;
    }
  };

  const onDialogKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    // The global hotkeys (tool switching, play/pause, delete) must not see keys typed in the dialog.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose(true);
      return;
    }
    if (e.key === 'Backspace' && e.altKey) {
      e.preventDefault();
      back();
      return;
    }
    if (e.key === 'Tab' && dialogRef.current !== null) {
      const list = focusables(dialogRef.current);
      const first = list[0];
      const last = list[list.length - 1];
      if (first === undefined || last === undefined) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const stopKeyUp = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    e.stopPropagation();
  };

  const sourceName = from !== null ? names(from) : device.name;
  const heading = step === 'source' ? `Connect a cable to ${device.name}` : `Connect a cable from ${sourceName}`;
  const listLabel = step === 'source' ? `Port on ${device.name} to start from` : 'Port to connect to';
  const count = candidates.enabled.length;
  const refused = candidates.disabled.length;
  const statusText =
    step === 'source'
      ? `${count} free ${count === 1 ? 'port takes' : 'ports take'} this cable${refused > 0 ? `; ${refused} ${refused === 1 ? 'does' : 'do'} not` : ''}.`
      : `${count} ${count === 1 ? 'port accepts' : 'ports accept'} this cable${refused > 0 ? `; ${refused} ${refused === 1 ? 'refuses' : 'refuse'} it` : ''}.`;

  const verdict = validation !== null && validation.key === specKey ? verdictText(validation.result, media) : null;
  const dce = serialDceHint(media, from ?? undefined, to ?? undefined, {
    ...(from !== null ? { from: names(from) } : {}),
    ...(to !== null ? { to: names(to) } : {}),
  });

  const style = placement !== null ? { left: placement.left, top: placement.top } : undefined;

  return (
    <div
      ref={dialogRef}
      className={`nf-kc${placement === null ? ' is-centred' : ''}`}
      style={style}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={onDialogKey}
      onKeyUp={stopKeyUp}
    >
      <div className="nf-kc-head">
        <h2 id={titleId} className="nf-kc-title">
          {heading}
        </h2>
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Close cable dialog" onClick={() => onClose(true)}>
          ✕
        </button>
      </div>

      <div className="nf-kc-row">
        <label htmlFor={mediaId}>Cable</label>
        <select id={mediaId} value={media} onChange={(e) => chooseMedia(e.target.value as MediaType)} disabled={step === 'confirm' || busy}>
          {items.map((i) => (
            <option key={i.media} value={i.media} disabled={!i.available}>
              {`${i.badge} · ${i.label}${i.available ? '' : ' (not offered)'}`}
            </option>
          ))}
        </select>
        {mediaItem !== undefined && <MediaGlyph item={mediaItem} />}
      </div>
      {mediaItem !== undefined && (
        <p className="nf-kc-note">
          {mediaItem.description}
          {mediaItem.dceHint !== undefined && step !== 'confirm' ? ` ${mediaItem.dceHint}` : ''}
        </p>
      )}

      {step !== 'confirm' && (
        <>
          <label className="nf-kc-label" htmlFor={`${listId}-input`}>
            {listLabel}
          </label>
          <input
            id={`${listId}-input`}
            ref={inputRef}
            className="nf-kc-input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-describedby={statusId}
            aria-activedescendant={active !== null ? `${listId}-${active}` : undefined}
            placeholder="Type to filter ports"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveKey(null);
            }}
            onKeyDown={onInputKey}
          />
          <p id={statusId} className="nf-kc-status" aria-live="polite">
            {statusText}
          </p>
          <ul id={listId} className="nf-kc-list" role="listbox" aria-label={listLabel}>
            {candidates.enabled.map((c) => (
              <li
                key={c.key}
                id={`${listId}-${c.key}`}
                role="option"
                aria-selected={c.key === active}
                className={`nf-kc-option${c.key === active ? ' is-active' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(c)}
              >
                <span className="nf-kc-port">{c.label}</span>
                <span className="nf-kc-verdict">{c.verdict}</span>
              </li>
            ))}
            {candidates.disabled.map((c) => (
              <li key={c.key} id={`${listId}-${c.key}`} role="option" aria-selected={false} aria-disabled="true" className="nf-kc-option is-disabled">
                <span className="nf-kc-port">{c.label}</span>
                <span className="nf-kc-verdict">{c.verdict}</span>
              </li>
            ))}
            {count + refused === 0 && (
              <li role="option" aria-selected={false} aria-disabled="true" className="nf-kc-option is-empty">
                {query.trim() !== '' ? 'No port matches this filter.' : 'No free port can take a cable here.'}
              </li>
            )}
          </ul>
        </>
      )}

      {step === 'confirm' && from !== null && to !== null && (
        <div className="nf-kc-confirm">
          <p className="nf-kc-summary">
            <b>{names(from)}</b> to <b>{names(to)}</b> with {MEDIA_VOCAB[media].name}.
          </p>
          <p className={`nf-kc-verdict-box${verdict === null ? ' is-wait' : verdict.ok ? ' is-ok' : ' is-err'}`} aria-live="polite">
            {verdict === null ? '… checking the cable' : `${verdict.title}: ${verdict.detail}`}
          </p>
          {dce !== undefined && <p className="nf-kc-note">⏱ {dce.text}</p>}
        </div>
      )}

      {error !== null && (
        <p className="nf-kc-error" role="alert">
          ✕ {error}
        </p>
      )}

      <div className="nf-kc-actions">
        <button type="button" className="btn" onClick={back} disabled={busy}>
          {step === 'source' || (step === 'target' && request.from !== null) ? 'Cancel' : 'Back'}
        </button>
        {step === 'confirm' && (
          <button ref={connectRef} type="button" className="btn btn-primary" onClick={() => void connect()} disabled={busy}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        )}
      </div>
      <p className="nf-kc-help">Arrow keys choose, Enter confirms, Alt+Backspace goes back, Escape closes.</p>
    </div>
  );
}
