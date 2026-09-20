/**
 * Point-to-point radio settings panel (GUI panel `radio.link`; ARCHITECTURE-P1 D5, D9, §3.7, §3.12, §6, §7).
 *
 * Each `radio` port with role `radio-ptp` gets its own section: radio on/off, band, a fixed channel (both ends of a
 * link must share it, so there is no automatic choice), transmit power and the pairing key, all sent as canonical
 * `interface RadioN` lines through `EngineApi.configure` (gui/commands.ts `radioLinkCommands`), with per-line errors
 * shown next to the input that produced them.
 *
 * The distance override is a property of the radio link, not a configuration line (topology `links[].distance_m`,
 * `LinkSpec.distanceOverrideM`). The bridge offers no setter for it, so the panel lays the same link again: it removes
 * the link and adds it back with the same id, ends, media, length, impairments and the new override (restoring the
 * original link when the new one is refused). This happens only after the radio lines were accepted.
 *
 * The section also shows the live link: the far end, distance and where it comes from, signal bars with dBm, SNR and
 * rate, or the reason the link is down in plain words. All wording is original (§1.6); nothing relies on colour.
 */
import { useId } from 'react';
import { CHANNELS, MAX_DISTANCE_M } from '@netforge/engine';
import type { AddLinkSpec, DeviceId, DeviceSnapshot, LinkSnapshot, PortSnapshot, RadioPortSpec, RfBand } from '@netforge/engine';
import { engine } from '../bridge/client';
import type { EngineApi } from '../bridge/protocol';
import { useStore } from '../store/store';
import { radioLinkCommands } from '../gui/commands';
import type { CommandPlan } from '../gui/commands';
import {
  BAND_LABELS,
  DEFAULT_MAX_TX_POWER_DBM,
  PEER_KEY_MAX,
  RADIO_BANDS,
  hasErrors,
  radioLinkFormFrom,
  validateRadioLinkForm,
} from '../gui/forms';
import type { FormErrors, RadioLinkForm, SubmitOutcome } from '../gui/forms';
import { linkDownText } from '../vocab/media';
import {
  SettingsField,
  SignalBars,
  SubmitBar,
  deviceNotReadyReason,
  fieldError,
  rateText,
  submitPlan,
  useDeviceNames,
  useRadioSpecs,
  useSettingsForm,
  useSubmitState,
  withBand,
} from './WirelessPanel';
import type { ConfigureApi, PanelSubmitResult } from './WirelessPanel';

// ── model ────────────────────────────────────────────────────────────────────

/** Shortest pairing key the device accepts (characters). */
export const PEER_KEY_MIN = 4;

/** The radio form plus the link's distance override (metres as typed; empty = measured on the canvas). */
export interface RadioLinkPanelForm extends RadioLinkForm {
  distanceM: string;
}

/** What the panel needs from the engine: configure plus the two link calls used to lay the link again. */
export type RadioLinkApi = ConfigureApi & Pick<EngineApi, 'addLink' | 'removeLink'>;

/** Point-to-point radios of a device: `radio` ports whose effective role is `radio-ptp`, in port order. */
export function ptpRadioPorts(device: Pick<DeviceSnapshot, 'ports'>): readonly PortSnapshot[] {
  return device.ports.filter((p) => p.kind === 'radio' && p.role === 'radio-ptp');
}

/** Text form of a distance override (whole metres print without decimals). */
export function distanceText(metres: number | undefined): string {
  if (metres === undefined || !Number.isFinite(metres)) return '';
  return String(Math.round(metres * 1000) / 1000);
}

/** Panel form of one radio port; `link` is the port's radio link when it has one. */
export function radioLinkPanelFormFrom(device: DeviceSnapshot, port: string, link: LinkSnapshot | undefined): RadioLinkPanelForm {
  return { ...radioLinkFormFrom(device, port), distanceM: distanceText(link?.distanceOverrideM) };
}

/** Override in metres for a typed distance: undefined = no override, NaN = not a valid distance. */
export function parseDistance(text: string): number | undefined {
  const t = text.trim();
  if (t === '') return undefined;
  if (!/^\d+(\.\d{1,3})?$/.test(t)) return Number.NaN;
  return Number(t);
}

