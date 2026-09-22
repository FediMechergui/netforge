/**
 * IEEE 802.2 LLC codec, with and without SNAP (contracts/fields.ts `llc`): the glue between an 802.11 data header and
 * its payload (EAPOL, and IPv4/ARP on the air before the medium rewraps to Ethernet), and (P2) the header after an
 * 802.3 length (spanning-tree BPDUs, the NF control protocols).
 *
 * SNAP wire image (8 bytes, big-endian): `dsap(1)=0xaa ssap(1)=0xaa control(1)=0x03 oui(3) type(2)`
 *  • `type` selects the next layer: in the `ethertype` space when `oui` is 0 (and, as in P1, any OUI other than
 *    NF_OUI), in the `nf.pid` space when `oui` is NF_OUI (P2: DTP, VTP, PAgP in their NF formats, D8).
 *  • A SNAP header whose control is not 0x03 decodes with an error and no next layer. The SNAP encode and decode
 *    paths are byte-identical to P1.
 * Non-SNAP wire image (P2, 3 bytes): `dsap(1) ssap(1) control(1)` — any header whose DSAP or SSAP is not 0xaa.
 *  • It has no `oui`/`type`; the next layer is selected by `dsap` in the `llc.sap` space (0x42 → stp). An
 *    unregistered SAP has no next layer (the rest of the bound belongs to this layer).
 *  • Encode refuses `oui`/`type` on a non-SNAP header.
 *  • `transparent`: topProto()/summary() skip this layer (a frame is described by what it carries).
 *  • LLC has no trailer. `fixTrailer` sets the layer length to header + the inner layer's declared length,
 *    so bytes after the inner layer are attributed to the enclosing frame's trailer (802.11 FCS, Ethernet padding),
 *    never to LLC.
 */
import type { Codec, DecodedLayer, FieldValue, LayerView } from '../../contracts/pdu.js';
import { LLC_SNAP_HEADER, NF_OUI } from '../../contracts/pdu.js';
import { numField, readU16, writeU16 } from '../checksum.js';
import { isSnapLlc, lookupNext, nextProto } from './dispatch.js';

const SNAP_SAP = 0xaa;
const UI_CONTROL = 0x03;
/** @since P2 Length of an LLC header without SNAP (DSAP, SSAP, one control byte). */
export const LLC_HEADER = 3;

function decode(bytes: Uint8Array, offset: number, length: number): DecodedLayer {
  const avail = Math.max(0, Math.min(length, bytes.length - offset));
  const fields: Record<string, FieldValue> = {};
  const fieldRanges: Record<string, readonly [number, number]> = {};

  const snap = avail < 2 || (bytes[offset] === SNAP_SAP && bytes[offset + 1] === SNAP_SAP);
  if (!snap) {
    if (avail < LLC_HEADER) return { fields, fieldRanges, headerLength: avail, length: avail, error: 'LLC header truncated' };
    return decodeNonSnap(bytes, offset, avail, fields, fieldRanges);
  }

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

  if (fields.control !== UI_CONTROL) {
    return { fields, fieldRanges, headerLength: LLC_SNAP_HEADER, length: avail, error: 'not an LLC/SNAP header' };
  }
  const space = fields.oui === NF_OUI ? 'nf.pid' : 'ethertype';
  return {
    fields,
    fieldRanges,
    headerLength: LLC_SNAP_HEADER,
    length: avail,
    next: { proto: nextProto(space, fields.type), offset: offset + LLC_SNAP_HEADER, length: avail - LLC_SNAP_HEADER },
  };
}

/** P2: a header without SNAP; the DSAP selects the next layer in the `llc.sap` space. */
function decodeNonSnap(
  bytes: Uint8Array,
  offset: number,
  avail: number,
  fields: Record<string, FieldValue>,
  fieldRanges: Record<string, readonly [number, number]>,
): DecodedLayer {
  fields.dsap = bytes[offset]!;
  fields.ssap = bytes[offset + 1]!;
  fields.control = bytes[offset + 2]!;
  fieldRanges.dsap = [offset, 1];
  fieldRanges.ssap = [offset + 1, 1];
  fieldRanges.control = [offset + 2, 1];
  const out: DecodedLayer = { fields, fieldRanges, headerLength: LLC_HEADER, length: avail };
  const next = lookupNext('llc.sap', fields.dsap);
  if (next !== undefined && avail > LLC_HEADER) out.next = { proto: next, offset: offset + LLC_HEADER, length: avail - LLC_HEADER };
  return out;
}

function encode(fields: Record<string, FieldValue>, payload: Uint8Array): Uint8Array {
  const p = 'llc';
  const dsap = numField(p, fields, 'dsap', SNAP_SAP);
  const ssap = numField(p, fields, 'ssap', SNAP_SAP);
  const control = numField(p, fields, 'control', UI_CONTROL);
  if (dsap < 0 || dsap > 0xff) throw new Error(`llc.dsap out of range: ${dsap}`);
  if (ssap < 0 || ssap > 0xff) throw new Error(`llc.ssap out of range: ${ssap}`);
  if (control < 0 || control > 0xff) throw new Error(`llc.control out of range: ${control}`);
  if (!isSnapLlc({ dsap, ssap })) {
    const given = (k: string): boolean => fields[k] !== undefined && fields[k] !== null;
    if (given('oui') || given('type')) throw new Error('llc.oui and llc.type exist only on a SNAP header (dsap = ssap = 0xaa)');
    const out = new Uint8Array(LLC_HEADER + payload.length);
    out[0] = dsap;
    out[1] = ssap;
    out[2] = control;
    out.set(payload, LLC_HEADER);
    return out;
  }
  const oui = numField(p, fields, 'oui', 0);
  const type = numField(p, fields, 'type', null);
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

const hex = (n: number, digits: number): string => `0x${n.toString(16).padStart(digits, '0')}`;

function summarize(fields: Readonly<Record<string, FieldValue>>): string {
  if (typeof fields.dsap === 'number' && !isSnapLlc(fields)) {
    return `LLC dsap=${hex(fields.dsap, 2)} ssap=${hex(typeof fields.ssap === 'number' ? fields.ssap : 0, 2)}`;
  }
  const type = typeof fields.type === 'number' ? hex(fields.type, 4) : '?';
  if (fields.oui === NF_OUI) return `LLC/SNAP NF protocol ${type}`;
  return `LLC/SNAP type=${type}`;
}

/** LLC codec. Required on a SNAP encode: `type` (the registry fills it from the inner layer when possible). */
export const llcCodec: Codec = {
  proto: 'llc',
  defaults: Object.freeze({ dsap: SNAP_SAP, ssap: SNAP_SAP, control: UI_CONTROL, oui: 0, type: null }),
  decode,
  encode,
  summarize,
  transparent: true,
  fixTrailer,
};
