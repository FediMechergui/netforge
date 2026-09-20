/**
 * IEEE 802.2 LLC + SNAP codec (contracts/fields.ts `llc`), the glue between an 802.11 data header and
 * its payload (EAPOL, and IPv4/ARP on the air before the medium rewraps to Ethernet).
 *
 * Wire image (8 bytes, big-endian): `dsap(1)=0xaa ssap(1)=0xaa control(1)=0x03 oui(3)=0 type(2)`
 *  • `type` shares the ethertype number space and selects the next layer through the dispatch table.
 *  • A header that is not SNAP (dsap/ssap ≠ 0xaa or control ≠ 0x03) decodes with an error and no next layer.
 *  • `transparent`: topProto()/summary() skip this layer (a dot11 data frame is described by what it carries).
 *  • LLC has no trailer. `fixTrailer` sets the layer length to header + the inner layer's declared length,
 *    so bytes after the inner layer are attributed to the enclosing 802.11 trailer, never to LLC.
 */
import type { Codec, DecodedLayer, FieldValue, LayerView } from '../../contracts/pdu.js';
import { LLC_SNAP_HEADER } from '../../contracts/pdu.js';
import { numField, readU16, writeU16 } from '../checksum.js';
import { nextProto } from './dispatch.js';

const SNAP_SAP = 0xaa;
const UI_CONTROL = 0x03;

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};

  if (avail < LLC_SNAP_HEADER) {
    return { fields, fieldRanges, headerLength: avail, length: avail, error: 'LLC/SNAP header truncated' };
  }
  fields.dsap = bytes[offset]!;
  fields.ssap = bytes[offset + 1]!;
  fields.control = bytes[offset + 2]!;
  fields.oui = (bytes[offset + 3]! << 16) | (bytes[offset + 4]! << 8) | bytes[offset + 5]!;
  fields.type = readU16(bytes, offset + 6);
  fieldRanges.dsap = [offset, 1];
  fieldRanges.ssap = [offset + 1, 1];
  fieldRanges.control = [offset + 2, 1];
  fieldRanges.oui = [offset + 3, 3];
  fieldRanges.type = [offset + 6, 2];

  if (fields.dsap !== SNAP_SAP || fields.ssap !== SNAP_SAP || fields.control !== UI_CONTROL) {
    return { fields, fieldRanges, headerLength: LLC_SNAP_HEADER, length: avail, error: 'not an LLC/SNAP header' };
  }
  return {
    fields,
    fieldRanges,
    headerLength: LLC_SNAP_HEADER,
    length: avail,
    next: { proto: nextProto('ethertype', fields.type), offset: offset + LLC_SNAP_HEADER, length: avail - LLC_SNAP_HEADER },
  };
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'llc';
  const dsap = numField(p, fields, 'dsap', SNAP_SAP);
  const ssap = numField(p, fields, 'ssap', SNAP_SAP);
  const control = numField(p, fields, 'control', UI_CONTROL);
  const oui = numField(p, fields, 'oui', 0);
  const type = numField(p, fields, 'type', null);
  if (dsap < 0 || dsap > 0xff) throw new Error(`llc.dsap out of range: ${dsap}`);
  if (ssap < 0 || ssap > 0xff) throw new Error(`llc.ssap out of range: ${ssap}`);
  if (control < 0 || control > 0xff) throw new Error(`llc.control out of range: ${control}`);
  if (oui < 0 || oui > 0xffffff) throw new Error(`llc.oui out of range: ${oui}`);
  if (type < 0 || type > 0xffff) throw new Error(`llc.type out of range: ${type}`);

  const out = new Uint8Array(LLC_SNAP_HEADER + payload.length);
  out[0] = dsap;
  out[1] = ssap;
  out[2] = control;
  out[3] = (oui >>> 16) & 0xff;
  out[4] = (oui >>> 8) & 0xff;
  out[5] = oui & 0xff;
  writeU16(out, 6, type);
  out.set(payload, LLC_SNAP_HEADER);
  return out;
}

/** Shrink the layer to header + inner layer (idempotent); bytes past the inner layer belong to the outer frame. */
function fixTrailer(self: LayerView, inner: LayerView | undefined): LayerView {
  if (!inner || self.error !== undefined) return self;
  const exact = self.headerLength + inner.length;
  return exact < self.length ? { ...self, length: exact } : self;
}

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  const type = typeof fields.type === 'number' ? `0x${fields.type.toString(16).padStart(4, '0')}` : '?';
  return `LLC/SNAP type=${type}`;
}

/** LLC/SNAP codec. Required on encode: `type` (the registry fills it from the inner layer when possible). */
export const llcCodec: Codec = {
  proto: 'llc',
  defaults: Object.freeze({ dsap: SNAP_SAP, ssap: SNAP_SAP, control: UI_CONTROL, oui: 0, type: null }),
  decode,
  encode,
  summarize,
  transparent: true,
  fixTrailer,
};
