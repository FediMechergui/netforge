/**
 * TCP codec (RFC 9293 header; options RFC 9293 MSS, RFC 7323 window scale and timestamps, RFC 2018 SACK) —
 * ARCHITECTURE-P1 §4.5, contracts/fields.ts `tcp`.
 *
 * Wire image: `srcPort(2) dstPort(2) seq(4) ack(4) dataOffset/reserved(1) flags(1) window(2) checksum(2)
 * urgentPointer(2) options... data...`.
 *  • `flags` is a string of letters in the fixed order F S R P A U E C (FIN 0x01, SYN 0x02, RST 0x04, PSH 0x08,
 *    ACK 0x10, URG 0x20, ECE 0x40, CWR 0x80), e.g. 'S', 'SA', 'A', 'PA', 'FA', 'R'. Encode accepts the letters in
 *    any order (or a number of flag bits) and always writes the canonical order; unknown letters throw.
 *  • Options: mss (kind 2), windowScale (3), sackPermitted (4), sackBlocks (5, 'l1-r1,l2-r2'), timestamp and
 *    timestampEcho (8). Encode writes them in the order MSS, SACK-permitted, timestamps, window scale, SACK
 *    blocks, aligning each with NOPs as usual, then pads the header to a 4-byte multiple with EOL/zero bytes.
 *    Decode skips NOPs and unknown kinds by their length; a malformed option list sets an error but keeps the
 *    header fields.
 *  • `dataOffset` and `checksum` are derived (always recomputed by `encode`). The checksum covers the pseudo-
 *    header of the NEAREST enclosing IP layer (length = segment length); with no enclosing IP layer it is 0.
 *    `outerInputs` lists ipv4.src/dst and ipv6.src/dst so a NAT-style `mutate` re-encodes the segment.
 *  • The segment length is the bound handed down by IP (TCP has no length field), so the layer covers it all.
 *  • A header quoted inside an ICMP/ICMPv6 error decodes without error even when only its first 8 bytes are
 *    present; quoted segments are never checksum-verified (`checksumValid` undefined).
 *  • Next layer: DISPATCH_TABLE `tcp.port` (destination first, then source) whenever the segment carries at
 *    least 1 data byte; the application codec reports `partial` for an incomplete message. Otherwise payload.
 */
import type { Codec, CodecContext, DecodedLayer, FieldValue, MutationReason, ProtoName } from '../../contracts/pdu.js';
import { IPPROTO_TCP, TCP_MIN_HEADER } from '../../contracts/pdu.js';
import { finishChecksum, numField, onesSum, readU16, readU32, writeU16, writeU32 } from '../checksum.js';
import { lookupPortNext } from './dispatch.js';
import { isQuotedContext, nearestIpLayer, pseudoHeaderSumFor, transportEndpoints } from './udp.js';

/** Flag letters in bit order (bit 0 = F … bit 7 = C); also the canonical letter order of `tcp.flags`. */
export const TCP_FLAG_LETTERS = 'FSRPAUEC';

/** Largest TCP header (dataOffset 15). */
const MAX_HEADER = 60;

/** Canonical flag string for a flags byte, e.g. 0x12 → 'SA'. */
export function tcpFlagsFromBits(bits: number): string {
  let out = '';
  for (let i = 0; i < 8; i++) if ((bits >>> i) & 1) out += TCP_FLAG_LETTERS[i];
  return out;
}

/**
 * Flags byte for a flag string (letters in any order, case-sensitive, each at most once) or a number of flag
 * bits (0–255). Throws on an unknown or repeated letter.
 */
export function tcpFlagBits(flags: FieldValue | undefined): number {
  if (flags === undefined || flags === null || flags === '') return 0;
  if (typeof flags === 'number') {
    if (!Number.isInteger(flags) || flags < 0 || flags > 0xff) throw new Error(`tcp.flags out of range: ${flags}`);
    return flags;
  }
  if (typeof flags !== 'string') throw new Error('tcp.flags must be a string of flag letters');
  let bits = 0;
  for (const ch of flags) {
    const i = TCP_FLAG_LETTERS.indexOf(ch);
    if (i < 0) throw new Error(`tcp.flags has an unknown flag letter "${ch}" (use ${TCP_FLAG_LETTERS})`);
    if ((bits >>> i) & 1) throw new Error(`tcp.flags repeats the flag letter "${ch}"`);
    bits |= 1 << i;
  }
  return bits;
}

