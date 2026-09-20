/**
 * Port inspector: role, connector, encapsulation, carrier and line protocol, negotiation, serial clocking,
 * collision domain, radio state, addressing and counters, plus an enable/shut toggle. The toggle goes through
 * headless `configure` with the canonical lines of gui/commands.ts (`interface X` + `[no] shutdown`, or the host
 * shell's `adapter X up|down`), so the change lands in the running-config exactly as if it had been typed
 * (ARCHITECTURE-P1 D9, §3.12). Whether a port may be toggled comes from its role traits, never the device kind.
 */
import { Fragment, useState } from 'react';
import type { DeviceSnapshot, PortCounters, PortId, PortRef, PortSnapshot } from '@netforge/engine';
import { engine } from '../bridge/client';
import { portAdminCommands } from '../gui/commands';
import { deviceGrammar, mapConfigureResult } from '../gui/forms';
import { store, useStore } from '../store/store';
import { portKindLabel, portRoleLabel } from '../vocab/categories';
import { formatBps, formatSignal } from '../vocab/fields';
import { lineProtocolText } from '../vocab/media';
import { assocStateVocab } from '../vocab/trace-kinds';
import { toastError, useDeviceIndex } from './PacketInspector';
import {
  PHY_VIA_TEXT,
  RADIO_MODE_LABELS,
  RF_BAND_LABELS,
  associationOfStation,
  deviceById,
  formatDistance,
  linkById,
  portOf,
  portToggleState,
} from './tabs';
import './inspector.css';

// ── shared port helpers ─────────────────────────────────────────────────────

export function fmtBps(bps: number | undefined): string {
  return formatBps(bps);
}

export function portAddress(p: PortSnapshot): string | undefined {
  const a = p.l3.ipv4;
  return a ? `${a.address}/${a.prefixLen}` : undefined;
}

export interface PortStatus {
  cls: 'up' | 'down' | 'admin' | 'err' | 'off';
  glyph: string;
  text: string;
}

/** Glyph + text status of a port (the glyph shape is the non-colour channel). */
export function portStatus(p: PortSnapshot, device: Pick<DeviceSnapshot, 'power' | 'booted'>): PortStatus {
  if (!device.power) return { cls: 'off', glyph: '○', text: 'device off' };
  if (p.errDisabled) return { cls: 'err', glyph: '✖', text: 'err-disabled' };
  if (!p.adminUp) return { cls: 'admin', glyph: '■', text: 'admin down' };
  if (p.operUp) return { cls: 'up', glyph: '●', text: 'up' };
  if (!device.booted) return { cls: 'down', glyph: '▲', text: 'booting' };
  if (p.phy?.carrier === true) return { cls: 'down', glyph: '◐', text: 'up, line protocol down' };
  if (p.virtual === true) return { cls: 'down', glyph: '▲', text: 'down' };
  if (p.radio !== undefined) return { cls: 'down', glyph: '▲', text: 'down (no signal)' };
  return { cls: 'down', glyph: '▲', text: p.link ? 'down' : 'down (no cable)' };
}

export function PortLed({ status }: { status: PortStatus }) {
  return (
    <span className={`led ${status.cls}`}>
      <span className="dot" aria-hidden="true">
        {status.glyph}
      </span>
      {status.text}
    </span>
  );
}

/**
 * Enable or shut a port through headless configure. Rejects with the device's own message when a line is refused.
 */
export async function setPortEnabled(device: Pick<DeviceSnapshot, 'id' | 'cli'>, port: PortId, enabled: boolean): Promise<void> {
  const plan = portAdminCommands(deviceGrammar(device), port, enabled);
  if (typeof engine.configure !== 'function') {
    throw new Error('This build cannot apply settings from the inspector.');
  }
  const result = await engine.configure(device.id, [...plan.commands], plan.options);
  if (!result.ok) {
    const outcome = mapConfigureResult(plan, result);
    throw new Error(outcome.fieldErrors.enabled ?? outcome.general[0] ?? 'The device did not accept the change.');
  }
}

// ── component ───────────────────────────────────────────────────────────────

