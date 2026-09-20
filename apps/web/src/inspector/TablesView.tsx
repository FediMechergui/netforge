/**
 * Table visualizers (spec §9.4; ARCHITECTURE-P1 §7, §9.3): CAM, ARP and RIB for one device, plus every extra table
 * the snapshot carries (`tables.extra`: wireless associations, and from P1 neighbours, sockets, DHCP bindings, DNS
 * cache), rendered generically from their TABLE_DESCRIPTORS columns. Which sections show follows table ownership
 * (the catalog entry's daemons, else the capabilities), never the device kind. Rows flash when a `tableWrite`
 * arrives, rows with an expiry show a countdown ring, and rows that were just removed linger briefly as
 * struck-through "ghost" rows rebuilt from the `tableExpire` event. Countdowns tick at 4 Hz, never per frame.
 */
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ArpRow, CamRow, DeviceSnapshot, RouteRow, SimTime, TableColumn, TableSnapshot } from '@netforge/engine';
import { fmtSimTime } from '../bridge/client';
import { extrapolatedNow } from '../store/selectors';
import { store, useStore } from '../store/store';
import type { TableFlash } from '../store/types';
import { formatStateValue, formatTableCell } from '../vocab/fields';
import { catalogModel, tableSectionsFor } from './tabs';
import './inspector.css';

const TICK_MS = 250;

/** Extrapolated sim time, refreshed every `periodMs` (no re-render while paused). */
export function useTickNow(periodMs = TICK_MS, enabled = true): SimTime {
  const [now, setNow] = useState<SimTime>(() => extrapolatedNow(store.getState(), performance.now()));
  useEffect(() => {
    if (!enabled) return;
    const tick = (): void => setNow(extrapolatedNow(store.getState(), performance.now()));
    tick();
    const id = setInterval(tick, periodMs);
    return () => clearInterval(id);
  }, [periodMs, enabled]);
  return now;
}

