/**
 * Link inspector (ARCHITECTURE-P1 §3.4, §3.5, §3.7, §3.9, §7): endpoints, media with its badge, length or radio
 * distance, state with plain-language wording from vocab/media.ts, carrier versus line protocol, the serial DCE end,
 * per-end negotiation (and duplex mismatch), the shared segment a cable belongs to (members with their collision and
 * deferral counters), PtP radio detail (band, channel, signal, SNR, rate and MCS), impairment sliders (debounced to
 * engine.setImpairments) and a disconnect action. Every state has a glyph + text channel.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeviceId, DeviceSnapshot, Impairments, LinkId, LinkSnapshot, PhyEndView, PortRef, SegmentSnapshot } from '@netforge/engine';
import { engine } from '../bridge/client';
import { store, useStore } from '../store/store';
import { lineProtocolText, linkDownText, mediaBadge, mediaName } from '../vocab/media';
import type { LinkDownText } from '../vocab/media';
import { BarsMeter } from './AssociationInspector';
import { deviceName, portShort, toastError, useDeviceIndex } from './PacketInspector';
import { fmtBps } from './PortInspector';
import { PHY_VIA_TEXT, RF_BAND_LABELS, formatDistance, formatMcs, identifyMcs, linkById, segmentById } from './tabs';
import './inspector.css';

type Index = ReadonlyMap<DeviceId, DeviceSnapshot>;

function endLabel(index: Index, ref: PortRef): string {
  return `${portShort(index, ref.device, ref.port)} on ${deviceName(index, ref.device)}`;
}

/** Wording of `LinkState.downReason` with the device and port names of this link filled in. */
export function linkDownWording(reason: string | undefined, link: LinkSnapshot, index: Index): LinkDownText {
  return linkDownText(reason, {
    deviceA: deviceName(index, link.a.device),
    deviceB: deviceName(index, link.b.device),
    endA: endLabel(index, link.a),
    endB: endLabel(index, link.b),
    lengthM: link.lengthM,
  });
}

/** Plain-language explanation of `LinkState.downReason`. */
export function explainDownReason(reason: string, link: LinkSnapshot, index: Index): string {
  return linkDownWording(reason, link, index).explain;
}

/** Title of a link: PtP radio links are not cables. */
export function linkTitle(link: Pick<LinkSnapshot, 'kind' | 'id'>): string {
  return `${link.kind === 'radio' ? 'Radio link' : 'Cable'} ${link.id}`;
}

/** Glyph + text of a link's state (carrier without line protocol is its own state). */
export function linkStateText(link: Pick<LinkSnapshot, 'up' | 'carrier'>): { cls: 'up' | 'down' | 'admin'; glyph: string; text: string } {
  if (link.up) return { cls: 'up', glyph: '●', text: 'up' };
  if (link.carrier === true) return { cls: 'admin', glyph: '◐', text: 'carrier, line protocol down' };
  return { cls: 'down', glyph: '▲', text: 'down' };
}

// ── impairments ─────────────────────────────────────────────────────────────

const BANDWIDTH_PRESETS: readonly (number | undefined)[] = [
  undefined,
  64_000,
  256_000,
  1_000_000,
  2_000_000,
  10_000_000,
  100_000_000,
  1_000_000_000,
];

interface DraftImp {
  lossPct: number;
  corruptPct: number;
  latencyMs: number;
  jitterMs: number;
  bandwidthIndex: number;
}

function toDraft(imp: Impairments): DraftImp {
  let bandwidthIndex = 0;
  if (imp.bandwidthBps !== undefined) {
    let best = 1;
    BANDWIDTH_PRESETS.forEach((v, i) => {
      const cur = BANDWIDTH_PRESETS[best];
      if (v !== undefined && cur !== undefined && Math.abs(v - imp.bandwidthBps!) < Math.abs(cur - imp.bandwidthBps!)) best = i;
    });
    bandwidthIndex = best;
  }
  return {
    lossPct: imp.lossPct,
    corruptPct: imp.corruptPct,
    latencyMs: Math.round(imp.latencyNs / 1_000_000),
    jitterMs: Math.round(imp.jitterNs / 1_000_000),
    bandwidthIndex,
  };
}

const DEBOUNCE_MS = 180;

