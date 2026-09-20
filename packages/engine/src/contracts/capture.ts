/**
 * Packet capture and analysis — NetScope (spec §10; ARCHITECTURE-P1 §4.12, §7).
 *
 * Records copy wire bytes at the instant they are on the medium because PDUs keep their id across hops and
 * are mutated in place (TTL, MAC rewrite, 802.11 rewrap) and the PDU registry keeps only the latest image.
 * The LINK MODEL is the single tap point (`LinkModelDeps.capture`): tx is recorded when a frame actually
 * starts on the medium (after egress rewrap, before corruption); rx is recorded in `LinkModel.admit` (after
 * corruption, before ingress rewrap), so an AP's Wl0 capture shows 802.11 frames.
 *
 * Live captures belong to the Simulation (ids `c_<n>`, die with the world). Imported captures belong to the
 * worker CaptureLibrary (ids `i_<n>`, survive reset) and never touch sim ids or rng. Timestamps are integer
 * ns; pcapng writes `if_tsresol = 9` and a caller-supplied base wall-clock (UI passes Date.now; engine
 * default 0 keeps exports byte-deterministic). Structured-clone safe except `WireEvent.pdu` (engine-internal).
 *
 * Display filters: a DOM-free engine module (capture/filter/*), also exported by the `@netforge/engine/pure`
 * entry for UI highlighting/autocompletion; evaluation over records runs in the worker (EngineApi.queryCapture).
 * Grammar subset: `or/and/not` (`|| && !`), parentheses, bare protocol presence, relations
 * `== != < <= > >= contains`, `in {…}`, literals number/hex/"string"/IPv4[/len]/IPv6[/len]/MAC. `matches`
 * (regex) is excluded. Field names = canonical PROTO_FIELDS paths plus a familiar alias table
 * (ip.src/dst/addr, ipv6.addr, eth.src/dst/addr, tcp.port, udp.port, tcp.flags.syn/ack/fin/rst,
 * icmp, dns.qry.name, http.request.method, http.response.code, frame.number/len/time_relative/interface).
 * Multi-valued fields (ip.addr): `==` means any, `!=` means none (documented extension).
 */
import type { PduId, PortRef } from './ids.js';
import type { LayerView, Pdu, ProtoName } from './pdu.js';
import type { SimTime } from './time.js';

/** 'c_<n>' live, 'i_<n>' imported. */
export type CaptureId = string;

/** Link types, named after pcap LINKTYPE_* values. */
export type CaptureLinkType = 'ethernet' | 'ieee802_11' | 'c_hdlc' | 'raw';
export const PCAP_LINKTYPE: Readonly<Record<CaptureLinkType, number>> = Object.freeze({ ethernet: 1, ieee802_11: 105, c_hdlc: 104, raw: 101 });

export interface CaptureSpec {
  /** Capture points; omitted together with `links` = every port (promiscuous lab capture). */
  ports?: readonly PortRef[];
  /** Every port attached to these links / segments / media. */
  links?: readonly string[];
  dir?: 'tx' | 'rx' | 'both';
  /** Ring size; oldest dropped. Default DEFAULT_CAPTURE_MAX_RECORDS. */
  maxRecords?: number;
  /** Include background frames (keepalives, beacons). Default false. */
  includeBackground?: boolean;
  name?: string;
}

export interface CaptureInterface {
  /** Index used by records and pcapng IDB order. */
  index: number;
  ref?: PortRef;
  /** Original display name, e.g. 'PC1 Gi0'. */
  name: string;
  linkType: CaptureLinkType;
  /**
   * Trailing FCS bytes present in each record for this interface (pcapng if_fcslen). Live: ethernet 4; dot11 0
   * (stripped); c_hdlc 0 (2-byte CRC stripped). Import: pcapng if_fcslen when the FCS-present flag is set, else 0;
   * classic pcap 0; unsupported values fall back to 0.
   */
  fcsLen: 0 | 2 | 4;
}

export interface CaptureRecord {
  /** Monotonic within the capture (frame.number = index + 1). */
  index: number;
  t: SimTime;
  iface: number;
  dir: 'tx' | 'rx' | 'unknown';
  bytes: Uint8Array;
  origLen: number;
  /** Live captures only. */
  pdu?: PduId;
  corrupted?: boolean;
}