/** Error for a typed distance override, undefined when valid (empty is valid). */
export function checkDistance(text: string): string | undefined {
  const v = parseDistance(text);
  if (v === undefined) return undefined;
  if (Number.isNaN(v)) return 'Enter the distance in metres as a plain number, for example 2500, or leave it empty.';
  if (v > MAX_DISTANCE_M) return `The distance can be at most ${MAX_DISTANCE_M} m.`;
  return undefined;
}

function sameDistance(a: string, b: string): boolean {
  const x = parseDistance(a);
  const y = parseDistance(b);
  return x === y || (x !== undefined && y !== undefined && Number.isNaN(x) && Number.isNaN(y));
}

/** The radio part of the panel form (what `radioLinkCommands` reads). */
export function radioPart(form: RadioLinkPanelForm): RadioLinkForm {
  const { distanceM: _distance, ...rest } = form;
  return rest;
}

/** Validation of one radio section (field keys match gui/commands.ts: band, channel, txPowerDbm, peerKey, distanceM). */
export function validateRadioLinkPanel(
  draft: RadioLinkPanelForm,
  baseline: RadioLinkPanelForm,
  spec: RadioPortSpec | undefined,
  link: LinkSnapshot | undefined,
): FormErrors {
  const errors = validateRadioLinkForm(radioPart(draft), spec);
  const key = draft.peerKey;
  if (errors.peerKey === undefined && key !== '' && key.length < PEER_KEY_MIN) {
    errors.peerKey = `A pairing key needs at least ${PEER_KEY_MIN} characters.`;
  }
  const distanceError = checkDistance(draft.distanceM);
  if (distanceError !== undefined) errors.distanceM = distanceError;
  else if (link === undefined && !sameDistance(draft.distanceM, baseline.distanceM)) {
    errors.distanceM = 'Connect this radio to another radio first; the distance belongs to that link.';
  }
  return errors;
}

/** Lines of one radio section against its baseline. */
export function radioLinkPanelPlan(draft: RadioLinkPanelForm, baseline: RadioLinkPanelForm): CommandPlan {
  return radioLinkCommands(radioPart(draft), radioPart(baseline));
}

/** The AddLinkSpec that lays `link` again, with `distanceOverrideM` replaced (undefined removes the override). */
export function relaidLinkSpec(link: LinkSnapshot, distanceOverrideM: number | undefined): AddLinkSpec {
  const spec: AddLinkSpec = {
    id: link.id,
    a: { device: link.a.device, port: link.a.port },
    b: { device: link.b.device, port: link.b.port },
    media: link.media,
    lengthM: link.lengthM,
    impairments: { ...link.impairments },
    kind: link.kind ?? 'radio',
  };
  if (link.dceEnd !== undefined) spec.dceEnd = link.dceEnd;
  if (distanceOverrideM !== undefined) spec.distanceOverrideM = distanceOverrideM;
  return spec;
}

/** Message when the link could not be laid again with the new distance. */
export const MSG_DISTANCE_FAILED = 'The new distance could not be applied to the radio link.';
/** Extra message when even the original link could not be restored. */
export const MSG_LINK_LOST = 'The radio link could not be restored either; connect the two radios again.';

function errorDetail(err: unknown): string {
  return err instanceof Error && err.message !== '' ? ` ${err.message}` : '';
}

/**
 * Lay `link` again with a new distance override. Resolves with undefined on success, else with the message to show
 * (the original link is put back when possible).
 */
export async function relayRadioLink(api: Pick<EngineApi, 'addLink' | 'removeLink'>, link: LinkSnapshot, distanceOverrideM: number | undefined): Promise<string | undefined> {
  try {
    await api.removeLink(link.id);
  } catch (err) {
    return `${MSG_DISTANCE_FAILED}${errorDetail(err)}`;
  }
  try {
    await api.addLink(relaidLinkSpec(link, distanceOverrideM));
    return undefined;
  } catch (err) {
    const message = `${MSG_DISTANCE_FAILED}${errorDetail(err)}`;
    try {
      await api.addLink(relaidLinkSpec(link, link.distanceOverrideM));
      return message;
    } catch {
      return `${message} ${MSG_LINK_LOST}`;
    }
  }
}

