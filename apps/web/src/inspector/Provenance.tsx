/**
 * Header provenance timeline (spec §9.3 — the flagship).
 *
 * For one PDU: a horizontal row of hops (a device visit each), built from the
 * PDU's provenance log merged with the frameRx/frameTx/drop/pduConsumed trace
 * events for that id. Under each hop only the fields that changed THERE are
 * shown as before → after chips, coloured and lettered by mutation reason, with
 * derived checksum/FCS updates tucked behind a toggle and the responsible cause
 * quoted (click → that device's config). Above it, the "family" strip: the
 * packets this one came from or caused (ARP request/reply, echo reply, flood
 * copies), assembled from `meta.parent` / `meta.triggeredBy`.
 */
import { memo, useEffect, useMemo, useState } from 'react';
import type {
  DeviceId,
  DeviceSnapshot,
  LinkId,
  Mutation,
  MutationReason,
  PduId,
  PduJson,
  PortId,
  SimTime,
  TraceEvent,
} from '@netforge/engine';
import { fmtDuration, fmtSimTime } from '../bridge/client';
import { store, useStore } from '../store/store';
import { openDeviceTab } from './DeviceInspector';
import { protoClass } from './HexView';
import {
  deviceName,
  fetchPdu,
  fmtMutationValue,
  pduIdOf,
  portShort,
  selectPdu,
  useDeviceIndex,
  usePduJson,
} from './PacketInspector';
import './inspector.css';

// ── vocabularies (original wording) ─────────────────────────────────────────

export const DROP_LABEL: Record<string, string> = {
  'link-down': 'link is down',
  'link-loss': 'lost on the cable',
  'fcs-error': 'bad frame checksum',
  runt: 'frame too short',
  giant: 'frame too long',
  'port-admin-down': 'port not accepting frames',
  'port-err-disabled': 'port error-disabled',
  'queue-full': 'queue full',
  'no-route': 'no route',
  'ttl-expired': 'TTL expired',
  'arp-unresolved': 'next hop never answered ARP',
  'not-for-me': 'not addressed to this device',
  'unsupported-ethertype': 'unknown ethertype',
  'unsupported-protocol': 'no handler for protocol',
  'bad-checksum': 'bad header checksum',
  'no-l3-address': 'no IPv4 address on interface',
  'acl-deny': 'denied by access list',
  other: 'discarded',
  collision: 'collided on a shared segment',
  'late-collision': 'late collision on a shared segment',
  'excessive-collisions': 'too many collisions, frame abandoned',
  'out-of-range': 'receiver out of radio range',
  'not-associated': 'station not associated',
  'encapsulation-mismatch': 'serial encapsulation mismatch',
  'out-of-band': 'console line carries no data frames',
};

const REASON_ICON: Record<MutationReason, string> = {
  TtlDecrement: 'T',
  MacRewrite: 'M',
  ChecksumRecompute: 'Σ',
  FcsRecompute: 'Σ',
  VlanTagPush: 'V+',
  VlanTagPop: 'V−',
  NatTranslate: 'N',
  FragmentSplit: 'F',
  Encrypt: 'E',
  Decrypt: 'D',
  Corruption: '!',
  Padding: 'P',
  Encapsulate: '+',
  Other: '•',
  Decapsulate: '−',
};

const REASON_LABEL: Record<MutationReason, string> = {
  TtlDecrement: 'TTL decremented while forwarding',
  MacRewrite: 'MAC addresses rewritten for the next hop',
  ChecksumRecompute: 'Checksum recomputed after a change',
  FcsRecompute: 'Frame checksum recomputed after a change',
  VlanTagPush: 'VLAN tag added',
  VlanTagPop: 'VLAN tag removed',
  NatTranslate: 'Address translated',
  FragmentSplit: 'Packet fragmented',
  Encrypt: 'Payload encrypted',
  Decrypt: 'Payload decrypted',
  Corruption: 'Bits flipped on the wire',
  Padding: 'Padding adjusted',
  Encapsulate: 'Header pushed around the packet',
  Other: 'Field changed',
  Decapsulate: 'Header removed from around the packet',
};

const DERIVED = new Set<string>(['ChecksumRecompute', 'FcsRecompute']);