/** One wire observation reported by the link model to the tap. `pdu` is live: the tap copies `pdu.bytes` immediately. */
export interface WireEvent {
  t: SimTime;
  dir: 'tx' | 'rx';
  port: PortRef;
  pdu: Pdu;
  linkType: CaptureLinkType;
  corrupted?: boolean;
  /** Collision fragment: only these leading bytes were received. */
  fragmentBytes?: number;
}

/** Hook the facade installs in `LinkModelDeps.capture`. `wants` makes taps free without captures. */
export interface CaptureTap {
  wants(port: PortRef): boolean;
  record(ev: WireEvent): void;
}

export interface CaptureInfo {
  id: CaptureId;
  name: string;
  source: 'live' | 'import';
  running: boolean;
  interfaces: CaptureInterface[];
  /** Next record index (= total recorded). */
  head: number;
  oldest: number;
  dropped: number;
}

/** List-pane row (no bytes). */
export interface CaptureRow {
  index: number;
  t: SimTime;
  iface: number;
  dir: CaptureRecord['dir'];
  len: number;
  /** Innermost meaningful protocol. */
  proto: ProtoName;
  layers: ProtoName[];
  src: string;
  dst: string;
  info: string;
  /** Normalised conversation key for follow-stream ('tcp:10.0.0.1:49152-10.0.0.80:80'), when applicable. */
  stream?: string;
  pdu?: PduId;
  corrupted?: boolean;
}

export interface CaptureQuery {
  /** Display filter text. Empty = all. */
  filter?: string;
  from: number;
  limit: number;
}

export interface CaptureQueryResult {
  rows: CaptureRow[];
  next: number;
  /** Records scanned / matched so far (progress on large captures). */
  scanned: number;
  matched: number;
  filterError?: DisplayFilterError;
}

export interface CaptureRecordDetail {
  row: CaptureRow;
  bytes: Uint8Array;
  /**
   * Decoded with the codec registry only, no PduIds allocated:
   * `decodeStandalone(bytes, outerForLinkType(iface.linkType, bytes), { fcsLen: iface.fcsLen })`. Bytes the
   * codecs do not decode go to the payload proto.
   */
  layers: LayerView[];
  summary: string;
}

export interface FollowStreamResult {
  key: string;
  proto: 'tcp' | 'udp';
  endpoints: [string, string];
  /** Reassembled payload chunks in order; `from` 0 = first endpoint. */
  chunks: { from: 0 | 1; index: number; text: string; bytes: number }[];
  retransmissions: number;
  /** Present when HTTP messages were reassembled. */
  http?: { kind: 'request' | 'response'; startLine: string; headers: string; body: string; index: number }[];
}

export interface CaptureStatistics {
  total: number;
  bytes: number;
  durationNs: SimTime;
  /** Protocol hierarchy: path 'ethernet/ipv4/tcp/http'. */
  hierarchy: { path: string; frames: number; bytes: number }[];
  conversations: { proto: 'ethernet' | 'ipv4' | 'ipv6' | 'tcp' | 'udp'; a: string; b: string; frames: number; bytes: number; firstNs: SimTime; lastNs: SimTime }[];
  endpoints: { proto: 'ethernet' | 'ipv4' | 'ipv6'; address: string; frames: number; bytes: number }[];
  lengths: { bucket: string; frames: number }[];
}

export type PcapFormat = 'pcap' | 'pcapng';

export interface CaptureExportOptions {
  format: PcapFormat;
  filter?: string;
  /** Wall-clock ns added to SimTime timestamps (UI supplies; engine default 0n keeps bytes deterministic). */
  baseWallNs?: bigint;
}

/** Classic pcap supports one link type: export refuses mixed captures with this original message. */
export const PCAP_MIXED_LINKTYPE_MESSAGE = 'This capture mixes link types; save it as pcapng instead.';

/**
 * @since P1 Outer protocol used to decode a record: ethernet → 'ethernet', ieee802_11 → 'dot11', c_hdlc → 'hdlc',
 * raw → 'ipv4' | 'ipv6' by the high nibble of bytes[0] (6 → ipv6, anything else → ipv4).
 */