function outcomeOf(base: SubmitOutcome | null, fieldErrors: FormErrors, general: readonly string[]): SubmitOutcome {
  return Object.freeze({
    ok: false,
    reverted: false,
    fieldErrors: { ...(base?.fieldErrors ?? {}), ...fieldErrors },
    general: Object.freeze([...(base?.general ?? []), ...general]),
    skipped: base?.skipped ?? 0,
  });
}

/**
 * Validate, send the radio lines, then (only when they were accepted) lay the link again when the distance changed.
 * `sent` lists the configure lines (empty when only the distance changed); null when nothing was done.
 */
export async function applyRadioLinkSettings(
  api: RadioLinkApi,
  device: DeviceId,
  draft: RadioLinkPanelForm,
  baseline: RadioLinkPanelForm,
  spec: RadioPortSpec | undefined,
  link: LinkSnapshot | undefined,
): Promise<PanelSubmitResult> {
  const clientErrors = validateRadioLinkPanel(draft, baseline, spec, link);
  if (hasErrors(clientErrors)) return Object.freeze({ sent: null, clientErrors, outcome: null });
  const plan = radioLinkPanelPlan(draft, baseline);
  const distanceChanged = link !== undefined && !sameDistance(draft.distanceM, baseline.distanceM);
  if (plan.commands.length === 0 && !distanceChanged) return Object.freeze({ sent: null, clientErrors, outcome: null });

  let outcome: SubmitOutcome | null = null;
  if (plan.commands.length > 0) {
    outcome = await submitPlan(api, device, plan);
    if (outcome !== null && !outcome.ok) return Object.freeze({ sent: plan.commands, clientErrors, outcome });
  }
  if (distanceChanged && link !== undefined) {
    const problem = await relayRadioLink(api, link, parseDistance(draft.distanceM));
    if (problem !== undefined) {
      const note = plan.commands.length > 0 ? ['The radio settings were kept; only the distance is unchanged.'] : [];
      outcome = outcomeOf(outcome, { distanceM: problem }, note);
    } else if (outcome === null) {
      outcome = Object.freeze({ ok: true, reverted: false, fieldErrors: {}, general: Object.freeze([]), skipped: 0 });
    }
  }
  return Object.freeze({ sent: plan.commands, clientErrors, outcome });
}

/** The form as it stands after a successful Apply (the typed key is sent once, then only its presence is kept). */
export function appliedRadioLinkForm(draft: RadioLinkPanelForm): RadioLinkPanelForm {
  const distance = parseDistance(draft.distanceM);
  return { ...draft, peerKey: '', hasPeerKey: draft.hasPeerKey || draft.peerKey !== '', distanceM: distanceText(distance) };
}

// ── hooks ────────────────────────────────────────────────────────────────────

/** Hook: the link snapshot with `id`, through the snapshot index. */
export function useLinkSnapshot(id: string | undefined): LinkSnapshot | undefined {
  return useStore((s) => {
    if (id === undefined || s.snapshot === null) return undefined;
    const at = s.snapshotIndex?.links[id];
    const hit = at !== undefined ? s.snapshot.links[at] : undefined;
    if (hit !== undefined && hit.id === id) return hit;
    return s.snapshot.links.find((l) => l.id === id);
  });
}

// ── components ───────────────────────────────────────────────────────────────

/** Bands a point-to-point radio offers: the spec's non-cellular bands, else every radio band. */
export function ptpBandsFor(spec: RadioPortSpec | undefined): readonly Exclude<RfBand, 'cell'>[] {
  if (spec === undefined) return RADIO_BANDS;
  const bands = RADIO_BANDS.filter((b) => spec.bands.includes(b));
  return bands.length > 0 ? bands : RADIO_BANDS;
}

