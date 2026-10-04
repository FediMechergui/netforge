/**
 * Port inspector, OSPF section [S1] (ARCHITECTURE-P3 §5.9 "Port inspector", §6 "[S1] OSPF overlay … and the port
 * inspector's OSPF section"; §7 W3 web-inspector). For a port enabled for OSPF it shows the area, the network type, the
 * cost and where it comes from, the interface state (with the time left while Waiting), the hello and dead intervals,
 * the priority, whether the port is passive, the DR and BDR, the neighbours on the port with their states, and the
 * last hello the port refused with its reason.
 *
 * Everything comes from the `ospf-interfaces` and `ospf-neighbors` rows of the snapshot (§2.6; display reads the tables,
 * rule 20), so a port without a row shows nothing. Every state keeps a text channel next to its glyph; wording is
 * original (§0 rule 6).
 */
import { formatSimTime } from '@netforge/engine';
import type {
  DeviceSnapshot,
  OspfInterfaceRow,
  OspfIsmState,
  OspfNeighborRow,
  OspfNetworkType,
  OspfNsmState,
  PortId,
  PortSnapshot,
  SimTime,
} from '@netforge/engine';
import { areaLabel, waitDrainFraction } from '../canvas/overlays/ospf-model';
import { extraTableRows } from './SwitchportSection';
import './inspector.css';

// ── vocabulary ───────────────────────────────────────────────────────────────

/** Words of the RFC 2328 interface states. */
export const OSPF_ISM_WORDS: Readonly<Record<OspfIsmState, string>> = Object.freeze({
  down: 'down',
  loopback: 'loopback (advertised as a host route)',
  waiting: 'waiting (listening for a DR before electing one)',
  'point-to-point': 'point-to-point (no DR election)',
  drother: 'DROTHER (neither DR nor BDR)',
  backup: 'BDR (backup designated router)',
  dr: 'DR (designated router)',
});

/** Glyph + words of the RFC 2328 neighbour states (the glyph is the non-colour channel). */
export const OSPF_NSM_WORDS: Readonly<Record<OspfNsmState, { readonly glyph: string; readonly text: string }>> = Object.freeze({
  down: { glyph: '○', text: 'Down' },
  attempt: { glyph: '◔', text: 'Attempt' },
  init: { glyph: '◔', text: 'Init (heard, not yet two-way)' },
  '2way': { glyph: '◑', text: '2-Way (neighbours, not adjacent)' },
  exstart: { glyph: '◕', text: 'ExStart (choosing who leads the exchange)' },
  exchange: { glyph: '◕', text: 'Exchange (describing databases)' },
  loading: { glyph: '◕', text: 'Loading (requesting missing LSAs)' },
  full: { glyph: '●', text: 'Full (adjacent)' },
});

/** Words of the network types. */
export const OSPF_NETWORK_TYPE_WORDS: Readonly<Record<OspfNetworkType, string>> = Object.freeze({
  broadcast: 'broadcast (elects a DR and a BDR)',
  'point-to-point': 'point-to-point',
  loopback: 'loopback',
});

/** Words of a neighbour's role on the segment. */
export const OSPF_ROLE_WORDS: Readonly<Record<OspfNeighborRow['role'], string>> = Object.freeze({
  dr: 'DR',
  bdr: 'BDR',
  drother: 'DROTHER',
  none: '—',
});

function words<K extends string>(table: Readonly<Record<K, string>>, key: string): string {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key as K] : key;
}

// ── facts (pure) ─────────────────────────────────────────────────────────────

/** What the section shows for one port. */
export interface OspfPortFacts {
  readonly iface: OspfInterfaceRow;
  /** The neighbours heard on this port, by router id. */
  readonly neighbors: readonly OspfNeighborRow[];
}

/** The OSPF rows of `port` (undefined when the port is not enabled for OSPF). */
export function ospfPortFacts(device: Pick<DeviceSnapshot, 'tables'>, port: PortId): OspfPortFacts | undefined {
  const iface = extraTableRows(device, 'ospf-interfaces').find((r) => r.port === port) as OspfInterfaceRow | undefined;
  if (iface === undefined) return undefined;
  const neighbors = (extraTableRows(device, 'ospf-neighbors') as unknown as OspfNeighborRow[])
    .filter((r) => r.port === port)
    .sort((a, b) => (a.routerId < b.routerId ? -1 : a.routerId > b.routerId ? 1 : 0));
  return { iface, neighbors };
}

/** The cost and where it comes from: `64 (from the interface bandwidth)` / `10 (configured)`. */
export function ospfCostText(row: Pick<OspfInterfaceRow, 'cost' | 'costSource'>): string {
  return `${row.cost} (${row.costSource === 'configured' ? 'configured with ip ospf cost' : 'from the interface bandwidth'})`;
}

/** A DR or BDR as words: `2.2.2.2 at 10.0.0.2`, or `none` when the segment has none. */
export function ospfRouterText(id: string | undefined, address: string | undefined): string {
  if (id === undefined || id === '0.0.0.0') return 'none';
  return address === undefined ? id : `${id} at ${address}`;
}

