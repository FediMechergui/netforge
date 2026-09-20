/**
 * io/pcap.ts — pcap and pcapng capture files (ARCHITECTURE-P1 §4.12; contracts/capture.ts `ReadCapture`,
 * `WriteCapture`).
 *
 * Export (`writeCapture`), always little-endian and byte-deterministic for a given file and options:
 *  • pcapng: one Section Header Block (magic 0x0A0D0D0A, byte-order mark 0x1A2B3C4D, version 1.0, section length
 *    unknown, `shb_userappl`), one Interface Description Block per interface in `index` order (link type,
 *    snaplen 0 = unlimited, `if_name`, `if_tsresol` = 9 (ns), `if_fcslen` = the interface's fcsLen), and one
 *    Enhanced Packet Block per record with `ts = baseWallNs + t` in ns and `epb_flags` carrying the direction
 *    (inbound 1 / outbound 2) and the CRC-error bit (bit 24) for corrupted records.
 *  • classic pcap: magic 0xa1b23c4d (ns timestamps), version 2.4, one link type; each record loses its trailing
 *    `fcsLen` FCS bytes (only the part actually captured) and `origLen` shrinks by fcsLen. Mixed link types throw
 *    PCAP_MIXED_LINKTYPE_MESSAGE.
 *  • `opts.filter` is not applied here: the capture store chooses the records it passes in.
 *
 * Import (`readCapture`): classic pcap in both byte orders with µs or ns magics; pcapng sections in either byte
 * order with SHB / IDB / EPB / SPB and the obsolete Packet Block; unknown blocks are skipped. Every length is
 * bounds-checked and MAX_CAPTURE_IMPORT_BYTES / MAX_CAPTURE_IMPORT_RECORDS apply. Interface fcsLen = `if_fcslen`
 * when the option is present with a supported value (0, 2, 4), else 0; classic pcap uses 0. Timestamps become
 * integer ns: kept as they are when every value is a safe non-negative integer (files exported with baseWallNs 0
 * round-trip exactly), otherwise rebased on the earliest record. No sim ids, no rng, no clocks.
 */
import {
  MAX_CAPTURE_IMPORT_BYTES,
  MAX_CAPTURE_IMPORT_RECORDS,
  PCAP_LINKTYPE,
  PCAP_MIXED_LINKTYPE_MESSAGE,
  type CaptureExportOptions,
  type CaptureFile,
  type CaptureInterface,
  type CaptureLinkType,
  type CaptureRecord,
  type ReadCapture,
  type WriteCapture,
} from '../contracts/capture.js';

/** Classic pcap magic with microsecond timestamps. */
export const PCAP_MAGIC_US = 0xa1b2c3d4;
/** Classic pcap magic with nanosecond timestamps (the one NetForge writes). */
export const PCAP_MAGIC_NS = 0xa1b23c4d;
/** pcapng Section Header Block type. */
export const PCAPNG_SHB_TYPE = 0x0a0d0d0a;
/** pcapng byte-order mark. */
export const PCAPNG_BYTE_ORDER_MAGIC = 0x1a2b3c4d;
/** pcapng Interface Description Block type. */
export const PCAPNG_IDB_TYPE = 1;
/** pcapng obsolete Packet Block type. */
export const PCAPNG_PB_TYPE = 2;
/** pcapng Simple Packet Block type. */
export const PCAPNG_SPB_TYPE = 3;
/** pcapng Enhanced Packet Block type. */
export const PCAPNG_EPB_TYPE = 6;
/** Snapshot length written in classic pcap headers (raised when a record is longer). */
export const PCAP_DEFAULT_SNAPLEN = 262_144;
/** Application name written in the pcapng `shb_userappl` option. */
export const PCAPNG_USER_APPLICATION = 'NetForge NetScope';