export function fmtRemaining(ns: number): string {
  if (ns <= 0) return 'expiring';
  const total = Math.ceil(ns / 1_000_000_000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min ${s} s`;
  return `${s} s`;
}

const RING_R = 5;
const RING_C = 2 * Math.PI * RING_R;

export const Countdown = memo(function Countdown({
  expiresAt,
  updatedAt,
  now,
}: {
  expiresAt: SimTime;
  updatedAt: SimTime;
  now: SimTime;
}) {
  const total = Math.max(1, expiresAt - updatedAt);
  const remaining = Math.max(0, expiresAt - now);
  const frac = Math.min(1, remaining / total);
  const state = remaining <= 0 ? ' gone' : frac < 0.2 ? ' low' : '';
  return (
    <span className={`countdown${state}`} title={`Expires at ${fmtSimTime(expiresAt)}`}>
      <svg viewBox="0 0 14 14" aria-hidden="true">
        <circle className="track" cx="7" cy="7" r={RING_R} />
        <circle className="arc" cx="7" cy="7" r={RING_R} strokeDasharray={`${RING_C * frac} ${RING_C}`} />
      </svg>
      <span className="mono">{fmtRemaining(remaining)}</span>
    </span>
  );
});

// ── generic sortable section ────────────────────────────────────────────────

interface BaseRow {
  key: string;
  expiresAt?: SimTime;
  updatedAt: SimTime;
}

interface Column<R> {
  id: string;
  label: string;
  sort: (r: R) => string | number;
  cell: (r: R, now: SimTime) => ReactNode;
  num?: boolean;
}

interface Ghost {
  row: Record<string, unknown>;
  reason: string;
  stamp: number;
}

function ipNum(ip: unknown): number {
  if (typeof ip !== 'string') return 0;
  const parts = ip.split('.');
  let v = 0;
  for (const p of parts) v = v * 256 + (Number.parseInt(p, 10) || 0);
  return v;
}

function compare(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

interface SectionProps<R extends BaseRow> {
  title: string;
  table: string;
  rows: readonly R[];
  columns: readonly Column<R>[];
  flashes: ReadonlyMap<string, TableFlash>;
  ghosts: readonly Ghost[];
  now: SimTime;
  compact: boolean;
  emptyText: string;
  defaultSort: string;
}

function TableSection<R extends BaseRow>(props: SectionProps<R>) {
  const { title, table, rows, columns, flashes, ghosts, now, compact, emptyText, defaultSort } = props;
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 }>({ col: defaultSort, dir: 1 });

  const sorted = useMemo(() => {
    const col = columns.find((c) => c.id === sort.col);
    if (!col) return rows;
    return [...rows].sort((a, b) => sort.dir * compare(col.sort(a), col.sort(b)) || compare(a.key, b.key));
  }, [rows, columns, sort]);

  const onSort = (col: string): void => {
    setSort((cur) => (cur.col === col ? { col, dir: cur.dir === 1 ? -1 : 1 } : { col, dir: 1 }));
  };

  return (
    <section className="tbl-section">
      <h4>
        {title} <span className="count">{rows.length}</span>
      </h4>
      {rows.length === 0 && ghosts.length === 0 ? (
        <div className="tbl-empty">{emptyText}</div>
      ) : (
        <table className={`table${compact ? ' compact' : ''}`}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.id} aria-sort={sort.col === c.id ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" className="sort-th" onClick={() => onSort(c.id)} title={`Sort by ${c.label}`}>
                    {c.label}
                    {sort.col === c.id && <span className="dir">{sort.dir === 1 ? '▲' : '▼'}</span>}
                  </button>
                </th>
              ))}
              <th aria-label="Recent change" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const flash = flashes.get(`${table}|${r.key}`);
              return (
                <TableRowView
                  key={flash ? `${r.key}#${flash.wallCreated}` : r.key}
                  row={r}
                  columns={columns}
                  flashKind={flash?.kind}
                  now={r.expiresAt !== undefined ? now : 0}
                />
              );
            })}
            {ghosts.map((g) => (
              <tr key={`ghost:${String(g.row.key)}#${g.stamp}`} className="ghost flash-expire" title="Removed just now">
                {columns.map((c) => (
                  <td key={c.id} className={c.num ? 'num' : undefined}>
                    {c.id === 'expires' ? '—' : c.cell(g.row as unknown as R, now)}
                  </td>
                ))}
                <td className="ghost-note">✗ removed ({g.reason})</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

interface RowViewProps<R extends BaseRow> {
  row: R;
  columns: readonly Column<R>[];
  flashKind: TableFlash['kind'] | undefined;
  now: SimTime;
}

function TableRowViewImpl<R extends BaseRow>({ row, columns, flashKind, now }: RowViewProps<R>) {
  const cls = flashKind === 'write' ? 'flash-write' : flashKind === 'expire' ? 'flash-expire' : undefined;
  return (
    <tr className={cls}>
      {columns.map((c) => (
        <td key={c.id} className={c.num ? 'num' : undefined}>
          {c.cell(row, now)}
        </td>
      ))}
      <td className="dim" title={flashKind === 'write' ? 'Written just now' : undefined}>
        {flashKind === 'write' ? '✚' : flashKind === 'expire' ? '✗' : ''}
      </td>
    </tr>
  );
}

const TableRowView = memo(TableRowViewImpl) as typeof TableRowViewImpl;

// ── columns ─────────────────────────────────────────────────────────────────

function expiryCell(r: BaseRow, now: SimTime, staticText: string): ReactNode {
  if (r.expiresAt === undefined) return <span className="dim">{staticText}</span>;
  return <Countdown expiresAt={r.expiresAt} updatedAt={r.updatedAt} now={now} />;
}

function camColumns(shortOf: (port: string) => string): Column<CamRow>[] {
  return [
    { id: 'vlan', label: 'VLAN', sort: (r) => r.vlan, cell: (r) => r.vlan, num: true },
    { id: 'mac', label: 'MAC address', sort: (r) => r.mac, cell: (r) => <span className="mono">{r.mac}</span> },
    { id: 'port', label: 'Port', sort: (r) => r.port, cell: (r) => <span title={r.port}>{shortOf(r.port)}</span> },
    { id: 'type', label: 'Type', sort: (r) => r.type, cell: (r) => r.type },
    {
      id: 'expires',
      label: 'Ages out in',
      sort: (r) => r.expiresAt ?? Number.MAX_SAFE_INTEGER,
      cell: (r, now) => expiryCell(r, now, 'never (static)'),
    },
  ];
}

function arpColumns(shortOf: (port: string) => string): Column<ArpRow>[] {
  return [
    { id: 'ip', label: 'Address', sort: (r) => ipNum(r.ip), cell: (r) => <span className="mono">{r.ip}</span> },
    {
      id: 'mac',
      label: 'MAC address',
      sort: (r) => (r.incomplete ? '' : r.mac),
      cell: (r) =>
        r.incomplete ? (
          <span className="chip warn tiny" title="An ARP request is outstanding for this address">
            … resolving
          </span>
        ) : (
          <span className="mono">{r.mac}</span>
        ),
    },
    { id: 'iface', label: 'Interface', sort: (r) => r.iface, cell: (r) => <span title={r.iface}>{shortOf(r.iface)}</span> },
    { id: 'type', label: 'Type', sort: (r) => r.type, cell: (r) => r.type },
    {
      id: 'expires',
      label: 'Expires in',
      sort: (r) => r.expiresAt ?? Number.MAX_SAFE_INTEGER,
      cell: (r, now) => expiryCell(r, now, 'never (static)'),
    },
  ];
}

const SOURCE_TITLE: Record<RouteRow['source'], string> = {
  C: 'C — connected network',
  L: 'L — local address of an interface',
  S: 'S — static route',
  D: 'D — default route learned from a DHCP lease',
};

function ribColumns(shortOf: (port: string) => string): Column<RouteRow>[] {
  return [
    {
      id: 'source',
      label: 'Src',
      sort: (r) => r.source,
      cell: (r) => (
        <span className={`src-badge ${r.source}`} title={SOURCE_TITLE[r.source]}>
          {r.source}
          {r.isDefault ? '*' : ''}
        </span>
      ),
    },
    {
      id: 'network',
      label: 'Destination',
      sort: (r) => ipNum(r.network) * 64 + r.prefixLen,
      cell: (r) => (
        <span className="mono">
          {r.network}/{r.prefixLen}
        </span>
      ),
    },
    {
      id: 'nextHop',
      label: 'Next hop',
      sort: (r) => (r.nextHop ? ipNum(r.nextHop) : -1),
      cell: (r) => (r.nextHop ? <span className="mono">{r.nextHop}</span> : <span className="dim">directly connected</span>),
    },
    {
      id: 'iface',
      label: 'Interface',
      sort: (r) => r.iface ?? '',
      cell: (r) => (r.iface ? <span title={r.iface}>{shortOf(r.iface)}</span> : <span className="dim">via next hop</span>),
    },
    {
      id: 'ad',
      label: 'AD/metric',
      sort: (r) => r.ad * 1_000_000 + r.metric,
      cell: (r) => (
        <span className="mono" title="Administrative distance / metric">
          {r.ad}/{r.metric}
        </span>
      ),
      num: true,
    },
  ];
}

// ── extra tables ────────────────────────────────────────────────────────────

/** A row of a generic (extra) table, keyed and timed like the built-in rows. */
export interface GenericRow extends BaseRow {
  readonly fields: Readonly<Record<string, unknown>>;
}

/** Normalise the plain row copies of a TableSnapshot (rows without a key get their position). */
export function genericRows(table: Pick<TableSnapshot, 'rows'>): GenericRow[] {
  return table.rows.map((r, i) => {
    const key = typeof r.key === 'string' && r.key !== '' ? r.key : `#${i}`;
    const updatedAt = typeof r.updatedAt === 'number' ? r.updatedAt : 0;
    return typeof r.expiresAt === 'number' ? { key, updatedAt, expiresAt: r.expiresAt, fields: r } : { key, updatedAt, fields: r };
  });
}

function sortValue(format: TableColumn['format'], v: unknown): string | number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === undefined || v === null) return '';
  if (format === 'ipv4') return ipNum(v);
  return String(v);
}

const MONO_FORMATS: ReadonlySet<TableColumn['format']> = new Set(['mac', 'ipv4', 'ipv6', 'ip']);

/** Columns of an extra table from its descriptor; `port` cells show short names, `expiresAt` a countdown ring. */
export function genericColumns(columns: readonly TableColumn[], shortOf: (port: string) => string): Column<GenericRow>[] {
  return columns.map((c) => ({
    id: c.key === 'expiresAt' ? 'expires' : c.key,
    label: c.title,
    num: c.format === 'number' || c.format === 'duration',
    sort: (r: GenericRow) => (c.key === 'expiresAt' ? (r.expiresAt ?? Number.MAX_SAFE_INTEGER) : sortValue(c.format, r.fields[c.key])),
    cell: (r: GenericRow, now: SimTime): ReactNode => {
      const v = r.fields[c.key];
      if (c.key === 'expiresAt' && c.format === 'time') return expiryCell(r, now, 'never');
      if (c.format === 'time' && typeof v === 'number') return <span className="mono">{fmtSimTime(v)}</span>;
      if (c.format === 'port' && typeof v === 'string') return <span title={v}>{shortOf(v)}</span>;
      if (c.format === 'state' && typeof v === 'string') return <span title={v}>{formatStateValue(v)}</span>;
      const text = formatTableCell(c.format, v, now);
      return MONO_FORMATS.has(c.format) ? <span className="mono">{text}</span> : text;
    },
  }));
}

/** Empty-state wording of the known extra tables. */
const EXTRA_EMPTY_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'dot11-assoc': 'No wireless stations yet. Entries appear while a client joins or is joined.',
  nd: 'No IPv6 neighbours discovered yet.',
  rib6: 'No IPv6 routes. Give an interface an IPv6 address to get connected routes.',
  sockets: 'No open sockets.',
  'dhcp-bindings': 'No addresses handed out yet.',
  'dns-cache': 'Nothing cached. Names appear here once they have been looked up.',
});

