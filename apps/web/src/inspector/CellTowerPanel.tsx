/**
 * Mobile network tower settings panel (GUI panel `cell.tower`; ARCHITECTURE-P1 D3, D5, D9, §3.8, §3.12, §7).
 *
 * A tower has one access radio (`cellular` port, role `wireless-bss`) and a wired backhaul port it bridges to. The
 * panel switches the radio and the backhaul on or off through `EngineApi.configure` (gui/commands.ts
 * `cellTowerCommands` and `portAdminCommands`), with per-line errors next to the switch that produced them.
 *
 * The tower's transmit power, band and channel are fixed by its hardware in this release (the device grammar offers
 * no `tx-power` on cellular radios), so the panel shows them with the coverage radius instead of offering inputs.
 * It also lists the phones attached to each radio (state, signal bars with dBm, rate and distance) and the backhaul
 * state. All wording is original (§1.6); state is never shown by colour alone.
 */
import { Fragment, useId } from 'react';
import type { DeviceId, DeviceSnapshot, PortId, PortSnapshot } from '@netforge/engine';
import { engine } from '../bridge/client';
import { cellTowerCommands, mergePlans, portAdminCommands } from '../gui/commands';
import type { CommandPlan } from '../gui/commands';
import { cellTowerFormFrom } from '../gui/forms';
import type { CellTowerForm, FormErrors } from '../gui/forms';
import {
  ClientTable,
  SettingsField,
  SubmitBar,
  deviceNotReadyReason,
  fieldError,
  rateText,
  runPanelSubmit,
  useRadioSpecs,
  useServedAssociations,
  useSettingsForm,
  useSubmitState,
} from './WirelessPanel';
import type { ConfigureApi, PanelSubmitResult } from './WirelessPanel';

// ── model ────────────────────────────────────────────────────────────────────

/** One backhaul port and whether it is switched on. */
export interface BackhaulForm {
  port: PortId;
  enabled: boolean;
}

/** The tower panel form: every tower radio plus every backhaul port. */
export interface CellTowerPanelForm {
  radios: CellTowerForm[];
  backhaul: BackhaulForm[];
}

/** Tower radios of a device: `cellular` ports whose effective role is `wireless-bss`, in port order. */
export function towerRadioPorts(device: Pick<DeviceSnapshot, 'ports'>): readonly PortSnapshot[] {
  return device.ports.filter((p) => p.kind === 'cellular' && p.role === 'wireless-bss');
}

/** Backhaul ports of a tower: configurable cable ports (everything that is neither a radio nor virtual). */
export function backhaulPorts(device: Pick<DeviceSnapshot, 'ports'>): readonly PortSnapshot[] {
  return device.ports.filter(
    (p) => p.kind !== 'cellular' && p.kind !== 'wlan' && p.kind !== 'radio' && p.virtual !== true && p.configurable !== false && p.linkable !== false,
  );
}

/** Panel form of a tower. */
export function cellTowerPanelFormFrom(device: DeviceSnapshot): CellTowerPanelForm {
  return {
    radios: towerRadioPorts(device).map((p) => cellTowerFormFrom(device, p.id)),
    backhaul: backhaulPorts(device).map((p) => ({ port: p.id, enabled: p.adminUp })),
  };
}

/**
 * Validation of the tower form (field keys `radios.<i>.*`, `backhaul.<i>.*`): every port must still exist on the
 * device the baseline was read from. Transmit power is fixed on towers in this release and never sent, so it is not
 * checked.
 */
export function validateCellTowerPanel(draft: CellTowerPanelForm, baseline: CellTowerPanelForm): FormErrors {
  const errors: FormErrors = {};
  draft.radios.forEach((radio, i) => {
    if (!baseline.radios.some((r) => r.port === radio.port)) errors[`radios.${i}.enabled`] = `The radio ${radio.port} is no longer on this tower. Revert to reload the settings.`;
  });
  draft.backhaul.forEach((b, i) => {
    if (!baseline.backhaul.some((x) => x.port === b.port)) errors[`backhaul.${i}.enabled`] = `The port ${b.port} is no longer on this tower. Revert to reload the settings.`;
  });
  return errors;
}

/**
 * Prefix every field of a plan built with unprefixed keys (`enabled`) so errors land on the right section
 * (`radios.0.enabled`, `backhaul.1.enabled`).
 */
