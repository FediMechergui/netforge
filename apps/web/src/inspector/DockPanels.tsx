/**
 * Bottom-dock tabs owned by the inspector module: Packets, Events (lanes by kind),
 * Tables (every device side by side) and Provenance. Lists render only the newest
 * rows (enough virtualisation for P0), memoise rows and pre-compute their text.
 */
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DeviceId, DeviceSnapshot, PduId, TraceEvent, TraceKind } from '@netforge/engine';
import { fmtSimTime } from '../bridge/client';
import { store, useStore } from '../store/store';
import {
  deviceName,
  fmtMutationValue,
  pduIdOf,
  portLabel,
  selectPdu,
  useDeviceIndex,
  type EventOf,
} from './PacketInspector';
import { protoClass } from './HexView';
import { DROP_LABEL, Provenance } from './Provenance';
import { TablesView, useTickNow } from './TablesView';
import './inspector.css';

export { PacketInspector } from './PacketInspector';

type Index = ReadonlyMap<DeviceId, DeviceSnapshot>;

const MAX_PACKET_ROWS = 500;
const MAX_EVENT_ROWS = 800;

function useSelectedPduId(): PduId | null {
  return useStore((s) => (s.selection?.kind === 'pdu' ? s.selection.id : null));
}

/** Keep a scroll container pinned to the bottom while `follow` is on. */
function useFollowScroll(dep: unknown, follow: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [dep, follow]);
  return ref;
}

// ── Packets ─────────────────────────────────────────────────────────────────

type FrameTx = EventOf<'frameTx'>;

interface PacketLine {
  ev: FrameTx;
  from: string;
  to: string;
}