/** Normalise a flag string to the canonical FSRPAUEC order ('AS' → 'SA'). */
export function normalizeTcpFlags(flags: string): string {
  return tcpFlagsFromBits(tcpFlagBits(flags));
}

/** True when the flag string (as decoded) carries `letter`. */
export function hasTcpFlag(flags: FieldValue | undefined, letter: string): boolean {
  return typeof flags === 'string' && letter.length === 1 && flags.includes(letter);
}

/** Parse `'l1-r1,l2-r2'` SACK blocks into 32-bit edge pairs; throws on malformed text or more than 4 blocks. */
export function parseSackBlocks(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const part of text.split(',')) {
    const t = part.trim();
    if (t === '') continue;
    const m = /^(\d+)-(\d+)$/.exec(t);
    if (!m) throw new Error(`tcp.sackBlocks entry "${t}" must be "left-right"`);
    const l = Number(m[1]);
    const r = Number(m[2]);
    if (l > 0xffffffff || r > 0xffffffff) throw new Error(`tcp.sackBlocks entry "${t}" is outside 32 bits`);
    out.push([l, r]);
  }
  if (out.length > 4) throw new Error('tcp.sackBlocks holds at most 4 blocks');
  return out;
}

const DERIVED: Readonly<Record<string, MutationReason>> = Object.freeze({ dataOffset: 'Other', checksum: 'ChecksumRecompute' });

/** Parse the option bytes `[start, end)` into `fields`; returns an error text or undefined. */
function decodeOptions(
  bytes: Uint8Array,
  start: number,
  end: number,
  fields: Record<string, FieldValue>,
  fieldRanges: Record<string, readonly [number, number]>,
): string | undefined {
  let i = start;
  while (i < end) {
    const kind = bytes[i]!;
    if (kind === 0) return undefined; // end of option list
    if (kind === 1) {
      i++;
      continue;
    }
    if (i + 1 >= end) return 'TCP option list truncated';
    const len = bytes[i + 1]!;
    if (len < 2 || i + len > end) return `TCP option ${kind} has a bad length ${len}`;
    switch (kind) {
      case 2:
        if (len !== 4) return `TCP MSS option has a bad length ${len}`;
        fields.mss = readU16(bytes, i + 2);
        fieldRanges.mss = [i, len];
        break;
      case 3:
        if (len !== 3) return `TCP window scale option has a bad length ${len}`;
        fields.windowScale = bytes[i + 2]!;
        fieldRanges.windowScale = [i, len];
        break;
      case 4:
        if (len !== 2) return `TCP SACK-permitted option has a bad length ${len}`;
        fields.sackPermitted = true;
        fieldRanges.sackPermitted = [i, len];
        break;
      case 5: {
        if ((len - 2) % 8 !== 0) return `TCP SACK option has a bad length ${len}`;
        const blocks: string[] = [];
        for (let b = i + 2; b < i + len; b += 8) blocks.push(`${readU32(bytes, b)}-${readU32(bytes, b + 4)}`);
        fields.sackBlocks = blocks.join(',');
        fieldRanges.sackBlocks = [i, len];
        break;
      }
      case 8:
        if (len !== 10) return `TCP timestamp option has a bad length ${len}`;
        fields.timestamp = readU32(bytes, i + 2);
        fields.timestampEcho = readU32(bytes, i + 6);
        fieldRanges.timestamp = [i + 2, 4];
        fieldRanges.timestampEcho = [i + 6, 4];
        break;
      default:
        break; // unknown option: skipped by its length
    }
    i += len;
  }
  return undefined;
}