const reasonKey = (r: string): MutationReason => (r in REASON_ICON ? (r as MutationReason) : 'Other');

// ── hop model ───────────────────────────────────────────────────────────────

type ItemKind = 'origin' | 'rx' | 'mut' | 'tx' | 'drop' | 'consumed';

const RANK: Record<ItemKind, number> = { origin: 0, rx: 1, mut: 2, tx: 3, drop: 4, consumed: 5 };

interface Item {
  t: SimTime;
  kind: ItemKind;
  order: number;
  device?: DeviceId;
  link?: LinkId;
  ev?: TraceEvent;
  mut?: Mutation;
}

export interface Hop {
  key: string;
  device?: DeviceId;
  link?: LinkId;
  t0: SimTime;
  origin: boolean;
  inPorts: PortId[];
  outPorts: PortId[];
  mutations: Mutation[];
  drop?: { reason: string; detail?: string };
  consumedBy?: string;
  /** Wire time of the frame leaving this hop. */
  wire?: { link: LinkId; ns: SimTime };
}

const pushUnique = (list: string[], v: string): void => {
  if (!list.includes(v)) list.push(v);
};

export function buildHops(pdu: PduJson, events: readonly TraceEvent[]): Hop[] {
  const items: Item[] = [];
  const firstMutation = pdu.provenance[0];
  const originT = firstMutation ? Math.min(pdu.meta.born, firstMutation.at) : pdu.meta.born;
  items.push({ t: originT, kind: 'origin', order: 0, device: pdu.meta.origin });

  events.forEach((ev, i) => {
    if (pduIdOf(ev) !== pdu.id) return;
    const order = i + 1;
    switch (ev.kind) {
      case 'frameRx':
        items.push({ t: ev.t, kind: 'rx', order, device: ev.device, ev });
        break;
      case 'frameTx':
        items.push({ t: ev.t, kind: 'tx', order, device: ev.from.device, ev });
        break;
      case 'drop':
        if (ev.device !== undefined) items.push({ t: ev.t, kind: 'drop', order, device: ev.device, ev });
        else items.push({ t: ev.t, kind: 'drop', order, link: ev.link ?? 'unknown', ev });
        break;
      case 'pduConsumed':
        items.push({ t: ev.t, kind: 'consumed', order, device: ev.device, ev });
        break;
      default:
        break;
    }
  });
  pdu.provenance.forEach((m, i) => items.push({ t: m.at, kind: 'mut', order: i, device: m.device, mut: m }));

  items.sort((a, b) => a.t - b.t || RANK[a.kind] - RANK[b.kind] || a.order - b.order);

  const hops: Hop[] = [];
  let cur: Hop | undefined;
  for (const it of items) {
    const place = it.device !== undefined ? `d:${it.device}` : `l:${it.link ?? ''}`;
    const curPlace = cur ? (cur.device !== undefined ? `d:${cur.device}` : `l:${cur.link ?? ''}`) : '';
    if (!cur || place !== curPlace || cur.drop || cur.consumedBy !== undefined) {
      cur = {
        key: `${hops.length}:${place}`,
        t0: it.t,
        origin: it.kind === 'origin',
        inPorts: [],
        outPorts: [],
        mutations: [],
      };
      if (it.device !== undefined) cur.device = it.device;
      if (it.link !== undefined) cur.link = it.link;
      hops.push(cur);
    }
    const ev = it.ev;
    switch (it.kind) {
      case 'rx':
        if (ev?.kind === 'frameRx') pushUnique(cur.inPorts, ev.port);
        break;
      case 'tx':
        if (ev?.kind === 'frameTx') {
          pushUnique(cur.outPorts, ev.from.port);
          cur.wire = { link: ev.link, ns: ev.arrive - ev.txStart };
        }
        break;
      case 'mut':
        if (it.mut) cur.mutations.push(it.mut);
        break;
      case 'drop':
        if (ev?.kind === 'drop') {
          cur.drop = ev.detail !== undefined ? { reason: ev.reason, detail: ev.detail } : { reason: ev.reason };
          if (ev.port !== undefined) pushUnique(cur.inPorts, ev.port);
        }
        break;
      case 'consumed':
        if (ev?.kind === 'pduConsumed') cur.consumedBy = ev.process;
        break;
      default:
        break;
    }
  }
  return hops;
}

