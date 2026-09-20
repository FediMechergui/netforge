/**
 * Desktop "Wi-Fi" app (ARCHITECTURE-P1 §7 Desktop tab, §3.6, §6 host shell expansions). Lists the wireless
 * networks the station daemon has heard (the `wlan-client` StateView candidates, strongest first, with signal
 * bars), shows the association state, and joins or leaves a network through `EngineApi.configure` with the
 * canonical lines from gui/commands `wifiClientCommands` (`wifi connect <ssid> [key <pass>]` on the host shell).
 *
 * "Scan" asks the station to refresh its list: `hostRequest({app:'wifi.scan'})` when the engine offers it,
 * otherwise the host shell's `wifi list` line (which issues the same scan request). Networks appear while the
 * simulation runs. The passphrase is never read back from the device. Wording is original (§1.6).
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { AssociationSnapshot, CliGrammar, DeviceSnapshot, PortSnapshot, RfBand, WifiAssocState, WifiSecurity } from '@netforge/engine';
import { engine } from '../../bridge/client';
import { useStore } from '../../store/store';
import { portAdminCommands, wifiClientCommands } from '../../gui/commands.js';
import { BAND_LABELS, WIFI_SECURITY_LABELS, deviceGrammar, hasErrors, validateWifiClientForm, wifiClientFormFrom } from '../../gui/forms.js';
import type { FormErrors, WifiClientForm } from '../../gui/forms.js';
import {
  DeviceGone,
  FormStatus,
  SignalBars,
  TextField,
  deviceBusyReason,
  errorText,
  formatRate,
  outcomeMessages,
  processPortRow,
  processState,
  signalBars,
  submitPlan,
  useDeviceById,
} from '../shared.js';
import type { DesktopAppProps } from '../shared.js';

/** Station daemon name (its StateView carries the scan candidates). */
export const WLAN_CLIENT = 'wlan-client';

/** One network in the list: every heard BSS with the same name and security, merged. */
export interface WifiNetwork {
  /** `${ssid}|${security}` */
  readonly key: string;
  readonly ssid: string;
  readonly security: WifiSecurity;
  /** Strongest level heard, if any BSS reported one. */
  readonly rssiDbm?: number;
  readonly bars: 0 | 1 | 2 | 3 | 4;
  readonly bands: readonly RfBand[];
  readonly channels: readonly number[];
  readonly bssids: readonly string[];
}

function isSecurity(v: unknown): v is WifiSecurity {
  return v === 'open' || v === 'wpa2-psk' || v === 'wpa3-sae';
}

/**
 * Networks from the station's candidate rows (`{ bssid, ssid, security, band?, channel?, rssiDbm? }`), merged by
 * name and security, strongest first (unknown levels last, then by name). Hidden networks (empty name) are left
 * out: they cannot be joined from a list.
 */
export function wifiNetworks(candidates: unknown): readonly WifiNetwork[] {
  if (!Array.isArray(candidates)) return [];
  const byKey = new Map<string, { ssid: string; security: WifiSecurity; rssi?: number; bands: RfBand[]; channels: number[]; bssids: string[]; first: number }>();
  candidates.forEach((raw, index) => {
    if (raw === null || typeof raw !== 'object') return;
    const c = raw as Record<string, unknown>;
    const ssid = c['ssid'];
    const bssid = c['bssid'];
    const security = c['security'];
    if (typeof ssid !== 'string' || ssid === '' || typeof bssid !== 'string' || !isSecurity(security)) return;
    const key = `${ssid}|${security}`;
    let entry = byKey.get(key);
    if (entry === undefined) {
      entry = { ssid, security, bands: [], channels: [], bssids: [], first: index };
      byKey.set(key, entry);
    }
    if (!entry.bssids.includes(bssid)) entry.bssids.push(bssid);
    const rssi = c['rssiDbm'];
    if (typeof rssi === 'number' && Number.isFinite(rssi) && (entry.rssi === undefined || rssi > entry.rssi)) entry.rssi = rssi;
    const band = c['band'];
    if (typeof band === 'string' && (band === '2.4' || band === '5' || band === '6' || band === '60') && !entry.bands.includes(band)) entry.bands.push(band);
    const channel = c['channel'];
    if (typeof channel === 'number' && !entry.channels.includes(channel)) entry.channels.push(channel);
  });
  const list = [...byKey.entries()].map(([key, e]) => {
    const net: WifiNetwork = { key, ssid: e.ssid, security: e.security, bars: signalBars(e.rssi), bands: Object.freeze(e.bands), channels: Object.freeze(e.channels), bssids: Object.freeze(e.bssids) };
    return { net: Object.freeze(e.rssi === undefined ? net : { ...net, rssiDbm: e.rssi }), first: e.first };
  });
  list.sort((a, b) => {
    const ra = a.net.rssiDbm;
    const rb = b.net.rssiDbm;
    if (ra !== undefined && rb !== undefined && ra !== rb) return rb - ra;
    if ((ra === undefined) !== (rb === undefined)) return ra === undefined ? 1 : -1;
    return a.first - b.first;
  });
  return Object.freeze(list.map((x) => x.net));
}

