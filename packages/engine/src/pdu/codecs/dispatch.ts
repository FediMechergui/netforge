/**
 * Next-protocol dispatch tables (spec §4.5 decode chain; contracts/pdu.ts `DispatchSpace`).
 *
 * Built once, at module load, from `DISPATCH_TABLE` in contracts/fields.ts. The tables replace the
 * per-codec switch statements, so one number space serves every field that shares it:
 *  • `ethertype` — ethernet.type, llc.type, hdlc.protocol
 *  • `ipproto`   — ipv4.protocol, ipv6.nextHeader, IPv6 extension nextHeader
 *  • `udp.port` / `tcp.port` — destination port first, then source port, only when the transport
 *    payload is at least 1 byte (`lookupPortNext`)
 *
 * Rules:
 *  • Forward lookup (`lookupNext`) returns the FIRST non-reserved entry for (space, key). Reserved
 *    entries (D1: names and ports only) are never returned, so those payloads decode as `payload`.
 *  • Reverse lookup (`keyForProto`) returns the FIRST non-reserved key for (space, proto) in table
 *    order (dhcp → 67, http → 80).
 *  • A returned protocol name may have no registered codec yet (e.g. `ipv6` before P1); the registry's
 *    chain walk decodes unknown names as `payload`, so observable P0 decodes are unchanged.
 *  • `LINK_FIELDS` names, per layer protocol, the field that selects the next layer and its space.
 *    The registry uses it to fill that field from the inner layer's name when a builder omits it.
 *
 * P2 (ARCHITECTURE-P2 §2.3):
 *  • New spaces `llc.sap` (the DSAP of a non-SNAP LLC header) and `nf.pid` (llc.type when llc.oui is NF_OUI).
 *  • `dot1q.type` selects in the `ethertype` space like `ethernet.type`.
 *  • The 802.3 rule (`lengthFramed`): ethernet.type and dot1q.type values up to ETH_LENGTH_MAX are a LENGTH and
 *    the next layer is `llc`; `linkFieldFill` fills 0 when the next proto is `llc` (the codec writes the length).
 *  • `linkFieldOf(proto, fields)` is the field-aware selector: an llc header selects on `type` in `nf.pid` when its
 *    oui is NF_OUI, in `ethertype` otherwise, and on nothing a builder may fill when it is not SNAP (its DSAP is
 *    explicit). `linkFieldFill` also completes an EMPTY llc spec for a next proto that only the `llc.sap` space
 *    (DSAP = SSAP = key) or the `nf.pid` space (oui NF_OUI, type = key) names.
 *
 * Pure data; iteration order is table order (deterministic).
 */
import type { DispatchSpace, FieldValue, ProtoName } from '../../contracts/pdu.js';
import { ETH_LENGTH_MAX, NF_OUI } from '../../contracts/pdu.js';
import { DISPATCH_TABLE } from '../../contracts/fields.js';

/** A layer field that selects the next protocol, and the number space it is looked up in. */
export interface LinkField {
  /** Bare field name on the layer (e.g. `type`, `protocol`, `nextHeader`). */
  readonly field: string;
  readonly space: DispatchSpace;
  /**
   * @since P2 The 802.3 rule: a value up to ETH_LENGTH_MAX is a length and the next layer is `llc` (ethernet.type,
   * dot1q.type). A builder passes 0 and the codec writes the LLC payload length.
   */
  readonly lengthFramed?: true;
}

/** Next-layer selector field per protocol (the fields `fillLinkField` may fill). */
export const LINK_FIELDS: Readonly<Record<string, LinkField>> = Object.freeze({
  ethernet: Object.freeze({ field: 'type', space: 'ethertype', lengthFramed: true as const }),
  llc: Object.freeze({ field: 'type', space: 'ethertype' }),
  dot1q: Object.freeze({ field: 'type', space: 'ethertype', lengthFramed: true as const }),
  hdlc: Object.freeze({ field: 'protocol', space: 'ethertype' }),
  ipv4: Object.freeze({ field: 'protocol', space: 'ipproto' }),
  ipv6: Object.freeze({ field: 'nextHeader', space: 'ipproto' }),
  'ipv6-hopopts': Object.freeze({ field: 'nextHeader', space: 'ipproto' }),
  'ipv6-route': Object.freeze({ field: 'nextHeader', space: 'ipproto' }),
  'ipv6-frag': Object.freeze({ field: 'nextHeader', space: 'ipproto' }),
  'ipv6-dstopts': Object.freeze({ field: 'nextHeader', space: 'ipproto' }),
});

const FORWARD = new Map<DispatchSpace, Map<number, ProtoName>>();
const REVERSE = new Map<DispatchSpace, Map<ProtoName, number>>();

for (const e of DISPATCH_TABLE) {
  if (e.reserved) continue;
  let fwd = FORWARD.get(e.space);
  if (!fwd) {
    fwd = new Map<number, ProtoName>();
    FORWARD.set(e.space, fwd);
  }
  if (!fwd.has(e.key)) fwd.set(e.key, e.proto);
  let rev = REVERSE.get(e.space);
  if (!rev) {
    rev = new Map<ProtoName, number>();
    REVERSE.set(e.space, rev);
  }
  if (!rev.has(e.proto)) rev.set(e.proto, e.key);
}