const COUNTER_ROWS: { label: string; rx?: keyof PortCounters; tx?: keyof PortCounters }[] = [
  { label: 'Packets', rx: 'inPackets', tx: 'outPackets' },
  { label: 'Bytes', rx: 'inBytes', tx: 'outBytes' },
  { label: 'Broadcasts', rx: 'inBroadcasts' },
  { label: 'Errors', rx: 'inErrors' },
  { label: 'CRC errors', rx: 'crcErrors' },
  { label: 'Runts', rx: 'runts' },
  { label: 'Giants', rx: 'giants' },
  { label: 'Collisions', tx: 'collisions' },
  { label: 'Late collisions', tx: 'lateCollisions' },
  { label: 'Excessive collisions', tx: 'excessiveCollisions' },
  { label: 'Deferred (waited for the wire)', tx: 'deferred' },
  { label: 'Radio retries', tx: 'txRetries' },
  { label: 'Drops', rx: 'inDrops', tx: 'outDrops' },
];

export function PortInspector({ port: ref }: { port: PortRef }) {
  const device = useStore((s) => deviceById(s, ref.device));
  const port = portOf(device, ref.port);
  if (!device || !port) {
    return (
      <div className="insp fill">
        <div className="empty-hint">That port is no longer part of the topology.</div>
      </div>
    );
  }
  return <PortDetails key={`${device.id}/${port.id}`} device={device} port={port} />;
}

function counterValue(counters: PortCounters, key: keyof PortCounters | undefined): string {
  if (key === undefined) return '—';
  return String(counters[key] ?? 0);
}