export function prefixPlanFields(plan: CommandPlan, prefix: string): CommandPlan {
  return Object.freeze({
    ...plan,
    lines: Object.freeze(
      plan.lines.map((l) =>
        Object.freeze({ ...l, spans: Object.freeze(l.spans.map((s) => Object.freeze({ ...s, field: s.field === null ? null : `${prefix}${s.field}` }))) }),
      ),
    ),
  });
}

/**
 * One `configure` plan for the tower. Radios are switched off before the backhaul changes and on after it, so a tower
 * never serves phones through a backhaul that is being turned off.
 */
export function cellTowerPanelPlan(draft: CellTowerPanelForm, baseline: CellTowerPanelForm): CommandPlan {
  const radioPlan = (i: number): CommandPlan => {
    const radio = draft.radios[i] as CellTowerForm;
    const before = baseline.radios.find((r) => r.port === radio.port);
    // Transmit power is fixed on towers in this release: the baseline value is kept so no tx-power line is sent.
    const next = before === undefined ? { ...radio, txPowerDbm: '' } : { ...radio, txPowerDbm: before.txPowerDbm };
    return prefixPlanFields(cellTowerCommands(next, before), `radios.${i}.`);
  };
  const turningOff: CommandPlan[] = [];
  const turningOn: CommandPlan[] = [];
  draft.radios.forEach((radio, i) => {
    (radio.enabled ? turningOn : turningOff).push(radioPlan(i));
  });
  const backhaul: CommandPlan[] = [];
  draft.backhaul.forEach((b, i) => {
    const before = baseline.backhaul.find((x) => x.port === b.port);
    if (before !== undefined && before.enabled === b.enabled) return;
    backhaul.push(prefixPlanFields(portAdminCommands('nfos', b.port, b.enabled), `backhaul.${i}.`));
  });
  return mergePlans('nfos', [...turningOff, ...backhaul, ...turningOn]);
}

/** Validate, build and send the tower settings. */
export function applyCellTowerSettings(
  api: ConfigureApi,
  device: DeviceId,
  draft: CellTowerPanelForm,
  baseline: CellTowerPanelForm,
): Promise<PanelSubmitResult> {
  return runPanelSubmit(api, device, validateCellTowerPanel(draft, baseline), () => cellTowerPanelPlan(draft, baseline));
}

// ── components ───────────────────────────────────────────────────────────────

function OnOffField({ label, field, checked, submit, hint, onChange }: {
  label: string;
  field: string;
  checked: boolean;
  submit: Parameters<typeof fieldError>[0];
  hint?: string;
  onChange(on: boolean): void;
}) {
  return (
    <SettingsField label={label} error={fieldError(submit, field)} hint={hint}>
      {({ id, describedBy, invalid }) => (
        <label htmlFor={id} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input id={id} type="checkbox" checked={checked} aria-describedby={describedBy} aria-invalid={invalid} onChange={(e) => onChange(e.target.checked)} />
          {checked ? 'On' : 'Off'}
        </label>
      )}
    </SettingsField>
  );
}

function radioLine(port: PortSnapshot | undefined, power: boolean): { glyph: string; text: string } {
  if (port === undefined) return { glyph: '○', text: 'not present' };
  if (!power) return { glyph: '○', text: 'tower off' };
  if (!port.adminUp) return { glyph: '■', text: 'turned off' };
  if (port.radio?.up === true) return { glyph: '●', text: 'serving phones' };
  return { glyph: '▲', text: 'not serving yet' };
}

function backhaulText(port: PortSnapshot | undefined, power: boolean): string {
  if (port === undefined) return 'not present';
  if (!power) return 'tower off';
  if (!port.adminUp) return 'turned off';
  if (port.operUp) return port.speedBps !== undefined ? `up at ${rateText(port.speedBps)}` : 'up';
  return port.link === undefined ? 'down, no cable' : 'down';
}

