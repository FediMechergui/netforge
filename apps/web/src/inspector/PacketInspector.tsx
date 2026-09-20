/**
 * Packet inspector (spec §9.2): header with lineage links, one card per decoded
 * layer (width ∝ bytes), fields as name = value, and a synchronized hex view.
 *
 * Also hosts the small shared helpers of the inspector module: the PduJson cache
 * (`fetchPdu`, `usePduJson`), the device index hook, value formatters and the
 * dock-reveal helper. They live here (not in a separate file) because the module
 * owns a fixed file list.
 */
import { memo, useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import type {
  DeviceId,
  DeviceSnapshot,
  FieldValue,
  LayerView,
  PduId,
  PduJson,
  PortRef,
  TraceEvent,
} from '@netforge/engine';
import { engine, fmtSimTime } from '../bridge/client';
import { store, useStore } from '../store/store';
import type { DockTab } from '../store/types';
import { HexView, protoClass, type ByteRange } from './HexView';
import './inspector.css';

// ── shared helpers ──────────────────────────────────────────────────────────

export type EventOf<K extends TraceEvent['kind']> = Extract<TraceEvent, { kind: K }>;

/** Dock heights at or below this are the collapsed tab strip (mirrors app/Dock). */
const DOCK_COLLAPSED_MAX = 30;
const DOCK_REVEAL_HEIGHT = 260;

export function revealDockTab(tab: DockTab): void {
  const st = store.getState();
  st.setDockTab(tab);
  if (st.dockHeight <= DOCK_COLLAPSED_MAX) st.setDockHeight(DOCK_REVEAL_HEIGHT);
}

export function toastError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  store.getState().toast(msg, 'error');
}

export function selectPdu(id: PduId): void {
  store.getState().select({ kind: 'pdu', id });
}

/** The PDU id an event is about, if any. */
export function pduIdOf(ev: TraceEvent): PduId | undefined {
  switch (ev.kind) {
    case 'frameTx':
    case 'frameRx':
    case 'drop':
    case 'pduCreated':
    case 'pduConsumed':
      return ev.pdu.id;
    case 'mutation':
      return ev.pdu;
    default:
      return undefined;
  }
}

/** Snapshot devices by id; stable between snapshots. */
export function useDeviceIndex(): ReadonlyMap<DeviceId, DeviceSnapshot> {
  const devices = useStore((s) => s.snapshot?.devices);
  return useMemo(() => new Map((devices ?? []).map((d) => [d.id, d] as const)), [devices]);
}

export function deviceName(index: ReadonlyMap<DeviceId, DeviceSnapshot>, id: DeviceId): string {
  return index.get(id)?.name ?? id;
}

export function portShort(index: ReadonlyMap<DeviceId, DeviceSnapshot>, device: DeviceId, port: string): string {
  return index.get(device)?.ports.find((p) => p.id === port)?.short ?? port;
}

export function portLabel(index: ReadonlyMap<DeviceId, DeviceSnapshot>, ref: PortRef): string {
  return `${deviceName(index, ref.device)} ${portShort(index, ref.device, ref.port)}`;
}

// ── PduJson cache ───────────────────────────────────────────────────────────

const PDU_CACHE_MAX = 50;
const pduCache = new Map<PduId, PduJson>();

// A new simulation generation (reset / load) restarts PDU ids: every cached PDU is stale.
// Registered at module load so it runs before any usePduJson subscriber.
store.subscribe((s, prev) => {
  if (s.epoch !== prev.epoch) pduCache.clear();
});

function remember(p: PduJson): void {
  pduCache.delete(p.id);
  pduCache.set(p.id, p);
  while (pduCache.size > PDU_CACHE_MAX) {
    const oldest = pduCache.keys().next();
    if (oldest.done) break;
    pduCache.delete(oldest.value);
  }
}

