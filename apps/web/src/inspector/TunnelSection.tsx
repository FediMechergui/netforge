/**
 * Port inspector, Tunnel section [S18] and its IPsec part [C13] (ARCHITECTURE-P3 §5.9 "Port inspector" — "the Tunnel
 * section shows [C13] protection, the SA state and the IP MTU", §6; §3.10, §3.13; §7 W3 web-inspector). For a tunnel
 * port it shows the mode, the source (address and interface) and destination, whether the tunnel is up or why it is
 * down, the transport and IP MTUs and, in IPsec mode, the protection profile, the security association's state (with
 * the reason of a failure, the side that started it, the proposal and the SPIs) and the packets encapsulated and
 * decapsulated.
 *
 * Sources: the `tunnels` row (§2.6 `TunnelRow`, the tunnel owner's), the `ipsec-sa` row (§2.17 `IpsecSaRow`), the
 * protection line of the running configuration (`tunnel protection ipsec profile <p>`) and the gre StateView's
 * per-tunnel counters (display only, rule 20). A port without a `tunnels` row shows nothing. Every state keeps a text
 * channel next to its glyph; wording is original (§0 rule 6).
 */
import { formatSimTime, walkConfigText } from '@netforge/engine';
import type { DeviceSnapshot, IpsecSaRow, PortId, PortSnapshot, TunnelRow } from '@netforge/engine';
import { tunnelReasonText } from '../canvas/overlays/wan-model';
import { extraTableRows } from './SwitchportSection';
import './inspector.css';

// ── vocabulary ───────────────────────────────────────────────────────────────

/** Words of the tunnel modes (with the line that selects each). */
export const TUNNEL_MODE_WORDS: Readonly<Record<TunnelRow['mode'], string>> = Object.freeze({
  gre: 'GRE over IPv4 (tunnel mode gre ip)',
  ipsec: 'IPsec virtual tunnel interface (tunnel mode ipsec ipv4)',
});

/** Glyph + words of a security association's state. */
export const IPSEC_SA_STATE_WORDS: Readonly<Record<IpsecSaRow['state'], { readonly glyph: string; readonly text: string }>> = Object.freeze({
  negotiating: { glyph: '◔', text: 'negotiating' },
  established: { glyph: '●', text: 'established' },
  failed: { glyph: '✗', text: 'failed' },
});

/** Words of the side that started the exchange. */
export const IPSEC_ROLE_WORDS: Readonly<Record<IpsecSaRow['role'], string>> = Object.freeze({
  initiator: 'this router started the exchange (initiator)',
  responder: 'the peer started the exchange (responder)',
});

// ── facts (pure) ─────────────────────────────────────────────────────────────

/** The per-tunnel counters of the gre StateView (display only). */
export interface TunnelCounters {
  readonly encaps: number;
  readonly decaps: number;
  readonly mtuDrops?: number;
  readonly noSa?: number;
}

/** What the section shows for one tunnel port. */
export interface TunnelFacts {
  readonly tunnel: TunnelRow;
  /** [C13] The port's security association, when ike has written one. */
  readonly sa?: IpsecSaRow;
  /** [C13] The protection profile: the SA's, else the port's `tunnel protection ipsec profile` line. */
  readonly profile?: string;
  readonly counters?: TunnelCounters;
}

