/**
 * protocols/eigrp/metric.ts — the classic EIGRP composite metric in integers [C1] (ARCHITECTURE-P3 D26, §3.12, §4.5;
 * §7 W1 eigrp).
 *
 * A route carries a vector: the cumulative delay (µs), the minimum bandwidth (kb/s), the minimum MTU, the hop count,
 * reliability and load (the IPv4 internal-route TLV, `pdu/codecs/eigrp.ts` scales delay and bandwidth to the RFC's
 * 256-based units on the wire). A router that learns a route on an interface adds the interface's delay and takes the
 * minimum with its bandwidth (`eigrpVectorThrough`), then computes
 *
 *   BW  = floor(10 000 000 / minimum bandwidth in kb/s)
 *   DLY = floor(total delay in µs / 10)
 *   metric = 256 · (K1·BW + floor(K2·BW / (256 − load)) + K3·DLY)
 *   metric = floor(metric · K5 / (reliability + K4))            only when K5 ≠ 0
 *
 * with load 1 and reliability 255 as constants (listed deviation: neither is measured). An unreachable vector (delay
 * `EIGRP_DELAY_UNREACHABLE`) has the infinite metric `EIGRP_INFINITY` (2^32 − 1); a finite result that would reach it
 * is capped there (classic metrics are 32-bit), which cannot happen with CCNA-scale bandwidths and delays. Every
 * intermediate value stays far below 2^53, so floor divisions are exact.
 *
 * Interface defaults (D26, D17): the routing bandwidth is the `bandwidth` line, else 1544 kb/s on serial, else 100 kb/s
 * on a tunnel, else the port speed; the delay is the `delay` line (tens of µs), else 20 000 µs on serial, 50 000 µs on
 * a tunnel, 5 000 µs on a loopback, 10 µs on an SVI, and on Ethernet-like ports by speed: 10 µs at 1 Gb/s and above,
 * 100 µs at 100 Mb/s and above, 1 000 µs below.
 *
 * Pure: no module state, no randomness; integer maths only (§4.5 extends the floating-point grep ban here).
 */
import type { PortRole } from '../../contracts/catalog.js';
import { EIGRP_INFINITY } from '../../contracts/pdu.js';
import type { PortKind } from '../../contracts/port.js';

/** K1–K5 (`metric weights 0 k1 k2 k3 k4 k5`). */
export type EigrpKValues = readonly [number, number, number, number, number];

/** The default weights: bandwidth and delay only. */
export const EIGRP_DEFAULT_K_VALUES: EigrpKValues = Object.freeze([1, 0, 1, 0, 0] as const);
/** Load (1/255) and reliability (255/255): constants (D26, listed deviation). */
export const EIGRP_LOAD = 1;
export const EIGRP_RELIABILITY = 255;
/** The delay of an unreachable route (the `inf` of the routes TLV). */
export const EIGRP_DELAY_UNREACHABLE = 0xffff_ffff;
/** The bandwidth reference: BW = floor(10^7 / kb/s). */
export const EIGRP_BANDWIDTH_REFERENCE = 10_000_000;
/** Default MTU carried in a vector when the port does not say. */
export const EIGRP_DEFAULT_MTU = 1500;

/** Routing bandwidth defaults (kb/s) that do not come from the port speed (D7, D17). */
export const EIGRP_SERIAL_BANDWIDTH_KBPS = 1544;
export const EIGRP_TUNNEL_BANDWIDTH_KBPS = 100;
/** Delay defaults (µs) by interface type (D26). */
export const EIGRP_DELAY_US = Object.freeze({
  gigabit: 10,
  fast: 100,
  ethernet: 1000,
  serial: 20_000,
  loopback: 5_000,
  svi: 10,
  tunnel: 50_000,
});

/** A route's metric vector. */
export interface EigrpVector {
  /** Cumulative delay in µs; `EIGRP_DELAY_UNREACHABLE` for an unreachable route. */
  readonly delayUs: number;
  /** Minimum bandwidth along the path in kb/s. */
  readonly bwKbps: number;
  readonly mtu: number;
  readonly hops: number;
  readonly reliability: number;
  readonly load: number;
}

/** What the metric needs to know about an interface. */
export interface EigrpLink {
  readonly delayUs: number;
  readonly bwKbps: number;
  readonly mtu?: number;
}

/** The part of a port the defaults read. */
export interface EigrpPortInfo {
  readonly kind: PortKind;
  readonly role: PortRole;
  /** The port speed (bit/s). */
  readonly speedBps: number;
}