/** Fetch a PDU from the engine (served from the cache unless `fresh`). */
export async function fetchPdu(id: PduId, fresh = false): Promise<PduJson | undefined> {
  if (!fresh) {
    const hit = pduCache.get(id);
    if (hit) return hit;
  }
  const p = await engine.pdu(id);
  if (p) remember(p);
  return p;
}

const PDU_REFRESH_MS = 200;
const EVENT_SCAN_LIMIT = 4000;

function newEventsTouch(next: readonly TraceEvent[], prev: readonly TraceEvent[], id: PduId): boolean {
  const prevLast = prev[prev.length - 1];
  for (let i = next.length - 1, n = 0; i >= 0 && n < EVENT_SCAN_LIMIT; i--, n++) {
    const ev = next[i];
    if (ev === undefined || ev === prevLast) return false;
    if (pduIdOf(ev) === id) return true;
  }
  return false;
}

/**
 * The PduJson for `id`, fetched on change and refreshed (debounced) whenever a new
 * trace event mentions that PDU — its provenance grows as it crosses devices.
 */
export function usePduJson(id: PduId | null): { pdu: PduJson | undefined; missing: boolean } {
  const [state, setState] = useState<{ id: PduId | null; pdu: PduJson | undefined; missing: boolean }>(() => ({
    id,
    pdu: id === null ? undefined : pduCache.get(id),
    missing: false,
  }));

  useEffect(() => {
    if (id === null) {
      setState({ id: null, pdu: undefined, missing: false });
      return;
    }
    let alive = true;
    let seq = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = (): void => {
      const mine = ++seq;
      fetchPdu(id, true)
        .then((p) => {
          if (alive && mine === seq) setState({ id, pdu: p, missing: p === undefined });
        })
        .catch(() => {
          if (alive && mine === seq) setState((prev) => ({ id, pdu: prev.id === id ? prev.pdu : undefined, missing: true }));
        });
    };
    const schedule = (): void => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        load();
      }, PDU_REFRESH_MS);
    };

    setState({ id, pdu: pduCache.get(id), missing: false });
    load();
    const unsubscribe = store.subscribe((s, prev) => {
      if (s.epoch !== prev.epoch) {
        // Reset / load: ids restart; the module-level listener already cleared the cache.
        pduCache.clear();
        schedule();
        return;
      }
      if (s.events !== prev.events && newEventsTouch(s.events, prev.events, id)) schedule();
    });
    return () => {
      alive = false;
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [id]);

  if (state.id === id) return { pdu: state.pdu, missing: state.missing };
  return { pdu: id === null ? undefined : pduCache.get(id), missing: false };
}

// ── value formatting ────────────────────────────────────────────────────────

const hex = (v: number, width: number): string => `0x${(v >>> 0).toString(16).padStart(width, '0')}`;

const ETHERTYPE_NAMES: Record<number, string> = {
  0x0800: 'IPv4',
  0x0806: 'ARP',
  0x8100: '802.1Q tag',
  0x86dd: 'IPv6',
};
const IP_PROTOCOL_NAMES: Record<number, string> = { 1: 'ICMP', 6: 'TCP', 17: 'UDP' };
const ICMP_TYPE_NAMES: Record<number, string> = {
  0: 'echo reply',
  3: 'destination unreachable',
  8: 'echo request',
  11: 'time exceeded',
};
const ARP_OP_NAMES: Record<number, string> = { 1: 'request', 2: 'reply' };

function named(v: number, text: string | undefined, shown: string = String(v)): string {
  return text === undefined ? shown : `${shown} (${text})`;
}

function fmtByteArray(b: Uint8Array): string {
  const head = Array.from(b.subarray(0, 12), (x) => x.toString(16).padStart(2, '0')).join(' ');
  return `${b.length} bytes${b.length > 0 ? `: ${head}${b.length > 12 ? ' …' : ''}` : ''}`;
}

