/**
 * Desktop "IP configuration" app (ARCHITECTURE-P1 §7 Desktop tab; D9). Shows the adapters of an end device and
 * edits the address, mask and default gateway of one adapter. The form is read from the snapshot
 * (gui/forms `ipConfigFormFrom`), checked locally (`validateIpConfigForm`), turned into canonical lines
 * (gui/commands `ipConfigCommands`) and applied through `EngineApi.configure`; errors from the device's own CLI come
 * back next to the field that produced them. The adapter can also be enabled or disabled (`portAdminCommands`).
 *
 * While the user has not edited anything, the form follows the live snapshot. Wording is original (§1.6).
 *
 * P2 (ARCHITECTURE-P2 §5.5 "IP configuration app", §5.2; W3 web-inspector): an IPv6 choice — nothing, automatic
 * from router advertisements, or automatic with DHCPv6 — writes `ipv6 address dhcp` / `ipv6 address autoconfig`
 * (host shell: `ipv6 address dhcp [<adapter>]` / `ipv6 autoconfig [<adapter>]`) through gui/commands
 * `ipv6ModeCommands`; the choice is read back from the adapter's config lines. [S4] On a telephone (a host with a
 * built-in bridge: capabilities `host` and `switching`, no routing) a Voice VLAN field writes `voice vlan <v>`
 * (`voiceVlanCommands`). The form model of this panel (`IpConfigPanelForm`) extends gui/forms' `IpConfigForm` with
 * these two values; the P1 form and its builders are unchanged.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ROLE_TRAITS, isVlanId } from '@netforge/engine';
import type { CliGrammar, DeviceSnapshot, PortId, PortSnapshot } from '@netforge/engine';
import { IPV6_ADDRESS_MODES, ipConfigCommands, ipv6ModeCommands, mergePlans, portAdminCommands, voiceVlanCommands } from '../../gui/commands.js';
import type { CommandPlan, Ipv6AddressMode } from '../../gui/commands.js';
import {
  configValue,
  defaultAdapter,
  deviceGrammar,
  globalConfigLines,
  hasConfigLine,
  hasErrors,
  interfaceConfigLines,
  ipConfigFormFrom,
  validateIpConfigForm,
} from '../../gui/forms.js';
import type { FormErrors, IpConfigForm } from '../../gui/forms.js';
import { portKindLabel } from '../../vocab/categories.js';
import {
  DeviceGone,
  FormStatus,
  InfoRow,
  TextField,
  deviceBusyReason,
  errorText,
  outcomeMessages,
  submitPlan,
  useDeviceById,
} from '../shared.js';
import type { DesktopAppProps } from '../shared.js';

/** Adapters the app can edit: the default adapter on the host grammar; every configurable L3 port otherwise. */
export function editableAdapters(device: Pick<DeviceSnapshot, 'ports' | 'hostPorts' | 'cli'>, grammar: CliGrammar = deviceGrammar(device)): readonly PortId[] {
  const def = defaultAdapter(device);
  if (grammar === 'host') return def === undefined ? [] : [def];
  const out: PortId[] = [];
  for (const p of device.ports) {
    if (p.configurable === false || (p.virtual === true && p.role !== 'svi')) continue;
    if (p.role !== undefined && !ROLE_TRAITS[p.role].l3) continue;
    if (p.role === undefined && p.kind !== 'ethernet' && p.kind !== 'serial') continue;
    out.push(p.id);
  }
  if (def !== undefined && !out.includes(def)) out.unshift(def);
  return out;
}

/** Adapters listed in the status table: `hostPorts` when the model names them, else the editable ones. */
export function listedAdapters(device: Pick<DeviceSnapshot, 'ports' | 'hostPorts' | 'cli'>): readonly PortSnapshot[] {
  const ids = device.hostPorts !== undefined && device.hostPorts.length > 0 ? device.hostPorts : editableAdapters(device);
  const out: PortSnapshot[] = [];
  for (const id of ids) {
    const p = device.ports.find((x) => x.id === id);
    if (p !== undefined) out.push(p);
  }
  return out;
}