const OPT_END = 0;
const OPT_SHB_USERAPPL = 4;
const OPT_IF_NAME = 2;
const OPT_IF_TSRESOL = 9;
const OPT_IF_FCSLEN = 13;
const OPT_IF_TSOFFSET = 14;
const OPT_EPB_FLAGS = 2;
const EPB_FLAG_INBOUND = 1;
const EPB_FLAG_OUTBOUND = 2;
const EPB_FLAG_CRC_ERROR = 1 << 24;
const NS_PER_S = 1_000_000_000n;
const U64_LIMIT = 1n << 64n;

const LINKTYPE_BY_NUMBER: ReadonlyMap<number, CaptureLinkType> = new Map<number, CaptureLinkType>([
  [PCAP_LINKTYPE.ethernet, 'ethernet'],
  [PCAP_LINKTYPE.ieee802_11, 'ieee802_11'],
  [PCAP_LINKTYPE.c_hdlc, 'c_hdlc'],
  [PCAP_LINKTYPE.raw, 'raw'],
  [228, 'raw'],
  [229, 'raw'],
]);

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

// ── writing ──────────────────────────────────────────────────────────────────

/** Little-endian append-only byte buffer. */
class ByteWriter {
  private buf = new Uint8Array(1024);
  private view = new DataView(this.buf.buffer);
  length = 0;

  private ensure(extra: number): void {
    if (this.length + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.length + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void {
    this.ensure(1);
    this.view.setUint8(this.length, v);
    this.length += 1;
  }

  u16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.length, v, true);
    this.length += 2;
  }

  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.length, v >>> 0, true);
    this.length += 4;
  }

  u64(v: bigint): void {
    this.ensure(8);
    this.view.setBigUint64(this.length, v, true);
    this.length += 8;
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
  }

  pad4(): void {
    while (this.length % 4 !== 0) this.u8(0);
  }

  /** Overwrite a u32 already written at `at`. */
  patch32(at: number, v: number): void {
    this.view.setUint32(at, v >>> 0, true);
  }

  result(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

function option(w: ByteWriter, code: number, value: Uint8Array): void {
  w.u16(code);
  w.u16(value.length);
  w.bytes(value);
  w.pad4();
}

/** Write a pcapng block: `body` fills the bytes between the length fields. */
function block(w: ByteWriter, type: number, body: (w: ByteWriter) => void): void {
  const start = w.length;
  w.u32(type);
  w.u32(0);
  body(w);
  w.pad4();
  const total = w.length - start + 4;
  w.u32(total);
  w.patch32(start + 4, total);
}

function u32le(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0, true);
  return b;
}

/** Interfaces sorted by `index`, with a map from `index` to file position. */
function orderInterfaces(ifaces: readonly CaptureInterface[]): { sorted: CaptureInterface[]; position: Map<number, number> } {
  const sorted = [...ifaces].sort((a, b) => a.index - b.index);
  const position = new Map<number, number>();
  sorted.forEach((iface, i) => {
    if (position.has(iface.index)) throw new Error(`The capture lists interface ${iface.index} twice.`);
    position.set(iface.index, i);
  });
  return { sorted, position };
}

function recordTimestamp(rec: CaptureRecord, base: bigint): bigint {
  if (!Number.isInteger(rec.t) || rec.t < 0) throw new Error(`Frame ${rec.index + 1} has an invalid time ${rec.t}.`);
  const ts = base + BigInt(rec.t);
  if (ts < 0n || ts >= U64_LIMIT) throw new Error(`Frame ${rec.index + 1} has a time that does not fit a capture file.`);
  return ts;
}

