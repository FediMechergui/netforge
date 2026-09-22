/**
 * NAT quadrant visualizer (ARCHITECTURE-P2 §6 "NAT quadrant visualizer"; spec §9.4 names it the fix for the single
 * most confused CCNA topic): the four address names of network address translation laid out as inside/outside ×
 * local/global, filled from the device's `nat` table rows, with the selected packet's provenance marking the two
 * cells its `NatTranslate` mutation moved between (outbound: inside local → inside global; inbound: inside global →
 * inside local) and the rule that caused it (`Mutation.cause` = `NatRow.rule`, §3.9).
 *
 * `natRowsOf`, `natPacketMatch` and `natQuadrantModel` are pure (snapshot rows and a PduJson in, a view model
 * out) so the panel tests can pin them; `NatQuadrant` renders a model, and `NatQuadrantForDevice` feeds it the
 * selected packet through the PDU cache. Each cell keeps a text channel (letters and words) beside its highlight.
 * Wording is original (§0 rule 6).
 */
import type { CSSProperties } from 'react';
import type { DeviceId, DeviceSnapshot, Mutation, PduJson, SimTime } from '@netforge/engine';
import { fmtSimTime } from '../bridge/client';
import { useStore } from '../store/store';
import { usePduJson } from './PacketInspector';
import './inspector.css';

// ── rows ─────────────────────────────────────────────────────────────────────

