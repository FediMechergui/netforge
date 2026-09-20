/**
 * Access point settings panel (GUI panel `wireless.ap`; ARCHITECTURE-P1 D9, §3.12, §6, §7 "AP / home router / radio /
 * tower settings").
 *
 * Every access radio (`wlan` port with role `wireless-bss`) gets its network name, security mode and password, band,
 * channel (including automatic), channel width and transmit power. The panel never writes configuration itself: it
 * validates the form (gui/forms.ts), turns the edited form and the values it loaded into canonical interface lines
 * (gui/commands.ts) and sends them through `EngineApi.configure`, so the device's own CLI grammar checks every line.
 * Per-line errors come back with caret columns and are shown next to the input that produced the token.
 *
 * This module also holds the small toolkit the other settings panels (HomeRouterPanel, RadioLinkPanel,
 * CellTowerPanel) share: the submit runner, the draft/baseline form hook, field and status components, radio spec
 * lookup and the radio fields block. All wording is original (§1.6); state is never shown by colour alone.
 */
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CHANNELS } from '@netforge/engine';
import type {
  AssociationSnapshot,
  DeviceId,
  DeviceModel,
  DeviceSnapshot,
  PortId,
  PortSnapshot,
  RadioPortSpec,
  RfBand,
  WifiSecurity,
} from '@netforge/engine';
import { engine } from '../bridge/client';
import type { EngineApi } from '../bridge/protocol';
import { useStore } from '../store/store';
import { isEmptyPlan, mergePlans, wirelessApCommands } from '../gui/commands';
import type { CommandPlan } from '../gui/commands';
import {
  BAND_LABELS,
  CHANNEL_WIDTHS,
  DEFAULT_MAX_TX_POWER_DBM,
  PASSPHRASE_MAX,
  RADIO_BANDS,
  SSID_MAX,
  WIFI_SECURITY_LABELS,
  WIFI_SECURITY_MODES,
  hasErrors,
  mapConfigureResult,
  validateWirelessApForm,
  wirelessApFormFrom,
} from '../gui/forms';
import type { FormErrors, SubmitOutcome, WirelessApForm } from '../gui/forms';

// ── submit runner (shared) ───────────────────────────────────────────────────

/** The part of the engine the settings panels submit through. */
export type ConfigureApi = Pick<EngineApi, 'configure'>;

/** What one Apply press produced. */
export interface PanelSubmitResult {
  /** Lines handed to `configure`; null when nothing was sent (invalid form, or nothing changed). */
  readonly sent: readonly string[] | null;
  /** Client-side validation messages (nothing is sent while any exist). */
  readonly clientErrors: FormErrors;
  /** Mapped engine result; null when nothing was sent. */
  readonly outcome: SubmitOutcome | null;
}

/** Message shown when the bridge offers no configure call. */
export const MSG_CONFIGURE_UNAVAILABLE = 'This build cannot apply device settings yet: the settings service is not connected.';
/** Message shown when the configure call itself failed (worker fault, unknown device). */
export const MSG_CONFIGURE_FAILED = 'The settings could not be sent to the device.';

function failedOutcome(message: string): SubmitOutcome {
  return Object.freeze({ ok: false, reverted: false, fieldErrors: {}, general: Object.freeze([message]), skipped: 0 });
}

/**
 * Send `plan` to `device` through `api.configure` and map the result onto form fields. An empty plan is not sent and
 * yields `null`. A rejected call becomes a general message (never an exception).
 */
export async function submitPlan(api: ConfigureApi, device: DeviceId, plan: CommandPlan): Promise<SubmitOutcome | null> {
  if (isEmptyPlan(plan)) return null;
  // Called as a method: `engine` is a Comlink proxy, where reading `.call` off the function would name a remote member.
  if (api.configure === undefined) return failedOutcome(MSG_CONFIGURE_UNAVAILABLE);
  try {
    const result = await api.configure(device, [...plan.commands], { ...plan.options });
    return mapConfigureResult(plan, result);
  } catch (err) {
    const detail = err instanceof Error && err.message !== '' ? ` ${err.message}` : '';
    return failedOutcome(`${MSG_CONFIGURE_FAILED}${detail}`);
  }
}