function writePcapng(file: CaptureFile, base: bigint): Uint8Array {
  const w = new ByteWriter();
  const { sorted, position } = orderInterfaces(file.interfaces);
  block(w, PCAPNG_SHB_TYPE, (b) => {
    b.u32(PCAPNG_BYTE_ORDER_MAGIC);
    b.u16(1);
    b.u16(0);
    b.u64(U64_LIMIT - 1n);
    option(b, OPT_SHB_USERAPPL, encoder.encode(PCAPNG_USER_APPLICATION));
    b.u32(OPT_END);
  });
  for (const iface of sorted) {
    block(w, PCAPNG_IDB_TYPE, (b) => {
      b.u16(PCAP_LINKTYPE[iface.linkType]);
      b.u16(0);
      b.u32(0);
      option(b, OPT_IF_NAME, encoder.encode(iface.name));
      option(b, OPT_IF_TSRESOL, Uint8Array.of(9));
      option(b, OPT_IF_FCSLEN, Uint8Array.of(iface.fcsLen));
      b.u32(OPT_END);
    });
  }
  for (const rec of file.records) {
    const pos = position.get(rec.iface);
    if (pos === undefined) throw new Error(`Frame ${rec.index + 1} refers to interface ${rec.iface}, which the capture does not list.`);
    const ts = recordTimestamp(rec, base);
    let flags = rec.dir === 'rx' ? EPB_FLAG_INBOUND : rec.dir === 'tx' ? EPB_FLAG_OUTBOUND : 0;
    if (rec.corrupted === true) flags |= EPB_FLAG_CRC_ERROR;
    block(w, PCAPNG_EPB_TYPE, (b) => {
      b.u32(pos);
      b.u32(Number(ts >> 32n));
      b.u32(Number(ts & 0xffffffffn));
      b.u32(rec.bytes.length);
      b.u32(Math.max(rec.origLen, rec.bytes.length));
      b.bytes(rec.bytes);
      b.pad4();
      if (flags !== 0) {
        option(b, OPT_EPB_FLAGS, u32le(flags));
        b.u32(OPT_END);
      }
    });
  }
  return w.result();
}

function writePcap(file: CaptureFile, base: bigint): Uint8Array {
  const linkTypes = [...new Set(file.interfaces.map((i) => i.linkType))];
  if (linkTypes.length > 1) throw new Error(PCAP_MIXED_LINKTYPE_MESSAGE);
  const { position, sorted } = orderInterfaces(file.interfaces);
  const linkType: CaptureLinkType = linkTypes[0] ?? 'ethernet';
  let snaplen = PCAP_DEFAULT_SNAPLEN;
  for (const rec of file.records) snaplen = Math.max(snaplen, rec.bytes.length);
  const w = new ByteWriter();
  w.u32(PCAP_MAGIC_NS);
  w.u16(2);
  w.u16(4);
  w.u32(0);
  w.u32(0);
  w.u32(snaplen);
  w.u32(PCAP_LINKTYPE[linkType]);
  for (const rec of file.records) {
    const pos = position.get(rec.iface);
    if (pos === undefined) throw new Error(`Frame ${rec.index + 1} refers to interface ${rec.iface}, which the capture does not list.`);
    const fcsLen = (sorted[pos] as CaptureInterface).fcsLen;
    const origLen = Math.max(rec.origLen, rec.bytes.length);
    // The FCS sits at the end of the original frame: strip only the part of it that was captured.
    const missing = origLen - rec.bytes.length;
    const strip = Math.max(0, Math.min(rec.bytes.length, fcsLen - missing));
    const data = rec.bytes.subarray(0, rec.bytes.length - strip);
    const ts = recordTimestamp(rec, base);
    const sec = ts / NS_PER_S;
    if (sec > 0xffffffffn) throw new Error('A frame time does not fit a classic pcap file; save it as pcapng instead.');
    w.u32(Number(sec));
    w.u32(Number(ts % NS_PER_S));
    w.u32(data.length);
    w.u32(Math.max(0, origLen - fcsLen, data.length));
    w.bytes(data);
  }
  return w.result();
}

/**
 * Serialise a capture as pcapng or classic pcap. `opts.baseWallNs` (default 0) is added to every record time, so
 * the default output depends only on the capture. Throws PCAP_MIXED_LINKTYPE_MESSAGE for classic pcap over mixed
 * link types, and an Error naming the frame for a record whose interface is not listed or whose time is invalid.
 */
export const writeCapture: WriteCapture = (file: CaptureFile, opts: CaptureExportOptions): Uint8Array => {
  const base = opts.baseWallNs ?? 0n;
  if (base < 0n) throw new Error('The wall-clock base of an export cannot be negative.');
  return opts.format === 'pcap' ? writePcap(file, base) : writePcapng(file, base);
};