/** Same values (text compare, whitespace-insensitive). */
export function sameIpForm(a: IpConfigForm, b: IpConfigForm): boolean {
  return a.adapter === b.adapter && a.address.trim() === b.address.trim() && a.mask.trim() === b.mask.trim() && a.gateway.trim() === b.gateway.trim();
}

// ── P2: IPv6 choice and the phone's Voice VLAN ───────────────────────────────

/** The panel's form: the P1 address form plus the IPv6 choice and (phones) the Voice VLAN. */
export interface IpConfigPanelForm extends IpConfigForm {
  ipv6: Ipv6AddressMode;
  /** Empty = no voice VLAN configured (ignored on devices without the field). */
  voiceVlan: string;
}

/** Display names of the IPv6 choices. */
export const IPV6_MODE_LABELS: Readonly<Record<Ipv6AddressMode, string>> = Object.freeze({
  none: 'Not set automatically',
  autoconfig: 'Automatic from router advertisements',
  dhcp: 'Automatic with DHCPv6',
});

/** The IPv6 choice of an adapter from its config lines (`ipv6 address dhcp` wins over `ipv6 address autoconfig`). */
export function ipv6AddressModeFrom(device: Pick<DeviceSnapshot, 'runningConfig'>, adapter: PortId): Ipv6AddressMode {
  const lines = interfaceConfigLines(device.runningConfig, adapter);
  if (hasConfigLine(lines, ['ipv6', 'address', 'dhcp'])) return 'dhcp';
  if (hasConfigLine(lines, ['ipv6', 'address', 'autoconfig'])) return 'autoconfig';
  return 'none';
}

/** The configured `voice vlan <v>` of a device ('' when none). */
export function voiceVlanFrom(device: Pick<DeviceSnapshot, 'runningConfig'>): string {
  return configValue(globalConfigLines(device.runningConfig), ['voice', 'vlan']) ?? '';
}

/**
 * [S4] Whether the device takes a Voice VLAN: a host with a built-in bridge and no routing (the telephone's
 * capability set), decided from capabilities, never from the icon family.
 */
export function voiceVlanCapable(device: Pick<DeviceSnapshot, 'capabilities'>): boolean {
  const caps = device.capabilities ?? [];
  return caps.includes('host') && caps.includes('switching') && !caps.includes('routing');
}

/** Panel form of an adapter: the P1 form plus the IPv6 choice and the voice VLAN. */
export function ipConfigPanelFormFrom(device: DeviceSnapshot, adapter?: PortId): IpConfigPanelForm {
  const base = ipConfigFormFrom(device, adapter);
  return { ...base, ipv6: ipv6AddressModeFrom(device, base.adapter), voiceVlan: voiceVlanFrom(device) };
}

/** Same values, the P2 fields included. */
export function sameIpPanelForm(a: IpConfigPanelForm, b: IpConfigPanelForm): boolean {
  return sameIpForm(a, b) && a.ipv6 === b.ipv6 && a.voiceVlan.trim() === b.voiceVlan.trim();
}

/** Error for the Voice VLAN input; empty is allowed (no voice VLAN). */
export function checkVoiceVlan(text: string): string | undefined {
  const t = text.trim();
  if (t === '') return undefined;
  if (!/^\d+$/.test(t) || !isVlanId(Number(t))) return 'Enter a VLAN number from 1 to 4094, or leave the field empty.';
  return undefined;
}

/** Validation context of the panel form. */
export interface IpConfigPanelContext {
  grammar: CliGrammar;
  defaultAdapter?: PortId;
  /** The Voice VLAN field is shown (validated) on this device. */
  voiceVlan: boolean;
}

/** Validate the panel form: the P1 checks plus the voice VLAN when the device takes one. */
export function validateIpConfigPanelForm(form: IpConfigPanelForm, ctx: IpConfigPanelContext): FormErrors {
  const errors = validateIpConfigForm(form, { grammar: ctx.grammar, ...(ctx.defaultAdapter !== undefined ? { defaultAdapter: ctx.defaultAdapter } : {}) });
  if (ctx.voiceVlan) {
    const bad = checkVoiceVlan(form.voiceVlan);
    if (bad !== undefined && errors['voiceVlan'] === undefined) errors['voiceVlan'] = bad;
  }
  return errors;
}

