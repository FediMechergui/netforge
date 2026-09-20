/**
 * Desktop "IP configuration" app (ARCHITECTURE-P1 §7 Desktop tab; D9). Shows the adapters of an end device and
 * edits the address, mask and default gateway of one adapter. The form is read from the snapshot
 * (gui/forms `ipConfigFormFrom`), checked locally (`validateIpConfigForm`), turned into canonical lines
 * (gui/commands `ipConfigCommands`) and applied through `EngineApi.configure`; errors from the device's own CLI come
 * back next to the field that produced them. The adapter can also be enabled or disabled (`portAdminCommands`).
 *
 * While the user has not edited anything, the form follows the live snapshot. Wording is original (§1.6).
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ROLE_TRAITS } from '@netforge/engine';
import type { CliGrammar, DeviceSnapshot, PortId, PortSnapshot } from '@netforge/engine';
import { ipConfigCommands, portAdminCommands } from '../../gui/commands.js';
import { defaultAdapter, deviceGrammar, hasErrors, ipConfigFormFrom, validateIpConfigForm } from '../../gui/forms.js';
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
  const fresh = useMemo(() => ipConfigFormFrom(device, adapter), [device, adapter]);
  const [baseline, setBaseline] = useState<IpConfigForm>(fresh);
  const [form, setForm] = useState<IpConfigForm>(fresh);
  const [errors, setErrors] = useState<FormErrors>({});
  const [messages, setMessages] = useState<readonly string[]>([]);
  const [ok, setOk] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const dirty = !sameIpForm(form, baseline);
  // After a successful apply the snapshot lags by one batch; do not snap the form back to the old values meanwhile.
  const settleUntil = useRef(0);
  useEffect(() => {
    if (dirty || busy) return;
    if (!sameIpForm(fresh, baseline)) {
      if (performance.now() < settleUntil.current) return;
      setBaseline(fresh);
      setForm(fresh);
    }
  }, [fresh, baseline, dirty, busy]);

  const port = device.ports.find((p) => p.id === adapter);
  const blocked = deviceBusyReason(device);

  const edit = (patch: Partial<IpConfigForm>): void => {
    setForm((f) => ({ ...f, ...patch }));
    setOk(null);
    setMessages([]);
  };

  const chooseAdapter = (id: PortId): void => {
    const next = ipConfigFormFrom(device, id);
    setAdapter(id);
    setBaseline(next);
    setForm(next);
    setErrors({});
    setMessages([]);
    setOk(null);
  };

  const apply = async (): Promise<void> => {
    const found = validateIpConfigForm(form, { grammar, ...(def !== undefined ? { defaultAdapter: def } : {}) });
    setErrors(found);
    if (hasErrors(found)) {
      setOk(false);
      setMessages(['Fix the marked fields first.']);
      return;
    }
    let plan;
    try {
      plan = ipConfigCommands(grammar, form, baseline, def);
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
            <InfoRow label="State">{adapterStateText(port).text}</InfoRow>
          </dl>
        </section>
      )}
    </div>
  );
}