/** Human rendering of a decoded field value. */
export function fmtValue(proto: string, field: string, v: FieldValue | undefined): string {
  if (v === null || v === undefined) return '—';
  if (v instanceof Uint8Array) return fmtByteArray(v);
  if (typeof v === 'boolean') return field.endsWith('Valid') ? (v ? '✓ valid' : '✗ invalid') : v ? 'yes' : 'no';
  if (typeof v === 'string') return v;
  switch (`${proto}.${field}`) {
    case 'ethernet.type':
      return named(v, ETHERTYPE_NAMES[v], hex(v, 4));
    case 'ethernet.fcs':
      return hex(v, 8);
    case 'arp.htype':
    case 'arp.ptype':
    case 'ipv4.checksum':
    case 'icmpv4.checksum':
    case 'udp.checksum':
    case 'tcp.checksum':
      return hex(v, 4);
    case 'arp.op':
      return named(v, ARP_OP_NAMES[v]);
    case 'ipv4.protocol':
      return named(v, IP_PROTOCOL_NAMES[v]);
    case 'ipv4.id':
      return `${v} (${hex(v, 4)})`;
    case 'icmpv4.type':
      return named(v, ICMP_TYPE_NAMES[v]);
    case 'raw.bytes':
      return hex(v, 2);
    default:
      return String(v);
  }
}

/** Mutation values carry the dotted field path (`ipv4.ttl`). */
export function fmtMutationValue(path: string, v: FieldValue | undefined): string {
  const dot = path.indexOf('.');
  if (dot < 0) return fmtValue(path, '', v);
  const s = fmtValue(path.slice(0, dot), path.slice(dot + 1), v);
  // Chips stay short: drop the "(name)" annotation.
  const paren = s.indexOf(' (');
  return paren > 0 && !s.startsWith('✓') && !s.startsWith('✗') ? s.slice(0, paren) : s;
}

// ── component ───────────────────────────────────────────────────────────────

interface HotField {
  layer: number;
  field: string;
}

export function PacketInspector({ pdu }: { pdu: PduJson }) {
  const [selectedLayer, setSelectedLayer] = useState<number | null>(null);
  const [hot, setHot] = useState<HotField | null>(null);
  const devices = useDeviceIndex();

  useEffect(() => {
    setSelectedLayer(null);
    setHot(null);
  }, [pdu.id]);

  const toggleLayer = useCallback((i: number) => {
    setSelectedLayer((cur) => (cur === i ? null : i));
  }, []);
  const hoverField = useCallback((h: HotField | null) => setHot(h), []);

  const size = pdu.bytes.length;
  const selLayerView = selectedLayer === null ? undefined : pdu.layers[selectedLayer];
  const selectedRange: ByteRange | null = selLayerView ? [selLayerView.offset, selLayerView.length] : null;
  const hotRange: ByteRange | null = (hot && pdu.layers[hot.layer]?.fieldRanges[hot.field]) || null;

  const { meta } = pdu;
  const originName = deviceName(devices, meta.origin);

  return (
    <div className="pk">
      <div className="pk-head">
        <div className="insp-title-row">
          <span className={`proto-chip ${protoClass(pdu.topProto)}`}>{pdu.topProto}</span>
          <span className="insp-title mono">Packet #{pdu.id}</span>
        </div>
        <div className="pk-summary">{pdu.summary}</div>
        <div className="pk-meta">
          <span>{size} bytes on the wire</span>
          <span>born {fmtSimTime(meta.born)}</span>
          <span>
            created on{' '}
            <button
              type="button"
              className="link-btn"
              onClick={() => store.getState().select({ kind: 'device', id: meta.origin })}
            >
              {originName}
            </button>
          </span>
          {meta.tag !== undefined && <span className="chip tiny">tag {meta.tag}</span>}
          {meta.flow !== undefined && <span className="chip tiny" title="Conversation key">{meta.flow}</span>}
        </div>
        <div className="pk-meta">
          {meta.parent !== undefined && (
            <span>
              copy of{' '}
              <button type="button" className="link-btn" onClick={() => selectPdu(meta.parent as PduId)}>
                #{meta.parent}
              </button>
            </span>
          )}
          {meta.triggeredBy !== undefined && (
            <span>
              caused by{' '}
              <button type="button" className="link-btn" onClick={() => selectPdu(meta.triggeredBy as PduId)}>
                #{meta.triggeredBy}
              </button>
            </span>
          )}
          <span>
            {pdu.provenance.length} recorded change{pdu.provenance.length === 1 ? '' : 's'} ·{' '}
            <button type="button" className="link-btn" onClick={() => revealDockTab('provenance')}>
              open the provenance timeline
            </button>
          </span>
        </div>
      </div>

      <div className="pk-layers">
        {pdu.layers.length === 0 && <div className="insp-note">The decoder found no layers in these bytes.</div>}
        {pdu.layers.map((layer, i) => (
          <LayerCard
            key={`${i}:${layer.proto}:${layer.offset}`}
            layer={layer}
            index={i}
            total={size}
            selected={selectedLayer === i}
            hotField={hot && hot.layer === i ? hot.field : null}
            onToggle={toggleLayer}
            onHover={hoverField}
          />
        ))}
      </div>

      <div className="pk-hexwrap">
        <h4>Bytes</h4>
        <div className="pk-legend">
          {pdu.layers.map((layer, i) => (
            <span key={i} className={protoClass(layer.proto)}>
              <span className="sw" aria-hidden="true" />
              {layer.proto} {layer.offset}–{layer.offset + layer.length - 1}
            </span>
          ))}
          <span>underlined = inside a layer · bold = hovered field</span>
        </div>
        <HexView bytes={pdu.bytes} layers={pdu.layers} selected={selectedRange} hot={hotRange} />
      </div>
    </div>
  );
}