/** The Wi-Fi station adapter of a device: a wlan port in the wireless-client role (radio mode station). */
export function stationPort(device: Pick<DeviceSnapshot, 'ports'>): PortSnapshot | undefined {
  return device.ports.find((p) => p.kind === 'wlan' && (p.role === 'wireless-client' || p.radio?.mode === 'station'));
}

const FAILURE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'wrong-key': 'The password was not accepted.',
  'no-bss': 'No access point with this name answered.',
  'out-of-range': 'The network is out of range.',
  'bss-down': 'The access point stopped its network.',
  'ap-full': 'The access point has no room for another device.',
  rejected: 'The access point refused the connection.',
  timeout: 'The access point stopped answering.',
  'handshake-timeout': 'The security check did not finish in time.',
});

/** Sentence for the station state (glyph + words). */
export function stationStateText(state: WifiAssocState | undefined, ssid: string, reason?: string): { glyph: string; text: string } {
  const name = ssid === '' ? 'the network' : `“${ssid}”`;
  switch (state) {
    case 'scanning':
      return { glyph: '…', text: `Looking for ${name}.` };
    case 'authenticating':
    case 'associating':
      return { glyph: '…', text: `Joining ${name}.` };
    case 'handshake':
      return { glyph: '…', text: `Checking the password for ${name}.` };
    case 'associated':
      return { glyph: '✓', text: `Connected to ${name}.` };
    case 'failed':
      return { glyph: '✕', text: `Could not join ${name}. ${(reason !== undefined ? FAILURE_TEXT[reason] : undefined) ?? 'Trying again shortly.'}` };
    case 'idle':
    case undefined:
      return ssid === '' ? { glyph: '○', text: 'Not connected to a wireless network.' } : { glyph: '…', text: `Waiting to join ${name}.` };
  }
}

/**
 * Ask the station to refresh its network list. Uses `hostRequest` when the engine supports it; host-shell devices
 * fall back to the `wifi list` line, which issues the same scan request.
 */
export async function requestScan(deviceId: string, port: string, grammar: CliGrammar): Promise<void> {
  try {
    await engine.hostRequest(deviceId, { app: 'wifi.scan', port });
    return;
  } catch (err) {
    if (grammar !== 'host') throw err;
  }
  const result = await engine.configure(deviceId, ['wifi list'], { stopOnError: true });
  if (!result.ok) {
    const line = result.lines[0];
    throw new Error(line?.error?.message.replace(/^%\s*/, '') ?? 'The device could not look for networks.');
  }
}

export function WifiApp({ deviceId }: DesktopAppProps) {
  const device = useDeviceById(deviceId);
  if (device === undefined) return <DeviceGone />;
  const port = stationPort(device);
  if (port === undefined) return <p className="desk-empty">This device has no Wi-Fi adapter.</p>;
  return <WifiPanel device={device} port={port} />;
}