function ImpairmentEditor({ link }: { link: LinkSnapshot }) {
  const imp = link.impairments;
  const linkId = link.id;
  const [draft, setDraft] = useState<DraftImp>(() => toDraft(imp));
  const pending = useRef<Partial<Impairments>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flush = useCallback(() => {
    timer.current = undefined;
    const patch = pending.current;
    pending.current = {};
    if (Object.keys(patch).length === 0) return;
    engine.setImpairments(linkId, patch).catch(toastError);
  }, [linkId]);

  // Mirror engine values while the user is not mid-edit.
  const { lossPct, corruptPct, latencyNs, jitterNs, bandwidthBps } = imp;
  useEffect(() => {
    if (timer.current === undefined) setDraft(toDraft({ lossPct, corruptPct, latencyNs, jitterNs, bandwidthBps }));
  }, [lossPct, corruptPct, latencyNs, jitterNs, bandwidthBps]);

  // Never lose an edit: flush on unmount.
  useEffect(
    () => () => {
      if (timer.current !== undefined) {
        clearTimeout(timer.current);
        flush();
      }
    },
    [flush],
  );

  const change = (next: Partial<DraftImp>, patch: Partial<Impairments>): void => {
    setDraft((d) => ({ ...d, ...next }));
    Object.assign(pending.current, patch);
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = setTimeout(flush, DEBOUNCE_MS);
  };

  const bw = BANDWIDTH_PRESETS[draft.bandwidthIndex];
  const anyImpairment =
    draft.lossPct > 0 || draft.corruptPct > 0 || draft.latencyMs > 0 || draft.jitterMs > 0 || bw !== undefined;

  return (
    <section className="insp-section">
      <div className="panel-title">Impairments</div>
      <div className="slider-row">
        <label htmlFor={`${linkId}-loss`}>Loss</label>
        <input
          id={`${linkId}-loss`}
          type="range"
          min={0}
          max={100}
          step={0.5}
          value={draft.lossPct}
          onChange={(e) => {
            const v = Number(e.target.value);
            change({ lossPct: v }, { lossPct: v });
          }}
        />
        <span className="val">{draft.lossPct}%</span>
      </div>
      <div className="slider-row">
        <label htmlFor={`${linkId}-corrupt`}>Corruption</label>
        <input
          id={`${linkId}-corrupt`}
          type="range"
          min={0}
          max={100}
          step={0.5}
          value={draft.corruptPct}
          onChange={(e) => {
            const v = Number(e.target.value);
            change({ corruptPct: v }, { corruptPct: v });
          }}
        />
        <span className="val">{draft.corruptPct}%</span>
      </div>
      <div className="slider-row">
        <label htmlFor={`${linkId}-latency`}>Latency</label>
        <input
          id={`${linkId}-latency`}
          type="range"
          min={0}
          max={1000}
          step={1}
          value={draft.latencyMs}
          onChange={(e) => {
            const v = Number(e.target.value);
            change({ latencyMs: v }, { latencyNs: v * 1_000_000 });
          }}
        />
        <span className="val">{draft.latencyMs} ms</span>
      </div>
      <div className="slider-row">
        <label htmlFor={`${linkId}-jitter`}>Jitter</label>
        <input
          id={`${linkId}-jitter`}
          type="range"
          min={0}
          max={200}
          step={1}
          value={draft.jitterMs}
          onChange={(e) => {
            const v = Number(e.target.value);
            change({ jitterMs: v }, { jitterNs: v * 1_000_000 });
          }}
        />
        <span className="val">±{draft.jitterMs} ms</span>
      </div>
      <div className="slider-row">
        <label htmlFor={`${linkId}-bw`}>Bandwidth</label>
        <input
          id={`${linkId}-bw`}
          type="range"
          min={0}
          max={BANDWIDTH_PRESETS.length - 1}
          step={1}
          value={draft.bandwidthIndex}
          onChange={(e) => {
            const i = Number(e.target.value);
            change({ bandwidthIndex: i }, { bandwidthBps: BANDWIDTH_PRESETS[i] });
          }}
        />
        <span className="val">{bw === undefined ? 'no cap' : fmtBps(bw)}</span>
      </div>
      <div className="insp-actions">
        <button
          type="button"
          className="btn"
          disabled={!anyImpairment}
          onClick={() =>
            change(
              { lossPct: 0, corruptPct: 0, latencyMs: 0, jitterMs: 0, bandwidthIndex: 0 },
              { lossPct: 0, corruptPct: 0, latencyNs: 0, jitterNs: 0, bandwidthBps: undefined },
            )
          }
        >
          ↺ Clear impairments
        </button>
      </div>
    </section>
  );
}

// ── detail sections ─────────────────────────────────────────────────────────

function phyEndText(end: PhyEndView): string {
  return `${fmtBps(end.speedBps)} ${end.duplex} duplex — ${PHY_VIA_TEXT[end.via]}`;
}