interface LayerCardProps {
  layer: LayerView;
  index: number;
  total: number;
  selected: boolean;
  hotField: string | null;
  onToggle(i: number): void;
  onHover(h: HotField | null): void;
}

const MIN_LAYER_PCT = 40;

const LayerCard = memo(function LayerCard({ layer, index, total, selected, hotField, onToggle, onHover }: LayerCardProps) {
  const pct = total > 0 ? Math.max(MIN_LAYER_PCT, Math.round((layer.length / total) * 100)) : 100;
  const style = { '--w': `${Math.min(100, pct)}%` } as CSSProperties;
  const end = layer.offset + layer.length - 1;
  const fields = Object.entries(layer.fields);
  return (
    <div className={`pk-layer ${protoClass(layer.proto)}${selected ? ' is-selected' : ''}`} style={style}>
      <button
        type="button"
        className="pk-layer-head"
        aria-pressed={selected}
        title={selected ? 'Clear the byte highlight' : 'Highlight this layer in the hex view'}
        onClick={() => onToggle(index)}
      >
        <span className="proto">{layer.proto}</span>
        <span className="dim">
          {layer.headerLength} B header{layer.trailerLength ? ` + ${layer.trailerLength} B trailer` : ''}
        </span>
        {layer.error !== undefined && <span className="err">⚠ {layer.error}</span>}
        <span className="range">
          bytes {layer.offset}–{end} ({layer.length})
        </span>
      </button>
      {fields.length > 0 && (
        <dl className="pk-fields" onMouseLeave={() => onHover(null)}>
          {fields.map(([name, value]) => {
            const text = fmtValue(layer.proto, name, value);
            const validity =
              typeof value === 'boolean' && name.endsWith('Valid') ? (value ? 'valid' : 'invalid') : undefined;
            const hasRange = layer.fieldRanges[name] !== undefined;
            return (
              <div
                key={name}
                className={`pk-field${hotField === name ? ' is-hot' : ''}`}
                onMouseEnter={() => onHover(hasRange ? { layer: index, field: name } : null)}
              >
                <dt>{name}</dt>
                <dd>{validity ? <span className={validity}>{text}</span> : text}</dd>
              </div>
            );
          })}
        </dl>
      )}
    </div>
  );
});