/** Ghost rows of a generic table carry the raw removed row; wrap it so the generic cells can read it. */
function wrapGhosts(ghosts: readonly Ghost[]): Ghost[] {
  return ghosts.map((g) => {
    const row = genericRows({ rows: [g.row] })[0];
    return { ...g, row: (row ?? { key: String(g.row.key), updatedAt: 0, fields: g.row }) as unknown as Record<string, unknown> };
  });
}

function ExtraTableSection({
  table,
  shortOf,
  flashes,
  ghosts,
  now,
  compact,
}: {
  table: TableSnapshot;
  shortOf: (port: string) => string;
  flashes: ReadonlyMap<string, TableFlash>;
  ghosts: readonly Ghost[];
  now: SimTime;
  compact: boolean;
}) {
  const rows = useMemo(() => genericRows(table), [table]);
  const columns = useMemo(() => genericColumns(table.columns, shortOf), [table.columns, shortOf]);
  const wrapped = useMemo(() => wrapGhosts(ghosts), [ghosts]);
  return (
    <TableSection
      title={table.title}
      table={table.name}
      rows={rows}
      columns={columns}
      flashes={flashes}
      ghosts={wrapped}
      now={now}
      compact={compact}
      emptyText={EXTRA_EMPTY_TEXT[table.name] ?? 'No entries yet.'}
      defaultSort={columns[0]?.id ?? 'key'}
    />
  );
}