/** The routing bandwidth in kb/s: the `bandwidth` line, else serial 1544, tunnel 100, else the port speed. */
export function eigrpBandwidthKbps(port: EigrpPortInfo, configuredKbps?: number): number {
  if (configuredKbps !== undefined && Number.isInteger(configuredKbps) && configuredKbps > 0) return configuredKbps;
  if (port.role === 'tunnel') return EIGRP_TUNNEL_BANDWIDTH_KBPS;
  if (port.kind === 'serial' || port.role === 'wan') return EIGRP_SERIAL_BANDWIDTH_KBPS;
  return Math.max(1, Math.floor(port.speedBps / 1000));
}

/** The default delay of a port in µs (D26). */
export function eigrpDefaultDelayUs(port: EigrpPortInfo): number {
  if (port.role === 'tunnel') return EIGRP_DELAY_US.tunnel;
  if (port.role === 'virtual') return EIGRP_DELAY_US.loopback;
  if (port.role === 'svi') return EIGRP_DELAY_US.svi;
  if (port.kind === 'serial' || port.role === 'wan') return EIGRP_DELAY_US.serial;
  if (port.speedBps >= 1_000_000_000) return EIGRP_DELAY_US.gigabit;
  if (port.speedBps >= 100_000_000) return EIGRP_DELAY_US.fast;
  return EIGRP_DELAY_US.ethernet;
}

/** The interface delay in µs: the `delay` line (in tens of µs), else the port default. */
export function eigrpDelayUs(port: EigrpPortInfo, configuredTens?: number): number {
  if (configuredTens !== undefined && Number.isInteger(configuredTens) && configuredTens > 0) return configuredTens * 10;
  return eigrpDefaultDelayUs(port);
}

/** The vector of a directly connected network: the interface's own delay and bandwidth, no hop. */
export function eigrpConnectedVector(link: EigrpLink): EigrpVector {
  return {
    delayUs: link.delayUs,
    bwKbps: link.bwKbps,
    mtu: link.mtu ?? EIGRP_DEFAULT_MTU,
    hops: 0,
    reliability: EIGRP_RELIABILITY,
    load: EIGRP_LOAD,
  };
}

/** Whether a vector is unreachable. */
export function eigrpUnreachable(v: Pick<EigrpVector, 'delayUs'>): boolean {
  return v.delayUs >= EIGRP_DELAY_UNREACHABLE;
}

/** The vector of a route advertised as `advertised` and learned on `link`: delay added, bandwidth and MTU minimum. */
export function eigrpVectorThrough(advertised: EigrpVector, link: EigrpLink): EigrpVector {
  const unreachable = eigrpUnreachable(advertised);
  return {
    delayUs: unreachable ? EIGRP_DELAY_UNREACHABLE : Math.min(EIGRP_DELAY_UNREACHABLE, advertised.delayUs + link.delayUs),
    bwKbps: Math.min(advertised.bwKbps, link.bwKbps),
    mtu: Math.min(advertised.mtu, link.mtu ?? EIGRP_DEFAULT_MTU),
    hops: advertised.hops + 1,
    reliability: advertised.reliability,
    load: advertised.load,
  };
}

/** An unreachable vector (what a poison or a query for a lost route carries). */
export function eigrpUnreachableVector(): EigrpVector {
  return { delayUs: EIGRP_DELAY_UNREACHABLE, bwKbps: 0, mtu: EIGRP_DEFAULT_MTU, hops: 0, reliability: EIGRP_RELIABILITY, load: EIGRP_LOAD };
}

/** The composite metric of a vector under `k` (D26); `EIGRP_INFINITY` when unreachable. */
export function eigrpMetric(v: Pick<EigrpVector, 'delayUs' | 'bwKbps'>, k: EigrpKValues = EIGRP_DEFAULT_K_VALUES): number {
  if (eigrpUnreachable(v) || v.bwKbps <= 0) return EIGRP_INFINITY;
  const [k1, k2, k3, k4, k5] = k;
  const bw = Math.floor(EIGRP_BANDWIDTH_REFERENCE / v.bwKbps);
  const dly = Math.floor(v.delayUs / 10);
  let metric = 256 * (k1 * bw + Math.floor((k2 * bw) / (256 - EIGRP_LOAD)) + k3 * dly);
  if (k5 !== 0) metric = Math.floor((metric * k5) / (EIGRP_RELIABILITY + k4));
  return metric >= EIGRP_INFINITY ? EIGRP_INFINITY : metric;
}

/** Two routers form a neighbourship only with equal K values (D26). */
export function eigrpKValuesMatch(a: EigrpKValues, b: EigrpKValues): boolean {
  return a.every((v, i) => v === b[i]);
}