function PortDetails({ device, port }: { device: DeviceSnapshot; port: PortSnapshot }) {
  const [busy, setBusy] = useState(false);
  const devices = useDeviceIndex();
  const link = useStore((s) => linkById(s, port.link));
  const association = useStore((s) => (port.radio !== undefined ? associationOfStation(s.snapshot, { device: device.id, port: port.id }) : undefined));
  const segmentId = port.phy?.segment ?? link?.segment;
  const status = portStatus(port, device);
  const address = portAddress(port);
  const toggle = portToggleState(device, port);
  const select = (sel: Parameters<ReturnType<typeof store.getState>['select']>[0]): void => store.getState().select(sel);

  const onToggle = async (): Promise<void> => {
    const enable = !port.adminUp;
    setBusy(true);
    try {
      await setPortEnabled(device, port.id, enable);
      store.getState().toast(`${port.short} on ${device.name} is now ${enable ? 'enabled' : 'shut down'}.`, 'info');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  const peer = link ? (link.a.device === device.id && link.a.port === port.id ? link.b : link.a) : undefined;
  const peerDevice = peer ? devices.get(peer.device) : undefined;
  const role = port.role;
  const roleLabel = role !== undefined ? portRoleLabel(role, device.capabilities) : portKindLabel(port.kind);
  const otherRoles = (port.allowedRoles ?? []).filter((r) => r !== role);
  const phy = port.phy;
  const settings = port.phySettings;
  const radio = port.radio;
  const hasMac = port.encap === undefined || port.encap === 'ethernet' || port.encap === 'dot11';

  return (
    <div className="insp fill">
      <div className="insp-head">
        <div className="insp-title-row">
          <span className="insp-title" title={port.id}>
            {port.id}
          </span>
          <PortLed status={status} />
        </div>
        <div className="insp-sub">
          <span>
            on{' '}
            <button type="button" className="link-btn" onClick={() => select({ kind: 'device', id: device.id })}>
              {device.name}
            </button>
          </span>
          <span className="mono">{port.short}</span>
          <span>{roleLabel}</span>
        </div>
        <div className="insp-actions">
          <button
            type="button"
            className="btn"
            disabled={busy || !toggle.ok}
            title={toggle.ok ? undefined : toggle.reason}
            aria-describedby={toggle.ok ? undefined : `${device.id}-${port.id}-toggle-why`}
            onClick={() => void onToggle()}
          >
            {busy ? 'Applying…' : port.adminUp ? '■ Shut down' : '▶ Enable'}
          </button>
        </div>
        {!toggle.ok && (
          <div id={`${device.id}-${port.id}-toggle-why`} className="insp-note">
            {toggle.reason}
          </div>
        )}
      </div>
      <div className="insp-body">
        <section className="insp-section">
          <dl className="kv">
            <dt>Role</dt>
            <dd>
              {roleLabel}
              {otherRoles.length > 0 && (
                <div className="dim">
                  can also work as: {otherRoles.map((r) => portRoleLabel(r, device.capabilities)).join(', ')}
                  {otherRoles.includes('routed') ? ' ("no switchport")' : otherRoles.includes('switched') ? ' ("switchport")' : ''}
                </div>
              )}
            </dd>
            <dt>Type</dt>
            <dd>
              {portKindLabel(port.kind)}
              {port.connector !== undefined && port.connector !== 'none' && <span className="dim"> · {port.connector} socket</span>}
              {port.autoMdix === true && <span className="dim"> · auto-MDIX</span>}
              {port.wiring !== undefined && port.autoMdix !== true && <span className="dim"> · {port.wiring}</span>}
            </dd>
            {port.encap !== undefined && port.encap !== 'none' && (
              <>
                <dt>Encapsulation</dt>
                <dd className="mono">{port.encap}</dd>
              </>
            )}
            {hasMac && (
              <>
                <dt>MAC address</dt>
                <dd className="mono">{port.mac}</dd>
              </>
            )}
            <dt>Admin state</dt>
            <dd>{port.adminUp ? 'enabled' : 'shut down'}</dd>
            <dt>Carrier</dt>
            <dd>{phy ? (phy.carrier ? 'present' : 'none') : port.operUp ? 'present' : 'none'}</dd>
            <dt>Line protocol</dt>
            <dd>
              {port.operUp ? 'up' : 'down'}
              {phy?.lineProtocolReason !== undefined && !port.operUp && <div className="dim">{lineProtocolText(phy.lineProtocolReason)}</div>}
            </dd>
            {port.errDisabled && (
              <>
                <dt>Err-disabled</dt>
                <dd>{port.errDisabled}</dd>
              </>
            )}
            <dt>Speed / duplex</dt>
            <dd>
              {port.speedBps ? `${fmtBps(port.speedBps)}, ${port.duplex ?? '—'} duplex` : 'not negotiated (no link)'}
              {phy?.end !== undefined && <div className="dim">{PHY_VIA_TEXT[phy.end.via]}</div>}
              {phy?.duplexMismatch === true && <div className="dim">▲ duplex mismatch with the other end</div>}
            </dd>
            {settings !== undefined && (
              <>
                <dt>Configured</dt>
                <dd className="mono">
                  speed {settings.speed === 'auto' ? 'auto' : fmtBps(settings.speed)} · duplex {settings.duplex}
                  {settings.clockRateBps !== undefined && ` · clock rate ${settings.clockRateBps}`}
                </dd>
              </>
            )}
            {phy?.dce !== undefined && (
              <>
                <dt>Serial end</dt>
                <dd>{phy.dce ? 'DCE (supplies the clock)' : 'DTE (receives the clock)'}</dd>
              </>
            )}
            {segmentId !== undefined && (
              <>
                <dt>Shared segment</dt>
                <dd className="mono">{segmentId}</dd>
              </>
            )}
            <dt>MTU</dt>
            <dd className="mono">{port.mtu}</dd>
            {(port.l3.ipv4 !== undefined || port.l3.ipv6 === undefined) && (
              <>
                <dt>IPv4 address</dt>
                <dd className="mono">
                  {address ?? 'none'}
                  {port.l3.ipv4?.origin !== undefined && port.l3.ipv4.origin !== 'manual' && <span className="dim"> ({port.l3.ipv4.origin})</span>}
                </dd>
              </>
            )}
            {port.l3.ipv6 !== undefined && port.l3.ipv6.length > 0 && (
              <>
                <dt>IPv6 addresses</dt>
                <dd className="mono">
                  {port.l3.ipv6.map((a) => (
                    <div key={`${a.address}/${a.prefixLen}`}>
                      {a.address}/{a.prefixLen} <span className="dim">{a.scope}, {a.state}</span>
                    </div>
                  ))}
                </dd>
              </>
            )}
            {(port.slot !== undefined || port.module !== undefined) && (
              <>
                <dt>Module</dt>
                <dd>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => select({ kind: 'slot', device: device.id, slot: port.module?.slot ?? (port.slot as string) })}
                  >
                    slot {port.module?.slot ?? port.slot}
                  </button>
                  {port.module !== undefined && <span className="mono dim"> {port.module.module}</span>}
                </dd>
              </>
            )}
            {port.transceiver !== undefined && (
              <>
                <dt>Transceiver</dt>
                <dd className="mono">{port.transceiver}</dd>
              </>
            )}
            {port.poe !== undefined && (
              <>
                <dt>Power over Ethernet</dt>
                <dd>
                  {port.poe.pse !== undefined && `supplies up to ${port.poe.pse.maxW} W (802.3${port.poe.pse.standard})`}
                  {port.poe.pd !== undefined && `draws ${port.poe.pd.drawW} W (802.3${port.poe.pd.standard})`}
                </dd>
              </>
            )}
            {port.linkable !== false && radio === undefined && (
              <>
                <dt>Cable</dt>
                <dd>
                  {link ? (
                    <button type="button" className="link-btn" onClick={() => select({ kind: 'link', id: link.id })}>
                      {link.kind === 'radio' ? 'radio link' : 'cable'} {link.id}
                    </button>
                  ) : (
                    'not connected'
                  )}
                  {peer && (
                    <>
                      {' '}
                      to{' '}
                      <button type="button" className="link-btn" onClick={() => select({ kind: 'port', ref: peer })}>
                        {peerDevice?.name ?? peer.device} {portOf(peerDevice, peer.port)?.short ?? peer.port}
                      </button>
                    </>
                  )}
                </dd>
              </>
            )}
            <dt>Transmit queue</dt>
            <dd className="mono">
              {port.txQueue} frame{port.txQueue === 1 ? '' : 's'}
            </dd>
          </dl>
        </section>
        {radio !== undefined && (
          <section className="insp-section" aria-label="Radio">
            <div className="panel-title">Radio</div>
            <dl className="kv">
              <dt>Works as</dt>
              <dd>{RADIO_MODE_LABELS[radio.mode]}</dd>
              <dt>Band / channel</dt>
              <dd className="mono">
                {RF_BAND_LABELS[radio.band]}
                {radio.band !== 'cell' && ` · channel ${radio.channel} · ${radio.widthMhz} MHz`}
              </dd>
              <dt>Transmit power</dt>
              <dd className="mono">{radio.txPowerDbm} dBm</dd>
              {radio.ssid !== undefined && (
                <>
                  <dt>Network name</dt>
                  <dd className="mono">{radio.ssid}</dd>
                </>
              )}
              {radio.security !== undefined && (
                <>
                  <dt>Security</dt>
                  <dd className="mono">{radio.security}</dd>
                </>
              )}
              {radio.bssid !== undefined && (
                <>
                  <dt>BSSID</dt>
                  <dd className="mono">{radio.bssid}</dd>
                </>
              )}
              <dt>{radio.mode === 'ap' || radio.mode === 'tower' ? 'Operating' : 'Radio on'}</dt>
              <dd>{radio.up ? 'yes' : 'no'}</dd>
              {radio.clients !== undefined && (
                <>
                  <dt>Clients</dt>
                  <dd className="mono">{radio.clients}</dd>
                </>
              )}
              {radio.state !== undefined && (
                <>
                  <dt>Connection</dt>
                  <dd>
                    {assocStateVocab(radio.mode === 'ue' ? 'cellular' : 'wifi', radio.state)?.label ?? radio.state}
                    {association && (
                      <>
                        {' '}
                        <button type="button" className="link-btn" onClick={() => select({ kind: 'association', id: association.id })}>
                          details
                        </button>
                      </>
                    )}
                  </dd>
                </>
              )}
              {radio.rssiDbm !== undefined && (
                <>
                  <dt>Signal</dt>
                  <dd className="mono">{formatSignal(radio.rssiDbm, radio.bars ?? 0)}</dd>
                </>
              )}
              {radio.snrDb !== undefined && (
                <>
                  <dt>Signal to noise</dt>
                  <dd className="mono">{radio.snrDb} dB</dd>
                </>
              )}
              {radio.rateBps !== undefined && (
                <>
                  <dt>Rate</dt>
                  <dd className="mono">{fmtBps(radio.rateBps)}</dd>
                </>
              )}
              <dt>Range</dt>
              <dd className="mono">{formatDistance(radio.rangeM)}</dd>
            </dl>
          </section>
        )}
        <section className="insp-section">
          <table className="table compact">
            <thead>
              <tr>
                <th>Counter</th>
                <th className="num">Received</th>
                <th className="num">Sent</th>
              </tr>
            </thead>
            <tbody>
              {COUNTER_ROWS.map((row) => (
                <Fragment key={row.label}>
                  <tr>
                    <td>{row.label}</td>
                    <td className="num">{counterValue(port.counters, row.rx)}</td>
                    <td className="num">{counterValue(port.counters, row.tx)}</td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
