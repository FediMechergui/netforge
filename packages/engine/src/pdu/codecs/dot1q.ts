/**
 * IEEE 802.1Q tag codec (ARCHITECTURE-P2 D4, §2.3; contracts/fields.ts `dot1q`).
 *
 * A tagged frame decodes as `[ethernet {type 0x8100}, dot1q {pcp, dei, vid, type}, …]`: the tag is its own layer,
 * pushed and popped by structural rewrap (pdu/vlan.ts, `RewrapOp.as`), never a field of the ethernet layer.
 *
 * Wire image (4 bytes, big-endian): `TCI(2) = pcp(3) | dei(1) | vid(12)`, then `type(2)`.
 *  • `type` follows the `ethernet.type` 802.3 rule exactly: a value up to ETH_LENGTH_MAX is a LENGTH and the next
 *    layer is `llc`, bounded by it (a tagged per-VLAN BPDU is `[ethernet 0x8100, dot1q {type = length}, llc, stp]`);
 *    on encode any value up to 0x05dc (builders pass 0; the registry fills 0 in front of `llc`) is replaced by the
 *    payload length. A larger value is an ethertype dispatched through the shared table.
 *  • `pcp` defaults to 0 (0–7), `dei` to false, `vid` is required (0–4095; 0 = priority tag).
 *  • `transparent`: topProto()/summary() skip the tag (a tagged ARP is described as an ARP).
 *  • `fixTrailer` like llc: the layer covers the tag plus the inner layer's declared length, so the Ethernet padding
 *    after it stays the Ethernet trailer.
 */
import type { Codec, DecodedLayer, FieldValue, LayerView } from '../../contracts/pdu.js';
import { DOT1Q_HEADER } from '../../contracts/pdu.js';
import { numField, readU16, writeU16 } from '../checksum.js';
import { isLengthType } from './dispatch.js';
import { nextForTypeOrLength, typeOrLengthToWrite } from './ethernet.js';

/** Largest VLAN id carried in a tag (4095 is reserved by 802.1Q but encodable). */
export const DOT1Q_VID_MAX = 0x0fff;

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};
  if (avail < DOT1Q_HEADER) {
    return { fields, fieldRanges, headerLength: avail, length: avail, error: '802.1Q tag truncated' };
  }
  const tci = readU16(bytes, offset);
  fields.pcp = tci >>> 13;
  fields.dei = (tci & 0x1000) !== 0;
  fields.vid = tci & DOT1Q_VID_MAX;
  fields.type = readU16(bytes, offset + 2);
  fieldRanges.pcp = [offset, 1];
  fieldRanges.dei = [offset, 1];
  fieldRanges.vid = [offset, 2];
  fieldRanges.type = [offset + 2, 2];
  return {
    fields,
    fieldRanges,
    headerLength: DOT1Q_HEADER,
    length: avail,
    next: nextForTypeOrLength(fields.type, offset + DOT1Q_HEADER, avail - DOT1Q_HEADER),
  };
}

function boolField(fields: Readonly<Record<string, FieldValue>>, key: string): boolean {
  const v = fields[key];
  if (v === undefined || v === null) return false;
  if (typeof v === 'boolean') return v;
  if (v === 0 || v === 1) return v === 1;
  throw new Error(`dot1q.${key} must be a boolean`);
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'dot1q';
  const pcp = numField(p, fields, 'pcp', 0);
  const vid = numField(p, fields, 'vid', null);
  if (pcp < 0 || pcp > 7) throw new Error(`dot1q.pcp out of range: ${pcp}`);
  if (vid < 0 || vid > DOT1Q_VID_MAX) throw new Error(`dot1q.vid out of range: ${vid}`);
  const type = typeOrLengthToWrite(p, numField(p, fields, 'type', null), payload.length);
  const out = new Uint8Array(DOT1Q_HEADER + payload.length);
  writeU16(out, 0, (pcp << 13) | (boolField(fields, 'dei') ? 0x1000 : 0) | vid);
  writeU16(out, 2, type);
  out.set(payload, DOT1Q_HEADER);
  return out;
}

/** Shrink the layer to tag + inner layer (idempotent); bytes past the inner layer belong to the Ethernet trailer. */
function fixTrailer(self: LayerView, inner: LayerView | undefined): LayerView {
  if (!inner || self.error !== undefined) return self;
  const exact = self.headerLength + inner.length;
  return exact < self.length ? { ...self, length: exact } : self;
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const vid = String(fields.vid ?? '?');
  const pcp = typeof fields.pcp === 'number' && fields.pcp !== 0 ? ` priority ${fields.pcp}` : '';
  const t = fields.type;
  const tail = typeof t === 'number' ? (isLengthType(t) ? ` length=${t}` : ` type=0x${t.toString(16).padStart(4, '0')}`) : '';
  return `802.1Q VLAN ${vid}${pcp}${tail}`;
}

/** 802.1Q tag codec. Required on encode: `vid`, `type` (the registry fills `type` from the inner layer). */
export const dot1qCodec: Codec = {
  proto: 'dot1q',
  defaults: Object.freeze({ pcp: 0, dei: false, vid: null, type: null }),
  decode,
  encode,
  summarize,
  transparent: true,
  fixTrailer,
};
