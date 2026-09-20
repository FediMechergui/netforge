/**
 * Shared pieces of the Desktop apps (ARCHITECTURE-P1 §7 "Desktop tab"): device lookup by id through the
 * snapshot index, process StateView access, the configure round trip (D9: every setting goes through
 * `EngineApi.configure` and the device's own CLI grammar), signal bars and small form widgets.
 *
 * Nothing here branches on device kind; apps find their ports by kind and role (D2/D3). Wording is original.
 */
import type { ReactNode } from 'react';
import { RF } from '@netforge/engine';
import type { DeviceId, DeviceSnapshot, PortRef, SimSnapshot } from '@netforge/engine';
import { engine } from '../bridge/client';
import { useStore } from '../store/store';
import type { SnapshotIndex } from '../store/types';
import { isEmptyPlan } from '../gui/commands.js';
import type { CommandPlan } from '../gui/commands.js';
import { mapConfigureResult } from '../gui/forms.js';
import type { SubmitOutcome } from '../gui/forms.js';

/** Props every Desktop app receives from the window layer. */
export interface DesktopAppProps {
  readonly deviceId: DeviceId;
  /** Window id (`DesktopWindow.id`). */
  readonly windowId: number;
}

/** Device of `id` through the snapshot index (a linear search only when the index is missing or stale). */
export function deviceById(snapshot: Pick<SimSnapshot, 'devices'> | null, index: Pick<SnapshotIndex, 'devices'> | undefined, id: DeviceId): DeviceSnapshot | undefined {
  if (snapshot === null) return undefined;
  const i = index?.devices[id];
  const hit = i === undefined ? undefined : snapshot.devices[i];
  if (hit !== undefined && hit.id === id) return hit;
  return snapshot.devices.find((d) => d.id === id);
}

/** Live device snapshot of `id` (undefined once the device is removed). */
export function useDeviceById(id: DeviceId): DeviceSnapshot | undefined {
  return useStore((s) => deviceById(s.snapshot, s.snapshotIndex, id));
}

/** Display name of a `device/port` key or PortRef (`"TOWER1 Cellular0"`), falling back to the raw text. */
export function portRefName(snapshot: Pick<SimSnapshot, 'devices'> | null, index: Pick<SnapshotIndex, 'devices'> | undefined, ref: PortRef | string): string {
  const r = typeof ref === 'string' ? splitPortKey(ref) : ref;
  if (r === undefined) return String(ref);
  const d = deviceById(snapshot, index, r.device);
  return d === undefined ? `${r.device} ${r.port}` : `${d.name} ${r.port}`;
}

/** `device/port` → PortRef (the first slash separates; port names may contain slashes). */
export function splitPortKey(key: string): PortRef | undefined {
  const at = key.indexOf('/');
  if (at <= 0 || at === key.length - 1) return undefined;
  return { device: key.slice(0, at), port: key.slice(at + 1) };
}

/** A process's StateView `state` object, if the device runs that process. */
export function processState(device: Pick<DeviceSnapshot, 'processes'>, process: string): Record<string, unknown> | undefined {
  return device.processes.find((p) => p.process === process)?.state;
}

/** The `ports` rows of a daemon StateView that match `port` (daemons list one row per managed port). */
export function processPortRow(state: Record<string, unknown> | undefined, port: string): Record<string, unknown> | undefined {
  const rows = state?.['ports'];
  if (!Array.isArray(rows)) return undefined;
  for (const row of rows) {
    if (row !== null && typeof row === 'object' && (row as Record<string, unknown>)['port'] === port) return row as Record<string, unknown>;
  }
  return undefined;
}

/** Signal bars (0–4) of a received level, from the engine's bar thresholds. */
export function signalBars(rssiDbm: number | undefined): 0 | 1 | 2 | 3 | 4 {
  if (rssiDbm === undefined || !Number.isFinite(rssiDbm)) return 0;
  const mdb = Math.round(rssiDbm * 1000);
  let bars = 0;
  for (const threshold of RF.BARS_MDB) if (mdb >= threshold) bars++;
  return Math.min(4, bars) as 0 | 1 | 2 | 3 | 4;
}

/** `54 Mb/s`, `1.2 Gb/s`, `600 kb/s`. */
export function formatRate(bps: number | undefined): string {
  if (bps === undefined || !Number.isFinite(bps) || bps <= 0) return 'no data rate';
  if (bps >= 1_000_000_000) return `${trim(bps / 1_000_000_000)} Gb/s`;
  if (bps >= 1_000_000) return `${trim(bps / 1_000_000)} Mb/s`;
  if (bps >= 1_000) return `${trim(bps / 1_000)} kb/s`;
  return `${bps} b/s`;
}