/** Validate, build and submit in one step: nothing is sent while `clientErrors` is non-empty or the plan is empty. */
export async function runPanelSubmit(api: ConfigureApi, device: DeviceId, clientErrors: FormErrors, build: () => CommandPlan): Promise<PanelSubmitResult> {
  if (hasErrors(clientErrors)) return Object.freeze({ sent: null, clientErrors, outcome: null });
  const plan = build();
  if (isEmptyPlan(plan)) return Object.freeze({ sent: null, clientErrors, outcome: null });
  const outcome = await submitPlan(api, device, plan);
  return Object.freeze({ sent: plan.commands, clientErrors, outcome });
}

// ── radio spec lookup (shared) ───────────────────────────────────────────────

/** Catalog RadioPortSpec of a device port (module ports and unknown models give undefined). */
export function radioSpecOf(catalog: readonly DeviceModel[], type: string, port: PortId): RadioPortSpec | undefined {
  const model = catalog.find((m) => m.type === type);
  return model?.ports.find((p) => p.name === port)?.radio;
}

/** RadioPortSpecs of the given ports of `device`, keyed by port id (entries without a spec are left out). */
export function radioSpecsOf(catalog: readonly DeviceModel[], type: string, ports: readonly PortId[]): Readonly<Record<PortId, RadioPortSpec>> {
  const out: Record<PortId, RadioPortSpec> = {};
  for (const port of ports) {
    const spec = radioSpecOf(catalog, type, port);
    if (spec !== undefined) out[port] = spec;
  }
  return out;
}

/** Hook: RadioPortSpecs for `ports` of `device` from the store catalog. */
export function useRadioSpecs(type: string, ports: readonly PortId[]): Readonly<Record<PortId, RadioPortSpec>> {
  const catalog = useStore((s) => s.catalog);
  // `key` carries the port list, whose array identity changes every render.
  const key = ports.join('\n');
  return useMemo(() => radioSpecsOf(catalog, type, key === '' ? [] : key.split('\n')), [catalog, type, key]);
}

// ── form hook (shared) ───────────────────────────────────────────────────────

/** Draft/baseline state of one settings form. */
export interface SettingsForm<F> {
  /** What the inputs hold. */
  readonly draft: F;
  /** The values the draft was loaded from (commands are built against it). */
  readonly baseline: F;
  /** The user edited something since loading or applying. */
  readonly dirty: boolean;
  /** The device's values changed while the draft was being edited. */
  readonly stale: boolean;
  update(change: (draft: F) => F): void;
  /** Load the device's current values, dropping the edits. */
  reload(): void;
  /** The draft was applied: it becomes the baseline and the form is clean again. */
  markApplied(applied: F): void;
}

/** Internal state of `useSettingsForm` (exported with its transitions so they can be tested without React). */
export interface SettingsFormState<F> {
  readonly draft: F;
  readonly baseline: F;
  /** JSON of the device values the baseline was taken from. */
  readonly baselineKey: string;
  readonly dirty: boolean;
  readonly resetKey: string;
}

/** Device values as the form sees them: the value and its JSON key. */
export interface LiveValues<F> {
  readonly value: F;
  readonly key: string;
}

/** A fresh, clean form state for `live`. */
export function initialFormState<F>(live: LiveValues<F>, resetKey: string): SettingsFormState<F> {
  return { draft: live.value, baseline: live.value, baselineKey: live.key, dirty: false, resetKey };
}

/**
 * The device values changed (or the identity did): a new identity reloads unconditionally, a clean form follows the
 * device, an edited form stays put (it becomes `stale`).
 */
export function syncFormState<F>(s: SettingsFormState<F>, live: LiveValues<F>, resetKey: string): SettingsFormState<F> {
  if (s.resetKey !== resetKey) return initialFormState(live, resetKey);
  if (s.dirty || s.baselineKey === live.key) return s;
  return { ...s, draft: live.value, baseline: live.value, baselineKey: live.key };
}

/**
 * An Apply succeeded. When the device values already moved on since the baseline was loaded (the engine posts its
 * update before `configure` resolves), the form shows them at once. Otherwise it shows what was applied and keeps the
 * old key, so the device values arriving next replace it (normalised addresses, cleared secrets).
 */