function LinkStatus({ device, port, link }: { device: DeviceSnapshot; port: PortSnapshot; link: LinkSnapshot | undefined }) {
  const nameOf = useDeviceNames();
  if (link === undefined) {
    return (
      <div className="insp-note" role="status">
        <span aria-hidden="true">○ </span>
        Not linked. Use the connect tool to join this radio to another radio bridge.
      </div>
    );
  }
  const far = link.a.device === device.id && link.a.port === port.id ? link.b : link.a;
  const side = link.a.device === device.id && link.a.port === port.id ? 'a' : 'b';
  const radio = link.radio;
  const down = link.up
    ? undefined
    : linkDownText(link.downReason, {
        deviceA: side === 'a' ? device.name : nameOf(far.device),
        deviceB: side === 'b' ? device.name : nameOf(far.device),
        endA: side === 'a' ? `${port.id} on ${device.name}` : `${far.port} on ${nameOf(far.device)}`,
        endB: side === 'b' ? `${port.id} on ${device.name}` : `${far.port} on ${nameOf(far.device)}`,
      });
  return (
    <dl className="kv" aria-live="polite">
      <dt>Link</dt>
      <dd>
        {link.up ? (
          <>
            <span aria-hidden="true">● </span>up
          </>
        ) : (
          <>
            <span aria-hidden="true">▲ </span>down: {down?.short}
          </>
        )}
      </dd>
      <dt>Other end</dt>
      <dd>
        {nameOf(far.device)} <span className="dim mono">{far.port}</span>
      </dd>
      {radio !== undefined && (
        <>
          <dt>Distance</dt>
          <dd>
            {`${Math.round(radio.distanceM)} m`}{' '}
            <span className="dim">{radio.distanceSource === 'override' ? '(entered below)' : '(measured on the canvas)'}</span>
          </dd>
          <dt>Signal</dt>
          <dd>
            <SignalBars bars={radio.bars} rssiDbm={radio.rssiDbm} />
            <span className="dim">{` · SNR ${radio.snrDb} dB`}</span>
          </dd>
          <dt>Rate</dt>
          <dd>{link.up ? rateText(radio.rateBps) : '—'}</dd>
        </>
      )}
      {down !== undefined && (
        <>
          <dt>Why</dt>
          <dd>
            <div className="reason-box">{down.explain}</div>
          </dd>
        </>
      )}
    </dl>
  );
}

