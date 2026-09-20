/**
 * Home router setup panel (GUI panel `home-router.setup`; ARCHITECTURE-P1 D3, D9, §3.12, §6, §7).
 *
 * A home router has no console (shell `none`), so this panel is the only way to set it up. It covers:
 *  - the local network: the LAN interface address (`interface Vlan1` + `ip address`), plus the address pool the
 *    router's DHCP service will hand out. DHCP behaviour arrives in P1, so the pool is shown (derived from the LAN
 *    subnet) but nothing about it is sent yet, and the panel says so;
 *  - the internet side: a WAN mode (fixed address, not connected, or automatic, which also arrives in P1), the WAN
 *    address and the provider gateway (sent as the default route);
 *  - every Wi-Fi radio (the same fields as the access point panel).
 * Lines come from gui/commands.ts `homeRouterCommands` and go through `EngineApi.configure`; per-line errors land on
 * the field that produced them (`lan.*`, `wan.*`, `radios.<i>.*`). All wording is original (§1.6).
 */
import { Fragment, useId } from 'react';
import { maskToPrefixLen, parseIpv4, prefixLenToMaskU32 } from '@netforge/engine';
import type { DeviceId, DeviceSnapshot, PortId, PortSnapshot, RadioPortSpec } from '@netforge/engine';
import { engine } from '../bridge/client';
import { homeRouterCommands } from '../gui/commands';
import type { CommandPlan } from '../gui/commands';
import { homeRouterFormFrom, normalizeIpv4, normalizeMask, validateHomeRouterForm } from '../gui/forms';
import type { FormErrors, HomeRouterForm } from '../gui/forms';
import {
  ClientTable,
  RadioFields,
  SettingsField,
  SubmitBar,
  clearedRadioSecrets,
  deviceNotReadyReason,
  fieldError,
  runPanelSubmit,
  useRadioSpecs,
  useServedAssociations,
  useSettingsForm,
  useSubmitState,
} from './WirelessPanel';
import type { ConfigureApi, PanelSubmitResult, SubmitState } from './WirelessPanel';

// ── model ────────────────────────────────────────────────────────────────────

/** How the internet side gets its address. `dhcp` is listed but not selectable until P1. */
export type WanMode = 'static' | 'none' | 'dhcp';

/** WAN modes in display order with their labels. */
export const WAN_MODES: readonly { mode: WanMode; label: string; available: boolean }[] = Object.freeze([
  { mode: 'static', label: 'Fixed address from the provider', available: true },
  { mode: 'none', label: 'Not connected (no internet address)', available: true },
  { mode: 'dhcp', label: 'Automatic from the provider (DHCP)', available: false },
]);

/** Note shown next to DHCP settings until P1 brings the DHCP service. */
export const DHCP_LATER_NOTE =
  'Automatic addressing (DHCP) is not part of this release; it arrives with the next stage. The router stores nothing ' +
  'from these fields yet. Until then, give each computer a fixed address inside the local network.';

/** The panel form: the router form plus the chosen WAN mode. */
export interface HomeRouterPanelForm extends HomeRouterForm {
  wanMode: WanMode;
}

/** Panel form of a device: the WAN mode is `static` when an internet address is configured. */
export function homeRouterPanelFormFrom(device: DeviceSnapshot): HomeRouterPanelForm {
  const form = homeRouterFormFrom(device);
  return { ...form, wanMode: form.wan.address.trim() !== '' ? 'static' : 'none' };
}

/** The router form that is actually sent: `none` clears the internet address and gateway. */
export function effectiveHomeRouterForm(form: HomeRouterPanelForm): HomeRouterForm {
  const { wanMode, ...rest } = form;
  if (wanMode !== 'static') return { ...rest, wan: { ...rest.wan, address: '', mask: '', gateway: '' } };
  return rest;
}