/** One `nat` row as the quadrant reads it (typed from the generic snapshot row). */
export interface NatRowView {
  readonly key: string;
  readonly proto: string;
  readonly kind: string;
  readonly rule: string;
  readonly insideLocal: string;
  readonly insideLocalPort: number | undefined;
  readonly insideGlobal: string;
  readonly insideGlobalPort: number | undefined;
  readonly outsideLocal: string | undefined;
  readonly outsideLocalPort: number | undefined;
  readonly outsideGlobal: string | undefined;
  readonly outsideGlobalPort: number | undefined;
  readonly updatedAt: SimTime;
  readonly expiresAt: SimTime | undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** True when the snapshot declares a `nat` table (the model runs the nat daemon). */
export function hasNatTable(device: Pick<DeviceSnapshot, 'tables'>): boolean {
  return device.tables.extra?.some((t) => t.name === 'nat') === true;
}

/** The `nat` rows of a device, in table (insertion) order; empty without the table. */
export function natRowsOf(device: Pick<DeviceSnapshot, 'tables'>): readonly NatRowView[] {
  const table = device.tables.extra?.find((t) => t.name === 'nat');
  if (table === undefined) return [];
  const out: NatRowView[] = [];
  table.rows.forEach((r, i) => {
    const insideLocal = str(r['insideLocal']);
    const insideGlobal = str(r['insideGlobal']);
    if (insideLocal === undefined || insideGlobal === undefined) return;
    out.push({
      key: str(r['key']) ?? `#${i}`,
      proto: str(r['proto']) ?? 'any',
      kind: str(r['kind']) ?? 'static',
      rule: str(r['rule']) ?? '',
      insideLocal,
      insideLocalPort: num(r['insideLocalPort']),
      insideGlobal,
      insideGlobalPort: num(r['insideGlobalPort']),
      outsideLocal: str(r['outsideLocal']),
      outsideLocalPort: num(r['outsideLocalPort']),
      outsideGlobal: str(r['outsideGlobal']),
      outsideGlobalPort: num(r['outsideGlobalPort']),
      updatedAt: num(r['updatedAt']) ?? 0,
      expiresAt: num(r['expiresAt']),
    });
  });
  return out;
}

// ── quadrant model ───────────────────────────────────────────────────────────

/** The four address names. */
export type NatCell = 'insideLocal' | 'insideGlobal' | 'outsideLocal' | 'outsideGlobal';

/** Cells in reading order (row by row: inside, then outside; local before global). */
export const NAT_CELLS: readonly NatCell[] = Object.freeze(['insideLocal', 'insideGlobal', 'outsideLocal', 'outsideGlobal']);

/** Original one-line meanings of the four names. */
export const NAT_CELL_TEXT: Readonly<Record<NatCell, { title: string; meaning: string }>> = Object.freeze({
  insideLocal: { title: 'Inside local', meaning: 'the private address an inside host really has' },
  insideGlobal: { title: 'Inside global', meaning: 'the public address the outside world sees for that host' },
  outsideLocal: { title: 'Outside local', meaning: 'how an inside host names the outside host (unchanged here)' },
  outsideGlobal: { title: 'Outside global', meaning: 'the real address of the outside host' },
});

/** `address` or `address:port` (`address id n` for ICMP query rows). */
export function endpointText(address: string, port: number | undefined, proto: string): string {
  if (port === undefined) return address;
  return proto === 'icmp' ? `${address} id ${port}` : `${address}:${port}`;
}

/** What the selected packet did on this device, read from its provenance. */
export interface NatPacketMatch {
  readonly direction: 'outbound' | 'inbound';
  /** The address rewrite: `ipv4.src` outbound, `ipv4.dst` inbound. */
  readonly from: string;
  readonly to: string;
  readonly rule: string | undefined;
  /** Row the rewrite used, when one of the rows still matches it. */
  readonly rowKey: string | null;
  /** Ports or ICMP ids moved with it (PAT), in provenance order: `icmpv4.id 1 → 2`. */
  readonly portChanges: readonly { field: string; from: string; to: string }[];
  /** The two cells the packet moved between, in travel order. */
  readonly cells: readonly [NatCell, NatCell];
}

function fieldText(v: unknown): string {
  return v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/**
 * The selected packet's translation at `device`: the first `NatTranslate` on `ipv4.src` (outbound) or `ipv4.dst`
 * (inbound) recorded by this device, with the port or id rewrites of the same pass. Undefined when the packet was
 * not translated here.
 */
export function natPacketMatch(rows: readonly NatRowView[], pdu: Pick<PduJson, 'provenance'> | undefined, device: DeviceId): NatPacketMatch | undefined {
  if (pdu === undefined) return undefined;
  const mine: Mutation[] = pdu.provenance.filter((m) => m.reason === 'NatTranslate' && m.device === device);
  const address = mine.find((m) => m.field === 'ipv4.src' || m.field === 'ipv4.dst');
  if (address === undefined) return undefined;
  const direction = address.field === 'ipv4.src' ? 'outbound' : 'inbound';
  const from = fieldText(address.before);
  const to = fieldText(address.after);
  const local = direction === 'outbound' ? from : to;
  const global = direction === 'outbound' ? to : from;
  const exact = rows.find((r) => r.insideLocal === local && r.insideGlobal === global && (address.cause === undefined || r.rule === address.cause));
  const byRule = exact ?? rows.find((r) => r.insideLocal === local && r.insideGlobal === global);
  const portChanges = mine
    .filter((m) => m !== address && m.field !== 'ipv4.src' && m.field !== 'ipv4.dst')
    .map((m) => ({ field: m.field, from: fieldText(m.before), to: fieldText(m.after) }));
  return {
    direction,
    from,
    to,
    rule: address.cause,
    rowKey: byRule?.key ?? null,
    portChanges,
    cells: direction === 'outbound' ? ['insideLocal', 'insideGlobal'] : ['insideGlobal', 'insideLocal'],
  };
}

/** One address in a cell. */
export interface NatCellEntry {
  readonly text: string;
  readonly rowKey: string;
  readonly kind: string;
  /** The selected packet used this row. */
  readonly hot: boolean;
}

export interface NatQuadrantModel {
  readonly cells: Readonly<Record<NatCell, readonly NatCellEntry[]>>;
  readonly match: NatPacketMatch | undefined;
  readonly rowCount: number;
}

/** Fill the four cells from the rows; entries of the packet's row are `hot`. Duplicated texts are kept once (the first row wins). */
export function natQuadrantModel(rows: readonly NatRowView[], match: NatPacketMatch | undefined): NatQuadrantModel {
  const cells: Record<NatCell, NatCellEntry[]> = { insideLocal: [], insideGlobal: [], outsideLocal: [], outsideGlobal: [] };
  const add = (cell: NatCell, text: string, row: NatRowView): void => {
    const hot = match !== undefined && match.rowKey === row.key && match.cells.includes(cell);
    const existing = cells[cell].find((e) => e.text === text);
    if (existing !== undefined) {
      if (hot && !existing.hot) cells[cell][cells[cell].indexOf(existing)] = { ...existing, hot: true, rowKey: row.key };
      return;
    }
    cells[cell].push({ text, rowKey: row.key, kind: row.kind, hot });
  };
  for (const r of rows) {
    add('insideLocal', endpointText(r.insideLocal, r.insideLocalPort, r.proto), r);
    add('insideGlobal', endpointText(r.insideGlobal, r.insideGlobalPort, r.proto), r);
    if (r.outsideLocal !== undefined) add('outsideLocal', endpointText(r.outsideLocal, r.outsideLocalPort, r.proto), r);
    if (r.outsideGlobal !== undefined) add('outsideGlobal', endpointText(r.outsideGlobal, r.outsideGlobalPort, r.proto), r);
  }
  return { cells, match, rowCount: rows.length };
}

/** Sentence for the selected packet's translation. */
export function natMatchText(match: NatPacketMatch): string {
  const what = match.direction === 'outbound' ? 'Outbound: the source address' : 'Inbound: the destination address';
  const ports = match.portChanges.map((p) => `${p.field} ${p.from} → ${p.to}`).join(', ');
  return `${what} ${match.from} became ${match.to}${ports === '' ? '' : ` (with ${ports})`}${match.rule !== undefined ? ` because of "${match.rule}"` : ''}.`;
}

// ── component ────────────────────────────────────────────────────────────────

const CELL_STYLE: Readonly<Record<'cell' | 'hot', CSSProperties>> = {
  cell: { verticalAlign: 'top', minWidth: '9em' },
  hot: { verticalAlign: 'top', minWidth: '9em', outline: '2px solid var(--accent)', outlineOffset: '-2px' },
};

function CellEntries({ entries }: { entries: readonly NatCellEntry[] }) {
  if (entries.length === 0) return <span className="dim">—</span>;
  return (
    <>
      {entries.map((e) => (
        <div key={`${e.rowKey}|${e.text}`} className="mono">
          {e.hot && <span aria-hidden="true">▶ </span>}
          {e.text}
          <span className="dim"> {e.kind}</span>
          {e.hot && <span className="dim"> (this packet)</span>}
        </div>
      ))}
    </>
  );
}

export interface NatQuadrantProps {
  device: Pick<DeviceSnapshot, 'id' | 'tables' | 'power'>;
  /** The selected packet, when one is selected and loaded. */
  pdu?: PduJson | undefined;
  /** Extrapolated sim time for the expiry note (optional). */
  now?: SimTime;
}

/** The inside/outside × local/global view of a device's translations. */
export function NatQuadrant({ device, pdu, now }: NatQuadrantProps) {
  if (!hasNatTable(device)) return <div className="insp-note">This device does not translate addresses.</div>;
  if (!device.power) return <div className="insp-note">The device is powered off, so it holds no translations.</div>;
  const rows = natRowsOf(device);
  const match = natPacketMatch(rows, pdu, device.id);
  const model = natQuadrantModel(rows, match);
  const hot = (cell: NatCell): boolean => match !== undefined && match.rowKey !== null && match.cells.includes(cell);
  const nextExpiry = rows.map((r) => r.expiresAt).filter((t): t is number => t !== undefined).sort((a, b) => a - b)[0];
  return (
    <section className="insp-section" aria-label="Address translation">
      <div className="panel-title">
        Address translation <span className="dim">({model.rowCount} translation{model.rowCount === 1 ? '' : 's'})</span>
      </div>
      <table className="table compact nat-quadrant">
        <thead>
          <tr>
            <th aria-label="Side" />
            <th title="the address as it is known on the inside network">Local</th>
            <th title="the address as it is known on the outside network">Global</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row" title="hosts behind the ip nat inside interfaces">
              Inside
            </th>
            <td style={hot('insideLocal') ? CELL_STYLE.hot : CELL_STYLE.cell} data-cell="insideLocal">
              <div className="dim">{NAT_CELL_TEXT.insideLocal.title}</div>
              <CellEntries entries={model.cells.insideLocal} />
            </td>
            <td style={hot('insideGlobal') ? CELL_STYLE.hot : CELL_STYLE.cell} data-cell="insideGlobal">
              <div className="dim">{NAT_CELL_TEXT.insideGlobal.title}</div>
              <CellEntries entries={model.cells.insideGlobal} />
            </td>
          </tr>
          <tr>
            <th scope="row" title="hosts beyond the ip nat outside interfaces">
              Outside
            </th>
            <td style={CELL_STYLE.cell} data-cell="outsideLocal">
              <div className="dim">{NAT_CELL_TEXT.outsideLocal.title}</div>
              <CellEntries entries={model.cells.outsideLocal} />
            </td>
            <td style={CELL_STYLE.cell} data-cell="outsideGlobal">
              <div className="dim">{NAT_CELL_TEXT.outsideGlobal.title}</div>
              <CellEntries entries={model.cells.outsideGlobal} />
            </td>
          </tr>
        </tbody>
      </table>
      {match !== undefined ? (
        <div className="insp-note" role="status">
          <span aria-hidden="true">{match.direction === 'outbound' ? '→ ' : '← '}</span>
          {natMatchText(match)}
          {match.rowKey === null && ' The row that did it has already expired or been cleared.'}
        </div>
      ) : rows.length === 0 ? (
        <div className="insp-note">
          No translation yet. Rows appear when an inside host sends towards the outside (dynamic and overload rules) or as soon as a static rule is
          configured.
        </div>
      ) : (
        <div className="insp-note">
          Select a packet that crossed this device to see which two cells it moved between.
          {nextExpiry !== undefined && (now === undefined || nextExpiry > now) && ` Next expiry at ${fmtSimTime(nextExpiry)}.`}
        </div>
      )}
      <dl className="kv">
        {NAT_CELLS.map((c) => (
          <NatMeaning key={c} cell={c} />
        ))}
      </dl>
    </section>
  );
}

function NatMeaning({ cell }: { cell: NatCell }) {
  return (
    <>
      <dt>{NAT_CELL_TEXT[cell].title}</dt>
      <dd className="dim">{NAT_CELL_TEXT[cell].meaning}</dd>
    </>
  );
}

/** The quadrant of `device`, fed with the currently selected packet (when the selection is a PDU). */
export function NatQuadrantForDevice({ device, now }: { device: Pick<DeviceSnapshot, 'id' | 'tables' | 'power'>; now?: SimTime }) {
  const selected = useStore((s) => (s.selection?.kind === 'pdu' ? s.selection.id : null));
  const { pdu } = usePduJson(selected);
  return <NatQuadrant device={device} pdu={pdu} now={now} />;
}
