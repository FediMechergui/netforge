/**
 * Wireless controller panel (GUI panel `wlc.controller`; ARCHITECTURE-P2 §3.12, §5.3, §5.5 "Controller panel", D9,
 * D17; §7 W6 web-inspector).
 *
 * Four pages, chosen with a keyboard-reachable tab list:
 *  - Access points — the lightweight access points that joined (the `capwap-aps` rows: name, MAC, address, join state
 *    as a glyph plus words, clients), with the management interface the access points join on;
 *  - Interfaces — the controller interfaces (`wlc-interface <name>`: VLAN, address, mask, gateway, DHCP server), the
 *    predefined `management` interface always first; create one, edit one, remove one;
 *  - WLANs — the WLANs (`wlan <id> <profile> <ssid>`: security, passphrase, the interface chosen from the Interfaces
 *    list, radios, offered or not); create, edit, remove;
 *  - Clients — the wireless clients the access points report (the `wlan-clients` rows).
 *
 * The panel never writes configuration itself (D9): each editor validates its form (gui/forms.ts), builds the
 * canonical §5.3 lines with the pure builders of gui/commands.ts (`wlcInterfaceCommands`, `wlanCommands`,
 * `wlcInterfaceRemoveCommands`, `wlanRemoveCommands`) and sends them through `EngineApi.configure`, so the controller's
 * own grammar and handlers check every line; a refused line comes back next to the input that produced it
 * (`runPanelSubmit`, `SettingsField`, `SubmitBar` from WirelessPanel). Passphrases are never read back: the form
 * only knows whether one is stored. Nothing here branches on the device kind; states are words plus a glyph, never
 * colour alone. All wording is original (§1.6).
 */
