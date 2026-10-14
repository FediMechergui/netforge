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
 * P3 (ARCHITECTURE-P3 §9.2 ruling R57(b); W6 web-inspector): opened from a hop — `inspectPduAtHop(frameTx)`, the call a
 * Packets-list row of a leg or a provenance stop makes — the inspector shows the packet as it was on that leg, with that
 * leg's banner: an ESP leg of an IPsec ping at the provider says "Encrypted (ESP, simulated)" although the packet the
 * engine now holds was decrypted at the far end. The engine keeps only a packet's newest image, so the leg is rebuilt
 * by undoing, newest first, every change its provenance recorded after the leg left its device (`rewindToHop`): field
 * changes are undone exactly; a header a later device removed is listed by name only (its fields were not kept); when
 * every header is known the leg's bytes are re-encoded with the engine's codecs and kept only if they decode back to
 * the same fields and the leg's size. The hop belongs to the selection it was opened with: any other selection of the
 * packet (the canvas, the Events list, "Inspect layers") shows today's view, unchanged. A TLS or SSH segment carried
 * through an IPsec tunnel shows its own banner on both LANs and ESP between the routers (`hopProtection`, from the inner
 * mark the tunnel keeps; W8 item 47, ruling R58(a)).
 *
 * Also hosts the small shared helpers of the inspector module: the PduJson cache
 * (`fetchPdu`, `usePduJson`), the device index hook, value formatters and the
 * dock-reveal helper. They live here (not in a separate file) because the module
 * owns a fixed file list.
 */