function trim(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

/** Error text of a rejected engine call. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Outcome of a plan that sends nothing. */
export const NOTHING_TO_SEND: SubmitOutcome = Object.freeze({ ok: true, reverted: false, fieldErrors: {}, general: Object.freeze([]), skipped: 0 });

/**
 * Run a command plan through the headless configure session of `device` and map the result onto form fields.
 * An empty plan sends nothing. Rejections (device removed, worker fault) become a general message.
 */
export async function submitPlan(device: DeviceId, plan: CommandPlan): Promise<SubmitOutcome> {
  if (isEmptyPlan(plan)) return NOTHING_TO_SEND;
  try {
    const result = await engine.configure(device, [...plan.commands], { ...plan.options });
    return mapConfigureResult(plan, result);
  } catch (err) {
    return Object.freeze({ ok: false, reverted: false, fieldErrors: {}, general: Object.freeze([`The simulator did not accept the request: ${errorText(err)}`]), skipped: 0 });
  }
}

/** Sentence for a failed submit (general messages, plus a note when the device undid the partial change). */
export function outcomeMessages(outcome: SubmitOutcome): readonly string[] {
  const out = [...outcome.general];
  if (outcome.reverted) out.push('Nothing was changed: the device undid the settings it had already taken.');
  if (outcome.skipped > 0 && !outcome.reverted) out.push(`${outcome.skipped} later setting${outcome.skipped === 1 ? ' was' : 's were'} not applied.`);
  return out;
}

/** Why the device cannot take settings right now, or undefined when it can. */
export function deviceBusyReason(device: Pick<DeviceSnapshot, 'power' | 'booted'>): string | undefined {
  if (!device.power) return 'The device is switched off. Turn it on to change settings.';
  if (!device.booted) return 'The device is still starting up.';
  return undefined;
}

/** Signal strength as bars (shape and count) plus text; colour is never the only channel. */
export function SignalBars({ bars, label }: { bars: 0 | 1 | 2 | 3 | 4; label?: string }) {
  const text = label ?? `Signal ${bars} of 4`;
  return (
    <span className="desk-bars" role="img" aria-label={text} title={text}>
      <svg viewBox="0 0 20 14" width="20" height="14" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <rect
            key={i}
            x={1 + i * 5}
            y={11 - i * 3}
            width={3.4}
            height={3 + i * 3}
            rx={0.6}
            className={i < bars ? 'desk-bar is-on' : 'desk-bar'}
          />
        ))}
      </svg>
    </span>
  );
}

/** A labelled text input with an inline error (glyph + text) wired through aria-describedby. */
export function TextField(props: {
  id: string;
  label: string;
  value: string;
  error?: string | undefined;
  hint?: string;
  type?: 'text' | 'password';
  disabled?: boolean;
  placeholder?: string;
  autoComplete?: string;
  onChange: (value: string) => void;
}) {
  const { id, label, value, error, hint, type = 'text', disabled, placeholder, autoComplete = 'off', onChange } = props;
  const errId = `${id}-err`;
  const hintId = `${id}-hint`;
  const described = [error !== undefined ? errId : '', hint !== undefined ? hintId : ''].filter((x) => x !== '').join(' ');
  return (
    <div className={`desk-field ${error !== undefined ? 'has-error' : ''}`}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="input"
        type={type}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        autoComplete={autoComplete}
        spellCheck={false}
        aria-invalid={error !== undefined}
        aria-describedby={described === '' ? undefined : described}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint !== undefined && (
        <span id={hintId} className="desk-hint">
          {hint}
        </span>
      )}
      {error !== undefined && (
        <span id={errId} className="desk-error">
          <span aria-hidden="true">⚠ </span>
          {error}
        </span>
      )}
    </div>
  );
}

/** Messages under a form: errors (role alert) or a success line (role status). */
export function FormStatus({ ok, messages }: { ok: boolean | null; messages: readonly string[] }) {
  if (messages.length === 0) return null;
  if (ok === true) {
    return (
      <p className="desk-status is-ok" role="status">
        <span aria-hidden="true">✓ </span>
        {messages.join(' ')}
      </p>
    );
  }
  return (
    <div className={`desk-status ${ok === false ? 'is-error' : ''}`} role={ok === false ? 'alert' : 'status'}>
      {messages.map((m, i) => (
        <p key={i}>
          {ok === false && <span aria-hidden="true">⚠ </span>}
          {m}
        </p>
      ))}
    </div>
  );
}

/** Shown by an app whose device no longer exists. */
export function DeviceGone() {
  return <p className="desk-empty">This device is no longer on the canvas.</p>;
}

/** A labelled read-only value row. */
export function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="desk-info-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