import { useCallback, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { CapwapApRow, CapwapState, DeviceId, DeviceSnapshot, TableName, WlanClientRow } from '@netforge/engine';
import { engine } from '../bridge/client';
import { wlanCommands, wlanRemoveCommands, wlcInterfaceCommands, wlcInterfaceRemoveCommands } from '../gui/commands';
import {
  PASSPHRASE_MAX,
  WIFI_SECURITY_LABELS,
  WIFI_SECURITY_MODES,
  WLAN_RADIOS,
  WLAN_RADIO_LABELS,
  emptyWlanForm,
  emptyWlcInterfaceForm,
  nextFreeWlanId,
  sameWlanIdentity,
  validateWlanForm,
  validateWlcInterfaceForm,
  wlanFormsFrom,
  wlcInterfaceFormsFrom,
  wlcManagementInterface,
} from '../gui/forms';
import type { WlanContext, WlanForm, WlanRadio, WlcInterfaceContext, WlcInterfaceForm } from '../gui/forms';
import { SettingsField, SubmitBar, deviceNotReadyReason, fieldError, runPanelSubmit, useSettingsForm, useSubmitState } from './WirelessPanel';
import type { ConfigureApi, PanelSubmitResult, SubmitState } from './WirelessPanel';

// ── pages ────────────────────────────────────────────────────────────────────

/** The pages of the controller panel. */
export type WlcPage = 'aps' | 'interfaces' | 'wlans' | 'clients';

/** Pages in display order. */
export const WLC_PAGES: readonly WlcPage[] = Object.freeze(['aps', 'interfaces', 'wlans', 'clients']);

/** Page names. */
export const WLC_PAGE_LABELS: Readonly<Record<WlcPage, string>> = Object.freeze({
  aps: 'Access points',
  interfaces: 'Interfaces',
  wlans: 'WLANs',
  clients: 'Clients',
});

/** Next page for keyboard navigation of the page list (wraps around). */
export function stepWlcPage(current: WlcPage, key: 'next' | 'prev' | 'first' | 'last'): WlcPage {
  const n = WLC_PAGES.length;
  const i = Math.max(0, WLC_PAGES.indexOf(current));
  const idx = key === 'first' ? 0 : key === 'last' ? n - 1 : key === 'next' ? (i + 1) % n : (i - 1 + n) % n;
  return WLC_PAGES[idx] ?? 'aps';
}

/** The page the panel opens on: Interfaces while the management interface has no address (setup comes first), else Access points. */
export function initialWlcPage(device: Pick<DeviceSnapshot, 'runningConfig'>): WlcPage {
  const management = wlcInterfaceFormsFrom(device.runningConfig)[0];
  return management === undefined || management.address === '' ? 'interfaces' : 'aps';
}

// ── snapshot readers ─────────────────────────────────────────────────────────

/** Rows of one extra table of the device snapshot (empty when the device has none). */
export function extraRows<T>(device: Pick<DeviceSnapshot, 'tables'>, name: TableName): readonly T[] {
  return (device.tables.extra?.find((t) => t.name === name)?.rows ?? []) as unknown as readonly T[];
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The access points that joined the controller (`capwap-aps`), by name then MAC. */
export function capwapApRows(device: Pick<DeviceSnapshot, 'tables'>): readonly CapwapApRow[] {
  return [...extraRows<CapwapApRow>(device, 'capwap-aps')].sort((a, b) => byText(a.name, b.name) || byText(a.apMac, b.apMac));
}

/** The wireless clients the access points reported (`wlan-clients`), by station MAC. */
export function wlanClientRows(device: Pick<DeviceSnapshot, 'tables'>): readonly WlanClientRow[] {
  return [...extraRows<WlanClientRow>(device, 'wlan-clients')].sort((a, b) => byText(a.station, b.station));
}

/** A CAPWAP join state as a glyph and words (the glyph is the non-colour channel; the words are the text form). */
export const CAPWAP_STATE_TEXT: Readonly<Record<CapwapState, { readonly glyph: string; readonly text: string }>> = Object.freeze({
  idle: { glyph: '○', text: 'idle' },
  discovery: { glyph: '▲', text: 'looking for a controller' },
  dtls: { glyph: '▲', text: 'securing the control channel (simulated)' },
  join: { glyph: '▲', text: 'joining' },
  configure: { glyph: '▲', text: 'receiving its configuration' },
  'data-check': { glyph: '▲', text: 'checking the data channel' },
  run: { glyph: '●', text: 'running' },
});

function capwapStateText(state: string): { readonly glyph: string; readonly text: string } {
  return CAPWAP_STATE_TEXT[state as CapwapState] ?? { glyph: '?', text: state };
}

/** WLANs (by number) that name each controller interface. */
export function wlansByInterface(wlans: readonly Pick<WlanForm, 'id' | 'iface'>[]): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const w of wlans) {
    const list = out.get(w.iface) ?? [];
    list.push(w.id);
    out.set(w.iface, list);
  }
  return out;
}

// ── validation contexts ──────────────────────────────────────────────────────

/** Context of the interface editor: every configured interface except the one being edited (`editing`, null = new). */
export function wlcInterfaceContextOf(interfaces: readonly WlcInterfaceForm[], editing: WlcInterfaceForm | undefined): WlcInterfaceContext {
  return { others: interfaces.filter((i) => i.name !== editing?.name), isNew: editing === undefined };
}

/** Context of the WLAN editor: every configured WLAN except the one being edited, and the interface names. */
export function wlanContextOf(wlans: readonly WlanForm[], interfaces: readonly WlcInterfaceForm[], editing: WlanForm | undefined): WlanContext {
  return { others: wlans.filter((w) => w.id !== editing?.id), interfaces: interfaces.map((i) => i.name) };
}

// ── submit ───────────────────────────────────────────────────────────────────

/** Validate, build and send one controller interface (`previous` undefined = a new interface). */
export function applyWlcInterface(
  api: ConfigureApi,
  device: DeviceId,
  draft: WlcInterfaceForm,
  previous: WlcInterfaceForm | undefined,
  ctx: WlcInterfaceContext,
): Promise<PanelSubmitResult> {
  return runPanelSubmit(api, device, validateWlcInterfaceForm(draft, ctx), () => wlcInterfaceCommands(draft, previous));
}

