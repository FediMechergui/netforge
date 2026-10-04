/**
 * Port inspector, PPP section [S19] (ARCHITECTURE-P3 §5.9 "Port inspector", §6 "[S18]/[S19] WAN overlay … PPP and Tunnel
 * port-inspector sections"; §3.9; §7 W3 web-inspector). For a serial port running PPP it shows the phase rail
 * (D·E·A·N, the same rail the WAN overlay draws), the LCP state, authentication in both directions (what this end
 * requires of its peer, and what the peer requires of this end) with their outcomes, the peer's name, IPCP with the
 * peer's address, IPV6CP when it runs, the two magic numbers, and the failures with the last one's reason.
 *
 * Everything comes from the port's `ppp` row (§2.6, `PppRow`), so a port without one shows nothing. Every state keeps a
 * text channel next to its glyph; wording is original (§0 rule 6).
 */
import { formatSimTime } from '@netforge/engine';
import type { DeviceSnapshot, PortId, PortSnapshot, PppFsmState, PppPhase, PppRow } from '@netforge/engine';
import { pppRail, PPP_DONE_GLYPH, PPP_FAILED_GLYPH, PPP_RAIL_SEPARATOR, type PppStepState } from '../canvas/overlays/wan-model';
import { extraTableRows } from './SwitchportSection';
import './inspector.css';

// ── vocabulary ───────────────────────────────────────────────────────────────

/** Words of the RFC 1661 link phases. */
export const PPP_PHASE_WORDS: Readonly<Record<PppPhase, string>> = Object.freeze({
  dead: 'Dead (no link yet)',
  establish: 'Establish (LCP negotiating the link)',
  authenticate: 'Authenticate (checking the peer)',
  network: 'Network (network protocols)',
  terminate: 'Terminate (closing the link)',
});

/** Words of the RFC 1661 automaton states (LCP and the NCPs). */
export const PPP_FSM_WORDS: Readonly<Record<PppFsmState, string>> = Object.freeze({
  initial: 'Initial',
  starting: 'Starting',
  closed: 'Closed',
  stopped: 'Stopped',
  closing: 'Closing',
  stopping: 'Stopping',
  'req-sent': 'Request sent',
  'ack-rcvd': 'Acknowledgement received',
  'ack-sent': 'Acknowledgement sent',
  opened: 'Opened',
});

/** Glyph + words of an authentication outcome. */
export const PPP_AUTH_STATE_WORDS: Readonly<Record<'pending' | 'success' | 'failed', { readonly glyph: string; readonly text: string }>> =
  Object.freeze({
    pending: { glyph: '◔', text: 'in progress' },
    success: { glyph: '✓', text: 'succeeded' },
    failed: { glyph: '✗', text: 'failed' },
  });

/** How each rail step is shown in text (a screen reader hears the words, the glyph is the non-colour channel). */
const STEP_GLYPH: Readonly<Record<PppStepState, string>> = Object.freeze({
  done: PPP_DONE_GLYPH,
  current: '▶',
  todo: '',
  failed: PPP_FAILED_GLYPH,
  skipped: '–',
});

function words<K extends string>(table: Readonly<Record<K, string>>, key: string | undefined): string {
  if (key === undefined) return '—';
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key as K] : key;
}

// ── facts (pure) ─────────────────────────────────────────────────────────────

/** The `ppp` row of `port` (undefined when the port does not run PPP). */
export function pppRowOf(device: Pick<DeviceSnapshot, 'tables'>, port: PortId): PppRow | undefined {
  return extraTableRows(device, 'ppp').find((r) => r.port === port) as PppRow | undefined;
}

/** The rail as text, each letter followed by its mark: `D✓·E✓·A▶·N`. */
export function pppRailText(row: Parameters<typeof pppRail>[0]): string {
  return pppRail(row)
    .steps.map((s) => `${s.letter}${STEP_GLYPH[s.state]}`)
    .join(PPP_RAIL_SEPARATOR);
}

/**
 * One direction of authentication as words: `this end requires CHAP of its peer: ✓ succeeded`, `not required`.
 * `who` says which direction the line is about.
 */
export function pppAuthText(proto: PppRow['authLocal'], state: PppRow['authLocalState'], who: 'local' | 'peer'): string {
  if (proto === 'none') return who === 'local' ? 'this end requires no authentication' : 'the peer requires no authentication';
  const head = who === 'local' ? `this end requires ${proto.toUpperCase()} of its peer` : `the peer requires ${proto.toUpperCase()} of this end`;
  if (state === undefined) return `${head}: not started`;
  const w = PPP_AUTH_STATE_WORDS[state];
  return `${head}: ${w.glyph} ${w.text}`;
}

/** A magic number as eight hex digits. */
export function magicText(v: number | undefined): string {
  return v === undefined ? '—' : `0x${(v >>> 0).toString(16).padStart(8, '0')}`;
}

// ── component ────────────────────────────────────────────────────────────────

export interface PppSectionProps {
  device: Pick<DeviceSnapshot, 'tables'>;
  port: Pick<PortSnapshot, 'id'>;
}

/** The PPP section of a port, or nothing when the port does not run PPP. */
export function PppSection({ device, port }: PppSectionProps) {
  const row = pppRowOf(device, port.id);
  if (row === undefined) return null;
  const rail = pppRail(row);
  return (
    <section className="insp-section" aria-label="PPP">
      <div className="panel-title">PPP</div>
      <dl className="kv">
        <dt>Phase</dt>
        <dd>
          <span className="mono" aria-hidden="true">
            {pppRailText(row)}
          </span>{' '}
          {words(PPP_PHASE_WORDS, row.phase)}
          <div className="dim">{rail.words}</div>
        </dd>
        <dt>Link control</dt>
        <dd>LCP {words(PPP_FSM_WORDS, row.lcp)}</dd>
        <dt>Authentication</dt>
        <dd>
          <div>{pppAuthText(row.authLocal, row.authLocalState, 'local')}</div>
          <div>{pppAuthText(row.authPeer, row.authPeerState, 'peer')}</div>
          {row.peerName !== undefined && <div className="dim">the peer calls itself {row.peerName}</div>}
        </dd>
        <dt>IPv4 (IPCP)</dt>
        <dd>
          {words(PPP_FSM_WORDS, row.ipcp)}
          {row.peerAddress !== undefined && (
            <span className="mono">
              {' '}
              · peer {row.peerAddress}
            </span>
          )}
        </dd>
        {row.ipv6cp !== undefined && (
          <>
            <dt>IPv6 (IPV6CP)</dt>
            <dd>{words(PPP_FSM_WORDS, row.ipv6cp)}</dd>
          </>
        )}
        <dt>Magic numbers</dt>
        <dd className="mono">
          this end {magicText(row.magic)} · peer {magicText(row.peerMagic)}
        </dd>
        <dt>Failures</dt>
        <dd>
          <span className="mono">{row.failures}</span>
          {row.lastFailure !== undefined && <div className="dim">last: {row.lastFailure}</div>}
        </dd>
        <dt>Since</dt>
        <dd className="mono">{formatSimTime(row.since)}</dd>
      </dl>
    </section>
  );
}