// ── family ──────────────────────────────────────────────────────────────────

const FAMILY_MAX = 40;
const CANDIDATE_MAX = 60;
const ID_WINDOW = 80;

async function buildFamily(focus: PduJson, events: readonly TraceEvent[]): Promise<PduJson[]> {
  const family = new Map<PduId, PduJson>([[focus.id, focus]]);

  // Ancestors: follow parent / triggeredBy upward.
  const queue: PduJson[] = [focus];
  while (queue.length > 0 && family.size < FAMILY_MAX) {
    const p = queue.shift();
    if (!p) break;
    for (const up of [p.meta.parent, p.meta.triggeredBy]) {
      if (up === undefined || family.has(up)) continue;
      const j = await fetchPdu(up);
      if (j) {
        family.set(up, j);
        queue.push(j);
      }
    }
  }

  // Descendants: later PDUs seen in the trace whose lineage points into the family.
  const minId = Math.min(...family.keys());
  const maxId = Math.max(...family.keys());
  const flows = new Set([...family.values()].map((p) => p.meta.flow).filter((f): f is string => f !== undefined));
  const candidateIds: PduId[] = [];
  const seen = new Set<PduId>();
  for (const ev of events) {
    if (ev.kind !== 'pduCreated' && ev.kind !== 'frameTx') continue;
    const s = ev.pdu;
    if (s.id <= minId || family.has(s.id) || seen.has(s.id)) continue;
    const related =
      (s.parent !== undefined && family.has(s.parent)) ||
      (s.flow !== undefined && flows.has(s.flow)) ||
      s.id <= maxId + ID_WINDOW;
    if (!related) continue;
    seen.add(s.id);
    candidateIds.push(s.id);
  }
  candidateIds.sort((a, b) => a - b);
  const candidates: PduJson[] = [];
  for (const id of candidateIds.slice(0, CANDIDATE_MAX)) {
    const j = await fetchPdu(id);
    if (j) candidates.push(j);
  }
  let grew = true;
  while (grew && family.size < FAMILY_MAX) {
    grew = false;
    for (const c of candidates) {
      if (family.has(c.id)) continue;
      const { parent, triggeredBy } = c.meta;
      if ((parent !== undefined && family.has(parent)) || (triggeredBy !== undefined && family.has(triggeredBy))) {
        family.set(c.id, c);
        grew = true;
      }
    }
  }
  return [...family.values()].sort((a, b) => a.id - b.id);
}

