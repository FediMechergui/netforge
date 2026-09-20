/**
 * Association inspector (selection `{kind:'association', id}`; ARCHITECTURE-P1 §3.6, §3.8, §7): one Wi-Fi
 * association or cellular attachment from `SimSnapshot.media.associations`. Shows the phase ladder (scan → auth →
 * join → keys → connected, or search → attach → attached), both ends, network name, BSSID, band and channel,
 * security, signal (bars + dBm), signal-to-noise, rate with the MCS that produces it, distance, time connected and
 * the RF hold countdown when the signal has dropped below the threshold. Every value has a text channel; the bar
 * meter repeats the bar count in words.
 */
import type { AssociationSnapshot, DeviceId, PortRef } from '@netforge/engine';
import { store, useStore } from '../store/store';
import { formatBps, formatDurationNs } from '../vocab/fields';
import { assocStateVocab } from '../vocab/trace-kinds';
import { useTickNow } from './TablesView';
import {
  RF_BAND_LABELS,
  WIFI_SECURITY_TEXT,
  assocPhaseSteps,
  associationById,
  bssById,
  cellById,
  deviceById,
  formatDistance,
  formatMcs,
  holdRemainingNs,
  identifyMcs,
  portOf,
} from './tabs';
import './inspector.css';

const BAR_HEIGHTS = [4, 7, 10, 13] as const;

/** Four-bar signal meter; the count is also given as text and through the meter role. */
export function BarsMeter({ bars, label }: { bars: number; label: string }) {
  const n = Math.max(0, Math.min(4, Math.round(bars)));
  return (
    <span role="meter" aria-valuemin={0} aria-valuemax={4} aria-valuenow={n} aria-label={label} style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 2, marginRight: 6 }}>
      <svg width="22" height="14" viewBox="0 0 22 14" aria-hidden="true">
        {BAR_HEIGHTS.map((h, i) => (
          <rect
            key={h}
            x={i * 5 + 1}
            y={14 - h}
            width={4}
            height={h}
            rx={0.5}
            fill={i < n ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth={0.8}
          />
        ))}
      </svg>
      <span>
        {n}/4
      </span>
    </span>
  );
}

function PortButton({ refTo, names }: { refTo: PortRef; names: (id: DeviceId) => { device: string; port: string } }) {
  const n = names(refTo.device);
  return (
    <button type="button" className="link-btn" onClick={() => store.getState().select({ kind: 'port', ref: refTo })}>
      {n.device} {n.port}
    </button>
  );
}

export function AssociationInspector({ id }: { id: string }) {
  const assoc = useStore((s) => associationById(s.snapshot, id));
  if (assoc === undefined) {
    return (
      <div className="insp fill">
        <div className="empty-hint">That wireless connection has ended; it is no longer part of the simulation.</div>
      </div>
    );
  }
  return <AssociationDetails assoc={assoc} />;
}

