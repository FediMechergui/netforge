/**
 * core/lpm.ts — longest-prefix match over a RIB table (spec §9.4 "longest-prefix-match explainer").
 *
 * Candidates are every route whose `network/prefixLen` contains `dst`, ordered by
 * `prefixLen` desc, then `ad` asc, then `metric` asc, then `key` asc (a stable, fully
 * deterministic order so the explainer can replay the elimination). The winner is the
 * first candidate. The candidate list is returned so the UI can animate the losers.
 *
 * P3c [S7]: `lpmRows` runs the same match over plain rows (the web's route-path overlay holds RIB rows from a
 * snapshot, not a `Table`); `lpm` and `lpmRows` give the same result for the same rows. Both are exported through
 * `@netforge/engine/pure`, beside `core/lpm6`.
 */
import { ipv4ToU32, parseIpv4, prefixLenToMaskU32, type Ipv4Address } from '../contracts/addr.js';
import type { LpmResult, RouteRow, Table } from '../contracts/tables.js';

/** Total order on matching routes: longest prefix, lowest AD, lowest metric, then key. */
function compareRoutes(a: RouteRow, b: RouteRow): number {
  if (a.prefixLen !== b.prefixLen) return b.prefixLen - a.prefixLen;
  if (a.ad !== b.ad) return a.ad - b.ad;
  if (a.metric !== b.metric) return a.metric - b.metric;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** True when `row`'s `network/prefixLen` contains `d` (an address as an unsigned 32-bit value). */
function contains(row: RouteRow, d: number): boolean {
  const m = prefixLenToMaskU32(row.prefixLen);
  return ((ipv4ToU32(row.network) & m) >>> 0) === ((d & m) >>> 0);
}

/**
 * @since P3c [S7] Longest-prefix match of `dst` over plain RIB rows (any order: the result's order is total). Returns
 * the ordered candidates and the winner, as `lpm` does. Rows whose network does not parse never match; a `dst` that
 * does not parse returns no candidates. Never throws on data read from a snapshot.
 */
export function lpmRows(rows: readonly RouteRow[], dst: Ipv4Address): LpmResult {
  if (parseIpv4(dst) === null) return { candidates: [] };
  const d = ipv4ToU32(dst);
  const candidates: RouteRow[] = [];
  for (const r of rows) {
    if (parseIpv4(r.network) === null || !Number.isInteger(r.prefixLen) || r.prefixLen < 0 || r.prefixLen > 32) continue;
    if (contains(r, d)) candidates.push(r);
  }
  candidates.sort(compareRoutes);
  const winner = candidates[0];
  return winner === undefined ? { candidates } : { winner, candidates };
}

/** Longest-prefix match of `dst` against `rib`. Never throws on an empty table. */
export function lpm(rib: Table<RouteRow>, dst: Ipv4Address): LpmResult {
  const d = ipv4ToU32(dst);
  const candidates = rib.find((r) => {
    const m = prefixLenToMaskU32(r.prefixLen);
    return ((ipv4ToU32(r.network) & m) >>> 0) === ((d & m) >>> 0);
  });
  candidates.sort(compareRoutes);
  const winner = candidates[0];
  return winner === undefined ? { candidates } : { winner, candidates };
}
