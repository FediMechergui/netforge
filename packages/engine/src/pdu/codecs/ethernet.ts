/**
 * Ethernet II codec (spec §4.5 encapsulations, §2.1 "Ethernet & framing").
 *
 * Wire image: `dst(6) src(6) type(2) payload... padding... fcs(4)`.
 *  • The 4-byte FCS is part of `bytes` (contract `pdu.ts` header). It is the
 *    reflected IEEE 802.3 CRC-32 over everything before it, written little-endian.
 *  • Preamble/SFD/IFG are NOT in `bytes`.
 *  • `encode` pads the payload so the frame is at least 64 bytes INCLUDING the FCS.
 *  • Fields: `dst`, `src`, `type` (encode + decode); `fcs`, `fcsValid`, `padding`
 *    (decode-only). A single-layer `decode` cannot know how much of the payload is
 *    padding (only the inner header knows its own length), so it reports
 *    `padding: 0` / `trailerLength: 4`; `decodeLayers` in registry.ts fixes both up
 *    from the inner layer's declared length once it has been decoded.
 *  • `next.length` is an UPPER BOUND (`avail - 14 - 4`, includes padding) per the
 *    contract's inner-codec rule.
 *  • `fixTrailer` (P0.5) performs that padding fix-up; `derived` lists fcs/padding
 *    for provenance; the next protocol comes from the shared `ethertype` dispatch table.
 *  • P1: `ctx.fcsLen === 0` (standalone decode of a capture record without FCS) bounds the payload to the
 *    remaining bytes and leaves `fcs`/`fcsValid` undefined; padding is still reported. Any other value than
 *    the native 4 falls back to 0 (unsupported, as for pcapng imports).
 */
import type { Codec, CodecContext, DecodedLayer, FieldValue, LayerView, MutationReason, ProtoName } from '../../contracts/pdu.js';
import { ETH_FCS, ETH_HEADER, ETH_MIN_FRAME } from '../../contracts/pdu.js';
import { bytesToMac, macToBytes, MAC_BROADCAST, MAC_ZERO } from '../../contracts/addr.js';
import { crc32, numField, readU16, readU32LE, strField, writeU16, writeU32LE } from '../checksum.js';
import { keyForProto, nextProto } from './dispatch.js';

/** Ethertype → protocol layer name (shared `ethertype` dispatch table); anything unknown decodes as raw payload. */
export function protoForEthertype(type: number): ProtoName {
  return nextProto('ethertype', type);
}

/** Ethertype implied by an inner layer name (used by the registry to fill a missing `type`). */
export function ethertypeForProto(proto: ProtoName): number | undefined {
  return keyForProto('ethertype', proto);
}

/**
 * Attribute the slack between the payload bound and the inner layer's declared length to
 * padding: rewrites `padding`, `trailerLength` and the `padding` field range. Idempotent (the FCS
 * length is read from its field range, not from the current trailer).
 */
function fixTrailer(self: LayerView, inner: LayerView | undefined): LayerView {
  if (!inner || self.error !== undefined) return self;
  const fcsRange = self.fieldRanges.fcs;
  const fcsLen = fcsRange ? fcsRange[1] : 0;
  const bound = self.length - self.headerLength - fcsLen;
  const slack = bound - inner.length;
  if (slack <= 0) return self;
  const padStart = inner.offset + inner.length;
  return {
    ...self,
    trailerLength: slack + fcsLen,
    fields: { ...self.fields, padding: slack },
    fieldRanges: { ...self.fieldRanges, padding: [padStart, slack] },
  };
}

const DERIVED: Readonly<Record<string, MutationReason>> = Object.freeze({ fcs: 'FcsRecompute', padding: 'Padding' });

/** `0x0806` */
function hexType(type: number): string {
  return `0x${type.toString(16).padStart(4, '0')}`;
}

function decode(bytes: Uint8Array, offset: number, length: number, ctx?: CodecContext): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};

  if (avail < ETH_HEADER) {
    return { fields, fieldRanges, headerLength: avail, length: avail, error: 'Ethernet header truncated' };
  }
  fields.dst = bytesToMac(bytes, offset);
  fields.src = bytesToMac(bytes, offset + 6);
  fields.type = readU16(bytes, offset + 12);
  fieldRanges.dst = [offset, 6];
  fieldRanges.src = [offset + 6, 6];
  fieldRanges.type = [offset + 12, 2];

  if (ctx?.fcsLen !== undefined && ctx.fcsLen !== ETH_FCS) {
    const end = offset + avail;
    fields.padding = 0; // refined by fixTrailer once the inner length is known
    fieldRanges.padding = [end, 0];
    return {
      fields,
      fieldRanges,
      headerLength: ETH_HEADER,
      length: avail,
      next: { proto: protoForEthertype(fields.type), offset: offset + ETH_HEADER, length: avail - ETH_HEADER },
    };
  }

  if (avail < ETH_HEADER + ETH_FCS) {
    return { fields, fieldRanges, headerLength: ETH_HEADER, length: avail, error: 'Ethernet frame truncated (no FCS)' };
  }

  const fcsOff = offset + avail - ETH_FCS;
  const fcs = readU32LE(bytes, fcsOff);
  fields.fcs = fcs;
  fields.fcsValid = crc32(bytes, offset, avail - ETH_FCS) === fcs;
  fields.padding = 0; // refined by decodeLayers once the inner length is known
  fieldRanges.fcs = [fcsOff, ETH_FCS];
  fieldRanges.padding = [fcsOff, 0];

  return {
    fields,
    fieldRanges,
    headerLength: ETH_HEADER,
    length: avail,
    trailerLength: ETH_FCS,
    next: { proto: protoForEthertype(fields.type), offset: offset + ETH_HEADER, length: avail - ETH_HEADER - ETH_FCS },
  };
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const dst = macToBytes(strField('ethernet', fields, 'dst', MAC_BROADCAST));
  const src = macToBytes(strField('ethernet', fields, 'src', MAC_ZERO));
  const type = numField('ethernet', fields, 'type', null);
  if (type < 0 || type > 0xffff) throw new Error(`ethernet.type out of range: ${type}`);

  const body = ETH_HEADER + payload.length;
  const padLen = Math.max(0, ETH_MIN_FRAME - ETH_FCS - body);
  const total = body + padLen + ETH_FCS;
  const out = new Uint8Array(total); // zero-filled → padding is zeros
  out.set(dst, 0);
  out.set(src, 6);
  writeU16(out, 12, type);
  out.set(payload, ETH_HEADER);
  writeU32LE(out, total - ETH_FCS, crc32(out, 0, total - ETH_FCS));
  return out;
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const type = typeof fields.type === 'number' ? hexType(fields.type) : '?';
  return `Ethernet ${String(fields.src ?? '?')} > ${String(fields.dst ?? '?')} type=${type}`;
}

/** Ethernet II codec. Required field on encode: `type` (the registry fills it from the inner layer when possible). */
export const ethernetCodec: Codec = {
  proto: 'ethernet',
  defaults: Object.freeze({ dst: MAC_BROADCAST, src: MAC_ZERO, type: null }),
  decode,
  encode,
  summarize,
  derived: DERIVED,
  fixTrailer,
};