/** Whole seconds between two instants, at least 0 (`12 s`). */
function secondsText(ns: number): string {
  return `${Math.max(0, Math.ceil(ns / 1_000_000_000))} s`;
}

/** The interface state as words, with the time left while Waiting (`… 23 s left`). */
export function ospfStateText(row: Pick<OspfInterfaceRow, 'state' | 'stateSince' | 'waitUntil'>, now: SimTime): string {
  const base = words(OSPF_ISM_WORDS, row.state);
  if (row.state === 'waiting' && row.waitUntil !== undefined) return `${base}, ${secondsText(row.waitUntil - now)} left`;
  return base;
}

/** The last refused hello as one sentence. */
export function ospfRefusalText(r: NonNullable<OspfInterfaceRow['rejected']>): string {
  return `from ${r.from} (router ${r.routerId}): ${r.reason}, at ${formatSimTime(r.at)}`;
}

// ── component ────────────────────────────────────────────────────────────────

export interface OspfSectionProps {
  device: Pick<DeviceSnapshot, 'tables'>;
  port: Pick<PortSnapshot, 'id'>;
  now: SimTime;
}

/** The OSPF section of a port, or nothing when the port is not enabled for OSPF. */
export function OspfSection({ device, port, now }: OspfSectionProps) {
  const facts = ospfPortFacts(device, port.id);
  if (facts === undefined) return null;
  const { iface, neighbors } = facts;
  const drain = waitDrainFraction(iface, now);
  return (
    <section className="insp-section" aria-label="OSPF">
      <div className="panel-title">OSPF</div>
      <dl className="kv">
        <dt>Area</dt>
        <dd>
          {areaLabel(iface.area)} <span className="dim mono">({iface.area})</span>
          <div className="dim">
            process {iface.process} · router id <span className="mono">{iface.routerId}</span>
          </div>
        </dd>
        <dt>Network type</dt>
        <dd>{words(OSPF_NETWORK_TYPE_WORDS, iface.networkType)}</dd>
        <dt>Cost</dt>
        <dd className="mono">{ospfCostText(iface)}</dd>
        <dt>State</dt>
        <dd>
          {ospfStateText(iface, now)}
          {drain !== undefined && (
            <div
              role="progressbar"
              aria-label="Time left before the DR election"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(drain * 100)}
              style={{ height: 4, marginTop: 3, background: 'var(--border)', borderRadius: 2 }}
            >
              <div style={{ width: `${Math.round(drain * 100)}%`, height: '100%', background: 'var(--accent)', borderRadius: 2 }} />
            </div>
          )}
        </dd>
        <dt>Timers</dt>
        <dd className="mono">
          hello {iface.helloS} s · dead {iface.deadS} s
        </dd>
        <dt>Priority</dt>
        <dd className="mono">
          {iface.priority}
          {iface.priority === 0 && <span className="dim"> (never DR or BDR)</span>}
        </dd>
        {iface.passive && (
          <>
            <dt>Passive</dt>
            <dd>
              <span aria-hidden="true">P </span>yes: the network is advertised, but no hello is sent or accepted here
            </dd>
          </>
        )}
        {iface.networkType === 'broadcast' && (
          <>
            <dt>DR</dt>
            <dd className="mono">{ospfRouterText(iface.dr, iface.drAddress)}</dd>
            <dt>BDR</dt>
            <dd className="mono">{ospfRouterText(iface.bdr, iface.bdrAddress)}</dd>
          </>
        )}
        {iface.rejected !== undefined && (
          <>
            <dt>Last refused hello</dt>
            <dd>
              <span aria-hidden="true">! </span>
              {ospfRefusalText(iface.rejected)}
            </dd>
          </>
        )}
      </dl>
      {neighbors.length === 0 ? (
        <div className="insp-note">{iface.passive ? 'A passive interface forms no neighbours.' : 'No neighbour heard on this port yet.'}</div>
      ) : (
        <table className="table compact">
          <caption className="dim">
            Neighbours on this port: {neighbors.length}, adjacent (Full): {neighbors.filter((n) => n.state === 'full').length}
          </caption>
          <thead>
            <tr>
              <th scope="col">Router id</th>
              <th scope="col">Address</th>
              <th scope="col">State</th>
              <th scope="col">Role</th>
              <th scope="col" className="num">
                Priority
              </th>
            </tr>
          </thead>
          <tbody>
            {neighbors.map((n) => {
              const st = OSPF_NSM_WORDS[n.state] ?? { glyph: '?', text: n.state };
              return (
                <tr key={n.routerId}>
                  <th scope="row" className="mono">
                    {n.routerId}
                  </th>
                  <td className="mono">{n.address}</td>
                  <td>
                    <span aria-hidden="true">{st.glyph} </span>
                    {st.text}
                  </td>
                  <td className="mono">{words(OSPF_ROLE_WORDS, n.role)}</td>
                  <td className="num">{n.priority}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
