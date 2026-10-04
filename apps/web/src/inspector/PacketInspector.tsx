/**
 * Packet inspector (spec §9.2): header with lineage links, one card per decoded
 * layer (width ∝ bytes), fields as name = value, and a synchronized hex view.
 * P2 (ARCHITECTURE-P2 §3.12 step 3, §6; W6 web-inspector): a PDU with `meta.protected`
 * (CAPWAP control after the simulated DTLS step) gets the "Protected (DTLS, simulated)"
 * banner, and the layers inside its UDP payload are marked as simulated plaintext.
 *
 * P3 (ARCHITECTURE-P3 §6, §9.2 W3 items 28 and 30b; §7 W3 web-inspector): the banner is generalised from DTLS to
 * `PduMeta.protectedBy` — 'tls' (RESTCONF over 443, D21), [S13] 'ssh' (its payload decoded from the keystream both ends
 * derive, D14, §3.14 step 6), [C13] 'esp' ("Encrypted (ESP, simulated)", the inner packet) and 'ike' (IKE_AUTH); a
 * protected PDU without `protectedBy` keeps the P2 DTLS banner, word for word. The header gains the marking chips (each
 * `QosMark` record of the PDU's provenance, D16, and [C13] its `Encrypt` / `Decrypt` records) and [S20] the wait chips
 * ("waited 41 ms in VOICE (priority)", from each `frameQueued` of the PDU to its next `frameTx` from that port).
 *
 * Also hosts the small shared helpers of the inspector module: the PduJson cache
 * (`fetchPdu`, `usePduJson`), the device index hook, value formatters and the
 * dock-reveal helper. They live here (not in a separate file) because the module
 * owns a fixed file list.
 */