function decode(bytes: Uint8Array, offset: number, length: number, ctx?: CodecContext): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  const quoted = isQuotedContext(ctx);

  if (avail >= 2) {
    fields.srcPort = readU16(bytes, offset);
    fieldRanges.srcPort = [offset, 2];
  }
  if (avail >= 4) {
    fields.dstPort = readU16(bytes, offset + 2);
    fieldRanges.dstPort = [offset + 2, 2];
  }
  if (avail >= 8) {
    fields.seq = readU32(bytes, offset + 4);
    fieldRanges.seq = [offset + 4, 4];
  }
  if (avail >= 12) {
    fields.ack = readU32(bytes, offset + 8);
    fieldRanges.ack = [offset + 8, 4];
  }
  if (avail >= 14) {
    fields.dataOffset = bytes[offset + 12]! >>> 4;
    fields.flags = tcpFlagsFromBits(bytes[offset + 13]!);
    fieldRanges.dataOffset = [offset + 12, 1];
    fieldRanges.flags = [offset + 13, 1];
  }
  if (avail >= 16) {
    fields.window = readU16(bytes, offset + 14);
    fieldRanges.window = [offset + 14, 2];
  }
  if (avail >= 18) {
    fields.checksum = readU16(bytes, offset + 16);
    fieldRanges.checksum = [offset + 16, 2];
  }
  if (avail < TCP_MIN_HEADER) {
    const out: DecodedLayer = { fields, fieldRanges, headerLength: avail, length: avail };
    if (!quoted) out.error = 'TCP header truncated';
    return out;
  }
  fields.urgentPointer = readU16(bytes, offset + 18);
  fieldRanges.urgentPointer = [offset + 18, 2];

  const dataOffset = fields.dataOffset as number;
  const hdrLen = dataOffset * 4;
  if (hdrLen < TCP_MIN_HEADER) {
    if (!quoted) fields.checksumValid = false;
    return { fields, fieldRanges, headerLength: TCP_MIN_HEADER, length: avail, error: `bad TCP data offset ${dataOffset}` };
  }
  if (avail < hdrLen) {
    const out: DecodedLayer = { fields, fieldRanges, headerLength: avail, length: avail };
    decodeOptions(bytes, offset + TCP_MIN_HEADER, offset + avail, fields, fieldRanges);
    if (!quoted) out.error = 'TCP options truncated';
    return out;
  }

  const optionError = decodeOptions(bytes, offset + TCP_MIN_HEADER, offset + hdrLen, fields, fieldRanges);
  if (!quoted && nearestIpLayer(ctx)) {
    const pseudo = pseudoHeaderSumFor(ctx, IPPROTO_TCP, avail);
    if (pseudo !== undefined) fields.checksumValid = finishChecksum(onesSum(bytes, offset, avail, pseudo)) === 0;
  }

  const out: DecodedLayer = { fields, fieldRanges, headerLength: hdrLen, length: avail };
  if (optionError !== undefined) out.error = optionError;
  const dataLen = avail - hdrLen;
  if (dataLen > 0) {
    const app: ProtoName | undefined = quoted ? undefined : lookupPortNext('tcp.port', fields.dstPort as number, fields.srcPort as number, dataLen);
    out.next = { proto: app ?? 'payload', offset: offset + hdrLen, length: dataLen };
  }
  return out;
}

