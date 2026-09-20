/**
 * capture/stream.ts — conversation keys and follow-stream reassembly for NetScope (ARCHITECTURE-P1 §4.12;
 * contracts/capture.ts `CaptureRow.stream`, `FollowStreamResult`).
 *
 * Stream keys: `<proto>:<endpoint>-<endpoint>` with `proto` 'tcp' or 'udp' and each endpoint written `addr:port`
 * (IPv6 addresses in brackets: `[2001:db8::1]:80`). The two endpoints are normalised: the lower address comes
 * first (IPv4 before IPv6, numeric order inside a family), then the lower port. Both directions of one conversation
 * therefore share a key, e.g. `tcp:10.0.0.1:49152-10.0.0.80:80`.
 *
 * The transport layer of a frame is the first `tcp`/`udp` layer that is not quoted inside an ICMP error (no
 * `icmpv4`/`icmpv6` layer before it); its addresses come from the nearest enclosing `ipv4`/`ipv6` layer.
 *
 * Follow stream:
 *  • The same frame seen at several capture points (tx on one end of a cable, rx on the other, the next hop after
 *    a router) is one observation: a frame whose transport header (ports, sequence, acknowledgement, flags, window,
 *    checksum), payload length and IPv4 identification match a frame already seen at a DIFFERENT point (interface +
 *    direction) and never at this point is skipped entirely.
 *  • TCP (RFC 9293 sequence space, modulo 2^32): per direction, the stream origin is the SYN's sequence number + 1
 *    (the SYN consumes one number) or, without a SYN in the capture, the first data segment's sequence number.
 *    Data is appended in sequence order: data wholly below the next expected byte is a retransmission and is
 *    dropped; a partial overlap counts as a retransmission and contributes only its new tail; data above the next
 *    expected byte is held until the gap fills. Held data still waiting at the end is appended in sequence order
 *    (the missing bytes were never captured). Consecutive data of one direction forms one chunk.
 *  • UDP: every datagram with a payload is one chunk; nothing is reassembled.
 *  • The first endpoint is the sender of the first SYN without ACK when the capture holds one, otherwise the sender
 *    of the first frame of the stream.
 *  • HTTP: each direction's reassembled bytes are parsed with the http codec's pure `parseHttpStream`; every
 *    message with a start line is listed with the record index of the segment carrying its first byte.
 *  • Chunk text is the UTF-8 decoding of the bytes with C0 controls other than tab, LF and CR (and DEL) shown as '.'.
 */
import type { CaptureRecord, FollowStreamResult } from '../contracts/capture.js';
import { parseIpv4 } from '../contracts/addr.js';
import type { FieldValue, LayerView } from '../contracts/pdu.js';
import { parseIpv6 } from '../core/addr6.js';
import { parseHttpStream } from '../pdu/codecs/http.js';

const UTF8 = new TextDecoder('utf-8', { fatal: false });

/** Transport protocols that have follow streams. */
export type StreamProto = 'tcp' | 'udp';

/** The transport view of one decoded frame. */
export interface TransportView {
  proto: StreamProto;
  /** Index of the transport layer in the layer list. */
  layerIndex: number;
  /** Address family of the enclosing IP layer. */
  family: 'ipv4' | 'ipv6';
  src: string;
  dst: string;
  srcPort: number;
  dstPort: number;
  /** `addr:port` text of each end (IPv6 bracketed). */
  srcEndpoint: string;
  dstEndpoint: string;
  /** Normalised stream key. */
  key: string;
}

/** A parsed stream key. */
export interface ParsedStreamKey {
  proto: StreamProto;
  /** The two endpoints in key order (`addr:port`). */
  endpoints: [string, string];
}

/** One captured frame handed to `followStream`. */
export interface FollowFrame {
  /** Capture record index. */
  index: number;
  iface: number;
  dir: CaptureRecord['dir'];
  /** Captured bytes the layers were decoded from. */
  bytes: Uint8Array;
  layers: readonly LayerView[];
}