import { memo, useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { qosDscpText, vtySshCrypt, vtySshKey, vtyText } from '@netforge/engine';
import type {
  DeviceId,
  DeviceSnapshot,
  EgressClassSpec,
  FieldValue,
  LayerView,
  Mutation,
  PduId,
  PduJson,
  PduMeta,
  PortId,
  PortRef,
  SimTime,
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
// P3: GRE [S18], ESP [C13], EIGRP [C1] and OSPF join the names (display only).
const IP_PROTOCOL_NAMES: Record<number, string> = { 1: 'ICMP', 6: 'TCP', 17: 'UDP', 47: 'GRE', 50: 'ESP', 88: 'EIGRP', 89: 'OSPF' };
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
    case 'ipv4.dscp':
      // P3 (D16): the DSCP name a `set dscp` line uses (`46 (ef)`); an unnamed value stays a number
      return qosDscpText(v) === String(v) ? String(v) : `${v} (${qosDscpText(v)})`;
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

// ── protected payloads (P2) ─────────────────────────────────────────────────

/**
 * @since P2 Heading of the banner shown for a PDU with `meta.protected` (ARCHITECTURE-P2 §3.12 step 3, §6): the CAPWAP
 * control messages after the simulated DTLS step. "Headers real, crypto simulated" (spec §4.9): the story says the
 * payload is encrypted, the simulator decodes it anyway so it can be studied.
 */
export const PROTECTED_BANNER_TITLE = 'Protected (DTLS, simulated)';

/**
 * @since P3 The simulated channel that protects a PDU: 'dtls' is P2's meaning (`meta.protected` without `protectedBy`:
 * CAPWAP control), the others are `PduMeta.protectedBy` (§9.2 W3 items 28 and 30b).
 */
export type ProtectionKind = 'dtls' | NonNullable<PduMeta['protectedBy']>;

/** @since P3 The banner heading per channel; the DTLS one is `PROTECTED_BANNER_TITLE`, unchanged. */
export const PROTECTED_BANNER_TITLES: Readonly<Record<ProtectionKind, string>> = Object.freeze({
  dtls: PROTECTED_BANNER_TITLE,
  tls: 'Protected (TLS, simulated)',
  ssh: 'Protected (SSH, simulated)',
  esp: 'Encrypted (ESP, simulated)',
  ike: 'Protected (IKE, simulated)',
});

/** @since P3 The small header chip of a protected PDU (ESP says "encrypted", as its banner does). */
export const PROTECTED_HEADER_CHIPS: Readonly<Record<ProtectionKind, string>> = Object.freeze({
  dtls: 'protected (simulated)',
  tls: 'protected (simulated)',
  ssh: 'protected (simulated)',
  esp: 'encrypted (simulated)',
  ike: 'protected (simulated)',
});

/** The closing sentence every banner shares: the story says encrypted, the simulator decodes it anyway. */
const SIMULATED_SENTENCE =
  'NetForge only simulates that encryption, so the protected fields below are decoded for study and marked as simulated.';

/**
 * @since P2 Why the protected fields are readable here (original wording). P3: `by` names the channel (absent = DTLS,
 * whose text is unchanged).
 */
export function protectedBannerText(layers: readonly Pick<LayerView, 'proto'>[], by: ProtectionKind = 'dtls'): string {
  switch (by) {
    case 'tls': {
      const what = layers.some((l) => l.proto === 'http')
        ? 'This web request travels inside an encrypted TLS session (HTTPS on TCP port 443)'
        : 'This message travels inside an encrypted TLS session';
      return (
        `${what}: a capture on a real network would show the outer addresses and ports, not the request line, the ` +
        `headers or the body. No handshake is simulated. ${SIMULATED_SENTENCE}`
      );
    }
    case 'ssh':
      return (
        'This remote-terminal packet travels inside an encrypted SSH session: after the version strings, which are ' +
        'sent in clear, a capture on a real network shows the addresses, the ports and the packet length, never the ' +
        'user name, the password or the commands typed. NetForge only simulates that encryption with a keystream both ' +
        'ends derive from the connection, so the payload is decoded below for study and marked as simulated.'
      );
    case 'esp':
      return (
        'This packet crosses the provider inside an IPsec tunnel. ESP encrypts the whole original packet, so a capture ' +
        'between the two sites shows only the outer addresses, the SPI and the sequence number, never the private ' +
        'addresses inside. NetForge only simulates that encryption, so the inner packet below is decoded for study and ' +
        'marked as simulated.'
      );
    case 'ike':
      return (
        'This key-exchange message (IKE_AUTH) is encrypted with the keys the two routers agreed in their first ' +
        'exchange: a capture shows the IKE header and the SPIs, not the identities, the proof of the pre-shared key or ' +
        `the proposed security association. The key itself is never sent. ${SIMULATED_SENTENCE}`
      );
    case 'dtls': {
      const what = layers.some((l) => l.proto === 'capwap')
        ? 'This CAPWAP control message travels between the access point and its controller inside an encrypted DTLS session'
        : 'This message travels inside an encrypted session';
      return `${what}: a capture on a real network would show the outer addresses and ports, not the protected fields. ${SIMULATED_SENTENCE}`;
    }
  }
}

/** @since P3 The banner heading of a channel (the DTLS one when absent). */
export function protectedBannerTitle(by: ProtectionKind = 'dtls'): string {
  return PROTECTED_BANNER_TITLES[by];
}

/** @since P2 Whether a PDU carries a protected payload (`PduMeta.protected`). */
export function isProtectedPdu(pdu: Pick<PduJson, 'meta'>): boolean {
  return pdu.meta.protected === true;
}

/** @since P3 The channel protecting a PDU, or undefined when it is not protected (no `protectedBy` = DTLS, P2). */
export function protectionOf(pdu: Pick<PduJson, 'meta'>): ProtectionKind | undefined {
  if (!isProtectedPdu(pdu)) return undefined;
  return pdu.meta.protectedBy ?? 'dtls';
}

/** The layer whose payload a channel protects: DTLS and IKE run over UDP, TLS and SSH over TCP, ESP carries the packet. */
const PROTECTED_AFTER: Readonly<Record<ProtectionKind, string>> = Object.freeze({ dtls: 'udp', ike: 'udp', tls: 'tcp', ssh: 'tcp', esp: 'esp' });

/**
 * @since P2 Indexes of the layers a protected PDU's encryption covers: every layer inside the outermost UDP layer (DTLS
 * runs over UDP), or only the innermost layer when there is no UDP layer. P3: by channel — inside the outermost UDP
 * layer for DTLS and IKE, the outermost TCP layer for TLS and SSH, the outermost ESP header for ESP (the inner packet);
 * the innermost layer alone when that anchor is missing.
 */
export function protectedLayerIndexes(layers: readonly Pick<LayerView, 'proto'>[], by: ProtectionKind = 'dtls'): ReadonlySet<number> {
  const anchor = layers.findIndex((l) => l.proto === PROTECTED_AFTER[by]);
  const from = anchor >= 0 ? anchor + 1 : Math.max(0, layers.length - 1);
  const out = new Set<number>();
  for (let i = from; i < layers.length; i++) out.add(i);
  return out;
}

/** Text of the per-layer mark on a protected layer. */
export const PROTECTED_LAYER_MARK = 'protected · fields shown as simulated plaintext';

// ── [S13] the SSH payload, decoded for study ────────────────────────────────

/** @since P3 [S13] Names of the SSH message numbers the simulated server and client exchange (RFC 4252/4253/4254). */
export const SSH_MESSAGE_NAMES: Readonly<Record<number, string>> = Object.freeze({
  1: 'DISCONNECT',
  50: 'USERAUTH_REQUEST',
  51: 'USERAUTH_FAILURE',
  52: 'USERAUTH_SUCCESS',
  94: 'CHANNEL_DATA',
});

/** @since P3 [S13] One protected SSH packet as the two ends read it. */
export interface SshPlaintext {
  readonly type: number;
  /** The message name (`USERAUTH_REQUEST`), or `message <n>` for a number without one. */
  readonly name: string;
  /** The message body as text, with control characters made visible (`␀` for the zero byte, `↵` for a line end). */
  readonly text: string;
}

/** Control characters made visible: the zero byte that separates user and password, line ends, telnet commands. */
function visibleText(s: string): string {
  return s.replace(/\r\n|\n/g, '↵').replace(/\r/g, '↵').replace(/\0/g, '␀').replace(/[\x01-\x1f\x7f]/g, '·');
}

/**
 * @since P3 [S13] The plaintext of a protected SSH packet, decoded the way both ends decode it: XOR with the keystream
 * of the segment's endpoints (`vtySshKey`, `vtySshCrypt`; D14). Undefined for anything else (a version line, a segment
 * without addresses or ports, an empty payload).
 */
export function sshPlaintextOf(layers: readonly Pick<LayerView, 'proto' | 'fields'>[]): SshPlaintext | undefined {
  const sshAt = layers.findIndex((l) => l.proto === 'ssh');
  if (sshAt < 0) return undefined;
  const ssh = layers[sshAt];
  if (ssh === undefined || ssh.fields.phase !== 'protected') return undefined;
  const payload = ssh.fields.payload;
  if (!(payload instanceof Uint8Array) || payload.length === 0) return undefined;
  let tcp: Pick<LayerView, 'fields'> | undefined;
  let ip: Pick<LayerView, 'fields'> | undefined;
  for (let i = sshAt - 1; i >= 0; i--) {
    const l = layers[i];
    if (l === undefined) continue;
    if (tcp === undefined && l.proto === 'tcp') tcp = l;
    else if (tcp !== undefined && l.proto === 'ipv4') {
      ip = l;
      break;
    }
  }
  const src = ip?.fields.src;
  const dst = ip?.fields.dst;
  const sp = tcp?.fields.srcPort;
  const dp = tcp?.fields.dstPort;
  if (typeof src !== 'string' || typeof dst !== 'string' || typeof sp !== 'number' || typeof dp !== 'number') return undefined;
  const plain = vtySshCrypt(vtySshKey(src, sp, dst, dp), payload);
  const type = plain[0] ?? 0;
  return { type, name: SSH_MESSAGE_NAMES[type] ?? `message ${type}`, text: visibleText(vtyText(plain.subarray(1))) };
}

function ProtectedBanner({ layers, by }: { layers: readonly LayerView[]; by: ProtectionKind }) {
  const title = protectedBannerTitle(by);
  const ssh = by === 'ssh' ? sshPlaintextOf(layers) : undefined;
  return (
    <div className="reason-box pk-protected" role="note" aria-label={title}>
      <div>
        <span aria-hidden="true">⊘ </span>
        <strong>{title}</strong>
      </div>
      <div>{protectedBannerText(layers, by)}</div>
      {ssh !== undefined && (
        <div className="mono">
          Simulated plaintext: {ssh.name} ({ssh.type}){ssh.text !== '' ? ` · ${ssh.text}` : ''}
        </div>
      )}
    </div>
  );
}

// ── P3 marking chips (D16, [C13]) ───────────────────────────────────────────

/** @since P3 The provenance records the header shows as chips: QoS marking, and [C13] the IPsec encryption steps. */
export type MarkingReason = Extract<Mutation['reason'], 'QosMark' | 'Encrypt' | 'Decrypt'>;

/** @since P3 One marking chip. */
export interface MarkingChip {
  readonly reason: MarkingReason;
  readonly at: SimTime;
  readonly device: DeviceId;
  readonly field: string;
  /** e.g. `DSCP 0 → 46 (ef)`, `CoS 0 → 5`, `encrypted`. */
  readonly text: string;
  /** The configuration line responsible (`policy-map MARK class VOIP set dscp ef`, `interface Tunnel0`). */
  readonly cause?: string;
}

/** @since P3 Glyph of each marking chip (the letter is the non-colour channel; Q as in the provenance timeline). */
export const MARKING_GLYPH: Readonly<Record<MarkingReason, string>> = Object.freeze({ QosMark: 'Q', Encrypt: 'E', Decrypt: 'D' });

const MARK_FIELD_LABEL: Readonly<Record<string, string>> = Object.freeze({
  'ipv4.dscp': 'DSCP',
  'ipv6.trafficClass': 'traffic class',
  'dot1q.pcp': 'CoS',
});

/** @since P3 A marking value in words: a DSCP with its name (`46 (ef)`), anything else as its number. */
export function markingValueText(field: string, v: FieldValue | undefined): string {
  if (typeof v !== 'number') return v === undefined || v === null ? '—' : String(v);
  if (field === 'ipv4.dscp') return qosDscpText(v) === String(v) ? String(v) : `${v} (${qosDscpText(v)})`;
  return String(v);
}

/** @since P3 The marking chips of a PDU's provenance, oldest first. */
export function markingChipsOf(provenance: readonly Mutation[]): MarkingChip[] {
  const out: MarkingChip[] = [];
  for (const m of provenance) {
    if (m.reason !== 'QosMark' && m.reason !== 'Encrypt' && m.reason !== 'Decrypt') continue;
    const text =
      m.reason === 'QosMark'
        ? `${MARK_FIELD_LABEL[m.field] ?? m.field} ${markingValueText(m.field, m.before)} → ${markingValueText(m.field, m.after)}`
        : m.reason === 'Encrypt'
          ? 'encrypted'
          : 'decrypted';
    out.push({ reason: m.reason, at: m.at, device: m.device, field: m.field, text, ...(m.cause !== undefined ? { cause: m.cause } : {}) });
  }
  return out;
}

// ── [S20] queue waits ───────────────────────────────────────────────────────

/** @since P3 [S20] One wait of a PDU in a class queue: from its `frameQueued` to the next `frameTx` from that port. */
export interface QueueWait {
  readonly device: DeviceId;
  readonly port: PortId;
  /** The class queue (`frameQueued.queue`: the class name). */
  readonly queue: string;
  /** The class's depth right after the enqueue. */
  readonly depth: number;
  readonly queuedAt: SimTime;
  /** When serialisation started (`frameTx.txStart`); absent while the frame still waits. */
  readonly sentAt?: SimTime;
  /** `sentAt − queuedAt`; absent while the frame still waits. */
  readonly waitNs?: number;
}

/**
 * @since P3 [S20] The waits of PDU `id` in the trace: each `frameQueued` of it, closed by the next `frameTx` of it from
 * the same device and port. A wait not yet closed has no `sentAt`.
 */
export function queueWaitsOf(events: readonly TraceEvent[], id: PduId): QueueWait[] {
  const out: QueueWait[] = [];
  const open = new Map<string, number>();
  for (const ev of events) {
    if (ev.kind === 'frameQueued') {
      if (ev.pdu.id !== id) continue;
      open.set(`${ev.device}|${ev.port}`, out.length);
      out.push({ device: ev.device, port: ev.port, queue: ev.queue, depth: ev.depth, queuedAt: ev.t });
    } else if (ev.kind === 'frameTx') {
      if (ev.pdu.id !== id) continue;
      const key = `${ev.from.device}|${ev.from.port}`;
      const at = open.get(key);
      if (at === undefined) continue;
      open.delete(key);
      const w = out[at];
      if (w === undefined) continue;
      const sentAt = ev.txStart;
      out[at] = { ...w, sentAt, waitNs: Math.max(0, sentAt - w.queuedAt) };
    }
  }
  return out;
}

/** @since P3 [S20] A wait as words: `41 ms`, `3.5 ms`, `0.2 ms`, `1.25 s`. */
export function fmtWait(ns: number): string {
  if (ns >= 1_000_000_000) return `${(ns / 1_000_000_000).toFixed(2)} s`;
  if (ns >= 10_000_000) return `${Math.round(ns / 1_000_000)} ms`;
  return `${(ns / 1_000_000).toFixed(1)} ms`;
}

/** @since P3 [S20] Words of a class kind after the queue name (class-default needs none). */
export const QUEUE_KIND_WORDS: Readonly<Record<EgressClassSpec['kind'], string>> = Object.freeze({
  priority: 'priority',
  bandwidth: 'bandwidth',
  default: '',
});

/**
 * @since P3 [S20] The wait chip: `waited 41 ms in VOICE (priority)`; `kind` is the class kind on that port when known.
 * A frame still in its queue reads `waiting in VOICE (priority)`.
 */
export function queueWaitText(w: Pick<QueueWait, 'queue' | 'waitNs'>, kind?: EgressClassSpec['kind']): string {
  const words = kind === undefined ? '' : QUEUE_KIND_WORDS[kind];
  const where = `${w.queue}${words === '' ? '' : ` (${words})`}`;
  return w.waitNs === undefined ? `waiting in ${where}` : `waited ${fmtWait(w.waitNs)} in ${where}`;
}

/** The class kind of `queue` on a port, from its snapshot's queue view ([S20] `PortSnapshot.qos.queue`). */
function queueKindOf(index: ReadonlyMap<DeviceId, DeviceSnapshot>, w: QueueWait): EgressClassSpec['kind'] | undefined {
  const port = index.get(w.device)?.ports.find((p) => p.id === w.port);
  return port?.qos?.queue?.classes.find((c) => c.name === w.queue)?.kind;
}

const NO_EVENTS: readonly TraceEvent[] = [];

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
  const protection = protectionOf(pdu);
  const protectedLayers = useMemo(
    () => (protection !== undefined ? protectedLayerIndexes(pdu.layers, protection) : new Set<number>()),
    [protection, pdu.layers],
  );
  // P3: the marking chips (QosMark, [C13] Encrypt/Decrypt) and [S20] the waits of this PDU in class queues
  const marks = useMemo(() => markingChipsOf(pdu.provenance), [pdu.provenance]);
  const events = useStore((s) => s.events) ?? NO_EVENTS;
  const waits = useMemo(() => queueWaitsOf(events, pdu.id), [events, pdu.id]);

  return (
    <div className="pk">
      <div className="pk-head">
        <div className="insp-title-row">
          <span className={`proto-chip ${protoClass(pdu.topProto)}`}>{pdu.topProto}</span>
          <span className="insp-title mono">Packet #{pdu.id}</span>
          {protection !== undefined && <span className="chip tiny">{PROTECTED_HEADER_CHIPS[protection]}</span>}
        </div>
        <div className="pk-summary">{pdu.summary}</div>
        {protection !== undefined && <ProtectedBanner layers={pdu.layers} by={protection} />}
        {(marks.length > 0 || waits.length > 0) && (
          <div className="pk-meta" aria-label="Marking and queueing">
            {marks.map((m, i) => (
              <span
                key={`m${i}`}
                className={`chip tiny${m.reason === 'QosMark' ? ' accent' : ''}`}
                title={m.cause !== undefined ? `${m.text} — ${m.cause}` : m.text}
              >
                <span aria-hidden="true">{MARKING_GLYPH[m.reason]}</span> {m.text} on {deviceName(devices, m.device)}
              </span>
            ))}
            {waits.map((w, i) => (
              <span key={`w${i}`} className="chip tiny" title={`queued at ${fmtSimTime(w.queuedAt)} behind ${w.depth - 1} other packet(s)`}>
                <span aria-hidden="true">⧗</span> {queueWaitText(w, queueKindOf(devices, w))} at {portLabel(devices, { device: w.device, port: w.port })}
              </span>
            ))}
          </div>
        )}
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
            simulated={protectedLayers.has(i)}
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
  /** @since P2 The layer is inside a protected payload: its fields are shown as simulated plaintext. */
  simulated?: boolean;
  onToggle(i: number): void;
  onHover(h: HotField | null): void;
}

const MIN_LAYER_PCT = 40;

const LayerCard = memo(function LayerCard({ layer, index, total, selected, hotField, simulated = false, onToggle, onHover }: LayerCardProps) {
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
        {simulated && <span className="chip tiny">{PROTECTED_LAYER_MARK}</span>}
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
