/**
 * protocols/l2/lag-hash.ts — the EtherChannel load-balance hash (ARCHITECTURE-P2 D10, §3.7 step 5, §4.1, §4.5).
 *
 * `etherchannel.onEgress(pdu, 'Port-channelN')` picks ONE bundled member: `i = hash(method, frame) mod n` over the
 * bundled members in canonical port order (the caller passes them in that order), then sends there.
 *
 * NetForge port MACs are `02:b3:b2:b1:b0:<ordinal>` (contracts/addr.ts `portMac`), so the last octet is the port
 * ordinal — every single-NIC PC ends in `:01` — and must not be the only hash input. The MAC fold XORs the five
 * octets that vary per device, every octet except the fixed 0x02 prefix: `fold(mac) = o1 ^ o2 ^ o3 ^ o4 ^ o5`.
 *
 *   src-mac      fold(src)                  (default; `port-channel load-balance` changes it)
 *   dst-mac      fold(dst)
 *   src-dst-mac  fold(src) ^ fold(dst)
 *   src-ip       o0 ^ o1 ^ o2 ^ o3 of the IPv4 source       (non-IPv4 frame → src-mac)
 *   dst-ip       the same of the IPv4 destination           (non-IPv4 frame → dst-mac)
 *   src-dst-ip   XOR of the two                             (non-IPv4 frame → src-dst-mac)
 *
 * Integer only, no randomness (§4.1: a fixed integer function). Pure: no state, no I/O, no clock.
 */
import { normalizeMac, parseIpv4 } from '../../contracts/addr.js';
import type { Ipv4Address, MacAddress } from '../../contracts/addr.js';
import type { ConfigAst } from '../../contracts/config.js';
import type { PortId } from '../../contracts/ids.js';
import type { PduView } from '../../contracts/pdu.js';

/** `port-channel load-balance` methods (§5.1). */
export type LoadBalanceMethod = 'src-mac' | 'dst-mac' | 'src-dst-mac' | 'src-ip' | 'dst-ip' | 'src-dst-ip';
/** Every method, in §5.1 order. */
export const LOAD_BALANCE_METHODS: readonly LoadBalanceMethod[] = Object.freeze([
  'src-mac', 'dst-mac', 'src-dst-mac', 'src-ip', 'dst-ip', 'src-dst-ip',
]);
/** Default method. */
export const DEFAULT_LOAD_BALANCE: LoadBalanceMethod = 'src-mac';

/** The addresses the hash reads from a frame. */
export interface LagFrameKeys {
  readonly srcMac: MacAddress;
  readonly dstMac: MacAddress;
  /** IPv4 source and destination, present only for an IPv4 packet. */
  readonly srcIp?: Ipv4Address;
  readonly dstIp?: Ipv4Address;
}

/** XOR of octets 1–5 of a MAC (the fixed first octet excluded). An unparsable MAC folds to 0. */
export function macFold(mac: MacAddress): number {
  const n = normalizeMac(mac);
  if (n === null) return 0;
  const o = n.split(':').map((h) => parseInt(h, 16));
  return ((o[1] ?? 0) ^ (o[2] ?? 0) ^ (o[3] ?? 0) ^ (o[4] ?? 0) ^ (o[5] ?? 0)) & 0xff;
}

/** XOR of the four octets of an IPv4 address. An unparsable address folds to 0. */
export function ipv4Fold(addr: Ipv4Address): number {
  const v = parseIpv4(addr);
  if (v === null) return 0;
  return ((v >>> 24) ^ (v >>> 16) ^ (v >>> 8) ^ v) & 0xff;
}

/** The hash of `keys` under `method` (0–255). IP methods fall back to their MAC variant for a non-IPv4 frame. */
export function lagHash(method: LoadBalanceMethod, keys: LagFrameKeys): number {
  const ip = keys.srcIp !== undefined && keys.dstIp !== undefined;
  switch (method) {
    case 'src-mac':
      return macFold(keys.srcMac);
    case 'dst-mac':
      return macFold(keys.dstMac);
    case 'src-dst-mac':
      return macFold(keys.srcMac) ^ macFold(keys.dstMac);
    case 'src-ip':
      return ip ? ipv4Fold(keys.srcIp as Ipv4Address) : macFold(keys.srcMac);
    case 'dst-ip':
      return ip ? ipv4Fold(keys.dstIp as Ipv4Address) : macFold(keys.dstMac);
    case 'src-dst-ip':
      return ip ? ipv4Fold(keys.srcIp as Ipv4Address) ^ ipv4Fold(keys.dstIp as Ipv4Address) : macFold(keys.srcMac) ^ macFold(keys.dstMac);
  }
}

/** The hash inputs of a frame: outer Ethernet addresses, plus the first IPv4 header's addresses when there is one. */
export function lagFrameKeys(frame: Pick<PduView, 'layers'>): LagFrameKeys {
  let srcMac = '';
  let dstMac = '';
  let srcIp: string | undefined;
  let dstIp: string | undefined;
  for (const l of frame.layers) {
    if (l.proto === 'ethernet' && srcMac === '' && dstMac === '') {
      srcMac = String(l.fields.src ?? '');
      dstMac = String(l.fields.dst ?? '');
    } else if (l.proto === 'ipv4') {
      const s = l.fields.src;
      const d = l.fields.dst;
      if (typeof s === 'string' && typeof d === 'string') {
        srcIp = s;
        dstIp = d;
      }
      break;
    }
  }
  return srcIp === undefined || dstIp === undefined ? { srcMac, dstMac } : { srcMac, dstMac, srcIp, dstIp };
}

/** Index of the member for `keys` among `n` bundled members (`hash mod n`), or undefined when `n` is 0. */
export function lagMemberIndex(method: LoadBalanceMethod, keys: LagFrameKeys, n: number): number | undefined {
  if (n <= 0) return undefined;
  return lagHash(method, keys) % n;
}

/**
 * The member a frame leaves on: `members[hash mod n]`, with `members` the bundled members in canonical port order.
 * Undefined when no member is bundled (drop `other`, `noActiveMemberDetail(bundle)`).
 */
export function pickLagMember(method: LoadBalanceMethod, frame: Pick<PduView, 'layers'>, members: readonly PortId[]): PortId | undefined {
  const i = lagMemberIndex(method, lagFrameKeys(frame), members.length);
  return i === undefined ? undefined : members[i];
}

/** Drop detail of a send on a bundle with no bundled member: `<bundle> has no active member`. */
export function noActiveMemberDetail(bundle: PortId): string {
  return `${bundle} has no active member`;
}

/** The global `port-channel load-balance <method>` of `config`, else the default (src-mac). */
export function readLoadBalance(config: ConfigAst): LoadBalanceMethod {
  let method = DEFAULT_LOAD_BALANCE;
  for (const c of config.root.children) {
    if (c.key !== 'port-channel' || c.args[0] !== 'load-balance' || c.args.length !== 2) continue;
    const m = c.args[1] as LoadBalanceMethod;
    if (LOAD_BALANCE_METHODS.includes(m)) method = m;
  }
  return method;
}