function isQuoteBoundary(proto: string): boolean {
  return proto === 'icmpv4' || proto === 'icmpv6';
}

/** Index of the first `tcp`/`udp` layer that is not inside an ICMP error quote, or -1. */
export function transportLayerIndex(layers: readonly LayerView[]): number {
  for (let i = 0; i < layers.length; i++) {
    const p = layers[i]!.proto;
    if (isQuoteBoundary(p)) return -1;
    if (p === 'tcp' || p === 'udp') return i;
  }
  return -1;
}

/** Index of the last `ipv4`/`ipv6` layer before the first ICMP quote boundary (the frame's own IP header), or -1. */
export function networkLayerIndex(layers: readonly LayerView[]): number {
  let found = -1;
  for (let i = 0; i < layers.length; i++) {
    const p = layers[i]!.proto;
    if (p === 'ipv4' || p === 'ipv6') found = i;
    if (isQuoteBoundary(p)) break;
  }
  return found;
}

function text(v: FieldValue | undefined): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function num(v: FieldValue | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** `addr:port`, with an IPv6 address in brackets. */
export function formatStreamEndpoint(address: string, port: number): string {
  return address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`;
}

/** Split `addr:port` / `[v6]:port` into its parts; undefined when the text is not an endpoint. */
export function splitStreamEndpoint(endpoint: string): { address: string; port: number } | undefined {
  let address: string;
  let portText: string;
  if (endpoint.startsWith('[')) {
    const close = endpoint.indexOf(']:');
    if (close < 0) return undefined;
    address = endpoint.slice(1, close);
    portText = endpoint.slice(close + 2);
  } else {
    const colon = endpoint.lastIndexOf(':');
    if (colon <= 0) return undefined;
    address = endpoint.slice(0, colon);
    portText = endpoint.slice(colon + 1);
  }
  if (!/^\d{1,5}$/.test(portText)) return undefined;
  const port = Number(portText);
  if (port > 65535) return undefined;
  return { address, port };
}

/**
 * Total order on address text used by keys and statistics: IPv4 (numeric) before IPv6 (numeric by bytes) before
 * any other text (MACs and names, compared as strings).
 */
export function compareAddresses(a: string, b: string): number {
  const rank = (s: string): { r: number; v4?: number; v6?: Uint8Array } => {
    const v4 = parseIpv4(s);
    if (v4 !== null) return { r: 0, v4 };
    const v6 = parseIpv6(s);
    if (v6 !== null) return { r: 1, v6 };
    return { r: 2 };
  };
  const x = rank(a);
  const y = rank(b);
  if (x.r !== y.r) return x.r - y.r;
  if (x.r === 0) return (x.v4 as number) - (y.v4 as number);
  if (x.r === 1) {
    const p = x.v6 as Uint8Array;
    const q = y.v6 as Uint8Array;
    for (let i = 0; i < 16; i++) if (p[i] !== q[i]) return (p[i] as number) - (q[i] as number);
    return 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Order two `addr:port` endpoints: address first ({@link compareAddresses}), then port. */
export function compareStreamEndpoints(a: string, b: string): number {
  const x = splitStreamEndpoint(a);
  const y = splitStreamEndpoint(b);
  if (x === undefined || y === undefined) return a < b ? -1 : a > b ? 1 : 0;
  const c = compareAddresses(x.address, y.address);
  return c !== 0 ? c : x.port - y.port;
}

/** Normalised stream key of a conversation between two endpoints. */
export function streamKey(proto: StreamProto, a: string, b: string): string {
  return compareStreamEndpoints(a, b) <= 0 ? `${proto}:${a}-${b}` : `${proto}:${b}-${a}`;
}

/** Parse a stream key; undefined when it is not `tcp:`/`udp:` followed by two endpoints. */
export function parseStreamKey(key: string): ParsedStreamKey | undefined {
  const colon = key.indexOf(':');
  if (colon < 0) return undefined;
  const proto = key.slice(0, colon);
  if (proto !== 'tcp' && proto !== 'udp') return undefined;
  const rest = key.slice(colon + 1);
  const dash = rest.indexOf('-');
  if (dash < 0) return undefined;
  const a = rest.slice(0, dash);
  const b = rest.slice(dash + 1);
  if (splitStreamEndpoint(a) === undefined || splitStreamEndpoint(b) === undefined) return undefined;
  return { proto, endpoints: [a, b] };
}

/** The transport view of a decoded frame, or undefined when it carries no (unquoted) TCP/UDP header with an IP header. */
export function transportView(layers: readonly LayerView[]): TransportView | undefined {
  const ti = transportLayerIndex(layers);
  if (ti < 0) return undefined;
  let ii = -1;
  for (let i = ti - 1; i >= 0; i--) {
    const p = layers[i]!.proto;
    if (p === 'ipv4' || p === 'ipv6') {
      ii = i;
      break;
    }
  }
  if (ii < 0) return undefined;
  const ip = layers[ii]!;
  const tl = layers[ti]!;
  const src = text(ip.fields.src);
  const dst = text(ip.fields.dst);
  const srcPort = num(tl.fields.srcPort);
  const dstPort = num(tl.fields.dstPort);
  if (src === undefined || dst === undefined || srcPort === undefined || dstPort === undefined) return undefined;
  const proto = tl.proto as StreamProto;
  const srcEndpoint = formatStreamEndpoint(src, srcPort);
  const dstEndpoint = formatStreamEndpoint(dst, dstPort);
  return {
    proto,
    layerIndex: ti,
    family: ip.proto as 'ipv4' | 'ipv6',
    src,
    dst,
    srcPort,
    dstPort,
    srcEndpoint,
    dstEndpoint,
    key: streamKey(proto, srcEndpoint, dstEndpoint),
  };
}

/** Stream key of a decoded frame (`CaptureRow.stream`), or undefined. */
export function streamKeyOf(layers: readonly LayerView[]): string | undefined {
  return transportView(layers)?.key;
}

/** Bytes a transport layer carries: `[offset + headerLength, offset + length - trailerLength)`, clamped to `bytes`. */
export function transportPayload(bytes: Uint8Array, layer: LayerView): Uint8Array {
  const from = Math.min(bytes.length, Math.max(0, layer.offset + layer.headerLength));
  const to = Math.min(bytes.length, Math.max(from, layer.offset + layer.length - (layer.trailerLength ?? 0)));
  return bytes.subarray(from, to);
}

/** Printable text of stream bytes: UTF-8 with C0 controls except tab/LF/CR, and DEL, shown as '.'. */
export function streamText(bytes: Uint8Array): string {
  return UTF8.decode(bytes).replace(/[ --]/g, '.');
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Signed 32-bit distance `a - b` in sequence space (RFC 9293 §3.4 modular arithmetic). */
export function seqDiff(a: number, b: number): number {
  return ((a - b) | 0);
}

interface ChunkBuild {
  from: 0 | 1;
  index: number;
  parts: Uint8Array[];
  bytes: number;
}

interface Held {
  rel: number;
  data: Uint8Array;
  index: number;
}

interface Direction {
  /** Sequence number of stream offset 0. */
  base: number | undefined;
  /** Next expected stream offset. */
  next: number;
  held: Held[];
  /** Appended bytes in order, with the record index each run came from. */
  runs: { offset: number; index: number; data: Uint8Array }[];
}

function newDirection(): Direction {
  return { base: undefined, next: 0, held: [], runs: [] };
}

/**
 * Reassemble the conversation `key` from `frames` (capture order). Frames that do not belong to the key are ignored.
 * An unparsable key or a key without frames gives an empty result (proto 'tcp' when the key names neither).
 */
export function followStream(key: string, frames: readonly FollowFrame[]): FollowStreamResult {
  const parsed = parseStreamKey(key);
  const proto: StreamProto = parsed?.proto ?? 'tcp';
  const result: FollowStreamResult = {
    key,
    proto,
    endpoints: parsed !== undefined ? [parsed.endpoints[0], parsed.endpoints[1]] : ['', ''],
    chunks: [],
    retransmissions: 0,
  };
  if (parsed === undefined) return result;

  // Select the stream's frames once, dropping repeated observations of the same frame at other capture points.
  const seenAt = new Map<string, Set<string>>();
  const mine: { f: FollowFrame; v: TransportView; tl: LayerView }[] = [];
  for (const f of frames) {
    const v = transportView(f.layers);
    if (v === undefined || v.key !== key) continue;
    const tl = f.layers[v.layerIndex]!;
    const ip = f.layers[networkLayerIndex(f.layers)];
    const payloadLen = transportPayload(f.bytes, tl).length;
    const sig = [
      v.srcEndpoint,
      v.dstEndpoint,
      String(tl.fields.seq ?? ''),
      String(tl.fields.ack ?? ''),
      String(tl.fields.flags ?? ''),
      String(tl.fields.window ?? ''),
      String(tl.fields.checksum ?? ''),
      String(payloadLen),
      ip !== undefined && ip.proto === 'ipv4' ? String(ip.fields.id ?? '') : '',
    ].join('|');
    const point = `${f.iface}:${f.dir}`;
    let points = seenAt.get(sig);
    if (points === undefined) {
      points = new Set<string>();
      seenAt.set(sig, points);
    } else if (!points.has(point)) {
      // The same frame observed at another capture point.
      points.add(point);
      continue;
    }
    points.add(point);
    mine.push({ f, v, tl });
  }
  if (mine.length === 0) return result;

  // First endpoint: the active opener when a SYN without ACK is present, else the first sender.
  let first = mine[0]!.v.srcEndpoint;
  if (proto === 'tcp') {
    for (const m of mine) {
      const flags = String(m.tl.fields.flags ?? '');
      if (flags.includes('S') && !flags.includes('A')) {
        first = m.v.srcEndpoint;
        break;
      }
    }
  }
  const second = first === parsed.endpoints[0] ? parsed.endpoints[1] : parsed.endpoints[0];
  result.endpoints = [first, second];

  const chunks: ChunkBuild[] = [];
  const emit = (from: 0 | 1, index: number, data: Uint8Array, merge: boolean): void => {
    if (data.length === 0) return;
    const last = chunks[chunks.length - 1];
    if (merge && last !== undefined && last.from === from) {
      last.parts.push(data);
      last.bytes += data.length;
      return;
    }
    chunks.push({ from, index, parts: [data], bytes: data.length });
  };

  const dirs: [Direction, Direction] = [newDirection(), newDirection()];
  let retransmissions = 0;

  if (proto === 'udp') {
    for (const m of mine) {
      const from: 0 | 1 = m.v.srcEndpoint === first ? 0 : 1;
      const data = transportPayload(m.f.bytes, m.tl);
      if (data.length > 0) dirs[from].runs.push({ offset: 0, index: m.f.index, data });
      emit(from, m.f.index, data, false);
    }
  } else {
    const append = (d: Direction, from: 0 | 1, index: number, data: Uint8Array): void => {
      d.runs.push({ offset: d.next, index, data });
      d.next += data.length;
      emit(from, index, data, true);
    };
    const drain = (d: Direction, from: 0 | 1): void => {
      for (;;) {
        d.held.sort((x, y) => x.rel - y.rel || x.index - y.index);
        const h = d.held[0];
        if (h === undefined || h.rel > d.next) return;
        d.held.shift();
        const end = h.rel + h.data.length;
        if (end <= d.next) {
          retransmissions++;
          continue;
        }
        if (h.rel < d.next) retransmissions++;
        append(d, from, h.index, h.data.subarray(d.next - h.rel));
      }
    };
    for (const m of mine) {
      const from: 0 | 1 = m.v.srcEndpoint === first ? 0 : 1;
      const d = dirs[from];
      const flags = String(m.tl.fields.flags ?? '');
      const seqField = m.tl.fields.seq;
      const seq = typeof seqField === 'number' ? seqField >>> 0 : 0;
      const data = transportPayload(m.f.bytes, m.tl);
      const syn = flags.includes('S');
      if (d.base === undefined) {
        if (syn) d.base = (seq + 1) >>> 0;
        else if (data.length > 0) d.base = seq;
        else continue;
      }
      if (data.length === 0) continue;
      const dataSeq = syn ? (seq + 1) >>> 0 : seq;
      let rel = seqDiff(dataSeq, d.base);
      let payload = data;
      if (rel < 0) {
        // Bytes before the stream origin (a stale retransmission of an earlier incarnation's data).
        if (rel + payload.length <= 0) {
          retransmissions++;
          continue;
        }
        payload = payload.subarray(-rel);
        rel = 0;
        retransmissions++;
      }
      const end = rel + payload.length;
      if (end <= d.next) {
        retransmissions++;
        continue;
      }
      if (rel > d.next) {
        if (d.held.some((h) => h.rel === rel && h.data.length === payload.length)) retransmissions++;
        else d.held.push({ rel, data: payload, index: m.f.index });
        continue;
      }
      if (rel < d.next) retransmissions++;
      append(d, from, m.f.index, payload.subarray(d.next - rel));
      drain(d, from);
    }
    // Data still held after a gap that was never filled: append it in sequence order.
    for (const from of [0, 1] as const) {
      const d = dirs[from];
      d.held.sort((x, y) => x.rel - y.rel || x.index - y.index);
      for (const h of d.held) {
        const end = h.rel + h.data.length;
        if (end <= d.next) {
          retransmissions++;
          continue;
        }
        const start = Math.max(h.rel, d.next);
        if (h.rel < d.next) retransmissions++;
        d.runs.push({ offset: start, index: h.index, data: h.data.subarray(start - h.rel) });
        d.next = end;
        emit(from, h.index, h.data.subarray(start - h.rel), true);
      }
      d.held = [];
    }
  }

  result.retransmissions = retransmissions;
  result.chunks = chunks.map((c) => {
    const bytes = concatBytes(c.parts);
    return { from: c.from, index: c.index, text: streamText(bytes), bytes: c.bytes };
  });

  if (proto === 'tcp') {
    const http = httpMessages(dirs);
    if (http.length > 0) result.http = http;
  }
  return result;
}

/** HTTP messages of both directions' reassembled bytes, ordered by record index, then direction. */
function httpMessages(dirs: readonly [Direction, Direction]): NonNullable<FollowStreamResult['http']> {
  const found: { from: 0 | 1; entry: NonNullable<FollowStreamResult['http']>[number] }[] = [];
  for (const from of [0, 1] as const) {
    const d = dirs[from];
    if (d.runs.length === 0) continue;
    const all = concatBytes(d.runs.map((r) => r.data));
    // Position of each run in the concatenation (a run after a never-filled gap follows its predecessor directly).
    const starts: number[] = [];
    let o = 0;
    for (const r of d.runs) {
      starts.push(o);
      o += r.data.length;
    }
    const recordAt = (offset: number): number => {
      let idx = d.runs[0]!.index;
      for (let i = 0; i < starts.length && starts[i]! <= offset; i++) idx = d.runs[i]!.index;
      return idx;
    };
    let at = 0;
    for (const m of parseHttpStream(all)) {
      if (m.method !== undefined || m.status !== undefined) {
        found.push({ from, entry: { kind: m.kind, startLine: m.startLine, headers: m.headers, body: m.body, index: recordAt(at) } });
      }
      at += m.consumed;
    }
  }
  found.sort((a, b) => a.entry.index - b.entry.index || a.from - b.from);
  return found.map((x) => x.entry);
}