// ── reading ──────────────────────────────────────────────────────────────────

const NOT_A_CAPTURE = 'This file is neither a pcap nor a pcapng capture.';

function truncated(at: number): never {
  throw new Error(`The capture file is cut short at byte ${at}.`);
}

function linkTypeOf(n: number): CaptureLinkType {
  const t = LINKTYPE_BY_NUMBER.get(n);
  if (t === undefined) throw new Error(`NetScope cannot open link type ${n}; it reads Ethernet, 802.11, HDLC and raw IP captures.`);
  return t;
}

/** A record before timestamps are converted to SimTime. */
interface RawRecord {
  ts: bigint;
  iface: number;
  dir: CaptureRecord['dir'];
  bytes: Uint8Array;
  origLen: number;
  corrupted: boolean;
}

function checkRecordLimit(records: readonly RawRecord[]): void {
  if (records.length >= MAX_CAPTURE_IMPORT_RECORDS) {
    throw new Error(`The capture holds more than ${MAX_CAPTURE_IMPORT_RECORDS} frames, the most NetScope imports.`);
  }
}

function readClassic(bytes: Uint8Array, view: DataView, little: boolean, nano: boolean): { interfaces: CaptureInterface[]; raw: RawRecord[] } {
  if (bytes.length < 24) truncated(bytes.length);
  const network = view.getUint32(20, little);
  const linkType = linkTypeOf(network & 0xffff);
  const interfaces: CaptureInterface[] = [{ index: 0, name: 'Interface 0', linkType, fcsLen: 0 }];
  const raw: RawRecord[] = [];
  const frac = nano ? 1n : 1000n;
  let off = 24;
  while (off < bytes.length) {
    if (off + 16 > bytes.length) truncated(bytes.length);
    const sec = view.getUint32(off, little);
    const sub = view.getUint32(off + 4, little);
    const incl = view.getUint32(off + 8, little);
    const orig = view.getUint32(off + 12, little);
    const start = off + 16;
    if (start + incl > bytes.length) truncated(bytes.length);
    checkRecordLimit(raw);
    raw.push({
      ts: BigInt(sec) * NS_PER_S + BigInt(sub) * frac,
      iface: 0,
      dir: 'unknown',
      bytes: bytes.slice(start, start + incl),
      origLen: Math.max(orig, incl),
      corrupted: false,
    });
    off = start + incl;
  }
  return { interfaces, raw };
}

/** Per-section interface state for timestamp conversion. */
interface SectionIface {
  global: number;
  tsresol: number;
  tsoffsetS: bigint;
  snaplen: number;
}

function pad4(n: number): number {
  return (n + 3) & ~3;
}

/** Walk pcapng options in `[start, end)`; calls `visit` for each option before opt_endofopt. */
function readOptions(view: DataView, start: number, end: number, little: boolean, visit: (code: number, at: number, len: number) => void): void {
  let off = start;
  while (off + 4 <= end) {
    const code = view.getUint16(off, little);
    const len = view.getUint16(off + 2, little);
    if (code === OPT_END) return;
    const at = off + 4;
    if (at + len > end) throw new Error(`A pcapng option at byte ${off} runs past its block.`);
    visit(code, at, len);
    off = at + pad4(len);
  }
}

function tsToNs(raw: bigint, iface: SectionIface): bigint {
  const r = iface.tsresol;
  let ns: bigint;
  if ((r & 0x80) !== 0) {
    ns = (raw * NS_PER_S) >> BigInt(r & 0x7f);
  } else if (r <= 9) {
    ns = raw * 10n ** BigInt(9 - r);
  } else {
    ns = raw / 10n ** BigInt(r - 9);
  }
  return ns + iface.tsoffsetS * NS_PER_S;
}

function flagsToDir(flags: number): CaptureRecord['dir'] {
  const d = flags & 3;
  return d === EPB_FLAG_INBOUND ? 'rx' : d === EPB_FLAG_OUTBOUND ? 'tx' : 'unknown';
}

