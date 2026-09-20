/**
 * capture/decode-row.ts — decoding capture records into packet-list rows (ARCHITECTURE-P1 §4.12;
 * contracts/capture.ts `CaptureRow`, `CaptureRecordDetail`).
 *
 * A record is decoded with the codec registry only (no PduIds):
 * `decodeStandalone(bytes, outerForLinkType(iface.linkType, bytes), { fcsLen: iface.fcsLen })`.
 *
 * Row columns:
 *  • `proto`: the chain's meaningful protocol (`topProto`; transparent layers skipped, ICMP errors stop descent);
 *  • `layers`: every decoded protocol, outermost first;
 *  • `src` / `dst`: the frame's own IP addresses (the last `ipv4`/`ipv6` layer before any ICMP quote); without an
 *    IP header, the link addresses (ethernet src/dst, 802.11 transmitter addr2 / receiver addr1); otherwise '';
 *  • `info`: the chain summary; `len`: the original length on the wire; `stream`: the follow-stream key.
 *
 * `createDecodeCache` keeps the most recently used decodes (default 2000 frames, least recently used evicted
 * first). It is keyed by record index, which is unique and immutable within one capture store.
 */
import { outerForLinkType, type CaptureInterface, type CaptureRecord, type CaptureRow } from '../contracts/capture.js';
import type { FieldValue, LayerView, ProtoName } from '../contracts/pdu.js';
import { decodeStandalone } from '../pdu/codecs/registry.js';
import { networkLayerIndex, streamKeyOf } from './stream.js';

/** Number of decoded frames the row cache keeps (§4.12). */
export const CAPTURE_DECODE_CACHE_SIZE = 2000;

/** One decoded record: its layers, summary, meaningful protocol and list row. */
export interface DecodedRecord {
  readonly layers: readonly LayerView[];
  readonly summary: string;
  readonly topProto: ProtoName;
  readonly row: CaptureRow;
}

function addr(v: FieldValue | undefined): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '';
}

/** Source and destination column text of a decoded frame (see the file header). */
export function frameAddresses(layers: readonly LayerView[]): { src: string; dst: string } {
  const ni = networkLayerIndex(layers);
  if (ni >= 0) {
    const ip = layers[ni]!;
    return { src: addr(ip.fields.src), dst: addr(ip.fields.dst) };
  }
  for (const l of layers) {
    if (l.proto === 'ethernet') return { src: addr(l.fields.src), dst: addr(l.fields.dst) };
    if (l.proto === 'dot11') return { src: addr(l.fields.addr2), dst: addr(l.fields.addr1) };
  }
  return { src: '', dst: '' };
}

/** Decode a record's bytes for its capture interface (codec registry only). */
export function decodeRecordLayers(rec: Pick<CaptureRecord, 'bytes'>, iface: Pick<CaptureInterface, 'linkType' | 'fcsLen'>): {
  layers: LayerView[];
  summary: string;
  topProto: ProtoName;
} {
  return decodeStandalone(rec.bytes, outerForLinkType(iface.linkType, rec.bytes), { fcsLen: iface.fcsLen });
}

/** Build the packet-list row of a record from its decode. */
export function rowOf(rec: CaptureRecord, layers: readonly LayerView[], summary: string, topProto: ProtoName): CaptureRow {
  const { src, dst } = frameAddresses(layers);
  const row: CaptureRow = {
    index: rec.index,
    t: rec.t,
    iface: rec.iface,
    dir: rec.dir,
    len: Math.max(rec.origLen, rec.bytes.length),
    proto: topProto,
    layers: layers.map((l) => l.proto),
    src,
    dst,
    info: summary,
  };
  const stream = streamKeyOf(layers);
  if (stream !== undefined) row.stream = stream;
  if (rec.pdu !== undefined) row.pdu = rec.pdu;
  if (rec.corrupted === true) row.corrupted = true;
  return row;
}

/** Decode a record and build its row. */
export function decodeCaptureRecord(rec: CaptureRecord, iface: Pick<CaptureInterface, 'linkType' | 'fcsLen'>): DecodedRecord {
  const d = decodeRecordLayers(rec, iface);
  return { layers: d.layers, summary: d.summary, topProto: d.topProto, row: rowOf(rec, d.layers, d.summary, d.topProto) };
}

/** A bounded least-recently-used cache of decoded records, keyed by record index. */
export interface DecodeCache {
  /** The decode of `rec` (from the cache, or decoded now and cached). */
  get(rec: CaptureRecord, iface: Pick<CaptureInterface, 'linkType' | 'fcsLen'>): DecodedRecord;
  /** Forget one record (it left the ring). */
  delete(index: number): void;
  /** Forget everything. */
  clear(): void;
  /** Number of cached decodes. */
  readonly size: number;
  /** Maximum number of cached decodes. */
  readonly capacity: number;
}

/** Create a decode cache holding at most `capacity` frames (default {@link CAPTURE_DECODE_CACHE_SIZE}). */
export function createDecodeCache(capacity = CAPTURE_DECODE_CACHE_SIZE): DecodeCache {
  if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`A decode cache needs a positive whole capacity, not ${capacity}.`);
  const map = new Map<number, DecodedRecord>();
  return {
    get(rec, iface) {
      const hit = map.get(rec.index);
      if (hit !== undefined) {
        map.delete(rec.index);
        map.set(rec.index, hit);
        return hit;
      }
      const d = decodeCaptureRecord(rec, iface);
      map.set(rec.index, d);
      if (map.size > capacity) {
        const oldest = map.keys().next();
        if (oldest.done !== true) map.delete(oldest.value);
      }
      return d;
    },
    delete(index) {
      map.delete(index);
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
    capacity,
  };
}