/** Remove a controller interface (the controller refuses the management interface and one a WLAN still uses). */
export function removeWlcInterface(api: ConfigureApi, device: DeviceId, name: string): Promise<PanelSubmitResult> {
  return runPanelSubmit(api, device, {}, () => wlcInterfaceRemoveCommands(name));
}

/** Validate, build and send one WLAN (`previous` undefined = a new WLAN). */
export function applyWlan(api: ConfigureApi, device: DeviceId, draft: WlanForm, previous: WlanForm | undefined, ctx: WlanContext): Promise<PanelSubmitResult> {
  return runPanelSubmit(api, device, validateWlanForm(draft, previous, ctx), () => wlanCommands(draft, previous));
}

/** Remove a WLAN by number. */
export function removeWlan(api: ConfigureApi, device: DeviceId, id: string): Promise<PanelSubmitResult> {
  return runPanelSubmit(api, device, {}, () => wlanRemoveCommands(id));
}

/** The WLAN form as it stands once applied: the typed passphrase is forgotten, only its presence is kept. */
export function appliedWlanForm(draft: WlanForm): WlanForm {
  return { ...draft, passphrase: '', hasPassphrase: draft.security !== 'open' && (draft.hasPassphrase || draft.passphrase !== '') };
}

// ── small components ─────────────────────────────────────────────────────────

const FIELDSET_STYLE = { border: 'none', margin: 0, padding: 0, minWidth: 0 } as const;

/** Result of a remove button: what the controller said, next to the list. */
function ActionOutcome({ submit, done }: { submit: SubmitState; done: string }) {
  const { outcome } = submit;
  if (outcome === null) return null;
  if (outcome.ok) {
    return (
      <div className="reason-box ok" role="status">
        <span aria-hidden="true">✔ </span>
        {done}
      </div>
    );
  }
  const messages = [...outcome.general, ...Object.values(outcome.fieldErrors)];
  return (
    <div className="reason-box" role="alert" style={{ borderLeftColor: 'var(--err)' }}>
      <span aria-hidden="true">✖ </span>
      The controller refused: {messages.join(' ')}
    </div>
  );
}

function TextInput({
  label,
  field,
  value,
  submit,
  hint,
  mono = true,
  placeholder,
  inputMode,
  onChange,
}: {
  label: string;
  field: string;
  value: string;
  submit: SubmitState;
  hint?: string;
  mono?: boolean;
  placeholder?: string;
  inputMode?: 'numeric' | 'decimal';
  onChange(value: string): void;
}) {
  return (
    <SettingsField label={label} error={fieldError(submit, field)} hint={hint}>
      {({ id, describedBy, invalid }) => (
        <input
          id={id}
          className={mono ? 'input mono' : 'input'}
          value={value}
          placeholder={placeholder}
          inputMode={inputMode}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            submit.clearField(field);
            onChange(e.target.value);
          }}
        />
      )}
    </SettingsField>
  );
}

// ── Access points page ───────────────────────────────────────────────────────