/** Validation of the panel form (router checks plus the WAN mode rules). */
export function validateHomeRouterPanel(
  draft: HomeRouterPanelForm,
  baseline: HomeRouterPanelForm,
  specs: Readonly<Record<PortId, RadioPortSpec>>,
): FormErrors {
  const errors = validateHomeRouterForm(effectiveHomeRouterForm(draft), effectiveHomeRouterForm(baseline), specs);
  // A router that never had a local address can still get its Wi-Fi set up first: only removing an address is refused.
  const emptyLan = (f: HomeRouterForm): boolean => f.lan.address.trim() === '' && f.lan.mask.trim() === '';
  if (emptyLan(draft) && emptyLan(baseline)) delete errors['lan.address'];
  if (draft.wanMode === 'dhcp' && errors['wan.address'] === undefined) {
    errors['wan.address'] = 'Automatic internet addressing is not available in this release. Choose a fixed address or not connected.';
  }
  if (draft.wanMode === 'static' && draft.wan.port !== '') {
    if (draft.wan.address.trim() === '' && errors['wan.address'] === undefined) errors['wan.address'] = 'Enter the internet address your provider gave you.';
    if (draft.wan.mask.trim() === '' && errors['wan.mask'] === undefined) errors['wan.mask'] = 'Enter the subnet mask of the internet address.';
  }
  return errors;
}

/** Lines of the panel form against its baseline. */
export function homeRouterPanelPlan(draft: HomeRouterPanelForm, baseline: HomeRouterPanelForm): CommandPlan {
  return homeRouterCommands(effectiveHomeRouterForm(draft), effectiveHomeRouterForm(baseline));
}

/** Validate, build and send the home router setup. */
export function applyHomeRouterSettings(
  api: ConfigureApi,
  device: DeviceId,
  draft: HomeRouterPanelForm,
  baseline: HomeRouterPanelForm,
  specs: Readonly<Record<PortId, RadioPortSpec>>,
): Promise<PanelSubmitResult> {
  return runPanelSubmit(api, device, validateHomeRouterPanel(draft, baseline, specs), () => homeRouterPanelPlan(draft, baseline));
}

/** The form as it stands on the device after a successful Apply (secrets cleared, `none` fields emptied). */
export function appliedHomeRouterForm(draft: HomeRouterPanelForm): HomeRouterPanelForm {
  const effective = effectiveHomeRouterForm(draft);
  return { ...effective, wanMode: draft.wanMode === 'static' ? 'static' : 'none', radios: effective.radios.map(clearedRadioSecrets) };
}

/** The address range the DHCP service will offer on the local network. */
export interface DhcpPoolSuggestion {
  readonly start: string;
  readonly end: string;
  /** Addresses in the range, the router's own address excluded. */
  readonly size: number;
}

function dotted(v: number): string {
  return `${v >>> 24}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`;
}

/**
 * Pool the router proposes for a LAN address and mask: `.100`–`.199` of the subnet when it has room for that, else
 * every host address except the router's own. Undefined for invalid input or subnets with fewer than 2 hosts.
 */
export function suggestedDhcpPool(address: string, mask: string): DhcpPoolSuggestion | undefined {
  const a = normalizeIpv4(address);
  const m = normalizeMask(mask);
  if (a === undefined || m === undefined) return undefined;
  const len = maskToPrefixLen(m);
  if (len === null || len > 30) return undefined;
  const maskU = prefixLenToMaskU32(len);
  const router = parseIpv4(a) as number;
  const network = (router & maskU) >>> 0;
  const broadcast = (network | ~maskU) >>> 0;
  const firstHost = network + 1;
  const lastHost = broadcast - 1;
  let start: number;
  let end: number;
  if (lastHost - firstHost + 1 >= 254) {
    start = network + 100;
    end = network + 199;
  } else {
    start = firstHost;
    end = lastHost;
  }
  if (router === start) start += 1;
  if (router === end) end -= 1;
  if (end < start) return undefined;
  const inside = router > start && router < end ? 1 : 0;
  return Object.freeze({ start: dotted(start), end: dotted(end), size: end - start + 1 - inside });
}

// ── components ───────────────────────────────────────────────────────────────

function portLine(port: PortSnapshot | undefined, device: Pick<DeviceSnapshot, 'power'>): { glyph: string; text: string } {
  if (port === undefined) return { glyph: '○', text: 'not present' };
  if (!device.power) return { glyph: '○', text: 'router off' };
  if (!port.adminUp) return { glyph: '■', text: 'turned off' };
  if (port.operUp) return { glyph: '●', text: 'up' };
  return { glyph: '▲', text: port.kind === 'virtual' ? 'down (nothing connected to the local network)' : port.link === undefined ? 'down (no cable)' : 'down' };
}