// ── view ────────────────────────────────────────────────────────────────────

const NO_GHOSTS: readonly Ghost[] = Object.freeze([]);


interface TablesViewProps {
  device: DeviceSnapshot;
  compact?: boolean;
  /** Supply a shared clock (dock panel); otherwise the view runs its own 4 Hz ticker. */
  now?: SimTime;
}

export function TablesView({ device, compact = false, now: sharedNow }: TablesViewProps) {
  const ownNow = useTickNow(TICK_MS, sharedNow === undefined);
  const now = sharedNow ?? ownNow;
  const allFlashes = useStore((s) => s.tableFlashes);

  const flashes = useMemo(() => {
    const m = new Map<string, TableFlash>();
    for (const f of allFlashes) if (f.device === device.id) m.set(`${f.table}|${f.key}`, f);
    return m;
  }, [allFlashes, device.id]);

  const { cam, arp, rib } = device.tables;
  const extra = device.tables.extra;
  const model = useStore((s) => catalogModel(s.catalog, device.type));

  const ghosts = useMemo(() => {
    const out = new Map<string, Ghost[]>();
    const present = new Map<string, ReadonlySet<string>>([
      ['cam', new Set(cam.map((r) => r.key))],
      ['arp', new Set(arp.map((r) => r.key))],
      ['rib', new Set(rib.map((r) => r.key))],
    ]);
    for (const t of extra ?? []) present.set(t.name, new Set(genericRows(t).map((r) => r.key)));
    const wanted = [...flashes.values()].filter((f) => f.kind === 'expire' && present.get(f.table)?.has(f.key) === false);
    if (wanted.length === 0) return out;
    const events = store.getState().events;
    for (const f of wanted) {
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (ev && ev.kind === 'tableExpire' && ev.device === device.id && ev.table === f.table && ev.key === f.key) {
          const list = out.get(f.table) ?? [];
          list.push({ row: ev.row, reason: ev.reason, stamp: f.wallCreated });
          out.set(f.table, list);
          break;
        }
      }
    }
    return out;
  }, [flashes, cam, arp, rib, extra, device.id]);

  const shortOf = useMemo(() => {
    const m = new Map(device.ports.map((p) => [p.id, p.short] as const));
    return (port: string): string => m.get(port) ?? port;
  }, [device.ports]);

  const columns = useMemo(
    () => ({ cam: camColumns(shortOf), arp: arpColumns(shortOf), rib: ribColumns(shortOf) }),
    [shortOf],
  );

  const sections = useMemo(() => tableSectionsFor(device, model), [device, model]);

  if (!device.power) {
    return <div className="insp-note">The device is powered off, so its tables are empty (they live in RAM).</div>;
  }

  if (sections.length === 0) {
    return <div className="insp-note">This device keeps no tables: it passes signals on without learning addresses.</div>;
  }

  return (
    <div>
      {sections.map((sec) => {
        switch (sec.kind) {
          case 'cam':
            return (
              <TableSection
                key="cam"
                title="MAC address table"
                table="cam"
                rows={cam}
                columns={columns.cam}
                flashes={flashes}
                ghosts={ghosts.get('cam') ?? NO_GHOSTS}
                now={now}
                compact={compact}
                emptyText="Nothing learned yet. Entries appear as frames arrive on the ports."
                defaultSort="mac"
              />
            );
          case 'arp':
            return (
              <TableSection
                key="arp"
                title="ARP cache"
                table="arp"
                rows={arp}
                columns={columns.arp}
                flashes={flashes}
                ghosts={ghosts.get('arp') ?? NO_GHOSTS}
                now={now}
                compact={compact}
                emptyText="No neighbours resolved yet. Sending to a local address fills it in."
                defaultSort="ip"
              />
            );
          case 'rib':
            return (
              <TableSection
                key="rib"
                title="Routing table"
                table="rib"
                rows={rib}
                columns={columns.rib}
                flashes={flashes}
                ghosts={ghosts.get('rib') ?? NO_GHOSTS}
                now={now}
                compact={compact}
                emptyText="No routes. Give an interface an address (and bring it up) to get connected routes."
                defaultSort="network"
              />
            );
          case 'extra': {
            const table = extra?.[sec.index];
            if (table === undefined) return null;
            return (
              <ExtraTableSection
                key={`extra:${table.name}`}
                table={table}
                shortOf={shortOf}
                flashes={flashes}
                ghosts={ghosts.get(table.name) ?? NO_GHOSTS}
                now={now}
                compact={compact}
              />
            );
          }
        }
      })}
    </div>
  );
}