function AccessPointsPage({ device, onOpenInterfaces }: { device: DeviceSnapshot; onOpenInterfaces(): void }) {
  const aps = capwapApRows(device);
  const management = wlcInterfaceFormsFrom(device.runningConfig)[0] ?? emptyWlcInterfaceForm(wlcManagementInterface());
  return (
    <>
      <section className="insp-section">
        {management.address !== '' ? (
          <p className="insp-note">
            Access points join on the management interface: <span className="mono">{management.address}</span>
            {management.vlan !== '' && <> in VLAN {management.vlan}</>}.
          </p>
        ) : (
          <div className="reason-box" role="status">
            <span aria-hidden="true">▲ </span>
            The management interface has no address yet, so no access point can join.{' '}
            <button type="button" className="link-btn" onClick={onOpenInterfaces}>
              Set it on the Interfaces page
            </button>
          </div>
        )}
      </section>
      <section className="insp-section">
        <table className="table compact">
          <caption className="dim">Access points that joined this controller.</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">MAC</th>
              <th scope="col">Address</th>
              <th scope="col">State</th>
              <th scope="col" className="num">
                Clients
              </th>
            </tr>
          </thead>
          <tbody>
            {aps.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  No access point has joined yet. A lightweight access point joins once it has an address in a VLAN that
                  reaches the management interface.
                </td>
              </tr>
            ) : (
              aps.map((ap) => {
                const state = capwapStateText(ap.state);
                return (
                  <tr key={ap.key}>
                    <th scope="row">{ap.name}</th>
                    <td className="mono">{ap.apMac}</td>
                    <td className="mono">{ap.apIp}</td>
                    <td>
                      <span aria-hidden="true">{state.glyph} </span>
                      {state.text}
                    </td>
                    <td className="num">{ap.clients}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}

// ── Clients page ─────────────────────────────────────────────────────────────

function ClientsPage({ device }: { device: DeviceSnapshot }) {
  const clients = wlanClientRows(device);
  const apName = new Map(capwapApRows(device).map((a) => [a.apMac, a.name] as const));
  return (
    <section className="insp-section">
      <table className="table compact">
        <caption className="dim">Wireless clients the access points report to this controller.</caption>
        <thead>
          <tr>
            <th scope="col">Client</th>
            <th scope="col">Access point</th>
            <th scope="col">WLAN</th>
            <th scope="col">VLAN</th>
            <th scope="col">Interface</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {clients.length === 0 ? (
            <tr>
              <td colSpan={6}>No wireless client is connected.</td>
            </tr>
          ) : (
            clients.map((c) => (
              <tr key={c.key}>
                <th scope="row" className="mono">
                  {c.station}
                </th>
                <td>{apName.get(c.ap) ?? <span className="mono">{c.ap}</span>}</td>
                <td>
                  {c.wlanId} <span className="dim">({c.ssid})</span>
                </td>
                <td className="mono">{c.vlan}</td>
                <td className="mono">{c.iface}</td>
                <td>
                  <span aria-hidden="true">{c.state === 'associated' ? '● ' : '◌ '}</span>
                  {c.state === 'associated' ? 'connected' : c.state}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  );
}

// ── Interfaces page ──────────────────────────────────────────────────────────

function InterfacesPage({ device }: { device: DeviceSnapshot }) {
  const management = wlcManagementInterface();
  const interfaces = wlcInterfaceFormsFrom(device.runningConfig);
  const users = wlansByInterface(wlanFormsFrom(device.runningConfig));
  /** Name of the interface in the editor; null = a new interface. */
  const [selected, setSelected] = useState<string | null>(management);
  /** Bumped whenever the user picks another interface: the editor reloads (a create keeps it, so its result stays shown). */
  const [session, setSession] = useState(0);
  const baseline = selected === null ? undefined : interfaces.find((i) => i.name === selected);
  const current = baseline ?? emptyWlcInterfaceForm(selected ?? '');
  const resetKey = `${device.id}|wlc-if|${session}`;
  const form = useSettingsForm<WlcInterfaceForm>(current, resetKey);
  const submit = useSubmitState(resetKey);
  const removal = useSubmitState(`${device.id}|wlc-if-remove`);
  const notReady = deviceNotReadyReason(device);
  const busy = submit.busy || removal.busy;
  const { draft } = form;
  const isNew = baseline === undefined;
  const isManagement = draft.name.trim() === management;

  const open = (name: string | null): void => {
    setSelected(name);
    setSession((n) => n + 1);
  };
  const edit = (name: string | null): void => {
    open(name);
    removal.clear();
  };
  const apply = (): void => {
    const next = form.draft;
    const ctx = wlcInterfaceContextOf(interfaces, baseline);
    void submit.run(() => applyWlcInterface(engine, device.id, next, baseline, ctx)).then((result) => {
      if (result?.outcome?.ok !== true) return;
      form.markApplied(next);
      if (isNew) setSelected(next.name.trim());
    });
  };
  const remove = (name: string): void => {
    void removal.run(() => removeWlcInterface(engine, device.id, name)).then((result) => {
      if (result?.outcome?.ok === true && selected === name) open(management);
    });
  };
  const set = (key: keyof WlcInterfaceForm) => (value: string) => form.update((d) => ({ ...d, [key]: value }));

  return (
    <>
      <section className="insp-section">
        <p className="insp-note">
          A controller interface ties a VLAN to an address on the controller. WLANs name an interface, and their clients
          reach the wired network in its VLAN. Access points join on the management interface.
        </p>
        <table className="table compact">
          <caption className="dim">Controller interfaces.</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">VLAN</th>
              <th scope="col">Address</th>
              <th scope="col">Gateway</th>
              <th scope="col">DHCP server</th>
              <th scope="col">Used by</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {interfaces.map((i) => {
              const used = users.get(i.name) ?? [];
              const fixed = i.name === management;
              return (
                <tr key={i.name}>
                  <th scope="row" className="mono">
                    {i.name}
                    {fixed && <span className="dim"> (built in)</span>}
                  </th>
                  <td className="mono">{i.vlan === '' ? '—' : i.vlan}</td>
                  <td className="mono">{i.address === '' ? 'none' : `${i.address} ${i.mask}`}</td>
                  <td className="mono">{i.gateway === '' ? '—' : i.gateway}</td>
                  <td className="mono">{i.dhcpServer === '' ? '—' : i.dhcpServer}</td>
                  <td>{used.length === 0 ? 'no WLAN' : `WLAN ${used.join(', ')}`}</td>
                  <td>
                    <button type="button" className="btn" aria-pressed={selected === i.name} aria-label={`Edit the interface ${i.name}`} onClick={() => edit(i.name)}>
                      Edit
                    </button>{' '}
                    {!fixed && (
                      <button
                        type="button"
                        className="btn"
                        disabled={busy || notReady !== undefined || used.length > 0}
                        title={used.length > 0 ? 'Point its WLANs at another interface first.' : undefined}
                        aria-label={`Remove the interface ${i.name}`}
                        onClick={() => remove(i.name)}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <ActionOutcome submit={removal} done="The interface was removed." />
        <div className="insp-actions">
          <button type="button" className="btn" aria-pressed={selected === null} onClick={() => edit(null)}>
            + Add an interface
          </button>
        </div>
      </section>

      <fieldset className="insp-section" disabled={busy} style={FIELDSET_STYLE}>
        <legend className="panel-title">{isNew ? 'New controller interface' : `Interface ${draft.name}`}</legend>
        <dl className="kv">
          {isNew ? (
            <TextInput label="Name" field="name" value={draft.name} submit={submit} hint="Letters, digits, dots, dashes or underscores, for example STAFF-IF." onChange={set('name')} />
          ) : (
            <>
              <dt>Name</dt>
              <dd className="mono">
                {draft.name}
                {isManagement && <span className="dim"> — the interface access points join on</span>}
                {fieldError(submit, 'name') !== undefined && (
                  <div role="alert" className="reason-box" style={{ borderLeftColor: 'var(--err)' }}>
                    <span aria-hidden="true">✖ </span>
                    {fieldError(submit, 'name')}
                  </div>
                )}
              </dd>
            </>
          )}
          <TextInput label="VLAN" field="vlan" value={draft.vlan} submit={submit} inputMode="numeric" hint="The controller adds this VLAN to its VLAN list." onChange={set('vlan')} />
          <TextInput label="Address" field="address" value={draft.address} submit={submit} placeholder="192.168.99.5" hint="Leave the address and mask empty for an interface without one." onChange={set('address')} />
          <TextInput label="Subnet mask" field="mask" value={draft.mask} submit={submit} placeholder="255.255.255.0 or /24" onChange={set('mask')} />
          <TextInput
            label="Gateway"
            field="gateway"
            value={draft.gateway}
            submit={submit}
            hint={isManagement ? 'The router of this subnet; it is also the default gateway of the controller.' : 'The router of this subnet (optional).'}
            onChange={set('gateway')}
          />
          <TextInput
            label="DHCP server"
            field="dhcpServer"
            value={draft.dhcpServer}
            submit={submit}
            hint="Recorded for the clients of this interface's WLANs. Their address requests are bridged into the VLAN, so a DHCP server or relay must serve it."
            onChange={set('dhcpServer')}
          />
        </dl>
      </fieldset>
      <SubmitBar
        submit={submit}
        form={form}
        canApply={notReady === undefined}
        disabledReason={notReady}
        onApply={apply}
        applyLabel={isNew ? 'Create the interface' : 'Save the interface'}
      />
    </>
  );
}

// ── WLANs page ───────────────────────────────────────────────────────────────

function WlansPage({ device }: { device: DeviceSnapshot }) {
  const interfaces = wlcInterfaceFormsFrom(device.runningConfig);
  const wlans = wlanFormsFrom(device.runningConfig);
  /** Number of the WLAN in the editor; null = a new WLAN. */
  const [selected, setSelected] = useState<string | null>(() => wlans[0]?.id ?? null);
  /** Bumped whenever the user picks another WLAN: the editor reloads (a save keeps it, so its result stays shown). */
  const [session, setSession] = useState(0);
  const baseline = selected === null ? undefined : wlans.find((w) => w.id === selected);
  const current = baseline ?? emptyWlanForm(nextFreeWlanId(wlans));
  const resetKey = `${device.id}|wlan|${session}`;
  const form = useSettingsForm<WlanForm>(current, resetKey);
  const submit = useSubmitState(resetKey);
  const removal = useSubmitState(`${device.id}|wlan-remove`);
  const notReady = deviceNotReadyReason(device);
  const busy = submit.busy || removal.busy;
  const { draft } = form;
  const isNew = baseline === undefined;
  const replaced = baseline !== undefined && !sameWlanIdentity(draft, baseline);
  const keepsPassphrase = draft.hasPassphrase && !replaced && !isNew && baseline?.security !== 'open';
  const ifaceNames = interfaces.map((i) => i.name);
  if (draft.iface !== '' && !ifaceNames.includes(draft.iface)) ifaceNames.push(draft.iface);

  const open = (id: string | null): void => {
    setSelected(id);
    setSession((n) => n + 1);
  };
  const edit = (id: string | null): void => {
    open(id);
    removal.clear();
  };
  const apply = (): void => {
    const next = form.draft;
    const ctx = wlanContextOf(wlans, interfaces, baseline);
    void submit.run(() => applyWlan(engine, device.id, next, baseline, ctx)).then((result) => {
      if (result?.outcome?.ok !== true) return;
      form.markApplied(appliedWlanForm(next));
      setSelected(next.id.trim());
    });
  };
  const remove = (id: string): void => {
    void removal.run(() => removeWlan(engine, device.id, id)).then((result) => {
      if (result?.outcome?.ok === true && selected === id) open(null);
    });
  };
  const set = (key: 'id' | 'profile' | 'ssid' | 'passphrase' | 'iface') => (value: string) => form.update((d) => ({ ...d, [key]: value }));

  return (
    <>
      <section className="insp-section">
        <p className="insp-note">
          A WLAN is a network the access points offer. Its clients reach the wired network through the controller
          interface it names, in that interface&apos;s VLAN.
        </p>
        <table className="table compact">
          <caption className="dim">WLANs of this controller.</caption>
          <thead>
            <tr>
              <th scope="col">WLAN</th>
              <th scope="col">Profile</th>
              <th scope="col">Network name</th>
              <th scope="col">Security</th>
              <th scope="col">Interface</th>
              <th scope="col">Radios</th>
              <th scope="col">Offered</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {wlans.length === 0 ? (
              <tr>
                <td colSpan={8}>No WLAN yet: access points offer no network until one is added.</td>
              </tr>
            ) : (
              wlans.map((w) => (
                <tr key={w.id}>
                  <th scope="row" className="mono">
                    {w.id}
                  </th>
                  <td className="mono">{w.profile}</td>
                  <td className="mono">{w.ssid}</td>
                  <td>{WIFI_SECURITY_LABELS[w.security]}</td>
                  <td className="mono">{w.iface}</td>
                  <td>{WLAN_RADIO_LABELS[w.radio]}</td>
                  <td>
                    <span aria-hidden="true">{w.enabled ? '● ' : '■ '}</span>
                    {w.enabled ? 'yes' : 'no (shut down)'}
                  </td>
                  <td>
                    <button type="button" className="btn" aria-pressed={selected === w.id} aria-label={`Edit WLAN ${w.id}`} onClick={() => edit(w.id)}>
                      Edit
                    </button>{' '}
                    <button type="button" className="btn" disabled={busy || notReady !== undefined} aria-label={`Remove WLAN ${w.id}`} onClick={() => remove(w.id)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <ActionOutcome submit={removal} done="The WLAN was removed." />
        <div className="insp-actions">
          <button type="button" className="btn" aria-pressed={selected === null} onClick={() => edit(null)}>
            + Add a WLAN
          </button>
        </div>
      </section>

      <fieldset className="insp-section" disabled={busy} style={FIELDSET_STYLE}>
        <legend className="panel-title">{isNew ? 'New WLAN' : `WLAN ${baseline?.id ?? draft.id}`}</legend>
        {replaced && (
          <div className="reason-box" role="status">
            <span aria-hidden="true">▲ </span>
            Changing the number, profile or network name replaces the WLAN: its clients reconnect, and the passphrase must
            be typed again.
          </div>
        )}
        <dl className="kv">
          <TextInput label="WLAN number" field="id" value={draft.id} submit={submit} inputMode="numeric" onChange={set('id')} />
          <TextInput label="Profile name" field="profile" value={draft.profile} submit={submit} hint="A name for this WLAN on the controller, for example STAFF." onChange={set('profile')} />
          <TextInput label="Network name (SSID)" field="ssid" value={draft.ssid} submit={submit} hint="What clients see: up to 32 characters, no spaces or colons." onChange={set('ssid')} />
          <SettingsField label="Security" error={fieldError(submit, 'security')}>
            {({ id, describedBy, invalid }) => (
              <select
                id={id}
                className="select"
                value={draft.security}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(e) => {
                  submit.clearField('security');
                  submit.clearField('passphrase');
                  form.update((d) => ({ ...d, security: e.target.value as WlanForm['security'] }));
                }}
              >
                {WIFI_SECURITY_MODES.map((m) => (
                  <option key={m} value={m}>
                    {WIFI_SECURITY_LABELS[m]}
                  </option>
                ))}
              </select>
            )}
          </SettingsField>
          {draft.security !== 'open' && (
            <SettingsField
              label="Passphrase"
              error={fieldError(submit, 'passphrase')}
              hint={keepsPassphrase ? 'A passphrase is stored; leave this empty to keep it.' : `8 to ${PASSPHRASE_MAX} characters, shared by every client.`}
            >
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  className="input"
                  type="password"
                  value={draft.passphrase}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  autoComplete="new-password"
                  onChange={(e) => {
                    submit.clearField('passphrase');
                    set('passphrase')(e.target.value);
                  }}
                />
              )}
            </SettingsField>
          )}
          <SettingsField label="Interface" error={fieldError(submit, 'iface')} hint="Its clients reach the wired network in this interface's VLAN.">
            {({ id, describedBy, invalid }) => (
              <select
                id={id}
                className="select"
                value={draft.iface}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(e) => {
                  submit.clearField('iface');
                  set('iface')(e.target.value);
                }}
              >
                {ifaceNames.map((name) => {
                  const i = interfaces.find((x) => x.name === name);
                  return (
                    <option key={name} value={name}>
                      {name}
                      {i !== undefined && i.vlan !== '' ? ` (VLAN ${i.vlan})` : ''}
                    </option>
                  );
                })}
              </select>
            )}
          </SettingsField>
          <SettingsField label="Radios" error={fieldError(submit, 'radio')}>
            {({ id, describedBy, invalid }) => (
              <select
                id={id}
                className="select"
                value={draft.radio}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(e) => {
                  submit.clearField('radio');
                  form.update((d) => ({ ...d, radio: e.target.value as WlanRadio }));
                }}
              >
                {WLAN_RADIOS.map((r) => (
                  <option key={r} value={r}>
                    {WLAN_RADIO_LABELS[r]}
                  </option>
                ))}
              </select>
            )}
          </SettingsField>
          <SettingsField label="Offered" error={fieldError(submit, 'enabled')} hint={draft.enabled ? undefined : 'A WLAN that is not offered disappears from every access point.'}>
            {({ id, describedBy, invalid }) => (
              <label htmlFor={id} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <input
                  id={id}
                  type="checkbox"
                  checked={draft.enabled}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  onChange={(e) => {
                    submit.clearField('enabled');
                    form.update((d) => ({ ...d, enabled: e.target.checked }));
                  }}
                />
                {draft.enabled ? 'Yes' : 'No'}
              </label>
            )}
          </SettingsField>
        </dl>
      </fieldset>
      <SubmitBar submit={submit} form={form} canApply={notReady === undefined} disabledReason={notReady} onApply={apply} applyLabel={isNew ? 'Create the WLAN' : 'Save the WLAN'} />
    </>
  );
}

// ── panel ────────────────────────────────────────────────────────────────────

/** Wireless controller panel (`wlc.controller`). `initialPage` overrides the page it opens on (tests, deep links). */
export function WlcPanel({ device, initialPage }: { device: DeviceSnapshot; initialPage?: WlcPage }) {
  const [page, setPage] = useState<WlcPage>(() => initialPage ?? initialWlcPage(device));
  const tabRefs = useRef(new Map<WlcPage, HTMLButtonElement>());
  const baseId = `wlc-${useId().replace(/:/g, '')}`;

  const onKey = useCallback(
    (e: KeyboardEvent<HTMLDivElement>): void => {
      const key = e.key === 'ArrowRight' ? 'next' : e.key === 'ArrowLeft' ? 'prev' : e.key === 'Home' ? 'first' : e.key === 'End' ? 'last' : undefined;
      if (key === undefined) return;
      e.preventDefault();
      const next = stepWlcPage(page, key);
      setPage(next);
      tabRefs.current.get(next)?.focus();
    },
    [page],
  );

  const aps = capwapApRows(device).length;
  const clients = wlanClientRows(device).length;
  const count = (p: WlcPage): string => (p === 'aps' ? ` (${aps})` : p === 'clients' ? ` (${clients})` : '');

  return (
    <div className="insp-body" aria-label={`Controller settings of ${device.name}`}>
      <div className="insp-tabs" role="tablist" aria-label={`${device.name} controller pages`} onKeyDown={onKey}>
        {WLC_PAGES.map((p) => (
          <button
            key={p}
            ref={(el) => {
              if (el) tabRefs.current.set(p, el);
              else tabRefs.current.delete(p);
            }}
            id={`${baseId}-tab-${p}`}
            type="button"
            role="tab"
            aria-selected={page === p}
            aria-controls={`${baseId}-page`}
            tabIndex={page === p ? 0 : -1}
            className={`tab${page === p ? ' is-active' : ''}`}
            onClick={() => setPage(p)}
          >
            {WLC_PAGE_LABELS[p]}
            {count(p)}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${baseId}-page`} aria-labelledby={`${baseId}-tab-${page}`}>
        {page === 'aps' && <AccessPointsPage device={device} onOpenInterfaces={() => setPage('interfaces')} />}
        {page === 'interfaces' && <InterfacesPage device={device} />}
        {page === 'wlans' && <WlansPage device={device} />}
        {page === 'clients' && <ClientsPage device={device} />}
      </div>
    </div>
  );
}