function useFamily(focus: PduJson | undefined, pduCount: number): PduJson[] {
  const [state, setState] = useState<{ id: PduId; list: PduJson[] } | null>(null);
  useEffect(() => {
    if (!focus) return;
    let alive = true;
    const timer = setTimeout(() => {
      buildFamily(focus, store.getState().events)
        .then((list) => {
          if (alive) setState({ id: focus.id, list });
        })
        .catch(() => undefined);
    }, 120);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [focus, pduCount]);
  if (!focus) return [];
  return state && state.id === focus.id ? state.list : [focus];
}

function roleOf(p: PduJson, focus: PduJson): string {
  if (p.id === focus.id) return 'this packet';
  if (focus.meta.triggeredBy === p.id) return 'caused this';
  if (focus.meta.parent === p.id) return 'copied from';
  if (p.meta.triggeredBy === focus.id) return 'caused by this';
  if (p.meta.parent === focus.id) return 'copy of this';
  return p.meta.tag ?? 'related';
}

// ── components ──────────────────────────────────────────────────────────────

interface ProvenanceProps {
  pduId: PduId | null;
  /** True when the panel is tracking the newest packet rather than a selection. */
  following?: boolean;
}

export function Provenance({ pduId, following = false }: ProvenanceProps) {
  const [override, setOverride] = useState<PduId | null>(null);
  useEffect(() => {
    setOverride(null);
  }, [pduId]);

  const focusId = following ? pduId : (override ?? pduId);
  const { pdu, missing } = usePduJson(focusId);
  const events = useStore((s) => s.events);
  const pduCount = useStore((s) => s.snapshot?.pduCount ?? 0);
  const devices = useDeviceIndex();
  const family = useFamily(pdu, pduCount);
  const hops = useMemo(() => (pdu ? buildHops(pdu, events) : []), [pdu, events]);

  if (focusId === null) return <ProvenanceEmpty />;
  if (!pdu) {
    return (
      <div className="empty-hint">
        {missing
          ? `Packet #${focusId} is no longer held by the engine (it may have been cleared by a reset).`
          : `Loading packet #${focusId}…`}
      </div>
    );
  }

  const pick = (id: PduId): void => {
    if (following) selectPdu(id);
    else setOverride(id === pduId ? null : id);
  };

  const changes = pdu.provenance.filter((m) => !DERIVED.has(m.reason)).length;
  const derived = pdu.provenance.length - changes;

  return (
    <div className="prov">
      <div className="dock-toolbar">
        <span className={`proto-chip ${protoClass(pdu.topProto)}`}>{pdu.topProto}</span>
        <b className="mono">#{pdu.id}</b>
        <span className="ev-msg">{pdu.summary}</span>
        <span className="spacer" />
        {following && <span title="Select a packet to pin the timeline">following the newest packet</span>}
        <button type="button" className="btn" onClick={() => selectPdu(pdu.id)}>
          Inspect layers
        </button>
      </div>
      <div className="prov-strip" aria-label="Related packets">
        <span className="strip-label">Family</span>
        {family.length <= 1 && <span className="dock-hint">No related packets found (yet).</span>}
        {family.length > 1 &&
          family.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`prov-card ${protoClass(p.topProto)}${p.id === pdu.id ? ' is-focus' : ''}`}
              aria-pressed={p.id === pdu.id}
              onClick={() => pick(p.id)}
              title={p.summary}
            >
              <span className="role">{roleOf(p, pdu)}</span>
              <span className="id">
                <b>#{p.id}</b> {p.topProto}
                {p.meta.tag !== undefined ? ` · ${p.meta.tag}` : ''}
              </span>
              <span className="sum">{p.summary}</span>
            </button>
          ))}
      </div>
      <div className="prov-timeline" aria-label="Hops">
        {hops.map((hop, i) => (
          <HopWithArrow key={hop.key} hop={hop} devices={devices} last={i === hops.length - 1} />
        ))}
      </div>
      <div className="prov-footer">
        {hops.length} stop{hops.length === 1 ? '' : 's'} · {changes} header change{changes === 1 ? '' : 's'}
        {derived > 0 ? ` (+${derived} derived)` : ''} · hops are rebuilt from the recorded provenance and the recent
        event history
      </div>
    </div>
  );
}

function ProvenanceEmpty() {
  return (
    <div className="empty-hint">
      <h3>Where did this packet change, and why?</h3>
      Pick a packet — from the Packets tab, the Events tab or the canvas — and this panel lays out every device it
      passed through. Each stop lists only the header fields rewritten there, with the configuration line that caused
      it.
      <ul>
        <li>Give two hosts addresses and ping one from the other to create traffic.</li>
        <li>ARP lookups and replies caused by a packet show up as cards along the top.</li>
        <li>A drop ends the timeline with the reason it was discarded.</li>
      </ul>
    </div>
  );
}

function HopWithArrow({ hop, devices, last }: { hop: Hop; devices: ReadonlyMap<DeviceId, DeviceSnapshot>; last: boolean }) {
  return (
    <>
      <HopColumn hop={hop} devices={devices} />
      {!last && (
        <div className="prov-arrow" aria-hidden="true" title={hop.wire ? `on cable ${hop.wire.link}` : undefined}>
          →{hop.wire && <small>{fmtDuration(hop.wire.ns)}</small>}
        </div>
      )}
    </>
  );
}

