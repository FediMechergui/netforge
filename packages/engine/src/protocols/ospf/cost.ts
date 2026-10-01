/**
 * protocols/ospf/cost.ts — OSPF interface cost from the routing bandwidth (ARCHITECTURE-P3 D7, §3.2, §4.5, §5.1; §7 W1
 * ospf).
 *
 * Routing bandwidth of an interface, in kb/s, in this order (D7; [C1] EIGRP reads the same order, D26):
 *   1. the interface's `bandwidth <kbps>` line;
 *   2. a fixed value by role: serial (`wan`) 1544 kb/s — `show interfaces` keeps its clocked rate, a listed deviation;
 *      [S18] tunnel 100 kb/s; loopback (`virtual`) 8 000 000 kb/s;
 *   3. the port's speed (the negotiated one, else its nominal one; the caller passes it; a subinterface passes its
 *      parent's);
 *   4. otherwise an SVI 1 000 000 kb/s, anything else 100 000 kb/s.
 * Cost = `ip ospf cost` when configured, else max(1, floor(reference Mb/s × 1000 / bandwidth kb/s)), at most 65 535
 * (§4.5). Reference 100 Mb/s by default (`auto-cost reference-bandwidth`): GigE 1, FastE 1, serial 64; at 1000:
 * GigE 1, FastE 10, serial 647.
 *
 * Pure integer arithmetic; no module state.
 */
import type { PortRole } from '../../contracts/catalog.js';

/** @since P3 Default `auto-cost reference-bandwidth`, Mb/s. */
export const OSPF_REFERENCE_MBPS_DEFAULT = 100;
/** @since P3 Largest `auto-cost reference-bandwidth`, Mb/s (§5.1). */
export const OSPF_REFERENCE_MBPS_MAX = 4_294_967;
/** @since P3 Highest interface cost (and highest `ip ospf cost`). */
export const OSPF_COST_MAX = 65_535;
/** @since P3 Routing bandwidth of a serial port, kb/s (D7). */
export const OSPF_SERIAL_BANDWIDTH_KBPS = 1544;
/** @since P3 [S18] Routing bandwidth of a tunnel port, kb/s (D17). */
export const OSPF_TUNNEL_BANDWIDTH_KBPS = 100;
/** @since P3 Routing bandwidth of a loopback, kb/s. */
export const OSPF_LOOPBACK_BANDWIDTH_KBPS = 8_000_000;
/** @since P3 Routing bandwidth of an SVI with no speed, kb/s. */
export const OSPF_SVI_BANDWIDTH_KBPS = 1_000_000;
/** @since P3 Routing bandwidth of any other port with no speed, kb/s. */
export const OSPF_FALLBACK_BANDWIDTH_KBPS = 100_000;

/** @since P3 What the routing bandwidth of a port depends on. */
export interface RoutingBandwidthInput {
  readonly role: PortRole;
  /** The port's speed in b/s (negotiated, else nominal; a subinterface: its parent's). */
  readonly speedBps?: number;
  /** The `bandwidth` line, kb/s. */
  readonly configuredKbps?: number;
}

/** @since P3 The routing bandwidth of a port in kb/s (the order of the module header); always ≥ 1. */
export function routingBandwidthKbps(p: RoutingBandwidthInput): number {
  if (p.configuredKbps !== undefined && Number.isInteger(p.configuredKbps) && p.configuredKbps > 0) return p.configuredKbps;
  switch (p.role) {
    case 'wan':
      return OSPF_SERIAL_BANDWIDTH_KBPS;
    case 'tunnel':
      return OSPF_TUNNEL_BANDWIDTH_KBPS;
    case 'virtual':
      return OSPF_LOOPBACK_BANDWIDTH_KBPS;
    default:
      break;
  }
  if (p.speedBps !== undefined && Number.isFinite(p.speedBps) && p.speedBps >= 1000) return Math.floor(p.speedBps / 1000);
  return p.role === 'svi' ? OSPF_SVI_BANDWIDTH_KBPS : OSPF_FALLBACK_BANDWIDTH_KBPS;
}

/** @since P3 max(1, floor(referenceMbps × 1000 / bandwidthKbps)), at most `OSPF_COST_MAX`. */
export function ospfCostFor(referenceMbps: number, bandwidthKbps: number): number {
  const bw = bandwidthKbps > 0 ? bandwidthKbps : 1;
  return Math.min(OSPF_COST_MAX, Math.max(1, Math.floor((referenceMbps * 1000) / bw)));
}

/** @since P3 An interface's cost and where it comes from (the `ospf-interfaces` row's `cost` and `costSource`). */
export function ospfInterfaceCost(opts: {
  readonly configuredCost?: number;
  readonly referenceMbps: number;
  readonly bandwidthKbps: number;
}): { cost: number; costSource: 'bandwidth' | 'configured' } {
  const c = opts.configuredCost;
  if (c !== undefined && Number.isInteger(c) && c >= 1 && c <= OSPF_COST_MAX) return { cost: c, costSource: 'configured' };
  return { cost: ospfCostFor(opts.referenceMbps, opts.bandwidthKbps), costSource: 'bandwidth' };
}