/** The profile named by `tunnel protection ipsec profile <p>` under `interface <port>` (undefined when absent). */
export function tunnelProtectionProfile(runningConfig: string, port: PortId): string | undefined {
  const want = port.toLowerCase();
  let profile: string | undefined;
  for (const l of walkConfigText(runningConfig)) {
    const head = l.context[0];
    if (l.context.length !== 1 || head === undefined || head[0] !== 'interface' || (head[1] ?? '').toLowerCase() !== want) continue;
    const t = l.tokens;
    if (t[0] === 'tunnel' && t[1] === 'protection' && t[2] === 'ipsec' && t[3] === 'profile' && t[4] !== undefined) {
      profile = l.negate ? undefined : t[4];
    }
  }
  return profile;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** The gre StateView's counters of `port` (undefined when gre reports none). */
export function tunnelCountersOf(device: Pick<DeviceSnapshot, 'processes'>, port: PortId): TunnelCounters | undefined {
  const gre = device.processes.find((p) => p.process === 'gre');
  const list = gre?.state.tunnels;
  if (!Array.isArray(list)) return undefined;
  const e = list.find((x): x is Record<string, unknown> => typeof x === 'object' && x !== null && (x as { port?: unknown }).port === port);
  if (e === undefined) return undefined;
  const mtuDrops = num(e.mtuDrops);
  const noSa = num(e.noSa);
  return {
    encaps: num(e.encaps) ?? 0,
    decaps: num(e.decaps) ?? 0,
    ...(mtuDrops !== undefined ? { mtuDrops } : {}),
    ...(noSa !== undefined ? { noSa } : {}),
  };
}

/** The facts of a tunnel port (undefined when the port has no `tunnels` row). */
export function tunnelFacts(device: Pick<DeviceSnapshot, 'tables' | 'processes' | 'runningConfig'>, port: PortId): TunnelFacts | undefined {
  const tunnel = extraTableRows(device, 'tunnels').find((r) => r.port === port) as TunnelRow | undefined;
  if (tunnel === undefined) return undefined;
  const sa = extraTableRows(device, 'ipsec-sa').find((r) => r.port === port) as IpsecSaRow | undefined;
  const profile = sa?.profile ?? tunnelProtectionProfile(device.runningConfig, port);
  const counters = tunnelCountersOf(device, port);
  return {
    tunnel,
    ...(sa !== undefined ? { sa } : {}),
    ...(profile !== undefined ? { profile } : {}),
    ...(counters !== undefined ? { counters } : {}),
  };
}

/** The tunnel's state as glyph + words: `● up`, `▲ down: no route to the tunnel destination`. */
export function tunnelStateText(row: Pick<TunnelRow, 'state' | 'reason'>): string {
  if (row.state === 'up') return '● up';
  const why = tunnelReasonText(row.reason);
  return why === '' ? '▲ down' : `▲ down: ${why}`;
}

/** The security association as words: `● established`, `✗ failed: key negotiation failed`. */
export function ipsecSaText(sa: Pick<IpsecSaRow, 'state' | 'reason'>): string {
  const w = IPSEC_SA_STATE_WORDS[sa.state] ?? { glyph: '?', text: sa.state };
  const why = sa.reason !== undefined ? tunnelReasonText(sa.reason) : '';
  return `${w.glyph} ${w.text}${why === '' ? '' : `: ${why}`}`;
}

/** An SPI as eight hex digits. */
export function spiText(v: number | undefined): string {
  return v === undefined ? '—' : `0x${(v >>> 0).toString(16).padStart(8, '0')}`;
}

// ── component ────────────────────────────────────────────────────────────────

export interface TunnelSectionProps {
  device: Pick<DeviceSnapshot, 'tables' | 'processes' | 'runningConfig'>;
  port: Pick<PortSnapshot, 'id'>;
}

/** The Tunnel section of a port, or nothing when the port is not a tunnel the tunnel owner reports. */
export function TunnelSection({ device, port }: TunnelSectionProps) {
  const facts = tunnelFacts(device, port.id);
  if (facts === undefined) return null;
  const { tunnel, sa, profile, counters } = facts;
  const ipsec = tunnel.mode === 'ipsec';
  return (
    <section className="insp-section" aria-label="Tunnel">
      <div className="panel-title">Tunnel</div>
      <dl className="kv">
        <dt>Mode</dt>
        <dd>{TUNNEL_MODE_WORDS[tunnel.mode] ?? tunnel.mode}</dd>
        <dt>Source</dt>
        <dd className="mono">
          {tunnel.source ?? 'not set'}
          {tunnel.sourceIface !== undefined && <span className="dim"> ({tunnel.sourceIface})</span>}
        </dd>
        <dt>Destination</dt>
        <dd className="mono">{tunnel.destination ?? 'not set'}</dd>
        <dt>State</dt>
        <dd>
          {tunnelStateText(tunnel)}
          <div className="dim">since {formatSimTime(tunnel.since)}</div>
        </dd>
        <dt>MTU</dt>
        <dd className="mono">
          IP MTU {tunnel.ipMtu} bytes · transport {tunnel.transportMtu} bytes
          <div className="dim">a larger packet is dropped here: fragmentation is not simulated</div>
        </dd>
        {ipsec && (
          <>
            <dt>Protection</dt>
            <dd className="mono">{profile !== undefined ? `IPsec profile ${profile}` : 'no protection profile configured'}</dd>
            <dt>Security association</dt>
            <dd>
              {sa === undefined ? (
                'none yet'
              ) : (
                <>
                  {ipsecSaText(sa)}
                  <div className="dim">{IPSEC_ROLE_WORDS[sa.role] ?? sa.role}</div>
                  {sa.proposal !== undefined && <div className="dim mono">{sa.proposal}</div>}
                  {(sa.espSpiIn !== undefined || sa.espSpiOut !== undefined) && (
                    <div className="dim mono">
                      ESP SPI in {spiText(sa.espSpiIn)} · out {spiText(sa.espSpiOut)}
                    </div>
                  )}
                  <div className="dim">since {formatSimTime(sa.since)}</div>
                </>
              )}
            </dd>
          </>
        )}
        {counters !== undefined && (
          <>
            <dt>Packets</dt>
            <dd className="mono">
              {counters.encaps} {ipsec ? 'encrypted and sent' : 'encapsulated'} · {counters.decaps} {ipsec ? 'received and decrypted' : 'decapsulated'}
              {counters.mtuDrops !== undefined && counters.mtuDrops > 0 && <div className="dim">{counters.mtuDrops} too big for the tunnel</div>}
              {counters.noSa !== undefined && counters.noSa > 0 && <div className="dim">{counters.noSa} dropped: no security association</div>}
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}