const HopColumn = memo(function HopColumn({ hop, devices }: { hop: Hop; devices: ReadonlyMap<DeviceId, DeviceSnapshot> }) {
  const [showDerived, setShowDerived] = useState(false);
  const primary = hop.mutations.filter((m) => !DERIVED.has(m.reason));
  const derived = hop.mutations.filter((m) => DERIVED.has(m.reason));
  const causes: string[] = [];
  for (const m of hop.mutations) if (m.cause) pushUnique(causes, m.cause);

  const kind = hop.drop ? 'dropped' : hop.origin ? 'origin' : hop.consumedBy !== undefined ? 'delivered' : 'transit';
  const cls = `prov-hop${hop.drop ? ' drop' : hop.origin ? ' origin' : hop.consumedBy !== undefined ? ' consumed' : ''}`;
  const device = hop.device;
  const short = (p: PortId): string => (device !== undefined ? portShort(devices, device, p) : p);

  const openCause = (cause: string): void => {
    if (device === undefined) return;
    store.getState().select({ kind: 'device', id: device });
    openDeviceTab('config', cause);
  };

  return (
    <div className={cls}>
      <div className="hop-name">
        {device !== undefined ? (
          <button
            type="button"
            className="link-btn"
            onClick={() => store.getState().select({ kind: 'device', id: device })}
          >
            {deviceName(devices, device)}
          </button>
        ) : (
          <button
            type="button"
            className="link-btn"
            onClick={() => hop.link && store.getState().select({ kind: 'link', id: hop.link })}
          >
            cable {hop.link}
          </button>
        )}
        <span className="kind">
          {hop.drop ? '✗ ' : hop.consumedBy !== undefined ? '✓ ' : ''}
          {kind}
        </span>
      </div>
      <div className="hop-time">{fmtSimTime(hop.t0)}</div>
      {(hop.inPorts.length > 0 || hop.outPorts.length > 0) && (
        <div className="hop-ports">
          {hop.inPorts.length > 0 && `in ${hop.inPorts.map(short).join(', ')}`}
          {hop.inPorts.length > 0 && hop.outPorts.length > 0 && ' · '}
          {hop.outPorts.length > 0 && `out ${hop.outPorts.map(short).join(', ')}`}
        </div>
      )}
      <div className="prov-chips">
        {primary.length === 0 && !hop.drop && <span className="hop-none">no header changes here</span>}
        {primary.map((m, i) => (
          <MutationChip key={i} m={m} derived={false} />
        ))}
        {derived.length > 0 && (
          <button
            type="button"
            className="prov-derived-toggle"
            aria-expanded={showDerived}
            onClick={() => setShowDerived((v) => !v)}
          >
            {showDerived ? '▾' : '▸'} derived ({derived.length})
          </button>
        )}
        {showDerived && derived.map((m, i) => <MutationChip key={`d${i}`} m={m} derived />)}
      </div>
      {causes.map((c) => (
        <button
          key={c}
          type="button"
          className="prov-cause"
          title={device !== undefined ? 'Show this device’s configuration' : undefined}
          onClick={() => openCause(c)}
        >
          <span className="q">“</span>
          {c}
          <span className="q">”</span>
        </button>
      ))}
      {hop.drop && (
        <>
          <div className="prov-drop-reason">✗ {DROP_LABEL[hop.drop.reason] ?? hop.drop.reason}</div>
          {hop.drop.detail !== undefined && <div className="prov-drop-detail">{hop.drop.detail}</div>}
        </>
      )}
      {hop.consumedBy !== undefined && <div className="prov-drop-detail">✓ accepted by {hop.consumedBy}</div>}
    </div>
  );
});

function MutationChip({ m, derived }: { m: Mutation; derived: boolean }) {
  const reason = reasonKey(m.reason);
  const title = `${REASON_LABEL[reason]}${m.cause ? ` — ${m.cause}` : ''}`;
  return (
    <div className={`prov-chip r-${reason}${derived ? ' derived' : ''}`} title={title}>
      <span className="ico" aria-label={REASON_LABEL[reason]}>
        {REASON_ICON[reason]}
      </span>
      {reason === 'Encapsulate' ? (
        <>
          <span className="after">+{typeof m.after === 'string' ? m.after : m.field}</span>
          <span className="fld">header</span>
        </>
      ) : (
        <>
          <span className="fld">{m.field}</span>
          <span>{fmtMutationValue(m.field, m.before)}</span>
          <span className="arrow">→</span>
          <span className="after">{fmtMutationValue(m.field, m.after)}</span>
        </>
      )}
    </div>
  );
}