function NegotiationSection({ link, index }: { link: LinkSnapshot; index: Index }) {
  const phy = link.phy;
  if (phy === undefined) return null;
  return (
    <section className="insp-section" aria-label="Negotiation">
      <div className="panel-title">Negotiation</div>
      <dl className="kv">
        <dt>{endLabel(index, link.a)}</dt>
        <dd>{phyEndText(phy.a)}</dd>
        <dt>{endLabel(index, link.b)}</dt>
        <dd>{phyEndText(phy.b)}</dd>
      </dl>
      {phy.mismatch === 'duplex' && (
        <div className="reason-box">
          ▲ Duplex mismatch: one end sends whenever it likes while the other waits its turn, so frames collide late and
          arrive damaged.
        </div>
      )}
    </section>
  );
}

const SEGMENT_WARNING_TEXT: Readonly<Record<NonNullable<SegmentSnapshot['warnings']>[number], string>> = Object.freeze({
  'coax-segment-too-long': 'The coaxial segment is longer than the medium allows; signals may not reach every tap.',
  'repeater-rule-exceeded': 'Too many repeaters sit between two stations; collisions may go unnoticed.',
});

function SegmentSection({ segment, index }: { segment: SegmentSnapshot; index: Index }) {
  const select = (ref: PortRef): void => store.getState().select({ kind: 'port', ref });
  const active = segment.active.length;
  return (
    <section className="insp-section" aria-label="Shared segment">
      <div className="panel-title">
        Shared segment <span className="dim mono">{segment.id}</span>
      </div>
      <div className="insp-note">
        Every station on this segment hears every frame and must wait for a quiet wire before sending. Collisions so
        far: <span className="mono">{segment.collisions}</span> · wire{' '}
        {segment.busy ? `▶ busy (${active} transmission${active === 1 ? '' : 's'})` : '○ quiet'} · rate{' '}
        <span className="mono">{fmtBps(segment.bps)}</span>
      </div>
      {(segment.warnings ?? []).map((w) => (
        <div key={w} className="reason-box">
          ▲ {SEGMENT_WARNING_TEXT[w]}
        </div>
      ))}
      <table className="table compact">
        <thead>
          <tr>
            <th>Member</th>
            <th>Role</th>
            <th>Duplex</th>
            <th className="num">Sent</th>
            <th className="num" title="Collisions">
              Coll.
            </th>
            <th className="num" title="Late collisions">
              Late
            </th>
            <th className="num" title="Frames that waited for a quiet wire">
              Waited
            </th>
          </tr>
        </thead>
        <tbody>
          {segment.members.map((m) => (
            <tr key={`${m.port.device}/${m.port.port}`}>
              <td>
                <button type="button" className="link-btn" onClick={() => select(m.port)}>
                  {endLabel(index, m.port)}
                </button>
              </td>
              <td>{m.role === 'station' ? '◆ station' : '◇ repeater'}</td>
              <td>{m.duplex}</td>
              <td className="num">{m.tx}</td>
              <td className="num">{m.collisions}</td>
              <td className="num">{m.lateCollisions}</td>
              <td className="num">{m.deferred}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function RadioSection({ link }: { link: LinkSnapshot }) {
  const radio = link.radio;
  if (radio === undefined) return null;
  const mcs = identifyMcs(radio.band, radio.rateBps);
  return (
    <section className="insp-section" aria-label="Radio path">
      <div className="panel-title">Radio path</div>
      <dl className="kv">
        <dt>Distance</dt>
        <dd className="mono">
          {formatDistance(radio.distanceM)}{' '}
          <span className="dim">{radio.distanceSource === 'override' ? '(entered distance)' : '(from the canvas)'}</span>
        </dd>
        <dt>Band / channel</dt>
        <dd className="mono">
          {RF_BAND_LABELS[radio.band]} · channel {radio.channel}
        </dd>
        <dt>Signal</dt>
        <dd>
          <BarsMeter bars={radio.bars} label={`Signal strength ${radio.bars} of 4 bars`} />
          <span className="mono">{radio.rssiDbm} dBm</span>
        </dd>
        <dt>Signal to noise</dt>
        <dd className="mono">{radio.snrDb} dB</dd>
        <dt>Radio rate</dt>
        <dd>
          <span className="mono">{radio.rateBps > 0 ? fmtBps(radio.rateBps) : 'none (no usable modulation)'}</span>
          {mcs !== undefined && <div className="dim mono">{formatMcs(mcs)}</div>}
        </dd>
      </dl>
    </section>
  );
}

// ── component ───────────────────────────────────────────────────────────────

export function LinkInspector({ id }: { id: LinkId }) {
  const link = useStore((s) => linkById(s, id));
  if (!link) {
    return (
      <div className="insp fill">
        <div className="empty-hint">That link is no longer part of the topology.</div>
      </div>
    );
  }
  return <LinkDetails link={link} />;
}

function LinkDetails({ link }: { link: LinkSnapshot }) {
  const index = useDeviceIndex();
  const [removing, setRemoving] = useState(false);
  const segmentId = link.segment;
  const segment = useStore((s) => segmentById(s.snapshot, segmentId));
  const radio = link.kind === 'radio';

  const disconnect = async (): Promise<void> => {
    setRemoving(true);
    try {
      await engine.removeLink(link.id);
      const st = store.getState();
      if (st.selection?.kind === 'link' && st.selection.id === link.id) st.select(null);
      st.toast(`${radio ? 'Radio link' : 'Cable'} between ${endLabel(index, link.a)} and ${endLabel(index, link.b)} removed.`, 'info');
    } catch (err) {
      toastError(err);
      setRemoving(false);
    }
  };

  const selectPort = (ref: PortRef): void => store.getState().select({ kind: 'port', ref });
  const media = link.media === 'auto' ? `automatic → ${mediaName(link.resolvedMedia)}` : mediaName(link.media);
  const state = linkStateText(link);
  const down = link.up ? undefined : linkDownWording(link.downReason, link, index);
  const dceRef = link.resolvedDceEnd === 'a' ? link.a : link.resolvedDceEnd === 'b' ? link.b : undefined;
  const lineReason = link.carrier === true && link.downReason !== undefined ? lineProtocolText(link.downReason) : '';

  return (
    <div className="insp fill">
      <div className="insp-head">
        <div className="insp-title-row">
          <span className="insp-title">{linkTitle(link)}</span>
          <span className={`led ${state.cls}`}>
            <span className="dot" aria-hidden="true">
              {state.glyph}
            </span>
            {state.text}
          </span>
        </div>
        <div className="insp-sub">
          <span className="chip" title="Media badge, as drawn on the canvas">
            {mediaBadge(link.resolvedMedia)}
          </span>
          <span>{media}</span>
          {segmentId !== undefined && <span>◆ shared segment</span>}
        </div>
        <div className="insp-actions">
          <button type="button" className="btn" disabled={removing} onClick={() => void disconnect()}>
            ✂ Disconnect
          </button>
        </div>
      </div>
      <div className="insp-body">
        <section className="insp-section">
          <dl className="kv">
            <dt>End A</dt>
            <dd>
              <button type="button" className="link-btn" onClick={() => selectPort(link.a)}>
                {endLabel(index, link.a)}
              </button>
              {link.resolvedDceEnd === 'a' && <span className="chip"> ◷ DCE</span>}
            </dd>
            <dt>End B</dt>
            <dd>
              <button type="button" className="link-btn" onClick={() => selectPort(link.b)}>
                {endLabel(index, link.b)}
              </button>
              {link.resolvedDceEnd === 'b' && <span className="chip"> ◷ DCE</span>}
            </dd>
            <dt>Medium</dt>
            <dd>{media}</dd>
            <dt>{radio ? 'Distance' : 'Length'}</dt>
            <dd className="mono">
              {!radio
                ? `${link.lengthM} m`
                : link.radio !== undefined
                  ? formatDistance(link.radio.distanceM)
                  : link.distanceOverrideM !== undefined
                    ? formatDistance(link.distanceOverrideM)
                    : 'taken from the canvas'}
            </dd>
            <dt>Negotiated</dt>
            <dd className="mono">{link.up ? fmtBps(link.negotiatedBps) : '—'}</dd>
            {dceRef !== undefined && (
              <>
                <dt>Clock end (DCE)</dt>
                <dd>
                  ◷ {endLabel(index, dceRef)} <span className="dim">supplies the clock and needs “clock rate”</span>
                </dd>
              </>
            )}
          </dl>
          {link.up ? (
            <div className="reason-box ok">
              ✓ {radio ? 'The radios hear each other; frames can cross this link.' : 'Carrier on both ends; frames can cross this cable.'}
            </div>
          ) : (
            <div className="reason-box" role="status">
              ▲ {down?.explain ?? 'The link is down.'}
              {lineReason !== '' && lineReason !== down?.explain && <div className="dim">{lineReason}</div>}
              {link.downReason !== undefined && <div className="dim mono">reason: {link.downReason}</div>}
            </div>
          )}
        </section>
        <RadioSection link={link} />
        <NegotiationSection link={link} index={index} />
        {segment !== undefined && <SegmentSection segment={segment} index={index} />}
        <ImpairmentEditor key={link.id} link={link} />
      </div>
    </div>
  );
}