import { memo, useCallback, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { ETHERTYPE_VLAN, createPduFactory, qosDscpText, vtySshCrypt, vtySshKey, vtyText } from '@netforge/engine';
import type {
  DeviceId,
  DeviceSnapshot,
  EgressClassSpec,
  FieldValue,
  LayerView,
  Mutation,
  PduFactory,
  PduId,
  PduJson,
  PduMeta,
  PortId,
  PortRef,
  ProtoName,
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

/**
 * The protected banner: its title, why the fields are readable here, and [S13] an SSH packet's simulated plaintext.
 * @since P3 Exported (ruling R57(b)): NetScope's frame detail shows the same banner.
 */
export function ProtectedBanner({ layers, by }: { layers: readonly Pick<LayerView, 'proto' | 'fields'>[]; by: ProtectionKind }) {
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

// ── P3 (ruling R57(b)): the packet as it was on one leg ─────────────────────

/** @since P3 A hop the inspector can be opened from: the `frameTx` that put the packet on one wire. */
export type PacketHop = EventOf<'frameTx'>;

interface OpenedHop {
  readonly hop: PacketHop;
  /** The store's selection object the hop was opened with: any other selection ends the hop. */
  readonly selection: unknown;
  /** A reset restarts PDU ids: a hop of the previous world never applies. */
  readonly epoch: unknown;
}

let openedHop: OpenedHop | null = null;
const hopListeners = new Set<() => void>();

function subscribeHop(listener: () => void): () => void {
  hopListeners.add(listener);
  return () => {
    hopListeners.delete(listener);
  };
}

const hopSnapshot = (): OpenedHop | null => openedHop;

/**
 * @since P3 (ruling R57(b)) Select packet `hop.pdu.id` and open the inspector on it as it was on that leg — the call a
 * Packets-list row, a sim-mode row or a provenance stop makes. Selecting the packet any other way shows its newest image.
 */
export function inspectPduAtHop(hop: PacketHop): void {
  store.getState().select({ kind: 'pdu', id: hop.pdu.id });
  const now = store.getState();
  openedHop = { hop, selection: now.selection, epoch: now.epoch };
  for (const listener of hopListeners) listener();
}

/** @since P3 The hop packet `id` was opened from, while the selection it was opened with is still the store's. */
export function usePacketHop(id: PduId): PacketHop | undefined {
  const selection = useStore((s) => s.selection);
  const epoch = useStore((s) => s.epoch);
  const opened = useSyncExternalStore(subscribeHop, hopSnapshot, hopSnapshot);
  if (opened === null || selection === null || selection === undefined) return undefined;
  if (opened.selection !== selection || opened.epoch !== epoch || opened.hop.pdu.id !== id) return undefined;
  return opened.hop;
}

/** @since P3 How much of a header the rewind knows: every field, some (a tag a later device popped), or none. */
export type HopLayerKept = 'all' | 'some' | 'none';

/** @since P3 One header of a packet as it was on a leg, outermost first. */
export interface HopLayer {
  readonly proto: ProtoName;
  /** The fields known for that leg (empty when none was kept). */
  readonly fields: Readonly<Record<string, FieldValue>>;
  readonly kept: HopLayerKept;
}

/** @since P3 A packet rebuilt as it was on one leg (`rewindToHop`). */
export interface HopImage {
  readonly hop: PacketHop;
  /** The headers on that leg, outermost first. */
  readonly layers: readonly HopLayer[];
  /**
   * The leg's exact image (bytes, decoded layers, the provenance up to the leg, the leg's summary): the packet itself
   * when nothing changed after the leg, else re-encoded from `layers` when every header is known and the bytes decode
   * back to the same fields and the leg's size. Absent otherwise.
   */
  readonly image?: PduJson;
  /** Changes the provenance recorded after the leg (the ones undone). */
  readonly later: number;
  /** A later change could not be undone exactly (bits flipped on a cable, a record that matches no header). */
  readonly inexact: boolean;
}

/**
 * @since P3 Index of the first provenance record made after `hop` left its device: records after the leg's time, and
 * at the same instant those of another device or the bits a cable flipped in the copy it carried (the tap records the
 * frame before that damage).
 */
export function hopCut(provenance: readonly Mutation[], hop: Pick<PacketHop, 't' | 'from'>): number {
  for (let i = 0; i < provenance.length; i++) {
    const m = provenance[i];
    if (m === undefined) continue;
    if (m.at > hop.t) return i;
    if (m.at === hop.t && (m.device !== hop.from.device || m.reason === 'Corruption')) return i;
  }
  return provenance.length;
}

interface RewindLayer {
  proto: ProtoName;
  fields: Record<string, FieldValue>;
  kept: HopLayerKept;
}

const FIELD_PATH = /^([a-z0-9_]+)(?:\[(\d+)\])?\.(.+)$/;

/** Undo one recorded change on the stack (newest first). False when it cannot be undone exactly. */
function undoMutation(stack: RewindLayer[], m: Mutation): boolean {
  switch (m.reason) {
    case 'Encapsulate': {
      // the pushed header was the outermost one right after the change
      if (stack[0]?.proto !== m.field) return false;
      stack.shift();
      return true;
    }
    case 'Decapsulate':
      // a header removed later: its name is known, its fields were not kept
      stack.unshift({ proto: m.field as ProtoName, fields: {}, kept: 'none' });
      return true;
    case 'VlanTagPush': {
      const eth = stack[0];
      const tag = stack[1];
      if (eth?.proto !== 'ethernet' || tag?.proto !== 'dot1q') return false;
      stack.splice(1, 1);
      if (eth.kept !== 'none') {
        if (tag.fields.type !== undefined) eth.fields.type = tag.fields.type;
        else eth.kept = 'some';
      }
      return true;
    }
    case 'VlanTagPop': {
      const eth = stack[0];
      if (eth?.proto !== 'ethernet') return false;
      const inner = eth.fields.type;
      const fields: Record<string, FieldValue> = { vid: m.before };
      if (inner !== undefined) fields.type = inner;
      stack.splice(1, 0, { proto: 'dot1q', fields, kept: 'some' });
      if (eth.kept !== 'none') eth.fields.type = ETHERTYPE_VLAN;
      return true;
    }
    case 'Corruption':
      // the record keeps the byte, not where it was: the flip cannot be undone
      return false;
    default: {
      const path = FIELD_PATH.exec(m.field);
      if (path === null) return false;
      const [, proto, at, field] = path;
      if (proto === undefined || field === undefined) return false;
      const index = at !== undefined ? (stack[Number(at)]?.proto === proto ? Number(at) : -1) : stack.findIndex((l) => l.proto === proto);
      const layer = stack[index];
      if (layer === undefined) return false;
      if (layer.kept === 'none') return true; // nothing of that header was kept: nothing to undo
      if (m.before === null) delete layer.fields[field];
      else layer.fields[field] = m.before;
      return true;
    }
  }
}

function sameFieldValue(a: FieldValue | undefined, b: FieldValue | undefined): boolean {
  if (a instanceof Uint8Array && b instanceof Uint8Array) return a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}

let rebuildFactory: PduFactory | undefined;

/** Re-encode a fully known leg; kept only when it decodes back to the same headers and fields and the leg's size. */
function rebuildImage(pdu: PduJson, hop: PacketHop, layers: readonly HopLayer[], cut: number): PduJson | undefined {
  if (layers.length === 0 || layers.some((l) => l.kept !== 'all')) return undefined;
  try {
    rebuildFactory ??= createPduFactory();
    const built = rebuildFactory.build(
      layers.map((l) => ({ proto: l.proto, fields: { ...l.fields } })),
      pdu.meta,
    ).toJSON();
    if (built.bytes.length !== hop.pdu.size || built.layers.length !== layers.length) return undefined;
    for (let i = 0; i < layers.length; i++) {
      const want = layers[i];
      const got = built.layers[i];
      if (want === undefined || got === undefined || want.proto !== got.proto) return undefined;
      const keys = Object.keys(want.fields);
      if (keys.length !== Object.keys(got.fields).length) return undefined;
      for (const k of keys) if (!sameFieldValue(want.fields[k], got.fields[k])) return undefined;
    }
    return {
      id: pdu.id,
      bytes: built.bytes,
      layers: built.layers,
      meta: pdu.meta,
      provenance: pdu.provenance.slice(0, cut),
      summary: hop.pdu.summary,
      topProto: hop.pdu.proto,
    };
  } catch {
    return undefined;
  }
}

/**
 * @since P3 (ruling R57(b)) Packet `pdu` (its newest image) as it was on leg `hop`: every change recorded after the leg
 * is undone, newest first. Field changes are undone exactly; a header a later device removed comes back by name only
 * (`kept: 'none'`); a tag a later switch popped comes back with its VID (`kept: 'some'`). Bits a cable flipped cannot
 * be undone (`inexact`).
 */
export function rewindToHop(pdu: PduJson, hop: PacketHop): HopImage {
  const cut = hopCut(pdu.provenance, hop);
  const later = pdu.provenance.length - cut;
  const stack: RewindLayer[] = pdu.layers.map((l) => ({ proto: l.proto, fields: { ...l.fields }, kept: 'all' }));
  if (later === 0) return { hop, layers: stack, image: pdu, later, inexact: false };
  let inexact = false;
  for (let i = pdu.provenance.length - 1; i >= cut; i--) {
    const m = pdu.provenance[i];
    if (m !== undefined && !undoMutation(stack, m)) inexact = true;
  }
  const image = inexact ? undefined : rebuildImage(pdu, hop, stack, cut);
  return image === undefined ? { hop, layers: stack, later, inexact } : { hop, layers: stack, image, later, inexact };
}

/**
 * @since P3 (ruling R57(b)) The channel protecting a packet on one leg: ESP when an ESP header is on that leg (the PDU's
 * own mark is cleared where the tunnel ends); otherwise the packet's mark (TLS, SSH and IKE mark a segment end to end,
 * and a protected PDU without `protectedBy` is still P2's DTLS) — but not ESP on a leg outside the tunnel. A segment
 * carried through an IPsec tunnel keeps its own mark (W8 item 47, ruling R58(a)): after the tail it is the packet's
 * mark again, and while the packet is still inside the tunnel a leg outside it shows the inner mark the tunnel keeps
 * (`innerProtectedBy`) — so TLS or SSH on both LANs, ESP between the routers.
 */
export function hopProtection(layers: readonly Pick<HopLayer, 'proto'>[], meta: PduMeta): ProtectionKind | undefined {
  if (layers.some((l) => l.proto === 'esp')) return 'esp';
  const by = protectionOf({ meta });
  if (by !== 'esp') return by;
  const inner = meta.innerProtectedBy;
  return inner === 'esp' ? undefined : inner;
}

/** @since P3 Words of a header whose fields the rewind could not recover. */
export const HOP_LAYER_NOT_KEPT: Readonly<Record<Exclude<HopLayerKept, 'all'>, string>> = Object.freeze({
  none: 'header not kept',
  some: 'some fields not kept',
});

/** @since P3 The note under a leg rebuilt without its bytes (original wording). */
export function hopRebuiltNote(at: Pick<HopImage, 'layers' | 'inexact'>): string {
  const lost = at.layers.some((l) => l.kept !== 'all');
  const parts = [
    'NetForge keeps only the newest bytes of a packet, so this leg was rebuilt by undoing the changes recorded after it.',
  ];
  if (lost) parts.push('Headers a later device removed were not kept: they are listed by name, and their fields are missing.');
  else parts.push('Every field is known, but the bytes of the leg could not be rebuilt from them.');
  if (at.inexact) parts.push('A later change could not be undone (for example bits flipped on a cable), so some fields may show the packet as it is now.');
  parts.push('Capture on this link in NetScope to keep every byte of every leg.');
  return parts.join(' ');
}

// ── component ───────────────────────────────────────────────────────────────

interface HotField {
  layer: number;
  field: string;
}

/**
 * The packet inspector of `pdu`. P3 (ruling R57(b)): opened from a hop (`inspectPduAtHop`), it shows the packet as it was
 * on that leg — its exact image when it can be rebuilt, else its headers by name with the fields that were kept.
 */
export function PacketInspector({ pdu }: { pdu: PduJson }) {
  const hop = usePacketHop(pdu.id);
  const at = useMemo(() => (hop === undefined ? undefined : rewindToHop(pdu, hop)), [pdu, hop]);
  if (at === undefined) return <PacketView pdu={pdu} />;
  const key = `${at.hop.t}:${at.hop.from.device}/${at.hop.from.port}`;
  if (at.image !== undefined) return <PacketView key={key} pdu={at.image} at={at} />;
  return <HopLayersView key={key} pdu={pdu} at={at} />;
}

/** @since P3 Where the inspected leg ran, and the way back to the packet's newest image. */
function HopStrip({ at, devices }: { at: HopImage; devices: ReadonlyMap<DeviceId, DeviceSnapshot> }) {
  const { hop } = at;
  return (
    <div className="pk-meta" aria-label="Inspected leg">
      <span>
        As sent from <b>{portLabel(devices, hop.from)}</b> to <b>{portLabel(devices, hop.to)}</b> at {fmtSimTime(hop.t)}
        {at.later > 0 ? ` · ${at.later} later change${at.later === 1 ? '' : 's'} undone` : ''}
      </span>
      <button type="button" className="link-btn" onClick={() => selectPdu(hop.pdu.id)}>
        show the packet as it is now
      </button>
    </div>
  );
}

/** The marking chips and the queue waits of the header (rendered only when there are some). */
function PacketMarks({
  marks,
  waits,
  devices,
}: {
  marks: readonly MarkingChip[];
  waits: readonly QueueWait[];
  devices: ReadonlyMap<DeviceId, DeviceSnapshot>;
}) {
  if (marks.length === 0 && waits.length === 0) return null;
  return (
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
  );
}

/** Size, birth, origin, tag and flow; lineage and the provenance link. */
function PacketMetaLines({ pdu, size, devices }: { pdu: PduJson; size: number; devices: ReadonlyMap<DeviceId, DeviceSnapshot> }) {
  const { meta } = pdu;
  const originName = deviceName(devices, meta.origin);
  return (
    <>
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
    </>
  );
}

/** The waits of PDU `id` in class queues, up to the leg's time when a leg is inspected. */
function useQueueWaits(id: PduId, until?: SimTime): QueueWait[] {
  const events = useStore((s) => s.events) ?? NO_EVENTS;
  return useMemo(() => {
    const all = queueWaitsOf(events, id);
    return until === undefined ? all : all.filter((w) => w.queuedAt <= until);
  }, [events, id, until]);
}

/**
 * One exact image: today's view of the packet, or (P3, `at`) the image of the leg it was opened from, with that leg's
 * banner and the strip that names the leg.
 */
function PacketView({ pdu, at }: { pdu: PduJson; at?: HopImage }) {
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

  // P3 (R57(b)): a leg's banner follows that leg's headers; today's view follows the packet's mark
  const protection = at === undefined ? protectionOf(pdu) : hopProtection(pdu.layers, pdu.meta);
  const protectedLayers = useMemo(
    () => (protection !== undefined ? protectedLayerIndexes(pdu.layers, protection) : new Set<number>()),
    [protection, pdu.layers],
  );
  // P3: the marking chips (QosMark, [C13] Encrypt/Decrypt) and [S20] the waits of this PDU in class queues
  const marks = useMemo(() => markingChipsOf(pdu.provenance), [pdu.provenance]);
  const waits = useQueueWaits(pdu.id, at?.hop.t);

  return (
    <div className="pk">
      <div className="pk-head">
        <div className="insp-title-row">
          <span className={`proto-chip ${protoClass(pdu.topProto)}`}>{pdu.topProto}</span>
          <span className="insp-title mono">Packet #{pdu.id}</span>
          {protection !== undefined && <span className="chip tiny">{PROTECTED_HEADER_CHIPS[protection]}</span>}
        </div>
        <div className="pk-summary">{pdu.summary}</div>
        {at !== undefined && <HopStrip at={at} devices={devices} />}
        {protection !== undefined && <ProtectedBanner layers={pdu.layers} by={protection} />}
        <PacketMarks marks={marks} waits={waits} devices={devices} />
        <PacketMetaLines pdu={pdu} size={size} devices={devices} />
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

/**
 * @since P3 (ruling R57(b)) A leg whose bytes could not be rebuilt: its headers outermost first (a header a later device
 * removed by name only), the leg's banner over the layers it protects, and the note that says why there are no bytes.
 */
function HopLayersView({ pdu, at }: { pdu: PduJson; at: HopImage }) {
  const devices = useDeviceIndex();
  const { hop } = at;
  const protection = hopProtection(at.layers, pdu.meta);
  const protectedLayers = useMemo(
    () => (protection !== undefined ? protectedLayerIndexes(at.layers, protection) : new Set<number>()),
    [protection, at.layers],
  );
  // the packet up to the leg: the marks and the change count it had then
  const cut = pdu.provenance.length - at.later;
  const before = useMemo<PduJson>(() => ({ ...pdu, provenance: pdu.provenance.slice(0, cut) }), [pdu, cut]);
  const marks = useMemo(() => markingChipsOf(before.provenance), [before.provenance]);
  const waits = useQueueWaits(pdu.id, hop.t);

  return (
    <div className="pk">
      <div className="pk-head">
        <div className="insp-title-row">
          <span className={`proto-chip ${protoClass(hop.pdu.proto)}`}>{hop.pdu.proto}</span>
          <span className="insp-title mono">Packet #{pdu.id}</span>
          {protection !== undefined && <span className="chip tiny">{PROTECTED_HEADER_CHIPS[protection]}</span>}
        </div>
        <div className="pk-summary">{hop.pdu.summary}</div>
        <HopStrip at={at} devices={devices} />
        {protection !== undefined && <ProtectedBanner layers={at.layers} by={protection} />}
        <PacketMarks marks={marks} waits={waits} devices={devices} />
        <PacketMetaLines pdu={before} size={hop.pdu.size} devices={devices} />
      </div>

      <div className="pk-layers">
        {at.layers.map((layer, i) => (
          <HopLayerCard key={`${i}:${layer.proto}`} layer={layer} simulated={protectedLayers.has(i)} />
        ))}
      </div>

      <div className="pk-hexwrap">
        <h4>Bytes</h4>
        <div className="insp-note" role="note">
          {hopRebuiltNote(at)}
        </div>
      </div>
    </div>
  );
}

const DEFAULT_CURSOR: CSSProperties = { cursor: 'default' };

/** @since P3 A header of a rebuilt leg: its known fields, and words for the ones that were not kept. */
function HopLayerCard({ layer, simulated }: { layer: HopLayer; simulated: boolean }) {
  const fields = Object.entries(layer.fields);
  return (
    <div className={`pk-layer ${protoClass(layer.proto)}`}>
      <div className="pk-layer-head" style={DEFAULT_CURSOR}>
        <span className="proto">{layer.proto}</span>
        {layer.kept !== 'all' && <span className="dim">{HOP_LAYER_NOT_KEPT[layer.kept]}</span>}
        {simulated && <span className="chip tiny">{PROTECTED_LAYER_MARK}</span>}
      </div>
      {fields.length > 0 && (
        <dl className="pk-fields">
          {fields.map(([name, value]) => {
            const text = fmtValue(layer.proto, name, value);
            const validity = typeof value === 'boolean' && name.endsWith('Valid') ? (value ? 'valid' : 'invalid') : undefined;
            return (
              <div key={name} className="pk-field">
                <dt>{name}</dt>
                <dd>{validity ? <span className={validity}>{text}</span> : text}</dd>
              </div>
            );
          })}
        </dl>
      )}
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
