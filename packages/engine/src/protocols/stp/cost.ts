/**
 * protocols/stp/cost.ts — spanning-tree path costs (ARCHITECTURE-P2 §3.6 "Identities and costs", §3.7 step 7, D10).
 *
 * Short (16-bit era) method, from the port's negotiated speed:
 *     ≥ 10 Gb/s → 2,  ≥ 1 Gb/s → 4,  ≥ 100 Mb/s → 19,  otherwise 100 (10 Mb/s; nothing slower bridges in NF).
 * A Port-channel uses the AGGREGATE bandwidth of its currently bundled members (bundled and up), looked up in the
 * channel table below; it is recomputed whenever the bundled set changes (2 × 1 G → 3; one member lost → 4). That
 * recompute is a cost update only: never by itself a role change, a state change or a topology change (§3.6).
 *
 * Channel table (aggregate bandwidth → cost), checked top-down; it agrees with the short method for a single member
 * at every NF port speed (10 M, 100 M, 1 G, 10 G, 40 G), and the rows between the speed classes give a bundle a
 * lower cost than one of its members:
 *     ≥ 10 G → 2,  ≥ 2 G → 3,  ≥ 1 G → 4,  ≥ 400 M → 8,  ≥ 300 M → 9,  ≥ 200 M → 12,  ≥ 100 M → 19,
 *     ≥ 40 M → 39, ≥ 20 M → 56, otherwise 100.
 *
 * Overrides (`spanning-tree cost <n>` on the interface, `spanning-tree vlan <list> cost <n>` for one VLAN): the
 * per-VLAN value wins over the interface value, which wins over the computed cost (`effectivePathCost`).
 *
 * Pure integer arithmetic; no module state.
 */

/** One row of a cost table: the cost of any bandwidth at or above `minBps` (rows are checked top-down). */
export interface StpCostRow {
  readonly minBps: number;
  readonly cost: number;
}

/** Short-method cost of one port by negotiated speed (§3.6). */
export const STP_PORT_COSTS: readonly StpCostRow[] = Object.freeze([
  { minBps: 10_000_000_000, cost: 2 },
  { minBps: 1_000_000_000, cost: 4 },
  { minBps: 100_000_000, cost: 19 },
  { minBps: 0, cost: 100 },
]);

/** Cost of a Port-channel by the aggregate bandwidth of its bundled members (§3.6, §3.7 step 7). */
export const STP_CHANNEL_COSTS: readonly StpCostRow[] = Object.freeze([
  { minBps: 10_000_000_000, cost: 2 },
  { minBps: 2_000_000_000, cost: 3 },
  { minBps: 1_000_000_000, cost: 4 },
  { minBps: 400_000_000, cost: 8 },
  { minBps: 300_000_000, cost: 9 },
  { minBps: 200_000_000, cost: 12 },
  { minBps: 100_000_000, cost: 19 },
  { minBps: 40_000_000, cost: 39 },
  { minBps: 20_000_000, cost: 56 },
  { minBps: 0, cost: 100 },
]);

/** Lowest and highest value of `spanning-tree cost` / `spanning-tree vlan … cost`. */
export const STP_COST_MIN = 1;
export const STP_COST_MAX = 200_000_000;

function lookup(table: readonly StpCostRow[], bps: number): number {
  for (const row of table) if (bps >= row.minBps) return row.cost;
  return table[table.length - 1]!.cost;
}

/** Short-method path cost of a port negotiated at `speedBps` (an unknown or zero speed costs 100). */
export function portPathCost(speedBps: number | undefined): number {
  const bps = speedBps !== undefined && Number.isFinite(speedBps) && speedBps > 0 ? speedBps : 0;
  return lookup(STP_PORT_COSTS, bps);
}

/**
 * Path cost of a Port-channel from the negotiated speeds of its CURRENTLY BUNDLED members (bundled and up), in any
 * order. Undefined when no member is bundled: the bundle is down and has no spanning-tree port.
 */
export function channelPathCost(memberSpeedsBps: readonly number[]): number | undefined {
  if (memberSpeedsBps.length === 0) return undefined;
  let total = 0;
  for (const s of memberSpeedsBps) if (Number.isFinite(s) && s > 0) total += s;
  return lookup(STP_CHANNEL_COSTS, total);
}

/** True for a value `spanning-tree cost` accepts. */
export function isStpCost(n: number): boolean {
  return Number.isInteger(n) && n >= STP_COST_MIN && n <= STP_COST_MAX;
}

/** The cost a port uses in one VLAN: the per-VLAN override, else the interface override, else the computed cost. */
export function effectivePathCost(computed: number, overrides: { readonly port?: number; readonly vlan?: number } = {}): number {
  return overrides.vlan ?? overrides.port ?? computed;
}