function readPcapng(bytes: Uint8Array, view: DataView): { interfaces: CaptureInterface[]; raw: RawRecord[] } {
  const interfaces: CaptureInterface[] = [];
  const raw: RawRecord[] = [];
  let section: SectionIface[] = [];
  let little = true;
  let lastTs = 0n;
  let off = 0;
  while (off < bytes.length) {
    if (off + 12 > bytes.length) truncated(bytes.length);
    // The SHB type is a byte palindrome, so it reads the same before the section's byte order is known.
    if (view.getUint32(off, true) === PCAPNG_SHB_TYPE) {
      if (off + 16 > bytes.length) truncated(bytes.length);
      const bom = view.getUint32(off + 8, true);
      if (bom === PCAPNG_BYTE_ORDER_MAGIC) little = true;
      else if (bom === 0x4d3c2b1a) little = false;
      else throw new Error(`The pcapng section at byte ${off} has an unknown byte-order mark.`);
      section = [];
    } else if (off === 0) {
      throw new Error(NOT_A_CAPTURE);
    }
    const type = view.getUint32(off, little);
    const len = view.getUint32(off + 4, little);
    if (len < 12 || len % 4 !== 0) throw new Error(`The pcapng block at byte ${off} has an invalid length ${len}.`);
    if (off + len > bytes.length) truncated(bytes.length);
    if (view.getUint32(off + len - 4, little) !== len) throw new Error(`The pcapng block at byte ${off} has mismatched length fields.`);
    const body = off + 8;
    const end = off + len - 4;
    switch (type) {
      case PCAPNG_SHB_TYPE: {
        if (end - body < 16) throw new Error(`The pcapng section header at byte ${off} is too short.`);
        const major = view.getUint16(body + 4, little);
        if (major !== 1) throw new Error(`The pcapng section at byte ${off} uses version ${major}, which NetScope cannot read.`);
        break;
      }
      case PCAPNG_IDB_TYPE: {
        if (end - body < 8) throw new Error(`The pcapng interface block at byte ${off} is too short.`);
        const linkType = linkTypeOf(view.getUint16(body, little));
        const snaplen = view.getUint32(body + 4, little);
        const global = interfaces.length;
        let name = `Interface ${global}`;
        let tsresol = 6;
        let tsoffsetS = 0n;
        let fcsLen: CaptureInterface['fcsLen'] = 0;
        readOptions(view, body + 8, end, little, (code, at, olen) => {
          if (code === OPT_IF_NAME) {
            const text = decoder.decode(bytes.subarray(at, at + olen)).replace(/\0+$/, '');
            if (text.length > 0) name = text;
          } else if (code === OPT_IF_TSRESOL && olen >= 1) {
            tsresol = view.getUint8(at);
          } else if (code === OPT_IF_TSOFFSET && olen >= 8) {
            tsoffsetS = view.getBigInt64(at, little);
          } else if (code === OPT_IF_FCSLEN && olen >= 1) {
            const v = view.getUint8(at);
            fcsLen = v === 2 || v === 4 ? v : 0;
          }
        });
        if ((tsresol & 0x80) === 0 && tsresol > 18) throw new Error(`Interface ${global} uses an unsupported time resolution.`);
        if ((tsresol & 0x80) !== 0 && (tsresol & 0x7f) > 63) throw new Error(`Interface ${global} uses an unsupported time resolution.`);
        interfaces.push({ index: global, name, linkType, fcsLen });
        section.push({ global, tsresol, tsoffsetS, snaplen });
        break;
      }
      case PCAPNG_EPB_TYPE:
      case PCAPNG_PB_TYPE: {
        if (end - body < 20) throw new Error(`The pcapng packet block at byte ${off} is too short.`);
        const ifId = type === PCAPNG_EPB_TYPE ? view.getUint32(body, little) : view.getUint16(body, little);
        const iface = section[ifId];
        if (iface === undefined) throw new Error(`A packet at byte ${off} refers to interface ${ifId}, which the file never describes.`);
        const tsRaw = (BigInt(view.getUint32(body + 4, little)) << 32n) | BigInt(view.getUint32(body + 8, little));
        const caplen = view.getUint32(body + 12, little);
        const orig = view.getUint32(body + 16, little);
        const data = body + 20;
        if (data + caplen > end) throw new Error(`The pcapng packet block at byte ${off} holds fewer bytes than it claims.`);
        let flags = 0;
        readOptions(view, data + pad4(caplen), end, little, (code, at, olen) => {
          if (code === OPT_EPB_FLAGS && olen >= 4) flags = view.getUint32(at, little);
        });
        checkRecordLimit(raw);
        const ts = tsToNs(tsRaw, iface);
        lastTs = ts;
        raw.push({
          ts,
          iface: iface.global,
          dir: flagsToDir(flags),
          bytes: bytes.slice(data, data + caplen),
          origLen: Math.max(orig, caplen),
          corrupted: (flags & EPB_FLAG_CRC_ERROR) !== 0,
        });
        break;
      }
      case PCAPNG_SPB_TYPE: {
        if (end - body < 4) throw new Error(`The pcapng packet block at byte ${off} is too short.`);
        const iface = section[0];
        if (iface === undefined) throw new Error(`A packet at byte ${off} refers to interface 0, which the file never describes.`);
        const orig = view.getUint32(body, little);
        let caplen = Math.min(orig, end - body - 4);
        if (iface.snaplen > 0) caplen = Math.min(caplen, iface.snaplen);
        checkRecordLimit(raw);
        raw.push({ ts: lastTs, iface: iface.global, dir: 'unknown', bytes: bytes.slice(body + 4, body + 4 + caplen), origLen: orig, corrupted: false });
        break;
      }
      default:
        break;
    }
    off += len;
  }
  return { interfaces, raw };
}