/**
 * The panel's plan: the P1 address lines, then the IPv6 choice, then (phones) the voice VLAN, in one atomic
 * `configure` call. Throws like `ipConfigCommands` when the host grammar is asked for a non-default adapter.
 */
export function ipConfigPanelPlan(grammar: CliGrammar, next: IpConfigPanelForm, previous: IpConfigPanelForm | undefined, ctx: { defaultAdapter?: PortId; voiceVlan: boolean }): CommandPlan {
  const plans: CommandPlan[] = [ipConfigCommands(grammar, next, previous, ctx.defaultAdapter)];
  plans.push(ipv6ModeCommands(grammar, next.adapter, next.ipv6, previous?.ipv6, ctx.defaultAdapter));
  if (ctx.voiceVlan) plans.push(voiceVlanCommands(grammar, next.voiceVlan, previous?.voiceVlan));
  return mergePlans(grammar, plans);
}

/** One-line state of an adapter: glyph + words (never colour alone). */
export function adapterStateText(p: Pick<PortSnapshot, 'adminUp' | 'operUp'>): { glyph: string; text: string } {
  if (!p.adminUp) return { glyph: '⊘', text: 'disabled' };
  if (p.operUp) return { glyph: '▲', text: 'connected' };
  return { glyph: '▽', text: 'not connected' };
}

function addressText(p: PortSnapshot): string {
  const v4 = p.l3.ipv4;
  return v4 === undefined ? 'no address' : `${v4.address}/${v4.prefixLen}`;
}

/** Origin wording of an IPv6 address (how the adapter got it). */
const IPV6_ORIGIN_TEXT: Readonly<Record<string, string>> = Object.freeze({
  manual: 'set by hand',
  eui64: 'built from the MAC address',
  'auto-link-local': 'link-local',
  slaac: 'from a router advertisement',
  dhcpv6: 'from DHCPv6',
});

/** Global and unique-local IPv6 addresses of an adapter with how each was obtained. */
export function ipv6AddressLines(p: Pick<PortSnapshot, 'l3'>): readonly string[] {
  return (p.l3.ipv6 ?? [])
    .filter((a) => a.scope !== 'link-local')
    .map((a) => `${a.address}/${a.prefixLen} (${IPV6_ORIGIN_TEXT[a.origin] ?? a.origin}${a.state === 'preferred' ? '' : `, ${a.state}`})`);
}

/** Wall time the form keeps the applied values while the confirming snapshot is on its way. */
export const SETTLE_MS = 1500;

export function IpConfigApp({ deviceId }: DesktopAppProps) {
  const device = useDeviceById(deviceId);
  if (device === undefined) return <DeviceGone />;
  return <IpConfigPanel device={device} />;
}