/** Protocol dispatched by `key` in `space`, or undefined when the key is unknown or reserved. */
export function lookupNext(space: DispatchSpace, key: number): ProtoName | undefined {
  return FORWARD.get(space)?.get(key);
}

/** Like `lookupNext`, but returns `fallback` (default `payload`) when nothing is dispatched. */
export function nextProto(space: DispatchSpace, key: number, fallback: ProtoName = 'payload'): ProtoName {
  return FORWARD.get(space)?.get(key) ?? fallback;
}

/** Dispatch key implied by an inner protocol name in `space` (reverse lookup), or undefined. */
export function keyForProto(space: DispatchSpace, proto: ProtoName): number | undefined {
  return REVERSE.get(space)?.get(proto);
}

/**
 * Port-based dispatch for `udp.port` / `tcp.port`: the destination port wins, then the source port.
 * Returns undefined when the transport payload is empty or neither port is known.
 */
export function lookupPortNext(
  space: DispatchSpace,
  dstPort: number,
  srcPort: number,
  payloadLength: number,
): ProtoName | undefined {
  if (payloadLength < 1) return undefined;
  return lookupNext(space, dstPort) ?? lookupNext(space, srcPort);
}

/** The next-layer selector field of `proto`, or undefined when the layer does not select one by number. */
export function linkFieldFor(proto: ProtoName): LinkField | undefined {
  return Object.prototype.hasOwnProperty.call(LINK_FIELDS, proto) ? LINK_FIELDS[proto] : undefined;
}

/** SNAP DSAP/SSAP value (an LLC header with dsap = ssap = 0xaa carries an OUI and a type). */
const SNAP_SAP = 0xaa;
const NF_PID_SELECTOR: LinkField = Object.freeze({ field: 'type', space: 'nf.pid' });

function isAbsent(v: FieldValue | undefined): boolean {
  return v === undefined || v === null;
}

/** @since P2 True when an llc spec or decoded layer is SNAP (DSAP and SSAP 0xaa; an absent value takes the 0xaa default). */
export function isSnapLlc(fields: Readonly<Record<string, FieldValue>>): boolean {
  const dsap = fields.dsap;
  const ssap = fields.ssap;
  return (isAbsent(dsap) || dsap === SNAP_SAP) && (isAbsent(ssap) || ssap === SNAP_SAP);
}

/** @since P2 True for a value up to ETH_LENGTH_MAX: an 802.3 LENGTH rather than an ethertype (ethernet.type, dot1q.type). */
export function isLengthType(type: number): boolean {
  return type >= 0 && type <= ETH_LENGTH_MAX;
}

/**
 * @since P2 The next-layer selector of a layer given its fields: `linkFieldFor`, except for llc, which selects on
 * `type` in `nf.pid` when its oui is NF_OUI, in `ethertype` otherwise, and on nothing a builder may fill when it is
 * not SNAP (the DSAP is the selector and is always explicit).
 */
export function linkFieldOf(proto: ProtoName, fields: Readonly<Record<string, FieldValue>>): LinkField | undefined {
  if (proto === 'llc') {
    if (!isSnapLlc(fields)) return undefined;
    return fields.oui === NF_OUI ? NF_PID_SELECTOR : LINK_FIELDS.llc;
  }
  return linkFieldFor(proto);
}

/**
 * @since P2 The fields to add to a `proto` spec whose next layer is `innerProto` (used by the registry's
 * `fillLinkField`), or undefined when nothing is filled. An explicit selector value is never replaced. In order:
 *  • an llc spec with no dsap, ssap, oui or type whose inner proto has no ethertype: the `llc.sap` key → dsap = ssap
 *    = key (a non-SNAP header), else the `nf.pid` key → oui NF_OUI and type = key;
 *  • ethernet / dot1q with inner `llc` → `type: 0` (802.3 length framing; the codec writes the length);
 *  • otherwise the table-driven key of `linkFieldOf`.
 */
export function linkFieldFill(
  proto: ProtoName,
  fields: Readonly<Record<string, FieldValue>>,
  innerProto: ProtoName,
): Record<string, FieldValue> | undefined {
  if (proto === 'llc' && isAbsent(fields.dsap) && isAbsent(fields.ssap) && isAbsent(fields.oui) && isAbsent(fields.type)
    && keyForProto('ethertype', innerProto) === undefined) {
    const sap = keyForProto('llc.sap', innerProto);
    if (sap !== undefined) return { dsap: sap, ssap: sap };
    const pid = keyForProto('nf.pid', innerProto);
    if (pid !== undefined) return { oui: NF_OUI, type: pid };
    return undefined;
  }
  const lf = linkFieldOf(proto, fields);
  if (!lf || !isAbsent(fields[lf.field])) return undefined;
  if (lf.lengthFramed === true && innerProto === 'llc') return { [lf.field]: 0 };
  const key = keyForProto(lf.space, innerProto);
  return key === undefined ? undefined : { [lf.field]: key };
}