function RadioLinkSection({ device, port, spec, notReady }: { device: DeviceSnapshot; port: PortSnapshot; spec: RadioPortSpec | undefined; notReady: string | undefined }) {
  const link = useLinkSnapshot(port.link);
  const current = radioLinkPanelFormFrom(device, port.id, link);
  const resetKey = `${device.id}|${port.id}|${link?.id ?? ''}`;
  const form = useSettingsForm<RadioLinkPanelForm>(current, resetKey);
  const submit = useSubmitState(resetKey);
  const headingId = useId();
  const { draft } = form;

  const err = (name: string): string | undefined => fieldError(submit, name);
  const set = (name: keyof RadioLinkPanelForm, patch: Partial<RadioLinkPanelForm>): void => {
    submit.clearField(name);
    form.update((d) => ({ ...d, ...patch }));
  };

  const bands = ptpBandsFor(spec);
  const channels = (RADIO_BANDS as readonly string[]).includes(draft.band) ? CHANNELS[draft.band as Exclude<RfBand, 'cell'>].map(String) : [];
  const maxPower = spec?.maxTxPowerDbm ?? DEFAULT_MAX_TX_POWER_DBM;
  const measured = link?.radio !== undefined && link.radio.distanceSource === 'canvas' ? `${Math.round(link.radio.distanceM)} m` : undefined;

  const apply = (): void => {
    const { draft: next, baseline } = form;
    void submit.run(() => applyRadioLinkSettings(engine, device.id, next, baseline, spec, link)).then((result) => {
      if (result?.outcome?.ok === true) form.markApplied(appliedRadioLinkForm(next));
    });
  };

  return (
    <section className="insp-section" aria-labelledby={headingId}>
      <div id={headingId} className="panel-title">
        {port.id}{' '}
        <span className="dim">
          {port.radio !== undefined ? `${BAND_LABELS[port.radio.band as Exclude<RfBand, 'cell'>] ?? port.radio.band}, channel ${port.radio.channel}` : 'point-to-point radio'}
        </span>
      </div>
      <LinkStatus device={device} port={port} link={link} />
      <fieldset disabled={submit.busy} aria-label={`Settings of ${port.id}`} style={{ border: 'none', margin: 0, padding: 0, minWidth: 0 }}>
        <dl className="kv">
          <SettingsField label="Radio" error={err('enabled')}>
            {({ id, describedBy, invalid }) => (
              <label htmlFor={id} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <input
                  id={id}
                  type="checkbox"
                  checked={draft.enabled}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  onChange={(e) => set('enabled', { enabled: e.target.checked })}
                />
                {draft.enabled ? 'On' : 'Off'}
              </label>
            )}
          </SettingsField>
          <SettingsField label="Band" error={err('band')} hint="Both radios of the link must use the same band.">
            {({ id, describedBy, invalid }) => (
              <select
                id={id}
                className="select"
                value={draft.band}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(e) => {
                  submit.clearField('band');
                  submit.clearField('channel');
                  const value = e.target.value;
                  form.update((d) => withBand(d, value, spec));
                }}
              >
                {!(bands as readonly string[]).includes(draft.band) && <option value={draft.band}>{draft.band === '' ? 'Choose a band' : draft.band}</option>}
                {bands.map((b) => (
                  <option key={b} value={b}>
                    {BAND_LABELS[b]}
                  </option>
                ))}
              </select>
            )}
          </SettingsField>
          <SettingsField label="Channel" error={err('channel')} hint="Both radios of the link must use the same fixed channel.">
            {({ id, describedBy, invalid }) => (
              <select
                id={id}
                className="select"
                value={draft.channel}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(e) => set('channel', { channel: e.target.value })}
              >
                {!channels.includes(draft.channel) && <option value={draft.channel}>{draft.channel === '' || draft.channel === 'auto' ? 'Choose a channel' : draft.channel}</option>}
                {channels.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
          </SettingsField>
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
                value={draft.txPowerDbm}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(e) => set('txPowerDbm', { txPowerDbm: e.target.value })}
              />
            )}
          </SettingsField>
          <SettingsField
            label="Pairing key"
            error={err('peerKey')}
            hint={
              draft.hasPeerKey
                ? 'A key is saved. Leave this empty to keep it; type a new one to replace it on this radio.'
                : `${PEER_KEY_MIN} to ${PEER_KEY_MAX} characters; the radio at the other end needs the same key.`
            }
          >
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className="input"
                type="password"
                value={draft.peerKey}
                maxLength={PEER_KEY_MAX}
                autoComplete="new-password"
                placeholder={draft.hasPeerKey ? '(unchanged)' : ''}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(e) => set('peerKey', { peerKey: e.target.value })}
              />
            )}
          </SettingsField>
          <SettingsField
            label="Distance (m)"
            error={err('distanceM')}
            hint={
              link === undefined
                ? 'Available once this radio is linked to another radio.'
                : `Leave empty to measure the distance on the canvas${measured !== undefined ? ` (now ${measured})` : ''}. A typed distance replaces it for this link.`
            }
          >
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className="input mono"
                inputMode="decimal"
                value={draft.distanceM}
                disabled={link === undefined}
                placeholder={measured ?? ''}
                spellCheck={false}
                autoComplete="off"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(e) => set('distanceM', { distanceM: e.target.value })}
              />
            )}
          </SettingsField>
        </dl>
      </fieldset>
      {link !== undefined && !sameDistance(draft.distanceM, form.baseline.distanceM) && (
        <div className="insp-note" role="note">
          <span aria-hidden="true">ⓘ </span>
          Changing the distance lays the radio link again, so traffic on it pauses briefly.
        </div>
      )}
      <SubmitBar submit={submit} form={form} canApply={notReady === undefined} disabledReason={notReady} onApply={apply} />
    </section>
  );
}

/** Point-to-point radio settings panel (`radio.link`). */
export function RadioLinkPanel({ device }: { device: DeviceSnapshot }) {
  const ports = ptpRadioPorts(device);
  const specs = useRadioSpecs(
    device.type,
    ports.map((p) => p.id),
  );
  const notReady = deviceNotReadyReason(device);

  if (ports.length === 0) {
    return <div className="empty-hint">This device has no point-to-point radio to set up.</div>;
  }

  return (
    <div className="insp-body" aria-label={`Radio link settings of ${device.name}`}>
      <section className="insp-section">
        <div className="insp-note">
          A radio link comes up when both radios are on, share the band, the channel and the pairing key, and are within
          range. Radio changes are checked by the device as if typed at its console; if one is refused, none are kept.
        </div>
      </section>
      {ports.map((port) => (
        <RadioLinkSection key={port.id} device={device} port={port} spec={specs[port.id]} notReady={notReady} />
      ))}
    </div>
  );
}