export function appliedFormState<F>(s: SettingsFormState<F>, applied: F, live: LiveValues<F>): SettingsFormState<F> {
  if (live.key !== s.baselineKey) return { ...s, draft: live.value, baseline: live.value, baselineKey: live.key, dirty: false };
  return { ...s, draft: applied, baseline: applied, dirty: false };
}

/**
 * Keep an editable draft of `current` (the values read from the snapshot). While the form is clean it follows the
 * device; once edited it stays put and reports `stale` when the device changes underneath. `resetKey` (the device
 * and port identity) reloads unconditionally.
 */
export function useSettingsForm<F>(current: F, resetKey: string): SettingsForm<F> {
  const currentKey = JSON.stringify(current);
  const [state, setState] = useState<SettingsFormState<F>>(() => initialFormState({ value: current, key: currentKey }, resetKey));
  const currentRef = useRef<LiveValues<F>>({ value: current, key: currentKey });
  currentRef.current = { value: current, key: currentKey };

  useEffect(() => {
    setState((s) => syncFormState(s, currentRef.current, resetKey));
  }, [currentKey, resetKey]);

  const update = useCallback((change: (draft: F) => F) => {
    setState((s) => ({ ...s, draft: change(s.draft), dirty: true }));
  }, []);
  const reload = useCallback(() => {
    const live = currentRef.current;
    setState((s) => ({ ...s, draft: live.value, baseline: live.value, baselineKey: live.key, dirty: false }));
  }, []);
  const markApplied = useCallback((applied: F) => {
    setState((s) => appliedFormState(s, applied, currentRef.current));
  }, []);

  return {
    draft: state.draft,
    baseline: state.baseline,
    dirty: state.dirty,
    stale: state.dirty && state.baselineKey !== currentKey,
    update,
    reload,
    markApplied,
  };
}

/** Busy flag, last outcome and errors of a panel's Apply button. */
export interface SubmitState {
  readonly busy: boolean;
  readonly outcome: SubmitOutcome | null;
  readonly clientErrors: FormErrors;
  /** True after an Apply press that changed nothing. */
  readonly nothingToApply: boolean;
  /** Run one submit; resolves with the result once state is updated. */
  run(submit: () => Promise<PanelSubmitResult>): Promise<PanelSubmitResult | undefined>;
  /** Forget the messages for `field` (the user is fixing it). */
  clearField(field: string): void;
  /** Forget every message. */
  clear(): void;
}