export function outerForLinkType(linkType: CaptureLinkType, bytes: Uint8Array): ProtoName {
  switch (linkType) {
    case 'ethernet':
      return 'ethernet';
    case 'ieee802_11':
      return 'dot11';
    case 'c_hdlc':
      return 'hdlc';
    case 'raw':
      return bytes.length > 0 && (bytes[0] as number) >> 4 === 6 ? 'ipv6' : 'ipv4';
  }
}

// ── capture files and the shared analyser (netscope: io/pcap.ts P1 W1, capture/store.ts P1 W3) ──

/** @since P1 A capture as read from or written to pcap/pcapng. */
export interface CaptureFile {
  interfaces: CaptureInterface[];
  records: CaptureRecord[];
}

/**
 * @since P1 io/pcap.ts. Both endians, µs/ns magics; throws Error with original wording on malformed input or
 * MAX_CAPTURE_IMPORT_* overflow. Uses no sim ids or rng.
 */
export type ReadCapture = (bytes: Uint8Array) => CaptureFile;

/**
 * @since P1 io/pcap.ts. pcapng writes if_fcslen = fcsLen; classic pcap strips fcsLen bytes from each record and
 * reduces origLen to match. Throws PCAP_MIXED_LINKTYPE_MESSAGE for classic pcap with mixed link types.
 */
export type WriteCapture = (file: CaptureFile, opts: CaptureExportOptions) => Uint8Array;

/** @since P1 capture/store.ts: one analyser for live (Simulation, c_*) and imported (worker CaptureLibrary, i_*) captures. */
export interface CaptureStore {
  info(): CaptureInfo;
  /** Live tap appends; ring limits (maxRecords, MAX_CAPTURE_BYTES) drop the oldest records. */
  append(rec: CaptureRecord): void;
  setRunning(running: boolean): void;
  query(q: CaptureQuery): CaptureQueryResult;
  record(index: number): CaptureRecordDetail | undefined;
  follow(key: string): FollowStreamResult;
  stats(filter?: string): CaptureStatistics;
  export(opts: CaptureExportOptions): Uint8Array;
}

/** @since P1 */
export interface CaptureStoreInit {
  id: CaptureId;
  name: string;
  source: 'live' | 'import';
  interfaces: CaptureInterface[];
  records?: CaptureRecord[];
  maxRecords?: number;
  maxBytes?: number;
}

/** @since P1 Simulation capture methods and bridge/worker/captures.ts both delegate to this. */
export type CreateCaptureStore = (init: CaptureStoreInit) => CaptureStore;

// ── display filter (pure; also exported from the `pure` entry) ───────────────

export type DisplayFilterValue =
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'ipv4'; value: string; prefixLen?: number }
  | { type: 'ipv6'; value: string; prefixLen?: number }
  | { type: 'mac'; value: string }
  | { type: 'bool'; value: boolean };

export type DisplayFilterAst =
  | { op: 'and' | 'or'; left: DisplayFilterAst; right: DisplayFilterAst }
  | { op: 'not'; expr: DisplayFilterAst }
  | { op: 'present'; field: string }
  | { op: '==' | '!=' | '<' | '<=' | '>' | '>=' | 'contains'; field: string; value: DisplayFilterValue }
  | { op: 'in'; field: string; values: DisplayFilterValue[] };

/** Parse error: original message naming the unsupported construct, with the offending span. */
export interface DisplayFilterError {
  message: string;
  column: number;
  length: number;
}

export interface DisplayFieldDef {
  /** Name typed by the user ('ip.src', 'ipv4.src', 'tcp.flags.syn'). */
  name: string;
  /** Canonical PROTO_FIELDS path(s) it reads; several = any-of (ip.addr → ipv4.src, ipv4.dst). */
  reads: readonly string[];
  type: 'number' | 'string' | 'ipv4' | 'ipv6' | 'mac' | 'bool' | 'protocol';
  help: string;
}

export interface DisplayFilterCompletion {
  from: number;
  to: number;
  items: { label: string; kind: 'field' | 'operator' | 'keyword' | 'value'; help: string }[];
}

export const DEFAULT_CAPTURE_MAX_RECORDS = 100_000;
/** Byte cap per live capture ring (oldest records dropped beyond it). */
export const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
export const MAX_CAPTURE_IMPORT_BYTES = 64 * 1024 * 1024;
export const MAX_CAPTURE_IMPORT_RECORDS = 200_000;