export function PacketsPanel() {
  const events = useStore((s) => s.events);
  const devices = useDeviceIndex();
  const selectedPdu = useSelectedPduId();
  const [query, setQuery] = useState('');
  const [frozen, setFrozen] = useState<readonly TraceEvent[] | null>(null);
  const follow = frozen === null;
  const source = frozen ?? events;

  const { lines, total } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: PacketLine[] = [];
    let count = 0;
    for (const ev of source) {
      if (ev.kind !== 'frameTx') continue;
      const line: PacketLine = { ev, from: portLabel(devices, ev.from), to: portLabel(devices, ev.to) };
      if (q) {
        const hay = `#${ev.pdu.id} ${ev.pdu.proto} ${ev.pdu.summary} ${line.from} ${line.to} ${ev.pdu.tag ?? ''}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      count++;
      out.push(line);
    }
    return { lines: out.slice(-MAX_PACKET_ROWS), total: count };
  }, [source, query, devices]);

  const scrollRef = useFollowScroll(lines, follow);
  const onPick = useCallback((id: PduId) => selectPdu(id), []);

  return (
    <div className="dock-panel">
      <div className="dock-toolbar">
        <input
          className="input"
          type="search"
          placeholder="Filter: address, protocol, device, #id…"
          aria-label="Filter packets"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className={`btn${follow ? ' is-active' : ''}`}
          aria-pressed={follow}
          onClick={() => setFrozen(follow ? events : null)}
          title={follow ? 'Freeze the list to read it' : 'Resume following new packets'}
        >
          {follow ? '⏸ Pause list' : '▶ Follow new'}
        </button>
        <span className="spacer" />
        <span>
          {total > lines.length ? `newest ${lines.length} of ${total}` : `${total}`} transmission{total === 1 ? '' : 's'}
        </span>
      </div>
      <div className="dock-scroll" ref={scrollRef}>
        {lines.length === 0 ? (
          <div className="dock-hint">
            {query ? 'No transmissions match the filter.' : 'No frames sent yet. Ping between two configured hosts to see traffic here.'}
          </div>
        ) : (
          <table className="table compact">
            <thead>
              <tr>
                <th>Time</th>
                <th className="num">#</th>
                <th>From</th>
                <th>To</th>
                <th>Proto</th>
                <th>Summary</th>
                <th className="num">Bytes</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <PacketRow
                  key={`${l.ev.pdu.id}:${l.ev.link}:${l.ev.t}:${i}`}
                  line={l}
                  selected={selectedPdu === l.ev.pdu.id}
                  onPick={onPick}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const PacketRow = memo(function PacketRow({
  line,
  selected,
  onPick,
}: {
  line: PacketLine;
  selected: boolean;
  onPick(id: PduId): void;
}) {
  const { ev } = line;
  return (
    <tr className={`is-clickable${selected ? ' is-selected' : ''}`} onClick={() => onPick(ev.pdu.id)}>
      <td className="mono">{fmtSimTime(ev.t)}</td>
      <td className="num">{ev.pdu.id}</td>
      <td>{line.from}</td>
      <td>{line.to}</td>
      <td>
        <span className={`proto-chip ${protoClass(ev.pdu.proto)}`}>{ev.pdu.proto}</span>
      </td>
      <td className="ev-msg" title={ev.pdu.tag}>
        {ev.pdu.summary}
      </td>
      <td className="num">{ev.pdu.size}</td>
    </tr>
  );
});

// ── Events ──────────────────────────────────────────────────────────────────

const ALL_KINDS: readonly TraceKind[] = [
  'frameTx',
  'frameRx',
  'drop',
  'pduCreated',
  'pduConsumed',
  'mutation',
  'tableWrite',
  'tableExpire',
  'debug',
  'log',
  'linkState',
  'portState',
  'deviceState',
  'cliOutput',
  'cliPrompt',
  'configChange',
  'topologyChanged',
];

const DEFAULT_HIDDEN: readonly TraceKind[] = ['cliPrompt'];

const onOff = (v: boolean): string => (v ? 'up' : 'down');

/** One-line human description of a trace event (original wording). */
export function describeEvent(ev: TraceEvent, idx: Index): string {
  switch (ev.kind) {
    case 'frameTx':
      return `#${ev.pdu.id} sent ${portLabel(idx, ev.from)} → ${portLabel(idx, ev.to)}: ${ev.pdu.summary} (${ev.pdu.size} B)`;
    case 'frameRx':
      return `#${ev.pdu.id} received on ${portLabel(idx, { device: ev.device, port: ev.port })}: ${ev.pdu.summary}`;
    case 'drop': {
      const where =
        ev.device !== undefined
          ? ev.port !== undefined
            ? portLabel(idx, { device: ev.device, port: ev.port })
            : deviceName(idx, ev.device)
          : `cable ${ev.link ?? '?'}`;
      return `#${ev.pdu.id} dropped at ${where}: ${DROP_LABEL[ev.reason] ?? ev.reason}${ev.detail ? ` — ${ev.detail}` : ''}`;
    }
    case 'pduCreated':
      return `${deviceName(idx, ev.device)} ${ev.process} created #${ev.pdu.id}: ${ev.pdu.summary}`;
    case 'pduConsumed':
      return `${deviceName(idx, ev.device)} ${ev.process} accepted #${ev.pdu.id}: ${ev.pdu.summary}`;
    case 'mutation': {
      const m = ev.mutation;
      const change =
        m.reason === 'Encapsulate'
          ? `+${String(m.after ?? m.field)} header`
          : `${m.field} ${fmtMutationValue(m.field, m.before)} → ${fmtMutationValue(m.field, m.after)}`;
      return `#${ev.pdu} at ${deviceName(idx, m.device)}: ${change} (${m.reason})${m.cause ? ` “${m.cause}”` : ''}`;
    }
    case 'tableWrite':
      return `${deviceName(idx, ev.device)} ${ev.table} ${ev.previous ? 'refreshed' : 'added'} ${ev.key}`;
    case 'tableExpire':
      return `${deviceName(idx, ev.device)} ${ev.table} removed ${ev.key} (${ev.reason})`;
    case 'debug':
      return `${deviceName(idx, ev.event.device)} [${ev.event.category}] ${ev.event.message}`;
    case 'log':
      return `${deviceName(idx, ev.device)} ${ev.facility} (level ${ev.severity}): ${ev.message}`;
    case 'linkState':
      return `cable ${ev.link} is ${onOff(ev.up)}${ev.reason ? ` (${ev.reason})` : ''}`;
    case 'portState':
      return `${portLabel(idx, { device: ev.device, port: ev.port })}: admin ${onOff(ev.adminUp)}, line ${onOff(ev.operUp)}${ev.reason ? ` (${ev.reason})` : ''}`;
    case 'deviceState':
      return `${deviceName(idx, ev.device)} ${ev.power ? (ev.booted ? 'booted' : 'powering on') : 'powered off'}`;
    case 'cliOutput':
      return `session ${ev.session} printed ${ev.text.length} character${ev.text.length === 1 ? '' : 's'}`;
    case 'cliPrompt':
      return `session ${ev.session} prompt ${ev.prompt}${ev.busy ? ' (busy)' : ''}`;
    case 'configChange': {
      const ctx = ev.context.map((c) => c.join(' ')).join(' › ');
      return `${deviceName(idx, ev.device)} config: ${ev.negate ? 'no ' : ''}${ev.line}${ctx ? ` [in ${ctx}]` : ''}`;
    }
    case 'topologyChanged':
      return `${ev.what} ${ev.id} ${ev.op === 'add' ? 'added' : ev.op === 'remove' ? 'removed' : 'moved'}`;
    default:
      return '';
  }
}

interface EventLine {
  ev: TraceEvent;
  text: string;
}

export function EventsPanel() {
  const events = useStore((s) => s.events);
  const dropped = useStore((s) => s.droppedEvents);
  const devices = useDeviceIndex();
  const selectedPdu = useSelectedPduId();
  const [hidden, setHidden] = useState<ReadonlySet<TraceKind>>(() => new Set(DEFAULT_HIDDEN));
  const [query, setQuery] = useState('');
  const [frozen, setFrozen] = useState<readonly TraceEvent[] | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<TraceEvent>>(() => new Set());
  const follow = frozen === null;
  const source = frozen ?? events;

  const counts = useMemo(() => {
    const c = new Map<TraceKind, number>();
    for (const ev of source) c.set(ev.kind, (c.get(ev.kind) ?? 0) + 1);
    return c;
  }, [source]);

  const { lines, total } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const picked: TraceEvent[] = [];
    if (!q) {
      for (let i = source.length - 1; i >= 0 && picked.length < MAX_EVENT_ROWS; i--) {
        const ev = source[i];
        if (ev && !hidden.has(ev.kind)) picked.push(ev);
      }
      let totalVisible = 0;
      for (const ev of source) if (!hidden.has(ev.kind)) totalVisible++;
      picked.reverse();
      return { lines: picked.map((ev) => ({ ev, text: describeEvent(ev, devices) })), total: totalVisible };
    }
    const out: EventLine[] = [];
    for (const ev of source) {
      if (hidden.has(ev.kind)) continue;
      const text = describeEvent(ev, devices);
      const hay = ev.kind === 'cliOutput' ? `${text} ${ev.text}` : `${ev.kind} ${text}`;
      if (hay.toLowerCase().includes(q)) out.push({ ev, text });
    }
    return { lines: out.slice(-MAX_EVENT_ROWS), total: out.length };
  }, [source, hidden, query, devices]);

  const scrollRef = useFollowScroll(lines, follow);

  const toggleKind = (k: TraceKind): void => {
    setHidden((cur) => {
      const next = new Set(cur);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const onToggleExpand = useCallback((ev: TraceEvent) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(ev)) next.delete(ev);
      else next.add(ev);
      return next;
    });
  }, []);

  const onActivate = useCallback((ev: TraceEvent) => {
    const select = store.getState().select;
    const pdu = pduIdOf(ev);
    if (pdu !== undefined) return select({ kind: 'pdu', id: pdu });
    switch (ev.kind) {
      case 'tableWrite':
      case 'tableExpire':
      case 'log':
      case 'deviceState':
      case 'configChange':
        return select({ kind: 'device', id: ev.device });
      case 'portState':
        return select({ kind: 'port', ref: { device: ev.device, port: ev.port } });
      case 'debug':
        return select({ kind: 'device', id: ev.event.device });
      case 'linkState':
        return select({ kind: 'link', id: ev.link });
      default:
        return undefined;
    }
  }, []);

  return (
    <div className="dock-panel">
      <div className="dock-toolbar">
        <input
          className="input"
          type="search"
          placeholder="Filter events…"
          aria-label="Filter events"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className={`btn${follow ? ' is-active' : ''}`}
          aria-pressed={follow}
          onClick={() => setFrozen(follow ? events : null)}
        >
          {follow ? '⏸ Pause list' : '▶ Follow new'}
        </button>
        <span className="spacer" />
        {dropped > 0 && <span className="chip warn">⚠ {dropped} older events were not kept</span>}
        <span>
          {total > lines.length ? `newest ${lines.length} of ${total}` : total} shown
        </span>
      </div>
      <div className="dock-toolbar" role="group" aria-label="Event kinds">
        {ALL_KINDS.map((k) => {
          const off = hidden.has(k);
          return (
            <button
              key={k}
              type="button"
              className={`chip chip-toggle${off ? ' is-off' : ''}`}
              aria-pressed={!off}
              title={off ? `Show ${k} events` : `Hide ${k} events`}
              onClick={() => toggleKind(k)}
            >
              {off ? '○' : '●'} {k} {counts.get(k) ?? 0}
            </button>
          );
        })}
      </div>
      <div className="dock-scroll" ref={scrollRef}>
        {lines.length === 0 ? (
          <div className="dock-hint">No events to show. Run the simulation or change the filter.</div>
        ) : (
          <table className="table compact">
            <tbody>
              {lines.map((l, i) => (
                <EventRow
                  key={i + (source.length - lines.length)}
                  line={l}
                  expanded={expanded.has(l.ev)}
                  selected={selectedPdu !== null && pduIdOf(l.ev) === selectedPdu}
                  onToggleExpand={onToggleExpand}
                  onActivate={onActivate}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const EventRow = memo(function EventRow({
  line,
  expanded,
  selected,
  onToggleExpand,
  onActivate,
}: {
  line: EventLine;
  expanded: boolean;
  selected: boolean;
  onToggleExpand(ev: TraceEvent): void;
  onActivate(ev: TraceEvent): void;
}) {
  const { ev, text } = line;
  return (
    <tr className={`is-clickable${selected ? ' is-selected' : ''}`} onClick={() => onActivate(ev)}>
      <td className="mono">{fmtSimTime(ev.t)}</td>
      <td>
        <span className={`ev-kind ${ev.kind}`}>
          {ev.kind === 'drop' ? '✗ ' : ''}
          {ev.kind}
        </span>
      </td>
      <td className="ev-msg" style={{ whiteSpace: 'pre-wrap' }}>
        {ev.kind === 'cliOutput' ? (
          <>
            <button
              type="button"
              className="ev-collapsed"
              aria-expanded={expanded}
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpand(ev);
              }}
            >
              {expanded ? '▾' : '▸'} {text}
            </button>
            {expanded && <pre className="ev-msg">{ev.text}</pre>}
          </>
        ) : (
          text
        )}
      </td>
    </tr>
  );
});

// ── Tables ──────────────────────────────────────────────────────────────────

export function TablesPanel() {
  const devices = useStore((s) => s.snapshot?.devices);
  const now = useTickNow();
  if (!devices || devices.length === 0) {
    return <div className="empty-hint">Add devices to the canvas; their MAC, ARP and routing tables appear here side by side.</div>;
  }
  return (
    <div className="dock-tables">
      {devices.map((d) => (
        <div className="dev-col" key={d.id}>
          <h3>
            <button
              type="button"
              className="link-btn"
              onClick={() => store.getState().select({ kind: 'device', id: d.id })}
            >
              {d.name}
            </button>
            <span className="sub">
              {d.model}
              {d.power ? '' : ' · off'}
            </span>
          </h3>
          <TablesView device={d} compact now={now} />
        </div>
      ))}
    </div>
  );
}

// ── Provenance ──────────────────────────────────────────────────────────────

const PROVENANCE_SCAN = 5000;

export function ProvenancePanel() {
  const selectedPdu = useSelectedPduId();
  const newest = useStore((s) => {
    if (s.selection?.kind === 'pdu') return null;
    for (let i = s.events.length - 1, n = 0; i >= 0 && n < PROVENANCE_SCAN; i--, n++) {
      const ev = s.events[i];
      if (ev?.kind === 'pduCreated') return ev.pdu.id;
    }
    return null;
  });
  const following = selectedPdu === null;
  return (
    <div className="dock-panel">
      <Provenance pduId={selectedPdu ?? newest} following={following && newest !== null} />
    </div>
  );
}