/** Hook: submit bookkeeping with unmount protection. */
export function useSubmitState(resetKey: string): SubmitState {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SubmitOutcome | null>(null);
  const [clientErrors, setClientErrors] = useState<FormErrors>({});
  const [nothingToApply, setNothingToApply] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    setOutcome(null);
    setClientErrors({});
    setNothingToApply(false);
  }, [resetKey]);

  const run = useCallback(async (submit: () => Promise<PanelSubmitResult>) => {
    setBusy(true);
    setNothingToApply(false);
    try {
      const result = await submit();
      if (!alive.current) return undefined;
      setClientErrors(result.clientErrors);
      setOutcome(result.outcome);
      setNothingToApply(result.sent === null && !hasErrors(result.clientErrors));
      return result;
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);

  const clearField = useCallback((field: string) => {
    const drop = (errors: FormErrors): FormErrors => {
      if (errors[field] === undefined) return errors;
      const next = { ...errors };
      delete next[field];
      return next;
    };
    setClientErrors(drop);
    setOutcome((o) => (o === null || o.fieldErrors[field] === undefined ? o : { ...o, fieldErrors: drop(o.fieldErrors) }));
    setNothingToApply(false);
  }, []);

  const clear = useCallback(() => {
    setClientErrors({});
    setOutcome(null);
    setNothingToApply(false);
  }, []);

  return { busy, outcome, clientErrors, nothingToApply, run, clearField, clear };
}

/** Message for `field`: a client-side check first, then the device's answer. */
export function fieldError(submit: Pick<SubmitState, 'clientErrors' | 'outcome'>, field: string): string | undefined {
  return submit.clientErrors[field] ?? submit.outcome?.fieldErrors[field];
}

// ── shared components ────────────────────────────────────────────────────────

/** One labelled input with its error message (linked through aria-describedby). */
export function SettingsField({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [error !== undefined ? errorId : undefined, hint !== undefined ? hintId : undefined].filter((v) => v !== undefined).join(' ');
  return (
    <>
      <dt>
        <label htmlFor={id}>{label}</label>
      </dt>
      <dd>
        {children({ id, describedBy: describedBy === '' ? undefined : describedBy, invalid: error !== undefined })}
        {hint !== undefined && (
          <div id={hintId} className="insp-note">
            {hint}
          </div>
        )}
        {error !== undefined && (
          <div id={errorId} role="alert" className="reason-box" style={{ borderLeftColor: 'var(--err)' }}>
            <span aria-hidden="true">✖ </span>
            {error}
          </div>
        )}
      </dd>
    </>
  );
}

/** Apply / Revert buttons plus the outcome of the last Apply. */
export function SubmitBar({
  submit,
  form,
  canApply,
  disabledReason,
  onApply,
  applyLabel = 'Apply settings',
}: {
  submit: SubmitState;
  form: Pick<SettingsForm<unknown>, 'dirty' | 'stale' | 'reload'>;
  canApply: boolean;
  disabledReason?: string;
  onApply(): void;
  applyLabel?: string;
}) {
  const { outcome, busy } = submit;
  const clientCount = Object.keys(submit.clientErrors).length;
  const deviceFieldCount = outcome === null ? 0 : Object.keys(outcome.fieldErrors).length;
  return (
    <section className="insp-section" aria-live="polite">
      {form.stale && (
        <div className="reason-box" role="status">
          <span aria-hidden="true">▲ </span>
          These settings changed on the device while you were editing.{' '}
          <button type="button" className="link-btn" onClick={() => form.reload()}>
            Load the current values
          </button>
        </div>
      )}
      {disabledReason !== undefined && !canApply && <div className="insp-note">{disabledReason}</div>}
      <div className="insp-actions">
        <button type="button" className="btn btn-primary" disabled={!canApply || busy} onClick={onApply}>
          {busy ? 'Applying…' : applyLabel}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || !form.dirty}
          onClick={() => {
            form.reload();
            submit.clear();
          }}
          title="Discard the edits and show the device's current values"
        >
          ↺ Revert
        </button>
      </div>
      {clientCount > 0 && (
        <div className="reason-box" role="alert" style={{ borderLeftColor: 'var(--err)' }}>
          <span aria-hidden="true">✖ </span>
          {clientCount === 1 ? 'One field needs attention' : `${clientCount} fields need attention`} before anything is sent.
        </div>
      )}
      {submit.nothingToApply && (
        <div className="insp-note" role="status">
          Nothing changed, so nothing was sent.
        </div>
      )}
      {outcome !== null && outcome.ok && (
        <div className="reason-box ok" role="status">
          <span aria-hidden="true">✔ </span>
          The device accepted the new settings.
        </div>
      )}
      {outcome !== null && !outcome.ok && (
        <div className="reason-box" role="alert" style={{ borderLeftColor: 'var(--err)' }}>
          <div>
            <span aria-hidden="true">✖ </span>
            The device refused {deviceFieldCount + outcome.general.length === 1 ? 'a setting' : 'some settings'}
            {outcome.reverted ? ', so none of the changes were kept.' : '.'}
          </div>
          {outcome.skipped > 0 && (
            <div>
              {outcome.skipped === 1 ? 'One later line was not tried.' : `${outcome.skipped} later lines were not tried.`}
            </div>
          )}
          {outcome.general.length > 0 && (
            <ul>
              {outcome.general.map((msg, i) => (
                <li key={i}>{msg}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/** Why a device cannot take settings right now, or undefined when it can. */
export function deviceNotReadyReason(device: Pick<DeviceSnapshot, 'power' | 'booted'>): string | undefined {
  if (!device.power) return 'The device is powered off. Turn it on to change its settings.';
  if (!device.booted) return 'The device is still starting up. Settings can be changed once it has booted.';
  return undefined;
}

/** Signal strength as bar glyphs with a text alternative (never colour alone). */
export function SignalBars({ bars, rssiDbm }: { bars: number; rssiDbm?: number }) {
  const n = Math.max(0, Math.min(4, Math.round(bars)));
  const label = `${n} of 4 bars${rssiDbm !== undefined ? `, ${rssiDbm} dBm` : ''}`;
  return (
    <span className="mono" role="img" aria-label={label} title={label}>
      {'▮'.repeat(n)}
      {'▯'.repeat(4 - n)}
      {rssiDbm !== undefined && <span className="dim"> {rssiDbm} dBm</span>}
    </span>
  );
}

/** Human rate text for bits per second. */
export function rateText(bps: number | undefined): string {
  if (bps === undefined || !Number.isFinite(bps) || bps <= 0) return '—';
  if (bps >= 1_000_000_000) return `${Number((bps / 1_000_000_000).toFixed(2))} Gb/s`;
  if (bps >= 1_000_000) return `${Number((bps / 1_000_000).toFixed(1))} Mb/s`;
  if (bps >= 1_000) return `${Number((bps / 1_000).toFixed(1))} kb/s`;
  return `${bps} b/s`;
}

/** Plain wording of a Wi-Fi association or cellular attach state. */
export const LINK_STATE_TEXT: Readonly<Record<AssociationSnapshot['state'], string>> = Object.freeze({
  idle: 'idle',
  scanning: 'looking for networks',
  authenticating: 'checking identity',
  associating: 'joining',
  handshake: 'exchanging keys',
  associated: 'connected',
  failed: 'could not connect',
  searching: 'looking for a tower',
  attaching: 'attaching',
  attached: 'attached',
  detached: 'detached',
});

/** Hook: associations served by `ports` of `device` (Wi-Fi AP radios or tower radios), in snapshot order. */
export function useServedAssociations(device: DeviceId, ports: readonly PortId[]): readonly AssociationSnapshot[] {
  const media = useStore((s) => s.snapshot?.media);
  // `key` carries the port list, whose array identity changes every render.
  const key = ports.join('\n');
  return useMemo(() => {
    const wanted = new Set(key === '' ? [] : key.split('\n'));
    return (media?.associations ?? []).filter((a) => a.ap !== undefined && a.ap.device === device && wanted.has(a.ap.port));
  }, [media, device, key]);
}

/** Hook: device display name by id, through the snapshot index. */
export function useDeviceNames(): (id: DeviceId) => string {
  const snapshot = useStore((s) => s.snapshot);
  const index = useStore((s) => s.snapshotIndex);
  return useCallback(
    (id: DeviceId) => {
      if (snapshot === null) return id;
      const at = index?.devices[id];
      const dev = at !== undefined ? snapshot.devices[at] : snapshot.devices.find((d) => d.id === id);
      return dev !== undefined && dev.id === id ? dev.name : id;
    },
    [snapshot, index],
  );
}

/** Table of the stations or phones a radio serves. */
export function ClientTable({ associations, empty }: { associations: readonly AssociationSnapshot[]; empty: string }) {
  const nameOf = useDeviceNames();
  if (associations.length === 0) return <div className="insp-note">{empty}</div>;
  return (
    <table className="table compact">
      <thead>
        <tr>
          <th>Device</th>
          <th>State</th>
          <th>Signal</th>
          <th className="num">Rate</th>
          <th className="num">Distance</th>
        </tr>
      </thead>
      <tbody>
        {associations.map((a) => (
          <tr key={a.id}>
            <td>
              {nameOf(a.station.device)} <span className="dim mono">{a.station.port}</span>
            </td>
            <td>
              {a.authorized ? <span aria-hidden="true">● </span> : <span aria-hidden="true">◌ </span>}
              {LINK_STATE_TEXT[a.state]}
              {a.holdUntil !== undefined && <span className="dim"> (signal lost, holding)</span>}
            </td>
            <td>
              <SignalBars bars={a.bars} rssiDbm={a.rssiDbm} />
            </td>
            <td className="num">{rateText(a.rateBps)}</td>
            <td className="num">{`${Math.round(a.distanceM)} m`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── radio fields (shared with the home router panel) ─────────────────────────

/** Bands a Wi-Fi radio offers in its band list: the spec's Wi-Fi bands, else every Wi-Fi band. */
export function wifiBandsFor(spec: RadioPortSpec | undefined): readonly Exclude<RfBand, 'cell'>[] {
  if (spec === undefined) return RADIO_BANDS;
  const bands = RADIO_BANDS.filter((b) => spec.bands.includes(b));
  return bands.length > 0 ? bands : RADIO_BANDS;
}

/** Channel widths offered on `band` for `spec` (60 GHz has none). */
export function widthsFor(band: string, spec: RadioPortSpec | undefined): readonly number[] {
  if (band === '60') return [];
  return CHANNEL_WIDTHS.filter((w) => (band !== '2.4' || w <= 40) && (spec === undefined || w <= spec.maxWidthMhz));
}

/**
 * Keep the channel and width meaningful after a band change: a fixed channel that does not exist on the new band
 * becomes the radio's default channel (when the default band is chosen) or the band's first channel; a width the
 * band cannot use falls back to 20 MHz. 'auto' is kept.
 */
export function withBand<T extends { band: string; channel: string; widthMhz?: string }>(form: T, band: string, spec: RadioPortSpec | undefined): T {
  const next: T = { ...form, band };
  const list = (RADIO_BANDS as readonly string[]).includes(band) ? CHANNELS[band as Exclude<RfBand, 'cell'>] : [];
  const channel = form.channel.trim();
  if (channel !== 'auto' && !list.includes(Number(channel))) {
    const fallback = spec !== undefined && spec.defaultBand === band && list.includes(spec.defaultChannel) ? spec.defaultChannel : list[0];
    next.channel = fallback === undefined ? '' : String(fallback);
  }
  if (form.widthMhz !== undefined && band !== '60') {
    const widths = widthsFor(band, spec);
    if (!widths.includes(Number(form.widthMhz))) next.widthMhz = '20';
  }
  return next;
}

/** Plain wording of the radio's live state. */
function radioStatus(port: PortSnapshot | undefined): { glyph: string; text: string } {
  if (port === undefined) return { glyph: '○', text: 'not present' };
  if (!port.adminUp) return { glyph: '■', text: 'turned off' };
  const radio = port.radio;
  if (radio === undefined) return { glyph: '▲', text: 'no radio information yet' };
  if (radio.up) return { glyph: '●', text: `broadcasting on channel ${radio.channel}` };
  return { glyph: '▲', text: radio.ssid === undefined || radio.ssid === '' ? 'idle (no network name)' : 'not broadcasting' };
}

/**
 * Inputs of one access radio. Field keys are `${prefix}ssid` etc., matching gui/commands.ts and gui/forms.ts so
 * device errors land on the right input.
 */
export function RadioFields({
  form,
  spec,
  port,
  prefix,
  submit,
  onChange,
  disabled,
}: {
  form: WirelessApForm;
  spec: RadioPortSpec | undefined;
  port: PortSnapshot | undefined;
  prefix: string;
  submit: Pick<SubmitState, 'clientErrors' | 'outcome' | 'clearField'>;
  onChange(next: WirelessApForm, field: string): void;
  disabled: boolean;
}) {
  const err = (name: string): string | undefined => fieldError(submit, `${prefix}${name}`);
  const set = (name: keyof WirelessApForm, patch: Partial<WirelessApForm>): void => {
    submit.clearField(`${prefix}${name}`);
    onChange({ ...form, ...patch }, `${prefix}${name}`);
  };
  const bands = wifiBandsFor(spec);
  const channelList = (RADIO_BANDS as readonly string[]).includes(form.band) ? CHANNELS[form.band as Exclude<RfBand, 'cell'>] : [];
  const channelValues = channelList.map(String);
  const widths = widthsFor(form.band, spec);
  const maxPower = spec?.maxTxPowerDbm ?? DEFAULT_MAX_TX_POWER_DBM;
  const status = radioStatus(port);
  const secured = form.security !== 'open';

  return (
    <fieldset className="insp-section" disabled={disabled} style={{ border: 'none', margin: 0, padding: 0, minWidth: 0 }}>
      <legend className="panel-title">
        {form.port}{' '}
        <span className="dim">
          <span aria-hidden="true">{status.glyph} </span>
          {status.text}
          {port?.radio?.clients !== undefined && ` · ${port.radio.clients} connected`}
        </span>
      </legend>
      <dl className="kv">
        <SettingsField label="Radio" error={err('enabled')}>
          {({ id, describedBy, invalid }) => (
            <label htmlFor={id} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input
                id={id}
                type="checkbox"
                checked={form.enabled}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(e) => set('enabled', { enabled: e.target.checked })}
              />
              {form.enabled ? 'On' : 'Off'}
            </label>
          )}
        </SettingsField>
        <SettingsField label="Network name (SSID)" error={err('ssid')} hint={form.ssid === '' ? 'Leave empty to keep the radio quiet.' : undefined}>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              className="input"
              value={form.ssid}
              maxLength={SSID_MAX}
              spellCheck={false}
              autoComplete="off"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              onChange={(e) => set('ssid', { ssid: e.target.value })}
            />
          )}
        </SettingsField>
        <SettingsField label="Security" error={err('security')}>
          {({ id, describedBy, invalid }) => (
            <select
              id={id}
              className="select"
              value={form.security}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              onChange={(e) => set('security', { security: e.target.value as WifiSecurity })}
            >
              {WIFI_SECURITY_MODES.map((m) => (
                <option key={m} value={m}>
                  {WIFI_SECURITY_LABELS[m]}
                </option>
              ))}
            </select>
          )}
        </SettingsField>
        {secured && (
          <SettingsField
            label="Password"
            error={err('passphrase')}
            hint={form.hasPassphrase ? 'A password is saved. Leave this empty to keep it.' : 'Between 8 and 63 characters.'}
          >
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className="input"
                type="password"
                value={form.passphrase}
                maxLength={PASSPHRASE_MAX}
                autoComplete="new-password"
                placeholder={form.hasPassphrase ? '(unchanged)' : ''}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(e) => set('passphrase', { passphrase: e.target.value })}
              />
            )}
          </SettingsField>
        )}
        <SettingsField label="Band" error={err('band')}>
          {({ id, describedBy, invalid }) => (
            <select
              id={id}
              className="select"
              value={form.band}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              onChange={(e) => {
                submit.clearField(`${prefix}band`);
                submit.clearField(`${prefix}channel`);
                submit.clearField(`${prefix}widthMhz`);
                onChange(withBand(form, e.target.value, spec), `${prefix}band`);
              }}
            >
              {!(bands as readonly string[]).includes(form.band) && <option value={form.band}>{form.band === '' ? 'Choose a band' : form.band}</option>}
              {bands.map((b) => (
                <option key={b} value={b}>
                  {BAND_LABELS[b]}
                </option>
              ))}
            </select>
          )}
        </SettingsField>
        <SettingsField
          label="Channel"
          error={err('channel')}
          hint={form.channel === 'auto' && port?.radio !== undefined ? `Currently using channel ${port.radio.channel}.` : undefined}
        >
          {({ id, describedBy, invalid }) => (
            <select
              id={id}
              className="select"
              value={form.channel}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              onChange={(e) => set('channel', { channel: e.target.value })}
            >
              <option value="auto">Automatic (quietest channel)</option>
              {form.channel !== 'auto' && !channelValues.includes(form.channel) && <option value={form.channel}>{form.channel === '' ? 'Choose a channel' : form.channel}</option>}
              {channelValues.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
        </SettingsField>
        {form.band !== '60' && (
          <SettingsField label="Channel width" error={err('widthMhz')}>
            {({ id, describedBy, invalid }) => (
              <select
                id={id}
                className="select"
                value={form.widthMhz}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(e) => set('widthMhz', { widthMhz: e.target.value })}
              >
                {!widths.map(String).includes(form.widthMhz) && <option value={form.widthMhz}>{form.widthMhz === '' ? 'Choose a width' : `${form.widthMhz} MHz`}</option>}
                {widths.map((w) => (
                  <option key={w} value={String(w)}>
                    {w} MHz
                  </option>
                ))}
              </select>
            )}
          </SettingsField>
        )}
        <SettingsField label="Transmit power (dBm)" error={err('txPowerDbm')} hint={`0 to ${maxPower} dBm.`}>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              className="input"
              type="number"
              inputMode="numeric"
              min={0}
              max={maxPower}
              step={1}
              value={form.txPowerDbm}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              onChange={(e) => set('txPowerDbm', { txPowerDbm: e.target.value })}
            />
          )}
        </SettingsField>
      </dl>
    </fieldset>
  );
}

/** A secret the form holds is sent once: after Apply the input is cleared and the saved flag set (or cleared for open). */
export function clearedRadioSecrets(form: WirelessApForm): WirelessApForm {
  const hasPassphrase = form.security === 'open' ? false : form.hasPassphrase || form.passphrase !== '';
  return { ...form, passphrase: '', hasPassphrase };
}

// ── wireless panel ───────────────────────────────────────────────────────────

/** Access radios of a device: `wlan` ports whose effective role is `wireless-bss`, in port order. */
export function accessRadioPorts(device: Pick<DeviceSnapshot, 'ports'>): readonly PortSnapshot[] {
  return device.ports.filter((p) => p.kind === 'wlan' && p.role === 'wireless-bss');
}

/** Validation of every access radio of the panel (field keys `radios.<i>.*`). */
export function validateWirelessPanel(
  draft: readonly WirelessApForm[],
  baseline: readonly WirelessApForm[],
  specs: Readonly<Record<PortId, RadioPortSpec>>,
): FormErrors {
  const errors: FormErrors = {};
  draft.forEach((radio, i) => {
    const before = baseline.find((r) => r.port === radio.port);
    Object.assign(errors, validateWirelessApForm(radio, before, specs[radio.port], `radios.${i}.`));
  });
  return errors;
}

/** One `configure` plan for every access radio that changed. */
export function wirelessPanelPlan(draft: readonly WirelessApForm[], baseline: readonly WirelessApForm[]): CommandPlan {
  return mergePlans(
    'nfos',
    draft.map((radio, i) => wirelessApCommands(radio, baseline.find((r) => r.port === radio.port), `radios.${i}.`)),
  );
}

/** Validate, build and send the access point settings. */
export function applyWirelessSettings(
  api: ConfigureApi,
  device: DeviceId,
  draft: readonly WirelessApForm[],
  baseline: readonly WirelessApForm[],
  specs: Readonly<Record<PortId, RadioPortSpec>>,
): Promise<PanelSubmitResult> {
  return runPanelSubmit(api, device, validateWirelessPanel(draft, baseline, specs), () => wirelessPanelPlan(draft, baseline));
}

/** Access point settings panel (`wireless.ap`). */
export function WirelessPanel({ device }: { device: DeviceSnapshot }) {
  const ports = accessRadioPorts(device);
  const portIds = ports.map((p) => p.id);
  const specs = useRadioSpecs(device.type, portIds);
  const current = ports.map((p) => wirelessApFormFrom(device, p.id));
  const resetKey = `${device.id}|${portIds.join(',')}`;
  const form = useSettingsForm<WirelessApForm[]>(current, resetKey);
  const submit = useSubmitState(resetKey);
  const associations = useServedAssociations(device.id, portIds);
  const notReady = deviceNotReadyReason(device);

  if (ports.length === 0) {
    return <div className="empty-hint">This device has no access point radio to set up.</div>;
  }

  const apply = (): void => {
    const { draft, baseline } = form;
    void submit.run(() => applyWirelessSettings(engine, device.id, draft, baseline, specs)).then((result) => {
      if (result?.outcome?.ok === true) form.markApplied(draft.map(clearedRadioSecrets));
    });
  };

  return (
    <div className="insp-body" aria-label={`Wireless settings of ${device.name}`}>
      <section className="insp-section">
        <div className="insp-note">
          Changes are checked by the device exactly as if they were typed at its console. If any line is refused, none of
          the changes are kept.
        </div>
      </section>
      {form.draft.map((radio, i) => {
        const port = ports.find((p) => p.id === radio.port);
        const served = associations.filter((a) => a.ap?.port === radio.port);
        return (
          <Fragment key={radio.port}>
            <RadioFields
              form={radio}
              spec={specs[radio.port]}
              port={port}
              prefix={`radios.${i}.`}
              submit={submit}
              disabled={submit.busy}
              onChange={(next) => form.update((d) => d.map((r, j) => (j === i ? next : r)))}
            />
            <section className="insp-section">
              <div className="panel-title">Connected on {radio.port}</div>
              <ClientTable associations={served} empty="No wireless clients are connected to this radio." />
            </section>
          </Fragment>
        );
      })}
      <SubmitBar submit={submit} form={form} canApply={notReady === undefined} disabledReason={notReady} onApply={apply} />
    </div>
  );
}
