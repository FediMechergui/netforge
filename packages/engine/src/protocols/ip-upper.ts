/**
 * protocols/ip-upper.ts — the static IP upper-layer table (ARCHITECTURE-P1 §2 "Demux", §4.2).
 *
 * Wire frames reach ipv4/ipv6 through demux selectors; everything above IP is reached through THIS table instead:
 * the IP daemon looks up the protocol number (IPv4 `protocol`, IPv6 `nextHeader` of the last header) and hands the
 * packet to the named daemon with a `deliver` action, provided the device actually runs that daemon
 * (`model.processes`). ICMP errors are fanned back the same way, keyed by the protocol of the QUOTED datagram
 * (quoted 17 → udp, quoted 6 → tcp), so the transport daemons can report `sock.error` to their sockets.
 *
 * IPv4 (RFC 791 / RFC 790 numbers):   1 → icmpv4, 6 → tcp, 17 → udp.
 * IPv6 (RFC 8200, RFC 4443, RFC 4861): 58 with type 133–137 → nd, other 58 → icmpv6, 6 → tcp, 17 → udp.
 *
 * Anything without a target is the caller's `unsupported-protocol` case: ICMP protocol unreachable (3/2) for IPv4,
 * parameter problem (4/1, pointer 6) for IPv6, never for broadcast or multicast destinations.
 *
 * Pure data and lookups: no state, no rng, no time.
 */
import type { DeviceModel } from '../contracts/device.js';
import type { ProcessName } from '../contracts/ids.js';
import { IPPROTO_ICMP, IPPROTO_ICMPV6, IPPROTO_TCP, IPPROTO_UDP } from '../contracts/pdu.js';

/** One row of the upper-layer table. */
export interface IpUpperEntry {
  /** IP protocol number (IPv4 `protocol`, IPv6 `nextHeader`). */
  readonly protocol: number;
  /** Daemon that consumes packets of this protocol. */
  readonly process: ProcessName;
  /** Short protocol label used in debug lines and drop details. */
  readonly label: string;
}

/** IPv4 upper-layer table, in protocol-number order. */
export const IPV4_UPPER: readonly IpUpperEntry[] = Object.freeze([
  Object.freeze({ protocol: IPPROTO_ICMP, process: 'icmpv4', label: 'icmp' }),
  Object.freeze({ protocol: IPPROTO_TCP, process: 'tcp', label: 'tcp' }),
  Object.freeze({ protocol: IPPROTO_UDP, process: 'udp', label: 'udp' }),
]);

/** IPv6 upper-layer table, in protocol-number order (ICMPv6 neighbour discovery types are split off to `nd`). */
export const IPV6_UPPER: readonly IpUpperEntry[] = Object.freeze([
  Object.freeze({ protocol: IPPROTO_TCP, process: 'tcp', label: 'tcp' }),
  Object.freeze({ protocol: IPPROTO_UDP, process: 'udp', label: 'udp' }),
  Object.freeze({ protocol: IPPROTO_ICMPV6, process: 'icmpv6', label: 'icmpv6' }),
]);

/** First ICMPv6 type handled by `nd` (router solicitation, RFC 4861 §4.1). */
export const ND_TYPE_MIN = 133;
/** Last ICMPv6 type handled by `nd` (redirect, RFC 4861 §4.5). */
export const ND_TYPE_MAX = 137;

/** True when the device model runs `process` (a daemon absent from the model never receives deliveries). */
export function runsProcess(model: Pick<DeviceModel, 'processes'>, process: ProcessName): boolean {
  return model.processes.includes(process);
}

/** The IPv4 table row for `protocol`, whether or not the device runs the daemon. */
export function ipv4UpperEntry(protocol: number): IpUpperEntry | undefined {
  for (const e of IPV4_UPPER) if (e.protocol === protocol) return e;
  return undefined;
}

/**
 * Daemon that receives an IPv4 packet of `protocol` addressed to this device, or undefined when the protocol is
 * unknown or the device does not run its daemon (→ `unsupported-protocol` + ICMP 3/2).
 */
export function ipv4UpperProcess(model: Pick<DeviceModel, 'processes'>, protocol: number): ProcessName | undefined {
  const e = ipv4UpperEntry(protocol);
  return e !== undefined && runsProcess(model, e.process) ? e.process : undefined;
}

/**
 * Daemon that receives an IPv6 packet whose last header is `nextHeader` (with `icmpType` for ICMPv6), or undefined
 * when there is none on this device. ICMPv6 types 133–137 go to `nd`, every other ICMPv6 type to `icmpv6`.
 */
export function ipv6UpperProcess(model: Pick<DeviceModel, 'processes'>, nextHeader: number, icmpType?: number): ProcessName | undefined {
  let process: ProcessName | undefined;
  if (nextHeader === IPPROTO_ICMPV6) {
    process = icmpType !== undefined && icmpType >= ND_TYPE_MIN && icmpType <= ND_TYPE_MAX ? 'nd' : 'icmpv6';
  } else {
    for (const e of IPV6_UPPER) if (e.protocol === nextHeader) process = e.process;
  }
  return process !== undefined && runsProcess(model, process) ? process : undefined;
}

/**
 * Transport daemon that owns the datagram quoted inside an ICMP error (quoted protocol 17 → udp, 6 → tcp), or
 * undefined for any other quoted protocol or when the device does not run that daemon. Quoted ICMP is handled by
 * the ICMP daemon itself (ping jobs and probes).
 */
export function icmpErrorTarget(model: Pick<DeviceModel, 'processes'>, quotedProtocol: number): ProcessName | undefined {
  if (quotedProtocol !== IPPROTO_TCP && quotedProtocol !== IPPROTO_UDP) return undefined;
  const process = quotedProtocol === IPPROTO_TCP ? 'tcp' : 'udp';
  return runsProcess(model, process) ? process : undefined;
}
