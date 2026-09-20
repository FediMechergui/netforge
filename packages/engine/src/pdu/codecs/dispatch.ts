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
 * Pure data; iteration order is table order (deterministic).
 */
import type { DispatchSpace, ProtoName } from '../../contracts/pdu.js';
import { DISPATCH_TABLE } from '../../contracts/fields.js';

/** A layer field that selects the next protocol, and the number space it is looked up in. */
export interface LinkField {
  /** Bare field name on the layer (e.g. `type`, `protocol`, `nextHeader`). */
  readonly field: string;
  readonly space: DispatchSpace;
}

/** Next-layer selector field per protocol (the fields `fillLinkField` may fill). */
export const LINK_FIELDS: Readonly<Record<string, LinkField>> = Object.freeze({
  ethernet: Object.freeze({ field: 'type', space: 'ethertype' }),
  llc: Object.freeze({ field: 'type', space: 'ethertype' }),
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