function WifiPanel({ device, port }: { device: DeviceSnapshot; port: PortSnapshot }) {
  const uid = useId();
  const grammar = deviceGrammar(device);
  const playing = useStore((s) => s.playing);
  const association = useStore((s) => findAssociation(s.snapshot?.media?.associations, device.id, port.id));
  const current = wifiClientFormFrom(device, port.id);
  const row = processPortRow(processState(device, WLAN_CLIENT), port.id);
  const networks = wifiNetworks(row?.['candidates']);
  const state = row?.['state'] as WifiAssocState | undefined;
  const reason = typeof row?.['reason'] === 'string' ? (row['reason'] as string) : undefined;
  const blocked = deviceBusyReason(device);

  const [chosen, setChosen] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const [messages, setMessages] = useState<readonly string[]>([]);
  const [ok, setOk] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);

  // A scan the user asked for reports failures; the automatic one on opening stays quiet (the station keeps
  // rescanning by itself). Results arriving after the window closed are ignored.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const scan = useCallback(
    async (quiet: boolean): Promise<void> => {
      setScanning(true);
      try {
        await requestScan(device.id, port.id, grammar);
      } catch (err) {
        if (!quiet && mounted.current) {
          setOk(false);
          setMessages([`Could not look for networks: ${errorText(err)}`]);
        }
      } finally {
        if (mounted.current) setScanning(false);
      }
    },
    [device.id, port.id, grammar],
  );

  // One refresh when the app opens on a running, enabled adapter.
  const scannedOnce = useRef(false);
  const canScan = blocked === undefined && port.adminUp;
  useEffect(() => {
    if (scannedOnce.current || !canScan) return;
    scannedOnce.current = true;
    void scan(true);
  }, [canScan, scan]);

  const pick = (key: string): void => {
    setChosen((c) => (c === key ? null : key));
    setPassphrase('');
    setErrors({});
    setMessages([]);
    setOk(null);
  };

  const join = async (net: WifiNetwork): Promise<void> => {
    const next: WifiClientForm = { port: port.id, ssid: net.ssid, security: net.security, passphrase, hasPassphrase: current.hasPassphrase };
    const found = validateWifiClientForm(next, grammar, current);
    setErrors(found);
    if (hasErrors(found)) {
      setOk(false);
      setMessages([]);
      return;
    }
    let plan;
    try {
      plan = wifiClientCommands(grammar, next, current);
    } catch (err) {
      setOk(false);
      setMessages([errorText(err)]);
      return;
    }
    if (plan.lines.length === 0) {
      setOk(true);
      setMessages([`Already set to join “${net.ssid}”.`]);
      return;
    }
    setBusy(true);
    const outcome = await submitPlan(device.id, plan);
    setBusy(false);
    setErrors(outcome.fieldErrors);
    setOk(outcome.ok);
    if (outcome.ok) {
      setPassphrase('');
      setChosen(null);
      setMessages([`Joining “${net.ssid}”. The state above shows when the connection is ready${playing ? '' : ' (start the simulation to let it happen)'}.`]);
    } else {
      setMessages(outcomeMessages(outcome));
    }
  };

  const leave = async (): Promise<void> => {
    const plan = wifiClientCommands(grammar, { ...current, ssid: '', passphrase: '' }, current);
    setBusy(true);
    const outcome = await submitPlan(device.id, plan);
    setBusy(false);
    setOk(outcome.ok);
    setMessages(outcome.ok ? ['Disconnected.'] : outcomeMessages(outcome));
  };

  const enable = async (): Promise<void> => {
    setBusy(true);
    const outcome = await submitPlan(device.id, portAdminCommands(grammar, port.id, true));
    setBusy(false);
    setOk(outcome.ok);
    setMessages(outcome.ok ? [`${port.id} enabled.`] : outcomeMessages(outcome));
  };

  const status = stationStateText(state ?? (association?.state as WifiAssocState | undefined), current.ssid, reason);

  return (
    <div className="desk-app">
      <section aria-labelledby={`${uid}-status`}>
        <h3 id={`${uid}-status`} className="desk-heading">
          {port.id}
        </h3>
        <p className="desk-state" role="status">
          <span aria-hidden="true">{status.glyph} </span>
          {port.adminUp ? status.text : 'The Wi-Fi adapter is disabled.'}
        </p>
        {association !== undefined && association.authorized && (
          <p className="desk-signal">
            <SignalBars bars={association.bars} />
            <span>
              {association.rssiDbm} dBm · {formatRate(association.rateBps)} · {BAND_LABELS[association.band as keyof typeof BAND_LABELS] ?? association.band} channel {association.channel}
            </span>
          </p>
        )}
        {port.l3.ipv4 !== undefined && (
          <p className="desk-sub">
            Address <span className="desk-mono">{`${port.l3.ipv4.address}/${port.l3.ipv4.prefixLen}`}</span>
          </p>
        )}
        <div className="desk-actions">
          {!port.adminUp && (
            <button type="button" className="btn btn-primary" disabled={busy || blocked !== undefined} onClick={() => void enable()}>
              Enable Wi-Fi
            </button>
          )}
          {current.ssid !== '' && (
            <button type="button" className="btn" disabled={busy || blocked !== undefined} onClick={() => void leave()}>
              Disconnect
            </button>
          )}
          <button type="button" className="btn" disabled={scanning || !canScan} onClick={() => void scan(false)}>
            {scanning ? 'Scanning…' : 'Scan'}
          </button>
        </div>
        {blocked !== undefined && <p className="desk-note">{blocked}</p>}
      </section>

      <section aria-labelledby={`${uid}-list`}>
        <h3 id={`${uid}-list`} className="desk-heading">
          Networks in range
        </h3>
        {networks.length === 0 ? (
          <p className="desk-empty">
            {playing ? 'No networks heard yet. Scan again in a moment.' : 'No networks heard yet. Start the simulation, then scan.'}
          </p>
        ) : (
          <ul className="desk-list" aria-label="Wireless networks">
            {networks.map((net) => {
              const open = chosen === net.key;
              const joined = current.ssid === net.ssid && current.security === net.security;
              const needsKey = net.security !== 'open';
              return (
                <li key={net.key} className={`desk-net ${open ? 'is-open' : ''}`}>
                  <button type="button" className="desk-net-row" aria-expanded={open} onClick={() => pick(net.key)}>
                    <SignalBars bars={net.bars} label={net.rssiDbm !== undefined ? `Signal ${net.bars} of 4, ${net.rssiDbm} dBm` : 'Signal not measured'} />
                    <span className="desk-net-name">{net.ssid}</span>
                    <span className="desk-net-meta">
                      {WIFI_SECURITY_LABELS[net.security]}
                      {net.bands.length > 0 ? ` · ${net.bands.map((b) => `${b} GHz`).join(', ')}` : ''}
                    </span>
                    {joined && <span className="desk-tag">chosen</span>}
                  </button>
                  {open && (
                    <form
                      className="desk-form desk-net-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (!busy) void join(net);
                      }}
                    >
                      {needsKey && (
                        <TextField
                          id={`${uid}-${net.key}-pass`}
                          label="Password"
                          type="password"
                          autoComplete="new-password"
                          value={passphrase}
                          error={errors['passphrase']}
                          hint={joined && current.hasPassphrase && grammar !== 'host' ? 'Leave empty to keep the saved password.' : '8 to 63 characters.'}
                          onChange={(v) => {
                            setPassphrase(v);
                            setErrors({});
                          }}
                        />
                      )}
                      {errors['ssid'] !== undefined && (
                        <p className="desk-error" role="alert">
                          <span aria-hidden="true">⚠ </span>
                          {errors['ssid']}
                        </p>
                      )}
                      {errors['security'] !== undefined && (
                        <p className="desk-error" role="alert">
                          <span aria-hidden="true">⚠ </span>
                          {errors['security']}
                        </p>
                      )}
                      <div className="desk-actions">
                        <button type="submit" className="btn btn-primary" disabled={busy || blocked !== undefined}>
                          {busy ? 'Joining…' : 'Connect'}
                        </button>
                        <button type="button" className="btn" onClick={() => pick(net.key)}>
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <FormStatus ok={ok} messages={messages} />
    </div>
  );
}

function findAssociation(list: readonly AssociationSnapshot[] | undefined, device: string, port: string): AssociationSnapshot | undefined {
  if (list === undefined) return undefined;
  return list.find((a) => a.tech === 'wifi' && a.station.device === device && a.station.port === port);
}