/** Mobile network tower settings panel (`cell.tower`). */
export function CellTowerPanel({ device }: { device: DeviceSnapshot }) {
  const current = cellTowerPanelFormFrom(device);
  const radioIds = current.radios.map((r) => r.port);
  const specs = useRadioSpecs(device.type, radioIds);
  const resetKey = `${device.id}|${radioIds.join(',')}|${current.backhaul.map((b) => b.port).join(',')}`;
  const form = useSettingsForm<CellTowerPanelForm>(current, resetKey);
  const submit = useSubmitState(resetKey);
  const associations = useServedAssociations(device.id, radioIds);
  const backhaulId = useId();
  const notReady = deviceNotReadyReason(device);
  const { draft } = form;

  if (draft.radios.length === 0) {
    return <div className="empty-hint">This device has no mobile network radio to set up.</div>;
  }

  const apply = (): void => {
    const { draft: next, baseline } = form;
    void submit.run(() => applyCellTowerSettings(engine, device.id, next, baseline)).then((result) => {
      if (result?.outcome?.ok === true) form.markApplied(next);
    });
  };

  return (
    <div className="insp-body" aria-label={`Tower settings of ${device.name}`}>
      <section className="insp-section">
        <div className="insp-note">
          Phones and tablets in range attach to this tower automatically and reach the wired network behind its backhaul
          port. Changes are checked by the tower as if typed at a console.
        </div>
      </section>

      {draft.radios.map((radio, i) => {
        const port = device.ports.find((p) => p.id === radio.port);
        const spec = specs[radio.port];
        const view = port?.radio;
        const status = radioLine(port, device.power);
        const served = associations.filter((a) => a.ap?.port === radio.port);
        return (
          <Fragment key={radio.port}>
            <fieldset className="insp-section" disabled={submit.busy} style={{ border: 'none', margin: 0, padding: 0, minWidth: 0 }}>
              <legend className="panel-title">
                {radio.port}{' '}
                <span className="dim">
                  <span aria-hidden="true">{status.glyph} </span>
                  {status.text}
                </span>
              </legend>
              <dl className="kv">
                <OnOffField
                  label="Radio"
                  field={`radios.${i}.enabled`}
                  checked={radio.enabled}
                  submit={submit}
                  hint={radio.enabled ? undefined : 'Attached phones lose service when the radio is turned off.'}
                  onChange={(on) => {
                    submit.clearField(`radios.${i}.enabled`);
                    form.update((d) => ({ ...d, radios: d.radios.map((r, j) => (j === i ? { ...r, enabled: on } : r)) }));
                  }}
                />
                <dt>Transmit power</dt>
                <dd>
                  {view !== undefined ? `${view.txPowerDbm} dBm` : radio.txPowerDbm !== '' ? `${radio.txPowerDbm} dBm` : '—'}{' '}
                  <span className="dim">(fixed by the tower hardware in this release)</span>
                  {fieldError(submit, `radios.${i}.txPowerDbm`) !== undefined && (
                    <div role="alert" className="reason-box" style={{ borderLeftColor: 'var(--err)' }}>
                      <span aria-hidden="true">✖ </span>
                      {fieldError(submit, `radios.${i}.txPowerDbm`)}
                    </div>
                  )}
                </dd>
                <dt>Network</dt>
                <dd>
                  Mobile data (LTE){view !== undefined ? `, channel ${view.channel}, ${view.widthMhz} MHz` : ''}
                </dd>
                <dt>Coverage</dt>
                <dd>{view !== undefined ? `about ${Math.round(view.rangeM)} m around the tower` : '—'}</dd>
                <dt>Phones</dt>
                <dd>
                  {view?.clients ?? served.filter((a) => a.state === 'attached').length}
                  {spec?.maxClients !== undefined ? ` of at most ${spec.maxClients}` : ''} attached
                </dd>
              </dl>
            </fieldset>
            <section className="insp-section">
              <div className="panel-title">Phones on {radio.port}</div>
              <ClientTable associations={served} empty="No phone or tablet is attached to this radio." />
            </section>
          </Fragment>
        );
      })}

      {draft.backhaul.length > 0 && (
        <fieldset className="insp-section" disabled={submit.busy} aria-describedby={backhaulId} style={{ border: 'none', margin: 0, padding: 0, minWidth: 0 }}>
          <legend className="panel-title">Backhaul</legend>
          <div id={backhaulId} className="insp-note">
            The wired link that carries phone traffic to the rest of the network.
          </div>
          <dl className="kv">
            {draft.backhaul.map((b, i) => {
              const port = device.ports.find((p) => p.id === b.port);
              return (
                <OnOffField
                  key={b.port}
                  label={`${b.port} (${backhaulText(port, device.power)})`}
                  field={`backhaul.${i}.enabled`}
                  checked={b.enabled}
                  submit={submit}
                  onChange={(on) => {
                    submit.clearField(`backhaul.${i}.enabled`);
                    form.update((d) => ({ ...d, backhaul: d.backhaul.map((x, j) => (j === i ? { ...x, enabled: on } : x)) }));
                  }}
                />
              );
            })}
          </dl>
        </fieldset>
      )}

      <SubmitBar submit={submit} form={form} canApply={notReady === undefined} disabledReason={notReady} onApply={apply} />
    </div>
  );
}