function AddressInput({
  label,
  field,
  value,
  submit,
  placeholder,
  hint,
  onChange,
}: {
  label: string;
  field: string;
  value: string;
  submit: Pick<SubmitState, 'clientErrors' | 'outcome'>;
  placeholder?: string;
  hint?: string;
  onChange(value: string): void;
}) {
  return (
    <SettingsField label={label} error={fieldError(submit, field)} hint={hint}>
      {({ id, describedBy, invalid }) => (
        <input
          id={id}
          className="input mono"
          value={value}
          spellCheck={false}
          autoComplete="off"
          inputMode="decimal"
          placeholder={placeholder}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </SettingsField>
  );
}

function DhcpPoolFields({ lan }: { lan: HomeRouterForm['lan'] }) {
  const noteId = useId();
  const pool = suggestedDhcpPool(lan.address, lan.mask);
  return (
    <fieldset className="insp-section" disabled aria-describedby={noteId} style={{ border: 'none', margin: 0, padding: 0, minWidth: 0 }}>
      <legend className="panel-title">
        Address pool for computers <span className="dim">(next release)</span>
      </legend>
      <div id={noteId} className="reason-box" role="note">
        <span aria-hidden="true">ⓘ </span>
        {DHCP_LATER_NOTE}
      </div>
      <dl className="kv">
        <SettingsField label="Hand out addresses">
          {({ id, describedBy }) => (
            <label htmlFor={id} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input id={id} type="checkbox" checked={false} readOnly aria-describedby={describedBy} />
              Off
            </label>
          )}
        </SettingsField>
        <SettingsField label="First address">
          {({ id, describedBy }) => <input id={id} className="input mono" readOnly value={pool?.start ?? ''} aria-describedby={describedBy} />}
        </SettingsField>
        <SettingsField label="Last address">
          {({ id, describedBy }) => <input id={id} className="input mono" readOnly value={pool?.end ?? ''} aria-describedby={describedBy} />}
        </SettingsField>
        <SettingsField label="Lease time">
          {({ id, describedBy }) => <input id={id} className="input" readOnly value="1 day" aria-describedby={describedBy} />}
        </SettingsField>
      </dl>
      <div className="insp-note">
        {pool === undefined
          ? 'Set a valid local network address to see the planned range.'
          : `${pool.size} address${pool.size === 1 ? '' : 'es'} planned; the router keeps its own address out of the range.`}
      </div>
    </fieldset>
  );
}

/** Home router setup panel (`home-router.setup`). */
export function HomeRouterPanel({ device }: { device: DeviceSnapshot }) {
  const current = homeRouterPanelFormFrom(device);
  const radioPorts = current.radios.map((r) => r.port);
  const specs = useRadioSpecs(device.type, radioPorts);
  const resetKey = `${device.id}|${current.lan.port}|${current.wan.port}|${radioPorts.join(',')}`;
  const form = useSettingsForm<HomeRouterPanelForm>(current, resetKey);
  const submit = useSubmitState(resetKey);
  const associations = useServedAssociations(device.id, radioPorts);
  const wanGroupName = useId();
  const notReady = deviceNotReadyReason(device);
  const { draft } = form;

  const lanPort = device.ports.find((p) => p.id === draft.lan.port);
  const wanPort = device.ports.find((p) => p.id === draft.wan.port);
  const lanStatus = portLine(lanPort, device);
  const wanStatus = portLine(wanPort, device);

  const edit = (field: string, change: (d: HomeRouterPanelForm) => HomeRouterPanelForm): void => {
    submit.clearField(field);
    form.update(change);
  };

  const apply = (): void => {
    const { draft: next, baseline } = form;
    void submit.run(() => applyHomeRouterSettings(engine, device.id, next, baseline, specs)).then((result) => {
      if (result?.outcome?.ok === true) form.markApplied(appliedHomeRouterForm(next));
    });
  };

  if (draft.lan.port === '') {
    return <div className="empty-hint">This device has no local network interface to set up.</div>;
  }

  return (
    <div className="insp-body" aria-label={`Home router setup of ${device.name}`}>
      <section className="insp-section">
        <div className="insp-note">
          This router has no console: everything is set up here. Each change is checked by the router before it is kept,
          and if one setting is refused none of the changes are kept.
        </div>
      </section>

      <fieldset className="insp-section" disabled={submit.busy} style={{ border: 'none', margin: 0, padding: 0, minWidth: 0 }}>
        <legend className="panel-title">
          Local network <span className="dim mono">{draft.lan.port}</span>{' '}
          <span className="dim">
            <span aria-hidden="true">{lanStatus.glyph} </span>
            {lanStatus.text}
          </span>
        </legend>
        <dl className="kv">
          <AddressInput
            label="Router address"
            field="lan.address"
            value={draft.lan.address}
            submit={submit}
            placeholder="192.168.1.1"
            hint="Computers on the local network use this address as their gateway."
            onChange={(v) => edit('lan.address', (d) => ({ ...d, lan: { ...d.lan, address: v } }))}
          />
          <AddressInput
            label="Subnet mask"
            field="lan.mask"
            value={draft.lan.mask}
            submit={submit}
            placeholder="255.255.255.0 or /24"
            onChange={(v) => edit('lan.mask', (d) => ({ ...d, lan: { ...d.lan, mask: v } }))}
          />
        </dl>
      </fieldset>

      <DhcpPoolFields lan={draft.lan} />

      {draft.wan.port !== '' && (
        <fieldset className="insp-section" disabled={submit.busy} style={{ border: 'none', margin: 0, padding: 0, minWidth: 0 }}>
          <legend className="panel-title">
            Internet <span className="dim mono">{draft.wan.port}</span>{' '}
            <span className="dim">
              <span aria-hidden="true">{wanStatus.glyph} </span>
              {wanStatus.text}
            </span>
          </legend>
          <div role="radiogroup" aria-label="How the internet side gets its address" style={{ display: 'grid', gap: 4, margin: '4px 0 8px' }}>
            {WAN_MODES.map(({ mode, label, available }) => (
              <label key={mode} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }} className={available ? undefined : 'dim'}>
                <input
                  type="radio"
                  name={wanGroupName}
                  value={mode}
                  checked={draft.wanMode === mode}
                  disabled={!available}
                  onChange={() => {
                    submit.clearField('wan.address');
                    submit.clearField('wan.mask');
                    submit.clearField('wan.gateway');
                    form.update((d) => ({ ...d, wanMode: mode }));
                  }}
                />
                {label}
                {!available && ' (next release)'}
              </label>
            ))}
          </div>
          {draft.wanMode === 'static' ? (
            <dl className="kv">
              <AddressInput
                label="Internet address"
                field="wan.address"
                value={draft.wan.address}
                submit={submit}
                placeholder="203.0.113.2"
                onChange={(v) => edit('wan.address', (d) => ({ ...d, wan: { ...d.wan, address: v } }))}
              />
              <AddressInput
                label="Subnet mask"
                field="wan.mask"
                value={draft.wan.mask}
                submit={submit}
                placeholder="255.255.255.0 or /24"
                onChange={(v) => edit('wan.mask', (d) => ({ ...d, wan: { ...d.wan, mask: v } }))}
              />
              <AddressInput
                label="Provider gateway"
                field="wan.gateway"
                value={draft.wan.gateway}
                submit={submit}
                placeholder="203.0.113.1"
                hint="Traffic for anywhere outside the local network is sent here. Leave empty for none."
                onChange={(v) => edit('wan.gateway', (d) => ({ ...d, wan: { ...d.wan, gateway: v } }))}
              />
            </dl>
          ) : (
            <>
              <div className="insp-note">The internet port keeps no address and the router has no route to the internet.</div>
              {fieldError(submit, 'wan.address') !== undefined && (
                <div className="reason-box" role="alert" style={{ borderLeftColor: 'var(--err)' }}>
                  <span aria-hidden="true">✖ </span>
                  {fieldError(submit, 'wan.address')}
                </div>
              )}
            </>
          )}
        </fieldset>
      )}

      {draft.radios.length > 0 && (
        <section className="insp-section">
          <div className="panel-title">Wi-Fi</div>
        </section>
      )}
      {draft.radios.map((radio, i) => {
        const port = device.ports.find((p) => p.id === radio.port);
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
              onChange={(next) => form.update((d) => ({ ...d, radios: d.radios.map((r, j) => (j === i ? next : r)) }))}
            />
            <section className="insp-section">
              <div className="panel-title">Connected on {radio.port}</div>
              <ClientTable associations={served} empty="No wireless devices are connected to this radio." />
            </section>
          </Fragment>
        );
      })}

      <SubmitBar submit={submit} form={form} canApply={notReady === undefined} disabledReason={notReady} onApply={apply} />
    </div>
  );
}