/**
 * Parse pcap or pcapng bytes into interfaces and records (record `index` = file order). Throws an Error with an
 * original message on malformed input, unsupported link types or when the MAX_CAPTURE_IMPORT_* limits are exceeded.
 */
export const readCapture: ReadCapture = (bytes: Uint8Array): CaptureFile => {
  if (bytes.length > MAX_CAPTURE_IMPORT_BYTES) {
    throw new Error(`The capture file is larger than ${MAX_CAPTURE_IMPORT_BYTES / (1024 * 1024)} MB, the most NetScope imports.`);
  }
  if (bytes.length < 4) throw new Error(NOT_A_CAPTURE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magicLe = view.getUint32(0, true);
  const magicBe = view.getUint32(0, false);
  let parsed: { interfaces: CaptureInterface[]; raw: RawRecord[] };
  if (magicLe === PCAPNG_SHB_TYPE) parsed = readPcapng(bytes, view);
  else if (magicLe === PCAP_MAGIC_US) parsed = readClassic(bytes, view, true, false);
  else if (magicLe === PCAP_MAGIC_NS) parsed = readClassic(bytes, view, true, true);
  else if (magicBe === PCAP_MAGIC_US) parsed = readClassic(bytes, view, false, false);
  else if (magicBe === PCAP_MAGIC_NS) parsed = readClassic(bytes, view, false, true);
  else throw new Error(NOT_A_CAPTURE);
  const { interfaces, raw } = parsed;
  let min = 0n;
  let max = 0n;
  raw.forEach((r, i) => {
    if (i === 0 || r.ts < min) min = r.ts;
    if (i === 0 || r.ts > max) max = r.ts;
  });
  const safe = BigInt(Number.MAX_SAFE_INTEGER);
  const base = min >= 0n && max <= safe ? 0n : min;
  if (max - base > safe) throw new Error('The capture spans more time than NetScope can represent.');
  const records: CaptureRecord[] = raw.map((r, index) => {
    const rec: CaptureRecord = { index, t: Number(r.ts - base), iface: r.iface, dir: r.dir, bytes: r.bytes, origLen: r.origLen };
    if (r.corrupted) rec.corrupted = true;
    return rec;
  });
  return { interfaces, records };
};