/** Option bytes for `fields`, already padded to a 4-byte multiple. */
function encodeOptions(fields: Readonly<Record<string, FieldValue>>): number[] {
  const p = 'tcp';
  const o: number[] = [];
  const mssV = fields.mss;
  if (mssV !== undefined && mssV !== null) {
    const mss = numField(p, fields, 'mss', null);
    if (mss < 0 || mss > 0xffff) throw new Error(`tcp.mss out of range: ${mss}`);
    o.push(2, 4, mss >>> 8, mss & 0xff);
  }
  const sackPermitted = fields.sackPermitted === true || fields.sackPermitted === 1;
  const tsV = fields.timestamp;
  const hasTs = tsV !== undefined && tsV !== null;
  if (sackPermitted && hasTs) o.push(4, 2);
  else if (sackPermitted) o.push(1, 1, 4, 2);
  if (hasTs) {
    const ts = numField(p, fields, 'timestamp', null);
    const echo = numField(p, fields, 'timestampEcho', 0);
    if (ts < 0 || ts > 0xffffffff) throw new Error(`tcp.timestamp out of range: ${ts}`);
    if (echo < 0 || echo > 0xffffffff) throw new Error(`tcp.timestampEcho out of range: ${echo}`);
    if (!sackPermitted) o.push(1, 1);
    o.push(8, 10, ts >>> 24, (ts >>> 16) & 0xff, (ts >>> 8) & 0xff, ts & 0xff, echo >>> 24, (echo >>> 16) & 0xff, (echo >>> 8) & 0xff, echo & 0xff);
  }
  const wsV = fields.windowScale;
  if (wsV !== undefined && wsV !== null) {
    const ws = numField(p, fields, 'windowScale', null);
    if (ws < 0 || ws > 14) throw new Error(`tcp.windowScale out of range: ${ws}`);
    o.push(1, 3, 3, ws);
  }
  const sackV = fields.sackBlocks;
  if (typeof sackV === 'string' && sackV.trim() !== '') {
    const blocks = parseSackBlocks(sackV);
    if (blocks.length > 0) {
      o.push(1, 1, 5, 2 + blocks.length * 8);
      for (const [l, r] of blocks) {
        o.push(l >>> 24, (l >>> 16) & 0xff, (l >>> 8) & 0xff, l & 0xff, r >>> 24, (r >>> 16) & 0xff, (r >>> 8) & 0xff, r & 0xff);
      }
    }
  }
  while (o.length % 4 !== 0) o.push(0);
  if (TCP_MIN_HEADER + o.length > MAX_HEADER) throw new Error(`tcp options need ${o.length} bytes; at most ${MAX_HEADER - TCP_MIN_HEADER} fit`);
  return o;
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array, ctx?: CodecContext): Uint8Array {
  const p = 'tcp';
  const srcPort = numField(p, fields, 'srcPort', null);
  const dstPort = numField(p, fields, 'dstPort', null);
  const seq = numField(p, fields, 'seq', 0);
  const ack = numField(p, fields, 'ack', 0);
  const window = numField(p, fields, 'window', 65535);
  const urgent = numField(p, fields, 'urgentPointer', 0);
  if (srcPort < 0 || srcPort > 0xffff) throw new Error(`tcp.srcPort out of range: ${srcPort}`);
  if (dstPort < 0 || dstPort > 0xffff) throw new Error(`tcp.dstPort out of range: ${dstPort}`);
  if (seq < 0 || seq > 0xffffffff) throw new Error(`tcp.seq out of range: ${seq}`);
  if (ack < 0 || ack > 0xffffffff) throw new Error(`tcp.ack out of range: ${ack}`);
  if (window < 0 || window > 0xffff) throw new Error(`tcp.window out of range: ${window}`);
  if (urgent < 0 || urgent > 0xffff) throw new Error(`tcp.urgentPointer out of range: ${urgent}`);
  const flagBits = tcpFlagBits(fields.flags);
  const options = encodeOptions(fields);

  const hdrLen = TCP_MIN_HEADER + options.length;
  const len = hdrLen + payload.length;
  const out = new Uint8Array(len);
  writeU16(out, 0, srcPort);
  writeU16(out, 2, dstPort);
  writeU32(out, 4, seq);
  writeU32(out, 8, ack);
  out[12] = (hdrLen / 4) << 4;
  out[13] = flagBits;
  writeU16(out, 14, window);
  writeU16(out, 18, urgent);
  out.set(options, TCP_MIN_HEADER);
  out.set(payload, hdrLen);
  const pseudo = pseudoHeaderSumFor(ctx, IPPROTO_TCP, len);
  if (pseudo !== undefined) writeU16(out, 16, finishChecksum(onesSum(out, 0, len, pseudo)));
  return out;
}

function summarize(fields: Readonly<Record<string, FieldValue>>, ctx?: CodecContext): string {
  const flags = typeof fields.flags === 'string' && fields.flags !== '' ? fields.flags : '.';
  let s = `TCP ${transportEndpoints(fields, ctx)} [${flags}] seq=${String(fields.seq ?? '?')}`;
  if (hasTcpFlag(fields.flags, 'A')) s += ` ack=${String(fields.ack ?? '?')}`;
  if (fields.window !== undefined) s += ` win=${String(fields.window)}`;
  if (fields.mss !== undefined) s += ` mss=${String(fields.mss)}`;
  return s;
}

/** TCP codec. Required on encode: `srcPort`, `dstPort`. */
export const tcpCodec: Codec = {
  proto: 'tcp',
  defaults: Object.freeze({ srcPort: null, dstPort: null, seq: 0, ack: 0, flags: '', window: 65535, urgentPointer: 0 }),
  decode,
  encode,
  summarize,
  derived: DERIVED,
  outerInputs: Object.freeze(['ipv4.src', 'ipv4.dst', 'ipv6.src', 'ipv6.dst']),
};