function AssociationDetails({ assoc }: { assoc: AssociationSnapshot }) {
  const now = useTickNow();
  const station = useStore((s) => deviceById(s, assoc.station.device));
  const ap = useStore((s) => (assoc.ap !== undefined ? deviceById(s, assoc.ap.device) : undefined));
  const bss = useStore((s) => (assoc.tech === 'wifi' ? bssById(s.snapshot, assoc.medium) : undefined));
  const cell = useStore((s) => (assoc.tech === 'cellular' ? cellById(s.snapshot, assoc.medium) : undefined));

  const wifi = assoc.tech === 'wifi';
  const phase = assocStateVocab(assoc.tech, assoc.state);
  const steps = assocPhaseSteps(assoc.tech, assoc.state);
  const hold = holdRemainingNs(assoc, now);
  const mcs = identifyMcs(assoc.band, assoc.rateBps, bss?.widthMhz);
  const connected = assoc.state === 'associated' || assoc.state === 'attached';
  const title = wifi ? 'Wi-Fi connection' : 'Mobile network attachment';

  const names = (dev: DeviceId): { device: string; port: string } => {
    const d = dev === station?.id ? station : dev === ap?.id ? ap : undefined;
    const ref = dev === assoc.station.device ? assoc.station : assoc.ap;
    return { device: d?.name ?? dev, port: portOf(d, ref?.port)?.short ?? ref?.port ?? '' };
  };

  return (
    <div className="insp fill">
      <div className="insp-head">
        <div className="insp-title-row">
          <span className="insp-title">{title}</span>
          <span className={`led ${connected ? 'up' : assoc.state === 'failed' || assoc.state === 'detached' ? 'err' : 'down'}`}>
            <span className="dot" aria-hidden="true">
              {phase?.badge ?? '?'}
            </span>
            {phase?.label ?? assoc.state}
          </span>
        </div>
        <div className="insp-sub">
          <span>
            <PortButton refTo={assoc.station} names={names} />
          </span>
          {assoc.ap !== undefined && (
            <span>
              {wifi ? 'to' : 'via'} <PortButton refTo={assoc.ap} names={names} />
            </span>
          )}
          {assoc.ssid !== undefined && <span className="mono">“{assoc.ssid}”</span>}
        </div>
      </div>
      <div className="insp-body">
        <section className="insp-section" aria-label="Connection steps">
          <div className="panel-title">Steps</div>
          <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {steps.map((st) => (
              <li
                key={st.state}
                aria-current={st.status === 'current' ? 'step' : undefined}
                style={{ opacity: st.status === 'todo' ? 0.6 : 1, fontWeight: st.status === 'current' ? 600 : 400 }}
              >
                <span aria-hidden="true" className="mono" style={{ display: 'inline-block', width: '1.5em' }}>
                  {st.mark}
                </span>
                {assocStateVocab(assoc.tech, st.state)?.label ?? st.state}
                <span className="dim"> — {st.status === 'done' ? 'done' : st.status === 'current' ? 'in progress' : 'not reached'}</span>
              </li>
            ))}
          </ol>
          {(assoc.state === 'failed' || assoc.state === 'detached' || assoc.state === 'idle') && (
            <div className="reason-box">
              ✖ {phase?.label ?? assoc.state}
              {assoc.reason !== undefined && <span className="mono"> ({assoc.reason})</span>}
            </div>
          )}
          {hold !== undefined && (
            <div className="reason-box" role="status">
              ▲ The signal is below the drop threshold. The connection is kept for {formatDurationNs(hold)} more in case it
              recovers.
            </div>
          )}
        </section>
        <section className="insp-section">
          <dl className="kv">
            {assoc.ssid !== undefined && (
              <>
                <dt>Network name</dt>
                <dd className="mono">{assoc.ssid}</dd>
              </>
            )}
            {assoc.bssid !== undefined && (
              <>
                <dt>BSSID</dt>
                <dd className="mono">{assoc.bssid}</dd>
              </>
            )}
            <dt>Band / channel</dt>
            <dd className="mono">
              {RF_BAND_LABELS[assoc.band]}
              {assoc.band !== 'cell' && ` · channel ${assoc.channel}`}
              {bss !== undefined && ` · ${bss.widthMhz} MHz`}
            </dd>
            {bss !== undefined && (
              <>
                <dt>Security</dt>
                <dd>{WIFI_SECURITY_TEXT[bss.security]}</dd>
              </>
            )}
            {wifi && (
              <>
                <dt>Authorized</dt>
                <dd>{assoc.authorized ? '✓ yes, data may flow' : '✗ not yet, only setup frames flow'}</dd>
              </>
            )}
            {assoc.aid !== undefined && (
              <>
                <dt>Association id</dt>
                <dd className="mono">{assoc.aid}</dd>
              </>
            )}
            <dt>Signal</dt>
            <dd>
              <BarsMeter bars={assoc.bars} label={`Signal strength ${assoc.bars} of 4 bars`} />
              <span className="mono">{assoc.rssiDbm} dBm</span>
            </dd>
            <dt>Signal to noise</dt>
            <dd className="mono">{assoc.snrDb} dB</dd>
            <dt>Rate</dt>
            <dd>
              <span className="mono">{assoc.rateBps > 0 ? formatBps(assoc.rateBps) : 'none (no usable modulation)'}</span>
              {mcs !== undefined && <div className="dim mono">{formatMcs(mcs)}</div>}
            </dd>
            <dt>Distance</dt>
            <dd className="mono">{formatDistance(assoc.distanceM)}</dd>
            <dt>{connected ? 'Connected for' : 'In this phase for'}</dt>
            <dd className="mono">{formatDurationNs(Math.max(0, now - assoc.since))}</dd>
            {bss !== undefined && (
              <>
                <dt>Airtime</dt>
                <dd>
                  {bss.contention.length === 0
                    ? 'not shared with other networks'
                    : `shared with ${bss.contention.length} other network${bss.contention.length === 1 ? '' : 's'} on this channel`}
                </dd>
              </>
            )}
            {cell !== undefined && (
              <>
                <dt>Tower</dt>
                <dd>
                  {cell.up ? 'operating' : 'off the air'} · {cell.ues} device{cell.ues === 1 ? '' : 's'} attached · reach{' '}
                  {formatDistance(cell.rangeM)}
                </dd>
              </>
            )}
            <dt>Medium</dt>
            <dd className="mono">{assoc.medium}</dd>
          </dl>
        </section>
      </div>
    </div>
  );
}