function IpConfigPanel({ device }: { device: DeviceSnapshot }) {
  const uid = useId();
  const grammar = deviceGrammar(device);
  const def = defaultAdapter(device);
  const adapters = editableAdapters(device, grammar);
  const [adapter, setAdapter] = useState<PortId>(def ?? adapters[0] ?? '');
  const voice = voiceVlanCapable(device);
  const fresh = useMemo(() => ipConfigPanelFormFrom(device, adapter), [device, adapter]);
  const [baseline, setBaseline] = useState<IpConfigPanelForm>(fresh);
  const [form, setForm] = useState<IpConfigPanelForm>(fresh);
  const [errors, setErrors] = useState<FormErrors>({});
  const [messages, setMessages] = useState<readonly string[]>([]);
  const [ok, setOk] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const dirty = !sameIpPanelForm(form, baseline);
  // After a successful apply the snapshot lags by one batch; do not snap the form back to the old values meanwhile.
  const settleUntil = useRef(0);
  useEffect(() => {
    if (dirty || busy) return;
    if (!sameIpPanelForm(fresh, baseline)) {
      if (performance.now() < settleUntil.current) return;
      setBaseline(fresh);
      setForm(fresh);
    }
  }, [fresh, baseline, dirty, busy]);

  const port = device.ports.find((p) => p.id === adapter);
  const blocked = deviceBusyReason(device);

  const edit = (patch: Partial<IpConfigPanelForm>): void => {
    setForm((f) => ({ ...f, ...patch }));
    setOk(null);
    setMessages([]);
  };

  const chooseAdapter = (id: PortId): void => {
    const next = ipConfigPanelFormFrom(device, id);
    setAdapter(id);
    setBaseline(next);
    setForm(next);
    setErrors({});
    setMessages([]);
    setOk(null);
  };

  const apply = async (): Promise<void> => {
    const found = validateIpConfigPanelForm(form, { grammar, ...(def !== undefined ? { defaultAdapter: def } : {}), voiceVlan: voice });
    setErrors(found);
    if (hasErrors(found)) {
      setOk(false);
      setMessages(['Fix the marked fields first.']);
      return;
    }
    let plan;
    try {
      plan = ipConfigPanelPlan(grammar, form, baseline, { ...(def !== undefined ? { defaultAdapter: def } : {}), voiceVlan: voice });
    } catch (err) {
      setOk(false);
      setMessages([errorText(err)]);
      return;
    }
    if (plan.lines.length === 0) {
      setOk(true);
      setMessages(['Nothing to change.']);
      return;
    }
    setBusy(true);
    const outcome = await submitPlan(device.id, plan);
    setBusy(false);
    setErrors(outcome.fieldErrors);
    if (outcome.ok) {
      setOk(true);
      setMessages(['Settings applied.']);
      settleUntil.current = performance.now() + SETTLE_MS;
      setBaseline(form);
    } else {
      setOk(false);
      const msgs = outcomeMessages(outcome);
      setMessages(msgs.length > 0 ? msgs : ['Check the marked fields.']);
    }
  };

  const toggleAdmin = async (): Promise<void> => {
    if (port === undefined) return;
    setBusy(true);
    const outcome = await submitPlan(device.id, portAdminCommands(grammar, port.id, !port.adminUp));
    setBusy(false);
    setOk(outcome.ok);
    setMessages(outcome.ok ? [port.adminUp ? `${port.id} disabled.` : `${port.id} enabled.`] : outcomeMessages(outcome));
  };

  const revert = (): void => {
    setForm(baseline);
    setErrors({});
    setMessages([]);
    setOk(null);
  };

  const listed = listedAdapters(device);

  return (
    <div className="desk-app">
      <section aria-labelledby={`${uid}-adapters`}>
        <h3 id={`${uid}-adapters`} className="desk-heading">
          Network adapters
        </h3>
        {listed.length === 0 ? (
          <p className="desk-empty">This device has no network adapter.</p>
        ) : (
          <table className="desk-table">
            <thead>
              <tr>
                <th scope="col">Adapter</th>
                <th scope="col">State</th>
                <th scope="col">Address</th>
              </tr>
            </thead>
            <tbody>
              {listed.map((p) => {
                const st = adapterStateText(p);
                return (
                  <tr key={p.id} className={p.id === adapter ? 'is-current' : undefined}>
                    <th scope="row">
                      {p.id}
                      <span className="desk-sub"> {portKindLabel(p.kind)}</span>
                    </th>
                    <td>
                      <span aria-hidden="true">{st.glyph} </span>
                      {st.text}
                    </td>
                    <td className="desk-mono">{addressText(p)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <form
        className="desk-form"
        aria-labelledby={`${uid}-settings`}
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void apply();
        }}
      >
        <h3 id={`${uid}-settings`} className="desk-heading">
          Address settings
        </h3>
        {adapters.length > 1 ? (
          <div className="desk-field">
            <label htmlFor={`${uid}-adapter`}>Adapter</label>
            <select id={`${uid}-adapter`} className="select" value={adapter} onChange={(e) => chooseAdapter(e.target.value)}>
              {adapters.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <p className="desk-sub">
            Adapter: <strong>{adapter === '' ? 'none' : adapter}</strong>
            {grammar === 'host' && listed.length > 1 ? ' (this device sets addresses on its main adapter only)' : ''}
          </p>
        )}
        {errors['adapter'] !== undefined && (
          <p className="desk-error" role="alert">
            <span aria-hidden="true">⚠ </span>
            {errors['adapter']}
          </p>
        )}
        <TextField id={`${uid}-address`} label="IP address" value={form.address} error={errors['address']} placeholder="192.168.1.10" onChange={(v) => edit({ address: v })} />
        <TextField
          id={`${uid}-mask`}
          label="Subnet mask"
          value={form.mask}
          error={errors['mask']}
          placeholder="255.255.255.0"
          hint="Dotted, or a prefix such as /24."
          onChange={(v) => edit({ mask: v })}
        />
        <TextField
          id={`${uid}-gateway`}
          label="Default gateway"
          value={form.gateway}
          error={errors['gateway']}
          placeholder="192.168.1.1"
          hint="Leave empty for no gateway. Clear every field to remove the address."
          onChange={(v) => edit({ gateway: v })}
        />
        <div className={`desk-field ${errors['ipv6'] !== undefined ? 'has-error' : ''}`}>
          <label htmlFor={`${uid}-ipv6`}>IPv6 address</label>
          <select
            id={`${uid}-ipv6`}
            className="select"
            value={form.ipv6}
            aria-invalid={errors['ipv6'] !== undefined}
            aria-describedby={`${uid}-ipv6-hint${errors['ipv6'] !== undefined ? ` ${uid}-ipv6-err` : ''}`}
            onChange={(e) => edit({ ipv6: e.target.value as Ipv6AddressMode })}
          >
            {IPV6_ADDRESS_MODES.map((m) => (
              <option key={m} value={m}>
                {IPV6_MODE_LABELS[m]}
              </option>
            ))}
          </select>
          <span id={`${uid}-ipv6-hint`} className="desk-hint">
            DHCPv6 asks a server for an address and name servers; router advertisements let the adapter build its own address.
          </span>
          {errors['ipv6'] !== undefined && (
            <span id={`${uid}-ipv6-err`} className="desk-error">
              <span aria-hidden="true">⚠ </span>
              {errors['ipv6']}
            </span>
          )}
        </div>
        {voice && (
          <TextField
            id={`${uid}-voice-vlan`}
            label="Voice VLAN"
            value={form.voiceVlan}
            error={errors['voiceVlan']}
            placeholder="150"
            hint="The VLAN this telephone tags its calls with. Leave empty to send them untagged."
            onChange={(v) => edit({ voiceVlan: v })}
          />
        )}
        {blocked !== undefined && <p className="desk-note">{blocked}</p>}
        <div className="desk-actions">
          <button type="submit" className="btn btn-primary" disabled={busy || adapter === '' || blocked !== undefined}>
            {busy ? 'Applying…' : 'Apply'}
          </button>
          <button type="button" className="btn" disabled={!dirty || busy} onClick={revert}>
            Undo edits
          </button>
          {port !== undefined && port.configurable !== false && (
            <button type="button" className="btn" disabled={busy || blocked !== undefined} onClick={() => void toggleAdmin()}>
              {port.adminUp ? 'Disable adapter' : 'Enable adapter'}
            </button>
          )}
        </div>
        <FormStatus ok={ok} messages={messages} />
      </form>

      {port !== undefined && (
        <section aria-labelledby={`${uid}-details`}>
          <h3 id={`${uid}-details`} className="desk-heading">
            {port.id} details
          </h3>
          <dl className="desk-info">
            <InfoRow label="Physical address">
              <span className="desk-mono">{port.mac}</span>
            </InfoRow>
            <InfoRow label="Address">
              <span className="desk-mono">{addressText(port)}</span>
            </InfoRow>
            {ipv6AddressLines(port).length > 0 && (
              <InfoRow label="IPv6 addresses">
                {ipv6AddressLines(port).map((line) => (
                  <div key={line} className="desk-mono">
                    {line}
                  </div>
                ))}
              </InfoRow>
            )}
            <InfoRow label="State">{adapterStateText(port).text}</InfoRow>
          </dl>
        </section>
      )}
    </div>
  );
}
